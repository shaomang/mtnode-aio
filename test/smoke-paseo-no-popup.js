"use strict";
/* test/smoke-paseo-no-popup.js — 手机端（Paseo）会话**不开询问卡**的回归
 * ============================================================================
 * 运行：node test/smoke-paseo-no-popup.js
 *
 * 现场（用户报的「手机上会话时弹窗卡住」）：用手机 Paseo 接管一条会话时，模型一问话
 * 就在电脑上开一张询问卡（「🐋 模型等待你的回应」），而 **Paseo 没有关掉 MTNode 界面上
 * 那张卡的能力** —— 卡就一直挂着、还挡在眼前。
 *
 * 已与用户确认的口径：认「这条会话正被手机端驱动」为判据 —— 那条通道走的正是 Paseo 桥
 * 自己开的观察（`session/watch`），凡是被它登记过的会话，**电脑侧不再开询问卡**，改在
 * 会话里落一行可读痕迹。手机侧本来就是纯文字（paseo/acp-bridge.mjs 的 questionChatText，
 * 手机回一条消息即答案 → 桥按题 id 对齐成 answers[] 打回 session/approval），这条链与
 * 「电脑上有没有开卡」无关，所以不开卡不会让模型收不到答案。
 *
 * 覆盖：
 *   [1] 静态接线：桥登记「被手机驱动」的会话 + 两半之间的口（isRemoteDriven / 撤卡钩子）
 *   [2] 真跑：vm 里加载 renderer/app-session-bridge.js，喂一次 session/watch →
 *       onRunEvent 推 question 帧，断言「手机驱动名单」里有这条会话
 *   [3] 真跑：假 DOM + vm 跑 app-db.js 询问窗那一段（真源码，不重写逻辑）——
 *       未被手机驱动的会话照旧开卡；被手机驱动的会话**不开卡**，只落一行痕迹；
 *       卡已在屏上时「变成被手机驱动」当场撤卡
 * 只跑本机 Node + 假 DOM：不拉浏览器、不碰 Electron、不改任何文件。
 * ============================================================================
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

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
function has(src, needle, msg) {
  ok(String(src).indexOf(needle) >= 0, msg + " · 源码含 " + JSON.stringify(String(needle).slice(0, 56)));
}

const ROOT = path.join(__dirname, "..");
const read = (rel) =>
  fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8").replace(/\r\n/g, "\n");

const DB = read("renderer/app-db.js");
const BRIDGE = read("renderer/app-session-bridge.js");

/* ════════════════════════════════════════════════════════════════════════════
   [1] 静态接线
   ════════════════════════════════════════════════════════════════════════════ */
