"use strict";
/**
 * 安装窗（插件安装步骤对话）回归 —— 本轮新增能力的唯一冒烟入口。
 *
 * 口径（与实现一一对应）：
 *   · 步骤协议真源 pack-steps/step.ps1（一行一条 JSON）→ 7 个包各一份副本必须逐字节一致；
 *   · 每个包一份 steps.json（开窗即列全表），步骤 id 必须与包脚本里打的一致；
 *   · 解析与状态机在 plugins/install-steps.js（纯函数，本文件真跑它）；
 *   · 7 个后端宿主 + 窗口插件 + 桌宠都要在安装窗登记（registerInstallTarget）；
 *   · 取消 = 按进程树强杀 + 落 state="cancelled"（真进程证据在 test/smoke-install-cancel.js）；
 *   · 失败处置：脚本失败后**不再静默转 Agent 兜底**，一律停在安装窗的失败步，
 *     由用户点「交给 mtnode 会话修复」新建可见会话（工作区 = 安装目录）。
 * 跑法：node test/smoke-install-window.js
 */
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const os = require("os");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

let checks = 0;
let fails = 0;
function ok(cond, label) {
  checks++;
  if (cond) console.log("  ok   " + label);
  else {
    fails++;
    console.log("  FAIL " + label);
  }
}
function has(src, needle, label) {
  ok(String(src).indexOf(needle) >= 0, label + (String(src).indexOf(needle) >= 0 ? "" : "（缺 " + JSON.stringify(needle) + "）"));
}
function hasnt(src, needle, label) {
  ok(String(src).indexOf(needle) < 0, label);
}
function seg(src, from, to) {
  const i = String(src).indexOf(from);
  if (i < 0) return "";
  const j = String(src).indexOf(to, i + from.length);
  return j < 0 ? src.slice(i) : src.slice(i, j);
}
/** 按名字取出一个函数体（大括号配平）——断言「这个函数里有没有某调用」用，不靠下一个函数名赌顺序 */
function fnBody(src, name) {
  const at = String(src).indexOf("function " + name + "(");
  if (at < 0) return "";
  const open = String(src).indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  return src.slice(at);
}

/* 7 个后端插件：包目录 / 宿主文件 / 安装窗 id / steps.json */
const PACKS = [
  { pack: "llama-pack", host: "llama/main-llama.js", id: "llama-local", skill: "llama-local-install", steps: 5 },
  { pack: "breeze-pack", host: "breeze/main-breeze.js", id: "breeze-tts-local", skill: "breeze-tts-local-install", steps: 8 },
  { pack: "sensenova-pack", host: "sensenova/main-sensenova.js", id: "sensenova-local", skill: "sensenova-local-install", steps: 11 },
  { pack: "h3-pack", host: "h3/main-h3.js", id: "minimax-h3", skill: "minimax-h3-install", steps: 6 },
  { pack: "music3-pack", host: "music3/main-music3.js", id: "minimax-music3", skill: "minimax-music3-install", steps: 6 },
  { pack: "yue-pack", host: "yue/main-yue.js", id: "yue2-local", skill: "yue2-local-install", steps: 9 },
  { pack: "remotion-pack", host: "remotion/main-remotion.js", id: "remotion", skill: "", steps: 4 },
];

/* ═════════════ [1] 步骤协议：真源一份，7 个包逐字节一致 ═════════════ */
console.log("\n[1] 步骤协议真源 pack-steps/step.ps1 与 7 个包内的副本");
const protoSrc = read("pack-steps/step.ps1");
ok(exists("pack-steps/step.ps1"), "协议真源在 pack-steps/step.ps1");
for (const p of PACKS) {
  const rel = p.pack + "/scripts/step.ps1";
  ok(exists(rel), rel + " 随包存在");
  ok(fs.readFileSync(path.join(ROOT, rel), "utf8") === protoSrc, rel + " 与真源逐字节一致（复制没走样）");
}
has(protoSrc, "mtnodeStep", "协议行带 mtnodeStep 版本字段（宿主靠它认出步骤行）");
has(protoSrc, '"run|ok|fail|skip"', "协议写明四种步骤状态");
has(protoSrc, "function Step-ProgressMap", "大脚本用「进度门槛 → 步骤」适配层（不必重排安装流程）");
has(protoSrc, "function Step-Progress", "适配层函数在真源里");

/* ═════════════ [2] 每个包的步骤清单 + 脚本与清单同 id ═════════════ */
console.log("\n[2] 每包 steps.json：开窗即列全表，id 与脚本打的步骤行一致");
for (const p of PACKS) {
  const rel = p.pack + "/steps.json";
  ok(exists(rel), rel + " 存在");
  let man = null;
  try {
    man = JSON.parse(read(rel));
  } catch (e) {
    ok(false, rel + " 是合法 JSON（" + ((e && e.message) || e) + "）");
    continue;
  }
  const ids = (man.steps || []).map((s) => String(s.id || ""));
  ok(ids.length === p.steps, rel + " 步骤数 = " + p.steps + "（实得 " + ids.length + "）");
  ok(ids.every((id) => /^[A-Za-z0-9_.-]{1,48}$/.test(id)), rel + " 每个 id 都是协议合法形状");
  ok(new Set(ids).size === ids.length, rel + " 无重复 id");
  ok(
    (man.steps || []).every((s) => String(s.title || "").trim().length > 0),
    rel + " 每步都有标题（窗里显示的就是它）",
  );
  /* 脚本里真的会打这些 id：安装脚本 + 它的进度门槛表都要能对上 */
  const script = read(p.pack + "/scripts/install.ps1");
  const missingInScript = ids.filter((id) => script.indexOf('"' + id + '"') < 0);
  ok(
    missingInScript.length === 0,
    rel + " 的步骤 id 都在 install.ps1 里出现过" + (missingInScript.length ? "（缺 " + missingInScript.join(",") + "）" : ""),
  );
  ok(script.indexOf("step.ps1") >= 0, p.pack + "/scripts/install.ps1 会 dot-source 协议库");
}

/* ═════════════ [3] 解析与状态机真跑（plugins/install-steps.js） ═════════════ */
console.log("\n[3] plugins/install-steps.js 真跑：解析 / 状态机 / 失败定位");
const steps = require(path.join(ROOT, "plugins/install-steps.js"));
ok(steps.STEP_PROTOCOL === 1, "协议版本常量 = 1");
ok(
  steps.parseStepLine('{"mtnodeStep":1,"id":"venv","status":"run","pct":10}') &&
    steps.parseStepLine('{"mtnodeStep":1,"id":"venv","status":"run","pct":10}').step.id === "venv",
  "认得出合法步骤行",
);
ok(steps.parseStepLine('{"foo":1}') === null, "别家的 JSON 日志不当步骤行");
ok(steps.parseStepLine('{"mtnodeStep":2,"id":"venv","status":"run"}') === null, "协议版本不符不认");
ok(steps.parseStepLine('{"mtnodeStep":1,"id":"bad id","status":"run"}') === null, "非法 id 不认");
ok(steps.parseStepLine('{"mtnodeStep":1,"id":"venv","status":"nope"}') === null, "非法状态不认");
ok(steps.parseStepLine("普通日志一行") === null, "普通日志行返回 null（宿主当日志处理）");

