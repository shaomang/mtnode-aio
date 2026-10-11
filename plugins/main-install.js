"use strict";
/**
 * 插件**安装窗**编排（主进程，唯一一处）：
 * 把 8 个本地后端宿主 + 窗口类插件 + 桌宠的安装/下载链，收成一只看得见过程的独立窗：
 * 左侧是「安装脚本对应的步骤表」（来自各包 steps.json，未跑到的显示「待执行」），
 * 右侧是当前步骤的日志；某一步失败就停在失败步，显示日志尾部与建议修复方法，
 * 并给「交给 mtnode 会话修复」—— 新建一条可见会话（工作区 = 安装目录，按该插件 -install skill 修），
 * 不再由插件端静默转 Agent 兜底（看不见过程正是本轮要消掉的东西）。
 *
 * 为什么在这里：安装本身仍跑在各插件自己的宿主进程里（它有 venv / ComfyUI / git 那套环境），
 * 本模块只做三件事 ——
 *   ① 开 / 关 / 复用这只窗（`openInstallWindow`）；
 *   ② 接各宿主的上报（`reportPluginStep` / `beginPluginInstall` / `finishPluginInstall`）并广播给窗；
 *   ③ 提供「交给会话」所需的一份现场快照（`sessionRequestPayload`），会话由主窗口渲染层新建
 *      （渲染层的 app-repair.js 已有同款做法，安装窗不自己造第二套会话入口）。
 *
 * 数据纪律：本模块**不落盘**（不写日志文件、不写配置）；只读各包 steps.json 与安装目录路径。
 * 步骤模型与协议解析在 plugins/install-steps.js（纯函数，冒烟可直接 require）。
 *
 * IPC（本模块注册，主窗口 preload 白名单里各有一份桥）：
 *   invoke `mtnodeInstall:open`    { id, name?, skill?, installDir?, action? } → { ok, open }
 *   invoke `mtnodeInstall:close`   { id? }                                   → { ok }
 *   invoke `mtnodeInstall:state`   { id? }                                   → { ok, session|null, sessions:[…] }
 *   invoke `mtnodeInstall:cancel`  { id }                                     → 转发宿主自己的取消口
 *   invoke `mtnodeInstall:fix`     { id }                                     → 请主窗口新建修复会话（delegate:"session" 事件）
 *   send   `mtnodeInstall:session` { id, installDir, skill, name, action, code, message, hint, log } → 主窗口
 *   send   `mtnodeInstall:state`   (session)  → 安装窗（快照）
 *   send   `mtnodeInstall:event`   ({ id, kind, … }) → 安装窗（步骤 / 日志 / 终结）
 */
const path = require("path");
const fs = require("fs");
const { BrowserWindow, ipcMain, screen, dialog } = require("electron");
const steps = require("./install-steps.js");
const weights = require("./install-weights.js");

/** 窗单例：同一时刻只开一只安装窗（切插件 = 原地换内容，不叠窗）。 */
let installWin = null;
let getMainWin = null;
let getDataDir = null;
let appRoot = null;
let logLine = null;

/** pluginId → 会话快照（内存，关掉窗后重开仍能看回上一次结果）。 */
const sessions = new Map();
/** pluginId → 宿主登记（开窗 / 换插件时按 id 取名字、技能与安装目录）。 */
const plugins = new Map();
/** 每个插件的取消口：{ id → () => Promise } —— 由宿主在自己 register 时给。 */
const cancels = new Map();
/** 兜底取消口：没登记 id 的插件（窗口插件 id 是云端目录动态来的，装不到一份固定表）就用它。 */
let cancelFallback = null;
/** 当前窗里显示哪一个插件（切插件只换内容，不新开窗）。 */
let currentId = "";
/** 主窗口是否订阅了「请新建修复会话」事件（渲染层就绪前丢事件会很困惑，先记着）。 */
let mainReady = false;
/** pluginId → 用户已指定的「手动下载的权重位置」（内存，不落盘：它只是这一次搬运的输入）。 */
const weightsSel = new Map();
/** 正在跑的权重搬运作业：{ id, cancelled }（同一时刻只允许一个）。 */
let weightsJob = null;
/** pluginId → 最近一次搬运结果（关窗重开仍看得到结论）。 */
const weightsLast = new Map();

function log(line) {
  try {
    if (logLine) logLine(line);
  } catch {}
}

/* ------------------------------------------------------------------ */
/* 步骤清单（各包 steps.json）                                          */
/* ------------------------------------------------------------------ */

/**
 * 读一个包的 steps.json。
 * packRoots: 该插件可能的包根候选（宿主传自己那份 bundledPackRoot()，未装 / 未打包时可能不存在）。
 * 找不到就回空清单 —— 安装窗照样能跑（脚本打的步骤行会逐步累积出来），只是开窗时看不到全表。
 */
function readManifest(packRoots) {
  const roots = Array.isArray(packRoots) ? packRoots : packRoots ? [packRoots] : [];
  for (const r of roots) {
    const p = path.join(String(r || ""), "steps.json");
    try {
      if (!fs.existsSync(p)) continue;
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      const man = steps.normManifest(raw);
      if (man.steps.length) return man;
    } catch (e) {
      log("[install] steps.json 解析失败 " + p + " :: " + String((e && e.message) || e));
    }
  }
  return { version: 1, steps: [] };
}

