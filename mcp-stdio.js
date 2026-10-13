#!/usr/bin/env node
/**
 * MTNode MCP · stdio 桥（独立 Node 脚本，不属于应用主进程）
 *
 * 干什么：本地 MCP 客户端（Claude Code / Cursor / 自研 Agent）用 stdio 拉起本脚本，
 *   脚本把每条 JSON-RPC 原样 POST 给正在运行的 MTNode 主进程 MCP 服务端，再把回执写回
 *   stdout。**执行只有一条路径**（主进程 → 渲染层），这里不做任何工具实现、不读画布文件。
 *
 * 怎么找服务端：读数据目录里的 mcp-server.json（port / token / enabled）。
 *   目录候选顺序（按序**逐个探活**：文件在、端口 + token 齐备也要真连得上才采用，
 *   连不上就继续下一个候选 —— 状态文件可能是旧进程留下的死端口，采纳它 = 桥报
 *   「fetch failed」而服务端其实在跑；全部候选都不通时报错会逐条列出每个候选的
 *   路径、端口、死活与失败原因）：
 *     1) $MTNODE_DATA_DIR/pipeline-console、$MTNODE_DATA_DIR（两种写法都认）
 *     2) <userData>/pipeline-console —— Windows = %APPDATA%\pipeline-console\pipeline-console，
 *        macOS = ~/Library/Application Support/pipeline-console/pipeline-console，
 *        Linux = ~/.config/pipeline-console/pipeline-console。
 *        **应用默认的数据目录就是这一层**：主进程数据根 = appData/pipeline-console（userData），
 *        数据目录 = 它下面的 pipeline-console 子目录，服务端状态就写在数据目录里。
 *     3) 设置里改过「配置数据目录」时，<userData>/data-root.json 的 path 指向的数据目录
 *     4) 平台默认应用数据根（%APPDATA%\pipeline-console 等，旧版直接把状态写在那一层的兼容兜底）
 *   可用 MTNODE_MCP_URL / MTNODE_MCP_TOKEN 显式覆盖（多用户 / 便携版场景）。
 *
 * 运行时：普通 Node（≥ 18，只用 fetch 与内置模块）即可；MTNode 自带的那个 Electron 运行时
 *   （打包态 <安装目录>\MTNodeAIO.exe、开发态 node_modules/electron/dist/electron.exe）
 *   也**能**直接跑本脚本 —— 但要看清两条口径不同（真机实测，2026-10-13）：
 *     开发态 electron.exe + 本脚本：直接按普通 Node 跑本脚本（实测 223ms 出结果），不必另装 Node；
 *     打包态 MTNodeAIO.exe + 本脚本：**必须**带 ELECTRON_RUN_AS_NODE=1（客户端配置片段里的 env），
 *       不带就会被当主程序启动 —— 实测 10 秒不退出、多出 4 个实例、stdout 只有 [user-plugins]
 *       体检文本、零 jsonrpc，第三方客户端只会看到「连不上」。所以第三方客户端不必另装 Node；
 *       想用系统 Node 就把 command 换成 node（Node ≥ 18）并去掉那条 env。
 *   面板「复制配置片段」与 GET /meta 的 stdioCommand 就是按这个口径给的（同一真源）。
 *
 * stdout 只写协议帧；所有诊断走 stderr（客户端会把它当 server log 显示）。
 *
 * 用法：
 *   node mcp-stdio.js                 # stdio 模式（客户端按这个配）
 *   node mcp-stdio.js --print-config  # 打印客户端配置片段与当前地址/token
 *   node mcp-stdio.js --check         # 只验证「能否连上服务端」，打印结果后退出
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const CLIENT = String(process.env.MTNODE_MCP_CLIENT || "stdio").slice(0, 64);
const REQUEST_TIMEOUT_MS = 20 * 60 * 1000;
/** MCP 会话 id（initialize 时由服务端下发）：一次桥进程内沿用同一个，保证同一客户端会话一致。 */
let SESSION_ID = "";

function log(...a) {
  try {
    process.stderr.write("[mtnode-mcp] " + a.join(" ") + "\n");
  } catch {
    /* stderr 关了也不能影响协议流 */
  }
}

