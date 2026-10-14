#!/usr/bin/env node
/* scripts/probe-paseo-bridge.mjs — 「Paseo 桥」真机探针（真 MTNode + 真桥进程 + 真 ACP 客户端）
 *
 * 为什么要有它：本功能是三段接力（MTNode 本地会话族 → 桥 → 手机端），三段里任何一段断了
 * 都表现为「手机上没反应」。自动冒烟（test/smoke-*.js）里两头都是假的，能在真机上跑一遍的
 * 只有这一只：它**不冒充手机**，只把「桥真的能对着在跑的 MTNode 走完 ACP 的一整轮」钉住。
 *
 *   node scripts/probe-paseo-bridge.mjs                    # 用数据目录里在跑的那个 MTNode
 *   node scripts/probe-paseo-bridge.mjs --data <数据目录>   # 指定数据目录
 *   node scripts/probe-paseo-bridge.mjs --keep             # 保留探针建的那条会话（默认删）
 *   node scripts/probe-paseo-bridge.mjs --turn-timeout 90000  # 等一轮跑完的上限（默认 25 秒）
 *
 * 做九件事（每件都打印可复核的一句）：
 *   1 找数据目录 → 读 mcp-server.json 拿端口与令牌 → GET /health 探活
 *   2 /ctl session/tools（旧实例会回「不支持的方法」—— 那就先重启 MTNode 再来）
 *   3 /ctl session/list：真会话清单
 *   4 /ctl session/read：读回一条真会话的消息（取最后一条 user 消息当探针 prompt）
 *   5 /ctl session/models：供应商 + 模型清单（手机新建会话时选的那份）
 *   6 起真桥进程（node paseo/acp-bridge.mjs）→ ACP initialize（协议版本 / 能力位）
 *   7 ACP session/new → 在 MTNode 真建一条会话（记下 id，收尾删掉）
 *   8 ACP session/prompt：真发一句话 → 收 session/update 流；收到权限请求就答「允许一次」；
 *      等 stopReason（自己设上限，到点就 session/cancel，不无限挂）
 *   9 GET /session/stream（SSE）：真开一条流，看它握手（有事件就打印类型，没事件也算通）
 *
 * 退出码：0 = 全通过；1 = 有步骤失败（每条失败都带「怎么修」）。
 * 注意：绝不写画布、绝不改任何已有会话的内容 —— 唯一会新建的是 7 那条空会话（除非 --keep）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import bridgeInfo from "../paseo/bridge-info.js";

const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const DATA_ARG = argOf("--data", "");
const KEEP = argv.includes("--keep");
const TURN_TIMEOUT_MS = Number(argOf("--turn-timeout", "25000")) || 25000;
const PROMPT_ARG = argOf("--prompt", "");

let fails = 0;
let checks = 0;
const results = [];
function step(name, ok, detail) {
  checks++;
  if (!ok) fails++;
  const line = (ok ? "  ok    " : "FAIL  ") + name + (detail ? " — " + detail : "");
  console.log(line);
  results.push({ name, ok, detail: detail || "" });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dataDir() {
  if (DATA_ARG) return DATA_ARG;
  const list = bridgeInfo.dataDirCandidates();
  for (const d of list) {
    try {
      if (fs.existsSync(path.join(d, "mcp-server.json"))) return d;
    } catch {
      /* 下一个 */
    }
  }
  return list[0] || "";
}

function readServerState(dir) {
  const f = path.join(dir, "mcp-server.json");
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch (e) {
    return { __error: (e && e.message) || "读不到 mcp-server.json" };
  }
}

function httpJson(base, pathname, headers, body) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
    const req = http.request(
      base + pathname,
      {
        method: data ? "POST" : "GET",
        headers: Object.assign({}, headers || {}, data ? { "content-length": data.length } : {}),
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          let j = null;
          try {
            j = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          } catch {
            j = { __raw: Buffer.concat(chunks).toString("utf8").slice(0, 200) };
          }
          resolve({ status: res.statusCode, json: j });
        });
      },
    );
    req.on("error", (e) => resolve({ status: 0, json: { __error: (e && e.message) || String(e) } }));
    req.setTimeout(30000, () => {
      req.destroy();
      resolve({ status: 0, json: { __error: "timeout" } });
    });
    if (data) req.write(data);
    req.end();
  });
}

