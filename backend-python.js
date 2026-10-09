"use strict";
/* 本地后端解释器口径（唯一真源）：把 venv 的 python.exe 换成「不弹控制台」的 pythonw.exe。
 *
 * 症状：插件卡片点「启动」后，宿主明明是用
 *   spawn(py, ["-m", "app", port], { windowsHide: true, detached: true, stdio: "ignore" })
 * 静默拉起的，Windows 11 上仍会多出一只独立的 Windows Terminal 窗口（标题就是 venv 的 python.exe）。
 *
 * 原因（本机 2026-10 复现并对照过）：Store 版 Python（…\WindowsApps\PythonSoftwareFoundation.Python.3.10_*）
 * 生成的 venv 里，Scripts\python.exe 只是一层「再启动器」shim（268KB），它自己再用 CreateProcess 拉起真解释器
 * python3.10.exe。windowsHide 只作用于**我们直接创建的那一个**进程（CREATE_NO_WINDOW ⇒ 该进程没有控制台），
 * shim 再拉起的真解释器是控制台子系统、没有控制台可继承，Windows 就给它新分配一个控制台
 * → conhost.exe + 默认终端宿主（Windows Terminal）各起一份，用户看到的就是「插件又弹出一只终端窗口」。
 * 同一 spawn 参数的实测对照：
 *   .venv\Scripts\python.exe                  → 新增 conhost.exe + 可见 WindowsTerminal 窗口（旧行为）
 *   .venv\Scripts\pythonw.exe                 → 无新增 conhost / 终端窗口，解释器照常执行（本模块口径）
 *   WindowsApps\…\python.exe（直连真解释器）  → 同样干净
 *
 * 口径：venv 的 python.exe 一律换成同目录的 pythonw.exe（GUI 子系统，CreateProcess 不给它分配控制台，
 * shim 链同理，整条链静默）；pythonw.exe 不存在时原样返回 python.exe。
 * 语义不变：stdio 由宿主显式给定（"ignore" / 管道 / 已打开的日志文件句柄），pythonw 下 sys.stdout / sys.stderr
 * 仍是有效文本流（管道与文件句柄照常写；实测写文件与 execFile 取 stdout 都正常），宿主与脚手架都不读控制台。
 *
 * 同类问题在别处已有先例：dsh/gateway/gateway.mjs 的 applySandboxWorkaround（「没有 console 的父进程 →
 * 子进程在 Windows 里新建窗口闪一下」），口径一致：要么父进程有 console 且窗口隐藏，要么整条链都别要 console。
 */
const fs = require("fs");
const path = require("path");

/** python.exe → 同目录 pythonw.exe（存在时）；python3.10.exe → python3.10w.exe；已是 pythonw / 非 python*.exe 原样返回。 */
function quietPython(pythonExe) {
  const p = String(pythonExe || "").trim();
  if (!p) return pythonExe;
  const base = path.basename(p);
  if (/^pythonw[\w.]*\.exe$/i.test(base)) return pythonExe;
  const m = /^python([\w.]*)\.exe$/i.exec(base);
  if (!m) return pythonExe;
  const cand = path.join(path.dirname(p), "python" + m[1] + "w.exe");
  try {
    if (fs.existsSync(cand)) return cand;
  } catch {}
  return pythonExe;
}

module.exports = { quietPython };
