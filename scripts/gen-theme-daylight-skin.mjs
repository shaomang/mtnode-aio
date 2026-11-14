/* 生成 css/theme-daylight-skin.css —— 亮色主题的「皮肤层」机械覆盖
 *
 *   node scripts/gen-theme-daylight-skin.mjs            # 生成
 *   node scripts/gen-theme-daylight-skin.mjs --dry      # 只报统计，不写盘
 *
 * 为什么要有这一步：
 *   四档主题共用 css/theme-endfield.css 那套皮肤（body.ef-skin），它把
 *   「石墨底盘 + 发丝线 + 象牙板」的**具体色值**写死在几百条规则里
 *   （background:#141414 / border-color:#3b3b3b / box-shadow:rgba(0,0,0,.5) …），
 *   只换 --ef-* 变量盖不住这些字面值 —— 亮色下它们就是一块块深色补丁，
 *   再配上已经变深的前景色，正好是「fill 与文字同色」那类 bug 的源头。
 *
 *   人工一条条补 1000+ 覆盖不现实也不可靠，所以这里按**一张显式的字面值→令牌映射表**
 *   把「深色面 / 深色线 / 黑色阴影 / 亮色文字 / 品牌强调色」批量翻译成亮色侧的值，
 *   生成一份前缀为 body.ef-skin.theme-light 的覆盖层。生成物落盘、可 review、可重跑；
 *   映射表就在本文件里，改色只改这里再跑一次。
 *
 * 不翻译的东西（非常重要）：
 *   · 形状 / 动效 / 布局：只碰颜色类属性（见 COLOR_PROPS）
 *   · 已经够浅的面（#e9e7e4 象牙板这类）：原样保留
 *   · 深浅之间的中间调文字（#a1a1a1 这类）：按亮度分档翻成 --ink / --muted
 *   · 媒体件（图片 / 视频 / canvas 内绘制）：不在此列 —— 那些由运行时自己画
 *
 * 描边一律落到亮色侧的三级梯度（令牌，不再各造一支灰）：
 *   白边 rgba(255,255,255,.06~.4)  ≥.12 → --line-strong，<.12 → --line
 *   黑边 rgba(0,0,0,.08~.7)        ≥.3（硬边）→ --line-hair，<.3（软压暗）→ 阴影冷灰
 *   暗灰字面值（#141414 / #6b6b6b …）按亮度：l<.20 → --line，其余 → --line-strong
 *   「按钮整个没边」就是白边被译成 rgba(29,42,68,.02~.05)（1.02~1.2:1）造成的。
 *
 * 蒙层（#overlay / .mt-dialog / 搜索遮罩 / 灯箱 / 工坊二级浮层 …）不按「淡墨」翻：
 *   暗色里它们是 45~96% 的黑纱，压成 rgba(29,42,68,.14) 在浅底上等于没压 —— 画布整片
 *   透出来，浮层跟背景糊成一块。蒙层的浓度只在手写层的一处（--pop-scrim）定义，这里
 *   把整份值换成 var(--pop-scrim)（径向渐变同样折叠成一个值：暗色那圈本来就是同色 stops）。
 *
 * 生成之后必须跑：node test/verify-theme-light-contrast.js
 * 那只脚本会把真机渲染出来的每一个带字元素逐个量对比度，漏网的会当场列出来。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CSS_DIR = path.join(ROOT, "renderer", "css");
const OUT = path.join(CSS_DIR, "theme-daylight-skin.css");
const DRY = process.argv.includes("--dry");

/* 参与翻译的源文件（顺序即层叠顺序，与 renderer/style.css 的 @import 一致）。
   theme-daylight.css 自己不算（它是手写的令牌层 + 手工覆盖，不许被生成物盖掉）；
   pdf-print.css 是打印样式，不进亮色主题。 */
