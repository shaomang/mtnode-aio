/* 一次性验证（本会话用后即弃）：把策略模块生成的 config 真喂给 dsh 自带的
   @deepseek-ai/dsh-compaction-basic，看它自己解出来的触发线是多少。
   插入真插件 = 只有 resolveConfig / _registerAutomaticCompaction 会跑（不发请求、不碰会话）。 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = 'E:\\dev\\tools\\pipeline-console'
const pol = require(path.join(ROOT, 'dsh-compact-policy.js'))

const Engine = (
  await import(
    pathToFileURL(
      path.join(ROOT, 'dsh', 'gateway', 'node_modules', '@deepseek-ai', 'dsh-compaction-basic', 'lib', 'index.js'),
    ).href
  )
).default

const fakeCtx = {
  on() {},
  get() {
    return undefined
  },
  reflect: { provide() {} },
  logger: { warn() {}, info() {} },
}

/* 真源里的路由事实（取自会话日志 session.v4.jsonl 的 request/header）：
   provider=deepseek-official · model=deepseek-v4-flash · maxTokens=256000 · contextWindow=1000000 */
const CONTEXT_WINDOW = 1000000
const ROUTED = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }

function thresholdFor(cfgObj, reserved, label) {
  const engine = new Engine(fakeCtx, cfgObj)
  const cfg = engine.config
  const policy = cfg.modelPolicies.find((p) => p.provider === ROUTED.provider && p.model === ROUTED.model)
  const headroom = policy && policy.headroomTokens !== undefined ? policy.headroomTokens : cfg.headroomTokens
  const ratio = (policy && policy.thresholdRatio) || cfg.thresholdRatio
  /* 与插件同一条算式（lib/index.js:128-133） */
  const pressure = CONTEXT_WINDOW - reserved - headroom
  const thresholdTokens = Math.floor(Math.min(CONTEXT_WINDOW * ratio, pressure))
  console.log(
    label.padEnd(14),
    '| auto=' + cfg.auto,
    '| policy命中=' + (policy ? '是' : '否'),
    '| headroom=' + headroom,
    '| retain=' + (policy && policy.retainTokens !== undefined ? policy.retainTokens : 'ratio'),
    '| 摘要请求 maxTokens=' + (policy && policy.maxTokens !== undefined ? policy.maxTokens : cfg.maxTokens),
    '| 触发线=' + thresholdTokens + ' token',
  )
  return thresholdTokens
}

const cfgOf = (raw) => pol.compactConfigOf(raw)

console.log('路由：' + ROUTED.provider + '/' + ROUTED.model + ' · 窗口 ' + CONTEXT_WINDOW + ' · 预留输出 256000')
console.log('')
thresholdFor(cfgOf({ enabled: true, tier: 'frugal' }), 256000, '修好之后·省钱')
thresholdFor(cfgOf({ enabled: true, tier: 'custom', customTriggerTokens: 250000 }), 256000, '修好之后·自定义250k')
thresholdFor(cfgOf({ enabled: true, tier: 'mid' }), 256000, '中档（未动）')
thresholdFor(cfgOf({ enabled: false, tier: 'frugal' }), 256000, '关闭（未动）')

/* 复现旧行为：点名表只有 deepseek-flash 时，这条路由上 policy 命中不了 →
   走全局默认 headroomTokens 65536（插件 resolveConfig 的默认值）*/
const legacy = pol.compactConfigOf({ enabled: true, tier: 'frugal' })
legacy.modelPolicies = pol.modelPoliciesOf('frugal', { officialModels: ['deepseek-flash'] })
console.log('')
thresholdFor(legacy, 256000, '修好之前')

/* 配置里出现兜底表没有的官方 id 时也要命中 */
const exotic = pol.compactConfigOf({ tier: 'frugal', officialModels: ['deepseek-chat'] })
const engine2 = new Engine(fakeCtx, exotic)
console.log('')
console.log(
  '新增官方 id（deepseek-chat）也被点名：',
  engine2.config.modelPolicies.some((p) => p.model === 'deepseek-chat' && p.headroomTokens === pol.FRUGAL_HEADROOM_TOKENS),
)
