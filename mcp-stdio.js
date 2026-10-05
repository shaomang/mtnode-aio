#!/usr/bin/env node
/**
 * MTNode MCP · stdio 桥（独立 Node 脚本，不属于应用主进程）
 *
 * 干什么：本地 MCP 客户端（Claude Code / Cursor / 自研 Agent）用 stdio 拉起本脚本，
 *   脚本把每条 JSON-RPC 原样 POST 给正在运行的 MTNode 主进程 MCP 服务端，再把回执写回
 *   stdout。**执行只有一条路径**（主进程 → 渲染层），这里不做任何工具实现、不读画布文件。
 *
 * 怎么找服务端：读用户数据目录里的 mcp-server.json（port / token / enabled），
 *   目录顺序 = $MTNODE_DATA_DIR → %APPDATA%\pipeline-console（Windows）→
 *   ~/Library/Application Support/pipeline-console（macOS）→ ~/.config/pipeline-console（Linux）。
 *   可用 MTNODE_MCP_URL / MTNODE_MCP_TOKEN 显式覆盖（多用户 / 便携版场景）。
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

function dataDirCandidates() {
  const out = [];
  const push = (p) => {
    if (!p) return;
    const v = String(p);
    if (out.indexOf(v) < 0) out.push(v);
  };
  /* $MTNODE_DATA_DIR 的语义与主进程 main.js **完全一致**：
       主进程把它当 userData 目录（app.setPath('userData', ...)），真正落数据的
       数据目录是它下面的 pipeline-console/ 子目录。
     两种写法都试（子目录优先）：便携版 / 自定义数据根直接把数据目录本身写进
       MTNODE_DATA_DIR 时，第一个候选落空、第二个候选命中；标准用法反之。
     两个都不试 = 用户明明设了环境变量，桥却报「没开 MTNode」。 */
  const env = String(process.env.MTNODE_DATA_DIR || "").trim();
  if (env) {
    push(path.join(env, "pipeline-console"));
    push(env);
  }
  const home = os.homedir();
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    push(path.join(appData, "pipeline-console"));
  } else if (process.platform === "darwin") {
    push(path.join(home, "Library", "Application Support", "pipeline-console"));
  } else {
    push(path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "pipeline-console"));
  }
  return out;
}

function readServerInfo() {
  const url = String(process.env.MTNODE_MCP_URL || "").trim();
  const token = String(process.env.MTNODE_MCP_TOKEN || "").trim();
  if (url && token) return { url, token, from: "env" };
  const tried = [];
  let sawDisabled = "";
  for (const dir of dataDirCandidates()) {
    const fp = path.join(dir, "mcp-server.json");
    tried.push(fp);
    try {
      const j = JSON.parse(fs.readFileSync(fp, "utf8"));
      const port = Number(j && j.port) || 0;
      const tok = String((j && j.token) || "");
      if (port && tok) {
        return {
          url: "http://127.0.0.1:" + port + "/mcp",
          token: tok,
          from: fp,
          enabled: j.enabled !== false,
        };
      }
      /* 文件在、但端口没在监听（服务端关着 / 刚停）：这不是「没开 MTNode」，
         要如实说清是哪一种，否则用户按「打开 MTNode」去查永远查不出来。 */
      if (j && j.enabled === false) sawDisabled = fp + "（配置里 enabled=false：服务端被关掉了）";
      else if (tok && !port) sawDisabled = fp + "（没在监听：服务端已停 / 尚未启动完成）";
    } catch {
      /* 换下一个候选目录 */
    }
  }
  const e = new Error(
    (sawDisabled ? "找到 MTNode 的数据目录，但 MCP 服务端没在跑：" + sawDisabled + "。" : "") +
      "找不到 MTNode MCP 服务端的运行信息（没开 MTNode，或还没启用「MCP 服务端」）。已找过：" +
      tried.join("、"),
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
      info = readServerInfo();
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
    info = readServerInfo();
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
    info = readServerInfo();
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
