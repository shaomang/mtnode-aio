#!/usr/bin/env node
/* paseo/acp-bridge.mjs — 把 MTNode 的智能体会话接成 Paseo 的一个 ACP provider（桥）
 *
 * ── 这是什么 ─────────────────────────────────────────────────────────────
 * Paseo（https://paseo.sh）的「agent」接入协议是 **ACP**（Agent Client Protocol）：
 *   · Paseo daemon 按 ~/.paseo/config.json 的 agents.providers.<id> 拉起本文件（stdio 子进程）；
 *   · 本进程对 Paseo 说 ACP（JSON-RPC 2.0，换行分隔），对 MTNode 说它自己的本机 HTTP
 *     （POST /ctl 的会话族 mtnode_session_* + GET /session/stream 的 SSE 实时流）。
 * 于是手机上（Paseo App 经它自带的 relay 扫码配对）看到的就是 MTNode 里那条 as… 会话本身 ——
 * 「同一份账」：手机上发的消息在电脑左栏看得到，电脑上开的会话手机也能接。
 *
 * ── 刻意不做的 ───────────────────────────────────────────────────────────
 *   · 不碰画布：本桥一个画布工具都不调（共识：远程接管只碰会话层）。
 *   · 不自带依赖：纯 Node（≥18）零 npm 依赖，手写最小 ACP（只覆盖 Paseo 实际用到的帧）。
 *   · 不代填凭据：令牌从 MTNode 数据目录的 mcp-server.json 读，或由环境变量给。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 *   node acp-bridge.mjs            # 由 Paseo daemon 当 provider 子进程拉起（stdio）
 *   node acp-bridge.mjs --config   # 打印要写进 ~/.paseo/config.json 的那一段
 *   node acp-bridge.mjs --check    # 自检：数据目录 / 端口 / 令牌 / ACP 帧形状
 *
 * 环境变量：MTNODE_DATA_DIR（覆盖数据目录）、MTNODE_MCP_URL + MTNODE_MCP_TOKEN（直接点名服务端）、
 *          MTNODE_PASEO_DEBUG=1（把 ACP 帧与桥的动作打到 stderr）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import process from "node:process";
import { fileURLToPath } from "node:url";
/* 落点与配置片段的单一真源（CJS）：主进程的「Paseo 桥」面板 require 的是同一份 */
import bridgeInfo from "./bridge-info.js";

/* ── 常量 ──────────────────────────────────────────────────────────────── */

/** 本桥实现的 ACP 协议版本（ACP v1 是当前稳定线，见 agentclientprotocol.com/protocol/v1）。 */
const ACP_PROTOCOL_VERSION = 1;
const BRIDGE_NAME = "mtnode-paseo-bridge";
const BRIDGE_VERSION = "1.0.0";
/** 兼容闸：Paseo 迭代很快，声明一个最低版本；真机联调拿到实际版本后按需上调。
 *  不兼容时**明确报错**（--check 与 initialize 都会说），不静默连不上。 */
const PASEO_MIN_VERSION = process.env.MTNODE_PASEO_MIN_VERSION || "0.1.0";
/** 一轮的兜底等待（手机断线时 MTNode 那边仍在等审批，这里只保证不无限占着 stdio） */
const TURN_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const DEBUG = !!process.env.MTNODE_PASEO_DEBUG;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "..");

/* ── 小工具 ────────────────────────────────────────────────────────────── */

