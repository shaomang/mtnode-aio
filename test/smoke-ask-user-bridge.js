"use strict";
/* 询问窗（ask_user_question）在 dsh 0.2 内核下必须真的有人应答 —— 冒烟测试
 *   node test/smoke-ask-user-bridge.js
 *
 * 故障现场（本次修复的 bug）：开发绑定会话里调 ask_user_question，工具以
 *   `Error: no user-questions answerer accepted the request` 失败，界面上根本不弹
 *   「🐋 模型等待你的回应」卡片。
 * 成因：dsh 0.2 的 `@deepseek-ai/dsh-user-questions` 把提问做成 **Agent 作用域的
 *   `user-questions/request` 瀑布**，回答者 = 普通 Cordis 监听
 *   （服务端无人认领时回 `UserQuestionError(..., "NO_PROVIDER")`）；
 *   `ctx.userQuestions` 上**没有** `registerProvider`（0.1 的旧写法）。
 *   而 `dsh/gateway/bridge-plugin.mjs` 还在调 `ctx.userQuestions.registerProvider({ask})`
 *   —— 装载期抛错被吞，等于这条桥从没挂上回答者，于是每一次提问都撞 NO_PROVIDER。
 * 修复：桥改用 `ctx.on('user-questions/request', (request, next) => …)` 注册回答者，
 *   与同文件的 `approval/request` 同形状；拿不到 TCP 桥时 `return next()`（让位给别的
 *   回答者），绝不自己造一个失败的答案。
 *
 * 覆盖：
 *   [1] 旧通道已拆除：不再出现 registerProvider / 不再读 ctx.userQuestions
 *   [2] 回答者挂在水位上：真事件流下 ask() 发出 question 帧，宿主回 answer 帧 → 解出答案
 *   [3] 帧的形状：questions 映射（含 header / detail / options / multiSelect 省略规则）
 *       与 sessionId 盖章（request.agent.id）
 *   [4] 桥不可用 → next() 让位（不 reject、不返回空答案）
 *   [5] abort → 发 drop 撤卡并以失败收场（不是空 answers 骗过模型）
 * 依赖：只 import node 内置（被 import 的插件本体也是），零依赖、不启动 Electron、
 *       不碰真实 %APPDATA%；TCP 只监听 127.0.0.1 的临时端口。
 */
const net = require("net");
const path = require("path");
const { pathToFileURL } = require("url");

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
const PLUGIN_REL = "dsh/gateway/bridge-plugin.mjs";
const pluginAbs = path.join(__dirname, "..", PLUGIN_REL);
const fs = require("fs");
const SRC = fs.readFileSync(pluginAbs, "utf8");
/* 注释里会写到 `ctx.userQuestions`（说明为什么拆掉旧通道），所以「不再读它」这条
   断言必须先剥注释——否则注释本身会把断言判红。 */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** 起一台「假网关」：解析换行分隔 JSON，按收到的帧回一帧答案（或什么都不回）。 */
function startFakeGateway() {
  const frames = [];
  const sockets = new Set();
  const server = net.createServer((s) => {
    sockets.add(s);
    let buf = "";
    s.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m = null;
        try {
          m = JSON.parse(line);
        } catch (_) {
          continue;
        }
        frames.push(m);
        if (m.t === "question") {
          s.write(
            JSON.stringify({
              t: "answer",
              id: m.id,
              answers: (m.questions || []).map((q) => ({
                id: q.id,
                selected: ["甲"],
                custom: "乙",
              })),
            }) + "\n",
          );
        } else if (m.t === "question-abort-case") {
          s.write(JSON.stringify({ t: "abort", id: m.id }) + "\n");
        }
      }
    });
    s.on("error", () => {});
    s.on("close", () => sockets.delete(s));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        frames,
        close: () =>
          new Promise((r) => {
            for (const s of sockets) {
              try {
                s.destroy();
              } catch (_) {}
            }
            server.close(() => r());
          }),
      });
    });
  });
}

