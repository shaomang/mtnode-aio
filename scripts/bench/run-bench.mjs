#!/usr/bin/env node
/**
 * bench/run-bench.mjs — 用 MTNode 自有的「Agent 网关本地协议」跑多臂评测（standard / lean / code / minimal，--arms 选）。
 *
 * 它测的是**产品真实链路**：spawn 仓库内的 dsh/gateway/gateway.mjs → 网关按 preset 拼角色前缀、
 * 按 PRESET_EFFORT_CAPS 收敛思考档 → 拉起 dsh 运行时 → 打真实服务商 API。评测器不碰渲染层，
 * 只当「宿主」：发 {method:'run'} 帧、收 {event:{reqId,type,data}} 帧。协议契约见 dsh/DESIGN.md。
 *
 * 臂（arm）定义 —— 唯一变量 = 预设，其余全同（同模型 / 同服务商 / 同题 / 同题面）：
 *   standard = preset 'standard'，思考档按 --effort 原样下发（默认 high）
 *   lean     = preset 'lean'     ，同样下发 --effort（默认 high）
 *              lean 只精简思考的**表达形式**，不压思考预算 —— 想少想由用户在设置里选档。
 *   code     = preset 'code'     ：软件工程师人设，前缀中等长度
 *   minimal  = preset 'minimal'  ：极短人设，用于分离「前缀长度」这一结构性变量
 * 网关历史上那张按预设压档的上限表（PRESET_EFFORT_CAPS）已取消，所以
 * **生效档 == 请求档**：本脚本不再镜像任何降档规则，记录里的 effortEffective 就是 --effort 本身。
 *
 * 采集口径（逐题一行 JSON 追加写 results.jsonl，崩溃可续跑）：
 *   - usage 事件逐次累加：inputTokens / outputTokens / reasoningTokens / cacheRead / cacheWrite
 *   - done.metrics 原样保留：turns / steps / tools / wallMs / llmMs / toolMs / firstTokenAvgMs /
 *     tokPerSec / cacheHitPct / contextWindow / models[]（逐模型台账）
 *     注：网关的首字延字段名是 firstTokenAvgMs（多步平均），报告里的「首字延」即取此字段。
 *   - 题目 id、题面 gold（判分要用，见 score 侧）、finalResponse、错误、重试次数、宿主侧墙钟、
 *     模型中途提问 / 审批 / 画布 / 数据库交互的次数（ix 计数，用来发现某一臂在「问人」上作弊）
 *
 * 落盘全在仓库外（不进 git、不污染工作区）：
 *   %LOCALAPPDATA%\mtnode-bench\datasets\          数据集（fetch-data.mjs 的产物，本脚本只读）
 *   %LOCALAPPDATA%\mtnode-bench\gateway-home\      评测专用 DSH_HOME（与应用的 dsh-home 隔离）
 *   %LOCALAPPDATA%\mtnode-bench\ws\run-<name>\w<i> 每个并发槽位的运行时工作目录
 *   %LOCALAPPDATA%\mtnode-bench\runs\<name>\       results.jsonl + run-meta.json + runner.log
 *   目录根可用 --bench-root / MTNODE_BENCH_ROOT 改；注意 fetch-data.mjs 的 MTNODE_BENCH_DIR 指的是
 *   「数据集目录」，两者默认值对齐（<root>\datasets）。
 *   服务商 Key 只在内存里用，绝不打印、绝不进结果文件（日志与 metrics 都过一次 redact）；
 *   唯一例外是网关按既有契约把服务商写进**评测专用** DSH_HOME\settings.yaml（与应用同一机制，仍在仓库外）。
 *
 * 用法：
 *   node scripts/bench/run-bench.mjs --status                     # 只握手，不花 token
 *   node scripts/bench/run-bench.mjs --limit 5 --dry-run          # 打印题目/排程，不发请求
 *   node scripts/bench/run-bench.mjs --limit 5                    # 试点：GSM8K+HumanEval 各 5 题 × 2 臂
 *   node scripts/bench/run-bench.mjs --dataset math500 --arms standard,lean,code,minimal  # 只跑数学题集四臂
 *   node scripts/bench/run-bench.mjs --sample 100 --concurrency 2 # 正式跑（支持中断后重跑续上）
 *   node scripts/bench/run-bench.mjs --run pilot1 --arms lean     # 只跑某一臂
 *   node scripts/bench/run-bench.mjs --model qwen3.8-flash --provider mtnode_qwen-token-plan-cn
 *
 * 参数：
 *   --run <name>          本次评测的目录名（默认 default；续跑要用同一个）
 *   --dataset <a,b>       gsm8k,humaneval,math500（默认前两者；三集并跑显式列出）
 *   --sample <n> --seed <s> 选用哪个抽样子集文件（默认 100/1234，与 fetch-data 一致）
 *   --full                用全量题集而不是抽样子集
 *   --limit <n>           每个数据集最多几题（试点用）
 *   --arms <a,b>          standard,lean,code,minimal（默认 standard,lean）
 *   --concurrency <1..3>  并发槽位数（默认 1；同臂同槽位复用同一运行时进程，跨槽位各起一台）
 *   --timeout-min <m>     单题墙钟上限（默认 10；超时发 cancel 并记 status=timeout）
 *   --retries <n>         失败/超时重跑次数（默认 1）
 *   --no-warmup           跳过每臂一次预热题（预热记录标 warmup=true，不计分、不算续跑）
 *   --allow-tools         题面不再要求「只用推理作答」（默认要求，避免工具与文件 IO 混进 token 账）
 *   --provider/--model/--effort/--max-tokens   覆盖服务商与模型档（默认取 MTNode 配置里的 dsh 设置）
 *   --dir/--bench-root    数据集目录 / 评测根目录
 *   --data-dir <dir>      MTNode 数据目录（含 config.json）；默认 %APPDATA%\pipeline-console\pipeline-console
 *   --gateway <path>      换网关脚本路径（离线协议桩自测用；默认仓库内 dsh/gateway/gateway.mjs）
 *   --force               忽略已有结果重跑全部
 *   --skip-failed         已有结果里失败的也不重跑（默认会重试）
 *   --status / --dry-run  只握手 / 只看排程
 *
 * 离线自测（不花 token、不碰真实服务商）：把 --gateway 指向协议桩，它按同一套帧格式回
 * usage / tool / question / done，并可注入挂起与失败：
 *   FAKE_HANG=1 FAKE_FAIL=1 FAKE_ASK=1 node scripts/bench/run-bench.mjs \
 *     --gateway scripts/bench/fake-gateway.mjs --limit 3 --run stub --concurrency 2 --timeout-min 0.05
 *
 * 注意：跑评测时请**关闭 MTNode 应用**。网关启动时会按 DSH_HOME 恢复插件挂载段，可能与应用的
 * 网关同时改写仓库内 dsh/gateway/cordis.yml；本脚本会在结束时把它还原成开跑前的内容并提示。
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const GATEWAY_PATH = path.join(REPO_ROOT, 'dsh', 'gateway', 'gateway.mjs');
const CORDIS_PATH = path.join(REPO_ROOT, 'dsh', 'gateway', 'cordis.yml');
const CREDS_PATH = path.join(REPO_ROOT, 'dsh', 'mtnode-llm-creds.js');
const MIN_NODE = [22, 19];
const SCHEMA = 'mtnode-bench-run/1';

/* ------------------------------------------------------------------ CLI */

