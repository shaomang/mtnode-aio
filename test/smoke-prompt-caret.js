"use strict";
/* 节点提示词「透明 textarea + 背景高亮层」点击落点 —— 纯 Node 冒烟测试（不依赖 Electron）
 *   node test/smoke-prompt-caret.js
 * 与 test/smoke-rel-layout.js / test/smoke-global-refs.js 同一套路：
 * 正则抽取源码与 CSS 来跑，不改动任何源文件、不启动 Electron。
 *
 * 背景（修的 bug）：画布节点的 Prompt 输入框是两层叠放 —— 文字透明的 textarea
 * (.n-text.n-text-layered) 盖在可见的高亮镜像层 (.n-prompt-hl) 上。用户「看见」的是
 * 镜像层的字，「编辑」的是 textarea。两层的排版几何一旦不同（滚动条槽位、断行规则），
 * 软换行位置就错开：点击落点按窄宽度算，光标却显示在别处 → 误编辑临近文字。
 * 图像处理节点（proc_image）最容易发生：它的 prompt 区被右侧 .n-out 挤得更窄。
 *
 * 覆盖：
 *   [1] 两层的排版度量逐条相同（padding / border 宽 / 字号 / 行高 / 字体 / 字距 /
 *       tab-size / white-space / overflow-wrap / word-break / scrollbar-gutter / 盒模型）
 *   [2] 没有任何旁路 CSS 打破这份一致性；滚动条槽宽有共同来源（10px）
 *   [3] 高亮层正文与 textarea 实际值严格同源（跑真实 promptRefBackdropHtml）
 *   [4] syncPromptRefBackdrop 不再手工按 endsWith 补换行，且滚动位置双向同步
 *   [5] 同步时机齐全（input/scroll 之外补 select/selectionchange/focus/compositionend）
 *   [6] caretXY 命中链路：补画布缩放补偿、镜像断行抄 textarea、补扣 scrollLeft
 *   [7] 影响面收敛：只有这一处编辑器被改动（助手侧栏 / 设置 / 批量条目未受牵连） */
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
const eqStr = (a, b, msg) => ok(a === b, msg + "（得到 " + show(a) + "，期望 " + show(b) + "）");
const eqNum = (a, b, msg) => ok(a === b, msg + "（得到 " + a + "，期望 " + b + "）");
const eqArr = (a, b, msg) => ok(show(a) === show(b), msg + "（得到 " + show(a) + "）");

/* ---------- 从源码里按名字抠出顶层函数 / 常量（不改动源文件） ---------- */
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
  const isFn = /^(async\s+)?function/.test(src.slice(at, at + 14));
  if (!isFn) {
    const eol = src.indexOf("\n", at);
    return src.slice(at, eol + 1);
  }
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
    /* 注释先于引号判断：注释里的英文撇号（it's）会被误认成串起点 */
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
const extract = (src, names) => names.map((n) => fnBody(src, n)).join("\n");

