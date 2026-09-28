"use strict";
/**
 * test/smoke-longtask-artifacts.js —— 长周期任务「产物上画布」（产物节点 · 清点 · 逐个放置 · 排版）
 *
 * 用户口径：长任务在每个环节完成时要**清点本次的产物**，把其中**用户该读 / 该收的关键文件**
 * （报告文档 / 数据表 / 成品图）**逐个摆到主画布**并排好版 —— 图片看缩略图、文本给摘要、
 * 其余关键件给路径 + 打开入口；中间件 / 日志 / 音视频不占画布（只摆关键件的口径见 [2] ⓪）；
 * 一件产物一颗节点，按「任务 + 环节 + 文件路径」认人（重跑不堆新的），上游交下来的输入不再摆一遍。
 *
 * 断言按层排：
 *   [1] 装配：index.html 加载顺序 / LOCKED 名单 / app.js 登记与端子 / app-canvas 渲染分支 / css / 指南
 *   [2] 数据层真跑：分类 / 清点（只算本环节自己的）/ 认人复用 / 读不到不摆 / 上限 / 排版不压既有节点
 *   [3] 引擎联动：ltOutputPublish 里真的调了放置（产出节点 + 产物节点两条一起落画布）
 * 只读断言：不改任何文件、不起 Electron（vm 里整份装 app-longtask.js + app-longtask-artifacts.js）。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
/* 行尾统一成 \n：工作区里的源码可能是 CRLF（git autocrlf / 编辑器各异），
   下面有跨行断言（如 NODE_DEFAULTS 的 "ltart: {\n    w: 260,"），不归一就会误报。 */
const read = (rel) => fs.readFileSync(path.join(ROOT, ...rel.split("/")), "utf8").replace(/\r\n?/g, "\n");
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
const NODES = read("renderer/app-nodes.js");
const CANVASJS = read("renderer/app-canvas.js");
const HELP = read("renderer/app-nodehelp.js");
const I18N_SRC = read("renderer/i18n.js");
const HTML = read("renderer/index.html");
const LTCSS = read("renderer/css/longtask.css");
const LTV = read("renderer/app-longtask.js");
const LTARTJS = read("renderer/app-longtask-artifacts.js");
const MANUAL = read("guides/manual/longtask.md");

/* ═══════════════ [1] 装配与文档（静态） ═══════════════ */
console.log("\n[1] 装配：加载顺序 / LOCKED / 登记与端子 / 渲染分支 / css / 指南");
has(HTML, '<script src="app-longtask-artifacts.js"></script>', "index.html 引入 app-longtask-artifacts.js");
ok(
  HTML.indexOf('src="app-longtask.js"') >= 0 &&
    HTML.indexOf('src="app-longtask.js"') < HTML.indexOf('src="app-longtask-artifacts.js"'),
  "加载顺序在 app-longtask.js 之后（用到它的登记层与 makeNode）",
);
has(LTV, 'LOCKED: ["deliver", "ltout", "ltart"]', "LT.LOCKED 含 ltart（手动 / 复制 / 智能体建图三处闸都读它）");
has(APP, 'ltart: "ltart"', "KIND_CLS 有 ltart → 主画布按类上色");
has(APP, "ltart: {\n    w: 260,", "NODE_DEFAULTS 有 ltart（渲染 / 尺寸 / 字段缺省都靠它）");
has(APP, 'if (n.kind === "ltart") return 0;', "输出端子 0 个（产物节点不向下游出数据）");
has(APP, 'if (node.kind === "ltart") return 0;', "输入端子 0 个（连不了线）");
has(APP, 'ltart: "产物"', "kind 名显示为「产物」");
has(APP, 'ltart: "产物节点（长周期任务 · 每件产物一颗 · 板身预览 · ✎ 编辑保存 · ⇢ 打开）"', "设置项用途说明到位（含头部 ✎ 编辑保存入口）");
has(CANVASJS, "function buildLtartBody(", "板身按产物类型预览（buildLtartBody）");
has(CANVASJS, "function ltartOpenButtonEl(", "头部有「用系统程序打开」入口");
has(CANVASJS, 'if (node.kind === "ltart") {', "节点头部走 ltart 分支");
has(CANVASJS, "buildLtartBody(node, body);", "buildBody 分派到 ltart 板身");
has(CANVASJS, "fileUrlWithBust(p, bust)", "预览走 file:// URL + bust（同路径覆盖后不吃缓存）");
has(LTCSS, ".wf-node.ltart {", "产物节点有 .ltart 一族配色");
has(LTCSS, "body.theme-light .wf-node.ltart", "浅色主题同口径");
has(LTCSS, ".n-ltart-stage", "预览舞台有样式");
has(LTCSS, ".n-ltart-path", "完整路径有样式");
has(HELP, "ltart:", "app-nodehelp 的 KIND_HELP 有它（? 按钮不说「暂无说明」）");
/* ── 产物所在文件夹（头部 📁）：长任务产物常扎堆在一个输出目录里，用户的下一个动作
   多半是去那个目录接着翻别的文件，所以头部再给一枚「打开所在文件夹」（与 ⇢ 同排）。
   这里既钉静态入口 / 通道 / 样式 / 词条，也把文件夹路径的切分纯函数真跑一遍。 */
