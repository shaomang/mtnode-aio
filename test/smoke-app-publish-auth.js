"use strict";
/* 上架窗的登录态收口 —— 真跑 renderer/app-publish.js 的 openAppPublish（纯 Node + 迷你 DOM）
 *   node test/smoke-app-publish-auth.js
 *
 * 这一份钉住的是一个真实故障：「已经登录，上架窗却显示『未登录：先登录再上传』」。
 * 病根在于上架窗的登录态判据是**自己裸打 /api/me**：
 *   · 网络 / 服务端抖一下（status=0 / 5xx）→ 旧代码记 loggedIn=false，把已登录的用户说成未登录；
 *   · 服务器真不认这个会话（401）→ 旧代码也不清本机凭据：顶栏still「已登录」、上架窗说未登录，
 *     用户点「去登录」又被顶栏当成已登录，连重新登录的入口都找不到。
 * 现在判据走主进程的账户契约 window.api.authMe（401 时它会清凭据 + 广播），失败分三档：
 *   未登录（本机无凭据）/ 登录态没核到（有凭据但这次没核到，给「重试读取登录态」）/ 已登录。
 *
 * 被测对象是真源码：用 vm 在迷你 DOM 里**真跑** openAppPublish 与本窗的绘制函数，
 * 四个场景各自断言「页脚说了什么、上传按钮能不能点、动作按钮是哪一颗」。
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
const read = (rel) => fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");

/* ───────── 迷你 DOM：只实现 app-publish.js 真正用到的那几样 ───────── */

function mkEl(tag) {
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    id: "",
    className: "",
    textContent: "",
    children: [],
    parentNode: null,
    hidden: false,
    disabled: false,
    readOnly: false,
    checked: false,
    type: "",
    title: "",
    value: "",
    placeholder: "",
    maxLength: 0,
    src: "",
    style: {},
    dataset: {},
    attrs: {},
    listeners: {},
    ownerDocument: null,
  };
  el.classList = {
    add() {
      const list = new Set(String(el.className || "").split(/\s+/).filter(Boolean));
      for (const a of arguments) if (a) list.add(a);
      el.className = Array.from(list).join(" ");
    },
    remove() {
      const drop = new Set(Array.from(arguments));
      el.className = String(el.className || "")
        .split(/\s+/)
        .filter((c) => c && !drop.has(c))
        .join(" ");
    },
    contains(c) {
      return String(el.className || "").split(/\s+/).indexOf(c) >= 0;
    },
    toggle(c, on) {
      if (on) el.classList.add(c);
      else el.classList.remove(c);
    },
  };
  el.appendChild = (child) => {
    if (child && child.__text) {
      el.textContent += String(child.data || "");
      return child;
    }
    el.textContent = el.textContent; /* 保留已有文本（DOM 语义：先 append 的文本节点后接子节点） */
    if (child) {
      child.parentNode = el;
      el.children.push(child);
    }
    return child;
  };
  el.removeChild = (child) => {
    const i = el.children.indexOf(child);
    if (i >= 0) el.children.splice(i, 1);
    return child;
  };
  el.remove = () => {
    if (el.parentNode) el.parentNode.removeChild(el);
  };
  el.setAttribute = (k, v) => {
    el.attrs[k] = String(v);
  };
  el.getAttribute = (k) => (k in el.attrs ? el.attrs[k] : null);
  el.removeAttribute = (k) => {
    delete el.attrs[k];
  };
  el.addEventListener = (ev, fn) => {
    (el.listeners[ev] = el.listeners[ev] || []).push(fn);
  };
  el.removeEventListener = (ev, fn) => {
    const list = el.listeners[ev] || [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  };
  el.click = () => {
    /* 真 DOM 里 click() 也会触发 el.onclick —— app-publish.js 的动作按钮挂的是 onclick */
    const ev = { preventDefault() {}, stopPropagation() {} };
    if (typeof el.onclick === "function") el.onclick(ev);
    for (const fn of (el.listeners.click || []).slice()) fn(ev);
  };
  el.setSelectionRange = () => {};
  el.focus = () => {};
  el.querySelector = () => null;
  el.querySelectorAll = () => [];
  el.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
  Object.defineProperty(el, "innerHTML", {
    get() {
      return "";
    },
    set() {
      el.children.length = 0;
      el.textContent = "";
    },
  });
  return el;
}

