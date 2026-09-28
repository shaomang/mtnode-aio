"use strict";
/* 一人公司 / 专家团 —— 圆桌「选人 + 并行作答」—— 冒烟测试（纯 Node，无 Electron / 最小 DOM 桩）
 *   node test/smoke-team-round.js
 * 需求：圆桌一轮 = 先选人（绝不全员、@ 定向优先）→ 参与者并行独立 run（各自 runKey）→
 *       按参与人顺序回收 → 一轮结束自动请主持人汇总；单个专家失败不拖垮整轮；
 *       终止一次取消本轮全部 runKey。
 * 覆盖：
 *   [1] 选人上限与「不全员」约束：2–6 位、候选 ≥3 时至少排除 1 位、去重 / 忽略未知 id / 保序
 *   [2] 专家数 < 3 的兜底：候选不足 3 位时全部参与，不跑主持人选人
 *   [3] @提及只唤起被 @ 者（跳过主持人选人，不受 2–6 人数约束）
 *   [4] 选人 JSON：解析成功走 host（姓名 → id，理由透传）；解析失败 / 无 JSON 走本地相关性回退
 *   [5] 并行性：两个专家 run 同时 in-flight，结果按参与者顺序回收（完成顺序 = onMessage 顺序）
 *   [6] 单个专家失败只写进他这条消息，不影响其余
 *   [7] 终止一次取消本轮全部 runKey（activeRunKeys / resolveRunKey 反查）
 *   [8] 一轮结束后自动触发主持人汇总（无发言 / 用户终止则不汇总）
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

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
const ROOT = path.join(__dirname, "..");
const read = (rel) =>
  fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");

/* 最小 DOM 桩：只有 renderTeamPane / teamViewRenderMsgs 会用到 getElementById，
   全部返回 null 让它们快速返回；createElement 给 teamViewEl 用。 */
function fakeEl(tag) {
  const cls = new Set();
  const e = {
    tagName: tag,
    className: "",
    textContent: "",
    style: {},
    children: [],
    options: [],
    value: "",
    _html: "",
    _ev: {},
    hidden: false,
    appendChild(c) {
      this.children.push(c);
      return c;
    },
    setAttribute() {},
    removeAttribute() {},
    addEventListener(t, fn) {
      (this._ev[t] || (this._ev[t] = [])).push(fn);
    },
    removeEventListener() {},
    classList: {
      contains: (c) => cls.has(c),
      add(c) {
        cls.add(c);
      },
      remove(c) {
        cls.delete(c);
      },
      toggle(c, on) {
        const v = on === undefined ? !cls.has(c) : !!on;
        if (v) cls.add(c);
        else cls.delete(c);
        return v;
      },
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    insertBefore(c) {
      this.children.unshift(c);
      return c;
    },
  };
  Object.defineProperty(e, "innerHTML", {
    get() {
      return this._html;
    },
    set(v) {
      this._html = String(v);
      this.children.length = 0;
    },
  });
  return e;
}

/* ═══════════ 沙箱：icons → team（真）→ teamview（真），窗口即全局 ═══════════ */
function loadAll() {
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.console = console;
  sandbox.I18n = {
    t: (s, vars) => {
      let out = String(s);
      if (vars && typeof vars === "object")
        out = out.replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? "" : String(vars[k])));
      return out;
    },
  };
  const els = {};
  sandbox.document = {
    createElement: (t) => fakeEl(t),
    getElementById: (id) => els[id] || null,
  };
  sandbox.__testEls = els;
  sandbox.api = { configSave: () => Promise.resolve() };
  sandbox.toast = () => {};
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  sandbox.cancelAnimationFrame = (id) => clearTimeout(id);
  sandbox.AGENT_PRESETS = ["minimal", "standard", "lean", "code", "cordis"].map((id) => ({ id }));
  sandbox.AGENT_PRESET_DEFAULT = "minimal";
  sandbox.AGENT_PRESET_LEGACY_IDS = {};
  sandbox.normalizeAgentEffort = (v) => {
    const s = String(v == null ? "" : v).trim();
    return ["low", "medium", "high", "xhigh", "max"].indexOf(s) >= 0 ? s : "high";
  };
  sandbox.permissionPresetOptions = () =>
    ["mtnode-unattended", "workspace-write", "read-only", "danger-full-access"].map((id) => [id, id]);
  const S = { config: {}, wf: { id: "wf-round", name: "圆桌画布" } };
  sandbox.S = S;
  vm.createContext(sandbox);
  vm.runInContext(read("renderer/app-team-icons.js"), sandbox, { filename: "app-team-icons.js" });
  vm.runInContext(read("renderer/app-team.js"), sandbox, { filename: "app-team.js" });
  vm.runInContext(read("renderer/app-teamview.js"), sandbox, { filename: "app-teamview.js" });
  return { sandbox, S, team: sandbox.MTNodeTeam };
}

