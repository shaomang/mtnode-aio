/**
 * 团队事实库迁移：把某个画布已建的事实库整目录搬到项目文件夹，并回写所有绝对路径引用。
 *
 * 背景：事实库落点口径已改为「画布工作区 / 用户选定的项目文件夹根 → <根>/团队事实库/」，
 * 旧的「应用数据目录 facts/<canvasId>/」回退已取消（见 renderer/app-factlib.js 与 main.js
 * 的 factLibDirOf）。已经建在应用目录 / 仓库根里的库需要搬到对应项目文件夹。
 *
 * 用法（**先关闭 MTNode 再跑**，避免与应用运行时的配置回写打架）:
 *   node scripts/migrate-factlib.mjs --canvas wf_mtghgelb --to E:\dev\tools\tutorial\mtnode_arch
 *   node scripts/migrate-factlib.mjs --canvas wf_mtghgelb --to <目录> --dry-run   # 只体检不动盘
 *   环境变量 MTNODE_APPDATA_DIR 可指向别的应用数据根（测试 / 非默认安装用）。
 *
 * 做三件事：
 *   ① 把 <旧库目录> 整目录（*.md / *.review.json / assets/ …）搬到 <目标>/团队事实库/
 *      —— 同盘优先 rename，跨盘则复制后校验再删；目标同名文件与源逐字节一致才跳过，绝不覆盖。
 *   ② 回写引用该库绝对路径的两处配置（**只改结构化字段**，不做全文替换：config.json 里还存着
 *      历史会话 / 任务书正文，正文里的旧路径是归档文字，不得篡改）：
 *      - %APPDATA%\pipeline-console\pipeline-console\config.json 里
 *        team.canvases[<canvas>].fact 的 dir / assetsDir / file / reviewFile / docs[].file
 *        / docs[].reviewFile，以及该画布条目的 workspace；
 *      - %APPDATA%\pipeline-console\pipeline-console\save\wf_<canvas>.json 的 workspace。
 *      （workspace 只在源文件确实写了值时回写；迁移不许用空值抹掉已定的项目文件夹。）
 *   ③ 写前备份（config.json 与 wf_<canvas>.json 各留一份 .bak-<时间戳>）、写前校验旧路径与磁盘
 *      存在性、写后自检（新路径文件齐全、旧目录已空、结构化字段无旧路径、JSON 仍可解析）；
 *      配置写入失败会把库搬回原处，不留半成品。
 *
 * 幂等：旧目录已不存在（或已等于目标目录）且配置已指向新目录 → 直接报告「已完成」，退出码 0。
 * 只碰这两个 JSON 里的路径字段与库目录本身，不改任何别的配置项。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const LIB_NAME = "团队事实库";

/* ───────────────────────── 参数 ───────────────────────── */

function parseArgs(argv) {
  const o = { canvas: "", to: "", dryRun: false, help: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run" || a === "-n") o.dryRun = true;
    else if (a === "--force") o.force = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else if (a === "--canvas") o.canvas = String(argv[++i] || "").trim();
    else if (a.startsWith("--canvas=")) o.canvas = a.slice(9).trim();
    else if (a === "--to") o.to = String(argv[++i] || "").trim();
    else if (a.startsWith("--to=")) o.to = a.slice(5).trim();
    else {
      console.error(`未知参数：${a}（用 --help 看用法）`);
      process.exit(2);
    }
  }
  return o;
}

const HELP = `团队事实库迁移（scripts/migrate-factlib.mjs）

  node scripts/migrate-factlib.mjs --canvas <画布 id> --to <项目文件夹根> [--dry-run]

  --canvas   画布 id（如 wf_mtghgelb），决定读哪条 team.canvases 与哪个 wf_<id>.json
  --to       项目文件夹根目录；库会被搬进 <to>${path.sep}${LIB_NAME}${path.sep}
  --dry-run  只打印将要做的改动，不写盘
  --force    跳过「应用是否在运行」的检查（正常迁移不要用）
  -h/--help  显示本说明

注意：**跑之前先关闭 MTNode**，否则应用退出时可能用旧配置覆盖回写结果。`;

/* ───────────────────────── 路径 ───────────────────────── */

