"use strict";
/**
 * 安装步骤上报器（宿主侧）：把一个安装子进程的 stdout/stderr 变成「步骤事件 + 日志」两条流。
 *
 * 为什么存在：8 个插件宿主各自 spawn 自己的 install 脚本，但「哪一行是步骤、哪一行是日志、
 * 当前跑到哪一步、失败停在哪一步」这套判断只能有一份实现 —— 否则安装窗在 8 个插件上
 * 会表现出 8 种脾气。宿主只做：spawn（带 stdio）→ 每行交给本模块 → 事件交给
 * plugins/main-install.js 的广播口。
 *
 * 协议真源是 `pack-steps/step.ps1`（脚本侧）与 `plugins/install-steps.js`（解析与状态机）。
 *
 * 用法（宿主侧）：
 *   const stepReporter = require("../plugins/install-step-reporter.js");
 *   const rep = stepReporter.attach({ pluginId: "llama-local", child, onEvent: (ev) => installHost.emit(ev) });
 *   ... 子进程结束后 ...
 *   rep.finish({ ok: true });            // 或 { ok:false, error:"低磁盘", hint:"建议…" }
 *   rep.log("自己打的一行");              // 宿主自己的日志（appendConsole 那类）也进当前步
 */
const steps = require("./install-steps.js");

/**
 * 给一个子进程挂上报器。
 * opts: { pluginId, child, onEvent(ev), stepId?（宿主手工指认当前步骤，如「Agent 安装」） }
 * onEvent 收到的两类事件：
 *   { kind:"step", pluginId, step, stepIndex }
 *   { kind:"log",  pluginId, stepId, line, stream:"out"|"err"|"host" }
 * 本模块**永不抛异常**：上报只是一层旁路，绝不能让安装链因为解析出错而失败。
 */
function attach(opts) {
  const o = opts || {};
  const pluginId = String(o.pluginId || "");
  const child = o.child || null;
  const onEvent = typeof o.onEvent === "function" ? o.onEvent : () => {};
  /** 宿主显式指认的步骤（脚本没打步骤行时，日志归到它名下；如 h3/music3 的 Agent 安装） */
  let forcedStep = String(o.stepId || "");
  let closed = false;

  const currentId = () => forcedStep || "_";

  function emit(ev) {
    try {
      onEvent(Object.assign({ pluginId }, ev));
    } catch {}
  }

  /** 处理一行输出：步骤行 → step 事件；其它 → log 事件（归到当前步骤） */
  function feed(line, stream) {
    if (closed) return;
    const raw = String(line == null ? "" : line).replace(/\r$/, "");
    if (!raw.trim()) return;
    const parsed = steps.parseStepLine(raw);
    if (parsed && parsed.step) {
      if (parsed.step.status === "run") forcedStep = parsed.step.id;
      emit({ kind: "step", step: parsed.step });
      return;
    }
    emit({ kind: "log", stepId: forcedStep || "_", line: raw, stream: stream || "out" });
  }

  /** 宿主自己的日志行（也进当前步的日志；安装窗「日志」区一视同仁） */
  function log(line) {
    if (closed) return;
    const raw = String(line == null ? "" : line);
    if (!raw.trim()) return;
    emit({ kind: "log", stepId: currentId(), line: raw, stream: "host" });
  }

  /** 手工切当前步骤（Agent 安装这类没有脚本步骤行的路径用它） */
  function setStep(id) {
    forcedStep = String(id || "");
    return forcedStep;
  }

  /** 每路流各留半行：一块数据正好切在一行中间时，等下一块补齐再发（否则安装窗会多出残行）。 */
  const pending = { out: "", err: "" };
  const PENDING_MAX = 16384;

  /** 把缓冲里剩下的那半行也发出去（进程退出 / 收尾时），别把最后一行丢掉。 */
  function flush(stream) {
    const keys = stream ? [stream] : ["out", "err"];
    for (const k of keys) {
      const rest = pending[k];
      pending[k] = "";
      if (rest && rest.trim()) feed(rest, k);
    }
  }

  if (child) {
    const read = (stream) => (d) => {
      /* \r\n / \n / 单个 \r 都算换行：curl / pip 的进度行只回 \r。 */
      let buf = pending[stream] + String(d == null ? "" : d);
      const parts = buf.split(/\r\n|\n|\r/);
      pending[stream] = parts.pop();
      for (const line of parts) feed(line, stream);
      /* 防御：一行超长又不带换行（进度条刷屏）时先吐出来，别把后面的输出一直憋在缓冲里。 */
      if (pending[stream].length > PENDING_MAX) {
        feed(pending[stream], stream);
        pending[stream] = "";
      }
    };
    try {
      if (child.stdout && child.stdout.on) child.stdout.on("data", read("out"));
      if (child.stderr && child.stderr.on) child.stderr.on("data", read("err"));
      /* 进程结束（close / exit）与流结束（end）都兜一下：最后一行没有换行也不会丢 */
      if (typeof child.on === "function") child.on("close", () => flush());
      if (child.stdout && child.stdout.on) child.stdout.on("end", () => flush("out"));
      if (child.stderr && child.stderr.on) child.stderr.on("end", () => flush("err"));
    } catch {}
  }

  function finish(outcome) {
    if (closed) return;
    flush();
    closed = true;
    const o2 = outcome || {};
    emit({
      kind: "finish",
      ok: !!o2.ok,
      error: String(o2.error || ""),
      hint: String(o2.hint || ""),
      cancelled: !!o2.cancelled,
    });
  }

  return { feed, log, setStep, finish, isClosed: () => closed };
}

