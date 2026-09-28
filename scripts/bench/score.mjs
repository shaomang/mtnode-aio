#!/usr/bin/env node
/**
 * bench/score.mjs — 给 run-bench.mjs 的双臂结果判分并做统计（标准模式 vs 思维精简）。
 *
 * 判分口径（沿用 benchmark 官方指标，不自造指标）：
 *   GSM8K     最终数值 exact-match。gold 取官方 answer 里最后一个 `#### ` 之后的数值；
 *             预测值按 `#### N` → `\boxed{N}` → 「the answer is N」 → 全文最后一个数 的顺序抽取，
 *             归一规则与官方 grader 一致（去逗号 / 去 $ % / `\frac{a}{b}` 视作 a/b / 数值比较）。
 *   MATH-500  答案**等价性**判定（沿用 MATH / LightEval 口径，不做步骤分）：
 *             抽取优先级 `\boxed{}`（取最后一个）→ 行首 `ANSWER =/:` → 「(final) answer is …」→ 末行；
 *             归一化去 `$`、`\left`/`\right`、`\text{}` 包裹，`\dfrac`/`\tfrac`/`\cfrac`→`\frac`，
 *             去千分位逗号与 `\%`/`%`，`\frac{a}{b}`→a/b、`\sqrt{}`/带分数/幂一并转成可解析算式；
 *             比较三级：两边都是可解析数值 → 数值相等（相对容差 1e-6）；两边都是集合/元组/列表 →
 *             按元素递归比较（`{}` 视为无序、`()[]` 视为有序）；否则空白与符号规范化后全等。
 *             未判为对的题在 `<out>/math500/<arm>/<id>.md` 留一份可复核产物（gold 原文 + 抽取结果 + 答复全文）。
 *             `--selftest` 跑内置金标准与边界用例（等价写法判对、不等价判错），不需要 run 目录。
 *   HumanEval pass@1。从答复里抽出 python 代码块 → 程序 = 官方 prompt（含 import 与 helper def）
 *             + 模型代码 + 官方 test（定义 check(candidate)） + `\ncheck(<entry_point>)`，
 *             交给**本机 python 子进程**执行；退出码 0 记 pass。**空答复 / 抽不出代码 = 失败**
 *             （这是「思维精简」真实的产品风险，评分阶段不抹平；试点记录里 lean 臂确实有 2 题空答复）。
 *   MMLU      兜底集（本次未启用）：选项字母 exact-match，规则一并实现，换题集时无需再写判分器。
 *
 * 统计量（results.json / results.csv / summary.csv / scores.jsonl，全在仓库外）：
 *   - 两臂成功率（按数据集 + 合并），配对分析：两臂同对 / 同错 / 不一致计数 b、c
 *     McNemar 精确二项检验 p 值 + 配对 bootstrap 95% CI（成功率差值 lean - standard）
 *   - 每题 token 分解：总 token（含缓存读）/ 非缓存 token / 输出 / 思考 / 正文，均值·中位·P90
 *   - 端到端耗时：网关 wallMs 与宿主 runnerWallMs 的均值·中位·P90·P99·max，及 wall>15s 计数
 *   - 成本：按服务商价目（元/百万 token，峰谷两套价）估算总花费、每题成本、每道正确题的成本
 *   - 每题 token 节省率与耗时节省率（配对题集上算，含 lean 更低的题数）
 *   - 失败归因（格式不合规 / 空答复 / 语法错 / 断言失败 / 超时 …），供报告解释「差异从哪来」
 *
 * token 语义（依据 dsh/gateway 服务商适配器 mapUsage 的实际映射，已核对）：
 *   inputTokens  = prompt_tokens - cached_tokens（**不含**缓存读，两者不相交）
 *   cacheReadTokens = 缓存命中部分；计费 prompt 总量 = inputTokens + cacheReadTokens
 *   outputTokens = completion_tokens（**包含** reasoningTokens，思考是输出的子集，不能相加）
 *   所以「总 token」= inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens
 *
 * 可复现性：判分不重新下载数据，而是读 run-meta.json 记下的题集文件路径 + sha256 并**校验哈希**，
 *   对不上直接报错退出（防止「跑的是 A 子集、判的是 B 子集」）。随机化只用固定种子的
 *   mulberry32（与 fetch-data / run-bench 同一套），bootstrap 结果可复现。
 *
 * 用法：
 *   node scripts/bench/score.mjs                        # 判 runs\full（默认）
 *   node scripts/bench/score.mjs --run pilot            # 判试点
 *   node scripts/bench/score.mjs --python none          # 不执行 HumanEval（只判 GSM8K + token 统计）
 *   node scripts/bench/score.mjs --he-parallel 6 --he-timeout-sec 30
 *   node scripts/bench/score.mjs --price-mode offpeak --price-out 4.5 --price-in 1.5 --price-cache 0.05
 *   node scripts/bench/score.mjs --price-json my-prices.json   # 整表替换（见 DEFAULT_PRICES 结构）
 *   node scripts/bench/score.mjs --selftest              # 只跑 MATH-500 判分器自测（无需 run 目录）
 *
 * 参数：
 *   --run <name>        要判的 run 目录名（默认 full；即 %LOCALAPPDATA%\mtnode-bench\runs\<name>）
 *   --bench-root <dir>  评测根目录（默认 %LOCALAPPDATA%\mtnode-bench，或 MTNODE_BENCH_ROOT）
 *   --out <dir>         产物目录（默认 <run目录>，与 results.jsonl 同处，均在仓库外）
 *   --dataset <a,b>     要判哪些数据集（默认取 run-meta 里记录的全部）
 *   --arms <a,b>        要对比的臂（默认取 run-meta 里记录的臂）
 *   --python <auto|路径|none>  HumanEval 执行用的解释器（默认 auto：python → py -3）
 *   --he-timeout-sec <s> 单个 HumanEval 程序的执行上限（默认 20）
 *   --he-parallel <n>   执行并发（默认 4，1..16）
 *   --no-he-artifacts   判分后删除生成的 .py 程序（默认保留 <out>/humaneval/ 供人工复核）
 *   --price-mode <peak|offpeak|both> 成本口径（默认 both：主口径取 peak，附带 offpeak）
 *   --price-in/--price-cache/--price-out <元/百万> 覆盖主价目（缓存写入按 0 计，DeepSeek 不收）
 *   --price-json <file> 用 JSON 文件整表替换价目
 *   --bootstrap <n>     配对 bootstrap 次数（默认 4000，需 ≥200）
 *   --seed <s>          bootstrap 随机种子（默认 20260904）
 *   --quiet             只写文件，不打印人读汇总
 *   --selftest          只跑 MATH-500 判分器的内置金标准/边界用例（不读 run 目录，全对退出码 0）
 *
 * 注意：HumanEval 判分会**在本机执行模型生成的代码**（这是该 benchmark 的标准做法，无沙箱隔离），
 *   程序落在仓库外 <out>/humaneval/ 下，且题面已要求模型不读写文件 / 不跑命令；
 *   若你不想执行，用 --python none，该数据集判为 skipped 并如实反映在成功率分母上。
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const SCHEMA = 'mtnode-bench-run/1';

/* ------------------------------------------------------------------ CLI */

/** DeepSeek-V4-Flash 公开价目（元 / 百万 token）。2026-08 峰谷定价调整后的口径：
 *  空闲时段 = 高峰时段的一半；缓存写入不单独计费。数字只影响「成本」这一列，
 *  随时可用 --price-* 覆盖；results.json 会把实际用到的价目原样记下来。 */
const DEFAULT_PRICES = {
  currency: 'CNY',
  unit: '元/百万 token',
  model: 'deepseek-v4-flash',
  peak: { input: 3.0, cacheHit: 0.1, cacheWrite: 0, output: 9.0 },
  offPeak: { input: 1.5, cacheHit: 0.05, cacheWrite: 0, output: 4.5 },
  source: [
    'https://www.techweb.com.cn/it/2026-08-17/2978269.shtml',
    'https://api-docs.deepseek.com/quick_start/models-pricing',
  ],
  note: '第三方报道的 DeepSeek-V4 系列调价：V4-Flash 输入未命中 1.5→3.0、输出 4.5→9.0、'
    + '缓存命中空闲 0.05 / 高峰 0.10（元/百万 token）；空闲时段为高峰一半。以官方价格页为准。',
};

function defaultBenchRoot() {
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
    run: 'full',
    benchRoot: defaultBenchRoot(),
    out: '',
    datasets: null,
    arms: null,
    python: 'auto',
    heTimeoutSec: 20,
    heParallel: 4,
    heArtifacts: true,
    priceMode: 'both',
    prices: null,
    priceJson: '',
    bootstrap: 4000,
    seed: 20260904,
    quiet: false,
    selftest: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (what) => {
      const v = argv[++i];
      if (v === undefined) fail(`${a} 缺少${what}`);
      return v;
    };
    if (a === '--run') o.run = next('名称');
    else if (a === '--bench-root') o.benchRoot = path.resolve(next('目录'));
    else if (a === '--out') o.out = path.resolve(next('目录'));
    else if (a === '--dataset') o.datasets = next('数据集').split(',').map((x) => x.trim()).filter(Boolean);
    else if (a === '--arms') o.arms = next('臂').split(',').map((x) => x.trim()).filter(Boolean);
    else if (a === '--python') o.python = next('解释器');
    else if (a === '--he-timeout-sec') o.heTimeoutSec = Number(next('秒'));
    else if (a === '--he-parallel') o.heParallel = Number.parseInt(next('并发'), 10);
    else if (a === '--no-he-artifacts') o.heArtifacts = false;
    else if (a === '--price-mode') o.priceMode = next('口径');
    else if (a === '--price-in') o.priceIn = Number(next('价格'));
    else if (a === '--price-cache') o.priceCache = Number(next('价格'));
    else if (a === '--price-out') o.priceOut = Number(next('价格'));
    else if (a === '--price-json') o.priceJson = path.resolve(next('文件'));
    else if (a === '--bootstrap') o.bootstrap = Number.parseInt(next('次数'), 10);
    else if (a === '--seed') o.seed = Number.parseInt(next('种子'), 10);
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--selftest') o.selftest = true;
    else if (a === '-h' || a === '--help') {
      console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, ''));
      process.exit(0);
    } else fail(`未知参数：${a}（--help 看用法）`);
  }
  if (!Number(o.heTimeoutSec) || o.heTimeoutSec <= 0) fail('--he-timeout-sec 需为正数');
  if (!Number.isInteger(o.heParallel) || o.heParallel < 1 || o.heParallel > 16) fail('--he-parallel 只支持 1..16');
  if (!['peak', 'offpeak', 'both'].includes(o.priceMode)) fail('--price-mode 只支持 peak / offpeak / both');
  if (!Number.isInteger(o.bootstrap) || o.bootstrap < 200) fail('--bootstrap 需为 ≥200 的整数');
  return o;
}

function fail(msg) {
  console.error(`[score][错误] ${msg}`);
  process.exit(1);
}

/* ------------------------------------------------------------------ 小工具 */

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function sha256File(p) {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/** mulberry32：与 fetch-data.mjs / run-bench.mjs 同一套可复现随机 */
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

function readJsonl(file) {
  const out = [];
  const raw = fs.readFileSync(file, 'utf8');
  let line = 0;
  for (const s of raw.split('\n')) {
    line++;
    const t = s.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      fail(`${file} 第 ${line} 行不是合法 JSON`);
    }
  }
  return out;
}

function num(x) {
  const v = Number(x);
  return Number.isFinite(v) ? v : 0;
}

function sum(arr) {
  return arr.reduce((s, v) => s + v, 0);
}

function mean(arr) {
  return arr.length ? sum(arr) / arr.length : 0;
}

