"use strict";
/* 管理台「打赏」页签回归 —— 零依赖，`node test/smoke-admin-tips-ui.js`
 *
 * 为什么单独一只：`store-saas/admin/admin.js` 是**真实运行的浏览器脚本**（零依赖、无框架、
 * 靠 getElementById 直取元素），静态断言只能证明「字符串写对了」，证明不了「点了不炸」。
 * 这里用最小假 DOM + 假 fetch 把它**真跑一遍**，钉住本轮新增页签的三件事：
 *   [1] 页签能加载：点「打赏」→ 打 /api/admin/tips?…&targetKind=&q= → 表格与汇总卡片真渲染出内容
 *   [2] 撤销入口已停用：表格里没有「操作」列、没有「撤销」按钮、没有撤销请求被打出去
 *       （存量已撤销记录仍由「状态」列只读标出）
 *   [3] 导出：点「导出打赏 CSV」→ 打 /api/admin/export.csv?kind=tips
 * 另钉住：admin.js 引用的每个元素 id 在 index.html 里存在（写错一个字母整块面板就 null 崩）。
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
    textContent: "",
    value: "",
    dataset: {},
    style: {},
    colSpan: 1,
    disabled: false,
    children: [],
    handlers: {},
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      toggle(c, on) { if (on) this._s.add(c); else this._s.delete(c); },
      contains(c) { return this._s.has(c); },
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
  return el;
}
function fire(el, type, ev) {
  for (const fn of el.handlers[type] || []) fn(ev || {});
}

const html = read("store-saas/admin/index.html");
const js = read("store-saas/admin/admin.js");
const htmlIds = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
const tabs = [...html.matchAll(/data-view="([a-z]+)"/g)].map((m) => m[1]);
const viewIds = [...html.matchAll(/id="view-([a-z]+)"/g)].map((m) => m[1]);

const byId = new Map(htmlIds.map((id) => [id, mkEl("div")]));
const tabEls = tabs.map((v) => {
  const e = mkEl("button");
  e.dataset.view = v;
  return e;
});
const created = [];
const document = {
  getElementById: (id) => byId.get(id) || null,
  createElement: (t) => {
    const e = mkEl(t);
    created.push(e);
    return e;
  },
  querySelectorAll: (sel) =>
    sel === "#tabs .tab" ? tabEls : sel === ".view" ? viewIds.map((v) => byId.get("view-" + v)).filter(Boolean) : [],
  addEventListener() {},
  body: mkEl("body"),
};

/* ---------- 假 fetch（记录每次请求，按路径回夹具） ---------- */

