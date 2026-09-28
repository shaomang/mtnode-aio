#!/usr/bin/env node
/**
 * bench/fetch-data.mjs — 下载 Agent 能力评测（Benchmark）数据集到仓库外的本机缓存目录。
 *
 * 默认落盘位置（不进仓库）：%LOCALAPPDATA%\mtnode-bench\datasets\
 *   ├── gsm8k\test-00000-of-00001.parquet      官方 HF parquet（原始缓存产物）
 *   ├── gsm8k\test.jsonl                       GSM8K test 全量 1319 题（评测 / 抽样用，免 parquet 解析）
 *   ├── gsm8k\test-sample-n{n}-seed{s}.jsonl   固定随机种子抽样出的评测子集
 *   ├── humaneval\HumanEval.jsonl.gz           官方压缩包（原始缓存产物）
 *   ├── humaneval\HumanEval.jsonl              HumanEval 全量 164 题（pass@1，执行官方 tests）
 *   ├── humaneval\HumanEval-sample-n{n}-seed{s}.jsonl
 *   ├── math500\test.jsonl                     MATH-500 难档题集全量 500 题（归一为统一题目契约）
 *   ├── math500\math500-sample-n{n}-seed{s}.jsonl  先按 level≥4 过滤再固定种子抽样（默认 100 题）
 *   └── manifest.json                          来源 URL / 字节数 / sha256 / 行数 / 契约与体积核对
 *
 * 统一题目契约（MATH-500 落盘即契约格式，供 run-bench.mjs 与 score.mjs 共用）：
 *   {
 *     dataset:  'math500',                       # 数据集键，与目录名 / 文件名前缀一致
 *     id:       'math500#<全量行号>',             # 本脚本写入并保持稳定：全量与子集同 id，消费方直接读行内 id，
 *                                                #   不要按子集文件行号重算（否则断点续跑 / 判分会对不上 gold）
 *     question: '<题干原文>',                     # 原文照抄，不翻译不改写
 *     gold:     { answer, solution, level }      # level 归一为数字 1..5
 *     meta:     { subject, unique_id }           # 可选追溯字段，消费方可忽略
 *   }
 *   GSM8K / HumanEval 仍保留官方原始字段（由 run-bench 侧按同规则归一），本脚本不改其格式。
 *
 * 指标口径（由评测侧脚本消费，本脚本只负责取数、归一与抽样）：
 *   - GSM8K：最终数值 exact-match accuracy
 *   - HumanEval：pass@1（执行官方 tests）
 *   - MATH-500：难档（level≥4）子集，最终答案 exact-match accuracy
 *   - 若本机无可用 Python：HumanEval 无法执行判分，兜底改用 MMLU 子集（选择题 exact-match）；
 *     本脚本会打印 Python 探测结果与兜底提示，不会自动下载 MMLU。
 *
 * 用法：
 *   node scripts/bench/fetch-data.mjs                     # 下载 + 默认试点子集（n=100, seed=1234）
 *   node scripts/bench/fetch-data.mjs --sample 200        # 自定义子集题量（题量试点后再定）
 *   node scripts/bench/fetch-data.mjs --no-sample         # 只下载全量
 *   node scripts/bench/fetch-data.mjs --dir D:\tmp\bench  # 自定义缓存目录
 *   node scripts/bench/fetch-data.mjs --force             # 重新下载已有文件
 *
 * 约束：零依赖（Node ≥ 18，用内置 fetch / zlib / crypto）；总体积必须 < 1GB，超预算报错退出。
 */

import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const ONE_GB = 1024 * 1024 * 1024;

/* ------------------------------------------------------------------ CLI */

function parseArgs(argv) {
  const opts = {
    dir: defaultDatasetDir(),
    sample: 100,
    seed: 1234,
    force: false,
    doSample: true,
    budget: ONE_GB,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`参数 ${a} 缺少取值`);
      return v;
    };
    if (a === '--dir') opts.dir = path.resolve(next());
    else if (a === '--sample') opts.sample = Number.parseInt(next(), 10);
    else if (a === '--seed') opts.seed = Number.parseInt(next(), 10);
    else if (a === '--budget') opts.budget = Number.parseInt(next(), 10);
    else if (a === '--force') opts.force = true;
    else if (a === '--no-sample') opts.doSample = false;
    else if (a === '-h' || a === '--help') {
      console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, ''));
      process.exit(0);
    } else fail(`未知参数：${a}（--help 看用法）`);
  }
  if (!Number.isInteger(opts.sample) || opts.sample <= 0) fail('--sample 需为正整数');
  if (!Number.isInteger(opts.seed)) fail('--seed 需为整数');
  if (!Number.isInteger(opts.budget) || opts.budget <= 0) fail('--budget 需为正整数（字节）');
  return opts;
}

