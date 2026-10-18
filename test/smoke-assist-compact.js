"use strict";
/* ============================================================================
 * test/smoke-assist-compact.js — 助手栏「上下文压缩」档位（本次需求：挪到「思考强度」下一行）
 *
 *   node test/smoke-assist-compact.js              断言模式（绿 = 退出码 0）
 *
 * 为什么要有它：这一格是「设置 · 智能能力 · 上下文压缩」的**第二个人口**，两处必须是同一份值
 * （S.config.dsh.compact）—— 别人另存一份（如 S.assistCompact）就会造成「面板显示中档、
 * 组合里是早档」的静默错配；位置也要钉住（用户点名「思考强度下方」）。
 * 靠读源码只能证明它写在那一行，证明不了「真实 DOM 里真的在下方」「改一下真的写成那张配置」，
 * 所以这里用仓库自带的 Electron（show:false + offscreen，布局照算）摆起**真实 index.html 的
 * <body>** 与真实样式（renderer/style.css 的 @import 分片全量内联），并抠出 app-assist.js 里
 * 真正在跑的那几个函数注进页面执行（改名 / 改写法即变红）：
 *   · 布局：压缩这一格必须整格落在「思考强度」那一格的**下方**（rect.top 更大），
 *     且两格同属 #assistCtrl（不会跑到别处去）；
 *   · 回显：缺省配置 → 选项是「中」；{enabled:false,tier:'late'} → 选项是「关闭」；
 *     非法档 → 回落「中」；切语言 → 选项文字跟着换（英文界面不回落中文）；
 *   · 落盘：改下拉 → S.config.dsh.compact 写成对应形状 + configSave 真被调用 + 档位不丢。
 * ========================================================================== */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const rel = (...p) => path.join(ROOT, ...p);

/* ---------- 纯 Node 时：用仓库自带的 Electron 重启自己（保持 `node test/...` 的跑法） ---------- */
if (!process.versions.electron) {
  const { spawn } = require("child_process");
  const bin = require("electron");
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(String(bin), [__filename].concat(process.argv.slice(2)), {
    stdio: "inherit",
    env,
  });
  child.on("exit", (code, sig) => process.exit(sig ? 1 : code == null ? 1 : code));
  child.on("error", (e) => {
    console.error("启动 Electron 失败：" + (e && e.message));
    process.exit(1);
  });
} else {
  main().catch((e) => {
    console.error("[smoke-assist-compact] 失败：", (e && e.stack) || e);
    try {
      require("electron").app.exit(1);
    } catch (_) {}
  });
}

/* ==================== 从 renderer/app-assist.js 抠出「真正在跑」的构件 ====================
 * 断言必须打在产品代码上：按名字把原文抠出来，注入页面执行。抠不到（改名 / 删了 / 换写法）
 * → 直接抛错让 smoke 变红，逼着两边同步。
 * 档位清单 / 归一 / 词条住在 renderer/app-dsh-compact.js（设置面板与助手栏共用的小单元），
 * 这里连它一起注入 —— 真实 index.html 里它排在 app-assist.js 之前。 */
const IMPL_FNS = [
  "syncAssistCompactOptions",
  "syncCompactSideControls",
  "syncCompactCustomInput",
  "syncCompactLimitInputs",
  "applyAssistCompactChoice",
  "applyAssistCompactTrigger",
  "applyAssistCompactLimit",
  "persistAssistUi",
];

function grabFn(src, name) {
  const re = new RegExp("^function\\s+" + name + "\\s*\\(", "m");
  const m = re.exec(src);
  if (!m)
    throw new Error("找不到函数 " + name + "（改名了？／搬去别的加载单元了？断言要跟着改）");
  let i = m.index + m[0].length;
  while (i < src.length && src[i] !== "{") i++;
  if (i >= src.length) throw new Error("函数 " + name + " 找不到函数体起始 {");
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(m.index, i + 1);
    }
  }
  throw new Error("函数 " + name + " 的收尾 } 没找到（括号不配对？）");
}

/* 档位清单 / 归一 / 边界常量：整段取自 renderer/app-dsh-compact.js（共享小单元原文） */
function grabOptionsConst(src) {
  const start = src.indexOf("const ASSIST_COMPACT_OPTIONS = [");
  if (start < 0) throw new Error("renderer/app-dsh-compact.js 里找不到 ASSIST_COMPACT_OPTIONS");
  const end = src.indexOf("];", start);
  if (end < 0) throw new Error("ASSIST_COMPACT_OPTIONS 的收尾 ] 没找到");
  return src.slice(start, end + 2);
}

