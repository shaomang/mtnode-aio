"use strict";
/* 节点提示词的 @ 引用菜单：整条键盘路径必须可用（不必鼠标点）
 *   node test/smoke-ref-keyboard.js
 * 与 test/smoke-global-refs.js / test/smoke-prompt-caret.js 同一套路：用 vm 从 renderer 源码里
 * 按名字抠出**真实函数**来跑，不改动任何源文件、不启动 Electron。
 * 只有「菜单渲染 / 落库 / 高亮层同步」这些与键盘判定无关的下游用测试侧替身（见 __FAKES__）；
 * @token 解析、候选筛选、按键消费、正文写回全部走真实代码。
 *
 * 背景（本次修的三处缺陷）：应用内帮助早就写着「↑↓ 选择、Enter 确认」，实际却做不到 ——
 *   1) refKey 的 ↑↓ 方向写反（↓ 取 sel-1），且 window 快捷键里又调了一次 refKey，
 *      一次按键被消费两遍 → 实际每次跳两格，键盘根本走不准，只能鼠标点；
 *   2) 智能任务节点的 Enter 在选完引用后继续往下落进 playNode → 选个引用把节点跑了；
 *   3) refTick 只认「光标紧挨着 @」，@ 后一打字菜单就关闭 → 无法边打边筛，条目多时更要点。
 *
 * 覆盖：
 *   [1] @token 解析：什么算「正在输入的引用」（边界、结束符、光标在中间）
 *   [2] 候选筛选：@ 后的片段包含即命中、前缀优先、大小写无关、无命中
 *   [3] 按键消费：↑↓ 正向单格、回车/Tab 确认高亮条目、Shift+Enter 与输入法放行、Esc 收起
 *   [4] 确认后写回：只吃掉当前这段 token（更早的引用不动）、该补空格才补
 *   [5] 候选集合指纹：同一批保留高亮项、换批回到第一条
 *   [6] 接线与文案静态核对：refKey 只有一个调用点且调用方按返回值中断；菜单钉在 @ 处；
 *       无匹配即收起；键盘提示文案在中英文与指南里都在 */
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
const read = (rel) =>
  fs.readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8");
const show = (v) => JSON.stringify(v);
const eqNum = (a, b, msg) =>
  ok(a === b, msg + "（得到 " + a + "，期望 " + b + "）");
const eqStr = (a, b, msg) =>
  ok(a === b, msg + "（得到 " + show(a) + "，期望 " + show(b) + "）");
const eqArr = (a, b, msg) => ok(show(a) === show(b), msg + "（得到 " + show(a) + "）");

/* ---------- 从源码里按名字抠出顶层函数（不改动源文件） ---------- */
function fnBody(src, name) {
  const m = src.match(new RegExp("\\nfunction " + name + "\\s*\\(", "m"));
  if (!m) throw new Error("找不到函数：" + name);
  const at = m.index + 1;
  const i = src.indexOf("{", at);
  let depth = 0;
  let inStr = null;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    const p = src[j - 1];
    if (inStr) {
      if (c === inStr && p !== "\\") inStr = null;
      continue;
    }
    if (c === "/" && src[j + 1] === "/") {
      j = src.indexOf("\n", j) - 1;
      continue;
    }
    if (c === "/" && src[j + 1] === "*") {
      j = src.indexOf("*/", j) + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (!depth) return src.slice(at, j + 1);
    }
  }
  throw new Error("函数体不完整：" + name);
}

const appSrc = read("renderer/app.js");
const canvasSrc = read("renderer/app-canvas.js");
const cssSrc = read("renderer/css/components.css");
const i18nSrc = read("renderer/i18n.js");
const guideZh = read("guides/manual/nodes-wires.md");
const guideEn = read("guides/manual/en/nodes-wires.md");

/* REF_SEP / REF_TOKEN_RE 是跨行 const，按名字抠会截断，整块取到第一个函数前 */
const CONSTS = appSrc.slice(
  appSrc.indexOf("const REF_SEP"),
  appSrc.indexOf("function refTokenAt("),
);
if (!CONSTS.includes("const REF_TOKEN_RE")) throw new Error("取不到 REF_TOKEN_RE");

/* ---------- 测试侧替身名单（只替与键盘判定无关的下游） ---------- */
const __FAKES__ = [
  "closeRefMenu", // 真实实现只收 DOM + 清 S.refMenu，这里用计数替身
  "paintRefSel", // 真实实现要查 .ref-item 并滚动
  "setProcPrompt", // 写回节点 prompt（落库副作用）
  "syncPromptRefBackdrop", // 高亮层同步（渲染副作用）
];

