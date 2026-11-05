/**
 * 开发调试的一次性 CLI（零依赖 · 给人用）
 *
 * 干什么：从某个数据目录的 `mcp-server.json` 里读端口与令牌，直连本机 MTNode 的 MCP 服务端
 *   （`POST /ctl`，见 mcp-server.js），把 `mtnode_dev` 的一次动作原样打过去、把回执打回来。
 *   于是**人能复现 agent 的每一条调试动作**：起一只隔离实例、截图、点、读控制台、
 *   改完代码 reload / restart、再拍一张。工具本身的实现在根目录 `dev-agent.js`，
 *   参数表真源在 `dsh/gateway/dev-plugin.mjs`；本脚本不含任何产品逻辑，删掉不影响应用。
 *
 * 与 tools/mtnode-gui.mjs 的分工：那个驱动**用户正在用的**那只窗口（mtnode_gui），
 *   这个驱动**自己 spawn 的那只调试实例**（mtnode_dev）。两者并存，别互相替代。
 *
 * 前置：被驱动的这台 MTNode 必须是**开发态**（npm start / electron .）且「扩展能力管理 →
 *   开发调试」总开关已开、MCP 服务端在监听（默认开）。打包态会被 dev-agent 直接拒绝。
 *
 * 用法：
 *   node scripts/mtnode-dev.mjs discover [--data <数据目录>]
 *   node scripts/mtnode-dev.mjs <action> [--data <dir>] [--args '<json>']
 *
 * 例：
 *   node scripts/mtnode-dev.mjs status
 *   node scripts/mtnode-dev.mjs launch --args '{"target":"main"}'
 *   node scripts/mtnode-dev.mjs snapshot
 *   node scripts/mtnode-dev.mjs screenshot --args '{"path":"E:\\tmp\\dev.png"}'
 *   node scripts/mtnode-dev.mjs click --args '{"target":{"text":"设置"}}'
 *   node scripts/mtnode-dev.mjs reload --args '{"changedFiles":["renderer/app.js"]}'
 *   node scripts/mtnode-dev.mjs restart
 *   node scripts/mtnode-dev.mjs stop
 *
 * 退出码：0 = 回执 ok；2 = 回执 ok:false（错误文本照打）；1 = 用法 / 环境错误。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

/** 找一个数据目录里的 mcp-server.json：给了 --data 就用它，否则按与 mtnode-gui.mjs 相同的顺序猜。 */
function findStatePath(dataDir) {
  const cands = [];
  if (dataDir) cands.push(dataDir, path.join(dataDir, "pipeline-console"));
  const env = process.env.MTNODE_DATA_DIR;
  if (env) cands.push(env, path.join(env, "pipeline-console"));
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  cands.push(path.join(appData, "pipeline-console"), path.join(appData, "pipeline-console", "pipeline-console"));
  for (const d of cands) {
    const p = path.join(d, "mcp-server.json");
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* 权限 / 不存在：继续找下一个 */
    }
  }
  throw new Error(
    "没找到 mcp-server.json。用 --data 指定 MTNode 的数据目录（`MTNODE_DATA_DIR=X` 启动时就是 X\\pipeline-console）。找过：" +
      cands.join(" | "),
  );
}

function readState(p) {
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  if (!j || !j.token) throw new Error("mcp-server.json 里没有 token：" + p);
  if (j.enabled === false) throw new Error("MCP 服务端当前是关闭状态（enabled:false）：" + p);
  if (!j.port) throw new Error("MCP 服务端没在监听（port:0）：MTNode 没开着？" + p);
  return j;
}

async function ctl(state, method, params) {
  const url = "http://127.0.0.1:" + state.port + "/ctl";
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + state.token },
    body: JSON.stringify({ method, params }),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("服务端回了非 JSON（HTTP " + res.status + "）：" + text.slice(0, 300));
  }
  return body;
}

/** MCP tools/call 的结果：{content:[{type:'text',text}], structuredContent, isError} → 纯对象。 */
function unwrap(rpc) {
  const r = rpc && rpc.result;
  const sc = r && r.structuredContent;
  if (sc && typeof sc === "object") return { ok: !(r && r.isError), value: sc };
  if (r && Array.isArray(r.tools)) return { ok: true, value: r };
  const txt = r && Array.isArray(r.content) ? (r.content.find((c) => c && c.type === "text") || {}).text : "";
  let parsed = null;
  try {
    parsed = txt ? JSON.parse(txt) : null;
  } catch {
    parsed = null;
  }
  const ok = !(r && r.isError) && !(parsed && parsed.ok === false);
  return { ok, value: parsed === null ? txt : parsed };
}

function readArgsJson(args) {
  if (args.json && args.json !== true) return JSON.parse(fs.readFileSync(String(args.json), "utf8"));
  if (args.args && args.args !== true) return JSON.parse(String(args.args));
  /* 环境变量兜底：从 PowerShell / cmd 传 JSON 时引号常被吞，这时用 MTNODE_DEV_ARGS 最省事
     （与 tools/mtnode-gui.mjs 的 MTNODE_GUI_ARGS 同一个坑）。 */
  const env = process.env.MTNODE_DEV_ARGS;
  if (env && String(env).trim()) return JSON.parse(String(env));
  return {};
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || "status");
  const statePath = findStatePath(args.data === true ? "" : args.data);
  const state = readState(statePath);
  const meta = { statePath, port: state.port };

  if (cmd === "discover") {
    const list = await ctl(state, "tools/list", {});
    const tools = (list.result && list.result.tools) || [];
    const names = tools.map((t) => t.name);
    console.log(
      JSON.stringify(
        { ok: true, ...meta, tools: names, count: names.length, hasDev: names.includes("mtnode_dev") },
        null,
        2,
      ),
    );
    return;
  }

  const toolArgs = readArgsJson(args);
  toolArgs.action = cmd;
  if (args.which && args.which !== true) toolArgs.which = String(args.which);

  const rpc = await ctl(state, "tools/call", { name: "mtnode_dev", arguments: toolArgs });
  const out = unwrap(rpc);
  console.log(JSON.stringify({ ok: out.ok, tool: "mtnode_dev", args: toolArgs, ...meta, result: out.value }, null, 2));
  if (!out.ok) process.exitCode = 2;
}

main().catch((e) => {
  console.error("[mtnode-dev] " + ((e && e.message) || e));
  process.exitCode = 1;
});
