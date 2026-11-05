/* renderer/app-speakbar.js — 状态栏「最新语音播报」格（取代原来的画布统计文字）
 *
 * 需求：footer 里那几段统计文字（画布名 / 节点·连线 / 服务商 / 网格）整块下线，
 * 这一格改为显示**最新一条语音播报内容**；没有播报内容时直接采用**最新一轮 Agent 答复**。
 *   · 单行省略（状态栏高度不变，不放长文）；
 *   · 点击向上展开全文（浮层在状态栏上方），浮层里有「清空」；
 *   · 清空 = 把当前内容清掉（之后再来的播报 / 答复照常写入）。
 *
 * 数据来源（谁往这里写）：
 *   · 语音播报：renderer/app-tts.js 的 sendPiece() 每次把本轮累计要念的话写进来
 *     （说话即更新，不必等整段合成完）；
 *   · Agent 答复：renderer/app-assist.js 两处收尾（画布助手栏 / 会话视图）落消息时写进来。
 * 两者按「时间新的那个」显示：播报正常开启时永远是播报稿；语音关掉后自动回落到答复正文。
 *
 * 纪律：本模块只画状态栏这一格，不碰画布、不写文件；浮层为只读查看，
 * 关闭只走「再点一次 / ✕ / Esc」（不点外部自动关，见 AGENTS.md 的浮层口径）。
 *
 * 本需求（新闻条 + 呼吸灯）：
 *   · 这一格外圈是一圈细框（CSS .sb-speak-line 的 1px 边框）；
 *   · 框里的内容放不下就横向匀速单向循环滚动（.sb-speak-view.is-roll + --sb-speak-shift），
 *     放得下就静止 —— 位移与时长在这里按真实宽度现算，不靠在 CSS 里猜；
 *     单向 = 永远朝左走，走到尾接上第二份同样内容（无缝回绕），不倒着滚回去；
 *   · 出现新内容（新的播报稿 / 新的 Agent 答复）时细框走呼吸灯，60 秒后自动停；
 *     这 1 分钟里若又来了新内容，计时重新起算。
 */
