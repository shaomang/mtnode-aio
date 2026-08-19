"use strict";
/**
 * 应用插件目录（右上角「插件」）：
 * 从云端 catalog.json 拉取列表；window 类型可下载 zip 安装，不必升级主程序。
 * 桌宠（pet）仍由主程序实现；讨论区等窗口插件的 UI 从 zip 加载，宿主 IPC 在主程序。
 */
const { BrowserWindow, ipcMain, screen, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const zlib = require("zlib");

const PLUGIN_FEED =
  process.env.MTNODE_PLUGIN_URL || "http://mt-agent.com/mtnode/plugins";
const KNOWN_KINDS = new Set(["builtin", "pet", "window", "music3", "h3"]);
const ID_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;
const MAX_CATALOG = 512 * 1024;
const MAX_ZIP = 80 * 1024 * 1024;

let getDataDir = null;
let getMainWin = null;
let getAppVersion = null;
let appRoot = "";
const pluginWins = new Map();
const wcToPluginId = new WeakMap();
const installing = Object.create(null);

function join(...a) {
  return path.join(...a);
}
function mk(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}
function pluginsRoot() {
  return mk(join(getDataDir(), "app-plugins"));
}
function cacheCatalogPath() {
  return join(pluginsRoot(), "catalog.json");
}
function pluginDir(id) {
  return join(pluginsRoot(), String(id));
}
function runtimeDir(id) {
  return join(pluginDir(id), "runtime");
}
function installedMetaPath(id) {
  return join(pluginDir(id), "installed.json");
}
function dataPath(id) {
  return join(pluginDir(id), "data.json");
}
function defaultCatalogPath() {
  return join(__dirname, "catalog.default.json");
}

function readJson(p, fb) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fb;
  }
}
function writeJson(p, v) {
  mk(path.dirname(p));
  const tmp = p + ".tmp" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2), "utf8");
  fs.renameSync(tmp, p);
}
function rmDirRecursive(dir) {
  if (!fs.existsSync(dir)) return;
  fs.rmSync(dir, { recursive: true, force: true });
}
function copyDirRecursive(src, dest) {
  mk(dest);
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = join(src, ent.name);
    const d = join(dest, ent.name);
    if (ent.isDirectory()) copyDirRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}
