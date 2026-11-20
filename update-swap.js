"use strict";
/**
 * 退出瞬间交换（swap）：把已经预装好的旁路目录（`<安装目录>.stage`）换成正式的安装目录。
 *
 * ── 为什么必须是独立进程 ──────────────────────────────────────────────────────
 * Windows 上正在运行的 exe 与它的工作目录都会把「父目录改名」锁住，所以交换只能在主应用
 * **真正退出之后**做；也就是说干活的那个进程必须比主进程活得久。形态固定为：
 *   ① 主进程（退出前）把 helper 脚本复制到 `%LOCALAPPDATA%\MTNodeAIO-update\`
 *      —— 放在安装目录之外：那个目录马上要改名，脚本放里面等于拆自己脚下的地板；
 *   ② `cmd /c powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <脚本> …`
 *      以 windowsHide + detached + stdio ignore 拉起，参数带 pid / 安装目录 / 旁路目录 / 新版本号；
 *   ③ helper 先等那个 pid 退出（60s 超时即放弃并留痕），再做两次同卷 rename。
 * helper 用 PowerShell：系统自带、不受 asar 影响、不依赖主进程或安装目录里的任何文件。
 * 脚本正文在 update-swap-helper.ps1（构建白名单里必须带上，见 build.json）。
 *
 * ── 交换序列（任一步失败都回滚并写 swap-result.json，绝不留静默半成品）────────
 *   等 pid 退出 → installDir → `<安装目录>.old-<旧版本>`（毫秒级）
 *   → stageDir → installDir（失败就把 .old 改回去）→ 收尾（注册表 / 快捷方式 / 差分基座备份）
 *   → 拉起新版本（带 --updated，与 NSIS 装完自动重开同一语义）→ 后台删 .old（失败重试，
 *   残留写进结果交给下次启动清理）。
 *
 * ── 回落 ─────────────────────────────────────────────────────────────────────
 * 机器级安装（HKLM 有 InstallLocation）/ 旁路与安装目录不同卷 / 目录不安全 / helper 跑不了 /
 * 任何前置校验不过 → 返回 `{ ok:false, unsupported:true, reason }`，由 updater 回落既有的
 * quitAndInstall（可见向导就地安装）。本模块自己从不抛错、从不假装成功。
 *
 * 边界：本模块只做「交换 + 收尾」，不 require electron（便于单独测试与复用），
 * 也不管什么时候该交换（那是 updater.restartToApply / 退出钩子的事）。
 */
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const { spawn } = require("child_process");

/** helper 落盘目录（安装目录之外；带产品名，排障一眼认得出是谁的） */
const HELPER_DIR_NAME = "MTNodeAIO-update";
const HELPER_SCRIPT_NAME = "swap-helper.ps1";
/** 仓库里的脚本正文（打包后在 asar 内，fs 能读；要**执行**必须先复制出去） */
const HELPER_SOURCE = path.join(__dirname, "update-swap-helper.ps1");
/** 交换结论（helper 每跑一次重写一份；主进程下次启动读它收尾） */
const RESULT_NAME = "swap-result.json";
/** helper 日志（追加；「超时放弃」这类事只能靠它留痕） */
const LOG_NAME = "swap-helper.log";
/** 等主进程退出最长 60 秒：超过就放弃，一个字节都不动 */
const SWAP_WAIT_MS = 60000;
/** 拉起 helper 后确认「它真的起来了」的上限（正常 ~0.3–1s；起不来就别退出应用） */
const SWAP_CONFIRM_MS = 3000;
/** 旁路目录后缀：只认我们自己造的那一个（拿别的目录去做交换是事故） */
const STAGE_DIR_SUFFIX = ".stage";
/** 交换后旧目录 = `<安装目录>.old-<旧版本>`；主进程下次启动按这个前缀清残留 */
const OLD_DIR_SUFFIX = ".old-";
/** 安装登记的 APP_GUID（与 updater.js / installer.nsh 同源，改 appId 要跟着改） */
const INSTALL_APP_GUID = "5b5a6f4f-0946-51d3-a887-4a5488acb989";
const REG_INSTALL_KEY = "Software\\" + INSTALL_APP_GUID;

