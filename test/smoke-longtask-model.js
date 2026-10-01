"use strict";
/**
 * test/smoke-longtask-model.js —— 长任务画布界面的「当前模型 / 预设」与模型误选修
 *
 * 本轮修的是「模型选择会误选」：长任务侧的模型格原先用**裸模型 id** 取值，
 * 回显 / ✓ 走 routeOfModel(裸 id) 反查 —— 跨服务商出现同名模型时反查只命中第一组，
 * 于是「选 B 家 → 悄悄落到 A 家路由」，界面 ✓ 也标错分组；「跟随默认」的提示又拿
 * modelsOf(route)[0] 冒充默认模型、空 provider 一路被 dshRunTask / newAgentSession
 * 兜成 deepseek-official，显示与生效彻底不同源。
 *
 * 断言按层排（沿用 smoke-longtask.js 的风格：能真跑的绝不只 grep）：
 *   [1] 成对编码：「路由|模型」拼 / 拆 / 反查（把 app-longtask-ctl.js 整份装进 vm 真跑）
 *   [2] 下拉控件真跑：给一只极简假 DOM，验证 ✓ 只标在真正所属的服务商分组，
 *       裸 id（老数据）不冒充命中任一组，setHint 就地换行
 *   [3] 界面接线：检查器 / 创建窗的模型格吃成对编码、选中即 provider+model 成对写回
 *   [4] 引擎真跑：cfg 全空 = 用户当前选择；伪节点 / 本轮 dsh 选型不再被兜成 deepseek-official
 *   [5] 词条：新加的 i18n 中英齐备（切英文不出现中文半截）
 * 只读断言：不改任何文件、不起 Electron。
 */
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os"), childProcess = require("child_process");
const SHARED = { fs, path, vm, os, spawn: childProcess.spawn };
const TEST_DIR = __dirname;
let MERGED_FAILED = false;

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, ...rel.split("/")), "utf8");

let fails = 0;
let checks = 0;
const ok = (cond, msg) => {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
};
const has = (hay, needle, msg) => {
  const c = String(hay).indexOf(needle) >= 0;
  ok(c, msg + (c ? "" : "（缺 " + JSON.stringify(needle) + "）"));
};
const hasnt = (hay, needle, msg) => {
  const c = String(hay).indexOf(needle) < 0;
  ok(c, msg + (c ? "" : "（仍含 " + JSON.stringify(needle) + "）"));
};
const eqNum = (a, b, msg) => ok(a === b, msg + "（得到 " + JSON.stringify(a) + "，期望 " + JSON.stringify(b) + "）");
const eqStr = (a, b, msg) => ok(String(a) === String(b), msg + "（得到 " + JSON.stringify(a) + "，期望 " + JSON.stringify(b) + "）");

const CTL = read("renderer/app-longtask-ctl.js");
const LTU = read("renderer/app-longtask-ui.js");
const LTC = read("renderer/app-longtask-create.js");
const LTV = read("renderer/app-longtask.js");
const LTCSS = read("renderer/css/longtask.css");
const I18N = read("renderer/i18n.js");
const APP = read("renderer/app.js");

/* ═══════════════ 假 DOM（只够跑 ltSelField 这一条路径） ═══════════════ */
function mkEl(tag) {
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    className: "",
    hidden: false,
    value: "",
    placeholder: "",
    type: "",
    autocomplete: "",
    spellcheck: true,
    attrs: {},
    handlers: {},
    children: [],
    _text: "",
    appendChild(c) {
      el.children.push(c);
      return c;
    },
    setAttribute(k, v) {
      el.attrs[k] = String(v);
    },
    addEventListener(k, fn) {
      (el.handlers[k] = el.handlers[k] || []).push(fn);
    },
    select() {},
    scrollIntoView() {},
    contains() {
      return false;
    },
    closest() {
      return null;
    },
  };
  const parts = () => String(el.className || "").split(/\s+/).filter(Boolean);
  el.classList = {
    add(...c) {
      const s = parts();
      for (const x of c) if (s.indexOf(x) < 0) s.push(x);
      el.className = s.join(" ");
    },
    remove(...c) {
      el.className = parts().filter((x) => c.indexOf(x) < 0).join(" ");
    },
    contains(c) {
      return parts().indexOf(c) >= 0;
    },
    toggle(c, force) {
      const had = el.classList.contains(c);
      const want = force === undefined ? !had : !!force;
      if (want && !had) el.classList.add(c);
      else if (!want && had) el.classList.remove(c);
      return want;
    },
  };
  Object.defineProperty(el, "childElementCount", { get: () => el.children.length });
  Object.defineProperty(el, "textContent", {
    get: () => el._text,
    set(v) {
      el._text = v == null ? "" : String(v);
      el.children.length = 0; /* 与真 DOM 同口径：写 textContent 会清掉子节点 */
    },
  });
  return el;
}
const mkFakeDoc = () => ({ createElement: mkEl, activeElement: null, addEventListener() {}, getElementById() { return null; } });
const hasClass = (el, cls) => String((el && el.className) || "").split(/\s+/).indexOf(cls) >= 0;
const childByClass = (el, cls) => ((el && el.children) || []).filter((c) => hasClass(c, cls))[0] || null;
/* 选项行文本：按渲染出来的真实 DOM 取（label / hint / ✓ 三格） */
function optsOf(pop, groupLabel) {
  let label = "";
  const out = [];
  for (const ch of pop.children) {
    if (hasClass(ch, "lt-sel-g")) {
      label = ch.textContent;
      continue;
    }
    if (hasClass(ch, "lt-sel-grp") && label === groupLabel) {
      for (const op of ch.children) {
        const ol = childByClass(op, "lt-sel-ol");
        const oh = childByClass(op, "lt-sel-oh");
        const ck = childByClass(op, "lt-sel-ck");
        out.push({ label: ol ? ol.textContent : "", hint: oh ? oh.textContent : "", mark: ck ? ck.textContent : "" });
      }
    }
  }
  return out;
}
const marksOf = (pop) => {
  let label = "";
  const hits = [];
  for (const ch of pop.children) {
    if (hasClass(ch, "lt-sel-g")) {
      label = ch.textContent;
      continue;
    }
    if (hasClass(ch, "lt-sel-grp")) {
      for (const op of ch.children) {
        const ck = childByClass(op, "lt-sel-ck");
        if (ck) hits.push(label + "/" + ck.textContent);
      }
    }
  }
  return hits;
};

/* ═══════════════ [1][2] 控件工厂：同一个沙箱 ═══════════════ */
/* 两家服务商各有一只同名模型 shared —— 误选修的现场就是这个形状 */
const GROUPS = [
  { id: "prov-a", name: "A家", models: ["shared", "a-only"] },
  { id: "prov-b", name: "B家", models: ["shared", "b-only"] },
];
function mkCtlSandbox(extra) {
  const sandbox = {
    window: {},
    document: mkFakeDoc(),
    devAgentModelGroups: () => JSON.parse(JSON.stringify(GROUPS)),
    preferredAgentProviderRoute: () => "prov-b",
    preferredAgentModelForRoute: (r) => (r === "prov-b" ? "b-only" : ""),
    AGENT_PRESETS: [{ id: "standard", labelKey: "标准预设" }, { id: "lean", labelKey: "精简预设" }],
    AGENT_EFFORT_UI_ORDER: ["low", "medium", "high"],
    AGENT_EFFORT_ORDER: ["low", "medium", "high", "xhigh", "max"],
    AGENT_EFFORT_LABELS: { low: "低", medium: "中", high: "高" },
    AGENT_PRESET_DEFAULT: "standard",
    S: { assistPreset: "lean", assistEffort: "low" },
    I18n: { t: (s) => s },
    console,
  };
  Object.assign(sandbox, extra || {});
  vm.createContext(sandbox);
  vm.runInContext(CTL, sandbox, { filename: "renderer/app-longtask-ctl.js" });
  return sandbox;
}
const cs = mkCtlSandbox();
const ctl = cs.window.LT && cs.window.LT.ui && cs.window.LT.ui.ctl;

console.log("\n[1] 「路由|模型」成对编码：拼 / 拆 / 反查（真跑 app-longtask-ctl.js）");
ok(!!ctl, "控件工厂整份执行并挂上 window.LT.ui.ctl");
ok(!!ctl && typeof ctl.agentOpts === "function", "agentOpts() 出口在（模型清单唯一真源）");
const AO = ctl.agentOpts();

