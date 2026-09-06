// 思考强度（reasoning effort）档位与请求归一化 —— 纯函数模块（无 dsh 依赖）。
//
// 参考 codex（codex-rs/protocol/src/openai_models.rs 的 ReasoningEffort / ModelPreset，
// core/src/client.rs 的 reasoning_effort_for_request）把 MTNode 的思考档收敛成一套：
//   - 宽档位可选用档 low/medium/high/xhigh/max（对齐 pi-ai 能力集 @earendil-works/pi-ai
//     EXTENDED_THINKING_LEVELS = off/minimal/low/medium/high/xhigh/max 的可选用子集）;
//   - 模型 preset 声明能力（codex ModelPreset.supported/default_reasoning_effort）→ 本模块的
//     「路由能力表」:deepseek-official 固定 = llm-deepseek 适配器能力 off/low/high/max 的
//     可选用交集 low/high/max;目录/pi-ai 等其余路由按全档（模型级精确能力在运行时由
//     mtnode-effort 插件经 ctx.llm 解析后夹紧）;
//   - 请求归一化（codex reasoning_effort_for_request 式回退）:旧档与非法值 → high 兜底;
//     不支持 → 同侧最近低档 → high 兜底。归一化永不硬失败（不会让请求因档位抛错）。
//
// 本模块同时被两处加载，所以严禁 import 任何 dsh / pi-ai 运行时包：
//   - dsh/gateway/gateway.mjs（网关侧:按路由定「生效档」→ runtime key + env 下达 + 回传宿主）
//   - dsh/gateway/plugins/effort-plugin.mjs（运行时侧:agent/request waterfall 上按模型能力再夹一次）
// 测试（test/smoke-reasoning-effort.mjs）直接 import 本文件断言回退链。

/* pi-ai 完整能力阶梯（与 @earendil-works/pi-ai 的 EXTENDED_THINKING_LEVELS 同序）。
   off/minimal 不进入 MTNode 可选用档:off 在 agent 链上的语义是旧档「关思考」→ high
   （proc_text 非智能节点另有自己的 off/低/中/高 循环,不经本模块）;minimal 无消费方。 */
export const FULL_LADDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/* MTNode 可选用档（UI / run 参数 effort 的 vocabulary,升序） */
export const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max']

/* 网关/宿主口白的白名单（旧网关 EFFORTS = low/high/max 的扩档版） */
export const EFFORTS = [...EFFORT_ORDER]

/* 兜底默认档:settings.yaml 的 llm-deepseek.reasoningEffort 只保留它（不再随档位重写）;
   归一化的最终回退也是它。与 llm-deepseek 适配器「省略 reasoningEffort → high」一致。 */
export const DEFAULT_EFFORT = 'high'

/* deepseek-official 路由(llm-deepseek 适配器):完整适配器能力 off/low/high/max */
export const DEEPSEEK_ADAPTER_EFFORTS = ['off', 'low', 'high', 'max']
/* 其在 MTNode 可选用档上的交集(low/high/max);medium/xhigh 在此路由被夹紧 */
export const DEEPSEEK_EFFORTS = ['low', 'high', 'max']

/* 旧档(兼容已存工作流/节点/会话):off/none/无/空 → high */
const LEGACY_TO_DEFAULT = new Set(['', 'off', 'none', '无'])

/** 把宿主下发的 raw 档位归一到可选用档（不感知路由）。旧档与非法值 → high 兜底。 */
export function normalizeEffort(effort) {
  const raw = String(effort ?? '').trim().toLowerCase()
  if (LEGACY_TO_DEFAULT.has(raw)) return DEFAULT_EFFORT
  return EFFORT_ORDER.includes(raw) ? raw : DEFAULT_EFFORT
}

/** 路由能力表:deepseek-official 固定(off/low/high/max ∩ 可选用档);
    其余路由(pi-ai 目录同源 / 手写 mtnode_* / 未知)按全档 ——
    模型级精确能力由运行时 mtnode-effort 插件经 ctx.llm 解析后夹紧。 */
export function routeEffortsOf(route) {
  return String(route || '') === 'deepseek-official' ? DEEPSEEK_EFFORTS : EFFORT_ORDER
}

/* codex reasoning_effort_for_request 式回退链:不支持 → 同侧最近低档 → high 兜底。
   supported 为升序档位数组（可选用档集合）。永不返回 supported 之外的档。 */
export function clampEffort(effort, supported) {
  const want = normalizeEffort(effort)
  const caps = Array.isArray(supported) && supported.length
    ? supported.map(String)
    : EFFORT_ORDER
  if (caps.includes(want)) return want
  for (let i = EFFORT_ORDER.indexOf(want) - 1; i >= 0; i--) {
    if (caps.includes(EFFORT_ORDER[i])) return EFFORT_ORDER[i]
  }
  return DEFAULT_EFFORT
}

/** 按路由能力表归一请求档位（gateway 每轮 run 用它定「生效档」）。 */
export function effortForRoute(effort, route) {
  return clampEffort(effort, routeEffortsOf(route))
}

/** runtime key 用的档位片段:一律回到可选用档的小写值(空/旧值 → high)。
    保证 applySettings / runtime key / env 三处口径一致。 */
export function effortKeyOf(effort) {
  return normalizeEffort(effort)
}

/* 模型级能力夹紧（运行时插件用）:supportedEfforts 是适配器按精确模型公布的可支持档
   （含 off/minimal 等非可选用档,来自 ctx.llm.resolveModelInfo(...).reasoning.efforts）。
   命中 → 原样;不支持 → 同侧最近低档;该模型只支持 off/minimal（无可选用正档）
   → undefined = 不下发档位(沿用适配器/提供方默认),绝不盲发一个会
   UNSUPPORTED_REASONING_EFFORT 硬失败的值。 */
export function effortForModelEfforts(effort, supportedEfforts) {
  const want = normalizeEffort(effort)
  if (!Array.isArray(supportedEfforts) || !supportedEfforts.length) return undefined
  const caps = supportedEfforts.map((x) => String(x)).filter((x) => EFFORT_ORDER.includes(x))
  if (caps.includes(want)) return want
  for (let i = EFFORT_ORDER.indexOf(want) - 1; i >= 0; i--) {
    if (caps.includes(EFFORT_ORDER[i])) return EFFORT_ORDER[i]
  }
  return undefined
}
