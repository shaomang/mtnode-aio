/* test/smoke-ask-panel-top.js — 询问窗「总在最前 + 即时恢复」回归
 * ============================================================================
 * 运行：node test/smoke-ask-panel-top.js
 *
 * 需求：把询问菜单 UI（#ixPanel —— dsh 提问 / 审批卡片，即「🐋 模型等待你的回应」）
 *       变为总在最前，确保用户即时恢复弹出的询问窗。
 * 为什么：这只窗是「模型正卡在这一问上」的唯一出口，用户晚答一秒这一轮就白等一秒。
 *         它原来 z-index:60，被 #overlay(100) / 对话框(2400) / 素材菜单(2600) /
 *         节点提示(10050) / 全局搜索(12000) / 查找栏(12100) 一律盖住 = 看不见也点不到；
 *         位置记忆又可能正停在「收进底栏」那一条上，新的一问来了用户根本不会注意到。
 * 口径：
 *   [1] 层级总在最前：dsh.css #ixPanel 的 z-index 高于全仓（css + 内联）所有其它层级，
 *       且窗口本体的定位 / 收起态规则没被顺手改坏。
 *   [2] 新的一问到达 → 取消收起态、把记住的 top 夹到「整窗完整可见」（行为级：把
 *       app-db.js 里那组位置函数抽出来在 vm 里真跑一遍）。
 *   [3] 只有「新卡到达」才露窗：答题过程中的重绘（ixDrop / ixDropRun）不打扰用户摆放。
 *   [4] 本来就在屏上的窗，到达时头部闪两下（.ix-head.ix-attn），别让人盯着底栏猜。
 * 只读断言：不改任何文件。
 * ============================================================================
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const CSS_DIR = path.join(ROOT, "renderer", "css");
const DSH_CSS = fs.readFileSync(path.join(CSS_DIR, "dsh.css"), "utf8");
const DB_JS = fs.readFileSync(path.join(ROOT, "renderer", "app-db.js"), "utf8");

let fails = 0;
let checks = 0;
const ok = (cond, msg) => {
  checks++;
  if (cond) console.log("  ok  " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
};

/* ── 从源码里按名字抽一个函数（花括号配平；本文件抽的都是平铺 function 声明） ── */
function fnSrc(src, name) {
  const at = src.indexOf("function " + name + "(");
  if (at < 0) return "";
  const open = src.indexOf("{", at);
  if (open < 0) return "";
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) return src.slice(at, j + 1);
    }
  }
  return "";
}
/* 取一段 CSS 规则体（选择器到下一个 "}"） */
function cssRule(css, selector) {
  const at = css.indexOf(selector);
  if (at < 0) return "";
  const end = css.indexOf("}", at);
  return end > at ? css.slice(at, end + 1) : "";
}
const zOf = (rule) => {
  const m = /z-index:\s*(\d+)/.exec(rule);
  return m ? Number(m[1]) : NaN;
};