function errMsg(e) {
  return String((e && e.message) || e || "");
}

/** 系统目录下的原生 exe（reg / powershell 都只从 System32 起，不吃 PATH） */
function sysNative(name) {
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  return path.join(root, "System32", name);
}
function regExe() {
  return sysNative("reg.exe");
}
function powershellExe() {
  return sysNative(path.join("WindowsPowerShell", "v1.0", "powershell.exe"));
}

/** helper 目录（%LOCALAPPDATA%\MTNodeAIO-update；LOCALAPPDATA 缺失时按 homedir 推） */
function helperDir() {
  const base = process.env.LOCALAPPDATA || (os.homedir() ? path.join(os.homedir(), "AppData", "Local") : "");
  return base ? path.join(base, HELPER_DIR_NAME) : "";
}

function helperPaths(dir) {
  const d = dir || helperDir();
  return {
    dir: d,
    script: d ? path.join(d, HELPER_SCRIPT_NAME) : "",
    result: d ? path.join(d, RESULT_NAME) : "",
    log: d ? path.join(d, LOG_NAME) : "",
  };
}

/** 建helper 目录并确认可写（不可写 = 前置校验不过，回落旧路径） */
async function ensureHelperDir() {
  const d = helperDir();
  if (!d || !path.isAbsolute(d)) return "";
  try {
    await fsp.mkdir(d, { recursive: true });
    await fsp.access(d, fs.constants.W_OK);
    return d;
  } catch (_) {
    return "";
  }
}

/* ── 小工具 ─────────────────────────────────────────────────────────────── */

/** 目录路径归一：去掉尾部分隔符（`C:\app\` 与 `C:\app` 在 rename 里是两个名字） */
function normalizeDir(p) {
  const s = String(p || "").trim();
  if (!s) return "";
  const t = s.replace(/[\\/]+$/, "");
  return t || s;
}

/**
 * 走 cmd /c 的路径不能带这些字符：cmd 会拿 `& | < > ^` 当分隔符、拿 `%` 做变量展开、
 * 拿 `!` 做延迟展开，而路径里的引号会把整条命令行拆坏。碰到就前置校验不过（回落旧路径），
 * 不在这种路径上赌命令行解析。
 */
function unsafeForCmd(p) {
  return /["`&|<>^%!\r\n]/.test(String(p || ""));
}

async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch (_) {
    return false;
  }
}

/** 起一个子进程收 stdout / stderr / 退出码（只用于 reg query；不抛错） */
function execCapture(exe, args, timeoutMs) {
  return new Promise((resolve) => {
    let out = "";
    let errt = "";
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    let child = null;
    try {
      child = spawn(exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      finish({ code: -1, out: "", err: errMsg(e) });
      return;
    }
    const ms = Math.max(1000, Number(timeoutMs) || 10000);
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch (_) {}
      finish({ code: -1, out, err: errt || "timeout" });
    }, ms);
    try {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (d) => {
        out += d;
      });
      child.stderr.on("data", (d) => {
        errt += d;
      });
    } catch (_) {}
    child.on("error", (e) => {
      clearTimeout(timer);
      finish({ code: -1, out, err: errMsg(e) });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      finish({ code: code == null ? -1 : code, out, err: errt });
    });
  });
}

/** 读一个注册表值（读不到回空串：分不清「没这个值」与「没权限」在这里不影响判定） */
async function regRead(key, name) {
  const r = await execCapture(regExe(), ["query", key, "/v", name], 10000);
  if (r.code !== 0) return "";
  const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = r.out.match(new RegExp("^\\s+" + esc + "\\s+REG_\\w+\\s+(.*)$", "mi"));
  return m ? String(m[1]).trim() : "";
}

/* ── helper 结论文件 ─────────────────────────────────────────────────────── */

/**
 * 读 helper 的结论（没有 / 坏了都回 null）。
 * 去 BOM：PowerShell 5.1 的文本类写入会加 BOM，而 JSON.parse 见到 BOM 直接抛错。
 */
