"use strict";
/**
 * test/smoke-longtask-output.js —— 长周期任务「产出回流」（产出节点 · 编辑感知 · 判不准问用户）
 *
 * 用户口径：长任务执行中生成的信息 / 文件内容要**同步写进画布**上的产出节点，供用户查阅与修改；
 * 用户改过以后，后续环节必须用**改后的内容**；核实不了就必须先问用户，不许按记忆硬跑。
 *
 * 断言按层排：
 *   [1] 登记与建法：kind ltout 登记齐全 / 只由系统建（LT.LOCKED 三道闸）/ 引擎两处发布点
 *   [2] 数据层真跑：ltOutputWrite / ltOutputRead / ltOutputDirty 的 clean / edited / unknown
 *   [3] 回流真跑：prompt 段「以画布为准」/ 判不准落人工确认项 / 答完续跑且不再反复拦
 *   [4] 装配与文档：index.html 加载顺序 / css / i18n / nodehelp / 节点指南 / 手册
 *   [5] 落盘环节真跑：状态键按**整份共享状态**取（平级 Agent 环节那一层也看得见 —— 用户报的
 *       save_report · failed 根因）/ 路径留空自动兜底 / 取不到才算失败且说明带可见键清单
 * 只读断言：不改任何文件、不起 Electron（vm 里整份装 app-longtask.js + app-longtask-out.js）。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
/* 行尾统一成 \n：工作区里的源码可能是 CRLF（git autocrlf / 编辑器各异），
   下面有跨行断言（如 NODE_DEFAULTS 的 "ltout: {\n    w: 360,"），不归一就会误报。 */
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
const LTOUTJS = read("renderer/app-longtask-out.js");
const PRELOAD = read("preload.js");
const MANUAL = read("guides/manual/longtask.md");

/* ═══════════════ [1] 登记与建法（静态） ═══════════════ */
console.log("\n[1] 产出节点（kind ltout）：登记齐全 / 只由系统建 / 引擎两处发布点");
has(APP, 'ltout: "ltout"', "KIND_CLS 有 ltout → 主画布按类上色");
has(APP, "ltout: {\n    w: 360,", "NODE_DEFAULTS 有 ltout（渲染 / 最小尺寸 / 字段缺省都靠它）");
has(APP, "ltRefs: [],", "NODE_DEFAULTS.ltout 带 ltRefs（只读文件引用清单随画布 JSON 存）");
has(APP, 'ltout: "产出"', "kind 名显示为「产出」");
has(APP, 'ltout: "产出节点（长周期任务 · 执行中产出 · 可直接编辑）"', "设置项用途说明到位");
has(APP, 'if (n.kind === "ltout") return 0;', "输出端子 0 个（产出节点是落点，不往下接线）");
has(APP, 'if (node.kind === "ltout") return 0;', "输入端子 0 个（连不了线）");
has(CANVASJS, "if (node.kind === \"ltout\") {", "节点头部走 ltout 分支（✎ 编辑入口）");
has(CANVASJS, "function ltoutMdEditButtonEl(", "✎ 复用 app.js 的内置 Markdown 编辑器（不新造编辑器）");
has(CANVASJS, "openMdViewer(\"\", {", "✎ 打开的是内置 Markdown 编辑器虚拟文档形态");
has(CANVASJS, "function buildLtoutBody(", "板身正文走 buildLtoutBody（与文本节点同一套 node.text 交互）");
has(CANVASJS, "node.text", "正文即 node.text：改了就随画布保存，后续环节读得到");