const man = steps.normManifest({ steps: [{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "a", title: "dup" }] });
ok(man.steps.length === 2, "清单去重（同 id 只留一条）");
const snap = steps.createSnapshot({ id: "x-local", name: "X", skillName: "x-install", steps: man.steps });
ok(snap.state === "idle", "新会话状态 = idle（窗开了但还没开跑，不假装「安装中」）");
ok(snap.steps.length === 2 && snap.steps[0].status === "pending", "开窗即列全表，未跑到的都是待执行");
steps.applyStep(snap, { id: "a", status: "run", pct: 10 });
ok(snap.state === "running" && snap.steps[0].status === "run", "第一条 run 把会话推进到 running");
steps.pushLog(snap, "a", "日志一行");
ok((snap.logs.a || "").indexOf("日志一行") >= 0, "日志按当前步骤归档");
steps.applyStep(snap, { id: "a", status: "ok", pct: 50 });
ok(snap.steps[0].status === "ok" && snap.pct === 50, "ok 落到该步并推进整体百分比");
steps.applyStep(snap, { id: "b", status: "fail", message: "下载失败" });
ok(snap.state === "failed" && snap.steps[1].status === "fail", "失败步把整个会话判失败（停在这一步）");
ok(snap.error === "下载失败", "失败原因留给窗显示");
steps.applyStep(snap, { id: "zz", status: "run", pct: 60 });
ok(snap.steps.length === 3 && snap.steps[2].id === "zz", "清单里没有的步骤照样累积（脚本比清单可信）");
const snap2 = steps.createSnapshot({ steps: man.steps });
steps.applyStep(snap2, { id: "a", status: "run" });
steps.applyStep(snap2, { id: "a", status: "fail", message: "炸了" });
steps.finishSnapshot(snap2, { ok: false, error: "炸了" });
ok(snap2.state === "failed" && snap2.steps[1].status === "pending", "失败收尾：后面的步骤保持 pending（看清死在哪一步）");
const snap3 = steps.createSnapshot({ steps: man.steps });
steps.applyStep(snap3, { id: "a", status: "run" });
steps.finishSnapshot(snap3, { ok: true });
ok(snap3.state === "done" && snap3.pct === 100 && snap3.steps[1].status === "skip", "成功收尾：没跑到的步标「已跳过」");
ok(steps.tailLines("1\n2\n3\n4", 2) === "3\n4", "日志尾部截取");

/* ═════════════ [4] 协议端到端真跑（PowerShell → Node 解析） ═════════════ */
console.log("\n[4] 协议端到端：真 PowerShell 打步骤行 → Node 解析成步骤状态");
if (process.platform === "win32") {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-step-"));
  try {
    fs.copyFileSync(path.join(ROOT, "pack-steps/step.ps1"), path.join(tmp, "step.ps1"));
    fs.writeFileSync(
      path.join(tmp, "emit.ps1"),
      [
        '. (Join-Path $PSScriptRoot "step.ps1")',
        'Step-Begin "venv" "创建虚拟环境" 10',
        'Write-Host "一行普通日志"',
        'Step-Ok "venv" 20',
        'Step-Begin "weights" "下载权重" 40',
        'Step-Fail "weights" "权重下载失败：网络不通"',
      ].join("\r\n"),
      "utf8",
    );
    const r = cp.spawnSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(tmp, "emit.ps1")],
      { encoding: "utf8" },
    );
    const lines = String(r.stdout || "").split(/\r?\n/);
    const e2e = steps.createSnapshot({ steps: [{ id: "venv", title: "创建虚拟环境" }, { id: "weights", title: "下载权重" }] });
    let stepLines = 0;
    let logLines = 0;
    for (const line of lines) {
      const parsed = steps.parseStepLine(line);
      if (parsed) {
        stepLines++;
        steps.applyStep(e2e, parsed.step);
      } else if (line.trim()) {
        logLines++;
        steps.pushLog(e2e, steps.currentStepId(e2e), line);
      }
    }
    ok(stepLines === 4, "PowerShell 打出 4 条步骤行（实得 " + stepLines + "）");
    ok(logLines === 1, "普通日志行被当日志（实得 " + logLines + "）");
    ok(e2e.state === "failed", "端到端结论 = 失败");
    ok(e2e.steps[0].status === "ok" && e2e.steps[1].status === "fail", "端到端停在第 2 步（下载权重）");
    ok((e2e.logs.venv || "").indexOf("一行普通日志") >= 0, "日志落在当时正在跑的那一步上");
    ok(e2e.error.indexOf("网络不通") >= 0, "失败原因带出来（窗里就显示这句）");
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  }
} else {
  console.log("  skip  windows-only：协议端到端要 PowerShell");
}

/* ═════════════ [5] 主进程编排模块 ═════════════ */
console.log("\n[5] plugins/main-install.js：编排 / 广播 / 会话交接 / 白名单透传");
const hostSrc = read("plugins/main-install.js");
has(hostSrc, "function registerInstallTarget", "有宿主登记口（每个插件登记自己的步骤表 / 目录 / 取消口）");
has(hostSrc, "function beginPluginInstall", "有「开一次安装会话」（开窗即列全表）");
has(hostSrc, "function reportPluginStep", "有步骤 / 日志上报口（宿主调它）");
has(hostSrc, "function finishPluginInstall", "有终局口（成功 / 失败都报）");
has(hostSrc, "function requestSessionFix", "有「交给 mtnode 会话修复」（推主窗口新建可见会话）");
has(hostSrc, "mtnodeInstall:session", "会话交接走 mtnodeInstall:session 事件");
has(hostSrc, "mtnodeInstall:openConsole", "「打开插件控制台」走 mtnodeInstall:openConsole 事件");
has(hostSrc, "INSTALL_API_CHANNELS", "安装窗调主进程能力走**白名单**表");
has(hostSrc, "api_not_allowed", "白名单外的接口一律拒绝（安装窗没有任意调用主进程的能力）");
has(hostSrc, 'require("./install-steps.js")', "步骤模型复用 install-steps.js（不在编排里另写状态机）");
has(hostSrc, 'require("./install-weights.js")', "权重指路复用 install-weights.js（不在编排里另写匹配 / 搬运）");
has(hostSrc, "WINDOW_PLUGIN_MANIFEST", "窗口类插件有兜底步骤表（它们没有 steps.json）");
has(hostSrc, "PET_MANIFEST", "桌宠有兜底步骤表");
has(hostSrc, "function notifyMainFinished", "终局给主窗口一条 mtnodeInstall:finished（卡片据此重画；卡片上已无进度事件可听）");
has(hostSrc, '"mtnodeInstall:finished"', "终局广播走 mtnodeInstall:finished 通道");
hasnt(hostSrc, "fs.writeFileSync", "本模块不落盘（日志只在窗内内存里）");

