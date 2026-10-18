#!/usr/bin/env node
/* test/smoke-default-model-top.js —— 「设置 · 默认模型」置顶 + 与会话对齐（本次需求）
 * ============================================================================
 * 需求（用户口径）：把设置里的默认模型放到最上方，并且「设置完整、与会话对齐」。
 * 拷问共识（本轮）：
 *   ① 位置：设置整页第一块「默认模型」（在「提供商配置」之上），智能能力里那格删除；
 *   ② 内容：提供商（先选服务商、模型只列这家）/ 模型 / 思考强度 / 预设 / 上下文压缩，
 *      与**会话输入区的模型菜单**对齐；
 *   ③ 生效：新建会话按设置播种；会话自己选过的优先，只有会话模型为空时才按设置的
 *      「提供商 + 模型」整体兜底（替掉「无条件取该服务商清单第一只」）；
 *   ④ 助手栏合并成一份真源（config.dsh.provider / model / effort），老 assist* 启动时迁走；
 *   ⑤ 默认思考强度只管新会话 + 助手栏（工具 / 长任务 / 开发会话不动）。
 *
 * 本文件钉的是：源码契约（[0][3]）+ 两段真逻辑真跑（[1] 设置读取器、[2] 运行期兜底）
 * + i18n（[4]）。零依赖、不起 Electron、不碰 %APPDATA%。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
/* 源码切片一律先归一成 LF：本仓工作区里 CRLF 与 LF 并存（见 test/layout-agent-plan.js） */
const lf = (s) => String(s == null ? "" : s).replace(/\r\n/g, "\n");

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
function has(src, needle, msg) {
  ok(String(src).indexOf(needle) >= 0, msg + (String(src).indexOf(needle) >= 0 ? "" : "\n        缺：" + needle));
}
/* 取两个锚点之间的源码（含后一个锚点之前的全部内容） */
function between(src, a, b) {
  const s = lf(src);
  const i = s.indexOf(a);
  if (i < 0) throw new Error("找不到起点锚：" + a);
  const j = b ? s.indexOf(b, i + a.length) : -1;
  if (b && j < 0) throw new Error("找不到终点锚：" + b);
  return s.slice(i, j < 0 ? s.length : j);
}

const SETTINGS = read("renderer/app-settings.js");
const BOOT = read("renderer/app-boot.js");
const ASSIST = read("renderer/app-assist.js");
const DB = read("renderer/app-db.js");
const AGENT = read("renderer/app-agent.js");
const APP = read("renderer/app.js");
const I18N = read("renderer/i18n.js");

/* ═══════════════════════ [0] 源码契约：位置与去重 ═══════════════════════ */
console.log("\n[0] 源码契约：默认模型置顶 · 智能能力里那几行已搬走");
{
  const lead = SETTINGS.indexOf('sec.className = "settings-sec settings-sec-lead";');
  const provSec = SETTINGS.indexOf("const provSec = document.createElement(\"div\");");
  ok(
    lead > 0 && provSec > lead,
    "「默认模型」块（settings-sec-lead）出现在「提供商配置」之前 —— 设置整页第一块",
  );
  has(SETTINGS, 'secTitleSpan.textContent = I18n.t("默认模型");', "首块标题 = 「默认模型」");
  ok(
    SETTINGS.indexOf("默认模型（智能能力使用）") < 0,
    "旧的「默认模型（智能能力使用）」那一行已删除（不再有两处默认模型）",
  );
  ok(
    SETTINGS.indexOf("S.config.dsh.compact") < 0 &&
      SETTINGS.indexOf("assistCompactCustomSet") < 0 &&
      SETTINGS.indexOf('I18n.t("上下文压缩"') < 0,
    "上下文压缩已从设置移除（设置里不再有第二个宿主，档位只在会话侧）",
  );
  ok(
    (SETTINGS.match(/Agent 预设（智能能力的角色与行为风格）/g) || []).length === 1,
    "Agent 预设只有一行（同上，智能能力里不再重复）",
  );
  has(SETTINGS, 'document.createTextNode(I18n.t("模型提供商"))', "有「模型提供商」格（与会话菜单同构）");
  has(SETTINGS, 'document.createTextNode(I18n.t("思考强度"))', "有「思考强度」格（新增默认档）");
  has(
    SETTINGS,
    'typeof AGENT_EFFORT_UI_ORDER !== "undefined"',
    "思考强度档位取自 AGENT_EFFORT_UI_ORDER（与会话菜单同一张表）",
  );
  has(
    SETTINGS,
    "const paintModelOptions = (provId, preferModel)",
    "模型格按提供商重建（只列这家的模型）",
  );
  ok(
    SETTINGS.indexOf("modelSel.appendChild(og)") < 0,
    "跨服务商 optgroup 平铺已下线（同名模型不再歧义）",
  );
}

