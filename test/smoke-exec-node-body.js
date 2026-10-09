"use strict";
/* 执行节点 body 两态 —— 冒烟测试（纯 Node + 迷你 DOM，不依赖 Electron）
 *   node test/smoke-exec-node-body.js
 *
 * 本轮需求：执行节点绑定文件后，body 不再显示图标，执行按钮充满整个 body（原图标位让给按钮）。
 * 覆盖（真跑 app-canvas.js 的 buildBody 执行节点分支）：
 *   [1] 已绑定：body 无 .exec-title-row / .exec-body-icon / .exec-path-row，按钮一点即执行
 *   [2] 已绑定：按钮 tooltip 收着路径与结果（不再占 body 版面），**一次点击就执行**
 *       （本轮 bug：用户报「点击一次开始经常无效，需要点第二次」—— 旧的两段式预备态
 *        `.armed` 已删除，第一下点击必须真的 runExecuteNode，不再只是染绿）
 *   [3] 未绑定：保留图标 + 绑定引导，按钮置灰不可点（不误执行）
 *   [4] 接线：app-canvas.js 分支与 canvas.css / i18n.js 词条齐备（预备态词条已删除）
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
const read = (rel) => fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");

/* ============================ 迷你 DOM ============================ */
function mkEl(tag) {
  const el = {
    __el: true,
    tagName: String(tag || "div").toUpperCase(),
    childNodes: [],
    parentNode: null,
    id: "",
    _cls: "",
    _text: "",
    innerHTML: "",
    title: "",
    type: "",
    disabled: false,
    _l: {},
    style: {},
    _attrs: {},
    setAttribute(k, v) {
      el._attrs[k] = String(v);
    },
    getAttribute(k) {
      return k in el._attrs ? el._attrs[k] : null;
    },
    appendChild(c) {
      c.parentNode = el;
      el.childNodes.push(c);
      return c;
    },
    addEventListener(t, f) {
      (el._l[t] = el._l[t] || []).push(f);
    },
    fire(type, ev) {
      const e = Object.assign({ type, preventDefault() {}, stopPropagation() {} }, ev || {});
      for (const f of (el._l[type] || []).slice()) f(e);
    },
    click() {
      if (el.disabled) return;
      if (typeof el.onclick === "function") el.onclick({ stopPropagation() {} });
    },
  };
  Object.defineProperty(el, "className", {
    get: () => el._cls,
    set: (v) => {
      el._cls = String(v);
    },
  });
  Object.defineProperty(el, "classList", {
    get: () => ({
      contains: (c) => el._cls.split(/\s+/).indexOf(c) >= 0,
      add: (c) => {
        if (!el.classList.contains(c)) el._cls = (el._cls + " " + c).trim();
      },
    }),
  });
  Object.defineProperty(el, "textContent", {
    get: () => el._text,
    set: (v) => {
      el._text = String(v);
    },
  });
  return el;
}
function walk(el, out) {
  for (const c of el.childNodes) {
    out.push(c);
    walk(c, out);
  }
  return out;
}
function all(body) {
  return walk(body, []);
}
function classesOf(body) {
  return all(body).map((e) => e.className);
}
function has(body, cls) {
  return classesOf(body).some((c) => c.split(/\s+/).indexOf(cls) >= 0);
}
const document = { createElement: (t) => mkEl(t) };

/* ============ 从 app-canvas.js 抠出 buildBody 的执行节点分支 ============ */
const CANVAS = read("renderer/app-canvas.js");
function sliceExecuteBranch(src) {
  const fnAt = src.indexOf("function buildBody(node, body) {");
  if (fnAt < 0) throw new Error("找不到 buildBody");
  const marker = '} else if (node.kind === "execute") {';
  const at = src.indexOf(marker, fnAt);
  if (at < 0) throw new Error("buildBody 里找不到 execute 分支");
  const open = src.indexOf("{", at + marker.length - 1);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error("execute 分支括号不闭合");
}
const BRANCH = sliceExecuteBranch(CANVAS);

