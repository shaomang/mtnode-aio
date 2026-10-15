"use strict";
/* llama.cpp 后端「不自己开窗」的回归（本机真跑，不只是扫源码）
 *   node test/smoke-llama-backend-silent.js
 *
 * 背景（本次需求 + 真因）
 * ---------------------------------------------------------------------------
 * 插件卡片点「启用」时，宿主是用 `pythonw.exe` 静默拉后端的（backend-python.js 的 quietPython，
 * 见 test/smoke-console-silent.js），可 llama.cpp 后端**自己**又开了一只窗：
 * `llama-pack/app/console_banner.py` 的 `kernel32.AllocConsole()` + `SetConsoleTitleW(
 * "MTNode llama.cpp Plugin Service")` —— 那是**主动**造一只可见控制台窗（里面还写着「请勿关闭此窗口」），
 * `pythonw` / `CREATE_NO_WINDOW` / `sitecustomize.py` 垫片全都拦不住「代码自己调 AllocConsole」。
 * 本轮改为：**永不新建窗口** —— 已经有控制台（用户自己在终端里跑 start_backend.cmd）就打给那只控制台，
 * 没有控制台（插件宿主静默拉起）就只写管理服务日志 `.console.log`（插件控制台 / ⓘ 浮层读它）。
 *
 * 覆盖：
 *   [1] 源码口径（剥掉注释与文档串后再判）：llama.cpp 后端链路里没有 AllocConsole / CONOUT$ /
 *       窗口标题那句 /「请勿关闭此窗口」；横幅改成「有控制台才打 stdout + 一律落 .console.log」，
 *       日志路径只有一个真源（app/console_log.py，server.py / models.py 都收敛到它）。
 *   [2] 真跑（pythonw 真无控制台）：show_service_banner 之后**零新增可见控制台窗口**，
 *       且横幅正文真落进 .console.log（能用证据读回来，不是「什么都不做」）。
 *       起跑前要求基线为 0 只窗口 —— 桌面上本来就有终端时这条不予判定（显式 SKIP，不算失败）。
 *   [3] 对照组（检测能力自证）：pythonw 拉一只不带 CREATE_NO_WINDOW 的控制台子进程 —— 尺子必须数出窗口，
 *       否则 [2] 那个 0 说明不了任何事（这条机器上数不出窗口时 [2] 显式 SKIP，不算失败）。
 *
 * 窗口尺子与 [3] 的手法沿用 scripts/probe-console-windows.ps1（唯一真源，与 smoke-console-silent 共用）。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PROBE_PS1 = path.join(ROOT, "scripts", "probe-console-windows.ps1");

let checks = 0;
let fails = 0;
let skips = 0;
function ok(cond, msg) {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
}
function skipIt(msg) {
  skips++;
  console.log("  SKIP  " + msg);
}
function has(src, needle, msg) {
  const c = String(src).indexOf(needle) >= 0;
  ok(c, msg + (c ? "" : "（缺 " + JSON.stringify(needle) + "）"));
}
function hasnt(src, needle, msg) {
  const c = String(src).indexOf(needle) < 0;
  ok(c, msg + (c ? "" : "（仍有 " + JSON.stringify(needle) + "）"));
}
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");
}

/** 剥掉 Python 源码里的注释与模块文档串：说明「别调 AllocConsole」的注释不能算违规代码。 */
function stripPy(src) {
  let s = String(src);
  s = s.replace(/"""[\s\S]*?"""/g, "\n");
  s = s.replace(/'''[\s\S]*?'''/g, "\n");
  s = s
    .split(/\r?\n/)
    .map((ln) => ln.replace(/\s+#.*$/, ""))
    .join("\n");
  return s;
}

/** 等一个探针结果文件出现并有内容（最多 timeoutMs）。 */
function readWhenReady(file, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 8000);
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, "utf8");
      if (text.trim()) return text;
    }
    spawnSync("cmd", ["/c", "ping -n 1 -w 250 127.0.0.1 >nul"], { windowsHide: true });
  }
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

/* ── [3] 对照组用的探针：模拟改动前的窗口来源 ──
 * 窗口计数这把尺子本身有脾气：`AllocConsole` 出来的窗在本机**不是每轮都数得到**（见头注的实测记录），
 * 所以对照组改成走那条**稳定**「pythonw 拉控制台子进程 ⇒ Windows 新建一只窗」的机制
 * （与 test/smoke-console-silent.js 的对照组同一手法）：尺子能数出这只窗，就证明 [2] 的 0 是真的 0。 */
const CONTROL_PY = [
  "import subprocess, sys, time",
  "open(sys.argv[1], 'w', encoding='utf-8').write('spawning')",
  "subprocess.Popen(['cmd', '/c', 'ping -n 9 127.0.0.1 >nul'])",
  "time.sleep(9)",
].join("\n");

