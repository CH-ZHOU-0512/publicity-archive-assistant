import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { createReadStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import open from "open";
import { z } from "zod";
import { AppDatabase } from "./database.js";
import { RenderWorker } from "./worker.js";
import { findEdgeExecutable } from "./browser.js";
import { assertSafePublicUrl } from "./security.js";
import { EXTENSION_SHARED_TOKEN, ExtensionCaptureStore } from "./extension-capture.js";

const appRoot = path.resolve(import.meta.dirname, "../..");
const dataDirectory = process.env.PA_DATA_DIRECTORY || path.join(appRoot, "data");
const defaultOutputDirectory = process.env.PA_DEFAULT_OUTPUT_DIRECTORY || path.join(appRoot, "output", "pdf");
const webDirectory = path.join(appRoot, "web", "dist");
const port = Number(process.env.PORT ?? 43117);
const host = "127.0.0.1";
const isDevelopment = process.argv.includes("--dev");
const extensionDirectory = process.env.PA_EXTENSION_DIRECTORY || path.join(appRoot, "extension", "dist");
const sessionToken = randomBytes(24).toString("hex");

const database = new AppDatabase(dataDirectory, defaultOutputDirectory);
const worker = new RenderWorker(database);
const extensionCaptures = new ExtensionCaptureStore();
const app = Fastify({ logger: { level: isDevelopment ? "info" : "warn" } });

await app.register(fastifyCookie);

app.addHook("onRequest", async (request, reply) => {
  if (!request.url.startsWith("/api") || request.method === "GET") return;
  if (request.url.startsWith("/api/extension/")) {
    const origin = request.headers.origin;
    if (origin && !/^chrome-extension:\/\/[a-p]{32}$/i.test(origin)) {
      return reply.code(403).send({ error: "扩展请求来源无效" });
    }
    if (request.headers["x-publicity-extension"] !== EXTENSION_SHARED_TOKEN) {
      return reply.code(403).send({ error: "扩展身份校验失败" });
    }
    reply.header("Access-Control-Allow-Origin", origin || "*");
    return;
  }
  const origin = request.headers.origin;
  if (origin) {
    const parsed = safeUrl(origin);
    if (!parsed || !["127.0.0.1", "localhost"].includes(parsed.hostname)) {
      return reply.code(403).send({ error: "请求来源无效" });
    }
  }
  if (request.cookies.pa_session !== sessionToken) {
    return reply.code(403).send({ error: "本地会话已失效，请刷新页面" });
  }
});

app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_request, body, done) => {
  done(null, body);
});

app.get("/api/session", async (_request, reply) => {
  reply.setCookie("pa_session", sessionToken, {
    httpOnly: true,
    sameSite: "strict",
    path: "/api"
  });
  return { ready: true };
});

app.get("/api/health", async () => {
  let edge: string | null = null;
  try {
    edge = findEdgeExecutable();
  } catch {
    // Report the missing prerequisite without crashing the local UI.
  }
  return { ok: true, edgeAvailable: Boolean(edge), edgePath: edge };
});

app.get("/api/tasks", async () => ({
  tasks: database.listTasks(),
  settings: database.getSettings()
}));

const renderModeSchema = z.enum(["auto", "structured", "screenshot"]);
const importSchema = z.object({
  name: z.string().trim().max(100).optional(),
  mode: renderModeSchema.default("auto"),
  items: z.array(z.object({
    url: z.string().trim().min(1).max(4096),
    title: z.string().trim().max(500).optional(),
    date: z.string().trim().max(100).optional(),
    mode: renderModeSchema.optional()
  })).min(1).max(500)
});