/* ============================ 沙箱 ============================ */
const calls = { run: 0, pick: 0, toast: [] };
const I18n = { t: (s) => s };
const sandbox = {
  document,
  I18n,
  renderCanvas() {},
  toast(msg) {
    calls.toast.push(msg);
  },
  execIconKeyOf: () => "auto",
  execIconSvg: () => "<svg data-ico></svg>",
  pickExecForNode() {
    calls.pick++;
  },
  runExecuteNode() {
    calls.run++;
  },
};
vm.createContext(sandbox);
vm.runInContext(
  "buildExecuteBranch = function (node, body) " + BRANCH + ";",
  sandbox,
  { filename: "app-canvas.js#execute-branch" },
);
const build = (node) => {
  const body = mkEl("div");
  sandbox.buildExecuteBranch(node, body);
  return body;
};

/* ==================== [1][2] 已绑定：按钮独占 body ==================== */
console.log("\n[1] 已绑定文件：body 无图标 / 路径行，执行按钮独占 body");
let body = build({ id: "e1", kind: "execute", execPath: "C:\\Tools\\run.bat" });
ok(body.classList.contains("exec-bound"), "已绑定 → body 打上 .exec-bound");
ok(!has(body, "exec-title-row"), "已绑定 → 不再渲染图标行（body 不显示 icon）");
ok(!has(body, "exec-body-icon"), "已绑定 → 不再渲染 .exec-body-icon");
ok(!has(body, "exec-path-row"), "已绑定 → 路径行不再占 body（收进按钮 tooltip）");
ok(all(body).filter((e) => e.className.split(/\s+/)[0] === "exec-play").length === 1, "body 里只有一枚执行按钮");
const btn1 = all(body).find((e) => e.className.indexOf("exec-play") >= 0);
ok(!!btn1 && btn1.disabled !== true, "已绑定 → 按钮可点");
ok(!!btn1 && btn1.title.indexOf("C:\\Tools\\run.bat") >= 0, "按钮 tooltip 收着绑定路径");

ok(!!btn1 && btn1.className.indexOf("disabled") < 0, "已绑定 → 不带 disabled 类");

console.log("\n[2] 已绑定：一次点击即执行 / 运行中 / 状态行");
calls.run = 0;
btn1.click();
ok(calls.run === 1, "第一次点击就执行（runExecuteNode 被调用一次）");
ok(btn1.title.indexOf("再次点击执行") < 0, "tooltip 不再提示「再次点击」（两段式已废）");
const bodyArmed = build({ id: "e1", kind: "execute", execPath: "C:\\Tools\\run.bat", _armed: true });
const btnArmed = all(bodyArmed).find((e) => e.className.indexOf("exec-play") >= 0);
ok(!!btnArmed && btnArmed.className.indexOf("armed") < 0, "旧档残留的 _armed 不再渲染 .armed（老画布也一键执行）");
calls.run = 0;
btnArmed.click();
ok(calls.run === 1, "带 _armed 残留时同样一次点击执行");
const bodyRun = build({ id: "e1", kind: "execute", execPath: "C:\\a.exe", running: true });
const btnRun = all(bodyRun).find((e) => e.className.indexOf("exec-play") >= 0);
ok(!!btnRun && btnRun.className.indexOf("running") >= 0 && btnRun.innerHTML === "…", "运行中按钮显示 … 且带 .running");
const stRun = all(bodyRun).find((e) => e.className.indexOf("n-status") >= 0);
ok(!!stRun && stRun.className.indexOf("run") >= 0, "运行中状态行标 run（启动结果仍在 body 显示）");
const bodyErr = build({
  id: "e1",
  kind: "execute",
  execPath: "C:\\a.exe",
  error: "文件不存在：C:\\a.exe",
  execStatus: "文件不存在：C:\\a.exe",
});
const stErr = all(bodyErr).find((e) => e.className.indexOf("n-status") >= 0);
ok(!!stErr && stErr.className.indexOf("err") >= 0 && stErr.textContent.indexOf("文件不存在") >= 0, "出错时状态行进 body（错误不丢）");