/* ═══════════════ [1] 层级：压过全仓所有其它浮层 ═══════════════ */
console.log("[1] #ixPanel 总在最前：层级压过全仓所有其它浮层");
let ixZ = NaN;
{
  const rule = cssRule(DSH_CSS, "#ixPanel {");
  ok(!!rule, "dsh.css 有 #ixPanel 规则");
  ixZ = zOf(rule);
  ok(Number.isFinite(ixZ), "#ixPanel 显式写了 z-index");
  ok(/position:\s*fixed/.test(rule), "仍是 position:fixed 的悬浮窗");
  ok(/left:\s*50%/.test(rule) && /bottom:\s*44px/.test(rule), "默认位置没变（底部居中、贴 footer 上沿）");
  ok(/max-height:\s*78vh/.test(rule), "仍受 78vh 限高（不会顶穿窗口）");
  ok(/gap:\s*0/.test(cssRule(DSH_CSS, "#ixPanel.ix-docked {")) || /#ixPanel\.ix-docked\s*\{[\s\S]{0,160}?max-height:\s*44px/.test(DSH_CSS), "「收进底栏」的紧凑态规则仍在");

  /* 全仓其它层级：renderer/css/*.css 里的 z-index 声明 */
  const files = fs.readdirSync(CSS_DIR).filter((n) => n.endsWith(".css"));
  ok(files.length >= 8, "扫到 renderer/css 下 " + files.length + " 个样式文件");
  const others = [];
  for (const n of files) {
    const txt = fs.readFileSync(path.join(CSS_DIR, n), "utf8");
    const re = /z-index:\s*(\d+)/g;
    let m;
    while ((m = re.exec(txt))) {
      /* #ixPanel 自己那条排除在外 */
      const isMe = n === "dsh.css" && m.index >= DSH_CSS.indexOf("#ixPanel {") && m.index <= DSH_CSS.indexOf("#ixPanel {") + cssRule(DSH_CSS, "#ixPanel {").length;
      if (!isMe) others.push({ n, z: Number(m[1]) });
    }
  }
  const maxOther = others.reduce((a, b) => (b.z > a.z ? b : a), { n: "-", z: 0 });
  ok(maxOther.z > 0 && ixZ > maxOther.z, "#ixPanel z-index=" + ixZ + " > 其余最高 " + maxOther.z + "（" + maxOther.n + "）");
  ok(ixZ >= 12600, "z-index 取值落在「最高一层」档（>=12600）");
  /* 钉住几个关键对照物：这几只必须被压住 */
  const mustBeat = {
    "#overlay 弹窗": zOf(cssRule(fs.readFileSync(path.join(CSS_DIR, "components.css"), "utf8"), "#overlay {")),
    ".mt-dialog 对话框": zOf(cssRule(fs.readFileSync(path.join(CSS_DIR, "base.css"), "utf8"), ".mt-dialog {")),
    ".gs-layer 全局搜索": zOf(cssRule(fs.readFileSync(path.join(CSS_DIR, "search.css"), "utf8"), ".gs-layer {")),
    ".fd-bar 查找栏": zOf(cssRule(fs.readFileSync(path.join(CSS_DIR, "find.css"), "utf8"), ".fd-bar {")),
  };
  for (const k of Object.keys(mustBeat)) {
    ok(Number.isFinite(mustBeat[k]) && ixZ > mustBeat[k], "压住 " + k + "（" + mustBeat[k] + "）");
  }

  /* 内联层级（JS 里现写的 z-index）也不能有漏网的 */
  const jsFiles = fs.readdirSync(path.join(ROOT, "renderer")).filter((n) => n.endsWith(".js"));
  const inline = [];
  for (const n of jsFiles) {
    const txt = fs.readFileSync(path.join(ROOT, "renderer", n), "utf8");
    const re = /z-index:\s*(\d+)|zIndex\s*=\s*"(\d+)"/g;
    let m;
    while ((m = re.exec(txt))) inline.push(Number(m[1] || m[2]));
  }
  const maxInline = inline.reduce((a, b) => Math.max(a, b), 0);
  ok(maxInline < ixZ, "renderer/*.js 里的内联 z-index 最高 " + maxInline + "，仍低于询问窗");
}

/* ═══════════════ [2][3][4] 接进逻辑 ═══════════════ */
console.log("\n[2] 新的一问到达 → 取消收起态 + 夹回视口（vm 里真跑一遍位置函数）");
{
  /* 把 app-db.js 里那组位置函数原样抽出来跑，避免「测试里重写一份实现」 */
  const names = [
    "ixPosLoad",
    "ixPosSave",
    "ixPosClear",
    "applyIxPos",
    "ixDockedAt",
    "ixDockApply",
    "ixRestorePos",
    "ixPosResetStyle",
    "ixRevealNewCard",
  ];
  const parts = names.map((n) => fnSrc(DB_JS, n));
  ok(parts.every((p) => p), "9 个位置函数都能从 app-db.js 抽出（未改名 / 未删）");
  const consts = [
    /^const IXPOS_KEY = .*$/m.exec(DB_JS),
    /^const IXPOS_DOCK_PX = .*$/m.exec(DB_JS),
  ].map((m) => (m ? m[0] : ""));
  ok(consts.every(Boolean), "IXPOS_KEY / IXPOS_DOCK_PX 常量就位");

  function boot(saved) {
    const store = new Map();
    if (saved) store.set("mtnode.ixPanel.pos", JSON.stringify(saved));
    const head = {
      classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
      offsetHeight: 34,
    };
    const el = {
      style: {},
      offsetWidth: 420,
      /* 真实 DOM 里 .ix-docked 会把整窗压成头部那一条（max-height:44px）——
         高度必须跟着收起态变，否则「先放开收起态再量高度」这条断言测不出来 */
      get offsetHeight() {
        return this.classList.contains("ix-docked") ? 34 : 300;
      },
      classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); }, toggle(c, on) { if (on) this._s.add(c); else this._s.delete(c); } },
      removeAttribute() {},
      setAttribute() {},
      querySelector: () => head,
      _head: head,
      _store: store,
    };
    const sandbox = {
      console,
      I18n: { t: (s) => String(s) },
      setTimeout: () => 0,
      clearTimeout: () => {},
      localStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
      },
      window: { innerWidth: 1200, innerHeight: 800 },
    };
    sandbox.window.window = sandbox.window;
    const savedPos = () => {
      try {
        return JSON.parse(store.get("mtnode.ixPanel.pos") || "null");
      } catch (_) {
        return null;
      }
    };
    vm.createContext(sandbox);
    vm.runInContext(consts.join("\n") + "\nlet ixAttnTimer = 0;\n" + parts.join("\n"), sandbox, {
      filename: "app-db.ixpos.js",
    });
    return { sandbox, el, head, savedPos };
  }

  /* ① 记忆停在「收进底栏」（贴窗口底）→ 新的一问必须把它放回完整可见处，
        而且重绘之后不能又被收回底栏（收起判定按未收起的整窗量） */
  {
    const { sandbox, el, head, savedPos } = boot({ left: 300, top: 798 });
    vm.runInContext("ixRestorePos(__el)", Object.assign(sandbox, { __el: el }));
    ok(el.classList.contains("ix-docked"), "前置：记到底部的窗先被还原成「收进底栏」态");
    vm.runInContext("ixRevealNewCard(__el, true)", Object.assign(sandbox, { __el: el }));
    ok(!el.classList.contains("ix-docked"), "新的一问到达 → 收起态被取消（正文放开）");
    const top = parseFloat(el.style.top);
    ok(Number.isFinite(top) && top + el.offsetHeight <= 800 - 4, "整窗完整落在视口内（top=" + top + " + 高" + el.offsetHeight + " <= 796）");
    ok(top + Math.max(el.offsetHeight, Math.round(800 * 0.78)) < 800 - 12, "落点在「收起判定线」之上（否则下一次重绘又收回底栏）");
    const p = savedPos();
    ok(p && p.left === 300, "记住的横向位置不动（只抬 top，尊重用户摆放）");
    ok(head.classList.contains("ix-attn"), "本来就在屏上的窗 → 头部挂上注意脉冲 .ix-attn");
    vm.runInContext("ixRestorePos(__el)", sandbox);
    ok(!el.classList.contains("ix-docked"), "再重绘一次仍是展开态（不会答一题就又收进底栏）");
  }

  /* ② 用户自己拖到画布上方（展开区）→ 到达时位置原样，不无谓跳动 */
  {
    const { sandbox, el } = boot({ left: 120, top: 40 });
    vm.runInContext("ixRevealNewCard(__el, false)", Object.assign(sandbox, { __el: el }));
    ok(!el.classList.contains("ix-docked"), "非收起态仍保持展开");
    ok(Math.round(parseFloat(el.style.top)) === 40 && Math.round(parseFloat(el.style.left)) === 120, "用户自己拖出来的位置原样保留（top=40 / left=120）");
    ok(!el._head.classList.contains("ix-attn"), "pulse=false 时不闪（首次弹出只是「出现」）");
  }

  /* ③ 没有位置记忆（默认底部居中）→ 到达时也不收起、不跑偏 */
  {
    const { sandbox, el } = boot(null);
    vm.runInContext("ixRevealNewCard(__el, false)", Object.assign(sandbox, { __el: el }));
    ok(!el.classList.contains("ix-docked") && !el.style.top && !el.style.left, "无记忆时保持 CSS 默认位（底部居中），未被写成异常坐标");
  }
}

