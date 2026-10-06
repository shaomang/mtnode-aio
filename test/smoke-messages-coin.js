"use strict";
/* 消息正文金额 · 鲸圆币真跑回归 —— 零依赖，`node test/smoke-messages-coin.js`
 *
 * 需求（本轮）：「打赏不要显示元，显示鲸圆币」——消息中心那条打赏通知过去写着
 * 「「XX」收到 2.00 元打赏（来自 YY）」。服务端已改为按币数生成（store-saas/tips.mjs，
 * 由 test/smoke-messages.js 静态钉住），这里管**历史消息的兜底**：
 * 改版前落库的老正文里仍然写着「元」，必须由渲染层换成「币数 + 鲸圆币图标」。
 *
 * 做法：**真跑源码，不复制逻辑**——
 *   · 假 DOM 执行 renderer/app-whalecoin.js，拿到真的 window.MtCoin（汇率 / 图标 / coinEl）；
 *   · 用括号配对器从 renderer/app-messages.js 里抠出 rowEl 与其依赖（el / kindText /
 *     actorName / tsText / coinAmountEl / msgTextParts …）的**真实函数体**再执行，
 *     于是断言落在这份源码上：改坏了这里就红。
 *   · 静态扫描（smoke-messages.js）负责「文案里没有元」，本文件负责「渲染出来确实没有元」。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
let fails = 0;
let checks = 0;
function ok(cond, msg, extra) {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg + (extra !== undefined ? "  → " + String(extra).slice(0, 300) : ""));
  }
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
/* 去注释后的代码体（注释里的说明不算实现） */
const stripComment = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
/* 按「function 名(...) { … }」配平大括号抠出真实函数体（与 smoke-messages.js 同一把尺子） */
function fnBody(src, name) {
  const m = src.match(new RegExp("\\n\\s*function " + name + "\\s*\\("));
  if (!m) throw new Error("找不到函数：" + name);
  const at = src.indexOf("{", m.index);
  let depth = 0;
  let inStr = null;
  for (let j = at; j < src.length; j++) {
    const c = src[j];
    if (inStr) {
      if (c === "\\") j++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") inStr = c;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (!depth) return src.slice(m.index, j + 1);
    }
  }
  throw new Error("函数体没闭合：" + name);
}