has(CANVASJS, "function ltartDirOf(", "有从产物路径切出文件夹的纯函数（不动 node 字段）");
has(CANVASJS, "function ltartFolderButtonEl(", "头部有「打开所在文件夹」入口按钮");
has(CANVASJS, 'b.className = "n-play n-ltart-folder";', "按钮走 .n-play + 专属 .n-ltart-folder");
has(CANVASJS, "head.appendChild(ltartFolderButtonEl(node));", "ltart 节点头部真的摆了这枚按钮");
has(
  CANVASJS,
  'if (String(node.ltFile || "").trim()) head.appendChild(ltartFolderButtonEl(node));',
  "没有文件路径时不摆空按钮（点了只会弹提示）",
);
has(CANVASJS, "window.api.shellShowItem(p)", "走 shellShowItem（在文件管理器中定位并选中该文件）");
has(CANVASJS, "window.api.shellOpenPath(dir)", "老 preload 没有 showItem 通道时退回 shellOpenPath(文件夹)");
has(LTCSS, ".wf-node.ltart .n-head .n-ltart-folder", "这枚按钮与 ⇢ / ✎ 同排等宽、不参与收缩（挤不没）");
has(I18N_SRC, '"打开这件产物所在的文件夹（在文件管理器中显示）"', "i18n 表里有按钮 tooltip 词条");
has(I18N_SRC, '"打开产物所在文件夹"', "i18n 表里有 aria-label 词条");
has(I18N_SRC, "shown in the file manager", "英文词条成对（切英文不回中文）");
has(HELP, "点 📁 打开它所在的文件夹", "? 按钮说明里也提到这枚入口");
has(read("guides/nodes/ltart.md"), "📁", "指南写明「打开所在文件夹」入口");
has(read("guides/nodes/en/ltart.md"), "Open its folder", "英文指南成对（AGENTS：指南中英同步）");
{
  /* 切分纯函数真跑：Windows 反斜杠 / POSIX 正斜杠 / 盘符根 / 根 / 相对 / 无分隔符。
     ltartDirOf 自包含（不引用任何画布全局），可单独在 vm 里装起来验行为。 */
  const fnSrc = (CANVASJS.match(/function ltartDirOf\(p\) \{[\s\S]*?\n\}/) || [])[0];
  ok(!!fnSrc, "能在源码里切出 ltartDirOf 的函数体");
  const box = {};
  vm.createContext(box);
  vm.runInContext(String(fnSrc || "function ltartDirOf(){return '';}") + "\nthis.dirOf = ltartDirOf;", box);
  const dirOf = box.dirOf;
  const cases = [
    ["C:\\ws\\out\\a.png", "C:\\ws\\out", "Windows 绝对路径切出父目录"],
    ["/home/u/out/a.mp4", "/home/u/out", "POSIX 路径切出父目录"],
    ["out\\sub\\a.md", "out\\sub", "相对路径照切（不特判盘符）"],
    ["E:\\a.png", "E:\\", "盘符根：保留根并补回分隔符（不能切成一截盘符）"],
    ["/a.png", "/", "POSIX 根：留下根"],
    ["a.png", "", "没有分隔符（纯文件名）→ 空串，按钮显式提示而不是瞎猜目录"],
  ];
  for (const [input, want, msg] of cases)
    ok(dirOf(input) === want, msg + "（" + JSON.stringify(input) + " → " + JSON.stringify(dirOf(input)) + "，期望 " + JSON.stringify(want) + "）");
}
for (const k of [
  "产物",
  "产物节点（长周期任务 · 每件产物一颗 · 板身预览 · ✎ 编辑保存 · ⇢ 打开）",
  "用系统默认程序打开这件产物（路径见节点底部）",
  "这类文件不在节点里预览 · 点上方 ⇢ 用系统程序打开",
])
  has(I18N_SRC, '"' + k + '"', "i18n 表里有词条：" + k);