/* app-assist.js 依赖、但不属于本格行为的三样（探针里按原样补齐，免得抠一大串）：
   · AGENT_PRESET_DEFAULT：落盘那一句 `S.config.assistPreset = S.assistPreset || …` 要用；
   · clampAssistW / ASSIST_W_MIN：同一句里的窗口宽度夹取。
   这三个都从产品源码里取（常量抠原文、函数按名字抠），不自己编值。 */
function grabConst(src, name, where) {
  const m = new RegExp("^const " + name + "\\s*=\\s*([^;\\n]+);", "m").exec(src);
  if (!m) throw new Error((where || "renderer/app-assist.js") + " 里找不到常量 " + name);
  return "const " + name + " = " + m[1] + ";";
}

/** 跨行的对象字面量常量（如 COMPACT_TIER_SIZE_DEFAULTS）：按花括号配对整段抠出来。 */
function grabObjectConst(src, name, where) {
  const at = src.indexOf("const " + name + " = {");
  if (at < 0) throw new Error((where || "renderer/app-assist.js") + " 里找不到常量 " + name);
  let i = src.indexOf("{", at);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(at, i + 1) + ";";
    }
  }
  throw new Error("常量 " + name + " 的花括号不配对");
}

function implInjection() {
  const src = fs.readFileSync(rel("renderer", "app-assist.js"), "utf8");
  const shared = fs.readFileSync(rel("renderer", "app-dsh-compact.js"), "utf8");
  const appSrc = fs.readFileSync(rel("renderer", "app.js"), "utf8");
  /* 共享小单元（app-dsh-compact.js）：档位清单 + 归一 + 词条 + 边界常量，整份原文注入 */
  let code = grabOptionsConst(shared) + "\n";
  code += grabFn(shared, "compactPolicyOf") + "\n";
  code += grabFn(shared, "compactLimitOf") + "\n";
  code += grabFn(shared, "compactTierSizeDefault") + "\n";
  code += grabFn(shared, "compactRetainEffectiveOf") + "\n";
  code += grabFn(shared, "compactSummaryEffectiveOf") + "\n";
  code += grabFn(shared, "assistCompactOptionLabel") + "\n";
  code += grabFn(shared, "compactCustomSuffix") + "\n";
  code += grabConst(shared, "COMPACT_FIXED_TIERS", "renderer/app-dsh-compact.js") + "\n";
  code += grabConst(shared, "COMPACT_CUSTOM_MIN", "renderer/app-dsh-compact.js") + "\n";
  code += grabConst(shared, "COMPACT_CUSTOM_MAX", "renderer/app-dsh-compact.js") + "\n";
  /* 压缩后的大小（本次需求）：两个可调量的边界与档位默认表 */
  code += grabConst(shared, "COMPACT_RETAIN_MIN", "renderer/app-dsh-compact.js") + "\n";
  code += grabConst(shared, "COMPACT_RETAIN_MAX", "renderer/app-dsh-compact.js") + "\n";
  code += grabConst(shared, "COMPACT_SUMMARY_MIN", "renderer/app-dsh-compact.js") + "\n";
  code += grabConst(shared, "COMPACT_SUMMARY_MAX", "renderer/app-dsh-compact.js") + "\n";
  code +=
    grabObjectConst(shared, "COMPACT_TIER_SIZE_DEFAULTS", "renderer/app-dsh-compact.js") + "\n";
  /* 助手侧自己的常量与函数 */
  code += grabConst(src, "ASSIST_W_MIN") + "\n";
  /* AGENT_PRESET_DEFAULT 的真源在 app.js（app-assist.js 直接用它） */
  code += grabConst(appSrc, "AGENT_PRESET_DEFAULT", "renderer/app.js") + "\n";
  for (const n of IMPL_FNS) code += grabFn(src, n) + "\n";
  try {
    new Function("window", "document", "I18n", "S", "toast", "clampAssistW", code);
  } catch (e) {
    throw new Error("从 app-assist.js 抠出的构件编译不过（切割位置不对？）：" + (e && e.message));
  }
  return (
    "window.__compactImpl=(function(){\n" +
    "  var S = window.__probeS;\n" +
    "  function toast(){ window.__toastCalls.push(Array.prototype.slice.call(arguments)); }\n" +
    "  function clampAssistW(w){\n" +
    "    var half = Math.max(ASSIST_W_MIN, Math.floor((window.innerWidth || 1200) / 2));\n" +
    "    var n = Math.round(Number(w) || ASSIST_W_MIN);\n" +
    "    return Math.max(ASSIST_W_MIN, Math.min(half, n));\n" +
    "  }\n" +
    code +
    "  return { compactPolicyOf: compactPolicyOf, syncAssistCompactOptions: syncAssistCompactOptions," +
    " applyAssistCompactChoice: applyAssistCompactChoice, applyAssistCompactTrigger: applyAssistCompactTrigger," +
    " applyAssistCompactLimit: applyAssistCompactLimit, syncCompactLimitInputs: syncCompactLimitInputs," +
    " syncCompactCustomInput: syncCompactCustomInput, options: ASSIST_COMPACT_OPTIONS };\n" +
    "})();\n"
  );
}