/**
 * 「脚本失败 → 建议修复」文案：安装窗失败步下面那一句。
 * 只按**能自己认出来的错误码 / 关键字**给建议，认不出就如实说「看日志 / 交给会话」，
 * 绝不编造根因（错误码真源在各宿主与 plugin-error-repair.js，这里只补安装场景的说法）。
 */
const HINTS = [
  [
    /install_verify_failed|verify_failed/i,
    "安装脚本报了成功，但收尾自查没通过（日志里带 FAIL 的那几行就是原因：缺 llama-server.exe / venv 里 import 不了 / 没有 API Key）。" +
      "这不代表装好了：按 FAIL 那一项重跑安装；反复不过就点「交给 mtnode 会话修复」，由 Agent 按该插件的安装技能补齐缺的那一块。",
  ],
  [
    /下载.{0,12}(卡住|很慢|太慢|超时|断了|中断|没有输出)|下载源不响应|download.{0,16}(stuck|slow|timeout)|downloaded archive|bin\\\.download|curl exit/i,
    "下载卡住 / 很慢（镜像不响应、连接断了或速度只有几十 KB/s）：重跑安装就会接着已经下好的部分继续（分块断点续传，已下的块留在安装目录的 .download\\ 里），" +
      "不会从头再来，所以不必删 bin\\（除非日志明说存下来的不是 zip：那才是代理错误页被当成了压缩包，需要清掉 .download\\ 后重跑）。" +
      "重跑还是卡在同一处，就点「让 Agent 兜底修复 / 交给 mtnode 会话修复」。",
  ],
  [
    /install_stalled|没有任何输出|卡住/i,
    "安装脚本这次是彻底失效（长时间没有任何输出、已被宿主强杀），不是哪一步的报错现场：直接重试大概率还卡在同一处。" +
      "请点「让 Agent 兜底修复 / 交给 mtnode 会话修复」，由 Agent 按该插件的安装技能接手（换下载源、必要时手工放二进制、修 venv）。",
  ],
  [/low_disk|磁盘剩余|not enough space|disk full|空间不够/i, "磁盘剩余空间不足。清理磁盘，或在插件控制台换一个剩余空间足够的安装目录后重装（脚本可重跑，已下载的部分会复用）。"],
  [/no_cuda|no_nvidia_gpu|未检测到.{0,8}(nvidia|显卡|gpu)|nvidia-smi/i, "没检测到可用的 NVIDIA 显卡 / 驱动。装的是 CUDA 版本依赖，缺卡装不上：换一台有 N 卡的机器，或在插件里显式选择 CPU 档（很慢）后重装。"],
  [/driver[_ ]?too[_ ]?old|驱动太旧|驱动过旧/i, "NVIDIA 驱动太旧，跑不了目标 CUDA 算子。请升级显卡驱动到支持该 CUDA 版本的版本后重装。"],
  [/vram_too_low|显存不足|out of memory|CUDA out of memory/i, "显存不足。关掉其它占显存的程序（本地大模型 / 视频后端），或换显存更大的显卡后重装。"],
  [/pip|Could not find a version|No matching distribution|ProxyError|SSLError|Read timed out/i, "Python 依赖下载失败（多半是镜像 / 网络抖动）。安装链已默认走国内 pip 源（清华 → 阿里云 / USTC，官方只做最后兜底），并用 PIP_* 环境变量压掉本机 pip.ini 里不可达的 extra-index；确认能访问国内镜像后重跑脚本即可，已装好的依赖不会重装。"],
  [/ghproxy|github|Rate limit|404 Not Found|Could not resolve host/i, "从 GitHub 拉取二进制 / 源码失败。安装链已默认走国内代理回退（ghfast.top → gh-proxy.com → ghproxy.net），最后才直连；换网络重试，或用各包自带的环境变量指向你自己的加速镜像后重跑。"],
  [/modelscope|hf-mirror|huggingface|safetensors|权重|weight/i, "模型权重下载失败或不完整。确认能访问 ModelScope / hf-mirror 后重跑脚本（权重支持断点续传，已完成的部分会复用）。"],
  [/npm ERR|npm_exit_|node_modules/i, "npm 安装失败。安装链已默认走 registry.npmmirror.com；确认本机 Node 可用后重跑安装。"],
  [/venv|ensurepip|No module named|ModuleNotFoundError|ImportError/i, "Python 环境不完整（venv 或某个包缺失）。重跑安装脚本会补齐；反复失败就把这一步的日志交给会话修复。"],
  [/cancelled|已取消|用户取消/i, "安装是你主动取消的，不是故障。要装就再点一次安装。"],
];

function hintFor(text) {
  const hay = String(text || "");
  for (const [re, msg] of HINTS) {
    if (re.test(hay)) return msg;
  }
  return "";
}

module.exports = { attach, hintFor, HINTS };
