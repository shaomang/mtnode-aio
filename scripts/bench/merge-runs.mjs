#!/usr/bin/env node
/**
 * bench/merge-runs.mjs — 把多个 run 目录的 results.jsonl 合并成一个「判分器可直接吃」的新 run 目录。
 *
 * 为什么需要：runner 一次只能带一组 --arms。为了把四臂（standard / lean / code / minimal）
 * 放进同一批题里对比，标准/精简跑在 runs\full，代码/极简跑在 runs\full2；判分器
 * （score.mjs）按 <benchRoot>\runs\<run>\ 读 results.jsonl + run-meta.json，且只会取一份
 * 题集指纹。本工具把两者合成 runs\full4，**不动任何原件**，判分时一条命令看四臂：
 *   node scripts/bench/score.mjs --run full4 --arms standard,lean
 *   node scripts/bench/score.mjs --run full4 --arms code,minimal
 *
 * 合并前置条件（不满足即报错退出，绝不静悄悄地把两批不同数据拼一起）：
 *   1) 两份 run-meta 的**题集指纹**逐项相等：datasets 的键集合一致，且每个键的 sha256 一致
 *      （判分器就是拿这个 sha 校验题集的，指纹不同 = 不是同一批题）；
 *   2) **model / provider / effort 逐项相等**：model、provider、以及各臂的请求档与预期生效档
 *      （同一个臂名必须带完全相同的 arm spec）；
 *   3) 影响可比性的口径字段一致：permissionPreset、toolGuard/allowTools（题面工具闸门）、
 *      maxTokens、systemPrompt、seed、sample、full、limit。
 *   其余字段（并发、超时、重跑次数、网关路径、生成时间…）允许不同，取第一份的值并记进 warnings。
 *
 * 去重：按 (dataset, id, arm, warmup) 分组，默认保留 `at` 最新的一条（--dedupe latest）；
 *   `--dedupe keep-all` 则原样保留全部行（含同一题的重跑，成本口径与单目录一致）。
 *   注意 runner 每次重试都会追加一行，同一目录内也可能撞键：latest 会把它们压成一条，
 *   于是「含重试的真实成本」会被低估 —— 合并计数与压掉的行数都写进 run-meta.merge。
 *
 * 用法：
 *   node scripts/bench/merge-runs.mjs                                  # full + full2 → full4
 *   node scripts/bench/merge-runs.mjs --sources full,full2 --out full4
 *   node scripts/bench/merge-runs.mjs --sources <绝对目录>,<绝对目录> --out stub-merged --dry-run
 *   node scripts/bench/merge-runs.mjs --bench-root <dir> --dedupe keep-all --force
 *
 * 参数：
 *   --sources <a,b,...>   源 run 名（相对 <benchRoot>\runs）或绝对目录，≥2 个（默认 full,full2）
 *   --out <name|dir>      目标 run 名（默认 full4）；写 <benchRoot>\runs\<name>\
 *   --bench-root <dir>    评测根目录（默认与 runner 一致：%LOCALAPPDATA%\mtnode-bench）
 *   --dedupe <latest|keep-all>  同键多行时的保留策略（默认 latest）
 *   --force               目标已有 results.jsonl 时允许覆盖
 *   --dry-run             只校验 + 打印将要合并的结果，不落盘
 *
 * 零依赖（只用 node 内置模块），只读源目录，输出确定性排序（按 at 时间序）。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const SCHEMA = 'mtnode-bench-run/1';
/** 判分器按两臂配对做对比，四臂时用它喜欢的规范顺序排列 */
const ARM_ORDER = ['standard', 'lean', 'code', 'minimal'];

/* ------------------------------------------------------------------ CLI */

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
    sources: ['full', 'full2'],
    out: 'full4',
    benchRoot: defaultBenchRoot(),
    dedupe: 'latest',
    force: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (what) => {
      const v = argv[++i];
      if (v === undefined) fail(`${a} 缺少${what}`);
      return v;
    };
    if (a === '--sources') o.sources = next('源列表').split(',').map((x) => x.trim()).filter(Boolean);
    else if (a === '--out') o.out = next('目标');
    else if (a === '--bench-root') o.benchRoot = path.resolve(next('目录'));
    else if (a === '--dedupe') o.dedupe = next('策略');
    else if (a === '--force') o.force = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '-h' || a === '--help') {
      console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, ''));
      process.exit(0);
    } else fail(`未知参数：${a}（--help 看用法）`);
  }
  if (!Array.isArray(o.sources) || o.sources.length < 2) fail('--sources 至少两个 run（例如 full,full2）');
  if (!['latest', 'keep-all'].includes(o.dedupe)) fail('--dedupe 只支持 latest / keep-all');
  return o;
}