async function readSwapResult(file) {
  const f = file || helperPaths().result;
  if (!f) return null;
  try {
    const txt = (await fsp.readFile(f, "utf8")).replace(/^\uFEFF/, "");
    if (!txt.trim()) return null;
    return JSON.parse(txt);
  } catch (_) {
    return null;
  }
}

/** 结论文件写一份（原子 tmp + rename）：拉起前后各写一次，留痕用 */
async function writeSwapResult(obj, file) {
  const f = file || helperPaths().result;
  if (!f) return false;
  try {
    await fsp.mkdir(path.dirname(f), { recursive: true });
    const tmp = f + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(obj, null, 2), "utf8");
    await fsp.rename(tmp, f);
    return true;
  } catch (_) {
    return false;
  }
}

/* ── 前置闸：任一不过就 unsupported（由调用方回落 quitAndInstall） ───────── */

/**
 * 交换前置校验（只读，不改任何东西）。
 * 顺序按代价排：平台 > 路径形状 > 目录内容 > helper 目录 / PowerShell > 注册表。
 * 返回 { ok:true, installDir, stageDir, exeName, … } 或 { ok:false, unsupported:true, reason }。
 */
async function swapPreflight(info) {
  const i = info || {};
  if (process.platform !== "win32") return { ok: false, unsupported: true, reason: "platform" };
  const installDir = normalizeDir(i.installDir);
  const stageDir = normalizeDir(i.stageDir);
  if (!installDir || !path.isAbsolute(installDir)) {
    return { ok: false, unsupported: true, reason: "no_install_dir" };
  }
  if (!stageDir || !path.isAbsolute(stageDir)) {
    return { ok: false, unsupported: true, reason: "no_stage_dir" };
  }
  /* 只认我们自己造出来的旁路目录（后缀是硬闸：绝不拿别的目录去换正式目录） */
  if (!stageDir.endsWith(STAGE_DIR_SUFFIX)) {
    return { ok: false, unsupported: true, reason: "bad_stage_dir", stageDir };
  }
  /* 同目录的兄弟关系：rename 是「同卷」操作，跨卷会退化成复制 + 删除，毫秒级就不成立了 */
  if (path.parse(stageDir).root.toLowerCase() !== path.parse(installDir).root.toLowerCase()) {
    return { ok: false, unsupported: true, reason: "cross_volume", stageDir, installDir };
  }
  if (path.dirname(stageDir).toLowerCase() !== path.dirname(installDir).toLowerCase()) {
    return { ok: false, unsupported: true, reason: "stage_not_sibling", stageDir, installDir };
  }
  const exeName = String(i.exeName || "MTNodeAIO.exe");
  const paths = helperPaths();
  const ps = powershellExe();
  for (const p of [installDir, stageDir, paths.dir, ps]) {
    if (unsafeForCmd(p)) return { ok: false, unsupported: true, reason: "unsafe_path", path: p };
  }
  if (!(await pathExists(installDir))) {
    return { ok: false, unsupported: true, reason: "install_dir_missing", installDir };
  }
  /* 旁路目录必须真的是一份完整安装（/D 被丢掉时那儿只剩空壳，见 docs §8.2） */
  if (!(await pathExists(path.join(stageDir, exeName)))) {
    return { ok: false, unsupported: true, reason: "stage_dir_incomplete", stageDir };
  }
  if (!(await pathExists(ps))) {
    return { ok: false, unsupported: true, reason: "powershell_missing" };
  }
  /* helper 正文必须读得到（打包后在 asar 内）：这里直接真读一次而不是只判存在 ——
     判存在用的是 access，它对 asar 虚拟路径的支持不如 readFile 稳；读不到就是「这台机器
     做不了交换」，回落就地安装，不能在退出前才发现脚本是空的 */
  try {
    const probe = await fsp.readFile(HELPER_SOURCE, "utf8");
    if (!probe || probe.length < 200) {
      return { ok: false, unsupported: true, reason: "helper_source_empty" };
    }
  } catch (e) {
    return { ok: false, unsupported: true, reason: "helper_source_missing", detail: errMsg(e) };
  }
  const dir = await ensureHelperDir();
  if (!dir) return { ok: false, unsupported: true, reason: "helper_dir_unavailable" };
  /* 机器级安装：安装器写 HKLM，静默安装要 UAC，helper 也没权限改 HKLM 的登记 —— 一律回落旧路径 */
  const hklm = await regRead("HKLM\\" + REG_INSTALL_KEY, "InstallLocation");
  if (hklm) {
    return { ok: false, unsupported: true, reason: "machine_level_install", registeredInstallDir: hklm };
  }
  return {
    ok: true,
    installDir,
    stageDir,
    exeName,
    helperDir: dir,
    oldVersion: String(i.oldVersion || i.appVersion || ""),
    newVersion: String(i.version || ""),
    cacheDir: normalizeDir(i.cacheDir),
    backupDir: normalizeDir(i.backupDir),
    appGuid: String(i.appGuid || INSTALL_APP_GUID),
  };
}

