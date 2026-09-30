"use strict";
/* 外层工作目录输入一律只读 —— 冒烟测试
 *   node test/smoke-workspace-readonly.js
 *
 * 需求：画布的项目目录（以及其他在外层的工作目录输入）改为只读，
 *       避免用户手打错一个字符，直到很深的写盘步骤才报「写入失败」。
 *
 * 被测（都是按标记从源码里切出来**真跑**的，不是抄一份逻辑）：
 *   renderer/app-db.js    workspaceReadOnlyGuard（只读守卫：拦键入 / 双击选目录 / 粘贴一次）
 *   renderer/app-db.js    workspaceBrowseButton（点击与双击都触发系统文件夹选择器）
 * 接线契约（四处外层入口都装配了守卫）：
 *   renderer/app.js        renderWfWorkspace（顶栏画布统一工作目录）
 *   renderer/app.js        newWorkflowDialog（新建画布的工作目录）
 *   renderer/app-assist.js syncAssistWorkspaceChrome（助手工作区）
 *   renderer/app-canvas.js promptDevProjectFolder（功能块的项目文件夹 devPath）
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
const read = (rel) =>
  fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8").replace(/\r\n?/g, "\n");
const HAS = (src, needle, msg) =>
  ok(src.indexOf(needle) >= 0, msg + (src.indexOf(needle) >= 0 ? "" : "\n        缺：" + needle));

/* 大括号配对切出完整函数（含 async 前缀）；找不到返回 "" */
function fnBody(src, name) {
  const m = new RegExp("(?:async\\s+)?function\\s+" + name + "\\s*\\(").exec(src);
  if (!m) return "";
  let k = src.indexOf("{", m.index);
  let d = 0;
  for (; k < src.length; k++) {
    if (src[k] === "{") d++;
    else if (src[k] === "}") {
      d--;
      if (!d) return src.slice(m.index, k + 1);
    }
  }
  return "";
}

const DB = read("renderer/app-db.js");
const APP = read("renderer/app.js");
const CANVAS = read("renderer/app-canvas.js");
const ASSIST = read("renderer/app-assist.js");
const HTML = read("renderer/index.html");
const CSS = read("renderer/css/canvas.css");
const I18n = require("../renderer/i18n.js");

/* ==================== 极简假 DOM ====================
   只要守卫真正用到的那几件：addEventListener / 属性 / value / 事件派发。 */
class FakeEl {
  constructor(tag, className) {
    this.tagName = String(tag || "").toUpperCase();
    this.className = className || "";
    this.listeners = {};
    this.attrs = {};
    this.value = "";
    this.title = "";
    this.readOnly = false;
    this.disabled = false;
    this.hidden = false;
    this.spellcheck = true;
    this.type = "";
    this.parentNode = null;
    this.clicks = 0;
    this.focused = 0;
  }
  addEventListener(kind, fn) {
    (this.listeners[kind] = this.listeners[kind] || []).push(fn);
  }
  removeEventListener(kind, fn) {
    const arr = this.listeners[kind] || [];
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return this.attrs[k];
  }
  click() {
    this.clicks++;
    return this.onclick ? this.onclick({ stopPropagation() {} }) : undefined;
  }
  dispatchEvent(ev) {
    const kind = ev && ev.type ? String(ev.type) : "";
    for (const fn of (this.listeners[kind] || []).slice()) fn(ev);
    return true;
  }
  focus() {
    this.focused++;
  }
  /* 事件对象只造守卫真正读到的字段；preventDefault 记数便于断言「拦住了」 */
  emit(kind, ev) {
    const e = Object.assign(
      {
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        stopPropagation() {},
      },
      ev || {},
    );
    for (const fn of (this.listeners[kind] || []).slice()) fn(e);
    return e;
  }
}

const TOASTS = [];
function makeSandbox() {
  const sb = {
    console,
    Event: class {
      constructor(type) {
        this.type = type;
      }
    },
    /* 选择器只认守卫自己发出的这一条 */
    document: {
      querySelector: (sel) => (sel === "button.ws-browse" ? sb.__browse || null : null),
    },
    I18n: {
      t: (k) => String(k),
    },
    toast: (m, kind) => TOASTS.push({ m, kind }),
    __browse: null,
  };
  vm.runInContext(fnBody(DB, "workspaceReadOnlyGuard"), vm.createContext(sb), {
    filename: "app-db.js#ws-readonly",
  });
  return sb;
}
const ex = (sb, expr) => vm.runInContext(expr, sb);
const makeInput = () => new FakeEl("input");

