"use strict";
/* MATH-500（难档）判分器与统一题目契约冒烟测试（纯 Node，无 DOM）
 *   node test/smoke-bench-math-grade.js
 * 背景：Agent 预设实测链的本地工具在 scripts/ 下，而 .gitignore 第 10 行整体忽略 scripts/，
 *       所以本测试全程用 fs.existsSync 守卫 —— 脚本或题集缺失时判为「跳过」（不算失败，退出码 0）。
 * 覆盖：
 *   [1] 本地评测件存在性守卫（scripts/bench 缺失即整体 SKIP 并通过）
 *   [2] score.mjs --selftest 独立可跑（空 --bench-root、不读 run 目录）：退出码 0、用例 ≥10 且全过
 *   [3] 统一题目契约静态断言（fetch-data 落盘字段 / 难档过滤 / run-bench 认嵌套 gold / score 判分接线）
 *   [4] 难档题集产物动态断言（仓库外 %LOCALAPPDATA%\mtnode-bench\datasets：字段、id、level、sha256）
 *   [5] 反向自查：runner 不再镜像任何「按预设压档」；没有任何测试 import run-bench.mjs（顶层自执行 main 会真起网关烧 token）
 */
const fs = require("fs");
const os = require("os");
const cp = require("child_process");
const path = require("path");
const crypto = require("crypto");

let fails = 0;
let checks = 0;
let skips = 0;
function ok(cond, msg) {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
}
function skip(msg) {
  skips++;
  console.log("  skip  " + msg);
}
const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel.split("/").join(path.sep)));
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/* 评测根目录：与 run-bench/score 的 defaultBenchRoot() 同口径（MTNODE_BENCH_ROOT 优先） */
const benchRoot =
  process.env.MTNODE_BENCH_ROOT ||
  path.join(
    process.platform === "win32" ? process.env.LOCALAPPDATA || "" : path.join(os.homedir(), ".local", "share"),
    "mtnode-bench",
  );
/* 数据集目录：与 fetch-data.mjs 同口径（MTNODE_BENCH_DIR 指的是「数据集目录」） */
const datasetDir =
  process.env.MTNODE_BENCH_DIR || path.join(benchRoot, "datasets");

const SCORE = "scripts/bench/score.mjs";
const FETCH = "scripts/bench/fetch-data.mjs";
const RUNNER = "scripts/bench/run-bench.mjs";

console.log("\n[1] 本地评测件存在性守卫（scripts/ 被 .gitignore 忽略，缺失即跳过）");
if (!exists(SCORE)) {
  skip("找不到 scripts/bench/score.mjs（评测本地件未随仓库分发）—— 本测试整体跳过");
  if (exists(FETCH) || exists(RUNNER)) {
    ok(false, "scripts/bench 下存在其它本地件时 score.mjs 也必须在位");
  } else {
    ok(true, "scripts/bench 整体缺失（与 .gitignore 一致）");
  }
  console.log(
    "\n" +
      (fails ? "FAILED " + fails + " / " + checks + " checks" : "ALL OK  " + checks + " checks") +
      "（跳过 " + skips + " 项）",
  );
  process.exit(fails ? 1 : 0);
}
ok(true, "scripts/bench/score.mjs 在位");
const hasFetch = exists(FETCH);
const hasRunner = exists(RUNNER);
ok(hasFetch, "scripts/bench/fetch-data.mjs 在位");
ok(hasRunner, "scripts/bench/run-bench.mjs 在位");

console.log("\n[2] score.mjs --selftest：判分器自测不依赖 run 目录");
const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-bench-selftest-"));
let st = null;
try {
  st = cp.spawnSync(process.execPath, [path.join(ROOT, SCORE), "--selftest", "--bench-root", emptyRoot], {
    encoding: "utf8",
    cwd: ROOT,
  });
} finally {
  fs.rmSync(emptyRoot, { recursive: true, force: true });
}
if (!st || st.error) {
  ok(false, "跑 score.mjs --selftest 失败：" + String((st && st.error && st.error.message) || "unknown").slice(0, 160));
} else {
  const out = String(st.stdout || "") + String(st.stderr || "");
  ok(st.status === 0, "--selftest 退出码 0（空 --bench-root 也跑得通 = 不读 run 目录、不联网）");
  const m = out.match(/判分自测\s+(\d+)\/(\d+)\s+通过/);
  ok(!!m, "--selftest 打印「MATH-500 判分自测 N/N 通过」汇总行");
  if (m) {
    const passed = Number(m[1]);
    const total = Number(m[2]);
    ok(total >= 10, "--selftest 用例数 ≥ 10（实际 " + total + " 例）");
    ok(passed === total, "--selftest 全部通过（" + passed + "/" + total + "）");
    ok(out.indexOf("✗") < 0, "--selftest 无失败用例输出");
  }
  const help = cp.spawnSync(process.execPath, [path.join(ROOT, SCORE), "--help"], { encoding: "utf8", cwd: ROOT });
  ok(help.status === 0, "score.mjs --help 退出码 0");
  ok(/MATH-500/.test(String(help.stdout || "")), "--help 说明含 MATH-500 判分口径");
}

