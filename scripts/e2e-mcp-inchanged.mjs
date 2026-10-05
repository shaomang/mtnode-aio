/**
 * MTNode MCP · 真机端到端：MCP 免确认 + 编辑不再自动改节点（2026-02 需求）
 * ============================================================================
 * 与其它测试的分工：
 *   - test/smoke-mcp-no-confirm.js   零依赖单模块回归（抽真源码在 vm 里跑）
 *   - **本脚本**：起一只干净数据目录的**真 MTNode**（Electron），用**真实 HTTP 客户端**
 *     （POST /mcp + Bearer，不走 stdio 桥）逐条打 MCP 工具，验证两件事：
 *       ① 第三方调用全程不弹确认框（用 mtnode_app 的 pending_interactions 取证）；
 *       ② canvas_edit 改正文 / 建节点都不再自动改节点尺寸、也不再自动排版：
 *          已存在节点的 w/h/位置一字不变，新节点不重叠。
 *     最后把过程日志 + JSON 报告 + 整窗截图落盘。
 *
 * 跑法（自己起实例，跑完自己收）：
 *   node scripts/e2e-mcp-inchanged.mjs --out E:\dev\tools\mtnode-mcp-test
 * 可选：--data <数据目录>（默认 <out>\clean-inchanged）、--keep（跑完不关实例）
 *
 * 现场纪律：只碰 --out 指定的目录；不启动第二个实例占你的默认数据目录。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const require_ = createRequire(import.meta.url);

function argOf(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const OUT = path.resolve(argOf("--out", path.join(ROOT, "..", "mtnode-mcp-test")));
const DATA = path.resolve(argOf("--data", path.join(OUT, "clean-inchanged")));
const KEEP = process.argv.includes("--keep");
const FRESH = !process.argv.includes("--reuse");
const WAIT_MS = Number(argOf("--wait", "180000"));

fs.mkdirSync(OUT, { recursive: true });
/* 每一轮都从干净环境开始（--reuse 才沿用上一次的现场）：否则会读到上一轮遗留的
   mcp-server.json（端口早失效），握手就变成一个「fetch failed」的假象。 */
if (FRESH && fs.existsSync(DATA)) {
  try {
    fs.rmSync(DATA, { recursive: true, force: true });
  } catch (e) {
    console.warn("[e2e] 清不掉旧数据目录：" + ((e && e.message) || e));
  }
}
fs.mkdirSync(DATA, { recursive: true });
const LOG = path.join(OUT, "logs", "e2e-mcp-inchanged.log");
fs.mkdirSync(path.dirname(LOG), { recursive: true });
const logStream = fs.createWriteStream(LOG, { flags: "w" });

const t0 = Date.now();
const results = [];
let stepNo = 0;
function out(line) {
  process.stdout.write(line + "\n");
  logStream.write(line + "\n");
}
function step(name, ok, detail) {
  stepNo += 1;
  results.push({ n: stepNo, name, ok: !!ok, detail: detail == null ? "" : String(detail) });
  out(
    "[" + String(Date.now() - t0).padStart(7) + "ms] " + (ok ? "PASS" : "FAIL") + " #" +
      String(stepNo).padStart(3) + " " + name +
      (detail ? "  ‹ " + String(detail).replace(/\s+/g, " ").slice(0, 240) + " ›" : ""),
  );
}
const info = (l) => out("[" + String(Date.now() - t0).padStart(7) + "ms] ·· " + l);
const phase = (t) => {
  out("");
  out("══════════════════════════════════════════════════════════════");
  out("  " + t);
  out("══════════════════════════════════════════════════════════════");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 起一只干净实例 ─────────────────────────────────────────────────────── */
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
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c) => c.split("\n").forEach((l) => l.trim() && info("app │ " + l.trim())));
  child.stderr.on("data", (c) => c.split("\n").forEach((l) => l.trim() && info("app! │ " + l.trim())));
  return child;
}

