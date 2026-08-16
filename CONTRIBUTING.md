# 贡献指南

感谢你愿意改进宣传记录助手。项目尤其欢迎新的新闻站点样本、页面兼容性修复、PDF 版式改进和安全测试。

## 开始之前

- 一般问题、用法交流和想法讨论请优先使用 [GitHub Discussions](https://github.com/CH-ZHOU-0512/publicity-archive-assistant/discussions)。
- 可复现的缺陷请提交 [Issue](https://github.com/CH-ZHOU-0512/publicity-archive-assistant/issues)。
- 安全漏洞不要公开披露，请按 [SECURITY.md](SECURITY.md) 私下报告。

## 开发环境

需要 Windows 10/11、Node.js 22+ 和 Microsoft Edge。

```powershell
git clone https://github.com/CH-ZHOU-0512/publicity-archive-assistant.git
cd publicity-archive-assistant
npm ci
npm test
npm run dev
```

## 提交修改

1. 从 `main` 创建主题分支，例如 `fix/desktop-capture-bounds`。
2. 保持改动聚焦，并为边界算法、文件名规则、安全校验等纯逻辑补充测试。
3. 涉及 PDF 版式时，至少用一个普通桌面新闻页和一个长图/公众号样本逐页检查。
4. 在提交前运行：

```powershell
npm test
npm run build
npm audit --audit-level=moderate
```

5. 发起 Pull Request，说明问题、修复方法、验证样本和可能的兼容性影响。

## 代码约定

- 使用 TypeScript，保持现有 ESM 与显式类型风格。
- 不把用户文章、Cookie、SQLite 数据库、生成的 PDF、安装包或调试日志提交进仓库。
- 页面适配优先使用语义与通用边界算法；新增站点特例时说明为什么通用策略不足。
- 任何网络入口都要维持 `http/https` 白名单、SSRF 防护、本机监听和会话校验。
- 不用采集时间替代无法确认的原文发布日期。

## 提交信息建议

使用简洁的动词开头，例如：

- `Fix desktop article overflow capture`
- `Add metadata adapter for example.com`
- `Document extension fallback workflow`

提交贡献即表示你同意按仓库的 [MIT License](LICENSE) 许可这些修改。
