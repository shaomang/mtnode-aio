/* canvas-doc-render —— 画布「演示态」场景树内核（同一份代码，两处入口）
 * ============================================================================
 * 一句话：(doc, cam, viewport) → **场景树**（纯数据）→（适配器）DOM。
 *
 * 两处入口（与 canvas-doc-core / canvas-doc-edit 同一口径）：
 *   · 浏览器：renderer/index.html 以 <script> 引入，挂 globalThis.MTCanvasRender
 *   · Node（主进程 / 脚本 / 冒烟）：require("canvas-doc/canvas-doc-render.js") 拿同一份 api
 *
 * 为什么要有它（路 B）：
 *   · 路 A（canvas-replay.js）把一帧画成「简化 SVG」：只有方框 + 标题 + 一种线型，
 *     卡片结构 / 端子 / 徽标都不在，够做回放缩略，不够做演示与宿主复用。
 *   · 路 B 是**应用里那张画布本身**的渲染口径：卡片 / 标题 / 端子 / 连线 / 标注 /
 *     组框 / 徽标 / 正文摘要，几何与类名与 renderer 同源。场景树是纯数据（可 JSON 化、
 *     可版本化、可进黄金文件），DOM 只是其中一个适配器 —— `mountNodeEl` 在这里退化成
 *     「一棵节点的场景 → 一个元素」，不再自带布局与业务。
 *
 * 覆盖范围（**演示态子集**，不是整张画布）：
 *   卡片      .wf-node + kind 类（含 sel / browse / is-ctrl / in-media / no-in-ports / no-out-ports）
 *   标题栏    .n-head > .n-drag-handle（种类图标按钮，图标来自 canvas-doc/kind-icons.js）
 *             + .n-title + 「?」.n-play.n-help-btn + 「✕」.n-play.n-del —— 与 app-canvas.js 的
 *             nodeElement 同一排（少了这排小按钮，卡片就只是「像卡片」，不是源画布那张）
 *   端子      .port.in / .port.out（spare / linked / ctrl / yes / no / img）+ .port-badge
 *   连线      <path class="fn-edge …" id="wire-ID"> 的 d（重力垂线，与 wirePathAB 同一公式）
 *   标注      .wf-mark.mk-text + .mk-text（文本 / 颜色 / 字号）
 *   组框      .wf-group[data-gid] + .wg-title（= groupBounds + GROUP_PAD 16）
 *   种类图标键 场景里的 node.badge.text（值 = kind；control 走 ctrl_start / ctrl_end_ok /
 *             ctrl_end_fail，db_replica / super(db) 走 db，super(dev) 走 dev，super(tool) 走
 *             tool —— 与 app.js nodeKindIconKey + fillNodeKindIcon 同口径）
 *   正文摘要  .n-summary（kind 对应字段的前 120 字）
 *
 * 不进内核（**明确不做**，由宿主 / 后续任务承担）：
 *   · 节点内编辑器与预览：正文 textarea、参数面板、媒体播放器、各类挂载按钮、缩放手柄；
 *     标题栏上的业务小按钮（YAML / 批量 / 后端探针 / 运行 …）也不画 —— 它们各有各的状态源；
 *   · 壳层内部：parentSuperId 子节点、展开壳舞台、super_io、组输入 / 参数 / 组输出哨兵端子；
 *   · 工具 / 函数节点（参数即端子）、素材 / 交付 / 长任务 / 应用节点、Remotion / 视频生成
 *     （端子数由契约或数据槽算，不是演示态固定口径）；
 *   · 关系线的扇出避让与线上文字（只画两端直线段，标 relApprox）。
 *
 * 纪律：
 *   · sceneOf 纯函数：只读 doc / cam / viewport / opts，不碰 DOM、不读时钟、不写状态。
 *   · 文案不归内核：端子徽标默认只给「输入N / 输出N」，宿主用 opts.labels(node, dir, i)
 *     注入自己的 i18n 口径（renderer 的 portBadgeText 就这么接，见对账闸）。
 *   · 覆盖范围外的 kind 一律不画，但进 scene.stats.skippedKinds 记账 —— 绝不猜端子数。
 *   · 与 renderer 的漂移由 test/smoke-canvas-render-parity.js 逐项对账（类名 / 几何 /
 *     端子号 / 连线 d / 标注 / 组框 / 徽标）；任一侧改了都要让那只闸重新绿。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MTCanvasRender = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const VERSION = "canvas-render/1";

  /* ── 与 renderer/app.js 同一组常量（改这里必须同步那边，对账闸会盯着） ────────── */
  const GEOM = {
    portR: 5,
    portStep: 15, /* app.js: PORT_STEP = PORT_R * 3 */
    portOff: 9,
    border: 1,
    groupPad: 16, /* app.js: GROUP_PAD */
    portTop: 45, /* inPortY / outPortY 的 top 与 min */
    portBottom: 5,
  };
  const PARAM_IN_INDEX = 9001;
  const GROUP_IN_INDEX = 9002;
  const GROUP_OUT_INDEX = 9003;

  /* 演示态覆盖的 kind → 卡片类名（值抄自 app.js 的 KIND_CLS，覆盖集之外的 kind 不画） */
  const KIND_CLS = {
    input_text: "in",
    input_image: "in",
    input_file: "in",
    input_audio: "in",
    input_video: "in",
    input_form: "in",
    input_any: "in",
    proc_text: "proc",
    proc_image: "proc-img",
    agent_task: "agent",
    save: "sv",
    save_text: "sv",
    save_image: "sv",
    save_pdf: "sv",
    task: "task",
    judge: "judge",
    qa_text: "judge",
    qa_image: "judge",
    qa_video: "judge",
    qa_audio: "judge",
    qa_file: "judge",
    control: "ctrl",
    wait_file: "wait",
    timer: "timer",
    delayer: "delayer",
    popup: "delayer",
    sequencer: "sequencer",
    gate: "gate",
    splitter: "splitter",
    counter: "counter",
    mutex: "mutex",
    global: "global",
    net_recv: "net",
    net_send: "net",
    execute: "exec",
    db_table: "db-tbl",
    db_replica: "db",
    music_gen: "music",
    yue_gen: "music",
    moss_music: "music",
    breeze_gen: "tts",
    /* DeepSeek 云端语音（合成 / 识别）：与本地语音同族配色 */
    deepseek_tts: "tts",
    deepseek_asr: "tts",
    infinitetalk_gen: "video",
    soulxflashhead_gen: "video",
    flux3klein_gen: "proc-img",
    qwenimage_gen: "proc-img",
    /* 节点层（super）：录制回放里最常见的一类 —— 一张板子 + 标题 + 外露端子。
       它是「容器」，端子数由线决定（见 countsOf 的 super 分支），body 不猜内容。 */
    super: "super",
  };

  const CONTROL_KINDS = [
    "control",
    "wait_file",
    "timer",
    "delayer",
    "popup",
    "sequencer",
    "gate",
    "splitter",
    "counter",
    "mutex",
    "judge",
    "task",
  ];
  const QA_KINDS = ["qa_text", "qa_image", "qa_video", "qa_audio", "qa_file"];
  const DYN_KINDS = [
    "proc_text",
    "proc_image",
    "agent_task",
    "input_text",
    "input_image",
    "input_audio",
    "input_video",
    "input_file",
  ];
  /* 未选中 = 浏览态（app-canvas.js 的 NODE_BROWSE_KINDS；save 的两种别名归一成 save） */
  const BROWSE_KINDS = ["input_text", "input_image", "proc_text", "proc_image", "agent_task", "save"];

  /* 正文摘要取哪个字段（演示态口径：有什么给什么，不拼业务文案） */
  const SUMMARY_FIELDS = {
    input_text: "text",
    input_image: "text",
    input_file: "text",
    input_audio: "text",
    input_video: "text",
    proc_text: "prompt",
    proc_image: "prompt",
    agent_task: "task",
    save: "savePath",
    save_text: "savePath",
    save_image: "savePath",
    save_pdf: "savePath",
    task: "goal",
    judge: "prompt",
  };

  /* ── 小工具 ─────────────────────────────────────────────────────────────── */
  function isObj(v) {
    return !!v && typeof v === "object";
  }
  function num(v, fb) {
    const n = Number(v);
    return isFinite(n) ? n : fb;
  }
  function toSet(v) {
    if (!v) return new Set();
    if (typeof v === "string") return new Set([v]);
    if (typeof v.forEach === "function") return new Set(v);
    return new Set();
  }
  function clip(s, n) {
    s = String(s == null ? "" : s);
    return s.length > n ? s.slice(0, n) + "…" : s;
  }
  function px(v) {
    return num(v, 0) + "px";
  }
  function inList(list, v) {
    return list.indexOf(v) >= 0;
  }

  /* ── 种类图标：真源 canvas-doc/kind-icons.js（与 renderer/app.js 的 KIND_ICON_SVG 同一份） ──
     节点标题栏那颗按钮（.n-drag-handle）里装的就是它。这里只负责「按图标键取串」，
     查不到时才落一枚中性的方框兜底（内核独立 require 时可能真的没有那份模块）。 */
  const ICON_FALLBACK =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.2" y="3.2" width="9.6" height="9.6" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5.6 8h4.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
  let _icons;
  function iconApi() {
    if (_icons !== undefined) return _icons;
    _icons = null;
    try {
      if (typeof module === "object" && module && module.exports) _icons = require("./kind-icons.js");
      else _icons = (typeof globalThis !== "undefined" && globalThis.MTKindIcons) || null;
    } catch (_) {
      _icons = null;
    }
    return _icons;
  }
  /** 图标键 → 内联 SVG 串（空 / 查不到 = 中性兜底，绝不留一个空按钮） */
  function iconSvgOf(key) {
    const api = iconApi();
    if (api && typeof api.get === "function") {
      const s = api.get(key);
      if (s) return String(s);
    }
    return ICON_FALLBACK;
  }
  /** 图标按钮上的配色修饰类（app.js fillNodeKindIcon：db-ico / dev-ico / exec-ico） */
  function iconModCls(key) {
    if (key === "db") return " db-ico";
    if (key === "dev") return " dev-ico";
    if (key === "execute") return " exec-ico";
    return "";
  }

  /* ── 节点口径 ───────────────────────────────────────────────────────────── */
  function baseKind(n) {
    if (!n) return "";
    return n.kind === "save_text" || n.kind === "save_image" ? "save" : n.kind;
  }
  function isSaveKind(kind) {
    return kind === "save" || kind === "save_text" || kind === "save_image" || kind === "save_pdf";
  }
  function isCovered(n, opts) {
    if (!n || !n.kind) return false;
    if (n.kind === "proc_text" && n.agent) return true;
    /* 节点层（super）默认仍不进「演示态子集」—— 它的端子数是线推出来的，不保证与旧路
       逐项对齐；录制回放（take-player）显式传 supers:true 才画，冒烟对账口径不受影响。 */
    if (n.kind === "super" && !(opts && opts.supers)) return false;
    return !!KIND_CLS[n.kind];
  }
  /* 卡片类名（app-canvas.js nodeElement 的三目）：proc_text(agent) → agent；
     control 的角色 → "ctrl ctrl-ok|ctrl-fail|ctrl-start"（两个 token，第二颗是角色） */
  function kindClsOf(n) {
    if (!n) return "proc";
    if (n.kind === "proc_text" && n.agent) return "agent";
    if (n.kind === "control") {
      if (n.ctrlRole === "endSuccess") return "ctrl ctrl-ok";
      if (n.ctrlRole === "endFail") return "ctrl ctrl-fail";
      if (n.ctrlRole === "start") return "ctrl ctrl-start";
    }
    return KIND_CLS[n.kind] || "proc";
  }
  /* 种类图标键（app.js nodeKindIconKey + fillNodeKindIcon）：卡片标题栏那颗图标认的键。
     与 kind 的差别：agent / control 角色 / 节点层的三个变体（db / dev / tool）/ execute。
     内核只算键，图标长什么样问 canvas-doc/kind-icons.js。 */
  function iconKeyOf(n) {
    if (!n || !n.kind) return "proc_text";
    if (n.kind === "proc_text" && n.agent) return "agent_task";
    if (n.kind === "control") {
      if (n.ctrlRole === "start") return "ctrl_start";
      if (n.ctrlRole === "endSuccess") return "ctrl_end_ok";
      if (n.ctrlRole === "endFail") return "ctrl_end_fail";
    }
    if (n.kind === "super" && n.tool) return "tool";
    /* app.js fillNodeKindIcon：数据库副本 / 数据库层换成库体图标，开发节点换立方体 */
    if (n.kind === "db_replica" || (n.kind === "super" && n.db)) return "db";
    if (n.kind === "super" && n.dev) return "dev";
    return String(n.kind);
  }
  function isControlKind(n) {
    return !!n && inList(CONTROL_KINDS, n.kind);
  }
  function isQaKind(n) {
    return !!n && inList(QA_KINDS, n.kind);
  }
  function isDynCtrl(n) {
    return !!n && inList(DYN_KINDS, n.kind);
  }
  function nodeDrawSize(n) {
    if (!n) return { w: 240, h: 160 };
    /* 节点层：展开态用的是 expandW / expandH（app.js 的 superDisplaySize 同口径），
       收起态就是节点自己的 w / h —— 少了这一条，回放里板子的边框会压在里面的卡片上。 */
    if (n.kind === "super" && n.superOpen)
      return {
        w: Math.max(320, num(n.expandW, 720) || 720),
        h: Math.max(220, num(n.expandH, 480) || 480),
      };
    if (n.kind === "super") return { w: num(n.w, 280) || 280, h: num(n.h, 200) || 200 };
    return { w: num(n.w, 240) || 240, h: num(n.h, 160) || 160 };
  }

  /* ── 连线口径（只认演示态需要的几条） ────────────────────────────────────── */
  function allWiresTo(D, id) {
    return (D.wires || []).filter(
      (w) =>
        isObj(w) &&
        w.to === id &&
        !w.rel &&
        !(w && !w.rel && (w.grp || w.sup)) &&
        Number(w.toIndex) !== PARAM_IN_INDEX,
    );
  }
  function isGroupWire(w) {
    return !!(w && (w.grp || w.sup));
  }
  /* 来源端是不是控制口（app.js wireFromIsControl 的演示态子集） */
  function wireFromIsControl(D, w) {
    if (!w) return false;
    const from = nodeById(D, w.from);
    if (!from) return false;
    if (isControlKind(from)) return true;
    if (from.kind === "net_recv" && num(w.fromIndex, 0) >= 1) return true;
    if (from.kind === "breeze_gen" && num(w.fromIndex, 0) >= 1) return true;
    if ((from.kind === "deepseek_tts" || from.kind === "deepseek_asr") && num(w.fromIndex, 0) >= 1)
      return true;
    if (
      (from.kind === "music_gen" ||
        from.kind === "yue_gen" ||
        from.kind === "flux3klein_gen" ||
        from.kind === "qwenimage_gen" ||
        from.kind === "infinitetalk_gen" ||
        from.kind === "soulxflashhead_gen") &&
      num(w.fromIndex, 0) >= 1
    )
      return true;
    return false;
  }
  function nodeById(D, id) {
    for (const n of D.nodes || []) if (n && n.id === id) return n;
    return null;
  }
  /* 端子徽标是否「端子本体就是控制口」（app-canvas.js inPortIsControl） */
  function inPortIsControl(D, n, i) {
    if (!n) return false;
    if (isControlKind(n)) return true;
    if (n.kind === "net_send") return i === 1;
    if (n.kind === "music_gen") return i === 2;
    if (n.kind === "yue_gen") return i === 3;
    if (n.kind === "moss_music") return i === 2;
    if (n.kind === "breeze_gen") return i === 4;
    if (n.kind === "deepseek_tts" || n.kind === "deepseek_asr") return i === 1;
    if (n.kind === "infinitetalk_gen") return i === 4;
    if (n.kind === "soulxflashhead_gen") return i === 2;
    if (n.kind === "flux3klein_gen" || n.kind === "qwenimage_gen") return i === 2;
    if (isQaKind(n)) return i === 2;
    /* 动态端子节点：末位那颗专用控制端子（app.js dynCtrlInPortIndex） */
    if (isDynCtrl(n)) return i === dynCtrlIndex(D, n);
    return false;
  }
  /* 输出端子是不是控制口（app.js nodeEmitsControlOnPort） */
  function outPortIsControl(n, i) {
    if (!n) return false;
    if (isControlKind(n)) return true;
    if (isQaKind(n)) return num(i, 0) >= 1;
    if (n.kind === "net_recv") return num(i, 0) >= 1;
    if (n.kind === "breeze_gen") return num(i, 0) >= 1;
    if (n.kind === "deepseek_tts" || n.kind === "deepseek_asr") return num(i, 0) >= 1;
    if (
      n.kind === "music_gen" ||
      n.kind === "yue_gen" ||
      n.kind === "flux3klein_gen" ||
      n.kind === "qwenimage_gen" ||
      n.kind === "infinitetalk_gen" ||
      n.kind === "soulxflashhead_gen"
    )
      return num(i, 0) >= 1;
    return false;
  }

  /**
   * 端子数：与 app.js 的 inputCount / outputCount 同口径的**演示态子集**。
   * 返回 { covered, in, out }；covered=false 的节点不画（不猜端子数）。
   */
  function countsOf(D, n, opts) {
    if (!isObj(n) || !isCovered(n, opts)) return { covered: false, in: 0, out: 0, reason: n ? n.kind : "" };
    const kind = n.kind;
    const to = allWiresTo(D, n.id);
    /* 节点层（super）：外侧端子数不存节点上，只由「连了几根线」推出来
       （app.js superDynamicPortCount 同口径：收起 = 已占最大下标 +1，展开再留 1 个空槽）。
       不这么算，板子边缘一颗端子都不画，171 根线就全丢了。 */
    if (kind === "super") {
      let maxIn = -1;
      let maxOut = -1;
      for (const w of D.wires || []) {
        if (!isObj(w) || w.rel || isGroupWire(w)) continue;
        if (w.to === n.id && Number(w.toIndex) !== PARAM_IN_INDEX && Number(w.toIndex) !== GROUP_IN_INDEX)
          maxIn = Math.max(maxIn, num(w.toIndex, 0));
        if (w.from === n.id && Number(w.fromIndex) !== GROUP_OUT_INDEX)
          maxOut = Math.max(maxOut, num(w.fromIndex, 0));
      }
      const open = !!n.superOpen;
      const dyn = (m) => (m < 0 ? 1 : open ? m + 2 : m + 1);
      return { covered: true, in: dyn(maxIn), out: dyn(maxOut), reason: "" };
    }
    let ic;
    if (n.ro) ic = 0;
    else if (
      kind === "wait_file" ||
      kind === "input_any" ||
      kind === "timer" ||
      kind === "db_replica" ||
      kind === "execute" ||
      kind === "appnode"
    )
      ic = 0;
    else if (kind === "control" && n.ctrlRole === "start") ic = 0;
    else if (kind === "input_form") ic = 1;
    else if (isDynCtrl(n)) ic = dynCtrlIndex(D, n) + 1;
    else if (kind === "task") ic = 1;
    else if (isQaKind(n)) ic = 3;
    else if (kind === "gate") ic = Math.max(2, Math.min(8, Math.round(num(n.gateInputs, 2) || 2)));
    else if (kind === "mutex") ic = Math.max(2, Math.min(8, Math.round(num(n.mutexInputs, 2) || 2)));
    else if (kind === "music_gen") ic = 3;
    else if (kind === "yue_gen") ic = 4;
    else if (kind === "moss_music") ic = 3;
    else if (kind === "breeze_gen") ic = 5;
    else if (kind === "deepseek_tts" || kind === "deepseek_asr") ic = 2;
    else if (kind === "infinitetalk_gen") ic = 5;
    else if (kind === "soulxflashhead_gen") ic = 3;
    else if (kind === "flux3klein_gen" || kind === "qwenimage_gen") ic = 3;
    else if (kind === "net_recv") ic = 0;
    else if (kind === "net_send") ic = 2;
    else ic = Math.max(1, to.length + 1);

    let oc;
    if (kind === "control" && (n.ctrlRole === "endSuccess" || n.ctrlRole === "endFail")) oc = 0;
    else if (kind === "global" || kind === "execute" || kind === "net_send") oc = 0;
    else if (kind === "input_audio" || kind === "input_video") oc = 2;
    else if (kind === "task" || kind === "judge") oc = 2;
    else if (isQaKind(n)) oc = 3;
    else if (kind === "moss_music") oc = 3;
    else if (
      kind === "music_gen" ||
      kind === "yue_gen" ||
      kind === "breeze_gen" ||
      kind === "infinitetalk_gen" ||
      kind === "soulxflashhead_gen" ||
      kind === "flux3klein_gen" ||
      kind === "qwenimage_gen" ||
      kind === "deepseek_tts" ||
      kind === "deepseek_asr"
    )
      oc = 2;
    else if (kind === "net_recv") oc = 2;
    else if (kind === "sequencer") oc = Math.max(2, Math.min(8, Math.round(num(n.seqOutputs, 3) || 3)));
    else if (kind === "splitter") oc = Math.max(2, Math.min(8, Math.round(num(n.splitOutputs, 3) || 3)));
    else if (isSaveKind(kind)) oc = 1;
    else oc = 1;
    return { covered: true, in: ic, out: oc, reason: "" };
  }

  /* 动态端子节点的控制端子号（app.js dynCtrlInPortIndex） */
  function dynCtrlIndex(D, n) {
    let maxData = -1;
    for (const w of D.wires || []) {
      if (!isObj(w) || w.rel || w.to !== n.id) continue;
      if (wireFromIsControl(D, w)) continue;
      const i = Number(w.toIndex);
      if (isFinite(i) && i >= PARAM_IN_INDEX) continue;
      if (isFinite(i) && i > maxData) maxData = i;
    }
    return Math.max(1, maxData + 2);
  }

  /* ── 几何：与 app.js 的端口 / 连线公式逐行对齐 ───────────────────────────── */
  function portBandY(totalH, i, count, o) {
    o = o || {};
    const step = Number(o.step) > 0 ? Number(o.step) : GEOM.portStep;
    const h = Math.max(1, totalH || 1);
    const inner = Math.max(1, h - (o.top || 0) - (o.bottom || 0));
    const bandTop = (o.top || 0) + inner * (o.bandA == null ? 0.18 : o.bandA);
    const bandBot = (o.top || 0) + inner * (o.bandB == null ? 0.82 : o.bandB);
    const span = Math.max(0, (count || 1) - 1) * step;
    let start;
    if (span <= bandBot - bandTop) start = Math.round(bandTop);
    else {
      start = (o.top || 0) + Math.round((inner - span) / 2);
      if (start < (o.top || 0)) start = o.top || 0;
    }
    return Math.max(o.min || 0, start + i * step);
  }
  function inPortY(node, i, ic) {
    return portBandY(nodeDrawSize(node).h, i, ic, {
      top: GEOM.portTop,
      bottom: GEOM.portBottom,
      min: GEOM.portTop,
      bandA: 0,
      bandB: 1,
    });
  }
  function outPortY(node, i, oc) {
    return portBandY(nodeDrawSize(node).h, i, oc, {
      top: GEOM.portTop,
      bottom: GEOM.portBottom,
      min: GEOM.portTop,
      bandA: 0,
      bandB: 1,
    });
  }
  function inCenter(n, box, i, ic) {
    return {
      x: box.x + GEOM.portOff + GEOM.border,
      y: box.y + inPortY(n, i, ic == null ? countsOf({ nodes: [] }, n).in : ic) + GEOM.border,
    };
  }
  function outCenter(n, box, i, oc) {
    return {
      x: box.x + box.w - GEOM.portOff - GEOM.border,
      y: box.y + outPortY(n, i, oc) + GEOM.border,
    };
  }
  function wirePathAB(ax, ay, bx, by) {
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const sag = Math.min(52, Math.max(14, len * 0.15));
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2 + sag * 2.5;
    return "M " + ax + " " + ay + " Q " + mx + " " + my + " " + bx + " " + by;
  }

  /* 标注矩形（app-canvas.js markBounds） */
  function markBounds(m) {
    if (!m) return null;
    const x = Number(m.x);
    const y = Number(m.y);
    const w = Number(m.w || 40);
    const h = Number(m.h || 40);
    if (![x, y, w, h].every(isFinite) || w <= 0 || h <= 0) return null;
    return { x, y, w, h };
  }
  /* 组框矩形（app.js groupBounds：只计入当前层可见成员）+ GROUP_PAD */
  function groupBoxOf(D, g, topIds) {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity,
      any = false;
    const include = (x, y, w, h) => {
      if (![x, y, w, h].every(isFinite) || w < 0 || h < 0) return;
      any = true;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w);
      maxY = Math.max(maxY, y + h);
    };
    for (const id of g.nodeIds || []) {
      const n = nodeById(D, id);
      if (!n || n.parentSuperId || !topIds.has(id)) continue;
      const size = nodeDrawSize(n);
      include(num(n.x, 0), num(n.y, 0), size.w, size.h);
    }
    for (const id of g.markIds || []) {
      const m = markById(D, id);
      if (!m || m.parentSuperId) continue;
      const b = markBounds(m);
      if (b) include(b.x, b.y, b.w, b.h);
    }
    if (!any) return null;
    const pad = GEOM.groupPad;
    return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
  }
  function markById(D, id) {
    for (const m of D.marks || []) if (m && m.id === id) return m;
    return null;
  }

  /* ── 场景树 ────────────────────────────────────────────────────────────── */
  function summaryOf(n) {
    const key = SUMMARY_FIELDS[n.kind] || (n.kind === "save_text" || n.kind === "save_image" ? "savePath" : "");
    let v = key ? n[key] : "";
    if (!v) v = n.text || n.prompt || n.task || n.goal || n.savePath || "";
    if (Array.isArray(v)) v = v.join(" · ");
    return clip(String(v == null ? "" : v).replace(/\s+/g, " ").trim(), 120);
  }
  function labelOf(opts, n, dir, i) {
    if (opts && typeof opts.labels === "function") {
      const s = opts.labels(n, dir, i);
      if (s != null && String(s) !== "") return String(s);
    }
    return (dir === "in" ? "输入" : "输出") + (i + 1);
  }

  function inPortsOf(D, n, ic, opts) {
    const out = [];
    for (let i = 0; i < ic; i++) {
      const linked = allWiresTo(D, n.id).some((w) => Number(w.toIndex || 0) === i);
      const ctrl = inPortIsControl(D, n, i);
      const cls = ["port", "in"];
      if (!linked) cls.push("spare");
      if (ctrl) cls.push("ctrl");
      if (linked) cls.push("linked");
      const y = inPortY(n, i, ic);
      out.push({
        dir: "in",
        idx: i,
        y,
        top: y - GEOM.portR,
        left: GEOM.portOff - GEOM.portR,
        cls: cls.join(" "),
        linked,
        ctrl,
        badge: labelOf(opts, n, "in", i),
      });
    }
    return out;
  }
  function outPortsOf(D, n, oc, opts) {
    const out = [];
    for (let i = 0; i < oc; i++) {
      const linked = (D.wires || []).some(
        (w) => isObj(w) && !w.rel && !isGroupWire(w) && w.from === n.id && num(w.fromIndex, 0) === i,
      );
      const cls = ["port", "out"];
      if (n.kind === "judge" || n.kind === "task") cls.push(i === 0 ? "yes" : "no");
      else if ((n.kind === "flux3klein_gen" || n.kind === "qwenimage_gen") && i === 0) cls.push("img");
      else if (outPortIsControl(n, i)) cls.push("ctrl");
      if (linked) cls.push("linked");
      const y = outPortY(n, i, oc);
      out.push({
        dir: "out",
        idx: i,
        y,
        top: y - GEOM.portR,
        right: GEOM.portOff - GEOM.portR,
        cls: cls.join(" "),
        linked,
        ctrl: outPortIsControl(n, i),
        badge: labelOf(opts, n, "out", i),
      });
    }
    return out;
  }

  /**
   * (doc, cam, viewport) → 场景树。
   * @param {object} doc      画布文档 { id,name,nodes,wires,marks,groups }
   * @param {{x:number,y:number,z:number}} cam 机位（世界坐标平移 + 缩放）
   * @param {{width:number,height:number,dpr?:number}} viewport
   * @param {{sel?:Array|Set, selMark?:string, selGroup?:string, labels?:Function}} opts
   */
  function sceneOf(doc, cam, viewport, opts) {
    opts = opts || {};
    const D = {
      id: isObj(doc) ? String(doc.id || "") : "",
      name: isObj(doc) ? String(doc.name || "") : "",
      nodes: (isObj(doc) && Array.isArray(doc.nodes) ? doc.nodes : []).filter(isObj),
      wires: (isObj(doc) && Array.isArray(doc.wires) ? doc.wires : []).filter(isObj),
      marks: (isObj(doc) && Array.isArray(doc.marks) ? doc.marks : []).filter(isObj),
      groups: (isObj(doc) && Array.isArray(doc.groups) ? doc.groups : []).filter(isObj),
    };
    const sel = toSet(opts.sel);
    const V = {
      width: Math.max(1, num(viewport && viewport.width, 1280)),
      height: Math.max(1, num(viewport && viewport.height, 720)),
      dpr: Math.max(1, num(viewport && viewport.dpr, 2)),
    };
    const C = {
      x: num(cam && cam.x, 0),
      y: num(cam && cam.y, 0),
      z: num(cam && cam.z, 1) || 1,
    };
    const topNodes = D.nodes.filter((n) => !n.parentSuperId);
    const topIds = new Set(topNodes.map((n) => n.id));
    const skippedKinds = {};

    const nodes = [];
    for (const n of topNodes) {
      const counts = countsOf(D, n, opts);
      if (!counts.covered) {
        const k = String(n.kind || "?");
        skippedKinds[k] = (skippedKinds[k] || 0) + 1;
        continue;
      }
      const size = nodeDrawSize(n);
      const box = { x: num(n.x, 0), y: num(n.y, 0), w: size.w, h: size.h };
      const isSel = sel.has(n.id);
      const browse = inList(BROWSE_KINDS, baseKind(n)) && !isSel;
      const cls = ["wf-node", kindClsOf(n)];
      if (counts.in === 0) cls.push("no-in-ports");
      if (counts.out === 0) cls.push("no-out-ports");
      if (isSel) cls.push("sel");
      if (browse) cls.push("browse");
      if (isControlKind(n)) cls.push("is-ctrl");
      if (n.kind === "input_audio" || n.kind === "input_video") cls.push("in-media");
      /* 节点层的变体（展开 / 工具 / 开发 / 长任务壳）：类名与 app-canvas.js 的 nodeElement
         一致，canvas.css 里那些描边与配色规则才会照常生效。只加类，不加内容。 */
      if (n.kind === "super") {
        if (n.superOpen) cls.push("super-open");
        if (n.tool) cls.push("tool-node");
        if (n.dev && !n.db) cls.push("dev-el", "dev-el-" + String(n.devKind || "module"));
        if (String(n.ltShellTask || "").trim()) cls.push("lt-shell");
      }
      nodes.push({
        id: String(n.id || ""),
        kind: String(n.kind || ""),
        title: String(n.title == null ? "" : n.title),
        sel: isSel,
        browse,
        box,
        cls: cls.join(" "),
        form: browse ? "browse" : "edit",
        ports: {
          in: inPortsOf(D, n, counts.in, opts),
          out: outPortsOf(D, n, counts.out, opts),
        },
        badge: { text: iconKeyOf(n) },
        body: { summary: summaryOf(n) },
        _n: n,
        _counts: counts,
      });
    }

    const nodeSceneById = {};
    for (const s of nodes) nodeSceneById[s.id] = s;
    /* 场景节点对外不带内部引用（可 JSON 化）：_n / _counts 只在函数内部用 */
    const cleanNodes = nodes.map((s) => ({
      id: s.id,
      kind: s.kind,
      title: s.title,
      sel: s.sel,
      browse: s.browse,
      box: s.box,
      cls: s.cls,
      form: s.form,
      ports: s.ports,
      badge: s.badge,
      body: s.body,
    }));


    /* 连线：两端都在场景里的才画；组线 / 壳线（grp / sup）不进子集 */
    const wires = [];
    let wiresSkipped = 0;
    for (const w of D.wires) {
      const a = nodeSceneById[w.from];
      const b = nodeSceneById[w.to];
      if (w.rel) {
        if (!a || !b) {
          wiresSkipped++;
          continue;
        }
        const p = { x: a.box.x + a.box.w / 2, y: a.box.y + a.box.h / 2 };
        const q = { x: b.box.x + b.box.w / 2, y: b.box.y + b.box.h / 2 };
        wires.push({
          id: String(w.id || ""),
          from: String(w.from),
          to: String(w.to),
          fromIndex: 0,
          toIndex: 0,
          rel: true,
          relApprox: true,
          a: p,
          b: q,
          d: "M " + p.x + " " + p.y + " L " + q.x + " " + q.y,
          cls: "fn-edge rel",
        });
        continue;
      }
      if (!a || !b || isGroupWire(w)) {
        wiresSkipped++;
        continue;
      }
      const fromIndex = num(w.fromIndex, 0);
      const toIndex = num(w.toIndex, 0);
      if (toIndex === PARAM_IN_INDEX || toIndex === GROUP_IN_INDEX || fromIndex === GROUP_OUT_INDEX) {
        wiresSkipped++;
        continue;
      }
      const pa = outCenter(a._n, a.box, fromIndex, a._counts.out);
      const pb = inCenter(b._n, b.box, toIndex, b._counts.in);
      const cls = ["fn-edge"];
      if (wireFromIsControl(D, w) || isControlKind(b._n)) cls.push("ctrl");
      wires.push({
        id: String(w.id || ""),
        from: String(w.from),
        to: String(w.to),
        fromIndex,
        toIndex,
        rel: false,
        a: pa,
        b: pb,
        d: wirePathAB(pa.x, pa.y, pb.x, pb.y),
        cls: cls.join(" "),
      });
    }

    const marks = [];
    let marksSkipped = 0;
    for (const m of D.marks) {
      if (m.parentSuperId || m.kind !== "text") {
        marksSkipped++;
        continue;
      }
      const b = markBounds(m);
      if (!b) {
        marksSkipped++;
        continue;
      }
      marks.push({
        id: String(m.id || ""),
        kind: "text",
        text: String(m.text == null ? "" : m.text),
        color: String(m.color || ""),
        fontSize: num(m.fontSize, 16) || 16,
        box: b,
        sel: String(opts.selMark || "") === String(m.id || ""),
        cls: "wf-mark mk-text" + (String(opts.selMark || "") === String(m.id || "") ? " sel" : ""),
      });
    }

    /* 组框：成员里有「不归内核画」的 kind（壳 / 素材 / 视频生成 …）时，那些成员的尺寸
       由它们的展开态决定，内核不猜 —— 框仍然画（按已知成员撑开），但标 partial，
       宿主据此知道「这只框不是完整口径」。 */
    const coveredIds = new Set(cleanNodes.map((x) => x.id));
    const groups = [];
    for (const g of D.groups) {
      const b = groupBoxOf(D, g, topIds);
      if (!b) continue;
      const skippedMembers = [];
      for (const id of g.nodeIds || []) {
        const m = nodeById(D, id);
        if (m && !m.parentSuperId && !coveredIds.has(id)) skippedMembers.push(String(m.kind || "?"));
      }
      const selG = String(opts.selGroup || "") === String(g.id || "");
      groups.push({
        id: String(g.id || ""),
        title: String(g.title == null ? "" : g.title),
        box: b,
        sel: selG,
        partial: skippedMembers.length > 0,
        skippedMembers,
        cls: "wf-group" + (selG ? " sel" : ""),
      });
    }


    return {
      v: VERSION,
      doc: { id: D.id, name: D.name },
      viewport: V,
      cam: C,
      transform: "translate(" + C.x + "px, " + C.y + "px) scale(" + C.z + ")",
      nodes: cleanNodes,
      wires,
      marks,
      groups,
      stats: {
        nodes: topNodes.length,
        covered: cleanNodes.length,
        skipped: topNodes.length - cleanNodes.length,
        skippedKinds,
        ports: {
          in: cleanNodes.reduce((a, s) => a + s.ports.in.length, 0),
          out: cleanNodes.reduce((a, s) => a + s.ports.out.length, 0),
        },
        wires: wires.length,
        wiresSkipped,
        marks: marks.length,
        marksSkipped,
        groups: groups.length,
      },
    };
  }

  /* ── 场景树 → DOM 描述树（纯数据；适配器只认这一层） ─────────────────────── */
  function portTree(p, nodeId) {
    const style = { top: px(p.top) };
    if (p.dir === "in") style.left = px(p.left);
    else style.right = px(p.right);
    const attrs = { "data-node": String(nodeId || "") };
    if (p.dir === "in") attrs["data-idx"] = String(p.idx);
    else attrs["data-from-index"] = String(p.idx);
    return {
      tag: "div",
      cls: p.cls,
      attrs,
      style,
      kids: [{ tag: "span", cls: "port-badge", text: p.badge }],
    };
  }
  function nodeTree(s) {
    const attrs = { "data-nid": s.id, "data-node-form": s.form };
    const iconKey = String((s.badge && s.badge.text) || s.kind || "");
    /* 标题栏 = app-canvas.js nodeElement 的那条菜单条：种类图标按钮（可拖手柄）→ 标题 →
       「?」说明 → 「✕」删除。少了那排小按钮，回放里的卡片就只是「像卡片」，不是源画布那张。
       图标按钮的内容是内联 SVG（data-raw=1：适配器直接 innerHTML，签名比对把它当叶子看）。 */
    const head = {
      tag: "div",
      cls: "n-head",
      kids: [
        {
          tag: "button",
          cls: "n-drag-handle" + iconModCls(iconKey),
          attrs: { "data-kind-icon": iconKey, "data-raw": "1", type: "button" },
          html: iconSvgOf(iconKey),
        },
        { tag: "div", cls: "n-title", text: s.title },
        { tag: "button", cls: "n-play n-help-btn", attrs: { type: "button" }, text: "?" },
        { tag: "button", cls: "n-play n-del", attrs: { type: "button" }, text: "✕" },
      ],
    };
    const kids = [
      head,
      {
        tag: "div",
        cls: "n-body",
        kids: [{ tag: "div", cls: "n-summary", text: s.body.summary }],
      },
    ];
    for (const p of s.ports.in) kids.push(portTree(p, s.id));
    for (const p of s.ports.out) kids.push(portTree(p, s.id));
    return {
      tag: "div",
      cls: s.cls,
      attrs,
      style: {
        left: px(s.box.x),
        top: px(s.box.y),
        width: px(s.box.w),
        height: px(s.box.h),
        "--nw": px(s.box.w),
        "--nh": px(s.box.h),
      },
      kids,
    };
  }
  function wireTree(w) {
    const attrs = {
      id: "wire-" + w.id,
      "data-wire": w.id,
      "data-from": w.from,
      "data-to": w.to,
    };
    if (!w.rel) {
      attrs["data-from-index"] = String(w.fromIndex);
      attrs["data-to-index"] = String(w.toIndex);
    }
    return { tag: "path", ns: "svg", cls: w.cls, attrs, d: w.d };
  }
  function groupTree(g) {
    return {
      tag: "div",
      cls: g.cls,
      attrs: { "data-gid": g.id },
      style: { left: px(g.box.x), top: px(g.box.y), width: px(g.box.w), height: px(g.box.h) },
      kids: [{ tag: "div", cls: "wg-title", text: g.title }],
    };
  }
  function markTree(m) {
    return {
      tag: "div",
      cls: m.cls,
      attrs: { "data-mid": m.id },
      style: { left: px(m.box.x), top: px(m.box.y), width: px(m.box.w), height: px(m.box.h) },
      kids: [
        {
          tag: "div",
          cls: "mk-text",
          style: { color: m.color, fontSize: m.fontSize + "px" },
          text: m.text,
        },
      ],
    };
  }

  /** 场景树 → DOM 描述树（纯数据：{tag,cls,attrs,style,text,kids}；svg 子树带 ns:"svg"） */
  function treeOf(scene) {
    const S = scene || {};
    const vp = S.viewport || { width: 1280, height: 720 };
    return {
      tag: "div",
      cls: "wf-scene",
      attrs: { "data-render": VERSION },
      style: { width: px(vp.width), height: px(vp.height) },
      kids: [
        {
          tag: "svg",
          ns: "svg",
          cls: "wf-wires",
          /* 连线路径按**世界坐标**算（与 .wf-stage 里节点的 left/top 同一套），所以这层
             必须跟着机位一起变换 —— 不然平移 / 缩放一动手，线就整条飞离卡片。 */
          style: { transform: String(S.transform || ""), transformOrigin: "0 0" },
          attrs: { width: String(vp.width), height: String(vp.height), viewBox: "0 0 " + vp.width + " " + vp.height },
          kids: (S.wires || []).map(wireTree),
        },
        {
          tag: "div",
          cls: "wf-stage",
          style: { transform: String(S.transform || "") },
          kids: []
            .concat((S.groups || []).map(groupTree))
            .concat((S.marks || []).map(markTree))
            .concat((S.nodes || []).map(nodeTree)),
        },
      ],
    };
  }

  /* ── 适配器：描述树 → 真 DOM（唯一碰 document 的地方） ────────────────────── */
  function docOf(opts) {
    const d =
      (opts && opts.document) || (typeof document !== "undefined" ? document : null);
    if (!d || typeof d.createElement !== "function")
      throw new Error("canvas-doc-render: 没有 document —— mount 只能在浏览器 / 宿主里跑（场景树本身不碰 DOM）");
    return d;
  }
  function camel(s) {
    return String(s).replace(/-([a-z])/g, (m, c) => c.toUpperCase());
  }
  function applySpec(el, spec, doc) {
    /* 类名一律走 setAttribute("class")：SVGElement.className 是只读的 SVGAnimatedString，
       直接赋值在浏览器里抛 "Cannot set property className"（HTML 元素两种写法等价）。 */
    if (spec.cls) el.setAttribute("class", spec.cls);
    const attrs = spec.attrs || {};
    for (const k of Object.keys(attrs)) {
      if (k.indexOf("data-") === 0) el.dataset[camel(k.slice(5))] = String(attrs[k]);
      else if (k === "class") el.setAttribute("class", String(attrs[k]));
      else el.setAttribute(k, String(attrs[k]));
    }
    if (spec.d != null) el.setAttribute("d", String(spec.d));
    const style = spec.style || {};
    for (const k of Object.keys(style)) {
      if (k.indexOf("--") === 0) {
        if (el.style.setProperty) el.style.setProperty(k, String(style[k]));
      } else el.style[k] = String(style[k]);
    }
    if (spec.text != null) el.textContent = String(spec.text);
    /* 内联 HTML 叶子（种类图标那一枚 SVG）：不做二次解析，整段塞进去 */
    if (spec.html != null) el.innerHTML = String(spec.html);
    for (const kid of spec.kids || []) el.appendChild(domOf(kid, { document: doc }));
    return el;
  }
  /** 描述树 → 元素（opts.document 可注入；不传则用全局 document） */
  function domOf(spec, opts) {
    if (!spec) return null;
    const d = docOf(opts);
    const el = spec.ns === "svg" ? d.createElementNS("http://www.w3.org/2000/svg", spec.tag) : d.createElement(spec.tag);
    return applySpec(el, spec, d);
  }
  /** 挂整个场景：先清空 root，再挂 svg + stage */
  function mount(root, scene, opts) {
    const d = docOf(opts);
    while (root && root.firstChild) root.removeChild(root.firstChild);
    const el = domOf(treeOf(scene), { document: d });
    if (root) root.appendChild(el);
    return el;
  }
  /**
   * mountNodeEl 的退化形态：**一棵节点的场景 → 一个元素**。
   * 与 renderer/app-canvas.js 的 mountNodeEl(stage, n) 同形，但不再算布局 / 建按钮 / 绑事件。
   */
  function mountNodeEl(parent, nodeScene, opts) {
    const el = domOf(nodeTree(nodeScene), opts);
    if (parent) parent.appendChild(el);
    return el;
  }

  /* ── 对账工具：元素 → 描述树（DOM 结构与场景树比同一份形状） ──────────────── */
  function specOf(el) {
    if (!el || el.nodeType !== 1) return null;
    const attrs = {};
    const ds = el.dataset || {};
    for (const k of Object.keys(ds)) attrs["data-" + k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())] = String(ds[k]);
    if (el.id) attrs.id = String(el.id);
    /* 非 data-* 的属性只认这几颗（对账口径固定，不做通用反射） */
    for (const k of ["width", "height", "viewBox", "type"]) {
      const v = el.getAttribute && el.getAttribute(k);
      if (v != null) attrs[k] = String(v);
    }
    const style = {};
    for (const k of ["left", "top", "right", "width", "height", "color", "fontSize", "transform", "transformOrigin", "--nw", "--nh"]) {
      const v = el.style && el.style[k];
      if (v != null && v !== "") style[k] = String(v);
    }
    /* data-raw=1 = 内容整段塞进来的叶子（种类图标那一枚 SVG）：序列化出来的形参顺序 /
       自闭合写法与源码里的串不完全同形，所以签名只认这颗元素本身，不往里看。
       两种读法都认：浏览器里 dataset 与 attribute 互通，轻量假 DOM（冒烟）只认其中一种。 */
    const rawVal =
      (el.dataset && el.dataset.raw != null ? String(el.dataset.raw) : "") ||
      (el.getAttribute && el.getAttribute("data-raw") != null ? String(el.getAttribute("data-raw")) : "");
    const raw = rawVal === "1";
    return {
      tag: String(el.tagName || "").toLowerCase(),
      cls: String(el.className || ""),
      attrs,
      style,
      d: el.getAttribute && el.getAttribute("d") != null ? String(el.getAttribute("d")) : undefined,
      text: raw ? "" : el.children && el.children.length ? "" : String(el.textContent == null ? "" : el.textContent),
      kids: raw ? [] : (el.children || []).map(specOf).filter(Boolean),
    };
  }
  function normSpec(s) {
    if (!s) return "";
    const attrs = Object.keys(s.attrs || {})
      .sort()
      .map((k) => k + "=" + s.attrs[k])
      .join(",");
    const style = Object.keys(s.style || {})
      .sort()
      .map((k) => k + ":" + s.style[k])
      .join(",");
    const self =
      (s.tag || "") +
      "|" +
      String(s.cls || "")
        .split(/\s+/)
        .filter(Boolean)
        .sort()
        .join(" ") +
      "|" +
      attrs +
      "|" +
      style +
      (s.d ? "|d=" + s.d : "") +
      (s.text ? "|" + clip(String(s.text).replace(/\s+/g, " ").trim(), 80) : "");
    const kids = (s.kids || []).map(normSpec).join(";");
    return kids ? self + "{" + kids + "}" : self;
  }
  /** 结构签名：描述树或真 DOM 都行；用来做快照 / 对账（类名按集合排序，几何按值） */
  function signatureOf(x) {
    return normSpec(x && x.nodeType === 1 ? specOf(x) : x);
  }
  function sceneSignature(scene) {
    return signatureOf(treeOf(scene));
  }

  return {
    VERSION,
    GEOM,
    KIND_CLS,
    COVERED_KINDS: Object.keys(KIND_CLS),
    isCovered,
    /* 场景 */
    sceneOf,
    countsOf,
    /* 描述树 / 适配器 */
    treeOf,
    domOf,
    mount,
    mountNodeEl,
    /* 对账 */
    specOf,
    signatureOf,
    sceneSignature,
    /* 单项构建（宿主按需拼装时用） */
    nodeTreeOf: nodeTree,
    groupTreeOf: groupTree,
    markTreeOf: markTree,
    wireTreeOf: wireTree,
    /* 节点卡片正文的文案口径（take-player 按它算「这段正文是哪一帧长出来的」，
       不复制第二份剪裁 / 兜底规则） */
    summaryOf,
    /* 几何（供测试 / 宿主复核） */
    geometry: {
      inPortY,
      outPortY,
      portBandY,
      wirePathAB,
      markBounds,
    },
  };
});
