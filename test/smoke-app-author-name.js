"use strict";
/* 应用市场的「作者 / 上传者」显示名 —— 本轮需求（版本选择里显示 uid 而不是昵称）的回归
 *   node test/smoke-app-author-name.js
 *
 * 需求一句话：微信 / 手机号扫码自动建号的账号，username 是系统生成的占位名（`u_f2bea279`），
 * 于是应用市场的分支树 / 版本行把作者显示成了 uid 样的字符串。口径定案（与用户逐轮确认）：
 *   · 显示名 = 账号**昵称**（服务端按 uid **实时解析**，作者改一次昵称处处同步）；
 *   · 昵称为空才回落账号名，且占位名（`u_` + 十六进制）不算名字；都没有 → 「未知作者」；
 *   · **`owner` / `uploader` 保持账号名语义不变**（客户端的「同作者」判定与下载寻址按它比对），
 *     显示名走**新增**字段 `ownerName` / `uploaderName`；
 *   · 同一个 id 下两条分支昵称相同时补「#<ownerId 末 6 位>」区分；
 *   · 本机条目仍按 app.json 的 author 显示（离线可读）；
 *   · 改昵称时服务端顺带重刷静态目录（catalog.json 是快照，不重刷就还是旧名字）。
 *
 * 覆盖：
 *   [1] 真起 store-saas（临时 DATA_DIR + MTNODE_APPS_WEB_DIR + 种子库）：
 *       目录 / 详情 / 版本接口的 ownerName · uploaderName 按 uid 实时解析；
 *       老字段 owner · uploader · nickname 原样保留；改昵称 → 静态目录立刻跟着变；
 *       名下没有应用的账号改昵称不重刷目录（不做无谓写盘）。
 *   [2] 客户端主进程 apps-store.js 真跑（真 HTTP 假目录）：ownerName / uploaderName 进条目与版本项；
 *       老目录没有这两个字段 → 空串，不报错、不把 uid 当名字。
 *   [3] 渲染层 app-apps.js 真跑（vm 沙箱）：显示名规则、重名补短 uid、上传者显示名。
 *   [4] 渲染层 app-publish.js 真跑（vm 沙箱）：与 app-apps.js **同一组用例结果一致**（两处实现不许漂）。
 *   [5] 契约文档：docs/apps-market.md 的字段表写明 ownerName / uploaderName 与显示口径。
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const vm = require("vm");
const http = require("http");
const crypto = require("crypto");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel.split("/").join(path.sep)));

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-author-name-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("smoke-app-author-name：应用市场作者名 = 账号昵称（按 uid 实时解析）\n");

/* ================= 种子数据（真实两种账号形态：占位名 + 真账号名） =================
 * A 毛桑（真账号名 ms2308，有密码）· B Tester（微信占位名 u_f2bea279，无密码）
 * C Tester（占位名，与 B 同名 → 考重名）· D 无名（昵称空 + 占位名 → 考「未知作者」）
 * E carol（昵称空 + 真账号名 → 回落账号名）· F 无应用账号（考「改名不重刷目录」） */
const PW = "smoke-pass";
const SALT = "smoke-salt";
const passHash = () => crypto.scryptSync(PW, SALT, 32).toString("hex");
const U = {
  A: "u_b33738db79310ff5",
  B: "u_40c0d0252539e484",
  C: "u_cccccccccccccccc",
  D: "u_dddddddddddddddd",
  E: "u_eeeeeeeeeeeeeeee",
  F: "u_ffffffffffffffff",
};
const APP_ID = "author-name-app";

