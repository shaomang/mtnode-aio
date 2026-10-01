"use strict";
/* dsh 运行时 Node 选择与托管安装 —— 冒烟测试（纯 Node，无 DOM、不联网）
 *   node test/smoke-dsh-node.js
 *
 * 事故（2026-09-30 实测，打包版）：dsh 0.2 的内核在 boot 时要 node-addon-require-builtin
 * 去 hook ESM 内部模块，该原生插件只认它编译过的 Electron 版本 ——
 *   dsh: host preparation failed: node-addon-require-builtin unsupported: Unsupported/no-context
 *   (unsupported Electron runtime fingerprint: Node 22.22.1, V8 14.2.231.22-electron.0
 *    (supported Electron versions: 43.0.0, 44.0.0, 45.0.0-alpha.6))
 * MTNode 是 Electron 39，于是每次 run 都在 host preparation 阶段硬失败（应用侧表现 =
 * 「dsh 网关已退出」/ 运行时立刻消失）。
 * 又因为 SDK 客户端把运行时子进程写死成 `command: process.execPath`
 * （@deepseek-ai/dsh-sdk-client 的 resolveDshLaunch），网关自己必须跑在**真 Node** 上。
 *
 * 覆盖：
 *   [1] 候选清单顺序与形状（env 覆盖 → 托管 → PATH → 版本管理器 / 包管理器目录）
 *   [2] 探针判据：Electron 冒充 Node 必须被拒；老 Node 必须被拒；不存在的路径 = missing
 *   [3] resolveDshNode：命中真 Node 不回退；一个候选都没有才回退 Electron（并带 fallback 标记）
 *   [4] 报错翻译：实测抓到的那条报文 → 可执行的说明
 *   [5] zip 解压（零依赖、走中央目录）：store / deflate / 目录项 / 越界条目 / 坏 method
 *   [6] 托管安装的失败路径与现场清理（zip 缺 node.exe、node.exe 不是可执行、下载被关掉）
 *   [7] 接线口径：build.json 白名单、main-dsh 不再硬编码 Electron、DESIGN.md 有该章
 */
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os"), childProcess = require("child_process");
const SHARED = { fs, path, vm, os, spawn: childProcess.spawn };
const TEST_DIR = __dirname;
let MERGED_FAILED = false;

const zlib = require("zlib");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const M = require(path.join(ROOT, "dsh-node.js"));

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
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-dsh-node-"));

/* ── 手写 zip 生成器（只为测试解压器：store / deflate / 目录 / 越界 / 坏 method）── */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const raw = e.data || Buffer.alloc(0);
    const method = e.method === "deflate" ? 8 : e.method === "bad" ? 12 : 0;
    const body = e.dir ? Buffer.alloc(0) : method === 8 ? zlib.deflateRawSync(raw) : raw;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

console.log("\n[1] 候选清单：env 覆盖 → 托管 → PATH → 常见安装位置");
{
  const dataDir = path.join(TMP, "data");
  const env = {
    MTNODE_NODE_BIN: "D:\\custom\\node.exe",
    PATH: ["C:\\one", "C:\\two"].join(path.delimiter),
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local",
    APPDATA: "C:\\Users\\x\\AppData\\Roaming",
    USERPROFILE: "C:\\Users\\x",
    ProgramData: "C:\\ProgramData",
    NVM_HOME: "C:\\nvm",
    NVM_SYMLINK: "C:\\nvm4w\\nodejs",
  };
  const c = M.nodeCandidates({ dataDir, env });
  const bins = c.map((x) => x.bin);
  ok(bins[0] === "D:\\custom\\node.exe" && c[0].source === "env:MTNODE_NODE_BIN", "MTNODE_NODE_BIN 排第一（诊断 / 内网自备 Node 的出口）");
  ok(bins[1] === path.join(dataDir, M.MANAGED_DIR, "node.exe") && c[1].source === "managed", "托管 Node 排第二（版本确定，优先于系统里的）");
  ok(bins.includes("C:\\one\\node.exe") && bins.includes("C:\\two\\node.exe"), "PATH 里逐个目录都试");
  ok(bins.includes("C:\\Program Files\\nodejs\\node.exe"), "Program Files\\nodejs 在表里");
  ok(bins.includes("C:\\Users\\x\\AppData\\Local\\Programs\\nodejs\\node.exe"), "LOCALAPPDATA\\Programs\\nodejs 在表里");
  ok(bins.includes("C:\\nvm4w\\nodejs\\node.exe"), "nvm-windows 的 symlink 在表里");
  ok(c.every((x) => x.bin && x.source), "每条候选都带来源标签（诊断要说得清是谁）");
  ok(new Set(bins.map((b) => b.toLowerCase())).size === bins.length, "候选去重（同一目录只试一次）");
}

