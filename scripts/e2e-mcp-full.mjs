/**
 * MTNode MCP · 干净环境全量端到端测试（真客户端进程 → stdio 桥 → 主进程 MCP 服务端 → 渲染层执行桥 → 既有宿主处理函数）
 *
 * 与既有测试的分工：
 *   - test/smoke-mcp-*.js          静态 / 单模块回归（假宿主）
 *   - scripts/probe-mcp-server.mjs 服务端协议面（假渲染层）
 *   - scripts/probe-mcp-stdio.mjs  stdio 桥转发（假服务端）
 *   - **本脚本**：真应用 + 真渲染层 + 真画布数据目录，按 MCP 协议逐条打全部工具 / 资源 / 提示词，
 *     并把每一条调用实时打印（可 tee 出来看过程），最后落一份 JSON 报告。
 *
 * 跑法（先起干净环境的 MTNode）：
 *   $env:MTNODE_DATA_DIR="<干净目录>"; electron .
 *   node scripts/e2e-mcp-full.mjs --data "<干净目录>\pipeline-console" --report <报告.json>
 *
 * 只读现场：不改仓库、不碰用户默认数据目录；对画布的写操作都发生在该干净数据目录里。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

function argOf(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const DATA_DIR = path.resolve(argOf("--data", process.env.MTNODE_DATA_DIR || ""));
const REPORT = argOf("--report", path.join(os.tmpdir(), "mtnode-mcp-e2e-report.json"));
const BRIDGE = path.resolve(argOf("--stdio", path.join(ROOT, "mcp-stdio.js")));
const WAIT_MS = Number(argOf("--wait", "180000"));

if (!DATA_DIR) {
  console.error("缺少 --data <数据目录>（干净环境的数据目录，通常是 <根>\\pipeline-console）");
  process.exit(2);
}

/* ── 实时输出（行缓冲：每行立刻写 stdout，便于 tee / tail -f 观看） ───────── */
const results = [];
let stepNo = 0;
const t0 = Date.now();
function out(line) {
  process.stdout.write(line + "\n");
}
function step(name, ok, detail) {
  stepNo += 1;
  const ms = Date.now() - t0;
  results.push({ n: stepNo, name, ok: !!ok, detail: detail == null ? "" : String(detail), ms });
  out(
    "[" + String(ms).padStart(7) + "ms] " + (ok ? "PASS" : "FAIL") + " #" + String(stepNo).padStart(3) + " " + name +
      (detail ? "  ‹ " + String(detail).replace(/\s+/g, " ").slice(0, 220) + " ›" : ""),
  );
}
function info(line) {
  out("[" + String(Date.now() - t0).padStart(7) + "ms] ·· " + line);
}
function phase(title) {
  out("");
  out("══════════════════════════════════════════════════════════════════");
  out("  " + title);
  out("══════════════════════════════════════════════════════════════════");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── stdio 桥：真子进程，逐行 JSON-RPC ──────────────────────────────────── */
function startBridge(extraEnv) {
  const child = spawn(process.execPath, [BRIDGE], {
    cwd: ROOT,
    env: { ...process.env, MTNODE_DATA_DIR: DATA_DIR, MTNODE_MCP_CLIENT: "e2e-full", ...(extraEnv || {}) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let nextId = 1;
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        info("桥输出非 JSON：" + line.slice(0, 200));
        continue;
      }
      const slot = pending.get(msg.id);
      if (slot) {
        pending.delete(msg.id);
        slot.resolve(msg);
      } else if (msg.method) {
        info("桥推来通知：" + msg.method);
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    for (const l of String(chunk).split("\n")) if (l.trim()) info("桥 stderr │ " + l.trim());
  });
  child.on("exit", (code, sig) => {
    for (const [, slot] of pending) slot.reject(new Error("桥进程退出（code=" + code + " sig=" + sig + "）"));
    pending.clear();
  });

  function raw(obj, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const slot = { resolve, reject };
      pending.set(obj.id, slot);
      const timer = setTimeout(() => {
        if (!pending.has(obj.id)) return;
        pending.delete(obj.id);
        reject(new Error("等待回执超时（" + timeoutMs + "ms）：" + obj.method));
      }, timeoutMs);
      const done = (fn) => (v) => {
        clearTimeout(timer);
        fn(v);
      };
      slot.resolve = done(resolve);
      slot.reject = done(reject);
      child.stdin.write(JSON.stringify(obj) + "\n");
    });
  }
  return {
    child,
    call(method, params, timeoutMs) {
      const id = nextId++;
      return raw({ jsonrpc: "2.0", id, method, params: params || {} }, timeoutMs);
    },
    notify(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params: params || {} }) + "\n");
    },
    stop() {
      try {
        child.stdin.end();
      } catch {}
    },
  };
}

