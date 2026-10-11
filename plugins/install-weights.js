"use strict";
/**
 * 权重「指路 → 移动就位」（纯函数 + 本机文件操作，无 Electron 依赖）：
 * 给本地后端插件的安装窗用 —— 用户在安装窗里指向自己已经手动下载好的目录，
 * 由这里**按各插件已知的仓库结构自动匹配**，再把匹配到的文件**移动**到该插件预期的权重目录
 * （先 rename；跨盘退化为复制 + 删除，逐文件处理，峰值不会出现两份完整权重）。
 *
 * 两条硬口径（本轮共识）：
 *   · 是**移动**不是复制（权重动辄几十 GB，复制代价高）；
 *   · 目标目录撞上同名文件 → **用源文件覆盖**（以用户手动下载的那份为准）。
 *
 * 就位判定交给各插件自己的安装脚本：它们本来就会跳过已存在的权重、只补缺的
 * （h3 / tts 有显式文件清单，sensenova / yue / music3 / breeze 看 .ok 或文件是否齐），
 * 所以这里只保证「把文件搬到脚本期望的位置」，搬完由用户点安装窗里的「重试」继续。
 *
 * 目标目录表为什么在这里：8 个宿主各自 hardcode 了路径（ComfyUI\models、models\MiniMax-Music3 …），
 * 这张表是**安装窗侧的唯一映射**，只读不改各宿主；新增插件时在 WEIGHTS_SPECS 补一条即可。
 *
 * 目录名 / 文件名匹配口径（认不出的**留在原地**并如实列出，绝不猜着搬）：
 *   · accepts     = 目录名命中（大小写不敏感，尾部 * 可作通配）→ 该目录**内容**搬进槽位目标目录；
 *   · keepAccepts = 目录名命中 → 该目录**本身**建在槽位目标目录下（如 chinese-hubert-base）；
 *   · fileNames / fileRe = 落单文件命中 → 该文件搬进槽位目标目录根部（保留自己的文件名）。
 */
const fs = require("fs");
const path = require("path");

/** 各插件的权重目标（rel = 相对安装目录的路径段）。pluginId 与安装窗 / 宿主登记表同源。 */
const WEIGHTS_SPECS = {
  "minimax-h3": {
    label: "MiniMax H3 权重（ComfyUI）",
    slots: [
      {
        id: "diffusion_models",
        label: "扩散模型",
        rel: ["ComfyUI", "models", "diffusion_models"],
        accepts: ["diffusion_models"],
        fileRe: [/^minimax_h3_(fl2va|ref2va).*\.safetensors$/i],
      },
      {
        id: "text_encoders",
        label: "文本编码器",
        rel: ["ComfyUI", "models", "text_encoders"],
        accepts: ["text_encoders"],
        fileRe: [/^qwen3vl_.*\.(safetensors|sft)$/i],
      },
      {
        id: "vae",
        label: "VAE",
        rel: ["ComfyUI", "models", "vae"],
        accepts: ["vae"],
        fileRe: [/^minimax_h3_.*vae.*\.safetensors$/i],
      },
    ],
  },
  "minimax-music3": {
    label: "MiniMax Music3 官方 Diffusers 权重",
    slots: [
      {
        id: "app",
        label: "官方权重",
        rel: ["models", "MiniMax-Music3"],
        accepts: ["MiniMax-Music3", "MiniMaxAI__MiniMax-Music3", "MiniMax-Music3*"],
        fileRe: [
          /^model_index\.json$/i,
          /^config\.json$/i,
          /^.*\.safetensors$/i,
        ],
      },
    ],
  },
  "yue2-local": {
    label: "YuE2 权重（YuE2-3B + YuE2-Vae）",
    slots: [
      {
        id: "yue2-3b",
        label: "YuE2-3B",
        rel: ["models", "m-a-p__YuE2-3B"],
        accepts: ["m-a-p__YuE2-3B", "YuE2-3B", "YuE2_3B", "YuE2-3B*"],
        /* 3B 本体：排除掉名字里带 vae 的（那是另一个槽位），免得上层「落单文件」匹配时判不准 */
        fileRe: [/^(?!.*vae).*\.safetensors$/i, /^config\.json$/i],
      },
      {
        id: "yue2-vae",
        label: "YuE2-Vae",
        rel: ["models", "m-a-p__YuE2-Vae"],
        accepts: ["m-a-p__YuE2-Vae", "YuE2-Vae", "YuE2_Vae", "YuE2-Vae*"],
        fileRe: [/^.*vae.*\.(safetensors|bin|pt|pth)$/i],
      },
    ],
  },
  "sensenova-local": {
    label: "SenseNova-U1.5-8B-MoT 权重",
    slots: [
      {
        id: "models",
        label: "权重（8 片 safetensors）",
        rel: ["models"],
        accepts: [
          "SenseNova-U1.5-8B-MoT",
          "SenseNova-U1.5-8B-MoT*",
          "SenseNova_U1.5_8B_MoT",
          "SenseNova__SenseNova-U1.5-8B-MoT",
        ],
        fileRe: [/^model-\d+-of-\d+\.safetensors$/i, /^config\.json$/i, /^.*\.safetensors$/i],
      },
    ],
  },
  "tts-local": {
    label: "GPT-SoVITS 预训练权重",
    slots: [
      {
        id: "pretrained",
        label: "pretrained_models",
        rel: ["engine", "GPT_SoVITS", "pretrained_models"],
        accepts: ["pretrained_models"],
        keepAccepts: ["chinese-hubert-base", "chinese-roberta-wwm-ext-large"],
        /* 落单的 SoVITS 底模：s2G488k 是 v1（bundled 配置指向它），s2G2333k 是 v2；
           s2G233k 是插件早期写错的名字，留着只为了让那时候装下的目录还能被认出来。 */
        fileNames: ["s2G488k.pth", "s2G2333k.pth", "s2G233k.pth"],
        fileRe: [/^s1bert25hz.*\.ckpt$/i],
      },
    ],
  },
  "breeze-tts-local": {
    label: "Breeze TTS 2 权重",
    slots: [
      {
        id: "ckpt",
        label: "权重",
        rel: ["checkpoints", "breeze-tts-2"],
        accepts: ["breeze-tts-2", "breeze-tts-2*", "BreezeBlue__breeze-tts-2"],
        fileRe: [/^.*\.(safetensors|pt|pth|bin)$/i, /^config\.json$/i],
      },
    ],
  },
};

