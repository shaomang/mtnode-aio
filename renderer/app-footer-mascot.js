/* ============================================================================
 * 状态栏右下角的点阵小人（renderer/app-footer-mascot.js + css/footer-mascot.css）
 * ----------------------------------------------------------------------------
 * 需求：在 footer 版本号（#authorLink）左侧放一个 32×24 的点阵小人动画，
 * 随「闲时 / 忙碌中 / 长期闲时」三态自动切换，透明背景、不写文字标签，
 * 悬停给一句状态说明（tooltip），不可点、不弹提示。
 *
 * 三态口径（已与用户逐条确认，别自行改回去）：
 *   · 忙碌中（最高优先）= 内置运行队列 collectRunQueueAll() 的 items 非空 —— 与状态栏
 *     「运行队列」按钮同一个真源（画布节点、开发块、媒体生成在途/排队、
 *     任意 Agent 会话在跑），不新增第二套判定，永不与队列显示打架；
 *     注意它返回的是汇总对象 { items, counts, hasQueue }，不是数组（见 readBusy）；
 *   · 长期闲时 = 队列为空，且距最后一次活动 ≥ 5 分钟。活动只有两种：
 *     ① 模型运行结束（忙碌 → 空闲的那一拍）；② 画布内容编辑（pushHistory 那一拍，
 *     含增删节点/连线/改参数/拖动后松手）。平移、缩放、点选、切面板都不算，
 *     这正是需求里「编辑画布」的字面意思；
 *   · 闲时 = 队列为空且未满 5 分钟。
 *   忙碌一结束立即回闲时（不留余韵）；启动即闲时，5 分钟从应用启动算，不落盘。
 *
 * 画面来源：**直接取用户给的像素参考表原图**（三行 × 六帧），不重画。
 * 真源是 renderer/img/footer-mascot.png —— 一张从参考截图里逐格切出来、去掉
 * 白底、按统一比例缩放的 3×6 精灵表（每格 64×48，行 = 状态，列 = 帧）：
 *   第 0 行 闲时（坐着待机，轻微呼吸/眨眼）
 *   第 1 行 忙碌中（俯身对着桌上的设备操作）
 *   第 2 行 长期闲时（裹着被子侧躺，旁边飘 zzz）
 * 切帧脚本的思路与参数写在文件末尾的「精灵表来源」注释里，便于以后换图重切。
 *
 * 实现：32×24 的 <canvas>（背板 64×48，HiDPI 下再降采样一次，边缘不糊）。
 * 图片加载失败时画布保持透明，不抛错、不影响状态栏。
 * 每态 6 帧（参考表就是 6 帧一行）：闲时 500ms/帧、忙碌 250ms/帧、睡着 800ms/帧。
 *
 * 心跳：250ms 一拍只推进当前动画帧（纯本地计算，不取数）；运行队列的状态
 * 每秒才取一次（collectRunQueueAll 要扫画布与会话，4Hz 没必要）。页面隐藏
 * 时整拍跳过，回来再按真实时间轴算帧 —— 不会因为省电而「慢动作」。
 *
 * 本文件只碰这一块 DOM：不改画布、不写任何持久化数据、不新增主进程代码。
 * ========================================================================== */
