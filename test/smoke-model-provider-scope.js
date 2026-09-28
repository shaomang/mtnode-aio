"use strict";
/**
 * test/smoke-model-provider-scope.js —— 「模型清单只列当前服务商」的回归
 *
 * 本轮修的是「选模型时可选所有提供商的模型」：前面的「服务商 / 路由」（或会话头部的
 * 「供应商」）已经确定，后面的模型一格却把**所有服务商**的模型摊在一起 —— 用户点一只
 * 别家的模型，要么被悄悄换掉服务商、要么配出一个只在运行时才炸的组合，正是「误选」。
 *
 * 断言按层排（能真跑的不只 grep）：
 *   [1] 收窄口径真跑：agentOpts().modelGroupsFor(route) 只列这一家；route 留空 = 全量
 *       （清单本身就是选型入口，选中即把路由一并拨正）
 *   [2] 控件真跑：modelScopeOpts 把收窄后的清单喂给 ltSelField.setOptions，
 *       下拉里再也点不到别家的模型；控件里的历史值（不属于该家）单独成组、可回显
 *   [3] 界面接线：会话模型菜单 / 长任务检查器 / 建图选型 / 条带 chip 面板
 *       四处模型格都按上一格收窄，换供应商时只重列模型清单（不重建浮层）
 *   [4] i18n：新加的「（不属于该服务商）」中英齐备
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
const eqStr = (a, b, msg) =>
  ok(String(a) === String(b), msg + "（得到 " + JSON.stringify(a) + "，期望 " + JSON.stringify(b) + "）");
const eqNum = (a, b, msg) =>
  ok(a === b, msg + "（得到 " + JSON.stringify(a) + "，期望 " + JSON.stringify(b) + "）");

const CTL = read("renderer/app-longtask-ctl.js");
const LTU = read("renderer/app-longtask-ui.js");
const LTC = read("renderer/app-longtask-create.js");
const ASSIST = read("renderer/app-assist.js");
const I18N = read("renderer/i18n.js");

/* ═══════════════ 假 DOM（与 smoke-longtask-model.js 同口径，只够跑 ltSelField） ═══════════ */
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
      el.children.length = 0;
    },
  });
  return el;
}
const mkFakeDoc = () => ({
  createElement: mkEl,
  activeElement: null,
  addEventListener() {},
  getElementById() {
    return null;
  },
});
const hasClass = (el, cls) => String((el && el.className) || "").split(/\s+/).indexOf(cls) >= 0;
const childByClass = (el, cls) => ((el && el.children) || []).filter((c) => hasClass(c, cls))[0] || null;
/* 下拉里当前可见的分组标签（= 模型格那一格能点到的服务商） */
function groupLabels(pop) {
  const out = [];
  for (const ch of pop.children) if (hasClass(ch, "lt-sel-g")) out.push(ch.textContent);
  return out;
}
/* 某一分组里的模型 label 列表 */
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
        out.push(ol ? ol.textContent : "");
      }
    }
  }
  return out;
}

/* 两家服务商各有一只同名模型 shared —— 「选 B 家落到 A 家」的现场就是这个形状 */
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
    AGENT_PRESETS: [{ id: "standard", labelKey: "标准预设" }],
    AGENT_EFFORT_UI_ORDER: ["low", "high"],
    AGENT_EFFORT_ORDER: ["low", "medium", "high", "xhigh", "max"],
    AGENT_EFFORT_LABELS: { low: "低", high: "高" },
    AGENT_PRESET_DEFAULT: "standard",
    S: { assistPreset: "standard", assistEffort: "high" },
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

console.log("\n[1] 收窄口径真跑：modelGroupsFor(route) 只列这一家（真跑 app-longtask-ctl.js）");
ok(!!ctl && typeof ctl.agentOpts === "function", "控件工厂整份执行并挂上 window.LT.ui.ctl");
const AO = ctl.agentOpts();
ok(typeof AO.modelGroupsFor === "function", "agentOpts 出口新增 modelGroupsFor（收窄清单唯一真源）");
{
  const all = AO.modelGroups.map((g) => g.group).join(",");
  eqStr(all, "A家,B家", "路由留空时的全量清单仍是两家都在（清单本身就是选型入口）");
  const a = AO.modelGroupsFor("prov-a");
  eqStr(a.map((g) => g.group).join(","), "A家", "选了 A 家：模型清单只剩 A家 这一组");
  eqStr(
    a[0].items.map((it) => it.label).join(","),
    "shared,a-only",
    "A家 组里就是它自己的两只模型（同名 shared 只出现一次）",
  );
  eqStr(a[0].items.map((it) => it.value).join(","), "prov-a|shared,prov-a|a-only", "value 仍是「路由|模型」成对编码");
  const b = AO.modelGroupsFor("prov-b");
  eqStr(b.map((g) => g.group).join(","), "B家", "选了 B 家：只剩 B家 这一组");
  eqStr(b[0].items.map((it) => it.label).join(","), "shared,b-only", "B家 组里没有 A家 的 a-only");
  eqStr(AO.modelGroupsFor("").map((g) => g.group).join(","), "A家,B家", "空路由 = 全量（老调用方的口径不变）");
  eqStr(AO.modelGroupsFor("prov-gone").length, 0, "路由不在清单里（服务商被删）→ 空清单，不编一个别家的表");
}
has(CTL, "const modelGroupsFor = (r) => {", "收窄函数在 ctl 里只有一份");
has(CTL, "modelGroupsFor: modelGroupsFor,", "modelGroupsFor 挂进 agentOpts 出口");
has(CTL, "if (!s) return modelGroups;", "路由留空走全量分支（不是空表）");
{
  const seg = CTL.slice(CTL.indexOf("const modelGroups = routes"));
  const dup = seg.slice(0, seg.indexOf("const modelGroupsFor")).indexOf("ltaKeyOf(g.id, m)") >= 0;
  ok(dup, "全量清单只建一次（收窄函数复用它，不复制第二份 key 拼法）");
}

