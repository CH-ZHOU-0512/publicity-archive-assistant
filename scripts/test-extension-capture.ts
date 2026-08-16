import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import puppeteer from "puppeteer-core";
import { findEdgeExecutable } from "../src/server/browser.js";

const articleUrl = process.argv[2];
const title = process.argv[3];
const date = process.argv[4];
const source = process.argv[5] || "微信公众号扩展验收";
if (!articleUrl || !title || !/^20\d{2}-\d{2}-\d{2}$/.test(date || "")) {
  throw new Error("Usage: tsx scripts/test-extension-capture.ts URL TITLE YYYY-MM-DD [SOURCE]");
}

const extensionDirectory = path.resolve("extension/dist");
const temporaryRoot = path.resolve(os.tmpdir());
const profile = await fs.mkdtemp(path.join(temporaryRoot, "pa-extension-qa-"));
const edge = spawn(findEdgeExecutable(), [
  "--window-position=-32000,-32000",
  "--window-size=900,1108",
  "--no-first-run",
  "--no-default-browser-check",
  "--no-proxy-server",
  "--disable-http2",
  "--disable-quic",
  `--disable-extensions-except=${extensionDirectory}`,
  `--load-extension=${extensionDirectory}`,
  "--remote-debugging-address=127.0.0.1",
  "--remote-debugging-port=0",
  `--user-data-dir=${profile}`,
  "about:blank"
], { windowsHide: true, stdio: "ignore" });

try {
  const port = await waitForDevToolsPort(profile);
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, protocolTimeout: 120_000 });
  try {
    const extensionTarget = await browser.waitForTarget(
      (target) => target.type() === "service_worker" && target.url().startsWith("chrome-extension://"),
      { timeout: 20_000 }
    );
    const worker = await extensionTarget.worker();
    if (!worker) throw new Error("扩展后台未启动");
    const popupUrl = await worker.evaluate("chrome.runtime.getURL('popup.html')") as string;

    const payload = JSON.stringify({ articleUrl, title, date, source });
    const result = await worker.evaluate(`(async () => {
      const payload = ${payload};
      const tab = await chrome.tabs.create({ url: payload.articleUrl, active: true });
      if (!tab.id) throw new Error('无法创建公众号测试标签页');
      await new Promise((resolve, reject) => {
        let listener;
        const timeout = setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(listener);
          reject(new Error('公众号测试页加载超时'));
        }, 60000);
        listener = (tabId, change) => {
          if (tabId === tab.id && change.status === 'complete') {
            clearTimeout(timeout);
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
      });
      await new Promise(resolve => setTimeout(resolve, 1500));
      await chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?qa=1&tabId=' + tab.id), active: false });
      return { tabId: tab.id };
    })()` as never) as { tabId: number };
    if (!result.tabId) throw new Error("扩展未找到公众号测试标签页");

    const popupTarget = await browser.waitForTarget((target) => target.url().startsWith(popupUrl), { timeout: 20_000 });
    const popup = await popupTarget.page();
    if (!popup) throw new Error("扩展弹窗未打开");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const popupState = await popup.evaluate("(() => ({ url: location.href, status: document.querySelector('#status')?.textContent || '', disabled: document.querySelector('#capture')?.disabled }))()") as { url: string; status: string; disabled: boolean };
    console.log(JSON.stringify({ popupState }, null, 2));
    await popup.waitForSelector("#capture:not([disabled])", { timeout: 20_000 });
    await popup.click("#capture");
    await popup.waitForFunction("(() => { const element = document.querySelector('#status'); return element?.classList.contains('success') || element?.classList.contains('error'); })()", { timeout: 120_000 });
    const captureResult = await popup.evaluate("(() => { const element = document.querySelector('#status'); return { ok: element?.classList.contains('success') || false, message: element?.textContent || '' }; })()") as { ok: boolean; message: string };
    console.log(JSON.stringify(captureResult, null, 2));
    if (!captureResult.ok) process.exitCode = 1;
  } finally {
    await browser.close().catch(() => undefined);
  }
} finally {
  edge.kill();
  const resolvedProfile = path.resolve(profile);
  if (resolvedProfile.startsWith(`${temporaryRoot}${path.sep}`)) {
    await fs.rm(resolvedProfile, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function waitForDevToolsPort(userDataDirectory: string): Promise<number> {
  const portFile = path.join(userDataDirectory, "DevToolsActivePort");
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const content = await fs.readFile(portFile, "utf8");
      const port = Number(content.split(/\r?\n/, 1)[0]);
      if (Number.isInteger(port) && port > 0) return port;
    } catch {
      // Edge writes this file after the browser process is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("无法连接扩展验收浏览器");
}
