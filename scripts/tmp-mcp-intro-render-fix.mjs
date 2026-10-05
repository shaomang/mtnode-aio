/**
 * 一次性收尾脚本 #2（不随包发版）：给「视频合成（Remotion）」补上描述文本与渲染参数。
 *
 * 复用既有的独立档位数据目录（必须先跑过 tmp-mcp-intro-workflow.mjs）。
 * 注意 remotion 节点的描述字段是 node.text（见 renderer/app-nodes.js §remotion patch：
 * patch.text → node.text；prompt 字段不被该分支消费），所以这里用 text 传。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
function argOf(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const PROFILE = path.resolve(argOf("--profile", path.join(ROOT, ".mcp-intro-profile")));
const DATA_DIR = path.join(PROFILE, "pipeline-console");
const ELECTRON = path.resolve(argOf("--electron", path.join(ROOT, "node_modules", "electron", "dist", "electron.exe")));
const CANVAS_NAME = "MTNode 自我介绍视频工作流";
const WAIT_MS = Number(argOf("--wait", "120000"));
const KEEP = process.argv.includes("--keep");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => process.stdout.write(s + "\n");

const RENDER_TEXT = [
  "为《MTNode 自我介绍》合成一支 1920x1080 · 30fps 的横版短视频（mp4，含字幕）。",
  "",
  "旁白是 90 秒的量；Remotion 节点时长上限 60 秒（1–60），所以先按 60 秒渲一版，",
  "长版分两段出、或把旁白压到 60 秒以内——两条都由用户在节点 ⚙ 里改。",
  "",
  "依据（上游「成片素材整备」从描述端口喂进来）：",
  "- 旁白定稿与逐句时间",
  "- 6 个镜头的镜头表（画面含动效）",
  "- 字幕清单",
  "- 视觉规范",
  "",
  "视觉要求：深色底 + 单一强调色；字幕居中底部、逐句淡入淡出；镜头之间用 0.3 秒位移过渡；节点与连线用线框示意，不出现任何真实品牌 Logo 或照片。",
  "",
  "产出：整片 mp4，交给下游「成片落盘」写盘。",
].join("\n");

let port = 0;
let token = "";
let sessionId = "";
let rpcId = 0;

async function mcp(method, params) {
  const headers = { "content-type": "application/json", accept: "application/json", authorization: "Bearer " + token };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch("http://127.0.0.1:" + port + "/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params: params || {} }),
  });
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  if (res.status !== 200 && res.status !== 202) throw new Error("HTTP " + res.status + " " + text.slice(0, 300));
  return json;
}
async function mcpRetry(method, params, tries = 5) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      return await mcp(method, params);
    } catch (e) {
      last = e;
      log("   · " + method + " 第 " + (i + 1) + " 次失败：" + ((e && e.message) || e));
      await sleep(2500);
    }
  }
  throw last;
}
async function callTool(name, args, tries = 5) {
  const msg = await mcpRetry("tools/call", { name, arguments: args || {} }, tries);
  const r = (msg && msg.result) || {};
  const text = (r.content || []).map((c) => c.text || "").join("\n");
  return { ok: !r.isError, text, structured: r.structuredContent || null };
}
function mtimeOf(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}
async function waitForServer(mtimeBefore) {
  const fp = path.join(DATA_DIR, "mcp-server.json");
  const deadline = Date.now() + WAIT_MS;
  let last = "还没生成";
  while (Date.now() < deadline) {
    const st = mtimeOf(fp);
    if (st > mtimeBefore + 500) {
      const j = JSON.parse(fs.readFileSync(fp, "utf8"));
      if (Number(j.port) > 0 && j.token) return { port: Number(j.port), token: String(j.token) };
    }
    last = "mtime=" + st;
    await sleep(1000);
  }
  throw new Error("等待 mcp-server.json 超时（" + last + "）");
}
function canvasFileOf(id) {
  return path.join(DATA_DIR, "save", id + ".json");
}

async function main() {
  const fp = path.join(DATA_DIR, "mcp-server.json");
  if (!fs.existsSync(fp)) {
    log("找不到独立档位的数据目录：" + DATA_DIR);
    process.exit(2);
  }
  const stale = mtimeOf(fp);
  const fd = fs.openSync(path.join(PROFILE, "app.out.log"), "a");
  const app = spawn(ELECTRON, ["--user-data-dir=" + path.join(PROFILE, "userdata"), ROOT, "--mcp-intro-profile"], {
    cwd: ROOT,
    env: { ...process.env, MTNODE_DATA_DIR: PROFILE, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
    stdio: ["ignore", fd, fd],
  });
  log("拉起独立实例 pid=" + app.pid);
  const srv = await waitForServer(stale);
  port = srv.port;
  token = srv.token;
  await mcpRetry("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "intro-render-fix", version: "1.0" } });
  await mcpRetry("notifications/initialized", {});
  log("MCP 就绪 port=" + port);

  const before = await callTool("mtnode_canvas_get", { detail: "standard", canvas: CANVAS_NAME, sections: ["nodes"] });
  const b = before.structured || {};
  const hash = b.contentHash || "";
  const nodes = b.nodes || [];
  const render = nodes.find((n) => n.title === "视频合成（Remotion）");
  const out = nodes.find((n) => n.title === "成片落盘");
  const canvasId = (b.workflow && b.workflow.id) || "";
  log("读图 hash=" + hash + " · 画布 id=" + canvasId);
  log("Remotion 节点现值：" + JSON.stringify({ size: render && render.size, fps: render && render.fps, duration: render && render.duration, textLen: render && render.textLen }));
  log("落盘节点现值：" + JSON.stringify({ savePath: out && out.savePath }));

  const edit = await callTool("mtnode_canvas_edit", {
    baseHash: hash,
    canvas: CANVAS_NAME,
    update: [
      { id: render.id, text: RENDER_TEXT, size: "1920x1080", remotionSize: "1920x1080", fps: 30, duration: 60 },
    ],
  });
  log("补参数回执 ok=" + edit.ok + " warnings=" + JSON.stringify((edit.structured && edit.structured.warnings) || []));
  if (!edit.ok) log(edit.text.slice(0, 500));

  await sleep(2500); /* 等渲染层落盘 */
  const after = await callTool("mtnode_canvas_get", { detail: "standard", canvas: CANVAS_NAME, sections: ["nodes"], ids: ["视频合成（Remotion）", "成片落盘"] });
  const a = after.structured || {};
  log("回读：" + JSON.stringify((a.nodes || []).map((n) => ({ t: n.title, size: n.size, fps: n.fps, duration: n.duration, textLen: n.textLen, savePath: n.savePath }))));
  if (canvasId) {
    const f = canvasFileOf(canvasId);
    if (fs.existsSync(f)) {
      const j = JSON.parse(fs.readFileSync(f, "utf8"));
      const rn = (j.nodes || []).find((n) => n.kind === "remotion");
      log("磁盘复核 " + path.basename(f) + "：remotion text=" + String(rn && rn.text || "").length + " 字 · size=" + (rn && rn.size) + " fps=" + (rn && rn.fps) + " duration=" + (rn && rn.duration));
    }
  }
  fs.writeFileSync(
    path.join(PROFILE, "report-render.json"),
    JSON.stringify({ at: new Date().toISOString(), canvasId, before: render, edit: edit.structured || edit.text, after: a }, null, 2),
    "utf8",
  );
  if (!KEEP) {
    spawn("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore" });
    log("已关闭独立实例");
  }
}

main().catch((e) => {
  log("RESULT: FAIL — " + ((e && e.stack) || e));
  process.exit(1);
});
