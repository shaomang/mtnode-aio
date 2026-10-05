"use strict";
/* 管理台「内容管理」页回归 —— 零依赖，`node test/smoke-admin-content-ui.js`
 *
 * 为什么单独一只：`store-saas/admin/admin.js` 是**真实运行的浏览器脚本**（零依赖、无框架、
 * 靠 getElementById 直取元素），静态断言只能证明「字符串写对了」，证明不了「点了不炸」。
 * 这里用最小假 DOM + 假 fetch 把它**真跑一遍**，钉住本轮新增的「内容管理」页：
 *   [1] 页签位置与页内二级页签：系统资源监控紧跟「概览」、内容管理排最后；四个二级页签用
 *       data-csub（**不占**「中转服务」那套 data-sub，否则 relay 那只回归会被带崩）
 *   [2] 默认停在「应用」，打 /api/admin/content?kind=app&page=1&pageSize=20，表渲染 + 页签角标
 *   [3] 上架 / 下架：POST /api/admin/content/publish（unpublish 真假分明）
 *   [4] 编辑：弹窗字段（标题 / 简介 / 标签 / 应用另有图标文件）→ POST /api/admin/content/update
 *   [5] 版本历史：GET /api/admin/content/versions → 弹窗列表；「删除此版本」先二次确认再 POST delete-version
 *   [6] 删除：二次确认弹窗写明「删哪条、含几个版本」→ POST /api/admin/content/delete
 *   [7] 模板 / 技能：各自的列表接口、技能的「设为官方」走 update、多文件技能下载先让选文件
 *   [8] 改动留痕子页签：GET /api/admin/content/audit 并渲染动作 / 类型 / 对象
 *   [9] 重发静态目录：POST /api/admin/content/republish + GET /api/apps/pub 体检文案
 *   [10] 纪律：admin.js 里没有任何 setInterval（内容页不轮询），引用的元素 id 全在 index.html 里
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
    files: [],
    type: "",
    accept: "",
    colSpan: 1,
    rows: 0,
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
const files = {
  tabs: [...html.matchAll(/data-view="([a-z]+)"/g)].map((m) => m[1]),
  subTabs: [...html.matchAll(/data-sub="([a-z]+)"/g)].map((m) => m[1]),
  cSubTabs: [...html.matchAll(/data-csub="([a-z]+)"/g)].map((m) => m[1]),
  viewIds: [...html.matchAll(/id="view-([a-z]+)"/g)].map((m) => m[1]),
  cViewIds: [...html.matchAll(/id="cview-([a-z]+)"/g)].map((m) => m[1]),
  htmlIds: [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]),
};

const byId = new Map(files.htmlIds.map((id) => {
  const e = mkEl("div");
  e.id = id;
  return [id, e];
}));
const tabEls = files.tabs.map((v) => {
  const e = mkEl("button");
  e.dataset.view = v;
  return e;
});
const cSubTabEls = files.cSubTabs.map((v) => {
  const e = mkEl("button");
  e.dataset.csub = v;
  return e;
});
const subTabEls = files.subTabs.map((v) => {
  const e = mkEl("button");
  e.dataset.sub = v;
  return e;
});
const document = {
  getElementById: (id) => byId.get(id) || null,
  createElement: (t) => mkEl(t),
  querySelectorAll: (sel) => {
    if (sel === "#tabs .tab") return tabEls;
    if (sel === ".view") return files.viewIds.map((v) => byId.get("view-" + v)).filter(Boolean);
    if (sel === "#relaySubtabs .subtab") return subTabEls;
    if (sel === ".subview") return [...html.matchAll(/id="sub-([a-z]+)"/g)].map((m) => byId.get("sub-" + m[1])).filter(Boolean);
    if (sel === "#contentSubtabs .subtab") return cSubTabEls;
    if (sel === ".csubview") return files.cViewIds.map((v) => byId.get("cview-" + v)).filter(Boolean);
    return [];
  },
  addEventListener() {},
  body: mkEl("body"),
};

/* ---------- 假 fetch ---------- */

