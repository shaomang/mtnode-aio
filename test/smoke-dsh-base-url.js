"use strict";
/* dsh 0.2 的 Messages 端点根归一 —— 冒烟测试（纯 Node，无 DOM、不联网）
 *   node test/smoke-dsh-base-url.js
 *
 * 事故（2026-09-30 实测，真 key）：dsh 0.2 的 llm-deepseek 把 `baseURL` 当
 * **Messages 兼容的端点根**，自己在其后拼 `/v1/messages`；而 MTNode 的服务商配置里存的是
 * OpenAI 兼容根 `https://api.deepseek.com` → 实际请求打到
 *   https://api.deepseek.com/v1/messages   → 404（空体）
 * 而 DeepSeek 的 Messages 面在
 *   https://api.deepseek.com/anthropic/v1/messages → 200（真回复）
 * 0.1 代没有这一层，所以 0.2 升级后必须在网关侧补一次归一（`messages-base-url.mjs`）。
 *
 * 覆盖：
 *   [1] 归一函数：官方裸根补 /anthropic；已带路径 / 第三方端点 / 非法输入一律不动
 *   [2] isMessagesBaseUrl 判定
 *   [3] 接线口径：gateway.mjs 真的用了它（不是只写了个模块）
 *   [4] DESIGN.md 记下这条 0.2 行为变化
 */
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

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
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

(async () => {
  const M = await import(pathToFileURL(path.join(ROOT, "dsh/gateway/messages-base-url.mjs")).href);

  console.log("\n[1] 归一：只动官方裸根");
  const cases = [
    ["https://api.deepseek.com", "https://api.deepseek.com/anthropic", "官方裸根 → 补 /anthropic（0.2 的 Messages 面在这）"],
    ["https://api.deepseek.com/", "https://api.deepseek.com/anthropic", "带尾斜杠的裸根同样补"],
    ["  https://api.deepseek.com  ", "https://api.deepseek.com/anthropic", "两侧空白不影响判定"],
    ["https://api.deepseek.com/anthropic", "https://api.deepseek.com/anthropic", "已经带 /anthropic 不动（幂等）"],
    ["https://api.deepseek.com/anthropic/v1", "https://api.deepseek.com/anthropic/v1", "带 /anthropic/v1 不动"],
    ["https://api.deepseek.com/v1", "https://api.deepseek.com/v1", "用户显式写了 /v1 = 他自己指定端点，不猜"],
    ["https://api.apiyi.com/v1", "https://api.apiyi.com/v1", "第三方域原样透传（各有各的 Messages 根）"],
    ["http://127.0.0.1:8765/v1", "http://127.0.0.1:8765/v1", "本地 llama 端点原样透传"],
    ["", "", "空输入回空串（不凭空造端点）"],
    [null, "", "null 回空串"],
    ["not a url", "not a url", "非法 URL 原样交回（让运行时报它自己的错）"],
    ["ftp://api.deepseek.com", "ftp://api.deepseek.com", "非 http(s) 不碰"],
  ];
  for (const [input, want, msg] of cases) {
    const got = M.messagesBaseUrl(input);
    ok(got === want, msg + (got === want ? "" : `（得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}）`));
  }
  ok(M.messagesBaseUrl("https://api.deepseek.com") === M.messagesBaseUrl(M.messagesBaseUrl("https://api.deepseek.com")),
    "归一幂等（重跑同一份配置不会越补越长）");

  console.log("\n[2] isMessagesBaseUrl 判定");
  ok(M.isMessagesBaseUrl("https://api.deepseek.com/anthropic") === true, "官方 /anthropic 判 true");
  ok(M.isMessagesBaseUrl("https://api.deepseek.com") === false, "官方裸根判 false（就是它导致 404）");
  ok(M.isMessagesBaseUrl("https://api.apiyi.com/v1") === true, "第三方端点不归我们管，判 true");
  ok(M.isMessagesBaseUrl("") === false && M.isMessagesBaseUrl("oops") === false, "空 / 非法判 false");

  console.log("\n[3] 接线口径");
  {
    const gw = read("dsh/gateway/gateway.mjs");
    ok(/import \{ messagesBaseUrl \} from '\.\/messages-base-url\.mjs'/.test(gw), "gateway.mjs 引入归一函数");
    ok(/env\.DEEPSEEK_BASE_URL = messagesBaseUrl\(baseUrl\)/.test(gw), "下发运行时的 baseURL 走归一");
    ok(!/env\.DEEPSEEK_BASE_URL = baseUrl\b/.test(gw), "没有把用户配置的裸根直接下发（那正是 404 那条路）");
    ok(/messagesApiRoot|0\.2/.test(gw) || /dsh 0\.2 的 llm-deepseek/.test(gw), "现场注释说明为什么要有这一层");
    const design = read("dsh/DESIGN.md");
    ok(/messages-base-url\.mjs/.test(design), "DESIGN.md 记了这个模块");
    ok(/api\.deepseek\.com\/v1\/messages/.test(design) && /404/.test(design), "DESIGN.md 记下实测的 404 现象与地址");
  }

  console.log("\n" + (fails ? "FAILED " + fails + " / " + checks + " checks" : "ALL OK  " + checks + " checks"));
  process.exit(fails ? 1 : 0);
})();