/* ── 假 DOM：只实现被用到的部分（节点 / 文本 / textContent / appendChild / SVG 命名空间） ── */
function makeDom() {
  function mk(tag) {
    const n = {
      nodeType: 1,
      tagName: String(tag || "div").toUpperCase(),
      className: "",
      title: "",
      children: [],
      attrs: {},
      appendChild(c) {
        this.children.push(c);
        return c;
      },
      setAttribute(k, v) {
        this.attrs[k] = String(v);
      },
      getAttribute(k) {
        return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
      },
      addEventListener() {},
      removeAttribute() {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      get textContent() {
        return this.children.map((c) => (c.nodeType === 3 ? c.text : c.textContent)).join("");
      },
      set textContent(v) {
        this.children = [mkText(String(v))];
      },
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    return n;
  }
  function mkText(t) {
    return { nodeType: 3, text: String(t), get textContent() { return this.text; } };
  }
  return { createElement: mk, createElementNS: (_ns, tag) => mk(tag), createTextNode: mkText };
}

/* 把节点树序列化成「父>子>孙」路径列表（只含元素节点；路径里带 class，便于断言元件形状）。
   注意：节点是在 vm 沙箱那个 realm 里造的，tagName 是**跨 realm 的 String 对象**，
   直接 === 比较会假阴性 —— 所以统一 String(...) 收敛成宿主 realm 的原始字符串再比。 */
function tagPaths(node, trail, out) {
  out = out || [];
  if (!node || Number(node.nodeType) !== 1) return out;
  const cls = String(node.className || "").trim().split(/\s+/)[0];
  const tag = String(node.tagName).toLowerCase() + (cls ? "." + cls : "");
  const here = trail ? trail + ">" + tag : tag;
  out.push(here);
  const kids = node.children || [];
  for (let i = 0; i < kids.length; i++) tagPaths(kids[i], here, out);
  return out;
}

function main() {
  const dom = makeDom();
  const MSG = read("renderer/app-messages.js");
  const CODE = stripComment(MSG);

  /* ── [1] 抠真实函数体 ───────────────────────────────────────── */
  console.log("[1] 从 renderer/app-messages.js 取真实实现（不复制逻辑）");
  const regexDecl = (CODE.match(/var RE_YUAN_AMOUNT = \/[^\n]*\/g;/) || [""])[0];
  const names = [
    "el",
    "kindText",
    "kindCls",
    "targetText",
    "actorName",
    "tsText",
    "coinAmountEl",
    "msgTextParts",
    "targetLine",
    "rowEl",
  ];
  const bodies = names.map((n) => fnBody(CODE, n)).join("\n");
  ok(!!regexDecl, "取到 RE_YUAN_AMOUNT（正文里的元金额识别正则）");
  ok(bodies.includes("document.createElement") && bodies.length > 2000, "取到全部依赖的真实函数体");
  ok(/window\.MtCoin[\s\S]{0,120}coinEl/.test(fnBody(CODE, "coinAmountEl")), "币数元件走 window.MtCoin.coinEl");
  ok(/coinsOfYuan\(yuan\)/.test(fnBody(CODE, "coinAmountEl")),
    "交给 coinEl 之前先 coinsOfYuan 换算（coinEl 收的是币数，递元会把 2 元显示成「2」）");

  /* ── [2] 真跑：假 DOM 里执行 app-whalecoin.js + 抠出的函数体 ── */
  console.log("\n[2] 真跑渲染：老正文（元）→ 币数 + 鲸圆币图标");
  const sandbox = { console, window: {}, document: dom, Math, Number, String, Object, Array, JSON };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(read("renderer/app-whalecoin.js"), ctx, { filename: "app-whalecoin.js" });
  const MtCoin = sandbox.window.MtCoin;
  ok(!!MtCoin && typeof MtCoin.coinEl === "function", "假 DOM 下真跑 app-whalecoin.js，拿到真的 window.MtCoin");
  ok(MtCoin.coinsOfYuan(2) === 100 && MtCoin.coinsOfYuan(20) === 1000 && MtCoin.coinsOfYuan(0.02) === 1,
    "汇率固定 1 币 = ¥0.02（2 元 = 100 币 / 20 元 = 1000 币），与钱包同一份换算");

  vm.runInContext(
    'function T(s){return s;}\n' + regexDecl + "\n" + bodies +
      "\nthis.__row = rowEl;",
    ctx,
    { filename: "app-messages.slice.js" },
  );
  const rowEl = sandbox.__row;
  ok(typeof rowEl === "function", "抠出的 rowEl 可调用（依赖齐备才可能为函数）");

  const render = (text) =>
    rowEl({ id: "nt1", kind: "tip", at: Date.UTC(2026, 5, 10, 4, 0, 0), read: true, title: "收到打赏", text });

  /* ① 改版前落库的老正文（服务端那时写的是元） */
  const old = render("「AI 绘图助手」收到 2.00 元打赏（来自 爱丽丝）");
  const oldTxt = String(old.textContent);
  ok(oldTxt.indexOf("2.00") < 0, "老正文里的「2.00 元」不再按元显示", oldTxt);
  ok(oldTxt.indexOf("元") < 0, "渲染结果里一个「元」都没有（用户报的就是这个）", oldTxt);
  ok(oldTxt.includes("100"), "2.00 元 → 100 币（数字按币数换算）", oldTxt);
  ok(oldTxt.includes("「AI 绘图助手」收到") && oldTxt.includes("打赏（来自 爱丽丝）"),
    "单位前后的正文一字不动（只换金额与单位）", oldTxt);
  const paths = tagPaths(old, "", []);
  const svgPaths = paths.filter((p) => /svg$/.test(p));
  const iconPath = paths.filter((p) => /coin-amt>span\.coin-ico>svg$/.test(p));
  ok(svgPaths.length === 1 && iconPath.length === 1,
    "币数后面挂的是鲸圆币图标元件（.coin-amt > .coin-ico > svg），不是文字单位",
    "svgPaths=" + JSON.stringify(svgPaths) + " iconPath=" + JSON.stringify(iconPath) + " total=" + paths.length);
  ok(allText(old).indexOf("币") < 0 && allText(old).indexOf("¥") < 0,
    "正文里不写「币」「¥」（单位由图标承担，与全应用口径一致）", allText(old));

  /* ② 千分位：20 元档 → 1,000 币 */
  const big = render("「模板」收到 20 元打赏（来自 鲸鱼）");
  ok(String(big.textContent).includes("1,000"), "20 元 → 1,000 币（千分位与钱包一致）", String(big.textContent));

  /* ③ 带 ¥ 前缀的老写法也要认 */
  const yen = render("收到 ¥5 元打赏");
  ok(String(yen.textContent).indexOf("元") < 0 && String(yen.textContent).indexOf("¥") < 0,
    "「¥5 元」这种老写法也一并换成币数", String(yen.textContent));

  /* ④ 与打赏无关的正文照原样（不误伤：评论 / 回复消息里没有元金额） */
  const cmt = render("写得很清楚，感谢分享！");
  ok(String(cmt.textContent).endsWith("写得很清楚，感谢分享！"),
    "普通正文一字不改（没有金额就不动它）", String(cmt.textContent));
  ok(tagPaths(cmt, "", []).filter((p) => p.endsWith("svg")).length === 0, "普通正文里不会凭空多出一枚图标");

  /* ⑤ 新服务端文案（已是鲸圆币）渲染后不再出现「元」，也不被二次改写 */
  const neu = render("「AI 绘图助手」收到 100 鲸圆币打赏（来自 爱丽丝）");
  const neuTxt = String(neu.textContent);
  ok(neuTxt.includes("100") && neuTxt.includes("鲸圆币") && neuTxt.indexOf("元") < 0,
    "新文案（服务端已按鲸圆币写）渲染后仍是「100 鲸圆币」，不被再动一次", neuTxt);

  /* ── [3] MtCoin 缺席的兜底：绝不退回「元」 ─────────────────── */
  console.log("\n[3] window.MtCoin 缺席（夹具 / 预览页）时的兜底");
  const bare = { console, window: {}, document: dom, Math, Number, String, Object, Array, JSON };
  bare.globalThis = bare;
  const ctx2 = vm.createContext(bare);
  vm.runInContext(
    'function T(s){return s;}\n' + regexDecl + "\n" + bodies + "\nthis.__row = rowEl;",
    ctx2,
    { filename: "app-messages.slice.bare.js" },
  );
  const bareRow = bare.__row;
  const fallback = bareRow({ kind: "tip", at: 0, title: "收到打赏", text: "收到 2 元打赏" });
  const fbTxt = String(fallback.textContent);
  ok(typeof bareRow === "function", "MtCoin 缺席时抠出的函数体照样可执行（不抛错）");
  ok(fbTxt.indexOf("元") < 0, "兜底文案里没有「元」", fbTxt);
  ok(fbTxt.includes("100") && fbTxt.includes("鲸圆币"),
    "兜底退回「100 鲸圆币」纯文本（单位写鲸圆币，不写元）", fbTxt);

  console.log("\n" + (fails ? "FAILED  " : "ALL OK  ") + checks + " checks");
  process.exitCode = fails ? 1 : 0;
}

function allText(node) {
  return node && node.textContent != null ? String(node.textContent) : "";
}

main();
