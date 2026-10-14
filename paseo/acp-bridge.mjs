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
 *   node acp-bridge.mjs --probe-question
 *                                  # 提问通道自检：自己当客户端跑一次真桥，逐拍验
 *                                  # 「MTNode 发询问卡 → 手机上一条可读消息 → 文本作答回到 MTNode」
 *
 * 环境变量：MTNODE_DATA_DIR（覆盖数据目录）、MTNODE_MCP_URL + MTNODE_MCP_TOKEN（直接点名服务端）、
 *          MTNODE_PASEO_DEBUG=1（把 ACP 帧与桥的动作打到 stderr）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import process from "node:process";
import { spawn } from "node:child_process";
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
/** session/load 回放正文的预算：条数与单条长度。Paseo 导入清单时会对**每条**候选会话
 *  各发一次 session/load 取首末消息做预览（acp-agent.js loadImportPromptPreviews），
 *  所以这里的上限就是「手机拉一次清单要搬多少字」—— 取 80 条 / 单条 4000 字封顶。 */
const HISTORY_LIMIT = Number(process.env.MTNODE_PASEO_HISTORY_LIMIT) || 80;
const HISTORY_BODY_LIMIT = 4000;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "..");

/* ── 模型的「询问卡」走哪条 ACP 通道（本次需求 · 四代口径）──────────────────
 * 写清免得再走回头路 —— 每一代都是真机实测后的结论：
 *   ① 最早：提问被当成权限请求发出去 —— 只有「允许一次 / 拒绝」两个按钮，
 *      题面与选项全丢，答案回不到模型。
 *   ② 上一版：改发 form 模式的 `session/elicitation`（要求 client 声明
 *      `clientCapabilities.elicitation.form`），不支持才回退权限请求 + 一条
 *      「这台手机不支持表单问答」的说明帧 —— 但真机 Paseo（0.11.2 实测：客户端能力
 *      只有 fs + terminal，**从不声明 elicitation**）因此永远走回退，用户看到的正是那个现场。
 *   ③ 再上一版（**错的，已下线**）：改发 `session/request_permission` +
 *      `toolCall.kind:"question"` + `input.questions[]`，指望 Paseo 渲染它自己的
 *      QuestionFormCard。两条硬事实把它否掉（2026-10 实测 Paseo 0.11.2）：
 *        · ACP 的 ToolKind 只有 read/edit/delete/move/search/execute/think/fetch/
 *          switch_mode/other，**没有 question** —— daemon 的 zod 校验把整帧拒掉
 *          （日志原文：`method: 'session/request_permission' … code: -32602, message:
 *          'Invalid params', data: { toolCall: { kind: [Object] } }`），询问卡根本到不了手机；
 *        · 就算 kind 合法也到不了那张表单：daemon 的 mapPermissionRequest 只产出
 *          kind "tool"/"mode"，且**从不填 input** —— 客户端渲染表单的条件是
 *          `request.kind === "question" && request.input.questions[]`，两个条件都凑不齐。
 *      而同一时刻 MTNode 那个提问工具自己的 tool 事件被翻成 `kind:"other"` 的工具卡，
 *      Paseo 的 buildToolCallDisplayModel 把它显示成 **Other**（humanizeToolName("other")），
 *      点开是 { type:"unknown", input: rawInput } 的详情 = 原始 JSON ——
 *      「手机端显示 Other，点进去是 JSON」说的就是这张卡。
 *   ④ 现在（这一版）：**提问走普通聊天消息**。题面 / 选项 / 作答方式拼成一段可读正文
 *      （questionChatText），以 `agent_message_chunk` 发下去 —— 手机上就是一条普通消息，
 *      按 Markdown 渲染，正文里一个 JSON 都没有；用户在手机输入框里回一条消息就是答案：
 *        · 桥把这条回复翻成 answers[]（逐题按 id 对齐）+ 可读 answerText，走 /ctl 的
 *          session/approval 打回 MTNode：那张卡就地收口、模型接着往下跑；
 *        · 手机发消息时 Paseo **先 interrupt 再 prompt**（它默认 activeTurnBehavior =
 *          "interrupt"，见 daemon 的 session.js / agent-manager.replaceAgentRun）——
 *          这一枪打断不是要停这一轮，所以桥在「正等作答」时**不打 MTNode 的 session/stop**，
 *          只按 ACP 要求把旧那一枪以 cancelled 收尾，随后到的那条 prompt 就是答案。
 * 审批（approval）与画布确认（canvas）**照旧**走 session/request_permission：
 * 本来就是「允许 / 拒绝」两三个按钮的事（toolCall.kind 用合法的 "other"）。
 * 口径由 --check 的 ASK_CHANNEL_NOTE 一行报出，排障时一眼看出走的是哪条。 */
/** 本桥声明的「提问通道」自述（--check 那一行与注释同源，避免两处口径漂移）。 */
const ASK_CHANNEL_NOTE =
  "ask channel: question → 可读聊天消息（agent_message_chunk）+ 手机下一条消息作答 → answers[]；" +
  "approval / canvas → session/request_permission(toolCall.kind=\"other\")；" +
  "不发 elicitation、也不发 kind=\"question\" 的权限卡（ACP ToolKind 没有 question，Paseo 整帧拒）";

/** 用户把审批卡放着不答时等多久（真实上限由 request.signal 兜底：宿主「中断任务」时 resolve(null)） */
const ASK_TIMEOUT_MS = 24 * 60 * 60 * 1000;
/** 「等手机文本作答」的有效期：过了就忘掉这条挂起（手机再来消息按普通消息下发） */
const TEXT_ASK_TTL_MS = Number(process.env.MTNODE_PASEO_ASK_TTL_MS) || 6 * 60 * 60 * 1000;
/** 手机发消息会先 interrupt：打断后这么久还没等到那条 prompt，就当成「用户真的按了停止」 */
const ANSWER_WAIT_AFTER_CANCEL_MS = 3000;

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

/** 这串版本号能不能拿来比较？（Paseo 0.11.2 官方桌面端在本地通道上报的是 "dev"） */
function versionComparable(v) {
  return /^\d+(\.\d+)*$/.test(String(v == null ? "" : v).trim());
}

/**
 * 客户端版本是否放行。
 *
 * 为什么不能直接 `versionGte(clientVersion, MIN)`：Paseo 官方客户端在**本地 provider 通道**上
 * 报的 clientInfo.version 是字面量 "dev"，`versionGte("dev","0.1.0")` 会把 "dev" 解析成 0.0.0
 * → 判「版本过低」→ 桥在 initialize 就拒绝。2026-10-14 真机实测的现场：daemon 侧
 * `daemon status --json` 里 mtnode provider 显示 available=true，但日志里全是
 * `ACPRequestError: Paseo 版本过低（客户端 dev，本桥要求 ≥ 0.1.0）`，一个会话都建不起来。
 *
 * 口径：**无法比较的版本号按放行处理**（只记一行 stderr），能比较的才走最低版本闸。
 * 反过来（把 unrecognized 当过低）等于用闸门把本机挡在门外，代价远大于收益。
 */
