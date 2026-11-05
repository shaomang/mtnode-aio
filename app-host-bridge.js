"use strict";

/* ── appHost · 画布 / agent / 文件 / 语音 / 工具 / 联网（主进程中继）──────────────────
 *
 * 为什么需要这一层：画布真源与 agent 会话运行态**只活在主窗口渲染层**
 * （renderer/app.js 的 S.wf、app-assist.js 的 S.agentSessions），而应用中心窗口
 * （preload-app.js）与插件窗口（plugins/preload-window.js）是两份**独立 BrowserWindow**，
 * 页面也不属于 MTNode 渲染层。所以能力只能这样走：
 *
 *   应用窗口 / 插件窗口 ──invoke──▶ 本模块（认发送方窗口、认能力位、认授权）
 *        ──webContents.send('appHost:event')──▶ 主窗口渲染层（renderer/app-apphost-bridge.js）
 *        ◀──window.api.appHostReply(frame)──  回执（本模块 settle）
 *
 * 三条纪律：
 *   1) **逐类白名单**（NS_METHODS）：绝不代理整个 window.api，应用只能调到列出的方法；
 *   2) **画布绑定不是「当前打开的那张」**：应用默认用自己的那张画布（id = 应用 id），
 *      没有才让用户选；插件窗口没有绑定概念，用当前画布。目标画布没打开时由渲染层
 *      后台加载（runAgainstWf，不动用户视图）；
 *   3) **主窗口不在线就回结构化 not_ready**：不装成功、不把调用挂死。
 *
 * 授权（本轮共识）：应用要在 app.json 的 capabilities 里声明 canvasHost / agentHost；
 * 声明 ≠ 放行 —— 首次调用弹一次窗，一次授权该应用的全部重能力（画布 / agent / fs / audio / tools / net），
 * 记录在 <数据目录>/apps-host.json（grants）。关掉能力位 = 撤销授权（见 apps-store.js）。
 *
 * 状态文件：<数据目录>/apps-host.json
 *   { v:1, grants:{ "app:<id>": {at,name} }, bindings:{ "app:<id>": {canvasId, sessionId} } }
 * ─────────────────────────────────────────────────────────────────────── */

const fs = require("fs");
const path = require("path");
const { readJson, writeJson } = require("./config-providers.js");
/* 联网取素材的实现（主进程 fetch：无跨域限制、不受应用页 CSP 约束） */
const netFetchMod = require("./net-download.js");
/* 图片白名单只留一份：与 iframe 那条媒体路由（音视频 + 图片同一条）共用 */
const { IMAGE_MIME } = require("./preview-media.js");

/* 单次调用的等待上限（与 MCP 同口径：画布整图跑 / 长会话都不会被这条误杀） */
const CALL_TIMEOUT_MS = 15 * 60 * 1000;
/* 用户选画布 / 点授权窗的等待上限：人在屏幕上，给足时间，但绝不永久挂着 */
const USER_TIMEOUT_MS = 5 * 60 * 1000;
/* 画布信息缓存（fs 的操作根要读它，别每个文件操作都回渲染层问一次） */
const CANVAS_TTL_MS = 5000;
/* 文件读写上限（与 appnode:fs 同一口径） */
const FILE_MAX_BYTES = 8 * 1024 * 1024;
/* 应用页面能自己显示哪些图（fs.imageDataUrl 的扩展名白名单，真源在 preview-media.js）：
   应用窗口的 <img> 只吃 'self' / data: / blob: 三种源，磁盘上的图（file://）在 iframe 里被 CSP 挡、
   在独立窗口里也读不到，所以由宿主把字节读出来转成 dataURL。只读、只认图片扩展名、
   超过 FILE_MAX_BYTES 就拒。 */

/* 逐类白名单：命名空间 → 允许的方法。多一个都不给（与 app-appnode.js 的那张表同源） */
const NS_METHODS = {
  /* 素材库（assets-store.js · assetActorCall）：应用可以列 / 读全库，但只能改删
     自己创建的内容（归属校验在库里判，越权回 forbidden）。
     用户的库级动作（换根目录 / 备份 / 改别人素材）一律不在这张表里。 */
  assets: [
    "root",
    "scan",
    "mkdir",
    "create",
    "addItem",
    "importFile",
    "importFiles",
    "readItem",
    "updateText",
    "updateMeta",
    "removeItem",
    "deleteAsset",
  ],
  canvas: [
    "graph",
    "nodes",
    "node",
    "form",
    "updateForm",
    "addNode",
    "updateNode",
    "removeNode",
    "connect",
    "disconnect",
    "select",
    "view",
    "setView",
    "save",
    "info",
    "list",
    "pick",
    /* 执行 / 取产物 / 终止（本轮补的那条闭环：应用建好图像节点之后要真能跑、能拿图） */
    "runNode",
    "nodeOutput",
    "cancelNode",
    /* 组（wf.groups）：应用把自己的链圈进一个组（画布上「绘制」只剩文本，归类节点用组） */
    "addGroup",
    "updateGroup",
    "removeGroup",
    /* 素材节点：应用显式调用才建一颗绑定素材库条目的节点（不自动往画布摆东西） */
    "addAssetNode",
  ],
  agent: ["sessions", "create", "bind", "bound", "send", "cancel"],
  fs: ["root", "readText", "writeText", "list", "mkdir", "remove", "exists", "imageDataUrl"],
  audio: ["presets", "status", "synth", "cancel"],
  tools: ["list", "call"],
  /* 联网取素材（2026-12）：search = 带 header 的文本 GET（素材站搜索回调 JSON）；
     download = 二进制落盘（图 / 音效 / 视频）。应用页 CSP 是 connect-src 'none'，
     页面自己发不了请求，这两条是它与外网之间唯一的通道。 */
  net: ["fetch", "search", "download"],
};
/* 需要声明能力位的命名空间（画布与 agent 两位；fs / tools / net 归在画布那一位的授权里，
   但**声明**也按它们各自的位算：没声明就整类不放行，见 ensureDeclared）。
   audio（Breeze 语音合成）有自己的一位 voiceGen：想出声不必连画布读写一起授权。 */
