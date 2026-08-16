import fs from "node:fs/promises";
import path from "node:path";
import { PDFDocument, rgb, type PDFFont, type PDFImage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import QRCode from "qrcode";
import type { Page } from "puppeteer-core";
import type { ExtractedMetadata } from "../shared/types.js";

const A4_WIDTH_PT = 595.28;
const A4_HEIGHT_PT = 841.89;
const MM_TO_PT = 72 / 25.4;
const SCREENSHOT_CSS_WIDTH = 764;

interface CaptureGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  blockBounds: Array<{ top: number; bottom: number }>;
}

interface HorizontalCaptureBounds {
  x: number;
  width: number;
}

/**
 * Expands a nominal article rectangle to include visible content that hangs
 * outside its container (negative margins, transforms, wide figures, etc.).
 * The final rectangle remains inside the document surface so Chromium never
 * receives an invalid screenshot clip.
 */
export function expandHorizontalCaptureBounds(
  base: HorizontalCaptureBounds,
  contentRects: Array<{ left: number; right: number }>,
  documentWidth: number,
  padding = 12
): HorizontalCaptureBounds {
  const validRects = contentRects.filter((rect) =>
    Number.isFinite(rect.left) && Number.isFinite(rect.right) && rect.right > rect.left
  );
  const minimumLeft = Math.min(base.x, ...validRects.map((rect) => rect.left));
  const maximumRight = Math.max(base.x + base.width, ...validRects.map((rect) => rect.right));
  const surfaceRight = Math.max(documentWidth, base.x + base.width);
  const x = Math.max(0, Math.floor(minimumLeft - padding));
  const right = Math.min(surfaceRight, Math.ceil(maximumRight + padding));
  return { x, width: Math.max(1, right - x) };
}

