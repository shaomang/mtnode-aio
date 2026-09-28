"use strict";
/* 「无模型」—— 模型不可见静默变无模型 · 无模型不允许启动 —— 冒烟测试
 *   node test/smoke-node-no-model.js
 *
 * 需求口径（本轮）：
 *   1) 任何时候都不弹「模型不可见」类错误提示：画布加载 / 切画布 / 导入他人模板时，
 *      不再有「检测到无效模型配置」逐个询问 + 批量替换服务商 / 模型的弹窗
 *      （app.js 里的 collectInvalidProviderGroups / promptReplaceProviderGroup /
 *      sanitizeInvalidProviders 已整体移除，sanitizeWfEnvironment 只剩工作目录那一支）；
 *   2) 解析不出可用模型时**自动静默**变成「无模型」：节点头摘要照实写「无模型 · 原来那一份
 *      （本机不存在）」，节点设置的服务商 / 模型下拉把本机没有的那只标出来，不改用户数据；
 *   3) 无模型时**不允许启动**：节点 ▶ 与控制节点 ▶ 都拦下（不起跑），用户亲手点启动时
 *      弹一次提示；自动级联 / 批次驱动的再入（quiet）不弹，免得一次刷出一串。
 *
 * 被测（能真跑的进 vm 沙箱真跑，其余按源码接入点钉住）：
 *   renderer/app.js         nodeModelGate / nodeModelStaleLabel（真跑）+ 旧弹窗已移除
 *   renderer/app-nodes.js   playNodeBody / playRemotionNode / playControlNode 三道闸门
 *   renderer/app-canvas.js  nsApiSummary 摘要与 nsProviderModelFields 回显
 *   renderer/i18n.js        中英词条（新词条齐备 · 旧「批量替换」词条已清）
 *   guides/manual/          手册不再写「逐个询问 / 批量替换」（行为改了，文档要跟上）
 * 只读断言：不改任何文件、不起 Electron、不碰真实 %APPDATA%。
 */
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
const HAS = (src, needle, msg) =>
  ok(src.indexOf(needle) >= 0, msg + (src.indexOf(needle) >= 0 ? "" : "\n        缺：" + needle));
const HASNT = (src, needle, msg) =>
  ok(src.indexOf(needle) < 0, msg + (src.indexOf(needle) < 0 ? "" : "\n        仍有：" + needle));

/* 大括号配对切出完整函数（含 async 前缀）；找不到返回 "" */
function fnBody(src, name) {
  const m = new RegExp("(?:async\\s+)?function\\s+" + name + "\\s*\\(").exec(src);
  if (!m) return "";
  let k = src.indexOf("{", m.index);
  let d = 0;
  for (; k < src.length; k++) {
    if (src[k] === "{") d++;
    else if (src[k] === "}") {
      d--;
      if (!d) return src.slice(m.index, k + 1);
    }
  }
  return "";
}

const APP = read("renderer/app.js");
const NODES = read("renderer/app-nodes.js");
const CANVAS = read("renderer/app-canvas.js");
const I18N = read("renderer/i18n.js");
/* 形态判定用真源（app-model-kind.js 是纯函数段，可单独 require） */
const KIND = require("../renderer/app-model-kind.js");

