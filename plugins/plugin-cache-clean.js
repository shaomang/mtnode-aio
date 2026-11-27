/* plugins/plugin-cache-clean.js — 插件目录里「产出物缓存」的统计与清理内核（纯 Node，不依赖 electron / UI）
 *
 * 需求：5 个基于 ComfyUI 的本地后端插件（H3 / InfiniteTalk / SoulX-FlashHead / FLUX 3 Klein / Qwen Image）
 * 每跑一次生成都会在自己的安装目录里留一份产物（ComfyUI 的 output/、上传进 input/ 的参考图等），
 * 长期使用后能吃掉几十 GB。卸载窗里那颗「删除产物」只在卸载时可用，平时没有任何清理出口 ——
 * 本模块就是那个出口的内核：**只读统计**（scan）与**确认后删除**（clean）。
 *
 * 为什么可以删（逐宿主核对过的产物落点，别再在别处另写一份）：
 *   命中判据只有一条：画布节点拿到的 path 是不是**复制出去**的那一份。5 个宿主的实况
 *   （行号会漂，认函数名）：
 *   · H3（h3/main-h3.js）—— 内置链 generateVideo：先 comfyOutputPath() 得到安装目录内的原文件，再
 *     `exportDir = params.outputDir || resolveManagedOutDir(params.canvasWorkflowId).dir`
 *     （画布资产目录，拿不到就数据目录 asset-tmp）→ copyOutputToDir() 复制，回执与画布用的都是复制件；
 *     postProcess（超分 / 补帧 / 图链）同理，exportDir 恒非空、恒复制。
 *     ⚠ **但自建工作流分支 runCustomWorkflow 不是**：它只在 `params.outputDir` 非空时才
 *     copyOutputToDir，托管口径（画布节点没配输出路径、输出接保存节点，渲染层 buildVideoGenRunParams
 *     的 outParams = {}）下直接把 comfyOutputPath() 的**安装目录原文件**当产物回给节点 ——
 *     这种节点删了就断链。所以 h3 的 ComfyUI/output 只进预览、不删（见 CACHE_RISK_SUBDIRS）。
 *   · InfiniteTalk（infinitetalk/main-infinitetalk.js）：分块产 mp4 → jobDir（数据目录 jobs/，不在白名单）→
 *     合成后 muxAudio() 写到 finalTargetPath()：显式 outputPath，否则 outputRootFor() =
 *     画布资产目录 / 显式 outputDir / <数据目录>/infinitetalk-local/output。安装目录里的 ComfyUI
 *     output 只是分块中间件，成片是复制出来的那份 → 可删。
 *   · FLUX 3（flux3klein/main-flux3klein.js）· Qwen Image（qwenimage/main-qwenimage.js）：
 *     `src = <comfy>/output/<sub>/<file>` 之后一定 `fs.copyFileSync(src, out)`，out 在
 *     outputRootFor()（画布资产目录 / 显式 outputDir / 数据目录插件目录的 output），回执只回 out → 可删。
 *   · SoulX-FlashHead（soulxflashhead/main-soulxflashhead.js）：不走 ComfyUI，直接把 out_path
 *     （= outputRootFor() 算出的画布资产目录 / 显式 outputDir）交给后端服务落盘，安装目录里没有产物 → 可删。
 *   结论：只有 h3 的 ComfyUI/output 存在「安装目录文件被直接当产物」的支路，其余目录删掉不会让已完成的
 *   画布节点断链（正在写的由 keepRecentMinutes 兜住）。
 *
 * 纪律：
 *   · 能清理的插件只有 CACHE_PLUGINS 里那 5 个（认不出的 id 一律拒绝，绝不猜着删别的插件目录）；
 *   · 能碰的子目录只有 CACHE_SUBDIRS 这一份清单（安装目录内的固定相对名），再减掉 CACHE_RISK_SUBDIRS
 *     里**该插件**的那几个（那几个只统计、只标注风险，一个文件都不删）；
 *   · 每删一个文件都重新校验：路径在安装目录内、在该白名单子目录内、lstat 是普通文件且不是符号链接
 *     （不跟随链接 = 删的是链接本身，绝不顺着它删到别处）；
 *   · 最近 N 分钟（默认 10）内有改动的文件一律跳过 —— 正在写的产物不能被删；
 *   · 单个文件删不动（EBUSY / EPERM / EACCES：后端正占用）只记进 errors，不中断整次清理；
 *   · 不删目录本身（只删文件），不碰 models / venv / custom_nodes / 用户自己的 outputDir。
 *
 * 返回形状：
 *   scan  → { ok, id, label, installDir, dirs:[{rel,path,exists,files,bytes,oldestMs,newestMs,skipped,note,risk,keptFiles,keptBytes,errors}],
 *             files, bytes, skipped, keptFiles, keptBytes, errors, scannedAt }
 *   clean → { ok, id, label, installDir, dryRun, keepDays, keepRecentMinutes,
 *             dirs:[…同上（files/bytes = 这次删掉的；risk=true 的目录一个都不删，占用记在 keptFiles/keptBytes）],
 *             freedBytes, files, skipped, keptFiles, keptBytes, errors }
 *   keptFiles / keptBytes = risk 目录（只标注不删）的占用，**不进** files / bytes / freedBytes。
 *   两者都是 fail-closed：认不出插件 / 没有安装目录 → { ok:false, error, message }。
 */
