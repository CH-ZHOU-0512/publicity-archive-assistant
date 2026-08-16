import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "puppeteer-core";
import type { AppSettings, ExtractedMetadata, TaskRecord, TaskStatus } from "../shared/types.js";
import { buildPdfFilename, normalizePublishedDate, normalizeTitle } from "../shared/filename.js";
import { launchIsolatedEdge, requiresLegacyHttpTransport, securePage } from "./browser.js";
import { createScreenshotPdf, createStructuredPdf, prepareCaptureDocument } from "./capture.js";
import { inspectPage, type PageInspection } from "./metadata.js";
import { assertSafePublicUrl, UnsafeUrlError } from "./security.js";

export interface RenderCallbacks {
  onStatus(status: TaskStatus): void;
  onInspection(
    inspection: ExtractedMetadata & { actualMode: "structured" | "screenshot" }
  ): void;
}

export type RenderResult =
  | { kind: "needs_review"; message: string }
  | { kind: "completed"; outputPath: string; filename: string };

export class RenderError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export async function renderTask(
  task: TaskRecord,
  settings: AppSettings,
  callbacks: RenderCallbacks
): Promise<RenderResult> {
  await assertSafePublicUrl(task.inputUrl);
  callbacks.onStatus("loading");
  const browser = await launchIsolatedEdge(true, requiresLegacyHttpTransport(task.inputUrl));

  try {
    const page = await browser.newPage();
    const getBlockedError = await securePage(page);
    const userAgent = (await browser.userAgent()).replace("HeadlessChrome", "Chrome");
    await page.setUserAgent(userAgent);
    await page.setExtraHTTPHeaders({ "Accept-Language": "zh-CN,zh;q=0.9" });

    try {
      await page.goto(task.inputUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    } catch (error) {
      const blocked = getBlockedError();
      if (blocked) throw blocked;
      throw new RenderError("PAGE_LOAD_FAILED", "网页加载失败，请检查网络或网址是否仍然有效。", { cause: error });
    }

    if (!/^https?:/i.test(page.url())) {
      throw new RenderError("PAGE_LOAD_FAILED", "网页跳转到了无法保存的页面，请稍后重试或使用浏览器扩展。" );
    }
    await assertSafePublicUrl(page.url());
    callbacks.onStatus("stabilizing");
    await stabilizePage(page);
    await detectBlockedOrEmptyPage(page);

    callbacks.onStatus("extracting");
    const inspection = await inspectPage(page);
    const metadata: ExtractedMetadata = {
      title: normalizeTitle(task.title) ?? inspection.title,
      publishedDate: normalizePublishedDate(task.publishedDate) ?? inspection.publishedDate,
      source: inspection.source,
      author: inspection.author,
      resolvedUrl: inspection.resolvedUrl
    };
    const actualMode = chooseMode(task, inspection);
    callbacks.onInspection({ ...metadata, actualMode });

    const missing = [!metadata.title && "标题", !metadata.publishedDate && "发布日期"].filter(Boolean);
    if (missing.length > 0) {
      return {
        kind: "needs_review",
        message: `未能可靠识别${missing.join("和")}，请确认后继续生成。`
      };
    }

    callbacks.onStatus("rendering");
    await fs.mkdir(settings.outputDirectory, { recursive: true });
    const filename = buildPdfFilename(metadata.title!, metadata.publishedDate!);
    const outputPath = await uniqueOutputPath(settings.outputDirectory, filename);
    const geometry = await prepareCaptureDocument(page, metadata, actualMode === "screenshot");

    if (actualMode === "screenshot") {
      await createScreenshotPdf(
        page,
        outputPath,
        metadata,
        geometry,
        settings.standardMarginMm,
        settings.screenshotDpi
      );
    } else {
      await createStructuredPdf(page, outputPath, metadata, settings.standardMarginMm);
    }

    const stat = await fs.stat(outputPath);
    if (stat.size < 10_000) {
      await fs.rm(outputPath, { force: true });
      throw new RenderError("EMPTY_PDF", "生成的 PDF 内容异常，请改用截图模式重试。");
    }
    return { kind: "completed", outputPath, filename: path.basename(outputPath) };
  } catch (error) {
    if (error instanceof RenderError || error instanceof UnsafeUrlError) throw error;
    throw new RenderError("RENDER_FAILED", humanizeError(error), { cause: error });
  } finally {
    await browser.close().catch(() => undefined);
  }
}

function chooseMode(task: TaskRecord, inspection: PageInspection): "structured" | "screenshot" {
  if (task.requestedMode !== "auto") return task.requestedMode;
  return "screenshot";
}

async function stabilizePage(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const image of document.images) {
      const lazySource =
        image.dataset.src ||
        image.dataset.original ||
        image.getAttribute("data-actualsrc") ||
        image.getAttribute("data-original-src");
      if (lazySource && (!image.src || image.src.startsWith("data:image/gif;base64"))) image.src = lazySource;
      image.loading = "eager";
    }
  });

  let previousHeight = 0;
  let stableRounds = 0;
  for (let step = 0; step < 180; step += 1) {
    const metrics = await page.evaluate(() => ({
      height: Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight,
        ...[...document.querySelectorAll<HTMLElement>("body *")]
          .filter((element) => element.scrollHeight > element.clientHeight + 300 && element.clientHeight > 200)
          .map((element) => element.scrollHeight)
      ),
      atBottom: (() => {
        const containers = [...document.querySelectorAll<HTMLElement>("body *")]
          .filter((element) => element.scrollHeight > element.clientHeight + 300 && element.clientHeight > 200)
          .sort((a, b) => b.scrollHeight - a.scrollHeight)
          .slice(0, 4);
        window.scrollBy(0, Math.max(520, window.innerHeight * 0.72));
        for (const container of containers) {
          container.scrollTop += Math.max(420, container.clientHeight * 0.72);
          container.dispatchEvent(new Event("scroll"));
        }
        return window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4 &&
          containers.every((container) => container.scrollTop + container.clientHeight >= container.scrollHeight - 4);
      })()
    }));
    if (metrics.height === previousHeight && metrics.atBottom) stableRounds += 1;
    else stableRounds = 0;
    if (stableRounds >= 4) break;
    previousHeight = metrics.height;
    await delay(120);
  }

  await page.evaluate(async () => {
    if (document.fonts?.ready) {
      await Promise.race([
        document.fonts.ready,
        new Promise<void>((resolve) => window.setTimeout(resolve, 2500))
      ]);
    }
    const pendingImages = [...document.images].filter((image) => !image.complete);
    await Promise.race([
      Promise.allSettled(pendingImages.map((image) => image.decode())),
      new Promise<void>((resolve) => window.setTimeout(resolve, 10_000))
    ]);
    for (const element of document.querySelectorAll<HTMLElement>("body *")) {
      if (element.scrollHeight > element.clientHeight + 300 && element.clientHeight > 200) element.scrollTop = 0;
    }
    window.scrollTo(0, 0);
  });
  // Some news SPAs briefly hide or dim their internal scroll view after it is
  // reset to the top. Waiting for that transition avoids archiving the site's
  // loading veil as if it were article content.
  await delay(5_000);

  await page.evaluate(() => {
    const selectors = [
      ".modal",
      ".popup",
      ".mask",
      ".overlay",
      ".van-overlay",
      ".van-loading",
      ".el-loading-mask",
      "[class*='loading-mask']",
      ".cookie-banner",
      "[class*='download-app']",
      "[class*='open-app']",
      "[class*='float-ad']",
      "[id*='float-ad']",
      ".wx_bottom_modal",
      ".wx_bottom_modal_mask_fixed",
      ".weui-half-screen-dialog",
      "#js_pc_qr_code",
      ".qr_code_pc_outer"
    ];
    for (const selector of selectors) {
      document.querySelectorAll<HTMLElement>(selector).forEach((element) => {
        const style = getComputedStyle(element);
        if (
          style.position === "fixed" || style.position === "sticky" || style.zIndex === "9999" ||
          element.matches(".wx_bottom_modal,.wx_bottom_modal_mask_fixed,.weui-half-screen-dialog,#js_pc_qr_code,.qr_code_pc_outer")
        ) {
          element.style.setProperty("display", "none", "important");
        }
      });
    }
  });
}

async function detectBlockedOrEmptyPage(page: Page): Promise<void> {
  const state = await page.evaluate(() => ({
    title: document.title,
    text: (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 3000),
    images: document.images.length
  }));
  const blockedPatterns = [
    "环境异常",
    "访问过于频繁",
    "请在微信客户端打开",
    "完成验证后继续访问",
    "Access Denied",
    "Forbidden"
  ];
  if (blockedPatterns.some((pattern) => state.title.includes(pattern) || state.text.includes(pattern))) {
    throw new RenderError("PAGE_BLOCKED", "网页要求验证或限制访问，可稍后使用浏览器扩展采集当前页面。");
  }
  if (state.text.length < 80 && state.images === 0) {
    throw new RenderError("EMPTY_PAGE", "网页没有加载出可保存的正文内容。");
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
  throw new RenderError("FILENAME_COLLISION", "同名文件过多，请清理输出目录后重试。");
}

function humanizeError(error: unknown): string {
  if (error instanceof Error) {
    if (/timeout/i.test(error.message)) return "网页处理超时，请重试或切换截图模式。";
    return error.message.slice(0, 500);
  }
  return "生成 PDF 时发生未知错误。";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
