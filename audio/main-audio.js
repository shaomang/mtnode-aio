"use strict";
/**
 * 音频分析后端（内置 · 无插件卡 · 无权重）—— 主进程宿主
 *
 * 为画布节点「MT 音频频谱分析」（audio_spectrum）与后续剪辑链路提供**离线音乐结构分析**：
 * 拍点 / BPM / 小节 / 段落 / onset / 能量包络 → 结构化 JSON + 频谱 PNG。
 *
 * 与 Breeze / YuE2 那类插件后端不同：这里没有插件卡、没有安装窗、不需要 GPU、不下载权重。
 * 用户第一次点节点的 ▶ 时，宿主按需做四件事（全部落在数据目录，绝不写应用目录）：
 *
 *   ① 同步随包脚手架 audio-pack/app → <数据目录>/audio-analysis/app（逐文件比 mtime/大小）
 *   ② 建 venv 并装唯一依赖 numpy（国内镜像三级回退，见 cn-mirrors.js）
 *   ③ 拉起常驻分析服务 `pythonw -m app --port <p> --ffmpeg <ffmpeg 绝对路径>`
 *   ④ 把 {port,pid,startedAt} 写进 runtime.json，并按需 POST /analyze
 *
 * 纪律（与 docs/audio-analysis/service-contract.md 对齐）：
 *  · 端口不写死：8774–8783 顺延挑空闲端口，端口只经 runtime.json 与内存态下发，画布侧永远看不到；
 *  · key 由宿主生成并写 api-key.txt（服务复用它），只进 `Authorization: Bearer`，不进日志；
 *  · /health 免鉴权，探活不占服务并发；
 *  · 429 退避 5/10/20 s 最多 3 次、504 重试一次 —— 都做在这一层，画布与 Agent 只看到最终结果；
 *  · 退出（before-quit）调 /shutdown，2 s 不退就 kill，绝不留孤儿 python。
 *
 * 目录布局（<根> = <数据目录>/audio-analysis）：
 *   app/            从 audio-pack/app 同步来的分析服务（只读使用）
 *   venv/           Python 3.10–3.12 虚拟环境（只有 numpy）
 *   api-key.txt     32 hex（宿主生成，服务复用）
 *   runtime.json    {port,pid,startedAt}（宿主写）
 *   console.log     服务 stdout/stderr 环形日志
 *   cache/          <key>/analysis.json（LRU 2 GiB / 30 天，服务自己管）
 *   artifacts/      <key16>/spectrogram.png …（与 cache 同生同灭）
 */

const { app, ipcMain, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const net = require("net");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { quietPython, silentEnv, syncShims } = require("../backend-python.js");
const mirrors = require("../cn-mirrors.js");

/* ── 常量 ─────────────────────────────────────────────────────────────── */
const PORT_MIN = 8774;
const PORT_MAX = 8783;
const ANALYZE_TIMEOUT_MS = 320000; /* 服务端 300 s 硬预算 + 20 s 余量 */
const HEALTH_TIMEOUT_MS = 3000;
const READY_TIMEOUT_MS = 90000; /* 首次建 venv + 装 numpy 之后等就绪；纯起进程通常 < 3 s */
const LOG_MAX_BYTES = 512 * 1024;
const LOG_MAX_LINES = 2000;
const NUMPY_SPEC = "numpy>=1.24,<3";

/* ── 注入的宿主上下文 ─────────────────────────────────────────────────── */
let getDataDir = () => "";
let getMainWin = () => null;
let appRoot = path.join(__dirname, "..");

/* ── 运行时状态 ───────────────────────────────────────────────────────── */
let proc = null; /* 分析服务子进程 */
let readyInfo = null; /* { port, pid, startedAt, baseUrl } */
let starting = null; /* Promise（并发调用只走同一次准备） */
let progress = { phase: "idle", pct: 0, label: "", error: "" };
let lastError = "";

function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch {}
  return p;
}

/* ── 路径 ─────────────────────────────────────────────────────────────── */
function root() {
  const base = (typeof getDataDir === "function" && getDataDir()) || app.getPath("userData");
  return ensureDir(path.join(base, "audio-analysis"));
}
function paths() {
  const r = root();
  return {
    root: r,
    app: path.join(r, "app"),
    venv: path.join(r, "venv"),
    python: path.join(r, "venv", "Scripts", "python.exe"),
    pythonw: path.join(r, "venv", "Scripts", "pythonw.exe"),
    key: path.join(r, "api-key.txt"),
    runtime: path.join(r, "runtime.json"),
    cache: path.join(r, "cache"),
    artifacts: path.join(r, "artifacts"),
    log: path.join(r, "console.log"),
  };
}
/** 随包脚手架目录：开发态在仓库里，打包态在 resources/audio-pack。 */
function packDir() {
  if (app.isPackaged) {
    const packed = path.join(process.resourcesPath, "audio-pack");
    if (fs.existsSync(path.join(packed, "app"))) return packed;
  }
  return path.join(appRoot, "audio-pack");
}