function walk(node, out) {
  for (const c of node.children || []) {
    out.push(c);
    walk(c, out);
  }
  return out;
}

function mkDoc() {
  const html = mkEl("html");
  const body = mkEl("body");
  html.appendChild(body);
  const overlay = mkEl("div");
  overlay.id = "overlay";
  overlay.style.display = "none";
  const box = mkEl("div");
  box.className = "overlay-box";
  const ovBody = mkEl("div");
  ovBody.id = "ovBody";
  const ovFoot = mkEl("div");
  ovFoot.id = "ovFoot";
  box.appendChild(ovBody);
  box.appendChild(ovFoot);
  overlay.appendChild(box);
  body.appendChild(overlay);
  const byId = { overlay, ovBody, ovFoot, ovTitle: mkEl("div") };
  const doc = {
    body,
    documentElement: html,
    getElementById: (id) => byId[id] || null,
    createElement: mkEl,
    createTextNode: (t) => ({ __text: true, data: String(t == null ? "" : t) }),
    contains: (node) => {
      if (!node) return false;
      let p = node;
      while (p) {
        if (p === html) return true;
        p = p.parentNode;
      }
      return false;
    },
    querySelector: (sel) => {
      const s = String(sel);
      /* app-publish.js 只用作 pubShellBox() 的 "…> .overlay-box" 形态 */
      if (/\.overlay-box/.test(s)) return box;
      return null;
    },
    querySelectorAll: (sel) => {
      const s = String(sel);
      if (/pub-resize/.test(s)) {
        return walk(ovBody, []).filter((e) => e.classList.contains("pub-resize"));
      }
      if (/overlay-box/.test(s)) return [box];
      return [];
    },
    addEventListener() {},
    removeEventListener() {},
  };
  Object.defineProperty(doc, "readyState", { get: () => "complete" });
  return doc;
}

/* ───────── 沙箱：真源码 + 桩 ───────── */

function boot(opts) {
  const o = opts || {};
  const doc = mkDoc();
  const state = {
    user: o.user || null, /* window.MTNodeAuth.state() 的 user */
    authMeResult: o.authMeResult || { ok: true, user: { id: "u1", username: "smoke", nickname: "冒烟" } },
    authMeCalls: 0,
    storeCalls: [],
    toasts: [],
    opened: 0,
  };
  const win = {
    document: doc,
    innerWidth: 1400,
    innerHeight: 900,
    console,
    setTimeout,
    clearTimeout,
    Promise,
    Math,
    Date,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Set,
    Map,
    Error,
    isNaN,
    parseInt,
    parseFloat,
    encodeURIComponent,
    decodeURIComponent,
    I18n: {
      /* 与 renderer/i18n.js 的 t() 同口径：键就是中文原文，{name} 占位替换 */
      t: (k, vars) => {
        let s = String(k == null ? "" : k);
        if (vars && typeof vars === "object") {
          s = s.replace(/\{(\w+)\}/g, (_, name) => (vars[name] == null ? "" : String(vars[name])));
        }
        return s;
      },
      getLocale: () => "zh",
    },
    MTNodeAuth: {
      state: () => ({ signedIn: !!state.user, user: state.user }),
      refresh: async () => ({ signedIn: !!state.user, user: state.user }),
      open: () => {
        state.opened++;
      },
    },
    api: {
      appsList: async () => ({
        apps: [{ id: "demo-app", name: "演示应用", version: "1.0.0", entry: "index.html" }],
      }),
      authMe: async () => {
        state.authMeCalls++;
        const r = state.authMeResult;
        if (r && r.throw) throw new Error(r.throw);
        return r;
      },
      storeRequest: async (req) => {
        state.storeCalls.push(String(req && req.path));
        const p = String((req && req.path) || "");
        /* 线上状态：这个 id 本机账号自己已上架过（mine）→ 页脚会算「将追加版本」；
           版本树 / 配额：够用就好（这一份测的是登录态，不是多版本） */
        if (/\/versions/.test(p)) {
          return { ok: true, status: 200, data: { latestVersion: "1.0.0", versions: [{ version: "1.0.0" }] } };
        }
        if (/owner=/.test(p)) return { ok: true, status: 200, data: { items: [] } };
        if (/\/api\/apps\/demo-app$/.test(p)) {
          return {
            ok: true,
            status: 200,
            data: { item: { id: "demo-app", owner: "smoke", mine: true, latestVersion: "1.0.0", versions: [{ version: "1.0.0" }] } },
          };
        }
        return { ok: false, status: 404, data: { ok: false, code: "NOT_FOUND", error: "not found" } };
      },
      appsExportZip: async () => ({ ok: true, sha256: "x", bytes: 1 }),
      appsReadZipBase64: async () => ({ ok: true, base64: "AA==", sha256: "x" }),
    },
    toast: (msg, kind) => state.toasts.push({ msg: String(msg), kind: String(kind || "") }),
    toastSafe: (msg, kind) => state.toasts.push({ msg: String(msg), kind: String(kind || "") }),
    openOverlay: () => {
      doc.getElementById("overlay").style.display = "flex";
    },
    closeOverlay: () => {
      doc.getElementById("overlay").style.display = "none";
    },
    fmtBytes: (n) => String(n) + "B",
    appsLocalById: () => null,
    mediaFileUrlOf: () => "",
  };
  win.window = win;
  const ctx = vm.createContext(win);
  vm.runInContext(read("renderer/app-publish.js"), ctx, { filename: "app-publish.js" });
  return { win, doc, state, ctx };
}

