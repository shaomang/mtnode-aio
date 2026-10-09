/* 冒烟：「本会话每一轮都长期保留」—— 轨迹 / 改动两栏不得只剩最后一轮
 *   node test/smoke-round-keep.js
 *
 * 需求（用户报的 bug）：同一会话连发第二轮后，切到「轨迹 / 改动」只剩最后一轮。
 *   根因两条，都在数据链路上（不是 UI）：
 *     ① renderer/app-trajectory.js 的 collectSegments：本轮内存轨迹非空就直接 return，
 *        完全不再合并历史消息里的段快照 → 一开第二轮旧轮整段消失；
 *     ② 会话消息的保留上限是**固定 100 条**（app-assist.js 开轮 / 落盘、app-db.js 三处
 *        写入路径各一份）：开发 / 细化会话一轮里用户消息本来就多（询问窗每条回答都是一条
 *        user 消息），7 轮上下就把最早的**助手消息**（轨迹 / 改动唯一的数据源）挤出去。
 * 口径（用户已确认）：历史轮次与当前运行轮**合并展示、按「第 N 轮」分组**；
 *   改动栏除「每轮都在」外不变；消息保留改成**按轮保留**；存量数据不回填。
 *
 * 覆盖：
 *   [1] 轨迹取数：带 live 段的会话上，历史轮次一条不丢、与本轮合并、按轮号分组
 *   [2] 合并判据（agentSegsMergeRounds 真函数）：别轮保留 / 同轮去重 / 无轮号不误删
 *   [3] 改动取数：全量助手消息的工具清单 + 本轮 _liveTools，轮号按段配对（app-changes.js 真模块）
 *   [4] 消息按轮保留（agentTrimSessionMessages 真函数）：按轮裁、绝不切开一轮
 *   [5] 静态口径：四处写入路径同源到同一个闸，不再有写死的 100 条
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let checks = 0;
let fails = 0;
function ok(cond, label) {
  checks++;
  if (cond) console.log("  ok    " + label);
  else {
    fails++;
    console.log("  FAIL  " + label);
  }
}
function section(t) {
  console.log("\n" + t);
}
const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const ASSIST = read("renderer/app-assist.js");
const TRAJ = read("renderer/app-trajectory.js");
const CHANGES = read("renderer/app-changes.js");
const DB = read("renderer/app-db.js");

/* 抠函数本体：字符串 / 模板串 / 注释感知的大括号配对（与 smoke-think.js 同一种读法） */
function grabFn(src, name, indent) {
  const pad = " ".repeat(indent == null ? 2 : indent);
  const at = src.indexOf(pad + "function " + name + "(");
  if (at < 0) throw new Error("找不到函数 " + name);
  let i = src.indexOf("{", at);
  let depth = 0;
  let st = "";
  let esc = false;
  for (; i < src.length; i++) {
    const c = src[i];
    const nx = src[i + 1];
    if (st === "line") {
      if (c === "\n") st = "";
      continue;
    }
    if (st === "block") {
      if (c === "*" && nx === "/") {
        st = "";
        i++;
      }
      continue;
    }
    if (st) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === st) st = "";
      continue;
    }
    if (c === "/" && nx === "/") {
      st = "line";
      i++;
      continue;
    }
    if (c === "/" && nx === "*") {
      st = "block";
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      st = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (!depth) return src.slice(at, i + 1);
    }
  }
  throw new Error("函数 " + name + " 括号不配对");
}
function grabNumConst(src, name) {
  const m = new RegExp("^const\\s+" + name + "\\s*=\\s*(\\d+)", "m").exec(src);
  if (!m) throw new Error("找不到常量 " + name);
  return Number(m[1]);
}
const T = (s, p) =>
  String(s).replace(/\{(\w+)\}/g, (m, k) => (p && p[k] != null ? String(p[k]) : m));

/* =====================================================================
 * [1] 轨迹取数：历史轮次 + 本轮 live 段合并
 * ===================================================================== */
