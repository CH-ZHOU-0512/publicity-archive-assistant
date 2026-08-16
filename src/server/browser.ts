import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import puppeteer, { type Browser, type HTTPRequest, type Page } from "puppeteer-core";
import { assertSafePublicUrl, UnsafeUrlError } from "./security.js";

export class BrowserUnavailableError extends Error {
  readonly code = "EDGE_NOT_FOUND";
}

const DIRECT_PROXY_BYPASS = [
  "hbue.edu.cn",
  "*.hbue.edu.cn",
  "mp.weixin.qq.com",
  "*.weixin.qq.com",
  "<local>"
];

export function findEdgeExecutable(): string {
  const candidates = [
    process.env.EDGE_EXECUTABLE_PATH,
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe")
  ].filter((candidate): candidate is string => Boolean(candidate));

  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) {
    throw new BrowserUnavailableError("未找到 Microsoft Edge。请确认系统已安装 Edge 后重试。");
  }
  return executable;
}

export async function launchIsolatedEdge(headless = true, legacyHttpTransport = false): Promise<Browser> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "publicity-assistant-edge-"));
  const edge = spawn(findEdgeExecutable(), buildEdgeLaunchArguments(userDataDir, headless, legacyHttpTransport), {
    windowsHide: true,
    stdio: "ignore",
    env: withDirectNoProxy(process.env)
  });
  edge.unref();

  try {
    const port = await waitForDevToolsPort(userDataDir);
    const browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${port}`,
    protocolTimeout: 60_000,
    defaultViewport: {
      width: 1280,
      height: 900,
      deviceScaleFactor: 3
    }
  });

    browser.on("disconnected", () => {
      fs.rm(userDataDir, { recursive: true, force: true }, () => undefined);
    });
    return browser;
  } catch (error) {
    fs.rm(userDataDir, { recursive: true, force: true }, () => undefined);
    throw error;
  }
}

export function buildEdgeLaunchArguments(userDataDir: string, headless = true, legacyHttpTransport = false): string[] {
  return [
    ...(headless ? ["--headless=new"] : ["--window-position=-32000,-32000", "--window-size=900,1108"]),
    ...(legacyHttpTransport ? ["--no-proxy-server", "--disable-http2", "--disable-quic"] : []),
    "--hide-scrollbars",
    "--mute-audio",
    "--disable-extensions",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-blink-features=AutomationControlled",
    "--disable-features=Translate,MediaRouter,OptimizationHints",
    "--disable-sync",
    "--metrics-recording-only",
    "--safebrowsing-disable-auto-update",
    `--proxy-bypass-list=${DIRECT_PROXY_BYPASS.join(";")}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "about:blank"
  ];
}

export function requiresLegacyHttpTransport(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "hbue.edu.cn" || hostname.endsWith(".hbue.edu.cn") ||
      hostname === "weixin.qq.com" || hostname.endsWith(".weixin.qq.com");
  } catch {
    return false;
  }
}

function withDirectNoProxy(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const existing = environment.NO_PROXY || environment.no_proxy || "";
  const additions = ["hbue.edu.cn", ".hbue.edu.cn", "weixin.qq.com", ".weixin.qq.com"];
  const merged = [...new Set([...existing.split(","), ...additions].map((item) => item.trim()).filter(Boolean))].join(",");
  return { ...environment, NO_PROXY: merged, no_proxy: merged };
}

async function waitForDevToolsPort(userDataDir: string): Promise<number> {
  const portFile = path.join(userDataDir, "DevToolsActivePort");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const content = await fsPromises.readFile(portFile, "utf8");
      const port = Number(content.split(/\r?\n/, 1)[0]);
      if (Number.isInteger(port) && port > 0) return port;
    } catch {
      // Edge creates the file after its browser process is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new BrowserUnavailableError("Edge 已启动，但无法建立本地渲染连接。");
}

export async function securePage(page: Page): Promise<() => UnsafeUrlError | null> {
  let blockedError: UnsafeUrlError | null = null;
  await page.setRequestInterception(true);

  page.on("request", (request) => {
    void handleRequest(request);
  });

  async function handleRequest(request: HTTPRequest): Promise<void> {
    if (request.isInterceptResolutionHandled()) return;
    const url = request.url();
    if (/^(data:|blob:|about:)/i.test(url)) {
      await request.continue();
      return;
    }

    try {
      await assertSafePublicUrl(url);
      if (!request.isInterceptResolutionHandled()) await request.continue();
    } catch (error) {
      if (
        error instanceof UnsafeUrlError && /^https?:/i.test(request.url()) &&
        request.isNavigationRequest() && request.frame() === page.mainFrame()
      ) {
        blockedError = error;
      }
      if (!request.isInterceptResolutionHandled()) await request.abort("blockedbyclient");
    }
  }

  return () => blockedError;
}
