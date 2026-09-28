"use strict";
/* SenseNova 本地图像生成（sensenova_gen）端到端联调：electron 替身 + 本机 mock 后端
 *   node test/smoke-sensenova-e2e.js
 *
 * 与 test/smoke-sensenova.js 互补：那边是**源码级契约**（不装环境、不起服务），这边把真实
 * sensenova/main-sensenova.js 的 generateImage 完整跑一遍 —— IPC handler → ensureReady →
 * POST /generate（本机 mock 后端，绝不出网）→ 落盘 → 回执。不装 Python、不下 32.66GB 权重、
 * 不碰用户真实的 8774 后端（config.port 指到 mock 的随机端口，数据目录指到系统临时目录）。
 *
 * 锁住的契约（本轮：节点与后端打通 + 端子泛化 / 临时路径）：
 *   [1] 不传 outputDir / workflowId → 出图落**应用托管目录**（<data>\sensenova\asset-tmp），
 *       回传绝对路径 + managed_output_dir 警告；绝不写应用文件夹
 *   [2] 传 workflowId → 出图复制进画布资产目录（assetDirFor(wfId)，与 proc_image 同一去处）
 *       并删掉临时件
 *   [3] 提示词文本逐字进入 /generate 请求体；抽卡 rollIndex 进文件名（多轮不撞名）；种子 +1
 *   [4] 参考图：核「存在 + 图片后缀」后随 refImages 进 /generate 请求体（图像编辑模式），
 *       读不到的路径进 warnings（ref_image_missing），无效参考图不塞进提示词
 *   [5] 非法输入有明确报错：空提示词 empty_prompt · 缺 nodeId missing_node_id · 后端 400 bad_request
 *   [6] 显式 outputDir 落在应用目录内 → 回落应用托管目录（数据不落应用文件夹）
 *
 * 收尾：关 mock 服务、删临时目录，显式 process.exit（宿主有 unref 的 GPU 轮询与空闲定时器）。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
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
const show = (v) => JSON.stringify(v);
/** 数组逐项比（参考图路径顺序敏感：按连线顺序下发） */
function eqArr(got, want, msg) {
  ok(show(got) === show(want), msg + "（得到 " + show(got) + "，期望 " + show(want) + "）");
}
function eqNum(got, want, msg) {
  ok(Number(got) === Number(want), msg + "（得到 " + show(got) + "，期望 " + show(want) + "）");
}
const ROOT = path.join(__dirname, "..");

