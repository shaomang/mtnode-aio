# 角色（Role）系统设计

> 状态：设计稿 · 仅覆盖「角色数据结构 + 角色模板库 + 人设撰写规范」三件事。
> 上游依据：`docs/codex-agent-benchmark.md` §2.7 / §2.11、`docs/prompt-source-of-truth.md`。

## 0. 定位与三条硬原则

**角色 = 一份可复用的「智能体人格 + 能力边界 + 模型档位」配置包**，挂在智能节点（`agent_task` / `proc_text(agent:true)`）与子代理上，决定它**怎么说话、用什么模型、能碰什么**。

| 原则 | 含义 | 后果 |
| --- | --- | --- |
| **R1 只收窄，不扩权** | 角色可以换模型、降思考强度、裁剪工具/技能、收紧知识范围，但**永远不能突破宿主会话的 provider / 审批策略 / 沙箱 / 工作区** | 合并时能力取交集，权限取最严 |
| **R2 人设是数据，不是代码** | 角色的全部字段可序列化（YAML/JSON），可导出、可分享、可被项目覆盖 | 不硬编码在渲染层字符串里 |
| **R3 参数机制单一真源** | Schema 字段说明只写本文；节点/画布侧只保留「怎么用」的行为纪律 | 避免字段清单抄两份 |

角色与既有概念的边界：

- **角色 ≠ 节点**：节点是执行位置，角色是执行者身份。同一个角色可以被多个节点、多个子代理、多个项目复用。
- **角色 ≠ 技能**：技能是「会做什么事」的流程知识（`skills/*/SKILL.md`）；角色是「以什么身份做事」。角色**声明需要哪些技能**，不内联技能正文。
- **角色 ≠ 预设档（preset）**：`AGENT_PRESETS`（minimal / standard / lean / code / cordis）是**基础指令的详略档**；角色是在其之上叠加的人设层。`devPreset` 与角色可同时存在。

## 1. 角色 Schema

### 1.1 顶层结构

```yaml
# 角色文件：roles/<id>.role.yaml
schemaVersion: 1
id: research-analyst            # 全局唯一，[a-z0-9-]，稳定不可改
name: 研究分析师                 # 显示名
version: 1.0.0                  # 语义化版本；内容变更必须递增
description: 面向证据的资料研究与结论提炼专家   # ≤120 字，直接进 spawn/派活指导
avatar:                         # 头像（可选）
  kind: emoji                   # emoji | image | initial
  value: "🔍"
  imagePath: null               # kind=image 时为本机/素材库路径
role:                           # 岗位/职责
  title: 资料研究员
  duty: 收集、交叉验证、按证据给出可追溯结论
  boundaries:                   # 明确不做什么（进提示词的负向约束）
    - 不替用户做最终决策
    - 不在无来源时给出具体数字
persona:                        # 人设，见 §1.2
  ...
prompt:                         # 系统提示词模板，见 §2
  ...
model:                          # 模型档位，见 §1.3
  ...
tools:                          # 可用工具/技能，见 §1.4
  ...
knowledge:                      # 知识范围，见 §1.5
  ...
overrides: {}                   # 项目级覆盖位（定义时留空），见 §3
tags: [research, analysis]      # 用于筛选/@标签
```

### 1.2 persona（人设）

```yaml
persona:
  personality: [严谨, 克制, 有主见但不武断]     # 3–6 个性格词
  tone: 简洁、结论先行、不用感叹号            # 语气/表达风格
  background: 十年数据新闻与实证研究经验      # 专业背景（一两句）
  values: [证据优先, 承认不确定, 不编造]       # 价值观/工作信条
  audience: 需要快速决策的产品负责人            # 默认读者
  language: zh-CN                            # 输出语言（默认跟随界面口味）
  signature: 每条结论末尾附一行「证据强度：高/中/低」  # 可选，稳定的行为习惯
```

> 人设只描述**稳定的表达与判断倾向**；具体任务要求写进节点 prompt / task，不写进人设。

### 1.3 model（分配模型与参数）

```yaml
model:
  provider: null            # 空 = 继承宿主会话的服务商路由
  id: null                  # 空 = 继承；非空时必须属于该 provider 的可用模型
  effort: null              # low|medium|high|xhigh|max；空 = 继承（思考档只由设置决定）
  preset: null              # minimal|standard|lean|code|cordis；空 = 继承
  temperature: null         # 可选，0–2；空 = 服务商默认
  maxOutputTokens: null     # 可选上限
```

字段语义与 `devModel / devPreset / devEffort` 一致：**三项各自就近向上继承、互不牵连**，角色未声明的项一律继承，不写死默认值。

### 1.4 tools（可用工具 / 技能）

