"use strict";
/**
 * 安装中断核心（宿主侧）：把「取消安装」从「置一个标志」变成「真的把安装进程树杀掉」。
 *
 * 为什么存在：8 个插件宿主的取消口原先只做 `installCancel = true`，而那个标志只在
 * powershell 脚本**自己退出之后**才被 `child.on("close")` 读到（历史见 llama/main-llama.js
 * 的 `const cancelled = !!installCancel`）—— 脚本在下载权重 / 装 torch 期间不会自己退出，
 * 于是用户点「取消安装」等于没点。模块化的窗口插件与桌宠更直接：压根没登记取消口。
 *
 * 口径（本轮共识）：
 *   · 取消 = 立刻按**进程树**强杀当前安装子进程（win32 用 `taskkill /PID <pid> /T /F`，
 *     PowerShell 脚本会拉起 pip / curl / python，只杀父进程会把它们留成孤儿继续占网占盘）；
 *   · 不清目录、不删已下好的文件（重试＝脚本续跑，已完成的步骤与权重由脚本自己跳过）；
 *   · 一个插件同时只有一次安装，登记表按 pluginId 存**当前**那一个子进程，装完自动注销。
 *
 * 用法（宿主侧）：
 *   const installCancel = require("../plugins/install-cancel.js");
 *   const child = spawn("powershell.exe", psArgs, { … });
 *   installCancel.track(PLUGIN_ID, child);          // spawn 之后立刻登记
 *   child.on("close", () => installCancel.untrack(PLUGIN_ID));
 *   // 取消口：
 *   cancel: async () => { installCancel = true; return await installCancel.killProcessTree(PLUGIN_ID); }
 *
 * 本模块不依赖 Electron，可在冒烟里直接 require（test/smoke-install-cancel.js）。
 */
const { execFile, spawnSync } = require("child_process");

/** pluginId → 当前安装子进程（同一插件只保留最近一次 spawn 的）。 */
const active = new Map();

/** 取消中的插件：kill 之后到 close 事件之间，避免重复 taskkill。 */
const killing = new Set();

function isWin() {
  return process.platform === "win32";
}

function alive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!(e && e.code === "EPERM");
  }
}

/** 登记当前安装子进程（幂等：同插件重复 spawn 时后者覆盖，并顺手放掉旧引用）。 */
function track(pluginId, child) {
  const id = String(pluginId || "").trim();
  if (!id || !child || typeof child !== "object") return { ok: false, error: "bad_args" };
  active.set(id, child);
  return { ok: true, pid: Number(child.pid) || 0 };
}

/** 注销（子进程结束 / 安装函数收尾时调用；只清引用，不杀任何东西）。 */
function untrack(pluginId) {
  const id = String(pluginId || "").trim();
  if (!id) return { ok: false, error: "bad_id" };
  active.delete(id);
  killing.delete(id);
  return { ok: true };
}

/** 当前是否有登记的安装子进程（安装窗 / 宿主可用于判断「这次取消有没有东西可停」）。 */
function activePidOf(pluginId) {
  const child = active.get(String(pluginId || "").trim());
  return child && child.pid ? Number(child.pid) : 0;
}

/**
 * 按进程树强杀一个 pid。永不抛，永远 resolve：
 *   { ok, pid, killed, gone, via, error? }
 *   · via: "taskkill"（win32 / 有 taskkill 时）| "kill"（回退到 child.kill）| "none"
 *   · gone: kill 之后该 pid 是否已经不在（taskkill /F 通常立即生效）
 */
function killTree(pid, opts) {
  const o = opts || {};
  const n = Number(pid) || 0;
  if (!n) return Promise.resolve({ ok: false, error: "no_pid", pid: 0, killed: false, gone: true, via: "none" });
  const via = o.via || (isWin() ? "taskkill" : "kill");
  const grace = Number.isFinite(o.graceMs) ? Number(o.graceMs) : 1500;
  const child = o.child || null;
  return new Promise((resolve) => {
    let settled = false;
    const done = (extra) => {
      if (settled) return;
      settled = true;
      resolve(Object.assign({ ok: true, pid: n, killed: true, gone: !alive(n), via }, extra || {}));
    };
    const fallback = (why) => {
      /* taskkill 不可用（非 win32 / 被策略拦住）：至少把直接子进程杀掉 */
      try {
        if (child && typeof child.kill === "function") child.kill();
        else if (!isWin()) process.kill(n, "SIGKILL");
      } catch {}
      setTimeout(() => done({ error: why || "" }), 200);
    };
    /* win32 的 /T 一定要走 cmd.exe：taskkill 把 `/T` 当成 TTY 开关，
       直接 execFile("taskkill", ["/T"]) 会报「无效参数/选项 - '/'」。 */
    const cmd = o.taskkillCmd || (isWin() ? "cmd.exe" : "taskkill");
    const args = isWin() ? ["/d", "/s", "/c", `taskkill /PID ${n} /T /F`] : ["/PID", String(n), "/T", "/F"];
    try {
      execFile(cmd, args, { windowsHide: true, timeout: grace + 1500 }, (err) => {
        if (err) fallback(String((err && err.message) || err));
        else done();
      });
    } catch (e) {
      fallback(String((e && e.message) || e));
    }
  });
}

/**
 * 取消某插件的当前安装：置宿主取消标志（由宿主自己做）+ 强杀进程树。
 * 没有登记的进程（已装完 / 还没开始）不算失败：返回 { ok:true, noop:true }，
 * 宿主据此把「这次取消」如实落到快照上（安装窗显示「已取消」）。
 */
async function cancelInstall(id, opts) {
  const sid = String(id || "").trim();
  if (!sid) return { ok: false, error: "bad_id" };
  const child = active.get(sid);
  if (!child || !child.pid) return { ok: true, noop: true, id: sid };
  if (killing.has(sid)) return { ok: true, alreadyCancelling: true, id: sid };
  killing.add(sid);
  const r = await killTree(child.pid, Object.assign({ child }, opts || {}));
  return Object.assign({ id: sid, noop: false }, r);
}

/** 测试 / 冒烟用：把内存状态读出来（不落盘，没有别的方式窥视）。 */
function debugState() {
  return {
    active: [...active.entries()].map(([id, c]) => ({ id, pid: (c && c.pid) || 0 })),
    killing: [...killing],
  };
}

module.exports = {
  track,
  untrack,
  activePidOf,
  killTree,
  cancelInstall,
  debugState,
  /* 冒烟里用同一套同步口径核对 taskkill 的真实行为（不参与运行期逻辑） */
  _spawnSyncKill: (pid) =>
    spawnSync("cmd.exe", ["/d", "/s", "/c", `taskkill /PID ${Number(pid) || 0} /T /F`], { windowsHide: true }),
  _alive: alive,
};
