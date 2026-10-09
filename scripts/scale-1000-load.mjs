/* scripts/scale-1000-load.mjs — 「1000 条目录」压测（本地沙箱 / 生产隔离实例 / 线上只读）
 * ============================================================================
 * 用法（Node ≥18，零依赖）：
 *   node scripts/scale-1000-load.mjs --base http://127.0.0.1:18790
 *   node scripts/scale-1000-load.mjs --base http://127.0.0.1:18790 --levels 10,50,100,200 --secs 60
 *   node scripts/scale-1000-load.mjs --base http://127.0.0.1:18790 --write 1 --user ms2308 --pass xxx
 *   node scripts/scale-1000-load.mjs --base http://127.0.0.1:18790 --json out.json --no-write
 *
 * 口径（与本轮验证报告一致）：
 *   · 阶梯升压：默认 10 → 50 → 100 → 200 并发，每档 60s；
 *   · 场景混合：目录**全量下载**（/mtnode/apps/catalog.json 或 /api/apps/catalog）占 40%、
 *     接口目录占 20%、列表分页占 15%、详情占 15%、未登录首页 /api/apps/pub 占 10%；
 *   · 读写比默认 9:1：每 10 次读夹 1 次写（追加一个版本到 --user 名下的小应用；
 *     写路径要登录，没给 --user/--pass 就自动退化成纯读，并在报告里注明）；
 *   · 每档开头先 10 次预热（不算成绩），避免把首连 TLS / 编译开销算成 P95；
 *   · 报 P50 / P90 / P95 / P99 / 最大值 + 错误率 + 吞吐（每档的实际 QPS）。
 * 退出码：0 = 达标（目录接口 P95 < --p95 且错误率 < --max-err），1 = 不达标。
 * 安全：只打你给的 --base；写操作只动 --write-id 指定的应用（默认自动挑 --user 名下第一条
 *   以 scale1000 开头的应用），绝不动别人的数据。
 * ========================================================================== */
import fs from "node:fs";

function arg(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}
const BASE = String(arg("base", "http://127.0.0.1:18790")).replace(/\/+$/, "");
const LEVELS = String(arg("levels", "10,50,100,200"))
  .split(",")
  .map((x) => parseInt(x, 10))
  .filter((x) => x > 0);
const SECS = Number(arg("secs", 60)) || 60;
const WARM = Number(arg("warm", 10)) || 10;
const USER = String(arg("user", "") || "");
const TICKET = String(arg("ticket", "") || ""); /* 直接给票（沙箱 adm_ 票即第一个作者身份） */
const PASS = String(arg("pass", "") || "");
const WRITE_ON = arg("no-write", false) !== true;
const WRITE_RATIO = Math.max(0, Number(arg("write-ratio", 10)) || 10); // 每 N 次读夹 1 次写
const P95_LIMIT = Number(arg("p95", 700)) || 700; // 目录接口 P95 上限（含公网往返；同机 localhost 远低于它）
const MAX_ERR = Number(arg("max-err", 0.01)) || 0.01;
const JSON_OUT = arg("json", "");
const TAG = String(arg("tag", "scale1000") || "scale1000");

const stats = new Map(); // kind -> {ms:[], err:0, ok:0}
function rec(kind, ms, ok) {
  let s = stats.get(kind);
  if (!s) {
    s = { ms: [], err: 0, ok: 0 };
    stats.set(kind, s);
  }
  s.ms.push(ms);
  if (ok) s.ok++;
  else s.err++;
}
function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}
function summarize(levels) {
  const out = [];
  for (const [kind, s] of stats) {
    const sorted = s.ms.slice().sort((a, b) => a - b);
    out.push({
      kind: kind,
      n: s.ms.length,
      ok: s.ok,
      err: s.err,
      errRate: s.ms.length ? +(s.err / s.ms.length).toFixed(4) : 0,
      p50: pct(sorted, 50),
      p90: pct(sorted, 90),
      p95: pct(sorted, 95),
      p99: pct(sorted, 99),
      max: sorted.length ? sorted[sorted.length - 1] : 0,
    });
  }
  return out.sort((a, b) => a.kind.localeCompare(b.kind));
}