/* ── 日志（环形）─────────────────────────────────────────────────────── */
function logLine(s) {
  const line = "[" + new Date().toISOString() + "] " + String(s || "");
  try {
    fs.appendFileSync(paths().log, line + "\n");
    /* 环形：超过上限就按行裁剪（分析服务每个请求一行，长跑一天也才几百行） */
    const st = fs.statSync(paths().log);
    if (st.size > LOG_MAX_BYTES) {
      const txt = fs.readFileSync(paths().log, "utf8").split(/\r?\n/);
      fs.writeFileSync(paths().log, txt.slice(-LOG_MAX_LINES).join("\n") + "\n");
    }
  } catch {}
}
function consoleTail(n) {
  try {
    const txt = fs.readFileSync(paths().log, "utf8");
    return txt.split(/\r?\n/).slice(-Math.max(20, Number(n) || 200)).join("\n");
  } catch {
    return "";
  }
}

/* ── 进度（首次准备：同步 / venv / deps / start）──────────────────────── */
function emitProgress(patch) {
  progress = Object.assign({}, progress, patch || {});
  try {
    const win = getMainWin && getMainWin();
    if (win && !win.isDestroyed()) win.webContents.send("audio:progress", progress);
  } catch {}
}

/* ── 脚手架同步（逐文件比 mtime + 大小：热修改动下次启动自动生效）────── */
function copyTreeIfNewer(src, dst) {
  let copied = 0;
  const walk = (s, d) => {
    ensureDir(d);
    for (const ent of fs.readdirSync(s, { withFileTypes: true })) {
      if (ent.name === "__pycache__" || ent.name.endsWith(".pyc")) continue;
      const sp = path.join(s, ent.name);
      const dp = path.join(d, ent.name);
      if (ent.isDirectory()) {
        walk(sp, dp);
        continue;
      }
      try {
        const ss = fs.statSync(sp);
        let need = true;
        try {
          const ds = fs.statSync(dp);
          need = ds.size !== ss.size || Math.abs(ds.mtimeMs - ss.mtimeMs) > 1000;
        } catch {
          need = true;
        }
        if (!need) continue;
        fs.copyFileSync(sp, dp);
        try {
          fs.utimesSync(dp, ss.atime, ss.mtime);
        } catch {}
        copied++;
      } catch (e) {
        logLine("同步文件失败 " + sp + "：" + ((e && e.message) || e));
      }
    }
  };
  walk(src, dst);
  return copied;
}
function syncScaffold() {
  const src = path.join(packDir(), "app");
  if (!fs.existsSync(path.join(src, "__main__.py"))) {
    throw new Error("随包脚手架缺失：找不到 audio-pack/app/__main__.py（重装应用可修复）");
  }
  const dst = paths().app;
  const copied = copyTreeIfNewer(src, dst);
  /* 静默垫片：起进程前的 PYTHONPATH 里挂 shims/sitecustomize.py（见 backend-python.js） */
  syncShims(packDir(), paths().root);
  if (copied) logLine("已同步脚手架 " + copied + " 个文件 → " + dst);
  return { ok: true, copied };
}