/* 只由系统建：LOCKED 名单 + 三道闸（addNode / 复制 / canvas_edit） */
has(LTV, 'LOCKED: ["deliver", "ltout", "ltart"]', "引擎导出 LOCKED 名单含 ltout / ltart（下面三处闸都读它）");
has(APP, "window.LT.LOCKED.indexOf(kind) >= 0 && !(extra && extra.__ltSystem)", "addNode：没有 __ltSystem 就建不出产出节点（不能手动新建）");
has(APP, "window.LT.LOCKED.indexOf(src.kind) >= 0", "复制 / 粘贴：产出节点被丢掉（一个环节只有一个落点）");
has(NODES, "window.LT.LOCKED.indexOf(kind) >= 0", "canvas_edit 建图侧同样拒绝创建产出节点（智能体也不能手搓）");
has(LTV, "__ltSystem: true", "系统建产出节点时带 __ltSystem（唯一放行口）");
has(LTV, "S._skipCanvasHistory = true;", "系统建产出节点不进撤销栈（Ctrl+Z 不会把它撤掉）");
has(LTV, "function ltOutputCanvasNodeOf(", "按 ltTaskUid + ltPath 认人：重跑 / 回跳复用同一颗，删了会补回来");
has(LTV, "产出", "标题走「产出 · <环节名>」");
has(LTV, "const LT_OUTPUT_HASH_MAX", "内容哈希有体积上限（大文件只认 mtime/size）");

/* 引擎两处发布点：Agent 环节收尾 + output 落盘后，都包在 try 里（发布失败不改成败口径） */
{
  const p1 = LTV.indexOf("await ltOutputPublish(run, path, { text: text");
  ok(p1 > 0, "Agent 环节收尾调 ltOutputPublish（本轮正文 + 已落盘文件）");
  ok(p1 > 0 && LTV.slice(Math.max(0, p1 - 40), p1).indexOf("try {") >= 0, "Agent 环节发布包在 try 里（发布失败不判这一环失败）");
  const p2 = LTV.indexOf("await ltOutputPublish(run, path, { text: body, files: [abs] });");
  ok(p2 > 0, "output 落盘成功后调 ltOutputPublish（正文 + 该文件）");
  ok(p2 > 0 && LTV.slice(Math.max(0, p2 - 40), p2).indexOf("try {") >= 0, "output 发布同样包在 try 里");
}
has(LTV, "if (typeof ltOutGate === \"function\") {", "Agent 环节执行前过「产出回流闸」（app-longtask-out.js）");
has(LTV, "if (gate && gate.asked) {", "闸说「问过了」就停下这一环（等用户答复，不往下跑）");
has(LTV, "typeof ltOutResolveAsk === \"function\"", "用户在人工卡里答完走 ltOutResolveAsk 续跑");
has(LTV, "ltOutPromptSection(run, path)", "prompt 注入产出段（接在【当前状态】之后）");
has(HTML, 'src="app-longtask.js"', "index.html 加载引擎");
has(HTML, 'src="app-longtask-out.js"', "index.html 加载产出回流模块");
ok(
  HTML.indexOf('src="app-longtask.js"') < HTML.indexOf('src="app-longtask-out.js"'),
  "加载顺序：产出回流在引擎之后（用到 ltOutputRec / ltOutputDirty / ltEnsureDeliverNode）",
);

