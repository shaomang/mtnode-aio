"use strict";
/* 新安装默认服务商播种：DeepSeek 只有 flash / pro 两个模型，且默认勾选「支持视觉」
 *   node test/smoke-default-provider.js
 * 需求：新安装 MTNode 时，默认提供商（DeepSeek）默认模型是 flash
 *       （deepseek-flash = V4.1-Flash，原生多模态、能识图）与 pro 两个，
 *       并默认勾选支持视觉；已下线的 deepseek-v4-flash / vision-exp 不再进清单；
 *       Key 为空（默认）时设置页上方显示 DeepSeek 官方充值通道
 *       https://platform.deepseek.com/ —— 那条横幅的回归在
 *       test/smoke-provider-settings.js [1b][6]，本文件只钉播种清单与视觉默认。
 * 覆盖：
 *   [1] renderer/app-boot.js 的 ensureDefaultProviders()：整表为空时播种
 *       [deepseek-flash, deepseek-v4-pro] + vision:true（不是三个模型、不是 vision:false）
 *   [2] 已有任何服务商时一律不动（用户删过 / 改过的不会被补回来）
 *   [3] 删除清单（removedProviders）里的默认项不再复活
 *   [4] 第二真源 main.js 的 config:load 兜底默认与启动播种逐字一致
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
const read = (rel) =>
  fs.readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8");

const DS_MODELS = ["deepseek-flash", "deepseek-v4-pro"];

const readText = (rel) => read(rel).replace(/\r\n/g, "\n");

/* ── 从真源里取出「默认模型常量 + 播种函数」，在最小沙箱里真跑一遍 ── */
const boot = readText("renderer/app-boot.js");
const constM = boot.match(/const DEEPSEEK_DEFAULT_MODELS = \[[\s\S]*?\];/);
const fnM = boot.match(
  /function ensureDefaultProviders\(\) \{[\s\S]*?\n\}\n/,
);
ok(!!constM, "app-boot.js 里能找到 DEEPSEEK_DEFAULT_MODELS 常量");
ok(!!fnM, "app-boot.js 里能找到 ensureDefaultProviders()");

function seedWith(config) {
  const sandbox = {
    console,
    S: { config: JSON.parse(JSON.stringify(config || {})) },
    I18n: { t: (s) => s },
  };
  vm.createContext(sandbox);
  vm.runInContext(constM[0] + "\n" + fnM[0] + "\nensureDefaultProviders();", sandbox);
  return sandbox.S.config;
}
const byId = (cfg, id) => (cfg.providers || []).find((p) => p && p.id === id);

console.log("\n[1] 全新空列表 → 只播种 flash / pro 两个模型 + 默认勾选支持视觉");
const seeded = seedWith({});
const ds = byId(seeded, "deepseek");
ok(!!ds, "播出了默认服务商 DeepSeek（id \"deepseek\"）");
ok(
  JSON.stringify(ds && ds.models) === JSON.stringify(DS_MODELS),
  "模型清单恰好是 flash（deepseek-flash）+ pro：" + JSON.stringify(ds && ds.models),
);
ok(
  !(ds && ds.models || []).some((m) => /vision|deepseek-v4-flash$/.test(String(m))),
  "已下线的 vision-exp / deepseek-v4-flash 不再进默认清单",
);
ok(ds && ds.vision === true, "默认勾选「支持视觉」（vision: true）");
ok(ds && ds.apiKey === "", "API Key 默认为空（→ 设置页显示官方充值通道）");
ok(
  ds && ds.baseUrl === "https://api.deepseek.com",
  "baseUrl 指向官方端点：https://api.deepseek.com",
);
ok(
  (seeded.providers || [])[0] === ds,
  "默认文本服务商排在首位（播种只做这一次排序）",
);
ok(!!byId(seeded, "gpt_image_2"), "图像默认项（GPT Image 2）仍在");

console.log("\n[2] 已有任何服务商 → 一律不动（尊重用户已保存的列表）");
const custom = [
  { id: "p1", name: "我的服务商", type: "text_openai", models: ["x"], vision: false },
];
const kept = seedWith({ providers: custom });
ok(
  JSON.stringify(kept.providers) === JSON.stringify(custom),
  "列表非空时原样保留（不补默认项、不改模型清单、不重排）",
);
ok(!byId(kept, "deepseek"), "被删掉的默认项不会因为打开设置 / 重启而复活");

const already = [
  { id: "deepseek", name: "DeepSeek", type: "text_openai", apiKey: "sk-x", models: ["my-model"], vision: false },
];
const kept2 = seedWith({ providers: already });
const ds2 = byId(kept2, "deepseek");
ok(
  ds2.models.length === 1 && ds2.models[0] === "my-model" && ds2.vision === false,
  "用户自己改过的模型清单 / 视觉勾选不被默认值覆盖",
);

console.log("\n[3] 删除清单里的默认项不复活");
const removed = seedWith({ providers: [], removedProviders: ["deepseek", "gpt_image_2"] });
ok(
  !byId(removed, "deepseek") && !byId(removed, "gpt_image_2"),
  "removedProviders 命中时两条默认项都不再播种",
);

console.log("\n[4] main.js（config:load 兜底）与启动播种同口径");
const main = readText("main.js");
const at = main.indexOf('id: "deepseek"');
const block = at < 0 ? "" : main.slice(at, at + 420);
ok(at >= 0, "main.js 的默认配置里有 DeepSeek 服务商");
ok(
  /models:\s*\[\s*"deepseek-flash"\s*,\s*"deepseek-v4-pro"\s*\]/.test(block),
  "main.js 默认模型清单 = [deepseek-flash, deepseek-v4-pro]（没有第三个模型）",
);
ok(!/models:[\s\S]{0,200}vision-exp/.test(block), "main.js 默认清单里没有 vision-exp");
ok(
  !/models:[\s\S]{0,200}"deepseek-v4-flash"/.test(block),
  "main.js 默认清单里没有已下线的 deepseek-v4-flash",
);
ok(/vision:\s*true/.test(block), "main.js 默认 vision: true（与启动播种一致）");
ok(/apiKey:\s*""/.test(block), "main.js 默认 API Key 为空");
ok(
  main.indexOf('models: [\n            "deepseek-v4-flash",\n            "deepseek-v4-pro",\n            "deepseek-v4-flash-vision-exp",\n          ]') < 0,
  "main.js 里旧的「三个模型」写法已清除",
);

console.log(
  "\n" + (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ 全部 " + checks + " 项通过"),
);
process.exit(fails ? 1 : 0);