/* ---------- 极简 CSS 解析：选择器 → 声明（够用即可，不引依赖） ---------- */
function parseRules(src, file) {
  const s = src.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  let order = 0;
  while ((m = re.exec(s))) {
    const sel = m[1].trim().replace(/\s+/g, " ");
    if (!sel || sel.startsWith("@") || sel.endsWith("@")) continue;
    const decls = {};
    for (const d of m[2].split(";")) {
      const i = d.indexOf(":");
      if (i < 0) continue;
      const k = d.slice(0, i).trim().toLowerCase();
      const v = d.slice(i + 1).trim();
      if (!k || k.startsWith("/*")) continue;
      if (/!important/.test(v)) decls["*" + k] = v.replace(/\s*!important/, "");
      else decls[k] = v;
    }
    /* border 简写拆出边框宽度：两侧 border 颜色/样式本就允许不同 */
    if (decls.border !== undefined) {
      const t = decls.border.split(/\s+/).find((x) => /^[\d.]+(px|em|rem)$/.test(x));
      if (t !== undefined) decls["border-width"] = t;
      delete decls.border;
    }
    out.push({
      sel,
      parts: sel.split(",").map((x) => x.trim()),
      decls,
      file,
      order: order++,
    });
  }
  return out;
}
/* 就近似按「类/属性选择器个数」比较特异性，再按文档顺序 */
const spec = (sel) => (sel.match(/[.#\[]/g) || []).length;
function merged(rules, targets) {
  const hit = rules
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.parts.some((p) => targets.indexOf(p) >= 0))
    .sort((a, b) => spec(a.r.sel) - spec(b.r.sel) || a.i - b.i);
  const out = {};
  for (const { r } of hit) for (const k in r.decls) out[k] = r.decls[k];
  return { map: out, from: hit.map(({ r }) => r.file + ":" + r.sel) };
}

const cssDir = path.join(__dirname, "..", "renderer", "css");
const cssFiles = fs
  .readdirSync(cssDir)
  .filter((f) => f.endsWith(".css"))
  .sort();
const ALL_RULES = [];
for (const f of cssFiles) {
  for (const r of parseRules(read("renderer/css/" + f), f)) ALL_RULES.push(r);
}
const HL_TARGETS = [".n-prompt-hl"];
const TA_TARGETS = [".n-text", ".n-text[readonly]", ".n-prompt .n-text"];
const layered = ALL_RULES.filter((r) => r.parts.indexOf(".n-text.n-text-layered") >= 0);
const hlRules = ALL_RULES.filter((r) => r.parts.some((p) => HL_TARGETS.indexOf(p) >= 0));
const taMap = Object.assign(
  merged(ALL_RULES, TA_TARGETS).map,
  merged(layered, [".n-text.n-text-layered"]).map,
);
const hlMap = merged(ALL_RULES, HL_TARGETS).map;

const appSrc = read("renderer/app.js");
const HL = fnBody(appSrc, "syncPromptRefBackdrop");

/* ===================== [1] 两层的排版度量逐条相同 ===================== */
console.log("\n[1] .n-text.n-text-layered（透明 textarea）↔ .n-prompt-hl（可见镜像层）度量核对");
const METRICS = [
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border-width",
  "border-radius",
  "font-size",
  "font-weight",
  "font-family",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "tab-size",
  "text-indent",
  "white-space",
  "overflow-wrap",
  "word-break",
  "scrollbar-gutter",
  "box-sizing",
];
for (const p of METRICS) {
  const a = taMap[p];
  const b = hlMap[p];
  ok(
    a === b,
    "排版属性两侧一致：" +
      p +
      "（textarea=" +
      show(a === undefined ? "(未声明)" : a) +
      "，hl=" +
      show(b === undefined ? "(未声明)" : b) +
      "）",
  );
}
ok(
  taMap["*word-break"] === undefined && hlMap["*word-break"] === undefined,
  "两侧都没有 !important 版 word-break（断行机会不受强推）",
);
console.log(
  "      · hl 规则命中：" + hlRules.map((r) => r.file + ":" + r.sel).join(" / "),
);
console.log(
  "      · textarea 规则命中：" +
    merged(ALL_RULES, TA_TARGETS).from.concat(["canvas.css:.n-text.n-text-layered"]).join(" / "),
);

/* ===================== [2] 没有旁路 CSS 打破一致性 ===================== */
console.log("\n[2] 断行与滚动条槽：无残留差异");
ok(
  hlRules.every((r) => r.decls["word-break"] === undefined),
  ".n-prompt-hl 不再声明 word-break（textarea 侧没有这条，多出来就会让长 token 断在不同列）",
);
eqStr(taMap["word-break"], undefined, "textarea 侧同样没有 word-break（走初始 normal）");
eqStr(taMap["scrollbar-gutter"], "stable", "textarea 恒定预留滚动条槽（出不出滚动条排版宽度都一样）");
eqStr(hlMap["scrollbar-gutter"], "stable", "镜像层同样预留滚动条槽（否则宽度差 10px → 换行错位）");
eqStr(hlMap["overflow"], "hidden", "镜像层 overflow: hidden（滚动由 scrollTop 同步，不自己出条）");
const scrollbarRule = (read("renderer/css/components.css").match(
  /::-webkit-scrollbar\s*\{[^}]*\}/,
) || [""])[0];
ok(
  /width:\s*10px/.test(scrollbarRule),
  "classic 滚动条宽度有共同来源（components.css ::-webkit-scrollbar width:10px → 两侧扣掉同一宽度）",
);
/* 派生选择器（.xxx .n-text / .n-text.n-y）可能悄悄只给一层加度量，全量扫一遍 */
const stray = [];
for (const r of ALL_RULES) {
  if (TA_TARGETS.concat([".n-text.n-text-layered"]).some((t) => r.parts.indexOf(t) >= 0))
    continue;
  if (HL_TARGETS.some((t) => r.parts.indexOf(t) >= 0)) continue;
  const touchesT = r.parts.some((p) => /\.n-text\b/.test(p));
  const touchesH = r.parts.some((p) => /n-prompt-hl/.test(p));
  if (!touchesT && !touchesH) continue;
  for (const p of METRICS)
    if (r.decls[p] !== undefined) stray.push(r.file + ":" + r.sel + "{" + p + ":" + r.decls[p] + "}");
}
eqArr(stray, [], "没有第三条规则单独给其中一层加排版度量（会把对齐悄悄破坏掉）");
/* 两层是兄弟节点，祖先的继承型度量必须同时命中两层（否则一边继承到、一边没继承到） */
const wrap = merged(ALL_RULES, [".n-prompt-wrap"]);
const promptBox = merged(ALL_RULES, [".n-prompt"]);
ok(
  wrap.map["word-break"] === undefined &&
    wrap.map["letter-spacing"] === undefined &&
    wrap.map["tab-size"] === undefined &&
    promptBox.map["word-break"] === undefined &&
    promptBox.map["letter-spacing"] === undefined,
  ".n-prompt-wrap / .n-prompt 都没有可继承的排版度量（两层的继承链同样干净）",
);

/* ===================== [3] 高亮层正文与 textarea 严格同源（跑真实函数） ===================== */
console.log("\n[3] promptRefBackdropHtml：正文 = textarea 实际值 + 恒定尾部占位");
const sandbox = {
  S: { wf: { nodes: [], wires: [], tagCatalog: ["资料"] } },
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
  /* 候选清单只影响 @ 是否着色，与本轮排版一致性无关 → 测试侧替身 */
  refCandidates: () => [{ id: "nA", title: "素材甲" }],
  refTagCandidates: () => ["资料"],
};
vm.createContext(sandbox);
vm.runInContext(
  extract(appSrc, [
    "escapePromptHl",
    "PROMPT_HL_TAIL",
    "promptRefBackdropHtml",
    "findCandidateByTitle",
    "tagByAtToken",
    "normalizeTagName",
    "wfTagCatalog",
  ]),
  sandbox,
  { filename: "prompt-caret-extract.js" },
);
const F = (expr) => vm.runInContext(expr, sandbox);
const TAIL = F("PROMPT_HL_TAIL");
const html = (v) => F("promptRefBackdropHtml")(v, { id: "me", kind: "proc_image" });
eqStr(TAIL, "\n", "尾部占位是恒定常量（不再按 endsWith 分支决定补不补）");
eqStr(html("abc"), "abc\n", "普通文本 → 原样 + 一行占位");
eqStr(html(""), "\n", "空值 → 只有一个占位（与 textarea 的空行等行数）");
eqStr(html(null), "\n", "null 同样安全（不抛异常、不留空层）");
for (const v of ["abc", "两行\n正文", "结尾有换行\n", "连续两个换行\n\n"])
  eqStr(
    html(v + "\n"),
    html(v) + TAIL,
    "值多一个行尾换行 → 镜像层只多一个占位（行数与 textarea 同步，不整层漂移）：" + show(v),
  );
eqStr(
  (html("a\nb\nc").match(/\n/g) || []).length,
  3,
  "占位只追加一次（三行文本 → 三个行尾换行，没有累加）",
);
eqStr(html("<b>&x"), "&lt;b&gt;&amp;x\n", "HTML 元字符仍被转义（同源不等于放弃转义）");
ok(
  html("看 @素材甲 的图").indexOf('<span class="at-ref-node">@素材甲</span>') >= 0,
  "@标题 着色照旧生效（改动没有破坏引用高亮）",
);
ok(
  html("看 @资料 的内容").indexOf('<span class="at-ref-tag">@资料</span>') >= 0,
  "@标签 着色照旧生效",
);
ok(
  html("看 @不存在 的内容").indexOf("<span") < 0,
  "不存在的 @词 不着色、也不吞字符（正文与 textarea 完全一致）",
);

/* ===================== [4] syncPromptRefBackdrop 不再手工补换行 ===================== */
console.log("\n[4] syncPromptRefBackdrop：与 textarea 同一份文本 + 滚动位置双向同步");
ok(
  HL.indexOf("endsWith(") < 0,
  "没有残留的 endsWith(\"\\n\") 手工补换行 hack（分支补行正是漂移来源）",
);
ok(
  /promptRefBackdropHtml\(\s*String\(\s*ta\.value\s*\|\|\s*""\s*\)\s*,\s*node\s*\)/.test(HL),
  "镜像层正文直接取 textarea 当前值（唯一真源），且空值兜底",
);
eqStr(
  (function () {
    const m = HL.match(/innerHTML\s*=\s*([^;]+);/);
    return m ? m[1].trim() : "<无>";
  })(),
  'promptRefBackdropHtml(String(ta.value || ""), node)',
  "innerHTML 只有这一处赋值（不存在第二条写回路径把正文改写成长度不同的版本）",
);
ok(
  HL.indexOf("hl.scrollTop = ta.scrollTop") >= 0 &&
    HL.indexOf("hl.scrollLeft = ta.scrollLeft") >= 0,
  "纵向 + 横向滚动位置都同步（此前只同步 scrollTop）",
);
ok(
  fnBody(appSrc, "promptRefBackdropHtml").indexOf("PROMPT_HL_TAIL") >= 0,
  "占位追加发生在 promptRefBackdropHtml 内部（任何调用者拿到的都是同一份尾部）",
);
eqStr(
  HL.indexOf("PROMPT_HL_TAIL") < 0,
  true,
  "占位不在 syncPromptRefBackdrop 里重复追加（避免叠加成两行）",
);

/* ===================== [5] 同步时机齐全 ===================== */
console.log("\n[5] mountPromptTextarea：值/滚动可能变化的时机都补一次同步");
const mount = fnBody(appSrc, "mountPromptTextarea");
/* 事件名可能直接写在 addEventListener 首参里，也可能出现在事件名数组字面量中 */
const listedEvents = new Set();
for (const blk of mount.match(/\[\s*(?:"[^"]+"\s*,?\s*)+\]/g) || [])
  for (const m2 of blk.match(/"([^"]+)"/g)) listedEvents.add(m2.slice(1, -1));
const hasListener = (ev) =>
  new RegExp('addEventListener\\(\\s*"' + ev + '"').test(mount) || listedEvents.has(ev);
for (const ev of ["input", "scroll"])
  ok(hasListener(ev), "原有同步时机保留：" + ev);
for (const ev of ["select", "selectionchange", "focus", "compositionend"])
  ok(hasListener(ev), "新增同步时机：" + ev + "（拖拽改选 / 重新聚焦 / 输入法上屏）");
ok(
  /for \(const ev of \[[^\]]*\]\)\s*\n?\s*ta\.addEventListener\(ev, syncHl\)/.test(mount),
  "新增时机统一挂同一个 syncHl（不再各写各的）",
);
const inputBlock = (mount.match(/addEventListener\(\s*"input"[\s\S]*?\}\)/) || [""])[0];
const idxIn = (s, n) => s.indexOf(n);
ok(
  idxIn(inputBlock, "persistPrompt") >= 0 &&
    idxIn(inputBlock, "persistPrompt") < idxIn(inputBlock, "refTick") &&
    idxIn(inputBlock, "refTick") < idxIn(inputBlock, "syncHl") &&
    idxIn(inputBlock, "syncHl") < idxIn(inputBlock, "slashTick"),
  "input 链路顺序仍是 persistPrompt → refTick → syncHl → slashTick（未打乱原有引用/斜杠菜单流程）",
);
const scrollBlock = (mount.match(/addEventListener\(\s*"scroll"[\s\S]*?\}\)/) || [""])[0];
ok(
  idxIn(scrollBlock, "closeRefMenu") >= 0 &&
    idxIn(scrollBlock, "closeSlashMenu") >= 0 &&
    idxIn(scrollBlock, "syncHl") >= 0,
  "scroll 链路保留（滚动时关菜单 + 同步镜像层）",
);
ok(
  mount.indexOf("document.addEventListener") < 0,
  "没有注册 document 级监听（节点反复重渲染会泄漏监听器）",
);
ok(
  /ta\.classList\.add\("n-text-layered"\)/.test(mount) &&
    /hl\.className\s*=\s*"n-prompt-hl"/.test(mount) &&
    mount.indexOf('wrap.appendChild(hl)') < mount.indexOf("wrap.appendChild(ta)"),
  "DOM 结构不变：镜像层先入 .n-prompt-wrap、textarea 后入（透明层仍浮在上接收点击）",
);
ok(
  /hl\.setAttribute\("aria-hidden",\s*"true"\)/.test(mount),
  "镜像层对读屏隐藏（重复文本不会被无障碍读两遍）",
);

/* ===================== [6] caretXY 命中链路 ===================== */
console.log("\n[6] caretXY：@ / 斜杠弹层落点（第二处偏移）");
const caret = fnBody(appSrc, "caretXY");
const caretDoc = (function () {
  const i = appSrc.indexOf("function caretXY(");
  const s = appSrc.lastIndexOf("/*", i);
  return s >= 0 && i - s < 2200 ? appSrc.slice(s, i) : "";
})();
ok(
  /r\.width\s*\/\s*ta\.offsetWidth/.test(caret) && /r\.height\s*\/\s*ta\.offsetHeight/.test(caret),
  "本地位移乘上实测渲染倍率（kx/ky 由元素自身矩形反推）→ 画布缩放 ≠100% 时弹层不再整体偏离光标",
);
ok(
  caret.indexOf("S.cam") < 0,
  "倍率不读 S.cam.z（助手侧栏 / 会话面板里同类输入框不在画布变换下，倍率天然是 1，一份代码两种场合都对）",
);
ok(
  caret.indexOf("cs.wordBreak") >= 0 && caret.indexOf("cs.overflowWrap") >= 0,
  "镜像的断行规则抄 textarea 的计算值（长 URL / 连续 token 时换行点与实际正文一致）",
);
ok(
  !/word-break:\s*break-all/.test(caret),
  "不再写死 word-break:break-all（这正是量出来整行偏掉的来源）",
);
ok(
  /width:"\s*\+\s*ta\.clientWidth/.test(caret) || /ta\.clientWidth/.test(caret),
  "镜像宽度用 ta.clientWidth（已排除边框与滚动条槽，等于 textarea 的内容宽）",
);
ok(
  caret.indexOf("cs.borderLeftWidth") >= 0 && caret.indexOf("cs.borderTopWidth") >= 0,
  "原点补上 1px 边框（getBoundingClientRect 的原点在边框外沿，镜像没有边框）",
);
ok(
  caret.indexOf("ta.scrollLeft") >= 0 && caret.indexOf("ta.scrollTop") >= 0,
  "横向 + 纵向滚动都扣减（原先只扣 scrollTop，横向滚动时弹层会偏）",
);
ok(
  /cs\.tabSize/.test(caret),
  "镜像补 tab-size（与 CSS 两侧钉死为同一值呼应）",
);
ok(
  caretDoc.indexOf("缩放") >= 0 &&
    (caretDoc.indexOf("几何") >= 0 || caretDoc.indexOf("scrollbar-gutter") >= 0),
  "排查结论写进函数头注释（勿再猜：缩放只影响弹层落点，误编辑根因是两层几何差）",
);

/* ===================== [7] 影响面收敛 ===================== */
console.log("\n[7] 只改这一处编辑器（其余编辑器不受牵连）");
const jsFiles = fs
  .readdirSync(path.join(__dirname, "..", "renderer"))
  .filter((f) => f.endsWith(".js"))
  .sort();
const hlOwners = [];
for (const f of jsFiles) {
  const src = read("renderer/" + f);
  if (src.indexOf("n-prompt-hl") >= 0 || src.indexOf("n-text-layered") >= 0) hlOwners.push(f);
}
eqArr(hlOwners, ["app.js"], "只有 renderer/app.js 涉及这两层（助手侧栏 / 设置 / 批量条目没有被顺手改动）");
for (const f of ["app-assist.js", "app-settings.js", "app-db.js", "app-nodes.js", "app-canvas.js"]) {
  const src = read("renderer/" + f);
  ok(
    src.indexOf("PROMPT_HL_TAIL") < 0 && src.indexOf("syncPromptRefBackdrop") < 0,
    f + " 未引用本次新增的占位常量 / 同步函数（无跨模块耦合）",
  );
}
const bentry = (read("renderer/css/components.css").match(/\.bentry-text\s*\{[^}]*\}/) || [""])[0];
ok(
  bentry.indexOf("scrollbar-gutter") < 0,
  "批量条目输入框 .bentry-text 没有被加 scrollbar-gutter（任务范围外，保持原样）",
);
ok(
  fnBody(appSrc, "promptRefBackdropHtml").indexOf("selectRefEntry") < 0 &&
    /syncPromptRefBackdrop\((ta|rm\.ta), rm\.node\)/.test(
      fnBody(appSrc, "selectRefEntry"),
    ),
  "写回引用值的链路仍走原函数（@ 菜单确认——点选或回车——后照旧刷新镜像层）",
);

console.log("\n———— " + (checks - fails) + "/" + checks + " 通过 ————");
if (fails) {
  console.log(fails + " 项失败");
  process.exit(1);
}
console.log("全部通过");
