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
const fs = require("fs");
const path = require("path");
const vm = require("vm");
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
  has(bodyOf(ASSIST, "persistAgentSession", "app-assist.js"), 'canvasWfId: s.canvasWfId || "",', "归属随会话落盘（重启后仍归它自己那张图）");

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
  process.exit(fails ? 1 : 0);
}
main().catch((err) => {
  console.log("\n测试异常：" + ((err && (err.stack || err.message)) || err));
  console.log("✗ 异常中止（已累计 " + fails + " / " + checks + " 项失败）");
  process.exit(1);
});