export async function prepareCaptureDocument(
  page: Page,
  metadata: ExtractedMetadata,
  screenshotMode: boolean
): Promise<CaptureGeometry> {
  return page.evaluate(
    ({ metadata, screenshotMode, screenshotWidth }) => {
      const cloneCanvasAndVideoFrames = (): void => {
        for (const canvas of document.querySelectorAll<HTMLCanvasElement>("canvas")) {
          try {
            const image = document.createElement("img");
            image.src = canvas.toDataURL("image/png");
            image.width = canvas.clientWidth;
            image.height = canvas.clientHeight;
            canvas.replaceWith(image);
          } catch {
            canvas.setAttribute("data-capture-failed", "canvas");
          }
        }

        for (const video of document.querySelectorAll<HTMLVideoElement>("video")) {
          const replacement = document.createElement("img");
          replacement.alt = "视频代表画面";
          replacement.src = video.poster || "";
          if (!replacement.src && video.videoWidth && video.videoHeight) {
            try {
              const canvas = document.createElement("canvas");
              canvas.width = video.videoWidth;
              canvas.height = video.videoHeight;
              canvas.getContext("2d")?.drawImage(video, 0, 0);
              replacement.src = canvas.toDataURL("image/png");
            } catch {
              // A cross-origin video may only allow its publisher-provided poster.
            }
          }
          if (replacement.src) video.replaceWith(replacement);
        }
      };

      const makeImagesSelfContained = (): void => {
        for (const image of document.images) {
          const source = image.currentSrc || image.src || image.dataset.src || image.dataset.original;
          if (source) image.setAttribute("src", source);
          image.removeAttribute("loading");
        }
      };

      if (screenshotMode) {
        cloneCanvasAndVideoFrames();
        makeImagesSelfContained();

        if (location.hostname === "mp.weixin.qq.com") {
          const articleFrame = document.querySelector<HTMLElement>("#img-content,.rich_media_area_primary_inner");
          const bottomBar = document.querySelector<HTMLElement>("#js_article_bottom_bar");
          if (articleFrame && bottomBar) {
            articleFrame.append(bottomBar);
            bottomBar.style.setProperty("position", "static", "important");
            bottomBar.style.setProperty("inset", "auto", "important");
            bottomBar.style.setProperty("transform", "none", "important");
            bottomBar.style.setProperty("display", "flex", "important");
            bottomBar.style.setProperty("width", "100%", "important");
            bottomBar.style.setProperty("z-index", "auto", "important");
          }
        }

        const removableSelectors = [
          ".advertisement", ".advert", ".ad", "[class*='advert']", "[class*='-ad-']",
          "[id*='advert']", "[id*='float-ad']", ".popup", ".modal", ".overlay",
          ".van-overlay", ".van-loading", ".el-loading-mask", "[class*='loading-mask']",
          ".cookie-banner", "[class*='download-app']", "[class*='open-app']",
          ".wx_bottom_modal", ".wx_bottom_modal_mask_fixed", ".weui-half-screen-dialog",
          "#js_pc_qr_code", ".qr_code_pc_outer", "#unlogin_bottom_bar",
          ".recommend-box", ".recommend-list", ".recommendation", ".related-news", ".related_news",
          ".article-recommend", ".news-recommend", ".news_recommend", ".hot-news", ".hot_news",
          ".hot-list", ".popular-news", ".popular-list", ".more-news-list", ".guess-you-like", ".album_read_card", ".album_con",
          "[class*='recommend-box']", "[class*='recommend_list']", "[class*='recommend-list']",
          "[class*='related-news']", "[class*='related_news']", "[class*='article-recommend']",
          "[class*='news-recommend']", "[class*='news_recommend']", "[class*='hot-news']",
          "[class*='hot_news']", "[class*='popular-news']", "[class*='guess-you-like']"
        ];
        for (const selector of removableSelectors) {
          document.querySelectorAll<HTMLElement>(selector).forEach((element) => {
            if (element.closest("#js_article_bottom_bar")) return;
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            const looksLikeAdvertisement = /advert|广告|推广|download-app|open-app|cookie|popup|modal|overlay/i.test(
              `${element.id} ${element.className} ${element.getAttribute("aria-label") || ""}`
            );
            const looksLikeRecommendation = /recommend|related[-_]?news|article[-_]?recommend|news[-_]?recommend|hot[-_]?news|guess[-_]?you[-_]?like|album_read/i.test(
              `${element.id} ${element.className}`
            );
            if (looksLikeAdvertisement || looksLikeRecommendation || style.position === "fixed" || rect.width * rect.height < 400_000) {
              element.remove();
            }
          });
        }

        for (const element of document.querySelectorAll<HTMLElement>("p,h2,h3,h4,span,div")) {
          if (element.closest("#js_article_bottom_bar")) continue;
          const text = (element.innerText || "").replace(/\s+/g, " ").trim();
          if (!/^(更多精彩报道.{0,20}(下载|打开)|相关推荐|推荐阅读|精彩推荐|热门推荐|猜你喜欢|延伸阅读|更多新闻|更多报道)$/.test(text)) continue;
          const module = element.closest<HTMLElement>(
            "[class*='recommend'],[class*='related'],[class*='hot-news'],[class*='hot_news'],[class*='popular-news'],[class*='more-news']"
          ) ?? element.closest<HTMLElement>("[class*='module'],[class*='box'],aside,section");
          const target = module && !module.querySelector("#js_content,.wp_articlecontent,.article-content,.news-content")
            ? module
            : element;
          target.remove();
        }

        if (location.hostname === "mp.weixin.qq.com") {
          for (const toolbar of document.querySelectorAll<HTMLElement>("#js_temp_bottom_area,.rich_media_tool_area")) {
            toolbar.style.setProperty("position", "static", "important");
            toolbar.style.setProperty("inset", "auto", "important");
            toolbar.style.setProperty("transform", "none", "important");
            toolbar.style.setProperty("width", "100%", "important");
            toolbar.style.setProperty("z-index", "auto", "important");
          }
        }

        const preserveStyle = document.createElement("style");
        preserveStyle.textContent = `
          *, *::before, *::after {
            animation-play-state: paused !important;
            caret-color: transparent !important;
          }
          html, body { overflow: visible !important; }
        `;
        document.head.append(preserveStyle);
        window.scrollTo(0, 0);

        const root = document.documentElement;
        const wechatFrame = location.hostname === "mp.weixin.qq.com"
          ? document.querySelector<HTMLElement>("#img-content,.rich_media_area_primary_inner")
          : null;
        let captureX = 0;
        let captureY = 0;
        let width = root.clientWidth;
        const articleSelectors = [
          "#page-content", "#js_content", "article", ".news-detail-container", ".news-detail-box", ".detail-cont",
          ".wp_articlecontent", ".article-content", ".article_content", ".article-cont",
          ".news-content", ".news_content", "main", ".content"
        ];
        const articleCandidates = articleSelectors
          .flatMap((selector) => [...document.querySelectorAll<HTMLElement>(selector)])
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return { element, rect, textLength: (element.innerText || "").replace(/\s+/g, "").length };
          })
          .filter(({ rect, textLength }) => rect.width >= 260 && rect.height >= 180 && textLength >= 120);
        const maxArticleText = Math.max(0, ...articleCandidates.map((candidate) => candidate.textLength));
        const pageArticle = articleCandidates
          .filter((candidate) => candidate.textLength >= Math.max(120, maxArticleText * 0.7))
          .sort((a, b) => a.rect.height - b.rect.height || a.rect.width - b.rect.width)[0]?.element ?? null;
        if (pageArticle) {
          let ancestor: HTMLElement | null = pageArticle.parentElement;
          while (ancestor) {
            const style = getComputedStyle(ancestor);
            if (ancestor.scrollHeight > ancestor.clientHeight + 8 || ["auto", "scroll", "hidden"].includes(style.overflowY)) {
              ancestor.style.setProperty("height", "auto", "important");
              ancestor.style.setProperty("max-height", "none", "important");
              ancestor.style.setProperty("overflow", "visible", "important");
            }
            ancestor = ancestor.parentElement;
          }
        }
        document.body.style.setProperty("height", "auto", "important");
        root.style.setProperty("height", "auto", "important");
        const visibleBottoms = [...document.querySelectorAll<HTMLElement>("body *")]
          .filter((element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && style.position !== "fixed" && rect.width > 1 && rect.height > 1;
          })
          .map((element) => element.getBoundingClientRect().bottom + window.scrollY);
        const documentHeight = Math.max(root.scrollHeight, document.body?.scrollHeight || 0, ...visibleBottoms);
        let height = documentHeight;
        if (pageArticle) {
          const articleRect = pageArticle.getBoundingClientRect();
          const articleTop = articleRect.top + window.scrollY;
          let contentBottom = articleRect.bottom + window.scrollY;
          for (const sidebar of document.querySelectorAll<HTMLElement>("aside,[class*='sidebar'],[class*='side-bar']")) {
            const rect = sidebar.getBoundingClientRect();
            const top = rect.top + window.scrollY;
            const bottom = rect.bottom + window.scrollY;
            if (rect.width > 80 && rect.height > 80 && top < contentBottom && bottom > articleTop) {
              contentBottom = Math.max(contentBottom, bottom);
            }
          }
          height = Math.min(documentHeight, Math.ceil(contentBottom + 4));
        }
        if (wechatFrame) {
          const frameRect = wechatFrame.getBoundingClientRect();
          captureX = Math.max(0, Math.floor(frameRect.left + window.scrollX));
          captureY = Math.max(0, Math.floor(frameRect.top + window.scrollY));
          width = Math.ceil(frameRect.width);
          height = Math.ceil(frameRect.height);
        }
        const horizontalScope = wechatFrame ?? pageArticle;
        if (horizontalScope) {
          const captureBottom = captureY + height;
          const visibleHorizontalRects = [horizontalScope, ...horizontalScope.querySelectorAll<HTMLElement>("*")]
            .map((element) => {
              const rect = element.getBoundingClientRect();
              const style = getComputedStyle(element);
              return {
                left: rect.left + window.scrollX,
                right: rect.right + window.scrollX,
                top: rect.top + window.scrollY,
                bottom: rect.bottom + window.scrollY,
                visible: style.display !== "none" && style.visibility !== "hidden" && style.position !== "fixed"
              };
            })
            .filter((rect) => rect.visible && rect.right > rect.left && rect.bottom > captureY && rect.top < captureBottom);
          const documentWidth = Math.max(
            root.scrollWidth,
            document.body?.scrollWidth || 0,
            window.innerWidth,
            captureX + width
          );
          const minimumLeft = Math.min(captureX, ...visibleHorizontalRects.map((rect) => rect.left));
          const maximumRight = Math.max(captureX + width, ...visibleHorizontalRects.map((rect) => rect.right));
          const expandedX = Math.max(0, Math.floor(minimumLeft - 12));
          const expandedRight = Math.min(documentWidth, Math.ceil(maximumRight + 12));
          captureX = expandedX;
          width = Math.max(1, expandedRight - expandedX);
        }
        const textBounds: Array<{ top: number; bottom: number }> = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            if (!(node.textContent || "").trim()) return NodeFilter.FILTER_REJECT;
            const parent = node.parentElement;
            if (!parent || ["SCRIPT", "STYLE", "NOSCRIPT"].includes(parent.tagName)) return NodeFilter.FILTER_REJECT;
            const style = getComputedStyle(parent);
            return style.display === "none" || style.visibility === "hidden" ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
          }
        });
        let textNode: Node | null;
        while ((textNode = walker.nextNode())) {
          const range = document.createRange();
          range.selectNodeContents(textNode);
          for (const rect of range.getClientRects()) {
            if (rect.width > 1 && rect.height > 2) {
              textBounds.push({ top: rect.top + window.scrollY, bottom: rect.bottom + window.scrollY });
            }
          }
        }
        // Screenshot pagination should protect readable text lines, but must not
        // reserve a large blank area merely to keep a tall photograph on one page.
        // A long webpage screenshot is expected to let large images continue on
        // the next A4 page, just like a physical strip cut at page boundaries.
        const blockBounds = textBounds
          .filter((block) => block.bottom > block.top && block.top >= captureY && block.bottom <= captureY + height + 5)
          .sort((a, b) => a.top - b.top);

        return { x: captureX, y: captureY, width, height, blockBounds };
      }

      const candidateSelectors = [
        "#page-content",
        "article",
        ".wp_articlecontent",
        "#js_content",
        ".news-detail-container",
        ".news-detail-box",
        ".detail-cont",
        ".article-content",
        ".article_content",
        ".article-cont",
        ".article_cont",
        ".news-content",
        ".news_content",
        "main",
        "#content",
        ".content"
      ];

      const scoreCandidate = (element: Element, selectorIndex: number): number => {
        const html = element as HTMLElement;
        const rect = html.getBoundingClientRect();
        const contentLength = (html.innerText || "").replace(/\s+/g, "").length;
        if (contentLength < 80 || rect.width < 240) return -1;
        const imageBonus = html.querySelectorAll("img").length * 250;
        const selectorBonus = (candidateSelectors.length - selectorIndex) * 120;
        const hugePenalty = contentLength > 50000 ? 10000 : 0;
        return contentLength + imageBonus + selectorBonus - hugePenalty;
      };

      let article: Element | null = null;
      let bestScore = -1;
      candidateSelectors.forEach((selector, index) => {
        document.querySelectorAll(selector).forEach((candidate) => {
          const score = scoreCandidate(candidate, index);
          if (score > bestScore) {
            bestScore = score;
            article = candidate;
          }
        });
      });
      if (!article) {
        const genericCandidates = [...document.querySelectorAll<HTMLElement>("div,section,main")]
          .map((element) => {
            const rect = element.getBoundingClientRect();
            const contentLength = (element.innerText || "").replace(/\s+/g, "").length;
            const linkLength = [...element.querySelectorAll("a")]
              .reduce((sum, link) => sum + (link.textContent || "").replace(/\s+/g, "").length, 0);
            return { element, rect, contentLength, linkRatio: contentLength ? linkLength / contentLength : 1 };
          })
          .filter(({ element, rect, contentLength, linkRatio }) =>
            contentLength >= 400 && rect.width >= 300 && rect.height >= 200 && linkRatio < 0.35 &&
            !element.closest("header,nav,footer,aside")
          )
          .sort((a, b) => a.contentLength - b.contentLength);
        article = genericCandidates[0]?.element ?? null;
      }
      if (!article || article === document.body || article === document.documentElement) {
        throw new Error("ARTICLE_REGION_NOT_FOUND");
      }

      const logoImage = [...document.images]
        .map((image) => ({ image, rect: image.getBoundingClientRect() }))
        .filter(({ image, rect }) =>
          rect.top < 500 && rect.width >= 70 && rect.height >= 24 && rect.height <= 180 &&
          /logo|标志|报头|brand/i.test(`${image.src} ${image.alt} ${image.className}`)
        )
        .sort((a, b) => a.rect.top - b.rect.top || b.rect.width - a.rect.width)[0]?.image ?? null;

      cloneCanvasAndVideoFrames();
      makeImagesSelfContained();

      const wrapper = document.createElement("div");
      wrapper.className = "pr-capture-root";
      if (logoImage) {
        const brand = document.createElement("div");
        brand.className = "pr-brand-original";
        const parent = logoImage.parentElement;
        const parentRect = parent?.getBoundingClientRect();
        const originalBrand = parent && parentRect && parentRect.width <= 600 && parentRect.height <= 180 && parent.children.length <= 6
          ? parent
          : logoImage;
        brand.append(originalBrand.cloneNode(true));
        wrapper.append(brand);
      }

      const articleClone = article.cloneNode(true) as HTMLElement;
      articleClone.classList.add("pr-article");
      const articleText = articleClone.innerText || "";
      const includesTitle = metadata.title ? articleText.includes(metadata.title.slice(0, 20)) : false;
      if (!includesTitle) {
        const originalTitle = document.querySelector(
          "#activity-name,#news-title,.news-title,.detail-title,.news-detail-title,h1.article-title,h1.arti_title,.article-title h1,.news-title h1,main h1,article h1,h1"
        );
        if (originalTitle && !article.contains(originalTitle)) {
          wrapper.append(originalTitle.cloneNode(true));
        } else {
          const heading = document.createElement("h1");
          heading.textContent = metadata.title || "未命名文章";
          wrapper.append(heading);
        }
        const originalMeta = document.querySelector(
          "#meta_content,#publish_time,.publish-time,.article-time,.arti_metas,.article-info,.news-info,.info"
        );
        if (originalMeta && !article.contains(originalMeta)) wrapper.append(originalMeta.cloneNode(true));
      }
      wrapper.append(articleClone);

      for (const element of wrapper.querySelectorAll(
        "script,noscript,iframe,.recommend,.related,.comment,.comments,.advertisement,.share,.shares,.social,.interaction,.collect,.praise,[class*='recommend'],[class*='related'],[class*='advert'],[class*='comment'],[class*='share'],[class*='action'],[class*='tool'],[class*='favorite'],[class*='collect'],[class*='praise'],[id*='recommend'],[id*='comment'],[id*='share']"
      )) {
        element.remove();
      }

      document.body.replaceChildren(wrapper);
      const style = document.createElement("style");
      style.textContent = `
        @page { size: A4 portrait; margin: 8mm; }
        html, body { background: #fff !important; margin: 0 !important; padding: 0 !important; }
        .pr-capture-root {
          box-sizing: border-box !important;
          width: ${screenshotMode ? `${screenshotWidth}px` : "100%"} !important;
          max-width: none !important;
          margin: 0 auto !important;
          padding: 0 !important;
          overflow: visible !important;
        }
        .pr-capture-root *, .pr-capture-root *::before, .pr-capture-root *::after {
          box-sizing: border-box !important;
          animation-play-state: paused !important;
        }
        .pr-capture-root img, .pr-capture-root svg, .pr-capture-root canvas, .pr-capture-root video {
          max-width: 100% !important;
          height: auto !important;
        }
        .pr-capture-root [style*='position: fixed'],
        .pr-capture-root [style*='position:fixed'] { position: static !important; }
        .pr-brand-original { position: static !important; width: 100% !important; margin: 0 0 18px !important; }
        .pr-brand-original img { width: auto !important; height: auto !important; max-width: 100% !important; max-height: 120px !important; }
        .pr-article { width: 100% !important; max-width: none !important; margin-left: 0 !important; margin-right: 0 !important; }
        @media print {
          .pr-capture-root { width: 100% !important; }
          .pr-article p, .pr-article img, .pr-article figure { break-inside: avoid; }
        }
      `;
      document.head.append(style);

      window.scrollTo(0, 0);
      const rect = wrapper.getBoundingClientRect();
      const offsetTop = rect.top + window.scrollY;
      const offsetLeft = rect.left + window.scrollX;
      const blockBounds = [...wrapper.querySelectorAll("p,h1,h2,h3,h4,figure,img,section")]
        .map((element) => {
          const block = element.getBoundingClientRect();
          return { top: block.top + window.scrollY, bottom: block.bottom + window.scrollY };
        })
        .filter((block) => block.bottom > block.top && block.top >= offsetTop && block.bottom <= offsetTop + wrapper.scrollHeight + 5)
        .sort((a, b) => a.top - b.top);

      return {
        x: offsetLeft,
        y: offsetTop,
        width: rect.width,
        height: wrapper.scrollHeight,
        blockBounds
      };

    },
    { metadata, screenshotMode, screenshotWidth: SCREENSHOT_CSS_WIDTH }
  );
}