/* ── 解释器 / venv / 依赖 ─────────────────────────────────────────────── */
function execCapture(cmd, args, opts) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let child = null;
    try {
      child = spawn(cmd, args, Object.assign({ windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }, opts || {}));
    } catch (e) {
      resolve({ code: -1, stdout: "", stderr: String((e && e.message) || e) });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
    }, Math.min(Math.max(Number((opts && opts.timeoutMs) || 60000), 5000), 900000));
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: out, stderr: String((e && e.message) || e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err });
    });
  });
}
/** 找一个 ≥3.10 的基座解释器（返回可直接用作 argv[0] 的命令）*/
async function basePython() {
  const cands = [["python"], ["python3"], ["py", "-3.12"], ["py", "-3.11"], ["py", "-3.10"], ["py"]];
  for (const c of cands) {
    const r = await execCapture(c[0], c.slice(1).concat(["-c", "import sys;print('%d.%d' % sys.version_info[:2])"]), {
      timeoutMs: 12000,
    });
    if (r.code !== 0) continue;
    const m = /^(\d+)\.(\d+)/.exec(String(r.stdout || "").trim());
    if (!m) continue;
    const major = Number(m[1]);
    const minor = Number(m[2]);
    if (major !== 3 || minor < 10) continue;
    return c;
  }
  return null;
}
async function ensureVenv() {
  const p = paths();
  if (fs.existsSync(p.python)) return { ok: true, reused: true };
  emitProgress({ phase: "venv", pct: 8, label: "创建 Python 虚拟环境" });
  const py = await basePython();
  if (!py) {
    throw new Error(
      "本机没有可用的 Python（需要 3.10–3.12）：请先安装 Python 后重试。音频分析后端只依赖 numpy，装好 Python 即可自动准备。",
    );
  }
  const r = await execCapture(py[0], py.slice(1).concat(["-m", "venv", p.venv]), {
    env: silentEnv(p.root),
    timeoutMs: 180000,
  });
  if (r.code !== 0 || !fs.existsSync(p.python)) {
    throw new Error("创建 venv 失败（" + py.join(" ") + "）：" + String(r.stderr || "").slice(-400));
  }
  logLine("venv 已创建：" + p.venv);
  return { ok: true, created: true };
}
async function numpyInstalled() {
  const p = paths();
  const r = await execCapture(p.python, ["-c", "import numpy;print(numpy.__version__)"], { timeoutMs: 30000 });
  return r.code === 0 ? String(r.stdout || "").trim() : "";
}
async function ensureDeps() {
  const p = paths();
  const have = await numpyInstalled();
  if (have) return { ok: true, numpy: have };
  emitProgress({ phase: "deps", pct: 16, label: "安装依赖（numpy）" });
  const env = mirrors.installEnv ? mirrors.installEnv() : process.env;
  /* 三级镜像回退由 cn-mirrors 的 installEnv 提供（index-url 已指向可用镜像） */
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await execCapture(
      p.python,
      ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--upgrade", NUMPY_SPEC],
      { env: Object.assign({}, env, { PIP_DISABLE_PIP_VERSION_CHECK: "1" }), timeoutMs: 600000 },
    );
    if (r.code === 0) {
      const v = await numpyInstalled();
      if (v) {
        logLine("numpy 就绪：" + v);
        return { ok: true, numpy: v };
      }
    }
    last = String(r.stderr || r.stdout || "").slice(-600);
    /* 第一次失败：清镜像换官方源再试（cn-mirrors 的 installEnv 已按顺序给镜像，这里兜一次官方） */
    if (attempt === 0) logLine("pip 安装 numpy 失败，改用官方源重试：" + last.slice(0, 300));
    env.PIP_INDEX_URL = "https://pypi.org/simple";
  }
  throw new Error("安装 numpy 失败（这是音频分析唯一的依赖）：" + last);
}

/* ── key ─────────────────────────────────────────────────────────────── */
function ensureKey() {
  const p = paths();
  try {
    const cur = fs.readFileSync(p.key, "utf8").trim();
    if (/^[0-9a-f]{32}$/i.test(cur)) return cur;
  } catch {}
  const key = crypto.randomBytes(16).toString("hex");
  try {
    fs.writeFileSync(p.key, key + "\n", { encoding: "utf8", mode: 0o600 });
  } catch (e) {
    logLine("写 api-key.txt 失败：" + ((e && e.message) || e));
  }
  return key;
}

/* ── 端口 ─────────────────────────────────────────────────────────────── */
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    try {
      srv.listen(port, "127.0.0.1");
    } catch {
      resolve(false);
    }
  });
}
async function pickPort() {
  for (let port = PORT_MIN; port <= PORT_MAX; port++) {
    if (await portFree(port)) return port;
  }
  throw new Error("端口 " + PORT_MIN + "–" + PORT_MAX + " 全被占用：请关掉占用该段的程序后重试");
}