function fail(msg) {
  console.error(`[merge][错误] ${msg}`);
  process.exit(1);
}

/* ------------------------------------------------------------------ 源目录 */

function resolveSourceDir(token, opt) {
  const isPath = /[\\/]/.test(token) || /^[a-zA-Z]:/.test(token);
  return isPath ? path.resolve(token) : path.join(opt.benchRoot, 'runs', token);
}

function readJsonl(file) {
  const rows = [];
  let bad = 0;
  let lineNo = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    lineNo += 1;
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t));
    } catch {
      bad += 1;
    }
  }
  return { rows, bad };
}

/** 一个源 run：meta + 原始行（带行序，用于确定性 tie-break） */
function loadSource(name, opt, index) {
  const dir = resolveSourceDir(name, opt);
  const metaFile = path.join(dir, 'run-meta.json');
  const resFile = path.join(dir, 'results.jsonl');
  if (!fs.existsSync(metaFile)) fail(`源 ${name} 缺少 ${metaFile}`);
  if (!fs.existsSync(resFile)) fail(`源 ${name} 缺少 ${resFile}`);
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  } catch (err) {
    fail(`源 ${name} 的 run-meta.json 不是合法 JSON：${String(err && err.message)}`);
  }
  if (meta.v !== SCHEMA) fail(`源 ${name} 的 run-meta 版本不符：${meta.v}（期望 ${SCHEMA}）`);
  const { rows, bad } = readJsonl(resFile);
  if (bad) console.warn(`[merge][警告] 源 ${name} 的 results.jsonl 有 ${bad} 行解析失败，已跳过`);
  return {
    token: name,
    index,
    dir,
    metaFile,
    resFile,
    run: String(meta.run || path.basename(dir)),
    meta,
    rows: rows.map((r, i) => ({ row: r, order: i })),
  };
}

/* ------------------------------------------------------------------ 等值校验 */

function specOf(armEntry) {
  return {
    arm: String(armEntry?.arm ?? ''),
    preset: String(armEntry?.preset ?? ''),
    effort: String(armEntry?.effort ?? ''),
    effortEffective: String(armEntry?.effortEffective ?? ''),
    capNote: String(armEntry?.capNote ?? ''),
  };
}