section("[1] 轨迹取数（collectSegments 真函数）：旧轮与本轮都在");
let trajApi = null;
{
  /* 现场：两轮已归档（各带段快照，round = 1 / 2）+ 第三轮正在跑（live items，round = 3）。
     这正是用户报的「连发第二轮后只剩最后一轮」的那份数据。 */
  const r1segs = [
    { k: "think", text: "第一轮思考", step: 1, round: 1 },
    { k: "tool", text: "", step: 2, callId: "c1", round: 1 },
    { k: "say", text: "第一轮答复", step: 3, round: 1 },
  ];
  const r2segs = [
    { k: "think", text: "第二轮思考", step: 1, round: 2 },
    { k: "say", text: "第二轮答复", step: 2, round: 2 },
  ];
  const liveItems = [
    { k: "think", text: "第三轮思考", step: 1 },
    { k: "tool", text: "", step: 1, callId: "c9" },
    { k: "say", text: "第三轮答复", step: 2 },
  ];
  const sess = {
    id: "asR",
    running: true,
    messages: [
      { role: "user", content: "第一问", at: 1 },
      { role: "assistant", content: "第一轮答复", segments: r1segs, tools: [{ callId: "c1", step: 2, name: "edit", at: 11 }] },
      { role: "user", content: "第二问", at: 2 },
      { role: "assistant", content: "第二轮答复", segments: r2segs, tools: [{ callId: "c2", step: 1, name: "write", at: 21 }] },
      { role: "user", content: "第三问", at: 3 },
    ],
  };
  const sb = {
    console,
    agentSessionById: (id) => (String(id) === "asR" ? sess : null),
    activeSession: () => sess,
    agentTraceItems: (rk) => (rk === "agent:asR" ? liveItems : null),
    agentTraceRound: (rk) => (rk === "agent:asR" ? 3 : null),
    agentChatSegItems: () => null,
    dshSegToolAt: (pool) => (Array.isArray(pool) && pool.length ? 0 : -1),
  };
  vm.createContext(sb);
  vm.runInContext(
    [
      grabFn(TRAJ, "agentSegsMergeRounds"),
      grabFn(TRAJ, "collectSegments"),
      grabFn(TRAJ, "histSegmentsOf"),
      grabFn(TRAJ, "toolMapOf"),
      grabFn(TRAJ, "traceRoundOf"),
    ].join("\n") + "\nthis.collectSegments = collectSegments; this.mergeRounds = agentSegsMergeRounds;",
    sb,
    { filename: "trajectory-collect.js" },
  );
  const collect = (sid) => vm.runInContext("collectSegments(" + JSON.stringify(sid) + ")", sb);
  const segs = collect("asR");
  trajApi = { collect, mergeRounds: (h, l, r) => vm.runInContext("mergeRounds", sb)(h, l, r) };
  ok(segs.length === 8, "[1] 三轮段全在（3 + 2 + 3 = 8，实得 " + segs.length + "）");
  ok(
    segs.map((s) => String(s.round)).join(",") === "1,1,1,2,2,3,3,3",
    "[1] 段序 = 发生顺序、轮号递增（旧轮在前、本轮在后）：实得 " + segs.map((s) => s.round).join(","),
  );
  ok(
    segs.filter((s) => String(s.round) === "1").length === 3 &&
      segs.filter((s) => String(s.round) === "2").length === 2,
    "[1] 开第三轮之后，第 1 / 第 2 轮的段一条都不少（用户报的 bug 现场）",
  );
  ok(
    segs[3].text === "第二轮思考" && segs[7].text === "第三轮答复",
    "[1] 段正文原样（旧轮思考不被丢掉、本轮接在最后）",
  );
  ok(collect("none").length === 0, "[1] 没有这条会话 → 空数组（轨迹走空态，不抛）");

  /* 同一轮既在历史里又在 live 里（本轮刚跑完、归档已落地）：只出现一次。
     历史那条按落盘形态写（tool 段不带 callId），live 那条带着 —— 这正是「同一份段的两种形态」。 */
  const dupHist = [
    { k: "think", text: "本轮思考", step: 1, round: 3 },
    { k: "tool", text: "", step: 1, round: 3 },
    { k: "say", text: "本轮答复", step: 2, round: 3 },
  ];
  const merged = trajApi.mergeRounds(dupHist, liveItems, 3);
  ok(merged.length === 0, "[1] 同一轮只保留 live 那一份（历史里的本轮副本被剔掉，不显示两遍）");
}

