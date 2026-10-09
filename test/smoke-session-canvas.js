"use strict";
/* 会话「所属画布」回归冒烟测试 —— 纯 Node，不启动 Electron
 *   node test/smoke-session-canvas.js
 *
 * 保住的行为（本轮需求：允许会话访问非当前画布）：
 *   会话归属真源只有一个 —— 会话在**建立那一刻**绑下的 canvasWfId（用户当时看到的画布；
 *   开发 / 细化 / 问询 / 函数·工具开发 / 建议这类节点绑定会话 = 该节点所在的画布）。
 *   此后每一轮：画布读写、应用级 op、工作区、数据库接地、工具快照全按所属画布解析。
 *   用户在会话运行中途切去别的画布干活是常态 —— 会话绝不能漂到他此刻看着的那张图上；
 *   所属画布被删除时宁可这一轮明确失败，也绝不静默改写前台画布。
 *
 * 覆盖：
 *   [1] 归属真源的建立 / 水合 / 落盘 / 载回归一（会话存档带上 canvasWfId）
 *   [2] 每个建会话点都绑定归属（节点绑定会话走 ownerWfOfNode，不现取 S.wf）
 *   [3] 开轮解析：boundWf 与工作区 / 工具快照 / 数据库接地 / beginCanvasRun 同源
 *   [4] 真行为（vm 沙箱跑渲染层真函数 + 假 window.api）：按 id 解析画布的优先顺序、
 *       已删明确失败不漂图、同步读法不读盘、显示名退化链、在飞绑定判据、老会话就地补绑
 *   [5] 画布 / 应用事件按本轮绑定画布路由（app op 也进画布上下文；前台视图动作拒绝）
 *   [6] 前台被切走时写回不丢（loadWorkflow 复用袋中对象 / edit 收尾按 editWf 落盘）
 *   [7] 范围口径与提示词：渲染层纪律 + gateway 机制描述 + i18n 中英成对
 *   [8] 会话 UI 显示所属画布（侧栏 ▣ / 工作目录悬浮 / 开发绑定会话不加噪声）
 *   [9] 手册中英同口径 */
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os"), childProcess = require("child_process");
const SHARED = { fs, path, vm, os, spawn: childProcess.spawn };
const TEST_DIR = __dirname;
let MERGED_FAILED = false;

const I18n = require(path.join(__dirname, "..", "renderer", "i18n.js"));

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
const section = (t) => console.log("\n[" + t + "]");
/* 读源码并统一换行（Windows 工作区常见 CRLF，锚点串按 \n 写） */
const read = (rel) =>
  fs
    .readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8")
    .replace(/\r\n?/g, "\n");
const has = (hay, needle, msg) => ok(hay.indexOf(needle) >= 0, msg);
const hasnt = (hay, re, msg) =>
  ok(!(typeof re === "string" ? hay.indexOf(re) >= 0 : re.test(hay)), msg);
const noop = () => {};

const APP = read("renderer/app.js");
const NODES = read("renderer/app-nodes.js");
const DB = read("renderer/app-db.js");
const ASSIST = read("renderer/app-assist.js");
const AGENT = read("renderer/app-agent.js");
const PLAN = read("renderer/app-plan.js");
const TOOLS = read("renderer/app-tools.js");
const DEVNODE = read("renderer/app-devnode.js");
const BOOT = read("renderer/app-boot.js");
const CSS_DSH = read("renderer/css/dsh.css");
const CSS_LIGHT = read("renderer/css/theme-light.css");
const PLUGIN = read("dsh/gateway/canvas-plugin.mjs");
const PRELOAD = read("preload.js");

/* ── 从源码里抠出整个函数体（跳过字符串 / 注释做括号配对）──
 *   目的：断言「就在这一条路径里」，而不是全文 grep 到就算数。 */
function sliceBraces(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      i = src.indexOf("\n", i);
      continue;
    }
    if (c === "/" && n === "*") {
      i = src.indexOf("*/", i) + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") i++;
        else if (src[i] === q) break;
        i++;
      }
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  throw new Error("括号未配平（锚点附近代码改动过大？）");
}
function grabFunction(src, name) {
  const re = new RegExp("^(?:async\\s+)?function\\s+" + name + "\\s*\\(", "m");
  const m = re.exec(src);
  if (!m) throw new Error("源码里找不到函数：" + name);
  const open = src.indexOf("{", src.indexOf(")", m.index));
  return src.slice(m.index, open + sliceBraces(src, open).length);
}
/* 断言友好版：找不到就记一条失败并返回空串，不让整个测试崩在半路 */
function bodyOf(src, name, where) {
  try {
    return grabFunction(src, name);
  } catch (e) {
    ok(false, (where || "") + " 应定义函数 " + name + "（" + e.message + "）");
    return "";
  }
}

/* ══════════════════════ [1] 归属真源：建立 / 水合 / 落盘 / 载回 ══════════════════════ */
function part1() {
  section("1 归属真源 canvasWfId 的建立与持久化");
  const cwv = bodyOf(ASSIST, "currentVisibleWfId", "app-assist.js");
  const cfn = bodyOf(ASSIST, "canvasWfIdForNode", "app-assist.js");
  has(cwv, "currentVisibleWf()", "currentVisibleWfId() 取「前台画布」真源，不是裸 S.wf");
  has(cfn, "ownerWfOfNode(node)", "canvasWfIdForNode() 按「节点所属画布」绑定");
  has(cfn, "return currentVisibleWfId();", "节点归属解析不到才退回前台画布（绝不留空）");

  const sess = bodyOf(ASSIST, "agentSessions", "app-assist.js");
  has(sess, 'typeof s.canvasWfId !== "string"', "会话列表水合：历史存档缺 canvasWfId → 规范成空串");
  has(sess, 's.canvasWfId = "";', "未绑定用空串表示（开轮补绑一次），不瞎猜一张图");

  has(bodyOf(ASSIST, "agentSessionState", "app-assist.js"), "canvasWfId: currentVisibleWfId()", "兜底新建会话按用户此刻看到的画布绑定");
  has(bodyOf(ASSIST, "newAgentSession", "app-assist.js"), "canvasWfId: currentVisibleWfId()", "手动「新会话」同样绑定此刻的画布");
  /* 落盘白名单本体（会话拆到 agent-sessions/ 后叫 agentSessionMetaForDisk）：
     字段名与「谁落盘」变了，但要件不变 —— canvasWfId 必须在落盘对象里 */
  has(
    bodyOf(ASSIST, "agentSessionMetaForDisk", "app-assist.js"),
    'canvasWfId: s.canvasWfId || "",',
    "归属随会话落盘（重启后仍归它自己那张图）",
  );

  ok(/canvasWfId:\s*""/.test(BOOT), "app-boot.js 载回归一的默认字段表带 canvasWfId（漏了 = 重启丢归属）");
  has(BOOT, 'typeof sess.canvasWfId === "string" ? sess.canvasWfId : ""', "载回时字符串原样保留，非字符串才清空");
}

