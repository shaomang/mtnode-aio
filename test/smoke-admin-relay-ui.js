"use strict";
/* 管理台「中转服务 → 调用流水」页回归 —— 零依赖，`node test/smoke-admin-relay-ui.js`
 *
 * 为什么单独一只：`store-saas/admin/admin.js` 是**真实运行的浏览器脚本**（零依赖、无框架、
 * 靠 getElementById 直取元素），静态断言只能证明「字符串写对了」，证明不了「点了不炸」。
 * 这里用最小假 DOM + 假 fetch 把它**真跑一遍**，钉住本轮把中转服务页拆开后的四件事：
 *   [1] 页内二级页签：默认停在「调用流水」，配置 / 会话测试 / 改动留痕各自独立成页（不再堆一页）
 *   [2] 三档概览卡片：今日 / 近 7 天 / 近 30 天，实扣为主数字、欠费与未计费单列
 *   [3] 点卡片 = 收窄明细：窗口跟着切，且都打同一个只读聚合接口
 *   [4] 筛选接线：时间窗口 / 类型 / 模型 / 账号 → 查询串；重置回默认；明细列齐 + 未计费标记
 * 另钉住：admin.js 引用的每个元素 id 在 index.html 里存在（写错一个字母整块面板就 null 崩）。
 *
 * 夹具不追求算术自洽（明细 3 条、命中 1500 条）：这只钉**渲染与请求接线**，
 * 统计真算术由 `test/smoke-relay.js` 的接口回归（/api/admin/relay/usage）钉。
 *
 * 不联外网、不启服务、不写任何文件：fetch 是桩，数据是夹具。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
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
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

/* ---------- 假 DOM ---------- */

function mkEl(tag) {
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    className: "",
    value: "",
    dataset: {},
    style: {},
    colSpan: 1,
    disabled: false,
    children: [],
    handlers: {},
    /* classList 与 className 双向同步（真 DOM 就是这样）：admin.js 两种写法都有，
       只做一份映射的话「点了页签到底显示哪一页」这类断言会假失败。 */
    classList: {
      _list() { return String(el.className || "").split(/\s+/).filter(Boolean); },
      _set(l) { el.className = l.join(" "); },
      add(c) { const l = this._list(); if (!l.includes(c)) l.push(c); this._set(l); },
      remove(c) { this._set(this._list().filter((x) => x !== c)); },
      toggle(c, on) { if (on) this.add(c); else this.remove(c); },
      contains(c) { return this._list().includes(c); },
    },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
    remove() {},
    addEventListener(t, fn) { (this.handlers[t] = this.handlers[t] || []).push(fn); },
    focus() {},
    setAttribute() {},
    getAttribute() { return ""; },
    /** 递归取纯文本（renderTable 用 appendChild 拼树，断言要按文本比对）。 */
    text() {
      return String(this.textContent || "") + this.children.map((c) => (c.text ? c.text() : "")).join(" ");
    },
  };
  /* textContent 写入即清空子节点（真 DOM 的行为）：paint 系列都靠它「先清后填」。 */
  let text = "";
  Object.defineProperty(el, "textContent", {
    get() { return text; },
    set(v) { text = v == null ? "" : String(v); el.children.length = 0; },
    enumerable: true,
  });
  return el;
}
function fire(el, type, ev) {
  for (const fn of el.handlers[type] || []) fn(ev || {});
}

const html = read("store-saas/admin/index.html");
const js = read("store-saas/admin/admin.js");
const css = read("store-saas/admin/admin.css");
const relaySrc = read("store-saas/relay.mjs");
const serverSrc = read("store-saas/server.mjs");
const htmlIds = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
const tabs = [...html.matchAll(/data-view="([a-z]+)"/g)].map((m) => m[1]);
const viewIds = [...html.matchAll(/id="view-([a-z]+)"/g)].map((m) => m[1]);
const subTabs = [...html.matchAll(/data-sub="([a-z]+)"/g)].map((m) => m[1]);
const subViewIds = [...html.matchAll(/id="sub-([a-z]+)"/g)].map((m) => m[1]);

