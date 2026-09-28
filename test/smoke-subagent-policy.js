#!/usr/bin/env node
/* test/smoke-subagent-policy.js — 子代理（委派）策略：深度 / 后台并行 / fork / 总开关
 * ============================================================================
 * 钉住两件事：
 *   [1]-[4] dsh-agent-policy.js 的纯函数语义（策略归一、8 行 subagent* 的 disabled 改写与
 *           **可还原**、maxDepth 与 enableRunInBackground 的改写、fork 只关 fork 两行）；
 *   [5]     仓库接线：main.js 在「起网关之前」与「每次 config:save 之后」都写一次、
 *           build.json 白名单含新模块、出货的 cordis.yml 默认 maxDepth 是 1（不是 dsh 的 3）、
 *           设置界面写的是 S.config.dsh.subagent、i18n 词条齐备。
 * 口径：零依赖、不启动 Electron、不碰真实 %APPDATA%（只读仓库内文件 + 纯函数）。
 * ============================================================================
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

const policy = require("../dsh-agent-policy.js");
const CORDIS = read("dsh/gateway/cordis.yml");

/* 把一份 cordis.yml 文本按 `- id:` 切开，取某一行的块（断言用） */
function blockOf(text, id) {
  const first = text.search(/^- id: /m);
  if (first < 0) return "";
  const blocks = text.slice(first).split(/^(?=- id: )/m);
  for (const b of blocks) {
    const m = b.match(/^- id:\s*(\S+)/);
    if (m && m[1] === id) return b;
  }
  return "";
}
const isOff = (text, id) => /^\s*disabled:\s*true\s*$/m.test(blockOf(text, id));
const isPlatformGated = (text, id) =>
  blockOf(text, id).indexOf(policy.PLATFORM_DISABLED) >= 0;

console.log("\n[1] 策略归一：非法值一律回落默认（深度 1、其余全开）");
{
  ok(policy.DEFAULT_POLICY.depth === 1, "默认深度 = 1（对齐 OpenCode 的 subagent_depth 默认）");
  ok(
    policy.DEFAULT_POLICY.enabled &&
      policy.DEFAULT_POLICY.fork &&
      policy.DEFAULT_POLICY.background,
    "默认总开关 / fork / 后台并行都开（除深度外与接入前一致）",
  );
  const n = policy.normalizePolicy(undefined);
  ok(
    n.enabled === true && n.fork === true && n.background === true && n.depth === 1,
    "normalizePolicy(undefined) = 默认",
  );
  ok(policy.normalizePolicy({ depth: 9 }).depth === 1, "越界深度 9 → 回落 1");
  ok(policy.normalizePolicy({ depth: "2" }).depth === 2, "字符串 \"2\" 认成 2");
  ok(policy.normalizePolicy({ depth: 0 }).depth === 0, "0 是合法值（禁止委派），不被 || 吃掉");
  ok(policy.normalizePolicy({ depth: -1 }).depth === 1, "负数 → 回落 1");
  ok(policy.normalizePolicy({ enabled: false }).enabled === false, "only false 关（0/'' 视为开）");
  ok(
    policy.policyFromConfig({ dsh: { subagent: { depth: 0 } } }).depth === 0,
    "policyFromConfig 读 config.dsh.subagent（设置界面写的就是它）",
  );
  ok(
    policy.policyFromConfig({ subagent: { depth: 2 } }).depth === 2,
    "policyFromConfig 兼容顶层 config.subagent",
  );
  ok(policy.policyFromConfig({}).depth === 1, "配置里没有这项 → 默认深度 1");
  ok(policy.SUBAGENT_IDS.length === 8, "参与策略的 subagent* 行共 8 行");
}

