"use strict";
/* ============ 输入框自适应高度 + 拖上边框调高（共享模块） ============
 * 出口：window.MTGrowInput（同层脚本只在调用期按 typeof 取用，无加载期依赖）。
 * 五只输入框共用这一份：会话 #agentInput、助手 #assistInput、团队 #teamChatInput、
 * 研究 .rs-chat-input、迷你聊天 #mcInput（renderer/mini-chat.html 单独引一次本文件）。
 *
 * 口径（用户已确认的共识，改行为前先读这一段）：
 *   1) 默认 = 各输入框自己 CSS 里的最低高度（min-height / 两行），不因上次内容变高；
 *   2) 文字变多自动增高（输入、粘贴、程序写入都算），**自动增高封顶** =
 *      min(宿主可视高 × 60%, 宿主可视高 − 120px) —— 给上方对话区留一块；
 *   3) 上边框整条可拖（6px 感应区）：向上拉高、向下拉低，下限 = 最低值，
 *      **拖动上限** = 宿主可视高 − 120px；窗口变小自动向下夹紧，不溢出；
 *   4) 手拖高度 = 基线（base）：拖过之后自动增高仍可在文字需要时往上撑，
 *      删字回落到基线，不跌回两行；
 *   5) 记忆：#agentInput 按会话记（localStorage，重启仍在），其余输入框不记忆
 *      （同一窗口活着时保持，视图重建 / 重开窗口回到最低）；
 *   6) 发送后清空 → 回落到基线（没手拖过就是最低值）。
 *
 * 为什么高度用 px 写进 style.height 而不是交给 CSS：textarea 没有「按内容长」的能力，
 * 只能先置 auto 读 scrollHeight 再写回（一次同步排版，输入框上这点成本可接受）。
 * box-sizing 两种都支持：内部一律按 border-box 记账，写回时再换算成元素自己的口径。
 *
 * 程序化写入（草稿回填 / 发送清空 / 整页重绘）不会触发 input 事件，所以除 input 监听外
 * 还有一条 250ms 的轻量比对（只比 value 的长度与换行数，不读 DOM）兜底；
 * 调用方也可以在关键路径上调 MTGrowInput.refresh(el) 立即重算。
 */
