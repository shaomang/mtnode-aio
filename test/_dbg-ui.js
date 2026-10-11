"use strict";
/* 安装窗 UI 真跑（假 DOM + vm 加载 install/_dbg-app.js 的真源码）
 *   node test/smoke-install-window-ui.js
 *
 * 为什么要有这一只：install/app.js 是纯渲染层脚本，主进程冒烟（smoke-install-window.js）只能用正则
 * 钉它「写了什么」，钉不住「跑起来对不对」。这里用最小 DOM 桩把 install/index.html 里的 id 全建出来，
 * 再把 install/app.js 原样跑起来，然后真的去点按钮，看它调了哪条桥、传了什么参数。
 *
 * 锁住的口径：
 *   [1] 加载即无异常：app.js 引用的每个 DOM id 都真在 index.html 里（删了界面忘删 JS 会当场抛）
 *   [2] 失败态给的手动路径：「重试」摆在第一位（重跑安装脚本），「交给 mtnode 会话修复」是次要入口
 *   [3] 桥签名分派：后端插件传 { action }、窗口插件传**插件 id 字符串**（appPlugins:install(id)）
 *   [4] 安装目录：本窗有「选择安装目录」（按插件取 PickInstallDir 桥）
 *   [5] 权重指路：常驻入口 → 添加目录 / 扫描预览 / 移动并就位 / 取消 / 清空，进度与终局都落到界面上
 *   [6] 硬件门槛逃生阀：只有 sensenova 显示，勾了才透传 forceHardware
 *   [7] 日志区（本轮需求）：默认「全部日志」按真实输出顺序 / 点步骤切到该步日志 / 再点「全部日志」回全文 /
 *       失败时自动只给末尾 240 行（脚本崩溃那一段默认摆在眼前）/ 空态块（.ins-empty）整块已删、没会话时留空
 *   [8] 「复制日志」（本轮需求）：navigator → 主进程桥 → execCommand 三级兜底（前一级失败才往下走），
 *       只有真写成功才说成功；三级全挂时把日志整段选中并如实提示按 Ctrl+C
 *   [9] 「卸载」（本轮需求）：底栏那颗只在安装态给；点它先拉预览清单（删什么 / 留什么）再要确认，
 *       确认才真删；卸载中可停手；卸载那一次的按钮组是「确认卸载 / 取消 / 重试」而不是安装那一套
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

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
const html = fs.readFileSync(path.join(ROOT, "install/index.html"), "utf8");
const src = fs.readFileSync(path.join(ROOT, "install/app.js"), "utf8");
/** 让挂起的一轮微任务跑完：窗里的桥都是 async（adopt 后重拉权重现场、点键后回填），断言前要等一拍 */
const tick = () => new Promise((r) => setTimeout(r, 0));

/* ── 最小 DOM 桩：只实现 app.js 真用到的那几样 ── */
function mkEl(tag) {
  const el = {
    tagName: tag || "div",
    id: "",
    className: "",
    textContent: "",
    title: "",
    hidden: false,
    disabled: false,
    checked: false,
    style: {},
    dataset: {},
    children: [],
    onclick: null,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    /* innerHTML = "" 是真清空（app.js 每次重画步骤表都这么干）：不清 children 会让断言看到上一轮的旧行 */
    get innerHTML() {
      return this._html || "";
    },
    set innerHTML(v) {
      this._html = String(v == null ? "" : v);
      if (!this._html) this.children = [];
    },
    appendChild(c) {
      this.children.push(c);
      c.parentNode = this;
      return c;
    },
    removeChild(c) {
      this.children = this.children.filter((x) => x !== c);
      return c;
    },
    querySelector(sel) {
      if (sel === "i") return (this._i = this._i || mkEl("i"));
      return null;
    },
    querySelectorAll() {
      return [];
    },
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    getAttribute() {
      return null;
    },
    focus() {},
    select() {
      mkEl._lastSelected = this;
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    },
    classList: {
      _s: new Set(),
      add(...n) {
        n.forEach((x) => this._s.add(x));
      },
      remove(...n) {
        n.forEach((x) => this._s.delete(x));
      },
      toggle(n, on) {
        if (on === undefined) this._s.has(n) ? this._s.delete(n) : this._s.add(n);
        else if (on) this._s.add(n);
        else this._s.delete(n);
      },
      contains(n) {
        return this._s.has(n);
      },
    },
  };
  return el;
}
const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
const els = new Map();
for (const id of ids) {
  const el = mkEl("div");
  el.id = id;
  els.set(id, el);
}
const documentStub = {
  getElementById: (id) => els.get(id) || null,
  createElement: mkEl,
  addEventListener() {},
  querySelectorAll() {
    return [];
  },
  body: mkEl("body"),
  baseURI: "file:///install/index.html",
  /* execCommand / Range / Selection：剪贴板兜底链与「全选日志」要用（默认允许，测试里可临时关掉） */
  execCommand: () => execAllows,
  createRange: () => ({
    selectNodeContents(el) {
      selectedEl = el;
    },
  }),
};
let execAllows = true;
let selectedEl = null;
const windowStub = {
  getSelection: () => ({
    removeAllRanges() {},
    addRange() {},
  }),
};

