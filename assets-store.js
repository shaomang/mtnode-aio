"use strict";

/* ── 主进程侧「素材库」存储 ───────────────────────────────────────────
 * 素材库是独立于画布的本机内容仓库：画布删了，库里的东西还在；库里改了，所有
 * 引用它的画布下次读取即生效。库落在用户指定的根目录（项目目录）下，根路径写进
 * <数据目录>/config.json 的 assetRoot 字段（默认 <数据目录>/asset-lib —— 不能用
 * <数据目录>/assets，那个目录已被「每画布的图像/媒体资产」按 wfId 占用）。
 *
 * 目录语义（一条规则判定「素材」还是「分类」）：
 *   <root>/<分类路径>/<素材夹>/.mtnode-asset.json   ← 有这个标记文件 ＝ 素材
 *   没有标记文件的子目录                             ＝ 分类（可继续嵌套）
 *   素材夹内 items/ 放实体文件（自包含：入库一律复制，不记原始绝对路径）
 *
 * 标记文件内容（schema 1）：
 *   {
 *     schema: 1, id: "as…",
 *     displayName: "显示名", desc: "描述",
 *     items: [ { id:"it…", title:"端子标题", type:"text"|"image"|"audio"|"video",
 *                file:"items/it….png",        // 相对素材夹、恒用 "/" 分隔
 *                bytes, createdAt, updatedAt } ],
 *     createdAt, updatedAt
 *   }
 * 条目文件恒为 items/<itemId><扩展名>：标题可改、文件名不动，改名不碰磁盘。
 *
 * 安全垫（都不实删）：
 *   覆盖写盘  → 旧文件先进 <素材夹>/.versions/，同一 itemId 只留最近 5 份（撤销要能回滚）
 *   删除任何东西 → 先进 <root>/.trash/<时间戳>__<名字>/，用户在资源管理器里可手工找回
 *   任何 rel 入参 → 逐段净化 + 前缀校验，绝不允许逃出根目录
 *
 * 渲染层没有 fs：扫描 / 建夹 / 改名 / 删除 / 素材与条目 CRUD / 导入 全部经这里的
 * IPC（preload 白名单桥 api.assets*，方法名与 tools* 同风格）。原子写沿用
 * config-providers 的 readJson / writeJson（tmp + rename）。
 * 媒体条目的字节读取不另开管道：摘要里带 absPath，渲染层用现成 asset:readDataUrl。
 * ─────────────────────────────────────────────────────────────────── */

const fs = require("fs");
const path = require("path");
const { ipcMain } = require("electron");
const { readJson, writeJson } = require("./config-providers.js");

const SCHEMA = 1;
const MARKER = ".mtnode-asset.json";
const ITEMS_DIR = "items";
const VERSIONS_DIR = ".versions";
const TRASH_DIR = ".trash";
const VERSION_KEEP = 5;
const ASSET_ID_RE = /^[A-Za-z0-9_-]{4,80}$/;
const ITEM_ID_RE = /^[A-Za-z0-9_-]{4,80}$/;
/* 遍历与导入时永不下探的名字（隐藏目录一律跳过） */
const SKIP_DIRS = new Set([TRASH_DIR, VERSIONS_DIR, ".git", "node_modules", "Thumbs.db"]);
const ITEM_TYPES = { text: 1, image: 1, audio: 1, video: 1 };

const EXT_TYPE = (() => {
  const m = {};
  const put = (type, exts) => {
    for (const e of exts) m[e] = type;
  };
  put("image", ["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg", "avif", "tiff", "ico"]);
  put("audio", ["mp3", "wav", "ogg", "oga", "flac", "aac", "m4a", "opus", "mid", "midi", "amr"]);
  put("video", ["mp4", "mov", "webm", "avi", "mkv", "m4v", "flv", "wmv", "mpeg", "mpg"]);
  put("text", [
    "txt", "md", "markdown", "json", "jsonc", "yaml", "yml", "csv", "tsv", "xml", "html",
    "htm", "css", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "lua", "sh", "bat", "ps1",
    "ini", "log", "srt", "ass", "lrc",
  ]);
  return m;
})();
/* 文本条目在库内的落盘扩展名（与 EXT_TYPE 口径一致：文本一律 .txt） */
const EXT_OF_TYPE = { text: ".txt", image: ".png", audio: ".wav", video: ".mp4" };

let getDataDir = () => "";
let t = (s) => String(s == null ? "" : s);

