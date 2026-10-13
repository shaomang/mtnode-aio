#!/usr/bin/env node
/* test/smoke-mcp-stdio-discovery.js — stdio 桥的**默认发现路径**（打包态少一层）
 * ============================================================================
 * 现场（本机实测）：服务端状态写在 <userData>\pipeline-console\mcp-server.json，
 *   也就是 %APPDATA%\pipeline-console\pipeline-console\mcp-server.json；而桥在 Windows 上
 *   只找 %APPDATA%\pipeline-console\mcp-server.json —— 少一层，于是**推荐的 stdio 接入
 *   开箱即失败**，桥报「没开 MTNode」而服务端其实在跑。
 *   两层目录的来源：main.js 的 APP_DATA_ROOT = appData/pipeline-console，
 *   userData = APP_DATA_ROOT，DATA() = userData/pipeline-console（mcp-server.js 落盘到 DATA()）。
 *
 * 本冒烟**不设 MTNODE_DATA_DIR**（默认发现分支正是出问题的那条），只把 APPDATA 指到临时目录，
 *   用真子进程跑 mcp-stdio.js --check，因此修复前必红、修复后必绿。
 *   端口/令牌故意写成 1（必然连不上），这样即使某天 APPDATA 被忽略也**绝不会误连本机真服务端**。
 *
 * 口径：
 *   [1] 打包态真实布局（%APPDATA%\pipeline-console\pipeline-console\mcp-server.json）→ 端到端连上假服务端
 *   [2] 全部候选皆死（目录里连状态文件都没有）→ ok:false / exit=1，且错误正文**逐条列出每个候选**
 *   [3] data-root.json 指针指向的自定义数据目录（设置里改过数据目录的用户）
 *   [4] MTNODE_DATA_DIR 两种写法（应用数据根 / 数据目录本身）仍然认得
 *   [5] **首个候选是死端口 + 后续候选是活端口 → 必须采纳活的那个**（这一格是「按候选逐个探活」
 *       的核心回归：旧实现拿到第一份状态文件就采纳，于是报 fetch failed 而服务端其实在跑；
 *       只按单个候选造桩监听的冒烟测不出这一格）
 *   [6] 全部候选都是死端口 → ok:false / exit=1，错误正文逐条含每个候选的端口与连不上原因
 *
 * 零依赖、不启动 Electron、不碰真实 %APPDATA%（APPDATA 全程指向 mkdtemp 出来的临时目录）。
 * 用法：node test/smoke-mcp-stdio-discovery.js
 * ============================================================================
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const BRIDGE = path.join(ROOT, "mcp-stdio.js");

let pass = 0;
let fail = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) {
    pass++;
    console.log("  [ok] " + name + (detail ? " — " + detail : ""));
  } else {
    fail++;
    fails.push(name + (detail ? " — " + detail : ""));
    console.log("  [FAIL] " + name + (detail ? " — " + detail : ""));
  }
}

const tmpRoots = [];
function tmpDir(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-mcp-disc-" + tag + "-"));
  tmpRoots.push(d);
  return d;
}
function cleanup() {
  for (const d of tmpRoots) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {}
  }
}

function writeState(dir, state) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "mcp-server.json"), JSON.stringify(state, null, 2), "utf8");
}

/* 假 MCP 服务端：只认 initialize / tools/list，够 --check 判定「连上了、有工具」。
   端口/令牌是随机真值，但服务只在 127.0.0.1 上开着，且 APPDATA 全程隔离。 */
function startFakeServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let msg = {};
        try {
          msg = JSON.parse(raw || "{}");
        } catch {}
        const reply = (body) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        };
        if (req.method !== "POST") return reply({ jsonrpc: "2.0", id: msg.id || null, error: { code: -32600, message: "只接受 POST" } });
        if (msg.method === "initialize")
          return reply({
            jsonrpc: "2.0",
            id: msg.id,
            result: { protocolVersion: "2025-06-18", serverInfo: { name: "mtnode-fake", version: "0.0.0" }, capabilities: { tools: {} } },
          });
        if (msg.method === "tools/list")
          return reply({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "mtnode_canvas_get", description: "fake", inputSchema: { type: "object" } }] } });
        return reply({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, token: "tok-" + Math.random().toString(36).slice(2) }));
  });
}

