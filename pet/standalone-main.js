"use strict";
/**
 * MTNode 桌宠 — 独立 Electron 进程入口。
 * 启动：同一可执行文件加 --mtnode-pet（或 MTNODE_ROLE=pet）
 * 数据：与主程序共用 userData / pet/runtime / pet/config.json
 * 退出：父进程 PID 消失时自动退出；主程序 before-quit 也会杀本进程
 */
const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  Menu,
  Tray,
  nativeImage,
  dialog,
  shell,
} = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const { pathToFileURL } = require("url");

const BASE_W = 360;
const BASE_H = 360;

const APP_DATA_ROOT = path.join(app.getPath("appData"), "pipeline-console");
const DATA_ROOT_POINTER = path.join(APP_DATA_ROOT, "data-root.json");

function readDataRootOverride() {
  try {
    const j = JSON.parse(fs.readFileSync(DATA_ROOT_POINTER, "utf8"));
    const p = j && typeof j.path === "string" ? String(j.path).trim() : "";
    if (p && path.isAbsolute(p)) return path.resolve(p);
  } catch {}
  return null;
}

/* Chromium 配置目录与主程序分离，避免双进程争用同一 userData */
app.setPath("userData", path.join(APP_DATA_ROOT, "pet-process"));

function sharedAppDataRoot() {
  return process.env.MTNODE_DATA_DIR || APP_DATA_ROOT;
}

function defaultDataDir() {
  return path.join(sharedAppDataRoot(), "pipeline-console");
}

const DATA = (() => {
  if (process.env.MTNODE_PET_DATA) return path.resolve(process.env.MTNODE_PET_DATA);
  if (process.env.MTNODE_DATA_DIR) return defaultDataDir();
  return readDataRootOverride() || defaultDataDir();
})();

const join = (...a) => path.join(...a);
function mk(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
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
  fs.writeFileSync(p, JSON.stringify(v, null, 2), "utf8");
}