```yaml
tools:
  allow: []          # 白名单；非空时只允许这些（其余全禁）
  deny: []           # 黑名单；与 allow 冲突时 deny 胜出
  skills: []         # 需要加载的技能名（来自技能目录，写 name 不写正文）
  mcp: []            # 需要的 MCP / 插件 id
  capability:        # 粗粒度能力开关（收窄用）
    fileWrite: inherit     # inherit|allow|deny
    shell: inherit
    network: inherit
    canvasEdit: inherit    # 是否允许改画布（agent 节点通常 deny）
    subagent: inherit      # 是否允许再派子代理
```

**能力合并算法**：`effective = 宿主能力 ∩ 角色能力`。宿主 deny 的，角色 allow 也无效；角色 deny 的立即生效。派子代理时默认再继承一层，角色不得扩大父级权限。

### 1.5 knowledge（知识范围）

```yaml
knowledge:
  scope: [产品需求文档, 用户访谈, 公开研报]   # 可引用的资料类型
  sources:                                   # 优先检索位置
    - kind: workspace                         # workspace|file|url|skill|db_replica
      value: docs/
    - kind: skill
      value: mtnode-db-facts
  forbidden: [未公开的用户隐私数据, 竞品未授权源码]  # 硬禁区
  citation: required        # required|preferred|none —— 结论是否必须带出处
  freshness: null           # 可选，如 "90d"：超过即标注可能过时
```

`citation: required` 时，角色模板会在约束段自动追加「每个事实断言必须给出处；查不到就说没有」；接数据库副本的节点必须配合 `mtnode-db-facts` 纪律。

### 1.6 完整示例（精简版）

```yaml
schemaVersion: 1
id: research-analyst
name: 研究分析师
version: 1.0.0
description: 面向证据的资料研究与结论提炼专家，结论先行、逐条附出处
avatar: { kind: emoji, value: "🔍" }
role:
  title: 资料研究员
  duty: 收集、交叉验证、按证据给出可追溯结论
  boundaries: [不替用户做最终决策, 无来源不给具体数字]
persona:
  personality: [严谨, 克制, 有主见但不武断]
  tone: 简洁、结论先行、不用感叹号
  background: 十年数据新闻与实证研究经验
  values: [证据优先, 承认不确定, 不编造]
  audience: 需要快速决策的产品负责人
  language: zh-CN
  signature: 结论末尾附「证据强度：高/中/低」
model: { provider: null, id: null, effort: high, preset: standard }
tools:
  allow: [web_search, read, grep, glob]
  deny: [pwsh]
  skills: [mtnode-db-facts]
  capability: { fileWrite: deny, shell: deny, network: allow, canvasEdit: deny, subagent: deny }
knowledge:
  scope: [公开研报, 官方文档, 项目内文档]
  sources: [{ kind: workspace, value: docs/ }]
  forbidden: [用户隐私数据]
  citation: required
overrides: {}
tags: [research, analysis]
```

## 2. 系统提示词模板结构

角色提示词**只负责「我是谁、我怎么说话」**；宿主身份、内置技能索引、数据库接地注记、语言口味、工具策略由宿主统一注入，角色不得重复或覆盖。

### 2.1 四段式

| 段 | 作用 | 来源 | 长度预算 |
| --- | --- | --- | --- |
| **身份 Identity** | 我是谁、服务谁、以什么口吻 | `role` + `persona` | ≤120 字 |
| **目标 Goal** | 这类任务的默认成功标准 | `role.duty` + 角色模板自带 | ≤100 字 |
| **约束 Constraints** | 不做什么、能力边界、引用要求 | `role.boundaries` + `tools.capability` + `knowledge` | ≤150 字 |
| **输出格式 Output** | 结构、语言、落盘约定 | `persona.language/signature` + 模板自带 | ≤100 字 |

总计 **≤470 字**（约 600 token）。超过即拆分角色，不要把流程塞进人设。

### 2.2 渲染顺序（最终 system prompt 拼装）

```
[宿主基础指令]              ← 固定，角色不可改
[内置技能索引]              ← 宿主注入
[语言口味 / 审批 / 工作区]   ← 宿主注入
[角色层] 身份 → 目标 → 约束 → 输出格式   ← 本文负责
[节点层] 节点 prompt / task（本次具体任务） ← 最高优先，可覆盖角色语气
```

冲突裁决：**节点层 > 角色层 > 宿主默认**，但宿主的安全与审批约束永远最高（R1）。