/* ═══════════════ [2][3] 真跑（vm） ═══════════════ */
async function main() {
  console.log("\n[2] 数据层真跑：登记基线 +「改没改」三态判据");
  const files = new Map();
  const setFile = (p, mtime, size, content) => files.set(String(p), { mtime, size, content });
  let nodeSeq = 0;
  const S = { wf: { id: "wf-out", nodes: [], cam: { x: 0, y: 0, k: 1 } }, config: {}, _skipCanvasHistory: false };
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
      const n = Object.assign({ id: "ltn" + ++nodeSeq, kind: kind, x: x, y: y, w: 360, h: 260, title: kind, text: "" }, extra || {});
      S.wf.nodes.push(n);
      return n;
    },
    console, setTimeout, clearTimeout, Map, Set, Promise, JSON, Math, Date, Object, Array, String, Number, RegExp,
  };
  vm.createContext(sandbox);
  vm.runInContext(LTV, sandbox, { filename: "renderer/app-longtask.js" });
  vm.runInContext(LTOUTJS, sandbox, { filename: "renderer/app-longtask-out.js" });
  ok(!!sandbox.window.LT && !!sandbox.window.LTOUT, "两份脚本在同一沙箱里整份执行并导出 window.LT / window.LTOUT（顶层不碰 DOM）");
  const GRAPH = {
    nodes: [
      { id: "a", kind: "agent", title: "起草", cfg: { goal: "写一版稿", outKeys: ["draft"] } },
      { id: "b", kind: "output", title: "落盘", cfg: { key: "draft", path: "out.md" } },
      { id: "c", kind: "human", title: "交稿", cfg: { mode: "deliver" } },
    ],
    edges: [],
  };
  const newRun = (uid) => sandbox.ltRunNew({ uid: uid, name: "演示任务", graph: JSON.parse(JSON.stringify(GRAPH)) }, "wf-out", {});

  /* ① 引擎跑完一步：必建 / 更新产出节点正文 + 登记基线 */
  const runA = newRun("taskA");
  const nodeA1 = await sandbox.ltOutputPublish(runA, "a", { text: "第一版正文" });
  ok(!!nodeA1 && nodeA1.kind === "ltout", "发布产出：画布上真的有了一颗 kind ltout 节点（执行中就能看到）");
  eqNum(S.wf.nodes.filter((n) => n.kind === "ltout").length, 1, "只建一颗产出节点（不堆）");
  eqNum(nodeA1.text, "第一版正文", "节点正文 = 这一步生成的内容（用户看到的就是它）");
  eqNum(nodeA1.title, "产出 · 起草", "标题 = 「产出 · <环节名>」");
  eqNum(nodeA1.ltTaskUid, "taskA", "节点带任务身份（重跑 / 回跳靠它认人）");
  eqNum(nodeA1.ltPath, "a", "节点带环节路径");
  const recA = runA.outputs["a"];
  ok(!!recA, "run 上登记了产出基线（run.outputs[path]）");
  eqNum(recA.nodeId, nodeA1.id, "基线记下承载它的节点 id");
  eqNum(recA.contentHash, sandbox.ltOutputHash("第一版正文"), "基线存的是登记那一刻正文的哈希");
  eqNum(recA.edited, false, "刚发布的基线不是「被改过」");
  const nodeA2 = await sandbox.ltOutputPublish(runA, "a", { text: "第二版正文" });
  eqNum(nodeA2.id, nodeA1.id, "再跑一轮：复用同一颗产出节点（不新建）");
  eqNum(S.wf.nodes.filter((n) => n.kind === "ltout").length, 1, "画布上仍只有一颗");
  eqNum(nodeA2.text, "第二版正文", "正文被更新成最新一版");
  eqNum(runA.outputs["a"].contentHash, sandbox.ltOutputHash("第二版正文"), "基线跟着更新");
  eqNum(sandbox.ltOutputHash("abc"), sandbox.ltOutputHash("abc"), "哈希确定性：同内容同值");
  ok(sandbox.ltOutputHash("abc") !== sandbox.ltOutputHash("abd"), "哈希敏感：改一个字符就不同");

  /* ② 哈希一致 → clean，不加「被改」标注 */
  eqNum(await sandbox.ltOutputDirty(runA, "a"), "clean", "没人动过：节点正文哈希与基线一致 → clean");
  const sec0 = sandbox.ltOutPromptSection(runA, "a");
  has(sec0, "第二版正文", "prompt 产出段带出节点当前正文");
  hasnt(sec0, "用户已修改过", "没改过就不加「改过」标注");
  eqNum((await sandbox.ltOutScan(runA, "a")).state, "clean", "扫描结论 clean");

  /* ③ 手改节点正文 → edited，且下次 prompt 带现正文与「以画布为准」 */
  nodeA2.text = "用户改后的正文";
  eqNum(await sandbox.ltOutputDirty(runA, "a"), "edited", "手改节点正文 → 判据回 edited（确证被改）");
  ok(runA.outputs["a"].edited === true && Number(runA.outputs["a"].editAt) > 0, "判定为被改时记上 edited / editAt");
  const sec1 = sandbox.ltOutPromptSection(runA, "a");
  has(sec1, "用户改后的正文", "改过之后 prompt 带的是**改后的现内容**");
  has(sec1, "用户已修改过", "并显式标注「用户已修改过」");
  has(sec1, "一律以此为准", "钉住「与旧值 / 记忆冲突一律以此为准」");
  const prompt1 = sandbox.ltAgentPrompt(runA, "a", sandbox.ltNodeAt(runA, "a"), []);
  has(prompt1, "【产出（以画布为准）】", "环节 prompt 里有【产出（以画布为准）】段（接在当前状态之后）");
  has(prompt1, "以画布为准", "prompt 明写「以画布为准」");
  has(prompt1, "用户改后的正文", "prompt 里就是用户改后的正文（后续环节吃这份）");
  eqNum((await sandbox.ltOutScan(runA, "a")).state, "edited", "扫描结论 edited");
  const gate1 = await sandbox.ltOutGate(runA, "a", sandbox.ltNodeAt(runA, "a"));
  ok(gate1.asked === false, "确证被改过不拦：改后的内容直接算数，继续跑");

  /* ④ 文件 mtime / size 变化同样被识别 */
  const fp = "C:\\tmp\\ltout-file.txt";
  setFile(fp, 1000, 5, "hello");
  const runB = newRun("taskB");
  await sandbox.ltOutputPublish(runB, "b", { text: "落盘内容", files: [fp] });
  const rb = runB.outputs["b"];
  eqNum(rb.fileRefs.length, 1, "文件引用登记进基线");
  eqNum(rb.fileRefs[0].mtime, 1000, "基线记下 mtime");
  eqNum(rb.fileRefs[0].size, 5, "基线记下 size");
  eqNum(rb.fileRefs[0].hash, sandbox.ltOutputHash("hello"), "基线记下可读文本的内容哈希");
  eqNum(await sandbox.ltOutputDirty(runB, "b"), "clean", "文件没动 → clean");
  setFile(fp, 2000, 5, "hello");
  eqNum(await sandbox.ltOutputDirty(runB, "b"), "edited", "文件 mtime 变化被识别为「用户改过」");
  setFile(fp, 2000, 5, "hello");
  await sandbox.ltOutputPublish(runB, "b", { text: "落盘内容", files: [fp] });
  eqNum(await sandbox.ltOutputDirty(runB, "b"), "clean", "重发布后基线跟上（不再误报）");
  setFile(fp, 2000, 12, "hello world!!");
  eqNum(await sandbox.ltOutputDirty(runB, "b"), "edited", "文件 size 变化同样被识别");
  eqNum((await sandbox.ltOutputRead(runB, "b")).files[0].changed, true, "read 里这一条标了 changed = true");

  /* 缺基线 / 读不到 → unknown，绝不当作 clean */
  const ghost = "C:\\tmp\\ltout-missing.txt";
  const runB2 = newRun("taskB2");
  await sandbox.ltOutputPublish(runB2, "b", { text: "落盘内容", files: [ghost] });
  eqNum(runB2.outputs["b"].fileRefs[0].mtime, null, "登记时就读不到的路径：mtime 记 null（缺基线）");
  eqNum(await sandbox.ltOutputDirty(runB2, "b"), "unknown", "文件读不到 → unknown，不当作「没改」");
  eqNum((await sandbox.ltOutputRead(runB2, "b")).reason, "file-unreadable", "read 给出 reason = file-unreadable");

  /* ⑤ 判不准：节点被删 → unknown + 落人工确认项 + 答完续跑 */
  const runC = newRun("taskC");
  sandbox.ltInst(runC, "", runC.graph); /* 引擎点火时会先给环节建运行态槽（ltStat），闸读的就是它 */
  await sandbox.ltOutputPublish(runC, "c", { text: "产出正文" });
  const nodeC = S.wf.nodes.find((n) => n.id === runC.outputs["c"].nodeId);
  S.wf.nodes.splice(S.wf.nodes.indexOf(nodeC), 1); /* 用户把产出节点删了 */
  eqNum(await sandbox.ltOutputDirty(runC, "c"), "unknown", "产出节点被删 → unknown（不猜）");
  const readC = await sandbox.ltOutputRead(runC, "c");
  eqNum(readC.state, "unknown", "read 也是 unknown");
  eqNum(readC.reason, "node-missing", "read 给出 reason = node-missing");
  eqNum((await sandbox.ltOutScan(runC, "c")).state, "unknown", "扫描结论 unknown");
  const gateC = await sandbox.ltOutGate(runC, "c", sandbox.ltNodeAt(runC, "c"));
  ok(gateC.asked === true, "判不准 → 停下来问用户（不按记忆硬跑）");
  const stC = runC.nodes["c"];
  eqNum(stC.status, "waiting_delivery", "本环节转入等交付（主循环不再点火它）");
  ok((runC.waits || []).some((w) => w.kind === "deliver" && w.path === "c"), "run.waits 推了一张交付人工卡（复用既有 human/interrupt）");
  ok(!!stC.items && stC.items[0] && stC.items[0].id === "ltout_confirm", "卡里就一个确认条目：ltout_confirm");
  eqNum(stC.items[0].required, true, "确认条目是必填（不答不放行）");
  ok(stC.items[0].title === "产出判不准，请确认", "条目标题就是「产出判不准，请确认」");
  const dn = S.wf.nodes.find((n) => n.kind === "deliver" && (n.ltItems || [])[0] && n.ltItems[0].title === "产出判不准，请确认");
  ok(!!dn, "确认项同时落进系统建的交付节点（画布上也有落点）");
  ok(!!dn && dn.ltUid === "ltout-" + sandbox.ltOutputHash("taskC|c"), "交付节点 uid 按 task + path 稳定（反复判不准也只补同一颗）");
  has(stC.ask.why, "核对不上", "卡片说明写清了为什么判不准");
  let pumped = 0;
  sandbox.ltPump = () => { pumped++; };
  const res = await sandbox.ltOutResolveAsk(runC, "c", [{ value: "按画布上的现内容继续" }]);
  ok(res.ok === true, "用户答完：ltOutResolveAsk 收下答复");
  eqNum(runC.nodes["c"].status, "pending", "本环节回 pending（重新排队续跑）");
  eqNum((runC.waits || []).length, 0, "人工卡收掉");
  eqNum(pumped, 1, "并触发 ltPump 继续跑（不是「交付完成」，正文都还没生成）");
  const ans = sandbox.ltStateGet(runC, "c", "ltout_confirm");
  ok(!!ans && ans.answer === "按画布上的现内容继续", "答复写进状态键 ltout_confirm（后续环节读得到）");
  const gateC2 = await sandbox.ltOutGate(runC, "c", sandbox.ltNodeAt(runC, "c"));
  ok(gateC2.asked === false && gateC2.confirmed === true, "同一份料问过一次就不再反复拦（换基线才重新问）");

  /* ═══════════════ [4] 装配与文档（静态） ═══════════════ */
  console.log("\n[4] 装配与文档：css / i18n / nodehelp / 节点指南 / 手册");
  has(LTCSS, ".wf-node.ltout {", "产出节点有 .ltout 一族配色（与 .dlv 同族、语义不同）");
  has(LTCSS, "body.theme-light .wf-node.ltout", "浅色主题同口径");
  has(LTCSS, ".wf-node.ltout .n-text", "正文区有最小高度（空节点不发飘）");
  has(LTCSS, ".n-ltout-refs", "只读文件引用清单有样式");
  has(HELP, "ltout:", "app-nodehelp 的 KIND_HELP 有它（? 按钮不说「暂无说明」）");
  for (const k of ["产出", "产出节点（长周期任务 · 执行中产出 · 可直接编辑）", "产出判不准，请确认", "已按你的修改续跑"])
    has(I18N_SRC, '"' + k + '"', "i18n 表里有词条：" + k);
  has(I18N_SRC, "The output could not be verified", "英文词条成对（切英文不回中文）");
  ok(exists("guides/nodes/ltout.md"), "guides/nodes/ltout.md 存在（AGENTS：新增节点类型必须补指南）");
  ok(exists("guides/nodes/en/ltout.md"), "guides/nodes/en/ltout.md 存在（中英成对）");
  has(read("guides/nodes/index.json"), '"ltout"', "guides/nodes/index.json 登记 ltout");
  has(read("guides/nodes/ltout.md"), "后续环节会用你改后的内容", "节点指南写明「改后内容算数」的回流口径");
  has(MANUAL, "产出节点", "应用内手册写明产出节点");
  has(MANUAL, "以你改后的现内容为准", "手册写明「用户改过 → 以改后的现内容为准」");
  has(MANUAL, "产出判不准，请确认", "手册写明判不准会停下来问用户");
  hasnt(MANUAL, "点击展开选择", "手册没有旧的折叠面板口径残留");

  /* ═══════════════ [5] 落盘环节真跑：跨命名空间取键（本轮 Bug）+ 自动兜底 ═══════════════ */
  console.log("\n[5] 落盘环节（output）真跑：状态键按整份共享状态取 / 路径留空兜底 / 取不到才算失败");
  {
    const writes = [];
    sandbox.window.api.fileWriteText = async (p, body) => {
      writes.push({ p: p, body: body });
      return true;
    };
    sandbox.window.api.pathJoin = (a, b) => String(a).replace(/[\\/]+$/, "") + "\\" + String(b).replace(/^[\\/]+/, "");
    const graphOut = (o) => ({
      nodes: [
        { id: "a", kind: "agent", title: "起草", cfg: { goal: "写一版稿", outKeys: ["draft"] } },
        { id: "b", kind: "output", title: "落盘草稿", cfg: Object.assign({ key: "draft", path: "out/草稿.md" }, o || {}) },
      ],
      edges: [{ id: "e1", from: "a", to: "b" }],
    });
    const newOutRun = (uid, o) => {
      const r = sandbox.ltRunNew({ uid: uid, name: "落盘任务", graph: JSON.parse(JSON.stringify(graphOut(o))) }, "wf-out", {});
      r.ws = "C:\\tmp\\ltws";
      sandbox.ltInst(r, "", r.graph);
      return r;
    };

    /* ① 根因：Agent 环节把声明键写在自己那一层，平级产出节点在链上永远看不见 */
    const runD = newOutRun("taskD");
    sandbox.ltStatePut(runD, "a", "draft", "# 草稿正文");
    eqNum(sandbox.ltStateGet(runD, "b", "draft"), undefined, "老口径（只沿链向上）看不见平级环节写的键 —— 就是 save_report · failed 的根因");
    eqNum(sandbox.ltStateWhere(runD, "b", "draft").path, "a", "ltStateWhere 认出这份键在平级环节那一层（出处可查）");
    has(sandbox.ltStateFlat(runD, "b") && JSON.stringify(sandbox.ltStateFlat(runD, "b")), "草稿正文", "整份共享状态（ltStateFlat）也带上了平级环节的键");
    has(sandbox.ltAgentPrompt(runD, "b", sandbox.ltNodeAt(runD, "b"), []), "草稿正文", "Agent 提示词的【当前状态】段看得到上游环节的键（不再恒为空）");

    await sandbox.ltExecOutput(runD, "b", sandbox.ltNodeAt(runD, "b"), "");
    eqNum(runD.nodes["b"].status, "done", "落盘环节跑通（不再判 failed）");
    eqNum(writes.length, 1, "写出了一份文件");
    ok(writes[0].p.indexOf("C:\\tmp\\ltws") === 0 && writes[0].p.indexOf("草稿.md") > 0, "相对路径仍按工作目录展开（得到 " + writes[0].p + "）");
    eqNum(writes[0].body, "# 草稿正文", "落盘内容就是那个状态键的值");
    has(
      (runD.log || []).map((l) => l.text).join("\n"),
      "已自动修复：状态键「draft」取自 起草",
      "取自链外时在运行日志里留痕（点名是谁的键，不悄悄换料）",
    );

    /* ② 路径留空不再判失败：兜底到 <工作目录>/<本环节标题>.md */
    writes.length = 0;
    const runE = newOutRun("taskE", { path: "" });
    sandbox.ltStatePut(runE, "a", "draft", "正文");
    await sandbox.ltExecOutput(runE, "b", sandbox.ltNodeAt(runE, "b"), "");
    eqNum(runE.nodes["b"].status, "done", "没填落盘路径不再判失败（自动兜底）");
    eqNum(writes[0].p, "C:\\tmp\\ltws\\落盘草稿.md", "兜底文件名 = 本环节标题 + .md");

    /* ③ 键确实谁也没写回 → 才判失败，且说明里带「现在可见的状态键」与出路 */
    const runF = newOutRun("taskF", { key: "nope" });
    sandbox.ltStatePut(runF, "a", "draft", "正文");
    await sandbox.ltExecOutput(runF, "b", sandbox.ltNodeAt(runF, "b"), "");
    eqNum(runF.nodes["b"].status, "failed", "键真的取不到才判失败");
    has(runF.nodes["b"].err, "现在可见的状态键：", "失败说明列出当前可见的状态键（用户改键名有据可依）");
    has(runF.nodes["b"].err, "重跑本环节即可", "失败说明给出出路");

    /* ④ 放开的只是「平级可见」：map 逐项实例之间互不可见仍是承诺 */
    const runG = newOutRun("taskG");
    sandbox.ltStatePut(runG, "shots@0/x", "shot_file", "a.png");
    eqNum(sandbox.ltStateGet(runG, "shots@1/x", "shot_file"), undefined, "逐项实例之间看不见（链上口径）");
    ok(sandbox.ltStateWhere(runG, "shots@1/x", "shot_file") === null, "整份共享状态也不把别的实例的键串过来（实例隔离没被冲掉）");

    /* ⑤ 同名键：两个环节都写过 → Agent 看到的值与产出节点落盘的值必须是同一份（后写回的那份） */
    const runH = newOutRun("taskH", { key: "dup" });
    sandbox.ltStatePut(runH, "a", "dup", "旧的一份");
    sandbox.ltStatePut(runH, "b2", "dup", "新的一份");
    eqNum(sandbox.ltStateFlat(runH, "b")["dup"], "新的一份", "整份共享状态里同名键以后写回的那份为准");
    eqNum(sandbox.ltStateWhere(runH, "b", "dup").path, "b2", "单键读取与合流口径同源（出处 = 后写回的那层）");
    writes.length = 0;
    await sandbox.ltExecOutput(runH, "b", sandbox.ltNodeAt(runH, "b"), "");
    eqNum(writes[0].body, "新的一份", "落盘的就是 Agent 看到的那一份（两个口子不许各认各的）");

    /* ⑥ 共享状态整份可见，但长文不整份灌进提示词（只报字数并指向 lt_state） */
    const runJ = newOutRun("taskJ");
    sandbox.ltStatePut(runJ, "a", "big", "长".repeat(900));
    const prJ = sandbox.ltAgentPrompt(runJ, "b", sandbox.ltNodeAt(runJ, "b"), []);
    has(prJ, "用 lt_state 读全文", "长值在【当前状态】段里只报字数（不整份灌进 prompt）");
    hasnt(prJ, "长".repeat(700), "900 字的长文没有原样进提示词");
    has(prJ, "big", "键名照样列出（键一个不落）");

    /* ⑦ 续跑自愈：失败过的落盘环节，键现在取得到 → 自动重排队（不花 Token，只写一个文件）；
          取不到 / 用户已放行过 → 原样留着失败 */
    const runK = newOutRun("taskK");
    sandbox.ltStatePut(runK, "a", "draft", "正文");
    sandbox.ltSetStat(runK, "b", "failed", { err: "output 需要 path 与已存在的状态键" });
    eqNum(sandbox.ltHealOutputNodes(runK), 1, "键取得到的失败落盘环节自动重排队（1 个）");
    eqNum(runK.nodes["b"].status, "pending", "重排成本环节待跑");
    eqNum(runK.nodes["b"].err, "", "老错误说明一起清掉（卡片上不再挂着 ⚠）");
    has((runK.log || []).map((l) => l.text).join("\n"), "已自动修复（状态键现在取得到）", "自愈在运行日志里留痕");
    eqNum(sandbox.ltHealOutputNodes(runK), 0, "已经重排过的不重复动（幂等）");
    /* 下游要跟着一起重排（走 ltRewind 同一套跃迁）：只排这一环的话，它跑完点火下游时
       下游还停在 skipped 终态，run 会二次收成 stalled（修了还要再点一次） */
    const runK2 = sandbox.ltRunNew(
      {
        uid: "taskK2",
        name: "落盘任务",
        graph: {
          nodes: [
            { id: "a", kind: "agent", title: "起草", cfg: { goal: "写", outKeys: ["draft"] } },
            { id: "b", kind: "output", title: "落盘草稿", cfg: { key: "draft", path: "out/草稿.md" } },
            { id: "c", kind: "output", title: "落盘副本", cfg: { key: "draft", path: "out/副本.md" } },
          ],
          edges: [
            { id: "e1", from: "a", to: "b" },
            { id: "e2", from: "b", to: "c" },
          ],
        },
      },
      "wf-out",
      {},
    );
    runK2.ws = "C:\\tmp\\ltws";
    sandbox.ltInst(runK2, "", runK2.graph);
    sandbox.ltStatePut(runK2, "a", "draft", "正文");
    sandbox.ltSetStat(runK2, "b", "failed", { err: "x" });
    sandbox.ltSetStat(runK2, "c", "skipped");
    runK2.fired = { e1: 1 };
    eqNum(sandbox.ltHealOutputNodes(runK2), 1, "自愈重排本环节");
    eqNum(runK2.nodes["c"].status, "pending", "下游跟着一起重排（不会二次 stalled）");
    ok(!runK2.fired.e2, "回跳集内部的点火记录已撤（跑完会重新点火下游）");
    ok(!!runK2.fired.e1, "集外指进来的点火记录保留（本环节还等着被上游起跑）");
    const runL = newOutRun("taskL", { key: "nope" });
    sandbox.ltSetStat(runL, "b", "failed", { err: "output 需要 path 与已存在的状态键" });
    eqNum(sandbox.ltHealOutputNodes(runL), 0, "键确实取不到 → 不许猜，原样留着失败");
    eqNum(runL.nodes["b"].status, "failed", "没值的失败环节保持 failed（自愈不是无条件重跑）");
    const runM = newOutRun("taskM");
    sandbox.ltStatePut(runM, "a", "draft", "正文");
    sandbox.ltSetStat(runM, "b", "failed", { err: "x" });
    runM.fixes = [{ path: "b", by: "user", mode: "err" }];
    eqNum(sandbox.ltHealOutputNodes(runM), 0, "用户已对这次失败做过判断（放行留痕）→ 系统不推翻");
    /* 只认 output：Agent 环节的重跑要烧 Token，绝不自动重排 */
    const runN = newOutRun("taskN");
    sandbox.ltSetStat(runN, "a", "failed", { err: "agent 失败" });
    eqNum(sandbox.ltHealOutputNodes(runN), 0, "Agent 环节的失败不自动重排（重跑要烧 Token）");
    ok(LTV.indexOf("ltHealOutputNodes(run);") > 0, "续跑（ltResume）里真的接了自愈这一步");
  }

  console.log("\n" + (fails ? "FAILED " + fails + " / " + checks + " checks" : "ALL OK  " + checks + " checks"));
  process.exit(fails ? 1 : 0);
}

main().catch((e) => {
  console.error("smoke-longtask-output crashed:", (e && e.stack) || e);
  process.exit(1);
});