function defaultDatasetDir() {
  if (process.env.MTNODE_BENCH_DIR) return path.resolve(process.env.MTNODE_BENCH_DIR);
  const base =
    process.platform === 'win32' ? process.env.LOCALAPPDATA
      : process.platform === 'darwin' ? path.join(process.env.HOME || '', 'Library', 'Application Support')
        : path.join(process.env.XDG_DATA_HOME || path.join(process.env.HOME || '', '.local', 'share'));
  if (!base) fail('无法确定本机缓存目录，请用 --dir 显式指定');
  return path.join(base, 'mtnode-bench', 'datasets');
}

function fail(msg) {
  console.error(`[bench][错误] ${msg}`);
  process.exit(1);
}

/* --------------------------------------------------------------- 数据源 */

const SOURCES = [
  {
    id: 'gsm8k-parquet',
    dataset: 'gsm8k',
    file: 'test-00000-of-00001.parquet',
    metric: '最终数值 exact-match accuracy',
    note: '官方 HuggingFace parquet（原始缓存产物）；huggingface.co 直连不通时走镜像',
    candidates: [
      'https://huggingface.co/datasets/openai/gsm8k/resolve/main/main/test-00000-of-00001.parquet',
      'https://hf-mirror.com/datasets/openai/gsm8k/resolve/main/main/test-00000-of-00001.parquet',
    ],
  },
  {
    id: 'gsm8k-jsonl',
    dataset: 'gsm8k',
    file: 'test.jsonl',
    metric: '最终数值 exact-match accuracy',
    note: 'GSM8K test 全量（openai/grade-school-math 官方原始数据，与 parquet 同源同内容）',
    candidates: [
      'https://raw.githubusercontent.com/openai/grade-school-math/master/grade_school_math/data/test.jsonl',
      'https://cdn.jsdelivr.net/gh/openai/grade-school-math@master/grade_school_math/data/test.jsonl',
    ],
    expectLines: 1319,
    jsonl: true,
  },
  {
    id: 'humaneval-gz',
    dataset: 'humaneval',
    file: 'HumanEval.jsonl.gz',
    metric: 'pass@1（执行官方 tests）',
    note: '官方 openai/human-eval 压缩包（原始缓存产物）',
    candidates: [
      'https://raw.githubusercontent.com/openai/human-eval/master/data/HumanEval.jsonl.gz',
      'https://cdn.jsdelivr.net/gh/openai/human-eval@master/data/HumanEval.jsonl.gz',
    ],
    gunzipTo: 'HumanEval.jsonl',
  },
  {
    id: 'humaneval-jsonl',
    dataset: 'humaneval',
    file: 'HumanEval.jsonl',
    metric: 'pass@1（执行官方 tests）',
    note: 'HumanEval 全量 164 题（由 .jsonl.gz 解出；解后校验行数与完整性）',
    candidates: [],
    expectLines: 164,
    jsonl: true,
    derived: true,
  },
  {
    id: 'math500-jsonl',
    dataset: 'math500',
    file: 'test.jsonl',
    metric: '难档（level≥4）最终答案 exact-match accuracy',
    note: 'MATH-500 全量 500 题（HuggingFaceH4/MATH-500 官方 test.jsonl）；落盘前归一为统一题目契约 dataset/id/question/gold{answer,solution,level}',
    candidates: [
      'https://hf-mirror.com/datasets/HuggingFaceH4/MATH-500/resolve/main/test.jsonl',
      'https://huggingface.co/datasets/HuggingFaceH4/MATH-500/resolve/main/test.jsonl',
    ],
    expectLines: 500,
    jsonl: true,
    normalize: normalizeMath500,
    filterRows: (rows) => rows.filter((o) => Number(o?.gold?.level) >= 4),
    filterNote: 'level≥4（难档）',
    sampleBase: 'math500',
  },
];

/* --------------------------------------------------------------- 下载器 */