/**
 * 数据目录候选（按优先级）：返回 [{ dir, why }]，why 供报错时讲清「哪个目录、什么来路」。
 *
 * 为什么有这么多层：主进程 main.js 里
 *   APP_DATA_ROOT = appData/pipeline-console（Windows = %APPDATA%\pipeline-console）
 *   userData      = APP_DATA_ROOT（没设 MTNODE_DATA_DIR 时）
 *   DATA()        = userData/pipeline-console  ← 服务端状态就写在这一层
 * 也就是说数据目录比「应用数据根」**多一层**；早先这里只找应用数据根，于是打包态
 * 默认发现必然落空、桥报「没开 MTNode」而服务端其实在跑（本文件的历史 bug）。
 */
function appDataRoot() {
  const home = os.homedir();
  if (process.platform === "win32")
    return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "pipeline-console");
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "pipeline-console");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "pipeline-console");
}

/** 设置里改过「配置数据目录」时，主进程把新数据目录写在 <应用数据根>/data-root.json 的 path 里。 */
function customDataDir() {
  const fp = path.join(appDataRoot(), "data-root.json");
  try {
    const j = JSON.parse(fs.readFileSync(fp, "utf8"));
    const p = j && typeof j.path === "string" ? String(j.path).trim() : "";
    if (p && path.isAbsolute(p)) return { dir: path.resolve(p), why: fp };
  } catch {
    /* 没改过 / 读不了：正常，不是错误 */
  }
  return null;
}

function dataDirCandidates() {
  const out = [];
  const push = (p, why) => {
    if (!p) return;
    const v = path.resolve(String(p));
    if (out.some((c) => c.dir === v)) return;
    out.push({ dir: v, why });
  };
  /* $MTNODE_DATA_DIR 的语义与主进程 main.js **完全一致**：
       主进程把它当 userData 目录（app.setPath('userData', ...)），真正落数据的
       数据目录是它下面的 pipeline-console/ 子目录。
     两种写法都试（子目录优先）：便携版 / 自定义数据根直接把数据目录本身写进
       MTNODE_DATA_DIR 时，第一个候选落空、第二个候选命中；标准用法反之。
     两个都不试 = 用户明明设了环境变量，桥却报「没开 MTNode」。 */
  const env = String(process.env.MTNODE_DATA_DIR || "").trim();
  if (env) {
    push(path.join(env, "pipeline-console"), "$MTNODE_DATA_DIR 之下的数据目录");
    push(env, "$MTNODE_DATA_DIR 本身");
  }
  /* 默认数据目录 = 应用数据根 / pipeline-console（服务端状态就在这一层）。 */
  const root = appDataRoot();
  push(path.join(root, "pipeline-console"), "默认数据目录（应用数据根下的 pipeline-console）");
  const custom = customDataDir();
  if (custom) push(custom.dir, "data-root.json 指定的数据目录（" + custom.why + "）");
  /* 兼容兜底：旧版直接把状态写在应用数据根那一层。 */
  push(root, "应用数据根（旧版位置）");
  return out;
}

/** 探活超时：必须短（--check 与每个请求都会走这条路径）。死端口在 Windows 上
    通常立刻 ECONNREFUSED，但只要有一层防火墙 DROP，就会一直挂到超时 —— 所以
    不能省这个上限，也不能给太长。 */
const PROBE_TIMEOUT_MS = 1200;

/**
 * 探活一个候选地址：真发一帧 JSON-RPC 到 /mcp，看它是不是活的 MTNode 服务端。
 *
 * 服务端对所有 /mcp 回执都带 `authorization: Bearer`（含 401），所以「收到了 HTTP
 * 响应」就等于「端口上蹲着 MTNode MCP 服务端」；这里只判死活、不校验 token ——
 * token 错了会在真正转发时由服务端如实回 401，那是另一回事，不能拿来否定候选。
 * 返回 { ok, code, reason }：ok=false 时 reason 是能给人看的一句原因。
 */
