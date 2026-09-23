"use strict";
/**
 * 插件报错总线（主进程）：宿主注册 + 错误上报 + 去抖 + 可修复性判定 + 一键修复回执。
 *
 * 为什么存在：各本地后端宿主（H3 / Music3 / TTS / llama.cpp / ASR / Remotion）的失败
 * 原先只落在自己控制台窗内的 toast 与画布节点状态里，**跨窗不可见、也没有统一入口**：
 * 主窗口看到「生成失败」，却既不知道根因、也不知道哪里点一下能修好。
 * 本模块把各宿主已有失败出口收成一个事件流，一次事件同时推两处：
 *   · `pluginRepair:error`（**扁平字段**）→ renderer/app-repair.js 的错误报告窗：用户点「🤖 自动修复」
 *     就在左侧栏新建一条看得见的会话去修（主路径，见下 `repairDialogPayload`）；
 *   · `pluginError:report`（原始嵌套事件）→ 面板 / 调试 / 未来消费方，字段一律不动。
 * 事件带错误码、错误正文、最近日志尾部、出问题的节点、安装目录，以及一次性的 repairToken；
 * 渲染层拿 token 回调 `pluginError:repair` 还能走宿主注册的那条隐藏式自我修复（回落路径）。
 *
 * 三条口径：
 * 1. **去抖合并**：同插件 + 同错误码 60s 内只算一次事件，后续只累加 `count`（带
 *    `suppressed:true` 推同一 `eventId` 供 UI 更新计数）。批量重跑连撞同一个
 *    not_installed / backend_exited 时，弹一次就够。
 * 2. **可修复性判定（会话修复优先）**：`cancelled` / 用户主动停止 / `busy` / `low_disk` / 无 N 卡 /
 *    `driver_too_old` 这类「让 Agent 再跑一遍也不会变好」的，一律 `repairable:false` ——
 *    只弹报告 + 指路（该做什么、对应哪个安装技能），不弹「自动修复」。
 *    其余情况只看**能不能给出一条可见会话干活的现场**：有安装目录（可写工作区）或至少取得到日志尾部
 *    就算可修，不再硬性要求宿主注册 `selfRepair`（remotion / 桌宠这类没有 Agent 安装链的由此也能修）；
 *    `host.selfRepair` 降级为 `pluginError:repair` 那条隐藏回落路径的门槛。
 * 3. **永不影响主流程**：注册、上报、取日志全程吞异常；宿主在本模块 init 之前报错
 *    也只是丢掉一次报告。
 *
 * IPC（`initPluginErrorBus` 注册，给渲染层「插件报错」面板用；preload 白名单桥在渲染侧补）：
 *   invoke `pluginError:listHosts` → [{ id, name, skillName, installDir, hasSelfRepair, canRestart }]
 *   invoke `pluginError:repair`    ({ token, note }) → 跑这次报错对应宿主的自我修复（隐藏回落路径）
 *   invoke `pluginError:restart`   ({ token })       → 重启该宿主后端
 *   invoke `pluginError:dismiss`   ({ hostId, code }) → 清掉该组合的去抖窗口
 *   send   `pluginError:report`    (事件)            → 推主窗口（原始嵌套事件）
 *   send   `pluginRepair:error`    (扁平载荷)        → 推主窗口（app-repair.js 的错误报告窗 + 会话修复）
 * 主进程侧另有两条回执通道（handler 在 main.js，本模块不接）：
 *   `pluginRepair:report` 用户点了什么 / `pluginRepair:result` 那轮修复会话的结论（判成成功即清去抖）。
 *
 * 数据纪律：本模块不写任何文件（日志与安装目录只读），用户数据一律留在 %APPDATA%。
 */
const { ipcMain } = require("electron");

/** 去抖窗口：同插件同错误码 60s 内合并计数。 */
const DEBOUNCE_MS = 60 * 1000;
/** repairToken 有效期：过期后必须重新触发一次操作才能再修。 */
const TOKEN_TTL_MS = 10 * 60 * 1000;
/** 同时留存的 token 上限（防无界增长）。 */
const TOKEN_MAX = 64;
/** 送进 IPC 的日志尾部 / 错误正文硬顶：跨进程的东西必须有体积上限。 */
const LOG_TAIL_CHARS = 4000;
const MESSAGE_CHARS = 4000;
/** 向宿主取日志时请求的字节数（宿主 consoleTail 按字节读文件尾部）。 */
const LOG_TAIL_BYTES = 64 * 1024;

