"use strict";
/**
 * test/smoke-longtask-error-exit.js —— 长周期任务：**报错出路**（无视报错，直接进下一环）
 *
 * 本轮需求：长任务某一环报错后必须能当场「无视这次报错」继续往下走（可指定跳到哪一环），
 * 不许用户卡死在这个阶段。改动横跨三层，断言按层排：
 *   [1] 引擎真行为（vm 里真跑，不是 grep）：给一条 blocked / failed 的环节落放行 ——
 *       ltApplySkip 点火下游（留空 = 走它自己的下游，填了 = 只点「本环节 → 目标」那条边）、
 *       写干预痕迹 run.fixes、撤等人登记；ltErrorNextTarget 按 id **或标题**认目标；
 *       ltErrorSkipOn 只看 cfg.onError === "skip"；ltResolveErrorFinal 是自动放行那条闸。
 *   [2] 卡死解除：ltRearmSkipped 不复活用户放行过的环节；ltSettleRunStatus 不再把
 *       已放行环节（及它内部的子槽）算回 blocked。
 *   [3] 界面与词条：卡片 / 检查器共用的出路控件（跳到哪一环 + 放行按钮 + 写回图定义）、
 *       LT.manualResolve 是唯一落点、css / i18n 中英齐备、手册写了这条出路。
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

const LTV = read("renderer/app-longtask.js");
const LTU = read("renderer/app-longtask-ui.js");
const LTCSS = read("renderer/css/longtask.css");
const I18N = read("renderer/i18n.js");
const MANUAL = read("guides/manual/longtask.md");

/* ═══════════ [1][2] 引擎真行为：放行 = 点火 + 痕迹 + 不复活 ═══════════ */
async function enginePart() {
  console.log("\n[1] 引擎：报错出路（vm 里真跑 ltApplySkip / ltErrorNextTarget / ltResolveErrorFinal）");
  const sandbox = {
    window: { api: {}, mtnodeJsExec: { run: async () => ({ ok: true, value: true }) } },
    S: { wf: null, config: {} },
    I18n: { t: (s) => s },
    toast() {},
    scheduleSave() {},
    persistWf() {},
    currentVisibleWf() {
      return null;
    },
    renderCanvas() {},
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

  for (const k of ["manualResolve", "errorSkipOn", "errorNextTarget", "applySkip", "resolveErrorFinal"]) {
    ok(typeof LT[k] === "function", "window.LT 导出 " + k);
  }

  /* 图：s → a（会报错）→ b → e；另有旁支 c（挂在 b 上，用来验证「跳到哪一环」不是乱点火） */
  const G = LT.norm({
    nodes: [
      { id: "s", kind: "start", title: "起点" },
      { id: "a", kind: "agent", title: "a_check", cfg: { goal: "核对", outKeys: ["ok"] } },
      { id: "b", kind: "agent", title: "起草", cfg: { goal: "起草", outKeys: ["draft"] } },
      { id: "c", kind: "agent", title: "配图", cfg: { goal: "配图", outKeys: ["img"] } },
      { id: "e", kind: "end_ok", title: "收工" },
    ],
    edges: [
      { id: "e1", from: "s", to: "a" },
      { id: "e2", from: "a", to: "b" },
      { id: "e3", from: "b", to: "c" },
      { id: "e4", from: "c", to: "e" },
    ],
  });
  const mk = () => {
    const run = {
      runId: "r1",
      wfId: "wf1",
      aborted: false,
      booted: true,
      status: "blocked",
      graph: G,
      inst: { "": G },
      fired: { e1: 1 },
      nodes: {},
      ns: {},
      waits: [],
      fixes: [],
      rounds: {},
      opts: {},
      log: [],
    };
    for (const n of G.nodes) run.nodes[n.id] = { status: n.id === "s" ? "done" : "pending", rounds: [], tries: 0, err: "", since: 0 };
    run.nodes.a.status = "blocked";
    run.nodes.a.err = "429 限流";
    return run;
  };
  const nodeOf = (id) => G.nodes.filter((n) => n.id === id)[0];

  /* ① 判据：只有 cfg.onError === "skip" 才算自动放行 */
  eqNum(LT.errorSkipOn(nodeOf("a")), false, "没勾「无视报错」→ 不自动放行（默认停住等人）");
  eqNum(LT.errorSkipOn({ cfg: { onError: "skip" } }), true, 'onError === "skip" → 自动放行');
  eqNum(LT.errorSkipOn({ cfg: { onError: "SKIP" } }), false, "只认小写 skip（不做模糊匹配）");

  /* ② 归一化真的保住了新字段（不归一 = 检查器写进去的值下一轮被洗掉） */
  const normed = G.nodes.filter((n) => n.id === "a")[0];
  eqNum(normed.cfg.onError, "", "ltNormCfg 归一化出 onError（缺省空）");
  eqNum(normed.cfg.onErrorNext, "", "ltNormCfg 归一化出 onErrorNext（缺省空）");
  const keep = LT.norm({ nodes: [{ id: "z", kind: "agent", title: "z", cfg: { onError: "skip", onErrorNext: "b" } }], edges: [] });
  const zn = keep.nodes.filter((n) => n.id === "z")[0];
  eqNum(zn.cfg.onError, "skip", "归一化保住 onError = skip（图定义里的自动放行不丢）");
  eqNum(zn.cfg.onErrorNext, "b", "归一化保住 onErrorNext = b");

  /* ③ 目标解析：id 与标题都认，且落在同一命名空间 */
  let run = mk();
  ok(LT.errorNextTarget(run, "a", "b") === "b", "填环节 id → 目标路径就是它");
  ok(LT.errorNextTarget(run, "a", "起草") === "b", "填环节**标题**也能认（图里唯一看得出的身份）");
  ok(LT.errorNextTarget(run, "a", "") === "", "留空 → 没有指定目标（走自己的下游）");
  ok(LT.errorNextTarget(run, "a", "不存在") === "不存在", "填了图里没有的名字：原样当 id（自由跳跃，不假装认得出）");
  ok(LT.errorNextTarget(run, "sub/x", "b") === "sub/b", "子图里解析出的目标仍落在**同一个命名空间**");

  /* ④ ltApplySkip：blocked → skipped + 点火全部下游边 + 痕迹 + 撤等人登记 */
  run = mk();
  run.waits.push({ id: "w1", path: "a", kind: "approve", title: "a_check" });
  let fired = await LT.applySkip(run, "a", { mode: "skip", by: "user", reason: "无视报错，跳过这一环" });
  eqNum(run.nodes.a.status, "skipped", "放行后这一环记为 skipped（不再是 blocked）");
  eqNum(run.nodes.a.err, "", "报错文本清掉（不再挂着一句已处理的错）");
  ok(!!run.nodes.a.skippedBy, "留下「已放行」的痕迹（卡片上显示得出）");
  eqNum(fired, 1, "点火下游：本环节那一条出边被点着");
  eqNum(run.fired.e2, 1, "a → b 这条边真的进了点火记录");
  eqNum(run.waits.length, 0, "等人登记一并撤掉（它不在等谁了）");
  eqNum(run.fixes.length, 1, "干预痕迹 run.fixes 记了一条（随 checkpoint 落盘）");
  eqNum(run.fixes[0].mode, "skip", "痕迹里写明是「跳过」");
  eqNum(run.fixes[0].by, "user", "痕迹里写明是用户点的（不是自动放行）");
  eqNum(run.nodes.b.status, "pending", "下游 b 回到 pending（下一轮主循环会抓它）");
  const ready = LT.allReady(run);
  ok(ready.indexOf("b") >= 0, "ltAllReady 真的把 b 交出来了（放行 = 状态机继续动，不是只改个颜色）");

  /* ⑤ 指定目标：只点「本环节 → 目标」那条边，不顺手把 b 也点着 */
  run = mk();
  const G2 = LT.norm({
    nodes: G.nodes,
    edges: [
      { id: "e1", from: "s", to: "a" },
      { id: "e2", from: "a", to: "b" },
      { id: "e5", from: "a", to: "c" },
      { id: "e4", from: "c", to: "e" },
    ],
  });
  run.graph = G2;
  run.inst = { "": G2 };
  run.nodes.c = { status: "pending", rounds: [], tries: 0, err: "", since: 0 };
  fired = await LT.applySkip(run, "a", { mode: "skip", target: "c", by: "user" });
  eqNum(fired, 1, "填了目标：点着一条边");
  eqNum(run.fired.e5, 1, "点的是 a → c 这条边（{target} 认的是目标那一环）");
  eqNum(run.fired.e2, undefined, "没顺手点火 a → b（跳到指定的环就是只跳它）");
  eqNum(run.nodes.b.status, "pending", "没被点火的 b 留在 pending（随后由 ltSkipUnreachable 收成 skipped）");
  eqNum(run.fixes[0].target, "c", "痕迹里留下跳到哪一环");
  eqNum(run.nodes.a.skippedBy.length > 0, true, "放行痕迹非空");

  /* ⑥ 模式 err：判失败但照样点火下游（「这一环失败了我也不想卡在这儿」） */
  run = mk();
  await LT.applySkip(run, "a", { mode: "err", by: "user" });
  eqNum(run.nodes.a.status, "failed", "err 档：这一环仍是 failed（没假装成功）");
  eqNum(run.fired.e2, 1, "err 档照样点火下游（不再挂在这儿等人）");
  eqNum(run.fixes[0].mode, "err", "痕迹里写明是「判失败并继续」");

  /* ⑦ 自动放行闸：图定义里勾了才放行，没勾就原样停住 */
  run = mk();
  const nodeRaw = nodeOf("a");
  nodeRaw.cfg.onError = "skip";
  nodeRaw.cfg.onErrorNext = "c";
  const R2 = LT.norm({ nodes: G.nodes, edges: [{ id: "e1", from: "s", to: "a" }, { id: "e5", from: "a", to: "c" }] });
  run.graph = R2;
  run.inst = { "": R2 };
  run.nodes.c = { status: "pending", rounds: [], tries: 0, err: "", since: 0 };
  const rf = await LT.resolveErrorFinal(run, "a", { id: "a", kind: "agent", title: "a_check", cfg: { onError: "skip", onErrorNext: "c" } }, "429 限流");
  ok(rf && rf.skipped === true, "勾了「无视报错」→ 报错时就地放行（返回 skipped 回执）");
  eqNum(run.nodes.a.status, "skipped", "自动放行的这一环也记为 skipped");
  eqNum(run.fired.e5, 1, "自动放行按 onErrorNext 点火到指定那一环");
  eqNum(run.fixes[0].by, "auto", "痕迹里写明是图定义自动放行");
  run = mk();
  const rf2 = await LT.resolveErrorFinal(run, "a", { id: "a", kind: "agent", title: "a_check", cfg: {} }, "429 限流");
  eqNum(rf2, false, "没勾「无视报错」→ 原样停住（绝不静默吞错）");
  eqNum(run.nodes.a.status, "failed", "停住时这一环是 failed");
  eqNum(run.nodes.b.status, "pending", "停住时下游不动（这就是原来的「卡死」现场）");

  /* ⑧ 条件谓词写法兼容（本次需求：「route · blocked — state is not defined」）────────
   * fork（选路）的出边 cond 是受限 JS，真正执行它的是 fn-runtime（`new AsyncFunction(
   * "input", "mtnode", code)`）；策略层注入的是 input = { state, node, runId }。
   * 实测现场（用户那条「高考专业决策」v2 图，fork 节点 id 就是 route）两条出边写的是
   *   e6: state.pool_ok === false ? true : true
   *   e7: state.pool_ok === false
   * —— 裸名（没有 input.）**且**是表达式（没有 return）。前者只有 input 在作用域里 →
   * ReferenceError「state is not defined」把 route 判成 blocked；后者算完了没有值 →
   * 边既不点火也不报错、下游被静默跳过。这里把 sandbox 的 mtnodeJsExec 换成**真
   * fn-runtime**，两条都钉住，并确认真错的谓词照旧判失败且错误文本点名怎么写。 */
  console.log("\n[1b] 条件谓词：裸 state / node / runId 与表达式直写都认（真跑 fn-runtime）");
  const fnRuntime = require("../fn-runtime.js");
  let condRuns = [];
  sandbox.window.mtnodeJsExec = {
    run: async (code, input) => {
      condRuns.push(String(code));
      return await fnRuntime.runUserFunction({ code: code, input: input }, {});
    },
  };
  /* 一张最小运行现场：根图里一个 fork 环节（id 就叫 route），共享状态里放着 decided / note / pool_ok */
  const condRun = {
    runId: "r-cond",
    status: "running",
    ns: { "": { decided: 1, note: "noir", pool_ok: false } },
    nodes: {},
    fired: {},
    inst: { "": { nodes: [{ id: "route", kind: "fork", title: "route", cfg: {} }], edges: [] } },
  };
  const evalCond = async (src) => {
    Object.assign(sandbox, { __rc: condRun });
    return await vm.runInContext("ltCondEval(__rc, 'route', " + JSON.stringify(src) + ")", sandbox);
  };
  const c1 = await evalCond("return state.decided === 1");
  ok(c1.ok === true && c1.pass === true, "裸 state.decided 能求值（不再「state is not defined」把选路卡成 blocked）");
  eqNum(condRuns.length, 2, "裸名兼容只多跑一次（第一次 ReferenceError，第二次带上绑定）");
  condRuns = [];
  const c2 = await evalCond('return input.state.note === "noir"');
  ok(c2.ok === true && c2.pass === true, "input.state.<键> 照旧能求值（原写法不回退）");
  eqNum(condRuns.length, 1, "一次就能算出来时绝不重跑");
  condRuns = [];
  const c3 = await evalCond("state.pool_ok === false");
  ok(c3.ok === true && c3.pass === true, "实测现场 e7：裸名 + 表达式直写（state.pool_ok === false）当场算得出真值");
  eqNum(condRuns.length, 3, "两条兼容各补一跑（原样 → 带绑定 → 带绑定并按表达式求值）");
  condRuns = [];
  const c4 = await evalCond("input.state.pool_ok === false");
  ok(c4.ok === true && c4.pass === true, "表达式直写不带 return 也认（`input.state.x === y` 这种一行写法）");
  eqNum(condRuns.length, 2, "表达式兼容只补一跑（不重复扣裸名那次）");
  condRuns = [];
  const c5 = await evalCond("input.state.pool_ok !== false");
  ok(c5.ok === true && c5.pass === false, "表达式的假值同样是「不放行」（不因为兼容而一律点火）");
  condRuns = [];
  const c6 = await evalCond('return "note" in state && node.kind === "fork" && !!runId');
  ok(c6.ok === true && c6.pass === true, "裸 node / runId 与 state 同一条兼容路径（三个绑定一次给全）");
  const c7 = await evalCond("return (input) => input.state.decided === 1");
  ok(c7.ok === true && c7.pass === true, "谓词写成箭头函数（fn-runtime 用 input 再调一次）不受影响");
  condRuns = [];
  const c8 = await evalCond("return othing.here === 1");
  ok(c8.ok === false, "真写错的谓词照旧判失败（绝不在判据不明时静默选路）");
  eqNum(condRuns.length, 1, "错名既不在绑定名单里、也不是表达式 → 一次就停（不浪费执行）");
  ok(/othing is not defined/.test(c8.err), "错误文本仍带原始 ReferenceError（不掩盖真相）");
  has(c8.err, "input.state.<键>", "错误文本点名怎么写共享状态（用户 / Agent 不必去猜）");
  /* 真跑一次「选路」：fork 的两条出边照 v2 现场那么写 → 该走的那条点火、fork 不 blocked */
  const forkRun = {
    runId: "r-fork",
    status: "running",
    ns: { "": { pool_ok: false } },
    nodes: { route: { status: "running", rounds: [], tries: 0, err: "", since: 0 } },
    fired: {},
    log: [],
    inst: {
      "": {
        nodes: [
          { id: "route", kind: "fork", title: "route", cfg: {} },
          { id: "research", kind: "agent", title: "深度调研", cfg: {} },
          { id: "giveup", kind: "end_fail", title: "暂无可推荐方向", cfg: {} },
        ],
        edges: [
          { id: "e6", from: "route", to: "research", label: "", cond: "state.pool_ok !== false" },
          { id: "e7", from: "route", to: "giveup", label: "", cond: "state.pool_ok === false" },
        ],
      },
    },
  };
  await vm.runInContext("ltFireOut(__rf, 'route')", Object.assign(sandbox, { __rf: forkRun }));
  eqNum(forkRun.fired.e7, 1, "真跑选路：裸名 + 表达式写的分支边照样点火（旧版这里把 route 判成 blocked）");
  eqNum(forkRun.fired.e6, undefined, "条件不成立的那条不点火（兼容不等于全放行）");
  ok(forkRun.nodes.route.status !== "blocked", "fork 环节没被误判成 blocked（「route · blocked」不再出现）");
  eqNum(forkRun.nodes.giveup.status, "pending", "被点火的目标进 pending，等着跑");
  ok(forkRun.nodes.research === undefined, "没点火的目标不建槽（下游别被凭空拉起来）");

  console.log("\n[2] 卡死解除：放行过的环节不被复活 / 不再算回 blocked");
  /* ltRearmSkipped：旧版救援不许把用户明确放行过的环节排回 pending */
  run = mk();
  run.nodes.a.status = "skipped";
  run.nodes.a.skippedBy = "无视报错，跳过这一环";
  run.nodes.b.status = "skipped";
  eqNum(LT.rearmSkipped(run), 1, "救援只复活「不是用户放行」的那一个 skipped");
  eqNum(run.nodes.a.status, "skipped", "用户放行过的环节仍是 skipped（他的决定不被静默撤回）");
  eqNum(run.nodes.b.status, "pending", "旧版误标的 skipped 照旧被排回 pending");

  /* ltSettleRunStatus：放行后 run 不再停在 blocked */
  run = mk();
  run.nodes.a.status = "skipped";
  run.nodes.a.skippedBy = "无视报错";
  run.nodes.b.status = "done";
  run.nodes.c.status = "done";
  run.nodes.e.status = "done";
  run.status = "blocked";
  LT.settleRunStatus(run);
  ok(run.status === "done", "已放行 + 走到成功终点 → run 收成 done（真的能往下跑到底，不再 blocked）");
  /* 放行的那一环**内部**的子槽也不该把它顶回 blocked（子图 / 逐项里的失败随所属环节一起作废） */
  run = mk();
  run.nodes.a.status = "skipped";
  run.nodes.a.skippedBy = "无视报错";
  run.nodes["a/x"] = { status: "failed", rounds: [], tries: 0, err: "内部炸了", since: 0 };
  run.nodes.b.status = "done";
  run.nodes.c.status = "done";
  run.nodes.e.status = "done";
  run.status = "blocked";
  LT.settleRunStatus(run);
  ok(run.status !== "blocked", "放行环节**内部**的失败子槽不再把 run 顶回 blocked（点了放行就是真的往下走）");
}

/* ═══════════ [2b] 强行进入下一状态（本次需求 · 引擎真行为）═══════════ */
async function forcePart() {
  console.log("\n[2b] 引擎：「⏭ 强行进入下一状态」（run 级推进 · vm 里真跑 LT.forceAdvance）");
  const sandbox = {
    window: { api: {}, mtnodeJsExec: { run: async () => ({ ok: true, value: true }) } },
    S: { wf: null, config: {} },
    I18n: { t: (s) => s },
    toast() {},
    scheduleSave() {},
    persistWf() {},
    currentVisibleWf() {
      return null;
    },
    renderCanvas() {},
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
  const LT2 = sandbox.window.LT;
  for (const k of ["forceAdvance", "autoRepairGraph", "forcedNode"]) ok(typeof LT2[k] === "function", "window.LT 导出 " + k);

  const G = LT2.norm({
    nodes: [
      { id: "s", kind: "start", title: "起点" },
      { id: "a", kind: "agent", title: "a_check", cfg: { goal: "核对", outKeys: ["ok"] } },
      { id: "b", kind: "agent", title: "起草", cfg: { goal: "起草", outKeys: ["draft"] } },
      { id: "e", kind: "end_ok", title: "收工" },
    ],
    edges: [
      { id: "e1", from: "s", to: "a" },
      { id: "e2", from: "a", to: "b" },
      { id: "e3", from: "b", to: "e" },
    ],
  });
  const mk2 = () => {
    const run = {
      runId: "r-force",
      wfId: "wf1",
      aborted: false,
      booted: true,
      status: "blocked",
      graph: G,
      inst: { "": G },
      fired: { e1: 1 },
      nodes: {},
      ns: {},
      waits: [],
      fixes: [],
      rounds: {},
      opts: {},
      log: [],
    };
    for (const n of G.nodes) run.nodes[n.id] = { status: n.id === "s" ? "done" : "pending", rounds: [], tries: 0, err: "", since: 0 };
    return run;
  };

  /* ① 判据：只有「被停止 / 中断按下来」的 blocked 才算「排回队列」，别的都按报错放行 */
  eqNum(LT2.forcedNode({ status: "blocked", err: "已手动停止" }), true, "「已手动停止」按下来的一环 → 排回队列（不是跳过）");
  eqNum(LT2.forcedNode({ status: "blocked", err: "已中断（应用重启或任务停止）" }), true, "「已中断」同样排回队列");
  eqNum(LT2.forcedNode({ status: "blocked", err: "429 限流" }), false, "真报错的环节 → 走放行（不同档）");
  eqNum(LT2.forcedNode({ status: "blocked", err: "Stopped manually" }), true, "英文界面留下的停止文案也认（用户中途切过语言）");

  /* ② 没有要推进的东西：如实回执，绝不假装推进过 */
  let run = mk2();
  run.status = "waiting";
  const r0 = await LT2.forceAdvance(null, { run: run });
  eqNum(r0.ok, false, "这一轮没有卡住的环节、也没在终局 → 回执 ok:false（不是「点了没反应」）");
  has(r0.error, "没有卡住", "回执写明为什么推不动");

  /* ③ 真现场：一个被停止的 blocked（排回队列）+ 一个报错的 failed（放行）+ 一个 failed 下游 */
  run = mk2();
  run.nodes.a.status = "blocked";
  run.nodes.a.err = "已手动停止";
  run.nodes.b.status = "failed";
  run.nodes.b.err = "429 限流";
  run.nodes.e.status = "failed";
  run.nodes.e.err = "上游失败";
  run.waits.push({ id: "w1", path: "b", kind: "approve", title: "起草" });
  const rf = await LT2.forceAdvance(null, { run: run });
  eqNum(rf.ok, true, "强行推进成功（回执 ok:true）");
  /* 排回队列的那一环会被 ltPump 当场接走（状态机真的动了），所以终态是 pending 或已经在跑 ——
     两者都算「不卡在 blocked 上」；下面单独用一根最小现场钉住「恢复的是 pending」。 */
  ok(["pending", "running", "blocked"].indexOf(run.nodes.a.status) >= 0 && run.nodes.a.status !== "blocked", "被「停止」按下来的一环不再卡在 blocked（接着跑，不跳过）");
  eqNum(run.nodes.a.err, "", "排回队列时把「已手动停止」的说明清掉");
  ok(run.nodes.a.err !== "已手动停止", "「已手动停止」这句不再是它的状态说明（它已经重新排队了）");
  eqNum(rf.requeued, 1, "回执里 requeued = 1");
  ok(rf.details.some((d) => d.path === "a" && d.mode === "requeue"), "回执明细里写明 a 是「排回队列」而不是「放行」");
  eqNum(run.nodes.b.status, "skipped", "真报错的一环按「放行」记为 skipped（与单环节卡片同一个实现）");
  ok(!!run.nodes.b.skippedBy && run.nodes.b.skippedBy.length > 0, "放行留下痕迹（卡片上看得出已放行）");
  eqNum(rf.released >= 2, true, "放行的环节带上它下游那颗也一并放过（一次推进不止一格）");
  eqNum(run.waits.some((w) => w.path === "b"), false, "放行的那一环等人的登记一并撤掉");
  ok(run.fixes.some((f) => f.mode === "force" && f.by === "user"), "run.fixes 记了一条 by:user 的强行推进（留痕）");
  eqNum(run.aborted, false, "解开 aborted（手势 = 明确的「接着跑」）");
  ok(run.status === "running" || run.status === "blocked", "终局 / blocked 被解开，交回状态机收敛");
  /* 主循环是「叫一声就跑」的异步循环：它可能已经把这一环接走了（状态在 running），
     所以这里钉的是「不再是 blocked」+「明细里写明是排回队列」——
     真正的 pending 语义用下面那根最小现场钉（那根不让主循环抢跑）。 */
  ok(run.nodes.a.status !== "blocked", "排回队列的那一环不再卡着（状态机接着动，不是只改个颜色）");
  eqNum(run.log.some((l) => String(l.text).indexOf("强行进入下一状态") >= 0), true, "运行档案里留下这次强行推进的记录");

  /* ④ 只有被停止的一环（没有报错）：照样能推（这是最常见的那一次） */
  run = mk2();
  run.nodes.a.status = "blocked";
  run.nodes.a.err = "已手动停止";
  const expired = Promise.resolve(LT2.forceAdvance(null, { run: run }));
  eqNum(run.nodes.a.status, "pending", "排回队列的那一环**当场**回到 pending（「接着跑」的语义，不是跳过）");
  ok(LT2.allReady(run).indexOf("a") >= 0, "回到 pending 的那一刻它就是 ready（主循环抓得到）");
  const decided = await expired;
  eqNum(decided.ok, true, "只有「被停止」的一环时也能推进");
  eqNum(decided.released, 0, "没有任何环节被当成「报错放行」（停止 ≠ 报错）");
  eqNum(decided.requeued, 1, "只有排回队列那一个");

  /* ⑤ 结论性的图问题就地补好（「本不该出现的 state 错误」闸） */
  const bad1 = { nodes: [{ id: "a", kind: "agent", title: "起草", cfg: { goal: "写" } }], edges: [] };
  const fix1 = LT2.autoRepairGraph(bad1);
  ok(fix1.fixes.length > 0, "缺起点 / 缺终点的图 → 报出补了什么");
  const left1 = LT2.validate(bad1).filter((x) => x.level === "err");
  eqNum(left1.length, 0, "补完之后图校验真的通过（ltValidate 的判据一个字没改，是图被补好了）");
  ok(bad1.nodes.some((n) => n.kind === "start"), "补出了 start 节点");
  ok(bad1.nodes.some((n) => n.kind === "end_ok"), "补出了 end_ok 节点");
  ok(bad1.edges.length >= 2, "并接好了 start → 环节 → 终点 的边");
  const bad2 = { nodes: [{ id: "s", kind: "start", title: "起点" }, { id: "a", kind: "agent", title: "起草", cfg: { goal: "写" } }], edges: [{ id: "e1", from: "s", to: "a" }] };
  const fix2 = LT2.autoRepairGraph(bad2);
  ok(fix2.fixes.length > 0, "只缺终点的图 → 报出补了终点");
  ok(bad2.edges.some((e) => e.to === "end" || /^end/.test(String(e.to))), "叶子环节接到了新终点上");
  const fix3 = LT2.autoRepairGraph({ nodes: [], edges: [] });
  eqNum(fix3.fixes.length, 0, "空图：一个节点都没有 → 不硬补（没什么可接的）");
  ok(!!fix3.note, "空图如实说明为什么补不动");
}

/* ═══════════ [3] 界面 / 样式 / 词条 / 手册 ═══════════ */
function uiPart() {
  console.log("\n[3] 界面：出路控件的唯一落点 + 样式 + 中英词条 + 手册");
  has(LTU, "function ltErrEscapeBox(", "卡片与检查器共用的出路控件已就位");
  has(LTU, "ltErrEscapeBox(card, ltTaskOf(wf, run.taskId), run, path,", "卡住的环节卡片摆出出路控件");
  has(LTU, "ltErrEscapeBox(box, task, run, path,", "环节检查器也摆出同一只控件（选中卡住的那一环时）");
  has(LTU, 'API.manualResolve(wf, path, { mode: mode, target: tgt', "当场放行的唯一落点是引擎的 LT.manualResolve");
  hasnt(LTU, "run.fix(", "界面里没有第二套「直接改 run」的放行实现（判据只在引擎里有一份）");
  has(LTU, "长任务引擎未就绪：先点「继续」再试", "引擎不在时明确报错（不静默什么都不发生）");
  has(LTU, "以后这一环报错都照此放行（写回图定义）", "勾选即写回图定义（下次报错自动放行）");
  has(LTU, '"lt-errbox"', "出路控件有自己的样式类");
  has(LTU, 'ltT("无视这次报错，接着往下跑")', "出路控件有统一的标题文案");
  /* 条件谓词写法兼容（本次需求）：提示行点名怎么写共享状态，引擎侧有唯一的绑定名单 */
  has(LTU, "也可直接写 state.<键>", "条件编辑框的提示写明裸 state 也认（写法不再靠猜）");
  has(LTV, "LT_COND_BINDINGS", "引擎里有条件谓词的绑定名单（裸名兼容的唯一真源）");
  has(LTV, "ltCondBareNameErr", "只对「这三个绑定的 is-not-defined」重跑（别的错照旧判失败）");
  has(LTU, "lt-card-skipped", "已放行的那张卡片有独立外观（与还卡着的区分）");
  has(LTU, "st.skippedBy", "卡片上显示「已放行」的原因");
  /* 卡住的环节列表：把已放行的也列出来（放行只免阻拦，不抹掉出过错这件事） */
  has(LTU, 's !== "skipped"', "右栏「卡住的环节」也列已放行的那一环");
  has(LTV, "manualResolve: ltManualResolve,", "引擎把 manualResolve 挂到 window.LT");
  /* 本次需求：「强行进入下一状态」的 run 级入口（条带头那颗 ⏭ 的落点） */
  has(LTU, "function ltForceAdvanceBtn(", "条带头有「⏭ 强行进入下一状态」按钮的构造器");
  has(LTU, 'ltT("⏭ 强行进入下一状态")', "按钮文案就是「⏭ 强行进入下一状态」");
  has(LTU, "ltForceAdvanceBtn(wf, run)", "条带头真的把它摆出来（run 停在手上时）");
  has(LTU, 'run.status === "running" || run.status === "done"', "可见口径与「▶ 继续」同档：跑着 / 跑完不出现，卡住 / 失败 / 停住 / 已停止都出现");
  has(LTU, 'title: ltT("强行进入下一状态")', "点了先弹一次确认窗（说清会发生什么）");
  has(LTU, 'ltT("强行推进")', "确认键写「强行推进」而不是含糊的「确定」");
  has(LTU, 'API.forceAdvance(wf, { run: run })', "施加动作的唯一落点是引擎的 LT.forceAdvance（界面不自己改 run）");
  has(LTU, "ltArr(r.errs).length", "放行中途出错的环节如实报出来（不静默吞掉）");
  has(LTU, "这一轮没有卡住的环节：已按「继续」恢复现场", "没有可推的环节时自动按「继续」恢复现场（绝不点了没反应）");
  hasnt(LTU, "run.fix(", "界面里没有第二套「直接改 run」的推进实现（判据只在引擎里有一份）");
  has(LTCSS, ".lt-btn-force {", "强行推进按钮的样式进 longtask.css（与「▶ 继续」区分开）");
  has(LTCSS, ".lt-btn-force:hover", "悬停态齐备（同 :hover / [data-hover] 两路口径）");

  console.log("\n[3b] i18n：新词条中英成对（切英文不出现中文半截）");
  has(LTV, "applySkip: ltApplySkip,", "引擎把 applySkip（真实施加动作）挂出来供回归直接用");
  has(LTV, "errorSkipOn: ltErrorSkipOn,", "引擎把 errorSkipOn（图定义判据）挂出来");
  has(LTV, "errorNextTarget: ltErrorNextTarget,", "引擎把 errorNextTarget（目标解析）挂出来");
  has(LTV, "settleRunStatus: ltSettleRunStatus,", "引擎把 settleRunStatus 挂出来（回归直接验终局判据）");
  has(LTV, "fixes: [],", "run 上预留 fixes（干预痕迹随 checkpoint 结构明确）");
  has(LTV, "skippedBy: String(st.skippedBy || \"\"),", "现况快照 nodes[] 带 skippedBy（AI 改图时看得出哪一环是被放过去的）");
  has(LTV, "fixes: ltArr(mine.fixes).slice(-20)", "现况快照 run 带 fixes（放行痕迹可被 AI 读到）");

  has(LTCSS, ".lt-errbox {", "出路控件样式进 longtask.css");
  has(LTCSS, ".lt-errbox-cb", "复选框样式齐备（accent-color 标红）");
  has(LTCSS, ".lt-card-skipped", "已放行卡片的样式齐备");

  console.log("\n[3b] i18n：新词条中英成对（切英文不出现中文半截）");
  const keys = [
    "无视这次报错，接着往下跑",
    "跳到哪一环",
    "（不填 = 走它自己的下游）",
    "留空 = 走它自己的下游",
    "图里没有别的环节可跳",
    "只列同一张图里的环节；留空 = 走它自己的下游",
    "以后这一环报错都照此放行（写回图定义）",
    "无视报错并继续",
    "判失败也继续",
    "无视报错：判失败并继续",
    "长任务引擎未就绪：先点「继续」再试",
    "这一环当前没有报错，放行不了",
    "已放行：",
    "图定义自动放行",
    "无视报错，跳过这一环",
    "无视报错，判失败但继续",
    "无视报错",
    "按图定义无视报错，继续往下走",
    "（下一环：",
    "（走它自己的下游）",
    "已按图定义无视报错：",
    "无视报错：跳过这一环",
    "无视报错：判失败并继续往下跑",
    "这一环记为「已跳过」：它留下的东西下游照旧读得到，缺的东西下游自己会说。",
    "这一环照旧记为失败，但不再拦住流程：下游照常点火，缺的东西由下游自己说（判失败 ≠ 跳过）。",
    "这一环记为失败，但照常点火下游（不再挂在这儿等人）",
    "要跳去的那一环得是图里另一个环节",
    "没有这一环",
    "这一环当前没有报错",
    "这一环当前没有报错，放行不了",
    "找不到该环节的图定义（图已改版？）",
    /* 本次需求：「⏭ 强行进入下一状态」（run 级推进）与结论性图问题的就地补好 */
    "⏭ 强行进入下一状态",
    "强行进入下一状态",
    "强行推进",
    "把卡住的环节放行、把被停止的环节排回队列，让状态机按图继续往下走（下一次先试「▶ 继续」）",
    "强行进入下一状态：把卡住的环节按「放行」处理（记为已跳过、照常点火下游，不假装它做成了）",
    "被「停止」按下来的环节重新排回队列接着跑；正在等你确认的环节不动。确定继续？",
    "这一轮没有卡住的环节：已按「继续」恢复现场",
    "这一轮已经跑完了，没有要推进的状态",
    "这一轮没有卡住的环节，也没有可推进的状态",
    "没有启用中的长任务",
    "已强行推进：放行 ",
    " 个环节、",
    " 个环节重新排队",
    "强行推进失败",
    "放行失败",
    "用户手动强行进入下一状态",
    "强行进入下一状态：放行 ",
    " 个卡住的环节、",
    " 个被停止的环节重新排队",
    "整个任务",
    "补了一个起点（原来没有 start：任务根本没法开跑）",
    "补了一个成功终点（原来没有 end_ok：跑完无处可去）",
    "补了一个成功终点（原来只有失败终点：成功那条路无处可去）",
    "图里缺的那一头已就地补好：",
    "还有这些要你自己改：",
    "图定义不可用",
    "图是空的：先加一个 Agent 任务或人工任务",
  ];
  const I = require("../renderer/i18n.js");
  I.setLocale("en");
  const miss = keys.filter((k) => I.t(k) === k);
  eqNum(miss.length, 0, "i18n 中英词条齐备" + (miss.length ? "（缺：" + miss.join(" / ") + "）" : ""));
  I.setLocale("zh");
  for (const k of keys) has(I18N, '"' + k + '"', "i18n 源文件里有「" + k + "」的词条");

  console.log("\n[3c] 手册：这条出路写进 longtask.md（用户看得到、找得到）");
  has(MANUAL, "### 某一环报错了？可以直接无视它往下走", "手册里有「报错了可以直接无视它往下走」这一节");
  has(MANUAL, "无视这次报错并继续", "手册里有「无视这次报错并继续」这条出路");
  has(MANUAL, "跳到哪一环", "手册写明可以指定跳到哪一环");
  has(MANUAL, "判失败也继续", "手册写明第二档出路（判失败也继续）");
  has(MANUAL, "写回**图定义**", "手册写明勾选即写回图定义（以后自动放行）");
  has(MANUAL, "跳过 ≠ 成功", "手册写明「跳过 ≠ 成功」（不假装这一环做成了）");
}

(async () => {
  await enginePart();
  await forcePart();
  uiPart();
  console.log("\n" + (fails ? "FAILED " + fails + " / " + checks + " checks" : "ALL OK  " + checks + " checks") + "  (smoke-longtask-error-exit)");
  process.exit(fails ? 1 : 0);
})();