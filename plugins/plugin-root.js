/* plugins/plugin-root.js — 「插件根目录」单一真源（纯 Node，不依赖 electron / UI）
 *
 * 需求：插件界面放一个**总的根目录**设置（第一次打开时提示设置）；所有需要目录的插件
 * 默认用「根目录 + 默认子目录名」；但插件里仍然允许单独更换安装目录（插件自己的
 * installDir 一设就优先，本模块只负责**没设过时**的默认值）。
 *
 * 存储：<数据目录>/config.json → { "plugins": { "installDir": "<绝对路径>" } }
 *   与 apps.installDir（应用中心的下载根）同一个文件、不同小节，互不影响。
 *   任何用户数据都不落应用文件夹 —— 根目录命中应用目录 / 数据目录时一律拒收。
 *
 * 默认值推断（第一次打开时的预填，**只预填不写盘**）：
 *   把「已设过 installDir 的插件」按父目录分组，取插件数最多的那个父目录；
 *   至少 2 个插件同属一个父目录、且不能是盘符根，否则不给预填值（让用户自己选）。
 *
 * 落地（ensureDir，本轮需求）：安装真正开始时把「根目录 + 默认子目录名」建出来
 *   （连根目录一起，已存在就直接复用）并写回该插件自己的 installDir ——
 *   用户设过根目录之后就不必再去系统选择框里手动新建一个文件夹。
 *
 * 谁在用：plugins/main-app-plugins.js（IPC + 默认目录推导）、plugins/main-install.js
 * （安装窗 / 权重指路的目录口径 + 安装开始时的 ensureDir）。渲染层的子目录名表在
 * renderer/app-plugins.js，两侧靠 plugins/plugin-root.js 的 mapDir / defaultDir 对齐，
 * 别在别处再抄一份。
 */
"use strict";

const fs = require("fs");
const path = require("path");

/** 插件 id / 别名 → 该插件自己的配置文件（相对数据目录）。
 *  「插件 id」不等于配置目录名的那几个（yue2→yue、breeze→breeze-tts、h3→h3…）在这里对齐；
 *  单段别名表 + 通用规则一起喂进 configOf()，多写一行不会有副作用。
 *  **tts-local 保留一行**（虽然该插件已随 1.5.x 移除）：已装机器的 %APPDATA% 里还留着
 *  tts/config.json 与其中的 installDir，卸掉那 6–12GB 的安装目录要靠它认路（见 main-install.js
 *  的 UNINSTALL_SPECS）；capability 不再提供，只是不再有安装入口。 */
const PLUGIN_CFG = {
  /* 已移除、但老机器上还留着安装目录的插件：**必须有这一行**，否则认不出它有「自己的目录」，
     安装 / 修复链会把它当成窗口插件（dir 空串）→ 宿主报 empty_dir。见 PLUGIN_SUBDIR 的说明。 */
  asr: "asr/config.json",
  "minimax-music3": "music3/config.json",
  music3: "music3/config.json",
  "yue2-local": "yue/config.json",
  yue2: "yue/config.json",
  yue: "yue/config.json",
  "sensenova-local": "sensenova/config.json",
  sensenova: "sensenova/config.json",
  "minimax-h3": "h3/config.json",
  h3: "h3/config.json",
  "llama-local": "llama/config.json",
  llama: "llama/config.json",
  "tts-local": "tts/config.json",
  tts: "tts/config.json",
  "breeze-tts-local": "breeze-tts/config.json",
  breeze: "breeze-tts/config.json",
  remotion: "remotion/config.json",
};

/** 插件 id / 别名 → **默认子目录名**。有名字 = 「安装时要目录的插件」，
 *  默认安装目录 = 插件根目录 + 这个名字（本轮共识：沿用用户现有目录名）。
 *  7 个本地后端插件正好对应 main.js 注册的那 7 套宿主（music3/yue/h3/llama/
 *  breeze/sensenova/remotion）—— 加新后端时在这里补一行即可，别在别处再写一份。
 *  asr 也在这里：它随 1.5.x 从插件目录移除了，但**老机器上还留着 asr/config.json + 安装目录**，
 *  而它有自己的目录与修复链（别处只把空目录当「没装」处理）；不列在这里的话
 *  ensureDir 会把它当窗口插件回空串 → 安装链又变成 empty_dir（本轮共识：不写死 7 个）。
 *  已移除的 tts-local **故意不在这里**：没有安装入口就不需要默认目录，
 *  它已装的那份靠 PLUGIN_CFG + 用户配置里设过的 installDir 认路（卸载用）。 */
