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
 *
 * ── 第二条口径（本轮新增，与 quietPython 配对）：整条**子进程子树**的静默 ──────────────
 * pythonw 只解决了「后端自己那只解释器」的窗口；它同时把整条链变成「没有控制台可继承的父进程」，
 * 于是后端 / 引擎 / 推理脚本里任何一次**没带 CREATE_NO_WINDOW** 的外部调用（第三方库自己写的
 * subprocess / os.system）都会被 Windows 新建一只终端窗 —— 已移除的 GPT-SoVITS 训练时那「大批窗口」
 * 就是这么来的（ffmpeg-python 逐音频条目 Popen，DataLoader 并发 5~12 个 worker）；Breeze 引擎 / ComfyUI
 * 装依赖同样是这条机制。实测与机制见 docs/plugin-install-window.md。
 *
 * 解法：把随包分发的 `shims/sitecustomize.py`（真源 pack-shims/sitecustomize.py）挂在子进程 PYTHONPATH 上，
 * CPython 启动时自动 import 它，进程级给 subprocess.Popen 与 os.system / os.popen 补默认 CREATE_NO_WINDOW；
 * 子进程继承 PYTHONPATH ⇒ multiprocessing / DataLoader 的 worker 里同样生效。宿主侧只需用
 * `silentEnv(installDir, env)` 组装 env（本模块是这条口径的唯一真源）。
 */
const fs = require("fs");
const path = require("path");

/** 安装目录里随包同步进来的垫片目录（sitecustomize.py 就在这里）。 */
function shimsDir(installDir) {
  const root = String(installDir || "").trim();
  return root ? path.join(root, "shims") : "";
}

/** 给子进程 env 的 PYTHONPATH 最前面挂上 <installDir>/shims（原地不动传入的 env，返回新对象）。 */
function silentEnv(installDir, env) {
  const out = Object.assign({}, env || {});
  const dir = shimsDir(installDir);
  if (!dir) return out;
  const prev = String(out.PYTHONPATH || "");
  out.PYTHONPATH = prev ? dir + path.delimiter + prev : dir;
  return out;
}

/**
 * 把 pack 的 shims/（sitecustomize 静默垫片）同步进安装目录，返回 { ok, copied }。
 * 「整包同步」的宿主（tts / breeze / llama / sensenova）本来就把它带过去了；
 * 只挑着拷（app/*.py + scripts/*）的宿主（h3 / music3 / yue）必须显式调这一句 ——
 * 漏了它，安装目录里没有 sitecustomize.py，silentEnv 挂上去也是个空目录（静默口径失效）。
 */
function syncShims(packRoot, installDir) {
  const from = String(packRoot || "").trim();
  const to = shimsDir(installDir);
  if (!from || !to) return { ok: false, copied: 0 };
  const src = path.join(from, "shims");
  try {
    if (!fs.existsSync(src)) return { ok: false, copied: 0 };
    fs.mkdirSync(to, { recursive: true });
    let copied = 0;
    for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
      if (!ent.isFile()) continue;
      if (ent.name.endsWith(".pyc")) continue;
      fs.copyFileSync(path.join(src, ent.name), path.join(to, ent.name));
      copied++;
    }
    return { ok: true, copied };
  } catch (e) {
    return { ok: false, copied: 0, error: String((e && e.message) || e) };
  }
}

/* ── 第三条口径（与 quietPython / silentEnv 配对）：起进程前的「解释器体检」 ──────────────
 * venv 里的 python.exe / pythonw.exe 并不是解释器本体，而是 CPython 的 **venv 重定向器**
 * （与 py.exe 同一份 PC/launcher.c 编出来的 venvlauncher，约 260KB）。它每次启动都按
 * <venv>/pyvenv.cfg 的 home / executable 去找基座解释器；基座被删或搬走之后，它就报
 *     Python Launcher is sorry to say ...
 *     No Python at '"C:\ProgramData\miniconda3\envs\seg\pythonw.exe'
 * 而 pythonw.exe 是 GUI 子系统 —— 这行错误走的是 **MessageBox**：一只模态框，没人点就一直挂着。
 *
 * 症状（本机 2026-10 复现）：用户手工删掉 conda 环境（`C:\ProgramData\miniconda3\envs\seg`）后，
 * 用它的基座建的三个 venv（music / video(ComfyUI) / yue2）全部变成「每次 spawn 弹一只消息框」，
 * 插件的启动、依赖自检、Sage 探针、音频转码…… 每条会起 python 的路径都弹。
 * 实测：E:\mtnode-plugins\music\.venv\Scripts\python.exe → exit 103 + 上面那行；
 *       同目录 pythonw.exe（宿主起后端用的那只）→ 上面那只模态消息框。
 *
 * 口径：**spawn 之前先体检**。坏了就绝不起进程，把原因当错误上报（用户看到「环境已失效，请在
 * 安装窗重装」而不是一串系统消息框）。纯同步、零依赖：只读 pyvenv.cfg + 做存在性判断 ——
 * 不启动解释器（启动它本身就是弹框的原因）。
 */

