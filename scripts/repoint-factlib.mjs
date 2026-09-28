/**
 * 事实库路径重新指向（migrate-factlib.mjs 的收尾补丁版）。
 *
 * 什么时候用：库目录已经在磁盘上搬好了，但 config.json 里 team.canvases[<canvas>].fact 的
 * 绝对路径还指着旧目录（典型场景：迁移时 MTNode 没关，应用退出 / 定时回写又把内存里的旧配置
 * 覆盖到了 config.json）。本脚本只做「把路径改到新目录」，不碰磁盘上的库文件。
 *
 * 用法（**先完全退出 MTNode 再跑**）:
 *   node scripts/repoint-factlib.mjs --canvas wf_mtghgelb \
 *     --from E:\dev\tools\pipeline-console\团队事实库 \
 *     --to   E:\dev\tools\tutorial\mtnode_arch\团队事实库
 *
 * 只改该画布 fact 的 dir / assetsDir / file / reviewFile / docs[].file / docs[].reviewFile，
 * 以及该画布条目的 workspace（后者仅在源文件确实写了值时）。写前留 .bak-repoint-<时间戳> 备份，
 * 写后回读自检。别的一律不动。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const arg = (n, d = "") => {
  const i = argv.indexOf(n);
  return i >= 0 ? String(argv[i + 1] || "") : d;
};
const canvasId = arg("--canvas").trim();
const from = arg("--from").trim().replace(/[\\/]+$/, "");
const to = arg("--to").trim().replace(/[\\/]+$/, "");
const wantHelp = argv.includes("-h") || argv.includes("--help");

const HELP = `事实库路径重新指向（scripts/repoint-factlib.mjs）

  node scripts/repoint-factlib.mjs --canvas <画布 id> --from <旧库目录> --to <新库目录>

  --canvas  画布 id（如 wf_mtghgelb）
  --from    旧库目录（config.json 里当前记着的那个）
  --to      新库目录（磁盘上库实际所在的位置）
  -h/--help 显示本说明

跑之前请先完全退出 MTNode，否则应用会用内存里的旧配置把改动覆盖回去。`;

if (wantHelp) {
  console.log(HELP);
  process.exit(0);
}
if (!canvasId || !from || !to) {
  console.log(HELP);
  process.exit(2);
}

const APPDATA_DIR = process.env.MTNODE_APPDATA_DIR
  ? path.resolve(process.env.MTNODE_APPDATA_DIR)
  : path.join(os.homedir(), "AppData", "Roaming", "pipeline-console", "pipeline-console");
const CONFIG = path.join(APPDATA_DIR, "config.json");
const SAVE = path.join(APPDATA_DIR, "save", `${canvasId}.json`);

function appRunning() {
  try {
    const r = spawnSync("tasklist", ["/NH"], { encoding: "utf8", windowsHide: true });
    return /MTNode[A-Za-z]*\.exe/i.test(r.stdout || "");
  } catch {
    return false;
  }
}

if (appRunning()) {
  console.error("⚠ 检测到 MTNode 正在运行：请先完全退出应用再跑本脚本。");
  console.error("  （应用持有内存配置并会定时回写，运行中改 config.json 会被覆盖回去。）");
  process.exit(1);
}

if (!fs.existsSync(CONFIG)) {
  console.error(`找不到配置：${CONFIG}`);
  process.exit(1);
}
if (!fs.existsSync(to)) {
  console.error(`新库目录不存在：${to}\n  （先确认库已经搬到那里，本脚本不搬文件。）`);
  process.exit(1);
}

const low = (s) => String(s).toLowerCase();
const remap = (v) => {
  if (typeof v !== "string" || !v) return v;
  const a = v.replace(/[\\/]+$/, "");
  if (low(a) === low(from)) return to;
  if (low(a).startsWith(low(from) + path.sep) || low(a).startsWith(low(from) + "/"))
    return to + a.slice(from.length);
  return v;
};

const cfgText = fs.readFileSync(CONFIG, "utf8").replace(/^\uFEFF/, "");
const cfg = JSON.parse(cfgText);
const canvas = ((cfg.team && cfg.team.canvases) || []).find((c) => c && c.id === canvasId);
if (!canvas) {
  console.error(`config.json 里找不到画布 ${canvasId}`);
  process.exit(1);
}
const fact = canvas.fact && typeof canvas.fact === "object" ? canvas.fact : null;
if (!fact) {
  console.error(`画布 ${canvasId} 没有已建的事实库（fact 为空），无需改路径。`);
  process.exit(1);
}

const bak = `${CONFIG}.bak-repoint-${Date.now()}`;
fs.copyFileSync(CONFIG, bak);

let changed = 0;
const set = (o, k) => {
  if (!o || typeof o[k] !== "string") return;
  const b = o[k];
  o[k] = remap(b);
  if (b !== o[k]) {
    changed++;
    console.log(`  ${k}: ${b} → ${o[k]}`);
  }
};
set(fact, "dir");
set(fact, "assetsDir");
set(fact, "file");
set(fact, "reviewFile");
for (const d of Array.isArray(fact.docs) ? fact.docs : []) {
  set(d, "file");
  set(d, "reviewFile");
}

/* workspace：指向旧库所在目录时才改（空值不补，交给应用 / 迁移脚本处理）。 */
if (typeof canvas.workspace === "string" && canvas.workspace.trim()) {
  const w = canvas.workspace.trim().replace(/[\\/]+$/, "");
  if (low(w) === low(path.dirname(from))) {
    console.log(`  workspace: ${canvas.workspace} → ${path.dirname(to)}`);
    canvas.workspace = path.dirname(to);
    changed++;
  }
}