/** 线性插值分位（与常见统计口径一致：p ∈ [0,1]，升序数组） */
function quantile(values, p) {
  const a = values.filter((v) => Number.isFinite(v)).slice().sort((x, y) => x - y);
  if (!a.length) return 0;
  if (a.length === 1) return a[0];
  const idx = (a.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (idx - lo);
}

function describe(values) {
  const a = values.filter((v) => Number.isFinite(v));
  if (!a.length) return { n: 0, mean: 0, median: 0, p75: 0, p90: 0, p99: 0, min: 0, max: 0, total: 0 };
  return {
    n: a.length,
    mean: round(mean(a), 2),
    median: round(quantile(a, 0.5), 2),
    p75: round(quantile(a, 0.75), 2),
    p90: round(quantile(a, 0.9), 2),
    p99: round(quantile(a, 0.99), 2),
    min: round(Math.min(...a), 2),
    max: round(Math.max(...a), 2),
    total: round(sum(a), 2),
  };
}

function round(v, digits = 2) {
  if (!Number.isFinite(v)) return 0;
  const k = 10 ** digits;
  return Math.round(v * k) / k;
}

function pct(v, digits = 1) {
  return round(v * 100, digits);
}

/* ------------------------------------------------------------------ GSM8K 判分 */

/** 官方 normalize/extract 语义：从 gold.answer 取最后一个 `#### ` 之后的最终数值 */
function gsm8kGold(rawAnswer) {
  const s = String(rawAnswer ?? '');
  const parts = s.split('####');
  const tail = (parts.length > 1 ? parts[parts.length - 1] : s).trim();
  return normalizeNumeric(tail);
}

/** 归一一个数值串：去逗号 / 货币符 / 百分号 / 句点；`\frac{a}{b}` → a/b；失败返回 null */
function normalizeNumeric(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  const frac = /\\frac\s*\{?(-?\d+(?:\.\d+)?)\}?\s*\{?(-?\d+(?:\.\d+)?)\}?/.exec(s);
  if (frac) {
    const den = Number(frac[2]);
    if (den !== 0) return { value: Number(frac[1]) / den, text: round(Number(frac[1]) / den, 6), kind: 'frac' };
  }
  s = s.replace(/\\boxed\s*\{([^{}]*)\}/g, '$1');
  s = s.replace(/[,，]/g, '').replace(/[$¥€%]|USD|美元/gi, '').replace(/\.\s*$/, '');
  s = s.replace(/^(the answer is|答案是|答案：|answer:)\s*/i, '').trim();
  const m = /-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/.exec(s.split(/\s+/).filter(Boolean).slice(-1)[0] ?? s);
  if (!m) return null;
  const v = Number(m[0]);
  return Number.isFinite(v) ? { value: v, text: m[0], kind: 'num' } : null;
}

/** 预测答案抽取：`#### N` → `\boxed{N}` → 「answer is N」 → 全文最后一个数 */
function extractGsm8k(response) {
  const s = String(response ?? '');
  if (!s.trim()) return { parsed: null, method: 'empty' };
  const hashes = [...s.matchAll(/#{2,}\s*([^\n\r]*)/g)];
  if (hashes.length) {
    const p = normalizeNumeric(hashes[hashes.length - 1][1]);
    if (p) return { parsed: p, method: 'hash-mark' };
  }
  const boxed = [...s.matchAll(/\\boxed\s*\{([^{}]+)\}/g)];
  if (boxed.length) {
    const p = normalizeNumeric(boxed[boxed.length - 1][1]);
    if (p) return { parsed: p, method: 'boxed' };
  }
  const stated = [...s.matchAll(/(?:the answer is|答案是|答案：|answer:)\s*([^\n.。]*)/gi)];
  if (stated.length) {
    const p = normalizeNumeric(stated[stated.length - 1][1]);
    if (p) return { parsed: p, method: 'answer-is' };
  }
  /* 兜底：从末尾向前找第一个含数字的行（官方 grader 也是「最后一个数」口径） */
  const lines = s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const nums = lines[i].match(/-?\d+(?:,\d{3})*(?:\.\d+)?/g);
    if (nums && nums.length) {
      const p = normalizeNumeric(nums[nums.length - 1]);
      if (p) return { parsed: p, method: 'last-number' };
    }
  }
  return { parsed: null, method: 'no-number' };
}

function gsm8kGrade(response, goldAnswer) {
  const gold = gsm8kGold(goldAnswer);
  const got = extractGsm8k(response);
  if (!gold) return { correct: false, reason: 'gold-unparsable', extracted: null, method: got.method };
  if (!got.parsed) return { correct: false, reason: got.method === 'empty' ? 'empty-response' : 'no-answer', extracted: null, method: got.method };
  const close = Math.abs(got.parsed.value - gold.value) <= 1e-4 * Math.max(1, Math.abs(gold.value));
  return {
    correct: close,
    reason: close ? 'match' : 'value-mismatch',
    extracted: got.parsed.text,
    method: got.method,
    gold: gold.text,
  };
}

/* ------------------------------------------------------------------ MATH-500 判分 */

/** 取 s[open] 处 '{' 开始的平衡花括号内容（承认 \{ \} 转义）；不闭合返回 null */
function braceContent(s, open) {
  if (s[open] !== '{') return null;
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (!depth) return s.slice(open + 1, i);
    }
  }
  return null;
}

/** 最后一个 \boxed{...} / \fbox{...} 的内容（官方 grader 的 last_boxed_only_string 口径） */
function lastBoxed(s) {
  const idx = Math.max(s.lastIndexOf('\\boxed'), s.lastIndexOf('\\fbox'));
  if (idx < 0) return null;
  const after = s.slice(idx);
  const m = /^\\(?:boxed|fbox)[ \t]*\{/.exec(after);
  if (!m) return null;
  return braceContent(after, m[0].length - 1);
}

/** 去掉行尾的标点 / 反引号 / 星号等装饰，保留数学内容 */
function tailOf(s) {
  let t = String(s ?? '').trim();
  t = t.replace(/^[*`_\s]+/, '').replace(/[*`_\s]+$/, '');
  t = t.replace(/[.,;:。，、；]+$/, '').trim();
  return t;
}

/** 答案抽取优先级：\boxed{} → ANSWER = → final answer is → 末行 */
function extractMathAnswer(raw) {
  const s = String(raw ?? '');
  if (!s.trim()) return { text: '', method: 'empty' };
  const boxed = lastBoxed(s);
  if (boxed !== null && boxed.trim()) return { text: tailOf(boxed), method: 'boxed' };
  const marked = [...s.matchAll(/(?:^|\r?\n)[ \t]*(?:#{1,4}[ \t]*)?ANSWER[ \t]*[:=][ \t]*([^\r\n]+)/gi)];
  if (marked.length) {
    const inner = lastBoxed(marked[marked.length - 1][1]);
    const text = tailOf(inner !== null ? inner : marked[marked.length - 1][1]);
    if (text) return { text, method: 'answer-mark' };
  }
  const stated = [...s.matchAll(/(?:final answer is|the answer is|answer is|最终答案(?:是|为)|答案(?:是|为|：))\s*([^\r\n]+)/gi)];
  if (stated.length) {
    const inner = lastBoxed(stated[stated.length - 1][1]);
    const text = tailOf(inner !== null ? inner : stated[stated.length - 1][1]);
    if (text) return { text, method: 'answer-is' };
  }
  const lines = s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const last = lines.length ? tailOf(lines[lines.length - 1]) : '';
  return last ? { text: last, method: 'last-line' } : { text: '', method: 'no-answer' };
}

/** 反复应用替换直到不再变化（处理嵌套 \frac / \sqrt） */
function replaceAllFix(s, re, make) {
  let out = s;
  for (let i = 0; i < 6; i++) {
    const next = out.replace(re, make);
    if (next === out) break;
    out = next;
  }
  return out;
}

/** 数学串归一：先做反斜杠命令的展开（\dfrac→\frac、\frac→(a)/(b)、\sqrt→sqrt()、去 \left \right \text），
 *  再去 $ \% 千分位与 unicode 符号，最后压空白。必须在删反斜杠**之前**处理带命令的部分。 */
function normMath(raw) {
  let s = String(raw ?? '');
  if (!s.trim()) return '';
  /* 矩阵 / 分段环境先展平成逗号列表：\begin{pmatrix}a\\b\end{pmatrix} ≡ (a,b)。
     必须在「去剩余反斜杠」之前做，否则只剩 begin{pmatrix} -18 -49 96 end{pmatrix} 这种不可解析残串
     （2026-09-04 fresh4 审计：math500#54 四臂同型误判）。 */
  s = s.replace(/\\begin\s*\{[a-zA-Z*]+\}[ \t]*([\s\S]*?)[ \t]*\\end\s*\{[a-zA-Z*]+\}/g,
    (_m, body) => ' (' + body.replace(/\\\\/g, ',').replace(/&/g, ',').replace(/\s+/g, ' ').trim() + ')');
  s = s.replace(/\\[dtc]frac/g, '\\frac');
  /* LaTeX 千分位写法：`32,\!348` / `1{,}000` 是**一个数**，不是二元列表
     （2026-09-04 fresh4 审计：gold `\$32,\!348` 被 `\,`→空格 规则拆成 "32, 348"，四臂同型误判） */
  s = s.replace(/(\d)\s*,\s*\\!,?\s*(\d{3})(?![\d])/g, '$1$2');
  s = s.replace(/(\d)\{,\}(\d{3})(?![\d])/g, '$1$2');
  s = s.replace(/(\d)\\,\{?(\d{3})\}?(?![\d])/g, '$1$2');
  s = s.replace(/\\(?:left|right|middle|big|Big|bigg|Bigg)[ \t]*[.!]/g, '');
  s = s.replace(/\\(?:left|right|middle|big|Big|bigg|Bigg)[ \t]*/g, '');
  s = replaceAllFix(s, /\\(?:text|mbox|textrm|mathrm|mathit|operatorname|mathbf)\s*\{([^{}]*)\}/g, '$1');
  s = s.replace(/\\(?:,|;|:|!|quad|qquad|\\)/g, ' ');
  s = s.replace(/\\%/g, '').replace(/\\(?:degree|deg)(?![a-zA-Z])/g, '').replace(/\^\s*\{?\s*\\circ\s*\}?|\\circ/g, '');
  s = s.replace(/\\(?:times|cdot|ast|otimes|bigtriangleup)(?![a-zA-Z])/g, '*').replace(/\\div(?![a-zA-Z])/g, '/');
  s = s.replace(/\\(?:leq|leqslant|le)(?![a-zA-Z])/g, '<=').replace(/\\(?:geq|geqslant|ge)(?![a-zA-Z])/g, '>=');
  s = s.replace(/\\(?:neq|ne)(?![a-zA-Z])/g, '!=').replace(/\\(?:lt|less)(?![a-zA-Z])/g, '<').replace(/\\(?:gt|greater)(?![a-zA-Z])/g, '>');
  /* \cup / \cap / \pm 保留为「带空格的词」，不能让去反斜杠把 (12,102) 与 cup 粘成一个数 */
  s = s.replace(/\\(?:cup|bigcup|union)(?![a-zA-Z])/g, ' cup ').replace(/\\(?:cap|bigcap|intersection)(?![a-zA-Z])/g, ' cap ');
  s = s.replace(/\\(?:pm|plusmn)(?![a-zA-Z])/g, ' +- ').replace(/\\(?:mp)(?![a-zA-Z])/g, ' -+ ');
  s = s.replace(/\\infty(?![a-zA-Z])/g, 'inf').replace(/\\pi(?![a-zA-Z])/g, 'pi');
  s = s.replace(/\\sqrt\s*\[([^\]]*)\]\s*\{([^{}]*)\}/g, 'root($1)($2)');
  s = replaceAllFix(s, /\\sqrt\s*\{([^{}]*)\}/g, 'sqrt($1)');
  s = s.replace(/\\sqrt\s*(\d+(?:\.\d+)?)/g, 'sqrt($1)');
  s = replaceAllFix(s, /(\d)\s*\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '$1+($2)/($3)');   // 带分数 1\frac{1}{2}
  s = replaceAllFix(s, /\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '($1)/($2)');
  /* 半边花括号：MATH 官方 gold 里真有 \frac{270}7 这种写法（审计 math500#30 四臂同型误判） */
  s = replaceAllFix(s, /\\frac\s*\{([^{}]*)\}\s*(\d+|[a-zA-Z])(?![a-zA-Z0-9])/g, '($1)/($2)');
  s = replaceAllFix(s, /\\frac\s*(\d+)\s*\{([^{}]*)\}/g, '($1)/($2)');
  s = replaceAllFix(s, /(\d)\s+(\d+)\s*\/\s*(\d+)(?![\d/])/g, '$1+($2)/($3)');             // 带分数的空格写法 1 4/5
  s = s.replace(/([a-zA-Z0-9})\]])\s*\^\s*\{([^{}]*)\}/g, '$1^($2)');                     // 2^{10} → 2^(10)
  s = s.replace(/\^\s*(\d+)/g, '^($1)');                                                  // R^2 → R^(2)（与 R² 同形）
  s = s.replace(/\$/g, '').replace(/\\/g, '');                                             // 剩余反斜杠（\{ \} \& 等）只去符号
  s = s.replace(/×|·/g, '*').replace(/÷/g, '/').replace(/≤/g, '<=').replace(/≥/g, '>=');
  s = s.replace(/≠/g, '!=').replace(/∞/g, 'inf').replace(/π/g, 'pi').replace(/√/g, 'sqrt').replace(/[–—]/g, '-');
  s = s.replace(/∪/g, ' cup ').replace(/∩/g, ' cap ').replace(/±/g, ' +- ').replace(/−/g, '-');
  s = s.replace(/[²³¹]/g, (c) => '^(' + { '¹': 1, '²': 2, '³': 3 }[c] + ')').replace(/°/g, '');
  /* 千分位**只在整串就是一个数**时剥离：`(12,102)` 里的逗号是列表/区间分隔，
     无条件剥会变成 12102（审计 math500#97：gold 与答复其实是同一个并集，被判不等）。 */
  const bare = s.trim();
  if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(bare)) s = bare.replace(/,/g, '');
  else s = bare.replace(/,\s+/g, ', ');                                                    // 「32, 348」与「32,348」同形
  s = s.replace(/%/g, '');                                                                  // 百分号
  s = s.replace(/\b(?:degrees?|degree)\b/g, '');
  s = s.replace(/(\d)(?:st|nd|rd|th)\b/g, '$1');                                            // 12th → 12
  s = s.replace(/[ \t]+/g, ' ').trim();
  s = s.replace(/^=/, '').trim();
  return tailOf(s);
}