/* ── HTTP ─────────────────────────────────────────────────────────────── */
function requestJson(method, urlPath, body, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    let payload = null;
    try {
      payload = body == null ? null : Buffer.from(JSON.stringify(body), "utf8");
    } catch (e) {
      resolve({ ok: false, status: 0, error: String((e && e.message) || e) });
      return;
    }
    const headers = { Accept: "application/json" };
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(payload.length);
    }
    if (o.key) headers["Authorization"] = "Bearer " + o.key;
    const req = http.request(
      {
        host: "127.0.0.1",
        port: o.port,
        path: urlPath,
        method,
        headers,
        timeout: Number(o.timeoutMs) || HEALTH_TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text, json });
        });
      },
    );
    req.on("timeout", () => {
      try {
        req.destroy(new Error("timeout"));
      } catch {}
    });
    req.on("error", (e) => resolve({ ok: false, status: 0, error: String((e && e.message) || e) }));
    if (payload) req.write(payload);
    req.end();
  });
}
async function health(runtime) {
  const info = runtime || readyInfo;
  if (!info) return null;
  const r = await requestJson("GET", "/health", null, { port: info.port, timeoutMs: HEALTH_TIMEOUT_MS });
  return r.ok && r.json ? r.json : null;
}

/* ── 起停 ─────────────────────────────────────────────────────────────── */
function resolveFfmpeg() {
  try {
    const m = require("../media-subtitle.js");
    if (m && typeof m.resolveFfmpeg === "function") {
      const r = m.resolveFfmpeg(getDataDir());
      if (r && r.ffmpeg && fs.existsSync(r.ffmpeg)) return r.ffmpeg;
    }
  } catch (e) {
    logLine("解析 ffmpeg 失败：" + ((e && e.message) || e));
  }
  return "";
}
function writeRuntime(info) {
  try {
    fs.writeFileSync(
      paths().runtime,
      JSON.stringify({ port: info.port, pid: info.pid, startedAt: info.startedAt }, null, 2),
      "utf8",
    );
  } catch (e) {
    logLine("写 runtime.json 失败：" + ((e && e.message) || e));
  }
}
function spawnBackend(port, ffmpeg) {
  const p = paths();
  const py = quietPython(fs.existsSync(p.pythonw) ? p.pythonw : p.python);
  const args = ["-m", "app", "--port", String(port)];
  if (ffmpeg) args.push("--ffmpeg", ffmpeg);
  const child = spawn(py, args, {
    cwd: p.root, /* 契约：cwd = <数据目录>/audio-analysis，`-m app` 靠它找到 app 包 */
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: silentEnv(p.root),
  });
  proc = child;
  const startedAt = new Date().toISOString();
  logLine("start pid=" + child.pid + " port=" + port + " ffmpeg=" + (ffmpeg || "(PATH)"));
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) logLine("svc: " + line.slice(0, 1200));
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => logLine("svc-err: " + String(d).trim().slice(0, 2000)));
  const done = new Promise((resolve) => {
    child.on("error", (e) => {
      logLine("spawn 失败：" + ((e && e.message) || e));
      if (proc === child) proc = null;
      resolve({ ok: false, error: String((e && e.message) || e) });
    });
    child.on("exit", (code) => {
      logLine("exit code=" + code);
      if (proc === child) proc = null;
      readyInfo = null;
      resolve({ ok: false, error: "分析服务已退出（code=" + code + "），详见 console.log" });
    });
  });
  const ready = new Promise((resolve) => {
    const t0 = Date.now();
    const tick = async () => {
      if (proc !== child) return resolve({ ok: false, error: lastError || "分析服务已退出" });
      const info = { port, pid: child.pid, startedAt };
      const h = await health(info);
      if (h && h.ok) return resolve({ ok: true, info, health: h });
      if (Date.now() - t0 > READY_TIMEOUT_MS)
        return resolve({ ok: false, error: "分析服务启动超时（" + READY_TIMEOUT_MS / 1000 + " s），详见 console.log" });
      setTimeout(tick, 400);
    };
    tick();
  });
  return Promise.race([ready, done]);
}

/** 确保后端可用：同步脚手架 → venv → numpy → 起进程 → 探活。并发调用共用同一趟。 */
function ensureBackend() {
  if (readyInfo) return Promise.resolve({ ok: true, info: readyInfo });
  if (starting) return starting;
  starting = (async () => {
    try {
      emitProgress({ phase: "sync", pct: 2, label: "同步分析服务", error: "" });
      syncScaffold();
      await ensureVenv();
      await ensureDeps();
      emitProgress({ phase: "start", pct: 40, label: "启动分析服务" });
      const port = await pickPort();
      const ffmpeg = resolveFfmpeg();
      if (!ffmpeg) logLine("未解析到 ffmpeg：服务照起，但 /analyze 会一律 E_INTERNAL（去插件里装 Remotion 可修）");
      const r = await spawnBackend(port, ffmpeg);
      if (!r.ok) {
        lastError = r.error || "分析服务起不来";
        emitProgress({ phase: "error", label: lastError, error: lastError });
        return { ok: false, error: lastError };
      }
      readyInfo = r.info;
      writeRuntime(r.info);
      emitProgress({ phase: "ready", pct: 100, label: "分析服务就绪（端口 " + port + "）" });
      logLine("ready port=" + port + " pid=" + r.info.pid);
      return { ok: true, info: readyInfo, health: r.health };
    } catch (e) {
      lastError = String((e && e.message) || e);
      logLine("准备失败：" + lastError);
      emitProgress({ phase: "error", label: lastError, error: lastError });
      return { ok: false, error: lastError };
    } finally {
      starting = null;
    }
  })();
  return starting;
}