function dbg(...a) {
  if (!DEBUG) return;
  try {
    process.stderr.write("[paseo-bridge] " + a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") + "\n");
  } catch {
    /* stderr 关了也无所谓 */
  }
}

function out(msg) {
  dbg("→", msg);
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id, result) {
  out({ jsonrpc: "2.0", id, result: result === undefined ? null : result });
}

function replyErr(id, code, message, data) {
  out({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

function notify(method, params) {
  out({ jsonrpc: "2.0", method, params });
}

function oneLine(s, n) {
  const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return n && t.length > n ? t.slice(0, n) + "…" : t;
}

/** 语义化版本比较：a >= b ?（只比较前三段，够用） */
function versionGte(a, b) {
  const pa = String(a).split(".").map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true;
}

/* ── MTNode 数据目录与服务端发现 ────────────────────────────────────────── */

/** 数据目录候选：实现与面板共用同一份（paseo/bridge-info.js，CJS —— 主进程也 require 它）。 */
const { dataDirCandidates } = bridgeInfo;

/** 找到在跑的那个 MCP 服务端（端口 + 令牌）。找不到时给出**逐条候选**的排障信息。 */
function discoverServer() {
  const envUrl = String(process.env.MTNODE_MCP_URL || "").trim();
  const envToken = String(process.env.MTNODE_MCP_TOKEN || "").trim();
  if (envUrl && envToken) {
    const port = Number((/:\/\/(?:127\.0\.0\.1|localhost):(\d+)/.exec(envUrl) || [])[1]) || 0;
    return { ok: true, base: envUrl.replace(/\/(mcp|ctl)\/?$/, ""), port, token: envToken, from: "env" };
  }
  const tried = [];
  for (const dir of dataDirCandidates()) {
    const f = path.join(dir, "mcp-server.json");
    let j = null;
    try {
      j = JSON.parse(fs.readFileSync(f, "utf8"));
    } catch (e) {
      tried.push({ dir, why: "读不到 mcp-server.json（" + ((e && e.code) || "no file") + "）" });
      continue;
    }
    const port = Number(j && j.port) || 0;
    const token = String((j && j.token) || "");
    const enabled = !(j && j.enabled === false);
    if (!enabled) {
      tried.push({ dir, why: "MCP 服务端在设置里被关掉了（enabled:false）" });
      continue;
    }
    if (!port || !token) {
      tried.push({ dir, why: "端口为 0（服务端没在跑 / 刚停过）" });
      continue;
    }
    tried.push({ dir, why: "ok（port=" + port + "）" });
    return { ok: true, base: "http://127.0.0.1:" + port, port, token, from: dir };
  }
  return {
    ok: false,
    error:
      "找不到 MTNode 的本地服务端。请确认 MTNode 正在运行（设置 → 扩展能力管理 → 服务端 里开关是开的），" +
      "或用 MTNODE_DATA_DIR / MTNODE_MCP_URL + MTNODE_MCP_TOKEN 显式指定。逐个候选探活结果：" +
      tried.map((t) => t.dir + " → " + t.why).join("；"),
    tried,
  };
}

/* ── MTNode HTTP 客户端 ───────────────────────────────────────────────── */

function createMtnodeClient(server) {
  const auth = { authorization: "Bearer " + server.token, "content-type": "application/json" };

  function post(pathname, body) {
    return new Promise((resolve, reject) => {
      const data = Buffer.from(JSON.stringify(body || {}), "utf8");
      const req = http.request(
        server.base + pathname,
        { method: "POST", headers: { ...auth, "content-length": data.length } },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            let j = null;
            try {
              j = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
            } catch (e) {
              return reject(new Error("回执不是合法 JSON（HTTP " + res.statusCode + "）：" + oneLine(Buffer.concat(chunks).toString("utf8"), 200)));
            }
            if (res.statusCode === 401) return reject(new Error("MTNode 拒绝了这枚令牌（401）：重新在面板里复制配置片段"));
            resolve(j);
          });
        },
      );
      req.on("error", reject);
      req.setTimeout(60 * 60 * 1000, () => req.destroy(new Error("请求超时")));
      req.write(data);
      req.end();
    });
  }

  /** 扁平控制面调用：{ ok, result | error }。会话族一律走它（不进 MCP 的 tools/list）。 */
  async function ctl(method, params) {
    const r = await post("/ctl", { method, params: params || {} });
    if (!r || r.ok !== true) throw new Error((r && r.error) || ("调用失败：" + method));
    return r.result;
  }

  /** 会话实时流（SSE）。onEvent 拿到的每一帧都是 { seq, at, sessionId, type, data }。
   *  **专用 agent（keepAlive:false）**：默认的全局 agent 会复用上一条请求的 socket，
   *  第二轮的流会被挂到一条已经结束的响应上 —— 表现就是「第一轮有输出、第二轮的卡与
   *  正文一条都不来」（真机与假服务端都复现过）。 */
  const sseAgent = new http.Agent({ keepAlive: false });

  function stream(sessionId, onEvent, onState) {
    let closed = false;
    let req = null;
    let backoff = 500;
    const url =
      server.base +
      "/session/stream?sessionId=" + encodeURIComponent(sessionId) +
      "&token=" + encodeURIComponent(server.token);
    const start = () => {
      if (closed) return;
      req = http.get(url, { headers: { accept: "text/event-stream" }, agent: sseAgent }, (res) => {
        if (res.statusCode !== 200) {
          onState && onState({ ok: false, status: res.statusCode });
          res.resume();
          return retry();
        }
        backoff = 500;
        onState && onState({ ok: true });
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of block.split("\n")) {
              if (!line.startsWith("data:")) continue;
              try {
                const ev = JSON.parse(line.slice(5).trim());
                dbg("sse", ev.type, ev.data && ev.data.id ? ev.data.id : "");
                onEvent(ev);
              } catch {
                /* 半截帧：丢掉，下一帧还会来 */
              }
            }
          }
        });
        res.on("end", () => retry());
        res.on("error", () => retry());
      });
      req.on("error", () => retry());
    };
    const retry = () => {
      if (closed) return;
      onState && onState({ ok: false, status: 0 });
      setTimeout(start, backoff);
      backoff = Math.min(8000, backoff * 2);
    };
    start();
    return {
      close() {
        closed = true;
        try {
          req && req.destroy();
        } catch {
          /* 已经断了 */
        }
      },
    };
  }

  /** 一次真探活（GET /health 免令牌）：initialize 只声明能力，若这里不探，客户端会以为
   *  连上了、直到第一次发消息才炸 —— 手机上表现成「发送没反应」，最难查。 */
  function probeServer(timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok, why) => {
        if (done) return;
        done = true;
        resolve({ ok, why: why || "" });
      };
      try {
        const req = http.get(server.base + "/health", { agent: false }, (res) => {
          res.resume();
          finish(res.statusCode === 200, "HTTP " + res.statusCode);
        });
        req.on("error", (e) => finish(false, (e && e.code) || (e && e.message) || "error"));
        req.setTimeout(timeoutMs || 3000, () => {
          req.destroy();
          finish(false, "timeout");
        });
      } catch (e) {
        finish(false, (e && e.message) || "error");
      }
    });
  }

  return { post, ctl, stream, probeServer };
}

