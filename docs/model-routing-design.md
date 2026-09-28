# 模型分配与路由机制设计（每角色不同模型）

> 目标：在 MTNode（本地优先的 Electron 工作流编排器）里，把「每个角色/任务用不同模型」做成可配置、可解释、可治理的机制——模型注册表 → 角色分配 → 项目覆盖 → 混合路由 → 降级回退 → 成本预算与用量统计。
> 范围：机制设计 + 落地映射 + 取舍。不包含本次未要求的代码实现。

---

## 1. 现状锚点（设计必须接得上）

| 现有面 | 位置 | 语义 |
| --- | --- | --- |
| 服务商与模型清单 | `config.json` → `providers[]`（`config-providers.js` 原子写入） | `{id, name, baseUrl, apiKey, models[]}`，无能力/成本标签 |
| 节点级模型 | `proc_text` / `proc_image` / `agent_task` 的 `providerId` / `provider` / `model` | 显式指定，最高优先 |
| 开发节点级模型 | `devModel` / `devProvider` / `devPreset` / `devEffort`（`app-devnode.js`） | 逐层就近继承，互不牵连 |
| 会话预设 | `dsh/gateway/gateway.mjs` → `PRESETS`（minimal / standard / lean / code / cordis） | 只控制工具负载与人设，不含模型 |
| 识图路由 | 工具描述「provider 顺序 → model 顺序」挑 vision 模型 | 隐式、无能力过滤，只看顺序 |
| 用量诊断 | `scripts/audit-token-usage.mjs`（只读、零依赖、解析 session.jsonl） | 事后分析，不做运行时记账 |

结论：模型选择目前是**点状显式 + 隐式顺序**，缺三样——统一的模型元数据（能力/成本/延迟/上下文）、角色到模型的声明式映射、运行时的成本与健康度闭环。本设计补齐这三样。

---

## 2. 模型注册表（Model Registry）

### 2.1 定位

注册表是**唯一模型元数据真源**：一切路由决策（能不能用、贵不贵、快不快、装不装得下）都查它。存放在 `config.json` 新增的 `modelRegistry[]`，由内置目录（builtin）+ 用户覆盖（user）合并而成；`providers[].models[]` 仍是「有哪些模型可选」的真源，注册表为每个模型补标签，两者用 `providerId + apiModel` 关联。

### 2.2 条目 Schema

```jsonc
{
  "id": "deepseek-v4-flash",          // 全局唯一键（UI 与策略引用它）
  "providerId": "deepseek-official",  // 关联 providers[].id
  "apiModel": "deepseek-v4-flash",    // 发给服务商的真实模型名
  "displayName": "DeepSeek V4 Flash",

  // —— 能力标签 ——
  "caps": {
    "text": true,          // 文本输入
    "imageIn": false,      // 图片输入（多模态）
    "imageOut": false,     // 图片输出（文生图）
    "audioIn": false,
    "tools": true,         // 支持 function/tool calling（智能节点必需）
    "jsonMode": true,      // 结构化输出
    "stream": true,
    "prefixCache": true    // 支持前缀缓存（成本治理关键）
  },

  // —— 档位（混合路由的核心抽象）——
  "tier": "fast",          // fast | balanced | reasoning | vision | media

  // —— 容量 ——
  "context": { "window": 128000, "maxOutput": 8192 },

  // —— 成本（每 100 万 token，记账与预算用）——
  "cost": { "inPer1M": 0.28, "outPer1M": 0.42, "cachedInPer1M": 0.028, "currency": "CNY" },

  // —— 延迟画像（用于排序与超时预算）——
  "latency": { "ttftMs": 400, "tps": 120, "class": "fast" },

  // —— 限额与健康（运行时更新，不落盘或只落健康快照）——
  "limits": { "rpm": 500, "tpm": 500000 },
  "health": { "status": "ok", "cooldownUntil": null, "failStreak": 0 },

  "tags": ["cheap", "fast", "cn"],
  "source": "builtin"           // builtin | user | plugin（插件托管项只刷新元数据，不动用户字段）
}
```

