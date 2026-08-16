import type { Page } from "puppeteer-core";
import type { ExtractedMetadata } from "../shared/types.js";
import { normalizePublishedDate, normalizeTitle } from "../shared/filename.js";

export interface PageInspection extends ExtractedMetadata {
  hasDynamicContent: boolean;
  isWechat: boolean;
}

interface RawInspection {
  titleCandidates: string[];
  dateCandidates: string[];
  sourceCandidates: string[];
  authorCandidates: string[];
  hasDynamicContent: boolean;
}

export async function inspectPage(page: Page): Promise<PageInspection> {
  const raw = await page.evaluate(() => {
    const text = (element: Element | null): string => element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
    const attr = (selector: string, name: string): string =>
      document.querySelector(selector)?.getAttribute(name)?.trim() ?? "";
    const texts = (selectors: string[]): string[] =>
      selectors.map((selector) => text(document.querySelector(selector))).filter(Boolean);

    const jsonObjects: Record<string, unknown>[] = [];
    for (const script of document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]')) {
      try {
        const value = JSON.parse(script.textContent ?? "") as unknown;
        const visit = (node: unknown): void => {
          if (Array.isArray(node)) {
            node.forEach(visit);
          } else if (node && typeof node === "object") {
            const record = node as Record<string, unknown>;
            jsonObjects.push(record);
            if (Array.isArray(record["@graph"])) visit(record["@graph"]);
          }
        };
        visit(value);
      } catch {
        // Invalid publisher JSON-LD should not prevent deterministic fallbacks.
      }
    }

    const jsonStrings = (key: string): string[] =>
      jsonObjects
        .map((item) => item[key])
        .flatMap((value) => {
          if (typeof value === "string") return [value];
          if (value && typeof value === "object") {
            const nested = value as Record<string, unknown>;
            return typeof nested.name === "string" ? [nested.name] : [];
          }
          return [];
        });

    const bodyLead = (document.body?.innerText ?? "").slice(0, 5000);
    const titleCandidates = [
      ...jsonStrings("headline"),
      attr('meta[property="og:title"]', "content"),
      attr('meta[name="twitter:title"]', "content"),
      ...texts([
        "#activity-name",
        "#news-title",
        ".news-title",
        ".detail-title",
        ".news-detail-title",
        "h1.article-title",
        "h1.arti_title",
        ".article-title h1",
        ".news-title h1",
        ".article h1",
        "main h1",
        "article h1",
        "h1"
      ]),
      document.title
    ].filter(Boolean);

    const dateCandidates = [
      ...jsonStrings("datePublished"),
      attr('meta[property="article:published_time"]', "content"),
      attr('meta[name="publishdate"]', "content"),
      attr('meta[name="PubDate"]', "content"),
      attr("time[datetime]", "datetime"),
      ...texts([
        "#publish_time",
        ".publish-time",
        ".article-time",
        ".arti_update",
        ".arti_metas",
        ".article-info",
        ".news-info",
        ".info"
      ]),
      bodyLead
    ].filter(Boolean);

    const sourceCandidates = [
      ...jsonStrings("publisher"),
      attr('meta[property="og:site_name"]', "content"),
      attr('meta[name="site_name"]', "content"),
      ...texts(["#js_name", ".account_nickname", ".site-name", ".logo", "header .name"])
    ].filter(Boolean);

    const authorCandidates = [
      ...jsonStrings("author"),
      attr('meta[name="author"]', "content"),
      ...texts(["#js_author_name", ".author", ".article-author"])
    ].filter(Boolean);

    const hasGif = [...document.images].some((image) =>
      /\.gif(?:$|[?#])/i.test(image.currentSrc || image.src || image.getAttribute("data-src") || "")
    );
    const hasDynamicContent =
      hasGif ||
      document.querySelector("canvas, video, svg animate, svg animateTransform") !== null;

    return { titleCandidates, dateCandidates, sourceCandidates, authorCandidates, hasDynamicContent };
  }) as RawInspection;

  const url = page.url();
  const hostname = new URL(url).hostname.toLowerCase();
  const title = firstNormalized(raw.titleCandidates, normalizeTitle);
  const publishedDate = firstNormalized(raw.dateCandidates, normalizePublishedDate);
  const source = firstUsefulText(raw.sourceCandidates) ?? sourceFromHostname(hostname);
  const author = firstUsefulText(raw.authorCandidates);

  return {
    title,
    publishedDate,
    source,
    author,
    resolvedUrl: url,
    hasDynamicContent: raw.hasDynamicContent,
    isWechat: hostname === "mp.weixin.qq.com"
  };
}

function firstNormalized(
  values: string[],
  normalize: (value: string) => string | null
): string | null {
  for (const value of values) {
    const result = normalize(value);
    if (result) return result;
  }
  return null;
}

function firstUsefulText(values: string[]): string | null {
  for (const value of values) {
    const cleaned = value.replace(/\s+/g, " ").trim();
    if (cleaned && cleaned.length <= 120) return cleaned;
  }
  return null;
}

function sourceFromHostname(hostname: string): string {
  const known: Record<string, string> = {
    "mp.weixin.qq.com": "微信公众号",
    "www.ctdsb.net": "极目新闻",
    "ctdsb.net": "极目新闻",
    "news.hubeidaily.net": "湖北日报客户端",
    "xwcb.hbue.edu.cn": "湖北经济学院新闻与传播学院"
  };
  return known[hostname] ?? hostname.replace(/^www\./, "");
}
