/* ===== 研究演示「初始化卡」（版本 / 风格 / 额外指示）· renderer/app-research-slides-init.js =====
 *
 * window.MTResearchSlidesInit（UMD：浏览器挂全局，node 里可直接 require —— 纯 DOM，不读盘 / 不联网）
 *
 * 为什么单独一份：这张卡是「演示还没定调」时的一次性仪式（版本 / 风格 / 额外指示），
 * 生命周期与三栏编辑器不同（编辑器天天开着，卡只在首次和「初始化设置」时开）。
 * 它只产出两样纯数据：brief（内核 normalizeBrief 那一份）与 theme（preset + mode），
 * 写盘 / 重算页 / 打开编辑器全在宿主（renderer/app-research.js 的 rsSlidesInitSubmit）——
 * 与 app-research-slides.js 同一条纪律：界面不碰盘，落盘只有一个入口（rsDeckSave）。
 *
 * 四块（与 docs/research-slides-video-spec.md §4 / §9 对齐）：
 *   ① 做法  tier：按指示创作（Agent 先写演示稿 → 内核编页）/ 照原文直出（确定性切页）+ 联网补料开关
 *   ② 版本  brief.mode：静态演示 / Remotion 视频 / 两个都要（白名单与文案都以内核为准）
 *   ③ 风格  theme：6 套预设 × 明 / 暗，缩略图直接吃 styleTokens 的颜色 + 字体（与 HTML / 视频同一份）
 *   ④ 指示  brief：受众 / 场合 / 时长 / 重点 / 忌口（各带快捷 chips）+ 自由文本 extra
 * 边界那句随做法变：创作档「研究里的稿子只是素材，新内容写成研究笔记并注明出处」。
 *
 * 浮层口径（仓规 persistent）：只走窗内 ✕ / 取消 / Esc，点幕布与点外部一律不关；
 * 同一时刻只留一块（OPEN 单例，重复 open 抬回并保持已填内容）。
 *
 * 依赖注入（opts）：
 *   brief     当前 brief（老存档没有就传 null → 归一成默认值）
 *   theme     当前主题（{ preset, mode } 或整张表；只取 preset / mode）
 *   tier      可选，"author"（缺省）/ "direct"：页从演示稿编来，还是原文确定性直切
 *   online    可选，联网补料开关（缺省 true；false = 只用本地资料）
 *   deck      可选，只为了标题（deck.title）
 *   title     可选，标题（没有 deck 时用）
 *   hint      可选，底部那句落盘提示（宿主传 slides/<slug>.json）
 *   reason    "init"（首次，缺省）| "settings"（从编辑器顶栏再打开改）
 *   onSubmit({ brief, theme, mode, tier, online })  必填；返回 false 或 {ok:false,error} = 没落盘成功，卡留着继续改
 *   onClose() 关闭之后
 *   doc       可选，换一份 document（自验用）
 *
 * 对外：window.MTResearchSlidesInit（open / close / isOpen / state）
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else if (root) root.MTResearchSlidesInit = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const VER = 1;
  /* 样式在 css/research-slides.css（本模块不注样式：卡只在应用内出现，不跟着导出文件走） */
  const CSS_HINT = "css/research-slides.css";

  /* 版本：id 走内核 BRIEF_MODES（不另抄一份枚举），文案按本卡的说法 */
  const MODE_LABEL = { slides: "静态演示", video: "Remotion 视频", both: "两个都要" };
  const MODE_HINT = {
    slides: "只出可翻页的静态版（HTML / PDF / PNG），内核直出、不花 Token",
    video: "只出 Remotion 视频（mp4），按这套风格的运动参数排",
    both: "两版都出：同一份页、同一份颜色与字体，只有出口不同",
  };
  const FONT_FALLBACK = { sans: "无衬线", serif: "衬线", kai: "楷体" };
  const MODE_FALLBACK = ["light", "dark"];
  const MODE_CN = { light: "明", dark: "暗" };

  /* 快捷 chips：点一下填进对应字段（受众 / 场合 再点一次清空；重点 / 忌口 是增删） */
  const CHIPS = {
    audience: ["同行研究者", "评审 / 答辩委员", "学生", "客户 / 高管", "公众"],
    occasion: ["组会", "周会", "学术会议", "答辩", "路演", "课堂"],
    duration: [5, 10, 20, 45],
    focus: ["方法", "结论", "数据", "局限", "应用"],
    avoid: ["不吹成果", "不堆术语", "不念稿", "不放公式", "不展开背景"],
  };

  function core() {
    if (typeof window !== "undefined" && window && window.MTResearchSlides) return window.MTResearchSlides;
    if (typeof require === "function") {
      try {
        return require("./research-slides.js");
      } catch (_) {
        return null;
      }
    }
    return null;
  }

  function str(v) {
    return String(v == null ? "" : v);
  }
  function el(doc, tag, cls, text) {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = str(text);
    return n;
  }
  function toastSafe(msg, kind) {
    try {
      if (typeof toast === "function") toast(msg, kind || "ok");
      else console.log("[research-slides-init]", msg);
    } catch (_) {}
  }
  /* styleTokens（颜色 + 字体 + 圆角 + 运动量，静态版 / 视频版共用那一份）；
     内核还没这一层时退回 themeVars（只少 motion / plan，缩略图不受影响）。 */
  function tokensOf(C, brief, theme) {
    try {
      if (C && typeof C.styleTokens === "function") return C.styleTokens(brief, theme);
    } catch (_) {}
    const th = C && typeof C.normalizeTheme === "function" ? C.normalizeTheme(theme) : { preset: "paper", mode: "light", font: "serif" };
    return {
      theme: th,
      css: C && typeof C.themeVars === "function" ? C.themeVars(th) : {},
      font: "",
      fontSize: "",
      radius: "",
      shadow: "",
      transition: th.transition || "fade",
      motion: null,
      plan: null,
    };
  }
  function fontLabelOf(C, font) {
    const one = C && C.FONTS ? C.FONTS[font] : null;
    return (one && one.label) || FONT_FALLBACK[font] || str(font);
  }
  function splitList(v) {
    return str(v)
      .split(/[,，、;；\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /* 同一时刻只留一块（重复 open 抬回，不重建 —— 已填的东西不能因为再点一次就丢） */
  let OPEN = null;

  function open(opts) {
    const o = opts && typeof opts === "object" ? opts : {};
    const C = core();
    if (!C || typeof C.normalizeBrief !== "function") return null;
    const D = o.doc || (typeof document !== "undefined" ? document : null);
    if (!D || !D.body) return null;
    if (OPEN) {
      OPEN.raise();
      return OPEN;
    }

    /* 开面板先收掉节点级浮层（app.js 的 closeNodePopsExcept，按调用期取；没接上就跳过） */
    if (typeof closeNodePopsExcept === "function") closeNodePopsExcept("");

    const brief0 = C.normalizeBrief(o.brief);
    const th0 = C.normalizeTheme(o.theme || {});
    const st = {
      brief: brief0,
      /* 风格只存 preset + mode：整张变量表由内核按这两样现算（与编辑器同一口径） */
      theme: { preset: th0.preset, mode: th0.mode },
      /* 做法：author = 按指示创作（Agent 先写演示稿，页由稿子编来）；direct = 照原文直出（确定性切页）。
         缺省 author —— 「优先按用户要求制作」是这一版的默认口径；老存档没有这两个键时也是它。 */
      tier: str(o.tier) === "direct" ? "direct" : "author",
      /* 联网补料：默认开。关了就只有本地资料（快档也仍是零 Token 的确定性直出）。 */
      online: o.online === false ? false : true,
      reason: str(o.reason) === "settings" ? "settings" : "init",
      title: str(o.title) || str((o.deck && o.deck.title) || ""),
      hint: str(o.hint),
      busy: false,
      err: "",
      onSubmit: typeof o.onSubmit === "function" ? o.onSubmit : null,
      onClose: typeof o.onClose === "function" ? o.onClose : null,
    };
    const W = D.defaultView || (typeof window !== "undefined" ? window : null);

    /* ── 骨架：幕布 + 卡（persistent：幕布不接关闭） ──────────────────────── */
    const curtain = el(D, "div", "rs-deck-init-curtain");
    const win = el(D, "div", "rs-deck-init-win");
    win.id = "rsSlidesInit";
    win.setAttribute("role", "dialog");
    win.setAttribute("aria-modal", "true");
    const head = el(D, "div", "rs-deck-init-head");
    const headBox = el(D, "div", "rs-deck-init-headbox");
    const titleEl = el(D, "span", "rs-deck-init-title", st.reason === "settings" ? "演示设置" : "新建演示");
    const subEl = el(D, "span", "rs-deck-init-sub");
    const btnX = el(D, "button", "rs-deck-init-x", "✕");
    btnX.type = "button";
    btnX.title = "关闭（Esc）";
    headBox.appendChild(titleEl);
    headBox.appendChild(subEl);
    head.appendChild(headBox);
    head.appendChild(btnX);

    const body = el(D, "div", "rs-deck-init-body");
    const foot = el(D, "div", "rs-deck-init-foot");
    win.appendChild(head);
    win.appendChild(body);
    win.appendChild(foot);
    curtain.appendChild(win);

    function subtitle() {
      const parts = [];
      if (st.title) parts.push(st.title);
      parts.push(st.reason === "settings" ? "改完立刻重排，手改与页序都保留" : "做法决定页从哪来：演示稿 / 原文直切");
      return parts.join(" · ");
    }
    subEl.textContent = subtitle();

    /* 卡的界面色吃选中风格的那套变量（--rs-slide-*）：选哪套，卡就长哪套 */
    function applyVars() {
      const tok = tokensOf(C, st.brief, st.theme);
      const vars = tok.css || {};
      for (const k of Object.keys(vars)) win.style.setProperty(k, vars[k]);
      if (!vars["--rs-slide-font"] && tok.font) win.style.setProperty("--rs-slide-font", tok.font);
    }
    function setStatus(msg) {
      st.err = str(msg);
      if (errEl) errEl.textContent = st.err;
    }

    /* ── ① 做法：按指示创作 / 照原文直出 + 联网补料 ──────────────────────── */
    const secTier = el(D, "div", "rs-deck-init-sec");
    const headTier = el(D, "div", "rs-deck-init-sechead");
    headTier.appendChild(el(D, "span", "rs-deck-init-secn", "①"));
    headTier.appendChild(el(D, "span", "rs-deck-init-sectitle", "做法"));
    headTier.appendChild(el(D, "span", "rs-deck-init-sechint", "以你的指示为准；研究现有内容只作参考素材"));
    secTier.appendChild(headTier);
    const tierRow = el(D, "div", "rs-deck-init-modes");
    const tierBtns = [];
    const tierHint = el(D, "div", "rs-deck-init-modehint");
    const TIERS = [
      {
        id: "author",
        label: "按指示创作",
        hint: "Agent 先写演示稿（每页一节 + 旁白 + 引用），内核再编成页；可联网补料，新内容写成研究笔记",
      },
      {
        id: "direct",
        label: "照原文直出",
        hint: "确定性切页：核心原文 + 3-Pass 变体直接成页，不花 Token、不重写叙事",
      },
    ];
    for (const t of TIERS) {
      const b = el(D, "button", "rs-deck-init-tier");
      b.type = "button";
      b.dataset.val = t.id;
      b.appendChild(el(D, "b", null, t.label));
      b.appendChild(el(D, "span", "rs-deck-init-mode-h", t.hint));
      b.addEventListener("click", () => {
        st.tier = t.id;
        paintTier();
        paintFoot();
      });
      tierBtns.push(b);
      tierRow.appendChild(b);
    }
    secTier.appendChild(tierRow);
    secTier.appendChild(tierHint);
    /* 联网补料：默认开；关掉就只有本地资料（快档照旧零 Token） */
    const netRow = el(D, "div", "rs-deck-init-row");
    netRow.appendChild(el(D, "span", "rs-deck-init-label", "联网补料"));
    const netFields = el(D, "div", "rs-deck-init-fields");
    const netBtn = el(D, "button", "rs-deck-init-chip");
    netBtn.type = "button";
    netBtn.addEventListener("click", () => {
      st.online = !st.online;
      paintTier();
      paintFoot();
    });
    netFields.appendChild(netBtn);
    const netHint = el(D, "span", "rs-deck-init-fhint", "开了：为解释原文术语 / 公式可检索公开来源，来源写进笔记；关了：只用本地资料");
    netFields.appendChild(netHint);
    netRow.appendChild(netFields);
    secTier.appendChild(netRow);
    body.appendChild(secTier);
    function paintTier() {
      for (const b of tierBtns) b.classList.toggle("is-on", b.dataset.val === st.tier);
      const one = TIERS.filter((t) => t.id === st.tier)[0] || TIERS[0];
      tierHint.textContent =
        "当前：" + one.label + (st.tier === "author" ? "（首次生成会派 Agent 写演示稿，消耗 Token）" : "（零 Token、同输入同输出）");
      netBtn.textContent = "联网补料：" + (st.online ? "开" : "关");
      netBtn.classList.toggle("is-on", !!st.online);
    }

    /* ── ② 版本 ─────────────────────────────────────────────────────────── */
    const secMode = el(D, "div", "rs-deck-init-sec");
    const headMode = el(D, "div", "rs-deck-init-sechead");
    headMode.appendChild(el(D, "span", "rs-deck-init-secn", "②"));
    headMode.appendChild(el(D, "span", "rs-deck-init-sectitle", "版本"));
    headMode.appendChild(el(D, "span", "rs-deck-init-sechint", "决定默认打开与导出哪一版"));
    secMode.appendChild(headMode);
    const modeRow = el(D, "div", "rs-deck-init-modes");
    const modeBtns = [];
    const modeHintEl = el(D, "div", "rs-deck-init-modehint");
    const modes = Array.isArray(C.BRIEF_MODES) && C.BRIEF_MODES.length ? C.BRIEF_MODES : ["slides", "video", "both"];
    for (const id of modes) {
      const b = el(D, "button", "rs-deck-init-mode");
      b.type = "button";
      b.dataset.val = id;
      b.appendChild(el(D, "b", null, MODE_LABEL[id] || (C.BRIEF_MODE_LABEL && C.BRIEF_MODE_LABEL[id]) || id));
      b.appendChild(el(D, "span", "rs-deck-init-mode-h", MODE_HINT[id] || ""));
      b.addEventListener("click", () => {
        st.brief.mode = id;
        paintModes();
        applyVars();
        paintFoot();
      });
      modeBtns.push(b);
      modeRow.appendChild(b);
    }
    secMode.appendChild(modeRow);
    secMode.appendChild(modeHintEl);
    body.appendChild(secMode);
    function paintModes() {
      for (const b of modeBtns) b.classList.toggle("is-on", b.dataset.val === st.brief.mode);
      modeHintEl.textContent =
        "当前：" + (MODE_LABEL[st.brief.mode] || st.brief.mode) + " · 页模型与 brief 两版共用同一份，改版本不会重排内容";
    }

    /* ── ③ 风格：6 套 × 明 / 暗（纸色 / 主色 / 字体缩略预览，选中即写 theme） ── */
    const secStyle = el(D, "div", "rs-deck-init-sec");
    const headStyle = el(D, "div", "rs-deck-init-sechead");
    headStyle.appendChild(el(D, "span", "rs-deck-init-secn", "③"));
    headStyle.appendChild(el(D, "span", "rs-deck-init-sectitle", "风格"));
    headStyle.appendChild(el(D, "span", "rs-deck-init-sechint", "纸色 / 主色 / 字体就按缩略图这套来，与视频版同源"));
    secStyle.appendChild(headStyle);
    const grid = el(D, "div", "rs-deck-init-grid");
    const styleBtns = [];
    const presets = Array.isArray(C.THEME_PRESETS) && C.THEME_PRESETS.length ? C.THEME_PRESETS : [];
    const styled = Array.isArray(C.MODES) && C.MODES.length ? C.MODES : MODE_FALLBACK;
    for (const m of styled) {
      for (const p of presets) {
        const tok = tokensOf(C, st.brief, { preset: p.id, mode: m });
        const vars = tok.css || {};
        const th = tok.theme || C.normalizeTheme({ preset: p.id, mode: m });
        const card = el(D, "button", "rs-deck-init-card");
        card.type = "button";
        card.dataset.preset = p.id;
        card.dataset.mode = m;
        card.title = (p.desc || p.label || p.id) + " · " + (MODE_CN[m] || m);
        const thumb = el(D, "span", "rs-deck-init-thumb");
        if (vars["--rs-slide-paper"]) thumb.style.background = vars["--rs-slide-paper"];
        if (vars["--rs-slide-ink"]) thumb.style.color = vars["--rs-slide-ink"];
        if (vars["--rs-slide-rule"]) thumb.style.borderColor = vars["--rs-slide-rule"];
        const aa = el(D, "i", "rs-deck-init-aa", "Aa");
        aa.style.fontFamily = vars["--rs-slide-font"] || tok.font || "";
        if (vars["--rs-slide-primary"]) aa.style.color = vars["--rs-slide-primary"];
        thumb.appendChild(aa);
        const bar = el(D, "i", "rs-deck-init-bar");
        if (vars["--rs-slide-primary"]) bar.style.background = vars["--rs-slide-primary"];
        const bar2 = el(D, "i", "rs-deck-init-bar is-accent");
        if (vars["--rs-slide-accent"]) bar2.style.background = vars["--rs-slide-accent"];
        thumb.appendChild(bar);
        thumb.appendChild(bar2);
        card.appendChild(thumb);
        card.appendChild(el(D, "span", "rs-deck-init-t", (p.label || p.id) + " · " + (MODE_CN[m] || m)));
        card.appendChild(el(D, "span", "rs-deck-init-f", fontLabelOf(C, th.font)));
        card.addEventListener("click", () => {
          st.theme.preset = str(p.id);
          st.theme.mode = m;
          paintStyles();
          applyVars();
          paintFoot();
        });
        styleBtns.push(card);
        grid.appendChild(card);
      }
    }
    secStyle.appendChild(grid);
    if (!presets.length) secStyle.appendChild(el(D, "div", "rs-deck-init-sechint", "内核没给出预设表（research-slides.js 未加载）"));
    body.appendChild(secStyle);
    function paintStyles() {
      for (const b of styleBtns) {
        b.classList.toggle("is-on", b.dataset.preset === st.theme.preset && b.dataset.mode === st.theme.mode);
      }
    }

    /* ── ④ 额外指示 ─────────────────────────────────────────────────────── */
    const secExtra = el(D, "div", "rs-deck-init-sec");
    const headExtra = el(D, "div", "rs-deck-init-sechead");
    headExtra.appendChild(el(D, "span", "rs-deck-init-secn", "④"));
    headExtra.appendChild(el(D, "span", "rs-deck-init-sectitle", "额外指示"));
    headExtra.appendChild(el(D, "span", "rs-deck-init-sechint", "叙事、内容取舍与节奏都按这里来；缺的可以联网补"));
    secExtra.appendChild(headExtra);
    const rows = el(D, "div", "rs-deck-init-rows");

    function row(label, hint) {
      const r = el(D, "div", "rs-deck-init-row");
      const lab = el(D, "span", "rs-deck-init-label", label);
      if (hint) lab.title = hint;
      r.appendChild(lab);
      const fields = el(D, "div", "rs-deck-init-fields");
      r.appendChild(fields);
      rows.appendChild(r);
      return { row: r, fields: fields };
    }
    /* 一排快捷 chips：labelOf 只改显示（值仍是原始那一项，别拿 textContent 反推） */
    function chipsBar(list, isOn, onClick, labelOf) {
      const bar = el(D, "div", "rs-deck-init-chips");
      const all = [];
      function paint() {
        list.forEach((c, i) => all[i].classList.toggle("is-on", !!isOn(c)));
      }
      list.forEach((c) => {
        const b = el(D, "button", "rs-deck-init-chip", labelOf ? labelOf(c) : str(c));
        b.type = "button";
        b.dataset.val = str(c);
        b.addEventListener("click", () => {
          onClick(c);
          paint();
        });
        all.push(b);
        bar.appendChild(b);
      });
      return { bar: bar, paint: paint };
    }

    /* 受众 / 场合：一句话，点 chip 填进去，再点一次清空 */
    function textField(label, key, chipList, placeholder) {
      const { fields } = row(label);
      const inp = el(D, "input", "rs-deck-init-input");
      inp.type = "text";
      inp.value = str(st.brief[key]);
      inp.placeholder = placeholder;
      inp.addEventListener("input", () => {
        st.brief[key] = inp.value;
        paint();
      });
      fields.appendChild(inp);
      const bar = chipsBar(chipList, (txt) => str(inp.value).trim() === str(txt), (c) => {
        inp.value = str(inp.value).trim() === str(c) ? "" : str(c);
        st.brief[key] = inp.value;
      });
      const paint = bar.paint;
      fields.appendChild(bar.bar);
      paint();
      return inp;
    }

    /* 重点 / 忌口：多值（内核 focus / avoid 各 ≤ 12 条），逗号 / 顿号分隔；chip 是增删 */
    function listField(label, key, chipList, placeholder) {
      const { fields } = row(label);
      const inp = el(D, "input", "rs-deck-init-input");
      inp.type = "text";
      inp.value = (Array.isArray(st.brief[key]) ? st.brief[key] : []).join("、");
      inp.placeholder = placeholder;
      const read = () => {
        st.brief[key] = splitList(inp.value);
        paint();
      };
      inp.addEventListener("input", read);
      fields.appendChild(inp);
      const bar = chipsBar(chipList, (txt) => (Array.isArray(st.brief[key]) ? st.brief[key] : []).indexOf(str(txt)) >= 0, (c) => {
        const list = (Array.isArray(st.brief[key]) ? st.brief[key] : []).slice();
        const i = list.indexOf(str(c));
        if (i >= 0) list.splice(i, 1);
        else list.push(str(c));
        st.brief[key] = list;
        inp.value = list.join("、");
        paintFoot();
      });
      const paint = bar.paint;
      fields.appendChild(bar.bar);
      paint();
      return inp;
    }

    /* 时长：按分钟填，0 / 留空 = 自动（内核 brief.durationSec，秒） */
    const durRow = row("时长", "目标总时长；留空 = 自动（按页数与字速算）");
    const durIn = el(D, "input", "rs-deck-init-input rs-deck-init-num");
    durIn.type = "number";
    durIn.min = "0";
    durIn.max = String(Math.max(1, Math.round((Number(C.BRIEF_MAX_SEC) || 3600) / 60)));
    durIn.step = "1";
    durIn.value = st.brief.durationSec > 0 ? String(Math.round(st.brief.durationSec / 60)) : "";
    durIn.placeholder = "自动";
    const durOf = () => {
      const n = Math.round(Number(durIn.value));
      return Number.isFinite(n) && n > 0 ? n : 0;
    };
    durIn.addEventListener("input", () => {
      st.brief.durationSec = durOf() * 60;
      paintDur();
    });
    durRow.fields.appendChild(durIn);
    const durBar = chipsBar(
      CHIPS.duration,
      (m) => durOf() === Number(m),
      (m) => {
        durIn.value = durOf() === Number(m) ? "" : str(m);
        st.brief.durationSec = durOf() * 60;
        paintFoot();
      },
      (m) => m + " 分钟",
    );
    durRow.fields.appendChild(durBar.bar);
    const durHint = el(D, "span", "rs-deck-init-fhint", "留空 / 0 = 自动；超时长会砍文献 → 公式 → 术语页，正文一页不砍");
    durRow.fields.appendChild(durHint);
    function paintDur() {
      durBar.paint();
      durHint.textContent =
        st.brief.durationSec > 0
          ? "目标 " + Math.round(st.brief.durationSec / 60) + " 分钟（" + st.brief.durationSec + " 秒）；超时长按 文献 → 公式 → 术语 压缩，正文一页不砍"
          : "留空 / 0 = 自动（按页数与字速算）；有目标时长时超出的部分按 文献 → 公式 → 术语 压缩，正文一页不砍";
    }

    textField("受众", "audience", CHIPS.audience, "讲给谁听（组会 / 评审 / 课堂 / 客户…）");
    textField("场合", "occasion", CHIPS.occasion, "什么场合讲多久（周会 / 答辩 / 路演…）");
    listField("重点", "focus", CHIPS.focus, "要突出什么（关键词或章节名，逗号分隔）");
    listField("忌口", "avoid", CHIPS.avoid, "不要出现的说法 / 不要展开的章节（逗号分隔）");

    /* 自由文本：与上面同级，最高优先级（内核 brief.extra） */
    const extraRow = row("自由指示");
    const extraIn = el(D, "textarea", "rs-deck-init-extra");
    extraIn.rows = 4;
    extraIn.value = str(st.brief.extra);
    extraIn.placeholder = "按人话写：先讲结论再讲方法、别用「赋能」这类词、最后一页留 1 分钟给提问…";
    extraIn.addEventListener("input", () => {
      st.brief.extra = extraIn.value;
    });
    extraRow.fields.appendChild(extraIn);
    secExtra.appendChild(rows);

    /* 边界那句（随做法变）：这一版的分工是「以用户指示为准，现有资料只作参考」 */
    const notice = el(D, "div", "rs-deck-init-note");
    notice.appendChild(el(D, "span", "rs-deck-init-note-i", "！"));
    const noticeText = el(D, "div", "rs-deck-init-note-t");
    const noticeB = el(D, "b", null, "");
    const noticeS = el(D, "span", null, "");
    noticeText.appendChild(noticeB);
    noticeText.appendChild(noticeS);
    notice.appendChild(noticeText);
    secExtra.appendChild(notice);
    function paintNotice() {
      if (st.tier === "author") {
        noticeB.textContent = "按你的指示做演示：研究里的稿子只是素材，不是必须照念的原文。";
        noticeS.textContent = st.online
          ? "需要解释原文术语 / 公式而本地资料不够时，可以联网找公开来源；新增内容一律写成研究笔记（notes/<slug>.explain.md 等）并注明出处，演示页引用它。"
          : "只用本地资料：不联网、不引入外部来源；需要解释的地方从现有笔记里取，取不到就留白，不编。";
      } else {
        noticeB.textContent = "照原文直出：不重写叙事，页按核心原文与 3-Pass 变体确定性切出来。";
        noticeS.textContent = st.online
          ? "勾了联网补料就只补「解释性笔记」（不改原文、不改页序），演示里以引用形式出现。"
          : "零 Token、同输入同输出；要按指示重写请把做法切到「按指示创作」。";
      }
    }
    body.appendChild(secExtra);

    /* ── 底部动作 ───────────────────────────────────────────────────────── */
    const footHint = el(D, "div", "rs-deck-init-hint");
    const errEl = el(D, "div", "rs-deck-init-err");
    const btnCancel = el(D, "button", "rs-deck-init-btn", "取消");
    const btnOk = el(D, "button", "rs-deck-init-btn primary", st.reason === "settings" ? "保存并重排" : "确认，打开编辑器");
    btnCancel.type = btnOk.type = "button";
    btnOk.disabled = !st.onSubmit;
    btnCancel.addEventListener("click", () => close());
    btnOk.addEventListener("click", () => submit());
    foot.appendChild(footHint);
    foot.appendChild(errEl);
    foot.appendChild(btnCancel);
    foot.appendChild(btnOk);

    function payload() {
      const brief = C.normalizeBrief(st.brief);
      brief.updatedAt = Date.now();
      return {
        brief: brief,
        theme: { preset: st.theme.preset, mode: st.theme.mode },
        mode: brief.mode,
        /* 做法与联网补料：与 brief 同级（宿主写进 slides/<slug>.json 顶层，不进 deck.brief） */
        tier: st.tier === "direct" ? "direct" : "author",
        online: !!st.online,
      };
    }
    function presetLabel(id) {
      for (const p of presets) if (p.id === str(id)) return str(p.label || p.id);
      return str(id);
    }
    function paintFoot() {
      const b = C.normalizeBrief(st.brief);
      const bits = [];
      bits.push("做法：" + (st.tier === "author" ? "按指示创作" : "照原文直出"));
      bits.push("版本：" + (MODE_LABEL[b.mode] || b.mode));
      bits.push("风格：" + presetLabel(st.theme.preset) + " · " + (MODE_CN[st.theme.mode] || st.theme.mode));
      if (st.online) bits.push("联网补料：开");
      if (b.durationSec > 0) bits.push("时长：" + Math.round(b.durationSec / 60) + " 分钟");
      if (b.focus.length) bits.push("重点 " + b.focus.length + " 条");
      if (b.avoid.length) bits.push("忌口 " + b.avoid.length + " 条");
      footHint.textContent =
        bits.join(" · ") + (st.hint ? " · 写进 " + st.hint : "") + (st.reason === "settings" ? "（手改保留）" : "");
      paintNotice();
    }
    function setBusy(on) {
      st.busy = !!on;
      btnOk.disabled = !!on || !st.onSubmit;
      btnCancel.disabled = !!on;
      btnOk.textContent = on ? "正在保存…" : st.reason === "settings" ? "保存并重排" : "确认，打开编辑器";
    }
    async function submit() {
      if (st.busy || !st.onSubmit) return null;
      const info = payload();
      setStatus("");
      setBusy(true);
      let res = null;
      try {
        res = await Promise.resolve(st.onSubmit(info));
      } catch (e) {
        setBusy(false);
        setStatus("没写进去：" + str((e && e.message) || e));
        return null;
      }
      setBusy(false);
      if (res === false || (res && res.ok === false)) {
        setStatus(str((res && res.error) || "没写进去（宿主没回执）"));
        return null;
      }
      close();
      return info;
    }

    /* 关闭：只走 ✕ / 取消 / Esc（幕布不接点击） */
    function onKey(ev) {
      if (ev.key !== "Escape" || !OPEN || OPEN.el !== win) return;
      /* 编辑器也在 document 上抓 Esc：这里在 window 上先一步吃掉，免得把背后的编辑器一起关掉 */
      ev.preventDefault();
      ev.stopPropagation();
      close();
    }
    function close() {
      if (W) W.removeEventListener("keydown", onKey, true);
      if (curtain.parentNode) curtain.remove();
      if (OPEN && OPEN.el === win) OPEN = null;
      const fn = st.onClose;
      if (typeof fn === "function") {
        try {
          fn();
        } catch (e) {
          toastSafe(str((e && e.message) || e), "err");
        }
      }
    }
    function raise() {
      if (curtain.parentNode !== D.body) D.body.appendChild(curtain);
      curtain.style.display = "flex";
    }

    btnX.addEventListener("click", () => close());
    /* 输入时重算底部摘要（版本 / 风格 / 条数都会变） */
    const repaint = () => paintFoot();
    body.addEventListener("input", repaint);
    body.addEventListener("change", repaint);
    body.addEventListener("click", repaint);

    paintModes();
    paintStyles();
    paintTier();
    paintDur();
    paintFoot();
    applyVars();
    D.body.appendChild(curtain);
    if (W) W.addEventListener("keydown", onKey, true);

    const ctrl = {
      VER: VER,
      CSS_HINT: CSS_HINT,
      el: win,
      curtain: curtain,
      raise: raise,
      close: close,
      mode: () => str(st.brief.mode),
      brief: () => payload().brief,
      theme: () => ({ preset: st.theme.preset, mode: st.theme.mode }),
      state: st,
    };
    OPEN = ctrl;
    return ctrl;
  }

  function close() {
    if (OPEN) OPEN.close();
  }

  function isOpen() {
    return !!OPEN;
  }

  return {
    VER: VER,
    CSS_HINT: CSS_HINT,
    open: open,
    mount: open,
    close: close,
    isOpen: isOpen,
    state: () => (OPEN ? OPEN.state : null),
    _internal: { core: core, tokensOf: tokensOf },
  };
});
