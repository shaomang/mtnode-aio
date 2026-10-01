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
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os"), childProcess = require("child_process");
const SHARED = { fs, path, vm, os, spawn: childProcess.spawn };
const TEST_DIR = __dirname;
let MERGED_FAILED = false;

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

/* ==================== 已并入：test/smoke-agent-wheel-scroll.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-agent-wheel-scroll.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

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

  /* ============================ 迷你 DOM ============================ */
  function mkEl(tag, props) {
    const el = {
      nodeType: 1,
      tagName: String(tag || "div").toUpperCase(),
      id: "",
      parentElement: null,
      children: [],
      style: {},
      attrs: {},
      listeners: {},
      scrollTop: 0,
      clientHeight: 200,
      scrollHeight: 200,
      overflowY: "visible",
      overflowX: "visible",
    };
    Object.assign(el, props || {});
    el.classList = {
      _s: new Set(
        props && props.cls ? String(props.cls).split(/\s+/).filter(Boolean) : [],
      ),
      add(c) {
        this._s.add(c);
      },
      contains(c) {
        return this._s.has(c);
      },
    };
    el.appendChild = (c) => {
      c.parentElement = el;
      el.children.push(c);
      return c;
    };
    el.addEventListener = (t, fn) => {
      (el.listeners[t] = el.listeners[t] || []).push(fn);
    };
    el.matches = (sel) => {
      sel = String(sel).trim();
      if (/^\[.*\]$/.test(sel)) {
        const k = sel.slice(1, -1).split("=")[0];
        return el.attrs[k] !== undefined;
      }
      const m = /^([a-zA-Z]+)?((?:[.#][\w-]+)*)$/.exec(sel);
      if (!m) return false;
      if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
      for (const p of (m[2] || "").match(/[.#][\w-]+/g) || []) {
        if (p[0] === ".") {
          if (!el.classList.contains(p.slice(1))) return false;
        } else if (el.id !== p.slice(1)) return false;
      }
      return true;
    };
    el.closest = (sel) => {
      const parts = String(sel)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      for (let n = el; n; n = n.parentElement) {
        if (n.matches && parts.some((p) => n.matches(p))) return n;
      }
      return null;
    };
    el.querySelector = (sel) => {
      const part = String(sel).trim();
      const walk = (node) => {
        for (const c of node.children || []) {
          if (c.matches && c.matches(part)) return c;
          const hit = walk(c);
          if (hit) return hit;
        }
        return null;
      };
      return walk(el);
    };
    return el;
  }

  /* 造一棵贴近 index.html + ensureHistRail() 之后的会话窗 DOM */
  function buildDom() {
    const pane = mkEl("div", { id: "agentPane", cls: "agent-pane" });
    const side = pane.appendChild(mkEl("aside", { cls: "agent-side" }));
    const sideList = side.appendChild(
      mkEl("div", {
        id: "agentSideList",
        cls: "agent-side-list",
        overflowY: "auto",
        scrollHeight: 900,
      }),
    );
    const main = pane.appendChild(mkEl("div", { cls: "agent-main" }));
    const body = main.appendChild(mkEl("div", { cls: "agent-body" }));
    const wrap = body.appendChild(
      mkEl("div", { cls: "hist-scroll-wrap is-flex-fill" }),
    );
    const list = wrap.appendChild(
      mkEl("div", {
        id: "agentList",
        cls: "agent-list",
        overflowY: "auto",
        scrollHeight: 1200,
        clientHeight: 200,
      }),
    );
    list.scrollTop = 800; /* 默认贴近底部（是否跟随由 _convStick 决定） */
    const msg = list.appendChild(mkEl("div", { cls: "dsh-msg dsh-ai" }));
    const pre = msg.appendChild(
      mkEl("pre", {
        cls: "dsh-seg-think",
        overflowY: "auto",
        scrollHeight: 400,
        clientHeight: 140,
      }),
    );
    const rail = wrap.appendChild(mkEl("div", { cls: "hist-rail" }));
    const railMark = rail.appendChild(mkEl("button", { cls: "hist-rail-mark" }));
    const composer = body.appendChild(mkEl("div", { cls: "agent-composer" }));
    const chips = composer.appendChild(
      mkEl("div", { cls: "agent-composer-chips" }),
    );
    const ta = composer.appendChild(
      mkEl("textarea", { id: "agentInput", cls: "chat-input" }),
    );
    const menu = composer.appendChild(
      mkEl("div", {
        cls: "agent-menu",
        overflowY: "auto",
        scrollHeight: 500,
        clientHeight: 160,
      }),
    );
    const plan = body.appendChild(
      mkEl("div", { cls: "agent-todo agent-plan", id: "agentPlan" }),
    );
    const planList = plan.appendChild(
      mkEl("div", {
        cls: "at-list",
        overflowY: "auto",
        scrollHeight: 400,
        clientHeight: 120,
      }),
    );
    return {
      pane,
      side,
      sideList,
      main,
      body,
      wrap,
      list,
      msg,
      pre,
      rail,
      railMark,
      composer,
      chips,
      ta,
      menu,
      plan,
      planList,
    };
  }

  /* 一次滚轮：按真实冒泡路径从 target 依次调用到 host 上的 wheel 监听 */
  function fireWheel(dom, host, target, deltaY, opts) {
    opts = opts || {};
    const chain = [];
    for (let n = target; n; n = n.parentElement) {
      chain.push(n);
      if (n === host) break;
    }
    let prevented = false;
    const ev = {
      type: "wheel",
      target,
      deltaY,
      deltaX: opts.deltaX || 0,
      deltaMode: opts.deltaMode || 0,
      ctrlKey: !!opts.ctrlKey,
      metaKey: !!opts.metaKey,
      altKey: !!opts.altKey,
      get defaultPrevented() {
        return prevented;
      },
      preventDefault() {
        prevented = true;
      },
    };
    for (const el of chain) {
      for (const fn of el.listeners.wheel || []) fn(ev);
    }
    return { ev, prevented };
  }

  /* 把 app-assist.js 里那段兜底逻辑单独摘出来跑（真源仍在 renderer，测试只验行为） */
  function loadAssistLogic(dom, rafQueue) {
    const src = read("renderer/app-assist.js");
    const from = src.indexOf("/* ============ 会话窗滚轮兜底");
    const to = src.indexOf("function setAssistOpen(on, persist) {");
    if (from < 0 || to < 0 || to <= from) return null;
    const code = src.slice(from, to);
    const sb = {
      console,
      $: (sel) => (sel === "#agentPane" ? dom.pane : dom.list),
      getComputedStyle: (el) => ({
        overflowY: el.overflowY,
        overflowX: el.overflowX,
      }),
      requestAnimationFrame: (fn) => rafQueue.push(fn),
      CONV_STICK_SLACK: 24,
      bindConvStick: (el) => el,
      markConvStick: (el, v) => {
        el._convStick = !!v;
      },
      convStickOf: (el) => !(el && el._convStick === false),
      isScrollNearBottom: (el, slack) =>
        el.scrollTop + el.clientHeight >=
        el.scrollHeight - (slack == null ? 56 : slack),
      setConvScrollTop: (el, top) => {
        /* 浏览器会把越界值夹回来：模拟成真才测得出「白滚一次」 */
        const max = Math.max(0, el.scrollHeight - el.clientHeight);
        el.scrollTop = Math.max(0, Math.min(max, top));
      },
    };
    vm.createContext(sb);
    return {
      api: vm.runInNewContext(
        code +
          "\n({ agentElCanScrollDir, agentWheelNativeOwner, agentWheelPixels, bindAgentPaneWheelScroll, AGENT_WHEEL_MAX_PX })",
        sb,
        { filename: "renderer/app-assist.js#wheel" },
      ),
    };
  }

  /* ===================== [1] 结构不变式 ===================== */
  console.log("\n[1] 结构不变式：居中定宽的会话列 + .agent-main 容器（空白的来源）");
  const html = read("renderer/index.html");
  const dshCss = read("renderer/css/dsh.css");
  ok(/<div class="agent-main">/.test(html), "index.html：会话窗有 .agent-main 容器");
  /* #agentList 必须直接挂在 .agent-body 里（两侧余量不属于滚动容器）。
     允许插在它前面的是**不参与布局收缩的单行件**：#agentRound 轮次标签
     （flex:none，见 dsh.css，本次需求）—— 消息区仍是那个唯一的填充项，
     余量归 .agent-body 而不是某个滚动壳，这一条断言的用意不变。
     用切片而不是一条大正则：轮次标签自己带子元素，写正则容易在嵌套的 </div> 上翻车。 */
  const bodyOpen = html.indexOf('<div class="agent-body">');
  const listOpen = html.indexOf('<div class="agent-list" id="agentList">');
  const between =
    bodyOpen >= 0 && listOpen > bodyOpen
      ? html
          .slice(bodyOpen + '<div class="agent-body">'.length, listOpen)
          .replace(/<!--[^]*?-->/g, "")
      : null;
  ok(
    bodyOpen >= 0 &&
      listOpen > bodyOpen &&
      /^\s*(?:<div class="agent-round"[^>]*><b><\/b><i><\/i><\/div>\s*)?$/.test(between || ""),
    "index.html：#agentList 直接挂在 .agent-body 里（两侧余量不属于滚动容器）",
  );
  ok(
    /\/\* ── 对话消息[^]*?\*\/\s*\.agent-list\s*\{[^}]*max-width:\s*820px;[^}]*margin:\s*0 auto;/.test(
      dshCss,
    ),
    "dsh.css：.agent-list 居中定宽（max-width:820px + margin:0 auto）",
  );
  ok(
    /\.agent-composer\s*\{[^}]*max-width:\s*820px;[^}]*margin:\s*0 auto;/.test(dshCss),
    "dsh.css：输入区同样居中定宽（所以两边都有空白）",
  );
  ok(
    !/\.hist-scroll-wrap\s*\{[^}]*overflow/.test(dshCss) &&
      !/\.agent-body\s*\{[^}]*overflow/.test(dshCss),
    "dsh.css：.hist-scroll-wrap / .agent-body 自身不可滚（原生滚轮在那儿无事可做）",
  );

  /* ===================== [2] 方向可滚判定 ===================== */
  console.log("\n[2] agentElCanScrollDir：只有「该方向真还能滚」才算可滚");
  const dom0 = buildDom();
  const L0 = loadAssistLogic(dom0, []);
  ok(!!L0, "app-assist.js 的滚轮兜底段落可被单独提取运行（真源唯一）");
  const { agentElCanScrollDir, agentWheelPixels } = L0.api;

  dom0.list.scrollTop = 800; /* max = 1200 - 200 = 1000 */
  ok(agentElCanScrollDir(dom0.list, -1), "列表在底部附近 → 向上可滚");
  dom0.list.scrollTop = 1000;
  ok(!agentElCanScrollDir(dom0.list, 1), "列表已在底部 → 向下不可滚（兜底不吞事件）");
  dom0.list.scrollTop = 0;
  ok(!agentElCanScrollDir(dom0.list, -1), "列表已在顶部 → 向上不可滚");
  ok(agentElCanScrollDir(dom0.list, 1), "列表在顶部 → 向下可滚");
  dom0.wrap.scrollTop = 5;
  dom0.wrap.scrollHeight = 900;
  ok(!agentElCanScrollDir(dom0.wrap, -1), "overflow:visible 的 .hist-scroll-wrap 不算可滚");
  dom0.body.overflowY = "hidden";
  dom0.body.scrollHeight = 900;
  ok(!agentElCanScrollDir(dom0.body, -1), "overflow:hidden 的容器不算可滚（被裁但滚不动）");
  ok(
    agentElCanScrollDir(
      mkEl("div", {
        overflowY: "visible",
        overflowX: "auto",
        scrollHeight: 900,
        scrollTop: 40,
      }),
      -1,
    ),
    "只写 overflow-x 时纵向按 auto 处理（浏览器实际口径）",
  );
  ok(
    !agentElCanScrollDir(null, -1) && !agentElCanScrollDir(dom0.railMark, -1),
    "空元素 / 无溢出元素一律不可滚",
  );

  /* ===================== [3] 位移折算 ===================== */
  console.log("\n[3] agentWheelPixels：px / line / page 与单次上限");
  const listRef = { clientHeight: 200 };
  ok(agentWheelPixels({ deltaY: -100, deltaMode: 0 }, listRef) === -100, "pixel 模式原样取值");
  ok(agentWheelPixels({ deltaY: -3, deltaMode: 1 }, listRef) === -60, "line 模式按 20px/行 折算");
  ok(agentWheelPixels({ deltaY: 1, deltaMode: 2 }, listRef) === 200, "page 模式按列高折算");
  ok(
    agentWheelPixels({ deltaY: 99999, deltaMode: 0 }, listRef) === L0.api.AGENT_WHEEL_MAX_PX,
    "单次位移被夹到上限（防一次跳半屏）",
  );
  ok(agentWheelPixels({ deltaY: 0, deltaMode: 0 }, listRef) === 0, "deltaY=0 折算为 0");
  ok(agentWheelPixels(null, listRef) === 0 && agentWheelPixels({}, null) === 0, "脏输入不炸");

  /* ===================== [4] 接管规则 ===================== */
  console.log("\n[4] 接管规则：只有无处可滚的「两侧空白」才被补给会话列");
  const dom = buildDom();
  const raf = [];
  const L = loadAssistLogic(dom, raf);
  L.api.bindAgentPaneWheelScroll();
  ok(
    (dom.main.listeners.wheel || []).length === 1,
    "bindAgentPaneWheelScroll 只把兜底挂一个监听在 .agent-main 上",
  );

  dom.list.scrollTop = 800;
  dom.list._convStick = true;

  /* 4.1 左边空白：滚动条宿主 .hist-scroll-wrap 自己身上 */
  let r = fireWheel(dom, dom.main, dom.wrap, -120);
  ok(r.prevented, "空白处（.hist-scroll-wrap）滚轮被接管（preventDefault）");
  ok(dom.list.scrollTop === 680, "空白处向上滚 → 会话列真的动了（800 → 680）");

  /* 4.2 右边空白：历史轨道与其上的轮次标记 */
  dom.list.scrollTop = 800;
  fireWheel(dom, dom.main, dom.rail, -100);
  ok(dom.list.scrollTop === 700, "右侧轨道空白 → 同样滚动会话列");
  dom.list.scrollTop = 800;
  fireWheel(dom, dom.main, dom.railMark, -100);
  ok(dom.list.scrollTop === 700, "轨道上的轮次标记处滚轮也能滚动会话列");

  /* 4.3 .agent-body 余量（输入区两侧的空白） */
  dom.list.scrollTop = 800;
  fireWheel(dom, dom.main, dom.body, 150);
  ok(dom.list.scrollTop === 950, ".agent-body 空白处向下滚 → 会话列跟着走");

  /* 4.4 会话列自己身上：交回原生，绝不叠加成双速 */
  dom.list.scrollTop = 800;
  r = fireWheel(dom, dom.main, dom.list, -120);
  ok(!r.prevented && dom.list.scrollTop === 800, "滚轮落在会话列自己身上 → 不接管（避免双速）");
  r = fireWheel(dom, dom.main, dom.msg, -120);
  ok(!r.prevented && dom.list.scrollTop === 800, "落在消息气泡（列内不可滚子元素）→ 交回原生");

  /* 4.5 内层真能滚的：代码块 / 计划清单 / 会话左栏 */
  dom.pre.scrollTop = 60;
  r = fireWheel(dom, dom.main, dom.pre, -30);
  ok(!r.prevented && dom.list.scrollTop === 800, "思考/代码块自己还能滚 → 不抢它的滚轮");
  dom.pre.scrollTop = 0;
  r = fireWheel(dom, dom.main, dom.pre, -30);
  ok(!r.prevented && dom.list.scrollTop === 800, "代码块滚到顶 → 由祖先链上的会话列原生接住，不叠加");
  dom.planList.scrollTop = 50;
  r = fireWheel(dom, dom.main, dom.planList, -40);
  ok(!r.prevented && dom.list.scrollTop === 800, "计划清单 .at-list 可滚 → 不受影响");
  dom.sideList.scrollTop = 20;
  r = fireWheel(dom, dom.main, dom.sideList, -40);
  ok(!r.prevented && dom.list.scrollTop === 800, "会话左栏列表不在 .agent-main 内 → 与本次无关");

  /* 4.6 输入框 / 弹层菜单：有自己的语义 */
  r = fireWheel(dom, dom.main, dom.ta, -120);
  ok(!r.prevented && dom.list.scrollTop === 800, "输入框上的滚轮不接管");
  r = fireWheel(dom, dom.main, dom.menu, -120);
  ok(!r.prevented && dom.list.scrollTop === 800, "弹出的选项菜单上的滚轮不接管");
  r = fireWheel(dom, dom.main, dom.chips, -120);
  ok(r.prevented && dom.list.scrollTop === 680, "chips 那一行的空白处 → 顺手滚动会话");

  /* 4.7 到头不吞事件 / 横向 / 修饰键 */
  dom.list.scrollTop = 0;
  r = fireWheel(dom, dom.main, dom.wrap, -120);
  ok(!r.prevented && dom.list.scrollTop === 0, "会话列已在顶部还继续上滚 → 不吞事件（不卡在半路）");
  dom.list.scrollTop = 1000;
  r = fireWheel(dom, dom.main, dom.wrap, 120);
  ok(!r.prevented, "会话列已到底还继续下滚 → 不吞事件");
  dom.list.scrollTop = 800;
  r = fireWheel(dom, dom.main, dom.wrap, 0, { deltaX: -120 });
  ok(!r.prevented && dom.list.scrollTop === 800, "纯横向滚轮（deltaY=0）不管");
  r = fireWheel(dom, dom.main, dom.wrap, -120, { ctrlKey: true });
  ok(!r.prevented && dom.list.scrollTop === 800, "Ctrl+滚轮（缩放）不接管");

  /* ===================== [5] 跟随底部 ===================== */
  console.log("\n[5] 跟随底部意图与列表内滚轮同口径");
  dom.list.scrollTop = 800;
  dom.list._convStick = true;
  fireWheel(dom, dom.main, dom.wrap, -120);
  ok(dom.list.scrollTop === 680, "空白处上翻 → 位移生效（680）");
  ok(dom.list._convStick === false, "空白处上翻 → 立刻脱离「跟随底部」");
  dom.list.scrollTop = 900;
  dom.list._convStick = false;
  fireWheel(dom, dom.main, dom.wrap, 150);
  ok(dom.list.scrollTop === 1000, "空白处下滚 → 越界被夹回底部（1000）");
  ok(dom.list._convStick === true, "空白处滚回底部 → 恢复跟随（流式输出继续自动跟）");
  /* 白滚一次：这一帧列表其实没动 → 不把用户的跟随意图改掉 */
  Object.defineProperty(dom.list, "scrollTop", {
    configurable: true,
    get: () => 500,
    set: () => {},
  });
  dom.list._convStick = true;
  fireWheel(dom, dom.main, dom.wrap, -120);
  ok(dom.list._convStick === false, "上翻先按用户意图脱离跟随");
  while (raf.length) raf.shift()();
  ok(dom.list._convStick === true, "下一帧发现列表根本没动 → 回滚跟随意图（与列表内滚轮同款兜底）");

  /* ===================== [6] 接线与幂等 ===================== */
  console.log("\n[6] 接线：启动即绑定、重复 bind 不叠加");
  const boot = read("renderer/app-boot.js");
  ok(/bindAgentPaneWheelScroll\(\);/.test(boot), "app-boot.js 启动时绑定会话窗滚轮兜底");
  const assistSrc = read("renderer/app-assist.js");
  ok(
    (assistSrc.match(/function bindAgentPaneWheelScroll\(\)/g) || []).length === 1,
    "兜底绑定函数在 renderer 里只有一处定义",
  );
  ok(
    (assistSrc.match(/_agentWheelBound/g) || []).length >= 2,
    "源码带 _agentWheelBound 幂等守卫",
  );
  const dom2 = buildDom();
  const L2 = loadAssistLogic(dom2, []);
  L2.api.bindAgentPaneWheelScroll();
  L2.api.bindAgentPaneWheelScroll();
  ok(
    (dom2.main.listeners.wheel || []).length === 1,
    "重复 bindAgentPaneWheelScroll 只挂一个 wheel 监听（幂等）",
  );

  /* ===================== [7] 快捷跳转竖条贴滚动条 ===================== */
  /* 回归：竖条（.hist-rail）曾以 flex 同伴项排在 .hist-scroll-wrap 最右端，
     而消息列是居中定宽的（max-width:820px + margin:0 auto）—— 窗口一宽，
     竖条就被推到整个窗口的右沿，离滚动条隔着一整段空白。
     正解：竖条脱离文档流，right = wrap.right − list.right（= 滚动条正右侧）。 */
  console.log("\n[7] 快捷跳转竖条：贴滚动条右侧，不再飘到窗口右沿");
  const railCssM = /\.hist-rail\s*\{([^}]*)\}/.exec(dshCss);
  const railCss = railCssM ? railCssM[1] : "";
  ok(!!railCss, "dsh.css 里找得到 .hist-rail 规则");
  ok(
    /position:\s*absolute/.test(railCss) && !/position:\s*relative/.test(railCss),
    "竖条脱离文档流（position:absolute）—— 在流里就必然被排到 wrap 最右端",
  );
  ok(!/flex:\s*none/.test(railCss), "竖条不再是 flex 同伴项（去掉 flex:none）");
  ok(/right:\s*0/.test(railCss), "竖条初值贴 wrap 右沿（由 JS 按实测空余再往左移到滚动条旁）");
  ok(
    /border-right:\s*1px solid var\(--bd\)/.test(railCss),
    "竖条边框改到右缘（贴滚动条那一侧）",
  );
  ok(
    /\.hist-scroll-wrap\s*\{[^}]*position:\s*relative/.test(dshCss),
    ".hist-scroll-wrap 是竖条的定位上下文（position:relative）",
  );
  ok(
    /function histRailAlign\s*\(/.test(assistSrc) &&
      /histRailAlign\(list,\s*rail\)/.test(assistSrc),
    "app-assist.js：histRailAlign(list, rail) 有定义且在排布时被调用",
  );
  ok(
    /wrap\.getBoundingClientRect\(\)\.right\s*-\s*list\.getBoundingClientRect\(\)\.right/.test(
      assistSrc,
    ),
    "对齐量取实测 rect（wrap.right − list.right），不写死 820 / 50% 之类的魔法数",
  );
  {
    /* 把真正的 histRailAlign 抠出来跑：纯函数，喂 stub rect 即可验算 */
    const fnM = /function histRailAlign\([\s\S]*?\r?\n\}\r?\n/.exec(assistSrc);
    ok(!!fnM, "histRailAlign 可从源码抠出单独执行（真源唯一，测试不抄副本）");
    if (fnM) {
      const histRailAlign = new Function("return (" + fnM[0] + ")")();
      const mkList = (listRight, wrapRight) => ({
        clientWidth: 810,
        offsetWidth: 820,
        parentNode: { getBoundingClientRect: () => ({ right: wrapRight }) },
        getBoundingClientRect: () => ({ right: listRight }),
      });
      const railA = { style: {} };
      histRailAlign(mkList(1190.7, 1281.3), railA);
      ok(
        railA.style.right === "91px",
        "宽窗：列右侧余量 90.6 → right=91px（旧写法 0，竖条被顶到窗口右沿）",
      );
      const railB = { style: {} };
      histRailAlign(mkList(900, 900), railB);
      ok(railB.style.right === "0px", "窄窗（列铺满整行）：余量 0 → right=0（最右沿 = 滚动条旁）");
      const railC = { style: {} };
      histRailAlign(null, railC);
      histRailAlign(mkList(100, 50), railC);
      ok(railC.style.right === "0px", "脏输入 / 负余量夹到 0，不会把竖条推出容器");
      const railD = { style: { right: "91px" } };
      histRailAlign(mkList(1190.7, 1281.3), railD);
      ok(railD.style.right === "91px", "重复对齐结果稳定（每帧重排不累积漂移）");
    }
  }

  /* ============ [8] 右侧「错开位置」：滚动条与竖条 / 栏宽把手互不重叠 ============ */
  /* 用户报的两条：
     ① 会话里轮次竖条（.hist-rail，18px）压在消息列的竖直滚动条上 → 滚动条选不中；
     ② 会话列表的竖直滚动条压在「调整栏宽」把手（9px 命中区）下 → 一样选不中。
     根因同一类：拿着「贴右缘」的绝对定位元素去叠滚动条。而滚动条是**占布局**的那一种
     （components.css 的 ::-webkit-scrollbar 宽 10px），它钉在元素内边距盒的右缘 ——
     给容器加 padding-right 只缩内容区，滚动条本身不动（实测验证过，别再走那条路）。
     正解是给滚动条留出让位：竖条靠 .hist-scroll-wrap 的右内边距，列表靠自己的 width。
     这里用同一套数算一遍两不重叠 —— 改 CSS 谁把这几条改回去都跑不过。 */
  console.log("\n[8] 右侧错开：滚动条与竖条 / 栏宽把手各走各的道");

  /* 全局滚动条宽（两侧都按它算） */
  const componentsCss = read("renderer/css/components.css");
  const globalSb = Number(
    (/::-webkit-scrollbar\s*\{\s*width:\s*(\d+)px/.exec(componentsCss) || [])[1],
  );
  ok(globalSb === 10, "components.css：全局竖直滚动条宽 10px（下面按它算占位）");

  /* ① 轮次竖条：壳的右内边距 ≥ 竖条宽 → 竖条落在与滚动条不重叠的槽里 */
  const wrapCss = (/\.hist-scroll-wrap\s*\{([^}]*)\}/.exec(dshCss) || [])[1] || "";
  const wrapPadM = /padding:\s*0\s+(\d+)px/.exec(wrapCss);
  const railW = Number(
    (/\.hist-rail\s*\{[^}]*width:\s*(\d+)px/.exec(dshCss) || [])[1],
  );
  ok(!!wrapPadM, ".hist-scroll-wrap 写了左右内边距（右侧那段就是竖条的专用槽）");
  ok(railW === 18, "竖条宽仍是 18px（观感没动，只挪位）");
  ok(
    wrapPadM && Number(wrapPadM[1]) >= railW,
    ".hist-scroll-wrap 右内边距 ≥ 竖条宽（否则竖条又会压到消息列的滚动条上）",
  );
  ok(
    /\.hist-rail\s*\{[^}]*right:\s*0/.test(dshCss),
    "竖条 right:0 = 壳内边距盒右缘 = 竖条槽右沿（不是叠在滚动条上）",
  );
  ok(
    /\/\* 竖条（.hist-rail）\s*的定位上下文：它贴滚动条右侧/.test(dshCss),
    "CSS 注释写明竖条是「贴滚动条右侧」（错开位置），不是「不占列宽」的叠放",
  );

  /* ② 会话列表：width 让出的量 ≥ 把手命中区宽（9px），且还留得住滚动条那 10px */
  const sideListCss = (/\.agent-side-list\s*\{([^}]*)\}/.exec(dshCss) || [])[1] || "";
  const sideWideM = /width:\s*calc\(100%\s*-\s*(\d+)px\)/.exec(sideListCss);
  const handleW = Number(
    (/\.agent-side-resize\s*\{[^}]*width:\s*(\d+)px/.exec(dshCss) || [])[1],
  );
  ok(handleW === 9, "栏宽把手命中区仍是 9px（拖拽手感没动）");
  ok(!!sideWideM, ".agent-side-list 用 width 让出右缘（不是 padding-right —— 那推不动滚动条）");
  const sideGutter = sideWideM ? Number(sideWideM[1]) : 0;
  ok(
    sideGutter >= handleW + 4,
    "让位 ≥ 把手 9px + 4px 缝（滚动条与把手之间留可见间隙）",
  );
  {
    /* 拿真值算一遍：栏宽 280 → 列表 266 → 滚动条 256…266，把手 271…280，中间 5px 缝 */
    const COL = 280;
    const listW = COL - sideGutter;
    const sb = [listW - globalSb, listW];
    const handle = [COL - handleW, COL];
    const overlap = Math.max(0, Math.min(sb[1], handle[1]) - Math.max(sb[0], handle[0]));
    ok(overlap === 0, "栏宽 280px 时：滚动条与把手 0 重叠（修复前整条重叠 9px）");
    ok(
      handle[0] - sb[1] >= 4,
      "两者之间留了 " + (handle[0] - sb[1]) + "px 缝（滚动条那一条整条可点）",
    );
  }
  {
    /* 消息列同样算一遍：820 定宽列 + 壳右内边距 18 → 竖条在位图右缘外 62px 处，不压滚动条 */
    const wrapW = 980, pad = wrapPadM ? Number(wrapPadM[1]) : 0, listW = 820;
    const listR = wrapW - pad - (wrapW - pad - listW) / 2;
    const sb = [listR - globalSb, listR];
    const rail = [wrapW - railW, wrapW];
    ok(
      Math.max(0, Math.min(sb[1], rail[1]) - Math.max(sb[0], rail[0])) === 0,
      "消息列 820px：滚动条（" + sb[0] + "…" + sb[1] + "）与竖条（" + rail[0] + "…" + rail[1] + "）0 重叠",
    );
    ok(rail[0] >= sb[1], "竖条左沿在滚动条右沿之外（错开，不是叠放）");
  }

  console.log(
    "\n" + (fails ? "FAIL " + fails + " / " + checks : "全部通过 " + checks + " 项"),
  );
  if (fails ? 1 : 0) MERGED_FAILED = true;

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-agent-wheel-scroll.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-agent-wheel-scroll.js：" + fails + " / " + checks + " 项失败");
})();

