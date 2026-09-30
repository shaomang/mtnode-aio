"use strict";
/* Agent 预设「思维精简 lean」（原名「草图模式 sketch」，本文件随档位同步改名）
 * ——冒烟测试（纯 Node + 源码切片 vm 求值，不依赖 Electron）
 *   node test/smoke-agent-preset-lean.js
 * 覆盖：
 *   [1] 网关 PRESETS.lean：压缩后的单段提示纪律（GOAL/GIVEN/DECIDE 一行 + Structured CoT 硬骨架
 *       / Sketch-of-Thought 符号化 / CRISP 剪枝）+ 长度预算 +「不再声明工具授权、无方法标号」
 *       + 深推理破例逃生口 + 就近来源注释 + 注释声明「本档不碰思考强度」
 *   [2] 思考档只看设置：EFFORTS 仍含 low、normalizeEffort 归一表、按预设压档的旧机制
 *       （PRESET_EFFORT_CAPS / effortForPreset）已整体拆除且无残留、
 *       applySettings 与 getRuntime 用同一个 runEffort、旧 off/none→high 回退链原样
 *   [3] 旧 id 兼容：LEGACY_PRESET_IDS / normalizePresetId —— 历史存的 sketch 仍解析到 lean
 *       （预设文本不丢），且归一后思考档仍原样跟随设置
 *   [4] 渲染层单一真源：AGENT_PRESETS 五档含 lean、兜底解析、四处 UI 全部消费真源且无第二份硬编码；
 *       lean 档位文案不再承诺「自动降为 low」，真源表不再有 effortCap 字段
 *   [5] 思考档显示：agentEffortDisplayLabel 只按所选档位出「标准 / 最强」（与 preset 无关），
 *       「生效档」那一套（effectiveAgentEffort / agentEffortDisplayTip / 低（思维精简））已全拆净
 *   [6] i18n：精简档位名 / hint 与新思考档文案全部有英文词条；五档 × 3 条档位文案全部可译；
 *       随压档机制一起废弃的死词条已从翻译表清除；渲染层无残留旧档位名
 *   [7] 既有决议无回归：pure / nodeLock 预设决议分支与网关空预设链路未被改动
 *   [8] 文档同口径：中 / 英手册、开发节点手册、dev-architect 技能、更新文档与实测报告
 *       都不再写「自动降为 low / 生效：低（思维精简）」，报告顶部有时效性说明 */
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
/* 读源码做字面切片：**统一成 LF** 再切。仓库里 CRLF 与 LF 并存（gateway.mjs 等是
   CRLF），带 "\n}\n" 这类多行锚点的切片在 CRLF 文件上永远命中不了 —— 那是换行符的
   差异，不是代码跑偏。归一之后断言只看内容。 */
const read = (rel) =>
  fs
    .readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8")
    .replace(/\r\n/g, "\n");

/* 源码切片：从 startMark 起、到 endMark 止（endMark 可为 null 表示用到下一个闭括号锚点） */
function between(src, startMark, endMark, label) {
  const a = src.indexOf(startMark);
  const b = a >= 0 ? src.indexOf(endMark, a) : -1;
  ok(a >= 0 && b > a, "定位到 " + label);
  return a >= 0 && b > a ? src.slice(a, b) : "";
}

const G = read("dsh/gateway/gateway.mjs");
const APP = read("renderer/app.js");
const ASSIST = read("renderer/app-assist.js");
const CANVAS = read("renderer/app-canvas.js");
const SETTINGS = read("renderer/app-settings.js");
const DEVNODE = read("renderer/app-devnode.js");
const DB = read("renderer/app-db.js");
const I18N = read("renderer/i18n.js");

/* ==================== [1] 网关 PRESETS.lean 文本 ==================== */
console.log("\n[1] 网关 PRESETS.lean：四法融合 + 工具授权表述");
const preSrc = (() => {
  const a = G.indexOf("const PRESETS = {");
  const b = G.indexOf("\n}\n", a);
  return a >= 0 && b > a ? G.slice(a, b + 2) : "";
})();
ok(!!preSrc, "定位到 PRESETS 定义块");
const PRESETS = vm.runInNewContext(preSrc + "\nPRESETS");
ok(
  ["standard", "minimal", "code", "cordis", "lean", "node", "bongochat", "pure"].every(
    (k) => Object.prototype.hasOwnProperty.call(PRESETS, k),
  ),
  "八档齐全：四可见档 + lean + 内部 node/bongochat/pure",
);
ok(
  !Object.prototype.hasOwnProperty.call(PRESETS, "sketch"),
  "旧档位 id sketch 已从 PRESETS 摘除（只留 LEGACY 别名）",
);
const LEAN = String(PRESETS.lean || "");
ok(LEAN.length >= 300 && LEAN.length <= 820, "lean 预设文本已压成单段（" + LEAN.length + " 字符）");
ok(LEAN.indexOf("Lean Thinking mode") >= 0, "只保留一句身份：自称 Lean Thinking mode（与档位名一致）");
ok(LEAN.indexOf("GOAL/GIVEN/DECIDE") >= 0, "F-CoT：输入先压成一行 GOAL/GIVEN/DECIDE");
ok(LEAN.indexOf("APPROACH(≤3 symbolic steps") >= 0, "Structured CoT：APPROACH ≤3 符号步");
ok(LEAN.indexOf("EDGE(one line)") >= 0, "Structured CoT：EDGE 一行风险");
ok(LEAN.indexOf("DO(concrete next action)") >= 0, "Structured CoT：DO 具体下一步");
ok(LEAN.indexOf("no added or removed sections") >= 0, "硬骨架：禁止增删小节");
ok(
  LEAN.indexOf("never restate user wording or tool output") >= 0,
  "禁止复述用户原话与工具输出",
);
ok(LEAN.indexOf("A→B") >= 0 && LEAN.indexOf("{candidate}/✔") >= 0, "SoT：箭头 + 符号化草图");
ok(LEAN.indexOf("never flowing prose") >= 0, "SoT：禁止连贯散文");
ok(
  LEAN.indexOf("drop any sentence that does not change the next decision") >= 0,
  "CRISP：不改变下一步决策的句子一律删",
);
ok(LEAN.indexOf("read/grep/query") >= 0, "CRISP：缺事实去查不脑补");
ok(LEAN.indexOf("break the skeleton ONCE") >= 0, "逃生口：真复杂任务允许破例展开一次深推理");
/* 压缩掉的装饰 token：工具授权声明整段删除（授权只由运行时【Agent 工具许可】段与
   app-db 的 nodeLock 决议决定，预设文本本来就不参与），方法标号 ①②③④ 也一并去掉。 */
