/* 「这轮任务跟画布有关吗」自动判定回归（撤掉手动「与画布无关」按钮后的唯一判据）
 *   node test/smoke-canvas-intent.js
 *
 * 本次需求：会话 / 助手输入区上方那枚「与画布无关」按钮移除，改为 AI（宿主侧）按任务
 * 自动判定 —— 判定与画布无关就**不注册画布 / 应用工具、也不注入画布快照**（省 token）；
 * **判不准一律按「有关」处理**（宁可多带一次画布工具，也不让模型撞上不存在的工具）。
 *
 * 这里跑 renderer/app-assist.js 里那个真函数（按锚点原样抠出来在 vm 里跑），钉三件事：
 *   ① 明确指向画布 / 节点图的措辞 → 有关；
 *   ② 明确声明无关 / 与工程无关的措辞 → 无关（这一条才真的省那 26K 字符/步）；
 *   ③ 其余（空消息、闲聊、读文件、写代码、纯英文任务）→ 有关（默认档，绝不误抽）；
 *   ④ 接续轮：这一轮没复述关键词，但最近几轮在讲画布 → 有关；
 *   ⑤ 接线：会话侧 turnCanvasFree / 助手侧 assistCanvasFree 都只由这一个判据产生，
 *      两处按钮在 index.html 里已不存在（改回手动档 = 这条断言先红）。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const ASSIST = fs.readFileSync(path.join(ROOT, "renderer", "app-assist.js"), "utf8");
const HTML = fs.readFileSync(path.join(ROOT, "renderer", "index.html"), "utf8");

let fails = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ok    " : "FAIL  ") + msg);
  if (!cond) fails++;
};
const eq = (got, want, msg) => ok(got === want, msg + "（得到 " + JSON.stringify(got) + "）");

/* 按锚点把真函数抠出来（不引整份 app-assist.js：它顶层就要 DOM / 全局） */
function grabFunction(src, name) {
  const re = new RegExp("^(?:async\\s+)?function\\s+" + name + "\\s*\\(", "m");
  const m = re.exec(src);
  if (!m) {
    ok(false, "app-assist.js 里应定义函数 " + name);
    return "";
  }
  const open = src.indexOf("{", src.indexOf(")", m.index));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(m.index, i + 1);
    }
  }
  ok(false, name + " 的括号没配平");
  return "";
}

const sb = { console, String, Array, RegExp };
vm.createContext(sb);
vm.runInContext(
  grabFunction(ASSIST, "agentCanvasTurnRelated") +
    "\n" +
    grabFunction(ASSIST, "assistCanvasTurnRelated") +
    "\nglobalThis.__rel = agentCanvasTurnRelated;\nglobalThis.__relA = assistCanvasTurnRelated;",
  sb,
  { filename: "app-assist.js#canvas-intent" },
);
const related = sb.__rel;
const relatedA = sb.__relA;
ok(typeof related === "function", "抠到 agentCanvasTurnRelated 真函数");
ok(typeof relatedA === "function", "抠到助手侧包装 assistCanvasTurnRelated");

console.log("\n[1] 明确指向画布 / 节点图的措辞 → 有关（照常读画布）");
for (const s of [
  "帮我把这三张图连成批处理",
  "总结一下这张画布",
  "这个工作流跑不通，看看哪一步",
  "给『文本节点 2』换个模型",
  "把输出端子拖到空白处建一个保存节点",
  "整理一下排版，控制节点放上面",
  "接一个数据库副本进来",
  "@内容条目 引用一下",
  "check the nodes on this canvas",
  "wire the prompt to the image node",
]) {
  eq(related(s), true, "有关：" + s.slice(0, 18));
}

console.log("\n[2] 明确声明无关 → 无关（这一条才真的省下画布工具与快照）");
for (const s of [
  "这个任务与画布无关，帮我改一下 README",
  "跟画布无关，只看这个文件",
  "不用管画布，读一下 E:\\dev\\a.md",
  "canvas-free task: rewrite these docs",
]) {
  eq(related(s), false, "无关：" + s.slice(0, 18));
}

console.log("\n[3] 判不准一律按「有关」处理（默认档，绝不误抽画布工具）");
for (const s of [
  "",
  "你好",
  "帮我写一篇 800 字的说明文",
  "读一下 E:\\dev\\tools\\pipeline-console\\README.md",
  "跑一下 npm test 看看",
  "translate this paragraph into Japanese",
]) {
  eq(related(s), true, "按有关（兜底）：" + (s ? s.slice(0, 18) : "（空消息）"));
}