function badArg(msg) {
  return { ok: false, error: msg };
}
function fail(err) {
  return { ok: false, error: String((err && err.message) || err) };
}
function genId(prefix) {
  return (
    String(prefix || "as") +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 8)
  );
}

/* ---------------- 根目录 ---------------- */

const configPath = () => path.join(String(getDataDir() || ""), "config.json");

function defaultRoot() {
  const d = String(getDataDir() || "").trim();
  if (!d) throw new Error(t("素材库存储未初始化（缺少数据目录）"));
  return path.join(d, "asset-lib");
}

/* 只读不建：getRoot / 判空态时不该有副作用 */
function rootPath() {
  const cfg = readJson(configPath(), {}) || {};
  const r = typeof cfg.assetRoot === "string" ? cfg.assetRoot.trim() : "";
  return { root: r || defaultRoot(), configured: !!r };
}

function ensureRoot() {
  const { root } = rootPath();
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/* ---------------- 路径安全 ---------------- */

/* 单段名字净化：去分隔符与文件系统非法字符、去首尾点/空格、限长 */
function safeName(s, fb) {
  let v = String(s == null ? "" : s)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  v = v.replace(/^[.\s]+/, "").replace(/[.\s]+$/, "");
  if (v.length > 80) v = v.slice(0, 80).trim();
  if (!v || v === ".." || v === ".") v = String(fb || "untitled");
  return v;
}

/* rel（"/" 分隔的相对路径）→ 根目录内绝对路径；越界一律抛错 */
function relToAbs(root, rel) {
  const parts = String(rel == null ? "" : rel)
    .split(/[\\/]/)
    .filter((p) => p !== "" && p !== ".");
  let cur = path.resolve(root);
  for (const p of parts) {
    if (p === "..") throw new Error(t("非法路径"));
    cur = path.join(cur, safeName(p, "_"));
  }
  const abs = path.resolve(cur);
  const pre = path.resolve(root) + path.sep;
  if (abs !== path.resolve(root) && !abs.startsWith(pre))
    throw new Error(t("非法路径（越出素材库根目录）"));
  return abs;
}

function toRel(absPath, root) {
  return path
    .relative(path.resolve(root), path.resolve(absPath))
    .split(path.sep)
    .join("/");
}

/* 目录内不重名：base → base、base 2、base 3 …（保留原扩展名） */
function uniqueName(dir, base, ext) {
  const e = String(ext || "");
  let name = safeName(base, "untitled") + e;
  let i = 2;
  while (fs.existsSync(path.join(dir, name))) {
    name = safeName(base, "untitled") + " " + i + e;
    i++;
  }
  return name;
}

function typeOfExt(p) {
  const e = path.extname(String(p || "")).slice(1).toLowerCase();
  return EXT_TYPE[e] || "";
}
function extOf(p, type) {
  const e = path.extname(String(p || "")).slice(1).toLowerCase();
  if (e && EXT_TYPE[e] === type) return "." + e;
  return EXT_OF_TYPE[type] || ".bin";
}

/* 同名文件在 items/ 内的去重（导入整个文件夹时很常见） */
function uniqueItemFile(itemsDir, itemId, ext, taken) {
  let name = itemId + ext;
  let i = 2;
  while (
    fs.existsSync(path.join(itemsDir, name)) ||
    (taken && taken.has(name.toLowerCase()))
  ) {
    name = itemId + "_" + i + ext;
    i++;
  }
  if (taken) taken.add(name.toLowerCase());
  return name;
}

/* ---------------- 回收站 / 版本 ---------------- */

function moveToTrash(root, abs, label) {
  if (!fs.existsSync(abs)) return "";
  const td = path.join(root, TRASH_DIR);
  fs.mkdirSync(td, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(td, uniqueName(td, stamp + "__" + safeName(label, "item"), ""));
  try {
    fs.renameSync(abs, dest);
  } catch {
    /* 极端情况（占用 / 跨卷）：退回复制 + 删除，保证语义仍是「进回收站」 */
    copyPath(abs, dest);
    rmrf(abs);
  }
  return dest;
}

function copyPath(src, dest) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const ent of fs.readdirSync(src, { withFileTypes: true }))
      copyPath(path.join(src, ent.name), path.join(dest, ent.name));
  } else fs.copyFileSync(src, dest);
}

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    try {
      fs.rmSync(p, { recursive: true });
    } catch {}
  }
}