/* ==================== [1] 守卫：拦键入（且没有恢复可编辑的入口） ==================== */
console.log("\n[1] 只读守卫：字符键入被拦，且不给任何「变回可编辑」的口子");
{
  const sb = makeSandbox();
  const inp = makeInput();
  const guard = ex(sb, "workspaceReadOnlyGuard")(inp);
  ok(!!guard && typeof guard.lockKeys === "function", "守卫装配成功（回 lockKeys / browse / hint）");
  ok(typeof guard.unlock !== "function" && typeof guard.locked !== "function",
    "没有 unlock / locked 入口（只读是常驻态，外部无法把框改成可编辑）");
  ok(inp.readOnly === true, "装配即只读（默认就是「只读」状态）");
  ok(!!inp.title && inp.title.indexOf("只读") >= 0, "title 直接说明这一格只读");

  TOASTS.length = 0;
  let ev = inp.emit("keydown", { key: "C" });
  ok(ev.defaultPrevented === true, "字母键 keydown 被拦（preventDefault）");
  ev = inp.emit("keydown", { key: "Spacebar" });
  ok(ev.defaultPrevented === true, "空格被拦（路径里混空格是常见错）");
  ev = inp.emit("keydown", { key: "Backspace" });
  ok(ev.defaultPrevented === true, "Backspace 被拦（敲掉一个字符同样是错路径）");
  ev = inp.emit("keydown", { key: "Delete" });
  ok(ev.defaultPrevented === true, "Delete 被拦");

  ev = inp.emit("keydown", { key: "Escape" });
  ok(ev.defaultPrevented === false, "Esc 放行（关弹窗 / 取消不受影响）");
  ev = inp.emit("keydown", { key: "Enter" });
  ok(ev.defaultPrevented === false, "Enter 放行（回车确认照旧）");
  ev = inp.emit("keydown", { key: "ArrowLeft" });
  ok(ev.defaultPrevented === false, "方向键放行（无字符按键不拦）");
  ok(TOASTS.length > 0 && TOASTS.every((t) => t.kind === "warn"), "第一次拦下时给一句 warn 提示");
  ok(TOASTS.length <= 2, "提示不刷屏（同一句只说一次）");

  ev = inp.emit("beforeinput", { inputType: "insertCompositionText" });
  ok(ev.defaultPrevented === true, "输入法逐字提交（beforeinput）同样被拦");
  ev = inp.emit("drop", {});
  ok(ev.defaultPrevented === true, "拖入文本被拦");

  /* lockKeys：占死「粘贴 / 双击」两条路（助手「仅当前画布」必须跟随画布口径） */
  let browsed = 0;
  guard.browse(() => browsed++);
  guard.lockKeys(true);
  ok(inp.readOnly === true, "lockKeys(true) 下仍是只读");
  ev = inp.emit("keydown", { key: "C" });
  ok(ev.defaultPrevented === true, "该状态下键入仍被拦");
  inp.emit("dblclick", {});
  ok(browsed === 0, "该状态下双击不弹选择器（跟随画布口径，改了也不算数）");
  guard.lockKeys(false);
  ok(inp.readOnly === true, "lockKeys(false) 也不放开展开键入（仍然是只读框）");
  inp.emit("dblclick", {});
  ok(browsed === 1, "lockKeys(false) 后双击恢复直选文件夹");
}

