/**
 * 一次性真机自验：智能任务节点「上下框之间那唯一一根 splitter」+ 框体互不重叠（2026-10 修复）
 *
 * 干什么：起一只**独立数据目录**的开发态实例（绝不碰用户那只），建一颗智能任务节点，
 *   用 MCP 的 mtnode_gui eval 在**真实渲染出来的 DOM** 上量几何：
 *     · 拖条（.vresize-handle）落在哪、是不是恰好夹在「上=会话框」与「下=输入框」之间；
 *     · 节点里是不是**只有这一根**拖条（会话框上沿不再有）；
 *     · 列内相邻框体两两不重叠、且都完整待在列（.n-proc-left）里（没有被顶出 / 压住）；
 *     · 把 convH 顶到历史上限 520、以及把节点拖矮到 300 时，上述两条仍然成立（实时夹取）。
 *
 * 跑法：node test-run/verify-agent-conv-splitter.mjs [--probe] [--out <目录>] [--keep]
 *   --probe：只量测、不判定（用来取「改前」现场）。
 * 退出码：0 = 全部判据通过；1 = 有判据不通过或环境错误。
 *
 * 证据落点：<out>\verify-agent-conv-splitter-<ts>\{clean,logs,report.json}
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
const PROBE = process.argv.includes("--probe");
const STAMP = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const OUT = path.resolve(
  argOf("--out", path.join(os.tmpdir(), "mtnode-verify-" + STAMP)),
);
const RUN = path.join(OUT, "verify-agent-conv-splitter-" + STAMP);
const DATA = path.join(RUN, "clean");
const LOG = path.join(RUN, "logs", "app.log");
fs.mkdirSync(path.dirname(LOG), { recursive: true });
fs.mkdirSync(DATA, { recursive: true });
const logStream = fs.createWriteStream(LOG, { flags: "w" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = {
  ts: new Date().toISOString(),
  mode: PROBE ? "probe" : "assert",
  runDir: RUN,
  dataDir: DATA,
  steps: [],
  measurements: {},
  ok: false,
};

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

/* ── 页面侧脚本 ──────────────────────────────────────────────────────────── */
const JS_FIXTURE = `(() => {
  const before = S.wf.nodes.length;
  const a = addNode("agent_task", 140, 140, { title: "分栏探针A" });
  const b = addNode("agent_task", 780, 140, { title: "分栏探针B" });
  a.w = 380; a.h = 380; a.convH = 200;
  b.w = 380; b.h = 380; b.convH = 200;
  a.output = { kind: "text", text: "探针输出\\n- 一行\\n- 两行" };
  b.output = { kind: "text", text: "探针输出\\n- 一行\\n- 两行" };
  renderCanvas();
  return JSON.stringify({ before, ids: [a.id, b.id], titles: [a.title, b.title] });
})()`;

/* 选中 / 取消选中（照 verify-agent-out-fold.mjs 的同一条路） */
const jsSelect = (id, on) => `(() => {
  const n = nodeById(${JSON.stringify(id)});
  if (!n) return JSON.stringify({ error: "node not found" });
  const el = document.querySelector('.wf-node[data-nid="' + n.id + '"]');
  if (${on ? "true" : "false"}) {
    S.selSet = new Set([n.id]); S.sel = n.id; S.selMark = null;
    if (typeof applySelectionInPlace === "function") applySelectionInPlace([n.id]);
    if (typeof applyFocusFormAfterRender === "function") applyFocusFormAfterRender();
    if (typeof setNodeSelClass === "function") setNodeSelClass(el, n, true);
  } else {
    S.selSet = new Set(); S.sel = null;
    if (typeof setNodeSelClass === "function") setNodeSelClass(el, n, false);
    else if (el) { el.classList.remove("sel"); if (typeof applyNodeForm === "function") applyNodeForm(el, n); }
  }
  const el2 = document.querySelector('.wf-node[data-nid="' + n.id + '"]');
  return JSON.stringify({
    selected: ${on ? "true" : "false"},
    form: el2 && el2.dataset ? el2.dataset.nodeForm : null,
    handles: el2 ? el2.querySelectorAll(".vresize-handle").length : -1,
    foldOpen: (() => { const f = el2 && el2.querySelector(".n-agent-out"); if (f) f.open = true; return f ? !!f.open : null; })(),
  });
})()`;