const S = { refMenu: null };
const persisted = [];
const closedAt = { n: 0 };
const painted = { n: 0 };
const sandbox = {
  S,
  console,
  Math,
  JSON,
  Set,
  Map,
  Array,
  Object,
  String,
  Number,
  RegExp,
  Error,
  closeRefMenu: () => {
    S.refMenu = null;
    closedAt.n++;
  },
  paintRefSel: () => {
    painted.n++;
  },
  setProcPrompt: (n, v) => {
    persisted.push({ id: n && n.id, v });
  },
  syncPromptRefBackdrop: () => {},
};
vm.runInNewContext(
  CONSTS +
    "\n" +
    ["refEntryTitle", "refEntriesHash", "filterRefEntries", "refTokenAt", "selectRefEntry", "refKey"]
      .map((n) => fnBody(appSrc, n))
      .join("\n") +
    "\n;Object.assign(__api, { refEntryTitle, refEntriesHash, filterRefEntries, refTokenAt, selectRefEntry, refKey });",
  Object.assign(sandbox, { __api: {} }),
);
const { refEntryTitle, refEntriesHash, filterRefEntries, refTokenAt, selectRefEntry, refKey } =
  sandbox.__api;

/* ---------- 造现场：textarea + 已打开的引用菜单 ---------- */
function taEl(value, caret) {
  return {
    value,
    selectionStart: caret,
    selectionEnd: caret,
    setSelectionRange(a, b) {
      this.selectionStart = b;
      this.selectionEnd = b;
    },
    focus() {
      this.focused = true;
    },
  };
}
const NODE = { id: "n1", kind: "proc_text", prompt: "" };
function titles(list) {
  return list.map(refEntryTitle);
}
function openMenu(ta, entries, sel) {
  S.refMenu = {
    ta,
    node: NODE,
    entries,
    sel: sel || 0,
    entriesHash: refEntriesHash(entries),
  };
  return S.refMenu;
}
function key(name, extra) {
  const ev = Object.assign({ key: name }, extra);
  ev.preventDefault = () => {
    ev.pd = true;
  };
  return ev;
}
const CAND = [
  { kind: "node", node: { id: "a", kind: "input_text", title: "图片A" } },
  { kind: "node", node: { id: "b", kind: "proc_image", title: "背景板" } },
  { kind: "tag", tag: "bgi" },
  { kind: "node", node: { id: "c", kind: "input_text", title: "BGInput" } },
  { kind: "node", node: { id: "d", kind: "input_text", title: "输出BG副本" } },
];

console.log("[1] @token 解析：什么算「光标前正在输入的引用」");
const tk = (v, c) => refTokenAt({ value: v, selectionStart: c == null ? v.length : c });
eqArr(tk("写一段提示 @"), { start: 6, query: "" }, "裸 @（@ 前是空格）算开始引用");
eqArr(tk("@"), { start: 0, query: "" }, "正文为空时的 @");
eqArr(tk("a\n@图"), { start: 2, query: "图" }, "换行后 @ 接片段");
eqArr(tk("（@tag"), { start: 1, query: "tag" }, "全角括号后 @ 仍算引用");
eqArr(tk("@标题 后续"), null, "token 已被空格结束 → 不再算输入中");
eqArr(tk("@标题，正文"), null, "中文逗号是 token 终点");
eqArr(tk("邮箱 a@b"), null, "@ 前紧跟字母数字 → 不是引用（不误弹菜单）");
eqArr(tk("总结@内容"), null, "@ 前是汉字也不算引用");
eqArr(tk("@a@b"), null, "连打两个 @ 的串不解析成引用");
eqArr(tk("@a 与 @b"), { start: 5, query: "b" }, "同一行多个引用只认光标前那段");
eqArr(tk("@图片1", 3), { start: 0, query: "图片" }, "光标落在 token 中间只取光标前部分");

console.log("[2] 候选筛选：@ 后继续打字 = 缩小范围");
eqArr(titles(filterRefEntries(CAND, "")), ["图片A", "背景板", "bgi", "BGInput", "输出BG副本"], "无片段时列全部候选");
eqArr(titles(filterRefEntries(CAND, "bg")), ["bgi", "BGInput", "输出BG副本"], "bg：包含即命中，前缀命中排前面");
eqArr(titles(filterRefEntries(CAND, "BGI")), ["bgi", "BGInput"], "大小写无关");
eqArr(titles(filterRefEntries(CAND, "背景")), ["背景板"], "中文片段按标题筛");
eqArr(titles(filterRefEntries(CAND, "zzz")), [], "无命中返回空（调用方据此收起菜单）");