/* ==================== 已并入：test/smoke-agent-lang.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-agent-lang.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

  const fs = require("fs");
  const path = require("path");

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

  const I18n = require("../renderer/i18n.js");

  /* ===================== [1] i18n 派生 ===================== */
  console.log("\n[1] i18n 派生：口味文案随语言切换");
  ok(typeof I18n.agentLangTaste === "function", "i18n 导出 agentLangTaste()");
  ok(typeof I18n.agentLangCode === "function", "i18n 导出 agentLangCode()");
  ok(typeof I18n.agentLangLabel === "function", "i18n 导出 agentLangLabel()");

  I18n.setLocale("zh");
  ok(I18n.agentLangCode() === "zh", "中文界面 → agentLangCode = zh");
  ok(I18n.agentLangLabel().indexOf("中文") >= 0, "中文界面 → 语言标签为中文");
  const zhTaste = I18n.agentLangTaste();
  ok(zhTaste.indexOf("【语言口味") >= 0, "中文口味段有明确抬头");
  ok(zhTaste.indexOf("中文") >= 0, "中文口味段指定中文");

  I18n.setLocale("en");
  ok(I18n.agentLangCode() === "en", "英文界面 → agentLangCode = en");
  ok(I18n.agentLangLabel().indexOf("English") >= 0, "英文界面 → 语言标签为 English");
  const enTaste = I18n.agentLangTaste();
  ok(enTaste.indexOf("Language Taste") >= 0, "英文口味段有明确抬头");
  ok(enTaste.indexOf("English") >= 0, "英文口味段指定 English");
  ok(enTaste.indexOf("请用英文") >= 0, "英文口味段带中文镜像（防提示主体中文被漏读）");
  ok(enTaste !== zhTaste, "两种语言的口味文案不同");

  /* ===================== [2] 文案要点 ===================== */
  console.log("\n[2] 口味文案要点：交流 + 期望回答 + 派生沿用 + 用户可覆盖");
  for (const [label, text] of [
    ["中文", zhTaste],
    ["英文", enTaste],
  ]) {
    ok(/最终回答|final answers/.test(text), label + "：要求最终回答用该语言");
    ok(/期望|Expect/.test(text), label + "：写明「期望 agent 用该语言回答」");
    ok(/子任务|subagent/.test(text), label + "：派生的每个 agent 同样沿用");
    ok(/提问、计划|questions, plans/.test(text), label + "：提问与计划也用该语言");
    ok(/明确指定|explicitly asks/.test(text), label + "：用户显式指定时以用户为准");
    ok(/保持原文|verbatim/.test(text), label + "：代码 / 路径 / 命令保持原文");
    ok(
      /不要翻译用户资料|do NOT translate the user/.test(text),
      label + "：只换交流语言，不翻译用户资料（事实库 / 表格 / 文件正文）",
    );
  }

  /* ===================== [3] 注入唯一 ===================== */
  console.log("\n[3] 注入点：所有 agent 运行统一带上口味");
  const db = read("renderer/app-db.js");
  ok(
    /function agentLangTasteNote\(\)/.test(db),
    "app-db.js 提供 agentLangTasteNote() 兜底封装",
  );
  ok(
    /* 纯净模式（pureOn）把 systemPrompt 变成了三元式：口味在「非纯净」那条数组里即可 */
    /systemPrompt:\s*(?:pureOn[\s\S]{0,40}\?:?\s*)?\[[\s\S]{0,700}?agentLangTasteNote\(\),[\s\S]{0,120}?\]/.test(
      db,
    ) ||
      /systemPrompt:[\s\S]{0,160}?\[[\s\S]{0,700}?agentLangTasteNote\(\),/.test(db) ||
      /* 分节改版后口味是 promptSections 的末位一节（由 renderSections 汇进 systemPrompt），不再是裸数组元素 */
      /PROMPT_SECTION_IDS\.lang_taste, text: agentLangTasteNote\(\)/.test(db),
    "dshRunTask 组装 systemPrompt 时带上语言口味（会话 / 节点 / 助手 / 计划 / 开发节点全覆盖）",
  );
  ok(
    (db.match(/agentLangTasteNote\(\)/g) || []).length === 2,
    "口味只在 dshRunTask 一处注入，不在各调用点重复拼装",
  );
  /* 旧的硬编码语言偏好必须清干净，否则英文界面仍被要求「中文优先」 */
  const jsFiles = fs
    .readdirSync(path.join(__dirname, "..", "renderer"))
    .filter((f) => f.endsWith(".js"));
  let stale = [];
  for (const f of jsFiles) {
    const src = read("renderer/" + f);
    if (src.indexOf("中文优先") >= 0 || src.indexOf("回答用中文") >= 0) stale.push(f);
  }
  ok(stale.length === 0, "renderer 下不再有硬编码「中文优先 / 回答用中文」" + (stale.length ? "（残留：" + stale.join("、") + "）" : ""));
  ok(
    /agentLangTaste:\s*\(\)\s*=>/.test(read("renderer/app.js")),
    "app.js 的 I18n 兜底桩也补齐 agentLangTaste（缺 i18n.js 时不报错）",
  );
  ok(
    read("dsh/gateway/gateway.mjs").indexOf("agentLangTaste") < 0,
    "网关不改（三层契约）：口味由渲染层随 systemPrompt 传入",
  );

  /* ===================== [4] UI 词条 ===================== */
  console.log("\n[4] UI 词条：顶栏与设置的语言口味提示有中英双语");
  const NEW_KEYS = [
    "智能会话与节点的回复语言会跟随此设置",
    "交流语言（Agent 口味）：",
    " —— 智能会话、智能节点与全局助手都用该语言交流，并期望 agent 用该语言回答；顶栏「中 / EN」切换即生效。",
  ];
  I18n.setLocale("zh");
  for (const k of NEW_KEYS) ok(I18n.t(k) === k, "中文界面原样显示：「" + k.slice(0, 14) + "…」");
  I18n.setLocale("en");
  for (const k of NEW_KEYS)
    ok(I18n.t(k) !== k && /[A-Za-z]{4,}/.test(I18n.t(k)), "英文界面有译文：「" + k.slice(0, 14) + "…」");
  I18n.setLocale("zh");

  const boot = read("renderer/app-boot.js");
  ok(
    boot.indexOf("智能会话与节点的回复语言会跟随此设置") >= 0,
    "顶栏「中 / EN」按钮提示写明口味随语言切换",
  );
  const settings = read("renderer/app-settings.js");
  ok(
    settings.indexOf("交流语言（Agent 口味）：") >= 0 &&
      /langTasteHint\.className = "settings-hint"/.test(settings),
    "设置 · 智能能力区块展示当前交流语言",
  );
  ok(
    settings.indexOf("agentLangLabel") >= 0,
    "该提示取 i18n 语言标签（单一真源，不自写文案）",
  );

  console.log(
    "\n" +
      (fails
        ? "FAILED " + fails + " / " + checks + " checks"
        : "ALL OK  " + checks + " checks"),
  );

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-agent-lang.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-agent-lang.js：" + fails + " / " + checks + " 项失败");
})();