/* 改节点几何（h / convH）后重绘 */
const jsSetGeom = (id, patch) => `(() => {
  const n = nodeById(${JSON.stringify(id)});
  if (!n) return JSON.stringify({ error: "node not found" });
  Object.assign(n, ${JSON.stringify(patch)});
  renderCanvas();
  const el = document.querySelector('.wf-node[data-nid="' + n.id + '"]');
  const f = el && el.querySelector(".n-agent-out");
  if (f) f.open = true;
  return JSON.stringify({ h: n.h, convH: n.convH, w: n.w });
})()`;

/* 几何量测：谁在哪、谁压着谁、谁被顶出列外。
   注意盯的是**看得见的框体**（会话框 / 拖条 / 输入框 / 状态行 / 输出折叠区）——
   会话框在列里是「轮次轨壳 .hist-scroll-wrap > .agent-conv」两层，
   老 bug 正是外壳被压小、内层会话框按 min-height 顶着不掉，越出壳外盖住输入框。 */
const jsGeom = (id) => `(() => {
  const n = nodeById(${JSON.stringify(id)});
  const el = document.querySelector('.wf-node[data-nid="' + n.id + '"]');
  if (!el) return JSON.stringify({ error: "element not found" });
  const P = 0.5;
  const box = (e) => {
    if (!e) return null;
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return {
      tag: (e.className || e.tagName || "").toString().trim(),
      top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1),
      h: +r.height.toFixed(1), w: +r.width.toFixed(1),
      parent: e.parentElement ? (e.parentElement.className || e.parentElement.tagName) : null,
      idx: e.parentElement ? Array.prototype.indexOf.call(e.parentElement.children, e) : -1,
      flex: cs.flex, minH: cs.minHeight, maxH: cs.maxHeight,
      cssH: cs.height, of: cs.overflow, pos: cs.position, disp: cs.display,
      inlineH: e.style.height || "", inlineMinH: e.style.minHeight || "",
      inlineBasis: e.style.flexBasis || "",
    };
  };
  const conv = el.querySelector(".agent-conv");
  const wrap = conv && conv.parentElement && conv.parentElement.classList.contains("hist-scroll-wrap")
    ? conv.parentElement : null;
  const left = el.querySelector(".n-proc-left");
  const body = el.querySelector(".n-body");
  const prompt = el.querySelector(".n-proc-left > .n-prompt") || el.querySelector(".n-proc-left .n-prompt");
  const ta = el.querySelector(".n-proc-left .n-text");
  const status = el.querySelector(".n-proc-left > .n-status");
  const fold = el.querySelector(".n-agent-out");
  const foldHead = el.querySelector(".n-agent-out-head");
  const handles = Array.from(el.querySelectorAll(".vresize-handle"));
  const kids = left ? Array.from(left.children) : [];
  const convBox = box(conv);
  const wrapBox = box(wrap);
  const promptBox = box(prompt);
  const statusBox = box(status);
  const foldBox = box(fold);
  const foldHeadBox = box(foldHead);
  const handleInfo = handles.map((h) => {
    const b = box(h);
    b.isConvChild = !!(conv && conv.contains(h));
    b.prevSibling = h.previousElementSibling ? (h.previousElementSibling.className || h.previousElementSibling.tagName) : null;
    b.nextSibling = h.nextElementSibling ? (h.nextElementSibling.className || h.nextElementSibling.tagName) : null;
    return b;
  });
  const h0 = handleInfo[0];
  /* 看得见的框体链（按列内自上而下）：会话框 → 拖条 → 输入框 → 状态行 → 输出折叠区 */
  const chain = [
    ["会话框", wrapBox || convBox], ["splitter", h0], ["输入框", promptBox],
    ["状态行", statusBox], ["输出折叠区", foldBox],
  ].filter((p) => !!p[1]);
  const overlaps = [];
  for (let i = 1; i < chain.length; i++) {
    const a = chain[i - 1], b = chain[i];
    if (a[1].bottom > b[1].top + P)
      overlaps.push({ a: a[0], b: b[0], px: +(a[1].bottom - b[1].top).toFixed(1) });
  }
  const lr = left ? left.getBoundingClientRect() : null;
  const escaped = chain
    .filter((p) => lr && (p[1].bottom > lr.bottom + P || p[1].top < lr.top - P))
    .map((p) => ({ tag: p[0], top: p[1].top, bottom: p[1].bottom, colTop: +lr.top.toFixed(1), colBottom: +lr.bottom.toFixed(1) }));
  return JSON.stringify({
    nodeW: n.w, nodeH: n.h, convH: n.convH,
    sel: el.className,
    node: box(el), body: box(body), left: box(left),
    wrap: wrapBox, conv: convBox, prompt: promptBox, textarea: box(ta),
    status: statusBox, fold: foldBox, foldHead: foldHeadBox,
    handles: handleInfo,
    handleCount: handles.length,
    handleIsConvChild: handleInfo.some((h) => h.isConvChild),
    /* 夹在两框之间 = 上不与会话框重叠、下不与输入框重叠，且整段落在这条缝里（缝宽 ≤ 20px） */
    handleBetweenConvAndPrompt: !!(h0 && convBox && promptBox &&
      h0.top >= convBox.bottom - P && h0.bottom <= promptBox.top + P &&
      (promptBox.top - convBox.bottom) <= 20),
    convOverflowsWrap: wrapBox ? +(convBox.h - wrapBox.h).toFixed(1) : null,
    colChildren: kids.map((k) => ((k.className || k.tagName) + "").toString().trim()),
    overlaps, escaped,
    colInnerH: lr ? +lr.height.toFixed(1) : null,
  });
})()`;

