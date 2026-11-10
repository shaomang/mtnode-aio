"use strict";
/* ============================================================
 * assist-isolation.js — 助手侧三股流（会话流 / 活动流 / 文件树）的进程宿主（main 进程）
 *
 * 任务 8/8 的落点：把这三股流的**渲染**搬出画布进程。本文件的职责只有「生 / 转发 / 收尾」：
 *   · 生：按 config 的 assist.isolation 档位起一只独立渲染进程 ——
 *       on     → WebContentsView（挂在主窗 contentView 上，按渲染层报来的矩形贴住会话区）；
 *       window → BrowserWindow（WebContentsView 起不来 / 需要单独摆一只窗时用同一份页面）；
 *       off    → 什么都不起（今天的内嵌路径，一字未改）；
 *   · 转发：主窗发布来的 patch、主进程收到的 dsh 事件、活动流新增条目，全部单向喂给那只进程；
 *   · 收：隔离页的用户动作（切会话 / 清活动 / 开文件 / 收起）原样转回主窗，由它执行 ——
 *     隔离页自己不改任何真源，所以「旧路径」永远还是唯一真源；
 *   · 收尾：窗口关、渲染进程崩、应用退出时关干净（崩了只记日志 + 标记故障，不自动反复拉起）。
 *
 * 为什么两种模式都留着：WebContentsView 贴在同窗里最像「原来那一栏」，但它对 z 序 /
 * 尺寸同步最敏感；BrowserWindow 那份最稳、最好排查（也更适合「盯着它跑」的现场）。
 * 实测结论与默认档位写在 docs/assist-isolation.md §2（assist.isolation 默认 off）。
 * ============================================================ */
const { WebContentsView, BrowserWindow } = require("electron");

let ctx = null; /* { getWindow, preload, page, log, readDir, onAction, onFault } */
let host = null; /* { mode, view|win, wc, ready, bounds, closed, pending[] } */
let lastBounds = { x: 0, y: 0, width: 0, height: 0 }; /* 换档重启时沿用上一条矩形 */
let desiredMode = "off";
let lastError = "";
let lastFault = "";
let openedAt = 0;

const PENDING_CAP = 400; /* 页面还没 ready 时攒着的 patch / 事件（超了丢最旧） */

function log(msg) {
  try {
    if (ctx && typeof ctx.log === "function") ctx.log(msg);
  } catch {}
}

function init(options) {
  ctx = options && typeof options === "object" ? options : {};
  desiredMode = normalizeMode(ctx.mode);
  return status();
}

/* 档位归一：只认 off / on / window 三个字面量，别的（含缺失）一律 off ——
   开关写错一个字就退回内嵌路径，绝不让它变成「什么都起不来、界面还空着」。 */
function normalizeMode(m) {
  const v = String(m || "").trim().toLowerCase();
  if (v === "on" || v === "view" || v === "webcontentsview") return "on";
  if (v === "window" || v === "win" || v === "browserwindow") return "window";
  return "off";
}

function status() {
  return {
    ok: true,
    desired: desiredMode,
    hosting: !!(host && !host.closed),
    mode: host && !host.closed ? host.mode : "",
    ready: !!(host && !host.closed && host.ready),
    since: openedAt || 0,
    error: lastError,
    fault: lastFault,
    /* 最后一次报上来的矩形（主窗按会话区的 getBoundingClientRect 逐帧上报）：
       排查「贴歪了 / 贴没了」的第一现场，自验脚本也拿它跟 DOM 对账 */
    bounds: { x: lastBounds.x, y: lastBounds.y, width: lastBounds.width, height: lastBounds.height },
  };
}

function mainWindow() {
  try {
    const w = ctx && typeof ctx.getWindow === "function" ? ctx.getWindow() : null;
    return w && !w.isDestroyed() ? w : null;
  } catch {
    return null;
  }
}

function webPrefs() {
  return {
    preload: ctx.preload,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    spellcheck: false,
    /* 这一页跟会话同生共死：后台节流会让「跑完那一条」迟迟不画，用户看到的是卡住的界面 */
    backgroundThrottling: false,
  };
}

function attach(wc, mode) {
  if (!wc) return;
  try {
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
  } catch {}
  wc.on("did-finish-load", () => {
    if (!host || host.closed || host.wc !== wc) return;
    host.ready = true;
    log("隔离页已就绪（" + mode + "），补发 " + host.pending.length + " 条攒着的消息");
    for (const one of host.pending) {
      try {
        wc.send(one.channel, one.data);
      } catch {}
    }
    host.pending = [];
  });
  wc.on("render-process-gone", (_e, details) => {
    if (!host || host.closed) return;
    const why = (details && details.reason) || "gone";
    lastFault = "隔离渲染进程退出：" + why;
    log(lastFault + "（" + ((details && details.exitCode) | 0) + "）—— 关掉隔离页，主窗回到内嵌路径");
    close("crash");
    try {
      if (ctx && typeof ctx.onFault === "function") ctx.onFault({ reason: why, exitCode: (details && details.exitCode) | 0 });
    } catch {}
  });
  wc.on("unresponsive", () => log("隔离渲染进程无响应（继续等它，不自动杀）"));
}