/* ── [2] 真跑探针：直接调本仓的 show_service_banner（工作目录 = 临时安装目录） ── */
const BANNER_PY = [
  "import sys, time",
  "from app.console_banner import show_service_banner",
  "open(sys.argv[1], 'w', encoding='utf-8').write('entered')",
  "show_service_banner(8765)",
  "open(sys.argv[2], 'w', encoding='utf-8').write('banner-done')",
  "time.sleep(9)",
].join("\n");

/** 找一个真能跑的 pythonw.exe（GUI 子系统 ⇒ 没有控制台，正是生产链路里那只解释器）。 */
function runnable(exe) {
  if (!exe) return false;
  const r = spawnSync(exe, ["-c", "print(1)"], { encoding: "utf8", windowsHide: true, timeout: 20000 });
  return !r.error && r.status === 0;
}
function findPythonw() {
  const cands = [];
  const fromEnv = String(process.env.MTNODE_SMOKE_PYTHONW || "").trim();
  if (fromEnv) cands.push(fromEnv);
  for (const [cmd, pre] of [["py", ["-3"]], ["python", []], ["python3", []]]) {
    const r = spawnSync(cmd, pre.concat(["-c", "import sys;print(sys.executable)"]), {
      encoding: "utf8",
      windowsHide: true,
      timeout: 20000,
    });
    if (r.error || r.status !== 0) continue;
    const exe = String(r.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop() || "";
    if (!exe) continue;
    cands.push(exe);
    const w = exe.replace(/python([\w.]*)\.exe$/i, "python$1w.exe");
    if (w !== exe) cands.push(w);
  }
  return cands.find((p) => /pythonw[\w.]*\.exe$/i.test(p) && runnable(p)) || "";
}

function parseLastJson(text) {
  const line = String(text || "").trim().split(/\r?\n/).filter(Boolean).pop() || "";
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
function psArgs(extra) {
  return ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PROBE_PS1].concat(extra || []);
}
function snapshotWindows() {
  const r = spawnSync("powershell.exe", psArgs([]), { encoding: "utf8", windowsHide: true, timeout: 60000 });
  return parseLastJson(r.stdout);
}
/** 盯 seconds 秒，返回 { peak, distinct, items }（采样在 PowerShell 里做，避免每帧起一只进程）。 */
function watchWindows(seconds, intervalMs) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn("powershell.exe", psArgs(["-WatchSeconds", String(seconds), "-IntervalMs", String(intervalMs)]), {
        windowsHide: true,
      });
    } catch {
      return resolve(null);
    }
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", () => resolve(null));
    child.on("close", () => resolve(parseLastJson(out)));
  });
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
/** 收尾：探针进程 sleep 完会自己退，但别赌它 —— 留一只带控制台的 pythonw 会污染下一轮基线。 */
function killTree(child) {
  const pid = child && child.pid;
  if (!pid) return;
  spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 10000 });
}
/** 跑一个「有 stdout」的探针（模拟用户手动在终端里起后端），返回 { code, stdout }。 */
function runProbeWithStdout(pyw, workDir, scriptPath, args) {
  return new Promise((resolve) => {
    const env = Object.assign({}, process.env, { PYTHONPATH: workDir, PYTHONIOENCODING: "utf-8" });
    let out = "";
    let err = "";
    let child;
    try {
      child = spawn(pyw, [scriptPath].concat(args || []), { cwd: workDir, env, windowsHide: true });
    } catch (e) {
      return resolve({ code: null, stdout: "", error: String((e && e.message) || e) });
    }
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => resolve({ code: null, stdout: out, error: String((e && e.message) || e) }));
    child.on("close", (code) => resolve({ code, stdout: out, stderr: err }));
  });
}
/** 起一个 pythonw 探针（工作目录 = workDir，PYTHONPATH 只挂 workDir）。 */
function spawnProbe(pyw, workDir, scriptPath, args) {
  const env = Object.assign({}, process.env, { PYTHONPATH: workDir, PYTHONIOENCODING: "utf-8" });
  const child = spawn(pyw, [scriptPath].concat(args || []), { cwd: workDir, env, windowsHide: true, stdio: "ignore" });
  child.unref();
  return child;
}
function fmtItems(win) {
  return JSON.stringify(((win && win.items) || []).map((i) => i.cls + ":" + i.pid));
}
/** 起跑前要一条「桌面上没有可见控制台窗」的基线：等最多 ~6 秒，返回 { clean, win }。 */
async function waitCleanBaseline(tries) {
  let last = null;
  for (let i = 0; i < (tries || 20); i++) {
    const win = snapshotWindows();
    if (win && win.ok === true && win.distinct === 0) return { clean: true, win };
    last = win;
    await sleep(300);
  }
  return { clean: false, win: last };
}

