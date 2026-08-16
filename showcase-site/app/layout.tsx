import type { Metadata } from "next";
import "./globals.css";
import "./site.css";

export const metadata: Metadata = {
  title: "宣传记录助手｜高保真网页新闻归档为 A4 PDF",
  description: "本地运行的 Windows 网页归档工具，将新闻网页与微信公众号文章保存为可追溯、可打印的 A4 PDF。",
  icons: { icon: "/assets/app-icon.svg" },
  openGraph: {
    type: "website",
    locale: "zh_CN",
    title: "宣传记录助手｜让每一份网页新闻都可追溯",
    description: "高保真桌面网页归档、A4 智能分页、微信公众号扩展兜底，全程在本机完成。",
    images: ["/assets/social-card.png"]
  }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <head>
        <meta name="theme-color" content="#7f231e" />
      </head>
      <body>{children}</body>
    </html>
  );
}