export async function createStructuredPdf(
  page: Page,
  outputPath: string,
  metadata: ExtractedMetadata,
  marginMm: number
): Promise<void> {
  await page.emulateMediaType("screen");
  const qrDataUrl = await QRCode.toDataURL(metadata.resolvedUrl, {
    errorCorrectionLevel: "M",
    margin: 0,
    width: 96
  });
  const capturedAt = new Date().toLocaleString("zh-CN", { hour12: false });
  const hostname = new URL(metadata.resolvedUrl).hostname;
  const footer = `
    <div style="width:100%;height:11mm;font:8px 'Microsoft YaHei',sans-serif;color:#666;padding:0 ${marginMm}mm;display:flex;align-items:center;gap:8px;">
      <span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeTemplate(metadata.source || "宣传材料存档")}　${escapeTemplate(hostname)}　采集：${escapeTemplate(capturedAt)}</span>
      <span><span class="pageNumber"></span> / <span class="totalPages"></span></span>
      <img src="${qrDataUrl}" style="width:9mm;height:9mm;" />
    </div>`;
  await page.pdf({
    path: outputPath,
    format: "A4",
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: "<div></div>",
    footerTemplate: footer,
    margin: {
      top: `${marginMm}mm`,
      right: `${marginMm}mm`,
      bottom: `${Math.max(marginMm, 14)}mm`,
      left: `${marginMm}mm`
    }
  });
}