/* ══════════════ [1] nodeModelGate 真跑：什么算「无模型」 ══════════════ */
console.log("\n[1] renderer/app.js：nodeModelGate 真跑（无模型判据唯一真源）");
{
  HAS(APP, "function nodeModelGate(node)", "nodeModelGate 存在（判据只有这一份）");
  HAS(APP, "function nodeModelStaleLabel(node)", "nodeModelStaleLabel 存在（点名原来那一份）");

  const SRC = [
    fnBody(APP, "nodeModelGate"),
    fnBody(APP, "nodeModelStaleLabel"),
    fnBody(APP, "apiProviderValid"),
  ].join("\n");
  ok(SRC.indexOf("function nodeModelGate") === 0, "切出 nodeModelGate / nodeModelStaleLabel / apiProviderValid");

  const TEXT_PROV = {
    id: "p1",
    name: "甲家",
    type: "text_openai",
    apiKey: "k",
    models: ["deepseek-v4-flash"],
  };
  /* 同一家 OpenAI 兼容端点只挂图像模型 —— 文本节点选到它时没有该形态的模型 */
  const IMAGE_ONLY = {
    id: "p2",
    name: "乙家",
    type: "text_openai",
    apiKey: "k",
    models: ["gpt-image-2-vip"],
  };
  const providers = [TEXT_PROV, IMAGE_ONLY];

  const sb = {
    S: { config: { providers } },
    providerHasKind: KIND.providerHasKind,
    modelsOfKind: KIND.modelsOfKind,
    I18n: {
      t: (k, vars) =>
        String(k).replace(/\{(\w+)\}/g, (_, n) =>
          vars && vars[n] != null ? String(vars[n]) : "",
        ),
    },
    agentProviderRouteValid: (route) => {
      const s = String(route || "").trim() || "deepseek-official";
      if (s === "deepseek-official") return true;
      if (s.startsWith("mtnode_"))
        return providers.some(
          (p) => p.id === s.slice("mtnode_".length) && p.type === "text_openai",
        );
      return false;
    },
    agentModelsForRoute: (route) => {
      const s = String(route || "").trim() || "deepseek-official";
      if (s === "deepseek-official") return ["deepseek-v4-flash", "deepseek-v4-pro"];
      if (s.startsWith("mtnode_"))
        return (
          ((providers.find((p) => p.id === s.slice("mtnode_".length)) || {}).models) || []
        ).map(String);
      return [];
    },
  };
  const ctx = vm.createContext(sb);
  vm.runInContext(SRC, ctx, { filename: "app.js#no-model" });
  const gate = (node) =>
    vm.runInContext("nodeModelGate(" + JSON.stringify(node) + ")", ctx);
  const stale = (node) =>
    vm.runInContext("nodeModelStaleLabel(" + JSON.stringify(node) + ")", ctx);

  const good = gate({ kind: "proc_text", providerId: "p1", model: "deepseek-v4-flash" });
  ok(good.ok === true, "有服务商 + 模型在本机清单里 → 可启动");

  const first = gate({ kind: "proc_text", providerId: "p1", model: "" });
  ok(
    first.ok === true && first.model === "deepseek-v4-flash",
    "没显式选模型但该服务商有 → 沿用首个模型，不误判成无模型（老画布不受影响）",
  );

  const staleModel = gate({ kind: "proc_text", providerId: "p1", model: "gpt-4o-mini" });
  ok(
    staleModel.ok === false &&
      staleModel.reason.indexOf("gpt-4o-mini") >= 0 &&
      staleModel.reason.indexOf("无模型") === 0,
    "模型在本机清单里找不到 → 无模型（提示里点名是哪只模型）",
  );

  const goneProv = gate({ kind: "proc_text", providerId: "gone", model: "x" });
  ok(
    goneProv.ok === false && goneProv.reason.indexOf("gone") >= 0,
    "服务商本机没有（他人模板 / 配置里删过）→ 无模型（点名服务商）",
  );

  const noProv = gate({ kind: "proc_text", providerId: "", model: "" });
  ok(
    noProv.ok === false && noProv.reason.indexOf("还没选服务商") >= 0,
    "新节点还没选服务商 → 无模型",
  );

  const wrongKind = gate({ kind: "proc_text", providerId: "p2", model: "" });
  ok(
    wrongKind.ok === false && wrongKind.reason.indexOf("这一形态") >= 0,
    "服务商在本机没有文本 / 图像这一形态的模型 → 无模型（按模型形态判，不看服务商级 type）",
  );

  const imgOk = gate({ kind: "proc_image", providerId: "p2", model: "gpt-image-2-vip" });
  ok(imgOk.ok === true, "图像节点 + 该服务商的图像模型 → 可启动");

  const remotionNoModel = gate({ kind: "remotion", providerId: "p1", model: "nope" });
  ok(remotionNoModel.ok === false, "remotion 与文本节点同判据（要文本模型）");

  ok(gate({ kind: "save", providerId: "", model: "" }).ok === true, "不需要模型的节点照常放行");
  ok(gate({ kind: "function", model: "" }).ok === true, "函数节点照常放行（模型由 AI 设定另管）");

  const agentGoneRoute = gate({
    kind: "agent_task",
    provider: "mtnode_gone",
    model: "deepseek-v4-flash",
  });
  ok(agentGoneRoute.ok === false, "智能节点的路由本机没有 → 无模型");

  const agentDefault = gate({ kind: "agent_task", provider: "", model: "" });
  ok(agentDefault.ok === true, "智能节点跟随默认路由 → 可启动");

  const agentStaleModel = gate({
    kind: "agent_task",
    provider: "deepseek-official",
    model: "not-on-this-machine",
  });
  ok(agentStaleModel.ok === false, "智能节点的模型不在该路由清单里 → 无模型");

  ok(
    stale({ kind: "proc_text", providerId: "gone", model: "m-x" }) === "gone · m-x",
    "nodeModelStaleLabel 点名「原来那一份」（服务商 · 模型）",
  );
  ok(
    stale({ kind: "proc_text", providerId: "p1", model: "deepseek-v4-flash" }) === "",
    "能解析出来的不重复报（标签为空）",
  );
  ok(
    stale({ kind: "agent_task", provider: "mtnode_gone", model: "mm" }) === "mtnode_gone · mm",
    "智能节点的标签同样点名路由与模型",
  );
}