has(I18N_SRC, "one node per artifact", "英文词条成对（切英文不回中文）");
ok(exists("guides/nodes/ltart.md"), "guides/nodes/ltart.md 存在（AGENTS：新增节点类型必须补指南）");
ok(exists("guides/nodes/en/ltart.md"), "guides/nodes/en/ltart.md 存在（中英成对）");
has(read("guides/nodes/index.json"), '"ltart"', "guides/nodes/index.json 登记 ltart");
has(read("guides/nodes/ltart.md"), "一件产物 = 一颗节点", "指南写明「一件产物一颗节点」");
has(read("guides/nodes/ltart.md"), "复用同一颗节点", "指南写明认人复用（重跑不堆）");
has(MANUAL, "产物节点", "应用内手册写明产物节点");
has(MANUAL, "一件一件摆成主画布上的「产物节点」", "手册写明逐件摆上画布的口径");
has(MANUAL, "上游环节交下来的输入文件不会在下游再摆一遍", "手册写明只摆本环节自己的产物");
/* ═══════════════ [2][3] 真跑（vm） ═══════════════ */
async function main() {
  console.log("\n[2] 数据层真跑：分类 / 清点 / 认人复用 / 读不到不摆 / 上限 / 排版");
  const files = new Map();
  const setFile = (p, mtime, size, content) => files.set(String(p), { mtime, size, content });
  let nodeSeq = 0;
  const S = { wf: { id: "wf-art", nodes: [], cam: { x: 0, y: 0, k: 1 } }, config: {}, _skipCanvasHistory: false };
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
    toast() {},
    scheduleSave() {},
    renderCanvas() {},
    focusNode() {},
    addNode(kind, x, y, extra) {
      const n = Object.assign(
        { id: "ltn" + ++nodeSeq, kind: kind, x: x, y: y, w: 360, h: 260, title: kind, text: "" },
        extra || {},
      );
      S.wf.nodes.push(n);
      return n;
    },
    /* app.js 的 makeNode / uniqueNodeTitle 在沙箱里的等价物：本模块只依赖这两个建节点原语 */
    makeNode(kind, x, y) {
      return { id: "ltart" + ++nodeSeq, kind: kind, x: x, y: y, w: 260, h: 210, title: "产物" };
    },
    uniqueNodeTitle(desired) {
      let t = String(desired || "");
      let i = 2;
      while (S.wf.nodes.some((n) => n.title === t)) t = String(desired) + " " + i++;
      return t;
    },
    console, setTimeout, clearTimeout, Map, Set, Promise, JSON, Math, Date, Object, Array, String, Number, RegExp,
  };
  vm.createContext(sandbox);
  vm.runInContext(LTV, sandbox, { filename: "renderer/app-longtask.js" });
  vm.runInContext(LTARTJS, sandbox, { filename: "renderer/app-longtask-artifacts.js" });
  const LA = sandbox.window.LTART;
  const LT = sandbox.window.LT;
  ok(!!sandbox.window.LT && !!LA, "两份脚本在同一沙箱里整份执行并导出 window.LT / window.LTART（顶层不碰 DOM）");

  /* 分类：什么类型走什么预览形态 */
  eqNum(LA.typeOf("C:\\out\\shot01.PNG"), "image", "扩展名大小写不敏感：PNG → 图像");
  eqNum(LA.typeOf("C:\\out\\pilot.mp4"), "video", "mp4 → 视频");
  eqNum(LA.typeOf("C:\\out\\voice.wav"), "audio", "wav → 音频");
  eqNum(LA.typeOf("C:\\out\\shotlist.md"), "text", "md → 文本");
  eqNum(LA.typeOf("C:\\out\\镜头清单.csv"), "text", "中文名的 csv → 文本");
  eqNum(LA.typeOf("C:\\out\\pack.zip"), "file", "未知类型落到「文件」（有路径 + 打开入口，不算漏）");
  eqNum(LA.fileName("C:\\out\\shots\\01.mp4"), "01.mp4", "文件名从任意分隔符里取尾段");

  /* ⓪ 关键文件口径（本轮需求）：清点出来的东西不是全都值得占画布 ——
     画布只摆用户该读 / 该收的（报告文档 / 数据表 / 成品图），中间件与音视频一律不摆。
     只影响**自动摆放**：交付环节用户亲手确认的交付件另走一条，不受这里的裁剪影响。 */
  ok(typeof LA.pickKeyFiles === "function", "导出 pickKeyFiles（清点与挑选分开，ownPaths 口径不动）");
  eqNum(LA.pickClassOf("C:\\out\\shotlist.md"), "doc", "报告文档一行 md → doc");
  eqNum(LA.pickClassOf("C:\\out\\分镜表.pdf"), "doc", "pdf → doc（交付给用户读的成稿）");
  eqNum(LA.pickClassOf("C:\\out\\角色表.csv"), "data", "数据表 csv → data");
  eqNum(LA.pickClassOf("C:\\out\\成片.png"), "image", "成品图 png → image");
  eqNum(LA.pickClassOf("C:\\out\\pilot.mp4"), null, "视频不是「读」的东西 → 不摆（画布上只多一个播放器）");
  eqNum(LA.pickClassOf("C:\\out\\voice.wav"), null, "音频同样不摆");
  eqNum(LA.pickClassOf("C:\\out\\run.log"), null, "运行日志不摆");
  eqNum(LA.pickClassOf("C:\\out\\shots.json"), null, "中间件 JSON 不摆（产出节点引用清单里照旧有）");
  eqNum(LA.pickClassOf("C:\\out\\pack.zip"), null, "归档 / 依赖包不摆");
  eqNum(
    LA.pickKeyFiles([
      "C:\\out\\a.mp4",
      "C:\\out\\b.log",
      "C:\\out\\c.md",
      "C:\\out\\d.csv",
      "C:\\out\\e.png",
      "C:\\out\\f.json",
      "C:\\out\\c.md",
    ]).join("|"),
    "C:\\out\\c.md|C:\\out\\d.csv|C:\\out\\e.png",
    "挑选 = 只留关键件（去重 + 报告 → 数据表 → 成品图的顺序）",
  );
  eqNum(LA.pickKeyFiles(["C:\\out\\a.mp4", "C:\\out\\b.log"]).length, 0, "整轮只有中间件时不摆任何东西（画布保持干净）");
  eqNum(
    LA.pickKeyFiles(["C:\\out\\1.md", "C:\\out\\2.md", "C:\\out\\3.csv"], 2).join("|"),
    "C:\\out\\1.md|C:\\out\\2.md",
    "挑选也吃上限（与产物节点上限同源，不把画布铺满）",
  );

  const mkRun = (uid) =>
    sandbox.ltRunNew({ uid: uid, name: "演示任务", graph: LT.norm({ nodes: [], edges: [] }) }, "wf-art", {});
  const P1 = "C:\\ws\\output\\shots\\pilot.md";
  const P2 = "C:\\ws\\output\\shots\\01.png";
  const P3 = "C:\\ws\\assets\\script\\shotlist.md";
  setFile(P1, 1000, 2048, "");
  setFile(P2, 1000, 4096, "");
  setFile(P3, 1000, 128, "# 分镜\n1. 开场");

  /* ① 清点 + 逐个放置 */
  const runA = mkRun("taskArtA");
  sandbox.ltInst(runA, "", runA.graph);
  let res = await LA.publish(runA, "shots", [P1, P2, P3, P1]);
  eqNum(res.placed, 3, "三件关键文件逐个摆上画布（重复路径只算一件）");
  const arts = S.wf.nodes.filter((n) => n.kind === "ltart");
  eqNum(arts.length, 3, "画布上真的多了三颗 kind ltart 节点");
  const n1 = arts.find((n) => n.ltFile === P1);
  ok(!!n1, "报告那件的节点在");
  eqNum(n1.ltTaskUid, "taskArtA", "节点带任务身份（认人靠它）");
  eqNum(n1.ltPath, "shots", "节点带环节路径");
  eqNum(n1.ltType, "text", "节点带类型（渲染形态按它选）");
  eqNum(n1.ltName, "pilot.md", "节点带文件名");
  eqNum(n1.ltSize, 2048, "节点带大小");
  eqNum(n1.ltMtime, 1000, "节点带 mtime（预览 bust 用）");
  ok(/^产物 · 文本 · pilot\.md$/.test(n1.title), "标题 = 「产物 · 类型 · 文件名」（得到 " + n1.title + "）");
  ok(n1.title.indexOf("产物") === 0, "标题前缀是「产物」");
  const n2 = arts.find((n) => n.ltFile === P2);
  eqNum(n2.ltType, "image", "png 那件按图像渲染");
  const n3 = arts.find((n) => n.ltFile === P3);
  eqNum(n3.ltType, "text", "md 那件按文本给摘要");

  /* ② 认人复用：再发布不新建，只更新指纹 */
  setFile(P1, 2000, 8192, "");
  res = await LA.publish(runA, "shots", [P1, P2, P3]);
  eqNum(res.placed, 0, "再发布：不新建节点");
  eqNum(res.updated, 3, "三件全部走「更新已有节点」");
  eqNum(S.wf.nodes.filter((n) => n.kind === "ltart").length, 3, "画布上仍只有三颗（重跑 / 回跳不堆新节点）");
  eqNum(arts.find((n) => n.ltFile === P1).ltSize, 8192, "已有节点的指纹跟到最新一版");

  /* ③ 只算本环节自己的产物：上游交下来的输入不在下游再摆一遍 */
  const runB = mkRun("taskArtB");
  sandbox.ltInst(runB, "", runB.graph);
  sandbox.ltStatePut(runB, "", "upstream_png", P2); /* 上游环节写进父命名空间 */
  res = await LA.publish(runB, "child", [P2, P3]);
  eqNum(res.placed, 1, "父命名空间里已有的 P2 被剔除（只摆本环节自己的 P3）");
  ok(!S.wf.nodes.some((n) => n.kind === "ltart" && n.ltPath === "child" && n.ltFile === P2), "下游环节没有重复摆上游的图");
  ok(S.wf.nodes.some((n) => n.kind === "ltart" && n.ltPath === "child" && n.ltFile === P3), "本环节自己的产物照摆");
  eqNum(LA.ownPaths(runB, "child", [P2, P3]).join("|"), P3, "ownPaths 直接给出「只剩自己的」那份清单");

  /* ④ 读不到 = 此刻不算产物（不摆死卡） */
  const runC = mkRun("taskArtC");
  sandbox.ltInst(runC, "", runC.graph);
  res = await LA.publish(runC, "shots", ["C:\\ws\\output\\ghost.mp4"]);
  eqNum(res.placed, 0, "读不到的路径不摆（避免画布上出现一张死卡）");

  /* ⑤ 上限：map 展开很多实例时不把画布铺满 */
  const runD = mkRun("taskArtD");
  sandbox.ltInst(runD, "", runD.graph);
  const many = [];
  for (let i = 0; i < 40; i++) {
    const p = "C:\\ws\\output\\bulk\\f" + i + ".txt";
    setFile(p, 1000, 10, "x");
    many.push(p);
  }
  res = await LA.publish(runD, "shots", many);
  eqNum(res.placed, LA.MAX, "单次最多摆 MAX（" + LA.MAX + "）件");

  /* ⑤之二 关键件闸：清点出来的中间件不占画布（本轮需求的核心），
     但清点口径（ownPaths）照旧 —— 文件没丢，只是不摆到画布上。 */
  S.wf.nodes.length = 0;
  const runK = mkRun("taskArtK");
  sandbox.ltInst(runK, "", runK.graph);
  const K1 = "C:\\ws\\raw\\shots.json";
  const K2 = "C:\\ws\\out\\take-01.mp4";
  const K3 = "C:\\ws\\out\\run.log";
  const K4 = "C:\\ws\\out\\报告.md";
  setFile(K1, 1000, 10, "{}");
  setFile(K2, 1000, 10, "");
  setFile(K3, 1000, 10, "");
  setFile(K4, 1000, 10, "# 报告");
  res = await LA.publish(runK, "shots", [K1, K2, K3, K4]);
  eqNum(res.own, 4, "清点口径不动：本环节写出来的四件全部记账");
  eqNum(res.selected, 1, "其中只有报告那件是关键件");
  eqNum(res.placed, 1, "画布上只摆这一件");
  ok(
    S.wf.nodes.some((n) => n.kind === "ltart" && n.ltFile === K4),
    "摆上来的正是报告（用户要读的那件）",
  );
  ok(
    !S.wf.nodes.some((n) => n.kind === "ltart" && [K1, K2, K3].indexOf(n.ltFile) >= 0),
    "中间件 / 视频 / 日志一件都没占画布",
  );

  /* ⑥ 排版：新节点不压住既有节点 */
  S.wf.nodes.length = 0;
  const runE = mkRun("taskArtE");
  sandbox.ltInst(runE, "", runE.graph);
  const blocker = { id: "blk", kind: "input_text", x: 700, y: 0, w: 300, h: 300, title: "挡路的节点" };
  S.wf.nodes.push(blocker);
  setFile("C:\\ws\\output\\layout\\a.png", 1000, 10, "");
  setFile("C:\\ws\\output\\layout\\b.csv", 1000, 10, "");
  await LA.publish(runE, "shots", ["C:\\ws\\output\\layout\\a.png", "C:\\ws\\output\\layout\\b.csv"]);
  const placedNodes = S.wf.nodes.filter((n) => n.kind === "ltart");
  eqNum(placedNodes.length, 2, "两件关键文件都摆上了");
  const hit = (a, b) =>
    !(Number(a.x) + Number(a.w) <= Number(b.x) || Number(b.x) + Number(b.w) <= Number(a.x) || Number(a.y) + Number(a.h) <= Number(b.y) || Number(b.y) + Number(b.h) <= Number(a.y));
  ok(!placedNodes.some((n) => hit(n, blocker)), "新摆的产物节点不压住既有节点（自动找空位）");
  ok(!hit(placedNodes[0], placedNodes[1]), "两件产物彼此也不重叠（按空位网格排开）");

  /* ⑦ Agent 相对路径产物（线上 bug 的回归）：`write` 工具的入参是工作区相对路径
     （assets/H3提示词/shot-01.md），状态里写回的也常是一段含相对路径的散文 ——
     只认「整串绝对路径」会把一整轮产物全部漏掉（用户看到「文件落了盘、画布上什么都没有」）。 */
  S.wf.nodes.length = 0;
  const runG = mkRun("taskArtG");
  sandbox.ltInst(runG, "", runG.graph);
  runG.ws = "C:\\ws";
  const RA1 = "C:\\ws\\assets\\H3提示词\\shot-01.md";
  const RA2 = "C:\\ws\\assets\\H3提示词\\shot-02.md";
  const RA3 = "C:\\ws\\assets\\script\\shotlist.md";
  setFile(RA1, 1000, 100, "# S01");
  setFile(RA2, 1000, 100, "# S02");
  setFile(RA3, 1000, 100, "# 分镜表");
  sandbox.ltNoteArtifactTool(runG, "script", {
    name: "write",
    args: JSON.stringify({ file_path: "assets/H3提示词/shot-01.md", content: "x" }),
  });
  eqNum((runG.arts.script || []).join("|"), RA1, "write 工具的相对入参按工作目录解析成绝对路径记账");
  sandbox.ltNoteArtifactTool(runG, "script", {
    name: "str_replace_editor",
    args: JSON.stringify({ command: "view", path: "assets/H3提示词/shot-02.md" }),
  });
  eqNum((runG.arts.script || []).length, 1, "str_replace_editor 的 view（只读）不算产物");
  sandbox.ltNoteArtifactTool(runG, "script", {
    name: "pwsh",
    args: JSON.stringify({ command: "Get-Content assets/H3提示词/shot-02.md" }),
  });
  eqNum((runG.arts.script || []).length, 1, "shell 工具不按入参路径记账（读到的文件不是产物）");
  sandbox.ltNoteArtifactTool(runG, "script", {
    name: "edit",
    args: JSON.stringify({ file_path: "assets/H3提示词/shot-02.md", old_string: "a", new_string: "b" }),
  });
  ok((runG.arts.script || []).indexOf(RA2) >= 0, "edit 改过的文件也算本环节产物");
  eqNum(LA.ownPaths(runG, "script", ["assets/script/shotlist.md"]).join("|"), RA3, "ownPaths 认相对路径");

  sandbox.ltStatePut(
    runG,
    "script",
    "script_path",
    "assets/script/shotlist.md（分镜表·106 秒/12 段）\n根剧本：Deepseek娘与MTNode画布_动画剧本.md",
  );
  setFile("C:\\ws\\Deepseek娘与MTNode画布_动画剧本.md", 1000, 100, "# 剧本");
  let pathsG = await sandbox.ltOutputPathsOf(runG, "script");
  ok(pathsG.indexOf(RA3) >= 0, "状态里的散文也能抽出相对路径（shotlist.md）");
  ok(pathsG.indexOf(RA1) >= 0, "工具记账的产物一起进清单（shot-01.md）");
  await sandbox.ltOutputPublish(runG, "script", { text: "本轮正文", files: pathsG });
  const artsG = S.wf.nodes.filter((n) => n.kind === "ltart");
  ok(artsG.some((n) => n.ltFile === RA1), "线上 bug 回归：相对路径写出来的产物真的摆上了画布");
  ok(artsG.some((n) => n.ltFile === RA3), "状态里抽出相对路径的那件也摆上了画布");
  ok(S.wf.nodes.filter((n) => n.kind === "ltout").length === 1, "产出节点照旧落画布");

  /* ⑧ 兜底清点：产物不从工具入参经过（外部程序把文件写进工作目录）时按时间窗扫一遍 */
  S.wf.nodes.length = 0;
  const runH = mkRun("taskArtH");
  sandbox.ltInst(runH, "", runH.graph);
  runH.ws = "C:\\ws";
  const stH = sandbox.ltStat(runH, "shots");
  stH.startedAt = 5000;
  setFile("C:\\ws\\out\\from-shell.md", 6000, 10, "# 导出的报告");
  sandbox.window.api.fileListDir = async (dir) => ({
    ok: true,
    list: [{ name: "from-shell.md", rel: "out/from-shell.md", isDir: false, mtime: 6000 }],
  });
  const scanned = await sandbox.ltStageWindowFiles(runH, "shots");
  eqNum(scanned.join("|"), "C:\\ws\\out\\from-shell.md", "时间窗内新增的文件被兜底清点出来");
  pathsG = await sandbox.ltOutputPathsOf(runH, "shots");
  eqNum(pathsG.length, 1, "状态与工具记账都空手时退回扫工作目录");

  /* ⑨ 旧 checkpoint 救援：早于本功能的 run 里产物一条都没记，点「继续」时按时间窗补摆 */
  S.wf.nodes.length = 0;
  const gI = LT.norm({ nodes: [{ id: "shots", kind: "agent", title: "写分镜", cfg: {} }], edges: [] });
  const runI = sandbox.ltRunNew({ uid: "taskArtI", name: "演示任务", graph: gI }, "wf-art", {});
  sandbox.ltInst(runI, "", runI.graph);
  runI.ws = "C:\\ws";
  const stI = sandbox.ltStat(runI, "shots");
  stI.status = "done";
  stI.startedAt = 5000;
  stI.finishedAt = 9000;
  setFile("C:\\ws\\out\\legacy.md", 6000, 10, "# 旧现场");
  sandbox.window.api.fileListDir = async () => ({
    ok: true,
    list: [{ name: "legacy.md", rel: "out/legacy.md", isDir: false, mtime: 6000 }],
  });
  eqNum(await sandbox.ltArtRescueDone(runI), 1, "旧 checkpoint 的环节按自己的时间窗补摆产物");
  ok(
    S.wf.nodes.some((n) => n.kind === "ltart" && n.ltFile === "C:\\ws\\out\\legacy.md"),
    "补摆的正是这个窗口里写出来的那件",
  );
  eqNum(await sandbox.ltArtRescueDone(runI), 0, "已经有产物节点的环节不再重复扫（幂等）");

  /* ═══════════════ [3] 引擎联动 ═══════════════ */
  console.log("\n[3] 引擎联动：ltOutputPublish 里真的调了放置（产出节点 + 产物节点一起落画布）");
  S.wf.nodes.length = 0;
  has(LTV, "if (typeof ltArtPublish === \"function\") {", "引擎按全局判空调用放置（模块缺席也不拦断产出回流）");
  has(LTV, "if (type === \"tool\") ltNoteArtifactTool(run, path, data);", "引擎在 Agent 事件流上真记写文件工具入参");
  has(LTV, "const LT_ART_WRITE_TOOL =", "写文件工具名单是显式常量（不是散落的魔法正则）");
  has(LTV, "run.ws = ws;", "运行工作目录记进 run（相对路径解析的根）");
  has(LTV, "const back = await ltArtRescueDone(j);", "打开画布（ltRestore）时对旧 checkpoint 补摆产物");
  has(LTV, "const back = await ltArtRescueDone(run);", "点「▶ 继续」（ltResume）时同样补摆一次");
  has(I18N_SRC, '"旧版本留下的现场：已把 "', "补摆日志有 i18n 词条（切英文不回中文）");
  has(I18N_SRC, "artifacts onto the canvas", "补摆日志英文成对");
  const runF = mkRun("taskArtF");
  sandbox.ltInst(runF, "", runF.graph);
  const pF = "C:\\ws\\output\\linked\\final.md";
  setFile(pF, 3000, 999, "");
  sandbox.ltStatePut(runF, "shots", "shot_file", pF); /* Agent 把落盘路径写回本环节状态 */
  await sandbox.ltOutputPublish(runF, "shots", { text: "本环节正文", files: await sandbox.ltOutputPathsOf(runF, "shots") });
  eqNum(S.wf.nodes.filter((n) => n.kind === "ltout").length, 1, "产出节点照旧落画布（产出回流没有被动过）");
  const linked = S.wf.nodes.filter((n) => n.kind === "ltart");
  eqNum(linked.length, 1, "产物节点同一次发布就摆上来了（引擎联动真的通）");
  eqNum(linked[0].ltFile, pF, "摆的正是本环节落盘的那件产物");
  eqNum(linked[0].ltPath, "shots", "归属到本环节路径");

  /* ═══════════════ [9] 真跑：入口显隐 + 保存后刷新 ═══════════════ */
  console.log("\n[9] 真跑：✎ 入口显隐 / 保存事件 → 重读指纹刷新板身");
  /* ltartEditButtonEl / ltartRefreshSavedFile 引用的画布全局（document / S / toast / I18n /
     scheduleSave / renderCanvas / window.api）在这里都补成最小桩：只需要装这两个函数体，
     不整份跑 app-canvas.js（顶层会碰真实 DOM）。带 I18n.t 前缀的字符串取值，与运行期一致。 */
  {
    const grab = (name) =>
      (CANVASJS.match(new RegExp("function " + name + "\\([^)]*\\)[ \\t]*\\{[\\s\\S]*?\\n\\}")) || [])[0];
    /* 装真身：类型判定 + 三枚同排入口 + 编辑入口 + 刷新函数 + 监听，都是 app-canvas.js 里的原文；
       只把它们的画布全局（document / S / toast / I18n / scheduleSave / renderCanvas / api）补成桩。
       只读预览入口（ltartTextPreviewButtonEl）已随本轮「移除预览、只留编辑」删除，不再切它。 */
    const typeFn = grab("ltartTypeOfNode");
    const openFn = grab("ltartOpenButtonEl");
    const folderFn = grab("ltartFolderButtonEl");
    const editFn = grab("ltartEditButtonEl");
    const refreshFn = grab("ltartRefreshSavedFile");
    const listenerSrc = (CANVASJS.match(/document\.addEventListener\("mtnode:file-saved"[\s\S]*?\n  \}\);/) || [])[0];
    ok(
      !!typeFn && !!openFn && !!folderFn && !!editFn && !!refreshFn && !!listenerSrc,
      "能在源码里切出类型判定 / 三枚入口 / 刷新函数 / 保存监听的全部函数体",
    );
    const listeners = {};
    const saved = { count: 0, auto: 0, renders: 0 };
    const statByPath = {
      "C:\\ws\\out\\shot.md": { ok: true, size: 4321, mtime: 7777 },
      "C:\\ws\\out\\other.md": { ok: true, size: 9, mtime: 8 },
    };
    const opened = [];
    const nodeEdit = { id: "e1", kind: "ltart", title: "产物 · 文本 · shot.md", ltFile: "C:\\ws\\out\\shot.md", ltSize: 100, ltMtime: 1000 };
    const nodeOther = { id: "e2", kind: "ltart", title: "产物 · 文本 · other.md", ltFile: "C:\\ws\\out\\other.md", ltSize: 1, ltMtime: 1 };
    const nodeImage = { id: "e3", kind: "ltart", title: "产物 · 图像 · a.png", ltFile: "C:\\ws\\out\\a.png", ltSize: 10, ltMtime: 2 };
    const nodeNoPath = { id: "e4", kind: "ltart", title: "产物 · 文本（旧版）", ltFile: "", ltSize: 0, ltMtime: 0 };
    const box = {
      S: { wf: { nodes: [nodeEdit, nodeOther, nodeImage, nodeNoPath] } },
      I18n: { t: (s) => s },
      toast(msg, kind) { box.toasts.push([msg, kind]); },
      toasts: [],
      renderCanvas() {
        saved.renders++;
      },
      scheduleSave(auto) {
        saved.count++;
        if (auto === true) saved.auto++;
      },
      window: {
        LTART: LA,
        api: {
          fileStat: async (p) => statByPath[String(p)] || { ok: false, exists: false },
          fileReadText: async () => ({ ok: true, exists: true, content: "x" }),
        },
      },
      openTextViewer(p) {
        opened.push(p);
      },
      document: {
        createElement(tag) {
          if (String(tag) !== "button") return {};
          return {
            tagName: "button",
            setAttribute() {},
            getAttribute() {
              return "";
            },
          };
        },
        addEventListener(type, fn) {
          (listeners[type] = listeners[type] || []).push(fn);
        },
      },
      console, Promise, Math, Number, String, Object, Array, JSON,
    };
    box.globalThis = box;
    vm.createContext(box);
    vm.runInContext(
      [
        typeFn || "function ltartTypeOfNode(){return 'file';}",
        openFn || "function ltartOpenButtonEl(){return null;}",
        folderFn || "function ltartFolderButtonEl(){return null;}",
        editFn || "function ltartEditButtonEl(){return null;}",
        refreshFn || "function ltartRefreshSavedFile(){return Promise.resolve(0);}",
        listenerSrc || "",
        "this.typeOfNode = ltartTypeOfNode;",
        "this.editButtonEl = ltartEditButtonEl;",
        "this.refreshSaved = ltartRefreshSavedFile;",
        /* buildBody 的 ltart 头部分支（原文口径）：⇢ → 📁（有路径）→ 文本类再 ✎（有路径）。
           这里逐字照 app-canvas.js 的 if 条件重演一遍，验证的是真函数在真分支下的显隐。
           本轮已移除与 ✎ 重复的 👁 只读预览，头部只剩这三枚。 */
        "this.headButtonsOf = function (node) {",
        "  const head = { list: [], appendChild(el) { this.list.push(el && el.className); return el; } };",
        "  if (node.kind !== 'ltart') return head.list;",
        "  head.appendChild(ltartOpenButtonEl(node));",
        "  if (String(node.ltFile || '').trim()) head.appendChild(ltartFolderButtonEl(node));",
        "  if (ltartTypeOfNode(node) === 'text') {",
        "    if (String(node.ltFile || '').trim()) head.appendChild(ltartEditButtonEl(node));",
        "  }",
        "  return head.list;",
        "};",
      ].join("\n"),
      box,
      { filename: "renderer/app-canvas.js[ltart-head]" },
    );
    /* ① 入口：文本类产物给按钮、非文本 / 无路径不摆空按钮 */
    ok(typeof box.editButtonEl === "function", "ltartEditButtonEl 在 vm 里可执行（真函数原文）");
    const okBtn = box.editButtonEl(nodeEdit);
    ok(
      !!okBtn && okBtn.className === "n-play n-ltart-edit" && okBtn.textContent === "✎",
      "文本类产物的按钮 = ✎ + .n-play .n-ltart-edit（与 ⇢/📁 同排，👁 预览已移除）",
    );
    /* ② 点击走 openTextViewer（同一套既有编辑器，保存写回原文件） */
    okBtn.onclick({ preventDefault() {}, stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 0));
    ok(opened.join("|") === "C:\\ws\\out\\shot.md", "点 ✎ 走 openTextViewer(node.ltFile)（得到 " + opened.join("|") + "）");
    ok(box.toasts.length === 0, "入口就绪时不弹任何提示（只有缺通道才显式 toast）");
    /* ③ 头部真摆了这枚按钮：文本类有路径 → 有 ✎；非文本 / 无路径 → 没有（不摆空按钮） */
    ok(
      box.headButtonsOf(nodeEdit).indexOf("n-play n-ltart-edit") >= 0,
      "头部分支在文本类产物上摆了 ✎（与 ⇢/📁 同排，👁 预览已移除）",
    );
    ok(
      box.headButtonsOf(nodeImage).indexOf("n-play n-ltart-edit") < 0,
      "非文本类产物不摆 ✎（真类型判定说了算）",
    );
    ok(
      box.headButtonsOf(nodeNoPath).indexOf("n-play n-ltart-edit") < 0,
      "没有文件路径的旧版节点不摆空按钮（点上只会弹提示）",
    );
    /* ④ 保存广播 → 命中的节点重读指纹 + 重渲染 + 落盘；其它类型 / 空路径不动 */
    eqNum(listeners["mtnode:file-saved"] ? listeners["mtnode:file-saved"].length : 0, 1, "保存监听挂了一次（document 级）");
    const before = { other: nodeOther.ltMtime, image: nodeImage.ltMtime, noPath: nodeNoPath.ltMtime };
    const fire = (path) => {
      for (const fn of listeners["mtnode:file-saved"] || []) fn({ detail: { path: path, source: "viewer" } });
    };
    fire("C:\\ws\\out\\shot.md");
    await new Promise((r) => setTimeout(r, 0));
    eqNum(nodeEdit.ltSize, 4321, "保存后命中节点重读出新的体积");
    eqNum(nodeEdit.ltMtime, 7777, "保存后命中节点重读出新的 mtime（板身摘要据它 bust）");
    ok(saved.renders === 1, "整面重渲染一次（得到 " + saved.renders + "）");
    ok(saved.count === 1 && saved.auto === 1, "刷新后落盘一次且是 auto=true（重开画布不回退）");
    eqNum(
      [nodeOther.ltMtime, nodeImage.ltMtime, nodeNoPath.ltMtime].join("|"),
      [before.other, before.image, before.noPath].join("|"),
      "其它产物节点 / 非文本件 / 空路径节点一律不动",
    );
    /* ⑤ 保底：路径为空或文件读不到时不炸、也不瞎写指纹 */
    fire("");
    fire("C:\\ws\\out\\ghost.md");
    await new Promise((r) => setTimeout(r, 0));
    eqNum(nodeEdit.ltMtime, 7777, "空路径 / 读不到的路径都不改动已有指纹（保底不踩空）");
  }

  /* ═══════════════ [9] 编辑保存入口（头部 ✎ · 保存即刷新） ═══════════════ */
  console.log("\n[9] 编辑保存入口：头部 ✎ / 复用可编辑阅读器 / 保存广播 → 节点刷新 / css / 词条 / 指南");
  has(CANVASJS, "function ltartEditButtonEl(", "有头部「✎ 编辑保存」入口按钮（不另造第二套编辑器）");
  has(CANVASJS, 'b.className = "n-play n-ltart-edit";', "按钮走 .n-play + 专属 .n-ltart-edit");
  has(
    CANVASJS,
    'if (String(node.ltFile || "").trim()) head.appendChild(ltartEditButtonEl(node));',
    "只有文本类产物且真有文件路径时才摆这枚按钮（空路径 / 非文本不摆空按钮）",
  );
  has(CANVASJS, 'ltartTypeOfNode(node) === "text"', "显隐按产物类型判定（文本件才给编辑保存）");
  has(
    CANVASJS.match(/function ltartEditButtonEl\(node\) \{[\s\S]*?\n\}/) || "",
    "openTextViewer",
    "复用应用内既有可编辑阅读器（.md 走 Markdown 阅读器、其它文本走行视图，保存写回原文件）",
  );
  has(
    CANVASJS,
    'toast(I18n.t("文本阅读器不可用（当前环境未就绪）"), "warn")',
    "阅读器未就绪时显式 toast（不静默、不阻断重绘）",
  );
  has(
    CANVASJS,
    'toast(I18n.t("无法编辑这件产物（当前环境不支持读写本地文件）"), "warn")',
    "没有本地读写通道时显式 toast（不静默）",
  );
  has(CANVASJS, 'toast(I18n.t("这件产物没有文件路径"), "warn")', "旧版节点没有文件路径时显式 toast（不瞎猜路径）");
  /* 保存广播：两条阅读器落盘成功各广播一次（虚拟文档分支不受影响），画布侧一次监听就地刷新 */
  has(
    APP,
    'new CustomEvent("mtnode:file-saved", { detail: { path: p, source: "viewer" } }),',
    "saveMdViewer / saveYamlViewer 落盘成功后广播 mtnode:file-saved（写盘是阅读器本人，画布只被动刷新）",
  );
  has(
    CANVASJS,
    'document.addEventListener("mtnode:file-saved", function (ev) {',
    "app-canvas 侧挂了一次监听（与 factlib:saved 同风格）",
  );
  has(CANVASJS, "ltartRefreshSavedFile(d && d.path);", "监听把路径交给刷新函数（其余节点原样不动）");
  has(CANVASJS, "function ltartRefreshSavedFile(path) {", "有「保存即刷新节点」的刷新函数");
  has(CANVASJS, 'n.kind === "ltart" && String(n.ltFile || "").trim() === want', "只认 ltFile 对得上的产物节点");
  has(CANVASJS, "n.ltSize = Number(st.size) || 0;", "重读文件大小写回节点");
  has(
    CANVASJS,
    "n.ltMtime = Number(st.mtime) || 0;",
    "重读 mtime 写回节点（板身摘要 / 预览的 bust 靠它，不刷新会一直显示旧内容）",
  );
  has(CANVASJS, 'if (typeof scheduleSave === "function") scheduleSave(true);', "指纹变了就地落盘（重开画布不回退）");
  has(CANVASJS, 'if (typeof renderCanvas === "function") renderCanvas();', "整面重渲染一次（板身摘要立刻跟上）");
  has(LTCSS, ".wf-node.ltart .n-head .n-ltart-edit", "这枚按钮与 ⇢ / 📁 同排等宽、不参与收缩（挤不没）");
  has(read("guides/nodes/ltart.md"), "编辑保存", "指南写明「编辑保存」入口");
  has(read("guides/nodes/en/ltart.md"), "Edit & save", "英文指南成对（AGENTS：指南中英同步）");
  has(MANUAL, "✎ 编辑保存", "应用内手册产物节点段补了同一句");
  /* 本轮需求「移除预览、只留编辑」：预览窗模块已删，头部不再有重复的 👁 */
  hasnt(CANVASJS, "ltartTextPreviewButtonEl", "头部不再有 👁 只读预览入口（与 ✎ 重复的那一半已移除）");
  ok(!exists("renderer/app-textpreview.js"), "renderer/app-textpreview.js 已删除");
  for (const k of [
    "编辑这件文本产物并保存回文件（Markdown 阅读器 / 行视图，保存写回原文件）",
    "编辑并保存文本产物",
    "文本阅读器不可用（当前环境未就绪）",
    "无法编辑这件产物（当前环境不支持读写本地文件）",
  ])
    has(I18N_SRC, '"' + k + '"', "i18n 表里有编辑保存词条：" + k);
  has(I18N_SRC, "Edit this text artifact and save it back to the file", "英文词条成对（切英文不回中文）");

  console.log("\n" + (fails ? "FAILED " + fails + " / " + checks + " checks" : "ALL OK  " + checks + " checks"));
  process.exit(fails ? 1 : 0);
}

main().catch((e) => {
  console.error("smoke-longtask-artifacts crashed:", (e && e.stack) || e);
  process.exit(1);
});
