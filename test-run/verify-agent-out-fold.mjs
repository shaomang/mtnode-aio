/**
 * 一次性真机自验：智能任务节点「选中态输出折叠区」的落位与宽度（2026-10 修复）
 *
 * 干什么：起一只**独立数据目录**的开发态实例（绝不碰用户那只），在它的画布里建两颗
 *   智能任务节点，用 MCP 的 mtnode_gui eval 在**真实渲染出来的 DOM** 上量几何：
 *     · 选中态（edit）· 预览态（browse）· 运行中（liveDsh，折叠区自动展开）
 *   并把「输出折叠区是主列的兄弟（右栏，坏）还是主列的子（整幅宽，好）」直接判出来。
 *
 * 跑法：node test-run/verify-agent-out-fold.mjs [--out <仓库外的目录>] [--keep]
 * 退出码：0 = 全部判据通过；1 = 有判据不通过或环境错误。
 *
 * 证据落点：<out>\verify-agent-out-fold-<ts>\{clean,logs,report.json}
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const require_ = createRequire(import.meta.url);

function argOf(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const KEEP = process.argv.includes("--keep");
const STAMP = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const OUT = path.resolve(
  argOf("--out", path.join(os.tmpdir(), "mtnode-verify-" + STAMP)),
);
const RUN = path.join(OUT, "verify-agent-out-fold-" + STAMP);
const DATA = path.join(RUN, "clean");
const LOG = path.join(RUN, "logs", "app.log");
fs.mkdirSync(path.dirname(LOG), { recursive: true });
fs.mkdirSync(DATA, { recursive: true });
const logStream = fs.createWriteStream(LOG, { flags: "w" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { ts: new Date().toISOString(), runDir: RUN, dataDir: DATA, steps: [], measurements: {}, ok: false };

function say(line) {
  process.stdout.write(line + "\n");
  logStream.write(line + "\n");
}

/* ── 起实例（照 scripts/e2e-mcp-inchanged.mjs 的现场纪律） ─────────────────── */
function launchApp() {
  const bin = require_("electron");
  const env = { ...process.env, MTNODE_DATA_DIR: DATA };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(String(bin), [".", "--user-data-dir=" + DATA], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (d) => logStream.write("[out] " + d.toString()));
  child.stderr.on("data", (d) => logStream.write("[err] " + d.toString()));
  return child;
}

function killApp(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === "win32")
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    else child.kill("SIGTERM");
  } catch (_) {}
}

/* ── MCP：从数据目录的 mcp-server.json 直连 /ctl ──────────────────────────── */
function findState() {
  for (const d of [DATA, path.join(DATA, "pipeline-console")]) {
    const p = path.join(d, "mcp-server.json");
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  }
  return null;
}
async function ctl(state, method, params) {
  const res = await fetch("http://127.0.0.1:" + state.port + "/ctl", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + state.token },
    body: JSON.stringify({ method, params }),
  });
  return JSON.parse(await res.text());
}
async function guiEval(state, expression) {
  const rpc = await ctl(state, "tools/call", {
    name: "mtnode_gui",
    arguments: { action: "eval", which: "main", expression },
  });
  const r = rpc && rpc.result;
  const sc = r && r.structuredContent;
  if (sc && sc.ok === false) throw new Error(String(sc.error || "gui eval 失败"));
  return sc && "value" in sc ? sc.value : sc;
}
async function callTool(state, name, args) {
  const rpc = await ctl(state, "tools/call", { name, arguments: args || {} });
  const r = rpc && rpc.result;
  const sc = r && r.structuredContent;
  if (r && r.isError) throw new Error(JSON.stringify(sc || r).slice(0, 400));
  return sc || r;
}

/* ── 页面侧脚本 ──────────────────────────────────────────────────────────── */
const JS_FIXTURE = `(() => {
  const before = S.wf.nodes.length;
  const a = addNode("agent_task", 120, 120, { title: "几何探针A" });
  const b = addNode("agent_task", 760, 120, { title: "几何探针B" });
  a.w = 360; a.h = 300; a.convH = 120;
  b.w = 360; b.h = 300; b.convH = 120;
  renderCanvas();
  return JSON.stringify({ before, ids: [a.id, b.id], titles: [a.title, b.title] });
})()`;