/* ══════════════ [2] 画布加载 / 导入：零弹窗 ══════════════ */
console.log("\n[2] renderer/app.js：模型不可见不再弹任何提示");
{
  HASNT(APP, "function collectInvalidProviderGroups", "旧的无效服务商分组体检已移除");
  HASNT(APP, "function promptReplaceProviderGroup", "旧的逐个询问 + 批量替换弹窗已移除");
  HASNT(APP, "sanitizeInvalidProviders", "sanitizeInvalidProviders 已移除（不再有调用点）");
  HASNT(APP, "检测到无效模型配置", "旧的信息弹窗文案已清（模型侧不再有错误弹窗）");
  const ENV = fnBody(APP, "sanitizeWfEnvironment");
  HAS(ENV, "sanitizeInvalidWorkspaces(opts)", "sanitizeWfEnvironment 仍处理无效工作目录（本次不动）");
  HASNT(ENV, "sanitizeInvalidProviders", "sanitizeWfEnvironment 不再牵扯服务商 / 模型");
  const GATE = fnBody(APP, "nodeModelGate");
  HASNT(GATE, "toast(", "判据本身不弹窗（弹不弹由调用方按「用户亲手点」决定）");
  HASNT(GATE, "openOverlay", "判据本身不开窗");
  HAS(GATE, "node.kind !== \"proc_text\"", "判据只认要云端模型的节点（其余照常放行）");
  HAS(APP, "派生状态", "注释写明是派生状态：不改用户数据、零弹窗");
}

/* ══════════════ [3] 启动闸门：无模型不允许启动，点了才提示 ══════════════ */
console.log("\n[3] renderer/app-nodes.js：无模型不允许启动 + 用户点启动才提示");
{
  const BODY = fnBody(NODES, "playNodeBody");
  HAS(BODY, "nodeModelGate(node)", "playNodeBody 起跑前过「无模型」闸门");
  HAS(BODY, "if (!mg.ok)", "无模型 → 不起跑");
  HAS(BODY, "if (!quiet) toast(mg.reason, \"warn\")", "用户亲手点 ▶（quiet=false）才弹一次提示");
  HAS(BODY, "node.error = mg.reason", "原因写回节点（节点上看得见，不静默吞掉）");
  ok(
    BODY.indexOf("nodeModelGate(node)") < BODY.indexOf("let prov = S.config.providers.find"),
    "闸门在取服务商之前（先拦再解析）",
  );

  const REM = fnBody(NODES, "playRemotionNode");
  HAS(REM, "nodeModelGate(node)", "remotion 起跑前同判据拦截");
  HAS(REM, "if (!quiet) toast(mg.reason, \"warn\")", "remotion 也是用户点了才提示");

  const CTL = fnBody(NODES, "playControlNode");
  HAS(CTL, "const userFired = !seen;", "控制节点记住「这一层是用户亲手点的」");
  HAS(CTL, ".filter((x) => !x.g.ok)", "控制批次里挑出无模型节点（每节点只判一次）");
  HAS(CTL, "for (const x of blocked) x.n.error = x.g.reason;", "被拦节点的原因写回自己身上");
  HAS(CTL, "I18n.t(\"无模型，未启动：\")", "点控制 ▶ 时弹提示并点名是哪些节点");
  HAS(CTL, "if (userFired) {", "提示只在用户亲手点的那一层弹（批次驱动再入不重复弹）");
  HAS(CTL, "runnable = runnable.filter((n) => !blockedNodes.includes(n));", "无模型节点被移出本次批次");
  HAS(CTL, "if (!runnable.length) return", "整批都无模型 → 不起跑");
  ok(!/\bconst runnable = fillOnly/.test(CTL), "runnable 改成 let（要按闸门过滤）");

  HAS(NODES, "await playNode(node, false, opts || {});", "节点 ▶ 走 playUserNode → quiet=false（提示会弹）");

  /* 判断节点（judge）：模型与文本服务商同源，没得用也不该静默什么都不发生 */
  const JUDGE = fnBody(APP, "playJudgeNode");
  HAS(JUDGE, "无模型：本机没有带 API Key 的文本服务商", "判断节点无模型 → 不起跑（写回节点）");
  HAS(JUDGE, "if (!quiet) toast(node.error, \"warn\")", "判断节点也是用户亲手点 ▶ 才提示");
}