console.log("\n[2] 控件真跑：模型格 setOptions 到收窄清单后点不到别家的模型");
ok(typeof ctl.modelScopeOpts === "function", "ctl 出口新增 modelScopeOpts（模型格收窄选项的唯一口径）");
{
  const fdoc = mkFakeDoc();
  const cs2 = mkCtlSandbox({ document: fdoc });
  const ctl2 = cs2.window.LT.ui.ctl;
  const AO2 = ctl2.agentOpts();
  const host = fdoc.createElement("div");
  /* 模型格：初值先按 A 家给（模拟到达时路由已选定） */
  const handle = ctl2.ltSelField(
    host,
    "模型",
    "prov-a|shared",
    ctl2.modelScopeOpts(AO2, "prov-a", null),
    () => {},
    { allowEmpty: true, emptyLabel: "跟随默认" },
  );
  const pop = childByClass(handle.el, "lt-sel-pop");
  handle.open();
  eqStr(groupLabels(pop).join(","), "A家", "模型格初开：只列 A家 一组（别家的模型根本点不到）");
  eqStr(handle.input.value, "shared", "当前值照常回显成模型名");
  /* 换到 B 家：先回显值，再按 B 家重列（面板 / 检查器的真实顺序） */
  handle.setValue("prov-b|b-only", true);
  handle.setOptions(ctl2.modelScopeOpts(AO2, "prov-b", handle));
  handle.close();
  handle.open();
  eqStr(groupLabels(pop).join(","), "B家", "换到 B 家：清单跟着换成 B家（不整窗重建也收窄）");
  eqStr(optsOf(pop, "B家").join(","), "shared,b-only", "B家 组里两只都在（含同名 shared）");
  eqStr(handle.value(), "prov-b|b-only", "换家后控件的值 = 新家的「路由|模型」成对编码");
  /* 历史值（不属于该家）不许被静默吞掉：单独成组列出并说明 */
  handle.setValue("prov-a|a-only", true);
  handle.setOptions(ctl2.modelScopeOpts(AO2, "prov-b", handle));
  handle.close();
  handle.open();
  const labels = groupLabels(pop);
  ok(labels.indexOf("B家") >= 0, "B家 分组仍在（收窄不等于清空）");
  ok(labels.indexOf("（不属于该服务商）") >= 0, "不属于该家的历史值单独成组（不静默改掉，看得到原因）");
  eqStr(optsOf(pop, "（不属于该服务商）").join(","), "a-only", "那一组里显示的是模型名（用户认模型，不认编码）");
  {
    const g = pop.children.filter((c) => hasClass(c, "lt-sel-g") && c.textContent === "（不属于该服务商）")[0];
    const grp = g ? pop.children[pop.children.indexOf(g) + 1] : null;
    const hint = grp && childByClass(grp.children[0], "lt-sel-oh");
    ok(!!hint && hint.textContent.indexOf("A家") >= 0, "越界项的 hint 说清它原本属于哪一家（「A家」在）");
  }
  eqStr(handle.value(), "prov-a|a-only", "控件仍持有该值（回显不乱、也不偷偷换成别家的模型）");
}
has(CTL, "function ltcModelScopeOpts(AO, route, handle) {", "modelScopeOpts 的实现只有一份（四处模型格共用）");
has(CTL, "const cur = handle && typeof handle.value === \"function\"", "越界值判据取控件当前值（现取现算，不缓存）");
has(CTL, "modelScopeOpts: ltcModelScopeOpts,", "modelScopeOpts 挂进 ctl 出口");