console.log("[3] 按键消费：回车直接确认，不再需要鼠标");
const list3 = [
  { kind: "node", node: { id: "x1", kind: "input_text", title: "A" } },
  { kind: "node", node: { id: "x2", kind: "input_text", title: "B" } },
  { kind: "node", node: { id: "x3", kind: "input_text", title: "C" } },
];
/* ↓ / ↑ 只前进 / 后退一格（旧：方向反 + 被消费两遍 = 跳两格） */
const taD = taEl("提示 @x", 6);
const mD = openMenu(taD, list3, 0);
const evD = key("ArrowDown");
eqNum(refKey(taD, evD, NODE), true, "↓ 被菜单消费（返回 true，调用方不得再跑节点）");
eqNum(mD.sel, 1, "↓ 只前进一格（不再反向、不再跳两格）");
ok(evD.pd === true, "↓ 已 preventDefault（不会在正文里插入转义串）");
const taU = taEl("提示 @x", 6);
const mU = openMenu(taU, list3, 0);
refKey(taU, key("ArrowUp"), NODE);
eqNum(mU.sel, list3.length - 1, "↑ 后退一格且环形到末尾");
/* 回车确认高亮条目 */
const taE = taEl("提示 @x", 6);
openMenu(taE, list3, 1);
const evE = key("Enter");
eqNum(refKey(taE, evE, NODE), true, "回车确认被消费 → 智能任务节点不会顺带 ▶ 运行");
eqNum(evE.pd, true, "回车已 preventDefault（不会插入换行）");
eqStr(taE.value, "提示 @B ", "回车写入的是高亮那条（@B）并自动补空格");
eqNum(closedAt.n >= 1, true, "确认同时收起菜单");
/* Tab 同义 */
const taT = taEl("提示 @x", 6);
openMenu(taT, list3, 2);
eqNum(refKey(taT, key("Tab"), NODE), true, "Tab 也直接确认（旧行为保留）");
eqStr(taT.value, "提示 @C ", "Tab 写入高亮那条（@C）");
/* 该放行的必须放行 */
const taS = taEl("提示 @x", 6);
openMenu(taS, list3, 0);
eqNum(refKey(taS, key("Enter", { shiftKey: true }), NODE), false, "Shift+Enter 仍换行");
const taI = taEl("提示 @x", 6);
openMenu(taI, list3, 0);
eqNum(refKey(taI, key("Enter", { isComposing: true }), NODE), false, "输入法组词中的回车归候选框");
const taI2 = taEl("提示 @x", 6);
openMenu(taI2, list3, 0);
eqNum(refKey(taI2, key("Enter", { keyCode: 229 }), NODE), false, "keyCode 229（IME）同样不截获");
const taC = taEl("提示 @x", 6);
openMenu(taC, list3, 0);
eqNum(refKey(taC, key("ArrowDown", { ctrlKey: true }), NODE), false, "Ctrl+↓ 不抢（留给别的快捷键）");
const taP = taEl("提示 @x", 6);
openMenu(taP, list3, 0);
eqNum(refKey(taP, key("y"), NODE), false, "普通字母键放行 → 继续打字即筛选");
const taOff = taEl("提示 @x", 3); /* 光标已离开 token（按过左右键） */
openMenu(taOff, list3, 0);
eqNum(refKey(taOff, key("Enter"), NODE), false, "光标不在 token 上时回车按原生行为");
const taEmpty = taEl("提示 @x", 6);
openMenu(taEmpty, [], 0);
eqNum(refKey(taEmpty, key("Enter"), NODE), false, "候选为空时一律放行");
const taEsc = taEl("提示 @x", 6);
openMenu(taEsc, list3, 0);
const before = closedAt.n;
eqNum(refKey(taEsc, key("Escape"), NODE), true, "Esc 被消费");
eqNum(closedAt.n, before + 1, "Esc 收起菜单");
S.refMenu = null;
eqNum(refKey(taEsc, key("Enter"), NODE), false, "菜单没开时 refKey 完全不介入");

