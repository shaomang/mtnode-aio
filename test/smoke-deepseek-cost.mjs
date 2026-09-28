/* DeepSeek 费用 / 余额模块（renderer/app-cost.js）冒烟测试
 * 用 vm 加载 app-cost.js，桩 window.api.apiDeepseekBalance / dshProvider / S，验证：
 *   1) 官方路由判定（id / 名称 / baseUrl）
 *   2) 余额返回解析：官方 {is_available, balance_infos:[...]} 与 {ok, data:{...}} 两种包装
 *   3) 60s TTL 缓存：TTL 内复用、过期后重新请求、force=true 跳过缓存
 *   4) 失败退避：失败后短时间内不重复请求，退避到期再试
 *   5) 非官方路由 / 无 key / 无桥 → 不请求、返回 null
 *   6) 主进程 IPC 契约：camelCase 归一形状可解析，main.js 回官方 snake_case
 * 运行：node test/smoke-deepseek-cost.mjs
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(path.join(ROOT, "renderer", "app-cost.js"), "utf8");

const DEFAULT_RES = {
  ok: true,
  is_available: true,
  balance_infos: [
    {
      currency: "CNY",
      total_balance: "110.00",
      granted_balance: "10.00",
      topped_up_balance: "100.00",
    },
  ],
};

/* 每个场景一个独立 vm 上下文（模块级缓存 _dsBal 不跨场景串味）。
 * opts.host  : dshProvider() 返回值（缺省 = 官方 + 有 key；传 null = 无路由）
 * opts.res   : 桩接口的 resolve 值
 * opts.api   : (calls) => window.api 的自定义实现
 * 返回 { ctx, calls, tick }：calls 记录每次请求参数，tick 推进假时钟（毫秒） */
function makeCtx(opts = {}) {
  const calls = [];
  let now = 1_700_000_000_000;
  const RealDate = Date;
  const FakeDate = new Proxy(RealDate, {
    get(target, key) {
      if (key === "now") return () => now;
      return Reflect.get(target, key);
    },
  });
  const host =
    opts.host === undefined
      ? { id: "deepseek-official", baseUrl: "https://api.deepseek.com", apiKey: "sk-test" }
      : opts.host;
  const api =
    opts.api !== undefined
      ? opts.api(calls)
      : {
          apiDeepseekBalance: (p) => {
            calls.push(p);
            return Promise.resolve(opts.res || DEFAULT_RES);
          },
        };
  const ctx = {
    console,
    Math,
    Number,
    Object,
    Array,
    String,
    JSON,
    Promise,
    Error,
    Date: FakeDate,
    S: opts.S || {},
    I18n: { t: (x) => String(x) },
    window: { api },
    document: undefined, /* 本文件只测取数，不测 DOM */
    dshProvider: () => host,
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: "app-cost.js" });
  return { ctx, calls, tick: (ms) => { now += ms; } };
}

let fails = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ok   " : "  FAIL ") + msg);
  if (!cond) fails++;
};
const near = (a, b, msg) => ok(Math.abs((a || 0) - (b || 0)) < 1e-9, msg + " (" + a + " vs " + b + ")");

/* ── 1. 官方路由判定 ─────────────────────────────────────── */
const g = makeCtx();
ok(g.ctx.costIsDeepseekOfficial("deepseek"), "'deepseek' 判为官方路由");
ok(g.ctx.costIsDeepseekOfficial("deepseek-official"), "'deepseek-official' 判为官方路由");
ok(!g.ctx.costIsDeepseekOfficial("mtnode_openrouter"), "其它路由不判官方");
ok(
  g.ctx.costIsDeepseekOfficial({ baseUrl: "https://api.deepseek.com/v1" }),
  "baseUrl 含 deepseek 判为官方",
);
ok(!g.ctx.costIsDeepseekOfficial(null), "null 不判官方");

/* ── 2. 官方返回解析 + TTL 缓存 ──────────────────────────── */
const a = makeCtx();
let r = await a.ctx.balanceGet(false);
ok(!!r, "官方返回能取到余额");
near(r.main.total, 110, "解析 total_balance");
near(r.main.granted, 10, "解析 granted_balance");
near(r.main.toppedUp, 100, "解析 topped_up_balance");
ok(r.main.currency === "CNY", "币种归一为大写 CNY");
ok(r.available === true, "解析 is_available");
ok(a.calls.length === 1, "首次查询发起 1 次请求");
ok(
  a.calls[0] && a.calls[0].apiKey === "sk-test" && /api\.deepseek\.com/.test(a.calls[0].baseUrl || ""),
  "请求带上 baseUrl + apiKey",
);

