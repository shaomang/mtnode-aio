"use strict";
/* 冒烟：卡片上点「回答」这一下，回执必须**立即**回来（本次需求）
 *   node test/smoke-ask-reply.js
 *
 * 故障现场（本次修复的 bug）：会话里那张**浏览器求助卡**（browser_help 弹的卡）上点
 *   「回答」后**没有任何反应** —— 卡片不撤、浮窗（#ixPanel）不关；而答案其实已经送达
 *   （会话照常继续往下跑）。这一等还会**超时**。
 * 根因（两处，合起来才是这个现象）：
 *   ① dsh/gateway/gateway.mjs 的 interact 分支里，求助卡作答路径（kind:'browser' +
 *      answers[]）在 `item.resolve(...)` 之后紧跟 `break` —— 跳出 switch，**跳过了函数
 *      末尾那句 `reply({ ok: true })`**，宿主那一跳永远等不到回执；
 *   ② dsh/main-dsh.js 的 interact 给这一跳套了 30 秒硬超时（提问卡同走这条通道，但它
 *      当场就回执，所以看不出超时）—— ①让它等满 30 秒，②到点把这次提交判成失败。
 *   渲染层于是拿到失败：卡不撤、浮窗不关、还弹一句「回答失败」。
 * 对照：提问卡（kind:'question'）不 break、会走到那句 reply → 当场关、不超时。
 *
 * 覆盖：
 *   [1] 真网关（真进程 + 真 stdio）：interact 立即回执（不再靠 30 秒超时收场）+ 两处源码口径
 *   [2] 真源码切片真跑：interact 每个 kind 恰好回一次、且**同步**就回（含 browser+answers 那条）
 *   [3] 真渲染层（假 DOM 跑真 app-db.js）：点「回答」→ kind:'browser' 回执发出 → 回 ok →
 *       卡片撤掉、浮窗收起、回答落进会话；失败 / stale 两态照旧收口
 *
 * 依赖：只 import node 内置；真网关用临时 DSH_HOME；不启动 Electron、不碰真实 %APPDATA%。
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawn } = require("node:child_process");

let checks = 0;
let fails = 0;
function ok(cond, msg) {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
}

const ROOT = path.join(__dirname, "..");
const read = (rel) =>
  fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8").replace(/\r\n/g, "\n");
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const GATEWAY_PATH = path.join(ROOT, "dsh", "gateway", "gateway.mjs");
const GATEWAY = read("dsh/gateway/gateway.mjs");
const MAIN_DSH = read("dsh/main-dsh.js");
const DB = read("renderer/app-db.js");

/* ═══════════════════ [1] 真网关：interact 立即回执 ═══════════════════ */
function connect(child) {
  let buf = "";
  const pending = new Map();
  let id = 0;
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.event) continue;
      if (pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      }
    }
  });
  function req(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      const rid = ++id;
      pending.set(rid, resolve);
      child.stdin.write(JSON.stringify({ id: rid, method, params }) + "\n");
      setTimeout(() => {
        if (pending.has(rid)) {
          pending.delete(rid);
          reject(new Error("timeout: " + method));
        }
      }, Number(timeoutMs) > 0 ? Number(timeoutMs) : 60000);
    });
  }
  return { req };
}

