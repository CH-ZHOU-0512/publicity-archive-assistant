import { launchIsolatedEdge, requiresLegacyHttpTransport } from "../src/server/browser.js";

const headed = process.argv.includes("--headed");
const scrollContainers = process.argv.includes("--scroll");
const waitArgument = process.argv.find((argument) => argument.startsWith("--wait="));
const waitMilliseconds = Math.max(0, Number(waitArgument?.split("=", 2)[1] || 0));
const afterArgument = process.argv.find((argument) => argument.startsWith("--after="));
const afterMilliseconds = Math.max(0, Number(afterArgument?.split("=", 2)[1] || 700));
const urls = process.argv.slice(2).filter((argument) => !["--headed", "--scroll"].includes(argument) && !argument.startsWith("--wait=") && !argument.startsWith("--after="));
if (urls.length === 0) throw new Error("Provide at least one URL");

for (const url of urls) {
  const browser = await launchIsolatedEdge(!headed, requiresLegacyHttpTransport(url));
  try {
    const page = await browser.newPage();
    const userAgent = (await browser.userAgent()).replace("HeadlessChrome", "Chrome");
    await page.setUserAgent(userAgent);
    await page.setExtraHTTPHeaders({ "Accept-Language": "zh-CN,zh;q=0.9" });
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    if (waitMilliseconds) await new Promise((resolve) => setTimeout(resolve, waitMilliseconds));
    if (scrollContainers) {
      for (let index = 0; index < 12; index += 1) {
        await page.evaluate(() => {
          for (const element of document.querySelectorAll<HTMLElement>("body *")) {
            if (element.scrollHeight > element.clientHeight + 300 && element.clientHeight > 200) {
              element.scrollTop += Math.max(420, element.clientHeight * 0.72);
              element.dispatchEvent(new Event("scroll"));
            }
          }
        });
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      await page.evaluate(() => {
        for (const element of document.querySelectorAll<HTMLElement>("body *")) element.scrollTop = 0;
      });
      await new Promise((resolve) => setTimeout(resolve, afterMilliseconds));
    }
    const result = await page.evaluate(() => {
      const selectors = [
        "#page-content", "article", ".wp_articlecontent", "#js_content", ".article-content",
        ".article_content", ".article-cont", ".article_cont", ".news-content", ".news_content",
        "main", "#content", ".content"
      ];
      return {
        url: location.href,
        title: document.title,
        bodyLead: (document.body?.innerText ?? "").replace(/\s+/g, " ").slice(0, 300),
        documentMetrics: {
          bodyWidth: document.body?.scrollWidth || 0,
          bodyHeight: document.body?.scrollHeight || 0,
          rootWidth: document.documentElement.scrollWidth,
          rootHeight: document.documentElement.scrollHeight
        },
        coveringElements: [...document.querySelectorAll<HTMLElement>("body *")]
          .map((element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return {
              tag: element.tagName,
              id: element.id,
              className: typeof element.className === "string" ? element.className : "",
              position: style.position,
              zIndex: style.zIndex,
              opacity: style.opacity,
              background: style.backgroundColor,
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              top: Math.round(rect.top),
              left: Math.round(rect.left),
              text: (element.innerText || "").replace(/\s+/g, " ").slice(0, 80)
            };
          })
          .filter((element) => element.width * element.height > window.innerWidth * window.innerHeight * 0.1 && (
            ["fixed", "sticky", "absolute"].includes(element.position) ||
            !["rgba(0, 0, 0, 0)", "rgb(255, 255, 255)"].includes(element.background)
          ))
          .sort((a, b) => Number(b.zIndex) - Number(a.zIndex))
          .slice(0, 20),
        candidates: selectors.flatMap((selector) =>
          [...document.querySelectorAll<HTMLElement>(selector)].slice(0, 10).map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              selector,
              tag: element.tagName,
              id: element.id,
              className: element.className,
              textLength: (element.innerText ?? "").replace(/\s+/g, "").length,
              images: element.querySelectorAll("img").length,
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              top: Math.round(rect.top)
            };
          })
        ),
        wechatBottomTools: [...document.querySelectorAll<HTMLElement>(
          "#js_temp_bottom_area,.rich_media_tool_area,#unlogin_bottom_bar,#js_article_bottom_bar,[class*='rich_media_tool'],[class*='bottom_bar']"
        )].map((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {
            tag: element.tagName,
            id: element.id,
            className: element.className,
            parentId: element.parentElement?.id || "",
            parentClass: element.parentElement?.className || "",
            text: (element.innerText || "").replace(/\s+/g, " ").trim().slice(0, 300),
            html: element.outerHTML.slice(0, 1000),
            display: style.display,
            visibility: style.visibility,
            position: style.position,
            zIndex: style.zIndex,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            top: Math.round(rect.top + window.scrollY),
            bottom: Math.round(rect.bottom + window.scrollY)
          };
        }),
        wechatRecommendationNodes: [...document.querySelectorAll<HTMLElement>("body *")]
          .filter((element) => {
            const text = (element.innerText || "").replace(/\s+/g, " ").trim();
            if (text.length < 2 || text.length > 400 || !/下一篇|上一篇|推荐阅读|相关推荐|精彩推荐|更多精彩|专题.{0,8}目录|专栏.{0,8}目录/.test(text)) return false;
            return ![...element.children].some((child) => /下一篇|上一篇|推荐阅读|相关推荐|精彩推荐|更多精彩|专题.{0,8}目录|专栏.{0,8}目录/.test((child as HTMLElement).innerText || ""));
          })
          .slice(0, 20)
          .map((element) => {
            const ancestors = [];
            let current: HTMLElement | null = element;
            for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
              const rect = current.getBoundingClientRect();
              ancestors.push({
                tag: current.tagName,
                id: current.id,
                className: current.className,
                text: (current.innerText || "").replace(/\s+/g, " ").trim().slice(0, 500),
                top: Math.round(rect.top + window.scrollY),
                height: Math.round(rect.height)
              });
            }
            return { html: element.outerHTML.slice(0, 2000), ancestors };
          }),
        contentAncestors: (() => {
          const content = document.querySelector<HTMLElement>(".content,article,.article-content,.wp_articlecontent");
          const ancestors = [];
          let current: HTMLElement | null = content;
          while (current) {
            const rect = current.getBoundingClientRect();
            const style = getComputedStyle(current);
            const before = getComputedStyle(current, "::before");
            const after = getComputedStyle(current, "::after");
            ancestors.push({
              tag: current.tagName,
              id: current.id,
              className: current.className,
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              top: Math.round(rect.top),
              bottom: Math.round(rect.bottom),
              clientHeight: current.clientHeight,
              scrollHeight: current.scrollHeight,
              overflow: style.overflow,
              overflowY: style.overflowY,
              position: style.position,
              transform: style.transform,
              filter: style.filter,
              opacity: style.opacity,
              zoom: style.zoom,
              display: style.display,
              before: { content: before.content, position: before.position, background: before.backgroundColor, opacity: before.opacity },
              after: { content: after.content, position: after.position, background: after.backgroundColor, opacity: after.opacity }
            });
            current = current.parentElement;
          }
          return ancestors;
        })(),
        textContainers: [...document.querySelectorAll<HTMLElement>("div,section,article,main")]
          .map((element) => {
            const rect = element.getBoundingClientRect();
            const textLength = (element.innerText ?? "").replace(/\s+/g, "").length;
            return {
              tag: element.tagName,
              id: element.id,
              className: typeof element.className === "string" ? element.className : "",
              textLength,
              images: element.querySelectorAll("img").length,
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              top: Math.round(rect.top),
              children: element.children.length
            };
          })
          .filter((element) => element.textLength > 300 && element.width > 300 && element.height > 100)
          .sort((a, b) => a.textLength - b.textLength)
          .slice(0, 25),
        topImages: [...document.images]
          .map((image) => {
            const rect = image.getBoundingClientRect();
            const parent = image.parentElement;
            return {
              src: image.currentSrc || image.src,
              alt: image.alt,
              top: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              parentId: parent?.id ?? "",
              parentClass: parent?.className ?? ""
            };
          })
          .filter((image) => image.top < 300 && image.width > 60)
          .slice(0, 20)
      };
    });
    console.log(JSON.stringify({ status: response?.status(), ...result }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ url, error: error instanceof Error ? error.message : String(error) }, null, 2));
  } finally {
    await browser.close();
  }
}