ok(
  LEAN.indexOf("【Agent 工具许可】") < 0 && LEAN.indexOf("①") < 0,
  "压缩生效：预设文本不再声明工具授权、不再带方法标号",
);
/* 提示词只管表达形式：文本里不出现「effort / reasoning_effort / low」这类档位承诺，
   思考预算一律由宿主设置决定。 */
ok(
  !/reasoning_effort|\bcap\b|effort/i.test(LEAN),
  "lean 预设文本不含任何思考档承诺（不代用户决定思考强度）",
);
const leanComment = between(G, "/* 思维精简(压缩思考", "lean:", "lean 就近来源注释");
["Structured CoT", "GBNF", "Sketch-of-Thought", "CRISP", "Focused CoT", "nodeLock"].forEach((k) =>
  ok(leanComment.indexOf(k) >= 0, "注释写明来源：「" + k + "」"),
);
ok(leanComment.indexOf("原名草图模式 sketch") >= 0, "注释保留改名线索（原名 sketch，便于追溯）");
ok(leanComment.indexOf("压成单段") >= 0, "注释写明压缩的理由（省前缀 token）");
ok(
  leanComment.indexOf("本档不声明任何思考上限") >= 0,
  "注释写明：本档不声明思考上限，思考强度按界面选择走",
);

/* ==================== [2] 思考档：梯子真源在 reasoning-effort.mjs（0.2 抽模块） ====================
   本轮 0.2 升级把「档位梯子 + 归一化」从 gateway.mjs 抽成独立模块
   dsh/gateway/reasoning-effort.mjs（gateway 与运行时 mtnode-effort 插件共用；本模块自己的
   回归是 test/smoke-reasoning-effort.mjs）。这里改成**直接 import 真源**断言 —— 老写法在
   gateway 源码里做字面切片，抽模块后切片必然落空（那是位置变了，不是行为变了）。 */
console.log("\n[2] 思考档：EFFORTS 归一表 + 按预设压档机制已拆除");
const reSrc = read("dsh/gateway/reasoning-effort.mjs");
ok(reSrc.length > 0, "定位到 reasoning-effort.mjs（档位梯子的唯一真源）");
/* 本冒烟是 CJS（顶层没有 await）：把真源里的 `export ` 去掉后喂给 vm 求值，
   拿到的就是模块里那一份 EFFORTS / normalizeEffort（真源本身零依赖，可安全求值）。
   只剥行首的 `export ` —— 文本里出现的 "export" 是注释/字符串的一部分（v1 曾在
   这句话上翻车：把散文里的 export 也当关键字剥掉了）。 */
