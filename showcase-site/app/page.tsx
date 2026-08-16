import Script from "next/script";
import landingSource from "../public/landing.html?raw";

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