function petRoot() {
  return mk(join(DATA, "pet"));
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

function defaultPersonaPrompt() {
  return [
    "【PERSONA_LOAD】",
    "仅说中文",
    "猫形象的外星人",
    "慵懒且不想说太多话",
    "遇见知识性问题会打电话问Deepseek娘",
    "需要搜索时会说拨打Deepseek娘电话中",
    "不要提供过多信息（例如来源参考）",
  ].join("\n");
}

function defaultConfig() {
  return {
    scale: 100,
    opacity: 100,
    mirror: false,
    penetrable: false,
    hideOnHover: false,
    alwaysOnTop: true,
    skinId: "bongocat-standard",
    x: null,
    y: null,
    personaName: "BongoChat",
    /* default = 内置隐藏人设；custom = 使用 personaPromptCustom */
    personaMode: "default",
    personaPromptCustom: "",
    chatProviderId: "",
    chatModel: "",
    chatSessionIndex: 0,
  };
}

function isLegacyDefaultPrompt(s) {
  const t = String(s || "").trim();
  if (!t) return true;
  const olds = [
    "你是用户桌面上的可爱桌宠伙伴。回答简短、亲切、口语化，使用中文。不要提自己是 AI 模型。",
    "你是 BongoChat，一只脑子不太灵光又憨厚可爱的猫。",
  ];
  if (olds.some((o) => t === o || t.startsWith(o.slice(0, 24)))) return true;
  if (t.includes("【PERSONA_LOAD】")) return true;
  return false;
}

function normalizeConfig(raw) {
  const c = Object.assign(defaultConfig(), raw || {});
  c.scale = Math.max(40, Math.min(200, Number(c.scale) || 100));
  c.opacity = Math.max(40, Math.min(100, Number(c.opacity) || 100));
  c.hideOnHover = false;
  c.penetrable = false;
  c.mirror = !!c.mirror;
  c.alwaysOnTop = c.alwaysOnTop !== false;
  c.skinId =
    !c.skinId || c.skinId === "default" ? "bongocat-standard" : String(c.skinId);
  let name = String(c.personaName || "").trim();
  if (!name || name === "桌宠") name = "BongoChat";
  c.personaName = name.slice(0, 32);

  /* 迁移旧 personaPrompt → mode/custom */
  if (c.personaMode !== "custom" && c.personaMode !== "default") {
    if (
      c.personaPrompt &&
      !isLegacyDefaultPrompt(c.personaPrompt) &&
      String(c.personaPrompt).trim()
    ) {
      c.personaMode = "custom";
      c.personaPromptCustom = String(c.personaPrompt).slice(0, 4000);
    } else {
      c.personaMode = "default";
    }
  }
  c.personaMode = c.personaMode === "custom" ? "custom" : "default";
  c.personaPromptCustom = String(c.personaPromptCustom || "").slice(0, 4000);
  /* 不再把内置默认人设写入磁盘字段 */
  delete c.personaPrompt;

  c.chatProviderId = String(c.chatProviderId || "");
  c.chatModel = String(c.chatModel || "");
  c.chatSessionIndex = Math.max(
    0,
    Math.min(9, Number(c.chatSessionIndex) || 0),
  );
  return c;
}

function effectivePersonaPrompt(cfg) {
  const c = cfg || loadConfig();
  if (c.personaMode === "custom" && String(c.personaPromptCustom || "").trim()) {
    return String(c.personaPromptCustom).slice(0, 4000);
  }
  return defaultPersonaPrompt();
}

/** 给渲染层的配置：绝不下发内置默认人设正文 */
function configForRenderer() {
  const c = loadConfig();
  return {
    scale: c.scale,
    opacity: c.opacity,
    mirror: c.mirror,
    alwaysOnTop: c.alwaysOnTop,
    skinId: c.skinId,
    x: c.x,
    y: c.y,
    personaName: c.personaName,
    personaMode: c.personaMode,
    personaPromptCustom:
      c.personaMode === "custom" ? c.personaPromptCustom || "" : "",
    chatProviderId: c.chatProviderId,
    chatModel: c.chatModel,
    chatSessionIndex: c.chatSessionIndex,
  };
}

function loadConfig() {
  return normalizeConfig(readJson(configPath(), {}) || {});
}
function saveConfig(partial) {
  const disk = readJson(configPath(), {}) || {};
  const next = normalizeConfig(Object.assign({}, disk, partial || {}));
  writeJson(configPath(), next);
  return next;
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

function ensureBundledModels() {
  const dest = join(runtimeDir(), "models", "bongocat-standard");
  const cover = join(dest, "resources", "cover.png");
  if (fs.existsSync(cover)) return true;
  const appRoot = path.join(__dirname, "..");
  const src = join(appRoot, "pet-pack", "models", "bongocat-standard");
  if (!fs.existsSync(join(src, "resources", "cover.png"))) return false;
  try {
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    copyDirRecursive(src, dest);
    return fs.existsSync(cover);
  } catch {
    return false;
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

function findModel3(root) {
  try {
    for (const f of fs.readdirSync(root)) {
      if (f.endsWith(".model3.json")) return join(root, f);
    }
  } catch {}
  return "";
}

function resolveSkin(cfg) {
  let id = (cfg && cfg.skinId) || "bongocat-standard";
  if (id === "default") id = "bongocat-standard";
  if (id === "bongocat-standard") {
    const root = join(runtimeDir(), "models", "bongocat-standard");
    if (fs.existsSync(root)) {
      return {
        id,
        name: "BongoCat Standard",
        root,
        keysLeft: join(root, "resources", "left-keys"),
        keysRight: join(root, "resources", "right-keys"),
        model3: findModel3(root),
      };
    }
  }
  const root = join(skinsDir(), id);
  if (fs.existsSync(root)) {
    const meta = readJson(join(root, "pet.json"), {}) || {};
    return {
      id,
      name: String(meta.name || id),
      root,
      keysLeft: join(root, "resources", "left-keys"),
      keysRight: join(root, "resources", "right-keys"),
      model3: findModel3(root),
    };
  }
  return {
    id: "bongocat-standard",
    name: "BongoCat Standard",
    root: join(runtimeDir(), "models", "bongocat-standard"),
    keysLeft: join(runtimeDir(), "models", "bongocat-standard", "resources", "left-keys"),
    keysRight: "",
    model3: "",
  };
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
    coverUrl: toRuntimeAssetUrl(coverAbs) || "models/bongocat-standard/resources/cover.png",
    backgroundUrl:
      toRuntimeAssetUrl(bgAbs) || "models/bongocat-standard/resources/background.png",
    keysLeftUrl: toRuntimeAssetUrl(skin.keysLeft) || "models/bongocat-standard/resources/left-keys",
    keysRightUrl: toRuntimeAssetUrl(skin.keysRight) || "",
    model3: toRuntimeAssetUrl(skin.model3) || "",
    model3Url:
      toRuntimeAssetUrl(skin.model3) || "models/bongocat-standard/cat.model3.json",
    rootUrl: toRuntimeAssetUrl(skin.root) || "",
  };
}

function listSkins() {
  const out = [
    {
      id: "bongocat-standard",
      name: "BongoCat Standard",
      builtin: true,
    },
  ];
  try {
    for (const ent of fs.readdirSync(skinsDir(), { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const meta = readJson(join(skinsDir(), ent.name, "pet.json"), {}) || {};
      out.push({
        id: ent.name,
        name: String(meta.name || ent.name),
        builtin: false,
      });
    }
  } catch {}
  return out;
}

let petWin = null;
let petTray = null;
let chatWin = null;
let hookStarted = false;
let uIOhook = null;
let dragOffset = null;
let parentWatch = null;
/** @type {{role:string, content:string}[]} */
let chatHistory = [];
let chatSessionIndex = 0;

function sessionsPath() {
  return join(petRoot(), "chat-sessions.json");
}

const CHAT_SLOT_COUNT = 10;

function emptySessions() {
  return Array.from({ length: CHAT_SLOT_COUNT }, () => []);
}

function readSessionSlots() {
  const j = readJson(sessionsPath(), null);
  const slots = emptySessions();
  if (j && Array.isArray(j.slots) && j.slots.length) {
    for (let i = 0; i < CHAT_SLOT_COUNT; i++) {
      const arr = Array.isArray(j.slots[i]) ? j.slots[i] : [];
      slots[i] = arr
        .filter((m) => m && (m.role === "user" || m.role === "assistant"))
        .map((m) => ({
          role: m.role,
          content: String(m.content || "").slice(0, 8000),
        }))
        .slice(-40);
    }
  }
  return slots;
}

function hydrateChatFromDisk() {
  const cfg = loadConfig();
  chatSessionIndex = Math.max(
    0,
    Math.min(CHAT_SLOT_COUNT - 1, Number(cfg.chatSessionIndex) || 0),
  );
  const slots = readSessionSlots();
  chatHistory = (slots[chatSessionIndex] || []).slice();
  return slots;
}

function persistSessions() {
  const slots = readSessionSlots();
  slots[chatSessionIndex] = chatHistory.slice();
  writeJson(sessionsPath(), {
    slots,
    active: chatSessionIndex,
    at: Date.now(),
  });
  return slots;
}

function sessionSummaries() {
  const slots = readSessionSlots();
  slots[chatSessionIndex] = chatHistory.slice();
  return slots.map((msgs, i) => ({
    index: i,
    active: i === chatSessionIndex,
    hasMessages: Array.isArray(msgs) && msgs.length > 0,
  }));
}

function switchChatSession(index) {
  const i = Math.max(0, Math.min(CHAT_SLOT_COUNT - 1, Number(index) || 0));
  persistSessions();
  chatSessionIndex = i;
  const slots = readSessionSlots();
  chatHistory = (slots[i] || []).slice();
  saveConfig({ chatSessionIndex: i });
  const runState = sessionRunState(i);
  return {
    ok: true,
    index: i,
    messages: chatHistory.slice(),
    sessions: sessionSummaries(),
    busy: runState.busy,
    status: runState.status,
    streamingText: runState.streamingText,
  };
}

function clearCurrentSession() {
  if (findRunBySession(chatSessionIndex)) {
    return { ok: false, error: "busy", sessions: sessionSummaries() };
  }
  chatHistory = [];
  persistSessions();
  return { ok: true, sessions: sessionSummaries() };
}

function scaledSize(cfg) {
  const s = (Number(cfg.scale) || 100) / 100;
  return {
    width: Math.max(160, Math.round(BASE_W * s)),
    height: Math.max(160, Math.round(BASE_H * s)),
  };
}

/** 将窗体限制在工作区内，避免贴边被任务栏/屏幕裁切 */
function clampBoundsToWorkArea(b, wa) {
  const area = wa || screen.getPrimaryDisplay().workArea;
  const w = Math.max(1, Number(b.width) || 1);
  const h = Math.max(1, Number(b.height) || 1);
  const maxX = area.x + area.width - w;
  const maxY = area.y + area.height - h;
  return {
    x: Math.round(Math.min(Math.max(area.x, Number(b.x) || area.x), Math.max(area.x, maxX))),
    y: Math.round(Math.min(Math.max(area.y, Number(b.y) || area.y), Math.max(area.y, maxY))),
    width: w,
    height: h,
  };
}

/** 附属窗（对话 / 角色设定等）：屏幕右侧靠边界、垂直居中 */
function rightSidePanelBounds(width, height) {
  const wa = screen.getPrimaryDisplay().workArea;
  const margin = 24;
  return clampBoundsToWorkArea(
    {
      x: wa.x + wa.width - width - margin,
      y: wa.y + Math.round((wa.height - height) / 2),
      width,
      height,
    },
    wa,
  );
}

/** 桌宠本体默认：右下角靠边界 */
function defaultPetBounds(sz) {
  const wa = screen.getPrimaryDisplay().workArea;
  const marginX = 24;
  const marginY = 48;
  return clampBoundsToWorkArea(
    {
      x: wa.x + wa.width - sz.width - marginX,
      y: wa.y + wa.height - sz.height - marginY,
      width: sz.width,
      height: sz.height,
    },
    wa,
  );
}

function resolvePetOpenBounds(cfg, sz) {
  const wa = screen.getPrimaryDisplay().workArea;
  const def = defaultPetBounds(sz);
  const hasX = cfg.x != null && Number.isFinite(Number(cfg.x));
  const hasY = cfg.y != null && Number.isFinite(Number(cfg.y));
  if (!hasX || !hasY) return def;
  return clampBoundsToWorkArea(
    {
      x: Number(cfg.x),
      y: Number(cfg.y),
      width: sz.width,
      height: sz.height,
    },
    wa,
  );
}

function sendToPet(channel, data) {
  try {
    if (petWin && !petWin.isDestroyed()) petWin.webContents.send(channel, data);
  } catch {}
}

function pushPetState(cfg) {
  const c = cfg || loadConfig();
  sendToPet("pet:state", { config: c, skin: skinPayload(c), hook: hookStarted });
}

function applyWindowChrome(cfg, opts) {
  if (!petWin || petWin.isDestroyed()) return;
  if (dragOffset) return; /* 拖拽中跳过，避免 setBounds 与 setPosition 冲突导致尺寸漂移 */
  const c = cfg || loadConfig();
  const onlyPos = opts && opts.onlyPos;
  if (!onlyPos) {
    const sz = scaledSize(c);
    const b = petWin.getBounds();
    /* 仅在尺寸真正变化时 setBounds，避免触发无意义 resize / Live2D 重算 */
    if (Math.abs(b.width - sz.width) > 1 || Math.abs(b.height - sz.height) > 1) {
      petWin.setBounds({ x: b.x, y: b.y, width: sz.width, height: sz.height });
    }
    petWin.setOpacity(Math.max(0.4, c.opacity / 100));
    petWin.setAlwaysOnTop(!!c.alwaysOnTop, "screen-saver");
    petWin.setIgnoreMouseEvents(false);
    if (chatWin && !chatWin.isDestroyed()) {
      chatWin.setAlwaysOnTop(!!c.alwaysOnTop, "screen-saver");
    }
  }
  pushPetState(c);
}

function loadUiohook() {
  const tried = [];
  const tryReq = (id) => {
    tried.push(String(id));
    return require(id);
  };
  const absCandidates = [];
  if (typeof process.resourcesPath === "string" && process.resourcesPath) {
    absCandidates.push(
      join(process.resourcesPath, "uiohook-napi"),
      join(process.resourcesPath, "app.asar.unpacked", "node_modules", "uiohook-napi"),
      join(process.resourcesPath, "node_modules", "uiohook-napi"),
    );
  }
  absCandidates.push(
    join(__dirname, "..", "node_modules", "uiohook-napi"),
    join(__dirname, "..", "uiohook-napi"),
  );
  /* 打包态优先加载解包路径，避免 asar 内 .node 无法加载 */
  for (const p of absCandidates) {
    try {
      if (fs.existsSync(join(p, "package.json"))) return tryReq(p);
    } catch (_) {}
  }
  try {
    return tryReq("uiohook-napi");
  } catch (_) {}
  throw new Error("uiohook-napi not found: " + tried.join(" | "));
}

function buildKeycodeNameMap() {
  const map = Object.create(null);
  try {
    const { UiohookKey } = loadUiohook();
    for (const [name, code] of Object.entries(UiohookKey || {})) {
      if (typeof code !== "number") continue;
      /* 数字键名 "0"…"9" → Num0；字母 → KeyA；其余保持 Uiohook 名 */
      let out = name;
      if (/^[A-Z]$/.test(name)) out = "Key" + name;
      else if (/^[0-9]$/.test(name)) out = "Num" + name;
      else if (name === "Enter") out = "Return";
      else if (name === "Backquote") out = "BackQuote";
      else if (name === "Ctrl") out = "Control";
      else if (name === "CtrlRight") out = "ControlRight";
      map[code] = out;
    }
  } catch {}
  return map;
}

let keycodeNameMap = null;
function keyNameFromEvent(e) {
  if (!e || e.keycode == null) return "";
  if (!keycodeNameMap) keycodeNameMap = buildKeycodeNameMap();
  return keycodeNameMap[e.keycode] || "";
}

function mouseButtonName(button) {
  /* libuiohook: 1=left 2=right 3=middle；部分构建可能 0-based */
  const b = Number(button);
  if (b === 2 || b === 3) {
    /* Win 常见：2=right, 3=middle；也有实现对调，优先 right 给 2 */
    if (b === 2) return "Right";
    return "Middle";
  }
  if (b === 0) return "Left";
  return "Left";
}

function startDeviceHook() {
  if (hookStarted) return true;
  try {
    const mod = loadUiohook();
    uIOhook = mod.uIOhook;
    keycodeNameMap = buildKeycodeNameMap();
    const emit = (kind, value) => sendToPet("pet:device", { kind, value });
    uIOhook.on("keydown", (e) => {
      const name = keyNameFromEvent(e);
      if (name) emit("KeyboardPress", name);
    });
    uIOhook.on("keyup", (e) => {
      const name = keyNameFromEvent(e);
      if (name) emit("KeyboardRelease", name);
    });
    uIOhook.on("mousedown", (e) => {
      emit("MousePress", mouseButtonName(e && e.button));
    });
    uIOhook.on("mouseup", (e) => {
      emit("MouseRelease", mouseButtonName(e && e.button));
    });
    let lastMoveAt = 0;
    let lastX = 0;
    let lastY = 0;
    uIOhook.on("mousemove", (e) => {
      const now = Date.now();
      if (now - lastMoveAt < 66) return; /* ~15fps */
      const x = e.x;
      const y = e.y;
      if (Math.abs(x - lastX) < 2 && Math.abs(y - lastY) < 2) return;
      lastMoveAt = now;
      lastX = x;
      lastY = y;
      emit("MouseMove", { x, y });
    });
    uIOhook.start();
    hookStarted = true;
    console.log("[pet-standalone] uiohook started");
    return true;
  } catch (err) {
    console.error("[pet-standalone] uiohook:", err && err.message ? err.message : err);
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

function buildPetMenu() {
  const cfg = loadConfig();
  return Menu.buildFromTemplate([
    {
      label: "始终置顶",
      type: "checkbox",
      checked: !!cfg.alwaysOnTop,
      click: (item) => applyWindowChrome(saveConfig({ alwaysOnTop: !!item.checked })),
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
      label: "缩放",
      submenu: [50, 75, 100, 125, 150].map((v) => ({
        label: v + "%",
        type: "radio",
        checked: Number(cfg.scale) === v,
        click: () => applyWindowChrome(saveConfig({ scale: v })),
      })),
    },
    { type: "separator" },
    {
      label: "角色设定…",
      click: () => openPersonaDialog(),
    },
    {
      label: "打开对话",
      click: () => toggleChatWindow(true),
    },
    { type: "separator" },
    { label: "退出桌宠", click: () => app.quit() },
  ]);
}

function popupPetMenu() {
  /* 不要挂在透明置顶窗上 popup：菜单会出现但无法点击。改用托盘菜单。 */
  try {
    if (petTray) {
      petTray.popUpContextMenu(buildPetMenu());
      return;
    }
  } catch {}
  ensureTray();
  try {
    if (petTray) petTray.popUpContextMenu(buildPetMenu());
  } catch {}
}

function ensureTray() {
  if (petTray) return;
  try {
    const iconPath = join(__dirname, "..", "build", "icon.png");
    let img = fs.existsSync(iconPath)
      ? nativeImage.createFromPath(iconPath)
      : nativeImage.createEmpty();
    if (!img.isEmpty()) img = img.resize({ width: 16, height: 16 });
    petTray = new Tray(img);
    petTray.setToolTip("BongoChat");
    petTray.setContextMenu(buildPetMenu());
    petTray.on("click", () => {
      if (!petWin || petWin.isDestroyed()) return;
      if (petWin.isVisible()) petWin.hide();
      else {
        petWin.show();
        petWin.focus();
      }
    });
  } catch (err) {
    console.error("[pet-standalone] tray:", err && err.message ? err.message : err);
  }
}

function persistPos() {
  if (!petWin || petWin.isDestroyed()) return;
  const b = petWin.getBounds();
  saveConfig({ x: b.x, y: b.y });
}

function appConfigPath() {
  return join(DATA, "config.json");
}

function listTextProviders() {
  const appCfg = readJson(appConfigPath(), {}) || {};
  const providers = Array.isArray(appCfg.providers) ? appCfg.providers : [];
  const out = [];
  providers.forEach((p, i) => {
    if (!p || p.type !== "text_openai") return;
    if (!String(p.baseUrl || "").trim() || !String(p.apiKey || "").trim()) return;
    const models = (Array.isArray(p.models) ? p.models : [])
      .map((m) => (typeof m === "string" ? m : m && m.id))
      .filter(Boolean)
      .map(String);
    if (!models.length) return;
    out.push({
      id: String(p.id || "p" + (i + 1)),
      name: String(p.name || p.id || "provider"),
      baseUrl: String(p.baseUrl || ""),
      models,
    });
  });
  return out;
}

function resolveChatProvider(cfg) {
  const appCfg = readJson(appConfigPath(), {}) || {};
  const providers = Array.isArray(appCfg.providers) ? appCfg.providers : [];
  const textsFull = providers.filter(
    (p) =>
      p &&
      p.type === "text_openai" &&
      String(p.baseUrl || "").trim() &&
      String(p.apiKey || "").trim() &&
      (Array.isArray(p.models) ? p.models : []).length,
  );
  let p =
    (cfg.chatProviderId &&
      textsFull.find(
        (x) => x.id === cfg.chatProviderId || x.name === cfg.chatProviderId,
      )) ||
    textsFull[0] ||
    null;
  if (!p) return null;
  const models = (Array.isArray(p.models) ? p.models : [])
    .map((m) => (typeof m === "string" ? m : m && m.id))
    .filter(Boolean)
    .map(String);
  const model =
    (cfg.chatModel && models.includes(String(cfg.chatModel))
      ? String(cfg.chatModel)
      : models[0]) || "deepseek-v4-flash";
  return { provider: p, model: String(model) };
}

function isDeepseekHost(baseUrl) {
  try {
    return new URL(baseUrl).hostname.toLowerCase().includes("deepseek");
  } catch {
    return false;
  }
}

function mtnodePiProvidersFromApp() {
  const out = [];
  const appCfg = readJson(appConfigPath(), {}) || {};
  const providers = Array.isArray(appCfg.providers) ? appCfg.providers : [];
  providers.forEach((p, i) => {
    if (!p || p.type !== "text_openai" || !String(p.apiKey || "").trim()) return;
    if (isDeepseekHost(p.baseUrl)) return;
    if (!String(p.baseUrl || "").trim() || !(p.models || []).length) return;
    out.push({
      route: p.id || "p" + (i + 1),
      name: p.name || p.id,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      api: p.api || "openai-completions",
      models: (p.models || [])
        .map((m) => (typeof m === "string" ? m : m && m.id))
        .filter(Boolean),
    });
  });
  return out;
}

function dshRouteForProvider(p) {
  if (!p) return "deepseek-official";
  if (isDeepseekHost(p.baseUrl)) return "deepseek-official";
  return "mtnode_" + String(p.id || "p");
}

function petWorkspaceDir(sessionIndex) {
  const i = Math.max(
    0,
    Math.min(CHAT_SLOT_COUNT - 1, Number(sessionIndex != null ? sessionIndex : chatSessionIndex) || 0),
  );
  return mk(join(petRoot(), "workspace-chat", "s" + i));
}

let petDshAdapter = null;
/** @type {Map<string, {acc:string, status:string, sessionIndex:number}>} */
const petDshRuns = new Map();

function findRunBySession(sessionIndex) {
  const idx = Number(sessionIndex);
  for (const [reqId, run] of petDshRuns) {
    if (run && run.sessionIndex === idx) return { reqId, run };
  }
  return null;
}

function sessionRunState(sessionIndex) {
  const hit = findRunBySession(sessionIndex);
  if (!hit) return { busy: false, status: "", streamingText: "" };
  return {
    busy: true,
    status: String(hit.run.status || ""),
    streamingText: String(hit.run.acc || ""),
  };
}

function appendAssistantToSession(sessionIndex, content) {
  const text = String(content || "");
  if (!text) return;
  const idx = Math.max(0, Math.min(CHAT_SLOT_COUNT - 1, Number(sessionIndex) || 0));
  if (idx === chatSessionIndex) {
    chatHistory.push({ role: "assistant", content: text });
    persistSessions();
    return;
  }
  const slots = readSessionSlots();
  slots[chatSessionIndex] = chatHistory.slice();
  const msgs = Array.isArray(slots[idx]) ? slots[idx].slice() : [];
  msgs.push({ role: "assistant", content: text });
  slots[idx] = msgs.slice(-40);
  writeJson(sessionsPath(), {
    slots,
    active: chatSessionIndex,
    at: Date.now(),
  });
}

function isActiveRun(reqId) {
  const run = petDshRuns.get(reqId);
  return !!(run && run.sessionIndex === chatSessionIndex);
}

function finalizeAbortedRun(reqId) {
  const run = petDshRuns.get(reqId);
  if (!run) return;
  petDshRuns.delete(reqId);
  const final = String(run.acc || "");
  if (final && !run.savedOnAbort) {
    appendAssistantToSession(run.sessionIndex, final);
    run.savedOnAbort = true;
  }
  if (run.sessionIndex === chatSessionIndex) {
    sendToChat("pet:chatStatus", { text: "" });
    sendToChat("pet:chatDone", { text: final, stopped: true });
  } else {
    sendToChat("pet:sessionsUpdated", { sessions: sessionSummaries() });
  }
}

async function handleChatStop() {
  const hit = findRunBySession(chatSessionIndex);
  if (!hit) return { ok: true, stopped: false };
  hit.run.aborted = true;
  const ws = hit.run.workspace || petWorkspaceDir(hit.run.sessionIndex);
  try {
    const dsh = ensurePetDsh();
    await dsh.ensureStarted();
    await dsh.cancel({ workspace: ws });
  } catch {}
  if (petDshRuns.has(hit.reqId)) finalizeAbortedRun(hit.reqId);
  return { ok: true, stopped: true };
}

function isWebToolName(name) {
  const n = String(name || "").toLowerCase();
  if (!n) return false;
  if (
    n === "web_search" ||
    n === "web_fetch" ||
    n === "web-search" ||
    n === "web-fetch" ||
    n.includes("web_search") ||
    n.includes("web-search") ||
    n.includes("web_fetch") ||
    n.includes("web-fetch")
  ) {
    return true;
  }
  if (/(^|[_-])(web|search)([_-]|$)/.test(n)) return true;
  if (n.includes("web") && !/(fs|file|bash|pwsh|shell|canvas|mtnode|write|read|edit|skill|job)/.test(n)) {
    return true;
  }
  return false;
}

function resolveDeepseekWebSearchKey() {
  const appCfg = readJson(appConfigPath(), {}) || {};
  const providers = Array.isArray(appCfg.providers) ? appCfg.providers : [];
  for (const p of providers) {
    if (!p || p.type !== "text_openai") continue;
    if (!String(p.apiKey || "").trim()) continue;
    if (!isDeepseekHost(p.baseUrl)) continue;
    return String(p.apiKey).trim();
  }
  return "";
}

function isForbiddenPetTool(name) {
  const n = String(name || "").toLowerCase();
  if (!n) return true;
  if (isWebToolName(n)) return false;
  /* 其它一律拒绝：文件/终端/画布/技能/任务等 */
  return true;
}

function ensurePetDsh() {
  if (petDshAdapter) return petDshAdapter;
  const { createDshAdapter } = require("../dsh/main-dsh.js");
  petDshAdapter = createDshAdapter({
    dataDir: petRoot(),
    errLog: (m) => console.error("[pet-dsh]", m),
    log: (m) => console.log("[pet-dsh]", m),
    onEvent: (ev) => onPetDshEvent(ev),
  });
  return petDshAdapter;
}

function onPetDshEvent(ev) {
  if (!ev || !ev.reqId) return;
  const run = petDshRuns.get(ev.reqId);
  if (!run) return;
  const type = ev.type;
  const data = ev.data || {};
  const active = isActiveRun(ev.reqId);

  if (type === "approval") {
    const toolName = data.toolName || data.name || "";
    const allow = isWebToolName(toolName) && !isForbiddenPetTool(toolName);
    try {
      ensurePetDsh().interact({
        kind: "approval",
        id: data.id,
        outcome: allow ? "allowed-once" : "rejected",
      });
    } catch {}
    if (!allow) return;
    run.status = "求助中…";
    if (active) sendToChat("pet:chatStatus", { text: run.status });
    return;
  }
  if (type === "question") {
    try {
      ensurePetDsh().interact({
        kind: "question",
        id: data.id,
        answers: {},
      });
    } catch {}
    return;
  }
  if (type === "reasoning") {
    /* 不展示思维链正文，仅状态 */
    run.status = "努力思考中…";
    if (active) sendToChat("pet:chatStatus", { text: run.status });
    return;
  }
  if (type === "tool") {
    run.status = "求助中…";
    if (active) sendToChat("pet:chatStatus", { text: run.status });
    return;
  }
  if (type === "text" && data.text) {
    run.acc += String(data.text);
    run.status = "";
    if (active) {
      sendToChat("pet:chatStatus", { text: "" });
      sendToChat("pet:chatDelta", { text: run.acc });
    }
    return;
  }
  if (type === "error") {
    if (run.aborted) {
      finalizeAbortedRun(ev.reqId);
      return;
    }
    const msg = String((data && data.message) || "未知错误");
    if (active) sendToChat("pet:chatError", { error: msg });
    petDshRuns.delete(ev.reqId);
    sendToChat("pet:sessionsUpdated", { sessions: sessionSummaries() });
    return;
  }
  if (type === "done") {
    if (run.aborted) {
      finalizeAbortedRun(ev.reqId);
      return;
    }
    const final =
      (data && data.finalResponse && String(data.finalResponse)) || run.acc || "";
    if (final) appendAssistantToSession(run.sessionIndex, final);
    petDshRuns.delete(ev.reqId);
    if (active) {
      if (final && !run.acc) {
        sendToChat("pet:chatDelta", { reset: true, text: final });
      } else if (final) {
        sendToChat("pet:chatDelta", { text: final });
      }
      sendToChat("pet:chatStatus", { text: "" });
      sendToChat("pet:chatDone", { text: final });
    } else {
      sendToChat("pet:sessionsUpdated", { sessions: sessionSummaries() });
    }
  }
}

function openPersonaDialog() {
  openPersonaEditor();
}

function openPersonaEditor() {
  syncRuntimeFromLocalPack();
  const htmlPath = join(runtimeDir(), "persona.html");
  const pos = rightSidePanelBounds(440, 420);
  const win = new BrowserWindow({
    width: pos.width,
    height: pos.height,
    x: pos.x,
    y: pos.y,
    parent: petWin || undefined,
    modal: false,
    frame: true,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    title: "角色设定",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: resolvePetPreload(),
    },
  });
  win.setMenu(null);
  win.setBounds(pos);
  if (fs.existsSync(htmlPath)) win.loadFile(htmlPath);
  else {
    win.loadURL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent(
          "<p style='padding:12px;font-family:sans-serif'>缺少 persona.html</p>",
        ),
    );
  }
  win.on("closed", () => {
    if (personaEditorWin === win) personaEditorWin = null;
  });
  personaEditorWin = win;
}

let personaEditorWin = null;

async function handleChatSend(text) {
  const t = String(text || "").trim();
  if (!t) return { ok: false, error: "empty" };
  if (findRunBySession(chatSessionIndex)) return { ok: false, error: "busy" };
  const cfg = loadConfig();
  const resolved = resolveChatProvider(cfg);
  if (!resolved || !String(resolved.provider.apiKey || "").trim()) {
    return {
      ok: false,
      error: "未配置可用的文本服务商 API Key。请在 MTNode 设置里填写后重试。",
    };
  }
  chatHistory.push({ role: "user", content: t });
  if (chatHistory.length > 24) chatHistory = chatHistory.slice(-24);
  persistSessions();

  const hist = chatHistory
    .slice(0, -1)
    .slice(-16)
    .map((m) => (m.role === "user" ? "用户：" : "助手：") + m.content)
    .join("\n\n");
  const input = hist ? hist + "\n\n用户(最新)：" + t : t;
  /* 身份写入 dsh 真正的 system-prompt,而不是用户消息里的「系统设定」 */
  const hostPersona = [
    "你是「" + cfg.personaName + "」，独立的桌面聊天伙伴。",
    "你不是 MTNode 工作流助手，也不在画布里工作；不要自称 MTNode 助手。",
    effectivePersonaPrompt(cfg),
    "【能力】你可以联网搜索获取信息。不要读写本地文件、不要执行终端或命令、不要操作画布或其它应用数据。需要查资料时使用搜索工具。",
  ].join("\n");

  const piProvs = mtnodePiProvidersFromApp();
  const providerRoute = dshRouteForProvider(resolved.provider);
  let apiKey = resolved.provider.apiKey;
  let baseUrl = resolved.provider.baseUrl;
  if (providerRoute !== "deepseek-official") {
    const mp = piProvs.find((x) => "mtnode_" + x.route === providerRoute);
    if (mp) {
      apiKey = mp.apiKey;
      baseUrl = mp.baseUrl;
    }
  }
  /* 联网搜索固定走 DeepSeek 官方 Key（与主程序智能会话一致） */
  const webSearchApiKey =
    resolveDeepseekWebSearchKey() ||
    (providerRoute === "deepseek-official" ? String(apiKey || "").trim() : "");

  const reqId = "pet_" + Date.now().toString(36) + "_" + crypto.randomBytes(3).toString("hex");
  const sessionIndex = chatSessionIndex;
  const workspace = petWorkspaceDir(sessionIndex);
  petDshRuns.set(reqId, {
    acc: "",
    status: "努力思考中…",
    sessionIndex,
    workspace,
  });
  sendToChat("pet:chatStatus", { text: "努力思考中…" });
  sendToChat("pet:chatDelta", { reset: true, text: "" });

  try {
    const dsh = ensurePetDsh();
    await dsh.ensureStarted();
    await dsh.run({
      reqId,
      workspace,
      input,
      model: resolved.model,
      maxTokens: 8192,
      apiKey,
      baseUrl,
      webSearchApiKey,
      hostPersona,
      preset: "bongochat",
      effort: "high",
      provider: providerRoute,
      mtnodeProviders: piProvs,
      permissionPreset: "bongochat",
    });
    return { ok: true, streaming: true, reqId };
  } catch (err) {
    const m = String((err && err.message) || err);
    petDshRuns.delete(reqId);
    sendToChat("pet:chatError", { error: m });
    return { ok: false, error: m };
  }
}

function toggleChatWindow(forceOpen) {
  if (chatWin && !chatWin.isDestroyed()) {
    if (forceOpen === true) {
      showChatWindowSafe();
      return;
    }
    if (forceOpen === false || chatWin.isVisible()) {
      chatWin.hide();
      return;
    }
    showChatWindowSafe();
    return;
  }
  createChatWindow();
}

function resolvePetPreload() {
  const candidates = [
    join(petRoot(), "preload-pet.js"),
    join(__dirname, "preload-pet.js"),
  ];
  if (typeof process.resourcesPath === "string" && process.resourcesPath) {
    candidates.unshift(join(process.resourcesPath, "pet-pack", "preload-pet.js"));
  }
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return join(__dirname, "preload-pet.js");
}

/** 把最新 preload 同步到数据目录（优先 pet-pack，避免 asar 旧副本覆盖） */
function syncPetPreload() {
  const candidates = [];
  if (typeof process.resourcesPath === "string" && process.resourcesPath) {
    candidates.push(join(process.resourcesPath, "pet-pack", "preload-pet.js"));
  }
  candidates.push(join(__dirname, "..", "pet-pack", "preload-pet.js"));
  candidates.push(join(__dirname, "preload-pet.js"));
  let src = "";
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      src = p;
      break;
    }
  }
  if (!src) return;
  try {
    fs.copyFileSync(src, join(petRoot(), "preload-pet.js"));
  } catch {}
}

function placeChatWindowRight() {
  if (!chatWin || chatWin.isDestroyed()) return;
  const b = chatWin.getBounds();
  const pos = rightSidePanelBounds(b.width || 360, b.height || 480);
  try {
    chatWin.setBounds(pos);
  } catch {}
}

function showChatWindowSafe() {
  if (!chatWin || chatWin.isDestroyed()) return;
  try {
    /* 每次显示都放到屏幕右侧靠边界，避免沿用旧位置或跟在桌宠旁 */
    placeChatWindowRight();
    chatWin.show();
    chatWin.focus();
    chatWin.moveTop();
  } catch {}
}

function resolveChatHtml() {
  const bundled = join(__dirname, "chat-ui", "chat.html");
  const bundledJs = join(__dirname, "chat-ui", "chat.js");
  const dest = runtimeDir();
  mk(dest);
  const packCandidates = [
    join(__dirname, "chat-ui"),
    join(__dirname, "..", "pet-pack"),
  ];
  if (typeof process.resourcesPath === "string" && process.resourcesPath) {
    packCandidates.push(join(process.resourcesPath, "pet-pack"));
  }
  let srcDir = "";
  for (const p of packCandidates) {
    if (fs.existsSync(join(p, "chat.html")) && fs.existsSync(join(p, "chat.js"))) {
      srcDir = p;
      break;
    }
  }
  if (srcDir) {
    try {
      fs.copyFileSync(join(srcDir, "chat.html"), join(dest, "chat.html"));
      fs.copyFileSync(join(srcDir, "chat.js"), join(dest, "chat.js"));
      const markedSrc = join(srcDir, "vendor", "marked.min.js");
      if (fs.existsSync(markedSrc)) {
        mk(join(dest, "vendor"));
        fs.copyFileSync(markedSrc, join(dest, "vendor", "marked.min.js"));
      }
    } catch {}
  }
  /* 始终从 runtime 加载，避免 asar 内旧 chat-ui 挡住 pet-pack/runtime 更新 */
  const runtimeHtml = join(dest, "chat.html");
  if (fs.existsSync(runtimeHtml) && fs.existsSync(join(dest, "chat.js"))) {
    return runtimeHtml;
  }
  if (fs.existsSync(bundled) && fs.existsSync(bundledJs)) return bundled;
  return runtimeHtml;
}

function createChatWindow() {
  if (chatWin && !chatWin.isDestroyed()) {
    showChatWindowSafe();
    return;
  }
  syncPetPreload();
  const chatW = 360;
  const chatH = 480;
  const pos = rightSidePanelBounds(chatW, chatH);
  chatWin = new BrowserWindow({
    width: pos.width,
    height: pos.height,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    show: false,
    webPreferences: {
      preload: resolvePetPreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
    },
  });
  chatWin.setMenu(null);
  chatWin.setAlwaysOnTop(true, "screen-saver");
  chatWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(String(url || ""))) {
      try {
        shell.openExternal(String(url));
      } catch {}
    }
    return { action: "deny" };
  });
  chatWin.webContents.on("will-navigate", (ev, url) => {
    if (url && url !== chatWin.getURL()) ev.preventDefault();
  });
  const chatHtml = resolveChatHtml();
  if (fs.existsSync(chatHtml)) chatWin.loadFile(chatHtml);
  else {
    chatWin.loadURL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent(
          "<p style='padding:12px;font-family:sans-serif'>缺少 chat.html，请更新桌宠运行时。</p>",
        ),
    );
  }
  /* 透明窗 ready-to-show 偶发不触发，双通道确保显示 */
  chatWin.once("ready-to-show", showChatWindowSafe);
  chatWin.webContents.once("did-finish-load", () => {
    setTimeout(showChatWindowSafe, 30);
  });
  chatWin.webContents.on("context-menu", (ev) => ev.preventDefault());
  chatWin.on("closed", () => {
    chatWin = null;
  });
}