/* 答复尾巴带单位（gallons / cents / inches per second / 12th grade…）时的兜底：
   从右往左剥掉尾部字母词，直到剩下的串能整体求值；剥不动或剥完仍不可求值就返回 null。
   自我约束在「核心必须可数值求值」，所以 `5 or 6`、`blue`、含未定义变量的式子都不会被误剥成别的数。
   （2026-09-04 fresh4 审计：MATH-500 的 gold 常是裸数，而模型按题面带单位作答 —— 四臂同型误判。） */
function numericCoreAfterUnitTail(canon) {
  let t = String(canon ?? '').trim();
  let trimmed = false;
  for (let i = 0; i < 6; i++) {
    if (t && evalNumeric(unwrapScalar(t)) !== null) return trimmed ? t : null;
    const m = /[ \t]+([A-Za-z][A-Za-z.'-]*)$/.exec(t);
    if (!m) return null;
    t = t.slice(0, m.index).trim();
    trimmed = true;
  }
  return null;
}



/** 递归下降求值：+ - * / ^、隐式乘法、sqrt()、|x|、pi；解析不了返回 null */
function evalNumeric(canon) {
  const src = String(canon ?? '').replace(/\s+/g, '');
  if (!src || /[^0-9+\-*/^().a-z|]/i.test(src)) return null;
  const toks = [];
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const text = src.slice(i, j);
      const v = Number(text);
      if (!Number.isFinite(v) || text === '.' || (text.match(/\./g) || []).length > 1) return null;
      toks.push({ k: 'num', v });
      i = j;
      continue;
    }
    if (/[a-z]/i.test(c)) {
      let j = i;
      while (j < src.length && /[a-z]/i.test(src[j])) j++;
      const id = src.slice(i, j).toLowerCase();
      if (id === 'pi') toks.push({ k: 'num', v: Math.PI });
      else if (id === 'sqrt') toks.push({ k: 'sqrt' });
      else return null;
      i = j;
      continue;
    }
    if ('+-*/^()|'.includes(c)) {
      toks.push({ k: c });
      i++;
      continue;
    }
    return null;
  }
  let p = 0;
  const peek = () => toks[p];
  const eat = (k) => (peek() && peek().k === k ? (p++, true) : false);
  const startsPrimary = (t) => !!t && (t.k === 'num' || t.k === '(' || t.k === 'sqrt');
  function primary() {
    const t = peek();
    if (!t) return null;
    if (t.k === 'num') { p++; return t.v; }
    if (t.k === 'sqrt') {
      p++;
      const arg = primary();
      if (arg === null) return null;
      return Math.sqrt(arg);
    }
    if (t.k === '|') {
      p++;
      const inner = expr();
      if (inner === null || !eat('|')) return null;
      return Math.abs(inner);
    }
    if (t.k === '(') {
      p++;
      const inner = expr();
      if (inner === null || !eat(')')) return null;
      return inner;
    }
    return null;
  }
  function power() {
    const base = primary();
    if (base === null) return null;
    if (peek() && peek().k === '^') {
      p++;
      const ex = unary();
      if (ex === null) return null;
      return base ** ex;
    }
    return base;
  }
  function unary() {
    if (eat('-')) { const v = unary(); return v === null ? null : -v; }
    if (eat('+')) return unary();
    return power();
  }
  function term() {
    let v = unary();
    if (v === null) return null;
    for (;;) {
      const t = peek();
      if (t && t.k === '*') { p++; const r = unary(); if (r === null) return null; v *= r; continue; }
      if (t && t.k === '/') {
        p++;
        const r = unary();
        if (r === null) return null;
        if (r === 0) return null;
        v /= r;
        continue;
      }
      if (startsPrimary(t)) { const r = unary(); if (r === null) return null; v *= r; continue; } // 隐式乘法
      break;
    }
    return v;
  }
  function expr() {
    let v = term();
    if (v === null) return null;
    for (;;) {
      if (peek() && peek().k === '+') { p++; const r = term(); if (r === null) return null; v += r; continue; }
      if (peek() && peek().k === '-') { p++; const r = term(); if (r === null) return null; v -= r; continue; }
      break;
    }
    return v;
  }
  const val = expr();
  if (val === null || p !== toks.length || !Number.isFinite(val)) return null;
  return val;
}

function closeEnough(a, b) {
  return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
}

/** 顶层逗号切分（尊重 () {} []）；不是容器返回 null */
function splitContainer(canon) {
  const s = String(canon ?? '').trim();
  if (!s) return null;
  let body = s;
  let kind = 'list';
  for (const [o, cl, k] of [['{', '}', 'set'], ['(', ')', 'seq'], ['[', ']', 'seq']]) {
    if (!s.startsWith(o) || !s.endsWith(cl)) continue;
    const inner = s.slice(1, -1);
    let depth = 0;
    let ok = true;
    for (const c of inner) {
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) {
        depth--;
        if (depth < 0) { ok = false; break; }
      }
    }
    if (ok && depth === 0) { body = inner; kind = k; break; }
  }
  /* 半开半闭区间 `(a,b]` / `[a,b)`：MATH 的区间答案常见，视作有序容器
     （2026-09-04 fresh4 审计：`\left(\frac35,\frac83\right]` 与 `3/5, 8/3]` 因定界符不配对而判不等） */
  if (kind === 'list' && /^[([{]/.test(s) && /[\])}]$/.test(s)) {
    const inner = s.slice(1, -1);
    let d = 0;
    let ok = true;
    for (const c of inner) {
      if ('([{'.includes(c)) d++;
      else if (')]}'.includes(c)) { d--; if (d < 0) { ok = false; break; } }
    }
    if (ok && d === 0) { body = inner; kind = 'seq'; }
  }
  const items = [];
  let depth = 0;
  let cur = '';
  for (const c of body) {
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) {
      items.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  items.push(cur.trim());
  const list = items.filter((x) => x !== '');
  if (list.length < 2) return null;
  return { kind, items: list };   // wrapped → set/seq；否则裸逗号列表（1, 2, 3）
}

/** 集合/元组/列表按元素递归比较：同为 {..} 视为无序；同为 (..)/[..] 视为有序；混合先有序后无序 */
function compareContainers(a, b) {
  if (a.items.length !== b.items.length) return false;
  const orderedFirst = a.kind === b.kind && a.kind !== 'set';
  if (a.items.every((x, i) => mathEquiv(x, b.items[i]))) return true;
  if (orderedFirst) return false;
  const key = (x) => normMath(x).replace(/\s+/g, '');
  const ba = a.items.slice().sort((x, y) => key(x).localeCompare(key(y)));
  const bb = b.items.slice().sort((x, y) => key(x).localeCompare(key(y)));
  return ba.every((x, i) => mathEquiv(x, bb[i]));
}

/** s[0] 处的定界符若正好闭合到末位，返回其内部内容；`(a)/(b)` 这种不整体包裹的返回 null */
function wholeWrap(s) {
  const close = { '{': '}', '(': ')', '[': ']' }[s[0]];
  if (!close || !s.endsWith(close)) return null;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') {
      depth--;
      if (!depth) return i === s.length - 1 ? s.slice(1, -1).trim() : null;
    }
  }
  return null;
}

/** 剥掉不含顶层逗号的单层包裹：`\{5\}`、`(5)` 与 `5` 视为同一个标量答案 */
function unwrapScalar(canon) {
  let t = String(canon ?? '').trim();
  for (let i = 0; i < 4; i++) {
    const inner = wholeWrap(t);
    if (!inner) break;
    let depth = 0;
    let comma = false;
    for (const c of inner) {
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) depth--;
      else if (c === ',' && depth === 0) comma = true;
    }
    if (comma) break;                                     // 多元素容器交给 splitContainer
    t = inner.trim();
  }
  return t;
}

/** 等价判定：可解析数值走数值相等（相对容差）→ 容器按元素递归 → 空白/符号规范化后全等 */
/** 区间两种写法互通：`(3,4]` ≡ `3 < λ <= 4`（审计：只有按不等式链作答的臂被扣分，属判分口径而非模型能力）。
 *  返回 { lo, hi, loClosed, hiClosed }；不是区间就返回 null。 */
function intervalOf(canon) {
  const s = String(canon ?? '').trim().replace(/\s+/g, ' ');
  const num = (t) => {
    const x = String(t).trim();
    if (/^-?inf(inity)?$/i.test(x)) return x[0] === '-' ? -Infinity : Infinity;
    const v = evalNumeric(x);
    return v === null ? null : v;
  };
  let m = /^([[({])\s*([^,()\[\]]+)\s*,\s*([^,()\[\]]+)\s*([\])}])$/.exec(s);
  if (m) {
    const lo = num(m[2]);
    const hi = num(m[3]);
    if (lo !== null && hi !== null) return { lo, hi, loClosed: m[1] === '[', hiClosed: m[4] === ']' };
  }
  m = /^([-+\d.]+|[a-z]+|π)[ \t]*(<=|<|>=|>)[ \t]*([^<>=]+?)[ \t]*(<=|<|>=|>)[ \t]*([-+\d.]+|[a-z]+|π)$/i.exec(s);
  if (m) {
    const invert = (o) => ({ '<': '>', '<=': '>=', '>': '<', '>=': '<=' }[o]);
    let lo = m[1];
    let hi = m[5];
    let oLo = m[2];
    let oHi = m[4];
    if (oLo === '>' || oLo === '>=') {                       // 递减链 a > x >= b → 翻成递增
      [lo, hi] = [hi, lo];
      [oLo, oHi] = [invert(oHi), invert(m[2])];
      if (oLo === '>' || oLo === '>=') return null;          // a > x < b 不是区间
    } else if (oHi === '>' || oHi === '>=') {
      return null;                                           // a < x > b 不是区间
    }
    const loV = num(lo);
    const hiV = num(hi);
    if (loV === null || hiV === null) return null;
    /* 递增链语义：`a < x` 左开、`a <= x` 左闭；`x < b` 右开、`x <= b` 右闭 */
    return { lo: loV, hi: hiV, loClosed: oLo === '<=', hiClosed: oHi === '<=' };
  }
  return null;
}

/** 区间等价：一边写成 (a,b]、另一边写成 a < x <= b 时判等（端点数值 + 开闭性都要一致） */
function intervalMatch(ga, gb) {
  const ia = intervalOf(ga);
  const ib = intervalOf(gb);
  if (!ia || !ib) return false;
  return closeEnough(ia.lo, ib.lo) && closeEnough(ia.hi, ib.hi)
    && ia.loClosed === ib.loClosed && ia.hiClosed === ib.hiClosed;
}

function mathEquiv(goldRaw, gotRaw) {
  const ga = normMath(goldRaw);
  const gb = normMath(gotRaw);
  if (!ga || !gb) return false;
  const a = unwrapScalar(ga);
  const b = unwrapScalar(gb);
  const va = evalNumeric(a);
  const vb = evalNumeric(b);
  if (va !== null && vb !== null) return closeEnough(va, vb);
  const ca = splitContainer(ga);
  const cb = splitContainer(gb);
  if (ca && cb) return compareContainers(ca, cb);
  if (a.replace(/\s+/g, '') === b.replace(/\s+/g, '')) return true;
  /* 区间 vs 不等式链：`(3,4]` ≡ `3 < λ <= 4`（同一答案的两种写法，判分口径不该只认一种） */
  if (intervalMatch(ga, gb)) return true;
  /* 单位尾巴兜底：两侧各剥出可求值的数值核心再比（gold `550` vs 答复 `550 gallons`） */
  const ua = numericCoreAfterUnitTail(a);
  const ub = numericCoreAfterUnitTail(b);
  if (ua || ub) {
    const xa = evalNumeric(unwrapScalar(ua || a));
    const xb = evalNumeric(unwrapScalar(ub || b));
    if (xa !== null && xb !== null && closeEnough(xa, xb)) return true;
  }
  return false;
}


