"use strict";
/* 会话引擎自动命名闸位（app-assist.js）—— 冒烟测试（纯 Node，无 Electron / 无 DOM）
 *   node test/smoke-session-auto-title.js
 * 需求：修复普通 Agent 助手新会话首轮跑完，标题仍停在引擎 5 词回落
 *       ("You are a direct executor.")、LLM 主题标题永不生效的问题。
 * 根因：引擎 dsh-session-title 每次 user/message 先 append 5 词回落(fallback)、
 *       再异步 append LLM 主题(provider)；网关将两者一视同仁转发、丢掉 source；
 *       渲染层把先到的 fallback 当最终主题并置 titleAuto=true 上锁，真主题被拒收。
 * 覆盖（钉住 task 1+2 对 app-assist.js / gateway.mjs 的闸位改动）：
 *   [1] agentSessionSend：自动命名武装位 st._autoTitleRound 一次性武装
 *       = !st.titleAuto && !st.titleLocked（不再按用户消息数重置）；
 *   [2] applyAutoSessionTitle：按来源(source)分流 —— provider/user 定名上锁，
 *       fallback/缺省仅占位、不置 titleAuto、保持武装让真主题可覆盖；
 *   [3] 回落命名（首条消息前 24 字）只受 titleLocked 约束、不写 titleAuto，
 *       与开发/细化绑定会话不触发该回落分支 两条既有语义保持不被破坏。
 */
const fs = require("fs");
const path = require("path");

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
const read = (rel) =>
  fs.readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8");
const SRC = read("renderer/app-assist.js");
const GW = read("dsh/gateway/gateway.mjs");

/* ===================== [1] 武装位一次性化 ===================== */
console.log("\n[1] agentSessionSend：武装位不再按用户消息数重置");
ok(
  /st\._autoTitleRound\s*=\s*!st\.titleAuto\s*&&\s*!st\.titleLocked/.test(SRC),
  "武装位 st._autoTitleRound = !st.titleAuto && !st.titleLocked（一次武装、常驻放行）",
);
ok(
  !/st\._autoTitleRound\s*=.*messages[\s\S]{0,80}\.role\s*===\s*"user"[\s\S]{0,40}length\s*<=\s*1/.test(SRC),
  "不再按「用户消息数 ≤1」每次发送重算武装位（旧逻辑已移除）",
);
ok(
  (SRC.match(/st\._autoTitleRound\s*=/g) || []).length >= 1,
  "app-assist.js 仍对 _autoTitleRound 做赋值（无删改后空转）",
);

/* ===================== [2] applyAutoSessionTitle：来源分流 ===================== */
console.log("\n[2] applyAutoSessionTitle：按来源(source)分流，fallback 不锁位");
const fnMatch = SRC.match(
  /function applyAutoSessionTitle\(st,\s*raw,\s*srcKind\)\s*\{[\s\S]*?\n\}/,
);
ok(!!fnMatch, "存在 applyAutoSessionTitle(st, raw, srcKind) 函数体（带第三入参 srcKind）");
if (fnMatch) {
  const body = fnMatch[0];
  ok(
    /if\s*\(!st\s*\|\|\s*st\.titleLocked\s*\|\|\s*!st\._autoTitleRound\)\s*return\s*false/.test(
      body,
    ),
    "首道闸 = !st || titleLocked || !_autoTitleRound（titleAuto 撤出首道闸，仅 provider/user 置位）",
  );
  /* 来源分流：provider/user 定名上锁；fallback/缺省仅占位 */
  ok(
    /if\s*\(srcKind\s*===\s*"provider"\s*\|\|\s*srcKind\s*===\s*"user"\)/.test(body),
    "provider/user 分支：写 st.title、置 titleAuto=true、关武装位",
  );
  const prov = body.match(
    /if\s*\(srcKind\s*===\s*"provider"\s*\|\|\s*srcKind\s*===\s*"user"\)\s*\{[\s\S]*?\n\}/,
  );
  if (prov) {
    ok(
      /st\.titleAuto\s*=\s*true/.test(prov[0]) &&
        /st\._autoTitleRound\s*=\s*false/.test(prov[0]) &&
        /if\s*\(srcKind\s*===\s*"user"\)\s*st\.titleLocked\s*=\s*true/.test(prov[0]),
      "provider 置 titleAuto+关武装位；user 额外置 titleLocked（最终定名、不让位）",
    );
  } else {
    ok(false, "provider/user 分流块细节未定位");
  }
  const fb = body.match(/else\s*\{[\s\S]*?\n\}/);
  ok(!!fb, "存在 fallback/缺省 else 分支");
  if (fb) {
    ok(
      /if\s*\(st\.title\)\s*return\s*false/.test(fb[0]),
      "fallback/缺省：仅当前无标题时占位写一次",
    );
    ok(
      !/titleAuto/.test(fb[0]) && !/titleLocked/.test(fb[0]),
      "fallback/缺省：绝不置 titleAuto / titleLocked（真实主题仍可覆盖）",
    );
  }
  ok(
    /st\.title\s*=\s*next/.test(body) && /st\.titleAuto\s*=\s*true/.test(body),
    "provider/user 命中写 st.title 并置 titleAuto = true",
  );
}

