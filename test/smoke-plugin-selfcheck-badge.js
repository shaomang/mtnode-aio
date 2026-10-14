"use strict";
/**
 * 插件卡片「安装后自检通过」勾角标 —— 真跑（假 DOM + 从 renderer/app-plugins.js 抽出本轮那几个函数）
 *   node test/smoke-plugin-selfcheck-badge.js
 *
 * 为什么要这一只：主进程侧的口径由 smoke-install-window.js 钉住（内核真跑 + 安装窗接线），
 * 但「卡片封面左上角那个勾到底画没画、画给谁」是**渲染层真跑**才看得出来的事：
 *   · 只给自检**通过**的卡片画勾（失败 / 跳过 / 没测过一律没有）；
 *   · 判据来自主进程回的那份自检快照（不是渲染层自己编的结论）；
 *   · 结论变了（跑完 / 清理）能重画：勾会出现、也会消失；
 *   · 卡片详情里能复看最近一次自检（时间 + 原因 + 产物路径），没登记的不装作有结论。
 * 做法与 test/smoke-dialog-persistence.js 等一致：把要测的函数从源码里抠出来，装进 vm 里真跑。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "renderer/app-plugins.js"), "utf8");

let checks = 0;
let fails = 0;
function ok(cond, label) {
  checks++;
  console.log((cond ? "  ok   " : "  FAIL ") + label);
  if (!cond) fails++;
}

/* ── 从 app-plugins.js 里抠出本轮这几个声明（大括号 / 语句配平，不靠下一个声明名赌顺序） ── */
function fnBody(src, name) {
  const at = src.indexOf("function " + name + "(");
  if (at < 0) return "";
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  return src.slice(at);
}
/** 取一条顶层声明语句（`const X = …;` / `let X = …;`）：从行首的声明关键字起，跨行到分号为止 */
function declBody(src, name) {
  const re = new RegExp("^\\s*(?:const|let|var)\\s+" + name + "\\b", "m");
  const m = re.exec(src);
  if (!m) return "";
  const at = src.indexOf(name, m.index);
  const semi = src.indexOf(";", at);
  if (semi < 0) return "";
  return src.slice(src.lastIndexOf("\n", m.index) + 1, semi + 1);
}

const PICK_DECL = ["PLUGIN_DONE_SVG", "_pluginCheckState", "PLUGIN_ACT_SVG"];
/* [名字, 是不是 async]：async 那几个要按 async function 抽，否则 await 会当场报语法错 */
const PICK_FN = [
  ["loadPluginCheckState", true],
  ["pluginCheckOf", false],
  ["pluginCheckPassed", false],
  ["pluginCheckTip", false],
  ["paintPluginDone", false],
  ["paintPluginSelfcheckRow", false],
  ["pluginIconName", false],
  ["pluginIconUrl", false],
  ["replacePluginCover", false],
  ["bindPluginCover", false],
  ["pluginVerLabel", false],
  ["mkPluginCardShell", false],
  ["pluginLoc", false],
];
let code = "";
for (const d of PICK_DECL) {
  const body = declBody(SRC, d);
  ok(!!body, "源码里找得到声明 " + d);
  code += body + "\n";
}
for (const [f, isAsync] of PICK_FN) {
  const at = SRC.indexOf((isAsync ? "async function " : "function ") + f + "(");
  const body = fnBody(SRC, f);
  ok(!!body, "源码里找得到函数 " + f);
  code += (isAsync && at >= 0 ? "async " : "") + body + "\n";
}

/* ── 最小 DOM 桩：只实现这几个函数真用到的那几样 ── */
/* 卡片壳真正会问的那几个位置（见 mkPluginCardShell 的 innerHTML 模板）：
   只有这几个允许「按需现造」，其余的（比如 .plugin-tile-done）一律回 null ——
   否则「没勾」这件事会被桩自己的现造行为伪造成「有勾」。 */
