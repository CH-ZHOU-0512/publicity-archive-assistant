import { describe, expect, it } from "vitest";
import { buildEdgeLaunchArguments, requiresLegacyHttpTransport } from "./browser.js";

describe("Edge launch network policy", () => {
  it("bypasses system proxies for HBUE and WeChat article hosts", () => {
    const args = buildEdgeLaunchArguments("C:\\Temp\\pa-edge", true, true);
    const bypass = args.find((argument) => argument.startsWith("--proxy-bypass-list="));

    expect(bypass).toContain("hbue.edu.cn");
    expect(bypass).toContain("*.hbue.edu.cn");
    expect(bypass).toContain("mp.weixin.qq.com");
    expect(bypass).toContain("*.weixin.qq.com");
    expect(args).toContain("--headless=new");
    expect(args).toContain("--disable-http2");
    expect(args).toContain("--disable-quic");
    expect(args).toContain("--no-proxy-server");
  });

  it("uses the compatibility transport only for direct-connect hosts", () => {
    expect(requiresLegacyHttpTransport("https://xwcb.hbue.edu.cn/53/c9/page.htm")).toBe(true);
    expect(requiresLegacyHttpTransport("https://www.hbue.edu.cn/news/page.htm")).toBe(true);
    expect(requiresLegacyHttpTransport("https://mp.weixin.qq.com/s/example")).toBe(true);
    expect(requiresLegacyHttpTransport("https://res.wx.qq.com/example.js")).toBe(false);
    expect(requiresLegacyHttpTransport("https://example.edu.cn/page.htm")).toBe(false);
  });
});
