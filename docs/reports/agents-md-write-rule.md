# 任务汇报：Agent 规则与技能文档同步（去掉提权绕法）

## 改了哪三处

### ① mtnode-agent-skills/mtnode/dev-architect/SKILL.md（原第 174 行）

删除原「写入授权（本技能预授权，规避默认权限限制）」段（该段要求 Agent 以「在项目根写 AGENTS.md」为唯一用途申请 `sandbox_permissions`），改为三条不提权口径：

- **写入方式（不提权、不绕法）**：应用会把**项目根并入 Agent 工作区**——工作区真源优先级为「手填工作目录 > 画布项目根（开发节点 `devPath`）> 画布工作目录 > 应用默认目录」，所以**画布含开发节点时，项目根即 Agent 工作区根**，在项目根写 / 更新 `AGENTS.md` 属于工作区内正常写入，文件策略天然允许。
  - **建图首轮先把 `devPath` 写到顶层功能块**：设好之后（同一轮建块完成之后的写入起）工作区就解析到项目根，共识文件可直接写；先写文件再设 devPath 才会踩到工作区尚未指向项目根的情况。
  - **禁止为写 `AGENTS.md` 申请任何提权或绕法**（不要传 `sandbox_permissions`，不要用「唯一用途申请写入权限」之类说法请求扩权）。
  - 仍被拒绝时（工作目录被手填到别处 / 顶层块还没有 `devPath`）：**如实告诉用户**把工作目录指向项目根后重试，并说明本次未落盘；不得静默跳过、推迟，也不得写到其它目录冒充项目根。

全文再无提权相关表述（仓库内 `sandbox_permissions` 仅剩这条禁止句）。

### ② 两处同款 Agent 规则长文本各补一句

- `renderer/app-assist.js` 的 `devNodeRule`（第 816 行）段末补：
  > **画布含开发节点时，项目根即 Agent 工作区根**（工作区真源优先级：手填工作目录 > 画布项目根 devPath > 画布工作目录 > 默认目录），所以在建图首轮就把 devPath 写到顶层功能块，之后项目根内的文件（含 AGENTS.md 共识文件）可直接读写，**不要为写文件申请任何提权或绕法**；仍写不进时如实请用户把工作目录指向项目根。
- `dsh/gateway/gateway.mjs` 的 `PRESETS.standard`（第 380 行）在 dev nodes 括注内 `skill mtnode-dev-architect drives scan/build flows` 之后补同口径英文句：
  > when the canvas contains dev nodes, the project root IS the Agent workspace root (workspace resolution: manually set dir > canvas project root devPath > canvas work dir > default), so set devPath on the top-level dev block in the first graph-building round and afterwards read/write project-root files such as AGENTS.md directly — never request permission escalation or workarounds to write them, and if writing is still refused, plainly ask the user to point the working directory at the project root

### ③ 重生成技能索引

执行 `npm run build:agent-skills-index` → `[build-mtnode-agent-skill-index] wrote index.json + INDEX.md (5 skills)`。
结果：`mtnode-agent-skills/index.json` 仅 `updatedAt` 变化，`INDEX.md` 无变化——因为本次改的是正文细则，frontmatter `description`（索引摘要来源）未动，索引与技能树现已同步。

## 校验

- `node --check renderer/app-assist.js` 通过；`node --check dsh/gateway/gateway.mjs` 通过（无输出、退出 0）。
- 新增文本可被 `indexOf` 正常定位，字符串字面量未被截断（devNodeRule 段长 2251 字符，仍为单条 JS 字符串）。

## 未做的事（计划外）

未运行测试 / 打包 / 安装依赖；未改 `renderer/app.js`、`app-agent.js`、`i18n.js`（这些文件在 `git status` 中已有改动，来自其它并行任务，非本任务产出）。本任务只动了上列 4 个文件。