/* ── ACP 侧：会话状态 ─────────────────────────────────────────────────── */

/** MTNode 会话 id（as…）→ 这一轮在途状态的登记 */
const turns = new Map();
/** ACP sessionId → { mode }：mode 是「接着哪条会话」（见 session/new 的模式清单） */
const sessions = new Map();

function liveTurn(sessionId) {
  return turns.get(String(sessionId || "")) || null;
}

/** 把 MTNode 的一帧事件翻成 ACP 的 session/update */
function toAcpUpdate(mtnodeSessionId, ev) {
  const d = ev.data || {};
  switch (String(ev.type || "")) {
    case "text":
    case "say-end": {
      const text = String(d.text || d.delta || "");
      if (!text) return null;
      return {
        sessionUpdate: "agent_message_chunk",
        messageId: "as-" + mtnodeSessionId,
        content: { type: "text", text },
      };
    }
    case "tool": {
      const name = String(d.name || d.tool || "tool");
      const callId = String(d.callId || d.id || name + "@" + (ev.seq || 0));
      const status = String(d.status || (d.error ? "failed" : d.result !== undefined ? "completed" : "pending"));
      const base = {
        toolCallId: callId,
        title: name,
        kind: "other",
        status: status === "running" ? "in_progress" : status,
        rawInput: d.args === undefined ? undefined : d.args,
      };
      const isUpdate = liveTurn(mtnodeSessionId) && liveTurn(mtnodeSessionId).tools.has(callId);
      if (isUpdate) {
        return {
          sessionUpdate: "tool_call_update",
          toolCallId: callId,
          status: base.status,
          rawOutput: d.result === undefined ? undefined : d.result,
          ...(d.error ? { content: [{ type: "content", content: { type: "text", text: String(d.error) } }] } : {}),
        };
      }
      const t = liveTurn(mtnodeSessionId);
      if (t) t.tools.add(callId);
      return { sessionUpdate: "tool_call", ...base };
    }
    case "error": {
      const msg = String(d.error || d.message || "这一轮失败了");
      return {
        sessionUpdate: "agent_message_chunk",
        messageId: "as-err-" + mtnodeSessionId,
        content: { type: "text", text: "\n\n⚠️ " + msg + "\n" },
      };
    }
    default:
      return null;
  }
}

