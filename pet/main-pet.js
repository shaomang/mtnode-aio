"use strict";
/**
 * 桌宠可选组件（不随安装包分发）P1：
 * 下载/安装/卸载、透明窗、托盘/右键菜单、穿透/悬停隐藏/缩放透明度/镜像、
 * 全局键鼠驱动、本地形象导入。
 */
const {
  BrowserWindow,
  ipcMain,
  screen,
  Menu,
  Tray,
  nativeImage,
  dialog,
  app,
} = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const zlib = require("zlib");
const { pathToFileURL } = require("url");
const { spawn } = require("child_process");

const PET_FEED =
  process.env.MTNODE_PET_URL || "http://mt-agent.com/mtnode/pet";
const BASE_W = 360;
const BASE_H = 360;

let petWin = null;
let petTray = null;
let installing = false;
let getDataDir = null;
let getMainWin = null;
let appRoot = null;
let hoverTimer = null;
let hoverHidden = false;
let hookStarted = false;
let uIOhook = null;
let dragOffset = null;
/** @type {import('child_process').ChildProcess|null} */
let petProc = null;

function join(...a) {
  return path.join(...a);
}
function mk(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}
function petRoot() {
  return mk(join(getDataDir(), "pet"));
}
function installedMetaPath() {
  return join(petRoot(), "installed.json");
}
function runtimeDir() {
  return join(petRoot(), "runtime");
}
function skinsDir() {
  return mk(join(petRoot(), "skins"));
}
function configPath() {
  return join(petRoot(), "config.json");
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

function defaultConfig() {
  return {
    scale: 100,
    opacity: 100,
    mirror: false,
    penetrable: false,
    hideOnHover: false, /* 暂不默认开启：易导致窗体透明度变 0 像“消失” */
    alwaysOnTop: true,
    skinId: "bongocat-standard",
    x: null,
    y: null,
  };
}

function loadConfig() {
  const c = Object.assign(defaultConfig(), readJson(configPath(), {}) || {});
  c.scale = Math.max(40, Math.min(200, Number(c.scale) || 100));
  c.opacity = Math.max(20, Math.min(100, Number(c.opacity) || 100));
  c.mirror = !!c.mirror;
  c.penetrable = !!c.penetrable;
  c.hideOnHover = !!c.hideOnHover;
  c.alwaysOnTop = c.alwaysOnTop !== false;
  c.skinId = String(c.skinId || "bongocat-standard");
  if (c.skinId === "default") c.skinId = "bongocat-standard";
  return c;
}

function saveConfig(partial) {
  const next = Object.assign(loadConfig(), partial || {});
  writeJson(configPath(), next);
  return next;
}

function sendProgress(data) {
  try {
    const w = getMainWin && getMainWin();
    if (w && !w.isDestroyed()) w.webContents.send("pet:progress", data);
  } catch {}
}

function sendToPet(channel, data) {
  try {
    if (petWin && !petWin.isDestroyed()) petWin.webContents.send(channel, data);
  } catch {}
}

function isInstalled() {
  const meta = readJson(installedMetaPath(), null);
  if (!meta || !meta.version) return false;
  return fs.existsSync(join(runtimeDir(), "index.html"));
}

function pickCover(root) {
  const candidates = [
    join(root, "resources", "cover.png"),
    join(root, "cover.png"),
    join(root, "sprite.png"),
    join(root, "pet.png"),
    join(root, "preview.png"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return pathToFileURL(p).href;
  }
  return "";
}

function pickBackground(root) {
  const candidates = [
    join(root, "resources", "background.png"),
    join(root, "background.png"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return pathToFileURL(p).href;
  }
  return "";
}

function listSkins() {
  const out = [];
  const seen = Object.create(null);
  const add = (item) => {
    if (!item || !item.id || seen[item.id]) return;
    seen[item.id] = true;
    out.push(item);
  };

  const bundled = join(runtimeDir(), "models", "bongocat-standard");
  if (fs.existsSync(join(bundled, "cat.model3.json")) || fs.existsSync(join(bundled, "resources", "cover.png"))) {
    add({
      id: "bongocat-standard",
      name: "BongoCat Standard",
      path: bundled,
      builtin: true,
      cover: pickCover(bundled),
    });
  }
  add({ id: "default", name: "简易默认", path: "", builtin: true });

  try {
    for (const ent of fs.readdirSync(skinsDir(), { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const id = ent.name;
      const root = join(skinsDir(), id);
      const meta = readJson(join(root, "pet.json"), {}) || {};
      add({
        id,
        name: String(meta.name || id),
        path: root,
        builtin: false,
        cover: pickCover(root),
      });
    }
  } catch {}
  return out;
}

function resolveSkin(cfg) {
  let id = (cfg && cfg.skinId) || "bongocat-standard";
  if (id === "default") {
    const bundled = join(runtimeDir(), "models", "bongocat-standard");
    if (fs.existsSync(join(bundled, "resources", "cover.png"))) {
      id = "bongocat-standard";
    }
  }
  if (id === "bongocat-standard") {
    const root = join(runtimeDir(), "models", "bongocat-standard");
    if (fs.existsSync(root)) {
      return {
        id: "bongocat-standard",
        name: "BongoCat Standard",
        root,
        coverUrl: pickCover(root),
        backgroundUrl: pickBackground(root),
        keysLeft: join(root, "resources", "left-keys"),
        keysRight: join(root, "resources", "right-keys"),
        model3: findModel3(root),
      };
    }
  }
  if (id === "default") {
    return {
      id: "default",
      name: "简易默认",
      root: "",
      coverUrl: "",
      backgroundUrl: "",
      keysLeft: join(runtimeDir(), "resources", "left-keys"),
      keysRight: join(runtimeDir(), "resources", "right-keys"),
    };
  }
  const root = join(skinsDir(), id);
  if (!fs.existsSync(root)) {
    return resolveSkin({ skinId: "bongocat-standard" });
  }
  const meta = readJson(join(root, "pet.json"), {}) || {};
  return {
    id,
    name: String(meta.name || id),
    root,
    coverUrl: pickCover(root),
    backgroundUrl: pickBackground(root),
    keysLeft: join(root, "resources", "left-keys"),
    keysRight: join(root, "resources", "right-keys"),
    model3: findModel3(root),
  };
}

function findModel3(root) {
  try {
    for (const f of fs.readdirSync(root)) {
      if (f.endsWith(".model3.json")) return join(root, f);
    }
  } catch {}
  return "";
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function petPidPath() {
  return join(petRoot(), "pet-pid.json");
}

function isPetProcessRunning() {
  if (petProc && petProc.pid && pidAlive(petProc.pid)) return true;
  const meta = readJson(petPidPath(), null);
  if (meta && meta.pid && pidAlive(meta.pid)) return true;
  return false;
}

function status() {
  const meta = readJson(installedMetaPath(), null) || {};
  const cfg = loadConfig();
  const running = isPetProcessRunning();
  return {
    ok: true,
    installed: isInstalled(),
    running,
    installing,
    version: meta.version || "",
    installedAt: meta.installedAt || 0,
    source: meta.source || "",
    feed: PET_FEED,
    path: isInstalled() ? runtimeDir() : "",
    config: cfg,
    skins: listSkins(),
    hook: false,
    standalone: true,
    pid: (petProc && petProc.pid) || (readJson(petPidPath(), {}) || {}).pid || 0,
  };
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

function localPackDir() {
  const candidates = [
    join(appRoot, "pet-pack"),
    join(appRoot, "..", "pet-pack"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(join(p, "index.html"))) return path.resolve(p);
  }
  return null;
}

function fetchBuffer(url, onProgress) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(
      url,
      {
        headers: { "User-Agent": "MTNodeAIO/1.1-pet" },
        timeout: 120000,
      },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          fetchBuffer(res.headers.location, onProgress).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error("HTTP " + res.statusCode));
          return;
        }
        const total = Number(res.headers["content-length"]) || 0;
        const chunks = [];
        let got = 0;
        res.on("data", (c) => {
          chunks.push(c);
          got += c.length;
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

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
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

function finalizeInstall(version, source) {
  writeJson(installedMetaPath(), {
    version: String(version || "0.0.0"),
    source: String(source || ""),
    installedAt: Date.now(),
  });
}

async function installFromLocalPack() {
  const src = localPackDir();
  if (!src) return { ok: false, error: "no_local_pack" };
  sendProgress({ phase: "copy", percent: 10 });
  rmDirRecursive(runtimeDir());
  copyDirRecursive(src, runtimeDir());
  const man = readJson(join(runtimeDir(), "manifest.json"), {}) || {};
  finalizeInstall(man.version || "0.1.0", "local:" + src);
  sendProgress({ phase: "done", percent: 100 });
  return { ok: true, version: man.version || "0.1.0", source: "local" };
}

async function installFromRemote() {
  sendProgress({ phase: "manifest", percent: 2 });
  const manUrl = PET_FEED.replace(/\/$/, "") + "/manifest.json";
  const manBuf = await fetchBuffer(manUrl);
  const man = JSON.parse(manBuf.toString("utf8"));
  if (!man || !man.zipUrl) throw new Error("bad_manifest");
  let zipUrl = String(man.zipUrl);
  if (zipUrl.startsWith("/")) {
    zipUrl = PET_FEED.replace(/\/$/, "") + zipUrl;
  } else if (!/^https?:\/\//i.test(zipUrl)) {
    zipUrl = PET_FEED.replace(/\/$/, "") + "/" + zipUrl.replace(/^\.\//, "");
  }
  sendProgress({ phase: "download", percent: 5, version: man.version });
  const zipBuf = await fetchBuffer(zipUrl, ({ got, total }) => {
    const pct = total ? Math.min(90, 5 + Math.floor((got / total) * 85)) : 40;
    sendProgress({
      phase: "download",
      percent: pct,
      got,
      total,
      version: man.version,
    });
  });
  if (man.sha256) {
    const h = sha256(zipBuf);
    if (h.toLowerCase() !== String(man.sha256).toLowerCase()) {
      throw new Error("sha256_mismatch");
    }
  }
  sendProgress({ phase: "extract", percent: 92 });
  const tmpZipDir = join(petRoot(), "_extract_tmp");
  rmDirRecursive(tmpZipDir);
  mk(tmpZipDir);
  unzipBuffer(zipBuf, tmpZipDir);
  let srcDir = tmpZipDir;
  const ents = fs.readdirSync(tmpZipDir);
  if (ents.length === 1) {
    const only = join(tmpZipDir, ents[0]);
    if (
      fs.statSync(only).isDirectory() &&
      fs.existsSync(join(only, "index.html"))
    ) {
      srcDir = only;
    }
  }
  if (!fs.existsSync(join(srcDir, "index.html"))) {
    throw new Error("pack_missing_index");
  }
  rmDirRecursive(runtimeDir());
  copyDirRecursive(srcDir, runtimeDir());
  rmDirRecursive(tmpZipDir);
  finalizeInstall(man.version || "0.0.0", zipUrl);
  sendProgress({ phase: "done", percent: 100, version: man.version });
  return { ok: true, version: man.version || "0.0.0", source: "remote" };
}

async function installPet() {
  if (installing) return { ok: false, error: "busy" };
  installing = true;
  sendProgress({ phase: "start", percent: 0 });
  try {
    try {
      const r = await installFromRemote();
      installing = false;
      return r;
    } catch (remoteErr) {
      const local = await installFromLocalPack();
      if (local.ok) {
        installing = false;
        return {
          ok: true,
          version: local.version,
          source: "local-fallback",
          remoteError: String((remoteErr && remoteErr.message) || remoteErr),
        };
      }
      installing = false;
      return {
        ok: false,
        error: String((remoteErr && remoteErr.message) || remoteErr),
      };
    }
  } catch (err) {
    installing = false;
    sendProgress({
      phase: "error",
      percent: 0,
      error: String((err && err.message) || err),
    });
    return { ok: false, error: String((err && err.message) || err) };
  }
}

function scaledSize(cfg) {
  const s = (Number(cfg.scale) || 100) / 100;
  return {
    width: Math.max(120, Math.round(BASE_W * s)),
    height: Math.max(120, Math.round(BASE_H * s)),
  };
}

function applyWindowChrome(cfg) {
  if (!petWin || petWin.isDestroyed()) return;
  const c = cfg || loadConfig();
  const sz = scaledSize(c);
  const b = petWin.getBounds();
  petWin.setBounds({
    x: b.x,
    y: b.y,
    width: sz.width,
    height: sz.height,
  });
  if (!hoverHidden) {
    petWin.setOpacity(Math.max(0.05, (Number(c.opacity) || 100) / 100));
  }
  petWin.setAlwaysOnTop(!!c.alwaysOnTop, "screen-saver");
  applyPenetrable(c);
  pushPetState(c);
}

function applyPenetrable(cfg) {
  if (!petWin || petWin.isDestroyed()) return;
  const c = cfg || loadConfig();
  if (hoverHidden) {
    petWin.setIgnoreMouseEvents(true, { forward: true });
    return;
  }
  if (c.penetrable) {
    petWin.setIgnoreMouseEvents(true, { forward: true });
  } else {
    petWin.setIgnoreMouseEvents(false);
  }
}

function toRuntimeAssetUrl(absPath) {
  if (!absPath || !fs.existsSync(absPath)) return "";
  const rt = runtimeDir();
  let rel = path.relative(rt, absPath);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    return rel.split(path.sep).join("/");
  }
  return pathToFileURL(absPath).href;
}

function ensureBundledModels() {
  const dest = join(runtimeDir(), "models", "bongocat-standard");
  const cover = join(dest, "resources", "cover.png");
  if (fs.existsSync(cover)) return true;
  const srcCandidates = [
    join(appRoot, "pet-pack", "models", "bongocat-standard"),
    join(runtimeDir(), "..", "..", "pet-pack", "models", "bongocat-standard"),
  ];
  for (const src of srcCandidates) {
    if (!fs.existsSync(join(src, "resources", "cover.png"))) continue;
    try {
      rmDirRecursive(dest);
      copyDirRecursive(src, dest);
      return fs.existsSync(cover);
    } catch {}
  }
  return false;
}

function skinPayload(cfg) {
  ensureBundledModels();
  const skin = resolveSkin(cfg || loadConfig());
  const coverAbs = skin.root
    ? [join(skin.root, "resources", "cover.png"), join(skin.root, "cover.png")].find(
        (p) => fs.existsSync(p),
      )
    : "";
  const bgAbs = skin.root
    ? [
        join(skin.root, "resources", "background.png"),
        join(skin.root, "background.png"),
      ].find((p) => fs.existsSync(p))
    : "";
  return {
    id: skin.id,
    name: skin.name,
    coverUrl: toRuntimeAssetUrl(coverAbs) || "",
    backgroundUrl: toRuntimeAssetUrl(bgAbs) || "",
    keysLeftUrl: toRuntimeAssetUrl(skin.keysLeft) || "",
    keysRightUrl: toRuntimeAssetUrl(skin.keysRight) || "",
    model3: toRuntimeAssetUrl(skin.model3) || "",
    rootUrl: toRuntimeAssetUrl(skin.root) || "",
  };
}

function pushPetState(cfg) {
  const c = cfg || loadConfig();
  sendToPet("pet:state", {
    config: c,
    skin: skinPayload(c),
    hook: hookStarted,
  });
}

function startHoverWatch() {
  stopHoverWatch();
  hoverTimer = setInterval(() => {
    if (!petWin || petWin.isDestroyed()) return;
    const cfg = loadConfig();
    if (!cfg.hideOnHover) {
      if (hoverHidden) {
        hoverHidden = false;
        petWin.setOpacity(Math.max(0.05, cfg.opacity / 100));
        applyPenetrable(cfg);
      }
      return;
    }
    const p = screen.getCursorScreenPoint();
    const b = petWin.getBounds();
    const inside =
      p.x >= b.x &&
      p.x <= b.x + b.width &&
      p.y >= b.y &&
      p.y <= b.y + b.height;
    if (inside && !hoverHidden) {
      hoverHidden = true;
      petWin.setOpacity(0);
      petWin.setIgnoreMouseEvents(true, { forward: true });
    } else if (!inside && hoverHidden) {
      hoverHidden = false;
      petWin.setOpacity(Math.max(0.05, cfg.opacity / 100));
      applyPenetrable(cfg);
    }
  }, 60);
}

function stopHoverWatch() {
  if (hoverTimer) {
    clearInterval(hoverTimer);
    hoverTimer = null;
  }
  hoverHidden = false;
}

let keycodeNameMap = null;
function buildKeycodeNameMap() {
  if (keycodeNameMap) return keycodeNameMap;
  keycodeNameMap = Object.create(null);
  try {
    const { UiohookKey } = require("uiohook-napi");
    for (const [name, code] of Object.entries(UiohookKey || {})) {
      if (typeof code === "number") keycodeNameMap[code] = name;
    }
    /* 别名：修饰键统一短名，便于皮肤 PNG 文件名匹配 */
    const alias = {
      Ctrl: "Control",
      CtrlRight: "Control",
      ShiftRight: "Shift",
      AltRight: "Alt",
      MetaRight: "Meta",
    };
    for (const [from, to] of Object.entries(alias)) {
      if (UiohookKey[from] != null) keycodeNameMap[UiohookKey[from]] = to;
    }
  } catch {}
  return keycodeNameMap;
}

function keyNameFromEvent(e) {
  if (!e || e.keycode == null) return "";
  const map = buildKeycodeNameMap();
  if (map[e.keycode]) return String(map[e.keycode]);
  return "Key" + e.keycode;
}

function mouseButtonName(button) {
  /* uiohook: 1 left, 2 right, 3 middle（部分平台枚举不同） */
  const b = Number(button);
  if (b === 2) return "Right";
  if (b === 3) return "Middle";
  return "Left";
}

function startDeviceHook() {
  if (hookStarted) return true;
  try {
    const mod = require("uiohook-napi");
    uIOhook = mod.uIOhook;
    buildKeycodeNameMap();
    const emit = (kind, value) => sendToPet("pet:device", { kind, value });
    uIOhook.on("keydown", (e) => emit("KeyboardPress", keyNameFromEvent(e)));
    uIOhook.on("keyup", (e) => emit("KeyboardRelease", keyNameFromEvent(e)));
    uIOhook.on("mousedown", (e) => emit("MousePress", mouseButtonName(e.button)));
    uIOhook.on("mouseup", (e) => emit("MouseRelease", mouseButtonName(e.button)));
    uIOhook.on("mousemove", (e) => emit("MouseMove", { x: e.x, y: e.y }));
    uIOhook.start();
    hookStarted = true;
    return true;
  } catch (err) {
    hookStarted = false;
    console.error("[pet] uiohook failed:", err && err.message ? err.message : err);
    return false;
  }
}

function stopDeviceHook() {
  if (!hookStarted || !uIOhook) return;
  try {
    uIOhook.stop();
    uIOhook.removeAllListeners();
  } catch {}
  hookStarted = false;
}

function trayIcon() {
  const candidates = [
    join(appRoot, "build", "icon.png"),
    join(appRoot, "build", "icon.ico"),
    join(runtimeDir(), "tray.png"),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    const img = nativeImage.createFromPath(p);
    if (img && !img.isEmpty()) return img.resize({ width: 16, height: 16 });
  }
  /* 1x1 fallback */
  return nativeImage.createEmpty();
}

function buildPetMenu() {
  const cfg = loadConfig();
  return Menu.buildFromTemplate([
    {
      label: petWin && !petWin.isDestroyed() && petWin.isVisible()
        ? "隐藏桌宠"
        : "显示桌宠",
      click: () => {
        if (!petWin || petWin.isDestroyed()) {
          startPet();
          return;
        }
        if (petWin.isVisible()) petWin.hide();
        else petWin.showInactive();
      },
    },
    { type: "separator" },
    {
      label: "始终置顶",
      type: "checkbox",
      checked: !!cfg.alwaysOnTop,
      click: (item) => {
        const next = saveConfig({ alwaysOnTop: !!item.checked });
        applyWindowChrome(next);
      },
    },
    {
      label: "镜像",
      type: "checkbox",
      checked: !!cfg.mirror,
      click: (item) => {
        const next = saveConfig({ mirror: !!item.checked });
        pushPetState(next);
      },
    },
    {
      label: "悬停隐藏",
      type: "checkbox",
      checked: !!cfg.hideOnHover,
      click: (item) => {
        const next = saveConfig({ hideOnHover: !!item.checked });
        applyWindowChrome(next);
      },
    },
    {
      label: "缩放",
      submenu: [50, 75, 100, 125, 150].map((v) => ({
        label: v + "%",
        type: "radio",
        checked: Number(cfg.scale) === v,
        click: () => {
          const next = saveConfig({ scale: v });
          applyWindowChrome(next);
        },
      })),
    },
    { type: "separator" },
    {
      label: "停止桌宠",
      click: () => stopPet(),
    },
  ]);
}

function ensureTray() {
  if (petTray) return;
  try {
    petTray = new Tray(trayIcon());
    petTray.setToolTip("MTNode 桌宠");
    petTray.setContextMenu(buildPetMenu());
    petTray.on("click", () => {
      if (!petWin || petWin.isDestroyed()) startPet();
      else if (petWin.isVisible()) petWin.hide();
      else petWin.showInactive();
    });
  } catch (err) {
    console.error("[pet] tray failed:", err && err.message ? err.message : err);
  }
}

function destroyTray() {
  if (petTray) {
    try {
      petTray.destroy();
    } catch {}
    petTray = null;
  }
}

function refreshTrayMenu() {
  if (petTray) {
    try {
      petTray.setContextMenu(buildPetMenu());
    } catch {}
  }
}

function popupPetMenu() {
  const cfg = loadConfig();
  const wasTop = !!cfg.alwaysOnTop;
  /* Windows：置顶窗会盖住原生菜单，弹出前暂时取消置顶（对齐 BongoCat） */
  if (wasTop && petWin && !petWin.isDestroyed()) {
    try {
      petWin.setAlwaysOnTop(false);
    } catch {}
  }
  const menu = buildPetMenu();
  const restore = () => {
    if (wasTop && petWin && !petWin.isDestroyed()) {
      try {
        petWin.setAlwaysOnTop(true, "screen-saver");
      } catch {}
    }
  };
  try {
    if (petWin && !petWin.isDestroyed()) {
      menu.popup({ window: petWin, callback: restore });
    } else {
      menu.popup({ callback: restore });
    }
  } catch (err) {
    restore();
    console.error("[pet] popup menu:", err && err.message ? err.message : err);
  }
}

async function importSkinFolder() {
  const parent = getMainWin && getMainWin();
  const result = await dialog.showOpenDialog(parent || undefined, {
    title: "选择桌宠形象文件夹",
    properties: ["openDirectory"],
  });
  if (!result || result.canceled || !result.filePaths || !result.filePaths[0]) {
    return { ok: false, error: "cancelled" };
  }
  const src = result.filePaths[0];
  const id =
    "skin_" +
    Date.now().toString(36) +
    "_" +
    crypto.randomBytes(3).toString("hex");
  const dest = join(skinsDir(), id);
  try {
    copyDirRecursive(src, dest);
    const name = path.basename(src);
    const metaPath = join(dest, "pet.json");
    if (!fs.existsSync(metaPath)) {
      writeJson(metaPath, { name, importedAt: Date.now() });
    } else {
      const m = readJson(metaPath, {}) || {};
      if (!m.name) {
        m.name = name;
        writeJson(metaPath, m);
      }
    }
    const next = saveConfig({ skinId: id });
    pushPetState(next);
    refreshTrayMenu();
    return { ok: true, id, name, skins: listSkins() };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

function stopPet() {
  /* 结束独立桌宠进程 */
  if (petProc && petProc.pid) {
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(petProc.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } else {
        petProc.kill("SIGTERM");
      }
    } catch {}
    petProc = null;
  }
  const meta = readJson(petPidPath(), null);
  if (meta && meta.pid && pidAlive(meta.pid)) {
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(meta.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } else {
        process.kill(meta.pid, "SIGTERM");
      }
    } catch {}
  }
  try {
    fs.unlinkSync(petPidPath());
  } catch {}
  if (petWin && !petWin.isDestroyed()) {
    try {
      petWin.close();
    } catch {}
  }
  petWin = null;
  stopHoverWatch();
  stopDeviceHook();
  destroyTray();
  return { ok: true };
}

function uninstallPet() {
  stopPet();
  rmDirRecursive(runtimeDir());
  try {
    fs.unlinkSync(installedMetaPath());
  } catch {}
  return { ok: true };
}

function startPet() {
  if (!isInstalled()) return { ok: false, error: "not_installed" };
  if (isPetProcessRunning()) return { ok: true, already: true, standalone: true };

  ensureBundledModels();
  const cfg = loadConfig();
  saveConfig({
    skinId:
      !cfg.skinId || cfg.skinId === "default"
        ? "bongocat-standard"
        : cfg.skinId,
    hideOnHover: false,
    penetrable: false,
    opacity: Math.max(40, Number(cfg.opacity) || 100),
  });

  const env = {
    ...process.env,
    MTNODE_PARENT_PID: String(process.pid),
  };
  /* 显式去掉可能残留的角色变量，避免子进程逻辑误判；入口只认 --mtnode-pet */
  delete env.MTNODE_ROLE;
  try {
    const root = getDataDir && getDataDir();
    if (root) {
      env.MTNODE_PET_DATA = root;
      const userData = path.dirname(root);
      if (userData) env.MTNODE_DATA_DIR = userData;
    }
  } catch {}

  let args;
  if (app.isPackaged) {
    args = ["--mtnode-pet"];
  } else {
    const appPath = appRoot || app.getAppPath();
    args = [appPath, "--mtnode-pet"];
  }

  try {
    petProc = spawn(process.execPath, args, {
      env,
      stdio: "ignore",
      windowsHide: false,
      detached: false,
    });
    petProc.on("exit", () => {
      petProc = null;
      try {
        fs.unlinkSync(petPidPath());
      } catch {}
    });
    petProc.on("error", (err) => {
      console.error("[pet] spawn error:", err && err.message ? err.message : err);
      petProc = null;
    });
    writeJson(petPidPath(), {
      pid: petProc.pid,
      parentPid: process.pid,
      at: Date.now(),
      role: "spawned",
    });
    return { ok: true, pid: petProc.pid, standalone: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

function registerPetIpc(opts) {
  getDataDir = opts.getDataDir;
  getMainWin = opts.getMainWin;
  appRoot = opts.appRoot || path.join(__dirname, "..");

  ipcMain.handle("pet:status", () => status());
  ipcMain.handle("pet:install", async () => installPet());
  ipcMain.handle("pet:uninstall", async () => {
    if (installing) return { ok: false, error: "busy" };
    return uninstallPet();
  });
  ipcMain.handle("pet:start", () => startPet());
  ipcMain.handle("pet:stop", () => stopPet());
  ipcMain.handle("pet:toggle", () => {
    if (isPetProcessRunning()) return stopPet();
    return startPet();
  });
  ipcMain.handle("pet:getConfig", () => ({ ok: true, config: loadConfig() }));
  /* 配置写入共享目录；独立桌宠进程通过监视 config.json 自动应用 */
  ipcMain.handle("pet:setConfig", (e, partial) => {
    const next = saveConfig(partial || {});
    return { ok: true, config: next };
  });
  ipcMain.handle("pet:listSkins", () => ({ ok: true, skins: listSkins() }));
  ipcMain.handle("pet:importSkin", async () => importSkinFolder());
  ipcMain.handle("pet:setSkin", (e, id) => {
    const next = saveConfig({ skinId: String(id || "bongocat-standard") });
    return { ok: true, config: next, skins: listSkins() };
  });
  /* 以下为旧版内嵌窗兼容；独立进程自行处理 */
  ipcMain.handle("pet:popupMenu", () => ({ ok: true }));
  ipcMain.handle("pet:dragStart", () => ({ ok: false }));
  ipcMain.handle("pet:dragMove", () => ({ ok: false }));
  ipcMain.handle("pet:dragEnd", () => ({ ok: false }));
  ipcMain.handle("pet:getState", () => {
    const cfg = loadConfig();
    return {
      ok: true,
      config: cfg,
      skin: skinPayload(cfg),
      hook: false,
      standalone: true,
      running: isPetProcessRunning(),
    };
  });
}

function shutdownPet() {
  stopPet();
}

module.exports = {
  registerPetIpc,
  shutdownPet,
  status,
  PET_FEED,
};