console.log("[4] 确认后写回：只吃当前这段 token");
const ta1 = taEl("先 @图片A 再 @背景", 12);
openMenu(ta1, CAND, 1); /* 高亮「背景板」 */
selectRefEntry(CAND[1]);
eqStr(ta1.value, "先 @图片A 再 @背景板 ", "第二个引用不动第一个");
eqNum(ta1.selectionStart, 14, "光标落在插入内容之后");
eqStr(persisted[persisted.length - 1].v, ta1.value, "写回同步到节点 prompt（落库）");
const ta2 = taEl("请 @bgi处理一下", 6);
openMenu(ta2, CAND, 2);
selectRefEntry(CAND[2]);
eqStr(ta2.value, "请 @bgi 处理一下", "引用紧跟正文时补空格断开，免得连成同一 token");
const ta3 = taEl("@bgi，然后", 4);
openMenu(ta3, CAND, 0);
selectRefEntry(CAND[2]);
eqStr(ta3.value, "@bgi，然后", "光标处已是分隔符就不重复补空格");
const ta4 = taEl("标签 @bgi", 7);
openMenu(ta4, CAND, 0);
selectRefEntry({ kind: "tag", tag: "bgi" });
eqStr(ta4.value, "标签 @bgi ", "@标签写回的是 @标签名（紫色那条）");

console.log("[5] 候选集合指纹：同一批保留高亮项，换批回到第一条");
const fbg = filterRefEntries(CAND, "bg");
eqStr(refEntriesHash(fbg), refEntriesHash(filterRefEntries(CAND, "BG")), "同一批候选（大小写不同片段）指纹一致");
ok(refEntriesHash(fbg) !== refEntriesHash(CAND), "候选被筛掉后指纹变化 → 高亮项回到第一条");

console.log("[6] 接线与文案（源码静态核对）");
eqNum((appSrc.match(/refKey\(/g) || []).length, 1, "app.js 里 refKey 只剩定义一处（window 快捷键不再重复调用）");
ok(/if \(inField\) return;/.test(appSrc), "输入框内的全局快捷键直接返回（不再二次消费按键）");
const atRef = canvasSrc.indexOf("if (refKey(ta, ev, node)) return;");
ok(atRef > 0, "节点输入框按 refKey 返回值中断事件链");
ok(/if \(S\.refMenu \|\| S\.slashMenu\) return;/.test(canvasSrc.slice(atRef, atRef + 600)), "智能任务节点保留「菜单开着不 ▶ 运行」的第二道保险");
ok(/function showRefMenu\(ta, node, items, query, at\)/.test(appSrc), "showRefMenu 收片段与 @ 位置（边打边筛 + 不跟跑）");
ok(/entries = filterRefEntries\(entries, query\)/.test(appSrc), "菜单构建前先按片段筛候选");
ok(/if \(!entries\.length\) \{\s*\n\s*closeRefMenu\(\);/.test(appSrc), "无匹配即收起菜单（不残留旧候选）");
ok(/showRefMenu\(\s*\n?\s*ta,\s*\n?\s*node,/.test(appSrc) && /tok\.query,[\s\S]{0,40}tok\.start/.test(appSrc), "refTick 把片段与 @ 下标一起传给菜单");
ok(/const pos = caretXY\(ta, typeof at === "number" \? at : undefined\)/.test(appSrc), "弹层钉在 @ 那一列，不随打字右移");
ok(/function caretXY\(ta, atIdx\)/.test(appSrc), "caretXY 支持指定锚点下标");
ok(/scrollIntoView\(\{ block: "nearest" \}\)/.test(appSrc), "高亮项滚进视野（长列表键盘可达）");
ok(/class="ref-keys"|className = "ref-keys"/.test(appSrc), "菜单头部有键盘提示元素");
ok(i18nSrc.includes('"↑↓ 选择 · 回车确认 · Esc 取消"'), "键盘提示文案有英文对照");
ok(/\.ref-menu \.ref-keys \{/.test(cssSrc) && /\.ref-menu \.ref-head-t \{/.test(cssSrc), "提示样式入 components.css");
ok(/\.ref-item:hover,\s*\n\.ref-item\.on \{/.test(cssSrc), "高亮态 .on 样式仍在（键盘可见）");
ok(/function slashKey\(ta, ev\)/.test(appSrc) && /if \(ev\.key === "Enter" \|\| ev\.key === "Tab"\)/.test(appSrc), "斜杠命令菜单的 Enter/Tab 未受影响（两套菜单各自处理）");
ok(guideZh.includes("回车（或 Tab）直接确认"), "应用内手册（中文）写了键盘确认");
ok(guideEn.includes("Enter (or Tab) confirms"), "应用内手册（英文）同步");

console.log("\n" + checks + " 项检查，" + fails + " 项失败");
process.exit(fails ? 1 : 0);
