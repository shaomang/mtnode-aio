"use strict";
/* 思考强度（reasoning effort）档位体系 —— 冒烟测试（纯 Node + vm 切片求值，不依赖 Electron）
 *   node test/smoke-reasoning-effort.js
 * 本轮落地：参考 codex（codex-rs/protocol/src/openai_models.rs 的 ReasoningEffort / ModelPreset、
 * core/src/client.rs 的 reasoning_effort_for_request）补全 MTNode 思考强度。
 * 覆盖：
 *   [1] 网关纯模块 dsh/gateway/reasoning-effort.mjs：可选用档词汇表 / 路由能力表 / 兜底默认
 *   [2] 旧值迁移：none / 无 → off（「无」= 关闭思考）、空串 / 非法值 → high（normalizeEffort，永不硬失败）
 *   [3] 归一化回退链（codex reasoning_effort_for_request 式）：clampEffort 同侧最近低档 → high；
 *       off 是「关档」：支持才原样，不支持退回最近正档
 *   [4] DeepSeek 路由夹紧：effortForRoute（medium→low、xhigh→high，low/high/max 原样）
 *   [5] 模型级夹紧 effortForModelEfforts：只支持 off/minimal 的模型 → undefined（不下发）
 *   [6] 渲染层白名单 app.js：AGENT_EFFORT_ORDER/UI_ORDER/LABELS + normalizeAgentEffort 与
 *       网关模块词汇表逐值一致（回显 = 下发契约）
 *   [7] 渲染层 dshEffortOf（app-agent.js 生效版）：会话 / 助手全档原样、proc_text 顶档 → max
 *   [8] 渲染层 devEffortKnown（app-devnode.js）+ app-nodes.js devEffort patch 白名单：
 *       只认档位词汇表内值，未知值警告丢弃（无共享常量环境时兜底同集合）
 *   [9] 网关消费点收敛：gateway.mjs import ./reasoning-effort.mjs，不再自持 EFFORTS /
 *       normalizeEffort（防止档位表出现第二份真源） */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { pathToFileURL } = require("url");

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
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* 源码切片：从 startMark 起、到 endMark 止（endMark 可为 null 表示用到下一个闭括号锚点） */
function between(src, startMark, endMark, label) {
  const a = src.indexOf(startMark);
  const b = a >= 0 ? src.indexOf(endMark, a) : -1;
  ok(a >= 0 && b > a, "定位到 " + label);
  return a >= 0 && b > a ? src.slice(a, b) : "";
}

const GATE = read("dsh/gateway/gateway.mjs");
const APP = read("renderer/app.js");
const AGENT = read("renderer/app-agent.js");
const DEVNODE = read("renderer/app-devnode.js");
const NODES = read("renderer/app-nodes.js");

const MOD = "dsh/gateway/reasoning-effort.mjs";

