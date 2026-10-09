/* 只读探针子件（非交付件）：真 OS 键盘事件的「产生时刻」记录者。
 *
 * 为什么必须单独一个进程：被测宿主（Electron 主进程）在做 config:save 时会被 78MB 的
 * 同步读/序列化/写盘占住几百毫秒到 1.7 秒，它自己取的时间戳不可信；本进程只挂一个全局
 * 键盘钩子、几乎不干活，事件一到就把 Date.now() 甩给父亲 —— 于是「OS 事件时刻」与宿主
 * 忙不忙无关，可以拿来跟页面 document 层收到 keydown 的时刻相减，量出真正的路由延迟。
 *
 * 不读不写任何文件。
 */
"use strict";
let hook = null;
try {
  ({ uIOhook: hook } = require("uiohook-napi"));
} catch (e) {
  try {
    process.send({ kind: "fatal", msg: "uiohook 载入失败：" + String((e && e.message) || e) });
  } catch {}
}
if (hook) {
  const send = (kind, e) => {
    const t = Date.now(); /* 本进程的 JS 线程基本空闲，这个时刻就是「事件到手」的时刻 */
    try {
      process.send({ kind, vk: e.keycode, t, osTime: e.time });
    } catch {}
  };
  hook.on("keydown", (e) => send("down", e));
  hook.on("keyup", (e) => send("up", e));
  try {
    hook.start();
    process.send({ kind: "started", pid: process.pid });
  } catch (e) {
    process.send({ kind: "fatal", msg: "hook.start 失败：" + String((e && e.message) || e) });
  }
}
process.on("message", (m) => {
  if (m === "stop") {
    try {
      hook && hook.stop();
    } catch (e) {}
    process.exit(0);
  }
});
process.on("disconnect", () => process.exit(0));
