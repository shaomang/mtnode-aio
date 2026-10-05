"use strict";
/* 管理台「系统资源监控」页回归 —— 零依赖，`node test/smoke-admin-sysinfo-ui.js`
 *
 * 需求口径（本文件要钉住的正是这几条）：
 *   · 两项新页签：系统资源监控紧跟「概览」、内容管理排最后（内容管理另有 smoke-admin-content-ui.js）；
 *   · 「仅在主动获取时显示，打开界面刷一次，不自动刷」= **切到该页签采一次 + 页内「刷新」再采一次**，
 *     绝不定时轮询（admin.js 里连一个 setInterval 都不许有）；
 *   · 指标：CPU 使用率 / 负载 / 内存 / Swap / 磁盘（数据目录所在盘）/ 本服务进程 + 主机信息；
 *   · 呈现：卡片 + 用量进度条（>= 80 黄、>= 90 红）+ 采样时间戳；Swap / 磁盘取不到要明说「本机不支持」；
 *   · 纯只读：这一页不许出现任何写请求（没有重启 / 清理 / 导出按钮）。
 *
 * 手法与 smoke-admin-relay-ui.js 同一套：最小假 DOM + 假 fetch 把 admin.js **真跑一遍**
 * （静态断言只能证明字符串写对了，证明不了「点了不炸」）。不联外网、不启服务、不写文件。
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
    files: [],
    type: "",
    colSpan: 1,
    disabled: false,
    children: [],
    handlers: {},
    classList: {
      _list() { return String(el.className || "").split(/\s+/).filter(Boolean); },
      _set(l) { el.className = l.join(" "); },
      add(c) { const l = this._list(); if (!l.includes(c)) l.push(c); this._set(l); },
      remove(c) { this._set(this._list().filter((x) => x !== c)); },
      toggle(c, on) { if (on === undefined ? !this.contains(c) : on) this.add(c); else this.remove(c); },
      contains(c) { return this._list().includes(c); },
    },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
    remove() {},
    addEventListener(t, fn) { (this.handlers[t] = this.handlers[t] || []).push(fn); },
    focus() {},
    click() {},
    setAttribute() {},
    getAttribute() { return ""; },
    text() {
      return String(this.textContent || "") + this.children.map((c) => (c.text ? c.text() : "")).join(" ");
    },
  };
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
const serverSrc = read("store-saas/server.mjs");
const tabs = [...html.matchAll(/data-view="([a-z]+)"/g)].map((m) => m[1]);
const viewIds = [...html.matchAll(/id="view-([a-z]+)"/g)].map((m) => m[1]);
const htmlIds = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);

const byId = new Map(htmlIds.map((id) => {
  const e = mkEl("div");
  e.id = id;
  return [id, e];
}));
const tabEls = tabs.map((v) => {
  const e = mkEl("button");
  e.dataset.view = v;
  return e;
});
const document = {
  getElementById: (id) => byId.get(id) || null,
  createElement: (t) => mkEl(t),
  querySelectorAll: (sel) => {
    if (sel === "#tabs .tab") return tabEls;
    if (sel === ".view") return viewIds.map((v) => byId.get("view-" + v)).filter(Boolean);
    if (sel === "#relaySubtabs .subtab") return [...html.matchAll(/data-sub="([a-z]+)"/g)].map((m) => {
      const e = mkEl("button");
      e.dataset.sub = m[1];
      return e;
    });
    if (sel === ".subview") return [...html.matchAll(/id="sub-([a-z]+)"/g)].map((m) => byId.get("sub-" + m[1])).filter(Boolean);
    if (sel === "#contentSubtabs .subtab") return [...html.matchAll(/data-csub="([a-z]+)"/g)].map((m) => {
      const e = mkEl("button");
      e.dataset.csub = m[1];
      return e;
    });
    if (sel === ".csubview") return [...html.matchAll(/id="cview-([a-z]+)"/g)].map((m) => byId.get("cview-" + m[1])).filter(Boolean);
    return [];
  },
  addEventListener() {},
  body: mkEl("body"),
};

/* ---------- 假 fetch：夹具带「完整」与「本机不支持」两套 ---------- */

