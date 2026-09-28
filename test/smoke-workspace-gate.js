"use strict";
/* 画布工作目录闸门 —— 冒烟测试（纯 Node：主进程 handler + 渲染层真实源码切片进 vm 沙箱，不依赖 Electron）
 *   node test/smoke-workspace-gate.js
 *
 * 需求口径：
 *   当画布工作目录无效或未填写时，任何画布行为都要弹窗要求用户填写；
 *   用户填了一个不存在的路径时，先询问是否新建文件夹，确认时新建；
 *   用户也可以在文件夹选择界面里新建（对话框 createDirectory / 系统窗口自带「新建文件夹」）。
 *
 * 被测：
 *   main.js                file:mkdir handler（幂等 / 同名文件拒绝 / recursive 建整条路径）
 *                          file:openDialog 的 directory 分支带 createDirectory
 *   preload.js             window.api.fileMkdir 桥
 *   renderer/app.js        createFolderPath / pickFolderDialogPath / chooseWorkspaceFolderDialog
 *   renderer/app-nodes.js  WS_GATE_LABEL / workspaceIssueOf(Node) / resolveWorkspaceIssue /
 *                          ensureRunWorkspace（并发去重）/ playUserNode / playControlNode 前置闸
 *   renderer/app-canvas.js 用户入口改走 playUserNode（▶ / 保存 / 闸门），控制节点 ▶ 保留 playControlNode
 */
const fs = require("fs");
const os = require("os");
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
const HAS = (src, needle, msg) =>
  ok(src.indexOf(needle) >= 0, msg + (src.indexOf(needle) >= 0 ? "" : "\n        缺：" + needle));

/* 大括号配对切出完整函数（含 async 前缀）；找不到返回 "" */
function fnBody(src, name) {
  const m = new RegExp("(?:async\\s+)?function\\s+" + name + "\\s*\\(").exec(src);
  if (!m) return "";
  let k = src.indexOf("{", m.index);
  let d = 0;
  for (; k < src.length; k++) {
    if (src[k] === "{") d++;
    else if (src[k] === "}") {
      d--;
      if (!d) return src.slice(m.index, k + 1);
    }
  }
  return "";
}

const MAIN = read("main.js");
const PRELOAD = read("preload.js");
const APP = read("renderer/app.js");
const NODES = read("renderer/app-nodes.js");
const CANVAS = read("renderer/app-canvas.js");

/* 每个测试节是一个 async 函数：整个文件保持 CommonJS（不能用顶层 await，
   否则 Node 会按 ESM 解析本文件 → require 直接报错）。 */
const SECTIONS = [];
const SECTION = (name, fn) => SECTIONS.push([name, fn]);

/* ══════════════ [1] 主进程：建文件夹能力 ══════════════ */
SECTION("file:mkdir", () => {
  /* 把 handler 从 main.js 里切出来真跑（require 换成桩，不动 Electron） */
  const i = MAIN.indexOf('ipcMain.handle("file:mkdir"');
  const j = MAIN.indexOf('ipcMain.handle("file:stat"', i);
  ok(i > 0 && j > i, "定位到 file:mkdir handler");
  const src = i > 0 ? MAIN.slice(i, j) : "";
  const handlers = {};
  const sb = {
    ipcMain: {
      handle: (name, fn) => {
        handlers[name] = fn;
      },
    },
    fs,
    I18n: { t: (k) => String(k) },
  };
  vm.runInContext(src, vm.createContext(sb), { filename: "main.js#mkdir" });
  const mkdir = handlers["file:mkdir"];
  ok(typeof mkdir === "function", "file:mkdir 注册成功");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-wsg-"));
  const deep = path.join(tmp, "a", "b", "c");
  const r1 = mkdir(null, deep);
  ok(r1.ok === true && r1.existed === false, "不存在的深层路径 → 新建成功（recursive 补齐父级）");
  ok(fs.existsSync(deep) && fs.statSync(deep).isDirectory(), "落盘确认：整条路径都建出来了");
  const r2 = mkdir(null, deep);
  ok(r2.ok === true && r2.existed === true, "已存在且是目录 → 幂等成功（existed:true）");
  const fileAt = path.join(tmp, "afile");
  fs.writeFileSync(fileAt, "x");
  const r3 = mkdir(null, fileAt);
  ok(r3.ok === false && !!r3.error, "命中同名文件 → 失败（绝不覆盖）");
  const r4 = mkdir(null, "   ");
  ok(r4.ok === false, "空路径 → 失败（不猜目录）");
  fs.rmSync(tmp, { recursive: true, force: true });
});

