interface PageMetadata {
  url: string;
  title: string;
  date: string;
  source: string;
}

const titleInput = document.querySelector<HTMLInputElement>("#title")!;
const dateInput = document.querySelector<HTMLInputElement>("#date")!;
const sourceInput = document.querySelector<HTMLInputElement>("#source")!;
const captureButton = document.querySelector<HTMLButtonElement>("#capture")!;
const status = document.querySelector<HTMLParagraphElement>("#status")!;
const pageUrl = document.querySelector<HTMLParagraphElement>("#page-url")!;
let activeTabId: number | null = null;
let currentUrl = "";

void initialize();

async function initialize(): Promise<void> {
  try {
    const requestedTabId = Number(new URL(location.href).searchParams.get("tabId"));
    const tab = Number.isInteger(requestedTabId) && requestedTabId > 0
      ? await chrome.tabs.get(requestedTabId)
      : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (!tab?.id || !tab.url || !/^https?:/i.test(tab.url)) throw new Error("当前标签页不是可采集的网页");
    activeTabId = tab.id;
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractPageMetadata });
    const metadata = result?.result as PageMetadata | undefined;
    if (!metadata) throw new Error("无法读取当前页面信息");
    currentUrl = metadata.url;
    pageUrl.textContent = metadata.url;
    pageUrl.title = metadata.url;
    titleInput.value = metadata.title;
    dateInput.value = metadata.date;
    sourceInput.value = metadata.source;
    captureButton.disabled = false;
    setStatus("请核对原标题和发布日期后开始。", "");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "无法读取当前页面", "error");
  }
}

captureButton.addEventListener("click", () => {
  if (!activeTabId || !titleInput.value.trim() || !dateInput.value) {
    setStatus("请填写原标题和发布日期。", "error");
    return;
  }
  captureButton.disabled = true;
  setStatus("正在加载图片并分段截图，请不要关闭当前标签页…", "");
  chrome.runtime.sendMessage({
    type: "capture-current-page",
    tabId: activeTabId,
    metadata: {
      url: currentUrl,
      title: titleInput.value.trim(),
      date: dateInput.value,
      source: sourceInput.value.trim() || null
    }
  }, (response) => {
    captureButton.disabled = false;
    if (chrome.runtime.lastError) {
      setStatus(chrome.runtime.lastError.message, "error");
    } else if (!response?.ok) {
      setStatus(response?.error || "采集失败，请重试", "error");
    } else {
      setStatus(`已保存：${response.filename}`, "success");
    }
  });
});

function setStatus(message: string, state: "" | "error" | "success"): void {
  status.textContent = message;
  status.className = `status ${state}`.trim();
}

function extractPageMetadata(): PageMetadata {
  const text = (element: Element | null): string => (element?.textContent || "").replace(/\s+/g, " ").trim();
  const first = (selectors: string): Element | null => document.querySelector(selectors);
  const title = text(first("#activity-name,#news-title,.news-title,.detail-title,.news-detail-title,h1.article-title,h1.arti_title,.article-title h1,article h1,main h1,h1")) || document.title.replace(/[-_|].*$/, "").trim();
  const dateSources = [
    first("meta[property='article:published_time']")?.getAttribute("content") || "",
    text(first("#publish_time,.publish-time,.article-time,.arti_metas,.article-info,.news-info,time")),
    (document.body?.innerText || "").slice(0, 2500)
  ];
  let date = "";
  for (const candidate of dateSources) {
    const match = candidate.match(/(20\d{2})[年\/.\-](\d{1,2})[月\/.\-](\d{1,2})日?/);
    if (match) {
      date = `${match[1]}-${match[2]!.padStart(2, "0")}-${match[3]!.padStart(2, "0")}`;
      break;
    }
  }
  const source = text(first("#js_name,.account_nickname,.source,.article-source,.media-name")) || location.hostname;
  return { url: location.href, title, date, source };
}