eqStr(AO.keyOf("prov-b", "shared"), "prov-b|shared", "keyOf 拼出「路由|模型」成对编码");
eqStr(AO.keyOf("prov-b", ""), "", "keyOf 缺一半 → 空（不会拼出「prov-b|」这种半截 key）");
eqStr(AO.keyOf("", "shared"), "", "keyOf 缺路由 → 空");
{
  const sp = AO.splitKey("prov-b|shared");
  eqStr(sp.provider, "prov-b", "splitKey 拆出路由 = prov-b（选第二家不会被拨回第一家）");
  eqStr(sp.model, "shared", "splitKey 拆出模型 = shared（落盘仍是裸 id）");
  const bare = AO.splitKey("shared");
  eqStr(bare.provider, "", "splitKey 遇裸 id：路由留空，交给调用方兜底（不当成已知归属）");
  eqStr(bare.model, "shared", "裸 id 的模型部分原样保留");
  const empty = AO.splitKey("");
  ok(empty.provider === "" && empty.model === "", "splitKey(\"\") 给空对（不会崩、也不会编一个路由）");
}
{
  const vals = [];
  for (const g of AO.modelGroups) for (const it of g.items) if (it.label === "shared") vals.push(it.value);
  eqNum(vals.length, 2, "两家服务商的同名模型在清单里各占一项");
  eqNum(new Set(vals).size, 2, "两项 value 不同（prov-a|shared / prov-b|shared）—— 同 id 不再同值");
  eqStr(vals.join(","), "prov-a|shared,prov-b|shared", "value 就是「路由|模型」，与 app.js 的 wfBuildAgentPicker 同口径");
  const gb = AO.modelGroups.filter((g) => g.group === "B家")[0] || { items: [] };
  ok(gb.items.every((it) => it.hint === "B家"), "每项 hint 带服务商名（下拉里一眼看得出归属，也能按服务商名搜）");
}
eqStr(AO.routeOfModel("prov-b|shared"), "prov-b", "routeOfModel 承认对编码：入参已是「路由|模型」就直接取路由部分");
eqStr(AO.routeOfModel("shared"), "prov-a", "裸 id 反查仍只命中第一组（prov-a）—— 所以它不能当模型格的真源，这正是误选的老路径");
eqStr(AO.modelForRoute("prov-b"), "b-only", "modelForRoute 先问真源 preferredAgentModelForRoute（认得用户当前选的模型），不是清单首项");
eqStr(AO.modelForRoute("prov-a"), "shared", "真源没给值时退回该路由清单首个（不给假默认）");
eqStr(AO.defaults.route, "prov-b", "defaults.route = 用户当前选的路由");
eqStr(AO.defaults.model, "b-only", "defaults.model = 用户当前选的模型（不是清单首项）");
eqStr(AO.defaults.preset, "lean", "defaults.preset 取自 S.assistPreset（与会话同源）");
eqStr(AO.defaults.effort, "low", "defaults.effort 取自 S.assistEffort（与会话同源）");
eqStr(AO.defaultText(), "B家 · b-only", "defaultText 说的就是真正生效的那一份");
{
  const csOff = mkCtlSandbox({ S: { assistPreset: "lean", assistEffort: "off" } });
  const AOoff = csOff.window.LT.ui.ctl.agentOpts();
  eqStr(AOoff.defaults.effort, "", "思考强度不在引擎落盘白名单（off）→ 留空，不在提示里承诺一个写不进盘的档");
}
has(CTL, "p && m ? p + \"|\" + m : \"\"", "分隔符口径写死在 ltaKeyOf（一处真源）");
has(APP, "g.id + \"|\" + m", "app.js 的 wfBuildAgentPicker 用同一个「路由|模型」口径（两处可互认）");

console.log("\n[2] 模型下拉真跑：✓ 只标在真正所属的分组（跨服务商同名模型不误标）");
{
  const fdoc = mkFakeDoc();
  const cs2 = mkCtlSandbox({ document: fdoc });
  const ctl2 = cs2.window.LT.ui.ctl;
  const AO2 = ctl2.agentOpts();
  const host = fdoc.createElement("div");
  const picked = [];
  const handle = ctl2.ltSelField(host, "模型", "prov-b|shared", AO2.modelGroups, (v) => picked.push(v), {
    allowEmpty: true,
    emptyLabel: "跟随默认",
    hint: "跟随默认（当前 = …）",
  });
  const pop = childByClass(handle.el, "lt-sel-pop");
  ok(!!pop, "单选下拉建出来了（ltSelField 的 DOM 结构如预期）");
  handle.open();
  eqStr(handle.value(), "prov-b|shared", "控件按完整 key 记值（不是裸模型 id）");
  eqStr(handle.input.value, "shared", "输入框显示的是模型 label（用户看到的是模型名，不是编码）");
  eqStr(marksOf(pop).join(","), "B家/✓", "选 B 家：✓ 只出现在 B家 分组（旧版会标到 A家）");
  {
    const b = optsOf(pop, "B家");
    eqNum(b.length, 2, "B家 分组里两只模型都在");
    eqStr(b[0].label + "/" + b[0].hint + "/" + b[0].mark, "shared/B家/✓", "B家·shared 那一项就是被 ✓ 命中的项");
    eqStr(b[1].mark, "", "同组的 b-only 没有被误标");
    ok(optsOf(pop, "A家").every((o) => o.mark === ""), "A家 分组里一个 ✓ 都没有（同名模型不再互相冒领）");
  }
  handle.setValue("prov-a|shared", true);
  eqNum(picked.length, 0, "静默 setValue（回显刷新用）不触发回调（不把回填当用户选择写回）");
  handle.close();
  handle.open();
  eqStr(marksOf(pop).join(","), "A家/✓", "改成选 A 家的同名 shared：✓ 跟着挪到 A家（回显与选中值同源）");
  eqStr(handle.input.value, "shared", "换了一家，显示名仍是 shared（同名模型的可读性不受编码影响）");
  /* 老数据 / 只存了裸 id：不许冒充命中任何一组 */
  handle.setValue("shared", true);
  handle.close();
  handle.open();
  eqStr(marksOf(pop).join(","), "", "裸 id 不冒充命中任何分组（没有 ✓ 落在错的服务商上）");
  ok(hasClass(handle.el, "lt-sel-unknown"), "裸 id 命中不到时打 lt-sel-unknown（调用方据此提示/补成对，而不是假装选中）");
  /* 清空 = 跟随默认：✓ 落在「跟随默认」项上 */
  handle.setValue("", true);
  handle.close();
  handle.open();
  eqStr(marksOf(pop).join(","), "/✓", "清空 → ✓ 落在「跟随默认」项上（allowEmpty 的 head 组）");
  eqStr(handle.input.placeholder, "跟随默认", "清空后占位文案就是「跟随默认」");
  /* 提示行就地刷新（跟随默认指向谁，改完立刻重算） */
  const hintEl = childByClass(handle.root, "lt-fh");
  ok(!!hintEl, "提示行元素在（.lt-fh）");
  handle.setHint("跟随默认（当前 = B家 · b-only · 精简预设 · 低）");
  eqStr(hintEl.textContent, "跟随默认（当前 = B家 · b-only · 精简预设 · 低）", "setHint 就地换提示行（不让提示停在旧值上）");
  handle.setValue("prov-b|shared", false);
  eqStr(picked.join(","), "prov-b|shared", "非静默 setValue 按完整 key 回调（编码原样交给调用方拆）");
}

/* ═══════════════ [3] 界面接线 ═══════════════ */
console.log("\n[3] 检查器 / 创建窗：模型格吃成对编码，选中即 provider+model 成对写回");
has(LTU, "const ltNodeModelKey = (route, model) => {", "检查器有 ltNodeModelKey：模型格显示值现拼成对编码");
has(LTU, "const k = AO.keyOf(route, m);", "显示值走 keyOf（路由与模型一起编码）");
has(LTU, "ltNodeModelKey(node.cfg.provider, node.cfg.model),", "模型格初值 = 成对编码（回显不再拿裸 id 去反查）");
has(LTU, "const sp = AO.splitKey(key);", "模型格选中回调拆成对编码（模型语义只在 ctl 里）");
has(LTU, "const patch = { model: sp.model };", "写回的仍是裸模型 id（落盘结构零变化）");
has(LTU, "if (sp.provider && sp.provider !== String(node.cfg.provider || \"\")) patch.provider = sp.provider;", "选中即把 provider 与 model 一起拨正（选 B 家不会被静默落到 A 家）");
has(LTU, "if (patch.provider) hProv.setValue(patch.provider, true);", "服务商格同步回显新路由（右栏保焦不重建时也不显示错位）");
has(LTU, "if (hModel) hModel.setValue(keep ? ltNodeModelKey(v, m) : \"\", true);", "换路由后模型格按成对编码就地刷新");
has(LTU, "const keep = !(m && v && AO.modelsOf(v).indexOf(m) < 0);", "「模型不属于新路由就清空」的判据仍用该路由清单里的裸 id（不是反查）");
has(LTU, "if (!key) {", "清空模型格的路径单独分支：只清 model，不动用户已选的 provider");
has(LTU, "save({ model: \"\" });", "清空 = 跟随默认模型（provider 原样保留）");

has(LTC, "const ltcModelKey = (route, model) => {", "创建窗同一套：ltcModelKey 现拼成对编码");
has(LTC, "const k = AO.keyOf(route, m);", "创建窗显示值走 keyOf");
has(LTC, "ltcModelKey(cfg.provider, cfg.model),", "创建窗模型格初值 = 成对编码");
has(LTC, "const sp = AO.splitKey(key);", "创建窗选中回调拆成对编码");
has(LTC, "if (hs.provider) hs.provider.setValue(sp.provider, true);", "创建窗选中即同步服务商格");
has(LTC, "if (hs.model) hs.model.setValue(ltcModelKey(patch.provider, cfg.model), true);", "创建窗换路由后模型格就地刷新成对编码");
has(LTC, "hs[k].setValue(k === \"model\" ? ltcModelKey(cfg.provider, cfg.model) : cfg[k], true);", "静默回填时模型格现拼成对编码（落盘仍是裸 id）");
has(LTC, "if (m && patch.provider && AO.modelsOf(patch.provider).indexOf(m) < 0) patch.model = \"\";", "创建窗的「模型不属于新路由」判据同样用清单裸 id");
has(
  LTC,
  'const LTC_AGENT_FIELDS = ["provider", "model", "preset", "effort"];',
  "创建窗落盘白名单仍是那四个裸字符串（localStorage 结构零变化）",
);

