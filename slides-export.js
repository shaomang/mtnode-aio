"use strict";

/* ── 主进程侧「演讲者第二屏」内核（slides-export.js · 零第三方依赖） ─────────────────
 *
 * 为什么在主进程做：
 *   · 主窗的 window.open 被 setWindowOpenHandler 一律拒绝（main.js），渲染层开不出第二屏。
 *
 * 演讲者第二屏：
 *   · openPresenter(html, opts) 建一只真窗口（opts.show === false 时离屏，冒烟用），载入 presenterHtml("push")；
 *   · pushPresenter(id, state) 用 executeJavaScript 调 window.__rrApply(state) 推当前页 / 下一页 / 备注；
 *   · closePresenter(id) 关窗。
 *
 * 落盘纪律（AGENTS.md）：演示只导出单文件 HTML（渲染层直接写盘），主进程不落任何导出物。
 * ───────────────────────────────────────────────────────────────────────────── */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { pathToFileURL } = require("url");

function insideAppDir(target) {
  try {
    const { app } = require("electron");
    const t = path.resolve(String(target || ""));
    if (!t) return false;
    /* 打包后 getAppPath() = asar 根，__dirname 也指向同一处；源码运行时是仓库根。
       两个都算「应用目录」，缺一个就可能在某些启动方式下漏判（比如直接跑脚本）。 */
    const roots = [];
    try {
      roots.push(path.resolve(app.getAppPath() || ""));
    } catch (_) {}
    roots.push(path.resolve(__dirname));
    for (const root of roots) {
      if (!root) continue;
      if (t === root || t.startsWith(root + path.sep)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/* 临时目录里放一份页面（第二屏窗只读它，用完删；用户产物在调用方指定的路径） */
function tmpHtmlOf(html, tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-slides-"));
  const file = path.join(dir, (tag || "deck") + ".html");
  fs.writeFileSync(file, html, "utf8");
  return { file, dir };
}

/* ── 演讲者第二屏 ──────────────────────────────────────────────────────────── */
let presenterSeq = 0;
const presenterWins = new Map();

function openPresenter(html, opts) {
  const src = String(html || "");
  const o = opts && typeof opts === "object" ? opts : {};
  if (!src.trim()) return { ok: false, error: "没有第二屏的页面内容" };
  const { BrowserWindow } = require("electron");
  let tmp = null;
  try {
    tmp = tmpHtmlOf(src, "presenter");
    const id = "pp-" + Date.now().toString(36) + "-" + ++presenterSeq;
    const win = new BrowserWindow({
      width: 1180,
      height: 760,
      /* 默认真的开出来给讲的人看；冒烟里传 { show:false } 走离屏，免得打断正用着的人 */
      show: o.show !== false,
      skipTaskbar: o.show === false,
      title: "演讲者视图",
      backgroundColor: "#0b0b10",
      webPreferences: {
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    presenterWins.set(id, win);
    win.on("closed", () => {
      presenterWins.delete(id);
      try {
        if (tmp && tmp.dir) fs.rmSync(tmp.dir, { recursive: true, force: true });
      } catch (_) {}
    });
    win.loadFile(tmp.file).catch(() => {});
    return { ok: true, id: id };
  } catch (err) {
    try {
      if (tmp && tmp.dir) fs.rmSync(tmp.dir, { recursive: true, force: true });
    } catch (_) {}
    return { ok: false, error: String((err && err.message) || err) };
  }
}

async function pushPresenter(id, state) {
  const win = presenterWins.get(String(id || ""));
  if (!win || win.isDestroyed()) return { ok: false, error: "第二屏窗口已关闭" };
  const js = "window.__rrApply(" + JSON.stringify(state || null) + ")";
  /* 刚开出来的那一瞬页面还没跑完脚本（__rrApply 不存在）：等它一会儿，别让第一推白丢 */
  let last = "";
  for (let i = 0; i < 12; i++) {
    try {
      await win.webContents.executeJavaScript(js, true);
      return { ok: true };
    } catch (err) {
      last = String((err && err.message) || err);
      if (win.isDestroyed()) return { ok: false, error: "第二屏窗口已关闭" };
      await new Promise((r) => setTimeout(r, 120));
    }
  }
  return { ok: false, error: last };
}

function closePresenter(id) {
  const key = String(id || "");
  if (!key) {
    for (const [, w] of presenterWins) {
      try {
        if (!w.isDestroyed()) w.destroy();
      } catch (_) {}
    }
    presenterWins.clear();
    return { ok: true, closed: true };
  }
  const win = presenterWins.get(key);
  if (!win) return { ok: true, closed: false };
  try {
    if (!win.isDestroyed()) win.destroy();
  } catch (_) {}
  presenterWins.delete(key);
  return { ok: true, closed: true };
}

module.exports = {
  openPresenter,
  pushPresenter,
  closePresenter,
  insideAppDir,
  pathToFileURL,
};
