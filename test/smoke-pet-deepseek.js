"use strict";
/* 桌宠 BongoChat 能用 DeepSeek 官方供应商 —— 冒烟测试（纯 Node，无 DOM / 无 Electron）
 *   node test/smoke-pet-deepseek.js
 * 故障现象：桌宠对话页「服务商」下拉只列非 DeepSeek 的第三方服务商 —— DeepSeek 官方
 *       那一行（config.json 里 id "deepseek"，baseUrl https://api.deepseek.com）被过滤掉，
 *       于是既选不到官方供应商，配置里已存的 "deepseek" 又不在列表里被前端回落到第一家
 *       第三方（选中的显示与实际请求的服务商不一致），官方模型也一起落到别家模型清单外。
 * 修复：服务商解析收敛到 pet/pet-provider.js 单一真源 —— 官方服务商在列表里以
 *       "deepseek-official"（与引擎 llm-deepseek 路由同名）出现，路由 / 密钥 / 模型
 *       一律按它下发；chat-ui 只按点名的服务商填模型，不再无条件回落第一家。
 * 覆盖：
 *   [1] listTextProviders：官方在列且值 = "deepseek-official"；第三方照旧；去重与缺 Key 过滤
 *   [2] resolveChatProvider：官方 id/路由名/兜底三条路径都解析出官方行 + 正确模型
 *   [3] dshRouteForProvider / mtnodePiProviders：官方走官方路由、不进 mtnode_* 表
 *   [4] deepseekWebSearchKey：联网搜索固定取官方 Key
 *   [5] 对话页（pet/chat-ui 与随包副本）：服务商下拉用后端给的 id、只按点名服务商填模型
 *   [6] 接入口径：standalone-main.js 走共享模块、不再自带一份解析；build.json 白名单已登记
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

const PetProvider = require("../pet/pet-provider.js");

/* 与真机同形的配置：官方 deepseek（有 Key）+ 两家第三方（一家缺 Key）+ 一行图像服务商 */
const APP_CFG = {
  providers: [
    {
      id: "deepseek",
      name: "DeepSeek",
      type: "text_openai",
      baseUrl: "https://api.deepseek.com",
      apiKey: "sk-official-key",
      models: ["deepseek-flash", "deepseek-v4-pro"],
    },
    {
      id: "qwen-token-plan-cn",
      name: "阿里云百炼",
      type: "text_openai",
      baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      apiKey: "sk-third-key",
      models: ["qwen3.8-max", "deepseek-v4.1-flash"],
    },
    {
      id: "nokey",
      name: "NoKey",
      type: "text_openai",
      baseUrl: "https://nokey.example/v1",
      apiKey: "",
      models: ["m"],
    },
    {
      id: "gpt_image_2",
      name: "GPT Image 2",
      type: "image_openai",
      baseUrl: "https://api.apiyi.com/v1",
      apiKey: "sk-img",
      models: ["gpt-image-2-vip"],
    },
  ],
};

console.log("\n[1] 服务商下拉：DeepSeek 官方必须在列（值 = deepseek-official）");
const list = PetProvider.listTextProviders(APP_CFG);
const ids = list.map((p) => p.id);
ok(ids[0] === "deepseek-official", "官方排在第一项（与设置页「默认项排首位」同口径）");
ok(
  list[0] && list[0].name === "DeepSeek 官方" && list[0].models.includes("deepseek-flash"),
  "官方项带展示名与官方模型清单（deepseek-flash）",
);
ok(ids.includes("qwen-token-plan-cn"), "第三方服务商照旧在列（用配置里的 id）");
ok(!ids.includes("deepseek"), "旧 id「deepseek」不再单独成项（避免与官方项重复）");
ok(ids.includes("nokey") === false, "没填 Key 的服务商不列出（与旧行为一致）");
ok(!ids.includes("gpt_image_2"), "图像服务商不进文本对话列表");

console.log("\n[2] 本轮服务商 / 模型解析");
const rSavedId = PetProvider.resolveChatProvider(
  { chatProviderId: "deepseek", chatModel: "deepseek-flash" },
  APP_CFG,
);
ok(
  rSavedId && rSavedId.provider.id === "deepseek" && PetProvider.isDeepseekHost(rSavedId.provider.baseUrl),
  "已存旧 id「deepseek」（真机 pet/config.json 现状）仍解析到官方行",
);
ok(rSavedId && rSavedId.model === "deepseek-flash", "已存官方模型原样保留");
ok(
  rSavedId && rSavedId.provider.apiKey === "sk-official-key",
  "官方 Key 随解析结果下发（供网关 llm-deepseek 使用）",
);
const rRouteName = PetProvider.resolveChatProvider(
  { chatProviderId: "deepseek-official", chatModel: "deepseek-v4-pro" },
  APP_CFG,
);
ok(
  rRouteName && rRouteName.provider.id === "deepseek" && rRouteName.model === "deepseek-v4-pro",
  "下拉现值「deepseek-official」能解析回官方行（存的是路由名也不丢）",
);
const rNoChoice = PetProvider.resolveChatProvider({}, APP_CFG);
ok(
  rNoChoice && rNoChoice.provider.id === "qwen-token-plan-cn",
  "没点名时保持旧兜底：优先第三方（不改变既有默认行为）",
);
const rBadModel = PetProvider.resolveChatProvider(
  { chatProviderId: "deepseek", chatModel: "qwen3.8-max" },
  APP_CFG,
);
ok(
  rBadModel && rBadModel.model === "deepseek-flash",
  "旧模型不属于所选服务商时落回该服务商首个模型（否则对端 404）",
);

