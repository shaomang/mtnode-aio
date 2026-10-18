"use strict";
/* 完成音 · 后台也能按时响 —— 冒烟测试（纯 Node，不起 Electron）
 *   node test/smoke-done-sound-bg.js
 *
 * 本轮需求：MTNode 在后台（最小化 / 被别的窗口整片盖住 / 不在前台）时，任务完成音
 * 要当场响，不能等切回界面才补响。根因是「完成判定只挂在渲染层定时器上」：那一拍
 * 一旦被后台节流推迟，声音就跟着推迟。
 *
 * 本文件钉住修复后的三条链路（少了任何一条都会退回旧行为）：
 *   [1] 主进程：sound:watch → 每 2 秒 sound:tick；窗口关闭时停表
 *   [2] 预加载桥：soundWatch / onSoundTick 存在且只暴露这两个
 *   [3] 渲染层：面板刷新时同步开关心跳 · 收到 tick 就刷面板 · 心跳异常不再自杀
 *              · 窗口重新激活（focus / visibilitychange）补一次判定
 *   [4] 音频：AudioContext 统一走 doneAudioCtx()（非 running 就续跑 + onstatechange 兜底），
 *            完成音与提问音都用它
 *   [5] 旧口径清干净：代码 / 文档里不再写「可能推迟到切回窗口才响（用户已知并接受）」
 */
const fs = require("fs");
const path = require("path");

let fails = 0;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
}
const read = (rel) =>
  fs
    .readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8")
    .replace(/\r\n/g, "\n");

const mainJs = read("main.js");
const preload = read("preload.js");
const appJs = read("renderer/app.js");
const appDb = read("renderer/app-db.js");
const dshReadme = read("dsh/README.md");
const dshDesign = read("dsh/DESIGN.md");

/* 截出某个函数 / 某段代码，后面的断言只看这一段，避免别处同名写法误判 */
function sliceOf(src, from, to) {
  const i = src.indexOf(from);
  if (i < 0) return "";
  const j = to ? src.indexOf(to, i + from.length) : -1;
  return j < 0 ? src.slice(i) : src.slice(i, j);
}

console.log("[1] 主进程：完成音心跳");
ok(/const SOUND_TICK_MS = 2000;/.test(mainJs), "心跳间隔 2 秒（与运行队列面板同频）");
ok(
  /ipcMain\.handle\("sound:watch", \(e, on\) => \{[\s\S]{0,160}?setSoundWatch\(!!on\)/.test(mainJs),
  "ipcMain.handle(\"sound:watch\") 转给 setSoundWatch",
);
const watchFn = sliceOf(mainJs, "function setSoundWatch(on)", "ipcMain.handle(\"sound:watch\"");
ok(/webContents\.send\("sound:tick"\)/.test(watchFn), "setSoundWatch 每拍发 sound:tick 给主窗");
ok(
  /else if \(!want && soundWatchTimer\)[\s\S]{0,120}?clearInterval\(soundWatchTimer\)/.test(watchFn),
  "队列空了就停表（不空转）",
);
ok(
  /mainWin\.on\("closed", \(\) => \{[\s\S]{0,200}?setSoundWatch\(false\)/.test(mainJs),
  "主窗关闭时停表",
);
ok(
  /disable-backgrounding-occluded-windows/.test(mainJs) &&
    /backgroundThrottling: false/.test(mainJs),
  "后台不降频的窗口开关与命令行开关仍在（与心跳互为两道保险）",
);

console.log("[2] 预加载桥");
ok(/soundWatch: \(on\) => ipcRenderer\.invoke\('sound:watch', !!on\)/.test(preload), "soundWatch(on) → sound:watch");
ok(
  /onSoundTick: \(cb\) => \{[\s\S]{0,220}?ipcRenderer\.on\('sound:tick', h\)/.test(preload),
  "onSoundTick(cb) 订阅 sound:tick",
);

console.log("[3] 渲染层：判定不依赖自己的定时器");
ok(
  /const hasQueue = !!items\.length;[\s\S]{0,260}?syncSoundWatch\(hasQueue\)/.test(appJs),
  "面板刷新时按队列状态同步心跳开关",
);
const watchSync = sliceOf(appJs, "function syncSoundWatch(on)", "window.addEventListener(\"focus\"");
ok(/window\.api\.soundWatch\(want\)/.test(watchSync), "syncSoundWatch 只在状态变化时调一次 IPC");
ok(
  /window\.api\.onSoundTick\(\(\) => \{[\s\S]{0,120}?updateRunQueuePanel\(\)/.test(appJs),
  "收到 sound:tick 就当场刷面板（= 当场跑完成判定）",
);
const ticker = sliceOf(appJs, "function syncRunQueueTicker(on)", "/* ── 完成音的主进程心跳 ──");
ok(
  /catch \(_\) \{[\s\S]{0,420}?stopRunQueueTicker\(\);[\s\S]{0,200}?\}, 3000\);/.test(ticker),
  "面板心跳异常不再永久停摆：3 秒后按队列状态重起",
);
ok(
  /window\.addEventListener\("focus"[\s\S]{0,120}?updateRunQueuePanel\(\)/.test(appJs),
  "窗口重新激活时补一次判定",
);
ok(
  /document\.addEventListener\("visibilitychange"[\s\S]{0,160}?updateRunQueuePanel\(\)/.test(appJs),
  "页面从隐藏回到可见时补一次判定",
);

console.log("[4] 音频输出：AudioContext 一直续跑");
const ctxFn = sliceOf(appDb, "function doneAudioCtx()", "/* 内置完成音");
ok(!!ctxFn, "doneAudioCtx() 存在");
ok(/onstatechange = \(\) => \{/.test(ctxFn), "挂 onstatechange：只要不是 running 就续（suspended / interrupted 都救）");
ok(/if \(ac\.state !== "running"\)/.test(ctxFn), "每次发声前先确保在跑");
const tones = sliceOf(appDb, "function playBuiltinTones(", "/* ── 完成音的发声");
ok(/const ac = doneAudioCtx\(\);/.test(tones), "内置完成音走 doneAudioCtx()");
const ix = sliceOf(appDb, "function builtinIxBeep()", "function playIxSound()");
ok(/const ac = doneAudioCtx\(\);/.test(ix), "提问/审批提示音走同一个 AudioContext");
ok(
  !/S\._audioCtx = S\._audioCtx \|\| new AC\(\)/.test(appDb),
  "旧写法（懒建 + 只在 suspended 时 resume 一次）已不存在",
);

console.log("[5] 旧口径已清干净");
const stale = "用户已知并接受";
ok(mainJs.indexOf(stale) < 0, "main.js 不再写「用户已知并接受」");
ok(preload.indexOf(stale) < 0, "preload.js 同上");
ok(appDb.indexOf(stale) < 0, "app-db.js 同上");
ok(
  dshReadme.indexOf("可能推迟到你切回") < 0,
  "dsh/README.md 不再写「可能推迟到你切回才响」",
);
ok(
  /主进程只保留判定心跳/.test(dshDesign),
  "dsh/DESIGN.md 写明主进程只剩判定心跳",
);

console.log("");
if (fails) {
  console.log("✗ 完成音后台回归：" + fails + "/" + checks + " 项失败");
  process.exitCode = 1;
} else {
  console.log("✓ 完成音后台回归：" + checks + " 项全绿");
}