(async () => {
  console.log("\n[1] 真网关 + 真 stdio：interact 回执立即返回");
  {
    /* 源码口径先钉住两处根因（跑真进程之外再钉一份，防止谁把硬超时写回来） */
    const gwCode = stripComments(GATEWAY);
    const seg = gwCode.split("} else if (p.kind === 'browser') {")[1] || "";
    const branch = seg.slice(0, seg.indexOf("} else if (p.kind === 'tool') {"));
    ok(
      branch.length > 200 &&
        /item\.resolve\(\{ answers: p\.answers \}\)/.test(branch) &&
        !/\bbreak\b/.test(branch.slice(branch.indexOf("item.resolve({ answers: p.answers })"))),
      "网关源码：求助卡作答路径 resolve 之后**不再 break**（不跳过末尾那句 reply）",
    );
    ok(
      /reply\(\{ ok: true \}\)\s*\n\s*break\s*\n\s*\}\s*\n\s*case 'shutdown':/.test(gwCode),
      "网关源码：interact 末尾统一回执 reply({ ok: true }) 仍在（成功路径都必须落到它）",
    );
    ok(
      /interact\(params\) \{\s*\n\s*return request\('interact', params, 0\)/.test(MAIN_DSH),
      "交付那一跳（main-dsh 的 interact）不再套 30 秒硬超时",
    );
    ok(
      !/request\('interact', params, 30000\)/.test(MAIN_DSH) &&
        /const budget = timeoutMs === undefined \? 60000 : Number\(timeoutMs\)/.test(MAIN_DSH) &&
        /Number\.isFinite\(budget\) && budget > 0/.test(MAIN_DSH),
      "main-dsh 的 request()：显式 0 / 非有限预算 = 不设上限（缺省仍是旧的 60 秒，只靠网关退出兜底）",
    );

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-ask-reply-home-"));
    const child = spawn(process.execPath, [GATEWAY_PATH], {
      cwd: path.dirname(GATEWAY_PATH),
      env: { ...process.env, DSH_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let gwErr = "";
    child.stderr.on("data", (d) => {
      gwErr += d.toString();
      if (gwErr.length > 4000) gwErr = gwErr.slice(-4000);
    });
    const { req } = connect(child);
    try {
      const st = await req("status", undefined, 60000).catch(() => null);
      ok(!!(st && st.ok), "真网关起来了（status 回执 ok）");
      /* 认不出的交互 id = 网关从没见过这一问：必须是**立即**的 {ok:true, stale:true}。
         旧口径下这一帧也要等满 30 秒才被判失败（渲染层据此把卡留住）。 */
      const t0 = Date.now();
      const r = await req(
        "interact",
        { kind: "browser", id: "no-such-card", answers: [{ id: "q1", selected: ["甲"] }] },
        20000,
      ).catch((e) => ({ err: String((e && e.message) || e) }));
      const ms = Date.now() - t0;
      ok(
        !!(r && r.ok === true && r.result && r.result.ok === true && r.result.stale === true),
        "认不出的交互 id → 真 stdio 上立即回 {ok:true, stale:true}（" + JSON.stringify(r && r.result) + "）",
      );
      ok(ms < 5000, "回执是立即到的（" + ms + "ms，远小于旧的 30 秒超时）");
      await req("shutdown", undefined, 20000).catch(() => null);
    } finally {
      child.stdin.end();
      await Promise.race([
        new Promise((r) => child.once("exit", r)),
        new Promise((r) => setTimeout(r, 8000)),
      ]);
      try {
        child.kill();
      } catch (_) {}
      try {
        fs.rmSync(home, { recursive: true, force: true });
      } catch (_) {}
    }
  }

  /* ═════════ [2] 真源码切片真跑：每个 kind 恰好回一次、同步就回 ═════════ */
  console.log("\n[2] 真源码切片（interact 分派本体）真跑：恰好一次回执、同步返回");
  {
    const FROM = GATEWAY.indexOf("        case 'interact': {");
    const TO = GATEWAY.indexOf("        case 'shutdown':");
    const CASE = FROM > 0 && TO > FROM ? GATEWAY.slice(FROM, TO) : "";
    ok(CASE.length > 1000, "摘到 interact 分派真源码（case 'interact' … case 'shutdown'）");
    const runInteract = new Function(
      "msg",
      "reply",
      "bridgePending",
      "diag",
      "shortKey",
      "switch (msg.method) {\n" + CASE + "\n}",
    );

    /* 一条用例：给一个 kind + 一条预置 pending，收 reply / 桥写出 / resolve 三样。 */
    function drive(kind, params, hasPending) {
      const replies = [];
      const writes = [];
      const bridgePending = new Map();
      let resolved;
      const socket = {
        destroyed: false,
        write(line) {
          writes.push(String(line));
          return true;
        },
      };
      if (hasPending) {
        bridgePending.set(String(params.id), {
          socket,
          key: "ws|pure:0|tl:x|lean:0|nc:0|nb:0|hx:y|high",
          kind: "browser",
          reqId: "req-1",
          sessionId: "session-1",
          resolve: (v) => {
            resolved = v;
          },
          reject: () => {},
        });
      }
      runInteract(
        { method: "interact", params },
        (result, error) => replies.push({ result, error }),
        bridgePending,
        () => {},
        (k) => String(k).slice(0, 12),
      );
      return { replies, writes, resolved, left: bridgePending.size };
    }

    /* —— 本次需求的那条：求助卡作答（kind:'browser' + answers[]）—— */
    const help = drive(
      "browser",
      { kind: "browser", id: "card-1", answers: [{ id: "q1", selected: ["甲"] }] },
      true,
    );
    ok(
      help.replies.length === 1 && help.replies[0].result && help.replies[0].result.ok === true,
      "求助卡作答：**同一拍同步**回了 {ok:true}（旧写法在这里一次都不回 → 渲染层等满 30 秒）",
    );
    ok(
      JSON.stringify(help.resolved) === JSON.stringify({ answers: [{ id: "q1", selected: ["甲"] }] }),
      "答案同时原样交到工具手里（item.resolve({ answers })）",
    );
    ok(help.left === 0, "pending 表里那一条已删（不会留下一条没人认领的死卡）");

    /* —— 危险动作确认卡（kind:'browser' + outcome，旧口径也不能被这次重构带坏）—— */
    const danger = drive("browser", { kind: "browser", id: "card-2", outcome: "allowed-once" }, true);
    ok(
      danger.replies.length === 1 && danger.resolved === "allowed-once" && danger.replies[0].result.ok === true,
      "危险动作确认卡：outcome 交回工具 + 一次回执",
    );

    /* —— 提问卡那条（对照：它一直是对的）—— */
    const ask = drive("question", { kind: "question", id: "card-3", answers: [{ id: "q1", selected: ["乙"] }] }, true);
    ok(
      ask.replies.length === 1 && ask.replies[0].result.ok === true && /"t":"answer"/.test(ask.writes.join("")),
      "提问卡：answer 帧写出 + 一次回执（与求助卡同一份同步口径）",
    );

    /* —— abort / stale / 非法 kind：三颗出口各有一次回执 —— */
    const abort = drive("abort", { kind: "abort", id: "card-4" }, true);
    ok(
      abort.replies.length === 1 && /"t":"abort"/.test(abort.writes.join("")),
      "「中断任务」：abort 帧写出 + 一次回执",
    );
    const stale = drive("browser", { kind: "browser", id: "card-gone", answers: [] }, false);
    ok(
      stale.replies.length === 1 && stale.replies[0].result.stale === true,
      "认不出的 id：立即回 stale（渲染层据此收口，而不是把卡留住）",
    );
    const bad = drive("weird", { kind: "weird", id: "card-5" }, true);
    ok(
      bad.replies.length === 1 && bad.replies[0].result === undefined && !!bad.replies[0].error,
      "非法 kind：回错误文本（不是无声无息）",
    );

    /* 其余 kind（画布 / 数据库 / 事实库 / 长任务 / 素材 / 用户工具）都走同一条成功路径 */
    for (const k of ["canvas", "db", "facts", "lt", "asset", "tool"]) {
      const r = drive(k, { kind: k, id: "card-" + k, result: { x: 1 } }, true);
      ok(r.replies.length === 1 && r.replies[0].result.ok === true, k + " 回执：一次 {ok:true}");
    }
    ok(!/setTimeout/.test(CASE), "分派本体里没有任何定时器（回执不靠超时自己收场）");
  }

  /* ═════ [3] 真渲染层（假 DOM 跑真 app-db.js）：点「回答」→ 撤卡 + 浮窗收起 ═════ */
  console.log("\n[3] 真渲染层：点「回答」→ 回执发送 → 回 ok → 卡片与浮窗当场收口");
  {
    const S0 = DB.slice(DB.indexOf("const IX_MULTI_RE ="), DB.indexOf("function ixPush(kind, data, runKey, src) {"));
    const S1 = DB.slice(
      DB.indexOf("function ixPush(kind, data, runKey, src) {"),
      DB.indexOf("function ixAnswerApproval(it"),
    );
    const S2 = DB.slice(DB.indexOf("function ixLaterButton(it) {"), DB.indexOf("/* ── 主题(dsh = 默认"));
    ok(S0.length > 200 && S1.length > 1000 && S2.length > 1000, "摘到三段真源码（多选判据 / 卡片与回答 / 题面与面板渲染）");
    ok(
      S1.indexOf("function ixLaterButton") < 0 && S2.indexOf("function ixPush(") < 0,
      "三段切片互不重叠（同一上下文里跑，重名的 let 会直接抛 SyntaxError）",
    );

    function matches(el, sel) {
      const parts = String(sel).trim().split(/\s+/);
      const last = parts[parts.length - 1];
      const hit = (node, tok) =>
        tok.charAt(0) === "." ? String(node.className || "").split(/\s+/).indexOf(tok.slice(1)) >= 0 : node.tag === tok;
      if (!hit(el, last)) return false;
      let cur = el.parent;
      for (let i = parts.length - 2; i >= 0; i--) {
        while (cur && !hit(cur, parts[i])) cur = cur.parent;
        if (!cur) return false;
        cur = cur.parent;
      }
      return true;
    }
    function walk(node, fn) {
      for (const c of node.children || []) {
        fn(c);
        walk(c, fn);
      }
    }
    function mkDom() {
      const byId = Object.create(null);
      function mkEl(tag) {
        const el = {
          tag,
          _id: "",
          className: "",
          type: "",
          value: "",
          checked: false,
          title: "",
          placeholder: "",
          textContent: "",
          innerHTML: "",
          dataset: {},
          style: {},
          children: [],
          parent: null,
          onclick: null,
          removed: false,
          focused: false,
          addEventListener() {},
          removeEventListener() {},
          classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
          appendChild(c) {
            c.parent = el;
            el.children.push(c);
            return c;
          },
          remove() {
            el.removed = true;
            if (el.parent) {
              const i = el.parent.children.indexOf(el);
              if (i >= 0) el.parent.children.splice(i, 1);
            }
          },
          closest(sel) {
            let cur = el;
            while (cur) {
              if (matches(cur, sel)) return cur;
              cur = cur.parent;
            }
            return null;
          },
          querySelectorAll(sel) {
            const out = [];
            walk(el, (x) => {
              if (matches(x, sel)) out.push(x);
            });
            return out;
          },
          querySelector(sel) {
            return el.querySelectorAll(sel)[0] || null;
          },
          focus() {
            el.focused = true;
          },
          setSelectionRange() {},
        };
        Object.defineProperty(el, "id", {
          get() {
            return el._id;
          },
          set(v) {
            el._id = v;
            if (v) byId[v] = el;
          },
        });
        return el;
      }
      const doc = {
        body: null,
        createElement: (t) => mkEl(t),
        getElementById: (id) => byId[id] || null,
        activeElement: null,
      };
      doc.body = mkEl("body");
      return doc;
    }
    const allByClass = (el, cls, out) => {
      out = out || [];
      if (String(el.className || "").split(/\s+/).indexOf(cls) >= 0) out.push(el);
      for (const c of el.children || []) allByClass(c, cls, out);
      return out;
    };
    /* 卡片在不在浮窗里（沿 parent 链找，别只看直接子节点：卡片挂在 .ix-body 下） */
    const inPanel = (panel, card) => {
      if (!panel || !card) return false;
      let cur = card.parent;
      while (cur) {
        if (cur === panel) return true;
        cur = cur.parent;
      }
      return false;
    };
    /* 这张卡确实收口了：从 activeIx 里摘掉 **且** 屏上不再有它
       （最后一张卡撤掉时整只浮窗被 remove —— 卡随窗一起走，同样算收口） */
    const cardGone = (r) =>
      r.ctx.S.activeIx.items.every((x) => x.data.id !== r.it.data.id) &&
      (r.panel.removed === true || !inPanel(r.panel, r.card));

    /* 一次完整现场：真渲染卡 → 选中选项 → 点「回答」→ 由 replyValue 决定回执 */
    async function scenario(it, replyValue, pick) {
      const doc = mkDom();
      const calls = [];
      const toasts = [];
      const session = { id: "s1", messages: [] };
      const ctx = {
        console: { log() {}, error() {}, warn() {} },
        document: doc,
        S: { activeIx: { items: [it] }, _runCancels: { "agent:s1": { _runInst: 1 } } },
        I18n: { t: (k) => String(k) },
        window: {
          api: {
            dshInteract: (params) => {
              calls.push(params);
              return Promise.resolve(replyValue);
            },
          },
          BrowserAct: { reload: () => {} },
        },
        toast: (msg, kind) => toasts.push([String(msg), String(kind || "")]),
        dshRunUserMark: () => {},
        agentSessionById: (id) => (String(id) === "s1" ? session : null),
        $: (sel) => (sel === "#ixPanel" ? doc.getElementById("ixPanel") : null),
        ixMakeDraggable: () => {},
        ixRestorePos: () => {},
        renderMarkdown: (s) => "<p>" + String(s) + "</p>",
        escapeHtml: (t) =>
          String(t == null ? "" : t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
        ixFreshCard: false,
        ixFreshPulse: false,
        navigator: { clipboard: { writeText: () => Promise.resolve() } },
        setTimeout,
        clearTimeout,
      };
      vm.createContext(ctx);
      vm.runInContext(S0, ctx);
      vm.runInContext(S1, ctx);
      vm.runInContext(S2 + "\n;renderIxPanel();", ctx);
      const panel = doc.getElementById("ixPanel");
      const card = doc.getElementById("ixCard_" + it.data.id);
      const btns = allByClass(card, "ix-btns")[0];
      const submit = (btns.children || []).filter((b) => b.textContent === "回答")[0];
      const inputs = card.querySelectorAll("input");
      const opt = inputs.filter((i) => i.value === pick)[0];
      if (opt) opt.checked = true;
      if (submit && submit.onclick) submit.onclick();
      await new Promise((r) => setTimeout(r, 0));
      return { doc, panel, card, submit, calls, toasts, session, it, inputs, ctx };
    }

    const helpItem = () => ({
      kind: "browser-help",
      runKey: "agent:s1",
      data: {
        id: "c1",
        kind: "help",
        helpKind: "login",
        title: "需要你登录 / 处理页面验证",
        message: "登录好了点回答",
        url: "https://example.com/login",
        sessionId: "session-1",
        questions: [{ id: "q1", question: "登录好了吗？", options: [{ label: "好了" }, { label: "还没" }] }],
      },
    });
    const good = await scenario(helpItem(), { ok: true }, "好了");
    ok(!!good.submit, "求助卡上渲染出「回答」键（真 renderIxPanel）");
    ok(
      good.calls.length === 1 &&
        good.calls[0].kind === "browser" &&
        good.calls[0].id === "c1" &&
        JSON.stringify(good.calls[0].answers) === JSON.stringify([{ id: "q1", selected: ["好了"] }]),
      "点一下就发出一帧 kind:'browser' + answers[]（求助卡走求助通道）",
    );
    ok(
      good.it && good.calls.length === 1 && good.session.messages.length === 1 &&
        good.session.messages[0]._src === "ix-answer",
      "回执 ok → 回答落进会话消息（进上下文 + 界面留痕）",
    );
    ok(
      good.calls.length === 1 && !good.toasts.some(([m]) => /回答失败|提交失败/.test(m)),
      "回执 ok 的那条路上**没有红字失败提示**（旧 bug 会弹「回答失败」）：" +
        JSON.stringify(good.toasts),
    );
    ok(
      good.ctx && good.ctx.S.activeIx.items.length === 0,
      "面板里这一张卡已从 activeIx 里摘掉（不是只藏了 DOM）",
    );
    ok(cardGone(good), "这一张卡当场收口（从 activeIx 摘掉 + 屏上不再有它）");
    ok(good.panel && good.panel.removed === true, "它是最后一张卡 → 整只「🐋 模型等待你的回应」浮窗自己收起（#ixPanel 被 remove）");

    /* 失败态：回执 ok:false → 卡片收口 + 红字提示（与旧口径一致，不能因为这次修而变哑） */
    const bad = await scenario(helpItem(), { ok: false, error: "回执送不到" }, "还没");
    ok(
      bad.calls.length === 1 && bad.toasts.some(([m]) => /回答失败/.test(m)),
      "回执失败 → 卡片收口并如实报错（toasts=" + JSON.stringify(bad.toasts) + " calls=" + bad.calls.length + "）",
    );
    ok(cardGone(bad), "失败态同样不把死卡留在屏上");

    /* stale 态：发起轮已结束 → 卡转「这一轮已经结束」留住（回答不丢，可当新消息重发） */
    const staleIt = helpItem();
    const st = await scenario(staleIt, { ok: true, stale: true }, "好了");
    const stCard = st.doc.getElementById("ixCard_c1");
    ok(
      st.it && st.it.ended === true && !!stCard && stCard.removed !== true && inPanel(st.panel, stCard),
      "stale → 卡片转「这一轮已经结束」态**留住**（ended=" + String(st.it && st.it.ended) + "）",
    );
    ok(
      st.session.messages.length === 1 && st.session.messages[0]._src === "ix-round-end",
      "stale → 会话里落一行可复核的痕迹（" + JSON.stringify(st.session.messages.map((m) => m._src)) + "）",
    );
  }

  console.log("\n" + (fails ? "FAILED " + fails + " / " + checks + " checks" : "ALL OK  " + checks + " checks"));
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error("smoke-ask-reply 崩了：" + ((e && e.stack) || e));
  process.exit(1);
});