/* ============================ 页内探针（真实 Blink 里执行） ============================ */
const I18N_SRC = fs.readFileSync(rel("renderer", "i18n.js"), "utf8");

const PROBE_SRC = String.raw`
window.__probe = (function () {
  function q(s, r) { return (r || document).querySelector(s); }
  function R(el) {
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { x: +r.left.toFixed(1), y: +r.top.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1),
             bottom: +r.bottom.toFixed(1) };
  }
  function ownText(el) {
    var s = "";
    if (!el) return s;
    for (var i = 0; i < el.childNodes.length; i++)
      if (el.childNodes[i].nodeType === 3) s += el.childNodes[i].nodeValue;
    return s.trim();
  }

  /* 探针配置：与运行时同一形状（persistAssistUi 就是读写这一坨） */
  window.__probeS = {
    config: { dsh: {} },
    assistMessages: [], assistLiveTools: [], assistW: 340,
    assistPreset: "minimal", assistProvider: "deepseek-official", assistModel: "",
    assistEffort: "high", assistWorkspace: "", assistScope: "current",
    assistGrill: true, assistPure: false, assistOpen: true, assistLive2d: false,
  };
  window.__savedConfigs = [];
  window.__toastCalls = [];
  window.api = {
    configSave: function (cfg) { window.__savedConfigs.push(JSON.parse(JSON.stringify(cfg))); return Promise.resolve(); },
  };

  /* 真实 i18n：词条齐不齐、切语言会不会回落中文，都在真表上验 */
  __I18N_SRC__;

  /* 应用代码：把真实 index.html 的 body 摆上来，再注入产品函数 */
  __IMPL_SRC__;

  function showAssist() {
    /* 助手栏默认是收起的（index.html 上带 hidden + CSS 只在 .layout.assist-open 时 display:flex）
       —— 不显式摊开就量不到布局：rect 全是 0，断言会「假绿」。这里按运行时的观感打开它。 */
    var pane = document.getElementById("assistPane");
    var layout = document.querySelector(".layout");
    if (layout) layout.classList.add("assist-open");
    document.body.classList.add("assist-open");
    pane.style.display = "";
    pane.hidden = false;
    pane.style.setProperty("--assist-w", "340px");
    var ctrl = document.getElementById("assistCtrl");
    ctrl.style.display = "flex";
    ctrl.hidden = false;
    return ctrl;
  }

  /* 走一次 product 的「打开助手栏即回刷」那条链（app-assist.js 的 renderAssistPanel 里那两句：
     档位清单 + 自定义触发线输入框） */
  function repaint() {
    window.__compactImpl.syncAssistCompactOptions(q("#assistCompactSel"));
    window.__compactImpl.syncCompactCustomInput(q("#assistCompactCustomInput"));
    window.__compactImpl.syncCompactLimitInputs();
  }

  function optionTexts() {
    var sel = q("#assistCompactSel");
    var out = [];
    for (var i = 0; i < sel.options.length; i++) out.push({ v: sel.options[i].value, t: sel.options[i].textContent });
    return out;
  }

  function layout() {
    var ctrl = showAssist();
    var compact = q("#assistCompactSel"), effort = q("#assistEffortSel");
    if (compact && compact.dataset && compact.dataset.bound !== "1") {
      compact.dataset.bound = "1";
      compact.onchange = function () { window.__compactImpl.applyAssistCompactChoice(compact.value); };
    }
    /* 自定义触发线输入框：按 app-boot.js 的接线原样接上（越界拒绝 → 回填当前生效值） */
    var tin = q("#assistCompactCustomInput");
    if (tin && tin.dataset && tin.dataset.bound !== "1") {
      tin.dataset.bound = "1";
      tin.onchange = function () {
        if (!window.__compactImpl.applyAssistCompactTrigger(tin.value))
          window.__compactImpl.syncCompactCustomInput(tin);
      };
    }
    /* 压缩后的大小两个输入框：按 app-boot.js 的接线原样接上（失败 → 回填当前生效值） */
    var bound = [["#assistCompactRetainInput", "retain"], ["#assistCompactSummaryInput", "summary"]];
    bound.forEach(function (pair) {
      var el = q(pair[0]);
      if (!el || (el.dataset && el.dataset.bound === "1")) return;
      el.dataset.bound = "1";
      el.onchange = function () {
        if (!window.__compactImpl.applyAssistCompactLimit(pair[1], el.value))
          window.__compactImpl.syncCompactLimitInputs();
      };
    });
    var cLabel = q('label.assist-ctrl-item:has(#assistCompactSel) span');
    return {
      inCtrl: !!ctrl && ctrl.contains(compact) && ctrl.contains(effort),
      sameRow: !!compact && !!effort && !!compact.closest("label") && compact.closest("label") !== effort.closest("label") &&
        compact.closest(".assist-ctrl-item") && effort.closest(".assist-ctrl-item"),
      compact: R(compact),
      effort: R(effort),
      labelText: ownText(cLabel),
      titleAttr: compact ? compact.getAttribute("title") || "" : "",
      optionCount: compact ? compact.options.length : 0,
    };
  }

  /* 改下拉 = 用户真的选一下（走 onchange，与 app-boot.js 的接线同一入口） */
  function choose(v) {
    var sel = q("#assistCompactSel");
    sel.value = v;
    sel.dispatchEvent(new Event("change"));
    return JSON.parse(JSON.stringify(window.__probeS.config.dsh.compact || null));
  }

  /* 填自定义触发线 = 用户在框里敲一个数（走 onchange，与 app-boot.js 同一入口） */
  function customSet(v) {
    var tin = q("#assistCompactCustomInput");
    tin.value = String(v);
    tin.dispatchEvent(new Event("change"));
    return JSON.parse(JSON.stringify(window.__probeS.config.dsh.compact || null));
  }

  /* 填「压缩后的大小」两个框（kind = retain / summary；走 onchange，与 app-boot.js 同一入口） */
  function sizeSet(kind, v) {
    var el = q(kind === "retain" ? "#assistCompactRetainInput" : "#assistCompactSummaryInput");
    el.value = v === null || v === undefined ? "" : String(v);
    el.dispatchEvent(new Event("change"));
    return JSON.parse(JSON.stringify(window.__probeS.config.dsh.compact || null));
  }
  function sizeState() {
    var r = q("#assistCompactRetainInput"), s = q("#assistCompactSummaryInput");
    return {
      retainValue: r.value, retainPlaceholder: r.placeholder,
      summaryValue: s.value, summaryPlaceholder: s.placeholder,
      inCtrl: !!document.getElementById("assistCtrl").contains(r) &&
        !!document.getElementById("assistCtrl").contains(s),
    };
  }

  /* 切语言：真 i18n.setLocale（app-boot.js 的 applyLocale 走的就是它） */
  function setLocale(loc) { I18n.setLocale(loc); repaint(); }

  return {
    ready: function () {
      showAssist();
      repaint();
      return !!q("#assistCompactSel");
    },
    repaint: repaint, optionTexts: optionTexts, layout: layout, choose: choose, customSet: customSet,
    sizeSet: sizeSet, sizeState: sizeState,
    setLocale: setLocale,
    setConfig: function (o) { window.__probeS.config.dsh.compact = o; repaint(); },
    currentValue: function () { return q("#assistCompactSel").value; },
    customState: function () {
      var row = q("#assistCompactCustom"), tin = q("#assistCompactCustomInput");
      /* #assistCompactFrugalNote 已按本轮要求整体撤掉：这里保留取值（恒 null）只为了让上面
         的断言能明确钉住「那一行长说明句真的不在了」，而不是悄悄消失 */
      var note = q("#assistCompactFrugalNote");
      return {
        rowHidden: row ? !!row.hidden : null,
        value: tin ? tin.value : null,
        noteHidden: note ? !!note.hidden : null,
      };
    },
    savedCount: function () { return window.__savedConfigs.length; },
    lastSavedCompact: function () {
      var last = window.__savedConfigs[window.__savedConfigs.length - 1] || {};
      return (last.dsh && last.dsh.compact) || null;
    },
    toasts: function () { return window.__toastCalls.map(function (a) { return String(a[0] || ""); }); },
  };
})();
`;