"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { readPluginDir, normDir } = require("./plugin-root.js");

/** 允许清理产出物的插件：插件 id / 卡片 kind → 中文名（界面与回执都用这一份）。 */
const CACHE_PLUGINS = {
  "minimax-h3": "MiniMax H3 视频生成",
  h3: "MiniMax H3 视频生成",
  "infinitetalk-local": "InfiniteTalk 数字人",
  infinitetalk: "InfiniteTalk 数字人",
  "soulxflashhead-local": "SoulX 实时数字人",
  soulxflashhead: "SoulX 实时数字人",
  "flux3-klein-local": "FLUX 3 Image Klein",
  flux3klein: "FLUX 3 Image Klein",
  "qwen-image-local": "Qwen Image 2.1",
  qwenimage: "Qwen Image 2.1",
};

/** 候选缓存子目录（相对插件安装目录，斜杠分隔）—— **全仓唯一一份**。
 *  ComfyUI/output 递归覆盖它自己的子目录（如 H3 的 output/post）；input 是上传进后端的参考图 / 音频，
 *  temp 是预览与中间帧。都不含任何模型 / 环境文件。 */
const CACHE_SUBDIRS = ["output", "ComfyUI/output", "ComfyUI/input", "ComfyUI/temp"];

/** 只统计、**一个文件都不删**的子目录（按插件 id 细分）。命中的目录在回执里带 risk:true + 一句为什么，
 *  预览照常显示它占了多少（keptFiles / keptBytes），清理时只把它记进 skipped。
 *  为什么只有 h3：见文件头 —— 只有它的自建工作流分支（runCustomWorkflow，调用方没给 outputDir 时）
 *  会把安装目录 ComfyUI/output 里的原文件当产物回给画布节点，删了那个节点就断链。
 *  其余 4 个插件的产物都是「复制到画布资产目录 / 用户 outputDir 的那一份」，所以它们的 ComfyUI/output 照删。 */
const CACHE_RISK_SUBDIRS = {
  "minimax-h3": ["ComfyUI/output"],
  h3: ["ComfyUI/output"],
};

/** 风险目录的一句话说明（预览里原样展示给用户，别改成别的措辞）。 */
const RISK_NOTE =
  "只标注风险、不清理：H3 的「自建工作流」在调用方没给 outputDir（画布托管口径）时，" +
  "把这里的原文件直接当产物回给节点 —— 删掉会让那些节点断链。确认没有节点引用后可手动删除。";

/** 该插件的哪些缓存子目录属于「只标注不删」。 */
function riskRelSet(id) {
  const list = CACHE_RISK_SUBDIRS[String(id || "").trim()];
  return new Set(Array.isArray(list) ? list : []);
}

/** 默认跳过最近 10 分钟内改过的文件（防删正在写的产物）。 */
const DEFAULT_KEEP_RECENT_MIN = 10;