async function fetchOne(url, timeoutMs = 90_000, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new Error('响应体为空');
      return buf;
    } catch (e) {
      lastErr = e;
      if (i < attempts) await new Promise((r) => setTimeout(r, i * 500));
    }
  }
  throw lastErr;
}

async function download(src, dir, force) {
  const dest = path.join(dir, src.dataset, src.file);
  if (!force && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    const buf = await fsp.readFile(dest);
    return { src, dest, buf, reused: true, url: '(本地已有)' };
  }
  if (src.derived) return { src, dest, buf: null, reused: false, url: '-' };
  let lastErr = null;
  for (const url of src.candidates) {
    try {
      const buf = await fetchOne(url);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.tmp`;
      await fsp.writeFile(tmp, buf);
      await fsp.rename(tmp, dest);
      console.log(`  ✓ ${src.dataset}/${src.file}  ${fmtBytes(buf.length)}  ← ${hostOf(url)}`);
      return { src, dest, buf, reused: false, url };
    } catch (e) {
      lastErr = e;
      console.log(`  · ${src.dataset}/${src.file} 候选源失败：${hostOf(url)} → ${e.message}`);
    }
  }
  fail(`${src.id} 下载失败：${lastErr?.message || '无可用源'}`);
}

function hostOf(u) {
  try { return new URL(u).host; } catch { return u; }
}

/* ------------------------------------------------------- JSONL / 抽样 */

function parseJsonl(buf) {
  const rows = [];
  for (const line of buf.toString('utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    rows.push(JSON.parse(s));
  }
  return rows;
}

/**
 * MATH-500 官方行（problem/solution/answer/subject/level/unique_id）→ 统一题目契约。
 * 幂等：已是契约行（带 math500# 前缀 id）再跑一遍输出不变，因此 --force 与本地复用两条路径都安全。
 */
function normalizeMath500(rows) {
  return rows.map((o, i) => {
    const question = String(o.question ?? o.problem ?? '').trim();
    const answer = String(o.gold?.answer ?? o.answer ?? '').trim();
    const solution = String(o.gold?.solution ?? o.solution ?? '').trim();
    const level = Number(o.gold?.level ?? o.level);
    if (!question) fail(`math500 第 ${i + 1} 行题面为空`);
    if (!answer) fail(`math500 第 ${i + 1} 行 gold.answer 为空`);
    if (!(Number.isFinite(level) && level >= 1 && level <= 5)) fail(`math500 第 ${i + 1} 行 level 异常：${o.level ?? o.gold?.level}`);
    const id = typeof o.id === 'string' && /^math500#\d+$/.test(o.id) ? o.id : `math500#${i + 1}`;
    return {
      dataset: 'math500',
      id,
      question,
      gold: { answer, solution, level },
      meta: {
        subject: String(o.meta?.subject ?? o.subject ?? '').trim(),
        unique_id: String(o.meta?.unique_id ?? o.unique_id ?? '').trim(),
      },
    };
  });
}

/** mulberry32：小而确定的 PRNG，配合固定种子保证抽样可复现。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 固定种子 Fisher-Yates 部分洗牌，结果按原始顺序输出（可复现）。 */
function sampleRows(rows, n, seed) {
  const take = Math.min(n, rows.length);
  const idx = rows.map((_, i) => i);
  const rnd = mulberry32(seed);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(rnd() * (idx.length - i));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, take).sort((x, y) => x - y).map((i) => rows[i]);
}

function countLines(buf) {
  let n = 0;
  for (const line of buf.toString('utf8').split(/\r?\n/)) if (line.trim()) n++;
  return n;
}

/* ----------------------------------------------------------- Python 探测 */

function probePython() {
  for (const cmd of ['python', 'python3', 'py']) {
    for (const args of [['-V'], ['-3', '-V']]) {
      try {
        const r = spawnSync(cmd, args, { stdio: 'ignore', timeout: 15_000, windowsHide: true });
        if (r.status === 0) return { ok: true, cmd: `${cmd} ${args.join(' ')}`.trim() };
      } catch { /* 继续尝试下一个 */ }
    }
  }
  return { ok: false };
}

/* ------------------------------------------------------------- 工具函数 */

function fmtBytes(b) {
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(2)} MB (${b.toLocaleString('en-US')} B)`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB (${b.toLocaleString('en-US')} B)`;
  return `${b} B`;
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function dirBytes(dir) {
  let total = 0;
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && !p.endsWith('.tmp') && e.name !== 'manifest.json') { total += fs.statSync(p).size; files.push(p); }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return { total, files };
}

