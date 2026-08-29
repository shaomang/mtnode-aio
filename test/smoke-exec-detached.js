"use strict";
/* 执行节点启动器 —— 独立进程启动 冒烟测试（纯 Node，不依赖 Electron）
 *   node test/smoke-exec-detached.js
 * 覆盖：
 *   [1] 空路径 / 不存在文件 → { ok:false, error }（不启动）
 *   [2] win32：.bat/.cmd/.exe/.lnk/.ps1 及文档类文件 → cmd /c start
 *       （新控制台 + 新进程组；detached + stdio ignore + windowsHide + unref）
 *   [3] win32 路径含空格：原样作为单个参数传入（由 Node 负责引号），不做手工拼串
 *   [4] posix：可执行扩展名 → spawn(detached)；普通文件 → shell-open 回退
 *   [5] launchDetached 注入假 spawn：cmd-start 真正调用 spawn 且 unref；
 *       spawn 抛错 → { ok:false, error }
 *   [6] 结果契约：ok / mode / fallback 字段 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  EXEC_EXTS,
  isExecPath,
  buildLaunchSpec,
  launchDetached,
} = require("../main-exec-launch.js");

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

/* 真实存在的临时文件（供 existsSync 校验） */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "exec-detached-"));
const realCmd = path.join(tmp, "probe.cmd");
fs.writeFileSync(realCmd, "@echo off\r\necho hi\r\n", "utf8");
const realMd = path.join(tmp, "notes.md");
fs.writeFileSync(realMd, "# hi\n", "utf8");

/* ============ [1] 参数与文件校验 ============ */
console.log("[1] 空路径 / 文件不存在");
ok(buildLaunchSpec("").ok === false, "空路径 → ok:false");
ok(buildLaunchSpec("   ", "win32").ok === false, "纯空白 → ok:false");
const miss = buildLaunchSpec(path.join(tmp, "nope.cmd"), "win32");
ok(miss.ok === false && /file not found/.test(miss.error), "不存在文件 → ok:false + file not found");
ok(buildLaunchSpec(realCmd, "win32").ok === true, "真实存在的文件 → ok:true");

/* ============ [2] win32 启动方案 ============ */
console.log("[2] win32：cmd /c start（新控制台 + 新进程组）");
const W = (p) => buildLaunchSpec(p, "win32");
let s = W(realCmd);
ok(s.mode === "cmd-start", ".cmd → cmd-start");
ok(s.file === "cmd.exe", "启动器 = cmd.exe");
ok(JSON.stringify(s.args) === JSON.stringify(["/d", "/c", "start", "", realCmd]), "args = /d /c start '' <path>");
ok(s.opts.detached === true, "detached:true（脱离父进程树）");
ok(s.opts.stdio === "ignore", "stdio:ignore（启动器不占用管道）");
ok(s.opts.windowsHide === true, "windowsHide:true（中间 cmd 不闪窗）");
for (const ext of [".bat", ".cmd", ".exe", ".lnk", ".com", ".msi", ".ps1", ".jar"]) {
  const p = path.join(tmp, "a" + ext);
  fs.writeFileSync(p, "", "utf8");
  ok(W(p).mode === "cmd-start", ext + " → cmd-start");
}
ok(W(realMd).mode === "cmd-start", "文档类 .md → cmd-start（start 交给默认应用）");

/* ============ [3] 空格路径不手工拼串 ============ */
console.log("[3] 空格路径");
const spaced = path.join(tmp, "dir with space", "agent rebuild.cmd");
fs.mkdirSync(path.dirname(spaced), { recursive: true });
fs.writeFileSync(spaced, "@echo off\r\n", "utf8");
const sw = W(spaced);
ok(sw.args[4] === spaced, "含空格路径作为单个原始参数传入（引号交给 Node spawn）");
ok(sw.args.length === 5, "args 恰 5 段（无手工转义污染）");

/* ============ [4] posix 方案 ============ */
console.log("[4] posix");
const toolSh = path.join(tmp, "tool.sh");
fs.writeFileSync(toolSh, "#!/bin/sh\n", "utf8");
const aExe = path.join(tmp, "a.exe");
fs.writeFileSync(aExe, "", "utf8");
const L = (p) => buildLaunchSpec(p, "linux");
let sl = L(realCmd);
ok(sl.mode === "cmd-start" === false && sl.mode === "spawn", "posix .cmd → spawn（不依赖 cmd.exe）");
sl = L(toolSh);
ok(sl.mode === "shell-open", "posix .sh（非清单扩展）→ shell-open 回退");
sl = L(realMd);
ok(sl.mode === "shell-open", "posix 文档类 → shell-open 回退");
sl = L(aExe);
ok(sl.mode === "spawn" && sl.opts.detached === true, "posix 可执行扩展名 → spawn(detached)");
ok(isExecPath("x.bat") && isExecPath("A.CMD") && !isExecPath("a.md"), "isExecPath 扩展名匹配（大小写不敏感）");
ok(EXEC_EXTS instanceof Set && EXEC_EXTS.size >= 8, "EXEC_EXTS 为集合且覆盖主要程序类型");

/* ============ [5] launchDetached：注入假 spawn ============ */
console.log("[5] launchDetached 执行语义");
{
  let spawned = null;
  let unrefed = false;
  const fakeSpawn = (file, args, opts) => {
    spawned = { file, args, opts };
    return { unref: () => (unrefed = true) };
  };
  const r = launchDetached(spaced, { platform: "win32", spawn: fakeSpawn });
  ok(r.ok === true && r.mode === "cmd-start", "cmd-start 返回 {ok:true, mode} ");
  ok(spawned && spawned.file === "cmd.exe", "注入的 spawn 收到 cmd.exe");
  ok(Array.isArray(spawned.args) && spawned.args[3] === "", "收到空标题参数");
  ok(unrefed === true, "对子进程调用 unref（不阻塞主进程退出）");
}
{
  const fakeSpawn = () => {
    throw new Error("boom");
  };
  const r = launchDetached(realCmd, { platform: "win32", spawn: fakeSpawn });
  ok(r.ok === false && /boom/.test(r.error), "spawn 抛错 → {ok:false,error}");
}
{
  const r = launchDetached(realMd, { platform: "linux" });
  ok(r.ok === true && r.fallback === "shell-open", "shell-open 方案 → {ok:true, fallback}（交由主进程 shell.openPath）");
}
{
  const r = launchDetached("", { platform: "win32", spawn: () => ({ unref() {} }) });
  ok(r.ok === false, "空路径不调用 spawn");
}

/* ============ [6] 结果契约 ============ */
console.log("[6] 结果契约");
const r1 = launchDetached(realCmd, { platform: "win32", spawn: () => ({ unref() {} }) });
ok(typeof r1.ok === "boolean" && typeof r1.mode === "string", "成功态含 ok+mode");
const r2 = buildLaunchSpec(realCmd, "win32");
ok(typeof r2.opts.detached === "boolean", "方案含启动选项");

/* 清理 */
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch (_) {}

console.log("\n" + (fails ? "FAILED " + fails + "/" + checks : "PASS " + checks + "/" + checks));
process.exit(fails ? 1 : 0);