console.log("[1] 静态接线：两半之间的口 + 判据同源");
{
  has(BRIDGE, "const remoteDriven = new Set();", "会话桥有「被手机端驱动」的会话名单");
  has(BRIDGE, "remoteDriven.add(sid);", "session/watch 时登记这条会话（Paseo 桥就是用这条口看会话的）");
  has(
    BRIDGE,
    "isRemoteDriven: (sid) =>",
    "会话桥对外给一个 isRemoteDriven(sid) 判据（app-db 的帧处理按它决定开不开卡）",
  );
  has(
    BRIDGE,
    "window.ixDropQuestionCardsOf",
    "会话变成被手机驱动时顺手收掉已经开着的询问卡（晚到一拍的死卡）",
  );
  has(DB, "function ixRemoteDriven(runKey) {", "app-db 有「这一轮是不是被手机端驱动」的判据");
  has(DB, "function ixRemoteAskKind(kind) {", "只有询问类卡（提问 / 浏览器求助卡）走这条口径，审批卡不动");
  has(DB, "function ixDropQuestionCardsOf(sessionId) {", "app-db 提供撤销该会话询问卡的入口");
  has(DB, "window.ixDropQuestionCardsOf = ixDropQuestionCardsOf;", "显式挂在 window 上（不靠加载顺序的偶然）");
  /* ixPush 必须在**开卡之前**就分流：放在后面等于卡已经进了 items 再撤，等于还是弹了一下 */
  const ixPush = DB.slice(DB.indexOf("function ixPush(kind, data, runKey, src) {"));
  const gate = ixPush.indexOf("ixRemoteAskKind(kind) && ixRemoteDriven(runKey)");
  const push = ixPush.indexOf("S.activeIx.items.push({");
  ok(gate > 0 && push > gate, "ixPush 在 items.push 之前就分流（不是先开卡再撤卡）");
  has(DB, "ixRemoteAskTrace(", "被手机驱动的会话：这一问改落一行可读痕迹（谁也白等不了）");
  has(DB, "ixRemoteAnswerNote()", "痕迹里写清「怎么答、答案落哪」");
  ok(
    DB.indexOf("模型在问你一件事") > 0 && DB.indexOf("会话在等你处理浏览器上的事") > 0,
    "提问与浏览器求助卡两种痕迹各有一句人话",
  );
  const i18n = read("renderer/i18n.js");
  for (const s of [
    "📱 {what}{title}：这条会话正被手机端接管，电脑上不再弹出询问卡 —— 题面与选项以纯文字发到手机上。",
    "📱 这条会话已由手机端接管：上面那张询问卡已撤，题面会以纯文字发到手机上作答。",
    "（这条会话正被手机端接管：提问与选项以纯文字发到手机上，在手机输入框里回一条消息即为答案，会落回这条会话。）",
  ]) {
    const k = i18n.indexOf(s);
    ok(k > 0 && /"\s*:/.test(i18n.slice(k + s.length, k + s.length + 12)), "i18n 有这条文案的英文词条（en 下不留中文）");
  }
  ok(
    !/kind: "question"[\s\S]{0,200}request_permission|request_permission[\s\S]{0,200}kind: "question"/.test(BRIDGE),
    "桥那一侧不被这条改动牵连（提问仍是纯文字消息，不发 kind:question 的权限卡）",
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   [2] 真跑：session/watch → 这条会话进「被手机端驱动」名单
   ════════════════════════════════════════════════════════════════════════════ */
console.log("[2] 真跑：renderer/app-session-bridge.js（session/watch → onRunEvent）");
const PROBE = { bridge: null, pushes: [] };
/* async IIFE：会话桥的帧入口是 async（回执是 Promise），这一段必须 await 才拿得到回执 */
(async () => {
  try {
    const pushes = [];
    const sandbox = {
      window: { api: { mcpSessionEvent: (ev) => pushes.push(ev) } },
      console,
    };
    vm.runInNewContext(BRIDGE, sandbox, { filename: "renderer/app-session-bridge.js" });
    const S = sandbox.window.MTNodeSession;
    ok(!!S && typeof S.onRunEvent === "function", "渲染层那一半在沙箱里跑起来了（window.MTNodeSession）");
    const SID = "asSmokeNoPopup1";
    ok(S.isRemoteDriven(SID) === false, "还没人看这条会话 → 不是手机驱动（电脑侧照旧开卡）");
    const r = await S.handleFrame({ op: "sessionWatch", params: { sessionId: SID, on: true } });
    ok(r && r.ok === true && r.watching === true, "session/watch 成功（手机端开始看这条会话）");
    ok(S.isRemoteDriven(SID) === true, "这条会话进「被手机端驱动」名单（电脑侧从此不开询问卡）");
    ok(
      !!r && Array.isArray(r.remoteDriven) && r.remoteDriven.indexOf(SID) >= 0,
      "回执里带回名单（控制台 / 冒烟一眼看得出哪条会话被手机驱动）",
    );
    const q = {
      id: "ask-nopopup-1",
      kind: "question",
      questions: [{ id: "q1", question: "选哪个？", options: [{ label: "A" }, { label: "B" }] }],
    };
    pushes.length = 0;
    const pushed = S.onRunEvent("agent:" + SID, "question", q, "req-nopopup-1");
    ok(pushed === true, "question 帧照旧推给主进程 → SSE（手机上仍然收到那条可读消息）");
    const frame = pushes.filter((x) => x.type === "question").pop() || null;
    ok(
      !!frame && frame.data && frame.data.questions && frame.data.questions[0].options.length === 2,
      "手机那条消息的内容不受影响（题面与选项一字不落）",
    );
    /* 停看（手机切走）不清「被手机驱动」：整段 Paseo 会话期间电脑侧都不该开卡 */
    await S.handleFrame({ op: "sessionWatch", params: { sessionId: SID, on: false } });
    ok(S.isRemoteDriven(SID) === true, "手机关掉观察也不撤销这个判据（会话仍由手机端驱动）");
    ok(S.isRemoteDriven("asOther") === false, "别的会话不受影响（只认被看过的那条）");
    PROBE.bridge = sandbox;
    PROBE.pushes = pushes;
  } catch (e) {
    ok(false, "[2] 抛异常：" + ((e && e.message) || e));
  }

  /* ══════════════════════════════════════════════════════════════════════════
     [3] 真跑：假 DOM + app-db.js 询问窗那一段
     ══════════════════════════════════════════════════════════════════════════ */

  /* app-db.js 里「询问窗」那一段（ixReset → renderIxPanel 之前）：
     与 smoke-ask-keep-input.js 同一手法 —— 抠真源码跑，绝不在这里重写一份实现。 */
  const DB_SLICE = (() => {
    const at = (m) => DB.indexOf(m);
    const a = at("/* 「稍后（终止本轮）」出口");
    const b = at("function renderIxPanel() {");
    if (a < 0 || b < 0 || b <= a) return "";
    return DB.slice(a, b);
  })();
  ok(!!DB_SLICE, "抠到 app-db.js 的询问窗整段（ixReset → renderIxPanel 之前）");
  ok(
    DB_SLICE.indexOf("function ixPush(kind, data, runKey, src) {") > 0 &&
      DB_SLICE.indexOf("function ixDropQuestionCardsOf(sessionId) {") > 0,
    "抠出来的片段里同时有 ixPush 与 ixDropQuestionCardsOf",
  );

  function mkCtx(extra) {
    /* 痕迹落在**会话消息**里（ixRoundEndTrace → st.messages），所以给一条假会话：
       断言直接读它写进去的正文，与真跑时用户看到的那行字同源。 */
    const sess = { id: "asSmokeNoPopup1", messages: [] };
    const sandbox = {
      console: { log() {}, error() {} },
      S: { activeIx: { items: [] }, _runCancels: {} },
      I18n: {
        t: (k, vars) => {
          let s = String(k);
          if (vars && typeof vars === "object")
            s = s.replace(/\{(\w+)\}/g, (_, n) => (vars[n] == null ? "" : String(vars[n])));
          return s;
        },
      },
      window: {},
      /* 询问窗那段只用到 document.getElementById("ixPanel") 探一下「窗在不在屏上」 */
      document: { getElementById: () => null },
      ixFreshCard: false,
      ixFreshPulse: false,
      renderIxPanel: () => {},
      playIxSound: () => {},
      toast: () => {},
      agentSessionById: (id) => (String(id) === sess.id ? sess : null),
      agentTouchSession: () => {},
      ixDraftDropCard: () => {},
      __sess: sess,
    };
    Object.assign(sandbox, extra || {});
    const ctx = vm.createContext(sandbox);
    vm.runInContext(DB_SLICE, ctx, { filename: "app-db.js#ixWindow" });
    return sandbox;
  }
  /** 假会话里最近那行痕迹的正文（痕迹写进 st.messages 的 content） */
  function traceOf(s) {
    const list = (s.__sess && s.__sess.messages) || [];
    const m = list[list.length - 1];
    return m ? String(m.content || "") : "";
  }
  const Q = (id) => ({
    id,
    kind: "question",
    questions: [{ id: "q1", question: "选哪个？", options: [{ label: "A" }, { label: "B" }] }],
  });
  const RUN = "agent:asSmokeNoPopup1";
  const pushQ = (s, cardId, runKey) =>
    vm.runInContext(
      "ixPush('question', " + JSON.stringify(Q(cardId)) + ", " + JSON.stringify(runKey || RUN) + ", null);",
      s,
    );

  console.log("\n[3a] 电脑上自己的会话：照旧开卡（这条口径不许误伤）");
  {
    const s = mkCtx();
    s.S._runCancels[RUN] = { cancelTag: RUN };
    pushQ(s, "ask-a");
    ok(s.S.activeIx.items.length === 1, "普通会话（没人用手机看）：询问卡照旧进面板");
    ok(s.S.activeIx.items[0].kind === "question", "面板里那张就是提问卡");
  }

  console.log("\n[3b] 被手机端驱动的会话：不开卡，只落一行痕迹");
  {
    const s = mkCtx({
      window: { MTNodeSession: { isRemoteDriven: (sid) => String(sid) === "asSmokeNoPopup1" } },
    });
    s.S._runCancels[RUN] = { cancelTag: RUN };
    pushQ(s, "ask-b");
    ok(s.S.activeIx.items.length === 0, "被手机驱动：询问卡**不进面板**（电脑上不再弹窗）");
    const box = traceOf(s);
    ok(!!box, "改落一行可读痕迹（不是一声不响地丢掉）");
    ok(/手机端接管/.test(box), "痕迹写明「这条会话正被手机端接管」");
    ok(/纯文字|输入框/.test(box), "痕迹写明题面走纯文字、在手机输入框里回一条消息即答案");
    ok(/模型在问你一件事/.test(box), "痕迹带一句人话抬头（提问这一类）");
    /* 审批卡不在这条口径里：它另有手机侧权限卡通道（本轮不动它） */
    vm.runInContext(
      "ixPush('approval', { id: 'ap-b', title: '写文件', kind: 'approval' }, " + JSON.stringify(RUN) + ", null);",
      s,
    );
    ok(
      s.S.activeIx.items.length === 1 && s.S.activeIx.items[0].kind === "approval",
      "审批卡照旧照开（只收询问类卡）",
    );
  }

  console.log("\n[3c] 卡已在屏上时「变成被手机驱动」：当场撤卡（晚到一拍的死卡）");
  {
    const reg = new Set();
    const s = mkCtx({ window: { __mtnodeRemoteDriven: reg } });
    s.S._runCancels[RUN] = { cancelTag: RUN };
    pushQ(s, "ask-c");
    ok(s.S.activeIx.items.length === 1, "先说好：这张卡本来开出来了（手机还没连上那一拍）");
    /* 手机连上：会话桥调这个口 → 卡当场撤，并在会话里留痕 */
    reg.add("asSmokeNoPopup1");
    const n = vm.runInContext("ixDropQuestionCardsOf('asSmokeNoPopup1');", s);
    ok(n === 1, "撤销口回报撤掉了 1 张（app-session-bridge.js 的 sessionWatch 调的就是它）");
    ok(s.S.activeIx.items.length === 0, "屏上那张询问卡没了（不再挡在眼前）");
    const box = traceOf(s);
    ok(/已由手机端接管/.test(box), "会话里留了一行「已由手机端接管 / 卡已撤」的痕迹");
    /* 别的会话的卡不许被顺手撤掉 */
    const s2 = mkCtx({ window: { __mtnodeRemoteDriven: new Set(["asOther"]) } });
    s2.S._runCancels[RUN] = { cancelTag: RUN };
    pushQ(s2, "ask-d");
    const n2 = vm.runInContext("ixDropQuestionCardsOf('asOther');", s2);
    ok(n2 === 0 && s2.S.activeIx.items.length === 1, "撤卡只撤那条会话自己的（别的会话的卡照旧在）");
  }

  console.log(
    "\n" +
      (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ 全部 " + checks + " 项通过") +
      "  (smoke-paseo-no-popup)",
  );
  process.exit(fails ? 1 : 0);
})();
