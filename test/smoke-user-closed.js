"use strict";
/* test/smoke-user-closed.js — 「用户主动关闭会话」不再显示工程报文（本次需求）
 *
 * 用户报的现场：按会话里的 ■ 关掉这一轮，界面上却是一屏
 *   exit code: 0
 *   stderr tail:
 *   [ix-speech] speech providers=0 []
 *   dsh: warning: 2 entries did not activate
 *   compaction-basic (...): ValidationError: $.modelPolicies[7].model expected string but got 123
 * 根因（改动前）：网关关掉运行时后 SDK 回的是「DeepSeek Harness runtime exited /
 * exit code: 0」这类工程报文，宿主只按「有没有取消字样」判，于是它被当错误落成 err 段、
 * 写进会话正文，还弹红 toast。
 *
 * 本文件跑真代码：
 *   [1] 判定函数的行为（从 renderer/app-db.js 抠出真函数体，注进沙箱）
 *   [2] 运行管线接线：error 帧不落 err 段 / done 与 catch 走中性收尾 / 收尾摘起跑代号
 *   [3] 呈现层：会话落中性状态行 + 折叠「详情」，节点 / 助手 / 计划并行组都不弹红 toast
 *   [4] 顺带修的配置 bug：modelPolicies 里形如数字的 id 写成带引号的字符串
 *
 * 运行：node test/smoke-user-closed.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let checks = 0;
let fails = 0;
function ok(cond, msg) {
  checks++;
  console.log((cond ? "  ok    " : "  FAIL  ") + msg);
  if (!cond) fails++;
}
const has = (src, needle, msg) => ok(String(src).indexOf(needle) >= 0, msg);
const no = (src, needle, msg) => ok(String(src).indexOf(needle) < 0, msg);

const ROOT = path.join(__dirname, "..");
const read = (rel) =>
  fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8").replace(/\r\n/g, "\n");

const DB = read("renderer/app-db.js");
const ASSIST = read("renderer/app-assist.js");
const NODES = read("renderer/app-nodes.js");
const PLAN = read("renderer/app-plan.js");
const I18N = read("renderer/i18n.js");
const CSS = read("renderer/css/browser.css");
const COMPACT = read("dsh-compact-policy.js");
const LONGRUN = read("renderer/app-longrun.js");
const APPJS = read("renderer/app.js");
const AGENTJS = read("renderer/app-agent.js");
const BOOT = read("renderer/app-boot.js");

/* ── 按大括号配平抠出真函数体（注释 / 字符串里的括号不算） ── */
function balanced(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === q) break;
        i++;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (!depth) return src.slice(openIdx, i + 1);
    }
  }
  throw new Error("unbalanced");
}
function grabFn(src, name) {
  const at = src.indexOf("function " + name + "(");
  if (at < 0) throw new Error("missing " + name);
  const open = src.indexOf("{", at);
  const body = balanced(src, open);
  return src.slice(at, open + body.length);
}

/* 真函数体（app-db.js 里的判定 / 终止戳两条链） */
const FN_SRC = [
  "USER_CLOSED_TEXT",
  "dshUserClosedText",
  "dshRunStopBaseSet",
  "dshRunStopBaseClear",
  "dshRunStoppedSinceStart",
  "dshRunAutoStoppedSinceStart",
  "dshRuntimeCleanExitText",
  "dshUserClosedErrorOf",
  "dshIsUserClosedError",
  "dshStopSeqOf",
  "dshStopMark",
  "dshStopStamped",
]
  .map((n) => {
    if (n === "USER_CLOSED_TEXT") {
      const m = DB.match(/const USER_CLOSED_TEXT = "[^"]*";/);
      if (!m) throw new Error("missing USER_CLOSED_TEXT");
      return m[0].replace("const ", "var ");
    }
    return grabFn(DB, n);
  })
  .join("\n");

function sandbox() {
  const S = { _runStop: {}, _runStopSeq: 0 };
  const ctx = {
    S,
    I18n: { t: (s) => String(s) },
    Number,
    String,
    Object,
    Error,
  };
  vm.createContext(ctx);
  vm.runInContext(FN_SRC, ctx);
  return ctx;
}