console.log("\n[3] 统一题目契约静态断言（取数 → runner → 判分 三处同口径）");
if (hasFetch) {
  const fetchSrc = read(FETCH);
  ok(
    /math500:\s*\[[^\]]*'dataset'[^\]]*'id'[^\]]*'question'[^\]]*'gold'[^\]]*\]/.test(fetchSrc),
    "fetch-data 的 math500 必备字段 = dataset/id/question/gold",
  );
  ok(
    /for \(const k of \['answer', 'solution', 'level'\]\)/.test(fetchSrc),
    "fetch-data 逐个校验 gold 的三个子字段（answer/solution/level）",
  );
  ok(/math500#/.test(fetchSrc), "fetch-data 为 math500 写入稳定题目 id");
  ok(
    /filterRows:[^\n]*Number\(o\?\.gold\?\.level\)\s*>=\s*4/.test(fetchSrc),
    "难档抽样池按 level ≥ 4 过滤（三难度阶梯的 L3）",
  );
  ok(/sampleBase:\s*'math500'/.test(fetchSrc), "抽样文件名基名固定为 math500");
  ok(/id 唯一/.test(fetchSrc) || /题目 id 不唯一/.test(fetchSrc), "fetch-data 断言题目 id 唯一（判分与断点续跑可对齐）");
  ok(/contract:\s*\{/.test(fetchSrc) && /math500:\s*'dataset\/id\/question\/gold/.test(fetchSrc), "manifest.json 登记 math500 题目契约");
  ok(/budgetOk|1GB|预算/.test(fetchSrc), "取数脚本保留体积预算核对");
} else {
  skip("fetch-data.mjs 缺失 —— 跳过取数侧契约断言");
}
if (hasRunner) {
  const runSrc = read(RUNNER);
  ok(/math500-sample-n\$\{n\}-seed\$\{s\}/.test(runSrc), "runner 的 math500 子集文件名与 fetch-data 产物同名（否则直接报缺题集）");
  ok(/if \(key === 'math500'\)/.test(runSrc), "runner 有 math500 题目归一分支");
  ok(/obj\.problem \|\| obj\.question/.test(runSrc), "runner 同时认官方 problem 与契约 question 两种题面字段");
  ok(/const g = obj\.gold && typeof obj\.gold === 'object'/.test(runSrc), "runner 认统一契约的嵌套 gold（2026-09-04 四臂全灭的根因修复）");
  ok(/answerSource:/.test(runSrc), "runner 记录 gold 来源（contract-gold / flat-answer / solution-fallback）可追溯");
  ok(/id: `math500#\$\{_line\}`/.test(runSrc), "runner 的题目 id 用题集文件物理行号（与 score 的 byLine 口径一致）");
  ok(/'Solve the following competition math problem\.'/.test(runSrc), "runner 的 math500 题面模板在位");
  ok(/'ANSWER = <final answer>'/.test(runSrc), "math500 题面要求末行单独输出 ANSWER = 最终答案");
  ok(
    runSrc.indexOf("do not read or write files, do not run commands, do not search the web.") >= 0,
    "math500 沿用 gsm8k 同一句工具闸门（三难度都只用推理作答）",
  );
  ok(!/effortCap:/.test(runSrc), "反向自查：runner 无 ARMS[].effortCap 降档镜像残留");
  ok(!/effortEffectiveFor\s*\(/.test(runSrc), "反向自查：runner 无 effortEffectiveFor() 降档函数残留");
  ok(/effortEffective:\s*opt\.effort/.test(runSrc), "生效档 == 请求档（effortEffective 直接取 --effort）");
} else {
  skip("run-bench.mjs 缺失 —— 跳过 runner 侧契约断言");
}
{
  const scoreSrc = read(SCORE);
  ok(/function extractMathAnswer\(/.test(scoreSrc), "score 有 MATH-500 答案抽取器");
  ok(/function normMath\(/.test(scoreSrc), "score 有 LaTeX/数字归一化器");
  ok(/function mathEquiv\(/.test(scoreSrc), "score 有等价性比较器（数值/容器/文本三级）");
  ok(/function math500Grade\(/.test(scoreSrc), "score 有 math500Grade 判分入口");
  ok(/function mathGoldRaw\(/.test(scoreSrc), "score 有 gold 兜底回查（run 无 gold 时问题集文件）");
  const ex = scoreSrc.slice(scoreSrc.indexOf("function extractMathAnswer("), scoreSrc.indexOf("function normMath("));
  const iBoxed = ex.indexOf("boxed");
  const iAnswer = ex.indexOf("ANSWER");
  ok(iBoxed >= 0 && iAnswer >= 0 && iBoxed < iAnswer, "抽取优先级：\\\\boxed{} 先于行首 ANSWER =");
  ok(
    /dataset === 'math500' \|\| dataset === 'math-500' \|\| dataset === 'math'/.test(scoreSrc),
    "判分分支认 math500 / math-500 / math 三种数据集别名",
  );
  ok(/byLine\.get\(id\)\) \|\| \(v\.byId/.test(scoreSrc), "题集定位：物理行号索引优先于行内自带 id（防 18 个重叠值拿错 gold）");
  ok(/rec\.goldSource = gm\.source/.test(scoreSrc), "判分记录写 goldSource（可复核来源）");
  ok(/mathReviewArtifacts/.test(scoreSrc), "未判对的 MATH 题落可复核产物并计入 results.json");
  ok(/gold-unparsable/.test(scoreSrc) && /'no-answer'/.test(scoreSrc), "抽取失败/gold 不可解析都判错并留原因码");
}

console.log("\n[4] 难档题集产物动态断言（题集在仓库外，缺失即跳过）");
const sampleRel = path.join("math500", "math500-sample-n100-seed1234.jsonl");
const sampleAbs = path.join(datasetDir, sampleRel);
const manifestAbs = path.join(datasetDir, "manifest.json");
if (!fs.existsSync(sampleAbs)) {
  skip("题集未取数（" + sampleAbs + " 不存在）—— 跳过产物动态断言，跑 node scripts/bench/fetch-data.mjs 后可覆盖");
} else {
  const buf = fs.readFileSync(sampleAbs);
  const rows = buf
    .toString("utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  ok(rows.length === 100, "难档子集恰为 100 题（实际 " + rows.length + "）");
  const badShape = rows.filter(
    (o) =>
      o.dataset !== "math500" ||
      !/^math500#\d+$/.test(String(o.id || "")) ||
      !String(o.question || "").trim() ||
      !o.gold ||
      typeof o.gold !== "object" ||
      !String(o.gold.answer || "").trim() ||
      !String(o.gold.solution || "").trim() ||
      !(Number(o.gold.level) >= 4),
  );
  ok(badShape.length === 0, "每题都满足契约 dataset/id/question/gold{answer,solution,level} 且 level ≥ 4（不合规 " + badShape.length + " 题）");
  ok(new Set(rows.map((o) => o.id)).size === rows.length, "题目 id 在子集内唯一");
  const levels = new Set(rows.map((o) => Number(o.gold.level)));
  ok([...levels].every((l) => l === 4 || l === 5) && levels.size >= 1, "level 取值只落在 4/5（难档）");
  if (fs.existsSync(manifestAbs)) {
    const man = JSON.parse(fs.readFileSync(manifestAbs, "utf8"));
    const rel = "math500/" + path.basename(sampleAbs);
    const entry = (man.files || []).find((f) => f.file === rel);
    ok(!!entry, "manifest.json 登记了 " + rel);
    if (entry) {
      ok(sha256(buf) === entry.sha256, "子集 sha256 与 manifest 一致（score 判分前的题集校验前提成立）");
      ok(entry.bytes === buf.length, "子集字节数与 manifest 一致");
    }
    ok(!!(man.contract && man.contract.math500), "manifest.contract.math500 在位");
  } else {
    skip("manifest.json 缺失 —— 跳过 sha256 对照");
  }
}

console.log("\n[5] 反向自查：测试侧不得自执行 runner");
const testDir = path.join(__dirname);
const importers = [];
for (const f of fs.readdirSync(testDir)) {
  if (!/\.js$/.test(f)) continue;
  const src = fs.readFileSync(path.join(testDir, f), "utf8");
  if (/(require|import)\s*\(\s*['"][^'"]*run-bench\.mjs['"]/.test(src) || /await import\([^)]*run-bench\.mjs/.test(src)) {
    importers.push(f);
  }
}
ok(importers.length === 0, "没有任何测试 require/import run-bench.mjs（其顶层自执行 main() 会真起网关烧 token）：" + (importers.join(", ") || "0 处"));
{
  const runSrc = hasRunner ? read(RUNNER) : "";
  ok(!hasRunner || /main\(\)\.catch\(/.test(runSrc), "run-bench.mjs 顶层自执行 main().catch(...)（正是上面禁止测试 require/import 它的原因）");
}

console.log(
  "\n" +
    (fails ? "FAILED " + fails + " / " + checks + " checks" : "ALL OK  " + checks + " checks") +
    (skips ? "（跳过 " + skips + " 项）" : ""),
);
process.exit(fails ? 1 : 0);
