# Agent Token 账单与优化台账

诊断工具：`scripts/audit-token-usage.mjs`（只读本机 `%APPDATA%\pipeline-console\dsh-home\sessions\*\*\session.jsonl[.zstd]`，
零依赖、手动跑，`--help` 读口径）。回归门槛：`test/smoke-token-budget.js`（当前 195 项全绿）。

一句话结论：最大的钱不在「做事」，而在**每轮重发的固定描述与快照** + **改完回读** + **连线试错**。
两轮迭代分别打掉这三项：第一轮把助手快照的节点正文去掉，第二轮把工具描述瘦身搬进按需技能、
让 edit 回执自足免回读、把端子 / 连线 / 路径约束前移到 schema 与收尾一次性校验。

---

## 第一轮：助手快照去正文（已落地）

一次「4 节点 + 5 条线」的轻任务却背了整张 39 节点教程画布的上下文。诊断结论：token 不在「建节点」，
而在**每轮对话被动注入的全量画布状态**——`text / prompt / task / goal` 等节点正文随 `app_state`
每轮原样重发（该画布 34 个节点带正文约 8,500 字符，单条音乐风格提示词就有 2,040 字）。

| 优先级 | 建议 | 状态 |
|---|---|---|
| ★★★ | 自动注入的状态改为「节点索引」，任何情况下不带正文 | **已落地**：`assistAppSnapshot` 不再注入正文 |
| ★★★ | 正文一律按需拉取（`canvas_get ids:[…] detail:"full"`） | **已落地**：系统提示补「快照不含正文、正文现拉」纪律 |
| ★★★ | 每轮只注入增量 | 不做（见下） |
| ★★ | `canvas_get` 默认 `detail` 由 `standard` 改 `minimal` | **第二轮落地**（见下） |
| ★★ | 节点正文硬上限（超长只给 `*Len` + 摘要） | 已落地（`bodyLimit` / `*Len`，默认保留按需全文） |
| ★★ | 只查连线的轻接口（避免为接线读整图） | 已落地（`sections`，本轮补「只查连线用 `["nodes","wires"]`」指引） |

**为什么不注入增量**：本 harness 每轮重建 systemPrompt，且历史里不含旧 systemPrompt；纯增量会让模型
看不到未变化的节点（等于把画布读瞎）。改由「按需 `canvas_get`」解耦画布大小与任务成本。

---

## 第二轮：工具描述瘦身 + 回执自足 + 预检前移 + 快照再降

第二份报告把矛头指向「E2E 一次建图任务」的实际钱包：工具描述与快照每轮重发、改完必须回读、
端子冲突与后缀笔误要「错了—报错—再改」。八条建议的落地状态：

| 优先级 | 建议 | 状态 |
|---|---|---|
| ★★★ | 工具描述瘦身：长规则搬进按需 skill | **已落地**：`EDIT_DESC` 只留卡口，完整硬规则进技能 `mtnode-canvas-edit-rules` |
| ★★★ | edit 回执自足、取消「改完回读」 | **已落地**：created / updated 带 `x/y/w/h` + 端口占用摘要；新增 `detail:"diff"` |
| ★★★ | 端口 / 连线预检前移到 schema | **已落地**：`canvas_get`（standard / full）暴露 `ports`；`connect` 失败回候选端子 + 接法建议；save 后缀 create / update 即校验 |
| ★★★ | 长正文一条都不进主上下文 | **已落地**（纪律）：节点间只写 `@标题`，长文案交给 `agent_task` / `input_text` 落文件 |
| ★★ | 校验一次性到底 | **已落地**：`collectEditStaticWarnings` 收尾合并五类静态检查进同一份 warnings |
| ★★ | 快照默认最小化 | **已落地**：`DEFAULT_GET_DETAIL = 'minimal'`；`app_state` 再降到「计数 + 选中 / 焦点」 |
| ★★ | 输出侧克制 | **已落地**（纪律）：收尾只报改了什么、产物路径、需用户操作的 1–2 处 |
| ★ | 长任务用 goal / subagent 隔离 | **已落地**（纪律）：建图—自查—排版放进子代理上下文，主对话只收最终回执 |

