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
 *   invoke `mtnodeInstall:ensureDir` { id }                                    → 安装开始时把「根目录 + 默认子目录名」建出来并落到该插件配置（本轮需求）
 *   invoke `mtnodeInstall:uninstall` { action:"preview"|"run"|"cancel", id }    → 卸载预览 / 真删（先停后端）/ 停手
 *   send   `mtnodeInstall:session` { id, installDir, skill, name, action, code, message, hint, log } → 主窗口
 *   send   `mtnodeInstall:state`   (session)  → 安装窗（快照）
 *   send   `mtnodeInstall:event`   ({ id, kind, … }) → 安装窗（步骤 / 日志 / 终结）
 */
const path = require("path");
const fs = require("fs");
const { BrowserWindow, ipcMain, screen, dialog } = require("electron");
const steps = require("./install-steps.js");
const weights = require("./install-weights.js");
/* 安装后自检的内核（本轮需求）：注册表 / 结果落盘 / 等锁队列都在那里；本模块只做窗口侧编排
   —— 本模块有「不落盘」的硬纪律（test/smoke-install-window.js），所以自检结果的读写一律在那边。 */
const selfcheck = require("./plugin-selfcheck.js");
/* plugin-root 的纯函数（normDir）：卸载守卫要把用户给的目录归一后再判危险目录 */
const { normDir: rootNormDir } = require("./plugin-root.js");

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
/** 正在跑的卸载作业（同一时刻只允许一个）：{ id, done, cancelled }。 */
let uninstallJob = null;
/** 卸载的步骤 id 与兜底步骤表（自定义路由的插件也用它，安装窗里就是一行「卸载并清理文件」）。 */
const UNINSTALL_STEP_ID = "uninstall";
const UNINSTALL_STEPS = [
  {
    id: UNINSTALL_STEP_ID,
    title: "卸载并清理文件",
    hint: "删不掉多为文件被占用：关掉该插件的后端 / 控制台 / 资源管理器里打开的那个目录后重试。",
  },
];

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
    /* 子目录名走 mod.subDir（显式表 + 「有自己配置的插件」推导，见 plugins/plugin-root.js）——
       别在这里写 subDirNameOf：那条老路径认不出云端 / 遗留插件，会把它当窗口插件回空串。 */
    if (mod && mod.needsDir(sid)) return mod.defaultDir(sid, mod.subDir(sid)) || "";
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
/**
 * 数据目录（插件根目录的真源就在它下面的 config.json）。
 * 防御：注入进来的取目录函数**又返回一个函数**时（main.js 曾经写成 `getDataDir: () => DATA`，
 * 而 DATA 自己就是取目录的函数）也照样取到真目录 —— 否则这里会拿到那个函数的源码字符串，
 * 于是插件根目录一律读成「没设」，安装时宿主报一句用户看不懂的 empty_dir（本轮真事故）。
 * 非绝对路径一律记一行并当**不可用**处理：宁可当场说清，也不把空目录一路传下去。
 */
function dataDirOf() {
  try {
    let v = typeof getDataDir === "function" ? getDataDir() : "";
    if (typeof v === "function") v = v();
    return String(v || "");
  } catch {
    return "";
  }
}
/** 数据目录可用吗：空的放行（老行为不变 —— 由调用方决定怎么报），非空但**不是绝对路径** = 不可用。 */
function dataDirUsable(d) {
  const s = String(d || "");
  if (!s) return true;
  try {
    return path.isAbsolute(s);
  } catch {
    return false;
  }
}

function appDirsOf() {
  const out = [];
  try {
    const root = String(appRoot || "");
    /* 只把**应用目录本身**算危险区。这里**不**连带父级：appRoot = app.getAppPath()，
       开发态就是项目根，把项目根的父级（整个开发盘）一并拒掉会让守卫本身变成误伤
       （正常安装目录常在项目同一块盘上，比如 E:\mtnode-plugins）。 */
    if (root) out.push(root);
  } catch {}
  return out.filter(Boolean);
}