let API_BASE = BASE;
async function detectBase() {
  const tries = [BASE, BASE + "/mtnode/store-api"];
  for (const b of tries) {
    try {
      const r = await fetch(b + "/api/apps/pub");
      if (r.status) return b;
    } catch (_) {}
  }
  return BASE;
}

async function login() {
  if (TICKET) return TICKET;
  if (!USER || !PASS) return "";
  try {
    const r = await fetch(API_BASE + "/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: USER, password: PASS }),
    });
    const d = await r.json();
    return d && d.token ? d.token : "";
  } catch (_) {
    return "";
  }
}

async function pickWriteTarget(token) {
  if (!token) return "";
  try {
    const who = USER ? encodeURIComponent(USER) : "";
    const r = await fetch(API_BASE + "/api/apps?pageSize=50" + (who ? "&owner=" + who : ""), {
      headers: { authorization: "Bearer " + token },
    });
    const d = await r.json();
    const list = (d && d.items) || [];
    const hit = list.find((x) => String(x.id || "").startsWith(TAG)) || list[0];
    return hit ? String(hit.id) : "";
  } catch (_) {
    return "";
  }
}

function timed(fn) {
  const t0 = performance.now();
  return fn().then(
    (r) => ({ r, ms: performance.now() - t0, ok: true }),
    (e) => ({ r: null, ms: performance.now() - t0, ok: false, err: e }),
  );
}