const PLUGIN_SUBDIR = {
  asr: "asr",
  "minimax-music3": "music",
  music3: "music",
  "yue2-local": "yue2",
  yue2: "yue2",
  /* yue 这一行**只为旧现场兼容**：历史上 yue/main-yue.js 的 PLUGIN_ID 写过短名 "yue"，
     老机器上可能有按它算出来的目录记录 / 调用（安装通道 yue:install 至今仍用短名当通道前缀）。
     宿主常量已收口成卡片 id "yue2-local"，全仓不再有第二个**插件 id**；这条别名保留但它与
     yue2-local / yue2 必须指向同一个子目录，否则旧 id 这条路上会被当成「窗口插件」——
     ensureDir 回空目录、又说「不需要目录」，安装链落成 empty_dir（真事故）。 */
  yue: "yue2",
  "sensenova-local": "sense",
  sensenova: "sense",
  "minimax-h3": "video",
  h3: "video",
  "llama-local": "vLLM",
  llama: "vLLM",
  "breeze-tts-local": "breeze",
  breeze: "breeze",
  remotion: "remotion",
};

/** 目录就绪的标记：任一命中就当作「这个目录真的装过东西」（推断与展示都用它）。 */
const READY_MARKERS = [".install-ok", ".venv", "ComfyUI", "node_modules", "models", ".scaffold-ref"];