let env = null;
let loadErr = null;
try {
  env = loadAll();
} catch (e) {
  loadErr = e;
}
ok(!loadErr, "app-team.js + app-teamview.js 顶层加载不抛错" + (loadErr ? "（" + loadErr.message + "）" : ""));
const { sandbox, S, team: T } = env || {};
ok(!!T && typeof T.runGroupRound === "function", "暴露 window.MTNodeTeam.runGroupRound");
ok(typeof sandbox.teamGroupRun === "function", "暴露 window.teamGroupRun（团队视图群聊入口）");

T.ensure(S.config);
const CANVAS = "wf-round";
T.ensureCanvas({ id: CANVAS, name: "圆桌画布" });

/* 四位候选专家：主持人 + 财务（与「现金流 / 预算」问题相关）+ 工程 + 设计。 */
const E1 = T.addExpert({ canvasId: CANVAS, name: "甲", role: "主持人", icon: "cat", persona: { expertise: ["主持", "议程"] } });
const E2 = T.addExpert({ canvasId: CANVAS, name: "乙", role: "财务", icon: "cat", persona: { expertise: ["现金流", "预算"] } });
const E3 = T.addExpert({ canvasId: CANVAS, name: "丙", role: "工程", icon: "cat", persona: { expertise: ["架构", "稳定性"] } });
const E4 = T.addExpert({ canvasId: CANVAS, name: "丁", role: "设计", icon: "cat", persona: { expertise: ["界面", "可用性"] } });
const FOUR = [E1, E2, E3, E4];

function groupOf(exps, facId) {
  return T.addGroupChat({
    canvasId: CANVAS,
    participants: exps.map((e) => e.id),
    facilitatorId: facId || (exps[0] && exps[0].id) || "",
    title: "圆桌讨论",
  });
}
const idsOf = (list) => (list || []).map((e) => e.id);

async function waitFor(cond, ms = 2000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 0));
  }
}