function clientVersionAllowed(clientVersion) {
  const v = String(clientVersion == null ? "" : clientVersion).trim();
  if (!v) return { allowed: true, why: "客户端没报版本" };
  if (!versionComparable(v)) return { allowed: true, why: "客户端版本 " + v + " 不是语义化版本，跳过最低版本闸" };
  const okv = versionGte(v, PASEO_MIN_VERSION);
  return { allowed: okv, why: okv ? "" : "客户端 " + v + " 低于最低版本 " + PASEO_MIN_VERSION };
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
  /* 「提问通道自检」的信任标志：**自检子进程**（MTNODE_PASEO_PROBE_CHILD=1）发出去的
     每一发都带上这枚头，MTNode 侧据此放行 `session/probe-question` / `probe-answer`
     两条口（它们只该给自检用，别处一律看不到）。
     为什么不能靠环境变量：自检是**另一个进程**（桥的父进程 spawn 出来的），而放行那道闸
     长在**正在跑的 MTNode** 身上 —— 父进程给子进程设的 env 永远到不了 MTNode 进程，
     于是控制台那颗「提问通道自检」在真机上必然报「未知的方法：session/probe-question」
     （2026-10-15 实测复现）。头是随请求走的，进程边界不丢。 */
  const selfcheck =
    String(process.env.MTNODE_PASEO_PROBE_CHILD || "") === "1" || server.selfcheck === true;
  if (selfcheck) auth["x-mtnode-selfcheck"] = "1";

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

/** 在途轮次的登记：**两个键指向同一个 turn** —— ACP 侧的 sessionId（可能是桥侧的
 *  mtnode-pending-…）与 MTNode 的那条 as… 会话 id。工具帧的「首帧 / 更新帧」判定靠它，
 *  只登记一个键就会出现「同一个 toolCallId 被翻成两张新卡」。 */
const turns = new Map();
/** ACP sessionId → { mode, ... }：mode 是「接着哪条会话」（见 session/new 的模式清单） */
const sessions = new Map();
/** 桥自己发的 pending 会话 id → { cwd, provider, model, effort, mtnodeId }：
 *  session/new 只登记、**不去 MTNode 建会话**（详见 session/new 处的说明）。 */
const pending = new Map();

/** 会话登记。 */
function registerSession(sid, patch) {
  const prev = sessions.get(String(sid)) || {};
  const next = Object.assign({ tools: new Set(), mode: String(sid) }, prev, patch || {});
  if (!(next.tools instanceof Set)) next.tools = new Set();
  sessions.set(String(sid), next);
  return next;
}

/** 桥侧的临时会话 id：**不再借 MTNode 的 as… 当 ACP sessionId**（那正是空会话的来源）。 */
let pendingCounter = 0;
function newPendingId() {
  pendingCounter += 1;
  return "mtnode-pending-" + Date.now().toString(36) + "-" + pendingCounter;
}

/** 轮次登记 / 撤销：两个键（ACP sessionId 与 as… 会话 id）一起管。 */
function setTurn(turn, sid, mtnodeId) {
  turns.set(String(sid), turn);
  if (mtnodeId && String(mtnodeId) !== String(sid)) turns.set(String(mtnodeId), turn);
  return turn;
}
function dropTurn(sid, mtnodeId) {
  turns.delete(String(sid));
  if (mtnodeId) turns.delete(String(mtnodeId));
}

function liveTurn(sessionId) {
  return turns.get(String(sessionId || "")) || null;
}

/* ── 模型清单（ACP 的 SessionModelState）─────────────────────────────────
   Paseo 的模型清单是**探针**出来的：fetchCatalog 真发一次 session/new，再从响应的
   models.availableModels 推导（acp-agent.js 的 deriveModelDefinitionsFromACP）。所以
   session/new 不回 models，手机上就永远「未检测到 Model」（真机 diagnostic：models=0）。

   modelId 用 "route::model" 编码：ACP 的 ModelInfo 只有 modelId / name / description，
   装不下「哪家供应商 + 哪个模型」两段。选模型时从**右往左**找最后一个 "::" 拆回两段
   （供应商 route 自己就带 ":"，如 mtnode_piai）。 */

/** 模型在 ACP configOptions 里的配置项 id（Paseo 只看 category=model，id 随便取但要稳定）。 */
const MODEL_CONFIG_ID = "model";

function encodeModelId(route, model) {
  return String(route || "") + "::" + String(model || "");
}
function decodeModelId(modelId) {
  const s = String(modelId || "");
  const i = s.lastIndexOf("::");
  if (i < 0) return { route: "", model: s };
  return { route: s.slice(0, i), model: s.slice(i + 2) };
}

/**
 * 模型清单 → ACP 的 SessionModelState。**session/new 与 session/load 都必须回它**：
 * Paseo 的 provider models 完全由「探针那次 session/new 的响应」推导
 * （acp-agent.js deriveModelDefinitionsFromACP），不回就是手机上「未检测到 Model」
 * （真机 diagnostic：models=0；`--check` 也会打印这个条数）。
 *
 * 渲染层不在（窗口关着 / 刚重启）时 /ctl session/models 会报错 —— 那种时候整个 provider
 * 变不可用更糟，这里退回一份「只有默认模型」的最小清单并把真实原因写进 description。
 */
async function modelsState(server) {
  const fallback = () => ({
    currentModelId: encodeModelId("", "default"),
    availableModels: [
      {
        modelId: encodeModelId("", "default"),
        name: "MTNode 默认模型",
        description: "拿不到 MTNode 的模型清单（渲染层未就绪 / 服务端刚重启）——在 MTNode 里选模型，或在控制台跑一次桥自检。",
      },
    ],
  });
  if (!server.ok) return fallback();
  let out = null;
  try {
    const client = createMtnodeClient(server);
    out = await client.ctl("session/models", {});
  } catch (e) {
    dbg("session/models failed", (e && e.message) || e);
    return fallback();
  }
  const providers = (out && out.providers) || [];
  const defaults = (out && out.defaults) || {};
  const availableModels = [];
  for (const p of providers) {
    const route = String(p.route || "");
    for (const m of p.models || []) {
      const model = String(m || "");
      if (!model) continue;
      availableModels.push({
        modelId: encodeModelId(route, model),
        name: model,
        description: (p.label ? String(p.label) + " · " : "") + route,
      });
    }
  }
  if (!availableModels.length) return fallback();
  const cur = encodeModelId(
    defaults.provider || providers[0].route,
    defaults.model || decodeModelId(availableModels[0].modelId).model,
  );
  return {
    currentModelId: availableModels.some((m) => m.modelId === cur) ? cur : availableModels[0].modelId,
    availableModels,
  };
}

/**
 * ACP 的 configOptions（category=model）。
 *
 * 为什么两条路都要给：Paseo 0.11.2 的「选模型」先在 `session/set_model` 上试一次，
 * **这条回错误时它就退到配置项这条路**（acp-agent.js 的 setModelWithSelection）；两条路都
 * 没有时它抛 `` `${provider} does not expose ACP model selection` `` —— 那句文案与真实原因
 * （本桥当时故意拒绝了 set_model）完全无关，正是用户报的这个错。所以：
 *   · set_model 现在**真的改**（见 session/set_model）；
 *   · 同时把模型清单也作为配置项露出：Paseo 以后改走配置项这条路时不会重犯，而且真拒绝时
 *     （模型不在清单 / 会话已被删）它会**把桥的原话**显示给手机，不再替换成那句含糊的话。
 */
function modelConfigOptions(models) {
  const list = ((models && models.availableModels) || [])
    .map((m) => {
      const value = String((m && m.modelId) || "");
      if (!value) return null;
      const option = { value, name: String((m && m.name) || value) };
      if (m && m.description) option.description = String(m.description);
      return option;
    })
    .filter(Boolean);
  if (!list.length) return [];
  const want = String((models && models.currentModelId) || "");
  const currentValue = list.some((o) => o.value === want) ? want : list[0].value;
  return [
    {
      id: MODEL_CONFIG_ID,
      name: "模型",
      description: "MTNode 的供应商与模型（换完从下一条消息生效，正在跑的那一轮不变）",
      category: "model",
      type: "select",
      currentValue,
      options: list,
    },
  ];
}

/** 一条会话的模型清单状态：清单来自 MTNode，**当前值优先用这条会话自己记的那个**（换过模型
 *  的会话再开清单时高亮的必须是新模型 —— Paseo 完全靠 currentModelId 打钩）。
 *  pending 会话（还没落地）用登记里的选择，已绑定的会话用 set_model 记下的那一份。 */
async function modelsStateFor(server, sid) {
  const models = await modelsState(server);
  const s = sessions.get(String(sid || "")) || pending.get(String(sid || ""));
  const route = String((s && s.provider) || "");
  const model = String((s && s.model) || "");
  if (!model) return models;
  const want = encodeModelId(route, model);
  if ((models.availableModels || []).some((m) => m.modelId === want)) models.currentModelId = want;
  return models;
}

/** MTNode 的会话清单（/ctl session/list）。手机端「可接管的已有会话」就靠它。 */
async function mtnodeSessions(server, limit) {
  const client = createMtnodeClient(server);
  const list = await client.ctl("session/list", { limit: Number(limit) || 200 });
  return (list && list.sessions) || [];
}

/** 「提问类工具」自己的 tool 事件：它的参数就是那份询问 JSON。
 *  这类事件**一张工具卡都不发** —— 手机上那张卡正是用户报的现场：
 *  Paseo 的 buildToolCallDisplayModel 用 `name`（daemon 填的 snapshot.kind）当标题，
 *  kind 认不出就落到 humanizeToolName("other") = **"Other"**，详情又是
 *  `{ type:"unknown", input: rawInput }` 的原始 JSON。题面已经由 questionChatText
 *  那条可读消息讲清楚了，工具卡只会再把 JSON 露一次（见文件头第 ④ 代口径）。 */
const ASK_TOOL_RE = /^(ask_user_question|ask_user|user-questions|user_questions|browser_help)$/i;

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
      /* 提问类工具不上卡（见 ASK_TOOL_RE 的注释）：它的 JSON 参数不该出现在手机上 */
      if (ASK_TOOL_RE.test(name.trim())) {
        const t0 = liveTurn(mtnodeSessionId);
        if (t0) t0.tools.add(String(d.callId || d.id || name));
        return null;
      }
      const callId = String(d.callId || d.id || name + "@" + (ev.seq || 0));
      const status = String(d.status || (d.error ? "failed" : d.result !== undefined ? "completed" : "pending"));
      const base = {
        toolCallId: callId,
        title: name,
        status: status === "running" ? "in_progress" : status,
        rawInput: d.args === undefined ? undefined : d.args,
        /* **不写死 kind**：ACP 的 ToolKind 是封闭枚举，"other" 会让 Paseo 把卡标题显示成
           humanizeToolName("other") = "Other"（工具名被丢掉）。省略 kind 时 daemon 用
           `snapshot.kind ?? snapshot.title` 兜底 —— 手机上显示的就是可读的工具名。 */
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

/** 「停下来等人」的那几类事件 → 手机上来回的那一发。
 *
 *  两条通道，按卡片类型分流：
 *   · `question`（模型提问）→ **一条可读聊天消息**（questionChatText，题面 / 选项 / 作答方式
 *     全是人话）+ 手机下一条消息作答（askQuestionViaChat / answerPendingAsk）；
 *   · `approval` / `canvas`（审批 / 画布确认）→ session/request_permission（允许 / 拒绝按钮）。
 *  见 askPermission。 */
function askOfEvent(sessionId, ev) {
  const type = String(ev.type || "");
  if (type !== "approval" && type !== "canvas" && type !== "question") return null;
  const d = ev.data || {};
  const id = String(d.id || "");
  if (!id) return null;
  if (type === "question") {
    /* 提问：题面/选项/多选/总结全在 questions[] 里（与 MTNode 询问卡同一份数据）。
       旧实现把 d.question / d.title 当标题取，多题与选项一律丢掉 —— 手机那边只剩
       「模型提问：<某题面>」+ 两个按钮，这就是「询问框没正确解析」的来源之一。 */
    const questions = (Array.isArray(d.questions) ? d.questions : [])
      .map((q) => ({
        id: String((q && q.id) || ""),
        question: String((q && q.question) || ""),
        header: q && q.header != null ? String(q.header) : "",
        detail: q && q.detail != null ? String(q.detail) : "",
        options: (Array.isArray(q && q.options) ? q.options : [])
          .map((o) => (typeof o === "string" ? { label: o } : o && typeof o === "object" ? o : null))
          .filter(Boolean)
          .map((o) => ({ label: String(o.label || ""), description: o.description != null ? String(o.description) : "" })),
        multiSelect: !!(q && q.multiSelect),
      }))
      .filter((q) => q.id || q.question);
    return {
      kind: "question",
      id,
      /* 抬头只留一句「这是要你作答的一问」；题数由 questionChatText 按实际装了几题拼
         —— 两处各拼一次会重复。 */
      title: "MTNode 询问",
      detail: "",
      questions,
    };
  }
  const kindLabel = type === "approval" ? "工具审批" : "画布修改确认";
  const title = String(d.title || d.name || d.tool || kindLabel);
  const detail = String(d.reason || d.detail || d.message || d.text || "").trim();
  return {
    kind: type,
    id,
    title: kindLabel + "：" + title,
    detail: detail ? oneLine(detail, 600) : "",
  };
}

/** 一张询问卡里**一道题**的可读正文：题干第一行 + 空行之后的 Markdown + 选项。
 *  手机端看到的就是这段人话（不渲染任何 JSON）；题面、选项与说明一律**原样、不截断**
 *  —— 选项就是用户照着作答的依据，少一个字都可能选错（只把换行压成空格）。
 *  `opts.number`：一窗多题时给每道题加「1. / 2.」序号（单题不加，免得像列表）。 */
function readableQuestion(q, idx, opts) {
  const o = opts || {};
  const text = String((q && q.question) || "");
  const nl = text.indexOf("\n\n");
  const head = (nl >= 0 ? text.slice(0, nl) : text).trim();
  const tail = nl >= 0 ? text.slice(nl + 2).trim() : "";
  const options = (Array.isArray(q && q.options) ? q.options : []).filter(Boolean);
  const lines = [];
  lines.push((o.number ? String(idx + 1) + ". " : "") + (head || String((q && q.header) || "") || "第 " + (idx + 1) + " 问"));
  if (q && q.detail) lines.push(String(q.detail).trim());
  if (tail) lines.push(tail);
  if (options.length) {
    /* 选项与说明**不截断**：手机上的这张卡就是照它作答的依据（与 MTNode 那侧同一条口径：
       卡片帧不做结构裁剪、文本也不截）。只把换行压成空格，免得一条选项撑成好几行。 */
    lines.push(
      (q.multiSelect ? "可多选" : "单选") +
        "：" +
        options.map((x) => oneLine(x.label) + (x.description ? "（" + oneLine(x.description) + "）" : "")).join(" / "),
    );
  }
  return lines.filter(Boolean).join("\n");
}

/** 一道题的 header（可读标题；题面没给 header 时按序号生成）—— 只在可读正文里用，
 *  MTNode 的 answers[] 按**题 id** 对齐（见 answersFromChat），不靠它。 */
function headerOf(q, idx) {
  const h = String((q && q.header) || "").replace(/[\r\n]+/g, " ").trim();
  return h || "第" + (idx + 1) + "问";
}

/** MTNode 的询问卡 → 手机上那条**可读消息**的正文（本次需求的核心：普通信息，不是 JSON）。
 *
 *  为什么不是权限卡 / 表单：见文件头「模型的询问卡走哪条 ACP 通道」第 ③ 代那条实测结论
 *  （ACP 的 ToolKind 没有 question，Paseo daemon 整帧拒掉；它的问句表单又不吃 ACP 的 input）。
 *  所以这里只做一件事：把题面、选项、以及「**怎么答**」写成一段 Markdown 人话，
 *  由 askQuestionViaChat 当普通助手消息发下去。 */
function questionChatText(ask) {
  const qs = Array.isArray(ask.questions) ? ask.questions : [];
  const lines = [];
  lines.push(qs.length > 1 ? "❓ MTNode 想问你 " + qs.length + " 个问题" : "❓ MTNode 想问你一个问题");
  if (String(ask.detail || "").trim()) lines.push("", String(ask.detail).trim());
  lines.push("");
  qs.forEach((q, idx) => {
    lines.push(readableQuestion(q, idx, { number: qs.length > 1 }));
    lines.push("");
  });
  lines.push(
    qs.length > 1
      ? "**怎么答**：直接回一条消息就是这一问的答案（可以几条一起答）。这条回复会被当作回答送回 MTNode，不会当成新指令；想中止请按停止。"
      : "**怎么答**：直接回一条消息就是答案。这条回复会被当作回答送回 MTNode，不会当成新指令；想中止请按停止。",
  );
  return lines.join("\n").trim();
}

/** 手机回的那**一条**消息 → MTNode 的 answers[]：`{ id, selected[] }`，**按题 id 对齐**
 *  （renderer/app-db.js 的 ixAnswerPairsOf 按 id 把答案对回题面；回 header 它就对不上了）。
 *
 *  手机端这一版没有逐题表单（Paseo 的问句表单经 ACP 到不了，见文件头），所以一条回复就是
 *  整张卡的答案：**逐题都填这条文本** —— 只填一题会让 MTNode 卡片上其余几题显示「（未作答）」，
 *  模型也会以为漏答了。同时给一条可读 answerText（MTNode 侧气泡与之后的上下文都用它）。 */
function answersFromChat(questions, text) {
  const list = (questions || []).filter(Boolean);
  const body = String(text == null ? "" : text).trim();
  const answers = list.map((q, idx) => {
    const a = { id: String((q && q.id) || "第" + (idx + 1) + "问") };
    if (body) a.selected = [body];
    return a;
  });
  const pairs = list.map(
    (q, idx) => "· " + oneLine(headerOf(q, idx), 60) + "：" + oneLine(readableQuestion(q, idx, {}).split("\n")[0], 160) + " → " + body,
  );
  return {
    answers,
    answerText: body ? ["【我在手机上回答】"].concat(pairs).join("\n") : "",
  };
}

/** 权限请求的选项（只管审批 / 画布确认；提问不走这条，见 askQuestionViaChat）。
 *  与 MTNode 卡片上的按钮一一对应：允许一次（审批再多一条「本会话后续都放行」）/ 拒绝。 */
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

/* ── 提问通道自检（--probe-question）─────────────────────────────────────── */

/**
 * 跑一次「提问通道」端到端自检，返回退出码（0 全通 / 1 某一拍断了）。
 *
 * 六拍逐个报：
 *   ① 桥进程起得来、initialize / session/new 通；
 *   ② 一轮真消息把会话落到 MTNode（拿到真 as… id）；
 *   ③ MTNode 从它自己那一侧发出询问卡；
 *   ④ 桥把它发成**一条可读的普通消息**（agent_message_chunk：题面 / 选项 / 作答方式都是人话，
 *      正文里没有 JSON；也**不再**发 session/request_permission(kind:"question") —— ACP 没有那个
 *      ToolKind，Paseo 会把整帧 -32602 拒掉）；
 *   ⑤ 手机回一条 prompt（文本）= 答案：桥按 ACP 收尾（end_turn，不新起一轮）；
 *   ⑥ 答案真的落到 MTNode（/ctl session/approval，带 answers[] + answerText）。
 *
 * 不依赖真模型：提问由 MTNode 的 demo 路径（`/ctl session/probe-question`）发出。
 */
async function runQuestionProbe(server) {
  const say = (s) => process.stdout.write(s + "\n");
  /** 给排障留痕：自检是**父进程**（可能被 Paseo 当 provider 拉起，stdout 是 ACP 协议面），
   *  子桥的 stdio 绝不能挂到父进程的 stdout 上 —— 那些 JSON-RPC 帧会撞进协议流。
   *  所以子桥的 stdio 全走管道，逐行转发到父进程 stderr（Paseo 侧记 daemon 日志）。 */
  const relay = (s) => {
    try {
      process.stderr.write("[paseo-probe] " + String(s).replace(/\r?\n$/, "") + "\n");
    } catch {}
  };
  const child = spawn(process.execPath, [path.join(HERE, "acp-bridge.mjs")], {
    cwd: APP_ROOT,
    env: Object.assign({}, process.env, {
      MTNODE_PASEO_PROBE_CHILD: "1",
      ...(server.ok ? { MTNODE_MCP_URL: server.base, MTNODE_MCP_TOKEN: server.token } : {}),
    }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const st = { frames: [], notes: [], waiters: new Map(), err: "", id: 5000 };
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m = null;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      st.frames.push(m);
      if (m.id !== undefined && m.method === undefined) {
        const w = st.waiters.get(m.id);
        if (w) {
          st.waiters.delete(m.id);
          w(m);
        }
      } else if (m.method) st.notes.push(m);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => {
    st.err += String(c);
    for (const line of String(c).split("\n")) if (line.trim()) relay(line);
  });
  const send = (method, params, timeoutMs) => {
    const id = ++st.id;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} }) + "\n");
    return new Promise((resolve) => {
      st.waiters.set(id, resolve);
      setTimeout(() => {
        if (st.waiters.has(id)) {
          st.waiters.delete(id);
          resolve({ error: { message: "超时（" + method + "）" } });
        }
      }, timeoutMs || 10000);
    });
  };
  const kill = () => {
    try {
      child.stdin.end();
    } catch {}
    try {
      child.kill();
    } catch {}
  };
  try {
    say("== MTNode 提问通道自检 ==");
    say("· 服务端：" + (server.ok ? server.base + "（来自 " + server.from + "）" : "未找到 —— " + server.error));
    const init = await send(
      "initialize",
      {
        protocolVersion: 1,
        /* 声明得**与真机 Paseo 一样**（它只有 fs + terminal，从不声明 elicitation）——
           自检才算「拿真客户端的形状」验这条链，而不是验一个更理想的客户端。 */
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: true },
        clientInfo: { name: "mtnode-probe", version: "0.11.2" },
      },
      15000,
    );
    if (!init.result) {
      say("✗ ① initialize 失败：" + JSON.stringify(init.error || init));
      say("   （桥的 stderr：" + oneLine(st.err, 400) + "）");
      return 1;
    }
    say("✓ ① 桥起得来：协议 v" + init.result.protocolVersion + " · " + (init.result.agentInfo || {}).name);
    const created = await send("session/new", { cwd: APP_ROOT, mcpServers: [] }, 15000);
    const sid = String((created.result && created.result.sessionId) || "");
    if (!sid) {
      say("✗ ① session/new 失败：" + JSON.stringify(created.error || created));
      return 1;
    }
    say("✓ ① session/new：" + sid + "（模型清单 " + (((created.result.models || {}).availableModels || []).length) + " 个）");
    /* ② 走一轮真消息把会话落到 MTNode（桥是懒创建的：第一条消息才 session/create）。
       文本只是自检标记，模型那边不参与 —— 紧接着就把这一轮停掉，只借它拿到真 as… id。 */
    const promptP = send(
      "session/prompt",
      { sessionId: sid, prompt: [{ type: "text", text: "MTNODE_PROBE(提问通道自检，请忽略)" }] },
      30000,
    );
    let mtnodeId = "";
    for (let i = 0; i < 120 && !mtnodeId; i++) {
      const m = /session\/create → (as[A-Za-z0-9_-]+)/.exec(st.err);
      if (m) mtnodeId = m[1];
      else await new Promise((r) => setTimeout(r, 100));
    }
    if (!mtnodeId) {
      say("✗ ② 桥没把会话落到 MTNode（拿不到 as… id）—— stderr：" + oneLine(st.err, 400));
      return 1;
    }
    say("✓ ② 会话已落到 MTNode：" + mtnodeId);
    await send("session/cancel", { sessionId: sid }, 5000);
    await promptP;
    /* ③ 让 MTNode **从它自己那一侧**发一张货真价实的询问卡
       （同一根 SSE 管子、同一帧形状；见 session-bridge.js 的 probeQuestion）。
       `selfcheck: true` → 这一发带上 x-mtnode-selfcheck 头：MTNode 那两道自检口只认它
       （父进程给子进程设的 env 到不了 MTNode，靠 env 判会把自检永远卡在 ③）。 */
    const made = await createMtnodeClient(Object.assign({}, server, { selfcheck: true })).ctl(
      "session/probe-question",
      {
        sessionId: mtnodeId,
        title: "MTNode 提问通道自检",
      },
    );
    if (!made || !made.ok) {
      say("✗ ③ 发不出自检询问卡：" + oneLine(JSON.stringify(made), 300));
      return 1;
    }
    say("✓ ③ MTNode 已发出询问卡：" + made.id);
    /* ④ 桥必须把它发成**一条可读的普通消息**（agent_message_chunk）：
       题面 / 选项 / 作答方式都是人话，正文里一个 JSON 都没有，
       而且**不能**再发 session/request_permission(kind=question) —— ACP 的 ToolKind
       没有 question，Paseo daemon 会把整帧 -32602 拒掉（这正是上一版的病根）。 */
    let msg = null;
    for (let i = 0; i < 40 && !msg; i++) {
      msg =
        st.notes.find(
          (m) =>
            String(m.method) === "session/update" &&
            String(((m.params || {}).update || {}).sessionUpdate || "") === "agent_message_chunk" &&
            String(((m.params || {}).update || {}).messageId || "") === "ask-" + String(made.id),
        ) || null;
      if (!msg) await new Promise((r) => setTimeout(r, 250));
    }
    if (!msg) {
      say("✗ ④ 桥没发这条询问消息（session/update + messageId=ask-" + made.id + "）—— 问题出在桥的上游（这一轮没收到 MTNode 的 question 帧？）");
      say("   stderr：" + oneLine(st.err, 400));
      return 1;
    }
    const askText = String((((msg.params || {}).update || {}).content || {}).text || "");
    if (!askText.trim()) {
      say("✗ ④ 询问消息是空的");
      return 1;
    }
    const badCard = st.notes.find(
      (m) =>
        String(m.method) === "session/request_permission" &&
        String(((m.params || {}).toolCall || {}).toolCallId || "") === "ask-" + String(made.id),
    );
    if (badCard) {
      say("✗ ④ 又发了 session/request_permission(kind=" + String((badCard.params.toolCall || {}).kind) + ") —— ACP 没有 kind:\"question\"，Paseo 会整帧拒掉；提问只走可读消息");
      return 1;
    }
    if (!/MTNode 提问通道自检/.test(askText) || !/怎么答/.test(askText)) {
      say("✗ ④ 消息里没有可读题面 / 作答说明：" + oneLine(askText, 300));
      return 1;
    }
    if (/\{\s*"/.test(askText)) {
      say("✗ ④ 消息正文里出现了 JSON 片段（手机上又会看到 JSON）：" + oneLine(askText, 300));
      return 1;
    }
    say("✓ ④ 询问消息（可读 · 无 JSON）：" + oneLine(askText, 240));
    /* ⑤ 模拟手机作答：**回一条 prompt（文本）** —— 桥必须把它当答案、
       不新起一轮（回 end_turn），并翻成 MTNode 的 answers[]。 */
    const answerText = "（自检）通道正常，这是手机侧输入的答案";
    const answerPrompt = send("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: answerText }] }, 20000);
    const ack = st.notes.find(
      (m) =>
        String(m.method) === "session/update" &&
        String(((m.params || {}).update || {}).messageId || "") === "ask-ok-" + String(made.id),
    );
    say(ack ? "✓ ⑤ 桥回了「已交给 MTNode」的回执消息（手机上看得见作答收口）" : "· ⑤ 没看到作答回执消息（不影响回执本身）");
    const answer = await answerPrompt;
    if (!answer || !answer.result || answer.result.stopReason !== "end_turn") {
      say("✗ ⑤ 那条消息没被当成答案（回的不是 end_turn）：" + oneLine(JSON.stringify(answer), 300));
      return 1;
    }
    say("✓ ⑤ 手机那条消息被当作答案接住（这一轮不新起，回 end_turn）");
    /* ⑥ 回执真的落到 MTNode：/ctl session/approval 带上 answers[]（按题 id 对齐）+ answerText */
    let got = null;
    for (let i = 0; i < 40; i++) {
      got = await createMtnodeClient(Object.assign({}, server, { selfcheck: true })).ctl(
        "session/probe-answer",
        {},
      );
      if (got && got.got) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (got && got.got && Array.isArray(got.answers) && got.answers.length) {
      const withSel = got.answers.filter((a) => a && Array.isArray(a.selected) && a.selected.length);
      say("✓ ⑥ MTNode 收到 answers[]：" + oneLine(JSON.stringify(got.answers), 400));
      if (withSel.length === got.answers.length && withSel.every((a) => a.selected[0] === answerText)) {
        say("== 提问通道自检通过：手机端看到的是可读的普通消息，文本作答能回到 MTNode ==");
        return 0;
      }
      say("✗ ⑥ 答案到了但对不上（每题都该拿到这条文本）—— 回执映射有问题");
      return 1;
    }
    say("✗ ⑥ MTNode 没收到 answers[] —— 断在回执这一段");
    say("   stderr：" + oneLine(st.err, 600));
    return 1;
  } catch (e) {
    say("✗ 自检崩了：" + ((e && e.message) || e));
    return 1;
  } finally {
    kill();
  }
}

/* ── 面板用：一份「桥在哪、怎么拉起、配什么」的状态 ─────────────────────
   实现放在 paseo/bridge-info.js（CJS，主进程的面板也 require 同一份），这里只转发，
   免得「面板显示的路径」与「桥自己的口径」成为两份会漂移的事实。 */
export { bridgePaths, providerSnippet, bridgeStatus } from "./bridge-info.js";

/* ── ACP 侧：主循环 ───────────────────────────────────────────────────── */

async function main() {
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
      lines.push("session/tools: 见 POST /ctl");
      /* 手机端「有没有模型可选 / 有没有会话可接管」的两个数字：控制台一个按钮就能看到，
         不用再去猜（这一轮的两个现场症状都出在这里）。 */
      const models = await modelsState(server);
      const list = models.availableModels || [];
      lines.push("models: " + list.length + "（当前 " + models.currentModelId + "）");
      for (const m of list.slice(0, 5)) lines.push("  - " + m.modelId);
      if (list.length > 5) lines.push("  … 还有 " + (list.length - 5) + " 个");
      /* 换模型的两条通道都要如实报出来：Paseo 选模型先走 set_model，回错误才退到配置项那条 ——
         只报一条会让人以为「修好了」，实际另一条缺着时手机端依旧报 does not expose … */
      lines.push(
        "model switching: session/set_model + session/set_config_option（category=model，每条会话改 provider/model，见 /ctl session/model）",
      );
      lines.push("configOptions(model): " + (modelConfigOptions(models).length ? "已露出" : "没露出（模型清单为空）"));
      /* 提问通道：静态自检时**没有客户端连着**，所以这里只能报口径；真机那一枪由
         `--probe-question` 跑（它自己当客户端，逐拍验完）。 */
      lines.push(ASK_CHANNEL_NOTE);
      lines.push("ask self-check: " + path.join(HERE, "acp-bridge.mjs") + " --probe-question（控制台「提问通道自检」同一份）");
      try {
        const sessions = await mtnodeSessions(server, 200);
        lines.push("sessions: " + sessions.length + " 条可接管（手机端「已有会话」清单）");
        for (const s of sessions.slice(0, 5)) {
          lines.push("  - " + s.id + "  " + oneLine(s.title || "(无标题)", 32) + (s.running ? " · 运行中" : ""));
        }
        if (sessions.length > 5) lines.push("  … 还有 " + (sessions.length - 5) + " 条");
      } catch (e) {
        lines.push("sessions: 读不到（" + ((e && e.message) || e) + "）");
      }
    }
    process.stdout.write(lines.join("\n") + "\n");
    return server.ok ? 0 : 2;
  }

  /* --probe-question：提问通道自检
     拿本文件当 ACP provider 跑一次**真桥**（子进程），自己当客户端把「模型提问」那一枪
     走完：initialize（能力位与真机 Paseo 同形）→ session/new → 让桥发一张询问卡
     （经 MTNode 的真实提问路径：/ctl session/probe-question）→ 按 question 卡作答 → 核对
     回执真的落到 MTNode（/ctl session/approval，带 answers[]）。
     为什么要有它：手机上「询问框没弹出 / 答了回不到 MTNode」时，光看日志分不清断在
     「桥没发」「卡的类型不对」「客户端不渲染」「回执送不回去」哪一拍 ——
     这条自检把六拍逐个报出来（控制台一键跑，见 paseo/ui）。 */
  if (argv.includes("--probe-question")) {
    return runQuestionProbe(server);
  }

  /* stdio ACP 主循环 */
  let buf = "";
  /** 本桥发出去的 session/request_permission：id → { resolve, sessionId, ask }。
   *  客户端（Paseo）的应答从 stdin 回来，按 id 认领 —— 认不到就是别的请求（这里没有）。
   *  **只有审批卡 / 画布确认卡走这张表**：ACP 里「向人要输入」也就这一条通道被普遍实现，
   *  而提问（question）走聊天消息 + 下一条消息作答（见文件头第 ④ 代口径 / textAsks）。 */
  const askWaiters = new Map();
  /** ACP sessionId → 一张「等手机文本作答」的询问（`kind:"question"`）：
   *  `{ ask, mtnodeId, qs, at }`。手机下一条 session/prompt 的正文就是答案（answerPendingAsk），
   *  在那之前 MTNode 那一轮一直挂着等人；这一轮自己收了尾 / 超时就把挂起项删掉。 */
  const textAsks = new Map();
  /** ACP sessionId → 定时器：手机 interrupt 之后多久还没等到那条答案 prompt，
   *  就当「用户真的按了停止」，照常停 MTNode 那一轮（见 session/cancel 的第一支）。 */
  const answerGrace = new Map();
  /** 手机上那条答案到了：撤掉宽限定时器（那一轮不该被停）。 */
  function clearAnswerGrace(sid) {
    const key = String(sid || "");
    const g = answerGrace.get(key);
    if (!g) return;
    clearTimeout(g);
    answerGrace.delete(key);
  }
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
      /* ① 先看是不是「我们发出去的请求」的应答（session/request_permission：审批 / 画布确认 /
         询问卡都走它）。提问卡的回执除了 optionId 还带 **updatedInput**（手机端填好的表单），
         少了它答案就白答了 —— 所以一并取下来。 */
      if (msg && msg.id !== undefined && msg.method === undefined) {
        const w = askWaiters.get(msg.id);
        if (w) {
          askWaiters.delete(msg.id);
          const oc = (msg.result && msg.result.outcome) || {};
          w.resolve(
            oc.optionId
              ? {
                  optionId: String(oc.optionId),
                  updatedInput:
                    msg.result && msg.result.updatedInput && typeof msg.result.updatedInput === "object"
                      ? msg.result.updatedInput
                      : null,
                }
              : null,
          );
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
      /* 客户端能力位**不参与提问通道的选择**（提问统一走一条可读聊天消息 + 下一条消息作答，
         见文件头「模型的询问卡走哪条 ACP 通道」第 ④ 代口径）。这里只把它打进 debug 日志，
         排障时能一眼看出对端声明了什么。 */
      dbg(
        "客户端能力：" + oneLine(JSON.stringify(p.clientCapabilities || {}), 300) +
          " · 提问通道不依赖 elicitation（走可读消息 + 手机文本作答）",
      );
      const gate = clientVersionAllowed(clientVersion);
      if (gate.why) dbg("版本闸：" + gate.why);
      if (!gate.allowed && !isNotification) {
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
          /* list：手机端「可导入的已有会话」清单 —— 不声明这一位，Paseo 直接 return []
             （acp-agent.js listImportableSessions 的第一道闸），手机上就永远看不到会话。
             close：探针 / 导入预览用完把会话收掉（声明了 Paseo 才会发 session/close）。 */
          sessionCapabilities: { list: {}, close: {} },
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
      const list = await mtnodeSessions(server);
      const opts = list.map((s) => ({
        id: String(s.id),
        name: oneLine(s.title || s.id, 48) + (s.running ? " · 运行中" : ""),
        description: "MTNode 会话 · " + (s.model || "默认模型") + " · " + new Date(s.updatedAt || 0).toLocaleString(),
      }));
      const availableModes = [{ id: "new", name: "新建 MTNode 会话", description: "在 MTNode 左栏新建一条会话" }, ...opts];
      return { currentModeId: "new", availableModes };
    }

    /**
     * 把「换模型」真的落到 MTNode：改的是这条会话的 provider / model 两个字段（与电脑上界面那两格
     * 「模型提供商 / 模型」同一落点，见 renderer/app-session-bridge.js 的 sessionModel），下一条消息
     * 生效。历史消息与**正在跑的那一轮**都不动 —— 那一轮的服务商与模型在开轮时就已经定下。
     *
     * 「模型是每条会话的属性、换不了」这个旧前提是错的：MTNode 界面本来就允许随时换（换的就是这两个
     * 字段，下一轮开轮时读它），所以这里不再假装拒绝。
     *
     * pending 会话（还没在 MTNode 落地）：只记下，第一次发消息时随 session/create 一起下发；
     * 已绑定的会话：走 /ctl session/model 真改一次，失败**原样抛**（调用方把原话回给客户端）。
     */
    async function applySessionModel(sid, sel) {
      if (!sid) throw new Error("换模型需要 sessionId");
      const s = sessions.get(sid) || null;
      const pend = pending.get(sid) || null;
      if (pend) {
        pend.provider = sel.route || pend.provider;
        pend.model = sel.model;
        if (s) {
          s.provider = pend.provider;
          s.model = pend.model;
        }
        dbg("set model (pending)", sid, pend.provider, pend.model);
        return { where: "pending", provider: pend.provider, model: pend.model };
      }
      const target = String((s && s.mtnodeId) || "").trim();
      if (!target) throw new Error("这条会话没有对应的 MTNode 会话（先 session/new 或 session/load）：" + sid);
      if (!server.ok) throw new Error("接不上 MTNode：" + server.error);
      const client = createMtnodeClient(server);
      const out = await client.ctl("session/model", {
        sessionId: target,
        ...(sel.route ? { provider: sel.route } : {}),
        model: sel.model,
      });
      const provider = String((out && out.provider) || sel.route || (s && s.provider) || "");
      const model = String((out && out.model) || sel.model || "");
      registerSession(sid, { provider, model, mtnodeId: target });
      dbg("set model", sid, provider, model);
      /* 正在跑一轮：给手机推一句说明 —— 这一轮仍是旧模型（不静默，也别让人以为这一轮也换了） */
      const t = liveTurn(sid) || liveTurn(target);
      if (t && !t.done) {
        notify("session/update", {
          sessionId: sid,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "as-model-" + sid + "-" + Date.now(),
            content: {
              type: "text",
              text:
                "\n\n⚠️ 已把这条会话的模型换成 " +
                (provider ? provider + " · " : "") +
                model +
                "。正在跑的这一轮仍是原来的模型，新模型从下一条消息开始生效。\n",
            },
          },
        });
      }
      return { where: "session", provider, model };
    }

    /**
     * session/new：**只登记，不在 MTNode 建会话**。
     *
     * 为什么必须懒创建：Paseo 每次刷新 provider 清单都会真发一次 session/new 做探针
     * （acp-agent.js fetchCatalog），旧的实现当场调 session/create —— 于是每刷一次清单，
     * MTNode 左栏就多一条空会话（真机实测：%APPDATA% 下 8 条 630B、标题「新会话」、
     * messages: [] 的垃圾）。探针**根本收不走**它们（MTNode 侧没有删除会话的能力）。
     * 改为：session/new 发一个桥侧的临时 id，第一次 session/prompt 才真的建会话。
     */
    if (method === "session/new") {
      if (!server.ok) return replyErr(id, -32000, "接不上 MTNode：" + server.error);
      const models = await modelsState(server);
      const { route, model } = decodeModelId(models.currentModelId);
      const sid = newPendingId();
      pending.set(sid, { cwd: String(p.cwd || ""), provider: route, model, effort: "" });
      registerSession(sid, { mode: "new", provider: route, model, mtnodeId: "" });
      let modes = null;
      try {
        modes = await modeState();
        modes.currentModeId = "new";
      } catch {
        modes = null;
      }
      return reply(id, {
        sessionId: sid,
        models,
        /* 模型也作为配置项露出（见 modelConfigOptions 的说明：Paseo 的选模型有两条路） */
        configOptions: modelConfigOptions(models),
        ...(modes ? { modes } : {}),
      });
    }

    /**
     * 把一条已有会话的正文回放成 ACP 的 session/update（session/load 的正文那一半）。
     *
     * 为什么必须回放：Paseo 判断「这条会话值不值得出现在可导入清单里」看的是
     * `describeImportableSession` → `loadImportPromptPreviews` 期间收到的帧里有没有
     * 会话内容（ACPImportHistoryCollector 的 hasConversation，只有 user/agent 消息帧、
     * tool_call、plan 才算）——**一条帧都不发，它会认定这条会话没有对话、直接从清单里剔掉**
     * （hasConversation === false → return null）。也就是说：只声明 list + 只回元数据，
     * 手机上依然是空的。这里按 MTNode 的正文顺序回放：用户消息 → user_message_chunk，
     * 助手消息 → agent_message_chunk（每段带自己的 messageId，Paseo 按它分段）。
     */
    async function replayHistory(client, sid) {
      let body = null;
      try {
        body = await client.ctl("session/read", { sessionId: sid, limit: HISTORY_LIMIT, bodyLimit: HISTORY_BODY_LIMIT });
      } catch (e) {
        return { ok: false, why: (e && e.message) || "会话不可用" };
      }
      const list = Array.isArray(body && body.messages) ? body.messages : [];
      const base = Math.max(0, (Number(body && body.total) || list.length) - list.length);
      let n = 0;
      for (let i = 0; i < list.length; i++) {
        const m = list[i] || {};
        const text = String(m.content == null ? "" : m.content).trim();
        if (!text) continue;
        const isUser = String(m.role || "") === "user";
        n += 1;
        notify("session/update", {
          sessionId: sid,
          update: {
            sessionUpdate: isUser ? "user_message_chunk" : "agent_message_chunk",
            messageId: "as-" + sid + "-" + (base + i + 1),
            content: { type: "text", text },
          },
        });
      }
      dbg("replay", sid, n + " frames");
      return { ok: true, frames: n, total: Number(body && body.total) || list.length };
    }

    if (method === "session/load") {
      const sid = String(p.sessionId || "");
      if (!sid) return replyErr(id, -32602, "session/load 需要 sessionId");
      const client = createMtnodeClient(server);
      /* 正文回放：先发帧再回应答（ACP 的顺序就是这样，Paseo 也正是在等这些帧） */
      const rep = await replayHistory(client, sid);
      if (!rep.ok) return replyErr(id, -32004, rep.why || "会话不可用");
      registerSession(sid, { mode: sid, mtnodeId: sid, cwd: String(p.cwd || "") });
      /* 回 models：手机在「接着已有会话」这条路上也要显示可选模型；配置项那条路同样给上 */
      const models = await modelsStateFor(server, sid);
      return reply(id, { models, configOptions: modelConfigOptions(models) });
    }

    /**
     * session/list：把 MTNode 左栏的会话交给 Paseo 的「可导入会话」清单。
     *
     * 两处闸门都要过：① initialize 里必须声明 agentCapabilities.sessionCapabilities.list
     * （没声明 Paseo 直接 return []，一个都不问）；② 本方法要真的实现。Paseo 会对每条
     * 会话再发一次 session/load 取首末消息做预览（acp-agent.js describeImportableSession），
     * 所以这里只回轻量元数据，不算重量级的活。
     */
    if (method === "session/list") {
      if (!server.ok) return replyErr(id, -32000, "接不上 MTNode：" + server.error);
      const wantCwd = String(p.cwd || "").trim();
      const cursor = Number(p.cursor) || 0;
      const PAGE = 50;
      let list = [];
      try {
        list = await mtnodeSessions(server);
      } catch (e) {
        return replyErr(id, -32000, "读不到 MTNode 的会话清单：" + ((e && e.message) || e));
      }
      const abs = (s) => {
        const w = String((s && s.workspace) || "").trim();
        return w && path.isAbsolute(w) ? w : process.cwd();
      };
      const all = list.filter((s) => s && s.id);
      const page = all.slice(cursor, cursor + PAGE);
      const sessions = page.map((s) => ({
        sessionId: String(s.id),
        cwd: abs(s),
        title: s.title ? String(s.title) : null,
        updatedAt: s.updatedAt ? new Date(Number(s.updatedAt)).toISOString() : null,
      }));
      const shown = wantCwd ? sessions.filter((s) => s.cwd === wantCwd) : sessions;
      const next = cursor + PAGE < all.length ? String(cursor + PAGE) : null;
      return reply(id, { sessions: shown, ...(next ? { nextCursor: next } : {}) });
    }

    if (method === "session/set_mode") {
      const sid = String(p.sessionId || "");
      const want = String(p.modeId || p.mode || "");
      const s = sessions.get(sid);
      if (s) s.mode = want;
      return reply(id, {});
    }

    /**
     * session/set_model：手机换模型（Paseo 选模型先走的就是这条）。
     *
     * 口径：**真的改** —— 落到这条 MTNode 会话的 provider / model 两个字段（与电脑上界面那两格
     * 同一落点），下一条消息用它；历史与正在跑的那一轮不变。pending 会话只记下、建会话时下发；
     * 会话已被删 / 模型不在清单里则如实报错（不假装成功）。
     *
     * 为什么这条**不能**再回错误：Paseo 0.11.2 的 setModel 只在它成功时才认；回错误它就退到
     * ACP 的配置项那条路（session/set_config_option），当时那条路不存在 → 抛出
     * `` `${provider} does not expose ACP model selection` `` —— 用户看到的报错与真实原因无关。
     */
    if (method === "session/set_model") {
      const sid = String(p.sessionId || "");
      const want = String(p.modelId || p.model || "");
      if (!want) return replyErr(id, -32602, "session/set_model 需要 modelId");
      const { route, model } = decodeModelId(want);
      if (!model) return replyErr(id, -32602, "modelId 里没有模型名：" + want);
      try {
        await applySessionModel(sid, { route, model });
      } catch (e) {
        return replyErr(id, -32602, (e && e.message) || String(e));
      }
      return reply(id, {});
    }

    /* 配置项那条路（ACP 的 session/set_config_option，category=model）：与 set_model 同一份实现。
       Paseo 在 set_model 回错误时会退到这条 —— 两条都在，它就不会再抛「does not expose …」，
       而且桥真拒绝时它会把原话显示出来。应答必须带上新的 configOptions（ACP 契约）。 */
    if (method === "session/set_config_option") {
      const sid = String(p.sessionId || "");
      if (String(p.configId || "") !== MODEL_CONFIG_ID) {
        return replyErr(id, -32602, "本桥只有一个会话配置项（" + MODEL_CONFIG_ID + "），收到 configId=" + String(p.configId || "（空）"));
      }
      const want = String(p.value || "");
      if (!want) return replyErr(id, -32602, "session/set_config_option 需要 value");
      const { route, model } = decodeModelId(want);
      if (!model) return replyErr(id, -32602, "配置项的值里没有模型名：" + want);
      try {
        await applySessionModel(sid, { route, model });
      } catch (e) {
        return replyErr(id, -32602, (e && e.message) || String(e));
      }
      const models = await modelsStateFor(server, sid);
      return reply(id, { configOptions: modelConfigOptions(models) });
    }

    /** session/close：探针与「导入预览」用完就关（声明了 close 能力才会被调用）。 */
    if (method === "session/close") {
      const sid = String(p.sessionId || "");
      pending.delete(sid);
      sessions.delete(sid);
      textAsks.delete(sid);
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

      /* ── 先看这条消息是不是「在回答一张问卡」（见文件头第 ④ 代口径）──
         手机端没有逐题表单：题面是我们发下去的一条可读消息，**用户的回复就是答案**。
         答上了就把 answers[] 打回 MTNode（不新起一轮）；那张卡已经失效（电脑上答过 /
         那一轮已收尾）就落下去按普通消息发，绝不吞掉用户的话。 */
      const pendingAsk = textAsks.get(sid);
      if (pendingAsk) {
        const answered = await answerPendingAsk(sid, text);
        if (answered.ok) {
          /* 手机的这条消息正是刚才那一枪 interrupt 要送的东西：别再把 MTNode 那一轮停掉 */
          clearAnswerGrace(sid);
          notify("session/update", {
            sessionId: sid,
            update: {
              sessionUpdate: "agent_message_chunk",
              messageId: "ask-ok-" + pendingAsk.ask.id,
              content: { type: "text", text: "✅ 已把你的回答交给 MTNode（这一轮接着往下跑）。" },
            },
          });
          return reply(id, { stopReason: "end_turn" });
        }
      }

      const client = createMtnodeClient(server);
      const rec = sessions.get(sid) || {};
      const pend = pending.get(sid) || null;
      /* 懒创建：session/new 登记过、还没落地 → 这一轮**和发消息合成一次调用**
         （session/send 支持不带 sessionId + 带 provider/model/effort 自己新建），
         于是既没有空会话垃圾，也不用多一次往返。 */
      const createOpts = pend
        ? {
            ...(pend.provider ? { provider: pend.provider } : {}),
            ...(pend.model ? { model: pend.model } : {}),
            ...(pend.effort ? { effort: pend.effort } : {}),
          }
        : null;
      const targetId = String(rec.mtnodeId || (pend ? "" : sid) || "");
      if (!targetId && !createOpts) return replyErr(id, -32602, "会话不存在（先 session/new）：" + sid);

      const turn = {
        id,
        sessionId: sid,
        mtnodeId: targetId,
        tools: new Set(),
        done: false,
        cancelled: false,
        stream: null,
        timer: null,
      };
      setTurn(turn, sid, targetId);

      /** 收掉这一轮的流与登记（**不回执**）—— 回执由 finish 负责，或早已回过（手机作答那一路）。 */
      const settle = () => {
        clearTimeout(turn.timer);
        const grace = answerGrace.get(sid);
        if (grace) {
          clearTimeout(grace);
          answerGrace.delete(sid);
        }
        try {
          turn.stream && turn.stream.close();
        } catch {}
        dropTurn(sid, turn.mtnodeId);
      };
      turn.settle = settle;

      const finish = (reason) => {
        if (turn.done) return;
        turn.done = true;
        settle();
        reply(id, { stopReason: reason });
      };

      /* 先挂实时流，再发消息：否则这一轮最早那几帧会漏掉。
         还没落地（懒创建）的会话在这里**同步建一次**：建完才有真的 as… 可以挂流，
         也不会出现「流挂在临时 id 上、MTNode 的事件一条都匹配不上」。 */
      if (!turn.mtnodeId) {
        try {
          const created = await client.ctl("session/create", createOpts || {});
          const realId = String(created.sessionId || "");
          if (!realId) throw new Error("MTNode 没有回会话 id");
          turn.mtnodeId = realId;
          setTurn(turn, sid, realId);
          pending.delete(sid);
          registerSession(sid, { mtnodeId: realId, mode: "new" });
          dbg("lazy create", realId);
          /* 一行**稳定标记**：提问通道自检（--probe-question）靠它认领这条会话的真 as… id
             （自检是另一个进程，只有 stderr 这条路能拿到桥内部的映射）。与 DEBUG 无关。 */
          try {
            process.stderr.write("[paseo-bridge] session/create → " + realId + "\n");
          } catch {}
        } catch (e) {
          dropTurn(sid, turn.mtnodeId);
          return replyErr(id, -32000, "建不了 MTNode 会话：" + ((e && e.message) || e));
        }
      }
      const mid = turn.mtnodeId;
      let started = false;
      const pendingEv = [];
      turn.stream = client.stream(
        mid,
        (ev) => {
          const t = String(ev.type || "");
          if (t === "round-end" || t === "done") {
            /* 一轮收尾：等 MTNode 的 done 到了才回 stopReason（不外泄内部帧）。
               这一轮若因为「手机先 interrupt 再作答」已经回过执（turn.done），就只收流；
               顺手把这一轮挂着的问卡撤掉 —— MTNode 那边这一轮已经结束（电脑上答过 /
               手机上答过 / 被停），挂起项再留着只会误吞用户的下一条消息。 */
            textAsks.delete(sid);
            if (!started) pendingEv.push(ev);
            else if (turn.done) settle();
            else finish(turn.cancelled ? "cancelled" : "end_turn");
            return;
          }
          const ask = askOfEvent(mid, ev);
          if (ask) {
            void askPermission(sid, mid, ask);
            return;
          }
          const upd = toAcpUpdate(mid, ev);
          if (!upd) return;
          if (!started) return pendingEv.push({ __upd: upd });
          notify("session/update", { sessionId: sid, update: upd });
        },
        (st) => dbg("stream state", st),
      );

      turn.timer = setTimeout(() => finish("max_turn_requests"), TURN_TIMEOUT_MS);
      if (turn.timer && typeof turn.timer.unref === "function") turn.timer.unref();

      try {
        const r = await client.ctl("session/send", { sessionId: mid, text });
        started = true;
        dbg("sent", r);
      } catch (e) {
        /* 只有这一条出口能回 id 的 error：**先撤掉 turn**，别再让 finish 回一次 result
           （同一 id 回两条 = 客户端把它当重复帧丢掉，还会留下一条假 stopReason）。 */
        turn.done = true;
        settle();
        return replyErr(id, -32000, "发不出去：" + ((e && e.message) || e));
      }
      for (const ev of pendingEv.splice(0)) {
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
      /* 手机上「发一条消息」= **先 interrupt 再 prompt**（Paseo 默认 activeTurnBehavior =
         "interrupt"，见 daemon 的 session.js / agent-manager.replaceAgentRun）—— 正等作答时，
         这一枪打断不是要停这一轮，而是为了把「答案」发过来（见文件头第 ④ 代口径）。
         所以这一支：不打 MTNode 的 session/stop、也不回收事件流（模型接着跑的输出照旧推到手机），
         只按 ACP 要求把旧那一枪以 cancelled 收尾（客户端在等它），随后那条 prompt 就是答案。
         真按「停止」的情况由 ANSWER_WAIT_AFTER_CANCEL_MS 兜底：等不到那条 prompt 就照常停。 */
      const pendingAsk = textAsks.get(sid);
      if (pendingAsk) {
        if (t && !t.done) {
          t.done = true; /* 已经回过执了：别让 finish 再回一次 */
          t.cancelled = false; /* 这不是「这一轮被取消」—— 它还在 MTNode 那边等人作答 */
          clearTimeout(t.timer);
          reply(t.id, { stopReason: "cancelled" });
        }
        const prevGrace = answerGrace.get(sid);
        if (prevGrace) clearTimeout(prevGrace);
        const grace = setTimeout(() => {
          answerGrace.delete(sid);
          textAsks.delete(sid);
          dbg("打断后没等到答案（用户真的按了停止）—— 照常停 MTNode 这一轮");
          void stopTurnOnCancel(sid, pendingAsk.mtnodeId, liveTurn(sid));
        }, ANSWER_WAIT_AFTER_CANCEL_MS);
        if (grace && typeof grace.unref === "function") grace.unref();
        answerGrace.set(sid, grace);
        dbg("cancel 落在正等作答的那一轮上：不停 MTNode，等手机那条答案");
        return isNotification ? undefined : reply(id, {});
      }
      if (t) t.cancelled = true;
      /* 叫停要打 MTNode 那条**真会话**（as…），不是桥侧的 sessionId */
      const stopId = String((t && t.mtnodeId) || (sessions.get(sid) || {}).mtnodeId || sid);
      if (server.ok) {
        try {
          const client = createMtnodeClient(server);
          await client.ctl("session/stop", { sessionId: stopId });
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
            if (typeof t.settle === "function") t.settle();
            else {
              clearTimeout(t.timer);
              try {
                t.stream && t.stream.close();
              } catch {}
              dropTurn(sid, t.mtnodeId);
            }
            reply(t.id, { stopReason: "cancelled" });
          }
        }, 1500);
      }
      return isNotification ? undefined : reply(id, {});
    }

    if (isNotification) return undefined;
    return replyErr(id, -32601, "本桥不支持这个方法：" + method);
  }

  /** 真按了「停止」（打断后没等到那条答案 prompt）：照旧停 MTNode 那一轮并收掉事件流。
   *  ACP 那一侧早已以 cancelled 回执过（见 session/cancel 的第一支），这里只做 MTNode 侧的收尾。 */
  async function stopTurnOnCancel(sessionId, mtnodeId, t) {
    const stopId = String(mtnodeId || (t && t.mtnodeId) || (sessions.get(sessionId) || {}).mtnodeId || sessionId);
    if (server.ok) {
      try {
        await createMtnodeClient(server).ctl("session/stop", { sessionId: stopId });
      } catch (e) {
        dbg("cancel failed", (e && e.message) || e);
      }
    }
    if (t && typeof t.settle === "function") t.settle();
  }

  /** 把 MTNode 那张「停下来等人」的卡交给手机，按用户的选择回执。
   *
   *  **两条通道，按卡片类型分流**（口径见文件头「模型的询问卡走哪条 ACP 通道」）：
   *   · `question`（模型提问 / 收尾确认卡）→ **普通聊天消息**（questionChatText，题面可读、
   *     一个 JSON 都没有）+ 手机下一条消息作答（askQuestionViaChat）；
   *   · `approval` / `canvas`（审批 / 画布确认）→ `session/request_permission`
   *     （toolCall.kind:"other"，本来就是「允许 / 拒绝」几个按钮的事）。
   *  客户端的卡片渲染不出来时**至少也是人话**：题面与选项都在正文 / 标题里，
   *  绝不把 MTNode 事件的原始 JSON 塞给它看。
   *
   *  Paseo 没答 / 断了 → 什么都不回执：MTNode 那边**永久等待**（共识：断线不自动拒绝）。
   *
   *  两个 id 别混：**通知给客户端的 sessionId 必须是 ACP 那个**（客户端按它归位这条会话），
   *  而打回 MTNode 的回执必须带**真 as… 会话 id**（否则回执落不到那条会话上）。 */
  async function askPermission(sessionId, mtnodeId, ask) {
    if (ask.kind === "question") return askQuestionViaChat(sessionId, mtnodeId, ask);
    return askPermissionViaPermissionRaw(sessionId, mtnodeId, ask);
  }

  /** 组装一张权限卡的帧（审批 / 画布确认用）。 */
  function permissionFrame(sessionId, reqId, ask, toolCallKind, extra) {
    return {
      jsonrpc: "2.0",
      id: reqId,
      method: "session/request_permission",
      params: {
        sessionId,
        toolCall: {
          toolCallId: "ask-" + ask.id,
          title: ask.title,
          kind: toolCallKind,
          status: "pending",
          ...(ask.detail ? { content: [{ type: "content", content: { type: "text", text: ask.detail } }] } : {}),
          ...(extra || {}),
        },
        options: permissionOptions(ask),
      },
    };
  }

  /** 发出这张卡，等用户作答（超时 / 断开都回 null，由调用方决定怎么收）。 */
  async function awaitAsk(reqId, ask) {
    const p = new Promise((resolve) => {
      askWaiters.set(reqId, { resolve, sessionId: "", ask });
    });
    let ans = null;
    try {
      ans = await Promise.race([
        p,
        new Promise((r) => setTimeout(() => r(null), ASK_TIMEOUT_MS)),
      ]);
    } finally {
      askWaiters.delete(reqId);
    }
    return ans;
  }

  /** 询问卡（**普通聊天消息** + 手机下一条消息作答）：一份消息装下全部问题。
   *
   *  为什么不走权限卡 / 表单：见文件头第 ③ 代那条实测结论（ACP 的 ToolKind 没有 question，
   *  Paseo daemon 会把整帧 -32602 拒掉；它的问句表单又只认自己 provider 填的 input）。
   *  于是把题面写成一段可读 Markdown 当普通助手消息发下去，答案就是用户的下一条消息：
   *  由 session/prompt 那一支接住（answerPendingAsk），翻成 answers[] 打回 MTNode。
   *
   *  这里**不 await**（不占着这一轮的事件流）：这一轮还挂在 MTNode 那边等人，
   *  手机随时可以答；答了、或那一轮自己收了尾（电脑上答过 / 被停），这个挂起项就作废。 */
  async function askQuestionViaChat(sessionId, mtnodeId, ask) {
    const qs = Array.isArray(ask.questions) ? ask.questions : [];
    const text = questionChatText(ask);
    /* 同一会话又来一张问卡：旧的作废（MTNode 一次只会挂一张，新的一定是最新的） */
    textAsks.set(sessionId, { ask, mtnodeId, qs, at: Date.now() });
    notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "ask-" + ask.id,
        content: { type: "text", text },
      },
    });
    dbg(
      "问卡（聊天消息）：题数=" + qs.length +
        " 题=" +
        qs.map((q, i) => headerOf(q, i) + ":" + ((q.options || []).length ? ((q.multiSelect ? "多选" : "单选") + q.options.length) : "文本")).join(",") +
        " · 等手机回一条消息作答",
    );
  }

  /** 手机那一条消息 → 答案：翻成 answers[] / answerText 打回 MTNode。
   *  返回 `{ ok:true }` = 已送达（调用方别再把它当新消息发下去）；
   *  `{ ok:false, stale:true }` = MTNode 明确说这张卡已经失效（电脑上答过 / 那一轮已结束）——
   *  调用方要把这条消息**按普通消息**继续下发，别吞掉用户的话。 */
  async function answerPendingAsk(sessionId, text) {
    const rec = textAsks.get(sessionId);
    if (!rec) return { ok: false };
    if (Date.now() - rec.at > TEXT_ASK_TTL_MS) {
      textAsks.delete(sessionId);
      dbg("挂起的问卡超时作废（" + Math.round(TEXT_ASK_TTL_MS / 60000) + " 分钟）—— 这条消息按普通消息下发");
      return { ok: false };
    }
    textAsks.delete(sessionId);
    const fromChat = answersFromChat(rec.qs, text);
    const r = await receiptToMtnode(sessionId, rec.mtnodeId, rec.ask, "answered", fromChat.answers, fromChat.answerText, {
      card: false,
    });
    if (!r || r.stale || r.ok === false) {
      dbg("这条消息没被当成答案（那张问卡已失效 / 回执没送到）—— 按普通消息下发");
      return { ok: false, stale: !!(r && (r.stale || r.ok === false)) };
    }
    dbg("手机上作答：answers=" + oneLine(JSON.stringify(fromChat.answers), 400));
    return { ok: true };
  }

  /** 审批 / 画布确认：session/request_permission，按选择的 optionId 回执。
   *  提问**不走这里**（它走 askQuestionViaChat 的聊天消息）。 */
  async function askPermissionViaPermissionRaw(sessionId, mtnodeId, ask) {
    const reqId = 900000 + (askCounter += 1);
    out(permissionFrame(sessionId, reqId, ask, "other", null));
    const ans = await awaitAsk(reqId, ask);
    if (!ans) return; /* 客户端把这一枪丢了（断开）：MTNode 那边继续等 */
    const outcome = String(ans.optionId || "");
    const mapped = outcome === "reject" ? "rejected" : outcome === "allow-session" ? "allowed-session" : "allowed-once";
    await receiptToMtnode(sessionId, mtnodeId, ask, mapped, null, null);
  }

  /** 把用户的选择送回 MTNode（各条路共用）：
   *  先给手机一个明确的回执帧（tool_call_update），再调 /ctl 的 session/approval。
   *  提问那条要带 `answers[]`（按题 id 对齐）与一条可读 `answerText` —— MTNode 的
   *  renderer/app-session-bridge.js 认这两样（`selected[]` 是给界面按钮用的下脚料，不用）。
   *  `opts.card === false`：这条通道**本来就没有工具卡**（提问走聊天消息）—— 别再发
   *  tool_call_update：ACP 客户端收到陌生 toolCallId 的更新会**新建**一张工具卡
   *  （手机上又是一张「Other」+ JSON，正是本次要修掉的现场）。
   *  返回值 = /ctl 的应答（调用方据此判 stale），送不出去时为 null。 */
  async function receiptToMtnode(sessionId, mtnodeId, ask, outcome, answers, answerText, opts) {
    const o = opts || {};
    const client = createMtnodeClient(server);
    if (o.card !== false) {
      notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "ask-" + ask.id,
          status: outcome === "rejected" ? "failed" : "completed",
        },
      });
    }
    try {
      return await client.ctl("session/approval", {
        id: ask.id,
        sessionId: mtnodeId,
        kind: ask.kind,
        outcome,
        ...(ask.kind === "question" && Array.isArray(answers) ? { answers } : {}),
        ...(ask.kind === "question" && answerText ? { answerText } : {}),
      });
    } catch (e) {
      notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "\n\n⚠️ 回执没能送到 MTNode：" + ((e && e.message) || e) + "\n" },
        },
      });
      return null;
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

/* main 现在是 async（--check 要 await 模型 / 会话清单）：退出码用 then 收，
   同步返回的 0（--config 那条路）也照旧走 process.exit。 */
Promise.resolve(main()).then(
  (code) => {
    if (typeof code === "number") process.exit(code);
  },
  (e) => {
    try {
      process.stderr.write("[" + BRIDGE_NAME + "] 启动失败：" + ((e && e.message) || e) + "\n");
    } catch {}
    process.exit(1);
  },
);
