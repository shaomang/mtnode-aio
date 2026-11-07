"use strict";
/* mini-chat-window.js — 快捷会话小窗（独立窗口 · 唯一 · 左下角入口 + 全局 F1）。
 *
 * 为什么单独一只文件：main.js 已经九千多行，这只窗有自己的一整套状态
 * （窗口唯一性 / 位置记忆 / 全局热键 / 与主窗渲染层的中继请求），挤进主进程正文只会让
 * before-quit 那套收尾更难读。本文件不 require 任何项目模块（electron 对象由 main.js 注入），
 * 因此可以单独在沙箱里跑单测桩。
 *
 * 口径（与用户共识一一对应，见本轮需求）：
 *   · 真·独立系统窗口：可拖到主窗口外，alwaysOnTop + skipTaskbar（像一只悬浮小工具）；
 *   · unique：全局只允许一只 —— 已存在就复用（移动 + 聚焦），绝不开第二只；
 *   · 全局 F1：每次按下都把窗口中心移到鼠标指针坐标（自动夹进所在显示器工作区）并聚焦，
 *     已开着也只移动不收起；F1 同时是小窗唯一的系统级入口（听写的按键转录因此改到 F3）；
 *   · 关闭：窗内 ✕ / Esc = 销毁窗口，尺寸与位置记忆到用户数据目录（不落应用文件夹）；
 *   · 主窗口关闭 → 本窗一起关（不留孤儿窗口）；
 *   · **不做任何 agent 逻辑**：会话列表 / 发指令 / 读最后回复 / 停止 / 跳转全部中继给
 *     主窗口渲染层（agent 运行态只在渲染层，主进程只持有 session:* 存储 IPC），
 *     中继协议见 renderer/app-mini-chat-host.js 文件头。
 */

const fs = require("fs");
const path = require("path");

/* 中继请求的超时：主窗渲染层忙（长任务里同步渲染大页面）时也别把小窗卡死，
 * 超时按「主窗口无响应」回给小窗，用户再点一次即可。 */
const RELAY_TIMEOUT_MS = 8000;
const DEFAULT_W = 384;
const DEFAULT_H = 560;
const MIN_W = 320;
const MIN_H = 380;