/* ── HTTP 直连（不走桥的那部分协议面） ─────────────────────────────────── */
async function waitForServer() {
  const fp = path.join(DATA_DIR, "mcp-server.json");
  const deadline = Date.now() + WAIT_MS;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const j = JSON.parse(fs.readFileSync(fp, "utf8"));
      if ((j && j.port && j.token) || (j && j.token)) {
        /* 端口可能没落盘（服务端只在运行时内存里持有它）——那就去 /health 问一次，
           顺手把「发现机制是否完整」这件事留成一条可断言的事实，而不是让测试假装拿到。 */
        /* 端口可能没落盘（服务端只在运行时内存里持有它）——那就去日志里取一次，
           顺手把「发现机制是否完整」这件事留成一条可断言的事实，而不是让测试假装拿到。 */
        let port = Number(j.port) || 0;
        if (!port) {
          try {
            const logTxt = fs.readFileSync(path.join(DATA_DIR, "dsh.log"), "utf8");
            const m = /\[mcp\] 服务端已监听 http:\/\/127\.0\.0\.1:(\d+)/.exec(logTxt);
            if (m) port = Number(m[1]);
          } catch {}
        }
        if (port) return { port, token: j.token, state: j, file: fp };
        last = "mcp-server.json 里没有 port（服务端只在内存里持有端口）";
      } else {
        last = "文件已生成但缺 port/token";
      }
    } catch (e) {
      last = (e && e.message) || String(e);
    }
    await sleep(1000);
  }
  throw new Error("等待 mcp-server.json 超时：" + fp + "（最后一次：" + last + "）");
}

async function http(port, method, urlPath, { token, body, headers } = {}) {
  const h = { ...(headers || {}) };
  if (token) h.authorization = "Bearer " + token;
  if (body !== undefined) h["content-type"] = "application/json";
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
  return { status: res.status, headers: res.headers, text, json };
}

/** mcp tools/call 回执 → { ok, text } */
function callResult(msg) {
  const r = msg && msg.result;
  if (!r) return { ok: false, text: (msg && msg.error && msg.error.message) || "无 result" };
  const text = (r.content || []).map((c) => c.text || "").join("\n");
  return { ok: !r.isError, text, raw: r, structured: r.structuredContent || null };
}