/**
 * 不弹「自动修复」的错误码 → 指路文案（中文，直接进报告正文）。
 * 判定只问一句：**让 Agent 自我修复跑一遍，情况会变好吗？** 不会就只报告。
 */
const NOT_REPAIRABLE = {
  cancelled: "安装 / 生成是你主动取消的，不是故障。要再来一次，直接点节点或控制台上的「安装 / 启用」。",
  user_stopped: "后端是你手动停掉的，不是故障。到插件控制台点「启用」即可。",
  force_killed: "为了让别的音视频任务用显存，后端被强制结束了，不是故障。下次执行节点会自动重启它。",
  busy: "已经有安装 / 修复任务在跑，等它结束再看。",
  busy_other_node: "全局音视频锁被另一个节点占着（同一时刻只允许 1 个音乐 / 视频任务）。等它跑完或先取消它。",
  busy_media: "全局音视频锁被另一个任务占着，等它结束再试。",
  low_disk: "磁盘剩余空间不够，重装只会再失败一次。请清理磁盘，或在插件控制台换一个剩余空间足够的安装目录。",
  no_nvidia_gpu: "这些后端需要 NVIDIA 显卡，本机没检测到 —— 自动修复装不上 CUDA 版依赖。",
  no_cuda: "未检测到可用的 NVIDIA 显卡。换机器 / 插卡，或在插件里显式选「仍装 CPU 版（很慢）」后重新安装。",
  driver_too_old:
    "NVIDIA 驱动太旧（跑不了目标 CUDA 算子）。请把驱动升到支持该 CUDA 的版本再重装 —— 自我修复不会替你更新驱动。",
  bad_dir: "安装目录不合法（盘根 / 系统目录 / 应用目录一律拒绝）。请在插件控制台重选一个普通用户目录。",
  refuse_root: "安装目录不能是盘根目录。请在插件控制台重选一个子目录。",
  refuse_system: "安装目录不能在系统目录下。请在插件控制台重选一个普通用户目录。",
  dir_mismatch: "配置里的安装目录与实际目录不一致。请在插件控制台重新指定安装目录。",
  missing_node_id: "节点缺少 id（画布数据异常）。重新添加一个该类型节点再跑。",
  no_dsh: "Agent 网关不可用，自我修复需要它。请重启 MTNode 后再试。",
  empty_console: "控制台日志为空，没有可供 Agent 分析的现场。先跑一次安装或生成再点修复。",
};

/** 错误码别名：各宿主历史写法收敛到同一口径。 */
const CODE_ALIASES = {
  install_cancelled: "cancelled",
  agent_cancelled: "cancelled",
  render_cancelled: "cancelled",
  generate_cancelled: "cancelled",
  user_cancel: "cancelled",
  cancel: "cancelled",
  cancelled_by_user: "cancelled",
  stopped: "user_stopped",
  backend_busy: "busy",
  other_node_busy: "busy_other_node",
  no_gpu: "no_nvidia_gpu",
};