### 2.3 注册表规则

- **能力是硬门槛**：路由先按 `caps` 过滤（如 vision 角色必须 `imageIn:true`，智能节点必须 `tools:true`，文生图必须 `imageOut:true`），过滤后才是排序。
- **tier 是软档位**：`reasoning` = 深度推理/规划；`balanced` = 通用；`fast` = 高频轻任务；`vision` = 图像理解；`media` = 图像/音视频生成。角色默认绑定 tier，而非绑定具体模型——换供应商时策略不用改。
- **成本/延迟为排序键**：同 tier 内按「健康 → 成本 → 延迟」排序，用户可在设置里调整权重（默认成本优先）。
- **未知模型兜底**：providers 里有、注册表没有的模型，自动生成最小条目（`tier:"balanced"`、`caps.tools:true`、`cost:null`），标 `source:"builtin"` 且 UI 提示「成本未知，不参与预算硬拦截，只做告警」——绝不因为缺元数据而拒绝用户已有的模型。

---

## 3. 角色与任务定义

「角色」= 谁在调用模型；「任务类型」= 这次调用要干什么。二者组合成路由键。

| 角色 | 对应 MTNode 面 | 典型任务类型 | 默认 tier |
| --- | --- | --- | --- |
| `assistant` | 全局助手 ✦ / 会话 | 规划、画布编排、问答 | `reasoning`（复杂） / `balanced` |
| `agent_node` | `agent_task` / `proc_text(agent)` | 长任务执行、写文件 | `reasoning` |
| `dev_advise` | 开发节点「建议」 | 架构建议、需求拷问 | `reasoning` |
| `dev_build` | 开发节点「开发」 | 写代码 | `reasoning` |
| `dev_refine` | 开发节点「细化」 | 逐层下钻 | `reasoning` |
| `dev_inquire` | 开发节点「问询」 | 短问答 | `fast` |
| `proc_text` | 普通文本处理 | 摘要、改写、抽取 | `fast` / `balanced` |
| `judge` | `judge` 节点 / 校验 | 判定、打分 | `fast` |
| `vision` | `mtnode_vision` / 视觉节点 | 读图 → 文本 | `vision` |
| `image_gen` | `proc_image` | 文生图 | `media` |
| `utility` | 分类器、嵌入、标题生成 | 轻量启发式 | `fast` |

> 角色表是**可扩展的命名空间**，不是硬编码枚举：插件可注册新角色并声明默认 tier。

---

## 4. 分配优先级规则（分辨率从高到低）

路由解析是一个**自上而下、逐级回退**的链：任何一级命中即停，只指定 `tier` 时在该 tier 内按 §2.3 排序取第一个可用模型。

| 优先级 | 层级 | 配置位置 | 说明 |
| --- | --- | --- | --- |
| P0 | 本次调用显式指定 | 节点 `providerId`/`model`、`devModel`+`devProvider`、工具入参 `model` | 用户手选，永远最高优先；校验能力不匹配则告警并允许强制 |
| P1 | 最近祖先 super | `devModel` 逐层向上继承 | 与现有「就近继承、互不牵连」一致；只作用于开发节点树 |
| P2 | 项目/画布覆盖 | `workflow.meta.modelPolicy` | 单项目用不同供应商/预算（见 §4.2） |
| P3 | 角色级默认 | `rolePolicy[role]` | 声明式，可写 `tier` 或模型候选列表 |
| P4 | 全局默认路由 | `globalRoute` | provider 顺序 + model 顺序（现有 vision 行为升级版） |
| P5 | 内置兜底 | builtin 目录 | 最后防线，保证任何情况都有模型可用 |

### 4.1 每级的形态

```jsonc
// P3 角色级默认
"rolePolicy": {
  "assistant":    { "tier": "reasoning", "fallbackTiers": ["balanced"] },
  "dev_build":    { "tier": "reasoning", "fallbackTiers": ["balanced"] },
  "proc_text":    { "tier": "fast",      "fallbackTiers": ["balanced"] },
  "judge":        { "tier": "fast",      "allowEscalate": true },   // 允许升级到 reasoning
  "vision":       { "requireCaps": ["imageIn"], "tier": "vision" },
  "image_gen":    { "requireCaps": ["imageOut"], "tier": "media" }
}
```