/* 打开窗之后把「我已阅读并同意」勾上：页脚此时才算得完（这一份测的是登录态，不是声明） */
function tickDecl(doc) {
  const body = doc.getElementById("ovBody");
  const cb = walk(body, []).find((e) => e.tagName === "INPUT" && e.type === "checkbox");
  if (cb) {
    cb.checked = true;
    for (const fn of (cb.listeners.change || []).slice()) fn({});
    for (const fn of (cb.listeners.click || []).slice()) fn({});
  }
  return !!cb;
}

/* 页脚组件读数：状态文字 / 上传按钮 / 状态行里那颗动作按钮 */
function footOf(doc) {
  const foot = doc.getElementById("ovFoot");
  const note = foot.children.find((c) => c.classList.contains("pub-foot-note"));
  const up = foot.children.find((c) => c.tagName === "BUTTON" && c.classList.contains("primary"));
  const act = note ? note.children.find((c) => c.classList.contains("pub-act")) : null;
  const authChip = doc
    .getElementById("ovBody")
    .children.concat([])
    .flatMap((r) => walk(r, []))
    .find((e) => e.classList.contains("pub-chip-auth"));
  return {
    note: note ? String(note.textContent) : "",
    enabled: !!(up && !up.disabled),
    upLabel: up ? String(up.textContent) : "",
    act: act ? String(act.textContent) : "",
    chip: authChip ? String(authChip.textContent) : "",
  };
}

/* 开窗并等它那串异步读取走完：openAppPublish 先同步开窗、再挂 PUB.load，
   所以这里先等窗壳出现（PUB.dom.root），再 await PUB.load —— 全程不靠 setTimeout 猜。 */
async function openAndSettle(win) {
  win.openAppPublish("demo-app");
  const PUB = win.__mtnodeAppPublish;
  for (let i = 0; i < 200 && !(PUB.dom && PUB.dom.root); i++) {
    await new Promise((r) => setImmediate(r));
  }
  const p = PUB.load;
  if (p && typeof p.then === "function") await p;
  return PUB;
}

/* ───────── 断言 ───────── */