/** 「停下来等人」的那几类事件 → ACP 的权限请求（手机点允许 / 拒绝） */
function askOfEvent(sessionId, ev) {
  const type = String(ev.type || "");
  if (type !== "approval" && type !== "canvas" && type !== "question") return null;
  const d = ev.data || {};
  const id = String(d.id || "");
  if (!id) return null;
  const kindLabel =
    type === "approval" ? "工具审批" : type === "canvas" ? "画布修改确认" : "模型提问";
  const title = String(d.title || d.name || d.tool || d.question || kindLabel);
  const detail = String(d.reason || d.detail || d.message || d.text || "").trim();
  return {
    kind: type,
    id,
    title: kindLabel + "：" + title,
    detail: detail ? oneLine(detail, 600) : "",
    raw: d,
  };
}

/** 权限请求的选项：与 MTNode 卡片上的按钮一一对应（工具审批三出口，其余两出口） */
function permissionOptions(ask) {
  const opts = [
    { optionId: "allow-once", name: "允许一次", kind: "allow_once" },
    { optionId: "reject", name: "拒绝", kind: "reject_once" },
  ];
  if (ask.kind === "approval") {
    opts.splice(1, 0, { optionId: "allow-session", name: "本会话后续都放行", kind: "allow_always" });
  }
  return opts;
}

/* ── 面板用：一份「桥在哪、怎么拉起、配什么」的状态 ─────────────────────
   实现放在 paseo/bridge-info.js（CJS，主进程的面板也 require 同一份），这里只转发，
   免得「面板显示的路径」与「桥自己的口径」成为两份会漂移的事实。 */
export { bridgePaths, providerSnippet, bridgeStatus } from "./bridge-info.js";

/* ── ACP 侧：主循环 ───────────────────────────────────────────────────── */