function absOf(base, rel) {
  const parts = String(rel || "")
    .split("/")
    .filter(Boolean);
  return parts.length ? path.join(String(base || ""), ...parts) : "";
}

function cmpKey(p) {
  const s = normDir(p);
  return process.platform === "win32" ? s.toLowerCase() : s;
}

/** child 是否**严格在** parent 里面（相等不算；归一化后按分隔符比，避免 plugin-data2 命中 plugin-data）。 */
function isInside(parent, child) {
  const a = cmpKey(parent);
  const b = cmpKey(child);
  if (!a || !b) return false;
  const pre = a.endsWith(path.sep) ? a : a + path.sep;
  return b.startsWith(pre);
}

function errInfo(p, e) {
  return { path: String(p || ""), code: String((e && e.code) || ""), message: String((e && e.message) || e || "") };
}

/** 解析目标插件：id 合法 + 它有自己设过的安装目录。认不出就如实拒绝，不猜。 */
function resolveTarget(id, opts) {
  const sid = String(id || "").trim();
  const label = CACHE_PLUGINS[sid];
  if (!label) {
    return {
      ok: false,
      error: "unsupported_plugin",
      message: "这个插件没有可清理的产出物缓存（只支持 H3 / InfiniteTalk / SoulX / FLUX 3 / Qwen Image）。",
    };
  }
  const dataDir = normDir((opts || {}).dataDir);
  if (!dataDir) return { ok: false, id: sid, label, error: "no_data_dir", message: "取不到数据目录，读不到该插件的安装目录。" };
  const installDir = normDir(readPluginDir(dataDir, sid));
  if (!installDir) {
    return { ok: false, id: sid, label, error: "no_install_dir", message: "这个插件还没有设置安装目录（可能还没安装）。" };
  }
  return { ok: true, id: sid, label, installDir, dataDir };
}

/**
 * 一个缓存子目录是不是真的存在、且**不是符号链接**（lstat：链接到别处的 output 一律不当目录用）。
 * 返回 "dir" | "missing" | "not_dir" | "symlink"。
 */
async function dirKind(abs) {
  try {
    const st = await fsp.lstat(abs);
    if (st.isSymbolicLink()) return "symlink";
    return st.isDirectory() ? "dir" : "not_dir";
  } catch (e) {
    return e && e.code === "ENOENT" ? "missing" : "not_dir";
  }
}

/** 递归收集普通文件（不跟随符号链接：链接记进 skipped，不进门）。 */
async function walkFiles(dir, acc) {
  let list = null;
  try {
    list = await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (!e || e.code !== "ENOENT") acc.errors.push(errInfo(dir, e));
    return;
  }
  for (const ent of list) {
    const p = path.join(dir, ent.name);
    if (ent.isSymbolicLink()) {
      acc.skipped.push({ path: p, reason: "symlink" });
      continue;
    }
    let kind = ent.isDirectory() ? "dir" : ent.isFile() ? "file" : "";
    if (!kind) {
      /* 少数平台 dirent 类型不明：退回 lstat 再判（仍不跟随链接） */
      let st = null;
      try {
        st = await fsp.lstat(p);
      } catch (e) {
        acc.errors.push(errInfo(p, e));
        continue;
      }
      if (st.isSymbolicLink()) {
        acc.skipped.push({ path: p, reason: "symlink" });
        continue;
      }
      kind = st.isDirectory() ? "dir" : st.isFile() ? "file" : "";
      if (!kind) {
        acc.skipped.push({ path: p, reason: "not_file" });
        continue;
      }
      if (kind === "file") {
        acc.files.push({ path: p, size: Number(st.size) || 0, mtimeMs: Number(st.mtimeMs) || 0 });
        continue;
      }
    }
    if (kind === "dir") {
      await walkFiles(p, acc);
      continue;
    }
    try {
      const st = await fsp.stat(p);
      acc.files.push({ path: p, size: Number(st.size) || 0, mtimeMs: Number(st.mtimeMs) || 0 });
    } catch (e) {
      acc.errors.push(errInfo(p, e));
    }
  }
}

function emptyAcc() {
  return { files: [], skipped: [], errors: [] };
}