const DATASETS = {
  gsm8k: {
    dir: 'gsm8k',
    full: 'test.jsonl',
    sample: (n, s) => `test-sample-n${n}-seed${s}.jsonl`,
    metric: '最终数值 exact-match（#### 行）',
  },
  humaneval: {
    dir: 'humaneval',
    full: 'HumanEval.jsonl',
    sample: (n, s) => `HumanEval-sample-n${n}-seed${s}.jsonl`,
    metric: 'pass@1（执行官方 tests）',
  },
  math500: {
    dir: 'math500',
    full: 'test.jsonl',
    // 命名与 fetch-data.mjs 的产物一致（该集子集名以 dataset 名为前缀，非 gsm8k 的 test- 前缀）
    sample: (n, s) => `math500-sample-n${n}-seed${s}.jsonl`,
    metric: '最终答案 exact-match（题面 solution 里的 \\boxed{}，作答要求末行 ANSWER = …）',
  },
};

/** 臂定义：唯一变量 = preset；各臂 effort 都按 --effort（默认 high）原样下发，
 *  生效档 == 请求档 —— 网关的按预设压档表（PRESET_EFFORT_CAPS）已取消，
 *  预设只精简思考的表达形式，思考档只由用户在设置里选。
 *  code / minimal 是网关 PRESETS 里与 standard 平级的另外两档人设，
 *  用于把「人设前缀长度」这一结构性差异单独量出来。 */
const ARMS = {
  standard: { preset: 'standard', capNote: '无上限（网关不按预设压档）' },
  lean: { preset: 'lean', capNote: '无上限（网关不按预设压档）' },
  code: { preset: 'code', capNote: '无上限（网关不按预设压档）' },
  minimal: { preset: 'minimal', capNote: '无上限（网关不按预设压档）' },
};

function armSpec(armName, opt) {
  const a = ARMS[armName];
  return {
    arm: armName,
    preset: a.preset,
    effort: opt.effort,
    /* 生效档 == 请求档：网关不再有预设压档规则，本脚本也不再镜像 */
    effortEffective: opt.effort,
    capNote: a.capNote,
  };
}

function defaultBenchRoot() {
  /* 注意与 fetch-data.mjs 的 MTNODE_BENCH_DIR 区分：那个指「数据集目录」，这个指「评测根目录」；
     两者的默认值天然对齐（<root>\datasets === fetch-data 的默认落盘位置）。 */
  if (process.env.MTNODE_BENCH_ROOT) return path.resolve(process.env.MTNODE_BENCH_ROOT);
  const base =
    process.platform === 'win32' ? process.env.LOCALAPPDATA
      : process.platform === 'darwin' ? path.join(process.env.HOME || '', 'Library', 'Application Support')
        : path.join(process.env.XDG_DATA_HOME || path.join(process.env.HOME || '', '.local', 'share'));
  if (!base) fail('无法确定本机缓存目录，请用 --bench-root 显式指定');
  return path.join(base, 'mtnode-bench');
}