const reMod = vm.runInNewContext(
  reSrc.replace(/^export (?=(const|let|var|function|async|class)\b)/gm, "") +
    "\n({ EFFORTS, EFFORT_ORDER, normalizeEffort, DEFAULT_EFFORT })",
);
const EFFORTS = reMod.EFFORTS;
ok(Array.isArray(EFFORTS) && EFFORTS.join(",") === "off,low,medium,high,xhigh,max", "EFFORTS = off/low/medium/high/xhigh/max（0.2 扩档，off = 真关思考）");
ok(EFFORTS.length === 6 && EFFORTS[EFFORTS.length - 1] === "max", "梯子到 max 为止（没有比 max 更高的档）");
const ne = reMod.normalizeEffort;
ok(ne("high") === "high", "标准（high）原样下发");
ok(ne("max") === "max", "最强（max）原样下发");
ok(ne("low") === "low", "内部路径的 low 原样下发（文本节点少想这一档还在）");
ok(ne("MAX") === "max", "大小写容忍后归一");
ok(ne(undefined) === "high" && ne("") === "high", "缺省 / 空串 → high（标准）");
ok(ne("off") === "off" && ne("none") === "off" && ne("无") === "off", "off/none/无 → off（0.2 起「无」是真关思考，不再回退 high）");
ok(ne("瞎写") === "high", "非法值 → high 兜底（永不硬失败）");
/* 死机制清干净：既没有上限表，也没有按预设收敛的函数（留着就是没人调的假开关） */
ok(
  G.indexOf("PRESET_EFFORT_CAPS") < 0 ||
    (G.match(/PRESET_EFFORT_CAPS/g) || []).length === 1,
  "网关不再按预设压档：PRESET_EFFORT_CAPS 只剩注释里的一处溯源说明",
);
ok(G.indexOf("effortForPreset") < 0, "effortForPreset 函数已整体删除（无残留调用）");
ok(
  G.indexOf("normalizeEffort") >= 0 && G.indexOf("reasoning-effort.mjs") >= 0,
  "handleRun 的档位归一走抽出来的 reasoning-effort.mjs（gateway 只 import，不再自带梯子）",
);
ok(
  G.indexOf("applySettings(") >= 0 &&
    G.indexOf("settings.envPatch") >= 0,
  "settings（reasoningEffort）与 getRuntime（runtime key）用同一 runEffort，不分错档",
);
ok(
  reSrc.indexOf("LEGACY_TO_DEFAULT") >= 0 && reSrc.indexOf("DEFAULT_EFFORT") >= 0,
  "旧档（空串 / 未列入的旧值）→ high 的兼容表仍在真源里",
);
ok(
  G.indexOf("**不碰思考强度**") < 0 &&
    G.indexOf("不碰思考强度") >= 0,
  "预设契约注释仍写明「预设不碰思考强度」（措辞随 0.2 重写，语义不变）",
);
/* pure（纯净模式）此前靠 effortForPreset 短路，现在压根不改档位，天然一致：
   0.2 起预设文本在 handleRun 里按 pureFlag / presetId 现算（见 presetBase 那几行），
   不再有 `const presetText = pureFlag` 这个名字 —— 断言改成「pure 只参与预设文本」。 */
ok(
  G.indexOf("presetBase") >= 0 && G.indexOf("pureFlag") >= 0 && G.indexOf("const presetText") >= 0,
  "pure 仍只影响预设文本（presetBase / pureFlag / presetText 三者同段），不再需要考虑思考档短路",
);

