# pilot2 试点校准：新增 code / minimal 两臂 + 量化「前缀长度」这一结构性差异

- 运行：`node scripts/bench/run-bench.mjs --limit 5 --run pilot2 --arms code,minimal --concurrency 1`
- 产物（全部仓库外）：`%LOCALAPPDATA%\mtnode-bench\runs\pilot2\`（results.jsonl / results.json / scores.jsonl / summary.csv / run-meta.json / runner.log）
- 模型 `deepseek-v4-flash` · 服务商 `deepseek-official` · 权限档 `mtnode-unattended` · 题集 sha256 与 pilot/full 完全一致（c6cc35835867… / 780c330b3a93…）
- 判分：`node scripts/bench/score.mjs --run pilot2`
- 样本：5 GSM8K + 5 HumanEval = 10 题 × 2 臂 = 20 次运行（+2 次预热），ok=22 / error=0 / timeout=0，用时 0.8 分钟

## 1. 协议与记账验收（全绿）

| 验收项 | code | minimal |
|---|---|---|
| status | ok 10/10 | ok 10/10 |
| token 字段非零 | inputTokens 10/10、cacheRead 10/10、output 10/10、reasoning 10/10（cacheWrite 恒 0，服务商不记缓存写） | 同（reasoning 9/10，一次思考 0 token） |
| effort | 请求 high → **生效 high**（10/10） | 请求 high → **生效 high**（10/10） |
| steps / 工具调用 | steps 均值 1.00，metrics.tools=0，streamed.toolCalls=0 | 同 |
| 写文件 | 槽位工作区 `ws\run-pilot2\` **0 个文件** | 同 |
| 交互（问人/审批/画布/数据库） | 0 / 0 / 0 / 0 | 同 |

effort 生效的三重直接证据（不靠推断）：
1. `run-meta.json` / 每条记录：`effortRequested=high, effortEffective=high`；
2. 评测专用 `gateway-home\settings.yaml` 跑完后为 `llm-deepseek: reasoningEffort: high`；
3. 网关自身 stderr 的 runKey 标记：pilot2 = `pure:0|high`，而 full（standard+lean）= `pure:0|low`×4 —— lean 被网关 PRESET_EFFORT_CAPS 压档、code/minimal 不压，对照成立。

工具闸门有效：即便 `code` 人设写着「先读文件再改、跑命令完成任务」，在题面闸门（"Answer directly from your own reasoning…"）+ `mtnode-unattended` 下**一次工具都没调**，两臂仍是单步纯推理，token 账没被工具轮次污染。

## 2. minimal / code 的答复格式分布（判分风险已排除）

| 口径 | code | minimal | standard（同 10 题） | lean（同 10 题） |
|---|---|---|---|---|
| 答复字符 中位 / min / max | 299 / 163 / 815 | 261 / **82** / 804 | 274 / 139 / 804 | 317 / **7** / 812 |
| 空答复（<20ch） | 0 | 0 | 0 | 1 |
| 超短答复（≤80ch） | 0 | 0 | 0 | 2 |
| HumanEval 恰好一个 ```python 块、块外 0 字符 | 5/5 | 5/5 | 5/5 | 5/5 |
| GSM8K 末行 `#### ` | 5/5（含 1 次 `#### $40`） | 5/5 | 5/5 | 5/5（含 `#### $40`） |
| 判分成功率 | **100%（10/10）** | **100%（10/10）** | — | — |

结论：
- **minimal 的「少解释」没有把答案压掉**：代码块仍在、块外散文为 0、`####` 行齐全，最短 82ch 也仍是完整可判分答复。判分链路对 `code`/`minimal` 两个新臂名零改动可用（score.mjs 的臂名本就参数化）。
- 唯一格式噪声与臂无关：`#### $40` 带货币符，`score.mjs` 的 `normalizeNumeric()` 已去 `$¥€%` 与逗号，不会误判。
- 试点无区分度（两臂 100% 正确，McNemar p=1，同对 10 / 分歧 0）——10 条样本量本来不足以拉开正确率，正式跑的区分度要看 100 题。

## 3. 「前缀长度」的结构性量化（本任务的主交付）

同题配对（题面 promptChars 逐题相同，Δ 只可能来自人设前缀）：

| 臂 | 输入总计均值 | 非缓存输入 | 缓存读 | 缓存占比 | 输出 | 思考 | wall 中位 | 成本 peak 元/次 |
|---|---|---|---|---|---|---|---|---|
| standard | 26,886 | 185 | 26,701 | 99.31% | 218 | 116 | 2,033 ms | 0.00519 |
| lean | 25,480 | 187 | 25,293 | 99.27% | 142 | 46 | 1,715 ms | 0.00437 |
| code | 25,309 | 349 | **24,960** | 98.62% | 261 | 153 | 1,967 ms | 0.00589 |
| minimal | 25,303 | 343 | **24,960** | 98.64% | 144 | 50 | 1,451 ms | 0.00482 |

**发现 A — 前缀长度差是一个逐题恒定的常数偏移，可精确剥离。**
Δ输入总计（vs standard）在 10 题上**每题都一模一样**：lean −1,406、code −1,577、minimal −1,583；code 与 minimal 之间只差 **6 tok**（两档人设文本长度本就相近）。也就是说人设长度 → 输入侧是一条纯平移，不含任何与题目互动的项，报告里可以直接按「每臂前缀常数」把它从 token 差异中扣掉。