function createMiniChat(opts) {
  const o = opts || {};
  const app = o.app;
  const BrowserWindow = o.BrowserWindow;
  const ipcMain = o.ipcMain;
  const screen = o.screen;
  const globalShortcut = o.globalShortcut;
  /* shell 只给「正文里的链接交系统浏览器打开」这一件事用（见 minichat:openExternal） */
  const shell = o.shell || null;
  const getMainWin = typeof o.getMainWin === "function" ? o.getMainWin : () => null;
  const iconPath = String(o.iconPath || "");
  const htmlPath = String(o.htmlPath || "");
  const preloadPath = String(o.preloadPath || "");
  const storePath = String(o.storePath || "");
  const t = typeof o.t === "function" ? o.t : (s) => s;
  /* 迷你窗自己的界面词条：键 = 小窗用的稳定 id，值 = 已本地化的文案。
     只有这里一处产出，页面拿到的就是成品字符串（页面不做语言判断）。 */
  const i18nDict = typeof o.i18nDict === "function" ? o.i18nDict : () => ({});
  const log = typeof o.log === "function" ? o.log : () => {};

  let win = null;
  let seq = 0;
  const pending = new Map();
  let hotkeyOk = false;
  let saveTimer = null;

  /* ── 位置记忆（用户数据目录，不落应用文件夹）────────────────────────── */
  function readStore() {
    try {
      const got = JSON.parse(fs.readFileSync(storePath, "utf8"));
      return got && typeof got === "object" ? got : {};
    } catch (_) {
      return {};
    }
  }
  function writeStore(patch) {
    try {
      const cur = readStore();
      const next = Object.assign({}, cur, patch || {});
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(storePath, JSON.stringify(next, null, 2), "utf8");
    } catch (e) {
      log("[minichat] 位置记忆写入失败：" + ((e && e.message) || e));
    }
  }
  function persistBounds() {
    if (!win || win.isDestroyed()) return;
    try {
      const b = win.getBounds();
      writeStore({ width: b.width, height: b.height, x: b.x, y: b.y });
    } catch (_) {}
  }
  function queuePersistBounds() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      persistBounds();
    }, 400);
  }

  /* ── 输入框上方那两枚模式开关（本轮需求）────────────────────────────────
     口径（共识 q4 / q5 / q7）：**整个小窗共用一份**记忆，随这份 JSON 落盘（重启仍生效）；
     缺省「不拷问需求 + 热修开」；两枚互斥（开热修自动关拷问，反之亦然）。
     它们只作用于小窗发出的那一轮 —— 由渲染层按轮覆写传给 agentSessionSend，
     这一层只管存与读，不碰任何会话字段。 */
  const MODE_DEFAULT = { grill: false, hotfix: true };
  function readModes() {
    const got = readStore();
    const grill = typeof got.grill === "boolean" ? got.grill : MODE_DEFAULT.grill;
    const hotfix = typeof got.hotfix === "boolean" ? got.hotfix : MODE_DEFAULT.hotfix;
    /* 老存档 / 手改文件里两枚都为真：按热修优先归一（与渲染层的互斥兜底同一口径） */
    return { grill: hotfix ? false : grill, hotfix };
  }
  function writeModes(patch) {
    const cur = readModes();
    const p = patch || {};
    let grill = typeof p.grill === "boolean" ? p.grill : cur.grill;
    let hotfix = typeof p.hotfix === "boolean" ? p.hotfix : cur.hotfix;
    /* 互斥：调用方（小窗）本来就点一枚关一枚，这里是硬兜底 */
    if (grill && hotfix) {
      if (typeof p.hotfix === "boolean") grill = false;
      else hotfix = false;
    }
    writeStore({ grill, hotfix });
    return { grill, hotfix };
  }

  /* ── 位置：默认贴主窗右下角附近；夹进所在显示器的工作区 ──────────────── */
  function clampToWorkArea(cx, cy, w, h) {
    let wa = null;
    try {
      const pt = { x: Math.round(cx), y: Math.round(cy) };
      const d = screen.getDisplayNearestPoint(pt);
      wa = d && d.workArea;
    } catch (_) {}
    let x = Math.round(cx - w / 2);
    let y = Math.round(cy - h / 2);
    if (wa) {
      const pad = 8;
      x = Math.min(Math.max(x, wa.x + pad), wa.x + wa.width - w - pad);
      y = Math.min(Math.max(y, wa.y + pad), wa.y + wa.height - h - pad);
    }
    return { x, y };
  }
  function defaultPoint() {
    const mw = getMainWin();
    try {
      if (mw && !mw.isDestroyed()) {
        const b = mw.getBounds();
        return { x: b.x + b.width - 240, y: b.y + b.height - 260 };
      }
    } catch (_) {}
    try {
      const d = screen.getPrimaryDisplay();
      const wa = d.workArea;
      return { x: wa.x + wa.width - 260, y: wa.y + wa.height - 300 };
    } catch (_) {}
    return { x: 900, y: 500 };
  }
  function cursorPoint() {
    try {
      const pt = screen.getCursorScreenPoint();
      return { x: pt.x, y: pt.y };
    } catch (_) {
      return defaultPoint();
    }
  }

  /* ── 主窗渲染层中继 ──────────────────────────────────────────────────── */
  function mainReady() {
    const w = getMainWin();
    return !!(w && !w.isDestroyed() && w.webContents);
  }
  function relay(op, args) {
    if (!mainReady()) return Promise.resolve({ ok: false, error: "main_not_ready" });
    const rid = ++seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(rid);
        resolve({ ok: false, error: "timeout" });
      }, RELAY_TIMEOUT_MS);
      pending.set(rid, (msg) => {
        try {
          clearTimeout(timer);
        } catch (_) {}
        resolve(msg || { ok: false, error: "empty" });
      });
      try {
        getMainWin().webContents.send("minichat:req", { rid, op, args: args || {} });
      } catch (e) {
        pending.delete(rid);
        clearTimeout(timer);
        resolve({ ok: false, error: "send_failed" });
      }
    });
  }
  /* 主窗 → 小窗的推送（会话列表 / 最后回复 / 运行态） */
  function pushToWin(payload) {
    if (!win || win.isDestroyed()) return;
    try {
      win.webContents.send("minichat:push", payload || {});
    } catch (_) {}
  }
  function tellVisibility(open) {
    const w = getMainWin();
    if (!w || w.isDestroyed() || !w.webContents) return;
    try {
      w.webContents.send("minichat:visibility", { open: !!open });
    } catch (_) {}
  }

  /* ── 窗口 ────────────────────────────────────────────────────────────── */
  function createWin(bounds) {
    const saved = readStore();
    const bw = Math.max(MIN_W, Number(bounds && bounds.width) || Number(saved.width) || DEFAULT_W);
    const bh = Math.max(MIN_H, Number(bounds && bounds.height) || Number(saved.height) || DEFAULT_H);
    const w = new BrowserWindow({
      width: bw,
      height: bh,
      x: bounds && Number.isFinite(bounds.x) ? bounds.x : undefined,
      y: bounds && Number.isFinite(bounds.y) ? bounds.y : undefined,
      minWidth: MIN_W,
      minHeight: MIN_H,
      resizable: true,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      title: t("快捷会话"),
      icon: iconPath || undefined,
      backgroundColor: "#0d1016",
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        spellcheck: false,
      },
    });
    try {
      w.setMenu(null);
    } catch (_) {}
    /* 正文里的链接由渲染层拦下交系统浏览器（minichat:openExternal）；这里再兜一层：
       这只窗永远离不开本页 —— 既不改地址、也不弹新窗。 */
    try {
      if (w.webContents && typeof w.webContents.on === "function")
        w.webContents.on("will-navigate", (ev) => {
          if (ev && ev.preventDefault) ev.preventDefault();
        });
      if (w.webContents && typeof w.webContents.setWindowOpenHandler === "function")
        w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    } catch (_) {}
    w.once("ready-to-show", () => {
      if (!w.isDestroyed()) w.show();
    });
    w.on("closed", () => {
      if (win === w) win = null;
      pending.clear();
      tellVisibility(false);
    });
    w.on("moved", queuePersistBounds);
    w.on("resized", queuePersistBounds);
    w.loadFile(htmlPath).catch((e) => log("[minichat] loadFile 失败：" + ((e && e.message) || e)));
    return w;
  }

  /* 呼出：at = "cursor"（F1，窗口中心对齐鼠标）| "saved"（入口按钮，用记忆位置） */
  function show(at) {
    const pt = at === "cursor" ? cursorPoint() : null;
    if (win && !win.isDestroyed()) {
      if (pt) {
        const b = win.getBounds();
        const pos = clampToWorkArea(pt.x, pt.y, b.width, b.height);
        try {
          win.setPosition(pos.x, pos.y);
        } catch (_) {}
        queuePersistBounds();
      }
      try {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      } catch (_) {}
      tellVisibility(true);
      return { ok: true, reused: true };
    }
    let bounds = null;
    if (pt) {
      const saved = readStore();
      const w = Math.max(MIN_W, Number(saved.width) || DEFAULT_W);
      const h = Math.max(MIN_H, Number(saved.height) || DEFAULT_H);
      bounds = Object.assign({ width: w, height: h }, clampToWorkArea(pt.x, pt.y, w, h));
    } else {
      const saved = readStore();
      const w = Math.max(MIN_W, Number(saved.width) || DEFAULT_W);
      const h = Math.max(MIN_H, Number(saved.height) || DEFAULT_H);
      if (Number.isFinite(Number(saved.x)) && Number.isFinite(Number(saved.y))) {
        const pos = clampToWorkArea(Number(saved.x) + w / 2, Number(saved.y) + h / 2, w, h);
        bounds = { width: w, height: h, x: pos.x, y: pos.y };
      } else {
        const d = defaultPoint();
        bounds = Object.assign({ width: w, height: h }, clampToWorkArea(d.x, d.y, w, h));
      }
    }
    win = createWin(bounds);
    tellVisibility(true);
    return { ok: true, reused: false };
  }

  function close() {
    /* 关窗前先把尺寸 / 位置落盘（窗口一关就取不到 bounds 了） */
    persistBounds();
    if (!win || win.isDestroyed()) return { ok: true };
    try {
      win.close();
    } catch (_) {}
    return { ok: true };
  }

  function destroy() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    persistBounds();
    if (!win || win.isDestroyed()) return;
    try {
      win.destroy();
    } catch (_) {}
    win = null;
  }

  /* ── 全局热键（F1）：注册失败不崩，如实回一份状态给小窗与设置文案 ─────── */
  function registerHotkey() {
    try {
      hotkeyOk = !!globalShortcut.register("F1", () => {
        try {
          show("cursor");
        } catch (e) {
          log("[minichat] F1 呼出失败：" + ((e && e.message) || e));
        }
      });
    } catch (e) {
      hotkeyOk = false;
      log("[minichat] F1 注册异常：" + ((e && e.message) || e));
    }
    if (!hotkeyOk) log("[minichat] F1 全局热键被占用，未能注册（入口按钮仍可用）");
    return hotkeyOk;
  }

  /* ── IPC ─────────────────────────────────────────────────────────────── */
  function register() {
    /* 热键与 IPC 一起挂上：调用方只需要 register() 一个入口（重复注册会抢不到 F1） */
    registerHotkey();
    ipcMain.handle("minichat:open", () => show("saved"));
    ipcMain.handle("minichat:showAtCursor", () => show("cursor"));
    ipcMain.handle("minichat:close", () => close());
    ipcMain.handle("minichat:hotkey", () => ({ ok: hotkeyOk, accelerator: "F1" }));
    /* 正文里的 Markdown 链接：只放行 http(s) / mailto（渲染层已经拦过一道，这里是硬白名单），
       其余（file: / javascript: / 自定义协议 / 相对路径）一律拒绝并如实回报。 */
    ipcMain.handle("minichat:openExternal", (e, url) => {
      const u = String(url || "").trim();
      if (!/^(https?:\/\/|mailto:)/i.test(u)) return { ok: false, error: "blocked" };
      if (!shell || typeof shell.openExternal !== "function") return { ok: false, error: "unsupported" };
      try {
        shell.openExternal(u);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
    });
    ipcMain.handle("minichat:i18n", () => ({ dict: i18nDict() }));
    /* 两枚模式开关：读 / 写（写会落盘，重启仍生效） */
    ipcMain.handle("minichat:modes", () => readModes());
    ipcMain.handle("minichat:setModes", (e, patch) => writeModes(patch));
    ipcMain.handle("minichat:state", () => relay("state", {}));
    ipcMain.handle("minichat:select", (e, id) => relay("select", { id: String(id || "") }));
    ipcMain.handle("minichat:newSession", () => relay("newSession", {}));
    ipcMain.handle("minichat:send", (e, payload) => {
      const out = {
        sessionId: String((payload && payload.sessionId) || ""),
        text: String((payload && payload.text) || ""),
      };
      /* 这一轮的模式（本轮需求）：只带布尔，除此之外的值一律不传 */
      if (payload && typeof payload.grill === "boolean") out.grill = payload.grill;
      if (payload && typeof payload.hotfix === "boolean") out.hotfix = payload.hotfix;
      return relay("send", out);
    });
    ipcMain.handle("minichat:stop", (e, id) => relay("stop", { id: String(id || "") }));
    /* 跳主窗：先让主窗自己切好会话，再收掉小窗（共识 q13） */
    ipcMain.handle("minichat:gotoSession", async (e, id) => {
      const sid = String(id || "");
      const mw = getMainWin();
      if (mw && !mw.isDestroyed()) {
        try {
          if (mw.isMinimized()) mw.restore();
          mw.show();
          mw.focus();
        } catch (_) {}
      }
      const r = await relay("goto", { id: sid });
      close();
      return r;
    });
    ipcMain.on("minichat:res", (e, msg) => {
      const rid = msg && msg.rid;
      const p = rid && pending.get(rid);
      if (!p) return;
      pending.delete(rid);
      p(msg);
    });
    ipcMain.on("minichat:push", (e, payload) => pushToWin(payload));
    return true;
  }

  function shutdown() {
    try {
      globalShortcut.unregister("F1");
    } catch (_) {}
    destroy();
  }

  return { register, registerHotkey, show, close, destroy, shutdown, relay };
}

module.exports = { createMiniChat };