/* ── window.mtnodeInstall 桩：把每次调用记下来，按 action 回一份可用的现场 ── */
const calls = [];
const subs = {};
let weightsState = {
  ok: true,
  id: "",
  supported: false,
  info: null,
  label: "",
  sources: [],
  moving: false,
  last: null,
};
function weightsReply(p) {
  const action = String((p && p.action) || "info");
  if (action === "scan") {
    return {
      ok: true,
      id: p.id,
      label: "MiniMax H3 权重（ComfyUI）",
      installDir: "D:\\inst",
      slots: [{ id: "diffusion_models", label: "扩散模型", dir: "D:\\inst\\ComfyUI\\models\\diffusion_models", count: 2, bytes: 2048 }],
      total: { count: 2, bytes: 2048 },
      unmatched: [],
      unmatchedCount: 0,
      sample: [],
    };
  }
  if (action === "move") return { ok: true, started: true, files: 2, bytes: 2048 };
  if (action === "cancel") return { ok: true };
  if (action === "pick") {
    weightsState = Object.assign({}, weightsState, { sources: ["E:\\dl\\MiniMax-H3"] });
    return weightsState;
  }
  if (action === "remove") {
    weightsState = Object.assign({}, weightsState, { sources: [] });
    return weightsState;
  }
  if (action === "reset") {
    weightsState = Object.assign({}, weightsState, { sources: [], last: null });
    return weightsState;
  }
  return Object.assign({}, weightsState, { id: String((p && p.id) || weightsState.id || "") });
}
/* 卸载桥的桩：默认回一份「删安装目录」的预览；uninstallPreviewFails 时回错（窗要如实说，不盲删） */
let uninstallPreviewFails = false;
function uninstallReply(p) {
  const action = String((p && p.action) || "preview");
  if (uninstallPreviewFails && action === "preview") {
    return { ok: false, error: "need_root", message: "还没设置插件根目录，取不到要删的目录。" };
  }
  if (action === "preview") {
    return {
      ok: true,
      id: String((p && p.id) || ""),
      label: "llama.cpp 本地模型",
      route: "root",
      installDir: "D:\\llama",
      targets: [{ path: "D:\\llama", rel: "", note: "整个安装目录（含虚拟环境 / 模型 / 脚手架）" }],
      items: [{ name: ".venv", note: "目录" }, { name: "models", note: "目录" }],
      note: "只删这一个插件的安装目录；插件自己的目录设置保留。",
      keepHint: "你下载的 GGUF 模型文件按你自己的选择保留。",
    };
  }
  if (action === "run") return { ok: true, started: true, id: String((p && p.id) || ""), installDir: "D:\\llama" };
  return { ok: true };
}
/* 剪贴板三级的可调开关：navigator 那级由 navigatorStub.writeText 决定（默认成功），
   主进程桥那级由 clipboardFails 决定，最后一级 execCommand 由 execAllows 决定。 */