/* =====================================================================
 * [2] 合并判据本身（边界）
 * ===================================================================== */
section("[2] agentSegsMergeRounds 的三条判据");
{
  const M = trajApi.mergeRounds;
  const live = [{ k: "say", text: "本轮", step: 1 }];
  ok(
    M([{ k: "say", text: "旧轮", step: 1, round: 1 }], live, 2).length === 1,
    "[2] 别轮（round 不同）→ 保留",
  );
  ok(M([], live, 2).length === 0, "[2] 没有历史 → 回空（调用方原样用 live）");
  ok(
    M([{ k: "say", text: "本轮", step: 1 }], live, null).length === 0,
    "[2] 段上没轮号但确实是尾部同一份 → 不算旧轮（老存档不重复显示）",
  );
  ok(
    M(
      [
        { k: "say", text: "旧轮", step: 1 },
        { k: "tool", text: "", step: 5 },
      ],
      live,
      null,
    ).length === 2,
    "[2] 段上没轮号、也对不上尾部 → 一律当旧轮留着（宁多留、不误删）",
  );
  ok(
    M([{ k: "say", text: "别的正文", step: 1, round: 2 }], live, 2).length === 0,
    "[2] 同轮按轮号剔（正文不同也剔：轮号是硬判据）",
  );
}

/* =====================================================================
 * [3] 改动栏取数：历史轮次 + 本轮 _liveTools（app-changes.js 真模块）
 * ===================================================================== */
