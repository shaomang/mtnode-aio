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
 * 谁在用：plugins/main-app-plugins.js（IPC + 默认目录推导）、plugins/main-install.js
 * （安装窗 / 权重指路的目录口径）。渲染层的子目录名表在 renderer/app-plugins.js，
 * 两侧靠 plugins/plugin-root.js 的 mapDir / defaultDir 对齐，别在别处再抄一份。
 */
"use strict";

const fs = require("fs");
const path = require("path");

/** 插件 id / 别名 → 该插件自己的配置文件（相对数据目录）。
 *  「插件 id」不等于配置目录名的那几个（yue2→yue、breeze→breeze-tts、h3→h3…）在这里对齐；
 *  单段别名表 + 通用规则一起喂进 configOf()，多写一行不会有副作用。 */
const PLUGIN_CFG = {
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
 *  8 个本地后端插件正好对应 main.js 注册的那 8 套宿主（music3/yue/h3/llama/tts/
 *  breeze/sensenova/remotion）—— 加新后端时在这里补一行即可，别在别处再写一份。 */
const PLUGIN_SUBDIR = {
  "minimax-music3": "music",
  music3: "music",
  "yue2-local": "yue2",
  yue2: "yue2",
  "sensenova-local": "sense",
  sensenova: "sense",
  "minimax-h3": "video",
  h3: "video",
  "llama-local": "vLLM",
  llama: "vLLM",
  "tts-local": "tts",
  tts: "tts",
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
/** 把这个插件自己的安装目录**写回去**（清 = 传空串，与各插件的 saveConfig 同一形状）。 */
function writePluginDir(dataDir, id, dir) {
  const p = configOf(dataDir, id);
  if (!p) return { ok: false, error: "unknown_plugin" };
  const cur = readJson(p, null);
  if (!cur || typeof cur !== "object") return { ok: false, error: "no_config" };
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
  /** 默认子目录名（空串 = 不是「需目录的插件」）。 */
  function subDir(id) {
    return subDirNameOf(id);
  }
  /** 是否是「安装时要目录的插件」（有默认子目录名的那 8 个 + 以后补进来的）。 */
  function needsDir(id) {
    return !!subDirNameOf(id);
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
    readPluginDir,
    writePluginDir,
    configOf,
  };
}

/** 插件 id / 别名 → 默认子目录名（空串 = 不是「需目录的插件」，如窗口插件 / 桌宠）。 */
function subDirNameOf(id) {
  return PLUGIN_SUBDIR[String(id || "").trim()] || "";
}

module.exports = {
  createPluginRoot,
  PLUGIN_CFG,
  PLUGIN_SUBDIR,
  READY_MARKERS,
  subDirNameOf,
  normDir,
  readPluginDir,
  writePluginDir,
  configOf,
};