/* ----------------------------------------------------------------- main */

const opts = parseArgs(process.argv.slice(2));

console.log('[bench] Benchmark 数据集下载（缓存目录在仓库外，不入库）');
console.log(`[bench] 缓存目录：${opts.dir}`);
await fsp.mkdir(opts.dir, { recursive: true });

const py = probePython();
if (py.ok) {
  console.log(`[bench] Python 可用（${py.cmd}）→ 主方案：GSM8K（exact-match）+ HumanEval（pass@1 执行官方 tests）`);
} else {
  console.log('[bench] 未探测到可执行 Python → HumanEval 无法执行判分；请按兜底方案改用 MMLU 子集（选择题 exact-match，几百 MB 以内）。本脚本不自动下载 MMLU。');
}

const written = [];
const results = [];
for (const src of SOURCES) results.push(await download(src, opts.dir, opts.force));

// 解出 HumanEval.jsonl（若 .gz 刚下载或本地缺失）
const gz = results.find((r) => r.src.id === 'humaneval-gz');
const he = results.find((r) => r.src.id === 'humaneval-jsonl');
if (gz?.buf) {
  const out = gunzipSync(gz.buf);
  await fsp.writeFile(he.dest, out);
  he.buf = out;
  console.log(`  ✓ humaneval/HumanEval.jsonl  ${fmtBytes(out.length)}  ← 由 ${path.basename(gz.src.file)} 解压`);
} else if (!fs.existsSync(he.dest)) {
  fail('HumanEval.jsonl 缺失且无法从 .gz 解出，请加 --force 重跑');
} else {
  he.buf = await fsp.readFile(he.dest);
}