/* ===================== [2b] 调用点透传 source ===================== */
console.log("\n[2b] 调用点：applyAutoSessionTitle(st, title, source) 透传第三参");
ok(
  /applyAutoSessionTitle\s*\(\s*st\s*,\s*\((?:data\s*&&\s*)?data\.title\)\s*\|\|\s*""/.test(
    SRC,
  ) &&
    /,\s*\((?:data\s*&&\s*)?data\.source\)\s*\|\|\s*""\s*\)\s*;/.test(SRC),
  "渲染层调用点把网关透传的 data.source 作为 srcKind 传入 applyAutoSessionTitle",
);
ok(
  /applyAutoSessionTitle\s*\(\s*st\s*,\s*\(data\s*&&\s*data\.title\)\s*\|\|\s*""\s*,\s*\(data\s*&&\s*data\.source\)\s*\|\|\s*""\s*\)/.test(
    SRC,
  ),
  "调用点缺省 source 归一为空串（fallback 语义）",
);

/* ===================== [2c] 网关透传 source ===================== */
console.log("\n[2c] 网关：session/title 事件转发时透传来源 source");
ok(
  /emit\(\s*['"]title['"]\s*,\s*\{\s*title:\s*ev\.data\.title\s*,\s*source:\s*\(\s*ev\.data\.source\s*&&\s*ev\.data\.source\.kind\s*\)\s*\|\|\s*['']['']\s*,?\s*\}/
    .test(GW),
  "gateway.mjs emit('title', {title, source: (ev.data.source&&.kind)||''}) 透传 source.kind",
);

/* ===================== [3] 回落命名与既有语义不被破坏 ===================== */
console.log("\n[3] 回落命名语义保持：只受 titleLocked 约束、开发绑定会话不受影响");
const fallback = SRC.match(/st\.title\s*=\s*t\.slice\(0,\s*24\)[^\n]*/);
ok(!!fallback, "回落命名（首条消息前 24 字）仍在 agentSessionSend 里保留");
ok(
  /if\s*\(!st\.titleLocked\)\s*\n?\s*st\.title\s*=\s*t\.slice\(0,\s*24\)/.test(SRC),
  "回落命名只受 titleLocked 约束（不写 titleAuto、不触碰新武装位）",
);
/* 回落命名只发生在「非开发/细化绑定会话」追加消息分支里：合并模式下 devContractMsg
   走 else 分支（内容上方注释「合并模式不追加消息…标题保持创建时设定不被覆盖」），
   不触发这条 24 字回落 —— 绑定会话标题交给引擎自动命名即可。 */
const mergeBlock = SRC.match(
  /if\s*\(!devContractMsg\)\s*\{[\s\S]{0,400}?st\.title\s*=\s*t\.slice\(0,\s*24\)/,
);
ok(!!mergeBlock, "回落命名（24 字）位于 !devContractMsg 追加消息块内（绑定会话不触发）");
/* 同一轮内先做回落命名、再放行引擎自动命名：两次赋值在同一函数 agentSessionSend
   中按先后顺序出现（两者之间隔 devContractMsg 的 else 块，不做邻接断言） */
const iFallback = SRC.indexOf("st.title = t.slice(0, 24)");
const iArm = SRC.indexOf("st._autoTitleRound = !st.titleAuto && !st.titleLocked");
ok(
  iFallback >= 0 && iArm > iFallback,
  "同一轮内先回落命名、后放行引擎命名（回落不写 titleAuto、让引擎命名可落地）",
);

console.log(
  "\n" +
    (fails
      ? "FAILED " + fails + " / " + checks + " checks"
      : "ALL OK  " + checks + " checks"),
);
process.exit(fails ? 1 : 0);
