/**
 * 一次性 MCP 驱动脚本（零依赖 · 供**非 MCP 客户端**的进程使用）
 *
 * 干什么：从某个数据目录的 `mcp-server.json` 里读端口与令牌，直连本机 MTNode 的 MCP 服务端
 *   （`POST /ctl`，见 mcp-server.js），把一次工具的 `arguments` 原样打过去、把回执打回来。
 *   主要用途是**驱动 MTNode 的窗口**（`mtnode_gui`）与读它的状态，好让一个跑在 MTNode 之外的
 *   自动化流程（比如本机的一个测试脚本）不必自己成为 MCP 客户端就能点界面、拍截图。
 *
 * 为什么是一把一次性脚本、不进产品代码：它没有任何产品逻辑，只是「发现 + 转发」；
 *   产品侧的 GUI 能力在 `mcp-gui-agent.js` + `mcp-server.js` 里，本脚本删掉不影响应用。
 *
 * 谁在用：开发 MTNode 自身功能时的**真机自验** —— 起一只独立数据目录的开发态实例，
 *   用它读界面结构、真点真输、拍截图。完整纪律（起实例 / 握手 / 判据四步 / 证据落点 /
 *   做不到怎么如实写）见技能 `mtnode-verify-in-app`（`mtnode-agent-skills/mtnode/verify-in-app/SKILL.md`）。
 *
 * 用法：
 *   node tools/mtnode-gui.mjs discover   [--data <数据目录>]
 *   node tools/mtnode-gui.mjs call <tool> [--data <dir>] [--args '<json>'] [--json <文件>]
 *   node tools/mtnode-gui.mjs gui <action> [--data <dir>] [--args '<json>'] [--which install] [--target '<json>']
 *
 * 例：
 *   node tools/mtnode-gui.mjs gui windows --data E:\mtnode-verify-data\pipeline-console
 *   node tools/mtnode-gui.mjs gui outline --which install --data <dir>
 *   node tools/mtnode-gui.mjs gui click --target '{"text":"开始安装"}' --which install --data <dir>
 *   node tools/mtnode-gui.mjs gui screenshot --which install --args '{"path":"E:\\tmp\\shot.png"}' --data <dir>
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

/** 找一个数据目录里的 mcp-server.json：给了 --data 就用它，否则按与本机应用同样的顺序猜。 */
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

/** MCP tools/call 的结果：{content:[{type:'text',text}], structuredContent, isError} → 纯对象。
 *  tools/list 这类非 tools/call 方法的结果是直接对象，原样返回。 */
function unwrap(rpc) {
  const r = rpc && rpc.result;
  const sc = r && r.structuredContent;
  if (sc && typeof sc === "object") return { ok: !(r && r.isError), value: sc };
  if (r && (Array.isArray(r.tools) || Array.isArray(r.resources) || Array.isArray(r.prompts))) {
    return { ok: true, value: r };
  }
  const txt = r && Array.isArray(r.content) ? (r.content.find((c) => c && c.type === "text") || {}).text : "";
  let parsed = null;
  try {
    parsed = txt ? JSON.parse(txt) : null;
  } catch {
    parsed = null;
  }
  return { ok: !(r && r.isError), value: parsed === null ? txt : parsed };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || "discover");
  const statePath = findStatePath(args.data === true ? "" : args.data);
  const state = readState(statePath);
  const meta = { statePath, port: state.port, url: "http://127.0.0.1:" + state.port };

  if (cmd === "discover") {
    const list = await ctl(state, "tools/list", {});
    const tools = (list.result && list.result.tools) || [];
    const names = tools.map((t) => t.name);
    const health = await fetch("http://127.0.0.1:" + state.port + "/health").then((r) => r.json()).catch(() => null);
    console.log(
      JSON.stringify(
        { ok: true, ...meta, health, tools: names, count: names.length, hasGui: names.includes("mtnode_gui") },
        null,
        2,
      ),
    );
    return;
  }

  let tool = "";
  let toolArgs = {};
  if (cmd === "call") {
    tool = String(args._[1] || "");
    if (!tool) throw new Error("用法：call <tool> [--args '<json>']");
    toolArgs = readArgsJson(args);
  } else if (cmd === "gui") {
    const action = String(args._[1] || "");
    if (!action) throw new Error("用法：gui <action> [--which …] [--target '<json>'] [--args '<json>']");
    tool = "mtnode_gui";
    toolArgs = readArgsJson(args);
    toolArgs.action = action;
    if (args.which && args.which !== true) toolArgs.which = String(args.which);
    if (args.target) toolArgs.target = typeof args.target === "string" ? JSON.parse(args.target) : args.target;
  } else {
    throw new Error("未知子命令：" + cmd + "（可用：discover / call / gui）");
  }

  const rpc = await ctl(state, "tools/call", { name: tool, arguments: toolArgs });
  const out = unwrap(rpc);
  const payload = { ok: out.ok, tool, args: toolArgs, ...meta, result: out.value };
  console.log(JSON.stringify(payload, null, 2));
  if (!out.ok) process.exitCode = 2;
}

function readArgsJson(args) {
  if (args.json && args.json !== true) return JSON.parse(fs.readFileSync(String(args.json), "utf8"));
  if (args.args && args.args !== true) return JSON.parse(String(args.args));
  /* 环境变量兜底：从 PowerShell / cmd 传 JSON 时引号常被吞（`--args '{"path":"x"}'` 到不了这里
     就是空的），这时用 MTNODE_GUI_ARGS 最省事。 */
  const env = process.env.MTNODE_GUI_ARGS;
  if (env && String(env).trim()) return JSON.parse(String(env));
  return {};
}

main().catch((e) => {
  console.error("[mtnode-gui] " + ((e && e.message) || e));
  process.exitCode = 1;
});
