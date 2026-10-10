"use strict";
/* test/smoke-apps-branch-merge-e2e.js — 版本合并（端到端，纯 Node，不起 Electron、不联网）
 *   node test/smoke-apps-branch-merge-e2e.js
 *
 * 与 test/smoke-apps-branch-merge.js 的分工：那一只测**算法与单元判定**（假依赖），
 * 这一只测**接线** —— 用真实 apps-store.js（假 electron 垫片）+ 真实 preload 参数表，
 * 起一个本地 http「云端」（catalog.json + 分支 zip），走完整条链：
 *   dev 目录判定 → 按 ?owner=&version= 解析下载地址 → 真 http 下载 → 真 sha256 校验
 *   → 真 unzipBuffer 解包到暂存目录 → 整目录备份 → 文件级差异清单
 *   → Agent 写 .merge-done.json 宣布结束 → 主进程补 merges 留痕 + 清暂存（看门狗那条路也走一遍）。
 *
 * 覆盖（本轮口径，见 app-branch-merge.js 的文件头）：
 *   [1] preload 参数表：appsMergePull 带 ownerId；旧的 mergePlan / mergeRun 已删
 *   [2] apps:mergeInfo 只对「在本机开发目录里」的应用回 dev:true
 *   [3] 拉取：真下载 + 真校验 + 真解包 + 真备份；排除清单在真路径上同样生效；**不写开发目录**
 *   [4] 结束声明：没写 = 什么都不动；写了 = 补一条 merges 留痕 + 清暂存，**版本号不动**
 *   [5] 旧暂存由下一次拉取清掉；看门狗把收尾结果推给界面（apps:mergeDone）
 *
 * 只写临时目录（os.tmpdir 下的工作区）：不碰仓库、不碰真实 %APPDATA% 的应用目录。
 * ============================================================================ */
/* 图标：一张 1x1 png 的 data URL。合并流程根本不读图标（只有安装写清单时才认它），
   这里放着只为让目录条目的形状与线上一致。 */
const ICON_DATAURL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const zlib = require("zlib");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-merge-e2e-"));
/* ── zip 打包：与安装路径同一形状（deflate），交给真 unzipBuffer 解 ── */
function zipOf(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, "utf8");
    let method = 8;
    let body = zlib.deflateRawSync(raw);
    if (body.length >= raw.length) {
      method = 0;
      body = raw;
    }
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const lp = Buffer.concat(locals);
  const cp = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cp.length, 12);
  end.writeUInt32LE(lp.length, 16);
  return Buffer.concat([lp, cp, end]);
}

let fails = 0;
function ok(cond, msg) {
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
}