function parseArgs(argv) {
  const o = {
    run: 'default',
    datasets: ['gsm8k', 'humaneval'],
    sample: 100,
    seed: 1234,
    full: false,
    limit: 0,
    arms: ['standard', 'lean'],
    concurrency: 1,
    timeoutMin: 10,
    retries: 1,
    warmup: true,
    allowTools: false,
    provider: '',
    model: '',
    effort: 'high',
    maxTokens: 0,
    benchRoot: defaultBenchRoot(),
    datasetDir: '',
    dataDir: '',
    gateway: GATEWAY_PATH,
    force: false,
    skipFailed: false,
    status: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (what) => {
      const v = argv[++i];
      if (v === undefined) fail(`${a} 缺少${what}`);
      return v;
    };
    if (a === '--run') o.run = next('名称');
    else if (a === '--dataset') o.datasets = next('数据集').split(',').map((x) => x.trim()).filter(Boolean);
    else if (a === '--sample') o.sample = Number.parseInt(next('题量'), 10);
    else if (a === '--seed') o.seed = Number.parseInt(next('种子'), 10);
    else if (a === '--full') o.full = true;
    else if (a === '--limit') o.limit = Number.parseInt(next('题数'), 10);
    else if (a === '--arms') o.arms = next('臂').split(',').map((x) => x.trim()).filter(Boolean);
    else if (a === '--concurrency') o.concurrency = Number.parseInt(next('并发'), 10);
    else if (a === '--timeout-min') o.timeoutMin = Number(next('分钟'));
    else if (a === '--retries') o.retries = Number.parseInt(next('次数'), 10);
    else if (a === '--no-warmup') o.warmup = false;
    else if (a === '--allow-tools') o.allowTools = true;
    else if (a === '--provider') o.provider = next('服务商');
    else if (a === '--model') o.model = next('模型');
    else if (a === '--effort') o.effort = next('思考档');
    else if (a === '--max-tokens') o.maxTokens = Number.parseInt(next('上限'), 10);
    else if (a === '--bench-root') o.benchRoot = path.resolve(next('目录'));
    else if (a === '--dir') o.datasetDir = path.resolve(next('目录'));
    else if (a === '--data-dir') o.dataDir = path.resolve(next('目录'));
    else if (a === '--gateway') o.gateway = path.resolve(next('网关路径'));
    else if (a === '--force') o.force = true;
    else if (a === '--skip-failed') o.skipFailed = true;
    else if (a === '--status') o.status = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '-h' || a === '--help') {
      console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, ''));
      process.exit(0);
    } else fail(`未知参数：${a}（--help 看用法）`);
  }
  for (const d of o.datasets) if (!DATASETS[d]) fail(`未知数据集 ${d}（可选 ${Object.keys(DATASETS).join(', ')}）`);
  for (const a of o.arms) if (!ARMS[a]) fail(`未知臂 ${a}（可选 ${Object.keys(ARMS).join(', ')}）`);
  /* 网关运行时池上限 6：一槽位两臂各占一台，超过 3 槽位会开始回收空闲运行时、白付冷启动 */
  if (!Number.isInteger(o.concurrency) || o.concurrency < 1 || o.concurrency > 3) fail('--concurrency 只支持 1..3（网关运行时池上限 6）');
  if (!(Number(o.timeoutMin) > 0)) fail('--timeout-min 需为正数');
  if (!Number.isInteger(o.retries) || o.retries < 0) fail('--retries 需为非负整数');
  if (!['low', 'high', 'max'].includes(o.effort)) fail('--effort 只支持 low / high / max');
  return o;
}

function fail(msg) {
  console.error(`[bench][错误] ${msg}`);
  process.exit(1);
}

/* ------------------------------------------------------------------ 路径与工具 */

function nodeVersionOk() {
  const m = /^v(\d+)\.(\d+)/.exec(process.version);
  if (!m) return false;
  const [maj, min] = [Number(m[1]), Number(m[2])];
  return maj > MIN_NODE[0] || (maj === MIN_NODE[0] && min >= MIN_NODE[1]);
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

/** mulberry32 + Fisher-Yates：与 fetch-data.mjs 同一套可复现随机（固定种子 → 排程可复现） */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(list, rand) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** 抹掉任何可能被上游原样回显的密钥，确保它绝不进日志与结果文件 */
function makeRedactor(secrets) {
  const list = [...new Set(secrets.map((s) => String(s || '')).filter((s) => s.length >= 6))];
  return (text) => {
    let out = String(text == null ? '' : text);
    for (const s of list) out = out.split(s).join('«redacted-key»');
    return out;
  };
}

/* ------------------------------------------------------------------ 配置与凭据 */

function resolveAppDataDir(opt) {
  const cands = [];
  if (opt.dataDir) cands.push(opt.dataDir);
  if (process.env.MTNODE_DATA_DIR) cands.push(process.env.MTNODE_DATA_DIR);
  const appData = process.env.APPDATA || '';
  if (appData) {
    cands.push(path.join(appData, 'pipeline-console', 'pipeline-console'));
    cands.push(path.join(appData, 'pipeline-console'));
  }
  for (const c of cands) {
    if (c && fs.existsSync(path.join(c, 'config.json'))) return c;
  }
  fail(
    '找不到 MTNode 的 config.json（设置 · API/配置 里配好服务商 Key 后再跑）。'
    + '可用环境变量 MTNODE_DATA_DIR 指定数据目录。',
  );
  return '';
}

/** 选定服务商与模型，并解析出该路由的 apiKey/baseUrl（与渲染层 dshRunTask 同一口径） */
function resolveRunConfig(opt) {
  const dataDir = resolveAppDataDir(opt);
  const creds = requireCjs(CREDS_PATH);
  const auth = creds.resolveDshRunAuth(dataDir);
  if (!auth || !auth.ok) fail((auth && auth.error) || '解析 MTNode 服务商凭据失败');

  let provider = opt.provider || auth.provider;
  let apiKey = auth.apiKey;
  let baseUrl = auth.baseUrl;
  if (provider !== 'deepseek-official') {
    const hit = (auth.mtnodeProviders || []).find((p) => 'mtnode_' + p.route === provider);
    if (!hit) {
      fail(
        `服务商 ${provider} 不在可用列表里。可选：deepseek-official, `
        + (auth.mtnodeProviders || []).map((p) => 'mtnode_' + p.route).join(', '),
      );
    }
    apiKey = hit.apiKey;
    baseUrl = hit.baseUrl;
  }
  let model = opt.model || auth.model;
  if (provider !== 'deepseek-official') {
    const hit = (auth.mtnodeProviders || []).find((p) => 'mtnode_' + p.route === provider);
    const models = (hit && hit.models) || [];
    if (model && (!models.length || !models.includes(model))) {
      console.warn(`[bench][提示] 模型 ${model} 不在 ${provider} 的模型列表里（该服务商可能仍接受）`);
    }
    if (!opt.model) model = models[0] || model;
  }
  if (!String(apiKey || '').trim()) fail(`服务商 ${provider} 没有可用 API Key`);
  return {
    dataDir,
    provider,
    model,
    apiKey,
    baseUrl,
    mtnodeProviders: auth.mtnodeProviders || [],
    /* 联网搜索固定要 DeepSeek 官方 Key；与网关契约一致，缺失时网关会回落成对话 Key */
    webSearchApiKey: auth.webSearchApiKey || '',
    permissionPreset: 'mtnode-unattended',
    maxTokens: Number(opt.maxTokens) > 0 ? Number(opt.maxTokens) : (Number(auth.maxTokens) > 0 ? Number(auth.maxTokens) : undefined),
  };
}

/* ------------------------------------------------------------------ 题集 */

function readJsonl(file) {
  const rows = [];
  const text = fs.readFileSync(file, 'utf8');
  let i = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    i += 1;
    try {
      rows.push({ _line: i, obj: JSON.parse(t) });
    } catch {
      fail(`${file} 第 ${i} 行不是合法 JSON`);
    }
  }
  return rows;
}

