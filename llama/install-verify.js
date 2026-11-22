"use strict";
/**
 * llama.cpp 插件 —— 安装结果自查（「安装需要自行验证安装成功」）。
 *
 * 为什么要单独一份、单独可测：脚本 exit 0、Agent 写 ok=true、`.install-ok` 存在，
 * 这些都只是**声明**。实测踩过：脚本报成功、标记也写了，`bin\` 里却没有
 * `llama-server.exe`，用户点启动才收到「后端尚未安装」。所以收尾必须真跑一遍。
 *
 * 这里只做纯检查（不联网、不起服务、不改业务数据）：
 *   · venv 解释器在不在，且真能 `import fastapi; from app import server`；
 *   · `bin\llama-server.exe` 在位且不是半截（体积判据见 MIN_SERVER_BYTES / SERVER_IMPL_DLL 处的说明）；
 *   · `models\` 与 `.api-key` 齐不齐（缺的就地补：插件登记模型、离线回退 key 都要它们）。
 * 任何一项不过 → ok:false + problems，由宿主按失败收口，绝不写 installedMeta。
 *
 * 依赖注入：log(line) 由宿主给（主进程是 appendConsole），测试里给个收集器即可。
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const IMPORT_TIMEOUT_MS = 180000;
const MIN_SERVER_BYTES = 1024 * 1024;
/* 二进制认两种布局：b10566 起 llama.cpp 的 Windows 包改成「薄启动器 + impl dll」——
   bin\llama-server.exe 只有 9 KB，真正的推理代码在 bin\llama-server-impl.dll（实测 9.9 MB）。
   只看 exe > 1MB 会把**真装好**的目录判成「只有半截」（本机实测踩中：exe --version 正常返回
   build 10566，安装窗却报 install_verify_failed）。半截包的特征是两块都不完整（下载被掐断时
   exe 与 impl.dll 都写不满），所以：exe 够大，或 exe 在位且同目录 impl dll 够大，才算完整。 */
const SERVER_IMPL_DLL = "llama-server-impl.dll";
const VERIFY_MARK = "mtnode-verify-ok";

/** 与管理服务同一格式（app/server.py: `"llama-" + secrets.token_urlsafe(24)`），别另造一套。 */
function genApiKey() {
  return "llama-" + require("crypto").randomBytes(24).toString("base64url");
}

function fileSizeOf(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

/** 真跑一次 venv 里的 import（超时保护：拉不起来的解释器不能把安装链挂死）。 */
function verifyPythonImport(installDir, py, opts) {
  const o = opts || {};
  const waitMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : IMPORT_TIMEOUT_MS;
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    let timer = null;
    const finish = (v) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(v);
    };
    let child;
    try {
      child = spawn(py, ["-c", "import fastapi; from app import server; print('" + VERIFY_MARK + "')"], {
        cwd: installDir,
        windowsHide: true,
        env: Object.assign({}, process.env, { PYTHONIOENCODING: "utf-8" }),
      });
    } catch (e) {
      return resolve({ ok: false, detail: "起不来 python：" + String((e && e.message) || e) });
    }
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish({ ok: false, detail: "import 超时（" + Math.round(waitMs / 1000) + " 秒没返回）" });
    }, waitMs);
    if (timer.unref) timer.unref();
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.stderr.on("data", (d) => {
      out += d.toString();
    });
    child.on("error", (e) => finish({ ok: false, detail: "起不来 python：" + String((e && e.message) || e) }));
    child.on("close", (code) => {
      const text = out.trim();
      if (code === 0 && text.indexOf(VERIFY_MARK) >= 0) return finish({ ok: true, detail: "" });
      finish({ ok: false, detail: "import 失败（exit " + code + "）：" + (text.slice(-400) || "无输出") });
    });
  });
}

/**
 * 安装自查。
 * @param {string} installDir 安装目录
 * @param {{log?: (line: string) => void, pythonPath?: string}} [opts]
 * @returns {Promise<{ok:boolean, checks:Array, problems:Array}>}
 */