/* 造一个**确定的死端口**：先真占一个 ephemeral 端口，拿到号立刻放掉 —— 这个号在本次运行里
   不会再有人监听，桥探活它必然连不上（ECONNREFUSED / 超时），且不会误连本机真服务端。
   比写死 1 / 9 稳：写死端口在某些机器上可能真有人蹲着。 */
function deadPort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer(() => {});
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

/* 真子进程跑桥：先**清掉**所有 MTNODE_* 与 NODE_OPTIONS（本机跑过开发态实例的环境会带这些），
   再只补调用方显式给的键 —— 否则「默认发现分支」会被父进程环境悄悄接管，测不出东西。
   用**异步 spawn + 文件 stdio**（读回来与管道等价）：
     · 受管沙箱里子进程拿不到匿名管道，管道 stdio 会整只挂住；
     · spawnSync 即便指了文件也会为内部管道转发卡住，所以这里用 spawn。 */
const TMP_STDIO_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-mcp-disc-io-"));
tmpRoots.push(TMP_STDIO_DIR);
let stdioSeq = 0;
function runBridge(args, env) {
  const childEnv = {};
  for (const k of Object.keys(process.env)) {
    if (/^MTNODE_/i.test(k) || k === "NODE_OPTIONS") continue;
    childEnv[k] = process.env[k];
  }
  Object.assign(childEnv, env || {});
  const n = ++stdioSeq;
  const outPath = path.join(TMP_STDIO_DIR, "out-" + n + ".txt");
  const errPath = path.join(TMP_STDIO_DIR, "err-" + n + ".txt");
  const read = (p) => {
    try {
      return fs.readFileSync(p, "utf8");
    } catch {
      return "";
    }
  };
  return new Promise((resolve) => {
    const outFd = fs.openSync(outPath, "w");
    const errFd = fs.openSync(errPath, "w");
    const child = spawn(process.execPath, [BRIDGE].concat(args || ["--check"]), {
      cwd: ROOT,
      env: childEnv,
      stdio: ["ignore", outFd, errFd],
    });
    const settle = (extra) => {
      try {
        fs.closeSync(outFd);
      } catch {}
      try {
        fs.closeSync(errFd);
      } catch {}
      resolve(
        Object.assign(
          { code: child.exitCode, stdout: read(outPath), stderr: read(errPath), error: null },
          extra || {},
        ),
      );
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      settle({ error: new Error("子进程超时未退出（30s）") });
    }, 30000);
    child.on("error", (e) => {
      clearTimeout(timer);
      settle({ error: e });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      settle({ code, error: signal ? new Error("子进程被信号终止：" + signal) : null });
    });
  });
}

function parseJson(text) {
  try {
    return JSON.parse(String(text || "").trim() || "null");
  } catch {
    return null;
  }
}