function datasetFile(opt, key) {
  const meta = DATASETS[key];
  const root = opt.datasetDir || path.join(opt.benchRoot, 'datasets');
  const name = opt.full ? meta.full : meta.sample(opt.sample, opt.seed);
  const file = path.join(root, meta.dir, name);
  if (!fs.existsSync(file)) {
    fail(`缺少题集文件：${file}\n         先跑 node scripts/bench/fetch-data.mjs --sample ${opt.sample} --seed ${opt.seed}`);
  }
  return file;
}

/** 归一题目：id 稳定（gsm8k / math500 用行号，humaneval 用官方 task_id），并带 gold 供判分 */
function normalizeProblem(key, _line, obj) {
  if (key === 'gsm8k') {
    const q = String(obj.question || '').trim();
    if (!q) return null;
    return { dataset: key, id: `gsm8k#${_line}`, question: q, gold: { answer: String(obj.answer || '') } };
  }
  if (key === 'math500') {
    /* 两种题集形态都要认（2026-09-04 fresh4 审计：早期只读展平 obj.answer，
       遇到 fetch-data 的统一契约子集时 gold 落成空串 → MATH-500 全量 gold-unparsable）：
       ① 官方原始 test.jsonl：problem / solution / answer（answer 多为 \boxed{…}）
       ② 契约子集：{ dataset, id, question, gold:{ answer, solution, level } } */
    const q = String(obj.problem || obj.question || '').trim();
    if (!q) return null;
    const g = obj.gold && typeof obj.gold === 'object' ? obj.gold : {};
    const nested = [g.answer, g.final_answer, obj.answer, obj.final_answer]
      .map((v) => (v === null || v === undefined ? '' : String(v).trim()))
      .find((v) => v) || '';
    const solution = String(obj.solution || g.solution || '');
    return {
      dataset: key,
      /* id 一律用题集文件内的物理行号（与 score.mjs 的 byLine 口径一致）；
         契约自带的「继承全量行号」的 id 只作溯源记在 gold.sourceId，不参与判分定位 */
      id: `math500#${_line}`,
      question: q,
      gold: {
        answer: nested || solution,
        answerSource: nested ? (g.answer ? 'contract-gold' : 'flat-answer') : 'solution-fallback',
        solution,
        level: Number(obj.level || g.level || 0) || null,
        sourceId: obj.id ? String(obj.id) : '',
      },
    };
  }
  const id = String(obj.task_id || `humaneval#${_line}`).trim();
  const prompt = String(obj.prompt || '');
  if (!prompt.trim()) return null;
  return {
    dataset: key,
    id,
    question: prompt,
    gold: { entry_point: obj.entry_point || '', test: obj.test || '', canonical_solution: obj.canonical_solution || '' },
  };
}

function loadProblems(opt, key) {
  const file = datasetFile(opt, key);
  const out = [];
  for (const { _line, obj } of readJsonl(file)) {
    const p = normalizeProblem(key, _line, obj);
    if (p) out.push(p);
  }
  if (Number.isInteger(opt.limit) && opt.limit > 0) return out.slice(0, opt.limit);
  return out;
}

/**
 * 题面：各臂逐字相同。默认加一句「只用推理作答」的工具闸门 ——
 * 否则某一臂可能去跑 pwsh / 写文件，把工具轮次的 token 与耗时混进「思考档差异」的对比里。
 * （题集本身是英文语料，闸门也用英文，避免中英混排影响各臂可比性。）
 * --allow-tools 去掉这句话，用来测「带工具的真实 agent 任务」上的差异。
 * gsm8k / humaneval 两段模板**逐字不动**（要与旧数据可比）；math500 另起一段，
 * 沿用 gsm8k 同一句工具闸门，只把作答格式换成末行 `ANSWER = <最终答案>`。
 */
function buildInput(p, opt) {
  const guard = opt.allowTools
    ? ''
    : '\n\nAnswer directly from your own reasoning: do not read or write files, do not run commands, do not search the web.';
  if (p.dataset === 'gsm8k') {
    return [
      'Solve the following grade-school math problem.',
      '',
      p.question,
      '',
      'Give a short step-by-step solution, then end your reply with the final numeric answer '
        + 'on its own last line, exactly in this format:',
      '#### <answer>',
      guard,
    ].join('\n');
  }
  if (p.dataset === 'math500') {
    return [
      'Solve the following competition math problem.',
      '',
      p.question,
      '',
      'Give a step-by-step solution, then end your reply with the final answer '
        + 'on its own last line, exactly in this format:',
      'ANSWER = <final answer>',
      guard,
    ].join('\n');
  }
  return [
    'Complete the following Python function.',
    '',
    '```python',
    p.question.trim(),
    '```',
    '',
    'Reply with exactly ONE ```python fenced code block containing the complete runnable '
      + 'definition (you may repeat the given imports and signature). '
      + 'Do not include tests, usage examples, or prose outside the code block.',
    guard,
  ].join('\n');
}

/* ------------------------------------------------------------------ 网关子进程（本地协议宿主） */

class GatewayHost {
  constructor({ gatewayPath, dshHome, log, redact }) {
    this.gatewayPath = gatewayPath;
    this.dshHome = dshHome;
    this.log = log;
    this.redact = redact;
    this.nextId = 0;
    this.pend = new Map();
    this.listeners = new Set();
    this.child = null;
    this.buf = '';
    this.stderrTail = '';
  }

