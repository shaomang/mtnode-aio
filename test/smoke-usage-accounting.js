/* 冒烟：网关 token 统计（本次需求 · 修「Token 报告没统计到任何数据」）
 *
 * 事故：dsh 0.2 的运行时**不再发 `assistant/chunk` 增量帧**（实测本机会话日志里 0 条），
 * 用量只挂在完整 `assistant/message` 的 `data.usage` 上。而 `handleRun` 的统计分支只在
 * `case 'assistant/chunk'` 里看 `c.type === 'usage'` → **一个 token 都记不到**：
 * 会话末尾的 Token 报告全是 0（现场表现就是「报告没生效」）。
 *
 * 这一只钉两件事（离线，不出网、不装运行时）：
 *   [1] `accountUsage` 真函数跑：token 累计 / 逐模型台账 / 调用数 / LLM 用时 /
 *       TTFT 样本 / prefill / genMs / usage 帧（带 provider·model 归属）都对；
 *   [2] 接线：两个来源（chunk 的 c.usage、message 的 data.usage）都调它；全 0 的 usage 跳过；
 *       `assistant/message` 分支确实在 handleRun 的统计 switch 里（不是只在 mapNotification 里）。
 * 真跑复核（要密钥 + 出网，手动）：`node test/_probe-gateway-usage.mjs`。
 *
 * 跑法：node test/smoke-usage-accounting.js
 */
const fs = require("fs");
const path = require("path");

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
const GW = fs.readFileSync(path.join(ROOT, "dsh", "gateway", "gateway.mjs"), "utf8");

/* ── 从真源码里抠出 accountUsage 的函数体（朴素括号配对；字符串/注释里的括号不算） ── */
function fnBody(src, name) {
  const at = src.indexOf("function " + name + "(");
  if (at < 0) throw new Error("函数没找到：" + name);
  let depth = 0;
  let inStr = null;
  let inLine = false;
  let inBlock = false;
  for (let j = src.indexOf("{", at); j < src.length; j++) {
    const c = src[j];
    const p = src[j - 1];
    if (inLine) {
      if (c === "\n") inLine = false;
      continue;
    }
    if (inBlock) {
      if (c === "*" && src[j + 1] === "/") {
        inBlock = false;
        j++;
      }
      continue;
    }
    if (inStr) {
      if (c === inStr && p !== "\\") inStr = null;
      continue;
    }
    if (c === "/" && src[j + 1] === "/") {
      inLine = true;
      continue;
    }
    if (c === "/" && src[j + 1] === "*") {
      inBlock = true;
      j++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(src.indexOf("{", at) + 1, j);
    }
  }
  throw new Error("函数体不闭合：" + name);
}

/* ── 用真函数跑一遍记账（桩：stats / modelBucket / emit） ── */
function makeCtx(stepStart, stepTtft) {
  const stats = {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    reasoningTokens: 0, llmMs: 0,
  };
  const bucket = {
    provider: "deepseek-official", model: "deepseek-flash",
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    reasoningTokens: 0, calls: 0, llmMs: 0, ttftMs: 0, ttftSamples: 0,
    prefillTokens: 0, genMs: 0,
  };
  const frames = [];
  const fn = new Function(
    "metrics", "u", "t",
    fnBody(GW, "accountUsage"),
  );
  return {
    stats, bucket, frames, fn,
    metrics: { stats, stepStart, stepTtft, modelBucket: () => bucket, emit: (n, d) => frames.push({ n, d }) },
  };
}