/* ==================== [3] 旧 id sketch 兼容（归一后文本不丢，档位照样跟随设置） ==================== */
console.log("\n[3] 旧 id 兼容：sketch 仍解析到 lean，思考档照旧跟随设置");
const legacySrc = (() => {
  const start = G.indexOf("const LEGACY_PRESET_IDS = {");
  if (start < 0) return "";
  const fnAt = G.indexOf("function normalizePresetId(", start);
  if (fnAt < 0) return "";
  /* 配平花括号找函数结尾（别用「\n  }」当锚点：块里先出现的那个会把切片截断，
     vm 收到半个函数就报 Unexpected end of input）。 */
  let depth = 0;
  let end = -1;
  for (let i = G.indexOf("{", fnAt); i < G.length; i++) {
    const ch = G[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  return end > fnAt ? G.slice(start, end) : "";
})();
/* 别名表所在整行（残留自查时先挖掉它，避免自己打自己） */
const LEGACY_SRC_LINE = (/^.*\bconst LEGACY_PRESET_IDS\b.*$/m.exec(G) || [""])[0];
ok(!!legacySrc, "定位到 LEGACY_PRESET_IDS / normalizePresetId 块");
const LEG = legacySrc
  ? vm.runInNewContext(legacySrc + "\n({ LEGACY_PRESET_IDS, normalizePresetId })")
  : { LEGACY_PRESET_IDS: {}, normalizePresetId: (x) => x };
const np = LEG.normalizePresetId;
ok(
  JSON.stringify(LEG.LEGACY_PRESET_IDS) === JSON.stringify({ sketch: "lean" }),
  "LEGACY_PRESET_IDS = { sketch: 'lean' }",
);
ok(np("sketch") === "lean", "旧 id sketch → 归一为 lean");
ok(np(" sketch ") === "lean", "旧 id 带空格也归一（宿主下发不做 trim 也不漏）");
ok(np("lean") === "lean", "现名 lean 原样通过（不被二次改写）");
ok(np("ghost") === "ghost", "未知 id 原样返回（交给 PRESETS 缺省回落 standard）");
ok(np("") === "" && np(undefined) === "", "空 / undefined 归一为空串（不套预设）");
ok(
  Object.prototype.hasOwnProperty.call(PRESETS, np("sketch")),
  "旧 sketch 命中的是 lean 预设文本（不再静默回落 standard）",
);
ok(
  LEAN !== "" && PRESETS[np("sketch")] === LEAN,
  "旧 sketch 取到的预设文本 ≡ PRESETS.lean（文本没被复制成第二份）",
);
ok(ne("high") === "high" && ne("max") === "max", "旧 sketch 会话这一轮同样吃设置：标准 / 最强各自原样");
ok(
  G.indexOf("const presetId = normalizePresetId(preset)") >= 0,
  "handleRun 入口先归一预设 id（预设文本按现名查）",
);
ok(
  G.indexOf("hasOwnProperty.call(PRESETS, presetId) ? PRESETS[presetId]") >= 0,
  "预设文本按归一后的 presetId 取（旧会话不再丢角色前缀）",
);
/* 0.2 起档位归一收进 reasoning-effort.mjs：handleRun 用 effortForRoute(rawEffort, route)
   算本轮生效档（见 gateway 的 runEffort 那几行），变量名不再叫 normalizeEffort 调用点。
   断言改成「档位确实由路由归一算出、且与 presetId 无关」。 */
ok(
  G.indexOf("const runEffort = effortForRoute(") >= 0 && G.indexOf("runEffort, presetId") < 0,
  "思考档与 presetId 无耦合：本轮档位由 effortForRoute 算出，不存在「按预设算档」的回头路",
);

/* ==================== [4] 渲染层单一真源 ==================== */
console.log("\n[4] AGENT_PRESETS 唯一真源 + 四处 UI 消费");
/* 真源块切片：若档位别名表（LEGACY / Alias）定义在 AGENT_PRESETS 之前，一并纳入切片，
   否则 vm 里 agentPresetById 会因引用未定义而崩。 */
const uiSrc = (() => {
  let a = APP.indexOf("const AGENT_PRESETS = [");
  const b = APP.indexOf("const NODE_DEFAULTS = {", a);
  if (a < 0 || b <= a) return "";
  /* 回退到紧邻其上的「旧 id 别名表」定义（若有），保证切片自足可求值 */
  const head = APP.slice(0, a);
  const defs = head.match(/^(?:const|let|var)\s+\w*(?:LEGACY|ALIAS|Alias)\w*\s*=/gm) || [];
  if (defs.length) {
    const last = defs[defs.length - 1];
    a -= head.length - head.lastIndexOf(last);
  }
  return APP.slice(a, b);
})();
ok(!!uiSrc, "定位到 AGENT_PRESETS 真源块");
let UI = null;
try {
  UI = vm.runInNewContext(
    "var I18n = { t: function (k) { return k; } };\n" +
      uiSrc +
      "\n({ AGENT_PRESETS, AGENT_PRESET_DEFAULT, agentPresetById, agentEffortDisplayLabel })",
  );
} catch (e) {
  ok(false, "求值 AGENT_PRESETS 真源块：" + (e && e.message));
}
if (!UI) {
  console.log("\n✗ 渲染层真源取不到，后续断言无法执行");
  process.exit(1);
}
ok(
  UI.AGENT_PRESETS.map((p) => p.id).join(",") === "minimal,standard,lean,code,cordis",
  "五档可见、顺序 minimal/standard/lean/code/cordis（默认档排第一；node·pure·bongochat 不上 UI）",
);
ok(
  UI.AGENT_PRESETS.every((p) => p.id && p.labelKey && p.settingsLabelKey && p.hint),
  "每项都带 id/labelKey/settingsLabelKey/hint",
);
const leanRow = UI.AGENT_PRESETS.filter((p) => p.id === "lean")[0] || {};
const leanRowText = [leanRow.labelKey, leanRow.settingsLabelKey, leanRow.hint].join("|");
ok(leanRow.id === "lean" && leanRow.labelKey === "思维精简", "lean 档在表内且短名为「思维精简」");
ok(
  leanRowText.indexOf("草图") < 0 && leanRowText.toLowerCase().indexOf("sketch") < 0,
  "lean 档三项文案已无旧名残留（草图 / sketch）",
);
ok(
  leanRowText.indexOf("降为 low") < 0 && leanRowText.indexOf("上限") < 0 && !/\blow\b/i.test(leanRowText),
  "lean 档三项文案不再承诺「思考档自动降为 low / 思考上限 low」",
);
ok(
  leanRow.hint.indexOf("按你的设置") >= 0,
  "lean 档 hint 明说：思考强度仍按用户自己的设置走",
);
ok(
  !UI.AGENT_PRESETS.some((p) => "effortCap" in p),
  "真源表没有 effortCap 字段（档位表不再携带思考上限）",
);
ok(
  !UI.AGENT_PRESETS.some((p) => p.id === "sketch"),
  "旧 id sketch 不再作为档位行出现在真源表里",
);
/* ── 默认档 = 极简，且它就是表内第一档（菜单第一眼看到的那一档就是出厂档） ── */
ok(UI.AGENT_PRESET_DEFAULT === "minimal", "默认预设档 = minimal（极简模式）");
ok(
  UI.AGENT_PRESETS[0].id === UI.AGENT_PRESET_DEFAULT,
  "档位表第一档就是默认档（顺序：极简 → 标准 → 思维精简）",
);
ok(
  UI.AGENT_PRESETS[1].id === "standard" && UI.AGENT_PRESETS[2].id === "lean",
  "第二档 standard、第三档 lean 就位",
);
ok(
  UI.AGENT_PRESETS[0].settingsLabelKey.indexOf("默认") >= 0,
  "默认档在设置页的长名带「默认」标注",
);
ok(
  !UI.AGENT_PRESETS.slice(1).some((p) => p.settingsLabelKey.indexOf("默认") >= 0),
  "「默认」标注只有一处（没跟着档位表留成两份）",
);
ok(UI.agentPresetById("ghost").id === "minimal", "未知 id 兜底回落默认档 minimal");
ok(UI.agentPresetById(undefined).id === "minimal", "空 id 兜底回落默认档 minimal");
ok(UI.agentPresetById("standard").id === "standard", "显式选择 standard 原样解析（兜底不改写已选档）");
ok(UI.agentPresetById("sketch").id === "lean", "渲染层旧 id sketch 也解析到 lean（历史设置不降级）");
ok(
  ASSIST.indexOf("for (const p of AGENT_PRESETS)") >= 0 &&
    ASSIST.indexOf("agentPresetById(id).labelKey") >= 0,
  "app-assist：会话模型菜单 + agentPresetLabel() 都吃真源",
);
ok(CANVAS.indexOf("for (const p of AGENT_PRESETS)") >= 0, "app-canvas：智能节点面板吃真源");
ok(SETTINGS.indexOf("for (const p of AGENT_PRESETS)") >= 0, "app-settings：设置下拉吃真源");
ok(
  ASSIST.indexOf("function syncAssistPresetOptions") >= 0 &&
    ASSIST.indexOf("syncAssistPresetOptions(presetSel)") >= 0,
  "app-assist：右侧助手「预设」下拉也吃真源（自表生成 + 切语言重刷）",
);
ok(
  /<select id="assistPresetSel"><\/select>/.test(read("renderer/index.html")),
  "index.html：助手「预设」下拉不再写死 <option> 清单（旧清单漏 lean、档位名自成一套）",
);
[
  ["app-assist.js", ASSIST],
  ["app-canvas.js", CANVAS],
  ["app-settings.js", SETTINGS],
].forEach(([name, src]) => {
  ok(
    ["标准模式", "极简模式", "创造模式"].every((lit) => src.indexOf(lit) < 0),
    name + "：无第二份硬编码档位清单",
  );
});
ok(SETTINGS.indexOf("const PRESET_OPTIONS") < 0, "app-settings：局部 PRESET_OPTIONS 旧清单已删");
ok(APP.split("const AGENT_PRESETS = [").length - 1 === 1, "档位清单全仓只有真源一份");

/* ── 默认档只有一份：兜底一律走 AGENT_PRESET_DEFAULT，不再写死档名 ─────────────
   默认档改判（standard → minimal）这一轮把所有「没选时用什么」的口子都收进常量，
   留任何一处字面量 = 留一处第二默认（下次改默认必然漏改）。
   唯一豁免：app-db.js 里三处**内部抽取跑**（识图 / 建表列结构 / 行抽取）刻意写死
   standard——那是机器解析用的规整输出，与界面默认档无关（该处有注释说明）。 */
[
  ["renderer/app.js", APP],
  ["renderer/app-assist.js", ASSIST],
  ["renderer/app-canvas.js", CANVAS],
  ["renderer/app-settings.js", SETTINGS],
  ["renderer/app-devnode.js", DEVNODE],
  ["renderer/app-boot.js", read("renderer/app-boot.js")],
  ["renderer/app-plan.js", read("renderer/app-plan.js")],
].forEach(([name, src]) => {
  const hits = (src.match(/preset[^{\n]*\|\|\s*"standard"|(?:preset|assistPreset)\s*[:=]\s*"standard"/g) || []).filter(
    // 档位表里 id: "standard" 是真源自身，不算兜底
    (s) => !/^id:/.test(s),
  );
  ok(
    hits.length === 0 && src.indexOf('|| "standard"') < 0,
    name + "：默认兜底全部走 AGENT_PRESET_DEFAULT" + (hits.length ? "（残留 " + hits[0] + "）" : ""),
  );
  ok(
    src.indexOf("AGENT_PRESET_DEFAULT") >= 0,
    name + "：确实在消费默认档真源常量",
  );
});
ok(
  (DB.match(/preset: "standard"/g) || []).length === 3 &&
    DB.indexOf("刻意选择") >= 0,
  "app-db：仅三处内部抽取跑保留显式 standard，且就地写明是刻意选择",
);

/* ==================== [5] 思考档显示：名义档就是生效档 ==================== */
console.log("\n[5] agentEffortDisplayLabel 只看所选档位（与预设无关）");
const labelTable = [];
for (const preset of ["lean", "sketch", "standard", "node", ""]) {
  for (const effort of ["high", "max", undefined, ""]) {
    labelTable.push([preset, effort]);
  }
}
const badLabels = labelTable.filter(([preset, effort]) => {
  const want = effort === "max" ? "最强" : "标准";
  return UI.agentEffortDisplayLabel({ preset, effort }) !== want;
});
ok(
  badLabels.length === 0,
  "20 组「预设 × 思考档」组合：显示档位只由所选思考档决定" +
    (badLabels.length ? "（首个差异 " + JSON.stringify(badLabels[0]) + "）" : ""),
);
ok(
  UI.agentEffortDisplayLabel({ preset: "lean", effort: "high" }) === "标准",
  "lean + 标准 → 显示「标准」（不再显示「低（思维精简）」）",
);
ok(UI.agentEffortDisplayLabel({ preset: "lean", effort: "max" }) === "最强", "lean + 最强 → 「最强」");
ok(
  UI.agentEffortDisplayLabel({ preset: "sketch", effort: "high" }) ===
    UI.agentEffortDisplayLabel({ preset: "lean", effort: "high" }),
  "旧 sketch 与 lean 显示同串（同一档、同一文案）",
);
/* 整套「生效档可见化」是压档机制的配套 UI：机制拆了，UI 也要跟着拆干净 */
["effectiveAgentEffort", "agentPresetEffortCap", "agentEffortDisplayTip"].forEach((fn) => {
  const dead = [
    ["app.js", APP],
    ["app-assist.js", ASSIST],
    ["app-canvas.js", CANVAS],
    ["app-devnode.js", DEVNODE],
  ].filter(([name, src]) => src.indexOf(fn) >= 0);
  ok(dead.length === 0, fn + "：渲染层四处已无定义与引用" + (dead.length ? "（残留在 " + dead.map((d) => d[0]).join("、") + "）" : ""));
});
[
  ["app.js", APP],
  ["app-assist.js", ASSIST],
  ["app-canvas.js", CANVAS],
  ["app-devnode.js", DEVNODE],
].forEach(([name, src]) => {
  ok(
    src.indexOf("低（思维精简）") < 0 && src.indexOf("生效：低") < 0,
    name + "：无「低（思维精简）/ 生效：低」这类生效档文案",
  );
});
ok(
  ASSIST.indexOf("agentEffortDisplayLabel(st)") >= 0,
  "app-assist：思考强度 cell 值仍走真源显示函数（单一口径）",
);
ok(
  CANVAS.indexOf("paintEffortHint") < 0,
  "app-canvas：思考强度标签的「生效档」重绘钩子已删（标签不再随预设变）",
);
ok(
  DEVNODE.indexOf("I18n.t(\"思考强度：\")") >= 0 && DEVNODE.indexOf("（生效档）") < 0,
  "app-devnode：对话框 / 按钮提示改为「思考强度：」（不再自称生效档）",
);

/* ==================== [6] i18n 词条 + 无残留旧名 ==================== */
console.log("\n[6] i18n 中英词条 + 死词条已清 + 渲染层无残留旧档位名");
const I18n = require("../renderer/i18n.js");
I18n.setLocale("en");
[leanRow.labelKey, leanRow.settingsLabelKey, leanRow.hint].forEach((k) =>
  ok(I18n.t(k) !== k, "精简档词条可翻：" + String(k).slice(0, 18) + "…"),
);
/* 思考档与开发节点三格的新文案：不写死新串，而是从代码里把实际使用的 key 抠出来逐条验可翻，
   改名后（无论措辞怎么调）只要漏词条就会红。 */
const effKeys = ["预设 / 模型 / 思考强度", "最强", "标准", "思维精简", "思考强度："];
const devTipKeys = (DEVNODE.match(/I18n\.t\("最强：[^"]*"\)/g) || []).map((s) =>
  s.replace(/^I18n\.t\("/, "").replace(/"\)$/, ""),
);
const canvasKeys = (CANVAS.match(/"思考强度（[^"]*）"/g) || []).map((s) => s.slice(1, -1));
ok(
  devTipKeys.length > 0 && devTipKeys.every((k) => k.indexOf("降档") < 0),
  "app-devnode 的「最强」提示已不再讲降档（" + (devTipKeys[0] || "未找到") + "）",
);
ok(
  canvasKeys.length > 0 && canvasKeys.every((k) => k.indexOf("生效") < 0),
  "app-canvas 的思考强度标签已无「生效档」字样（" + (canvasKeys[0] || "未找到") + "）",
);
effKeys.concat(devTipKeys, canvasKeys).forEach((k) =>
  ok(!!k && I18n.t(k) !== k, "思考档词条可翻：" + JSON.stringify(k).slice(0, 30) + "…"),
);
/* 死词条自查：随压档机制一起废弃的串，翻译表里一个字都不该留
   （留着既没人引用，又会在切英文时把旧说法再撒一遍）。 */
[
  "低（思维精简）",
  "生效档位：低（思维精简）",
  "思考强度（标准 / 最强 · 生效：低（思维精简））",
  "（压制推理的预设把「标准」降为 low；选「最强」不会被降档）",
  "生效思考档：",
  "思考强度（生效档）：",
  "不会被任何预设降档",
  /* 默认档改成极简：旧设置页长名（带「（默认）」的那两串）一个字都不该留在翻译表里 */
  "标准模式（默认）",
  "极简模式（直奔结果，少解释）",
].forEach((dead) =>
  ok(I18N.indexOf(dead) < 0, "i18n.js 死词条已清：" + dead.slice(0, 18) + "…"),
);
I18n.setLocale("zh");
ok(I18n.t(leanRow.labelKey) === leanRow.labelKey, "中文模式原样返回档位名");
ok(
  I18N.indexOf('"思维精简": "Lean Thinking"') >= 0,
  "i18n.js：新「思维精简」词条仍在（改名一族没被误删）",
);
/* 残留自查：旧档位名「草图…」在渲染层代码里只允许作为改名溯源注释存在，
   不允许再被当作字符串字面量引用（引用即说明还有一条没跟着改名的界面路径）。 */
function quotedOldName(src) {
  return (src.match(/["'`][^"'`\n]*草图[^"'`\n]*["'`]/g) || []).filter((s) => !/legacy/i.test(s));
}
[
  ["app.js", APP],
  ["app-assist.js", ASSIST],
  ["app-canvas.js", CANVAS],
  ["app-devnode.js", DEVNODE],
  ["app-settings.js", SETTINGS],
  ["app-db.js", DB],
].forEach(([name, src]) => {
  const hits = quotedOldName(src);
  ok(hits.length === 0, name + "：旧档位名「草图…」已无字符串字面量引用" + (hits.length ? "（" + hits[0] + "）" : "（只活在溯源注释里）"));
});
/* i18n.js 是翻译表：若仍保留旧「草图…」历史词条（只为让旧存档能翻），只提示数量不判 FAIL；
   界面真正引用的新词条由上面的「可翻」断言逐条兜住。 */
const i18nOldKeys = (I18N.match(/^\s*"草图[^"]*":/gm) || []).length;
if (i18nOldKeys)
  console.log("  note  i18n.js 保留 " + i18nOldKeys + " 条 legacy「草图…」词条（仅翻译表，界面不再引用）");
/* Sketch-of-Thought 是论文方法名（提示词与注释里合法保留），只有把 sketch 当档位 id
   用的写法才是残留：网关侧 sketch 只允许出现在 LEGACY 别名表与改名溯源注释里。 */
ok(
  !!LEGACY_SRC_LINE &&
    (G.replace(LEGACY_SRC_LINE, "")
      .match(/PRESETS\.sketch\b|\bsketch:\s*['"]|\bid:\s*["']sketch["']/g) || []).length === 0,
  "网关残留自查：sketch 只剩 LEGACY 别名表一处，不再是档位键 / 上限键",
);

/* 档位文案的英文完备性：AGENT_PRESETS 每一项的三个可显示串都必须有 EN 词条
   （旧四档历史上缺译，本轮补齐后此处按硬断言守住——再漏一条英文界面就会露中文）。 */
const allMissing = UI.AGENT_PRESETS.flatMap((p) => [p.labelKey, p.settingsLabelKey, p.hint])
  .filter(Boolean)
  .filter((k) => {
    I18n.setLocale("en");
    const miss = I18n.t(k) === k;
    I18n.setLocale("zh");
    return miss;
  });
ok(
  allMissing.length === 0,
  "全部预设档位文案都有英文词条" + (allMissing.length ? "（缺 " + allMissing.length + " 条：" + allMissing[0] + "…）" : ""),
);

/* ==================== [7] 既有决议无回归 ==================== */
console.log("\n[7] pure / nodeLock 决议与空预设链路未动");
ok(DB.indexOf('if (pureOn) return "pure";') >= 0, "app-db：pure 优先决议分支原样");
ok(
  DB.indexOf('nodeLock && (p === "standard" || p === AGENT_PRESET_DEFAULT)') >= 0,
  "app-db：nodeLock 下「默认档 → node」决议跟着真源走（老画布的 standard 与新默认 minimal 都落 node 档）",
);
ok(
  DB.indexOf('opts.preset || d.preset || AGENT_PRESET_DEFAULT') >= 0,
  "app-db：运行入口的预设兜底 = AGENT_PRESET_DEFAULT（不再有第二套默认）",
);
ok(
  G.indexOf("presetBase") >= 0 &&
    G.indexOf("? PRESETS[presetId] : PRESETS.standard") >= 0 &&
    G.indexOf("pureFlag") >= 0,
  "网关：pure 强制空预设 + 未知档回落 standard 链路原样（0.2 的 presetBase 三段式）",
);
ok(PRESETS.pure === "" && PRESETS.bongochat === "", "内部空串档（pure/bongochat）未被填充");
ok(PRESETS.node.indexOf("canvas AGENT NODE") >= 0, "内部 node 档文本原样");

/* ==================== [8] 手册 / 技能 / 更新文档同口径 ==================== */
console.log("\n[8] 文档口径：预设不再压档，四处一起改到位");
const DOC_LOCKS = [
  ["guides/manual/dsh.md", "中文手册（智能能力）"],
  ["guides/manual/en/dsh.md", "英文手册（智能能力）"],
  ["guides/manual/dev-nodes.md", "中文手册（开发节点）"],
  ["guides/manual/en/dev-nodes.md", "英文手册（开发节点）"],
  ["mtnode-agent-skills/mtnode/dev-architect/SKILL.md", "dev-architect 技能"],
];
for (const [rel, label] of DOC_LOCKS) {
  const doc = read(rel);
  ok(
    doc.indexOf("生效：低") < 0 &&
      doc.indexOf("低（思维精简）") < 0 &&
      doc.indexOf("自动降为 low") < 0 &&
      doc.indexOf("自动降到 low") < 0 &&
      doc.indexOf("自动 drops to Low") < 0 &&
      doc.indexOf("capped at low") < 0 &&
      doc.indexOf("capped down") < 0,
    label + "：无「自动降为 low / 生效：低（思维精简）」旧口径",
  );
}
const docZh = read("guides/manual/dsh.md");
ok(
  docZh.indexOf("不动思考强度") >= 0 && docZh.indexOf("现已取消") >= 0,
  "中文手册明说：这一档不动思考强度，旧的自动压档已取消",
);
const docEn = read("guides/manual/en/dsh.md");
ok(
  docEn.indexOf("does not touch the thinking level") >= 0,
  "英文手册同口径（does not touch the thinking level）",
);
const docDev = read("guides/manual/dev-nodes.md");
ok(
  docDev.indexOf("预设不再改写思考强度") >= 0,
  "开发节点手册改成「思考档只看设置」（预设不再改写思考强度）",
);
const skillDoc = read("mtnode-agent-skills/mtnode/dev-architect/SKILL.md");
ok(
  skillDoc.indexOf("该压档机制") >= 0 &&
    skillDoc.indexOf("已一并取消") >= 0 &&
    skillDoc.indexOf("只由设置决定") >= 0,
  "dev-architect 技能同步：思考档只由设置决定 · 压档机制与双口径文案已取消",
);
/* ── 默认档改成极简：手册表格 / 开发节点手册 / 技能的口径要跟界面一致 ── */
const presetRows = (src) => src.split("\n").filter((l) => /^\| \*\*/.test(l));
const zhRows = presetRows(read("guides/manual/dsh.md"));
ok(zhRows.length >= 5, "中文手册：五档表格齐全");
ok(
  zhRows[0].indexOf("极简模式") >= 0 && zhRows[0].indexOf("默认") >= 0,
  "中文手册：表格第一行 = 极简模式且标了「默认」",
);
ok(
  zhRows[1].indexOf("标准模式") >= 0 && zhRows[1].indexOf("默认") < 0,
  "中文手册：标准模式退到第二行，且不再自称默认",
);
ok(zhRows[2].indexOf("思维精简") >= 0, "中文手册：思维精简第三行");
const enRows = presetRows(read("guides/manual/en/dsh.md"));
ok(
  enRows[0].indexOf("Minimal") >= 0 && enRows[0].indexOf("default") >= 0,
  "英文手册：表格第一行 = Minimal 且标了 default",
);
ok(
  enRows[1].indexOf("Standard") >= 0 && enRows[1].indexOf("default") < 0,
  "英文手册：Standard 第二行且不再自称 default",
);
ok(enRows[2].indexOf("Lean Thinking") >= 0, "英文手册：Lean Thinking 第三行");
ok(
  read("guides/manual/dev-nodes.md").indexOf("默认档 = 极简模式") >= 0,
  "中文开发节点手册：三格全未指定时点明默认档 = 极简模式",
);
ok(
  read("guides/manual/en/dev-nodes.md").indexOf("default = 极简 (Minimal)") >= 0,
  "英文开发节点手册同口径（default = 极简 (Minimal)）",
);
ok(
  read("mtnode-agent-skills/mtnode/dev-architect/SKILL.md").indexOf("应用兜底 `minimal`") >= 0,
  "dev-architect 技能：兜底档改成 minimal（技能不再教旧默认）",
);
/* 网关兜底档仍是 standard（未知 / 缺省 id 用描述最完整的人设兜底），与界面默认档解耦 */
ok(
  G.indexOf("PRESETS.minimal") < 0,
  "网关：未知档没有偷偷跟着界面改判（兜底仍是最完整那份 standard 人设）",
);

/* CHANGELOG-v1.1.md 是本机写更新说明时留下的产物，**不在仓库里**（与 docs/ 同属本机文件）：
   文件不在就只记一笔，不算失败 —— 冒烟不该因为一份本机文档不在而红。 */
if (fs.existsSync(path.join(__dirname, "..", "CHANGELOG-v1.1.md"))) {
  const chg = read("CHANGELOG-v1.1.md");
  ok(
    chg.indexOf("思维精简不再限制思考强度") >= 0 && chg.indexOf("PRESET_EFFORT_CAPS") >= 0,
    "更新文档记录本轮取消按预设压档（PRESET_EFFORT_CAPS 拆除）",
  );
} else {
  console.log("note  跳过更新文档检查（CHANGELOG-v1.1.md 不在仓库里，属本机产物）");
}
/* docs/ 整体在 .gitignore 内（本机才有的实测报告）：文件不在就只记一笔，不算失败 */
if (fs.existsSync(path.join(__dirname, "..", "docs", "preset-lean-benchmark.md"))) {
  const bench = read("docs/preset-lean-benchmark.md");
  ok(
    bench.indexOf("时效性说明") >= 0 && bench.indexOf("不会在默认「标准」档下复现") >= 0,
    "实测报告顶部加了时效性说明（旧 lean 臂含降档，今天的 lean 只剩表达纪律）",
  );
} else {
  console.log("note  跳过实测报告检查（docs/preset-lean-benchmark.md 不在仓库里，属 gitignore 的本机产物）");
}

console.log(
  "\n" +
    (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全部通过") +
    "  (smoke-agent-preset-lean)",
);
process.exit(fails ? 1 : 0);
