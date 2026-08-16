import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the complete project showcase", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>宣传记录助手｜高保真网页新闻归档为 A4 PDF<\/title>/);
  assert.match(html, /网页会变化/);
  assert.match(html, /桌面新闻页不再被视口裁掉/);
  assert.match(html, /作者：周楚涵/);
  assert.match(html, /2801572048@qq\.com/);
  assert.match(html, /github\.com\/CH-ZHOU-0512\/publicity-archive-assistant\/releases\/latest/);
});

test("ships the social card and brand icon", async () => {
  await Promise.all([
    access(new URL("../public/assets/social-card.png", import.meta.url)),
    access(new URL("../public/assets/app-icon.svg", import.meta.url)),
    access(new URL("../public/site.js", import.meta.url)),
  ]);
});