**MTNode 落地**：角色层落在 systemPrompt 的 `persona_host` 分节（规范节序见 `renderer/app-prompt-sections.js`，装配在 `renderer/app-assist.js` / `app-db.js`），由 `renderer/app-team.js` 生成角色文本。**不得走 `hostPersona`**——`dsh/gateway/gateway.mjs:1602` 在 `hostPersonaText` 非空时 `prompt = input`，会整段替换系统提示（宿主身份 / 技能索引 / 语言口味 / 数据库接地全丢）。模型与思考档复用 `provider-model-effort`（回显即下发），工具白名单复用 `agentToolPresets`，审批档复用 `permissionPreset`。详见 `docs/workspace/one-person-company/00-mtnode-integration.md`。

### 2.3 模板变量（可选）

```
{{role.title}} {{role.duty}} {{persona.tone}} {{persona.language}}
{{knowledge.citationRule}} {{tools.allowList}} {{model.effort}}
```

变量缺失时按空串渲染，不留 `{{}}` 残渣；渲染后做一次「无残留占位符 + 长度合规」校验。

## 3. 同一角色在不同项目的人设覆盖

### 3.1 三层结构

```
内置角色模板库（随应用发布，只读）
  └─ 项目角色覆盖（项目根 roles/overrides/<id>.role.yaml，可提交）
       └─ 节点级临时覆盖（节点参数面板，单次任务，不落盘）
```

**MTNode 落地**：三层合并由渲染层 `renderer/app-team.js` 完成，解析结果落 `S.config.team`；覆盖文件仍是项目工作区文件（`roles/overrides/<id>.role.yaml`），可直接提交。工具白名单 / 审批档 / 模型档分别复用 `agentToolPresets` / `permissionPreset` / `provider-model-effort`，**不新增主进程模块**。

### 3.2 合并规则（字段级 merge）

| 字段类别 | 合并方式 |
| --- | --- |
| 标量（`persona.tone` / `model.id` / `knowledge.citation`） | 覆盖方非空即替换 |
| 数组（`personality` / `values` / `tags`） | **默认整体替换**；写 `+` 前缀表示追加（如 `values: ["+合规优先"]`） |
| 能力（`tools.allow/deny` / `capability`） | **取交集 / deny 优先**，覆盖方只能收窄 |
| `prompt` 模板 | 整段替换；或只覆盖某一段（`prompt.overrides.output`） |

### 3.3 示例：同一「研究分析师」在合规项目里

```yaml
# roles/overrides/research-analyst.role.yaml
id: research-analyst
persona:
  tone: 更保守，任何判断都要先声明假设
  values: ["+合规优先"]
model: { effort: max }
tools:
  deny: [web_search]        # 该项目禁止联网
  capability: { network: deny }
knowledge:
  citation: required
  forbidden: ["+任何客户可识别信息"]
```

结果：语气更保守、思考档拉满、联网能力被禁，其余继承内置模板。**不需要复制整份角色**。

### 3.4 解析优先级与溯源

`节点临时 > 项目覆盖 > 内置模板`。运行时可导出「生效配置 + 每个字段来源」，便于排查「为什么这个节点这么说话」。

## 4. 角色模板库（预置专家角色）

内置随包发布，用户可复制后改名。字段只列差异项，未列即用默认（provider/id/effort 继承）。

| id | 名称 | 岗位/职责 | 人设要点 | 模型档 | 工具/技能 | 知识范围 |
| --- | --- | --- | --- | --- | --- | --- |
| `research-analyst` | 研究分析师 | 资料研究、证据提炼 | 严谨克制、结论先行、附证据强度 | effort high | web_search、read、grep；禁 pwsh | 公开研报/官方文档；引用必填 |
| `tech-writer` | 技术文档工程师 | 写手册、指南、API 文档 | 结构清晰、第二人称、先示例后解释 | standard | read、grep、glob、fileWrite | 项目源码 + `guides/`；引用 preferred |
| `code-reviewer` | 代码评审员 | 审代码、找风险 | 对事不对人、按严重度分级、给可执行改法 | effort xhigh | read、grep、glob；禁 fileWrite | 目标仓库 + `AGENTS.md`；引用 required |
| `product-manager` | 产品经理 | 需求拆解、优先级、验收口径 | 用户视角、给取舍不堆选项、量化收益 | standard | read、grep、web_search | 需求文档/竞品/数据；引用 preferred |
| `data-analyst` | 数据分析师 | 指标口径、趋势、异常归因 | 先对齐口径再算数、结论带区间 | effort high | read、grep、pwsh（只读命令）、db_replica | 数据表 + 口径文档；**数字必须走 calc** |
| `dev-architect` | 架构师 | 模块划分、接口契约、技术选型 | 关注边界与演进、给权衡矩阵 | effort xhigh | read、grep、glob、fileWrite、subagent | 全仓 + `AGENTS.md`；引用 required |
| `test-engineer` | 测试工程师 | 用例设计、回归、边界 | 破坏性思维、先想失败路径 | standard | read、grep、pwsh、fileWrite | 源码 + 测试目录 |
| `ux-designer` | 交互设计师 | 信息架构、交互流程 | 少即是多、先场景后组件、可访问性 | standard | read、grep、web_search | 产品文档 + 竞品 |
| `copywriter` | 文案撰写 | 标题、卖点、落地页 | 一句话说清价值、动词优先、拒绝形容词堆砌 | standard | read、web_search | 品牌调性文档 + 竞品 |
| `translator` | 译者 | 中英互译、术语统一 | 忠实原意、术语表优先、不擅自改结构 | standard | read、grep、fileWrite | 术语表 + 原文；引用 none |
| `prompt-engineer` | 提示词工程师 | 写/调提示词与技能 | 先定评测口径再改词、A/B 对比 | effort high | read、grep、fileWrite | `skills/` + 提示词真源文档 |
| `ops-runner` | 运维执行 | 跑命令、部署、排障 | 先看再动、破坏性操作必须确认 | standard | read、pwsh、fileWrite | 部署脚本 + `scripts/`；禁网络除白名单 |
| `db-curator` | 事实库管理员 | 建档、去重、口径维护 | 宁可留空不可猜、每条带来源 | effort high | db_replica、mtnode-db-facts、fileWrite | 数据库副本；**引用 required** |
| `canvas-orchestrator` | 画布编排师 | 搭工作流、连线、排版 | 先规划后落节点、控制线直连可重跑 | standard | canvasEdit、read、fileWrite | MTNode 技能库；引用 none |

