/* 只读探针（非交付件 · 不改应用代码 · 不写用户数据）：
 * 量「会话转写拆出 config.json 之后」两条落盘路径各自的代价，并与改前基线对照：
 *
 *   A. 设置保存（config:save 的现场口径）—— 拆出后这份文件只剩设置（几百 KB）
 *   B. 单条会话保存（session:save 的现场口径）—— 一个 agent-sessions/<id>.json
 *
 * 每条路径都把「另一次保存正在跑」时窗口里敲一下要等多久（IPC ping 往返峰值）量出来：
 * 子进程每 5 ms 发一次 ping，父进程同步做一遍落盘，ping 被推迟多少就是卡多少。
 * 写盘一律落 %TEMP%（用户数据一个字节都不动）；读输入只用只读打开。
 *
 * 改前基线（同一台机器，会话还在 config.json 里那会儿，见 cfg-save-cost.cjs）：
 *   config.json 75.8 MB，单次 config:save 主进程同步 775 ms（read 164 / parse 126 /
 *   stringify 208 / write 110 / 备份 17），窗口侧被拖住 p95 821 ms —— 而这么一次保存，
 *   会话运行中每写一条消息都会发生一次。
 *
 * 用法：node test/_perf-probe/session-save-cost.cjs [轮数，默认 5] [--dir=<数据目录>]
 *   --dir 指到「迁移后的语料沙盒」（test/_perf-probe/migrated-corpus.cjs 生成的那种）：
 *   真实用户目录上迁移还没跑过时，只能这样量拆开后的数字。
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { fork } = require("child_process");

const argv = process.argv.slice(2);
const dirArg = argv.find((a) => a.indexOf("--dir=") === 0);
const DATA = dirArg
  ? path.resolve(dirArg.slice(6))
  : path.join(process.env.APPDATA || "", "pipeline-console", "pipeline-console");
const CFG = path.join(DATA, "config.json");
const SESS_DIR = path.join(DATA, "agent-sessions");
const OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-savecost-"));
const ROUNDS = Math.max(1, Number(argv.find((a) => /^\d+$/.test(a))) || 5);

function stat(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}
function mb(n) {
  return (n / 1048576).toFixed(2) + " MB";
}
function biggestSessionFile() {
  try {
    const files = fs
      .readdirSync(SESS_DIR)
      .filter((f) => f.endsWith(".json") && f !== "index.json")
      .map((f) => ({ f, s: stat(path.join(SESS_DIR, f)) }))
      .filter((x) => x.s)
      .sort((a, b) => b.s.size - a.s.size);
    return files.length ? path.join(SESS_DIR, files[0].f) : "";
  } catch {
    return "";
  }
}

/* 与 main.js config:save 逐字同源：读文本 → parse → 合并 → 写 → 备份 */
function oneConfigSave(extra) {
  const t = {};
  const t0 = process.hrtime.bigint();
  const raw = fs.readFileSync(CFG, "utf8");
  const t1 = process.hrtime.bigint();
  const parsed = JSON.parse(raw);
  const t2 = process.hrtime.bigint();
  const next = Object.assign({}, parsed, extra);
  const pretty = JSON.stringify(next, null, 2);
  const t3 = process.hrtime.bigint();
  const compact = JSON.stringify(next);
  const t4 = process.hrtime.bigint();
  const tmp = path.join(OUT_DIR, "config.json.tmp" + process.pid);
  fs.writeFileSync(tmp, compact, "utf8");
  const t5 = process.hrtime.bigint();
  const dest = path.join(OUT_DIR, "config.json");
  fs.renameSync(tmp, dest);
  const t6 = process.hrtime.bigint();
  const bakDir = path.join(OUT_DIR, "config-backups");
  fs.mkdirSync(bakDir, { recursive: true });
  fs.copyFileSync(dest, path.join(bakDir, "config-" + Date.now() + ".json"));
  const t7 = process.hrtime.bigint();
  const ms = (a, b) => Number(b - a) / 1e6;
  t.read = ms(t0, t1);
  t.parse = ms(t1, t2);
  t.stringifyPretty = ms(t2, t3);
  t.stringifyCompact = ms(t3, t4);
  t.write = ms(t4, t5);
  t.rename = ms(t5, t6);
  t.backup = ms(t6, t7);
  t.total = ms(t0, t7);
  t.bytes = Buffer.byteLength(compact);
  t.prettyBytes = Buffer.byteLength(pretty);
  return t;
}