/* 起（或换档重启）隔离进程。返回 status()。 */
function open(mode) {
  const want = normalizeMode(mode || desiredMode);
  desiredMode = want;
  if (want === "off") {
    close("mode-off");
    return status();
  }
  if (host && !host.closed && host.mode === want) return status();
  close("restart");

  const win = mainWindow();
  if (!win) {
    lastError = "主窗还没建好，隔离页起不来";
    log(lastError);
    return status();
  }
  lastError = "";
  lastFault = "";

  const bounds = clampBounds(lastBounds);
  try {
    if (want === "on") {
      const view = new WebContentsView({ webPreferences: webPrefs() });
      win.contentView.addChildView(view);
      view.setBounds(bounds.width && bounds.height ? bounds : { x: 0, y: 0, width: 0, height: 0 });
      host = { mode: "on", view: view, win: win, wc: view.webContents, ready: false, bounds: bounds, closed: false, pending: [] };
      attach(host.wc, "WebContentsView");
      host.wc.loadFile(ctx.page).catch((e) => fail("loadFile", e));
    } else {
      const wa = { x: 0, y: 0, width: 1200, height: 800 };
      try {
        const b = win.getBounds();
        wa.x = b.x + b.width - 560;
        wa.y = b.y + 80;
        wa.width = 540;
        wa.height = Math.max(420, b.height - 160);
      } catch {}
      const w2 = new BrowserWindow({
        x: wa.x,
        y: wa.y,
        width: wa.width,
        height: wa.height,
        parent: win,
        show: false,
        title: "助手副驾（独立进程）",
        autoHideMenuBar: true,
        backgroundColor: "#0d1016",
        webPreferences: webPrefs(),
      });
      try {
        w2.setMenu(null);
      } catch {}
      w2.once("ready-to-show", () => {
        try {
          if (w2 && !w2.isDestroyed()) w2.show();
        } catch {}
      });
      w2.on("closed", () => {
        if (host && host.win === w2) {
          host.closed = true;
          host = null;
        }
      });
      host = { mode: "window", win: w2, wc: w2.webContents, ready: false, bounds: bounds, closed: false, pending: [] };
      attach(host.wc, "BrowserWindow");
      host.wc.loadFile(ctx.page).catch((e) => fail("loadFile", e));
    }
    openedAt = Date.now();
    log("隔离页已拉起（" + want + "）");
  } catch (e) {
    fail("open", e);
  }
  return status();
}

function fail(where, e) {
  lastError = where + "：" + ((e && e.message) || String(e));
  log(lastError);
  close("failed");
}

function close(reason) {
  if (!host) return;
  const h = host;
  host = null;
  h.closed = true;
  try {
    if (h.mode === "on" && h.view) {
      const win = h.win && !h.win.isDestroyed() ? h.win : null;
      try {
        if (win) win.contentView.removeChildView(h.view);
      } catch {}
      try {
        h.wc.close();
      } catch {}
    } else if (h.win && !h.win.isDestroyed()) {
      try {
        h.win.destroy();
      } catch {}
    }
  } catch (e) {
    log("关闭隔离页出错：" + ((e && e.message) || String(e)));
  }
  if (reason && reason !== "restart") log("隔离页已关闭（" + reason + "）");
}

function send(channel, data) {
  if (!host || host.closed) return false;
  if (!host.ready) {
    host.pending.push({ channel: channel, data: data });
    if (host.pending.length > PENDING_CAP) host.pending.splice(0, host.pending.length - PENDING_CAP);
    return true;
  }
  try {
    host.wc.send(channel, data);
    return true;
  } catch (e) {
    lastError = "转发失败：" + ((e && e.message) || String(e));
    return false;
  }
}

/* 主窗发布来的一条 patch（sessions / stream / activity / tree 各一块）。 */
function sendPatch(patch) {
  if (!patch) return false;
  return send("assist-iso:patch", patch);
}

/* 一帧 dsh 事件（主进程 dshSendEvent 那条唯一收口处转发）。 */
function sendEvent(ev) {
  if (!ev) return false;
  return send("assist-iso:event", ev);
}

function sendSnapshot(snap, mode) {
  return send("assist-iso:snapshot", { snapshot: snap || {}, mode: mode || (host ? host.mode : "") });
}

/* 渲染层报来的矩形（CSS px，相对主窗视口左上角）。空矩形 = 收起来（宽高 0）。 */
function setBounds(rect) {
  const b = clampBounds(rect);
  lastBounds = b;
  if (host) host.bounds = b;
  if (!host || host.closed || host.mode !== "on" || !host.view) return b;
  try {
    host.view.setBounds(b.width && b.height ? b : { x: 0, y: 0, width: 0, height: 0 });
  } catch (e) {
    log("设置隔离页矩形失败：" + ((e && e.message) || String(e)));
  }
  return b;
}

function clampBounds(rect) {
  const r = rect && typeof rect === "object" ? rect : {};
  const win = mainWindow();
  let maxW = 4096;
  let maxH = 4096;
  try {
    const cb = win ? win.getContentBounds() : null;
    if (cb) {
      maxW = cb.width;
      maxH = cb.height;
    }
  } catch {}
  const num = (v) => Math.max(0, Math.round(Number(v) || 0));
  const x = Math.min(num(r.x), maxW);
  const y = Math.min(num(r.y), maxH);
  return {
    x: x,
    y: y,
    width: Math.min(num(r.width), Math.max(0, maxW - x)),
    height: Math.min(num(r.height), Math.max(0, maxH - y)),
  };
}

function isHosting() {
  return !!(host && !host.closed);
}

/* 应用退出：不 await 任何东西（渲染进程里那点状态本来就不落盘），只把它关掉。 */
function shutdown() {
  close("quit");
  return { ok: true };
}

module.exports = {
  init,
  open,
  close,
  status,
  send,
  sendPatch,
  sendEvent,
  sendSnapshot,
  setBounds,
  isHosting,
  shutdown,
  normalizeMode,
};