/** 窗口类插件（kind=window）没有 steps.json：下载 / 校验 / 解压就是它的全部步骤。
 *  这是它唯一一份步骤表（真源在此），卡片与安装窗都按它显示。 */
const WINDOW_PLUGIN_MANIFEST = {
  version: 1,
  steps: [
    { id: "prepare", title: "准备安装信息（目录 / 版本 / 下载地址）" },
    { id: "download", title: "下载安装包", hint: "从云端目录给的地址下载 zip；失败多为网络或服务端返回非 200。" },
    { id: "verify", title: "校验安装包（sha256）", hint: "校验不过说明包在传输中损坏或云端目录声明的 sha256 不一致：重下一次，仍失败请反馈云端目录。" },
    { id: "extract", title: "解压并检查入口页", hint: "缺入口 HTML = 云端包结构不对，属于服务端问题。" },
    { id: "done", title: "写入安装信息" },
  ],
};

/** 插件 id 的类别：从 id 后缀 / 已知命名习惯判，只用于挑兜底步骤表。 */
function kindOfId(id) {
  const s = String(id || "");
  if (/^pet$|bongochat/i.test(s)) return "pet";
  return "window";
}

/**
 * 该插件的步骤清单：① 显式给的 → ② 包里的 steps.json → ③ 兜底表（窗口插件 / 桌宠）。
 * 三级都空就回空清单 —— 安装窗照样跑，步骤行会逐步累积出来。
 */
function resolveManifest(t, explicitSteps) {
  if (Array.isArray(explicitSteps) && explicitSteps.length) return steps.normManifest({ steps: explicitSteps });
  const man = manifestOf(t);
  if (man && man.steps && man.steps.length) return man;
  return steps.normManifest(kindOfId(t && t.id) === "pet" ? PET_MANIFEST : WINDOW_PLUGIN_MANIFEST);
}

/** 桌宠安装（pet:install）：单步——复制托盘资源并注册自启。 */
const PET_MANIFEST = {
  version: 1,
  steps: [
    { id: "prepare", title: "准备桌宠资源目录" },
    { id: "copy", title: "复制桌宠资源（Live2D 托盘）", hint: "写入失败多为权限 / 磁盘问题；换一个普通用户目录后重试。" },
    { id: "done", title: "写入安装信息" },
  ],
};

/* ------------------------------------------------------------------ */
/* 宿主登记                                                            */
/* ------------------------------------------------------------------ */

/**
 * 登记一个可安装对象。宿主在自己 registerXxxIpc 里调用一次（幂等，后登记覆盖旧值）。
 * def: {
 *   id,                       // 与插件卡片一致（如 "llama-local" / "sensenova-local" / "remotion"）
 *   key?,                     // 宿主自己的短名（如 "llama"），仅用于日志
 *   name,                     // 窗标题上的中文名
 *   skill?,                   // 该插件的安装类 skill 名（失败时交给会话修复用）
 *   packRoots?,               // steps.json 所在包根（数组或单值）
 *   getInstallDir?(),         // 取当前安装目录（未选目录时返回 ""）
 *   cancel?(),                // 取消安装（宿主自己的 cancelInstall）
 *   kindLabel?,               // 「窗口插件 / 本地后端」这类展示口径
 * }
 */