export async function createScreenshotPdf(
  page: Page,
  outputPath: string,
  metadata: ExtractedMetadata,
  geometry: CaptureGeometry,
  marginMm: number,
  targetDpi: number
): Promise<void> {
  const marginPt = marginMm * MM_TO_PT;
  const footerHeightPt = 31;
  const printableWidthPt = A4_WIDTH_PT - marginPt * 2;
  const printableHeightPt = A4_HEIGHT_PT - marginPt * 2 - footerHeightPt;
  const cssPageHeight = geometry.width * (printableHeightPt / printableWidthPt);
  const contentScale = calculateAdaptiveScale(geometry.height, cssPageHeight);
  const renderedWidthPt = printableWidthPt * contentScale;
  const slices = calculateSlices(geometry, cssPageHeight / contentScale);

  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await loadChineseFont(pdf);
  const capturedAt = new Date().toLocaleString("zh-CN", { hour12: false });
  const qrImage = await pdf.embedPng(await QRCode.toBuffer(metadata.resolvedUrl, {
    type: "png",
    errorCorrectionLevel: "M",
    margin: 0,
    width: 128
  }));
  const hostname = new URL(metadata.resolvedUrl).hostname;

  for (let index = 0; index < slices.length; index += 1) {
    const slice = slices[index]!;
    const imageBytes = await page.screenshot({
      type: "jpeg",
      quality: 92,
      captureBeyondViewport: true,
      clip: {
        x: geometry.x,
        y: slice.top,
        width: geometry.width,
        height: slice.height
      }
    });
    let image: PDFImage;
    try {
      image = await embedRaster(pdf, imageBytes);
    } catch (error) {
      const signature = [...imageBytes.slice(0, 12)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      throw new Error(`第 ${index + 1} 段截图无法解析（top=${slice.top}, height=${slice.height}, width=${geometry.width}, ${imageBytes.byteLength} 字节，签名 ${signature}）：${error instanceof Error ? error.message : String(error)}`);
    }
    const pdfPage = pdf.addPage([A4_WIDTH_PT, A4_HEIGHT_PT]);
    const renderedHeight = renderedWidthPt * (slice.height / geometry.width);
    pdfPage.drawImage(image, {
      x: marginPt + (printableWidthPt - renderedWidthPt) / 2,
      y: A4_HEIGHT_PT - marginPt - renderedHeight,
      width: renderedWidthPt,
      height: renderedHeight
    });

    const footerY = Math.max(4, marginPt / 2 - 1);
    const qrSize = 25;
    const qrX = A4_WIDTH_PT - marginPt - qrSize;
    pdfPage.drawImage(qrImage, { x: qrX, y: 2.5, width: qrSize, height: qrSize });
    const footerText = `${metadata.source || "宣传材料存档"}　${hostname}　采集：${capturedAt}`;
    pdfPage.drawText(footerText, {
      x: marginPt,
      y: footerY,
      size: 7.5,
      font,
      color: rgb(0.38, 0.38, 0.38),
      maxWidth: printableWidthPt - 105
    });
    const pageText = `${index + 1} / ${slices.length}`;
    pdfPage.drawText(pageText, {
      x: qrX - 12 - font.widthOfTextAtSize(pageText, 7.5),
      y: footerY,
      size: 7.5,
      font,
      color: rgb(0.38, 0.38, 0.38)
    });
  }

  pdf.setTitle(metadata.title || "宣传材料");
  pdf.setSubject(metadata.resolvedUrl);
  pdf.setCreator("宣传记录助手");
  pdf.setCreationDate(new Date());
  await fs.writeFile(outputPath, await pdf.save({ useObjectStreams: true }));

  const effectiveDpi = (geometry.width * 3) / (renderedWidthPt / 72);
  if (effectiveDpi < Math.min(targetDpi, 240)) {
    throw new Error(`截图有效分辨率不足：${Math.round(effectiveDpi)} DPI`);
  }
}

/**
 * Avoid a nearly-empty final page when the whole webpage can fit on one fewer
 * A4 sheet with only a subtle, uniform reduction. The 88% floor keeps text
 * comfortably readable and prevents aggressive shrinking of genuinely long
 * articles. A small safety factor leaves room for line-aware page boundaries.
 */
export function calculateAdaptiveScale(contentHeight: number, nominalPageHeight: number): number {
  const naturalPages = Math.ceil(contentHeight / nominalPageHeight);
  if (naturalPages <= 1) return 1;

  const targetPages = naturalPages - 1;
  const scaleToFit = (targetPages * nominalPageHeight / contentHeight) * 0.98;
  return scaleToFit >= 0.88 ? Math.min(1, scaleToFit) : 1;
}

export async function createUploadedScreenshotPdf(
  outputPath: string,
  metadata: ExtractedMetadata,
  segments: Array<{ bytes: Uint8Array; width: number; height: number }>,
  marginMm: number
): Promise<void> {
  const marginPt = marginMm * MM_TO_PT;
  const footerHeightPt = 31;
  const printableWidthPt = A4_WIDTH_PT - marginPt * 2;
  const printableHeightPt = A4_HEIGHT_PT - marginPt * 2 - footerHeightPt;
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await loadChineseFont(pdf);
  const capturedAt = new Date().toLocaleString("zh-CN", { hour12: false });
  const qrImage = await pdf.embedPng(await QRCode.toBuffer(metadata.resolvedUrl, {
    type: "png", errorCorrectionLevel: "M", margin: 0, width: 128
  }));
  const hostname = new URL(metadata.resolvedUrl).hostname;
  const baseWidth = segments[0]?.width ?? 1;
  const normalizedContentHeight = segments.reduce(
    (sum, segment) => sum + segment.height * (baseWidth / segment.width),
    0
  );
  const nominalPageHeight = baseWidth * (printableHeightPt / printableWidthPt);
  const contentScale = calculateAdaptiveScale(normalizedContentHeight, nominalPageHeight);
  const renderedWidthPt = printableWidthPt * contentScale;
  const embeddedSegments: Array<{ image: PDFImage; top: number; height: number }> = [];
  let contentTopPt = 0;
  for (const segment of segments) {
    const renderedHeight = renderedWidthPt * (segment.height / segment.width);
    embeddedSegments.push({ image: await embedRaster(pdf, segment.bytes), top: contentTopPt, height: renderedHeight });
    contentTopPt += renderedHeight;
  }
  const pageCount = Math.max(1, Math.ceil((contentTopPt - 0.1) / printableHeightPt));

  for (let index = 0; index < pageCount; index += 1) {
    const pdfPage = pdf.addPage([A4_WIDTH_PT, A4_HEIGHT_PT]);
    const pageStart = index * printableHeightPt;
    const pageEnd = pageStart + printableHeightPt;
    for (const segment of embeddedSegments) {
      const segmentEnd = segment.top + segment.height;
      if (segmentEnd <= pageStart || segment.top >= pageEnd) continue;
      pdfPage.drawImage(segment.image, {
        x: marginPt + (printableWidthPt - renderedWidthPt) / 2,
        y: A4_HEIGHT_PT - marginPt - (segment.top - pageStart) - segment.height,
        width: renderedWidthPt,
        height: segment.height
      });
    }

    // Images crossing a page boundary are deliberately drawn whole and clipped
    // by opaque margin masks. This keeps the webpage continuous without raster
    // recomposition or image distortion.
    pdfPage.drawRectangle({ x: 0, y: A4_HEIGHT_PT - marginPt, width: A4_WIDTH_PT, height: marginPt, color: rgb(1, 1, 1) });
    pdfPage.drawRectangle({ x: 0, y: 0, width: A4_WIDTH_PT, height: marginPt + footerHeightPt, color: rgb(1, 1, 1) });

    const footerY = Math.max(4, marginPt / 2 - 1);
    const qrSize = 25;
    const qrX = A4_WIDTH_PT - marginPt - qrSize;
    pdfPage.drawImage(qrImage, { x: qrX, y: 2.5, width: qrSize, height: qrSize });
    const footerText = `${metadata.source || "浏览器扩展采集"}　${hostname}　采集：${capturedAt}`;
    pdfPage.drawText(footerText, {
      x: marginPt, y: footerY, size: 7.5, font,
      color: rgb(0.38, 0.38, 0.38), maxWidth: printableWidthPt - 105
    });
    const pageText = `${index + 1} / ${pageCount}`;
    pdfPage.drawText(pageText, {
      x: qrX - 12 - font.widthOfTextAtSize(pageText, 7.5),
      y: footerY, size: 7.5, font, color: rgb(0.38, 0.38, 0.38)
    });
  }

  pdf.setTitle(metadata.title || "宣传材料");
  pdf.setSubject(metadata.resolvedUrl);
  pdf.setCreator("宣传记录助手浏览器扩展");
  pdf.setCreationDate(new Date());
  await fs.writeFile(outputPath, await pdf.save({ useObjectStreams: true }));
}

async function embedRaster(pdf: PDFDocument, bytes: Uint8Array): Promise<PDFImage> {
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return isJpeg ? pdf.embedJpg(bytes) : pdf.embedPng(bytes);
}

export function calculateSlices(geometry: CaptureGeometry, nominalHeight: number): Array<{ top: number; height: number }> {
  const slices: Array<{ top: number; height: number }> = [];
  const end = geometry.y + geometry.height;
  let top = geometry.y;

  while (top < end - 1) {
    let bottom = Math.min(top + nominalHeight, end);
    if (bottom < end) {
      const intersecting = geometry.blockBounds
        .filter((block) => block.bottom - block.top < nominalHeight * 0.7 && block.top - 3 < bottom && block.bottom + 3 > bottom)
        .sort((a, b) => b.top - a.top)[0];
      if (intersecting && intersecting.top - top > nominalHeight * 0.7) {
        bottom = Math.max(top + 1, intersecting.top - 4);
      } else {
        const nearbyBottom = geometry.blockBounds
          .map((block) => block.bottom)
          .filter((candidate) => candidate > top + nominalHeight * 0.82 && candidate <= bottom - 4)
          .at(-1);
        if (nearbyBottom) bottom = nearbyBottom + 2;
      }

      // Moving several boundaries upward to protect text lines can accumulate
      // enough unused space to create a nearly-empty extra page. Keep each
      // adjusted boundary late enough that the original minimum page count is
      // still achievable, then advance past a text line if that clamp lands
      // inside one.
      const pagesIncludingCurrent = Math.max(1, Math.ceil((end - top - 0.5) / nominalHeight));
      const minimumBottom = end - (pagesIncludingCurrent - 1) * nominalHeight;
      if (bottom < minimumBottom) {
        bottom = minimumBottom;
        const crossingAfterClamp = geometry.blockBounds
          .filter((block) => block.top - 3 < bottom && block.bottom + 3 > bottom)
          .sort((a, b) => a.bottom - b.bottom)[0];
        if (crossingAfterClamp && crossingAfterClamp.bottom + 2 <= top + nominalHeight) {
          bottom = crossingAfterClamp.bottom + 2;
        }
      }
    }
    if (bottom < end && end - bottom <= nominalHeight * 0.12) bottom = end;
    slices.push({ top, height: bottom - top });
    top = bottom;
  }
  return slices;
}

async function loadChineseFont(pdf: PDFDocument): Promise<PDFFont> {
  const candidates = [
    "C:\\Windows\\Fonts\\Deng.ttf",
    "C:\\Windows\\Fonts\\simhei.ttf",
    "C:\\Windows\\Fonts\\simfang.ttf"
  ];
  for (const candidate of candidates) {
    try {
      const bytes = await fs.readFile(candidate);
      return await pdf.embedFont(bytes, { subset: true });
    } catch {
      // Try the next Windows Chinese font.
    }
  }
  throw new Error("未找到可用于 PDF 页脚的中文字体");
}

function escapeTemplate(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character] ?? character);
}