async function probeCandidate(url, token) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
  if (timer && typeof timer.unref === "function") timer.unref();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + token,
        "x-mtnode-client": CLIENT,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: "mtnode-bridge-probe", method: "ping", params: {} }),
      signal: ctl.signal,
    });
    return { ok: true, code: res.status, headers: res.headers };
  } catch (e) {
    const raw = (e && e.message) || String(e);
    const aborted = (e && e.name) === "AbortError";
    return {
      ok: false,
      code: 0,
      reason: aborted ? "探活超时（" + PROBE_TIMEOUT_MS + "ms 内没有响应）" : raw,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readServerInfo() {
  const url = String(process.env.MTNODE_MCP_URL || "").trim();
  const token = String(process.env.MTNODE_MCP_TOKEN || "").trim();
  if (url && token) return { url, token, from: "env" };
  const tried = [];
  const notes = [];
  for (const cand of dataDirCandidates()) {
    const fp = path.join(cand.dir, "mcp-server.json");
    tried.push(fp + "（" + cand.why + "）");
    let j;
    try {
      j = JSON.parse(fs.readFileSync(fp, "utf8"));
    } catch {
      /* 这个候选目录里没有状态文件：换下一个候选（读不了不是错误，不记进死因里） */
      continue;
    }
    const port = Number(j && j.port) || 0;
    const tok = String((j && j.token) || "");
    /* 文件在、但端口是 0 / 配置里 enabled=false（服务端关着 / 刚停）：这不是
       「没开 MTNode」，要如实说清是哪一种，否则用户按「打开 MTNode」去查永远
       查不出来。保持既有语义：0 端口 = 服务端已停，不去探活。 */
    if (j && j.enabled === false) {
      notes.push(fp + "（配置里 enabled=false：服务端被关掉了）");
      continue;
    }
    if (!tok || !port) {
      if (tok && !port) notes.push(fp + "（没在监听：服务端已停 / 尚未启动完成）");
      continue;
    }
    const candUrl = "http://127.0.0.1:" + port + "/mcp";
    const probe = await probeCandidate(candUrl, tok);
    if (!probe.ok) {
      /* 关键修复：状态文件不保证还有效（旧进程留下的死端口 / 多实例互相覆盖）。
         死端口不能采纳 —— 采纳它只会得到一句没头没脑的 fetch failed。 */
      tried.push(candUrl + " → 端口 " + port + " 连不上（" + probe.reason + "）");
      continue;
    }
    return {
      url: candUrl,
      token: tok,
      from: fp,
      enabled: true,
      sessionId: (probe.headers && probe.headers.get("mcp-session-id")) || "",
    };
  }
  const e = new Error(
    (notes.length ? "找到 MTNode 的数据目录，但 MCP 服务端没在跑：" + notes.join("；") + "。" : "") +
      "连不上 MTNode MCP 服务端（没开 MTNode，或还没启用「MCP 服务端」）—— 逐个候选探活的结果：" +
      tried.join("；") +
      "。核对办法：打开 MTNode → 设置里确认「MCP 服务端」已启用，再看上面哪个候选的端口与实际监听端口不符" +
      "（多开 MTNode 会用同一个数据目录，状态文件里的端口可能被另一个实例覆盖）；" +
      "也可以用 MTNODE_MCP_URL + MTNODE_MCP_TOKEN 显式指定地址与令牌绕开自动发现。",
  );
  e.code = "NO_SERVER";
  throw e;
}

async function postRpc(info, body, sessionId) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  if (timer && typeof timer.unref === "function") timer.unref();
  try {
    const headers = {
      "content-type": "application/json",
      authorization: "Bearer " + info.token,
      "x-mtnode-client": CLIENT,
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const res = await fetch(info.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) SESSION_ID = sid;
    if (res.status === 202) return null;
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("服务端回的不是 JSON：" + text.slice(0, 200));
    }
  } finally {
    clearTimeout(timer);
  }
}

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id === undefined ? null : id, error: { code, message } };
}