function registerInstallTarget(def) {
  try {
    const d = def || {};
    const id = String(d.id || "").trim();
    if (!id) return { ok: false, error: "bad_id" };
    plugins.set(id, {
      id,
      key: String(d.key || id),
      name: String(d.name || id),
      skill: String(d.skill || ""),
      kindLabel: String(d.kindLabel || ""),
      packRoots: d.packRoots || null,
      getInstallDir: typeof d.getInstallDir === "function" ? d.getInstallDir : null,
      cancel: typeof d.cancel === "function" ? d.cancel : null,
      manifest: null,
    });
    if (typeof d.cancel === "function") cancels.set(id, d.cancel);
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function targetOf(id) {
  return plugins.get(String(id || "")) || null;
}

/**
 * 登记「兜底取消口」：窗口插件的 id 来自云端目录（装机前不知道有哪些），
 * 没法逐个 registerInstallTarget；这类安装的取消由 plugins/main-app-plugins.js 提供：
 *   fallback(id) → 掐断该插件的下载（AbortController）并让安装链当场收手。
 */
function registerCancelFallback(fn) {
  cancelFallback = typeof fn === "function" ? fn : null;
  return { ok: true, has: !!cancelFallback };
}

/**
 * 某个插件当前的安装目录（安装窗 / 权重指路的现场）。
 * 口径与主进程其它处一致（plugins/main-app-plugins.js 的 installDirOf）：
 *   ① 插件自己的配置里设过 installDir → 用它（「插件中仍然允许更换安装目录」）；
 *   ② 没设过 → 插件根目录 + 默认子目录名（<数据目录>/config.json 的 plugins.installDir，
 *      见 plugins/plugin-root.js）；根目录没设时为空串；
 *   ③ 其余插件 → 老口径 <数据目录>/app-plugins/<id>。
 */
function installDirOf(id) {
  const sid = String(id || "");
  if (!sid) return "";
  try {
    const t = targetOf(sid);
    const own = t && typeof t.getInstallDir === "function" ? String(t.getInstallDir() || "") : "";
    if (own) return own;
    const mod = getPluginRootMod();
    if (mod && mod.needsDir(sid)) return mod.defaultDir(sid) || "";
    const host = plugins.get(sid);
    const viaHost = host && typeof host.getInstallDir === "function" ? String(host.getInstallDir() || "") : "";
    if (viaHost) return viaHost;
  } catch {}
  try {
    return getPluginDir ? String(getPluginDir(sid) || "") : "";
  } catch {
    return "";
  }
}
/** 插件根目录模块（plugins/plugin-root.js）的懒加载单例；取不到就返回 null（老行为不变）。 */
let pluginRootMod = null;
let pluginRootTried = false;
function getPluginRootMod() {
  if (pluginRootTried) return pluginRootMod;
  pluginRootTried = true;
  try {
    const { createPluginRoot } = require("./plugin-root.js");
    pluginRootMod = createPluginRoot({
      getDataDir: () => dataDirOf(),
      getAppDirs: () => appDirsOf(),
    });
  } catch {
    pluginRootMod = null;
  }
  return pluginRootMod;
}
function dataDirOf() {
  try {
    return typeof getDataDir === "function" ? String(getDataDir() || "") : "";
  } catch {
    return "";
  }
}
function appDirsOf() {
  const out = [];
  try {
    const root = String(appRoot || "");
    if (root) {
      out.push(root);
      out.push(path.join(root, ".."));
    }
  } catch {}
  return out.filter(Boolean);
}

function manifestOf(t) {
  if (!t) return { version: 1, steps: [] };
  if (!t.manifest) t.manifest = readManifest(t.packRoots);
  return t.manifest;
}

/* ------------------------------------------------------------------ */
/* 快照与广播                                                          */
/* ------------------------------------------------------------------ */

function snapshotOf(id) {
  return sessions.get(String(id || "")) || null;
}

/** 只推给安装窗（主窗口不需要逐步日志）。 */
function sendToWin(channel, payload) {
  try {
    if (installWin && !installWin.isDestroyed()) {
      installWin.webContents.send(channel, payload);
    }
  } catch {}
}

/** 推给主窗口（渲染层）：只有「请新建修复会话」这一件事走它。 */
function sendToMain(channel, payload) {
  try {
    const w = getMainWin && getMainWin();
    if (w && !w.isDestroyed()) {
      w.webContents.send(channel, payload);
      return true;
    }
  } catch {}
  return false;
}

/**
 * 开一次安装（宿主在真正开始前后调用）：
 *   · 建一份新快照（同插件上一次的结果被替换：安装窗显示的是「这一次」）；
 *   · 窗没开就开、开着就切到该插件。
 * opts: { id, action?, installDir? }
 */
function beginPluginInstall(opts) {
  const o = opts || {};
  const id = String(o.id || "").trim();
  if (!id) return { ok: false, error: "bad_id" };
  const t = targetOf(id);
  const man = resolveManifest(t, o.steps);
  const snap = steps.createSnapshot({
    id,
    name: String(o.name || (t && t.name) || id),
    installDir: String(o.installDir || installDirOf(id) || ""),
    skillName: (t && t.skill) || "",
    action: o.action || "install",
    steps: man.steps,
    startedAt: Date.now(),
  });
  sessions.set(id, snap);
  currentId = id;
  ensureWindow();
  sendToWin("mtnodeInstall:state", snap);
  log("[install] begin id=" + id + " steps=" + snap.steps.length + " dir=" + snap.installDir);
  return { ok: true, session: snap };
}

/** 宿主上报一条事件（步骤 / 日志 / 终结）。永不抛。 */
function reportPluginStep(ev) {
  try {
    const e = ev || {};
    const id = String(e.pluginId || "").trim();
    if (!id) return { ok: false, error: "bad_id" };
    let snap = sessions.get(id);
    if (!snap) {
      /* 宿主没先 begin（老代码路径 / 直接点控制台里的安装）就上报：补一份空清单快照，
         步骤行照样会累积出来，安装窗不会因为「没清单」而空白。 */
      beginPluginInstall({ id });
      snap = sessions.get(id);
    }
    if (!snap) return { ok: false, error: "no_session" };
    if (e.kind === "step") {
      const r = steps.applyStep(snap, e.step);
      if (!r.ok) return { ok: false, error: "bad_step" };
      sendToWin("mtnodeInstall:event", {
        id,
        kind: "step",
        stepIndex: r.stepIndex,
        step: snap.steps[r.stepIndex],
        state: snap.state,
        pct: snap.pct,
        error: snap.error,
      });
      return { ok: true, stepIndex: r.stepIndex };
    }
    if (e.kind === "log") {
      const pushed = steps.pushLog(snap, e.stepId, e.line);
      sendToWin("mtnodeInstall:event", {
        id,
        kind: "log",
        stepId: String(e.stepId || "_"),
        line: String(e.line || ""),
        stream: String(e.stream || "out"),
        /* 这行在整场安装里的序号：窗里的「全部」视图按它还原真实输出顺序
           （日志按步分桶存，但用户看的是脚本真实吐出来的先后） */
        seq: (pushed && pushed.seq) || 0,
      });
      return { ok: true };
    }
    if (e.kind === "finish") {
      steps.finishSnapshot(snap, {
        ok: !!e.ok,
        error: String(e.error || ""),
        hint: String(e.hint || ""),
      });
      sendToWin("mtnodeInstall:event", { id, kind: "finish", session: snap });
      notifyMainFinished(snap);
      log("[install] finish id=" + id + " ok=" + !!e.ok + " err=" + String(e.error || ""));
      return { ok: true, state: snap.state };
    }
    return { ok: false, error: "bad_kind" };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * 宿主判定安装终局（成功 / 失败 / 取消）—— 与 install-step-reporter 的 finish 同一口径，
 * 宿主两条路都会走：脚本进程结束（reporter.finish）+ 安装函数返回（本函数）。
 * 重复调用是幂等的（已是终局就不再改）。
 */
function finishPluginInstall(opts) {
  const o = opts || {};
  const id = String(o.id || "").trim();
  const snap = snapshotOf(id);
  if (!id || !snap) return { ok: false, error: "no_session" };
  if (snap.state === "done" || snap.state === "failed") return { ok: true, state: snap.state };
  steps.finishSnapshot(snap, {
    ok: !!o.ok,
    error: String(o.error || ""),
    hint: String(o.hint || o.advice || ""),
  });
  sendToWin("mtnodeInstall:event", { id, kind: "finish", session: snap });
  notifyMainFinished(snap);
  /* 失败时**不再**推主窗口的报错报告窗（本轮共识：全部在安装窗内呈现）；
     只有用户点了「交给 mtnode 会话修复」才请主窗口新建会话。 */
  log("[install] finish id=" + id + " ok=" + !!o.ok + " err=" + String(o.error || ""));
  return { ok: true, state: snap.state };
}

/**
 * 终局广播给主窗口：卡片上的安装进度已按本轮需求整块下线（安装过程只显示在安装窗），
 * 主窗口因此没有任何进度事件可听 —— 装完之后卡片状态可能已经变了（装了 / 还没装 / 要件补齐），
 * 由这一条让它重画卡片并刷新画布插件缓存（节点菜单可见性）。
 * 只送事实（id / 终局 / 成败），不送日志（日志只属于安装窗）。
 */
function notifyMainFinished(snap) {
  if (!snap) return;
  sendToMain("mtnodeInstall:finished", {
    id: snap.pluginId,
    state: snap.state,
    ok: snap.state === "done",
    name: snap.name || "",
    at: Date.now(),
  });
}

/** 步骤脚本自己说了失败（脚本写了 ok=false / 抛错），宿主把原因递进来。 */
function failStep(id, stepId, message) {
  return reportPluginStep({
    pluginId: id,
    kind: "step",
    step: { id: String(stepId || ""), status: "fail", message: String(message || "") },
  });
}

/* ------------------------------------------------------------------ */
/* 失败 → 交给 mtnode 会话修复                                          */
/* ------------------------------------------------------------------ */

/**
 * 给会话用的一份现场（安装窗「交给 mtnode 会话修复」按钮 → 主窗口渲染层新建会话）。
 * 正文只带**可复核的事实**：插件名 / 技能 / 安装目录 / 失败步骤 / 该步日志尾部。
 * 结论与建议由会话自己按 skill 判断，这里不预设根因。
 */
function sessionRequestPayload(id) {
  const t = targetOf(id);
  const snap = snapshotOf(id);
  if (!snap) return null;
  let failed = null;
  for (const s of snap.steps) {
    if (s.status === "fail") {
      failed = s;
      break;
    }
  }
  const stepId = failed ? failed.id : steps.currentStepId(snap);
  const logs = (snap.logs && (snap.logs[stepId] || snap.logs._)) || "";
  return {
    id: snap.pluginId,
    name: (t && t.name) || snap.name || snap.pluginId,
    skill: (t && t.skill) || snap.skillName || "",
    installDir: snap.installDir || installDirOf(id),
    action: snap.action || "install",
    code: snap.state === "failed" ? "install_step_failed" : "",
    stepId,
    stepTitle: failed ? failed.title : "",
    message: (failed && failed.message) || snap.error || "",
    hint: snap.hint || "",
    log: steps.tailLines(logs, 240),
    at: Date.now(),
  };
}

/**
 * 安装窗点了「打开插件控制台」：请主窗口渲染层开那只控制台窗。
 * 为什么绕主窗口：各插件的控制台入口在主窗口的插件卡片逻辑里（`<api>Open` / 窗口插件的
 * `appPlugins:open`），安装窗不该自己再造一份映射表。主窗口没开就只回错，不静默。
 */
function requestOpenConsole(id) {
  const sid = String(id || "").trim();
  if (!sid) return { ok: false, error: "bad_id" };
  if (!sendToMain("mtnodeInstall:openConsole", { id: sid })) {
    return { ok: false, error: "no_main_window", message: "主窗口不可用，无法打开插件控制台。" };
  }
  return { ok: true };
}

/** 安装窗可用的安装类桥（主窗口 preload 的同名桥 → 它调的 IPC 通道）。
 *  表在**主进程**维护，安装窗不能自定义名字：它只被允许调这张表里的通道。
 *  转发时把「调用方」换成主窗口（e.sender = mainWin.webContents）——否则 appPlugins:close
 *  这类按 sender 认窗的 handler 会把安装窗当成它要操作的那只窗。 */
const INSTALL_API_CHANNELS = {
  music3Install: "music3:install",
  music3PickInstallDir: "music3:pickInstallDir",
  yue2Install: "yue:install",
  yue2PickInstallDir: "yue:pickInstallDir",
  h3Install: "h3:install",
  h3PickInstallDir: "h3:pickInstallDir",
  llamaInstall: "llama:install",
  llamaPickInstallDir: "llama:pickInstallDir",
  ttsInstall: "tts:install",
  ttsPickInstallDir: "tts:pickInstallDir",
  breezeInstall: "breeze:install",
  breezePickInstallDir: "breeze:pickInstallDir",
  sensenovaInstall: "sensenova:install",
  sensenovaPickInstallDir: "sensenova:pickInstallDir",
  remotionInstall: "remotion:install",
  remotionPickInstallDir: "remotion:pickInstallDir",
  appPluginsInstall: "appPlugins:install",
  petInstall: "pet:install",
  /* 「复制日志」的稳路：主窗口 preload 上那条写剪贴板的桥（electron clipboard，不过渲染层权限闸）。
     渲染层的 navigator.clipboard 会被 clipboard-write=false 拒掉 —— 用户看到的就是「复制失败」。
     放进这张白名单表 = 安装窗只多了一条**既有**通道的使用权，不新开 IPC 面。 */
  clipboardWriteText: "clipboard:writeText",
};

/**
 * 把一次安装窗调用转发给已注册的 IPC handler。
 * IPC 通道的 handler 都挂在 ipcMain 的 invoke 表里（Electron 39：`_invokeHandlers` 是 Map），
 * 这里直接取表调用，避免自己再造一份「名字 → 函数」的映射（那会与 preload 双头维护）。
 * 取不到就返回 api_not_allowed（宁可失败，也不静默掉一次安装）。
 */
async function invokeChannelFor(channel, args, senderWc) {
  const table = ipcMain && (ipcMain._invokeHandlers || ipcMain._invokeHandlerMap);
  const fn = table && typeof table.get === "function" ? table.get(channel) : null;
  if (typeof fn !== "function") return { ok: false, error: "api_not_allowed", channel };
  const ev = {
    sender: senderWc || null,
    senderFrame: senderWc && senderWc.mainFrame ? senderWc.mainFrame : null,
  };
  return await fn(ev, ...(Array.isArray(args) ? args : []));
}

/** 安装窗点了「交给 mtnode 会话修复」：请主窗口新建一条看得见的会话去修。 */
function requestSessionFix(id) {
  const p = sessionRequestPayload(id);
  if (!p) return { ok: false, error: "no_session" };
  if (!p.installDir) {
    return {
      ok: false,
      error: "no_install_dir",
      message: "还没确定安装目录（没选过目录 / 目录不合法）：先把安装目录选出来，会话才有可写的工作区。",
    };
  }
  const delivered = sendToMain("mtnodeInstall:session", p);
  if (!delivered) {
    return {
      ok: false,
      error: "no_main_window",
      message: "主窗口不可用，无法新建修复会话。请打开 MTNode 主窗口后重试。",
    };
  }
  log("[install] session-fix requested id=" + p.id + " dir=" + p.installDir);
  return { ok: true, payload: p };
}

/* ------------------------------------------------------------------ */
/* 权重指路 → 移动就位（可选能力：只有带权重的大插件有）                    */
/* ------------------------------------------------------------------ */

/**
 * 权重指路的现场：能力 / 目标目录 / 已选源目录 / 正在搬运 / 上次结果。
 * 目标目录一律按「插件 + 安装目录」推导（表在 install-weights.js），不吃用户自选目标 ——
 * 各插件的安装脚本 hardcode 了期望路径，指到别处脚本照样不会用它。
 */
function weightsStateOf(id) {
  const pid = String(id || currentId || "");
  const supported = weights.supports(pid);
  const info = supported ? weights.weightsInfo(pid, installDirOf(pid)) : null;
  return {
    ok: true,
    id: pid,
    supported,
    info,
    label: info ? info.label : "",
    sources: (weightsSel.get(pid) || []).slice(),
    moving: !!(weightsJob && weightsJob.id === pid && !weightsJob.cancelled),
    last: weightsLast.get(pid) || null,
  };
}

/** 「添加目录…」：系统目录选择框（可多选）。取消 = 什么都不做。 */
function pickWeightsSources(id) {
  const pid = String(id || currentId || "");
  if (!weights.supports(pid)) return { ok: false, error: "no_weights_spec", message: "该插件没有权重指路能力。" };
  const cur = weightsSel.get(pid) || [];
  let picked = [];
  try {
    picked = dialog.showOpenDialogSync(installWin && !installWin.isDestroyed() ? installWin : null, {
      title: "选择已手动下载的权重所在目录（可多选；只会把它移动过去，不复制）",
      properties: ["openDirectory", "multiSelections", "dontAddToRecent"],
      defaultPath: cur[0] || undefined,
    }) || [];
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  if (!picked.length) return Object.assign({ cancelled: true }, weightsStateOf(pid));
  const next = cur.slice();
  for (const p of picked) if (!next.includes(p)) next.push(p);
  weightsSel.set(pid, next);
  weightsLast.delete(pid);
  log("[install] weights sources id=" + pid + " n=" + next.length);
  return weightsStateOf(pid);
}

function removeWeightsSource(id, dir) {
  const pid = String(id || currentId || "");
  const d = String(dir || "");
  const next = (weightsSel.get(pid) || []).filter((x) => x !== d);
  weightsSel.set(pid, next);
  weightsLast.delete(pid);
  return weightsStateOf(pid);
}

/** 扫描 + 匹配（只看不搬）：给窗里一份可复核的预览（含每个槽位几个文件 / 多少 GB）。 */
function scanWeights(id) {
  const pid = String(id || currentId || "");
  const plan = weights.planMove({
    pluginId: pid,
    installDir: installDirOf(pid),
    sources: weightsSel.get(pid) || [],
  });
  if (!plan.ok) return plan;
  /* 回给窗里的预览不放全量 moves（几万个文件会撑爆 IPC）：只给计数、体积与前若干条样例 */
  return {
    ok: true,
    id: plan.id,
    label: plan.label,
    installDir: plan.installDir,
    slots: plan.slots,
    total: plan.total,
    unmatched: plan.unmatched.slice(0, 100),
    unmatchedCount: plan.unmatched.length,
    sample: plan.moves.slice(0, 8).map((m) => ({ src: m.src, dst: m.dst })),
  };
}

/**
 * 开始搬运（后台跑，逐文件进度推给安装窗）：
 * 真移动（rename 优先，跨盘复制 + 删除）、同名冲突**用源覆盖**、认不出的留在原地。
 * 跑完只写结论；是否继续安装由用户点「重试」决定（与手动重试口径一致）。
 */
function startWeightsMove(id) {
  const pid = String(id || currentId || "");
  if (!weights.supports(pid)) return { ok: false, error: "no_weights_spec" };
  if (weightsJob && !weightsJob.cancelled) return { ok: false, error: "busy", message: "已有一份权重正在搬运。" };
  const plan = weights.planMove({
    pluginId: pid,
    installDir: installDirOf(pid),
    sources: weightsSel.get(pid) || [],
  });
  if (!plan.ok) return plan;
  if (!plan.moves.length) {
    return { ok: false, error: "nothing_to_move", message: "没认出可搬的权重文件：确认目录里是权重本体（含 config.json / *.safetensors 之类）。" };
  }
  weightsJob = { id: pid, cancelled: false };
  log("[install] weights move begin id=" + pid + " files=" + plan.moves.length);
  const job = weightsJob;
  void (async () => {
    let r = null;
    try {
      r = weights.movePlan(plan, {
        isCancelled: () => job.cancelled,
        onProgress: (p) => {
          if (p.index === 1 || p.index === p.count || p.index % 25 === 0) {
            sendToWin("mtnodeInstall:weights", {
              id: pid,
              kind: "progress",
              index: p.index,
              count: p.count,
              bytesDone: p.bytesDone,
              bytesTotal: p.bytesTotal,
              file: p.file,
            });
          }
        },
      });
    } catch (e) {
      r = { ok: false, error: String((e && e.message) || e), failed: [], moved: 0 };
    }
    const last = {
      at: Date.now(),
      ok: !!r.ok,
      cancelled: !!r.cancelled,
      moved: r.moved || 0,
      failed: (r.failed || []).slice(0, 20),
      failedCount: (r.failed || []).length,
      bytesDone: r.bytesDone || 0,
      bytesTotal: r.bytesTotal || 0,
      bytesText: weights.fmtBytes(r.bytesDone || 0),
      unmatched: (plan.unmatched || []).slice(0, 100),
      unmatchedCount: (plan.unmatched || []).length,
      slots: plan.slots,
      remaining: job.cancelled ? plan.moves.length - (r.moved || 0) : 0,
      note: job.cancelled
        ? "已取消：已搬完的文件留在目标目录（不回搬），再点「移动并就位」会接着搬剩下的。"
        : "权重已就位 —— 点「重试」继续安装（脚本会跳过已在的文件、只补缺的）。",
    };
    weightsLast.set(pid, last);
    weightsJob = null;
    sendToWin("mtnodeInstall:weights", { id: pid, kind: "done", last });
    log(
      "[install] weights move done id=" + pid + " moved=" + last.moved +
        " failed=" + last.failedCount + " cancelled=" + last.cancelled,
    );
  })();
  return { ok: true, started: true, files: plan.moves.length, bytes: plan.total.bytes };
}

function cancelWeightsMove(id) {
  const pid = String(id || currentId || "");
  if (!weightsJob || weightsJob.id !== pid || weightsJob.cancelled) {
    return { ok: false, error: "no_job", message: "没有正在跑的权重搬运。" };
  }
  weightsJob.cancelled = true;
  log("[install] weights move cancel requested id=" + pid);
  return { ok: true, cancelled: true };
}

/* ------------------------------------------------------------------ */
/* 窗                                                                */
/* ------------------------------------------------------------------ */

function installEntry() {
  return path.join(appRoot || path.join(__dirname, ".."), "install", "index.html");
}

function ensureWindow() {
  if (installWin && !installWin.isDestroyed()) return installWin;
  let wa = { x: 0, y: 0, width: 1280, height: 900 };
  try {
    wa = screen.getPrimaryDisplay().workArea;
  } catch {}
  const width = Math.max(760, Math.min(1080, Math.round(wa.width * 0.62)));
  const height = Math.max(560, Math.min(860, Math.round(wa.height * 0.82)));
  installWin = new BrowserWindow({
    width,
    height,
    x: wa.x + Math.max(0, wa.width - width - 60),
    y: wa.y + 40,
    minWidth: 720,
    minHeight: 520,
    frame: true,
    show: true,
    backgroundColor: "#14161c",
    title: "插件安装",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, "install-preload.js"),
    },
  });
  installWin.loadFile(installEntry());
  installWin.on("closed", () => {
    installWin = null;
  });
  return installWin;
}

/**
 * 开窗（卡片「安装 / 重装」、控制台窗内的「安装」、窗口插件与桌宠的下载口都走它）。
 * 另外：任何渲染层（各插件控制台窗）都可以直接 invoke `mtnodeInstall:open`，不必各自抄一遍开窗口。
 */
function openInstallWindow(opts) {
  const o = opts || {};
  const id = String(o.id || "").trim();
  const win = ensureWindow();
  if (!win) return { ok: false, error: "no_window" };
  try {
    win.setTitle("插件安装 · " + ((targetOf(id) && targetOf(id).name) || o.name || id || ""));
  } catch {}
  try {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  } catch {}
  /* 窗一打开就要看得见「这次的完整步骤表」（未跑到的显示待执行）：
     还没有本次会话就先建一份 idle 快照（begin 不覆盖正在跑的那一次）。 */
  let snap = id ? snapshotOf(id) : null;
  if (id && (!snap || (snap.state !== "running" && String(o.action || "") !== "" && snap.action !== o.action))) {
    beginPluginInstall({ id, name: o.name || "", action: o.action || "install", installDir: o.installDir || "" });
    snap = snapshotOf(id);
  }
  currentId = id || currentId;
  /* 窗刚建好时 renderer 还没就绪：它会在首帧主动 state 拉一次；
     这里补一帧，已就绪的窗也能立刻切到目标插件。 */
  if (snap) sendToWin("mtnodeInstall:state", snap);
  else if (id) sendToWin("mtnodeInstall:state", { pluginId: id, empty: true });
  return { ok: true, open: true, session: snap || null };
}

function closeInstallWindow(opts) {
  const o = opts || {};
  try {
    if (installWin && !installWin.isDestroyed()) installWin.close();
  } catch {}
  installWin = null;
  return { ok: true, closed: true, id: String(o.id || currentId || "") };
}

/**
 * 取消安装：转发宿主自己的取消口（宿主里那套进程回收逻辑原样复用，不在窗里重造），
 * 取消口返回后把快照落成终局 state="cancelled" —— 语义是「你主动终止的」，不是安装失败：
 *   · 安装窗标题显示「已取消（你主动终止）」并保留「重试」按钮（重试＝脚本续跑）；
 *   · 卡片的终局广播只送事实（state=cancelled），不弹报错报告窗（用户自己停的不算故障）。
 * 已装完（done）/ 已失败（failed）的会话不再改（重复点取消是幂等的）。
 */
async function cancelInstall(id) {
  const sid = String(id || "").trim();
  const fn = cancels.get(sid) || (cancelFallback ? () => cancelFallback(sid) : null);
  if (!fn) {
    return { ok: false, error: "no_cancel", message: "该插件没有可取消的安装（它不走本窗的安装链）。" };
  }
  try {
    const r = await fn();
    const snap = snapshotOf(sid);
    /* 落取消终局的条件：这次取消**真的打断了一个在跑的进程**（r.noop=false 或正在杀），
       或快照本来就是 running（脚本还没打第一条步骤行就被取消时，快照可能还是 idle —— 那也是
       「打断了」。见 createSnapshot 的 idle 口径）。
       还没开跑就点取消（noop + idle）不改状态：别把一次没开始的安装判死。 */
    const brokeSomething = !!(r && typeof r === "object" && (r.noop === false || r.alreadyCancelling));
    if (snap && (snap.state === "running" || brokeSomething)) {
      steps.finishSnapshot(snap, { ok: false, cancelled: true, error: "cancelled" });
      sendToWin("mtnodeInstall:event", { id: sid, kind: "finish", session: snap });
      notifyMainFinished(snap);
      log("[install] cancel id=" + sid + " tree=" + JSON.stringify((r && r.pid) || 0));
    }
    return Object.assign({ ok: true }, r && typeof r === "object" ? r : {}, {
      state: snap ? snap.state : "",
    });
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* ------------------------------------------------------------------ */
/* IPC                                                                */
/* ------------------------------------------------------------------ */

function initInstallHost(opts) {
  try {
    const o = opts || {};
    getMainWin = typeof o.getMainWin === "function" ? o.getMainWin : getMainWin;
    getDataDir = typeof o.getDataDir === "function" ? o.getDataDir : () => o.getDataDir;
    appRoot = o.appRoot || appRoot || path.join(__dirname, "..");
    logLine = typeof o.log === "function" ? o.log : logLine;
    if (o.registerIpc === false) return { ok: true, ipc: false };
    if (initInstallHost._ipc) return { ok: true, ipc: true };
    initInstallHost._ipc = true;
    /* 控制台窗（各插件自己的 Electron 窗）的「安装」按钮：**零改动接进安装窗** ——
       它们仍在自己的宿主里跑安装，这里只监听宿主在开跑前发的那条「开安装窗」广播。 */
    ipcMain.on("mtnodeInstallWindow:open", (e, payload) => {
      try {
        openInstallWindow(payload && typeof payload === "object" ? payload : {});
      } catch {}
    });
    if (!ipcMain || typeof ipcMain.handle !== "function") return { ok: true, ipc: false };
    ipcMain.handle("mtnodeInstall:open", async (e, payload) => openInstallWindow(payload || {}));
    ipcMain.handle("mtnodeInstall:close", async (e, payload) => closeInstallWindow(payload || {}));
    ipcMain.handle("mtnodeInstall:cancel", async (e, payload) => {
      const p = payload && typeof payload === "object" ? payload : {};
      return cancelInstall(p.id);
    });
    ipcMain.handle("mtnodeInstall:state", async (e, payload) => {
      const p = payload && typeof payload === "object" ? payload : {};
      const id = String(p.id || currentId || "");
      if (!plugins.size) {
        return { ok: true, session: null, sessions: [], registered: [] };
      }
      return {
        ok: true,
        id,
        session: id ? snapshotOf(id) : null,
        sessions: [...sessions.values()].map((s) => ({
          pluginId: s.pluginId,
          name: s.name,
          state: s.state,
          pct: s.pct,
        })),
        registered: [...plugins.keys()],
      };
    });
    ipcMain.handle("mtnodeInstall:fix", async (e, payload) => {
      const p = payload && typeof payload === "object" ? payload : {};
      return requestSessionFix(p.id || currentId);
    });
    ipcMain.handle("mtnodeInstall:openConsole", async (e, payload) => {
      const p = payload && typeof payload === "object" ? payload : {};
      return requestOpenConsole(p.id || currentId);
    });
    /* 权重指路 → 移动就位：{ action: "info"|"pick"|"remove"|"scan"|"move"|"cancel"|"reset", id, dir } */
    ipcMain.handle("mtnodeInstall:weights", async (e, payload) => {
      const p = payload && typeof payload === "object" ? payload : {};
      const id = String(p.id || currentId || "");
      const action = String(p.action || "info");
      if (action === "info") return weightsStateOf(id);
      if (action === "pick") return pickWeightsSources(id);
      if (action === "remove") return removeWeightsSource(id, p.dir);
      if (action === "scan") return scanWeights(id);
      if (action === "move") return startWeightsMove(id);
      if (action === "cancel") return cancelWeightsMove(id);
      if (action === "reset") {
        weightsSel.set(id, []);
        weightsLast.delete(id);
        return weightsStateOf(id);
      }
      return { ok: false, error: "bad_action", message: "安装窗不允许该权重操作：" + action };
    });
    /* 白名单透传：安装窗要用主窗口 preload 上那几个「安装 / 选安装目录」桥。
       只放行 INSTALL_API_CHANNELS 里的名字，别的名字一律拒绝 —— 安装窗没有任意调用
       主进程能力的权限（这些通道本来就在主窗口 preload 里对渲染层开放）。 */
    ipcMain.handle("mtnodeInstall:api", async (e, payload) => {
      const p = payload && typeof payload === "object" ? payload : {};
      const name = String(p.name || "");
      const channel = INSTALL_API_CHANNELS[name];
      if (!channel) {
        return { ok: false, error: "api_not_allowed", message: "安装窗不允许调用该接口：" + name };
      }
      const mainWc = (() => {
        try {
          const w = getMainWin && getMainWin();
          return w && !w.isDestroyed() ? w.webContents : null;
        } catch {
          return null;
        }
      })();
      try {
        return await invokeChannelFor(channel, p.args, mainWc);
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
    });
    ipcMain.handle("mtnodeInstall:markReady", async () => {
      mainReady = true;
      return { ok: true };
    });
    return { ok: true, ipc: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 测试 / 冒烟用：把内存状态读出来（不落盘，没有别的方式窥视）。 */
function debugState() {
  return {
    currentId,
    mainReady,
    plugins: [...plugins.keys()],
    sessions: [...sessions.entries()].map(([id, s]) => ({ id, state: s.state, steps: s.steps.length })),
    weights: {
      supported: [...plugins.keys()].filter((id) => weights.supports(id)),
      sel: [...weightsSel.entries()].map(([id, dirs]) => ({ id, dirs: dirs.slice() })),
      last: [...weightsLast.entries()].map(([id, r]) => ({ id, ok: r.ok, moved: r.moved })),
      job: weightsJob ? { id: weightsJob.id, cancelled: weightsJob.cancelled } : null,
    },
  };
}

module.exports = {
  initInstallHost,
  registerInstallTarget,
  registerCancelFallback,
  beginPluginInstall,
  reportPluginStep,
  finishPluginInstall,
  failStep,
  openInstallWindow,
  closeInstallWindow,
  cancelInstall,
  requestSessionFix,
  requestOpenConsole,
  sessionRequestPayload,
  snapshotOf,
  readManifest,
  /* 权重指路 → 移动就位（安装窗专用；冒烟直接调这几个纯主进程函数） */
  weightsStateOf,
  pickWeightsSources,
  removeWeightsSource,
  scanWeights,
  startWeightsMove,
  cancelWeightsMove,
  debugState,
};
