"use strict";
/* 网关依赖布局与打包复制 —— 冒烟测试（纯 Node，无 DOM）
 *   node test/smoke-gateway-packaging.js
 *
 * 事故（2026-09-30 实测）：网关依赖换成 pnpm 默认的 isolated 布局后，
 * `dsh/after-pack.cjs` 手工遍历复制（只搬真实文件）把指向目录的 junction 当成普通文件，
 * `fs.copyFileSync` 在 Windows 上抛 EPERM/EISDIR —— `resources/dsh/gateway` 只复制到一半
 * （node_modules、package.json、plugins/ 全缺），安装包启动后网关立刻 exit 1：
 *   Cannot find package '@deepseek-ai/dsh-sdk-client'
 * （应用侧表现 = main-dsh.js 记「dsh 网关已退出(code=1)」）
 *
 * 覆盖：
 *   [1] 布局开关：pnpm-workspace.yaml 的 nodeLinker: hoisted（pnpm ≥11 唯一生效位置）+ .npmrc 同值
 *   [2] after-pack 两道保险：跳过 node_modules/.pnpm；遇到指向目录的链接直接报错中止打包
 *   [3] 真机布局：网关 node_modules 里没有目录链接（真实目录，npm 式）
 *   [4] 已打包产物（存在才查）：网关树完整 —— 事故当时缺的路径现在必须在
 */
const fs = require("fs");
const path = require("path");

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
function skip(msg) {
  console.log("  skip  " + msg);
}
const p = (...seg) => path.join(ROOT, ...seg);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const isLink = (abs) => {
  try {
    return fs.lstatSync(abs).isSymbolicLink();
  } catch {
    return false;
  }
};

console.log("\n[1] 依赖布局开关 = npm 式真实目录（hoisted）");
const wsYaml = read("dsh/gateway/pnpm-workspace.yaml");
ok(/^nodeLinker:\s*hoisted\s*$/m.test(wsYaml), "pnpm-workspace.yaml 顶层 nodeLinker: hoisted（pnpm ≥11 只认这里）");
const npmrc = exists("dsh/gateway/.npmrc") ? read("dsh/gateway/.npmrc") : "";
ok(/^node-linker=hoisted\s*$/m.test(npmrc), ".npmrc 同值 node-linker=hoisted（供 pnpm < 11 读）");
const design = read("dsh/DESIGN.md");
ok(
  /nodeLinker: hoisted/.test(design) && /Cannot find package/.test(design),
  "DESIGN.md 记录该硬约束与事故现象（Cannot find package）",
);
ok(exists("dsh/gateway/pnpm-lock.yaml"), "pnpm-lock.yaml 仍在（锁文件口径不变）");

console.log("\n[2] after-pack 两道保险");
const ap = read("dsh/after-pack.cjs");
ok(/assertNoDirLink/.test(ap), "存在 assertNoDirLink（目录链接守卫）");
const guardBlock = ap.slice(ap.indexOf("const assertNoDirLink"), ap.indexOf("const walk ="));
ok(
  /fs\.statSync\(abs\)/.test(guardBlock) &&
    /!st\.isDirectory\(\)\) return/.test(guardBlock) &&
    /throw new Error\(/.test(guardBlock),
  "守卫：链接指向文件放行、指向目录 throw（不再走 copyFileSync 静默炸掉）",
);
ok(
  /e\.isDirectory\(\)\s*\)\s*drop\('dotdir:'/.test(ap) || /e\.isDirectory\(\)\)\s*\{\s*drop\('dotdir:'/.test(ap),
  "dotdir 桶仍在（跳过项会计入打包体积报表）",
);
const dotCond = ap.slice(ap.indexOf("e.name === '.cache'"), ap.indexOf("const decision ="));
ok(/\.pnpm/.test(dotCond), "node_modules/.pnpm 整目录跳过（hoisted 下运行时不可达，白占 ~1.8GB）");
ok(
  ap.indexOf("if (e.isSymbolicLink()) assertNoDirLink") > 0 &&
    ap.indexOf("if (e.isSymbolicLink()) assertNoDirLink") < ap.indexOf("const decision ="),
  "守卫发生在剪枝判定与复制之前（先拦后搬）",
);

console.log("\n[3] 真机布局：网关 node_modules 无目录链接");
const gwNm = p("dsh", "gateway", "node_modules");
if (!fs.existsSync(gwNm)) {
  skip("dsh/gateway/node_modules 不存在（未安装依赖），跳过布局实测");
} else {
  const sdk = path.join(gwNm, "@deepseek-ai", "dsh-sdk-client");
  ok(fs.existsSync(sdk) && !isLink(sdk), "@deepseek-ai/dsh-sdk-client 是真实目录（不是 junction）");
  const topLinks = fs.readdirSync(gwNm, { withFileTypes: true }).filter((e) => e.isSymbolicLink());
  ok(topLinks.length === 0, "node_modules 顶层无符号链接（实测 " + topLinks.length + " 条）");
  const scope = path.join(gwNm, "@deepseek-ai");
  if (fs.existsSync(scope)) {
    const scopeLinks = fs.readdirSync(scope, { withFileTypes: true }).filter((e) => e.isSymbolicLink());
    ok(scopeLinks.length === 0, "@deepseek-ai/ 下无符号链接（实测 " + scopeLinks.length + " 条）");
  } else skip("@deepseek-ai 目录不存在");
}

console.log("\n[4] 已打包产物完整性（dist 存在才查）");
const distGw = p("dist", "win-unpacked", "resources", "dsh", "gateway");
if (!fs.existsSync(distGw)) {
  skip("dist/win-unpacked/resources/dsh/gateway 不存在，跳过产物检查");
} else {
  for (const rel of [
    "package.json",
    "gateway.mjs",
    "cordis.yml",
    "tools-plugin.mjs",
    "rollback-plugin.mjs",
    "plugins/session-resume-server.mjs",
    "node_modules/@deepseek-ai/dsh-sdk-client",
    "node_modules/@deepseek-ai/dsh/lib/bin.js",
  ]) {
    ok(fs.existsSync(path.join(distGw, ...rel.split("/"))), "产物含 " + rel);
  }
}

console.log(
  "\n" + (fails ? "FAILED " + fails + " / " + checks + " checks" : "ALL OK  " + checks + " checks"),
);
process.exit(fails ? 1 : 0);