app.post("/api/batches", async (request, reply) => {
  const parsed = importSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "批量输入格式无效", details: parsed.error.issues });

  const seen = new Set<string>();
  const valid = [];
  const rejected: Array<{ url: string; reason: string }> = [];
  for (const item of parsed.data.items) {
    try {
      const url = new URL(item.url);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error("只允许 http/https");
      url.hash = "";
      const normalized = url.toString();
      if (seen.has(normalized)) {
        rejected.push({ url: item.url, reason: "重复网址" });
      } else {
        seen.add(normalized);
        valid.push({ ...item, url: normalized });
      }
    } catch {
      rejected.push({ url: item.url, reason: "网址格式无效" });
    }
  }
  if (valid.length === 0) return reply.code(400).send({ error: "没有可加入队列的有效网址", rejected });

  const batch = database.createBatch(parsed.data.name ?? "", valid, parsed.data.mode);
  worker.wake();
  return reply.code(201).send({ batch, accepted: valid.length, rejected });
});

app.post<{ Params: { id: string } }>("/api/tasks/:id/retry", async (request, reply) => {
  if (!database.retryTask(request.params.id)) return reply.code(409).send({ error: "该任务当前不能重试" });
  worker.wake();
  return { ok: true };
});

app.post<{ Params: { id: string } }>("/api/tasks/:id/cancel", async (request, reply) => {
  if (!database.cancelTask(request.params.id)) return reply.code(409).send({ error: "只能取消尚未开始的任务" });
  return { ok: true };
});

const confirmSchema = z.object({
  title: z.string().trim().min(1).max(500),
  date: z.string().trim().min(8).max(30),
  mode: renderModeSchema.optional()
});

app.patch<{ Params: { id: string } }>("/api/tasks/:id/confirm", async (request, reply) => {
  const parsed = confirmSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "请填写有效标题和发布日期" });
  if (!database.confirmTask(request.params.id, parsed.data.title, parsed.data.date, parsed.data.mode)) {
    return reply.code(409).send({ error: "日期格式应为 YYYY-MM-DD，或任务当前不可修改" });
  }
  worker.wake();
  return { ok: true };
});

app.get<{ Params: { id: string } }>("/api/tasks/:id/pdf", async (request, reply) => {
  const task = database.getTask(request.params.id);
  if (!task?.outputPath || !task.filename || !existsSync(task.outputPath)) {
    return reply.code(404).send({ error: "PDF 文件不存在" });
  }
  reply.header("Content-Type", "application/pdf");
  reply.header("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(task.filename)}`);
  return reply.send(createReadStream(task.outputPath));
});

const outputDirectorySchema = z.object({ directory: z.string().trim().min(3).max(1000) });
app.patch("/api/settings/output-directory", async (request, reply) => {
  const parsed = outputDirectorySchema.safeParse(request.body);
  if (!parsed.success || !path.isAbsolute(parsed.data.directory) || path.parse(parsed.data.directory).root === path.resolve(parsed.data.directory)) {
    return reply.code(400).send({ error: "请选择具体的绝对文件夹，不能使用磁盘根目录" });
  }
  try {
    return database.setOutputDirectory(parsed.data.directory);
  } catch {
    return reply.code(400).send({ error: "无法创建或写入该文件夹" });
  }
});

app.post("/api/settings/select-output-directory", async (_request, reply) => {
  try {
    const directory = await selectWindowsDirectory(database.getSettings().outputDirectory);
    if (!directory) return { cancelled: true, settings: database.getSettings() };
    return { cancelled: false, settings: database.setOutputDirectory(directory) };
  } catch {
    return reply.code(500).send({ error: "无法打开文件夹选择窗口，请重试" });
  }
});

const marginSchema = z.object({ marginMm: z.union([z.literal(5), z.literal(8)]) });
app.patch("/api/settings/margin", async (request, reply) => {
  const parsed = marginSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "页边距只能选择 5 mm 或 8 mm" });
  return database.setMargin(parsed.data.marginMm);
});

app.post("/api/open-output", async (_request, reply) => {
  const directory = database.getSettings().outputDirectory;
  await fs.mkdir(directory, { recursive: true });
  const child = spawn("explorer.exe", [directory], { detached: true, stdio: "ignore", windowsHide: false });
  child.unref();
  return reply.code(204).send();
});