/* ══════════════════════ [2] 每个建会话点都绑定归属 ══════════════════════ */
function part2() {
  section("2 建会话点绑定齐全（节点绑定会话按节点所属画布）");
  for (const [src, fn, rel] of [
    [APP, "createDevSessionForNode", "app.js"],
    [APP, "startDevAskSession", "app.js"],
    [APP, "ensureAgentSessionForNode", "app.js"],
    [TOOLS, "createFnDevSessionForNode", "app-tools.js"],
    [TOOLS, "createToolDevSessionForNode", "app-tools.js"],
    [DEVNODE, "devSuggestRecordSessionOf", "app-devnode.js"],
  ]) {
    const b = bodyOf(src, fn, rel);
    has(b, "canvasWfId: canvasWfIdForNode(node)", rel + " :: " + fn + " → 绑「节点所属画布」");
    hasnt(b, /canvasWfId:[^\n]*S\.wf/, rel + " :: " + fn + " → 不现取 S.wf（后台换画布上下文里它不是归属）");
  }
  has(bodyOf(APP, "createWfBuildSession", "app.js"), "canvasWfId: currentVisibleWfId()", "「让助手搭工作流」的构建会话绑定发起时的画布");
  has(bodyOf(APP, "forkAgentSession", "app.js"), "canvasWfId: src.canvasWfId || currentVisibleWfId()", "分支会话继承源会话的所属画布（源没绑才按前台补绑）");
  has(bodyOf(PLAN, "planDshRunOnce", "app-plan.js"), 'canvasWfId: String(opts.canvasWfId || "")', "planDshRunOnce 把所属画布透传给 dshRunTask");
  has(bodyOf(PLAN, "planRunParallel", "app-plan.js"), 'canvasWfId: st.canvasWfId || ""', "计划并行子任务继承 owner 会话的所属画布（不另起炉灶）");
  const owner = bodyOf(AGENT, "agentSessionOfRun", "app-agent.js");
  has(owner, 'key.indexOf("planpar:") === 0', "并行子任务按 runKey 反查 owner 会话（画布归属与 Token 台账同一口径）");
  /* 全仓兜底：不许再有「现取 S.wf 当归属」的写法 */
  hasnt(APP + TOOLS + DEVNODE + ASSIST, /canvasWfId:\s*(?:String\(\s*)?S\.wf/, "没有任何建会话点用 S.wf 现取归属（漂移根因）");
}

/* ══════════════════════ [3] 开轮解析与同源消费 ══════════════════════ */
function part3() {
  section("3 dshRunTask 按所属画布开轮（工作区 / 工具 / 数据库接地同源）");
  const res = bodyOf(DB, "dshResolveRunBoundWf", "app-db.js");
  has(res, "opts.canvasWfId", "显式传入的归属优先（并行子任务由 owner 会话交进来）");
  has(res, "agentSessionOfRun(opts)", "否则按 runKey / 节点反查归属会话");
  has(res, "await wfOfCanvasIdForRun(id)", "有归属 → 按 id 解析回画布对象（可能要读盘）");
  has(res, "sess.canvasWfId = String(cur.id)", "老会话没有归属 → 本轮就地补绑一次");
  has(res, "persistAgentSession()", "补绑后落盘，下一轮起就是稳定真源");

  const once = bodyOf(DB, "dshRunOnce", "app-db.js");
  has(once, "boundWf = await dshResolveRunBoundWf(opts)", "第一个 then 就把本轮绑定画布定下来");
  has(once, "dshWorkspaceOfWf(node, boundWf)", "工作区按绑定画布解析（不是 S.wf）");
  has(once, "agentDbGroundingNote(opts.node, boundWf)", "数据库接地按绑定画布");
  has(once, "agentUserToolsSnapshot(boundWf)", "用户工具快照按绑定画布（杜绝「看着 A、工具按 B」）");
  has(once, "beginCanvasRun(boundWf)", "运行栈绑的是所属画布");
  has(once, "endCanvasRun(boundWf)", "进出栈成对、且用同一个对象");
  has(once, "wf: boundWf,", "canvas / tool-run 帧的 runCtx 带上绑定画布（路由靠它，不看栈顶）");
  has(once, "handleDbToolEvent(msg.data || {}, opts.node, boundWf)", "db 帧同样按绑定画布找副本");
  hasnt(once, "agentUserToolsSnapshot(S.wf)", "工具快照不再现取 S.wf");
  hasnt(once, "agentDbGroundingNote(opts.node, S.wf)", "数据库接地不再现取 S.wf");
  hasnt(once, "beginCanvasRun(S.wf)", "绑定运行栈不再现取 S.wf");
  has(bodyOf(DB, "dshRunRetryable", "app-db.js"), "本会话所属画布已被删除", "「所属画布已删除」列入不可重发判据（不白烧 5×5s）");

  const ws = bodyOf(APP, "dshWorkspaceOfWf", "app.js");
  has(ws, "if (manual) return manual;", "手填工作目录仍最优先");
  has(ws, "if (!wf || wf === S.wf) return dshWorkspaceOf(node);", "绑定的就是前台画布 → 逐字走老路（零回归）");
  has(ws, "devProjectRootOf(wf)", "项目根按绑定画布解析");
  has(ws, "wf.workspace", "其次才是该画布的统一目录");
}

/* ══════════════════════ [4] 真行为：按 id 解析所属画布 ══════════════════════ */
const RUNTIME_FNS = [
  "wfBlacklist",
  "wfIsDeleted",
  "wfWriteBlocked",
  "deletedWfError",
  "reviveWf",
  "rememberWf",
  "beginCanvasRun",
  "endCanvasRun",
  "canvasTargetWf",
  "currentVisibleWf",
  "setForegroundWf",
  "wfInCanvasRun",
  "sessionWfDeletedError",
  "wfOfCanvasIdForRun",
  "canvasWfByIdLoaded",
  "wfNameOfId",
];
const wfOf = (id, name, nodes) => ({ id, name, nodes: nodes || [], wires: [], workspace: "" });
/* 把 app.js 里那组「画布归属 / 活性」真函数放进 vm 沙箱，window.api 换成假体：
   测的是行为（解析顺序、抛错、入袋、零读盘），不是源码字符串。 */
function makeSandbox(diskCanvases) {
  const loads = [];
  const ctx = {
    console, Date, JSON, Math, Promise, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set, WeakSet, setTimeout,
    I18n,
    toast: noop,
    renderAll: noop,
    /* 画布视图记忆（切 Tab 回原位）走的是 setForegroundWf 这一步交接：本测试测的是
       「前台真源 / 所属画布归属」，焦点与相机那份存取由 test/smoke-wf-view-memory.js
       用自己的沙箱真跑，这里按口径桩掉，不给两组用例互相绑死。 */
    rememberWfView: noop,
    applyWfView: noop,
    forgetWfView: noop,
    window: {
      api: {
        wfLoad: (id) => {
          loads.push(String(id));
          const hit = diskCanvases[String(id)];
          return Promise.resolve(hit ? { ok: true, data: hit } : { ok: false, error: "not found" });
        },
      },
    },
    S: {
      wf: null,
      _fgWf: null,
      wfBag: {},
      nodeWfId: {},
      canvasRunStack: [],
      canvasRunWf: null,
      _deletedWfIds: {},
      _deadWfObjs: new WeakSet(),
      dshWorkspaceFallback: "E:\\tmp\\default",
      config: { visitedWorkflows: [] },
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  const code = RUNTIME_FNS.map((n) => grabFunction(APP, n)).join("\n\n") + "\n({ " + RUNTIME_FNS.join(", ") + " })";
  const api = vm.runInContext(code, ctx, { filename: "renderer/app.js#session-canvas" });
  const missing = RUNTIME_FNS.filter((n) => typeof api[n] !== "function");
  if (missing.length) throw new Error("抠出的函数在沙箱里没定义：" + missing.join(", "));
  return { ctx, api, loads, S: ctx.S };
}

async function part4() {
  section("4 真行为（vm 沙箱 · 渲染层真函数 · 假 window.api）");
  /* 4a 前台画布就是所属画布 → 直接复用同一对象 */
  {
    const A = wfOf("sc_wfA", "画布A");
    const sb = makeSandbox({ sc_wfA: A });
    sb.api.setForegroundWf(A);
    const got = await sb.api.wfOfCanvasIdForRun("sc_wfA");
    ok(got === A, "所属画布 = 前台画布时复用同一对象（不重新读盘换对象）");
    ok(sb.loads.length === 0, "这一路完全没有读盘");
  }
  /* 4b 用户切走了：所属画布在内存袋里 → 用袋中对象，绝不给前台那张 */
  {
    const A = wfOf("sc_wfA", "画布A");
    const B = wfOf("sc_wfB", "画布B");
    const sb = makeSandbox({ sc_wfA: A });
    sb.api.setForegroundWf(B); // 用户此刻看着 B
    sb.S.wfBag.sc_wfA = A; // A 还在内存里
    const got = await sb.api.wfOfCanvasIdForRun("sc_wfA");
    ok(got === A, "用户切去 B 干活：本轮仍解析回会话所属的 A");
    ok(sb.loads.length === 0, "袋里有活对象就不读盘（换对象会让在飞改动丢在旧副本上）");
    ok(sb.api.canvasTargetWf() === B, "对照：老的栈顶口径确实会给出 B —— 所以必须显式绑定");
  }
  /* 4c 袋里也没有 → 读盘一份并 rememberWf 入袋 */
  {
    const A = wfOf("sc_wfA", "画布A");
    const sb = makeSandbox({ sc_wfA: A });
    sb.api.setForegroundWf(wfOf("sc_wfB", "画布B"));
    const got = await sb.api.wfOfCanvasIdForRun("sc_wfA");
    ok(!!got && got.id === "sc_wfA" && got.name === "画布A", "所属画布没加载 → 从磁盘读回它自己那份");
    ok(sb.loads.length === 1 && sb.loads[0] === "sc_wfA", "读盘只按归属 id 读，不读前台");
    ok(sb.S.wfBag.sc_wfA === got, "读回的对象入袋（后续 persistWf / ownerWfOfNode 才认它）");
  }
  /* 4d 所属画布已删除 → 明确失败，绝不漂到前台画布 */
  {
    const A = wfOf("sc_wfA", "画布A");
    const sb = makeSandbox({ sc_wfA: A });
    sb.api.setForegroundWf(wfOf("sc_wfB", "画布B"));
    sb.S.wfBag.sc_wfA = A;
    sb.S._deletedWfIds.sc_wfA = { at: Date.now(), name: "画布A" }; // 等价于删除收口后的黑名单登记
    let err = null;
    try {
      await sb.api.wfOfCanvasIdForRun("sc_wfA");
    } catch (e) {
      err = e;
    }
    ok(!!err, "所属画布已删除 → 抛错（这一轮明确失败）");
    ok(!!err && String(err.message).indexOf("已被删除") >= 0, "错误文案说清是「所属画布已被删除」：" + (err && err.message));
    ok(!!err && String(err.message).indexOf("画布A") >= 0, "错误文案带上那张图的名字，便于用户核对");
    ok(sb.loads.length === 0, "已删判据在读写盘之前：不会退成前台画布 B");
  }
  /* 4e 对象墓碑（同 id 重建后的旧引用）同样拦死 */
  {
    const A = wfOf("sc_wfA", "画布A");
    const sb = makeSandbox({});
    sb.api.setForegroundWf(wfOf("sc_wfB", "画布B"));
    sb.S._deadWfObjs.add(A);
    sb.S.wfBag.sc_wfA = A;
    let err = null;
    try {
      await sb.api.wfOfCanvasIdForRun("sc_wfA");
    } catch (e) {
      err = e;
    }
    ok(!!err && String(err.message).indexOf("已被删除") >= 0, "旧对象有墓碑 → 同样拒绝（不写进同 id 重建的新画布）");
  }
  /* 4f 读盘读不出来 = 归属没了 → 抛错而不是退回前台 */
  {
    const sb = makeSandbox({});
    sb.api.setForegroundWf(wfOf("sc_wfB", "画布B"));
    let err = null;
    try {
      await sb.api.wfOfCanvasIdForRun("sc_gone");
    } catch (e) {
      err = e;
    }
    ok(!!err, "所属画布在磁盘上也读不出来 → 抛错（绝不静默漂图）");
    ok(sb.loads.length === 1, "确实按归属 id 尝试过读盘一次");
  }
  /* 4g 已删的 id 即使磁盘上还有文件也不自动复活；应用侧真正重新打开（reviveWf）后才认 */
  {
    const A2 = wfOf("sc_wfA", "画布A", [{ id: "n1" }]);
    const sb = makeSandbox({ sc_wfA: A2 });
    sb.api.setForegroundWf(wfOf("sc_wfB", "画布B"));
    sb.S._deletedWfIds.sc_wfA = { at: Date.now(), name: "画布A" };
    let err = null;
    try {
      await sb.api.wfOfCanvasIdForRun("sc_wfA");
    } catch (e) {
      err = e;
    }
    ok(!!err, "id 在黑名单里 → 直接拒绝（哪怕磁盘上还有一个同 id 文件，也不自动当「重建」放行）");
    ok(sb.loads.length === 0, "这一路连盘都没读（复活写回的门彻底关死）");
    sb.api.reviveWf("sc_wfA"); // 用户新建 / 打开 / 从回收站搬回 = 应用自己的解禁入口
    const got = await sb.api.wfOfCanvasIdForRun("sc_wfA");
    ok(!!got && (got.nodes || []).length === 1, "合法解禁后按 id 从磁盘读回那张图");
    ok(sb.loads.length === 1 && sb.S.wfBag.sc_wfA === got, "读回即入袋：后续 persistWf / ownerWfOfNode 都认它");
  }
  /* 4h 同步读法 + 显示名退化链（工作区与侧栏这类不能等 IO 的入口用） */
  {
    const A = wfOf("sc_wfA", "画布A");
    const sb = makeSandbox({ sc_wfA: A });
    sb.api.setForegroundWf(wfOf("sc_wfB", "画布B"));
    ok(sb.api.canvasWfByIdLoaded("sc_wfA") === null, "同步读法拿不到未加载的画布（宁缺勿读盘）");
    ok(sb.loads.length === 0, "canvasWfByIdLoaded 完全不触发 wfLoad");
    sb.S.wfBag.sc_wfA = A;
    ok(sb.api.canvasWfByIdLoaded("sc_wfA") === A, "袋里有对象才给（与异步版同一判定顺序）");
    ok(sb.api.wfNameOfId("sc_wfA") === "画布A", "侧栏显示名取所属画布真名");
    sb.S._deletedWfIds.sc_wfA = { at: Date.now(), name: "画布A" };
    sb.S._deadWfObjs.add(A);
    ok(
      sb.api.wfNameOfId("sc_wfA") === "画布A（已删除）",
      "已删的所属画布在侧栏直说「画布A（已删除）」，不留一个看着还在的名字",
    );
    const sb2 = makeSandbox({});
    sb2.S.config.visitedWorkflows = [{ id: "sc_wfC", name: "画布C" }];
    ok(sb2.api.wfNameOfId("sc_wfC") === "画布C", "画布没加载但在顶部标签条里 → 用标签条的名字");
    ok(sb2.api.wfNameOfId("abcdefghijklmnop") === "abcdefghij…", "彻底查不到就退化成短 id，不瞎猜名字");
    ok(sb2.api.wfNameOfId("") === "", "没绑定（空 id）→ 空名：侧栏宁可不显示");
    ok(sb2.loads.length === 0, "取名一路零读盘（侧栏一次渲染几十行）");
  }
  /* 4i 在飞绑定判据（loadWorkflow 复用的第二条判据） */
  {
    const A = wfOf("sc_wfA", "画布A");
    const B = wfOf("sc_wfB", "画布B");
    const dead = wfOf("sc_wfDead", "已删画布");
    const sb = makeSandbox({});
    sb.api.setForegroundWf(B);
    ok(sb.api.wfInCanvasRun("sc_wfA") === false, "没开轮 → 该画布不在飞");
    sb.api.beginCanvasRun(A);
    ok(sb.api.wfInCanvasRun("sc_wfA") === true, "会话轮开轮 → 所属画布登记为在飞（切回来复用袋中对象）");
    ok(sb.api.wfInCanvasRun("sc_wfB") === false, "在飞判据只认真正被绑着的那张，前台那张不算");
    sb.S._deletedWfIds.sc_wfDead = { at: Date.now(), name: "已删画布" };
    sb.api.beginCanvasRun(dead);
    ok(sb.api.wfInCanvasRun("sc_wfDead") === false, "beginCanvasRun 仍拦得住已删画布（不给它留在飞登记）");
    sb.api.endCanvasRun(A);
    ok(sb.api.wfInCanvasRun("sc_wfA") === false, "收轮出栈 → 在飞登记解除");
  }
  /* 4j 老会话就地补绑一次（真 agentSessions 水合 + 真 dshResolveRunBoundWf） */
  {
    const A = wfOf("sc_wfA", "画布A");
    let persistCalls = 0;
    const lookups = [];
    const ctx = {
      console, Date, JSON, Promise, Object, Array, String, Number, Boolean, RegExp, Error, Set, WeakSet, setTimeout,
      I18n,
      toast: noop,
      planHydrateSession: noop,
      devContractHydrateSession: noop,
      persistAgentSession: () => {
        persistCalls++;
        return Promise.resolve();
      },
      wfOfCanvasIdForRun: (id) => {
        lookups.push(String(id));
        return Promise.resolve(String(id) === "sc_wfA" ? A : null);
      },
      S: {
        wf: A,
        _fgWf: A,
        wfBag: { sc_wfA: A },
        canvasRunStack: [],
        canvasRunWf: null,
        agentActiveId: "sc_as1",
        agentSessions: [{ id: "sc_as1", title: "老会话", canvasWfId: null, messages: [] }],
      },
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    const code =
      [
        grabFunction(ASSIST, "agentSessions"),
        grabFunction(AGENT, "agentSessionOfRun"),
        grabFunction(DB, "dshResolveRunBoundWf"),
        grabFunction(APP, "currentVisibleWf"),
      ].join("\n\n") + "\n({ agentSessions, agentSessionOfRun, dshResolveRunBoundWf })";
    const api = vm.runInContext(code, ctx, { filename: "cross-module#resolve-bound-wf" });
    const list = api.agentSessions();
    ok(list[0].canvasWfId === "", "水合把 null 归属规范成空串（老存档不留 undefined）");
    const got = await api.dshResolveRunBoundWf({ runKey: "agent:sc_as1" });
    ok(got === A, "老会话这一轮照常跑（退回当前画布）");
    ok(list[0].canvasWfId === "sc_wfA", "同时就地补绑一次 → 下一轮起归属稳定");
    ok(persistCalls === 1, "补绑后落盘一次");
    ok(lookups.length === 0, "本轮没有归属可解析 → 不读盘（补绑是纯内存 + 落盘）");
    const byOpt = await api.dshResolveRunBoundWf({ runKey: "agent:sc_as1", canvasWfId: "sc_other" });
    ok(byOpt === null, "opts.canvasWfId 优先于会话字段（并行子任务由 owner 会话显式交给它）");
    ok(lookups.length === 1 && lookups[0] === "sc_other", "显式归属直接按它解析，不再看会话字段");
    ok(list[0].canvasWfId === "sc_wfA", "显式归属解析失败也不会把会话字段改坏");
  }
}

/* ══════════════════════ [5] 画布 / 应用事件按绑定画布路由 ══════════════════════ */
function part5() {
  section("5 canvas / app 帧的路由目标 = 本轮绑定画布");
  const hce = bodyOf(NODES, "handleCanvasEvent", "app-nodes.js");
  has(hce, "runCtx.wf || null", "handleCanvasEvent 先从 runCtx 取本轮绑定画布");
  has(hce, "const target = boundWf || canvasTargetWf();", "目标优先是绑定画布，栈顶只作本地直调兜底");
  has(hce, 'if (opName === "vision")', "识图帧例外：只读本机图片，不进画布上下文");
  ok(
    hce.indexOf("runAgainstWf(target,") > hce.indexOf('if (opName === "vision")'),
    "除 vision 外（含 op==='app'）一律在 runAgainstWf(绑定画布) 内执行",
  );
  hasnt(hce, "const target = canvasTargetWf();", "不再无条件用运行栈栈顶当目标");
  has(hce, "confirmAssistAppOp(data.params || {}, frameOwner, boundWf)", "确认框也拿到绑定画布（与执行同一口径）");

  const aco = bodyOf(NODES, "applyCanvasOp", "app-nodes.js");
  has(aco, "return applyAppOp(params || {}, boundWf);", "app 帧把绑定画布显式交给 applyAppOp");
  has(aco, "canvasSnapshotFull(params || {}, { wf: boundWf })", "get 的快照按绑定画布出");

  const app = bodyOf(NODES, "applyAppOp", "app-nodes.js");
  has(app, "const boundWf = runWf || canvasTargetWf() || S.wf;", "applyAppOp 的目标真源是传进来的绑定画布");
  has(app, "canvasSnapshotFull({}, { wf: boundWf })", "status / list_workflows 快照走绑定画布");
  has(app, "resolveDeleteWfTarget(params, { scopeBlocked, wf: boundWf })", "删除目标按绑定画布解析");
  has(app, "{ wf: boundWf },", "改名同样按绑定画布（无 ref 时改的就是所属那张）");
  has(app, "wfWriteBlocked(boundWf)", "所属画布已删 → 收尾快照换到还活着的上下文");
  ok(
    app.indexOf('action === "select_nodes" || action === "undo" || action === "redo"') >= 0 &&
      /!\s*boundWf\s*\|\|\s*!fg\s*\|\|\s*String\(boundWf\.id\)\s*!==\s*String\(fg\.id\)/.test(app),
    "前台视图动作（选中 / 撤销 / 重做）：所属画布不在前台时明确拒绝，不改用户正看着的那张",
  );

  const del = bodyOf(NODES, "resolveDeleteWfTarget", "app-nodes.js");
  has(del, "opts && opts.wf && opts.wf.id", "删除目标首选调用方显式交进来的绑定画布");
  hasnt(del, /bound\s*=\s*S\.wf/, "删除目标不兜底 S.wf");
  const ren = bodyOf(NODES, "renameWorkflowByRef", "app-nodes.js");
  has(ren, "const bound = (opts && opts.wf) || S.wf;", "改名接收显式绑定画布");
  has(ren, "bound === currentVisibleWf()", "落盘按「是不是用户正看着的那张」分流");
  has(ren, "persistWf(bound)", "后台画布按它自己的 id 落盘，绝不写进前台画布");
  has(bodyOf(NODES, "confirmAssistAppOp", "app-nodes.js"), "summarizeAppOp(params, runWf)", "确认框与执行体共用同一绑定画布口径（杜绝显示 A 实际删 B）");
  has(bodyOf(NODES, "summarizeAppOp", "app-nodes.js"), "resolveDeleteWfTarget(params, { wf: runWf || null })", "确认框里的删除目标也按绑定画布解析");
}

/* ══════════════════════ [6] 前台被切走时写回不丢 ══════════════════════ */
function part6() {
  section("6 会话在后台写所属画布：改动不被旧副本冲掉");
  const lw = bodyOf(APP, "loadWorkflow", "app.js");
  has(lw, "wfHasRunning(bagWf) || wfInCanvasRun(id)", "切回该画布：有节点在跑 或 正被在飞会话轮绑着 → 复用袋中对象");
  hasnt(lw, "if (bagWf && wfHasRunning(bagWf)) {", "旧的单判据已扩写（否则后台写入会被磁盘副本覆盖）");
  const raw = bodyOf(APP, "runAgainstWfInner", "app.js");
  has(raw, "if (S.wf === target && currentVisibleWf() !== target) S.wf = prev;", "期间用户切「到」这张图时把手保持不动（前台上下文不指向别的画布）");
  const edit = bodyOf(NODES, "applyCanvasEdit", "app-nodes.js");
  has(edit, "const editWf = S.wf;", "进函数就把写入目标钉成对象（await 期间用户切画布也不换目标）");
  has(edit, "if (wfWriteBlocked(editWf))", "活性检查按钉住的那个对象做");
  has(edit, "if (editWf === currentVisibleWf() && S._canvasEditVisible !== false)", "收尾按「它是不是用户正看着的那张」分流");
  has(edit, "persistWf(editWf)", "后台画布：按自己的 id 落盘");
  hasnt(edit, "persistWf(S.wf)", "不再出现 persistWf(S.wf)（旧写法在编辑途中被切走时会存错画布）");
  has(bodyOf(APP, "persistWf", "app.js"), "window.api.wfSave(wf.id,", "persistWf 用传入画布自己的 id 落盘（与当前打开哪张无关）");
  has(PRELOAD, "wfSave: (id, data) => ipcRenderer.invoke('workflow:save'", "preload 桥接带上 id，主进程按 id 写盘");
}

/* ══════════════════════ [7] 范围口径 · 提示词 · i18n ══════════════════════ */
function part7() {
  section("7 工作范围口径与提示词改说「会话所属画布」");
  const scope = bodyOf(NODES, "applyAssistScopeToSnapshot", "app-nodes.js");
  hasnt(scope, "canvasTargetWf()", "范围锁定分支不再读运行栈栈顶");
  has(scope, "(opts && opts.wf) || currentVisibleWf() || S.wf", "锁定的是本轮绑定画布（没有才退回前台）");
  has(scope, "工作范围=本会话所属画布：不得读取或操作其他画布内容。", "scopeNote 口径已改");
  const rcoAt = NODES.indexOf("function restrictOtherCanvases()");
  ok(rcoAt > 0, "app-nodes.js 里能找到 restrictOtherCanvases");
  has(NODES.slice(Math.max(0, rcoAt - 700), rcoAt), "所属的那张画布", "restrictOtherCanvases 的注释按「会话所属画布」口径说明");
  const app = bodyOf(NODES, "applyAppOp", "app-nodes.js");
  has(app, "本轮只能操作它绑定的那张画布", "助手分支错误文案与绑定语义一致");
  has(app, "本会话只能访问它所属的画布", "会话分支错误文案改说所属画布");

  hasnt(ASSIST, "你仅能访问当前画布", "会话 systemPrompt 不再写「仅能访问当前画布」");
  has(ASSIST, "查看并修改本会话所属的画布", "systemPrompt：可改的是本会话所属画布");
  has(ASSIST, "你只能访问本会话所属的那张画布", "systemPrompt：范围纪律同口径");
  has(ASSIST, "该画布在会话建立时就已绑定", "systemPrompt 说明归属在建立会话时就定下（切画布不串图）");
  hasnt(ASSIST, "expandW", "systemPrompt 不抄画布字段清单（机制只写 gateway —— 提示词单一真源）");

  const own = (PLUGIN.match(/locked to its own canvas/g) || []).length;
  ok(own >= 3, "canvas-plugin.mjs 有 " + own + " 处「locked to its own canvas」（get / app / workflow 参数）");
  hasnt(PLUGIN, "locked to the current canvas", "旧的「locked to the current canvas」口径已清");
  has(PLUGIN, "on the canvas this run belongs to（会话所属画布，不是用户此刻看到的这张）", "mtnode_app 末段指向 canvas_edit 时说清是所属画布");
  has(PLUGIN, "rename the canvas this run belongs to", "rename_workflow 描述改为改所属画布");
  has(PLUGIN, "it acts on the canvas on screen", "select_nodes / undo / redo 描述补上「只作用屏幕上那张」");
  has(PLUGIN, "that canvas is the only valid target", "workflow 参数说明同步（未新增字段）");

  I18n.setLocale("en");
  const KEYS = [
    "本会话所属画布已被删除",
    "本会话所属画布已被删除：",
    "该操作只作用于屏幕上正显示的画布：本会话所属画布当前不在前台，为避免改到你正在编辑的另一张图，已拒绝执行。",
    "工作范围=本会话所属画布：不得读取或操作其他画布内容。",
    "助手的工作范围是「仅当前画布」：本轮只能操作它绑定的那张画布，无法访问其他画布。请将工作范围改为「全局」后再试。",
    "本会话只能访问它所属的画布，无法读取或操作其他画布。",
    "\n所属画布: ",
    "所属画布：",
    "会话只读写它所属的这张画布；你切到别的画布干活不会串图",
    "（已删除）",
    "画布",
  ];
  const noEn = KEYS.filter((k) => I18n.t(k) === k);
  ok(noEn.length === 0, "本轮口径的 " + KEYS.length + " 条中文键全部有英文译文" + (noEn.length ? "（缺：" + noEn.join(" | ") + "）" : ""));
  I18n.setLocale("zh");
  ok(KEYS.every((k) => I18n.t(k) === k), "中文档逐条原样返回（词条结构未破坏）");
  const all = APP + NODES + DB + ASSIST + AGENT + PLAN + TOOLS + DEVNODE + BOOT + PLUGIN;
  for (const dead of ["工作范围=当前画布", "你仅能访问当前画布", "还可以查看并修改当前画布"]) {
    hasnt(all, dead, "全仓渲染层 / 网关无残留旧口径：「" + dead + "」");
  }
}

/* ══════════════════════ [8] 会话 UI 显示所属画布 ══════════════════════ */
function part8() {
  section("8 会话界面看得出每条会话改的是哪张图");
  const nm = bodyOf(ASSIST, "sessionCanvasName", "app-assist.js");
  has(nm, "wfNameOfId(id)", "显示名走 app.js 的同步解析（侧栏不为取名读盘）");
  has(nm, 'return "";', "没绑定就不显示（宁缺勿写错图）");
  has(bodyOf(ASSIST, "sessionCanvasTooltipLine", "app-assist.js"), 'I18n.t("\\n所属画布: ")', "悬浮说明带「所属画布: xxx」");
  const devb = bodyOf(ASSIST, "sessionIsDevBoundTitle", "app-assist.js");
  has(devb, "_devContract", "节点绑定会话按会话契约字段识别（开发 / 细化 / 问询）");
  has(devb, '"建议"', "建议记录会话（只有标题前缀）也认得");
  ok(/sessionIsDevBoundTitle\(s\)\s*\?\s*""\s*:\s*sessionCanvasName\(s\)/.test(ASSIST), "开发绑定会话行内不追加 ▣（沿用「开发 · 模块名」标题，不加噪声）");
  has(ASSIST, 'wfEl.className = "side-sess-wf"', "侧栏行内元信息元素挂 .side-sess-wf");
  has(ASSIST, '"▣ " + canvasShown', "行内用 ▣ + 画布名");
  has(bodyOf(ASSIST, "sessionWorkspaceTooltipLine", "app-assist.js"), "sessionCanvasTooltipLine(st)", "工作目录 tooltip 同时说清归属（目录按所属画布解析）");
  has(bodyOf(ASSIST, "agentWorkspaceInfo", "app-assist.js"), "canvasProjectRoot(sessionCanvasWf(st))", "会话项目根按所属画布解析，不是前台画布");
  const cAt = ASSIST.indexOf("function renderAgentComposer");
  ok(cAt > 0, "app-assist.js 里能找到 renderAgentComposer");
  const chip = ASSIST.slice(cAt, cAt + 4000);
  has(chip, 'I18n.t("所属画布：") + canvasShown', "会话输入区的工作目录芯片也说清归属");

  ok(/\.side-sess-wf\s*\{[^}]*font-size/.test(CSS_DSH), ".side-sess-wf 有独立小字号样式（低对比元信息）");
  ok(/\.side-sess-wf\s*\{[^}]*text-overflow:\s*ellipsis/.test(CSS_DSH), "画布名过长走省略号，不撑破侧栏");
  has(CSS_DSH, ".side-sess:hover .side-sess-wf", "悬停时与时间一样让位给操作按钮");
  ok(CSS_LIGHT.indexOf(".side-sess-wf") >= 0, "浅色主题同样配了 .side-sess-wf 的对比色");
}

/* ══════════════════════ [9] 手册中英同口径 ══════════════════════ */
function part9() {
  section("9 手册（zh + en）与代码口径一致");
  const ag = read("guides/manual/agent-nodes.md");
  const agEn = read("guides/manual/en/agent-nodes.md");
  const dv = read("guides/manual/dev-nodes.md");
  const dvEn = read("guides/manual/en/dev-nodes.md");
  const wr = read("guides/manual/_write.mjs");
  has(ag, "还可以查看并修改**本会话所属的那张画布**", "zh agent-nodes：改图能力说成所属画布");
  has(ag, "### 会话属于哪张画布", "zh agent-nodes：新增「会话属于哪张画布」小节");
  has(ag, "不会串到你此刻正看着的画布", "zh：明确不会串到前台画布");
  has(ag, "不会误改、误删你正在编辑的那张", "zh：写清不会误删用户正在编辑的画布");
  has(ag, "会话**不跨画布**读写", "zh：边界说明（跨图走右侧全局助手）");
  has(ag, "▣", "zh：说明侧栏 ▣ 就是所属画布");
  hasnt(ag, "还可以查看并修改当前画布", "zh：旧口径已清");
  has(agEn, "**the canvas the session belongs to**", "en agent-nodes：同口径");
  has(agEn, "### Which canvas does a session belong to?", "en：新增小节标题");
  has(agEn, "never on the one now on your screen", "en：说明切画布不会串图");
  has(dv, "所属画布项目根", "zh dev-nodes 工作区表：智能会话按所属画布项目根");
  has(dv, "所属画布 = 该功能块所在的画布", "zh dev-nodes：开发 / 细化绑定会话的归属");
  has(dv, "仅当前画布", "zh dev-nodes：助手档位名与界面一致");
  has(dvEn, "project root of the canvas it belongs to", "en dev-nodes 同口径");
  has(dvEn, "the canvas that block lives on becomes the session's own canvas", "en dev-nodes：功能块档位说清归属");
  /* agent-nodes 页以内嵌模板为真源：模板不能留着旧口径，否则再生成就覆盖回去 */
  has(wr, "### 会话属于哪张画布", "_write.mjs 中文模板同步（不会被生成流程覆盖回旧口径）");
  has(wr, "### Which canvas does a session belong to?", "_write.mjs 英文模板同步");
  has(wr, "还可以查看并修改**本会话所属的那张画布**", "_write.mjs 模板正文同口径");
  hasnt(wr, "还可以查看并修改当前画布", "_write.mjs 无旧口径残留");
  const mdSection = (src, marker) => {
    const at = src.indexOf(marker);
    if (at < 0) return "";
    const ends = [src.indexOf("\n### ", at + marker.length), src.indexOf("\n## ", at + marker.length)].filter((x) => x > 0);
    return (ends.length ? src.slice(at, ends.sort((a, b) => a - b)[0]) : src.slice(at)).trim();
  };
  for (const [src, marker] of [
    [ag, "### 会话属于哪张画布"],
    [agEn, "### Which canvas does a session belong to?"],
  ]) {
    const seg = mdSection(src, marker);
    ok(seg.length > 80, "手册里能定位到小节：" + marker);
    ok(seg.length > 80 && wr.indexOf(seg) >= 0, "该小节与 _write.mjs 模板逐字一致：" + marker);
  }
}

async function main() {
  part1();
  part2();
  part3();
  await part4();
  part5();
  part6();
  part7();
  part8();
  part9();
  console.log(
    "\n" +
      (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全部通过") +
      "  (smoke-session-canvas)",
  );
}
main().catch((err) => {
  console.log("\n测试异常：" + ((err && (err.stack || err.message)) || err));
  console.log("✗ 异常中止（已累计 " + fails + " / " + checks + " 项失败）");
});

/* ==================== 已并入：test/smoke-session-draft-keep.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-session-draft-keep.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

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
    fs.readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8");

  /* ============================ 迷你 DOM ============================ */
  function mkEl(tag, cls, id) {
    const el = {
      nodeType: 1,
      tagName: String(tag || "div").toUpperCase(),
      id: String(id || ""),
      parentNode: null,
      children: [],
      dataset: {},
      style: {},
      title: "",
      value: "",
      hidden: false,
      _cls: new Set(String(cls || "").split(/\s+/).filter(Boolean)),
    };
    el.classList = {
      add: (c) => el._cls.add(c),
      remove: (c) => el._cls.delete(c),
      contains: (c) => el._cls.has(c),
      toggle: (c, on) => {
        if (on === undefined ? !el._cls.has(c) : !!on) el._cls.add(c);
        else el._cls.delete(c);
      },
      toString: () => Array.from(el._cls).join(" "),
    };
    el.appendChild = (c) => {
      if (!c) return c;
      if (c.parentNode) c.parentNode.removeChild(c);
      c.parentNode = el;
      el.children.push(c);
      return c;
    };
    el.insertBefore = (c, before) => {
      if (!c) return c;
      if (c.parentNode) c.parentNode.removeChild(c);
      c.parentNode = el;
      const i = el.children.indexOf(before);
      if (i < 0) el.children.push(c);
      else el.children.splice(i, 0, c);
      return c;
    };
    el.removeChild = (c) => {
      const i = el.children.indexOf(c);
      if (i >= 0) el.children.splice(i, 1);
      if (c) c.parentNode = null;
      return c;
    };
    el.remove = () => {
      if (el.parentNode) el.parentNode.removeChild(el);
    };
    el.contains = (node) => {
      for (let n = node; n; n = n.parentNode) if (n === el) return true;
      return false;
    };
    el.setAttribute = () => {};
    el.removeAttribute = () => {};
    el.querySelector = () => null;
    el.querySelectorAll = () => [];
    el.addEventListener = () => {};
    el.closest = (sel) => {
      const s = String(sel || "");
      for (let n = el; n; n = n.parentNode) {
        if (s[0] === "." && n._cls && n._cls.has(s.slice(1))) return n;
        if (s[0] === "#" && n.id === s.slice(1)) return n;
      }
      return null;
    };
    Object.defineProperty(el, "firstChild", { get: () => el.children[0] || null });
    Object.defineProperty(el, "innerHTML", {
      get: () => el.textContent || "",
      set: () => {
        for (const c of el.children.slice()) el.removeChild(c);
      },
    });
    Object.defineProperty(el, "className", {
      get: () => Array.from(el._cls).join(" "),
      set: (v) => {
        el._cls = new Set(String(v || "").split(/\s+/).filter(Boolean));
      },
    });
    return el;
  }
  function docGetById(root, id) {
    const walk = (node) => {
      if (node.id === id) return node;
      for (const c of node.children || []) {
        const hit = walk(c);
        if (hit) return hit;
      }
      return null;
    };
    return walk(root);
  }

  /* ============================ 沙箱 ============================ */
  const SESSIONS = [
    { id: "s1", title: "开发 · 新应用", appId: "app-new", messages: [], updatedAt: 3, _draft: "" },
    { id: "s2", title: "开发 · 中间应用", appId: "app-mid", messages: [], updatedAt: 2, _draft: "" },
  ];
  const APPS = [
    { id: "app-new", name: "新应用", dev: true },
    { id: "app-mid", name: "中间应用", dev: true },
  ];

  function build() {
    const root = mkEl("body", "", "");
    const sideList = root.appendChild(mkEl("div", "agent-side-list", "appsDevSideList"));
    const pane = root.appendChild(mkEl("div", "agent-pane", "agentPane"));
    const body = pane.appendChild(mkEl("div", "agent-body", ""));
    const list = body.appendChild(mkEl("div", "agent-list", "agentList"));
    const composer = body.appendChild(mkEl("div", "agent-composer", ""));
    const input = composer.appendChild(mkEl("textarea", "chat-input", "agentInput"));
    const calls = { configSave: [] };
    const timers = new Map();
    let timerSeq = 0;
    const S = {
      agentSessions: SESSIONS,
      agentActiveId: "s1",
      config: {},
    };
    const sandbox = {
      document: {
        getElementById: (id) => docGetById(root, String(id)),
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: (t) => mkEl(t),
        createTextNode: (x) => ({ nodeType: 3, textContent: String(x) }),
        body: root,
        contains: (n) => root.contains(n),
        addEventListener: () => {},
        removeEventListener: () => {},
        activeElement: null,
      },
      window: {
        api: {
          configSave: (cfg) => {
            calls.configSave.push(cfg);
            return Promise.resolve();
          },
        },
        addEventListener: () => {},
      },
      console,
      I18n: { t: (x) => x, getLocale: () => "zh" },
      APPS_ST: { nav: "dev" },
      AGENT_PRESET_DEFAULT: "standard",
      AGENT_EFFORT_UI_ORDER: ["low", "medium", "high"],
      S,
      $: (sel) => {
        const s = String(sel || "");
        return s[0] === "#" ? docGetById(root, s.slice(1)) : null;
      },
      appsHubIsOpen: () => true,
      appsLocalList: () => APPS,
      appsLocalById: (id) => APPS.find((a) => a.id === id) || null,
      appSessionsOf: (id) => SESSIONS.filter((s) => s.appId === id),
      /* 重绘依赖：本轮不测渲染，全部换成空实现，只让「草稿存取」这条链真跑 */
      liveNodeForSession: () => null,
      sessionIsRunning: () => false,
      markConvStick: () => {},
      captureConvStick: () => null,
      restoreConvStick: () => {},
      scheduleHistoryCollapse: () => {},
      rememberAgentThinkScroll: () => {},
      agentNotifyBrowserSession: () => {},
      paintAgentSendState: () => {},
      renderAgentComposer: () => {},
      renderAgentSessionSidebar: () => {},
      renderAgentQueueBar: () => {},
      renderAgentTodoPanel: () => {},
      renderSessionFooterStat: () => {},
      paintAgentToolsChip: () => {},
      paintAgentModeChip: () => {},
      persistAgentSession: () => Promise.resolve(),
      appsDevToast: () => {},
      toast: () => {},
      /* 定时器：草稿落盘是防抖的，这里收着由测试自己兑现 */
      setTimeout: (fn) => {
        const id = ++timerSeq;
        timers.set(id, fn);
        return id;
      },
      clearTimeout: (id) => {
        timers.delete(id);
      },
      requestAnimationFrame: () => 0,
      cancelAnimationFrame: () => {},
      setInterval: () => 0,
      clearInterval: () => {},
    };
    vm.createContext(sandbox);
    for (const f of ["renderer/app-apps-dev.js", "renderer/app-assist.js"]) {
      vm.runInContext(read(f), sandbox, { filename: f });
    }
    const get = (expr) => vm.runInContext(expr, sandbox);
    const flush = () => {
      for (const [id, fn] of Array.from(timers.entries())) {
        timers.delete(id);
        fn();
      }
    };
    /* 开发页「装起来」：宿主容器在文档里 + 选中一个应用（appsDevPageOpen 的判据） */
    const openDev = (appId) => {
      get("DEVD").listEl = sideList;
      get("DEVD").appId = appId || "app-new";
      get("DEVD").draft = true;
      get("DEVD").sessionId = "";
    };
    return { sandbox, get, calls, timers, flush, root, sideList, list, composer, input, S, openDev };
  }

  /* ============================ [1] 视图键 ============================ */
  console.log("[1] 草稿的视图键（agentDraftKeyNow）：谁的字记在谁名下");
  {
    const s = build();
    s.openDev("app-new");
    s.S.agentActiveId = "s1";
    ok(
      s.get("agentDraftKeyNow()") === "s1",
      "会话页（没有显示覆盖）= 当前会话 id：得到 " + s.get("agentDraftKeyNow()"),
    );
    s.get('agentViewOverrideSet("s2")');
    ok(
      s.get("agentDraftKeyNow()") === "s2",
      "开发页显示某条会话 = 那条会话 id（覆盖不改归属）",
    );
    s.get('agentViewOverrideSet("")');
    ok(
      s.get('agentDraftKeyNow()') === s.get('"\\u0000dev-first:" + "app-new"'),
      "开发页首轮态 = \"\\u0000dev-first:<appId>\"（草稿挂不到占位空会话上，按应用存）",
    );
    s.get("DEVD").appId = "app-mid";
    ok(
      s.get('agentDraftKeyNow()') === s.get('"\\u0000dev-first:" + "app-mid"'),
      "键跟着应用走（切应用 = 换一份草稿，A 的半截字不会跑到 B 名下）",
    );
    s.get("agentViewOverrideClear()");
    ok(s.get("agentDraftKeyNow()") === "s1", "撤掉覆盖回会话页：键回到当前会话");
  }

  /* ============================ [2] 输入即记 ============================ */
  console.log("[2] 输入即记（agentDraftTick）：草稿不再只活在 DOM 里");
  {
    const s = build();
    s.openDev("app-new");
    s.get('agentViewOverrideSet("")');
    s.input.value = "给这个应用加一个聊天栏";
    s.get("agentDraftTick()");
    ok(
      s.S.config.appsDevDrafts && s.S.config.appsDevDrafts["app-new"] === "给这个应用加一个聊天栏",
      "首轮态：敲进去的字立刻进 config.appsDevDrafts[appId]",
    );
    s.flush();
    ok(
      s.calls.configSave.length === 1 && s.calls.configSave[0] === s.S.config,
      "落盘走防抖的 window.api.configSave(S.config)（与 appsDevLastApp 同一口径）",
    );
    /* 会话侧：写的是会话自己的 _draft（老口径没变，随会话落盘） */
    s.get("agentViewOverrideClear()");
    s.S.agentActiveId = "s1";
    s.get("renderAgentSession()");
    s.input.value = "会话一的半截话";
    s.get("agentDraftTick()");
    ok(SESSIONS[0]._draft === "会话一的半截话", "会话页：输入即记进这条会话的 _draft");
    ok(
      !s.S.config.appsDevDrafts["s1"],
      "会话草稿不混进开发页草稿表（两张表各管各的）",
    );
  }

  /* ============================ [3] 切页 / 重绘不丢（本轮需求本体） ============================ */
  console.log("[3] 开发页首轮态写一半 → 切走 → 回来，字还在");
  {
    const s = build();
    s.openDev("app-new");
    s.S.agentActiveId = "s1";
    SESSIONS[0]._draft = "";
    /* 进开发页：显示覆盖 = 空（首轮态），输入框空 */
    s.get('agentViewOverrideSet("")');
    s.get("renderAgentSession()");
    ok(s.input.value === "", "首轮态刚画出来：输入框是空的（不凭空补字）");
    s.input.value = "把这个应用的首页改成深色";
    s.get("agentDraftTick()");
    ok(
      s.S.config.appsDevDrafts["app-new"] === "把这个应用的首页改成深色",
      "用户正在写的第一轮需求已按应用留底",
    );
    /* 关页 / 切页回收 = app-apps-dev.js appsDevViewClear 的两步：撤覆盖 + 按会话页重绘 */
    s.get("agentViewOverrideClear()");
    s.get("renderAgentSession()");
    ok(s.input.value === "", "切走后这只框换成会话页那条会话的草稿（首轮那半截不再占着它）");
    ok(
      s.S.config.appsDevDrafts["app-new"] === "把这个应用的首页改成深色",
      "人走了，草稿没走",
    );
    /* 回来：重新进开发页（还是首轮态） */
    s.get('agentViewOverrideSet("")');
    s.get("renderAgentSession()");
    ok(
      s.input.value === "把这个应用的首页改成深色",
      "回到开发页：那半截需求原样回到输入框（本轮需求：未输入完毕发送的内容不许丢）",
    );
    /* 再切走切回一次也不磨损 */
    s.get("agentViewOverrideClear()");
    s.get("renderAgentSession()");
    s.get('agentViewOverrideSet("")');
    s.get("renderAgentSession()");
    ok(s.input.value === "把这个应用的首页改成深色", "来回切两次仍然在（存取幂等）");
  }

  /* ============================ [4] 有没发的字 → 右栏不许被自动选会话顶掉 ============================ */
  console.log("[4] 首轮态有未发送内容时，自动选会话那条闸必须闭着");
  {
    const s = build();
    s.openDev("app-new");
    s.get('agentViewOverrideSet("")');
    s.get("renderAgentSession()");
    s.input.value = "写了一半的需求";
    const picked = s.get("appsDevEnsureCurrentSession()");
    ok(picked === false, "框里有字：appsDevEnsureCurrentSession 不动（返回 false）");
    ok(
      s.get("DEVD").draft === true && s.get("DEVD").sessionId === "",
      "本页仍停在首轮态（没被换成 app-new 下面那条会话）",
    );
    ok(
      s.get("appsDevDraftPending()") === true,
      "appsDevDraftPending：识别出「有还没发出去的字」",
    );
    /* 用户自己清空输入框：闸放开，老行为恢复（还有会话就必须显示一条） */
    s.input.value = "";
    s.get("agentDraftTick()");
    ok(s.get("appsDevDraftPending()") === false, "框清空 → 不再算 pending");
    const picked2 = s.get("appsDevEnsureCurrentSession()");
    ok(
      picked2 === true && s.get("DEVD").sessionId === "s1",
      "清空后照旧自动落到该应用最近一条会话（不会把开发页卡在首轮态）",
    );
  }

  /* ============================ [5] 切应用：各归各的 ============================ */
  console.log("[5] 切应用：A 的半截需求退回 A 名下，B 拿到自己那份");
  {
    const s = build();
    s.openDev("app-new");
    s.get('agentViewOverrideSet("")');
    s.get("renderAgentSession()");
    s.input.value = "A 应用的需求";
    s.get("agentDraftTick()");
    s.S.config.appsDevDrafts["app-mid"] = "B 应用早先写的";
    /* 点左栏另一个应用（app-apps-dev.js appsDevSelectApp 的落点：换 appId + 整页重绘） */
    s.get("DEVD").appId = "app-mid";
    s.get("renderAgentSession()");
    ok(
      s.S.config.appsDevDrafts["app-new"] === "A 应用的需求",
      "切走时 A 的字退回 A 名下（按视图键存，不跟到 B）",
    );
    ok(s.input.value === "B 应用早先写的", "B 的框显示 B 自己的那份草稿");
    s.get("DEVD").appId = "app-new";
    s.get("renderAgentSession()");
    ok(s.input.value === "A 应用的需求", "切回 A：A 的半截需求还在");
  }

  /* ============================ [6] 发出去 / 清空 = 不留痕 ============================ */
  console.log("[6] 首轮需求交出去之后，草稿槽清干净");
  {
    const s = build();
    s.openDev("app-new");
    s.get('agentViewOverrideSet("")');
    s.get("renderAgentSession()");
    s.input.value = "这条要发出去";
    s.get("agentDraftTick()");
    ok(s.get("appsDevDraftLoad('app-new')") === "这条要发出去", "前置：草稿在");
    s.get("appsDevDraftClear('app-new')"); /* = appsDevStartDevSession 在会话建好那一刻做的事 */
    ok(s.get("appsDevDraftLoad('app-new')") === "", "发出后：草稿槽清掉");
    ok(
      !s.S.config.appsDevDrafts || !("app-new" in s.S.config.appsDevDrafts),
      "config 里不留空串（下次点「＋」不会冒出上一轮的需求）",
    );
    s.flush();
    ok(
      s.calls.configSave.length === 1,
      "清草稿立刻落盘一次（防抖里那次被清掉，不会多写一遍）：得到 " + s.calls.configSave.length,
    );
    /* 空草稿不占位：写空 = 删条目 */
    s.get("appsDevDraftSave('app-mid', 'x')");
    s.get("appsDevDraftSave('app-mid', '')");
    ok(s.get("appsDevDraftLoad('app-mid')") === "", "写空 = 删条目（不留下 '' 这种占位）");
    /* 发出去之后的再次渲染：框是空的，不是旧字 */
    s.input.value = "";
    s.get("renderAgentSession()");
    ok(s.input.value === "", "发完再画：输入框空白（旧字不会漂回来）");
  }

  /* ============================ [7] 老口径不回退：会话之间各留各的 ============================ */
  console.log("[7] 会话之间的草稿隔离仍然成立（老行为）");
  {
    const s = build();
    s.S.agentActiveId = "s1";
    SESSIONS[0]._draft = "";
    SESSIONS[1]._draft = "";
    s.get("renderAgentSession()");
    ok(s.input.value === "", "s1 没有草稿 → 空框");
    s.input.value = "s1 写到一半";
    s.get("agentDraftTick()");
    s.S.agentActiveId = "s2";
    s.get("renderAgentSession()");
    ok(s.input.value === "", "切到 s2：s2 自己的草稿（空）");
    ok(SESSIONS[0]._draft === "s1 写到一半", "s1 那半截存进它自己的 _draft");
    s.input.value = "s2 写到一半";
    s.get("agentDraftTick()");
    s.S.agentActiveId = "s1";
    s.get("renderAgentSession()");
    ok(s.input.value === "s1 写到一半", "切回 s1：s1 的草稿回来");
    ok(SESSIONS[1]._draft === "s2 写到一半" && SESSIONS[0]._draft === "s1 写到一半", "两条会话互不串台");
    /* 老写法（只看会话 id、切那一刻抄一次）已退役：现在是按视图键 + 输入即记 */
    const assist = read("renderer/app-assist.js");
    ok(
      assist.indexOf("const prev = agentSessions().find((x) => x.id === prevId);") < 0,
      "旧的「切会话那一刻才抄一次」写法已去掉（改走 agentDraftKeyNow / agentDraftStash）",
    );
    ok(
      assist.indexOf("S._agentInputDraftKey") >= 0 &&
        assist.indexOf("agentDraftKeyNow()") >= 0,
      "renderAgentSession 按视图键存 / 取草稿（首轮态也在这一条路上）",
    );
    const boot = read("renderer/app-boot.js");
    ok(
      boot.indexOf("agentDraftTick()") >= 0,
      "app-boot.js 的 #agentInput input 监听里挂了 agentDraftTick（输入即记）",
    );
    const dev = read("renderer/app-apps-dev.js");
    ok(
      dev.indexOf("appsDevDraftClear(DEVD.appId);") >= 0,
      "开发会话建好那一刻清掉首轮草稿槽（appsDevStartDevSession）",
    );
  }

  console.log(
    (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全部通过") +
      "  (smoke-session-draft-keep)",
  );

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-session-draft-keep.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-session-draft-keep.js：" + fails + " / " + checks + " 项失败");
})();

/* ==================== 已并入：test/smoke-session-md-settle.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-session-md-settle.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

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
  const has = (src, needle, msg) =>
    ok(src.indexOf(needle) >= 0, msg + (src.indexOf(needle) >= 0 ? "" : "（未找到）"));
  const countOf = (src, re) => (src.match(re) || []).length;

  /* ---------- 从源码里按名字抠出顶层函数 / 常量（不改动源文件） ---------- */
  function fnBody(src, name) {
    const pats = [
      new RegExp("\\n(?:async\\s+)?function " + name + "\\s*\\(", "m"),
      new RegExp("\\nconst " + name + "\\s*=", "m"),
      new RegExp("\\nvar " + name + "\\s*=", "m"),
    ];
    let at = -1;
    for (const p of pats) {
      const m = src.match(p);
      if (m) {
        at = m.index + 1;
        break;
      }
    }
    if (at < 0) throw new Error("找不到函数/常量：" + name);
    const isFn = /^(async\s+)?function/.test(src.slice(at, at + 14));
    if (isFn) {
      const i = src.indexOf("{", at);
      if (i < 0) throw new Error("找不到函数体：" + name);
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
    const iBrace = src.indexOf("{", at);
    const iBracket = src.indexOf("[", at);
    const start =
      iBrace < 0 ? iBracket : iBracket < 0 || iBrace < iBracket ? iBrace : iBracket;
    if (start < 0) throw new Error("找不到常量体：" + name);
    let depth2 = 0;
    for (let j = start; j < src.length; j++) {
      const c = src[j];
      if (c === "{" || c === "[") depth2++;
      else if (c === "}" || c === "]") {
        depth2--;
        if (!depth2) return src.slice(at, j + 1) + ";";
      }
    }
    throw new Error("常量体不完整：" + name);
  }
  function constLine(src, name) {
    const re = new RegExp("\\n[ \\t]*(?:const|let|var) " + name + "\\s*=[^\\r\\n]*", "m");
    const m = src.match(re);
    if (!m) throw new Error("找不到单行常量：" + name);
    return m[0].replace(/^\n/, "") + "\n";
  }
  const extract = (src, names) => names.map((n) => fnBody(src, n)).join("\n");

  const DB = read("renderer/app-db.js");
  const ASSIST = read("renderer/app-assist.js");

  /* ==================== [1] 源码口径 ==================== */
  console.log("\n[1] say 段开合标记 + 唯一收口出口");
  has(DB, "function traceCloseSay(tr) {", "app-db.js 新增 traceCloseSay（正文段收口出口）");
  ok(
    countOf(DB, /tr\._openSay = false;/g) === 1,
    "tr._openSay = false 只剩 traceCloseSay 里那一处（旧散点全部改走收口函数；实得 " +
      countOf(DB, /tr\._openSay = false;/g) +
      " 处）",
  );
  ok(
    /function traceCloseSay\(tr\) \{[\s\S]{0,400}?if \(last && last\.k === "say" && last\.open !== false\) last\.open = false;/.test(
      DB,
    ),
    "traceCloseSay 只把当时最后那一条 say 段标记为已定稿（思考 / 工具 / 错误段不动）",
  );
  has(
    DB,
    'const it = { k: "say", text: body, step, callId: "", at: atNow, open: true };',
    "新建正文段带 open:true（与 think 段同一套「仍在增长」语义）+ at（这一段自己的起始时刻）",
  );
  ok(
    countOf(DB, /traceCloseSay\(tr\);/g) >= 5,
    "所有收口点（say-end / turn / step / tool / err）都走 traceCloseSay（实得 " +
      countOf(DB, /traceCloseSay\(tr\);/g) +
      " 处）",
  );
  ok(
    /if \(traceThinkEventSameStream\(tr, e, turn, step\)\) traceThinkCloseIfBig\(tr\);[\s\S]{0,300}?traceCloseSay\(tr\);[\s\S]{0,120}?const it = \{ k: "tool"/.test(
      DB,
    ),
    "工具段：先把正文段收口再落工具段（顺序不能反）",
  );

  /* ==================== [2] 真实 tracePush 行为（vm） ==================== */
  console.log("\n[2] 真实 tracePush：收口后不再并进，续写另起新段");
  const S = {};
  const sandbox = { S, console };
  vm.createContext(sandbox);
  vm.runInContext(
    constLine(DB, "THINK_TINY_CHARS") +
      "\n" +
      extract(DB, [
        "traceRunKey",
        "traceNum",
        "traceReset",
        "traceOf",
        "joinThinkText",
        "traceStreamKey",
        "traceToolSeq",
        "traceThinkOpenItem",
        "traceThinkEventSameStream",
        "traceThinkCloseIfBig",
        "traceCloseThink",
        "traceCloseSay",
        "tracePush",
        "traceText",
      ]),
    sandbox,
    { filename: "session-md-settle-extract.js" },
  );
  const G = (name) =>
    vm.runInContext(
      "(typeof " + name + " === 'undefined' ? null : " + name + ")",
      sandbox,
    );
  ["traceCloseSay", "tracePush", "traceText"].forEach((n) =>
    ok(typeof G(n) === "function", "vm 抽到真实函数：" + n),
  );
  const saySegs = (rk) => {
    const tr = S.runTrace[G("traceRunKey")(rk)];
    return (tr && tr.items ? tr.items : []).filter((it) => it.k === "say");
  };

  /* [2a] say-end 收口：段标定稿，续写另起新段（不再并回定稿段） */
  const RK1 = "mdSettle:sayend";
  G("traceReset")(RK1);
  G("tracePush")(RK1, "say", "# 最终答复", { turn: 1, step: 4, index: 0 });
  let segs = saySegs(RK1);
  ok(segs.length === 1 && segs[0].open === true, "正文段建出来时 open=true（还在增长）");
  G("tracePush")(RK1, "say-end", "", { turn: 1, step: 4, index: 0 });
  ok(segs[0].open === false, "say-end 一到，该段立即定稿（open=false）→ 渲染层改走 markdown");
  G("tracePush")(RK1, "say", "补充一句", { turn: 1, step: 4, index: 1 });
  segs = saySegs(RK1);
  ok(
    segs.length === 2 && segs[1].open === true && segs[1].text === "补充一句",
    "收口后的续写另起新段（定稿段不被改写、不重新打开）",
  );
  ok(segs[0].text === "# 最终答复", "定稿段正文原样保留（渲染出的 markdown 与前一段一致）");

  /* [2b] 工具调用 / 换 step 同样收口 */
  const RK2 = "mdSettle:tool";
  G("traceReset")(RK2);
  G("tracePush")(RK2, "say", "看完代码再答", { turn: 1, step: 1 });
  G("tracePush")(RK2, "tool", "", { turn: 1, step: 1, callId: "c1" });
  ok(saySegs(RK2)[0].open === false, "调工具前先把正文段收口（顺序：正文定稿 → 工具段）");
  const tr2 = S.runTrace[G("traceRunKey")(RK2)];
  ok(
    tr2.items[0].k === "say" && tr2.items[1].k === "tool",
    "轨迹顺序仍是「正文 → 工具」（收口没有插队）",
  );

  const RK3 = "mdSettle:step";
  G("traceReset")(RK3);
  G("tracePush")(RK3, "say", "第一段", { turn: 1, step: 1 });
  G("tracePush")(RK3, "say", "第二段", { turn: 1, step: 2 });
  segs = saySegs(RK3);
  ok(
    segs.length === 2 && segs[0].open === false && segs[1].open === true,
    "换 step = 上一段收口 + 新开放段",
  );
  G("tracePush")(RK3, "say", "第二段续写", { turn: 1, step: 2 });
  segs = saySegs(RK3);
  ok(
    segs.length === 2 && segs[1].text === "第二段第二段续写",
    "新段仍在开放 → 同 step 增量照旧并进这一段（流式不碎段）",
  );
  ok(G("traceText")(RK3, "say") === "第一段\n\n第二段第二段续写", "全文口径不变（段间空行）");

  /* ==================== [3] 落盘段快照不带界面状态位 ==================== */
  console.log("\n[3] open / 运行态只活在运行轨迹里，不进存档（时刻与轮号例外：要随段落盘）");
  has(
    DB,
    "out.push({ k: it.k, step: it.step, text, round, at });",
    "traceSegmentsOf 只带 k / step / text / round / at（open 不随消息落盘；at = 逐项时刻，本轮需求要它）",
  );
  ok(
    !/open: it\.open|o\.open =/.test(DB),
    "落盘段快照里没有 open 这个键（界面状态位不随消息存档）",
  );
  has(
    ASSIST,
    "const o = { k: s.k, text, step: s.step != null ? s.step : null };",
    "agentSegsForDisk 也只带 k / text / step（+callId）",
  );

  /* ==================== [4] 渲染接线 ==================== */
  console.log("\n[4] 渲染接线：只有仍开放的尾段走纯文本，收尾必落定一次");
  has(
    ASSIST,
    "const stillStreaming = streaming && !(seg.k === \"say\" && seg.open === false);",
    "agentLiveSegsEl：已收口的正文段即使还是尾段也按 markdown 渲染",
  );
  ok(
    /if \(stillStreaming\) \{[\s\S]{0,400}?\} else \{[\s\S]{0,200}?md\.innerHTML = renderMarkdown\(/.test(
      ASSIST,
    ),
    "纯文本分支与 markdown 分支的分工保持原样（只是判定换成了 stillStreaming）",
  );
  has(
    ASSIST,
    'if (kind === "say" && last.open === false) return null;',
    "agentLiveSegTail：已收口段不再当就地更新目标（返回 null → 调用方整表重绘）",
  );
  has(
    ASSIST,
    '} else if (type === "say-end") {',
    "会话 onEvent 新增 say-end 分支（正文块收尾即重绘一次）",
  );
  ok(
    /type === "say-end"[\s\S]{0,600}?const items = agentChatSegItems\(st\) && agentTraceItems\("agent:" \+ st\.id\);[\s\S]{0,300}?last\.k === "say" && last\.open === false[\s\S]{0,120}?renderAgentSession\(\);/.test(
      ASSIST,
    ),
    "say-end 只在「刚收口的正文段正好是尾段」时重绘（后面还有工具 / 思考段就不白刷）",
  );
  ok(
    /st\.running = false;\s*\n\s*st\._cancelled = false;\s*\n\s*st\._liveTools = \[\];[\s\S]{0,700}?if \(agentViewIs\(st\)\) renderAgentSession\(\);/.test(
      ASSIST,
    ),
    "finally 一置 st.running=false 就先落定一次界面（排在 persist / 侧栏刷新之前）",
  );
  ok(
    ASSIST.indexOf("旧口径里渲染是\n") > 0 ||
      /finally 的最后一句，前面 persist/.test(ASSIST),
    "注释写清根因：渲染原先是 finally 最后一句，前面任一步抛错就轮不到它",
  );

  /* ==================== [5] 真实 agentLiveSegTail 行为（vm） ==================== */
  console.log("\n[5] 真实 agentLiveSegTail：已收口段不再被就地纯文本覆盖");
  const sb2 = { Number, console };
  vm.createContext(sb2);
  vm.runInContext(fnBody(ASSIST, "agentLiveSegTail"), sb2, {
    filename: "agentLiveSegTail.js",
  });
  const tailFn = vm.runInContext("agentLiveSegTail", sb2);
  const el0 = { dataset: { segIdx: "0" } };
  ok(
    tailFn([{ k: "say", text: "还在写", open: true }], el0, "say") !== null,
    "开放中的尾段：照旧返回该段（就地纯文本追加）",
  );
  ok(
    tailFn([{ k: "say", text: "已定稿", open: false }], el0, "say") === null,
    "已收口的尾段：返回 null（调用方整表重绘 → 渲染成 markdown）",
  );
  ok(
    tailFn([{ k: "tool", step: 1 }], el0, "say") === null,
    "段类型对不上照旧 null",
  );
  ok(
    tailFn([{ k: "say", text: "x", open: true }], { dataset: { segIdx: "3" } }, "say") ===
      null,
    "段序对不上照旧 null（刚从别的段切过来时整表重绘一次）",
  );

  console.log(
    "\n" +
      (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全部通过") +
      "  (smoke-session-md-settle)",
  );

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-session-md-settle.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-session-md-settle.js：" + fails + " / " + checks + " 项失败");
})();

/* ==================== 已并入：test/smoke-session-scroll-stable.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-session-scroll-stable.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

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
  const has = (src, needle, msg) =>
    ok(src.indexOf(needle) >= 0, msg + (src.indexOf(needle) >= 0 ? "" : "（未找到）"));
  const countOf = (src, re) => (src.match(re) || []).length;

  /* ---------- 从源码里按名字抠出顶层函数（不改动源文件） ---------- */
  function fnBody(src, name) {
    const pats = [
      new RegExp("\\n(?:async\\s+)?function " + name + "\\s*\\(", "m"),
      new RegExp("\\nconst " + name + "\\s*=", "m"),
      new RegExp("\\nvar " + name + "\\s*=", "m"),
    ];
    let at = -1;
    for (const p of pats) {
      const m = src.match(p);
      if (m) {
        at = m.index + 1;
        break;
      }
    }
    if (at < 0) throw new Error("找不到函数/常量：" + name);
    const i = src.indexOf("{", at);
    if (i < 0) throw new Error("找不到函数体：" + name);
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
  function constLine(src, name) {
    const re = new RegExp(
      "\\n[ \\t]*(?:const|let|var) " + name + "\\s*=[^\\r\\n]*",
      "m",
    );
    const m = src.match(re);
    if (!m) throw new Error("找不到单行常量：" + name);
    return m[0].replace(/^\n/, "") + "\n";
  }

  const APP = read("renderer/app.js");

  /* ==================== [1] 源码口径 ==================== */
  console.log("\n[1] 键锚点还原 + 带序号的程序滚动守卫");
  has(
    APP,
    "function convScrollGuardOn(el) {",
    "app.js 新增 convScrollGuardOn（程序滚动守卫的唯一判定入口）",
  );
  has(
    APP,
    "function convAnchorRow(el, cap) {",
    "app.js 新增 convAnchorRow（按键找还原锚点行）",
  );
  has(
    APP,
    "function convRestoreOff(el, want, top) {",
    "app.js 新增 convRestoreOff（落点离谱才收口）",
  );
  ok(
    /function convAnchorRow\(el, cap\) \{[\s\S]{0,400}?if \(!a\.key\) return null;/.test(APP),
    "锚点没有键就不还原（不拿序号兜底）",
  );
  ok(APP.indexOf("rows[a.idx]") < 0, "restoreConvStick 里的 rows[a.idx] 序号兜底已删净");
  ok(
    APP.indexOf("(cap.top * el.scrollHeight) / cap.prevH") < 0,
    "restoreConvStick 里的按比例还原已删净（不再均摊上方长出来的高度）",
  );
  ok(
    /function setConvScrollTop\(el, top\) \{[\s\S]{0,260}?_convAutoScrollGen = \(Number\(el\._convAutoScrollGen\) \|\| 0\) \+ 1/.test(
      APP,
    ),
    "setConvScrollTop 给每一笔程序写入编号（_convAutoScrollGen）",
  );
  ok(
    /function setConvScrollTop\(el, top\) \{[\s\S]{0,520}?if \(Number\(el\._convAutoScrollGen\) !== gen\) return;/.test(
      APP,
    ),
    "守卫只由「最后一笔」解除：期间又写过就不解锁",
  );
  ok(
    countOf(APP, /_convAutoScroll = false;/g) === 2,
    "解除守卫只剩 setConvScrollTop 里那两处（带序号回调 + 无 rAF 兜底；实得 " +
      countOf(APP, /_convAutoScroll = false;/g) +
      " 处）",
  );
  ok(
    countOf(APP, /if \(convScrollGuardOn\(/g) >= 4,
    "各处 scroll 监听 / 尺寸补滚统一走 convScrollGuardOn（实得 " +
      countOf(APP, /if \(convScrollGuardOn\(/g) +
      " 处）",
  );

  /* ==================== 纯几何桩 ====================
     只给这套 helper 真正用到的量：el.scrollTop / clientHeight / scrollHeight，与每行的
     contentTop / offsetHeight / getBoundingClientRect().top。行的 rect.top 直接按浏览器
     口径写好（视口 = 内容坐标 - 容器 scrollTop）；列表自身固定在视口顶部（rect.top = 0），
     与真 DOM 里对话区在 .agent-body 中的占位一致。 */
  function mkList(rows, opt) {
    const o = opt || {};
    const list = {
      scrollTop: Math.max(0, Number(o.top) || 0),
      scrollHeight: Number(o.scrollHeight) || 0,
      clientHeight: Number(o.clientHeight) || 0,
      children: [],
      /* 列表自身固定在视口顶部：rect.top 与 scrollTop 无关
         （真 DOM 里对话区就贴在 .agent-body 顶部，页面本身不滚） */
      getBoundingClientRect() {
        return { top: 0, bottom: this.clientHeight };
      },
    };
    const build = (spec) => {
      list.children = spec.map((r) => ({
        className: "dsh-msg",
        classList: { contains: (c) => c === "dsh-msg" },
        dataset: { histKey: r.key },
        offsetHeight: r.h,
        _ctop: r.top,
        getBoundingClientRect() {
          const t = this._ctop - list.scrollTop;
          return { top: t, bottom: t + this.offsetHeight };
        },
      }));
    };
    build(rows);
    return { list, build };
  }
  function rowTop(list, key) {
    const r = list.children.find((x) => x.dataset.histKey === key);
    return r ? r.getBoundingClientRect().top : null;
  }

  /* 这套 helper 的真源：app.js 里逐行抠出来跑 */
  const SCROLL_FNS = [
    "convRows",
    "convScrollBase",
    "convRowTop",
    "convAnchorOf",
    "convAnchorRow",
    "convRestoreOff",
    "captureConvStick",
    "restoreConvStick",
    "setConvScrollTop",
    "convScrollGuardOn",
    "convStickOf",
    "markConvStick",
    "isScrollNearBottom",
  ];
  function loadScrollApi(rafQueue) {
    const code =
      constLine(APP, "CONV_SCROLL_SLACK") +
      constLine(APP, "CONV_STICK_SLACK") +
      SCROLL_FNS.map((n) => fnBody(APP, n)).join("\n") +
      "\n({ captureConvStick, restoreConvStick, setConvScrollTop, convScrollGuardOn," +
      " markConvStick, convAnchorOf, convAnchorRow, convRowTop, convScrollBase, convRows })";
    const sb = {
      console,
      getComputedStyle: () => ({ borderTopWidth: "0px" }),
      requestAnimationFrame: (fn) => {
        rafQueue.push(fn);
        return rafQueue.length;
      },
      bindConvStick: () => {},
    };
    vm.createContext(sb);
    return vm.runInNewContext(code, sb, { filename: "renderer/app.js#scroll" });
  }

  /* ==================== [2] 还原行为 ==================== */
  console.log("\n[2] 重绘后阅读位置不跳（键锚点，不按序号也不按比例）");
  {
    const raf = [];
    /* 视口 600px；四条消息；运行中用户上翻到 1500（m3 中段） */
    const g = mkList(
      [
        { key: "m1", top: 0, h: 800 },
        { key: "m2", top: 800, h: 600 },
        { key: "m3", top: 1400, h: 900 },
        { key: "m4", top: 2300, h: 700 },
      ],
      { top: 1500, clientHeight: 600, scrollHeight: 3000 },
    );
    const list = g.list;
    const api = loadScrollApi(raf);
    api.markConvStick(list, false); /* 用户上翻过：不贴底 */
    const beforeView = rowTop(list, "m3");
    ok(beforeView < 0 && beforeView > -600, "m3 在视口内（顶部偏移 " + beforeView + "）");
    const cap = api.captureConvStick(list, false);
    ok(!!cap.anchor && cap.anchor.key === "m3", "锚点 = 视口里最靠上的那条消息（m3）");

    /* 运行中：m3 上方的思考块长高 300px（下方内容整体下移），滚动容器高度不变 */
    g.build([
      { key: "m1", top: 0, h: 800 },
      { key: "m2", top: 800, h: 900 },
      { key: "m3", top: 1700, h: 900 },
      { key: "m4", top: 2600, h: 700 },
    ]);
    list.scrollHeight = 3300;
    list.clientHeight = 600;
    api.restoreConvStick(list, cap);
    const want = 1700 - beforeView; /* 锚点新顶 - 原视口偏移（offset = 视口位置） */
    ok(
      list.scrollTop === want,
      "锚点行在视口里的位置原样保持（还原到 " + want + "，实得 " + list.scrollTop + "）",
    );
    ok(
      rowTop(list, "m3") === beforeView,
      "锚点行相对视口的偏移与重绘前一致（" + beforeView + " → " + rowTop(list, "m3") + "）",
    );

    /* 再来一轮：锚点行自己的高度变了（markdown 落定），视口位置仍要原样 */
    const cap2 = api.captureConvStick(list, false);
    g.build([
      { key: "m1", top: 0, h: 800 },
      { key: "m2", top: 800, h: 900 },
      { key: "m3", top: 1700, h: 1400 },
      { key: "m4", top: 3100, h: 700 },
    ]);
    list.scrollHeight = 3800;
    api.restoreConvStick(list, cap2);
    ok(
      list.scrollTop === cap2.top,
      "锚点行在视口里的位置一字不差（" + cap2.top + "，实得 " + list.scrollTop + "）",
    );

    /* 高度没变时重绘：更不该动一下 */
    const cap3 = api.captureConvStick(list, false);
    g.build([
      { key: "m1", top: 0, h: 800 },
      { key: "m2", top: 800, h: 900 },
      { key: "m3", top: 1700, h: 1400 },
      { key: "m4", top: 3100, h: 700 },
    ]);
    api.restoreConvStick(list, cap3);
    ok(list.scrollTop === cap3.top, "同高度重绘不产生任何位移（仍为 " + list.scrollTop + "）");

    /* 可见窗口切片变化：锚点那条消息被裁到「更早内容」后面 → 原样回记录位置，
       绝不按比例缩放（旧口径会把 top 按新高速放大，画面往上跳） */
    const cap4 = {
      stick: false,
      top: 2000,
      prevH: 3000,
      anchor: { key: "m1", idx: 0, off: 100 },
    };
    g.build([
      { key: "m5", top: 0, h: 1200 },
      { key: "m6", top: 1200, h: 1200 },
      { key: "m7", top: 2400, h: 1200 },
    ]);
    list.scrollHeight = 3600;
    list.scrollTop = 2000;
    api.restoreConvStick(list, cap4);
    ok(
      list.scrollTop === 2000,
      "锚点不在窗口里 → 原样回记录位置（实得 " + list.scrollTop + "，比例口径会得到 2400）",
    );
    ok(
      api.convAnchorRow(list, cap4) === null,
      "锚点行不在重绘后的列表里时 convAnchorRow 明确返回 null（调用方走保守还原）",
    );
  }

  /* ==================== [3] 程序滚动守卫 ==================== */
  console.log("\n[3] 同帧内连续程序写入不提前解除守卫");
  {
    const raf = [];
    const g = mkList([{ key: "m1", top: 0, h: 2000 }], {
      clientHeight: 600,
      scrollHeight: 2000,
    });
    const list = g.list;
    const api = loadScrollApi(raf);
    const drainOne = () => {
      const fn = raf.shift();
      if (fn) fn();
    };
    ok(api.convScrollGuardOn(list) === false, "初始没在程序滚动");
    api.setConvScrollTop(list, 1200);
    ok(
      api.convScrollGuardOn(list) === true,
      "写入期间守卫成立（自己那笔 scroll 事件不算用户滚动）",
    );
    api.setConvScrollTop(list, 1400); /* 同一帧里第二笔（重绘后再落一次锚点） */
    drainOne(); /* 跑掉第一笔的回调 */
    ok(
      api.convScrollGuardOn(list) === true,
      "只跑掉第一笔的回调时守卫仍然成立（第二笔还没解锁）",
    );
    drainOne();
    ok(api.convScrollGuardOn(list) === false, "最后一笔的回调跑完才解锁");
    api.setConvScrollTop(list, 2000); /* 已在底部则浏览器夹住，但守卫仍要成立 */
    ok(api.convScrollGuardOn(list) === true, "再次写入重新上锁");
    drainOne();
    ok(api.convScrollGuardOn(list) === false, "解锁后回到可判定状态");
  }

  console.log(
    "\n" +
      (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全部通过") +
      "  (smoke-session-scroll-stable)",
  );

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-session-scroll-stable.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-session-scroll-stable.js：" + fails + " / " + checks + " 项失败");
})();

/* ==================== 已并入：test/smoke-session-wrap.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-session-wrap.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

  const fs = require("fs");
  const path = require("path");

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
  /* 读源码并统一换行：CSS 在 Windows 工作区里常是 CRLF，锚点串按 \n 写就好 */
  const read = (rel) =>
    fs
      .readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8")
      .replace(/\r\n?/g, "\n");

  /* ==================== [1] 根因复现 ==================== */
  console.log("\n[1] vendor marked 的输出里块之间真的带换行");
  const { marked } = require("../renderer/vendor/marked.min.js");
  const mdOut = marked.parse(
    "第一段第一行\n第一段第二行\n\n- 列表项一\n- 列表项二\n\n最后一段",
    { gfm: true, breaks: true },
  );
  ok(mdOut.indexOf("</p>\n<ul>") >= 0, "段落与列表之间输出 `</p>\\n<ul>`（pre-wrap 下即空行）");
  ok(mdOut.indexOf("</li>\n<li>") >= 0, "列表项之间输出 `</li>\\n<li>`（pre-wrap 下即多撑一行）");
  ok(mdOut.indexOf("<br>") >= 0, "段内单个换行由 breaks:true 发成 <br>（不依赖 pre-wrap）");

  /* ==================== [2] 修复点 ==================== */
  console.log("\n[2] .md 基础规则把空白归位 normal");
  const cssCanvas = read("renderer/css/canvas.css");
  const mdRuleAt = cssCanvas.indexOf("\n.md {");
  ok(mdRuleAt >= 0, "canvas.css 里能找到 .md 基础规则（Markdown 渲染一节）");
  const mdRule = mdRuleAt >= 0 ? cssCanvas.slice(mdRuleAt, cssCanvas.indexOf("}", mdRuleAt) + 1) : "";
  ok(/white-space:\s*normal/.test(mdRule), ".md 显式 white-space: normal（块间换行不再被渲染）");
  ok(
    mdRule.indexOf("pre-wrap") >= 0 && mdRule.indexOf("breaks:true") >= 0,
    ".md 规则注释写清根因（容器 pre-wrap 被继承）与段内换行的真正来源（breaks:true）",
  );

  /* ==================== [3] 全仓 CSS 扫描 ==================== */
  console.log("\n[3] 没有任何 .md 自身规则把空白保留又打开");
  const cssDir = path.join(__dirname, "..", "renderer", "css");
  const cssFiles = fs
    .readdirSync(cssDir)
    .filter((f) => f.endsWith(".css"))
    .map((f) => ["renderer/css/" + f, read("renderer/css/" + f)]);
  ok(cssFiles.length >= 5, "扫到 renderer/css 全套样式表（" + cssFiles.length + " 份）");
  function* rulesOf(src) {
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(src))) yield { sel: m[1], body: m[2] };
  }
  let mdSelfRules = 0;
  let mdPreWrapRules = [];
  for (const [rel, src] of cssFiles) {
    const clean = src.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const r of rulesOf(clean)) {
      const targetsMd = r.sel
        .split(",")
        .map((s) => s.replace(/\s+/g, " ").trim())
        .some((s) => /(^|[\s>+~])\.md$/.test(s));
      if (!targetsMd) continue;
      mdSelfRules++;
      if (/white-space:\s*(pre|pre-wrap|pre-line)/.test(r.body)) mdPreWrapRules.push(rel);
    }
  }
  ok(mdSelfRules >= 6, "扫到多条针对 .md 自身的规则（含亮色主题与节点内压缩版：" + mdSelfRules + " 条）");
  ok(mdPreWrapRules.length === 0, "全部 .md 自身规则里没有任何 white-space: pre*（回归清单：" + mdPreWrapRules.join(", ") + "）");

  /* ==================== [4] 零误伤：流式纯文本容器 ==================== */
  console.log("\n[4] 流式未渲染正文仍保留换行");
  const cssDsh = read("renderer/css/dsh.css");
  const containers = [
    [".dsh-msg-body", cssDsh],
    [".dsh-seg-say", cssDsh],
    [".chat-bubble", cssCanvas],
  ];
  for (const [sel, src] of containers) {
    const at = src.indexOf("\n" + sel + " {");
    const body = at >= 0 ? src.slice(at, src.indexOf("}", at) + 1) : "";
    ok(/white-space:\s*pre-wrap/.test(body), sel + " 仍是 pre-wrap（纯文本 / 流式原文的换行照旧）");
  }
  /* 智能节点实时输出：元素同时挂了 .md（只为排版）与 dsh-out-live（装的是未渲染原文）
     —— 这条更-specific 的规则必须还在，否则本次修复会把节点实时输出的换行吃掉 */
  ok(
    /\.n-out \.dsh-out-live\s*\{[^}]*white-space:\s*pre-wrap/.test(cssDsh),
    ".n-out .dsh-out-live 仍以 pre-wrap 压过 .md（节点实时原文不被归位 normal 误伤）",
  );
  ok(
    read("renderer/app-canvas.js").indexOf('className = "md dsh-out-live"') >= 0,
    "该元素确实带着 .md 类（正是需要被更-specific 规则保护的那一个）",
  );

  /* ==================== [5] 会话 markdown 落点 ==================== */
  console.log("\n[5] 会话正文的 markdown 都装在 .md 里");
  const assist = read("renderer/app-assist.js");
  ok(
    (assist.match(/className = "md"/g) || []).length >= 2,
    "分段正文段（dsh-seg-say）与历史段渲染都各自套一层 .md",
  );
  ok(
    /<div class="md">' \+ renderMarkdown/.test(assist),
    "旧整条渲染（无分段轨迹时）也走 .md —— 本次修复对两条路径同时生效",
  );
  ok(
    read("renderer/app.js").indexOf('doc.className = "md-viewer-doc md"') >= 0,
    "应用内 Markdown 阅读器也带 .md 类（同款换行口径）",
  );

  /* ==================== [6] breaks:true ==================== */
  console.log("\n[6] renderMarkdown 仍按聊天口径转义并换行");
  const appjs = read("renderer/app.js");
  const rmAt = appjs.indexOf("function renderMarkdown(text)");
  const rmBody = rmAt >= 0 ? appjs.slice(rmAt, appjs.indexOf("\n}\n", rmAt)) : "";
  ok(rmBody.indexOf("breaks: true") >= 0, "renderMarkdown 保持 breaks:true（否则用户单回车真的会消失）");
  ok(rmBody.indexOf("escapeHtml(text)") >= 0, "renderMarkdown 先转义 HTML（渲染口径未被这次改动带偏）");

  /* ==================== [7] 节点浏览视图 ==================== */
  console.log("\n[7] 节点只读视图：只有 yaml / plain 内联 pre-wrap");
  const nodeview = read("renderer/app-nodeview.js");
  const mdBranch = nodeview.slice(
    nodeview.indexOf('if (lang === "md")'),
    nodeview.indexOf('body.className = "ntv-plain"'),
  );
  ok(mdBranch.length > 0, "切到节点视图的 md 分支源码");
  ok(mdBranch.indexOf("whiteSpace") < 0, "md 分支不设内联 white-space（交给 CSS，不复活 pre-wrap）");
  ok(
    nodeview.indexOf('pre.style.whiteSpace = "pre-wrap"') >= 0 &&
      nodeview.indexOf('body.style.whiteSpace = "pre-wrap"') >= 0,
    "yaml / plain 分支仍显式保留换行（它们装的是纯文本，不是 markdown）",
  );

  console.log(
    "\n" +
      (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全部通过") +
      "  (smoke-session-wrap)",
  );

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-session-wrap.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-session-wrap.js：" + fails + " / " + checks + " 项失败");
})();

/* ==================== 已并入：test/smoke-session-styling.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-session-styling.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

  "use strict";
  const fs = require("node:fs");
  const path = require("node:path");

  let pass = 0;
  let fail = 0;
  function ok(cond, label) {
    if (cond) {
      pass++;
      console.log("  ✓ " + label);
    } else {
      fail++;
      console.log("  ✗ " + label);
    }
  }

  const ROOT = path.resolve(__dirname, "..");
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

  console.log("session-styling smoke");

  /* ── [1] 令牌文件与装配顺序 ─────────────────────────────────────────────── */
  const tokensPath = "renderer/css/dsh-tokens.css";
  ok(fs.existsSync(path.join(ROOT, tokensPath)), "[1] " + tokensPath + " 存在");
  const tokens = read(tokensPath);
  ok(/--dsh-pane-bg\s*:/.test(tokens), "[1] 定义了 --dsh-* 语义令牌");
  ok(/var\(--bg2\)/.test(tokens) && /var\(--ink\)/.test(tokens), "[1] 令牌值引用 base.css 的主题槽位（暗/亮同源，不写死 hex）");
  ok(/\.dsh-view-tabs/.test(tokens) && /\.dsh-view-tab\b/.test(tokens), "[1] View 标签栏样式在位");
  ok(/\.dsh-trace-list/.test(tokens) && /\.dsh-trace-row/.test(tokens), "[1] 轨迹列表样式在位");
  ok(/\.dsh-trace-detail/.test(tokens) && /\[open\]/.test(tokens), "[1] 工具调用可展开详情样式在位");
  ok(/\.dsh-trace-col/.test(tokens) && /position:\s*absolute/.test(tokens), "[1] 轨迹栏压在第三栏（绝对定位，与浏览器活动互斥）");
  /* 亮色不加特例：令牌引用槽位，theme-light 重定义槽位即可（有特例就说明又写死了颜色） */
  ok(!/theme-light/.test(tokens), "[1] 令牌文件里没有亮色特例（亮色靠槽位重定义，不再逐条补覆盖）");

  const style = read("renderer/style.css");
  const iDsh = style.indexOf("./css/dsh.css");
  const iTokens = style.indexOf("./css/dsh-tokens.css");
  const iAssist = style.indexOf("./css/assist.css");
  ok(iTokens > 0, "[1] style.css 引入了 dsh-tokens.css");
  ok(iDsh >= 0 && iTokens > iDsh && iAssist > iTokens, "[1] 装配顺序：dsh.css → dsh-tokens.css → assist.css");

  /* ── [2] 会话「对话 / 轨迹」View 的接线（本次需求：轨迹从右栏升为主区第二个 View）───── */
  const html = read("renderer/index.html");
  ok(/<script src="app-trajectory\.js"><\/script>/.test(html), "[2] index.html 引入了 app-trajectory.js");
  const iBrowser = html.indexOf('<script src="app-browser.js"></script>');
  const iTraj = html.indexOf('<script src="app-trajectory.js"></script>');
  ok(iBrowser >= 0 && iTraj > iBrowser, "[2] 排在 app-browser.js 之后（与它同一段装配，互不侵入）");

  const traj = read("renderer/app-trajectory.js");
  ok(/window\.MTNodeTrajectory\s*=/.test(traj), "[2] 导出 window.MTNodeTrajectory");
  ok(/agentTraceItems|agentChatSegItems/.test(traj), "[2] 只读 app-assist.js 已有的轨迹段数据（不新增会话接口）");
  ok(/data-seg-idx|dataset\.segIdx/.test(traj), "[2] 轨迹↔对话双向定位用对话区自己的段编号（dataset.segIdx）");
  ok(/developerTools\s*!==\s*false/.test(traj), "[2] 检查器受 developerTools 开关约束（缺配置 = 默认开）");
  ok(/trajView/.test(traj) && !/ba-open/.test(traj), "[2] 视图选择落在会话语义上（st.trajView），不再借右栏 .ba-open");
  ok(
    /tabsEl\.className = "dsh-view-tabs agent-view-tabs"/.test(traj) && /"对话"[\s\S]{0,120}?"轨迹"/.test(traj),
    "[2] 会话头部「对话 / 轨迹」两枚标签（复用 dsh-tokens 的 .dsh-view-tabs 皮）",
  );
  ok(
    /dsh-trace-ruler/.test(traj) && /dsh-trace-insp/.test(traj),
    "[2] 主区轨迹 = 窗口横轴 + 记录表 + 检查器（本轮撤掉列表外那条总时间轴后只剩这一条轴）",
  );
  ok(/fileviewHighlight/.test(traj), "[2] 检查器的代码块复用右侧文件面板的词法高亮（行号 + 着色，不另起一套）");

  /* ── [3] 设置项与缺省 ───────────────────────────────────────────────────── */
  const boot = read("renderer/app-boot.js");
  ok(/developerTools:\s*true/.test(boot), "[3] 配置缺省 developerTools: true（默认开）");
  const settings = read("renderer/app-settings.js");
  ok(/developerTools/.test(settings) && /devCb\.type\s*=\s*"checkbox"/.test(settings), "[3] 设置页有开发者工具开关");
  ok(/developerTools:\s*dshEls\.developerTools/.test(settings), "[3] 开关进 collect()（关窗写盘不丢值）");
  ok(/developerTools:\s*true/.test(settings), "[3] finalizeSettings 的缺省合并里有该键");
  const i18n = read("renderer/i18n.js");
  ok(/开发者工具（会话右栏「运行轨迹」视图/.test(i18n), "[3] 设置项有中英词条（i18n）");
  ok(/Developer tools \(a Run trajectory view/.test(i18n), "[3] 英文词条在位");

  /* ── [4] 版本（0.2 内核）口径仍钉住 ─────────────────────────────────────── */
  const pkg = JSON.parse(read("dsh/gateway/package.json"));
  ok(pkg.dependencies["@deepseek-ai/dsh"] === "0.2.0-rc.2", "[4] 网关仍锁 0.2.0-rc.2");
  ok(String(pkg.dependencies["@deepseek-ai/cordis"]).startsWith("4."), "[4] cordis 仍在 4.x 线");

  console.log("\nsession-styling smoke: pass " + pass + " / fail " + fail);

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-session-styling.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-session-styling.js：" + fails + " / " + checks + " 项失败");
})();

/* 收尾：正文与并入块任一失败都算这只红；退出码只在全部跑完之后才定 */
if (MERGED_FAILED) console.log("\n✗ 本文件有失败项（含已并入块）\n");
process.exit(MERGED_FAILED ? 1 : 0);
