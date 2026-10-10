"use strict";
/* test/smoke-apps-comments-mount.js — 应用中心「评论区挂了又被清掉」回归（零依赖，纯 Node）
 *
 *   node test/smoke-apps-comments-mount.js
 *
 * 现场（用户报障）：应用详情窗下方的评论区**一片空白**（连「正在读取评论…」都没有），
 *   而云端 /api/comments 明明有数据（已实测：wordless 主干 1 条）。
 *
 * 根因：`appsCommentsMountInto`（renderer/app-apps.js）用 `host.dataset.appsCmtKey/On`
 *   记住「这一格已经挂过评论区」，撞上同一个 key 就直接 return true —— 但
 *   `appsDetailPaint`（详情窗每次重绘）先做了 `lower.innerHTML = ""` 把评论区 DOM 摘掉，
 *   dataset 标记却留在 host 上。于是**第二次重绘起**这一步被整段跳过：
 *   宿主是空的、标记说「挂过了」→ 评论区永远不再出现。
 *   （详情窗打开后必踩：appsDetailWarmTips / 打赏汇总回来 → appsDetailRefresh → 重绘一次。）
 *
 * 本脚本用**真源码**跑一遍这条路：真 app-comments.js（mount 整条链）+ 真
 *   appsCommentsMountInto / appsCommentsStashDraft（从 app-apps.js 取原文求值），
 *   只桩掉 DOM 与 storeRequest 回执。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
let fails = 0;
let checks = 0;
function ok(cond, msg, extra) {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg + (extra !== undefined ? "  → " + String(extra).slice(0, 300) : ""));
  }
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

/* ── 极简 DOM（只实现 app-comments.js / appsComments* 真正用到的那几个 API） ──
   用到清单（从源码里数出来的）：createElement / appendChild / insertBefore / remove /
   querySelector / className / classList(add|remove) / textContent / innerHTML /
   dataset / value / rows / maxLength / disabled / placeholder / type / title /
   addEventListener / focus / closest / parentNode / dispatchEvent */
