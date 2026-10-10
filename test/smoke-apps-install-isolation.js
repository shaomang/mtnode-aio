/* test/smoke-apps-install-isolation.js — 下载 / 更新 / 覆盖**只动库（下载根）那一份**，
 * 开发中的项目文件夹一个字节都不动（零依赖，纯 Node，不起 Electron、不联网）
 *
 *   node test/smoke-apps-install-isolation.js
 *
 * 用户口径（2026-10-10 报障 + 本轮共识）：
 *   · 「应用下载时，是直接更新覆盖库中的应用，与开发毫无关系；库中的应用与开发中的应用是隔离的；
 *      只有在二次开发时才会进行 agent 合并或覆盖等选项。」
 *   · 于是这轮要钉住两件事：
 *     ① **同一个 id 在下载根与项目根各有一份**时，下载 / 更新三条 mode（"" / update / overwrite）
 *        都只替换 <下载根>/<id>，<项目根>/<id> 的每个文件的 sha256 + mtime 与装之前一模一样，
 *        也不产生 / 改动任何开发侧的东西；
 *     ② 界面（renderer/app-apps.js 的 appsDownload）的**完成 toast 必须写明「只更新了库里的那一份」**
 *        —— 用户过去看到的只有「已更新：X v1.1.0」，会以为自己的开发版被覆盖。
 *        合并 / 完全替换这两条路只在「二次开发」入口里（app-branch-merge.js /
 *        app-branch-replace.js），下载链一个字都不碰它们。
 *  真 IPC 通道（apps:install）真跑安装：本机 HTTP 静态目录 + zip + sha256 校验，全部落在临时目录。
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
let fails = 0;
let checks = 0;
const ok = (cond, msg, extra) => {
  checks++;
  console.log((cond ? "  ok    " : "FAIL  ") + msg + (cond || extra === undefined ? "" : "  → " + String(extra).slice(0, 300)));
  if (!cond) fails++;
};
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

/* ---------------- electron 打桩（与 smoke-apps-dual-root.js 同一手法） ---------------- */
const handlers = Object.create(null);
const electronStub = {
  app: { getAppPath: () => ROOT, getPath: () => "C:\\mtnode-fake-exe\\app.exe", isPackaged: false },
  BrowserWindow: class {},
  ipcMain: {
    handle(name, fn) {
      handlers[name] = fn;
    },
  },
  dialog: {},
  shell: { openPath: async () => "" },
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  protocol: { registerSchemesAsPrivileged() {}, handle() {} },
  session: {},
  nativeImage: {},
};
const load = Module._load;
Module._load = function (req) {
  if (req === "electron") return electronStub;
  return load.apply(this, arguments);
};

/* ---------------- 冒烟自带 zip（storeMode 0，与 smoke-app-versions.js 同款） ---------------- */
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
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(0, 42);
    central.push(ch, name);
    off += lh.length + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(off, 16);
  return Buffer.concat([Buffer.concat(locals), cd, eocd]);
}
const APP_ID = "isolation-app";
const V1 = "1.0.0";
const V2 = "1.1.0";
const zipOf = (ver, body) =>
  makeZip([
    { name: "index.html", data: Buffer.from("<html><body>" + body + "</body></html>", "utf8") },
    { name: "app.json", data: Buffer.from(JSON.stringify({ id: APP_ID, name: "隔离冒烟", version: ver, entry: "index.html" }), "utf8") },
  ]);
const ZIP1 = zipOf(V1, "cloud-v1");
const ZIP2 = zipOf(V2, "cloud-v2");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const SHA2 = sha(ZIP2);