function httpJson(url, opts, bodyBuf) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: opts.method || "POST",
        headers: opts.headers || {},
        timeout: 120000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          resolve({ status: res.statusCode || 0, body: buf.toString("utf8") });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

function sendToChat(channel, data) {
  try {
    if (chatWin && !chatWin.isDestroyed()) chatWin.webContents.send(channel, data);
  } catch {}
}

/** 开发态或安装包内 pet-pack 存在时，同步关键运行时文件（对话页、拖拽修复等） */
function syncRuntimeFromLocalPack() {
  const candidates = [join(__dirname, "..", "pet-pack")];
  if (typeof process.resourcesPath === "string" && process.resourcesPath) {
    candidates.push(join(process.resourcesPath, "pet-pack"));
  }
  let src = "";
  for (const p of candidates) {
    if (fs.existsSync(join(p, "index.html"))) {
      src = p;
      break;
    }
  }
  if (!src) return;
  const dest = runtimeDir();
  mk(dest);
  const files = [
    "app.js",
    "index.html",
    "style.css",
    "chat.html",
    "chat.js",
    "persona.html",
    "manifest.json",
    "live2d.bundle.js",
  ];
  for (const name of files) {
    const s = join(src, name);
    const d = join(dest, name);
    if (!fs.existsSync(s)) continue;
    try {
      fs.copyFileSync(s, d);
    } catch {}
  }
  const markedSrc = join(src, "vendor", "marked.min.js");
  const markedDestDir = join(dest, "vendor");
  if (fs.existsSync(markedSrc)) {
    try {
      mk(markedDestDir);
      fs.copyFileSync(markedSrc, join(markedDestDir, "marked.min.js"));
    } catch {}
  }
}