/* ═══════════════════════ [1] 设置读取器：真跑三格 ═══════════════════════ */
console.log("\n[1] 设置读取器 dshDefaultProviderRoute / Model / Effort / Preset（真跑 app-agent.js 那份）");
{
  const SRC = between(AGENT, "function dshDefaultProviderRoute() {", "/* ═══════════ 「默认模型」");
  const S = {
    config: {
      dsh: { provider: "", model: "", effort: "", preset: "" },
      providers: [],
    },
  };
  const ROUTES = ["deepseek-official", "mtnode_p1"];
  const sandbox = {
    S,
    AGENT_PRESET_DEFAULT: "standard",
    agentRouteOptions: () => new Set(ROUTES),
    preferredAgentProviderRoute: () => "mtnode_p1",
    normalizeAgentEffort: (v) => {
      const raw = String(v == null ? "" : v).trim().toLowerCase();
      if (raw === "off") return "off";
      return ["low", "medium", "high", "xhigh", "max"].includes(raw) ? raw : "high";
    },
    I18n: { t: (s) => s },
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  const run = (code) => vm.runInContext(code, sandbox);
  const d = S.config.dsh;

  d.provider = "";
  ok(run("dshDefaultProviderRoute()") === "mtnode_p1", "提供商没选过 → 跟随生效的默认智能路由（preferredAgentProviderRoute）");
  d.provider = "deepseek-official";
  ok(run("dshDefaultProviderRoute()") === "deepseek-official", "选过且可选 → 就用用户选的那家");
  d.provider = "mtnode_gone";
  ok(run("dshDefaultProviderRoute()") === "mtnode_p1", "选过但那家已不可用（停用 / 删掉）→ 回落到生效路由，不抛错");
  d.provider = "";

  d.model = "";
  ok(run("dshDefaultModelValue()") === "", "模型没选过 = 空串（由调用点决定回显 / 兜底）");
  d.model = "m2";
  ok(run("dshDefaultModelValue()") === "m2", "模型选过 → 原样返回");
  d.model = "";

  d.effort = "";
  ok(run("dshDefaultEffortValue()") === "high", "思考强度缺省 high（与会话 / 助手历史默认一致）");
  d.effort = "low";
  ok(run("dshDefaultEffortValue()") === "low", "选过 low → low");
  d.effort = "not-a-tier";
  ok(run("dshDefaultEffortValue()") === "high", "废值 → 归一到 high（不把非法档下发）");
  d.effort = "";

  d.preset = "";
  ok(run("dshDefaultPresetValue()") === "standard", "预设缺省 = AGENT_PRESET_DEFAULT");
  d.preset = "code";
  ok(run("dshDefaultPresetValue()") === "code", "预设选过 → 原样返回");
}

/* ═══════════════════════ [2] 运行期兜底：真跑 app-db.js 那段 ═══════════════════════ */
console.log("\n[2] 运行期兜底：会话没选过模型时才按设置的「提供商 + 模型」成对补");
{
  const SRC = between(DB, "  const ownProvider = String(opts.provider || \"\").trim();", "  /* 对话路由密钥");
  const AVAILABLE = {
    "deepseek-official": ["deepseek-flash", "deepseek-v4-pro"],
    mtnode_p1: ["m1", "m2"],
  };
  const mkSandbox = (dsh) => {
    const sandbox = {
      S: { config: { dsh } },
      mtnodePiProviders: () => [],
      dshDefaultModelValue: () => String(dsh.model || "").trim(),
      dshDefaultProviderRoute: () => String(dsh.provider || "").trim() || "deepseek-official",
      dshModelFitsRouteNow: (route, model) => (AVAILABLE[route] || []).indexOf(String(model)) >= 0,
      agentModelsForRoute: (route) => (AVAILABLE[route] || []).slice(),
    };
    vm.createContext(sandbox);
    vm.runInContext("function runIt(opts) {\n" + SRC + "\n  return opts;\n}", sandbox);
    return sandbox;
  };
  const runCase = (dsh, opts) => {
    const sb = mkSandbox(dsh);
    sb.__opts = Object.assign({}, opts);
    const out = vm.runInContext("runIt(__opts)", sb);
    return { provider: out.provider, model: out.model };
  };

  let r = runCase({ provider: "deepseek-official", model: "deepseek-v4-pro" }, { provider: "deepseek-official" });
  ok(r.model === "deepseek-v4-pro", "会话模型为空 → 用设置里的默认模型（旧实现会拿清单第一只 flash）");
  r = runCase({ provider: "deepseek-official", model: "deepseek-v4-pro" }, { provider: "deepseek-official", model: "deepseek-flash" });
  ok(r.model === "deepseek-flash", "会话自己选过模型 → 优先，不被设置顶掉");

  r = runCase({ provider: "deepseek-official", model: "deepseek-v4-pro" }, { provider: "mtnode_p1" });
  ok(
    r.provider === "deepseek-official" && r.model === "deepseek-v4-pro",
    "会话那家挂不上设置的模型 → 「提供商 + 模型」成对按设置拨正（绝不 A 家模型配 B 家路由）",
  );

  r = runCase({ provider: "mtnode_p1", model: "m2" }, { provider: "mtnode_p1" });
  ok(r.provider === "mtnode_p1" && r.model === "m2", "设置里的模型属于会话那家 → 只补模型，服务商不动");

  r = runCase({ provider: "", model: "" }, { provider: "mtnode_p1" });
  ok(r.provider === "mtnode_p1" && r.model === "m1", "设置里也没有模型 → 回落到该服务商清单第一只（旧口径保留）");

  r = runCase({ provider: "mtnode_p1", model: "" }, {});
  ok(r.provider === "mtnode_p1", "本轮没给提供商 → 用设置里的（设置也没选过才退回 DeepSeek 官方）");
}

/* ═══════════════════════ [3] 播种与助手栏：单一真源 ═══════════════════════ */
console.log("\n[3] 新建会话按设置播种 · 助手栏与会话读同一份");
{
  const newSess = between(ASSIST, "function newAgentSession() {", "/* ── 契约会话通用装配");
  has(newSess, "preset: dshDefaultPresetValue()", "新建会话的预设 = 设置里的预设（不再沿用当前会话）");
  has(newSess, "provider: dshDefaultProviderRoute()", "新建会话的提供商 = 设置里的提供商");
  has(newSess, "model: dshDefaultModelValue()", "新建会话的模型 = 设置里的模型");
  has(newSess, "effort: dshDefaultEffortValue()", "新建会话的思考强度 = 设置里的默认档");

  const placeholder = between(ASSIST, "function agentSessionState() {", "function wsGroupOf(ws) {");
  has(placeholder, "provider: dshDefaultProviderRoute()", "占位空会话同样按设置播种（它一收到消息就是真会话）");

  const persist = between(ASSIST, "function persistAssistUi() {", "const ASSIST_W_MIN");
  ok(
    persist.indexOf("S.config.assistProvider =") < 0 &&
      persist.indexOf("S.config.assistModel =") < 0 &&
      persist.indexOf("S.config.assistEffort =") < 0,
    "助手栏不再落盘自己那份 assistProvider / assistModel / assistEffort（唯一真源 = config.dsh.*）",
  );
  has(persist, "delete S.config.assistProvider", "老键在保存路径上也被清掉（迁移后不会复活）");

  const fill = between(ASSIST, "function fillAssistModelControls() {", "function fillAssistScopeControl() {");
  has(fill, "let cur = dshDefaultModelValue();", "助手栏模型格读设置里的那一只");
  has(fill, "S.config.dsh.provider = String(provSel.value || \"\");", "助手栏换服务商 = 写设置里的提供商");
  has(fill, "S.config.dsh.model = String(modelSel.value || \"\");", "助手栏换模型 = 写设置里的模型");

  has(BOOT, "function migrateAssistDefaultsToDsh", "启动时把老 assist* 一次性并入 dsh.*（迁移函数在位）");
  has(BOOT, "S.assistEffort = dshDefaultEffortValue();", "助手栏思考强度镜像来自设置（长任务等旧入口仍读它）");
  has(BOOT, "S.config.dsh.effort = normalizeAgentEffort(effortSel.value);", "助手栏改思考强度即写设置");
  has(BOOT, "provider: \"\",", "app-boot 的 dsh 缺省里新增 provider（空 = 跟随生效路由）");
  has(BOOT, "effort: \"high\",", "app-boot 的 dsh 缺省里新增 effort（high）");
}

/* ═══════════════════════ [3b] 两份逐字同步 ═══════════════════════ */
console.log("\n[3b] app.js 与 app-agent.js 的默认模型读取器逐字一致");
{
  const seg = (src) => between(src, "function dshDefaultProviderRoute() {", "/* ═══════════ 「默认模型」");
  ok(seg(APP) === seg(AGENT), "四个读取器两份逐字一致（后加载的 app-agent.js 才是生效那份）");
  const pick = (src) => between(src, "function dshDefaultModelRoutes(model) {", "/* 解析结果（不抛）");
  ok(pick(APP) === pick(AGENT), "dshDefaultModelRoutes 两份逐字一致（提供商优先取设置里的）");
  has(pick(AGENT), 'push(dshDefaultProviderRoute())', "候选路由① = 设置里的提供商");
}

/* ═══════════════════════ [4] i18n ═══════════════════════ */
console.log("\n[4] i18n：本次新增文案英文界面都有译文；已删文案不留残键");
{
  const keys = [
    "（无可用服务商：请先在下方「提供商配置」里填 API Key）",
    "默认模型 / Agent 预设已移到设置最上方的「默认模型」那一块。",
    "权限预设",
  ];
  const missing = keys.filter((k) => {
    const i = I18N.indexOf('"' + k + '"');
    if (i < 0) return true;
    /* 词条是「"中文键":\n  "英文值"」两行，取键后面这一小段看有没有英文 */
    return !/[A-Za-z]{4,}/.test(I18N.slice(i + k.length + 2, i + k.length + 360));
  });
  ok(missing.length === 0, "新增 " + keys.length + " 条文案都有英文译文" + (missing.length ? " 缺：" + missing.join(" | ") : ""));
  /* 本轮删除的四段说明文字：源码与词条里都不该再留（删了源码却留词条 = 死键） */
  const gone = [
    "（新建会话与右侧助手都用这一份；会话里单独选过的以会话为准）",
    "只列当前提供商的模型；改提供商后这一格跟着换成那家的清单。",
    "新建会话按这里播种（提供商 / 模型 / 思考强度 / 预设）",
    "（点击任一格配置该服务商；网格顺序即使用优先级，越靠前越优先）",
  ];
  const left = gone.filter(
    (k) => SETTINGS.indexOf(k) >= 0 || I18N.indexOf('"' + k) >= 0,
  );
  ok(left.length === 0, "已删说明文字在源码与词条里都不再出现" + (left.length ? " 残留：" + left.join(" | ") : ""));
  has(
    I18N,
    '"默认模型还没设置：请到 设置 · 默认模型 里选一只模型',
    "指路文案已改到新位置（设置 · 默认模型）",
  );
  ok(
    I18N.indexOf("设置 · 智能能力 · 默认模型") < 0,
    "旧的指路文案（设置 · 智能能力 · 默认模型）已全部改名",
  );
}

console.log(
  "\n" + (fails ? "FAILED " + fails + " / " + checks + " checks" : "ALL OK  " + checks + " checks"),
);
process.exitCode = fails ? 1 : 0;