function dirItemOf(rel, abs) {
  return {
    rel,
    path: abs,
    exists: false,
    files: 0,
    bytes: 0,
    oldestMs: 0,
    newestMs: 0,
    skipped: 0,
    note: "",
    risk: false,
    keptFiles: 0,
    keptBytes: 0,
    errors: [],
  };
}

function fillDirItem(item, acc) {
  item.files = acc.files.length;
  for (const f of acc.files) {
    item.bytes += f.size;
    if (!item.oldestMs || (f.mtimeMs && f.mtimeMs < item.oldestMs)) item.oldestMs = f.mtimeMs;
    if (f.mtimeMs > item.newestMs) item.newestMs = f.mtimeMs;
  }
  item.skipped = acc.skipped.length;
  item.errors = acc.errors.slice();
}

/** 只读统计：各缓存子目录的文件数 / 字节 / 最旧与最新修改时间。不动盘。 */
async function scan(id, opts) {
  const t = resolveTarget(id, opts);
  if (!t.ok) return t;
  const riskRels = riskRelSet(t.id);
  const dirs = [];
  const errors = [];
  let files = 0;
  let bytes = 0;
  let skipped = 0;
  let oldestMs = 0;
  let newestMs = 0;
  let keptFiles = 0;
  let keptBytes = 0;
  for (const rel of CACHE_SUBDIRS) {
    const abs = absOf(t.installDir, rel);
    const item = dirItemOf(rel, abs);
    /* 白名单都是固定相对名，正常永远在安装目录内；这里再兜一道（配置被手改成相对路径之类） */
    if (!abs || !isInside(t.installDir, abs)) {
      item.note = "不在安装目录内，已跳过";
      item.errors.push({ path: String(abs || ""), code: "outside_install_dir", message: item.note });
      errors.push(item.errors[0]);
      dirs.push(item);
      continue;
    }
    const kind = await dirKind(abs);
    if (kind !== "dir") {
      item.note = kind === "symlink" ? "是符号链接，不跟随" : "";
      if (kind === "symlink") {
        item.skipped = 1;
        skipped += 1;
      }
      dirs.push(item);
      continue;
    }
    const acc = emptyAcc();
    await walkFiles(abs, acc);
    item.exists = true;
    fillDirItem(item, acc);
    if (riskRels.has(rel)) {
      /* 只标注不删：占用照样算进 keptFiles / keptBytes（预览要能看见它有多大） */
      item.risk = true;
      item.note = RISK_NOTE;
      item.keptFiles = item.files;
      item.keptBytes = item.bytes;
      item.files = 0;
      item.bytes = 0;
      item.skipped += item.keptFiles;
      skipped += item.keptFiles;
      keptFiles += item.keptFiles;
      keptBytes += item.keptBytes;
    } else {
      files += item.files;
      bytes += item.bytes;
      skipped += item.skipped;
    }
    errors.push(...item.errors);
    if (item.oldestMs && (!oldestMs || item.oldestMs < oldestMs)) oldestMs = item.oldestMs;
    if (item.newestMs > newestMs) newestMs = item.newestMs;
    dirs.push(item);
  }
  return {
    ok: true,
    id: t.id,
    label: t.label,
    installDir: t.installDir,
    dirs,
    files,
    bytes,
    skipped,
    keptFiles,
    keptBytes,
    oldestMs,
    newestMs,
    errors,
    scannedAt: Date.now(),
  };
}

/**
 * 清理：删白名单子目录里的普通文件。
 * opts = { dataDir, keepDays=0（0 = 全清，>0 = 保留最近 N 天）, keepRecentMinutes=10, dryRun=false }
 * 单个文件删不动只记 errors；最近 N 分钟改过的文件记 skipped（reason:"recent"）。
 */
