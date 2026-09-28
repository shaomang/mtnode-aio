"use strict";
/**
 * test/smoke-longtask-canvas.js —— 长周期任务「内容不许生成到错误的画布」
 *
 * 用户口径（本轮需求）：长任务跑着的时候用户会切去别的画布干活 —— 那一刻之后，
 * 交付节点 / 产出节点 / 产物节点 / 超级节点壳、交付目录、output 落盘目录、Agent 工作区
 * 与记忆作用域**一处都不许漂**。一切「写哪张画布 / 用哪个工作目录」的判断只认
 * run.wfId（run 的所属画布），不认 S.wf（用户此刻正看着的那张）。
 *
 * 断言按层排：
 *   [1] 绑定层与唯一口径（静态）：ltRunCanvas / ltSyncCanvas / ltAfterCanvasWrite /
 *       ltNewSystemNode / 拒绝口径；三个模块（引擎 / 壳 / 产物）都接了同一份口径；
 *       全仓没有「按 S.wf 写」的旧写法残留。
 *   [2] 真跑（vm 整份装 app-longtask.js + app-longtask-out.js + app-longtask-artifacts.js
 *       + app-longtask-shell.js）：用户切画布之后引擎写的是 run 那张、不重绘用户屏幕、
 *       按对象 id 落盘；交付目录 / output 落盘 / 产物都落在 run 的画布与工作目录上；
 *       用户切回来时口径照旧（该重绘就重绘）；归属画布解析不到时整笔不写（宁缺勿错）；
 *       创建期预建（壳 / 生成工作流 / 交付节点）只建不跑、启用后认领与按 uid 复用。
 *   [3] i18n：拒绝句与句尾那件东西的名字中英成对（切英文不回中文）。
 * 只读断言：不改任何文件、不起 Electron。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const I18n = require(path.join(__dirname, "..", "renderer", "i18n.js"));

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, ...rel.split("/")), "utf8").replace(/\r\n?/g, "\n");

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

const LTV = read("renderer/app-longtask.js");
const LTSHELL = read("renderer/app-longtask-shell.js");
const LTART = read("renderer/app-longtask-artifacts.js");
const LTOUT = read("renderer/app-longtask-out.js");

/* ═══════════════ [1] 绑定层与唯一口径（静态） ══════════════ */
console.log("\n[1] 「写哪张画布」只有一个口径：run.wfId（不认 S.wf）");
has(LTV, "function ltRunCanvas(run) {", "引擎有 ltRunCanvas(run)：前台 → 内存袋，解析不到就 null（绝不退回前台画布）");
has(LTV, "if (vis && String(vis.id || \"\") === id) return vis;", "解析顺序①：前台那张就是它 → 用它（绝大多数时候零开销）");
has(LTV, "if (typeof canvasWfByIdLoaded === \"function\") {", "解析顺序②：已加载进内存袋的那张（loadWorkflow 的对象就是它，改的才是用户看得见的那份）");
has(LTV, "function ltAfterCanvasWrite(wf) {", "碰完画布统一收尾 ltAfterCanvasWrite(wf)：前台才重绘 + 前台保存通道");
has(LTV, "ltPersistWf(wf);", "后台那张按对象自己的 id 落盘（persistWf 写谁就是谁，不串前台）");
has(LTV, "function ltSyncCanvas(wf, fn) {", "同步段 ltSyncCanvas(wf, fn)：段内 S.wf 临时换归属画布（借用 runAgainstWf 的交接语义）");
has(LTV, "function ltNewSystemNode(wf, kind, x, y, extra) {", "系统节点统一走 ltNewSystemNode(wf, …)（makeNode 建 + 自己入列，不弹 toast / 不进撤销栈）");
has(LTV, "function ltCanvasRefused(run, what) {", "归属画布解析不到 = ltCanvasRefused：记日志、这一笔不写");
has(LTV, 'ltT("归属画布已不在（或还没打开），这一笔没有写：")', "拒绝时给用户一句说得清的话（不是静默丢内容）");
has(LTV, "if (!wf) return ltCanvasRefused(run, ltT(\"交付节点\"));", "交付节点：归属画布解析不到就不建（旧口径会建到前台那张）");
has(LTV, "if (!wf) return ltCanvasRefused(run, ltT(\"交付节点对齐\")) || 0;", "交付对齐链同样先定归属");
has(LTV, "if (!wf) return ltCanvasRefused(run, ltT(\"产出节点\"));", "产出节点：同上");
has(LTV, "if (!wf) return ltCanvasRefused(run, ltT(\"产出回流\"));", "产出回流整链：同上");
has(LTV, "const wf = ltCanvasOfNode(node) || (typeof S !== \"undefined\" ? S.wf : null);", "界面入口（用户在节点上改清单 / 收线）按**节点所在画布**办事");
has(LTV, "function ltCanvasOfNode(node) {", "ltCanvasOfNode：节点 → 它所在的那张画布（ownerWfOfNode → 前台 / S.wf / 内存袋）");
has(LTV, "function ltWfWorkspace(wf) {", "工作目录按画布对象取（交付目录 / output / 记忆作用域共用一个口径）");
has(LTV, "runKey: pn.id,", "Agent 环节的 dshOpts 仍按伪节点 id 分键（口径未动）");
has(LTV, "canvasWfId: String(run.wfId || \"\"),", "并把**本轮绑定画布**显式交给 dshRunTask（画布读写 / 应用 op / 工作区全按它算）");
has(LTV, "st.canvasWfId = String(run.wfId);", "绑定会话每次执行都校准 canvasWfId（老档案是空的时候也不许退回前台）");
has(LTV, "if (!j.wfId) j.wfId = String(wf.id || \"\");", "极老 checkpoint 缺 wfId 时按「读它出来的那张画布」补上归属");
has(LTV, "runCanvas: ltRunCanvas,", "绑定口径从 window.LT 导出（UI / 壳 / 产物 / 测试共用同一份）");
has(LTV, "afterCanvasWrite: ltAfterCanvasWrite,", "收尾分流同样导出");
has(LTSHELL, "function ltsBindWf(wf) {", "壳模块有 bindWf(wf)：引擎进入前绑、退出还原");
has(LTSHELL, "if (ltsCtxWf) return ltsCtxWf;", "壳内 ltsWf 优先取绑定画布（没绑定才是当前画布）");
has(LTSHELL, "if (ltsCtxWf && typeof persistWf === \"function\") persistWf(ltsCtxWf);", "壳改的是后台那张 → 只按 id 落盘，不重绘用户屏幕");
has(LTSHELL, "bindWf: ltsBindWf,", "bindWf 从 window.LTSHELL 导出");
has(LTV, "if (typeof sh.bindWf === \"function\") sh.bindWf(wf);", "引擎包装层进壳前绑定归属画布");
has(LTV, "if (run && run.wfId) return ltCanvasRefused(run, ltT(\"长任务壳\"));", "归属画布解析不到 → 壳整段不进（壳的 ltsWf 没有归属会退回 S.wf）");
has(LTART, "function ltArtWfOf(run) {", "产物模块有 ltArtWfOf(run)：run.wfId 优先，解析不到不退回前台");
has(LTART, "ltArtSync(wf, () => {", "产物的建 / 改节点放进同步段（段内 S.wf = 归属画布）");
has(LTART, "ltArtAfterWrite(wf);", "产物的收尾同样分流重绘 / 按 id 落盘");
has(LTART, "function ltArtNodeOf(taskUid, path, file, wfIn) {", "产物认人按显式画布（异步清点期间用户切画布也不串）");
has(LTART, "function ltArtPick(paths, limit) {", "只摆「关键文件」的挑选函数在（本轮需求：中间件不占画布）");
has(LTART, "const keys = ltArtPick(own);", "发布链先挑关键件，再为要摆的那几件读指纹（不整轮扫 IO）");
has(LTOUT, "function ltOutNodeOf(nodeId, run) {", "产出回流找节点按本 run 所属画布（切走后不许把产出判成「被删」）");
/* 旧写法一处都不许留：这四条正文就是本轮的回归闸 */
hasnt(LTV, "ltDeliverWriteToGraph(S && S.wf", "交付清单回写不再按前台画布");
hasnt(LTV, "if (String(run.wfId || \"\") !== String(S.wf.id || \"\")) return 0;", "旧产物救援的「必须正好是当前画布」前置条件已去掉（切走也能救，救的是它自己那张）");
hasnt(LTV, "await ltDeliverReconcileDisk(node, node && node.ltDir);", "磁盘对账不再缺 wf（缺了就会按前台画布的工作目录去认文件）");
hasnt(LTV, "ltAutoCollectSoon();", "自动收线一律带上本 run（否则收的是前台那张的线）");
hasnt(LTV, "workspace: cfg.workspace || (typeof wfWorkspace === \"function\" ? wfWorkspace() : undefined),", "Agent 工作区不再现取前台画布的工作目录");
hasnt(LTART, "if (typeof S === \"undefined\" || !S.wf) return out;", "产物模块不再以前台画布为前置条件");