/* ==================== [2] 守卫：双击选目录 + 粘贴一次 ==================== */
console.log("\n[2] 只读不等于没路走：双击直选文件夹 · Ctrl+V 粘贴路径");
{
  const sb = makeSandbox();
  const inp = makeInput();
  const guard = ex(sb, "workspaceReadOnlyGuard")(inp);
  ok(inp.readOnly === true, "先确认只读");

  /* 双击：登记的 browse 被调用 */
  const calls = [];
  guard.browse(() => calls.push("browse"));
  inp.emit("dblclick", {});
  ok(calls.length === 1, "双击 → 直接弹系统文件夹选择器");

  /* 粘贴：值落框 + 派发 change；框始终只读，粘贴不经过原生插入 */
  const changes = [];
  inp.addEventListener("change", () => changes.push(inp.value));
  let ev = inp.emit("paste", { clipboardData: { getData: () => "  E:/dev/tools/pipeline-console  " } });
  ok(ev.defaultPrevented === true, "粘贴由守卫接管（不走原生插入）");
  ok(inp.value === "E:/dev/tools/pipeline-console", "粘贴的路径落进框，并去掉首尾空白");
  ok(changes.length === 1, "派发一次 change → 原有校验 / 落盘逻辑照常执行");
  ok(inp.readOnly === true, "粘贴期间 / 之后框始终只读（不给接着打错字的机会）");
  ev = inp.emit("paste", { clipboardData: { getData: () => "   " } });
  ok(inp.value === "E:/dev/tools/pipeline-console", "粘到空白 → 不改值");

  /* browse 未登记时双击只给提示，不抛错 */
  const sb2 = makeSandbox();
  const inp2 = makeInput();
  const g2 = ex(sb2, "workspaceReadOnlyGuard")(inp2);
  TOASTS.length = 0;
  ok(g2 && inp2.emit("dblclick", {}) && TOASTS.length >= 1, "没登记 browse 时双击退化成提示（不静默）");
}

/* ==================== [3] 选择器按钮：点击与双击都触发 ==================== */
console.log("\n[3] 文件夹选择器：单击 / 双击都触发（按钮双击不落空）");
{
  const src = fnBody(DB, "workspaceBrowseButton");
  ok(src.length > 0, "定位到 workspaceBrowseButton");
  HAS(src, "b.onclick = run;", "单击触发");
  HAS(src, "b.ondblclick = run;", "双击触发（只读框双击选目录，手感一致）");
  HAS(src, "pickFolder(inp, onPicked)", "回填仍走 pickFolder（系统窗口里可直接新建）");
  HAS(src, "mini btn-sq ws-browse", "样式类名沿用 .ws-browse（图标与样式不变）");
}

