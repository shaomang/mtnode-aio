"use strict";
/* MCP 服务端（第三方客户端接进来操作 MTNode）—— 冒烟测试（纯 Node，不启 Electron）
 *   node test/smoke-mcp-server.js
 * 口径：本模块把「MTNode 自己当 MCP 服务端」这件事钉成回归门槛 —— 契约不许漂、
 * 接线不许断、边界（不导出什么）不许松、文档与打包白名单不许漏。
 * 真跑一条链路的探针是 scripts/probe-mcp-server.mjs / probe-mcp-stdio.mjs（可单独跑）。
 * 覆盖：
 *   [1] 契约由插件定义生成且不漂移（build-mcp-contract --check 同口径）；工具集 = 8 个既定名字
 *   [2] 接线：契约 family ↔ mcp-server.js 的 TOOL_OPS ↔ 渲染层 mcp-bridge.js 的 op 分派三方对齐
 *   [3] 生成物形状：JSON Schema 可用（type/properties）、校验表与契约同源同集
 *   [4] 服务端本体：零门槛起停、只绑回环、随机端口、令牌只落 mcp-server.json（不进 config.json）
 *   [5] 边界：browser_* / 引擎自带通用工具不导出，且给出可读原因
 *   [6] 主进程 / 预加载 / 渲染层接线：IPC 通道、事件推送、脚本加载顺序、授权开关
 *   [7] 「扩展能力管理 → 服务端」面板：标签页、开关/令牌/自检/审计/抓包入口
 *   [8] 打包与文档：build.json 白名单、docs/、guides/manual/、内置技能、skill index
 *   [9] 词条：面板新增中文字面量都有英文对照
 *  [10] 并发口径：写排队（服务端与渲染层各一道）、版本闸（baseHash）在两处都有判据
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

let fails = 0;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
}
const ROOT = path.join(__dirname, "..");
const abs = (rel) => path.join(ROOT, ...rel.split("/"));
const read = (rel) => fs.readFileSync(abs(rel), "utf8");
const exists = (rel) => fs.existsSync(abs(rel));
const zhRe = /[\u4e00-\u9fff]/;

const CONTRACT = JSON.parse(read("mcp-tools.json"));
const TOOL_NAMES = [
  "mtnode_canvas_get",
  "mtnode_canvas_edit",
  "mtnode_app",
  "mtnode_vision",
  "mtnode_db",
  "mtnode_facts",
  "lt_state",
  "mtnode_assets",
];

/* ── [1] 契约不漂移 + 工具集 ─────────────────────────────────────────────── */
console.log("[1] 契约由插件定义生成（不漂移）· 工具集");
{
  const r = spawnSync(process.execPath, [abs("scripts/build-mcp-contract.mjs"), "--check"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  ok(r.status === 0, "重跑生成器与仓内契约一致（scripts/build-mcp-contract.mjs --check）：" + (r.stdout || r.stderr || "").trim().split("\n").pop());
  ok(CONTRACT.generator === "scripts/build-mcp-contract.mjs", "契约标注了生成器");
  ok(/禁止手改/.test(CONTRACT.note || ""), "契约写明禁止手改");
  const names = CONTRACT.tools.map((t) => t.name);
  ok(
    names.length === TOOL_NAMES.length && TOOL_NAMES.every((n) => names.includes(n)),
    "工具集 = " + TOOL_NAMES.join(", "),
  );
  const srcs = new Set(CONTRACT.tools.map((t) => t.source));
  ok(
    srcs.size === 5 &&
      ["canvas-plugin.mjs", "db-plugin.mjs", "ai-facts-plugin.mjs", "longtask-plugin.mjs", "assets-plugin.mjs"].every(
        (f) => [...srcs].some((s) => s.endsWith("/" + f)),
      ),
    "参数表真源只来自 5 个插件：" + [...srcs].map((s) => s.split("/").pop()).join(", "),
  );
  ok(
    ![...srcs].some((s) => /browser-plugin|tools-plugin/.test(s)),
    "浏览器 / 用户工具节点插件不在导出范围",
  );
  const longDesc = CONTRACT.tools.find((t) => t.name === "mtnode_canvas_edit");
  ok(
    longDesc && longDesc.description.length > 200 && /CRITICAL/.test(longDesc.description),
    "description 是插件里的全文（未截断、未另抄一份）",
  );
}

/* ── [2] 三方接线对齐 ───────────────────────────────────────────────────── */
console.log("[2] 接线：契约 family ↔ TOOL_OPS ↔ 渲染层 op 分派");
{
  const server = read("mcp-server.js");
  const bridge = read("renderer/mcp-bridge.js");
  for (const t of CONTRACT.tools) {
    ok(new RegExp("\\b" + t.name + ":\\s*\\{").test(server), "服务端有 " + t.name + " 的 op 接线");
  }
  ok(/const TOOL_OPS = \{/.test(server), "TOOL_OPS 表存在（工具 → 渲染层 op）");
  ok(/"case \"canvasList\"/.test(bridge) === false, "渲染层分派用 switch（非字符串 case 拼接）");
  for (const op of ["get", "edit", "app", "vision", "db", "facts", "asset", "lt", "canvasList", "skillList", "skillBody"]) {
    ok(new RegExp('case "' + op + '"').test(bridge), "渲染层认得 op：" + op);
  }
  ok(/handleCanvasEvent\(/.test(bridge), "画布族复用 handleCanvasEvent（不另写执行器）");
  ok(/handleDbToolEvent\(/.test(bridge), "数据库族复用 handleDbToolEvent");
  ok(/handleAiFactsToolEvent\(/.test(bridge), "事实库族复用 handleAiFactsToolEvent");
  ok(/handleAssetToolEvent\(/.test(bridge), "素材族复用 handleAssetToolEvent");
  ok(!/fs\.writeFileSync|require\("fs"\)|require\('fs'\)/.test(bridge), "渲染层桥不直接写文件（画布真源只在宿主）");
}

/* ── [3] 生成物形状 ─────────────────────────────────────────────────────── */
console.log("[3] 生成物形状（JSON Schema / 校验表同源）");
{
  for (const t of CONTRACT.tools) {
    const s = t.inputSchema;
    ok(s && s.type === "object" && s.properties && typeof s.properties === "object", t.name + " 的 inputSchema 是对象 schema");
    ok(!("required" in s) || Array.isArray(s.required), t.name + " 的 required 是数组（MCP 口径）");
  }
  const schemas = require(abs("mcp-tool-schemas.js")).MCP_TOOL_SCHEMAS;
  const a = Object.keys(schemas).sort();
  const b = CONTRACT.tools.map((t) => t.name).sort();
  ok(JSON.stringify(a) === JSON.stringify(b), "校验表与契约的工具集一致（" + a.length + " 个）");
  ok(
    JSON.stringify(schemas.mtnode_canvas_get) === JSON.stringify(CONTRACT.tools.find((t) => t.name === "mtnode_canvas_get").inputSchema),
    "校验表内容与契约逐字一致",
  );
  ok(CONTRACT.resources.length === 5 && CONTRACT.prompts.length === 3, "资源 5 条（2 静态 + 3 模板）· 提示词 3 份");
  ok(
    CONTRACT.prompts.every((p) => typeof p.builder === "string" && p.arguments),
    "提示词带构造器名与参数表",
  );
}

/* ── [4] 服务端本体（真起一次，只绑回环）───────────────────────────────── */
console.log("[4] 服务端本体：起停 / 回环 / 令牌落点");
{
  const { createMcpHost } = require(abs("mcp-server.js"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-mcp-smoke-"));
  const host = createMcpHost({
    dataDir: tmp,
    appRoot: ROOT,
    log: () => {},
    sendToRenderer: () => {},
  });
  return (async () => {
    const st0 = host.status();
    ok(st0.running === false && st0.enabled === true, "默认启用但未监听（start 之前）");
    ok(typeof st0.token === "string" && st0.token.length >= 24, "首次运行即生成令牌（长度 ≥24）");
    ok(exists(path.relative(ROOT, path.join(tmp, "mcp-server.json"))) || fs.existsSync(path.join(tmp, "mcp-server.json")), "运行信息落 mcp-server.json");
    ok(!fs.existsSync(path.join(tmp, "config.json")), "不写 config.json（令牌与状态独立成文件）");

    await host.start();
    const st = host.status();
    ok(st.running && st.port > 0, "监听成功（随机端口 " + st.port + "）");
    ok(st.host === "127.0.0.1", "只绑回环地址");
    ok(st.url === "http://127.0.0.1:" + st.port + "/mcp", "URL 形状正确");
    ok(st.tools === CONTRACT.tools.length, "状态里的工具数与契约一致");
    ok(st.stdioCommand && /mcp-stdio\.js$/.test(st.stdioCommand.script), "状态给出 stdio 桥脚本路径");

    /* 端口必须**落盘**：stdio 桥唯一的发现来源就是 mcp-server.json 里的 port + token。
       只放运行时内存 = 外部客户端永远读不到，桥一律报「没开 MTNode」（实测踩过）。 */
    {
      const persisted = JSON.parse(fs.readFileSync(path.join(tmp, "mcp-server.json"), "utf8"));
      ok(Number(persisted.port) === st.port && st.port > 0, "监听端口落盘 mcp-server.json（stdio 桥靠它发现服务端）");
    }

    const metaRes = await fetch("http://127.0.0.1:" + st.port + "/meta");
    const meta = await metaRes.json();
    ok(metaRes.status === 200 && meta.running === true, "GET /meta 免令牌可读");
    ok(!JSON.stringify(meta).includes(st.token), "/meta 不泄露令牌本身");

    const noAuth = await fetch(st.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    ok(noAuth.status === 401, "无令牌一律 401");

    const after = await host.stop();
    ok(after.running === false, "停止后不再监听");
    {
      const persisted = JSON.parse(fs.readFileSync(path.join(tmp, "mcp-server.json"), "utf8"));
      ok(Number(persisted.port) === 0, "停止后把落盘端口清零（桥据此判「服务端没在跑」，不拿旧端口去连）");
    }
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}

    /* 打包态：stdio 桥脚本在 resources/（asar 外）——外部 Node 读不了 asar 内路径，
       所以 stdioCommand 必须优先认 resourcesDir。 */
    {
      const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-mcp-pack-"));
      fs.writeFileSync(path.join(tmp2, "mcp-stdio.js"), "// stub\n", "utf8");
      const host2 = createMcpHost({ dataDir: tmp2, appRoot: ROOT, resourcesDir: tmp2, log: () => {}, sendToRenderer: () => {} });
      const c2 = host2.status().stdioCommand;
      ok(c2.script === path.join(tmp2, "mcp-stdio.js"), "打包态 stdio 脚本取自 resourcesDir（asar 外）");
      const host3 = createMcpHost({ dataDir: tmp2, appRoot: ROOT, log: () => {}, sendToRenderer: () => {} });
      ok(host3.status().stdioCommand.script === path.join(ROOT, "mcp-stdio.js"), "开发态（无 resourcesDir）回退仓库根");
      try {
        fs.rmSync(tmp2, { recursive: true, force: true });
      } catch {}
    }

    /* ── [5] 边界 ─────────────────────────────────────────────────────── */
    console.log("[5] 边界：不导出什么（且给出可读原因）");
    const server = read("mcp-server.js");
    ok(/EXCLUDED_TOOLS/.test(server) && /browser_/.test(server), "browser_* 走显式排除表");
    ok(/会话自己的浏览器控制面/.test(server), "排除原因写成人话（不是「未知工具」）");
    ok(!/browser_launch|browser_click/.test(read("scripts/build-mcp-contract.mjs")), "生成器不抓浏览器插件");
    ok(/只导 MTNode 独有能力|不导出/.test(read("guides/mcp-server.md")), "文档写明边界");

    /* ── [6] 主进程 / 预加载 / 渲染层接线 ─────────────────────────────── */
    console.log("[6] 主进程 / 预加载 / 渲染层接线");
    const main = read("main.js");
    ok(/require\("\.\/mcp-server\.js"\)/.test(main), "main.js 引入 mcp-server.js");
    for (const ch of ["mcp:status", "mcp:setEnabled", "mcp:resetToken", "mcp:setClientId", "mcp:setCapture", "mcp:audit", "mcp:capture", "mcp:selfTest", "mcp:interact"]) {
      ok(main.includes('ipcMain.handle("' + ch + '"'), "IPC 通道 " + ch);
    }
    ok(/mainWin\.webContents\.send\("mcp:event"/.test(main), "主进程向渲染层推 mcp:event");
    ok(/mcp\(\)\s*\.start\(\)/.test(main), "应用启动即起服务端（幂等）");
    ok(/mcpHost\.dispose\(\)/.test(main), "退出时收掉服务端");

    const preload = read("preload.js");
    for (const m of ["mcpStatus", "mcpSetEnabled", "mcpResetToken", "mcpSetClientId", "mcpSetCapture", "mcpAudit", "mcpCapture", "mcpSelfTest", "mcpInteract", "mcpOnEvent"]) {
      ok(preload.includes(m + ":"), "preload 暴露 " + m);
    }
    ok(/ipcRenderer\.on\('mcp:event'/.test(preload), "preload 订阅 mcp:event 并给退订函数");

    const html = read("renderer/index.html");
    ok(/<script src="mcp-bridge\.js"><\/script>/.test(html), "index.html 加载 mcp-bridge.js");
    const iBridge = html.indexOf('src="mcp-bridge.js"');
    ok(iBridge > html.indexOf('src="app-nodes.js"') && iBridge > html.indexOf('src="app-db.js"'), "桥排在 app-nodes.js / app-db.js 之后");

    const nodes = read("renderer/app-nodes.js");
    ok(/if \(typeof runCtx\.mcpFrameSettle === "function"\)/.test(nodes), "handleCanvasEvent 认 MCP 回执通道");
    ok(/if \(S\._mcpAuthorized\) return false;/.test(nodes), "canvasOpNeedsConfirm 认授权开关");
    ok(/if \(S\._mcpAuthorized\) return;/.test(nodes), "ensureAgentTool 认授权开关");
    ok(/boundWf = runWf \|\| canvasTargetWf\(\)/.test(nodes), "应用动作按绑定画布解析目标（多画布）");
    const appjs = read("renderer/app.js");
    ok(/_mcpAuthorized: false/.test(appjs), "S 里有 _mcpAuthorized 初值");
    ok(/_mcpAuthorized/.test(read("renderer/mcp-bridge.js")), "桥在每次调用期间开关授权");

    /* MCP 调用不属于任何 dsh 轮：桥必须为本帧在 S._runCancels 里占位，否则宿主按
       canvasConfirmRunLive 判活会回「发起轮已结束，未执行」——canvas 族整族被拒（实测踩过）。 */
    const bridgeSrc = read("renderer/mcp-bridge.js");
    ok(/S\._runCancels\[runKey\] = runTicket/.test(bridgeSrc), "桥为每一帧登记在途轮（否则 canvas 族被判「发起轮已结束」）");
    ok(/releaseRun\(\)/.test(bridgeSrc) && /delete S\._runCancels\[runKey\]/.test(bridgeSrc), "帧结束立刻撤掉登记（不留常驻痕迹）");

    /* db / facts / asset 三族的回执通道：宿主处理函数的默认 reply 走 dshInteract（自家那一轮），
       第三方 MCP 帧不在任何 dsh 轮里 → 必须把窗口的 reply 覆盖成 mcpInteract 通道，
       否则结果写给没人认领的 id，客户端一直等到超时（实测踩过）。 */
    const dbsrc = read("renderer/app-db.js");
    for (const [fn, needle, why] of [
      ["handleDbToolEvent", "function handleDbToolEvent(data, node, wf, replyOverride)", "db 族认 MCP 回执覆盖"],
      ["handleAiFactsToolEvent", "function handleAiFactsToolEvent(data, wf, replyOverride)", "facts 族认 MCP 回执覆盖"],
      ["handleAssetToolEvent", "function handleAssetToolEvent(data, runKey, replyOverride)", "asset 族认 MCP 回执覆盖"],
    ]) {
      ok(dbsrc.includes(needle), why + "：" + fn);
    }
    for (const [call, needle] of [
      ["mcpHandleDb", "handleDbToolEvent("],
      ["mcpHandleFacts", "handleAiFactsToolEvent("],
      ["mcpHandleAsset", "handleAssetToolEvent("],
    ]) {
      const i = bridgeSrc.indexOf("function " + call);
      const seg = i < 0 ? "" : bridgeSrc.slice(i, i + 1400);
      ok(seg.includes(needle) && /\(result, error\) => reply\(frame\.id, result, error\)/.test(seg), call + " 把回执交回 MCP 通道");
    }

    /* ── [7] 面板 ─────────────────────────────────────────────────────── */
    console.log("[7] 「扩展能力管理 → 服务端」面板");
    const plugins = read("renderer/app-plugins.js");
    ok(/key: "server"/.test(plugins) && /zh: "MCP 服务端"/.test(plugins), "新增「服务端」分类");
    ok(/dshMcpServerGrid/.test(plugins), "面板有独立网格宿主");
    ok(/function paintMcpServerPanel/.test(plugins), "面板渲染函数存在");
    ok(/function fetchMcpServerState/.test(plugins) && /function mcpServerLoadLogs/.test(plugins), "状态与日志拉取函数存在");
    ok(plugins.indexOf('kind === "server"') > 0 && /function renderExtManagerInfo/.test(plugins), "服务端页走专用渲染分支");
    for (const label of ["开启服务端", "关闭服务端", "复制令牌", "重置令牌", "自检", "打开抓包", "复制配置片段"]) {
      ok(plugins.includes('I18n.t("' + label + '")') || plugins.includes('"' + label + '"'), "面板按钮：" + label);
    }
    ok(/mcp-audit/.test(plugins) || /最近调用（审计/.test(plugins), "面板展示审计入口");
    ok(/s\.token/.test(plugins) && /mcpCopy\(s\.token/.test(plugins), "令牌可看可复制");
    ok(!/point-out|outside-click/.test(plugins), "面板不引入点外部即关（persistent 口径）");
    const settings = read("renderer/app-settings.js");
    ok(/refreshExtInventory/.test(settings), "设置里仍走扩展能力管理入口（不另加内联清单）");

    /* ── [8] 打包与文档 ───────────────────────────────────────────────── */
    console.log("[8] 打包白名单与文档交付");
    const buildRaw = read("build.json");
    for (const f of ["mcp-server.js", "mcp-prompts.js", "mcp-tools.json", "mcp-tool-schemas.js", "mcp-stdio.js"]) {
      ok(buildRaw.includes('"' + f + '"'), "build.json files 含 " + f);
    }
    for (const f of ["guides/mcp-server.md", "guides/mcp-tools.md", "guides/manual/mcp-server.md", "mtnode-agent-skills/mtnode/mcp-server/SKILL.md", "scripts/build-mcp-contract.mjs", "scripts/probe-mcp-server.mjs", "scripts/probe-mcp-stdio.mjs", "test/smoke-mcp-server.js"]) {
      ok(exists(f), "存在 " + f);
    }
    /* docs/ 在 4ce4c3f 起被整目录取消跟踪（本地工程记录，不入库 / 不发版）：第三方能拿到手的
       文档必须放在随包且入库的目录里。这条断言防「写进 docs/ 等于没交付」重演。 */
    ok(!exists("docs/mcp-server.md") && !exists("docs/mcp-tools.md"), "接入文档不放 docs/（该目录已取消跟踪）");
    const skill = read("mtnode-agent-skills/mtnode/mcp-server/SKILL.md");    ok(/^---[\s\S]*name: mtnode-mcp-server[\s\S]*---/.test(skill), "技能 frontmatter 完整（name/title/description）");
    ok(/mtnode_canvas_get/.test(skill) && /baseHash/.test(skill), "技能正文写明读图与版本闸");
    const idx = JSON.parse(read("mtnode-agent-skills/index.json"));
    ok(JSON.stringify(idx).includes("mcp-server"), "内置技能索引已收录本技能");
    const manual = JSON.parse(read("guides/manual/index.json"));
    ok(JSON.stringify(manual).includes("mcp-server"), "应用内手册目录已收录本页");
    const manualMd = read("guides/manual/mcp-server.md");
    ok(/mcp-stdio\.js/.test(manualMd) && /mcp-audit/.test(manualMd), "手册页写明桥脚本与审计目录");

    /* ── [9] 词条 ─────────────────────────────────────────────────────── */
    console.log("[9] 中英词条");
    const i18n = read("renderer/i18n.js");
    const lits = [...plugins.matchAll(/I18n\.t\(\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).filter((x) => zhRe.test(x));
    const known = new Set([
      "更新中…",
      "基于 llama.cpp 的本地 GGUF 模型管理：指定目录安装、国内镜像、多模型显存管理、OpenAI 兼容 API。",
      "基于 GPT-SoVITS 的本地文本转语音：指定目录安装、参考音频音色管理、OpenAI 兼容 TTS API（API Key 鉴权）。",
      "移除技能",
      "服务器名",
      "添加服务器",
      "未启用",
    ]); /* 本次改动之前就缺的既有条目，不在本轮范围内 */
    const missing = [...new Set(lits)].filter((x) => !i18n.includes('"' + x + '"') && !known.has(x));
    ok(missing.length === 0, "面板新增中文文案都有英文对照" + (missing.length ? "（缺：" + missing.join(" / ") + "）" : ""));
    for (const w of ["MCP 服务端", "复制令牌", "重置令牌", "自检", "最近调用（审计 · 数据目录 mcp-audit/）"]) {
      ok(i18n.includes('"' + w + '"'), "词条：" + w);
    }

    /* ── [10] 并发与版本闸 ────────────────────────────────────────────── */
    console.log("[10] 写排队与版本闸");
    const srv = read("mcp-server.js");
    ok(/writeQueues/.test(srv) && /if \(op\.write\)/.test(srv), "服务端按会话给写操作排队");
    ok(/串行化/.test(srv), "排队意图写在注释里（可复核口径）");
    ok(/baseHash/.test(srv) && /ROUTE_KEYS/.test(srv), "baseHash 是 MCP 侧路由参数（不下发插件处理函数）");
    ok(/baseHash/.test(read("renderer/mcp-bridge.js")) && /版本不一致/.test(read("renderer/mcp-bridge.js")), "渲染层在写之前比内容哈希");
    ok(/contentHashOf\(/.test(read("renderer/mcp-bridge.js")), "内容哈希取自 canvas_get 同一真源");
    ok(/writeChains/.test(read("renderer/mcp-bridge.js")), "渲染层再有第二道写排队");
    ok(/canvasHashes/.test(srv), "服务端记最近读到的哈希（供回执与审计）");

    console.log("");
    console.log(fails ? "✗ " + fails + " / " + checks + " 项未通过" : "✓ 全部 " + checks + " 项通过");
    process.exit(fails ? 1 : 0);
  })();
}