/* ═══════════════ [2] 真跑：用户切画布之后 ═══════════════ */
async function part2() {
  console.log("\n[2] 真跑：跑着的时候用户切去另一张画布（内容仍写进 run 自己那张）");
  const probe = { renders: 0, saves: 0, persisted: [], listWs: [], joins: [], ensureWs: [], ensureArgs: null, toast: [] };
  let nodeSeq = 0;
  const files = new Map(); /* path → { size, mtime } */
  const setFile = (p, mtime, size) => files.set(String(p), { mtime, size, content: "" });
  const wfA = { id: "wfA", name: "A 项目", workspace: "D:\\projA", nodes: [], wires: [], cam: { x: 0, y: 0, k: 1 } };
  const wfB = { id: "wfB", name: "B 项目", workspace: "D:\\projB", nodes: [], wires: [], cam: { x: 0, y: 0, k: 1 } };
  const S = { wf: wfA, wfBag: { wfA: wfA, wfB: wfB }, config: {}, _skipCanvasHistory: false };
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
        fileWriteText: async (p) => {
          files.set(String(p), { mtime: 1, size: 1, content: "" });
          return { ok: true };
        },
        pathJoin: (a, b) => {
          probe.joins.push([a, b]);
          return String(a).replace(/[\\/]+$/, "") + "\\" + String(b).replace(/^[\\/]+/, "");
        },
        ltDeliverEnsure: async (args) => {
          probe.ensureArgs = args || {};
          probe.ensureWs.push(String((args && args.workspace) || ""));
          return {
            ok: true,
            dir: String((args && args.workspace) || "") + "\\mtnode-deliverables\\" + String((args && args.uid) || ""),
            manifest: { items: (args && args.items) || [] },
          };
        },
        ltDeliverList: async (a) => {
          probe.listWs.push(String((a && a.workspace) || ""));
          return { ok: true, dir: "", files: [] };
        },
        ltRunSave: async () => ({ ok: true }),
        ltMemAdd: async () => ({ ok: true, ids: [] }),
        ltMemRecall: async () => ({ ok: true, items: [] }),
        dshInteract: () => {},
      },
    },
    S: S,
    I18n: { t: (s) => s },
    document: { readyState: "loading", addEventListener() {}, getElementById() { return null; } },
    toast: (m, k) => probe.toast.push(String(m)),
    scheduleSave: () => { probe.saves++; },
    renderCanvas: () => { probe.renders++; },
    persistWf: (wf) => probe.persisted.push(String((wf && wf.id) || "")),
    currentVisibleWf: () => S.wf,
    canvasWfByIdLoaded: (id) => (S.wfBag || {})[String(id)] || null,
    canvasTargetWf: () => S.wf,
    runAgainstWf: (wf, fn) => {
      const prev = S.wf;
      S.wf = wf;
      try {
        return fn();
      } finally {
        if (S.wf === wf) S.wf = prev;
      }
    },
    wfWorkspace: () => String((S.wf && S.wf.workspace) || ""),
    makeNode: (kind, x, y) => ({ id: "mk" + ++nodeSeq, kind: kind, x: x, y: y, w: 360, h: 260, title: kind, text: "", cfg: {} }),
    uniqueNodeTitle: (t) => t,
    focusNode() {},
    addNode() {
      return null;
    },
    console, setTimeout, clearTimeout, Map, Set, Promise, JSON, Math, Date, Object, Array, String, Number, RegExp,
  };
  vm.createContext(sandbox);
  vm.runInContext(LTV, sandbox, { filename: "renderer/app-longtask.js" });
  vm.runInContext(LTOUT, sandbox, { filename: "renderer/app-longtask-out.js" });
  vm.runInContext(LTART, sandbox, { filename: "renderer/app-longtask-artifacts.js" });
  vm.runInContext(LTSHELL, sandbox, { filename: "renderer/app-longtask-shell.js" });
  ok(!!sandbox.window.LT && !!sandbox.window.LTOUT && !!sandbox.window.LTART && !!sandbox.window.LTSHELL, "四份脚本在同一沙箱里整份执行并各自导出（顶层不碰 DOM）");

  const GRAPH = {
    nodes: [
      { id: "a", kind: "agent", title: "起草", cfg: { goal: "写一版稿", outKeys: ["draft"] } },
      { id: "h", kind: "human", title: "交稿", cfg: { mode: "deliver", uid: "ltx-1", items: [{ id: "i1", kind: "file", title: "分镜表.md", file: "分镜表.md", required: true, done: false }] } },
    ],
    edges: [],
  };
  const mkTask = (uid) => ({ uid: uid, name: "演示任务", graph: JSON.parse(JSON.stringify(GRAPH)) });
  const runA = sandbox.ltRunNew(mkTask("taskA"), "wfA", {});
  sandbox.ltInst(runA, "", runA.graph);

  /* ① 用户切到 B 画布：引擎这一笔仍写在 A（且不打扰用户的屏幕） */
  S.wf = wfB;
  const p0 = probe.renders;
  const nodeA = await sandbox.ltOutputPublish(runA, "a", { text: "第一版正文" });
  ok(!!nodeA && nodeA.kind === "ltout", "产出节点建出来了（内容没有丢）");
  eqNum(wfA.nodes.filter((n) => n.kind === "ltout").length, 1, "产出节点落在 run 的所属画布（wfA）上");
  eqNum(wfB.nodes.length, 0, "用户切过去的那张画布（wfB）上一个节点都没多");
  eqNum(probe.renders, p0, "不重绘用户屏幕（renderCanvas 没被叫：他正看着别的图）");
  ok(probe.persisted.indexOf("wfA") >= 0, "改的是后台那张 → 按对象自己的 id 落盘（persistWf(wfA)）");
  eqNum(probe.saves, 0, "也没有走前台保存通道（scheduleSave 一次都没叫）");

  /* ② 交付环节：交付目录 / manifest 都跟着 run 那张画布的工作目录 */
  const hNode = sandbox.ltNodeAt(runA, "h");
  await sandbox.ltExecHuman(runA, "h", hNode);
  eqNum((probe.ensureArgs && probe.ensureArgs.uid) || "", "ltx-1", "交付环节按 uid 建交付目录（流程照旧）");
  eqNum(probe.ensureWs[0], "D:\\projA", "交付目录创建带的是 run 所属画布的工作目录（不是 wfB 的 D:\\projB）");
  eqNum(runA.nodes["h"].status, "waiting_delivery", "本环节转入等交付（流程照旧）");
  ok(String(runA.nodes["h"].dir || "").indexOf("D:\\projA") === 0, "交付目录建在 wfA 的工作目录下（不是 wfB 的 D:\\projB）");
  const dNode = await sandbox.ltEnsureDeliverNode(runA, "h", hNode);
  ok(!!dNode && dNode.kind === "deliver", "交付节点建出来了");
  eqNum(wfA.nodes.filter((n) => n.kind === "deliver").length, 1, "交付节点落在 wfA 上");
  eqNum(wfB.nodes.length, 0, "wfB 依然干净");
  probe.listWs.length = 0;
  const syncRes = await sandbox.ltDeliverSyncFromNode(dNode);
  ok(!!syncRes, "在交付节点上改清单（界面入口）也认得出它属于 wfA");
  eqNum(probe.listWs[0], "D:\\projA", "磁盘对账读的交付目录用 wfA 的工作目录（不是 wfB 的 D:\\projB）");

  /* ③ 产物上画布同样落在 run 那张 */
  const artPath = "D:\\projA\\shots\\shotlist.md";
  setFile(artPath, 100, 10);
  const artRes = await sandbox.ltArtPublish(runA, "a", [artPath]);
  eqNum(artRes.placed, 1, "产物清点后摆了一颗");
  eqNum(wfA.nodes.filter((n) => n.kind === "ltart").length, 1, "产物节点落在 wfA 上");
  eqNum(wfB.nodes.length, 0, "wfB 依然干净");
  /* ③之二 关键件闸（本轮需求）：中间件 / 视频 / 日志不占画布，清点口径不动 */
  const midPath = "D:\\projA\\shots\\shots.json";
  const vidPath = "D:\\projA\\shots\\take-01.mp4";
  setFile(midPath, 100, 10);
  setFile(vidPath, 100, 10);
  const midRes = await sandbox.ltArtPublish(runA, "a", [midPath, vidPath]);
  eqNum(midRes.placed, 0, "中间件与视频一件都不摆");
  eqNum(midRes.own, 2, "但仍然照常清点（own 记着两件，文件没丢）");
  eqNum(wfA.nodes.filter((n) => n.kind === "ltart").length, 1, "画布上仍只有报告那一颗产物节点");

  /* ④ output 环节的相对路径按 run 那张画布的工作目录展开 */
  sandbox.ltStatePut(runA, "", "draft", "正文");
  await sandbox.ltExecOutput(runA, "b", { kind: "output", title: "落盘", cfg: { key: "draft", path: "out.md" } }, "");
  const wrote = probe.joins.filter((j) => String(j[1]).indexOf("out.md") >= 0);
  ok(wrote.length >= 1 && wrote[0][0] === "D:\\projA", "output 落盘路径展开用的是 wfA 的工作目录（D:\\projA\\out.md）");

  /* ⑤ 壳模块：绑定期间口径 = 归属画布，退出即还原 */
  sandbox.window.LTSHELL.bindWf(wfA);
  const boundId = sandbox.window.LTSHELL.boundWf();
  eqNum(String((boundId && boundId.id) || ""), "wfA", "壳模块绑定期间 ltsWf = 归属画布（即便 S.wf 是 wfB）");
  sandbox.window.LTSHELL.bindWf(null);
  const afterId = sandbox.window.LTSHELL.boundWf();
  eqNum(String((afterId && afterId.id) || ""), "wfB", "退出绑定后回到「当前画布」口径（界面入口不受影响）");

  /* ⑥ 用户切回 A：口径照旧 —— 该重绘就重绘、该走前台保存就走 */
  S.wf = wfA;
  probe.persisted.length = 0;
  const p1 = probe.renders;
  const again = await sandbox.ltOutputPublish(runA, "a", { text: "第二版正文" });
  eqNum(again.id, nodeA.id, "切回来再跑一轮：复用同一颗产出节点（不堆）");
  eqNum(wfA.nodes.filter((n) => n.kind === "ltout" && n.ltPath === "a").length, 1, "环节 a 的产出节点仍只有一颗（不堆）");
  ok(probe.renders > p1, "用户看着它的时候照常重绘（界面体验没有退化）");
  ok(probe.saves >= 1, "并走前台保存通道（scheduleSave）");
  eqNum(probe.persisted.length, 0, "前台那张不走 persistWf（两条落盘通道各写各的，不重复）");

  /* ⑦ 归属画布解析不到（已删 / 还没打开）：整笔不写，绝不落到用户看着的那张 */
  const runGone = sandbox.ltRunNew(mkTask("taskGone"), "wfGone", {});
  sandbox.ltInst(runGone, "", runGone.graph);
  eqNum(sandbox.ltRunCanvas(runGone), null, "ltRunCanvas：画布不在内存里就是 null（不退回前台）");
  S.wf = wfB;
  const kindsBefore = JSON.stringify(wfA.nodes.map((n) => n.kind + ":" + (n.ltPath || "")));
  const nothing = await sandbox.ltOutputPublish(runGone, "a", { text: "不该写出去" });
  eqNum(nothing, null, "产出发布整笔不写（返回 null）");
  eqNum(wfB.nodes.length, 0, "用户看着的那张画布一个节点都没多（宁缺勿错）");
  eqNum(JSON.stringify(wfA.nodes.map((n) => n.kind + ":" + (n.ltPath || ""))), kindsBefore, "run 自己的画布也没被硬塞（节点清单逐字未变）");
  has(JSON.stringify(runGone.log || []), "归属画布已不在", "并在 run 日志里留下一句「这一笔没有写」（用户看得见发生了什么）");

  /* ⑧ 会话档案：绑定会话的 canvasWfId 每次都校准到 run.wfId */
  let persistedSess = 0;
  sandbox.agentSessions = () => [];
  sandbox.agentContractSession = () => null;
  sandbox.persistAgentSession = () => { persistedSess++; };
  sandbox.ltBindAgentSession(runA, "a", sandbox.ltNodeAt(runA, "a"), { id: "p1" });
  eqNum(persistedSess, 0, "会话基建缺席时不装配（长任务照常跑，不抛）");

  /* ⑨ 创建期预建（本轮需求「创建即显示」）：壳 / 生成工作流 / 交付节点在**任务所属画布**
        上一次建好，一律只建不跑；启用后被认领（不重长）、按 uid 复用（不重复建）、
        用户删掉后不偷偷重长。口径与本节主线一致：一切「写哪张画布」只认任务自己那张。 */
  console.log("     · 创建期预建：落点一次建好（只建不跑）+ 启用后认领 / 复用 / 不重长");
  {
    const wfC = { id: "wfC", name: "C 项目", workspace: "D:\\projC", nodes: [], wires: [], cam: { x: 0, y: 0, k: 1 } };
    S.wfBag.wfC = wfC;
    S.wf = wfB; /* 用户此刻看着 B：预建必须全部落在任务所属的 C 上 */
    const GRAPH9 = {
      nodes: [
        { id: "s", kind: "start", title: "起点" },
        { id: "a1", kind: "agent", title: "写分镜", cfg: { goal: "写一版分镜", outKeys: ["draft"] } },
        {
          id: "h",
          kind: "human",
          title: "交稿",
          cfg: {
            mode: "deliver",
            uid: "ltx-9",
            items: [{ id: "i1", kind: "file", title: "分镜表.md", file: "分镜表.md", required: true, done: false, paths: [] }],
          },
        },
        { id: "e", kind: "end_ok", title: "收工" },
      ],
      edges: [
        { id: "e1", from: "s", to: "a1" },
        { id: "e2", from: "a1", to: "h" },
        { id: "e3", from: "h", to: "e" },
      ],
    };
    probe.ensureWs.length = 0;
    const made9 = sandbox.window.LT.createFromGraph("预建演示", GRAPH9, wfC);
    ok(made9 && made9.ok === true, "在后台画布上创建任务：照常落库（收尾不影响创建本身）");
    const task9 = sandbox.ltTaskOf(wfC, made9.uid);
    eqNum(wfB.nodes.length, 0, "预建一处都没落进用户看着的那张画布（归属画布 = 任务自己那张）");
    const shells9 = wfC.nodes.filter((n) => n.kind === "super");
    eqNum(shells9.length, 2, "按图路径一次建齐：父壳 + 环节子壳（不再等跑到那一环才懒建）");
    const root9 = shells9.find((n) => !String(n.ltShellPath || "").trim());
    const step9 = shells9.find((n) => String(n.ltShellPath || "") === "a1");
    ok(!!root9 && !!step9, "父壳 / 环节子壳按 ltShellTask / ltShellPath 认得出身份");
    eqNum(String(root9.ltShellTask), String(task9.uid), "父壳绑定任务身份（与运行时懒建同一套字段）");
    const gens9 = wfC.nodes.filter((n) => String(n.parentSuperId || "") === String(step9.id) && n.ltGenType);
    eqNum(gens9.length, 1, "生成工作流预置到子壳里（缺省图像一枚）");
    ok(!gens9[0].running && !gens9[0].output, "预建的生成节点没有跑过（不替用户烧额度）");
    const dn9 = wfC.nodes.filter((n) => n.kind === "deliver");
    eqNum(dn9.length, 1, "交付环节的交付节点在创建那一刻就建好（旧口径要跑到才建）");
    eqNum(String(dn9[0].ltUid), "ltx-9", "交付节点按图里的交付 uid 认人（与运行时同一份身份）");
    eqNum(String(dn9[0].ltPath), "h", "交付节点带环节路径（清单 / 上传有宿主）");
    eqNum(String(dn9[0].ltRunId), "", "创建期没有 run：ltRunId 留空（启用后按同一 uid 复用这颗节点）");
    eqNum(dn9[0].__ltSystem, true, "交付节点带 __ltSystem（不进撤销栈、不能手动复制 / 新建）");
    eqNum((dn9[0].ltItems || []).length, 1, "图里的交付清单预置到节点上（创建完就知道要交什么）");
    ok(
      probe.ensureWs.length >= 1 && probe.ensureWs[probe.ensureWs.length - 1] === "D:\\projC",
      "交付目录 / manifest 落到该画布的工作目录（不落到用户看着的 B）",
    );
    ok(task9.enabled === false && !String(task9.activeRun || ""), "预建只建不跑：enabled 仍 false、没有 run");
    const nCount9 = wfC.nodes.length;
    sandbox.window.LTSHELL.ensureForTask(wfC, task9);
    eqNum(wfC.nodes.length, nCount9, "预建幂等：再叫一次节点数逐字不变");
    /* 启用 / 认领 / 删壳这几步：引擎是在包装层里 bindWf(run 的所属画布) 再进壳的，
       这里显式绑定同一个现场（用户此刻还看着 B）—— 壳的「哪张画布」判断只认它。 */
    const prevBind9 = sandbox.window.LTSHELL.bindWf(wfC);
    try {
      /* 启用（run 起来）之后：预建的壳被认领、交付节点按 uid 复用 —— 一处都不重复建 */
      const run9 = sandbox.ltRunNew(task9, "wfC", {});
      sandbox.ltInst(run9, "", run9.graph);
      const claim9 = sandbox.window.LTSHELL.ensure(run9, "a1");
      eqNum(claim9.created, 0, "预建壳被启用后的 ltsEnsure 认领：不新建壳");
      eqNum(wfC.nodes.length, nCount9, "认领不动节点：不重长壳、也不重复摆生成工作流");
      ok(
        !!run9.shellPaths && run9.shellPaths[""] === 1 && run9.shellPaths["a1"] === 1,
        "预建的壳按路径登记进 run.shellPaths（此后「删没删」按它判）",
      );
      const h9 = sandbox.ltNodeAt(run9, "h");
      await sandbox.ltExecHuman(run9, "h", h9);
      eqNum(wfC.nodes.filter((n) => n.kind === "deliver").length, 1, "跑到交付环节：按 uid 复用预建的那颗（不重复建）");
      eqNum(run9.nodes["h"].status, "waiting_delivery", "环节照旧转入等交付（流程不变）");
      await sandbox.ltRebindDeliverNodes(run9);
      eqNum(
        wfC.nodes.filter((n) => n.kind === "deliver").length,
        1,
        "恢复现场链路（ltRebindDeliverNodes）也按同一 uid 认人复用（仍然只有一颗）",
      );
      /* 用户把预建的壳删掉：认领过就该按墓碑口径走 —— 只提示不重建 */
      wfC.nodes = wfC.nodes.filter((n) => String(n.ltShellTask || "") !== String(task9.uid));
      const gone9 = sandbox.window.LTSHELL.ensure(run9, "a1");
      eqNum(gone9.gone, true, "预建壳被用户删掉 → gone = true（认领之后照旧不偷偷重长）");
      eqNum(wfC.nodes.filter((n) => n.kind === "super").length, 0, "画布上没有壳被静默重建");
      eqNum(run9.shellGone, true, "墓碑落在本 run 上（run.shellGone），提示只发一次");
    } finally {
      sandbox.window.LTSHELL.bindWf(prevBind9);
    }
    S.wf = wfB;
  }
}

/* ══════════════ [3] i18n ═══════════════ */
function part3() {
  console.log("\n[3] 拒绝句中英成对（切英文不改回中文）");
  const KEYS = [
    "归属画布已不在（或还没打开），这一笔没有写：",
    "交付节点",
    "交付节点对齐",
    "产出节点",
    "产出回流",
    "长任务壳",
  ];
  I18n.setLocale("en");
  const noEn = KEYS.filter((k) => I18n.t(k) === k);
  ok(noEn.length === 0, KEYS.length + " 条词条都有英文译文" + (noEn.length ? "（缺：" + noEn.join(" | ") + "）" : ""));
  I18n.setLocale("zh");
  ok(KEYS.every((k) => I18n.t(k) === k), "中文档逐条原样返回（词条结构未被破坏）");
}

async function main() {
  await part2();
  part3();
  console.log(
    "\n" + (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全部通过") + "  (smoke-longtask-canvas)",
  );
  process.exit(fails ? 1 : 0);
}
main().catch((err) => {
  console.log("\n测试异常：" + ((err && (err.stack || err.message)) || err));
  process.exit(1);
});