(async () => {
  /* ═════════ [1] 源码口径（剥注释与文档串） ═════════ */
  console.log("\n[1] 源码口径：llama.cpp 后端不再自己开窗、横幅改落日志");
  const bannerRaw = read("llama-pack/app/console_banner.py");
  const banner = stripPy(bannerRaw);
  hasnt(banner, "AllocConsole", "console_banner.py 的代码里不再调 AllocConsole（那就是凭空弹的那只窗）");
  hasnt(banner, "CONOUT$", "不再往 CONOUT$ 写（没有控制台时那句必须失败，纯属死代码）");
  hasnt(banner, "SetConsoleTitleW", "不再给窗口起名（窗口本身就不该存在）");
  hasnt(banner, "Keep this window OPEN", "不再有「请勿关闭此窗口」——没有窗口可关");
  hasnt(banner, "请勿关闭此窗口", "中文那句同理删掉");
  has(banner, "_has_usable_stdout", "改成「写一次 stdout 试试」判定（GetConsoleWindow 在有终端的会话里也返回 0，拿它当判据会把手动起后端的人一起静默掉）");
  hasnt(banner, "GetConsoleWindow", "不再拿内核窗口句柄当判据（本机实测在 PowerShell 里也返回 0）");
  has(banner, "from app.console_log import log_line", "横幅的正文写进日志真源 console_log");
  has(banner, "if _has_usable_stdout():", "stdout 通才打它（手动跑 start_backend.cmd 的开发者看得到）");

  const clog = read("llama-pack/app/console_log.py");
  has(clog, 'LOG_PATH = ROOT / ".console.log"', "console_log.py 是日志路径唯一真源（.console.log）");
  has(clog, "def log_line(", "提供 log_line（追加一行，失败不抛）");
  const server = read("llama-pack/app/server.py");
  has(server, "from app.console_log import log_line", "server.py 用日志真源");
  hasnt(server, 'log_path = ROOT / ".console.log"', "server.py 不再自己拼 .console.log 路径");
  has(server, "show_service_banner(port)", "server.py 启动时仍然打一次横幅（只是不再开窗）");
  const modelsSrc = read("llama-pack/app/models.py");
  has(modelsSrc, "from app.console_log import log_line", "models.py 的兜底日志也走真源");
  hasnt(stripPy(modelsSrc), "print(line, flush=True)", "models.py 不再往 stdout 打（宿主 stdio 是 ignore，写进去就丢）");

  /* ═════════ [2]/[3] 真跑：数窗口 ═════════ */
  console.log("\n[2] 真跑 pythonw：横幅零新增窗口 + 正文落日志");
  if (process.platform !== "win32") {
    skipIt("非 win32：这条机制（Windows 新建控制台窗）不存在，跳过");
  } else if (!fs.existsSync(PROBE_PS1)) {
    ok(false, "窗口探针脚本 scripts/probe-console-windows.ps1 存在");
  } else {
    const pyw = findPythonw();
    const snap = pyw ? snapshotWindows() : null;
    if (!pyw) {
      skipIt("本机找不到 pythonw.exe（可用 MTNODE_SMOKE_PYTHONW=<路径> 指定）：跳过真跑");
    } else if (!snap || snap.ok !== true) {
      skipIt("窗口探针跑不起来（powershell / Add-Type 不可用）：跳过真跑");
    } else {
      const base = await waitCleanBaseline(20);
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-llama-silent-"));
      const work = path.join(tmp, "install");
      fs.mkdirSync(path.join(work, "app"), { recursive: true });
      for (const f of ["console_banner.py", "console_log.py", "__init__.py"]) {
        fs.copyFileSync(path.join(ROOT, "llama-pack", "app", f), path.join(work, "app", f));
      }
      const bannerPy = path.join(tmp, "banner-probe.py");
      fs.writeFileSync(bannerPy, BANNER_PY);
      const bannerEntered = path.join(tmp, "banner.entered");
      const bannerDone = path.join(tmp, "banner.done");
      console.log("  · 解释器：" + pyw);
      console.log("  · 临时安装目录：" + work);
      {
        const WATCH = 9;
        const bannerChild = { pid: 0 };
        const run = await Promise.all([
          watchWindows(WATCH, 100),
          (async () => {
            const child = spawnProbe(pyw, work, bannerPy, [bannerEntered, bannerDone]);
            bannerChild.pid = child.pid;
            await sleep(400);
          })(),
        ]);
        const enteredText = readWhenReady(bannerEntered, 15000);
        const doneText = readWhenReady(bannerDone, 15000);
        const logText = readWhenReady(path.join(work, ".console.log"), 8000);
        const win = base.clean ? run[0] : null;
        killTree(bannerChild);
        if (!base.clean) {
          skipIt(
            "起跑前桌面上已有可见控制台窗（distinct=" + ((base.win && base.win.distinct) || "?") +
              " · " + fmtItems(base.win) + "）：这一轮数不出「新增」，" +
              "「show_service_banner 零新增窗口」不予判定（源码口径见 [1]）",
          );
        }

        ok(enteredText.trim() === "entered", "探针真进到了 show_service_banner（stage marker 已写）");
        ok(doneText.trim() === "banner-done", "show_service_banner 真跑完了（stage marker 已写）");
        has(logText, "  API   http://127.0.0.1:8765/v1", "横幅正文落进了 .console.log（不是「什么都不做」）");
        has(logText, "S e r v i c e", "日志里就是那段 llama.cpp Service 横幅（含 API 与运行方式说明）");
        if (!win) {
          skipIt("没拿到窗口读数（探针异常）：跳过「零新增窗口」断言");
        } else {
          console.log("  · 实测：peak=" + win.peak + " distinct=" + win.distinct + " · " + fmtItems(win));
          ok(
            win.distinct === 0,
            "show_service_banner 调用前后零新增可见控制台窗口（实测 distinct=" + win.distinct + "）",
          );
        }
      }

      /* ── [2b] 手动起后端那条路不能被一起静默掉：stdout 通的时候横幅照旧打给它 ── */
      console.log("\n[2b] 手动跑（stdout 通）：横幅照旧打在终端里，同时落日志");
      const manualWork = path.join(tmp, "manual");
      fs.mkdirSync(path.join(manualWork, "app"), { recursive: true });
      for (const f of ["console_banner.py", "console_log.py", "__init__.py"]) {
        fs.copyFileSync(path.join(ROOT, "llama-pack", "app", f), path.join(manualWork, "app", f));
      }
      const manual = await runProbeWithStdout(pyw, manualWork, bannerPy, [
        path.join(tmp, "manual.entered"),
        path.join(tmp, "manual.done"),
      ]);
      ok(manual.code === 0, "有 stdout 的探针正常跑完（exit=" + manual.code + "）");
      has(manual.stdout || "", "S e r v i c e", "横幅真打在了 stdout（手动起后端的人看得见）");
      has(manual.stdout || "", "  API   http://127.0.0.1:8765/v1", "stdout 的横幅带着本次端口");
      has(
        readWhenReady(path.join(manualWork, ".console.log"), 8000),
        "  API   http://127.0.0.1:8765/v1",
        "同一次跑也照样落 .console.log（插件浮层与终端两条路都有）",
      );

      /* ── [3] 对照组：pythonw 拉一只不带 CREATE_NO_WINDOW 的控制台子进程，
             尺子必须数出窗口 —— 否则 [2] 那个 0 说明不了任何事 ── */
      console.log("\n[3] 对照组（检测能力自证）：pythonw 拉控制台子进程必须数出窗口");
      const ctlPy = path.join(tmp, "control-probe.py");
      fs.writeFileSync(ctlPy, CONTROL_PY);
      const ctlStart = path.join(tmp, "ctl.start");
      const ctlChild = { pid: 0 };
      const ctl = await Promise.all([
        watchWindows(9, 100),
        (async () => {
          const child = spawnProbe(pyw, work, ctlPy, [ctlStart]);
          ctlChild.pid = child.pid;
          await sleep(400);
        })(),
      ]);
      const ctlWin = ctl[0];
      const ctlStartText = readWhenReady(ctlStart, 15000);
      killTree(ctlChild);
      if (ctlStartText.trim() !== "spawning") {
        skipIt("对照组探针没起来（stage marker 缺失）：跳过检测能力自证");
      } else if (!ctlWin) {
        skipIt("对照组没拿到窗口读数（探针异常）：跳过检测能力自证");
      } else if (ctlWin.distinct === 0) {
        skipIt(
          "对照组一只窗口都没数出来（无交互桌面 / 没有默认终端宿主）：这条机器上「零新增窗口」无从判定，" +
            "源码口径与「横幅落日志」已由 [1][2] 钉住",
        );
      } else {
        console.log("  · 对照组实测：peak=" + ctlWin.peak + " distinct=" + ctlWin.distinct + " · " + fmtItems(ctlWin));
        ok(ctlWin.distinct > 0, "对照组数出了窗口（distinct=" + ctlWin.distinct + "）—— 同一把尺子下 [2] 是 0，反差成立");
      }

      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {}
    }
  }

  console.log(
    "\n" +
      (fails ? "FAILED " + fails + " / " + checks : "ALL PASS " + checks) +
      " checks" +
      (skips ? "（" + skips + " 项 SKIP：环境不具备，不算失败）" : ""),
  );
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