async function waitForServer(deadlineMs) {
  /* 数据目录可能多一层 pipeline-console（应用策略），两处都找 */
  const candidates = [DATA, path.join(DATA, "pipeline-console")];
  const deadline = Date.now() + deadlineMs;
  let last = "";
  while (Date.now() < deadline) {
    for (const dir of candidates) {
      const fp = path.join(dir, "mcp-server.json");
      try {
        const j = JSON.parse(fs.readFileSync(fp, "utf8"));
        if (j && j.token && Number(j.port))
          return { port: Number(j.port), token: String(j.token), raw: j, file: fp, dataRoot: dir };
        last = "文件在，但缺 port/token：" + JSON.stringify(j);
      } catch (e) {
        last = (e && e.message) || String(e);
      }
    }
    await sleep(700);
  }
  throw new Error(
    "等待 mcp-server.json 超时（" + candidates.join(" / ") + "）（最后：" + last + "）",
  );
}

async function http(port, method, urlPath, { token, body, headers } = {}) {
  const h = { ...(headers || {}) };
  if (token) h.authorization = "Bearer " + token;
  if (body !== undefined) h["content-type"] = "application/json";
  let lastErr = null;
  /* 文件就绪 ≠ 监听就绪：/mcp 头几次连接被拒是正常的，重试一小会儿 */
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch("http://127.0.0.1:" + port + urlPath, {
        method,
        headers: h,
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {}
      return { status: res.status, json, text, sid: res.headers.get("mcp-session-id") || "" };
    } catch (e) {
      lastErr = e;
      await sleep(500);
    }
  }
  throw new Error(
    "连不上 127.0.0.1:" + port + urlPath + "（重试 30 次）：" + ((lastErr && lastErr.message) || lastErr),
  );
}

/** 真 HTTP 客户端：initialize 一次，之后 tools/call 共用同一个 Mcp-Session-Id */
function makeClient(port, token) {
  let sid = "";
  let nextId = 1;
  async function rpc(method, params, timeoutMs = 120000) {
    const id = nextId++;
    const p = http(port, "POST", "/mcp", {
      token,
      body: { jsonrpc: "2.0", id, method, params: params || {} },
      headers: sid ? { "mcp-session-id": sid } : undefined,
    });
    const r = await Promise.race([
      p,
      sleep(timeoutMs).then(() => {
        throw new Error("等待回执超时（" + timeoutMs + "ms）：" + method);
      }),
    ]);
    if (r.sid) sid = r.sid;
    return r;
  }
  return {
    get sid() {
      return sid;
    },
    rpc,
    async init() {
      const r = await rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "e2e-inchanged", version: "1.0.0" },
      });
      return r;
    },
    async call(name, args, timeoutMs) {
      const r = await rpc("tools/call", { name, arguments: args || {} }, timeoutMs);
      const res = r.json && r.json.result;
      const text = res && Array.isArray(res.content) ? res.content.map((c) => c.text || "").join("\n") : "";
      const j = (() => {
        try {
          return JSON.parse(text);
        } catch {
          return null;
        }
      })();
      return {
        status: r.status,
        ok: !!(res && !res.isError),
        isError: !!(res && res.isError),
        text,
        json: j,
        error: (r.json && r.json.error) || null,
        raw: r.json,
      };
    },
  };
}

/* ── 几何：与渲染层 layoutNodeSize 同一口径（超级壳展开时按 expandW/H） ── */
function drawSize(n) {
  if (n && n.kind === "super" && n.superOpen)
    return { w: Math.max(320, Number(n.expandW) || 720), h: Math.max(220, Number(n.expandH) || 480) };
  return { w: Number(n.w) || 288, h: Number(n.h) || 192 };
}
function overlap(a, b, pad = 0) {
  const sa = drawSize(a);
  const sb = drawSize(b);
  return (
    a.x < b.x + sb.w + pad &&
    a.x + sa.w + pad > b.x &&
    a.y < b.y + sb.h + pad &&
    a.y + sa.h + pad > b.y
  );
}
const key = (n) => n.title + "#" + n.id;
function geomSnapshot(nodes) {
  const m = {};
  for (const n of nodes) m[key(n)] = { x: n.x, y: n.y, w: n.w, h: n.h };
  return m;
}