const byId = new Map(htmlIds.map((id) => {
  const e = mkEl("div");
  e.id = id; // 真 DOM 的 id：switchView / showRelaySub 都按 id 判「该显示哪一页」
  return [id, e];
}));
const tabEls = tabs.map((v) => {
  const e = mkEl("button");
  e.dataset.view = v;
  return e;
});
const subTabEls = subTabs.map((v) => {
  const e = mkEl("button");
  e.dataset.sub = v;
  return e;
});
const subViewEls = subViewIds.map((v) => byId.get("sub-" + v));
const created = [];
const document = {
  getElementById: (id) => byId.get(id) || null,
  createElement: (t) => {
    const e = mkEl(t);
    created.push(e);
    return e;
  },
  querySelectorAll: (sel) => {
    if (sel === "#tabs .tab") return tabEls;
    if (sel === ".view") return viewIds.map((v) => byId.get("view-" + v)).filter(Boolean);
    if (sel === "#relaySubtabs .subtab") return subTabEls;
    if (sel === ".subview") return subViewEls;
    return [];
  },
  addEventListener() {},
  body: mkEl("body"),
};

/* ---------- 假 fetch（记录每次请求，按路径回夹具） ---------- */

const calls = [];
const RELAY_FIXTURE = {
  ok: true,
  config: {
    source: "db",
    upstreams: [
      { id: "deepseek", name: "DeepSeek", kind: "text", base: "https://api.deepseek.com", keyFrom: "env", keyTail: "seek", timeoutMs: 300000, enabled: true, models: ["deepseek-chat"] },
    ],
    models: [
      { id: "deepseek-flash", upstream: "text", upstreamId: "deepseek", upstreamModel: "deepseek-chat", enabled: true,
        price: { kind: "text", cacheHit: 0.02, cacheMiss: 1, output: 4, peakMultiplier: 2 } },
      { id: "gpt-image-2.5-vip", upstream: "image", upstreamId: "image", upstreamModel: "gpt-image-2.5-vip", enabled: true,
        price: { kind: "image", perImageYuan: 0.21 } },
    ],
    quota: {},
  },
  audit: [{ at: Date.UTC(2026, 5, 10, 4, 0, 0), userId: "u_admin", username: "adminseed", action: "save", changes: ["新增上游 deepseek", "上架模型 deepseek-flash"] }],
};
const USAGE_FIXTURE = {
  ok: true,
  window: "7d",
  from: 0,
  to: 0,
  limit: 1000,
  matched: 1500,
  scope: { calls: 1500, textCalls: 1200, imageCalls: 300, promptTokens: 1234567, outputTokens: 456789, images: 300, unbilled: 12, chargedYuan: 321.4567, costYuan: 322, shortfallYuan: 0.5433, avgMs: 812 },
  windows: [
    { key: "today", label: "今日", from: 0, calls: 42, textCalls: 40, imageCalls: 2, promptTokens: 12345, outputTokens: 6789, images: 2, unbilled: 1, chargedYuan: 5.6789, costYuan: 5.7, shortfallYuan: 0.0211, avgMs: 500 },
    { key: "7d", label: "近 7 天", from: 0, calls: 1500, textCalls: 1200, imageCalls: 300, promptTokens: 1234567, outputTokens: 456789, images: 300, unbilled: 12, chargedYuan: 321.4567, costYuan: 322, shortfallYuan: 0.5433, avgMs: 812 },
    { key: "30d", label: "近 30 天", from: 0, calls: 9000, textCalls: 8500, imageCalls: 500, promptTokens: 9000000, outputTokens: 3000000, images: 500, unbilled: 40, chargedYuan: 1234.5678, costYuan: 1235, shortfallYuan: 0.4322, avgMs: 900 },
  ],
  models: ["deepseek-flash", "gpt-image-2.5-vip"],
  items: [
    { id: "ru_3", at: Date.UTC(2026, 5, 10, 4, 0, 0), userId: "u_a", username: "alice", model: "gpt-image-2.5-vip", kind: "image", images: 2, promptTokens: 0, outputTokens: 0, costYuan: 0.42, chargedYuan: 0.42, shortfallYuan: 0, ms: 3200 },
    { id: "ru_2", at: Date.UTC(2026, 5, 10, 3, 0, 0), userId: "u_b", username: "bob", model: "deepseek-flash", kind: "text", images: 0, promptTokens: 1000, outputTokens: 500, costYuan: 0.003, chargedYuan: 0, shortfallYuan: 0.003, ms: 800 },
    { id: "ru_1", at: Date.UTC(2026, 5, 10, 2, 0, 0), userId: "u_a", username: "alice", model: "deepseek-flash", kind: "text", images: 0, promptTokens: 500, outputTokens: 200, costYuan: 0.0012, chargedYuan: 0.0012, shortfallYuan: 0, ms: 420 },
  ],
};
const fetchStub = async (url, opt) => {
  const u = String(url);
  const o = opt || {};
  calls.push({ url: u, method: o.method || "GET", body: o.body ? JSON.parse(o.body) : null });
  const json = (obj, status) => ({
    ok: (status || 200) < 400,
    status: status || 200,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
    blob: async () => ({}),
  });
  if (u.includes("/api/admin/overview")) {
    return json({ ok: true, admin: { id: "u_admin", username: "adminseed", nickname: "管理员" }, sessionExpiresAt: Date.now() + 3600e3, stats: {}, alipay: {}, wechat: {}, config: {} });
  }
  if (u.includes("/api/admin/orders")) return json({ ok: true, items: [], total: 0, page: 1, pageSize: 50 });
  if (u.includes("/api/admin/relay/usage")) return json(Object.assign({}, USAGE_FIXTURE, { window: /window=([a-z0-9]+)/.exec(u) ? RegExp.$1 : "" }));
  if (u.includes("/api/admin/relay")) return json(RELAY_FIXTURE);
  return json({ ok: false, code: "ADMIN_UNAUTHORIZED", error: "未登录" }, 401);
};