function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function fetchBuffer(url, onProgress, maxBytes) {
  const cap = maxBytes || MAX_ZIP;
  return new Promise((resolve, reject) => {
    const lib = String(url).startsWith("https") ? https : http;
    const req = lib.get(
      url,
      {
        headers: { "User-Agent": "MTNodeAIO/1.1-plugins" },
        timeout: 120000,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          fetchBuffer(res.headers.location, onProgress, cap).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error("HTTP " + res.statusCode));
          return;
        }
        const total = Number(res.headers["content-length"]) || 0;
        if (total > cap) {
          res.resume();
          reject(new Error("too_large"));
          return;
        }
        const chunks = [];
        let got = 0;
        res.on("data", (c) => {
          got += c.length;
          if (got > cap) {
            req.destroy();
            reject(new Error("too_large"));
            return;
          }
          chunks.push(c);
          if (onProgress) onProgress({ got, total });
        });
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

function unzipBuffer(buf, destDir) {
  mk(destDir);
  let o = 0;
  while (o + 4 <= buf.length) {
    const sig = buf.readUInt32LE(o);
    if (sig !== 0x04034b50) break;
    const method = buf.readUInt16LE(o + 8);
    const compSize = buf.readUInt32LE(o + 18);
    const nameLen = buf.readUInt16LE(o + 26);
    const extraLen = buf.readUInt16LE(o + 28);
    const name = buf.slice(o + 30, o + 30 + nameLen).toString("utf8");
    const dataStart = o + 30 + nameLen + extraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > buf.length) throw new Error("zip truncated");
    o = dataEnd;
    if (!name || name.endsWith("/")) continue;
    const norm = name.replace(/\\/g, "/").replace(/^\/+/, "");
    if (norm.includes("..")) continue;
    const outPath = join(destDir, ...norm.split("/"));
    mk(path.dirname(outPath));
    const compressed = buf.slice(dataStart, dataEnd);
    let raw;
    if (method === 0) raw = compressed;
    else if (method === 8) raw = zlib.inflateRawSync(compressed);
    else throw new Error("unsupported zip method " + method);
    fs.writeFileSync(outPath, raw);
  }
}

function safeIconName(v) {
  const s = String(v || "").replace(/\\/g, "/").split("/").pop() || "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(png|jpe?g|webp)$/i.test(s)) return "";
  return s;
}
function iconMime(name) {
  const n = String(name || "").toLowerCase();
  if (n.endsWith(".webp")) return "image/webp";
  if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
  return "image/png";
}
function iconSearchDirs() {
  const dirs = [join(__dirname, "icons"), join(__dirname, "..", "renderer", "plugin-icons")];
  if (appRoot) {
    dirs.push(join(appRoot, "renderer", "plugin-icons"));
    dirs.push(join(appRoot, "plugins", "icons"));
  }
  return dirs;
}
function pluginIconDataUrl(name) {
  const n = safeIconName(name);
  if (!n) return "";
  const seen = new Set();
  for (const dir of iconSearchDirs()) {
    const p = join(dir, n);
    if (seen.has(p)) continue;
    seen.add(p);
    try {
      if (!fs.existsSync(p)) continue;
      const buf = fs.readFileSync(p);
      if (!buf || !buf.length || buf.length > 2 * 1024 * 1024) continue;
      return "data:" + iconMime(n) + ";base64," + buf.toString("base64");
    } catch {}
  }
  return "";
}

function locObj(v) {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return {
      zh: String(v.zh || v.en || ""),
      en: String(v.en || v.zh || ""),
    };
  }
  const s = String(v || "");
  return { zh: s, en: s };
}

function verParts(s) {
  return String(s || "0")
    .split(/[^\d]+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((n) => parseInt(n, 10) || 0);
}
function verCmp(a, b) {
  const pa = verParts(a);
  const pb = verParts(b);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}
function verGte(a, b) {
  return verCmp(a, b) >= 0;
}
function verGt(a, b) {
  return verCmp(a, b) > 0;
}

function appVer() {
  try {
    return String((getAppVersion && getAppVersion()) || "0.0.0");
  } catch {
    return "0.0.0";
  }
}

function normalizePlugin(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim();
  if (!ID_OK.test(id)) return null;
  if (raw.enabled === false || raw.hidden === true) return null;
  let kind = String(raw.kind || "").trim().toLowerCase();
  if (id === "forum" && (kind === "builtin" || (!kind && raw.handler === "forum"))) kind = "window";
  if (!kind && raw.handler === "pet") kind = "pet";
  if (!kind && raw.handler === "music3") kind = "music3";
  if (!kind && raw.handler === "h3") kind = "h3";
  const iconName = safeIconName(raw.icon) || (id + ".png");
  const known = KNOWN_KINDS.has(kind);
  const win = (raw.window && typeof raw.window === "object") ? raw.window : {};
  const minApp = String(raw.minAppVersion || "").trim();
  const compatible = !minApp || verGte(appVer(), minApp);
  return {
    id,
    kind: known ? kind : "unknown",
    handler: String(raw.handler || (kind === "pet" ? "pet" : kind === "music3" ? "music3" : kind === "h3" ? "h3" : kind === "builtin" ? id : "")).trim(),
    order: Number(raw.order) || 100,
    title: locObj(raw.title || raw.name || id),
    subtitle: locObj(raw.subtitle || raw.description || ""),
    icon: iconName,
    iconDataUrl: pluginIconDataUrl(iconName),
    version: String(raw.version || ""),
    minAppVersion: minApp,
    compatible,
    zipUrl: String(raw.zipUrl || ""),
    sha256: String(raw.sha256 || ""),
    entry: String(raw.entry || "index.html").replace(/\\/g, "/"),
    window: {
      width: Math.max(280, Math.min(1200, Number(win.width) || 380)),
      height: Math.max(320, Math.min(1200, Number(win.height) || 520)),
      frame: win.frame === true,
      transparent: win.transparent !== false,
      alwaysOnTop: win.alwaysOnTop !== false,
      skipTaskbar: win.skipTaskbar !== false,
    },
  };
}

function parseCatalogDoc(doc) {
  const plugins = [];
  const list = doc && Array.isArray(doc.plugins) ? doc.plugins : [];
  for (const raw of list) {
    const p = normalizePlugin(raw);
    if (p) plugins.push(p);
  }
  plugins.sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id));
  return {
    version: Number(doc && doc.version) || 1,
    updatedAt: String((doc && doc.updatedAt) || ""),
    plugins,
  };
}