/* ── 拉起 helper ─────────────────────────────────────────────────────────── */

/** 给 cmd /c 用的一层引号（路径已由前置闸保证不含引号与 cmd 特殊字符） */
function quoteForCmd(v) {
  return '"' + String(v == null ? "" : v) + '"';
}

/**
 * 拼命令行。刻意 **不走 shell**、也不让 Node 替我们加引号（windowsVerbatimArguments:true）：
 * Node 默认那套 `\"` 转义是给 CreateProcess 的，cmd 不认识，会把路径拆坏。
 */
function buildCommand(info) {
  const parts = [
    quoteForCmd(powershellExe()),
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    quoteForCmd(info.script),
    "-AppPid",
    String(info.appPid),
    "-InstallDir",
    quoteForCmd(info.installDir),
    "-StageDir",
    quoteForCmd(info.stageDir),
    "-ExeName",
    quoteForCmd(info.exeName),
    "-OldVersion",
    quoteForCmd(info.oldVersion),
    "-NewVersion",
    quoteForCmd(info.newVersion),
    "-AppGuid",
    quoteForCmd(info.appGuid),
    "-ResultFile",
    quoteForCmd(info.resultFile),
    "-LogFile",
    quoteForCmd(info.logFile),
    "-CacheDir",
    quoteForCmd(info.cacheDir),
    "-BackupDir",
    quoteForCmd(info.backupDir),
    "-RunId",
    quoteForCmd(info.runId),
    "-WaitMs",
    String(info.waitMs),
  ];
  return parts.join(" ");
}

/**
 * 把 helper 脚本复制到 `%LOCALAPPDATA%\MTNodeAIO-update\` 并用 cmd /c 拉起（windowsHide +
 * detached + stdio ignore）。cwd 必须挪到 helper 目录：子进程继承主进程的工作目录，
 * 而主进程的工作目录**就是安装目录** —— 带着它去 rename 安装目录，等于自己把自己锁死。
 * 返回值只有「命令起来了 / 没起来」，交换成不成由 helper 写进 swap-result.json。
 */