/* 应用数据根：默认 %APPDATA%\pipeline-console\pipeline-console。
   环境变量 MTNODE_APPDATA_DIR 可覆盖（测试 / 非默认安装用），默认口径不变。 */
const APPDATA_DIR = process.env.MTNODE_APPDATA_DIR
  ? path.resolve(process.env.MTNODE_APPDATA_DIR)
  : path.join(os.homedir(), "AppData", "Roaming", "pipeline-console", "pipeline-console");
const CONFIG_PATH = path.join(APPDATA_DIR, "config.json");
const SAVE_DIR = path.join(APPDATA_DIR, "save");

const stamp = () => {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
};

const norm = (p) => path.resolve(String(p)).replace(/[\\/]+$/, "").toLowerCase();
const isSub = (child, parent) => {
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p + path.sep);
};
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* 逐个文件比对（字节一致才算同）；目录则递归比对相对路径集合与内容。 */
function sameTree(a, b) {
  const sa = fs.statSync(a);
  const sb = fs.statSync(b);
  if (sa.isDirectory() !== sb.isDirectory()) return false;
  if (!sa.isDirectory()) {
    if (sa.size !== sb.size) return false;
    return Buffer.compare(fs.readFileSync(a), fs.readFileSync(b)) === 0;
  }
  const rel = (dir) => {
    const out = [];
    const walk = (d, pre) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
        const r = pre ? pre + "/" + e.name : e.name;
        if (e.isDirectory()) walk(path.join(d, e.name), r);
        else out.push(r);
      }
    };
    walk(dir, "");
    return out;
  };
  const ra = rel(a);
  const rb = rel(b);
  if (ra.length !== rb.length || ra.some((v, i) => v !== rb[i])) return false;
  return ra.every((r) => Buffer.compare(fs.readFileSync(path.join(a, r)), fs.readFileSync(path.join(b, r))) === 0);
}

function walkFiles(dir) {
  const out = [];
  const walk = (d, pre) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
      const full = path.join(d, e.name);
      const r = pre ? pre + "/" + e.name : e.name;
      if (e.isDirectory()) walk(full, r);
      else out.push({ rel: r, full, size: fs.statSync(full).size });
    }
  };
  if (fs.existsSync(dir)) walk(dir, "");
  return out;
}

/* ───────────────────────── 应用是否在跑 ───────────────────────── */

function appRunning() {
  try {
    /* 打包后的进程名是 MTNodeAIO.exe；再兜一层模糊匹配，避免改名 / 开发态漏判。 */
    const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq MTNodeAIO.exe", "/NH"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (/MTNode[A-Za-z]*\.exe/i.test(r.stdout || "")) return true;
    const all = spawnSync("tasklist", ["/NH"], { encoding: "utf8", windowsHide: true });
    return /MTNode[A-Za-z]*\.exe/i.test(all.stdout || "");
  } catch {
    return false;
  }
}

/* ───────────────────────── 搬目录 ───────────────────────── */