section("[1] accountUsage 真函数：一次调用的账目");
{
  const c = makeCtx(1000, 250);
  const u = {
    inputTokens: 4503, outputTokens: 3, cacheReadTokens: 23296,
    cacheWriteTokens: 0, reasoningTokens: 0,
  };
  c.fn(c.metrics, u, 3456);
  ok(c.stats.inputTokens === 4503, "输入 token 进合计 (4503 vs " + c.stats.inputTokens + ")");
  ok(c.stats.cacheReadTokens === 23296, "缓存读进合计 (23296 vs " + c.stats.cacheReadTokens + ")");
  ok(c.stats.outputTokens === 3, "输出 token 进合计 (3 vs " + c.stats.outputTokens + ")");
  ok(c.bucket.inputTokens === 4503 && c.bucket.outputTokens === 3, "同额进逐模型台账桶");
  ok(c.bucket.calls === 1, "调用次数 +1 (1 vs " + c.bucket.calls + ")");
  ok(c.stats.llmMs === 2456 && c.bucket.llmMs === 2456, "LLM 用时 = t - stepStart (2456 vs " + c.stats.llmMs + ")");
  ok(c.bucket.ttftMs === 250 && c.bucket.ttftSamples === 1, "TTFT 样本入桶 (250 / 1)");
  ok(
    c.bucket.prefillTokens === 4503 + 23296,
    "prefill = 计费输入（入 + 缓存读 + 缓存写）(" + c.bucket.prefillTokens + ")",
  );
  ok(c.bucket.genMs === 2456 - 250, "genMs = LLM 用时 - TTFT (" + c.bucket.genMs + ")");
  ok(c.frames.length === 1 && c.frames[0].n === "usage", "下发一帧 usage（会话报告靠它实时增长）");
  const d = c.frames[0] && c.frames[0].d;
  ok(
    !!d && d.provider === "deepseek-official" && d.model === "deepseek-flash" && d.at === 3456,
    "usage 帧带 provider / model / at 归属",
  );
  ok(
    !!d && d.inputTokens === 4503 && d.cacheReadTokens === 23296 && d.outputTokens === 3,
    "usage 帧的 token 数字与入参一致",
  );
}

section("[1b] 边界：没有 step/start（stepStart=0）时不记脏的 LLM 用时");
{
  const c = makeCtx(0, 0);
  c.fn(c.metrics, { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, 9);
  ok(c.stats.llmMs === 0, "stepStart 缺失 → llmMs 记 0（不拿 epoch 差当用时）");
  ok(c.bucket.ttftSamples === 0, "没有 TTFT 采样就不多记样本");
  ok(c.bucket.genMs === 0, "genMs 也不虚增 (0 vs " + c.bucket.genMs + ")");
}

section("[2] 接线：两个来源都记账 + 0.2 的真源在 handleRun 的统计 switch 里");
{
  ok(/case 'assistant\/message'/.test(GW), "统计 switch 里有 case 'assistant/message'（0.2 的用量真源）");
  ok(
    /const ru = d && d\.usage/.test(GW),
    "assistant/message 分支读 data.usage（不是 c.usage —— 0.2 没有 chunk）",
  );
  /* 两处调用点：必须都是 accountUsage(...)，且各自带上真实的 stepStart / stepTtft */
  const calls = GW.split("accountUsage({ stats, modelBucket, emit, stepStart, stepTtft }, u, t)").length - 1;
  ok(calls === 2, "chunk 的 c.usage 与 message 的 data.usage 都调 accountUsage（实得 " + calls + " 处）");
  ok(
    /if \(c\.type === 'usage' && c\.usage\) \{[\s\S]{0,600}?accountUsage\(/.test(GW),
    "chunk 分支保留老运行时兼容（发 chunk 的运行时照旧记账）",
  );
  ok(
    !/(?<!metrics\.)stats\.inputTokens \+=/.test(GW),
    "记账只有 accountUsage 一处（不在两个分支各抄一份，改一处即生效）",
  );
  /* 全 0 的 usage 必须跳过：否则会凭空多一「次」调用，把均值与模型桶拉歪 */
  ok(
    /!u\.inputTokens && !u\.outputTokens && !u\.cacheReadTokens &&[\s\S]{0,80}?!u\.reasoningTokens[\s\S]{0,40}?break/.test(GW),
    "五个口径全 0 的 usage 直接 break（无用量权威值就不记账）",
  );
  /* 报告里的上下文窗口来自 request/context，这条早已在位 —— 顺带钉住，别在重构里丢 */
  ok(
    /case 'request\/context':[\s\S]{0,120}?contextWindow/.test(GW),
    "contextWindow 仍从 request/context 采集（报告与费用口径要用）",
  );
}

section("[3] 探针在位（真跑复核的入口）");
{
  const probe = path.join(ROOT, "test", "_probe-gateway-usage.mjs");
  ok(fs.existsSync(probe), "test/_probe-gateway-usage.mjs 在位（真连一次官方 API 复核统计）");
  const src = fs.readFileSync(probe, "utf8");
  ok(/USAGE FRAMES/.test(src) && /inputTokens/.test(src), "探针输出 usage 帧数与 done.metrics 的 token");
}

console.log(
  "\n" + (fails ? "✗ " + fails + " 项失败" : "✓ " + checks + " 项全部通过") + "  (smoke-usage-accounting)",
);
process.exit(fails ? 1 : 0);