/* ── /analyze ─────────────────────────────────────────────────────────── */
function errOut(code, message, detail) {
  return { ok: false, error: { code: String(code || "E_INTERNAL"), message: String(message || "分析失败"), detail: detail || "" } };
}
function normalizePath(raw) {
  let s = String(raw == null ? "" : raw).trim();
  if (!s) return "";
  if (/^file:\/\//i.test(s)) {
    s = s.replace(/^file:\/\//i, "");
    /* file:///C:/x → C:/x；共享路径 file://server/share → //server/share */
    if (/^\/[a-zA-Z]:/.test(s)) s = s.slice(1);
    try {
      s = decodeURIComponent(s);
    } catch {}
  }
  if (s.indexOf('"') === 0 && s.lastIndexOf('"') === s.length - 1) s = s.slice(1, -1);
  return s.trim();
}
const CODE_TEXT = {
  E_INPUT_MISSING: "没有可分析的音频 / 视频：请从端口 0 接入一个本机文件",
  E_TOO_LONG: "素材太长：单次分析上限 2 小时 / 2 GiB（不做截断，请先切一段再分析）",
  E_UNSUPPORTED_FORMAT: "这个文件解不出音轨（格式不支持）：请先转成 mp3 / wav / m4a / mp4 再试",
  E_NO_AUDIO_STREAM: "这个文件里没有音频流（纯视频轨道 / 纯图片）：换一个带声音的文件",
  E_DECODE_FAILED: "解码失败：ffmpeg 读不了这个文件（可能已损坏或编码特殊）",
  E_BUSY: "分析服务正忙（同一时刻只跑一份）：稍等几秒再点 ▶",
  E_TIMEOUT: "分析超时（服务端 300 s 预算）：素材可能过长，或换一段更短的试试",
  E_INTERNAL: "分析服务内部错误",
  E_UNAUTHORIZED: "分析服务鉴权失败（api-key.txt 被改过？删掉它再重试会自动重建）",
  E_BACKEND_DOWN: "音频分析后端没起来",
};

async function analyzeWithRetry(payload) {
  const key = ensureKey();
  const tries = [0, 5000, 10000, 20000]; /* 429：立即 → 5 s → 10 s → 20 s（最多 3 次退避） */
  let last = null;
  for (let attempt = 0; attempt < tries.length; attempt++) {
    if (tries[attempt]) await new Promise((r) => setTimeout(r, tries[attempt]));
    const r = await requestJson("POST", "/analyze", payload, {
      port: readyInfo.port,
      key,
      timeoutMs: ANALYZE_TIMEOUT_MS,
    });
    last = r;
    if (r.status === 429) {
      logLine("服务忙（429），第 " + (attempt + 1) + " 次退避后重试");
      continue;
    }
    if (r.status === 504) {
      /* 504 重试一次（服务端仍在后台跑完并写缓存，重试多半直接命中） */
      const r2 = await requestJson("POST", "/analyze", payload, {
        port: readyInfo.port,
        key,
        timeoutMs: ANALYZE_TIMEOUT_MS,
      });
      return r2;
    }
    return r;
  }
  return last || { ok: false, status: 0, error: "no response" };
}

async function analyze(raw) {
  const audioPath = normalizePath(raw && (raw.audioPath || raw.path));
  if (!audioPath) return errOut("E_INPUT_MISSING", CODE_TEXT.E_INPUT_MISSING, "audioPath 为空");
  if (!path.isAbsolute(audioPath))
    return errOut("E_INPUT_MISSING", CODE_TEXT.E_INPUT_MISSING, "不是绝对路径：" + audioPath.slice(0, 260));
  let st = null;
  try {
    st = fs.statSync(audioPath);
  } catch {
    st = null;
  }
  if (!st || !st.isFile())
    return errOut("E_INPUT_MISSING", CODE_TEXT.E_INPUT_MISSING, "文件不存在：" + audioPath.slice(0, 260));

  const up = await ensureBackend();
  if (!up.ok)
    return errOut("E_BACKEND_DOWN", CODE_TEXT.E_BACKEND_DOWN, String(up.error || "").slice(0, 800));

  let options = raw && raw.options;
  if (typeof options === "string") {
    try {
      options = JSON.parse(options);
    } catch {
      options = null;
    }
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) options = {};

  const r = await analyzeWithRetry({ audioPath, options });
  if (r && r.json) {
    if (r.json.ok === false) {
      const e = r.json.error || {};
      const code = String(e.code || "E_INTERNAL");
      return errOut(code, e.message || CODE_TEXT[code] || CODE_TEXT.E_INTERNAL, e.detail || "");
    }
    return {
      ok: true,
      body: r.json,
      status: r.status,
      baseUrl: "http://127.0.0.1:" + readyInfo.port,
      /* 完整明细（逐拍 / 逐事件 / rms 数组）在缓存里的那份 analysis.json：
         摘要里只用得到它的路径 —— 要让 Agent 读明细就打开这个文件。 */
      fullJsonPath: (() => {
        try {
          const key = (r.json.diagnostics && r.json.diagnostics.cache && r.json.diagnostics.cache.key) || "";
          if (!key) return "";
          const p = path.join(paths().cache, String(key), "analysis.json");
          return fs.existsSync(p) ? p : "";
        } catch {
          return "";
        }
      })(),
      key: "", /* 永不外泄 */
    };
  }
  const detail = String((r && (r.error || r.text)) || "").slice(0, 800);
  return errOut("E_INTERNAL", CODE_TEXT.E_INTERNAL, detail);
}

/* ── 状态 ─────────────────────────────────────────────────────────────── */
function state() {
  const p = paths();
  return {
    ok: true,
    ready: !!readyInfo,
    running: !!(proc && !proc.killed),
    starting: !!starting,
    port: readyInfo ? readyInfo.port : 0,
    pid: readyInfo ? readyInfo.pid : 0,
    progress,
    lastError,
    installed: fs.existsSync(path.join(p.app, "__main__.py")) && fs.existsSync(p.python),
    paths: { root: p.root, log: p.log, cache: p.cache, artifacts: p.artifacts },
  };
}

/* ── 退出收尾 ─────────────────────────────────────────────────────────── */
async function shutdownAudio() {
  const child = proc;
  proc = null;
  readyInfo = null;
  if (!child) return;
  try {
    const key = ensureKey();
    const port = (() => {
      try {
        return JSON.parse(fs.readFileSync(paths().runtime, "utf8")).port;
      } catch {
        return 0;
      }
    })();
    if (port) await requestJson("POST", "/shutdown", null, { port, key, timeoutMs: 3000 });
  } catch {}
  setTimeout(() => {
    try {
      if (child && !child.killed) child.kill();
    } catch {}
  }, 2000);
}

/* ── IPC ──────────────────────────────────────────────────────────────── */
function registerAudioIpc(opts) {
  if (registerAudioIpc._done) return { ok: true, already: true };
  registerAudioIpc._done = true;
  const o = opts || {};
  getDataDir = typeof o.getDataDir === "function" ? o.getDataDir : () => "";
  getMainWin = typeof o.getMainWin === "function" ? o.getMainWin : () => null;
  appRoot = o.appRoot || path.join(__dirname, "..");

  ipcMain.handle("audio:state", async () => {
    const s = state();
    const h = await health();
    return Object.assign({}, s, { health: h || null });
  });
  ipcMain.handle("audio:ensure", async () => {
    const r = await ensureBackend();
    const h = await health();
    return Object.assign({ ok: !!r.ok, error: r.ok ? "" : r.error }, state(), { health: h || null });
  });
  ipcMain.handle("audio:analyze", async (e, payload) => analyze(payload || {}));
  ipcMain.handle("audio:log", async (e, n) => ({ ok: true, text: consoleTail(n) }));
  ipcMain.handle("audio:openRoot", async () => {
    try {
      await shell.openPath(paths().root);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
  /* 启动时清掉上次残留的 runtime.json：端口是每一趟重新挑的，旧文件只会误导排查 */
  try {
    fs.unlinkSync(paths().runtime);
  } catch {}
  return { ok: true };
}

module.exports = { registerAudioIpc, shutdownAudio, state, analyze, ensureBackend, CODE_TEXT };
