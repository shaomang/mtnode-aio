"use strict";
/* ===== 输入框的 Markdown 预览档（renderer/app-mdpreview.js · 出口 window.MTMdPreview）=====
 *
 * 需求：文本节点板身正文框、文本处理节点（proc_text）提示词框里的 Markdown 能就地渲染出来看。
 * 口径（与用户逐条谈定，别自行放宽）：
 *   · **框内保持源码可编辑**，另给一颗框内右上角的小按钮手动在「源码 / 预览」两档间切；
 *     失焦不自动渲染、框内点击不切回（唯一出口就是那颗按钮）。
 *     **文本节点板身正文框那一颗已按用户要求移除**（absolute 按钮压住正文右上角挡字），
 *     所以现在只有 proc_text 提示词框还挂预览档；supported() 仍认 input_text 是给自验 /
 *     后续复用留的口子，但 buildBody 不再对它 attach。
 *   · 预览态只读（正文不可编），**框的宽高一律不变**（含手动拖过尺寸的节点）：
 *     预览层绝对铺满输入框，内容多了在框内滚动 —— 与输出区同款滚动容器。
 *   · 预览层上文字可选中 / 可复制；链接不可点（链接由全站 renderMarkdown 生成，
 *     与输出区同一口径）。
 *   · 空内容时预览态仍是空框 + 与编辑态完全相同的占位提示。
 *   · 每次切到预览都对当前正文重新渲染一遍（不缓存）。
 *   · 预览开关只是**界面态**：不写进节点、不进保存、不影响运行与下游。
 *
 * 渲染：走全站唯一入口 renderer/app.js 的 renderMarkdown（gfm + breaks，表格 / 公式一并渲染），
 *   样式复用输出区那套 .md，底色就地改成与输入框一致的 var(--code)（见 canvas.css 的 .n-md-prev）。
 *
 * @ 引用 / @标签 / 内嵌图像胶囊必须在预览态保住（用户明确要求）：
 *   它们的原文都是**普通 Markdown 文本**，直接交给 marked 会被当成强调符 / 自动链接吃掉
 *   （正文里的 `*` 会把跨行文本变成 <em>，`@img:xxx` 会被切成 `@img` 加残渣）。
 *   做法：渲染前把这三类片段换成**解析期不可能出现的占位符**（PUA 私用区包围 + 序号，与
 *   renderer/math-render.js 的公式占位符同一套思路），交给 renderMarkdown 解析，最后在
 *   解析结果里把占位符原样注回成高亮 span / 胶囊块 —— 于是 `**@文本节点 2**` 既保住粗体，
 *   又保住 @ 的青色高亮。
 *   占位符只落在「已渲染的 HTML」里做替换，用户输入从不被拼进 HTML，安全纪律不变
 *   （renderMarkdown 自身仍是先转义再解析）。
 *
 * 依赖（全部在调用期取，缺了就降级，不在加载期依赖）：
 *   renderMarkdown / refCandidates / refTagCandidates / atMentionsOf / findCandidateByTitle /
 *   tagByAtToken / promptCapsuleSupported / promptCapsuleMap / promptCapsuleTokens /
 *   PROMPT_CAP_SRC_LABELS / mediaFileUrlOf / fileName / I18n（app.js / app-canvas.js 同层脚本）。
 *
 * 接入点（调用方只加两行，判定与渲染全在本模块）：
 *   · 文本处理节点提示词框 —— renderer/app.js 的 mountPromptTextarea 末尾
 *   · 文本节点板身正文框 —— **已移除**（见上面那颗按钮的说明；app-canvas.js 的
 *     buildBody 不再 attach，也不再有 .n-md-wrap 定位宿主）
 */