async function launchSwapper(info) {
  const i = info || {};
  const dir = i.helperDir || (await ensureHelperDir());
  if (!dir) return { ok: false, error: "helper_dir_unavailable" };
  const paths = helperPaths(dir);
  let body = "";
  try {
    body = await fsp.readFile(HELPER_SOURCE, "utf8");
  } catch (e) {
    return { ok: false, error: "helper_source_unreadable:" + errMsg(e) };
  }
  body = body.replace(/^\uFEFF/, "");
  try {
    /* UTF-8 BOM：Windows PowerShell 5.1 读「无 BOM 的 UTF-8」会按 ANSI 解释，
       脚本里的中文注释与文案会变乱码（不影响逻辑，但日志没法看）。 */
    await fsp.writeFile(paths.script, "\uFEFF" + body, "utf8");
  } catch (e) {
    return { ok: false, error: "helper_write_failed:" + errMsg(e) };
  }
  const runId = String(i.runId || (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)));
  /* 上一轮的结论不能冒充这一轮：先清掉，再落一个 launching 标记（helper 起来后会覆写） */
  try {
    await fsp.unlink(paths.result);
  } catch (_) {}
  const marker = {
    schema: 1,
    runId,
    phase: "launching",
    ok: false,
    swapped: false,
    installDir: i.installDir || "",
    stageDir: i.stageDir || "",
    oldVersion: i.oldVersion || "",
    newVersion: i.newVersion || "",
    at: new Date().toISOString(),
  };
  await writeSwapResult(marker, paths.result);

  const command = buildCommand({
    script: paths.script,
    appPid: Number(i.appPid) || process.pid,
    installDir: i.installDir || "",
    stageDir: i.stageDir || "",
    exeName: String(i.exeName || "MTNodeAIO.exe"),
    oldVersion: String(i.oldVersion || ""),
    newVersion: String(i.newVersion || ""),
    appGuid: String(i.appGuid || INSTALL_APP_GUID),
    resultFile: paths.result,
    logFile: paths.log,
    cacheDir: i.cacheDir || "",
    backupDir: i.backupDir || "",
    runId,
    waitMs: Number(i.waitMs) || SWAP_WAIT_MS,
  });
  let child = null;
  try {
    /* 最外层那对引号是给 cmd 的：`cmd /c "<引号开头的命令行>"` 时，cmd 会按规则「砍掉第一个
       引号 + 砍掉最后一个引号」（cmd /? 的第 2 条），而我们这条命令正是以 powershell.exe 的
       带引号路径开头 —— 不套这层，参数会被拆坏（实测报 is not recognized）。套一层之后
       首尾那对引号被砍掉，剩下的正好是完整命令行。 */
    child = spawn("cmd.exe", ["/c", '"' + command + '"'], {
      /* cmd 的 cwd 挪到 helper 目录：见本函数开头那条注释（别让子进程继承安装目录当 CWD） */
      cwd: dir,
      windowsHide: true,
      /* 命令行由我们自己拼：Node 默认的加引号 / 转义规则是给 CreateProcess 的，cmd 不认 */
      windowsVerbatimArguments: true,
      detached: true,
      stdio: "ignore",
    });
  } catch (e) {
    return { ok: false, error: "spawn_failed:" + errMsg(e), command };
  }
  try {
    child.unref();
  } catch (_) {}
  child.on("error", () => {});
  return {
    ok: true,
    runId,
    cmdPid: child.pid || 0,
    helperDir: dir,
    script: paths.script,
    resultFile: paths.result,
    logFile: paths.log,
    /* command = powershell 那一层；cmdLine = 实际交给 cmd /c 的整条（排障时照抄可复现） */
    command,
    cmdLine: 'cmd.exe /c "' + command + '"',
  };
}

/** 等 helper 把相位从 launching 写走（即它真的跑起来了）；超时回 null */
async function waitHelperStart(resultFile, runId, timeoutMs) {
  const deadline = Date.now() + Math.max(300, Number(timeoutMs) || SWAP_CONFIRM_MS);
  while (Date.now() < deadline) {
    const j = await readSwapResult(resultFile);
    if (j && (!runId || j.runId === runId) && j.phase && j.phase !== "launching") return j;
    await new Promise((r) => setTimeout(r, 120));
  }
  return null;
}

/* ── 给 updater.setSwapRunner 用的那一个函数 ─────────────────────────────── */

/**
 * 生成交换器（`swapRunner(info)`），注册到 updater 的 setSwapRunner 上。
 * info 就是 stageInfo + { version, oldVersion, exeName, cacheDir, backupDir }。
 * 返回值：
 *   · { ok:true, launched:true, … }                已经拉起 helper，调用方可以退出了
 *   · { ok:false, unsupported:true, reason }       这台机器做不了交换 → 回落 quitAndInstall
 *   · { ok:false, error:"swap_helper_did_not_start" } helper 没起来（**不要**退出应用，留给用户重试）
 */