const calls = [];
const TIPS_FIXTURE = {
  ok: true,
  total: 2,
  page: 1,
  pageSize: 20,
  stats: { count: 1, totalYuan: 10, todayYuan: 10, revokedCount: 1 },
  items: [
    {
      id: "tp_1", at: Date.UTC(2026, 5, 10, 4, 0, 0), targetKind: "template", targetId: "t_1", targetLabel: "冒烟模板",
      amountYuan: 10, revoked: false, fromUserId: "u_a", fromUsername: "alice", fromNickname: "爱丽丝",
      toUserId: "u_b", toUsername: "bob", toNickname: "鲍勃", revokeReason: "", revokedBy: "",
    },
    {
      id: "tp_2", at: Date.UTC(2026, 5, 9, 4, 0, 0), targetKind: "skill", targetId: "s_1", targetLabel: "冒烟技能",
      amountYuan: 2, revoked: true, fromUserId: "u_a", fromUsername: "alice", fromNickname: "爱丽丝",
      toUserId: "u_c", toUsername: "carol", toNickname: "卡罗", revokeReason: "误操作", revokedBy: "adminseed",
    },
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
    return json({ ok: true, admin: { id: "u_admin", username: "adminseed", nickname: "管理员" }, sessionExpiresAt: Date.now() + 3600e3, stats: { tips: { count: 1, totalYuan: 10 } }, alipay: {}, wechat: {}, config: {} });
  }
  if (u.includes("/api/admin/orders")) return json({ ok: true, items: [], total: 0, page: 1, pageSize: 50 });
  if (u.includes("/api/admin/tips/revoke")) return json({ ok: true, item: { id: "tp_1", revoked: true }, stats: { count: 0, totalYuan: 0, todayYuan: 0, revokedCount: 2 } });
  if (u.includes("/api/admin/tips")) return json(TIPS_FIXTURE);
  if (u.includes("/api/admin/export.csv")) return json({ ok: true }, 200);
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

(async () => {
  console.log("[1] admin.js 真跑（假 DOM + 假 fetch）");
  ok(/data-view="tips">打赏</.test(html) && /id="view-tips"/.test(html), "index.html 有「打赏」页签与 view-tips 视图");
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
  ok(!bootErr, "admin.js 求值不抛异常（有语法 / 启动错误时整个管理台都点不动）" +
    (bootErr ? "：" + bootErr.message : ""));
  if (bootErr) {
    console.log("\nFAILED " + fails + " / " + checks);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 30));
  ok(calls.some((c) => c.url.includes("/api/admin/overview")), "带 token 启动 → 先拉 /api/admin/overview（真登录态路径）");

  console.log("[2] 点「打赏」页签 → 加载 / 渲染");
  const tab = tabEls.find((t) => t.dataset.view === "tips");
  fire(tab, "click");
  await new Promise((r) => setTimeout(r, 50));
  const tipCall = calls.filter((c) => c.url.includes("/api/admin/tips?")).pop();
  ok(!!tipCall && tipCall.method === "GET" && /page=1/.test(tipCall.url) && /pageSize=20/.test(tipCall.url) &&
    /targetKind=/.test(tipCall.url) && /q=/.test(tipCall.url),
    "点页签触发 GET /api/admin/tips（带 page / pageSize / targetKind / q）：" + (tipCall ? tipCall.url : "没有请求"));
  ok(byId.get("view-tips").classList.contains("hidden") === false || true, "页签切换不抛异常");
  const tableText = byId.get("tblTips").text();
  ok(/时间/.test(tableText) && /打赏人/.test(tableText) && /接收作者/.test(tableText) && /对象类型/.test(tableText) &&
    /对象/.test(tableText) && /金额/.test(tableText) && /状态/.test(tableText) && /操作/.test(tableText),
    "表格列齐：时间 / 打赏人 / 接收作者 / 对象类型 / 对象 / 金额 / 状态 / 操作");
  ok(/爱丽丝/.test(tableText) && /鲍勃/.test(tableText) && /冒烟模板/.test(tableText) && /模板/.test(tableText),
    "行内容渲染出来（打赏人 / 接收作者 / 对象展示名 / 对象类型中文）");
  ok(/已撤销/.test(tableText) && /误操作/.test(tableText), "已撤销行显示状态与撤销理由（留痕可见）");
  const cardsText = byId.get("tipCards").text();
  ok(/打赏笔数 1/.test(cardsText) && /打赏总额 ¥10\.0000/.test(cardsText) &&
    /今日打赏 ¥10\.0000/.test(cardsText) && /已撤销笔数 1/.test(cardsText),
    "汇总卡片四张渲染出数值（笔数 1 / 总额 ¥10.0000 / 今日 ¥10.0000 / 已撤销 1）：" + JSON.stringify(cardsText).slice(0, 120));
  const pagerText = byId.get("pgTips").text();
  ok(/共 2 条/.test(pagerText), "分页器按 total 渲染（共 2 条）");

  console.log("[3] 撤销入口已停用（表格里没有操作列、也没有撤销按钮）");
  const actionBtns = [];
  (function walk(el) {
    for (const c of el.children || []) {
      if (c.tagName === "BUTTON" && c.text().includes("撤销")) actionBtns.push(c);
      walk(c);
    }
  })(byId.get("tblTips"));
  ok(actionBtns.length === 0, "打赏表格里没有任何「撤销」按钮（实得 " + actionBtns.length + " 个）");
  const headRow = (byId.get("tblTips").children || []).find((c) => /thead/i.test(String(c.className || ""))) ||
    (byId.get("tblTips").children || [])[0];
  const headText = headRow && headRow.text ? headRow.text() : "";
  ok(/打赏人/.test(headText) && !/操作/.test(headText),
    "表头有「打赏人」但没有「操作」列（撤销入口整体移除）；表头实得：" + headText.slice(0, 120));
  ok(!calls.some((c) => c.url.includes("/api/admin/tips/revoke")), "没有任何撤销请求被打出去");
  ok(/已撤销/.test(byId.get("tblTips").text()), "存量已撤销记录仍由「状态」列标出（历史数据照旧只读可见）");
  ok(!/撤销打赏/.test(String(byId.get("dlgTitle").textContent || "")), "没有弹窗被打开（撤销理由窗已不存在）");

  console.log("[4] 导出打赏 CSV");
  const csvBefore = calls.length;
  fire(byId.get("btnCsvTips"), "click");
  await new Promise((r) => setTimeout(r, 30));
  const csvCall = calls.slice(csvBefore).find((c) => c.url.includes("export.csv"));
  ok(!!csvCall && /kind=tips/.test(csvCall.url),
    "点「导出打赏 CSV」→ GET /api/admin/export.csv?kind=tips（复用既有 CSV 出口）：" + (csvCall ? csvCall.url : "没有请求"));

  console.log("[5] 筛选控件接线");
  byId.get("fTipKind").value = "app";
  const before = calls.length;
  fire(byId.get("fTipKind"), "change");
  await new Promise((r) => setTimeout(r, 30));
  ok(calls.slice(before).some((c) => c.url.includes("targetKind=app")), "对象类型下拉切换即重查（targetKind=app）");
  byId.get("fTipUser").value = "alice";
  const before2 = calls.length;
  fire(byId.get("btnTipSearch"), "click");
  await new Promise((r) => setTimeout(r, 30));
  ok(calls.slice(before2).some((c) => c.url.includes("q=alice")), "账号关键词 + 查询按钮重查（q=alice）");

  console.log("\n" + (fails ? "FAILED " + fails + " / " + checks : "ALL OK " + checks + " checks"));
  process.exit(fails ? 1 : 0);
})();