console.log("\n[1] 判定：用户按停 + 退出码 0 = 用户主动关闭；其余一律照旧报错");
{
  const c = sandbox();
  const exit0 =
    'dsh profile "sdk": DeepSeek Harness runtime exited\nexit code: 0\nstderr tail:\n' +
    "[ix-speech] speech providers=0 []\ndsh: warning: 2 entries did not activate\n" +
    "compaction-basic (@deepseek-ai/dsh-compaction-basic): ValidationError: invalid config:\n" +
    "  - $.modelPolicies[7].model expected string but got 123";
  ok(c.dshRuntimeCleanExitText(exit0) === true, "exit code: 0 + runtime exited 认成干净退出");
  ok(
    c.dshRuntimeCleanExitText(
      'dsh profile "sdk": DeepSeek Harness runtime is not running\nexit code: 0',
    ) === true,
    "runtime is not running + exit code: 0 同口径",
  );
  ok(
    c.dshRuntimeCleanExitText("DeepSeek Harness runtime: transport closed\nexit code: 0") === true,
    "TransportClosedError 的 reason 也认",
  );
  ok(
    c.dshRuntimeCleanExitText(exit0.replace("exit code: 0", "exit code: 1")) === false,
    "退出码 1（被杀 / 崩溃）不算用户主动关闭 —— 真故障必须还能报错",
  );
  ok(
    c.dshRuntimeCleanExitText(exit0.replace("exit code: 0", "exit code: 10")) === false,
    "退出码 10 不会被 exit code: 0 的判据误吞（负向前瞻）",
  );
  ok(c.dshRuntimeCleanExitText("任务内容为空") === false, "普通业务报错不受影响");
  ok(c.dshRuntimeCleanExitText("") === false, "空报文不认");

  /* ② 用户按没按过停：没盖终止戳 = 不是用户关闭（运行时自己挂了要照旧报错） */
  c.dshRunStopBaseSet("agent:a1", 0);
  ok(c.dshUserClosedErrorOf("agent:a1", exit0) === null, "没按过停（无终止戳）→ 不算用户关闭");
  c.dshStopSeqOf; /* noop：保持真源引用 */
  c.S._runStop["agent:a1"] = 7;
  const err = c.dshUserClosedErrorOf("agent:a1", exit0);
  ok(!!err && err.userClosed === true, "按过停 + 干净退出 → 命中用户主动关闭");
  ok(!!err && err.message === "用户主动关闭会话", "文案就是这一句（不带任何工程报文）");
  ok(!!err && String(err.detail).indexOf("stderr tail:") > 0, "原始报文留在 detail 里（折叠给排查用）");
  ok(c.dshIsUserClosedError(err) === true && c.dshIsUserClosedError(new Error("x")) === false,
    "dshIsUserClosedError 只认这一枚标记");
  c.dshRunStopBaseSet("agent:a1", 99);
  ok(c.dshUserClosedErrorOf("agent:a1", exit0) === null,
    "起跑代号之后没再盖戳（戳属于上一轮）→ 不算本次关闭");
  c.dshRunStopBaseClear("agent:a1");
  ok(c.dshRunStoppedSinceStart("agent:a1") === false, "收尾摘掉起跑代号后不再命中");

  /* ③ 看门狗自动终止（长时间无响应 / 交互等待超时）不能冒充「用户主动关闭会话」 */
  c.dshRunStopBaseSet("agent:a2", 0);
  c.dshStopMark("agent:a2", { auto: true });
  ok(c.dshRunAutoStoppedSinceStart("agent:a2") === true, "自动终止有独立标记");
  ok(
    c.dshUserClosedErrorOf("agent:a2", exit0) === null,
    "自动终止即便退出码是 0 也不算用户关闭（真异常照旧报错）",
  );
  c.dshRunStopBaseClear("agent:a2");
}