/** 判定「这个目录像是权重目录」的通用文件特征（单槽位插件的兜底匹配用）。 */
const PAYLOAD_FILE_RE = [
  /^model_index\.json$/i,
  /^config\.json$/i,
  /^.*\.(safetensors|ckpt|pth|pt|bin)$/i,
];

/** 扫描时要跳过的目录（构建产物 / 缓存 / 版本库，一定不是权重本体）。 */
const SKIP_DIRS = new Set([".git", "__pycache__", ".venv", "venv", "_ms_cache", ".cache", "node_modules"]);

const MAX_DEPTH = 6;

function normName(s) {
  return String(s || "").trim().toLowerCase();
}

/** 目录名是否命中一个 accepts 项（大小写不敏感；尾部 * 作前缀通配）。 */
function nameHit(dirName, pattern) {
  const d = normName(dirName);
  const p = normName(pattern);
  if (!d || !p) return false;
  if (p.endsWith("*")) return d.startsWith(p.slice(0, -1));
  return d === p;
}

function targetsOf(pluginId) {
  return WEIGHTS_SPECS[String(pluginId || "")] || null;
}

/** 该插件是否有权重指路能力（没有就整块不显示入口）。 */
function supports(pluginId) {
  return !!targetsOf(pluginId);
}

/** 展示用信息：槽位 → 绝对目标目录（安装目录为空时返回空串，调用方据此提示先选目录）。 */
function weightsInfo(pluginId, installDir) {
  const spec = targetsOf(pluginId);
  if (!spec) return null;
  const root = String(installDir || "").trim();
  return {
    id: String(pluginId || ""),
    label: spec.label,
    installDir: root,
    slots: spec.slots.map((s) => ({
      id: s.id,
      label: s.label,
      dir: root ? path.join(root, ...s.rel) : "",
      rel: s.rel.join("\\"),
    })),
  };
}

/** 递归收文件（跳过 SKIP_DIRS 与深度上限；符号链接不跟，避免环）。 */
function walkFiles(dir, depth, out) {
  if (depth > MAX_DEPTH) return;
  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of ents) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(normName(ent.name))) continue;
      walkFiles(p, depth + 1, out);
    } else if (ent.isFile()) {
      out.push(p);
    }
  }
}

/** 递归收目录（含根自身），供目录名匹配用。 */
function walkDirs(dir, depth, out) {
  out.push(dir);
  if (depth > MAX_DEPTH) return;
  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of ents) {
    if (!ent.isDirectory() || SKIP_DIRS.has(normName(ent.name))) continue;
    walkDirs(path.join(dir, ent.name), depth + 1, out);
  }
}