const sandbox = {
  document,
  window: {},
  location: { pathname: "/admin/", search: "", href: "http://127.0.0.1/admin/" },
  localStorage: { getItem: () => "adm_test_token", setItem: () => {}, removeItem: () => {} },
  URLSearchParams,
  URL: { createObjectURL: () => "blob:x", revokeObjectURL: () => {} },
  setTimeout,
  clearTimeout,
  fetch: fetchStub,
  console,
};
sandbox.globalThis = sandbox;

const usageCalls = () => calls.filter((c) => c.url.includes("/api/admin/relay/usage"));
const lastUsageCall = () => usageCalls().slice(-1)[0];
const findCard = (label) => (byId.get("rlStatCards").children || []).find((c) => c.text().includes(label));

(async () => {
  console.log("[1] admin.js 真跑（假 DOM + 假 fetch）");
  ok(subTabs.join(",") === "usage,config,test,audit" && subViewIds.join(",") === "usage,config,test,audit",
    "index.html 有四个页内二级页签与对应视图（调用流水 / 配置 / 会话测试 / 改动留痕）：" + subTabs.join(" / "));
  ok(/<nav class="subtabs" id="relaySubtabs">/.test(html) && /class="subtab active" data-sub="usage"/.test(html),
    "默认落在「调用流水」页签上（active 写在 usage 上）");
  ok(/\.subtabs/.test(css) && /\.card-click\.on/.test(css), "admin.css 有二级页签与可选卡片样式");
  ok(relaySrc.includes("usageQuery") && /USAGE_QUERY_MAX = 1000/.test(relaySrc) && /usageQuery: usageQuery/.test(relaySrc),
    "relay.mjs 有只读聚合入口 usageQuery（上限 1000）");
  ok(serverSrc.includes('"/api/admin/relay/usage"'), "server.mjs 接了 GET /api/admin/relay/usage（只读）");
  ok(js.includes('"/api/admin/relay/usage?"'), "admin.js 打的是那个只读聚合接口（不是把明细搬回前端算）");

  const refIds = [...new Set([...js.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]))];
  const missing = refIds.filter((id) => !htmlIds.includes(id));
  ok(missing.length === 0, "admin.js 引用的 " + refIds.length + " 个元素 id 在 index.html 里都存在" +
    (missing.length ? "（缺失：" + missing.join(", ") + "）" : ""));

  let bootErr = null;
  try {
    vm.createContext(sandbox);
    vm.runInContext(js, sandbox, { filename: "admin.js", timeout: 5000 });
  } catch (e) {
    bootErr = e;
  }
  ok(!bootErr, "admin.js 求值不抛异常（有语法 / 启动错误时整个管理台都点不动）" + (bootErr ? "：" + bootErr.message : ""));
  if (bootErr) {
    console.log("\nFAILED " + fails + " / " + checks);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 30));

  console.log("[2] 点顶栏「中转服务」→ 默认停在「调用流水」，两个接口都拉");
  fire(tabEls.find((t) => t.dataset.view === "relay"), "click");
  await new Promise((r) => setTimeout(r, 60));
  const cfgCall = calls.filter((c) => /\/api\/admin\/relay\?/.test(c.url)).pop();
  ok(!!cfgCall && /audit=100/.test(cfgCall.url), "拉配置 + 留痕：GET /api/admin/relay?audit=100");
  ok(!!lastUsageCall() && /window=7d/.test(lastUsageCall().url) && /limit=1000/.test(lastUsageCall().url),
    "调用流水默认查近 7 天、上限 1000 条：" + (lastUsageCall() ? lastUsageCall().url : "没有请求"));
  ok(subTabEls.find((b) => b.dataset.sub === "usage").classList.contains("active"), "「调用流水」子页签高亮");
  ok(!byId.get("sub-usage").classList.contains("hidden") && byId.get("sub-config").classList.contains("hidden") &&
    byId.get("sub-test").classList.contains("hidden") && byId.get("sub-audit").classList.contains("hidden"),
    "默认只显示「调用流水」，配置 / 测试 / 留痕三页收起来（不再堆在一页）");

  console.log("[3] 三档概览卡片：实扣为主数字，欠费与未计费单列");
  const cards = byId.get("rlStatCards").children || [];
  ok(cards.length === 3, "三张窗口卡片（今日 / 近 7 天 / 近 30 天），实得 " + cards.length + " 张");
  const todayTxt = (findCard("今日") || mkEl("div")).text();
  ok(/今日（全站）/.test(todayTxt) && /¥5\.6789/.test(todayTxt) && /调用 42 次 · 文本 40 \/ 图像 2（2 张）/.test(todayTxt) &&
    /tokens 入 12\.3k · 出 6\.8k/.test(todayTxt) && /未计费 1 次 · 欠费未计 ¥0\.0211/.test(todayTxt),
    "今日卡：实扣 ¥5.6789 主数字 + 次数/文本图像 + tokens + 未计费与欠费：" + JSON.stringify(todayTxt).slice(0, 200));
  ok(!/耗时|平均/.test(todayTxt), "卡片不做健康度指标（平均耗时等按要求不放进统计卡片）");
  ok((findCard("近 7 天") || mkEl("div")).classList.contains("on") && !(findCard("今日") || mkEl("div")).classList.contains("on"),
    "默认窗口（近 7 天）那张卡高亮");
  ok(/全站/.test(byId.get("rlStatHint").textContent) && /未计费/.test(byId.get("rlStatHint").textContent),
    "卡片口径写明是「全站」且解释了「未计费」");
  const metaTxt = byId.get("rlUsageMeta").text();
  ok(/命中 1,500 条/.test(metaTxt) && /显示最近 3 条/.test(metaTxt) && /上限 1,000 条/.test(metaTxt),
    "明细上方标明命中条数、显示条数与上限（1000）：" + JSON.stringify(metaTxt).slice(0, 160));
  ok(/本次筛选合计 1,500 次（文本 1,200 \/ 图像 300）/.test(metaTxt) && /实扣 ¥321\.4567/.test(metaTxt) &&
    /tokens 入 1,234,567 \/ 出 456,789/.test(metaTxt) && /未计费 12 次/.test(metaTxt) && /欠费未计 ¥0\.5433/.test(metaTxt),
    "本次筛选合计：次数 / 文本图像 / 实扣 / tokens / 未计费 / 欠费都在一行里");

  console.log("[4] 点卡片 = 把明细一起收窄到那个窗口");
  const before = usageCalls().length;
  fire(findCard("今日"), "click");
  await new Promise((r) => setTimeout(r, 40));
  ok(byId.get("fUsageWindow").value === "today", "点「今日」卡 → 时间窗口下拉切到 today");
  ok(usageCalls().length > before && /window=today/.test(lastUsageCall().url), "并立刻按新窗口重查：" + (lastUsageCall() ? lastUsageCall().url : "没有请求"));
  ok((findCard("今日") || mkEl("div")).classList.contains("on") && !(findCard("近 7 天") || mkEl("div")).classList.contains("on"),
    "高亮跟着挪到「今日」（当前窗口一眼可辨）");

  console.log("[5] 明细表：列齐 + 未计费行有标记");
  const tableTxt = byId.get("tblRelayUsage").text();
  ok(/时间/.test(tableTxt) && /账号/.test(tableTxt) && /模型/.test(tableTxt) && /类型/.test(tableTxt) &&
    /入 \/ 出 tokens/.test(tableTxt) && /应扣\(元\)/.test(tableTxt) && /实扣\(元\)/.test(tableTxt) && /耗时\(ms\)/.test(tableTxt),
    "表格列齐：时间 / 账号 / 模型 / 类型 / 入出 tokens / 应扣 / 实扣 / 耗时");
  ok(/alice/.test(tableTxt) && /gpt-image-2\.5-vip/.test(tableTxt) && /图像 ×2/.test(tableTxt) && /文本/.test(tableTxt),
    "行内容渲染出来（账号 / 模型 / 文本与图像类型）");
  ok(/0\.0000（未计费）/.test(tableTxt) && /欠 0\.0030/.test(tableTxt),
    "实扣为 0 的那次标「（未计费）」并把欠费差额单列（欠 0.0030）");

  console.log("[6] 筛选接线（类型 / 模型 / 账号 / 重置）");
  byId.get("fUsageKind").value = "image";
  let n = usageCalls().length;
  fire(byId.get("fUsageKind"), "change");
  await new Promise((r) => setTimeout(r, 40));
  ok(usageCalls().length > n && /kind=image/.test(lastUsageCall().url), "类型下拉切换即重查（kind=image）");
  byId.get("fUsageModel").value = "deepseek-flash";
  n = usageCalls().length;
  fire(byId.get("fUsageModel"), "change");
  await new Promise((r) => setTimeout(r, 40));
  ok(usageCalls().length > n && /model=deepseek-flash/.test(lastUsageCall().url), "模型下拉重查（model=deepseek-flash）");
  const modelOpts = (byId.get("fUsageModel").children || []).map((o) => o.value);
  ok(modelOpts.includes("") && modelOpts.includes("deepseek-flash") && modelOpts.includes("gpt-image-2.5-vip"),
    "模型下拉候选 = 当前上架清单 ∪ 明细里出现过的模型：" + modelOpts.join(" / "));
  byId.get("fUsageUser").value = "alice";
  n = usageCalls().length;
  fire(byId.get("btnUsageSearch"), "click");
  await new Promise((r) => setTimeout(r, 40));
  ok(usageCalls().length > n && /userId=alice/.test(lastUsageCall().url), "账号输入框 + 查询按钮（userId=alice）");
  n = usageCalls().length;
  fire(byId.get("btnUsageReset"), "click");
  await new Promise((r) => setTimeout(r, 40));
  const resetUrl = lastUsageCall().url;
  ok(usageCalls().length > n && /window=7d/.test(resetUrl) && /kind=&/.test(resetUrl) && /model=&/.test(resetUrl) && /userId=&/.test(resetUrl),
    "重置：回到默认近 7 天并清空类型 / 模型 / 账号：" + resetUrl);
  ok(byId.get("fUsageWindow").value === "7d" && byId.get("fUsageKind").value === "" && byId.get("fUsageUser").value === "",
    "重置后控件值也复位");

  console.log("[7] 子页签切换：配置 / 会话测试 / 改动留痕各自成页");
  fire(subTabEls.find((b) => b.dataset.sub === "config"), "click");
  await new Promise((r) => setTimeout(r, 10));
  ok(byId.get("sub-config").classList.contains("hidden") === false && byId.get("sub-usage").classList.contains("hidden"),
    "点「配置」→ 配置页显示、调用流水收起");
  ok(/DeepSeek/.test(byId.get("tblRelayUp").text()) && /deepseek-flash/.test(byId.get("tblRelayModels").text()),
    "配置页两张表照旧渲染（上游 + 模型）");
  fire(subTabEls.find((b) => b.dataset.sub === "audit"), "click");
  await new Promise((r) => setTimeout(r, 10));
  ok(!byId.get("sub-audit").classList.contains("hidden") && /新增上游 deepseek/.test(byId.get("tblRelayAudit").text()),
    "「改动留痕」页渲染留痕内容");
  fire(subTabEls.find((b) => b.dataset.sub === "test"), "click");
  await new Promise((r) => setTimeout(r, 10));
  ok(!byId.get("sub-test").classList.contains("hidden") &&
    (byId.get("rlTestModel").children || []).map((o) => o.value).includes("deepseek-flash"),
    "「会话测试」页在，模型下拉按上架清单填好");

  console.log("\n" + (fails ? "FAILED " + fails + " / " + checks : "ALL OK " + checks + " checks"));
  process.exit(fails ? 1 : 0);
})();