async function clean(id, opts) {
  const o = opts || {};
  const t = resolveTarget(id, o);
  if (!t.ok) return t;
  const now = Date.now();
  const keepDays = Math.max(0, Number(o.keepDays) || 0);
  const keepRecentMinutes = Number.isFinite(Number(o.keepRecentMinutes))
    ? Math.max(0, Number(o.keepRecentMinutes))
    : DEFAULT_KEEP_RECENT_MIN;
  const dryRun = !!o.dryRun;
  /* 截止点要取**更早**的那个：比它新的都留着。
     keepDays>0（「保留最近 N 天」）时，N 天前才是真正的下限 —— 取更晚的那个会让 N 天那档
     被那 10 分钟窗口整个盖过去（7 天保留期内的文件照样被删）。keepDays=0 = 只保那 10 分钟。 */
  const cutoff =
    keepDays > 0
      ? Math.min(now - keepRecentMinutes * 60 * 1000, now - keepDays * 24 * 60 * 60 * 1000)
      : now - keepRecentMinutes * 60 * 1000;
  const riskRels = riskRelSet(t.id);
  const dirs = [];
  const errors = [];
  let freedBytes = 0;
  let files = 0;
  let skipped = 0;
  let keptFiles = 0;
  let keptBytes = 0;
  for (const rel of CACHE_SUBDIRS) {
    const abs = absOf(t.installDir, rel);
    const item = dirItemOf(rel, abs);
    if (!abs || !isInside(t.installDir, abs)) {
      item.note = "不在安装目录内，已跳过";
      item.errors.push({ path: String(abs || ""), code: "outside_install_dir", message: item.note });
      errors.push(item.errors[0]);
      dirs.push(item);
      continue;
    }
    const kind = await dirKind(abs);
    if (kind !== "dir") {
      if (kind === "symlink") {
        item.note = "是符号链接，不跟随";
        item.skipped = 1;
        skipped += 1;
      }
      dirs.push(item);
      continue;
    }
    item.exists = true;
    const acc = emptyAcc();
    await walkFiles(abs, acc);
    if (riskRels.has(rel)) {
      /* 风险目录：一个文件都不删（dryRun 也不删），只把占用报到 keptFiles / keptBytes 供预览标注 */
      item.risk = true;
      item.note = RISK_NOTE;
      item.keptFiles = acc.files.length;
      item.keptBytes = acc.files.reduce((s, f) => s + (Number(f.size) || 0), 0);
      item.skipped += item.keptFiles;
      skipped += item.keptFiles;
      keptFiles += item.keptFiles;
      keptBytes += item.keptBytes;
      errors.push(...acc.errors);
      dirs.push(item);
      continue;
    }
    for (const f of acc.files) {
      /* 逐条 fail-closed：必须在这个白名单子目录里，且 lstat 是普通文件（不是链接） */
      if (!isInside(abs, f.path) || !isInside(t.installDir, f.path)) {
        skipped += 1;
        item.skipped += 1;
        errors.push({ path: f.path, code: "outside_whitelist", message: "路径不在白名单缓存目录内，已跳过" });
        continue;
      }
      let st = null;
      try {
        st = await fsp.lstat(f.path);
      } catch (e) {
        if (e && e.code === "ENOENT") continue; /* 扫描后被别处删掉了：不算失败 */
        errors.push(errInfo(f.path, e));
        continue;
      }
      if (st.isSymbolicLink() || !st.isFile()) {
        skipped += 1;
        item.skipped += 1;
        continue;
      }
      if (Number(st.mtimeMs) >= cutoff) {
        skipped += 1;
        item.skipped += 1;
        continue;
      }
      const size = Number(st.size) || 0;
      if (!dryRun) {
        try {
          await fsp.unlink(f.path);
        } catch (e) {
          /* 被后端占用（EBUSY / EPERM / EACCES）不中断整次清理：记下来让用户先停后端再清 */
          errors.push(errInfo(f.path, e));
          continue;
        }
      }
      files += 1;
      item.files += 1;
      item.bytes += size;
      freedBytes += size;
    }
    dirs.push(item);
  }
  return {
    ok: true,
    id: t.id,
    label: t.label,
    installDir: t.installDir,
    dryRun,
    keepDays,
    keepRecentMinutes,
    dirs,
    freedBytes,
    files,
    skipped,
    keptFiles,
    keptBytes,
    errors,
    cleanedAt: Date.now(),
  };
}

module.exports = {
  scan,
  clean,
  CACHE_SUBDIRS,
  CACHE_RISK_SUBDIRS,
  CACHE_PLUGINS,
  DEFAULT_KEEP_RECENT_MIN,
};