### 4.2 项目级覆盖（P2）

```jsonc
"workflows": { "<wfId>": { "modelPolicy": {
  "overrides": { "dev_build": { "model": "gpt-5-codex", "providerId": "openai" } },
  "budget": { "run": 20, "day": 200, "currency": "CNY" },
  "defaultTierShift": -1        // 全局降一档：reasoning→balanced，balanced→fast
} } }
```

覆盖语义：**先应用项目覆盖，再走角色默认**；`overrides` 是角色级替换，`defaultTierShift` 是整体降档开关（成本紧张时的全局旋钮）。

### 4.3 解析伪代码

```
resolveModel(role, node, workflow):
  req = { role, caps: requiredCaps(role, node) }        # vision→imageIn, agent→tools …

  # P0 显式
  if node.providerId and node.model: return check(node.providerId, node.model, req)

  # P1 祖先继承（仅 dev 树）
  anc = nearestAncestorWithDevModel(node)
  if anc: return pickInTier(tierOf(anc.devModel), req)

  # P2 项目覆盖
  if workflow.modelPolicy.overrides[role]: return check(override, req)
  tier = rolePolicy[role].tier + (workflow.modelPolicy.defaultTierShift or 0)

  # P3/P4/P5 候选链
  for t in [tier, ...fallbackTiers(role)]:
     c = candidates(t, req)                              # 按 caps 过滤
     c.sort(health, cost, latency)                       # §2.3
     if c: return c[0]
  return error("无满足能力的可用模型")                     # 明确失败，不静默降质
```

---

## 5. 混合路由（推理模型 vs 快速模型）

两级路由：**静态角色绑定 + 动态难度/成本决策**。

### 5.1 静态层

角色默认 tier（§3）解决 80% 场景：规划/开发/细化 → `reasoning`，摘要/判定/问询 → `fast`，识图 → `vision`，生成 → `media`。这是可解释、零额外调用的基线。

### 5.2 动态层

只在**高成本角色**（`assistant`、`agent_node`、`dev_*`）开启，用一个**零成本启发式分类器**（不额外调 LLM）判断本次请求难度：

| 信号 | 判为「需要推理」 |
| --- | --- |
| 提示词长度 | > 8k tokens |
| 工具数量 | > 3 个已注册工具 |
| 多步规划 | 含 task 节点 / 含「拆解 / 规划 / 架构」意图 |
| 历史轮次 | 会话已 > N 轮且前一轮失败/被回退 |
| 图像输入 | 走 `vision`，不参与本判断 |
| 用户显式 | 用户手选或项目覆盖，跳过动态层 |

打分 `score ≥ 阈值` → 用 `reasoning`；否则用 `fast`。阈值与信号权重可在设置里调。**取舍**：学习型路由器（RouteLLM）精度更高，但需偏好数据与训练，与 MTNode「零依赖、数据不出本机」冲突，因此先用启发式，接口留成可插拔（`DifficultyScorer` 可换成 LLM 分类器或未来本地小模型）。

### 5.3 升级（escalation）

`fast` 的结果被下游 `judge` 节点判否，或输出解析失败/工具调用格式错时，**自动升级到 `reasoning` 重试一次**（每任务最多 1 次，可配）。升级次数计入成本统计，UI 标注「本步因校验失败升级」。这是「快模型省成本 + 慢模型保质量」的关键闭环。

---

## 6. 降级与回退（fallback）

### 6.1 触发条件

| 条件 | 动作 |
| --- | --- |
| 429 / 5xx / 网络超时 | 标记健康降级，换候选 |
| 上下文超窗 | 换更大 `context.window` 的候选，或触发压缩 |
| 内容策略拒答 | 换供应商候选（不同策略） |
| 不支持 tools/json（能力不符） | 换满足 `caps` 的候选 |
| 空响应 / 格式错 | 同模型重试 1 次，仍失败则回退 |

