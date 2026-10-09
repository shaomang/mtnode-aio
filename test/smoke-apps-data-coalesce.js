/* test/smoke-apps-data-coalesce.js —— 回归：应用数据落盘「合并写」
 *
 * 钉的是一个真实故障（用户口径：应用「启动后（独立窗口里）卡顿严重」，开发页预览却完全顺）：
 *   · 预览帧里那座桥在「同一应用已开在独立窗口」时是**只读**的（写类能力同步拒），一条盘都不写；
 *   · 独立窗口那条路每次操作都会 store.set(整份 state) → 防抖 → dataWrite，
 *     而 dataWrite 是**同步整份写盘**（JSON.stringify + writeFileSync + rename，全在主进程）。
 *   实测（test/_perf-probe/disk-write-cost.cjs，本机）：纯主进程 2MB ≈ 45ms / 8MB ≈ 240ms；
 *   走完整链路（渲染层 invoke → 主进程写盘 → 回包）2MB ≈ 372ms、0.5MB ≈ 94ms —— 每次操作都付。
 *
 * 修法：apps-store.js 的 dataWrite / storageSet / storageRemove 走 **queueDataWrite**：
 *   合并窗 120ms 内同文件的多次整份写只落**最后一次**，上限 1.5s 必须落一次，
 *   连发超过 20 发就先把压着的那一发落下再重新起窗；读盘之前与关窗前一律先把在飞的落下
 *   （整份替换语义下，读到旧的那一份等于应用以为自己的写丢了）。
 *
 * 本回归钉的就是这套语义（真跑 apps-store.js：假 electron + 真文件系统，落在临时目录）：
 *   [1] 合并：连发 5 次只落一次盘，盘上是最新那一份
 *   [2] 读穿：dataRead 前先把在飞的落下（读到的是自己刚写的那份，不是盘上旧的）
 *   [3] 落定：合并窗到点后盘上就是最新那一份（不需要任何读 / 关窗触发）
 *   [4] 上限：连发超过 20 发不会攒着不落（中途必须已经落过盘）
 *   [5] 关窗：closeAppWindow 前把在飞的落下（关窗不丢最后一步）
 *   [6] 上限拒绝：超 2MB 仍回 storage_full（合并逻辑不能把体积闸门吃掉）
 *   [7] storageSet / storageRemove 也走合并（老 kv 通道同一口径）
 *   [8] 源码口径：writeJson 不再 pretty-print（紧凑序列化：体积直接砍一半上下）
 *
 * 用法：node test/smoke-apps-data-coalesce.js
 */
const fs = require("fs"),
  path = require("path"),
  os = require("os"),
  Module = require("module");

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
const read = (rel) => fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");

console.log("smoke-apps-data-coalesce：应用数据落盘的合并写\n");