### 实测数字（代码侧，可复测）

`test/smoke-token-budget.js` 与网关实测量：

| 口径 | 优化前 | 本轮后 |
|---|---|---|
| `mtnode_canvas_edit` 描述本体（含固定前缀 NODE_LOCK） | ≈ 3.1K 字符 | **1,798 字符**（上限门槛 2,000） |
| 完整画布编辑硬规则 | 随工具描述每轮重发 | 技能 `canvas-edit-rules` 3,412 字符，命中「建图 / 连线 / 批量 / 媒体」才按需加载 |
| `mtnode_canvas_edit` 工具 JSON Schema 合计 | 59,185 字符 | **16,295 字符**（描述 1.8K + create/update 共用属性表 14.2K） |
| 同一张图（120 节点 × 5 正文键 × 400 字符 = 240,000 字符正文）的 `app_state` | 随每轮重发约 8.5K–240K 字符 | **791 字符**（非 canvas-free）/ **450 字符**（canvas-free） |
| `canvas_get` 缺省档位 | `standard`（配置齐全 + `*Len`） | **`minimal`**（纯节点索引：每节点只给 标题 / 描述(note) / 类别(kind)） |
| `mtnode_canvas_get` 描述本体 | ≈ 3.9K 字符（按 kind 的字段清单 + GRANULARITY 逐参数复述 + 功能色卡硬拷贝） | **2,066 字符**（字段清单与逐参数复述已删：参数取法真源只有 parameters 表；色卡由 `detail:"standard"` 的 `devFuncColors` 返回） |
| `mtnode_canvas_get` 工具 JSON Schema 合计 | ≈ 6.2K 字符 | **4,423 字符** |
| 缺省读图返回体 | 每节点带配置 / 坐标 / 层级，外加 wires / marks / groups / trees / kinds / 颜色卡 / cam | **纯节点索引**：重型块只留 `nodes`，静态词表与视角一并摘掉（要它们显式 `detail:"standard"` 或 `sections` 点名） |
| edit 回执 | 计数 + 别名 / 标题 | **计数 + 每条 `x/y/w/h` + `ports`（端子 index/name/kind/已连数）** |

每步固定前缀里 `mtnode_canvas_edit` 描述省下的 ≈1.4K 字符（≈0.5K token）**每一次模型调用都省**，
且不再随历史重放放大；被搬走的规则只在建图轮按需付一次。

### 实测数字（审计脚本，本机账单）

`node scripts/audit-token-usage.mjs --project pipeline-console --since 14`（本机 40 个会话，
`deepseek-v4-flash` 为主，这一批日志主要反映改造前 / 改造中的历史）：

- 固定前缀平均 **46.4K 字符 ≈ 16.6K token/步**（system 最大 7.0K · tools 最大 43.1K 字符）。
- 实测第一步 prompt：平均 **25.4K token**、最大 36.3K。
- 计费面：prompt 总量 101.08M token（非缓存输入 1.40M + 缓存读 99.68M），缓存命中率 **98.6%**；
  步数 1233、平均每步 **82.0K token**；历史增长累计重放量 Σ(每步 prompt − 首步) = 100.07M token。
- 最贵的工具说明书：`mtnode_canvas_edit` **17.5K 字符**（描述 3.2K + 参数表 14.2K，占 tools 40.7%，35 个会话）——
  本轮瘦身后描述已降到 1,798 字符。
- 最贵的工具返回：`read` 493 次 / 1.78M 字符（均值 3.6K、单次最大 39.5K）。

> 口径说明：审计读的是**本机历史会话日志**，这批会话多为改造前产生，因此「固定前缀 46.4K / 每步 82.0K」
> 是**基线**而非改造后的结果；改造收益以「代码侧可复测数字」为准（工具描述、快照、回执三项都由冒烟门槛钉住）。