**发现 B — 短人设会改变缓存结构，而且 code/minimal 与 lean 是两种不同机制。**
- standard / lean 的缓存读是**三个离散档**（26,624 / 26,752 / 26,880 与 25,216 / 25,344 / 25,472），即命中点落在人设**之后**、随题面分块粒度微跳；lean 相对 standard 的减量 −1,408 **全部落在缓存读**，非缓存输入几乎不变（+2 tok）→ 题面照旧被缓存住。
- code / minimal 的缓存读**塌成单一常量 24,960（极差 0）**，同时非缓存输入 +158 ~ +164 → 人设短到跌破公共锚点，缓存边界改由「工具定义 / 运行时上下文」那一段决定，**题面整段脱离缓存**。
- 所以「短人设」在 token 账上看着更省（−1,577），但结构上是「省了几乎免费的缓存读、多花了 10 倍价的非缓存输入」。

**发现 C — 因此在计费口径（peak：输入 3.0 / 缓存命中 0.1 / 输出 9.0 元·M⁻¹）下方向会翻转。**

| 臂 | Δ成本 vs standard | 拆解 |
|---|---|---|
| lean | **−15.7%** | 前缀省 1,408（全在缓存）+ 思考档压 low 省输出 76 |
| minimal | −7.2% | 前缀省 1,741（缓存）− 非缓存多 158 − 输出省 75 |
| code | **+13.6%（更贵）** | 前缀省 1,741（缓存）− 非缓存多 164 + 输出反而多 43（思考 +37） |

**「短人设 → 输入侧结构性变便宜」只在原始 token 口径成立，在成本口径下不普适**：code 臂（人设长度与 minimal 几乎相同，仅文本内容不同）就因为多写 43 tok 输出而整体贵过 standard，且它的非缓存增量(+164)与 minimal(+158) 同级 —— 说明 code/minimal 的**成本差几乎全部来自输出侧，而不是输入侧**，这正是我们要与 lean 分开列的证据。

## 4. 报告口径建议（据本次校准）

1. 输入侧必须三列并报：**输入总计 tok / 非缓存 tok / 缓存读 tok**，并附「缓存读离散度」，因为 code/minimal 出现缓存塌方（24,960 常量）。
2. token 差异一律先扣**每臂前缀常数**（standard→lean −1,406、→code −1,577、→minimal −1,583，单位 tok/次）再谈「思考档」与「表达长度」的效应。
3. 成本与 token 两套口径分别给结论，禁止用「总 token 更少」直接推「更便宜」（本次 code 就是反例）。

## 5. 代码改动（本任务唯一仓库改动）

回归校验（`--dry-run`，不花 token）：`standard→high / lean→low / code→high / minimal→high`，且 `--arms lean --effort max → 预期生效 max`（显式 max 不降档，与网关规则一致）——lean 原行为逐字未变。
成本口径取自 `score.mjs` 的 `DEFAULT_PRICES.peak`（输入 3.0 / 缓存命中 0.1 / 缓存写 0 / 输出 9.0，元·M⁻¹），与判分产物 `summary.csv` 的「成本(主口径)」同源；本文四臂成本表可直接由 `results.jsonl` 的 `usage` 字段复算。

`scripts/bench/run-bench.mjs`：
- `ARMS` 增加 `code` / `minimal` 两臂（各自映射到网关同名 `PRESETS`，`capNote: 无上限`）。
- 降档标注由硬编码 `armName !== 'lean'` 改为表驱动 `ARM_EFFORT_CAPS = { lean: 'low' }`（镜像网关 `PRESET_EFFORT_CAPS`，lean 行为逐字不变，新臂保持请求档）。
- 头注释补 `code` / `minimal` 两臂定义与 `--arms` 可选值说明。

未改：`score.mjs`（臂名本就参数化）、`dsh/` 网关、题面 `buildInput()`、`fetch-data.mjs`。`dsh/gateway/cordis.yml` 跑完已由脚本还原（`git diff` 干净），备份另存 `%LOCALAPPDATA%\mtnode-bench\cordis.yml.bak-pilot2`。

## 6. 发现的结构性问题 → 请示

试点协议全绿，但发现两项结构性问题，按约定**先报数再决定是否照旧跑各 100 题**：

1. **code / minimal 出现缓存塌方**（缓存读恒 24,960，题面脱离缓存），与 lean 的「前缀平移、题面仍缓存」不是同一机制。若照旧用「总 token」汇总，会把两类机制混成一类。
2. **code 臂在成本口径下比 standard 更贵（+13.6%）**，`--sample 100` 规模下这个反向差异需要保留区分，否则报告会得出与试点相反的结论。

建议正式跑另起一个 run 名（试点记录留在 `pilot2`，不与之混档）：
`node scripts/bench/run-bench.mjs --sample 100 --arms code,minimal --concurrency 3 --run full2`
（同题集、同题面、同 seed 1234，可中断续跑；预热默认开）判分 `node scripts/bench/score.mjs --run full2`。
若还要把 code/minimal 与 standard/lean 放进同一张四方对比表，另加跑一组同 100 题的 `--arms standard,minimal --run full3` 即可，全部按第 4 节的三列口径出报告。请确认后我再启动。