console.log("\n[2] 探针判据：真跑一次才算数");
{
  const me = process.execPath;
  const real = M.probeNodeBin(me);
  ok(real.ok === true && /^\d+\.\d+\.\d+/.test(real.version), "本机 node 探针通过（" + real.version + "）");
  ok(M.probeNodeBin(path.join(TMP, "nope", "node.exe")).reason === "missing", "不存在的路径 = missing");
  /* Electron 自带的 Node：探针脚本注入模拟（真跑不出来，这里只验判据分支） */
  const asElectron = M.probeNodeBin(me, { script: 'JSON.stringify({node:"22.22.1",electron:"39.0.0"})' });
  ok(asElectron.ok === false && asElectron.reason === "electron" && asElectron.electron === "39.0.0",
    "自报 electron 的一律拒（Electron 39 正是被 dsh 0.2 拒绝的那个）");
  const tooOld = M.probeNodeBin(me, { script: 'JSON.stringify({node:"18.20.4",electron:""})' });
  ok(tooOld.ok === false && tooOld.reason === "too-old", "老 Node（18.x）判 too-old");
  const justEnough = M.probeNodeBin(me, { script: 'JSON.stringify({node:"22.19.0",electron:""})' });
  ok(justEnough.ok === true, "正好 22.19.0 算够（dsh 的下限是 ≥22.19）");
  const garbage = M.probeNodeBin(me, { script: '"not json"' });
  ok(garbage.ok === false && garbage.reason === "unreadable", "输出读不懂 = unreadable（不瞎信）");
  ok(M.probeNodeBin("").reason === "empty", "空路径 = empty");
  ok(M.versionAtLeast("22.19.0", "22.19.0") && !M.versionAtLeast("22.18.9", "22.19.0"), "版本比较含等号边界");
  ok(M.versionAtLeast("24.2.0", "22.19.0") && !M.versionAtLeast("20.99.99", "22.19.0"), "跨主版本比较正确");
}

console.log("\n[3] resolveDshNode：先真 Node，实在没有才回退 Electron");
{
  const dataDir = path.join(TMP, "data3");
  const hit = M.resolveDshNode({ dataDir, env: { MTNODE_NODE_BIN: process.execPath, PATH: "" }, log: () => {} });
  ok(hit.ok !== false && hit.fallback === false && hit.electron === false, "命中真 Node：fallback=false");
  ok(hit.bin === process.execPath && hit.source === "env:MTNODE_NODE_BIN", "命中的就是候选中第一个可用的");
  ok(/^\d+\.\d+\.\d+/.test(hit.version), "带回版本号（日志 / 诊断要用）");

  const none = M.resolveDshNode({
    dataDir: path.join(TMP, "empty-home"),
    refresh: true,
    env: {
      PATH: "", ProgramFiles: "X:\\nope", "ProgramFiles(x86)": "X:\\nope2",
      LOCALAPPDATA: "X:\\nope3", APPDATA: "X:\\nope4", USERPROFILE: "X:\\nope5", ProgramData: "X:\\nope6",
    },
    log: () => {},
  });
  ok(none.fallback === true && none.electron === true, "一个候选都没有：回退 Electron 并显式标 fallback（不许静默）");
  ok(none.bin === process.execPath, "回退目标就是 Electron 自带的 Node（老行为）");
}