/* ══════════════ [2] 文件夹选择界面允许新建 ══════════════ */
SECTION("文件选择对话框", () => {
  const i = MAIN.indexOf('ipcMain.handle("file:openDialog"');
  const j = MAIN.indexOf('ipcMain.handle("shell:showItem"', i);
  const src = i > 0 && j > i ? MAIN.slice(i, j) : "";
  ok(src.length > 0, "定位到 file:openDialog handler");
  HAS(src, '"openDirectory", "createDirectory"', "directory 单选带 createDirectory（macOS 等价「新建文件夹」）");
  HAS(src, '"openDirectory", "multiSelections", "createDirectory"', "directory 多选同样带 createDirectory");
  HAS(PRELOAD, "fileMkdir: (p) => ipcRenderer.invoke('file:mkdir', p)", "preload 暴露 window.api.fileMkdir（渲染层建目录的唯一入口）");
  HAS(APP, "directory: true", "app.js 选目录走 fileOpenDialog directory 分支");
  HAS(APP, "await window.api.fileOpenDialog", "闸门窗的「浏览…」走同一个系统对话框（在里面可新建）");
});

/* ══════════════ [3] 弹窗：填 / 建 / 选 ══════════════ */
SECTION("弹窗源码口径", () => {
  HAS(APP, "function createFolderPath(", "createFolderPath（建目录）存在");
  HAS(APP, "function pickFolderDialogPath(", "pickFolderDialogPath（系统选目录）存在");
  HAS(APP, "function chooseWorkspaceFolderDialog(", "chooseWorkspaceFolderDialog 存在");
  const DLG = fnBody(APP, "chooseWorkspaceFolderDialog");
  HAS(DLG, "openOverlay(", "用 #overlay 弹窗承载");
  HAS(DLG, "{ persistent: true, min: false }", "带输入的浮层 persistent（禁止点外部即关）+ 不做最小化");
  HAS(DLG, "await confirmDialog(", "路径不存在时先弹确认（询问是否新建）");
  HAS(DLG, "await createFolderPath(v)", "确认后才真建");
  HAS(DLG, "await pathIsExistingDir(v)", "确定时按现场判定：有效目录直接用");
  HAS(DLG, "await window.api.fileExists(v)", "命中同名文件 → 窗内报错（不覆盖、不关窗）");
  HAS(DLG, 'I18n.t("新建文件夹")', "确认框标题写明是在新建文件夹");
  HAS(DLG, "浏览…", "窗里有「浏览…」（系统窗口里可新建）");
  HAS(DLG, "const guard = setInterval(", "✕ / Esc 关窗也能让等待方结算（不留悬挂 Promise）");
  const CP = fnBody(APP, "createFolderPath");
  HAS(CP, "window.api.fileMkdir", "建目录走主进程 file:mkdir");
  HAS(CP, 'joinPath(s, ".mtnode-ws")', "老宿主兜底：写哨兵文件连带建目录");
  HAS(APP, "workspaceBrowseButton(wsInp)", "新建画布弹窗的目录行用同一个选择器");
});

/* ══════════════ [4] 渲染层闸门真跑（源码切片进 vm） ══════════════ */
const PICK = { mode: "cancel", value: "" };
let DIALOGS = 0;
const TOASTS = [];
const SAVES = { n: 0 };
const RENDER = { n: 0 };
let DIRS = {};
const D1 = "D:/proj/ok";
const D2 = "D:/proj/missing";

const GATE_SRC = [
  NODES.slice(
    NODES.indexOf("const WS_GATE_LABEL = {"),
    NODES.indexOf("async function playNode(node, quiet, opts) {"),
  ),
  fnBody(NODES, "playUserNode"),
].join("\n");

