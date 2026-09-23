"use strict";
/* ============ AI 事实库（AI Fact Library）· 给 AI 读的极简条例库 ============
 *
 * 与「团队事实库」（app-factlib.js）的关系 —— 两套**互相独立**的存储，一般事实库行为一行不改：
 *   · 一般事实库 = 团队事实库（人读）：多篇互相独立的 md 文档 + 审阅版本链 + 共享 assets/，
 *     由专家在对话中建档维护；路径解析 / 落点守卫 / 历史错位修复全套照旧（app-factlib.js）。
 *   · AI 事实库（本文件）= 本轮新增的独立存储（AI 读）：一件事一条的极简条例（一行到几行），
 *     正文是写给模型看的，不是给人读的文档。
 *   两者都待在同一个「画布文件夹」下，只是目录不同：
 *     <画布文件夹>\团队事实库\<doc>.md          ← 人读，app-factlib.js 全权负责
 *     <画布文件夹>\团队事实库\AI\ai-facts.json  ← AI 读，本文件全权负责（固定路径，不可改）
 *
 * 落点豁免（本轮共识，改代码前先读这一段）：
 *   app-factlib.js 的 misplacedReason / isInAppDir（禁止落在应用目录 / 开发节点项目根内）
 *   **不适用于 AI 库**：即使画布文件夹就是应用源码目录（本机就是 E:\dev\tools\pipeline-console），
 *   AI 库也照建。理由是两者性质不同：团队事实库是**人类文档**，跟着源码目录走会被升级 / 卸载
 *   带走、被开发流程覆盖，所以必须挡；AI 库是**给 AI 读的紧凑条例**（一条一行、随画布重建即可
 *   重写），它的价值恰恰是「紧贴这张画布的工作目录」，另挪一处会让 Agent 取不到、也让
 *   「一张画布一份」的口径分裂。因此本文件**不调用 misplacedReason，也不做任何应用目录检查**。
 *
 * 落点与载入（画布删除后在同一工作目录重建 → 立刻载入，不弹任何确认框）：
 *   固定路径 = joinPath(画布文件夹, "团队事实库", "AI", "ai-facts.json")；
 *   「画布文件夹」沿用现有口径 window.teamCanvasWorkspace(canvasId)（app-team.js factWorkspace：
 *   锚点手填 > 该画布顶栏「工作目录」wf.workspace）。
 *   载入路径解析：① 先看 S.config.aiFacts.canvases[canvasId]（本模块自己的配置命名空间，
 *   dir = 画布文件夹绝对路径）；② 没有就看 teamCanvasWorkspace(canvasId) 直接推导，**推导成功
 *   即把 dir 登记进配置**（此后跟着画布走，工作目录后来改了也不漂移）；③ 两个都没有 → 弹目录选择
 *   让用户为这张画布选一个（选定结果同样登记进配置），用户取消 → 库不可用（不猜落点、不回落全局库）。
 *   ai-facts.json 存在 = 已载入；不存在 = 空库，**等首次写入时才创建文件**（打开弹窗 / 只读查询
 *   都不落地）。JSON 解析失败时先原样备份成 ai-facts.json.bak 再当空库，绝不静默丢掉用户数据。
 *
 * 数据格式（唯一真源；工具与界面共用同一个文件）：
 *   { "version": 1, "cap": 100,
 *     "entries": [{ "id": "af-…", "title": "…", "text": "…", "tags": [], "type": "", "src": "",
 *                   "status": "active", "hit": 0, "hits": 0, "lastHit": 0, "protectionUntil": 0,
 *                   "pinned": false, "createdAt": 0, "updatedAt": 0 }],
 *     "log": [{ "at": 0, "id": "af-…", "title": "…", "score": 0 }] }
 *   字段口径（与主进程 ai-facts-store.js 共用同一个文件，未知键一律保留）：
 *     · tags / type / src —— 标签（≤8 个短词）· 类型（架构 / 约定 / 命令 / 坑…）· 来源
 *       （哪份文件、哪次确认、哪条旧记忆）。三者都是检索辅助，不改变正文口径。
 *     · status —— "active" 已确认（工具查得到）/ "pending" 待确认（AI propose 出来的提议）：
 *       pending 进弹窗顶部的「待确认」区，**不参与查库、不占上限、不参与淘汰**，
 *       用户在界面上确认（confirm）后才落成 active。
 *     · hit —— 计分权重：被读一次 +1、被写一次 +0.5（旧档没有 hit 时以 hits 起步）。
 *     · hits —— 只数「被查阅次数」（读 +1；写 / pin / 删除都不加），界面与工具回执显示它。
 *     · protectionUntil —— 零命中新条目的保护期终点（创建时 = 创建时刻 + 7 天）。
 *     · text —— 正文（工具侧写 text；新口径的别名 body 也收，落到文件里统一是 text）。
 *
 * 命中 / 分数 / 淘汰口径：
 *   · 命中计数：只有 query / get / read 命中某条才 hits+1、hit+1 且 lastHit = Date.now()；
 *     list（列全部）与写入 / pin / 删除都**不**计数 —— 计数只表示「这条被真正查阅过」。
 *   · score = hit / (1 + daysSince(lastHit))：距上次命中越久分数越低（线性衰减，不设半衰期）；
 *     lastHit 为 0 时用 updatedAt，再没有用 createdAt，都没有则按 0 天算；界面显示保留 1 位小数。
 *   · cap 默认 100（每张画布各自一份，写进文件，界面可调）。**已确认**条目数 > cap 时：
 *     先淘汰**未 pin 且过了保护期**的，按 score 升序、score 相同先淘汰 lastHit 更旧的，削到 cap；
 *     pinned 永不淘汰；**零命中的新条目**在 protectionUntil 之前也不淘汰（给新条例被读到的机会）；
 *     pinned + 保护期内的条目已占满上限时不再淘汰，只保留超额并在回执里说明。
 *   · 淘汰结果写进文件的 log（最近 20 条，新的在前），弹窗底部「最近淘汰」可回看。
 *   · upsert 语义：write 带 id 且命中 → 更新该条（保留 hits / lastHit / pinned / createdAt，
 *     刷新 updatedAt）；不带 id → 按**归一化标题**（trim + 折叠连续空白 + 小写）匹配已有条目，
 *     命中即更新同一语义；都没命中 → 新建，id 形如 af-<Date.now().toString(36)>-<4 位随机>。
 *   · 权限：Agent（工具）可读可写可删可 pin；用户在弹窗里同样能新增 / 编辑 / 删除 / pin / 调 cap。
 *
 * 无绑定画布时一律拒绝：工具抛 / 弹窗提示「当前没有绑定画布」，绝不猜落点、不回落全局库。
 * 入口只有两个：Agent 侧的工具（aiFactsOp）与专家团左栏的「AI 事实库」弹窗（aiFactsOpenDlg）；
 * 不接 Ctrl+F 全局查找，也不接长任务记忆库同步。
 *
 * 装载：renderer/index.html 挂在 app-factlib.js 之后（本文件与它无依赖关系，只是同层相邻）。
 * app-teamview.js 实际排在更前面，故它对本模块的调用一律在**调用期**按 typeof 判空取用，
 * 不依赖装载顺序。公开接口：window.MTNodeAiFacts（另有全局别名 aiFacts*）。
 */