/* ── 真桥进程（stdio ACP 客户端）────────────────────────────────────────── */
function startBridge(env) {
  const st = {
    notes: [],
    waiters: new Map(),
    buf: "",
    err: "",
    exited: false,
    nextId: 5000,
  };
  st.child = spawn(process.execPath, [path.join(ROOT, "paseo", "acp-bridge.mjs")], {
    cwd: ROOT,
    env: Object.assign({}, process.env, env || {}),
    stdio: ["pipe", "pipe", "pipe"],
  });
  st.child.stdout.setEncoding("utf8");
  st.child.stdout.on("data", (chunk) => {
    st.buf += chunk;
    let i;
    while ((i = st.buf.indexOf("\n")) >= 0) {
      const line = st.buf.slice(0, i).trim();
      st.buf = st.buf.slice(i + 1);
      if (!line) continue;
      let msg = null;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.method) st.notes.push(msg);
      else if (msg.id !== undefined) {
        const w = st.waiters.get(msg.id);
        if (w) {
          st.waiters.delete(msg.id);
          w(msg);
        }
      }
    }
  });
  st.child.stderr.setEncoding("utf8");
  st.child.stderr.on("data", (c) => {
    st.err += String(c);
  });
  st.child.on("exit", () => {
    st.exited = true;
    for (const [, w] of st.waiters) w({ error: { message: "桥进程退出了" } });
    st.waiters.clear();
  });
  st.send = (method, params, timeoutMs) =>
    new Promise((resolve) => {
      const id = ++st.nextId;
      st.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} }) + "\n");
      st.waiters.set(id, resolve);
      setTimeout(() => {
        if (st.waiters.has(id)) {
          st.waiters.delete(id);
          resolve({ error: { message: "等应答超时：" + method } });
        }
      }, timeoutMs || 20000);
    });
  st.notify = (method, params) =>
    st.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params: params || {} }) + "\n");
  st.close = () => {
    try {
      st.child.stdin.end();
    } catch {}
    setTimeout(() => {
      try {
        st.child.kill();
      } catch {}
    }, 400);
  };
  return st;
}