function makeGateSandbox(opts) {
  const o = opts || {};
  const wf = { nodes: [], workspace: o.canvasWorkspace === undefined ? "" : o.canvasWorkspace };
  const sb = {
    console,
    Promise,
    S: { wf },
    I18n: {
      t: (k, vars) =>
        String(k).replace(/\{(\w+)\}/g, (_, n) => (vars && vars[n] != null ? String(vars[n]) : "")),
    },
    /* 目录有效性：沙箱里用一张清单模拟磁盘（不碰真磁盘） */
    pathIsExistingDir: (p) => Promise.resolve(!!DIRS[String(p || "").trim()]),
    wfWorkspace: () => String(wf.workspace || ""),
    dshWsOf: (n) => (n && (n.agentWorkspace || n.workspace)) || "",
    setDshWs: (n, v) => {
      if (n) n.agentWorkspace = v;
    },
    scheduleSave: () => {
      SAVES.n++;
    },
    renderCanvas: () => {
      RENDER.n++;
    },
    toast: (m) => TOASTS.push(m),
    chooseWorkspaceFolderDialog: () => {
      DIALOGS++;
      return Promise.resolve(PICK.mode === "pick" ? PICK.value : "");
    },
    isSaveNode: (n) => !!(n && String(n.kind || "").startsWith("save")),
    saveNodeAction: (n, o2) => {
      sb.SAVED.push({ id: n.id, opts: o2 || null });
      return Promise.resolve("saved");
    },
    playNode: (n, quiet, o2) => {
      sb.PLAYED.push({ id: n.id, quiet, opts: o2 || null });
      return Promise.resolve("played");
    },
    PLAYED: [],
    SAVED: [],
  };
  vm.runInContext(GATE_SRC, vm.createContext(sb), { filename: "app-nodes.js#ws-gate" });
  return sb;
}
const ex = (sb, expr) => vm.runInContext(expr, sb);

