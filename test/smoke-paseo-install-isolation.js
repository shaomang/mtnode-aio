"use strict";
/* 「Paseo 手机接管」隔离安装冒烟（纯 Node，不启 Electron）：
 *   node test/smoke-paseo-install-isolation.js
 *
 * 钉的是**「新客户机没装 Paseo 时装不上后端」**这一圈（现场：`[install] 完成：code=0 installed=false`）：
 *   [1] 路径注入：`MTNODE_PASEO_DIRS` / `MTNODE_PASEO_USERPROFILE` 生效，「本机什么都没有」与
 *       「本机装着 Paseo」两种机器状态都能在开发机上模拟出来
 *   [2] 主机解析：own 模式 CLI 不可用时**回落到本机已装的 Paseo**（过去是死胡同），
 *       `reuseCandidate()` 报出可回落的那一份，`switchToReuse()` 只改用户亲手点的那一下
 *   [3] 安装自检：`installBackend` 以「CLI 真能报版本」为判据（不再是目录在不在）；
 *       半成品（依赖目录在、bin 缺失）判失败并给出可操作原因
 *   [4] 真 Node 前置：Electron 自带的 Node 不算就位（桥的 command[0] 必须真 Node）
 *
 * 真装 @getpaseo/cli、真起 daemon 的那一支在 test/smoke-paseo-install-real.mjs（要网络，默认不跑）。
 *
 * 怎么把宿主拉进纯 Node：`paseo/main-paseo.js` 顶部 `require("electron")` —— 这里先用假体占住
 * `require.cache`（仓库里其它冒烟也是这么干的），再 require 真文件，直呼它导出的 `__internals`。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

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
const exists = (p) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
};

/* ── 假 Electron：宿主只用到这几样 ───────────────────────────────────────── */
const fakeElectron = {
  app: {
    getVersion: () => "0.0.0-smoke",
    getAppPath: () => ROOT,
    getPath: () => path.join(os.tmpdir(), "mtnode-paseo-smoke-userdata"),
  },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
  ipcMain: { handle: () => {} },
  dialog: { showOpenDialogSync: () => undefined },
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 800 } }) },
};
const electronEntry = require.resolve("electron");
require.cache[electronEntry] = {
  id: electronEntry,
  filename: electronEntry,
  loaded: true,
  exports: fakeElectron,
  children: [],
  paths: [],
};

/* 隔离现场：临时数据目录（宿主只往这里写日志 / 配置，绝不碰真实 %APPDATA%） */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-iso-"));
const DATA_DIR = path.join(SANDBOX, "data");
const EMPTY_MACHINE = path.join(SANDBOX, "empty-machine"); // 模拟「这台机器上没装 Paseo」
const FAKE_DESKTOP = path.join(SANDBOX, "fake-desktop"); // 模拟「装着 Paseo 桌面端」
const OWN_DIR = path.join(SANDBOX, "own-backend");
const HOME_DIR = path.join(SANDBOX, "home");
for (const d of [DATA_DIR, EMPTY_MACHINE, OWN_DIR, HOME_DIR]) fs.mkdirSync(d, { recursive: true });

process.env.MTNODE_DATA_DIR = DATA_DIR;
process.env.MTNODE_PASEO_USERPROFILE = SANDBOX;
process.env.MTNODE_PASEO_DIRS = EMPTY_MACHINE;

const host = require(abs("paseo/main-paseo.js"));
const I = host.__internals;
const configPath = path.join(DATA_DIR, "app-plugins", "paseo-remote", "config.json");
const writeCfg = (o) => {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(o, null, 2), "utf8");
};
const readCfg = () => JSON.parse(fs.readFileSync(configPath, "utf8"));

/** 造一份「看起来装好了」的自建后端目录：bin shim + 真入口 + 假的 CLI 脚本。
 *  真入口（`node_modules\@getpaseo\cli\bin\paseo`）是本轮新增的判据：拿得到真 Node 时，
 *  宿主直接 `<真Node> <入口>` 跑，不经 `.bin\paseo.cmd`（shim 会去 PATH 找 node = 旧 Node 现场的病根）。 */