async function verifyInstalled(installDir, opts) {
  const o = opts || {};
  const log = typeof o.log === "function" ? o.log : () => {};
  const root = String(installDir || "").trim();
  const checks = [];
  const add = (id, label, ok, detail) => {
    checks.push({ id, label, ok: !!ok, detail: detail || "" });
    return !!ok;
  };
  const py = o.pythonPath || path.join(root, ".venv", "Scripts", "python.exe");
  const server = path.join(root, "bin", "llama-server.exe");
  const modelsDir = path.join(root, "models");
  const keyFile = path.join(root, ".api-key");
  const hasServerPy = !!root && fs.existsSync(path.join(root, "app", "server.py"));
  /* 显式给了解释器（宿主编排 / 单测）时，它的「在不在」由下面真跑那一步证明：
     那边给的可能是 PATH 里的 "python" 这种命令名，stat 它没有意义。 */
  const pyPresent = o.pythonPath ? true : fs.existsSync(py);

  add("dir", "安装目录存在", !!root && fs.existsSync(root), root || "(未配置)");
  add("scaffold", "管理服务代码 app\\server.py", hasServerPy);
  add("install_ok", ".install-ok 标记", !!root && fs.existsSync(path.join(root, ".install-ok")));
  add("venv", ".venv 里的 python.exe", pyPresent, py);

  /* 只看在不在不够：下载被掐断的半截 exe 也在，只是跑不起来。体积判据覆盖两种发布布局
     （单文件 exe / 薄启动器 + impl dll），见 SERVER_IMPL_DLL 处「为什么」。 */
  const serverBytes = fileSizeOf(server);
  const implBytes = fileSizeOf(path.join(root, "bin", SERVER_IMPL_DLL));
  const serverOk = serverBytes > MIN_SERVER_BYTES || (serverBytes > 0 && implBytes > MIN_SERVER_BYTES);
  const serverDetail = !serverBytes
    ? "缺失"
    : serverBytes > MIN_SERVER_BYTES
      ? Math.round(serverBytes / (1024 * 1024)) + " MB"
      : serverOk
        ? "启动器 " + Math.round(serverBytes / 1024) + " KB + " + SERVER_IMPL_DLL + " " + Math.round(implBytes / (1024 * 1024)) + " MB"
        : "只有半截（" + Math.round(serverBytes / 1024) + " KB）";
  add("server", "bin\\llama-server.exe（完整，含 impl dll 布局）", serverOk, serverDetail);

  if (pyPresent && hasServerPy) {
    const r = await verifyPythonImport(root, py, { timeoutMs: o.importTimeoutMs });
    add("import", "venv 内 import fastapi + app.server", r.ok, r.detail);
  } else {
    add("import", "venv 内 import fastapi + app.server", false, "前置文件缺失，没跑");
  }

  let modelsOk = false;
  try {
    fs.mkdirSync(modelsDir, { recursive: true });
    modelsOk = fs.existsSync(modelsDir);
  } catch {}
  add("models", "models\\ 模型目录", modelsOk, modelsDir);

  let keyOk = false;
  try {
    let key = "";
    try {
      key = fs.readFileSync(keyFile, "utf8").trim();
    } catch {}
    if (!key) {
      fs.writeFileSync(keyFile, genApiKey(), "utf8");
      log("[verify] .api-key 缺失，已按管理服务同一格式补写");
      key = fs.readFileSync(keyFile, "utf8").trim();
    }
    keyOk = !!key;
  } catch {}
  add("api_key", ".api-key", keyOk, keyFile);

  for (const c of checks) {
    log("[verify] " + (c.ok ? "OK   " : "FAIL ") + c.label + (c.detail ? " · " + c.detail : ""));
  }
  const problems = checks.filter((c) => !c.ok);
  return { ok: problems.length === 0, checks, problems };
}

/** 自查失败 → 一句话原因（失败卡片与日志共用同一份措辞）。 */
function verifyFailureMessage(verify) {
  const v = verify || {};
  const why = (v.problems || [])
    .map((p) => p.label + (p.detail ? "（" + p.detail + "）" : ""))
    .join("；");
  /* 措辞会进安装窗的失败卡片：再长就切掉尾（每一项的完整结果仍在步骤日志里）。 */
  const body = why || "未知原因";
  return "install_verify_failed: 安装收尾自查没通过 —— " + (body.length > 600 ? body.slice(0, 600) + "…" : body);
}

module.exports = { verifyInstalled, verifyPythonImport, verifyFailureMessage, genApiKey, VERIFY_MARK };
