/**
 * 插件安装驱动（一次性脚本 · 零依赖）：用 MCP 的 mtnode_gui 真的点 MTNode 的界面，
 * 走一遍「插件卡 → 开始安装 → 等终局」，并把安装窗里的步骤与日志抓回来。
 *
 * 为什么要有它：安装这件事**只能从窗口里发起**（宿主 install 函数在渲染层 IPC 后面），
 * 而本机执行者的会话没有 GUI 工具。所以：本脚本直连 MTNode 的 MCP 服务端（/ctl），
 * 用 mtnode_gui 的 eval/click/wait，把界面当 API 用。
 *
 * 用法：
 *   node tools/plugin-install-drive.mjs <pluginId> [--data <数据目录>] [--timeout <秒>]
 *     [--keep-open] [--no-open] [--dump <日志文件>]
 *   node tools/plugin-install-drive.mjs <pluginId> --status-only --data <dir>
 *   node tools/plugin-install-drive.mjs --list --data <dir>
 *
 * 退出码：0 = 安装终局 ok；3 = 终局失败（日志照打）；4 = 超时；1 = 用法 / 环境错误。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/* ---------------- MCP 直连（与 tools/mtnode-gui.mjs 同口径） ---------------- */

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const n = argv[i + 1];
      if (n !== undefined && !n.startsWith("--")) {
        out[k] = n;
        i++;
      } else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

function findState(dataDir) {
  const cands = [];
  if (dataDir) cands.push(dataDir, path.join(dataDir, "pipeline-console"));
  const env = process.env.MTNODE_DATA_DIR;
  if (env) cands.push(env, path.join(env, "pipeline-console"));
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  cands.push(path.join(appData, "pipeline-console"), path.join(appData, "pipeline-console", "pipeline-console"));
  for (const d of cands) {
    const p = path.join(d, "mcp-server.json");
    if (fs.existsSync(p)) return p;
  }
  throw new Error("没找到 mcp-server.json（用 --data 指定数据目录）。找过：" + cands.join(" | "));
}

function readState(p) {
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  if (!j || !j.token) throw new Error("mcp-server.json 没有 token：" + p);
  if (!j.port) throw new Error("MCP 服务端没在监听（port:0）：MTNode 没开着？" + p);
  return j;
}

function makeCtl(state) {
  return async function ctl(method, params) {
    const res = await fetch("http://127.0.0.1:" + state.port + "/ctl", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + state.token },
      body: JSON.stringify({ method, params }),
    });
    return res.json();
  };
}

/** mtnode_gui 一次调用；失败即抛（错误文本原样带出）。 */
async function gui(ctl, action, extra) {
  const rpc = await ctl("tools/call", { name: "mtnode_gui", arguments: Object.assign({ action }, extra || {}) });
  if (!rpc || rpc.ok !== true) throw new Error("MCP 调用失败：" + JSON.stringify(rpc && rpc.error));
  const r = rpc.result;
  if (r && r.isError) {
    const txt = (r.content && r.content[0] && r.content[0].text) || "";
    throw new Error("mtnode_gui " + action + " 失败：" + txt);
  }
  const v = r && r.structuredContent;
  if (v && v.ok === false) throw new Error("mtnode_gui " + action + " 动作未生效：" + (v.error || ""));
  return v || r;
}