const NS_CAP = {
  canvas: "canvasHost",
  agent: "agentHost",
  fs: "canvasHost",
  audio: "voiceGen",
  tools: "canvasHost",
  net: "canvasHost",
  /* 素材库有自己的一位（2026-11 用户共识）：想读写素材库不必连画布读写一起授权；
     这一位也只对应用开放（插件窗口暂不给，见 callAssets 的 not_supported）。 */
  assets: "assetHost",
};

const STATE_FILE = "apps-host.json";

function bad(error, code) {
  return { ok: false, code: code || "failed", error: String(error || "") };
}
function isObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function callerKey(c) {
  return String((c && c.kind) || "") + ":" + String((c && c.id) || "");
}

/**
 * @param {object} o
 *   getMainWin()     → 主窗口 BrowserWindow（画布真源所在）
 *   getDataDir()     → 数据目录
 *   getApp(id)       → 应用清单摘要 {id,name,dir,capabilities} 或 null（apps-store 注入）
 *   t(str)           → 界面语言
 *   log(line)        → 日志
 */
function createAppHostBridge(o) {
  const opts = o || {};
  const getMainWin = typeof opts.getMainWin === "function" ? opts.getMainWin : () => null;
  const getDataDir = typeof opts.getDataDir === "function" ? opts.getDataDir : () => "";
  const getApp = typeof opts.getApp === "function" ? opts.getApp : () => null;
  const t = typeof opts.t === "function" ? opts.t : (s) => String(s);
  const log = typeof opts.log === "function" ? opts.log : () => {};

  /** 在途调用：id → { resolve, timer } */
  const pending = new Map();
  /** callerKey → 往那个窗口推流式事件的函数（每次调用时刷新） */
  const pushes = new Map();
  /** canvasId → { at, info } */
  const canvasCache = new Map();
  let stateCache = null;

  /* ── 状态文件（grants / bindings）────────────────────────────────────── */

  function statePath() {
    const dir = String(getDataDir() || "");
    return dir ? path.join(dir, STATE_FILE) : "";
  }
  function state() {
    if (stateCache) return stateCache;
    let raw = null;
    try {
      raw = readJson(statePath(), null);
    } catch {
      raw = null;
    }
    const src = isObj(raw) ? raw : {};
    stateCache = {
      v: 1,
      grants: isObj(src.grants) ? src.grants : {},
      bindings: isObj(src.bindings) ? src.bindings : {},
    };
    return stateCache;
  }
  function saveState() {
    const p = statePath();
    if (!p) return;
    try {
      writeJson(p, state());
    } catch (err) {
      log("[appHost] 状态落盘失败：" + ((err && err.message) || err));
    }
  }

  /* ── 主窗口往返 ─────────────────────────────────────────────────────── */

  function askRenderer(op, params, timeoutMs) {
    const win = getMainWin();
    /* 主窗口没了就立刻回结构化 not_ready（别把调用挂到超时）。
       注意只能**调用** isDestroyed()，不能拿它当布尔值判 —— 那是个函数，恒为真。 */
    const dead = !win || (typeof win.isDestroyed === "function" ? win.isDestroyed() : false);
    if (dead) {
      return Promise.resolve(
        bad(
          t("MTNode 主窗口当前不可用（画布与会话的真源在主窗口里）：请先打开主窗口再重试"),
          "not_ready",
        ),
      );
    }
    const id = "ah" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    /* timeoutMs：> 0 = 这个上限；**0 = 不挂超时器**（canvas.runNode 用：一次出图可能几分钟，
       用户共识是不设宿主超时，收口靠应用主动 canvas.cancelNode）；省略 = CALL_TIMEOUT_MS。 */
    const ms = timeoutMs === 0 ? 0 : Number(timeoutMs) > 0 ? Number(timeoutMs) : CALL_TIMEOUT_MS;
    return new Promise((resolve) => {
      const timer =
        ms > 0
          ? setTimeout(() => {
              pending.delete(id);
              resolve(bad(t("主窗口渲染层没有回执（超时）：") + op, "timeout"));
            }, ms)
          : null;
      if (timer && typeof timer.unref === "function") timer.unref();
      pending.set(id, { resolve: resolve, timer: timer });
      try {
        win.webContents.send("appHost:event", { id: id, op: op, params: params || {} });
      } catch (err) {
        if (timer) clearTimeout(timer);
        pending.delete(id);
        resolve(bad(t("推帧给主窗口失败：") + ((err && err.message) || err), "not_ready"));
      }
    });
  }

  /** 渲染层回执（main.js 的 ipcMain.handle('appHost:reply') 调这里） */
  function settle(frame) {
    const id = frame && frame.id;
    const p = id ? pending.get(id) : null;
    if (!p) return { ok: false, error: "这条调用已失效（超时或已回执）" };
    pending.delete(id);
    try {
      clearTimeout(p.timer);
    } catch {}
    if (frame && frame.error) p.resolve(bad(frame.error, (frame && frame.code) || "failed"));
    else p.resolve(isObj(frame && frame.result) ? frame.result : { ok: true, result: (frame && frame.result) ?? null });
    return { ok: true };
  }

  /** 渲染层推来的 agent 流式事件 → 转发给发起调用的那只应用窗口 */
  function pushStream(ev) {
    const key = String((ev && ev.callerKey) || "");
    const fn = key ? pushes.get(key) : null;
    if (typeof fn !== "function") return { ok: false, error: "这只窗口不在线（应用已关闭）" };
    try {
      fn({ type: "agent", sessionId: String(ev.sessionId || ""), frame: ev.frame || {} });
    } catch (err) {
      return bad((err && err.message) || err, "push_failed");
    }
    return { ok: true };
  }

  /* ── 授权（声明 + 首次弹窗）────────────────────────────────────────── */

  function granted(c) {
    const g = state().grants[callerKey(c)];
    return !!(g && g.at);
  }

  /** 撤销（关掉能力位时由 apps-store 调；也可从应用设置里手动撤） */
  function revoke(kind, id) {
    const k = String(kind || "app") + ":" + String(id || "");
    const st = state();
    if (!st.grants[k]) return { ok: true, revoked: false };
    delete st.grants[k];
    saveState();
    return { ok: true, revoked: true };
  }

  async function ensureGrant(caller) {
    if (granted(caller)) return { ok: true };
    const isApp = caller.kind === "app";
    const name = String(caller.name || caller.id || "");
    const lines = isApp
      ? [
          t("应用：") + name,
          t("申请的能力：读改画布（含撤销）· 执行画布节点（会花 Token / 占显存）· 调 agent 会话 · 画布工作目录文件 · 本机后端工具 · 联网 · 语音合成 · 素材库（读写删自己创建的内容）"),
          t("只对「这个应用对应的那张画布」生效；当前主窗口关着时它拿不到任何东西。素材库里你自己创建的素材与条目对它只读。"),
        ]
      : [t("插件：") + name, t("申请的能力：读改当前画布 · 调 agent 会话 · 文件 · 本机后端工具 · 联网 · 语音合成")];
    const r = await askRenderer(
      "grantAsk",
      { title: isApp ? t("应用请求画布与 agent 能力") : t("插件请求画布与 agent 能力"), lines: lines },
      USER_TIMEOUT_MS,
    );
    if (!r || r.ok !== true) {
      /* 主窗口不在线 / 超时 / 界面不可用：原样报回去（说成「用户拒绝」会把排障带偏） */
      const code = String((r && r.code) || "");
      if (code === "not_ready" || code === "timeout" || code === "no_ui")
        return bad((r && r.error) || t("主窗口没有回应授权请求"), code);
      return bad(t("用户没有授权（应用拿不到画布与 agent）"), "denied");
    }
    const st = state();
    st.grants[callerKey(caller)] = { at: Date.now(), name: name };
    saveState();
    return { ok: true };
  }

  /** 能力位声明：应用必须声明（插件没有 app.json，跳过这一道） */
  function ensureDeclared(caller, ns) {
    if (caller.kind !== "app") return { ok: true };
    const capId = NS_CAP[ns];
    if (!capId) return { ok: true };
    let app = null;
    try {
      app = getApp(String(caller.id || ""));
    } catch {
      app = null;
    }
    /* 清单读不到（应用已被删 / 根目录改了）时按「未声明」处理：宁可不放行 */
    const caps = isObj(app && app.capabilities) ? app.capabilities : {};
    if (caps[capId] === true) return { ok: true };
    return bad(
      t("这个应用没有声明该能力（app.json 的 capabilities.") +
        capId +
        t("）：去应用中心的「应用设置」里勾上它再试"),
      "not_declared",
    );
  }

  /* ── 画布绑定 ───────────────────────────────────────────────────────── */

  async function canvasList() {
    const r = await askRenderer("canvasList", {}, 30000);
    if (!r || r.ok !== true) return r;
    return { ok: true, list: Array.isArray(r.list) ? r.list : [] };
  }

  function canvasDead(id) {
    /* 画布文件在不在：主进程就能判（<数据目录>/save/<id>.json），省一次往返 */
    try {
      return !fs.existsSync(path.join(String(getDataDir() || ""), "save", String(id) + ".json"));
    } catch {
      return true;
    }
  }

  /** 这个调用方该操作哪张画布：返回 { ok, id, name, workspace } */
  async function boundCanvas(caller, opts2) {
    const isApp = caller.kind === "app";
    if (!isApp) {
      /* 插件窗口没有绑定概念：永远是「用户当前看着的那张」 */
      return askRenderer("canvasInfo", { canvasId: "" }, 60000);
    }
    const key = callerKey(caller);
    const st = state();
    const bind = isObj(st.bindings[key]) ? st.bindings[key] : {};
    /* ① 用户选过的那张（还活着就用它） */
    if (bind.canvasId && !canvasDead(bind.canvasId)) {
      const info = await canvasInfo(String(bind.canvasId), opts2);
      if (info.ok) return info;
    }
    /* ② 默认 = 与应用同 id 的那张画布（新建应用时后台建好的那张） */
    if (!canvasDead(caller.id)) {
      const info = await canvasInfo(String(caller.id), opts2);
      if (info.ok) return info;
    }
    /* ③ 都不在：让用户选一张，选完记住 */
    const picked = await askRenderer("pickCanvas", { suggest: String(caller.id || "") }, USER_TIMEOUT_MS);
    if (!picked || picked.ok !== true || !picked.id) {
      /* 主窗口不在线 / 超时 / 本机压根没有画布：三种原因分开报（别一律说成「没有画布」） */
      const code = String((picked && picked.code) || "");
      if (code === "not_ready" || code === "timeout")
        return bad((picked && picked.error) || t("主窗口没有回应"), code);
      return bad(
        (picked && picked.error) ||
          t("这个应用还没有可用的画布：请先在 MTNode 里建一张，或在应用里重选一次"),
        code || "no_canvas",
      );
    }
    st.bindings[key] = Object.assign({}, st.bindings[key], { canvasId: String(picked.id) });
    saveState();
    return canvasInfo(String(picked.id), opts2);
  }

  function canvasInfo(canvasId, o2) {
    const id = String(canvasId || "");
    const cached = id ? canvasCache.get(id) : null;
    if (cached && Date.now() - cached.at < CANVAS_TTL_MS && !(o2 && o2.fresh)) return Promise.resolve(cached.info);
    return askRenderer("canvasInfo", { canvasId: id }, 60000).then((r) => {
      if (r && r.ok && id) canvasCache.set(id, { at: Date.now(), info: r });
      return r;
    });
  }

  /* ── fs / tools / net ───────────────────────────────────────────────── */

  function normWorkdir(v) {
    const s = String(v || "").trim();
    if (!s) return "";
    try {
      return path.resolve(s);
    } catch {
      return "";
    }
  }
  function insideOf(root, p) {
    const a = path.resolve(root).toLowerCase().replace(/\\+$/, "");
    const b = path.resolve(p).toLowerCase();
    return b === a || b.startsWith(a + path.sep);
  }

  /* 只读、只按路径定位的两个动作（exists / imageDataUrl）**不弹「选一张画布」**：
     预览 iframe 与应用里都可能有「还没有绑定画布」的时刻，读一张图不该先让人选画布。
     有绑定就顺手拿到工作目录（相对路径与 outside 标记要用），没有也不拦。 */
  async function quietCanvas(caller) {
    if (!caller || caller.kind !== "app") return null;
    const key = callerKey(caller);
    const st = state();
    const bind = isObj(st.bindings[key]) ? st.bindings[key] : {};
    const ids = [];
    if (bind.canvasId) ids.push(String(bind.canvasId));
    if (caller.id) ids.push(String(caller.id));
    for (const id of ids) {
      if (!id || canvasDead(id)) continue;
      const info = await canvasInfo(id);
      if (info && info.ok) return info;
    }
    return null;
  }

  async function callFs(caller, method, args) {
    const a = isObj(args) ? args : {};
    /* 读图与「在不在」是纯读盘：与音频 / 视频那条媒体通道同一口径（绝对路径、只认媒体扩展名），
       不依赖画布。其余读 / 写 / 列 / 删仍按绑定的画布工作目录来。 */
    const byPath = method === "exists" || method === "imageDataUrl";
    const canvas = byPath ? await quietCanvas(caller) : await boundCanvas(caller, { fresh: method === "root" });
    if (!byPath && !canvas.ok) return canvas;
    const wd = normWorkdir(canvas && canvas.ok ? canvas.workspace : "");
    if (!byPath && !wd) return bad(t("这张画布还没有工作目录（先在顶栏选一个文件夹）"), "no_workdir");
    const rel = String(a.rel == null ? a.path == null ? "" : a.path : a.rel).replace(/\\/g, "/");
    const abs = path.isAbsolute(rel) ? path.resolve(rel) : wd ? path.resolve(wd, rel || ".") : "";
    if (!abs) return bad(t("这是相对路径，但这个应用还没有绑定的画布工作目录：请给绝对路径"), "no_workdir");
    const outside = wd ? !insideOf(wd, abs) : false;
    /* exists 只判「这个路径在不在」：不读内容、不写盘、不列目录，所以它**不限于工作目录** ——
       用户在系统选图框里挑的本机图、引用画布节点图的绝对路径都在工作目录之外，
       锁死工作目录的后果就是应用把每一张这样的图都报成「这张图不在」，上传与引用两条路等于废掉。
       其余操作（读 / 写 / 列 / 删）仍只认工作目录。 */
    if (method === "exists") {
      try {
        return { ok: true, path: abs, exists: fs.existsSync(abs), outside: outside };
      } catch (err) {
        return bad(t("文件操作失败：") + ((err && err.message) || err), "fs_failed");
      }
    }
    /* imageDataUrl：把一张图读成 dataURL 交给应用页面（只读）。为什么必须由宿主读：
       应用页面（独立窗口 / 预览 iframe）的 <img> 只认 'self' / data: / blob:，画布节点那张图是
       磁盘绝对路径（file://），iframe 里被 CSP 挡、独立窗口里也读不到 —— 应用自己拿不到像素。
       与 exists 同一口径**不限工作目录**（节点产物可能落在别处），只认图片扩展名、只读、有字节上限；
       回执带 outside 供应用判断这张图在不在工作目录里。 */
    if (method === "imageDataUrl") {
      try {
        if (!fs.existsSync(abs)) return bad(t("这张图不在：") + abs, "no_file");
        const st = fs.statSync(abs);
        if (!st.isFile()) return bad(t("这不是一个文件：") + abs, "not_file");
        const mime = IMAGE_MIME[path.extname(abs).toLowerCase()];
        if (!mime) return bad(t("只认图片（png / jpg / webp / gif / bmp）"), "bad_ext");
        if (st.size > FILE_MAX_BYTES) return bad(t("图片太大（上限 8MB）"), "too_large");
        const buf = fs.readFileSync(abs);
        return {
          ok: true,
          path: abs,
          bytes: buf.length,
          mime: mime,
          outside: outside,
          dataUrl: "data:" + mime + ";base64," + buf.toString("base64"),
        };
      } catch (err) {
        return bad(t("读图失败：") + ((err && err.message) || err), "image_read_failed");
      }
    }
    if (!insideOf(wd, abs)) return bad(t("只能读写画布工作目录里的文件"), "outside");
    try {
      if (method === "root") return { ok: true, root: wd, canvasId: canvas.id, canvasName: canvas.name };
      if (method === "readText") {
        const st = fs.statSync(abs);
        if (st.size > FILE_MAX_BYTES) return bad(t("文件太大（上限 8MB）"), "too_large");
        return { ok: true, path: abs, text: fs.readFileSync(abs, "utf8") };
      }
      if (method === "writeText") {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, String(a.content == null ? "" : a.content), "utf8");
        return { ok: true, path: abs };
      }
      if (method === "list") {
        const ents = fs.readdirSync(abs, { withFileTypes: true });
        return {
          ok: true,
          path: abs,
          items: ents.map((e) => ({ name: String(e.name || ""), dir: !!(e.isDirectory && e.isDirectory()) })),
        };
      }
      if (method === "mkdir") {
        fs.mkdirSync(abs, { recursive: true });
        return { ok: true, path: abs };
      }
      if (method === "remove") {
        if (abs === wd) return bad(t("不能删画布工作目录本身"), "refused");
        fs.rmSync(abs, { recursive: true, force: true });
        return { ok: true, path: abs };
      }
      return bad(t("不认识的文件操作"), "bad_op");
    } catch (err) {
      return bad(t("文件操作失败：") + ((err && err.message) || err), "fs_failed");
    }
  }

  /* ── audio（语音合成 · Breeze TTS 2）────────────────────────────────────
   *
   * 为什么必须有这一条：应用窗口只能拿到**文本**写盘（fs.writeText 收 UTF-8），
   * 没有二进制写口、也没有「跑画布节点」的接口，所以 wav 一条也出不来 ——
   * 识别（ASR）早有一条直通通道，合成这条一直缺着，应用里那张配音卡因此总是
   * 报「宿主没有应用侧语音合成通道」。
   *
   * 三条口径（用户共识）：
   *   ① **产物写盘、回 path**（不是 base64）：应用拿 path 再 fs.exists 复核，
   *      与产品「产物必须验过才算完成」的纪律一致；
   *   ② **outputPath 必填**，且只能落在画布工作目录内（越界回 outside，与 fs 同码）：
   *      generateBreezeFile 自己会给缺 path 的调用兜底到 asset-tmp，应用拿不到那个路径，
   *      所以这里绝不替它兜底；
   *   ③ **单任务互斥**：Breeze 后端一次只跑一个，第二个请求立刻回 busy（排队只会撞超时）。
   *      忙判定取 breeze 的**全局在途数** —— 画布节点 / MCP 正在合成时应用也回 busy。
   *
   * 实现全部转发 breeze/main-breeze.js 的 appBridgeHooks()：桥不认识 breeze 内部，
   * 也不在桥里重写预设解析 / 引擎拉起 / 显存编排。
   */

  function breezeHooks() {
    let mod = null;
    try {
      mod = require("./breeze/main-breeze.js");
    } catch {
      mod = null;
    }
    return mod && typeof mod.appBridgeHooks === "function" ? mod.appBridgeHooks() : null;
  }

  async function callAudio(caller, method, args) {
    const a = isObj(args) ? args : {};
    const canvas = await boundCanvas(caller);
    if (!canvas.ok) return canvas;
    /* 后端口子按方法现取：参数类错误要**先于**「插件未加载」报出来（应用照提示就能改），
       不能让一条拼错的调用被一句「后端不可用」盖住。 */

    if (method === "presets") {
      const hooks = breezeHooks();
      if (!hooks) return bad(t("本机语音合成后端不可用（插件未加载）"), "no_local_backend");
      try {
        const r = hooks.presets();
        return Object.assign({ ok: true }, isObj(r) ? r : { presets: [] });
      } catch (err) {
        return bad(t("读不到角色预设：") + ((err && err.message) || err), "presets_failed");
      }
    }
    if (method === "status") {
      const hooks = breezeHooks();
      if (!hooks) return bad(t("本机语音合成后端不可用（插件未加载）"), "no_local_backend");
      try {
        const r = hooks.status();
        return Object.assign({ ok: true }, isObj(r) ? r : {});
      } catch (err) {
        return bad((err && err.message) || err, "status_failed");
      }
    }
    if (method === "cancel") {
      const hooks = breezeHooks();
      if (!hooks) return bad(t("本机语音合成后端不可用（插件未加载）"), "no_local_backend");
      try {
        const r = await hooks.cancel("app:" + String((caller && caller.id) || ""));
        return Object.assign({ ok: true }, isObj(r) ? r : {});
      } catch (err) {
        return bad(t("叫停失败：") + ((err && err.message) || err), "cancel_failed");
      }
    }
    if (method === "synth") {
      const text = String(a.text == null ? "" : a.text).trim();
      if (!text) return bad(t("缺少合成文本"), "no_text");
      const rel = String(a.outputPath == null ? "" : a.outputPath).replace(/\\/g, "/");
      if (!rel) return bad(t("必须给 outputPath（画布工作目录里的路径）"), "no_path");
      const wd = normWorkdir(canvas.workspace);
      if (!wd) return bad(t("这张画布还没有工作目录（先在顶栏选一个文件夹）"), "no_workdir");
      const abs = path.resolve(wd, rel);
      if (!insideOf(wd, abs)) return bad(t("只能写到画布工作目录里"), "outside");
      const hooks = breezeHooks();
      if (!hooks) return bad(t("本机语音合成后端不可用（插件未加载）"), "no_local_backend");
      let st = null;
      try {
        st = hooks.status();
      } catch {
        st = null;
      }
      if (st && st.busy) return bad(t("语音后端正在合成另一段，稍后重试"), "busy");
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
      } catch (err) {
        return bad(t("建目录失败：") + ((err && err.message) || err), "fs_failed");
      }
      const r = await hooks.generate({
        text: text,
        presetId: String(a.presetId || ""),
        presetGroupId: String(a.presetGroupId || ""),
        instruction: String(a.instruction || ""),
        voice: String(a.voice || ""),
        cfgScale: a.cfgScale,
        seed: a.seed,
        speed: a.speed,
        /* 显式给绝对路径：绝不落 generateBreezeFile 的 resolveManagedOutDir 兜底目录 */
        outputPath: abs,
        response_format: String(a.responseFormat || "wav"),
        nodeId: "app:" + String((caller && caller.id) || ""),
      });
      if (!r || r.ok !== true)
        return {
          ok: false,
          code: String((r && r.error) || "tts_failed"),
          error: String((r && r.message) || (r && r.error) || t("语音合成失败")),
        };
      let bytes = 0;
      try {
        bytes = fs.statSync(abs).size;
      } catch {
        bytes = 0;
      }
      /* 合成成功但磁盘上没有文件 = 不算成功（应用会拿 path 去 fs.exists 复核，别让它自己发现） */
      if (!bytes) return bad(t("合成已返回，但产物不在磁盘上"), "no_file");
      return { ok: true, path: abs, bytes: Number(r.bytes || bytes) };
    }
    return bad(t("不认识的语音操作：") + method, "bad_method");
  }

  /* ── assets（素材库 · 应用侧唯一入口）──────────────────────────────────
   * 实现在 assets-store.js 的 assetActorCall：归属校验就在库里判 —— 应用只能改 / 删
   * 自己创建的素材与条目，用户自己那份一律只读（越权回 forbidden），不靠调用方自觉。
   * 插件窗口本轮不开放（用户共识：只给应用），在这里就直说，不去弹授权窗。
   *
   * readItem 带 withDataUrl:true 时顺手把图像读成 dataURL：应用页面（独立窗口 / 预览
   * iframe）的 <img> 只认 'self' / data: / blob:，磁盘绝对路径显示不出来。
   * 上限与 fs.imageDataUrl 同一口径（FILE_MAX_BYTES、只认 IMAGE_MIME）。
   */
  function assetsStore() {
    try {
      return require("./assets-store.js");
    } catch {
      return null;
    }
  }
  /* 素材库被**应用**改过之后，通知主窗口渲染层重扫一次。
     为什么必须有：渲染层的扫描结果（ASSET_LIB.scan）是缓存，节点上显示的就是那份缓存；
     应用是经主进程直接写库的，渲染层一点都不知道 —— 不广播的话，画布上那颗素材节点
     要等用户手动打开素材库 / 重启才看到新内容。只广播「变了」，刷新怎么做由渲染层决定。 */
  function notifyAssetsChanged(info) {
    const win = getMainWin();
    if (!win || (typeof win.isDestroyed === "function" && win.isDestroyed())) return;
    try {
      win.webContents.send("assets:changed", Object.assign({ at: Date.now() }, info || {}));
    } catch {
      /* 广播失败不影响这次写库结果：应用已经拿到 ok，界面下次刷新照样能看见 */
    }
  }
  /* 会改库的方法（列 / 读不算）：只有这几个需要广播 */
  const ASSET_WRITE_METHODS = [
    "mkdir",
    "create",
    "addItem",
    "importFile",
    "importFiles",
    "updateText",
    "updateMeta",
    "removeItem",
    "deleteAsset",
  ];
  async function callAssets(caller, method, args) {
    if (caller.kind !== "app")
      return bad(t("素材库能力目前只对应用开放（插件窗口暂不提供）"), "not_supported");
    const mod = assetsStore();
    if (!mod || typeof mod.assetActorCall !== "function")
      return bad(t("素材库存储未就绪（assets-store.js）"), "not_ready");
    const a = isObj(args) ? args : {};
    const actor = { kind: "app", id: String(caller.id || ""), name: String(caller.name || "") };
    const r = await mod.assetActorCall(actor, String(method || ""), a);
    if (!r || r.ok !== true) return isObj(r) ? r : bad(t("素材库操作失败"), "failed");
    if (ASSET_WRITE_METHODS.indexOf(String(method || "")) >= 0)
      notifyAssetsChanged({ method: String(method || ""), app: String(caller.id || "") });
    if (method === "readItem" && (a.withDataUrl === true || a.dataUrl === true)) {
      const p = String((r.file && r.file.path) || "");
      const mime = p ? IMAGE_MIME[path.extname(p).toLowerCase()] : "";
      if (p && mime) {
        try {
          const st = fs.statSync(p);
          if (st.isFile() && st.size <= FILE_MAX_BYTES) {
            r.dataUrl = "data:" + mime + ";base64," + fs.readFileSync(p).toString("base64");
            r.mime = mime;
          }
        } catch {
          /* 读不到就只回路径：读取失败不该把整条 readItem 变成错误 */
        }
      }
    }
    return r;
  }

  /* ── agent ──────────────────────────────────────────────────────────── */

  async function callAgent(caller, method, args) {
    const a = isObj(args) ? args : {};
    const canvas = await boundCanvas(caller);
    if (!canvas.ok) return canvas;
    const key = callerKey(caller);
    const st = state();
    const bind = isObj(st.bindings[key]) ? st.bindings[key] : {};
    const remember = (patch) => {
      st.bindings[key] = Object.assign({}, st.bindings[key], patch);
      saveState();
    };

    if (method === "sessions") {
      const r = await askRenderer("agentSessions", { canvasId: canvas.id }, 60000);
      if (!r || r.ok !== true) return r;
      return Object.assign({ ok: true, bound: String(bind.sessionId || "") }, r);
    }
    if (method === "create") {
      const r = await askRenderer("agentCreate", { canvasId: canvas.id, title: String(a.title || "") }, 120000);
      if (!r || r.ok !== true) return r;
      remember({ sessionId: String(r.sessionId || "") });
      return r;
    }
    if (method === "bind") {
      const sid = String(a.sessionId || "").trim();
      if (!sid) return bad(t("sessionId 必填"), "bad_arg");
      const r = await askRenderer("agentBindCanvas", { canvasId: canvas.id, sessionId: sid }, 60000);
      if (!r || r.ok !== true) return r;
      remember({ sessionId: sid });
      return r;
    }
    if (method === "bound") {
      const sid = String(bind.sessionId || "");
      if (!sid) return { ok: true, sessionId: "", title: "" };
      const r = await askRenderer("agentSessions", { canvasId: canvas.id }, 60000);
      const hit = (r && r.ok && (r.sessions || []).find((s) => String(s.id) === sid)) || null;
      return { ok: true, sessionId: sid, title: hit ? String(hit.title || "") : "", alive: !!hit };
    }
    if (method === "send") {
      const text = String(a.text == null ? "" : a.text).trim();
      if (!text) return bad(t("text 不能为空"), "bad_arg");
      let sid = String(a.sessionId || bind.sessionId || "").trim();
      if (!sid) {
        const made = await callAgent(caller, "create", { title: "" });
        if (!made.ok) return made;
        sid = String(made.sessionId || "");
      }
      const r = await askRenderer(
        "agentSend",
        { canvasId: canvas.id, sessionId: sid, text: text, callerKey: key },
        120000,
      );
      if (r && r.ok) remember({ sessionId: sid });
      return r || bad(t("会话没有回执"), "failed");
    }
    if (method === "cancel") {
      const sid = String(a.sessionId || bind.sessionId || "").trim();
      if (!sid) return bad(t("还没有绑定会话"), "not_bound");
      return askRenderer("agentCancel", { canvasId: canvas.id, sessionId: sid }, 60000);
    }
    return bad(t("不认识的 agent 方法：") + method, "bad_method");
  }

  /* ── net：联网取素材（搜索 / 下载） ─────────────────────────────────────
   * search 不碰画布（纯网络读），download 只往**绑定的画布工作目录**里写 ——
   * 宿主替应用定路径，不接受任意绝对路径落盘，也不让相对路径跑出工作目录。 */
  async function callNet(caller, method, args) {
    const a = isObj(args) ? args : {};
    const url = String(a.url || "");
    if (method === "search") {
      return netFetchMod.search({ url: url, headers: a.headers, timeoutMs: a.timeoutMs });
    }
    const canvas = await boundCanvas(caller);
    if (!canvas.ok) return canvas;
    const wd = normWorkdir(canvas.workspace);
    if (!wd) return bad(t("这张画布还没有工作目录（先在顶栏选一个文件夹）"), "no_workdir");
    const rel = String(a.rel == null ? (a.path == null ? "" : a.path) : a.rel).replace(/\\/g, "/");
    if (!rel) return bad(t("没给落盘位置（素材只能写进画布工作目录）"), "bad_dest");
    const abs = path.resolve(wd, rel);
    if (!insideOf(wd, abs)) return bad(t("只能写进画布工作目录里"), "outside");
    const ext = path.extname(abs).toLowerCase();
    if (!netFetchMod.OK_EXT.has(ext)) return bad(t("只认素材扩展名（图 / 音 / 视频）"), "bad_ext");
    return netFetchMod.download({
      url: url,
      destPath: abs,
      headers: a.headers,
      maxBytes: a.maxBytes,
      timeoutMs: a.timeoutMs,
    });
  }

  /* ── 入口 ───────────────────────────────────────────────────────────── */

  /**
   * 一次调用。caller = { kind:"app"|"plugin", id, name, push(ev) }。
   * 返回结构化回执（永不 reject）。
   */
  async function call(caller, ns, method, args) {
    const kind = String((caller && caller.kind) || "");
    const id = String((caller && caller.id) || "");
    if ((kind !== "app" && kind !== "plugin") || !id) return bad(t("认不出是哪个窗口在调用"), "not_app");
    const table = NS_METHODS[String(ns || "")];
    if (!table || table.indexOf(String(method || "")) < 0)
      return bad(t("这个宿主能力不存在：") + String(ns) + "." + String(method), "bad_method");
    if (typeof caller.push === "function") pushes.set(callerKey(caller), caller.push);
    /* 素材库只给应用：插件窗口在这里就回绝，不去弹一次没用的授权窗 */
    if (ns === "assets" && kind !== "app")
      return bad(t("素材库能力目前只对应用开放（插件窗口暂不提供）"), "not_supported");
    const decl = ensureDeclared(caller, String(ns));
    if (!decl.ok) return decl;
    const g = await ensureGrant(caller);
    if (!g.ok) return g;
    try {
      if (ns === "canvas") {
        /* 画布清单 / 重选 / 信息这三条不走绑定（它们是「绑定之前」要用的） */
        if (method === "list") return canvasList();
        if (method === "pick") {
          /* 插件没有「绑定画布」这个概念（永远操作你当前打开的那张），重选对它没有意义 */
          if (kind !== "app")
            return bad(t("插件没有绑定画布：它操作的永远是你当前打开的那张，不需要重选"), "not_bound");
          const r = await askRenderer("pickCanvas", { suggest: id }, USER_TIMEOUT_MS);
          if (!r || r.ok !== true || !r.id) return r && r.ok === false ? r : bad(t("没有选择画布"), "cancelled");
          const st = state();
          st.bindings[callerKey(caller)] = Object.assign({}, st.bindings[callerKey(caller)], {
            canvasId: String(r.id),
          });
          saveState();
          canvasCache.delete(String(r.id));
          return canvasInfo(String(r.id), { fresh: true });
        }
        if (method === "info") {
          const c = await boundCanvas(caller);
          return c;
        }
        const c = await boundCanvas(caller);
        if (!c.ok) return c;
        /* runNode = 真跑一颗节点（图像生成可能 20s~几分钟）：**不挂宿主超时**，
           收口靠应用自己 canvas.cancelNode(id)（用户共识：不限时）。 */
        const waitMs = method === "runNode" ? 0 : undefined;
        return askRenderer("canvasCall", { canvasId: c.id, method: method, args: isObj(args) ? args : {} }, waitMs);
      }
      if (ns === "agent") return await callAgent(caller, String(method), args);
      if (ns === "assets") return await callAssets(caller, String(method), args);
      if (ns === "fs") return await callFs(caller, String(method), args);
      if (ns === "audio") return await callAudio(caller, String(method), args);
      if (ns === "tools") {
        if (method === "list") return askRenderer("toolsList", {}, 60000);
        return askRenderer("toolsCall", { id: String((args && (args.id || args.tool)) || ""), args: (args && args.args) || {} }, CALL_TIMEOUT_MS);
      }
      /* net：fetch 仍是老的「取一段网页文本」（走渲染层的既有通道）；
         search / download 是这一轮新增的素材通道，直接在主进程做。 */
      if (ns === "net") {
        if (method === "search" || method === "download") return await callNet(caller, String(method), args);
        return askRenderer("netFetch", { url: String((args && args.url) || args || "") }, CALL_TIMEOUT_MS);
      }
      return bad(t("不认识的能力"), "bad_method");
    } catch (err) {
      return bad((err && err.message) || err, "failed");
    }
  }

  return {
    call: call,
    settle: settle,
    pushStream: pushStream,
    revoke: revoke,
    granted: granted,
    /* 冒烟 / 排障用：当前授权与绑定（只读） */
    snapshot: () => JSON.parse(JSON.stringify(state())),
    NS_METHODS: NS_METHODS,
  };
}

module.exports = {
  createAppHostBridge,
  NS_METHODS,
  STATE_FILE,
};
