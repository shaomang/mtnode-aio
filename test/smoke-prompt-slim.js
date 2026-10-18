"use strict";
/* 前置 Prompt 瘦身回归（本次开发需求）
 *   node test/smoke-prompt-slim.js
 *
 * 用户拷问定下的口径（本文件逐条钉住）：
 *   [1] 系统提示只留硬闸：自检纪律压成四条短句 + 一句指向技能 mtnode-self-check；
 *       被删的软性条目（不空转 / 长任务建图建议 / 浏览器留痕）只在技能里，不再随每轮重发。
 *   [2] 拷问契约只留「触发句 + 收尾卡格式」；询问窗 / multi_select / 推荐项 / 禁止正文列
 *       问题的细则唯一真源 = 内置技能 mtnode-grill-me，契约不再抄第二份。
 *   [3] 三段会话人设都压成「身份 + 硬闸 + 一句指向」，总长有上限。
 *   [4] 技能索引每行只给 name + title + 一句话（首个分句 ≤ 60 字），整块有上限。
 *   [5] 开发 / 细化任务书只留五要素（模块名 + 项目根 + AGENTS.md 指向 + 本次需求原文 +
 *       画布禁改 / 收尾回写），静态骨架 ≤ 1500 字；子元素清单与 note 两段长文不再进提示。
 *   [6] 新技能文件真存在、真进了索引（skill 工具能按名字找到）。
 * 纯静态 + 真跑两段函数（vm 抠原文）：不拉浏览器、不碰 Electron。 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let checks = 0;
let fails = 0;
function ok(cond, msg) {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
}
function has(src, needle, msg) {
  ok(String(src).indexOf(needle) >= 0, msg + " · 源码含 " + JSON.stringify(String(needle).slice(0, 40)));
}
function no(src, needle, msg) {
  ok(String(src).indexOf(needle) < 0, msg + " · 源码不含 " + JSON.stringify(String(needle).slice(0, 40)));
}

const ROOT = path.join(__dirname, "..");
const read = (rel) =>
  fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8").replace(/\r\n/g, "\n");

const ASSIST = read("renderer/app-assist.js");
const APP = read("renderer/app.js");
const LIB = read("mtnode-agent-skills-lib.js");
const SELF_SKILL = read("mtnode-agent-skills/mtnode/self-check/SKILL.md");
const GRILL_SKILL = read("mtnode-agent-skills/mtnode/grill-me/SKILL.md");
const INDEX = JSON.parse(read("mtnode-agent-skills/index.json"));

/* 从源码里求值一个 const 声明（与 smoke-ask-summary 同一口径） */
function evalConst(src, name) {
  const re = new RegExp("const " + name + " =\\n([\\s\\S]*?);\\n");
  const m = src.match(re);
  if (!m) return { value: "", found: false };
  try {
    return { value: vm.runInNewContext("(" + m[1] + ")"), found: true };
  } catch (e) {
    return { value: "", found: false, err: e.message };
  }
}

/* ── [1] 自检纪律：四条硬闸 + 一句指向 ─────────────────────────────────────── */
console.log("\n[1] 自检纪律（四条硬闸 + 指向技能）");
const sc = evalConst(ASSIST, "SELF_CHECK_DISCIPLINE");
ok(sc.found, "抠到 SELF_CHECK_DISCIPLINE 常量");
const SCD = sc.value;
ok(SCD.length > 200 && SCD.length <= 900, "自检纪律 ≤ 900 字（实测 " + SCD.length + "）");
for (const [needle, label] of [
  ["browser_help", "硬闸①：浏览器求助走 browser_help"],
  ["ask_user_question", "硬闸①：其它询问走 ask_user_question"],
  ["阶段 / 大步骤后自检", "硬闸②：阶段自检"],
  ["交付前对照最初目标做一次全检", "硬闸②：交付前全检"],
  ["todo_write 清单随手收口", "硬闸③：todo 清单随手收口"],
  ["先自己修好", "硬闸④：先自修"],
  ["硬断言必须给可复核依据", "硬闸④：硬断言带证据"],
  ["mtnode-self-check", "指向技能 mtnode-self-check"],
]) {
  has(SCD, needle, label);
}
/* 软性条目已搬走：系统提示里不许再出现（技能里必须有） */
no(SCD, "长任务不空转", "软性条目「不空转」已移出系统提示");
no(SCD, "长周期任务图", "软性条目「长任务建图建议」已移出系统提示");
no(SCD, "浏览器工作要留下痕迹", "软性条目「浏览器留痕」已移出系统提示");
has(SELF_SKILL, "不空转", "技能 mtnode-self-check 收着「不空转」");
has(SELF_SKILL, "长周期任务图", "技能 mtnode-self-check 收着「长任务建图建议」");
has(SELF_SKILL, "浏览器工作留痕", "技能 mtnode-self-check 收着「浏览器留痕」");