/* ============================ 探针页 ============================ */
function probeHtml() {
  const html = fs.readFileSync(rel("renderer", "index.html"), "utf8");
  const m = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  if (!m) throw new Error("renderer/index.html 里没有解析到 <body>");
  const body = m[1].replace(/<script[\s\S]*?<\/script>/gi, "");
  const styleEntry = fs.readFileSync(rel("renderer", "style.css"), "utf8");
  const names = [];
  const re = /@import\s+url\(["']?([^"')]+)["']?\)/g;
  let mm;
  while ((mm = re.exec(styleEntry))) names.push(mm[1]);
  if (!names.length) throw new Error("renderer/style.css 没有解析到 @import 分片");
  let css = "";
  for (const n of names)
    css += "\n/* ==== " + n + " ==== */\n" + fs.readFileSync(path.join(rel("renderer"), n.split("/").join(path.sep)), "utf8");
  const baseHref = "file:///" + rel("renderer").split(path.sep).join("/").replace(/\/$/, "") + "/";
  const probe = PROBE_SRC.replace("__I18N_SRC__", I18N_SRC).replace("__IMPL_SRC__", implInjection());
  return (
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><base href="' + baseHref + '">' +
    "<style>" + css + "</style></head><body>" + body +
    "\n<script>" + probe + "</scr" + "ipt></body></html>"
  );
}