let clipboardFails = false;
let navigatorFails = false;
const navigatorStub = {
  language: "zh-CN",
  clipboard: {
    writeText: (t) => {
      calls.push({ name: "navigator", args: [t] });
      return navigatorFails ? Promise.reject(new Error("NotAllowedError")) : Promise.resolve();
    },
  },
};
const win = {
  mtnodeInstall: {
    state: async () => ({ ok: true, session: null }),
    open: async () => ({ ok: true }),
    close: async () => ({ ok: true }),
    cancel: async () => ({ ok: true }),
    fix: async () => ({ ok: true }),
    openConsole: async () => ({ ok: true }),
    api: async (name, args) => {
      calls.push({ name: "api:" + name, args: args || [] });
      /* 复制日志的稳路：白名单里的 clipboardWriteText → 主窗口那条 electron clipboard 桥。
         默认答 ok，测试里可临时让它失败。 */
      if (String(name) === "clipboardWriteText") {
        if (clipboardFails) return { ok: false, error: "clipboard_unavailable" };
        return { ok: true };
      }
      return { ok: true };
    },
    weights: async (p) => {
      calls.push({ name: "weights:" + String((p && p.action) || "info"), args: [p] });
      return weightsReply(p);
    },
    uninstall: async (p) => {
      calls.push({ name: "uninstall:" + String((p && p.action) || "preview"), args: [p] });
      return uninstallReply(p);
    },
    onState: (cb) => {
      subs.state = cb;
      return () => {};
    },
    onEvent: (cb) => {
      subs.event = cb;
      return () => {};
    },
    onWeights: (cb) => {
      subs.weights = cb;
      return () => {};
    },
  },
};