const server = http.createServer((req, res) => {
  const u = new URL(req.url || "/", "http://local");
  const p = u.pathname;
  const send = (code, body, type) => {
    res.writeHead(code, { "Content-Type": type || "application/json" });
    res.end(Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), "utf8"));
  };
  if (p.endsWith("/apps/catalog.json")) {
    return send(200, {
      version: 1,
      updatedAt: "2026-10-10T00:00:00.000Z",
      apps: [
        {
          id: APP_ID,
          title: "隔离冒烟",
          description: "同一个 id 两边各一份时，下载只动库那一份",
          version: V2,
          latestVersion: V2,
          zipUrl: APP_ID + ".zip",
          sha256: SHA2,
          entry: "index.html",
          owner: "tester",
          ownerId: "u_tester",
          versions: [
            { version: V1, zipUrl: APP_ID + "/" + V1 + ".zip", sha256: sha(ZIP1), bytes: ZIP1.length, createdAt: 1000, uploader: "tester" },
            { version: V2, zipUrl: APP_ID + "/" + V2 + ".zip", sha256: SHA2, bytes: ZIP2.length, createdAt: 2000, uploader: "tester", parentVersion: V1 },
          ],
        },
      ],
    });
  }
  if (p === "/mtnode/apps/" + APP_ID + ".zip") return send(200, ZIP2, "application/zip");
  if (p === "/mtnode/apps/" + APP_ID + "/" + V1 + ".zip") return send(200, ZIP1, "application/zip");
  if (p === "/mtnode/apps/" + APP_ID + "/" + V2 + ".zip") return send(200, ZIP2, "application/zip");
  return send(404, { ok: false, error: "no route " + p });
});