/* ==================== [4] 接线：四处外层工作目录输入都装配守卫 ==================== */
console.log("\n[4] 接线契约：顶栏画布目录 / 新建画布 / 助手工作区 / 功能块项目文件夹");
{
  const WF = fnBody(APP, "renderWfWorkspace");
  ok(WF.length > 0, "定位到 renderWfWorkspace（顶栏统一工作目录）");
  HAS(WF, "workspaceReadOnlyGuard(inp)", "顶栏画布项目目录装配只读守卫");
  HAS(WF, "inp.placeholder = I18n.t(\"统一目录(留空 = 各节点单独设置)…\")", "顶栏提示语不变（留空 = 各节点单独设置）");
  HAS(WF, "workspaceBrowseButton(inp", "顶栏保留选择器按钮");
  HAS(WF, "wsGuard.browse(", "顶栏双击 = 直选文件夹");
  ok(WF.indexOf("inp.addEventListener(\"change\"") >= 0 || WF.indexOf("inp.addEventListener('change'") >= 0,
    "change 校验 / 落盘逻辑保留（只读不改变语义）");
  ok(
    WF.indexOf("该路径不存在或不是有效文件夹，已自动清空。请重新选择有效的工作目录。") >= 0,
    "无效路径仍当场清空并提示（粘贴错路径也不会留在画布里）",
  );

  const NEW = APP.slice(
    APP.indexOf('const wsInp = document.createElement("input");'),
  );
  const seg = NEW.slice(0, NEW.indexOf('const foot = $("#ovFoot")'));
  HAS(seg, "workspaceReadOnlyGuard(wsInp)", "新建画布的工作目录装配只读守卫");
  HAS(seg, "workspaceBrowseButton(wsInp)", "新建画布保留选择器");
  HAS(seg, "wsGuard.browse(", "新建画布双击直选");
  ok(
    seg.indexOf("wsInp.placeholder = I18n.t(\"请选择已存在的文件夹…\")") >= 0,
    "新建画布的占位文案仍是「请选择已存在的文件夹…」",
  );

  const SYNC = fnBody(ASSIST, "syncAssistWorkspaceChrome");
  ok(SYNC.length > 0, "定位到 syncAssistWorkspaceChrome（助手工作区）");
  HAS(SYNC, "assistWsGuard = workspaceReadOnlyGuard(ws)", "助手工作区装配只读守卫（句柄只建一次）");
  HAS(SYNC, "assistWsGuard.lockKeys(locked || assistScopeIsCurrent())",
    "运行中锁定 / 「仅当前画布」都连粘贴也不给（跟随画布口径），其余情况仍是只读框");
  ok(!/assistWsGuard\.locked\(/.test(SYNC),
    "助手侧不再有「把框解回可编辑」的调用（locked(false) 曾让这条外层目录重新可手打）");
  HAS(SYNC, "assistWsGuard.browse(", "助手双击直选文件夹");
  HAS(ASSIST, "let assistWsGuard = null;", "守卫句柄声明为模块级 assistWsGuard");
  /* 声明 / 使用同名（app-assist.js 是 "use strict"）：这里曾经把句柄写成未声明的 wsGuard，
     严格模式下 syncAssistWorkspaceChrome 一进来就 ReferenceError（助手面板整只挂掉），
     而当时的断言也钉了同一个错名 —— 所以既钉正确名，也反查「不许出现裸 wsGuard」。 */
  ok(
    !/(?<![A-Za-z0-9_$.])wsGuard\s*[.(=]/.test(ASSIST),
    "app-assist.js 内不出现未声明的 wsGuard（严格模式下会抛 ReferenceError）",
  );
  /* 泛化一层：本文件里用到的每个 *Guard 标识符，都必须在 app-assist.js 或 app-db.js 有声明 */
  const guardIds = new Set();
  for (const m of ASSIST.matchAll(/(?<![A-Za-z0-9_$.])([A-Za-z_$][A-Za-z0-9_$]*Guard)\b/g)) guardIds.add(m[1]);
  const declared = (id, src) =>
    new RegExp("(?:function|let|var|const)\\s+" + id + "\\b").test(src) ||
    new RegExp("\\b" + id + "\\s*=\\s*(?:async\\s*)?(?:function|\\()").test(src);
  const undeclared = [...guardIds].filter((id) => !declared(id, ASSIST) && !declared(id, DB));
  ok(
    undeclared.length === 0,
    "app-assist.js 用到的 *Guard 标识符都有声明（ASSIST / app-db.js）" +
      (undeclared.length ? " → 未声明: " + undeclared.join(", ") : ""),
  );

  const DEV = fnBody(CANVAS, "promptDevProjectFolder");
  ok(DEV.length > 0, "定位到 promptDevProjectFolder（功能块项目文件夹 devPath）");
  HAS(DEV, "workspaceReadOnlyGuard(inp)", "项目文件夹装配只读守卫");
  HAS(DEV, "devGuard.browse(pickDevFolder)", "双击直选（与「选择文件夹…」同一个实现）");
  HAS(DEV, "browse.onclick = pickDevFolder;", "按钮单击仍触发系统选择器");
  ok(
    DEV.split("node.devPath").length - 1 === 1,
    "devPath 仍只写一处（只读改造没动写入路径）",
  );
  HAS(DEV, "const clear = document.createElement(\"button\");", "「清除」按钮保留（清空 devPath 仍可用）");
}

/* ==================== [5] 样式与词条 ==================== */
console.log("\n[5] 只读的视觉与词条：虚线边框 + 中英词条齐备");
{
  ok(
    /\.wf-ws-box input\[readonly\]\s*\{[^}]*border-style:\s*dashed/.test(CSS),
    "顶栏只读目录用虚线边框（与助手侧同一视觉口径）",
  );
  const ASSIST_CSS = read("renderer/css/assist.css");
  ok(
    /\.assist-ws-line input\[readonly\]\s*\{[^}]*border-style:\s*dashed/.test(ASSIST_CSS),
    "助手侧原有 readonly 样式未动",
  );
  const keys = ["工作目录只读：点右侧「选择文件夹」按钮选目录", "双击直选文件夹，Ctrl+V 粘贴路径"];
  I18n.setLocale("en");
  for (const k of keys) {
    const v = I18n.t(k);
    ok(v !== k && /[A-Za-z]{2,}/.test(v), "英文词条：「" + k + "」→「" + v + "」");
  }
  I18n.setLocale("zh");
  for (const k of keys) ok(I18n.t(k) === k, "中文界面原样显示：" + k);
  HAS(DB, "workspaceReadOnlyGuard", "守卫与选择器同在 app-db.js（渲染层公用件集中一处）");
  const at = (f) => HTML.indexOf('<script src="' + f + '"></script>');
  ok(at("app-db.js") > 0 && at("app-db.js") < at("app-canvas.js"), "app-db.js 先于 app-canvas.js 加载（app-canvas 可直接用守卫）");
}

console.log(
  "\n" +
    (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全部通过") +
    "  (smoke-workspace-readonly)",
);
process.exit(fails ? 1 : 0);