(function () {
  "use strict";

  function T(s) {
    return typeof I18n !== "undefined" && I18n.t ? I18n.t(s) : s;
  }

  /* 呼吸灯时长（新内容到达后亮 1 分钟，之后停） */
  const FRESH_MS = 60000;
  /* 新闻条滚动速度（像素 / 秒）：慢一点才看得清，也不至于长文要等半天 */
  const ROLL_PX_S = 26;
  /* 无缝回绕时两份正文之间的间隔（与 CSS 的 --sb-speak-gap 同一个值） */
  const ROLL_GAP = 32;

  /* 两条候选：speech = 最新语音播报稿；reply = 最新一轮 Agent 答复 */
  const rec = {
    speech: null, /* { text, at } */
    reply: null, /* { text, at } */
  };
  let open = false;
  let built = false;
  let el = null;
  let freshTimer = 0;
  let shown = ""; /* 上一次画进框里的正文：用来判断「是不是新内容」 */

  function current() {
    const s = rec.speech;
    const r = rec.reply;
    if (s && (!r || s.at >= r.at)) return { text: s.text, kind: "speech" };
    if (r) return { text: r.text, kind: "reply" };
    return { text: "", kind: "" };
  }

  function build() {
    if (built) return;
    built = true;
    const host = document.getElementById("sbSpeak");
    if (!host) {
      built = false;
      return;
    }
    host.textContent = "";

    const line = document.createElement("button");
    line.type = "button";
    line.id = "sbSpeakBtn";
    line.className = "sb-speak-line";
    line.setAttribute("aria-expanded", "false");

    const icon = document.createElement("span");
    icon.className = "sb-speak-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "🔊";

    /* 框里再套一层裁剪容器：外层细框不动，滚的是里面这一行字 */
    const view = document.createElement("span");
    view.className = "sb-speak-view";

    /* 单向无缝循环：轨道里放两份同样的正文，走完一份正好接上第二份 */
    const track = document.createElement("span");
    track.className = "sb-speak-track";

    const text = document.createElement("span");
    text.className = "sb-speak-text";
    text.id = "sbSpeakText";
    const clone = document.createElement("span");
    clone.className = "sb-speak-text sb-speak-ghost";
    clone.setAttribute("aria-hidden", "true");
    track.appendChild(text);
    track.appendChild(clone);
    view.appendChild(track);

    line.appendChild(icon);
    line.appendChild(view);
    line.addEventListener("click", (e) => {
      e.preventDefault();
      toggle();
    });

    const pop = document.createElement("div");
    pop.className = "sb-speak-pop";
    pop.id = "sbSpeakPop";
    pop.hidden = true;

    const head = document.createElement("div");
    head.className = "sb-speak-pop-head";
    const title = document.createElement("b");
    title.className = "sb-speak-pop-title";
    title.textContent = T("语音播报全文");
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "mini sb-speak-clear";
    clearBtn.textContent = T("清空");
    clearBtn.title = T("清空这一格的内容（之后的播报 / 答复照常写入）");
    clearBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      clear();
    });
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "sb-speak-close";
    closeBtn.setAttribute("aria-label", T("关闭"));
    closeBtn.title = T("关闭（Esc）");
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    });
    head.appendChild(title);
    head.appendChild(clearBtn);
    head.appendChild(closeBtn);

    const body = document.createElement("div");
    body.className = "sb-speak-pop-body";
    body.id = "sbSpeakBody";

    pop.appendChild(head);
    pop.appendChild(body);

    host.appendChild(line);
    host.appendChild(pop);
    el = { host, line, view, track, text, clone, pop, body, clearBtn };
    /* 框宽变了（窗口缩放 / 换语言字宽变）要重算要不要滚、滚多远 */
    if (typeof ResizeObserver === "function") {
      try {
        new ResizeObserver(() => syncScroll()).observe(view);
      } catch (_) {}
    }
    window.addEventListener("resize", () => syncScroll());
    document.addEventListener(
      "keydown",
      (e) => {
        if (open && (e.key === "Escape" || e.key === "Esc")) {
          e.stopPropagation();
          setOpen(false);
        }
      },
      true,
    );
  }

  /* 新闻条：内容比框长就横向单向循环滚动，放得下就静止。
     位移 = 一份正文宽度 + 间隔（走完一份，第二份正好顶上，无缝回绕）；
     时长按真实宽度现算（写进 CSS 变量），DOM 不重建，滚动不会一次次从头上重来。 */
  function syncScroll() {
    if (!el) return;
    const view = el.view;
    const track = el.track;
    const text = el.text;
    view.classList.remove("is-roll");
    track.style.removeProperty("--sb-speak-shift");
    track.style.removeProperty("--sb-speak-dur");
    const w = text.getBoundingClientRect().width;
    const over = w - view.clientWidth;
    if (!(over > 4)) return;
    const step = w + ROLL_GAP;
    track.style.setProperty("--sb-speak-shift", -step + "px");
    track.style.setProperty(
      "--sb-speak-dur",
      Math.max(6, Math.round(step / ROLL_PX_S)) + "s",
    );
    view.classList.add("is-roll");
  }

  function stopFresh() {
    if (freshTimer) {
      clearTimeout(freshTimer);
      freshTimer = 0;
    }
    if (el) el.host.classList.remove("is-fresh");
  }

  /* 新内容到达：细框呼吸 60s（再来新内容就重新起算） */
  function markFresh() {
    if (!el) return;
    el.host.classList.remove("is-fresh");
    void el.host.offsetWidth; /* 强制回流，让动画从头开始 */
    el.host.classList.add("is-fresh");
    if (freshTimer) clearTimeout(freshTimer);
    freshTimer = setTimeout(() => {
      freshTimer = 0;
      if (el) el.host.classList.remove("is-fresh");
    }, FRESH_MS);
  }

  function paint() {
    build();
    if (!el) return;
    const cur = current();
    const body = cur.text || "";
    el.text.textContent = body || T("暂无播报内容");
    el.clone.textContent = el.text.textContent;
    el.host.classList.toggle("is-empty", !body);
    el.host.classList.toggle("is-reply", cur.kind === "reply" && !!body);
    el.line.title = body
      ? (cur.kind === "speech" ? T("最新语音播报") : T("最新 Agent 答复")) + " · " + T("点击展开全文")
      : T("还没有语音播报（会回落到最新一轮 Agent 答复）");
    el.body.textContent = body;
    el.clearBtn.disabled = !body;
    if (!body && open) setOpen(false);
    syncScroll();
    if (!body) {
      shown = "";
      stopFresh();
    } else if (body !== shown) {
      shown = body;
      markFresh();
    }
  }

  function setOpen(next) {
    build();
    if (!el) return;
    open = !!next;
    el.pop.hidden = !open;
    el.line.setAttribute("aria-expanded", open ? "true" : "false");
    el.host.classList.toggle("is-open", open);
  }

  function toggle() {
    setOpen(!open);
  }

  function clear() {
    rec.speech = null;
    rec.reply = null;
    if (open) setOpen(false);
    paint();
  }

  function setSpeech(text) {
    const body = String(text == null ? "" : text).trim();
    if (!body) return;
    rec.speech = { text: body, at: Date.now() };
    paint();
  }

  function setReply(text) {
    const body = String(text == null ? "" : text).trim();
    if (!body) return;
    rec.reply = { text: body, at: Date.now() };
    paint();
  }

  window.MTNodeSpeakBar = {
    setSpeech,
    setReply,
    clear,
    current,
    toggle,
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", paint);
  else paint();
})();