const jsOut = (mode, id) => `(() => {
  const n = nodeById(${JSON.stringify(id)});
  if (!n) return JSON.stringify({ error: "node not found" });
  if (${JSON.stringify(mode)} === "live") {
    n.running = true;
    n.output = null; n.error = null; n.batchOutputs = null;
  } else if (${JSON.stringify(mode)} === "done") {
    n.running = false;
    n.output = { kind: "text", text: "探针输出\\n- 一行\\n- 两行" };
  } else {
    n.running = false;
    n.output = null; n.error = null; n.batchOutputs = null;
  }
  renderCanvas();
  const el = document.querySelector('.wf-node[data-nid="' + n.id + '"]');
  if (!el) return JSON.stringify({ error: "element not found" });
  const f = el.querySelector(".n-agent-out");
  if (f) f.open = true;
  return JSON.stringify({ outKind: n.output ? n.output.kind : (n.running ? "running" : "none"), w: n.w, h: n.h });
})()`;

const jsSelect = (id, on) => `(() => {
  const n = nodeById(${JSON.stringify(id)});
  if (!n) return JSON.stringify({ error: "node not found" });
  const el = document.querySelector('.wf-node[data-nid="' + n.id + '"]');
  if (${on ? "true" : "false"}) {
    S.selSet = new Set([n.id]); S.sel = n.id; S.selMark = null;
    /* 与真实点选同一条路：先就地刷形态（sel class + browse/edit），再兜一道形态刷新 ——
       只改 S.selSet 不刷形态会留在 browse 里，折叠区根本不会被装配。 */
    if (typeof applySelectionInPlace === "function") applySelectionInPlace([n.id]);
    if (typeof applyFocusFormAfterRender === "function") applyFocusFormAfterRender();
    if (typeof setNodeSelClass === "function") setNodeSelClass(el, n, true);
  } else {
    S.selSet = new Set(); S.sel = null;
    if (typeof setNodeSelClass === "function") setNodeSelClass(el, n, false);
    else if (el) { el.classList.remove("sel"); if (typeof applyNodeForm === "function") applyNodeForm(el, n); }
  }
  const el2 = document.querySelector('.wf-node[data-nid="' + n.id + '"]');
  const body = el2 ? el2.querySelector(":scope > .n-body") : null;
  return JSON.stringify({
    selected: ${on ? "true" : "false"},
    className: el2 ? el2.className : null,
    form: el2 && el2.dataset ? el2.dataset.nodeForm : null,
    bodyLen: body ? body.innerHTML.length : 0,
    hasFold: !!(el2 && el2.querySelector(".n-agent-out")),
  });
})()`;