/* ---------------- 现场：两套根各一份（同 id） ---------------- */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-install-isolation-"));
const DATA = path.join(TMP, "data");
const DL = path.join(TMP, "apps-library");
const DEV = path.join(TMP, "apps-project");
for (const d of [DATA, DL, DEV]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(
  path.join(DATA, "config.json"),
  JSON.stringify({ apps: { installDir: DL, projectDir: DEV } }, null, 2),
  "utf8",
);
/* 库那一份（下载根）：旧版 + 安装账本 —— 这次要把它更新成 V2 */
const dlDir = path.join(DL, APP_ID);
fs.mkdirSync(dlDir, { recursive: true });
fs.writeFileSync(path.join(dlDir, "index.html"), "<html><body>library-old</body></html>", "utf8");
fs.writeFileSync(
  path.join(dlDir, "app.json"),
  JSON.stringify({ id: APP_ID, name: "隔离冒烟", version: V1, entry: "index.html", dev: false }, null, 2),
  "utf8",
);
fs.writeFileSync(
  path.join(dlDir, "installed.json"),
  JSON.stringify({ schema: 1, id: APP_ID, version: V1, source: "http://local/old.zip", installedAt: 1, files: ["index.html", "app.json"] }, null, 2),
  "utf8",
);
/* 开发那一份（项目根）：他自己在改的目录 —— 这次**一个字节都不许动** */
const devDir = path.join(DEV, APP_ID);
fs.mkdirSync(path.join(devDir, "assets"), { recursive: true });
fs.writeFileSync(path.join(devDir, "index.html"), "<html><body>my-dev-copy</body></html>", "utf8");
fs.writeFileSync(path.join(devDir, "app.json"), JSON.stringify({ id: APP_ID, name: "我的开发版", version: "9.9.9", entry: "index.html", dev: true }, null, 2), "utf8");
fs.writeFileSync(path.join(devDir, "assets", "mine.js"), "console.log('我的源码');\n", "utf8");
fs.writeFileSync(path.join(devDir, ".merge-done.json"), JSON.stringify({ at: 123, by: "agent" }), "utf8");

/** 目录指纹：相对路径 → { sha256, mtimeMs }（mtime 也记 —— 「没动」要连时间戳一起证明） */
function snap(dir) {
  const out = Object.create(null);
  const walk = (base, rel) => {
    for (const ent of fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(base, ent.name);
      const r = rel ? rel + "/" + ent.name : ent.name;
      if (ent.isDirectory()) walk(abs, r);
      else {
        const st = fs.statSync(abs);
        out[r] = { sha256: sha(fs.readFileSync(abs)), mtimeMs: st.mtimeMs, bytes: st.size };
      }
    }
  };
  walk(dir, "");
  return out;
}
function diffSnap(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const bad = [];
  for (const k of keys) {
    const x = a[k];
    const y = b[k];
    if (!x || !y) {
      bad.push(k + (x ? "（被删）" : "（新增）"));
      continue;
    }
    if (x.sha256 !== y.sha256) bad.push(k + "（内容变了）");
    else if (Number(x.mtimeMs) !== Number(y.mtimeMs)) bad.push(k + "（mtime 变了）");
  }
  return bad;
}

async function main() {
  console.log("smoke-apps-install-isolation：下载 / 更新只动库那一份\n");
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const PORT = server.address().port;
  process.env.MTNODE_APPS_URL = "http://127.0.0.1:" + PORT + "/mtnode/apps";
  process.env.MTNODE_STORE_URL = "http://127.0.0.1:" + PORT;
  const store = require(path.join(ROOT, "apps-store.js"));
  store.registerAppsIpc({ getDataDir: () => DATA, t: (s) => String(s == null ? "" : s) });
  const call = (name, arg) => handlers[name]({ sender: null }, arg);

  const devBefore = snap(devDir);
  const libBefore = snap(dlDir);
  ok(Object.keys(devBefore).length >= 4, "开发那份有 4 个文件（含 assets/mine.js 与 .merge-done.json）");
  ok(String(JSON.parse(fs.readFileSync(path.join(devDir, "app.json"), "utf8")).version) === "9.9.9", "开发那份版本号 = 9.9.9（本机自己的）");

  console.log("\n[1] 先按本机双根的口径认一遍现场");
  {
    const r = await call("apps:list");
    const mine = r.apps.filter((a) => a.id === APP_ID);
    ok(mine.length === 2, "同 id 两条都在（下载根 + 项目根），实际 " + mine.length);
    ok(store.diskKindOf(APP_ID) === "down", "diskKindOf 缺省 = 下载那份（库）");
    ok(store.diskKindOf(APP_ID, "dev") === "dev", "diskKindOf(dev) = 项目根那份（开发）");
    ok(path.resolve(store.dirOfApp(APP_ID)) === path.resolve(dlDir), "dirOfApp 缺省 = 库目录");
    ok(path.resolve(store.dirOfApp(APP_ID, "dev")) === path.resolve(devDir), "dirOfApp(dev) = 开发目录");
  }

  /* 三条 mode 各跑一次：""（首次下载路径 —— 库那份已存在，主进程按老口径回冲突三态，
     渲染层拿到 conflict 再带 overwrite 重来，见 app-apps.js 的 appsConflictAsk）/ update / overwrite。
     每次跑完都要求「库那份确实换了」而「开发那份纹丝不动」。 */
  const modes = ["", "update", "overwrite"];
  for (let i = 0; i < modes.length; i++) {
    const mode = modes[i];
    console.log("\n[2." + (i + 1) + "] apps:install mode=\"" + (mode || "(空)") + "\"");
    let r = await call("apps:install", { id: APP_ID, mode: mode, version: V2, ownerId: "u_tester" });
    if (r && r.ok === false && r.conflict) {
      /* 空 mode + 库那份已在 = 冲突三态（覆盖 / 改名 / 取消）：这正是下载链的第一次尝试。
         冲突**只针对库目录**（主进程看的就是下载根里有没有同名目录）——开发那份不参与判定。 */
      ok(r.code === "exists" && Array.isArray(r.choices) && r.choices.join(",") === "overwrite,rename,cancel",
        "空 mode + 库那份已在 → 冲突三态（覆盖 / 改名 / 取消），且只针对库目录");
      const ex = r.existing || {};
      ok(path.resolve(String(ex.dir || "")) === path.resolve(dlDir) || String(ex.id || "") === APP_ID,
        "冲突里的 existing 是**库那一份**（开发那份不参与判定）", JSON.stringify({ id: ex.id, version: ex.version }));
      r = await call("apps:install", { id: APP_ID, mode: "overwrite", version: V2, ownerId: "u_tester" });
    }
    ok(r && r.ok === true, "安装回执 ok（mode=" + (mode || "空") + "）", r && (r.error || ""));
    ok(path.resolve(String(r.dir || "")) === path.resolve(dlDir), "★ 装进的是**库目录**：" + path.basename(String(r.dir || "")));
    const libMan = JSON.parse(fs.readFileSync(path.join(dlDir, "app.json"), "utf8"));
    ok(String(libMan.version) === V2, "库那份已换成 v" + V2 + "（实得 v" + libMan.version + "）");
    ok(fs.readFileSync(path.join(dlDir, "index.html"), "utf8").indexOf("cloud-v2") >= 0, "库那份的 index.html 是云端 v2 的内容");
    const bad = diffSnap(devBefore, snap(devDir));
    ok(bad.length === 0, "★ 开发那份（项目根）内容与 mtime 一个字节都没变", bad.join(", "));
    const devMan = JSON.parse(fs.readFileSync(path.join(devDir, "app.json"), "utf8"));
    ok(String(devMan.version) === "9.9.9" && devMan.dev === true, "开发那份仍是 dev:true / v9.9.9（没被云端清单顶掉）");
  }

  console.log("\n[3] 库那份的安装账本照旧只记库自己的来源");
  {
    const led = JSON.parse(fs.readFileSync(path.join(dlDir, "installed.json"), "utf8"));
    ok(String(led.version) === V2, "账本当前版 = v" + V2);
    ok(String(led.source || "").indexOf(APP_ID) > 0 && /\.zip$/.test(String(led.source || "")), "账本记的是这次真下下来的地址：" + String(led.source || ""));
    ok(!fs.existsSync(path.join(devDir, "installed.json")), "开发那份**不会**被写进安装账本（它不是从云端装下来的）");
  }

  console.log("\n[4] 界面口径：完成 toast 必须写明「只动库那一份」");
  {
    const apps = read("renderer/app-apps.js");
    const i = apps.indexOf("async function appsDownload(");
    const body = i < 0 ? "" : apps.slice(i, apps.indexOf("\n}\n", i) + 2);
    ok(i > 0 && body.length > 200, "取到 appsDownload 的原文");
    ok(
      body.indexOf("（只更新了库里的那一份，开发中的项目文件夹未动）") > 0 &&
        body.indexOf("（只装进库里，开发中的项目文件夹未动）") > 0 &&
        /appsT\(\s*r\.updated\s*\?/.test(body),
      "★ 成功 toast 里按「更新 / 新装」分别写明只动库那一份",
    );
    ok(!/appsMergeStart|appsBranchReplace|appsReplace/.test(body), "appsDownload 里不出现任何合并 / 完全替换调用（那两条只在二次开发入口里）");
    const cmt = apps.indexOf("下载 / 更新 / 覆盖**一律只动库里的那一份**");
    ok(cmt > 0, "appsDownload 上方留了口径注释（可复核）");
    const i18n = read("renderer/i18n.js");
    ok(i18n.indexOf('"（只更新了库里的那一份，开发中的项目文件夹未动）"') > 0, "i18n 收了新词条（更新那一句）");
    ok(i18n.indexOf('"（只装进库里，开发中的项目文件夹未动）"') > 0, "i18n 收了新词条（新装那一句）");
    ok(
      /"（只更新了库里的那一份，开发中的项目文件夹未动）":\s*\n\s*"[^"]+"/.test(i18n) &&
        /"（只装进库里，开发中的项目文件夹未动）":\s*\n\s*"[^"]+"/.test(i18n),
      "两条词条都有英文译文（en locale 不回落中文）",
    );
  }

  console.log("\n[5] 源码口径：安装链只认下载根（不许出现别的写路径）");
  {
    const s = read("apps-store.js");
    const i = s.indexOf("async function installApp(arg)");
    const j = s.indexOf("async function rollbackApp(arg)");
    const fn = i < 0 || j < i ? "" : s.slice(i, j);
    ok(fn.length > 1000, "取到 installApp 的原文");
    ok(/ensureRootPersisted\(APP_KIND_DOWN\)/.test(fn), "installApp 只用下载根（ensureRootPersisted(APP_KIND_DOWN)）");
    ok(!/ensureRootPersisted\(APP_KIND_DEV\)|rootPathOf\(APP_KIND_DEV\)/.test(fn), "★ installApp 里不出现项目根（开发侧）的任何根解析");
    ok(!/app-branch-merge|app-branch-replace/.test(fn), "★ installApp 里不碰合并 / 完全替换的实现（它们只在二次开发入口里）");
    ok(fs.existsSync(path.join(ROOT, "app-branch-merge.js")) && fs.existsSync(path.join(ROOT, "app-branch-replace.js")),
      "两条二次开发路径的实现文件本来就在（本轮的隔离没有删掉它们）");
  }

  console.log("\n" + (fails ? "FAILED " + fails + " / " + checks : "ALL PASS " + checks + " 项"));
  server.close();
  process.exit(fails ? 1 : 0);
}

main().catch((e) => {
  console.error("脚本自身出错：" + ((e && e.stack) || e));
  server.close();
  process.exit(1);
});