console.log("\n[3] 只有「新卡到达」才露窗：答题重绘不打扰");
{
  const push = fnSrc(DB_JS, "ixPush");
  const render = fnSrc(DB_JS, "renderIxPanel");
  ok(/ixFreshCard\s*=\s*true/.test(push), "ixPush 收到新卡时置 ixFreshCard");
  ok(/ixFreshPulse\s*=\s*!!document\.getElementById\("ixPanel"\)/.test(push), "ixPush 记下「这只窗本来就在屏上」才算要闪");
  ok(
    /ixRestorePos\(box\)[\s\S]{0,600}?ixRevealNewCard\(box, pulse\)/.test(render),
    "ixRevealNewCard 排在 ixRestorePos 之后（先按记忆还原、再破掉收起态）",
  );
  ok(/if \(ixFreshCard\) \{/.test(render), "重绘末尾按 ixFreshCard 消费一次");
  ok(!/ixFreshCard/.test(fnSrc(DB_JS, "ixDrop")), "ixDrop（答完撤卡）不触发露窗");
  ok(!/ixFreshCard/.test(fnSrc(DB_JS, "ixDropRun")), "ixDropRun（收尾清卡）不触发露窗");
  ok(!/ixFreshCard/.test(fnSrc(DB_JS, "ixReset")), "ixReset 不触发露窗");
  const reveal = fnSrc(DB_JS, "ixRevealNewCard");
  ok(
    reveal.indexOf('classList.remove("ix-docked")') < reveal.indexOf("offsetHeight"),
    "先放开收起态再量高度（收起时只有头部高，按它折算会被又收回底栏）",
  );
  ok(/ixRestorePos\(el\)/.test(reveal) && /ixPosSave\(/.test(reveal), "露窗 = 抬高记住的 top + 按位置口径重新摆放");
}

console.log("\n[4] 头部注意脉冲：CSS 定义 + JS 挂摘都在");
{
  const rule = cssRule(DSH_CSS, "#ixPanel .ix-head.ix-attn {");
  ok(!!rule, "dsh.css 定义了 #ixPanel .ix-head.ix-attn");
  ok(/animation:\s*ixHeadAttn/.test(rule), "脉冲走 ixHeadAttn 动画");
  ok(/@keyframes ixHeadAttn/.test(DSH_CSS), "@keyframes ixHeadAttn 存在");
  const reveal = fnSrc(DB_JS, "ixRevealNewCard");
  ok(/classList\.add\("ix-attn"\)/.test(reveal) && /classList\.remove\("ix-attn"\)/.test(reveal), "挂上后 1.6 秒自行摘掉（不残留）");
  ok(/clearTimeout\(ixAttnTimer\)/.test(reveal), "连续两问不叠定时器");
}

console.log(
  fails
    ? "\n✗ " + fails + " / " + checks + " 项失败  (smoke-ask-panel-top)\n"
    : "\n✓ 全部 " + checks + " 项通过  (smoke-ask-panel-top)\n",
);
process.exit(fails ? 1 : 0);