(async () => {
  /* ==================== [1] 网关纯模块：词汇表 / 能力表 ==================== */
  console.log("\n[1] 网关纯模块 " + MOD + "（词汇表 / 能力表）");
  const R = await import(pathToFileURL(path.join(__dirname, "..", ...MOD.split("/"))).href);
  ok(
    eq(R.EFFORT_ORDER, ["off", "low", "medium", "high", "xhigh", "max"]),
    "可选用档 EFFORT_ORDER = off/low/medium/high/xhigh/max（off = 「无」＝关思考，对齐 pi-ai 能力集，升序）",
  );
  ok(eq(R.EFFORTS, R.EFFORT_ORDER), "网关口白 EFFORTS = 可选用档全集（旧 low/high/max 的扩档版）");
  ok(
    eq(R.FULL_LADDER, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
    "FULL_LADDER 保留 pi-ai 全阶梯（off 已入选，minimal 无消费方不入选）",
  );
  ok(R.DEFAULT_EFFORT === "high", "兜底默认 = high（与 llm-deepseek 适配器缺省一致）");
  ok(
    eq(R.DEEPSEEK_EFFORTS, ["off", "low", "high", "max"]),
    "deepseek 路由能力表 = off/low/high/max（适配器能力 ∩ 可选用档，off 即「无」＝关思考）",
  );
  ok(
    eq(R.routeEffortsOf("deepseek-official"), ["off", "low", "high", "max"]),
    "deepseek-official 路由能力表 = off/low/high/max",
  );
  ok(
    eq(R.routeEffortsOf("mtnode_p1"), R.EFFORT_ORDER) &&
      eq(R.routeEffortsOf(""), R.EFFORT_ORDER) &&
      eq(R.routeEffortsOf(null), R.EFFORT_ORDER),
    "目录/pi-ai/未知/空路由按全档（模型级精确能力由运行时插件夹紧）",
  );

  /* ==================== [2] 「无」/旧值迁移：none/无 → off，空串/非法 → high ==================== */
  console.log("\n[2] 旧值迁移（normalizeEffort）");
  ok(R.normalizeEffort("off") === "off", "off → off（会话 / 助手「无」＝关闭思考，不再是回落 high）");
  ["none", "无", "OFF"].forEach((v) =>
    ok(R.normalizeEffort(v) === "off", "旧档 / 中文「无」 " + JSON.stringify(v) + " → off"),
  );
  ["", undefined, null].forEach((v) =>
    ok(R.normalizeEffort(v) === "high", "空值 " + JSON.stringify(v) + " → high（没选 = 兜底默认）"),
  );
  ["off", "low", "medium", "high", "xhigh", "max"].forEach((v) =>
    ok(R.normalizeEffort(v) === v, "可选用档 " + v + " 原样保留"),
  );
  ok(R.normalizeEffort(" High ") === "high", "大小写 / 空白容忍：' High ' → high");
  ["ultra", "persistent", "disabled", "custom", "垃圾"].forEach((v) =>
    ok(R.normalizeEffort(v) === "high", "非法 / codex 专有档 " + v + " → high 兜底（永不硬失败）"),
  );

  /* ==================== [3] 归一化回退链（codex reasoning_effort_for_request 式） ==================== */
  console.log("\n[3] 归一化回退链（clampEffort：同侧最近低档 → high 兜底）");
  ok(R.clampEffort("low", ["low", "high", "max"]) === "low", "支持档命中 → 原样");
  ok(R.clampEffort("medium", ["low", "high", "max"]) === "low", "medium 不支持 → 同侧最近低档 low");
  ok(R.clampEffort("xhigh", ["low", "high", "max"]) === "high", "xhigh 不支持 → 同侧最近低档 high");
  ok(R.clampEffort("max", ["low", "high", "max"]) === "max", "max 支持 → 原样");
  ok(R.clampEffort("max", ["low", "high"]) === "high", "max 不支持且无更高档 → 一路回退到 high");
  ok(R.clampEffort("xhigh", ["low", "medium", "high"]) === "high", "目标档恰为能力上限 → 返回上限");
  ok(R.clampEffort("high", undefined) === "high", "无能力表 → 按全档（high 命中）");
  ok(R.clampEffort("off", ["low", "high", "max"]) === "low", "off 不被支持（老能力表）→ 退回最近正档 low，绝不停在 off");
  ok(R.clampEffort("off", ["off", "low", "high", "max"]) === "off", "off 被支持（deepseek 适配器）→ 原样关思考");
  ok(R.clampEffort("off", ["off", "minimal"]) === "off", "只支持 off/minimal 的模型也能关思考");
  ok(R.clampEffort("disabled", ["low", "high", "max"]) === "high", "codex Custom(disabled) → high 兜底");
  const allInCaps = R.EFFORT_ORDER.every((want) =>
    R.DEEPSEEK_EFFORTS.includes(R.clampEffort(want, R.DEEPSEEK_EFFORTS)),
  );
  ok(allInCaps, "性质：deepseek 能力集上归一结果永远落在能力集内");

  /* ==================== [4] DeepSeek 路由夹紧（effortForRoute） ==================== */
  console.log("\n[4] DeepSeek 路由夹紧（effortForRoute · 回显 = 下发契约）");
  ok(R.effortForRoute("medium", "deepseek-official") === "low", "deepseek 路由 medium → low（同侧最近低档）");
  ok(R.effortForRoute("xhigh", "deepseek-official") === "high", "deepseek 路由 xhigh → high");
  ok(R.effortForRoute("low", "deepseek-official") === "low", "deepseek 路由 low 原样");
  ok(R.effortForRoute("high", "deepseek-official") === "high", "deepseek 路由 high 原样");
  ok(R.effortForRoute("max", "deepseek-official") === "max", "deepseek 路由 max 原样");
  ok(R.effortForRoute("off", "deepseek-official") === "off", "deepseek 路由「无」off 原样（直达适配器 thinking disabled）");
  ok(R.effortForRoute("无", "deepseek-official") === "off", "deepseek 路由中文「无」→ off");
  ok(R.effortForRoute("off", "mtnode_p1") === "off", "目录/pi-ai 路由 off 不夹紧（真档，模型级再由插件裁决）");
  ok(R.effortForRoute("medium", "mtnode_p1") === "medium", "目录/pi-ai 路由 medium 不夹紧（真档）");
  ok(R.effortForRoute("xhigh", "mtnode_p1") === "xhigh", "目录/pi-ai 路由 xhigh 不夹紧");
  ok(R.effortForRoute("ultra", "deepseek-official") === "high", "非法档在任意路由 → high 兜底");

  /* ==================== [5] 模型级夹紧（effortForModelEfforts，运行时插件口径） ==================== */
  console.log("\n[5] 模型级夹紧（effortForModelEfforts：无正档 → 不下发）");
  ok(R.effortForModelEfforts("max", ["off", "low", "high", "max"]) === "max", "模型能力命中 → 原样");
  ok(R.effortForModelEfforts("xhigh", ["off", "low", "high", "max"]) === "high", "模型不支持 xhigh → high");
  ok(R.effortForModelEfforts("medium", ["off", "low", "high", "max"]) === "low", "模型不支持 medium → low");
  ok(
    R.effortForModelEfforts("high", ["off", "minimal"]) === undefined,
    "模型只支持 off/minimal → undefined（不下发，沿用提供方默认，绝不盲发会 UNSUPPORTED 的值）",
  );
  ok(R.effortForModelEfforts("high", []) === undefined, "空能力表 → undefined");
  ok(R.effortForModelEfforts("medium", ["off", "minimal", "xhigh", "max"]) === undefined, "无低侧正档可回 → undefined");
  ok(
    R.effortForModelEfforts("off", ["off", "low", "high", "max"]) === "off",
    "「无」off 命中模型能力 → 原样关思考",
  );
  ok(
    R.effortForModelEfforts("off", ["low", "high", "max"]) === "low",
    "模型不支持 off（老能力表）→ 退回最近正档 low，绝不盲发 off",
  );
  ok(
    R.effortForModelEfforts("medium", ["low", "foo", "max", "HIGH"]) === "low",
    "能力表脏值 / 大小写不匹配被过滤（只认词汇表内小写档）→ low",
  );

  /* ==================== [6] 渲染层白名单 app.js（与网关词汇表逐值一致） ==================== */
  console.log("\n[6] 渲染层白名单 app.js（AGENT_EFFORT_* + normalizeAgentEffort）");
  const appConsts = between(
    APP,
    "const AGENT_EFFORT_ORDER = [",
    "function agentPresetId(id) {",
    "app.js AGENT_EFFORT_* 常量块",
  );
  const appFns = between(
    APP,
    "function normalizeAgentEffort(v) {",
    "const NODE_DEFAULTS = {",
    "app.js normalizeAgentEffort / agentEffortLabelOf / agentEffortDisplayLabel",
  );
  const s6 = vm.createContext({ I18n: { t: (k) => k }, console });
  vm.runInContext(appConsts + "\n" + appFns, s6, { filename: "app.js#effort" });
  const ex6 = (expr) => vm.runInContext(expr, s6);
  ok(
    eq(ex6("AGENT_EFFORT_ORDER"), R.EFFORT_ORDER.filter((v) => v !== "off")),
    "AGENT_EFFORT_ORDER ≡ 网关可选用档去掉 off（开发 / 工具块白名单不含「无」：agent 链不能关思考）",
  );
  ok(
    eq(ex6("AGENT_EFFORT_UI_ORDER"), ["off", "low", "high", "xhigh", "max"]),
    "会话 / 助手 UI 露出五档 = 无/轻/标准/强/最强",
  );
  ok(
    ex6("AGENT_EFFORT_UI_ORDER.every(function (v) { return AGENT_EFFORT_ORDER.indexOf(v) >= 0 || v === 'off'; })") &&
      ex6("AGENT_EFFORT_UI_ORDER.indexOf('medium') < 0") &&
      ex6("AGENT_EFFORT_ORDER.indexOf('off') < 0"),
    "UI 露出档 ⊆ 网关词汇表且 medium 不露出（默认路由会把它夹到 low，露出即静默降档陷阱）；off 只留在 UI 档（关思考）",
  );
  ok(
    eq(ex6("AGENT_EFFORT_DEV_ORDER"), ["low", "high", "xhigh", "max"]),
    "开发节点档位格不含「无」（devEffort 白名单 = AGENT_EFFORT_ORDER，落不下盘的档不露出）",
  );
  ok(
    ex6("AGENT_EFFORT_DEV_ORDER.every(function (v) { return AGENT_EFFORT_ORDER.indexOf(v) >= 0; })"),
    "开发节点露出档 ⊆ 词汇表",
  );
  ok(
    ex6("Object.keys(AGENT_EFFORT_LABELS).length === 6 && AGENT_EFFORT_LABELS.high === '标准'"),
    "AGENT_EFFORT_LABELS 六档全有短名（high = 标准）",
  );
  ok(
    ex6("AGENT_EFFORT_LABELS.off === '无' && agentEffortLabelOf('off') === '无'"),
    "「无」= off 档的短名（会话 / 助手菜单首档）",
  );
  const normBoth = (v) =>
    R.normalizeEffort(v) === vm.runInContext("normalizeAgentEffort(" + JSON.stringify(v) + ")", s6);
  ["off", "none", "无", "", "low", "medium", "high", "xhigh", "max", "ultra", "disabled", "HIGH", " Low "].forEach(
    (v) => ok(normBoth(v), "normalizeEffort ≡ normalizeAgentEffort（值 " + JSON.stringify(v) + " 两侧同判）"),
  );
  ok(ex6("normalizeAgentEffort('medium')") === "medium", "渲染层 medium 是合法白名单值（不拍平）");
  ok(ex6("normalizeAgentEffort('max')") === "max", "渲染层旧档 max 原样合法（不迁移不重置）");
  ok(ex6("agentEffortLabelOf('xhigh')") === "强", "档位短名 xhigh = 强");
  ok(ex6("agentEffortLabelOf('medium')") === "中", "未露出档 medium 也有可显示名 = 中");
  ok(ex6("agentEffortDisplayLabel({ effort: 'max' })") === "最强", "agentEffortDisplayLabel 随档位显示");

  /* ==================== [7] 渲染层 dshEffortOf（app-agent.js 生效版） ==================== */
  console.log("\n[7] 渲染层 dshEffortOf（app-agent.js · 会话 / 助手 / proc_text）");
  const agSrc = between(AGENT, "function dshEffortOf(v, fromProcText) {", "/* 中断智能运行", "app-agent.js dshEffortOf");
  const s7 = vm.createContext({
    console,
    AGENT_EFFORT_ORDER: R.EFFORT_ORDER,
    AGENT_PRESETS: [],
  });
  vm.runInContext(agSrc, s7, { filename: "app-agent.js#dshEffortOf" });
  const ex7 = (expr) => vm.runInContext(expr, s7);
  ok(ex7("dshEffortOf('low')") === "low", "low 原样下发（不再拍平 high）");
  ok(ex7("dshEffortOf('medium')") === "medium", "medium 原样下发");
  ok(ex7("dshEffortOf('xhigh')") === "xhigh", "xhigh 原样下发");
  ok(ex7("dshEffortOf('max')") === "max", "max 原样下发");
  ok(ex7("dshEffortOf('high')") === "high", "high 原样下发");
  ok(ex7("dshEffortOf('high', true)") === "max", "proc_text 智能文本节点（fromProcText）顶档 high → max（历史口径）");
  ok(ex7("dshEffortOf('low', true)") === "low" && ex7("dshEffortOf('medium', true)") === "medium",
    "proc_text 低 / 中 → low / medium 跟随词汇表原样");
  ok(ex7("dshEffortOf('off')") === "off", "「无」off 原样下发（会话 / 助手：网关侧关闭思考）");
  ["none", "无"].forEach((v) =>
    ok(ex7("dshEffortOf(" + JSON.stringify(v) + ")") === "off", "旧档 / 中文「无」 " + JSON.stringify(v) + " → off"),
  );
  ok(ex7("dshEffortOf('')") === "high", "空串（没选）→ high 兜底");
  ok(
    ["off", "none", "无"].every((v) => ex7("dshEffortOf(" + JSON.stringify(v) + ", true)") === "high"),
    "proc_text 智能文本节点（agent 链）「无」→ high（agent 链上思考不能关闭，历史口径不变）",
  );
  ok(ex7("dshEffortOf(undefined)") === "high" && ex7("dshEffortOf(null)") === "high", "空值 → high 兜底");
  ok(ex7("dshEffortOf('ultra')") === "high", "非法档 → high 兜底");

  /* ==================== [8] 渲染层 devEffortKnown + app-nodes.js patch 白名单 ==================== */
  console.log("\n[8] 渲染层 devEffortKnown（app-devnode.js）+ devEffort patch 白名单（app-nodes.js）");
  const devFn = between(DEVNODE, "function devEffortKnown(v) {", "function devEffortOwn(node) {", "app-devnode.js devEffortKnown");
  const s8a = vm.createContext({ console, AGENT_EFFORT_ORDER: R.EFFORT_ORDER.filter((v) => v !== "off") });
  vm.runInContext(devFn, s8a, { filename: "app-devnode.js#devEffortKnown" });
  const ex8 = (expr, ctx) => vm.runInContext(expr, ctx || s8a);
  R.EFFORT_ORDER.filter((v) => v !== "off").forEach((v) =>
    ok(ex8("devEffortKnown(" + JSON.stringify(v) + ")") === v, "devEffortKnown 认 " + v),
  );
  ["off", "none", "无", "", undefined, "ultra"].forEach((v) =>
    ok(ex8("devEffortKnown(" + JSON.stringify(v) + ")") === "", "devEffortKnown 拒绝 " + JSON.stringify(v)),
  );
  const s8b = vm.createContext({ console });
  vm.runInContext(devFn, s8b, { filename: "app-devnode.js#devEffortKnown#fallback" });
  ok(
    vm.runInContext("devEffortKnown('xhigh') === 'xhigh' && devEffortKnown('medium') === 'medium'", s8b) &&
      vm.runInContext("devEffortKnown('off') === ''", s8b),
    "无常量环境兜底同集合（五档认、旧档拒）——与 devEffortKnown 语义一致",
  );
  const patchBlock = between(
    NODES,
    "if (patch.devEffort != null) {",
    "/* 核心文件列表",
    "app-nodes.js devEffort patch 白名单块",
  );
  const DEV_ORDER = R.EFFORT_ORDER.filter((v) => v !== "off");
  const runPatch = (v) => {
    const ctx = vm.createContext({
      console,
      patch: { devEffort: v },
      node: {},
      warnings: [],
      I18n: { t: (k) => k },
    });
    vm.runInContext(patchBlock, ctx, { filename: "app-nodes.js#devEffortPatch" });
    return { node: ctx.node, warnings: ctx.warnings };
  };
  DEV_ORDER.forEach((v) => {
    const r = runPatch(v);
    ok(r.node.devEffort === v && r.warnings.length === 0, "patch devEffort " + v + " 通过白名单落盘");
  });
  const rOff = runPatch("off");
  ok(rOff.node.devEffort === undefined && rOff.warnings.length === 1, "patch devEffort off → 警告丢弃（「无」不能落进开发块）");
  ok(rOff.warnings[0].indexOf("未知思考强度档位") >= 0, "警告文案点名未知档位");
  ok(runPatch("").node.devEffort === "", "patch devEffort 空串 → 清空（跟随默认）");
  ok(runPatch("ultra").warnings.length === 1, "patch devEffort ultra → 警告丢弃");

  /* ==================== [9] 网关消费点收敛（防止第二份真源） ==================== */
  console.log("\n[9] 网关消费点收敛（gateway.mjs 单一真源）");
  ok(
    GATE.indexOf("from './reasoning-effort.mjs'") >= 0 &&
      GATE.indexOf("effortForRoute") >= 0 &&
      GATE.indexOf("effortKeyOf") >= 0 &&
      GATE.indexOf("DEFAULT_EFFORT") >= 0,
    "gateway.mjs import ./reasoning-effort.mjs 的 effortForRoute / effortKeyOf / DEFAULT_EFFORT",
  );
  ok(
    !/const EFFORTS\s*=/.test(GATE) && !/function normalizeEffort\s*\(/.test(GATE),
    "gateway.mjs 不再自持 EFFORTS / normalizeEffort（档位表无第二份实现）",
  );
  ok(
    GATE.indexOf("effortForRoute(rawEffort, route)") >= 0,
    "handleRun 用 effortForRoute 先定路由再归一（每轮 run 的生效档）",
  );
  ok(
    GATE.indexOf("env.MTNODE_EFFORT") >= 0,
    "生效档经 env MTNODE_EFFORT 下达运行时（mtnode-effort 插件再按模型夹一次）",
  );
  const PLUGIN = read("dsh/gateway/plugins/effort-plugin.mjs");
  ok(
    PLUGIN.indexOf("['off', 'low', 'high', 'max']") >= 0,
    "运行时插件 deepseek 能力表含 off（「无」命中即下发 thinking disabled）",
  );

  /* ==================== [10] 文本处理节点头部按钮：补「最强」(max) ==================== */
  console.log("\n[10] proc_text 节点头部思考强度按钮（无 / 低 / 中 / 高 / 最强）");
  const CANVAS = read("renderer/app-canvas.js");
  const I18N = read("renderer/i18n.js");
  const MAIN = read("main.js");
  const btnSrc = between(
    CANVAS,
    "const EFFORT_LEVELS =",
    "function effortButtonEl(node) {",
    "app-canvas.js 文本思考档表（EFFORT_LEVELS / EFFORT_LABELS / normalizeTextEffort）",
  );
  const s10 = vm.createContext({ console, I18n: { t: (k) => k } });
  vm.runInContext(btnSrc, s10, { filename: "app-canvas.js#textEffort" });
  const ex10 = (expr) => vm.runInContext(expr, s10);
  ok(
    eq(ex10("EFFORT_LEVELS"), ["off", "low", "medium", "high", "max"]),
    "按钮环五档：无/低/中/高/最强（点击切换走这张表）",
  );
  ok(ex10("EFFORT_LABELS.max") === "最强", "最强档短名 = 「最强」（与会话 / 智能节点同一称谓）");
  ok(ex10("normalizeTextEffort('max')") === "max", "max 不再掉到 low（按钮选最强 = 真正下发 max）");
  ok(ex10("normalizeTextEffort('xhigh')") === "high", "xhigh 不露出但归一成 high（默认路由会夹到 high，不掉 low）");
  ok(
    ex10("normalizeTextEffort('off')") === "off" && ex10("normalizeTextEffort('none')") === "low",
    "旧档语义不变：off / 无 仍在、none/minimal → low",
  );
  ok(
    CANVAS.indexOf("点击切换（无 / 低 / 中 / 高 / 最强）") >= 0 &&
      I18N.indexOf('"」· 点击切换（无 / 低 / 中 / 高 / 最强）"') >= 0 &&
      I18N.indexOf("(Off / Low / Medium / High / Max)") >= 0,
    "按钮 tooltip 文案与中英词条同步为五档（含 Max）",
  );
  ok(
    NODES.indexOf('node.kind === "proc_text" ? normalizeTextEffort(node.effort)') >= 0,
    "app-nodes 下发文本节点档位走同一归一（max 可直达主进程）",
  );
  const thinkSrc = between(
    MAIN,
    "function applyTextThinkingEffort(body, effort) {",
    "/* ── gpt-image-2 图像参数",
    "main.js applyTextThinkingEffort",
  );
  const s10b = vm.createContext({ console });
  vm.runInContext(thinkSrc, s10b, { filename: "main.js#applyTextThinkingEffort" });
  vm.runInContext(
    "var bMax = {}; applyTextThinkingEffort(bMax, 'max');" +
      "var bOff = {}; applyTextThinkingEffort(bOff, 'off');",
    s10b,
  );
  ok(
    s10b.bMax.thinking.type === "enabled" && s10b.bMax.reasoning_effort === "max",
    "末段运输：max → thinking.enabled + reasoning_effort=max（全链路真的到得了顶档）",
  );
  ok(
    s10b.bOff.thinking.type === "disabled" && s10b.bOff.reasoning_effort === undefined,
    "末段运输：off → thinking.disabled 且不发 reasoning_effort（关闭思考语义不变）",
  );

  console.log(
    "\n" +
      (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全部通过") +
      "  (smoke-reasoning-effort)",
  );
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error("smoke-reasoning-effort 运行异常：" + e.stack);
  process.exit(1);
});