/* ── [2] 拷问契约：触发句 + 收尾卡 ──────────────────────────────────────────── */
console.log("\n[2] 拷问契约（触发句 + 收尾卡，细则指向技能）");
const gc = evalConst(ASSIST, "GRILL_CONTRACT");
ok(gc.found, "抠到 GRILL_CONTRACT 常量");
const GRILL = gc.value;
ok(GRILL.length <= 700, "拷问契约 ≤ 700 字（实测 " + GRILL.length + "）");
has(GRILL, "mtnode-grill-me", "指向技能 mtnode-grill-me");
has(GRILL, "只问不做", "保留「只问不做」硬闸");
has(GRILL, "收尾那张确认卡按固定格式写", "保留收尾确认卡格式");
has(GRILL, "📋 总结", "写明总结渲染去处（与渲染层同源）");
no(GRILL, "ask_user_question", "询问窗细则不再抄在契约里");
no(GRILL, "一次把整个前沿的全部问题问完", "前沿口径不再抄在契约里");
no(GRILL, "multi_select: true", "multi_select 写法不再抄在契约里");
has(GRILL_SKILL, "ask_user_question", "技能里收着询问窗写法");
has(GRILL_SKILL, "`multi_select`：候选可并存时置 `true`", "技能里收着 multi_select 写法");

/* ── [3] 三段会话人设：硬闸 + 指向 ─────────────────────────────────────────── */
console.log("\n[3] 三段会话人设（硬闸 + 一句指向）");
const pFrom = ASSIST.indexOf('let systemPrompt = "";');
const pTo = ASSIST.indexOf("if (!pureMode) systemPrompt += SELF_CHECK_DISCIPLINE;");
ok(pFrom > 0 && pTo > pFrom, "定位会话人设三段源码");
const personaSrc = ASSIST.slice(pFrom, pTo);
ok(personaSrc.length <= 3600, "三段人设源码 ≤ 3600 字符（实测 " + personaSrc.length + "）");
has(personaSrc, "本轮不注册任何画布与应用工具", "无画布档：写明三件套都不注册");
has(personaSrc, "本会话不读取也不修改画布", "只读档：写明不读也不改画布");
has(personaSrc, "只访问本会话绑定的那张画布", "全量档：写明只碰本会话绑定的画布");
has(personaSrc, "mtnode-canvas-edit-rules", "全量档：画布操作规范指向技能");
no(personaSrc, "该画布在会话建立时就已绑定：用户在你运行中途切去其他画布干活", "旧长句已删");
no(personaSrc, "你只能访问本会话所属的那张画布：list_workflows / canvas_get 不会返回其他画布内容。", "旧长句已删（重复表述）");

/* ── [4] 技能索引：name + title + 一句话 ───────────────────────────────────── */
console.log("\n[4] 技能索引（每行一句话 · 有上限）");
const lib = require(path.join(ROOT, "mtnode-agent-skills-lib.js"));
const idx = lib.readIndexAt(path.join(ROOT, "mtnode-agent-skills")) || INDEX;
const compact = lib.compactIndexText(idx);
ok(compact.length <= 2000, "索引块 ≤ 2000 字（实测 " + compact.length + "）");
const rows = compact.split("\n").filter((l) => l.indexOf("- ") === 0);
ok(rows.length >= 10, "索引仍列出全部内置技能（" + rows.length + " 行）");
const descs = rows.map((r) => {
  const parts = r.slice(2).split(" | ");
  return parts.length >= 3 ? parts.slice(2).join(" | ") : "";
});
ok(
  descs.every((d) => d.length <= 61),
  "每行的一句话 ≤ 60 字（最长 " + Math.max.apply(null, descs.map((d) => d.length)) + "）",
);
ok(
  rows.every((r) => r.indexOf("|") > 0),
  "每行仍是 name | title（| 后面才是可选的一句话）",
);
ok(
  rows.some((r) => r.indexOf("mtnode-self-check") === 0 || r.indexOf("- mtnode-self-check") === 0),
  "索引里出现新技能 mtnode-self-check",
);