function seedDb() {
  const now = Date.now();
  const ver = (v, uploader, uploaderId, at, note) => ({
    version: v,
    parentVersion: "",
    bytes: 120,
    sha256: crypto.createHash("sha256").update(APP_ID + v).digest("hex"),
    entry: "index.html",
    note: note || "",
    uploader: uploader,
    uploaderId: uploaderId,
    createdAt: at,
    declarationAt: at,
  });
  const branch = (userId, version, at, forkOf) =>
    Object.assign(
      {
        id: APP_ID,
        userId: userId,
        title: "作者名冒烟应用",
        description: "考作者显示名",
        version: version,
        latestVersion: version,
        entry: "index.html",
        tags: ["测试"],
        bytes: 120,
        sha256: crypto.createHash("sha256").update(APP_ID + version).digest("hex"),
        downloads: 0,
        createdAt: at,
        updatedAt: at,
        versions: [ver(version, uploaderSnapshotOf(userId), userId, at)],
      },
      forkOf ? { forkOf: forkOf } : {},
    );
  return {
    version: 1,
    savedAt: now,
    users: [
      { id: U.A, username: "ms2308", nickname: "毛桑", salt: SALT, pass: passHash(), createdAt: 1 },
      { id: U.B, username: "u_f2bea279", nickname: "Tester", createdAt: 2 },
      { id: U.C, username: "u_1234abcd", nickname: "Tester", createdAt: 3 },
      { id: U.D, username: "u_deadbeef", nickname: "", createdAt: 4 },
      { id: U.E, username: "carol", nickname: "", salt: SALT, pass: passHash(), createdAt: 5 },
      { id: U.F, username: "u_0f0f0f0f", nickname: "没有应用的人", createdAt: 6 },
    ],
    /* 同 id 五条分支：每条一个作者（客户端按 ownerId 归组，主干 = createdAt 最早） */
    apps: [
      branch(U.A, "1.0.0", 1000),
      /* B 是二次开发分支：forkOf 指回 A（考「二次开发自」那行的显示名） */
      branch(U.B, "1.0.1", 2000, { id: APP_ID, ownerId: U.A, owner: "ms2308" }),
      branch(U.C, "1.0.2", 3000),
      branch(U.D, "1.0.3", 4000),
      branch(U.E, "1.0.4", 5000),
    ],
    sessions: [],
    identities: [],
    templates: [],
    skills: [],
    tips: [],
    appDeclarations: [],
  };
}
/* 版本记录里的 uploader 是**上传当时的账号名快照**——测试就用它（历史记录正是这种形态） */
function uploaderSnapshotOf(userId) {
  return (
    {
      [U.A]: "ms2308",
      [U.B]: "u_f2bea279",
      [U.C]: "u_1234abcd",
      [U.D]: "u_deadbeef",
      [U.E]: "carol",
    }[userId] || userId
  );
}

async function main() {
  await partServer();
  await partMainStore();
  partRendererApps();
  partRendererPublish();
  partDocs();
}

/* 入口放在**所有常量之后**：种子数据用的 U / PW / SALT 都是 const（TDZ），提前调用会直接抛 */
main().then(
  () => {
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch (_) {}
    console.log("\n" + (fails ? "FAIL " + fails : "PASS") + " / " + checks + " 项断言");
    process.exit(fails ? 1 : 0);
  },
  (e) => {
    console.log("FAIL 测试自身抛出：" + ((e && e.stack) || e));
    process.exit(1);
  },
);

