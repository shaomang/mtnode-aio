"use strict";
/* 插件后端「整条子进程子树静默」的回归
 *   node test/smoke-console-silent.js
 *
 * 背景（本次需求 + 根因，详见 docs/plugin-console-silence.md）
 * ---------------------------------------------------------------------------
 * 宿主用 pythonw.exe 起后端（backend-python.js 的 quietPython：GUI 子系统 ⇒ 没有控制台），
 * 于是**后端拉起的任何控制台子进程**只要自己没传 CREATE_NO_WINDOW，Windows 就给它新建一只
 * 可见的终端窗口。已移除的 GPT-SoVITS 训练时那「大批窗口」就是这么来的：`tools/my_utils.py::load_audio()`
 * 走 ffmpeg-python（裸 Popen）逐音频条目调用，s2 的 DataLoader 还开着 5 个 worker（s1 侧 12 个）。
 * 实测（本机真实引擎）：pythonw 下连调 12 次 load_audio → 22 个可见控制台窗口对象。
 *
 * 解法：随包分发的 `shims/sitecustomize.py`（真源 pack-shims/sitecustomize.py）挂在子进程
 * PYTHONPATH 最前，CPython 启动时自动 import，进程级给 subprocess.Popen 与 os.system / os.popen
 * 补默认 CREATE_NO_WINDOW；子进程继承 PYTHONPATH ⇒ multiprocessing / DataLoader 的 worker 同样生效。
 *
 * 覆盖：
 *   [1] 垫片真源内容 + 6 个 Python pack 的副本逐字节一致 + build.json 白名单
 *   [2] 宿主接线：silentEnv 挂 PYTHONPATH、h3 / music3 / yue 的脚手架同步带上 shims/
 *   [3] 真枚举（真跑 pythonw + PowerShell 数窗口）：不带垫片时会冒窗口（检测能力自证），
 *       带上垫片后**零新增可见控制台窗口**。环境不具备（找不到 pythonw / 无交互桌面 /
 *       没有默认终端宿主）时显式 SKIP —— 环境问题不算回归失败，但会打印原因。
 *
 * 复跑尺子：scripts/probe-console-windows.ps1（本测试与人工排查共用同一份，唯一真源）
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PROBE_PS1 = path.join(ROOT, "scripts", "probe-console-windows.ps1");
const SHIM_SRC_REL = "pack-shims/sitecustomize.py";
const SHIM_SRC = path.join(ROOT, "pack-shims", "sitecustomize.py");

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
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");
}

/* 【3】用的 pythonw 探针：交错走 subprocess 与 os.system 两条路径 */
const CHILD_PROBE_PY = [
  "import os, subprocess, sys, time",
  'print("hook=%d" % (1 if getattr(subprocess.Popen, "_mtnode_silent", False) else 0), flush=True)',
  'print("os_system=%d" % (1 if getattr(os.system, "_mtnode_silent", False) else 0), flush=True)',
  "n = int(sys.argv[1]) if len(sys.argv) > 1 else 5",
  "for i in range(n):",
  "    if i % 2:",
  '        os.system("ping -n 2 127.0.0.1 >nul")',
  "    else:",
  '        subprocess.run(["cmd", "/c", "ping -n 2 127.0.0.1 >nul"])',
  "    time.sleep(0.1)",
  'print("done", flush=True)',
].join("\n");

/** 候选解释器「真能跑」吗？——不能用 fs.existsSync：Store 版 Python 的 WindowsApps 目录受 ACL 保护，
 *  文件明明在也 existsSync=false（本机实测），而 spawn 它是可以的。 */
function runnable(exe) {
  if (!exe) return false;
  const r = spawnSync(exe, ["-c", "print(1)"], { encoding: "utf8", windowsHide: true, timeout: 20000 });
  return !r.error && r.status === 0;
}

/** 找一个 pythonw.exe（GUI 子系统 ⇒ 没有控制台，正是生产链路里那只解释器）。 */
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

/** 单帧快照（探针可用性自检）。 */
function snapshotWindows() {
  const r = spawnSync("powershell.exe", psArgs([]), { encoding: "utf8", windowsHide: true, timeout: 60000 });
  return parseLastJson(r.stdout);
}

/** 盯 seconds 秒，返回 { peak, distinct }（探针脚本自己做采样，避免每帧起一只 PowerShell）。 */
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