SECTION("闸门真跑", async () => {
  /* ---- [4.1] 目录有效 → 不弹窗、直接放行 ---- */
  DIRS = { [D1]: true };
  DIALOGS = 0;
  let sb = makeGateSandbox({ canvasWorkspace: D1 });
  let dir = await ex(sb, "ensureRunWorkspace(null)");
  ok(dir === D1, "目录有效 → 返回该目录");
  ok(DIALOGS === 0, "目录有效 → 一个弹窗都不弹");
  let issue = await ex(sb, "workspaceIssueOf()");
  ok(issue.ok === true && issue.none === false, "现场标记 ok（非 none / 非 missing）");

  /* ---- [4.2] 目录空 → 弹窗要求填写 ---- */
  DIRS = {};
  DIALOGS = 0;
  sb = makeGateSandbox({ canvasWorkspace: "" });
  issue = await ex(sb, "workspaceIssueOf()");
  ok(issue.none === true && issue.ok === false, "未填写 → 现场标 none");
  PICK.mode = "pick";
  PICK.value = D1;
  dir = await ex(sb, "ensureRunWorkspace(null)");
  ok(DIALOGS === 1, "未填写 → 弹一次「请填写工作目录」");
  ok(dir === D1, "用户填/选了有效目录 → 闸门放行并回该目录");

  /* ---- [4.3] 用户放弃 → 空串（调用方据此不起跑） ---- */
  DIRS = {};
  DIALOGS = 0;
  sb = makeGateSandbox({ canvasWorkspace: "" });
  PICK.mode = "cancel";
  dir = await ex(sb, "ensureRunWorkspace(null)");
  ok(dir === "", "用户取消 → 回空串（放行失败）");
  ok(DIALOGS === 1, "只弹一次，不反复骚扰");

  /* ---- [4.4] 目录填错（被删 / 打错）→ 一样弹窗，预填错的那条 ---- */
  DIRS = { [D1]: true };
  DIALOGS = 0;
  sb = makeGateSandbox({ canvasWorkspace: D2 });
  issue = await ex(sb, "workspaceIssueOf()");
  ok(issue.missing === true && issue.raw === D2, "填了但不存在 → 现场标 missing 并带原值");
  PICK.mode = "pick";
  PICK.value = D1;
  dir = await ex(sb, "ensureRunWorkspace(null)");
  ok(dir === D1, "改填成有效目录后放行");

  /* ---- [4.5] 节点自带目录优先；没有手填才回画布口径；写回落在正确那一层 ---- */
  DIRS = { [D1]: true };
  DIALOGS = 0;
  sb = makeGateSandbox({ canvasWorkspace: "" });
  const n1 = { id: "n1", kind: "proc_text", agentWorkspace: D1 };
  issue = await ex(sb, "workspaceIssueOfNode(" + JSON.stringify(n1) + ")");
  ok(issue.ok === true && issue.label === "节点工作目录", "节点手填了有效目录 → 节点口径、标记 ok");
  dir = await ex(sb, "ensureRunWorkspace(" + JSON.stringify(n1) + ")");
  ok(dir === D1 && DIALOGS === 0, "画布目录空但节点自己有 → 不弹窗（不无谓打断）");
  const n2 = { id: "n2", kind: "proc_text" };
  const issue2 = await ex(sb, "workspaceIssueOfNode(" + JSON.stringify(n2) + ")");
  ok(issue2.none === true && issue2.label === "画布工作目录", "节点没手填 → 回落画布口径（统一问）");

  /* 画布本来没有统一目录：用户填的目录落在**画布**这一层（后面别的节点不用再逐个问） */
  PICK.mode = "pick";
  PICK.value = "D:/hand/pick";
  DIRS["D:/hand/pick"] = true;
  const n3 = { id: "n3", kind: "proc_text" };
  const before = SAVES.n + RENDER.n;
  const dir3 = await ex(sb, "ensureRunWorkspace(" + JSON.stringify(n3) + ")");
  ok(dir3 === "D:/hand/pick", "闸门回用户填的目录");
  ok(sb.S.wf.workspace === "D:/hand/pick", "画布本来没目录 → 写回画布统一目录");
  ok(n3.agentWorkspace === undefined, "不往节点字段多存一份（画布统一目录是单一真源）");
  ok(SAVES.n + RENDER.n > before, "写回后落盘 + 重绘（用户马上能看到）");

  /* 画布已有有效目录、只是这个节点手填的那条失效了：只改这个节点，不动画布设置 */
  DIRS = { [D1]: true };
  DIALOGS = 0;
  sb = makeGateSandbox({ canvasWorkspace: D1 });
  const n4 = { id: "n4", kind: "proc_text", agentWorkspace: D2 };
  /* 把节点放进沙箱上下文里按引用用：JSON 字面量会被 vm 克隆，写回就看不见了 */
  sb.NODE = n4;
  const issue4 = await ex(sb, "workspaceIssueOfNode(NODE)");
  ok(issue4.missing === true && issue4.label === "节点工作目录", "节点手填的目录失效 → 节点现场标 missing");
  PICK.mode = "pick";
  PICK.value = "D:/node/ok";
  DIRS["D:/node/ok"] = true;
  dir = await ex(sb, "ensureRunWorkspace(NODE)");
  ok(n4.agentWorkspace === "D:/node/ok", "节点现场选的目录写回节点（agentWorkspace）");
  ok(sb.S.wf.workspace === D1, "画布那层没被改掉（节点问题只改节点）");
  ok(dir === "D:/node/ok", "闸门回节点的新目录");

  /* ---- [4.6] 并发去重：一批 N 个下游只问一次 ---- */
  DIRS = { [D1]: true };
  DIALOGS = 0;
  sb = makeGateSandbox({ canvasWorkspace: "" });
  PICK.mode = "pick";
  PICK.value = D1;
  const p1 = ex(sb, "ensureRunWorkspace(null)");
  const p2 = ex(sb, "ensureRunWorkspace(null)");
  ok(p1 === p2, "同一轮重入拿到同一个 Promise（不叠弹窗、不各问一次）");
  const both = await Promise.all([p1, p2]);
  ok(both[0] === D1 && both[1] === D1, "并发调用都拿到同一个目录");
  ok(DIALOGS === 1, "一批 N 个下游只弹一次");
  ok(ex(sb, "S._wsGate") === null, "结算后清掉在途句柄（下一批能重新问）");

  /* ---- [4.7] playUserNode：放弃不起跑；保存节点走保存；普通节点走 playNode ---- */
  DIRS = { [D1]: true };
  DIALOGS = 0;
  sb = makeGateSandbox({ canvasWorkspace: D1 });
  await ex(sb, "playUserNode({ id: 'p1', kind: 'proc_text' })");
  ok(sb.PLAYED.length === 1 && sb.PLAYED[0].quiet === false, "普通节点：过闸后以 quiet=false 起跑");
  await ex(sb, "playUserNode({ id: 's1', kind: 'save_text' })");
  ok(
    sb.SAVED.length === 1 && sb.SAVED[0].opts.skipWsGate === true,
    "保存节点：走 saveNodeAction（带 skipWsGate，不重复问）",
  );
  ok(sb.PLAYED.length === 1, "保存节点不再落进 playNode（避免双跑）");

  DIRS = {};
  DIALOGS = 0;
  sb = makeGateSandbox({ canvasWorkspace: "" });
  TOASTS.length = 0;
  PICK.mode = "cancel";
  await ex(sb, "playUserNode({ id: 'p2', kind: 'proc_text' })");
  ok(sb.PLAYED.length === 0, "用户放弃 → 节点不起跑");
  ok(
    TOASTS.some((m) => String(m).indexOf("已取消") >= 0),
    "放弃时给一句 toast 说明（不是静默无事发生）",
  );
});