console.log("\n[2] 运行管线接线：error 帧不落 err 段，收尾走中性错误");
{
  has(DB, "let userClosedRaw = \"\";", "dshRunOnce 记一列「用户关闭的原始报文」");
  has(DB, "if (dshUserClosedErrorOf(runKey, msg.data.message))", "error 帧先过用户关闭判定");
  has(DB, "const userClosedFrame =", "按报文认出「这一帧是用户关闭」");
  has(DB, "if (!userClosedFrame) {", "用户关闭那一帧不进 traceFeedEvent（不落 err 段）");
  has(DB, "if (opts.onEvent && !userClosedFrame)", "也不再派给界面（各 error 分支只认真故障）");
  has(DB, "} else if (seenError) {", "done 分支：用户关闭优先于 seenError");
  has(DB, "dshUserClosedErrorOf(runKey, userClosedRaw) ||", "done 分支收尾成带标记的中性错误");
  has(DB, "const uc = userClosedRaw ? dshUserClosedErrorOf(runKey, userClosedRaw) : null;",
    "IPC 直接 reject 的路径同样识别");
  has(DB, "dshRunStopBaseSet(runKey, stopBase);", "dshRunTask 起跑登记终止代号");
  has(DB, "dshRunStopBaseClear(runKey);", "收尾（成败两条）摘掉代号");
  no(DB, "return attempt(null).catch((err) => {", "原来的 catch-only 收尾已换成 then(ok, err) 双路");
}

console.log("\n[3] 呈现层：会话一条中性状态行；节点 / 助手 / 并行组不弹红 toast");
{
  has(DB, 'const USER_CLOSED_SRC = "user-closed";', "状态行有独立 _src（与 ix-round-end 同族）");
  has(DB, "function userClosedTrace(runKey, detail)", "会话状态行落盘函数存在");
  has(DB, '_src: USER_CLOSED_SRC,', "落盘带 _src");
  has(DB, '_detail: String(detail || "").slice(0, 4000),', "原始报文随消息存档（有上限）");
  has(DB, 'if (String(m._src || "") === USER_CLOSED_SRC) continue;', "状态行不进模型上下文");

  has(ASSIST, "function userClosedRowEl(m, nodeId, idx)", "会话里的状态行渲染函数存在");
  has(ASSIST, 'if (m && m._src === "user-closed") return userClosedRowEl(m, nodeId, idx);',
    "dshMsgBlock 走状态行分支（不画空气泡）");
  has(ASSIST, 'btn.textContent = I18n.t("详情");', "原始报文折叠在「详情」按钮后面");
  has(ASSIST, 'box.className = "dsh-closed-raw";', "展开的是一块原始报文");
  has(ASSIST, 'typeof dshUserClosedText === "function"', "状态行文案取统一真源");
  has(ASSIST, "if (typeof dshIsUserClosedError === \"function\" && dshIsUserClosedError(e)) {",
    "会话收尾先判用户主动关闭");
  has(ASSIST, "userClosedTrace(rk, (e && e.detail) || errMsg);", "会话落一条状态行（带原始报文）");
  ok(
    ASSIST.indexOf("dshIsUserClosedError(e)") < ASSIST.indexOf('toast(I18n.t("智能会话失败：")'),
    "用户关闭分支排在红 toast 之前（不会既落状态行又报错）",
  );
  has(ASSIST, '        _src: "user-closed",', "全局助手同样落状态行");

  has(NODES, 'if (typeof dshIsUserClosedError === "function" && dshIsUserClosedError(e)) {',
    "节点运行收尾先判用户主动关闭");
  has(NODES, 'node.error = typeof dshUserClosedText === "function" ? dshUserClosedText() : I18n.t("用户主动关闭会话");',
    "节点 error 写中性文案");
  has(NODES, "if (!quiet && !node._aborted) toast(node.error, \"warn\");",
    "节点侧只给中性 toast（不是「处理失败：」的红 toast）");

  has(PLAN, "function planTaskFailText(reason)", "并行子任务的成败文案有统一出口");
  has(PLAN, "if (typeof dshIsUserClosedError === \"function\" && dshIsUserClosedError(reason))",
    "并行子任务命中用户关闭时不写「失败：」");
  ok(
    (PLAN.match(/planTaskFailText\(r\.reason\)/g) || []).length >= 2,
    "会话内并行组与节点内并行组两处都改用它",
  );

  has(I18N, '"用户主动关闭会话": "Session closed by you",', "中英文词条齐");
  has(CSS, ".dsh-closed-line {", "状态行有中性样式（灰字，不是告警色）");
  has(CSS, ".dsh-closed-raw {", "展开的报文有样式（可滚动、不撑破会话）");
}