function main() {
  const argv = process.argv.slice(2);
  const server = discoverServer();

  /* --config：打印 provider 配置片段（面板「一键复制」与这里同一份口径） */
  if (argv.includes("--config")) {
    const cmd = [process.execPath, path.join(HERE, "acp-bridge.mjs")];
    const snippet = {
      agents: {
        providers: {
          mtnode: {
            extends: "acp",
            label: "MTNode 会话",
            command: cmd,
            env: { MTNODE_DATA_DIR: "<MTNode 数据目录>" },
          },
        },
      },
    };
    process.stdout.write(
      "# ~/.paseo/config.json（改完跑 paseo reload）\n" +
        "  command = 本机真 Node + 本桥脚本（打包态用应用自带的 Node）\n" +
        JSON.stringify(snippet, null, 2) +
        "\n",
    );
    return 0;
  }

  /* --check：自检（面板与排障都用它） */
  if (argv.includes("--check")) {
    const lines = [];
    lines.push("bridge: " + path.join(HERE, "acp-bridge.mjs"));
    lines.push("node: " + process.execPath + " (" + process.version + ")");
    lines.push("paseoMinVersion: " + PASEO_MIN_VERSION);
    lines.push("appRoot: " + APP_ROOT);
    lines.push("dataDir candidates:");
    for (const d of dataDirCandidates()) lines.push("  - " + d);
    lines.push("server: " + (server.ok ? server.base + "（来自 " + server.from + "）" : "未找到"));
    if (!server.ok) lines.push("  " + server.error);
    else {
      const client = createMtnodeClient(server);
      lines.push("session/tools: 见 POST /ctl");
    }
    process.stdout.write(lines.join("\n") + "\n");
    return server.ok ? 0 : 2;
  }

  /* stdio ACP 主循环 */
  let buf = "";
  /** 本桥发出去的 session/request_permission：id → { resolve, sessionId, ask }。
   *  客户端（Paseo）的应答从 stdin 回来，按 id 认领 —— 认不到就是别的请求（这里没有）。 */
  const askWaiters = new Map();
  let askCounter = 0;
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg = null;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      dbg("←", msg);
      /* ① 先看是不是「我们发出去的请求」的应答（session/request_permission） */
      if (msg && msg.id !== undefined && msg.method === undefined) {
        const w = askWaiters.get(msg.id);
        if (w) {
          askWaiters.delete(msg.id);
          const oc = (msg.result && msg.result.outcome) || {};
          w.resolve(oc.optionId ? { optionId: String(oc.optionId) } : null);
          continue;
        }
      }
      handle(msg).catch((e) => {
        if (msg && msg.id !== undefined) replyErr(msg.id, -32603, (e && e.message) || String(e));
      });
    }
  });
  process.stdin.on("end", () => process.exit(0));

  async function handle(msg) {
    const id = msg.id;
    const method = String(msg.method || "");
    const p = msg.params || {};
    const isNotification = id === undefined || id === null;

    /* ── initialize：版本与能力协商 ── */
    if (method === "initialize") {
      const clientVersion = String((p.clientInfo && p.clientInfo.version) || "");
      const compatible = !clientVersion || versionGte(clientVersion, PASEO_MIN_VERSION);
      if (!compatible && !isNotification) {
        return replyErr(
          id,
          -32600,
          "Paseo 版本过低（客户端 " + clientVersion + "，本桥要求 ≥ " + PASEO_MIN_VERSION + "）。" +
            "请升级 Paseo 后重试（或设 MTNODE_PASEO_MIN_VERSION 放宽，但未验证的组合不保证可用）。",
        );
      }
      if (!server.ok) {
        return replyErr(id, -32000, "接不上 MTNode：" + server.error);
      }
      /* 真探活一次：端口在、但 MTNode 已经关掉时，这里就要说清（别让手机端到第一次
         发消息才发现）。探不通时错误文本与 session/new 那一条同源。 */
      const probe = await createMtnodeClient(server).probeServer(3000);
      if (!probe.ok) {
        return replyErr(
          id,
          -32000,
          "接不上 MTNode（" + server.base + " 探活失败：" + probe.why + "）。" +
            "请确认 MTNode 正在运行；服务端端口每次启动都会变，若刚重启过请重开本 provider。",
        );
      }
      return reply(id, {
        protocolVersion: ACP_PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
        },
        agentInfo: { name: BRIDGE_NAME, version: BRIDGE_VERSION },
        authMethods: [],
      });
    }

    if (method === "authenticate") return reply(id, {});
    if (method === "logout") return reply(id, {});

    /* ── 会话清单（当 ACP 的「模式」露出：手机在新建会话时能选「接着哪条 MTNode 会话」）── */
    async function modeState() {
      const client = createMtnodeClient(server);
      const list = await client.ctl("session/list", { limit: 50 });
      const opts = (list.sessions || []).map((s) => ({
        id: String(s.id),
        name: oneLine(s.title || s.id, 48) + (s.running ? " · 运行中" : ""),
        description: "MTNode 会话 · " + (s.model || "默认模型") + " · " + new Date(s.updatedAt || 0).toLocaleString(),
      }));
      const availableModes = [{ id: "new", name: "新建 MTNode 会话", description: "在 MTNode 左栏新建一条会话" }, ...opts];
      return { currentModeId: "new", availableModes };
    }

    if (method === "session/new") {
      if (!server.ok) return replyErr(id, -32000, "接不上 MTNode：" + server.error);
      const client = createMtnodeClient(server);
      const created = await client.ctl("session/create", {});
      const sid = String(created.sessionId || "");
      if (!sid) return replyErr(id, -32603, "MTNode 没有回会话 id");
      sessions.set(sid, { mode: sid, tools: new Set() });
      let modes = null;
      try {
        modes = await modeState();
        modes.currentModeId = sid;
      } catch {
        modes = null;
      }
      return reply(id, { sessionId: sid, ...(modes ? { modes } : {}) });
    }

    if (method === "session/load") {
      const sid = String(p.sessionId || "");
      if (!sid) return replyErr(id, -32602, "session/load 需要 sessionId");
      const client = createMtnodeClient(server);
      try {
        /* 读一遍正文：读得到才算这条会话真的在（读不到会明确报「已被删除」） */
        await client.ctl("session/read", { sessionId: sid, limit: 1 });
      } catch (e) {
        return replyErr(id, -32004, (e && e.message) || "会话不可用");
      }
      sessions.set(sid, { mode: sid, tools: new Set() });
      return reply(id, {});
    }

    if (method === "session/set_mode") {
      const sid = String(p.sessionId || "");
      const want = String(p.modeId || p.mode || "");
      const s = sessions.get(sid);
      if (s) s.mode = want;
      return reply(id, {});
    }

    /* ── 发一句话：落进 MTNode 那条会话，并把这一轮的事件流回给 Paseo ── */
    if (method === "session/prompt") {
      const sid = String(p.sessionId || "");
      if (!sid) return replyErr(id, -32602, "session/prompt 需要 sessionId");
      const blocks = Array.isArray(p.prompt) ? p.prompt : [];
      const text = blocks
        .map((b) => (b && b.type === "text" ? String(b.text || "") : ""))
        .filter(Boolean)
        .join("\n")
        .trim();
      if (!text) return replyErr(id, -32602, "只支持文本消息（这一版不转发图片 / 附件）");
      if (!server.ok) return replyErr(id, -32000, "接不上 MTNode：" + server.error);

      const client = createMtnodeClient(server);
      const turn = {
        id,
        sessionId: sid,
        tools: new Set(),
        done: false,
        cancelled: false,
        stream: null,
        timer: null,
      };
      turns.set(sid, turn);

      const finish = (reason) => {
        if (turn.done) return;
        turn.done = true;
        clearTimeout(turn.timer);
        try {
          turn.stream && turn.stream.close();
        } catch {}
        turns.delete(sid);
        reply(id, { stopReason: reason });
      };

      /* 先挂实时流，再发消息：否则这一轮最早那几帧会漏掉 */
      let started = false;
      const pending = [];
      turn.stream = client.stream(
        sid,
        (ev) => {
          const t = String(ev.type || "");
          if (t === "round-end" || t === "done") {
            /* 一轮收尾：等 MTNode 的 done 到了才回 stopReason（不外泄内部帧） */
            if (!started) pending.push(ev);
            else finish(turn.cancelled ? "cancelled" : "end_turn");
            return;
          }
          const ask = askOfEvent(sid, ev);
          if (ask) {
            void askPermission(sid, ask, turn);
            return;
          }
          const upd = toAcpUpdate(sid, ev);
          if (!upd) return;
          if (!started) return pending.push({ __upd: upd });
          notify("session/update", { sessionId: sid, update: upd });
        },
        (st) => dbg("stream state", st),
      );

      turn.timer = setTimeout(() => finish("max_turn_requests"), TURN_TIMEOUT_MS);
      if (turn.timer && typeof turn.timer.unref === "function") turn.timer.unref();

      try {
        const r = await client.ctl("session/send", { sessionId: sid, text });
        started = true;
        dbg("sent", r);
      } catch (e) {
        /* 只有这一条出口能回 id 的 error：**先撤掉 turn**，别再让 finish 回一次 result
           （同一 id 回两条 = 客户端把它当重复帧丢掉，还会留下一条假 stopReason）。 */
        turn.done = true;
        clearTimeout(turn.timer);
        try {
          turn.stream && turn.stream.close();
        } catch {}
        turns.delete(sid);
        return replyErr(id, -32000, "发不出去：" + ((e && e.message) || e));
      }
      for (const ev of pending.splice(0)) {
        if (ev.__upd) notify("session/update", { sessionId: sid, update: ev.__upd });
        else if (String(ev.type) === "round-end" || String(ev.type) === "done")
          finish(turn.cancelled ? "cancelled" : "end_turn");
      }
      return undefined; /* 等 done（reply 在 finish 里发） */
    }

    /* ── 终止这一轮（ACP 通知）── */
    if (method === "session/cancel") {
      const sid = String(p.sessionId || "");
      const t = liveTurn(sid);
      if (t) t.cancelled = true;
      if (server.ok) {
        try {
          const client = createMtnodeClient(server);
          await client.ctl("session/stop", { sessionId: sid });
        } catch (e) {
          dbg("cancel failed", (e && e.message) || e);
        }
      }
      if (t) {
        /* ACP 要求：收到 cancel 就必须以 cancelled 收尾（不能挂在那儿） */
        setTimeout(() => {
          const cur = liveTurn(sid);
          if (cur === t && !t.done) {
            t.done = true;
            clearTimeout(t.timer);
            try {
              t.stream && t.stream.close();
            } catch {}
            turns.delete(sid);
            reply(t.id, { stopReason: "cancelled" });
          }
        }, 1500);
      }
      return isNotification ? undefined : reply(id, {});
    }

    if (method === "session/close") {
      const sid = String(p.sessionId || "");
      sessions.delete(sid);
      return reply(id, {});
    }

    if (isNotification) return undefined;
    return replyErr(id, -32601, "本桥不支持这个方法：" + method);
  }

  /** 权限请求：把 MTNode 那张卡交给 Paseo（客户端弹给手机），按用户的选择回执。
   *  Paseo 没答 / 断了 → 什么都不回执：MTNode 那边**永久等待**（共识：断线不自动拒绝）。 */
  async function askPermission(sessionId, ask, turn) {
    const client = createMtnodeClient(server);
    const options = permissionOptions(ask);
    const reqId = 900000 + (askCounter += 1);
    const p = new Promise((resolve) => {
      askWaiters.set(reqId, { resolve, sessionId, ask });
    });
    out({
      jsonrpc: "2.0",
      id: reqId,
      method: "session/request_permission",
      params: {
        sessionId,
        toolCall: {
          toolCallId: "ask-" + ask.id,
          title: ask.title,
          kind: "other",
          status: "pending",
          rawInput: ask.raw,
          ...(ask.detail ? { content: [{ type: "content", content: { type: "text", text: ask.detail } }] } : {}),
        },
        options,
      },
    });
    const ans = await p;
    if (!ans) return; /* 客户端把这一枪丢了（断开）：MTNode 那边继续等 */
    const outcome = String(ans.optionId || "");
    const mapped = outcome === "reject" ? "rejected" : outcome === "allow-session" ? "allowed-session" : "allowed-once";
    /* 先给手机一个明确回执帧（MTNode 那边答完才会真的继续） */
    notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "ask-" + ask.id,
        status: mapped === "rejected" ? "failed" : "completed",
      },
    });
    try {
      await client.ctl("session/approval", {
        id: ask.id,
        sessionId,
        kind: ask.kind,
        outcome: mapped,
        ...(ask.kind === "question" && ans.text ? { answerText: ans.text } : {}),
      });
    } catch (e) {
      notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "\n\n⚠️ 回执没能送到 MTNode：" + ((e && e.message) || e) + "\n" },
        },
      });
    }
  }
}

/* handle 需要在 main 里被重新赋值：用一个薄包装绕开 const 约束 */
let handleRef = null;
process.on("uncaughtException", (e) => {
  dbg("uncaught", (e && e.stack) || e);
  try {
    process.stderr.write("[" + BRIDGE_NAME + "] 未捕获异常：" + ((e && e.message) || e) + "\n");
  } catch {}
});

const code = main();
if (typeof code === "number") process.exit(code);