function loadDefaultCatalog() {
  return parseCatalogDoc(readJson(defaultCatalogPath(), { plugins: [] }));
}

function listInstalledWindowIds() {
  const out = [];
  try {
    for (const ent of fs.readdirSync(pluginsRoot(), { withFileTypes: true })) {
      if (!ent.isDirectory() || !ID_OK.test(ent.name)) continue;
      if (isWindowInstalled(ent.name)) out.push(ent.name);
    }
  } catch {}
  return out;
}

function isWindowInstalled(id) {
  const meta = readJson(installedMetaPath(id), null);
  if (!meta || !meta.version) return false;
  const entry = String(meta.entry || "index.html");
  return fs.existsSync(join(runtimeDir(id), ...entry.split("/").filter(Boolean)));
}

function installedInfo(id) {
  const meta = readJson(installedMetaPath(id), null) || {};
  return {
    installed: isWindowInstalled(id),
    version: String(meta.version || ""),
    installedAt: Number(meta.installedAt) || 0,
  };
}

function attachInstalled(plugins) {
  const seen = new Set();
  const out = [];
  for (const p of plugins) {
    seen.add(p.id);
    if (p.kind === "window") {
      const st = installedInfo(p.id);
      out.push(Object.assign({}, p, {
        installed: st.installed,
        installedVersion: st.version,
        updateAvailable: !!(st.installed && p.version && verGt(p.version, st.version)),
      }));
    } else if (p.kind === "music3" || p.handler === "music3" || p.kind === "h3" || p.handler === "h3") {
      out.push(Object.assign({}, p, {
        installed: true,
        installedVersion: p.version || "",
        updateAvailable: false,
      }));
    } else {
      out.push(Object.assign({}, p, { installed: p.kind === "builtin", installedVersion: "", updateAvailable: false }));
    }
  }
  for (const id of listInstalledWindowIds()) {
    if (seen.has(id)) continue;
    const st = installedInfo(id);
    out.push({
      id,
      kind: "window",
      handler: "",
      order: 900,
      title: locObj(id),
      subtitle: locObj(""),
      icon: id + ".png",
      iconDataUrl: pluginIconDataUrl(id + ".png"),
      version: st.version,
      minAppVersion: "",
      compatible: true,
      zipUrl: "",
      sha256: "",
      entry: "index.html",
      window: { width: 380, height: 520, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true },
      installed: true,
      installedVersion: st.version,
      updateAvailable: false,
      retired: true,
    });
  }
  return out;
}

function sendProgress(data) {
  try {
    const w = getMainWin && getMainWin();
    if (w && !w.isDestroyed()) w.webContents.send("appPlugins:progress", data);
  } catch {}
}

function catalogUrl() {
  return PLUGIN_FEED.replace(/\/$/, "") + "/catalog.json";
}

function resolveZipUrl(zipUrl) {
  let u = String(zipUrl || "").trim();
  if (!u) return "";
  if (u.startsWith("/")) return PLUGIN_FEED.replace(/\/$/, "") + u;
  if (!/^https?:\/\//i.test(u)) {
    return PLUGIN_FEED.replace(/\/$/, "") + "/" + u.replace(/^\.\//, "");
  }
  try {
    const feed = new URL(PLUGIN_FEED);
    const zip = new URL(u);
    if (zip.protocol !== "http:" && zip.protocol !== "https:") return "";
    if (zip.hostname.toLowerCase() !== feed.hostname.toLowerCase()) return "";
    return zip.toString();
  } catch {
    return "";
  }
}

function safeEntry(entry) {
  const e = String(entry || "index.html").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!e || e.includes("..") || e.includes(":")) return "";
  if (!/\.html?$/i.test(e)) return "";
  return e;
}

