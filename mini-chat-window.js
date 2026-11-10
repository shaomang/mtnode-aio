"use strict";
/* mini-chat-window.js — 快捷会话小窗（独立窗口 · 唯一 · 左下角入口 + 窗内 F1）。
 *
 * 为什么单独一只文件：main.js 已经九千多行，这只窗有自己的一整套状态
 * （窗口唯一性 / 位置记忆 / 开关 IPC / 与主窗渲染层的中继请求），挤进主进程正文只会让
 * before-quit 那套收尾更难读。本文件不 require 任何项目模块（electron 对象由 main.js 注入），
 * 因此可以单独在沙箱里跑单测桩。
 *
 * 口径（与用户共识一一对应，见本轮需求）：
 *   · 真·独立系统窗口：可拖到主窗口外，alwaysOnTop + skipTaskbar（像一只悬浮小工具）；
 *   · unique：全局只允许一只 —— 已存在就复用（移动 + 聚焦），绝不开第二只；
 *   · 开关是**窗内 F1**（本轮改口径：原来注册 globalShortcut 全局抢 F1，现在不抢了）：
 *     开着就关上（与 ✕ 同一条路径），没开就按当前鼠标指针坐标开出来（自动夹进所在显示器
 *     工作区）并聚焦 —— 判键与派发在主窗渲染层 renderer/app-status-keys.js，本文件只提供
 *     minichat:toggle 这一个动作；
 *   · 关闭：窗内 ✕ / Esc = 销毁窗口，尺寸与位置记忆到用户数据目录（不落应用文件夹）；
 *   · **唤回**（本次修复）：主进程另记一位 wantOpen（用户想让它开着），F1 只在
 *     「真的看得见 + 没最小化 + 没被甩出屏幕」时才是「关」，否则一律走唤回（restore →
 *     夹回屏幕 → 显示 → 置顶 → 抬到最前 → 聚焦）。用户报的「截完图小窗整只不见了、
 *     F1 也呼不回来、按钮却还亮着」就是这条：窗口对象还在，按 F1 却走了「关」；
 *     另外窗口被系统藏起 / 最小化时也补发一次可见态，状态栏那枚 ✦ 不再说谎；
 *   · **草稿**（本次修复）：输入框内容防抖落盘到同一份 mini-chat.json，Esc / ✕ / F1
 *     关窗都不清，只有发送成功才清 —— 下次开窗自动回填；
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
  /* globalShortcut 本轮起不再使用（F1 改窗内，见 register 前那段说明）；main.js 仍会注入，
     这里不取用即可，删注入是另一件事，不在这轮改动范围里。 */
  /* shell 只给两件事用：正文里的链接交系统浏览器（minichat:openExternal）、
     截图缩略图交系统看图程序（minichat:openImage） */
  const shell = o.shell || null;
  /* clipboard 只读位图（minichat:clipboardImage）：粘贴事件里拿不到图时的兜底 */
  const clipboard = o.clipboard || null;
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
  /* 用户「想让它开着」这一位只在主进程里：窗口被系统藏起 / 最小化 / 甩出屏幕时它仍然是 true，
     所以 F1 不会把「看不见的窗口」当成「开着」去关掉（见下面的 toggle / revealTop）。 */
  let wantOpen = false;
  let seq = 0;
  const pending = new Map();
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

  /* ── 草稿（本次修复 · 用户共识 q5）────────────────────────────────────
     关窗不再吃掉输入框里没发出去的字：小窗页面按输入防抖（150 ms）冲一次，
     失焦 / 关窗前再立刻冲一次；只有「发送成功」才写空串。存的位置就是这份 JSON
     （与尺寸 / 位置 / 两枚模式同一份文件），所以重启应用也还在。 */
  const DRAFT_MAX = 20000;
  function readDraft() {
    const got = readStore();
    const raw = typeof got.draft === "string" ? got.draft : "";
    return {
      text: raw.length > DRAFT_MAX ? raw.slice(0, DRAFT_MAX) : raw,
      sessionId: typeof got.draftSession === "string" ? got.draftSession : "",
      at: Number(got.draftAt) || 0,
    };
  }
  function writeDraft(payload) {
    const p = payload || {};
    const cur = readDraft();
    const raw = typeof p.text === "string" ? p.text : cur.text;
    const out = {
      text: raw.length > DRAFT_MAX ? raw.slice(0, DRAFT_MAX) : raw,
      /* 空草稿 = 已经发出去了：会话 id 一并清掉，不留「有会话没正文」的半条记录 */
      sessionId: typeof p.text === "string" && !raw ? "" : String(p.sessionId || cur.sessionId || ""),
      at: Date.now(),
    };
    writeStore({ draft: out.text, draftSession: out.sessionId, draftAt: out.at });
    return out;
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
    /* 窗口被系统藏起 / 最小化 / 还原时补发一次可见态：状态栏那枚 ✦ 的亮点要跟真实现状
       一致（用户报的「窗口都不见了、按钮却还亮着」就是这条没同步）。 */
    const syncVisibility = () => {
      let vis = false;
      try {
        vis = typeof w.isVisible === "function" ? !!w.isVisible() : !!w.visible;
        if (typeof w.isMinimized === "function" && w.isMinimized()) vis = false;
      } catch (_) {
        vis = false;
      }
      tellVisibility(vis);
    };
    w.on("show", syncVisibility);
    w.on("hide", syncVisibility);
    w.on("minimize", syncVisibility);
    w.on("restore", syncVisibility);
    w.on("closed", () => {
      if (win === w) win = null;
      wantOpen = false;
      pending.clear();
      tellVisibility(false);
    });
    w.on("moved", queuePersistBounds);
    w.on("resized", queuePersistBounds);
    w.loadFile(htmlPath).catch((e) => log("[minichat] loadFile 失败：" + ((e && e.message) || e)));
    return w;
  }

  /* ── 可见性 / 唤回（本次修复）───────────────────────────────────────────
     判据分三层，别再用「窗口对象还在」当「开着」：
       visibleNow  没最小化 + 真的 isVisible
       onScreen    与任一显示器工作区有足够重叠（被甩出屏幕 = 用户眼里的「整只不见了」）
       usableNow   用户想开着 + 上面两条都成立 —— 只有它成立时 F1 才是「关」 */
  function alive() {
    return !!(win && !win.isDestroyed());
  }
  function visibleNow() {
    if (!alive()) return false;
    try {
      if (typeof win.isMinimized === "function" && win.isMinimized()) return false;
      return typeof win.isVisible === "function" ? !!win.isVisible() : !!win.visible;
    } catch (_) {
      return false;
    }
  }
  function onScreen() {
    if (!alive()) return false;
    let b = null;
    try {
      b = win.getBounds();
    } catch (_) {
      return true;
    }
    if (!b) return true;
    let list = [];
    try {
      list = (typeof screen.getAllDisplays === "function" && screen.getAllDisplays()) || [];
    } catch (_) {
      list = [];
    }
    if (!list.length) return true; /* 拿不到显示器信息时不判死，按「在屏幕上」走 */
    for (const d of list) {
      const wa = d && d.workArea;
      if (!wa) continue;
      const ox = Math.min(b.x + b.width, wa.x + wa.width) - Math.max(b.x, wa.x);
      const oy = Math.min(b.y + b.height, wa.y + wa.height) - Math.max(b.y, wa.y);
      if (ox >= 80 && oy >= 40) return true;
    }
    return false;
  }
  function usableNow() {
    return wantOpen && visibleNow() && onScreen();
  }
  /* 位置被甩到屏幕外时拉回最近显示器的工作区中心（只改位置，不动尺寸） */
  function pullOnScreen() {
    if (!alive() || onScreen()) return false;
    let b = null;
    try {
      b = win.getBounds();
    } catch (_) {
      return false;
    }
    if (!b) return false;
    let wa = null;
    try {
      const d = screen.getDisplayNearestPoint({
        x: Math.round(b.x + b.width / 2),
        y: Math.round(b.y + b.height / 2),
      });
      wa = d && d.workArea;
    } catch (_) {}
    if (!wa) return false;
    const pos = clampToWorkArea(wa.x + wa.width / 2, wa.y + wa.height / 2, b.width, b.height);
    try {
      win.setBounds({ x: pos.x, y: pos.y, width: b.width, height: b.height });
      queuePersistBounds();
      return true;
    } catch (_) {
      return false;
    }
  }

  /* 唤回：恢复 → 拉回屏幕 → 显示 → 置顶 → 抬到最前 → 聚焦（inactive = 只抬不抢焦点） */
  function reveal(opts) {
    const o = opts || {};
    if (!alive()) return { ok: false, error: "no_window" };
    try {
      if (win.isMinimized()) win.restore();
    } catch (_) {}
    pullOnScreen();
    try {
      if (typeof win.setAlwaysOnTop === "function") win.setAlwaysOnTop(true);
    } catch (_) {}
    if (o.inactive && typeof win.showInactive === "function") {
      try {
        win.showInactive();
      } catch (_) {
        try {
          win.show();
        } catch (_) {}
      }
    } else {
      try {
        win.show();
      } catch (_) {}
    }
    try {
      if (typeof win.moveTop === "function") win.moveTop();
    } catch (_) {}
    if (!o.inactive) {
      try {
        win.focus();
      } catch (_) {}
    }
    wantOpen = true;
    tellVisibility(true);
    return { ok: true, reused: true };
  }

  /* 呼出：at = "cursor"（F1 从关到开，窗口中心对齐鼠标）| "saved"（入口按钮，用记忆位置） */
  function show(at) {
    const pt = at === "cursor" ? cursorPoint() : null;
    if (alive()) {
      if (pt) {
        const b = win.getBounds();
        const pos = clampToWorkArea(pt.x, pt.y, b.width, b.height);
        try {
          win.setPosition(pos.x, pos.y);
        } catch (_) {}
        queuePersistBounds();
      }
      return reveal();
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
    wantOpen = true;
    tellVisibility(true);
    return { ok: true, reused: false };
  }

  /* F1 是开关：**只有真的看得见**才算开着 → 关；
     看不见（被藏起 / 最小化 / 甩出屏幕）或本来就没有 → 唤回 / 开出来（贴到鼠标旁）。
     这就是用户报的「截完图小窗整只不见了，按 F1 也呼不回来」的修法：
     过去这里只看「窗口对象在不在」，于是 F1 走的还是「关」，越按越没有。 */
  function toggle() {
    if (usableNow()) return close();
    return show("cursor");
  }

  /* 应用重新拿到前台（用户在别的程序里干完活、回到 MTNode 的任一窗口）：
     小窗本该开着就把 Z 序抬回来；被系统藏起 / 最小化就静默显示回来（不抢焦点）。
     为什么挂在「应用获得焦点」而不是窗口 blur 上：微信截图那种全屏浮层在前台时去抢 Z 序，
     会把小窗糊到截图浮层上面（截出来的图里就带上了小窗）；等用户回到 MTNode 才说明这一趟结束了。 */
  function revealTop() {
    if (!wantOpen) return { ok: false, error: "closed" };
    if (!alive()) return { ok: false, error: "no_window" };
    if (visibleNow() && onScreen()) {
      try {
        if (typeof win.setAlwaysOnTop === "function") win.setAlwaysOnTop(true);
      } catch (_) {}
      try {
        if (typeof win.moveTop === "function") win.moveTop();
      } catch (_) {}
      return { ok: true, raised: true };
    }
    const r = reveal({ inactive: true });
    return { ok: r.ok, raised: true, restored: true };
  }

  function close() {
    wantOpen = false;
    /* 关窗前先把尺寸 / 位置落盘（窗口一关就取不到 bounds 了） */
    persistBounds();
    if (!win || win.isDestroyed()) return { ok: true };
    try {
      win.close();
    } catch (_) {}
    return { ok: true };
  }

  function destroy() {
    wantOpen = false;
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

  /* ── 窗内快捷键（F1）：不再注册 globalShortcut ───────────────────────────
     本轮口径（用户确认）：F1–F4 四颗键统一只在 MTNode 窗口内生效，不抢系统 F2/F3/F4，
     也不再全局抢 F1。主窗口的 renderer/app-status-keys.js 负责四颗键的判键与派发，
     这里只留「开关」这一个动作（minichat:toggle），热键状态恒报可用。 */

  /* ── IPC ─────────────────────────────────────────────────────────────── */
  function register() {
    /* 只有 IPC：调用方只需要 register() 一个入口（重复注册会抢不到同一条通道） */
    ipcMain.handle("minichat:open", () => show("saved"));
    ipcMain.handle("minichat:showAtCursor", () => show("cursor"));
    ipcMain.handle("minichat:close", () => close());
    /* 窗内 F1（renderer/app-status-keys.js）：开着就关、没开就开到鼠标位置。
       开合状态只在主进程这一侧持有，渲染层不自己记 —— 否则重载一次就对不上。 */
    ipcMain.handle("minichat:toggle", () => toggle());
    ipcMain.handle("minichat:hotkey", () => ({ ok: true, accelerator: "F1" }));
    /* 小窗现在是不是开着（只读、没有开窗副作用）。
       为什么需要它：状态推送只在主窗渲染层那一侧跑，而它「有没有开着」这一位过去只来自
       minichat:visibility 事件 —— 事件是一锤子买卖，主窗渲染层一重载（「刷新图形显存」的
       重载按钮 / 自我编译后的 reload / 任何 location.reload）就全丢了：渲染层这边 miniOpen
       归 false，推送循环再也起不来，小窗从此停在旧内容上 —— 用户看到的是「我发了新指令、
       agent 也跑完了，小窗里却永远等不到它的回复」。渲染层初始化时拿这条问一次即可自愈。 */
    ipcMain.handle("minichat:isOpen", () => {
      /* 只把「真的看得见、没最小化、没被甩出屏幕」报成开着 —— 藏起来的窗口起推送循环没意义 */
      const open = usableNow();
      /* 顺手把这一拍补发一次：老版本渲染层只认事件，也能被这一句救回来 */
      if (open) tellVisibility(true);
      return { ok: true, open: open };
    });
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
    /* ── 截图（本轮需求）──────────────────────────────────────────────────
       小窗输入框允许粘截图，但它自己被 sandbox 关在 file: 页面里，读写文件的只有主进程与
       主窗渲染层。三条 IPC 各管一件事，能力边界都只到「一只图」：
         clipboardImage  剪贴板位图 → PNG base64（粘贴事件里没有文件项时的兜底）
         attachImage     原样中继给主窗渲染层落盘（目录 / 命名规则在那里唯一真源）
         openImage       缩略图点开：只放行「确实存在的图片文件」，交系统看图程序 */
    ipcMain.handle("minichat:clipboardImage", () => {
      if (!clipboard || typeof clipboard.readImage !== "function")
        return { ok: false, error: "unsupported" };
      try {
        const img = clipboard.readImage();
        if (!img || (typeof img.isEmpty === "function" && img.isEmpty()))
          return { ok: false, error: "empty" };
        const png = img.toPNG();
        if (!png || !png.length) return { ok: false, error: "empty" };
        return { ok: true, base64: Buffer.from(png).toString("base64"), ext: "png" };
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
    });
    ipcMain.handle("minichat:attachImage", (e, payload) => {
      const p = payload || {};
      const out = {
        sessionId: String(p.sessionId || ""),
        base64: String(p.base64 || ""),
      };
      /* 扩展名只认这几个（正文里那行图靠后缀判断）；给别的值就按 png 走 */
      const ext = String(p.ext || "").replace(/^\./, "").toLowerCase();
      out.ext = /^(png|jpe?g|webp|gif|bmp)$/.test(ext) ? ext : "png";
      if (!out.base64) return Promise.resolve({ ok: false, error: "empty" });
      return relay("attachImage", out);
    });
    ipcMain.handle("minichat:openImage", async (e, p) => {
      const target = String(p || "").trim();
      if (!target || !path.isAbsolute(target)) return { ok: false, error: "blocked" };
      if (!/\.(png|jpe?g|webp|gif|bmp)$/i.test(target)) return { ok: false, error: "blocked" };
      try {
        if (!fs.existsSync(target)) return { ok: false, error: "missing" };
      } catch (_) {
        return { ok: false, error: "missing" };
      }
      if (!shell || typeof shell.openPath !== "function") return { ok: false, error: "unsupported" };
      try {
        const err = await shell.openPath(target);
        return err ? { ok: false, error: String(err) } : { ok: true };
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
    });
    /* 两枚模式开关：读 / 写（写会落盘，重启仍生效） */
    ipcMain.handle("minichat:modes", () => readModes());
    ipcMain.handle("minichat:setModes", (e, patch) => writeModes(patch));
    /* 草稿（本次修复）：关窗不清、发送成功才清 —— 下次开窗按它回填输入框 */
    ipcMain.handle("minichat:draft", () => readDraft());
    ipcMain.handle("minichat:setDraft", (e, payload) => writeDraft(payload));
    ipcMain.handle("minichat:state", () => relay("state", {}));
    ipcMain.handle("minichat:select", (e, id) => relay("select", { id: String(id || "") }));
    /* 组内「＋」：可带目标文件夹（左栏某一组标题右边那颗小加号 = 就在这一组里新建） */
    ipcMain.handle("minichat:newSession", (e, payload) =>
      relay("newSession", { ws: String((payload && payload.ws) || "") }),
    );
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
    /* 删除会话（本轮需求）：中继给主窗渲染层的 deleteAgentSession ——
       会话文件 + 索引条目一起下掉，小窗不自己碰磁盘。 */
    ipcMain.handle("minichat:delete", (e, id) => relay("delete", { id: String(id || "") }));
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
    /* F1 已不再是全局热键（改窗内，见上面 register 前那段说明）：这里不再 unregister，
       留着 destroy 收窗口即可。 */
    destroy();
  }

  return { register, show, close, destroy, shutdown, relay, revealTop, reveal, toggle };
}

module.exports = { createMiniChat };