app.post("/api/open-extension", async (_request, reply) => {
  if (!existsSync(extensionDirectory)) return reply.code(404).send({ error: "尚未构建浏览器扩展" });
  const child = spawn("explorer.exe", [extensionDirectory], { detached: true, stdio: "ignore", windowsHide: false });
  child.unref();
  return reply.code(204).send();
});

const extensionStartSchema = z.object({
  url: z.string().url().max(4096),
  title: z.string().trim().min(1).max(500),
  date: z.string().trim().min(8).max(30),
  source: z.string().trim().max(200).nullable().optional(),
  author: z.string().trim().max(200).nullable().optional()
});

app.post("/api/extension/captures", async (request, reply) => {
  const parsed = extensionStartSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "请确认文章标题、日期和网址" });
  await assertSafePublicUrl(parsed.data.url);
  try {
    const id = extensionCaptures.start({
      title: parsed.data.title,
      publishedDate: parsed.data.date,
      source: parsed.data.source ?? null,
      author: parsed.data.author ?? null,
      resolvedUrl: parsed.data.url
    });
    return reply.code(201).send({ id, settings: database.getSettings() });
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : "无法开始扩展采集" });
  }
});

app.post<{ Params: { id: string } }>("/api/extension/captures/:id/segments", {
  bodyLimit: 25 * 1024 * 1024
}, async (request, reply) => {
  const index = Number(request.headers["x-segment-index"]);
  const width = Number(request.headers["x-segment-width"]);
  const height = Number(request.headers["x-segment-height"]);
  if (!Buffer.isBuffer(request.body)) return reply.code(400).send({ error: "截图数据格式无效" });
  try {
    extensionCaptures.addSegment(request.params.id, index, width, height, request.body);
    return reply.code(204).send();
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : "无法保存截图分段" });
  }
});

app.post<{ Params: { id: string } }>("/api/extension/captures/:id/complete", async (request, reply) => {
  try {
    const task = await extensionCaptures.complete(request.params.id, database, database.getSettings());
    return { task };
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : "无法完成扩展采集" });
  }
});

app.post("/api/shutdown", async (_request, reply) => {
  reply.code(202).send({ ok: true });
  setTimeout(() => {
    worker.stop();
    void app.close().finally(() => process.exit(0));
  }, 150);
});

if (existsSync(webDirectory)) {
  await app.register(fastifyStatic, { root: webDirectory });
  app.setNotFoundHandler((request, reply) => {
    if (request.method === "GET" && !request.url.startsWith("/api")) return reply.sendFile("index.html");
    return reply.code(404).send({ error: "Not found" });
  });
}

await app.listen({ host, port });
worker.start();

if (!isDevelopment && !process.argv.includes("--no-open")) {
  await open(`http://${host}:${port}`);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    worker.stop();
    void app.close().finally(() => process.exit(0));
  });
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

async function selectWindowsDirectory(defaultPath: string): Promise<string | null> {
  if (process.env.PA_DESKTOP_RUNTIME === "1") {
    const { dialog } = await import("electron");
    const result = await dialog.showOpenDialog({
      title: "选择 PDF 保存文件夹",
      defaultPath,
      buttonLabel: "选择此文件夹",
      properties: ["openDirectory", "createDirectory"]
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  }

  const script = `
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $shell = New-Object -ComObject Shell.Application
    $folder = $shell.BrowseForFolder(0, '选择 PDF 保存文件夹', 65, 0)
    if ($null -ne $folder) {
      Write-Output $folder.Self.Path
    }
  `;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise<string | null>((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-STA", "-EncodedCommand", encoded],
      { windowsHide: true, encoding: "utf8", timeout: 120_000 },
      (error, stdout) => {
        if (error) {
          if ((error as { killed?: boolean }).killed) resolve(null);
          else reject(error);
          return;
        }
        const selected = stdout.trim().split(/\r?\n/).at(-1)?.trim();
        resolve(selected || null);
      }
    );
  });
}
