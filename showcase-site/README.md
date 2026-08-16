# 宣传记录助手展示站（Sites 版本）

这是项目展示页的 OpenAI Sites / Vinext 部署版本。GitHub Pages 的纯静态源文件位于仓库 `docs/`，两者使用相同文案、视觉资源和外部链接。

## 本地运行

需要 Node.js 22.13+。

```powershell
npm ci
npm run dev
```

## 验证

```powershell
npm run build
npm test
npm run lint
```

## 内容同步

- `public/landing.html` 对应 `../docs/index.html`；
- `app/site.css` 与 `public/site.css` 对应 `../docs/site.css`；
- `public/site.js` 对应 `../docs/site.js`；
- `public/assets/` 保存品牌图标与社交分享图。

`.openai/hosting.json` 只保存 Sites 项目标识和可选资源绑定，不保存部署令牌或其他秘密。