(async () => {
  /* ── 本机开发目录里的应用（真 app.json 形状） ── */
  const devRoot = path.join(TMP, "dev-root");
  const appDir = path.join(devRoot, "wordless");
  fs.mkdirSync(path.join(appDir, "storage"), { recursive: true });
  fs.writeFileSync(path.join(appDir, "index.html"), "<h1>mine</h1>\n");
  fs.writeFileSync(path.join(appDir, "game.js"), "const A = 1;\nconst B = 2;\n");
  fs.writeFileSync(path.join(appDir, "only-mine.js"), "// 只有我有\n");
  fs.writeFileSync(path.join(appDir, "storage", "store.json"), '{"myScore":42}');
  fs.writeFileSync(path.join(appDir, "app.json"), JSON.stringify({
    schema: 1, id: "wordless", kind: "window", name: "wordless", title: "Wordless", entry: "index.html",
    version: "1.0.0", description: "d", icon: "", author: "ms2308", tags: [], dev: true,
    forkOf: { id: "wordless", ownerId: "u_b33738db79310ff5", owner: "ms2308" },
    cloud: { id: "wordless", ownerId: "u_b33738db79310ff5", owner: "ms2308", version: "1.0.0", at: 1 },
    capabilities: { textInput: true, imageGen: false },
  }, null, 0));

  /* ── 本地「云端」：目录 + 分支 zip（含对方新增的文件、改过的文件与不该被合的东西） ── */
  const zip = zipOf([
    { name: "index.html", data: "<h1>theirs</h1>\n" },
    { name: "game.js", data: "const A = 1;\nconst B = 2;\nconst C = 3;\n" },
    { name: "newfile.js", data: "console.log('their new file');\n" },
    { name: "storage/store.json", data: '{"theirs":true}' },
    { name: "wordless.mtnodes", data: '{"theirs":true}' },
    { name: "app.json", data: '{"id":"wordless","version":"9.9.9","author":"别人"}' },
  ]);
  const catalog = {
    version: 1,
    updatedAt: new Date().toISOString(),
    apps: [
      {
        id: "wordless", ownerId: "u_b33738db79310ff5", familyRootId: "wordless", trunk: true,
        familyRootOwnerId: "u_b33738db79310ff5", parentOwnerId: "", title: "Wordless",
        version: "1.0.0", latestVersion: "1.0.0",
        versions: [{ version: "1.0.0", createdAt: 1000, bytes: 10, sha256: "" }],
        desc: "d", description: "d", icon: ICON_DATAURL, thumb: "", shots: [], shotsThumb: [], shotsSha: [],
        zipUrl: "wordless__u_b33738db79310ff5.zip", url: "wordless__u_b33738db79310ff5.zip", sha256: "",
        owner: "ms2308", ownerName: "ms2308", forkOf: null, entry: "index.html", tags: [], bytes: 10,
        createdAt: 1000, updatedAt: 1000,
      },
      {
        id: "wordless", ownerId: "u_40c0d0252539e484", familyRootId: "wordless", trunk: false,
        familyRootOwnerId: "u_b33738db79310ff5", parentOwnerId: "u_b33738db79310ff5", title: "Wordless",
        version: "1.0.1", latestVersion: "1.0.1",
        versions: [{ version: "1.0.1", createdAt: 2000, bytes: zip.length, sha256: sha256Of(zip), note: "修了两个 bug" }],
        desc: "d", description: "d", icon: ICON_DATAURL, thumb: "", shots: [], shotsThumb: [], shotsSha: [],
        zipUrl: "wordless/u_40c0d0252539e484/1.0.1.zip", url: "wordless/u_40c0d0252539e484/1.0.1.zip",
        sha256: sha256Of(zip), owner: "u_f2bea279", ownerName: "Tester",
        forkOf: { id: "wordless", ownerId: "u_b33738db79310ff5", owner: "ms2308", ownerName: "ms2308" },
        entry: "index.html", tags: [], bytes: zip.length, createdAt: 2000, updatedAt: 2000,
      },
    ],
  };
  const srv = http.createServer((req, res) => {
    const u = req.url.split("?")[0];
    if (u === "/catalog.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(catalog));
      return;
    }
    if (u === "/wordless/u_40c0d0252539e484/1.0.1.zip") {
      res.writeHead(200, { "content-type": "application/zip", "content-length": zip.length });
      res.end(zip);
      return;
    }
    res.writeHead(404);
    res.end("nope");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  console.log("本地云端：http://127.0.0.1:" + port + "（catalog.json + 分支 zip）");

  /* ── 用真 apps-store.js（假 electron 垫片）+ 真 preload 参数表 ── */
  process.env.MTNODE_APPS_URL = "http://127.0.0.1:" + port;
  fs.mkdirSync(TMP, { recursive: true });
  fs.writeFileSync(path.join(TMP, "config.json"), JSON.stringify({ apps: { projectDir: devRoot, installDir: path.join(TMP, "down-root") } }), "utf8");
  const handlers = new Map();
  const sent = [];
  const fakeElectron = {
    app: { getAppPath: () => ROOT, getPath: () => TMP, on: () => {}, isPackaged: false },
    BrowserWindow: function () { return { loadFile() {}, on() {}, webContents: { on() {}, send() {} }, isDestroyed: () => true, once() {} }; },
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: () => {}, removeHandler: () => {} },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showMessageBox: async () => ({ response: 0 }) },
    shell: { openPath: async () => "", openExternal: async () => "" },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
    protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
    session: { fromPartition: () => ({ webRequest: { onHeadersReceived: () => {} }, setPermissionRequestHandler: () => {} }) },
    contextBridge: { exposeInMainWorld: () => {} },
    ipcRenderer: { invoke: () => {}, on: () => {}, send: () => {}, removeAllListeners: () => {} },
  };
  const origLoad = Module._load;
  Module._load = function (req) {
    if (req === "electron") return fakeElectron;
    return origLoad.apply(this, arguments);
  };
  const store = require(path.join(ROOT, "apps-store.js"));
  require(path.join(ROOT, "preload.js"));
  Module._load = origLoad;
  const paramsOf = (name) => {
    const src = fs.readFileSync(path.join(ROOT, "preload.js"), "utf8");
    const re = new RegExp(name + ":\\s*\\(([^)]*)\\)");
    const m = re.exec(src);
    return m ? m[1] : "";
  };
  store.registerAppsIpc({
    getDataDir: () => TMP,
    locale: () => "zh",
    /* 界面那一侧：收尾事件走 webContents.send（这里只把它记下来） */
    getMainWin: () => ({ isDestroyed: () => false, webContents: { send: (ch, data) => sent.push({ ch: ch, data: data }) } }),
  });
  const call = (ch, arg) => {
    const fn = handlers.get(ch);
    if (!fn) throw new Error("通道没注册：" + ch);
    return fn({}, arg);
  };
  const stagingRoot = path.join(TMP, "runtime-tmp", "app-merge");
  const stagingDirsOf = (id) =>
    fs.existsSync(stagingRoot)
      ? fs.readdirSync(stagingRoot).filter((n) => {
          try {
            return JSON.parse(fs.readFileSync(path.join(stagingRoot, n, "merge.json"), "utf8")).appId === id;
          } catch {
            return false;
          }
        })
      : [];

  console.log("\n[端到端] 用真 apps-store 的接线跑「拉取别人的分支 → Agent 确认后落地」");
  ok(paramsOf("appsMergePull").indexOf("ownerId") >= 0, "preload 的 appsMergePull 参数表带 ownerId（分支点选）");
  ok(!/appsMergePlan|appsMergeRun/.test(fs.readFileSync(path.join(ROOT, "preload.js"), "utf8")), "preload 里旧的预演 / 脚本合并入口已删");
  const info = await call("apps:mergeInfo", { id: "wordless" });
  ok(info.ok && info.dev === true && info.version === "1.0.0" && info.pending === null, "apps:mergeInfo：开发目录里的应用 dev:true v1.0.0、还没有待收尾的暂存");

  const pull = await call("apps:mergePull", { id: "wordless", ownerId: "u_40c0d0252539e484", version: "1.0.1" });
  ok(pull.ok === true, "apps:mergePull 走真目录 + 真下载 + 真 sha256 校验 + 真解包：" + (pull.ok ? "" : pull.error));
  ok(pull.their && pull.their.author === "Tester" && pull.their.version === "1.0.1" && pull.their.note === "修了两个 bug", "回执里点到了 Tester 的 v1.0.1（带版本说明）");
  ok(pull.files.every((f) => !f.content && !f.binarySrc && !/^[A-Za-z]:/.test(String(f.rel))), "回给渲染层的清单不含文件正文与绝对路径");
  const kinds = Object.create(null);
  for (const f of pull.files) kinds[f.rel] = f.kind;
  ok(kinds["newfile.js"] === "add", "对方新增文件识别为 add");
  ok(kinds["only-mine.js"] === "local", "「只有我有」的文件进清单但标 local（一律保留）");
  ok(kinds["storage/store.json"] === undefined && kinds["wordless.mtnodes"] === undefined && kinds["app.json"] === undefined, "排除清单在真下载路径上同样生效（storage / 画布 / app.json 不在清单里）");
  ok(pull.staging.indexOf(stagingRoot) === 0 && fs.existsSync(pull.staging), "对方那一版解在数据目录的暂存目录里（" + pull.staging + "）");
  ok(fs.existsSync(path.join(pull.staging, "merge.json")), "暂存目录里有 merge.json（谁的那一版、备份在哪）");
  ok(fs.readFileSync(path.join(appDir, "game.js"), "utf8").indexOf("const C") < 0 && !fs.existsSync(path.join(appDir, "newfile.js")), "拉取**不写开发目录**（写盘是会话里 Agent 的活）");
  ok(fs.existsSync(pull.backupDir) && fs.readFileSync(path.join(pull.backupDir, "game.js"), "utf8").indexOf("const C") < 0, "拉取前整目录备份在（备份里是合并前的原文件）");
  ok(!fs.existsSync(path.join(appDir, "MERGE-REPORT.md")), "没有任何报告文件落到开发目录");

  const end0 = await call("apps:mergeEnd", { id: "wordless", staging: pull.staging });
  ok(end0.ok === true && end0.declared === false && fs.existsSync(pull.staging), "Agent 还没宣布结束时：不落留痕、不删暂存");
  ok(JSON.parse(fs.readFileSync(path.join(appDir, "app.json"), "utf8")).version === "1.0.0", "没有结束声明时 app.json 的版本号一个字节都没动");

  /* Agent 按用户逐项确认的结果落地（这里用最朴素的方式模拟：把采用的两份拷过去），再写结束声明 */
  fs.copyFileSync(path.join(pull.srcDir, "newfile.js"), path.join(appDir, "newfile.js"));
  fs.writeFileSync(path.join(appDir, "game.js"), fs.readFileSync(path.join(pull.srcDir, "game.js")));
  fs.writeFileSync(
    path.join(pull.staging, ".merge-done.json"),
    JSON.stringify({ done: true, files: ["game.js", "newfile.js"], version: "" }),
    "utf8",
  );
  const end1 = await call("apps:mergeEnd", { id: "wordless", staging: pull.staging });
  ok(end1.ok === true && end1.declared === true && end1.removed === true, "写了结束声明之后：补留痕 + 清暂存");
  ok(!fs.existsSync(pull.staging), "暂存目录真的没了");
  const man = JSON.parse(fs.readFileSync(path.join(appDir, "app.json"), "utf8"));
  ok(man.version === "1.0.0", "合并**不改版本号**（还是 1.0.0；对方是 1.0.1、包里那份更是 9.9.9）");
  ok(man.dev === true && man.cloud && man.cloud.version === "1.0.0" && man.author === "ms2308", "app.json 的 dev / cloud / 作者留痕原样保留（对方那份 app.json 没顶上来）");
  ok(Array.isArray(man.merges) && man.merges.length === 1 && man.merges[0].author === "Tester" && man.merges[0].version === "1.0.1", "补了一条 merges 留痕（Tester v1.0.1）");
  ok(fs.readFileSync(path.join(appDir, "game.js"), "utf8").indexOf("const C") >= 0 && fs.existsSync(path.join(appDir, "newfile.js")), "用户确认采用的那两项落了盘");
  ok(fs.readFileSync(path.join(appDir, "storage", "store.json"), "utf8") === '{"myScore":42}', "本机存档 storage/store.json 没被动（真路径同样守住）");
  ok(fs.existsSync(path.join(appDir, "only-mine.js")), "「只有我有」的文件照旧在（一律保留）");
  ok(!fs.existsSync(path.join(appDir, "wordless.mtnodes")), "对方的画布文件没被合进来（*.mtnodes 走排除清单）");
  ok(fs.readdirSync(appDir).filter((n) => n.indexOf("MERGE-REPORT") >= 0).length === 0, "合并收尾后开发目录里也没有报告文件");

  /* 旧暂存：上一次没宣布结束留下的那一份，由下一次拉取清掉；看门狗把收尾结果推给界面 */
  const stale = path.join(stagingRoot, "wordless-stale-v0.9.0");
  fs.mkdirSync(stale, { recursive: true });
  fs.writeFileSync(path.join(stale, "merge.json"), JSON.stringify({ appId: "wordless", at: Date.now() - 5000 }), "utf8");
  const pull2 = await call("apps:mergePull", { id: "wordless", ownerId: "u_40c0d0252539e484", version: "1.0.1" });
  ok(pull2.ok === true && !fs.existsSync(stale), "上一次留下的暂存目录在这次拉取时清掉了");
  ok(stagingDirsOf("wordless").length === 1, "同一时刻这个应用只有一份暂存（" + stagingDirsOf("wordless").join(",") + "）");
  const pending = (await call("apps:mergeInfo", { id: "wordless" })).pending;
  ok(pending && pending.done === false && pending.version === "1.0.1", "mergeInfo 的 pending 报出这次没宣布结束的暂存");
  sent.length = 0;
  fs.writeFileSync(path.join(pull2.staging, ".merge-done.json"), JSON.stringify({ done: true, files: [], version: "" }), "utf8");
  const got = await new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      const hit = sent.filter((m) => m.ch === "apps:mergeDone")[0];
      if (hit) return resolve(hit);
      if (Date.now() - t0 > 8000) return resolve(null);
      setTimeout(tick, 200);
    };
    tick();
  });
  ok(!!got && got.data && got.data.declared === true && got.data.removed === true, "看门狗看到结束声明后自动收尾，并把结果推给界面（apps:mergeDone）");
  ok(!fs.existsSync(pull2.staging) && stagingDirsOf("wordless").length === 0, "看门狗收尾后暂存目录也没了");
  const man2 = JSON.parse(fs.readFileSync(path.join(appDir, "app.json"), "utf8"));
  ok(man2.merges.length === 2 && man2.version === "1.0.0", "第二次合并又补了一条留痕，版本号依旧没动");

  console.log("\n" + (fails ? "FAILED " + fails : "端到端全部通过"));
  try { srv.close(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.log("异常：" + ((e && e.stack) || e));
  process.exit(1);
});

function sha256Of(buf) {
  return require("crypto").createHash("sha256").update(buf).digest("hex");
}