const SOURCES = [
  "base.css", "layout.css", "canvas.css", "components.css", "dsh.css",
  "dsh-tokens.css", "assist.css", "inline-img.css", "review.css", "textedit.css",
  "mask.css", "fileview.css", "auth.css", "team.css", "sidebar-files.css",
  "asr.css", "recaudio.css", "search.css", "find.css", "pdf-view.css", "repair.css",
  "toolbuild.css", "longtask.css", "apps.css", "wallet.css", "whalecoin.css",
  "tips.css", "comments.css", "browser.css", "voice.css", "perf.css",
  "node-params.css", "ws-temp.css", "input-form.css", "canvas-dock.css",
  "theme-endfield.css", "mini-chat.css", "tts.css", "deepseek.css", "take-ui.css",
  "screenshot.css", "notify.css", "msg.css", "research.css", "research-slides.css",
  "ai-facts.css", "app-publish.css", "assist-isolated.css", "self-rebuild.css",
  "footer-mascot.css", "input-form.css",
];

/* ── 颜色工具 ───────────────────────────────────────────────────────────── */
const lin = (c) => {
  const x = c / 255;
  return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
};
const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
const hex2rgb = (h) => {
  let s = h.replace("#", "");
  if (s.length === 3) s = s.split("").map((c) => c + c).join("");
  const n = parseInt(s, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
};
const parseAnyColor = (v) => {
  const s = String(v || "").trim().toLowerCase();
  const m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if ([p[0], p[1], p[2]].some((x) => Number.isNaN(x))) return null;
    return { r: p[0], g: p[1], b: p[2] };
  }
  if (/^#[0-9a-f]{3,6}$/.test(s)) return hex2rgb(s);
  return null;
};
const rgb2hex = (c) =>
  "#" + [c.r, c.g, c.b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join("");

/* ── 一、品牌 / 强调色：暗色侧那几支 → 亮色侧（白底 ≥4.5:1 的深色版） ─────
   只认「值」，不认主题：同一个 #38d6ff 在四档皮肤里都表示强调青。 */
const ACCENTS = [
  // 青 / 蓝
  ["#38d6ff", "#0a7489"], ["#7ce8ff", "#08667a"], ["#5686fe", "#155fb0"],
  ["#7ca2fe", "#155fb0"], ["#4d9bff", "#155fb0"], ["#2f9eff", "#155fb0"],
  ["#22a6f2", "#155fb0"], ["#7fd6ff", "#0a7489"], ["#4dd0e1", "#0a7489"],
  ["#3ea6d8", "#0a7489"], ["#7ec7f0", "#0a7489"], ["#38bdf8", "#0a7489"],
  // 信号黄 / 橄榄（终末地那两支）
  ["#fffa00", "#0a7489"], ["#f2f27a", "#08667a"], ["#d8d400", "#08667a"],
  ["#c6ca4c", "#6a4d00"], ["#b6d94a", "#0e5b33"], ["#e2dfd2", "#1d2a44"],
  ["#f6f4ea", "#1d2a44"], ["#ffd166", "#6a4d00"], ["#ffcf6a", "#7a4f00"],
  ["#dcae52", "#7a4f00"],
  // 橙 / 琥珀
  ["#ff8f2e", "#a94f08"], ["#ffb066", "#8a3f03"], ["#f97501", "#a94f08"],
  ["#ff9f43", "#a94f08"], ["#e89a3c", "#a94f08"], ["#d9660a", "#a94f08"],
  // 绿 / 成功
  ["#5fd68a", "#0e5b33"], ["#8ce03c", "#0e5b33"], ["#4ade80", "#0e5b33"],
  ["#7ce6a0", "#0e5b33"], ["#2f9e63", "#0e5b33"], ["#1d7a45", "#0e5b33"],
  ["#7fd6b8", "#0f6b5c"], ["#7fe0c8", "#0f6b5c"],
  // 红 / 危险
  ["#ff5f56", "#96201a"], ["#ff4a3d", "#96201a"], ["#e5383b", "#96201a"],
  ["#ff7d8d", "#96201a"], ["#ff4d4d", "#96201a"], ["#b3261e", "#96201a"],
  ["#cf2a1e", "#96201a"],
  // Material / Tailwind 那一族浅色变体（原皮肤里用它们当「浅色强调」）
  ["#ff8a65", "#a94f08"], ["#ff9c9c", "#96201a"], ["#e0a94a", "#7a4f00"],
  ["#ffd54f", "#6a4d00"], ["#ffe082", "#7a4f00"], ["#90caf9", "#155fb0"],
  ["#a5d6a7", "#0e5b33"], ["#f48fb1", "#96201a"], ["#ce93d8", "#5b3a8c"],
  ["#80deea", "#0a7489"], ["#4dd0e1", "#0a7489"], ["#ffab91", "#a94f08"],
  ["#b0bec5", "#5b6577"], ["#cfd8dc", "#5b6577"], ["#e0e0e0", "#5b6577"],
  ["#ffcc80", "#7a4f00"], ["#c5e1a5", "#0e5b33"], ["#9fa8da", "#5b3a8c"],
  ["#ffb74d", "#7a4f00"], ["#81c784", "#0e5b33"], ["#64b5f6", "#155fb0"],
  ["#e57373", "#96201a"], ["#ba68c8", "#5b3a8c"], ["#4db6ac", "#0f6b5c"],
  // 紫（判断 / 互斥节点那一族）
  ["#c3a6ec", "#5b3a8c"], ["#b3a4f5", "#5b3a8c"], ["#a9a2e0", "#5b3a8c"],
];
const ACCENT_MAP = new Map(ACCENTS.map(([a, b]) => [a, b]));

/* ── 二、面（background*）分档：源越暗 → 亮色侧越白，保持「谁在谁上面」的层序 ── */
const BG_BUCKETS = [
  [0.035, "#ffffff"],
  [0.075, "#fbfcfe"],
  [0.13, "#f5f7fa"],
  [0.23, "#eef2f7"],
  [0.45, "#e6ebf2"],
];
/* ── 三、线（border* / outline* / fill / stroke）→ 亮色侧三级梯度 ────────
   亮色的描边只有三档，全部取 css/theme-daylight.css 的令牌，不再各造一支灰：
     --line-hair    面板内区隔（表头下沿 / 行分隔 / 列分隔）
     --line         结构框（卡片 / 浮层 / 区域）
     --line-strong  控件可见边界（按钮 / 输入件，白底 3.07:1，过 WCAG 1.4.11）
   分档只看**源色在暗色世界里有多显眼**：暗色里几乎与底色同色的边（l < .20，
   #141414 / #2b2b2b 这类）在亮色里就是结构框 → --line；中间调灰（#6b6b6b 往上）
   在暗色里已经是一眼能看见的边 → 控件档 --line-strong。 */
const TOK = { hair: "var(--line-hair)", line: "var(--line)", strong: "var(--line-strong)" };
const LINE_BUCKETS = [
  [0.20, TOK.line],
  [1.01, TOK.strong],
];
/* 控件选择器：命中就无条件落 --line-strong（WCAG 1.4.11 对「控件可见边界」要求 ≥3:1）。
   输入件 / 按钮在暗色里常只给一条 rgba(255,255,255,.08) 的发丝边，光按 alpha 分档会
   把它们当成结构框，白底上还是看不出框 —— 所以选择器也算语义的一部分。 */
const CONTROL_SEL = /(^|[\s>+~,.:#[(])(input|select|textarea|button)([\s>+~,.:#[\]]|$)|btn|chip|\bico\b|-tab\b|tab\.|preset-sel|-ta\b/i;
/* 蒙层选择器：命中就整份值换成 --pop-scrim（浓度只由手写令牌层一处决定）。
   只认「铺满视口、把底下的界面压到后面」的那一族：#overlay / .mt-dialog / 搜索遮罩 /
   灯箱 / 工坊二级浮层 / 预览幕布 / 各种 -mask。小件上的深色淡墨（.md pre / .gv-note /
   .np-q-tip / .cdock-pop 这类深色小面板）不在此列 —— 它们不是蒙层，按原分档翻译。 */
const SCRIM_SEL = /#overlay\b|scrim|mt-dialog|mt-pop\b|lightbox|pdf-pv|apps-modal|-mask\b|curtain|tpl-sub-ov|yaml-viewer|review-dlg|pub-shot-cover|apps-dev-loading|appnode-picker|tts-confirm|eqmodal/;
const pick = (buckets, l) => {
  for (const [max, v] of buckets) if (l < max) return v;
  return null;
};

const COLOR_PROPS = new Set([
  "background", "background-color", "background-image",
  "border", "border-color", "border-top", "border-bottom", "border-left", "border-right",
  "border-top-color", "border-bottom-color", "border-left-color", "border-right-color",
  "border-block", "border-inline", "border-block-color", "border-inline-color",
  "box-shadow", "outline", "outline-color", "caret-color", "accent-color",
  "fill", "stroke", "stop-color", "flood-color",
  "scrollbar-color", "text-shadow",
]);
const COLOR_ONLY = new Set(["color"]);

function kindOf(prop) {
  if (prop === "color") return "text";
  if (/^(border|outline)/.test(prop)) return "line";
  if (prop === "box-shadow" || prop === "text-shadow") return "shadow";
  if (prop === "fill" || prop === "stroke" || prop === "stop-color" || prop === "flood-color") return "line";
  return "bg";
}

/* 一个颜色字面值 → 亮色侧的值；返回 null 表示「不动」
   hint.strong = 这条规则的选择器是控件（输入件 / 按钮 / 色板 …），线一律给控件档 */
function mapColor(raw, kind, hint) {
  const s = raw.trim().toLowerCase();
  const forceStrong = !!(hint && hint.strong);
  if (ACCENT_MAP.has(s)) return ACCENT_MAP.get(s);
  const m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    const [r, g, b] = p;
    let a = p.length > 3 ? p[3] : 1;
    if (a > 1) a = a / 100;
    if ([r, g, b].some((x) => Number.isNaN(x))) return null;
    /* 黑 / 近黑：阴影与压暗蒙层 → 冷灰蓝、浓度压低 */
    if (r < 40 && g < 40 && b < 40) {
      /* 黑边（border 上）：暗色世界靠「压黑」画出来的边界，语义分两支 ——
         ≥.3 的是硬边（色板描边 / 硬凹槽 / 虚线段），亮色下换成最轻一档发丝线
         （浅底上压一块黑影只会脏）；<.3 的只是把边压暗一点，本质是阴影，
         换成低浓度冷灰蓝，保留「软」的观感，不当硬线用。 */
      if (kind === "line") {
        if (forceStrong) return TOK.strong;
        if (a >= 0.3) return TOK.hair;
        const softEdge = Math.min(0.12, Math.max(0.03, a * 0.55));
        return "rgba(29, 42, 68, " + +softEdge.toFixed(2) + ")";
      }
      const soft = Math.min(kind === "shadow" ? 0.20 : 0.14, Math.max(0.02, a * (kind === "shadow" ? 0.4 : 0.5)));
      return "rgba(29, 42, 68, " + +soft.toFixed(2) + ")";
    }
    /* 白 / 近白：暗色里的高光与半透明白底 → 亮色里的低浓度冷灰（保留层级但不脏） */
    if (r > 200 && g > 200 && b > 200) {
      if (kind === "text") return a < 0.85 ? "rgba(29, 42, 68, " + +Math.max(0.55, a).toFixed(2) + ")" : "#1d2a44";
      /* 白边（border 上）：「按钮整个没边」的真正来源 —— rgba(255,255,255,.06~.14)
         是暗色里唯一能画出来的边，翻成 rgba(29,42,68,.02~.05) 就等于 1.02~1.2:1，
         白底上完全看不见。按暗色里那根线有多重分两档：
         ≥.16（已经是一眼能看见的边）→ 控件档 --line-strong；
         <.16（贴着底色的发丝线，多是结构框）→ 结构档 --line；
         控件选择器上的白边不论多细都走 --line-strong。 */
      if (kind === "line") return forceStrong || a >= 0.16 ? TOK.strong : TOK.line;
      const soft = Math.min(0.10, Math.max(0.02, a * 0.35));
      return "rgba(29, 42, 68, " + +soft.toFixed(2) + ")";
    }
    /* 其余带色半透明（品牌色光晕 / 状态色底）：按强调色映射，保留 alpha */
    const asHex = rgb2hex({ r, g, b });
    if (ACCENT_MAP.has(asHex)) {
      const t = hex2rgb(ACCENT_MAP.get(asHex));
      return "rgba(" + t.r + ", " + t.g + ", " + t.b + ", " + +a.toFixed(2) + ")";
    }
    /* 文字色：只按「够不够亮」翻成主字 / 次要字，**绝不能**落到背景分档里
       （落到那儿就是把浅色面当成字色 → 浅底浅字，正好是要防的那种 bug） */
    if (kind === "text") {
      const l = lum({ r, g, b });
      if (l < 0.62) return null;
      /* 文字不做半透明：暗色里 rgba(255,255,255,.55) 压在深底上是「弱化标签」，
         亮色里同一支半透明墨压在浅底上就只剩 3:1 —— 看着就是一片发虚的灰字。
         这里一律落成不透明的 --ink / --muted（5.9:1 起）。 */
      return l >= 0.8 ? "#1d2a44" : "#5b6577";
    }
    /* 深色半透明面：按背景分档抬亮；线直接落三级令牌（不再 hex + 保 alpha 合成，
       令牌本身已经是亮色侧那一档，再叠 alpha 只会又变回「看不见」） */
    const l = lum({ r, g, b });
    if (l < 0.45) {
      if (kind === "line") return forceStrong ? TOK.strong : pick(LINE_BUCKETS, l);
      const t = pick(BG_BUCKETS, l);
      if (!t) return null;
      const tc = hex2rgb(t);
      return "rgba(" + tc.r + ", " + tc.g + ", " + tc.b + ", " + +Math.max(0.35, a).toFixed(2) + ")";
    }
    return null;
  }
  const m2 = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (!m2) return null;
  const c = hex2rgb(s);
  const l = lum(c);
  if (kind === "text") {
    /* 亮字 → 深墨：够亮的走主字色，中间调走次要字色 */
    if (l >= 0.62) return l >= 0.80 ? "#1d2a44" : "#5b6577";
    return null;
  }
  if (kind === "shadow") {
    return l < 0.5 ? "#1d2a44" : null;
  }
  if (l >= 0.45) return null; // 已经够浅的面 / 线，不动
  if (kind === "line" && forceStrong) return TOK.strong;
  return pick(kind === "line" ? LINE_BUCKETS : BG_BUCKETS, l);
}

/* 蒙层判定：整份值里的颜色全是「近黑 + 半透明」（a ≥ .35），且至少有一个颜色。
   命中就把整份值换成 --pop-scrim —— 径向渐变那种三个同色 stops 也一并折叠成这一个值
   （暗色那圈本来就是同色 stops，只是靠 alpha 渐变做边缘，浅色侧不需要那层假渐变）。 */
function isScrimValue(value) {
  const colors = value.match(/rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}\b/g);
  if (!colors || !colors.length) return false;
  return colors.every((raw) => {
    const s = raw.trim().toLowerCase();
    const m = /^rgba?\(([^)]+)\)$/.exec(s);
    if (!m) return false; // 不透明十六进制 = 实色面，不是蒙层
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    let a = p.length > 3 ? p[3] : 1;
    if (a > 1) a /= 100;
    if ([p[0], p[1], p[2]].some((x) => Number.isNaN(x))) return false;
    return p[0] < 40 && p[1] < 40 && p[2] < 40 && a >= 0.35;
  });
}

/* 把一段值里的颜色字面值逐个替换（保留其它 token 原样） */
function mapValue(value, kind, hint) {
  /* 蒙层：整份值换成一个令牌（只在 background / background-color 上，由调用方保证） */
  if (hint && hint.scrim && kind === "bg" && isScrimValue(value)) return "var(--pop-scrim)";
  let changed = false;
  const out = value.replace(/(#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\))/g, (raw) => {
    const mapped = mapColor(raw, kind, hint);
    if (mapped && mapped !== raw.toLowerCase()) {
      changed = true;
      return mapped;
    }
    return raw;
  });
  if (!changed) return null;
  /* 兜底值本身被翻成同一个令牌时（var(--line, #2b2b2b) → var(--line, var(--line))）
     折叠成单层，别在生成物里留自指的 var() */
  return out.replace(/var\((--[\w-]+),\s*var\((--[\w-]+)\)\)/g, (all, a, b) => (a === b ? "var(" + a + ")" : all));
}

/* ── 四、极简 CSS 解析：拿到「选择器 → 声明」，递归进 @media / @supports ──── */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}
function findBlockEnd(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return i;
  }
  return src.length;
}
/* 返回 [{ kind: "rule"|"at", prelude, rules: [...] , decls }] */
function parse(src, start = 0, end = src.length) {
  const nodes = [];
  let i = start;
  while (i < end) {
    const open = src.indexOf("{", i);
    if (open < 0 || open >= end) break;
    const prelude = src.slice(i, open).trim();
    const close = findBlockEnd(src, open);
    const body = src.slice(open + 1, close);
    if (prelude.startsWith("@")) {
      if (/^@(media|supports|container|layer)/.test(prelude)) nodes.push({ kind: "at", prelude, children: parse(src, open + 1, close) });
      /* @keyframes / @font-face / @page 等一律跳过 */
    } else if (prelude) {
      nodes.push({ kind: "rule", prelude, decls: splitDecls(body) });
    }
    i = close + 1;
  }
  return nodes;
}
function splitDecls(body) {
  const out = [];
  /* 声明里可能带 url(...) 或括号，按「顶层分号」切 */
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === ";" && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.map((d) => {
    const k = d.indexOf(":");
    if (k < 0) return null;
    return { prop: d.slice(0, k).trim(), value: d.slice(k + 1).trim() };
  }).filter(Boolean);
}