### 回归门槛（`test/smoke-token-budget.js`）

- `[1]` `EDIT_DESC` 本体 ≤ 2,000 字符、`GET_DESC` 本体 ≤ 2,200 字符、
  `mtnode_canvas_edit` schema ≤ 17,000 字符、`mtnode_canvas_get` schema ≤ 8,000 字符、两个主干工具合计 ≤ 24,000 字符；
  仍保留 judge 双出 / 参数即端子 / `superConnect` / `save 与 wait_file` / 批次等硬信息，且 12 条硬规则正文已迁出、
  `GET_DESC` 不再带按 kind 的字段清单与功能色卡硬拷贝。
- `[9]` 助手两档 `app_state` 都不取整图快照（`canvasSnapshotFull` / `canvasSnapshot` 零调用）、
  不含任何画布快照字段与正文键，只给计数 + 选中 / 焦点（对照 240,000 字符正文）。
- `[10]` edit 回执自足（x/y/w/h + ports）、`detail:"diff"` 只回明细、`ports` 暴露、
  connect 候选建议、保存后缀预检、收尾一次性校验（含去重）、`canvas_get` 结构哈希缓存、
  `minimal` = 纯节点索引（节点白名单 = 标题 / 描述 / 类别；重型块只留 `nodes`；静态词表与视角一并摘掉）。

`test/smoke-canvas-scope.js` `[5]` 真跑 `canvasSnapshot({detail:"minimal"})` 钉住：
每节点只带 标题 / 描述 / 类别、没有 id / 坐标 / 配置 / 正文，`marks` / `wires` / `groups` / `taskTree` / `superTree` /
`kinds` / `cam` / `view` / 颜色卡一个都不带，`workflow` + `scopeInfo` 这层小信封仍在，
且 `sections:["nodes","wires"]` 在 minimal 档仍能便宜地只查连线；`[1]` 另钉住「`ports` 只在 standard / full 档暴露、minimal 档不带」。

---

## 已知问题

- `test/smoke-token-budget.js` [1] 的 `mtnode_canvas_edit ≤ 16,000` 旧门槛已在第二轮随工具描述瘦身
  更新为 **描述本体 ≤ 2,000 + schema ≤ 17,000**（工作区实测 16,295）；原「17.5K 超门槛」的既有红已消除。
- `test/smoke-session-canvas.js` 有 9 项既有红（`guides/manual/en/*` 英文小节缺失、`applyAppOp` 三参调用
  等），来自工作区里**另一条在途改动**，与本轮 token 优化无关，未在本次改动范围内。
- `dsh/smoke-settings.mjs` 与 `dsh/smoke-real.mjs` 在本机跑不起来：二者都在 import 阶段读
  `C:/Users/<user>/.dsh/.credentials.yaml` 的 `DEEPSEEK_API_KEY`，而本机该文件是 `version / refs`
  格式、没有这个键 —— 属环境前置缺失（真实密钥类文件不入库），与本轮改动无关。
  `dsh/smoke-gateway.mjs`（退出码 0）与 `dsh/smoke-interaction-gate.mjs`（41 项全通过）可跑。

---

## 度量方法（下次迭代怎么复测）

1. 改动前后各跑一次 `node scripts/audit-token-usage.mjs --project pipeline-console --since N`，
   对比「固定前缀 / 每步 prompt / 工具返回体积 / 缓存命中率」四项。
2. 跑 `node test/smoke-token-budget.js`（＋ `smoke-canvas-scope.js` / `smoke-systemprompt-sections.js`）
   确认代码侧门槛没被改回去。
3. 工具负载看 `mtnode_canvas_edit` 的「描述 / 参数表」两列：描述应稳定在 2K 字符以内，
   参数表是 create / update 共用的机器可读契约，不属本轮瘦身范围。