(function () {
  /* 词条取词：中文为键，英文由 i18n.js 的 EN 表兜底；缺词条时原样回显中文（不报错、不缺字）。 */
  function T(s, vars) {
    if (window.I18n && window.I18n.t) return window.I18n.t(s, vars);
    var out = String(s);
    if (vars && typeof vars === "object")
      out = out.replace(/\{(\w+)\}/g, function (_m, k) {
        return vars[k] == null ? "" : String(vars[k]);
      });
    return out;
  }
  function api() {
    try {
      return window.api || null;
    } catch (e) {
      return null;
    }
  }
  function str(v) {
    return v == null ? "" : String(v);
  }
  /* 提示（app.js 的全局 toast；缺失时静默）。 */
  function warn(msg, kind) {
    try {
      if (typeof toast === "function") toast(msg, kind || "warn");
    } catch (e) {}
  }
  function errText(err) {
    return String((err && err.message) || err || "");
  }

  /* ───────────────────────── 常量 ───────────────────────── */

  var LIB_DIR = "团队事实库"; /* 与团队事实库共用一个父目录：两个库在同一处，用户好找 */
  var AI_DIR = "AI"; /* AI 库独占的子目录，绝不与人类 md 混放 */
  var FILE_NAME = "ai-facts.json";
  var BAK_SUFFIX = ".bak";
  var CAP_DEFAULT = 100;
  var CAP_MIN = 1;
  var CAP_MAX = 1000; /* 界面可调但要有硬闸：手打一个 1e9 会让淘汰把库清空 */
  var Q_LIMIT_DEFAULT = 10;
  var Q_LIMIT_MAX = 50;
  var PROTECT_DAYS = 7; /* 零命中新条目的保护期：7 天之内不参与淘汰（见文件头「淘汰口径」） */
  var EVICT_LOG_MAX = 20; /* 写进文件的最近淘汰记录条数（弹窗底部「最近淘汰」可回看） */
  var PENDING_MAX = 50; /* 待确认（propose）区软上限：超过就提示先确认或清掉，别让提议淹没库 */
  var BODY_HINT_LEN = 200; /* 正文超过这个长度就提示精简（软提示，不拦写入） */
  var DAY_MS = 24 * 60 * 60 * 1000;
  var NB = "当前没有绑定画布"; /* 无绑定画布的唯一错误文本（工具与界面共用） */

  /* ───────────────────────── 路径工具（渲染层无 node path，自己拼） ───────────────────────── */

  function isWinPath(p) {
    var s = str(p);
    return /^[a-zA-Z]:/.test(s) || s.indexOf("\\") >= 0;
  }
  function isAbs(p) {
    var s = str(p).trim();
    if (!s) return false;
    return /^[a-zA-Z]:[\\/]/.test(s) || /^\\\\/.test(s) || s.charAt(0) === "/";
  }
  /* 逐段拼接：优先用主进程的 path.join（preload 白名单），没有就手工拼（Windows 用 \）。 */
  function joinPath() {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) {
      var p = arguments[i];
      if (p != null && str(p) !== "") parts.push(str(p));
    }
    if (!parts.length) return "";
    var a = api();
    if (a && typeof a.pathJoin === "function") {
      try {
        return str(a.pathJoin.apply(null, parts));
      } catch (e) {}
    }
    var win = isWinPath(parts[0]);
    var joined = parts
      .map(function (s) {
        return s.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
      })
      .join("/")
      .replace(/\/{2,}/g, "/");
    return win ? joined.replace(/\//g, "\\") : joined;
  }

  /* ───────────────────── 配置命名空间 S.config.aiFacts ─────────────────────

     新配置命名空间：S.config.aiFacts.canvases[canvasId] = { dir }（dir = 画布文件夹绝对路径）。
     与团队事实库把 dir 写进库记录同口径，但**独立一份**：一般事实库的库记录挂在
     S.config.team.canvases[].fact 上，本模块不读也不写那棵树，两边互不干扰。
     只存「画布文件夹」而不是文件全路径：库内三段（团队事实库 / AI / ai-facts.json）是固定口径，
     存进配置就成了第二份真源，将来改口径会留下死路径。 */

  function stateObj() {
    try {
      return typeof S !== "undefined" && S && typeof S === "object" ? S : null;
    } catch (e) {
      return null;
    }
  }
  function cfgRoot(create) {
    var st = stateObj();
    if (!st) return null;
    if (!st.config || typeof st.config !== "object") {
      if (!create) return null;
      st.config = {};
    }
    var c = st.config;
    if (!c.aiFacts || typeof c.aiFacts !== "object") {
      if (!create) return null;
      c.aiFacts = { canvases: {} };
    }
    if (!c.aiFacts.canvases || typeof c.aiFacts.canvases !== "object") {
      if (!create) return null;
      c.aiFacts.canvases = {};
    }
    return c.aiFacts;
  }
  function cfgDirOf(canvasId) {
    var r = cfgRoot(false);
    var k = str(canvasId);
    if (!r || !k || !r.canvases) return "";
    var e = r.canvases[k];
    var d = e && str(e.dir).trim();
    /* 手改坏的相对路径不认（否则会拼出相对当前进程目录的怪路径），当作没登记 → 重新推导。 */
    return d && isAbs(d) ? d : "";
  }
  function persistConfig() {
    var a = api();
    var st = stateObj();
    if (!a || typeof a.configSave !== "function" || !st || !st.config) return;
    try {
      var p = a.configSave(st.config);
      if (p && typeof p.then === "function") p.then(function () {}, function () {});
    } catch (e) {}
  }
  /* 登记「这张画布的 AI 库落在哪个画布文件夹」：值没变就不写盘（切画布 / 反复载入不刷盘）。 */
  function cfgSetDir(canvasId, dir) {
    var d = str(dir).trim();
    var k = str(canvasId);
    if (!k || !d || !isAbs(d)) return false;
    if (cfgDirOf(k) === d) return true;
    var r = cfgRoot(true);
    if (!r) return false;
    r.canvases[k] = { dir: d };
    persistConfig();
    return true;
  }

  /* ───────────────────────── 画布 id ───────────────────────── */

  /* 当前绑定画布 = 用户正看着的那张（前台真源 currentVisibleWf），退回 S.wf。
     取不到就返回空串，由调用方一律按「当前没有绑定画布」拒绝 —— 绝不猜、不回落全局库。 */
  function canvasId() {
    try {
      if (typeof currentVisibleWf === "function") {
        var w = currentVisibleWf();
        if (w && w.id) return str(w.id);
      }
    } catch (e) {}
    var st = stateObj();
    if (st && st.wf && st.wf.id) return str(st.wf.id);
    return "";
  }
  /* 显式传入的 canvasId 优先；没传才落到当前绑定画布。 */
  function idOf(canvasIdArg) {
    return str(canvasIdArg).trim() || canvasId();
  }

  /* ───────────────────────── 路径解析（pathOf） ───────────────────────── */

  function pickFolder() {
    var a = api();
    if (!a || typeof a.fileOpenDialog !== "function") return Promise.resolve("");
    return Promise.resolve(
      a.fileOpenDialog({
        title: T("选择画布文件夹（AI 事实库将建在此目录下的「团队事实库/AI」里）"),
        directory: true,
      }),
    ).then(
      function (r) {
        var p = r && r.path ? str(r.path).trim() : "";
        return p && isAbs(p) ? p : "";
      },
      function () {
        return "";
      },
    );
  }

  /* 解析「画布文件夹」→ { dir, fromWorkspace, picked }（解析不出返回 null）。
     顺序（口径见文件头）：配置 → 画布工作目录（推导成功即登记）→ 弹目录选择（silent 不弹）。 */
  function resolveDir(id, o) {
    var cfg = cfgDirOf(id);
    if (cfg) return Promise.resolve({ dir: cfg, fromWorkspace: false, picked: false });
    var ws = "";
    try {
      if (typeof window.teamCanvasWorkspace === "function")
        ws = str(window.teamCanvasWorkspace(id)).trim();
    } catch (e) {}
    if (ws && isAbs(ws)) {
      /* 推导成功即登记：画布删除后在同一工作目录重建时，下一条路径解析直接命中配置（立刻载入）。 */
      cfgSetDir(id, ws);
      return Promise.resolve({ dir: ws, fromWorkspace: true, picked: false });
    }
    /* 静默（自动扫描 / 左栏条数 / 工具侧）：没有已定的画布文件夹就放弃，绝不擅自弹目录选择。 */
    if (o && o.silent) return Promise.resolve(null);
    return pickFolder().then(function (p) {
      if (!p) return null;
      cfgSetDir(id, p);
      return { dir: p, fromWorkspace: false, picked: true };
    });
  }

  /* 库路径：Promise<{ dir, file, canvasId, fromWorkspace, picked }>；解析不出返回 null。
     注意：这里**不做**落点守卫（misplacedReason / isInAppDir）—— AI 库豁免，理由见文件头。 */
  function pathOf(canvasIdArg, opts) {
    var o = opts || {};
    return Promise.resolve().then(function () {
      var id = idOf(canvasIdArg);
      if (!id) return null;
      return resolveDir(id, o).then(function (r) {
        if (!r || !r.dir) return null;
        return {
          dir: r.dir,
          file: joinPath(r.dir, LIB_DIR, AI_DIR, FILE_NAME),
          canvasId: id,
          fromWorkspace: !!r.fromWorkspace,
          picked: !!r.picked,
        };
      });
    });
  }

  /* ───────────────────────── 数据归一化 / 分数 / 淘汰 ───────────────────────── */

  function clampCap(v) {
    var n = Math.floor(Number(v));
    if (!isFinite(n) || n <= 0) return CAP_DEFAULT;
    if (n < CAP_MIN) return CAP_MIN;
    if (n > CAP_MAX) return CAP_MAX;
    return n;
  }
  function emptyData() {
    return { version: 1, cap: CAP_DEFAULT, entries: [] };
  }
  /* 新建条例 id：af-<36 进制时间戳>-<4 位随机>（时间戳在前，肉眼扫 id 也能看出新旧）。 */
  function genId() {
    var chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    var rand = "";
    for (var i = 0; i < 4; i++) rand += chars.charAt(Math.floor(Math.random() * chars.length));
    return "af-" + Date.now().toString(36) + "-" + rand;
  }
  /* 归一化标题：trim + 折叠连续空白 + 小写 —— upsert 的「同一语义」判据就是它。 */
  function normTitle(t) {
    return str(t).trim().replace(/\s+/g, " ").toLowerCase();
  }
  /* 单条归一化（**就地**改写传入对象，保住引用：调用方 mutate 完直接落盘，条目对象始终同一只）。 */
  function normEntry(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    var title = str(raw.title).trim();
    var text = str(raw.text);
    if (!title && !text.trim()) return null; /* 标题与正文都空的脏项直接丢掉 */
    raw.id = str(raw.id).trim() || genId();
    raw.title = title;
    raw.text = text;
    raw.hits = Math.max(0, Math.floor(Number(raw.hits) || 0));
    raw.lastHit = Math.max(0, Number(raw.lastHit) || 0);
    raw.pinned = !!raw.pinned;
    /* hit 是计分权重（读 +1 / 写 +0.5）：旧档没有它就以 hits 起步，老库攒下的读数不丢。 */
    raw.hit = Math.max(0, Number(raw.hit));
    if (!isFinite(raw.hit) || raw.hit < raw.hits) raw.hit = raw.hits;
    raw.tags = tagsOf(raw.tags);
    raw.type = str(raw.type).trim().slice(0, 32);
    raw.src = str(raw.src == null || raw.src === "" ? raw.source : raw.src).trim().slice(0, 160);
    raw.status = str(raw.status).trim() === "pending" ? "pending" : "active";
    raw.protectionUntil = Math.max(0, Number(raw.protectionUntil) || 0);
    /* 时间戳缺就留 0（不编造时间）：score 的 daysSince 再没有就按 0 天算，读数才诚实。 */
    raw.createdAt = Math.max(0, Number(raw.createdAt) || 0);
    raw.updatedAt = Math.max(0, Number(raw.updatedAt) || 0);
    return raw;
  }
  /* 整库归一化（就地）：cap 夹到 1..1000、entries 过滤非法项并补默认字段。 */
  function normData(raw) {
    var d = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    d.version = 1;
    d.cap = clampCap(d.cap);
    var src = Array.isArray(d.entries) ? d.entries : [];
    var out = [];
    for (var i = 0; i < src.length; i++) {
      var e = normEntry(src[i]);
      if (e) out.push(e);
    }
    d.entries = out;
    /* 最近淘汰记录（flat：[{at,id,title,score}]，新的在前）：只管截断，内容由 evict 写。 */
    d.log = (Array.isArray(d.log) ? d.log : []).slice(0, EVICT_LOG_MAX);
    return d;
  }

  /* 标签归一化：数组 / 逗号（中英文）/ 顿号 / 分号 / 空格分隔都收；trim、去空、忽略大小写去重、最多 8 个。 */
  function tagsOf(v) {
    var raw = [];
    if (Array.isArray(v)) raw = v.slice();
    else if (str(v).trim()) raw = str(v).split(/[,，、;；\s]+/);
    var seen = {};
    var out = [];
    for (var i = 0; i < raw.length && out.length < 8; i++) {
      var t = str(raw[i]).trim().slice(0, 24);
      var k = t.toLowerCase();
      if (!t || seen[k]) continue;
      seen[k] = 1;
      out.push(t);
    }
    return out;
  }
  /* 计分权重：读 +1 / 写 +0.5 都累在这里（hits 只数「被查阅次数」，分工见文件头）。 */
  function weightOf(entry) {
    var e = entry || {};
    var hits = Math.max(0, Number(e.hits) || 0);
    var w = Number(e.hit);
    if (!isFinite(w) || w < 0) w = 0;
    return w < hits ? hits : w;
  }
  /* 待确认（AI propose 出来的提议）：不参与查库、不占上限、不参与淘汰。 */
  function isPending(e) {
    return str(e && e.status).trim() === "pending";
  }
  function activeEntries(data) {
    return (data && Array.isArray(data.entries) ? data.entries : []).filter(function (e) {
      return !isPending(e);
    });
  }
  function pendingEntries(data) {
    return (data && Array.isArray(data.entries) ? data.entries : []).filter(isPending);
  }
  /* 保护期：**零命中**（hits = 0，即从没被查阅过）的已确认新条目，在 protectionUntil 之前不淘汰。 */
  function isProtected(e, nowMs) {
    if (!e || isPending(e)) return false;
    if (Math.max(0, Number(e.hits) || 0) > 0) return false;
    var until = Number(e.protectionUntil) || 0;
    if (!until) return false;
    return until > (Number(nowMs) || Date.now());
  }

  /* 分数原始值：hit / (1 + 距上次命中天数)。 */
  function rawScore(entry) {
    var e = entry || {};
    var hit = weightOf(e);
    var last = Number(e.lastHit) || 0;
    if (!last) last = Number(e.updatedAt) || 0;
    if (!last) last = Number(e.createdAt) || 0;
    var days = last > 0 ? Math.max(0, (Date.now() - last) / DAY_MS) : 0;
    return hit / (1 + days);
  }
  /* 分数（保留 1 位小数）：界面显示与淘汰排序都用它，界面与工具读到的数才是同一个。 */
  function scoreOf(entry) {
    return Math.round(rawScore(entry) * 10) / 10;
  }

  /* 淘汰：**已确认**条目数 > cap 时削回 cap（待确认的提议不占名额，也不被淘汰）。
     返回 { evicted:[{id,title,score}], overflow, protectedKept }。
     overflow = pinned + 保护期内的条目已占满名额而无法淘汰（只保留超额，由调用方在回执里说明）；
     protectedKept = 本轮因「零命中保护期」而免于淘汰的条数。 */
  function evict(data) {
    var evicted = [];
    data.cap = clampCap(data.cap);
    var now = Date.now();
    var active = activeEntries(data);
    if (active.length <= data.cap) return { evicted: evicted, overflow: false, protectedKept: 0 };
    var pinned = [];
    var prot = [];
    var free = [];
    active.forEach(function (e) {
      if (e.pinned) pinned.push(e);
      else if (isProtected(e, now)) prot.push(e);
      else free.push(e);
    });
    /* pinned 与保护期内的条目都不淘汰。 */
    if (pinned.length + prot.length >= data.cap)
      return { evicted: evicted, overflow: true, protectedKept: prot.length };
    var keepFree = data.cap - pinned.length - prot.length;
    /* 未 pin 的按 score 升序、score 相同先淘汰 lastHit 更旧的（再相同看 updatedAt）。 */
    free.sort(function (x, y) {
      var d = rawScore(x) - rawScore(y);
      if (d) return d;
      var lx = Number(x.lastHit) || 0;
      var ly = Number(y.lastHit) || 0;
      if (lx !== ly) return lx - ly;
      return (Number(x.updatedAt) || 0) - (Number(y.updatedAt) || 0);
    });
    /* 升序排序后**前缀**就是被淘汰的那批（分数最低的先走），后缀是留下的 keepFree 条。 */
    var dropCount = free.length - keepFree;
    var dropped = free.slice(0, dropCount);
    dropped.forEach(function (e) {
      evicted.push({ id: str(e.id), title: str(e.title), score: scoreOf(e) });
    });
    var kept = free.slice(dropCount);
    /* 保留原文件顺序（只按引用筛掉被淘汰的），避免每次写入都把库重排一遍；
       提议与保护期内的条目一律留下。 */
    data.entries = data.entries.filter(function (e) {
      if (isPending(e) || e.pinned) return true;
      if (isProtected(e, now)) return true;
      return kept.indexOf(e) >= 0;
    });
    if (evicted.length) pushEvictLog(data, evicted, now);
    return { evicted: evicted, overflow: false, protectedKept: prot.length };
  }
  /* 淘汰记录：写进文件的 log（新的在前，最多 EVICT_LOG_MAX 条），弹窗底部「最近淘汰」可回看。 */
  function pushEvictLog(data, evicted, nowMs) {
    if (!Array.isArray(data.log)) data.log = [];
    var at = Number(nowMs) || Date.now();
    for (var i = evicted.length - 1; i >= 0; i--) {
      var it = evicted[i] || {};
      data.log.unshift({
        at: at,
        id: str(it.id),
        title: str(it.title),
        score: Number(it.score) || 0,
      });
    }
    if (data.log.length > EVICT_LOG_MAX) data.log = data.log.slice(0, EVICT_LOG_MAX);
  }

  /* ───────────────────────── 读 / 写 ───────────────────────── */

  function readRaw(p) {
    var a = api();
    if (!p || !a || typeof a.fileReadText !== "function")
      return Promise.resolve({ exists: false, content: "" });
    return Promise.resolve(a.fileReadText(p)).then(
      function (r) {
        return { exists: !!(r && r.exists), content: str(r && r.content) };
      },
      function () {
        return { exists: false, content: "" };
      },
    );
  }
  function writeRaw(p, text) {
    var a = api();
    if (!p || !a || typeof a.fileWriteText !== "function") return Promise.resolve(false);
    return Promise.resolve(a.fileWriteText(p, str(text))).then(
      function (r) {
        return !!(r && r.ok !== false);
      },
      function () {
        return false;
      },
    );
  }
  /* 落盘成功即广播：左栏「AI 事实库」行据此刷新条数（不必整面重渲染，不打断用户输入）。 */
  function notifySaved(file, canvasId) {
    try {
      if (typeof document === "undefined" || !document.dispatchEvent) return;
      var detail = { file: str(file), canvasId: str(canvasId) };
      var ev = null;
      try {
        ev = new CustomEvent("aifact:saved", { detail: detail });
      } catch (_) {
        if (typeof document.createEvent === "function") {
          ev = document.createEvent("CustomEvent");
          ev.initCustomEvent("aifact:saved", false, false, detail);
        }
      }
      if (ev) document.dispatchEvent(ev);
    } catch (_) {}
  }

  /* 读库：{ ok, dir, file, data, exists, error?, backup? }。
     不存在 / 读不到 / 坏档都当空库（不抛）：坏档先备份成 ai-facts.json.bak 再当空库，
     下次写入时才会真正重写 ai-facts.json —— 绝不静默丢掉用户手改的内容。 */
  function load(canvasIdArg, opts) {
    /* 先单独判 id：工具侧两种不可用都回同一句「当前没有绑定画布」（口径见文件头），
       但界面要把它们分开讲 —— 没有绑定画布 ≠ 这张画布还没选文件夹，所以另给一个
       机器可读的 reason（"no-canvas" / "no-folder"）供弹窗选文案。 */
    var id = idOf(canvasIdArg);
    if (!id)
      return Promise.resolve({
        ok: false,
        dir: "",
        file: "",
        data: emptyData(),
        exists: false,
        error: T(NB),
        reason: "no-canvas",
      });
    return pathOf(id, opts).then(function (p) {
      if (!p || !p.file)
        return {
          ok: false,
          dir: "",
          file: "",
          data: emptyData(),
          exists: false,
          error: T(NB),
          reason: "no-folder",
        };
      return readRaw(p.file).then(function (r) {
        var raw = str(r.content);
        if (!r.exists || !raw.trim())
          return { ok: true, dir: p.dir, file: p.file, data: emptyData(), exists: false };
        var parsed = null;
        var bad = false;
        try {
          parsed = JSON.parse(raw);
        } catch (e) {
          bad = true;
        }
        if (!bad && (!parsed || typeof parsed !== "object" || Array.isArray(parsed))) bad = true;
        if (bad) {
          var bak = p.file + BAK_SUFFIX;
          return writeRaw(bak, raw).then(function () {
            return {
              ok: true,
              dir: p.dir,
              file: p.file,
              data: emptyData(),
              exists: false,
              backup: bak,
            };
          });
        }
        return { ok: true, dir: p.dir, file: p.file, data: normData(parsed), exists: true };
      });
    });
  }

  /* 落盘：先归一化（cap 夹紧 / 条目过滤补字段），再写 JSON。返回 Promise<boolean>。
     silent 解析：程序化保存不弹目录选择 —— 路径本来就已经定好，弹窗只该由用户点出来。 */
  function save(canvasIdArg, data) {
    return pathOf(canvasIdArg, { silent: true }).then(function (p) {
      if (!p || !p.file) return false;
      var norm = normData(data);
      return writeRaw(p.file, JSON.stringify(norm, null, 2) + "\n").then(function (ok) {
        if (ok) notifySaved(p.file, p.canvasId);
        return ok;
      });
    });
  }
  /* op 内部落盘（lib.file 已定，不必再走一次路径解析）。 */
  function saveLib(lib) {
    return writeRaw(lib.file, JSON.stringify(normData(lib.data), null, 2) + "\n").then(
      function (ok) {
        if (ok) notifySaved(lib.file, lib.canvasId);
        return ok;
      },
    );
  }

  /* ───────────────────────── 检索匹配 ───────────────────────── */

  function isCjk(ch) {
    var c = ch.charCodeAt(0);
    return (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff);
  }
  /* 分词：按空白 / 标点切；中文按 2 字滑窗（中文不用空格断词，整句当一整个 token 会永远查不到）。 */
  function tokensOf(q) {
    var s = str(q).toLowerCase();
    var out = [];
    var buf = "";
    function flush() {
      if (buf) {
        out.push(buf);
        buf = "";
      }
    }
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (isCjk(ch)) {
        flush();
        var j = i;
        while (j < s.length && isCjk(s.charAt(j))) j++;
        var run = s.slice(i, j);
        if (run.length <= 2) out.push(run);
        else for (var k = 0; k + 2 <= run.length; k++) out.push(run.substr(k, 2));
        i = j - 1;
      } else if (/[a-z0-9_]/.test(ch)) {
        buf += ch;
      } else {
        flush(); /* 空白与标点都是分隔符 */
      }
    }
    flush();
    /* 去重（滑窗常撞车），空 token 不进表 */
    var seen = {};
    var uniq = [];
    out.forEach(function (t) {
      if (!t || seen[t]) return;
      seen[t] = 1;
      uniq.push(t);
    });
    return uniq;
  }
  /* 大小写不敏感子串命中，或全部 token 都命中（多词查询要都出现，避免一条无关键也冒出来）。 */
  function matchEntry(e, q, toks) {
    var hay = (str(e.title) + "\n" + str(e.text)).toLowerCase();
    if (!hay) return false;
    if (hay.indexOf(str(q).toLowerCase()) >= 0) return true;
    if (!toks.length) return false;
    for (var i = 0; i < toks.length; i++) if (hay.indexOf(toks[i]) < 0) return false;
    return true;
  }
  function entryById(data, id) {
    var k = str(id);
    for (var i = 0; i < data.entries.length; i++)
      if (str(data.entries[i].id) === k) return data.entries[i];
    return null;
  }
  /* 列表项（工具 / 界面共用一份字段表）。 */
  function briefOf(e) {
    return {
      id: str(e.id),
      title: str(e.title),
      text: str(e.text),
      tags: tagsOf(e.tags),
      type: str(e.type),
      src: str(e.src),
      status: isPending(e) ? "pending" : "active",
      hits: Math.max(0, Number(e.hits) || 0),
      hit: Math.round(weightOf(e) * 10) / 10,
      lastHit: Math.max(0, Number(e.lastHit) || 0),
      pinned: !!e.pinned,
      score: scoreOf(e),
      inProtection: isProtected(e),
    };
  }
  function fullOf(e) {
    var b = briefOf(e);
    b.createdAt = Math.max(0, Number(e.createdAt) || 0);
    b.updatedAt = Math.max(0, Number(e.updatedAt) || 0);
    return b;
  }
  function clampLimit(v) {
    var n = Math.floor(Number(v));
    if (!isFinite(n) || n <= 0) return Q_LIMIT_DEFAULT;
    return Math.min(n, Q_LIMIT_MAX);
  }
  /* upsert 查找：带 id 且命中 → 那一条；否则按归一化标题匹配（同一语义）；都没命中 → null（新建）。 */
  function findForWrite(data, id, title) {
    var k = str(id).trim();
    if (k) {
      var byId = entryById(data, k);
      if (byId) return byId;
    }
    var key = normTitle(title);
    if (!key) return null;
    for (var i = 0; i < data.entries.length; i++)
      if (normTitle(data.entries[i].title) === key) return data.entries[i];
    return null;
  }
  /* ids 入参兼容 { ids:[…] } 与单个 { id }。 */
  function idsOf(params) {
    var out = [];
    var raw = params && params.ids;
    if (Array.isArray(raw))
      raw.forEach(function (x) {
        var s = str(x).trim();
        if (s) out.push(s);
      });
    var one = params && str(params.id).trim();
    if (one && out.indexOf(one) < 0) out.push(one);
    return out;
  }

  /* ───────────────────────── 动作实现 ───────────────────────── */

  function opList(lib) {
    return {
      ok: true,
      dir: lib.dir,
      file: lib.file,
      cap: lib.data.cap,
      count: activeEntries(lib.data).length,
      pending: pendingEntries(lib.data).length,
      /* list 不计数：列全部只读，不改 hits / lastHit；待确认的提议不进 list（还没确认，不该当事实用）。 */
      entries: activeEntries(lib.data).map(briefOf),
    };
  }

  function opQuery(lib, params) {
    var q = str(params.q).trim();
    var limit = clampLimit(params.limit);
    var toks = tokensOf(q);
    var matched = [];
    if (q) {
      activeEntries(lib.data).forEach(function (e) {
        if (matchEntry(e, q, toks)) matched.push(e);
      });
      /* 常被查的先给：score 降序，同分按 lastHit 新的先给。 */
      matched.sort(function (x, y) {
        var d = rawScore(y) - rawScore(x);
        if (d) return d;
        return (Number(y.lastHit) || 0) - (Number(x.lastHit) || 0);
      });
    }
    var out = matched.slice(0, limit);
    var found = matched.length;
    if (!out.length) {
      /* 查不到任何条目：不动文件（空查询不该产生一次写盘，也不该留下空 lastHit）。 */
      return {
        ok: true,
        dir: lib.dir,
        file: lib.file,
        found: found,
        count: 0,
        entries: [],
      };
    }
    /* 计数口径：只给**真正返回给调用方**的那几条 hits+1 —— limit 之外没被读到的条目
       不该因为这次查询涨分（否则下次排序会把「没人读过」的条目越推越前）。 */
    var now = Date.now();
    out.forEach(function (e) {
      e.hits = Math.max(0, Number(e.hits) || 0) + 1;
      e.hit = weightOf(e) + 1; /* 读 +1 */
      e.lastHit = now;
    });
    var ids = out.map(function (e) {
      return str(e.id);
    });
    return saveLib(lib).then(function () {
      return {
        ok: true,
        dir: lib.dir,
        file: lib.file,
        found: found,
        count: ids.length,
        entries: ids
          .map(function (id) {
            var e = entryById(lib.data, id);
            return e ? briefOf(e) : null;
          })
          .filter(function (x) {
            return !!x;
          }),
      };
    });
  }

  function opGet(lib, params) {
    var id = str(params.id).trim();
    var e = entryById(lib.data, id);
    if (!e) throw new Error(T("AI 事实库中没有该条例：") + id);
    e.hits = Math.max(0, Number(e.hits) || 0) + 1;
    e.hit = weightOf(e) + 1; /* 读 +1 */
    e.lastHit = Date.now();
    return saveLib(lib).then(function () {
      var fresh = entryById(lib.data, id) || e;
      return { ok: true, dir: lib.dir, file: lib.file, record: fullOf(fresh) };
    });
  }

  function opWrite(lib, params) {
    var list = Array.isArray(params.records) ? params.records.slice() : [];
    if (params.record && typeof params.record === "object") list.push(params.record);
    var items = [];
    list.forEach(function (it) {
      if (!it || typeof it !== "object" || Array.isArray(it)) return;
      var title = str(it.title).trim();
      /* 正文两种叫法都收：工具侧口径是 text，新口径叫 body，落到文件里统一是 text。 */
      var text = it.text == null ? str(it.body) : str(it.text);
      if (!title && !text.trim()) return; /* 空项丢掉：不因为一条脏数据让整批写入失败 */
      items.push({
        id: str(it.id).trim(),
        title: title,
        text: text,
        tags: tagsOf(it.tags),
        type: str(it.type).trim(),
        src: str(it.src == null || it.src === "" ? it.source : it.src).trim(),
      });
    });
    if (!items.length)
      throw new Error(T("写入需要给出 records 或 record（标题或正文不能都为空）"));
    var now = Date.now();
    var written = [];
    var hints = [];
    items.forEach(function (it) {
      var exist = findForWrite(lib.data, it.id, it.title);
      if (exist) {
        /* 更新：保留 hits / lastHit / pinned / createdAt，刷标题 / 正文 / 标签 / 类型 / 来源 / updatedAt。 */
        exist.title = it.title;
        exist.text = it.text;
        if (it.tags.length) exist.tags = it.tags;
        if (it.type) exist.type = it.type;
        if (it.src) exist.src = it.src;
        exist.hit = weightOf(exist) + 0.5; /* 写 +0.5 */
        exist.updatedAt = now;
        if (longBody(it.text)) hints.push(str(exist.title));
        written.push({ id: str(exist.id), title: str(exist.title), updated: true, updatedAt: now });
        return;
      }
      var e = normEntry({
        id: it.id || "",
        title: it.title,
        text: it.text,
        tags: it.tags,
        type: it.type,
        src: it.src,
        status: "active",
        hit: 0.5, /* 写 +0.5 */
        hits: 0,
        lastHit: 0,
        protectionUntil: now + PROTECT_DAYS * DAY_MS, /* 零命中新条目：7 天保护期 */
        pinned: false,
        createdAt: now,
        updatedAt: now,
      });
      if (!e) return;
      lib.data.entries.push(e);
      if (longBody(it.text)) hints.push(str(e.title));
      written.push({ id: str(e.id), title: str(e.title), updated: false, updatedAt: now });
    });
    var ev = evict(lib.data);
    return saveLib(lib).then(function (ok) {
      if (!ok) throw new Error(T("AI 事实库写入失败"));
      return {
        ok: true,
        dir: lib.dir,
        file: lib.file,
        count: activeEntries(lib.data).length,
        pending: pendingEntries(lib.data).length,
        cap: lib.data.cap,
        written: written,
        evicted: ev.evicted,
        protectedKept: ev.protectedKept,
        overflow: !!ev.overflow,
        hint: hints.length ? bodyHintText(hints) : "",
        note: ev.overflow
          ? T("固定（pin）的条例已占满上限（{cap}），超额条目保留不再淘汰", {
              cap: String(lib.data.cap),
            }) + protectionNote(ev.protectedKept)
          : "",
      };
    });
  }
  /* 正文超长提示（软提示，不拦写入）：超过约 200 字就提醒精简成「一句能传意」的条例。 */
  function longBody(text) {
    return str(text).trim().length > BODY_HINT_LEN;
  }
  function bodyHintText(titles) {
    return (
      T("有 {n} 条条例正文超过约 200 字，建议精简成一句能传意的话（已照常保存）：", {
        n: String(titles.length),
      }) + titles.slice(0, 3).join("、")
    );
  }
  /* 保护期补充说明（挂在 overflow 回执后面）：让「为什么留着超额」说清楚。 */
  function protectionNote(n) {
    var k = Math.max(0, Number(n) || 0);
    if (!k) return "";
    return (
      " " +
      T("另有 {n} 条处于零命中保护期（{days} 天内不淘汰）", {
        n: String(k),
        days: String(PROTECT_DAYS),
      })
    );
  }

  function opDelete(lib, params) {
    var ids = idsOf(params);
    if (!ids.length) return { ok: true, deleted: 0, count: lib.data.entries.length };
    var before = lib.data.entries.length;
    lib.data.entries = lib.data.entries.filter(function (e) {
      return ids.indexOf(str(e.id)) < 0;
    });
    var deleted = before - lib.data.entries.length;
    if (!deleted) return { ok: true, deleted: 0, count: before };
    return saveLib(lib).then(function () {
      return { ok: true, deleted: deleted, count: lib.data.entries.length };
    });
  }

  function opPin(lib, params) {
    var ids = idsOf(params);
    var on = params.on === undefined ? true : !!params.on;
    if (!ids.length) return { ok: true, pinned: 0, count: lib.data.entries.length };
    var n = 0;
    var changed = false;
    lib.data.entries.forEach(function (e) {
      if (ids.indexOf(str(e.id)) < 0) return;
      n++;
      /* pin 只表示「别淘汰它」，不是内容编辑：不刷 updatedAt（分数的时间基准不该被它顶新）。 */
      if (!!e.pinned !== on) {
        e.pinned = on;
        changed = true;
      }
    });
    if (!changed) return { ok: true, pinned: n, count: lib.data.entries.length };
    return saveLib(lib).then(function () {
      return { ok: true, pinned: n, count: lib.data.entries.length };
    });
  }

  /* ── 待确认（propose / confirm / reject）─────────────────────────────────
     AI 提议（propose）出来的条例先落成 status:"pending"，进弹窗顶部的「待确认」区：
     **不参与查库、不占上限、不参与淘汰**；用户在界面上确认（confirm）后才落成 active，
     那一刻记「写 +0.5」并给它 7 天零命中保护期（createdAt 保留提议时间）。 */
  function opPropose(lib, params) {
    var list = Array.isArray(params.records) ? params.records.slice() : [];
    if (params.record && typeof params.record === "object") list.push(params.record);
    var items = [];
    list.forEach(function (it) {
      if (!it || typeof it !== "object" || Array.isArray(it)) return;
      var title = str(it.title).trim();
      var text = it.text == null ? str(it.body) : str(it.text);
      if (!title && !text.trim()) return;
      items.push({
        id: str(it.id).trim(),
        title: title,
        text: text,
        tags: tagsOf(it.tags),
        type: str(it.type).trim(),
        src:
          str(it.src == null || it.src === "" ? it.source : it.src).trim() || T("AI 提议"),
      });
    });
    if (!items.length)
      throw new Error(T("写入需要给出 records 或 record（标题或正文不能都为空）"));
    var now = Date.now();
    var proposed = [];
    var hints = [];
    items.forEach(function (it) {
      var exist = findForWrite(lib.data, it.id, it.title);
      if (exist) {
        exist.title = it.title;
        exist.text = it.text;
        if (it.tags.length) exist.tags = it.tags;
        if (it.type) exist.type = it.type;
        if (it.src) exist.src = it.src;
        /* 已确认的条目被重新提议 = 退回待确认：让用户再看一眼（不删正文，不丢原读数）。 */
        exist.status = "pending";
        exist.updatedAt = now;
        if (longBody(it.text)) hints.push(str(exist.title));
        proposed.push({ id: str(exist.id), title: str(exist.title), updated: true });
        return;
      }
      var e = normEntry({
        id: it.id || "",
        title: it.title,
        text: it.text,
        tags: it.tags,
        type: it.type,
        src: it.src,
        status: "pending",
        hit: 0, /* 提议还没落库：不给写 +0.5（确认时再记） */
        hits: 0,
        lastHit: 0,
        protectionUntil: 0,
        pinned: false,
        createdAt: now,
        updatedAt: now,
      });
      if (!e) return;
      lib.data.entries.push(e);
      if (longBody(it.text)) hints.push(str(e.title));
      proposed.push({ id: str(e.id), title: str(e.title), updated: false });
    });
    var pending = pendingEntries(lib.data).length;
    return saveLib(lib).then(function (ok) {
      if (!ok) throw new Error(T("AI 事实库写入失败"));
      return {
        ok: true,
        dir: lib.dir,
        file: lib.file,
        proposed: proposed,
        pending: pending,
        hint: hints.length ? bodyHintText(hints) : "",
        note:
          pending > PENDING_MAX
            ? T("待确认的提议已超过 {cap} 条，请先确认或清掉一些", { cap: String(PENDING_MAX) })
            : "",
      };
    });
  }

  function opConfirm(lib, params) {
    var ids = idsOf(params);
    var all = !!params.all || !ids.length;
    var now = Date.now();
    var confirmed = [];
    lib.data.entries.forEach(function (e) {
      if (!isPending(e)) return;
      if (!all && ids.indexOf(str(e.id)) < 0) return;
      e.status = "active";
      e.hit = weightOf(e) + 0.5; /* 确认即落库：写 +0.5 */
      if (!Number(e.createdAt)) e.createdAt = now;
      e.updatedAt = now;
      if (!Number(e.protectionUntil) || Number(e.protectionUntil) < now)
        e.protectionUntil = now + PROTECT_DAYS * DAY_MS;
      confirmed.push({ id: str(e.id), title: str(e.title) });
    });
    if (!confirmed.length) return { ok: true, confirmed: [], count: activeEntries(lib.data).length };
    var ev = evict(lib.data);
    return saveLib(lib).then(function (ok) {
      if (!ok) throw new Error(T("AI 事实库写入失败"));
      return {
        ok: true,
        dir: lib.dir,
        file: lib.file,
        confirmed: confirmed,
        count: activeEntries(lib.data).length,
        pending: pendingEntries(lib.data).length,
        evicted: ev.evicted,
        protectedKept: ev.protectedKept,
        overflow: !!ev.overflow,
        note: ev.overflow
          ? T("固定（pin）的条例已占满上限（{cap}），超额条目保留不再淘汰", {
              cap: String(lib.data.cap),
            }) + protectionNote(ev.protectedKept)
          : "",
      };
    });
  }

  /* 驳回提议：直接删掉 pending 条目（确认过的不受影响；无 ids / all:true = 清空待确认区）。 */
  function opReject(lib, params) {
    var ids = idsOf(params);
    var all = !!params.all || !ids.length;
    var before = lib.data.entries.length;
    lib.data.entries = lib.data.entries.filter(function (e) {
      if (!isPending(e)) return true;
      if (!all && ids.indexOf(str(e.id)) < 0) return true;
      return false;
    });
    var n = before - lib.data.entries.length;
    if (!n) return { ok: true, rejected: 0, pending: pendingEntries(lib.data).length };
    return saveLib(lib).then(function () {
      return { ok: true, rejected: n, pending: pendingEntries(lib.data).length };
    });
  }

  /* 工具入口：{ action, params } → Promise<result>。
     所有错误一律用 Error 抛出（路由层转成 ok:false + error 文本给 AI），这里绝不吞。 */
  function op(args, canvasIdArg) {
    var a = args && typeof args === "object" ? args : {};
    var action = str(a.action).trim();
    var params = a.params && typeof a.params === "object" ? a.params : {};
    return Promise.resolve().then(function () {
      var id = idOf(canvasIdArg);
      if (!id) throw new Error(T(NB));
      /* silent 载入：工具侧绝不弹目录选择（Agent 不该替用户选落点）。 */
      return load(id, { silent: true }).then(function (r) {
        if (!r || r.ok === false || !r.file) throw new Error(T(NB));
        var lib = { canvasId: id, dir: r.dir, file: r.file, data: r.data || emptyData() };
        if (action === "list") return opList(lib);
        if (action === "query") return opQuery(lib, params);
        if (action === "get") return opGet(lib, params);
        if (action === "write") return opWrite(lib, params);
        if (action === "delete") return opDelete(lib, params);
        if (action === "pin") return opPin(lib, params);
        if (action === "propose") return opPropose(lib, params);
        if (action === "confirm") return opConfirm(lib, params);
        if (action === "reject") return opReject(lib, params);
        if (action === "export") return exportLib(id);
        throw new Error(T("未知动作：") + action);
      });
    });
  }

  /* 左栏条数：不存在 / 不可用都返回 0（不创建文件、不弹窗、silent）。
     只数**已确认**条目（与弹窗「条数 n / 上限 cap」同口径）；待确认的提议在弹窗里单独显示。 */
  function countOf(canvasIdArg) {
    return load(canvasIdArg, { silent: true }).then(
      function (r) {
        return r && r.ok !== false && r.data ? activeEntries(r.data).length : 0;
      },
      function () {
        return 0;
      },
    );
  }

  /* ───────────────────────── 查阅弹窗（专家团左栏入口） ─────────────────────────
     用 app.js 的 openOverlay 建 persistent + 可最小化浮层（默认即可最小化）：
     这是带输入（标题 / 正文 / cap）的窗，绝不挂「点外部即关」，出口 = 窗内「关闭」按钮 /
     窗壳 ✕。所有改动即时落盘并刷新列表（列表即磁盘现状，不留「未保存」的中间态）。 */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function btn(cls, text, fn, title) {
    var b = el("button", cls || "mini", text);
    b.type = "button";
    if (title) {
      b.title = title;
      b.setAttribute("aria-label", title);
    }
    b.addEventListener("click", function (ev) {
      if (ev && ev.preventDefault) ev.preventDefault();
      fn(ev);
    });
    return b;
  }
  function readActive() {
    try {
      return document.activeElement || null;
    } catch (e) {
      return null;
    }
  }

  function openDlg(canvasIdArg) {
    if (typeof document === "undefined") return null;
    if (typeof openOverlay !== "function") return null;
    var id = idOf(canvasIdArg);
    openOverlay(T("AI 事实库"), { persistent: true });
    var body = document.getElementById("ovBody");
    if (!body) return null;
    body.innerHTML = "";
    var foot = document.getElementById("ovFoot");
    if (foot) {
      foot.innerHTML = "";
      foot.appendChild(
        btn("mini", T("关闭"), function () {
          if (typeof closeOverlay === "function") closeOverlay();
        }),
      );
    }
    var root = el("div", "aif");
    body.appendChild(root);

    var state = {
      canvasId: id,
      ok: false,
      reason: "",
      dir: "",
      file: "",
      data: emptyData(),
      q: "",
      editingId: "",
      creating: false,
    };

    /* ── 顶部信息行：文件绝对路径 + 条数 / 上限 + cap 输入 + 搜索框 + 新建 ── */
    var head = el("div", "aif-head");
    var pathIn = document.createElement("input");
    pathIn.type = "text";
    pathIn.readOnly = true;
    pathIn.className = "aif-path";
    pathIn.spellcheck = false;
    head.appendChild(pathIn);

    var meta = el("div", "aif-meta");
    var countEl = el("span", "aif-count", "");
    meta.appendChild(countEl);
    var capIn = document.createElement("input");
    capIn.type = "number";
    capIn.min = String(CAP_MIN);
    capIn.max = String(CAP_MAX);
    capIn.className = "aif-cap";
    capIn.title = T("上限（超出后先淘汰未固定 pin 的低分条例；固定（★）的永不淘汰）");
    capIn.setAttribute("aria-label", T("上限"));
    meta.appendChild(capIn);
    var search = document.createElement("input");
    search.type = "text";
    search.className = "aif-search";
    search.placeholder = T("搜索条例（标题或正文）…");
    search.spellcheck = false;
    meta.appendChild(search);
    meta.appendChild(
      btn("mini primary", T("＋ 新建条例"), function () {
        state.creating = true;
        state.editingId = "";
        render();
      }),
    );
    meta.appendChild(
      btn(
        "mini",
        T("导出…"),
        function () {
          exportLib(state.canvasId).then(function (r) {
            if (r && r.ok) warn(T("已导出到 {file}", { file: str(r.file) }), "ok");
            else if (!(r && r.canceled)) warn((r && r.error) || T("导出失败"), "err");
          });
        },
        T("把整库另存成一份 JSON（备份 / 迁移用）"),
      ),
    );
    head.appendChild(meta);
    root.appendChild(head);

    /* 三段竖直排（顺序即口径）：待确认区（AI propose 出来的提议）· 库列表 · 最近淘汰。 */
    var prop = el("div", "aif-prop");
    root.appendChild(prop);
    var list = el("div", "aif-list");
    root.appendChild(list);
    var logBox = el("div", "aif-log");
    root.appendChild(logBox);

    /* ── 渲染 ── */
    function pendingText() {
      var n = pendingEntries(state.data).length;
      return n ? " · " + T("待确认 {n} 条", { n: String(n) }) : "";
    }
    function paintHead() {
      pathIn.value = state.file || "";
      pathIn.title = state.file || "";
      countEl.textContent =
        T("条数 {n} / 上限 {cap}", {
          n: String(activeEntries(state.data).length),
          cap: String(state.data.cap),
        }) + pendingText();
      if (readActive() !== capIn) capIn.value = String(state.data.cap);
      search.disabled = !state.ok;
    }

    function emptyState() {
      var box = el("div", "aif-empty");
      if (!state.ok) {
        /* 不可用的原因分两种，文案要分开：没有绑定画布（根本不知道该给谁建库）与
           这张画布还没有画布文件夹（等用户选一个）。判据是库层给的 reason，不是文案比对。 */
        var noCanvas = state.reason === "no-canvas";
        box.appendChild(el("div", "aif-empty-h", noCanvas ? T(NB) : T("AI 事实库还不可用")));
        box.appendChild(
          el(
            "div",
            "aif-empty-p",
            noCanvas
              ? T("先在左侧选中一张画布（AI 事实库一张画布一份），再来建库。")
              : T("这张画布还没有画布文件夹（顶栏「工作目录」为空）。先选一个文件夹，AI 事实库就会建在它的「团队事实库/AI」里。"),
          ),
        );
        box.appendChild(
          btn("mini primary", T("选择画布文件夹…"), function () {
            /* 非静默 pathOf：这一步就是要弹目录选择，选定结果写进 S.config.aiFacts。 */
            pathOf(state.canvasId).then(function (p) {
              if (!p || !p.file) return;
              return refresh();
            });
          }),
        );
        return box;
      }
      if (str(state.q).trim()) {
        box.appendChild(el("div", "aif-empty-h", T("没有匹配的条例")));
        box.appendChild(el("div", "aif-empty-p", T("换个关键词，或清空搜索框看全部。")));
        return box;
      }
      box.appendChild(el("div", "aif-empty-h", T("还没有条例")));
      box.appendChild(
        el(
          "div",
          "aif-empty-p",
          T("Agent 在建架构 / 建工作流时会自动把关键结论沉淀成极简条例；也可以在这里手动新增。"),
        ),
      );
      return box;
    }

    /* 内联编辑器（新建与编辑共用）：标题 + 正文 + 类型 / 标签 / 来源（检索辅助，可留空）+ 保存 / 取消。 */
    function editBox(e, isNew) {
      var box = el("div", "aif-edit");
      var ti = document.createElement("input");
      ti.type = "text";
      ti.className = "aif-in";
      ti.spellcheck = false;
      ti.placeholder = T("标题（一行，便于检索）");
      ti.value = e ? str(e.title) : "";
      var ta = document.createElement("textarea");
      ta.className = "aif-in aif-ta";
      ta.rows = 4;
      ta.placeholder = T("正文（给 AI 读的极简条例，一行到几行）");
      ta.value = e ? str(e.text) : "";
      box.appendChild(ti);
      box.appendChild(ta);

      /* 类型 / 标签 / 来源：三个小输入并排（都是可选），落到条目上供检索与「这条哪来的」追溯。 */
      var fields = el("div", "aif-fields");
      var tyIn = document.createElement("input");
      tyIn.type = "text";
      tyIn.className = "aif-in";
      tyIn.spellcheck = false;
      tyIn.placeholder = T("类型（架构 / 约定 / 命令 / 坑…）");
      tyIn.value = e ? str(e.type) : "";
      var tgIn = document.createElement("input");
      tgIn.type = "text";
      tgIn.className = "aif-in";
      tgIn.spellcheck = false;
      tgIn.placeholder = T("标签（逗号分隔，最多 8 个）");
      tgIn.value = e ? tagsOf(e.tags).join(", ") : "";
      var srcIn = document.createElement("input");
      srcIn.type = "text";
      srcIn.className = "aif-in";
      srcIn.spellcheck = false;
      srcIn.placeholder = T("来源（哪份文件 / 哪次确认）");
      srcIn.value = e ? str(e.src) : "";
      fields.appendChild(tyIn);
      fields.appendChild(tgIn);
      fields.appendChild(srcIn);
      box.appendChild(fields);

      var acts = el("div", "aif-acts");
      acts.appendChild(
        btn("mini primary", T("保存"), function () {
          var title = str(ti.value).trim();
          var text = str(ta.value);
          if (!title && !text.trim()) {
            warn(T("标题或正文不能都为空"));
            return;
          }
          /* 正文超长是**软提示**：照常保存，只提醒「一句能传意」的条例更好用。 */
          if (longBody(text))
            warn(T("正文超过约 {n} 字，建议精简成一句能传意的话", { n: String(BODY_HINT_LEN) }));
          /* 走 op write（与 Agent 同一条路径）：不带 id 就按归一化标题 upsert，
             所以「新建」撞上同名条例时会更新那一条 —— 下面按本地预判给对应的回执。 */
          var dup = isNew ? findForWrite(state.data, "", title) : null;
          var rec = {
            title: title,
            text: text,
            type: str(tyIn.value).trim(),
            tags: tagsOf(tgIn.value),
            src: str(srcIn.value).trim(),
          };
          if (!(isNew && !dup)) rec.id = str((dup && dup.id) || (e && e.id) || "");
          op({ action: "write", params: { records: [rec] } }, state.canvasId).then(
            function () {
              warn(dup ? T("已更新同名条例") : T("已保存条例"), "ok");
              state.creating = false;
              state.editingId = "";
              return refresh();
            },
            function (err) {
              warn(errText(err) || T("保存失败"), "err");
            },
          );
        }),
      );
      acts.appendChild(
        btn("mini", T("取消"), function () {
          state.creating = false;
          state.editingId = "";
          render();
        }),
      );
      box.appendChild(acts);
      return box;
    }

    function rowEl(e) {
      var row = el("div", "aif-row" + (e.pinned ? " pinned" : ""));
      var top = el("div", "aif-row-h");
      top.appendChild(el("span", "aif-name", str(e.title) || T("（无标题）")));
      top.appendChild(
        el(
          "span",
          "aif-score",
          T("命中 {n}", { n: String(Math.max(0, Number(e.hits) || 0)) }) +
            " · " +
            T("权重 {n}", { n: (Math.round(weightOf(e) * 10) / 10).toFixed(1) }) +
            " · " +
            T("分数 {n}", { n: (scoreOf(e) || 0).toFixed(1) }),
        ),
      );
      var acts = el("div", "aif-row-acts");
      acts.appendChild(
        btn(
          "mini aif-pin" + (e.pinned ? " on" : ""),
          e.pinned ? "★" : "☆",
          function () {
            op({ action: "pin", params: { ids: [str(e.id)], on: !e.pinned } }, state.canvasId).then(
              function () {
                return refresh();
              },
              function (err) {
                warn(errText(err) || T("保存失败"), "err");
              },
            );
          },
          e.pinned
            ? T("取消固定（允许按分数淘汰）")
            : T("固定这条（永不淘汰，也不受上限影响）"),
        ),
      );
      acts.appendChild(
        btn("mini", T("编辑"), function () {
          state.editingId = str(e.id);
          state.creating = false;
          render();
        }),
      );
      acts.appendChild(
        btn("mini danger", T("删除"), function () {
          if (typeof confirmDialog !== "function") return;
          Promise.resolve(
            confirmDialog(
              T("删除条例「{title}」？删除后不可恢复。", {
                title: str(e.title) || str(e.id),
              }),
              { title: T("删除条例"), okText: T("删除"), cancelText: T("取消"), danger: true },
            ),
          ).then(function (yes) {
            if (!yes) return;
            op({ action: "delete", params: { ids: [str(e.id)] } }, state.canvasId).then(
              function () {
                warn(T("已删除条例"), "ok");
                return refresh();
              },
              function (err) {
                warn(errText(err) || T("删除失败"), "err");
              },
            );
          });
        }),
      );
      top.appendChild(acts);
      row.appendChild(top);
      row.appendChild(el("div", "aif-text", str(e.text)));
      var chips = chipsOf(e);
      if (chips) row.appendChild(chips);
      return row;
    }

    /* 检索辅助行：类型 / 标签 / 来源 / 保护期（都缺就不占位）。 */
    function chipsOf(e) {
      var box = el("div", "aif-chips");
      if (str(e.type)) box.appendChild(el("span", "aif-chip", str(e.type)));
      tagsOf(e.tags).forEach(function (t) {
        box.appendChild(el("span", "aif-chip aif-chip-tag", "#" + t));
      });
      if (str(e.src)) box.appendChild(el("span", "aif-chip aif-chip-src", T("来源：") + str(e.src)));
      if (isProtected(e)) {
        var left = Math.max(0, Math.ceil((Number(e.protectionUntil) - Date.now()) / DAY_MS));
        box.appendChild(
          el("span", "aif-chip aif-chip-prot", T("零命中保护期（剩 {n} 天）", { n: String(left) })),
        );
      }
      return box.childNodes.length ? box : null;
    }
    function dateText(ts) {
      var n = Number(ts) || 0;
      if (!n) return "";
      try {
        return new Date(n).toLocaleString();
      } catch (e) {
        return "";
      }
    }

    /* ── 待确认区（AI propose 出来的提议）──
       整块常显在库列表之上（没有提议就不占位）；每条给「确认 / 驳回」，顶部给「全部确认 / 全部驳回」。 */
    function propRow(e) {
      var row = el("div", "aif-prop-row");
      var top = el("div", "aif-row-h");
      top.appendChild(el("span", "aif-name", str(e.title) || T("（无标题）")));
      top.appendChild(el("span", "aif-score", T("待确认")));
      var acts = el("div", "aif-row-acts");
      acts.appendChild(
        btn(
          "mini primary",
          T("确认"),
          function () {
            op({ action: "confirm", params: { ids: [str(e.id)] } }, state.canvasId).then(
              function () {
                warn(T("已确认该条例"), "ok");
                return refresh();
              },
              function (err) {
                warn(errText(err) || T("保存失败"), "err");
              },
            );
          },
          T("确认这条 AI 提议，收进库里"),
        ),
      );
      acts.appendChild(
        btn(
          "mini danger",
          T("驳回"),
          function () {
            op({ action: "reject", params: { ids: [str(e.id)] } }, state.canvasId).then(
              function () {
                warn(T("已驳回该提议"), "ok");
                return refresh();
              },
              function (err) {
                warn(errText(err) || T("删除失败"), "err");
              },
            );
          },
          T("驳回这条提议（直接删掉）"),
        ),
      );
      top.appendChild(acts);
      row.appendChild(top);
      row.appendChild(el("div", "aif-text", str(e.text)));
      var chips = chipsOf(e);
      if (chips) row.appendChild(chips);
      return row;
    }

    function renderProp() {
      prop.innerHTML = "";
      if (!state.ok) return;
      var rows = pendingEntries(state.data);
      if (!rows.length) return;
      var h = el("div", "aif-prop-h");
      h.appendChild(el("span", "aif-sub", T("待确认（{n} 条 AI 提议）", { n: String(rows.length) })));
      h.appendChild(
        btn(
          "mini primary",
          T("全部确认"),
          function () {
            op({ action: "confirm", params: { all: true } }, state.canvasId).then(
              function (r) {
                warn(
                  T("已确认 {n} 条提议", {
                    n: String(r && r.confirmed ? r.confirmed.length : 0),
                  }),
                  "ok",
                );
                return refresh();
              },
              function (err) {
                warn(errText(err) || T("保存失败"), "err");
              },
            );
          },
          T("把待确认区里的提议全部收进库"),
        ),
      );
      h.appendChild(
        btn("mini danger", T("全部驳回"), function () {
          op({ action: "reject", params: { all: true } }, state.canvasId).then(
            function () {
              warn(T("已清空待确认区"), "ok");
              return refresh();
            },
            function (err) {
              warn(errText(err) || T("删除失败"), "err");
            },
          );
        }),
      );
      prop.appendChild(h);
      rows.forEach(function (e) {
        prop.appendChild(propRow(e));
      });
    }

    /* ── 最近淘汰（写进文件的 log）：谁被淘汰了、当时的分数、什么时候 —— 可回看。 ── */
    function renderLog() {
      logBox.innerHTML = "";
      var logs = Array.isArray(state.data.log) ? state.data.log : [];
      if (!logs.length) return;
      logBox.appendChild(
        el("div", "aif-sub", T("最近淘汰（{n} 条）", { n: String(logs.length) })),
      );
      logs.forEach(function (it) {
        var row = el("div", "aif-log-row");
        row.appendChild(el("span", "aif-log-name", str(it.title) || str(it.id)));
        row.appendChild(
          el(
            "span",
            "aif-log-meta",
            T("分数 {n}", { n: (Number(it.score) || 0).toFixed(1) }) + " · " + dateText(it.at),
          ),
        );
        logBox.appendChild(row);
      });
    }

    function renderList() {
      list.innerHTML = "";
      if (!state.ok) {
        list.appendChild(emptyState());
        return;
      }
      if (state.creating) list.appendChild(editBox(null, true));
      /* 弹窗里的搜索是**纯浏览**：本地过滤，不计数、不写盘 ——
         「常被查」只由 Agent 的 query / get 决定（见文件头「命中计数」），
         用户在搜索框里打字不该改分数，也不该每敲一个字就写一次文件。 */
      var q = str(state.q).trim().toLowerCase();
      var rows = activeEntries(state.data).filter(function (e) {
        if (!q) return true;
        return (str(e.title) + "\n" + str(e.text)).toLowerCase().indexOf(q) >= 0;
      });
      /* 排序与工具侧一致：分数高的在前，同分按 lastHit 新的在前。 */
      rows.sort(function (x, y) {
        var d = rawScore(y) - rawScore(x);
        if (d) return d;
        return (Number(y.lastHit) || 0) - (Number(x.lastHit) || 0);
      });
      if (!rows.length && !state.creating) {
        list.appendChild(emptyState());
        return;
      }
      rows.forEach(function (e) {
        if (state.editingId && str(e.id) === state.editingId) list.appendChild(editBox(e, false));
        else list.appendChild(rowEl(e));
      });
    }

    function render() {
      paintHead();
      renderProp();
      renderList();
      renderLog();
    }

    /* 重新读盘再画：列表永远等于磁盘现状（没有「未保存」的中间态）。 */
    function refresh() {
      return load(state.canvasId, { silent: true }).then(
        function (r) {
          state.ok = !!(r && r.ok !== false && r.file);
          state.reason = str(r && r.reason);
          state.dir = str(r && r.dir);
          state.file = str(r && r.file);
          state.data = (r && r.data) || emptyData();
          render();
          return r;
        },
        function () {
          state.ok = false;
          state.reason = "no-folder";
          render();
          return null;
        },
      );
    }

    /* ── 事件：搜索 / cap（改动即校验 + 落盘） ── */
    search.addEventListener("input", function () {
      state.q = str(search.value);
      renderList();
    });
    capIn.addEventListener("change", function () {
      var n = Math.floor(Number(capIn.value));
      if (!isFinite(n) || n < CAP_MIN || n > CAP_MAX) {
        warn(T("上限必须是 1–1000 之间的整数"));
        capIn.value = String(state.data.cap);
        return;
      }
      state.data.cap = n;
      var ev = evict(state.data); /* 调小上限 = 立刻按淘汰规则削到新上限 */
      save(state.canvasId, state.data).then(
        function (ok) {
          if (!ok) {
            warn(T("保存失败"), "err");
            return;
          }
          if (ev.overflow)
            warn(
              T("固定（pin）的条例已占满上限（{cap}），超额条目保留不再淘汰", { cap: String(n) }) +
                protectionNote(ev.protectedKept),
            );
          else if (ev.evicted.length)
            warn(T("上限已改为 {cap}，淘汰 {n} 条低分条例", { cap: String(n), n: String(ev.evicted.length) }));
          else warn(T("上限已改为 {cap}", { cap: String(n) }), "ok");
          return refresh();
        },
        function () {
          warn(T("保存失败"), "err");
        },
      );
    });

    render();
    refresh();
    return root;
  }

  /* ───────────────── 导出 / 新口径公开接口（init · read · add · update · remove ·
     hit · propose · confirm · reject · export） ─────────────────

     新口径的这批名字都是既有内部实现的**薄封装**：读写一律走 op（与工具 / 界面同一条路径，
     绝不另开一条读写入口），因此口径、计数、淘汰、落盘守卫永远只有一份。
     既有接口（pathOf / load / save / op / scoreOf / countOf / openDlg / canvasId）原样保留：
     app-db.js 的 mtnode_facts 路由、app-teamview.js 的左栏入口、ai-facts-store.js 的固定文件
     都按这些名字接线，名字不可改。 */

  /* 导出：把整库（含 log）另存成一份 JSON 给用户备份 / 迁移（系统保存对话框选位置）。 */
  function exportLib(canvasIdArg) {
    var a = api();
    if (!a || typeof a.fileSaveDialog !== "function" || typeof a.fileWriteText !== "function")
      return Promise.resolve({ ok: false, error: T("当前环境不支持文件保存") });
    return load(canvasIdArg, { silent: true }).then(function (r) {
      if (!r || r.ok === false || !r.file) return { ok: false, error: T(NB) };
      if (!r.exists || !activeEntries(r.data).length)
        return { ok: false, error: T("库还是空的，没有可导出的条例") };
      var text = JSON.stringify(normData(r.data), null, 2) + "\n";
      var stamp = new Date().toISOString().slice(0, 10);
      return Promise.resolve(
        a.fileSaveDialog({
          title: T("导出 AI 事实库"),
          defaultName: "ai-facts-" + stamp + ".json",
          filters: [{ name: "JSON", extensions: ["json"] }],
        }),
      ).then(function (pick) {
        var dest = pick && str(pick.path).trim();
        if (!dest) return { ok: false, canceled: true };
        return Promise.resolve(a.fileWriteText(dest, text)).then(
          function (w) {
            if (w && w.ok === false) return { ok: false, error: T("导出失败") };
            return { ok: true, file: dest, count: activeEntries(r.data).length };
          },
          function (e) {
            return { ok: false, error: errText(e) || T("导出失败") };
          },
        );
      });
    });
  }

  /* init(workdir)：把这**一张画布**的库落点登记成给定文件夹（写进 S.config.aiFacts，随后跟着画布走）。
     只收绝对路径：相对路径会随进程工作目录漂移，宁可拒绝也不猜。 */
  function initLib(workdir, canvasIdArg) {
    var id = idOf(canvasIdArg);
    if (!id) return Promise.resolve({ ok: false, error: T(NB) });
    var dir = str(workdir).trim();
    if (!dir || !isAbs(dir))
      return Promise.resolve({ ok: false, error: T("请给出画布文件夹的绝对路径") });
    cfgSetDir(id, dir);
    persistConfig();
    return pathOf(id, { silent: true }).then(function (p) {
      return { ok: !!(p && p.file), canvasId: id, dir: str(p && p.dir), file: str(p && p.file) };
    });
  }

  /* read：{id} 取一条（读 +1）/ {ids:[…]} 批量取 / {q} 关键词查 / 都不给 = 列全部（不计数）。 */
  function readEntries(arg, canvasIdArg) {
    var a = arg && typeof arg === "object" && !Array.isArray(arg) ? arg : {};
    var one = str(a.id).trim();
    if (one)
      return op({ action: "get", params: { id: one } }, canvasIdArg).then(function (r) {
        return r && r.record ? r.record : null;
      });
    var ids = Array.isArray(a.ids) ? a.ids : [];
    if (ids.length) {
      return ids.reduce(function (chain, x) {
        return chain.then(function (acc) {
          return op({ action: "get", params: { id: str(x) } }, canvasIdArg).then(
            function (r) {
              if (r && r.record) acc.push(r.record);
              return acc;
            },
            function () {
              return acc; /* 单条取不到（已删 / id 写错）不拖垮整批 */
            },
          );
        });
      }, Promise.resolve([]));
    }
    var q = str(a.q == null ? (typeof arg === "string" ? arg : "") : a.q).trim();
    if (q)
      return op({ action: "query", params: { q: q, limit: a.limit } }, canvasIdArg).then(
        function (r) {
          return (r && r.entries) || [];
        },
      );
    return op({ action: "list", params: {} }, canvasIdArg).then(function (r) {
      return (r && r.entries) || [];
    });
  }

  /* add：一条或一批新条例（写 +0.5，带 7 天零命中保护期）；update：按 id 改局部字段。 */
  function addEntries(records, canvasIdArg) {
    var list = Array.isArray(records) ? records.slice() : records ? [records] : [];
    return op({ action: "write", params: { records: list } }, canvasIdArg);
  }
  function updateEntry(id, patch, canvasIdArg) {
    var k = str(id).trim();
    if (!k) return Promise.reject(new Error(T("update 需要给出 id")));
    var p = patch && typeof patch === "object" ? patch : {};
    /* 先读现状再合并：op write 的更新是「整条覆盖」，局部改必须自己补齐其余字段。 */
    return load(canvasIdArg, { silent: true }).then(function (r) {
      if (!r || r.ok === false || !r.file) throw new Error(T(NB));
      var cur = entryById(r.data, k);
      if (!cur) throw new Error(T("AI 事实库中没有该条例：") + k);
      var rec = {
        id: k,
        title: p.title == null ? str(cur.title) : p.title,
        text: p.text == null ? (p.body == null ? str(cur.text) : p.body) : p.text,
        tags: p.tags == null ? tagsOf(cur.tags) : p.tags,
        type: p.type == null ? str(cur.type) : p.type,
        src: p.src == null ? (p.source == null ? str(cur.src) : p.source) : p.src,
      };
      return op({ action: "write", params: { records: [rec] } }, canvasIdArg);
    });
  }
  function removeEntries(ids, canvasIdArg) {
    var list = Array.isArray(ids) ? ids.slice() : ids ? [ids] : [];
    return op({ action: "delete", params: { ids: list } }, canvasIdArg);
  }
  /* hit：显式记一次「被查阅」（读 +1，不改正文）；propose / confirm / reject：待确认区三件事。 */
  function hitEntries(ids, canvasIdArg) {
    var list = Array.isArray(ids) ? ids : ids ? [ids] : [];
    if (!list.length) return Promise.resolve({ ok: true, hits: 0 });
    return list
      .reduce(function (chain, x) {
        return chain.then(function (n) {
          return op({ action: "get", params: { id: str(x) } }, canvasIdArg).then(
            function () {
              return n + 1;
            },
            function () {
              return n;
            },
          );
        });
      }, Promise.resolve(0))
      .then(function (n) {
        return { ok: true, hits: n };
      });
  }
  function proposeEntries(records, canvasIdArg) {
    var list = Array.isArray(records) ? records.slice() : records ? [records] : [];
    return op({ action: "propose", params: { records: list } }, canvasIdArg);
  }
  function confirmEntries(ids, canvasIdArg) {
    var list = Array.isArray(ids) ? ids : ids ? [ids] : [];
    return op(
      { action: "confirm", params: list.length ? { ids: list } : { all: true } },
      canvasIdArg,
    );
  }
  function rejectEntries(ids, canvasIdArg) {
    var list = Array.isArray(ids) ? ids : ids ? [ids] : [];
    return op(
      { action: "reject", params: list.length ? { ids: list } : { all: true } },
      canvasIdArg,
    );
  }
  /* 待确认 / 最近淘汰：给界面与别的模块（如左栏徽标）读的两个只读小接口。 */
  function pendingOf(canvasIdArg) {
    return load(canvasIdArg, { silent: true }).then(
      function (r) {
        return r && r.ok !== false && r.data ? pendingEntries(r.data) : [];
      },
      function () {
        return [];
      },
    );
  }
  function evictLogOf(canvasIdArg) {
    return load(canvasIdArg, { silent: true }).then(
      function (r) {
        return r && r.ok !== false && r.data && Array.isArray(r.data.log) ? r.data.log : [];
      },
      function () {
        return [];
      },
    );
  }

  var API = {
    pathOf: pathOf,
    load: load,
    save: save,
    op: op,
    scoreOf: scoreOf,
    countOf: countOf,
    openDlg: openDlg,
    canvasId: canvasId,
    /* 新口径公开接口（本任务）：init / read / add / update / remove / hit / propose /
       confirm / reject / export，外加两个只读小接口。 */
    init: initLib,
    read: readEntries,
    add: addEntries,
    update: updateEntry,
    remove: removeEntries,
    hit: hitEntries,
    propose: proposeEntries,
    confirm: confirmEntries,
    reject: rejectEntries,
    export: exportLib,
    pendingOf: pendingOf,
    evictLogOf: evictLogOf,
    isPending: isPending,
    isProtected: isProtected,
    weightOf: weightOf,
  };
  window.MTNodeAiFacts = API;
  /* 新口径的别名：名字里 AIF 三个字母都是大写，认错大小写的调用方也能取到同一只对象。 */
  window.MTNodeAIFacts = API;

  /* 全局别名：同层脚本（app-teamview.js 等）可直接调用，按 typeof 判空取用。 */
  window.aiFactsPathOf = pathOf;
  window.aiFactsLoad = load;
  window.aiFactsSave = save;
  window.aiFactsOp = op;
  window.aiFactsScoreOf = scoreOf;
  window.aiFactsCountOf = countOf;
  window.aiFactsOpenDlg = openDlg;
  window.aiFactsCanvasId = canvasId;
})();