"use strict";
/* 普通（非智能）文本处理节点：提示词框支持 / 或 、 呼出技能，运行前展开技能说明书
 *   node test/smoke-skill-slash-node.js
 *
 * 背景：技能斜杠调用（slashTick / slashKey / resolveSkillSlash / skillTaskPrompt）原先只挂在
 *   agent_task 与「开启智能模式」的 proc_text（isDshTask）上，普通文本处理节点没有入口。
 * 本轮放宽到 proc_text（含智能与普通两种），并在运行 / 预览路径同口径展开。
 *
 * 覆盖：
 *   [1] UI 接线：renderer/app-canvas.js 的文本域绑定 slashTick / slashKey（compositionend、
 *       keydown、click 三处），标签与占位文案；renderer/app.js 的 input 监听同步放宽
 *   [2] 运行路径：renderer/app-nodes.js buildSpec / buildSpecAgg 新增 skillWrap 且在 @ 引用
 *       解析之后展开；runOnce / runOnceAgg / previewNode 走 resolveSkillSlash
 *   [3] 行为（vm 跑真实函数）：slashToken 认 / 与 、 触发、空格结束；applySkillWrapToAssembled
 *       就地替换行首 /技能名 且不碰技能正文里的 @ / /
 *   [4] i18n：新增两条文案中英成对、无重复键
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

const ROOT = path.join(__dirname, "..");
const read = (rel) =>
  fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");
/* 从源码里按名字抠出顶层函数（不改动源文件，见 smoke-ref-keyboard.js 同套路） */
function fnBody(src, name) {
  const m = src.match(new RegExp("\\nfunction " + name + "\\s*\\(", "m"));
  if (!m) throw new Error("找不到函数：" + name);
  const at = m.index + 1;
  const i = src.indexOf("{", at);
  let depth = 0;
  let inStr = null;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    const p = src[j - 1];
    if (inStr) {
      if (c === inStr && p !== "\\") inStr = null;
      continue;
    }
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
const at = (src, needle) => src.indexOf(needle);

const app = read("renderer/app.js");
const canvas = read("renderer/app-canvas.js");
const nodes = read("renderer/app-nodes.js");
const i18n = read("renderer/i18n.js");

console.log("[1] UI 接线：普通文本处理节点的提示词框也能呼出技能菜单");
ok(
  canvas.indexOf('if (node.kind === "proc_text") slashTick(ta, "node", persistPrompt);') >= 0,
  "canvas compositionend：proc_text（含普通）触发 slashTick(ta, \"node\", persistPrompt)",
);
ok(
  canvas.indexOf('if (node.kind === "proc_text" && slashKey(ta, ev)) return;') >= 0,
  "keydown：slashKey 先消费 ↑↓ / Enter / Tab / Esc（被消费即 return）",
);
ok(
  canvas.indexOf('if (node.kind === "proc_text" && S.slashMenu) slashTick(ta, "node", persistPrompt);') >= 0,
  "click：菜单开着时按当前光标重筛",
);
{
  const kd = at(canvas, 'if (node.kind === "proc_text" && slashKey(ta, ev)) return;');
  const rk = at(canvas, "if (refKey(ta, ev, node)) return;");
  ok(kd > 0 && rk > 0 && kd < rk, "slashKey 在 refKey 之前消费（两套菜单各自处理，不互相截胡）");
}
ok(
  canvas.indexOf('I18n.t("提示词 Prompt（@ 引用输入节点 · 输入 / 呼出技能）")') >= 0,
  "普通 proc_text 标签改为「提示词 Prompt（@ 引用输入节点 · 输入 / 呼出技能）」",
);
ok(
  canvas.indexOf('I18n.t("任务（输入 / 呼出技能 · @ 引用输入节点）")') >= 0,
  "智能（agent）节点标签保持原样",
);
ok(
  canvas.indexOf("输入 @ 引用已连接节点 · 输入 / 或 、 呼出技能") >= 0,
  "普通 proc_text 的 textarea placeholder 补「输入 / 或 、 呼出技能」",
);

console.log("\n[2] app.js：input 监听同步放宽（边打字边筛）");
{
  /* 按「函数名 + 头几个形参」定位：正文框后来加了可选的第 5 个形参（opts：refs 口径 /
     落回回调），这里不再钉死整条签名，免得每加一个可选参数就整段失效 */
  const mi = at(app, "function mountPromptTextarea(f3, ta, node, persistPrompt");
  const body = mi >= 0 ? app.slice(mi, mi + 1400) : "";
  ok(body.indexOf('if (node.kind === "proc_text") slashTick(ta, "node", persistPrompt);') >= 0,
    "mountPromptTextarea 的 input 监听对 proc_text（含普通）调 slashTick");
  const pv = body.indexOf("persistPrompt(ta.value);");
  const st = body.indexOf('if (node.kind === "proc_text") slashTick(ta, "node", persistPrompt);');
  ok(pv > 0 && st > pv, "先落库再重筛（与原有顺序一致）");
  ok(body.indexOf("if (isDshTask(node)) slashTick") < 0, "旧的 isDshTask 限定已不在 input 监听里");
}
ok(
  app.indexOf('if (t.charAt(0) === "\\u3001") t = "/" + t.slice(1);') >= 0,
  "resolveSkillSlash 认中文顿号 、 当 /（普通节点同样生效）",
);
ok(/const m = t\.match\(\/\^\\\/\(\[a-zA-Z0-9_-\]\+\)/.test(app),
  "resolveSkillSlash 仍解析行首 /技能名 [说明]");
ok(/function slashKey\(ta, ev\)/.test(app) && /if \(ev\.key === "Enter" \|\| ev\.key === "Tab"\)/.test(app),
  "slashKey 未改动（回车 / Tab 确认、↑↓ 选择、Esc 收起）");
ok(/function slashTick\(ta, scope, onChange\)/.test(app) && /scope !== "node" \|\| !isCanvasBuildSkillName/.test(app),
  "slashTick scope=node 仍过滤画布类技能（generate-workflow / generate-task）");

console.log("\n[3] 运行路径：技能说明书在 @ 引用解析之后就地展开");
ok(nodes.indexOf("function buildSpec(node, prov, idx, skillWrap) {") >= 0,
  "buildSpec 新增可选 skillWrap 参数");
ok(nodes.indexOf("function buildSpecAgg(node, prov, skillWrap) {") >= 0,
  "buildSpecAgg 新增可选 skillWrap 参数");
{
  const b1 = at(nodes, "function buildSpec(node, prov, idx, skillWrap) {");
  const seg1 = nodes.slice(b1, b1 + 1600);
  const rr = seg1.indexOf("resolveRefs(runPrompt, node, idx);");
  const aw = seg1.indexOf("applySkillWrapToAssembled(");
  ok(rr > 0 && aw > rr, "buildSpec：applySkillWrapToAssembled 在 resolveRefs 之后（正文里的 @ / / 不被二次解析）");
  ok(seg1.indexOf("skillWrap.raw") >= 0 && seg1.indexOf("skillTaskPrompt(skillWrap)") >= 0,
    "buildSpec：以 skillWrap.raw 定位、skillTaskPrompt 包装");
  const b2 = at(nodes, "function buildSpecAgg(node, prov, skillWrap) {");
  const seg2 = nodes.slice(b2, b2 + 2600);
  const rr2 = seg2.indexOf("resolveRefsAgg(runPrompt, node);");
  const aw2 = seg2.indexOf("applySkillWrapToAssembled(");
  ok(rr2 > 0 && aw2 > rr2, "buildSpecAgg：同样在 resolveRefsAgg 之后展开");
}
ok(/resolveSkillSlash\(procPromptForRun\(node\), \{\s*\r?\n\s*denyCanvasSkills: true,\s*\r?\n\s*\}\)/.test(nodes),
  "普通节点统一走 resolveSkillSlash(procPromptForRun(node), { denyCanvasSkills: true })");
{
  const r1 = at(nodes, "async function runOnce(node, prov, idx, itemTitle, attemptT) {");
  const seg = nodes.slice(r1, r1 + 900);
  ok(/const dshTask = isDshTask\(node\);/.test(seg), "runOnce 先判 dshTask");
  ok(/const skillWrap = dshTask\s*\n?\s*\? null\s*\n?\s*: await resolveSkillSlash\(/.test(seg),
    "runOnce：智能任务节点不重复展开（避免二次包装），仅普通节点解析");
  ok(seg.indexOf("buildSpec(node, prov, idx, skillWrap)") >= 0, "runOnce 把 skillWrap 传进 buildSpec");
  const r2 = at(nodes, "async function runOnceAgg(node, prov, attemptT) {");
  const seg2 = nodes.slice(r2, r2 + 900);
  ok(/const dshTask = isDshTask\(node\);/.test(seg2), "runOnceAgg 同口径");
  ok(seg2.indexOf("buildSpecAgg(node, prov, skillWrap)") >= 0, "runOnceAgg 把 skillWrap 传进 buildSpecAgg");
  const pv = at(nodes, "/* 行首 /技能名：预览也走同口径，看到的就是真正会发出去的内容 */");
  const seg3 = nodes.slice(pv, pv + 600);
  ok(seg3.indexOf("await resolveSkillSlash(procPromptForRun(node), {") >= 0 &&
     seg3.indexOf("buildSpec(node, prov, 0, skillWrap)") >= 0,
    "previewNode：预览即所见即所发（同口径解析并传入 buildSpec）");
}
ok(nodes.indexOf("await resolveSkillSlash(procPromptForRun(node),") >= 0 &&
   nodes.indexOf('typeof applySkillWrapToAssembled === "function"') >= 0,
  "普通节点仍走原 apiCallTextStream 路径（不改成 dsh 任务）");

console.log("\n[4] 行为：真实函数（vm 取源码，不碰源文件）");
const sandbox = {
  console, Math, JSON, String, Number, RegExp, Array, Object, Error,
  I18n: { t: (s) => s },
};
vm.runInNewContext(
  fnBody(app, "slashToken") + "\n" + fnBody(app, "applySkillWrapToAssembled") +
    "\n;Object.assign(__api, { slashToken, applySkillWrapToAssembled });",
  Object.assign(sandbox, { __api: {} }),
);
const { slashToken, applySkillWrapToAssembled } = sandbox.__api;
const mk = (value, caret) => ({ value, selectionStart: caret == null ? value.length : caret });

{
  const a = slashToken(mk("/mu"));
  ok(a && a.trigger === "/" && a.query === "mu", "行首「/」触发：query=mu");
  const b = slashToken(mk("、mu"));
  ok(b && b.trigger === "、" && b.query === "mu", "中文顿号「、」同样触发（输入法 / 打成 、 也能用）");
  const c = slashToken(mk("/minimax-music"));
  ok(c && c.query === "minimax-music", "技能名带 - 也照常解析（query=minimax-music）");
  ok(slashToken(mk("/minimax-music 写一首")) === null, "技能名后打空格即收起菜单（正文继续写，token 结束）");
  ok(slashToken(mk("正文里 /mu")) === null, "/ 前有正文（非行首）时不误弹菜单");
  ok(slashToken(mk("第一行\n/decompose")) !== null, "换行后行首 / 触发");
}
{
  const raw = "/minimax-music 写一首轻快的歌";
  const wrapped = "请使用技能「MiniMax 音乐」。\n\n写一首轻快的歌\n\n—— 技能说明书 ——\n步骤 @某节点 /help";
  const assembled = "【背景信息】\n### 输入\n内容\n\n【内容】\n" + raw;
  const out = applySkillWrapToAssembled(assembled, raw, wrapped);
  ok(out.indexOf(raw) < 0 && out.indexOf(wrapped) >= 0, "整段 raw 被技能说明书就地替换");
  ok(out.indexOf("【背景信息】") === 0, "【背景信息】块不受影响");
  ok(out.indexOf("@某节点 /help") > 0, "技能正文里的 @ / / 原样保留（不再被解析）");
  const out2 = applySkillWrapToAssembled("【背景信息】\n\n【内容】\n别的文本", "找不到的原文", wrapped);
  ok(out2.indexOf(wrapped) >= 0 && out2.indexOf("【背景信息】") === 0,
    "原文定位不到时按【内容】标记兜底追加说明书（不丢上文）");
  ok(applySkillWrapToAssembled("", "", wrapped) === wrapped, "空 assembled 时直接返回说明书");
}

console.log("\n[5] i18n：新增两条文案中英成对、无重复键");
ok(
  i18n.indexOf('"提示词 Prompt（@ 引用输入节点 · 输入 / 呼出技能）": "Prompt (@ to reference input nodes · type / for skills)"') >= 0,
  "标签词条中英成对",
);
ok(
  i18n.indexOf('"例如：将输入内容总结为三句话… 输入 @ 引用已连接节点 · 输入 / 或 、 呼出技能":') >= 0 &&
  i18n.indexOf("e.g. Summarize the input in three sentences… type @ to reference connected nodes · type / or 、 for skills") >= 0,
  "占位词条中英成对",
);
for (const key of [
  '"提示词 Prompt（@ 引用输入节点 · 输入 / 呼出技能）"',
  '"例如：将输入内容总结为三句话… 输入 @ 引用已连接节点 · 输入 / 或 、 呼出技能"',
]) {
  const re = new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
  ok((i18n.match(re) || []).length === 1, "无重复键：" + key.slice(0, 22) + "…");
}
ok(
  (i18n.match(/"暂无匹配的命令或技能"/g) || []).length === 1,
  "斜杠菜单词条「暂无匹配的命令或技能」仍只一处（复用，不新增）",
);
ok(
  i18n.indexOf('"任务（输入 / 呼出技能 · @ 引用输入节点）":') >= 0 &&
  i18n.indexOf('"Task (type / for skills · @ to reference inputs)"') >= 0,
  "相邻既有标签词条仍成对",
);

console.log(
  (fails ? "\n✗ FAIL " : "\n✓ 全部 ") +
    checks +
    " 项" +
    (fails ? "，失败 " + fails + " 项" : "通过"),
);
process.exit(fails ? 1 : 0);