/** 宿主只丢回一长串文本时，从正文兜底识别错误码。 */
const CODE_HINTS = [
  [/\bcancelled\b|\bcanceled\b|已取消|用户取消/i, "cancelled"],
  [/driver[_ ]?too[_ ]?old|驱动太旧|驱动过旧/i, "driver_too_old"],
  [/no_nvidia_gpu|no nvidia|未检测到.{0,8}(nvidia|显卡|gpu)|no_cuda/i, "no_cuda"],
  [/low_disk|磁盘剩余|not enough space|disk full/i, "low_disk"],
  [/busy_other_node|busy_media/i, "busy_other_node"],
  [/\bbusy\b|正在安装中|already installing/i, "busy"],
  [/backend_start_timeout|启动超时|就绪超时/i, "backend_start_timeout"],
  [/backend_exited|进程启动后退出|进程退出|进程已退出/i, "backend_exited"],
  [/not_installed|尚未安装|未安装/i, "not_installed"],
  [/no_venv|venv 还没装好|缺少 Python 环境/i, "no_venv"],
  [/custom_workflow_missing|工作流不存在/i, "custom_workflow_missing"],
  [/\bbad_dir\b|refuse_root|refuse_system|安装目录不合法/i, "bad_dir"],
  [/\bno_dsh\b|agent 网关不可用/i, "no_dsh"],
  [/\bforce[_ ]?kill/i, "force_killed"],
  [/ModuleNotFoundError|ImportError|Traceback \(/i, "python_env_broken"],
  [/npm_exit_|npm ERR|npm err!/i, "npm_install_failed"],
  [/pack_missing|scaffold_missing|script_missing|脚手架缺失/i, "pack_missing"],
  [/health_check_failed|健康检查失败/i, "health_check_failed"],
  [/deliverable_missing|要件缺项|交付缺项/i, "deliverable_missing"],
  [/install_incomplete|incomplete|环境不完整/i, "incomplete"],
  [/empty_console|console 日志为空/i, "empty_console"],
  [/missing_source|source_missing|输入不存在/i, "source_missing"],
];

const hosts = new Map();
/** key = hostId + "\u0000" + code → { count, firstAt, lastAt } */
const debounces = new Map();
/** repairToken → { hostId, code, message, createdAt, used } */
const tokens = new Map();
/** hostId → true：自我修复 / 重启正在跑，防连点把 Agent 会话叠起来 */
const running = Object.create(null);

let getMainWin = null;
let logLine = null;

const now = () => Date.now();

function clip(s, n) {
  const t = String(s == null ? "" : s);
  return t.length <= n ? t : t.slice(t.length - n);
}

/** 去掉 ANSI 色码：日志文件里带颜色转义，塞进 UI 只会是乱码。 */
function stripAnsi(s) {
  return String(s == null ? "" : s).replace(/\x1b\[[0-9;]*m/g, "");
}

function hintCode(text) {
  const hay = String(text || "");
  for (const [re, c] of CODE_HINTS) {
    if (re.test(hay)) return c;
  }
  return "";
}

/** 一眼可认的错误码：短、且只有标识符字符。不满足就当它是「一段错误正文」。 */
const CODE_IDENT = /^[A-Za-z0-9_.-]{1,40}$/;

function headOf(text) {
  const head = String(text || "")
    .trim()
    .split(/[\s:：|,，;；()（）]+/)[0];
  return (head || "").toLowerCase().slice(0, 40);
}

function normCode(raw, message) {
  const rawCode = String(raw == null ? "" : raw).trim();
  /* 宿主有时把整条异常文本当 error 传回来（"install failed: exit 1 …"）：
     先从正文与原文里认已知错误码，认不出来才截第一个词当码，正文另有 message 承载。 */
  const code = CODE_IDENT.test(rawCode) ? rawCode : hintCode(message) || hintCode(rawCode) || headOf(rawCode);
  return CODE_ALIASES[code] || code || "unknown";
}

/**
 * 可修复性判定 → { repairable, why }。why = 不自动修时的指路文案。
 * 导出给宿主自测与渲染层复用（同一份判定，别在 UI 里再抄一遍清单）。
 *
 * 口径 = **会话修复优先**（弹窗里那颗「🤖 自动修复」新建一条可见会话，不要求宿主注册 selfRepair）：
 * 只看能不能给 Agent 一份干活的现场 —— 有安装目录（= 可写工作区）或至少取得到日志尾部，就值得修一轮；
 * 两样都没有才判不可修。`host.selfRepair` 只门槛住 `pluginError:repair` 那条隐藏回落路径
 * （见 runRepairByToken），不参与本判定 —— 否则 remotion / 桌宠这类没有 Agent 安装链的宿主永远修不了。
 * opts = { installDir }：本次事件实际拿到的安装目录（宿主没注册 getInstallDir、但上报里带了也算）。
 */
function judgeRepairability(host, code, message, opts) {
  const known = NOT_REPAIRABLE[code];
  if (known) return { repairable: false, why: known };
  const hay = String(message || "");
  for (const [re, c] of CODE_HINTS) {
    if (!NOT_REPAIRABLE[c]) continue;
    if (c !== code && re.test(hay)) return { repairable: false, why: NOT_REPAIRABLE[c] };
  }
  if (!host) {
    return { repairable: false, why: "该插件没在报错总线注册，只能人工看日志处理。" };
  }
  const o = opts || {};
  const dir = String(o.installDir || safeInstallDir(host) || "");
  if (!dir && typeof host.tailConsole !== "function") {
    return {
      repairable: false,
      why: "该插件既报不出安装目录（INSTALL_DIR = 修复会话的可写工作区），也取不到现场日志：Agent 没有可干的活。请打开它的控制台看完整日志后手动处理。",
    };
  }
  return { repairable: true, why: "" };
}

function safeInstallDir(host) {
  try {
    if (!host || typeof host.getInstallDir !== "function") return "";
    return String(host.getInstallDir() || "");
  } catch {
    return "";
  }
}

/** 最近日志尾部：宿主 consoleTail(n) → { ok, text }，取不到就空串（报告照发）。 */
function safeLogTail(host) {
  try {
    if (!host || typeof host.tailConsole !== "function") return "";
    const r = host.tailConsole(LOG_TAIL_BYTES);
    const text = r && typeof r === "object" && "text" in r ? r.text : r;
    return clip(stripAnsi(text), LOG_TAIL_CHARS);
  } catch {
    return "";
  }
}

function newToken(hostId, code, message) {
  const t = "rpt_" + now().toString(36) + "_" + cryptoRandom();
  tokens.set(t, {
    hostId,
    code,
    message: String(message || "").slice(0, 2000),
    createdAt: now(),
    used: false,
  });
  if (tokens.size > TOKEN_MAX) {
    const keys = [...tokens.keys()];
    for (const k of keys.slice(0, keys.length - TOKEN_MAX)) tokens.delete(k);
  }
  return t;
}

function cryptoRandom() {
  try {
    return require("crypto").randomBytes(6).toString("hex");
  } catch {
    return Math.random().toString(36).slice(2, 14);
  }
}

function pruneTokens() {
  const cutoff = now() - TOKEN_TTL_MS;
  for (const [k, v] of tokens) {
    if (!v || Number(v.createdAt) < cutoff) tokens.delete(k);
  }
}

function hostView(h) {
  return {
    id: h.id,
    name: h.name || h.id,
    skillName: h.skillName || "",
    installDir: safeInstallDir(h),
    hasSelfRepair: typeof h.selfRepair === "function",
    canRestart: typeof h.restart === "function",
  };
}

/**
 * 总线事件 → 渲染层错误报告窗那一份**扁平**载荷（消费方 renderer/app-repair.js）。
 * 两侧字段名历史上各说各话：总线给嵌套（plugin / node / autoFix），弹窗吃扁平 ——
 * 这里一次性映射掉，弹窗侧不必再猜、也不必两条通道都订阅。
 * 字段名与 renderer/app-repair.js 的 pluginRepairNormalize 一一对应；
 * repairable / why 一并带下去：不可修时窗内把「自动修复」置灰并显示 why（指路文案只有一个真源）。
 */
function repairDialogPayload(ev) {
  const p = (ev && ev.plugin) || {};
  const n = (ev && ev.node) || {};
  const a = (ev && ev.autoFix) || {};
  return {
    pluginId: p.id || "",
    pluginName: p.name || "",
    /* kind 也填插件 id：弹窗侧按 pluginId 或 kind 任一路都能查到该插件的服务表条目 */
    kind: p.id || "",
    skill: p.skillName || "",
    installDir: (ev && ev.installDir) || "",
    code: (ev && ev.code) || "",
    message: (ev && ev.message) || "",
    phase: (ev && ev.phase) || "",
    log: (ev && ev.logTail) || "",
    nodeId: n.id || "",
    nodeTitle: n.title || "",
    nodeKind: n.kind || "",
    workflowId: n.workflowId || "",
    workflowName: n.workflowName || "",
    repairToken: a.repairToken || "",
    repairable: !!a.repairable,
    why: a.why || "",
    hasRestart: !!a.hasRestart,
    count: Number((ev && ev.count) || 1),
    eventId: (ev && ev.eventId) || "",
    at: Number((ev && ev.ts) || now()),
  };
}

function sendToMainWindow(event) {
  try {
    const w = getMainWin && getMainWin();
    if (!w || w.isDestroyed()) return false;
    /* 一次事件推两条：先推弹窗那条（app-repair.js 吃扁平字段），再推原始事件。
       合并计数（suppressed）与修复回执（kind=repairResult）都不是「新报错」，只走原始通道 ——
       否则同一 token 在渲染层那 45s 去重窗外会被重复弹一次报告窗。 */
    if (event && event.eventId && !event.suppressed) {
      try {
        w.webContents.send("pluginRepair:error", repairDialogPayload(event));
      } catch {}
    }
    w.webContents.send("pluginError:report", event);
    return true;
  } catch {
    return false;
  }
}

function busLog(line) {
  try {
    if (logLine) logLine(line);
  } catch {}
}

/**
 * 注册一个宿主。同 id 重复注册覆盖旧值（宿主模块热重载 / 多次 init 时幂等）。
 * host: { id, name, skillName, getInstallDir(), tailConsole(n), selfRepair(opts), restart() }
 */
function registerPluginHost(host) {
  try {
    const id = String((host && host.id) || "").trim();
    if (!id) return { ok: false, error: "bad_host_id" };
    const prev = hosts.get(id);
    hosts.set(id, {
      id,
      name: String(host.name || (prev && prev.name) || id),
      skillName: String(host.skillName || (prev && prev.skillName) || ""),
      getInstallDir:
        typeof host.getInstallDir === "function" ? host.getInstallDir : (prev && prev.getInstallDir) || null,
      tailConsole: typeof host.tailConsole === "function" ? host.tailConsole : (prev && prev.tailConsole) || null,
      selfRepair: typeof host.selfRepair === "function" ? host.selfRepair : (prev && prev.selfRepair) || null,
      restart: typeof host.restart === "function" ? host.restart : (prev && prev.restart) || null,
    });
    return { ok: true, id, replaced: !!prev };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function getPluginHost(id) {
  return hosts.get(String(id || "")) || null;
}

function listPluginHosts() {
  return [...hosts.values()].map(hostView);
}

/**
 * 上报一次插件错误。宿主在已有失败出口加一行即可；本函数**永不抛异常**。
 * payload: { code?, error?, message?, phase?, nodeId?, nodeTitle?, nodeKind?,
 *            workflowId?, workflowName?, installDir? }
 * 返回 { ok, merged }：merged=true 表示落在去抖窗口内，只加了计数、没新建事件。
 */
function reportPluginError(pluginId, payload) {
  try {
    const id = String(pluginId || "").trim();
    const p = payload && typeof payload === "object" ? payload : {};
    const message = clip(stripAnsi(p.message || p.detail || p.error || p.code || ""), MESSAGE_CHARS);
    const code = normCode(p.code || p.error, message);
    const host = hosts.get(id) || null;
    if (!host) busLog(`[plugin-error] 未注册的宿主: ${id || "(空)"} code=${code}`);

    const key = id + "\u0000" + code;
    const prev = debounces.get(key);
    if (prev && now() - Number(prev.lastAt || 0) < DEBOUNCE_MS) {
      prev.count = Number(prev.count || 0) + 1;
      prev.lastAt = now();
      /* 合并计数：推回同一个 eventId，UI 只更新计数，不再弹一次。 */
      if (prev.event) sendToMainWindow(Object.assign({}, prev.event, { count: prev.count, suppressed: true }));
      return { ok: true, merged: true, count: prev.count, eventId: prev.eventId || "" };
    }
    const st = { count: 1, firstAt: now(), lastAt: now() };
    debounces.set(key, st);
    /* 去抖表只防无界增长：过期条目清掉即可，事件不靠它回溯。 */
    if (debounces.size > 256) {
      for (const [k, v] of debounces) {
        if (now() - Number(v.lastAt || 0) >= DEBOUNCE_MS) debounces.delete(k);
      }
    }

    pruneTokens();
    /* 先定安装目录再判可修：会话修复的「可写工作区」就是它，宿主没注册 getInstallDir
       但上报里带了目录的（如插件安装链）也算有现场。 */
    const installDir = String(p.installDir || safeInstallDir(host) || "");
    const judged = judgeRepairability(host, code, message, { installDir });
    const repairToken = judged.repairable ? newToken(id, code, message) : "";
    const event = {
      eventId: "evt_" + now().toString(36) + "_" + cryptoRandom(),
      ts: now(),
      plugin: { id, name: (host && host.name) || id, skillName: (host && host.skillName) || "" },
      code,
      message,
      phase: String(p.phase || "").trim(),
      /* 出问题的节点：宿主只知道 id 时，标题由主窗口按 id 在画布里现查。 */
      node: {
        id: String(p.nodeId || p.node || "").trim(),
        title: String(p.nodeTitle || p.nodeName || "").trim(),
        kind: String(p.nodeKind || "").trim(),
        workflowId: String(p.workflowId || p.canvasWorkflowId || "").trim(),
        workflowName: String(p.workflowName || "").trim(),
      },
      installDir: installDir,
      logTail: safeLogTail(host),
      count: 1,
      autoFix: {
        repairable: !!judged.repairable,
        why: judged.why,
        hasRestart: !!(host && typeof host.restart === "function"),
        repairToken,
      },
    };
    st.event = event;
    st.eventId = event.eventId;
    busLog(
      `[plugin-error] ${id} code=${code} repairable=${event.autoFix.repairable}` +
        (event.autoFix.repairable ? "" : ` why=${event.autoFix.why}`),
    );
    sendToMainWindow(event);
    return { ok: true, merged: false, count: 1, eventId: event.eventId };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 清去抖窗口（修好了 / UI 关掉报告时调用），让同类错误下次能重新弹一条。 */
function resetDebounce(pluginId, code) {
  try {
    const id = String(pluginId || "");
    const c = String(code || "");
    if (!id && !c) {
      debounces.clear();
      return { ok: true };
    }
    for (const k of [...debounces.keys()]) {
      const [kh, kc] = k.split("\u0000");
      if ((id && kh !== id) || (c && kc !== c)) continue;
      debounces.delete(k);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function takeToken(token) {
  pruneTokens();
  const t = String(token || "");
  const rec = tokens.get(t);
  if (!rec) return null;
  if (rec.used) return null;
  return { token: t, rec };
}

function repairResultEvent(hostId, payload) {
  try {
    sendToMainWindow(
      Object.assign({ kind: "repairResult", ts: now(), hostId: String(hostId || "") }, payload || {}),
    );
  } catch {}
}

/**
 * 自我修复（**隐藏回落路径**）：拿 token 找回是哪一次报错，交给宿主注册的 selfRepair（读 console 交 Agent 分析）。
 * 主路径是渲染层那条「看得见的会话」（app-repair.js 直接新建会话，不经这里）；本通道只服务
 * 注册了 selfRepair 的宿主（各插件控制台窗里的老「自我修复」入口 / 面板调用）。
 * 没注册 selfRepair 的宿主判不成可修也不是「不能修」—— 如实指回弹窗那颗「自动修复」。
 */
async function runRepairByToken(token, note) {
  try {
    const hit = takeToken(token);
    if (!hit) {
      return {
        ok: false,
        error: "repair_token_expired",
        message: "该报告的修复凭据已过期或已用过，请重新触发一次操作再看报告。",
      };
    }
    const { rec } = hit;
    const host = hosts.get(rec.hostId);
    if (!host) return { ok: false, error: "no_host", message: "插件宿主未注册，无法自动修复。" };
    const judged = judgeRepairability(host, rec.code, rec.message, { installDir: safeInstallDir(host) });
    if (!judged.repairable) {
      return { ok: false, error: "not_repairable", code: rec.code, message: judged.why };
    }
    if (typeof host.selfRepair !== "function") {
      return {
        ok: false,
        error: "no_hidden_repair",
        code: rec.code,
        message: "该插件没有主进程内的隐藏自我修复入口，请在报错弹窗里点「🤖 自动修复」（新建一条看得见的会话来修）。",
      };
    }
    if (running[host.id]) return { ok: false, error: "busy", message: "该插件的修复 / 重启已在进行中。" };
    rec.used = true;
    running[host.id] = true;
    busLog(`[plugin-error] repair start host=${host.id} code=${rec.code}`);
    repairResultEvent(host.id, { state: "start", code: rec.code });
    try {
      const r = await host.selfRepair({
        error: String(rec.message || "") + (note ? "\n\n补充说明：" + String(note) : ""),
        code: rec.code,
        via: "pluginErrorBus",
      });
      const ok = !!(r && r.ok);
      busLog(`[plugin-error] repair done host=${host.id} ok=${ok}`);
      repairResultEvent(host.id, {
        state: ok ? "done" : "failed",
        code: rec.code,
        error: ok ? "" : String((r && (r.error || r.message)) || "repair_failed"),
      });
      /* 修好了就清去抖：同类错误若再出现要能重新弹报告。 */
      if (ok) resetDebounce(host.id, rec.code);
      return Object.assign({ hostId: host.id, code: rec.code }, r && typeof r === "object" ? r : { ok });
    } catch (e) {
      const msg = String((e && e.message) || e);
      busLog(`[plugin-error] repair threw host=${host.id} ${msg}`);
      repairResultEvent(host.id, { state: "failed", code: rec.code, error: msg });
      return { ok: false, error: "repair_threw", message: msg, hostId: host.id, code: rec.code };
    } finally {
      running[host.id] = false;
    }
  } catch (e) {
    return { ok: false, error: "repair_crashed", message: String((e && e.message) || e) };
  }
}

/** 重启后端：报告里的次要动作（不重装，先重启看看）。 */
async function restartByToken(token) {
  try {
    const hit = takeToken(token);
    const hostId = hit ? hit.rec.hostId : "";
    const host = hosts.get(hostId);
    if (!host || typeof host.restart !== "function") {
      return { ok: false, error: "no_restart", message: "该插件没有可重启的后端进程。" };
    }
    if (running[host.id]) return { ok: false, error: "busy", message: "该插件的修复 / 重启已在进行中。" };
    if (hit) hit.rec.used = true;
    running[host.id] = true;
    try {
      const r = await host.restart();
      const ok = !!(r && r.ok);
      if (ok) resetDebounce(host.id, hit ? hit.rec.code : "");
      return Object.assign({ hostId: host.id, code: hit ? hit.rec.code : "" }, r && typeof r === "object" ? r : { ok });
    } catch (e) {
      return { ok: false, error: "restart_threw", message: String((e && e.message) || e), hostId: host.id };
    } finally {
      running[host.id] = false;
    }
  } catch (e) {
    return { ok: false, error: "restart_crashed", message: String((e && e.message) || e) };
  }
}

/** 主进程 init 一次：给主窗口 getter + 注册 IPC。宿主模块只 require + registerPluginHost。 */
function initPluginErrorBus(opts) {
  try {
    const o = opts || {};
    getMainWin = typeof o.getMainWin === "function" ? o.getMainWin : getMainWin;
    logLine = typeof o.log === "function" ? o.log : logLine;
    if (o.registerIpc === false) return { ok: true, ipc: false };
    if (!ipcMain || typeof ipcMain.handle !== "function") return { ok: true, ipc: false };
    if (initPluginErrorBus._ipc) return { ok: true, ipc: true };
    initPluginErrorBus._ipc = true;
    ipcMain.handle("pluginError:listHosts", async () => ({ ok: true, hosts: listPluginHosts() }));
    ipcMain.handle("pluginError:repair", async (e, payload) => {
      const p = payload && typeof payload === "object" ? payload : {};
      return runRepairByToken(p.token, p.note);
    });
    ipcMain.handle("pluginError:restart", async (e, payload) => {
      const p = payload && typeof payload === "object" ? payload : {};
      return restartByToken(p.token);
    });
    ipcMain.handle("pluginError:dismiss", async (e, payload) => {
      const p = payload && typeof payload === "object" ? payload : {};
      return resetDebounce(p.hostId, p.code);
    });
    return { ok: true, ipc: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

module.exports = {
  DEBOUNCE_MS,
  registerPluginHost,
  getPluginHost,
  listPluginHosts,
  reportPluginError,
  resetDebounce,
  judgeRepairability,
  repairDialogPayload,
  runRepairByToken,
  restartByToken,
  initPluginErrorBus,
};