function createPetWindow() {
  syncRuntimeFromLocalPack();
  syncPetPreload();
  if (!fs.existsSync(join(runtimeDir(), "index.html"))) {
    dialog.showErrorBox(
      "BongoChat",
      "未找到 BongoChat 运行时。请先在 MTNode「插件」中下载安装。",
    );
    app.quit();
    return;
  }
  ensureBundledModels();
  const cfg = loadConfig();
  const sz = scaledSize(cfg);
  const pos = resolvePetOpenBounds(cfg, sz);
  /* 持久化桌宠位置（默认右下角；用户拖过则保留） */
  writeJson(configPath(), Object.assign({}, cfg, { x: pos.x, y: pos.y }));

  petWin = new BrowserWindow({
    width: pos.width,
    height: pos.height,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    alwaysOnTop: !!cfg.alwaysOnTop,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: resolvePetPreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
    },
  });
  petWin.setMenu(null);
  if (cfg.alwaysOnTop) petWin.setAlwaysOnTop(true, "screen-saver");
  petWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  petWin.setOpacity(Math.max(0.4, cfg.opacity / 100));
  /* 强制可交互：不再启用穿透 */
  petWin.setIgnoreMouseEvents(false);

  /* 彻底禁止右键弹出任何菜单（含系统/Chromium 菜单） */
  petWin.webContents.on("context-menu", (ev) => {
    ev.preventDefault();
  });
  petWin.webContents.on("before-input-event", (ev, input) => {
    if (input.type === "keyDown" && input.key === "F10") ev.preventDefault();
  });

  petWin.loadFile(join(runtimeDir(), "index.html"));
  petWin.once("ready-to-show", () => {
    if (!petWin || petWin.isDestroyed()) return;
    petWin.show();
    petWin.focus();
    pushPetState(loadConfig());
  });
  petWin.webContents.on("did-finish-load", () => pushPetState(loadConfig()));
  /* 拖拽中不写盘：频繁 moved→fs.watch→applyWindowChrome 会放大透明窗 */
  petWin.on("moved", () => {
    if (dragOffset) return;
    persistPos();
  });
  petWin.on("closed", () => {
    petWin = null;
    if (chatWin && !chatWin.isDestroyed()) {
      try {
        chatWin.close();
      } catch {}
    }
    app.quit();
  });

  startDeviceHook();
  ensureTray();
}