/* ── 主流程 ───────────────────────────────────────────────────────────── */
(async function () {
  console.log("Paseo 桥 · 真机探针");
  const dir = dataDir();
  console.log("  数据目录：" + dir);

  /* 1) 探活 */
  const state = readServerState(dir);
  if (state.__error || !state.port || !state.token) {
    step("① 读服务端状态", false, state.__error || "mcp-server.json 里没有端口/令牌（MTNode 没在跑？）");
    console.log("  修：先启动 MTNode，再看「扩展能力管理 → 服务端」页里开关是否打开。");
    return finish();
  }
  const base = "http://127.0.0.1:" + state.port;
  const auth = { authorization: "Bearer " + state.token, "content-type": "application/json" };
  const health = await httpJson(base, "/health", {});
  step("① 本地服务端探活", health.status === 200 && health.json && health.json.ok, base + "（HTTP " + health.status + "）");
  if (health.status !== 200) {
    console.log("  修：端口每次启动都会变 —— MTNode 刚重启过就会是旧端口。重开一次即可。");
    return finish();
  }

  /* 2) 会话族在不在（旧实例会回「不支持的方法」） */
  const tools = await httpJson(base, "/ctl", auth, { method: "session/tools", params: {} });
  const toolNames = (tools.json && tools.json.result && tools.json.result.tools) || [];
  const hasFamily = !!(tools.json && tools.json.ok) && toolNames.length >= 10;
  step(
    "② 会话族可用（session/tools）",
    hasFamily,
    hasFamily ? toolNames.length + " 个工具" : String((tools.json && tools.json.error) || "无回执"),
  );
  if (!hasFamily) {
    console.log("  修：这个 MTNode 实例是**改动之前**启动的。重启 MTNode 后再跑本探针。");
    return finish();
  }

  /* 3) 真会话清单 */
  const list = await httpJson(base, "/ctl", auth, { method: "session/list", params: { limit: 20 } });
  const sessions = (list.json && list.json.result && list.json.result.sessions) || [];
  step("③ 列会话（session/list）", !!(list.json && list.json.ok), sessions.length + " 条" + (sessions[0] ? "，最新：" + sessions[0].title : ""));

  /* 4) 读回一条真会话的正文（取最后一条 user 消息当探针 prompt；不改任何东西）
     注意：**必须挑一条有消息的会话** —— 新建但还没跑过的会话在盘上只有索引条目，
     读回来当然是 0 条（那是正常形态，不是 bug）。 */
  let probePrompt = PROMPT_ARG;
  let probeSession = null;
  let readOk = false;
  let readDetail = "";
  for (const s of sessions) {
    const one = await httpJson(base, "/ctl", auth, {
      method: "session/read",
      params: { sessionId: s.id, limit: 10, bodyLimit: 400 },
    });
    const msgs = (one.json && one.json.result && one.json.result.messages) || [];
    if (!msgs.length) {
      if (!readDetail) readDetail = "（" + s.id + " 还没有消息）";
      continue;
    }
    probeSession = s;
    readOk = true;
    if (!probePrompt) {
      const lastUser = [...msgs].reverse().find((m) => m.role === "user" && String(m.content || "").trim());
      if (lastUser) probePrompt = String(lastUser.content);
    }
    readDetail = s.id + " · " + msgs.length + " 条消息";
    break;
  }
  step("④ 读会话历史（session/read）", readOk, readOk ? readDetail : "没有一条会话有消息" + readDetail);
  if (!readOk) {
    console.log("  提示：新实例里还没有跑过任何一轮。先在界面上随便说一句（或在手机上发一条）再跑本探针。");
  }

  /* 5) 模型清单 */
  const models = await httpJson(base, "/ctl", auth, { method: "session/models", params: {} });
  const providers = (models.json && models.json.result && models.json.result.providers) || [];
  step(
    "⑤ 供应商与模型清单（session/models）",
    !!(models.json && models.json.ok) && providers.length > 0,
    providers.length + " 个供应商（" + providers.map((p) => p.route).join(", ") + "）",
  );

  /* 6~8) 真桥进程：ACP 握手 → 建会话 → 走一轮 */
  const bridge = startBridge({ MTNODE_DATA_DIR: dir });
  let created = "";
  try {
    const init = await bridge.send("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      clientInfo: { name: "mtnode-probe", version: "9.9.9" },
    });
    step(
      "⑥ 桥 ACP 握手（initialize）",
      !!(init.result && init.result.protocolVersion === 1),
      init.result
        ? "协议 v" + init.result.protocolVersion + " · " + init.result.agentInfo.name + " " + init.result.agentInfo.version
        : JSON.stringify(init.error || init),
    );

    const created2 = await bridge.send("session/new", { cwd: ROOT, mcpServers: [] });
    created = String((created2.result && created2.result.sessionId) || "");
    step(
      "⑦ 桥在 MTNode 新建会话（session/new）",
      !!created,
      created ? created + "（模式清单 " + ((created2.result.modes && created2.result.modes.availableModes.length) || 0) + " 项）" : JSON.stringify(created2.error || created2),
    );

    if (created) {
      const text = probePrompt || "（探针）你好，请只回一句：桥已连通。";
      const promptP = bridge.send("session/prompt", { sessionId: created, prompt: [{ type: "text", text }] }, TURN_TIMEOUT_MS + 30000);
      /* 一边等应答，一边把桥发出来的权限请求答掉（真机上会弹审批卡） */
      const until = Date.now() + TURN_TIMEOUT_MS;
      let answered = 0;
      let updates = 0;
      const seenNotes = new Set();
      let stopReason = "";
      let done = false;
      promptP.then((r) => {
        done = true;
        stopReason = (r.result && r.result.stopReason) || (r.error ? "error:" + r.error.message : "");
      });
      while (Date.now() < until && !done) {
        for (const m of bridge.notes) {
          const key = String(m.id) + ":" + String(m.method);
          if (seenNotes.has(key)) continue;
          seenNotes.add(key);
          if (String(m.method) === "session/update") updates++;
          if (String(m.method) === "session/request_permission") {
            answered++;
            bridge.child.stdin.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: m.id,
                result: { outcome: { outcome: "selected", optionId: "allow-once" } },
              }) + "\n",
            );
            console.log("      · 桥弹了一张权限请求：「" + (m.params.toolCall.title || "") + "」→ 已答「允许一次」");
          }
        }
        await sleep(120);
      }
      /* 收尾后再扫一遍（最后一帧常常在 done 之后到） */
      for (const m of bridge.notes) {
        const key = String(m.id) + ":" + String(m.method);
        if (seenNotes.has(key)) continue;
        seenNotes.add(key);
        if (String(m.method) === "session/update") updates++;
      }
      if (!done) {
        bridge.notify("session/cancel", { sessionId: created });
        await sleep(1500);
      }
      step(
        "⑧ 桥走完一轮（session/prompt）",
        done,
        done
          ? "stopReason=" + stopReason + " · " + updates + " 帧 session/update · 代答审批 " + answered + " 次"
          : "到 " + Math.round(TURN_TIMEOUT_MS / 1000) + " 秒上限仍未收尾（已发 session/cancel）",
      );
      if (!done) {
        console.log("  提示：会话可能还在等审批，或本机模型很慢。用 --turn-timeout 90000 放宽再跑一次。");
      }
    } else {
      step("⑧ 桥走完一轮（session/prompt）", false, "上一步没建出会话，跳过");
    }

    /* 9) SSE 真开一条流（观察者登记 + 握手） */
    const sseOk = await new Promise((resolve) => {
      const req = http.get(
        base + "/session/stream?sessionId=" + encodeURIComponent(created || probeSession?.id || "asProbe") + "&replay=1&token=" + encodeURIComponent(state.token),
        (res) => {
          const ct = String(res.headers["content-type"] || "");
          res.on("data", () => {});
          setTimeout(() => {
            req.destroy();
            resolve(ct.includes("text/event-stream"));
          }, 700);
        },
      );
      req.on("error", (e) => resolve(false));
      req.setTimeout(4000, () => {
        req.destroy();
        resolve(false);
      });
    });
    step("⑨ 实时流握手（GET /session/stream · SSE）", sseOk, sseOk ? "text/event-stream 已建立" : "没握上手");
  } finally {
    bridge.close();
    await sleep(400);
    step("⑩ 桥进程收尾", bridge.exited, bridge.exited ? "stdin 关闭后自行退出（不留孤儿进程）" : "仍在运行（已强杀）");
    /* 清理：把探针建的那条空会话删掉（除非 --keep）。只删它自己建的那一条，别的一律不动。 */
    if (created && !KEEP) {
      const all = await httpJson(base, "/ctl", auth, { method: "session/list", params: { limit: 200, includeArchived: true } });
      const ids = ((all.json && all.json.result && all.json.result.sessions) || []).map((s) => s.id);
      const keepIds = ids.filter((id) => id !== created);
      let removed = false;
      try {
        const store = require(path.join(ROOT, "agent-sessions-store.js"));
        const s = store.createAgentSessionsStore({
          dataDir: () => dir,
          cfgFile: () => path.join(dir, "config.json"),
          log: () => {},
          backup: () => {},
          mutateConfig: () => Promise.resolve(),
        });
        s.saveSessions({ activeId: "", sessions: keepIds.map((id) => ({ id, loaded: false })), drop: [created] });
        removed = true;
      } catch (e) {
        removed = false;
      }
      step("⑪ 清理探针建的会话", removed, removed ? "已删掉 " + created + "（它只是一条空会话）" : "没能删掉 " + created + "（可在界面上手动删）");
    }
  }

  return finish();

  function finish() {
    console.log("");
    console.log(fails === 0 ? "✓ 真机探针全部通过（" + checks + " 项）" : "✗ " + fails + " / " + checks + " 项未通过");
    console.log("");
    console.log("剩下的（只有你能做）：");
    console.log("  1) 电脑上装 Paseo（Desktop 或 npx @getpaseo/cli），让它把 daemon 跑起来");
    console.log("  2) MTNode →「扩展能力管理 → 服务端」→「Paseo 桥」→ 复制 provider 片段 → 合并进 ~/.paseo/config.json → paseo reload");
    console.log("  3) 手机上装 Paseo App → 配对设备（relay 扫码，或 Direct connection 填 Tailscale IP:6767）");
    console.log("  4) 新建 agent 时选「MTNode 会话」—— 手机上应该能看到左栏那些会话并接着聊");
    console.log("  口径与排障见 guides/paseo-bridge.md");
    process.exit(fails === 0 ? 0 : 1);
  }
})();
