"use strict";
/* main-tray-notify.js — 常驻托盘 + 关闭收托盘 + 任务完成系统通知（主进程侧）。
 *
 * 为什么单独一只文件：main.js 已经 9900+ 行，托盘/通知是**一组互相关联的状态**
 * （是否正在退出、托盘图标是否已建、运行中任务数、通知点击回跳），挤进主进程正文
 * 只会让 before-quit 那套收尾更难读。本文件不 require 任何项目模块，只收 electron
 * 的几个对象（由 main.js 注入），因此可以单独在沙箱里跑单测桩。
 *
 * 口径（与用户共识一一对应）：
 *   · 主窗 ✕ = 先问「最小化到任务栏 / 退出程序」（询问在 main.js 的 close 拦截里）；
 *     托盘菜单「退出」= 直接退出（markQuitting → app.quit），不再询问；
 *   · 托盘菜单 = 显示主窗口 / 运行中任务数（只读）/ 全部终止运行 / 退出；
 *   · 托盘图标固定用 build/icon.png，不随运行态换图；悬停提示写「MTNode · N 项任务运行中」；
 *   · 系统通知只在应用不在前台时发（判定在渲染层，主进程只负责显示），
 *     点击通知 = 唤起主窗 + 把跳转目标回给渲染层（notify:click）；
 *   · 通知 silent:true —— 声音仍由渲染层 WebAudio 发出（renderer/app-db.js 的
 *     playTaskDoneSound），否则一次完成会响两遍。
 */

function createTrayNotify(opts) {
  const o = opts || {};
  const app = o.app;
  const Tray = o.Tray;
  const Menu = o.Menu;
  const Notification = o.Notification;
  const nativeImage = o.nativeImage;
  const ipcMain = o.ipcMain;
  const iconPath = String(o.iconPath || "");
  const getMainWin = typeof o.getMainWin === "function" ? o.getMainWin : () => null;
  const log = typeof o.log === "function" ? o.log : () => {};

  let tray = null;
  let quitting = false;
  let runningCount = 0;
  let lastNotifyAt = 0;

  const tooltip = () =>
    runningCount > 0 ? "MTNode · " + runningCount + " 项任务运行中" : "MTNode AI工作站";

  function send(channel, payload) {
    try {
      const w = getMainWin();
      if (!w || w.isDestroyed() || !w.webContents) return false;
      w.webContents.send(channel, payload);
      return true;
    } catch (e) {
      log("[tray] send " + channel + " 失败：" + ((e && e.message) || e));
      return false;
    }
  }

  function showMain() {
    const w = getMainWin();
    if (!w || w.isDestroyed()) return false;
    try {
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
      return true;
    } catch (e) {
      log("[tray] 唤起主窗失败：" + ((e && e.message) || e));
      return false;
    }
  }

  function buildMenu() {
    return Menu.buildFromTemplate([
      { label: "显示主窗口", click: () => showMain() },
      {
        label: runningCount > 0 ? "运行中任务：" + runningCount : "运行中任务：无",
        enabled: false,
      },
      {
        label: "全部终止运行",
        enabled: runningCount > 0,
        click: () => {
          showMain();
          send("tray:stopAll", null);
        },
      },
      { type: "separator" },
      {
        label: "退出 MTNode",
        click: () => {
          quitting = true;
          try {
            app.quit();
          } catch (e) {
            log("[tray] 退出失败：" + ((e && e.message) || e));
          }
        },
      },
    ]);
  }

  function refreshMenu() {
    if (!tray) return;
    try {
      tray.setToolTip(tooltip());
      tray.setContextMenu(buildMenu());
    } catch (e) {
      log("[tray] 刷新菜单失败：" + ((e && e.message) || e));
    }
  }

  /* 建托盘（幂等）。返回是否可用 —— 建不出来时调用方**不能**把窗口藏掉，
     否则用户既看不到窗也找不到托盘，应用等于消失。 */
  function ensureTray() {
    if (tray) return true;
    if (!Tray) return false;
    try {
      let img = null;
      try {
        if (iconPath && nativeImage) img = nativeImage.createFromPath(iconPath);
      } catch (_) {}
      if (img && img.isEmpty && img.isEmpty()) img = null;
      tray = new Tray(img || iconPath);
      tray.setToolTip(tooltip());
      tray.setContextMenu(buildMenu());
      /* 左键单击 = 恢复主窗（双击同效：Windows 上单击与双击都会来，重复 show 无害） */
      tray.on("click", () => showMain());
      tray.on("double-click", () => showMain());
      log("[tray] 托盘已创建（关闭主窗会询问：最小化到任务栏 / 退出程序）");
      return true;
    } catch (e) {
      tray = null;
      log("[tray] 创建托盘失败：" + ((e && e.message) || e));
      return false;
    }
  }

  /* 系统通知。跳转目标只传可序列化的 id 组合（node 对象过不了 IPC）。 */
  function notify(payload) {
    const p = payload && typeof payload === "object" ? payload : {};
    const title = String(p.title || "").trim();
    const body = String(p.body || "").trim();
    if (!title) return { ok: false, error: "empty_title" };
    if (!Notification || (Notification.isSupported && !Notification.isSupported()))
      return { ok: false, error: "unsupported" };
    try {
      const n = new Notification({
        title,
        body,
        silent: true, /* 声音由渲染层 WebAudio 负责，这里再响就是两遍 */
        icon: iconPath || undefined,
      });
      const jump = p.jump && typeof p.jump === "object" ? p.jump : null;
      n.on("click", () => {
        showMain();
        if (jump) send("notify:click", jump);
      });
      n.show();
      lastNotifyAt = Date.now();
      return { ok: true };
    } catch (e) {
      log("[notify] 显示失败：" + ((e && e.message) || e));
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  function register() {
    if (!ipcMain) return;
    /* 渲染层每次运行队列变化上报一次（它自己判重，只在数量变了才发） */
    ipcMain.handle("tray:setRunning", (_e, n) => {
      const v = Math.max(0, Math.min(999, Number(n) || 0));
      if (v !== runningCount) {
        runningCount = v;
        refreshMenu();
      }
      return { ok: true, running: runningCount };
    });
    ipcMain.handle("notify:show", (_e, payload) => notify(payload));
    ipcMain.handle("tray:status", () => ({
      ok: true,
      available: !!tray,
      quitting,
      running: runningCount,
      lastNotifyAt,
    }));
  }

  function destroy() {
    if (!tray) return;
    try {
      tray.destroy();
    } catch (_) {}
    tray = null;
  }

  return {
    register,
    ensureTray,
    hasTray: () => !!tray,
    refreshMenu,
    showMain,
    notify,
    destroy,
    isQuitting: () => !!quitting,
    markQuitting: () => {
      quitting = true;
    },
    runningCount: () => runningCount,
  };
}

module.exports = { createTrayNotify };
