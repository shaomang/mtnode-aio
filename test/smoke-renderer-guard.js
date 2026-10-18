"use strict";
/* 渲染层错误自诊断的口径（renderer/app-boot.js）：
 *   node test/smoke-renderer-guard.js
 * 背景：Chromium 把「ResizeObserver loop completed with undelivered notifications.」
 * 当 window error 抛出来，旧代码一律弹红 toast「渲染错误：…」+ 写崩溃日志，
 * 用户看到的就是一串「渲染错误」（窗口缩放 / 面板展开一次能连抛十几条）。
 * 钉住的口径：
 *   [1] 该告警被判为「非本应用异常」：不弹 toast、不写崩溃日志，只留一行控制台 warn（每会话一次）；
 *   [2] 真异常照旧弹 toast + 写崩溃日志（没被一刀切掉）；
 *   [3] error 与 unhandledrejection 两个入口都装了这道闸；
 *   [4] 判据函数真的认这两条 ResizeObserver 文案、且不误伤普通异常。
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

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "renderer", "app-boot.js"), "utf8");

console.log("[1] 判据函数");
const reM = src.match(/const RENDERER_BENIGN_ERR =\s*(\/[^/\n]+\/[a-z]*);/);
ok(!!reM, "app-boot.js 里有 RENDERER_BENIGN_ERR 判据正则");
const fnM = src.match(
  /function isRendererBenignError\(text\) \{[\s\S]*?\n\}/,
);
ok(!!fnM, "app-boot.js 里有 isRendererBenignError(text)");
let judge = null;
try {
  judge = new Function(
    "RENDERER_BENIGN_ERR",
    (fnM ? fnM[0] : "") + "\nreturn isRendererBenignError;",
  )(reM ? new Function("return " + reM[1])() : /.^/);
} catch (e) {
  judge = null;
}
ok(typeof judge === "function", "判据函数可独立求值（无隐藏依赖）");
if (typeof judge === "function") {
  ok(
    judge("ResizeObserver loop completed with undelivered notifications.") ===
      true,
    "认「ResizeObserver loop completed with undelivered notifications.」",
  );
  ok(
    judge("ResizeObserver loop limit exceeded") === true,
    "认「ResizeObserver loop limit exceeded」（老引擎的同义文案）",
  );
  ok(
    judge("Uncaught TypeError: x is not a function") === false,
    "不误伤普通异常（TypeError 仍算真错误）",
  );
  ok(judge("") === false && judge(undefined) === false, "空输入不误判");
}

console.log("[2] 只留控制台告警，不弹 toast、不写崩溃日志");
const noteM = src.match(/function noteRendererBenignError\(text\) \{[\s\S]*?\n\}/);
ok(!!noteM, "app-boot.js 里有 noteRendererBenignError(text)");
ok(
  !!noteM && /console\.warn\(/.test(noteM[0]),
  "该告警仍在控制台留一行（可诊断，不是静默吞掉）",
);
ok(
  !!noteM && !/crashLogRenderer/.test(noteM[0]),
  "不写崩溃日志（避免一次缩放刷十几条）",
);
ok(
  !!noteM && /rendererBenignErrLogged/.test(noteM[0]),
  "每会话只打一次（连抛十几条也只留一行）",
);

console.log("[3] 两个入口都装了这道闸，真错误照旧上报");
const iToast = src.indexOf('toast(I18n.t("渲染错误：")');
const iToast2 = src.indexOf('toast(I18n.t("未处理异常：")');
const iGuard1 = src.indexOf("if (isRendererBenignError(ev.message || msg)) {");
const iGuard2 = src.indexOf("if (isRendererBenignError(msg)) {");
ok(iToast > 0 && iToast2 > 0, "真错误仍弹 toast（渲染错误 / 未处理异常两条文案都在）");
ok(iGuard1 > 0 && iGuard1 < iToast, "error 事件：先过闸再弹 toast");
ok(iGuard2 > 0 && iGuard2 < iToast2, "unhandledrejection：先过闸再弹 toast");
ok(
  src.indexOf("crashLogRenderer", iToast) > 0 &&
    src.indexOf("crashLogRenderer", iToast2) > 0,
  "真错误仍写崩溃日志（自诊断链路没断）",
);

console.log("[4] 词条未受影响");
const i18n = fs.readFileSync(path.join(ROOT, "renderer", "i18n.js"), "utf8");
ok(i18n.indexOf('"渲染错误："') > 0, "i18n 仍有「渲染错误：」词条");

console.log(
  "\n" + (fails ? "FAILED " + fails + "/" + checks : "ALL OK " + checks),
);
process.exit(fails ? 1 : 0);