function makeDom() {
  const nodes = [];
  function El(tag) {
    const el = {
      tagName: String(tag || "div").toUpperCase(),
      children: [],
      parentNode: null,
      dataset: {},
      style: {},
      _cls: "",
      _text: "",
      _html: "",
      value: "",
      disabled: false,
      hidden: false,
    };
    Object.defineProperty(el, "className", {
      get() {
        return el._cls;
      },
      set(v) {
        el._cls = String(v || "");
      },
    });
    Object.defineProperty(el, "textContent", {
      get() {
        return el._text || el.children.map((c) => c.textContent).join("");
      },
      set(v) {
        el._text = String(v == null ? "" : v);
        el.children.length = 0;
      },
    });
    Object.defineProperty(el, "innerHTML", {
      get() {
        return el._html;
      },
      set(v) {
        el._html = String(v == null ? "" : v);
        /* 与应用里一致：写 innerHTML = "" 会把子节点整批摘掉（parentNode 也要断） */
        for (const c of el.children) c.parentNode = null;
        el.children.length = 0;
      },
    });
    el.classList = {
      add: (c) => {
        const set = new Set(String(el._cls || "").split(/\s+/).filter(Boolean));
        set.add(String(c));
        el._cls = Array.from(set).join(" ");
      },
      remove: (c) => {
        const set = new Set(String(el._cls || "").split(/\s+/).filter(Boolean));
        set.delete(String(c));
        el._cls = Array.from(set).join(" ");
      },
      contains: (c) => String(el._cls || "").split(/\s+/).indexOf(String(c)) >= 0,
      toggle: (c, on) => (on ? el.classList.add(c) : el.classList.remove(c)),
    };
    el.appendChild = (c) => {
      if (!c) return c;
      if (c.parentNode && c.parentNode.removeChild) c.parentNode.removeChild(c);
      c.parentNode = el;
      el.children.push(c);
      return c;
    };
    el.insertBefore = (c, ref) => {
      const i = ref ? el.children.indexOf(ref) : -1;
      if (i < 0) return el.appendChild(c);
      c.parentNode = el;
      el.children.splice(i, 0, c);
      return c;
    };
    el.removeChild = (c) => {
      const i = el.children.indexOf(c);
      if (i >= 0) {
        el.children.splice(i, 1);
        c.parentNode = null;
      }
      return c;
    };
    el.remove = () => {
      if (el.parentNode) el.parentNode.removeChild(el);
    };
    el.getAttribute = (k) => (k === "class" ? el._cls : "");
    el.setAttribute = (k, v) => {
      if (k === "class") el._cls = String(v || "");
    };
    el.setAttributeNS = () => {};
    el.addEventListener = () => {};
    el.removeEventListener = () => {};
    el.dispatchEvent = () => true;
    el.focus = () => {};
    el.closest = (sel) => {
      const cls = String(sel || "").replace(/^\./, "");
      let n = el;
      while (n) {
        if (n.classList && n.classList.contains(cls)) return n;
        n = n.parentNode;
      }
      return null;
    };
    el.querySelector = (sel) => queryIn(el, sel, true);
    el.querySelectorAll = (sel) => queryAllIn(el, sel);
    el.contains = (n) => {
      let x = n;
      while (x) {
        if (x === el) return true;
        x = x.parentNode;
      }
      return false;
    };
    nodes.push(el);
    return el;
  }
  function walk(el, out) {
    for (const c of el.children || []) {
      out.push(c);
      walk(c, out);
    }
    return out;
  }
  /* 只支持 .cls / .a.b / tag / .a .b 这几种写法（本脚本够用） */
  /* 极简选择器：只认 ".cls"（含空格分隔的祖先链 ".a .b"）。刻意不复用任何宿主 API ——
     早期版本这里踩过「matches 与 el.matches 同名」的坑，重名会让每次比较都返回 false。 */
  function selMatch(el, sel) {
    const s = String(sel || "").trim();
    if (!s) return false;
    if (s.indexOf(" ") >= 0) {
      const parts = s.split(/\s+/).filter(Boolean);
      const last = parts[parts.length - 1];
      if (!selMatch(el, last)) return false;
      let n = el.parentNode;
      for (let i = parts.length - 2; i >= 0; i--) {
        let hit = false;
        while (n) {
          if (selMatch(n, parts[i])) {
            hit = true;
            n = n.parentNode;
            break;
          }
          n = n.parentNode;
        }
        if (!hit) return false;
      }
      return true;
    }
    const want = s.replace(/^\./, "");
    if (!want) return false;
    if (/^[a-zA-Z]+$/.test(want)) return el.tagName === want.toUpperCase();
    const list = String(el._cls || "").split(/\s+/).filter(Boolean);
    return list.indexOf(want) >= 0;
  }
  function queryIn(root, sel, first) {
    const found = walk(root, []).filter((n) => selMatch(n, sel));
    return first ? found[0] || null : found;
  }
  const queryAllIn = (root, sel) => queryIn(root, sel, false);
  const document = {
    createElement: (t) => El(t),
    createElementNS: (ns, t) => El(t),
    createTextNode: (t) => {
      const n = El("#text");
      n.textContent = String(t == null ? "" : t);
      return n;
    },
    body: El("body"),
    documentElement: El("html"),
    getElementById: () => null,
    querySelector: (s) => document.body.querySelector(s),
    querySelectorAll: (s) => document.body.querySelectorAll(s),
    addEventListener: () => {},
    removeEventListener: () => {},
    contains: () => true,
  };
  return { document, El };
}

/* ── 真 app-comments.js：只桩掉 window.api / I18n / 账户，其余整条链真跑 ── */
function loadRealComments() {
  const { document } = makeDom();
  const win = {
    addEventListener: () => {},
    removeEventListener: () => {},
    confirm: () => true,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
  };
  const sandbox = {
    window: win,
    document,
    console,
    setTimeout,
    clearTimeout,
    Promise,
    Event: function Event(type) {
      this.type = type;
    },
    Number,
    String,
    Object,
    Array,
    Math,
    JSON,
    Date,
    RegExp,
    isFinite,
    encodeURIComponent,
  };
  sandbox.globalThis = sandbox;
  win.document = document;
  win.api = {
    storeRequest: (o) => {
      const p = String((o && o.path) || "");
      if (p.indexOf("/api/comments") === 0 && String(o.method || "GET").toUpperCase() === "GET") {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: {
            ok: true,
            total: 1,
            rating: { avg: 5, count: 1 },
            targetOwnerId: "u_b33738db79310ff5",
            items: [
              {
                id: "c1",
                targetKind: "app",
                targetId: "wordless",
                parentId: "",
                content: "Best game ever",
                rating: 5,
                author: { id: "u1", username: "ms2308", nickname: "ms2308" },
                createdAt: 1791157727922,
                deleted: false,
                mine: false,
                canDelete: false,
              },
            ],
          },
        });
      }
      return Promise.resolve({ ok: false, status: 404, error: "not stubbed" });
    },
  };
  win.MTNodeAuth = { state: () => ({ signedIn: false, user: null }), onChange: () => () => {} };
  win.I18n = { t: (s, v) => String(s).replace(/\{(\w+)\}/g, (m, k) => String((v || {})[k] != null ? v[k] : m)) };
  vm.createContext(sandbox);
  vm.runInContext(read("renderer/app-comments.js"), sandbox, { filename: "renderer/app-comments.js" });
  return { win, document, MtComments: win.MtComments };
}

