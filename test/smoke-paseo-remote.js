"use strict";
/* 「Paseo 手机接管」应用插件（kind paseo，id paseo-remote）—— 冒烟测试（纯 Node，不启 Electron）
 *   node test/smoke-paseo-remote.js
 *
 * 这只测试钉的是**新插件这一圈接线**，桥本身（ACP ↔ 本机 HTTP）由
 * test/smoke-paseo-bridge.mjs 与 test/smoke-session-bridge.js 分别负责，不在这里重复。
 *
 * 覆盖：
 *   [1] 五层接线：catalog 词条 / KNOWN_KINDS + handler 兜底 / main.js 注册与退出 /
 *                 preload 桥 / 渲染层卡片分支与图标 / 封面图标
 *   [2] 宿主契约：报错总线注册（含 skill 名）、每个失败出口上报、控制台窗与其 preload、
 *                 远程总开关**默认关**、gate 语义
 *   [3] 会话族闸门：mcp-server.js 的 sessionGate / assertSessionAllowed / dropSessionStreams，
 *                 且 SSE 也过闸（关掉总开关时实时流同样进不来）
 *   [4] 二维码：paseo/qr.js 真编码一次真实长度的配对 URL（243 字符量级）并出 SVG
 *   [5] 打包与交付：build.json 白名单与 extraResources、skills 安装技能、指南提到插件入口、
 *                 i18n 中英成对、设置页只剩一行入口（旧面板的片段复制与自检按钮已收进插件）
 */
const fs = require("fs");
const path = require("path");

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

const PLUGIN_ID = "paseo-remote";
const KIND = "paseo";