const SKIP_SELECTOR = /^(:root|html|body\.theme-|body\.ef-skin\.theme-daylight)/;

function prefixSelector(sel) {
  return sel
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      /* 已经提级过的（各文件里 migrate 过的亮色覆盖）不要再叠一层：
         叠成 body.ef-skin.theme-light.theme-light 会多出一个类，权重反而更高，
         把 theme-daylight.css 里手写的覆盖压掉（实测：搜索遮罩被压成白色 35%）。 */
      if (/^body\.ef-skin\.theme-light\b/.test(s)) return null;
      if (/^body\.ef-skin\b/.test(s)) return s.replace(/^body\.ef-skin/, "body.ef-skin.theme-light");
      if (/^body\b/.test(s)) return s.replace(/^body/, "body.ef-skin.theme-light");
      return "body.ef-skin.theme-light " + s;
    })
    .filter(Boolean)
    .join(", ");
}

let stat = { files: 0, rules: 0, kept: 0, decls: 0 };
function emit(nodes, out, indent = "") {
  for (const n of nodes) {
    if (n.kind === "at") {
      const lines = [];
      emit(n.children, lines, indent + "  ");
      if (lines.length) {
        out.push(indent + n.prelude + " {");
        out.push(...lines);
        out.push(indent + "}");
      }
      continue;
    }
    stat.rules++;
    const decls = [];
    /* 这条规则是不是在画控件（输入件 / 按钮 / 色板）：是的话线一律落控件档；
       是不是一块蒙层（#overlay / .mt-dialog / 灯箱 …）：是的话底色整份落 --pop-scrim */
    const hint = { strong: CONTROL_SEL.test(n.prelude), scrim: SCRIM_SEL.test(n.prelude) };
    /* 先看这条规则映射后的底色是不是「强调色实底」（深且饱和）：是就把深色字翻白。
       原皮肤是「深字压亮黄 / 亮青」，亮色侧那支强调色已经压深（#0a7489），
       深字压上去就是 3.4:1 —— 同一处必须成对翻。 */
    let accentFill = false;
    for (const d of n.decls) {
      const prop = d.prop.toLowerCase();
      if (!/^(background|background-color)$/.test(prop)) continue;
      const m = mapValue(d.value, "bg", hint);
      if (!m) continue;
      const hexes = m.match(/#[0-9a-f]{6}/gi) || [];
      for (const h of hexes) {
        const c = hex2rgb(h);
        if (lum(c) < 0.32) accentFill = true;
      }
    }
    for (const d of n.decls) {
      const prop = d.prop.toLowerCase();
      const isColorProp = COLOR_PROPS.has(prop) || COLOR_ONLY.has(prop) || /^(background|border|outline|--)/.test(prop);
      if (!isColorProp) continue;
      if (prop.startsWith("--")) continue; // 变量由手写令牌层负责
      const kind = COLOR_ONLY.has(prop) ? "text" : kindOf(prop);
      const imp = /!important\s*$/i.test(d.value) ? " !important" : "";
      const rawVal = d.value.replace(/!important\s*$/i, "").trim();
      if (accentFill && prop === "color") {
        const c0 = parseAnyColor(rawVal);
        if (c0 && lum(c0) < 0.45) {
          decls.push("  " + prop + ": #ffffff" + imp + ";");
          continue;
        }
      }
      /* 蒙层只看 background / background-color：background-image 上的渐变纹理不能被换成单色 */
      const scrimHint = hint.scrim && (prop === "background" || prop === "background-color")
        ? hint
        : { strong: hint.strong, scrim: false };
      const mapped = mapValue(rawVal, kind, scrimHint);
      if (mapped) decls.push("  " + prop + ": " + mapped + imp + ";");
    }
    if (!decls.length) continue;
    const sel = prefixSelector(n.prelude);
    if (!sel || SKIP_SELECTOR.test(n.prelude.trim())) continue;
    if (/^body\.ef-skin\.theme-light/.test(n.prelude.trim())) continue;
    stat.kept++;
    stat.decls += decls.length;
    out.push(indent + sel + " {");
    out.push(...decls.map((d) => indent + d));
    out.push(indent + "}");
  }
}

/* ── 主流程 ─────────────────────────────────────────────────────────────── */
const header = `/* ══════════════════════════════════════════════════════════════════════════
   亮色主题 · 皮肤层（**生成物，勿手改**）

   由 scripts/gen-theme-daylight-skin.mjs 生成：按一张显式的「字面值 → 令牌」映射表，
   把四档共用皮肤（css/theme-endfield.css）与各组件里写死的深色面 / 深色线 /
   黑色阴影 / 亮色文字 / 品牌强调色，批量翻译成亮色侧的值。
   所有规则前缀 body.ef-skin.theme-light —— 比 body.ef-skin 高一个类，
   稳定压过暗色皮肤，且不需要 !important。

   要改亮色的颜色：改令牌 → 改 css/theme-daylight.css（手写层）；
   要改这张映射表本身 → 改 scripts/gen-theme-daylight-skin.mjs 的 ACCENTS /
   BG_BUCKETS / LINE_BUCKETS / SCRIM_SEL（以及 mapColor 里的白边 / 黑边两支），
   再重跑生成，不要手改本文件。描边只有三级令牌：--line-hair / --line / --line-strong；
   蒙层只有一个令牌：--pop-scrim（浓度在手写令牌层定义，这里只把值换成它）。

   验收：node test/verify-theme-light-contrast.js（真机离屏渲染 + 逐元素对比度）
   ══════════════════════════════════════════════════════════════════════════ */

`;

const body = [];
const seen = new Set();
for (const name of SOURCES) {
  if (seen.has(name)) continue;
  seen.add(name);
  const p = path.join(CSS_DIR, name);
  if (!fs.existsSync(p)) continue;
  const src = stripComments(fs.readFileSync(p, "utf8"));
  const nodes = parse(src);
  const out = [];
  emit(nodes, out);
  if (!out.length) continue;
  stat.files++;
  body.push("/* ── 源：css/" + name + " ─────────────────────────────────────────────── */");
  body.push(...out);
  body.push("");
}

const text = header + body.join("\n") + "\n";
console.log("源文件 " + stat.files + " 个 / 扫到规则 " + stat.rules + " 条 / 保留 " + stat.kept + " 条 / 声明 " + stat.decls + " 条");
console.log("输出 " + (text.length / 1024).toFixed(1) + " KB → " + path.relative(ROOT, OUT));
if (!DRY) {
  fs.writeFileSync(OUT, text, "utf8");
  console.log("已写入");
}