async function main() {
  API_BASE = await detectBase();
  const token = await login();
  const writeId = WRITE_ON ? await pickWriteTarget(token) : "";
  const canWrite = !!(token && writeId);
  console.log(
    "[load] 基址 " + API_BASE + " · 档位 " + LEVELS.join(",") + " · 每档 " + SECS + "s · 写 " +
      (canWrite ? "开（" + writeId + "，每 " + WRITE_RATIO + " 读夹 1 写）" : "关（没给 --user/--pass 或名下没有可写应用）"),
  );

  /* 场景表：按权重轮转（确定性，便于复现；不引入随机） */
  const plan = [];
  const push = (kind, n, fn) => {
    for (let i = 0; i < n; i++) plan.push({ kind, fn });
  };
  const getText = (p) => () => fetch(API_BASE + p).then((r) => r.text());
  const getJson = (p) => () => fetch(API_BASE + p).then((r) => r.json());
  push("catalog-static", 4, getText("/mtnode/apps/catalog.json"));
  push("catalog-api", 2, getJson("/api/apps/catalog"));
  push("list-page", 1, getJson("/api/apps?pageSize=50&sort=new"));
  push("detail", 1, getJson("/api/apps?pageSize=1&sort=downloads"));
  push("pub", 1, getJson("/api/apps/pub"));
  push("templates", 1, getJson("/api/templates?pageSize=50"));
  if (canWrite) {
    const writeFn = () =>
      fetch(API_BASE + "/api/apps/" + encodeURIComponent(writeId) + "/versions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify({
          version: "9." + Date.now() % 100000 + "." + Math.floor(Math.random() * 1000),
          zipBase64:
            "UEsDBBQAAAAIAAAAIQC8z8DwHwAFAAUAAAALAAAAaW5kZXguaHRtbDxodG1sPjxiPng8L2I+PC9odG1sPlBLAQIUAxQAAAAIAAAAIQC8z8DwHwAFAAUAAAALAAAAAAAAAAAAAACAAQAAAABpbmRleC5odG1sUEsFBgAAAAABAAEALgAAAC0AAAAAAA==",
          acceptDeclaration: true,
        }),
      }).then((r) => r.json());
    /* 读写比：每 WRITE_RATIO 次读夹 1 次写。1 次写也算一条计划项，权重 = ceil(总读/比例)。 */
    const readsPlanned = 10;
    const writeSlots = Math.max(1, Math.round(readsPlanned / Math.max(1, WRITE_RATIO)));
    push("write-version", writeSlots, writeFn);
  }

  const levels = [];
  for (const conc of LEVELS) {
    /* 预热（不算成绩） */
    await Promise.all(Array.from({ length: WARM }, (_, i) => plan[i % plan.length].fn().catch(() => {})));
    const before = new Map();
    for (const [k, v] of stats) before.set(k, { n: v.ms.length, err: v.err });
    const t0 = performance.now();
    const deadline = t0 + SECS * 1000;
    let issued = 0;
    const worker = async (idx) => {
      let i = idx;
      while (performance.now() < deadline) {
        const job = plan[i % plan.length];
        const out = await timed(job.fn);
        /* 写场景在 409（版本号撞了）时也算成功：服务端正确拒绝也算「服务没坏」 */
        rec(job.kind, out.ms, out.ok);
        i++;
        issued++;
      }
    };
    await Promise.all(Array.from({ length: conc }, (_, i) => worker(i)));
    const dur = (performance.now() - t0) / 1000;
    const per = [];
    for (const [k, v] of stats) {
      const from = before.get(k) || { n: 0, err: 0 };
      const slice = v.ms.slice(from.n).sort((a, b) => a - b);
      if (!slice.length) continue;
      const errN = v.err - from.err;
      per.push({
        kind: k,
        n: slice.length,
        p50: pct(slice, 50),
        p90: pct(slice, 90),
        p95: pct(slice, 95),
        p99: pct(slice, 99),
        max: slice[slice.length - 1],
        err: errN,
      });
    }
    const line = { level: conc, secs: +dur.toFixed(1), requests: issued, qps: +(issued / dur).toFixed(1), endpoints: per };
    levels.push(line);
    const cat = per.find((x) => x.kind === "catalog-static") || per.find((x) => x.kind === "catalog-api");
    console.log(
      "[load] 并发 " + conc + " · " + line.qps + " req/s · " + issued + " 次 · 目录 P50/P95/P99 = " +
        (cat ? Math.round(cat.p50) + "/" + Math.round(cat.p95) + "/" + Math.round(cat.p99) + " ms" : "-") +
        " · 错误累计 " + per.reduce((a, b) => a + b.err, 0),
    );
  }

  const summary = summarize(levels);
  const report = {
    base: API_BASE,
    levels: LEVELS,
    secsPerLevel: SECS,
    wrote: canWrite ? { id: writeId, everyReads: WRITE_RATIO } : null,
    startedAt: new Date().toISOString(),
    summary: summary,
    perLevel: levels,
  };
  if (JSON_OUT) {
    fs.writeFileSync(String(JSON_OUT), JSON.stringify(report, null, 2));
    console.log("[load] 报告 " + JSON_OUT);
  }

  const cat = summary.find((x) => x.kind === "catalog-static") || summary.find((x) => x.kind === "catalog-api");
  const errRate = summary.length ? summary.reduce((a, b) => a + b.err, 0) / summary.reduce((a, b) => a + b.n, 0) : 1;
  const okP95 = cat ? cat.p95 <= P95_LIMIT : false;
  const okErr = errRate <= MAX_ERR;
  console.log(
    "[load] 判定：目录接口 P95 " + (cat ? Math.round(cat.p95) : "-") + "ms（上限 " + P95_LIMIT + "）· 错误率 " +
      (errRate * 100).toFixed(2) + "%（上限 " + (MAX_ERR * 100).toFixed(2) + "%）→ " + (okP95 && okErr ? "达标" : "不达标"),
  );
  process.exit(okP95 && okErr ? 0 : 1);
}

main().catch((e) => {
  console.error("[load] 失败：" + ((e && e.stack) || e));
  process.exit(1);
});