if (!changed) {
  console.log("无需改动：路径已经指向目标目录。");
  fs.rmSync(bak, { force: true });
  process.exit(0);
}

let saveBak = "";
if (fs.existsSync(SAVE)) {
  const sText = fs.readFileSync(SAVE, "utf8").replace(/^\uFEFF/, "");
  try {
    const s = JSON.parse(sText);
    if (typeof s.workspace === "string" && s.workspace.trim()) {
      const w = s.workspace.trim().replace(/[\\/]+$/, "");
      if (low(w) === low(path.dirname(from))) {
        s.workspace = path.dirname(to);
        saveBak = `${SAVE}.bak-repoint-${Date.now()}`;
        fs.copyFileSync(SAVE, saveBak);
        fs.writeFileSync(SAVE, JSON.stringify(s, null, 2) + "\n", "utf8");
        console.log(`  ${path.basename(SAVE)} 的 workspace → ${s.workspace}`);
      }
    }
  } catch (e) {
    console.error(`（提示：${path.basename(SAVE)} 解析失败，跳过：${e.message}）`);
  }
}

fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + "\n", "utf8");

/* 自检：回读确认已指向新目录。 */
const check = JSON.parse(fs.readFileSync(CONFIG, "utf8").replace(/^\uFEFF/, ""));
const f2 = check.team.canvases.find((c) => c && c.id === canvasId).fact || {};
const bad = [];
if (f2.dir && low(f2.dir.replace(/[\\/]+$/, "")) !== low(to)) bad.push(`fact.dir = ${f2.dir}`);
if (f2.file && !low(f2.file).startsWith(low(to))) bad.push(`fact.file = ${f2.file}`);
for (const d of Array.isArray(f2.docs) ? f2.docs : []) {
  if (d.file && !low(d.file).startsWith(low(to))) bad.push(`docs[].file = ${d.file}`);
}
if (bad.length) {
  console.error("自检未通过：" + bad.join("；"));
  console.error(`备份在 ${bak}，可手工恢复。`);
  process.exit(1);
}
console.log(`已改写 ${changed} 个路径字段；fact.dir = ${f2.dir}`);
console.log(`备份：${bak}${saveBak ? "\n      " + saveBak : ""}`);