/** 在页面里求值（表达式可以是 Promise，返回会被 await）。 */
async function ev(ctl, which, expression) {
  return gui(ctl, "eval", { which, expression });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ---------------- 页面侧探针（字符串拼接：不能出现模板字面量） ---------------- */

/** 从**主进程**读安装会话快照（比在页面里挂钩事件稳：安装窗的桥只在它自己的 preload 上，
 *  主窗口没有 onEvent；而 mtnodeInstallState 是主窗口 preload 里的正式桥）。
 *  表达式只做「取回来 + JSON.stringify」，整理交给 Node 侧（页面里的复杂脚本一多就容易写错）。 */
function stateExpr(id) {
  return "window.api.mtnodeInstallState(" + JSON.stringify(String(id)) + ").then(function(r){ return JSON.stringify(r); })";
}

/** 把 mtnodeInstallState 的回执整理成驱动要的形状。 */
function normState(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const s = r.session || null;
  if (!s) return { none: true, raw: r };
  const all = [];
  const buckets = s.logs || {};
  for (const k of Object.keys(buckets)) {
    for (const line of String(buckets[k] || "").split("\n")) if (line) all.push(line);
  }
  return {
    state: s.state,
    pct: s.pct,
    error: s.error || "",
    hint: s.hint || "",
    installDir: s.installDir || "",
    pluginId: s.pluginId || "",
    steps: (s.steps || []).map((x) => ({ id: x.id, title: x.title, status: x.status, message: x.message, pct: x.pct })),
    logLines: all,
    logCount: all.length,
    ended: !!s.endedAt,
  };
}

/** 安装窗里的动作按钮文案（当前态）。 */
const ACTION_BTN_EXPR =
  "(function(){ var out = []; var bs = document.querySelectorAll('button'); for (var i = 0; i < bs.length; i++) {" +
  " var b = bs[i]; var tx = String(b.textContent || '').replace(/\\s+/g, ' ').trim();" +
  " if (!tx || b.id === 'btnClose') continue; if (b.offsetParent === null) continue; out.push({ text: tx, cls: b.className }); } return JSON.stringify(out); })()";

/** 点安装窗里文案匹配的按钮（精确优先，其次包含）。 */
function clickBtnExpr(want) {
  return (
    "(function(){ var want = " + JSON.stringify(want) + ";" +
    " var bs = document.querySelectorAll('button'); var exact = null, part = null;" +
    " for (var i = 0; i < bs.length; i++) { var b = bs[i]; if (b.disabled) continue; if (b.offsetParent === null) continue;" +
    " var tx = String(b.textContent || '').replace(/\\s+/g, ' ').trim(); if (!tx) continue;" +
    " if (tx === want && !exact) exact = b; else if (tx.indexOf(want) >= 0 && !part) part = b; }" +
    " var hit = exact || part; if (!hit) return JSON.stringify({ ok: false, error: 'no-button', want: want," +
    " seen: Array.prototype.map.call(bs, function(x){ return String(x.textContent || '').replace(/\\s+/g,' ').trim(); }).filter(Boolean) });" +
    " hit.click(); return JSON.stringify({ ok: true, clicked: String(hit.textContent || '').replace(/\\s+/g, ' ').trim() }); })()"
  );
}

/** 同上，但连 disabled 的按钮也点（有些态下按钮只是视觉禁用，事件仍绑着）。 */
function clickBtnExprForce(want) {
  return (
    "(function(){ var want = " + JSON.stringify(want) + ";" +
    " var bs = document.querySelectorAll('button');" +
    " for (var i = 0; i < bs.length; i++) { var b = bs[i];" +
    " var tx = String(b.textContent || '').replace(/\\s+/g, ' ').trim();" +
    " if (tx === want || tx.indexOf(want) >= 0) { b.disabled = false; b.removeAttribute('disabled'); b.click();" +
    " return JSON.stringify({ ok: true, clicked: tx }); } }" +
    " return JSON.stringify({ ok: false, error: 'no-button-force' }); })()"
  );
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const statePath = findState(args.data === true ? "" : args.data);
  const state = readState(statePath);
  const ctl = makeCtl(state);

  if (args.list) {
    const w = await gui(ctl, "windows");
    console.log(JSON.stringify(w.windows, null, 2));
    return;
  }

  const id = String(args._[0] || "").trim();
  if (!id) throw new Error("用法：plugin-install-drive.mjs <pluginId> [--data <dir>] [--timeout <秒>]");

  if (args["status-only"]) {
    const st = await ev(ctl, "main", stateExpr(id));
    console.log(JSON.stringify(normState(JSON.parse(st.value || "{}")), null, 2));
    return;
  }

  const timeoutMs = (Number(args.timeout) || 3600) * 1000;
  const deadline = Date.now() + timeoutMs;

  /* ① 开安装窗（走主窗口那条既有入口，与用户点卡片完全同一条路） */
  if (!args["no-open"]) {
    console.log("[drive] open install window: " + id);
    const r = await ev(
      ctl,
      "main",
      "window.api.mtnodeInstallOpen({ id: " +
        JSON.stringify(id) +
        ", action: 'install' }).then(function(r){ return JSON.stringify({ok: r && r.ok, open: r && r.open, state: r && r.session && r.session.state}); })",
    );
    console.log("[drive] open → " + r.value);
  }

  /* ② 等安装窗出现（先确认窗在，再点按钮） */
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      await gui(ctl, "windows", { which: "install" });
      break;
    } catch (e) {
      if (i === 39) throw new Error("安装窗一直没出来：" + ((e && e.message) || e));
    }
  }

  /* ③ 点起跑按钮。三种态各有各的按钮：
     · idle（窗刚开）→ 「开始安装」
     · failed（上一轮失败）→ 「重试」
     · done（装完过）→ 「重新安装」（**必须点它才会重跑**：只开窗什么都不做，
       下面读到的还是上一次的终局快照 —— 会把「没测」误当「已通过」）。
     已经在跑（state=running）就什么都不点，直接进轮询。 */
  await sleep(1000);
  const st0 = normState(JSON.parse((await ev(ctl, "main", stateExpr(id))).value || "{}"));
  console.log("[drive] state before start: " + st0.state);
  let btns = JSON.parse((await ev(ctl, "install", ACTION_BTN_EXPR)).value || "[]");
  console.log("[drive] actions: " + btns.map((b) => b.text).join(" | "));
  const pick = ["开始安装", "重试", "重新安装"].find((w) => btns.some((b) => b.text === w)) || "";
  if (st0.state === "running") {
    console.log("[drive] 已经在跑，不重复点按钮");
  } else if (!pick) {
    console.log("[drive] 没找到「开始安装 / 重试 / 重新安装」按钮，按当前状态继续观察");
  } else {
    const c = JSON.parse((await ev(ctl, "install", clickBtnExpr(pick))).value || "{}");
    console.log("[drive] click: " + JSON.stringify(c));
    if (c && c.ok === false) {
      console.log("[drive] 按钮点不到（可能被禁用）：改用 force 再试一次");
      const cf = JSON.parse(
        (await ev(ctl, "install", clickBtnExprForce(pick))).value || "{}",
      );
      console.log("[drive] force click: " + JSON.stringify(cf));
    }
  }

  /* ④ 轮询：终局 = 快照 state 落到 done / failed / cancelled（或 endedAt 有值）
     另有「卡住」判据：脚本连续 8 分钟一行日志都不出，且状态还是 running —— 报出来比干等到底强
     （实测踩过：上一轮遗留的 .venv\Scripts\python.exe 还活着时，新一轮一碰就 Permission denied 卡死）。 */
  let last = null;
  let lastLogCount = 0;
  let lastProgressAt = Date.now();
  let finished = false;
  let stalled = false;
  while (Date.now() < deadline) {
    await sleep(4000);
    let snap;
    try {
      snap = normState(JSON.parse((await ev(ctl, "main", stateExpr(id))).value || "{}"));
    } catch (e) {
      console.log("[drive] 读安装快照失败：" + ((e && e.message) || e));
      break;
    }
    last = snap;
    if (snap.none) {
      console.log("[drive] 安装窗被关了 / 没有这个插件的会话");
      break;
    }
    if (snap.logCount !== lastLogCount) {
      lastLogCount = snap.logCount;
      lastProgressAt = Date.now();
      const tail = (snap.logLines || []).slice(-3).join(" ⏎ ");
      console.log("[drive] …" + snap.logCount + " 行 | " + tail.slice(0, 200));
    } else if (Date.now() - lastProgressAt > 8 * 60 * 1000) {
      stalled = true;
      console.log("[drive] 8 分钟没有任何新日志，判定卡住（状态 " + snap.state + "）");
      break;
    }
    if (snap.ended || snap.state === "done" || snap.state === "failed" || snap.state === "cancelled") {
      finished = true;
      break;
    }
  }

  /* ⑤ 出报告 */
  const steps = ((last && last.steps) || []).map(
    (s) => (s.status || "?") + " " + (s.title || s.id) + (s.message ? " :: " + String(s.message).slice(0, 300) : ""),
  );
  const report = {
    pluginId: id,
    stalled,
    statePath,
    port: state.port,
    finished,
    outcome: last && last.state ? last.state : "(unknown)",
    error: (last && last.error) || "",
    hint: (last && last.hint) || "",
    installDir: (last && last.installDir) || "",
    pct: last && last.pct,
    steps,
    logTail: ((last && last.logLines) || []).slice(-400),
    logCount: (last && last.logCount) || 0,
  };
  if (args.dump && args.dump !== true) {
    fs.writeFileSync(String(args.dump), JSON.stringify(report, null, 2), "utf8");
    console.log("[drive] 报告已写：" + args.dump);
  }
  console.log("==== REPORT ====");
  console.log(
    JSON.stringify(
      Object.assign({}, report, { logTail: report.logTail.slice(-40) }),
      null,
      2,
    ),
  );
  if (!finished) process.exitCode = 4;
  else if (report.outcome !== "done") process.exitCode = 3;
}

main().catch((e) => {
  console.error("[drive] " + ((e && e.message) || e));
  process.exitCode = 1;
});
