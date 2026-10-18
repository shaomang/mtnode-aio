/**
 * 一次性真机**对照**量测（修复前形态）：把编辑态的折叠区落位改回 `row.appendChild`
 * （即修复前的写法：折叠区被当成与主列并排的右栏），在同一台机器上量出「坏形态」的几何，
 * 作交付里改前 / 改后的同源对照。量完**一定**把文件还原（校验通过才退出 0）。
 *
 * 只改编辑态那一处（app-canvas.js 里 `left.appendChild(agentTaskOutFoldEl(...))` 的第二处，
 * 紧跟在「整幅宽、挂在输入框下方」那段注释后面）—— 预览态那一处保持修复后写法，
 * 这样对照的就是本次修复真正动过的那一行。
 *
 * 跑法：node test-run/verify-agent-out-fold-before.mjs [--out <目录>]
 * 退出码：0 = 反向注入生效、量到坏形态、文件已还原；1 = 环境错或注入/还原失败。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const require_ = createRequire(import.meta.url);
const CANVAS = path.join(ROOT, "renderer", "app-canvas.js");
const STAMP = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const OUT = path.resolve(
  (process.argv.includes("--out") && process.argv[process.argv.indexOf("--out") + 1]) ||
    path.join(os.tmpdir(), "mtnode-verify-before-" + STAMP),
);
const RUN = path.join(OUT, "verify-agent-out-fold-before-" + STAMP);
const DATA = path.join(RUN, "clean");
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(path.join(RUN, "logs"), { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const orig = fs.readFileSync(CANVAS, "utf8");
const backup = path.join(RUN, "app-canvas.js.fixed.bak");
fs.writeFileSync(backup, orig, "utf8");

/* 只把编辑态那一处换回旧写法：用「注释 + 那一行」做锚点，保证不会连带改预览态那处 */
const GOOD_BLOCK =
  "           （老数据留着不动，不主动收窄用户已存的几何）。 */\n        left.appendChild(agentTaskOutFoldEl(node, r, liveDsh));";
const BAD_BLOCK = GOOD_BLOCK.replace("left.appendChild", "row.appendChild");
if (!orig.includes(GOOD_BLOCK)) {
  console.error("找不到编辑态那一处的锚点，无法反向注入（源码已变？）");
  process.exit(1);
}
fs.writeFileSync(CANVAS, orig.replace(GOOD_BLOCK, BAD_BLOCK), "utf8");
const injected = fs.readFileSync(CANVAS, "utf8");
console.log(
  "已反向注入编辑态落位（修复前写法）：" +
    (injected.split("row.appendChild(agentTaskOutFoldEl").length - 1) +
    " 处 row.appendChild；备份 " + backup,
);

