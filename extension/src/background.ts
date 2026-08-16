const API_ROOT = "http://127.0.0.1:43117/api/extension";
const SHARED_TOKEN = "pa-local-extension-9f2c40717c854c8db187";
const A4_WIDTH_PT = 595.28;
const A4_HEIGHT_PT = 841.89;
const MM_TO_PT = 72 / 25.4;
const FOOTER_HEIGHT_PT = 31;

interface CaptureMessage {
  type: "capture-current-page";
  tabId: number;
  metadata: { url: string; title: string; date: string; source: string | null };
}

chrome.runtime.onMessage.addListener((message: CaptureMessage, _sender, sendResponse) => {
  if (message.type !== "capture-current-page") return false;
  void capturePage(message).then(
    (result) => sendResponse({ ok: true, filename: result.filename }),
    (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "采集失败" })
  );
  return true;
});

async function capturePage(message: CaptureMessage): Promise<{ filename: string }> {
  const target: chrome.debugger.Debuggee = { tabId: message.tabId };
  const start = await api<{ id: string; settings: { standardMarginMm: number } }>("/captures", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message.metadata)
  });

  await attach(target);
  try {
    await command(target, "Page.enable");
    const preparationResult = await command(target, "Runtime.evaluate", {
      expression: `new Promise(async (resolve) => {
        const sleep = (delay) => new Promise(r => setTimeout(r, delay));
        const bodyText = (document.body?.innerText || '').replace(/\\s+/g, ' ');
        if (location.hostname === 'mp.weixin.qq.com') {
          const hasArticle = Boolean(document.querySelector('#js_article, #js_content'));
          const isVerification = /环境异常|访问过于频繁|完成验证|安全验证|验证码|请在微信客户端打开链接/.test(bodyText);
          if (!hasArticle || isVerification) {
            resolve({ ok: false, reason: '当前是微信验证或拦截页面。请先在本标签页完成验证、确认正文已经显示，再重新采集。' });
            return;
          }
        }

        for (const image of document.images) {
          const lazy = image.dataset.src || image.dataset.original || image.getAttribute('data-actualsrc');
          const lazySrcset = image.dataset.srcset || image.getAttribute('data-original-srcset');
          if (lazy) image.src = lazy;
          if (lazySrcset) image.srcset = lazySrcset;
          image.loading = 'eager';
        }

        let previousHeight = 0;
        let stableAtBottom = 0;
        for (let i = 0; i < 180; i += 1) {
          window.scrollBy(0, Math.max(500, innerHeight * .72));
          window.dispatchEvent(new Event('scroll'));
          await sleep(120);
          const height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
          const atBottom = scrollY + innerHeight >= height - 3;
          stableAtBottom = atBottom && height === previousHeight ? stableAtBottom + 1 : 0;
          if (stableAtBottom >= 4) break;
          previousHeight = height;
        }

        if (document.fonts?.ready) await Promise.race([document.fonts.ready, sleep(8000)]);
        const pendingImages = [...document.images].filter(image => !image.complete);
        await Promise.race([
          Promise.allSettled(pendingImages.map(image => image.decode ? image.decode() : new Promise(done => {
            image.addEventListener('load', done, { once: true });
            image.addEventListener('error', done, { once: true });
          }))),
          sleep(10000)
        ]);

        const style = document.createElement('style');
        style.dataset.publicityArchiveCapture = 'true';
        style.textContent = '*{animation-play-state:paused!important;caret-color:transparent!important}';
        document.head.append(style);

        if (location.hostname === 'mp.weixin.qq.com') {
          const articleFrame = document.querySelector('#img-content,.rich_media_area_primary_inner');
          const bottomBar = document.querySelector('#js_article_bottom_bar');
          if (articleFrame && bottomBar) {
            articleFrame.append(bottomBar);
            bottomBar.style.setProperty('position', 'static', 'important');
            bottomBar.style.setProperty('inset', 'auto', 'important');
            bottomBar.style.setProperty('transform', 'none', 'important');
            bottomBar.style.setProperty('display', 'flex', 'important');
            bottomBar.style.setProperty('width', '100%', 'important');
            bottomBar.style.setProperty('z-index', 'auto', 'important');
          }
        }

        const adSelectors = [
          '#js_top_ad_area', '.js_ad_link', '.advertisement', '.advert', '.ad',
          '[class*="advert"]', '[class*="-ad-"]', '[id*="advert"]', '[id*="float-ad"]',
          '[class*="download-app"]', '[class*="open-app"]', '[aria-label="广告"]',
          '.wx_bottom_modal', '.wx_bottom_modal_mask_fixed', '.weui-half-screen-dialog',
          '#js_pc_qr_code', '.qr_code_pc_outer', '#unlogin_bottom_bar',
          '.recommend-box', '.recommend-list', '.recommendation', '.related-news', '.related_news',
          '.article-recommend', '.news-recommend', '.news_recommend', '.hot-news', '.hot_news',
          '.hot-list', '.popular-news', '.popular-list', '.more-news-list', '.guess-you-like', '.album_read_card', '.album_con',
          '[class*="recommend-box"]', '[class*="recommend_list"]', '[class*="recommend-list"]',
          '[class*="related-news"]', '[class*="related_news"]', '[class*="article-recommend"]',
          '[class*="news-recommend"]', '[class*="news_recommend"]', '[class*="hot-news"]',
          '[class*="hot_news"]', '[class*="popular-news"]', '[class*="guess-you-like"]'
        ];
        for (const selector of adSelectors) document.querySelectorAll(selector).forEach(el => {
          if (!el.closest('#js_article_bottom_bar')) el.remove();
        });

        for (const element of document.querySelectorAll('p,h2,h3,h4,span,div')) {
          if (element.closest('#js_article_bottom_bar')) continue;
          const text = (element.innerText || '').replace(/\s+/g, ' ').trim();
          if (!/^(更多精彩报道.{0,20}(下载|打开)|相关推荐|推荐阅读|精彩推荐|热门推荐|猜你喜欢|延伸阅读|更多新闻|更多报道)$/.test(text)) continue;
          const module = element.closest('[class*="recommend"],[class*="related"],[class*="hot-news"],[class*="hot_news"],[class*="popular-news"],[class*="more-news"]') || element.closest('[class*="module"],[class*="box"],aside,section');
          const target = module && !module.querySelector('#js_content,.wp_articlecontent,.article-content,.news-content') ? module : element;
          target.remove();
        }

        for (const toolbar of document.querySelectorAll('#js_temp_bottom_area,.rich_media_tool_area')) {
          toolbar.style.setProperty('position', 'static', 'important');
          toolbar.style.setProperty('inset', 'auto', 'important');
          toolbar.style.setProperty('transform', 'none', 'important');
          toolbar.style.setProperty('width', '100%', 'important');
          toolbar.style.setProperty('z-index', 'auto', 'important');
        }

        for (const element of document.querySelectorAll('.popup,.modal,.overlay,.cookie-banner')) {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const text = (element.textContent || '').replace(/\\s+/g, ' ');
          const obscuresPage = ['fixed', 'sticky'].includes(style.position) && rect.width * rect.height > innerWidth * innerHeight * .12;
          if (obscuresPage && /广告|打开.{0,8}App|下载.{0,8}App|安装客户端|Cookie|隐私设置/.test(text)) element.remove();
        }

        window.scrollTo(0, 0);
        await sleep(700);
        resolve({
          ok: true,
          imageCount: document.images.length,
          incompleteImages: [...document.images].filter(image => !image.complete || image.naturalWidth === 0).length
        });
      })`,
      awaitPromise: true,
      returnByValue: true
    });
    const preparation = (preparationResult as { result?: { value?: CapturePreparation } }).result?.value;
    if (!preparation?.ok) throw new Error(preparation?.reason || "页面资源准备失败");

    const boundsResult = await command(target, "Runtime.evaluate", {
      expression: `(() => {
        const root = document.documentElement;
        const wechatFrame = location.hostname === 'mp.weixin.qq.com'
          ? document.querySelector('#img-content,.rich_media_area_primary_inner')
          : null;
        let captureX = 0;
        let captureY = 0;
        let width = root.clientWidth;
        const selectors = ['#page-content','#js_content','article','.news-detail-container','.news-detail-box','.detail-cont','.wp_articlecontent','.article-content','.article_content','.article-cont','.news-content','.news_content','main'];
        const candidates = selectors.flatMap(selector => [...document.querySelectorAll(selector)]).map(el => {
          const rect = el.getBoundingClientRect();
          return { el, rect, textLength: (el.innerText || '').replace(/\\s+/g,'').length };
        }).filter(({rect,textLength}) => rect.width >= 260 && rect.height >= 180 && textLength >= 120);
        const maxTextLength = Math.max(0, ...candidates.map(candidate => candidate.textLength));
        const article = candidates.filter(candidate => candidate.textLength >= Math.max(120, maxTextLength * .7))
          .sort((a,b) => a.rect.height - b.rect.height || a.rect.width - b.rect.width)[0]?.el || null;
        if (article) {
          let ancestor = article.parentElement;
          while (ancestor) {
            const style = getComputedStyle(ancestor);
            if (ancestor.scrollHeight > ancestor.clientHeight + 8 || ['auto','scroll','hidden'].includes(style.overflowY)) {
              ancestor.style.setProperty('height','auto','important');
              ancestor.style.setProperty('max-height','none','important');
              ancestor.style.setProperty('overflow','visible','important');
            }
            ancestor = ancestor.parentElement;
          }
        }
        document.body.style.setProperty('height','auto','important');
        root.style.setProperty('height','auto','important');
        const visibleBottoms = [...document.querySelectorAll('body *')].filter(el => {
          const style = getComputedStyle(el), rect = el.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && style.position !== 'fixed' && rect.width > 1 && rect.height > 1;
        }).map(el => el.getBoundingClientRect().bottom + scrollY);
        const documentHeight = Math.max(root.scrollHeight, document.body.scrollHeight, ...visibleBottoms);
        let height = documentHeight;
        if (article) {
          const r = article.getBoundingClientRect();
          const articleTop = r.top + scrollY;
          let contentBottom = r.bottom + scrollY;
          for (const sidebar of document.querySelectorAll('aside,[class*="sidebar"],[class*="side-bar"]')) {
            const s = sidebar.getBoundingClientRect();
            const top = s.top + scrollY, bottom = s.bottom + scrollY;
            if (s.width > 80 && s.height > 80 && top < contentBottom && bottom > articleTop) contentBottom = Math.max(contentBottom, bottom);
          }
          height = Math.min(documentHeight, Math.ceil(contentBottom + 4));
        }
        if (wechatFrame) {
          const frameRect = wechatFrame.getBoundingClientRect();
          captureX = Math.max(0, Math.floor(frameRect.left + scrollX));
          captureY = Math.max(0, Math.floor(frameRect.top + scrollY));
          width = Math.ceil(frameRect.width);
          height = Math.ceil(frameRect.height);
        }
        const horizontalScope = wechatFrame || article;
        if (horizontalScope) {
          const captureBottom = captureY + height;
          const visibleHorizontalRects = [horizontalScope, ...horizontalScope.querySelectorAll('*')].map(element => {
            const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
            return {
              left: rect.left + scrollX, right: rect.right + scrollX,
              top: rect.top + scrollY, bottom: rect.bottom + scrollY,
              visible: style.display !== 'none' && style.visibility !== 'hidden' && style.position !== 'fixed'
            };
          }).filter(rect => rect.visible && rect.right > rect.left && rect.bottom > captureY && rect.top < captureBottom);
          const documentWidth = Math.max(root.scrollWidth, document.body.scrollWidth, innerWidth, captureX + width);
          const minimumLeft = Math.min(captureX, ...visibleHorizontalRects.map(rect => rect.left));
          const maximumRight = Math.max(captureX + width, ...visibleHorizontalRects.map(rect => rect.right));
          const expandedX = Math.max(0, Math.floor(minimumLeft - 12));
          const expandedRight = Math.min(documentWidth, Math.ceil(maximumRight + 12));
          captureX = expandedX;
          width = Math.max(1, expandedRight - expandedX);
        }
        const textBlocks = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode(node) {
          if (!(node.textContent || '').trim()) return NodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          if (!parent || ['SCRIPT','STYLE','NOSCRIPT'].includes(parent.tagName)) return NodeFilter.FILTER_REJECT;
          const style = getComputedStyle(parent);
          return style.display === 'none' || style.visibility === 'hidden' ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        }});
        let node;
        while ((node = walker.nextNode())) {
          const range = document.createRange(); range.selectNodeContents(node);
          for (const b of range.getClientRects()) if (b.width > 1 && b.height > 2) textBlocks.push({ top: b.top + scrollY, bottom: b.bottom + scrollY });
        }
        const blocks = textBlocks.filter(b => b.bottom > b.top && b.top >= captureY && b.bottom <= captureY + height + 5).sort((a,b) => a.top - b.top);
        return { x: captureX, y: captureY, width, height, blocks };
      })()`,
      returnByValue: true
    }) as { result?: { value?: CaptureBounds } };
    const bounds = boundsResult.result?.value;
    if (!bounds || bounds.width < 200 || bounds.height < 100) throw new Error("无法定位当前文章区域");

    const marginPt = start.settings.standardMarginMm * MM_TO_PT;
    const printableWidth = A4_WIDTH_PT - marginPt * 2;
    const printableHeight = A4_HEIGHT_PT - marginPt * 2 - FOOTER_HEIGHT_PT;
    const nominalHeight = bounds.width * (printableHeight / printableWidth);
    const slices = calculateSlices(bounds, nominalHeight);

    for (let index = 0; index < slices.length; index += 1) {
      const slice = slices[index]!;
      const screenshot = await command(target, "Page.captureScreenshot", {
        format: "jpeg",
        quality: 92,
        fromSurface: true,
        captureBeyondViewport: true,
        clip: { x: bounds.x, y: slice.top, width: bounds.width, height: slice.height, scale: 3 }
      }) as { data?: string };
      if (!screenshot.data) throw new Error(`第 ${index + 1} 段截图失败`);
      const bytes = base64Bytes(screenshot.data);
      await api(`/captures/${start.id}/segments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Segment-Index": String(index),
          "X-Segment-Width": String(bounds.width),
          "X-Segment-Height": String(slice.height)
        },
        body: bytes
      });
    }
    const completed = await api<{ task: { filename: string } }>(`/captures/${start.id}/complete`, { method: "POST" });
    return { filename: completed.task.filename };
  } finally {
    await detach(target).catch(() => undefined);
  }
}

interface CaptureBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  blocks: Array<{ top: number; bottom: number }>;
}

interface CapturePreparation {
  ok: boolean;
  reason?: string;
  imageCount?: number;
  incompleteImages?: number;
}

function calculateSlices(bounds: CaptureBounds, nominalHeight: number): Array<{ top: number; height: number }> {
  const slices: Array<{ top: number; height: number }> = [];
  const end = bounds.y + bounds.height;
  let top = bounds.y;
  while (top < end - 1) {
    let bottom = Math.min(top + nominalHeight, end);
    if (bottom < end) {
      const crossing = bounds.blocks.filter((block) => block.bottom - block.top < nominalHeight * .7).find((block) => block.top - 3 < bottom && block.bottom + 3 > bottom);
      if (crossing && crossing.top - top > nominalHeight * .78) bottom = crossing.top - 3;

      const pagesIncludingCurrent = Math.max(1, Math.ceil((end - top - .5) / nominalHeight));
      const minimumBottom = end - (pagesIncludingCurrent - 1) * nominalHeight;
      if (bottom < minimumBottom) {
        bottom = minimumBottom;
        const crossingAfterClamp = bounds.blocks.filter((block) => block.top - 3 < bottom && block.bottom + 3 > bottom).sort((a, b) => a.bottom - b.bottom)[0];
        if (crossingAfterClamp && crossingAfterClamp.bottom + 2 <= top + nominalHeight) bottom = crossingAfterClamp.bottom + 2;
      }
    }
    if (bottom < end && end - bottom <= nominalHeight * .12) bottom = end;
    slices.push({ top, height: Math.max(1, bottom - top) });
    top = bottom;
  }
  return slices;
}

async function api<T = unknown>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${API_ROOT}${path}`, {
    ...init,
    headers: { "X-Publicity-Extension": SHARED_TOKEN, ...init.headers }
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
    throw new Error(data.error || `本地程序返回错误 ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function command(target: chrome.debugger.Debuggee, method: string, params: object = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

function attach(target: chrome.debugger.Debuggee): Promise<void> {
  return new Promise((resolve, reject) => chrome.debugger.attach(target, "1.3", () => {
    const error = chrome.runtime.lastError;
    if (error) reject(new Error(error.message)); else resolve();
  }));
}

function detach(target: chrome.debugger.Debuggee): Promise<void> {
  return new Promise((resolve, reject) => chrome.debugger.detach(target, () => {
    const error = chrome.runtime.lastError;
    if (error) reject(new Error(error.message)); else resolve();
  }));
}

function base64Bytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
