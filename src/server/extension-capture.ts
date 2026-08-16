import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AppDatabase } from "./database.js";
import type { AppSettings, ExtractedMetadata, TaskRecord } from "../shared/types.js";
import { buildPdfFilename, normalizePublishedDate, normalizeTitle } from "../shared/filename.js";
import { createUploadedScreenshotPdf } from "./capture.js";

export const EXTENSION_SHARED_TOKEN = "pa-local-extension-9f2c40717c854c8db187";

interface CaptureSession {
  id: string;
  metadata: ExtractedMetadata;
  createdAt: number;
  segments: Map<number, { bytes: Uint8Array; width: number; height: number }>;
  totalBytes: number;
}

export class ExtensionCaptureStore {
  private readonly sessions = new Map<string, CaptureSession>();

  start(metadata: ExtractedMetadata): string {
    this.prune();
    const title = normalizeTitle(metadata.title);
    const publishedDate = normalizePublishedDate(metadata.publishedDate);
    if (!title || !publishedDate) throw new Error("请在扩展中确认原标题和发布日期");
    const id = randomUUID();
    this.sessions.set(id, {
      id,
      metadata: { ...metadata, title, publishedDate },
      createdAt: Date.now(),
      segments: new Map(),
      totalBytes: 0
    });
    return id;
  }

  addSegment(id: string, index: number, width: number, height: number, bytes: Uint8Array): void {
    const session = this.sessions.get(id);
    if (!session) throw new Error("扩展采集会话已失效，请重新开始");
    if (!Number.isInteger(index) || index < 0 || index >= 100) throw new Error("截图分段序号无效");
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 200 || height < 50) {
      throw new Error("截图尺寸无效");
    }
    if (bytes.byteLength < 1_000 || bytes.byteLength > 25 * 1024 * 1024) throw new Error("截图分段大小异常");
    const previous = session.segments.get(index);
    session.totalBytes -= previous?.bytes.byteLength ?? 0;
    session.totalBytes += bytes.byteLength;
    if (session.totalBytes > 300 * 1024 * 1024) throw new Error("页面过长，截图总量超过 300 MB");
    session.segments.set(index, { bytes, width, height });
  }

  async complete(id: string, database: AppDatabase, settings: AppSettings): Promise<TaskRecord> {
    const session = this.sessions.get(id);
    if (!session) throw new Error("扩展采集会话已失效，请重新开始");
    try {
      const ordered = [...session.segments.entries()].sort(([a], [b]) => a - b);
      if (ordered.length === 0 || ordered.some(([index], position) => index !== position)) {
        throw new Error("截图分段不完整，请重新采集");
      }
      await fs.mkdir(settings.outputDirectory, { recursive: true });
      const filename = buildPdfFilename(session.metadata.title!, session.metadata.publishedDate!);
      const outputPath = await uniqueOutputPath(settings.outputDirectory, filename);
      await createUploadedScreenshotPdf(
        outputPath,
        session.metadata,
        ordered.map(([, segment]) => segment),
        settings.standardMarginMm
      );
      const stat = await fs.stat(outputPath);
      if (stat.size < 10_000) throw new Error("扩展生成的 PDF 内容异常");
      return database.recordExtensionCapture({
        inputUrl: session.metadata.resolvedUrl,
        resolvedUrl: session.metadata.resolvedUrl,
        title: session.metadata.title!,
        publishedDate: session.metadata.publishedDate!,
        source: session.metadata.source,
        author: session.metadata.author,
        outputPath,
        filename: path.basename(outputPath)
      });
    } finally {
      this.sessions.delete(id);
    }
  }

  private prune(): void {
    const cutoff = Date.now() - 20 * 60_000;
    for (const [id, session] of this.sessions) {
      if (session.createdAt < cutoff) this.sessions.delete(id);
    }
  }
}

async function uniqueOutputPath(directory: string, filename: string): Promise<string> {
  const parsed = path.parse(filename);
  let candidate = path.join(directory, filename);
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    try {
      await fs.access(candidate);
      candidate = path.join(directory, `${parsed.name}_${suffix}${parsed.ext}`);
    } catch {
      return candidate;
    }
  }
  throw new Error("同名文件过多，请清理输出目录后重试");
}