let child = null;
try {
  const bin = require_("electron");
  const env = { ...process.env, MTNODE_DATA_DIR: DATA };
  delete env.ELECTRON_RUN_AS_NODE;
  const log = fs.createWriteStream(path.join(RUN, "logs", "app.log"), { flags: "w" });
  child = spawn(String(bin), [".", "--user-data-dir=" + DATA], {
    cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  child.stdout.on("data", (d) => log.write("[out] " + d));
  child.stderr.on("data", (d) => log.write("[err] " + d));

  let state = null;
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    for (const d of [DATA, path.join(DATA, "pipeline-console")]) {
      const p = path.join(d, "mcp-server.json");
      if (fs.existsSync(p)) state = JSON.parse(fs.readFileSync(p, "utf8"));
    }
    if (state && state.port) break;
  }
  if (!state || !state.port) throw new Error("实例没起来（日志：" + RUN + "\\logs\\app.log）");
  await sleep(3000);
  const ctl = async (method, params) =>
    (await fetch("http://127.0.0.1:" + state.port + "/ctl", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + state.token },
      body: JSON.stringify({ method, params }),
    })).json();
  const evalJs = async (expression) => {
    const r = await ctl("tools/call", { name: "mtnode_gui", arguments: { action: "eval", which: "main", expression } });
    const sc = r && r.result && r.result.structuredContent;
    if (sc && sc.ok === false) throw new Error(String(sc.error));
    return sc && "value" in sc ? sc.value : sc;
  };

  /* 夹具：一颗智能任务节点 → 选中 → 注入输出 → 展开折叠区 → 量几何 */
  const fx = JSON.parse(await evalJs(`(() => {
    const before = S.wf.nodes.length;
    const a = addNode("agent_task", 120, 120, { title: "坏形态探针" });
    a.w = 360; a.h = 300; a.convH = 120;
    renderCanvas();
    return JSON.stringify({ before, id: a.id });
  })()`));
  const A = fx.id;
  const inject = JSON.parse(await evalJs(`(() => {
    const n = nodeById(${JSON.stringify(A)});
    n.output = { kind: "text", text: "坏形态对照输出\\n- 一行\\n- 两行" };
    renderCanvas();
    return JSON.stringify({ outKind: n.output.kind, w: n.w });
  })()`));
  const sel = JSON.parse(await evalJs(`(() => {
    const n = nodeById(${JSON.stringify(A)});
    S.selSet = new Set([n.id]); S.sel = n.id;
    applySelectionInPlace([n.id]); applyFocusFormAfterRender();
    const el = document.querySelector('.wf-node[data-nid="' + n.id + '"]');
    setNodeSelClass(el, n, true);
    const f = el.querySelector(".n-agent-out");
    if (f) f.open = true;
    return JSON.stringify({ form: el.dataset.nodeForm, hasFold: !!f, open: f ? !!f.open : null });
  })()`));
  const m = JSON.parse(await evalJs(`(() => {
    const n = nodeById(${JSON.stringify(A)});
    const el = document.querySelector('.wf-node[data-nid="' + n.id + '"]');
    const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { w: +b.width.toFixed(1), right: +b.right.toFixed(1) }; };
    const fold = el.querySelector(".n-agent-out");
    const row = el.querySelector(".n-proc-row");
    const left = el.querySelector(".n-proc-left");
    const panel = el.querySelector(".n-agent-out .n-out");
    const btns = el.querySelector(".n-agent-out .n-out-btns");
    return JSON.stringify({
      nodeW: +el.getBoundingClientRect().width.toFixed(1),
      fold: r(fold), left: r(left), panel: r(panel),
      btns: btns ? { w: +btns.getBoundingClientRect().width.toFixed(1), right: +btns.getBoundingClientRect().right.toFixed(1) } : null,
      foldParentIsRow: !!(fold && row && fold.parentElement === row),
      foldParentIsLeft: !!(fold && left && fold.parentElement === left),
    });
  })()`));
  /* 收尾：删掉探针节点 */
  const cl = JSON.parse(await evalJs(`(() => {
    const n = nodeById(${JSON.stringify(A)});
    const i = S.wf.nodes.indexOf(n);
    if (i >= 0) S.wf.nodes.splice(i, 1);
    S.selSet = new Set(); S.sel = null; renderCanvas();
    return JSON.stringify({ nodes: S.wf.nodes.length });
  })()`));

  const report = { ts: new Date().toISOString(), kind: "before(broken-layout)", runDir: RUN, fixture: fx, inject, sel, measure: m, cleanup: cl };
  fs.writeFileSync(path.join(RUN, "report.json"), JSON.stringify(report, null, 2), "utf8");
  console.log("夹具：" + JSON.stringify(fx));
  console.log("注入输出：" + JSON.stringify(inject));
  console.log("形态：" + JSON.stringify(sel));
  console.log("坏形态量测：" + JSON.stringify(m));
  console.log("收尾：" + JSON.stringify(cl));
  const broke =
    m.foldParentIsRow === true && m.fold && m.left && m.fold.w < m.left.w * 0.9;
  console.log(broke ? "✓ 坏形态已复现（折叠区被排成右栏、面板被挤窄）" : "⚠ 没复现出坏形态，请检查注入是否生效");
  process.exitCode = broke ? 0 : 1;
} catch (e) {
  console.error("ERROR " + ((e && e.stack) || e));
  process.exitCode = 1;
} finally {
  if (child) {
    try {
      if (process.platform === "win32")
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      else child.kill("SIGTERM");
    } catch (_) {}
    await sleep(1500);
  }
  fs.writeFileSync(CANVAS, orig, "utf8");
  const back = fs.readFileSync(CANVAS, "utf8");
  const clean = back === orig;
  console.log(clean ? "已还原修复后的 app-canvas.js（逐字节校验通过）" : "⚠ 还原校验失败：" + CANVAS);
  if (!clean) process.exitCode = 1;
}