/* ── [5] 开发任务书：五要素 + ≤ 1500 字 ────────────────────────────────────── */
console.log("\n[5] 开发任务书（五要素 · 静态骨架 ≤ 1500 字）");
const cFrom = APP.indexOf("function devNodeContractText(node");
const cTo = APP.indexOf("/* 该功能块名下的会话");
ok(cFrom > 0 && cTo > cFrom, "定位 devNodeContractText 源码");
const sb = {
  console,
  I18n: {
    t: (s) => {
      if (sb.__keys.indexOf(s) < 0) sb.__keys.push(s);
      return s;
    },
  },
  __keys: [],
  DEV_KIND_LABEL: { module: "模块", file: "文件", class: "类" },
  devKindOf: (n) => (n && n.devKind) || "module",
  devPathOf: () => "E:/dev/tools/pipeline-console",
};
vm.createContext(sb);
vm.runInContext(APP.slice(cFrom, cTo), sb, { filename: "app.js#devNodeContractText" });
vm.runInContext(
  "node = { id: 'n1', title: '测试模块', dev: true, devKind: 'module', devGrill: true }",
  sb,
);
const mk = (req) =>
  vm.runInContext(
    "devNodeContractText(node, " + JSON.stringify(req) + ", { noCanvasRead: true })",
    sb,
  );
const bare = mk("");
const withReq = mk("给下载加超时与重试");
ok(bare.length <= 1500, "静态骨架 ≤ 1500 字（实测 " + bare.length + "）");
ok(
  withReq.indexOf("本次开发需求：给下载加超时与重试") >= 0 &&
    withReq.indexOf("…") < 0,
  "需求原文照抄、不截断",
);
ok(bare.indexOf("本次开发需求：") < 0, "没有需求时不塞空行");
has(bare, "【开发任务书】 测试模块（模块）", "要素①：模块名");
has(bare, "项目根目录：E:/dev/tools/pipeline-console", "要素②：项目根目录");
has(bare, "AGENTS.md", "要素③：AGENTS.md 共识指向");
has(withReq, "本次开发需求：给下载加超时与重试", "要素④：本次需求原文");
has(bare, "画布禁改", "要素⑤：画布禁改（无读画布档）");
has(bare, "不改任何文件、不改画布、不出实施计划、不开工", "拷问开关：只问不做");
no(bare, "本模块已有子元素", "子元素清单不再进提示");
no(bare, "模块功能（面向非技术）", "note 功能段不再进提示");
no(bare, "实现要点（面向技术）", "note 实现段不再进提示");
no(bare, "本会话是代码开发工作", "重复的收尾说明已删");
no(bare, "不要分两次会话输入重复提交", "重复的收尾说明已删");
/* 细化档（可读画布）：仍要求按两段式回写 note / devStatus / devFiles */
const refine = vm.runInContext(
  "devNodeContractText(node, '展开到文件级', {})",
  sb,
);
has(refine, "收尾：按两段式规范", "细化档保留两段式回写要求");
has(refine, "devFiles", "细化档保留 devFiles 回写口径");
/* 中英成对：任务书每条 I18n.t 都得有英文词条，否则英文界面退回中文 */
const I18nMod = require(path.join(ROOT, "renderer", "i18n.js"));
I18nMod.setLocale("en");
const missingEn = sb.__keys.filter((k) => I18nMod.t(k) === k);
I18nMod.setLocale("zh");
ok(
  missingEn.length === 0,
  "任务书每条 I18n.t 都有英文词条（缺：" + missingEn.join(" | ").slice(0, 200) + "）",
);

/* ── [6] 新技能真存在、真进索引 ────────────────────────────────────────────── */
console.log("\n[6] 新技能落位（文件 + frontmatter + 索引）");
has(SELF_SKILL, "name: mtnode-self-check", "SKILL.md frontmatter 有 name");
has(SELF_SKILL, "description:", "SKILL.md frontmatter 有 description（索引的一句话取它的首个分句）");
has(SELF_SKILL, "自检与交付纪律", "SKILL.md 标题是「自检与交付纪律」");
const flat = lib.flattenIndex(idx);
ok(
  flat.some((s) => s.name === "mtnode-self-check"),
  "index.json 收录 mtnode-self-check（skill 工具按名字能找到）",
);
ok(
  lib.skillIndexOneLiner("一句话。后面还有很多字。") === "一句话",
  "一句话 = description 的第一个分句",
);
ok(
  lib.skillIndexOneLiner("很长".repeat(60)).length <= 60,
  "分句过长时截断到 60 字以内",
);

console.log(
  "\n" + (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全部通过") + "  (smoke-prompt-slim)",
);
process.exit(fails ? 1 : 0);