function sizeOf(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

/**
 * 扫描 + 匹配（**只看不搬**）：返回
 *   { ok, label, slots:[{id,label,dir,count,bytes}], moves:[{src,dst,slotId,bytes}], unmatched:[{path,reason}] }
 * 匹配口径见文件头。moves 里 dst 是**绝对目标文件路径**。
 */
function planMove(opts) {
  const o = opts || {};
  const pluginId = String(o.pluginId || "");
  const spec = targetsOf(pluginId);
  if (!spec) return { ok: false, error: "no_weights_spec", message: "该插件没有权重指路能力。" };
  const installDir = String(o.installDir || "").trim();
  if (!installDir) {
    return { ok: false, error: "no_install_dir", message: "还没确定安装目录：先把安装目录选出来。" };
  }
  const sources = (Array.isArray(o.sources) ? o.sources : [])
    .map((s) => String(s || "").trim())
    .filter(Boolean);
  if (!sources.length) return { ok: false, error: "no_source", message: "还没指定「已下载的权重位置」。" };

  const slotDirs = new Map();
  for (const s of spec.slots) slotDirs.set(s.id, path.join(installDir, ...s.rel));

  /** 目录 → { slotId, keep, anchor } */
  const anchored = new Map();
  const moves = [];
  const unmatched = [];

  const pushDirPayload = (dir, slot, keep) => {
    const files = [];
    walkFiles(dir, 0, files);
    for (const f of files) {
      const inner = path.relative(dir, f);
      const dst = keep
        ? path.join(slotDirs.get(slot.id), path.basename(dir), inner)
        : path.join(slotDirs.get(slot.id), inner);
      moves.push({ src: f, dst, slotId: slot.id, bytes: sizeOf(f) });
    }
    anchored.set(dir, { slotId: slot.id, keep });
  };

  /* ① 目录名匹配：先到先得；命中后不再往该目录里面找更细的锚点。 */
  const dirs = [];
  for (const src of sources) walkDirs(src, 0, dirs);
  dirs.sort((a, b) => a.length - b.length);
  for (const d of dirs) {
    if ([...anchored.keys()].some((a) => d === a || d.startsWith(a + path.sep))) continue;
    const name = path.basename(d);
    let hit = null;
    for (const slot of spec.slots) {
      if ((slot.accepts || []).some((p) => nameHit(name, p))) {
        hit = { slot, keep: false };
        break;
      }
      if ((slot.keepAccepts || []).some((p) => nameHit(name, p))) {
        hit = { slot, keep: true };
        break;
      }
    }
    if (hit) pushDirPayload(d, hit.slot, hit.keep);
  }

  /* ② 单槽位兜底：一个插件只有一个槽位时，目录里只要出现权重味儿的文件就当它是该槽位。 */
  if (!anchored.size && spec.slots.length === 1) {
    const slot = spec.slots[0];
    for (const d of dirs) {
      if ([...anchored.keys()].some((a) => d === a || d.startsWith(a + path.sep))) continue;
      let ents = [];
      try {
        ents = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        continue;
      }
      const looksPayload = ents.some(
        (e) => e.isFile() && PAYLOAD_FILE_RE.some((re) => re.test(e.name)),
      );
      if (looksPayload) pushDirPayload(d, slot, false);
    }
  }

  /* ③ 落单文件：文件名命中**唯一**一个槽位才搬（命中多个 = 判不准，留在原地）。 */
  const covered = (f) => [...anchored.keys()].some((a) => f === a || f.startsWith(a + path.sep));
  const allFiles = [];
  for (const src of sources) walkFiles(src, 0, allFiles);
  for (const f of allFiles) {
    if (covered(f)) continue;
    const name = path.basename(f);
    const hits = spec.slots.filter((slot) => {
      const byName = (slot.fileNames || []).some((n) => normName(n) === normName(name));
      const byRe = (slot.fileRe || []).some((re) => re.test(name));
      return byName || byRe;
    });
    if (hits.length === 1) {
      const slot = hits[0];
      moves.push({ src: f, dst: path.join(slotDirs.get(slot.id), name), slotId: slot.id, bytes: sizeOf(f) });
    } else {
      unmatched.push({ path: f, reason: hits.length ? "ambiguous" : "unknown" });
    }
  }

  /* 认不出的目录（顶层）：只列没被任何 moves 覆盖的顶层项，避免刷屏。 */
  for (const src of sources) {
    let ents = [];
    try {
      ents = fs.readdirSync(src, { withFileTypes: true });
    } catch {
      unmatched.push({ path: src, reason: "unreadable" });
      continue;
    }
    for (const ent of ents) {
      const p = path.join(src, ent.name);
      const used = moves.some((m) => m.src === p || m.src.startsWith(p + path.sep));
      const isAnchor = [...anchored.keys()].some((a) => a === p);
      if (!used && !isAnchor) unmatched.push({ path: p, reason: ent.isDirectory() ? "unknown_dir" : "unknown" });
    }
  }

  const slots = spec.slots.map((s) => {
    const list = moves.filter((m) => m.slotId === s.id);
    return {
      id: s.id,
      label: s.label,
      dir: slotDirs.get(s.id),
      count: list.length,
      bytes: list.reduce((a, m) => a + (Number(m.bytes) || 0), 0),
    };
  });
  const total = moves.reduce((a, m) => a + (Number(m.bytes) || 0), 0);
  return {
    ok: true,
    id: pluginId,
    label: spec.label,
    installDir,
    sources,
    slots,
    moves,
    unmatched,
    total: { count: moves.length, bytes: total },
  };
}

/** 目标已存在时按「源覆盖目标」处理：rename 在 Windows 上可覆盖，被占用时先删目标再 rename。 */
function moveFileSync(src, dst) {
  try {
    fs.renameSync(src, dst);
    return { ok: true, how: "rename" };
  } catch (e) {
    const code = String((e && e.code) || "");
    if (code === "EXDEV") {
      /* 跨盘：物理上只能复制 + 删除（逐文件处理，峰值只多一份文件，不会出现两份完整权重） */
      fs.copyFileSync(src, dst);
      fs.unlinkSync(src);
      return { ok: true, how: "copy" };
    }
    if (code === "EPERM" || code === "EACCES" || code === "EBUSY" || code === "EEXIST") {
      try {
        fs.rmSync(dst, { force: true });
      } catch {}
      fs.renameSync(src, dst);
      return { ok: true, how: "replace" };
    }
    return { ok: false, error: code || String((e && e.message) || e) };
  }
}

/** 搬完清一次空目录（只在源目录树内，自底向上；非空不动）。 */
function pruneEmptyDirs(root) {
  let ents = [];
  try {
    ents = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of ents) {
    if (!ent.isDirectory() || SKIP_DIRS.has(normName(ent.name))) continue;
    const p = path.join(root, ent.name);
    pruneEmptyDirs(p);
    try {
      if (!fs.readdirSync(p).length) fs.rmdirSync(p);
    } catch {}
  }
}

/**
 * 执行一次 planMove 的搬迁。opts: { onProgress, isCancelled }
 * onProgress: { phase:"copy"|"rename", file, index, count, bytesDone, bytesTotal, done }
 * 返回 { ok, moved, failed:[{src,error}], cancelled, unmatched }
 */
function movePlan(plan, opts) {
  const o = opts || {};
  const p = plan || {};
  if (!p.ok || !Array.isArray(p.moves)) return { ok: false, error: "bad_plan" };
  const onProgress = typeof o.onProgress === "function" ? o.onProgress : null;
  const isCancelled = typeof o.isCancelled === "function" ? o.isCancelled : () => false;
  const count = p.moves.length;
  const bytesTotal = p.moves.reduce((a, m) => a + (Number(m.bytes) || 0), 0);
  const failed = [];
  let bytesDone = 0;
  let moved = 0;
  for (let i = 0; i < count; i++) {
    if (isCancelled()) {
      return { ok: false, cancelled: true, moved, failed, bytesDone, bytesTotal, unmatched: p.unmatched || [] };
    }
    const m = p.moves[i];
    try {
      fs.mkdirSync(path.dirname(m.dst), { recursive: true });
      const r = moveFileSync(m.src, m.dst);
      if (!r.ok) failed.push({ src: m.src, error: r.error });
      else moved++;
    } catch (e) {
      failed.push({ src: m.src, error: String((e && e.code) || (e && e.message) || e) });
    }
    bytesDone += Number(m.bytes) || 0;
    if (onProgress) {
      try {
        onProgress({
          phase: "move",
          file: m.src,
          index: i + 1,
          count,
          bytesDone,
          bytesTotal,
          done: moved,
        });
      } catch {}
    }
  }
  for (const src of p.sources || []) pruneEmptyDirs(src);
  return {
    ok: failed.length === 0,
    moved,
    failed,
    bytesDone,
    bytesTotal,
    cancelled: false,
    unmatched: p.unmatched || [],
  };
}

/** 人读的体积文案（安装窗与日志共用一份口径）。 */
function fmtBytes(n) {
  const x = Number(n) || 0;
  if (x >= 1024 ** 3) return (x / 1024 ** 3).toFixed(2) + " GB";
  if (x >= 1024 ** 2) return (x / 1024 ** 2).toFixed(1) + " MB";
  if (x >= 1024) return (x / 1024).toFixed(0) + " KB";
  return x + " B";
}

module.exports = {
  WEIGHTS_SPECS,
  supports,
  targetsOf,
  weightsInfo,
  planMove,
  movePlan,
  fmtBytes,
  _internals: { nameHit, walkFiles, moveFileSync, PAYLOAD_FILE_RE },
};