/* ══════════════ [4] 显示：节点头摘要与节点设置照实写「无模型」 ══════════════ */
console.log("\n[4] renderer/app-canvas.js：节点头 / 节点设置照实回显");
{
  const SUM = fnBody(CANVAS, "nsApiSummary");
  HAS(SUM, "nodeModelGate(node)", "摘要走同一份判据（显示与实际一致）");
  HAS(SUM, "I18n.t(\"无模型\")", "无模型时摘要写「无模型」");
  HAS(SUM, "nodeModelStaleLabel(node)", "摘要点名原来那一份");
  HAS(SUM, "（本机不存在）", "摘要标出「本机不存在」");

  const FIELDS = fnBody(CANVAS, "nsProviderModelFields");
  HAS(FIELDS, "（本机不存在）", "节点设置把本机没有的那只模型标出来（不静默改值）");
  HAS(FIELDS, "（无模型）", "该形态一个模型都没有时下拉明说「无模型」");
  HAS(FIELDS, "modelsOfKind(S.config, prov, kind)", "模型下拉仍按形态取（口径未变）");
}

/* ══════════════ [5] i18n：新词条中英齐备 · 旧弹窗词条清掉 ══════════════ */
console.log("\n[5] renderer/i18n.js：词条");
{
  for (const k of [
    "无模型",
    "（无模型）",
    "（本机不存在）",
    "无模型：本机没有该节点的服务商「{name}」，请在节点设置里重新选择服务商与模型",
    "无模型：该节点还没选服务商，请在节点设置里选好服务商与模型",
    "无模型：该服务商在本机没有可用模型，请在设置 · 模型服务里补上模型",
    "无模型：服务商「{name}」在本机没有这一形态的模型，请在设置 · 模型服务里补上模型或改模型类型",
    "无模型：模型「{model}」在本机不存在，请在节点设置里重新选择模型",
    "无模型，未启动：",
    "（请在各自节点的设置里选好服务商与模型）",
  ]) {
    HAS(I18N, '"' + k + '":', "i18n 收词条（中英各一份）：" + k);
  }
  HASNT(I18N, '"批量替换":', "旧「批量替换」词条随弹窗一起移除");
  HASNT(I18N, '"请选择模型":', "旧「请选择模型」词条随弹窗一起移除");
  HASNT(I18N, '"无效服务商 / 模型":', "旧「无效服务商 / 模型」标题词条已移除");
}

/* ══════════════ [6] 手册：行为改了，文档要跟上 ══════════════ */
console.log("\n[6] guides/manual：手册不再写「逐个询问 / 批量替换」");
{
  const ZH = read("guides/manual/community.md");
  const EN = read("guides/manual/en/community.md");
  HASNT(ZH, "批量替换", "中文手册不再写批量替换");
  HASNT(ZH, "逐个询问", "中文手册不再写逐个询问");
  HAS(ZH, "无模型", "中文手册写明会静默变成「无模型」");
  HASNT(EN, "batch-replace", "English manual no longer promises batch replace");
  HAS(EN, "No model", "English manual says the node silently becomes No model");
}

console.log(
  "\n" + (fails ? "FAIL" : "PASS") + "  smoke-node-no-model：" + checks + " 项，" + fails + " 项失败",
);
process.exit(fails ? 1 : 0);