"use strict";
/**
 * test/smoke-longtask-edit.js —— 长周期任务：任务链修改（弹窗 + 原地改图）+ 头部按钮收纳
 *
 * 本轮的改动分四层，任一层掉链子都会变成「按钮点了没反应 / 以为改了其实没写回」：
 *   [1] 引擎：window.LT.updateFromGraph 原地改图（同 uid / 保留身份 / ver+1 / 落盘命中被改的画布）
 *       + LT.graphOf 现况快照（图定义 + 运行态）+ updateFromGraph 的拒绝路径
 *   [2] 工具层：mtnode_app 的 get_longtask / update_longtask（enum / APP_DESC / uid 参数）
 *       + app-nodes 分发 + app_ops 归属 + 规划模式拒绝 + 回滚记账只放行读那只
 *   [3] 弹窗：renderer/app-longtask-edit.js 的契约会话（get→改→update 原地写回 / 禁新建 / 禁手改
 *       wf.longtask）+ 每轮把当前图喂给 Agent + 收尾闸 + 持久化浮层（最小宽 ≥50% / 右下拖调）
 *   [4] 收纳与装配：头部那些手动按钮进了「⋯ 更多」下拉（瞬时菜单，点外部即收）+ index.html 顺序
 *       + longtask.css 的 .lte-* / .lt-more-* + i18n 中英词条
 * 只读断言：不改任何文件、不起 Electron（引擎真行为在 vm 里跑）。
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
const seg = (a, b) => {
  const i = LTU.indexOf(a);
  const j = LTU.indexOf(b);
  ok(i >= 0 && j > i, "切片 " + a + " → " + b + " 存在");
  return i >= 0 && j > i ? LTU.slice(i, j) : "";
};

const LTE = read("renderer/app-longtask-edit.js");
const LTU = read("renderer/app-longtask-ui.js");
const LTV = read("renderer/app-longtask.js");
const LTG = read("renderer/app-longtask-guide.js");
const NODES = read("renderer/app-nodes.js");
const PLUGIN = read("dsh/gateway/canvas-plugin.mjs");
const ROLLBACK = read("dsh/gateway/rollback-plugin.mjs");
const HTML = read("renderer/index.html");
const CSS = read("renderer/css/longtask.css");
const I18N = read("renderer/i18n.js");
const MANUAL = read("guides/manual/longtask.md");

/* ══════════════ [1] 引擎：updateFromGraph / graphOf（vm 里真跑）═══════════════ */
async function enginePart() {
  console.log("\n[1] 引擎：LT.updateFromGraph 原地改图 + LT.graphOf 现况快照（真跑，不是 grep）");
  let saves = 0;
  const persisted = [];
  const sandbox = {
    window: { api: {} },
    S: { wf: null, config: {} },
    I18n: { t: (s) => s },
    toast() {},
    scheduleSave() {
      saves++;
    },
    persistWf(wf) {
      persisted.push(wf);
    },
    currentVisibleWf() {
      return null; /* 测试里没有「用户看着的画布」→ 一律走 persistWf 这条 */
    },
    renderCanvas() {},
    focusNode() {},
    addNode() {
      return null;
    },
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
  const LT = sandbox.window.LT;
  eqNum(typeof LT.updateFromGraph, "function", "window.LT 导出 updateFromGraph");
  eqNum(typeof LT.graphOf, "function", "window.LT 导出 graphOf（现况快照）");

  const G1 = {
    nodes: [
      { id: "s", kind: "start", title: "起点" },
      { id: "a", kind: "agent", title: "起草", cfg: { goal: "写一版稿子", outKeys: ["draft"] } },
      { id: "e", kind: "end_ok", title: "收工" },
    ],
    edges: [
      { from: "s", to: "a" },
      { from: "a", to: "e" },
    ],
  };
  /* 改后的图：把「起草」拆成「起草 → 初审 → 终审」 */
  const G2 = {
    nodes: [
      { id: "s", kind: "start", title: "起点" },
      { id: "a", kind: "agent", title: "起草", cfg: { goal: "写一版稿子", outKeys: ["draft"] } },
      { id: "r1", kind: "agent", title: "初审", cfg: { goal: "初审稿子", outKeys: ["review1"] } },
      { id: "r2", kind: "agent", title: "终审", cfg: { goal: "终审定稿", outKeys: ["review2"] } },
      { id: "e", kind: "end_ok", title: "收工" },
    ],
    edges: [
      { from: "s", to: "a" },
      { from: "a", to: "r1" },
      { from: "r1", to: "r2" },
      { from: "r2", to: "e" },
    ],
  };

  const wf = { id: "wf1", name: "画布一" };
  let r = LT.updateFromGraph(wf, "", G1, "");
  ok(r && r.ok === false, "没有任务 → 拒绝（不静默吞掉）");
  has(r.error, "没有找到这张长任务", "拒绝文本说清找不到任务");

  const created = LT.createFromGraph("审稿流水线", G1, wf);
  ok(created && created.ok === true, "先建一张任务（修改的前置）");
  const uid = created.uid;
  const t0 = wf.longtask.tasks[0];
  const created0 = t0.createdAt;
  eqNum(t0.ver, 1, "新建时 ver = 1");

  r = LT.updateFromGraph(wf, uid, null, "");
  ok(r && r.ok === false, "缺 graph → 拒绝");
  has(r.error, "缺少图定义 graph", "拒绝文本说清缺的是图定义");
  eqNum(saves, 0, "缺图不触发存盘");

  r = LT.updateFromGraph(wf, uid, { nodes: [], edges: [] }, "");
  ok(r && r.ok === false, "空图 → 拒绝（参数级直接挡，不把用户的图改没）");
  eqNum((LT.tasks(wf) || [])[0].graph.nodes.length, 3, "空图不落库：原图仍是 3 个节点");

  /* 校验不过的图：多出一个没有上游的节点 */
  const DIRTY = {
    nodes: G2.nodes.concat([{ id: "x", kind: "agent", title: "没上游", cfg: { goal: "g" } }]),
    edges: G2.edges,
  };
  r = LT.updateFromGraph(wf, uid, DIRTY, "");
  ok(r && r.ok === false, "脏图 → 拒绝（校验未过）");
  has(r.error, "长周期任务图校验未通过：", "拒绝文本带「校验未通过」前缀（Agent 可读）");
  has(r.error, "没有任何上游", "拒绝文本把引擎的 err 原样带回（Agent 知道改什么）");
  has(r.error, "。请修正后重新调用 update_longtask。", "拒绝文本明确让 Agent 修正后重调 update_longtask");
  ok(Array.isArray(r.errs) && r.errs.length >= 1, "拒绝回执带结构化 errs");
  ok(Array.isArray(r.warnings), "拒绝回执带 warnings");
  eqNum((LT.tasks(wf) || [])[0].graph.nodes.length, 3, "校验不过绝不半改：原图仍是 3 个节点");

  saves = 0;
  persisted.length = 0;
  r = LT.updateFromGraph(wf, uid, G2, "");
  ok(r && r.ok === true, "干净的新图 → 原地改图成功");
  eqNum(r.uid, uid, "回执 uid 与被改的任务一致（不是新建）");
  eqNum(r.ver, 2, "ver 只增不减：v1 → v2");
  eqNum((LT.tasks(wf) || []).length, 1, "任务数不变：原地改，不新建第二条");
  const t1 = LT.tasks(wf)[0];
  eqNum(t1.uid, uid, "任务身份保留（uid 不变）");
  eqNum(t1.createdAt, created0, "createdAt 保留（不是一份新任务）");
  eqNum(t1.graph.nodes.length, 5, "图定义被换成新图（5 个节点）");
  eqNum(t1.graph.nodes[3].title, "终审", "新图内容真的落进 task.graph");
  eqNum(t1.graph.ver, 2, "图定义上的 ver 与任务 ver 同步");
  eqNum(t1.enabled, false, "enabled 原样保留（改图不等于启用）");
  ok(saves + persisted.length >= 1, "改图触发落盘");
  eqNum(persisted.length, 1, "落盘按对象自己的 id 走 persistWf（不写用户看着的另一张）");
  ok(persisted[0] === wf, "落盘的正是那张被改的画布");
  eqNum(r.running, false, "没有在跑的 run 时 running:false（不吓唬 Agent）");
  eqNum(r.runNote, "", "没在跑就没有 runNote 这句提醒");

  /* graphOf：现况快照（身份 + 图 + 运行态） */
  const snap = LT.graphOf(wf, uid);
  ok(!!snap, "graphOf 拿得到现况");
  eqNum(snap.uid, uid, "快照带 uid");
  eqNum(snap.name, "审稿流水线", "快照带任务名");
  eqNum(snap.ver, 2, "快照带当前图版本");
  eqNum(snap.enabled, false, "快照带 enabled");
  eqNum(snap.graph.nodes.length, 5, "快照带整张图定义（Agent 就是照它改）");
  eqNum(snap.run, null, "没有 run 时 run:null");
  eqNum(LT.graphOf(wf, "不存在"), null, "uid 不存在 → null（不抛错）");
  eqNum(LT.graphOf(null, uid), null, "没有画布 → null");

  /* 改图 ≠ 影响在跑的 run：run 拿的是启用那刻的快照（共识 q34）。
     这里用「任务记了 activeRun 但 run 不在内存」模拟：running 仍报 false，
     但 activeRun 原样留着 —— 这条钉住「改图不会把 run 记录抹掉」。 */
  /* 写 activeRun 要写**真源对象** wf.longtask.tasks[0]：LT.tasks() 每次都走 ltEnsure 重建
     一份归一后的 task 对象，上一行取到的 t1 在 updateFromGraph 内部那次 ltEnsure 之后
     就已经不是它了（不是 bug，是「归一是唯一入口」的代价）。 */
  wf.longtask.tasks[0].activeRun = "r_x";
  r = LT.updateFromGraph(wf, uid, G2, "");
  ok(r && r.ok === true, "带 activeRun 的任务也能改图");
  eqNum(LT.tasks(wf)[0].activeRun, "r_x", "activeRun 原样保留（不打断也没抹掉）");
  eqNum(typeof r.runNote, "string", "回执总是带 runNote 字段（无 run 时为空串）");
  hasnt(LTV.slice(LTV.indexOf("function ltUpdateFromGraph"), LTV.indexOf("function ltGraphSnapshot")), "createFromGraph", "改图路径不偷偷调建图（只原地替换）");
}

/* ══════════════ [2] 工具层与分发 ═══════════════ */
function toolPart() {
  console.log("\n[2] 工具层：mtnode_app 的 get_longtask / update_longtask（enum / 卡口 / 分发 / 权限）");
  has(PLUGIN, "'get_longtask'", "action enum 收了 get_longtask");
  has(PLUGIN, "'update_longtask'", "action enum 收了 update_longtask");
  has(PLUGIN, "- get_longtask: read one existing long-running task in full", "APP_DESC 写了 get_longtask 给什么");
  has(PLUGIN, "- update_longtask: replace the graph definition of an EXISTING long-running task in place", "APP_DESC 写了 update_longtask 干什么");
  has(PLUGIN, "not a diff; the graph replaces the old one", "APP_DESC 说清 graph 是整张替换、不是增量");
  has(PLUGIN, "get_longtask / update_longtask: target long-running task uid", "新增 uid 参数并写明两个动作都用它");
  has(PLUGIN, "For create_longtask / update_longtask: the long-running-task state-machine graph.", "graph 参数说明覆盖两个动作");
  has(PLUGIN, "mtnode-grill-me", "仍指向 mtnode-grill-me 的图契约（单一真源，不抄字段）");

  has(NODES, 'if (action === "get_longtask") {', "应用动作分发有 get_longtask 分支");
  has(NODES, 'if (action === "update_longtask") {', "应用动作分发有 update_longtask 分支");
  has(NODES, "LT.graphOf(boundWf", "get_longtask 读的是「本会话所属画布」的现况");
  has(NODES, "LT.updateFromGraph(", "update_longtask 调 window.LT.updateFromGraph（归一 + 校验都在引擎里）");
  has(NODES, 'action === "get_longtask" ||', "两只动作都归 app_ops（工具清单里有它才可被模型调到）");
  has(NODES, 'action === "update_longtask" ||', "update_longtask 同样归 app_ops");
  {
    const denied = NODES.slice(NODES.indexOf("const PLAN_DENIED_APP_ACTIONS"), NODES.indexOf("function canvasOpMutates("));
    has(denied, '"update_longtask"', "规划模式把 update_longtask 列为拒绝动作（只出计划不改画布）");
    hasnt(denied, '"get_longtask"', "get_longtask 是只读，规划模式下仍放行");
  }
  has(ROLLBACK, "'get_longtask'", "回滚记账把 get_longtask 当只读（连占位都不发）");
  hasnt(ROLLBACK, "'update_longtask'", "回滚记账不放行 update_longtask（按写操作处理）");

  /* 会话侧权限：修改会话走的是「允许读画布」的契约会话 → 三件套都在（= 有全部权限） */
  has(LTE, "allowCanvas: true", "修改会话显式允许读画布（→ canvas_get / edit / app 三件套都在）");
  has(LTE, "agentContractSession(", "复用既有契约会话装配（不另造一套会话机制）");
  has(LTE, "noPlanFlow = true", "计划闸豁免：产物是改好的图，不是普通会话计划");
  hasnt(LTE, "mtnode_canvas_edit(\"", "宿主不直接拿画布写工具去画状态机图（只走 update_longtask）");
}

/* ══════════════ [3] 修改弹窗 ═══════════════ */
function dialogPart() {
  console.log("\n[3] 修改弹窗：契约（get → 改 → update 原地写回）+ 每轮现况喂给 Agent + 出口");
  ok(fs.existsSync(path.join(ROOT, "renderer/app-longtask-edit.js")), "renderer/app-longtask-edit.js 存在");
  has(LTE, "window.ltOpenEditDlg = ltOpenEditDlg", "导出 window.ltOpenEditDlg（头部按钮的落点）");
  has(LTU, "window.ltOpenEditDlg", "头部按钮调的就是它");
  has(LTU, "任务链修改模块未就绪", "模块没加载时给提示，不静默失败");

  const ct = LTE.slice(LTE.indexOf("function lteContractText()"), LTE.indexOf("function lteGraphText()"));
  has(ct, "get_longtask", "契约第一步：先读现状（get_longtask）");
  has(ct, "update_longtask", "契约最后一步：原地写回（update_longtask）");
  has(ct, "不是增量补丁，是整张替换", "契约说清 graph 是整张替换");
  has(ct, "不要 create_longtask 新建任务", "契约禁止新建任务（修改 ≠ 创建）");
  has(ct, "禁止手改画布 JSON 里的 wf.longtask", "契约禁止手改 wf.longtask");
  has(ct, "禁止用 mtnode_canvas_edit 去画这张状态机图", "契约禁止用画布写工具画状态机图");
  has(ct, "校验未通过", "契约要求按 err 修好再调一次");
  has(ct, "ask_user_question", "要求有歧义时用询问窗问满（不是拿计划代替提问）");
  has(ct, "禁止】输出 <!--MTNODE-PLAN-->", "契约禁止普通会话计划块");

  /* 每轮把「当前图 + 运行态 + 用户要求」一次交清（少一条 Agent 就得凭记忆改） */
  has(LTE, "function lteRoundInput(", "每轮拼一条起轮消息");
  has(LTE, "当前图定义 JSON", "起轮消息里带当前图定义");
  has(LTE, "当前运行态", "起轮消息里带运行态（哪个环节卡住 / 在等谁）");
  has(LTE, "lteGraphText()", "图 JSON 从 LT.graphOf 现况取（不是窗内记忆）");
  has(LTE, "JSON.stringify({ uid: snap.uid, name: snap.name, ver: snap.ver, graph: snap.graph })", "喂给 Agent 的 JSON 含 uid / 名字 / 版本 / 图");
  has(LTE, "过长已截断，完整定义请用 get_longtask 读", "超长图截断并指回 get_longtask（不静默丢）");

  /* 收尾闸：本轮没写回就自动纠偏一次 */
  has(LTE, "const LTE_FIX_MAX = 1", "自动纠偏上限 = 1（一个用户轮最多一次）");
  has(LTE, "function lteSettle(", "有每轮收尾闸");
  has(LTE, "lteFixDirective()", "收尾闸会回发纠偏指令");
  has(LTE, "本轮没有把改好的图写回", "纠偏前先明确告诉用户发生了什么");
  has(LTE, "_ltEditFixRounds = 0", "用户亲口发话 → 纠偏额度清零（绝不来回拉扯）");

  /* 兜底写回：回复里那份图也按同一份归一路径落库（工具不可用时不至于白聊） */
  has(LTE, "window.LT.updateFromGraph(wf", "回复里的图由宿主走同一条 updateFromGraph 写回");
  has(LTE, "LTE.applied", "同一份图只兜底写一次（幂等位记在窗内状态，重绘不回写）");
  has(LTE, "ltgParseGraph", "复用引导区的图 JSON 解析（不双写解析器）");

  /* 持久化浮层口径：与创建窗同款 */
  has(LTE, 'openOverlay(lteT("修改任务链"), { persistent: true, min: true })', "持久化浮层 + 可最小化到状态栏");
  has(LTE, "vw * 0.5", "最小宽 ≥ 50% 视口（与审阅窗 / 创建窗同口径）");
  has(LTE, 'const rz = lteEl("div", "lte-resize")', "右下角可拖调大小");
  has(LTE, "lteSaveSize(n)", "拖过的尺寸记 localStorage");
  has(LTE, "lteDraftSave(ta.value)", "没发出去的要求随输入落盘（关窗不丢）");
  has(LTE, 'const LTE_SESSION_KEY = "ltEditSession"', "历史接回记录仍会清掉（旧版留下的 key 不让下一次开窗复活旧上下文）");
  has(LTE, "lteAbandonPrevSessions(", "开窗时结束遗留修改会话里可能还在跑的那一轮（不许它在后台继续烧）");
  hasnt(LTE, "lteFindSession", "不再按契约抬头认回旧会话（本次需求：改任务链时重启，不继承前面的上下文）");
  hasnt(LTE, "lteSessionSave", "不再把会话 id 落盘接回（同上）");
  has(LTE, "dshMsgBlock(", "对话区复用会话视图的消息渲染");
  has(LTE, "renderAgentSession", "挂窗口级重绘钩子（流式实时）");
  has(LTE, "setInterval(", "运行期轮询兜底（重绘钩子漏了也跟得上）");

  /* 输入区在最上面（用户要写的要求靠上），不用翻滚动条才找得到 */
  const iTop = LTE.indexOf('wrap.appendChild(top)');
  const iRow = LTE.indexOf('wrap.appendChild(row)');
  const iMain = LTE.indexOf('wrap.appendChild(main)');
  ok(iTop >= 0 && iRow > iTop && iMain > iRow, "排版自上而下：抬头 → 输入区 → 对话区（要写的东西在最上面）");

  /* 出口三个：看条带 / 中断本轮 / 稍后 */
  has(LTE, 'lteT("看条带")', "出口有「看条带」");
  has(LTE, 'lteT("中断本轮")', "出口有「中断本轮」");
  has(LTE, 'lteT("稍后")', "出口有「稍后」");
  has(LTE, "stopSessionRuns(st, true)", "中断走既有的停止通道（不另造一套）");

  /* 本次需求：改任务链时重启清空会话（不继承前面的上下文，避免干扰）——
     两头都要钉住：开窗不认回旧会话、每轮发送都新起一条。 */
  const segSend = LTE.slice(LTE.indexOf("async function lteSend("), LTE.indexOf("function lteClearDraft("));
  has(segSend, "agentContractSession({", "每轮「发送」都新起一条契约会话（新上下文）");
  hasnt(segSend, "agentSessionSend(", "不再往窗内旧会话续聊（改任务链不继承前面的上下文）");
  hasnt(segSend, "st._ltEditFixRounds = 0\n  st.noPlanFlow", "追问轮那条续聊分支已移除");
  has(segSend, "stopSessionRuns(prev, true)", "上一次还在跑就先停掉（不叠在旧上下文上白烧 token）");
  const segOpen = LTE.slice(LTE.indexOf("function ltOpenEditDlg("), LTE.indexOf("window.ltOpenEditDlg = ltOpenEditDlg"));
  has(segOpen, "lteClearSessionRec()", "开窗先清历史接回记录（旧 key 不复活旧上下文）");
  has(segOpen, "lteAbandonPrevSessions(cap, task.uid)", "开窗停掉遗留会话在跑的那一轮");
  hasnt(segOpen, "lteFindSession", "开窗不再认回旧会话");
  hasnt(segOpen, "lteSessionSave", "开窗不再记「下次接着聊」");
}

/* ═══════════════ [4] 头部按钮收纳 + 装配与文案 ═══════════════ */
function headAndWiringPart() {
  console.log("\n[4] 收纳：不常用的手动按钮进「⋯ 更多」（瞬时菜单）；装配 / 样式 / i18n");
  /* 头部函数本身 = ltRenderHead 的开头到第一个菜单 helper（下面的 ltMenuClose）：
     少切这一段，下面「不再平铺」的负向断言会被菜单实现自己误伤。 */
  const headSeg = LTU.slice(LTU.indexOf("function ltRenderHead("), LTU.indexOf("function ltMenuClose("));
  has(headSeg, "ltMoreBtn(wf, task)", "头部挂着「⋯ 更多」按钮");
  has(headSeg, 'ltT("✎ 修改任务链")', "头部有「✎ 修改任务链」主入口");
  /* 「开始长任务」上移到条带右端（本次需求）：lt-spacer 之后、⚙ 之前常驻一颗「▶ 启用并绑定」
     主按钮 —— 落点仍是 ltEnable（与「⋯ 更多」那颗同一处逻辑），run 还活着时不出现。 */
  has(headSeg, 'ltT("▶ 启用并绑定")', "条带右端常驻「▶ 启用并绑定」主按钮（从「⋯ 更多」提上来）");
  has(headSeg, "ltEnable(wf, task.uid, {})", "主按钮的落点就是 ltEnable（不另造一套启用逻辑）");
  has(headSeg, "lt-spacer", "它排在 lt-spacer 之后（右端一组）");
  ok(
    headSeg.indexOf('ltEl("div", "lt-spacer")') < headSeg.indexOf('ltT("▶ 启用并绑定")') &&
      headSeg.indexOf('ltT("▶ 启用并绑定")') < headSeg.indexOf('ltT("⚙")'),
    "位置口径：lt-spacer 之后、⚙ 之前（右端主按钮）",
  );
  has(headSeg, "runLive", "run 还活着（正在跑 / 停在等你处理）时主按钮让位（不顶掉用户手里的 run）");
  has(headSeg, "ltForceAdvanceBtn(wf, run)", "run 停在手上时还有一颗「⏭ 强行进入下一状态」（本次需求：run 级统一出路）");
  /* 模型 chip 可点开（本次需求）：条带头那枚「模型 …」从只读回显变成选型入口 ——
     锚点身份 data-lt-menu="lt-model"（头部 ~90ms 一次重建后认回来，面板不被收掉），
     点开走 ltAgentPanelOpen（四格控件与清单复用 ctl 那一份，不复制清单）。 */
  has(headSeg, 'chip.setAttribute("data-lt-menu", "lt-model")', "模型 chip 是可点入口（锚点身份写在 data-lt-menu 上）");
  has(headSeg, "ltAgentPanelOpen(wf, chip)", "点 chip 开四格选型面板（不必先下钻某一环再翻检查器）");
  has(LTU, "function ltAgentPanelOpen(wf, chip) {", "面板本体在 app-longtask-ui.js");
  has(LTU, "ltMenuOpen(chip, [{ el: box }]);", "面板挂瞬时菜单的自定义内容块（不另造一套浮层）");
  /* forceAdvance 挂载（本次需求）：界面施加动作的唯一落点是引擎那一份 run 级推进 ——
     界面不自己改 run，拿不到就什么都不做（点了没反应正是要避免的）。 */
  has(LTV, "forceAdvance: ltForceAdvance,", "引擎导出 window.LT.forceAdvance（run 级手动推进）");
  has(LTV, "autoRepairGraph: ltAutoRepairGraph,", "引擎导出 autoRepairGraph（结论性图问题就地补好）");
  has(LTU, "API.forceAdvance(wf, { run: run })", "条带头那颗 ⏭ 的落点就是 LT.forceAdvance");
  /* 右端主按钮与「▶ 继续」并存：run 卡住 / 失败 / 停住时两颗都在，各管一件事 */
  ok(
    headSeg.indexOf("runLive") < headSeg.indexOf('ltT("▶ 继续")'),
    "主按钮先于「▶ 继续」渲染：run 停下时两颗并排（一个接着跑、一个按当前图重开）",
  );
  const moreSeg = LTU.slice(LTU.indexOf("function ltMoreBtn("), LTU.indexOf("function ltOpenEditDlg("));
  for (const k of ["按当前图重跑", "停用解绑", "记忆", "历史 run", "交付目录体检", "任务图校验", "🗑 删除任务"]) {
    has(moreSeg, 'ltT("' + k + '")', "「⋯ 更多」菜单里有「" + k + "」");
  }
  has(moreSeg, 'ltT("按当前图定义从起点重跑（正在跑的 run 会被替换）")', "「按当前图重跑」写清它会替换正在跑的 run");
  hasnt(moreSeg, 'ltT("重新启用（新 run）")', "旧的那颗重复项（重新启用（新 run））已收敛掉，菜单里不再有两颗同义项");
  hasnt(moreSeg, 'label: ltT("▶ 启用并绑定")', "菜单里不再有与右端主按钮同名的那一颗（收敛后只留「按当前图重跑」）");
  /* 收纳后头部不该再平铺这些：少一条断言，下次又会一顆颗爬回来 */
  hasnt(headSeg, 'ltT("记忆")', "「记忆」不再平铺在头部");
  hasnt(headSeg, "ltRunsDlg", "「历史 run」不再平铺在头部");
  hasnt(headSeg, "ltOrphanDlg", "「交付目录体检」不再平铺在头部");
  hasnt(headSeg, 'ltT("按引擎规则校验当前这张图，列出 err / warn")', "「任务图校验」菜单项不再平铺在头部（头部只留出错 chip）");
  /* 瞬时菜单：没有待提交的输入 → 点外部 / Esc 即收（AGENTS 的浮层分类） */
  has(LTU, "function ltMenuOutside(", "下拉点外部即收");
  has(LTU, 'ev.key === "Escape"', "下拉 Esc 即收");
  has(LTU, "document.body.appendChild(el)", "面板挂 body + fixed（.lt-head 是 overflow-x 容器，挂里面会被裁）");
  has(LTU, "ltMenuClose()", "开新面板前先收旧面板（不叠浮层）");
  has(LTU, 'ltEl("div", "lt-more-pop")', "面板类名 lt-more-pop（样式在 longtask.css）");
  hasnt(LTU.slice(LTU.indexOf("function ltMenuOutside("), LTU.indexOf("function ltMenuOpen(")), "persistent", "下拉不冒充持久化浮层（它本来就该点外部即收）");
  /* 条带整块重建时头部按钮也一起换掉（长任务运行期约 90ms 一次），但面板不许被这一次重建收掉：
     锚点身份写在按钮的 data-lt-menu 上，重建后由 ltMenuReadopt 认到新按钮并重新贴位；
     只有认不到锚点（这颗按钮这一帧不再存在）才收掉，绝不留飘着的孤儿。
     （本次需求变化：原来是「重建前先 ltMenuClose」，长任务跑着时点开菜单下一帧就被收。） */
  has(LTU, "ltMenuReadopt(oldMenu)", "头部重建后把挂在头部按钮上的下拉认回来（认不到才收）");
  has(LTU, 'b.setAttribute("data-lt-menu", "lt-more")', "下拉锚点身份 = 按钮上的 data-lt-menu（与按钮形状无关，重建后仍找得到）");
  has(LTU.slice(LTU.indexOf("function ltMenuReadopt("), LTU.indexOf("function ltMoreBtn(")), "ltMenuClose()", "认不到锚点仍收掉（不留锚点已失效的浮层）");

  const iUi = HTML.indexOf('src="app-longtask-ui.js"');
  const iGuide = HTML.indexOf('src="app-longtask-guide.js"');
  const iEdit = HTML.indexOf('src="app-longtask-edit.js"');
  ok(iUi >= 0 && iEdit > iUi, "index.html 加载顺序：edit 在 ui 之后（要用 ltBtn / 头部入口）");
  ok(iGuide >= 0 && iEdit > iGuide, "index.html 加载顺序：edit 在 guide 之后（复用 ltgParseGraph 与同一套会话口径）");
  for (const c of [".lte-top", ".lte-row", ".lte-ta", ".lte-main", ".lte-conv", ".lte-right", ".lte-status", ".lte-sum", ".lte-acts", ".lte-resize", ".lt-more-pop", ".lt-more-i", ".lt-btn-pri", ".lt-btn-force", ".lt-chip-model", ".lt-mdl", ".lt-mdl-h"]) {
    has(CSS, c, "longtask.css 有样式 " + c);
  }
  has(MANUAL, "任务链修改", "应用内手册补了「任务链修改」用法");

  const I = require("../renderer/i18n.js");
  I.setLocale("en");
  const keys = [
    "修改任务链",
    "这张画布没有可修改的长任务：先创建一张",
    "任务链修改",
    "任务链修改模块未就绪",
    "用一句话说清要改什么，Agent 按当前任务状态图原地改 / 修复（有全部权限）",
    "⋯ 更多",
    "其余不常用的操作（启用 / 停用 / 记忆 / 删除任务 等）",
    "按当前图定义拍一张快照开一个 run（图改过就用新版跑）",
    "按当前图定义从起点重跑（正在跑的 run 会被替换）",
    /* 「⋯ 更多」里收敛后的那颗（与右端主按钮同名重复的旧项已删） */
    "按当前图重跑",
    "解绑本画布：图与历史记录都保留，随时可再启用",
    "长任务记忆沉淀：查 / 记 / 导出到事实库",
    "看这张任务跑过的每一轮 run 与它们的图版本",
    "扫交付目录：报告缺项 / 孤儿，只报告不删",
    "按引擎规则校验当前这张图，列出 err / warn",
    "长任务设置：任务切换 / 历史 run / 交付目录体检 / 图校验",
    "收起长任务条带",
    "▶ 继续",
    "■ 停止",
    "▶ 启用并绑定",
    /* 本次需求：模型 chip 的选型入口 + run 级「⏭ 强行进入下一状态」按钮 */
    "⏭ 强行进入下一状态",
    "强行进入下一状态",
    "把卡住的环节放行、把被停止的环节排回队列，让状态机按图继续往下走（下一次先试「▶ 继续」）",
    "这一轮跑哪只模型（共 {n} 个 Agent 环节）",
    "模型选型控件未就绪",
    "停用解绑",
    "记忆",
    "历史 run",
    "交付目录体检",
    "任务图校验",
    "Agent 任务",
    "人工任务",
    "任务链已更新到 v",
    "本轮没有把改好的图写回：已让 Agent 按契约重做一次。",
    "当前任务图",
    "先用一句话写清要改什么",
    "这条修改会话留在左侧栏只作历史；下次打开本窗是一条全新会话（不继承上下文）",
    "已中断本轮：会话留着，随时可以接着说",
    "。请修正后重新调用 update_longtask。",
    "该任务正在跑（run ",
    "）：当前 run 仍按启用那刻的旧版图在跑，改图不会影响它；要按新图跑需在条带上重新启用。",
  ];
  const miss = keys.filter((k) => I.t(k) === k);
  eqNum(miss.length, 0, "i18n 中英词条齐全（en 档下这些 key 都有译文）" + (miss.length ? "（缺：" + miss.join(" / ") + "）" : ""));
  /* 新模块里每条 lteT 字面量都要有 EN 译文（不能中英混排）。
     例外只剩「纯符号 / 数字」标签（如 ）—— 它们没有可翻译的语言内容，
     I.t 原样返回即正确（这里显式列出，别处不许再用「看起来像中文却说没译文」的键）。 */
  const re = /lteT\(\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  const unmatch = [];
  while ((m = re.exec(LTE))) {
    const k = m[1].replace(/\\n/g, "\n");
    if (!k.trim() || k === "Agent" || !/[\u4e00-\u9fff]/.test(k)) continue;
    if (I.t(k) === k) unmatch.push(k);
  }
  eqNum(unmatch.length, 0, "app-longtask-edit.js 的每条中文文案都有 EN 译文" + (unmatch.length ? "（缺：" + unmatch.join(" / ") + "）" : ""));
  /* 头部收纳新增的标签同样要能中英对照 */
  const re2 = /ltT\(\s*"((?:[^"\\]|\\.)*)"/g;
  const newKeys = new Set(["▶ 继续", "■ 停止", "▶ 启用并绑定", "停用解绑", "记忆", "历史 run", "交付目录体检", "任务图校验", "⋯ 更多", "收起长任务条带", "修改任务链", "任务链修改模块未就绪", "⏭ 强行进入下一状态", "强行进入下一状态", "按当前图重跑"]);
  const bad = [];
  while ((m = re2.exec(LTU))) {
    const k = m[1].replace(/\\n/g, "\n");
    if (!newKeys.has(k)) continue;
    if (I.t(k) === k) bad.push(k);
  }
  eqNum(bad.length, 0, "头部收纳这批标签都有 EN 译文" + (bad.length ? "（缺：" + bad.join(" / ") + "）" : ""));
}

async function main() {
  await enginePart();
  toolPart();
  dialogPart();
  headAndWiringPart();
  console.log("\n" + (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全部通过") + "  (smoke-longtask-edit)");
  process.exit(fails ? 1 : 0);
}

main().catch((e) => {
  console.log("测试异常：" + String((e && e.stack) || e));
  process.exit(1);
});