console.log("\n[3b] 「跟随默认」提示 = 真正生效的当前选择（不是清单首项冒充）");
has(LTU, "\"跟随默认（当前 = {route} · {model} · {preset} · {effort}）\"", "检查器提示改成四件套（路由 · 模型 · 预设 · 思考强度）");
has(LTC, "\"跟随默认（当前 = {route} · {model} · {preset} · {effort}）\"", "创建窗提示同口径");
has(LTU, "(typeof AO.modelForRoute === \"function\" ? AO.modelForRoute(route) : \"\") ||", "检查器提示里的模型走 modelForRoute（认得用户当前选的模型）");
has(LTC, "(typeof AO.modelForRoute === \"function\" ? AO.modelForRoute(route) : \"\") ||", "创建窗提示里的模型同样走 modelForRoute");
has(LTU, "preset: optLabel(AO.presetOptions, node.cfg.preset || AO.defaults.preset) || ltT(\"默认预设\"),", "检查器提示里的预设来自 AO.defaults（S.assistPreset 同源）");
has(LTU, "effort: optLabel(AO.effortOptions, node.cfg.effort || AO.defaults.effort) || ltT(\"默认思考强度\"),", "检查器提示里的思考强度来自 AO.defaults（S.assistEffort 同源）");
has(LTC, "preset: optLabel(AO.presetOptions, cfg.preset || AO.defaults.preset) || ltcT(\"默认预设\"),", "创建窗提示里的预设同源");
has(LTC, "effort: optLabel(AO.effortOptions, cfg.effort || AO.defaults.effort) || ltcT(\"默认思考强度\"),", "创建窗提示里的思考强度同源");
{
  const uiSeg = LTU.slice(LTU.indexOf("const defHintText = () => {"), LTU.indexOf("const pickCfg = {", LTU.indexOf("const defHintText = () => {")));
  hasnt(uiSeg, "modelsOf(route)[0]", "检查器提示不再拿该路由清单首项冒充默认模型");
  const cSeg = LTC.slice(LTC.indexOf("const defHintText = () => {"), LTC.indexOf("/* 服务商 / 模型两格的提示行"));
  hasnt(cSeg, "modelsOf(route)[0]", "创建窗提示同样不再冒充");
}
hasnt(LTU, "\"跟随默认（当前 = {route} · {model}）\"", "检查器两件套旧提示已撤（不再只说路由 + 模型）");
hasnt(LTC, "\"跟随默认（当前 = {route} · {model}）\"", "创建窗两件套旧提示已撤");
has(LTU, "for (const h of hints) if (h && typeof h.setHint === \"function\") h.setHint(defHintText());", "四格任一改动后当场重算提示（不会停在旧值）");
has(LTC, "for (const h of hints) if (h && typeof h.setHint === \"function\") h.setHint(defHintText());", "创建窗同样即时重算提示");
has(CTL, "setHint(text) {", "setHint 落在控件工厂（通用「换一行字」，不认识模型语义）");
has(CTL, "本控件只做「换一行字」，不认识任何业务字段", "控件本体保持通用（不写死模型语义）");
has(CTL, "const routeOfModel = (m) => {", "反查工具 routeOfModel 保留（老调用方仍可用）");

console.log("\n[3c] 三处只读回显：同一份数据源（条带头 chip / 卡片摘要 / 检查器那一行）");
has(LTU, "function ltAgentSelRead(n, AO) {", "回显真源 ltAgentSelRead（cfg 写了用 cfg，留空取用户当前选择）");
has(LTU, "if (typeof ltAgentSelOf === \"function\") return ltAgentSelOf(n);", "回显直接问引擎的 ltAgentSelOf（不另写一套兜底）");
has(LTU, "function ltAgentOptsNow() {", "清单只从 ctl 的 agentOpts() 取（AGENTS 单源约定：不复制清单）");
has(LTU, "return C && typeof C.agentOpts === \"function\" ? C.agentOpts() : null;", "ltAgentOptsNow 就是 C.agentOpts() 的取用口");
hasnt(LTU, "devAgentModelGroups(", "条带界面不自己去拉模型清单（单源）");
has(LTU, "lt-chip lt-chip-model", "① 条带头有模型信息 chip（ltRenderHead）");
/* 本次需求：chip 从「只读回显」变成「选型入口」——title 不再事后 .title = 赋值，而是随
     ltBtn 的第 4 个入参一起传：完整读数（ltAgentSelText）+ 一句「点这里改选型」的口径说明。 */
  has(LTU, 'ltAgentSelText(selHead, AOhead) + ltT("　点这里改选型', "chip 的 title = 完整「本轮模型：路由 · 模型 · 预设 · 思考强度」+ 点这里改选型的口径");
has(LTU, "n.kind === \"agent\" ? ltAgentModelShort(ltAgentSelRead(n, null).model, Math.min(18, Math.floor(cols / 2)))", "② 图内 agent 卡片摘要带该环生效模型短名（预算 = 最多半行）");
has(LTU, "const mFit = (s) => fit(mTag ? mTag + \" · \" + s : s);", "短名占的是已有那一行摘要的前缀（不新增行）");
has(LTU, "return Math.max(base, 70 + rows * 14);", "ltNodeRenderH 的 70 + N×14 口径未动（连线端点几何零变化）");
has(LTU, "const ltInspAO = node.kind === \"agent\" ? ltAgentOptsNow() : null;", "③ 检查器顶部那一行：agent 环节才取回显");
has(LTU, "if (ltInspAO) box.appendChild(ltEl(\"div\", \"lt-insp-model\", ltAgentSelLine(node, ltInspAO)));", "检查器顶部插一行 .lt-insp-model");
has(LTU, "const AO = ltInspAO;", "四只下拉复用顶部那一份清单（不重复取第二份）");
has(LTU, "const mark = (k) => (String(cfg[k] || \"\").trim() ? \"\" : ltT(\"（跟随默认）\"));", "留空的字段就地标「（跟随默认）」（分得清自己写的与跟默认跑的）");
has(LTU, "route: p.route + mark(\"provider\"),", "四个字段各自标来源");
has(LTCSS, ".lt-chip-model {", "chip 样式在 renderer/css/longtask.css（.lt-* 前缀）");
has(LTCSS, ".lt-insp-model {", "检查器那一行的样式在同一个样式表");
has(LTCSS, "#c792ea", "chip 用 AI 紫（与状态 chip 的橙/青/绿/红分开）");
has(LTCSS, ".lt-chip-model:hover,", "chip 有 hover 态（可点件口径：与 [data-hover] 并排写，头部重建后悬停标不闪）");
  has(LTCSS, ".lt-chip-model.on {", "面板开着时 chip 亮边（与其它头部下拉同款「这里开着」提示）");
  has(LTCSS, "cursor: pointer;", "chip 是可点件（cursor:pointer）");

  /* ── 本次需求：chip 就是选型入口（点它开四格面板，不必先下钻某一环再翻检查器）─────────
     锚点身份 data-lt-menu="lt-model" 是它能在头部 ~90ms 一次的重建中活下来的唯一原因：
     重建后 ltMenuReadopt 认回新 chip 并重新贴位，认不到才收。 */
  has(LTU, 'chip.setAttribute("data-lt-menu", "lt-model")', "chip 写下自己的锚点身份（头部重建后由 ltMenuReadopt 认回来）");
  has(LTU, "ltAgentPanelOpen(wf, chip)", "点 chip 的落点 = ltAgentPanelOpen（界面上唯一开面板处）");
  has(LTU, "if (ltMenuIsOpen(chip)) {", "再点一次自身即收（与其它头部下拉同一手感）");
  has(LTU, "function ltAgentPanelOpen(wf, chip) {", "面板本体 ltAgentPanelOpen");
  has(LTU, "ltAgentNodes(task)", "环节清单来自 ltAgentNodes（含子图 / 逐项并行，任意层深）");
  has(LTU, "C.ltSelField(", "四格复用 ctl 的 ltSelField（不复制一份控件）");
  has(LTU, "ltAgentFillBlank(task, key, value)", "改动写回只落「还留空」的环节（ltAgentFillBlank）");
  has(LTU, "ltMenuOpen(chip, [{ el: box }]);", "面板作为自定义内容块挂进瞬时菜单（不另造一套浮层）");
  has(LTU, 'const box = ltEl("div", "lt-mdl");', "面板根节点 .lt-mdl（样式进 longtask.css）");
  has(LTCSS, ".lt-mdl {", "面板样式 .lt-mdl 在 longtask.css");
  has(LTCSS, ".lt-mdl-h {", "面板抬头样式 .lt-mdl-h（AI 紫，与 chip 同色）");
  has(LTCSS, ".lt-mdl .lt-sel-pop {", "面板内下拉清单单独给高度（浮层里也不被裁）");