// 完整性核对：行数 / 关键字段（MATH-500 先归一为统一题目契约，再校验并回写落盘文件）
const NEED_FIELDS = {
  gsm8k: ['question', 'answer'],
  humaneval: ['task_id', 'prompt', 'test'],
  math500: ['dataset', 'id', 'question', 'gold'],
};
for (const r of results) {
  if (!r.src.jsonl) continue;
  let rows = parseJsonl(r.buf);
  if (r.src.normalize) {
    rows = r.src.normalize(rows);
    const out = Buffer.from(rows.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8');
    await fsp.writeFile(r.dest, out);
    r.buf = out;
    console.log(`  ✓ ${r.src.dataset}/${r.src.file}  ${fmtBytes(out.length)}  ← 已归一为统一题目契约`);
  }
  const n = rows.length;
  if (r.src.expectLines && n !== r.src.expectLines) {
    fail(`${r.src.dataset}/${r.src.file} 行数 ${n} ≠ 预期 ${r.src.expectLines}`);
  }
  const need = NEED_FIELDS[r.src.dataset] || [];
  for (const k of need) if (!(k in rows[0])) fail(`${r.src.dataset}/${r.src.file} 缺少字段 ${k}`);
  if (r.src.dataset === 'math500') {
    for (const k of ['answer', 'solution', 'level']) {
      if (!(k in (rows[0].gold || {}))) fail(`math500/${r.src.file} gold 缺少字段 ${k}`);
    }
    if (new Set(rows.map((o) => o.id)).size !== n) fail(`math500/${r.src.file} 题目 id 不唯一，判分与断点续跑无法对齐`);
  }
  r.rows = rows;
  r.lineCount = n;
  console.log(`  ✓ ${r.src.dataset}/${r.src.file}  ${n} 条，字段完整（${need.join('/')}）`);
}

// 固定随机种子抽样评测子集（题量试点后再定，默认 n=100）
const subsets = [];
if (opts.doSample) {
  for (const r of results) {
    if (!r.src.jsonl || !r.rows) continue;
    const base = r.src.sampleBase || path.parse(r.src.file).name;
    const pool = r.src.filterRows ? r.src.filterRows(r.rows) : r.rows;
    if (r.src.filterRows) {
      console.log(`  · ${r.src.dataset} 抽样池（${r.src.filterNote || '过滤后'}）${pool.length}/${r.lineCount} 条`);
      if (pool.length < opts.sample) fail(`${r.src.dataset} 过滤后仅 ${pool.length} 题，不足 --sample ${opts.sample}`);
    }
    const outName = `${base}-sample-n${opts.sample}-seed${opts.seed}.jsonl`;
    const outPath = path.join(opts.dir, r.src.dataset, outName);
    const picked = sampleRows(pool, opts.sample, opts.seed);
    await fsp.writeFile(outPath, picked.map((o) => JSON.stringify(o)).join('\n') + '\n');
    const st = await fsp.stat(outPath);
    subsets.push({
      dataset: r.src.dataset,
      file: outName,
      rows: picked.length,
      pool: pool.length,
      total: r.lineCount,
      filter: r.src.filterNote || null,
      bytes: st.size,
      seed: opts.seed,
    });
    const from = r.src.filterRows ? `${pool.length}/${r.lineCount}` : `${r.lineCount}`;
    console.log(`  ✓ 评测子集 ${r.src.dataset}/${outName}  ${picked.length} 条（池 ${from}${r.src.filterNote ? `，${r.src.filterNote}` : ''}）  ${fmtBytes(st.size)}  (seed=${opts.seed})`);
  }
}

// 汇总：实际字节数 + <1GB 核对
for (const r of results) {
  if (!fs.existsSync(r.dest)) continue;
  const st = await fsp.stat(r.dest);
  written.push({
    dataset: r.src.dataset,
    file: path.relative(opts.dir, r.dest).split(path.sep).join('/'),
    bytes: st.size,
    sha256: sha256(fs.readFileSync(r.dest)),
    metric: r.src.metric,
    note: r.src.note,
    source: r.url,
    reused: !!r.reused,
  });
}
for (const s of subsets) {
  written.push({
    dataset: s.dataset,
    file: `${s.dataset}/${s.file}`,
    bytes: s.bytes,
    sha256: sha256(fs.readFileSync(path.join(opts.dir, s.dataset, s.file))),
    metric: 'seeded subset',
    note: s.filter
      ? `${s.filter} 过滤后 ${s.pool}/${s.total} 题中固定种子抽样 ${s.rows} 条（seed=${s.seed}）`
      : `固定种子抽样 ${s.rows} 条（seed=${s.seed}）`,
    filter: s.filter || null,
    pool: s.pool,
    source: '(本地生成)',
    reused: false,
  });
}

const { total } = dirBytes(opts.dir);
const budgetOk = total < opts.budget;
const manifest = {
  generatedAt: new Date().toISOString(),
  datasetDir: opts.dir,
  python: py,
  plan: {
    gsm8k: '最终数值 exact-match accuracy',
    humaneval: 'pass@1（执行官方 tests）',
    math500: 'MATH-500 难档题集：全量 500 题按 level≥4 过滤后固定种子抽 100 题，最终答案 exact-match accuracy',
    fallback: '无 Python 时用 MMLU 子集（选择题 exact-match）',
  },
  contract: {
    math500: 'dataset/id/question/gold{answer,solution,level}（+ 可选 meta{subject,unique_id}）；id 由本脚本写入、在全量与子集间保持稳定，run-bench 与 score 直接读行内 id，不要按子集文件行号重算',
    gsm8k: '官方原始字段（question/answer），由 run-bench 归一为同一契约',
    humaneval: '官方原始字段（task_id/prompt/test/entry_point），由 run-bench 归一为同一契约',
  },
  sample: opts.doSample ? { size: opts.sample, seed: opts.seed } : null,
  budgetBytes: opts.budget,
  totalBytes: total,
  budgetOk,
  files: written,
};
await fsp.writeFile(path.join(opts.dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log('\n[bench] —— 实际字节数与体积核对 ——');
for (const f of written) console.log(`  ${String(f.bytes).padStart(10)} B  ${f.file}`);
console.log(`  ${String(total).padStart(10)} B  合计（数据集文件，不含 manifest.json）`);
console.log(`[bench] 总体积 ${fmtBytes(total)} = ${(total / ONE_GB * 1024).toFixed(1)} MiB，预算 ${fmtBytes(opts.budget)} → ${budgetOk ? 'PASS（<1GB）' : 'FAIL（超预算）'}`);
if (!budgetOk) fail(`数据集总体积 ${fmtBytes(total)} 超出 ${fmtBytes(opts.budget)} 预算`);
console.log(`[bench] 清单已写入 ${path.join(opts.dir, 'manifest.json')}`);
console.log('[bench] 完成。数据集在仓库外，不入库；抽样子集题量可用 --sample 调整后重跑。');
