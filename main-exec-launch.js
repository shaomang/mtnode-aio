"use strict";
/* 执行节点启动器（主进程侧）—— 让执行节点绑定的文件在【独立进程 / 新控制台】中启动，
   不随 MTNode 主程序退出而关闭。
   修复 Bug：把 MTNode 编译脚本（如 scripts\agent-rebuild.cmd）加入执行节点执行后，
   console 随主程序关闭而关闭（旧实现走 shell.openPath，目标进程挂在 MTNode
   进程树下、共用控制台，主程序一退出 console 就被带走、编译中断）。
   纯 Node、无 Electron 依赖，便于 test/smoke-exec-detached.js 直接加载断言。 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

/* 视为「程序」的扩展名：需要独立进程 / 独立控制台启动，而不是交给默认应用打开 */
const EXEC_EXTS = new Set([
  ".exe",
  ".bat",
  ".cmd",
  ".com",
  ".lnk",
  ".msi",
  ".ps1",
  ".jar",
  ".app",
  ".dmg",
]);

function isExecPath(p) {
  return EXEC_EXTS.has(path.extname(String(p || "")).toLowerCase());
}

/* 纯函数：给出启动方案（不真正启动，便于测试）。
   win32 一律走 cmd /c start —— start 创建全新进程组 + 新控制台窗口，
   中间 cmd 立即退出，目标进程与 MTNode 进程树彻底脱离；
   文档类文件（.md/.png/…）同样交给 start → 系统默认应用，行为与 shell.openPath 一致。
   其它平台：可执行扩展名 spawn(detached)（新会话，不随父退出）；
   普通文件回退给调用方 shell.openPath。 */
function buildLaunchSpec(p, platform) {
  const target = String(p || "").trim();
  const plat = platform || process.platform;
  if (!target) return { ok: false, error: "empty path" };
  if (!fs.existsSync(target))
    return { ok: false, error: "file not found: " + target };
  if (plat === "win32") {
    return {
      ok: true,
      mode: "cmd-start",
      file: "cmd.exe",
      args: ["/d", "/c", "start", "", target],
      opts: { detached: true, stdio: "ignore", windowsHide: true },
    };
  }
  if (isExecPath(target)) {
    return {
      ok: true,
      mode: "spawn",
      file: target,
      args: [],
      opts: { detached: true, stdio: "ignore" },
    };
  }
  return { ok: true, mode: "shell-open" };
}

/* 真正启动绑定文件；返回 { ok:true, mode } 或 { ok:false, error }。
   spawnFn 可注入（测试用）；shell-open 方案由调用方处理（主进程 shell.openPath）。 */
function launchDetached(p, opt = {}) {
  const spec = buildLaunchSpec(p, opt.platform);
  if (!spec.ok) return spec;
  if (spec.mode === "shell-open")
    return { ok: true, fallback: "shell-open" };
  try {
    const spawnFn = opt.spawn || spawn;
    const child = spawnFn(spec.file, spec.args, spec.opts);
    if (child && typeof child.unref === "function") child.unref();
    return { ok: true, mode: spec.mode };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

module.exports = { EXEC_EXTS, isExecPath, buildLaunchSpec, launchDetached };