console.log("\n[4] 配置 bug：modelPolicies 里像数字的 id 必须写成字符串");
{
  const pol = require(path.join(ROOT, "dsh-compact-policy.js"));
  const text = read("dsh/gateway/cordis.yml");
  /* 现场复现：中转服务商自报的模型 id 是个数字，String() 之后裸写进 YAML 就成了 number */
  const cfg = {
    providers: [
      {
        id: "deepseek",
        type: "text_openai",
        baseUrl: "https://api.deepseek.com",
        models: ["deepseek-v4-flash", 123],
      },
    ],
  };
  const policy = pol.compactPolicyFromConfig(
    Object.assign({ dsh: { compact: { enabled: true, tier: "frugal" } } }, cfg),
  );
  const out = pol.applyCompactPolicy(text, policy).text.replace(/\r\n?/g, "\n");
  ok(out.indexOf('model: "123"') >= 0, "数字形态的模型 id 写成 model: \"123\"（YAML 里是字符串）");
  no(out, "model: 123\n", "不再有裸写的 model: 123（插件校验不会再报 expected string）");
  ok(out.indexOf("model: deepseek-v4-flash") >= 0,
    "普通 id 仍裸写（与出货组合逐字一致，往返无损不破）");
  const mid = pol.applyCompactPolicy(text, { enabled: true, tier: "mid" });
  ok(mid.text === text, "默认中档对出货 cordis.yml 仍是零改动（幂等没被引号破坏）");
  has(COMPACT, "function yamlScalarOf(v)", "标量写法收在一个函数里（provider 与 model 同一口径）");
}

console.log("\n[5] 文案统一：用户按停只出现「用户主动关闭会话」，自动终止仍算（已终止）");
{
  /* 会话收尾（■ 停止 / 全部终止 / 删除会话）：两条取消路径都改成落中性状态行 */
  ok(
    (ASSIST.match(/dshRunAutoStoppedSinceStart\(rk\)/g) || []).length >= 2,
    "会话的两条取消收尾都先判「是不是自动终止」",
  );
  has(ASSIST, 'dshRunAutoStoppedSinceStart("assist")', "全局助手同样区分用户按停 / 自动终止");
  ok(
    (ASSIST.match(/_src: "user-closed"/g) || []).length >= 3,
    "助手的三条收尾（正常收尾 / 取消 / 用户关闭错误）都落同一条状态行",
  );
  has(ASSIST, 'userClosedTrace(rk, (e && e.detail) || "");', "会话取消路径也落状态行（不带报文时为纯一句话）");
  has(LONGRUN, 'why = auto ? T("已终止") : T("用户主动关闭会话");', "长时自治面板同一套文案");
  has(DB, "if (dshRunAutoStoppedSinceStart(runKey)) return null;",
    "自动终止在判定层就排除掉（不会走到「用户主动关闭」）");
  has(DB, "dshCancelActive(runKey, { auto: true });", "看门狗盖的是自动终止戳");
  has(APPJS, 'dshStopMark(runKey ? String(runKey) : "", opts && opts.auto ? { auto: true } : undefined);',
    "用户入口（app.js 的 dshCancelActive）不带 auto");
  has(AGENTJS, 'dshStopMark(runKey ? String(runKey) : "", opts && opts.auto ? { auto: true } : undefined);',
    "用户入口（app-agent.js 的 dshCancelActive）不带 auto");
  /* 助手的这条状态行同样要落盘 / 重开可见，且不进模型上下文 */
  has(ASSIST, "if (m._src) o._src = String(m._src);", "助手存档带上 _src（重开仍是状态行）");
  has(ASSIST, "if (m._detail) o._detail = String(m._detail).slice(0, 4000);",
    "助手存档带上 _detail（原始报文不丢）");
  has(BOOT, "if (m._src) o._src = String(m._src);", "启动还原 _src（不然会变成空气泡）");
  has(BOOT, "if (m._detail) o._detail = String(m._detail);", "启动还原 _detail");
  has(ASSIST, ".filter((m) => !m._src)", "助手历史过滤掉界面痕迹（不会出现空的「用户：」）");
}

console.log("\n" + (fails ? "FAILED " + fails + " / " + checks : "ALL OK " + checks));
process.exit(fails ? 1 : 0);