function moveLibrary(oldDir, newDir, log) {
  fs.mkdirSync(newDir, { recursive: true });
  const items = fs.readdirSync(oldDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  let moved = 0;
  let skipped = 0;
  for (const it of items) {
    const src = path.join(oldDir, it.name);
    const dst = path.join(newDir, it.name);
    if (fs.existsSync(dst)) {
      if (sameTree(src, dst)) {
        /* 目标已有完全相同的副本 → 删掉源件（内容一致，删源不丢数据），保证库可整体搬到目标。 */
        log(`  = 跳过（目标已有完全相同的条目）并清掉源件: ${it.name}`);
        fs.rmSync(src, { recursive: true, force: true });
        skipped++;
        continue;
      }
      throw new Error(
        `目标已存在且内容不同，拒绝覆盖：${dst}\n` +
          `    请人工确认后再跑（先处理这个冲突，脚本绝不覆盖数据）。`,
      );
    }
    let renamed = false;
    try {
      fs.renameSync(src, dst);
      renamed = true;
    } catch {
      renamed = false;
    }
    if (!renamed) {
      /* 跨盘 / 被占用 → 复制到临时名，逐字节校验后再删源。 */
      const tmp = dst + ".migrating";
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.cpSync(src, tmp, { recursive: true });
      if (!sameTree(src, tmp)) {
        fs.rmSync(tmp, { recursive: true, force: true });
        throw new Error(`复制后校验不一致，已回滚临时副本：${src}`);
      }
      fs.renameSync(tmp, dst);
      fs.rmSync(src, { recursive: true, force: true });
    }
    log(`  → ${it.name}${it.isDirectory() ? path.sep : ""}`);
    moved++;
  }
  /* 旧目录应已空；若还有内容说明上面有遗漏，报错而不是静默删。 */
  if (fs.existsSync(oldDir) && fs.readdirSync(oldDir).length) {
    throw new Error(`旧目录仍有未搬走的条目：${oldDir}`);
  }
  if (fs.existsSync(oldDir)) fs.rmdirSync(oldDir);
  return { moved, skipped };
}

/* ───────────────────────── 主流程 ───────────────────────── */

function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.help) {
    console.log(HELP);
    return;
  }
  if (!opt.canvas) {
    console.error("缺少 --canvas <画布 id>。\n\n" + HELP);
    process.exit(2);
  }
  if (!opt.to) {
    console.error("缺少 --to <项目文件夹根>。\n\n" + HELP);
    process.exit(2);
  }
  if (!path.isAbsolute(opt.to)) {
    console.error(`--to 必须是绝对路径：${opt.to}`);
    process.exit(2);
  }

  const log = (s = "") => console.log(s);
  log("团队事实库迁移" + (opt.dryRun ? "（--dry-run 试运行，不写盘）" : ""));
  log(`  画布: ${opt.canvas}`);
  log(`  目标: ${opt.to}`);
  log();

  if (appRunning() && !opt.force) {
    log("⚠ 检测到 MTNode 正在运行：请先完全退出应用再跑本脚本，");
    log("  否则应用退出时会用旧配置覆盖回写结果。");
    if (!opt.dryRun) process.exit(1);
    log();
  }

  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`找不到配置：${CONFIG_PATH}`);
    process.exit(1);
  }
  const cfgText = fs.readFileSync(CONFIG_PATH, "utf8").replace(/^\uFEFF/, "");
  let cfg;
  try {
    cfg = JSON.parse(cfgText);
  } catch (e) {
    console.error(`config.json 解析失败：${e.message}`);
    process.exit(1);
  }
  const teamCanvases = (cfg.team && Array.isArray(cfg.team.canvases) && cfg.team.canvases) || [];
  const canvas = teamCanvases.find((c) => c && c.id === opt.canvas);
  if (!canvas) {
    console.error(`config.json 的 team.canvases 里没有画布 ${opt.canvas}`);
    process.exit(1);
  }
  const fact = canvas.fact && typeof canvas.fact === "object" ? canvas.fact : null;
  if (!fact) {
    console.error(`画布 ${opt.canvas} 没有已建的事实库（fact 为空），无需迁移。`);
    process.exit(1);
  }

  /* 画布文件命名口径：save/<画布 id>.json，画布 id 本身已带 wf_ 前缀时不再重复加。 */
  const wfFile = opt.canvas.startsWith("wf_") ? `${opt.canvas}.json` : `wf_${opt.canvas}.json`;
  const saveFile = path.join(SAVE_DIR, wfFile);
  let saveText = null;
  let saveJson = null;
  if (fs.existsSync(saveFile)) {
    saveText = fs.readFileSync(saveFile, "utf8").replace(/^\uFEFF/, "");
    try {
      saveJson = JSON.parse(saveText);
    } catch (e) {
      console.error(`${wfFile} 解析失败：${e.message}`);
      process.exit(1);
    }
  } else {
    log(`（提示：未找到 ${saveFile}，跳过画布工作区文件回写）`);
  }

  const oldDir = String(fact.dir || "").trim() || (fact.file ? path.dirname(String(fact.file)) : "");
  const newDir = path.join(opt.to, LIB_NAME);
  /* config.json 里路径是 JSON 转义形态（\\），比对前统一成同一种写法。 */
  const cfgTextFlat = cfgText.replace(/\\\\/g, "\\");
  const newDirFlat = newDir;
  if (!oldDir) {
    console.error("配置里取不到旧库目录（fact.dir / fact.file 均为空）。");
    process.exit(1);
  }

  /* 幂等分支：旧目录没了 + 配置已在目标位置 → 已完成。
     旧库目录已经等于目标目录 → 也已经搬到位，只核对配置（不重复搬）。 */
  const oldGone = !fs.existsSync(oldDir);
  const sameDir = norm(oldDir) === norm(newDir);
  if (sameDir) {
    if (oldGone) {
      console.error(`配置里的库目录不存在（${oldDir}），也没在 ${newDir} 上找到内容。请人工核对该库现状。`);
      process.exit(1);
    }
    const cfgHasNew = cfgTextFlat.includes(newDirFlat);
    log(`✔ 迁移已完成：库已在目标位置 ${newDir}，配置引用 ${cfgHasNew ? "已" : "未"}指向它`);
    return;
  }
  if (oldGone) {
    if (cfgTextFlat.includes(newDirFlat)) {
      log(`✔ 迁移已完成：旧目录已不存在，配置已指向 ${newDir}`);
      return;
    }
    console.error(`旧目录不存在（${oldDir}），配置里也没指向 ${newDir}。请人工核对该库现状。`);
    process.exit(1);
  }

  /* 合法性体检：目标不得落在旧库内部。 */
  if (isSub(newDir, oldDir)) {
    console.error(`目标 ${newDir} 位于旧库目录内部，会把库搬进自己，拒绝执行。`);
    process.exit(1);
  }

  /* ① 搬目录 */
  const before = oldGone ? [] : walkFiles(oldDir);
  let movedLibrary = false;
  if (!oldGone) {
    log(`① 搬目录  ${oldDir}`);
    log(`        → ${newDir}`);
    if (opt.dryRun) {
      for (const f of before) log(`   → ${f.rel}  (${f.size} B)`);
      log(`   试运行：将搬运 ${before.length} 个文件`);
    } else {
      let r;
      try {
        r = moveLibrary(oldDir, newDir, log);
      } catch (e) {
        console.error(`\n搬目录失败（未改动任何配置）：${e.message}`);
        process.exit(1);
      }
      movedLibrary = true;
      log(`   完成：搬运 ${r.moved} 个条目，跳过 ${r.skipped} 个（旧目录已清空并删除）`);
    }
  } else {
    log(`① 旧目录已不存在，跳过搬运（${oldDir}）`);
  }
  log();

  /* ② 回写路径
     只改**结构化字段**，不做全文替换：config.json 里除 team.canvases[].fact 之外还存着历史
     会话 / 任务书正文，正文里也含旧库路径文本，那是归档文字，绝不能顺手改（会篡改历史记录）。
     因此按 JSON 解析 → 只改这条画布 fact 的 dir/assetsDir/file/reviewFile/docs[].* → 整体重新序列化
     （源文件本来就是 2 空格缩进，序列化不改变数据）。 */
  log("② 回写绝对路径");
  const rawOld = oldDir.replace(/[\\/]+$/, "");
  const stripTrail = (s) => s.replace(/[\\/]+$/, "");
  const countIn = (s, needle) => (needle ? s.split(needle).length - 1 : 0);
  const countOld = (s) => countIn(s, rawOld);
  /* 把落在 <旧库目录> 下的路径换成对应新路径；不在其下的原样保留。 */
  const remap = (v) => {
    if (typeof v !== "string" || !v) return v;
    const a = stripTrail(v);
    if (norm(a) === norm(rawOld)) return newDir;
    if (a.toLowerCase().startsWith(norm(rawOld) + path.sep) ||
        a.toLowerCase().startsWith(norm(rawOld) + "/")) {
      return newDir + a.slice(rawOld.length);
    }
    return v;
  };

  const nextCfgObj = cfg; /* 已解析；下面就地改这条画布的 fact */
  let cfgHits = 0;
  const bump = (before, after) => {
    if (before !== after) cfgHits++;
  };
  const setKey = (obj, key) => {
    if (!obj || typeof obj[key] !== "string") return;
    const before = obj[key];
    obj[key] = remap(before);
    bump(before, obj[key]);
  };
  setKey(fact, "dir");
  setKey(fact, "assetsDir");
  setKey(fact, "file");
  setKey(fact, "reviewFile");
  if (Array.isArray(fact.docs)) {
    for (const d of fact.docs) {
      setKey(d, "file");
      setKey(d, "reviewFile");
    }
  }

  let nextSave = saveText;

  /* workspace：只在源文件确实写了值、且当前不等于目标时才回写（绝不用空值抹掉）。 */
  const wsFromSave = saveJson && typeof saveJson.workspace === "string" ? saveJson.workspace.trim() : "";
  const wsCur = String(canvas.workspace || "").trim();
  const wsNew = wsFromSave || wsCur;
  if (wsNew && norm(wsNew) !== norm(opt.to) && norm(wsNew) === norm(path.dirname(rawOld))) {
    /* 画布工作区还指着旧库所在目录 → 同步改成目标根。 */
    canvas.workspace = opt.to;
    bump(wsNew, opt.to);
    if (nextSave) {
      const obj = JSON.parse(nextSave);
      if (obj && norm(String(obj.workspace || "")) === norm(wsNew)) {
        obj.workspace = opt.to;
        nextSave = JSON.stringify(obj, null, 2) + "\n";
      }
    }
    log(`   workspace: ${wsNew} → ${opt.to}`);
  }

  /* 画布条目的 workspace 为空但工作区文件里已定 → 补上，免得解析时又弹目录选择。 */
  if (wsFromSave && !wsCur) {
    canvas.workspace = wsFromSave;
    cfgHits++;
    log(`   workspace(空 → 补): ${wsFromSave}`);
  }

  const nextCfg = cfgHits ? JSON.stringify(cfg, null, 2) + "\n" : cfgText;
  log(`   config.json: 改写 ${cfgHits} 个路径字段（仅 team.canvases[${opt.canvas}].fact 与 workspace）`);
  if (nextSave !== saveText) log(`   ${wfFile}: 已更新 workspace`);
  else log(`   ${wfFile}: 无路径引用需要改`);

  if (opt.dryRun) {
    log("\n试运行结束：未写入任何文件。去掉 --dry-run 即真正执行。");
    return;
  }

  /* ③ 备份 + 写入 + 自检 */
  log();
  log("③ 备份并写入");
  const suffix = `.bak-${stamp()}`;
  const cfgBak = CONFIG_PATH + suffix;
  fs.copyFileSync(CONFIG_PATH, cfgBak);
  log(`   备份 ${path.basename(cfgBak)}`);
  const saveBak = saveText != null ? saveFile + suffix : "";
  if (saveBak) {
    fs.copyFileSync(saveFile, saveBak);
    log(`   备份 ${path.basename(saveBak)}`);
  }

  const rollback = [];
  try {
    if (nextCfg !== cfgText) {
      fs.writeFileSync(CONFIG_PATH, nextCfg, "utf8");
      rollback.push(() => fs.writeFileSync(CONFIG_PATH, cfgText, "utf8"));
    }
    if (nextSave != null && nextSave !== saveText) {
      fs.writeFileSync(saveFile, nextSave, "utf8");
      rollback.push(() => fs.writeFileSync(saveFile, saveText, "utf8"));
    }
  } catch (e) {
    console.error(`写入失败：${e.message}，正在回滚…`);
    for (const fn of rollback) {
      try {
        fn();
      } catch {}
    }
    /* 库已经搬走但配置写不进去 → 把库搬回原处，避免应用按新配置找不到库、按旧配置也找不到。 */
    if (movedLibrary && fs.existsSync(newDir) && !fs.existsSync(oldDir)) {
      try {
        fs.mkdirSync(path.dirname(oldDir), { recursive: true });
        moveLibrary(newDir, oldDir, () => {});
        console.error("已把事实库搬回原处（回滚完成，未留半成品）。");
      } catch (e2) {
        console.error(
          `自动搬回失败：${e2.message}\n  库现在在 ${newDir}，请手工搬回 ${oldDir}（备份 JSON 见下方）。`,
        );
      }
    }
    console.error(`备份：${cfgBak}${saveBak ? " / " + saveBak : ""}`);
    process.exit(1);
  }

  /* 自检 */
  const readText = (p) => fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "");
  const problems = [];
  try {
    JSON.parse(readText(CONFIG_PATH));
  } catch (e) {
    problems.push(`config.json 写入后无法解析：${e.message}`);
  }
  if (saveBak) {
    try {
      JSON.parse(readText(saveFile));
    } catch (e) {
      problems.push(`${wfFile} 写入后无法解析：${e.message}`);
    }
  }
  if (fs.existsSync(oldDir)) problems.push(`旧目录仍然存在：${oldDir}`);
  const after = walkFiles(newDir);
  const beforeRel = before.map((f) => f.rel).sort();
  const afterRel = after.map((f) => f.rel).sort();
  if (beforeRel.join("\n") !== afterRel.join("\n")) {
    problems.push(
      `新目录文件集合与源不一致（源 ${beforeRel.length} 个 / 新 ${afterRel.length} 个）`,
    );
  }
  const parsed = JSON.parse(readText(CONFIG_PATH));
  const afterCanvas =
    ((parsed.team && parsed.team.canvases) || []).find((c) => c && c.id === opt.canvas) || {};
  const afterFact = afterCanvas.fact && typeof afterCanvas.fact === "object" ? afterCanvas.fact : {};
  if (String(afterFact.dir || "") && norm(afterFact.dir) !== norm(newDir))
    problems.push(`回写后 fact.dir 仍不是新目录：${afterFact.dir}`);
  if (String(afterFact.assetsDir || "") && !isSub(afterFact.assetsDir, newDir))
    problems.push(`回写后 fact.assetsDir 不在新目录内：${afterFact.assetsDir}`);
  for (const d of Array.isArray(afterFact.docs) ? afterFact.docs : []) {
    if (d && d.file && !isSub(d.file, newDir)) problems.push(`回写后 docs[].file 不在新目录内：${d.file}`);
    if (d && d.reviewFile && !isSub(d.reviewFile, newDir))
      problems.push(`回写后 docs[].reviewFile 不在新目录内：${d.reviewFile}`);
  }
  /* config.json 里残留的旧库路径只应出现在**历史归档文字**（会话 / 任务书正文）里，
     那是记录本身，不该改。结构化字段（fact.* 与 workspace）必须已全部改净。 */
  const strayStructured = [];
  const scanStructured = (obj, tag) => {
    if (typeof obj === "string") {
      if (obj && norm(obj).includes(norm(rawOld))) strayStructured.push(`${tag}: ${obj}`);
      return;
    }
    if (Array.isArray(obj)) return obj.forEach((v, i) => scanStructured(v, `${tag}[${i}]`));
    if (obj && typeof obj === "object")
      for (const k of Object.keys(obj)) scanStructured(obj[k], `${tag}.${k}`);
  };
  scanStructured(afterFact, "fact");
  scanStructured(afterCanvas.workspace, "workspace");
  if (strayStructured.length) {
    for (const s of strayStructured.slice(0, 10)) problems.push(`结构化字段仍有旧路径 → ${s}`);
  }
  const stray = countOld(readText(CONFIG_PATH));
  const strayNote = stray ? `${stray} 处仍在历史会话 / 任务书正文（归档文字，按设计不改）` : "无";

  log();
  log("④ 自检");
  if (problems.length) {
    for (const p of problems) log(`   ✗ ${p}`);
    log("   备份在：" + path.basename(cfgBak) + (saveBak ? " / " + path.basename(saveBak) : ""));
    process.exit(1);
  }
  log(`   ✔ 新目录文件齐全（${after.length} 个，共 ${after.reduce((n, f) => n + f.size, 0)} B）`);
  log(`   ✔ 旧目录已不存在：${oldDir}`);
  log(`   ✔ config.json / ${wfFile} 均可解析，事实库 + workspace 路径全部指向 ${newDir}`);
  log(`   ✔ config.json 旧库路径残留：${strayNote}`);
  log(`   备份：${cfgBak}${saveBak ? "\n         " + saveBak : ""}`);
  log();
  log("迁移完成。");
}

main();
