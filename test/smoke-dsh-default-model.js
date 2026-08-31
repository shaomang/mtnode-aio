"use strict";
/* 设置「默认模型（智能能力使用）」不再被强制指定 deepseek 模型 —— 冒烟测试（纯 Node，无 DOM）
 *   node test/smoke-dsh-default-model.js
 * 需求：默认模型下拉必须列出全部文本服务商的模型（按服务商分组），未保存时默认值
 *       跟随实际生效的智能路由（preferredAgentProviderRoute，优先其它文本服务商），
 *       不再硬编码 deepseek-v4-flash；启动缺省合并也不再写入 deepseek 模型。
 * 覆盖：
 *   [1] app-settings.js 下拉构建：optgroup 分组遍历 mtnodePiProviders() 全部文本服务商
 *   [2] 未保存时默认值来自 preferredAgentModelForRoute(preferredAgentProviderRoute())
 *   [3] app-settings.js 不再出现 hardcoded deepseek-v4-flash 兜底
 *   [4] app-boot.js dsh 缺省合并 model 为空串（不再启动即强制 deepseek）
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

console.log("\n[1] 默认模型下拉 = 全部文本服务商的模型（按服务商分组）");
const settings = read("renderer/app-settings.js");
ok(
  /mtnodePiProviders\(\)/.test(settings),
  "下拉构建遍历 mtnodePiProviders()（全部非 DeepSeek 文本服务商，不再只取第一个 DeepSeek 服务商）",
);
ok(
  /optgroup/.test(settings),
  "模型按服务商 optgroup 分组展示（与智能会话 / 全局助手同源）",
);
ok(
  /dp\.models\.map\(\(m\) => String\(m\)\)/.test(settings),
  "DeepSeek 官方组取 dshProvider().models",
);
ok(
  /groups\.push\(\{ label: p\.name, models: models\.map\(\(m\) => String\(m\)\) \}\)/.test(settings),
  "其余每个文本服务商各成一组的模型列表",
);

console.log("\n[2] 未保存时默认值跟随实际生效的智能路由");
ok(
  /preferredAgentModelForRoute\(preferredAgentProviderRoute\(\)\)/.test(settings),
  "默认值 = 生效智能路由的默认模型（优先其它文本服务商，不硬编码 deepseek）",
);
ok(
  /保底：老配置里保存过、但已不在任何服务商模型清单中的值/.test(settings),
  "老配置里保存过但不在清单中的模型仍能显示（不丢失用户已选值）",
);
ok(
  /（无可用模型）/.test(settings),
  "无任何模型时给出「无可用模型」空态",
);

console.log("\n[3] 硬编码兜底已清除");
ok(
  settings.indexOf("deepseek-v4-flash") < 0,
  "app-settings.js 不再出现 deepseek-v4-flash",
);

console.log("\n[4] 启动缺省合并不再强制 deepseek");
const boot = read("renderer/app-boot.js");
ok(
  /nodePath: "",\s*\n\s*model: ""/.test(boot),
  "app-boot.js dsh 缺省合并 model 为空串（留空 = 跟随生效路由）",
);
ok(
  boot.indexOf('model: "deepseek-v4-flash"') < 0,
  "app-boot.js 不再启动即写入 deepseek-v4-flash",
);

console.log(
  "\n" +
    (fails
      ? "FAILED " + fails + " / " + checks + " checks"
      : "ALL OK  " + checks + " checks"),
);
process.exit(fails ? 1 : 0);