/** 跑一次 pythonw 探针；hookDir 非空 = 把垫片目录挂在 PYTHONPATH 最前。 */
function runChildProbe(py, probePyPath, hookDir) {
  return new Promise((resolve) => {
    const env = Object.assign({}, process.env);
    if (hookDir) env.PYTHONPATH = hookDir + path.delimiter + String(env.PYTHONPATH || "");
    else delete env.PYTHONPATH;
    let out = "";
    let child;
    try {
      child = spawn(py, [probePyPath, "5"], { env, windowsHide: true });
    } catch (e) {
      return resolve({ hook: null, osSystem: null, out: String((e && e.message) || e) });
    }
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("error", (e) => resolve({ hook: null, osSystem: null, out: out + String((e && e.message) || e) }));
    child.on("close", () => {
      const h = /hook=(\d)/.exec(out);
      const s = /os_system=(\d)/.exec(out);
      resolve({ hook: h ? Number(h[1]) : null, osSystem: s ? Number(s[1]) : null, out });
    });
  });
}

(async () => {
  const PACKS = ["h3-pack", "music3-pack", "yue-pack", "breeze-pack", "llama-pack", "sensenova-pack"];

  /* ═════════ [1] 垫片真源与随包副本 ═════════ */
  console.log("\n[1] 垫片真源 pack-shims/sitecustomize.py 与 6 个 Python pack 副本");
  const src = read(SHIM_SRC_REL);
  has(src, "_CREATE_NO_WINDOW = 0x08000000", "真源定义 CREATE_NO_WINDOW");
  has(src, 'sys.platform == "win32"', "只在 win32 生效（其它平台整模块空转）");
  has(src, "popen.__init__ = _mtnode_init", "给 subprocess.Popen 补默认标志（run / call / check_output 一并覆盖）");
  has(src, "os.system = _mtnode_system", "os.system 改走带标志的 subprocess（uvr5 那类调用）");
  has(src, "os.popen = _mtnode_popen", "os.popen 同理");
  has(src, 'kwargs.get("creationflags")', "显式传了 creationflags 的调用不覆盖（谁想要窗口谁自己传）");
  has(src, 'kwargs.get("startupinfo") is None', "显式给了 startupinfo 的调用也不覆盖");
  const wantBytes = fs.readFileSync(SHIM_SRC);
  const diff = [];
  const missing = [];
  for (const p of PACKS) {
    const f = path.join(ROOT, p, "shims", "sitecustomize.py");
    if (!fs.existsSync(f)) missing.push(p);
    else if (!fs.readFileSync(f).equals(wantBytes)) diff.push(p);
  }
  ok(missing.length === 0, "6 个 Python pack 都带 shims/sitecustomize.py" + (missing.length ? "（缺：" + missing.join("、") + "）" : ""));
  ok(diff.length === 0, "副本与真源逐字节一致" + (diff.length ? "（不一致：" + diff.join("、") + "）" : ""));
  const build = read("build.json");
  const noShims = PACKS.filter((p) => {
    const seg = build.split('"from": "' + p + '"')[1] || "";
    const filterPart = seg.slice(0, seg.indexOf('"from": ') >= 0 ? seg.indexOf('"from": ') : 2000);
    return filterPart.indexOf('"shims/**"') < 0;
  });
  ok(
    noShims.length === 0,
    "build.json 的 6 个 Python pack 白名单都含 shims/**（漏了 = 打包后装出来的目录里没有垫片）" +
      (noShims.length ? "（漏：" + noShims.join("、") + "）" : ""),
  );

  /* ═════════ [2] 宿主接线 ═════════ */
  console.log("\n[2] 宿主接线：silentEnv 挂 PYTHONPATH / 脚手架同步带 shims");
  const bp = read("backend-python.js");
  has(bp, "function silentEnv(", "backend-python.js 提供 silentEnv（唯一真源）");
  has(bp, "function syncShims(", "backend-python.js 提供 syncShims（把 pack 的 shims 同步进安装目录）");
  has(bp, 'out.PYTHONPATH = prev ? dir + path.delimiter + prev : dir;', "silentEnv 把 shims 目录挂在 PYTHONPATH 最前，保留原值");
  const { silentEnv, shimsDir, syncShims } = require(path.join(ROOT, "backend-python.js"));
  ok(
    silentEnv("C:/x/tts", {}).PYTHONPATH === shimsDir("C:/x/tts"),
    "silentEnv 在没有原 PYTHONPATH 时就是 shims 目录本身",
  );
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-console-silent-"));
  fs.mkdirSync(path.join(tmp, "pack", "shims"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "pack", "shims", "sitecustomize.py"), "# stub");
  fs.mkdirSync(path.join(tmp, "install"), { recursive: true });
  const sr = syncShims(path.join(tmp, "pack"), path.join(tmp, "install"));
  ok(
    sr.ok === true && fs.existsSync(path.join(tmp, "install", "shims", "sitecustomize.py")),
    "syncShims 真把 pack 的 shims/ 拷进安装目录",
  );
  const HOSTS = [
    "h3/main-h3.js",
    "music3/main-music3.js",
    "yue/main-yue.js",
    "breeze/main-breeze.js",
    "llama/main-llama.js",
    "sensenova/main-sensenova.js",
  ];
  for (const f of HOSTS) {
    const s = read(f);
    has(s, "silentEnv", f + " 从 backend-python.js 取静默口径");
    has(s, "silentEnv(", f + " 起后端时把 shims 挂上 PYTHONPATH");
  }
  for (const f of ["h3/main-h3.js", "music3/main-music3.js", "yue/main-yue.js"]) {
    has(read(f), "syncShims(", f + " 的脚手架同步带上 shims/（它只挑着拷 app/*.py，不显式拷就会漏）");
  }
  /* 部署指纹里带 shims 的宿主（升级垫片后能重启到新口径）：全仓当前只有 breeze 走这套指纹 */
  const fingerprintHosts = ["breeze/main-breeze.js"];
  for (const f of fingerprintHosts) {
    has(read(f), 'walk(join(pack, "shims"), "shims")', f + " 的部署指纹含 shims（升级后后端会重启到新口径）");
  }

  /* ═════════ [3] 真枚举：数窗口 ═════════ */
  console.log("\n[3] 真跑 pythonw + 数可见控制台窗口（真源尺子：" + path.relative(ROOT, PROBE_PS1) + "）");
  if (process.platform !== "win32") {
    skipIt("非 win32：这条机制（Windows 给无控制台的父进程新建 console）不存在，跳过");
  } else if (!fs.existsSync(PROBE_PS1)) {
    ok(false, "窗口探针脚本 scripts/probe-console-windows.ps1 存在");
  } else {
    const pyw = findPythonw();
    if (!pyw) {
      skipIt("本机找不到 pythonw.exe（可用 MTNODE_SMOKE_PYTHONW=<路径> 指定）：跳过真枚举");
    } else {
      const snap = snapshotWindows();
      if (!snap || snap.ok !== true) {
        skipIt("窗口探针跑不起来（powershell / Add-Type 不可用）：跳过真枚举");
      } else {
        const probePy = path.join(tmp, "child-probe.py");
        fs.writeFileSync(probePy, CHILD_PROBE_PY);
        const WATCH = 8;
        console.log("  · 解释器：" + pyw);
        const ctl = await Promise.all([watchWindows(WATCH, 120), runChildProbe(pyw, probePy, "")]);
        const ctlWin = ctl[0];
        const ctlRun = ctl[1];
        ok(ctlRun.hook === 0, "对照组：子进程没有加载垫片（hook=0）");
        ok(ctlRun.osSystem === 0, "对照组：os.system 也没被改（os_system=0）");
        if (!ctlWin) {
          skipIt("对照组没拿到窗口读数（探针异常）：跳过「零新增窗口」断言");
        } else {
          console.log(
            "  · 对照组实测（不带垫片）：peak=" + ctlWin.peak + " distinct=" + ctlWin.distinct +
              " 只窗口 —— 检测能力自证",
          );
          const hookDir = path.join(ROOT, "pack-shims");
          const exp = await Promise.all([watchWindows(WATCH, 120), runChildProbe(pyw, probePy, hookDir)]);
          const expWin = exp[0];
          const expRun = exp[1];
          ok(expRun.hook === 1, "实验组：sitecustomize 垫片真的加载了（hook=1）");
          ok(expRun.osSystem === 1, "实验组：os.system 也被接管（os_system=1）");
          if (ctlWin.distinct === 0) {
            skipIt(
              "对照组一只窗口都没冒出来（无交互桌面 / 没有默认终端宿主）：这条机器上看不到窗口，" +
                "「零新增窗口」断言无从判定 —— 垫片是否加载已由上面两条钉住",
            );
          } else if (!expWin) {
            skipIt("实验组没拿到窗口读数（探针异常）：跳过「零新增窗口」断言");
          } else {
            ok(
              expWin.distinct === 0,
              "带上垫片后子进程零新增可见控制台窗口（实测 distinct=" + expWin.distinct + "）",
            );
          }
        }
      }
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