### 6.2 回退链顺序

```
同 tier 同能力内下一候选 → 降 tier（仅当 rolePolicy.fallbackTiers 允许，且记录「降质」事件）
→ 本地模型（llama.cpp / 本机 OpenAI 兼容代理）→ 明确失败（可读原因 + 建议）
```

### 6.3 熔断与退避

- 每次失败 `failStreak++`；连续 3 次或 429 → `health.status="degraded"` + `cooldownUntil = now + 60s·2^n`（上限 15 分钟）。
- 冷却期内该模型不参与排序；冷却结束自动恢复为 `ok`。
- 单请求回退上限 N=3，指数退避，避免雪崩。
- 全链路失败时输出结构化原因（哪一级、什么错、试过哪些模型），而不是一句「调用失败」。

---

## 7. 成本预算与用量统计

### 7.1 预算层级

| 层级 | 键 | 默认 |
| --- | --- | --- |
| 全局 | `budget.global.{day,month}` | 不设（告警模式） |
| 项目/画布 | `workflow.modelPolicy.budget.{run,day}` | 不设 |
| 单次运行 | 同上 `run` | 不设 |
| 单节点 | `node.costLimit` | 不设 |

未设预算时**只记账不拦截**（本地工具不应擅自阻断用户），设置后按下面阈值执行。

### 7.2 记账

每次模型调用落一条本地记录（复用 `db-store.js` 的 SQLite，新增 `usage` 表，或独立 `usage-store.js`；全部本机，不上云）：

```jsonc
{ "ts", "workflowId", "nodeId", "role", "providerId", "modelId", "tier",
  "inputTokens", "outputTokens", "cachedTokens", "cost", "currency",
  "latencyMs", "ttftMs", "attempts", "fallbackFrom", "escalated", "ok", "errCode" }
```

`cost = in/1e6*inPer1M + out/1e6*outPer1M + cached/1e6*cachedInPer1M`；成本未知的模型记 `cost:null` 并单列。

### 7.3 阈值与拦截

| 用量 | 动作 |
| --- | --- |
| ≥ 80% 预算 | 软告警；自动把 `defaultTierShift = -1`、关闭升级重试 |
| ≥ 100% 预算 | 硬拦截：拒绝新的高成本调用，只允许 `fast` tier，UI 给出「已用尽，可提高预算或换模型」 |
| 单次运行超 `run` 预算 | 中止本次运行，保留已完成产出 |

### 7.4 成本优化手段（按收益排序）

1. **前缀缓存优先**：优先选 `caps.prefixCache:true` 且缓存价低的模型（MTNode 固定前缀很重，缓存命中率直接影响成本）。
2. **档位分层**：静态 tier 绑定 + 动态难度，让多数调用落在 `fast`。
3. **结果缓存**：同输入同模型的幂等调用复用（如重复试跑）。
4. **批量策略**：逐条批量用 `batchMode=batch`（每次只看一条），避免 N² 调用——与 `mtnode-canvas-batch-safety` 一致。
5. **prompt 压缩**：减少工具负载（lean 预设）、精简上下文。
6. **升级/回退预算**：升级每任务 ≤1 次，回退每请求 ≤3 次。

### 7.5 统计报表

按 `角色 / 项目 / 模型 / 天` 四维聚合：成本、token、调用次数、缓存命中率、回退率、升级率、平均延迟、成本 top-N。复用 `audit-token-usage.mjs` 的解析口径，把事后分析与运行时记账对齐。

---

## 8. 对标 SOTA 与取舍