const jsMeasure = (id) => `(() => {
  const n = nodeById(${JSON.stringify(id)});
  const el = document.querySelector('.wf-node[data-nid="' + n.id + '"]');
  const box = (e) => {
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return +r.width.toFixed(1);
  };
  const rect = (e) => {
    if (!e) return null;
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return {
      w: +r.width.toFixed(1), h: +r.height.toFixed(1),
      x: +r.left.toFixed(1), right: +r.right.toFixed(1),
      maxW: cs.maxWidth, disp: cs.display, flex: cs.flex, dir: cs.flexDirection,
    };
  };
  const fold = el.querySelector(".n-agent-out");
  const row = el.querySelector(".n-proc-row");
  const left = el.querySelector(".n-proc-left");
  const prompt = el.querySelector(".n-proc-left .n-prompt");
  const panel = el.querySelector(".n-agent-out .n-out");
  const head = el.querySelector(".n-agent-out-head");
  const btns = el.querySelector(".n-agent-out .n-out-btns");
  const nodeRect = el.getBoundingClientRect();
  const body = el.querySelector(".n-body");
  const bodyW = (() => {
    if (!body) return null;
    const cs = getComputedStyle(body);
    return +(body.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)).toFixed(1);
  })();
  return JSON.stringify({
    nodeW: +nodeRect.width.toFixed(1),
    bodyInnerW: bodyW,
    cam: { z: S.cam && S.cam.z },
    hasFold: !!fold,
    foldOpen: fold ? !!fold.open : null,
    fold: rect(fold), row: rect(row), left: rect(left), prompt: rect(prompt),
    panel: rect(panel), head: rect(head),
    btns: (() => { const r = btns ? btns.getBoundingClientRect() : null; return r ? { w: +r.width.toFixed(1), left: +r.left.toFixed(1), right: +r.right.toFixed(1) } : null; })(),
    foldParentIsRow: !!(fold && row && fold.parentElement === row),
    foldParentIsLeft: !!(fold && left && fold.parentElement === left),
    foldAfterPrompt: !!(fold && prompt && prompt.compareDocumentPosition(fold) & Node.DOCUMENT_POSITION_FOLLOWING),
    resizeHandleShown: (() => { const h = fold ? fold.querySelector(".n-out-resize") : null; return h ? getComputedStyle(h).display !== "none" : null; })(),
    outHeadCount: el.querySelectorAll(".n-agent-out .n-out-head").length,
    outBtnsCount: el.querySelectorAll(".n-agent-out .n-out-btns").length,
  });
})()`;

const jsRemove = (ids) => `(() => {
  const gone = [];
  for (const id of ${JSON.stringify(ids)}) {
    const n = nodeById(id);
    if (!n) continue;
    const i = S.wf.nodes.indexOf(n);
    if (i >= 0) S.wf.nodes.splice(i, 1);
    gone.push(id);
  }
  S.selSet = new Set(); S.sel = null;
  renderCanvas();
  return JSON.stringify({ removed: gone, nodes: S.wf.nodes.length });
})()`;

/* ── 判据 ────────────────────────────────────────────────────────────────── */
let fails = 0;
function check(name, cond, detail) {
  const ok = !!cond;
  if (!ok) fails++;
  report.steps.push({ name, ok, detail: detail == null ? "" : String(detail) });
  say((ok ? "  ok    " : "FAIL  ") + name + (detail ? "  ‹ " + detail + " ›" : ""));
}

function judge(m, phase) {
  report.measurements[phase] = m;
  if (!m || m.error) {
    check(phase + "：量测拿到了数据", false, JSON.stringify(m));
    return;
  }
  say("    " + phase + " 量测：" + JSON.stringify({
    nodeW: m.nodeW, bodyInnerW: m.bodyInnerW, foldW: m.fold && m.fold.w,
    leftW: m.left && m.left.w, promptW: m.prompt && m.prompt.w,
    panelW: m.panel && m.panel.w, headW: m.head && m.head.w,
    btns: m.btns, foldParentIsRow: m.foldParentIsRow, foldParentIsLeft: m.foldParentIsLeft,
    foldAfterPrompt: m.foldAfterPrompt, outHeadCount: m.outHeadCount,
  }));
  check(phase + "：折叠输出区挂在左侧列里（不是横向 row 的兄弟）", m.foldParentIsLeft && !m.foldParentIsRow,
    "parentIsLeft=" + m.foldParentIsLeft + " parentIsRow=" + m.foldParentIsRow);
  check(phase + "：折叠输出区在输入框下方（文档位次在后）", m.foldAfterPrompt);
  check(phase + "：折叠输出区是整幅宽（= 节点体内宽，误差 ≤ 2px）",
    m.fold && m.bodyInnerW && Math.abs(m.fold.w - m.bodyInnerW) <= 2,
    "fold=" + (m.fold && m.fold.w) + " body=" + m.bodyInnerW);
  check(phase + "：输出面板自己不再被挤窄（宽 > 面板最小宽 120）",
    m.panel && m.panel.w > 120, "panel=" + (m.panel && m.panel.w));
  check(phase + "：按钮组落在面板横向范围内（不是飘在面板右外侧）",
    m.btns && m.panel && m.btns.right <= m.panel.right + 1,
    "btnsRight=" + (m.btns && m.btns.right) + " panelRight=" + (m.panel && m.panel.right));
  check(phase + "：输出标题只有一行（面板本体不再重复 OUTPUT 行）", m.outHeadCount === 0,
    "面板内 .n-out-head 数=" + m.outHeadCount + "（宿主那行是 .n-agent-out-head）");
  check(phase + "：折叠区里的拖宽条已隐藏（宽度恒为节点宽）", m.resizeHandleShown === false,
    "resizeDisplay!==none? " + m.resizeHandleShown);
  check(phase + "：节点宽度 = 智能任务节点的类型下限 380（不再按右侧框抬到 546+）",
    m.nodeW <= 400, "nodeW=" + m.nodeW);
  check(phase + "：会话/输入列仍占整幅（left 宽 = 折叠区宽，误差 ≤ 2px）",
    m.left && m.fold && Math.abs(m.left.w - m.fold.w) <= 2,
    "left=" + (m.left && m.left.w) + " fold=" + (m.fold && m.fold.w));
}