async function main() {
  console.log("[1] 已登录 + 会话有效：页脚按线上状态给结论、上传可点");
  {
    const { win, doc } = boot({ user: { id: "u1", username: "smoke", nickname: "冒烟" } });
    await openAndSettle(win);
    tickDecl(doc);
    const f = footOf(doc);
    ok(/将追加版本/.test(f.note), "页脚 = 将追加版本（不是未登录）：" + f.note);
    ok(f.enabled, "上传按钮可点（登录态核过）");
    ok(f.act === "", "没有多余的「去登录 / 重试」动作按钮");
    ok(f.chip === "已登录：冒烟", "窗内登录账号 chip = " + f.chip);
  }

  console.log("[2] 已登录 + 服务端抖了一下（HTTP 500）：不能说「未登录」，给「重试读取登录态」");
  {
    const { win, doc, state } = boot({
      user: { id: "u1", username: "smoke", nickname: "冒烟" },
      authMeResult: { ok: false, status: 500, code: "INTERNAL", error: "Internal Server Error" },
    });
    await openAndSettle(win);
    tickDecl(doc);
    const f = footOf(doc);
    ok(!/未登录/.test(f.note), "页脚不再说「未登录」：" + f.note);
    ok(/登录态没核到/.test(f.note) && /500/.test(f.note), "页脚如实说「登录态没核到（服务端 HTTP 500）」：" + f.note);
    ok(f.act === "重试读取登录态", "动作按钮 = 重试读取登录态（不是「去登录」）");
    ok(!f.enabled, "这一档先禁用上传（真实拒绝让上传自己报出来前不给假希望）");
    ok(f.chip === "已登录：冒烟", "窗体仍显示已登录账号（本机凭据还在）");
    ok(state.authMeCalls === 1, "登录态探测走主进程账户契约 authMe（1 次）");
    /* 点「重试读取登录态」：这一回服务端好了 → 页脚回到可用态 */
    state.authMeResult = { ok: true, user: { id: "u1", username: "smoke", nickname: "冒烟" } };
    const note = doc.getElementById("ovFoot").children.find((c) => c.classList.contains("pub-foot-note"));
    note.children.find((c) => c.classList.contains("pub-act")).click();
    await win.__mtnodeAppPublish.load; /* 重试那一次飞行同样记进 PUB.load */
    const f2 = footOf(doc);
    ok(/将追加版本/.test(f2.note) && f2.enabled, "重试成功 → 页脚恢复可用态且可点：" + f2.note);
  }

  console.log("[3] 已登录 + 网络不通（status=0）：同样不说未登录，给重试");
  {
    const { win, doc } = boot({
      user: { id: "u1", username: "smoke", nickname: "冒烟" },
      authMeResult: { ok: false, status: 0, error: "fetch failed" },
    });
    await openAndSettle(win);
    tickDecl(doc);
    const f = footOf(doc);
    ok(!/未登录/.test(f.note), "网络不通时不说未登录：" + f.note);
    ok(/连不上账户服务/.test(f.note), "页脚 = 登录态没核到（连不上账户服务）：" + f.note);
    ok(f.act === "重试读取登录态", "动作按钮 = 重试读取登录态");
  }

  console.log("[4] 服务器明确不认这个会话（401）：按未登录收口 + 给「去登录」");
  {
    const { win, doc, state } = boot({
      user: { id: "u1", username: "smoke", nickname: "冒烟" },
      authMeResult: { ok: false, status: 401, code: "UNAUTHORIZED", error: "未登录" },
    });
    await openAndSettle(win);
    const f = footOf(doc);
    ok(/未登录|登录已失效/.test(f.note), "页脚按未登录收口：" + f.note);
    ok(f.act === "去登录", "动作按钮 = 去登录");
    ok(!f.enabled, "上传按钮禁用");
    ok(f.chip === "未登录", "窗内 chip = 未登录（不再自相矛盾）");
    ok(state.authMeCalls === 1, "401 也走 authMe（主进程据此清本机凭据 + 广播 auth:changed）");
    /* 点「去登录」走统一账户模块的入口 */
    const note = doc.getElementById("ovFoot").children.find((c) => c.classList.contains("pub-foot-note"));
    note.children.find((c) => c.classList.contains("pub-act")).click();
    ok(state.opened === 1, "「去登录」打开统一账户对话框（MTNodeAuth.open）");
  }

  console.log("[5] 本机凭据不在（未登录）：openAppPublish 直接拦下并去登录，不开窗");
  {
    const { win, doc, state } = boot({ user: null });
    await openAndSettle(win);
    ok(doc.getElementById("ovBody").children.length === 0, "没有开窗（ovBody 空）");
    ok(state.toasts.some((t) => /上架需要先登录/.test(t.msg)), "给了「上架需要先登录」的提示");
    ok(state.opened === 1, "并且自动打开了登录对话框");
  }

  console.log("[6] 上传被服务端按未登录拒绝（401）：本窗与顶栏一起收敛成未登录 + 去登录");
  {
    const { win, doc, state } = boot({ user: { id: "u1", username: "smoke", nickname: "冒烟" } });
    await openAndSettle(win);
    tickDecl(doc);
    /* 打包 / 读回都成功，到 POST 那一步服务端回 401（凭据在这期间失效了） */
    win.api.storeRequest = async (req) => {
      const p = String((req && req.path) || "");
      if (String(req && req.method) === "POST") {
        return { ok: false, status: 401, data: { ok: false, code: "UNAUTHORIZED", error: "未登录" } };
      }
      if (/\/versions/.test(p)) return { ok: true, status: 200, data: { latestVersion: "1.0.0", versions: [] } };
      if (/owner=/.test(p)) return { ok: true, status: 200, data: { items: [] } };
      return { ok: false, status: 404, data: {} };
    };
    const up = doc
      .getElementById("ovFoot")
      .children.find((c) => c.tagName === "BUTTON" && c.classList.contains("primary"));
    ok(!up.disabled, "上传前按钮可点（表单齐、声明已勾）");
    up.click();
    for (let i = 0; i < 400 && win.__mtnodeAppPublish.busy; i++) {
      await new Promise((r) => setImmediate(r));
    }
    await new Promise((r) => setImmediate(r));
    const f = footOf(doc);
    ok(/登录已失效/.test(f.note), "页脚按「登录已失效」收口（不是「上传失败：未登录或登录已过期」）：" + f.note);
    ok(f.act === "去登录", "页脚出现「去登录」动作按钮");
    ok(f.chip === "未登录", "窗内 chip 同步成未登录");
    ok(state.toasts.some((t) => /登录已失效/.test(t.msg)), "给了「登录已失效」的提示");
    ok(state.authMeCalls === 2, "为收口又问了一次账户契约 authMe（开窗 1 次 + 收口 1 次）");
  }

  console.log("[7] 源码接线：判据走账户契约、401 收口、i18n 词条齐");
  {
    const src = read("renderer/app-publish.js");
    ok(/api\.authMe\(\)/.test(src), "登录态判据走 window.api.authMe（主进程契约，401 会清凭据 + 广播）");
    ok(/function pubSessionLost/.test(src), "401 收口函数 pubSessionLost 在位");
    ok(/pubSessionLost\(r, pubT\("线上状态读不到/.test(src), "线上状态读到 401 也走收口");
    ok(/pubSessionLost\(r, pubT\("配额读不到/.test(src), "配额读到 401 也走收口");
    ok(/重试读取登录态/.test(src) && /pubAuthAction/.test(src), "页脚有「重试读取登录态」动作按钮");
    const i18n = read("renderer/i18n.js");
    for (const k of [
      '"未登录：先登录再上传"',
      '"正在读取登录态…"',
      '"登录态没核到（服务端 HTTP {code}）"',
      '"登录态没核到（连不上账户服务）"',
      '"重试读取登录态"',
      '"已登录"',
    ]) {
      ok(i18n.indexOf(k) >= 0, "i18n 中英词条在：" + k);
    }
    const css = read("renderer/css/app-publish.css");
    ok(/\.pub-chip-auth/.test(css) && /\.pub-note-act/.test(css), "样式在（登录 chip + 页脚动作按钮）");
  }

  console.log("\n" + (fails ? "FAIL / " : "PASS / ") + checks + " 项断言");
  process.exit(fails ? 1 : 0);
}

main().catch((e) => {
  console.error("测试自己炸了：", e);
  process.exit(1);
});
