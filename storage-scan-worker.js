"use strict";

/* ── 存储统计的后台线程（storage-clean.js 的 scan 专用） ────────────────
 * 设置 · 存储占用与清理一打开就自动统计数据目录：本机实测 19729 个文件 / 7 GB，
 * 一次 scan 要 5.1–5.9s，原先全在主进程同步跑完才回值 —— 整个应用这段时间没响应。
 * 现在这趟遍历搬到本线程里跑，主进程全程可用；返回结构与主进程内直调 scan 逐字一致。
 *
 * 为什么要 stub electron：storage-clean.js 顶层 `require("electron")` 只是为了注册
 * IPC（registerStorageIpc），而 Electron 的主进程 API 在线程里不可用。统计这条路径
 * 一个 electron API 都不用（shell 只出现在 clean 的删除路径上，本线程不碰 clean），
 * 所以换成一个空壳即可。
 *
 * ⚠ 本文件必须写进 build.json 的 files 白名单（已在），否则打包后线程起不来，
 *   设置里只会看到一条「存储统计失败」的错误行。
 * ─────────────────────────────────────────────────────────────────── */

const Module = require("module");
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return { ipcMain: { handle: () => {} }, shell: {} };
  return origLoad.call(this, request, parent, isMain);
};

const path = require("path");
const { parentPort, workerData } = require("worker_threads");

const sc = require(path.join(__dirname, "storage-clean.js"));
const I18n = require(path.join(__dirname, "renderer", "i18n.js"));

const d = workerData || {};
try {
  if (d.locale) I18n.setLocale(d.locale === "en" ? "en" : "zh");
} catch {}

sc.registerStorageIpc({
  getDataDir: () => String(d.dataDir || ""),
  t: (s) => I18n.t(s),
  /* scan 只判「回滚存储是否可用」（typeof rollbackGc === "function"）；
     真清理走主进程的 clean，本线程绝不调它。 */
  rollbackGc: d.hasRollbackGc ? () => {} : null,
});

let out = null;
try {
  out = sc.scan(d.opts || {});
} catch (err) {
  out = { ok: false, error: String((err && err.message) || err) };
}
parentPort.postMessage(out);