/* ===================== [1] 选人上限与「不全员」约束 ===================== */
console.log("\n[1] 选人上限与「不全员」约束（clampParticipants / 常量）");
{
  ok(T.GROUP_MIN_PARTICIPANTS === 2, "最少参与人 = 2");
  ok(T.GROUP_MAX_PARTICIPANTS === 6, "最多参与人 = 6");

  const allIds = idsOf(FOUR);
  const all = T.clampParticipants(FOUR, allIds, "随便问点什么");
  ok(all.length < FOUR.length, "候选 4 位、点名全员 → 至少排除 1 位（不全员）");
  ok(all.length <= T.GROUP_MAX_PARTICIPANTS, "结果不超过上限 6 位");
  ok(idsOf(all).every((id) => allIds.indexOf(id) >= 0), "结果全部来自候选");
  ok(
    idsOf(all).every((id, i, a) => i === 0 || allIds.indexOf(a[i - 1]) < allIds.indexOf(id)),
    "输出顺序 = 候选原始顺序",
  );

  const one = T.clampParticipants(FOUR, [E1.id], "随便问点什么");
  ok(one.length === T.GROUP_MIN_PARTICIPANTS, "只点名 1 位 → 补齐到下限 2 位");

  const dup = T.clampParticipants(FOUR, [E1.id, E1.id, "不存在的 id"], "随便问点什么");
  ok(idsOf(dup).length === new Set(idsOf(dup)).size, "重复 id 去重");
  ok(idsOf(dup).every((id) => allIds.indexOf(id) >= 0), "未知 id 被忽略");

  const eight = FOUR.concat([
    T.addExpert({ canvasId: CANVAS, name: "戊", role: "法务", icon: "cat" }),
    T.addExpert({ canvasId: CANVAS, name: "己", role: "运维", icon: "cat" }),
    T.addExpert({ canvasId: CANVAS, name: "庚", role: "增长", icon: "cat" }),
    T.addExpert({ canvasId: CANVAS, name: "辛", role: "内容", icon: "cat" }),
  ]);
  const capped = T.clampParticipants(eight, idsOf(eight), "随便问点什么");
  ok(capped.length === T.GROUP_MAX_PARTICIPANTS, "8 位候选点名全员 → 夹到上限 6 位");
  ok(capped.length < eight.length, "8 位候选仍不全员");

  ok(T.clampParticipants([], [], "x").length === 0, "空候选返回空");

  const three = [E1, E2, E3];
  ok(
    T.clampParticipants(three, idsOf(three), "x").length === 2,
    "候选恰好 3 位点名全员 → 只留 2 位",
  );
}

