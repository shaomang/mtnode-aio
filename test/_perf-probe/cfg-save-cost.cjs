/* 只读探针（非交付件 · 不改应用代码 · 不写用户数据）：
 * 量「本机真实 config.json（78.5MB）走一遍 config:save 的代价」，并把这份阻塞
 * 落到一个独立子进程上模拟「另一个进程（应用窗口）的输入延迟」——
 * 子进程每 5ms 发一次 IPC ping，父进程同步做一遍 config:save 的 CPU/IO，
 * 记录 ping 往返的最大值 = 那一刻「窗口里敲一下」要等多久。
 *
 * 用法：node test/_perf-probe/cfg-save-cost.cjs [轮数，默认 5]
 * 读的只有 %APPDATA%\pipeline-console\pipeline-console\config.json（只读打开），
 * 写盘一律写 %TEMP%（config 与备份副本的字节都只在临时目录里落）。
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { fork } = require("child_process");

const CFG = path.join(
  process.env.APPDATA || "",
  "pipeline-console",
  "pipeline-console",
  "config.json",
);
const OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-cfgcost-"));
const ROUNDS = Math.max(1, Number(process.argv[2]) || 5);

function stat(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

/* 与 main.js config:save 逐字同源的三步：读文本 → parse → merge 后 stringify(null,2) */
function oneSyncSave(obj, text) {
  const t = {};
  const t0 = process.hrtime.bigint();
  const raw = fs.readFileSync(CFG, "utf8"); // main.js loadConfigText（大档每趟都真读）
  const t1 = process.hrtime.bigint();
  const parsed = JSON.parse(raw); // 只读校验：确保读到的确是合法 JSON
  const t2 = process.hrtime.bigint();
  const next = Object.assign({}, parsed, obj); // mergeConfigForSave 的顶层浅合并
  const pretty = JSON.stringify(next, null, 2); // 现场代码就是 null,2
  const t3 = process.hrtime.bigint();
  const compact = JSON.stringify(next); // config-providers.js 的紧凑口径（对照）
  const t4 = process.hrtime.bigint();
  const tmp = path.join(OUT_DIR, "config.json.tmp" + process.pid);
  fs.writeFileSync(tmp, pretty, "utf8");
  const t5 = process.hrtime.bigint();
  const dest = path.join(OUT_DIR, "config.json");
  fs.renameSync(tmp, dest);
  const t6 = process.hrtime.bigint();
  /* backupConfigFile：copyFileSync 整份 + readdir + stat 30 份 + 淘汰 */
  const bakDir = path.join(OUT_DIR, "config-backups");
  fs.mkdirSync(bakDir, { recursive: true });
  fs.copyFileSync(dest, path.join(bakDir, "config-" + Date.now() + ".json"));
  const t7 = process.hrtime.bigint();
  const files = fs
    .readdirSync(bakDir)
    .filter((f) => f.startsWith("config-") && f.endsWith(".json"))
    .map((f) => ({ f, t: fs.statSync(path.join(bakDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const old of files.slice(30)) {
    try {
      fs.unlinkSync(path.join(bakDir, old.f));
    } catch {}
  }
  const t8 = process.hrtime.bigint();
  const ms = (a, b) => Number(b - a) / 1e6;
  t.read = ms(t0, t1);
  t.parse = ms(t1, t2);
  t.stringifyPretty = ms(t2, t3);
  t.stringifyCompact = ms(t3, t4);
  t.writePretty = ms(t4, t5);
  t.rename = ms(t5, t6);
  t.backupCopy = ms(t6, t7);
  t.backupPrune = ms(t7, t8);
  t.total = ms(t0, t8);
  t.prettyBytes = Buffer.byteLength(pretty);
  t.compactBytes = Buffer.byteLength(compact);
  return t;
}

/* 子进程：每 5ms 往父进程发一次 ping，父进程同步阻塞期间它的 pong 会被推迟
 * → 拿出来就是「另一个渲染进程在那一刻要等多久」。 */
const pinger = fork(path.join(__dirname, "cfg-save-pinger.cjs"), [], {
  stdio: ["ignore", "ignore", "inherit", "ipc"],
});
let waiters = [];
pinger.on("message", () => {
  const w = waiters.shift();
  if (w) w();
});
function ping() {
  return new Promise((res) => {
    waiters.push(res);
    pinger.send("ping");
  });
}

(async () => {
  const st = stat(CFG);
  console.log("config.json =", CFG);
  console.log(
    "size =",
    (st ? (st.size / 1048576).toFixed(1) + " MB" : "-") +
      " | mtime = " +
      (st ? st.mtime.toISOString() : "-"),
  );
  console.log("临时落盘目录 =", OUT_DIR, "（用户数据一个字节都没动）\n");

  /* 基线：主进程空转时，子进程 ping 的往返（应为 ~0ms） */
  let base = [];
  for (let i = 0; i < 40; i++) {
    const t0 = process.hrtime.bigint();
    await ping();
    base.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const pk = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length * 0.95)] || 0;
  console.log(
    "基线（主进程空闲）ping 往返 p50/p95/max =",
    base.sort((a, b) => a - b)[Math.floor(base.length / 2)].toFixed(2) + "/" +
      pk(base).toFixed(2) + "/" + Math.max(...base).toFixed(2) + " ms\n",
  );

  const rows = [];
  for (let r = 0; r < ROUNDS; r++) {
    /* 每一轮都改一个键（模拟真实保存：内容不同 → 一定会备份 + 写盘） */
    const obj = { probeStamp: Date.now() + ":" + r };
    /* 阻塞期间持续 ping：一个 async 循环紧贴同步段跑，取这期间的往返峰值 */
    const pings = [];
    let stop = false;
    (async () => {
      while (!stop) {
        const t0 = process.hrtime.bigint();
        await ping();
        pings.push(Number(process.hrtime.bigint() - t0) / 1e6);
      }
    })();
    await new Promise((res) => setImmediate(res));
    const t = oneSyncSave(obj, null);
    stop = true;
    await new Promise((res) => setTimeout(res, 20));
    t.blockP95 = pk(pings);
    t.blockMax = pings.length ? Math.max(...pings) : 0;
    t.blockN = pings.length;
    rows.push(t);
    console.log(
      "第" + (r + 1) + "轮：" +
        "read=" + t.read.toFixed(0) + "ms" +
        " parse=" + t.parse.toFixed(0) + "ms" +
        " stringify(2空格)=" + t.stringifyPretty.toFixed(0) + "ms" +
        " [紧凑=" + t.stringifyCompact.toFixed(0) + "ms]" +
        " write=" + t.writePretty.toFixed(0) + "ms" +
        " backupCopy=" + t.backupCopy.toFixed(0) + "ms" +
        " backupPrune=" + t.backupPrune.toFixed(0) + "ms" +
        " ⇒ 一次 config:save 主进程同步 " + t.total.toFixed(0) + "ms" +
        " | 同期窗口 ping p95=" + t.blockP95.toFixed(0) + "ms max=" + t.blockMax.toFixed(0) + "ms",
    );
  }
  const avg = (k) => rows.reduce((s, r) => s + r[k], 0) / rows.length;
  console.log("\n均值：read=" + avg("read").toFixed(0) + " parse=" + avg("parse").toFixed(0) +
    " stringify2=" + avg("stringifyPretty").toFixed(0) + " write=" + avg("writePretty").toFixed(0) +
    " backup=" + (avg("backupCopy") + avg("backupPrune")).toFixed(0) +
    " ⇒ 单次 " + avg("total").toFixed(0) + "ms，窗口侧被拖住的峰值 p95=" +
    avg("blockP95").toFixed(0) + "ms max=" + avg("blockMax").toFixed(0) + "ms");
  const res = path.join(os.tmpdir(), "cfgcost.json");
  fs.writeFileSync(
    res,
    JSON.stringify({ cfg: CFG, cfgBytes: st ? st.size : 0, baselineP95: pk(base), rows }, null, 2),
  );
  console.log("结果 JSON =", res);
  pinger.kill();
  process.exit(0);
})();