(function () {
  "use strict";

  const W = 32; /* CSS 尺寸（容器与 canvas 的显示尺寸，不改变状态栏高度） */
  const H = 24;
  const CELL_W = 64; /* 精灵表单格尺寸（背板 2 倍，见文件末尾） */
  const CELL_H = 48;
  const COLS = 6; /* 参考表一态 6 帧 */
  const ROW = { idle: 0, busy: 1, sleep: 2 };
  const FRAME_MS = { idle: 500, busy: 250, sleep: 800 };
  const SLEEP_AFTER_MS = 5 * 60 * 1000; /* 5 分钟：需求写死，不进设置 */
  const TICK_MS = 250;
  const BUSY_POLL_MS = 1000;
  const SHEET_SRC = "img/footer-mascot.png";

  /* ── 精灵表 ────────────────────────────────────────────────────────────
     单张 PNG（384×144 = 6×64 与 3×48）；加载完成后才开始出帧。 */
  let sheet = null;
  let sheetFailed = false;
  function loadSheet() {
    if (typeof Image === "undefined") return;
    const img = new Image();
    img.onload = () => {
      sheet = img;
    };
    img.onerror = () => {
      sheetFailed = true;
    };
    img.src = SHEET_SRC;
  }
  loadSheet();

  /* ── 状态机（纯函数，可单独跑）─────────────────────────────────────────
     busy 优先；否则看「距最后一次活动」是否已满 5 分钟。lastActivity 与
     bootAt 取大的那个：应用刚起来，第一次活动的起点就是启动时刻。 */
  function poseAt(opt) {
    const o = opt || {};
    if (o.busy) return "busy";
    const now = Number(o.now) || 0;
    const bootAt = Number(o.bootAt) || 0;
    const last = Math.max(bootAt, Number(o.lastActivity) || 0);
    if (now - last >= SLEEP_AFTER_MS) return "sleep";
    return "idle";
  }

  /* 帧序号：按「进入该状态后过了多久」算，不累计自增 —— 页面隐藏回来也不会错拍。 */
  function frameAt(pose, elapsedMs) {
    const ms = FRAME_MS[pose] || FRAME_MS.idle;
    const n = Math.floor(Math.max(0, Number(elapsedMs) || 0) / ms);
    return n % COLS;
  }

  /* ── 画一帧（从精灵表里取一格贴上去）────────────────────────────────── */
  function paint(ctx, pose, frame) {
    ctx.clearRect(0, 0, CELL_W, CELL_H);
    if (!sheet) return;
    const row = ROW[pose];
    if (row === undefined) return;
    const col = Math.max(0, Math.min(COLS - 1, Number(frame) || 0));
    ctx.drawImage(
      sheet,
      col * CELL_W,
      row * CELL_H,
      CELL_W,
      CELL_H,
      0,
      0,
      CELL_W,
      CELL_H,
    );
  }

  /* ── 文案（走 I18n，与状态栏其它提示同一套词条）────────────────────── */
  function t(s) {
    try {
      if (typeof I18n !== "undefined" && I18n && typeof I18n.t === "function")
        return I18n.t(s);
    } catch (_) {}
    return s;
  }

  function tipOf(pose, now, lastActivity) {
    if (pose === "busy") return t("忙碌中 · 有模型在运行");
    if (pose === "sleep") return t("长期闲时 · 5 分钟以上没有运行模型或编辑画布");
    const mins = Math.max(0, Math.floor((now - lastActivity) / 60000));
    return t("闲时 · 距上次活动 ") + mins + t(" 分钟");
  }

  /* ── 运行队列（忙碌判定）：与状态栏「运行队列」按钮同一真源 ───────────
     collectRunQueueAll() 返回的是**汇总对象** { items, running, waiting, assist,
     counts, hasQueue }，不是数组（旧版这里按数组判 length，于是永远判空 ——
     「队列里有活在跑，小人却一直闲时」就是它）。取数与 app-db.js 的
     dshRunQueueDoneCheck（完成音那处队列对比）同一口径。 */
  function queueBusy(q) {
    if (!q) return false;
    const items = Array.isArray(q) ? q : q.items;
    return !!(Array.isArray(items) && items.length > 0);
  }
  function readBusy() {
    try {
      if (typeof collectRunQueueAll !== "function") return false;
      return queueBusy(collectRunQueueAll());
    } catch (_) {
      return false;
    }
  }

  /* ── 挂载 ──────────────────────────────────────────────────────────── */
  function mount() {
    const cv = document.getElementById("footerMascot");
    if (!cv || typeof cv.getContext !== "function") return;

    /* 背板 2 倍尺寸：CSS 仍是 32×24（见 css/footer-mascot.css），
       画的时候 1:1 贴 64×48 的格子，由浏览器做最后一次降采样。 */
    cv.width = CELL_W;
    cv.height = CELL_H;

    const ctx = cv.getContext("2d");
    if (!ctx) return;
    try {
      ctx.imageSmoothingEnabled = true;
    } catch (_) {}

    const bootAt = Date.now();
    let lastActivity = bootAt; /* 启动即闲时，5 分钟从启动算（不落盘） */
    let busy = readBusy();
    let lastPoll = Date.now();
    let pose = "";
    let poseAtMs = bootAt;
    let frame = -1;
    let lastTip = "";
    let lastPainted = "";

    /* 画布内容编辑 = pushHistory 那一拍（增删节点/连线/改参数/拖动后松手）。
       只挂一次；原函数照常执行，钩子里出任何错都不影响编辑本身。 */
    if (!window.__mtFooterMascotHook && typeof window.pushHistory === "function") {
      const orig = window.pushHistory;
      window.pushHistory = function () {
        try {
          noteActivity();
        } catch (_) {}
        return orig.apply(this, arguments);
      };
      window.__mtFooterMascotHook = true;
    }

    function noteActivity() {
      lastActivity = Date.now();
      /* 立刻重算一次，免得「刚编辑完却还在打盹」拖到下一拍（最多 250ms 迟滞） */
      tick(true);
    }

    function tick(fromActivity) {
      const now = Date.now();
      if (!fromActivity && typeof document !== "undefined" && document.hidden) return;

      /* 忙碌状态每秒取一次：队列从「有」变「无」的那一拍就是一次活动（模型跑完） */
      if (now - lastPoll >= BUSY_POLL_MS) {
        lastPoll = now;
        const next = readBusy();
        if (busy && !next) lastActivity = now;
        busy = next;
      }

      const nextPose = poseAt({ now, busy, lastActivity, bootAt });
      if (nextPose !== pose) {
        pose = nextPose;
        poseAtMs = now;
        frame = -1;
      }
      const nextFrame = frameAt(pose, now - poseAtMs);
      const key = pose + ":" + nextFrame;
      if (key !== lastPainted && (sheet || sheetFailed)) {
        /* 图片还没到就先不画（到了自然会在下一拍补上），失败则保持透明 */
        lastPainted = key;
        frame = nextFrame;
        paint(ctx, pose, frame);
      }

      const tip = tipOf(pose, now, lastActivity);
      if (tip !== lastTip) {
        lastTip = tip;
        cv.title = tip;
        cv.setAttribute("aria-label", tip);
      }
    }

    /* 第一帧立刻画出来（不等 250ms 后那一拍，避免启动瞬间是个空画布） */
    pose = poseAt({ now: bootAt, busy, lastActivity, bootAt });
    poseAtMs = bootAt;
    frame = 0;
    lastTip = tipOf(pose, bootAt, lastActivity);
    cv.title = lastTip;
    cv.setAttribute("aria-label", lastTip);

    if (typeof setInterval === "function") setInterval(() => tick(false), TICK_MS);
  }

  /* 冒烟 / 排障用的只读探针（不改任何状态，也不依赖 DOM —— node 里也能跑）：
     poseAt / frameAt 是纯函数；paint 可以在假 ctx 上重画任意一帧（sheet 未加载
     时只清屏）。 */
  const API = {
    poseAt,
    frameAt,
    paint,
    queueBusy,
    readBusy,
    size: { w: W, h: H },
    cell: { w: CELL_W, h: CELL_H },
    cols: COLS,
    frames: FRAME_MS,
    sleepAfterMs: SLEEP_AFTER_MS,
    sheetSrc: SHEET_SRC,
  };
  if (typeof window !== "undefined") window.MTNodeFooterMascot = API;
  else if (typeof globalThis !== "undefined") globalThis.MTNodeFooterMascot = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;

  if (typeof document !== "undefined") {
    if (document.readyState === "loading")
      document.addEventListener("DOMContentLoaded", mount);
    else mount();
  }
})();

/* ── 精灵表来源（换图 / 重切时按这个来）─────────────────────────────────
 * 真源：用户给的像素参考截图（3 行 × 6 帧，白底）。
 * 切法：按行做列投影找出 6 个帧组（组间留白列，行首那块是「待机中/工作中/
 * 睡着了」文字标签，不要），从边界外圈对白底做 flood fill 置透明（保留围裙/
 * 头饰内部的白），再把边界那圈与白底混出来的浅色像素换成邻近的角色色（否则
 * 深色状态栏上会有一圈白边）。
 * 对齐（人物不抖的关键）：同一行内以首帧为参考，用不透明遮罩做 IoU 互相关
 * 找出每帧的平移量，18 帧共用同一个缩放比例（S 由最高的一帧算出），底边压
 * 在同一条基线 y=44、水平按内容居中 —— 不做逐帧自适应缩放，否则帧间人物会
 * 一大一小地"呼吸"。拼成 renderer/img/footer-mascot.png（384×144）。
 * 不重画、不改色。
 * ========================================================================== */