function createSwapRunner(deps) {
  const d = deps || {};
  return async function swapRunner(info) {
    const i = info || {};
    try {
      const pre = await swapPreflight(i);
      if (!pre.ok) {
        return {
          ok: false,
          unsupported: true,
          reason: pre.reason || "preflight_failed",
          details: pre,
        };
      }
      const launched = await launchSwapper(
        Object.assign({}, pre, {
          appPid: Number(i.appPid) || process.pid,
          runId: i.runId || "",
          waitMs: Number(i.waitMs) || SWAP_WAIT_MS,
          /* 前置闸算出来的这三样优先（normalize 过的路径），其余从 stageInfo 带过来 */
          cacheDir: pre.cacheDir || i.cacheDir || "",
          backupDir: pre.backupDir || i.backupDir || "",
          oldVersion: pre.oldVersion || i.oldVersion || i.appVersion || "",
          newVersion: pre.newVersion || i.version || "",
          appGuid: pre.appGuid || INSTALL_APP_GUID,
        }),
      );
      if (!launched.ok) {
        return { ok: false, unsupported: false, error: launched.error || "swap_launch_failed" };
      }
      const started = await waitHelperStart(
        launched.resultFile,
        launched.runId,
        Number(d.confirmMs) || SWAP_CONFIRM_MS,
      );
      if (!started) {
        /* cmd 起来了但 PowerShell 没跑起来（执行策略被组策略按住之类）：不退出应用，
           如实回执，让用户重试或走「稍后 / 退出时装」那一档 */
        return {
          ok: false,
          unsupported: false,
          error: "swap_helper_did_not_start",
          launched,
        };
      }
      return {
        ok: true,
        launched: true,
        phase: started.phase || "",
        runId: launched.runId,
        helperDir: launched.helperDir,
        resultFile: launched.resultFile,
        logFile: launched.logFile,
        result: started,
      };
    } catch (e) {
      return { ok: false, unsupported: false, error: errMsg(e) || "swap_failed" };
    }
  };
}

/* ── 主进程下次启动：收尾残留 ────────────────────────────────────────────── */