/** 极简 cordis ctx：只需 on() 收监听器（本插件只用到这一件事）。 */
function makeCtx() {
  const listeners = new Map();
  return {
    listeners,
    on(ev, fn) {
      const arr = listeners.get(ev) || [];
      arr.push(fn);
      listeners.set(ev, arr);
      return () => {};
    },
    /** 模拟服务端的瀑布派发：顺次调监听器，谁返回非 undefined 就用谁的结果。 */
    waterfall(ev, request, fallback) {
      const arr = listeners.get(ev) || [];
      const step = (idx) => {
        const fn = arr[idx];
        if (!fn) return Promise.resolve().then(fallback);
        const r = fn(request, () => step(idx + 1));
        return r === undefined ? step(idx + 1) : Promise.resolve(r);
      };
      return step(0);
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log("\n[1] 旧通道已拆除（dsh 0.2 没有 registerProvider）");
  ok(
    !/ctx\.userQuestions\s*\.\s*registerProvider\s*\(/.test(CODE),
    "bridge-plugin.mjs 不再调用 ctx.userQuestions.registerProvider（0.1 通道）",
  );
  ok(
    !/ctx\s*\.\s*userQuestions/.test(CODE),
    "不再从 ctx.userQuestions 上取任何方法（回答者只走事件瀑布）",
  );
  ok(
    /ctx\.on\(\s*['"]user-questions\/request['"]/.test(CODE),
    "注册了 user-questions/request 回答者（与 approval/request 同形状）",
  );
  ok(
    /inject\s*=\s*\[\s*['"]userQuestions['"]\s*\]/.test(SRC),
    "inject 仍声明 userQuestions（等到该服务就绪再挂监听）",
  );

  /* ── 真事件流 ──────────────────────────────────────────────────────── */
  console.log("\n[2] 真事件流：question 帧出、answer 帧回 → 解出宿主答案");
  const gw = await startFakeGateway();
  process.env.MTNODE_BRIDGE_PORT = String(gw.port);
  const mod = await import(pathToFileURL(pluginAbs).href);
  const ctx = makeCtx();
  mod.apply(ctx);
  await sleep(120); // 等 TCP 连上（socket 就绪 = 回答者接手）
  const answer = await ctx.waterfall(
    "user-questions/request",
    {
      questions: [
        {
          id: "q1",
          question: "修法确认？",
          header: "确认",
          detail: "细节",
          options: [{ label: "甲" }],
          multiSelect: true,
        },
        { id: "q2", question: "第二问" },
      ],
      agent: { id: "session-abc" },
      signal: new AbortController().signal,
    },
    () => Promise.reject(new Error("no user-questions answerer accepted the request")),
  );
  ok(!!answer && Array.isArray(answer.answers), "回答者返回了答案对象（不是 next() 兜底失败）");
  ok(
    JSON.stringify(answer.answers) ===
      JSON.stringify([
        { id: "q1", selected: ["甲"], custom: "乙" },
        { id: "q2", selected: ["甲"], custom: "乙" },
      ]),
    "答案按 id 原样回给服务（{id, selected, custom}）",
  );

  console.log("\n[3] 帧形状：questions 映射 + sessionId 盖章");
  const qf = gw.frames.find((f) => f.t === "question");
  ok(!!qf, "桥上收到 question 帧");
  ok(qf.sessionId === "session-abc", "frameSid = request.agent.id（归属门控的判据）");
  ok(
    JSON.stringify(qf.questions[0]) ===
      JSON.stringify({
        id: "q1",
        question: "修法确认？",
        header: "确认",
        detail: "细节",
        options: [{ label: "甲" }],
        multiSelect: true,
      }),
    "题面字段齐全（id / question / header / detail / options / multiSelect）",
  );
  ok(
    JSON.stringify(qf.questions[1]) === JSON.stringify({ id: "q2", question: "第二问" }),
    "未声明的可选字段不补空键（undefined 不落帧）",
  );

  console.log("\n[4] 桥不可用 → next() 让位（不 reject、不造空答案）");
  const ctxNoBridge = makeCtx();
  const saved = process.env.MTNODE_BRIDGE_PORT;
  delete process.env.MTNODE_BRIDGE_PORT;
  const mod2 = await import(pathToFileURL(pluginAbs).href + "?nobridge=1");
  mod2.apply(ctxNoBridge);
  let handedOff = false;
  const noBridgeAnswer = await ctxNoBridge.waterfall(
    "user-questions/request",
    { questions: [{ id: "q1", question: "?" }], agent: { id: "session-x" } },
    () => {
      handedOff = true;
      return Promise.resolve({ answers: [] });
    },
  );
  ok(handedOff, "无桥（无端口）= 调 next()，把机会让给别的回答者");
  ok(!!noBridgeAnswer && Array.isArray(noBridgeAnswer.answers), "next() 的结果原样透传");
  process.env.MTNODE_BRIDGE_PORT = saved;

  console.log("\n[5] abort → 发 drop 撤卡，并以失败收场");
  /* 这台假网关只在收到 question 帧后回 abort 帧（模拟宿主点「中断任务」）。 */
  const frames2 = [];
  const sockets2 = new Set();
  const server2 = net.createServer((s) => {
    sockets2.add(s);
    let buf = "";
    s.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m = null;
        try {
          m = JSON.parse(line);
        } catch (_) {
          continue;
        }
        frames2.push(m);
        if (m.t === "question") s.write(JSON.stringify({ t: "abort", id: m.id }) + "\n");
      }
    });
    s.on("error", () => {});
    s.on("close", () => sockets2.delete(s));
  });
  await new Promise((r) => server2.listen(0, "127.0.0.1", r));
  process.env.MTNODE_BRIDGE_PORT = String(server2.address().port);
  const mod3 = await import(pathToFileURL(pluginAbs).href + "?abort=1");
  const ctx3 = makeCtx();
  mod3.apply(ctx3);
  await sleep(120);
  let aborted = null;
  try {
    await ctx3.waterfall(
      "user-questions/request",
      {
        questions: [{ id: "q1", question: "?" }],
        agent: { id: "session-abort" },
        signal: new AbortController().signal,
      },
      () => Promise.reject(new Error("no user-questions answerer accepted the request")),
    );
  } catch (e) {
    aborted = e;
  }
  ok(!!aborted, "宿主「中断任务」后提问以失败收场（模型看得到失败，不是空 answers）");
  ok(
    /aborted before the user answered/.test(String((aborted && aborted.message) || "")),
    "失败原因写明「用户在作答前中止了本次提问」",
  );
  await new Promise((r) => {
    for (const s of sockets2) {
      try {
        s.destroy();
      } catch (_) {}
    }
    server2.close(() => r());
  });

  console.log(
    "\n" + (fails ? "FAILED " + fails + " / " + checks + " checks" : "ALL OK  " + checks + " checks"),
  );
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error("smoke-ask-user-bridge 崩了：" + ((e && e.message) || e));
  process.exit(1);
});