(async () => {
  console.log("stdio 桥默认发现路径冒烟（临时 APPDATA · 真子进程）");
  console.log("桥脚本 " + path.relative(ROOT, BRIDGE));
  const fake = await startFakeServer();
  console.log("假服务端 http://127.0.0.1:" + fake.port + "/mcp");

  /* ── [1] 打包态真实布局：%APPDATA%\pipeline-console\pipeline-console\mcp-server.json ── */
  const ap1 = tmpDir("appdata");
  const userData1 = path.join(ap1, "pipeline-console");
  writeState(path.join(userData1, "pipeline-console"), { enabled: true, port: fake.port, token: fake.token });
  const r1 = await runBridge(["--check"], { APPDATA: ap1, USERPROFILE: ap1, HOME: ap1 });
  const j1 = parseJson(r1.stdout);
  ok(
    !!(j1 && j1.ok === true),
    "打包态默认布局能被发现（%APPDATA%\\pipeline-console\\pipeline-console\\mcp-server.json，且未设 MTNODE_DATA_DIR）",
    "exit=" + r1.code + " stdout=" + r1.stdout.trim().slice(0, 200),
  );
  ok(
    !!(j1 && /pipeline-console[\\/]pipeline-console[\\/]mcp-server\.json$/.test(String(j1.infoFrom || ""))),
    "命中来源就是 userData 层那份状态文件",
    String((j1 && j1.infoFrom) || "(无)"),
  );

  /* ── [2] 什么都没开时（目录里连状态文件都没有 = 全部候选皆死）：
         报错必须自证「找过哪些路径」，且 exit=1 / ok:false ── */
  const ap2 = tmpDir("appdata-empty");
  const missing2 = path.join(ap2, "pipeline-console", "pipeline-console", "mcp-server.json");
  fs.mkdirSync(path.join(ap2, "pipeline-console", "pipeline-console"), { recursive: true });
  const r2 = await runBridge(["--check"], { APPDATA: ap2, USERPROFILE: ap2, HOME: ap2 });
  const j2 = parseJson(r2.stdout) || {};
  const msg2 = String(j2.error || r2.stdout || "");
  ok(j2.ok === false && r2.code === 1, "全部候选皆死时 --check 给 ok:false 且 exit=1", "exit=" + r2.code + " stdout=" + r2.stdout.trim().slice(0, 200));
  ok(/逐个候选探活的结果/.test(msg2), "报错说明是「逐个候选探活」的结果（不再是笼统的找不到运行信息）", msg2.slice(0, 220));
  ok(
    msg2.indexOf(missing2) >= 0,
    "报错里含 userData 层候选（用户能一眼看出差一层）",
    msg2.slice(0, 220),
  );
  ok(
    msg2.indexOf(path.join(ap2, "pipeline-console", "mcp-server.json")) >= 0,
    "报错里同时含应用数据根候选（逐条列候选，不是只列第一个）",
    msg2.slice(0, 220),
  );

  /* ── [3] data-root.json 指针：设置里改过「配置数据目录」 ── */
  const ap3 = tmpDir("appdata-pointer");
  const custom3 = tmpDir("custom-data");
  fs.mkdirSync(path.join(ap3, "pipeline-console"), { recursive: true });
  fs.writeFileSync(path.join(ap3, "pipeline-console", "data-root.json"), JSON.stringify({ path: custom3 }), "utf8");
  writeState(custom3, { enabled: true, port: fake.port, token: fake.token });
  const r3 = await runBridge(["--check"], { APPDATA: ap3, USERPROFILE: ap3, HOME: ap3 });
  const j3 = parseJson(r3.stdout);
  ok(!!(j3 && j3.ok === true), "data-root.json 指向的自定义数据目录能被发现", "exit=" + r3.code + " stdout=" + r3.stdout.trim().slice(0, 200));

  /* ── [4] MTNODE_DATA_DIR 两种写法仍认（兼容兜底，不许被这次的改动弄坏） ──
     注意：仍然给一个**隔离的 APPDATA**，否则桥会退回真实 %APPDATA% 去找状态文件，
     这台机器上真跑着 MTNode 时就会误连真服务端 —— 那样这几项测的就不是环境变量了。 */
  const ap4 = tmpDir("appdata-env");
  fs.mkdirSync(path.join(ap4, "pipeline-console"), { recursive: true });
  const env4 = { APPDATA: ap4, USERPROFILE: ap4, HOME: ap4 };
  const root4 = tmpDir("env-root");
  writeState(path.join(root4, "pipeline-console"), { enabled: true, port: fake.port, token: fake.token });
  const r4a = await runBridge(["--check"], Object.assign({ MTNODE_DATA_DIR: root4 }, env4));
  ok(
    !!(parseJson(r4a.stdout) || {}).ok,
    "MTNODE_DATA_DIR = 应用数据根（其下 pipeline-console\\）仍认得",
    "exit=" + r4a.code + " err=" + String((r4a.error && r4a.error.message) || "-") + " stdout=" + r4a.stdout.trim() + " stderr=" + r4a.stderr.trim().slice(0, 300),
  );
  const dataOnly4 = tmpDir("env-data-only");
  writeState(dataOnly4, { enabled: true, port: fake.port, token: fake.token });
  const r4b = await runBridge(["--check"], Object.assign({ MTNODE_DATA_DIR: dataOnly4 }, env4));
  ok(
    !!(parseJson(r4b.stdout) || {}).ok,
    "MTNODE_DATA_DIR = 数据目录本身仍认得",
    "exit=" + r4b.code + " err=" + String((r4b.error && r4b.error.message) || "-") + " stdout=" + r4b.stdout.trim() + " stderr=" + r4b.stderr.trim().slice(0, 300),
  );

  /* ── [5] 首个候选是死端口（旧进程留下的状态文件）+ 后续候选是活端口 ──
     这一格钉住核心修复：状态文件不保证还有效（多实例共用数据目录会互相覆盖端口）。
     桥必须跳过死端口、采纳后面那个真在监听的候选；采纳死端口 = 服务端其实在跑却报 fetch failed。 */
  const dead5 = await deadPort();
  const ap5 = tmpDir("appdata-stale");
  const live5 = tmpDir("data-live");
  /* 默认数据目录（最优先候选）里放一份**端口已死**的状态文件 */
  writeState(path.join(ap5, "pipeline-console", "pipeline-console"), { enabled: true, port: dead5, token: "tok-stale" });
  /* 显式数据目录（次优先候选）里放活端口 —— 且这份是**后写的**，模拟「多实例覆盖后仍有一份活地址」 */
  writeState(live5, { enabled: true, port: fake.port, token: fake.token });
  const r5 = await runBridge(["--check"], { APPDATA: ap5, USERPROFILE: ap5, HOME: ap5, MTNODE_DATA_DIR: live5 });
  const j5 = parseJson(r5.stdout) || {};
  ok(
    j5.ok === true,
    "首个候选死端口 + 后续候选活端口 → 采纳活的那个（ok:true）",
    "exit=" + r5.code + " stdout=" + r5.stdout.trim().slice(0, 300),
  );
  ok(
    String(j5.url || "") === "http://127.0.0.1:" + fake.port + "/mcp",
    "采纳的就是活候选的地址（http://127.0.0.1:" + fake.port + "/mcp），死端口 " + dead5 + " 没被采纳",
    String(j5.url || "(无)") + " · infoFrom=" + String(j5.infoFrom || "(无)"),
  );

  /* ── [6] 全部候选都是死端口：不许静默，必须逐条列出每个候选的端口与连不上原因 ── */
  const dead6 = await deadPort();
  const ap6 = tmpDir("appdata-dead");
  const data6 = tmpDir("data-dead");
  writeState(path.join(ap6, "pipeline-console", "pipeline-console"), { enabled: true, port: dead6, token: "tok-dead-a" });
  writeState(data6, { enabled: true, port: dead6, token: "tok-dead-b" });
  const r6 = await runBridge(["--check"], { APPDATA: ap6, USERPROFILE: ap6, HOME: ap6, MTNODE_DATA_DIR: data6 });
  const j6 = parseJson(r6.stdout) || {};
  const msg6 = String(j6.error || r6.stdout || "");
  ok(j6.ok === false && r6.code === 1, "全部候选皆死端口时 --check 给 ok:false 且 exit=1", "exit=" + r6.code + " stdout=" + r6.stdout.trim().slice(0, 200));
  const candidates6 = [
    path.join(ap6, "pipeline-console", "pipeline-console", "mcp-server.json"),
    path.join(data6, "mcp-server.json"),
  ];
  const missing6 = candidates6.filter((fp) => msg6.indexOf(fp) < 0);
  ok(missing6.length === 0, "错误正文逐条列出每个候选的状态文件路径", missing6.length ? "缺：" + missing6.join(" / ") : msg6.slice(0, 260));
  ok(
    (msg6.match(/端口 \d+ 连不上（[^）]*）/g) || []).length >= 2,
    "每个死候选都点名端口号 + 连不上原因（不是一句没头没脑的 fetch failed，也不是只列第一个）",
    msg6.slice(0, 360),
  );
  ok(/MTNODE_MCP_URL/.test(msg6), "错误里给出绕法：MTNODE_MCP_URL + MTNODE_MCP_TOKEN 显式指定", msg6.slice(-260));

  fake.server.close();
  console.log("");
  console.log("结果：" + pass + " 项通过" + (fail ? " · " + fail + " 项失败" : " · 全绿"));
  if (fail) {
    console.log("失败项：");
    for (const f of fails) console.log("  - " + f);
  }
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("冒烟自身异常：" + ((e && e.stack) || e));
  cleanup();
  process.exit(1);
});