/** 列出 `<安装目录>.old-*`（交换后该被 helper 删掉、但可能删不掉的那些） */
async function listOldDirs(installDir) {
  const dir = normalizeDir(installDir);
  if (!dir) return [];
  const parent = path.dirname(dir);
  const prefix = path.basename(dir) + OLD_DIR_SUFFIX;
  let ents = [];
  try {
    ents = await fsp.readdir(parent, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  return ents
    .filter((e) => e.isDirectory() && e.name.toLowerCase().startsWith(prefix.toLowerCase()))
    .map((e) => path.join(parent, e.name));
}

/**
 * 启动时收尾上一次交换留下的东西（幂等，只动我们自己造的东西）：
 *  · swapped:true（交换成立，现在跑的就是新版本）→ 删掉 `.old-<旧版本>` 残留
 *    （helper 当时删不掉的，「残留交给下次启动清理」就是这一步）；
 *  · 顺手把差分基座的还原备份（快照目录里的 installer.exe / installer-base.json）清掉 ——
 *    交换成功以后 cacheDir 里那份就是新版本的基座，旧备份留着只会误导下一次更新；
 *  · 其它相位（waiting / wait_timeout / rename 失败 / 回滚）→ 一个目录都不动，
 *    只把结论回给调用方（旁路目录的去留由 updater 的 recoverStageState 决定）。
 */
async function recoverSwapState(opts) {
  const o = opts || {};
  const resultFile = o.resultFile || helperPaths().result;
  const j = await readSwapResult(resultFile);
  if (!j) return null;
  const out = {
    phase: j.phase || "",
    swapped: !!j.swapped,
    ok: !!j.ok,
    at: j.at || "",
    cleaned: [],
    errors: [],
    result: j,
  };
  if (!out.swapped) return out;
  const installDir = normalizeDir(j.installDir || "");
  if (installDir) {
    for (const p of await listOldDirs(installDir)) {
      try {
        await fsp.rm(p, { recursive: true, force: true });
        out.cleaned.push(p);
      } catch (e) {
        out.errors.push("old:" + p + ":" + errMsg(e));
      }
    }
  }
  const backupDir = normalizeDir(j.backupDir || o.backupDir || "");
  if (backupDir) {
    for (const n of ["installer.exe", "installer-base.json"]) {
      const f = path.join(backupDir, n);
      try {
        await fsp.unlink(f);
        out.cleaned.push(f);
      } catch (_) {}
    }
  }
  return out;
}

/* ── 主进程下次启动：独立扫掉 `.old-*` 残留（不依赖结论文件）──────────────────── */

/** helper 是不是还在飞：launching = 主进程刚拉起 / waiting = 它正等主进程退出，两个相位都还没做 rename */
function swapPhaseInFlight(phase) {
  const p = String(phase || "");
  return p === "launching" || p === "waiting";
}

/**
 * 启动时扫掉 `<安装目录>.old-*` 残留并后台删除。
 *
 * 与 recoverSwapState 的分工：那一个读 helper 的结论文件（swapped:true 才动手），管的是
 * 一条**正常走完**的交换；这一个不看结论，只扫目录 —— 主进程崩溃 / 被「结束进程」时 helper
 * 可能压根没写成结论，残留只能靠扫目录发现。
 *
 * 三道硬闸（任一不成立就一个目录都不碰）：
 *   ① 正式目录里必须有一份完整的安装（exe 在）—— 否则那对目录很可能是「正式目录刚被改名成
 *      .old、旁路还没挪进来」这个瞬间的残迹，删掉就只剩残骸；
 *   ② 交换器不在飞（launching / waiting）—— 它马上要 / 正在做 rename，这时候动目录就是抢它的活；
 *   ③ 绝不删「本进程自己正跑在里面的那一个」（按 process.execPath 的目录比）。
 * 返回 { ok, removed, skipped, errors, reason }，从不抛错。
 */
async function sweepOldDirs(opts) {
  const o = opts || {};
  const installDir = normalizeDir(o.installDir || "");
  const exeName = String(o.exeName || "MTNodeAIO.exe");
  const out = { ok: false, reason: "", removed: [], skipped: [], errors: [] };
  if (process.platform !== "win32") {
    out.reason = "platform";
    return out;
  }
  if (!installDir || !path.isAbsolute(installDir)) {
    out.reason = "no_install_dir";
    return out;
  }
  if (!(await pathExists(path.join(installDir, exeName)))) {
    out.reason = "install_dir_incomplete";
    return out;
  }
  const j = await readSwapResult(o.resultFile);
  if (j && swapPhaseInFlight(j.phase)) {
    out.reason = "swap_in_flight:" + j.phase;
    return out;
  }
  let selfDir = "";
  try {
    selfDir = normalizeDir(path.dirname(String(process.execPath || "")));
  } catch (_) {}
  out.ok = true;
  for (const p of await listOldDirs(installDir)) {
    if (selfDir && p.toLowerCase() === selfDir.toLowerCase()) {
      out.skipped.push(p);
      continue;
    }
    try {
      await fsp.rm(p, { recursive: true, force: true });
      out.removed.push(p);
    } catch (e) {
      out.errors.push(p + ":" + errMsg(e));
    }
  }
  return out;
}

module.exports = {
  HELPER_DIR_NAME,
  HELPER_SCRIPT_NAME,
  RESULT_NAME,
  LOG_NAME,
  SWAP_WAIT_MS,
  SWAP_CONFIRM_MS,
  STAGE_DIR_SUFFIX,
  OLD_DIR_SUFFIX,
  INSTALL_APP_GUID,
  helperDir,
  helperPaths,
  readSwapResult,
  swapPreflight,
  launchSwapper,
  createSwapRunner,
  recoverSwapState,
  sweepOldDirs,
  /* 纯函数件：供冒烟测试直接断言「哪些路径过不了 cmd /c」与「拉起命令长什么样」 */
  unsafeForCmd,
  normalizeDir,
  buildCommand,
};