/* ==================== 已并入：test/smoke-agent-reply-bottom.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-agent-reply-bottom.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

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

  const ASSIST = read("renderer/app-assist.js");
  const APP = read("renderer/app.js");
  const DSH_CSS = read("renderer/css/dsh.css");

  /* ==================== [1] 源码口径 ==================== */
  console.log("\n[1] 段不再按条数裁 + 兜底 chips 不再压住回复");
  ok(
    ASSIST.indexOf("AGENT_SEG_TOOL_MAX") < 0,
    "工具段条数上限常量已删净（不再有「最近 40 条工具段」这档口径）",
  );
  ok(
    ASSIST.indexOf("agentSegsTrimCap") < 0,
    "agentSegsTrimCap 已删净（段一条不丢，只夹单段字数）",
  );
  ok(
    /const AGENT_SEG_TEXT_MAX = 8000;/.test(ASSIST) &&
      /if \(s\.k !== "think" && text\.length > AGENT_SEG_TEXT_MAX\)/.test(ASSIST),
    "单段字数上限保留（think 整段不裁，say / err 截长加省略号）",
  );
  ok(
    /body\.insertBefore\(chips, body\.firstChild\);/.test(ASSIST),
    "配不到段的兜底 chips 挂在消息正文最前面（不再 appendChild 到时间线尾部）",
  );
  ok(
    /chips\.className = "dsh-tools dsh-tools-head";/.test(ASSIST),
    "兜底 chips 带 dsh-tools-head 标记（样式与时间线里的 chips 分开）",
  );
  ok(
    /\.dsh-msg-segs>\.dsh-tools-head \{[\s\S]{0,80}margin-bottom/.test(DSH_CSS),
    "dsh.css 给 dsh-tools-head 留了与 .dsh-seg 同档的间距",
  );

  /* ==================== [2] agentSegsForDisk 真源码行为 ==================== */
  console.log("\n[2] agentSegsForDisk：工具段一条不丢、顺序不变、字数照旧夹（跑真源码）");
  const from = ASSIST.indexOf("const AGENT_SEG_TEXT_MAX = 8000;");
  const fnFrom = ASSIST.indexOf("function agentSegsForDisk(segList) {");
  const fnTo = ASSIST.indexOf("\n}\n", fnFrom);
  ok(from > 0 && fnFrom > from && fnTo > fnFrom, "摘到 agentSegsForDisk 真源码");
  const sb = { console };
  vm.createContext(sb);
  const api = vm.runInNewContext(
    ASSIST.slice(from, ASSIST.indexOf("\n", from)) +
      "\n" +
      ASSIST.slice(fnFrom, fnTo + 3) +
      "\n({ agentSegsForDisk, AGENT_SEG_TEXT_MAX })",
    sb,
  );
  const segs100 = [];
  for (let i = 0; i < 100; i++) {
    segs100.push({ k: "think", text: "想" + i, step: i });
    segs100.push({ k: "tool", text: "", step: i, callId: "c" + i });
    segs100.push({ k: "say", text: "说" + i, step: i });
  }
  const disk = api.agentSegsForDisk(segs100);
  ok(disk.length === 300, "300 条段（含 100 条工具段）原样保留（得到 " + disk.length + "）");
  ok(
    disk.filter((s) => s.k === "tool").length === 100,
    "工具段一条不丢（100 条全在，配得上各自的时间线位置）",
  );
  ok(
    disk.every((s, i) => s.k === segs100[i].k) &&
      disk.every((s, i) => (s.step == null ? true : s.step === segs100[i].step)),
    "顺序与 step 原样保持（chip 不会掉到消息尾部）",
  );
  ok(
    disk.every((s) => s.k !== "tool" || !s.text),
    "工具段只留 callId / step，不夹正文",
  );
  const longSay = api.agentSegsForDisk([
    { k: "think", text: "x".repeat(20000), step: 0 },
    { k: "say", text: "y".repeat(20000), step: 0 },
  ]);
  ok(
    longSay[0].text.length === 20000 &&
      longSay[1].text.length === api.AGENT_SEG_TEXT_MAX + 1,
    "think 不裁（20000 字原样）；say 截到上限 + 省略号",
  );
  ok(api.agentSegsForDisk([]) === null, "空段表回 null（调用方按旧口径渲染）");

  /* ==================== [3] 尺寸变化补滚的接线 ==================== */
  console.log("\n[3] 底栏面板变化后补滚回底（跟随底部才补）");
  ok(
    /function bindConvResizeRepin\(el\) \{/.test(APP),
    "app.js 新增 bindConvResizeRepin（会话消息区 / 助手栏 / 节点内联会话共用）",
  );
  ok(
    /bindConvStick\(el\)[\s\S]{0,200}bindConvResizeRepin\(el\);/.test(APP),
    "bindConvStick 里挂上补滚（所有会话滚动容器一处接线）",
  );
  const repinFrom = APP.indexOf("function bindConvResizeRepin(el) {");
  const repinSrc = APP.slice(repinFrom, APP.indexOf("\n}\n", repinFrom));
  ok(
    /typeof ResizeObserver !== "function"/.test(repinSrc) &&
      /new ResizeObserver\(/.test(repinSrc),
    "用 ResizeObserver 观察容器尺寸（不支持时静默跳过）",
  );
  ok(
    /* 守卫判定统一走 convScrollGuardOn（会话运行中滚动条上跳的修复：程序滚动标记
       带序号，同一帧内第二笔程序写入不会提前解锁；这里只钉「不介入」这一语义） */
    /if \(convScrollGuardOn\(el\)\) return;/.test(repinSrc),
    "程序滚动期间不介入（不与本套 setConvScrollTop 抢）",
  );
  ok(
    /let first = true;/.test(repinSrc) &&
      /if \(first\) \{[\s\S]{0,40}first = false;[\s\S]{0,20}return;/.test(repinSrc),
    "首次回调（初始尺寸）不介入 —— 重绘后用户上翻位置的还原权归各自渲染路径",
  );
  ok(
    /if \(!convStickOf\(el\)\) return;/.test(repinSrc),
    "用户上翻过（_convStick=false）的列表一律不动 —— 不把阅读位置拽走",
  );
  ok(
    /el\.scrollTop \+ el\.clientHeight >= el\.scrollHeight - 1/.test(repinSrc),
    "已在底部就不重复写 scrollTop（不做无谓抖动）",
  );
  ok(
    /el\._convRepinBound = true;/.test(repinSrc) && /el\._convRepinRo = ro;/.test(repinSrc),
    "每元素只挂一次，句柄记在元素上（重绘换元素不泄漏）",
  );

  console.log(
    "\n" +
      (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全部通过") +
      "  (smoke-agent-reply-bottom)",
  );

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-agent-reply-bottom.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-agent-reply-bottom.js：" + fails + " / " + checks + " 项失败");
})();

/* 收尾：正文与并入块任一失败都算这只红；退出码只在全部跑完之后才定 */
if (MERGED_FAILED) console.log("\n✗ 本文件有失败项（含已并入块）\n");
process.exit(MERGED_FAILED ? 1 : 0);