/* 模拟真拖：在拖条上 mousedown，再在 window 上 mousemove 到目标位置（不改任何源码）。
   mousemove 必须带 buttons:1 —— 拖动处理器把「左/中键都没按下」当成已松手并取消拖拽。 */
const jsDrag = (id, dy) => `(() => {
  const n = nodeById(${JSON.stringify(id)});
  const el = document.querySelector('.wf-node[data-nid="' + n.id + '"]');
  if (!el) return JSON.stringify({ error: "element not found" });
  const h = el.querySelector(".vresize-handle");
  if (!h) return JSON.stringify({ error: "no handle" });
  const r = h.getBoundingClientRect();
  const y0 = r.top + r.height / 2;
  const before = { convH: n.convH };
  h.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: y0, button: 0, buttons: 1 }));
  const mode = S.drag && S.drag.mode;
  for (let k = 1; k <= 12; k++) {
    window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: r.left + r.width / 2, clientY: y0 + (${dy} * k) / 12, button: 0, buttons: 1 }));
  }
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: y0 + ${dy}, button: 0, buttons: 0 }));
  const el2 = document.querySelector('.wf-node[data-nid="' + n.id + '"]');
  const conv = el2 && el2.querySelector('[data-vbox="convH"]');
  const item = conv && typeof agentConvFlexItem === "function" ? agentConvFlexItem(conv) : conv;
  return JSON.stringify({
    dragMode: mode || null,
    convHBefore: before.convH, convHAfter: n.convH,
    dataVboxTag: conv ? conv.className : null,
    itemTag: item ? item.className : null,
    itemBasis: item ? item.style.flexBasis : null,
    itemFlex: item ? item.style.flex : null,
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

function brief(m) {
  if (!m || m.error) return JSON.stringify(m);
  return JSON.stringify({
    nodeH: m.nodeH, convH: m.convH,
    col: m.left && [m.left.top, m.left.bottom],
    conv: m.conv && [m.conv.top, m.conv.bottom],
    wrapH: m.wrap && m.wrap.h, convMinusWrap: m.convOverflowsWrap,
    handles: m.handles.map((h) => [h.tag, h.top, h.bottom, "inConv=" + h.isConvChild, "prev=" + h.prevSibling, "next=" + h.nextSibling]),
    prompt: m.prompt && [m.prompt.top, m.prompt.bottom],
    status: m.status && [m.status.top, m.status.bottom],
    fold: m.fold && [m.fold.top, m.fold.bottom],
    foldHeadH: m.foldHead && m.foldHead.h,
    overlaps: m.overlaps, escaped: m.escaped,
    between: m.handleBetweenConvAndPrompt,
  });
}

/* 目标形态的判据（改后必须条条通过） */
function judge(m, phase) {
  report.measurements[phase] = m;
  if (!m || m.error) {
    check(phase + "：量测拿到了数据", false, JSON.stringify(m));
    return;
  }
  say("    " + phase + "：" + brief(m));
  check(phase + "：节点里只有一根 splitter", m.handleCount === 1, "count=" + m.handleCount);
  check(phase + "：splitter 不再挂在会话框里（上沿干净）", m.handleIsConvChild === false,
    "isConvChild=" + m.handleIsConvChild + " handles=" + JSON.stringify(m.handles.map((h) => h.tag)));
  check(phase + "：splitter 正好夹在「上=会话框」与「下=输入框」之间（两框之间那条缝里）",
    m.handleBetweenConvAndPrompt,
    "handle=" + JSON.stringify(m.handles[0] && [m.handles[0].top, m.handles[0].bottom]) +
      " conv.bottom=" + (m.conv && m.conv.bottom) + " prompt.top=" + (m.prompt && m.prompt.top));
  check(phase + "：会话框不越出自己的壳（conv 高 − 壳高 ≤ 0.5px）",
    m.convOverflowsWrap == null || m.convOverflowsWrap <= 0.5,
    "conv−wrap = " + m.convOverflowsWrap);
  check(phase + "：看得见的框体两两不重叠", m.overlaps.length === 0, JSON.stringify(m.overlaps));
  check(phase + "：框体都完整待在列里（没有被顶出 / 压住）", m.escaped.length === 0, JSON.stringify(m.escaped));
  check(phase + "：输入框（消息栏）完整可见（高 ≥ 30px，且底边不越过列沿）",
    m.prompt && m.prompt.h >= 30 && m.left && m.prompt.bottom <= m.left.bottom + 0.5,
    "promptH=" + (m.prompt && m.prompt.h) + " promptBottom=" + (m.prompt && m.prompt.bottom) + " colBottom=" + (m.left && m.left.bottom));
  check(phase + "：输出折叠区那行标题没被裁掉（标题行高 ≥ 18px 且在列内）",
    m.foldHead && m.foldHead.h >= 18 && m.left && m.foldHead.bottom <= m.left.bottom + 0.5,
    "foldHeadH=" + (m.foldHead && m.foldHead.h) + " bottom=" + (m.foldHead && m.foldHead.bottom));
  check(phase + "：会话框底边不越过列沿（拖到上限也不越界）",
    m.conv && m.left && m.conv.bottom <= m.left.bottom + 0.5,
    "convBottom=" + (m.conv && m.conv.bottom) + " colBottom=" + (m.left && m.left.bottom));
}

/* ── 主流程 ──────────────────────────────────────────────────────────────── */
let child = null;
try {
  say("证据目录：" + RUN + (PROBE ? "（--probe：只量测不判定）" : ""));
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

  /* ① 选中态（编辑态）· 默认几何 */
  say("\n[1] 选中态 · 默认几何（h=380 / convH=200）");
  say("    形态：" + JSON.stringify(JSON.parse(await guiEval(state, jsSelect(A, true)))));
  const m1 = JSON.parse(await guiEval(state, jsGeom(A)));
  if (PROBE) { report.measurements["选中态·默认"] = m1; say("    " + brief(m1)); }
  else judge(m1, "选中态·默认");

  /* ② 选中态 · convH 顶到历史上限 520（改前：会话框高出列沿 181px、盖住下方三个框） */
  say("\n[2] 选中态 · convH=520（拖到历史上限）");
  say("    注入：" + (await guiEval(state, jsSetGeom(A, { convH: 520 }))));
  const m2 = JSON.parse(await guiEval(state, jsGeom(A)));
  if (PROBE) { report.measurements["选中态·convH520"] = m2; say("    " + brief(m2)); }
  else judge(m2, "选中态·convH520");

  /* ③ 选中态 · 节点矮到 300（空间不够时谁让位） */
  say("\n[3] 选中态 · 节点塌到 h=300");
  say("    注入：" + (await guiEval(state, jsSetGeom(A, { h: 300, convH: 200 }))));
  const m3 = JSON.parse(await guiEval(state, jsGeom(A)));
  if (PROBE) { report.measurements["选中态·h300"] = m3; say("    " + brief(m3)); }
  else judge(m3, "选中态·h300");

  /* ③b 选中态 · 节点塌到类型下限 240（列内所有下限之和必须仍然装得下） */
  say("\n[3b] 选中态 · 节点塌到类型下限 h=240");
  say("    注入：" + (await guiEval(state, jsSetGeom(A, { h: 240, convH: 520 }))));
  const m3b = JSON.parse(await guiEval(state, jsGeom(A)));
  if (PROBE) { report.measurements["选中态·h240"] = m3b; say("    " + brief(m3b)); }
  else judge(m3b, "选中态·h240");

  /* ④ 真拖（往下 400px）：必须被「列内此刻真实放得下」实时夹住 */
  say("\n[4] 真拖：把 splitter 往下拖 400px（会话框变高）");
  say("    先摆回默认：" + (await guiEval(state, jsSetGeom(A, { h: 380, convH: 200 }))));
  const dg = JSON.parse(await guiEval(state, jsDrag(A, 400)));
  say("    拖拽回执：" + JSON.stringify(dg));
  report.measurements["拖拽回执·下拖"] = dg;
  const m4 = JSON.parse(await guiEval(state, jsGeom(A)));
  report.measurements["选中态·下拖后"] = m4;
  if (PROBE) say("    " + brief(m4));
  else {
    check("真拖：确实走进了 vresize 分支", dg.dragMode === "vresize", "mode=" + dg.dragMode);
    check("真拖：下拖让会话框变高（convH 变大）", dg.convHAfter > dg.convHBefore,
      "oh=" + dg.convHBefore + " → " + dg.convHAfter);
    check("真拖：convH 被实时夹住（不越写死的 520，且会话框底边不越过列沿）",
      dg.convHAfter <= 520 && m4.conv.bottom <= m4.left.bottom + 0.5,
      "convH=" + dg.convHAfter + " convBottom=" + m4.conv.bottom + " colBottom=" + m4.left.bottom);
    check("真拖：高度写在弹性项（有轮次轨壳时是壳）的 flexBasis 上（与渲染同一条口径）",
      /px$/.test(String(dg.itemBasis || "")) && /hist-scroll-wrap/.test(String(dg.itemTag || "")),
      "item=" + dg.itemTag + " basis=" + dg.itemBasis);
    judge(m4, "选中态·下拖后");
  }

  /* ⑤ 真拖（往上 400px）：会话框变矮，下限 72px，下方框体照旧完整 */
  say("\n[5] 真拖：把 splitter 往上拖 400px（会话框变矮、下限 72px）");
  const ug = JSON.parse(await guiEval(state, jsDrag(A, -400)));
  say("    拖拽回执：" + JSON.stringify(ug));
  report.measurements["拖拽回执·上拖"] = ug;
  const m5 = JSON.parse(await guiEval(state, jsGeom(A)));
  report.measurements["选中态·上拖后"] = m5;
  if (PROBE) say("    " + brief(m5));
  else {
    check("真拖：上拖让会话框变矮且不破下限 72px（不塌成 0、不消失）",
      ug.convHAfter >= 72 && m5.conv.h >= 71, "convH=" + ug.convHAfter + " convH(实测)=" + m5.conv.h);
    judge(m5, "选中态·上拖后");
  }

  /* ⑥ 预览态（未选中）· 同一口径 */
  say("\n[6] 预览态（未选中）");
  say("    形态：" + JSON.stringify(JSON.parse(await guiEval(state, jsSelect(A, false)))));
  const m6 = JSON.parse(await guiEval(state, jsGeom(A)));
  if (PROBE) { report.measurements["预览态"] = m6; say("    " + brief(m6)); }
  else judge(m6, "预览态");

  /* ⑦ 第二颗节点（B）同口径 */
  say("\n[7] 第二颗节点（B）同口径");
  await guiEval(state, jsSelect(B, true));
  const m7 = JSON.parse(await guiEval(state, jsGeom(B)));
  if (PROBE) { report.measurements["第二颗·选中态"] = m7; say("    " + brief(m7)); }
  else judge(m7, "第二颗·选中态");

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
  report.fails = fails;
  fs.writeFileSync(path.join(RUN, "report.json"), JSON.stringify(report, null, 2), "utf8");
  say("\n" + (fails === 0 ? "✓ 全部判据通过" : "✗ 有 " + fails + " 条判据未通过") + "（报告：" + path.join(RUN, "report.json") + "）");
  logStream.end();
}
process.exitCode = fails === 0 ? 0 : 1;