  start() {
    ensureDir(this.dshHome);
    const env = { ...process.env, DSH_HOME: this.dshHome };
    /* 评测跑在真实 node 上（≥22.19）；应用内才用 Electron 自带 Node。
       这几个变量属于「当前这个 dsh 会话」，绝不能泄漏给被评测的网关子进程。 */
    for (const k of ['DSH_SESSION_ID', 'DSH_SESSION_JSONL', 'DSH_WEB_URL', 'DSH_SHELL', 'MTNODE_PURE']) delete env[k];
    this.child = spawn(process.execPath, [this.gatewayPath], {
      cwd: path.dirname(this.gatewayPath),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (d) => this._onData(d));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (d) => {
      const s = this.redact(d.toString());
      this.stderrTail = (this.stderrTail + s).slice(-8000);
      this.log('gateway-stderr: ' + s.replace(/\s+/g, ' ').slice(0, 400));
    });
    this.child.on('exit', (code) => {
      const msg = `网关进程已退出 code=${code}`;
      this.log(msg + ' stderr尾部: ' + this.stderrTail.slice(-600));
      for (const [id, p] of this.pend) {
        clearTimeout(p.timer);
        p.reject(new Error(this.redact(msg)));
        this.pend.delete(id);
      }
    });
    this.child.on('error', (err) => this.log('网关 spawn 失败: ' + this.redact(err && err.message)));
  }