section("[3] 改动栏取数（app-changes.js 真模块）：每轮的工具记录都拿得到");
{
  /* 迷你 DOM：只够 app-changes.js 建容器用（不点行、不看 diff 皮肤） */
  function mkEl(tag) {
    const el = {
      nodeType: 1,
      tagName: String(tag || "div").toUpperCase(),
      id: "",
      parentNode: null,
      _children: [],
      _cls: new Set(),
      _attrs: {},
      dataset: {},
      hidden: false,
      title: "",
      type: "",
      style: {},
      scrollTop: 0,
      scrollHeight: 0,
      clientHeight: 0,
      offsetWidth: 800,
      textContent: "",
    };
    el.classList = {
      add: (...c) => c.forEach((x) => el._cls.add(x)),
      remove: (...c) => c.forEach((x) => el._cls.delete(x)),
      contains: (c) => el._cls.has(c),
      toggle: (c, on) => (on === undefined ? !el._cls.has(c) : on),
    };
    el.appendChild = (c) => {
      el._children.push(c);
      if (c) c.parentNode = el;
      return c;
    };
    el.removeChild = (c) => {
      const i = el._children.indexOf(c);
      if (i >= 0) el._children.splice(i, 1);
      return c;
    };
    el.remove = () => {
      if (el.parentNode) el.parentNode.removeChild(el);
    };
    el.setAttribute = (k, v) => {
      el._attrs[k] = String(v);
    };
    el.getAttribute = (k) => (k in el._attrs ? el._attrs[k] : null);
    el.addEventListener = () => {};
    el.removeEventListener = () => {};
    el.querySelector = () => null;
    el.querySelectorAll = () => [];
    el.getBoundingClientRect = () => ({ width: 800, height: 600, left: 0, top: 0 });
    el.getElementsByClassName = () => [];
    Object.defineProperty(el, "children", { get: () => el._children.slice() });
    Object.defineProperty(el, "firstChild", { get: () => el._children[0] || null });
    Object.defineProperty(el, "innerHTML", {
      get: () => "",
      set: () => {
        el._children.length = 0;
      },
    });
    return el;
  }
  const host = mkEl("div");
  const win = {};
  const sb = {
    console,
    window: win,
    document: { createElement: (t) => mkEl(t) },
    I18n: { t: T },
    fmtTime: () => "T",
    dshToolTitleOf: (t) => String((t && t.name) || ""),
  };
  win.window = win;
  win.MTNodeChatDiff = {
    /* 只认编辑类工具；路径就是 args.file_path —— 与 app-assist.js 的真判据无关，
       这里只验证「改动栏把每一轮的工具记录都收进来了、轮号配得上」。 */
    ofFull: (rec) => {
      const a = (rec && rec.args) || {};
      const n = String((rec && rec.name) || "");
      if (!/^(edit|write|str_replace_editor)$/.test(n)) return null;
      return { path: String(a.file_path || ""), rows: [{ t: "x" }], added: 1, removed: 0 };
    },
  };
  vm.createContext(sb);
  vm.runInContext(CHANGES, sb, { filename: "app-changes.js" });
  const CH = win.MTNodeChanges;
  ok(!!CH && typeof CH.mount === "function", "[3] app-changes.js 挂在 window.MTNodeChanges 上");

  const sess = {
    id: "asC",
    workspace: "E:/prj",
    messages: [
      { role: "user", content: "一" },
      {
        role: "assistant",
        content: "一",
        segments: [{ k: "tool", callId: "k1", step: 1, round: 1 }],
        tools: [
          { callId: "k1", step: 1, name: "edit", at: 100, args: { file_path: "E:/prj/a.js" } },
          { callId: "k2", step: 2, name: "read", at: 101, args: { file_path: "E:/prj/a.js" } },
        ],
      },
      { role: "user", content: "二" },
      {
        role: "assistant",
        content: "二",
        segments: [{ k: "tool", callId: "k3", step: 1, round: 2 }],
        tools: [{ callId: "k3", step: 1, name: "write", at: 200, args: { file_path: "E:/prj/b.js" } }],
      },
      { role: "user", content: "三" },
    ],
    _liveTools: [
      { callId: "k9", step: 1, name: "edit", at: 300, args: { file_path: "E:/prj/a.js" } },
    ],
  };
  sb.agentSessions = () => [sess];
  sb.agentSessionById = (id) => (String(id) === "asC" ? sess : null);
  sb.agentTraceRound = () => 3;
  sb.agentRunWorkspace = () => "E:/prj";
  /* 模块内部按 typeof 读这些全局函数：注进沙箱即可 */
  vm.runInContext(
    "var S = { agentSessions: [__sess], agentActiveId: 'asC', config: { dsh: {} } };\n".replace(
      "__sess",
      "globalThis.__sess",
    ),
    sb,
  );
  sb.__sess = sess;
  let mounted = true;
  try {
    CH.mount(host, "asC");
  } catch (e) {
    mounted = false;
    console.log("      （mount 抛错：" + (e && e.message) + "）");
  }
  ok(mounted, "[3] mount 不抛（拿全量数据建左右两栏）");
  /* 模块不外抛数据，用「左栏一行一个文件」的行文本反查（一行 = 时刻 · 路径 · ± · 共 N 次） */
  const texts = [];
  (function walk(n) {
    if (!n) return;
    if (n._children) {
      if (!n._children.length && typeof n.textContent === "string" && n.textContent) texts.push(n.textContent);
      n._children.forEach(walk);
    }
  })(host);
  const joined = texts.join(" | ");
  ok(/a\.js/.test(joined) && /b\.js/.test(joined), "[3] 两个文件的改动都在左栏（含第 1 轮的 a.js）");
  ok(/共 2 次/.test(joined), "[3] 同一文件跨轮的多笔合并成一项（第 1 轮 + 第 3 轮 = 共 2 次）");
}

/* =====================================================================
 * [4] 消息按轮保留（agentTrimSessionMessages 真函数）
 * ===================================================================== */
