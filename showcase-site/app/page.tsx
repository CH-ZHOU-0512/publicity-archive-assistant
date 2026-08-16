import fs from "node:fs";
import path from "node:path";
import Script from "next/script";

const landingSource = fs.readFileSync(path.join(process.cwd(), "public", "landing.html"), "utf8");
const bodyMarkup = landingSource
  .match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1]
  ?.replace(/<script\s+src="site\.js"\s+defer><\/script>/i, "") ?? "";

export default function Home() {
  return (
    <>
      <div dangerouslySetInnerHTML={{ __html: bodyMarkup }} />
      <Script src="/site.js" strategy="afterInteractive" />
    </>
  );
}
