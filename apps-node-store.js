"use strict";

/* ═══════════════ 应用节点（kind appnode）的主进程侧 ═══════════════
 *
 * 应用节点 = 把「应用中心」里的某个静态应用钉在画布上：点节点进全屏界面，
 * 界面里能拿到 MTNode 的能力（画布读写 / agent / 工作目录文件 / 工具与数据库 /
 * 联网）与它自己那份数据。渲染层的界面与桥见 renderer/app-appnode.js。
 *
 * 本模块只管落盘与路径，四个契约（用户共识）：
 *   ① 数据根只落在**画布工作目录**里：`<工作目录>/apps-data/<appId>/data.json`。
 *      不复用 <数据目录>/apps-data（那是应用中心窗口的落点），也不跟节点 id 分离 ——
 *      同一应用钉两张画布，各自的数据跟着各自的画布走。
 *   ② 工作目录必须是绝对路径且真实存在；缺了直接拒（绝不猜、绝不写到别处）。
 *   ③ 应用页面能碰的文件只有工作目录里的东西：任何 `..` / 盘符逃逸一律拒。
 *   ④ 应用的静态文件只读：本模块不写应用目录（应用页数据一律走 apps-data）。
 *
 * 应用目录解析复用 apps-store.js 的口径（dirOfApp / rootsInfo），这里不重造：
 * 同一个 id 在「开发根 / 下载根」各有一份时的取舍那边已经定死了。
 * ───────────────────────────────────────────────────────────────────── */

const fs = require("fs");
const path = require("path");
const { ipcMain, shell } = require("electron");
const appsStore = require("./apps-store.js");
/* 联网取素材：与独立应用窗口**同一份**实现（搜索 / 流式下载 + 扩展名白名单） */
const netFetchMod = require("./net-download.js");

let t = (s) => String(s == null ? "" : s);
let getMainWin = () => null;

const DATA_FILE = "data.json";
const DATA_MAX_BYTES = 2 * 1024 * 1024; /* 与 appHost 的整份上限同口径（2MB） */
const APP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;

function bad(error, code) {
  return { ok: false, code: String(code || "error"), error: String(error || "") };
}
function isObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
/* 一个路径是不是在 base 里面（含 base 自身） */
function insideOf(base, p) {
  const rel = path.relative(base, p);
  if (!rel) return true;
  if (path.isAbsolute(rel)) return false;
  return !(rel === ".." || rel.startsWith(".." + path.sep) || rel.startsWith("../"));
}
/* 画布工作目录：只认绝对路径 + 真实存在的目录 */
function normWorkdir(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return "";
  if (!path.isAbsolute(s)) return "";
  const abs = path.resolve(s);
  try {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return "";
  } catch {
    return "";
  }
  return abs;
}
function safeAppId(v) {
  const s = String(v == null ? "" : v).trim();
  return APP_ID_RE.test(s) ? s : "";
}
/* 应用在本机的目录（两套根都找，口径与 apps-store 一致） */
function appDirOfId(id) {
  try {
    const dir = appsStore.dirOfApp(id);
    return dir && fs.existsSync(dir) ? dir : "";
  } catch {
    return "";
  }
}
function readManifest(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, "app.json"), "utf8");
    const man = JSON.parse(raw);
    return isObj(man) ? man : null;
  } catch {
    return null;
  }
}
function entryOf(man, dir) {
  const e = man && typeof man.entry === "string" ? man.entry.trim() : "";
  if (e && /\.html?$/i.test(e) && !path.isAbsolute(e) && e.indexOf("..") < 0) return e;
  try {
    if (fs.existsSync(path.join(dir, "index.html"))) return "index.html";
  } catch {}
  return "index.html";
}
function titleOf(man, id) {
  const tt = man && isObj(man.title) ? man.title : null;
  if (tt) {
    for (const k of ["zh", "en"]) {
      const v = typeof tt[k] === "string" ? tt[k].trim() : "";
      if (v) return v;
    }
  }
  return String(id || "");
}
/* 本机可绑的应用清单：两套根各扫一遍目录，app.json 缺了也列出（标题回落目录名） */
function listLocalApps() {
  const out = [];
  const seen = Object.create(null);
  let roots = {};
  try {
    roots = appsStore.rootsInfo() || {};
  } catch {
    roots = {};
  }
  for (const kind of Object.keys(roots)) {
    const root = String((roots[kind] && roots[kind].path) || "");
    if (!root) continue;
    let ents = [];
    try {
      ents = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of ents) {
      if (!ent || !ent.isDirectory || !ent.isDirectory()) continue;
      const id = String(ent.name || "");
      if (!safeAppId(id)) continue;
      const key = id.toLowerCase();
      if (seen[key]) continue;
      const dir = path.join(root, id);
      const man = readManifest(dir);
      seen[key] = true;
      out.push({
        id: id,
        title: titleOf(man, id),
        entry: entryOf(man, dir),
        dir: dir,
        kind: String(kind || ""),
        dev: !!(man && man.dev === true),
        version: man && typeof man.version === "string" ? man.version : "",
      });
    }
  }
  out.sort((a, b) => String(a.title).localeCompare(String(b.title), "zh"));
  return out;
}
/* 该应用的数据目录：<工作目录>/apps-data/<appId>（不存在就建） */
function dataRootOf(workdir, appId, create) {
  const base = path.join(workdir, "apps-data", appId);
  if (!insideOf(workdir, base)) return "";
  if (create) {
    try {
      fs.mkdirSync(base, { recursive: true });
    } catch {
      return "";
    }
  }
  return base;
}
function normDataFileName(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s || s === DATA_FILE) return DATA_FILE;
  return "";
}