/* ═════════════ [6] 安装窗页面 ═════════════ */
console.log("\n[6] 安装窗页面 install/：步骤表 + 逐步日志 + 失败三颗动作");
ok(exists("install/index.html"), "install/index.html 存在");
ok(exists("install/app.js"), "install/app.js 存在");
ok(exists("install/style.css"), "install/style.css 存在");
ok(exists("plugins/install-preload.js"), "plugins/install-preload.js 存在（窗的能力桥）");
const pageSrc = read("install/index.html");
has(pageSrc, 'id="insList"', "窗里有步骤表容器");
has(pageSrc, 'id="insLog"', "窗里有日志区");
has(pageSrc, 'id="insActions"', "窗里有动作区");
hasnt(pageSrc, "当前没有正在跑的安装", "空态块整块已删（没会话时主区域留空，不留占位文案）");
hasnt(pageSrc, "ins-empty", "空态样式类也不在页面上（页面 / 注释里都不留旧名字）");
const pageJs = read("install/app.js");
has(pageJs, "STATUS_ICON", "步骤状态有图标口径（✓ / ◐ / ✕ / —）");
/* 本轮需求：失败后**手动重试**是第一位，会话修复退居次要 */
has(pageJs, 'T("重试", "Retry")', "失败时给「重试」（重跑安装脚本，已完成的步骤脚本自己跳过 / 续传）");
has(pageJs, 'T("交给 mtnode 会话修复"', "失败时仍保留「交给 mtnode 会话修复」作次要入口");
has(pageJs, 'T("打开插件控制台"', "失败时给「打开插件控制台」");
has(pageJs, "copyLog", "失败时给「复制日志」");
/* 本轮需求：日志区默认「全部日志」（按真实输出顺序）+ 失败时只给末尾 240 行；
   「复制日志」走 navigator → 主进程桥 → execCommand 三级兜底，只有真写成功才说成功 */
has(pageJs, "全部日志", "日志区第一行是「全部日志」（默认视图）");
has(pageJs, "allLogText", "「全部日志」按真实输出顺序合成（不是按步各自拼接）");
has(pageJs, "ALL_VIEW_TAIL_LINES = 240", "失败态只给末尾 240 行（脚本崩溃那一段默认摆在眼前）");
has(pageJs, "clipboardWrite", "复制走三级兜底链（不是只写 navigator.clipboard）");
has(pageJs, 'api.api("clipboardWriteText"', "兜底链里有主进程写剪贴板那一级（走既有白名单通道）");
has(pageJs, 'document.execCommand("copy")', "最后一级是 execCommand 兜底");
has(pageJs, "已全选日志，请按 Ctrl+C", "三级全挂时如实降级（全选日志，请按 Ctrl+C），不只丢一句「复制失败」");
hasnt(pageJs, 'T("复制失败", "copy failed")', "不再凭 catch 猜「复制失败」（必须带可执行动作）");
const hostInstSrc = read("plugins/main-install.js");
has(
  hostInstSrc,
  'clipboardWriteText: "clipboard:writeText"',
  "clipboardWriteText 进 INSTALL_API_CHANNELS 白名单（不新开 IPC 面，复用主窗口既有的写剪贴板桥）",
);
has(pageJs, "logSeq", "日志按全局序号排「全部」视图（分桶只负责归属哪一步）");
has(hostInstSrc, "seq: (pushed && pushed.seq) || 0", "日志事件带上全局序号（窗据此还原真实输出顺序）");
hasnt(pageJs, 'T("重试这一步"', "不给「重试这一步」（脚本是一条进程，只能整轮续跑）");
hasnt(pageJs, 'T("换一个安装目录"', "不给「换一个安装目录」（改目录走「选择安装目录」，措辞与卡片一致）");
has(pageJs, 'T("选择安装目录"', "安装目录改由本窗选（控制台窗不再显示安装目录）");
has(pageJs, "installApiOf(id).pick", "「选择安装目录」按插件取对应的 PickInstallDir 桥");
has(pageJs, "runInstall", "窗内有「开始安装」入口（安装由用户在窗里发起）");
/* 权重指路：常驻入口 + 目标 / 源 / 预览 / 进度 / 结果 */
has(pageJs, "function renderWeights(", "窗里有权重指路区块的绘制");
has(pageJs, 'weights({ action: "pick"', "「添加目录…」走 mtnodeInstall:weights 的 pick");
has(pageJs, 'weightsAction("scan")', "「扫描并预览」只看不搬");
has(pageJs, 'weightsAction("move")', "「移动并就位」才真搬");
has(pageJs, 'weights({ action: "cancel"', "搬运可取消（已搬完的不回搬）");
has(pageJs, "onWeights(", "订阅搬运进度与终局");
has(pageJs, "权重已就位", "搬完提示「权重已就位 —— 点重试继续」（不自动开跑）");
has(pageJs, "api.weights({ action: \"info\"", "换插件时重拉权重现场");
/* 硬件门槛逃生阀：原在 sensenova 控制台窗里的「忽略硬件门槛」搬到这里（能力不丢） */
has(pageJs, 'FORCE_HW_IDS = ["sensenova-local"]', "硬件门槛逃生阀只对带这道门槛的插件显示");
has(pageJs, "forceHardware: true", "勾选后透传 forceHardware（不勾完全按脚本门槛走）");
has(pageSrc, 'id="insForceHw"', "窗页面有「忽略硬件门槛」开关");
/* 窗口插件的桥收的是插件 id 字符串（appPlugins:install(id)），传选项对象会变成 bad_id ——
   安装窗必须按桥的签名分派（这条曾经真错过：窗口插件在安装窗里点「开始安装」直接失败）。 */
has(pageJs, 'm.install === "appPluginsInstall"', "窗口插件的桥按 id 字符串调用（不混传选项对象）");
has(pageJs, "String(id)", "窗口插件那条走 String(id)（与 appPlugins:install 的签名对齐）");
const weightsPreload = read("plugins/install-preload.js");
has(weightsPreload, "weights: (payload)", "窗桥暴露 mtnodeInstall:weights");
has(weightsPreload, "onWeights:", "窗桥暴露搬运事件订阅");
has(pageSrc, 'id="insWeights"', "窗页面有权重指路区块");
has(pageSrc, 'id="insWMove"', "区块里有「移动并就位」");
has(pageSrc, 'id="insWSources"', "区块里列已指定的源目录");
const preloadWin = read("plugins/install-preload.js");
has(preloadWin, "contextBridge.exposeInMainWorld", "窗桥走 contextBridge 白名单");
has(preloadWin, "onState", "窗订阅状态帧");
has(preloadWin, "onEvent", "窗订阅事件流（步骤 / 日志 / 终局）");