/* ============ [1] 真起 store-saas：显示名字段 + 改昵称重刷目录 ============ */
async function partServer() {
  console.log("[1] 真起 store-saas：ownerName / uploaderName 按 uid 实时解析 · 改昵称重刷静态目录");
  if (!exists("store-saas/server.mjs")) {
    ok(false, "store-saas/server.mjs 存在");
    return;
  }
  const E2E = path.join(TMP, "e2e");
  const DATA = path.join(E2E, "data");
  const WEB = path.join(E2E, "apps-web");
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(WEB, { recursive: true });
  const dbPath = path.join(DATA, "db.json");
  fs.writeFileSync(dbPath, JSON.stringify(seedDb(), null, 2));
  const catalogPath = path.join(WEB, "catalog.json");

  const port = 20000 + Math.floor(Math.random() * 20000);
  const logPath = path.join(E2E, "server.log");
  const logFd = fs.openSync(logPath, "a");
  const { spawn } = require("child_process");
  const child = spawn(process.execPath, [path.join(ROOT, "store-saas", "server.mjs")], {
    env: Object.assign({}, process.env, {
      DATA_DIR: DATA,
      PORT: String(port),
      HOST: "127.0.0.1",
      MTNODE_APPS_WEB_DIR: WEB,
      /* 版本开关默认开，这里显式钉死，免得将来默认值变了这条用例跟着漂 */
      MTNODE_APP_VERSIONS: "1",
    }),
    stdio: ["ignore", logFd, logFd],
  });
  const base = "http://127.0.0.1:" + port;
  const api = async (method, p, body, token) => {
    const res = await fetch(base + p, {
      method: method,
      headers: Object.assign(
        { "Content-Type": "application/json" },
        token ? { Authorization: "Bearer " + token } : {},
      ),
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try {
      const text = await res.text();
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      data = null;
    }
    return { status: res.status, data: data };
  };
  try {
    let up = false;
    for (let i = 0; i < 80; i++) {
      try {
        const r = await fetch(base + "/api/health");
        if (r.ok) {
          up = true;
          break;
        }
      } catch (_) {}
      await sleep(250);
    }
    ok(up, "本地 store-saas 实例起来了（临时 DATA_DIR + 随机端口）");
    if (!up) {
      ok(false, "服务端没起来，日志尾巴：" + String(fs.readFileSync(logPath, "utf8")).slice(-400).replace(/\s+/g, " "));
      return;
    }

    /* 1.1 目录：每个作者一条分支，显示名按 uid 解析 */
    const cat = await api("GET", "/api/apps/catalog");
    const apps = (cat.data && cat.data.apps) || [];
    const of = (uid) => apps.find((a) => a.ownerId === uid) || {};
    ok(apps.length === 5 && apps.every((a) => a.ownerId), "目录里同 id 五条分支都在（每条带作者 uid）");
    ok(of(U.B).owner === "u_f2bea279", "老字段 owner 保持账号名语义（微信占位名原样在，不改成昵称）");
    ok(of(U.B).ownerName === "Tester", "★ ownerName = 真昵称（不再是 u_f2bea279）");
    ok(of(U.A).ownerName === "毛桑", "真账号名的作者也显示昵称（ownerName 优先于账号名）");
    ok(of(U.D).ownerName === "", "昵称为空 + 占位账号名 → ownerName 空串（客户端显示「未知作者」）");
    ok(of(U.E).ownerName === "carol", "昵称为空 + 真账号名 → 回落账号名 carol");
    ok(
      apps.every((a) => a.ownerName !== undefined) && of(U.C).ownerName === "Tester",
      "所有条目都带 ownerName 字段（同名分支各自独立解析）",
    );

    /* 1.2 历史版本行：uploader 快照不动，uploaderName 按 uid 实时解析 */
    ok(of(U.B).versions[0].uploader === "u_f2bea279", "版本项老字段 uploader 仍是上传当时的账号名快照（不改历史）");
    ok(of(U.B).versions[0].uploaderName === "Tester", "★ 版本项 uploaderName 按上传者 uid 实时解析出昵称");
    ok(of(U.A).versions[0].uploaderName === "毛桑", "真账号名的版本行也显示昵称");

    /* 1.3 详情接口：branches[] 的 ownerName、nickname 与 forkOf.ownerName 都在 */
    const one = await api("GET", "/api/apps/" + APP_ID);
    const item = (one.data && one.data.item) || {};
    const br = (item.branches || []).find((b) => b.ownerId === U.B) || {};
    ok(!!br.ownerName && br.ownerName === "Tester", "详情 branches[] 带 ownerName（客户端分支树的显示名来源）");
    ok(br.nickname === "Tester" && br.owner === "u_f2bea279", "branches[] 原有 owner / nickname 字段一字未改（老客户端照旧能读）");
    ok(!!br.forkOf && br.forkOf.ownerName === "毛桑", "forkOf 带源作者显示名（「二次开发自」那行不再显示占位名）");

    /* 1.4 版本树接口（上架窗读的那一个）：顶层与每版都带显示名 */
    const vs = await api("GET", "/api/apps/" + APP_ID + "/versions?owner=" + U.B);
    ok((vs.data || {}).ownerName === "Tester", "GET /api/apps/<id>/versions 顶层带 ownerName");
    const v0 = ((vs.data || {}).versions || [])[0] || {};
    ok(v0.uploaderName === "Tester" && v0.uploader === "u_f2bea279", "版本树每一项：uploaderName 是昵称、uploader 仍是快照");

    /* 1.5 搜索按昵称也能命中（改名后按名字找得到） */
    const search = await api("GET", "/api/apps?q=" + encodeURIComponent("Tester"));
    ok(
      ((search.data && search.data.items) || []).length === 2,
      "按昵称搜索能命中两条同名的分支（服务端搜索也认 ownerName）",
    );

    /* 1.6 改昵称 → 静态目录立刻跟着变（catalog.json 是快照，不重刷就还是旧名字） */
    const login = await api("POST", "/api/login", { username: "ms2308", password: PW });
    const token = ((login.data || {}).token) || "";
    ok(!!token, "作者账号登录拿到 token（改昵称要登录态）");
    const before = fs.existsSync(catalogPath);
    await api("PATCH", "/api/me", { nickname: "毛桑改名了" }, token);
    const afterDoc = fs.existsSync(catalogPath) ? JSON.parse(fs.readFileSync(catalogPath, "utf8")) : { apps: [] };
    const mine = (afterDoc.apps || []).find((a) => a.ownerId === U.A) || {};
    ok(
      mine.ownerName === "毛桑改名了",
      (before ? "改昵称后静态目录重刷：" : "改昵称顺带落了一份静态目录：") + "catalog.json 里 ownerName = 新昵称",
    );
    ok(mine.owner === "ms2308", "重刷后 owner 仍是账号名（判定键不跟着昵称漂）");
    const other = (afterDoc.apps || []).find((a) => a.ownerId === U.B) || {};
    ok(other.ownerName === "Tester", "别人的显示名不受影响（重刷是按 uid 重新解析，不是抄一份）");

    /* 1.7 名下没有应用的账号改昵称：不重刷目录（不做无谓写盘） */
    const fLogin = await api("POST", "/api/register", { username: "no-app-user", password: PW, nickname: "无关的人" });
    const fToken = ((fLogin.data || {}).token) || "";
    const mtimeBefore = fs.statSync(catalogPath).mtimeMs;
    await sleep(120);
    if (fToken) await api("PATCH", "/api/me", { nickname: "无关的人改名" }, fToken);
    await sleep(220);
    ok(
      fs.statSync(catalogPath).mtimeMs === mtimeBefore,
      "名下没有应用的账号改昵称 → 静态目录不重写（重刷卡在该账号名下真有应用时）",
    );
  } finally {
    try {
      child.kill();
    } catch (_) {}
    await sleep(120);
  }
}

/* ============ [2] 客户端主进程 apps-store.js 真跑（真 HTTP 假目录） ============ */
async function partMainStore() {
  console.log("[2] apps-store.js 真跑：ownerName / uploaderName 进条目与版本项；老目录不报错");
  const FEED_DOC = {
    version: 1,
    updatedAt: new Date().toISOString(),
    apps: [
      {
        id: "author-name-app",
        title: "作者名冒烟",
        version: "1.0.1",
        latestVersion: "1.0.1",
        entry: "index.html",
        zipUrl: "author-name-app.zip",
        sha256: "",
        bytes: 10,
        owner: "u_f2bea279",
        ownerName: "Tester",
        ownerId: U.B,
        versions: [
          { version: "1.0.0", zipUrl: "a.zip", sha256: "", bytes: 5, uploader: "ms2308", uploaderName: "毛桑", createdAt: 1000 },
          { version: "1.0.1", zipUrl: "b.zip", sha256: "", bytes: 5, uploader: "u_f2bea279", uploaderName: "Tester", createdAt: 2000 },
        ],
        forkOf: { id: "author-name-app", ownerId: U.A, owner: "ms2308", ownerName: "毛桑" },
      },
      /* 老目录条目：没有 ownerName / uploaderName（客户端必须自己兜底，不许把 uid 当名字） */
      {
        id: "legacy-app",
        title: "老目录条目",
        version: "1.0.0",
        entry: "index.html",
        zipUrl: "legacy-app.zip",
        owner: "u_0f0f0f0f",
        versions: [{ version: "1.0.0", zipUrl: "legacy.zip", uploader: "u_0f0f0f0f", createdAt: 1000 }],
      },
    ],
  };
  const feed = http.createServer((req, res) => {
    const url = String(req.url || "").split("?")[0];
    if (url === "/catalog.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(FEED_DOC));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end("{}");
  });
  await new Promise((r) => feed.listen(0, "127.0.0.1", r));
  const feedPort = feed.address().port;
  process.env.MTNODE_APPS_URL = "http://127.0.0.1:" + feedPort;

  /* 假 electron：apps-store.js 在模块加载时就 require("electron") */
  const electronMock = {
    app: {
      getAppPath: () => ROOT,
      getPath: () => ROOT,
      getVersion: () => "9.9.9",
    },
    BrowserWindow: function () {
      return { webContents: { on() {}, send() {}, isDestroyed: () => true }, on() {}, loadFile() {}, show() {}, focus() {} };
    },
    ipcMain: { handle() {} },
    protocol: { registerSchemesAsPrivileged() {}, handle() {} },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { openExternal: async () => {}, openPath: async () => "", trashItem: async () => {} },
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  };
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") return electronMock;
    return realLoad.call(this, request, parent, isMain);
  };
  const dataDir = path.join(TMP, "apps-data");
  fs.mkdirSync(dataDir, { recursive: true });
  let store = null;
  try {
    store = require(path.join(ROOT, "apps-store.js"));
    store.registerAppsIpc({
      getDataDir: () => dataDir,
      getMainWin: () => null,
      getAppVersion: () => "9.9.9",
      t: (s) => String(s == null ? "" : s),
      authState: () => ({ loggedIn: false, user: null }),
      aiCall: async () => ({ text: "x" }),
      aiCallStream: async () => ({ text: "x" }),
    });
    const cat = await store.loadCatalog();
    const spec = ((cat && cat.apps) || []).find((a) => a.id === "author-name-app") || {};
    ok(spec.ownerName === "Tester", "★ 目录条目带 ownerName（normSpec 白名单放行了它）");
    ok(spec.owner === "u_f2bea279", "owner 仍是账号名（判定键不变）");
    ok(
      (spec.versions || [])[1] && spec.versions[1].uploaderName === "Tester",
      "★ 版本项带 uploaderName（normVersionItem 放行了它）",
    );
    ok(
      (spec.versions || [])[0] && spec.versions[0].uploader === "ms2308",
      "版本项的 uploader 快照原样保留（老客户端读它）",
    );
    ok(spec.forkOf && spec.forkOf.ownerName === "毛桑", "forkOf 的 ownerName 也进了条目（normForkOf）");
    const legacy = ((cat && cat.apps) || []).find((a) => a.id === "legacy-app") || {};
    ok(legacy.ownerName === "" && (legacy.versions || [])[0].uploaderName === "", "老目录没有显示名字段 → 空串（不报错、不拿 uid 顶替）");
    ok(legacy.owner === "u_0f0f0f0f", "老目录条目的 owner 原样保留（兼容不破）");
  } finally {
    Module._load = realLoad;
    feed.close();
    try {
      if (store && typeof store.shutdownApps === "function") store.shutdownApps();
    } catch (_) {}
  }
}

/* ============ [3]/[4] 渲染层两处实现真跑，喂同一组用例 ============ */
function rendererSandbox(file) {
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: () => {},
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({
        style: { setProperty() {} },
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        appendChild() {},
        setAttribute() {},
        addEventListener() {},
      }),
      addEventListener() {},
      removeEventListener() {},
      body: { appendChild() {}, classList: { add() {}, remove() {}, toggle() {} } },
      documentElement: { style: { setProperty() {} } },
    },
    I18n: { t: (s) => String(s == null ? "" : s), getLocale: () => "zh" },
    esc: (s) => String(s == null ? "" : s),
    fmtBytes: (n) => String(n) + " B",
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.api = {};
  sandbox.MTNodeAuth = { state: () => ({ signedIn: true, user: { id: "u_me", username: "u_aabbccdd", nickname: "我自己" } }) };
  sandbox.window.MTNodeAuth = sandbox.MTNodeAuth;
  vm.createContext(sandbox);
  vm.runInContext(read(file), sandbox, { filename: file });
  return sandbox;
}
/* 同一组用例（两处实现必须给出同样的结果） */
const NAME_CASES = [
  { spec: { ownerId: U.B, owner: "u_f2bea279", ownerName: "Tester" }, want: "Tester", why: "昵称优先" },
  { spec: { ownerId: U.A, owner: "ms2308", ownerName: "毛桑" }, want: "毛桑", why: "有昵称就显示昵称（不显示账号名）" },
  { spec: { ownerId: U.B, owner: "u_f2bea279" }, want: "", why: "老目录：占位账号名不算名字（→「未知作者」）" },
  { spec: { ownerId: U.A, owner: "ms2308" }, want: "ms2308", why: "老目录：真账号名可以兜底" },
  { spec: { ownerId: U.E, owner: "carol", ownerName: "" }, want: "carol", why: "昵称为空回落账号名" },
  { spec: { ownerId: U.D, owner: "u_deadbeef", ownerName: "" }, want: "", why: "都没有 → 空（显示「未知作者」）" },
];
function partRendererApps() {
  console.log("[3] renderer/app-apps.js 真跑：显示名规则 · 重名补短 uid · 上传者显示名");
  const S = rendererSandbox("renderer/app-apps.js");
  for (const c of NAME_CASES) {
    ok(S.appsAuthorOf(c.spec) === c.want, "appsAuthorOf：" + c.why + "（实得 " + JSON.stringify(S.appsAuthorOf(c.spec)) + "）");
  }
  /* 本机条目：app.json 的 author 优先；它是占位名 / 为空时回落当前登录账号的昵称 */
  ok(S.appsAuthorOf({ author: "本机作者" }) === "本机作者", "本机条目仍按 app.json 的 author 显示（离线可读）");
  ok(S.appsAuthorOf({ author: "u_11223344" }) === "我自己", "本机作者写成占位名 → 回落当前登录账号的昵称");
  ok(S.appsAuthorOf({}) === "我自己", "本机条目连 author 都没有 → 当前登录账号昵称");

  /* 分支标签 + 重名补短 uid */
  const bB = { ownerId: U.B, owner: "u_f2bea279", ownerName: "Tester", nickname: "Tester" };
  const bC = { ownerId: U.C, owner: "u_1234abcd", ownerName: "Tester" };
  const bA = { ownerId: U.A, owner: "ms2308", ownerName: "毛桑" };
  const bD = { ownerId: U.D, owner: "u_deadbeef", ownerName: "" };
  ok(S.appsBranchLabelOf(bB, [bA, bB]) === "Tester", "分支标签：只有一个 Tester 时不加后缀");
  ok(S.appsBranchLabelOf(bB, [bA, bB, bC]) === "Tester # 39e484", "★ 两条分支同名 → 补「# <ownerId 末 6 位>」区分");
  ok(S.appsBranchLabelOf(bC, [bA, bB, bC]) === "Tester # cccccc", "同名时各自补自己的短 uid");
  ok(S.appsBranchLabelOf(bA, [bA, bB, bC]) === "毛桑", "不同名的分支不受影响");
  ok(S.appsBranchLabelOf(bD, [bD, bA]) === "未知作者", "没有名字 → 「未知作者」（不显示 uid）");
  ok(S.appsBranchLabelOf(bB) === "Tester", "不传分支列表 = 只给显示名（日志 / 单条场景不炸）");

  /* 上传者显示名 */
  ok(S.appsUploaderOf({ uploader: "u_f2bea279", uploaderName: "Tester" }) === "Tester", "版本行上传者：uploaderName 优先");
  ok(S.appsUploaderOf({ uploader: "u_f2bea279" }) === "", "版本行上传者：老目录的占位名不显示（整段省略）");
  ok(S.appsUploaderOf({ uploader: "ms2308" }) === "ms2308", "版本行上传者：真账号名可兜底");
  ok(S.appsUploaderOf({}) === "", "版本行上传者：都没有 → 空串");
}

function partRendererPublish() {
  console.log("[4] renderer/app-publish.js 真跑：与 app-apps.js 同一组用例结果必须一致");
  const S = rendererSandbox("renderer/app-publish.js");
  for (const c of NAME_CASES) {
    const got = S.pubAuthorNameOf(c.spec);
    ok(got === c.want, "pubAuthorNameOf：" + c.why + "（实得 " + JSON.stringify(got) + "）");
  }
  const bB = { ownerId: U.B, owner: "u_f2bea279", ownerName: "Tester", nickname: "Tester" };
  const bC = { ownerId: U.C, owner: "u_1234abcd", ownerName: "Tester" };
  const bA = { ownerId: U.A, owner: "ms2308", ownerName: "毛桑" };
  ok(S.pubBranchLabel(bB, [bA, bB]) === "Tester", "上架窗分支标签：只显示昵称");
  ok(S.pubBranchLabel(bB, [bA, bB, bC]) === "Tester # 39e484", "上架窗分支标签：同名补短 uid（与详情页同一口径）");
  ok(S.pubBranchLabel({ ownerId: U.D, owner: "u_deadbeef", ownerName: "" }, [bA]) === "未知作者", "上架窗：没有名字 → 「未知作者」");
  ok(S.pubUploaderOf({ uploader: "u_f2bea279", uploaderName: "Tester" }) === "Tester", "上架窗版本行上传者 = 昵称");
  ok(S.pubUploaderOf({ uploader: "u_f2bea279" }) === "", "上架窗版本行上传者：占位名不显示");
  /* 源码闸：版本行 / 分支头不许再直接摊 owner / uploader / nickname */
  const src = read("renderer/app-publish.js");
  ok(!/pubStr\(v\.uploader\)/.test(src), "上架窗版本行不再直接用 v.uploader（改走 pubUploaderOf）");
  const appsSrc = read("renderer/app-apps.js");
  ok(!/appsT\("上传者 "\) \+ r\.item\.uploader\b/.test(appsSrc), "详情版本树不再直接用 item.uploader（改走 appsUploaderOf）");
  ok(!/nick && name\) return nick \+ "（" \+ name \+ "）"/.test(appsSrc), "旧的「昵称（账号名）」拼接已去掉（只显示昵称）");
}

/* ============ [5] 契约文档 ============ */
function partDocs() {
  console.log("[5] 契约与客户端白名单口径写在文档里");
  const doc = exists("docs/apps-market.md") ? read("docs/apps-market.md") : "";
  ok(/ownerName/.test(doc), "docs/apps-market.md 写明 ownerName（作者显示名）");
  ok(/uploaderName/.test(doc), "docs/apps-market.md 写明 uploaderName（版本行上传者显示名）");
  ok(/昵称/.test(doc) && /占位名/.test(doc), "文档写明「昵称优先、占位账号名不算名字」的口径");
}
