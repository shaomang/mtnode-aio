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
- `music/` — 音乐生成内容的写作规范（风格提示词 / 歌词），面向用户，可被 `/技能名` 点名
- `plugins/` — 插件安装/排障（与 `-install` 技能互补，偏编排与验收）
- `canvas/` — 画布编排模式与复杂工作流模板

## frontmatter `menu`

- 缺省（不写）：技能带 `.mtnode-internal` 标记，只进「内置技能索引」给模型按需加载，**不出现在用户技能清单 / 「/」菜单**。
- `menu: user`：技能随包内置但**面向用户**——同步时写 `.builtin`（+ `.mtnode-builtin` 出处标记），于是出现在设置·扩展能力管理与「/」技能菜单里，标「内置」只读、不可卸载、不可被工坊下载覆盖。用来替代原先必须从创意工坊下载的技能（如 `minimax-music-prompt` / `minimax-music-lyrics`）。
