# MTNode 内置 Agent 技能库

面向 **MTNode 内部 Agent**（全局助手、智能会话、智能节点）的专项技能，与用户工坊技能、插件安装技能分离。

## 设计

| 层级 | 文件 | 作用 |
|------|------|------|
| 索引 | `index.json` / `INDEX.md` | 仅摘要，注入 Agent 系统提示；指引何时调取 |
| 正文 | `<category>/<id>/SKILL.md` | 完整流程，按需 `skill` 或 `read` 加载 |

运行时同步到 `<DSH_HOME>/mtnode-agent-skills/`，并注册到 `<DSH_HOME>/skills/<name>/`（带 `.mtnode-internal`，不出现在用户技能列表）。

## 维护

1. 在子目录新增或修改 `SKILL.md`（frontmatter 必填 `name`、`description`）
2. 运行 `node tools/build-mtnode-agent-skill-index.js`
3. 提交 `index.json` 与 `INDEX.md` 的变更

## 目录约定

- `mtnode/` — 产品行为、画布、编译、媒体生成等
- `plugins/` — 插件安装/排障（与 `-install` 技能互补，偏编排与验收）
- `canvas/` — 画布编排模式与复杂工作流模板