/* ── 真 appsCommentsMountInto / appsCommentsStashDraft / appsCommentTarget：取 app-apps.js 原文求值 ── */
function loadRealMountHelpers(windowObj) {
  const src = read("renderer/app-apps.js");
  const pick = (name) => {
    const i = src.indexOf("function " + name + "(");
    if (i < 0) throw new Error("app-apps.js 里找不到 " + name);
    const end = src.indexOf("\n}\n", i);
    if (end < 0) throw new Error(name + " 取不到函数尾");
    return src.slice(i, end + 3);
  };
  const draftDecl = "const APPS_CMT_DRAFT = Object.create(null);\n";
  if (src.indexOf(draftDecl.replace(/\n$/, "")) < 0) throw new Error("APPS_CMT_DRAFT 声明没找到");
  const code =
    "(function () {\n" +
    draftDecl +
    pick("appsCommentsStashDraft") +
    "\n" +
    pick("appsCommentsClearHost") +
    "\n" +
    pick("appsCommentTarget") +
    "\n" +
    pick("appsCommentsMountInto") +
    "\nreturn { appsCommentsMountInto: appsCommentsMountInto, appsCommentsStashDraft: appsCommentsStashDraft, appsCommentsClearHost: appsCommentsClearHost, appsCommentTarget: appsCommentTarget };\n})()";
  const { document } = makeDom();
  const sandbox = { window: windowObj, document, console, Object, String, Array, Number, Promise, Boolean };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return vm.runInContext(code, sandbox, { filename: "app-apps.js:comments-helpers" });
}

