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
 *                                  # 「MTNode 发询问卡 → form elicitation → 答案回到 MTNode」
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

/* ── 模型的「询问卡」走哪条 ACP 通道 ─────────────────────────────────────
 * MTNode 的 ask_user_question（以及收尾那张带 Markdown 总结的确认卡）以前被当成
 * **权限请求**发给手机：`session/request_permission` + 两个按钮（允许一次 / 拒绝）。
 * 那条通道表达不了题面、选项与自由文本，回执也只有 optionId —— 用户看到一张审批卡，
 * 答案回不到模型。ACP 为「向用户要输入」准备了另一条通道：**form 模式的
 * `session/elicitation`**（client 声明 `clientCapabilities.elicitation.form`，
 * agent 发 `{ message, mode:"form", requestedSchema }`，client 回
 * `{ action:"accept", content:{ <字段名>: 值 } }`）。
 * 现在：能 elicitation 就 elicitation（题面/选项/多选/自由文本都能装），
 * 不能才回退权限请求（老实说清「这台手机答不了」）——见 questionViaPermission 的注释。 */
const CLIENT_CAP_ELICITATION_FORM = "elicitation.form";
/** 用户把卡放着不答时等多久（真实上限由 request.signal 兜底：宿主「中断任务」时 resolve(null)） */
const ASK_TIMEOUT_MS = 24 * 60 * 60 * 1000;

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

/** 「停下来等人」的那几类事件 → 一张卡（手机上来回的那一发）。
 *
 *  `question`（模型提问）与 `approval` / `canvas`（审批 / 画布确认）的**通道不同**：
 *  前者走 session/elicitation（form），后两者走 session/request_permission —— 见
 *  questionAsk / permissionAskOf。 */
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
      title: questions.length ? "模型提问" : String(d.question || d.title || "模型提问"),
      detail: "",
      raw: d,
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
    raw: d,
  };
}

/** 客户端声明的能力里有没有 form 模式的 elicitation（Paseo ≥0.11 会带 `elicitation:{form:{}}`）。 */
function elicitationFormSupported(caps) {
  if (!caps || typeof caps !== "object") return false;
  const e = caps.elicitation;
  if (!e || typeof e !== "object") return false;
  return !!(e.form && typeof e.form === "object");
}

/** 字段名（elicitation 的 requestedSchema.properties 的键）：只允许 A-Za-z0-9_-（AC0 稳定）。 */
function fieldNameOf(id, idx) {
  const s = String(id || "").replace(/[^A-Za-z0-9_-]/g, "");
  return s || "q" + (idx + 1);
}

/** MTNode 的题面 → elicitation 的字段描述。
 *  `question` 的第一行是标题行，空行之后是 Markdown 总结（与询问卡同一口径，见
 *  renderer/app-db.js 的卡片渲染）：标题行进 field.title，总结整段进 field.description
 *  （description 在表单里是多行文本，Markdown 源码照样可读，不会被截断）。 */
function questionForm(ask) {
  const fields = ask.questions.map((q, idx) => {
    const name = fieldNameOf(q.id, idx);
    const text = String(q.question || "");
    const nl = text.indexOf("\n\n");
    const head = (nl >= 0 ? text.slice(0, nl) : text).trim();
    const tail = nl >= 0 ? text.slice(nl + 2).trim() : "";
    const desc = [q.detail ? String(q.detail) : "", tail].filter(Boolean).join("\n\n");
    const title = head || q.header || "第 " + (idx + 1) + " 问";
    const field = { name, id: q.id, title, asked: text, options: q.options || [], multiSelect: !!q.multiSelect, required: true };
    if (!q.options || !q.options.length) {
      field.schema = { type: "string", title, ...(desc ? { description: desc } : {}) };
    } else if (q.multiSelect) {
      /* 多选 = array + items.enum（ACP 的 MultiSelectPropertySchema） */
      field.schema = {
        type: "array",
        title,
        ...(desc ? { description: desc } : {}),
        items: { type: "string", enum: q.options.map((o) => oneLine(o.label, 200)) },
      };
    } else {
      /* 单选 = string + oneOf:[{const,title}]（官方 EnumOption；选项的第二行说明走 title） */
      field.schema = {
        type: "string",
        title,
        ...(desc ? { description: desc } : {}),
        oneOf: q.options.map((o) => ({
          const: oneLine(o.label, 200),
          title: o.description ? oneLine(o.label, 80) + " —— " + oneLine(o.description, 160) : oneLine(o.label, 200),
        })),
      };
    }
    return field;
  });
  const summary = fields.map((f) => "· " + f.title).join("\n");
  return {
    fields,
    requestedSchema: {
      type: "object",
      title: fields.length > 1 ? "MTNode 询问（" + fields.length + " 题）" : "MTNode 询问",
      description: fields.length > 1 ? summary : String(ask.questions[0] && ask.questions[0].question) || "",
      properties: Object.fromEntries(fields.map((f) => [f.name, f.schema])),
      required: fields.map((f) => f.name),
    },
  };
}