console.log("\n[2] 总开关：8 行全关 → 再打开逐字还原（幂等 · 可往返）");
{
  const on = policy.applySubagentPolicy(CORDIS, policy.DEFAULT_POLICY);
  ok(on.changed === false, "出货文件按默认策略应用 = 零字节变化（幂等）");
  ok(on.text === CORDIS, "默认应用后文本与出货文件逐字相同");

  const off = policy.applySubagentPolicy(CORDIS, { enabled: false });
  ok(off.changed === true, "关掉总开关会真的改写字节");
  let allOff = true;
  for (const id of policy.SUBAGENT_IDS) if (!isOff(off.text, id)) allOff = false;
  ok(allOff, "8 行 subagent* 全部变成 disabled: true（模型侧连委派工具都看不到）");
  ok(
    off.text.split(/^(?=- id: )/m).length === CORDIS.split(/^(?=- id: )/m).length,
    "行的条数一字不变（没有多出 / 少掉组合行）",
  );
  ok(blockOf(off.text, "session") === blockOf(CORDIS, "session"), "无关行原样保留（session 行）");

  const back = policy.applySubagentPolicy(off.text, policy.DEFAULT_POLICY);
  ok(back.text === CORDIS, "重新打开 = 逐字还原出货文本（平台条件行没被抹掉）");
  ok(isPlatformGated(back.text, "tool-subagent"), "还原后仍是平台条件行（!!js 隔离/纯模式闸）");

  const idem = policy.applySubagentPolicy(off.text, { enabled: false });
  ok(idem.changed === false, "重复关一次不再改字节（changed=false，调用方不碰磁盘）");
}

console.log("\n[3] 深度与后台并行：只改两个委派工具行");
{
  const d0 = policy.applySubagentPolicy(CORDIS, { depth: 0 }).text;
  ok(/^\s*maxDepth:\s*0\s*$/m.test(blockOf(d0, "tool-subagent")), "深度 0 写进 tool-subagent");
  ok(/^\s*maxDepth:\s*0\s*$/m.test(blockOf(d0, "tool-subagent-fork")), "深度 0 写进 tool-subagent-fork");
  const d2 = policy.applySubagentPolicy(CORDIS, { depth: 2 }).text;
  ok(/^\s*maxDepth:\s*2\s*$/m.test(blockOf(d2, "tool-subagent")), "深度 2 写入");
  ok(
    /^\s*maxDepth:\s*1\s*$/m.test(blockOf(CORDIS, "tool-subagent")),
    "出货文件（用户还没设置过时）就是 maxDepth: 1，不是 dsh 自带的 3",
  );
  ok(
    policy.applySubagentPolicy(CORDIS, { depth: 1 }).changed === false,
    "深度 1 = 出货默认，应用一次仍是零字节变化",
  );

  const nb = policy.applySubagentPolicy(CORDIS, { background: false }).text;
  ok(
    /^\s*enableRunInBackground:\s*false\s*$/m.test(blockOf(nb, "tool-subagent")),
    "后台并行关掉 → tool-subagent 写 enableRunInBackground: false",
  );
  ok(
    !/enableRunInBackground/.test(blockOf(nb, "tool-subagent-fork")),
    "fork 工具行不写这个键（它本来就是 one-shot 后台模式）",
  );
  const nbBack = policy.applySubagentPolicy(nb, policy.DEFAULT_POLICY);
  ok(nbBack.text === CORDIS, "后台并行再打开 = 逐字还原（新键被改回 true 而不是留下残行）");
}

console.log("\n[4] fork 开关：只关 fork 提供方与 fork 工具两行");
{
  const noFork = policy.applySubagentPolicy(CORDIS, { fork: false }).text;
  ok(isOff(noFork, "subagent-fork-in-process"), "fork 提供方行关掉");
  ok(isOff(noFork, "tool-subagent-fork"), "fork 委派工具行关掉");
  ok(!isOff(noFork, "subagent-spawn-in-process"), "spawn 提供方不受影响（仍是平台条件行）");
  ok(!isOff(noFork, "tool-subagent"), "spawn 委派工具不受影响");
  ok(
    policy.applySubagentPolicy(noFork, policy.DEFAULT_POLICY).text === CORDIS,
    "fork 再打开 = 逐字还原",
  );
  /* 总开关 + fork 同时关：fork 两行也必须关（不能因为 fork 分支提前 return 就漏掉） */
  const both = policy.applySubagentPolicy(CORDIS, { enabled: false, fork: true }).text;
  ok(isOff(both, "tool-subagent-fork"), "总开关关掉时 fork 行同样关（组合条件不短路）");
}