const SHELL_SELECTORS = [".plugin-tile-title", "[data-plugin-ver]", "[data-plugin-notice]", ".plugin-tile-cover img"];
function mkEl(tag) {
  const el = {
    tagName: tag || "div",
    className: "",
    textContent: "",
    title: "",
    hidden: false,
    style: {},
    dataset: {},
    children: [],
    parentNode: null,
    attrs: {},
    _html: "",
    set innerHTML(v) {
      this._html = String(v == null ? "" : v);
    },
    get innerHTML() {
      return this._html;
    },
    appendChild(c) {
      this.children.push(c);
      c.parentNode = this;
      return c;
    },
    removeChild(c) {
      this.children = this.children.filter((x) => x !== c);
      c.parentNode = null;
      return c;
    },
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    },
    querySelector(sel) {
      const key = String(sel);
      this._q = this._q || {};
      const cls = key.replace(/^\./, "").replace(/^\[|\]$/g, "");
      const own = this.children.find((c) => String(c.className || "").split(/\s+/).indexOf(cls) >= 0);
      if (own) {
        this._q[key] = own;
        return own;
      }
      if (SHELL_SELECTORS.indexOf(key) < 0) return null; /* 壳里没有就是没有 */
      if (this._q[key]) return this._q[key];
      const el2 = mkEl("div");
      el2.className = cls;
      this.children.push(el2);
      this._q[key] = el2;
      return el2;
    },
    querySelectorAll() {
      return [];
    },
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    getAttribute(k) {
      return this.attrs[k] === undefined ? null : this.attrs[k];
    },
    addEventListener() {},
  };
  return el;
}
/** 壳里那几个位置先造好（等价于 innerHTML 真的解析出来了） */
function mkShellCardEl() {
  const card = mkEl("div");
  for (const sel of SHELL_SELECTORS) card.querySelector(sel);
  return card;
}
const documentStub = { createElement: mkEl };
/* I18n 桩：中文界面下原样回显（键即中文原文），与真 I18n 的中文档一致 */
const I18n = { t: (k) => String(k) };

const sandbox = { document: documentStub, I18n, console, URL };
sandbox.window = { api: {} };
/* 卡片壳还用到的显存门槛标注：本测试与它无关，给个「不标注」的替身（空串 = 不画角标） */
sandbox.pluginVramNoticeText = () => "";
const ctx = vm.createContext(sandbox);
/* 让 vm 里的 document.createElement 用「壳里那几个位置先造好」的那一版 */
sandbox.document = { createElement: (tag) => mkShellCardEl() };
try {
  vm.runInContext(code, ctx, { filename: "app-plugins-extract.js" });
  ok(true, "抽出的这几个函数原样跑得起来（无语法 / 引用错）");
} catch (e) {
  ok(false, "抽出的这几个函数原样跑得起来（" + ((e && e.message) || e) + "）");
  console.log("\nFAILED " + (fails + 1) + " / " + (checks + 1) + " checks");
  process.exit(1);
}

const run = (expr) => vm.runInContext(expr, ctx);
/** 把测试侧造的对象递进 vm（vm 里访问不到外层作用域，只能这样给） */
function put(name, val) {
  ctx[name] = val;
  return name;
}
function setState(checksObj) {
  run("_pluginCheckState = " + JSON.stringify({ ok: true, checks: checksObj || {} }));
}

/* ── [1] 打勾判据：只认「通过」 ── */
console.log("\n[1] 打勾判据来自主进程回的自检快照（不是渲染层自己编的）");
setState({});
ok(run("pluginCheckPassed('sensenova-local')") === false, "没测过的插件不打勾");
setState({ "sensenova-local": { passed: true, result: { ok: true, at: 1700000000000, artifacts: [{ path: "D:\\\\x\\\\out.png" }] } } });
ok(run("pluginCheckPassed('sensenova-local')") === true, "自检通过 → 打勾");
setState({ "sensenova-local": { passed: false, result: { ok: false, error: "backend_timeout" } } });
ok(run("pluginCheckPassed('sensenova-local')") === false, "自检未通过不打勾（失败不静默，也不冒充通过）");
setState({ "minimax-h3": { passed: false, result: { ok: false, skipped: true, reason: "等全局生成锁超时" } } });
ok(run("pluginCheckPassed('minimax-h3')") === false, "自检跳过（等锁超时 / 缺工具）不打勾");
ok(run("pluginCheckOf('no-such-plugin') === null") === true, "没登记的插件查不到记录（返回 null，不编造）");