/**
 * 「这次安装真正要落到哪个目录」——并在**安装开始时把它建出来**（本轮需求）。
 *
 * 为什么必须有这一步：7 个后端宿主的安装函数只读**自己配置里的 installDir**（空串 =
 * isSafeInstallDir 回 empty_dir，安装根本起不来）。用户设过插件根目录之后，目录其实
 * 早就算得出来（根目录 + 默认子目录名，见 plugins/plugin-root.js），但从没人把它建出来、
 * 也没人写回插件自己的配置 —— 用户只能去安装窗点「选择安装目录」，再在系统框里手建一个。
 * 这里把这一步补上：口径全在 plugin-root.js 的 ensureDir 里（插件自己设过目录 → 原样返回；
 * 需目录的插件 → mkdir -p + 写回 installDir；窗口插件 / 桌宠 → 不建不写），本函数只负责
 * 「调它 + 把结果同步进快照 + 记一行日志」。
 *
 * 只在安装路径上调（安装窗的「开始安装 / 重试」）：只读入口（installDirOf / status）不许建目录。
 *
 * 回执比 plugin-root 多带一层语义给安装窗用：needs = 「这个插件本该有安装目录」。
 * 安装窗据此判「回执说成功、却没给出目录」= 真故障（如实报错），
 * 而不是继续往下走、让宿主报一句 empty_dir（本轮共识）。
 */
