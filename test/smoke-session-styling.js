/* 冒烟：会话样式与设计（dsh 桌面版口径）的接线钉点
 *
 * 本轮把会话 / 助手两个窗格的视觉词汇抽成语义令牌（renderer/css/dsh-tokens.css 的
 * --dsh-*，值引用 base.css 的主题槽位 → 暗色与亮色同源），并新增会话右栏的
 * 「运行轨迹」视图（renderer/app-trajectory.js：轨迹列表 + 工具调用可展开详情 +
 * 轨迹↔对话双向定位），由设置 · 开发者工具（S.config.dsh.developerTools，默认开）约束。
 *
 * 本冒烟做**静态接线检查**（不启 Electron）：上面这些东西分散在 index.html / style.css /
 * 四个 js 里，任何一处漏了，界面上就是「没反应」而不是报错 —— 正是最该被冒烟钉住的形态。
 *
 * 跑法：node test/smoke-session-styling.js
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) {
    pass++;
    console.log("  ✓ " + label);
  } else {
    fail++;
    console.log("  ✗ " + label);
  }
}

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

console.log("session-styling smoke");

/* ── [1] 令牌文件与装配顺序 ─────────────────────────────────────────────── */
const tokensPath = "renderer/css/dsh-tokens.css";
ok(fs.existsSync(path.join(ROOT, tokensPath)), "[1] " + tokensPath + " 存在");
const tokens = read(tokensPath);
ok(/--dsh-pane-bg\s*:/.test(tokens), "[1] 定义了 --dsh-* 语义令牌");
ok(/var\(--bg2\)/.test(tokens) && /var\(--ink\)/.test(tokens), "[1] 令牌值引用 base.css 的主题槽位（暗/亮同源，不写死 hex）");
ok(/\.dsh-view-tabs/.test(tokens) && /\.dsh-view-tab\b/.test(tokens), "[1] View 标签栏样式在位");
ok(/\.dsh-trace-list/.test(tokens) && /\.dsh-trace-row/.test(tokens), "[1] 轨迹列表样式在位");
ok(/\.dsh-trace-detail/.test(tokens) && /\[open\]/.test(tokens), "[1] 工具调用可展开详情样式在位");
ok(/\.dsh-trace-col/.test(tokens) && /position:\s*absolute/.test(tokens), "[1] 轨迹栏压在第三栏（绝对定位，与浏览器活动互斥）");
/* 亮色不加特例：令牌引用槽位，theme-light 重定义槽位即可（有特例就说明又写死了颜色） */
ok(!/theme-light/.test(tokens), "[1] 令牌文件里没有亮色特例（亮色靠槽位重定义，不再逐条补覆盖）");

const style = read("renderer/style.css");
const iDsh = style.indexOf("./css/dsh.css");
const iTokens = style.indexOf("./css/dsh-tokens.css");
const iAssist = style.indexOf("./css/assist.css");
ok(iTokens > 0, "[1] style.css 引入了 dsh-tokens.css");
ok(iDsh >= 0 && iTokens > iDsh && iAssist > iTokens, "[1] 装配顺序：dsh.css → dsh-tokens.css → assist.css");

/* ── [2] 会话右栏轨迹视图的接线 ─────────────────────────────────────────── */
const html = read("renderer/index.html");
ok(/<script src="app-trajectory\.js"><\/script>/.test(html), "[2] index.html 引入了 app-trajectory.js");
const iBrowser = html.indexOf('<script src="app-browser.js"></script>');
const iTraj = html.indexOf('<script src="app-trajectory.js"></script>');
ok(iBrowser >= 0 && iTraj > iBrowser, "[2] 排在 app-browser.js 之后（借它的第三栏显隐口径）");

const traj = read("renderer/app-trajectory.js");
ok(/window\.MTNodeTrajectory\s*=/.test(traj), "[2] 导出 window.MTNodeTrajectory");
ok(/agentTraceItems|agentChatSegItems/.test(traj), "[2] 只读 app-assist.js 已有的轨迹段数据（不新增会话接口）");
ok(/data-seg-idx|dataset\.segIdx/.test(traj), "[2] 轨迹↔对话双向定位用对话区自己的段编号（dataset.segIdx）");
ok(/developerTools\s*!==\s*false/.test(traj), "[2] 显隐受 developerTools 开关约束（缺配置 = 默认开）");
ok(/ba-open/.test(traj), "[2] 跟随会话右栏的显隐口径（.agent-pane.ba-open）");

/* ── [3] 设置项与缺省 ───────────────────────────────────────────────────── */
const boot = read("renderer/app-boot.js");
ok(/developerTools:\s*true/.test(boot), "[3] 配置缺省 developerTools: true（默认开）");
const settings = read("renderer/app-settings.js");
ok(/developerTools/.test(settings) && /devCb\.type\s*=\s*"checkbox"/.test(settings), "[3] 设置页有开发者工具开关");
ok(/developerTools:\s*dshEls\.developerTools/.test(settings), "[3] 开关进 collect()（关窗写盘不丢值）");
ok(/developerTools:\s*true/.test(settings), "[3] finalizeSettings 的缺省合并里有该键");
const i18n = read("renderer/i18n.js");
ok(/开发者工具（会话右栏「运行轨迹」视图/.test(i18n), "[3] 设置项有中英词条（i18n）");
ok(/Developer tools \(a Run trajectory view/.test(i18n), "[3] 英文词条在位");

/* ── [4] 版本（0.2 内核）口径仍钉住 ─────────────────────────────────────── */
const pkg = JSON.parse(read("dsh/gateway/package.json"));
ok(pkg.dependencies["@deepseek-ai/dsh"] === "0.2.0-rc.2", "[4] 网关仍锁 0.2.0-rc.2");
ok(String(pkg.dependencies["@deepseek-ai/cordis"]).startsWith("4."), "[4] cordis 仍在 4.x 线");

console.log("\nsession-styling smoke: pass " + pass + " / fail " + fail);
process.exitCode = fail ? 1 : 0;