r = await a.ctx.balanceGet(false);
ok(a.calls.length === 1, "60s TTL 内复用缓存，不再请求");
a.tick(60001);
await a.ctx.balanceGet(false);
ok(a.calls.length === 2, "超过 60s TTL 后重新请求");
await a.ctx.balanceGet(true);
ok(a.calls.length === 3, "force=true 跳过缓存强制刷新");

/* ── 3. {ok, data:{...}} 包装兼容 ─────────────────────────── */
const b = makeCtx({
  res: {
    ok: true,
    data: { is_available: true, balance_infos: [{ currency: "USD", total_balance: 5.5 }] },
  },
});
const rb = await b.ctx.balanceGet(false);
ok(!!rb && rb.main.total === 5.5 && rb.main.currency === "USD", "兼容 {ok,data} 包装");

/* ── 4. 失败退避 ─────────────────────────────────────────── */
const c = makeCtx({
  api: (calls) => ({
    apiDeepseekBalance: (p) => {
      calls.push(p);
      return Promise.reject(new Error("boom"));
    },
  }),
});
ok((await c.ctx.balanceGet(false)) === null, "请求失败返回 null");
ok(c.calls.length === 1, "失败也算发起过 1 次请求");
await c.ctx.balanceGet(false);
ok(c.calls.length === 1, "失败后退避窗口内不重复请求");
c.tick(6000);
await c.ctx.balanceGet(false);
ok(c.calls.length === 2, "退避（5s 基数）到期后重试");

/* ── 5. 不满足条件的路由：不请求、返回 null ──────────────── */
const d = makeCtx({
  host: { id: "mtnode_openrouter", baseUrl: "https://api.openai.com/v1", apiKey: "sk-x" },
});
ok((await d.ctx.balanceGet(false)) === null, "非官方路由不取余额");
ok(d.calls.length === 0, "非官方路由不发请求");
ok(d.ctx.balanceChip() === null, "非官方路由 balanceChip 返回 null");

const e = makeCtx({
  host: { id: "deepseek-official", baseUrl: "https://api.deepseek.com", apiKey: "" },
});
ok((await e.ctx.balanceGet(false)) === null && e.calls.length === 0, "无 API Key 不取余额");

const f = makeCtx({ host: null });
ok((await f.ctx.balanceGet(false)) === null && f.calls.length === 0, "无路由不取余额");

const h = makeCtx({ api: () => null });
ok((await h.ctx.balanceGet(false)) === null, "无 apiDeepseekBalance 桥 → null");

/* ── 6. 主进程 IPC 契约（api:deepseekBalance）───────────────
 * 主进程曾回自造 camelCase 形状 { ok, isAvailable, balances:[{totalBalance,…}] }，
 * 渲染层只认 balance_infos → 每次判「余额返回为空」，界面永远「查询失败」。
 * 两侧都钉住：渲染层能解析 camelCase；main.js 回的是官方 snake_case。 */
const m = makeCtx({
  res: {
    ok: true,
    isAvailable: true,
    balances: [
      {
        currency: "CNY",
        totalBalance: "1772.59",
        grantedBalance: "0.00",
        toppedUpBalance: "1772.59",
      },
    ],
  },
});
const rm = await m.ctx.balanceGet(false);
ok(!!rm && rm.main.total === 1772.59, "兼容主进程归一形状 balances / totalBalance");
ok(!!rm && rm.available === true, "兼容主进程 isAvailable 字段");

const MAIN_SRC = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");
const balanceHandler = MAIN_SRC.slice(MAIN_SRC.indexOf("async function fetchDeepseekBalance"));
const handlerBody = balanceHandler.slice(0, balanceHandler.indexOf("\nipcMain.handle"));
ok(/balance_infos: infos/.test(handlerBody), "主进程回官方 balance_infos 字段");
ok(!/isAvailable\s*:/.test(handlerBody), "主进程不再自造 camelCase isAvailable");

console.log(fails ? "\n✗ " + fails + " 项失败" : "\n✓ 全部通过");
process.exit(fails ? 1 : 0);
