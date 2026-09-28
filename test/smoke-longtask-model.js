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
const fs = require("fs");
const path = require("path");
const vm = require("vm");

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
  process.exit(fails ? 1 : 0);
}
main();