console.log("\n[4] 报错翻译：把 SDK 的 stderr 尾巴换成能修的话");
{
  const raw = 'dsh profile "sdk": JSON-RPC input closed\nexit code: 1\nstderr tail:\n'
    + "dsh: fatal uncaught exception: Error: dsh: host preparation failed: node-addon-require-builtin unsupported: Unsupported/no-context (unsupported Electron runtime fingerprint: Node 22.22.1, V8 14.2.231.22-electron.0 (supported Electron versions: 43.0.0, 44.0.0, 45.0.0-alpha.6))";
  const t1 = M.translateRuntimeReject(raw, { fallback: true, installing: true });
  ok(!!t1 && /Node ≥22\.19|Node ≥22.19/.test(t1), "命中实测报文 → 说明里点名本机需要 Node ≥22.19");
  ok(/正在后台下载/.test(t1), "后台装着时说「正在后台下载」");
  const t2 = M.translateRuntimeReject(raw, { fallback: true, installed: true, version: "22.22.1" });
  ok(/22\.22\.1/.test(t2) && /重试本轮/.test(t2), "装好了就报版本号并让用户重试");
  const t3 = M.translateRuntimeReject(raw, { fallback: true, error: "download-failed: HTTP 404" });
  ok(/MTNODE_NODE_BIN/.test(t3) && /404/.test(t3), "装不上就给手工出口（MTNODE_NODE_BIN）并带上原因");
  ok(M.translateRuntimeReject("Authentication Fails, Your api key: ****-key is invalid", { fallback: true }) === null,
    "不是这个错就原样透传（绝不吞别的报错）");
  ok(M.translateRuntimeReject("", { fallback: true }) === null, "空报文不翻译");
}

console.log("\n[5] zip 解压：走中央目录、防越界");
{
  const zip = makeZip([
    { name: "node-v22.22.1-win-x64/", dir: true },
    { name: "node-v22.22.1-win-x64/a.txt", data: Buffer.from("hello store"), method: "store" },
    { name: "node-v22.22.1-win-x64/b.txt", data: Buffer.from("hello deflate"), method: "deflate" },
    { name: "../evil.txt", data: Buffer.from("nope"), method: "store" },
  ]);
  const dest = path.join(TMP, "unzip");
  const n = M.extractZipBuffer(zip, dest);
  ok(n === 2, "解出 2 个文件（目录项不留、越界条目丢弃）");
  ok(fs.readFileSync(path.join(dest, "node-v22.22.1-win-x64", "a.txt"), "utf8") === "hello store", "store 条目内容正确");
  ok(fs.readFileSync(path.join(dest, "node-v22.22.1-win-x64", "b.txt"), "utf8") === "hello deflate", "deflate 条目内容正确");
  ok(!fs.existsSync(path.join(TMP, "evil.txt")), "带 ../ 的条目被丢掉（不写出解压目录之外）");
  let threw = "";
  try { M.extractZipBuffer(makeZip([{ name: "x.bin", data: Buffer.from("x"), method: "bad" }]), path.join(TMP, "unzip2")); } catch (e) { threw = e.message; }
  ok(/unsupported method/.test(threw), "不支持的压缩法直接报错（不静默写出半个包）");
  let bad = "";
  try { M.extractZipBuffer(Buffer.from("not a zip at all"), path.join(TMP, "unzip3")); } catch (e) { bad = e.message; }
  ok(/EOCD/.test(bad), "不是 zip 就报 EOCD not found");
  /* 真实工具产的 zip（Windows 自带 Compress-Archive）也要吃：Node 官方 zip 是同类标准产物 */
  if (process.platform === "win32") {
    const src = path.join(TMP, "real-src");
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, "node.exe"), "fake");
    const realZip = path.join(TMP, "real.zip");
    const r = spawnSync("powershell.exe", ["-NoProfile", "-Command",
      `Compress-Archive -Path '${path.join(src, "*")}' -DestinationPath '${realZip}' -Force`],
      { encoding: "utf8", windowsHide: true, timeout: 60000 });
    if (r.status === 0 && fs.existsSync(realZip)) {
      const d2 = path.join(TMP, "unzip-real");
      const n2 = M.extractZipBuffer(fs.readFileSync(realZip), d2);
      ok(n2 === 1 && fs.readFileSync(path.join(d2, "node.exe"), "utf8") === "fake", "真 Compress-Archive 产的 zip 也解得开");
    } else {
      console.log("  skip  Compress-Archive 不可用（不联网也不影响解压器口径）");
    }
  }
}