function math500Grade(response, goldAnswer) {
  const g = extractMathAnswer(goldAnswer);
  const got = extractMathAnswer(response);
  const goldCanon = normMath(g.text);
  const gotCanon = normMath(got.text);
  if (!goldCanon) {
    return { correct: false, reason: 'gold-unparsable', extracted: gotCanon || null, method: got.method, gold: null };
  }
  if (!got.text || !gotCanon) {
    return {
      correct: false,
      reason: got.method === 'empty' ? 'empty-response' : 'no-answer',
      extracted: null,
      method: got.method,
      gold: goldCanon,
    };
  }
  const ok = mathEquiv(goldCanon, gotCanon);
  return {
    correct: ok,
    reason: ok ? 'match' : 'value-mismatch',
    extracted: gotCanon,
    method: got.method,
    gold: goldCanon,
    goldMethod: g.method,
  };
}

/** 取第一个非空字符串（gold 字段名在不同题集里不统一） */
function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (v === null || v === undefined) continue;
    const s = String(v);
    if (s.trim()) return s;
  }
  return '';
}

/** 找 math500 题集里对应 id 的行（题集键可能是 math500 / math-500；id 别名见 loadDatasets）。
 *  解析顺序**先按行号、再按显式 id**：run-bench 的 id 是按题集文件的物理行号生成的
 *  （`math500#1..N`），而子集文件行内还自带一个继承全量行号的 `id`（`math500#12..500`）——
 *  两者数域会重叠（本次 100 题样本里有 18 个值同时是「某行的行号」和「另一行的显式 id」），
 *  若让显式 id 抢先命中就会拿错题面的 gold。故这里用 byLine 优先。 */
function mathDsRow(data, id) {
  for (const [k, v] of Object.entries(data || {})) {
    if (!/^math[-_]?500$/.test(k)) continue;
    const row = (v.byLine && v.byLine.get(id)) || (v.byId && v.byId.get(id));
    if (row) return row;
  }
  return null;
}

/** MATH-500 的 gold：优先 run 里落的 gold，缺失时按题集文件回查（含从 solution 尾部 \boxed{} 兜底）。
 *  返回 { raw, source }，source ∈ run / dataset-line / dataset-solution / none —— 供审计追踪口径。 */
function mathGoldRaw(gold, dsRow) {
  const run = firstNonEmpty(gold.answer, gold.final_answer, gold.finalAnswer, gold.gold);
  if (run) return { raw: run, source: 'run' };
  const dsGold = dsRow && dsRow.gold && typeof dsRow.gold === 'object' ? dsRow.gold : {};
  const byField = firstNonEmpty(
    dsGold.answer, dsGold.final_answer, dsGold.finalAnswer,
    dsRow && dsRow.answer, dsRow && dsRow.final_answer, dsRow && dsRow.finalAnswer,
  );
  if (byField) return { raw: byField, source: 'dataset-line' };
  const fromSolution = lastBoxed(firstNonEmpty(dsGold.solution, dsRow && dsRow.solution, gold.solution));
  if (fromSolution) return { raw: fromSolution, source: 'dataset-solution' };
  return { raw: '', source: 'none' };
}

/** MATH-500 判分自测：金标准 + 边界用例（等价写法判对、不等价判错），返回进程退出码 */
function runSelftest() {
  const cases = [
    // ---- 等价写法：必须判对 ----
    { name: 'boxed 抽最后一个', gold: '\\boxed{42}', resp: '先算得 \\boxed{7}，修正后答案是 \\boxed{42}。', expect: true, method: 'boxed' },
    { name: 'frac vs 斜线分数', gold: '$\\frac{1}{2}$', resp: 'ANSWER = 1/2', expect: true, method: 'answer-mark' },
    { name: 'dfrac vs 小数', gold: '0.75', resp: '\\boxed{\\dfrac{3}{4}}', expect: true, method: 'boxed' },
    { name: '千分位', gold: '1000', resp: '\\boxed{1,000}', expect: true, method: 'boxed' },
    { name: '百分号', gold: '50', resp: 'The final answer is $50\\%$', expect: true, method: 'answer-is' },
    { name: '美元符', gold: '5', resp: '\\boxed{\\$5}', expect: true, method: 'boxed' },
    { name: 'left right 元组', gold: '\\left(\\frac{1}{2},3\\right)', resp: '\\boxed{(1/2, 3)}', expect: true, method: 'boxed' },
    { name: '集合无序', gold: '\\{1,2,3\\}', resp: '\\boxed{\\{3, 1, 2\\}}', expect: true, method: 'boxed' },
    { name: 'text 包裹', gold: '\\text{blue}', resp: '\\boxed{\\text{blue}}', expect: true, method: 'boxed' },
    { name: '根式化简', gold: '2\\sqrt{3}', resp: '\\boxed{\\sqrt{12}}', expect: true, method: 'boxed' },
    { name: '带分数', gold: '1\\frac{1}{2}', resp: '\\boxed{1.5}', expect: true, method: 'boxed' },
    { name: '幂', gold: '8', resp: '\\boxed{2^3}', expect: true, method: 'boxed' },
    { name: '绝对值', gold: '\\left|-7\\right|', resp: '\\boxed{7}', expect: true, method: 'boxed' },
    { name: '末行兜底', gold: '3', resp: '一堆推理……\n3', expect: true, method: 'last-line' },
    { name: '区间等价（末行兜底）', gold: '\\left[0,1\\right)', resp: '端点开闭都要看。\n[0,1)', expect: true, method: 'last-line' },
    // ---- 以下 8 例全部来自 2026-09-04 fresh4 正式跑的 MATH-500 人工复核（当时四臂同型误判） ----
    { name: '半边花括号 \\frac{270}7', gold: '\\frac{270}7', resp: 'ANSWER = 270/7', expect: true, method: 'answer-mark' },
    { name: 'cup 与 ∪ 且区间内逗号不当千分位', gold: '(2,12) \\cup (12,102)', resp: 'ANSWER = (2, 12) ∪ (12, 102)', expect: true, method: 'answer-mark' },
    { name: '度数符号', gold: '106', resp: 'ANSWER = 106°', expect: true, method: 'answer-mark' },
    { name: '带单位尾巴 gallons', gold: '550', resp: 'ANSWER = 550 gallons', expect: true, method: 'answer-mark' },
    { name: '序数 + 名词尾巴 12th grade', gold: '12', resp: 'ANSWER = 12th grade', expect: true, method: 'answer-mark' },
    { name: '半开区间 + 分数', gold: '\\left(\\frac{3}{5},\\frac{8}{3}\\right]', resp: 'ANSWER = (3/5, 8/3]', expect: true, method: 'answer-mark' },
    { name: 'pmatrix 展平成有序元组', gold: '\\begin{pmatrix} -18 \\\\ -49 \\\\ 96 \\end{pmatrix}', resp: 'ANSWER = (-18, -49, 96)', expect: true, method: 'answer-mark' },
    { name: '上标 unicode ² 与 ^2', gold: '3R^2', resp: 'ANSWER = 3R²', expect: true, method: 'answer-mark' },
    { name: '带分数的空格写法', gold: '1\\frac{4}{5}', resp: 'ANSWER = 1 4/5', expect: true, method: 'answer-mark' },
    { name: 'unicode 减号 −', gold: '-\\frac{3}{8}', resp: 'ANSWER = −3/8', expect: true, method: 'answer-mark' },
    { name: 'LaTeX 千分位 32,\\!348', gold: '\\$32,\\!348', resp: 'ANSWER = 32348', expect: true, method: 'answer-mark' },
    { name: '花括号千分位 1{,}000', gold: '1{,}000', resp: 'ANSWER = 1000', expect: true, method: 'answer-mark' },
    // ---- 区间 / 不等式链互通（审计：只有按不等式链作答的臂被扣分） ----
    { name: '不等式链 vs 半开区间', gold: '(3,4]', resp: 'ANSWER = 3 < λ <= 4', expect: true, method: 'answer-mark' },
    { name: '闭开区间 vs 递增链', gold: '[0,1)', resp: 'ANSWER = 0 <= x < 1', expect: true, method: 'answer-mark' },
    { name: '递减链同样等价', gold: '[3,5)', resp: 'ANSWER = 5 > x >= 3', expect: true, method: 'answer-mark' },
    { name: '开闭性不同必须判错', gold: '(3,4]', resp: 'ANSWER = 3 <= λ <= 4', expect: false, method: 'answer-mark' },
    { name: '非区间链式不算区间', gold: '(3,4]', resp: 'ANSWER = 3 < λ > 4', expect: false, method: 'answer-mark' },
    // ---- 不等价 / 异常：必须判错 ----
    { name: '单元素集合=标量', gold: '\\{5\\}', resp: '\\boxed{5}', expect: true, method: 'boxed' },
    { name: '数值容差不放过小差异', gold: '0.5', resp: '\\boxed{0.51}', expect: false, method: 'boxed' },
    { name: '单位兜底不放过错数', gold: '551', resp: 'ANSWER = 550 gallons', expect: false, method: 'answer-mark' },
    { name: '多答案枚举不算等于单值', gold: '5', resp: 'ANSWER = 5 or 6', expect: false, method: 'answer-mark' },
    { name: '序数尾巴不吃掉真数字', gold: '12', resp: 'ANSWER = 120', expect: false, method: 'answer-mark' },
    { name: '数字不同', gold: '42', resp: '\\boxed{24}', expect: false, method: 'boxed' },
    { name: '有序元组换位', gold: '(1,2)', resp: '\\boxed{(2,1)}', expect: false, method: 'boxed' },
    { name: '分数不同', gold: '\\frac{1}{2}', resp: '\\boxed{\\frac{1}{3}}', expect: false, method: 'boxed' },
    { name: '集合元素数不同', gold: '\\{1,2,3\\}', resp: '\\boxed{\\{1,2\\}}', expect: false, method: 'boxed' },
    { name: '空答复', gold: '3', resp: '   ', expect: false, method: 'empty' },
    { name: '符号残留不等价', gold: '5', resp: '\\boxed{x = 5}', expect: false, method: 'boxed' },
    { name: '集合 vs 有序元组不同序', gold: '\\{1,2\\}', resp: '\\boxed{(3, 1)}', expect: false, method: 'boxed' },
  ];
  let bad = 0;
  for (const c of cases) {
    const g = math500Grade(c.resp, c.gold);
    const okM = !c.method || g.method === c.method;
    const pass = !!g.correct === c.expect && okM;
    if (!pass) {
      bad++;
      console.log(`  ✗ ${c.name}：期望 correct=${c.expect}/method=${c.method}，实际 correct=${g.correct}/method=${g.method}（extracted=${JSON.stringify(g.extracted)} gold=${JSON.stringify(g.gold)}）`);
    }
  }
  console.log(`[score][selftest] MATH-500 判分自测 ${cases.length - bad}/${cases.length} 通过`);
  return bad ? 1 : 0;
}

/* ------------------------------------------------------------------ MMLU 兜底判分（本次未启用） */

/** 选项字母 exact-match：答复里最后一个独立 A/B/C/D（先看 `Answer: X`） */
function mmluGrade(response, goldLetter) {
  const s = String(response ?? '');
  const gold = String(goldLetter ?? '').trim().toUpperCase();
  let m = [...s.matchAll(/(?:answer|答案)\s*[:：]?\s*\(?([A-D])\)?/gi)];
  if (!m.length) m = [...s.matchAll(/\(?([A-D])\)?\s*(?:$|[.,;\n])/g)];
  const picked = m.length ? m[m.length - 1][1].toUpperCase() : '';
  return { correct: !!gold && picked === gold, reason: picked ? (picked === gold ? 'match' : 'value-mismatch') : 'no-answer', extracted: picked || null };
}

/* ------------------------------------------------------------------ HumanEval 判分 */

const FENCE_RE = /```([a-zA-Z0-9_+-]*)[ \t]*\r?\n([\s\S]*?)```/g;