console.log("\n[5] 仓库接线");
{
  const mainJs = read("main.js");
  ok(
    /require\("\.\/dsh-agent-policy\.js"\)/.test(mainJs),
    "main.js require 了新模块 dsh-agent-policy.js",
  );
  ok(
    /function syncSubagentPolicy\(cfg\)/.test(mainJs) &&
      /applySubagentPolicy\(text,\s*policyFromConfig\(cfg\)\)/.test(mainJs),
    "main.js 有 syncSubagentPolicy（读文本 → 纯函数 → tmp+rename 原子写）",
  );
  const saveSeg = mainJs.slice(mainJs.indexOf('ipcMain.handle("config:save"'));
  ok(
    /syncSubagentPolicy\(next\);\s*\n\s*return \{ ok: true \};/.test(saveSeg.slice(0, 6000)),
    "config:save 之后调一次（设置改完立刻落进组合）",
  );
  const bootSeg = mainJs.slice(mainJs.indexOf("dsh().ensureStarted()") - 900);
  ok(
    /syncSubagentPolicy\(readJson\(path\.join\(DATA\(\), "config\.json"\), \{\}\)\)/.test(bootSeg),
    "起网关之前先写一次（首次启动 / 升级后不会带着 dsh 默认 3 层跑）",
  );
  ok(
    /path\.join\(path\.dirname\(DSH_GATEWAY_PATH\), "cordis\.yml"\)/.test(mainJs),
    "cordis.yml 路径取自 main-dsh.js 导出的 GATEWAY_PATH（开发态与打包态同源）",
  );
  ok(
    /const \{ createDshAdapter, GATEWAY_PATH: DSH_GATEWAY_PATH \}/.test(mainJs),
    "GATEWAY_PATH 是从 dsh/main-dsh.js 导入的（没有自己拼 resourcesPath）",
  );
  ok(
    read("build.json").indexOf('"dsh-agent-policy.js"') >= 0,
    "build.json files 白名单含 dsh-agent-policy.js（否则打包后 Cannot find module）",
  );

  const settings = read("renderer/app-settings.js");
  ok(
    /S\.config\.dsh\.subagent = Object\.assign\(/.test(settings),
    "设置界面把策略存在 S.config.dsh.subagent",
  );
  ok(
    /S\.config\.dsh\.subagent\.depth = Number\(depthSel\.value\)/.test(settings),
    "深度下拉写回 depth",
  );
  ok(
    /子代理嵌套深度（0 = 禁止委派）/.test(settings),
    "设置里有深度选择项（0 / 1 / 2）",
  );
  ok(
    settings.indexOf("子代理（委派）") > 0 &&
      settings.indexOf("智能能力（DeepSeek Harness / dsh）") < settings.indexOf("子代理（委派）"),
    "子代理小节落在「智能能力（dsh）」区块内",
  );
  const i18n = read("renderer/i18n.js");
  for (const zh of [
    "子代理（委派）",
    "子代理嵌套深度（0 = 禁止委派）",
    "1 · 只允许一层（默认）",
    "允许子代理委派（总开关：取消后模型看不到任何委派工具）",
    "允许后台并行委派（取消后子代理只在前台同步跑，一次一个）",
    "允许 fork 型子代理（复制当前上下文另起一个子会话）",
  ]) {
    const line = new RegExp('"' + zh.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '":\\s*"');
    ok(line.test(i18n), "i18n 词条（中文键 → 英文）齐备：" + zh);
  }
}

console.log("\n" + (fails ? "FAILED " + fails + " / " + checks + " checks" : "ALL OK  " + checks + " checks"));
process.exit(fails ? 1 : 0);