  _onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.event) {
        for (const fn of this.listeners) {
          try { fn(m.event); } catch (err) { this.log('事件处理异常: ' + this.redact(err && err.message)); }
        }
        continue;
      }
      if (m.id !== undefined && this.pend.has(m.id)) {
        const p = this.pend.get(m.id);
        this.pend.delete(m.id);
        clearTimeout(p.timer);
        if (m.ok) p.resolve(m.result);
        else p.reject(new Error(this.redact(m.error || '网关返回失败')));
      }
    }
  }

  request(method, params, timeoutMs = 60000) {
    if (!this.child || this.child.exitCode !== null) return Promise.reject(new Error('网关未运行'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pend.delete(id)) reject(new Error(`网关请求超时: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pend.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      } catch (err) {
        clearTimeout(timer);
        this.pend.delete(id);
        reject(err);
      }
    });
  }

  /** 不带应答的帧（宿主回话）：网关只处理带 id 的请求，所以回话也必须带 id，但不必等结果 */
  notify(method, params) {
    if (!this.child || this.child.exitCode !== null) return;
    const id = ++this.nextId;
    try { this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n'); } catch { /* 网关已关 */ }
  }

  onEvent(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async shutdown() {
    if (!this.child || this.child.exitCode !== null) return;
    try { await this.request('shutdown', {}, 8000); } catch { /* 忽略：下面兜底 kill */ }
    try { this.child.stdin.end(); } catch { /* ignore */ }
    setTimeout(() => { try { this.child.kill(); } catch { /* ignore */ } }, 3000).unref?.();
  }
}

/* ------------------------------------------------------------------ 单题执行 */

function jobKey(j) {
  return `${j.dataset}|${j.id}|${j.arm}`;
}

/** 一个槽位 = 一台运行时（同臂同槽位复用进程）。run 与超时 cancel 共用 tag `bench-<arm>-w<槽位>`，
 *  所以单题超时只会关掉出问题的那一台，不会误杀另一臂或别的槽位。 */
function makeSlot(i, paths) {
  return {
    index: i,
    workspace: paths.wsSlot(i),
  };
}

/** 记录骨架：正常收尾与超时收尾共用，避免两处字段漂移 */
function baseRecord(job, cfg, paths, startedAt) {
  const spec = job.spec;
  return {
    v: SCHEMA,
    at: new Date().toISOString(),
    startedAt,
    endedAt: Date.now(),
    runnerWallMs: Date.now() - startedAt,
    run: paths.name,
    dataset: job.dataset,
    id: job.id,
    arm: job.arm,
    preset: spec.preset,
    effortRequested: spec.effort,
    /* 生效档 == 请求档：网关已取消按预设压档（PRESET_EFFORT_CAPS 移除），思考档只由 --effort 决定 */
    effortEffective: spec.effortEffective,
    effortCapNote: spec.capNote,
    model: cfg.model,
    provider: cfg.provider,
    baseUrlHost: safeHost(cfg.baseUrl),
    permissionPreset: cfg.permissionPreset,
    slot: job.slot,
    attempt: job.attempt,
    order: job.order,
    warmup: !!job.warmup,
    status: 'ok',
    error: '',
    timedOut: false,
    finalResponse: '',
    usage: {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    metrics: null,
    streamed: { textChars: 0, reasoningChars: 0, toolCalls: 0, tools: [] },
    interactions: { question: 0, approval: 0, canvas: 0, db: 0 },
    promptChars: job.input.length,
    gold: job.gold,
  };
}

/**
 * 发一题并等收尾。宿主对四类交互帧（提问 / 审批 / 画布 / 数据库）一律即时回话，
 * 绝不让它们变成没人应答的死卡：提问给「无人应答，自行决定」的兜底回答，
 * 审批放行一次（沙箱本就是 workspace-write），画布 / 数据库直接回错让模型继续。
 */
function runOneJob({ host, cfg, paths, job, timeoutMs, log, redact }) {
  const reqId = `bench|${job.dataset}|${job.id}|${job.arm}|w${job.slot}|a${job.attempt}`;
  const startedAt = Date.now();
  const rec = baseRecord(job, cfg, paths, startedAt);
  const acc = rec.usage;
  const ix = rec.interactions;
  const st = rec.streamed;
  const errors = [];
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let forcedStatus = '';
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off();
      rec.endedAt = Date.now();
      rec.runnerWallMs = rec.endedAt - startedAt;
      rec.finalResponse = redact(rec.finalResponse);
      rec.error = redact(errors.length ? errors[errors.length - 1] : '');
      /* 超时优先于 error 记账：timeout 是「没等到 done」，网关随后补发的 error 不改判 */
      if (forcedStatus) rec.status = forcedStatus;
      else if (errors.length) rec.status = 'error';
      resolve(rec);
    };
    const off = host.onEvent((ev) => {
      if (!ev || ev.reqId !== reqId) return;
      const d = ev.data || {};
      switch (ev.type) {
        case 'usage':
          acc.calls += 1;
          acc.inputTokens += Number(d.inputTokens) || 0;
          acc.outputTokens += Number(d.outputTokens) || 0;
          acc.reasoningTokens += Number(d.reasoningTokens) || 0;
          acc.cacheReadTokens += Number(d.cacheReadTokens) || 0;
          acc.cacheWriteTokens += Number(d.cacheWriteTokens) || 0;
          break;
        case 'tool':
          st.toolCalls += 1;
          st.tools.push(String(d.name || d.tool || ''));
          break;
        case 'text':
          st.textChars += String(d.text || '').length;
          break;
        case 'reasoning':
          st.reasoningChars += String(d.text || '').length;
          break;
        case 'error':
          errors.push(String(d.message || '').slice(0, 500));
          break;
        case 'question': {
          ix.question += 1;
          const answers = (Array.isArray(d.questions) ? d.questions : []).map((q) => ({
            id: q.id,
            selected: [],
            custom: '无人应答（自动评测）。请按你认为合理的最优默认做法继续，并直接给出最终答案。',
          }));
          host.notify('interact', { id: d.id, kind: 'question', answers });
          log(`  · ${job.id} 模型发起了提问（第 ${ix.question} 次），已兜底回答`);
          break;
        }
        case 'approval':
          ix.approval += 1;
          host.notify('interact', { id: d.id, kind: 'approval', outcome: 'allowed-once' });
          break;
        case 'canvas':
          ix.canvas += 1;
          host.notify('interact', { id: d.id, kind: 'canvas', error: '评测宿主无画布' });
          break;
        case 'db':
          ix.db += 1;
          host.notify('interact', { id: d.id, kind: 'db', error: '评测宿主无数据库' });
          break;
        case 'done': {
          rec.metrics = d.metrics ? redactObj(d.metrics, redact) : null;
          rec.finalResponse = d.finalResponse == null ? '' : String(d.finalResponse);
          finish();
          break;
        }
        default:
          break;
      }
    });
    timer = setTimeout(() => {
      /* 单题超时：按本轮 cancelTag 关掉这一槽位的运行时（不动另一臂），记 timeout 后放行队列 */
      errors.push(`本地超时 ${Math.round(timeoutMs / 1000)}s 未收到 done 事件`);
      host.notify('cancel', { workspace: paths.wsSlot(job.slot), cancelTag: `bench-${job.arm}-w${job.slot}` });
      rec.timedOut = true;
      forcedStatus = 'timeout';
      finish();
    }, timeoutMs);

    host.request('run', {
      reqId,
      workspace: paths.wsSlot(job.slot),
      input: job.input,
      model: cfg.model,
      maxTokens: cfg.maxTokens,
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl,
      provider: cfg.provider,
      mtnodeProviders: cfg.mtnodeProviders,
      webSearchApiKey: cfg.webSearchApiKey,
      dshHome: paths.dshHome,
      permissionPreset: cfg.permissionPreset,
      preset: job.spec.preset,
      effort: job.spec.effort,
      systemPrompt: '',
      cancelTag: `bench-${job.arm}-w${job.slot}`,
    }, 30000).then((res) => {
      if (!res || !res.accepted) errors.push('网关未接受本次 run');
    }).catch((err) => {
      /* run 帧本身失败不会再有 done 事件：立刻收尾，别让槽位干等到超时 */
      errors.push(String((err && err.message) || err).slice(0, 500));
      finish();
    });
  });
}

function safeHost(baseUrl) {
  try { return new URL(baseUrl).host; } catch { return ''; }
}

/** metrics 理论上不含密钥，但仍整体过一次 redact 做纵深防御（服务商错误串会原样带出来） */
function redactObj(o, redact) {
  try { return JSON.parse(redact(JSON.stringify(o))); } catch { return null; }
}

/* ------------------------------------------------------------------ 续跑 */

/** 读已有 results.jsonl：同一题+臂被重跑过多次时，**最后一条**说了算（与判分侧同一口径） */
function loadDone(file, { skipFailed }) {
  const last = new Map();
  if (!fs.existsSync(file)) return { done: new Set(), retried: 0 };
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let r;
    try { r = JSON.parse(t); } catch { continue; }
    if (!r || r.warmup) continue;
    if (!r.dataset || !r.id || !r.arm) continue;
    last.set(`${r.dataset}|${r.id}|${r.arm}`, r.status);
  }
  const done = new Set();
  let retried = 0;
  for (const [k, status] of last) {
    if (status === 'ok' || skipFailed) done.add(k);
    else retried += 1;
  }
  return { done, retried };
}

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (!nodeVersionOk()) {
    fail(`网关需要 Node ≥ ${MIN_NODE.join('.')}，当前 ${process.version}（dsh 运行时同要求）`);
  }
  if (!fs.existsSync(opt.gateway)) fail(`找不到网关：${opt.gateway}`);

  const benchRoot = ensureDir(opt.benchRoot);
  const runName = opt.run.replace(/[^\w.\-]/g, '_');
  if (!opt.datasetDir) opt.datasetDir = path.join(benchRoot, 'datasets');
  const wsRoot = path.join(benchRoot, 'ws', `run-${runName}`);
  const runDir = ensureDir(path.join(benchRoot, 'runs', runName));
  const paths = {
    name: runName,
    benchRoot,
    datasets: opt.datasetDir,
    dshHome: path.join(benchRoot, 'gateway-home'),
    wsRoot,
    runDir,
    resultFile: path.join(runDir, 'results.jsonl'),
    metaFile: path.join(runDir, 'run-meta.json'),
    logFile: path.join(runDir, 'runner.log'),
    wsSlot: (i) => path.join(wsRoot, `w${i}`),
  };

  const cfg = resolveRunConfig(opt);
  const redact = makeRedactor([cfg.apiKey, cfg.webSearchApiKey]);
  const log = (m) => {
    console.log(m);
    /* 逐行落盘：崩了或被 Ctrl+C 也不会丢日志（fail() 直接 process.exit，来不及收尾） */
    try { fs.appendFileSync(paths.logFile, `${new Date().toISOString()} ${redact(String(m))}\n`); } catch { /* ignore */ }
  };

  /* 数据集文件指纹：报告要证明「同一批题、两臂配对、两臂题序一致」 */
  const datasetInfo = {};
  for (const d of opt.datasets) {
    const f = datasetFile(opt, d);
    const buf = fs.readFileSync(f);
    datasetInfo[d] = { file: f, bytes: buf.length, sha256: sha256(buf) };
  }

  const problemsByDataset = {};
  for (const d of opt.datasets) problemsByDataset[d] = loadProblems(opt, d);

  /* 排程：每题 × 每臂 一个 job，整体按固定种子洗牌 —— 两臂对同一题严格配对，
     但执行顺序随机，抵消服务商侧前缀缓存与臂顺序带来的偏差。 */
  const rand = rng(opt.seed + 1);
  let jobs = [];
  for (const d of opt.datasets) {
    for (const p of problemsByDataset[d]) {
      for (const armName of opt.arms) {
        jobs.push({
          dataset: d, id: p.id, arm: armName, gold: p.gold,
          input: buildInput(p, opt), attempt: 1, slot: 0, order: 0, warmup: false,
          spec: armSpec(armName, opt),
        });
      }
    }
  }
  jobs = shuffled(jobs, rand);
  jobs.forEach((j, i) => { j.order = i + 1; });

  const { done: doneSet, retried: resumeRetry } = opt.force
    ? { done: new Set(), retried: 0 }
    : loadDone(paths.resultFile, { skipFailed: opt.skipFailed });
  const pendingJobs = jobs.filter((j) => !doneSet.has(jobKey(j)));

  log(`评测目录 ${runDir}`);
  log(`服务商 ${cfg.provider} · 模型 ${cfg.model} · 权限档 ${cfg.permissionPreset} · 并发 ${opt.concurrency} · 单题超时 ${opt.timeoutMin}min`);
  for (const d of opt.datasets) {
    log(`题集 ${d}: ${problemsByDataset[d].length} 题 × ${opt.arms.length} 臂（${datasetInfo[d].file}，sha256 ${datasetInfo[d].sha256.slice(0, 12)}…）`);
  }
  log(`计划 ${jobs.length} 次运行，已完成 ${doneSet.size}（续跑跳过，其中历史失败待重试 ${resumeRetry}）本轮待发 ${pendingJobs.length}`);
  log(`臂定义：${opt.arms.map((a) => { const s = armSpec(a, opt); return `${a}(preset=${s.preset}, 请求 effort=${s.effort} → 生效 ${s.effortEffective})`; }).join(' | ')}`);

  fs.writeFileSync(paths.metaFile, JSON.stringify({
    v: SCHEMA,
    generatedAt: new Date().toISOString(),
    run: paths.name,
    node: process.version,
    execPath: process.execPath,
    gatewayPath: opt.gateway,
    benchRoot,
    dshHome: paths.dshHome,
    workspaceRoot: wsRoot,
    arms: opt.arms.map((a) => armSpec(a, opt)),
    model: cfg.model,
    provider: cfg.provider,
    baseUrl: cfg.baseUrl,
    apiKeyPresent: !!String(cfg.apiKey || '').trim(),
    webSearchKeyPresent: !!String(cfg.webSearchApiKey || '').trim(),
    permissionPreset: cfg.permissionPreset,
    maxTokens: cfg.maxTokens ?? null,
    systemPrompt: '',
    toolGuard: !opt.allowTools,
    allowTools: opt.allowTools,
    warmup: opt.warmup,
    concurrency: opt.concurrency,
    timeoutMs: Math.round(opt.timeoutMin * 60000),
    retries: opt.retries,
    seed: opt.seed,
    sample: opt.sample,
    full: opt.full,
    limit: opt.limit,
    datasets: datasetInfo,
    problems: Object.fromEntries(opt.datasets.map((d) => [d, problemsByDataset[d].length])),
    plannedRuns: jobs.length,
    resumeSkipped: doneSet.size,
    resumeRetry,
  }, null, 2) + '\n', 'utf8');

  if (opt.dryRun) {
    log('—— dry-run：只打印排程，不启动网关、不发任何请求 ——');
    const head = pendingJobs.slice(0, 12);
    for (const j of head) log(`  #${j.order} ${j.arm} ${j.id} (${j.input.length} chars)`);
    if (pendingJobs.length > head.length) log(`  …其余 ${pendingJobs.length - head.length} 次`);
    return;
  }

  /* 记下 cordis.yml 开跑前的内容：网关启动会按 DSH_HOME 恢复挂载段，结束时还原，仓库不留脏改动。
     只有真跑仓库内那个网关才需要（--gateway 指向桩脚本时不碰 cordis.yml） */
  const usesRepoGateway = path.resolve(opt.gateway) === GATEWAY_PATH;
  const cordisBefore = usesRepoGateway && fs.existsSync(CORDIS_PATH) ? fs.readFileSync(CORDIS_PATH) : null;

  const host = new GatewayHost({ gatewayPath: opt.gateway, dshHome: paths.dshHome, log, redact });
  host.start();

  let status = null;
  for (let i = 0; i < 20; i++) {
    try {
      status = await host.request('status', {}, 5000);
      break;
    } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  if (!status) {
    await host.shutdown();
    fail('网关 status 无响应（看 runner.log 里的 stderr）');
  }
  log(`网关握手 ok：gateway=${status.gateway} node=${status.node} runtimeBin=${path.basename(status.runtimeBin || '')}`);

  if (opt.status) {
    log('—— --status：只握手，不消耗 token ——');
    console.log(JSON.stringify(status, null, 2));
    await host.shutdown();
    if (cordisBefore) restoreCordis(cordisBefore, log);
    return;
  }

  for (let i = 0; i < opt.concurrency; i++) ensureDir(paths.wsSlot(i));
  const slots = Array.from({ length: opt.concurrency }, (_, i) => makeSlot(i, paths));

  const out = fs.openSync(paths.resultFile, 'a');
  const writeRecord = (rec) => {
    fs.writeSync(out, JSON.stringify(rec) + '\n');
    fs.fsyncSync(out);
  };

  let interrupted = false;
  const onSigint = () => {
    interrupted = true;
    log('收到 Ctrl+C：收尾当前在途题后停止（已写的结果可续跑）');
  };
  process.on('SIGINT', onSigint);

  const queue = pendingJobs.slice();
  const warm = [];
  if (opt.warmup && pendingJobs.length) {
    /* 每臂先跑一道极短预热题：把「运行时起机 + 网关首轮预热」的开销从统计里隔开。
       记录照写，但带 warmup=true —— 判分与续跑都忽略它（见 loadDone / score 侧）。 */
    for (const a of opt.arms) {
      warm.push({
        dataset: 'warmup', id: `warmup-${a}`, arm: a, gold: null, spec: armSpec(a, opt),
        input: '只回复两个字：收到', attempt: 1, slot: 0, order: 0, warmup: true,
      });
    }
  }
  const work = [...warm, ...queue];
  let finished = 0;
  const totals = { ok: 0, error: 0, timeout: 0 };
  const totalJobs = work.length;

  const timeoutMs = Math.round(opt.timeoutMin * 60000);
  async function worker(slot) {
    for (;;) {
      if (interrupted) return;
      const job = work.shift();
      if (!job) return;
      job.slot = slot.index;
      const label = job.warmup ? `预热 ${job.arm}` : `#${job.order} ${job.arm} ${job.id}`;
      process.stdout.write(`  → ${label} 起（槽位 w${slot.index}）\n`);
      let rec = null;
      for (let attempt = 1; attempt <= opt.retries + 1; attempt++) {
        job.attempt = attempt;
        rec = await runOneJob({ host, cfg, paths, job, timeoutMs, log, redact });
        /* 每一次尝试都入账：重跑同样烧 token 与时间，报告要能算「含重试的真实成本」。
           判分侧按 (dataset,id,arm) 取最后一条，成本侧把所有条相加。 */
        writeRecord(rec);
        if (rec.status === 'ok' || job.warmup) break;
        if (attempt <= opt.retries) {
          log(`  · ${label} 第 ${attempt} 次失败（${rec.error.slice(0, 120)}），重跑一次`);
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      totals[rec.status] = (totals[rec.status] || 0) + 1;
      finished += 1;
      const m = rec.metrics || {};
      process.stdout.write(
        `  ← ${label} ${rec.status} [${finished}/${totalJobs}]`
        + `  tok in=${rec.usage.inputTokens}/out=${rec.usage.outputTokens}`
        + `/reason=${rec.usage.reasoningTokens}`
        + `  wall=${Math.round((m.wallMs ?? rec.runnerWallMs) / 1000)}s`
        + `  steps=${m.steps ?? '?'}  答复=${rec.finalResponse.length}ch\n`,
      );
    }
  }

  const t0 = Date.now();
  await Promise.all(slots.map(worker));
  const elapsed = ((Date.now() - t0) / 60000).toFixed(1);

  process.off('SIGINT', onSigint);
  fs.closeSync(out);
  /* 收尾前先在本地核一遍配对完整性：两臂对同一题是否都有记录（判分侧要按配对算差值） */
  const pairCheck = pairIntegrity(paths.resultFile);
  await host.shutdown();
  if (cordisBefore) restoreCordis(cordisBefore, log);

  log(`本轮完成：${finished} 次运行（ok=${totals.ok} error=${totals.error} timeout=${totals.timeout}），用时 ${elapsed} 分钟`);
  if (pairCheck.pairs > 0) {
    log(`配对核对：${pairCheck.pairs} 题两臂齐全，缺臂 ${pairCheck.missing} 题（判分按配对集算）`);
  }
  log(`结果：${paths.resultFile}`);
  log(`配置：${paths.metaFile}`);
  if (interrupted) {
    log('已中断：重跑同一条命令（--run ' + paths.name + '）会从断点继续');
    process.exitCode = 130;
  }
}

/** 数一下 results.jsonl 里两臂都跑完的题数与缺臂题数（同一题两臂齐全才可配对比较） */
function pairIntegrity(file) {
  if (!fs.existsSync(file)) return { pairs: 0, missing: 0 };
  const arms = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let r;
    try { r = JSON.parse(t); } catch { continue; }
    if (!r || r.warmup || r.dataset === 'warmup') continue;
    const k = `${r.dataset}|${r.id}`;
    if (!arms.has(k)) arms.set(k, new Set());
    arms.get(k).add(r.arm);
  }
  let pairs = 0;
  let missing = 0;
  for (const set of arms.values()) {
    if (set.size >= 2) pairs += 1;
    else missing += 1;
  }
  return { pairs, missing };
}

function restoreCordis(before, log) {
  try {
    if (!fs.existsSync(CORDIS_PATH)) return;
    if (sha256(fs.readFileSync(CORDIS_PATH)) === sha256(before)) return;
    fs.writeFileSync(CORDIS_PATH, before);
    log('已把 dsh/gateway/cordis.yml 还原成开跑前的内容（网关启动时按评测用 DSH_HOME 恢复过挂载段）');
  } catch (err) {
    log('还原 cordis.yml 失败，请手工 git checkout：' + String(err && err.message));
  }
}

main().catch((err) => {
  console.error('[bench][错误] ' + String((err && err.stack) || err).split('\n').slice(0, 4).join(' | '));
  process.exitCode = 1;
});