console.log("\n[2b] 面板回显值归一（存的是行 id、选的是路由名）");
ok(
  PetProvider.routeNameOf("deepseek", APP_CFG) === "deepseek-official",
  "chatProviderId「deepseek」（真机现状）归一成下拉选项值「deepseek-official」",
);
ok(
  PetProvider.routeNameOf("DeepSeek", APP_CFG) === "deepseek-official",
  "按官方行名称存的旧值同样归一",
);
ok(
  PetProvider.routeNameOf("qwen-token-plan-cn", APP_CFG) === "qwen-token-plan-cn",
  "第三方 id 原样返回（不误判成官方）",
);
ok(PetProvider.routeNameOf("", APP_CFG) === "", "没存过（空串）保持空串 —— 面板走默认首项");
const listProviderIds = new Set(PetProvider.listTextProviders(APP_CFG).map((p) => p.id));
ok(
  listProviderIds.has(PetProvider.routeNameOf("deepseek", APP_CFG)),
  "归一后的值一定落在下拉选项里（选项选中态不再落空）",
);

console.log("\n[3] 网关路由下发");
const official = APP_CFG.providers[0];
const third = APP_CFG.providers[1];
ok(
  PetProvider.dshRouteForProvider(official) === "deepseek-official",
  "官方行 → deepseek-official（llm-deepseek 官方路由）",
);
ok(
  PetProvider.dshRouteForProvider(third) === "mtnode_qwen-token-plan-cn",
  "第三方行 → mtnode_<id>（pi-ai 路由）",
);
const pi = PetProvider.mtnodePiProviders(APP_CFG);
ok(
  pi.length === 1 && pi[0].route === "qwen-token-plan-cn",
  "官方不进 mtnode_* 路由表（否则会被当第三方服务商注册）",
);
ok(
  Array.isArray(pi[0].models) && pi[0].models.every((m) => typeof m === "string"),
  "路由表模型归一成字符串 id（网关 applySettings 直接写 YAML）",
);

console.log("\n[4] 联网搜索固定用官方 Key");
ok(
  PetProvider.deepseekWebSearchKey(APP_CFG) === "sk-official-key",
  "deepseekWebSearchKey 取官方那一行的 Key（与主程序智能会话一致）",
);
ok(
  PetProvider.deepseekWebSearchKey({ providers: [third] }) === "",
  "没有官方行时回空串（不误用第三方 Key）",
);

console.log("\n[5] 对话页：按点名服务商填模型，官方选项不丢");
for (const rel of ["pet/chat-ui/chat.js", "pet-pack/chat.js"]) {
  const chat = read(rel);
  ok(
    /const hit = providers\.find\(\(x\) => x\.id === provId\);\s*\n\s*const p = hit \|\| providers\[0\];/.test(chat),
    rel + "：只在没点名时才回落 providers[0]（点名的官方选项不再被顶掉）",
  );
  ok(
    /if \(selectedModel && !matched && modelSel\.firstChild\)/.test(chat),
    rel + "：已存模型不在清单时显式选中第一项（显示与实际一致）",
  );
}
const chatHtml = read("pet/chat-ui/chat.html");
ok(
  /id="provSel"/.test(chatHtml) && /id="modelSel"/.test(chatHtml),
  "对话页服务商 / 模型下拉仍在（官方项由后端 providers 列表驱动，无需改 HTML）",
);

console.log("\n[6] 接入口径：单一真源 + 随包白名单");
const stand = read("pet/standalone-main.js");
ok(
  /const PetProvider = require\("\.\/pet-provider\.js"\);/.test(stand),
  "standalone-main.js 引入共享模块 pet/pet-provider.js",
);
ok(
  /function resolveChatProvider\(cfg\) \{\s*\n\s*return PetProvider\.resolveChatProvider\(cfg, readAppConfig\(\)\);/.test(stand),
  "standalone-main.js 的 resolveChatProvider 转调共享实现（不再自带第二份）",
);
ok(
  stand.indexOf("function mtnodePiProvidersFromApp() {\n  const out = [];") < 0,
  "standalone-main.js 里旧的 mtnodePiProvidersFromApp 手写实现已移除",
);
const build = read("build.json");
ok(
  /"pet\/pet-provider\.js"/.test(build),
  "build.json files 白名单登记 pet/pet-provider.js（否则打包后 Cannot find module）",
);
ok(
  !/"pet\/pet-relay-cred\.js"/.test(build),
  "build.json 白名单里没有已删的 pet/pet-relay-cred.js（桌宠不再自带领票模块，Key 就在配置卡上）",
);
ok(
  /chatProviderId: PetProvider\.routeNameOf\(cfg\.chatProviderId, appCfg\)/.test(stand),
  "pet:listProviders 下发归一的 chatProviderId（面板选中官方项）",
);

console.log(
  "\n" +
    (fails
      ? "FAILED " + fails + " / " + checks + " checks"
      : "ALL OK  " + checks + " checks"),
);
process.exit(fails ? 1 : 0);