async function main() {
  /* 收尾统一走这里：process.exit() 若打断仍在关闭的 libuv 句柄，Node 会直接 abort
     （Windows 上表现为「Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)」+
     退出码 0xC0000409），把 --check 的正常结果变成一次崩溃。先让事件循环空转一拍，
     句柄收干净再退；真卡住也有 300ms 兜底。 */
  const exitSoon = (code) => {
    const hard = setTimeout(() => process.exit(code), 300);
    if (hard && typeof hard.unref === "function") hard.unref();
    setTimeout(() => process.exit(code), 30);
  };
  const argv = process.argv.slice(2);
  if (argv.includes("--print-config")) {
    let info = null;
    let err = "";
    try {
      info = await readServerInfo();
    } catch (e) {
      err = (e && e.message) || String(e);
    }
    const script = path.resolve(__filename);
    const snippet = {
      mcpServers: {
        mtnode: {
          command: process.execPath,
          args: [script],
        },
      },
    };
    process.stdout.write(
      JSON.stringify(
        {
          clientConfig: snippet,
          note: "把 mcpServers 片段合并进客户端的 MCP 配置；脚本自己读数据目录里的端口与 token，无需填地址。",
          running: !!info,
          url: info ? info.url : "",
          token: info ? info.token : "",
          infoFrom: info ? info.from : "",
          error: err,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  let info;
  try {
    info = await readServerInfo();
  } catch (e) {
    if (argv.includes("--check")) {
      process.stdout.write(JSON.stringify({ ok: false, error: (e && e.message) || String(e) }) + "\n");
      exitSoon(1);
      return;
    }
    log("连接失败：" + ((e && e.message) || e));
    /* stdio 模式下没有服务端就退出：客户端会显示本行 stderr 作为原因 */
    exitSoon(1);
    return;
  }
  if (argv.includes("--check")) {
    try {
      const init = await postRpc(info, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mtnode-bridge-check", version: "1" } },
      });
      const tools = await postRpc(info, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, SESSION_ID);
      const n = tools && tools.result && tools.result.tools ? tools.result.tools.length : 0;
      process.stdout.write(
        JSON.stringify(
          {
            ok: !!(init && init.result && init.result.serverInfo) && n > 0,
            url: info.url,
            infoFrom: info.from,
            serverInfo: (init && init.result && init.result.serverInfo) || null,
            tools: n,
            error: init && init.error ? init.error.message : "",
          },
          null,
          2,
        ) + "\n",
      );
      exitSoon(init && init.result && n > 0 ? 0 : 1);
      return;
    } catch (e) {
      process.stdout.write(
        JSON.stringify({ ok: false, url: info.url, error: (e && e.message) || String(e) }, null, 2) + "\n",
      );
      exitSoon(1);
      return;
    }
  }

  log("桥已就绪 → " + info.url + "（来源 " + info.from + "，client=" + CLIENT + "）");

  let buf = "";
  let queue = Promise.resolve();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      queue = queue.then(() => handleLine(line)).catch((e) => log("处理失败：" + ((e && e.message) || e)));
    }
  });
  process.stdin.on("end", () => {
    queue.finally(() => process.exit(0));
  });
}

async function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; /* 不是 JSON 的行直接丢（与 MCP 客户端的容错口径一致） */
  }
  const id = msg && msg.id;
  const isNotification = id === undefined || id === null;
  let info;
  try {
    info = await readServerInfo();
  } catch (e) {
    if (!isNotification) write(rpcError(id, -32000, (e && e.message) || String(e)));
    return;
  }
  try {
    const out = await postRpc(info, msg, SESSION_ID);
    if (out && !isNotification) write(out);
  } catch (e) {
    if (!isNotification) {
      const raw = (e && e.message) || String(e);
      /* 最常见的两种失败给一句能照做的解释：服务端没在跑（fetch failed / ECONNREFUSED），
         或地址变了（MTNode 重启后端口会变，数据目录里的 mcp-server.json 会跟着更新）。 */
      const hint = /fetch failed|ECONNREFUSED|socket hang up/i.test(raw)
        ? "连不上 MTNode MCP 服务端（" + info.url + "）：MTNode 可能已退出，或刚重启换了端口。请打开 MTNode 后重试。"
        : raw;
      write(rpcError(id, -32001, "转发到 MTNode 失败：" + hint));
    }
  }
}

main().catch((e) => {
  log("致命错误：" + ((e && e.stack) || e));
  process.exit(1);
});