async function fetchRemoteCatalog() {
  const buf = await fetchBuffer(catalogUrl(), null, MAX_CATALOG);
  const doc = JSON.parse(buf.toString("utf8"));
  const parsed = parseCatalogDoc(doc);
  if (!parsed.plugins.length && !(doc && Array.isArray(doc.plugins))) {
    throw new Error("bad_catalog");
  }
  writeJson(cacheCatalogPath(), {
    fetchedAt: Date.now(),
    sourceUrl: catalogUrl(),
    doc,
  });
  return parsed;
}

async function loadCatalog() {
  const fallback = loadDefaultCatalog();
  function mergeLocalOnly(plugins) {
    const list = Array.isArray(plugins) ? plugins.slice() : [];
    const have = new Set(list.map((p) => p && p.id).filter(Boolean));
    for (const p of fallback.plugins || []) {
      if (!p || !p.id || have.has(p.id)) continue;
      // Keep built-in handlers (pet/music3) visible even if remote catalog omits them
      if (p.kind === "music3" || p.handler === "music3" || p.kind === "h3" || p.handler === "h3" || p.kind === "pet" || p.handler === "pet") {
        list.push(p);
        have.add(p.id);
      }
    }
    return list;
  }
  try {
    const remote = await fetchRemoteCatalog();
    return {
      ok: true,
      source: "remote",
      fetchedAt: Date.now(),
      plugins: attachInstalled(mergeLocalOnly(remote.plugins)),
      appVersion: appVer(),
    };
  } catch (remoteErr) {
    const cached = readJson(cacheCatalogPath(), null);
    if (cached && cached.doc) {
      const parsed = parseCatalogDoc(cached.doc);
      return {
        ok: true,
        source: "cache",
        fetchedAt: Number(cached.fetchedAt) || 0,
        plugins: attachInstalled(mergeLocalOnly(parsed.plugins)),
        appVersion: appVer(),
        remoteError: String((remoteErr && remoteErr.message) || remoteErr),
      };
    }
    return {
      ok: true,
      source: "fallback",
      fetchedAt: 0,
      plugins: attachInstalled(fallback.plugins),
      appVersion: appVer(),
      remoteError: String((remoteErr && remoteErr.message) || remoteErr),
    };
  }
}

function findCatalogPlugin(id) {
  const cached = readJson(cacheCatalogPath(), null);
  const docs = [];
  if (cached && cached.doc) docs.push(cached.doc);
  docs.push(readJson(defaultCatalogPath(), { plugins: [] }));
  for (const doc of docs) {
    const parsed = parseCatalogDoc(doc);
    const hit = parsed.plugins.find((p) => p.id === id);
    if (hit) return hit;
  }
  return null;
}

async function installWindowPlugin(id) {
  if (!ID_OK.test(id)) return { ok: false, error: "bad_id" };
  if (installing[id]) return { ok: false, error: "busy" };
  installing[id] = true;
  sendProgress({ id, phase: "start", percent: 0 });
  try {
    let spec = findCatalogPlugin(id);
    if (!spec || spec.kind !== "window") {
      const cat = await loadCatalog();
      spec = (cat.plugins || []).find((p) => p.id === id);
    }
    if (spec && spec.kind === "window" && !spec.zipUrl) {
      const def = (loadDefaultCatalog().plugins || []).find((p) => p.id === id);
      if (def && def.zipUrl) {
        spec = Object.assign({}, spec, {
          zipUrl: def.zipUrl,
          version: spec.version || def.version,
          entry: spec.entry || def.entry,
          sha256: spec.sha256 || def.sha256,
          window: spec.window || def.window,
        });
      }
    }
    if (!spec || spec.kind !== "window") throw new Error("not_window_plugin");
    if (!spec.compatible) throw new Error("need_app_update");
    const zipUrl = resolveZipUrl(spec.zipUrl);
    if (!zipUrl) throw new Error("bad_zip_url");
    sendProgress({ id, phase: "download", percent: 5, version: spec.version });
    const zipBuf = await fetchBuffer(zipUrl, ({ got, total }) => {
      const pct = total ? Math.min(90, 5 + Math.floor((got / total) * 85)) : 40;
      sendProgress({ id, phase: "download", percent: pct, got, total, version: spec.version });
    });
    if (spec.sha256) {
      const h = sha256(zipBuf);
      if (h.toLowerCase() !== String(spec.sha256).toLowerCase()) throw new Error("sha256_mismatch");
    }
    sendProgress({ id, phase: "extract", percent: 92 });
    const tmp = join(pluginDir(id), "_extract_tmp");
    rmDirRecursive(tmp);
    mk(tmp);
    unzipBuffer(zipBuf, tmp);
    let srcDir = tmp;
    const ents = fs.readdirSync(tmp);
    const entry = safeEntry(spec.entry) || "index.html";
    if (ents.length === 1) {
      const only = join(tmp, ents[0]);
      if (fs.statSync(only).isDirectory() && fs.existsSync(join(only, ...entry.split("/")))) {
        srcDir = only;
      }
    }
    if (!fs.existsSync(join(srcDir, ...entry.split("/")))) throw new Error("pack_missing_entry");
    closePluginWindow(id);
    rmDirRecursive(runtimeDir(id));
    copyDirRecursive(srcDir, runtimeDir(id));
    rmDirRecursive(tmp);
    writeJson(installedMetaPath(id), {
      version: spec.version || "0.0.0",
      entry,
      source: zipUrl,
      installedAt: Date.now(),
    });
    sendProgress({ id, phase: "done", percent: 100, version: spec.version });
    installing[id] = false;
    return { ok: true, version: spec.version || "0.0.0" };
  } catch (err) {
    installing[id] = false;
    sendProgress({ id, phase: "error", percent: 0, error: String((err && err.message) || err) });
    return { ok: false, error: String((err && err.message) || err) };
  }
}