/* 覆盖前留版本：<素材夹>/.versions/<itemId>__<时间戳><ext>，同一 itemId 只留最近 VERSION_KEEP 份 */
function stashVersion(assetDir, itemId, absFile) {
  if (!absFile || !fs.existsSync(absFile)) return "";
  const vd = path.join(assetDir, VERSIONS_DIR);
  fs.mkdirSync(vd, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(vd, safeName(itemId, "it") + "__" + stamp + path.extname(absFile));
  try {
    fs.renameSync(absFile, dest);
  } catch {
    try {
      fs.copyFileSync(absFile, dest);
    } catch {
      return "";
    }
  }
  try {
    const pre = safeName(itemId, "it") + "__";
    const olds = fs
      .readdirSync(vd)
      .filter((f) => f.startsWith(pre))
      .map((f) => ({ f, t: fs.statSync(path.join(vd, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const o of olds.slice(VERSION_KEEP)) {
      try {
        fs.unlinkSync(path.join(vd, o.f));
      } catch {}
    }
  } catch {}
  return dest;
}

function listVersions(assetDir, itemId) {
  const vd = path.join(assetDir, VERSIONS_DIR);
  let names = [];
  try {
    names = fs.readdirSync(vd);
  } catch {
    return [];
  }
  const id = String(itemId == null ? "" : itemId).trim();
  const pre = id ? safeName(id, "") + "__" : "";
  return names
    .filter((f) => (!pre || f.startsWith(pre)) && !f.startsWith("."))
    .map((f) => {
      let m = 0;
      try {
        m = fs.statSync(path.join(vd, f)).mtimeMs;
      } catch {}
      return { name: f, path: path.join(vd, f), mtimeMs: m };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/* ---------------- 素材读写 ---------------- */

function markerPath(assetDir) {
  return path.join(assetDir, MARKER);
}
function readMarker(abs) {
  const j = readJson(markerPath(abs), null);
  if (!j || typeof j !== "object" || !Array.isArray(j.items)) return null;
  return j;
}
function writeMarker(assetDir, meta) {
  meta.schema = SCHEMA;
  meta.updatedAt = Date.now();
  writeJson(markerPath(assetDir), meta);
  return meta;
}

function normItems(list) {
  const out = [];
  const seen = new Set();
  for (const e of Array.isArray(list) ? list : []) {
    if (!e || typeof e !== "object") continue;
    const id = String(e.id || "");
    if (!ITEM_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    const type = ITEM_TYPES[e.type] ? String(e.type) : "text";
    out.push({
      id: id,
      title: String(e.title == null ? "" : e.title).trim() || t("内容 ") + (out.length + 1),
      type: type,
      file: String(e.file || "").split("\\").join("/"),
      bytes: Number(e.bytes) || 0,
      createdAt: Number(e.createdAt) || 0,
      updatedAt: Number(e.updatedAt) || 0,
    });
  }
  return out;
}

/* 按 id 在库内定位素材夹（scan 的副产品；找不到返回 null） */
function findAssetDir(root, id) {
  if (!ASSET_ID_RE.test(String(id || ""))) return null;
  if (!fs.existsSync(root)) return null;
  let hit = null;
  walkDirs(root, "", (dir, rel) => {
    if (hit) return false;
    const m = readMarker(dir);
    if (m && String(m.id) === String(id)) {
      hit = { dir: dir, rel: rel, meta: m };
      return false;
    }
    return true;
  });
  return hit;
}

/* 逐层遍历库内目录（含任意深度的分类）：cb 返回 false 即整体停止。
   隐藏目录、.trash/.versions、items/ 一律不下探 —— 素材夹因此自然成为叶子。 */
function walkDirs(root, relPrefix, cb) {
  const abs = relPrefix ? relToAbs(root, relPrefix) : root;
  let ents = [];
  try {
    ents = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of ents) {
    if (!ent.isDirectory()) continue;
    const name = ent.name;
    if (name.startsWith(".") || SKIP_DIRS.has(name) || name === ITEMS_DIR) continue;
    const rel = (relPrefix ? relPrefix + "/" : "") + name;
    if (cb(path.join(abs, name), rel) === false) return;
    walkDirs(root, rel, cb);
  }
}

function itemSummary(root, assetDir, it) {
  const abs = it.file ? path.join(assetDir, it.file.split("/").join(path.sep)) : "";
  let exists = false;
  let bytes = Number(it.bytes) || 0;
  if (abs) {
    try {
      const st = fs.statSync(abs);
      exists = !!st.isFile();
      if (exists) bytes = st.size || 0;
    } catch {}
  }
  return {
    id: it.id,
    title: it.title,
    type: it.type,
    file: it.file,
    absPath: abs || "",
    bytes: bytes,
    missing: !exists,
    createdAt: it.createdAt || 0,
    updatedAt: it.updatedAt || 0,
  };
}

function assetSummary(root, dir, rel, meta) {
  const items = normItems(meta.items).map((it) => itemSummary(root, dir, it));
  return {
    id: String(meta.id || ""),
    rel: rel,
    folder: path.basename(dir),
    catRel: rel.indexOf("/") < 0 ? "" : rel.slice(0, rel.lastIndexOf("/")),
    displayName: String(meta.displayName || ""),
    desc: String(meta.desc || ""),
    itemCount: items.length,
    items: items,
    createdAt: Number(meta.createdAt) || 0,
    updatedAt: Number(meta.updatedAt) || 0,
  };
}

/* 一次遍历：分类树（嵌套）+ 素材摘要（平铺，带 catRel）。根目录不存在时返回空树。 */
function scanLibrary(root) {
  const categories = [];
  const assets = [];
  const build = (relPrefix) => {
    const abs = relPrefix ? relToAbs(root, relPrefix) : root;
    let ents = [];
    try {
      ents = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return [];
    }
    const children = [];
    for (const ent of ents) {
      if (!ent.isDirectory()) continue;
      const name = ent.name;
      if (name.startsWith(".") || SKIP_DIRS.has(name) || name === ITEMS_DIR) continue;
      const dir = path.join(abs, name);
      const rel = (relPrefix ? relPrefix + "/" : "") + name;
      const meta = readMarker(dir);
      if (meta) {
        /* 素材：它自己的子目录不是分类，不再下探 */
        const a = assetSummary(root, dir, rel, meta);
        assets.push(a);
        children.push({ kind: "asset", id: a.id, rel: rel, name: a.displayName || name, asset: a, children: [] });
        continue;
      }
      categories.push({ rel: rel, name: name, assetCount: 0 });
      const node = { kind: "cat", rel: rel, name: name, children: build(rel) };
      children.push(node);
    }
    return children;
  };
  const tree = fs.existsSync(root) ? build("") : [];
  for (const c of categories) {
    c.assetCount = assets.filter(
      (a) => a.catRel === c.rel || a.catRel.startsWith(c.rel + "/"),
    ).length;
  }
  assets.sort(
    (a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0),
  );
  return { tree: tree, categories: categories, assets: assets };
}

/* 新建素材夹 + 标记文件（folder 名与 displayName 同源，重名自动加后缀） */
function createAssetDir(root, catRel, displayName, desc) {
  const parent = relToAbs(root, catRel || "");
  fs.mkdirSync(parent, { recursive: true });
  const name = safeName(displayName, "asset");
  const dir = path.join(parent, uniqueName(parent, name, ""));
  fs.mkdirSync(path.join(dir, ITEMS_DIR), { recursive: true });
  const now = Date.now();
  const meta = {
    schema: SCHEMA,
    id: genId("as"),
    displayName: name,
    desc: String(desc || ""),
    items: [],
    createdAt: now,
    updatedAt: now,
  };
  writeMarker(dir, meta);
  return { dir: dir, rel: toRel(dir, root), meta: meta };
}

/* 往素材里塞一个内容条目：text 走 content，媒体走 srcPath 或 base64（一律复制入库） */
function addItemEntry(root, found, arg) {
  const meta = found.meta;
  const itemsDir = path.join(found.dir, ITEMS_DIR);
  fs.mkdirSync(itemsDir, { recursive: true });
  const items = normItems(meta.items);
  const id = genId("it");
  let type = String(arg && arg.type || "");
  if (!ITEM_TYPES[type]) type = "";
  const srcPath = String((arg && arg.srcPath) || "").trim();
  if (!type) type = srcPath ? typeOfExt(srcPath) || "text" : "text";
  const title =
    String((arg && arg.title || "")).trim() ||
    (srcPath ? path.basename(srcPath, path.extname(srcPath)) : t("内容"));
  const taken = new Set(items.map((i) => String(i.file).toLowerCase()));
  let file = "";
  let bytes = 0;
  if (type === "text") {
    const abs = path.join(itemsDir, uniqueItemFile(itemsDir, id, ".txt", taken));
    const text =
      arg && typeof arg.content === "string"
        ? arg.content
        : srcPath
          ? String(fs.readFileSync(srcPath, "utf8") || "")
          : "";
    fs.writeFileSync(abs, text, "utf8");
    file = ITEMS_DIR + "/" + path.basename(abs);
    bytes = Buffer.byteLength(text, "utf8");
  } else {
    const ext = srcPath ? extOf(srcPath, type) : EXT_OF_TYPE[type];
    const abs = path.join(itemsDir, uniqueItemFile(itemsDir, id, ext, taken));
    if (srcPath) {
      if (!fs.existsSync(srcPath) || !fs.statSync(srcPath).isFile())
        throw new Error(t("源文件不存在"));
      fs.copyFileSync(srcPath, abs);
    } else if (arg && arg.base64) {
      fs.writeFileSync(abs, Buffer.from(String(arg.base64), "base64"));
    } else {
      fs.writeFileSync(abs, "");
    }
    file = ITEMS_DIR + "/" + path.basename(abs);
    bytes = fs.statSync(abs).size || 0;
  }
  const now = Date.now();
  const item = {
    id: id,
    title: title,
    type: type,
    file: file,
    bytes: bytes,
    createdAt: now,
    updatedAt: now,
  };
  items.push(item);
  meta.items = items;
  writeMarker(found.dir, meta);
  return item;
}

/* ---------------- IPC ---------------- */

function registerAssetsIpc(opts) {
  opts = opts || {};
  if (typeof opts.getDataDir === "function") getDataDir = opts.getDataDir;
  if (typeof opts.t === "function") t = opts.t;

  /* 根目录：首次使用需用户指定；未指定时 configured=false（渲染层据此走引导框） */
  ipcMain.handle("assets:getRoot", () => {
    try {
      const { root, configured } = rootPath();
      return {
        ok: true,
        path: root,
        defaultPath: defaultRoot(),
        configured: configured,
        exists: fs.existsSync(root),
      };
    } catch (err) {
      return fail(err);
    }
  });

  /* 改根目录 → 内容重新扫描（失联节点需手动重绑，二次确认在渲染层） */
  ipcMain.handle("assets:setRoot", (e, arg) => {
    try {
      const p = typeof arg === "string" ? arg : String((arg && arg.path) || "").trim();
      if (!p) return badArg(t("请选择素材库根目录"));
      if (!path.isAbsolute(p)) return badArg(t("素材库根目录必须是绝对路径"));
      const abs = path.resolve(p);
      if (fs.existsSync(abs) && !fs.statSync(abs).isDirectory())
        return badArg(t("该路径不是文件夹"));
      fs.mkdirSync(abs, { recursive: true });
      const cfg = readJson(configPath(), {}) || {};
      const prev = typeof cfg.assetRoot === "string" ? cfg.assetRoot : "";
      writeJson(configPath(), Object.assign({}, cfg, { assetRoot: abs }));
      const changed = !!prev && path.resolve(prev) !== abs;
      const s = scanLibrary(abs);
      return { ok: true, path: abs, previous: prev || "", changed: changed, scan: s };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle("assets:scan", () => {
    try {
      const { root, configured } = rootPath();
      if (!configured) return { ok: false, needRoot: true, error: t("尚未指定素材库根目录") };
      return { ok: true, root: root, configured: true, scan: scanLibrary(root) };
    } catch (err) {
      return fail(err);
    }
  });

  /* 新建分类文件夹（可嵌套） */
  ipcMain.handle("assets:mkdir", (e, arg) => {
    try {
      const root = ensureRoot();
      const parent = relToAbs(root, (arg && arg.parentRel) || "");
      const name = safeName(arg && arg.name, "");
      if (!name || name === "untitled") return badArg(t("文件夹名称不能为空"));
      fs.mkdirSync(parent, { recursive: true });
      const dir = path.join(parent, uniqueName(parent, name, ""));
      fs.mkdirSync(dir, { recursive: true });
      return { ok: true, rel: toRel(dir, root), name: path.basename(dir) };
    } catch (err) {
      return fail(err);
    }
  });

  /* 重命名分类 / 素材夹；带 toCatRel 时即「移动到分类」（同一次 rename，端子不受影响） */
  ipcMain.handle("assets:rename", (e, arg) => {
    try {
      const root = ensureRoot();
      const rel = String((arg && arg.rel) || "");
      const abs = relToAbs(root, rel);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory())
        return { ok: false, error: t("目录不存在") };
      const base = safeName(arg && arg.name, "");
      if (!base) return badArg(t("名称不能为空"));
      const parentAbs = relToAbs(root, (arg && arg.toCatRel) || (rel.indexOf("/") < 0 ? "" : rel.slice(0, rel.lastIndexOf("/"))));
      fs.mkdirSync(parentAbs, { recursive: true });
      const dest = path.join(parentAbs, uniqueName(parentAbs, base, ""));
      if (path.resolve(dest) === path.resolve(abs)) return { ok: true, rel: rel, name: base };
      fs.renameSync(abs, dest);
      const newRel = toRel(dest, root);
      /* 素材夹改名不改元数据里的 id；分类改名后按 id 定位仍然成立（scan 以 id 为准） */
      return { ok: true, rel: newRel, name: path.basename(dest), oldRel: rel };
    } catch (err) {
      return fail(err);
    }
  });

  /* 删除分类 / 素材：一律搬进 <root>/.trash，绝不实删 */
  ipcMain.handle("assets:remove", (e, arg) => {
    try {
      const root = rootPath().root;
      const rel = String((arg && arg.rel) || "");
      if (!rel) return badArg(t("缺少路径"));
      const abs = relToAbs(root, rel);
      if (!fs.existsSync(abs)) return { ok: false, error: t("目录不存在") };
      const dest = moveToTrash(root, abs, path.basename(abs));
      return { ok: true, trash: dest };
    } catch (err) {
      return fail(err);
    }
  });

  /* 素材：新建 / 改元数据 / 删除 */
  ipcMain.handle("assets:create", (e, arg) => {
    try {
      const root = ensureRoot();
      const a = createAssetDir(
        root,
        (arg && arg.catRel) || "",
        (arg && arg.displayName) || (arg && arg.name) || "",
        (arg && arg.desc) || "",
      );
      return { ok: true, asset: assetSummary(root, a.dir, a.rel, a.meta) };
    } catch (err) {
      return fail(err);
    }
  });

  /* 改显示名 / 描述；带 items:[{id,title}] 时只同步标题（端子名即条目标题） */
  ipcMain.handle("assets:saveMeta", (e, arg) => {
    try {
      const root = rootPath().root;
      const id = String((arg && arg.id) || "");
      const found = findAssetDir(root, id);
      if (!found) return { ok: false, error: t("素材不存在") };
      const meta = found.meta;
      if (typeof arg.displayName === "string") {
        const dn = safeName(arg.displayName, "");
        if (dn) meta.displayName = dn;
      }
      if (typeof arg.desc === "string") meta.desc = arg.desc;
      if (Array.isArray(arg.items)) {
        const items = normItems(meta.items);
        const titles = new Map();
        for (const e2 of arg.items) {
          if (e2 && ITEM_ID_RE.test(String(e2.id || "")))
            titles.set(String(e2.id), String(e2.title == null ? "" : e2.title).trim());
        }
        for (const it of items) {
          if (titles.has(it.id))
            it.title = titles.get(it.id) || it.title || t("内容");
        }
        meta.items = items;
      }
      writeMarker(found.dir, meta);
      return { ok: true, asset: assetSummary(root, found.dir, found.rel, meta) };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle("assets:delete", (e, arg) => {
    try {
      const root = rootPath().root;
      const id = String((typeof arg === "string" ? arg : (arg && arg.id)) || "");
      const found = findAssetDir(root, id);
      if (!found) return { ok: false, error: t("素材不存在") };
      const dest = moveToTrash(root, found.dir, found.meta.displayName || path.basename(found.dir));
      return { ok: true, trash: dest, rel: found.rel };
    } catch (err) {
      return fail(err);
    }
  });

  /* 内容条目：新增 / 读 / 覆盖（文本、字节）/ 删除 */
  ipcMain.handle("assets:itemAdd", (e, arg) => {
    try {
      const root = ensureRoot();
      const found = findAssetDir(root, String((arg && arg.id) || ""));
      if (!found) return { ok: false, error: t("素材不存在") };
      const item = addItemEntry(root, found, arg || {});
      return { ok: true, item: item, asset: assetSummary(root, found.dir, found.rel, found.meta) };
    } catch (err) {
      return fail(err);
    }
  });

  /* 读条目：文本回 text，媒体回 absPath（渲染层用现成 asset:readDataUrl 取缩略图）；
     带 version=<.versions 内文件名> 时读历史版本（撤销回滚用） */
  ipcMain.handle("assets:itemRead", (e, arg) => {
    try {
      const root = rootPath().root;
      const found = findAssetDir(root, String((arg && arg.id) || ""));
      if (!found) return { ok: false, error: t("素材不存在") };
      const itemId = String((arg && arg.itemId) || "");
      const version = String((arg && arg.version) || "");
      if (version) {
        const hit = listVersions(found.dir, itemId).find((v) => v.name === version);
        if (!hit) return { ok: false, error: t("历史版本不存在") };
        const isText = EXT_TYPE[path.extname(hit.name).slice(1).toLowerCase()] === "text";
        return {
          ok: true,
          version: hit.name,
          kind: isText ? "text" : "file",
          text: isText ? String(fs.readFileSync(hit.path, "utf8")) : "",
          absPath: hit.path,
        };
      }
      const it = normItems(found.meta.items).find((i) => i.id === itemId);
      if (!it) return { ok: false, error: t("内容条目不存在") };
      const abs = it.file ? path.join(found.dir, it.file.split("/").join(path.sep)) : "";
      if (!abs || !fs.existsSync(abs)) return { ok: false, error: t("内容文件缺失") };
      return {
        ok: true,
        kind: it.type === "text" ? "text" : "file",
        type: it.type,
        title: it.title,
        text: it.type === "text" ? String(fs.readFileSync(abs, "utf8")) : "",
        absPath: abs,
        bytes: fs.statSync(abs).size || 0,
        versions: listVersions(found.dir, itemId).map((v) => v.name),
      };
    } catch (err) {
      return fail(err);
    }
  });

  /* 覆盖写：旧文件先进 .versions/（撤销要能真回滚库文件） */
  function replaceItemFile(arg, writeFn) {
    const root = ensureRoot();
    const found = findAssetDir(root, String((arg && arg.id) || ""));
    if (!found) return { ok: false, error: t("素材不存在") };
    const items = normItems(found.meta.items);
    const itemId = String((arg && arg.itemId) || "");
    const it = items.find((i) => i.id === itemId);
    if (!it) return { ok: false, error: t("内容条目不存在") };
    const itemsDir = path.join(found.dir, ITEMS_DIR);
    fs.mkdirSync(itemsDir, { recursive: true });
    /* 条目没有落过盘（历史脏数据）时不能把 items/ 本身当旧文件搬进 .versions/ */
    const oldName = String(it.file || "").split("/").pop();
    const prevAbs = oldName ? path.join(itemsDir, oldName) : "";
    const hadFile = !!prevAbs && fs.existsSync(prevAbs) && fs.statSync(prevAbs).isFile();
    const prevVersion = hadFile ? stashVersion(found.dir, itemId, prevAbs) : "";
    const nextAbs = writeFn(itemsDir, it, hadFile ? prevAbs : "", prevAbs || "");
    if (!nextAbs || !fs.existsSync(nextAbs)) throw new Error(t("写入失败"));
    it.file = ITEMS_DIR + "/" + path.basename(nextAbs);
    it.bytes = fs.statSync(nextAbs).size || 0;
    it.updatedAt = Date.now();
    if (typeof (arg && arg.title) === "string" && String(arg.title).trim())
      it.title = String(arg.title).trim();
    found.meta.items = items;
    writeMarker(found.dir, found.meta);
    return {
      ok: true,
      item: it,
      prevVersion: prevVersion,
      asset: assetSummary(root, found.dir, found.rel, found.meta),
    };
  }

  ipcMain.handle("assets:itemUpdateText", (e, arg) => {
    try {
      return replaceItemFile(arg, (itemsDir, it, prevAbs, wantAbs) => {
        const text = arg && typeof arg.content === "string" ? arg.content : "";
        const abs = prevAbs || path.join(itemsDir, uniqueItemFile(itemsDir, it.id, ".txt", null));
        fs.writeFileSync(abs, text, "utf8");
        return abs;
      });
    } catch (err) {
      return fail(err);
    }
  });

  /* 媒体覆盖：srcPath（本机文件，复制入库）优先，其次 base64；
     扩展名跟随新内容，旧文件已进 .versions/ 不丢 */
  ipcMain.handle("assets:itemUpdateBytes", (e, arg) => {
    try {
      return replaceItemFile(arg, (itemsDir, it, prevAbs, wantAbs) => {
        const srcPath = String((arg && arg.srcPath) || "").trim();
        const ext = srcPath
          ? extOf(srcPath, it.type)
          : path.extname(wantAbs) || EXT_OF_TYPE[it.type] || ".bin";
        const nextAbs = path.join(itemsDir, uniqueItemFile(itemsDir, it.id, ext, null));
        if (srcPath) {
          if (!fs.existsSync(srcPath) || !fs.statSync(srcPath).isFile())
            throw new Error(t("源文件不存在"));
          fs.copyFileSync(srcPath, nextAbs);
        } else if (arg && arg.base64) {
          fs.writeFileSync(nextAbs, Buffer.from(String(arg.base64), "base64"));
        } else throw new Error(t("没有内容可写入"));
        if (prevAbs && path.resolve(nextAbs) !== path.resolve(prevAbs)) {
          try {
            fs.unlinkSync(prevAbs);
          } catch {}
        }
        return nextAbs;
      });
    } catch (err) {
      return fail(err);
    }
  });

  /* 删除条目：实体文件进 .trash（端子序号收缩与断线由渲染层负责） */
  ipcMain.handle("assets:itemRemove", (e, arg) => {
    try {
      const root = rootPath().root;
      const found = findAssetDir(root, String((arg && arg.id) || ""));
      if (!found) return { ok: false, error: t("素材不存在") };
      const items = normItems(found.meta.items);
      const itemId = String((arg && arg.itemId) || "");
      const i = items.findIndex((x) => x.id === itemId);
      if (i < 0) return { ok: false, error: t("内容条目不存在") };
      const it = items[i];
      const abs = it.file ? path.join(found.dir, it.file.split("/").join(path.sep)) : "";
      let trash = "";
      if (abs && fs.existsSync(abs)) trash = moveToTrash(root, abs, path.basename(abs));
      items.splice(i, 1);
      found.meta.items = items;
      writeMarker(found.dir, found.meta);
      return { ok: true, removed: it, trash: trash, asset: assetSummary(root, found.dir, found.rel, found.meta) };
    } catch (err) {
      return fail(err);
    }
  });

  /* 导入：本机文件夹 → 当前分类下的新素材（Q6①「上传为新素材」） */
  ipcMain.handle("assets:importDir", (e, arg) => {
    try {
      const root = ensureRoot();
      const src = path.resolve(String((arg && arg.srcPath) || "").trim());
      if (!src || !fs.existsSync(src) || !fs.statSync(src).isDirectory())
        return badArg(t("请选择一个存在的文件夹"));
      const name = safeName(
        (arg && arg.displayName) || path.basename(src),
        "asset",
      );
      const a = createAssetDir(root, (arg && arg.catRel) || "", name, (arg && arg.desc) || "");
      const picked = [];
      collectFiles(src, "", 4000, picked);
      let skipped = 0;
      for (const f of picked) {
        const type = typeOfExt(f.abs);
        if (!type) {
          skipped++;
          continue;
        }
        try {
          addItemEntry(root, a, {
            type: type,
            title: f.rel.indexOf("/") < 0 ? path.basename(f.abs, path.extname(f.abs)) : f.rel,
            srcPath: f.abs,
          });
        } catch {
          skipped++;
        }
      }
      const meta = readMarker(a.dir) || a.meta;
      return {
        ok: true,
        asset: assetSummary(root, a.dir, a.rel, meta),
        found: picked.length,
        skipped: skipped,
      };
    } catch (err) {
      return fail(err);
    }
  });

  /* 导入：本机文件 → 追加为既有素材的内容条目（Q6②「添加内容」） */
  ipcMain.handle("assets:importFiles", (e, arg) => {
    try {
      const root = ensureRoot();
      const found = findAssetDir(root, String((arg && arg.id) || ""));
      if (!found) return { ok: false, error: t("素材不存在") };
      const paths = Array.isArray(arg && arg.paths)
        ? arg.paths
        : [String((arg && arg.path) || "")];
      const added = [];
      const skipped = [];
      for (const p of paths) {
        const abs = path.resolve(String(p || "").trim());
        const type = typeOfExt(abs);
        if (!abs || !type || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
          skipped.push(String(p || ""));
          continue;
        }
        try {
          added.push(
            addItemEntry(root, found, { type: type, srcPath: abs }),
          );
        } catch (err) {
          skipped.push(String(p || "") + "（" + ((err && err.message) || err) + "）");
        }
      }
      return {
        ok: true,
        items: added,
        skipped: skipped,
        asset: assetSummary(root, found.dir, found.rel, found.meta),
      };
    } catch (err) {
      return fail(err);
    }
  });
}

/* 递归收集本机文件夹里的文件（深度有限、数量有上限，防误选大目录卡死） */
function collectFiles(dir, relPrefix, limit, out) {
  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of ents) {
    if (out.length >= limit) return;
    const abs = path.join(dir, ent.name);
    const rel = (relPrefix ? relPrefix + "/" : "") + ent.name;
    if (ent.isDirectory()) {
      if (ent.name.startsWith(".") || SKIP_DIRS.has(ent.name)) continue;
      collectFiles(abs, rel, limit, out);
    } else if (ent.isFile()) {
      if (ent.name.startsWith(".") || ent.name === MARKER) continue;
      out.push({ abs: abs, rel: rel });
    }
  }
}

module.exports = { registerAssetsIpc };