/* ── 主流程 ──────────────────────────────────────────────────────────────── */
let child = null;
try {
  say("证据目录：" + RUN);
  child = launchApp();
  let state = null;
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    state = findState();
    if (state && state.port) break;
  }
  if (!state || !state.port) throw new Error("实例没起来 / mcp-server.json 里没有端口（日志见 " + LOG + "）");
  await sleep(3000);
  const health = await fetch("http://127.0.0.1:" + state.port + "/health").then((r) => r.json()).catch(() => null);
  report.mcp = { port: state.port, health };
  say("握手：port=" + state.port + " health=" + JSON.stringify(health));
  const tools = await ctl(state, "tools/list", {});
  const names = ((tools.result && tools.result.tools) || []).map((t) => t.name);
  check("握手：tools/list 里有 mtnode_gui", names.includes("mtnode_gui"), names.length + " 个工具");
  if (!names.includes("mtnode_gui")) throw new Error("没有 mtnode_gui，无法量测");

  const fx = JSON.parse(await guiEval(state, JS_FIXTURE));
  say("夹具：" + JSON.stringify(fx));
  const [A, B] = fx.ids;
  report.fixture = fx;

  /* ① 选中态 · 无输出（不应出现折叠区） */
  say("\n[1] 选中态 · 无输出");
  const s1 = JSON.parse(await guiEval(state, jsSelect(A, true)));
  say("    形态：" + JSON.stringify(s1));
  const m1 = JSON.parse(await guiEval(state, jsMeasure(A)));
  check("选中态 · 无输出：节点切到编辑态（dataset.nodeForm=edit、class 带 sel 且不带 browse）",
    s1.form === "edit" && /(^|\s)sel(\s|$)/.test(s1.className || "") && !/(^|\s)browse(\s|$)/.test(s1.className || ""),
    JSON.stringify(s1));
  check("选中态 · 无输出：还没有输出 ⇒ 不装配折叠区", s1.hasFold === false, "hasFold=" + s1.hasFold);

  /* ② 选中态 · 已有输出（折叠区展开 → 本次修复的主现场） */
  say("\n[2] 选中态 · 已有输出（折叠区展开）");
  const o2 = JSON.parse(await guiEval(state, jsOut("done", A)));
  say("    注入输出：" + JSON.stringify(o2));
  const s2 = JSON.parse(await guiEval(state, jsSelect(A, true)));
  say("    形态：" + JSON.stringify(s2));
  const m2 = JSON.parse(await guiEval(state, jsMeasure(A)));
  judge(m2, "选中态·有输出");

  /* ③ 预览态（未选中）· 同一颗节点：与选中态同一位次 */
  say("\n[3] 预览态（未选中）· 同一颗节点");
  const s3 = JSON.parse(await guiEval(state, jsSelect(A, false)));
  say("    形态：" + JSON.stringify(s3));
  const m3 = JSON.parse(await guiEval(state, jsMeasure(A)));
  judge(m3, "预览态·有输出");
  /* 两态的折叠区宽度不必逐像素相同：编辑态与浏览态节点的 body 左右内边距本就不同
     （浏览态更紧，见 smoke-node-browse-view [6]），所以口径是「各自等于本态的体内宽」。
     这里只断言量级一致（差 ≤ 8px），真正的判据是上面每条 「= 节点体内宽」。 */
  check("两态同版式：选中态与预览态的折叠区宽度量级一致（差 ≤ 8px）",
    Math.abs(m2.fold.w - m3.fold.w) <= 8, "edit=" + m2.fold.w + " browse=" + m3.fold.w + "（差 " + Math.abs(m2.fold.w - m3.fold.w).toFixed(1) + "px = 两态 body 内边距差）");
  check("两态同版式：两态的父容器判定一致（都在左侧列里）",
    m2.foldParentIsLeft === m3.foldParentIsLeft && m2.foldParentIsRow === m3.foldParentIsRow);

  /* ④ 运行中（liveDsh）：折叠区自动展开、节点不被撑宽 */
  say("\n[4] 选中态 · 运行中（liveDsh）");
  const o4 = JSON.parse(await guiEval(state, jsOut("live", A)));
  say("    运行态注入：" + JSON.stringify(o4));
  const s4 = JSON.parse(await guiEval(state, jsSelect(A, true)));
  say("    形态：" + JSON.stringify(s4));
  const m4 = JSON.parse(await guiEval(state, jsMeasure(A)));
  report.measurements["选中态·运行中"] = m4;
  say("    量测：" + JSON.stringify({ nodeW: m4.nodeW, foldOpen: m4.foldOpen, foldW: m4.fold && m4.fold.w, panelW: m4.panel && m4.panel.w, foldParentIsLeft: m4.foldParentIsLeft }));
  check("运行中：折叠区自动展开（liveDsh）", m4.foldOpen === true);
  check("运行中：折叠区仍是整幅宽且在左侧列里",
    m4.foldParentIsLeft && Math.abs(m4.fold.w - m4.bodyInnerW) <= 2,
    "fold=" + (m4.fold && m4.fold.w) + " body=" + m4.bodyInnerW);
  check("运行中：节点仍不被撑宽（≤ 400）", m4.nodeW <= 400, "nodeW=" + m4.nodeW);
  check("运行中：输出面板仍不窄于 120px", m4.panel && m4.panel.w > 120, "panel=" + (m4.panel && m4.panel.w));

  /* ⑤ 回归：另一颗节点（B）不受影响、仍是同一口径 */
  say("\n[5] 第二颗节点（B）同口径");
  await guiEval(state, jsSelect(B, true));
  await guiEval(state, jsOut("done", B));
  const m5 = JSON.parse(await guiEval(state, jsMeasure(B)));
  report.measurements["选中态·第二颗有输出"] = m5;
  check("第二颗节点同样整幅宽、挂左侧列",
    m5.foldParentIsLeft && !m5.foldParentIsRow && Math.abs(m5.fold.w - m5.bodyInnerW) <= 2,
    "fold=" + (m5.fold && m5.fold.w) + " body=" + m5.bodyInnerW);

  /* 收尾：清掉探针节点 + 关实例（--keep 才保留） */
  const cl = JSON.parse(await guiEval(state, jsRemove([A, B])));
  say("\n收尾：" + JSON.stringify(cl));
  check("收尾：探针节点已从画布删掉", cl.removed.length === 2 && cl.nodes === fx.before, JSON.stringify(cl));
  report.ok = fails === 0;
} catch (e) {
  fails++;
  report.error = String((e && e.stack) || e);
  say("ERROR " + report.error);
} finally {
  if (!KEEP) killApp(child);
  report.kept = KEEP;
  fs.writeFileSync(path.join(RUN, "report.json"), JSON.stringify(report, null, 2), "utf8");
  say("\n" + (fails === 0 ? "✓ 全部判据通过" : "✗ 有 " + fails + " 条判据未通过") + "（报告：" + path.join(RUN, "report.json") + "）");
  logStream.end();
}
process.exitCode = fails === 0 ? 0 : 1;