function uninstallWindowPlugin(id) {
  if (!ID_OK.test(id)) return { ok: false, error: "bad_id" };
  closePluginWindow(id);
  rmDirRecursive(pluginDir(id));
  return { ok: true };
}

function pluginRightBounds(w, h) {
  const d = screen.getPrimaryDisplay();
  const wa = d.workArea;
  return {
    width: w,
    height: h,
    x: Math.max(wa.x, wa.x + wa.width - w - 16),
    y: Math.max(wa.y, wa.y + Math.round((wa.height - h) / 2)),
  };
}

function closePluginWindow(id) {
  const w = pluginWins.get(id);
  if (w && !w.isDestroyed()) {
    try { w.close(); } catch {}
  }
  pluginWins.delete(id);
}

function isPluginWindowOpen(id) {
  const w = pluginWins.get(id);
  return !!(w && !w.isDestroyed());
}

function notifyPluginWindowChanged(id, open) {
  try {
    const mw = getMainWin && getMainWin();
    if (mw && !mw.isDestroyed()) {
      mw.webContents.send("appPlugins:windowChanged", { id: String(id || ""), open: !!open });
    }
  } catch {}
}

function notifyPluginShown(id) {
  const w = pluginWins.get(id);
  if (!w || w.isDestroyed()) return;
  try {
    w.webContents.send("plugin:shown");
  } catch {}
}

function showPluginWindowSafe(id) {
  const w = pluginWins.get(id);
  if (!w || w.isDestroyed()) return;
  try {
    w.show();
    w.focus();
    w.moveTop();
  } catch {}
  notifyPluginShown(id);
}

function pluginIdOfSender(e) {
  return wcToPluginId.get(e.sender) || "";
}

