"use strict";
/* 应用开发页「借走 / 归还会话正文」：消息区（#agentList）必须回得来 —— 冒烟测试
 *   node test/smoke-apps-dev-borrow.js
 *
 * 用户报障（本次修）：**应用开发（页）用过之后，会话视图右侧框不显示完整会话内容，
 *   没有任何显示，只有一个清单**。
 * 根因（真实代码路径，见 renderer/app-assist.js 的 ensureHistRail）：
 *   #agentList 会被 ensureHistRail() 包进一只 .hist-scroll-wrap（轮次轨的滚动壳），
 *   那只壳才是 .agent-body 的直接子节点。而 renderer/app-apps-dev.js 的 appsDevMount()
 *   只按 id 搬 #agentList（壳留在 .agent-body），appsDevUnmount() 按「搬之前记下的
 *   .agent-body 子节点」（= 那只**空壳**）归还 —— #agentList 留在开发页的 DOM 里；
 *   应用中心浮层只是 hidden（app-apps.js 的 appsHubClose），那个节点从此谁也够不着：
 *   会话视图的消息区再也画不出东西，而 #agentPlan / #agentTodo（清单）是 body 的直接
 *   子节点、照常归还 —— 用户看到的就是「右侧框什么都没有，只剩一个清单」。
 *
 * 覆盖：
 *   [1] 搬运后：开发页右栏拿到整只消息壳（#agentList 在里面）
 *   [2] 归还后：#agentList 回到 .agent-body（在它的 .hist-scroll-wrap 里），开发页右栏不再持有
 *   [3] 归还后：清单面板 / 输入框也在 .agent-body 里（与 ①② 同一次归还，顺序不变）
 *   [4] 口径：appsDevMount 上溯 hist-scroll-wrap（源码钉住，防回归写法回来）
 */
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os"), childProcess = require("child_process");
const SHARED = { fs, path, vm, os, spawn: childProcess.spawn };
const TEST_DIR = __dirname;
let MERGED_FAILED = false;

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

/* ============================ 迷你 DOM ============================ */
/* 只要 app-apps-dev.js 的 appsDevMount / appsDevUnmount 用到的那几样：
   parentNode / children / appendChild（搬家）/ removeChild / contains /
   classList / getElementById / querySelector（单个选择器）。 */