const calls = [];
const FULL = {
  ok: true,
  at: 1730000000000,
  sampleMs: 201,
  cpu: { usagePct: 12.5, cores: 8, model: "AMD EPYC 7B13", load: [0.5, 0.7, 0.9] },
  mem: { totalBytes: 16 * 1024 ** 3, usedBytes: 9 * 1024 ** 3, freeBytes: 7 * 1024 ** 3, usedPct: 56.2 },
  swap: { supported: true, totalBytes: 4 * 1024 ** 3, usedBytes: 3.7 * 1024 ** 3, freeBytes: 0.3 * 1024 ** 3, usedPct: 92.5 },
  disk: { supported: true, path: "/opt/mtnode-store/data", totalBytes: 100 * 1024 ** 3, usedBytes: 85 * 1024 ** 3, freeBytes: 15 * 1024 ** 3, usedPct: 85 },
  proc: { pid: 4242, rssBytes: 180 * 1024 ** 2, heapUsedBytes: 90 * 1024 ** 2, cpuTimeMs: 65430, uptimeSec: 93784, startedAt: 1730000000000 - 93784 * 1000, node: "v22.19.0" },
  host: { hostname: "store-01", platform: "linux", arch: "x64", release: "5.15.0-105-generic", uptimeSec: 1234567 },
};
const MINIMAL = Object.assign({}, FULL, {
  swap: { supported: false, totalBytes: 0, usedBytes: 0, freeBytes: 0, usedPct: 0 },
  disk: { supported: false, path: "/opt/mtnode-store/data", totalBytes: 0, usedBytes: 0, freeBytes: 0, usedPct: 0 },
});
let mode = "full";

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
    return json({ ok: true, admin: { id: "u_admin", username: "ms2308", nickname: "管理员" }, sessionExpiresAt: Date.now() + 3600e3, stats: {}, alipay: {}, wechat: {}, config: {} });
  }
  if (u.includes("/api/admin/sysinfo")) return json(mode === "full" ? FULL : MINIMAL);
  if (u.includes("/api/admin/orders")) return json({ ok: true, items: [], total: 0, page: 1, pageSize: 50 });
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

const siCalls = () => calls.filter((c) => c.url.includes("/api/admin/sysinfo"));
const anyWrite = () => calls.filter((c) => c.method !== "GET");
const cardByLabel = (label) => (byId.get("siCards").children || []).find((c) => c.text().includes(label));
const meterOf = (label) => {
  const card = cardByLabel(label);
  if (!card) return null;
  return (card.children || []).find((c) => String(c.className || "").startsWith("meter")) || null;
};