console.log("\n[3] 界面接线：四处模型格都按上一格收窄");
/* [3a] 会话头部的模型菜单：模型清单只列当前供应商，不再「点模型 = 换供应商」 */
{
  const seg = ASSIST.slice(ASSIST.indexOf('if (pane === "model") {'), ASSIST.indexOf("} else {", ASSIST.indexOf('if (pane === "model") {')));
  has(seg, 'const cur = agentProviderGroupsNow().filter((g) => g.id === agentSessionProviderRoute(st))[0] || null', "会话模型菜单按当前供应商（模型提供商那一格）命中当前供应商");
  has(seg, "for (const m of cur.models) {", "只遍历当前供应商的模型（不再 for (const g of groups) 铺全部）");
  ok(seg.indexOf("st.provider = g.id") < 0, "点模型不再顺手改供应商（正是这次要修的误选）");
  has(seg, "if (!cur) {", "会话存的供应商已不在配置里 → 单独分支（照实说明，不静默切别家）");
  has(seg, "st.model = m;", "写回口径不变：仍只改 st.model");
  has(ASSIST, 'e.textContent = I18n.t("没有可用的模型");', "空态文案用已有词条（不新增词条）");
}
/* [3b] 长任务检查器 */
has(LTU, "const modelOptsNow = (route) =>", "检查器模型格有收窄取用口");
has(LTU, "C.modelScopeOpts(AO, route, hModel)", "检查器走 ctl.modelScopeOpts（不自己写一份过滤）");
has(LTU, "modelOptsNow(node.cfg.provider),", "检查器模型格初值按 node.cfg.provider 收窄");
has(LTU, "if (hModel) hModel.setOptions(modelOptsNow(v));", "检查器换路由时就地重列模型清单");
/* [3c] 条带 chip 面板（四格选型口） */
has(LTU, "modelOptsNow(sel0.provider),", "chip 面板模型格初值按当前路由收窄");
has(LTU, "if (hModel) hModel.setOptions(modelOptsNow(v));", "chip 面板换路由时就地重列（不整窗重建，未提交输入不丢）");
/* [3d] 建图「Agent 选型」一栏 */
has(LTC, "const modelOptsNow = (route) => C.modelScopeOpts(AO, route, hs.model);", "建图选型的模型格同一份收窄口径");
has(LTC, "modelOptsNow(cfg.provider),", "建图选型模型格初值按 cfg.provider 收窄");
has(LTC, "refreshModelOpts();", "建图选型换路由 / 静默回填时重列模型清单");
{
  const n = (LTC.match(/refreshModelOpts\(\);/g) || []).length;
  ok(n >= 2, "建图选型在两个路径上都重列（换路由 " + n + " 处 ≥ 2：含静默回填）");
}
hasntAll([["app-longtask-ui.js", LTU], ["app-longtask-create.js", LTC]], "AO.modelGroups,", "长任务两处模型格不再直接吃全量清单（改吃收窄后的）");

function hasntAll(list, needle, msg) {
  for (const [name, src] of list) {
    const c = String(src).indexOf(needle) < 0;
    ok(c, name + "：" + msg + (c ? "" : "（仍含 " + JSON.stringify(needle) + "）"));
  }
}

/* 兼容性：老调用方仍在的出口不许被顺手删掉 */
has(CTL, "modelGroups: modelGroups,", "全量 modelGroups 出口保留（老调用方 / 单测仍可用）");
has(CTL, "modelsOf: modelsOf,", "modelsOf 保留（换服务商时判断原模型属不属于新家的判据）");
has(CTL, "routeOfModel: routeOfModel,", "routeOfModel 保留");

console.log("\n[4] i18n：新增词条中英齐备（切英文不出现中文半截）");
{
  const I17 = require("../renderer/i18n.js");
  const keys = ["（不属于该服务商）", "（属于「{route}」）"];
  I17.setLocale("en");
  const miss = keys.filter((k) => I17.t(k) === k);
  eqNum(miss.length, 0, "i18n 中英词条齐备" + (miss.length ? "（缺：" + miss.join(" / ") + "）" : ""));
  eqStr(I17.t("（不属于该服务商）"), "(not from this provider)", "英文词条内容正确");
  eqStr(
    I17.t("（属于「{route}」）", { route: "A家" }),
    '(belongs to "A家")',
    "带占位符的词条能整句替换（切英文不出现中文半截）",
  );
  I17.setLocale("zh");
  eqStr(I17.t("（不属于该服务商）"), "（不属于该服务商）", "中文界面回显中文原文");
  for (const k of keys) has(I18N, '"' + k + '"', "i18n 源文件里有「" + k + "」的词条");
}

function hasntAll(list, needle, msg) {
  for (const [name, src] of list) {
    const c = String(src).indexOf(needle) < 0;
    ok(c, name + "：" + msg + (c ? "" : "（仍含 " + JSON.stringify(needle) + "）"));
  }
}

console.log("\n" + (fails ? "FAIL" : "PASS") + "  smoke-model-provider-scope：" + checks + " 项，" + fails + " 项失败");
process.exit(fails ? 1 : 0);