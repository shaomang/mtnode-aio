/* 生成 agent-prompts/defaults.json —— 「出厂默认」的随包快照。
 *
 * 为什么需要它：设置 →「内置能力」要能显示每段提示词的出厂默认，而默认文本写在
 * 代码里（PS(id, def)），只有那一档真的跑过一次才会被登记。开发机/作者机可以现场
 * 扫源码把默认算出来，普通用户机上没有源码树，就只能看到一片空白。
 * 这个脚本在构建期用同一套扫描（agent-prompts-lib.js 的 scanPromptDefaults）把结果
 * 固化成 JSON，随包进 agent-prompts/（build.json 的 agent-prompts/** 已覆盖）。
 *
 * 口径：
 *  - 只收「唯一能确定」的（字面量拼接 / 字符串常量 / 同构三元配对 / 纯文本包装器）；
 *    同一 id 对应多档文本或运行期拼装的一律不收 —— 宁可空白，也不能写错默认。
 *  - 覆盖层 / 源码默认层（agent-prompts/<id>.md）优先于此快照，它只是最后兜底。
 *  - 改了提示词就重跑：npm run build:prompt-defaults（smoke-agent-prompts 会报陈旧）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "agent-prompts", "defaults.json");

const lib = require(path.join(ROOT, "agent-prompts-lib.js"));
const scan = lib.scanPromptDefaults({ appRoot: ROOT, packaged: false, ignoreSnapshot: true });
const map = (scan && scan.map) || {};

const texts = {};
for (const id of Object.keys(map).sort()) {
  const t = String(map[id] || "");
  if (t) texts[id] = t;
}
const payload = {
  generatedAt: new Date().toISOString().slice(0, 10),
  generator: "scripts/gen-prompt-defaults.mjs",
  count: Object.keys(texts).length,
  texts,
};
fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n", "utf8");
console.log(
  "已写入 " + path.relative(ROOT, OUT) + "：" + payload.count + " 条（扫描 " + scan.files + " 个文件）",
);