/** 抽代码：优先取「定义了 entry_point 的最长 fenced 块」；没有就取最长 fenced 块；再没有就裸代码 */
function extractPython(response, entryPoint) {
  const s = String(response ?? '');
  if (!s.trim()) return { code: '', method: 'empty', blocks: 0 };
  const blocks = [];
  for (const m of s.matchAll(FENCE_RE)) {
    const lang = (m[1] || '').toLowerCase();
    if (lang && !['python', 'py', 'python3'].includes(lang)) continue;
    const body = m[2].replace(/\s+$/, '');
    if (body.trim()) blocks.push(body);
  }
  const defines = (c) => new RegExp(`(^|\\n)\\s*def\\s+${escapeRe(entryPoint)}\\s*\\(`).test(c);
  if (blocks.length) {
    const good = blocks.filter(defines).sort((a, b) => b.length - a.length);
    if (good.length) return { code: good[0], method: good.length === blocks.length && blocks.length === 1 ? 'single-fence' : 'fence-pick', blocks: blocks.length, formatOk: blocks.length === 1 };
    const longest = blocks.slice().sort((a, b) => b.length - a.length)[0];
    return { code: longest, method: 'fence-no-entry', blocks: blocks.length, formatOk: false };
  }
  if (defines(s)) return { code: s.replace(/\s+$/, ''), method: 'bare-code', blocks: 0, formatOk: false };
  /* 无围栏也没签名：可能只给了函数体（缩进块），拼在官方 prompt 后面仍可能可跑 */
  const indented = s.split(/\r?\n/).filter((l) => l.trim()).every((l) => /^[ \t]/.test(l));
  if (indented) return { code: s.replace(/\s+$/, ''), method: 'indented-body', blocks: 0, formatOk: false };
  return { code: '', method: 'no-code', blocks: 0, formatOk: false };
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 组装可执行程序：官方 prompt（imports + helper defs + 目标签名与 docstring）+ 模型代码 + 官方 test + check 调用 */
function buildProgram(prompt, completion, test, entryPoint) {
  const head = String(prompt || '').replace(/\s+$/, '');
  const body = String(completion || '').replace(/\s+$/, '');
  const tst = String(test || '').replace(/\s+$/, '');
  const usesCheck = /def\s+check\s*\(/.test(tst);
  return [head, body, tst, usesCheck ? `check(${entryPoint})` : ''].join('\n\n') + '\n';
}

function classifyPythonFailure(stderr, timedOut, exitCode) {
  const s = String(stderr || '');
  if (timedOut) return 'exec-timeout';
  if (/SyntaxError/.test(s)) return 'syntax-error';
  if (/IndentationError/.test(s)) return 'indentation-error';
  if (/NameError/.test(s)) return 'name-error';
  if (/ImportError|ModuleNotFoundError/.test(s)) return 'import-error';
  if (/AssertionError/.test(s)) return 'assertion-failed';
  if (/RecursionError/.test(s)) return 'recursion-error';
  if (/MemoryError/.test(s)) return 'memory-error';
  if (/ZeroDivisionError|TypeError|ValueError|IndexError|AttributeError/.test(s)) return 'runtime-error';
  if (/SystemExit/.test(s)) return 'sys-exit';
  return exitCode === 0 ? 'unknown' : `exit-${exitCode}`;
}

/** 本机 python 探测：--python auto → python / py -3 / python3（WindowsApps 的 stub 也能用） */
function resolvePython(spec) {
  if (String(spec).toLowerCase() === 'none') return null;
  const tryRun = (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    return r.status === 0;
  };
  const tail = (txt) => String(txt || '').split(/\r?\n/).filter(Boolean).slice(-2).join(' | ');
  if (spec && spec !== 'auto') {
    if (!tryRun(spec, ['-c', 'print(1)'])) fail(`--python ${spec} 不可用`);
    const v = spawnSync(spec, ['-V'], { encoding: 'utf8', windowsHide: true });
    return { cmd: spec, args: [], version: tail(v.stdout || v.stderr) };
  }
  for (const [cmd, args] of [['python', []], ['py', ['-3']], ['python3', []]]) {
    if (tryRun(cmd, [...args, '-c', 'print(1)'])) {
      const v = spawnSync(cmd, [...args, '-V'], { encoding: 'utf8', windowsHide: true });
      return { cmd, args, version: tail(v.stdout || v.stderr) };
    }
  }
  return null;
}

/** 跑一个程序，返回 {ok, exitCode, stderrTail, timedOut, ms} */
function runPython(py, file, timeoutSec) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let timedOut = false;
    const child = spawn(py.cmd, [...py.args, file], {
      cwd: path.dirname(file),
      windowsHide: true,
      env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    child.stdout.resume();
    child.stderr.on('data', (d) => {
      err += String(d);
      if (err.length > 20000) err = err.slice(-20000); // 只要尾部 traceback
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, Math.round(timeoutSec * 1000));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, exitCode: -1, stderrTail: `spawn failed: ${e.message}`, timedOut: false, ms: Date.now() - t0 });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const tail = err.split(/\r?\n/).filter(Boolean).slice(-6).join('\n');
      resolve({ ok: code === 0 && !timedOut, exitCode: code, stderrTail: tail, timedOut, ms: Date.now() - t0 });
    });
  });
}

/** 简单并发池：跑一批任务，最多 n 个同时在飞 */
async function pool(items, n, worker) {
  const out = new Array(items.length);
  let i = 0;
  const runners = Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const k = i++;
      if (k >= items.length) return;
      out[k] = await worker(items[k], k);
    }
  });
  await Promise.all(runners);
  return out;
}

/* ------------------------------------------------------------------ 统计 */

/** McNemar 精确检验（配对二分类）：b = A 对 B 错，c = A 错 B 对；双侧精确二项 p 值 */
function mcnemarExact(b, c) {
  const n = b + c;
  if (!n) return { b: 0, c: 0, n: 0, chi2: 0, pValue: 1, note: '无不一致对，检验无定义' };
  const k = Math.min(b, c);
  let tail = 0;
  let coef = 1; // C(n, 0)
  for (let i = 0; i <= k; i++) {
    if (i > 0) coef = (coef * (n - i + 1)) / i;
    tail += coef;
  }
  const p = Math.min(1, 2 * tail / 2 ** n);
  const chi2 = (Math.abs(b - c) - 1) ** 2 / n;
  return { b, c, n, chi2: round(chi2, 3), pValue: round(p, 6), note: '精确二项（小样本用精确而非卡方）' };
}

/** 配对 bootstrap：对「题目」重采样，统计 B - A 成功率差值的 95% CI */
function pairedBootstrap(pairs, reps, seed) {
  const n = pairs.length;
  if (!n) return { reps: 0, n: 0, delta: 0, ci95: [0, 0], bBetterProb: 0 };
  const r = rng(seed);
  const deltas = [];
  let bBetter = 0;
  for (let s = 0; s < reps; s++) {
    let a = 0;
    let b = 0;
    for (let i = 0; i < n; i++) {
      const p = pairs[Math.floor(r() * n)];
      a += p.a;
      b += p.b;
    }
    const d = (b - a) / n;
    deltas.push(d);
    if (d > 0) bBetter++;
  }
  deltas.sort((x, y) => x - y);
  const obs = (sum(pairs.map((p) => p.b)) - sum(pairs.map((p) => p.a))) / n;
  return {
    reps,
    n,
    delta: round(obs, 4),
    ci95: [round(quantile(deltas, 0.025), 4), round(quantile(deltas, 0.975), 4)],
    bBetterProb: round(bBetter / reps, 4),
    note: '差值 = B(对比臂) - A(基准臂) 的成功题占比；CI 不含 0 才可称显著',
  };
}

/** 配对节省率：(A - B) / A，>0 表示 B 更省。labels 用实际臂名，避免把 standard/lean 写死进产物 */
function pairedSaving(aVals, bVals, labelA = 'a', labelB = 'b') {
  const ratios = [];
  let bLower = 0;
  for (let i = 0; i < aVals.length; i++) {
    const a = aVals[i];
    const b = bVals[i];
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0) continue;
    ratios.push((a - b) / a);
    if (b < a) bLower++;
  }
  const sa = sum(aVals.filter(Number.isFinite));
  const sb = sum(bVals.filter(Number.isFinite));
  return {
    n: ratios.length,
    aggregateRatio: sa > 0 ? round((sa - sb) / sa, 4) : 0,
    perProblemMean: round(mean(ratios), 4),
    perProblemMedian: round(quantile(ratios, 0.5), 4),
    perProblemP10: round(quantile(ratios, 0.1), 4),
    perProblemP90: round(quantile(ratios, 0.9), 4),
    bLowerCount: bLower,
    bEqualOrHigherCount: ratios.length - bLower,
    totals: { [labelA]: round(sa, 0), [labelB]: round(sb, 0) },
  };
}

function tokenPack(rec) {
  const u = rec.usage || {};
  const input = num(u.inputTokens);
  const cacheRead = num(u.cacheReadTokens);
  const cacheWrite = num(u.cacheWriteTokens);
  const output = num(u.outputTokens);
  const reasoning = num(u.reasoningTokens);
  return {
    input,
    cacheRead,
    cacheWrite,
    output,
    reasoning,
    answerTokens: output - reasoning, // output 含 reasoning（服务商口径），正文 = 差值
    promptTotal: input + cacheRead + cacheWrite,
    total: input + cacheRead + cacheWrite + output,
    nonCached: input + output,
    calls: num(u.calls),
  };
}

function costOf(tp, price) {
  return (tp.input * price.input + tp.cacheRead * price.cacheHit + tp.cacheWrite * price.cacheWrite + tp.output * price.output) / 1e6;
}

/* ------------------------------------------------------------------ 载入结果 */

function loadRun(opt) {
  const runDir = path.join(opt.benchRoot, 'runs', opt.run);
  const metaFile = path.join(runDir, 'run-meta.json');
  const resFile = path.join(runDir, 'results.jsonl');
  if (!fs.existsSync(metaFile)) fail(`缺少 ${metaFile}（先用 run-bench.mjs 跑出一个 run）`);
  if (!fs.existsSync(resFile)) fail(`缺少 ${resFile}`);
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  if (meta.v !== SCHEMA) fail(`run-meta 版本不符：${meta.v}（期望 ${SCHEMA}）`);
  if (!fs.existsSync(resFile)) fail(`缺少 ${resFile}`);
  const outDir = opt.out || runDir;
  return { runDir, metaFile, resFile, meta, outDir };
}

/** 断点续跑语义：判分取 (dataset,id,arm) 的**最后一条**且非 warmup；成本取全部尝试之和 */
function indexResults(rows, arms) {
  const last = new Map(); // `${dataset}\u0000${id}\u0000${arm}` -> row
  const attempts = new Map(); // 同 key -> 所有尝试行（含失败重跑）
  let warmup = 0;
  for (const r of rows) {
    if (r.warmup || r.dataset === 'warmup') {
      warmup++;
      continue;
    }
    if (!arms.includes(r.arm)) continue;
    const k = `${r.dataset}\u0000${r.id}\u0000${r.arm}`;
    last.set(k, r);
    if (!attempts.has(k)) attempts.set(k, []);
    attempts.get(k).push(r);
  }
  return { last, attempts, warmup, scored: rows.length - warmup };
}

/** 读题集（只为补 humaneval 的 prompt 与 gsm8k 的题面），并校验与 run-meta 的 sha256 一致 */
function loadDatasets(meta, opt) {
  const out = {};
  for (const [key, d] of Object.entries(meta.datasets || {})) {
    if (!fs.existsSync(d.file)) fail(`题集文件不存在：${d.file}\n         先用 node scripts/bench/fetch-data.mjs 重新下载`);
    const actual = sha256File(d.file);
    if (d.sha256 && actual !== d.sha256) {
      fail(`题集 sha256 与 run-meta 不符：${key}\n  记录 ${d.sha256}\n  实际 ${actual}\n  → 判分与跑题不是同一份数据，拒绝继续（可用 --out 换目录后重跑）`);
    }
    const byId = new Map();
    const byLine = new Map(); // `<key>#<物理行号>` -> 行（run-bench 的 id 就是这个口径，必须优先于行内自带 id）
    for (const { obj } of readJsonlWithLine(d.file)) {
      byLine.set(`${key}#${obj._line}`, obj);
      /* 题集自带稳定 id（如 math500#<全量行号>）后登记，避免占用行号槽位 */
      const aliases = new Set([
        key === 'gsm8k' ? `gsm8k#${obj._line}` : String(obj.task_id || ''),
        `${key}#${obj._line}`,
        obj.id ? String(obj.id) : '',
        /^math[-_]?500$/.test(key) ? `math500#${obj._line}` : '',
      ].filter(Boolean));
      for (const a of aliases) if (!byId.has(a)) byId.set(a, obj);
    }
    out[key] = { file: d.file, sha256: actual, bytes: fs.statSync(d.file).size, byId, byLine };
  }
  return out;
}