/* ── IPC ─────────────────────────────────────────────────────────────── */

function registerAppsNodeIpc(opts) {
  const o = isObj(opts) ? opts : {};
  if (typeof o.t === "function") t = o.t;
  if (typeof o.getMainWin === "function") getMainWin = o.getMainWin;

  /* 可绑应用清单（创建节点时那一次选择用） */
  ipcMain.handle("appnode:list", () => {
    const apps = listLocalApps();
    return { ok: true, apps: apps, count: apps.length };
  });

  /* 该应用在本机的目录 / 入口页 / 标题（应用节点渲染与打开界面都问它） */
  ipcMain.handle("appnode:resolve", (_e, arg) => {
    const a = isObj(arg) ? arg : {};
    const id = safeAppId(a.appId);
    if (!id) return bad(t("应用 id 不合法"), "bad_id");
    const dir = appDirOfId(id);
    if (!dir) return Object.assign(bad(t("该应用不在本机"), "missing"), { missing: true, id: id });
    const man = readManifest(dir);
    return {
      ok: true,
      id: id,
      dir: dir,
      entry: entryOf(man, dir),
      title: titleOf(man, id),
      version: man && typeof man.version === "string" ? man.version : "",
    };
  });

  /* 数据目录：选应用确认后建一次（<工作目录>/apps-data/<appId>） */
  ipcMain.handle("appnode:dataRoot", (_e, arg) => {
    const a = isObj(arg) ? arg : {};
    const id = safeAppId(a.appId);
    if (!id) return bad(t("应用 id 不合法"), "bad_id");
    const wd = normWorkdir(a.workdir);
    if (!wd) return bad(t("这张画布还没有工作目录（先在顶栏选一个文件夹）"), "no_workdir");
    const dir = dataRootOf(wd, id, true);
    if (!dir) return bad(t("工作目录里建不出应用数据目录"), "mkdir_failed");
    return { ok: true, id: id, dir: dir, file: path.join(dir, DATA_FILE) };
  });

  /* 读整份数据（不存在 = 空对象，与 appHost.dataRead 同口径） */
  ipcMain.handle("appnode:dataRead", (_e, arg) => {
    const a = isObj(arg) ? arg : {};
    const id = safeAppId(a.appId);
    if (!id) return bad(t("应用 id 不合法"), "bad_id");
    const wd = normWorkdir(a.workdir);
    if (!wd) return bad(t("这张画布还没有工作目录（先在顶栏选一个文件夹）"), "no_workdir");
    const name = normDataFileName(a.file);
    if (!name) return bad(t("数据文件名不合法"), "bad_file");
    const dir = dataRootOf(wd, id, false);
    if (!dir) return bad(t("数据目录不合法"), "bad_dir");
    const file = path.join(dir, name);
    if (!insideOf(wd, file)) return bad(t("路径越界"), "outside");
    let data = {};
    let exists = false;
    try {
      if (fs.existsSync(file)) {
        exists = true;
        const raw = fs.readFileSync(file, "utf8");
        const parsed = raw ? JSON.parse(raw) : {};
        if (isObj(parsed)) data = parsed;
      }
    } catch (err) {
      return bad(t("数据读不出来：") + String((err && err.message) || err), "bad_json");
    }
    return { ok: true, data: data, dir: dir, file: file, exists: exists };
  });

  /* 写整份数据（原子写：tmp + rename；超 2MB 拒） */
  ipcMain.handle("appnode:dataWrite", (_e, arg) => {
    const a = isObj(arg) ? arg : {};
    const id = safeAppId(a.appId);
    if (!id) return bad(t("应用 id 不合法"), "bad_id");
    const wd = normWorkdir(a.workdir);
    if (!wd) return bad(t("这张画布还没有工作目录（先在顶栏选一个文件夹）"), "no_workdir");
    const name = normDataFileName(a.file);
    if (!name) return bad(t("数据文件名不合法"), "bad_file");
    const dir = dataRootOf(wd, id, true);
    if (!dir) return bad(t("数据目录建不出来"), "mkdir_failed");
    const file = path.join(dir, name);
    if (!insideOf(wd, file)) return bad(t("路径越界"), "outside");
    let text = "";
    try {
      text = JSON.stringify(isObj(a.data) ? a.data : {}, null, 2);
    } catch (err) {
      return bad(t("数据不是可序列化的 JSON"), "bad_json");
    }
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > DATA_MAX_BYTES) return bad(t("应用数据超出上限（2MB）"), "too_large");
    const tmp = file + ".tmp";
    try {
      fs.writeFileSync(tmp, text, "utf8");
      fs.renameSync(tmp, file);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {}
      return bad(t("数据写不进去：") + String((err && err.message) || err), "write_failed");
    }
    return { ok: true, bytes: bytes, file: file, dir: dir };
  });

  /* 在资源管理器里打开数据目录（⚙ 里那颗「打开文件夹」） */
  ipcMain.handle("appnode:openDir", async (_e, arg) => {
    const a = isObj(arg) ? arg : {};
    const id = safeAppId(a.appId);
    if (!id) return bad(t("应用 id 不合法"), "bad_id");
    const wd = normWorkdir(a.workdir);
    if (!wd) return bad(t("这张画布还没有工作目录（先在顶栏选一个文件夹）"), "no_workdir");
    const dir = dataRootOf(wd, id, true);
    if (!dir) return bad(t("数据目录建不出来"), "mkdir_failed");
    try {
      await shell.openPath(dir);
    } catch (err) {
      return bad(t("打不开文件夹：") + String((err && err.message) || err), "open_failed");
    }
    return { ok: true, dir: dir };
  });

  /* 工作目录里的文件读写（应用页 appHost.fs.*；越出工作目录一律拒） */
  ipcMain.handle("appnode:fs", (_e, arg) => {
    const a = isObj(arg) ? arg : {};
    const wd = normWorkdir(a.workdir);
    if (!wd) return bad(t("这张画布还没有工作目录（先在顶栏选一个文件夹）"), "no_workdir");
    const op = String(a.op || "");
    const rel = String(a.rel == null ? "" : a.rel).replace(/\\/g, "/");
    const abs = path.resolve(wd, rel || ".");
    /* exists 只判存在性（不读内容 / 不写盘 / 不列目录）：**不限于工作目录** ——
       应用要在「上传本机图 / 引用画布节点图」之后复核那张图还在不在，而这些路径天生在工作目录之外。
       锁死工作目录 = 应用把每张外部图都报成「这张图不在」。其余操作仍只认工作目录。 */
    if (op === "exists") {
      try {
        return { ok: true, path: abs, exists: fs.existsSync(abs), outside: !insideOf(wd, abs) };
      } catch (err) {
        return bad(t("文件操作失败：") + String((err && err.message) || err), "fs_failed");
      }
    }
    if (!insideOf(wd, abs)) return bad(t("只能读写画布工作目录里的文件"), "outside");
    try {
      if (op === "root") return { ok: true, root: wd };
      if (op === "readText") {
        const st = fs.statSync(abs);
        if (st.size > 8 * 1024 * 1024) return bad(t("文件太大（上限 8MB）"), "too_large");
        return { ok: true, path: abs, text: fs.readFileSync(abs, "utf8") };
      }
      if (op === "writeText") {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, String(a.content == null ? "" : a.content), "utf8");
        return { ok: true, path: abs };
      }
      if (op === "list") {
        const ents = fs.readdirSync(abs, { withFileTypes: true });
        return {
          ok: true,
          path: abs,
          items: ents.map((e) => ({
            name: String(e.name || ""),
            dir: !!(e.isDirectory && e.isDirectory()),
          })),
        };
      }
      if (op === "mkdir") {
        fs.mkdirSync(abs, { recursive: true });
        return { ok: true, path: abs };
      }
      if (op === "remove") {
        if (abs === wd) return bad(t("不能删画布工作目录本身"), "refused");
        fs.rmSync(abs, { recursive: true, force: true });
        return { ok: true, path: abs };
      }
      return bad(t("不认识的文件操作"), "bad_op");
    } catch (err) {
      return bad(t("文件操作失败：") + String((err && err.message) || err), "fs_failed");
    }
  });

  /* 联网取素材（net.search / net.download）：应用页 CSP 是 connect-src 'none'，
     请求只能由主进程代发；实现在 net-download.js（与独立应用窗口逐字同一条）。
     download 只往**这张画布的工作目录**里写：越界 / 非素材扩展名一律拒。 */
  ipcMain.handle("appnode:net", async (_e, arg) => {
    const a = isObj(arg) ? arg : {};
    const op = String(a.op || "");
    const url = String(a.url || "");
    if (op === "search") return netFetchMod.search({ url: url, headers: a.headers, timeoutMs: a.timeoutMs });
    if (op !== "download") return bad(t("不认识的联网操作"), "bad_op");
    const wd = normWorkdir(a.workdir);
    if (!wd) return bad(t("这张画布还没有工作目录（先在顶栏选一个文件夹）"), "no_workdir");
    const rel = String(a.rel == null ? (a.path == null ? "" : a.path) : a.rel).replace(/\\/g, "/");
    if (!rel) return bad(t("没给落盘位置（素材只能写进画布工作目录）"), "bad_dest");
    const abs = path.resolve(wd, rel);
    if (!insideOf(wd, abs)) return bad(t("只能写进画布工作目录里"), "outside");
    const ext = path.extname(abs).toLowerCase();
    if (!netFetchMod.OK_EXT.has(ext)) return bad(t("只认素材扩展名（图 / 音 / 视频）"), "bad_ext");
    return netFetchMod.download({
      url: url,
      destPath: abs,
      headers: a.headers,
      maxBytes: a.maxBytes,
      timeoutMs: a.timeoutMs,
    });
  });
  return true;
}

module.exports = {
  registerAppsNodeIpc,
  /* 纯函数（冒烟直接真跑）：路径守卫与清单归一 */
  insideOf,
  normWorkdir,
  safeAppId,
  normDataFileName,
  DATA_FILE,
  DATA_MAX_BYTES,
};