/* ===================== [2] 专家数 < 3 的兜底 ===================== */
console.log("\n[2] 专家数 < 3：没有可裁余地，全部参与且不跑主持人选人");
(async function () {
  /* 只放 2 位专家的画布：候选不足 3 位 → 无裁量空间。 */
  const TWO = "wf-two";
  T.addExpert({ canvasId: TWO, name: "双甲", role: "主持人", icon: "cat" });
  const b2 = T.addExpert({ canvasId: TWO, name: "双乙", role: "工程", icon: "cat" });
  const chat2 = T.addGroupChat({ canvasId: TWO, participants: [], title: "圆桌讨论" });
  let runCalls = 0;
  sandbox.dshRunTask = () => {
    runCalls++;
    return Promise.resolve("不该被调用");
  };
  const sel2 = await T.selectParticipants(chat2, "帮我看看架构");
  ok(sel2.participants.length === 2, "2 位专家全部参与（候选不足 3 位兜底）");
  ok(sel2.mode === "local", "兜底走本地口径（mode=local）");
  ok(runCalls === 0, "候选不足 3 位不发起主持人选人 run");
  ok(!!sel2.reason, "兜底给出一句理由");
  void b2;

  const ONE = "wf-one";
  T.addExpert({ canvasId: ONE, name: "独苗", role: "主持人", icon: "cat" });
  const chat1 = T.addGroupChat({ canvasId: ONE, participants: [], title: "圆桌讨论" });
  const sel1 = await T.selectParticipants(chat1, "随便问");
  ok(sel1.participants.length === 1, "只有 1 位专家时也全部参与（最小可运行）");
  delete sandbox.dshRunTask;

  /* ===================== [3] @提及只唤起被 @ 者 ===================== */
  console.log("\n[3] @提及只唤起被 @ 者（跳过选人，不受 2–6 人数约束）");
  const chat = groupOf(FOUR, E1.id);
  const mentions = T.parseMentions("@乙 你怎么看这件事？", chat);
  ok(mentions.length === 1 && mentions[0] === E2.id, "parseMentions 只命中被 @ 的专家");

  let selRunCalls = 0;
  sandbox.dshRunTask = () => {
    selRunCalls++;
    return Promise.resolve("不该被调用");
  };
  const selM = await T.selectParticipants(chat, "@乙 你怎么看这件事？");
  ok(selM.mode === "mention", "@ 命中时 mode=mention（跳过主持人选人）");
  ok(selM.participants.length === 1 && selM.participants[0].id === E2.id, "只由被 @ 的专家参与");
  ok(selRunCalls === 0, "@ 定向不发起主持人选人 run");
  delete sandbox.dshRunTask;

  /* ===================== [4] 选人 JSON：成功走 host / 失败走本地 ===================== */
  console.log("\n[4] 选人 JSON：解析成功走 host；解析失败走本地相关性回退");
  const Q = "现金流 预算 的风险怎么看？";

  sandbox.dshRunTask = () =>
    Promise.resolve('```json\n{"participants":["乙","丙"],"reason":"现金流与落地各一位"}\n```');
  const selH = await T.selectParticipants(chat, Q);
  ok(selH.mode === "host", "合法选人 JSON → mode=host");
  ok(
    selH.ids.length === 2 && selH.ids[0] === E2.id && selH.ids[1] === E3.id,
    "按姓名逐字命中并落成专家 id（保候选顺序）",
  );
  ok(selH.reason.indexOf("现金流") >= 0, "主持人理由透传");

  sandbox.dshRunTask = () => Promise.resolve("抱歉，我不确定该让谁发言。");
  const selL = await T.selectParticipants(chat, Q);
  ok(selL.mode === "local", "选人 JSON 解析失败 → mode=local 回退");
  ok(selL.participants.length < FOUR.length, "本地回退同样不全员");
  ok(selL.participants.length >= T.GROUP_MIN_PARTICIPANTS, "本地回退不低于下限 2 位");
  ok(
    selL.ids.indexOf(E2.id) >= 0,
    "本地相关性打分把与问题相关的专家（乙 / 现金流）排进本轮",
  );
  ok(selL.reason.indexOf("相关性") >= 0, "本地回退理由说明按相关性选人");

  sandbox.dshRunTask = () =>
    Promise.resolve('{"participants":["没有这个人"],"reason":"x"}');
  const selNone = await T.selectParticipants(chat, Q);
  ok(selNone.mode === "local", "选人 JSON 里没有任何命中姓名 → 视为失败，走本地回退");
  delete sandbox.dshRunTask;

  /* ===================== [5] 并行性 ===================== */
  console.log("\n[5] 并行性：多位专家同时 in-flight，结果按参与者顺序回收");
  const chatP = groupOf(FOUR, E1.id);
  let inflight = 0;
  let maxInflight = 0;
  let peak = 0;
  const gates = {};
  sandbox.dshRunTask = (input, opts) => {
    const expId = String((opts && opts.runKey) || "").split(":")[2];
    inflight++;
    peak++;
    maxInflight = Math.max(maxInflight, inflight);
    return new Promise((resolve) => {
      gates[expId] = () => {
        inflight--;
        resolve("回复-" + expId);
      };
    });
  };
  const orderOnMsg = [];
  const roundP = T.runGroupRound({
    chat: chatP,
    text: "@乙 @丙 请各自表态",
    round: 1,
    onMessage: (m) => orderOnMsg.push(m.expertId),
  });
  await waitFor(() => Object.keys(gates).length === 2);
  ok(maxInflight === 2, "两位专家的 run 同时处于 in-flight（并行，非串行）");
  ok(peak === 2, "本轮只起跑本轮参与者（2 位）");
  /* 后起的先完成：验证回收顺序不跟着完成快慢漂。 */
  gates[E3.id]();
  await new Promise((r) => setTimeout(r, 0));
  gates[E2.id]();
  const resP = await roundP;
  ok(
    resP.messages.length === 2 && resP.messages[0].expertId === E2.id && resP.messages[1].expertId === E3.id,
    "结果按参与者顺序回收（乙 → 丙，尽管丙先完成）",
  );
  ok(resP.messages[0].content === "回复-" + E2.id && resP.messages[1].content === "回复-" + E3.id, "每路内容正确对应各自的 run");
  ok(
    orderOnMsg.length === 2 && orderOnMsg[0] === E3.id && orderOnMsg[1] === E2.id,
    "onMessage 按完成顺序回调（丙先完成先回），与落库顺序解耦",
  );
  const lp = T.lastRoundOf(T.chat(chatP.id));
  ok(!!lp && lp.mode === "mention" && lp.ids.length === 2, "本轮参与人与选人理由落库（lastParticipants）");
  ok(lp.ids[0] === E2.id && lp.ids[1] === E3.id, "落库顺序 = 参与人顺序");
  delete sandbox.dshRunTask;

  /* ===================== [6] 单个专家失败不影响其余 ===================== */
  console.log("\n[6] 单个专家失败只写进他这条消息，不影响其余");
  const chatF = groupOf(FOUR, E1.id);
  sandbox.dshRunTask = (input, opts) => {
    const expId = String((opts && opts.runKey) || "").split(":")[2];
    if (expId === E2.id) return Promise.reject(new Error("乙这边炸了"));
    return Promise.resolve("丙的正常回复");
  };
  let threw = false;
  let resF = null;
  try {
    resF = await T.runGroupRound({ chat: chatF, text: "@乙 @丙 请各自表态", round: 1 });
  } catch (e) {
    threw = true;
  }
  ok(!threw, "单个专家失败不拖垮整轮（runGroupRound 不抛错）");
  ok(!!resF && resF.messages.length === 2, "另一位专家的结果照常回收（2 条）");
  const mFail = resF.messages.find((m) => m.expertId === E2.id);
  const mOk = resF.messages.find((m) => m.expertId === E3.id);
  ok(!!mFail && !!mFail.error && mFail.content === "", "失败者的消息带 error、content 为空");
  ok(!!mOk && mOk.content === "丙的正常回复" && !mOk.error, "未失败者内容完整、无 error");
  delete sandbox.dshRunTask;

  /* ===================== [7] 终止一次取消本轮全部 runKey ===================== */
  console.log("\n[7] 终止一次取消本轮全部 runKey");
  const chatS = groupOf(FOUR, E1.id);
  const gates2 = {};
  sandbox.dshRunTask = (input, opts) => {
    const expId = String((opts && opts.runKey) || "").split(":")[2];
    return new Promise((resolve) => {
      gates2[expId] = () => resolve("回复-" + expId);
    });
  };
  const roundS = T.runGroupRound({ chat: chatS, text: "@乙 @丙 请各自表态", round: 1 });
  await waitFor(() => Object.keys(gates2).length === 2);
  const active = T.activeRunKeys(chatS.id);
  ok(active.length === 2, "本轮有 2 路在跑的 runKey");
  ok(
    active.indexOf(T.runKeyOf(chatS.id, E2.id)) >= 0 && active.indexOf(T.runKeyOf(chatS.id, E3.id)) >= 0,
    "runKey = team:<chatId>:<expertId>，按专家隔离",
  );
  const cancelled = [];
  sandbox.dshCancelActive = (k) => cancelled.push(k);
  T.stopExpert("team:" + chatS.id);
  ok(cancelled.length === 2, "终止会话级 runKey → 一次取消本轮全部在跑的 runKey");
  ok(cancelled.indexOf(T.runKeyOf(chatS.id, E2.id)) >= 0 && cancelled.indexOf(T.runKeyOf(chatS.id, E3.id)) >= 0, "两位专家都被取消（不再只停第一位）");
  const resolved = T.resolveRunKey("team:" + chatS.id);
  ok(active.indexOf(resolved) >= 0, "resolveRunKey 能反查该会话正在跑的 runKey");
  /* 放行未决 run，收尾不留下悬挂 Promise。 */
  Object.keys(gates2).forEach((k) => gates2[k]());
  await roundS;
  ok(T.activeRunKeys(chatS.id).length === 0, "本轮结束后在跑集合清空");
  delete sandbox.dshRunTask;
  delete sandbox.dshCancelActive;

  /* ===================== [8] 一轮结束自动触发主持人汇总 ===================== */
  console.log("\n[8] 一轮结束后自动请主持人汇总（无发言 / 用户终止则不汇总）");
  const TEAM = sandbox.MTNodeTeam;
  const realRunGroup = TEAM.runGroupRound;
  const realAggregate = TEAM.aggregateGroup;
  const realWriteAdvice = TEAM.writeAdviceFile;
  let aggCalls = 0;
  let rgArgs = null;
  let nextRound = null;
  TEAM.runGroupRound = async (o) => {
    rgArgs = o;
    return nextRound;
  };
  TEAM.aggregateGroup = async () => {
    aggCalls++;
    return { card: { title: "x", conclusion: "c" }, text: "card", facilitator: { id: E1.id, name: "甲" } };
  };
  TEAM.writeAdviceFile = async () => "";

  const chatA = groupOf(FOUR, E1.id);
  nextRound = {
    round: 1,
    participants: [E2.id, E3.id],
    messages: [
      { role: "assistant", content: "乙的发言", expertId: E2.id, name: "乙" },
      { role: "assistant", content: "丙的发言", expertId: E3.id, name: "丙" },
    ],
  };
  await sandbox.teamGroupRun(chatA, "请讨论现金流的风险");
  ok(aggCalls === 1, "一轮有发言结束 → 自动触发主持人汇总（aggregateGroup 调 1 次）");
  ok(!!rgArgs && rgArgs.chat && rgArgs.chat.id === chatA.id, "先跑本轮（runGroupRound 收到本会话）");
  ok(!!rgArgs && rgArgs.round === 1, "轮次 1 传入");
  ok(
    !!rgArgs && typeof rgArgs.onEvent === "function" && typeof rgArgs.shouldStop === "function",
    "传入 onEvent（并行分路）与 shouldStop（终止检查）",
  );
  const msgsA = (T.chat(chatA.id) || {}).messages || [];
  ok(msgsA.length >= 3, "本轮署名发言 + 建议卡落回会话消息流");

  /* 全员失败（无任何 content）：不汇总。 */
  const chatB = groupOf(FOUR, E1.id);
  aggCalls = 0;
  nextRound = {
    round: 1,
    messages: [
      { role: "assistant", content: "", expertId: E2.id, error: "boom" },
      { role: "assistant", content: "", expertId: E3.id, error: "boom" },
    ],
  };
  await sandbox.teamGroupRun(chatB, "全员失败的一轮");
  ok(aggCalls === 0, "全员失败（无发言）→ 不汇总");

  /* 用户中途终止：即使专家已产出，也不汇总。 */
  const chatC = groupOf(FOUR, E1.id);
  aggCalls = 0;
  TEAM.runGroupRound = async (o) => {
    rgArgs = o;
    const live = sandbox.teamLiveOf(o.chat.id);
    if (live) live.stopped = true;
    return { round: 1, messages: [{ role: "assistant", content: "被打断的发言", expertId: E2.id }] };
  };
  await sandbox.teamGroupRun(chatC, "跑一半被终止");
  ok(aggCalls === 0, "用户终止本轮 → 不自动汇总");

  TEAM.runGroupRound = realRunGroup;
  TEAM.aggregateGroup = realAggregate;
  TEAM.writeAdviceFile = realWriteAdvice;

  console.log(
    "\n" +
      (fails
        ? "FAILED " + fails + " / " + checks + " checks"
        : "ALL OK  " + checks + " checks"),
  );
  process.exit(fails ? 1 : 0);
})();