(function () {
  if (typeof window === "undefined" || window.MTGrowInput) return;

  const DRAG_H = 6; /* 上边框感应条高度（与 css/grow-input.css 的 .ta-grow-grip 一致） */
  const KEEP_PX = 120; /* 拖动上限要留给上方对话区的高度 */
  const GROW_RATIO = 0.6; /* 自动增高最多占宿主可视高的比例 */
  const IDLE_MS = 250; /* 程序化写入的兜底同步间隔 */
  const STORE_PREFIX = "mtnode.grow.h.";

  const els = new Set(); /* 已挂载的输入框（idle 同步要遍历） */
  const states = new Map(); /* el → state（仅内存，随元素一起回收） */
  let idleTimer = null;
  let ro = null; /* 共享 ResizeObserver：尺寸 / 宿主变化时重排 */

  function T(s) {
    try {
      if (typeof I18n !== "undefined" && I18n && typeof I18n.t === "function")
        return I18n.t(s);
    } catch (_) {}
    return s;
  }

  function num(v, d) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : d;
  }

  function clamp(v, lo, hi) {
    return Math.min(Math.max(v, lo), Math.max(lo, hi));
  }

  /* 尺寸口径：padY / borderY 用计算值，box 决定 style.height 是内容高还是总高。
     minBox = 元素此刻 CSS 给的最低高度（border-box 记账），读 min-height 优先，
     没写就按行数算（textarea 的 rows 语义）。
     **两者取大**：CSS 的 min-height 可能比 rows 矮（.chat-input 的 44 配两行 22.5 就装不下），
     只认 min-height 会让默认状态就出现一条滚动条 —— 用户口径的「最低值」= 现在这个空框的样子。 */
  function metrics(el) {
    const cs = getComputedStyle(el);
    const padY = num(cs.paddingTop, 0) + num(cs.paddingBottom, 0);
    const borderY = num(cs.borderTopWidth, 0) + num(cs.borderBottomWidth, 0);
    const box = cs.boxSizing === "border-box" ? "border" : "content";
    const lh = num(cs.lineHeight, 0) || num(cs.fontSize, 13) * 1.5;
    const rows = Math.max(1, num(el.rows, 2));
    const rowsBox = rows * lh + padY + borderY;
    const cssMin = num(cs.minHeight, 0);
    const minBox =
      cssMin > 0
        ? Math.max(box === "border" ? cssMin : cssMin + padY + borderY, rowsBox)
        : rowsBox;
    return { padY, borderY, box, minBox };
  }

  /* 宿主 = 高度稳定、输入框变高时由它内部让位的那个容器（对话区 / 面板）。
     传的是选择器链，取第一个命中且真有高度的 —— 输入区被搬到应用开发页时
     .agent-body 不在链上，自动落到 .apps-dev-conv。 */
  function hostOf(el, st) {
    const list = st.opts.hosts || [];
    for (const sel of list) {
      let h = null;
      try {
        h = el.closest(sel);
      } catch (_) {
        h = null;
      }
      if (h && h.clientHeight > 0) return h;
    }
    return null;
  }

  function hostHeight(el, st) {
    const h = hostOf(el, st);
    const n = h ? h.clientHeight : 0;
    if (n > 0) return n;
    return window.innerHeight || 0;
  }

  /* 两条上限：自动增高（60% 且留 120px）/ 拖动（只留 120px） */
  function caps(el, st) {
    const H = hostHeight(el, st);
    const m = metrics(el);
    const keep = num(st.opts.keep, KEEP_PX);
    const ratio = num(st.opts.ratio, GROW_RATIO);
    const dragMax = Math.max(m.minBox, H - keep);
    const autoMax = Math.max(m.minBox, Math.min(H * ratio, H - keep));
    return { dragMax, autoMax, minBox: m.minBox };
  }

  /* 记账口径（border-box）→ 元素自己的 style.height */
  function setBoxHeight(el, m, boxH) {
    const h = m.box === "border" ? boxH : boxH - m.padY - m.borderY;
    el.style.height = Math.max(0, Math.round(h * 100) / 100) + "px";
  }

  /* ── 持久化：只有配置了 keyOf 的输入框才落盘（#agentInput = 按会话） ── */
  function storeKey(st) {
    try {
      if (typeof st.opts.keyOf !== "function") return null;
      const k = String(st.opts.keyOf() || "").trim();
      return k ? STORE_PREFIX + k : null;
    } catch (_) {
      return null;
    }
  }

  function readBase(st) {
    const key = storeKey(st);
    if (!key) return null;
    try {
      const v = parseFloat(window.localStorage.getItem(key));
      return Number.isFinite(v) && v > 0 ? v : null;
    } catch (_) {
      return null;
    }
  }

  function writeBase(st, v) {
    const key = storeKey(st);
    if (!key) return;
    try {
      if (v == null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, String(Math.round(v)));
    } catch (_) {}
  }

  /* ── 排序：先按内容算高度（含基线 / 两条上限），再摆抓手 ── */
  function layout(el, st) {
    if (!el || !el.isConnected) return;
    const m = metrics(el);
    const c = caps(el, st);
    /* 手拖基线超过拖动上限（窗口被缩小）时先夹紧 —— 只影响本次生效值，
       用户原本拖到的值留着，窗口回大后自动恢复（与 .agent-side-resize 同口径）。 */
    const base = clamp(st.base == null ? m.minBox : st.base, m.minBox, c.dragMax);
    el.style.height = "auto";
    /* 空框不读 scrollHeight：占位符（placeholder）也在 textarea 的内容层里，
       框一窄它就会换成好几行，把这当成「内容需要更高」会让空框凭空长高一行 ——
       空框一律按最低值（或手拖基线）收口，与用户口径一致。 */
    const hasText = String(el.value || "").length > 0;
    const need = hasText ? el.scrollHeight + m.borderY : 0;
    const cap = Math.max(c.autoMax, base);
    const want = clamp(Math.max(need, base, m.minBox), m.minBox, cap);
    setBoxHeight(el, m, want);
    placeGrip(el, st);
    watch(el, st);
  }

  /* 抓手贴着输入框上边框：用 rect 差算，输入框在 flex 里左右留白 / 附件条把它推下去都能跟上 */
  function placeGrip(el, st) {
    const grip = st.grip;
    if (!grip || !grip.isConnected) return;
    const box = grip.parentElement; /* 抓手挂在输入框的父元素上（不是布局宿主） */
    if (!box || !el.isConnected) return;
    const r = el.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    if (!r.width) return;
    /* 抓手是绝对定位：坐标相对父元素的 padding box（border 内沿），
       所以从 rect 差里减掉父元素的边框宽度（clientLeft / clientTop）。 */
    grip.style.left = Math.round(r.left - b.left - box.clientLeft) + "px";
    grip.style.width = Math.round(r.width) + "px";
    grip.style.top = Math.round(r.top - b.top - box.clientTop - DRAG_H / 2) + "px";
  }

  function ensureGrip(el, st) {
    if (st.grip && st.grip.isConnected) return st.grip;
    const parent = el.parentElement;
    if (!parent) return null;
    let pos = "static";
    try {
      pos = getComputedStyle(parent).position || "static";
    } catch (_) {
      pos = "static";
    }
    if (pos === "static") parent.classList.add("ta-grow-host");
    const grip = document.createElement("div");
    grip.className = "ta-grow-grip";
    grip.setAttribute("role", "separator");
    grip.setAttribute("aria-orientation", "horizontal");
    grip.setAttribute("aria-label", T("拖动调整输入框高度"));
    grip.tabIndex = 0;
    grip.title = T("拖动上边框调整输入框高度（双击回到最低）");
    parent.appendChild(grip);
    st.grip = grip;
    bindGrip(el, st, grip);
    return grip;
  }

  function bindGrip(el, st, grip) {
    grip.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0 || st.dragging) return;
      ev.preventDefault();
      ev.stopPropagation();
      const m = metrics(el);
      const startY = ev.clientY;
      const startBox = el.offsetHeight;
      st.dragging = true;
      grip.classList.add("dragging");
      const onMove = (e) => {
        if (!st.dragging) return;
        const c = caps(el, st);
        /* 输入框在抓手下方：向上拖（Y 变小）= 变高，每步都按此刻实测上限夹住 */
        const box = clamp(startBox + (startY - e.clientY), m.minBox, c.dragMax);
        st.base = box;
        st.manual = box;
        setBoxHeight(el, m, box);
        placeGrip(el, st);
      };
      const onUp = () => {
        if (!st.dragging) return;
        st.dragging = false;
        grip.classList.remove("dragging");
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onUp);
        writeBase(st, st.base); /* 松手才落盘（同 .ap-grip：拖到的就是此刻放得下的值） */
        layout(el, st);
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onUp);
    });
    /* 双击 = 回到最低（与 .ap-grip / .agent-side-resize 双击还原同口径），并清掉落盘的记忆 */
    grip.addEventListener("dblclick", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      st.base = null;
      st.manual = null;
      writeBase(st, null);
      layout(el, st);
    });
    /* 键盘也能调：↑/↓ 各 24px，Home 复位（抓手 tabIndex=0，a11y 与鼠标同一套口径） */
    grip.addEventListener("keydown", (ev) => {
      const m = metrics(el);
      const c = caps(el, st);
      if (ev.key === "Home") {
        ev.preventDefault();
        st.base = null;
        writeBase(st, null);
        layout(el, st);
        return;
      }
      if (ev.key !== "ArrowUp" && ev.key !== "ArrowDown") return;
      ev.preventDefault();
      const cur = el.offsetHeight;
      const step = ev.key === "ArrowUp" ? -24 : 24;
      const box = clamp(cur + step, m.minBox, c.dragMax);
      st.base = box;
      st.manual = box;
      writeBase(st, box);
      setBoxHeight(el, m, box);
      placeGrip(el, st);
    });
  }

  function sigOf(el) {
    const v = String(el.value || "");
    let nl = 0;
    for (let i = 0; i < v.length; i++) if (v.charCodeAt(i) === 10) nl++;
    return v.length + ":" + nl + ":" + (el.offsetWidth || 0);
  }

  function idleTick() {
    if (typeof document !== "undefined" && document.visibilityState === "hidden")
      return;
    for (const el of Array.from(els)) {
      const st = states.get(el);
      if (!st) {
        els.delete(el);
        continue;
      }
      if (!el.isConnected) {
        els.delete(el);
        states.delete(el);
        if (ro && st) {
          try {
            ro.unobserve(el);
            if (st.host) ro.unobserve(st.host);
          } catch (_) {}
        }
        continue;
      }
      const sig = sigOf(el);
      if (sig === st.sig) continue;
      st.sig = sig;
      layout(el, st);
    }
  }

  /* 尺寸变化的唯一观察者（一只共享 RO）：
       · 自己这只输入框尺寸变了 → 只重摆抓手（高度本来就是模块写的，再算一次没意义）；
       · 宿主面板尺寸变了（拖分栏 / 换视图 / 窗口缩放）→ 重新按新上限夹一次。
     宿主跟着视图切（输入区被搬到应用开发页）时，watch 会在下一次 layout 里换观察对象。 */
  function ensureRO() {
    if (ro || typeof ResizeObserver !== "function") return ro;
    ro = new ResizeObserver((entries) => {
      for (const ent of entries) {
        for (const el of Array.from(els)) {
          const st = states.get(el);
          if (!st) continue;
          /* 自己与宿主都用同一条出口：layout 是幂等的（算出来一样就不再写 DOM，
             值不变的 style.height 不会再触发一次 RO），所以这里不必分两条路。 */
          if (ent.target === el || st.host === ent.target) layout(el, st);
        }
      }
    });
    return ro;
  }

  function watch(el, st) {
    if (!ensureRO()) return;
    if (!st.selfWatched) {
      st.selfWatched = true;
      ro.observe(el);
    }
    const h = hostOf(el, st);
    if (h && h !== st.host) {
      if (st.host) {
        try {
          ro.unobserve(st.host);
        } catch (_) {}
      }
      st.host = h;
      ro.observe(h);
    }
  }

  function onInput(el, st) {
    st.sig = sigOf(el);
    layout(el, st);
  }

  /**
   * 把一只 textarea 变成「随内容增高 + 上边框可拖」。
   * @param {HTMLTextAreaElement} el
   * @param {object} opts
   *   hosts   {string[]} 宿主选择器链（高度稳定的面板容器），缺省 = 窗口高度
   *   keyOf   {() => string} 非空则按它落盘高度（每次现取：切会话即换 key）
   *   ratio   {number} 自动增高占宿主高的比例，缺省 0.6
   *   keep    {number} 上限要留出的对话区高度，缺省 120
   */
  function attach(el, opts) {
    if (!el || !/^textarea$/i.test(el.tagName || "")) return null;
    const old = states.get(el);
    if (old) return old;
    const st = {
      opts: opts || {},
      base: null,
      manual: null,
      grip: null,
      dragging: false,
      sig: "",
      host: null,
      hostWatched: false,
      selfWatched: false,
    };
    states.set(el, st);
    els.add(el);
    el.classList.add("ta-grow");
    st.base = readBase(st); /* 只有配了 keyOf 的输入框读得到东西 */
    ensureGrip(el, st);
    onInput(el, st);
    /* 首帧：元素可能还没进文档 / 还没有宽度，下一帧再排一次 */
    if (typeof requestAnimationFrame === "function")
      requestAnimationFrame(() => {
        if (el.isConnected) {
          ensureGrip(el, st);
          layout(el, st);
          st.sig = sigOf(el);
        }
      });
    el.addEventListener("input", () => onInput(el, st));
    el.addEventListener("change", () => onInput(el, st));
    el.addEventListener("compositionend", () => onInput(el, st));
    el.addEventListener("focus", () => {
      ensureGrip(el, st);
      layout(el, st);
    });
    watch(el, st);
    if (!idleTimer) idleTimer = setInterval(idleTick, IDLE_MS);
    return st;
  }

  function refresh(el) {
    const st = el && states.get(el);
    if (!st) return;
    ensureGrip(el, st);
    onInput(el, st);
  }

  function reset(el) {
    const st = el && states.get(el);
    if (!st) return;
    st.base = null;
    st.manual = null;
    writeBase(st, null);
    layout(el, st);
  }

  /* 切会话（草稿回填 / 换了 key）后立刻按新会话的记忆重排一次。
     #agentInput 的 key 是会话 id：先读回新 key 的高度，再按当前内容算。 */
  function rekey(el) {
    const st = el && states.get(el);
    if (!st) return;
    const b = readBase(st);
    st.base = b;
    onInput(el, st);
  }

  if (typeof window.addEventListener === "function") {
    window.addEventListener("resize", () => {
      for (const el of Array.from(els)) {
        const st = states.get(el);
        if (st && el.isConnected) layout(el, st);
      }
    });
    window.addEventListener("orientationchange", () => {
      for (const el of Array.from(els)) {
        const st = states.get(el);
        if (st && el.isConnected) layout(el, st);
      }
    });
  }

  window.MTGrowInput = { attach, refresh, reset, rekey, layout };
})();