function eq(v) {
  return v === undefined ? '∅' : v === null ? 'null' : typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** 必须逐项相等的字段：任一源不一致即 fatal */
const REQUIRED_FIELDS = [
  'model', 'provider', 'permissionPreset', 'toolGuard', 'allowTools',
  'maxTokens', 'systemPrompt', 'seed', 'sample', 'full', 'limit',
];

function checkCompatibility(sources) {
  const fatal = [];
  const warnings = [];
  const base = sources[0];

  /* 1) 题集指纹：键集合 + 每个键的 sha256 必须一致（bytes / file 路径只作提示） */
  const keys = new Set();
  for (const s of sources) for (const k of Object.keys(s.meta.datasets || {})) keys.add(k);
  if (!keys.size) fatal.push('所有源的 run-meta 都没有 datasets 指纹，判分器无法校验题集');
  for (const k of [...keys].sort()) {
    const seen = [];
    for (const s of sources) {
      const d = (s.meta.datasets || {})[k];
      if (!d) {
        fatal.push(`题集 ${k} 在源 ${s.run} 里没有记录（每个源必须是同一批题）`);
        continue;
      }
      seen.push({ run: s.run, ...d });
      for (const o of seen.slice(0, -1)) {
        if (String(o.sha256) !== String(d.sha256)) {
          fatal.push(`题集 ${k} 的 sha256 不一致：${o.run}=${eq(o.sha256)} vs ${s.run}=${eq(d.sha256)} → 不是同一批题，拒绝合并`);
        }
        if (String(o.file) !== String(d.file)) {
          warnings.push(`题集 ${k} 的文件路径不同（${o.run}=${eq(o.file)} / ${s.run}=${eq(d.file)}），但 sha256 相同；合并后沿用 ${o.run} 的路径`);
        }
      }
    }
  }

  /* 2) model / provider / effort 等影响结论可比性的字段 */
  for (const f of REQUIRED_FIELDS) {
    for (const s of sources.slice(1)) {
      if (eq(s.meta[f]) !== eq(base.meta[f])) {
        fatal.push(`${f} 不一致：${base.run}=${eq(base.meta[f])} vs ${s.run}=${eq(s.meta[f])} → 两批跑的不是同一个条件，拒绝合并`);
      }
    }
  }
  if (eq(base.meta.baseUrl) !== '∅') {
    for (const s of sources.slice(1)) {
      if (eq(s.meta.baseUrl) !== eq(base.meta.baseUrl)) {
        warnings.push(`baseUrl 不同：${base.run}=${eq(base.meta.baseUrl)} vs ${s.run}=${eq(s.meta.baseUrl)}（服务商端点差异请人工确认）`);
      }
    }
  }

  /* 3) effort / 臂规格：同名臂必须完全同规格；不同臂取并集 */
  const byArm = new Map();
  for (const s of sources) {
    const list = Array.isArray(s.meta.arms) ? s.meta.arms : [];
    if (!list.length) warnings.push(`源 ${s.run} 的 run-meta 里没有 arms，合并后的臂表可能不完整`);
    for (const entry of list) {
      const sp = specOf(entry);
      if (!sp.arm) {
        warnings.push(`源 ${s.run} 有一条没有 arm 名的 arm 记录，已忽略`);
        continue;
      }
      const prev = byArm.get(sp.arm);
      if (prev && eq(prev.spec) !== eq(sp)) {
        fatal.push(`臂 ${sp.arm} 的规格不一致：${prev.run} ${prevJSON(prev.spec)} vs ${s.run} ${prevJSON(sp)} → 同一臂跑在两档设置下，拒绝合并`);
      }
      if (!prev) byArm.set(sp.arm, { spec: sp, run: s.run });
    }
  }
  return { fatal, warnings, datasets: keys, armSpecs: new Map([...byArm].map(([k, v]) => [k, v.spec])) };
}

function prevJSON(sp) {
  return `preset=${sp.preset} effort=${sp.effort}→${sp.effortEffective}`;
}

/* ------------------------------------------------------------------ 合并 */

function rowKey(r) {
  return `${r.dataset}|${r.id}|${r.arm}|${r.warmup ? 1 : 0}`;
}

/** 确定性比较：先 at（ISO 串，字典序即时间序），再源顺序，再源内行序 */
function cmpItem(a, b) {
  const x = String(a.row.at || '');
  const y = String(b.row.at || '');
  if (x !== y) return x < y ? -1 : 1;
  if (a.srcIndex !== b.srcIndex) return a.srcIndex - b.srcIndex;
  return a.order - b.order;
}

function mergeRows(sources, dedupe) {
  const items = [];
  let malformed = 0;
  for (const s of sources) {
    for (const { row, order } of s.rows) {
      if (!row || typeof row !== 'object' || !row.dataset || !row.id || !row.arm) {
        malformed += 1;
        continue;
      }
      items.push({ key: rowKey(row), row, srcIndex: s.index, order });
    }
  }
  const groups = new Map();
  for (const it of items) {
    if (!groups.has(it.key)) groups.set(it.key, []);
    groups.get(it.key).push(it);
  }
  const kept = [];
  const collapsedKeys = [];
  let collapsed = 0;
  for (const [key, list] of groups) {
    list.sort(cmpItem);
    /* latest：同键只留 at 最新的一条（末尾即最新）；keep-all：全部原样保留（重跑行不压） */
    if (dedupe === 'keep-all') kept.push(...list);
    else kept.push(list[list.length - 1]);
    if (list.length > 1) {
      collapsed += list.length - 1;
      collapsedKeys.push(`${key}×${list.length}`);
    }
  }
  kept.sort(cmpItem);
  return {
    kept: kept.map((it) => it.row),
    raw: sources.reduce((n, s) => n + s.rows.length, 0),
    collapsed,
    collapsedKeys: collapsedKeys.slice(0, 20),
    malformed,
  };
}

/* ------------------------------------------------------------------ 统计 */

function armNameSort(a, b) {
  const ia = ARM_ORDER.indexOf(a);
  const ib = ARM_ORDER.indexOf(b);
  if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  return a < b ? -1 : 1;
}

function stats(keptRows) {
  const arms = new Set();
  const scoredByDataset = new Map();
  const byKeyArm = new Map(); // dataset|id -> Set(arm)
  const perArm = new Map();
  for (const r of keptRows) {
    arms.add(r.arm);
    const isWarm = r.warmup === true || r.dataset === 'warmup';
    if (!perArm.has(r.arm)) perArm.set(r.arm, { total: 0, scored: 0, ok: 0, warmup: 0 });
    const pa = perArm.get(r.arm);
    pa.total += 1;
    if (isWarm) {
      pa.warmup += 1;
      continue;
    }
    pa.scored += 1;
    if (r.status === 'ok') pa.ok += 1;
    if (!scoredByDataset.has(r.dataset)) scoredByDataset.set(r.dataset, new Set());
    scoredByDataset.get(r.dataset).add(r.id);
    const pk = `${r.dataset}|${r.id}`;
    if (!byKeyArm.has(pk)) byKeyArm.set(pk, new Set());
    byKeyArm.get(pk).add(r.arm);
  }
  const armList = [...arms].sort(armNameSort);
  const pairs = [];
  for (let i = 0; i < armList.length; i++) {
    for (let j = i + 1; j < armList.length; j++) {
      const A = armList[i];
      const B = armList[j];
      let both = 0;
      for (const set of byKeyArm.values()) if (set.has(A) && set.has(B)) both += 1;
      pairs.push({ pair: `${A}+${B}`, problems: both });
    }
  }
  const problems = Object.fromEntries([...scoredByDataset].map(([d, set]) => [d, set.size]));
  return { armList, problems, pairs, perArm, uniqueProblems: byKeyArm.size };
}

/* ------------------------------------------------------------------ 主流程 */

function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(opt.benchRoot)) fail(`找不到评测根目录：${opt.benchRoot}（--bench-root 指定）`);

  const outDir = /[\\/]/.test(opt.out) || /^[a-zA-Z]:/.test(opt.out)
    ? path.resolve(opt.out)
    : path.join(opt.benchRoot, 'runs', opt.out);
  const outName = path.basename(outDir);

  const sources = opt.sources.map((t, i) => loadSource(t, opt, i));
  const absSources = sources.map((s) => path.resolve(s.dir));
  if (absSources.includes(path.resolve(outDir))) {
    fail(`目标目录不能是源目录之一（${path.resolve(outDir)}）—— 合并是「只读源 + 新建目标」，不覆盖原件`);
  }
  const outResults = path.join(outDir, 'results.jsonl');
  const outMeta = path.join(outDir, 'run-meta.json');
  if (!opt.dryRun && fs.existsSync(outResults) && !opt.force) {
    fail(`${outResults} 已存在。确认要覆盖再加 --force（或用 --out 换个名字）`);
  }

  console.log(`[merge] 源：${sources.map((s) => `${s.run}(${path.relative(opt.benchRoot, s.dir) || s.dir})`).join(' + ')}`);
  console.log(`[merge] 目标：${outDir} · 去重策略 ${opt.dedupe}`);

  const { fatal, warnings, datasets, armSpecs } = checkCompatibility(sources);
  if (fatal.length) {
    for (const m of [...new Set(fatal)]) console.error(`[merge][错误] ${m}`);
    process.exit(1);
  }
  for (const w of [...new Set(warnings)]) console.warn(`[merge][警告] ${w}`);

  const merged = mergeRows(sources, opt.dedupe);
  const st = stats(merged.kept);
  const base = sources[0].meta;

  console.log(`[merge] 题集指纹一致：${[...datasets].sort().map((k) => `${k}=${String((base.datasets || {})[k]?.sha256 || '').slice(0, 12)}…`).join(' · ')}`);
  console.log(`[merge] 原始行 ${merged.raw} → 合并后 ${merged.kept.length}（压掉重复键 ${merged.collapsed} 行${merged.malformed ? ` · 坏行 ${merged.malformed}` : ''}）`);
  console.log(`[merge] 臂：${st.armList.join(' / ')}`);
  for (const a of st.armList) {
    const p = st.perArm.get(a) || {};
    console.log(`        ${a.padEnd(9)} 计分 ${p.scored ?? 0} 行（ok=${p.ok ?? 0}）· 预热 ${p.warmup ?? 0} 行`);
  }
  console.log(`[merge] 唯一题目 ${st.uniqueProblems} 道：${Object.entries(st.problems).map(([d, n]) => `${d}=${n}`).join(' · ')}`);
  for (const p of st.pairs) console.log(`        可配对 ${p.pair} = ${p.problems} 题`);

  const mergedMeta = {
    v: SCHEMA,
    generatedAt: new Date().toISOString(),
    run: outName,
    merged: true,
    mergedBy: 'scripts/bench/merge-runs.mjs',
    dedupe: opt.dedupe,
    dedupeKey: '(dataset,id,arm,warmup)',
    sources: sources.map((s) => ({
      run: s.run,
      dir: s.dir,
      generatedAt: s.meta.generatedAt ?? null,
      rowsRaw: s.rows.length,
      arms: (Array.isArray(s.meta.arms) ? s.meta.arms : []).map((a) => specOf(a).arm),
    })),
    arms: [...armSpecs.values()].sort((x, y) => armNameSort(x.arm, y.arm)),
    model: base.model,
    provider: base.provider,
    baseUrl: base.baseUrl,
    permissionPreset: base.permissionPreset,
    maxTokens: base.maxTokens ?? null,
    systemPrompt: base.systemPrompt ?? '',
    toolGuard: base.toolGuard,
    allowTools: base.allowTools,
    warmup: base.warmup,
    concurrency: base.concurrency,
    timeoutMs: base.timeoutMs,
    retries: base.retries,
    seed: base.seed,
    sample: base.sample,
    full: base.full,
    limit: base.limit,
    datasets: Object.fromEntries(
      [...datasets].map((k) => [k, {
        ...((base.datasets || {})[k] || {}),
        sources: sources.filter((s) => (s.meta.datasets || {})[k]).map((s) => s.run),
      }]),
    ),
    problems: st.problems,
    plannedRuns: merged.kept.length,
    merge: {
      rowsRaw: merged.raw,
      rowsKept: merged.kept.length,
      rowsCollapsed: merged.collapsed,
      collapsedExamples: merged.collapsedKeys,
      malformedRows: merged.malformed,
      requiredEqual: ['datasets.sha256', ...REQUIRED_FIELDS, 'arms[].(preset,effort,effortEffective,capNote)'],
      warnings: [...new Set(warnings)],
      note: '本目录由多个 run 合并而来，原件未被改动；判分时用 --arms a,b 任取两臂配对（score.mjs 是两臂配对器）。',
    },
    sourceMeta: Object.fromEntries(sources.map((s) => [s.run, s.meta])),
  };

  if (opt.dryRun) {
    console.log('[merge] —— dry-run：只做校验与统计，不落盘 ——');
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outResults, merged.kept.map((r) => JSON.stringify(r)).join('\n') + (merged.kept.length ? '\n' : ''), 'utf8');
  fs.writeFileSync(outMeta, JSON.stringify(mergedMeta, null, 2) + '\n', 'utf8');

  /* 写完立刻回读自检：行数与臂集合必须和内存里一致 */
  const reread = readJsonl(outResults);
  const backArms = new Set(reread.rows.map((r) => r.arm));
  if (reread.rows.length !== merged.kept.length || backArms.size !== st.armList.length) {
    fail(`回读校验失败：落盘 ${reread.rows.length} 行 / 臂 ${[...backArms].join(',')}，期望 ${merged.kept.length} 行 / 臂 ${st.armList.join(',')}`);
  }
  console.log(`[merge] 已写出：${outResults}（${reread.rows.length} 行）`);
  console.log(`[merge] 已写出：${outMeta}`);
  console.log('[merge] 判分：node scripts/bench/score.mjs --run ' + outName + ' --arms <A>,<B>');
}

try {
  main();
} catch (err) {
  console.error('[merge][错误] ' + String((err && err.stack) || err).split('\n').slice(0, 3).join(' | '));
  process.exitCode = 1;
}