function readJsonlWithLine(file) {
  /* 行号语义与 run-bench.mjs 的 readJsonl 严格一致（只数非空行的序号）：
     gsm8k 的题目 id 是 `gsm8k#<_line>`，序号对不上就找不到 gold —— 所以这里必须同规则。 */
  const out = [];
  let text = fs.readFileSync(file, 'utf8');
  let i = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    i += 1;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      fail(`${file} 第 ${i} 行不是合法 JSON`);
    }
    obj._line = i;
    out.push({ obj });
  }
  return out;
}

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.selftest) process.exit(runSelftest());
  const { meta, runDir, outDir, resFile } = loadRun(opt);
  ensureDir(outDir);

  const arms = opt.arms && opt.arms.length ? opt.arms : (meta.arms || []).map((a) => a.arm);
  if (arms.length !== 2) fail(`本判分器做两臂配对对比，当前只识别到 ${arms.length} 臂（${arms.join(', ')}）`);
  const [armA, armB] = arms; // A = 基准（standard），B = 对比（lean）

  const datasets = opt.datasets && opt.datasets.length ? opt.datasets : Object.keys(meta.datasets || {});
  const data = loadDatasets(meta, opt);

  const rows = readJsonl(resFile);
  const { last, attempts, warmup, scored } = indexResults(rows, arms);
  /* 价目先解析：--price-* / --price-json 的覆盖要落到每条记录的逐次成本上，
     而不是只在聚合阶段乘一遍（否则成本列与 token 列口径不一致）。 */
  const prices = buildPrices(opt);

  /* ---- 逐题判分 ---- */
  const records = []; // 每题每臂一条
  const byPair = new Map(); // `${dataset}|${id}` -> { [arm]: record }
  const heJobs = [];
  const mathReview = []; // MATH-500 未判对的题：落一份可复核产物（原题 gold + 模型答复全文）

  for (const key of last.keys()) {
    const [dataset, id, arm] = key.split('\u0000');
    if (!datasets.includes(dataset)) continue;
    const row = last.get(key);
    const all = attempts.get(key) || [row];
    const tp = tokenPack(row);
    const cost = {
      peak: sum(all.map((r) => costOf(tokenPack(r), prices.peak))),
      offPeak: sum(all.map((r) => costOf(tokenPack(r), prices.offPeak))),
      attempts: all.length,
    };
    const dsFileRow = (row.metrics && row.metrics.turns) || 0;
    const rec = {
      dataset,
      id,
      arm,
      preset: row.preset,
      status: row.status,
      error: row.error || '',
      timedOut: !!row.timedOut,
      responseChars: String(row.finalResponse ?? '').length,
      emptyResponse: !String(row.finalResponse ?? '').trim(),
      turns: dsFileRow,
      steps: num(row.metrics && row.metrics.steps),
      toolCalls: num(row.metrics && row.metrics.tools ? row.metrics.tools.length : row.streamed && row.streamed.toolCalls),
      toolNames: (row.metrics && row.metrics.tools) || [],
      interactions: row.interactions || {},
      wallMs: num(row.metrics && row.metrics.wallMs),
      runnerWallMs: num(row.runnerWallMs),
      llmMs: num(row.metrics && row.metrics.llmMs),
      firstTokenMs: num(row.metrics && row.metrics.firstTokenAvgMs),
      tokPerSec: num(row.metrics && row.metrics.tokPerSec),
      cacheHitPct: num(row.metrics && row.metrics.cacheHitPct),
      tokens: tp,
      cost,
      correct: null,
      gradeReason: '',
      extracted: null,
      goldValue: null,
      method: '',
      formatOk: null,
      execMs: null,
      artifact: '',
    };
    records.push(rec);
    const pk = `${dataset}|${id}`;
    if (!byPair.has(pk)) byPair.set(pk, {});
    byPair.get(pk)[arm] = rec;

    const gold = row.gold || {};
    if (dataset === 'gsm8k') {
      const g = gsm8kGrade(row.finalResponse, gold.answer);
      rec.correct = g.correct;
      rec.gradeReason = g.reason;
      rec.extracted = g.extracted;
      rec.goldValue = g.gold ?? null;
      rec.method = g.method;
      rec.formatOk = g.method === 'hash-mark';
    } else if (dataset === 'humaneval') {
      const dsRow = data.humaneval ? data.humaneval.byId.get(id) : null;
      const prompt = dsRow ? String(dsRow.prompt || '') : '';
      const entryPoint = String(gold.entry_point || (dsRow && dsRow.entry_point) || '');
      const test = String(gold.test || (dsRow && dsRow.test) || '');
      const ex = extractPython(row.finalResponse, entryPoint);
      rec.method = ex.method;
      rec.formatOk = ex.method === 'single-fence' ? true : !!ex.formatOk;
      rec.extracted = ex.code ? `${ex.code.length} chars` : null;
      rec.goldValue = entryPoint || null;
      if (!ex.code || !prompt || !test || !entryPoint) {
        rec.correct = false;
        rec.gradeReason = !ex.code ? (ex.method === 'empty' ? 'empty-response' : 'no-code') : !prompt ? 'missing-official-prompt' : 'missing-official-test';
      } else {
        heJobs.push({ rec, ex, prompt, test, entryPoint });
      }
    } else if (dataset === 'math500' || dataset === 'math-500' || dataset === 'math') {
      const dsRow = mathDsRow(data, id);
      const gm = mathGoldRaw(gold, dsRow);
      const g = math500Grade(row.finalResponse, gm.raw);
      rec.goldSource = gm.source;
      rec.correct = g.correct;
      rec.gradeReason = g.reason;
      rec.extracted = g.extracted;
      rec.goldValue = g.gold ?? null;
      rec.method = g.method;
      /* 题面要求末行 `ANSWER = …`，数据集原生是 \boxed{} —— 两者都算格式合规（与 gsm8k 的 #### 同地位） */
      rec.formatOk = g.method === 'boxed' || g.method === 'answer-mark';
      if (g.correct !== true) mathReview.push({ rec, goldRaw: gm.raw, response: String(row.finalResponse ?? '') });
    } else if (dataset === 'mmlu') {
      const g = mmluGrade(row.finalResponse, gold.answer || gold.letter);
      rec.correct = g.correct;
      rec.gradeReason = g.reason;
      rec.extracted = g.extracted;
      rec.goldValue = gold.answer || gold.letter || null;
      rec.method = 'letter';
    }
  }

  if (!records.length) fail('没有可判分的记录（检查 --dataset / --arms）');

  /* ---- HumanEval 执行 ---- */
  const py = resolvePython(opt.python);
  let heExecuted = 0;
  if (heJobs.length && !py) {
    for (const j of heJobs) {
      j.rec.correct = null;
      j.rec.gradeReason = 'python-unavailable';
    }
  } else if (heJobs.length) {
    const heDir = path.join(outDir, 'humaneval');
    ensureDir(heDir);
    const started = Date.now();
    await pool(heJobs, opt.heParallel, async (j) => {
      const dir = path.join(heDir, safeName(j.rec.arm));
      ensureDir(dir);
      const file = path.join(dir, `${safeName(j.rec.id)}.py`);
      const prog = buildProgram(j.prompt, j.ex.code, j.test, j.entryPoint);
      fs.writeFileSync(file, prog, 'utf8');
      const res = await runPython(py, file, opt.heTimeoutSec);
      j.rec.correct = res.ok;
      j.rec.execMs = res.ms;
      j.rec.artifact = file;
      if (res.ok) {
        j.rec.gradeReason = 'pass';
      } else {
        const cls = classifyPythonFailure(res.stderrTail, res.timedOut, res.exitCode);
        j.rec.gradeReason = cls;
        j.rec.errorTail = res.stderrTail.slice(0, 800);
      }
    });
    heExecuted = heJobs.length;
    if (!opt.heArtifacts) fs.rmSync(heDir, { recursive: true, force: true });
    console.log(`[score] HumanEval 执行 ${heExecuted} 个程序，用时 ${((Date.now() - started) / 1000).toFixed(1)}s（并发 ${opt.heParallel}，单题上限 ${opt.heTimeoutSec}s）`);
  }

  /* ---- MATH-500 可复核产物：未判为对的题保留 gold 原文 + 抽取结果 + 模型答复全文 ---- */
  let mathArtifacts = 0;
  if (mathReview.length && opt.heArtifacts) {
    const dir = path.join(outDir, 'math500');
    for (const j of mathReview) {
      const sub = path.join(dir, safeName(j.rec.arm));
      ensureDir(sub);
      const file = path.join(sub, `${safeName(j.rec.id)}.md`);
      fs.writeFileSync(file, [
        `# ${j.rec.id} · ${j.rec.arm}`,
        '',
        `- 判定：${j.rec.correct ? 'correct' : 'wrong'}（${j.rec.gradeReason}）`,
        `- 抽取方法：${j.rec.method || 'none'}`,
        `- gold 归一：${j.rec.goldValue ?? '(unparsable)'}`,
        `- 抽取归一：${j.rec.extracted ?? '(none)'}`,
        '',
        '## gold 原文',
        '',
        '```',
        j.goldRaw,
        '```',
        '',
        '## 模型答复全文',
        '',
        '```',
        j.response || '(empty)',
        '```',
        '',
      ].join('\n'), 'utf8');
      j.rec.artifact = file;
      mathArtifacts++;
    }
    console.log(`[score] MATH-500 未判对 ${mathArtifacts} 题，可复核产物：${dir}`);
  }

  /* ---- 聚合 ---- */
  const scopes = [];
  for (const d of new Set(records.map((r) => r.dataset))) scopes.push(d);
  scopes.push('ALL');

  const armStats = {};
  for (const arm of arms) {
    armStats[arm] = {};
    for (const scope of scopes) {
      const rs = records.filter((r) => r.arm === arm && (scope === 'ALL' || r.dataset === scope));
      armStats[arm][scope] = aggregateArm(rs, arm, scope, prices, opt);
    }
  }

  /* ---- 配对分析 ---- */
  const paired = {};
  for (const scope of scopes) {
    const ids = [...byPair.entries()]
      .filter(([k, v]) => (scope === 'ALL' || k.startsWith(`${scope}|`)) && v[armA] && v[armB])
      .map(([, v]) => v);
    paired[scope] = analyzePair(ids, armA, armB, opt);
  }

  const skipped = records.filter((r) => r.correct === null);
  const results = {
    v: 'mtnode-bench-score/1',
    generatedAt: new Date().toISOString(),
    repo: REPO_ROOT,
    run: meta.run,
    runDir,
    outDir,
    scoringSchema: SCHEMA,
    arms: { base: armA, compare: armB, definition: meta.arms },
    model: meta.model,
    provider: meta.provider,
    baseUrl: meta.baseUrl,
    permissionPreset: meta.permissionPreset,
    effortRequested: (meta.arms || []).find((a) => a.arm === armA)?.effort || meta.effort || 'high',
    concurrency: meta.concurrency,
    timeoutMs: meta.timeoutMs,
    seed: meta.seed,
    sample: meta.sample,
    datasets: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, { file: v.file, sha256: v.sha256, bytes: v.bytes }])),
    problems: meta.problems,
    rows: { total: rows.length, warmup, scored, graded: records.length, skippedGrading: skipped.length },
    resume: { note: '判分取 (dataset,id,arm) 最后一条且 warmup!=true；成本把该题所有尝试（含失败重跑）求和' },
    tokenSemantics: {
      inputTokens: 'prompt_tokens - cached_tokens（不含缓存读）',
      cacheReadTokens: '缓存命中的 prompt token',
      outputTokens: 'completion_tokens，**包含** reasoningTokens',
      total: 'input + cacheRead + cacheWrite + output',
      nonCached: 'input + output（去掉缓存读的真实新增上下文）',
      source: 'dsh/gateway/node_modules/@deepseek-ai/dsh-llm-deepseek mapUsage + gateway.mjs 统计分支',
    },
    grading: {
      gsm8k: '最终数值 exact-match（#### → \\boxed → answer is → 最后一个数；归一去逗号/货币符/\\frac）',
      math500: 'MATH 口径答案等价性：抽取优先级 \\boxed → ANSWER = → final answer is → 末行；'
        + '归一去 $ / \\left \\right / \\text、\\dfrac→\\frac、千分位与百分号；'
        + '可解析数值走数值相等（相对容差 1e-6），集合/元组/列表按元素递归比较（{} 无序、()[] 有序），其余空白与符号规范化后全等',
      humaneval: `pass@1：官方 prompt + 模型代码 + 官方 test + check(entry_point)，本机 python 执行，退出码 0 记 pass。python=${py ? py.cmd : 'none'} ${py ? py.version : ''}`.trim(),
      mmlu: '选项字母 exact-match（兜底集，本次未启用）',
      emptyResponsePolicy: '空答复 / 抽不出可判内容一律记失败（真实产品风险，不在评分里抹平）',
      heTimeoutSec: opt.heTimeoutSec,
      heExecuted,
      mathReviewArtifacts: mathArtifacts,
    },
    prices,
    definitions: {
      wallMs: '网关 done.metrics.wallMs（一次运行的端到端）',
      runnerWallMs: 'runner 宿主侧墙钟（含协议往返与槽位调度）',
      firstTokenAvgMs: '网关多步首字延平均',
      cost: 'token × 价目；单位见 prices.currency；两臂成本都含失败重跑',
    },
    stats: armStats,
    paired,
    perProblem: records.map((r) => ({
      dataset: r.dataset,
      id: r.id,
      arm: r.arm,
      correct: r.correct,
      gradeReason: r.gradeReason,
      extracted: r.extracted,
      goldValue: r.goldValue,
      method: r.method,
      formatOk: r.formatOk,
      emptyResponse: r.emptyResponse,
      status: r.status,
      wallMs: r.wallMs,
      tokens: r.tokens,
      cost: { peak: round(r.cost.peak, 6), offPeak: round(r.cost.offPeak, 6), attempts: r.cost.attempts },
    })),
  };

  /* ---- 落盘 ---- */
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2), 'utf8');
  fs.writeFileSync(path.join(outDir, 'results.csv'), toCsv(perProblemRows(records)), 'utf8');
  fs.writeFileSync(path.join(outDir, 'summary.csv'), toCsv(summaryRows(armStats, paired, arms, scopes)), 'utf8');
  fs.writeFileSync(
    path.join(outDir, 'scores.jsonl'),
    records
      .slice()
      .sort((a, b) => a.dataset.localeCompare(b.dataset) || a.id.localeCompare(b.id) || a.arm.localeCompare(b.arm))
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
    'utf8',
  );

  if (!opt.quiet) printSummary(results, records, arms, armA, armB, scopes);
  console.log(`[score] 产物：${path.join(outDir, 'results.json')} 等 4 个文件（均在仓库外）`);
}