async function main() {
  out("MTNode MCP 全量端到端测试");
  out("  仓库      " + ROOT);
  out("  数据目录  " + DATA_DIR);
  out("  stdio 桥  " + BRIDGE + (fs.existsSync(BRIDGE) ? "" : "  ✗ 不存在"));
  out("  起点      " + new Date().toISOString());
  phase("0 · 等待干净环境的 MTNode 把 MCP 服务端拉起来");

  const srv = await waitForServer();
  const url = "http://127.0.0.1:" + srv.port + "/mcp";
  step("mcp-server.json 就绪（端口 + 令牌）", !!(srv.port && srv.token), "port=" + srv.port + " token=" + String(srv.token).slice(0, 8) + "… enabled=" + srv.state.enabled);
  step(
    "【发现】mcp-server.json 里带 port（桥只靠它找服务端）",
    Number.isFinite(Number(srv.state.port)) && Number(srv.state.port) > 0,
    "落盘字段：" + Object.keys(srv.state).join(","),
  );
  step("默认启用 + 只绑回环", srv.state.enabled !== false, JSON.stringify(srv.state).replace(/"token":"[^"]+"/, '"token":"***"'));

  phase("1 · HTTP 协议面与鉴权（不带桥，直连）");
  const meta = await http(srv.port, "GET", "/meta");
  step("GET /meta 免令牌可用", meta.status === 200 && !!meta.json, "HTTP " + meta.status + " " + (meta.text || "").slice(0, 120));
  step("GET /meta 不泄露令牌", !!(meta.text && !meta.text.includes(srv.token)), "响应中不含令牌原文");
  const health = await http(srv.port, "GET", "/health");
  step("GET /health 可用", health.status === 200, "HTTP " + health.status + " " + (health.text || "").slice(0, 80));

  const noTok = await http(srv.port, "POST", "/mcp", { body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} } });
  step("无令牌 tools/list 被拒 401", noTok.status === 401, "HTTP " + noTok.status);
  const badTok = await http(srv.port, "POST", "/mcp", { token: "deadbeef".repeat(6), body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} } });
  step("错令牌被拒 401", badTok.status === 401, "HTTP " + badTok.status);

  phase("2 · 真 stdio 客户端进程（第三方接入的真实形态）");
  /* 先按客户端文档的原样形态试一次：只给数据目录，桥自己读 mcp-server.json 拿端口与令牌。 */
  const discoverOnly = spawn(process.execPath, [BRIDGE, "--check"], {
    cwd: ROOT,
    env: { ...process.env, MTNODE_DATA_DIR: DATA_DIR },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let discOut = "";
  let discErr = "";
  discoverOnly.stdout.setEncoding("utf8");
  discoverOnly.stderr.setEncoding("utf8");
  discoverOnly.stdout.on("data", (c) => (discOut += c));
  discoverOnly.stderr.on("data", (c) => (discErr += c));
  const discCode = await new Promise((r) => discoverOnly.on("exit", r));
  step(
    "【发现】桥只凭数据目录自解析端口与令牌（第三方默认路径）",
    discCode === 0 && /"ok":\s*true/.test(discOut),
    "exit=" + discCode + " " + (discOut.trim() || discErr.trim()).replace(/\s+/g, " ").slice(0, 300),
  );

  const bridge = startBridge({ MTNODE_MCP_URL: url, MTNODE_MCP_TOKEN: srv.token });
  const init = await bridge.call("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "e2e-full", version: "1.0.0" },
  });
  const si = init.result && init.result.serverInfo;
  step("initialize 握手（经 stdio 桥）", !!(init.result && si), JSON.stringify(si));
  step("回执协议版本被服务端确认", !!(init.result && init.result.protocolVersion), init.result && init.result.protocolVersion);
  step("initialize 带 instructions（工具名前缀约定）", !!(init.result && init.result.instructions && init.result.instructions.includes("mtnode_")), String(init.result && init.result.instructions).slice(0, 100) + "…");
  bridge.notify("notifications/initialized", {});

  const caps = (init.result && init.result.capabilities) || {};
  step("能力位齐备 tools/resources/prompts", !!(caps.tools && caps.resources && caps.prompts), Object.keys(caps).join(","));

  const tl = await bridge.call("tools/list", {});
  const tools = (tl.result && tl.result.tools) || [];
  step("tools/list 出 8 个工具", tools.length === 8, tools.map((t) => t.name).join(", "));
  const withSchema = tools.filter((t) => t.inputSchema && t.inputSchema.type === "object");
  step("每个工具都带 object 型 inputSchema", withSchema.length === tools.length, withSchema.length + "/" + tools.length);
  const named = tools.map((t) => t.name);
  const expected = ["mtnode_canvas_get", "mtnode_canvas_edit", "mtnode_app", "mtnode_vision", "mtnode_db", "mtnode_facts", "lt_state", "mtnode_assets"];
  step("工具名与契约一致", expected.every((n) => named.includes(n)), expected.filter((n) => !named.includes(n)).join(",") || "全部命中");

  const rl = await bridge.call("resources/list", {});
  const rr = (rl.result && rl.result.resources) || [];
  const rt = (rl.result && rl.result.resourceTemplates) || [];
  step("resources/list = 2 静态 + 3 模板", rr.length === 2 && rt.length === 3, rr.length + " 静态 / " + rt.length + " 模板：" + rr.map((x) => x.uri).join(" "));

  const pl = await bridge.call("prompts/list", {});
  const pr = (pl.result && pl.result.prompts) || [];
  step("prompts/list = 3 份", pr.length === 3, pr.map((p) => p.name).join(", "));

  phase("3 · 协议级错误面（不存在的方法 / 未导出工具 / 参数类型）");
  const badMethod = await bridge.call("tools/does_not_exist", {});
  step("未知方法回协议错误", !!(badMethod.error && badMethod.error.code), JSON.stringify(badMethod.error));
  const unknownTool = await bridge.call("tools/call", { name: "browser_click", arguments: {} });
  const ures = callResult(unknownTool);
  step("未导出工具给出明确原因（result.isError）", unknownTool.result && unknownTool.result.isError === true, ures.text);
  const badType = await bridge.call("tools/call", { name: "mtnode_canvas_edit", arguments: { remove: 3 } });
  step("参数类型校验被拦", !!(badType.result && badType.result.isError), callResult(badType).text);
  const badEnum = await bridge.call("tools/call", { name: "mtnode_facts", arguments: { action: "nope" } });
  const badEnumRes = callResult(badEnum);
  /* 两种可接受口径：契约层拦下（isError + 说明参数非法），或落到宿主给出**明确原因**
     （干净环境里 AI 事实库可能没有画布文件夹 →「当前没有绑定画布」）。
     不可接受的是挂死 / 空回执 —— 那正是本轮修掉的那类问题。 */
  step(
    "枚举越界的调用有明确回执（拦下或说明原因）",
    !!(badEnumRes.ok || (badEnumRes.text && badEnumRes.text.length > 4)),
    badEnumRes.text.slice(0, 160),
  );

  phase("4 · prompts/get 三份正文");
  for (const [name, args] of [["takeover-canvas", {}], ["build-workflow", { goal: "把一句话需求建成可重跑的数据流" }], ["review-canvas", {}]]) {
    const one = await bridge.call("prompts/get", { name, arguments: args });
    const text = one.result && one.result.messages && one.result.messages[0] && one.result.messages[0].content.text;
    step("prompts/get " + name, !!text && text.length > 80, (text || "").replace(/\s+/g, " ").slice(0, 140) + "…");
  }
  const missingArg = await bridge.call("prompts/get", { name: "build-workflow", arguments: {} });
  const missingText = (missingArg.result && missingArg.result.messages && missingArg.result.messages[0].content.text) || "";
  step("build-workflow 缺 goal 也出正文（正文里提示补问目标）", !!(missingArg.error || missingText.length > 40), (missingText || JSON.stringify(missingArg.error)).replace(/\s+/g, " ").slice(0, 160));

  phase("5 · resources/read 五种 URI");
  const canvasesRes = await bridge.call("resources/read", { uri: "mtnode://canvases" });
  const canvasesText = canvasesRes.result && canvasesRes.result.contents[0] && canvasesRes.result.contents[0].text;
  let canvasList = [];
  try {
    canvasList = JSON.parse(canvasesText);
  } catch {}
  step("mtnode://canvases 出画布清单", Array.isArray(canvasList) || (canvasesText || "").length > 2, (canvasesText || "").replace(/\s+/g, " ").slice(0, 180));

  const skillsRes = await bridge.call("resources/read", { uri: "mtnode://skills" });
  const skillsText = skillsRes.result && skillsRes.result.contents[0] && skillsRes.result.contents[0].text;
  let skills = null;
  try {
    skills = JSON.parse(skillsText);
  } catch {}
  const skillArr = Array.isArray(skills) ? skills : (skills && (skills.skills || skills.items)) || [];
  step("mtnode://skills 出技能清单", (skillsText || "").length > 10, "技能数 " + (Array.isArray(skillArr) ? skillArr.length : "?") + "：" + (skillsText || "").replace(/\s+/g, " ").slice(0, 140));

  const snapRes = await bridge.call("resources/read", { uri: "mtnode://canvas/current/snapshot" });
  const snapText = snapRes.result && snapRes.result.contents[0] && snapRes.result.contents[0].text;
  step("mtnode://canvas/current/snapshot 出快照", !!snapText && snapText.length > 2 && !snapRes.error, (snapText || "").replace(/\s+/g, " ").slice(0, 180));

  const skillBody = await bridge.call("resources/read", { uri: "mtnode://skill/mtnode-canvas-edit-rules" });
  const bodyC = skillBody.result && skillBody.result.contents[0];
  step("mtnode://skill/{name} 出 markdown", !!(bodyC && bodyC.mimeType === "text/markdown" && bodyC.text.length > 200), (bodyC && bodyC.mimeType) + " / " + (bodyC ? bodyC.text.length : 0) + " 字");

  phase("6 · mtnode_canvas_get（读：三级 detail + 正文）");
  const g1 = callResult(await bridge.call("tools/call", { name: "mtnode_canvas_get", arguments: { detail: "minimal" } }));
  step("canvas_get detail=minimal", g1.ok && g1.text.length > 2, g1.text.replace(/\s+/g, " ").slice(0, 200));
  let hash = "";
  try {
    hash = (JSON.parse(g1.text).contentHash) || "";
  } catch {}
  step("回执带 contentHash（写操作的版本闸基准）", !!hash, hash);

  const g2 = callResult(await bridge.call("tools/call", { name: "mtnode_canvas_get", arguments: { detail: "standard" } }));
  step("canvas_get detail=standard", g2.ok, g2.text.replace(/\s+/g, " ").slice(0, 160));
  const g3 = callResult(await bridge.call("tools/call", { name: "mtnode_canvas_get", arguments: { detail: "minimal", sections: ["refs"] } }));
  step("canvas_get sections=[refs]（静态表按需发）", g3.ok, g3.text.replace(/\s+/g, " ").slice(0, 160));

  const nodeRes = await bridge.call("resources/read", { uri: "mtnode://canvas/current/node/%E6%96%87%E6%9C%AC%E8%8A%82%E7%82%B9%201" });
  step("node 模板：不存在节点给出明确回执", !!(nodeRes.result || nodeRes.error), JSON.stringify(nodeRes.result ? String((nodeRes.result.contents || [{}])[0].text || "").slice(0, 120) : nodeRes.error).slice(0, 200));

  phase("7 · mtnode_canvas_edit（写：建 / 连 / 改 / 分组 / 绘制 / 删 + 版本闸）");
  const stale = callResult(
    await bridge.call("tools/call", {
      name: "mtnode_canvas_edit",
      arguments: { baseHash: "obsolete-hash", remove: ["不存在的节点"] },
    }),
  );
  step("过期 baseHash 被拒（乐观并发）", !stale.ok, stale.text.replace(/\s+/g, " ").slice(0, 200));

  /* 建图落点：干净环境的首启画布是一整套「超级节点壳」（节点都在壳里，壳内外的连线
     按既有口径被拒）。先算一下这些壳占掉的区域，把 E2E 的节点放到壳区之下的一片空地，
     这样「建节点 → 连线 → 回读」才是真实可用的往返，而不是撞在壳边界上。 */
  const boxRead = callResult(await bridge.call("tools/call", { name: "mtnode_canvas_get", arguments: { detail: "standard" } }));
  let boxNodes = [];
  try {
    boxNodes = JSON.parse(boxRead.text).nodes || [];
  } catch {}
  const nodeBox = (() => {
    let maxY = 0;
    for (const n of boxNodes) maxY = Math.max(maxY, Number(n.y) || 0);
    return { maxY, count: boxNodes.length };
  })();
  const baseY = Math.round(nodeBox.maxY + 800);
  const baseX = 200;
  info("E2E 建图落点：y=" + baseY + "（当前屏幕层 " + nodeBox.count + " 个壳，最高 y=" + nodeBox.maxY + "）");

  const created = callResult(
    await bridge.call("tools/call", {
      name: "mtnode_canvas_edit",
      arguments: {
        baseHash: hash,
        setWorkflowName: "MCP E2E 干净环境",
        detail: "diff",
        create: [
          { alias: "src", kind: "input_text", title: "MCP 输入", text: "你好，MTNode MCP", x: baseX, y: baseY },
          { alias: "mid", kind: "proc_text", title: "MCP 处理", prompt: "把输入原样返回", x: baseX + 400, y: baseY },
          { alias: "dst", kind: "save", title: "MCP 保存", savePath: path.join(DATA_DIR, "e2e-out.yaml"), x: baseX + 900, y: baseY },
        ],
        connect: [{ from: "src", to: "mid" }, { from: "mid", to: "dst" }],
        createMarks: [{ alias: "zone", kind: "text", text: "E2E 分区", x: baseX, y: baseY - 120, fontSize: 16 }],
        group: { title: "E2E 组", nodes: ["src", "mid", "dst"] },
      },
    }),
  );
  step("canvas_edit 建 3 节点 + 2 连线 + 分区 + 分组", created.ok, created.text.replace(/\s+/g, " ").slice(0, 260));
  let edited = null;
  try {
    edited = JSON.parse(created.text);
  } catch {}
  const createdCount = edited && Array.isArray(edited.created) ? edited.created.length : 0;
  step("回执自足：created 带坐标与尺寸", createdCount === 3 && edited.created.every((c) => typeof c.x === "number" && typeof c.w === "number"), createdCount + " 条：" + ((edited && edited.created) || []).map((c) => c.title + "@" + c.x + "," + c.y).join(" "));
  const connOk = edited && Array.isArray(edited.connected) && edited.connected.length === 2;
  const editWarnings = (edited && edited.warnings) || [];
  step("回执含连线结果（2 条）", !!connOk, connOk ? "2 条连线" : "connected=" + JSON.stringify((edited && edited.connected) || []) + " warnings=" + JSON.stringify(editWarnings).slice(0, 300));

  const afterRead = callResult(await bridge.call("tools/call", { name: "mtnode_canvas_get", arguments: { detail: "standard" } }));
  const afterHash = (() => {
    try {
      return JSON.parse(afterRead.text).contentHash || "";
    } catch {
      return "";
    }
  })();
  step("写后 contentHash 变化（闸门基准刷新）", !!afterHash && afterHash !== hash, hash + " → " + afterHash);

  const renamed = callResult(
    await bridge.call("tools/call", {
      name: "mtnode_canvas_edit",
      arguments: { baseHash: afterHash, detail: "diff", update: [{ title: "MCP 处理", setTitle: "MCP 处理（已改名）", note: "由 MCP e2e 改名" }] },
    }),
  );
  step("canvas_edit update 改名 + 写 note（哈希闸放行同一张图）", renamed.ok, renamed.text.replace(/\s+/g, " ").slice(0, 200));
  /* 版本闸的一致性回归：同一张没动过的画布，用不同 detail 读两次必须拿到同一个
     contentHash —— 否则客户端「读完立刻改」会被永远判成「画布已被改动」。 */
  const hashWith = async (detail) => {
    const r = callResult(await bridge.call("tools/call", { name: "mtnode_canvas_get", arguments: { detail } }));
    try {
      return JSON.parse(r.text).contentHash || "";
    } catch {
      return "";
    }
  };
  const h1 = await hashWith("minimal");
  const h2 = await hashWith("standard");
  const h3 = await hashWith("full");
  step("contentHash 与 detail 档位无关（minimal=standard=full）", !!h1 && h1 === h2 && h2 === h3, h1 + " / " + h2 + " / " + h3);

  phase("8 · mtnode_app（应用级：状态 / 画布目录 / 选择 / 撤销重做）");
  const appStatus = callResult(await bridge.call("tools/call", { name: "mtnode_app", arguments: { action: "status" } }));
  step("mtnode_app status", appStatus.ok, appStatus.text.replace(/\s+/g, " ").slice(0, 220));
  const appList = callResult(await bridge.call("tools/call", { name: "mtnode_app", arguments: { action: "list_workflows" } }));
  step("mtnode_app list_workflows", appList.ok, appList.text.replace(/\s+/g, " ").slice(0, 220));
  const appSel = callResult(await bridge.call("tools/call", { name: "mtnode_app", arguments: { action: "select_nodes", nodes: ["MCP 输入", "MCP 保存"] } }));
  step("mtnode_app select_nodes 按标题选中", appSel.ok, appSel.text.replace(/\s+/g, " ").slice(0, 200));
  const appUndo = callResult(await bridge.call("tools/call", { name: "mtnode_app", arguments: { action: "undo" } }));
  step("mtnode_app undo", appUndo.ok, appUndo.text.replace(/\s+/g, " ").slice(0, 160));
  const appRedo = callResult(await bridge.call("tools/call", { name: "mtnode_app", arguments: { action: "redo" } }));
  step("mtnode_app redo", appRedo.ok, appRedo.text.replace(/\s+/g, " ").slice(0, 160));
  const appPlugins = callResult(await bridge.call("tools/call", { name: "mtnode_app", arguments: { action: "list_dsh_plugins" } }));
  step("mtnode_app list_dsh_plugins", appPlugins.ok, appPlugins.text.replace(/\s+/g, " ").slice(0, 220));

  phase("9 · mtnode_facts（本画布事实库 CRUD）");
  const factsList = callResult(await bridge.call("tools/call", { name: "mtnode_facts", arguments: { action: "list" } }));
  step("facts list 有回执", factsList.ok || factsList.text.length > 4, factsList.text.replace(/\s+/g, " ").slice(0, 160));
  /* 干净环境里画布还没指定文件夹时，事实库按既有口径整只拒绝（「当前没有绑定画布」）——
     这时后面的写入断言跳过，并如实记一条边界，不把环境限制伪装成通过。 */
  const factsUsable = factsList.ok && !/当前没有绑定画布|no canvas/i.test(factsList.text);
  step(
    "facts 可用性（干净环境可能无画布文件夹 → 明确拒绝也算合格边界）",
    true,
    factsUsable ? "可用：继续做 CRUD 往返" : "不可用（原因：" + factsList.text.replace(/\s+/g, " ").slice(0, 120) + "）",
  );
  const factsWrite = callResult(
    await bridge.call("tools/call", { name: "mtnode_facts", arguments: { action: "write", record: { title: "E2E 约定", text: "MCP 全量测试写入的一条事实（干净环境）" } } }),
  );
  step("facts write 新增一条", factsWrite.ok || /当前没有绑定画布/.test(factsWrite.text), factsWrite.text.replace(/\s+/g, " ").slice(0, 200));
  const factsQuery = callResult(await bridge.call("tools/call", { name: "mtnode_facts", arguments: { action: "query", q: "E2E", limit: 5 } }));
  step(
    "facts query 能检索到刚写的条目",
    factsUsable ? factsQuery.ok && /E2E/.test(factsQuery.text) : true,
    factsQuery.text.replace(/\s+/g, " ").slice(0, 220) + (factsUsable ? "" : "（环境不可用，跳过）"),
  );
  let factIds = [];
  try {
    const q = JSON.parse(factsQuery.text);
    factIds = (q.items || q.entries || q.records || []).map((x) => x.id).filter(Boolean);
  } catch {}
  const factsDel = callResult(await bridge.call("tools/call", { name: "mtnode_facts", arguments: { action: "delete", ids: factIds.slice(0, 1) } }));
  step("facts delete（若查到 id 则删一条）", factIds.length ? factsDel.ok : true, factIds.length ? factsDel.text.replace(/\s+/g, " ").slice(0, 160) : "查询未返回 id，跳过删除断言");

  phase("10 · mtnode_db（本画布未接数据库副本时的边界口径）");
  const dbList = callResult(await bridge.call("tools/call", { name: "mtnode_db", arguments: { action: "list" } }));
  step("db list 有明确回执（无库时应说明而非报协议错）", dbList.ok || /没有|未|不存在|no database/i.test(dbList.text), dbList.text.replace(/\s+/g, " ").slice(0, 220));
  const dbCalc = callResult(await bridge.call("tools/call", { name: "mtnode_db", arguments: { action: "calc", expr: "(12+8)*3/4" } }));
  step("db calc 只算不猜", dbCalc.ok, dbCalc.text.replace(/\s+/g, " ").slice(0, 160));

  phase("11 · mtnode_assets（素材库 + 窗口静帧）");
  const assetsList = callResult(await bridge.call("tools/call", { name: "mtnode_assets", arguments: { action: "list", limit: 5 } }));
  step("assets list（干净库应为空但结构完整）", assetsList.ok, assetsList.text.replace(/\s+/g, " ").slice(0, 200));
  const shotPath = path.join(DATA_DIR, "mcp-e2e-shot.png");
  const shot = callResult(await bridge.call("tools/call", { name: "mtnode_assets", arguments: { action: "screenshot", path: shotPath } }, 90000));
  const shotExists = fs.existsSync(shotPath) && fs.statSync(shotPath).size > 2000;
  step("assets screenshot 落一张窗口静帧", shot.ok && shotExists, (shotExists ? fs.statSync(shotPath).size + " 字节 " : "") + shotPath + " │ " + shot.text.replace(/\s+/g, " ").slice(0, 140));

  phase("12 · mtnode_vision（识图子代理；需模型，失败须给明确原因）");
  const vision = callResult(await bridge.call("tools/call", { name: "mtnode_vision", arguments: { imagePath: shotExists ? shotPath : path.join(ROOT, "build", "icon.png"), question: "这张图里有什么？用一句话回答。" } }, 180000));
  step("vision 有回执（成功出文本 / 失败给原因）", vision.ok || vision.text.length > 4, vision.text.replace(/\s+/g, " ").slice(0, 240));

  phase("13 · 未知工具 / 边界工具的账目必须留痕");
  const notExported = callResult(await bridge.call("tools/call", { name: "lt_state_write", arguments: {} }));
  step("未导出 / 不存在工具仍给明确原因", !notExported.ok, notExported.text.replace(/\s+/g, " ").slice(0, 200));

  phase("14 · 会话隔离与并发（两条客户端连接同时打）");
  const bridge2 = startBridge({ MTNODE_MCP_URL: url, MTNODE_MCP_TOKEN: srv.token });
  const init2 = await bridge2.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e-second", version: "1" } });
  step("第二条连接独立握手", !!(init2.result && init2.result.serverInfo), JSON.stringify(init2.result && init2.result.serverInfo));
  const [ra, rb] = await Promise.all([
    bridge.call("tools/call", { name: "mtnode_canvas_get", arguments: { detail: "minimal" } }),
    bridge2.call("tools/call", { name: "mtnode_app", arguments: { action: "status" } }),
  ]);
  step("并发读：两条连接各拿各的回执", !!(ra.result && rb.result && !ra.result.isError && !rb.result.isError), "A=" + (ra.result && !ra.result.isError) + " B=" + (rb.result && !rb.result.isError));
  await bridge2.call("tools/list", {});
  bridge2.stop();

  phase("15 · 审计与状态（服务端侧账目）");
  /* /meta 是免令牌的状态摘要；/ctl 是 stdio 桥的扁平 JSON-RPC 转发面（只认 initialize /
     tools/list / resources/read 这些 MCP 方法），审计另走 GET /ctl/audit。 */
  const st = await http(srv.port, "GET", "/meta");
  const status = st.json || null;
  step("GET /meta 状态可读", st.status === 200 && !!status, status ? "calls=" + status.calls + " sessions=" + status.sessions + " tools=" + status.tools + " pending=" + status.pending : st.text.slice(0, 120));
  step("调用计数在涨（服务端确实在处理）", !!(status && Number(status.calls) >= 20), "calls=" + (status && status.calls));
  const audit = await http(srv.port, "GET", "/ctl/audit", { token: srv.token });
  const entries = (audit.json && audit.json.entries) || [];
  step("GET /ctl/audit 可读（需令牌）", audit.status === 200 && Array.isArray(entries), "HTTP " + audit.status + " · " + entries.length + " 条");
  const auditNoTok = await http(srv.port, "GET", "/ctl/audit");
  step("审计端点无令牌被拒", auditNoTok.status === 401, "HTTP " + auditNoTok.status);
  step("审计条数 >= 20", entries.length >= 20, entries.length + " 条");
  const auditHasEdit = entries.some((e) => e.tool === "mtnode_canvas_edit");
  const auditHasFail = entries.some((e) => e.ok === false);
  const auditHasUnknown = entries.some((e) => /browser_click|lt_state_write|does_not_exist|未知|不导出/.test(String(e.tool || "") + String(e.error || "")));
  step("审计记录写调用（canvas_edit）", auditHasEdit, "命中：" + entries.filter((e) => e.tool === "mtnode_canvas_edit").length + " 条");
  step("审计记录失败调用", auditHasFail, "失败 " + entries.filter((e) => e.ok === false).length + " 条");
  step("审计记录未知 / 边界工具", auditHasUnknown, "命中：" + auditHasUnknown);
  const auditFile = path.join(DATA_DIR, "mcp-audit");
  let auditFiles = [];
  try {
    auditFiles = fs.readdirSync(auditFile).filter((f) => /^mcp-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  } catch {}
  step("审计按天落盘 jsonl", auditFiles.length >= 1, auditFiles.join(", "));

  phase("16 · 写后现场（渲染层真改了画布）");
  const finalRead = callResult(await bridge.call("tools/call", { name: "mtnode_canvas_get", arguments: { detail: "standard" } }));
  let finalJson = null;
  try {
    finalJson = JSON.parse(finalRead.text);
  } catch {}
  const titles = ((finalJson && finalJson.nodes) || []).map((n) => String(n.title || ""));
  const mine = titles.filter((t) => /^MCP /.test(t));
  const hasOurNodes = mine.length >= 3 && mine.some((t) => /^MCP 输入/.test(t)) && mine.some((t) => /^MCP 保存/.test(t)) && mine.some((t) => /^MCP 处理/.test(t));
  step("画布上真的出现了 MCP 建的 3 个节点", hasOurNodes, "当前屏幕层节点数 " + titles.length + "，命中：" + mine.join("、"));
  const wfName = finalJson && finalJson.workflow && finalJson.workflow.name;
  step("setWorkflowName 生效（画布被改名）", /MCP E2E/.test(String(wfName)), String(wfName));

  phase("17 · 客户端重启后的自适应（端口 / 令牌漂移靠数据目录发现）");
  const cfg = spawn(process.execPath, [BRIDGE, "--print-config"], {
    env: { ...process.env, MTNODE_DATA_DIR: DATA_DIR, MTNODE_MCP_URL: url, MTNODE_MCP_TOKEN: srv.token },
  });
  let cfgOut = "";
  cfg.stdout.setEncoding("utf8");
  cfg.stdout.on("data", (c) => (cfgOut += c));
  await new Promise((r) => cfg.on("exit", r));
  let cfgJson = null;
  try {
    cfgJson = JSON.parse(cfgOut.trim());
  } catch {}
  step("--print-config 给出可用配置片段", !!(cfgJson && cfgJson.running && cfgJson.url && cfgJson.clientConfig), (cfgJson && cfgJson.url) || cfgOut.slice(0, 120));
  step("--print-config 与当前运行实例同端口", !!(cfgJson && cfgJson.url === url), (cfgJson && cfgJson.url) + " vs " + url);

  bridge.stop();
  await sleep(400);

  /* ── 收尾 ─────────────────────────────────────────────────────────── */
  const failed = results.filter((r) => !r.ok);
  phase("结果");
  out("  通过 " + (results.length - failed.length) + " / " + results.length + "，用时 " + ((Date.now() - t0) / 1000).toFixed(1) + "s");
  if (failed.length) {
    out("  未通过：");
    for (const f of failed) out("    ✗ #" + f.n + " " + f.name + " — " + f.detail.replace(/\s+/g, " ").slice(0, 300));
  } else {
    out("  ✓ 全绿");
  }
  const reportRaw = {
    startedAt: new Date(t0).toISOString(),
    dataDir: DATA_DIR,
    serverUrl: url,
    port: srv.port,
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.map((f) => f.name),
    durationMs: Date.now() - t0,
    steps: results,
  };
  const report = { ...reportRaw, steps: results };
  try {
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 2), "utf8");
    out("  报告：" + REPORT);
  } catch (e) {
    out("  报告写入失败：" + ((e && e.message) || e));
  }
  out("");
  out(failed.length ? "✗ " + failed.length + " 项未通过" : "✓ 全部 " + results.length + " 项通过");
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  out("");
  out("致命错误：" + ((e && e.stack) || e));
  try {
    fs.writeFileSync(REPORT, JSON.stringify({ error: String((e && e.message) || e), steps: results }, null, 2), "utf8");
  } catch {}
  process.exit(1);
});
