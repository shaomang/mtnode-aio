"use strict";
/* 会话运行中滚动条偶尔小幅上跳（用户报障）
 *   node test/smoke-session-scroll-stable.js
 *
 * 背景（真源全在 renderer/app.js 的「会话滚动」那一套里）：
 *   会话运行期每个 tool / tool-result 事件都会整表重绘 #agentList，重绘前用
 *   captureConvStick 记下用户的阅读位置、重绘后用 restoreConvStick 搬回去。
 *   旧口径有两处会把画面对不齐，观感就是滚动条偶尔小幅往上跳：
 *     ① 锚点行只按 data-histKey 找，找不到就 rows[anchor.idx] 兜底 —— 可见窗口切片
 *        变化（「显示更早内容」/ 条目预算裁剪）后序号已经错位，兜底指到另一条消息，
 *        还原出来的位置比原来高一截；
 *     ② 锚点彻底找不到时按 (top * 新高 / 旧高) 的比例还原 —— 流式内容让列表长高多少，
 *        阅读位置就被均摊着往上推多少（放大版的上跳）。
 *   另一条是「程序自己写的 scrollTop 反过来污染用户意图」：setConvScrollTop 的守卫
 *   _convAutoScroll 在下一帧无条件清除，同一帧里第二笔程序写入的 scroll 事件到达时
 *   守卫已经解除 → 被当成用户滚动 → 列表明明在底部却把 _convStick 写成 false，
 *   随后的补滚 / 还原再把画面小幅拽一下。
 *
 * 本轮口径：
 *   · convAnchorOf / convAnchorRow / restoreConvStick：只认键（同一条消息）还原，
 *     绝不按序号兜底、绝不按比例缩放；锚点行不在窗口里就原样回到记录位置；
 *   · convRestoreOff：落点偏离目标半个视口以上才收回记录位置（2px 级不动）；
 *   · setConvScrollTop：每一笔程序写入带序号（_convAutoScrollGen），只认最后一笔
 *     解除守卫，同帧内连续写入不会提前解锁；配套 convScrollGuardOn 统一判定。
 *
 * 覆盖：
 *   [1] 源码口径：键锚点 / 无比例还原 / 带序号的程序滚动守卫
 *   [2] 真实 restoreConvStick 行为（vm + 纯几何桩）：重绘后阅读位置不跳、不按比例漂移
 *   [3] 真实 setConvScrollTop 行为：同帧内第二笔写入后守卫仍然算「程序滚动」
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
const read = (rel) =>
  fs
    .readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8")
    .replace(/\r\n?/g, "\n");
const has = (src, needle, msg) =>
  ok(src.indexOf(needle) >= 0, msg + (src.indexOf(needle) >= 0 ? "" : "（未找到）"));
const countOf = (src, re) => (src.match(re) || []).length;

/* ---------- 从源码里按名字抠出顶层函数（不改动源文件） ---------- */
function fnBody(src, name) {
  const pats = [
    new RegExp("\\n(?:async\\s+)?function " + name + "\\s*\\(", "m"),
    new RegExp("\\nconst " + name + "\\s*=", "m"),
    new RegExp("\\nvar " + name + "\\s*=", "m"),
  ];
  let at = -1;
  for (const p of pats) {
    const m = src.match(p);
    if (m) {
      at = m.index + 1;
      break;
    }
  }
  if (at < 0) throw new Error("找不到函数/常量：" + name);
  const i = src.indexOf("{", at);
  if (i < 0) throw new Error("找不到函数体：" + name);
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
function constLine(src, name) {
  const re = new RegExp(
    "\\n[ \\t]*(?:const|let|var) " + name + "\\s*=[^\\r\\n]*",
    "m",
  );
  const m = src.match(re);
  if (!m) throw new Error("找不到单行常量：" + name);
  return m[0].replace(/^\n/, "") + "\n";
}

const APP = read("renderer/app.js");

/* ==================== [1] 源码口径 ==================== */
console.log("\n[1] 键锚点还原 + 带序号的程序滚动守卫");
has(
  APP,
  "function convScrollGuardOn(el) {",
  "app.js 新增 convScrollGuardOn（程序滚动守卫的唯一判定入口）",
);
has(
  APP,
  "function convAnchorRow(el, cap) {",
  "app.js 新增 convAnchorRow（按键找还原锚点行）",
);
has(
  APP,
  "function convRestoreOff(el, want, top) {",
  "app.js 新增 convRestoreOff（落点离谱才收口）",
);
ok(
  /function convAnchorRow\(el, cap\) \{[\s\S]{0,400}?if \(!a\.key\) return null;/.test(APP),
  "锚点没有键就不还原（不拿序号兜底）",
);
ok(APP.indexOf("rows[a.idx]") < 0, "restoreConvStick 里的 rows[a.idx] 序号兜底已删净");
ok(
  APP.indexOf("(cap.top * el.scrollHeight) / cap.prevH") < 0,
  "restoreConvStick 里的按比例还原已删净（不再均摊上方长出来的高度）",
);
ok(
  /function setConvScrollTop\(el, top\) \{[\s\S]{0,260}?_convAutoScrollGen = \(Number\(el\._convAutoScrollGen\) \|\| 0\) \+ 1/.test(
    APP,
  ),
  "setConvScrollTop 给每一笔程序写入编号（_convAutoScrollGen）",
);
ok(
  /function setConvScrollTop\(el, top\) \{[\s\S]{0,520}?if \(Number\(el\._convAutoScrollGen\) !== gen\) return;/.test(
    APP,
  ),
  "守卫只由「最后一笔」解除：期间又写过就不解锁",
);
ok(
  countOf(APP, /_convAutoScroll = false;/g) === 2,
  "解除守卫只剩 setConvScrollTop 里那两处（带序号回调 + 无 rAF 兜底；实得 " +
    countOf(APP, /_convAutoScroll = false;/g) +
    " 处）",
);
ok(
  countOf(APP, /if \(convScrollGuardOn\(/g) >= 4,
  "各处 scroll 监听 / 尺寸补滚统一走 convScrollGuardOn（实得 " +
    countOf(APP, /if \(convScrollGuardOn\(/g) +
    " 处）",
);

/* ==================== 纯几何桩 ====================
   只给这套 helper 真正用到的量：el.scrollTop / clientHeight / scrollHeight，与每行的
   contentTop / offsetHeight / getBoundingClientRect().top。行的 rect.top 直接按浏览器
   口径写好（视口 = 内容坐标 - 容器 scrollTop）；列表自身固定在视口顶部（rect.top = 0），
   与真 DOM 里对话区在 .agent-body 中的占位一致。 */
function mkList(rows, opt) {
  const o = opt || {};
  const list = {
    scrollTop: Math.max(0, Number(o.top) || 0),
    scrollHeight: Number(o.scrollHeight) || 0,
    clientHeight: Number(o.clientHeight) || 0,
    children: [],
    /* 列表自身固定在视口顶部：rect.top 与 scrollTop 无关
       （真 DOM 里对话区就贴在 .agent-body 顶部，页面本身不滚） */
    getBoundingClientRect() {
      return { top: 0, bottom: this.clientHeight };
    },
  };
  const build = (spec) => {
    list.children = spec.map((r) => ({
      className: "dsh-msg",
      classList: { contains: (c) => c === "dsh-msg" },
      dataset: { histKey: r.key },
      offsetHeight: r.h,
      _ctop: r.top,
      getBoundingClientRect() {
        const t = this._ctop - list.scrollTop;
        return { top: t, bottom: t + this.offsetHeight };
      },
    }));
  };
  build(rows);
  return { list, build };
}
function rowTop(list, key) {
  const r = list.children.find((x) => x.dataset.histKey === key);
  return r ? r.getBoundingClientRect().top : null;
}

/* 这套 helper 的真源：app.js 里逐行抠出来跑 */
const SCROLL_FNS = [
  "convRows",
  "convScrollBase",
  "convRowTop",
  "convAnchorOf",
  "convAnchorRow",
  "convRestoreOff",
  "captureConvStick",
  "restoreConvStick",
  "setConvScrollTop",
  "convScrollGuardOn",
  "convStickOf",
  "markConvStick",
  "isScrollNearBottom",
];
function loadScrollApi(rafQueue) {
  const code =
    constLine(APP, "CONV_SCROLL_SLACK") +
    constLine(APP, "CONV_STICK_SLACK") +
    SCROLL_FNS.map((n) => fnBody(APP, n)).join("\n") +
    "\n({ captureConvStick, restoreConvStick, setConvScrollTop, convScrollGuardOn," +
    " markConvStick, convAnchorOf, convAnchorRow, convRowTop, convScrollBase, convRows })";
  const sb = {
    console,
    getComputedStyle: () => ({ borderTopWidth: "0px" }),
    requestAnimationFrame: (fn) => {
      rafQueue.push(fn);
      return rafQueue.length;
    },
    bindConvStick: () => {},
  };
  vm.createContext(sb);
  return vm.runInNewContext(code, sb, { filename: "renderer/app.js#scroll" });
}

/* ==================== [2] 还原行为 ==================== */
console.log("\n[2] 重绘后阅读位置不跳（键锚点，不按序号也不按比例）");
{
  const raf = [];
  /* 视口 600px；四条消息；运行中用户上翻到 1500（m3 中段） */
  const g = mkList(
    [
      { key: "m1", top: 0, h: 800 },
      { key: "m2", top: 800, h: 600 },
      { key: "m3", top: 1400, h: 900 },
      { key: "m4", top: 2300, h: 700 },
    ],
    { top: 1500, clientHeight: 600, scrollHeight: 3000 },
  );
  const list = g.list;
  const api = loadScrollApi(raf);
  api.markConvStick(list, false); /* 用户上翻过：不贴底 */
  const beforeView = rowTop(list, "m3");
  ok(beforeView < 0 && beforeView > -600, "m3 在视口内（顶部偏移 " + beforeView + "）");
  const cap = api.captureConvStick(list, false);
  ok(!!cap.anchor && cap.anchor.key === "m3", "锚点 = 视口里最靠上的那条消息（m3）");

  /* 运行中：m3 上方的思考块长高 300px（下方内容整体下移），滚动容器高度不变 */
  g.build([
    { key: "m1", top: 0, h: 800 },
    { key: "m2", top: 800, h: 900 },
    { key: "m3", top: 1700, h: 900 },
    { key: "m4", top: 2600, h: 700 },
  ]);
  list.scrollHeight = 3300;
  list.clientHeight = 600;
  api.restoreConvStick(list, cap);
  const want = 1700 - beforeView; /* 锚点新顶 - 原视口偏移（offset = 视口位置） */
  ok(
    list.scrollTop === want,
    "锚点行在视口里的位置原样保持（还原到 " + want + "，实得 " + list.scrollTop + "）",
  );
  ok(
    rowTop(list, "m3") === beforeView,
    "锚点行相对视口的偏移与重绘前一致（" + beforeView + " → " + rowTop(list, "m3") + "）",
  );

  /* 再来一轮：锚点行自己的高度变了（markdown 落定），视口位置仍要原样 */
  const cap2 = api.captureConvStick(list, false);
  g.build([
    { key: "m1", top: 0, h: 800 },
    { key: "m2", top: 800, h: 900 },
    { key: "m3", top: 1700, h: 1400 },
    { key: "m4", top: 3100, h: 700 },
  ]);
  list.scrollHeight = 3800;
  api.restoreConvStick(list, cap2);
  ok(
    list.scrollTop === cap2.top,
    "锚点行在视口里的位置一字不差（" + cap2.top + "，实得 " + list.scrollTop + "）",
  );

  /* 高度没变时重绘：更不该动一下 */
  const cap3 = api.captureConvStick(list, false);
  g.build([
    { key: "m1", top: 0, h: 800 },
    { key: "m2", top: 800, h: 900 },
    { key: "m3", top: 1700, h: 1400 },
    { key: "m4", top: 3100, h: 700 },
  ]);
  api.restoreConvStick(list, cap3);
  ok(list.scrollTop === cap3.top, "同高度重绘不产生任何位移（仍为 " + list.scrollTop + "）");

  /* 可见窗口切片变化：锚点那条消息被裁到「更早内容」后面 → 原样回记录位置，
     绝不按比例缩放（旧口径会把 top 按新高速放大，画面往上跳） */
  const cap4 = {
    stick: false,
    top: 2000,
    prevH: 3000,
    anchor: { key: "m1", idx: 0, off: 100 },
  };
  g.build([
    { key: "m5", top: 0, h: 1200 },
    { key: "m6", top: 1200, h: 1200 },
    { key: "m7", top: 2400, h: 1200 },
  ]);
  list.scrollHeight = 3600;
  list.scrollTop = 2000;
  api.restoreConvStick(list, cap4);
  ok(
    list.scrollTop === 2000,
    "锚点不在窗口里 → 原样回记录位置（实得 " + list.scrollTop + "，比例口径会得到 2400）",
  );
  ok(
    api.convAnchorRow(list, cap4) === null,
    "锚点行不在重绘后的列表里时 convAnchorRow 明确返回 null（调用方走保守还原）",
  );
}

/* ==================== [3] 程序滚动守卫 ==================== */
console.log("\n[3] 同帧内连续程序写入不提前解除守卫");
{
  const raf = [];
  const g = mkList([{ key: "m1", top: 0, h: 2000 }], {
    clientHeight: 600,
    scrollHeight: 2000,
  });
  const list = g.list;
  const api = loadScrollApi(raf);
  const drainOne = () => {
    const fn = raf.shift();
    if (fn) fn();
  };
  ok(api.convScrollGuardOn(list) === false, "初始没在程序滚动");
  api.setConvScrollTop(list, 1200);
  ok(
    api.convScrollGuardOn(list) === true,
    "写入期间守卫成立（自己那笔 scroll 事件不算用户滚动）",
  );
  api.setConvScrollTop(list, 1400); /* 同一帧里第二笔（重绘后再落一次锚点） */
  drainOne(); /* 跑掉第一笔的回调 */
  ok(
    api.convScrollGuardOn(list) === true,
    "只跑掉第一笔的回调时守卫仍然成立（第二笔还没解锁）",
  );
  drainOne();
  ok(api.convScrollGuardOn(list) === false, "最后一笔的回调跑完才解锁");
  api.setConvScrollTop(list, 2000); /* 已在底部则浏览器夹住，但守卫仍要成立 */
  ok(api.convScrollGuardOn(list) === true, "再次写入重新上锁");
  drainOne();
  ok(api.convScrollGuardOn(list) === false, "解锁后回到可判定状态");
}

console.log(
  "\n" +
    (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全部通过") +
    "  (smoke-session-scroll-stable)",
);
process.exit(fails ? 1 : 0);