function safeName(s) {
  return String(s).replace(/[^A-Za-z0-9._-]+/g, '_');
}

function buildPrices(opt) {
  const base = opt.priceJson ? JSON.parse(fs.readFileSync(opt.priceJson, 'utf8')) : JSON.parse(JSON.stringify(DEFAULT_PRICES));
  const merge = (mode) => {
    const p = base[mode] || {};
    if (Number.isFinite(opt.priceIn)) p.input = opt.priceIn;
    if (Number.isFinite(opt.priceCache)) p.cacheHit = opt.priceCache;
    if (Number.isFinite(opt.priceOut)) p.output = opt.priceOut;
    p.cacheWrite = num(p.cacheWrite);
    return p;
  };
  base.peak = merge('peak');
  base.offPeak = merge('offPeak');
  base.mode = opt.priceMode;
  base.headline = opt.priceMode === 'offpeak' ? 'offPeak' : 'peak'; // 主口径
  return base;
}

function aggregateArm(rs, arm, scope, prices, opt) {
  const head = prices[prices.headline];
  const graded = rs.filter((r) => r.correct !== null);
  const correct = graded.filter((r) => r.correct === true);
  const tokens = rs.map((r) => r.tokens);
  const out = {
    arm,
    scope,
    n: rs.length,
    graded: graded.length,
    skippedGrading: rs.length - graded.length,
    correct: correct.length,
    successRate: graded.length ? round(correct.length / graded.length, 4) : 0,
    successRatePct: graded.length ? pct(correct.length / graded.length) : 0,
    failedRuns: rs.filter((r) => r.status !== 'ok').length,
    timedOutRuns: rs.filter((r) => r.timedOut).length,
    totalAttempts: sum(rs.map((r) => r.cost.attempts)),
    emptyResponses: rs.filter((r) => r.emptyResponse).length,
    formatOkRate: rs.every((r) => r.formatOk === null) ? null : round(mean(rs.filter((r) => r.formatOk !== null).map((r) => (r.formatOk ? 1 : 0))), 4),
    toolCallRuns: rs.filter((r) => r.toolCalls > 0).length,
    toolCallsTotal: sum(rs.map((r) => r.toolCalls)),
    stepsGt1Runs: rs.filter((r) => r.steps > 1).length,
    stepsGt1Rate: rs.length ? round(rs.filter((r) => r.steps > 1).length / rs.length, 4) : 0,
    /* 抽取方法分布：判分是逐级兜底的（#### → boxed → answer is → 最后一个数；
       single-fence → 多块 → 裸代码）。不看这分布，就可能把「没写代码块」误读成「不会写代码」。 */
    gradeMethodDist: (() => {
      const dist = {};
      for (const r of rs) {
        const k = r.dataset === 'humaneval' ? `he:${r.method || 'none'}` : `${r.dataset}:${r.method || 'none'}`;
        dist[k] = (dist[k] || 0) + 1;
      }
      return dist;
    })(),
    interactions: {
      question: sum(rs.map((r) => num(r.interactions && r.interactions.question))),
      approval: sum(rs.map((r) => num(r.interactions && r.interactions.approval))),
    },
    tokens: {
      total: describe(tokens.map((t) => t.total)),
      nonCached: describe(tokens.map((t) => t.nonCached)),
      input: describe(tokens.map((t) => t.input)),
      cacheRead: describe(tokens.map((t) => t.cacheRead)),
      output: describe(tokens.map((t) => t.output)),
      reasoning: describe(tokens.map((t) => t.reasoning)),
      answerOnly: describe(tokens.map((t) => t.answerTokens)),
      sums: {
        total: sum(tokens.map((t) => t.total)),
        nonCached: sum(tokens.map((t) => t.nonCached)),
        input: sum(tokens.map((t) => t.input)),
        cacheRead: sum(tokens.map((t) => t.cacheRead)),
        output: sum(tokens.map((t) => t.output)),
        reasoning: sum(tokens.map((t) => t.reasoning)),
        answerOnly: sum(tokens.map((t) => t.answerTokens)),
      },
    },
    wallMs: {
      gateway: describe(rs.map((r) => r.wallMs)),
      runner: describe(rs.map((r) => r.runnerWallMs)),
      firstTokenMs: describe(rs.map((r) => r.firstTokenMs)),
      llmMs: describe(rs.map((r) => r.llmMs)),
      steps: describe(rs.map((r) => r.steps)),
      over15s: rs.filter((r) => r.wallMs > 15000).length,
      over30s: rs.filter((r) => r.wallMs > 30000).length,
    },
    cost: {
      headline: prices.headline,
      unit: `${prices.currency}/${prices.unit}`,
      total: round(sum(rs.map((r) => (prices.headline === 'offPeak' ? r.cost.offPeak : r.cost.peak))), 6),
      totalOffPeak: round(sum(rs.map((r) => r.cost.offPeak)), 6),
      totalPeak: round(sum(rs.map((r) => r.cost.peak)), 6),
      perProblem: round(sum(rs.map((r) => (prices.headline === 'offPeak' ? r.cost.offPeak : r.cost.peak))) / (rs.length || 1), 6),
      perCorrectProblem: round(sum(rs.map((r) => (prices.headline === 'offPeak' ? r.cost.offPeak : r.cost.peak))) / (correct.length || 1), 6),
      tokensPerCorrect: round(sum(tokens.map((t) => t.total)) / (correct.length || 1), 1),
    },
    failureBreakdown: breakdown(rs),
  };
  return out;
}