section("[4] 消息保留改成按轮（agentTrimSessionMessages 真函数）");
{
  /* 三个常量：前两个是字面量，上限由它们相乘得来（跟着源码算，不在冒烟里另写一个数） */
  const PER = grabNumConst(ASSIST, "AGENT_ROUND_MAX_ENTRIES");
  const MINROUNDS = grabNumConst(ASSIST, "AGENT_MIN_KEEP_PER_ROUND");
  const CAP = PER * MINROUNDS;
  const sb = { console };
  vm.createContext(sb);
  vm.runInContext(
    [
      "var AGENT_MIN_KEEP_PER_ROUND = " + MINROUNDS + ";",
      "var AGENT_ROUND_MAX_ENTRIES = " + PER + ";",
      "var AGENT_MSG_KEEP_MAX = " + CAP + ";",
      grabFn(ASSIST, "agentTrimSessionMessages", 0),
    ].join("\n") + "\nthis.trim = agentTrimSessionMessages;",
    sb,
    { filename: "keep.js" },
  );
  const trim = (st) => vm.runInContext("trim", sb)(st);
  ok(CAP > 100, "[4] 总上限比原来的固定 100 条宽松得多（实得 " + CAP + "）");
  ok(
    PER >= 10,
    "[4] 一轮按最多 " + PER + " 条消息折算（开发 / 细化轮里一轮含多条询问窗回答）",
  );

  const mk = (rounds) => {
    const msgs = [];
    for (let r = 1; r <= rounds; r++) {
      msgs.push({ role: "user", content: "q" + r, at: r * 10 });
      msgs.push({ role: "assistant", content: "a" + r, at: r * 10 + 1, segments: [{ k: "say", text: "a" + r, round: r }] });
    }
    return { id: "asT", messages: msgs };
  };
  const small = mk(3);
  ok(trim(small) === 0 && small.messages.length === 6, "[4] 没到上限 → 一条都不裁");
  const big = mk(Math.ceil(CAP / 2) + 50);
  const n0 = big.messages.length;
  const cut = trim(big);
  ok(cut > 0 && big.messages.length === CAP, "[4] 到上限 → 裁回 " + CAP + " 条（裁掉 " + cut + " / " + n0 + "）");
  ok(
    big.messages.filter((m) => m.role === "assistant").length >= MINROUNDS,
    "[4] 裁完仍留着 ≥ " + MINROUNDS + " 轮的助手消息（轨迹 / 改动的数据源还在）",
  );
  /* 裁切点不切开一轮：留下的第一条要么本身就是用户消息（轮的起点），要么是助手消息、
     而它的用户消息（at 更小、紧跟在前）也一起留下了 */
  const first = big.messages[0];
  ok(
    big.messages.length > 1 &&
      (first.role === "user" || (big.messages[1] && big.messages[1].role === "user")),
    "[4] 裁切点不落在「只有助手消息、没有它的用户消息」的位置（保留的是完整轮）",
  );
  ok(
    big.messages[big.messages.length - 1].content === "a" + (Math.ceil(CAP / 2) + 50),
    "[4] 最新一轮永远在（尾部不裁）",
  );
  ok(trim(null) === 0 && trim({}) === 0, "[4] 没会话 / 没 messages → 不抛、返回 0");
}

/* =====================================================================
 * [5] 静态口径：四处写入路径同源
 * ===================================================================== */
section("[5] 写入路径同源到同一个闸（不再有写死的 100 条）");
{
  ok(
    (DB.match(/agentTrimSessionMessages\(st\)/g) || []).length === 2,
    "[5] app-db.js 两处写入路径（询问窗 / 求助卡的「回答」 + 轮末痕迹）都走同一个闸"
      + "（求助卡已与询问卡同源：答案走 ixCommitAnswerToSession 这一条，"
      + "旧的那条「已回应」痕迹随本次改版下线）",
  );
  ok(
    !/if \(st\.messages\.length > 100\) st\.messages\.splice/.test(DB) &&
      !/if \(st\.messages\.length > 100\) st\.messages\.splice/.test(ASSIST),
    "[5] 写死 100 条的那两处旧判据已撤",
  );
  ok(
    /agentTrimSessionMessages\(st\)/.test(ASSIST),
    "[5] app-assist.js 开轮那一处也走同一个闸（不再一刀切）",
  );
  ok(
    /messages: \(s\.messages \|\| \[\]\)\.slice\(-AGENT_MSG_KEEP_MAX\)/.test(ASSIST),
    "[5] 落盘条数读的就是同一个上限常量（不再各写一个数字）",
  );
}

console.log(
  "\n" + (fails ? "✗ " + fails + " 项失败" : "✓ " + checks + " 项全部通过") + "  (smoke-round-keep)",
);
if (fails) process.exitCode = 1;