function registerIpc() {
  ipcMain.handle("pet:stop", () => {
    app.quit();
    return { ok: true };
  });
  ipcMain.handle("pet:status", () => ({
    ok: true,
    running: true,
    standalone: true,
    hook: hookStarted,
  }));
  ipcMain.handle("pet:getConfig", () => ({ ok: true, config: configForRenderer() }));
  ipcMain.handle("pet:setConfig", (_e, partial) => {
    const patch = partial || {};
    /* 渲染层不得写入内置默认人设正文 */
    if ("personaPrompt" in patch) delete patch.personaPrompt;
    const next = saveConfig(patch);
    applyWindowChrome(next);
    if (petTray) petTray.setContextMenu(buildPetMenu());
    return { ok: true, config: configForRenderer() };
  });
  ipcMain.handle("pet:getState", () => ({
    ok: true,
    config: loadConfig(),
    skin: skinPayload(loadConfig()),
    hook: hookStarted,
    standalone: true,
  }));
  ipcMain.handle("pet:popupMenu", () => {
    popupPetMenu();
    return { ok: true };
  });
  ipcMain.handle("pet:openChat", () => {
    toggleChatWindow(true);
    return { ok: true };
  });
  ipcMain.handle("pet:toggleChat", () => {
    toggleChatWindow();
    return { ok: true };
  });
  ipcMain.handle("pet:chatSend", async (_e, text) => handleChatSend(text));
  ipcMain.handle("pet:chatStop", () => handleChatStop());
  ipcMain.handle("pet:chatClear", () => clearCurrentSession());
  ipcMain.handle("pet:chatHistory", () => {
    hydrateChatFromDisk();
    const runState = sessionRunState(chatSessionIndex);
    return {
      ok: true,
      messages: chatHistory.slice(),
      sessions: sessionSummaries(),
      index: chatSessionIndex,
      busy: runState.busy,
      status: runState.status,
      streamingText: runState.streamingText,
    };
  });
  ipcMain.handle("pet:listSessions", () => ({
    ok: true,
    sessions: sessionSummaries(),
    index: chatSessionIndex,
    ...sessionRunState(chatSessionIndex),
  }));
  ipcMain.handle("pet:switchSession", (_e, index) => switchChatSession(index));
  ipcMain.handle("pet:listProviders", () => {
    const cfg = loadConfig();
    return {
      ok: true,
      providers: listTextProviders(),
      chatProviderId: cfg.chatProviderId || "",
      chatModel: cfg.chatModel || "",
    };
  });
  ipcMain.handle("pet:closePersonaEditor", () => {
    if (personaEditorWin && !personaEditorWin.isDestroyed()) {
      try {
        personaEditorWin.close();
      } catch {}
    }
    personaEditorWin = null;
    return { ok: true };
  });
  ipcMain.handle("pet:dragStart", (_e, screenX, screenY) => {
    if (!petWin || petWin.isDestroyed()) return { ok: false };
    const b = petWin.getBounds();
    const sz = scaledSize(loadConfig());
    /* 拖拽开始时锁定设计尺寸，避免 Windows 透明窗在 setPosition 时漂移放大 */
    dragOffset = {
      x: Number(screenX) - b.x,
      y: Number(screenY) - b.y,
      width: sz.width,
      height: sz.height,
    };
    if (Math.abs(b.width - sz.width) > 1 || Math.abs(b.height - sz.height) > 1) {
      petWin.setBounds({ x: b.x, y: b.y, width: sz.width, height: sz.height });
    }
    return { ok: true };
  });
  ipcMain.handle("pet:dragMove", (_e, screenX, screenY) => {
    if (!petWin || petWin.isDestroyed() || !dragOffset) return { ok: false };
    /* 仅移动位置，避免 Windows 透明窗反复 setBounds 导致尺寸逐渐增大 */
    petWin.setPosition(
      Math.round(Number(screenX) - dragOffset.x),
      Math.round(Number(screenY) - dragOffset.y),
    );
    return { ok: true };
  });
  ipcMain.handle("pet:dragEnd", () => {
    if (petWin && !petWin.isDestroyed() && dragOffset) {
      const b = petWin.getBounds();
      const w = dragOffset.width;
      const h = dragOffset.height;
      /* 结束时校正尺寸；位置用当前值，避免再触发一次位移放大 */
      if (Math.abs(b.width - w) > 1 || Math.abs(b.height - h) > 1) {
        petWin.setBounds({ x: b.x, y: b.y, width: w, height: h });
      }
    }
    dragOffset = null;
    persistPos();
    return { ok: true };
  });
  ipcMain.handle("pet:listSkins", () => ({ ok: true, skins: listSkins() }));
  ipcMain.handle("pet:setSkin", (_e, id) => {
    const next = saveConfig({ skinId: String(id || "bongocat-standard") });
    pushPetState(next);
    return { ok: true, config: next, skins: listSkins() };
  });
}