function breakdown(rs) {
  const out = {};
  for (const r of rs) {
    const k = r.correct === true ? 'pass' : r.correct === null ? `skip:${r.gradeReason}` : r.gradeReason || 'unknown';
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

function analyzePair(pairObjs, armA, armB, opt) {
  const n = pairObjs.length;
  const scorable = pairObjs.filter((v) => v[armA].correct !== null && v[armB].correct !== null);
  let both = 0;
  let neither = 0;
  let b = 0;
  let c = 0;
  const bootPairs = [];
  for (const v of scorable) {
    const a = v[armA].correct ? 1 : 0;
    const bb = v[armB].correct ? 1 : 0;
    if (a && bb) both++;
    else if (!a && !bb) neither++;
    else if (a && !bb) b++;
    else c++;
    bootPairs.push({ a, b: bb });
  }
  const rateA = both + b;
  const rateB = both + c;
  const pick = (arm, fn) => pairObjs.map((v) => (v[arm] ? fn(v[arm]) : NaN));
  return {
    n,
    pairedGraded: scorable.length,
    success: {
      [armA]: rateA,
      [armB]: rateB,
      rateA: scorable.length ? round(rateA / scorable.length, 4) : 0,
      rateB: scorable.length ? round(rateB / scorable.length, 4) : 0,
      deltaProblems: rateB - rateA,
    },
    agreement: {
      bothCorrect: both,
      bothWrong: neither,
      [`${armA}Only`]: b,
      [`${armB}Only`]: c,
    },
    mcnemar: mcnemarExact(b, c),
    bootstrap: pairedBootstrap(bootPairs, opt.bootstrap, opt.seed),
    tokenSaving: pairedSaving(pick(armA, (r) => r.tokens.total), pick(armB, (r) => r.tokens.total), armA, armB),
    nonCachedTokenSaving: pairedSaving(pick(armA, (r) => r.tokens.nonCached), pick(armB, (r) => r.tokens.nonCached), armA, armB),
    outputTokenSaving: pairedSaving(pick(armA, (r) => r.tokens.output), pick(armB, (r) => r.tokens.output), armA, armB),
    reasoningTokenSaving: pairedSaving(pick(armA, (r) => r.tokens.reasoning), pick(armB, (r) => r.tokens.reasoning), armA, armB),
    wallSaving: pairedSaving(pick(armA, (r) => r.wallMs), pick(armB, (r) => r.wallMs), armA, armB),
    costSaving: pairedSaving(pick(armA, (r) => r.cost.peak), pick(armB, (r) => r.cost.peak), armA, armB),
  };
}

/* ------------------------------------------------------------------ CSV */

function perProblemRows(records) {
  const head = [
    'dataset', 'id', 'arm', 'preset', 'correct', 'gradeReason', 'method', 'formatOk', 'emptyResponse', 'status',
    'goldValue', 'extracted', 'responseChars', 'wallMs', 'runnerWallMs', 'firstTokenMs', 'llmMs', 'steps', 'toolCalls', 'cacheHitPct',
    'tok_input', 'tok_cacheRead', 'tok_output', 'tok_reasoning', 'tok_answer', 'tok_total', 'tok_nonCached',
    'cost_peak', 'cost_offPeak', 'attempts', 'errorTail',
  ];
  const rows = records
    .slice()
    .sort((a, b) => a.dataset.localeCompare(b.dataset) || a.id.localeCompare(b.id) || a.arm.localeCompare(b.arm))
    .map((r) => ({
      dataset: r.dataset,
      id: r.id,
      arm: r.arm,
      preset: r.preset,
      correct: r.correct === null ? '' : r.correct ? '1' : '0',
      gradeReason: r.gradeReason,
      method: r.method,
      formatOk: r.formatOk === null ? '' : r.formatOk ? '1' : '0',
      emptyResponse: r.emptyResponse ? '1' : '0',
      status: r.status,
      goldValue: r.goldValue ?? '',
      extracted: r.extracted ?? '',
      responseChars: r.responseChars,
      wallMs: r.wallMs,
      runnerWallMs: r.runnerWallMs,
      firstTokenMs: r.firstTokenMs,
      llmMs: r.llmMs,
      steps: r.steps,
      toolCalls: r.toolCalls,
      cacheHitPct: round(r.cacheHitPct, 2),
      tok_input: r.tokens.input,
      tok_cacheRead: r.tokens.cacheRead,
      tok_output: r.tokens.output,
      tok_reasoning: r.tokens.reasoning,
      tok_answer: r.tokens.answerTokens,
      tok_total: r.tokens.total,
      tok_nonCached: r.tokens.nonCached,
      cost_peak: round(r.cost.peak, 6),
      cost_offPeak: round(r.cost.offPeak, 6),
      attempts: r.cost.attempts,
      errorTail: String(r.errorTail || r.error || '').replace(/\s+/g, ' ').slice(0, 200),
    }));
  return { head, rows };
}

function summaryRows(armStats, paired, arms, scopes) {
  const [armA, armB] = arms;
  const head = ['scope', 'metric', armA, armB, 'delta_B_minus_A', 'ratio_B_over_A', 'note'];
  const rows = [];
  const push = (scope, metric, a, b, note = '') => {
    const delta = Number.isFinite(a) && Number.isFinite(b) ? round(b - a, 4) : '';
    const ratio = Number.isFinite(a) && Number.isFinite(b) && a !== 0 ? round(b / a, 4) : '';
    rows.push({ scope, metric, [armA]: a, [armB]: b, delta_B_minus_A: delta, ratio_B_over_A: ratio, note });
  };
  for (const scope of scopes) {
    const A = armStats[armA][scope];
    const B = armStats[armB][scope];
    if (!A || !B) continue;
    push(scope, 'n_problems', A.n, B.n, '两臂各自题数');
    push(scope, 'successRate', A.successRate, B.successRate, /^math[-_]?500$/.test(scope)
      ? 'MATH-500 答案等价性判对占比（\\boxed → ANSWER = → final answer is → 末行；数值/集合/文本三级比较）'
      : '判分成功占比');
    push(scope, 'correctCount', A.correct, B.correct);
    push(scope, 'tokens_total_mean', A.tokens.total.mean, B.tokens.total.mean, '含缓存读');
    push(scope, 'tokens_total_median', A.tokens.total.median, B.tokens.total.median);
    push(scope, 'tokens_total_p90', A.tokens.total.p90, B.tokens.total.p90);
    push(scope, 'tokens_nonCached_mean', A.tokens.nonCached.mean, B.tokens.nonCached.mean, 'input+output');
    push(scope, 'tokens_output_mean', A.tokens.output.mean, B.tokens.output.mean, '含思考');
    push(scope, 'tokens_reasoning_mean', A.tokens.reasoning.mean, B.tokens.reasoning.mean);
    push(scope, 'tokens_answer_mean', A.tokens.answerOnly.mean, B.tokens.answerOnly.mean, 'output-reasoning');
    push(scope, 'tokens_total_sum', A.tokens.sums.total, B.tokens.sums.total);
    push(scope, 'tokens_output_sum', A.tokens.sums.output, B.tokens.sums.output);
    push(scope, 'tokens_reasoning_sum', A.tokens.sums.reasoning, B.tokens.sums.reasoning);
    /* 前缀（人设）差异的直接证据：input 与 cacheRead 的均值 / 极差。
       cacheRead 的 min==max 说明缓存塌成单一常量（短人设跌破公共锚点）。 */
    push(scope, 'tokens_input_mean', A.tokens.input.mean, B.tokens.input.mean, 'prompt 未命中缓存部分');
    push(scope, 'tokens_cacheRead_mean', A.tokens.cacheRead.mean, B.tokens.cacheRead.mean, '缓存读；极差见 note');
    push(scope, 'tokens_cacheRead_range', A.tokens.cacheRead.max - A.tokens.cacheRead.min, B.tokens.cacheRead.max - B.tokens.cacheRead.min, `A min/max=${A.tokens.cacheRead.min}/${A.tokens.cacheRead.max} · B min/max=${B.tokens.cacheRead.min}/${B.tokens.cacheRead.max}`);
    push(scope, 'toolCallsTotal', A.toolCallsTotal, B.toolCallsTotal, '工具调用总次数（题面闸门是提示级，非硬禁）');
    push(scope, 'toolCallRuns', A.toolCallRuns, B.toolCallRuns, '发生过工具调用的题数');
    push(scope, 'stepsGt1Runs', A.stepsGt1Runs, B.stepsGt1Runs, '多步（steps>1）题数');
    push(scope, 'stepsGt1Rate', A.stepsGt1Rate, B.stepsGt1Rate, '多步占比');
    push(scope, 'gradeMethodDist', JSON.stringify(A.gradeMethodDist), JSON.stringify(B.gradeMethodDist), '答案/代码抽取方法分布');

    push(scope, 'wallMs_mean', A.wallMs.gateway.mean, B.wallMs.gateway.mean, '网关 wallMs');
    push(scope, 'wallMs_median', A.wallMs.gateway.median, B.wallMs.gateway.median);
    push(scope, 'wallMs_p90', A.wallMs.gateway.p90, B.wallMs.gateway.p90);
    push(scope, 'wallMs_p99', A.wallMs.gateway.p99, B.wallMs.gateway.p99);
    push(scope, 'wallMs_max', A.wallMs.gateway.max, B.wallMs.gateway.max);
    push(scope, 'wallMs_over15s', A.wallMs.over15s, B.wallMs.over15s, '长尾计数');
    push(scope, 'firstTokenMs_mean', A.wallMs.firstTokenMs.mean, B.wallMs.firstTokenMs.mean);
    push(scope, 'runnerWallMs_mean', A.wallMs.runner.mean, B.wallMs.runner.mean);
    push(scope, 'cost_total', A.cost.total, B.cost.total, `主口径 ${A.cost.headline}，${A.cost.unit}`);
    push(scope, 'cost_perProblem', A.cost.perProblem, B.cost.perProblem);
    push(scope, 'cost_perCorrect', A.cost.perCorrectProblem, B.cost.perCorrectProblem, '每道正确题的花费');
    push(scope, 'emptyResponses', A.emptyResponses, B.emptyResponses, '空答复题数（判为失败）');
    push(scope, 'formatOkRate', A.formatOkRate ?? '', B.formatOkRate ?? '', '题面要求的输出格式合规率');
    const P = paired[scope];
    if (P) {
      rows.push({
        scope,
        metric: 'paired McNemar / bootstrap',
        [armA]: `${P.agreement.bothCorrect} 同对 / ${P.agreement[`${armB}Only`]} ${armB}独对`,
        [armB]: `${P.agreement.bothWrong} 同错 / ${P.agreement[`${armA}Only`]} ${armA}独对`,
        delta_B_minus_A: P.mcnemar.pValue,
        ratio_B_over_A: P.bootstrap.ci95.join('..'),
        note: `McNemar 精确 p=${P.mcnemar.pValue}（b=${P.mcnemar.b}, c=${P.mcnemar.c}）；Δ(B-A)=${P.bootstrap.delta}，95%CI=${P.bootstrap.ci95.join('..')}`,
      });
      rows.push({
        scope,
        metric: 'token 节省 (A-B)/A',
        [armA]: P.tokenSaving.totals[armA],
        [armB]: P.tokenSaving.totals[armB],
        delta_B_minus_A: P.tokenSaving.aggregateRatio,
        ratio_B_over_A: P.tokenSaving.perProblemMedian,
        note: `总 token 聚合省 ${pct(P.tokenSaving.aggregateRatio)}%、每题中位 ${pct(P.tokenSaving.perProblemMedian)}%，B 更低 ${P.tokenSaving.bLowerCount}/${P.tokenSaving.n} 题；输出 token 聚合省 ${pct(P.outputTokenSaving.aggregateRatio)}%、思考 token 聚合省 ${pct(P.reasoningTokenSaving.aggregateRatio)}%`,
      });
      rows.push({
        scope,
        metric: 'wallMs 节省 (A-B)/A',
        [armA]: P.wallSaving.totals[armA],
        [armB]: P.wallSaving.totals[armB],
        delta_B_minus_A: P.wallSaving.aggregateRatio,
        ratio_B_over_A: P.wallSaving.perProblemMedian,
        note: `耗时聚合省 ${pct(P.wallSaving.aggregateRatio)}%，B 更快 ${P.wallSaving.bLowerCount}/${P.wallSaving.n} 题（每题中位 ${pct(P.wallSaving.perProblemMedian)}%）`,
      });
    }
  }
  return { head, rows };
}

function toCsv({ head, rows }) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '\uFEFF' + [head.join(','), ...rows.map((r) => head.map((h) => esc(r[h])).join(','))].join('\r\n') + '\r\n';
}

/* ------------------------------------------------------------------ 人读汇总 */

function printSummary(results, records, arms, armA, armB, scopes) {
  const pad = (s, n) => String(s).padEnd(n);
  const lpad = (s, n) => String(s).padStart(n);
  console.log('');
  console.log(`=== 判分汇总 · run=${results.run} · 模型 ${results.model}（${results.provider}）===`);
  console.log(`题目 ${results.problems ? Object.entries(results.problems).map(([k, v]) => `${k}=${v}`).join(' ') : ''}`
    + ` | 记录 ${results.rows.graded} 条（预热 ${results.rows.warmup} 已剔除）| 未判分 ${results.rows.skippedGrading}`);
  console.log(`HumanEval 执行：${results.grading.humaneval}`);
  if (records.some((r) => /^math[-_]?500$/.test(r.dataset))) {
    console.log(`MATH-500 判分：${results.grading.math500}`);
    console.log(`MATH-500 可复核产物：${results.grading.mathReviewArtifacts} 题（未判对的 gold + 答复全文，均在仓库外 out 目录）`);
  }
  for (const scope of scopes) {
    const A = results.stats[armA][scope];
    const B = results.stats[armB][scope];
    if (!A || !B) continue;
    console.log('');
    console.log(`--- ${scope}（${armA} n=${A.n} vs ${armB} n=${B.n}）---`);
    const line = (label, a, b, fmt = (x) => x) => console.log(`  ${pad(label, 26)} ${lpad(fmt(a), 12)} ${lpad(fmt(b), 12)}  ${fmt(b) === fmt(a) ? '' : ''}`);
    console.log(`  ${pad('', 26)} ${lpad(armA, 12)} ${lpad(armB, 12)}`);
    line('成功率 %', A.successRatePct, B.successRatePct, (x) => `${x}%`);
    line('正确题数', A.correct, B.correct);
    line('总 token 均值', A.tokens.total.mean, B.tokens.total.mean, (x) => x.toLocaleString('en-US'));
    line('总 token 中位', A.tokens.total.median, B.tokens.total.median, (x) => x.toLocaleString('en-US'));
    line('总 token P90', A.tokens.total.p90, B.tokens.total.p90, (x) => x.toLocaleString('en-US'));
    line('输出 token 均值', A.tokens.output.mean, B.tokens.output.mean, (x) => x.toLocaleString('en-US'));
    line('思考 token 均值', A.tokens.reasoning.mean, B.tokens.reasoning.mean, (x) => x.toLocaleString('en-US'));
    line('思考 token 合计', A.tokens.sums.reasoning, B.tokens.sums.reasoning, (x) => x.toLocaleString('en-US'));
    line('耗时 中位 ms', A.wallMs.gateway.median, B.wallMs.gateway.median, (x) => Math.round(x).toLocaleString('en-US'));
    line('耗时 P90 ms', A.wallMs.gateway.p90, B.wallMs.gateway.p90, (x) => Math.round(x).toLocaleString('en-US'));
    line('耗时 P99 ms', A.wallMs.gateway.p99, B.wallMs.gateway.p99, (x) => Math.round(x).toLocaleString('en-US'));
    line('耗时 max ms', A.wallMs.gateway.max, B.wallMs.gateway.max, (x) => Math.round(x).toLocaleString('en-US'));
    line('>15s 题数', A.wallMs.over15s, B.wallMs.over15s);
    line('首字延 均值 ms', A.wallMs.firstTokenMs.mean, B.wallMs.firstTokenMs.mean, (x) => Math.round(x));
    line('成本(主口径) 元', A.cost.total, B.cost.total, (x) => x.toFixed(4));
    line('每正确题成本', A.cost.perCorrectProblem, B.cost.perCorrectProblem, (x) => x.toFixed(5));
    line('每正确题总 token', A.cost.tokensPerCorrect, B.cost.tokensPerCorrect, (x) => Math.round(x).toLocaleString('en-US'));
    line('空答复题数', A.emptyResponses, B.emptyResponses);
    line('工具调用 总次数', A.toolCallsTotal, B.toolCallsTotal);
    line('多步(steps>1)题数', A.stepsGt1Runs, B.stepsGt1Runs);
    line('input token 均值', A.tokens.input.mean, B.tokens.input.mean, (x) => x.toLocaleString('en-US'));
    line('cacheRead token 均值', A.tokens.cacheRead.mean, B.tokens.cacheRead.mean, (x) => x.toLocaleString('en-US'));
    console.log(`  缓存读极差 ${armA} min/max=${A.tokens.cacheRead.min}/${A.tokens.cacheRead.max} · ${armB} min/max=${B.tokens.cacheRead.min}/${B.tokens.cacheRead.max}`);
    console.log(`  抽取方法分布 ${armA}: ${JSON.stringify(A.gradeMethodDist)}`);
    console.log(`  抽取方法分布 ${armB}: ${JSON.stringify(B.gradeMethodDist)}`);

    console.log(`  失败归因 ${armA}: ${JSON.stringify(A.failureBreakdown)}`);
    console.log(`  失败归因 ${armB}: ${JSON.stringify(B.failureBreakdown)}`);
    const P = results.paired[scope];
    if (P) {
      console.log(`  配对：同对 ${P.agreement.bothCorrect} · 同错 ${P.agreement.bothWrong} · ${armA} 独对 ${P.agreement[`${armA}Only`]} · ${armB} 独对 ${P.agreement[`${armB}Only`]}`);
      console.log(`  McNemar 精确 p=${P.mcnemar.pValue}（b=${P.mcnemar.b}, c=${P.mcnemar.c}）；Δ(${armB}-${armA})=${P.bootstrap.delta}，95%CI ${P.bootstrap.ci95.join(' .. ')}`);
      console.log(`  token 节省（${armA} - ${armB}）/${armA}：总 token 聚合 ${pct(P.tokenSaving.aggregateRatio)}%、每题中位 ${pct(P.tokenSaving.perProblemMedian)}%、${armB} 更低 ${P.tokenSaving.bLowerCount}/${P.tokenSaving.n} 题`);
      console.log(`    输出 token 聚合省 ${pct(P.outputTokenSaving.aggregateRatio)}%；思考 token 聚合省 ${pct(P.reasoningTokenSaving.aggregateRatio)}%；非缓存 token 聚合省 ${pct(P.nonCachedTokenSaving.aggregateRatio)}%`);
      console.log(`  耗时节省：聚合 ${pct(P.wallSaving.aggregateRatio)}%，${armB} 更快 ${P.wallSaving.bLowerCount}/${P.wallSaving.n} 题（每题中位 ${pct(P.wallSaving.perProblemMedian)}%）`);
      console.log(`  成本节省（peak 价）：聚合 ${pct(P.costSaving.aggregateRatio)}%`);
    }
  }
  console.log('');
}

await main();