const calls = [];
const APP_ROWS = [
  {
    kind: "app", id: "cool-app", ownerId: "u_author", ownerName: "authora", title: "很酷的应用", desc: "一个应用",
    tags: ["工具"], version: "1.0.1", versionCount: 2, bytes: 2048, downloads: 3, likes: 1, entry: "index.html",
    sha256: "aa", hasIcon: true, unpublished: false, unpublishedAt: 0, branchCount: 1, createdAt: 1, updatedAt: 2,
  },
  {
    kind: "app", id: "old-app", ownerId: "u_other", ownerName: "authorb", title: "下架过的应用", desc: "x",
    tags: [], version: "0.9.0", versionCount: 1, bytes: 512, downloads: 0, likes: 0, entry: "index.html",
    sha256: "bb", hasIcon: false, unpublished: true, unpublishedAt: 5, branchCount: 1, createdAt: 1, updatedAt: 3,
  },
];
const TPL_ROWS = [
  {
    kind: "template", id: "tpl_1", ownerId: "u_other", ownerName: "authorb", title: "示例模板", desc: "d",
    tags: ["小说"], bytes: 128, downloads: 7, likes: 2, hasPreview: true, createdAt: 1, updatedAt: 4,
  },
];
const SKILL_ROWS = [
  {
    kind: "skill", id: "sk_1", ownerId: "u_other", ownerName: "authorb", title: "示例技能", skillName: "demo-skill",
    desc: "", tags: [], version: "1.2.0", official: false, fileCount: 2, fileList: ["SKILL.md", "extra/notes.md"],
    bytes: 300, downloads: 1, likes: 0, hasPreview: false, createdAt: 1, updatedAt: 5,
  },
];
const VERSIONS = {
  ok: true, id: "cool-app", ownerId: "u_author", ownerName: "authora", title: "很酷的应用",
  latestVersion: "1.0.1", unpublished: false, versionsOn: true,
  items: [
    { version: "1.0.1", parentVersion: "1.0.0", bytes: 2048, sha256: "aa", entry: "index.html", createdAt: 20, current: true, hasFile: true },
    { version: "1.0.0", parentVersion: "", bytes: 1024, sha256: "a0", entry: "index.html", createdAt: 10, current: false, hasFile: true },
  ],
};
const AUDIT = {
  ok: true,
  items: [
    { id: "ca_2", at: 1730000000000, userId: "u_admin", username: "ms2308", action: "update", kind: "app", targetId: "cool-app", targetOwnerId: "u_author", targetTitle: "很酷的应用", detail: "改了标题 / 标签" },
    { id: "ca_1", at: 1729000000000, userId: "u_admin", username: "ms2308", action: "unpublish", kind: "app", targetId: "cool-app", targetOwnerId: "u_author", targetTitle: "很酷的应用", detail: "管理台下架" },
  ],
};