/** 表单回执（{ [字段名]: 值 }）→ MTNode 的 answers[]：{ id, selected[] }。
 *  单选取字符串、多选取数组（值就是选项 label）；没作答的字段**不补空键**
 *  （补了会让模型以为用户答了「空」）。
 *  注意 id 必须回**原题 id**（renderer/app-db.js 的 ixAnswerPairsOf 按它把答案对回题面），
 *  不是 elicitation 的字段名。 */
function answersFromContent(fields, content) {
  const out = [];
  for (const f of fields) {
    const raw = content ? content[f.name] : undefined;
    const vals = (Array.isArray(raw) ? raw : raw == null ? [] : [raw])
      .map((v) => String(v == null ? "" : v).trim())
      .filter(Boolean);
    const a = { id: String(f.id || f.name) };
    if (vals.length) a.selected = vals;
    out.push(a);
  }
  return out;
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

/* ── 提问通道自检（--probe-question）─────────────────────────────────────── */

/**
 * 跑一次「提问通道」端到端自检，返回退出码（0 全通 / 1 某一拍断了）。
 *
 * 四拍逐个报：
 *   ① 桥进程起得来、initialize 通（含能力协商）；
 *   ② 桥把「模型提问」发成 session/elicitation（form）—— 而不是权限请求；
 *   ③ 表单应答（accept + content）被翻成 MTNode 的 answers[] 回执；
 *   ④ 回执真的落到 MTNode（/ctl session/approval）。
 *
 * 不依赖真模型：提问由 MTNode 的 demo 路径（`/ctl session/demo-question`）发出。
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
  const waitNote = async (method, timeoutMs) => {
    const until = Date.now() + (timeoutMs || 20000);
    let seen = 0;
    while (Date.now() < until) {
      for (let i = seen; i < st.notes.length; i++) {
        seen = i + 1;
        if (String(st.notes[i].method) === method) return st.notes[i];
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    return null;
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
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, elicitation: { form: {} } },
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
       （同一根 SSE 管子、同一帧形状；见 session-bridge.js 的 probeQuestion）。 */
    const made = await createMtnodeClient(server).ctl("session/probe-question", {
      sessionId: mtnodeId,
      title: "MTNode 提问通道自检",
    });
    if (!made || !made.ok) {
      say("✗ ③ 发不出自检询问卡：" + oneLine(JSON.stringify(made), 300));
      return 1;
    }
    say("✓ ③ MTNode 已发出询问卡：" + made.id);
    const elicit = await waitNote("session/elicitation", 20000);
    if (!elicit) {
      const perm = st.notes.find((m) => String(m.method) === "session/request_permission");
      say(
        "✗ ④ 桥没发 session/elicitation（form）—— " +
          (perm ? "改发了权限请求（回退通道）：桥没拿到 elicitation/form 能力位" : "两样都没发，问题出在桥的上游"),
      );
      say("   stderr：" + oneLine(st.err, 400));
      return 1;
    }
    const schema = (elicit.params || {}).requestedSchema || {};
    const props = Object.keys(schema.properties || {});
    say("✓ ④ 询问卡（elicitation/form）：" + props.length + " 个字段 · " + oneLine(JSON.stringify(schema.properties || {}), 260));
    if (props.length < 2) {
      say("✗ ④ 表单只有 " + props.length + " 个字段（多题没装进同一份表单）");
      return 1;
    }
    /* ⑤ 应答（模拟手机表单提交）→ 核对桥翻成 MTNode 的 answers[] 并真的送达 */
    const content = {};
    for (const [k, v] of Object.entries(schema.properties || {})) {
      if (v && v.type === "array") content[k] = [((v.items || {}).enum || [""])[0]];
      else if (v && Array.isArray(v.oneOf) && v.oneOf.length) content[k] = v.oneOf[0].const;
      else content[k] = "（自检）文本答案";
    }
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: elicit.id, result: { action: "accept", content } }) + "\n",
    );
    let answer = null;
    for (let i = 0; i < 40; i++) {
      answer = await createMtnodeClient(server).ctl("session/probe-answer", {});
      if (answer && answer.got) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const receipt = st.notes.find(
      (m) => String(m.method) === "session/update" && (m.params || {}).update &&
        (m.params.update || {}).toolCallId === "ask-" + String(made.id),
    );
    say(receipt ? "✓ ⑤ 桥回了回执帧（手机端那张卡会收口）" : "· ⑤ 没看到回执帧（tool_call_update）");
    if (answer && answer.got && Array.isArray(answer.answers) && answer.answers.length) {
      const withSel = answer.answers.filter((a) => a && Array.isArray(a.selected) && a.selected.length);
      say("✓ ⑥ MTNode 收到 answers[]：" + oneLine(JSON.stringify(answer.answers), 400));
      if (withSel.length) {
        say("== 提问通道自检通过：手机端能弹表单卡、答案能回到 MTNode ==");
        return 0;
      }
      say("✗ ⑥ 答案到了但没带上选项值（selected 为空）—— 回执映射有问题");
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
         `--probe-question` 跑（它自己当客户端，逐拍验完）。两句话摆在一起，省得排障时
         把「静态自检没报 elicitation」误读成坏消息。 */
      lines.push(
        "ask channel: question → session/elicitation(form)/回退 session/request_permission（客户端是否声明 elicitation.form 由真机那一枪决定）",
      );
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
     走完：initialize（带 elicitation/form 能力）→ session/new → 让桥发一张询问卡
     （经 MTNode 的真实提问路径：/ctl session/demo-question）→ 表单应答 → 核对回执真的
     落到 MTNode（/ctl session/approval，带 answers[]）。
     为什么要有它：手机上「询问框没弹出 / 答了回不到 MTNode」时，光看日志分不清断在
     「桥没发」「客户端没声明能力」「客户端不渲染」「回执送不回去」哪一拍 ——
     这条自检把四拍逐个报出来（控制台一键跑，见 paseo/ui）。 */
  if (argv.includes("--probe-question")) {
    return runQuestionProbe(server);
  }

  /* stdio ACP 主循环 */
  let buf = "";
  /** 本桥发出去的 session/request_permission：id → { resolve, sessionId, ask }。
   *  客户端（Paseo）的应答从 stdin 回来，按 id 认领 —— 认不到就是别的请求（这里没有）。 */
  const askWaiters = new Map();
  /** 本桥发出去的 session/elicitation（form 模式的询问卡）：id → { resolve, sessionId, fields }。
   *  与权限请求同一套「按 id 认领应答」的口径，只是应答形状不同
   *  （{ result: { action, content } } 而不是 { result: { outcome } }）。 */
  const elicitWaiters = new Map();
  let askCounter = 0;
  /** 客户端在 initialize 里声明的能力（置 true 才能用 elicitation 发询问卡） */
  let clientSupportsElicitation = false;
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
      /* ① 先看是不是「我们发出去的请求」的应答（session/request_permission / session/elicitation） */
      if (msg && msg.id !== undefined && msg.method === undefined) {
        const ew = elicitWaiters.get(msg.id);
        if (ew) {
          elicitWaiters.delete(msg.id);
          const res = msg.result || {};
          ew.resolve({
            action: String(res.action || (msg.error ? "error" : "")),
            content: res.content && typeof res.content === "object" ? res.content : null,
            error: msg.error ? String(msg.error.message || "") : "",
          });
          continue;
        }
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
      /* 客户端声明的能力要**记下来**：form 模式的 elicitation 是模型询问卡的通道，
         不声明就只能回退权限请求（手机上那张卡就装不下题面与选项）。
         ★ 只在这一次 initialize **真带了** clientCapabilities 时才更新：客户端可能先探一次
         （不带能力位 / 老客户端），后一次才带全 —— 不能被后到的空能力位把已有能力抹掉。
         （真机同形：Paseo 刷新 provider 清单时也会再发一次会话探针。） */
      if (p.clientCapabilities && typeof p.clientCapabilities === "object") {
        clientSupportsElicitation = elicitationFormSupported(p.clientCapabilities);
      }
      dbg(
        "客户端能力：elicitation.form=" + (clientSupportsElicitation ? "有" : "无") +
          " · client=" + oneLine(JSON.stringify(p.clientCapabilities || {}), 300),
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

      const finish = (reason) => {
        if (turn.done) return;
        turn.done = true;
        clearTimeout(turn.timer);
        try {
          turn.stream && turn.stream.close();
        } catch {}
        dropTurn(sid, turn.mtnodeId);
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
            /* 一轮收尾：等 MTNode 的 done 到了才回 stopReason（不外泄内部帧） */
            if (!started) pendingEv.push(ev);
            else finish(turn.cancelled ? "cancelled" : "end_turn");
            return;
          }
          const ask = askOfEvent(mid, ev);
          if (ask) {
            void askPermission(sid, mid, ask, turn);
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
        clearTimeout(turn.timer);
        try {
          turn.stream && turn.stream.close();
        } catch {}
        dropTurn(sid, turn.mtnodeId);
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
            clearTimeout(t.timer);
            try {
              t.stream && t.stream.close();
            } catch {}
            dropTurn(sid, t.mtnodeId);
            reply(t.id, { stopReason: "cancelled" });
          }
        }, 1500);
      }
      return isNotification ? undefined : reply(id, {});
    }

    if (isNotification) return undefined;
    return replyErr(id, -32601, "本桥不支持这个方法：" + method);
  }

  /** 把 MTNode 那张「停下来等人」的卡交给 Paseo（客户端弹给手机），按用户的选择回执。
   *
   *  **两条通道**：
   *   · `question`（模型提问 / 收尾确认卡）→ `session/elicitation`（form）：题面、选项、
   *     多选、自由文本都能装，回执是 `{ action, content }`，再翻成 MTNode 的 answers[]；
   *   · `approval` / `canvas`（审批 / 画布确认）→ `session/request_permission`：本来就是
   *     「允许 / 拒绝」两三个按钮的事，走权限请求最贴切。
   *  客户端**没声明** form elicitation 时，提问回退权限请求（题面塞进 toolCall.title /
   *  content，选项只留 允许一次 / 拒绝）—— 那张卡答不出模型要的答案，所以同时推一条说明帧
   *  告诉用户「到电脑上答」。绝不自己也弹一张假的、也绝不代答。
   *
   *  Paseo 没答 / 断了 → 什么都不回执：MTNode 那边**永久等待**（共识：断线不自动拒绝）。
   *
   *  两个 id 别混：**通知给客户端的 sessionId 必须是 ACP 那个**（客户端按它归位这条会话），
   *  而打回 MTNode 的回执必须带**真 as… 会话 id**（否则回执落不到那条会话上）。 */
  async function askPermission(sessionId, mtnodeId, ask, turn) {
    if (ask.kind === "question" && clientSupportsElicitation) {
      return askQuestionViaElicitation(sessionId, mtnodeId, ask);
    }
    return askPermissionViaPermission(sessionId, mtnodeId, ask);
  }

  /** 询问卡（form elicitation）：一份表单装下全部问题。 */
  async function askQuestionViaElicitation(sessionId, mtnodeId, ask) {
    const client = createMtnodeClient(server);
    const form = questionForm(ask);
    const reqId = 900000 + (askCounter += 1);
    const p = new Promise((resolve) => {
      elicitWaiters.set(reqId, { resolve, sessionId, fields: form.fields });
    });
    dbg(
      "问卡（elicitation/form）：题数=" + form.fields.length +
        " 字段=" + form.fields.map((f) => f.name + ":" + (f.options.length ? (f.multiSelect ? "多选" : "单选") + f.options.length : "文本")).join(","),
    );
    out({
      jsonrpc: "2.0",
      id: reqId,
      method: "session/elicitation",
      params: {
        sessionId,
        message: ask.title + (form.fields.length > 1 ? "（" + form.fields.length + " 题）" : "") +
          "\n" + form.fields.map((f) => "· " + oneLine(f.title, 120)).join("\n"),
        mode: "form",
        requestedSchema: form.requestedSchema,
      },
    });
    let ans = null;
    try {
      ans = await Promise.race([
        p,
        new Promise((r) => setTimeout(() => r(null), ASK_TIMEOUT_MS)),
      ]);
    } finally {
      elicitWaiters.delete(reqId);
    }
    if (!ans) {
      /* 客户端把这一枪丢了（断开 / 一直没答）：MTNode 那边继续等，什么都不回执 */
      dbg("问卡没有回执（客户端没答）");
      return;
    }
    const action = String(ans.action || "");
    if (action !== "accept") {
      /* decline / cancel / error：用户明确没作答。**不代答、也不拒绝** ——
         卡交给发起轮自己收（宿主「中断任务」才是那条失败路径）。 */
      dbg("问卡未作答：action=" + (action || "(空)") + (ans.error ? " err=" + ans.error : ""));
      return;
    }
    const answers = answersFromContent(form.fields, ans.content || {});
    dbg("问卡回执：answers=" + oneLine(JSON.stringify(answers), 400));
    await receiptToMtnode(sessionId, mtnodeId, ask, "answered", answers);
  }

  /** 提问的**回退**通道（客户端不支持 elicitation）：权限请求 + 一条说明帧。
   *  说明写的是实话：那张权限卡只能回「允许一次 / 拒绝」，答不出模型要的答案。 */
  async function askPermissionViaPermission(sessionId, mtnodeId, ask) {
    notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text:
            "\n\n⚠️ 这台手机端不支持表单问答（ACP elicitation/form）：模型提的问题在这里只能回「允许一次 / 拒绝」，" +
            "答不出它要的答案。请在电脑上的 MTNode 询问卡里回答，模型会继续等。\n",
        },
      },
    });
    return askPermissionViaPermissionRaw(sessionId, mtnodeId, ask);
  }

  /** 审批 / 画布确认（以及提问的回退）：session/request_permission，按选择的 optionId 回执。 */
  async function askPermissionViaPermissionRaw(sessionId, mtnodeId, ask) {
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
    let ans = null;
    try {
      ans = await Promise.race([
        p,
        new Promise((r) => setTimeout(() => r(null), ASK_TIMEOUT_MS)),
      ]);
    } finally {
      askWaiters.delete(reqId);
    }
    if (!ans) return; /* 客户端把这一枪丢了（断开）：MTNode 那边继续等 */
    const outcome = String(ans.optionId || "");
    const mapped = outcome === "reject" ? "rejected" : outcome === "allow-session" ? "allowed-session" : "allowed-once";
    await receiptToMtnode(sessionId, mtnodeId, ask, mapped, null);
  }

  /** 把用户的选择送回 MTNode（两条通道共用）：
   *  先给手机一个明确的回执帧（tool_call_update），再调 /ctl 的 session/approval。 */
  async function receiptToMtnode(sessionId, mtnodeId, ask, outcome, answers) {
    const client = createMtnodeClient(server);
    notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "ask-" + ask.id,
        status: outcome === "rejected" ? "failed" : "completed",
      },
    });
    try {
      await client.ctl("session/approval", {
        id: ask.id,
        sessionId: mtnodeId,
        kind: ask.kind,
        outcome,
        ...(ask.kind === "question" && Array.isArray(answers) ? { answers } : {}),
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