/* ---------- 假 electron（与 smoke-apps.js 同一套口径：只给 apps-store.js 真用到的那几样） ---------- */
const winCalls = [];
const wcCalls = [];
function fakeWebContents() {
  const wc = {
    on() {},
    setWindowOpenHandler() {},
    send() {},
    isDestroyed: () => false,
  };
  wcCalls.push(wc);
  return wc;
}
class FakeBrowserWindow {
  constructor() {
    const rec = { closed: false };
    winCalls.push(rec);
    this.__rec = rec;
    this.webContents = fakeWebContents();
    this.__handlers = Object.create(null);
  }
  loadFile() {
    return Promise.resolve();
  }
  once() {}
  on(ev, cb) {
    this.__handlers[ev] = cb;
  }
  show() {}
  focus() {}
  setMenu() {}
  setAlwaysOnTop() {}
  isDestroyed() {
    return !!this.__closed;
  }
  close() {
    this.__closed = true;
    const h = this.__handlers["closed"];
    if (h) h();
  }
  getURL() {
    return "file:///app/index.html";
  }
  static fromWebContents() {
    return null;
  }
}
const ipcMainMock = { __h: Object.create(null), handle(ev, fn) { this.__h[ev] = fn; } };
const electronMock = {
  app: {
    getAppPath: () => ROOT,
    getPath: (k) => (k === "exe" ? path.join(ROOT, "node_modules", "electron", "dist", "electron.exe") : ROOT),
  },
  BrowserWindow: FakeBrowserWindow,
  ipcMain: ipcMainMock,
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
const store = require(path.join(ROOT, "apps-store.js"));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-apps-coalesce-"));
const DATA = path.join(TMP, "data");
const APPS_ROOT = path.join(TMP, "apps-root");
store.registerAppsIpc({ getDataDir: () => DATA, getMainWin: () => null, t: (s) => String(s) });
store.setRoot(APPS_ROOT);

const APP_ID = "coalesce-app";
const made = store.createApp({ name: "合并写应用", id: APP_ID });
ok(made && made.ok, "建出测试应用 " + APP_ID);
ok(store.openAppWindow(APP_ID).ok === true, "开窗（拿到发送方 webContents，senderAppDir 才认得出应用）");
const wc = wcCalls[wcCalls.length - 1];
const ev = { sender: wc };
const call = (ch, arg) => ipcMainMock.__h[ch](ev, arg);

/* 该应用的数据文件落点：从应用数据根里找（不猜路径口径） */
function dataFileOf() {
  const root = path.join(DATA, "apps-data");
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    let ents = [];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === "data.json") return p;
    }
  }
  return "";
}
const readDisk = () => {
  const f = dataFileOf();
  if (!f) return null;
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return null;
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  /* ---------- [1] 合并：连发 5 次只落一次盘 ---------- */
  {
    console.log("[1] 合并窗口内连发 5 次：盘上只被写一次，且是最新那一份");
    const t0 = Date.now();
    for (let i = 1; i <= 5; i++) {
      const r = await call("apps:hostDataWrite", { data: { v: i, tag: "第" + i + "份" }, file: "data.json" });
      ok(r && r.ok === true && r.coalesced === true, "第 " + i + " 次 dataWrite 回 ok（合并中，coalesced=true）");
    }
    ok(readDisk() === null, "合并窗内盘上还没有文件（5 次没有各写一遍）");
    ok(Date.now() - t0 < 120, "5 次调用本身几乎不花时间（不再各付一次同步写盘）");
    await sleep(260);
    const d = readDisk();
    ok(d && d.v === 5 && d.tag === "第5份", "合并窗到点后盘上是最后那一份（v=5）");
  }

  /* ---------- [2] 读穿：dataRead 之前先把在飞的落下 ---------- */
  {
    console.log("[2] 写后立刻读：读到的是自己刚写的那份（整份替换语义）");
    await call("apps:hostDataWrite", { data: { v: 7, tag: "读穿" }, file: "data.json" });
    const r = await call("apps:hostDataRead", { file: "data.json" });
    ok(r && r.ok === true && r.data && r.data.v === 7, "dataRead 回自己刚写的那份（v=7，不是盘上旧的 v=5）");
    ok(readDisk() && readDisk().v === 7, "读那一刻在飞的那一发已经真落盘");
  }

  /* ---------- [3] 落定：合并窗到点后自己会落（不需要任何读 / 关窗触发） ---------- */
  {
    console.log("[3] 合并窗到点自己落盘");
    await call("apps:hostDataWrite", { data: { v: 9 }, file: "data.json" });
    ok(readDisk() && readDisk().v === 7, "刚写完这一瞬盘上还是上一份（v=7）");
    await sleep(260);
    ok(readDisk() && readDisk().v === 9, "合并窗到点后盘上自动变成 v=9");
  }

  /* ---------- [4] 连发上限：超过 20 发不会攒着不落 ---------- */
  {
    console.log("[4] 连发超过 20 发：中途必须已经落过盘（不会把 20+ 次整份写挤在同一个 tick）");
    for (let i = 0; i < 25; i++) await call("apps:hostDataWrite", { data: { v: 100 + i, burst: true }, file: "data.json" });
    const mid = readDisk();
    ok(mid && mid.burst === true && mid.v >= 100 && mid.v < 124, "连发途中盘上已经落过一次（v=" + (mid && mid.v) + "），不是全攒着");
    await sleep(300);
    ok(readDisk() && readDisk().v === 124, "最后一次仍会落盘（v=124）");
  }

  /* ---------- [5] 关窗：closeAppWindow 前把在飞的落下 ---------- */
  {
    console.log("[5] 关窗前把在飞的落下（关窗不丢最后一步）");
    await call("apps:hostDataWrite", { data: { v: 555, lastStep: true }, file: "data.json" });
    ok(readDisk() && readDisk().v === 124, "关窗前盘上还是旧的（v=124）");
    store.closeAppWindow(APP_ID);
    ok(readDisk() && readDisk().v === 555 && readDisk().lastStep === true, "关窗那一刻最后那一发已经落盘（v=555）");
  }

  /* ---------- [6] 体积闸门：合并逻辑不能把 2MB 上限吃掉 ---------- */
  {
    console.log("[6] 超 2MB 仍回 storage_full");
    const big = { blob: "x".repeat(2 * 1024 * 1024 + 64) };
    const r = await call("apps:hostDataWrite", { data: big, file: "data.json" });
    ok(r && r.ok === false && r.code === "storage_full", "超上限回 storage_full（没有先排队再写进去）");
    ok(readDisk() && readDisk().v === 555, "被拒的那一份没有污染盘上数据");
  }

  /* ---------- [7] 老 kv 通道同一口径 ---------- */
  {
    console.log("[7] storageSet / storageRemove 也走合并");
    store.openAppWindow(APP_ID);
    const wc2 = wcCalls[wcCalls.length - 1];
    const ev2 = { sender: wc2 };
    const call2 = (ch, arg) => ipcMainMock.__h[ch](ev2, arg);
    const r = await call2("apps:hostStorageSet", { key: "k1", value: "v1" });
    ok(r && r.ok === true, "storageSet 回 ok");
    const all = await call2("apps:hostStorageAll", {});
    ok(all && all.ok === true && all.kv && all.kv.k1 === "v1", "storageAll 立刻读得到刚写的键（读穿）");
    const rm = await call2("apps:hostStorageRemove", { key: "k1" });
    ok(rm && rm.ok === true, "storageRemove 回 ok");
    const all2 = await call2("apps:hostStorageAll", {});
    ok(all2 && all2.kv && all2.kv.k1 === undefined, "删掉之后读不到该键");
    store.closeAppWindow(APP_ID);
  }

  /* ---------- [8] 源码口径：紧凑序列化 ---------- */
  {
    console.log("[8] 落盘序列化不再 pretty-print");
    const CP = read("config-providers.js");
    ok(CP.indexOf("JSON.stringify(v, null, 2)") < 0 && CP.indexOf("JSON.stringify(v)") > 0, "config-providers.writeJson 用紧凑 JSON.stringify（不再缩进两格）");
    const APPS = read("apps-store.js");
    ok(APPS.indexOf("DATA_WRITE_COALESCE_MS") > 0 && APPS.indexOf("DATA_WRITE_MAX_DELAY_MS") > 0 && APPS.indexOf("DATA_WRITE_BURST") > 0, "apps-store 三个合并参数都在（窗口 / 上限 / 连发阈值）");
    ok(APPS.indexOf("function queueDataWrite") > 0 && APPS.indexOf("function dataWriteFlushApp") > 0 && APPS.indexOf("function dataWriteFlushAll") > 0, "queueDataWrite / dataWriteFlushApp / dataWriteFlushAll 齐备");
    ok(/hostDataWrite[\s\S]{0,600}queueDataWrite\(target/.test(APPS), "hostDataWrite 走 queueDataWrite");
    ok(/closeAppWindow\(id\)[\s\S]{0,400}dataWriteFlushApp\(sid\)/.test(APPS), "closeAppWindow 里先把在飞的落下");
  }

  console.log("\n" + (fails ? "FAIL " + fails + " 项失败" : "PASS") + " · " + checks + " 项检查");
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
  process.exit(fails ? 1 : 0);
})();