function openWindowPlugin(id) {
  if (!getDataDir) return { ok: false, error: "not_ready" };
  if (!ID_OK.test(id)) return { ok: false, error: "bad_id" };
  const existing = pluginWins.get(id);
  if (existing && !existing.isDestroyed()) {
    showPluginWindowSafe(id);
    notifyPluginWindowChanged(id, true);
    return { ok: true, open: true };
  }
  const meta = readJson(installedMetaPath(id), null);
  if (!meta) return { ok: false, error: "not_installed" };
  const entry = safeEntry(meta.entry || "index.html");
  if (!entry) return { ok: false, error: "bad_entry" };
  const html = join(runtimeDir(id), ...entry.split("/"));
  if (!fs.existsSync(html)) return { ok: false, error: "missing_entry" };
  const spec = findCatalogPlugin(id);
  const winSpec = (spec && spec.window) || {
    width: 380,
    height: 520,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
  };
  const pos = pluginRightBounds(winSpec.width, winSpec.height);
  const w = new BrowserWindow({
    width: pos.width,
    height: pos.height,
    x: pos.x,
    y: pos.y,
    minWidth: 280,
    minHeight: 320,
    frame: !!winSpec.frame,
    transparent: !!winSpec.transparent,
    backgroundColor: winSpec.transparent ? "#00000000" : "#0d1016",
    hasShadow: true,
    alwaysOnTop: !!winSpec.alwaysOnTop,
    skipTaskbar: !!winSpec.skipTaskbar,
    resizable: true,
    show: false,
    title: (spec && spec.title && spec.title.zh) || id,
    webPreferences: {
      preload: join(__dirname, "preload-window.js"),
      additionalArguments: ["--mtnode-plugin-id=" + id],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  w.setMenu(null);
  if (winSpec.alwaysOnTop) {
    try { w.setAlwaysOnTop(true, "screen-saver"); } catch {}
  }
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(String(url || ""))) {
      try { shell.openExternal(String(url)); } catch {}
    }
    return { action: "deny" };
  });
  w.webContents.on("will-navigate", (ev, url) => {
    if (url && url !== w.getURL()) ev.preventDefault();
  });
  wcToPluginId.set(w.webContents, id);
  pluginWins.set(id, w);
  w.loadFile(html);
  w.once("ready-to-show", () => showPluginWindowSafe(id));
  w.webContents.once("did-finish-load", () => {
    setTimeout(() => showPluginWindowSafe(id), 30);
  });
  w.on("closed", () => {
    pluginWins.delete(id);
    notifyPluginWindowChanged(id, false);
  });
  notifyPluginWindowChanged(id, true);
  return { ok: true, open: true };
}

function closeSenderWindow(e) {
  const id = pluginIdOfSender(e);
  if (id) closePluginWindow(id);
  else {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w && !w.isDestroyed()) w.close();
  }
  return { ok: true };
}

function shutdownAppPlugins() {
  for (const id of [...pluginWins.keys()]) closePluginWindow(id);
}

function registerAppPluginsIpc(opts) {
  getDataDir = opts.getDataDir;
  getMainWin = opts.getMainWin;
  getAppVersion = opts.getAppVersion;
  appRoot = String((opts && opts.appRoot) || "");
  ipcMain.handle("appPlugins:catalog", () => loadCatalog());
  ipcMain.handle("appPlugins:icon", (e, name) => {
    const dataUrl = pluginIconDataUrl(name);
    return dataUrl ? { ok: true, dataUrl } : { ok: false };
  });
  ipcMain.handle("appPlugins:install", (e, id) => installWindowPlugin(String(id || "")));
  ipcMain.handle("appPlugins:uninstall", (e, id) => uninstallWindowPlugin(String(id || "")));
  ipcMain.handle("appPlugins:open", (e, id) => openWindowPlugin(String(id || "")));
  ipcMain.handle("appPlugins:close", (e) => closeSenderWindow(e));
  ipcMain.handle("appPlugins:closeById", (e, id) => {
    const sid = String(id || "");
    if (!ID_OK.test(sid)) return { ok: false, error: "bad_id" };
    closePluginWindow(sid);
    notifyPluginWindowChanged(sid, false);
    return { ok: true, open: false };
  });
  ipcMain.handle("appPlugins:isOpen", (e, id) => {
    const sid = String(id || "");
    if (!ID_OK.test(sid)) return { ok: false, open: false, error: "bad_id" };
    return { ok: true, open: isPluginWindowOpen(sid) };
  });
  ipcMain.handle("appPlugins:dataGet", (e) => {
    const id = pluginIdOfSender(e);
    if (!id) return { ok: false, error: "no_plugin" };
    return { ok: true, data: readJson(dataPath(id), {}) || {} };
  });
  ipcMain.handle("appPlugins:dataSet", (e, data) => {
    const id = pluginIdOfSender(e);
    if (!id) return { ok: false, error: "no_plugin" };
    writeJson(dataPath(id), data && typeof data === "object" ? data : {});
    return { ok: true };
  });
}

module.exports = {
  registerAppPluginsIpc,
  shutdownAppPlugins,
  openWindowPlugin,
  closePluginWindow,
  isPluginWindowOpen,
};