function readJson(p, fb) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fb;
  }
}
function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2), "utf8");
  fs.renameSync(tmp, p);
}
function normDir(p) {
  const s = String(p || "").trim();
  if (!s) return "";
  try {
    const r = path.resolve(s);
    /* 盘符根（E:\）不能被剥成 "E:" —— 那会被当成**相对路径**再去 resolve，护栏就形同虚设 */
    if (/^[a-zA-Z]:\\?$/.test(r) || r === "/" || /^\\\\[^\\]+\\[^\\]+$/.test(r)) return r;
    return r.replace(/[/\\]+$/, "");
  } catch {
    return "";
  }
}
function isInside(parent, child) {
  const a = normDir(parent);
  const b = normDir(child);
  if (!a || !b) return false;
  const cmp = process.platform === "win32" ? (s) => s.toLowerCase() : (s) => s;
  const x = cmp(a);
  const y = cmp(b);
  return y === x || y.startsWith(x + path.sep);
}
function existsDir(p) {
  try {
    return !!p && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 插件 id / 别名 → 它的配置文件绝对路径（认不出返回空串）。 */
function configOf(dataDir, id) {
  const sid = String(id || "").trim();
  if (!sid) return "";
  const rel = PLUGIN_CFG[sid] || sid + "/config.json";
  return path.join(String(dataDir || ""), rel);
}

/** 读该插件**自己设过**的安装目录；没设过 / 认不出 → 空串（不在这里算默认值）。 */
function readPluginDir(dataDir, id) {
  const p = configOf(dataDir, id);
  if (!p) return "";
  const cfg = readJson(p, null);
  if (!cfg || typeof cfg !== "object") return "";
  return normDir(cfg.installDir);
}
/**
 * 把这个插件自己的安装目录**写回去**（清 = 传空串，与各插件的 saveConfig 同一形状）。
 * opts.create = true：该插件的配置还没落过盘时**新起一份**（只带 installDir）——
 * 各宿主的 loadConfig 一律是 `Object.assign(defaultConfig(), readJson(...))`，缺的键由默认值补齐，
 * 所以这份「最小配置」与它自己 saveConfig 出来的效果一致（安装时自动落目录要用，见 ensureDir）。
 */
function writePluginDir(dataDir, id, dir, opts) {
  const p = configOf(dataDir, id);
  if (!p) return { ok: false, error: "unknown_plugin" };
  const create = !!(opts && opts.create);
  let cur = readJson(p, null);
  if (!cur || typeof cur !== "object" || Array.isArray(cur)) {
    if (!create) return { ok: false, error: "no_config" };
    cur = {};
  }
  cur.installDir = normDir(dir);
  try {
    writeJson(p, cur);
    return { ok: true, installDir: cur.installDir };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function createPluginRoot(opts) {
  const o = opts || {};
  const dataDir = () => String((typeof o.getDataDir === "function" ? o.getDataDir() : "") || "");
  const appDirs = () => {
    const out = [];
    for (const d of (typeof o.getAppDirs === "function" ? o.getAppDirs() || [] : [])) {
      const n = normDir(d);
      if (n) out.push(n);
    }
    return out;
  };

  function configPath() {
    return path.join(dataDir(), "config.json");
  }
  /** 用户显式设过的插件根目录（没设过 = 空串）。 */
  function get() {
    const cfg = readJson(configPath(), {});
    const p = cfg && cfg.plugins;
    return p && typeof p === "object" ? normDir(p.installDir) : "";
  }
  /** 留空 = 清掉（回到「未设 → 首次打开提示设置」那一态）。 */
  function set(dir) {
    const n = normDir(dir);
    if (!n) {
      const cfg = readJson(configPath(), {});
      if (cfg && typeof cfg === "object") {
        if (cfg.plugins && typeof cfg.plugins === "object") delete cfg.plugins.installDir;
        try {
          writeJson(configPath(), cfg);
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) };
        }
      }
      return { ok: true, installDir: "", cleared: true };
    }
    const bad = rejectReason(n);
    if (bad) return { ok: false, error: bad };
    const cfg = readJson(configPath(), {});
    const next = cfg && typeof cfg === "object" && !Array.isArray(cfg) ? cfg : {};
    if (!next.plugins || typeof next.plugins !== "object") next.plugins = {};
    next.plugins.installDir = n;
    try {
      writeJson(configPath(), next);
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
    return { ok: true, installDir: n };
  }

  /** 拒收理由（空串 = 合格）：盘符根 / 应用目录 / 数据目录一律不收。 */
  function rejectReason(dir) {
    const n = normDir(dir);
    if (!n) return "empty_dir";
    const driveRoot = /^[a-zA-Z]:\\?$/.test(n) || n === "/" || /^\\\\[^\\]+\\[^\\]+$/.test(n);
    if (driveRoot) return "refuse_root";
    for (const d of appDirs()) if (isInside(d, n) || isInside(n, d)) return "refuse_app_dir";
    const dd = normDir(dataDir());
    if (dd && (isInside(dd, n) || isInside(n, dd))) return "refuse_data_dir";
    return "";
  }

  /** 有目录的插件清单：哪些已设、目录还在不在（推断与界面展示共用一份现场）。
   *  按**配置文件**去重：一个插件有多个别名（music3 / minimax-music3 同一份配置），
   *  只算一次，否则推断的「几个插件同属一个父目录」会被别名灌水。 */
  function entries() {
    const dd = dataDir();
    const seen = new Map();
    for (const id of Object.keys(PLUGIN_CFG)) {
      const cfg = configOf(dd, id);
      if (!cfg || seen.has(cfg)) continue;
      const dir = readPluginDir(dd, id);
      seen.set(cfg, 1);
      if (!dir) continue;
      seen.set(cfg, { id, dir, parent: path.dirname(dir), exists: existsDir(dir) });
    }
    const out = [];
    for (const v of seen.values()) if (v && typeof v === "object") out.push(v);
    return out;
  }

  /**
   * 推断根目录 = 「已设过目录的插件」里插件数最多的公共父目录。
   * 至少 2 个插件同属它，且父目录本身合格（不是盘符根、不是应用 / 数据目录）。
   * 只算已设过的插件：用户已确认过的目录才参与，不会把没设过的插件卷进来。
   */
  function infer() {
    const list = entries();
    const tally = new Map();
    for (const e of list) {
      if (!e.parent) continue;
      const k = process.platform === "win32" ? e.parent.toLowerCase() : e.parent;
      const cur = tally.get(k) || { dir: e.parent, ids: [] };
      cur.ids.push(e.id);
      tally.set(k, cur);
    }
    let best = null;
    for (const v of tally.values()) {
      if (v.ids.length < 2) continue;
      if (rejectReason(v.dir)) continue;
      if (!best || v.ids.length > best.ids.length) best = v;
    }
    if (!best) return { dir: "", reason: "no_common_parent", ids: [] };
    return { dir: best.dir, reason: "", ids: best.ids.slice().sort() };
  }

  /** 现状（渲染层只吃这一份）：用户设过的值、推断出来的预填值、是否已设。 */
  function status() {
    const setDir = get();
    const inf = setDir ? { dir: "", reason: "has_root", ids: [] } : infer();
    return {
      ok: true,
      installDir: setDir,
      set: !!setDir,
      inferred: inf.dir,
      inferReason: inf.reason,
      inferIds: inf.ids,
      dataDir: dataDir(),
    };
  }

  /** 插件自己的目录（已设过才有值）。 */
  function pluginDir(id) {
    return readPluginDir(dataDir(), id);
  }
  /** 它自己那份配置里**真的设过 installDir**吗（空串 / 没这份配置 / 读不动 = 否）。
   *  判据只看有没有那个字段，不看值合不合格 —— 值不合格由调用方照旧报错。 */
  function hasOwnInstallDir(id) {
    const p = configOf(dataDir(), String(id || "").trim());
    if (!p) return false;
    const cfg = readJson(p, null);
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return false;
    return !!normDir(cfg.installDir);
  }

  /** 默认子目录名（空串 = 不是「需目录的插件」）。
   *  显式表（PLUGIN_SUBDIR）优先；表里没有但**它有自己 installDir 配置**的（云端新插件、
   *  遗留插件）退回它的配置目录名 —— 口径只此一处，别在别处再拼一次。 */
  function subDir(id) {
    return subDirNameOf(id) || deriveSubDirName(id);
  }
  /** 是否是「安装时要目录的插件」：**它有自己那份 installDir 配置**才算法。
   *  判据（只用已有事实，绝不猜）：显式子目录表里有它，或它自己那份配置已经落在盘上；
   *  两者都不沾的 id（窗口插件 / 桌宠 / 认不出的云端插件）→ **不**动它 ——
   *  它们的老口径是 <数据目录>/app-plugins/<id> 或插件自己的目录，硬塞插件根目录会踩到
   *  它们自己的卸载/安装路由（有冒烟钉着这条路，别放宽）。 */
  function needsDir(id) {
    const sid = String(id || "").trim();
    if (!sid) return false;
    if (subDirNameOf(sid)) return true;
    return hasOwnInstallDir(sid);
  }
  /** 「根目录 + 默认子目录名」；根目录没设或 id 认不出 → 空串。 */
  function defaultDir(id, sub) {
    const root = get();
    const name = String(sub || subDirNameOf(id) || "").trim();
    if (!root || !name) return "";
    return path.join(root, name);
  }
  /**
   * 按 id / 别名找配置里的安装目录（不做通用回退 —— 回退由调用方决定）。
   * 给「不知道这个 id 是不是后端插件」的入口（窗口插件 / 兜底 id）用。
   */
  function mapDir(id) {
    return readPluginDir(dataDir(), id);
  }

  /**
   * 安装真正开始时把默认目录**落地**（本轮需求：设了插件根目录就不该再让用户手建文件夹）。
   *   ① 插件自己设过 installDir → 原样返回，不建、不改写（人的选择优先，「已装的插件不动」）。
   *   ② 没设过、且它是「需目录的插件」→ 根目录 + 默认子目录名：
   *        · mkdir -p（根目录本身不存在就一起建出来）；
   *        · 把结果写回它自己的 installDir（安装 / 卸载 / 权重指路 / 修复会话从此认同一处）；
   *        · 已存在则**直接复用**，绝不删改里面已有的内容（重装 / 续装靠它们跳过已完成步骤）。
   *   ③ 其余（窗口插件 / 桌宠 / 认不出的 id）→ 不建不写，交回老口径（dir 为空串）。
   * 只该在**安装**路径上调（安装窗点「开始安装」）；只读入口（installDirOf / status / entries）
   * 不许建目录 —— 插件界面一打开就会问一遍各插件的目录，那时造文件夹是副作用。
   * 返回 { ok, dir, source: "plugin"|"root"|"legacy", created, wrote, needs, cfgPath, error, message }。
   *   · needs=true 而 dir 为空 = **本该给它建目录却没建出来**（调用方据此如实报错，
   *     别再把「目录为空」往下传成宿主的 empty_dir）；
   *   · cfgPath = 这次写回的是哪一份配置文件（调用方可复核，冒烟也认这一份）。
   */
  function ensureDir(id) {
    const sid = String(id || "").trim();
    if (!sid) return { ok: false, error: "bad_id", dir: "", source: "", created: false, wrote: false };
    const dd = dataDir();
    const cfgPath = configOf(dd, sid);
    const own = readPluginDir(dd, sid);
    if (own) return { ok: true, dir: own, source: "plugin", created: false, wrote: false, needs: true, cfgPath };
    /* 子目录名：显式表优先，其次按它自己那份配置推导（见 deriveSubDirName）。
       needsDir 与这里同源（表里有 / 配置里真设过），所以不会出现「说该建却不建」。 */
    const name = subDirNameOf(sid) || deriveSubDirName(sid);
    const needs = needsDir(sid);
    if (!needs) {
      /* 认不出的 id（窗口插件 / 桌宠 / 云端插件）：不建不写，交回老口径（dir 为空串） */
      return { ok: true, dir: "", source: "legacy", created: false, wrote: false, needs: false, cfgPath: "" };
    }
    const dir = defaultDir(sid, name);
    if (!dir) {
      return {
        ok: false,
        error: "need_root",
        dir: "",
        source: "root",
        created: false,
        wrote: false,
        needs: true,
        cfgPath,
        message: "还没有设置插件根目录：先在插件界面顶部选一个插件根目录。",
      };
    }
    const bad = rejectReason(dir);
    if (bad) {
      /* 根目录是**早就设过的**（护栏收紧前后 / 配置文件被手改过）时兜一道：
         不建危险目录，并把话说明白（安装窗会把 message 原样给用户看）。 */
      const why = {
        refuse_root: "默认安装目录落在盘符根上：请把插件根目录设成一个专门放插件的文件夹",
        refuse_app_dir: "默认安装目录落在应用目录里（升级 / 卸载会带走）：请另选一个插件根目录",
        refuse_data_dir: "默认安装目录落在数据目录里：请另选一个插件根目录",
      };
      return { ok: false, error: bad, dir, source: "root", created: false, wrote: false, needs: true, cfgPath, message: why[bad] || bad };
    }
    const existed = existsDir(dir);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      return {
        ok: false,
        error: "mkdir_failed",
        dir,
        source: "root",
        created: false,
        wrote: false,
        needs: true,
        cfgPath,
        message: String((e && e.message) || e),
      };
    }
    const w = writePluginDir(dd, sid, dir, { create: true });
    if (!w.ok) {
      return {
        ok: false,
        error: "write_failed",
        dir,
        source: "root",
        created: !existed,
        wrote: false,
        needs: true,
        cfgPath,
        message: String(w.error || ""),
      };
    }
    return { ok: true, dir, source: "root", created: !existed, wrote: true, needs: true, cfgPath };
  }

  return {
    configPath,
    get,
    set,
    rejectReason,
    entries,
    infer,
    status,
    pluginDir,
    subDir,
    needsDir,
    defaultDir,
    mapDir,
    ensureDir,
    readPluginDir,
    writePluginDir,
    configOf,
  };
}

/** 插件 id / 别名 → 默认子目录名（空串 = 不是「需目录的插件」，如窗口插件 / 桌宠）。 */
function subDirNameOf(id) {
  return PLUGIN_SUBDIR[String(id || "").trim()] || "";
}

/**
 * 没在 PLUGIN_SUBDIR 里、但**有自己 installDir 配置**的插件 → 默认子目录名。
 * 为什么要有这条：本轮共识是「今后任何『有自己安装目录』的插件都自动纳入默认目录逻辑」——
 * 靠一张写死的表意味着每加一个后端插件都要记得补一行，漏了就退回 empty_dir。
 * 规则（只用已有事实，不猜）：
 *   · id 自己就在 PLUGIN_CFG 里（如 asr）→ 配置目录名就是子目录名；
 *   · 否则认**别名**：PLUGIN_CFG 里目录名相同的别名叫什么，就用那个子目录名
 *     （如 id="sensenova" → 别名 "sensenova-local" → "sense"）；
 *   · 有配置位而认不出上面两样 → 用 id 本身当子目录名（云端新插件的常规形状）。
 * 认不出配置位的 id（窗口插件 / 桌宠 / 未知 id）→ 空串，交回老口径。
 */
function deriveSubDirName(id) {
  const sid = String(id || "").trim();
  if (!sid) return "";
  const rel = PLUGIN_CFG[sid];
  /* ① 认得出配置位：配置目录名就是子目录名；认不出再找同名配置目录的别名 */
  const pdir = rel ? String(rel).split("/")[0].trim() : "";
  if (!pdir) {
    for (const alias of Object.keys(PLUGIN_CFG)) {
      const a = String(PLUGIN_CFG[alias] || "").split("/")[0].trim();
      if (!a || a !== sid) continue;
      const sub = PLUGIN_SUBDIR[alias];
      if (sub) return String(sub).trim();
    }
    /* ② 完全不认识这个 id（窗口插件 / 桌宠 / 未知 id）→ 空串，交回老口径 */
    return "";
  }
  return pdir;
}

module.exports = {
  createPluginRoot,
  PLUGIN_CFG,
  PLUGIN_SUBDIR,
  READY_MARKERS,
  subDirNameOf,
  deriveSubDirName,
  normDir,
  readPluginDir,
  writePluginDir,
  configOf,
};