/* ══════════════ [5] 接线契约：画布入口 / 控制节点 / 保存节点 ══════════════ */
SECTION("接线契约", async () => {
  const users = (CANVAS.match(/playUserNode\(node\);/g) || []).length;
  ok(users >= 10, "画布 ▶ 入口全部改走 playUserNode（找到 " + users + " 处）");
  ok(CANVAS.indexOf("playNode(node);") < 0, "画布上不再有裸 playNode(node) 漏网");
  ok(CANVAS.indexOf("saveNodeAction(node);") < 0, "保存节点的 ▶ 也过闸（不再直接调 saveNodeAction）");
  ok(CANVAS.indexOf("playGateNode(node, false);") < 0, "闸门 ▶ 过闸（不再直接放行）");
  HAS(CANVAS, "playControlNode(node);", "控制节点 ▶ 保留 playControlNode（闸门在它内部，避免双问）");
  const PCN = fnBody(NODES, "playControlNode");
  HAS(PCN, "if (!seen) {", "控制节点：只有用户直接点（无 seen）才过闸");
  HAS(PCN, "await ensureRunWorkspace(node)", "控制节点起跑前调闸门");
  const SNA = fnBody(NODES, "saveNodeAction");
  HAS(SNA, "if (!opts.skipWsGate) {", "保存节点：用户点过闸，内部叫起跳过");
  HAS(fnBody(NODES, "playUserNode"), "ensureRunWorkspace(node)", "playUserNode 起跑前调闸门");
  HAS(fnBody(NODES, "ensureRunWorkspace"), "S._wsGate", "并发去重句柄挂在 S 上（可复核）");

  HAS(APP, 'I18n.t("请填写工作目录")', "闸门弹窗标题有词条");
  HAS(APP, 'I18n.t("要新建它吗？")', "新建确认语有词条");
  HAS(APP, 'I18n.t("已新建工作目录：")', "新建成功有提示");
  HAS(APP, 'I18n.t("新建文件夹失败：")', "新建失败如实报错（含原因）");
});

(async () => {
  console.log("\n[1] 主进程 file:mkdir：幂等 · 拒绝同名文件 · recursive 建整条路径");
  console.log("\n[2] 文件夹选择对话框：三平台都能新建文件夹");
  console.log("\n[3] 「请填写工作目录」弹窗：不存在先问、确认才建、失败不关窗");
  console.log("\n[4] 闸门真跑：空 / 错 / 对 三种现场 · 并发去重 · 放弃不起跑");
  console.log("\n[5] 接线契约：用户入口都过闸，内部驱动不被拦");
  for (const [name, fn] of SECTIONS) {
    await fn(name);
  }
  console.log(
    "\n" +
      (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全部通过") +
      "  (smoke-workspace-gate)",
  );
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.log("FAIL  测试异常：" + ((e && e.stack) || e));
  process.exit(1);
});