console.log("\n[4] 接续轮：这一轮没复述关键词，但最近几轮在讲画布 → 仍有关");
eq(related("继续", ["帮我把这三张图连成批处理"]), true, "「继续」+ 上一轮在讲画布 → 有关（上下文还在图上）");
eq(related("改一下颜色", ["给保存节点换个目录"]), true, "「改一下颜色」+ 上一轮讲节点 → 有关");
eq(related("继续", ["读一下 README", "跑一下测试"]), true, "最近几轮与画布无关也仍按「有关」兜底（不误抽）");
eq(related("继续", []), true, "没有历史 → 兜底按有关");
eq(related("与画布无关", ["帮我把这三张图连成批处理"]), false, "本轮明说无关 → 照本轮说的办（不看历史）");
eq(relatedA("帮我把这三张图连成批处理"), true, "助手侧包装同一判据（有关）");
eq(relatedA("这个任务与画布无关"), false, "助手侧包装同一判据（无关）");

console.log("\n[5] 接线：两处判据只由这一个函数产生；手动的按钮已移除");
ok(ASSIST.indexOf("const turnCanvasFree =") >= 0 && /!!st\.canvasFree \|\|/.test(ASSIST),
  "会话侧 turnCanvasFree = 显式声明 ∪ 自动判定（显式位留给插件修复等特殊入口）");
ok(ASSIST.indexOf("!agentCanvasTurnRelated(t, agentSessionUserHistory(st, null))") >= 0,
  "会话侧自动判定读「这轮消息 + 最近几轮用户消息」");
ok(ASSIST.indexOf("noCanvas: turnCanvasFree,") >= 0, "会话侧下发 noCanvas = turnCanvasFree（人设与整档闸同源）");
ok(ASSIST.indexOf("const assistCanvasFree = !assistCanvasTurnRelated(t)") >= 0,
  "助手侧改成按这条消息自动判定（不再读 S.assistCanvasFree）");
ok(ASSIST.indexOf("noCanvas: assistCanvasFree,") >= 0, "助手侧下发 noCanvas = assistCanvasFree");
ok(ASSIST.indexOf("S.assistCanvasFree\n") < 0, "运行路径里不再有读 S.assistCanvasFree 的判据");
const assistRuns = ASSIST.split("\n").filter(
  (l) =>
    /S\.assistCanvasFree/.test(l) &&
    !/S\.config\.assistCanvasFree\s*=/.test(l) &&
    l.trim().slice(0, 2) !== "//" &&
    l.trim().slice(0, 1) !== "*" &&
    /;\s*$/.test(l.trim()),
);
ok(assistRuns.length === 0,
  "没有任何读 S.assistCanvasFree 的活代码（落盘兼容位那一行是赋值不是判据，得到 " + assistRuns.length + " 处）");
ok(HTML.indexOf("agentCanvasFreeTrigger") < 0, "会话输入区的「与画布无关」chip 已从 index.html 移除");
ok(HTML.indexOf("assistCanvasFreeBtn") < 0, "助手栏的「与画布无关」按钮已从 index.html 移除");
ok(HTML.indexOf("assist-canvasfree-btn") < 0, "按钮的样式钩子也不再出现在页面里");
ok(/agentCanvasTurnRelated/.test(HTML), "index.html 的注释指向自动判定函数（后来人知道判据在哪）");
const BOOT = fs.readFileSync(path.join(ROOT, "renderer", "app-boot.js"), "utf8");
ok(BOOT.indexOf("agentCanvasFreeTrigger") < 0 && BOOT.indexOf("assistCanvasFreeBtn") < 0,
  "app-boot.js 里不再绑定这两个按钮");
const CSS = fs.readFileSync(path.join(ROOT, "renderer", "css", "assist.css"), "utf8");
ok(CSS.indexOf(".assist-canvasfree-btn") < 0, "assist.css 里那条按钮样式已删（不留死选择器）");
const LIGHT = fs.readFileSync(path.join(ROOT, "renderer", "css", "theme-light.css"), "utf8");
ok(LIGHT.indexOf(".assist-canvasfree-btn") < 0, "theme-light.css 里的亮色覆盖也一并删了");

console.log("\n[6] AI 自己也要判相关性（宿主关键词档只是省钱的前置闸，判不准仍按有关）");
ok(ASSIST.indexOf("任务相关性纪律：本轮先自己判断任务是否与画布有关") >= 0,
  "会话人设写明 AI 自己判：无关就别读画布（不调 mtnode_canvas_get）、用文件 / 联网 / 命令把活做完");
const relLines = ASSIST.split("\n").filter((l) => /相关性：先自己判断本轮任务是否与画布有关/.test(l)).length;
ok(relLines === 2, "助手人设两条工作范围分支（本画布 / 全局）都写了相关性纪律（得到 " + relLines + " 处）");

console.log(fails ? "\n✗ " + fails + " 项失败" : "\n✓ 全部通过  (smoke-canvas-intent)");
process.exit(fails ? 1 : 0);