/* ── [1] 五层接线 ────────────────────────────────────────────────────────── */
console.log("[1] 插件五层接线");
{
  const catalog = JSON.parse(read("plugins/catalog.default.json"));
  const item = (catalog.plugins || []).find((p) => p.id === PLUGIN_ID);
  ok(!!item, "catalog.default.json 里有 " + PLUGIN_ID + " 词条");
  ok(item && item.kind === KIND && item.handler === KIND, "kind / handler 都是 " + KIND);
  ok(item && item.icon === PLUGIN_ID + ".png", "封面图标指向 plugins/icons/" + PLUGIN_ID + ".png");
  ok(item && item.title && item.title.zh && item.title.en, "标题中英齐备");
  ok(item && item.subtitle && item.subtitle.zh && item.subtitle.en, "副标题中英齐备");
  ok(item && !!item.minAppVersion && !!item.version, "声明 version 与 minAppVersion");

  const iconPath = "plugins/icons/" + PLUGIN_ID + ".png";
  ok(exists(iconPath), "封面图标文件在：" + iconPath);
  if (exists(iconPath)) {
    const buf = fs.readFileSync(abs(iconPath));
    const isPng = buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    ok(isPng, "封面图标是合法 PNG（魔数）");
    if (isPng) {
      const w = buf.readUInt32BE(16);
      const h = buf.readUInt32BE(20);
      ok(w === h && w >= 128, "封面图标 1:1 且不小于 128px（实际 " + w + "x" + h + "）");
    }
  }

  const pluginsHost = read("plugins/main-app-plugins.js");
  ok(/KNOWN_KINDS = new Set\(\[[^\]]*"paseo"/.test(pluginsHost), "KNOWN_KINDS 收进了 kind paseo（否则卡片降级 unknown）");
  ok(/raw\.handler === "paseo"\) kind = "paseo"/.test(pluginsHost), "normalizePlugin 的 kind 兜底链认 handler=paseo");
  ok(/kind === "paseo" \? "paseo"/.test(pluginsHost), "handler 兜底三元链也补了 paseo");

  const main = read("main.js");
  ok(/require\("\.\/paseo\/main-paseo\.js"\)/.test(main), "main.js require 了 paseo/main-paseo.js");
  ok(/paseoRemote\.registerPaseoRemoteIpc\(/.test(main), "main.js 在 whenReady 段注册宿主 IPC");
  ok(/paseoRemote\.shutdownPaseoRemoteUiOnly\(\)/.test(main), "before-quit 里只关控制台窗（daemon 常驻）");
  ok(/sessionGate: \(\) => paseoRemote\.sessionGate\(\)/.test(main), "mcp() 注入了会话族闸门（总开关真源在插件）");

  const preload = read("preload.js");
  for (const api of [
    "paseoRemoteStatus",
    "paseoRemoteOpen",
    "paseoRemoteClose",
    "paseoRemoteRemoteSet",
    "paseoRemoteConsoleTail",
    "paseoRemoteOnConsoleChanged",
  ]) {
    ok(new RegExp(api + ":").test(preload), "preload 白名单有 " + api);
  }

  const ui = read("renderer/app-plugins.js");
  ok(/async function refreshPaseoPluginCard\(/.test(ui), "渲染层有 refreshPaseoPluginCard");
  ok(/item\.kind === "paseo" \|\| item\.handler === "paseo"/.test(ui), "openAppPluginsDialog 里挂了 paseo 分支");
  ok(/refreshPaseoPluginCard\(card\)/.test(ui), "分支里真的调它重画卡片");
  ok(/paseoRemoteOnConsoleChanged/.test(ui), "卡片订阅控制台开/关事件");
  ok(
    /mkPluginActBtn\(\s*"console"/.test(ui) && !/mkPluginActBtn\(\s*"paseo/.test(ui),
    "卡片按钮图标取自 PLUGIN_ACT_SVG 既有 kind（console），不自创图标名",
  );
}

/* ── [2] 宿主契约 ────────────────────────────────────────────────────────── */
console.log("[2] 宿主契约（paseo/main-paseo.js）");
{
  const host = read("paseo/main-paseo.js");
  ok(/const PLUGIN_ID = "paseo-remote"/.test(host), "PLUGIN_ID = paseo-remote（与 catalog id 一致）");
  ok(/const INSTALL_SKILL = "paseo-remote-install"/.test(host), "INSTALL_SKILL 常量存在");
  const reg = /registerPluginHost\(\{([\s\S]*?)\}\);/.exec(host);
  ok(!!reg, "注册了报错总线宿主");
  if (reg) {
    ok(/id: PLUGIN_ID/.test(reg[1]), "宿主 id 取 PLUGIN_ID");
    ok(/skillName: INSTALL_SKILL/.test(reg[1]), "宿主带 skillName（修复会话据此加载安装技能）");
    ok(/tailConsole:/.test(reg[1]) && /getInstallDir:/.test(reg[1]), "宿主给了日志尾部与现场目录");
  }
  ok(/defaultConfig\(\)[\s\S]{0,400}remoteEnabled: false/.test(host), "远程连接总开关**默认关**");
  ok(
    /function sessionGate\(\)[\s\S]{0,400}allowed: false/.test(host),
    "sessionGate 关着时回 allowed:false + 人话原因",
  );
  ok(/function disconnectAllRemote\(\)/.test(host) && /dropSessionStreams/.test(host), "「断开所有远程设备」= 关开关 + 收 SSE");
  ok(/function resetPairing\(\)/.test(host) && /daemon-keypair\.json/.test(host), "「重置配对凭据」= 换 daemon 密钥");
  /* CLI 调用姿势：真机实测把三条路都试过（见宿主里的长注释）——
     动态键必须整段替换 agents.providers，Windows 上必须自己按 CommandLineToArgvW 规则转义。 */
  ok(
    /"daemon", "config", "set", "agents\.providers"/.test(host) && /async function readProviders\(/.test(host),
    "provider 注册走官方 CLI 的**整段替换**（先 get agents.providers 再合并写回；动态键不能单独 set）",
  );
  ok(
    /"daemon", "config", "unset", "agents\.providers"/.test(host),
    "移除：清空后 unset 整段（还剩别的 provider 时才 set 剩余）",
  );
  ok(
    /function winArg\(/.test(host) && /windowsVerbatimArguments: true/.test(host) && /cmd\.exe/.test(host),
    "Windows 命令行自己按 CommandLineToArgvW 规则转义（JSON 参数才能原样到达 CLI）",
  );
  ok(!/function winQuote\(/.test(host), "旧的 cmd 引号实现已移除（它把 JSON 参数拆坏过）");
  ok(/need_confirm/.test(host) && /runningAgents/.test(host), "写入前先探一次活跃会话，必要时回 need_confirm");
  ok(
    /"daemon", "pair", "--json"/.test(host) && /RELAY_DISABLED|relay_disabled/.test(host),
    "配对走官方 `daemon pair --json`；relay 关着时明确回 relay_disabled",
  );
  {
    /* 桥的版本闸：官方客户端在本地 provider 通道上报的是字面量 "dev"，
       旧逻辑 `versionGte(\"dev\", MIN)` 会判成版本过低 —— 真机上 Paseo 侧表现为
       ACPRequestError「Paseo 版本过低」，provider 看着 available 却一个会话都建不起来。 */
    const bridge = read("paseo/acp-bridge.mjs");
    ok(/function versionComparable\(/.test(bridge) && /function clientVersionAllowed\(/.test(bridge), "桥有「非语义化版本放行」的版本闸");
    ok(/if \(!versionComparable\(v\)\) return \{ allowed: true/.test(bridge), "dev / 非语义化版本按放行处理（不是拿闸门把自己挡在门外）");
  }
  /* 每个失败出口都要上报：粗粒度数一遍 reportErr 的出现次数（安装 / 起后端 / provider / npm 缺失） */
  ok((host.match(/reportErr\(/g) || []).length >= 4, "失败出口都接进报错总线（≥4 处 reportErr）");
  ok(/openConsoleWindow/.test(host) && /preload: join\(__dirname, "preload-paseo\.js"\)/.test(host), "控制台窗用独立 preload");
  ok(/apart|不可|不静默/.test(host), "注释里写明边界（只碰会话层 / 不静默改设置）");

  const preloadPaseo = read("paseo/preload-paseo.js");
  ok(/contextBridge\.exposeInMainWorld\("paseoApi"/.test(preloadPaseo), "控制台桥暴露 window.paseoApi");
  for (const ch of ["pair", "providerApply", "remoteSet", "disconnectAll", "resetPairing", "install", "bridgeCheck"]) {
    ok(new RegExp(ch + ": \\(").test(preloadPaseo), "控制台桥有 " + ch);
  }
  ok(/paseoRemote:getStatus/.test(preloadPaseo), "控制台桥走 paseoRemote:* 通道");

  const uiHtml = read("paseo/ui/index.html");
  ok(/<script src="\.\.\/qr\.js"><\/script>/.test(uiHtml), "控制台加载 ../qr.js（自研二维码编码器）");
  ok(/<script src="ui\.js"><\/script>/.test(uiHtml), "控制台加载 ui.js");
  ok(exists("paseo/ui/ui.css") && exists("paseo/ui/ui.js"), "控制台三件套齐备（html/js/css）");

  /* 语法自检：冒烟原先只读文本，抓不到语法错 —— 本轮真机自验时就因此拿到一只全空的窗
     （renderPair 里少一个右括号，整个 ui.js 解析失败，六个区块一律空白）。这里补一道编译闸。 */
  const vm = require("vm");
  for (const f of ["paseo/qr.js", "paseo/ui/ui.js", "paseo/preload-paseo.js"]) {
    let compiled = true;
    let msg = "";
    try {
      new vm.Script(read(f), { filename: f });
    } catch (e) {
      compiled = false;
      msg = (e && e.message) || String(e);
    }
    ok(compiled, f + " 能被 JS 引擎编译（语法自检）" + (compiled ? "" : "：" + msg));
  }
  ok(/id="btn-close"/.test(uiHtml) && /paseoApi\.close\(\)/.test(read("paseo/ui/ui.js")), "控制台窗有窗内关闭按钮（不只靠原生标题栏 X）");

  /* 「手机端能选到几个模型 / 几条会话」这两个数要在面板上看得见：
     用户报的「未检测到 Model」「看不到会话」都栽在这里，不能只留在日志里。 */
  const uiJs = read("paseo/ui/ui.js");
  ok(/function bridgeFactsOf\(/.test(uiJs), "控制台解析桥自检正文里的模型 / 会话计数");
  ok(/BRIDGE_FACTS = facts;[\s\S]{0,80}renderProvider\(\)/.test(uiJs), "自检完刷新面板（数字当场可见，不用重开窗）");
  ok(/models:\\s\*\(\\d\+\)/.test(uiJs) && /sessions:\\s\*\(\\d\+\)\\s\*条可接管/.test(uiJs), "两个正则与桥 --check 的文案一致（models: N / sessions: N 条可接管）");
}

/* ── [3] 会话族闸门 ──────────────────────────────────────────────────────── */
console.log("[3] 会话族闸门（mcp-server.js）");
{
  const srv = read("mcp-server.js");
  ok(/const sessionGate = typeof o\.sessionGate === "function"/.test(srv), "createMcpHost 收 sessionGate 选项");
  ok(/function assertSessionAllowed\(\)/.test(srv), "有 assertSessionAllowed");
  ok(/async function sessionToolCall\(spec, args, ctx\) \{\s*assertSessionAllowed\(\);/.test(srv), "会话族入口先过闸");
  ok(/dropSessionStreams: \(why\) =>/.test(srv), "导出 dropSessionStreams（断开所有远程设备用）");
  const sse = /function openSse\(req, res, url\)([\s\S]*?)\n  \}/.exec(srv);
  ok(!!sse && /assertSessionAllowed\(\)/.test(sse[1]), "SSE 打开也过闸（实时流是远程接管的一半）");
  ok(/sessionGate: sessionBridge \? sessionBridge\.stats\(\) : null/.test(srv) === false, "status() 里的会话统计仍走 sessionBridge（未被闸门替换）");
  ok(/sessionStreams: sseClients\.size/.test(srv), "status() 报 sessionStreams（观察者数的真源）");
}

/* ── [4] 二维码编码器（真跑） ─────────────────────────────────────────────── */
console.log("[4] 二维码编码器 paseo/qr.js");
{
  ok(exists("paseo/qr.js"), "paseo/qr.js 在");
  const src = read("paseo/qr.js");
  ok(/module\.exports/.test(src), "QR 编码器可在 Node 下 require（CJS 导出）");
  ok(/window\.MTNodeQR|globalThis\.MTNodeQR/.test(src), "QR 编码器同时挂到全局（控制台窗 <script> 里也能用）");
  ok(!/require\(["']qrcode["']\)|from ["']qrcode["']/.test(src), "零第三方依赖（没有 require/import 外部 qrcode 包）");
  let q = null;
  try {
    q = require(abs("paseo/qr.js"));
  } catch (e) {
    ok(false, "require paseo/qr.js 失败：" + ((e && e.message) || e));
  }
  if (q) {
    /* 真实的配对 URL 量级：serverId + 44 字符公钥 + relay 段，实测 243 字符 */
    const url =
      "https://app.paseo.sh/#offer=" +
      Buffer.from(
        JSON.stringify({
          v: 2,
          serverId: "srv_tOgGmDJvECT3",
          daemonPublicKeyB64: "X".repeat(44),
          relay: { endpoint: "relay.paseo.sh:443", useTls: true },
        }),
        "utf8",
      ).toString("base64url");
    const m = q.qrMatrix(url, { ecl: "M" });
    ok(m && Array.isArray(m.modules) && m.modules.length === m.size, "qrMatrix 返回方阵（size/modules 自洽）");
    ok(m && m.size === (m.version - 1) * 4 + 21, "尺寸符合标准（4*version+17）");
    ok(m && m.version >= 8 && m.version <= 20, "243 字符 URL 落在合理版本区间（实际 v" + (m && m.version) + "）");
    ok(m && typeof m.mask === "number" && m.mask >= 0 && m.mask < 8, "自动 mask 落在 0..7");
    ok(m && m.modules[0][0] === true && m.modules[6][6] === true, "左上定位图案画上了（含分隔带校验位）");
    ok(m && m.modules[0][7] === false, "定位图案右侧有分隔带（标准要求，空白）");
    const svg = typeof q.qrSvg === "function" ? q.qrSvg(url, { scale: 6, margin: 3 }) : "";
    ok(/^<svg[\s\S]*<\/svg>$/.test(String(svg).trim()), "qrSvg 出的是单只 <svg>…</svg>");
    ok(/viewBox=/.test(svg) && /<rect/.test(svg), "SVG 带 viewBox 与白底 rect");
  }
}

/* ── [5] 打包与交付 ──────────────────────────────────────────────────────── */
console.log("[5] 打包白名单与交付物");
{
  const build = read("build.json");
  ok(/"paseo\/\*\*"/.test(build), "build.json 的 files 白名单含 paseo/**（宿主 + 桥真源 + ui + qr）");
  ok(/"from": "paseo"[\s\S]{0,200}"to": "paseo"/.test(build), "extraResources 仍把 paseo/ 送到 resources/paseo（外部 Node 读桥脚本）");
  const er = /"from": "paseo"([\s\S]*?)\}/.exec(build);
  ok(!!er && /html/.test(er[1]) && /css/.test(er[1]), "extraResources 的 filter 带上 html/css（resources 侧那份是完整插件目录）");

  ok(exists("skills/paseo-remote-install/SKILL.md"), "安装 / 修复技能 skills/paseo-remote-install/SKILL.md 在");
  const skill = exists("skills/paseo-remote-install/SKILL.md") ? read("skills/paseo-remote-install/SKILL.md") : "";
  ok(/自我修复/.test(skill), "技能里写了【自我修复】模式");
  ok(/paseo daemon pair --json/.test(skill), "技能里给了配对真源命令");

  const guide = read("guides/paseo-bridge.md");
  ok(/插件/.test(guide) && /Paseo 手机接管/.test(guide), "guides/paseo-bridge.md 已改成「装插件 → 控制台出码」的新路径");

  const i18n = read("renderer/i18n.js");
  for (const zh of ["Paseo 手机接管", "未检测到 Paseo：打开控制台装后端", "远程已开 · 接管 "]) {
    ok(i18n.includes('"' + zh + '"'), "i18n 有词条：" + zh);
  }
  ok(/Paseo phone handoff/.test(i18n), "i18n 有英文对句");
  const pairs = (i18n.match(/"Paseo 手机接管": "Paseo phone handoff"/g) || []).length;
  ok(pairs === 1, "词条成对且不重复");

  /* 设置页那一块：只剩入口与排障（旧面板的片段复制 / 自检按钮已收进插件） */
  const ui = read("renderer/app-plugins.js");
  ok(/打开「Paseo 手机接管」/.test(ui), "设置页保留了「打开插件」入口");
  ok(!/复制 provider 片段/.test(ui) || !/paintPaseoBridgePanel[\s\S]{0,6000}复制 provider 片段/.test(ui), "设置页不再留第二份 provider 片段复制入口");
}

console.log("");
console.log(fails === 0 ? "全部通过：" + checks + " 项" : "失败 " + fails + " / " + checks + " 项");
process.exit(fails === 0 ? 0 : 1);