const fetchStub = async (url, opt) => {
  const u = String(url);
  const o = opt || {};
  calls.push({ url: u, method: o.method || "GET", body: o.body ? JSON.parse(o.body) : null, auth: (o.headers || {}).Authorization || "" });
  const json = (obj, status) => ({
    ok: (status || 200) < 400,
    status: status || 200,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
    blob: async () => ({ size: 42, type: "application/zip" }),
  });
  if (u.includes("/api/admin/overview")) {
    return json({ ok: true, admin: { id: "u_admin", username: "ms2308", nickname: "管理员" }, sessionExpiresAt: Date.now() + 3600e3, stats: {}, alipay: {}, wechat: {}, config: {} });
  }
  if (u.includes("/api/admin/content/versions")) return json(VERSIONS);
  if (u.includes("/api/admin/content/audit")) return json(AUDIT);
  if (u.includes("/api/admin/content/update")) return json({ ok: true, changed: ["标题"] });
  if (u.includes("/api/admin/content/publish")) return json({ ok: true });
  if (u.includes("/api/admin/content/delete-version")) return json({ ok: true, remaining: 1 });
  if (u.includes("/api/admin/content/delete")) return json({ ok: true });
  if (u.includes("/api/admin/content/republish")) {
    return json({ ok: true, result: { ok: true, apps: 2, files: 3 }, health: { ok: true, dir: "/tmp/apps", dbApps: 2, diskApps: 2, fallback: false, last: { reason: "管理台手动重发", ok: true, apps: 2, files: 3 } } });
  }
  if (u.includes("/api/admin/content/download")) return json({ ok: true, bytes: 42 });
  if (u.includes("/api/admin/content?")) {
    const kind = /kind=([a-z]+)/.exec(u)[1];
    const items = kind === "app" ? APP_ROWS : kind === "template" ? TPL_ROWS : SKILL_ROWS;
    return json({ ok: true, kind: kind, page: 1, pageSize: 20, total: items.length, items: items, counts: { app: 2, appUnpublished: 1, template: 1, skill: 1, skillOfficial: 0 } });
  }
  if (u.includes("/api/apps/pub")) {
    return json({ ok: true, dir: "/tmp/apps", dbApps: 2, diskApps: 2, fallback: false, last: { reason: "启动", ok: true, apps: 2, files: 3 } });
  }
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

const contentCalls = (kind) => calls.filter((c) => c.url.includes("/api/admin/content?") && c.url.includes("kind=" + kind));
const lastContentCall = (kind) => contentCalls(kind).slice(-1)[0];
const postCall = (part) => calls.filter((c) => c.method === "POST" && c.url.includes(part)).slice(-1)[0];
const dlgOpen = () => !byId.get("dlg").classList.contains("hidden");
const dlgText = () => byId.get("dlgBody").text();

(async () => {
  console.log("[1] 页签与子页签结构（不占 relay 那套 data-sub）");
  ok(files.tabs.join(",") === "overview,sysinfo,orders,users,ledger,tips,relay,content",
    "顶栏页签顺序：概览 · 系统资源监控 · 订单 · 用户 · 流水 · 打赏 · 中转服务 · 内容管理 —— 实得 " + files.tabs.join(","));
  ok(files.subTabs.join(",") === "usage,config,test,audit",
    "relay 的 data-sub 仍是那四个（新页签没有占用它，relay 那只回归不受影响）");
  ok(files.cSubTabs.join(",") === "app,template,skill,audit" && files.cViewIds.join(",") === "app,template,skill,audit",
    "内容管理四个页内二级页签与视图：应用 / 模板 / 技能 / 改动留痕");
  ok(/data-csub="app"[^>]*>应用/.test(html) && /class="subtab active" data-csub="app"/.test(html),
    "默认落在「应用」子页签上（active 写在 app 上）");
  ok(/id="contentSubtabs"/.test(html) && /\.csubview/.test(read("store-saas/admin/admin.css")),
    "有 contentSubtabs 与 .csubview 样式（切子页签靠它收起来）");
  ok(!/setInterval\s*\(/.test(js), "admin.js 里没有任何 setInterval（内容页不轮询、不自动刷）");

  const refIds = [...new Set([...js.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]))];
  const missing = refIds.filter((id) => !files.htmlIds.includes(id));
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
  await new Promise((r) => setTimeout(r, 40));

  console.log("[2] 点顶栏「内容管理」→ 默认停在「应用」并拉列表 + 静态目录体检");
  fire(tabEls.find((t) => t.dataset.view === "content"), "click");
  await new Promise((r) => setTimeout(r, 80));
  const appCall = lastContentCall("app");
  ok(!!appCall && /page=1/.test(appCall.url) && /pageSize=20/.test(appCall.url) && /q=&/.test(appCall.url) && /author=&/.test(appCall.url),
    "应用列表：GET " + (appCall ? appCall.url : "（没有请求）"));
  ok(!!calls.find((c) => c.url.includes("/api/apps/pub")), "顺带拉静态目录体检（GET /api/apps/pub）");
  ok(cSubTabEls.find((b) => b.dataset.csub === "app").classList.contains("active"), "「应用」子页签高亮");
  ok(!byId.get("cview-app").classList.contains("hidden") && byId.get("cview-template").classList.contains("hidden") &&
    byId.get("cview-skill").classList.contains("hidden") && byId.get("cview-audit").classList.contains("hidden"),
    "默认只显示「应用」，其余三个子视图收起来");
  const appTbl = byId.get("tblApps").text();
  ok(/应用 id/.test(appTbl) && /当前版本/.test(appTbl) && /状态/.test(appTbl) && /操作/.test(appTbl),
    "应用表列齐：应用 id / 标题 / 作者 / 当前版本 / 大小 / 下载 赞 / 状态 / 更新时间 / 操作");
  ok(/cool-app/.test(appTbl) && /很酷的应用/.test(appTbl) && /authora/.test(appTbl) && /v1\.0\.1（共 2 版）/.test(appTbl),
    "行内容渲染出来（id / 标题 / 作者 / 版本数）");
  ok(/已上架/.test(appTbl) && /已下架/.test(appTbl) && /重新上架/.test(appTbl) && /删除/.test(appTbl),
    "状态徽标与行内操作按钮都在（下架的那条显示「重新上架」）");
  ok(/应用（2）/.test(cSubTabEls.find((b) => b.dataset.csub === "app").textContent) &&
    /模板（1）/.test(cSubTabEls.find((b) => b.dataset.csub === "template").textContent) &&
    /技能（1）/.test(cSubTabEls.find((b) => b.dataset.csub === "skill").textContent),
    "页签角标 = 全量条数（服务端 counts 口径）");
  ok(/静态目录：正常/.test(byId.get("appPubMeta").textContent) && /库 2 条 \/ 盘 2 条/.test(byId.get("appPubMeta").textContent),
    "静态目录体检文案：" + JSON.stringify(byId.get("appPubMeta").textContent));

  console.log("[3] 上架 / 下架：POST /api/admin/content/publish");
  const rowBtn = (tableId, label) => {
    const rows = byId.get(tableId).children.filter((c) => c.tagName === "TBODY")[0].children;
    const btns = rows[0].children[rows[0].children.length - 1].children[0].children;
    return btns.find((b) => b.textContent === label);
  };
  fire(rowBtn("tblApps", "下架"), "click");
  await new Promise((r) => setTimeout(r, 40));
  let pub = postCall("/api/admin/content/publish");
  ok(!!pub && pub.body.id === "cool-app" && pub.body.ownerId === "u_author" && pub.body.unpublish === true,
    "点「下架」→ POST publish { unpublic:true }（带上 ownerId 指明分支）：" + JSON.stringify(pub && pub.body));
  ok(!!pub && pub.auth === "Bearer adm_test_token", "管理台请求都带 adm_ 票");

  console.log("[4] 编辑：弹窗字段 + POST /api/admin/content/update");
  fire(rowBtn("tblApps", "编辑"), "click");
  await new Promise((r) => setTimeout(r, 20));
  ok(dlgOpen() && /只改元信息/.test(dlgText()), "编辑弹窗打开并写明「只改元信息」");
  const dlgInputs = byId.get("dlgBody").children.filter((c) => c.tagName === "LABEL").map((l) => l.children[0]);
  const inputByType = (t) => dlgInputs.find((i) => i.type === t);
  ok(!!inputByType("text") && !!dlgInputs.find((i) => i.tagName === "TEXTAREA") && inputByType("file") && inputByType("file").accept.includes("image/png"),
    "字段齐：标题（text）/ 简介（textarea）/ 标签（text）/ 图标文件（file，限 png·jpg·webp）");
  inputByType("text").value = "改过的标题";
  fire(byId.get("dlgOk"), "click");
  await new Promise((r) => setTimeout(r, 60));
  const upd = postCall("/api/admin/content/update");
  ok(!!upd && upd.body.kind === "app" && upd.body.id === "cool-app" && upd.body.title === "改过的标题" && upd.body.tags !== undefined,
    "点「保存」→ POST update（kind/id/ownerId/标题/简介/标签）：" + JSON.stringify(upd && upd.body));
  ok(!dlgOpen(), "保存成功后弹窗自动关掉");

  console.log("[5] 版本历史：GET versions → 删单版本要二次确认");
  fire(rowBtn("tblApps", "版本历史"), "click");
  await new Promise((r) => setTimeout(r, 60));
  ok(!!calls.find((c) => c.url.includes("/api/admin/content/versions?id=cool-app&owner=u_author")),
    "版本历史按 id + owner 取（分支寻址）");
  const verTbl = byId.get("dlgBody").text();
  ok(/v1\.0\.1（当前）/.test(verTbl) && /v1\.0\.0/.test(verTbl) && /删除此版本/.test(verTbl),
    "弹窗列出两个版本并标出当前版本，每行带「删除此版本」");
  const verRows = byId.get("dlgBody").children.filter((c) => c.tagName === "TABLE")[0].children[1].children;
  const delBtn = verRows[1].children[verRows[1].children.length - 1].children[0].children.find((b) => b.textContent === "删除此版本");
  fire(delBtn, "click");
  await new Promise((r) => setTimeout(r, 20));
  ok(/删除版本/.test(byId.get("dlgTitle").textContent) && /v1\.0\.0/.test(dlgText()),
    "先弹二次确认，写清删哪个版本：" + JSON.stringify(byId.get("dlgTitle").textContent));
  fire(byId.get("dlgOk"), "click");
  await new Promise((r) => setTimeout(r, 60));
  const dv = postCall("/api/admin/content/delete-version");
  ok(!!dv && dv.body.id === "cool-app" && dv.body.ownerId === "u_author" && dv.body.version === "1.0.0",
    "确认后 POST delete-version：" + JSON.stringify(dv && dv.body));

  console.log("[6] 删除整条：二次确认写明影响，再 POST delete");
  fire(rowBtn("tblApps", "删除"), "click");
  await new Promise((r) => setTimeout(r, 20));
  const delText = dlgText();
  ok(dlgOpen() && /将要删除：应用分支「很酷的应用」/.test(delText) && /含 2 个版本的 zip/.test(delText),
    "确认文案写明删哪条、含几个版本：" + JSON.stringify(delText.slice(0, 120)));
  ok(/不可撤销/.test(delText) && /改动留痕/.test(delText), "并写明不可撤销 + 会留痕");
  fire(byId.get("dlgOk"), "click");
  await new Promise((r) => setTimeout(r, 60));
  const del = postCall("/api/admin/content/delete");
  ok(!!del && del.body.kind === "app" && del.body.id === "cool-app" && del.body.ownerId === "u_author",
    "确认后 POST delete：" + JSON.stringify(del && del.body));

  console.log("[7] 模板 / 技能子页签：各自的接口与操作");
  fire(cSubTabEls.find((b) => b.dataset.csub === "template"), "click");
  await new Promise((r) => setTimeout(r, 60));
  ok(!byId.get("cview-template").classList.contains("hidden") && byId.get("cview-app").classList.contains("hidden"),
    "切到「模板」：模板视图显示、应用视图收起");
  const tplCall = lastContentCall("template");
  ok(!!tplCall && /q=&/.test(tplCall.url) && !/status=/.test(tplCall.url),
    "模板列表不带状态筛选（模板没有下架位）：" + (tplCall ? tplCall.url : "（没有请求）"));
  const tplTbl = byId.get("tblTpls").text();
  ok(/示例模板/.test(tplTbl) && /小说/.test(tplTbl) && /下载文件/.test(tplTbl) && /看预览图/.test(tplTbl),
    "模板表渲染 + 行内操作是「编辑 / 下载文件 / 看预览图 / 删除」（没有版本与上下架空按钮）");
  ok(!/版本历史/.test(tplTbl) && !/下架/.test(tplTbl), "模板行上不摆应用专属的空按钮");

  fire(cSubTabEls.find((b) => b.dataset.csub === "skill"), "click");
  await new Promise((r) => setTimeout(r, 60));
  ok(!!lastContentCall("skill") && /status=/.test(lastContentCall("skill").url),
    "技能列表带官方标记筛选位：" + (lastContentCall("skill") ? lastContentCall("skill").url : "（没有请求）"));
  const skillTbl = byId.get("tblSkills").text();
  ok(/demo-skill/.test(skillTbl) && /非官方/.test(skillTbl) && /设为官方/.test(skillTbl),
    "技能表渲染（skill name / 官方徽标 / 设为官方按钮）");
  const skillBtn = (label) => rowBtn("tblSkills", label);
  fire(skillBtn("设为官方"), "click");
  await new Promise((r) => setTimeout(r, 60));
  const off = postCall("/api/admin/content/update");
  ok(!!off && off.body.kind === "skill" && off.body.official === true,
    "「设为官方」走 update（kind=skill / official=true）：" + JSON.stringify(off && off.body));
  fire(skillBtn("下载"), "click");
  await new Promise((r) => setTimeout(r, 20));
  ok(/下载技能文件/.test(byId.get("dlgTitle").textContent) && /extra\/notes\.md/.test(dlgText()),
    "多文件技能点「下载」先让挑文件（不瞎下一份）");
  fire(byId.get("dlgCancel"), "click");

  console.log("[8] 改动留痕子页签");
  fire(cSubTabEls.find((b) => b.dataset.csub === "audit"), "click");
  await new Promise((r) => setTimeout(r, 60));
  const auditCall = calls.filter((c) => c.url.includes("/api/admin/content/audit")).pop();
  ok(!!auditCall && /limit=100/.test(auditCall.url), "GET /api/admin/content/audit?limit=100");
  const auditTbl = byId.get("tblContentAudit").text();
  ok(/管理员/.test(auditTbl) && /动作/.test(auditTbl) && /对象/.test(auditTbl) && /ms2308/.test(auditTbl) &&
    /编辑/.test(auditTbl) && /下架/.test(auditTbl) && /改了标题 \/ 标签/.test(auditTbl),
    "留痕表列齐并渲染出「谁 / 何时 / 动作 / 类型 / 对象 / 说明」");
  ok(/最近 2 条/.test(byId.get("cAuditMeta").textContent), "表头写明条数与留存上限：" + JSON.stringify(byId.get("cAuditMeta").textContent));

  console.log("[9] 重发静态目录（应用子页顶部的修复按钮）");
  fire(cSubTabEls.find((b) => b.dataset.csub === "app"), "click");
  await new Promise((r) => setTimeout(r, 40));
  const beforePub = calls.filter((c) => c.url.includes("/api/apps/pub")).length;
  fire(byId.get("btnAppRepublish"), "click");
  await new Promise((r) => setTimeout(r, 80));
  ok(!!postCall("/api/admin/content/republish"), "点「重发静态目录」→ POST /api/admin/content/republish");
  ok(calls.filter((c) => c.url.includes("/api/apps/pub")).length > beforePub, "重发后重新体检（GET /api/apps/pub）");
  ok(/静态目录：正常/.test(byId.get("appPubMeta").textContent), "体检文案跟着刷新");

  console.log("[10] 切走再切回：记住当前子页签，不重开别的页");
  fire(tabEls.find((t) => t.dataset.view === "orders"), "click");
  await new Promise((r) => setTimeout(r, 20));
  const nApp = contentCalls("app").length;
  fire(tabEls.find((t) => t.dataset.view === "content"), "click");
  await new Promise((r) => setTimeout(r, 60));
  ok(cSubTabEls.find((b) => b.dataset.csub === "app").classList.contains("active") &&
    !byId.get("cview-app").classList.contains("hidden"), "回到内容管理仍停在「应用」子页签");
  ok(contentCalls("app").length > nApp, "并按当前子页签重拉一次列表");

  console.log("\n" + (fails ? "FAILED " + fails + " / " + checks : "ALL OK " + checks + " checks"));
  process.exit(fails ? 1 : 0);
})();