console.log("\n[6] 托管安装：失败路径要干净、要能说清原因");
(async () => {
  const dataDir = path.join(TMP, "install-home");
  fs.mkdirSync(dataDir, { recursive: true });

  const zipNoNode = path.join(TMP, "no-node.zip");
  fs.writeFileSync(zipNoNode, makeZip([{ name: "node-v22.22.1-win-x64/README.md", data: Buffer.from("x"), method: "store" }]));
  const r1 = await M.installManagedNode({ dataDir, zipPath: zipNoNode, log: () => {} });
  ok(r1.ok === false && /node\.exe missing/.test(r1.error), "zip 里没有 node.exe → 明确失败（不产半成品）");
  ok(!fs.existsSync(path.join(dataDir, "node-runtime")), "失败后不留 node-runtime 目录");
  ok(!fs.existsSync(path.join(dataDir, "node-runtime.tmp")), "失败后现场（.tmp）被清掉");

  const zipBadExe = path.join(TMP, "bad-exe.zip");
  fs.writeFileSync(zipBadExe, makeZip([{ name: "node-v22.22.1-win-x64/node.exe", data: Buffer.from("not-a-real-exe"), method: "store" }]));
  const r2 = await M.installManagedNode({ dataDir, zipPath: zipBadExe, log: () => {} });
  ok(r2.ok === false && /installed-but-unusable/.test(r2.error), "装出来的 node.exe 跑不起来 → 判不可用（绝不当成装好了）");

  process.env.MTNODE_NO_NODE_DOWNLOAD = "1";
  const r3 = await M.installManagedNode({ dataDir, version: "9.9.9", log: () => {}, urls: ["https://127.0.0.1:1/nope.zip"] });
  delete process.env.MTNODE_NO_NODE_DOWNLOAD;
  ok(r3.ok === false && r3.error === "disabled", "MTNODE_NO_NODE_DOWNLOAD=1 时不下载（内网 / 测试出口）");

  const r4 = await M.installManagedNode({ dataDir, version: "9.9.9", log: () => {}, urls: ["https://127.0.0.1:1/nope.zip"] });
  ok(r4.ok === false && /download-failed/.test(r4.error), "下载全挂 → download-failed 并带上每个 URL 的原因");
  ok(r4.error.includes("127.0.0.1:1"), "失败原因里点名了试过的地址（诊断不用猜）");

  const st = M.managedNodeStatus(dataDir);
  ok(st.installed === false && st.bin.endsWith("node.exe"), "managedNodeStatus 如实回报「没装」");

  console.log("\n[7] 接线口径");
  {
    const build = read("build.json");
    ok(/"dsh-node\.js"/.test(build), "build.json 白名单里有 dsh-node.js（打包后 require 得到）");
    const mainDsh = read("dsh/main-dsh.js");
    ok(/require\('\.\.\/dsh-node\.js'\)/.test(mainDsh), "main-dsh 从 dsh-node.js 取 node");
    ok(/resolveDshNode\(\{ dataDir, log \}\)/.test(mainDsh), "网关 spawn 前先解析真 Node");
    ok(!/function nodeCommand\(\)/.test(mainDsh), "老的 nodeCommand()（硬编码 Electron）已摘除");
    ok(/nodeEnvFor\(nodeInfo, \{ \.\.\.process\.env \}\)/.test(mainDsh), "spawn env 按选定 node 决定 ELECTRON_RUN_AS_NODE");
    ok(/delete env\.NODE_OPTIONS/.test(mainDsh), "用户环境里的 NODE_OPTIONS 不带进网关（否则运行时会莫名起不来）");
    ok(/translateEvent\(msg\.event\)/.test(mainDsh), "网关 error 帧过一遍报错翻译");
    ok(/startManagedNodeInstall/.test(mainDsh) && /installManagedNode\(\{ dataDir, log \}\)/.test(mainDsh), "回退时后台自动装托管 Node（自愈）");
    ok(/installNode\(\)/.test(mainDsh) && /nodeInfo\(\)/.test(mainDsh), "适配器导出 nodeInfo / installNode（自检与修复入口）");
    const mainJs = read("main.js");
    ok(/dsh:installNode/.test(mainJs) && /nodeInfo\(\)/.test(mainJs), "main.js 把 node 状态并进 dsh:status，并留 dsh:installNode");
    const preload = read("preload.js");
    ok(/dshInstallNode:/.test(preload), "preload 暴露 dshInstallNode（自愈按钮的桥）");
    const design = read("dsh/DESIGN.md");
    ok(/Node 运行时/.test(design) && /unsupported Electron runtime fingerprint/.test(design),
      "DESIGN.md 记下「Node 运行时」口径与实测报错现象");
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log("\n" + (fails ? "FAILED " + fails + " / " + checks + " checks" : "ALL OK  " + checks + " checks"));
})();

/* ==================== 已并入：test/smoke-dsh-default-model.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-dsh-default-model.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

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
  const read = (rel) =>
    fs.readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8");

  console.log("\n[1] 默认模型下拉 = 全部文本服务商的模型（按服务商分组）");
  const settings = read("renderer/app-settings.js");
  ok(
    /mtnodePiProviders\(\)/.test(settings),
    "下拉构建遍历 mtnodePiProviders()（全部非 DeepSeek 文本服务商，不再只取第一个 DeepSeek 服务商）",
  );
  ok(
    /optgroup/.test(settings),
    "模型按服务商 optgroup 分组展示（与智能会话 / 全局助手同源）",
  );
  ok(
    /dp\.models\.map\(\(m\) => String\(m\)\)/.test(settings),
    "DeepSeek 官方组取 dshProvider().models",
  );
  ok(
    /groups\.push\(\{ label: p\.name, models: models\.map\(\(m\) => String\(m\)\) \}\)/.test(settings),
    "其余每个文本服务商各成一组的模型列表",
  );

  console.log("\n[2] 未保存时默认值跟随实际生效的智能路由");
  ok(
    /preferredAgentModelForRoute\(preferredAgentProviderRoute\(\)\)/.test(settings),
    "默认值 = 生效智能路由的默认模型（优先其它文本服务商，不硬编码 deepseek）",
  );
  ok(
    /保底：老配置里保存过、但已不在任何服务商模型清单中的值/.test(settings),
    "老配置里保存过但不在清单中的模型仍能显示（不丢失用户已选值）",
  );
  ok(
    /（无可用模型）/.test(settings),
    "无任何模型时给出「无可用模型」空态",
  );

  console.log("\n[3] 硬编码兜底已清除");
  ok(
    settings.indexOf("deepseek-v4-flash") < 0,
    "app-settings.js 不再出现 deepseek-v4-flash",
  );

  console.log("\n[4] 启动缺省合并不再强制 deepseek");
  const boot = read("renderer/app-boot.js");
  ok(
    /nodePath: "",\s*\n\s*model: ""/.test(boot),
    "app-boot.js dsh 缺省合并 model 为空串（留空 = 跟随生效路由）",
  );
  ok(
    boot.indexOf('model: "deepseek-v4-flash"') < 0,
    "app-boot.js 不再启动即写入 deepseek-v4-flash",
  );

  console.log(
    "\n" +
      (fails
        ? "FAILED " + fails + " / " + checks + " checks"
        : "ALL OK  " + checks + " checks"),
  );

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-dsh-default-model.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-dsh-default-model.js：" + fails + " / " + checks + " 项失败");
})();

/* 收尾：正文与并入块任一失败都算这只红；退出码只在全部跑完之后才定 */
if (MERGED_FAILED) console.log("\n✗ 本文件有失败项（含已并入块）\n");
process.exit(MERGED_FAILED ? 1 : 0);