/* 与 agent-sessions-store.js 的 saveSessions 逐字同源：读旧文本比对 → 紧凑写 → 原子替换 */
function oneSessionSave(file, mutate) {
  const t = {};
  const t0 = process.hrtime.bigint();
  let cur = "";
  try {
    cur = fs.readFileSync(file, "utf8");
  } catch {}
  const t1 = process.hrtime.bigint();
  let body = null;
  try {
    body = JSON.parse(cur);
  } catch {}
  if (body && mutate) mutate(body);
  const text = JSON.stringify(body || {});
  const t2 = process.hrtime.bigint();
  let wrote = false;
  if (cur !== text) {
    const tmp = path.join(OUT_DIR, "sess.json.tmp" + process.pid);
    fs.writeFileSync(tmp, text, "utf8");
    const t3 = process.hrtime.bigint();
    fs.renameSync(tmp, path.join(OUT_DIR, "sess.json"));
    const t4 = process.hrtime.bigint();
    t.write = Number(t3 - t2) / 1e6;
    t.rename = Number(t4 - t3) / 1e6;
    wrote = true;
  } else {
    t.write = 0;
    t.rename = 0;
  }
  const t5 = process.hrtime.bigint();
  const ms = (a, b) => Number(b - a) / 1e6;
  t.read = ms(t0, t1);
  t.parseStringify = ms(t1, t2);
  t.total = ms(t0, t5);
  t.wrote = wrote;
  t.bytes = Buffer.byteLength(text);
  return t;
}

/* 子进程每 5 ms 发一次 ping：父进程同步阻塞期间它的 pong 会被推迟 */
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
const pk = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length * 0.95)] || 0;

async function measure(fn) {
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
  const t = fn();
  stop = true;
  await new Promise((res) => setTimeout(res, 20));
  t.blockP95 = pk(pings);
  t.blockMax = pings.length ? Math.max(...pings) : 0;
  return t;
}

