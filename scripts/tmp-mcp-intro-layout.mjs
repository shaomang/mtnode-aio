/**
 * 一次性收尾脚本（不随包发版）：对「MTNode 自我介绍视频工作流」这张展示画布做排版收尾 ——
 * 经 MTNode 自带 MCP 服务端（POST /mcp）把节点摆成一条清清楚楚的链，并补一条说明标注。
 * 与 tmp-mcp-intro-workflow.mjs 用同一个独立数据目录（--profile），不碰用户默认数据目录。
 *
 * 只读现场：不改仓库源码、不碰用户正在用的数据目录。
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

/* ── 目标排版：左列输入 / 加工自下而上，右列合成与落盘（y 小 = 靠上） ─────── */
const LAYOUT = {
  brief: { x: 40, y: 40, w: 360, h: 240 },
  vo: { x: 40, y: 330, w: 460, h: 300 },
  sb: { x: 40, y: 690, w: 460, h: 280 },
  pack: { x: 40, y: 1030, w: 460, h: 320 },
  render: { x: 620, y: 380, w: 520, h: 380 },
  out: { x: 620, y: 860, w: 460, h: 300 },
};

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

function serverStateMtime() {
  try {
    return fs.statSync(path.join(DATA_DIR, "mcp-server.json")).mtimeMs;
  } catch {
    return 0;
  }
}

async function waitForServer(mtimeBefore) {
  const fp = path.join(DATA_DIR, "mcp-server.json");
  const deadline = Date.now() + WAIT_MS;
  let last = "还没生成";
  while (Date.now() < deadline) {
    try {
      const st = fs.statSync(fp);
      const j = JSON.parse(fs.readFileSync(fp, "utf8"));
      if (st.mtimeMs > mtimeBefore + 500 && j && Number(j.port) > 0 && j.token)
        return { port: Number(j.port), token: String(j.token) };
      last = "port=" + (j && j.port) + " mtime=" + st.mtimeMs;
    } catch (e) {
      last = (e && e.message) || String(e);
    }
    await sleep(1000);
  }
  throw new Error("等待 mcp-server.json 超时（" + last + "）");
}

async function main() {
  if (!fs.existsSync(path.join(DATA_DIR, "mcp-server.json"))) {
    log("找不到独立档位的数据目录：" + DATA_DIR + "（先跑 tmp-mcp-intro-workflow.mjs）");
    process.exit(2);
  }
  const stale = serverStateMtime();
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
  log("MCP 就绪 port=" + port);

  await mcpRetry("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "intro-layout", version: "1.0" } });
  await mcpRetry("notifications/initialized", {});

  const before = await callTool("mtnode_canvas_get", { detail: "standard", canvas: CANVAS_NAME, sections: ["nodes"] });
  const b = before.structured || {};
  const hash = b.contentHash || "";
  const byTitle = new Map(((b.nodes || [])).map((n) => [n.title, n.id]));
  log("读图：hash=" + hash + " 节点=" + (b.nodes || []).map((n) => n.title).join(" / "));

  const update = [];
  for (const [alias, box] of Object.entries(LAYOUT)) {
    const title = {
      brief: "主题与受众",
      vo: "旁白脚本",
      sb: "分镜脚本",
      pack: "成片素材整备",
      render: "视频合成（Remotion）",
      out: "成片落盘",
    }[alias];
    const id = byTitle.get(title);
    if (!id) throw new Error("画布上找不到节点：" + title);
    update.push(Object.assign({ id }, box));
  }

  const edit = await callTool("mtnode_canvas_edit", {
    baseHash: hash,
    canvas: CANVAS_NAME,
    /* layout:false = 本次不要自动排版，按我给的 x/y 摆（否则 x/y 只当起始锚点） */
    layout: false,
    update,
    /* 幂等：上一版留下的旧说明先删掉，再造新的（remove 收绘制正文精确匹配） */
    removeMarks: [
      "这一格是合成步骤：内容从端口 1「描述」喂进来（来源＝成片素材整备）。\nRemotion 属应用插件，全新环境未安装 → 节点 ▶ 会红字提示，属预期。",
    ],
    createMarks: [
      {
        kind: "text",
        x: 1180,
        y: 380,
        w: 520,
        h: 170,
        text:
          "合成这一步：内容从端口 1「描述」喂进来（来源＝成片素材整备）。\n" +
          "Remotion 属应用插件，全新环境未安装 → 节点 ▶ 会红字提示，属预期。\n" +
          "时长上限 60 秒（1–60），旁白是 90 秒的量 —— 分两段出或压到 60 秒以内，在节点 ⚙ 里改。",
        color: "#8ab4f8",
        fontSize: 16,
      },
    ],
  });
  log("排版回执 ok=" + edit.ok + " warnings=" + JSON.stringify((edit.structured && edit.structured.warnings) || []));
  if (!edit.ok) log(edit.text.slice(0, 600));

  const after = await callTool("mtnode_canvas_get", { detail: "minimal", canvas: CANVAS_NAME, sections: ["nodes", "wires", "groups", "marks"] });
  const a = after.structured || {};
  log(
    "最终：节点 " +
      (a.nodes || []).length +
      " · 连线 " +
      (a.wires || []).length +
      " · 分组 " +
      (a.groups || []).length +
      " · 绘制 " +
      (a.marks || []).length,
  );
  log("位置：" + JSON.stringify((edit.structured && edit.structured.updated ? edit.structured.updated : []).map((u) => [u.title, u.x, u.y, u.w, u.h])));
  fs.writeFileSync(
    path.join(PROFILE, "report-layout.json"),
    JSON.stringify({ at: new Date().toISOString(), hash, edit: edit.structured || edit.text, after: a }, null, 2),
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