function makeFakeBackend(dir, opts) {
  const o = opts || {};
  const binDir = path.join(dir, "node_modules", ".bin");
  const pkgDir = path.join(dir, "node_modules", "@getpaseo", "cli");
  fs.mkdirSync(binDir, { recursive: true });
  const js = path.join(pkgDir, "bin", "paseo.js");
  fs.mkdirSync(path.dirname(js), { recursive: true });
  const body =
    o.printVersion === false
      ? 'if (process.argv[2] === "--version") process.exit(3);\n'
      : 'if (process.argv[2] === "--version") { console.log("9.9.9"); process.exit(0); }\nprocess.exit(0);\n';
  fs.writeFileSync(js, body, "utf8");
  /* npm 的 bin 目标（无扩展名，node 直接跑它）—— 官方包 layout：node_modules\@getpaseo\cli\bin\paseo */
  const entry = path.join(pkgDir, "bin", "paseo");
  fs.writeFileSync(entry, '#!/usr/bin/env node\nrequire("./paseo.js");\n', "utf8");
  fs.writeFileSync(
    path.join(binDir, "paseo.cmd"),
    "@echo off\r\n" + '"' + process.execPath + '" "' + js + '" %*\r\n',
    "utf8",
  );
  if (o.withDep !== false) fs.mkdirSync(pkgDir, { recursive: true });
  return { cli: path.join(binDir, "paseo.cmd"), entry, pkg: pkgDir };
}
/** 造一份「桌面端自带 CLI」：<dir>\resources\bin\paseo.cmd */
function makeFakeDesktop(dir) {
  const bin = path.join(dir, "resources", "bin");
  fs.mkdirSync(bin, { recursive: true });
  const js = path.join(dir, "cli.js");
  fs.writeFileSync(js, 'if (process.argv[2] === "--version") { console.log("8.8.8"); process.exit(0); }\nprocess.exit(0);\n', "utf8");
  const cmd = path.join(bin, "paseo.cmd");
  fs.writeFileSync(cmd, "@echo off\r\n" + '"' + process.execPath + '" "' + js + '" %*\r\n', "utf8");
  return cmd;
}