/* ── 主流程 ─────────────────────────────────────────────────────────────── */
async function main() {
  phase("1 · 起干净实例（数据目录 " + DATA + "）");
  const app = launchApp();
  let exitCode = 1;
  const report = { data: DATA, startedAt: new Date().toISOString(), steps: results };
  try {
    const srv = await waitForServer(WAIT_MS);
    step("干净实例 MCP 服务端就绪（mcp-server.json: port + token）", true, "port=" + srv.port + " token=" + srv.token.slice(0, 8) + "… · " + srv.file);
    report.port = srv.port;

    const cli = makeClient(srv.port, srv.token);
    phase("2 · 真实 HTTP 客户端握手（POST /mcp + Bearer）");
    /* 渲染层要先把画布与控制脚本挂起来才接得住帧；服务端监听早于它，所以先给一点启动余量 */
    info("等渲染层就绪（8s：服务端监听早于页面脚本装载）");
    await sleep(8000);
    const init = await cli.init();
    step("initialize 成功并拿到 Mcp-Session-Id", init.status === 200 && !!cli.sid, "status=" + init.status + " sid=" + cli.sid);
    const tl = await cli.rpc("tools/list", {});
    const tools = ((tl.json && tl.json.result && tl.json.result.tools) || []).map((t) => t.name);
    step("tools/list 拿到工具清单", tools.length >= 8, tools.join(" "));
    const noAuth = await http(srv.port, "POST", "/mcp", {
      body: { jsonrpc: "2.0", id: 99, method: "tools/list", params: {} },
    });
    step("无令牌被拒（令牌就是那道授权闸）", noAuth.status === 401 || noAuth.status === 403, "status=" + noAuth.status);

    phase("3 · 读现状：干净画布的节点几何");
    const g0 = await cli.call("mtnode_canvas_get", { detail: "standard" });
    const snap0 = g0.json || {};
    const nodes0 = snap0.nodes || [];
    step("canvas_get detail=standard 有节点与几何", !!g0.ok && nodes0.length > 0, "节点 " + nodes0.length + " 个 · contentHash=" + String(snap0.contentHash || "").slice(0, 12));
    const geom0 = geomSnapshot(nodes0);
    info("初始：" + nodes0.slice(0, 6).map((n) => n.title + "@" + n.x + "," + n.y + " " + n.w + "×" + n.h).join(" | "));

    phase("4 · 造一颗受控的文本节点（显式尺寸），再改正文：w/h/位置一字不变");
    const SET_W = 264;
    const SET_H = 120;
    const shortText = "短正文";
    const mk = await cli.call("mtnode_canvas_edit", {
      baseHash: snap0.contentHash,
      detail: "diff",
      create: [{ alias: "victim", kind: "input_text", title: "MCP 尺寸受控节点", text: shortText, w: SET_W, h: SET_H }],
    });
    const madeNode = (mk.json && mk.json.created && mk.json.created[0]) || null;
    step(
      "canvas_edit 建受控节点（显式 " + SET_W + "×" + SET_H + "）",
      !!mk.ok && !!madeNode && madeNode.w === SET_W && madeNode.h === SET_H,
      madeNode ? madeNode.title + " @ " + madeNode.x + "," + madeNode.y + " " + madeNode.w + "×" + madeNode.h : mk.text.slice(0, 160),
    );
    const gA = await cli.call("mtnode_canvas_get", { detail: "standard", ids: [madeNode.id] });
    const victim = ((gA.json || {}).nodes || [])[0] || {};
    const vKey = key(victim);
    const before = { ...victim };
    const longText = "这是一段刻意很长的正文，用来触发旧版「按正文长短重算节点高度」的行为。".repeat(24);
    const editArgs =
      victim.kind === "input_text"
        ? { id: victim.id, text: longText }
        : { id: victim.id, prompt: longText };
    const e1 = await cli.call("mtnode_canvas_edit", { baseHash: (gA.json || {}).contentHash, detail: "diff", update: [editArgs] });
    step("canvas_edit update 改正文成功", e1.ok, e1.text.replace(/\s+/g, " ").slice(0, 200));
    const g1 = await cli.call("mtnode_canvas_get", { detail: "standard", ids: [victim.id] });
    const after1 = ((g1.json || {}).nodes || [])[0] || {};
    info("改正文后：" + after1.title + "@" + after1.x + "," + after1.y + " " + after1.w + "×" + after1.h);
    step(
      "改正文后尺寸与坐标一字不变（" + before.w + "×" + before.h + " @" + before.x + "," + before.y + "）",
      after1.w === before.w && after1.h === before.h && after1.x === before.x && after1.y === before.y,
      "现在 " + after1.w + "×" + after1.h + " @" + after1.x + "," + after1.y,
    );
    const bodyLen =
      victim.kind === "input_text"
        ? Number(after1.textLen) || String(after1.text || "").length
        : Number(after1.promptLen) || String(after1.prompt || "").length;
    step("正文确实被写长了（对照：不是没写进去）", bodyLen > 500, "正文长度 " + bodyLen + "（detail=standard 用 *Len 计数）");

    phase("5 · 建新节点：就近找空位、不与任何节点重叠、旧节点不动");
    const g2 = await cli.call("mtnode_canvas_get", { detail: "standard" });
    const nodes2 = (g2.json || {}).nodes || [];
    const geom2 = geomSnapshot(nodes2);
    const e2 = await cli.call("mtnode_canvas_edit", {
      baseHash: (g2.json || {}).contentHash,
      detail: "diff",
      create: [{ alias: "fresh", kind: "proc_text", title: "MCP 新节点（无坐标）", prompt: longText }],
    });
    step("canvas_edit create 不带坐标成功", e2.ok, e2.text.replace(/\s+/g, " ").slice(0, 200));
    const createdList = (e2.json && e2.json.created) || [];
    const fresh = createdList[0] || null;
    step("回执自足：created 带 x/y/w/h", !!fresh && [fresh.x, fresh.y, fresh.w, fresh.h].every((v) => typeof v === "number"), fresh ? fresh.title + "@" + fresh.x + "," + fresh.y + " " + fresh.w + "×" + fresh.h : "无 created");

    const g3 = await cli.call("mtnode_canvas_get", { detail: "standard" });
    const nodes3 = (g3.json || {}).nodes || [];
    const geom3 = geomSnapshot(nodes3);
    const sorted2 = Object.keys(geom2).sort();
    const sorted3 = Object.keys(geom3).filter((k) => k !== (fresh ? key(fresh) : "")).sort();
    let moved = 0;
    if (String(sorted2) === String(sorted3)) {
      for (const k of sorted2) {
        const a = geom2[k];
        const b = geom3[k];
        if (!b || a.x !== b.x || a.y !== b.y || a.w !== b.w || a.h !== b.h) moved++;
      }
    } else {
      moved = -1;
    }
    step("建新节点之后：所有旧节点几何一字不变（" + sorted2.length + " 个）", moved === 0, moved === 0 ? "0 个被挪动 / 缩放" : "被改动的旧节点数=" + moved);

    const freshNode = nodes3.find((n) => n.id === (fresh && fresh.id));
    const hits = freshNode ? nodes3.filter((o) => o.id !== freshNode.id && overlap(freshNode, o, 0)) : [];
    step(
      "新节点与既有节点零重叠（就近找空位）",
      !!freshNode && hits.length === 0,
      freshNode ? "落点 " + freshNode.x + "," + freshNode.y + " · 重叠 " + hits.length + " 个" + (hits.length ? "：" + hits.map((h) => h.title).join("、") : "") : "找不到新节点",
    );

    phase("6 · 再改一次新节点正文：尺寸仍不动（update 路径隔离验证）");
    const wBefore = freshNode ? { x: freshNode.x, y: freshNode.y, w: freshNode.w, h: freshNode.h } : null;
    const e3 = await cli.call("mtnode_canvas_edit", {
      baseHash: (g3.json || {}).contentHash,
      detail: "diff",
      update: [{ title: (freshNode && freshNode.title) || "MCP 新节点（无坐标）", prompt: longText + longText }],
    });
    step("第二次 canvas_edit update 成功", e3.ok, e3.text.replace(/\s+/g, " ").slice(0, 160));
    const g4 = await cli.call("mtnode_canvas_get", { detail: "standard", ids: [freshNode ? freshNode.id : ""] });
    const fresh2 = ((g4.json || {}).nodes || [])[0] || {};
    step(
      "改正文两轮后新节点几何不变",
      !!wBefore && fresh2.x === wBefore.x && fresh2.y === wBefore.y && fresh2.w === wBefore.w && fresh2.h === wBefore.h,
      wBefore ? "之前 " + wBefore.w + "×" + wBefore.h + " @" + wBefore.x + "," + wBefore.y + " → 现在 " + fresh2.w + "×" + fresh2.h + " @" + fresh2.x + "," + fresh2.y : "无基准",
    );

    phase("7 · 免确认取证：写操作没有走任何审批往返");
    const meta = await http(srv.port, "GET", "/meta", {});
    info("GET /meta（免令牌只读摘要）：" + JSON.stringify(meta.json).slice(0, 300));
    const auditRes = await http(srv.port, "GET", "/ctl/audit", { token: srv.token });
    const entries = (auditRes.json && auditRes.json.entries) || [];
    const editEntries = entries.filter((e) => e && e.tool === "mtnode_canvas_edit");
    step(
      "服务端审计逐笔入账（本次 canvas_edit 全在册）",
      editEntries.length >= 3,
      "最近 " + entries.length + " 条审计里 canvas_edit " + editEntries.length + " 笔 · 最近一条：" +
        JSON.stringify((entries[0] || {})).slice(0, 160),
    );
    /* 只统计「真调用」那批：故意的反向用例（无令牌被拒 = 401）与自检结论不计入 */
    const calls = results.filter(
      (r) => !/^(无令牌被拒|总结|脚本执行异常)/.test(r.name),
    );
    const badIx = calls.filter((r) => !r.ok || /401|403|已拒绝|需确认|不在允许|denied/i.test(r.detail));
    const editOk = calls.filter((r) => r.ok && /canvas_edit/.test(r.name)).length;
    step(
      "写操作全部一次成功、无越权 / 审批类错误",
      editOk >= 3 && badIx.length === 0,
      "canvas_edit 成功 " + editOk + " 笔 · 越权/审批类失败 " + badIx.length + " 条（全部 HTTP 200、无 401/403）",
    );
    const auditFile = path.join(srv.dataRoot, "mcp-audit");
    let auditFiles = [];
    try {
      auditFiles = fs.readdirSync(auditFile);
    } catch {}
    step("审计文件落在数据目录（不是应用目录）", auditFiles.length > 0, auditFile + " → " + auditFiles.join(", "));

    phase("8 · 现场截图 + 报告落盘");
    const shot = path.join(OUT, "mcp-inchanged-shot.png");
    const cap = await cli.call(
      "mtnode_assets",
      { action: "screenshot", path: shot },
      120000,
    );
    const shotOk = fs.existsSync(shot);
    step("整窗截图落盘", shotOk, shot + (shotOk ? "（" + fs.statSync(shot).size + " 字节）" : " · " + cap.text.replace(/\s+/g, " ").slice(0, 160)));
    report.screenshot = shotOk ? shot : null;

    /* 收尾再读一次全画布，留一份完整现场 */
    const g5 = await cli.call("mtnode_canvas_get", { detail: "full" });
    const finalNodes = (g5.json || {}).nodes || [];
    fs.writeFileSync(path.join(OUT, "mcp-inchanged-final-canvas.json"), JSON.stringify(g5.json, null, 2), "utf8");
    step("最终画布快照落盘（detail=full）", finalNodes.length > 0, path.join(OUT, "mcp-inchanged-final-canvas.json") + " · " + finalNodes.length + " 节点");

    const bad = results.filter((r) => !r.ok);
    step("总结：本次全部断言通过", bad.length === 0, bad.length ? "失败 " + bad.length + " 条：" + bad.map((b) => "#" + b.n + " " + b.name).join("；") : results.length + " 条全绿");
    exitCode = bad.length ? 1 : 0;
  } catch (e) {
    step("脚本执行异常", false, (e && e.stack) || String(e));
    exitCode = 1;
  } finally {
    report.finishedAt = new Date().toISOString();
    report.ok = exitCode === 0;
    fs.writeFileSync(path.join(OUT, "mcp-inchanged-report.json"), JSON.stringify(report, null, 2), "utf8");
    out("");
    out("报告：" + path.join(OUT, "mcp-inchanged-report.json"));
    out("日志：" + LOG);
    if (!KEEP) {
      info("关闭干净实例（pid=" + app.pid + "）");
      try {
        spawn("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      } catch {}
      await sleep(1200);
    } else {
      info("--keep：实例保留（pid=" + app.pid + "，数据目录 " + DATA + "）");
    }
    logStream.end();
  }
  process.exit(exitCode);
}

main().catch((e) => {
  console.error("[e2e-mcp-inchanged] 失败：", (e && e.stack) || e);
  process.exit(1);
});