/* ── [2] 勾画在卡片封面左上角，且只画给通过的卡片 ── */
console.log("\n[2] 勾只画在「已装 + 自检通过」的卡片上");
function mkCardFor(id, passed, extra) {
  const entry = passed
    ? { passed: true, result: Object.assign({ ok: true, at: Date.now(), artifacts: [{ path: "D:\\data\\plugin-selfcheck\\" + id + "\\check-1\\out.png" }] }, extra || {}) }
    : { passed: false, result: Object.assign({ ok: false }, extra || {}) };
  setState({ [id]: entry });
  const card = run("mkPluginCardShell(" + JSON.stringify({ id, title: { zh: "假插件" }, version: "1.0.0" }) + ")");
  /* 壳已拼好：此后 querySelector 不再现造元素 —— 「有没有勾」才问得准 */
  card._sealed = true;
  return card;
}
const isDone = (card) => card.children.some((c) => c.className === "plugin-tile-done");
/** 用 vm 里那一份 paintPluginDone 重画勾（card 得递进 vm 才看得见） */
function repaint(card, id) {
  const n = put("__card", card);
  run("paintPluginDone(" + n + ", " + JSON.stringify(id) + ")");
}
const cardPass = mkCardFor("sensenova-local", true);
const done = cardPass.children.find((c) => c.className === "plugin-tile-done");
ok(!!done, "自检通过的卡片上多了 .plugin-tile-done 角标");
ok(!!done && /^<svg/.test(String(done.innerHTML)), "角标里是一枚勾（内联 SVG，不是位图）");
ok(!!done && String(done.title).indexOf("安装后自检通过") >= 0, "角标 tooltip 说明结论来源（自检通过）");
ok(!!done && String(done.title).indexOf("out.png") >= 0, "角标 tooltip 带上自检产物路径（可复核）");
ok(!isDone(mkCardFor("minimax-music3", false, { error: "artifact_missing" })), "未通过的卡片上没有勾");
ok(!isDone(mkCardFor("remotion", false, { skipped: true, reason: "还没装好（缺要件）" })), "跳过的卡片上没有勾");
setState({});
ok(!isDone(run("mkPluginCardShell(" + JSON.stringify({ id: "breeze-tts-local", title: { zh: "假插件" }, version: "1.0.0" }) + ")")), "没测过的卡片上没有勾");

/* ── [3] 结论变了能重画：勾会出现，也会消失 ── */
console.log("\n[3] 结论变了就重画：勾会出现，也会消失");
setState({});
const card2 = mkCardFor("yue2-local", false, {});
ok(!isDone(card2), "起手没有勾");
setState({ "yue2-local": { passed: true, result: { ok: true, at: Date.now(), artifacts: [{ path: "D:\\data\\selfcheck.flac" }] } } });
repaint(card2, "yue2-local");
ok(isDone(card2), "自检通过后补画：勾出现（不必重开插件界面）");
/* 再画一次不叠第二个勾（重复事件 / 重画不该积累角标） */
repaint(card2, "yue2-local");
ok(card2.children.filter((c) => c.className === "plugin-tile-done").length === 1, "重复重画不叠出第二个勾");
setState({});
repaint(card2, "yue2-local");
ok(!isDone(card2), "清理自检产物 / 结论失效后：勾消失（不留旧勾）");