| 方案 | 做法 | 借鉴 | 取舍 |
| --- | --- | --- | --- |
| **RouteLLM**（LMSYS） | 训练偏好模型预测「该用强模型还是弱模型」 | 难度路由思想 | 需数据与训练，与本地零依赖冲突 → 用启发式，留可插拔接口 |
| **Optimized Workforce Learning / CAMEL** | coordinator + worker 分工，按角色配模型 | 角色分工、worker 用便宜模型 | 其重点在任务编排；MTNode 复用「角色 → tier」而非复制其调度器 |
| **LangGraph / AutoGen** | 每个 agent 显式绑定 `llm` | 显式可解释 | 无成本/健康感知 → 我们加注册表 + 预算 + 熔断 |
| **OpenRouter / LiteLLM Router** | 多供应商聚合、fallback、成本统计 | 回退链 + 成本记账 + 健康度 | 云端聚合不可用 → 全本地注册表，行为等价 |
| **Claude Code / Cursor 分级**（opus/sonnet/haiku、auto） | 用户按任务挑档位 | tier 抽象 | 档位是厂商内定的 → MTNode 让 tier 与供应商解耦 |
| **GPT-5 / auto 路由器** | 单一入口自动选模型 | 自动化的体验 | 黑盒不可控 → 保留显式覆盖与「回显即实际下发」 |

**总取舍**：MTNode 是本地优先、可解释的桌面工具，因此选择「**显式声明优先 + 启发式自动兜底 + 全程可观测**」，而不是学习型黑盒路由。任何自动决策都必须在 UI 回显（选中的模型 / tier / 是否回退升级），用户随时可用 P0 覆盖。

---

## 9. 落地映射（改动清单）

| 层 | 文件 | 改动 |
| --- | --- | --- |
| 渲染层 | `renderer/app-team.js`（新） | 注册表合并、优先级解析、回退/熔断/升级、用量聚合。**不新增根目录主进程模块**（原 `model-router.js` / `usage-store.js` 取消） |
| 配置 | `S.config.team`（`config.json` 的一节） | 存 `modelRegistry` / `modelAssignments` / `rolePolicy` / `budget`；读写沿用 `config-providers.js` 原子写 + 备份 |
| 项目文件 | 项目工作区 `.mtnode/usage/*.jsonl`（可选） | 用量明细落项目文件，聚合口径复用 `audit-token-usage.mjs` |
| 网关 | `dsh/gateway/gateway.mjs` | `PRESETS` 增加各预设的 tier 建议；调用前经 resolver 解析 |
| 网关 | `canvas-plugin.mjs` | `mtnode_vision` 路由由「顺序挑」改为「caps.imageIn 过滤 + vision tier 排序」 |
| 渲染层 | `renderer/app-settings.js` | 「模型服务」页加：注册表编辑、角色分配、预算与告警 |
| 渲染层 | `renderer/app-devnode.js` | `devModel` 继承链复用同一 resolver；按钮回显 tier/回退状态 |
| 渲染层 | `renderer/app-agent.js` / `app-assist.js` | 会话头显示当前角色模型与本次是否升级/回退；角色人设走 `persona_host` 分节 |
| 复用 | `provider-model-effort` / `permissionPreset` / `agentToolPresets` | 模型 / 思考档、审批档、工具白名单直接复用，不新造 |

> **硬约束**：角色人设只能走 `persona_host` 分节（`renderer/app-prompt-sections.js`），**不用 `hostPersona`**——`dsh/gateway/gateway.mjs:1602` 在 `hostPersonaText` 非空时整段替换系统提示。落点与复用清单见 `docs/workspace/one-person-company/00-mtnode-integration.md`。

**兼容性**：现有 `providers[]`、节点 `providerId`/`model`、`devModel` 全部原样生效（P0/P1），新机制只是在其下方补 P2–P5，不破坏任何既有画布。

---

## 10. 分期实施建议

1. **P1：注册表 + 显式路由**——`modelRegistry`、能力过滤、vision 路由升级、设置页只读展示。
2. **P2：角色分配 + 回退熔断**——`rolePolicy`、健康度、回退链、结构化错误。
3. **P3：成本记账 + 预算**——`usage-store`、阈值告警与硬拦截、统计报表。
4. **P4：混合路由 + 升级**——启发式难度分类、judge 触发升级、可插拔 scorer。

每期都可独立上线，且都保持「显式覆盖最高优先」的不变式。
