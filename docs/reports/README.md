# 任务汇报归档

本目录存放 Agent 会话产出的**一次性任务汇报 / 自检报告**，改完根目录就不该留散文件。

- 归档规则：会话结束时把汇报写到 `docs/reports/<主题短名>.md`（不加 `_report-` 前缀），**不要写在项目根目录**。
- 内容性质：为某次改动或某次核对而写，正文里的**行号引用会随代码演进过期**，只作过程留痕与结论依据，不当权威文档。
- 权威口径看这些地方：设计文档 `docs/`、应用内手册 `guides/manual/`、节点指南 `guides/nodes/`、网关契约 `dsh/DESIGN.md`、共识文件 `AGENTS.md`。

## 现有归档

| 文件 | 主题 | 产出日期 |
| --- | --- | --- |
| `agents-md-write-rule.md` | 去掉写 `AGENTS.md` 的提权绕法，改为「项目根即 Agent 工作区根」口径（同步技能文档 + 两处 Agent 规则长文本 + 重生成技能索引） | 2026-08-31 |
| `workspace-selfcheck-two-chains.md` | 工作区新优先级两条链路的人工读码自检（助手建图生效工作区 / 开发绑定会话仍钉 devPath），未改源码 | 2026-08-31 |
| `cordis-pure-gating.md` | `cordis.yml` 按 `MTNODE_PURE` 门控 25 条插件行 + system-prompt 源头关段（纯净模式） | 2026-09-01 |