/* ── [4] 卡片详情里复看最近一次自检 ── */
console.log("\n[4] 卡片详情复看最近一次自检（时间 / 原因 / 产物路径）");
function selfRowFor(id, entry) {
  setState({ [id]: entry });
  const pop = mkEl("div");
  const n = put("__pop", pop);
  run("paintPluginSelfcheckRow(" + n + ", " + JSON.stringify(id) + ")");
  return pop.children.map((c) => String(c.textContent || "")).join("\n");
}
const rowText = selfRowFor("minimax-h3", { passed: false, result: { ok: false, skipped: true, reason: "等全局生成锁超时", at: 1700000000000, artifacts: [] } });
ok(rowText.indexOf("安装后自检") >= 0 && rowText.indexOf("已跳过") >= 0, "详情里写明「安装后自检：已跳过」");
ok(rowText.indexOf("等全局生成锁超时") >= 0, "跳过原因如实写出（不吞）");
const rowText3 = selfRowFor("minimax-music3", { passed: true, result: { ok: true, at: 1700000000000, artifacts: [{ path: "D:\\data\\plugin-selfcheck\\minimax-music3\\a\\out.flac" }] } });
ok(rowText3.indexOf("通过") >= 0 && rowText3.indexOf("out.flac") >= 0, "通过时详情里给出产物路径（可复核）");
const rowText4 = selfRowFor("sensenova-local", { passed: false, result: { ok: false, error: "backend_timeout", at: 1700000000000, artifacts: [] } });
ok(rowText4.indexOf("未通过") >= 0 && rowText4.indexOf("backend_timeout") >= 0, "未通过时详情里给出失败原因原文");
setState({});
const pop2 = mkEl("div");
const n2 = put("__pop2", pop2);
run("paintPluginSelfcheckRow(" + n2 + ", 'llama-local')");
ok(pop2.children.length === 0, "没登记自检的插件不画这一行（不装作有结论）");

/* ── [5] 本轮需求：卡片本体不再是按钮，信息入口 = 封面右上角那颗 ⓘ ── */
console.log("\n[5] 卡片信息入口：封面右上角 ⓘ，卡片本体不再可点");
{
  const shellSrc = fnBody(SRC, "mkPluginCardShell");
  const shellHtml = String(mkCardFor("paseo-remote", false)._html || "");
  ok(shellHtml.indexOf('class="plugin-tile-info"') >= 0, "卡片壳里就有那颗 ⓘ（.plugin-tile-info，随 innerHTML 一起出）");
  ok(shellHtml.indexOf("data-plugin-info") >= 0, "ⓘ 带 data-plugin-info（接线用，不靠猜 class）");
  ok(shellHtml.indexOf("插件信息") >= 0, "ⓘ 的 tooltip / aria-label 有可读名（走 i18n 词条「插件信息」）");
  ok(/<svg/.test(shellHtml.slice(shellHtml.indexOf("data-plugin-info"))), "ⓘ 里是内联 SVG（取自 PLUGIN_ACT_SVG.info，不是位图）");
  /* ⓘ 必须锚在封面上（卡片比封面宽，锚卡片的角标会飘离封面右上角） */
  const coverAt = shellHtml.indexOf('class="plugin-tile-cover"');
  const infoAt = shellHtml.indexOf('class="plugin-tile-info"');
  const coverEnd = shellHtml.indexOf("</div>", infoAt);
  ok(coverAt >= 0 && infoAt > coverAt && infoAt < coverEnd, "ⓘ 写在封面容器里面（按封面定位，不在卡片上）");
  ok(!/card\.setAttribute\(\s*"role"/.test(shellSrc), "卡片壳不再声明 role=button（按不动的东西不该是按钮）");
  ok(!/card\.tabIndex\s*=/.test(shellSrc), "卡片壳不再进 Tab 顺序（键盘只停在 ⓘ 上）");
  const loopSrc = SRC.slice(SRC.indexOf("for (const item of list) {"), SRC.indexOf("if (!list.length) {"));
  ok(loopSrc.indexOf('querySelector("[data-plugin-info]")') > 0, "插件对话框逐卡给 ⓘ 接线");
  ok(loopSrc.indexOf("infoBtn.addEventListener") > 0, "ⓘ 的点击监听是唯一入口");
  ok(loopSrc.indexOf("card.addEventListener") < 0, "卡片本体不再挂任何监听（点击 / Enter / Space 都不开浮层）");
}

console.log("\n" + (fails ? "FAILED " + fails + " / " + checks : "ALL PASS " + checks) + " checks");
process.exit(fails ? 1 : 0);