/** venv 布局下 <venv>/Scripts/python.exe（或 bin/python）→ <venv>/pyvenv.cfg；非标准布局返回 ""。 */
function pyvenvCfgPath(pythonExe) {
  const exe = String(pythonExe || "").trim();
  if (!exe) return "";
  const dir = path.dirname(exe);
  const leaf = path.basename(dir).toLowerCase();
  if (leaf !== "scripts" && leaf !== "bin") return ""; /* 只认 venv 的两种布局，避免误读上层目录的 cfg */
  const cfg = path.join(dir, "..", "pyvenv.cfg"); /* <venv>/Scripts/.. → <venv>/pyvenv.cfg */
  try {
    return fs.existsSync(cfg) ? cfg : "";
  } catch {
    return "";
  }
}

/** 读 pyvenv.cfg 里记的基座解释器候选（executable 优先，其次 home + 自己的文件名）。 */
function pyvenvBaseCandidates(pythonExe, cfgPath) {
  let text = "";
  try {
    text = fs.readFileSync(cfgPath, "utf8");
  } catch {
    return [];
  }
  const vals = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w.-]*)\s*=\s*(.*)$/.exec(line.trim());
    if (m) vals[m[1].toLowerCase()] = m[2].trim();
  }
  const out = [];
  if (vals.executable) out.push(vals.executable);
  /* 重定向器找的是「与它自己同名」的基座（pythonw.exe 找 pythonw.exe）—— 报错文案里的路径就是它 */
  if (vals.home) out.push(path.join(vals.home, path.basename(pythonExe)));
  return out.filter((p, i) => p && out.indexOf(p) === i);
}

/**
 * 「看得见就算在」的存在性判断：EACCES / EPERM 一律当「在」。
 * 为什么不能只用 fs.existsSync / statSync：Store 版 Python 的 WindowsApps 目录对 stat 直接返回
 * EACCES（实测：`…\WindowsApps\PythonSoftwareFoundation.Python.3.10_*\pythonw.exe` statSync=EACCES、
 * accessSync=通过），只认 stat 就会把好好的 venv 判成「基座没了」—— 那等于给所有 Store 版用户
 * 制造一次起不来。拿不准一律判「在」：体检只负责拦住「一定会弹框」的那一种。
 */
function pathPresent(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch (e) {
    const code = String((e && e.code) || "");
    return code === "EACCES" || code === "EPERM";
  }
}

/**
 * 解释器体检：{ ok:true } 或 { ok:false, code, exe, base, message }。
 * code = "missing"（解释器本身不在了）/ "stale_venv"（venv 重定向器还在，基座解释器没了）。
 * 拿不准的一律判「可用」（PATH 裸名、读不到 cfg、>1MB 的真解释器副本、stat 被拒）—— 体检只负责
 * 拦住「一定会弹框」的那一种，不制造新的起不来。
 */
function pythonHealth(pythonExe) {
  const exe = String(pythonExe || "").trim();
  if (!exe) return { ok: true, exe };
  /* PATH 里的裸名（python / python3）：不查 PATH 判存在（查了也不准），更不会是 venv 重定向器 */
  if (!/[\\/]/.test(exe)) return { ok: true, exe, bare: true };
  let size = -1;
  try {
    const st = fs.statSync(exe);
    size = st.isFile() ? st.size : -1;
  } catch (e) {
    const code = String((e && e.code) || "");
    if (code === "EACCES" || code === "EPERM") return { ok: true, exe, sizeUnknown: true };
    if (code !== "ENOENT" && code !== "ENOTDIR") return { ok: true, exe, statError: code };
    return {
      ok: false,
      code: "missing",
      exe,
      base: "",
      message:
        "后端 Python 环境已损坏：找不到解释器 " + exe + "（venv 被删 / 被杀软隔离？）。" +
        "请在该插件卡片的安装窗里重装，重建 Python 环境。",
    };
  }
  const cfg = pyvenvCfgPath(exe);
  /* 大文件 = 真解释器副本（python -m venv --copies / 就地解释器）：基座没了它照样能跑，不判死 */
  if (!cfg || size > 1024 * 1024) return { ok: true, exe, redirector: false };
  const gone = pyvenvBaseCandidates(exe, cfg).filter((b) => !pathPresent(b));
  if (!gone.length) return { ok: true, exe, redirector: true, cfg };
  return {
    ok: false,
    code: "stale_venv",
    exe,
    cfg,
    base: gone[0],
    message:
      "后端 Python 环境已失效：" +
      exe +
      " 是 venv 重定向器，它要的基座解释器 " +
      gone[0] +
      " 已经不在了（conda / 系统 Python 被删或搬走）。这种环境起不来 —— 直接起它只会弹一只" +
      "「Python Launcher … No Python at …」的系统消息框，所以这里不再起进程；" +
      "请在该插件卡片的安装窗里重装，重建 Python 环境。",
  };
}

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

module.exports = { quietPython, pythonHealth, pyvenvCfgPath, shimsDir, silentEnv, syncShims };