function mkEl(tag, cls, id) {
  const el = {
    nodeType: 1,
    tagName: String(tag || "div").toUpperCase(),
    id: String(id || ""),
    parentNode: null,
    children: [],
    _cls: new Set(String(cls || "").split(/\s+/).filter(Boolean)),
  };
  el.classList = {
    add: (c) => el._cls.add(c),
    remove: (c) => el._cls.delete(c),
    contains: (c) => el._cls.has(c),
    toString: () => Array.from(el._cls).join(" "),
  };
  el.appendChild = (c) => {
    if (!c) return c;
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = el;
    el.children.push(c);
    return c;
  };
  el.removeChild = (c) => {
    const i = el.children.indexOf(c);
    if (i >= 0) el.children.splice(i, 1);
    if (c) c.parentNode = null;
    return c;
  };
  el.contains = (node) => {
    for (let n = node; n; n = n.parentNode) if (n === el) return true;
    return false;
  };
  const matchesSelf = (node, sel) => {
    const s = String(sel || "").trim();
    if (!s) return false;
    const m = /^([a-zA-Z]+)?((?:[.#][\w-]+)*)$/.exec(s);
    if (!m) return false;
    if (m[1] && node.tagName !== m[1].toUpperCase()) return false;
    for (const p of (m[2] || "").match(/[.#][\w-]+/g) || []) {
      if (p[0] === ".") {
        if (!node._cls.has(p.slice(1))) return false;
      } else if (node.id !== p.slice(1)) return false;
    }
    return true;
  };
  el.matches = (sel) => matchesSelf(el, sel);
  el.querySelector = (sel) => {
    const walk = (node) => {
      for (const c of node.children || []) {
        if (matchesSelf(c, sel)) return c;
        const hit = walk(c);
        if (hit) return hit;
      }
      return null;
    };
    return walk(el);
  };
  return el;
}
/* getElementById 每次都重扫一遍（节点会被搬来搬去，索引会过期） */
function docGetById(root, id) {
  const walk = (node) => {
    if (node.id === id) return node;
    for (const c of node.children || []) {
      const hit = walk(c);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root);
}

/* ============================ 现场：贴近真实的一棵会话窗 DOM ============================ */
/* index.html 的 .agent-body 子节点顺序：
   .hist-scroll-wrap（ensureHistRail 包出来的壳，里面是 #agentList + .hist-rail）
   → #agentPaused → #agentQueue → #agentPlan → #agentTodo → .agent-composer */
function buildScene() {
  const root = mkEl("body", "", "");
  const pane = root.appendChild(mkEl("div", "agent-pane", "agentPane"));
  const main = pane.appendChild(mkEl("div", "agent-main", ""));
  const body = main.appendChild(mkEl("div", "agent-body", ""));
  const wrap = body.appendChild(mkEl("div", "hist-scroll-wrap is-flex-fill", ""));
  const list = wrap.appendChild(mkEl("div", "agent-list", "agentList"));
  wrap.appendChild(mkEl("div", "hist-rail", "")); /* 轮次轨：壳里的第二个孩子 */
  body.appendChild(mkEl("div", "agent-queue agent-paused", "agentPaused"));
  body.appendChild(mkEl("div", "agent-queue", "agentQueue"));
  body.appendChild(mkEl("div", "agent-todo agent-plan", "agentPlan"));
  body.appendChild(mkEl("div", "agent-todo", "agentTodo"));
  const composer = body.appendChild(mkEl("div", "agent-composer", ""));
  composer.appendChild(mkEl("div", "agent-composer-chips", ""));
  composer.appendChild(mkEl("div", "agent-composer-card", ""));
  /* 应用中心浮层（app-apps.js 的 #appsHub）里的开发页右栏 + 底部输入框行 */
  const hub = root.appendChild(mkEl("div", "apps-hub", "appsHub"));
  const hubMain = hub.appendChild(mkEl("section", "apps-hub-main", ""));
  const hubBody = hubMain.appendChild(mkEl("div", "apps-hub-body", ""));
  const wrapDev = hubBody.appendChild(mkEl("div", "apps-dev", ""));
  const cols = wrapDev.appendChild(mkEl("div", "apps-dev-cols", ""));
  const conv = cols.appendChild(mkEl("section", "apps-dev-col apps-dev-conv", "appsDevConv"));
  const composerRow = wrapDev.appendChild(mkEl("div", "apps-dev-composer", "appsDevComposer"));
  return { root, pane, body, wrap, list, composer, hub, conv, composerRow };
}

/* 把 renderer/app-apps-dev.js 跑进沙箱（只用到 window / document 两个全局）。
   注意：DEVD 是脚本里的 const（词法作用域，不进沙箱对象），要从上下文里取。 */
function loadDev(s) {
  const doc = {
    getElementById: (id) => docGetById(s.root, String(id)),
    querySelector: (sel) => s.root.querySelector(sel),
    createElement: (t) => mkEl(t),
    body: s.root,
  };
  const sandbox = { document: doc, window: {}, console, I18n: { t: (x) => x } };
  vm.createContext(sandbox);
  vm.runInContext(read("renderer/app-apps-dev.js"), sandbox, {
    filename: "renderer/app-apps-dev.js",
  });
  return {
    DEVD: vm.runInContext("DEVD", sandbox),
    mount: () => vm.runInContext("appsDevMount()", sandbox),
    unmount: () => vm.runInContext("appsDevUnmount()", sandbox),
  };
}

/* ============================ [1][2][3] 搬运 / 归还 ============================ */
console.log("[1] 开发页借走会话正文（appsDevMount）");
{
  const s = buildScene();
  const sand = loadDev(s);
  sand.DEVD.convEl = s.conv;
  sand.DEVD.composerEl = s.composerRow;
  sand.mount();
  ok(s.conv.contains(s.list), "右栏拿到了 #agentList（会话正文落在开发页右栏里）");
  ok(s.composerRow.contains(s.composer), "底部输入框行拿到了 .agent-composer");
  ok(!s.body.contains(s.list), "搬走之后 .agent-body 里不再有 #agentList（同一份 DOM，不是复制）");
  ok(
    s.body.contains(s.wrap) || s.conv.contains(s.wrap),
    "那只 .hist-scroll-wrap 要么连壳一起搬走、要么留在 .agent-body（不允许两处都够不着）",
  );
}

console.log("[2] 关页归还（appsDevUnmount）：消息区必须回得来");
{
  const s = buildScene();
  const sand = loadDev(s);
  sand.DEVD.convEl = s.conv;
  sand.DEVD.composerEl = s.composerRow;
  sand.mount();
  sand.unmount();
  ok(
    s.body.contains(s.list),
    "#agentList 回到 .agent-body —— 会话视图的消息区画得出来（本次报障的直接判据）",
  );
  ok(!s.conv.contains(s.list), "开发页右栏不再持有 #agentList（浮层丢掉它也不影响会话视图）");
  ok(
    !s.list.parentNode || s.list.parentNode.parentNode === s.body,
    "#agentList 仍在它自己的 .hist-scroll-wrap 里（轮次轨的壳没被拆散）",
  );
  ok(
    s.body.contains(s.composer),
    ".agent-composer 回到 .agent-body（输入区与会话正文同一次归还）",
  );
  ok(
    s.body.contains(s.composer) && !s.composerRow.contains(s.composer),
    "底部输入框行不再持有 composer",
  );
}

console.log("[3] 清单面板同一次归还（左栏会话清单之外的「那一个清单」）");
{
  const s = buildScene();
  const sand = loadDev(s);
  sand.DEVD.convEl = s.conv;
  sand.DEVD.composerEl = s.composerRow;
  sand.mount();
  const inConv = ["agentPlan", "agentTodo", "agentQueue", "agentPaused"].every(
    (id) => s.conv.contains(docGetById(s.root, id)),
  );
  ok(inConv, "搬运期：四块面板（计划 / 任务清单 / 发送队列 / 已暂停）都在开发页右栏");
  sand.unmount();
  const back = ["agentPlan", "agentTodo", "agentQueue", "agentPaused"].every(
    (id) => s.body.contains(docGetById(s.root, id)),
  );
  ok(back, "归还期：四块面板与消息区一起回到 .agent-body（顺序仍按搬运前记下的那份）");
  const order = s.body.children.map((c) => c.id || c.classList.toString());
  ok(
    order[0].indexOf("hist-scroll-wrap") >= 0 &&
      order.indexOf("agentPlan") > 0 &&
      order.indexOf("agentTodo") > order.indexOf("agentPlan") &&
      order.indexOf("agent-composer") > order.indexOf("agentTodo"),
    "归还后的子节点顺序 = 搬运前那份（消息壳在首、清单与输入区依次在后）：" + order.join(" | "),
  );
}

console.log("[4] 口径钉住：搬运时上溯 .hist-scroll-wrap");
{
  const DEV = read("renderer/app-apps-dev.js");
  ok(
    DEV.indexOf("hist-scroll-wrap") >= 0 &&
      DEV.indexOf("function appsDevMoveTarget(") >= 0 &&
      DEV.indexOf("appsDevMoveTarget(id, body)") >= 0,
    "appsDevMount 走 appsDevMoveTarget：父节点是 .hist-scroll-wrap 就搬那只壳",
  );
  ok(
    DEV.indexOf("m.body.contains(list)") >= 0,
    "appsDevUnmount 有兜底：#agentList 没随 saved 回来时点名接回 .agent-body 里的壳",
  );
  const CSS = read("renderer/css/apps.css");
  ok(
    CSS.indexOf(".apps-dev-conv > .hist-scroll-wrap.is-flex-fill") >= 0 &&
      CSS.indexOf(".apps-dev-conv > .agent-list") >= 0,
    "apps.css：开发页右栏的消息区（含被包进壳的那种）取 base.css ① 的填充口径",
  );
  ok(
    CSS.indexOf(".apps-dev-conv.is-draft > .hist-scroll-wrap") >= 0,
    "apps.css：首轮态连消息壳一起藏（只写 > .agent-list 的话正文会从壳里露出来）",
  );
  const BASE = read("renderer/css/base.css");
  ok(
    BASE.indexOf(".agent-body>.hist-scroll-wrap.is-flex-fill") >= 0,
    "base.css ① 仍在（开发页那条是它的同口径镜像，不是替代）",
  );
  ok(
    DEV.indexOf("saved = Array.from(body.children)") >= 0,
    "归还仍按「搬运前记下的 .agent-body 子节点」原样 appendChild（对象与事件监听不变）",
  );
}

console.log("");
if (fails) {
  console.log("FAILED " + fails + " / " + checks + " 项检查");
} else {
  console.log("ALL PASS " + checks + " 项检查");
}

/* ==================== 已并入：test/smoke-apps-cloud.js ==================== */
let CLOUD_DONE = null; /* 并入块是异步的（真起 http 服务 + 真 require 主进程模块）：收尾要等它 */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-apps-cloud.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const http = require("http");
  const crypto = require("crypto");
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

  /* ---------------- 假的云端：一个 http 服务同时演「静态目录」与「接口目录」 ---------------- */
  const APP_ID = "cloud-app";
  let ZIP_BUF = Buffer.alloc(0);
  let ZIP_SHA = "";

  /* mode：static-empty / static-404 / ok / all-down */
  const cloud = { mode: "static-empty", hits: [] };

  function staticDoc() {
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      feed: "http://example.invalid/mtnode/apps",
      apps: [
        {
          id: APP_ID,
          title: "云应用",
          version: "1.2.0",
          latestVersion: "1.2.0",
          desc: "冒烟用",
          description: "冒烟用",
          icon: "icons/" + APP_ID + ".png",
          /* 封面缩略图：服务端**两种来源下发同一个字段**、且都是静态目录的相对写法
             （icons/<主干>__shot.png，见 store-saas/server.mjs 的 appCatalogEntry）。
             接口侧没有 icons/ 这条静态路由 —— 主进程必须把它换成 /api/apps/<id>/thumb，
             直拼（…/store-api/icons/…）线上是 404，卡片就等于拿不到封面。 */
          thumb: "icons/" + APP_ID + "__shot.png",
          coverSource: "shot",
          coverVer: "1791495394",
          zipUrl: APP_ID + ".zip",
          url: APP_ID + ".zip",
          sha256: ZIP_SHA,
          owner: "tester",
          entry: "index.html",
          tags: [],
          bytes: ZIP_BUF.length,
          versions: [
            { version: "1.0.0", zipUrl: APP_ID + "/1.0.0.zip", sha256: ZIP_SHA, bytes: ZIP_BUF.length },
            { version: "1.2.0", zipUrl: APP_ID + "/1.2.0.zip", sha256: ZIP_SHA, bytes: ZIP_BUF.length },
          ],
        },
      ],
    };
  }
  function apiDoc() {
    const d = staticDoc();
    d.apps[0].zipUrl = APP_ID + ".zip";
    return d;
  }

  const server = http.createServer((req, res) => {
    const u = new URL(req.url || "/", "http://local");
    const p = u.pathname;
    cloud.hits.push(req.method + " " + p + (u.search || ""));
    const send = (code, body, type) => {
      const data = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(JSON.stringify(body), "utf8");
      res.writeHead(code, { "Content-Type": type || "application/json" });
      res.end(data);
    };
    // 静态目录：…/apps/catalog.json
    if (p.endsWith("/apps/catalog.json")) {
      if (cloud.mode === "static-404" || cloud.mode === "all-down") return send(404, { ok: false });
      if (cloud.mode === "ok") return send(200, staticDoc());
      return send(200, { version: 1, updatedAt: "2026-01-01T00:00:00.000Z", feed: "", apps: [] });
    }
    // 图标（静态布局 icons/<id>.png 与接口 /api/apps/<id>/icon 都走这里）
    if (p.endsWith("/icons/" + APP_ID + ".png") || p === "/api/apps/" + APP_ID + "/icon") {
      return send(200, Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png");
    }
    // 接口目录
    if (p === "/api/apps/catalog" || p === "/api/apps/catalog.json") {
      if (cloud.mode === "all-down") return send(500, { ok: false });
      return send(200, apiDoc());
    }
    // 包：静态 <id>.zip / <id>/<ver>.zip 与接口 /api/apps/<id>/file 都回同一份 zip
    if (p === "/" + APP_ID + ".zip" || p === "/" + APP_ID + "/1.0.0.zip" || p === "/" + APP_ID + "/1.2.0.zip") {
      res.writeHead(200, { "Content-Type": "application/zip", "Content-Length": ZIP_BUF.length });
      return res.end(ZIP_BUF);
    }
    if (p === "/api/apps/" + APP_ID + "/file") {
      if (cloud.mode === "all-down") return send(500, { ok: false });
      res.writeHead(200, { "Content-Type": "application/zip", "Content-Length": ZIP_BUF.length });
      return res.end(ZIP_BUF);
    }
    return send(404, { ok: false, error: "no route " + p });
  });

  /* 最小 zip 打包（storeMode 0 = 不压缩）：冒烟自带，不引第三方依赖 */
  const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c;
    }
    return t;
  })();
  function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  }
  function makeZip(files) {
    const locals = [];
    const central = [];
    let off = 0;
    for (const f of files) {
      const name = Buffer.from(f.name, "utf8");
      const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), "utf8");
      const crc = crc32(data);
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4);
      lh.writeUInt16LE(0, 6);
      lh.writeUInt16LE(0, 8);
      lh.writeUInt16LE(0, 10);
      lh.writeUInt16LE(0, 12);
      lh.writeUInt32LE(crc, 14);
      lh.writeUInt32LE(data.length, 18);
      lh.writeUInt32LE(data.length, 22);
      lh.writeUInt16LE(name.length, 26);
      lh.writeUInt16LE(0, 28);
      locals.push(lh, name, data);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt16LE(20, 4);
      ch.writeUInt16LE(20, 6);
      ch.writeUInt16LE(0, 8);
      ch.writeUInt16LE(0, 10);
      ch.writeUInt16LE(0, 12);
      ch.writeUInt16LE(0, 14);
      ch.writeUInt32LE(crc, 16);
      ch.writeUInt32LE(data.length, 20);
      ch.writeUInt32LE(data.length, 24);
      ch.writeUInt16LE(name.length, 28);
      ch.writeUInt16LE(0, 30);
      ch.writeUInt16LE(0, 32);
      ch.writeUInt16LE(0, 34);
      ch.writeUInt16LE(0, 36);
      ch.writeUInt32LE(0, 38);
      ch.writeUInt32LE(off, 42);
      central.push(ch, name);
      off += lh.length + name.length + data.length;
    }
    const cd = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(off, 16);
    eocd.writeUInt16LE(0, 20);
    return Buffer.concat([Buffer.concat(locals), cd, eocd]);
  }

  /* 云端那一条应用的包：冒烟自带 zip（不引第三方依赖） */
  ZIP_BUF = makeZip([
    { name: "index.html", data: Buffer.from("<html><body>cloud</body></html>", "utf8") },
    {
      name: "app.json",
      data: Buffer.from(JSON.stringify({ id: APP_ID, name: "云应用", entry: "index.html" }), "utf8"),
    },
  ]);
  ZIP_SHA = crypto.createHash("sha256").update(ZIP_BUF).digest("hex");

  /* ---------------- 假 electron：apps-store.js 只用到 app.getAppPath / getPath ---------------- */
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-apps-cloud-"));
  const ROOT = path.join(__dirname, "..");
  const electronMock = {
    app: { getAppPath: () => ROOT, getPath: () => path.join(TMP, "userData") },
    BrowserWindow: class {},
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

  /* 每个场景换一份数据目录 + 重新 require：apps-store.js 的 FEED / STORE_BASE 是 require 期读的 */
  function freshStore(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(dataDir, "apps-root"), { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, "config.json"),
      JSON.stringify({ apps: { installDir: path.join(dataDir, "apps-root") } }, null, 2),
      "utf8",
    );
    const p = require.resolve("../apps-store.js");
    delete require.cache[p];
    const mod = require("../apps-store.js");
    mod.registerAppsIpc({
      getDataDir: () => dataDir,
      getMainWin: () => null,
      getAppVersion: () => "9.9.9",
      t: (s) => String(s == null ? "" : s),
    });
    return mod;
  }

  async function main() {
    console.log("smoke-apps-cloud：应用库连云端（目录双源兜底 + 按来源解析）\n");
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const PORT = server.address().port;
    const FEED = "http://127.0.0.1:" + PORT + "/mtnode/apps";
    const STORE = "http://127.0.0.1:" + PORT;
    process.env.MTNODE_APPS_URL = FEED;
    process.env.MTNODE_STORE_URL = STORE;

    /* ---- [1] 静态目录是空的（部署链刷空那种事故）→ 必须回退接口目录 ---- */
    console.log("[1] 静态目录 0 条 → 回退云端接口目录");
    {
      cloud.mode = "static-empty";
      const dataDir = path.join(TMP, "d1");
      const store = freshStore(dataDir);
      const cat = await store.loadCatalog();
      ok(cat.source === "api", "source=api（静态目录为空不当作结论）");
      ok(String(cat.sourceBase) === STORE, "sourceBase 指向接口目录基址");
      ok(String(cat.sourceUrl).endsWith("/api/apps/catalog"), "sourceUrl 是接口目录：" + cat.sourceUrl);
      ok((cat.apps || []).length === 1 && cat.apps[0].id === APP_ID, "接口目录里的应用被列出");
      ok(!!(cat.apps[0] && cat.apps[0].urls && cat.apps[0].urls.icon), "主进程已把图标解析成可请求的 URL");
      const urls = store.zipUrlsOf(cat.apps[0]);
      ok(urls.zip === STORE + "/api/apps/" + APP_ID + "/file?version=1.2.0&format=raw", "接口来源：下载地址走 /api/apps/<id>/file：" + urls.zip);
      ok(urls.versions["1.0.0"] === STORE + "/api/apps/" + APP_ID + "/file?version=1.0.0&format=raw", "接口来源：多版本每一版都有接口下载地址");
      ok(urls.icon === STORE + "/api/apps/" + APP_ID + "/icon", "接口来源：图标走 /api/apps/<id>/icon");
      ok(
        urls.thumb === STORE + "/api/apps/" + APP_ID + "/thumb",
        "接口来源：封面缩略图走 /api/apps/<id>/thumb（**不是** store-api/icons/… 那个 404 地址）：" + urls.thumb,
      );
      ok(cat.remoteError && /empty_catalog/.test(cat.remoteError), "回执里留下静态目录为空的原因：" + cat.remoteError);
    }

    /* ---- [2] 静态目录 404（服务端静态文件没发布）→ 同样回退接口 ---- */
    console.log("[2] 静态目录 404 → 回退云端接口目录");
    {
      cloud.mode = "static-404";
      const dataDir = path.join(TMP, "d2");
      const store = freshStore(dataDir);
      const cat = await store.loadCatalog();
      ok(cat.source === "api", "source=api");
      ok((cat.apps || []).length === 1, "接口目录照常出应用");
      ok(cat.remoteError && /HTTP 404/.test(cat.remoteError), "回执里留下静态目录的 HTTP 状态：" + cat.remoteError);
    }

    /* ---- [3] 静态目录正常 → 用静态目录，下载 / 图标走 FEED 相对路径 ---- */
    console.log("[3] 静态目录正常 → 首选静态目录（下载 / 图标仍是 FEED 相对路径）");
    {
      cloud.mode = "ok";
      const dataDir = path.join(TMP, "d3");
      const store = freshStore(dataDir);
      const cat = await store.loadCatalog();
      ok(cat.source === "remote", "source=remote（首选静态目录）");
      ok(String(cat.sourceBase) === FEED, "sourceBase 是静态目录基址");
      const urls = store.zipUrlsOf(cat.apps[0]);
      ok(urls.zip === FEED + "/" + APP_ID + ".zip", "静态来源：下载地址 = FEED + <id>.zip：" + urls.zip);
      ok(urls.versions["1.0.0"] === FEED + "/" + APP_ID + "/1.0.0.zip", "静态来源：多版本走 <id>/<ver>.zip");
      ok(urls.icon === FEED + "/icons/" + APP_ID + ".png", "静态来源：图标走 icons/<id>.<ext>");
      ok(
        urls.thumb === FEED + "/icons/" + APP_ID + "__shot.png",
        "静态来源：封面缩略图 = FEED + 服务端下发的相对写法（原样解析，不改名）：" + urls.thumb,
      );
    }

    /* ---- [4] 全断 → 本机缓存；缓存也没有 → empty（不抛错，交给渲染层提示） ---- */
    console.log("[4] 静态 + 接口都拿不到 → 本机缓存，再不行空列表");
    {
      cloud.mode = "all-down";
      const dataDir = path.join(TMP, "d4");
      let store = freshStore(dataDir);
      const empty = await store.loadCatalog();
      ok(empty.source === "empty" && (empty.apps || []).length === 0, "两层都断且无缓存 → source=empty（不抛错）");
      ok(empty.remoteError && /static:/.test(empty.remoteError) && /api:/.test(empty.remoteError), "回执里两层原因都在：" + empty.remoteError);
      // 上一次成功（static-404 → 接口）留下的缓存：接口都断了也能把目录显示出来
      cloud.mode = "static-404";
      store = freshStore(dataDir);
      const warm = await store.loadCatalog();
      ok(warm.source === "api" && (warm.apps || []).length === 1, "先拿一次接口目录（写缓存）");
      cloud.mode = "all-down";
      store = freshStore(dataDir);
      const cached = await store.loadCatalog();
      ok(cached.source === "cache", "两层都断 → 回退本机缓存");
      ok((cached.apps || []).length === 1, "缓存里的应用照常列出");
      ok(String(cached.sourceBase) === STORE, "缓存记住来源基址（图标 / 下载仍能解析）");
      const urls = store.zipUrlsOf(cached.apps[0]);
      ok(urls.icon === STORE + "/api/apps/" + APP_ID + "/icon", "缓存来源是接口 → 图标仍走接口 URL");
      ok(
        urls.thumb === STORE + "/api/apps/" + APP_ID + "/thumb",
        "缓存来源是接口 → 封面缩略图也仍走接口 URL：" + urls.thumb,
      );
    }

    /* ---- [5] 防投毒白名单仍然生效（接口目录不能把下载源指到别的站） ---- */
    console.log("[5] 下载地址白名单：只允许静态目录 / 云端接口两个基址");
    {
      const dataDir = path.join(TMP, "d5");
      const store = freshStore(dataDir);
      ok(store.resolveZipUrl("http://evil.example.com/x.zip", FEED) === "", "绝不允许目录把下载源指到别的域名");
      ok(store.resolveZipUrl("file:///C:/Windows/system32/evil.zip", FEED) === "", "非 http(s) 协议一律拒");
      ok(store.resolveZipUrl("https://" + "127.0.0.1" + ":8443/x.zip", FEED) !== "", "同 host（同站、换端口）放行：白名单按 host 判");
      ok(store.resolveZipUrl("/" + APP_ID + ".zip", "") === FEED + "/" + APP_ID + ".zip", "没给基址时退回静态目录基址");
    }

    /* ---- [6] 真装一次：接口来源的应用能下下来装进本机目录 ---- */
    console.log("[6] 从接口目录真装一次（下载 → 校验 sha256 → 解包落盘）");
    {
      cloud.mode = "static-empty";
      const dataDir = path.join(TMP, "d6");
      const store = freshStore(dataDir);
      const cat = await store.loadCatalog();
      ok((cat.apps || []).length === 1, "目录里有这条应用");
      const r = await store.installApp({ id: APP_ID, mode: "overwrite" });
      ok(r && r.ok === true, "安装成功" + (r && r.ok ? "" : "：" + JSON.stringify(r)));
      const appsRoot = path.join(dataDir, "apps-root");
      ok(fs.existsSync(path.join(appsRoot, APP_ID, "index.html")), "入口页落进本机应用目录");
      const hitZip = cloud.hits.some((h) => /\/api\/apps\/cloud-app\/file/.test(h));
      ok(hitZip, "下载确实走的接口地址（不是静态路径）");
    }

    console.log("\n" + (fails ? "FAILED" : "PASS") + "：smoke-apps-cloud " + (checks - fails) + "/" + checks + " 项通过");
    try { server.close(); } catch {}
    fs.rmSync(TMP, { recursive: true, force: true });
    if (fails ? 1 : 0) MERGED_FAILED = true;
  }

  CLOUD_DONE = main().catch((e) => {
    console.error("smoke-apps-cloud 崩了：" + ((e && e.stack) || e));
    try { server.close(); } catch {}
    if (1) MERGED_FAILED = true;
  });

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-apps-cloud.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-apps-cloud.js：" + fails + " / " + checks + " 项失败");
})();

/* 收尾：正文与并入块任一失败都算这只红；退出码**只在全部跑完之后**才定 ——
   并入块是异步的，早先这里同步 process.exit() 会在它跑完之前就把进程杀掉，
   于是「smoke-apps-cloud 这一块从来没跑过、却回了 PASS」（本轮补封面断言时才发现）。 */
Promise.resolve(CLOUD_DONE).then(() => {
  if (MERGED_FAILED) console.log("\n✗ 本文件有失败项（含已并入块）\n");
  process.exit(MERGED_FAILED ? 1 : 0);
});