/* 整只窗的驱动都要 await（桥是 async）—— 包一层 async 主流程，末尾统一收口 */
(async () => {
console.log("[1] 加载 install/app.js（假 DOM + 假桥），不抛异常");
let loadErr = null;
try {
  vm.runInNewContext(src, {
    window: Object.assign(win, windowStub),
    document: documentStub,
    navigator: navigatorStub,
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    console,
  });
} catch (e) {
  loadErr = e;
}
ok(!loadErr, "app.js 原样跑得起来" + (loadErr ? "（" + loadErr.message + "）" : ""));
if (loadErr) {
  console.log("\nFAILED 1 / 1 checks");
  process.exit(1);
}
ok(typeof subs.state === "function" && typeof subs.event === "function", "订阅了状态帧与事件流");
ok(typeof subs.weights === "function", "订阅了权重搬运事件");
ok(els.get("btnLogFollow").onclick !== null, "日志跟随键挂上了处理");
ok(els.get("insWMove").onclick !== null, "权重「移动并就位」键挂上了处理");
/* 首帧那条 api.state("") 的 then 会 adopt(null)（空态）—— 先让它落地，后面的会话才不会被它盖掉 */
await tick();

/* 文本收集：桩的 textContent 不聚合子节点，这里自己往下收 */
function textOf(el) {
  if (!el) return "";
  let s = String(el.textContent || "");
  for (const c of el.children || []) s += textOf(c);
  return s;
}

/* 造一份会话：驱动窗进入该状态；等一拍让 adopt 里那次「重拉权重现场」的桥调用落地 */
async function adopt(session) {
  subs.state(Object.assign({ logs: {} }, session));
  await tick();
}
function btnLabels() {
  return (els.get("insActions").children || []).map((b) => String(b.textContent || ""));
}
function clickBtn(label) {
  const b = (els.get("insActions").children || []).find((x) => String(x.textContent || "") === label);
  if (!b) throw new Error("找不到按钮：" + label);
  return b.onclick();
}

console.log("\n[2] 失败态：手动重试第一位，会话修复次要");
await adopt({
  pluginId: "llama-local",
  name: "llama.cpp 本地模型",
  installDir: "D:\\llama",
  state: "failed",
  pct: 18,
  error: "pip 装不上",
  steps: [{ id: "pip", title: "安装 Python 依赖", status: "fail", message: "pip 装不上" }],
  logs: { pip: "ERROR: ..." },
});
const labels = btnLabels();
ok(labels.indexOf("重试") >= 0, "失败后有「重试」");
ok(labels.indexOf("交给 mtnode 会话修复") >= 0, "失败后仍给「交给 mtnode 会话修复」（次要入口）");
ok(labels.indexOf("选择安装目录") >= 0, "安装目录改由本窗选（有「选择安装目录」）");
ok(labels.indexOf("打开插件控制台") >= 0, "失败后仍能开控制台看后端日志");
ok(labels.indexOf("复制日志") >= 0 && labels.indexOf("完成并关闭") >= 0, "复制日志 / 完成并关闭照旧");
ok(labels.indexOf("重试") < labels.indexOf("交给 mtnode 会话修复"), "「重试」排在会话修复之前");

calls.length = 0;
clickBtn("重试");
const retryCall = calls.find((c) => c.name === "api:llamaInstall");
setTimeout(() => {}, 0);
ok(!!retryCall, "点「重试」→ 重跑该插件的安装桥（llamaInstall）");
ok(retryCall && retryCall.args[0] && retryCall.args[0].action === "install", "重试带上 { action: \"install\" }（脚本自己续跑）");

console.log("\n[3] 桥签名分派：窗口插件传插件 id 字符串");
calls.length = 0;
await adopt({
  pluginId: "somewindowplugin",
  name: "窗口插件",
  installDir: "D:\\data\\app-plugins\\somewindowplugin",
  state: "idle",
  pct: 0,
  steps: [{ id: "prepare", title: "准备安装信息", status: "pending" }],
  logs: {},
});
ok(btnLabels().indexOf("开始安装") >= 0, "idle 态给「开始安装」");
clickBtn("开始安装");
const wpCall = calls.find((c) => c.name === "api:appPluginsInstall");
ok(!!wpCall, "窗口插件走 appPluginsInstall 桥");
ok(wpCall && wpCall.args[0] === "somewindowplugin", "窗口插件传的是**插件 id 字符串**（不是选项对象）");

console.log("\n[4] 权重指路：常驻入口 → 添加 / 预览 / 移动 / 取消 / 清空");
calls.length = 0;
weightsState = {
  ok: true,
  id: "minimax-h3",
  supported: true,
  info: {
    id: "minimax-h3",
    label: "MiniMax H3 权重（ComfyUI）",
    installDir: "D:\\h3",
    slots: [
      { id: "diffusion_models", label: "扩散模型", dir: "D:\\h3\\ComfyUI\\models\\diffusion_models", rel: "ComfyUI\\models\\diffusion_models" },
      { id: "vae", label: "VAE", dir: "D:\\h3\\ComfyUI\\models\\vae", rel: "ComfyUI\\models\\vae" },
    ],
  },
  sources: [],
  moving: false,
  last: null,
};
await adopt({
  pluginId: "minimax-h3",
  name: "Minimax H3",
  installDir: "D:\\h3",
  state: "failed",
  pct: 0,
  error: "权重下载失败",
  steps: [{ id: "weights", title: "下载 MiniMax H3 权重", status: "fail", message: "网络不通" }],
  logs: {},
});
ok(btnLabels().indexOf("指定权重位置…") >= 0, "有权重能力的插件显示常驻入口「指定权重位置…」");
ok(els.get("insWeights").hidden === false, "权重区块显示出来");
ok(els.get("insWBody").hidden === true, "默认收起（不占地方）");
clickBtn("指定权重位置…");
ok(els.get("insWBody").hidden === false, "点开后展开");
ok(String(els.get("insWTitle").textContent).indexOf("MiniMax H3") >= 0, "标题写明是哪个插件的权重");
const targets = textOf(els.get("insWTargets"));
ok(targets.indexOf("diffusion_models") >= 0 && targets.indexOf("vae") >= 0, "列出每个槽位的目标目录");

calls.length = 0;
els.get("insWAdd").onclick();
await tick();
ok(calls.some((c) => c.name === "weights:pick"), "「添加目录…」走 weights pick（系统目录选择框）");
const srcText = textOf(els.get("insWSources"));
ok(srcText.indexOf("MiniMax-H3") >= 0, "已指定的源目录列出来");
ok(btnLabels().indexOf("收起权重指路") >= 0, "入口按钮翻成「收起权重指路」");

calls.length = 0;
els.get("insWScan").onclick();
await tick();
ok(calls.some((c) => c.name === "weights:scan"), "「扫描并预览」只看不搬");
ok(String(els.get("insWPreview").textContent).indexOf("2 个文件") >= 0, "预览写明每个槽位几个文件 / 多少体积");calls.length = 0;
els.get("insWMove").onclick();
await tick();
ok(calls.some((c) => c.name === "weights:move"), "「移动并就位」才真搬");
calls.length = 0;
els.get("insWCancel").onclick();
await tick();
ok(calls.some((c) => c.name === "weights:cancel"), "「取消搬运」有对应动作");
calls.length = 0;
els.get("insWReset").onclick();
await tick();
ok(calls.some((c) => c.name === "weights:reset"), "「清空」清掉已选源目录");

/* 进度与终局：事件落到界面上 */
subs.weights({ id: "minimax-h3", kind: "progress", index: 3, count: 10, bytesDone: 1024, bytesTotal: 4096, file: "x.safetensors" });
ok(els.get("insWProg").hidden === false, "搬运中显示进度条");
ok(String(els.get("insWResult").textContent).indexOf("3/10") >= 0, "进度行写明第几个 / 共几个");
subs.weights({
  id: "minimax-h3",
  kind: "done",
  last: { ok: true, moved: 10, failedCount: 0, unmatchedCount: 1, bytesText: "1.50 GB", note: "权重已就位 —— 点「重试」继续安装" },
});
ok(els.get("insWProg").hidden === true, "搬完收起进度条");
ok(String(els.get("insWResult").textContent).indexOf("权重已就位") >= 0, "搬完提示「权重已就位」");
ok(String(els.get("insWResult").textContent).indexOf("1.50 GB") >= 0, "结果里带上搬了多少体积");
ok(String(els.get("insWResult").textContent).indexOf("未识别") >= 0, "认不出的条目如实报（留在原地）");

console.log("\n[5] 硬件门槛逃生阀：只有 sensenova 显示，勾了才透传");
ok(els.get("insForceHwBox").hidden === true, "h3 这类没有硬件门槛的插件不显示该开关");
calls.length = 0;
weightsState = Object.assign({}, weightsState, { id: "sensenova-local", supported: true, info: { id: "sensenova-local", label: "SenseNova 权重", installDir: "D:\\sn", slots: [] }, sources: [], last: null });
await adopt({
  pluginId: "sensenova-local",
  name: "SenseNova",
  installDir: "D:\\sn",
  state: "failed",
  pct: 0,
  error: "vram_too_low",
  steps: [{ id: "nvidia", title: "检测显卡", status: "fail", message: "显存 <20GB" }],
  logs: {},
});
ok(els.get("insForceHwBox").hidden === false, "sensenova 显示「忽略硬件门槛」");
els.get("insForceHw").checked = false;
clickBtn("重试");
const noForce = calls.find((c) => c.name === "api:sensenovaInstall");
ok(noForce && noForce.args[0] && noForce.args[0].forceHardware === undefined, "没勾时不透传 forceHardware（照原门槛）");
calls.length = 0;
els.get("insForceHw").checked = true;
clickBtn("重试");
const forced = calls.find((c) => c.name === "api:sensenovaInstall");
ok(forced && forced.args[0] && forced.args[0].forceHardware === true, "勾了才透传 forceHardware: true");

console.log("\n[6] 空态（已删）与无权重能力的插件");
weightsState = { ok: true, id: "", supported: false, info: null, label: "", sources: [], moving: false, last: null };
calls.length = 0;
await adopt({
  pluginId: "llama-local",
  name: "llama.cpp",
  installDir: "D:\\llama",
  state: "done",
  pct: 100,
  steps: [],
  logs: {},
});
ok(els.get("insWeights").hidden === true, "没有权重能力的插件整块不显示");
ok(documentStub.getElementById("insEmpty") === null, "空态块已整块删除（页面里没有这个 id）");
ok(
  html.indexOf("当前没有正在跑的安装") < 0 && html.indexOf('id="insEmpty"') < 0 && html.indexOf("ins-empty") < 0,
  "空态文案、那个 id 与它的样式类都不在页面上（注释里也不提，免得日后被误当活代码找回来）",
);
await adopt({ empty: true });
ok(els.get("insMain").hidden === true && els.get("insFoot").hidden === true, "没会话时主区域与底栏都收掉（留空，不留占位块）");

/* ═════════════ [7] 日志区：默认「全部日志」/ 点步骤切步 / 失败只给末尾 240 行 ═════════════ */
console.log("\n[7] 日志区：默认全部日志（按真实输出顺序）+ 点步骤切步 + 失败给末尾 240 行");
function stepRows() {
  return els.get("insList").children || [];
}
function clickStep(idx) {
  const li = stepRows()[idx];
  if (!li) throw new Error("找不到第 " + idx + " 行步骤");
  return li.onclick();
}
calls.length = 0;
await adopt({
  pluginId: "breeze-tts-local",
  name: "Breeze TTS 2",
  installDir: "E:\\mtnode-test\\breeze",
  state: "running",
  pct: 80,
  steps: [
    { id: "deps", title: "安装依赖（锁定 gradio 版本）", status: "ok" },
    { id: "weights", title: "下载 Breeze TTS 2 权重", status: "run" },
  ],
  logs: { deps: "deps line 1", weights: "weights line 1" },
});
ok(stepRows().length === 3, "步骤表第一行是「全部日志」，后面才是各步（" + stepRows().length + " 行）");
ok(textOf(stepRows()[0]).indexOf("全部日志") >= 0, "第一行写明「全部日志」");
ok(String(stepRows()[0].className).indexOf("is-current") >= 0, "默认就停在「全部日志」上（不是某一具体步）");
const allText = String(els.get("insLog").textContent || "");
ok(allText.indexOf("deps line 1") >= 0 && allText.indexOf("weights line 1") >= 0, "「全部日志」把各步日志都摆出来");
ok(allText.indexOf("deps line 1") < allText.indexOf("weights line 1"), "按真实输出顺序排（先依赖、后权重）");
ok(allText.indexOf("安装依赖（锁定 gradio 版本）") >= 0, "段间带步骤小标题，能认出哪一段是哪一步");
/* 点某一步 → 只看那一步 */
clickStep(1);
ok(String(els.get("insLog").textContent).indexOf("deps line 1") >= 0 && String(els.get("insLog").textContent).indexOf("weights line 1") < 0, "点「依赖」只看那一步的日志");
ok(String(els.get("insLogTitle").textContent).indexOf("安装依赖") >= 0, "日志标题写明在看哪一步");
/* 事件追加：日志行落到当前订阅的那一段 */
subs.event({ id: "breeze-tts-local", kind: "log", stepId: "deps", line: "deps line 2", seq: 30 });
ok(String(els.get("insLog").textContent).indexOf("deps line 2") >= 0, "看着某一步时，那一步的新日志即时追加");
/* 回「全部日志」 */
clickStep(0);
ok(textOf(stepRows()[0]).indexOf("全部日志") >= 0 && String(els.get("insLog").textContent).indexOf("weights line 1") >= 0, "再点「全部日志」回到整场日志");
/* 失败：整篇只给末尾 240 行 —— 前面 100 行必须被截掉，最后一行必须在 */
const longLines = [];
for (let i = 1; i <= 400; i++) longLines.push("L" + i);
calls.length = 0;
await adopt({
  pluginId: "breeze-tts-local",
  name: "Breeze TTS 2",
  installDir: "E:\\mtnode-test\\breeze",
  state: "failed",
  pct: 80,
  error: "exit 1: Copy-Item : Cannot overwrite the item ... with itself.",
  steps: [
    { id: "deps", title: "安装依赖（锁定 gradio 版本）", status: "ok" },
    { id: "weights", title: "下载 Breeze TTS 2 权重", status: "fail", message: "exit 1" },
  ],
  logs: { deps: longLines.join("\n"), weights: "崩溃：Copy-Item ... with itself." },
});
const failedText = String(els.get("insLog").textContent || "");
ok(failedText.indexOf("崩溃：Copy-Item") >= 0, "失败时脚本崩溃那一段默认就在眼前（不用点步骤去找）");
ok(failedText.indexOf("L1\n") < 0, "整篇超长时只给末尾（L1 已被截掉）");
ok(failedText.indexOf("L400") >= 0, "末尾那一行还在（L400）");
ok(String(els.get("insLogTitle").textContent).indexOf("末尾 240 行") >= 0, "标题如实写明「末尾 240 行」");
ok(String(els.get("insLogTitle").title || "").indexOf("Copy-Item") >= 0 || failedText.indexOf("with itself") >= 0, "失败原因可复核（标题提示或正文里带原文）");
/* 失败态点某一步：那一步的日志照样是完整的（不被末尾裁剪影响） */
clickStep(1);
ok(String(els.get("insLog").textContent).indexOf("L1\n") >= 0, "点「依赖」那一步仍能看到它的完整日志（含 L1）");
clickStep(0);

/* ═════════════ [8] 复制日志：三级兜底 + 真校验 + 全挂时降级为全选 ═════════════ */
console.log("\n[8] 复制日志：navigator → 主进程桥 → execCommand，只有真写成功才说成功");
async function copyLog() {
  await clickBtn("复制日志");
  await tick();
  await tick();
}
/* ① navigator 通：只用第一级，不碰桥 */
calls.length = 0;
navigatorFails = false;
clipboardFails = false;
execAllows = true;
selectedEl = null;
await copyLog();
ok(calls.some((c) => c.name === "navigator"), "① navigator.clipboard 可用时走它");
ok(!calls.some((c) => c.name === "api:clipboardWriteText"), "第一级成功就不再往下调桥（不重复写）");
ok(String(els.get("insToast").textContent).indexOf("已复制") >= 0, "真写成功才提示「日志已复制」");
/* ② navigator 被拒（权限闸 / 未聚焦）：退到主进程桥 */
calls.length = 0;
navigatorFails = true;
clipboardFails = false;
await copyLog();
ok(
  calls.some((c) => c.name === "navigator") && calls.some((c) => c.name === "api:clipboardWriteText"),
  "② navigator 失败后退到主进程桥（白名单 clipboardWriteText → electron clipboard）",
);
ok(String(els.get("insToast").textContent).indexOf("已复制") >= 0, "桥写成功也如实提示已复制");
ok(
  String(((calls.find((c) => c.name === "api:clipboardWriteText") || {}).args || [])[0] || "").indexOf("崩溃：Copy-Item") >= 0,
  "桥拿到的是眼前这份日志正文（失败现场）",
);
/* ③ 桥也失败：退到 execCommand */
calls.length = 0;
clipboardFails = true;
execAllows = true;
await copyLog();
ok(calls.some((c) => c.name === "api:clipboardWriteText"), "③ 桥失败后仍往下退");
ok(String(els.get("insToast").textContent).indexOf("已复制") >= 0, "execCommand 成了也如实提示");
/* ④ 三级全挂：不假装成功，把日志整段选中并提示按 Ctrl+C */
execAllows = false;
selectedEl = null;
await copyLog();
ok(String(els.get("insToast").textContent).indexOf("复制失败") < 0 || String(els.get("insToast").textContent).indexOf("Ctrl+C") >= 0, "四级全挂时提示里给的是可执行动作（Ctrl+C），不只一句「复制失败」");
ok(String(els.get("insToast").textContent).indexOf("Ctrl+C") >= 0, "如实说明自动复制不可用，请按 Ctrl+C");
ok(selectedEl === els.get("insLog"), "兜底把日志区整段选中（用户可以直接 Ctrl+C）");
/* 恢复默认，免得影响后续断言 */
navigatorFails = false;
clipboardFails = false;
execAllows = true;
/* 复制的是**当前视图**：切到某一步时只复制那一步 */
calls.length = 0;
clickStep(1);
await copyLog();
const stepCopy = (calls.find((c) => c.name === "navigator") || {}).args[0] || "";
ok(stepCopy.indexOf("L1") >= 0 && stepCopy.indexOf("崩溃：Copy-Item") < 0, "看着某一步时，复制的是那一步的日志（不是整场）");
clickStep(0);

console.log("\n[9] 卸载：底栏「卸载」→ 预览清单 → 确认才删；卸载态是另一组按钮");
/* 安装态（done）就有「卸载」，且它是**非破坏**入口：点它只拉预览，不动盘 */
calls.length = 0;
await adopt({
  pluginId: "llama-local",
  name: "llama.cpp 本地模型",
  installDir: "D:\\llama",
  state: "done",
  pct: 100,
  steps: [{ id: "deps", title: "安装 Python 依赖", status: "ok" }],
  logs: { deps: "ok" },
});
ok(btnLabels().indexOf("卸载") >= 0, "装好之后底栏有「卸载」");
clickBtn("卸载");
await tick();
ok(calls.some((c) => c.name === "uninstall:preview"), "点「卸载」先拉预览清单（不直接删）");
ok(!calls.some((c) => c.name === "uninstall:run"), "还没确认就不会真删");
ok(els.get("insUnin").hidden === false, "确认块展开");
ok(textOf(els.get("insUninList")).indexOf("D:\\llama") >= 0, "清单里写明要删的目录");
ok(textOf(els.get("insUninList")).indexOf(".venv") >= 0, "清单里列出目录里的条目");
ok(textOf(els.get("insUninNote")).indexOf("保留") >= 0, "清单里写明保留什么");
console.log("   DEBUG labels=" + JSON.stringify(btnLabels()) + " unin.hidden=" + els.get("insUnin").hidden);
ok(btnLabels().indexOf("确认卸载") >= 0, "确认块里有「确认卸载」");
/* 取消 = 收起，什么都不删 */
calls.length = 0;
clickBtn("取消");
await tick();
ok(els.get("insUnin").hidden === true, "「取消」收起确认块");
ok(!calls.some((c) => c.name === "uninstall:run"), "取消不触发删除");

/* 真删：确认后走 run，卸载那一次进「正在卸载…」并给停手入口 */
calls.length = 0;
clickBtn("卸载");
await tick();
clickBtn("确认卸载");
await tick();
ok(calls.some((c) => c.name === "uninstall:run"), "点「确认卸载」才真删（走 run）");
ok(calls.some((c) => c.name === "uninstall:run" && c.args[0] && c.args[0].id === "llama-local"), "run 带上插件 id（主进程按它查路由表）");
ok(btnLabels().indexOf("正在卸载…") >= 0, "卸载进行中给「正在卸载…」（不再是「确认卸载」，免得连点两次）");
/* 还没跑完时主进程还没把快照落终局：窗自己知道在跑（快照仍可能是 done） */
calls.length = 0;
clickBtn("正在卸载…");
await tick();
ok(calls.some((c) => c.name === "uninstall:cancel"), "「正在卸载…」那颗就是停手口（走 cancel）");

/* 卸载那一次的会话（mode=uninstall）：按钮组换成卸载那一套，安装那套不再出现 */
calls.length = 0;
await adopt({
  pluginId: "llama-local",
  name: "llama.cpp 本地模型",
  action: "uninstall",
  mode: "uninstall",
  installDir: "",
  state: "failed",
  pct: 40,
  error: "uninstall_locked",
  steps: [{ id: "uninstall", title: "卸载并清理文件", status: "fail", message: "删不掉 D:\\llama\\.venv" }],
  logs: { uninstall: "删不掉 D:\\llama\\.venv：EBUSY" },
});
const unLabels = btnLabels();
ok(unLabels.indexOf("重试") >= 0, "卸载失败后给「重试」");
ok(unLabels.indexOf("卸载") >= 0, "也留着「卸载」（再展开一次清单）");
ok(unLabels.indexOf("开始安装") < 0 && unLabels.indexOf("重新安装") < 0, "卸载那一次不出现安装按钮（安装 / 重新安装）");
ok(unLabels.indexOf("选择安装目录") < 0, "卸载那一次不出现「选择安装目录」（目录已经没了）");
calls.length = 0;
clickBtn("重试");
await tick();
ok(calls.some((c) => c.name === "uninstall:run"), "卸载态点「重试」走的是卸载，不是安装");

/* 预览拉不到（如根目录没设）：如实报错，且不给「确认卸载」（绝不盲删） */
calls.length = 0;
uninstallPreviewFails = true;
await adopt({
  pluginId: "tts-local",
  name: "GPT-SoVITS",
  installDir: "",
  state: "done",
  pct: 100,
  steps: [],
  logs: {},
});
clickBtn("卸载");
await tick();
ok(textOf(els.get("insUninList")).indexOf("取不到卸载清单") >= 0, "拉不到清单时如实写明原因");
const confirmBtn = (els.get("insActions").children || []).find((b) => String(b.textContent || "") === "确认卸载");
ok(!!confirmBtn && confirmBtn.disabled === true, "清单都没有时「确认卸载」置灰（不盲删）");
uninstallPreviewFails = false;

console.log("\n" + (fails ? "FAILED " + fails + " / " + checks : "ALL PASS " + checks) + " checks");
process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error("FAIL  安装窗 UI 冒烟异常：" + ((e && e.stack) || e));
  process.exit(1);
});