(function () {
  /* 占位符：PUA 私用区包围 + 序号。marked 不会转义 / 不会自动链接化 / 不会吞掉它，
     用户正文里也敲不出（真敲了也会被 escapeHtml 挡在解析之前）。 */
  const PH_L = "\uE000";
  const PH_R = "\uE001";
  /* 两类占位：@ 引用（节点 / 标签）与内嵌图像胶囊 */
  const PH_AT_RE = new RegExp(PH_L + "(\\d+)" + PH_R, "g");
  const PH_CAP_RE = new RegExp(PH_L + "c(\\d+)" + PH_R, "g");

  /* ta → 本模块给这颗框登记的现场（WeakMap：框被重画即自动回收，不留悬挂引用） */
  const NODES = new WeakMap();
  /* 宿主 → 同一份现场。**节点被重画时（选中 / 改尺寸 / 运行 / 切画布都算）textarea、按钮、
     预览层会整批换成新元素**，旧现场里的三个引用当场作废（表现为「点编辑反而开预览」）。
     所以按钮与 API 一律先用宿主取现场，再把现场里的 ta 指向当前这颗 textarea。 */
  const HOSTS = new WeakMap();

  const T_PREVIEW = () => I18n.t("预览");
  const T_EDIT = () => I18n.t("编辑");
  const T_HINT = () => I18n.t("Markdown 预览 / 回到编辑");

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* 预览层里那颗只读胶囊（复用编辑态 .pc-pill 的内层观感：缩略图 + 文件名，不带 ✕）。
     类名另起 .n-md-pill —— 编辑态的 .pc-pill 是绝对定位盖在镜像层上的，不能就地复用。 */
  function pillHtml(entry) {
    if (!entry) return "";
    const url = typeof mediaFileUrlOf === "function" ? mediaFileUrlOf(entry.path) : "";
    const name = String(entry.name || (typeof fileName === "function" ? fileName(entry.path) : "") || "");
    const srcLabel =
      typeof PROMPT_CAP_SRC_LABELS !== "undefined" && PROMPT_CAP_SRC_LABELS[entry.src]
        ? I18n.t(PROMPT_CAP_SRC_LABELS[entry.src])
        : "";
    const title = [name, srcLabel].filter(Boolean).join(" · ");
    return (
      '<span class="n-md-pill"' +
      (title ? ' title="' + esc(title) + '"' : "") +
      ">" +
      (url ? '<img class="pc-thumb" alt="" src="' + esc(url) + '">' : "") +
      '<span class="pc-name">' +
      esc(name) +
      "</span></span>"
    );
  }

  /* @ 命中片段的高亮标签（注回阶段与占位阶段共用同一份写法，两处不会漂） */
  function mark(raw) {
    return '<span class="' + raw.cls + '">' + esc(raw.seg) + "</span>";
  }

  /* 正文 → 预览 HTML。返回 { html, mentions }（mentions 只用于调试 / 测试断言） */
  function previewHtml(node, text) {
    const s = String(text == null ? "" : text);
    if (!s.trim()) return { html: "", mentions: 0 };
    const mentions = [];

    /* ① 内嵌图像胶囊 token：注册表里认得出的才换占位（认不出的原样留着，语义与编辑态一致） */
    const caps = [];
    let work = s;
    if (
      typeof promptCapsuleSupported === "function" &&
      promptCapsuleSupported(node) &&
      typeof promptCapsuleMap === "function" &&
      typeof promptCapsuleTokens === "function"
    ) {
      const reg = promptCapsuleMap(node);
      if (reg.size) {
        const toks = promptCapsuleTokens(s);
        let out = "";
        let last = 0;
        for (const t of toks) {
          const e = reg.get(String(t.id));
          if (!e) continue;
          out += s.slice(last, t.start) + PH_L + "c" + caps.length + PH_R;
          caps.push(e);
          last = t.end;
        }
        out += s.slice(last);
        work = out;
      }
    }

    /* ② @ 节点引用 / @标签：切词与匹配规则和编辑态高亮同源（atMentionsOf + 同一套判定），
          所以「预览里高亮的」与「编辑态高亮的 / 运行期真会解析的」严格一致。 */
    let cands = [];
    let tags = new Set();
    let names = [];
    try {
      cands = typeof refCandidates === "function" ? refCandidates(node) || [] : [];
      tags =
        typeof refTagCandidates === "function" ? new Set(refTagCandidates(node) || []) : new Set();
      names = typeof atRefNamesFor === "function" ? atRefNamesFor(cands) : [];
    } catch (_) {
      cands = [];
      tags = new Set();
      names = [];
    }
    if (names.length && typeof atMentionsOf === "function") {
      const hits = atMentionsOf(work, names);
      if (hits.length) {
        let out = "";
        let last = 0;
        for (const h of hits) {
          const key = h.name || h.token;
          /* 判定与编辑态高亮同源：findCandidateByTitle / tagByAtToken 吃的是**去 @ 的键** */
          const tag = typeof tagByAtToken === "function" ? tagByAtToken(key) : "";
          const cls =
            typeof findCandidateByTitle === "function" && findCandidateByTitle(cands, key)
              ? "at-ref-node"
              : tag && tags.has(tag)
                ? "at-ref-tag"
                : "";
          if (!cls) continue; /* 不认识的 @ 原样保留，不上高亮（编辑态同口径） */
          const seg = work.slice(h.start, h.end);
          out += work.slice(last, h.start) + PH_L + mentions.length + PH_R;
          mentions.push({ seg, cls });
          last = h.end;
        }
        out += work.slice(last);
        work = out;
      }
    }

    /* ③ 交给全站唯一入口渲染（表格 / 公式一并渲染） */
    let html = "";
    try {
      html =
        typeof renderMarkdown === "function"
          ? String(renderMarkdown(work) || "")
          : "<pre>" + esc(work) + "</pre>";
    } catch (_) {
      html = "<pre>" + esc(work) + "</pre>";
    }

    /* ④ 占位符注回：只替换我们自己发出的那两类占位，其余 HTML 一律不碰 */
    html = html.replace(PH_AT_RE, (m, i) => {
      const it = mentions[Number(i)];
      return it ? mark(it) : m;
    });
    html = html.replace(PH_CAP_RE, (m, i) => {
      const e = caps[Number(i)];
      return e ? pillHtml(e) : m;
    });
    return { html, mentions: mentions.length };
  }

  /* 当前正文：预览永远读 textarea 的真值（框就是真源，不做第二份缓存） */
  function textOf(rec) {
    return String((rec && rec.ta && rec.ta.value) || "");
  }

  function render(rec) {
    if (!rec || !rec.preview) return;
    const src = textOf(rec);
    rec.preview.innerHTML = previewHtml(rec.node, src).html;
    rec.preview.scrollTop = 0;
    rec.lastSrc = src;
    rec.lastHtml = rec.preview.innerHTML;
  }

  function apply(rec) {
    if (!rec) return;
    const on = !!rec.on;
    rec.preview.classList.toggle("on", on);
    /* 预览态：源码只让位、不退出排版（position:absolute 的预览层正是铺在它这份尺寸上，
       display:none 会让包裹层塌成 0 高 —— 那正是「框高会变」这个坑）。 */
    rec.ta.classList.toggle("n-md-src-hidden", on);
    if (on) {
      render(rec);
      rec.ta.setAttribute("aria-hidden", "true");
      rec.btn.classList.add("on");
      rec.btn.textContent = T_EDIT();
    } else {
      rec.preview.innerHTML = "";
      rec.ta.removeAttribute("aria-hidden");
      rec.btn.classList.remove("on");
      rec.btn.textContent = T_PREVIEW();
    }
    rec.btn.title = T_HINT();
    rec.btn.setAttribute("aria-label", rec.btn.title);
    rec.btn.setAttribute("aria-pressed", on ? "true" : "false");
  }

  /* 按宿主找现场：节点重画后 textarea / 按钮 / 预览层都是新元素，宿主是同一颗
     （.n-prompt-wrap 由提示词框那边重建，重画即连同现场一起换掉）。
     找不到现场时退回按 textarea 找（attach 那一刻的调用路径）。 */
  function recOf(hostOrTa) {
    if (!hostOrTa) return null;
    const rec =
      hostOrTa.tagName === "TEXTAREA"
        ? NODES.get(hostOrTa) || HOSTS.get(hostOrTa.parentNode || {})
        : HOSTS.get(hostOrTa);
    if (!rec) return null;
    if (rec.host && rec.host.isConnected === false) return null; /* 节点被删 / 切了画布 */
    return rec;
  }

  /* 每次要动 DOM 之前先问一句：现场里的三个引用还是当前这一帧的元素吗？
     不是就按宿主重新认一遍（宿主自己也被换过 → 整份现场作废，返回 null）。
     认的时候**档位一律回到编辑态**：新按钮 new 出来就是「预览」文案，若续用旧的 on，
     用户点一下会「看着像预览、实际是关掉」—— 宁可让他再点一次，也不给错位的档位。 */
  function rehost(rec) {
    if (!rec) return null;
    if (rec.btn && rec.btn.isConnected === false) {
      const host = rec.host;
      if (!host || host.isConnected === false) return null;
      const btn = host.querySelector(".n-md-toggle");
      const prev = host.querySelector(".n-md-prev");
      const ta = host.querySelector("textarea");
      if (!btn || !prev || !ta) return null;
      rec.btn = btn;
      rec.preview = prev;
      rec.ta = ta;
      rec.on = false;
      rec.lastHtml = null; /* 换了层，缓存内容作废 */
      rec.lastSrc = null;
      apply(rec);
    }
    return rec;
  }

  /* 把当前档位摆正（框被重画 / 节点正文被上游改写后调用）。
     正文没变就只搬现场、不重画 —— 否则预览态里每次滚动 / 选中都会把预览层重画一遍，
     滚动位置当场被拉回顶部。 */
  function refresh(hostOrTa) {
    const rec = rehost(recOf(hostOrTa));
    if (!rec || !rec.on) return;
    if (rec.lastHtml != null && textOf(rec) === rec.lastSrc) return;
    render(rec);
  }

  /* 只读面（node.ro / 继承输入 / 批量条目）不需要预览档：那些框本身就是只读展示 */
  function supported(node) {
    if (!node) return false;
    return (
      node.kind === "input_text" || node.kind === "proc_text"
    );
  }

  /* 一次挂载：宿主上补预览层 + 右上角那颗开关，现场按宿主与 textarea 双向登记
     （宿主那份用于「节点重画后按宿主找回现场」，textarea 那份用于按框调 API）。 */
  function attach(ta, node, opts) {
    if (!ta || !node) return null;
    if (!supported(node)) return null;
    const host = ta.parentNode;
    if (!host) return null;
    /* 同一颗宿主上已经挂过（重复调用 / 重画后忘了清）→ 复用现场，不叠第二套 */
    const old = HOSTS.get(host);
    if (old && old.btn && old.btn.isConnected !== false && old.ta) {
      old.ta = ta;
      NODES.set(ta, old);
      const cur = rehost(old);
      if (cur) return cur;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "n-md-toggle";
    btn.textContent = T_PREVIEW();
    btn.title = T_HINT();
    btn.setAttribute("aria-label", btn.title);
    btn.setAttribute("aria-pressed", "false");
    const prev = document.createElement("div");
    prev.className = "n-md-prev md";
    prev.setAttribute("aria-hidden", "true");
    /* 空内容时的占位文案与编辑态同源：直接用这颗 textarea 自己的 placeholder，
       不在预览层里再抄一份（两处文案永远不会漂）。 */
    prev.setAttribute("data-ph", String(ta.placeholder || ""));
    /* 按钮与预览层都挂在**输入的宿主**上（不是 textarea 的父级 iframe 式包装）：
       预览层铺满宿主，于是「框高不变」天然成立 —— 它不参与排版，只覆盖。 */
    host.appendChild(prev);
    host.appendChild(btn);
    /* 现场登记的键名与两处读取严格同名：preview / btn / ta / node / host。
       改名时三处一起改 —— 少改一处就是「切换时抛异常、预览根本不出现」。 */
    const rec = { ta, node, host, btn, preview: prev, on: false };
    NODES.set(ta, rec);
    HOSTS.set(host, rec);
    btn.addEventListener("mousedown", (ev) => {
      /* 别让这一下落到节点上（画布会开始拖节点）或吃掉 textarea 的焦点语义 */
      ev.preventDefault();
      ev.stopPropagation();
    });
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const cur = recOf(host) || rec;
      cur.on = !cur.on;
      apply(cur);
    });
    /* 编辑态里正文变了（打字 / 上游改写 / 程序写入）→ 预览层若正开着就跟着重画一次 */
    ta.addEventListener("input", () => refresh(ta));
    return rec;
  }

  window.MTMdPreview = {
    attach: attach,
    refresh: refresh,
    toggle: function (ta, on) {
      const rec = rehost(recOf(ta));
      if (!rec) return;
      rec.on = on == null ? !rec.on : !!on;
      apply(rec);
    },
    isOn: function (ta) {
      const rec = recOf(ta);
      return !!(rec && rec.on);
    },
    /* 给冒烟 / 自验用：直接拿正文算预览 HTML，不碰 DOM */
    html: previewHtml,
  };
})();