(async () => {
  console.log("[1] 页签结构：系统资源监控紧跟概览；整页只读");
  ok(tabs[0] === "overview" && tabs[1] === "sysinfo",
    "「系统资源监控」紧跟「概览」（态势查看挨着放）：" + tabs.slice(0, 3).join(" · "));
  ok(tabs[tabs.length - 1] === "content", "「内容管理」排最后（运营操作）");
  ok(viewIds.includes("sysinfo") && /id="view-sysinfo"/.test(html), "有 #view-sysinfo 视图");
  ["siMeta", "siCards", "siProc", "siHost", "btnSiRefresh"].forEach((id) => {
    ok(htmlIds.includes(id), "index.html 有 #" + id);
  });
  ok(/\.meter\b/.test(css) && /\.meter\.warn i/.test(css) && /\.meter\.bad i/.test(css),
    "admin.css 有进度条与两级阈值样式（>80 黄 / >90 红）");
  ok(!/setInterval\s*\(/.test(js), "admin.js 里没有任何 setInterval（不自动刷）");
  ok(serverSrc.includes('p === "/api/admin/sysinfo"') && /function sysinfoSnapshot/.test(serverSrc),
    "服务端有只读采样口 GET /api/admin/sysinfo（sysinfoSnapshot）");
  const siBlock = serverSrc.slice(serverSrc.indexOf("管理台 · 系统资源监控"), serverSrc.indexOf("管理台 · 内容管理"));
  ok(!/setInterval/.test(siBlock) && !/fs\.writeFileSync/.test(siBlock),
    "采样实现里没有定时器、也不写任何文件（纯只读）");
  ok(/readFileSync\("\/proc\/meminfo"/.test(siBlock) && /statfsSync/.test(siBlock),
    "Swap 读 /proc/meminfo、磁盘走 statfsSync（数据目录所在盘）");
  const siSection = html.split('id="view-sysinfo"')[1].split("</section>")[0];
  const siButtons = [...siSection.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1].trim());
  ok(siButtons.length === 1 && siButtons[0] === "刷新",
    "监控页只有「刷新」一个按钮（没有重启 / 清理 / 导出这类运维动作）：" + JSON.stringify(siButtons));
  ok(/只读页/.test(siSection) && /不提供重启 \/ 清理类操作/.test(siSection), "页内明写「只读 + 不提供运维操作」");

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
  ok(!bootErr, "admin.js 求值不抛异常" + (bootErr ? "：" + bootErr.message : ""));
  if (bootErr) {
    console.log("\nFAILED " + fails + " / " + checks);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 30));
  ok(siCalls().length === 0, "开机不预热监控（登录进管理台时一次都不采）：" + siCalls().length + " 次");

  console.log("[2] 点顶栏「系统资源监控」→ 采一次并渲染卡片 + 进度条");
  fire(tabEls.find((t) => t.dataset.view === "sysinfo"), "click");
  await new Promise((r) => setTimeout(r, 60));
  ok(siCalls().length === 1 && siCalls()[0].method === "GET", "切到该页签只采一次（GET /api/admin/sysinfo）：" + siCalls().length + " 次");
  ok(!byId.get("view-sysinfo").classList.contains("hidden") && byId.get("view-overview").classList.contains("hidden"),
    "监控视图显示、概览收起");
  const cards = byId.get("siCards").children || [];
  ok(cards.length === 6, "六张指标卡（CPU / 负载 / 内存 / Swap / 磁盘 / 本服务 RSS），实得 " + cards.length + " 张");
  const cpuTxt = (cardByLabel("CPU 使用率") || mkEl("div")).text();
  ok(/12\.5 %/.test(cpuTxt) && /8 核/.test(cpuTxt) && /AMD EPYC 7B13/.test(cpuTxt), "CPU 卡：使用率 + 核数 + 型号：" + JSON.stringify(cpuTxt));
  const loadTxt = (cardByLabel("负载（1 / 5 / 15 分钟）") || mkEl("div")).text();
  ok(/0\.50 \/ 0\.70 \/ 0\.90/.test(loadTxt) && /折合每核 1 分钟 0\.06/.test(loadTxt), "负载卡：三档负载 + 折合每核：" + JSON.stringify(loadTxt));
  const memTxt = (cardByLabel("内存") || mkEl("div")).text();
  ok(/9\.00 GB \/ 16\.00 GB/.test(memTxt) && /用量 56\.2%/.test(memTxt) && /可用 7\.00 GB/.test(memTxt), "内存卡：已用 / 总量 + 用量百分比：" + JSON.stringify(memTxt));
  const diskTxt = (cardByLabel("磁盘（数据目录所在盘）") || mkEl("div")).text();
  ok(/85\.00 GB \/ 100\.00 GB/.test(diskTxt) && /usage|用量 85\.0%/.test(diskTxt) && /\/opt\/mtnode-store\/data/.test(diskTxt),
    "磁盘卡：数据目录所在盘的已用 / 总量 + 路径：" + JSON.stringify(diskTxt));
  ok(/本服务内存（RSS）/.test(byId.get("siCards").text()) && /180\.0 MB/.test(byId.get("siCards").text()), "还有本服务 RSS 卡（180.0 MB）");

  console.log("[3] 进度条阈值配色：常态 / 黄（>=80）/ 红（>=90）");
  ok(!/warn|bad/.test(String((meterOf("内存") || mkEl("div")).className)) && !!meterOf("内存"), "内存 56.2% → 常态色");
  ok(/warn/.test(String((meterOf("磁盘（数据目录所在盘）") || mkEl("div")).className)), "磁盘 85% → 黄（warn）");
  ok(/bad/.test(String((meterOf("Swap") || mkEl("div")).className)), "Swap 92.5% → 红（bad）");
  const fill = (meterOf("内存") || mkEl("div")).children[0];
  ok(fill && fill.style.width === "56.2%", "进度条宽度 = 用量百分比（56.2%）：" + JSON.stringify(fill && fill.style.width));

  console.log("[4] 采样时间戳与口径说明");
  const meta = byId.get("siMeta").textContent;
  ok(/采样时间 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(meta) && /本次采样耗时 201ms/.test(meta),
    "写明采样时间（服务端 at）与本次采样耗时：" + JSON.stringify(meta.slice(0, 80)));
  ok(/点「刷新」再采一次/.test(meta) && /不留历史/.test(meta) && /不定时轮询/.test(meta),
    "并写明「切页签一次 + 刷新一次，不留历史、不定时轮询」");

  console.log("[5] 进程与主机信息面板");
  const proc = byId.get("siProc").text();
  ok(/进程 PID/.test(proc) && /4242/.test(proc) && /Node 版本/.test(proc) && /v22\.19\.0/.test(proc) &&
    /运行时长/.test(proc) && /1 天 2 小时/.test(proc) && /累计 CPU 时间/.test(proc) && /65 秒/.test(proc),
    "进程面板：PID / Node 版本 / 运行时长 / 启动时间 / 累计 CPU 时间 / RSS：");
  const host = byId.get("siHost").text();
  ok(/store-01/.test(host) && /linux 5\.15\.0-105-generic · x64/.test(host) && /14 天 6 小时/.test(host),
    "主机面板：主机名 / 系统 / 开机时长 / CPU / 数据目录");

  console.log("[6] 不自动刷：等一段没有任何新请求；点「刷新」才再采一次");
  const n1 = siCalls().length;
  await new Promise((r) => setTimeout(r, 400));
  ok(siCalls().length === n1, "静置 400ms 没有任何自动请求（" + n1 + " → " + siCalls().length + "）");
  fire(byId.get("btnSiRefresh"), "click");
  await new Promise((r) => setTimeout(r, 60));
  ok(siCalls().length === n1 + 1, "点「刷新」→ 恰好再采一次（" + (n1 + 1) + " 次）");
  const n2 = siCalls().length;
  await new Promise((r) => setTimeout(r, 250));
  ok(siCalls().length === n2, "刷新之后也不会转成轮询（" + n2 + " 次不变）");

  console.log("[7] 本机不支持时的降级：明说不假装有数");
  mode = "minimal";
  fire(byId.get("btnSiRefresh"), "click");
  await new Promise((r) => setTimeout(r, 60));
  ok(/本机不支持（读不到 \/proc\/meminfo）/.test((cardByLabel("Swap") || mkEl("div")).text()),
    "Swap 取不到 →「本机不支持」：" + JSON.stringify((cardByLabel("Swap") || mkEl("div")).text()));
  ok(/取不到磁盘信息/.test((cardByLabel("磁盘") || mkEl("div")).text()) && !meterOf("Swap") && !meterOf("磁盘"),
    "磁盘取不到 → 明说取不到，且不画进度条");
  mode = "full";

  console.log("[8] 切走再切回：每次进入采一次，且全程零写操作");
  fire(tabEls.find((t) => t.dataset.view === "orders"), "click");
  await new Promise((r) => setTimeout(r, 30));
  const n3 = siCalls().length;
  fire(tabEls.find((t) => t.dataset.view === "sysinfo"), "click");
  await new Promise((r) => setTimeout(r, 60));
  ok(siCalls().length === n3 + 1, "再进入该页签 → 又采一次（这是「打开界面刷一次」）：" + siCalls().length + " 次");
  ok(anyWrite().length === 0, "整页没有任何非 GET 请求（纯只读，无重启动 / 清理类动作）：" + JSON.stringify(anyWrite().map((c) => c.method + " " + c.url)));

  console.log("\n" + (fails ? "FAILED " + fails + " / " + checks : "ALL OK " + checks + " checks"));
  process.exit(fails ? 1 : 0);
})();
