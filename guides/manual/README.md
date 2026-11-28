# 应用内手册维护说明

本目录（`guides/manual/`）存放 MTNode 内置使用手册，供顶栏「文档」与设置页「帮助」离线读取。

## 目录结构

- `index.json`：目录清单（7 章 26 页，默认首页 `overview`），由 `_write.mjs` 生成。
- `<id>.md` 与 `en/<id>.md`：中英双语正文，以磁盘文件为准，重跑 `_write.mjs` 不会覆盖已有正文。
- `img/*.svg`：14 张高对比度静态图示，由 `_write.mjs` 生成；正文中（含 `en/` 下页面）一律使用相对根路径 `img/<文件名>.svg`，主进程 `loadMarkdownPack` 读取时自动内联为 data URI，渲染层 `MTRender.toHtml(..., { assets })` 还原显示。

## 写作口径

1. **面向普通用户说人话**：只写功能是什么、什么时候用、怎么三步上手；不堆开发黑话、不写历史改版流水账、不引用仓库内部路径或内部函数名。
2. **跟随当前版本**：新功能或快捷键变化时同步更新对应页面，中英双语保持一致。
3. **不使用原始 HTML 标签**：渲染内核会先转义 HTML，快捷键和行内代码请使用 Markdown 反引号（如 `` `Ctrl + Tab` ``）。

## 接入机制速览

- **主进程 IPC**（`main.js` / `preload.js`）：`docs:catalog`（目录）、`docs:load`（读单页 + 内联图示 + 旧页 ID 别名兼容）、`docs:search`（目录与正文全文检索）、`docs:bundle`（拼装全文供手册「答疑」使用）。
- **渲染层阅读器**（`renderer/app.js` `#appDocsDlg` + `renderer/css/base.css`）：支持目录与正文全文检索、页内二级标题目录跳转、`#page-id` 跨页链接、页脚「上一篇 / 下一篇」顺序翻页、以及基于本手册的 AI 答疑，并跟随四套主题（含亮色主题）自动适配配色。
- **旧页 ID 别名**：已整合的旧短页（如 `marks-groups`、`rollback`、`approvals`、`quick-build`、`md-editing`、`moss-music`、`blender-local`、`windows-run`、`glossary`、`manifest`）在 `main.js` 的 `MANUAL_PAGE_ALIASES` 中自动重定向到对应新页面，旧链接不会报错。