/* ---------------------------------------------------------------- */
(async function main() {
  console.log("\n[sensenova e2e] electron 替身 + 本机 mock 后端");

  /* ---------- 临时工作区：数据目录 / 安装目录 / 资产目录 ---------- */
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-sensenova-e2e-"));
  const dataDir = path.join(tmpRoot, "data");
  const installDir = path.join(tmpRoot, "install");
  const assetsDir = path.join(tmpRoot, "assets");
  /* 假安装目录：projectSignals().ready = scaffold && venv（权重缺席不算不可用） */
  fs.mkdirSync(path.join(installDir, "app"), { recursive: true });
  fs.mkdirSync(path.join(installDir, ".venv", "Scripts"), { recursive: true });
  fs.writeFileSync(path.join(installDir, "app", "server.py"), "# mock scaffold\n");
  fs.writeFileSync(path.join(installDir, "app", "engine.py"), "# mock scaffold\n");
  fs.writeFileSync(path.join(installDir, ".venv", "Scripts", "python.exe"), "stub");
  fs.mkdirSync(path.join(dataDir, "sensenova"), { recursive: true });

  /* ---------- mock 后端：冻结契约的 /health · /generate · /progress · /cancel · /shutdown ---------- */
  const PNG_1x1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  let lastBody = null;
  let generateHits = 0;
  const server = http.createServer((req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const u = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && u.pathname === "/health")
      return send(200, {
        ok: true,
        version: "mock-0.1",
        loaded: true,
        modelReady: true,
        vramMode: "fast",
        resolutions: [
          { ratio: "1:1", width: 2048, height: 2048 },
          { ratio: "16:9", width: 2720, height: 1536 },
        ],
      });
    if (req.method === "GET" && u.pathname === "/progress")
      return send(200, { ok: true, pct: 100, message: "mock" });
    if (req.method === "POST" && u.pathname === "/cancel") return send(200, { ok: true });
    if (req.method === "POST" && u.pathname === "/shutdown") return send(200, { ok: true });
    if (req.method === "POST" && u.pathname === "/generate") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let body = null;
        try {
          body = JSON.parse(raw);
        } catch {}
        lastBody = body;
        generateHits++;
        if (!body || !body.outputDir || !body.filename)
          return send(400, { ok: false, error: "bad_request", message: "缺少 outputDir / filename" });
        /* 非法输入：mock 判定 → 后端 400 bad_request（宿主应原样上报错误码） */
        if (String(body.prompt || "").indexOf("ILLEGAL") >= 0)
          return send(400, { ok: false, error: "bad_request", message: "提示词非法（mock 判定）" });
        if (body.ratio === "bad_ratio")
          return send(400, { ok: false, error: "bad_request", message: "ratio 不在官方训练桶里" });
        const out = path.join(body.outputDir, body.filename);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, Buffer.concat([PNG_1x1, Buffer.alloc(4096)]));
        return send(200, {
          ok: true,
          imagePath: out,
          width: Number(body.width) || 2048,
          height: Number(body.height) || 2048,
          ratio: String(body.ratio || "1:1"),
          seed: Number(body.seed) || 0,
          numSteps: Number(body.numSteps) || 30,
          elapsedSec: 0.12,
          peakVramGiB: 0,
          mock: true,
          warnings: [],
        });
      });
      return;
    }
    send(404, { ok: false, error: "not_found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const mockPort = server.address().port;
  ok(mockPort > 0 && mockPort !== 8774, "mock 后端起在随机端口 " + mockPort + "（不碰用户真实的 8774）");

  /* 宿主配置：installDir + mock 端口（loadConfig 读 <data>\sensenova\config.json） */
  fs.writeFileSync(
    path.join(dataDir, "sensenova", "config.json"),
    JSON.stringify({ installDir, port: mockPort, idleMinutes: 0 }, null, 2),
    "utf8",
  );

  /* ---------- electron 替身 ---------- */
  const HANDLERS = new Map();
  const electronStub = {
    app: {
      isPackaged: false,
      getPath: (n) =>
        n === "userData" ? dataDir : n === "exe" ? path.join(ROOT, "mtnode.exe") : dataDir,
      getAppPath: () => ROOT,
      on() {},
      whenReady: () => Promise.resolve(),
      quit() {},
    },
    ipcMain: {
      handle: (ch, fn) => HANDLERS.set(ch, fn),
      on() {},
      removeHandler() {},
    },
    ipcRenderer: {
      send() {},
      sendSync: () => undefined,
      on() {},
      invoke: () => Promise.resolve(),
      removeListener() {},
    },
    BrowserWindow: class {
      loadFile() {}
      on() {}
      static getAllWindows() {
        return [];
      }
    },
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showMessageBox: async () => ({ response: 0 }),
      showErrorBox() {},
    },
    shell: { openPath: async () => "", openExternal: async () => "" },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
    contextBridge: { exposeInMainWorld() {} },
    webUtils: { getPathForFile: () => "" },
  };

  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === "electron") return electronStub;
    return origLoad.apply(this, arguments);
  };
  const HOST_PATH = path.join(ROOT, "sensenova", "main-sensenova.js");
  delete require.cache[require.resolve(HOST_PATH)];
  const host = require(HOST_PATH);
  Module._load = origLoad;

  host.registerSensenovaIpc({
    getDataDir: () => dataDir,
    getMainWin: () => null,
    appRoot: ROOT,
    getDsh: null,
    /* main.js 的 assetDirFor 真源是 assetDir = (wfId) => mk(assetDirPath(wfId))：建目录并返回。
       替身同样建目录，否则 copyFileSync 会因目标目录不存在而走 asset_copy_failed 分支。 */
    assetDirFor: (wfId) => {
      const d = path.join(assetsDir, String(wfId || "default"));
      fs.mkdirSync(d, { recursive: true });
      return d;
    },
  });
  const generate = HANDLERS.get("sensenova:generate");
  ok(typeof generate === "function", "宿主注册了 sensenova:generate（真实 IPC handler）");
  const tmpOutDir = path.join(dataDir, "sensenova", "asset-tmp");
  const consoleLog = path.join(dataDir, "sensenova", "console.log");

  /* ===================== [1] 不设输出路径 → 落应用托管目录 ===================== */
  console.log("\n[1] 不传 outputDir / workflowId：出图落应用托管目录");
  const prompt1 = "清晨薄雾里的雪山湖泊，写实风光摄影，柔和逆光";
  const r1 = await generate(null, {
    nodeId: "sensenova-e2e-0001",
    prompt: prompt1,
    ratio: "1:1",
    width: 2048,
    height: 2048,
    seed: 7,
  });
  ok(r1 && r1.ok === true, "[1] 出图成功（得到 " + show(r1 && (r1.error || "ok")) + "）");
  const p1 = String((r1 && r1.path) || "");
  ok(p1.startsWith(tmpOutDir + path.sep), "[1] 产物落应用托管目录 asset-tmp（得到 " + p1 + "）");
  ok(!p1.startsWith(ROOT + path.sep), "[1] 绝不落应用文件夹（" + ROOT + "）");
  ok(fs.existsSync(p1), "[1] 回传的是已落盘的绝对路径");
  if (fs.existsSync(p1)) {
    const head = fs.readFileSync(p1).subarray(0, 8);
    ok(
      head[0] === 0x89 && head.subarray(1, 4).toString("latin1") === "PNG",
      "[1] 产物是合法 PNG（魔数校验 " + head.toString("hex") + "）",
    );
  } else ok(false, "[1] 产物是合法 PNG（文件不存在，跳过）");
  ok(Number(r1.bytes) >= 1024, "[1] 回执带字节数（" + (r1 && r1.bytes) + "）");
  ok(
    Array.isArray(r1.warnings) && r1.warnings.some((w) => String(w).indexOf("managed_output_dir") >= 0),
    "[1] 回执明说这是应用托管目录（managed_output_dir 警告）",
  );
  ok(Number(r1.seed) === 7 && Number(r1.nextSeed) === 8, "[3] 种子沿用 + 回传 nextSeed = seed+1");

  /* ===================== [3] 提示词 / 抽卡编号进请求 ===================== */
  console.log("\n[3] 提示词进请求体 · rollIndex 落文件名 · 多轮不撞名");
  ok(lastBody && lastBody.prompt === prompt1, "[3] 装配后的提示词逐字进入 /generate 请求体");
  ok(String(lastBody && lastBody.outputDir) === tmpOutDir, "[3] 请求体 outputDir = 托管临时目录");
  ok(/\.png$/.test(String(lastBody && lastBody.filename)), "[3] 请求体文件名以 .png 结尾");
  ok(String(lastBody && lastBody.ratio) === "1:1", "[3] 画幅桶原样下发（ratio）");

  const r3a = await generate(null, {
    nodeId: "sensenova-e2e-0003",
    workflowId: "wf-e2e",
    prompt: "抽卡第一张",
    ratio: "1:1",
    width: 2048,
    height: 2048,
    rollIndex: 1,
  });
  const nameA = String(lastBody && lastBody.filename);
  const r3b = await generate(null, {
    nodeId: "sensenova-e2e-0003",
    workflowId: "wf-e2e",
    prompt: "抽卡第二张",
    ratio: "1:1",
    width: 2048,
    height: 2048,
    rollIndex: 2,
  });
  const nameB = String(lastBody && lastBody.filename);
  ok(r3a && r3a.ok === true && r3b && r3b.ok === true, "[3] 同一节点连跑两轮都成功");
  ok(nameA !== nameB, "[3] 两轮资产名不同（rollIndex 修掉了撞名）");
  ok(/#1\.png$/.test(nameA) && /#2\.png$/.test(nameB), "[3] rollIndex 编号进文件名（take 标记 #N：" + nameA + " / " + nameB + "）");

  /* ===================== [2] 带 workflowId → 画布资产目录 ===================== */
  console.log("\n[2] 带 workflowId：复制进画布资产目录并删临时件");
  const assetFileA = path.join(assetsDir, "wf-e2e", nameA);
  const tmpFileA = path.join(tmpOutDir, nameA);
  ok(String(r3a.path) === assetFileA, "[2] 回传的是资产目录里的绝对路径（得到 " + r3a.path + "）");
  ok(fs.existsSync(assetFileA), "[2] 资产文件真实存在（与 proc_image 同一去处）");
  ok(!fs.existsSync(tmpFileA), "[2] 临时件已删除（复制后清理，" + tmpFileA + "）");

  /* ===================== [4] 参考图：真的下发（图像编辑模式） ===================== */
  console.log("\n[4] 参考图入参：核路径后随 refImages 下发后端（图像编辑模式）");
  const refA = path.join(tmpRoot, "ref-a.png");
  const refB = path.join(tmpRoot, "ref-b.png");
  const refMissing = path.join(tmpRoot, "ref-missing.png");
  fs.writeFileSync(refA, PNG_1x1);
  fs.writeFileSync(refB, PNG_1x1);
  const r4 = await generate(null, {
    nodeId: "sensenova-e2e-0004",
    prompt: "按参考图改造",
    ratio: "1:1",
    width: 2048,
    height: 2048,
    refImages: [refA, refMissing, refB, refA],
  });
  ok(r4 && r4.ok === true, "[4] 带参考图照常出图");
  eqArr(lastBody && lastBody.refImages, [refA, refB], "[4] /generate 请求体带 refImages（不存在的路径被剔除、重复去重）");
  ok(r4 && r4.mode === "edit", "[4] 回执 mode = edit（图像编辑模式，参考图参与条件）");
  eqArr(r4 && r4.refImages, [refA, refB], "[4] 回执 refImages 只含真正下发的路径");
  eqNum(r4 && r4.refImagesUsed, 2, "[4] 回执 refImagesUsed = 2");
  ok(
    Array.isArray(r4.warnings) && r4.warnings.some((w) => String(w).indexOf("ref_image_missing") >= 0),
    "[4] 读不到的参考图逐条进 warnings（ref_image_missing，不静默）",
  );
  ok(r4.referenceIgnored === undefined, "[4] 回执不再有 referenceIgnored 降级字段");
  ok(String(lastBody && lastBody.prompt) === "按参考图改造", "[4] 提示词照常进请求");
  ok(String(lastBody && lastBody.prompt).indexOf(".png") < 0, "[4] 参考图路径没有被塞进提示词正文");
  ok(
    fs.existsSync(consoleLog) && fs.readFileSync(consoleLog, "utf8").indexOf("ref_image_missing") >= 0,
    "[4] 控制台日志留痕（[job] warn ref_image_missing）",
  );
  /* 无参考图时不得下发 refImages（纯文生图路径保持不变） */
  const r4b = await generate(null, {
    nodeId: "sensenova-e2e-0004b",
    prompt: "纯文生图",
    ratio: "1:1",
    width: 2048,
    height: 2048,
  });
  ok(r4b && r4b.ok === true && !("refImages" in (lastBody || {})), "[4] 不传参考图 → 请求体不带 refImages（t2i）");
  ok(r4b && r4b.mode === "t2i", "[4] 回执 mode = t2i（纯文生图）");

  /* ===================== [5] 非法输入：明确报错 ===================== */
  console.log("\n[5] 非法输入：明确错误码，不打后端 / 原样上报");
  const hitsBefore = generateHits;
  const r5 = await generate(null, { nodeId: "sensenova-e2e-0005", prompt: "   " });
  ok(r5 && r5.ok === false && r5.error === "empty_prompt", "[5] 空提示词 → empty_prompt（得到 " + show(r5 && r5.error) + "）");
  ok(generateHits === hitsBefore, "[5] 空提示词前置拦截，不请求后端");
  const r6 = await generate(null, { prompt: "x" });
  ok(r6 && r6.ok === false && r6.error === "missing_node_id", "[5] 缺 nodeId → missing_node_id（得到 " + show(r6 && r6.error) + "）");
  const r7 = await generate(null, {
    nodeId: "sensenova-e2e-0007",
    prompt: "ILLEGAL 非法输入",
    ratio: "1:1",
    width: 2048,
    height: 2048,
  });
  ok(r7 && r7.ok === false && r7.error === "bad_request", "[5] 后端 400 bad_request → 原样上报错误码（得到 " + show(r7 && r7.error) + "）");
  ok(String((r7 && r7.message) || "").length > 0, "[5] 带后端给的错误正文（" + show(r7 && r7.message) + "）");
  ok(
    fs.readFileSync(consoleLog, "utf8").indexOf("bad_request") >= 0,
    "[5] 控制台日志留痕（[job] error: bad_request）",
  );

  /* ===================== [6] 应用目录内的 outputDir → 回落 ===================== */
  console.log("\n[6] 显式 outputDir 落在应用目录内：回落应用托管目录");
  const inApp = path.join(ROOT, "e2e-should-not-exist");
  const r8 = await generate(null, {
    nodeId: "sensenova-e2e-0008",
    prompt: "应用目录回落",
    ratio: "1:1",
    width: 2048,
    height: 2048,
    outputDir: inApp,
  });
  ok(r8 && r8.ok === true, "[6] 出图成功（目录被回落，不是失败）");
  ok(String(r8 && r8.path).startsWith(tmpOutDir + path.sep), "[6] 产物落应用托管目录（得到 " + (r8 && r8.path) + "）");
  ok(!fs.existsSync(inApp), "[6] 应用目录里没有新建任何产物目录");
  ok(
    Array.isArray(r8.warnings) && r8.warnings.some((w) => String(w).indexOf("output_dir_inside_app") >= 0),
    "[6] 回声明说回落原因（output_dir_inside_app）",
  );

  /* ===================== 收尾 ===================== */
  await new Promise((resolve) => server.close(resolve));
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}

  console.log("\n———— " + (checks - fails) + "/" + checks + " 通过 ————");
  if (fails) {
    console.log(fails + " 项失败");
    process.exit(1);
  }
  console.log("全部通过");
  process.exit(0);
})().catch((e) => {
  console.log("FAIL  端到端联调异常：" + ((e && e.stack) || e));
  process.exit(1);
});