/* ═════════════ [6b] 卸载（本轮需求：安装界面增加卸载功能） ═════════════ */
console.log("\n[6b] 安装窗的「卸载」：预览清单 → 确认 → 先停后端再删目录");
has(hostInstSrc, "mtnodeInstall:uninstall", "主进程有卸载通道 mtnodeInstall:uninstall（安装窗唯一入口）");
has(hostInstSrc, "function uninstallPreviewFor(", "有卸载预览（这一趟删什么 / 留什么，只看不动盘）");
has(hostInstSrc, "function startUninstall(", "有真删口 startUninstall（异步跑，进度推给窗）");
has(hostInstSrc, "UNINSTALL_SPECS", "卸载路由表在主进程（窗只说「卸载这个插件」，删除范围不由窗决定）");
has(hostInstSrc, "function uninstallGuard(", "有卸载安全守卫");
has(hostInstSrc, "mod.rejectReason(n)", "守卫不吃用户给的路径：走 plugin-root 的 rejectReason（盘根 / 应用目录 / 数据目录一律拒）");
has(hostInstSrc, "refuse_plugin_root", "安装目录 = 插件根目录本身时拒绝（不删整根）");
has(hostInstSrc, 'error: "not_installed"', "目录不存在时如实回 not_installed（不装作删过）");
has(hostInstSrc, 'error: "busy"', "同时只允许一次卸载（再来一次回 busy）");
has(hostInstSrc, "if (spec.stop) {", "通用卸载先停后端（DLL / EXE 被占用时删不掉）");
has(hostInstSrc, 'invokeChannelFor(spec.custom.preview', "自定义卸载口的插件（Music3 / H3）先问它自己的预览");
has(hostInstSrc, 'invokeChannelFor(spec.custom.run', "自定义卸载口的插件交给它自己删（output 保留口径由它决定）");
has(hostInstSrc, '"pet:uninstall"', "桌宠走它自己的卸载口（自启登记一并撤）");
has(hostInstSrc, "maxRetries: 3", "删除用 fs.rmSync(force + maxRetries)（Windows 上占用的文件有重试机会）");
hasnt(hostInstSrc, "fs.rmSync(dir, { recursive: true, force: true });", "不裸删：目录删除一律带 maxRetries");
has(hostInstSrc, 'snap.mode = "uninstall"', "beginPluginInstall 给卸载那一次打 mode=uninstall（窗据此认出这是卸载）");
has(hostInstSrc, "UNINSTALL_STEPS", "卸载有自己的兜底步骤表（自定义路由的插件也有一行「卸载并清理文件」）");
has(preloadWin, "uninstall: (payload)", "窗桥暴露 mtnodeInstall:uninstall");
has(pageJs, "function isUninstall(", "窗认得出「这是卸载那一次」");
has(pageJs, 'api.uninstall({ action: "preview"', "点「卸载」先拉预览清单（确认前不动盘）");
has(pageJs, 'api.uninstall({ action: "run"', "点「确认卸载」才真删");
has(pageJs, 'api.uninstall({ action: "cancel"', "卸载中可停手（已删掉的不恢复）");
has(pageJs, "function renderUninstall(", "窗画卸载确认清单（删什么 / 留什么）");
has(pageJs, 'T("确认卸载", "Uninstall now")', "破坏性动作要显式确认（不是点一下就走）");
has(pageJs, 'T("保留：", "kept: ")', "清单里写明保留什么（别让用户以为卸载 = 全清）");
has(pageSrc, 'id="insUnin"', "窗页面有卸载确认块");
has(pageSrc, 'id="insUninList"', "确认块里有清单容器");
has(pageJs, 'T("卸载", "Uninstall")', "底栏有「卸载」按钮");
has(pageJs, "uninRunning", "卸载进行中置灰（避免连点两次）");

