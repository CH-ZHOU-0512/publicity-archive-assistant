import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AppSettings, BatchRecord, ImportItem, RenderMode, TaskRecord, TaskStatus } from "../shared/types.js";
import { normalizePublishedDate, normalizeTitle } from "../shared/filename.js";

type RawRow = Record<string, string | number | null>;

export class AppDatabase {
  private readonly db: DatabaseSync;

  constructor(dataDirectory: string, defaultOutputDirectory: string) {
    fs.mkdirSync(dataDirectory, { recursive: true });
    fs.mkdirSync(defaultOutputDirectory, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDirectory, "publicity-assistant.sqlite"));
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate(defaultOutputDirectory);
  }

  private migrate(defaultOutputDirectory: string): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS batches (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        total INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL REFERENCES batches(id),
        input_url TEXT NOT NULL,
        resolved_url TEXT,
        title TEXT,
        published_date TEXT,
        source TEXT,
        author TEXT,
        requested_mode TEXT NOT NULL,
        actual_mode TEXT,
        status TEXT NOT NULL,
        output_path TEXT,
        filename TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status_created
        ON tasks(status, created_at);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    const insertSetting = this.db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)");
    insertSetting.run("outputDirectory", defaultOutputDirectory);
    insertSetting.run("standardMarginMm", "8");
    insertSetting.run("screenshotDpi", "300");

    // A task interrupted by closing the application should be safe to retry.
    this.db.prepare(`
      UPDATE tasks
      SET status = 'queued', error_code = NULL, error_message = NULL, updated_at = ?
      WHERE status IN ('loading', 'stabilizing', 'extracting', 'rendering')
    `).run(new Date().toISOString());
  }

  createBatch(name: string, items: ImportItem[], defaultMode: RenderMode): BatchRecord {
    const batchId = randomUUID();
    const now = new Date().toISOString();
    const safeName = name.trim() || `批次 ${new Date().toLocaleString("zh-CN", { hour12: false })}`;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO batches(id, name, total, created_at) VALUES (?, ?, ?, ?)")
        .run(batchId, safeName, items.length, now);

      const insertTask = this.db.prepare(`
        INSERT INTO tasks(
          id, batch_id, input_url, title, published_date, requested_mode,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)
      `);

      for (const item of items) {
        insertTask.run(
          randomUUID(),
          batchId,
          item.url,
          normalizeTitle(item.title),
          normalizePublishedDate(item.date),
          item.mode ?? defaultMode,
          now,
          now
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return { id: batchId, name: safeName, total: items.length, createdAt: now };
  }

  listTasks(limit = 300): TaskRecord[] {
    const rows = this.db.prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?").all(limit) as RawRow[];
    return rows.map(mapTask);
  }

  getTask(id: string): TaskRecord | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as RawRow | undefined;
    return row ? mapTask(row) : null;
  }

  getNextQueuedTask(): TaskRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM tasks WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1
    `).get() as RawRow | undefined;
    return row ? mapTask(row) : null;
  }

  updateStatus(id: string, status: TaskStatus): void {
    this.db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), id);
  }

  updateInspection(
    id: string,
    values: {
      resolvedUrl: string;
      title: string | null;
      publishedDate: string | null;
      source: string | null;
      author: string | null;
      actualMode: "structured" | "screenshot";
    }
  ): void {
    this.db.prepare(`
      UPDATE tasks SET
        resolved_url = ?, title = ?, published_date = ?, source = ?, author = ?,
        actual_mode = ?, updated_at = ?
      WHERE id = ?
    `).run(
      values.resolvedUrl,
      values.title,
      values.publishedDate,
      values.source,
      values.author,
      values.actualMode,
      new Date().toISOString(),
      id
    );
  }

  completeTask(id: string, outputPath: string, filename: string): void {
    this.db.prepare(`
      UPDATE tasks SET status = 'completed', output_path = ?, filename = ?,
        error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ?
    `).run(outputPath, filename, new Date().toISOString(), id);
  }

  recordExtensionCapture(values: {
    inputUrl: string;
    resolvedUrl: string;
    title: string;
    publishedDate: string;
    source: string | null;
    author: string | null;
    outputPath: string;
    filename: string;
  }): TaskRecord {
    const batchId = randomUUID();
    const taskId = randomUUID();
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO batches(id, name, total, created_at) VALUES (?, ?, 1, ?)")
        .run(batchId, "浏览器扩展采集", now);
      this.db.prepare(`
        INSERT INTO tasks(
          id, batch_id, input_url, resolved_url, title, published_date, source, author,
          requested_mode, actual_mode, status, output_path, filename, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'screenshot', 'screenshot', 'completed', ?, ?, ?, ?)
      `).run(
        taskId, batchId, values.inputUrl, values.resolvedUrl, values.title,
        values.publishedDate, values.source, values.author, values.outputPath,
        values.filename, now, now
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(taskId)!;
  }

  failTask(id: string, code: string, message: string): void {
    this.db.prepare(`
      UPDATE tasks SET status = 'failed', error_code = ?, error_message = ?, updated_at = ?
      WHERE id = ?
    `).run(code, message.slice(0, 1000), new Date().toISOString(), id);
  }

  markNeedsReview(id: string, message: string): void {
    this.db.prepare(`
      UPDATE tasks SET status = 'needs_review', error_code = 'METADATA_REVIEW',
        error_message = ?, updated_at = ? WHERE id = ?
    `).run(message, new Date().toISOString(), id);
  }

  confirmTask(id: string, title: string, publishedDate: string, mode?: RenderMode): boolean {
    const normalizedTitle = normalizeTitle(title);
    const normalizedDate = normalizePublishedDate(publishedDate);
    if (!normalizedTitle || !normalizedDate) return false;

    const result = this.db.prepare(`
      UPDATE tasks SET title = ?, published_date = ?, requested_mode = COALESCE(?, requested_mode),
        status = 'queued', error_code = NULL, error_message = NULL, updated_at = ?
      WHERE id = ? AND status IN ('needs_review', 'failed', 'completed')
    `).run(normalizedTitle, normalizedDate, mode ?? null, new Date().toISOString(), id);
    return result.changes > 0;
  }

  retryTask(id: string): boolean {
    const result = this.db.prepare(`
      UPDATE tasks SET status = 'queued', error_code = NULL, error_message = NULL,
        output_path = NULL, filename = NULL, updated_at = ?
      WHERE id = ? AND status IN ('failed', 'cancelled')
    `).run(new Date().toISOString(), id);
    return result.changes > 0;
  }

  cancelTask(id: string): boolean {
    const result = this.db.prepare(`
      UPDATE tasks SET status = 'cancelled', updated_at = ?
      WHERE id = ? AND status = 'queued'
    `).run(new Date().toISOString(), id);
    return result.changes > 0;
  }

  getSettings(): AppSettings {
    const rows = this.db.prepare("SELECT key, value FROM settings").all() as RawRow[];
    const values = new Map(rows.map((row) => [String(row.key), String(row.value)]));
    return {
      outputDirectory: values.get("outputDirectory") ?? path.resolve("output"),
      standardMarginMm: Number(values.get("standardMarginMm") ?? "8"),
      screenshotDpi: Number(values.get("screenshotDpi") ?? "300")
    };
  }

  setOutputDirectory(directory: string): AppSettings {
    const resolved = path.resolve(directory);
    fs.mkdirSync(resolved, { recursive: true });
    this.db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('outputDirectory', ?)").run(resolved);
    return this.getSettings();
  }

  setMargin(marginMm: 5 | 8): AppSettings {
    this.db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('standardMarginMm', ?)")
      .run(String(marginMm));
    return this.getSettings();
  }
}

function mapTask(row: RawRow): TaskRecord {
  return {
    id: String(row.id),
    batchId: String(row.batch_id),
    inputUrl: String(row.input_url),
    resolvedUrl: nullableString(row.resolved_url),
    title: nullableString(row.title),
    publishedDate: nullableString(row.published_date),
    source: nullableString(row.source),
    author: nullableString(row.author),
    requestedMode: String(row.requested_mode) as RenderMode,
    actualMode: nullableString(row.actual_mode) as TaskRecord["actualMode"],
    status: String(row.status) as TaskStatus,
    outputPath: nullableString(row.output_path),
    filename: nullableString(row.filename),
    errorCode: nullableString(row.error_code),
    errorMessage: nullableString(row.error_message),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function nullableString(value: string | number | null | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}