/* ═══════════════ [4] 引擎真跑：cfg 全空 = 用户当前选择 ═══════════════ */
async function main() {
  console.log("\n[4] 引擎真跑：ltAgentSelOf / ltPseudoNode 不再被兜成 deepseek-official");
  const sandbox = {
    window: { api: { dshInteract() {} } },
    S: { wf: null, config: {}, assistPreset: "lean", assistEffort: "low", agentActiveId: "" },
    I18n: { t: (s) => s },
    document: { readyState: "loading", addEventListener() {}, getElementById() { return null; } },
    toast() {},
    scheduleSave() {},
    renderCanvas() {},
    focusNode() {},
    addNode() { return null; },
    preferredAgentProviderRoute: () => "prov-b",
    preferredAgentModelForRoute: (r) => (r === "prov-b" ? "b-only" : ""),
    AGENT_PRESET_DEFAULT: "standard",
    AGENT_EFFORT_ORDER: ["low", "medium", "high", "xhigh", "max"],
    console,
    setTimeout,
    clearTimeout,
    Map,
    Set,
    Promise,
    JSON,
    Math,
    Date,
    Object,
    Array,
    String,
    Number,
    RegExp,
  };
  vm.createContext(sandbox);
  vm.runInContext(LTV, sandbox, { filename: "renderer/app-longtask.js" });
  ok(typeof sandbox.ltAgentSelOf === "function", "引擎脚本整份执行，ltAgentSelOf 可调用");
  {
    const sel = sandbox.ltAgentSelOf({ kind: "agent", cfg: {} });
    eqStr(sel.provider, "prov-b", "cfg 全空 → provider = 用户当前选择（不是空值、更不是 deepseek-official）");
    eqStr(sel.model, "b-only", "cfg 全空 → model = 用户当前选的模型");
    eqStr(sel.preset, "lean", "cfg 全空 → preset = 当前预设（S.assistPreset 同源）");
    eqStr(sel.effort, "low", "cfg 全空 → effort = 当前思考强度（S.assistEffort 同源）");
  }
  {
    const sel = sandbox.ltAgentSelOf({ kind: "agent", cfg: { provider: "prov-a", model: "a-only", preset: "standard", effort: "high" } });
    eqStr([sel.provider, sel.model, sel.preset, sel.effort].join("|"), "prov-a|a-only|standard|high", "cfg 写了的一律照用（留空才跟随默认）");
  }
  {
    sandbox.S.assistEffort = "off";
    eqStr(sandbox.ltAgentSelOf({ cfg: {} }).effort, "", "思考档 off 不在引擎落盘白名单 → 留空（不写一个会被洗掉的值）");
    sandbox.S.assistEffort = "low";
  }
  {
    const pn = sandbox.ltPseudoNode({ runId: "r1" }, "a", { title: "起草", cfg: {} });
    eqStr(pn.provider, "prov-b", "伪节点显式写出 provider = 用户当前选择（留空不再往下传）");
    ok(pn.provider !== "deepseek-official", "伪节点的 provider 不是硬编码的 deepseek-official（误选的根因已断）");
    eqStr(pn.model, "b-only", "伪节点写出 model");
    eqStr(pn.preset, "lean", "伪节点写出 preset");
    eqStr(pn.effort, "low", "伪节点写出 effort");
    const pn2 = sandbox.ltPseudoNode({ runId: "r1" }, "a", { title: "起草", cfg: { provider: "prov-a", model: "a-only" } });
    eqStr(pn2.provider, "prov-a", "cfg 写了的 provider 原样进伪节点");
  }
  has(LTV, "const sel = ltAgentSelOf(gNode);", "ltPseudoNode 的选型只有这一个出口（不各自读一遍 raw cfg）");
  has(LTV, "provider: sel.provider,", "伪节点把 provider 显式写出来");
  has(LTV, "const sel = ltAgentSelOf(node);", "ltBindAgentSession 走同一份选型");
  has(LTV, "provider: eff.provider,", "建会话时显式写死当前选择（不给 newAgentSession 的兜底留口子）");
  has(LTV, "} else if (eff.provider && String(st.provider || \"\") !== String(eff.provider)) {", "复用旧会话（当初靠兜底建的）时与伪节点对齐 provider");
  has(LTV, "model: pn.model || undefined,", "本轮 dsh 选型取伪节点那份（model）");
  has(LTV, "provider: pn.provider || undefined,", "本轮 dsh 选型取伪节点那份（provider，不再走 provider || \"deepseek-official\"）");
  has(LTV, "preset: pn.preset || undefined,", "本轮 dsh 选型取伪节点那份（preset）");
  has(LTV, "effort: pn.effort || undefined,", "本轮 dsh 选型取伪节点那份（effort）");
  hasnt(LTV, "provider: pn.provider || \"deepseek-official\"", "dshOpts 里没有 deepseek-official 硬兜底");

  console.log("\n[5] i18n：新增词条中英齐备（切英文不出现中文半截）");
  const I17 = require("../renderer/i18n.js");
  const keys = [
    "跟随默认（当前 = {route} · {model} · {preset} · {effort}）",
    "默认预设",
    "默认思考强度",
    "默认路由",
    "本轮模型：{route} · {model} · {preset} · {effort}",
    "（跟随默认）",
    "模型",
    /* 本次需求：chip 的选型面板（app-longtask-ui.js · ltAgentPanelOpen）新增的文案 */
    "这一轮跑哪只模型（共 {n} 个 Agent 环节）",
    "改动即写回本任务全部 Agent 环节（含子图）里还留空的那几个；某一环单独指定过，就去检查器里改它",
    "　点这里改选型（改动即写回本任务全部 Agent 环节（含子图）里还留空的那几个）",
    "已把 {field} 写进 {n} 个 Agent 环节（原来留空的那几个）",
    "{field}：本任务没有留空的环节（都各自指定过，去检查器里改）",
    "这只模型属于「{route}」：先把上面的服务商 / 路由改成它，再选模型",
    "模型选型控件未就绪",
    "服务商 / 路由",
    "预设",
    "思考强度",
  ];
  I17.setLocale("en");
  const miss = keys.filter((k) => I17.t(k) === k);
  eqNum(miss.length, 0, "i18n 中英词条齐备" + (miss.length ? "（缺：" + miss.join(" / ") + "）" : ""));
  eqStr(
    I17.t("本轮模型：{route} · {model} · {preset} · {effort}", { route: "R", model: "M", preset: "P", effort: "E" }),
    "Model this round: R · M · P · E",
    "英文词条的占位符能整句替换（栏头 chip 的 title）",
  );
  eqStr(
    I17.t("跟随默认（当前 = {route} · {model} · {preset} · {effort}）", { route: "R", model: "M", preset: "P", effort: "E" }),
    "Follow default (currently R · M · P · E)",
    "「跟随默认（当前 = …）」英文替换正确（检查器 / 创建窗提示行）",
  );
  /* 面板里的两条带占位符的文案（写回条数 / 误配路由的提示）也要能整句替换 */
  eqStr(
    I17.t("已把 {field} 写进 {n} 个 Agent 环节（原来留空的那几个）", { field: "模型", n: 2 }),
    "Wrote 模型 into 2 agent step(s) that were left empty",
    "面板写回 toast 的占位符能整句替换（切英文不出现中文半截）",
  );
  eqStr(
    I17.t("这一轮跑哪只模型（共 {n} 个 Agent 环节）", { n: 3 }),
    "Which model this round runs (across 3 agent steps)",
    "面板抬头的占位符能整句替换",
  );
  I17.setLocale("zh");
  for (const k of keys) has(I18N, '"' + k + '"', "i18n 源文件里有「" + k + "」的词条");

  console.log("\n" + (fails ? "FAIL" : "PASS") + "  smoke-longtask-model：" + checks + " 项，" + fails + " 项失败");
}
main();