async function main() {
  const { app, BrowserWindow } = require("electron");
  try {
    app.setPath("userData", path.join(os.tmpdir(), "mtnode-smoke-assist-compact-userdata"));
  } catch (_) {}
  app.commandLine.appendSwitch("disable-gpu");

  let checks = 0;
  let fails = 0;
  const ok = (cond, msg) => {
    checks++;
    if (cond) console.log("  ok    " + msg);
    else {
      fails++;
      console.log("FAIL  " + msg);
    }
  };

  await app.whenReady();
  const tmp = path.join(os.tmpdir(), "mtnode-smoke-assist-compact.html");
  fs.writeFileSync(tmp, probeHtml(), "utf8");

  const win = new BrowserWindow({
    show: false,
    useContentSize: true,
    width: 1280,
    height: 820,
    webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: false, contextIsolation: true, nodeIntegration: false },
  });
  await win.loadFile(tmp);
  const run = (expr) => win.webContents.executeJavaScript(expr, true);

  console.log("\n[1] 真实 DOM：压缩这一格落在「思考强度」下一行");
  ok(await run("!!window.__probe && window.__probe.ready()"), "探针页摆好：真实 index.html body + 真实样式 + 产品函数已注入");
  const lay = await run("window.__probe.layout()");
  ok(lay.inCtrl, "压缩下拉与思考强度下拉同属 #assistCtrl（没跑到别处去）");
  ok(!!lay.sameRow, "两格各占一条 .assist-ctrl-item 行（没有并进同一格）");
  ok(lay.compact && lay.effort, "两格都真的渲染出来了（有布局矩形）");
  ok(
    !!lay.compact && lay.compact.h > 0 && !!lay.effort && lay.effort.h > 0,
    "两格都量到了真实高度（h " + (lay.compact && lay.compact.h) + " / " + (lay.effort && lay.effort.h) + "，不是 0 高——否则「下方」会假绿）",
  );
  ok(
    lay.compact && lay.effort && lay.compact.y >= lay.effort.bottom - 0.5,
    "压缩这一格整格在思考强度那一格下方（top " + (lay.compact && lay.compact.y) + " ≥ bottom " + (lay.effort && lay.effort.bottom) + "）",
  );
  ok(lay.labelText === "上下文压缩", "行标签就是「上下文压缩」（实测：" + lay.labelText + "）");
  ok(/上下文压缩时机/.test(lay.titleAttr), "下拉带中文悬浮说明（tooltip 真落到了 DOM 上）");
  ok(lay.optionCount === 5, "五档（关闭 / 省钱 / 中 / 晚 / 自定义），实测 " + lay.optionCount + " 项");

  console.log("\n[2] 与「设置 · 智能能力」同一份值的回显");
  const opts0 = await run("window.__probe.optionTexts()");
  ok(
    opts0.map((o) => o.v).join(",") === "off,frugal,mid,late,custom",
    "档位值顺序 = off,frugal,mid,late,custom（省钱排最前、自定义排最后，与设置面板同一张表）",
  );
  ok(await run("window.__probe.currentValue()") === "mid", "缺省配置回显「中」（缺省 = 开 · 中档，与组合里的 0.3 / 32768 对得上）");
  await run('window.__probe.setConfig({ enabled: false, tier: "late" })');
  ok(await run("window.__probe.currentValue()") === "off", "enabled:false 回显「关闭」（不按 tier 显示，用户看到的就是关掉了）");
  await run('window.__probe.setConfig({ tier: "nonsense" })');
  ok(await run("window.__probe.currentValue()") === "mid", "非法档位回落「中」（脏值不会写进组合）");
  await run('window.__probe.setConfig({ tier: "early" })');
  ok(await run("window.__probe.currentValue()") === "mid", "已下线的早档旧值也回显「中」（老配置在界面上归一）");

  console.log("\n[3] 改一下 = 写进同一份配置并落盘");
  await run('window.__probe.setConfig({ enabled: true, tier: "mid" })');
  const before = await run("window.__probe.savedCount()");
  const afterFrugal = await run('window.__probe.choose("frugal")');
  ok(afterFrugal && afterFrugal.enabled === true && afterFrugal.tier === "frugal",
    "选「省钱」→ config.dsh.compact.tier = 'frugal'（≈100k 触发那一档）");
  ok((await run("window.__probe.savedCount()")) === before + 1, "选完走 persistAssistUi → configSave 落盘一次（不是只改内存）");
  const savedFrugal = await run("window.__probe.lastSavedCompact()");
  ok(savedFrugal && savedFrugal.tier === "frugal" && savedFrugal.enabled === true,
    "落盘那份里带的就是新档（main.js 的 syncCompactPolicy 读的就是它）");
  const afterOff = await run('window.__probe.choose("off")');
  ok(afterOff && afterOff.enabled === false && afterOff.tier === "frugal", "选「关闭」→ enabled:false 且保留原档 frugal（再打开回到原档）");
  ok(await run("window.__probe.currentValue()") === "off", "关闭后下拉回显仍是「关闭」");
  const afterLate = await run('window.__probe.choose("late")');
  ok(afterLate && afterLate.enabled === true && afterLate.tier === "late", "再选「晚」→ 开起来并落到 late（各档都能选到）");

  console.log("\n[3b] 自定义档：就地填触发线（越界拒绝、合法值落盘并切档）");
  const afterCustom = await run('window.__probe.choose("custom")');
  ok(afterCustom && afterCustom.tier === "custom" && afterCustom.customTriggerTokens === 100000,
    "选「自定义」→ tier:'custom' 且带上缺省触发线 100k（不填也有值）");
  const inState = await run("window.__probe.customState()");
  ok(inState.rowHidden === false, "选了自定义 → 输入框那一行露出");
  ok(inState.value === "100000", "输入框回填当前生效值（实测：" + inState.value + "）");
  const beforeCustom = await run("window.__probe.savedCount()");
  const customOk = await run('window.__probe.customSet(250000)');
  ok(customOk && customOk.customTriggerTokens === 250000 && customOk.tier === "custom", "填 250k → 触发线写进 config.dsh.compact");
  ok((await run("window.__probe.savedCount()")) === beforeCustom + 1, "合法值落盘一次（configSave 真被调用）");
  const customBad = await run('window.__probe.customSet(9000)');
  ok(customBad && customBad.customTriggerTokens === 250000, "越界（9000）被拒绝：配置里仍是上一个合法值");
  const badState = await run("window.__probe.customState()");
  ok(badState.value === "250000", "越界后输入框回填成当前生效值（界面不留脏数）");
  const toastsCustom = await run("window.__probe.toasts()");
  ok(toastsCustom.some((t) => /自定义触发线要填/.test(t)), "越界有明确提示（提示语进了 toast）");
  const noteState = await run('window.__probe.choose("frugal")');
  ok(!!noteState, "选回省钱档正常");
  const noteOn = await run("window.__probe.customState()");
  ok(noteOn.rowHidden === true && noteOn.noteHidden === null,
    "省钱档：输入框收起，且不再有那一行长说明句（档位文案只留「档位名 · 上下文阈值」）");
  const noteOff = await run('window.__probe.choose("mid")');
  ok(!!noteOff, "选回中档正常");
  const midState = await run("window.__probe.customState()");
  ok(midState.noteHidden === null, "中档同样没有说明句（该说明句已整体撤掉，不是只在某档隐藏）");
  const toasts = await run("window.__probe.toasts()");
  ok(toasts.some((t) => /下一个新会话生效/.test(t)), "每次改都提示「下一个新会话生效」（口径与设置面板一致）");

  console.log("\n[3c] 压缩后的大小：两个输入框（留空 = 跟随档位、越界拒绝、切档位清空）");
  await run('window.__probe.setConfig({ enabled: true, tier: "mid" })');
  const blank = await run("window.__probe.sizeState()");
  ok(blank.inCtrl, "两个输入框都在 #assistCtrl 里（与压缩档同一条控制区）");
  ok(blank.retainValue === "" && blank.retainPlaceholder === "32768",
    "保留原文留空 + 占位符 = 中档默认 32,768（实测：" + blank.retainPlaceholder + "）");
  ok(blank.summaryValue === "" && blank.summaryPlaceholder === "256000",
    "摘要上限留空 + 占位符 = 默认 256,000（实测：" + blank.summaryPlaceholder + "）");
  const sizeOk = await run('window.__probe.sizeSet("retain", 65536)');
  ok(sizeOk && sizeOk.retainTokens === 65536, "填 65,536 → 保留原文写进 config.dsh.compact");
  const sizeBad = await run('window.__probe.sizeSet("summary", 900000)');
  ok(sizeBad && sizeBad.summaryMaxTokens === null, "摘要上限 900,000 越界 → 拒绝、配置里仍是跟随档位（null）");
  const sizeBadState = await run("window.__probe.sizeState()");
  ok(sizeBadState.summaryValue === "", "越界后输入框回填成空（= 跟随档位，界面不留脏数）");
  const sizeToast = await run("window.__probe.toasts()");
  ok(sizeToast.some((t) => /摘要上限要填 4K – 256K/.test(t)), "越界有明确提示（提示语进了 toast）");
  const sizeSum = await run('window.__probe.sizeSet("summary", 8192)');
  ok(sizeSum && sizeSum.summaryMaxTokens === 8192 && sizeSum.retainTokens === 65536,
    "两个量互不覆盖（改摘要上限不丢保留原文）");
  const cleared = await run('window.__probe.choose("late")');
  ok(cleared && cleared.retainTokens === null && cleared.summaryMaxTokens === null,
    "切档位 → 两个自定义值清空（回到该档默认）");
  const blankAgain = await run("window.__probe.sizeState()");
  ok(blankAgain.retainPlaceholder === "65536" && blankAgain.retainValue === "",
    "切到晚档后占位符 = 65,536（档位默认跟着档走）");

  console.log("\n[4] 切语言：选项文字跟着换（英文界面不回落中文）");
  await run('window.__probe.setConfig({ enabled: true, tier: "mid" })');
  await run('window.__probe.setLocale("en")');
  const optsEn = await run("window.__probe.optionTexts()");
  ok(optsEn.length === 5 && optsEn[0].t === "Close", "英文界面第一档 = Close");
  ok(
    optsEn.slice(1).every((o) => !/[\u4e00-\u9fa5]/.test(o.t)),
    "英文界面后四档没有中文残留（" + optsEn.slice(1).map((o) => o.t.slice(0, 12)).join(" | ") + "）",
  );
  await run('window.__probe.setLocale("zh")');
  const optsZh = await run("window.__probe.optionTexts()");
  ok(optsZh[0].t === "关闭", "切回中文第一档 = 关闭");
  ok(/省钱/.test(optsZh[1].t) && /自定义/.test(optsZh[4].t), "切回中文：省钱 / 自定义两档文案都在");

  const exitWith = (code) => {
    try { fs.unlinkSync(tmp); } catch (_) {}
    console.log(
      "\n" + (code === 0 ? "✓" : "✗") + " " + (checks - fails) + " / " + checks + " 项" +
        (code === 0 ? "全部通过" : "里有 " + fails + " 项失败") + "  (smoke-assist-compact)",
    );
    app.exit(code);
  };
  exitWith(fails ? 1 : 0);
}