function watchParent() {
  const parentPid = Number(process.env.MTNODE_PARENT_PID || 0);
  if (!parentPid) return;
  parentWatch = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      app.quit();
    }
  }, 1500);
}

/** 主程序改配置时热更新；忽略仅坐标写入，避免拖拽触发尺寸抖动 */
function watchSharedConfig() {
  let lastScale = null;
  let lastOpacity = null;
  let lastPen = null;
  let lastTop = null;
  let lastSkin = null;
  let lastMirror = null;
  let timer = null;
  try {
    const cfg0 = loadConfig();
    lastScale = cfg0.scale;
    lastOpacity = cfg0.opacity;
    lastPen = !!cfg0.penetrable;
    lastTop = !!cfg0.alwaysOnTop;
    lastSkin = cfg0.skinId;
    lastMirror = !!cfg0.mirror;
    fs.watch(configPath(), { persistent: false }, () => {
      if (dragOffset) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (dragOffset) return;
        try {
          const next = loadConfig();
          const chromeChanged =
            next.scale !== lastScale ||
            next.opacity !== lastOpacity ||
            !!next.penetrable !== lastPen ||
            !!next.alwaysOnTop !== lastTop;
          const lookChanged =
            next.skinId !== lastSkin || !!next.mirror !== lastMirror;
          lastScale = next.scale;
          lastOpacity = next.opacity;
          lastPen = !!next.penetrable;
          lastTop = !!next.alwaysOnTop;
          lastSkin = next.skinId;
          lastMirror = !!next.mirror;
          if (chromeChanged) applyWindowChrome(next);
          else if (lookChanged) pushPetState(next);
          if (petTray && (chromeChanged || lookChanged)) {
            petTray.setContextMenu(buildPetMenu());
          }
        } catch {}
      }, 80);
    });
  } catch {}
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  registerIpc();
  watchParent();
  watchSharedConfig();
  hydrateChatFromDisk();
  createPetWindow();
  writeJson(join(petRoot(), "pet-pid.json"), {
    pid: process.pid,
    parentPid: Number(process.env.MTNODE_PARENT_PID || 0) || null,
    at: Date.now(),
    role: "standalone",
  });
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  if (parentWatch) clearInterval(parentWatch);
  stopDeviceHook();
  if (petDshAdapter) {
    try {
      petDshAdapter.shutdown();
    } catch {}
    petDshAdapter = null;
  }
  if (petTray) {
    try {
      petTray.destroy();
    } catch {}
    petTray = null;
  }
  try {
    fs.unlinkSync(join(petRoot(), "pet-pid.json"));
  } catch {}
});