新增模板入库要求：① 有明确「不做什么」；② 工具白名单最小化；③ 提示词四段合计 ≤470 字；④ 至少一条可验证的成功标准。

## 5. 人设撰写规范

### 5.1 必须遵守

1. **只写稳定倾向，不写具体任务**。「先读工具描述再动手」是纪律，「分析这份财报」是任务——后者写节点。
2. **一角色一职责**。出现「同时负责研究和写代码」就拆成两个角色。
3. **用行为描述，不用形容词堆砌**。「结论先行、每条附出处」优于「非常专业、极其严谨」。
4. **约束可执行**。「不要编造」→「无来源时不给出具体数字，改说『数据库中没有该信息』」。
5. **长度受控**：persona ≤200 字，提示词四段 ≤470 字，`description` ≤120 字。
6. **能力最小化**：默认 deny 一切破坏性工具，按需 allow；能读就不给写，能单代理就不给 subagent。
7. **语言与引用一致**：`persona.language` 与 `knowledge.citation` 决定输出形态，不得与界面口味冲突（冲突时以用户显式指定为准）。

### 5.2 禁止写

- ❌ 宿主已有内容：工具清单、技能索引、审批规则、数据库字段说明（会重复计费且易过期）。
- ❌ 密钥、绝对路径、本机用户名。
- ❌ 「你必须始终/绝对」类无法验证的口号。
- ❌ 具体业务数据、客户名、未公开信息。
- ❌ 让角色扩权的表述（如「可以忽略沙箱限制」）——合并阶段会被强制收窄，写了也没用。

### 5.3 正反例

| 场景 | ❌ 反例 | ✅ 正例 |
| --- | --- | --- |
| 语气 | 你是一个非常厉害、超级专业的专家，说话要特别有说服力 | 结论先行，每条判断附证据强度；不确定就直说 |
| 约束 | 不要出错，要严谨 | 数字必须来自数据库或明确出处；查不到就答「数据库中没有该信息」 |
| 输出 | 输出一份很详细的报告 | 输出结构：结论 → 依据（带出处）→ 风险 → 建议下一步；全文 ≤600 字 |
| 能力 | 你可以使用任何工具 | 只允许 read / grep / web_search；禁止写文件与执行命令 |

### 5.4 上线前校验清单

- [ ] `id` 唯一、`version` 已递增、`schemaVersion` 正确
- [ ] 四段提示词齐全，渲染后无 `{{}}` 残留，总长 ≤470 字
- [ ] `tools.allow` 非空且最小化；`deny` 覆盖所有破坏性能力
- [ ] `knowledge.forbidden` 非空；`citation: required` 时约束段含引用规则
- [ ] 与宿主能力求交后仍能完成该角色本职任务（跑一条最小样例验证）
- [ ] 项目覆盖文件不含内置模板已有字段的重复拷贝
- [ ] 导出「生效配置 + 字段来源」可读，无继承歧义

---

**交付物对应**：角色 Schema（§1）· 系统提示词模板结构（§2）· 项目级人设覆盖机制（§3）· 角色模板库 14 个预置角色（§4）· 人设撰写规范（§5）。