(async () => {
  /* ── [1] 路径注入：一台「什么都没装」的机器 ─────────────────────────────── */
  console.log("[1] 路径注入（模拟未安装 Paseo 的新客户机）");
  {
    ok(I.overrideDirs().length === 1 && I.overrideDirs()[0] === EMPTY_MACHINE, "MTNODE_PASEO_DIRS 被读到（模拟空机器）");
    ok(I.homeDir() === SANDBOX, "MTNODE_PASEO_USERPROFILE 覆盖了 ~ 落点（不动真实用户目录）");
    const cands = I.desktopCliCandidates();
    ok(cands.length >= 1 && cands[0].startsWith(EMPTY_MACHINE), "desktop CLI 候选只在注入目录里找（真机上的 Paseo 不干扰）");
    ok(I.resolveCli({ mode: "reuse" }).cli === "", "空机器 + 复用模式 → 找不到 CLI（cli_missing 的现场）");
    ok(I.reuseCandidate().available === false, "空机器上没有可回落的本机 Paseo");
  }

  /* ── [2] own 走不通时的回落出口 ────────────────────────────────────────── */
  console.log("[2] own 走不通 → 本机已装的 Paseo 能接上（过去的死胡同）");
  {
    writeCfg({ mode: "own", installDir: path.join(SANDBOX, "missing-dir"), ownHome: HOME_DIR });
    ok(I.resolveCli({ mode: "own" }).cli === "", "own 指向一个空目录：自有 CLI 找不到");
    ok(I.resolveCli({ mode: "own" }).source === "", "own 且坏掉时不再假装有 CLI");
    const c1 = I.reuseCandidate();
    ok(c1.available === false, "这台机器还没有别的 Paseo → 回落出口应当报不可用");

    const desktopCli = makeFakeDesktop(FAKE_DESKTOP); // 现在「本机装着 Paseo 桌面端」
    process.env.MTNODE_PASEO_DIRS = FAKE_DESKTOP;
    delete require.cache[require.resolve(abs("paseo/main-paseo.js"))];
    const host2 = require(abs("paseo/main-paseo.js"));
    const I2 = host2.__internals;
    const c2 = I2.reuseCandidate();
    ok(c2.available && c2.source === "desktop" && c2.cli === desktopCli, "装了桌面端后：reuseCandidate 报出 desktop CLI");

    const r = I2.switchToReuse();
    ok(r.ok && r.source === "desktop", "switchToReuse() 成功（用户点「改用本机已装的 Paseo」）");
    ok(readCfg().mode === "reuse" && readCfg().installDir === "", "切换只改模式（installDir 清空，不残留死目录）");
    ok(I2.resolveCli(readCfg()).cli === desktopCli, "切完 own 的坏目录不再挡路：own 模式也能拿到本机那份");
    const own = I2.verifyOwnInstall({ mode: "own", installDir: path.join(SANDBOX, "missing-dir") });
    ok(own && typeof own.then === "function", "verifyOwnInstall 是异步的（要真跑 CLI）");
    const ownRes = await own;
    ok(ownRes.ok === false && ownRes.reason === "dep_missing", "自检能区分「依赖根本没落盘」（dep_missing）");
  }

  /* ── [3] 安装自检口径（installed 不再只看目录在不在） ────────────────────── */
  console.log("[3] 安装自检：CLI 真能跑才算装好");
  {
    const host3 = require(abs("paseo/main-paseo.js"));
    const I3 = host3.__internals;

    /* 3a. 半成品：依赖目录在，但 .bin\paseo.cmd 没生成 → 过去判 installed=true，现在判 cli_bin_missing */
    const half = path.join(SANDBOX, "half-backend");
    fs.mkdirSync(path.join(half, "node_modules", "@getpaseo", "cli"), { recursive: true });
    writeCfg({ mode: "own", installDir: half, ownHome: HOME_DIR });
    const v1 = await I3.verifyOwnInstall(readCfg());
    ok(v1.depExists === true && v1.ok === false && v1.reason === "cli_bin_missing", "依赖目录在、bin 缺失 → 判未装好并把原因说清（cli_bin_missing）");

    /* 3b. 装好了：bin 在位且 --version 真回版本号 */
    const good = path.join(SANDBOX, "good-backend");
    makeFakeBackend(good);
    writeCfg({ mode: "own", installDir: good, ownHome: HOME_DIR });
    const v2 = await I3.verifyOwnInstall(readCfg());
    ok(v2.ok === true && v2.version === "9.9.9", "bin 在位 + --version 回 9.9.9 → 判装好（自检版本号一并给出）");

    /* 3c. bin 在但跑不起来（CLI 自身报错）*/
    const broken = path.join(SANDBOX, "broken-backend");
    makeFakeBackend(broken, { printVersion: false });
    writeCfg({ mode: "own", installDir: broken, ownHome: HOME_DIR });
    const v3 = await I3.verifyOwnInstall(readCfg());
    ok(v3.ok === false && v3.reason === "cli_not_runnable", "CLI 在位但 --version 失败 → cli_not_runnable（不谎报装好）");

    /* 3d. UI 状态行读的是自检结论，不是目录在不在 */
    writeCfg({ mode: "own", installDir: half, ownHome: HOME_DIR });
    const st = await I3.detectBackend();
    ok(st.mode === "own" && st.installed === false, "detectBackend：own 半成品 → installed=false（与自检一致）");
    ok(st.installCheck && st.installCheck.reason === "cli_bin_missing", "状态里带上未通过的原因（控制台摊给用户看）");
    ok(st.depExists === undefined && st.installCheck.depExists === true, "依赖目录是否在位单独给出（两个判据不再混为一谈）");

    writeCfg({ mode: "own", installDir: good, ownHome: HOME_DIR });
    const st2 = await I3.detectBackend();
    ok(st2.installed === true && st2.cliSource === "own" && st2.version === "9.9.9", "装好时：installed=true + cliSource=own + 版本 9.9.9");
    ok(st2.nodeReady === true || st2.nodeReady === false, "状态里给出真 Node 是否就位（nodeReady）");
    ok(!st2.nodeReady === !!st2.nodeElectronFallback, "nodeReady 与 nodeElectronFallback 互斥（一个判据）");

    /* 3e. 「CLI 在但跑不起来」时状态行不能显示成装好（旧的目录判据会显示装好） */
    const broken2 = path.join(SANDBOX, "broken-backend2");
    makeFakeBackend(broken2, { printVersion: false });
    writeCfg({ mode: "own", installDir: broken2, ownHome: HOME_DIR });
    const st3 = await I3.detectBackend();
    ok(st3.cli && st3.cliSource === "own", "坏 CLI 仍在状态里指出来（cli 路径给用户看）");
    ok(!st3.version, "坏 CLI 的版本号为空（界面据此标「跑不起来」）");
    ok(st3.installed === false && st3.installCheck.reason === "cli_not_runnable", "坏 CLI：installed=false + cli_not_runnable（不显示成装好）");
  }

  /* ── [4] 真 Node 前置 ─────────────────────────────────────────────────── */
  console.log("[4] 真 Node 前置（桥的 command[0]）");
  {
    const I4 = require(abs("paseo/main-paseo.js")).__internals;
    ok(I4.nodeReadyOf({ bin: "x", electron: true }) === false, "Electron 自带的 Node **不算**就位");
    ok(I4.nodeReadyOf({ bin: "x", electron: false }) === true, "真 Node 才算就位");
    ok(I4.nodeReadyOf(null) === false, "拿不到 Node 时不算就位");
    const src = read("paseo/main-paseo.js");
    ok(/await waitRealNode\(\{ timeoutMs: 20000 \}\)/.test(src), "注册 provider 前先等真 Node（不把 Electron 写进 provider）");
    /* 本轮口径变了：不再「不主动装」—— 缺 Node / 版本过旧时**主动装一份托管 Node**（用户设备现场：
       npm 放行、CLI 跑不起来），且有 Node 时 npm 与 CLI 都走它，不经 .cmd shim。 */
    ok(/ensureNodeRuntime/.test(src) && /installManagedNode/.test(src), "缺真 Node / 版本过旧时走 dsh 那套托管安装（installManagedNode）");
    ok(
      /installManagedNode\(\{[\s\S]{0,400}version: MANAGED_NODE_VERSION/.test(src),
      "托管安装的版本与 dsh 同一份常量（不各写一个数字）",
    );
    const waitSrc = /async function waitRealNode\(opts\)([\s\S]*?)\n\}/.exec(src);
    ok(!!waitSrc && /resolveDshNode|realNode\(\)/.test(waitSrc[1]), "等待走的是 dsh 的解析口径（同一份真源）");
    ok(!!waitSrc && !/fs\.|spawn|exec/.test(waitSrc[1]), "等待只轮询解析结果：不写盘、不起安装进程");
  }

  /* ── [4.5] Windows 调用姿势与端口避让（现场踩过的两个坑） ──────────────── */
  console.log("[4.5] 调用姿势（.cmd）与端口避让（6767）");
  {
    const I45 = require(abs("paseo/main-paseo.js")).__internals;
    const src = read("paseo/main-paseo.js");
    /* 坑 1：Windows 上 spawnSync("npm.cmd", …) 直接 EINVAL → 现场表现成「装了 Node 却说没 npm」 */
    if (process.platform === "win32") {
      const p = I45.resolveCommandPath("where");
      ok(/\.(cmd|exe)$/i.test(p), "裸命令能被解析成可执行文件（where → " + p + "）");
      ok(I45.resolveCommandPath("这个命令不存在-xyz") === "", "不存在的命令回空串（调用方据此报 npm_missing，不瞎猜）");
      ok(I45.resolveCommandPath("C:\\Windows\\System32\\where.exe").indexOf("System32") > 0, "带路径的入参原样返回（不再去 where 里绕）");
      ok(/cmd\.exe/.test(src) && /resolveCommandPath\(cli\)/.test(src), "spawnCli 对裸命令先解析再经 cmd.exe（`.cmd` 唯一稳的路）");
      ok(/cmd\.exe", \["\/d", "\/s", "\/c", '"' \+ String\(cmd\) \+ '\.cmd --version"'/.test(src), "npm 探测走 cmd.exe（spawnSync 直接跑 npm.cmd 会 EINVAL）");
    }
    /* 坑 2：自建 daemon 沿用 6767 必撞桌面端 → 必须能改 daemon.listen，且撞上能自愈 */
    ok(/daemon\.listen/.test(src), "宿主会把自建后端的 listen 写成 daemon.listen（官方持久键）");
    ok(/async function ensureOwnListen\(/.test(src), "有 ensureOwnListen（挑空闲端口）");
    ok(/EADDRINUSE/.test(src) && /force: true/.test(src), "startDaemon 撞 EADDRINUSE 时换端口重试一次");
    ok(/6768/.test(src) && /6787/.test(src), "备用端口区间明确（6768~6787）");
    ok(/MTNODE_PASEO_PORT/.test(src), "端口可注入（隔离测试用，避免撞开发机上别的服务）");
    const free = await I45.portFree(6789);
    ok(typeof free === "boolean", "portFree 可用（6789 现在" + (free ? "空闲" : "被占") + "）");
  }

  /* ── [4.6] Node 运行时预检：旧 Node 装出来的 CLI 必须被拦住（用户设备现场） ──
     现场：PATH 里是 Node v18.13.0 / npm 8.19.3，`npm i @getpaseo/cli` 只给 EBADENGINE 警告就放行，
     装完 `.bin\paseo.cmd` 去 PATH 找 node → 崩，界面只能报「CLI 装上了但跑不起来」。 */
  console.log("[4.6] Node 运行时预检与「旧 Node 装出来的 CLI」拒绝安装");
  {
    const host46 = require(abs("paseo/main-paseo.js"));
    const I46 = host46.__internals;
    const dshNode = require(abs("dsh-node.js"));

    ok(I46.NODE_MIN_VERSION === dshNode.NODE_MIN_VERSION, "版本底线与 dsh 同一份（" + I46.NODE_MIN_VERSION + "）");
    ok(I46.MANAGED_NODE_VERSION === dshNode.MANAGED_NODE_VERSION, "托管安装版本与 dsh 同一份（" + I46.MANAGED_NODE_VERSION + "）");

    /* npm 解析：<真Node>\node_modules\npm\bin\npm-cli.js（去问真 Node 自己，不猜 PATH） */
    const npmCli = I46.npmCliOf(process.execPath);
    ok(/npm-cli\.js$/i.test(npmCli) && exists(npmCli), "npmCliOf(真 Node) 能定位到 npm-cli.js（" + npmCli + "）");
    ok(I46.npmCliOf(path.join(SANDBOX, "no-such-node.exe")) === "", "拿不到配套 npm 时回空（调用方据此拒绝，不退回 PATH 的 npm）");
    const spec = I46.npmSpecFor(process.execPath);
    ok(!!spec && spec.node === process.execPath && /npm-cli\.js$/i.test(spec.cli), "npmSpecFor 出的是 `<真Node> <npm-cli.js>`（不经 npm.cmd）");

    /* 假冒一份「旧版 Node」：拷一份**真 node 二进制**，并在这个块里把 spawnSync 截住，
       让它被问到时只回 18.13.0（真机上这就是「PATH 里那份旧 node」）。
       为什么这么绕：探针是 `spawnSync(bin, ["-p", …])` 且不带 shell，Windows 上 .cmd 直接 EINVAL
       （`spawnSync node.cmd EINVAL`），所以拿真二进制 + 截桩演最像；NODE_OPTIONS 不行 ——
       探针会主动删掉它（防用户环境污染）。 */
    const oldDir = path.join(SANDBOX, "old-node");
    fs.mkdirSync(oldDir, { recursive: true });
    const oldNode = path.join(oldDir, process.platform === "win32" ? "node.exe" : "node");
    fs.copyFileSync(process.execPath, oldNode);
    ok(exists(oldNode), "假冒旧 Node 用的是真 PE 二进制（" + oldNode + "）");
    /* 截桩要打在 dsh-node 的导出上：它在模块顶层 `const { spawnSync } = require("child_process")`，
       之后改 child_process.spawnSync 对它无效。 */
    const dshMod = require(abs("dsh-node.js"));
    const origProbe = dshMod.probeNodeBin;
    const patchOldNode = () => {
      dshMod.probeNodeBin = function (bin, opts) {
        if (String(bin) === oldNode) return { ok: false, reason: "too-old", version: "18.13.0" };
        return origProbe.apply(dshMod, arguments);
      };
    };
    const restoreProbe = () => {
      dshMod.probeNodeBin = origProbe;
    };
    patchOldNode();
    process.env.MTNODE_NODE_BIN = oldNode;
    const rt = I46.pickNodeRuntime({});
    restoreProbe();
    ok(
      rt.ready === false && rt.reason === "too_old" && rt.version === "18.13.0",
      "旧版 Node 被判不达标（too_old，版本号一并给出）：" + JSON.stringify({ reason: rt.reason, version: rt.version }),
    );
    delete process.env.MTNODE_NODE_BIN;
    ok(
      rt.ready === false && rt.reason === "too_old" && rt.version === "18.13.0",
      "旧版 Node 被判不达标（too_old，版本号一并给出）：" + JSON.stringify({ reason: rt.reason, version: rt.version }),
    );
    delete process.env.MTNODE_NODE_BIN;
    delete process.env.NODE_OPTIONS;

    /* npm 的 EBADENGINE 现场文本 → 版本可被摘出来，并据此判「是 Node 太旧」而不是「CLI 坏了」 */
    const eng = "npm WARN EBADENGINE Unsupported engine { package: '@vercel/oidc@3.0.3', required: { node: '>= 20' }, current: { node: 'v18.13.0', npm: '8.19.3' } }";
    ok(I46.nodeVersionFromText(eng) === "18.13.0", "npm EBADENGINE 文本里的 current node 版本能摘出来");
    ok(I46.nodeVersionFromText("npm ERR! something else") === "", "没有版本号时不瞎猜（回空串）");
  }

  /* ── [4.7] installBackend 的预检：Node 太旧 + 自动装 Node 失败 → 拒绝，且不跑 npm ── */
  console.log("[4.7] 预检拒绝：不跑 npm、不留半成品、原因可操作");
  {
    const host47 = require(abs("paseo/main-paseo.js"));
    const I47 = host47.__internals;
    const oldNode2 = path.join(SANDBOX, "old-node", process.platform === "win32" ? "node.exe" : "node");
    const rejDir = path.join(SANDBOX, "reject-backend");
    fs.mkdirSync(rejDir, { recursive: true });
    /* 三件事合起来把这条路钉成离线可复现（= 用户设备：PATH 里只有旧 Node、Node 又下不来）：
       ① 只给一份「旧 Node」（MTNODE_NODE_BIN）+ 把开发机自己那份 Node 从 PATH 里摘掉
          （照 dsh「干净机器」冒烟的做法，只摘 node 目录，System32 等仍留着）；
       ② 托管安装被禁用（dsh-node 自己的测试钩子 MTNODE_NO_NODE_DOWNLOAD）= 模拟下载不通；
       ③ 清掉进程内缓存 + 截住 spawnSync，确保这一次真的重跑预检。 */
    const origPath = process.env.PATH;
    const origPathKey = process.env.PATH === undefined && process.env.Path !== undefined ? "Path" : "PATH";
    const nodeDir = path.dirname(process.execPath);
    process.env[origPathKey] = String(origPath || "")
      .split(path.delimiter)
      .filter((p) => {
        const s = String(p || "").trim();
        if (!s) return false;
        try {
          return path.resolve(s).toLowerCase() !== path.resolve(nodeDir).toLowerCase();
        } catch {
          return true;
        }
      })
      .join(path.delimiter);
    process.env.MTNODE_NODE_BIN = oldNode2;
    process.env.MTNODE_NO_NODE_DOWNLOAD = "1";
    const dshMod2 = require(abs("dsh-node.js"));
    const origProbe2 = dshMod2.probeNodeBin;
    dshMod2.probeNodeBin = function (bin, opts) {
      if (String(bin) === oldNode2) return { ok: false, reason: "too-old", version: "18.13.0" };
      return origProbe2.apply(dshMod2, arguments);
    };
    I47.cachedNodeRuntime({ refresh: true });
    const r = await I47.installBackend({ installDir: rejDir, noRetry: true });
    dshMod2.probeNodeBin = origProbe2;
    process.env[origPathKey] = origPath;
    delete process.env.MTNODE_NODE_BIN;
    delete process.env.MTNODE_NO_NODE_DOWNLOAD;

    ok(r.ok === false && r.error === "install_failed", "旧 Node + Node 装不上 → 拒绝安装（不留下装坏的目录）");
    ok(r.reason === "node_install_failed", "原因码是 node_install_failed（自动装 Node 失败）：" + r.reason);
    ok(/Node ≥/.test(String(r.message || "")) && /改用本机已装的 Paseo|等真 Node 就位/.test(String(r.hint || "")), "提示里写清底线与三条出口（装 Node / 自动装 / 改用桌面端）");
    const log = (() => {
      try {
        return fs.readFileSync(path.join(DATA_DIR, "app-plugins", "paseo-remote", "console.log"), "utf8");
      } catch {
        return "";
      }
    })();
    ok(/\[node\]/.test(log) && /自动装一份 Node/.test(log), "控制台日志写清「试过自动装 Node」");
    ok(/\[install\] 预检不过/.test(log), "控制台日志写清卡在哪一步（预检不过）");
    ok(!/npm i @getpaseo\/cli/.test(log), "**没有跑 npm install**（拒绝发生在 npm 之前）");
    ok(!exists(path.join(rejDir, "node_modules")), "目录里没有留下半成品 node_modules");
  }

  /* ── [5] 宿主接线：新出口都在五层里 ─────────────────────────────────────── */
  console.log("[5] 接线（宿主 / 控制台桥 / 前端动作）");  {
    const src = read("paseo/main-paseo.js");
    ok(/handle\("useReuse"/.test(src), "宿主注册了 useReuse");
    ok(/handle\("waitNode"/.test(src), "宿主注册了 waitNode");
    ok(/handle\("cleanReinstall"/.test(src), "宿主注册了 cleanReinstall（清干净重装）");
    const pre = read("paseo/preload-paseo.js");
    ok(/useReuse: \(\) => ipcRenderer\.invoke\("paseoRemote:useReuse"\)/.test(pre), "控制台桥转发 useReuse");
    ok(/waitNode: \(\) => ipcRenderer\.invoke\("paseoRemote:waitNode"\)/.test(pre), "控制台桥转发 waitNode");
    ok(/cleanReinstall: \(opts\) => ipcRenderer\.invoke\("paseoRemote:cleanReinstall"/.test(pre), "控制台桥转发 cleanReinstall");
    const ui = read("paseo/ui/ui.js");
    ok(/act === "use-reuse"/.test(ui) && /paseoApi\.useReuse\(\)/.test(ui), "控制台有「改用本机已装的 Paseo」动作");
    ok(/act === "wait-node"/.test(ui) && /paseoApi\.waitNode\(\)/.test(ui), "控制台有「等真 Node 就位」动作");
    ok(/act === "clean-reinstall"/.test(ui) && /paseoApi\.cleanReinstall\(/.test(ui), "控制台有「清干净重装」动作（点了才删 node_modules）");
    ok(/node_too_old/.test(ui) && /node_install_failed/.test(ui), "控制台把「Node 太旧 / Node 装不上」翻成人话");
    ok(/InstallCheck|installCheck/.test(ui), "控制台渲染安装自检结论");
    ok(/real_node_missing/.test(ui), "控制台把「没有真 Node」翻成人话");
    ok(/cleanOwnDeps/.test(src) && /重装一次/.test(src), "安装失败先清半成品再重装一次（不无限重试）");
    ok(/daemon 自检|installCheck/.test(read("paseo/ui/ui.js")), "控制台把自检结论画在状态行里（用户看得见卡在哪一步）");
  }

  /* ── 收尾 ─────────────────────────────────────────────────────────────── */
  try {
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  } catch {}
  console.log("");
  console.log(fails === 0 ? "全部通过：" + checks + " 项" : "失败 " + fails + " / " + checks + " 项");
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => {
  console.log("FAIL  未捕获异常：" + ((e && e.stack) || e));
  process.exit(1);
});