/* ==================== [3] 未绑定：图标 + 引导 + 置灰 ==================== */
console.log("\n[3] 未绑定：保留图标与绑定引导，按钮置灰不误点");
body = build({ id: "e2", kind: "execute", execPath: "" });
ok(body.classList.contains("exec-unbound"), "未绑定 → body 打上 .exec-unbound");
ok(has(body, "exec-title-row") && has(body, "exec-body-icon"), "未绑定 → 仍显示图标（便于右键换图标）");
ok(has(body, "exec-path-row") && has(body, "exec-path"), "未绑定 → 显示路径行与「绑定…」入口");
const bindBtn = all(body).find((e) => e.className.split(/\s+/).indexOf("mini") >= 0);
ok(!!bindBtn && bindBtn.textContent === "绑定…", "未绑定 → 绑定按钮在场");
calls.pick = 0;
if (bindBtn) bindBtn.click();
ok(calls.pick === 1, "点「绑定…」→ pickExecForNode");
const btn2 = all(body).find((e) => e.className.indexOf("exec-play") >= 0);
ok(!!btn2 && btn2.disabled === true && btn2.className.indexOf("disabled") >= 0, "未绑定 → 按钮 disabled + .disabled 置灰");
calls.run = 0;
calls.toast.length = 0;
if (btn2) btn2.click();
ok(calls.run === 0 && calls.toast.length === 0, "未绑定 → 点按钮被 disabled 拦住（不执行、不弹错）");

/* ==================== [4] 接线检查 ==================== */
console.log("\n[4] 接线：源码 / 样式 / 英文词条");
ok(CANVAS.indexOf("body.classList.add(bound ? \"exec-bound\" : \"exec-unbound\")") >= 0, "app-canvas.js：两态在 body 上盖章");
ok(CANVAS.indexOf("const bound = !!String(node.execPath || \"\").trim();") >= 0, "app-canvas.js：按是否绑定文件分支");
ok(CANVAS.indexOf("if (!bound) play.disabled = true;") >= 0, "app-canvas.js：未绑定置灰按钮");
ok(CANVAS.indexOf("runExecuteNode(node);") >= 0 && CANVAS.indexOf("node._armed = true") < 0, "app-canvas.js：点击处理器直接 runExecuteNode（不再置 _armed）");
const CSS = read("renderer/css/canvas.css");
ok(CSS.indexOf(".n-body.exec-bound") >= 0, "canvas.css：.n-body.exec-bound 让按钮铺满 body");
ok(CSS.indexOf(".exec-play.disabled") >= 0, "canvas.css：置灰态样式");
ok(CSS.indexOf(".exec-play.armed") < 0 && CSS.indexOf(".exec-body-icon") >= 0, "canvas.css：预备态样式已删（未绑定图标样式保留）");
const I18N = read("renderer/i18n.js");
[
  "点击执行（或双击节点直接执行）",
  "点击执行 · 双击节点也可执行",
  "执行：",
  "正在启动…（按钮可继续点，启动过程不会中断）",
].forEach((k) => {
  const at = I18N.indexOf(JSON.stringify(k) + ":");
  ok(at >= 0, "i18n.js 有词条：" + k);
});
/* 预备态词条必须一并清掉：留着就是「词条说要点两下、实现只点一下」的假口径 */
["再次点击执行（或双击节点直接执行）", "点击预备执行（播放键变为绿色背景 · 金色高亮），再次点击执行该文件；或直接双击执行"].forEach((k) => {
  ok(I18N.indexOf(JSON.stringify(k) + ":") < 0, "i18n.js 已删除旧预备态词条：" + k);
});

console.log("\n" + (fails ? "FAILED " + fails + "/" + checks : "ALL PASS " + checks + " checks"));
process.exit(fails ? 1 : 0);