(async () => {
  const cfgSt = stat(CFG);
  const sessFile = biggestSessionFile();
  const sessSt = sessFile ? stat(sessFile) : null;
  console.log("数据目录 =", DATA);
  console.log(
    "config.json = " +
      (cfgSt ? mb(cfgSt.size) : "（不存在）") +
      "  |  最大会话文件 = " +
      (sessSt ? mb(sessSt.size) + "（" + path.basename(sessFile) + "）" : "（没有 agent-sessions/）"),
  );
  console.log("临时落盘目录 =", OUT_DIR, "（用户数据一个字节都没动）\n");

  let cfgHasSessions = false;
  try {
    const j = JSON.parse(fs.readFileSync(CFG, "utf8"));
    cfgHasSessions = Array.isArray(j.agentSessions) && j.agentSessions.length > 0;
  } catch {}
  if (cfgHasSessions) {
    console.log(
      "⚠ config.json 里仍有 agentSessions（这台机器上迁移还没跑过）：A 段量到的是**改前**口径。\n" +
        "  要量拆开后的数字，先跑 node test/_perf-probe/migrated-corpus.cjs 再带 --dir 过来。\n",
    );
  }

  const base = [];
  for (let i = 0; i < 40; i++) {
    const t0 = process.hrtime.bigint();
    await ping();
    base.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  console.log("基线（主进程空闲）ping 往返 p95 =", pk(base).toFixed(2), "ms\n");

  const rows = { cfg: [], sess: [] };
  for (let r = 0; r < ROUNDS; r++) {
    const a = await measure(() => oneConfigSave({ probeStamp: Date.now() + ":" + r }));
    rows.cfg.push(a);
    console.log(
      "A 设置保存 第" + (r + 1) + "轮：read=" + a.read.toFixed(0) + " parse=" + a.parse.toFixed(0) +
        " stringify紧凑=" + a.stringifyCompact.toFixed(0) + "（缩进版 " + a.stringifyPretty.toFixed(0) + "）" +
        " write=" + a.write.toFixed(0) + " 备份=" + a.backup.toFixed(0) +
        " ⇒ 单次 " + a.total.toFixed(0) + " ms（" + a.bytes + " 字节）" +
        " | 同期窗口 ping p95=" + a.blockP95.toFixed(0) + " ms",
    );
  }
  if (sessFile) {
    for (let r = 0; r < ROUNDS; r++) {
      const b = await measure(() =>
        oneSessionSave(sessFile, (body) => {
          body.probeStamp = Date.now() + ":" + r;
          if (Array.isArray(body.messages) && body.messages.length)
            body.messages[body.messages.length - 1]._probe = r;
        }),
      );
      rows.sess.push(b);
      console.log(
        "B 会话保存 第" + (r + 1) + "轮：read=" + b.read.toFixed(0) + " parse+stringify=" +
          b.parseStringify.toFixed(0) + " write=" + b.write.toFixed(0) + " rename=" + b.rename.toFixed(0) +
          " ⇒ 单次 " + b.total.toFixed(0) + " ms（" + b.bytes + " 字节）" +
          (b.wrote ? "" : "（内容没变：一次磁盘都没碰）") +
          " | 同期窗口 ping p95=" + b.blockP95.toFixed(0) + " ms",
      );
    }
  }
  const avg = (arr, k) => (arr.length ? arr.reduce((s, x) => s + x[k], 0) / arr.length : 0);
  console.log("\n均值：");
  console.log(
    "  A 设置保存：" + avg(rows.cfg, "total").toFixed(0) + " ms（read " + avg(rows.cfg, "read").toFixed(0) +
      " / parse " + avg(rows.cfg, "parse").toFixed(0) + " / stringify紧凑 " + avg(rows.cfg, "stringifyCompact").toFixed(0) +
      " / write " + avg(rows.cfg, "write").toFixed(0) + " / 备份 " + avg(rows.cfg, "backup").toFixed(0) +
      "），窗口 ping p95 = " + avg(rows.cfg, "blockP95").toFixed(0) + " ms" +
      "，字节 " + avg(rows.cfg, "bytes").toFixed(0),
  );
  if (rows.sess.length)
    console.log(
      "  B 会话保存：" + avg(rows.sess, "total").toFixed(0) + " ms（read " + avg(rows.sess, "read").toFixed(0) +
        " / parse+stringify " + avg(rows.sess, "parseStringify").toFixed(0) + " / write " + avg(rows.sess, "write").toFixed(0) +
        "），窗口 ping p95 = " + avg(rows.sess, "blockP95").toFixed(0) + " ms" +
        "，字节 " + avg(rows.sess, "bytes").toFixed(0),
    );
  console.log(
    "\n改前基线（会话还在 config.json 里，本机实测）：单次 775 ms、窗口 ping p95 821 ms。" +
      "\n口径：两条路径都是「内容逐字没变就不落盘」，所以 B 段里没有改动的那几轮是 0 写。",
  );
  const res = path.join(os.tmpdir(), "session-save-cost.json");
  fs.writeFileSync(
    res,
    JSON.stringify(
      {
        cfg: CFG,
        cfgBytes: cfgSt ? cfgSt.size : 0,
        sessionFile: sessFile,
        sessionBytes: sessSt ? sessSt.size : 0,
        cfgHasSessions,
        baselineP95: pk(base),
        rows,
      },
      null,
      2,
    ),
  );
  console.log("结果 JSON =", res);
  pinger.kill();
  process.exit(0);
})();