async function main() {
  console.log("smoke-apps-comments-mount：应用中心评论区「挂了又被清掉」回归\n");

  const { document, MtComments } = loadRealComments();
  ok(!!MtComments && typeof MtComments.mount === "function", "真 app-comments.js 挂上了 window.MtComments.mount");

  const helpers = loadRealMountHelpers({ MtComments: MtComments });
  const target = helpers.appsCommentTarget({ id: "wordless", ownerId: "u_b33738db79310ff5" });
  ok(!!target && target.id === "wordless" && target.ownerId === "u_b33738db79310ff5",
    "appsCommentTarget：上架过的应用给 { kind:app, id, ownerId }", JSON.stringify(target));

  /* 宿主 = 详情窗下方那一格（.apps-detail-cmt 的角色） */
  const lower = document.createElement("div");
  lower.className = "apps-detail-cmt";

  console.log("\n[1] 第一次挂载：占位被清掉、评论区真的在");
  const wait = document.createElement("div");
  wait.className = "apps-empty";
  wait.textContent = "正在读取评论…";
  lower.appendChild(wait);
  const mounted = helpers.appsCommentsMountInto(lower, target, { title: "wordless" }, target.ownerId);
  ok(mounted === true, "appsCommentsMountInto 回 true");
  ok(!!lower.querySelector(".cmt-root"), "宿主里挂出了 .cmt-root");
  ok(!lower.querySelector(".apps-empty"), "「正在读取评论…」占位已被清掉");
  await new Promise((r) => setTimeout(r, 0));
  ok(!!lower.querySelector(".cmt-list .cmt-row"), "真 mount 走完 GET /api/comments：列表渲染出 1 条评论");
  ok(lower.children.length === 1 && lower.children[0].className === "cmt-root", "宿主里只有一份 .cmt-root（不重复挂）");

  console.log("\n[2] 详情窗重绘（appsDetailPaint 的 lower.innerHTML = \"\"）之后");
  helpers.appsCommentsStashDraft(lower);
  lower.innerHTML = "";
  ok(!lower.querySelector(".cmt-root"), "重绘确实把评论区 DOM 摘掉了（这一步就是现场）");
  const again = helpers.appsCommentsMountInto(lower, target, { title: "wordless" }, target.ownerId);
  ok(again === true, "再挂一次仍回 true");
  ok(
    !!lower.querySelector(".cmt-root"),
    "★ 重绘后评论区必须重新挂回来（修前：宿主是空的、dataset 标记还说「挂过了」→ 一片空白）",
    "宿主子节点数=" + lower.children.length,
  );
  await new Promise((r) => setTimeout(r, 0));
  ok(!!lower.querySelector(".cmt-list .cmt-row"), "重挂之后评论列表照样有内容");

  console.log("\n[3] 同一 key 且 DOM 还在 → 原地不动（保住草稿，不白拆输入框）");
  const taBefore = lower.querySelector(".cmt-input");
  taBefore.value = "写了一半的草稿";
  const third = helpers.appsCommentsMountInto(lower, target, { title: "wordless" }, target.ownerId);
  ok(third === true, "第三次调用回 true");
  ok(lower.querySelector(".cmt-input") === taBefore && lower.querySelector(".cmt-input").value === "写了一半的草稿",
    "DOM 还在时不被拆掉：草稿原样留着（append-only 的语义没被破坏）");

  console.log("\n[4] 换一条分支（ownerId 变了）→ 必须整块换成那一支的评论");
  const other = helpers.appsCommentTarget({ id: "wordless", ownerId: "u_40c0d0252539e484" });
  const fourth = helpers.appsCommentsMountInto(lower, other, { title: "wordless" }, other.ownerId);
  ok(fourth === true && lower.children.length === 1, "切分支重挂：只剩一份 .cmt-root");
  ok(lower.dataset.appsCmtId === "wordless" && String(lower.dataset.appsCmtKey).indexOf("u_40c0d0252539e484") >= 0,
    "宿主记账跟着换成新分支的 key");

  console.log("\n[5] 本机自建 / 还没上架（没有 ownerId）→ 不挂评论区，且不许留旧记账");
  const noTarget = helpers.appsCommentTarget({ id: "my-local-app", ownerId: "" });
  ok(noTarget === null, "appsCommentTarget 对没有分支身份的应用回 null");
  helpers.appsCommentsClearHost(lower);
  ok(!lower.querySelector(".cmt-root"), "appsCommentsClearHost 把评论区清干净了");
  ok(!lower.dataset.appsCmtOn && !lower.dataset.appsCmtKey && !lower.dataset.appsCmtId,
    "★ 清场必须连记账一起清（否则换到有云端的应用时记账会拦下重挂）");
  /* 换到有云端的应用：清过场之后必须能立刻挂回来 */
  const back = helpers.appsCommentsMountInto(lower, target, { title: "wordless" }, target.ownerId);
  ok(back === true && !!lower.querySelector(".cmt-root"), "清过场之后再挂回来：评论区照常出现");

  console.log("\n[6] 源码断言：清场与挂载两侧必须同源记账");
  const apps = read("renderer/app-apps.js");
  const list = read("renderer/app-apps-list.js");
  ok(/function appsCommentsMountInto/.test(apps), "appsCommentsMountInto 仍在原处");
  ok(/function appsCommentsClearHost/.test(apps), "app-apps.js 提供 appsCommentsClearHost（DOM + 记账一起清）");
  ok(
    /dataset\.appsCmtOn\s*===\s*"1"\s*&&[\s\S]{0,200}?querySelector\("\.cmt-root"\)/.test(apps),
    "挂载侧的「已挂过」判据必须同时看 .cmt-root 还在不在（不许只信 dataset 标记）",
  );
  ok(
    /appsCommentsStashDraft\(lower\);\s*\n\s*appsCommentsClearHost\(lower\);/.test(apps),
    "详情窗重绘：草稿记下后用 appsCommentsClearHost 清场（不再裸写 lower.innerHTML = \"\"）",
  );
  ok(!/appsCommentsStashDraft\(lower\);\s*\n\s*lower\.innerHTML\s*=\s*"";/.test(apps),
    "详情窗里不再出现「记完草稿就裸清 innerHTML」这种旧写法");
  ok(/appsCommentsClearHost\(st\.cmt\)/.test(list), "列表面板：没有评论目标时也走 appsCommentsClearHost");

  console.log("\n" + (fails ? "FAILED " + fails + " / " + checks : "ALL PASS " + checks + " 项"));
  process.exit(fails ? 1 : 0);
}

main().catch((e) => {
  console.error("脚本自身出错：" + ((e && e.stack) || e));
  process.exit(1);
});