function ensureInstallDirFor(id) {
  const sid = String(id || "").trim();
  if (!sid) return { ok: false, error: "bad_id", dir: "", source: "", created: false, wrote: false };
  /* 数据目录不可用（不是绝对路径：注入的取目录函数被多包了一层之类）时当场说清，
     别让它退化成一个读不到的 config.json → 插件根目录读成「没设」→ 宿主报 empty_dir。 */
  const dd = dataDirOf();
  if (!dataDirUsable(dd)) {
    log("[install] ensure dir 中止：数据目录不可用 id=" + sid + " dataDir=" + dd);
    return {
      ok: false,
      error: "bad_data_dir",
      dir: "",
      source: "root",
      created: false,
      wrote: false,
      needs: true,
      cfgPath: "",
      message: "数据目录不可用（" + dd + "）：插件根目录读不出来，请重启应用后再试。",
    };
  }
  const mod = getPluginRootMod();
  if (!mod || typeof mod.ensureDir !== "function") {
    /* 真源取不到（老行为不变）：不建也不写，宿主自己会照旧报「安装目录不合法」 */
    return { ok: true, dir: "", source: "no_module", created: false, wrote: false, needs: false, cfgPath: "" };
  }
  let r = null;
  try {
    r = mod.ensureDir(sid);
  } catch (e) {
    return {
      ok: false,
      error: "ensure_failed",
      dir: "",
      source: "root",
      created: false,
      wrote: false,
      message: String((e && e.message) || e),
    };
  }
  /* 快照里的安装目录跟着刷新：安装窗顶部那一行与后续宿主上报看的是同一份现场 */
  try {
    const snap = sessions.get(sid);
    if (r && r.ok && r.dir && snap) snap.installDir = String(r.dir);
  } catch {}
  if (r && r.ok && r.dir) {
    log(
      "[install] ensure dir id=" +
        sid +
        " dir=" +
        r.dir +
        " created=" +
        !!r.created +
        " cfg=" +
        String(r.cfgPath || ""),
    );
  } else if (r && !r.ok) {
    log("[install] ensure dir failed id=" + sid + " err=" + String(r.error || "") + " " + String(r.message || ""));
  }
  return r;
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
  /* 卸载这一次走的是同一只窗、同一份快照模型：mode 让窗认出「这是卸载，不是安装」
     （按钮文案 / 「重试」该调哪条桥都由它决定）。安装场景不写这个字段，老口径不变。 */
  if (String(o.action || "") === "uninstall") snap.mode = "uninstall";
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
    if (e.kind === "selfcheck") {
      /* 安装后自检（本轮需求）：宿主 / 自检内核推来的进度与结论，原样转给安装窗。
         契约见 plugins/plugin-selfcheck.js 头部 —— 只有 { state, ... }，不在这里解释业务。 */
      sendToWin("mtnodeInstall:event", {
        id,
        kind: "selfcheck",
        state: String(e.state || ""),
        note: String(e.note || ""),
        queued: !!e.queued,
        step: e.step || null,
        log: e.log == null ? "" : String(e.log),
        result: e.result || null,
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
  /* 自检产物路径点一下就定位到文件（本轮需求：结果区给「可点开的路径」）。
     与剪贴板那条同理：只是让安装窗多一条**既有**通道的使用权，不新开 IPC 面。 */
  shellShowItem: "shell:showItem",
};

/**
 * 安装通道（"yue:install" 这类后端安装桥）→ 该插件登记进本模块的 id。
 * 用**登记表反查**（宿主注册时的 key = 通道前缀），别在别处再抄一份 id 表；
 * 窗口插件 / 桌宠 / 不在表里的通道 → 空串（不参与「先落目录」这道双保险）。
 */
function installPluginIdOfChannel(channel) {
  const m = /^([a-z0-9_-]+):install$/i.exec(String(channel || ""));
  if (!m) return "";
  const key = m[1].toLowerCase();
  for (const [id, t] of plugins.entries()) {
    if (!t) continue;
    if (String(t.key || "").toLowerCase() === key || String(id).toLowerCase() === key) return String(id);
  }
  return "";
}

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
/* 卸载（安装窗内那一颗「卸载」）                                        */
/* ------------------------------------------------------------------ */

/**
 * 卸载路由表（**主进程唯一一份**：安装窗只说「卸载这个插件」，删什么由这里决定）。
 *   id       → 安装窗给出的插件 id（后端 / 桌宠 id、窗口插件的目录名）
 *   label    → 预览标题里的中文名（认不出时用登记的 name / id）
 *   stop     → 卸载前先停后端（本地后端各自那条 `<kind>:stop`；没有常驻后端的插件不写）
 *   custom   → 该插件自己的卸载口（{ preview, run } 两条 IPC 通道名）：
 *              有了就交给它（它更懂自己的产物，如 Music3 / H3 的 output 保留口径、桌宠的自启登记）；
 *              没有就走通用口径 —— 删它自己的安装目录。
 *   keepHint → 明确不会删的东西（写进预览，别让用户以为「卸载 = 全清」）。
 */
const UNINSTALL_SPECS = {
  "llama-local": { label: "llama.cpp 本地模型", stop: "llama:stop", keepHint: "你下载的 GGUF 模型文件按你自己的选择保留（模型列表在控制台里维护）。" },
  /* GPT-SoVITS 插件已随本版移除、没有安装入口了：这条留给**已装机器**当卸载出口
     （`stop` 那条 IPC 已随宿主删掉，所以这里不再写 stop；删安装目录这条通用口径照跑）。
     安装目录靠 plugins/plugin-root.js 的 PLUGIN_CFG（tts/config.json）认路。 */
  "tts-local": { label: "GPT-SoVITS 语音合成" },
  "breeze-tts-local": { label: "Breeze TTS 2 本地 TTS", stop: "breeze:stop" },
  "sensenova-local": { label: "SenseNova 本地图像生成", stop: "sensenova:stop" },
  "yue2-local": { label: "YuE2 本地音乐", stop: "yue:stop" },
  "minimax-music3": { label: "MiniMax Music 3", stop: "music3:stop", custom: { preview: "music3:uninstallPreview", run: "music3:uninstall" }, keepHint: "output/ 里的音频输出保留。" },
  "minimax-h3": { label: "MiniMax H3 视频生成", stop: "h3:stop", custom: { preview: "h3:uninstallPreview", run: "h3:uninstall" }, keepHint: "output/ 里的渲染产物保留。" },
  remotion: { label: "Remotion 动效视频" },
  pet: { label: "桌宠", custom: { preview: "", run: "pet:uninstall" }, keepHint: "桌面上的桌宠窗口会先关掉。" },
  bongochat: { label: "桌宠", custom: { preview: "", run: "pet:uninstall" }, keepHint: "桌面上的桌宠窗口会先关掉。" },
};
/** 窗口类插件（kind=window）：删之前先把它那只窗关掉 —— 走它自己的卸载口，不裸删目录。
 *  注意 `appPlugins:uninstall` 的签名收的是**插件 id 字符串**（传对象会被 String() 成
 *  "[object Object]" → bad_id，与 `appPlugins:install` 同一个坑），所以标 idArgs 让它只收 id。 */
const WINDOW_PLUGIN_UNINSTALL = {
  custom: { preview: "", run: "appPlugins:uninstall", idArgs: true },
  keepHint: "它在插件界面上的入口与缓存一并移除。",
};
/** 后端短名（卡片 kind）→ 安装窗用的插件 id（与 renderer/app-plugins.js 的 BACKEND_INSTALL_IDS 同源）。 */
const BACKEND_ID_ALIASES = {
  music3: "minimax-music3",
  yue: "yue2-local",
  yue2: "yue2-local",
  sensenova: "sensenova-local",
  h3: "minimax-h3",
  llama: "llama-local",
  tts: "tts-local",
  breeze: "breeze-tts-local",
  remotion: "remotion",
};

/** 认得出是不是「需目录的本地后端插件」（认不出 = 窗口插件 / 未知 id）。 */
function isBackendPluginId(id) {
  const sid = String(id || "");
  const mod = getPluginRootMod();
  return !!(mod && mod.needsDir(sid)) || !!UNINSTALL_SPECS[sid] || !!BACKEND_ID_ALIASES[sid];
}

function uninstallSpecOf(id) {
  const sid = String(id || "");
  if (UNINSTALL_SPECS[sid]) return UNINSTALL_SPECS[sid];
  const alias = BACKEND_ID_ALIASES[sid];
  if (alias && UNINSTALL_SPECS[alias]) return UNINSTALL_SPECS[alias];
  const t = targetOf(sid);
  /* 窗口类插件的 id 来自云端目录（装之前不知道有哪些），所以不逐个进表：
     认不出、但取得到它自己的安装目录，就按窗口插件那条走（它自己的卸载口先关窗再删）。 */
  if (!isBackendPluginId(sid) && installDirForUninstall(sid)) {
    return Object.assign({ label: (t && t.name) || sid }, WINDOW_PLUGIN_UNINSTALL);
  }
  /* 认不出、也没有目录：不给卸载入口（宁可没有，也不猜着删） */
  return null;
}

/** 该插件当前的安装目录（宿主自己的口径优先，其次插件配置里设过的那个）。
 *  **不在这里推默认值**：插件根目录 + 子目录名只是「没设过时该装到哪」，那个目录还没装过东西 ——
 *  把它当卸载目标会去删一个可能装了别的东西的目录（卸载只删「这个插件真正的安装目录」）。 */
function installDirForUninstall(id) {
  const sid = String(id || "");
  const t = targetOf(sid);
  const own = t && typeof t.getInstallDir === "function" ? String(t.getInstallDir() || "") : "";
  if (own) return own;
  const mod = getPluginRootMod();
  if (mod) {
    const cfg = mod.pluginDir(sid);
    if (cfg) return cfg;
  }
  return "";
}

/** 目录是否真的存在（卸载守卫与预览都用它；statSync 失败一律当不存在）。 */
function existsDir(p) {
  try {
    return !!p && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 目录归一：plugin-root 的 normDir 只挂在模块导出上（实例上没有），所以这里直接用模块级那份。 */
function normalizeDir(dir) {
  try {
    return rootNormDir(dir) || String(dir || "");
  } catch {
    return String(dir || "");
  }
}

/** 卸载安全守卫：空目录 / 盘根 / 应用目录 / 数据目录 / 插件根目录本身一律拒删；
 *  目录不存在也拒（不装作「删过了」）。过了这一关才允许删。 */
function uninstallGuard(id, dir) {
  const mod = getPluginRootMod();
  const n = normalizeDir(dir);
  if (!n) return { ok: false, error: "no_install_dir", message: "取不到该插件的安装目录，无法卸载。" };
  if (mod) {
    const bad = mod.rejectReason(n);
    if (bad) {
      return {
        ok: false,
        error: bad,
        message:
          bad === "refuse_root"
            ? "安装目录落在盘根上，拒绝卸载（太危险）。"
            : "安装目录落在应用目录 / 数据目录里，拒绝卸载。",
      };
    }
    const root = normalizeDir(mod.get());
    if (root && root === n) {
      return { ok: false, error: "refuse_plugin_root", message: "安装目录就是「插件根目录」本身：拒绝卸载整个根目录。" };
    }
  }
  if (!existsDir(n)) return { ok: false, error: "not_installed", message: "该插件的安装目录不存在（可能已经卸载过）。" };
  return { ok: true, dir: n };
}

function fmtGB(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024 * 1024) return Math.max(0, Math.round(n / 1024)) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
  return (n / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

function dirSizeSync(dir) {  let total = 0;
  let stack = [String(dir || "")];
  while (stack.length) {
    const cur = stack.pop();
    let list = [];
    try {
      list = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of list) {
      const p = path.join(cur, e.name);
      try {
        if (e.isDirectory() && !e.isSymbolicLink()) stack.push(p);
        else total += fs.statSync(p).size || 0;
      } catch {}
    }
  }
  return total;
}

/** 目录里的头几项（预览用：别把几万个文件全列出来）。 */
function topEntriesSync(dir, limit) {
  const out = [];
  let list = [];
  try {
    list = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  const max = Math.max(1, Number(limit) || 20);
  for (const e of list) {
    if (out.length >= max) break;
    const p = path.join(dir, e.name);
    let note = e.isDirectory() ? "目录" : "文件";
    try {
      note = e.isDirectory() ? "目录" : fmtGB(fs.statSync(p).size);
    } catch {}
    out.push({ name: e.name, path: p, note });
  }
  return out;
}

/**
 * 卸载预览：这一趟会删掉什么、保留什么。
 * 只读，不动盘。custom 路由的插件先问它自己的预览口（拿不到就退回「删安装目录」这一句）。
 */
async function uninstallPreviewFor(id) {
  const sid = String(id || "");
  const spec = uninstallSpecOf(sid);
  if (!spec) {
    return { ok: false, error: "unknown_plugin", message: "认不出这个插件，无法卸载。" };
  }
  const label = String(spec.label || (targetOf(sid) && targetOf(sid).name) || sid);
  if (spec.custom && spec.custom.preview) {
    const r = await invokeChannelFor(spec.custom.preview, [], mainWebContents());
    if (r && r.ok) {
      return {
        ok: true,
        id: sid,
        label,
        route: "custom",
        installDir: String(r.installDir || installDirForUninstall(sid) || ""),
        targets: Array.isArray(r.targets) ? r.targets : [],
        note: String(r.note || ""),
        keepHint: String(spec.keepHint || ""),
      };
    }
    return {
      ok: false,
      error: (r && (r.error || r.message)) || "preview_failed",
      message: "取不到该插件的卸载清单：" + ((r && (r.error || r.message)) || "未知错误"),
    };
  }
  if (spec.custom && spec.custom.run) {
    /* 有卸载口但没预览口（桌宠 / 窗口类插件）：说清「会删什么」。顺手用守卫把它自己的安装目录
       也过一遍 —— 目录在就列进清单（用户看得见删的是哪儿），不在就当场说要重装（别等确认完才报错）。 */
    const g = uninstallGuard(sid, installDirForUninstall(sid));
    return {
      ok: true,
      id: sid,
      label,
      route: "custom",
      installDir: g.ok ? g.dir : installDirForUninstall(sid),
      targets: g.ok ? [{ path: g.dir, rel: "", note: "该插件自己的运行时文件（由它自己的卸载实现删除）" }] : [],
      note: g.ok
        ? "删除范围由该插件自己的卸载实现决定（先关掉它的窗口 / 进程再删）。"
        : "卸载该插件自己管理的运行时文件。",
      keepHint: String(spec.keepHint || ""),
      warning: g.ok ? "" : String(g.message || ""),
    };
  }
  const g = uninstallGuard(sid, installDirForUninstall(sid));
  if (!g.ok) return Object.assign({ ok: false, id: sid, label }, g);
  const items = topEntriesSync(g.dir, 20);
  return {
    ok: true,
    id: sid,
    label,
    route: "root",
    installDir: g.dir,
    targets: [{ path: g.dir, rel: "", note: "整个安装目录（含虚拟环境 / 模型 / 脚手架）" }],
    items,
    note: "只删这一个插件的安装目录；插件自己的目录设置保留，重装时会再装回同一处。",
    keepHint: String(spec.keepHint || (items.length >= 20 ? "目录里还有更多条目（未逐一列出）。" : "")),
  };
}

/** 通用卸载现场（异步跑，进度与日志边跑边推给安装窗）。 */
function startUninstall(id) {
  const sid = String(id || "");
  const spec = uninstallSpecOf(sid);
  if (!spec) return { ok: false, error: "unknown_plugin", message: "认不出这个插件，无法卸载。" };
  if (uninstallJob && !uninstallJob.done) {
    return { ok: false, error: "busy", message: "已经有一次卸载在跑，等它结束再试。" };
  }
  const useCustom = !!(spec.custom && spec.custom.run);
  let dir = "";
  if (!useCustom) {
    const g = uninstallGuard(sid, installDirForUninstall(sid));
    if (!g.ok) return g;
    dir = g.dir;
  }
  const snap = beginPluginInstall({ id: sid, action: "uninstall", installDir: dir, steps: UNINSTALL_STEPS });
  uninstallJob = { id: sid, done: false, cancelled: false };
  const job = uninstallJob;
  log("[install] uninstall begin id=" + sid + " dir=" + dir + " route=" + (useCustom ? "custom" : "root"));
  void (async () => {
    const emit = (ev) => reportPluginStep(Object.assign({ pluginId: sid }, ev));
    const line = (text) => emit({ kind: "log", stepId: UNINSTALL_STEP_ID, line: text });
    const fail = (error, message, hint) => {
      job.done = true;
      line("✕ " + message);
      emit({ kind: "finish", ok: false, error: error, hint: hint || "" });
    };
    try {
      emit({ kind: "step", step: { id: UNINSTALL_STEP_ID, title: "卸载并清理文件", status: "run" } });
      /* ① 停后端：让后端自己回收进程树（DLL / EXE 被占用时文件删不掉） */
      if (spec.stop) {
        line("停止后端（" + spec.stop + "）…");
        try {
          await invokeChannelFor(spec.stop, [], mainWebContents());
          line("后端已停止。");
        } catch (e) {
          line("停止后端时出错（继续卸载）：" + String((e && e.message) || e));
        }
      }
      /* ② 删除 */
      if (useCustom) {
        const args = spec.custom.idArgs ? [sid] : [{ confirm: true, action: "uninstall" }];
        const r = await invokeChannelFor(spec.custom.run, args, mainWebContents());
        if (!r || !r.ok) {
          return fail((r && (r.error || r.message)) || "uninstall_failed", "卸载失败：" + ((r && (r.error || r.message)) || "未知错误"));
        }
        if (Array.isArray(r.errors) && r.errors.length) {
          line("有 " + r.errors.length + " 项没能删除（多被占用）：");
          for (const e of r.errors.slice(0, 8)) line("  " + String((e && e.path) || "") + " :: " + String((e && e.error) || ""));
          return fail("uninstall_partial", "卸载未完成：" + r.errors.length + " 项没能删除（后端可能还在占用）。");
        }
        line("已删除 " + ((r.deleted || []).length || 0) + " 项。");
      } else {
        let total = 0;
        const sub = topEntriesSync(dir, 200);
        line("删除安装目录：" + dir + (sub.length ? "（" + sub.length + " 个条目）" : ""));
        for (const e of sub) {
          if (job.cancelled) {
            job.done = true;
            return emit({ kind: "finish", ok: false, error: "cancelled", hint: "" });
          }
          const bytes = dirSizeSync(e.path);
          try {
            fs.rmSync(e.path, { recursive: true, force: true, maxRetries: 3 });
            total += bytes;
            line("已删除 " + e.name + (bytes ? "（" + fmtGB(bytes) + "）" : ""));
          } catch (err) {
            return fail("uninstall_locked", "删不掉 " + e.path + "：" + String((err && err.message) || err), "关掉占用该目录的后端 / 编辑器后重试一次。");
          }
        }
        /* 剩下的（隐藏文件 / 空壳）一并清掉，然后目录本身 */
        try {
          fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
        } catch (err) {
          return fail("uninstall_locked", "删不掉 " + dir + "：" + String((err && err.message) || err));
        }
        line("已释放约 " + fmtGB(total) + "。");
      }
      /* ③ 收口：快照的安装目录清空（它已经不存在了） */
      if (snap) snap.installDir = "";
      /* ④ 自检结果与产物一并清掉（用户共识：卸载后勾与结果一起失效） */
      try {
        selfcheck.dropCheck(sid);
      } catch {}
      job.done = true;
      emit({ kind: "step", step: { id: UNINSTALL_STEP_ID, title: "卸载并清理文件", status: "ok", pct: 100 } });
      emit({ kind: "finish", ok: true });
      log("[install] uninstall done id=" + sid);
    } catch (e) {
      job.done = true;
      fail("uninstall_error", "卸载出错：" + String((e && e.message) || e));
    }
  })();
  return { ok: true, started: true, id: sid, installDir: dir, route: useCustom ? "custom" : "root" };
}

function mainWebContents() {
  try {
    const w = getMainWin && getMainWin();
    return w && !w.isDestroyed() ? w.webContents : null;
  } catch {
    return null;
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
    /* 自检内核接线（本轮需求）：数据目录 / 各插件安装目录 / 推给安装窗的事件口 / 日志。
       放在这里而不是启动路径上：数据目录只有到这一步才确定（DATA 取目录函数）。 */
    try {
      selfcheck.initPluginSelfcheck({
        getDataDir: () => dataDirOf(),
        getInstallDirOf: (id) => installDirOf(id),
        pushEvent: (ev) => reportPluginStep(Object.assign({ pluginId: (ev && ev.id) || "" }, ev || {})),
        log: (line) => log(line),
      });
    } catch (e) {
      log("[install] selfcheck init failed: " + ((e && e.message) || e));
    }
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
    /* 安装开始时把「插件根目录 + 默认子目录名」落地（本轮需求）：见 ensureInstallDirFor。
       安装窗在调安装桥**之前**问一次；窗口插件 / 桌宠不受影响（回 dir:"" 的老口径）。 */
    ipcMain.handle("mtnodeInstall:ensureDir", async (e, payload) => {
      const p = payload && typeof payload === "object" ? payload : {};
      return ensureInstallDirFor(String(p.id || currentId || ""));
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
    /* 卸载（安装窗里那一颗「卸载」）：{ action: "preview"|"run", id }
       preview 只读地给出「删什么 / 留什么」；run 才真删（先停后端）。 */
    ipcMain.handle("mtnodeInstall:uninstall", async (e, payload) => {
      const p = payload && typeof payload === "object" ? payload : {};
      const id = String(p.id || currentId || "");
      const action = String(p.action || "preview");
      if (action === "preview") return await uninstallPreviewFor(id);
      if (action === "run") return startUninstall(id);
      if (action === "cancel") {
        if (uninstallJob && !uninstallJob.done) uninstallJob.cancelled = true;
        return { ok: true };
      }
      return { ok: false, error: "bad_action", message: "安装窗不允许该卸载操作：" + action };
    });
    /* 安装后自检（本轮需求）：{ action: "info"|"state"|"run"|"cancel"|"clean", id, reason }
       编排（谁来跑、结果落哪、等锁排队）全在 plugins/plugin-selfcheck.js —— 本模块只转手，
       自己不落盘、不解释业务（本模块有「不落盘」的硬纪律，见 test/smoke-install-window.js）。 */
    ipcMain.handle("mtnodeInstall:selfcheck", async (e, payload) => {
      const p = payload && typeof payload === "object" ? payload : {};
      const id = String(p.id || currentId || "");
      const action = String(p.action || "state");
      if (!id) return { ok: false, error: "bad_id" };
      if (action === "state") return selfcheck.stateOf(id);
      if (action === "run") return selfcheck.runCheck(id, { reason: String(p.reason || "manual"), installDir: String(p.installDir || "") });
      if (action === "cancel") return selfcheck.cancelCheck(id);
      if (action === "clean") return selfcheck.cleanArtifacts(id);
      return { ok: false, error: "bad_action", message: "安装窗不允许该自检操作：" + action };
    });
    /* 白名单透传：安装窗要用主窗口 preload 上那几个「安装 / 选安装目录」桥。       只放行 INSTALL_API_CHANNELS 里的名字，别的名字一律拒绝 —— 安装窗没有任意调用
       主进程能力的权限（这些通道本来就在主窗口 preload 里对渲染层开放）。 */
    ipcMain.handle("mtnodeInstall:api", async (e, payload) => {
      const p = payload && typeof payload === "object" ? payload : {};
      const name = String(p.name || "");
      const channel = INSTALL_API_CHANNELS[name];
      if (!channel) {
        return { ok: false, error: "api_not_allowed", message: "安装窗不允许调用该接口：" + name };
      }
      /* 后端安装桥：转发前先在主进程把「插件根目录 + 默认子目录名」落地 ——
         与安装窗里那一拍（mtnodeInstall:ensureDir）**同源的双保险**。安装窗那一步被跳过、
         或它问到的口径与宿主不一致时，这里也绝不把「目录为空」往下传，让用户只看到一句
         宿主报的 empty_dir（本轮真事故的出口）。窗口插件 / 桌宠不在表里，老口径不变。 */
      const preflightId = installPluginIdOfChannel(channel);
      if (preflightId) {
        const ens = ensureInstallDirFor(preflightId);
        if (ens && ens.needs && !ens.dir) {
          return {
            ok: false,
            error: ens.error || "no_install_dir",
            message:
              ens.message ||
              "取不到这个插件的安装目录：先在插件界面顶部设好插件根目录，或用「选择安装目录」手动选一处。",
          };
        }
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
    uninstall: uninstallJob ? { id: uninstallJob.id, done: uninstallJob.done, cancelled: uninstallJob.cancelled } : null,
    /* 安装后自检（本轮需求）：给冒烟与诊断看的现场 —— 登记了哪些插件、每个的最近一次结论 */
    selfcheck: selfcheck.selfcheckSummary(),
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
  /* 该插件这次的安装目录（自检内核要它判「都装好了没」；同一条口径，别再抄一份） */
  installDirOf,
  snapshotOf,
  readManifest,
  /* 权重指路 → 移动就位（安装窗专用；冒烟直接调这几个纯主进程函数） */
  weightsStateOf,  pickWeightsSources,
  removeWeightsSource,
  scanWeights,
  startWeightsMove,
  cancelWeightsMove,
  /* 卸载（安装窗内那一颗「卸载」；冒烟直接调纯主进程函数） */
  uninstallPreviewFor,
  startUninstall,
  uninstallGuard,
  uninstallSpecOf,
  installDirForUninstall,
  isBackendPluginId,
  UNINSTALL_SPECS,
  debugState,
};