/* ==================== 已并入：test/smoke-longtask-shell.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-longtask-shell.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

  const fs = require("fs");
  const path = require("path");
  const vm = require("vm");

  const ROOT = path.join(__dirname, "..");
  const read = (rel) => fs.readFileSync(path.join(ROOT, ...rel.split("/")), "utf8");
  const exists = (rel) => fs.existsSync(path.join(ROOT, ...rel.split("/")));

  let fails = 0;
  let checks = 0;
  const ok = (cond, msg) => {
    checks++;
    if (cond) console.log("  ok    " + msg);
    else {
      fails++;
      console.log("FAIL  " + msg);
    }
  };
  const has = (hay, needle, msg) => {
    const c = String(hay).indexOf(needle) >= 0;
    ok(c, msg + (c ? "" : "（缺 " + JSON.stringify(needle) + "）"));
  };
  const hasnt = (hay, needle, msg) => {
    const c = String(hay).indexOf(needle) < 0;
    ok(c, msg + (c ? "" : "（仍含 " + JSON.stringify(needle) + "）"));
  };
  const eqNum = (a, b, msg) => ok(a === b, msg + "（得到 " + JSON.stringify(a) + "，期望 " + JSON.stringify(b) + "）");

  const APP = read("renderer/app.js");
  const CANVASJS = read("renderer/app-canvas.js");
  const LTCSS = read("renderer/css/canvas.css");
  const I18N_SRC = read("renderer/i18n.js");
  const HTML = read("renderer/index.html");
  const LTV = read("renderer/app-longtask.js");
  const LTUI = read("renderer/app-longtask-ui.js");
  const LTARTJS = read("renderer/app-longtask-artifacts.js");
  const SHELLJS = read("renderer/app-longtask-shell.js");
  const MANUAL = read("guides/manual/longtask.md");
  const MANUAL_EN = read("guides/manual/en/longtask.md");
  const LTSH_EXPORT_OK = SHELLJS.slice(SHELLJS.indexOf("window.LTSHELL"));

  /* ══════════════ [1] 装配与文档（静态） ══════════════ */
  console.log("\n[1] 装配：加载顺序 / 落点委派 / 画布壳标记与徽标 / css / i18n / 手册");
  has(HTML, '<script src="app-longtask-shell.js"></script>', "index.html 引入 app-longtask-shell.js");
  ok(
    HTML.indexOf('src="app-longtask.js"') < HTML.indexOf('src="app-longtask-shell.js"') &&
      HTML.indexOf('src="app-longtask-artifacts.js"') < HTML.indexOf('src="app-longtask-shell.js"'),
    "加载顺序在 app-longtask.js 与 app-longtask-artifacts.js 之后（用到登记层与 makeNode）",
  );
  has(LTV, "function ltShellOutputPlace(", "产出落点走单一委派入口（引擎只认 window.LTSHELL）");
  has(LTV, "function ltShellArtifactsParent(", "产物落点同一套委派");
  has(LTSH_EXPORT_OK, 'presetGen: ltsPresetGen', "生成工作流预置由壳模块导出（引擎只按判空调用它）");
  has(LTV, 'sh.outputFinalize(run, path, node)', "产出节点建好后交给壳模块改落点");
  has(LTV, "ltShellOutputPlace(run, path, node);", "已有产出节点（重跑 / 旧档）也对齐落点");
  has(LTARTJS, "ltShellArtifactsParent(run, path, node);", "产物节点建好后交给壳模块改落点");
  has(LTARTJS, "if (typeof ltShellArtifactsParent === \"function\")", "壳模块缺席时按全局判空跳过（回落主画布层）");
  hasnt(LTARTJS, "产物一律摆在主画布层", "旧的「产物一律摆主画布层」注释已改（新口径 = 落环节子壳）");
  has(CANVASJS, 'el.classList.add("lt-shell")', "画布给长任务壳打 .lt-shell 标记");
  has(CANVASJS, 'ltChip.className = "n-chip n-chip-lt"', "壳头部摆一枚只读「长任务 / 环节壳」徽标");
  has(CANVASJS, 'I18n.t("长周期任务的产出壳：")', "徽标 tooltip 说明这是长任务的产出壳");
  has(LTCSS, ".wf-node.super.lt-shell {", "长任务壳有专属色外框");
  has(LTCSS, ".n-chip.n-chip-lt {", "徽标有专属色");
  has(LTCSS, "body.theme-light .wf-node.super.lt-shell", "浅色主题同口径");
  has(I18N_SRC, '"长任务": "Long task"', "i18n 有「长任务」词条且英文成对");
  has(I18N_SRC, '"环节壳": "Step shell"', "i18n 有「环节壳」词条");
  has(I18N_SRC, '"需要生成内容": "Needs generated content"', "i18n 有「需要生成内容」词条");
  has(I18N_SRC, '"生成类型": "Generation types"', "i18n 有「生成类型」词条");
  has(I18N_SRC, "Created this task's super node on the canvas", "英文词条成对（切英文不回中文）");
  has(LTUI, 'ltT("需要生成内容")', "条带检查器有「需要生成内容」勾选（用户可改）");
  has(LTUI, 'ltT("生成类型")', "条带检查器有「生成类型」多选");
  has(LTV, "out.needsGen = !(c.needsGen === false", "ltNormCfg 归一 needsGen（缺省勾上，显式 false 才是关）");
  has(LTV, '["image", "video", "music", "tts"].indexOf(s) >= 0', "ltNormCfg 归一 genTypes（只认四种生成类型）");
  has(LTV, "只清掉壳上的任务绑定字段", "删任务时只清绑定、保留壳与内容");
  has(LTUI, 'ltT("重建壳")', "壳被删后条带「⋯ 更多」里才出现「重建壳」入口（显式恢复，不是静默重长）");
  has(LTUI, "if (needShell)", "重建入口只在墓碑落在本轮 run 上时出现");
  has(MANUAL, "超级节点", "应用内手册写明超级节点壳口径");
  has(MANUAL, "一律不运行", "手册写明生成工作流只建不跑");
  has(MANUAL_EN, "super-node shell", "英文手册同步（AGENTS：手册中英成对）");
  has(read("guides/nodes/ltout.md"), "超级节点子壳", "产出节点指南写明落点在环节子壳");
  has(read("guides/nodes/en/ltout.md"), "super-node shell", "产出节点指南英文成对");
  has(read("guides/nodes/ltart.md"), "超级节点子壳", "产物节点指南写明落点在环节子壳");
  has(read("guides/nodes/en/ltart.md"), "super-node shell", "产物节点指南英文成对");
  has(read("guides/nodes/super.md"), "长任务壳", "超节点指南列入「长任务壳」这一特殊形态");
  has(read("guides/nodes/en/super.md"), "Long-task shell", "超节点指南英文成对");

  /* ═══════════════ [2][3] 真跑（vm） ═══════════════ */
  function buildSandbox() {
    const files = new Map();
    const setFile = (p, content) => files.set(String(p), { mtime: 1000, size: 100, content: content || "x" });
    let seq = 0;
    const S = { wf: { id: "wf-shell", nodes: [], wires: [], cam: { x: 0, y: 0, k: 1 }, workspace: "" }, config: {}, _skipCanvasHistory: false };
    const toasts = [];
    const sizes = {
      super: [280, 200],
      ltout: [360, 260],
      ltart: [260, 210],
      proc_image: [360, 200],
      video_gen: [400, 340],
      music_gen: [360, 300],
      tts_gen: [360, 300],
      control: [240, 140],
    };
    const sandbox = {
      window: {
        innerWidth: 1280,
        api: {
          fileStat: async (p) => {
            const f = files.get(String(p));
            return f ? { ok: true, mtime: f.mtime, size: f.size } : { ok: false, exists: false };
          },
          fileReadText: async (p) => {
            const f = files.get(String(p));
            return f ? { ok: true, exists: true, content: f.content } : { ok: false, exists: false };
          },
          toFileUrl: (p) => "file:///" + String(p || "").replace(/\\/g, "/"),
          ltRunSave: async () => ({ ok: true }),
          dshInteract: () => {},
        },
      },
      S: S,
      I18n: { t: (s) => s },
      document: { readyState: "loading", addEventListener() {}, getElementById() { return null; } },
      toast: (msg, kind) => toasts.push([msg, kind]),
      scheduleSave() {},
      renderCanvas() {},
      focusNode() {},
      pushHistory() {},
      closeAllNodePops() {},
      /* app.js 的 makeNode / addNode / uniqueNodeTitle 在沙箱里的等价物：
         本模块只依赖这三个建节点原语 + superChildrenOf（壳内子节点判定）。 */
      makeNode(kind, x, y) {
        const sz = sizes[kind] || [300, 200];
        return {
          id: "n" + ++seq,
          kind: kind,
          x: x,
          y: y,
          w: sz[0],
          h: sz[1],
          title: kind,
          parentSuperId: "",
          parentTaskId: "",
        };
      },
      addNode(kind, x, y, extra) {
        const n = sandbox.makeNode(kind, x, y);
        Object.assign(n, extra || {});
        S.wf.nodes.push(n);
        return n;
      },
      uniqueNodeTitle(desired, exceptId) {
        const base = String(desired || "").trim() || "节点";
        const taken = new Set(S.wf.nodes.filter((n) => n.id !== exceptId).map((n) => n.title));
        if (!taken.has(base)) return base;
        let i = 2;
        while (taken.has(base + " " + i)) i++;
        return base + " " + i;
      },
      addWire(from, to) {
        S.wf.wires.push({ id: "w" + S.wf.wires.length, from: from, to: to, toIndex: 0 });
      },
      superChildrenOf(id) {
        return S.wf.nodes.filter((n) => String(n.parentSuperId || "") === String(id));
      },
      console, setTimeout, clearTimeout, Map, Set, Promise, JSON, Math, Date, Object, Array, String, Number, RegExp,
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(LTV, sandbox, { filename: "renderer/app-longtask.js" });
    vm.runInContext(LTARTJS, sandbox, { filename: "renderer/app-longtask-artifacts.js" });
    vm.runInContext(SHELLJS, sandbox, { filename: "renderer/app-longtask-shell.js" });
    return { sandbox, S, files, setFile, toasts, seqOf: () => seq };
  }

  const AGENT_GRAPH = (title, cfg) => ({
    nodes: [
      { id: "start", kind: "start", title: "起点", cfg: {} },
      { id: "a1", kind: "agent", title: title, cfg: Object.assign({ goal: "写出这一环节的产物" }, cfg || {}) },
      { id: "end", kind: "end_ok", title: "完成", cfg: {} },
    ],
    edges: [
      { id: "e1", from: "start", to: "a1" },
      { id: "e2", from: "a1", to: "end" },
    ],
  });

  async function main() {
    const env = buildSandbox();
    const { sandbox, S, setFile, toasts } = env;
    const LT = sandbox.window.LT;
    const LTSH = sandbox.window.LTSHELL;
    ok(!!LT && !!LTSH, "三份脚本在同一沙箱里整份执行并导出 window.LT / window.LTSHELL（顶层不碰 DOM）");

    console.log("\n[2] 数据层真跑：创建期预建（只建不跑）/ 懒建壳 / 产出与产物落子壳 / 生成工作流预置（不跑）/ 布局 / 墓碑 / 迁移");

    /* ── ⓪ 创建期预建（本轮需求：创建即显示）：任务一经创建就把落点摆好，一律只建不跑 ──
       旧口径「跑到那一环才懒建」= 图上看得见图、画布上什么都没有；本轮改成创建即预建，
       懒建（ltsEnsure）退回运行期兜底与「壳被删」的墓碑口径。 */
    const made = LT.createFromGraph("演示任务", AGENT_GRAPH("写分镜"), S.wf);
    ok(made && made.ok, "先按正常路径落一张长任务图（任务条目进 wf.longtask，最后删任务那节要用）");
    const task = sandbox.ltTaskOf(S.wf, made.uid);
    const TID = String(task.uid);
    {
      has(SHELLJS, "function ltsEnsureForTask(wf, task) {", "壳模块有创建期预建口 ltsEnsureForTask");
      has(LTSH_EXPORT_OK, "ensureForTask: ltsEnsureForTask,", "LTSHELL.ensureForTask 已导出（引擎创建收尾按判空调用）");
      has(LTV, "function ltLandingCreate(wf, task) {", "引擎有预建总入口 ltLandingCreate（壳 / 生成工作流 + 交付节点）");
      has(LTV, "ltLandingCreate(wf, task);", "创建收尾（ltCreateFromGraph）真的调了预建总入口");
      {
        /* 源码级钉点：预建函数体里不许出现「跑」与「墓碑」的任何写法 ——
           只 makeNode + push，绝不调 runNode、绝不置 running、绝不写 run.shell* 字段。 */
        const body = SHELLJS.slice(
          SHELLJS.indexOf("function ltsEnsureForTask(wf, task) {"),
          SHELLJS.indexOf("/* ── ⑥ 壳被删的降级口径"),
        );
        ok(body.length > 500, "取到 ltsEnsureForTask 的真实现源码（下面三条静态断言才是有据可查）");
        hasnt(body, "runNode", "只建不跑：函数体里没有 runNode（一个生成都不代跑）");
        hasnt(body, "running", "也不置 running（预建的节点不显示成在跑）");
        hasnt(body, "shellGone", "不写墓碑（创建期没有 run，那套字段只属运行中的 run）");
      }
      eqNum(typeof LTSH.ensureForTask, "function", "window.LTSHELL.ensureForTask 在沙箱里可调用");
      eqNum(LTSH.graphPaths(AGENT_GRAPH("写分镜")).join(","), "start,a1,end", "同一份图路径清单给壳预建与交付预建共用（只列图定义路径）");
      const shells0 = S.wf.nodes.filter((n) => n.kind === "super");
      eqNum(shells0.length, 2, "创建那一刻父壳 + 环节子壳已经在画布上（不再等跑到那一环）");
      const root0 = shells0.find((n) => !String(n.ltShellPath || "").trim());
      const step0 = shells0.find((n) => String(n.ltShellPath || "") === "a1");
      ok(!!root0 && !!step0, "预建的父壳 / 环节子壳按 ltShellTask / ltShellPath 认得出身份");
      eqNum(String(root0.ltShellTask), TID, "父壳带任务身份（与运行时懒建同一套字段）");
      eqNum(String(step0.parentSuperId), String(root0.id), "环节子壳挂在预建的父壳里");
      const gens0 = S.wf.nodes.filter(
        (n) => String(n.parentSuperId || "") === String(step0.id) && n.ltGenType,
      );
      eqNum(gens0.length, 1, "按 cfg.genTypes 把生成节点一次摆好（缺省 = 图像一枚）");
      eqNum(String(gens0[0].kind), "proc_image", "类型 → kind 走壳模块同一份词汇表");
      const ctrl0 = S.wf.nodes.find(
        (n) => n.kind === "control" && String(n.parentSuperId || "") === String(step0.id),
      );
      ok(!!ctrl0 && String(ctrl0.ctrlRole) === "start", "控制 ▶ 一并建好（ctrlRole \"start\"）");
      ok(Number(ctrl0.y) < Number(gens0[0].y), "预建也守「控制靠上、生成靠下」的排版口径");
      ok(
        S.wf.wires.some((w) => w && w.from === ctrl0.id && w.to === gens0[0].id),
        "控制 ▶ 直连生成节点（控制流不走数据线，点下去才真的能触发）",
      );
      ok(!S.wf.nodes.some((n) => n.running || n.output), "预建一个都不跑：没有 running、也没有产出（不替用户烧额度）");
      ok(
        task.enabled === false && !String(task.activeRun || ""),
        "预建不改任务状态：enabled 仍 false、没有 run（开跑只由用户点「启用并绑定」）",
      );
      ok(!task.shellGone && !task.shellPaths, "创建期没有 run：不写墓碑、不碰 run.shell* 字段（那套字段只属运行中的 run）");
      /* 幂等：创建收尾与界面入口会重复叫它，第二次必须是空动作 */
      const before0 = S.wf.nodes.length;
      const again0 = LTSH.ensureForTask(S.wf, task);
      eqNum(S.wf.nodes.length, before0, "重复预建不重建（幂等：节点数逐字不变）");
      eqNum(again0.created, 0, "第二次 created = 0");
      eqNum(again0.skipped, true, "第二次 skipped = true（这一次什么都没建）");
      /* 启用后被「认领」而非重长：run 起来时 ltsEnsure 入口把画布上现存的壳登记进 run.shellPaths，
         于是「这一条路径建过没建过」有据可查，预建壳不会被误判成「用户删了壳」。 */
      const runClaim = sandbox.ltRunNew(task, "wf-shell", {});
      sandbox.ltInst(runClaim, "", runClaim.graph);
      const nBeforeClaim = S.wf.nodes.length;
      const claim = LTSH.ensure(runClaim, "a1");
      eqNum(claim.created, 0, "已预建的壳被认领：ensure 不新建任何壳（created = 0）");
      eqNum(S.wf.nodes.length, nBeforeClaim, "认领不动节点：不重长壳、也不重复摆生成工作流");
      ok(!!claim.root && !!claim.step, "认领返回的正是创建期预建的那两颗壳（按身份认人）");
      ok(
        !!runClaim.shellPaths && runClaim.shellPaths[""] === 1 && runClaim.shellPaths["a1"] === 1,
        "预建的壳按路径登记进 run.shellPaths（此后「删没删」按它判）",
      );
      /* 删了不偷偷重长（墓碑口径在预建壳上照旧）：认领之后用户把壳删掉 → 这一轮只提示不重建 */
      S.wf.nodes = S.wf.nodes.filter((n) => String(n.ltShellTask || "") !== TID);
      const goneClaim = LTSH.ensure(runClaim, "a1");
      eqNum(goneClaim.gone, true, "预建壳被用户删掉 → gone = true（绝不静默重长）");
      eqNum(S.wf.nodes.filter((n) => n.kind === "super").length, 0, "画布上没有被偷偷重建的壳");
      eqNum(runClaim.shellGone, true, "墓碑落在本 run 上（run.shellGone）");
      toasts.length = 0; /* 上面这条墓碑提示不算进 ⑤ 的「只提示一次」计数（那是另一个 run 的账） */
    }
    /* ── ⓪.5 本轮 bug：逐项（map）环节的实例路径不再一项一颗空壳 ──
       病根：跑到第 i 项时，这一项内部节点的路径带实例号（`shots@1/s_shot`，见 app-longtask.js
       的 ltPathKey / ltChildPrefix），而壳按 ltShellPath 一条路径一颗 —— 一份 12 项的清单就在
       画布上建出 12 颗彼此独立、且只有一颗有内容的空壳（清单 100 项 = 100 颗空壳）。
       口径：壳按**定义路径**认人（实例号 @i 一律脱掉），跑多少项都共用同一颗环节子壳。 */
    console.log("     · 逐项（map）实例：一份清单共用一颗环节子壳（不再一项一颗空壳）");
    {
      eqNum(LTSH.defPathOf("shots@1/s_shot"), "shots/s_shot", "壳定义路径口径：脱掉实例号（LTSHELL.defPathOf 已导出）");
      eqNum(LTSH.defPathOf("m@0/sub@3/step"), "m/sub/step", "嵌套实例也逐段脱（m@0/sub@3/step → m/sub/step）");
      eqNum(LTSH.defPathOf("plain/path"), "plain/path", "没带实例号的路径原样返回（幂等）");
      const MAPGRAPH = {
        nodes: [
          { id: "start", kind: "start", title: "起点", cfg: {} },
          { id: "a1", kind: "agent", title: "先写清单", cfg: { goal: "写出十二项清单" } },
          {
            id: "shots",
            kind: "map",
            title: "逐场备好生成工作流",
            cfg: {
              overKey: "shots_arr",
              itemKey: "item",
              outKeys: ["shot_file"],
              graph: {
                nodes: [
                  { id: "s_start", kind: "start", title: "起点", cfg: {} },
                  { id: "s_shot", kind: "agent", title: "备好这一场", cfg: { goal: "备好这一场的生成工作流" } },
                  { id: "s_end", kind: "end_ok", title: "完成", cfg: {} },
                ],
                edges: [
                  { id: "se1", from: "s_start", to: "s_shot" },
                  { id: "se2", from: "s_shot", to: "s_end" },
                ],
              },
            },
          },
          { id: "end", kind: "end_ok", title: "完成", cfg: {} },
        ],
        edges: [
          { id: "e1", from: "start", to: "a1" },
          { id: "e2", from: "a1", to: "shots" },
          { id: "e3", from: "shots", to: "end" },
        ],
      };
      const madeMap = LT.createFromGraph("逐项演示", MAPGRAPH, S.wf);
      ok(madeMap && madeMap.ok, "落一张带逐项（map）环节的长任务图（12 项清单）");
      const taskMap = sandbox.ltTaskOf(S.wf, madeMap.uid);
      const TIDM = String(taskMap.uid);
      /* 创建期预建：定义路径只有一条通往映射内部的路径（shots/s_shot）—— 子壳一颗 */
      const mapStepShells0 = S.wf.nodes.filter(
        (n) => n.kind === "super" && String(n.ltShellPath || "") === "shots/s_shot",
      );
      eqNum(mapStepShells0.length, 1, "创建期预建：逐项内部那一颗环节子壳只有一颗（按定义路径）");
      const runMap = sandbox.ltRunNew(taskMap, "wf-shell", {});
      sandbox.ltInst(runMap, "", runMap.graph);
      /* 真跑：12 个实例各自把内部节点发布一次产出 —— 老口径会在这里建出 12 颗壳 */
      const nodesBeforeMap = S.wf.nodes.length;
      const Q = "C:\\ws\\out\\shot-01.png";
      for (let i = 0; i < 12; i++) {
        const ip = "shots@" + i;
        sandbox.ltInst(runMap, ip, runMap.graph.nodes.find((n) => n.id === "shots").cfg.graph);
        setFile(Q);
        sandbox.ltStatePut(runMap, ip + "/s_shot", "shot_file", Q);
        await sandbox.ltOutputPublish(runMap, ip + "/s_shot", { text: "第 " + (i + 1) + " 场的正文" });
      }
      const mapShells = S.wf.nodes.filter(
        (n) => n.kind === "super" && String(n.ltShellTask || "") === TIDM,
      );
      const mapStepShells = mapShells.filter((n) => String(n.ltShellPath || "").trim());
      /* 环节子壳 = 图里三个环节（a1 / shots 这个逐项环节本身 / 它内部的 s_shot），
         不是「12 项各一颗」；老口径在这里会得到 1 + 1 + 12 = 14 颗。 */
      eqNum(mapStepShells.length, 3, "12 项跑完只有三颗环节子壳（a1 + 逐项环节本身 + 它内部那一颗），不是 14 颗");
      ok(
        mapStepShells.some((n) => String(n.ltShellPath || "") === "shots"),
        "逐项环节本身有自己的子壳（生成工作流摆在这里，用户点 ▶ 的那一层）",
      );
      ok(
        mapStepShells.every((n) => String(n.ltShellPath || "").indexOf("@") < 0),
        "壳上记的路径一律是定义路径（不带实例号 @i）",
      );
      const shotsShell = mapStepShells.find((n) => String(n.ltShellPath || "") === "shots/s_shot");
      ok(!!shotsShell, "逐项内部那一颗子壳按定义路径 shots/s_shot 认得出身份");
      eqNum(
        S.wf.nodes.filter((n) => String(n.parentSuperId || "") === String(shotsShell.id) && n.kind === "ltout").length,
        12,
        "12 项的产出全部落进同一颗子壳（一项一颗产出节点，各自带实例路径认人）",
      );
      eqNum(mapShells.length, 4, "整张图一共四颗壳：父壳 + a1 + 逐项环节本身 + 它内部的 s_shot（老口径：15 颗）");
      ok(
        Object.keys(runMap.shellPaths).every((p) => p.indexOf("@") < 0),
        "run.shellPaths 也按定义路径记（墓碑账本与壳一一对应，不错位）",
      );
      ok(
        Object.keys(runMap.shellPaths).indexOf("shots/s_shot") >= 0,
        "逐项内部那条路径在账本里只有一条（shots/s_shot）",
      );
      const nAfterMap = S.wf.nodes.length;
      const againMap = LTSH.ensure(runMap, "shots@11/s_shot");
      eqNum(againMap.created, 0, "第 12 项再发布一次：认领同一颗子壳，一个新节点都不建（幂等）");
      eqNum(S.wf.nodes.length, nAfterMap, "节点数不再随实例数增长（12 项跑完就这么多，再跑第 N 项也不加）");
      ok(
        nAfterMap - nodesBeforeMap < 20,
        "整轮只多了十来个节点（老口径：12 项各建一颗空壳 + 各自的生成/控制）",
      );
      /* 老现场收口：手工摆一颗当年那种「实例路径壳」（有内容）→ 合并进定义路径壳，节点一个不删 */
      {
        const legacy = sandbox.makeNode("super", 24, 24);
        legacy.ltShellTask = TIDM;
        legacy.ltShellPath = "shots@0/s_shot";
        legacy.title = "逐场备好生成工作流";
        S.wf.nodes.push(legacy);
        const legacyOut = sandbox.makeNode("ltout", 48, 48);
        legacyOut.ltShellTask = TIDM;
        legacyOut.ltShellPath = "shots@0/s_shot";
        legacyOut.parentSuperId = legacy.id;
        S.wf.nodes.push(legacyOut);
        const nBeforeFix = S.wf.nodes.length;
        const fixed = LTSH.ensure(runMap, "shots@3/s_shot");
        ok(!!fixed.step, "收口之后照常拿得到本环节子壳");
        ok(!S.wf.nodes.some((n) => n && n.id === legacy.id), "老现场的实例路径壳被合并掉（不再永远空着占地方）");
        ok(S.wf.nodes.some((n) => n && n.id === legacyOut.id), "壳里的节点一个不删（只搬不删，用户的资产还在）");
        eqNum(String(legacyOut.parentSuperId), String(shotsShell.id), "壳里的节点改挂到定义路径那颗子壳上");
        eqNum(S.wf.nodes.length, nBeforeFix - 1, "只少了那一颗重复壳（节点数 -1）");
        const fixedAgain = LTSH.ensure(runMap, "shots@3/s_shot");
        eqNum(S.wf.nodes.length, nBeforeFix - 1, "再跑一次零动作（收口幂等）");
        ok(!!fixedAgain.step, "幂等那一轮照样有壳可用");
      }
      /* 清掉这张演示任务的所有壳，别影响下面「创建期还没有落点」的老口径段落 */
      S.wf.nodes = S.wf.nodes.filter((n) => String(n.ltShellTask || "") !== TIDM || n.kind !== "super");
      S.wf.nodes = S.wf.nodes.filter((n) => String(n.ltTaskUid || "") !== TIDM);
      S.wf.wires.length = 0;
    }
    /* 清空画布，回到「创建期还没有落点」的现场：下面几条老口径（懒建 / 墓碑 / 迁移）照旧真跑 */
    S.wf.nodes.length = 0;
    S.wf.wires.length = 0;
    const run = sandbox.ltRunNew(task, "wf-shell", {});
    sandbox.ltInst(run, "", run.graph);
    eqNum(S.wf.nodes.filter((n) => n.kind === "super").length, 0, "还没有产出时画布上一颗壳都没有（懒建口径照旧）");
    const P = "C:\\ws\\out\\shot-01.png";
    setFile(P);
    sandbox.ltStatePut(run, "a1", "shot_file", P);
    await sandbox.ltOutputPublish(run, "a1", { text: "本环节正文", files: await sandbox.ltOutputPathsOf(run, "a1") });

    const shells = S.wf.nodes.filter((n) => n.kind === "super");
    eqNum(shells.length, 2, "父壳 + 环节子壳一起建出来（一环节一颗）");
    const root = shells.find((n) => !String(n.ltShellPath || "").trim());
    const step = shells.find((n) => String(n.ltShellPath || "") === "a1");
    ok(!!root && !!step, "能按 ltShellTask / ltShellPath 认出父壳与环节子壳");
    eqNum(String(root.ltShellTask), TID, "父壳带任务身份（绑定 = 数据绑定，不新建状态节点）");
    eqNum(root.title, "长任务 · 演示任务", "父壳名 = 「长任务 · <任务名>」");
    eqNum(String(step.parentSuperId), String(root.id), "环节子壳挂在父壳里（parentSuperId）");
    eqNum(step.title, "写分镜", "子壳名 = 环节标题");
    ok(!String(root.parentSuperId || "").trim(), "父壳在主画布层（不嵌套在别的壳里）");

    /* ── ② 产出与产物都落进对应环节子壳 ── */
    const outNode = S.wf.nodes.find((n) => n.kind === "ltout");
    const artNode = S.wf.nodes.find((n) => n.kind === "ltart");
    ok(!!outNode && !!artNode, "产出节点与产物节点都建出来了");
    eqNum(String(outNode.parentSuperId), String(step.id), "产出节点落进本环节子壳");
    eqNum(String(artNode.parentSuperId), String(step.id), "产物节点落进本环节子壳");
    eqNum(String(artNode.ltShellPath), "a1", "产物节点带壳归属（ltShellTask / ltShellPath）");
    ok(
      !S.wf.nodes.some((n) => (n.kind === "ltout" || n.kind === "ltart") && !String(n.parentSuperId || "")),
      "产出 / 产物都不再平铺在主画布层",
    );

    /* ─ ③ 生成工作流预置：按类型平行建、控制靠上、生成靠下、一律不运行 ── */
    const gens = () => S.wf.nodes.filter((n) => String(n.parentSuperId || "") === String(step.id) && n.ltGenType);
    eqNum(gens().length, 1, "默认只预置图像生成（genTypes 缺省 = [\"image\"]）");
    eqNum(String(gens()[0].kind), "proc_image", "图像类型建的是 proc_image（类型 → kind 唯一词汇表在壳模块）");
    const ctrl = S.wf.nodes.find((n) => n.kind === "control" && String(n.parentSuperId || "") === String(step.id));
    ok(!!ctrl, "子壳里有一枚控制节点（用户点 ▶ 的入口）");
    eqNum(String(ctrl.ctrlRole), "start", "控制节点是起点角色（不是 endSuccess / endFail）");
    eqNum(String(ctrl.ctrlAction), "run", "控制动作只认 run（不建 clear）");
    ok(Number(ctrl.y) < Number(gens()[0].y), "控制靠上、生成靠下（与画布既有排版口径一致）");
    ok(!gens()[0].running && !gens()[0].output, "预置的生成节点没有跑过（不替用户花钱）");
    ok(String(gens()[0].prompt || "").indexOf("写分镜") >= 0, "生成节点的提示词来自环节标题");
    ok(String(gens()[0].prompt || "").indexOf("写出这一环节的产物") >= 0, "生成节点的提示词带上环节 goal");
    ok(String(gens()[0].prompt || "").indexOf("费用") >= 0, "提示词里写明生成会产生费用（用户知情）");
    {
      const before = gens().length;
      const again = LTSH.presetGen(run, "a1");
      eqNum(gens().length, before, "再预置一次不重建（幂等：同类型已有就跳过）");
      eqNum(again.created, 0, "第二次 created = 0");
    }

    /* ── ④ 按 cfg.genTypes 预置多种类型（平行摆，各自带自己的参数）── */
    {
      run.graph.nodes.find((n) => n.id === "a1").cfg.genTypes = ["image", "video", "tts", "music"];
      LTSH.presetGen(run, "a1");
      const kinds = gens().map((n) => n.kind).sort().join(",");
      eqNum(kinds, "music_gen,proc_image,tts_gen,video_gen", "四种类型各建一个节点（平行，不串成一条链）");
      ok(
        gens().every((n) => String(n.parentSuperId) === String(step.id)),
        "四种生成节点都摆在同一颗环节子壳里",
      );
      const seen = new Set();
      ok(
        gens().every((n) => {
          const k = String(n.x) + "|" + String(n.y);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        }),
        "平行摆的生成节点各自占一格（不叠在一起）",
      );
      /* 壳里所有节点两两不重叠：控制（上）· 生成（左两列）· 产出（第三列）· 产物（更右一列起）。
         网格间距必须大于节点自身尺寸，否则 video_gen（高 340）/ proc_image（宽 400）会两两相压。 */
      const inner = () =>
        S.wf.nodes.filter((n) => String(n.parentSuperId || "") === String(step.id));
      const overlaps = (a, b) =>
        Number(a.x) < Number(b.x) + Number(b.w) &&
        Number(b.x) < Number(a.x) + Number(a.w) &&
        Number(a.y) < Number(b.y) + Number(b.h) &&
        Number(b.y) < Number(a.y) + Number(a.h);
      const bad = [];
      const all = inner();
      for (let i = 0; i < all.length; i++)
        for (let j = i + 1; j < all.length; j++)
          if (overlaps(all[i], all[j]))
            bad.push(
              all[i].kind + "(" + all[i].x + "," + all[i].y + ") × " + all[j].kind + "(" + all[j].x + "," + all[j].y + ")",
            );
      eqNum(bad.join(" / "), "", "壳内" + all.length + "颗节点两两不重叠（控制 / 生成 / 产出 / 产物各占自己的格子）");
      run.graph.nodes.find((n) => n.id === "a1").cfg.genTypes = ["image"];
    }

    /* ─ ⑤ 墓碑：壳被用户删了 → 不偷偷重长，只提示一次 ── */
    {
      S.wf.nodes = S.wf.nodes.filter((n) => String(n.ltShellTask || "") !== TID);
      const before = S.wf.nodes.length;
      await sandbox.ltOutputPublish(run, "a1", { text: "第二版正文", files: [] });
      eqNum(S.wf.nodes.filter((n) => n.kind === "super").length, 0, "壳被删后不再自动重建（不静默重长）");
      ok(run.shellGone === true, "在本 run 上记了墓碑（判据：建过壳 shellMade，此刻却找不到）");
      const out2 = S.wf.nodes.find((n) => n.kind === "ltout");
      ok(!!out2 && !String(out2.parentSuperId || ""), "这一轮的产出回落主画布层（有地方看结果，不断链）");
      const warns = toasts.filter((t) => String(t[0]).indexOf("超级节点壳已被删除") >= 0).length;
      eqNum(warns, 1, "只提示一次（不每轮刷屏）");
      eqNum(S.wf.nodes.length >= before, true, "回落路径照旧建节点");
    }
    /* 用户点「重建」才恢复 */
    {
      const rebuilt = LTSH.rebuild(run);
      ok(rebuilt === true, "用户点「重建壳」后恢复（不是静默重长，是用户点的）");
      ok(run.shellGone !== true, "墓碑清掉");
      ok(run.shellWarned !== true, "「已提示」标记一并清掉（重建后还能再提示一次）");
      eqNum(S.wf.nodes.filter((n) => n.kind === "super" && !String(n.ltShellPath || "")).length, 1, "父壳重新建出来");
      await sandbox.ltOutputPublish(run, "a1", { text: "第三版正文", files: [] });
      const step2 = LTSH.stepShellOf(TID, "a1");
      ok(!!step2, "下一次产出时子壳按原身份补回来（同一环节不堆第二颗）");
      eqNum(S.wf.nodes.filter((n) => n.kind === "super" && String(n.ltShellPath || "") === "a1").length, 1, "子壳只有一颗（幂等）");
      const out3 = S.wf.nodes.find((n) => n.kind === "ltout" && String(n.ltPath || "") === "a1");
      eqNum(String(out3.parentSuperId), String(step2.id), "产出又落回子壳");
    }

    /* ── ⑥ 存量迁移：主画布层上的产出节点搬进它该在的环节子壳（幂等） ── */
    {
      const legacy = { id: "legacyOut", kind: "ltout", x: 900, y: 40, w: 360, h: 260, title: "产出 · 旧档", text: "", ltTaskUid: TID, ltRunId: run.runId, ltPath: "a1", parentSuperId: "", parentTaskId: "" };
      S.wf.nodes.push(legacy);
      const r1 = await sandbox.ltShellMigrateOutputs(S.wf);
      eqNum(r1.moved, 1, "旧档的产出节点搬了一次");
      const step3 = LTSH.stepShellOf(TID, "a1");
      eqNum(String(legacy.parentSuperId), String(step3.id), "搬到本环节子壳里");
      ok(legacy.y >= 40 && legacy.x >= 40, "搬完给的是子壳内坐标系（不是原来的世界坐标）");
      const r2 = await sandbox.ltShellMigrateOutputs(S.wf);
      eqNum(r2.moved, 0, "已经在对的子壳里就不再搬（幂等）");
    }

    /* ── ⑦ 关掉「需要生成内容」就不预置（用户可改）── */
    {
      const g2 = LT.norm(AGENT_GRAPH("配音", { needsGen: false, genTypes: ["tts"] }));
      const runB = sandbox.ltRunNew({ uid: "taskShellB", name: "关掉的演示", graph: g2 }, "wf-shell", {});
      sandbox.ltInst(runB, "", runB.graph);
      setFile("C:\\ws\\out\\voice.wav");
      sandbox.ltStatePut(runB, "a1", "voice_file", "C:\\ws\\out\\voice.wav");
      await sandbox.ltOutputPublish(runB, "a1", { text: "配音稿", files: await sandbox.ltOutputPathsOf(runB, "a1") });
      const stepB = LTSH.stepShellOf("taskShellB", "a1");
      ok(!!stepB, "关掉生成的环节照旧建子壳（产出仍然有归属）");
      eqNum(S.wf.nodes.filter((n) => String(n.parentSuperId || "") === String(stepB.id) && n.ltGenType).length, 0, "关掉「需要生成内容」就不预置生成节点");
      eqNum(S.wf.nodes.filter((n) => n.kind === "control" && String(n.parentSuperId || "") === String(stepB.id)).length, 0, "也不摆控制节点（没有生成可触发）");
    }

    /* ──  环节改名：子壳标题跟上 ── */
    {
      const cur = LTSH.stepShellOf(TID, "a1");
      run.graph.nodes.find((n) => n.id === "a1").title = "写分镜（改过名）";
      const n = LTSH.syncStepTitles(run);
      ok(n >= 1 && String(cur.title) === "写分镜（改过名）", "环节改名后子壳标题跟到现名（重名交给 uniqueNodeTitle）");
    }

    /* ═══════════════ [3] 归属与清理 ═══════════════ */
    console.log("\n[3] 归属与清理：生成类型词汇表 / 缺省口径 / 删任务留壳");
    eqNum(LTSH.genTypesOf({}).join(","), "image", "genTypes 缺省 = [\"image\"]（默认只勾图像）");
    eqNum(LTSH.genTypesOf({ genTypes: [] }).join(","), "image", "空数组也回落默认");
    eqNum(LTSH.genTypesOf({ genTypes: ["video", "bogus", "video"] }).join(","), "video", "非法值丢掉、去重");
    eqNum(LTSH.needsGen({}), true, "needsGen 缺省 = 勾上（未设过即 true）");
    eqNum(LTSH.needsGen({ needsGen: false }), false, "显式 false 才是关");
    ok(LTSH.GEN_KINDS.image === "proc_image" && LTSH.GEN_KINDS.video === "video_gen" && LTSH.GEN_KINDS.music === "music_gen" && LTSH.GEN_KINDS.tts === "tts_gen", "四种生成类型的 kind 映射齐备");
    {
      /* 删任务：壳与壳内内容保留，只清掉绑定字段 */
      const before = S.wf.nodes.length;
      const r = await LT.deleteTask(S.wf, TID);
      ok(r && r.ok, "删任务成功");
      eqNum(S.wf.nodes.length, before, "壳与壳内节点一个都没被删（用户的资产与产出保留）");
      const left = S.wf.nodes.filter((n) => n.kind === "super" && String(n.ltShellPath || "") === "a1");
      ok(left.length >= 1, "带环节归属的子壳仍在画布上");
      eqNum(
        S.wf.nodes.filter((n) => String(n.ltShellTask || "") === TID).length,
        0,
        "壳上的任务绑定字段已清（此后这条任务的产出不再进壳）",
      );
    }

    console.log("\n" + (fails ? "FAILED " + fails + " / " + checks + " checks" : "ALL OK  " + checks + " checks"));
  }

  main().catch((e) => {
    console.error("smoke-longtask-shell crashed:", (e && e.stack) || e);
  });

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-longtask-shell.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-longtask-shell.js：" + fails + " / " + checks + " 项失败");
})();

/* 收尾：正文与并入块任一失败都算这只红；退出码只在全部跑完之后才定 */
if (MERGED_FAILED) console.log("\n✗ 本文件有失败项（含已并入块）\n");
process.exit(MERGED_FAILED ? 1 : 0);