/* ═════════════ [7] 宿主接线：登记 + 上报 + 入口先开窗 ═════════════ */
console.log("\n[7] 7 个后端宿主：登记安装窗 / 上报步骤 / 安装入口先开会话");
for (const p of PACKS) {
  const src = read(p.host);
  has(src, 'require("../plugins/main-install.js")', p.host + " require 安装窗编排模块");
  has(src, 'require("../plugins/install-step-reporter.js")', p.host + " require 步骤上报器");
  has(src, "installHost.registerInstallTarget({", p.host + " 登记安装目标");
  has(src, 'id: PLUGIN_ID', p.host + " 登记用 PLUGIN_ID（与卡片 / 报错总线同源 id）");
  ok(src.indexOf('packRoots: [bundledPackRoot()]') >= 0, p.host + " 把包根交给安装窗（用来读 steps.json）");
  has(src, "onEvent: (ev) => installHost.reportPluginStep(ev)", p.host + " 把脚本步骤行转给安装窗");
  has(src, "installHost.beginPluginInstall(", p.host + " 安装入口先开安装窗的会话");
  has(src, "installHost.finishPluginInstall(", p.host + " 安装终局报给安装窗");
  has(src, "cancel: async () => {", p.host + " 登记取消口（安装窗「取消安装」走它）");
  has(src, 'require("../plugins/install-cancel.js")', p.host + " 接中断核心（install-cancel.js）");
  /* 取消必须真的杀进程树：只置标志的写法（installCancel = true; return { ok: true }）已修掉 ——
     那个标志只在脚本自己退出后才被 close 回调读到，下载期间点取消等于没点（真进程证据见
     test/smoke-install-cancel.js）。 */
  has(src, "installKill.cancelInstall(PLUGIN_ID)", p.host + " 取消口真的按进程树强杀（不是只置标志）");
  has(src, "installKill.track(PLUGIN_ID, child)", p.host + " 安装脚本一生出来就登记进取消表");
  ok(
    !/cancel: async \(\) => \{\s*\n\s*installCancel = true;\s*\n\s*return \{ ok: true \};/.test(src),
    p.host + " 取消口已不含「只置标志」的旧写法",
  );
  ok(
    src.indexOf('"' + p.id + '"') >= 0 || src.indexOf("Yue2 local") >= 0 || src.indexOf("PACK_ID") >= 0,
    p.host + " 里能查到安装窗 id " + p.id + "（PLUGIN_ID / 清单常量）",
  );
  if (p.skill) {
    ok(src.indexOf('"' + p.skill + '"') >= 0, p.host + " 登记了修复技能 " + p.skill);
  }
}

/* ═════════════ [8] 失败处置：脚本失败不再静默转 Agent 兜底 ═════════════ */
console.log("\n[8] 脚本失败一律停在安装窗的失败步（不再静默转 Agent）");
let failStepHosts = 0;
for (const p of PACKS) {
  const src = read(p.host);
  /* 安装入口的函数体（installProject[Inner] / installScriptBody）里不许再有兜底调用 */
  const body = [fnBody(src, "installProject"), fnBody(src, "installProjectInner"), fnBody(src, "installScriptBody")].join("\n");
  ok(body.length > 200, p.host + " 能取到安装入口的函数体（断言没空转）");
  ok(
    !/agentRecoverInstall\(/.test(body),
    p.host + " 的安装入口里没有 agentRecoverInstall 调用（兜底链已删）",
  );
  ok(
    /installHost\.finishPluginInstall\(\{[\s\S]{0,600}?ok: false/.test(src),
    p.host + " 失败时如实报 ok:false 给安装窗",
  );
  if (src.indexOf("installHost.failStep(") >= 0) failStepHosts++;
}
/* 「不再静默兜底」这句口径注释：本轮改到安装链的三个宿主（llama / breeze / remotion）
   都写在 catch 里；h3 / music3 / yue 的说明写在 install.ps1 的编排注释里。 */
for (const rel of ["llama/main-llama.js", "breeze/main-breeze.js", "remotion/main-remotion.js"]) {
  const src = read(rel);
  ok(
    src.indexOf("不再自动转 Agent 兜底") >= 0 || src.indexOf("不再自动重跑 / 静默兜底") >= 0,
    rel + " 写明「脚本失败不再静默兜底」（口径落在代码里）",
  );
}
for (const rel of ["h3-pack/scripts/install.ps1", "music3-pack/scripts/install.ps1", "yue-pack/scripts/install.ps1"]) {
  const src = read(rel);
  /* 口径：脚本里要写明「步骤 id 与同包 steps.json 同源，改脚本不忘改清单」。
     中英任一句式都算 —— 已迁到 ASCII 英文的脚本（yue）与仍带中文注释的脚本（h3 / music3）
     都能表达同一件事，别把语言当成契约。 */
  ok(
    /步骤 id|步骤协议|step ids?|steps\.json/i.test(src),
    rel + " 写明步骤 id 与同包 steps.json 同源（改脚本不忘改清单）",
  );
  ok(
    src.indexOf("Step-Begin") >= 0 || src.indexOf("Step-ProgressMap") >= 0,
    rel + " 真的按步骤打步骤行（Step-Begin 或进度门槛映射表）",
  );
}
ok(
  failStepHosts >= 3,
  "有磁盘 / 硬件门槛的宿主把门槛失败直接标成失败步（" + failStepHosts + " 个：h3 / music3 / yue）",
);
ok(
  /installHost\.failStep\(\s*\n?\s*PLUGIN_ID,\s*\n?\s*"disk"/.test(read("h3/main-h3.js")),
  "h3 的磁盘门槛失败停在「disk」这一步（不是飘在会话级错误里）",
);
const repSrc = read("plugin-error-repair.js");
has(
  repSrc,
  "pluginRepair:error",
  "报错总线仍在（控制台手动「自我修复」与插件运行期错误照旧）",
);
hasnt(
  read("plugins/main-app-plugins.js"),
  "installHost.finishPluginInstall({ id, ok: false",
  "窗口插件安装失败也不再额外弹主窗口报错窗（本轮共识：全在安装窗内呈现）→ 该调用已被 installHost 统一收口",
);

/* ═════════════ [9] 窗口插件 + 桌宠也进同一只窗 ═════════════ */
console.log("\n[9] 窗口类插件与桌宠的下载也走同一只窗");
const appPluginsSrc = read("plugins/main-app-plugins.js");
has(appPluginsSrc, 'require("./main-install.js")', "窗口插件宿主 require 安装窗编排");
has(appPluginsSrc, "function reportInstallProgress", "窗口插件的 download/verify/extract 翻成步骤事件");
has(appPluginsSrc, "installHost.beginPluginInstall({ id, action: ctx.phase", "窗口插件安装也开一次会话");
has(appPluginsSrc, 'step("verify"', "sha256 校验是独立一步（失败停在这一步）");
has(appPluginsSrc, 'step("extract"', "解压是独立一步");
const petSrc = read("pet/main-pet.js");
has(petSrc, 'require("../plugins/main-install.js")', "桌宠宿主 require 安装窗编排");
has(petSrc, "installHost.registerInstallTarget({", "桌宠登记安装目标");
has(petSrc, "function petInstallDir()", "桌宠安装目录单一口径（报错总线与安装窗共用）");
has(petSrc, "installHost.beginPluginInstall(", "桌宠安装也开一次会话");
/* 窗口插件与桌宠的安装是主进程自建 HTTP 下载（没有子进程可杀），取消靠 AbortController 掐连接 */
has(appPluginsSrc, "function cancelWindowPluginInstall(", "窗口插件有取消口（掐断下载）");
has(appPluginsSrc, "installHost.registerCancelFallback(", "窗口插件 id 来自云端目录 → 用兜底取消口登记");
has(appPluginsSrc, "throwIfCancelled()", "窗口插件每一步之间都检查「用户已经取消」");
has(appPluginsSrc, 'msg === "cancelled"', "窗口插件把取消落成「已取消」终局（不报安装失败）");
has(petSrc, "function cancelPetInstall(", "桌宠有取消口（掐断形象包下载）");
has(petSrc, "cancel: () => cancelPetInstall()", "桌宠把取消口登记进安装窗");
has(petSrc, "job.cancelled", "桌宠取消后不再回落本机离线包（取消就是停）");
has(read("plugins/install-cancel.js"), "taskkill", "中断核心按进程树强杀（win32 taskkill /T）");
has(read("plugins/install-cancel.js"), '"cmd.exe"', "taskkill 经 cmd.exe 转发（/T 不被当 TTY 开关）");
has(read("plugins/install-steps.js"), 'snap.state = "cancelled"', "状态机新增「已取消」终局（不是失败）");
has(read("plugins/main-install.js"), "registerCancelFallback", "编排层提供兜底取消口登记");
has(read("plugins/main-install.js"), "cancelled: true", "编排层在取消口返回后落取消终局");
has(appPluginsSrc, 'ipcMain.handle("appPlugins:cancelInstall"', "窗口插件有一条显式取消 IPC");
has(read("preload.js"), "appPluginsCancelInstall:", "主窗口 preload 暴露窗口插件取消桥");
const cancelSrc = read("plugins/install-cancel.js");
has(cancelSrc, "function track(pluginId, child)", "中断核心按 pluginId 登记当前安装子进程");
has(cancelSrc, "function cancelInstall(id", "中断核心有统一取消入口（宿主只传 pluginId）");

/* ═════════════ [10] 主窗口接线：入口收口 + 会话交接 ═════════════ */
console.log("\n[10] 主窗口接线：卡片/控制台入口 + 会话交接 + 开控制台");
const preloadMain = read("preload.js");
has(preloadMain, "mtnodeInstallOpen:", "主窗口 preload 暴露安装窗入口");
has(preloadMain, "onMtnodeInstallSession:", "主窗口订阅「请新建修复会话」");
has(preloadMain, "onMtnodeInstallOpenConsole:", "主窗口订阅「请开插件控制台」");
const mainSrc = read("main.js");
has(mainSrc, 'require("./plugins/main-install.js")', "main.js require 安装窗编排");
has(mainSrc, "installHost.initInstallHost({", "main.js 起安装窗编排（与报错总线同一阶段）");
const pluginsUi = read("renderer/app-plugins.js");
has(pluginsUi, "function openPluginInstallWindow(", "渲染层有开安装窗的唯一入口");
has(pluginsUi, "BACKEND_INSTALL_IDS", "后端插件 id → 安装窗 id 的映射表");
has(
  pluginsUi,
  'await openPluginInstallWindow({ id, action: "install", installDir: target.dir })',
  "卡片「安装 / 重装」改为开窗（并把解析好的安装目录带过去）",
);
has(pluginsUi, "function backendSpecById(", "按 id 反查后端 spec（安装窗「打开控制台」用）");
const repairUi = read("renderer/app-repair.js");
has(repairUi, "function pluginInstallFixSession(", "渲染层有「安装失败 → 新建修复会话」");
has(repairUi, "st.workspace = info.installDir;", "修复会话的工作区 = 安装目录");
has(repairUi, "st.canvasFree = true;", "修复会话走「与画布无关」档（省上下文）");
has(repairUi, "function pluginInstallOpenConsole(", "渲染层有「开该插件控制台」");
has(repairUi, "onMtnodeInstallSession", "订阅安装窗的会话交接事件");
has(repairUi, "onMtnodeInstallOpenConsole", "订阅安装窗的开控制台事件");

/* ═════════════ [11] 交付纪律 ═════════════ */
console.log("\n[11] 交付纪律：不落盘 / 数据不出应用目录 / 打包白名单");
const buildJson = read("build.json");
has(buildJson, '"plugins/**"', "plugins/** 在打包 files 里（新模块随包）");
has(buildJson, '"renderer/**"', "renderer/** 在打包 files 里");
ok(
  buildJson.indexOf('"install/**"') >= 0 || exists("install/index.html"),
  "安装窗页面在源码里（打包白名单靠 renderer/plugins 通配 + 安装窗自带的 install/ 目录）",
);
hasnt(read("plugins/main-install.js"), 'join(getDataDir(), "install"', "安装窗不往数据目录写自己的文件");

/* ═════════════ [12] 权重指路：安装窗侧的接线（行为另见 smoke-install-weights.js） ═════════════ */
console.log("\n[12] 权重指路 → 移动就位：主进程 IPC + 目标表接线");
const weightsMod = require(path.join(ROOT, "plugins/install-weights.js"));
const W_IDS = ["minimax-h3", "minimax-music3", "yue2-local", "sensenova-local", "breeze-tts-local"];
for (const id of W_IDS) {
  ok(weightsMod.supports(id) === true, id + " 在权重目标表里");
}
ok(weightsMod.supports("llama-local") === false, "llama 不在表里（GGUF 是运行期在控制台里按需下载的）");
ok(weightsMod.supports("remotion") === false, "remotion 不在表里（没有权重）");
has(hostSrc, 'ipcMain.handle("mtnodeInstall:weights"', "安装窗有一条 mtnodeInstall:weights 通道");
for (const a of ['"pick"', '"remove"', '"scan"', '"move"', '"cancel"', '"reset"']) {
  has(hostSrc, "action === " + a, "weight 通道支持 " + a + " 动作");
}
has(hostSrc, "function weightsStateOf(", "有权重现场快照（目标 / 已选源 / 是否在搬 / 上次结果）");
has(hostSrc, "function startWeightsMove(", "有真搬运入口");
has(hostSrc, "function cancelWeightsMove(", "有取消入口");
has(hostSrc, "function scanWeights(", "有「只看不搬」的扫描入口");
has(hostSrc, "weightsSel", "已选源目录按插件记在内存（不落盘）");
has(hostSrc, "weightsLast", "上次搬运结果留着（关窗重开仍看得到结论）");
has(read("plugins/install-weights.js"), "覆盖", "同名冲突口径：用源文件覆盖（写进模块注释里）");
has(read("plugins/install-weights.js"), "EXDEV", "跨盘退化为复制 + 删除（rename 优先）");
has(read("plugins/install-weights.js"), "unmatched", "认不出的源内容留在原地并列出");
/* 目标表按 pluginId 查安装目录：id 必须与各宿主 registerInstallTarget 的 id 一致，否则目标推导不出来 */
const W_HOST = {
  "minimax-h3": "h3/main-h3.js",
  "minimax-music3": "music3/main-music3.js",
  "yue2-local": "yue/main-yue.js",
  "sensenova-local": "sensenova/main-sensenova.js",
  "breeze-tts-local": "breeze/main-breeze.js",
};
for (const [id, host] of Object.entries(W_HOST)) {
  const src = read(host);
  has(src, "registerInstallTarget({", host + " 登记安装目标（权重目标靠它取安装目录）");
  has(src, "getInstallDir:", host + " 提供 getInstallDir（目标目录 = 安装目录 + 槽位相对路径）");
  ok(
    src.indexOf(host.split("/")[1].replace("main-", "").replace(".js", "")) >= 0 || src.indexOf('"' + id + '"') >= 0,
    host + " 里能查到安装窗 id " + id + "（与权重目标表的键同源）",
  );
}

/* ═════════════ [13] H3 安装编排干跑：源码已在也照样备环境 ═════════════ */
/* 修的是什么（用户现场）：h3-pack/scripts/install.ps1 上一版只要 ComfyUI\main.py 已存在，
   就把「源码 + 环境」整段跳过（setup_env.ps1 根本没跑），随后 venv 步按「venv python 不存在」
   判失败 —— 于是任何「源码拉下来了、venv 还没建」的断点续装现场都卡在 venv。
   本节用 mock 子脚本真跑一遍编排（不装 H3、不下权重、不碰用户目录），把口径钉住：
     · 源码已在 ⇒ comfy 步不重复拉源码，但 venv 步**仍然**执行完整环境准备；
     · 失败按证据分档 + 失败步带子脚本报错尾部；后面没跑到的步骤标「已跳过」；
     · 成功路径：venv 复检通过之后才允许 nodes 步开始。 */
console.log("\n[13] h3 install.ps1 干跑：main.py 已存在仍执行环境准备 + 失败分档 + 步骤顺序");
const h3InstallSrc = read("h3-pack/scripts/install.ps1");
has(h3InstallSrc, "-SourceOnly", "comfy 步只保证源码（setup_env -SourceOnly），环境准备留给 venv 步");
has(h3InstallSrc, "Skip-AfterStep", "失败时把后面没跑到的步骤显式标 skip");
has(h3InstallSrc, "comfy_kitchen", "venv 步按实测复检（venv python + torch.cuda + comfy_kitchen）");
const invSub = psFnBody(h3InstallSrc, "Invoke-SubScript");
has(invSub, "ForEach-Object", "子脚本输出走管道逐行转发（实时流式，长步骤不再整段沉默）");
hasnt(invSub, "$out = ", "不再先把整段输出收进变量、跑完才打印");
hasnt(invSub, "Invoke-Expression", "不用 Invoke-Expression（转发不重新求值命令行）");
const h3StepsMan = JSON.parse(read("h3-pack/steps.json"));
const H3_STEP_IDS = ["comfy", "venv", "nodes", "weights", "smoke"];

/** 取「function NAME {（或 function NAME( )」形态的函数体（大括号配平） */
function psFnBody(src, name) {
  const at = String(src).indexOf("function " + name);
  if (at < 0) return "";
  const open = String(src).indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  return src.slice(at);
}

/** 把一段安装脚本输出按宿主口径解成（快照, 步骤行序列）；exitCode 走宿主同一条收尾路径 */
function h3Collect(outText, exitCode) {
  const snap = steps.createSnapshot({ steps: steps.normManifest(h3StepsMan).steps });
  const seq = [];
  String(outText)
    .split(/\r?\n/)
    .forEach((line, i) => {
      const parsed = steps.parseStepLine(line);
      if (parsed) {
        seq.push({ id: parsed.step.id, status: parsed.step.status, line: i });
        steps.applyStep(snap, parsed.step);
      } else if (line.trim()) {
        steps.pushLog(snap, steps.currentStepId(snap), line);
      }
    });
  steps.finishSnapshot(snap, { ok: exitCode === 0 });
  return { snap, seq };
}
const h3Step = (snap, id) => (snap.steps || []).find((s) => s.id === id) || {};
const h3SeqAt = (seq, id, status) => {
  const hit = seq.find((e) => e.id === id && e.status === status);
  return hit ? hit.line : -1;
};

/* 干跑编排用的公共件（[13.4] 的异步探针也在模块级用它，所以放这儿） */
const rootScripts = path.join(ROOT, "h3-pack", "scripts");
const PS_RUN = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"];
const writeMock = (file, lines) => fs.writeFileSync(file, lines.join("\r\n") + "\r\n", "utf8");
const runInstall = (dir) =>
  cp.spawnSync(
    "powershell.exe",
    [...PS_RUN, path.join(dir, "scripts", "install.ps1"), "-InstallDir", dir, "-DiskHintGb", "0"],
    { encoding: "utf8" },
  );

if (process.platform !== "win32") {
  console.log("  skip  windows-only：编排干跑要 PowerShell");
} else {

  /* ── [13.1] 失败路径：源码已在、venv 没建起来 ── */
  const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-h3-a-"));
  try {
    fs.mkdirSync(path.join(tmpA, "scripts"), { recursive: true });
    for (const n of ["install.ps1", "step.ps1"]) fs.copyFileSync(path.join(rootScripts, n), path.join(tmpA, "scripts", n));
    fs.mkdirSync(path.join(tmpA, "ComfyUI"), { recursive: true });
    fs.writeFileSync(path.join(tmpA, "ComfyUI", "main.py"), "# mock ComfyUI\n", "utf8");
    writeMock(path.join(tmpA, "scripts", "setup_env.ps1"), [
      'param([string]$CudaPython = "", [switch]$SourceOnly)',
      "$log = Join-Path (Split-Path -Parent $PSScriptRoot) 'setup_env.calls.log'",
      "Add-Content -Path $log -Value ('sourceOnly=' + [bool]$SourceOnly)",
      "Write-Host '[h3-setup] mock: full env prep'",
      "Write-Host 'ERROR: Could not find a version that satisfies the requirement torch==2.9.1+cu130'",
      "exit 0",
    ]);
    writeMock(path.join(tmpA, "scripts", "download_models.ps1"), ["Write-Host '[h3-download] mock'", "exit 0"]);
    const rA = runInstall(tmpA);
    const outA = String(rA.stdout || "");
    const { snap: snapA, seq: seqA } = h3Collect(outA, rA.status);
    const callLogA = fs.existsSync(path.join(tmpA, "setup_env.calls.log"))
      ? fs.readFileSync(path.join(tmpA, "setup_env.calls.log"), "utf8").trim().split(/\r?\n/)
      : [];
    ok(rA.status !== 0, "venv 建不起来时脚本以非 0 退出（实得 " + rA.status + "）");
    ok(callLogA.length >= 1, "ComfyUI\\main.py 已存在，环境准备**仍然**被执行（旧版这里一次都不跑）");
    ok(callLogA.indexOf("sourceOnly=False") >= 0, "venv 步跑的是完整环境准备（sourceOnly=False）");
    ok(callLogA.indexOf("sourceOnly=True") < 0, "源码已在时 comfy 步不重复调 setup_env（不做无用功）");
    ok(h3Step(snapA, "comfy").status === "ok", "comfy 步照旧判 ok（源码已在）");
    const venvA = h3Step(snapA, "venv");
    ok(venvA.status === "fail", "停在 venv 步（实得 " + venvA.status + "）");
    ok(String(venvA.message || "").indexOf("报错尾部") >= 0, "失败原因按证据分档并附报错尾部");
    ok(String(venvA.message || "").indexOf("torch==2.9.1+cu130") >= 0, "报错尾部带的是子脚本里的真实报错行（不是「驱动与 CUDA 档位不匹配」那句套话）");
    for (const id of ["nodes", "weights", "smoke"]) {
      ok(h3Step(snapA, id).status === "skip", id + " 步标「已跳过」（不是在「待执行」上吊着）");
    }
    ok(String((snapA.logs || {}).venv || "").indexOf("mock: full env prep") >= 0, "环境准备的输出逐行进安装窗日志（归到 venv 步）");
    ok(snapA.state === "failed", "整场会话结论 = 失败");
  } finally {
    try {
      fs.rmSync(tmpA, { recursive: true, force: true });
    } catch {}
  }

  /* ── [13.2] 成功路径：源码缺 → 先拉源码，再备环境，venv 复检过了才开 nodes ── */
  const pyOk = cp.spawnSync("python", ["-c", "import sys;print(sys.version_info[0])"], { encoding: "utf8" });
  if (!pyOk || pyOk.status !== 0 || String(pyOk.stdout || "").trim() !== "3") {
    console.log("  skip  [13.2]/[13.3] 本机没有可用的 python：成功路径与两条分档干跑跳过（失败路径已覆盖根因）");
  } else {
    const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-h3-b-"));
    try {
      fs.mkdirSync(path.join(tmpB, "scripts"), { recursive: true });
      for (const n of ["install.ps1", "step.ps1"]) fs.copyFileSync(path.join(rootScripts, n), path.join(tmpB, "scripts", n));
      writeMock(path.join(tmpB, "scripts", "setup_env.ps1"), [
        'param([string]$CudaPython = "", [switch]$SourceOnly)',
        "$root = Split-Path -Parent $PSScriptRoot",
        "$log = Join-Path $root 'setup_env.calls.log'",
        "Add-Content -Path $log -Value ('sourceOnly=' + [bool]$SourceOnly)",
        "$comfy = Join-Path $root 'ComfyUI'",
        "if ($SourceOnly) {",
        "  New-Item -ItemType Directory -Force -Path $comfy | Out-Null",
        "  Set-Content -Path (Join-Path $comfy 'main.py') -Value '# mock ComfyUI'",
        "  Write-Host '[h3-setup] mock: source-only'",
        "  exit 0",
        "}",
        "$venv = Join-Path $comfy 'venv'",
        "& python -m venv --without-pip $venv | Out-Null",
        "$sp = Join-Path $venv 'Lib\\site-packages'",
        "New-Item -ItemType Directory -Force -Path $sp | Out-Null",
        "Set-Content -Path (Join-Path $sp 'torch.py') -Value @('class _Cuda:', '    @staticmethod', '    def is_available(): return True', 'cuda = _Cuda()', \"__version__ = '2.9.1+cu130'\")",
        "Set-Content -Path (Join-Path $sp 'comfy_kitchen.py') -Value '# stub'",
        "New-Item -ItemType Directory -Force -Path (Join-Path $comfy 'custom_nodes\\ComfyUI-KJNodes') | Out-Null",
        "Write-Host '[h3-setup] mock: full env prep done'",
        "exit 0",
      ]);
      writeMock(path.join(tmpB, "scripts", "download_models.ps1"), [
        "$root = Split-Path -Parent $PSScriptRoot",
        "foreach ($d in @('diffusion_models', 'text_encoders', 'vae')) { New-Item -ItemType Directory -Force -Path (Join-Path $root \"ComfyUI\\models\\$d\") | Out-Null }",
        "Write-Host '[h3-download] mock'",
        "exit 0",
      ]);
      const rB = runInstall(tmpB);
      const { snap: snapB, seq: seqB } = h3Collect(String(rB.stdout || ""), rB.status);
      const callLogB = fs.existsSync(path.join(tmpB, "setup_env.calls.log"))
        ? fs.readFileSync(path.join(tmpB, "setup_env.calls.log"), "utf8").trim().split(/\r?\n/)
        : [];
      ok(rB.status === 0, "环境齐备时脚本以 0 退出（实得 " + rB.status + "；stderr=" + String(rB.stderr || "").slice(-200) + "）");
      ok(fs.existsSync(path.join(tmpB, ".install-ok")), "收尾写出 .install-ok");
      ok(callLogB.indexOf("sourceOnly=True") >= 0, "源码缺时 comfy 步用 -SourceOnly 只拉源码");
      ok(callLogB.indexOf("sourceOnly=False") >= 0, "venv 步无条件再跑一次完整环境准备（幂等补齐）");
      ok(
        H3_STEP_IDS.every((id) => h3Step(snapB, id).status === "ok") && h3Step(snapB, "disk").status === "ok",
        "六步全 ok（" + snapB.steps.map((s) => s.id + ":" + s.status).join(" ") + "）",
      );
      const iVenvOk = h3SeqAt(seqB, "venv", "ok");
      const iNodesRun = h3SeqAt(seqB, "nodes", "run");
      ok(iVenvOk >= 0 && iNodesRun > iVenvOk, "nodes 步在 venv 复检通过之后才开始（顺序：" + iVenvOk + " → " + iNodesRun + "）");
      ok(seqB.filter((e) => e.status === "skip").length === 0, "成功路径不产生任何 skip 行");
      ok(snapB.state === "done" && snapB.pct === 100, "成功收尾：state=done / pct=100");
    } finally {
      try {
        fs.rmSync(tmpB, { recursive: true, force: true });
      } catch {}
    }

    /* ── [13.3] 失败分档：venv 在但 cuda 不可用 / comfy_kitchen 导入失败各给各的原因 ── */
    const tmpC = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-h3-c-"));
    try {
      fs.mkdirSync(path.join(tmpC, "scripts"), { recursive: true });
      for (const n of ["install.ps1", "step.ps1"]) fs.copyFileSync(path.join(rootScripts, n), path.join(tmpC, "scripts", n));
      fs.mkdirSync(path.join(tmpC, "ComfyUI"), { recursive: true });
      fs.writeFileSync(path.join(tmpC, "ComfyUI", "main.py"), "# mock ComfyUI\n", "utf8");
      writeMock(path.join(tmpC, "scripts", "setup_env.ps1"), [
        "$log = Join-Path (Split-Path -Parent $PSScriptRoot) 'setup_env.calls.log'",
        "Add-Content -Path $log -Value 'called'",
        "Write-Host '[h3-setup] mock: venv already in place'",
        "exit 0",
      ]);
      writeMock(path.join(tmpC, "scripts", "download_models.ps1"), ["Write-Host '[h3-download] mock'", "exit 0"]);
      const venvDir = path.join(tmpC, "ComfyUI", "venv");
      const vr = cp.spawnSync("python", ["-m", "venv", "--without-pip", venvDir], { encoding: "utf8" });
      ok(vr.status === 0, "[13.3] 现场：真建一只 venv 用于两条分档（python -m venv --without-pip）");
      const sitePkgs = path.join(venvDir, "Lib", "site-packages");
      fs.mkdirSync(sitePkgs, { recursive: true });
      const torchStub = (cuda) => [
        "class _Cuda:",
        "    @staticmethod",
        "    def is_available(): return " + (cuda ? "True" : "False"),
        "cuda = _Cuda()",
        "__version__ = '2.9.1+cu130'",
        "",
      ].join("\n");
      fs.writeFileSync(path.join(sitePkgs, "comfy_kitchen.py"), "# stub\n", "utf8");

      /* ① venv 在、torch 在，但 cuda 不可用 */
      fs.writeFileSync(path.join(sitePkgs, "torch.py"), torchStub(false), "utf8");
      const rC1 = runInstall(tmpC);
      const c1 = h3Collect(String(rC1.stdout || ""), rC1.status);
      const msgC1 = String(h3Step(c1.snap, "venv").message || "");
      ok(h3Step(c1.snap, "venv").status === "fail", "[13.3①] cuda 不可用 ⇒ 停在 venv 步");
      ok(msgC1.indexOf("torch.cuda.is_available()") >= 0 && msgC1.indexOf("CPU 版 torch") >= 0, "[13.3①] 原因是「CPU 版 torch / 驱动档位」，不是「venv 没建起来」");
      ok(msgC1.indexOf("仍不存在") < 0, "[13.3①] 不再把这类失败误报成「venv 没建起来」");
      ok(msgC1.indexOf("nocuda") >= 0, "[13.3①] 失败步带上探针的真实输出（nocuda）");
      ok(h3Step(c1.snap, "nodes").status === "skip", "[13.3①] 后续步骤照旧标「已跳过」");

      /* ② torch 可用、comfy_kitchen 缺失 */
      fs.writeFileSync(path.join(sitePkgs, "torch.py"), torchStub(true), "utf8");
      fs.rmSync(path.join(sitePkgs, "comfy_kitchen.py"), { force: true });
      const rC2 = runInstall(tmpC);
      const c2 = h3Collect(String(rC2.stdout || ""), rC2.status);
      const msgC2 = String(h3Step(c2.snap, "venv").message || "");
      ok(h3Step(c2.snap, "venv").status === "fail", "[13.3②] comfy_kitchen 缺失 ⇒ 停在 venv 步");
      ok(msgC2.indexOf("comfy_kitchen") >= 0 && msgC2.indexOf("ComfyUI 依赖没装全") >= 0, "[13.3②] 原因指向 comfy_kitchen / ComfyUI 依赖，与 cuda 那条分开");
      ok(msgC2.indexOf("No module named") >= 0, "[13.3②] 失败步带上探针的真实报错行");
    } finally {
      try {
        fs.rmSync(tmpC, { recursive: true, force: true });
      } catch {}
    }
  }
}

/* ── [13.4] 实时流式：子脚本还在跑，它的输出就已经到安装窗了 ──
   整只冒烟里唯一的异步断言（要观察「输出在子脚本结束前就到了」），所以收尾汇总交给它调用 finish()。 */
async function h3StreamingProbe() {
  const tmpS = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-h3-s-"));
  try {
    fs.mkdirSync(path.join(tmpS, "scripts"), { recursive: true });
    for (const n of ["install.ps1", "step.ps1"]) fs.copyFileSync(path.join(rootScripts, n), path.join(tmpS, "scripts", n));
    fs.mkdirSync(path.join(tmpS, "ComfyUI"), { recursive: true });
    fs.writeFileSync(path.join(tmpS, "ComfyUI", "main.py"), "# mock ComfyUI\n", "utf8");
    writeMock(path.join(tmpS, "scripts", "setup_env.ps1"), [
      "Write-Host '[h3-setup] mock: first line'",
      "Start-Sleep -Seconds 4",
      "Write-Host '[h3-setup] mock: last line'",
      "exit 0",
    ]);
    writeMock(path.join(tmpS, "scripts", "download_models.ps1"), ["exit 0"]);
    const t0 = Date.now();
    const at = { first: 0, close: 0 };
    const child = cp.spawn(
      "powershell.exe",
      [...PS_RUN, path.join(tmpS, "scripts", "install.ps1"), "-InstallDir", tmpS, "-DiskHintGb", "0"],
      { windowsHide: true },
    );
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += String(d);
      if (!at.first && buf.indexOf("mock: first line") >= 0) at.first = Date.now() - t0;
    });
    const done = new Promise((res) => child.on("close", () => { at.close = Date.now() - t0; res(); }));
    const guard = new Promise((res) => setTimeout(res, 60000));
    await Promise.race([done, guard]);
    ok(at.first > 0, "[13.4] 子脚本的第一行输出被转发出来（实得 " + at.first + "ms）");
    ok(
      at.close > 0 && at.first > 0 && at.close - at.first >= 2000,
      "[13.4] 第一行在子脚本结束前 " + (at.close - at.first) + "ms 就到了（旧版整段缓冲 ⇒ 只会在结束时一起出现）",
    );
  } finally {
    try {
      fs.rmSync(tmpS, { recursive: true, force: true });
    } catch {}
  }
}

function finish() {
  console.log("\n" + (fails ? "FAILED " + fails + " / " + checks : "ALL PASS " + checks) + " checks");
  process.exit(fails ? 1 : 0);
}

if (process.platform === "win32") {
  h3StreamingProbe().then(finish, (e) => {
    checks++;
    fails++;
    console.log("  FAIL [13.4] 实时流式探针异常：" + ((e && e.message) || e));
    finish();
  });
} else {
  finish();
}
