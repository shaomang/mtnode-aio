/* ============ 会话局部批注（renderer/app-annotate.js · 出口 window.SessionAnnotate）============

   用户口径（本次需求 · 已确认共识 + 第二轮修正）：
     · 界面：主窗口「会话」视图 + 智能助手栏（两处共用 dsh-msg 渲染，一套引擎）；
     · 对象：**只 AI 回复的正文**（含 Markdown 表格 / 代码块 / 图片 / LaTeX 公式块），
       用户消息不挂；
     · 入口：① 拖选文字 → 浮出「批注」小条；② 表格 / 代码块 / 图片 hover 时右上角出现「批注」键；
     · 内容：只有一个批注框（不分批注 / 质疑 / 展开），写什么都由用户定；
     · 选区：**正文只读** —— 批注时一个字符都不往正文里插（不包 span、不加 class），
       被批注的那段用**虚线框**在叠层里描出来（不填充，见 css 的 .sa-mark）；
       虚线框两端有 iOS 式手柄，字符级拖动增减（同一消息内可跨段；表格 / 代码块整块吸附）；
     · 生效后（本次需求 · 第三轮修正）：**不再有「加到这条消息」按钮** —— 批注框里写了字，
       它下一轮自动随消息发出（takeForSend 只看 body 非空）；发送栏胶囊照旧只在发送这一瞬
       把它们拼成正文块；**发出即消失（第四轮）**：那条批注连同卡片 / 虚线框 / 编号点一起
       从版面上删掉（purgeAnno），不留「已发出」的残条占位；
     · 拼块顺序（第四轮）：**批注块在前，用户输入在后** —— 模型先读「在说哪一段 + 意见」，
       再读用户这一轮的原话；
     · 卡片落点：**会话区左侧的空白**，收成一条可收纳的窄边栏（.sa-rail）——
       收起时只留 22px 窄条 + 每条批注的编号点（不显示内容），点一下展开成面板，
       面板里的批注卡可直接编辑 / 删除；展开时若左侧留白不够，给会话区补左侧内边距
       （applyRailPad），**绝不覆盖正文**（第三轮之前那套「贴正文右侧」会压住文字）；
     · 只进草稿、不自动发送；随会话落盘（重开 / 重启都在）。

   ── 实现要点（改之前先读）────────────────────────────────────────────────
   1) 卡片层是 **position:fixed 的整屏叠层**（#saLayer，挂在 body 末尾），不放进消息列表：
      .agent-list 是 overflow:auto 的滚动容器，任何挂进去的定位子节点都会跟着滚 / 被裁掉。
      叠层按 viewport 坐标定位，滚动 / 尺寸变化时重排（scroll 捕获 + resize + rAF）。
   2) **正文只读**：高亮不再包 span，而是每帧按锚点算 Range 的 client rects，在叠层里画
      虚线框（.sa-mark）—— 早先的实现用 range.extractContents() 把选区包成 <span>，
      重绘时再拆开 + parent.normalize()；流式每帧都在重绘，正文里就会不断冒出多余空格
      （用户报的「持续产生空格」）。**任何改动都不许再动消息正文的 DOM**。
   3) 锚点 = 消息行的稳定键（row.dataset.histKey，会话与助手栏同一份）+ 原文片段 +
      第几次出现（occ）；整块批注另用「块在该条消息里的序号」。重绘时先用上一帧的 Range
      （容器还在文档里、文字没变）省掉一次全文查找。
   4) 批注数据按会话 id 存在主进程 session-annos-store.js（不走会话正文，原因见那个文件头）。
   5) 胶囊条 = 这一条会话里 applied 的批注（applied 现在等价于「批注框里写了字」）；点胶囊
      定位正文那一段，✕ 删掉这条批注。发送时 takeForSend(st) 把它们拼成三行块
      （定位 / > 原文 / 批注：），**拼完即 purgeAnno 删掉**（第四轮：发出去就不该再占版面）。
   6) 卡片元件只按 id 找数据（不闭包住 anno 对象）：批注表整份换过（读回 / 切会话）之后，
      老闭包会写到已经不在表里的那个对象上。
   7) 左侧边栏（.sa-rail）挂在同一个叠层里：收起 = 窄条 + 编号点，展开 = 面板 + 批注卡。
      左侧留白不够时给会话区补 padding-left（applyRailPad，只改内联 padding-left，
      切走 / 删光时还原），所以面板永远落在正文左边的空白里，不压字。
   8) 当前这一条（选中正文那段 / 鼠标在它的卡片上 / 正在卡片里写字）= st.activeId：
      它的虚线框、连线、卡片左边框一律走金色呼吸灯细虚线（css 的 .on / .is-active 与
      叠层里的 svg.sa-glow；金色 = .sa-layer 上的 --sa-gold）。
   9) 复杂块（表格 / 代码块 / 引用 / 图片 / LaTeX 公式）：整块批注，锚点 = 原文片段优先、
      块序号兜底（BLOCK_SEL 里加进公式后，老数据的块序号会整体后移 —— 先按 quote 认）。
      公式的 quote 取 data-rv-tex 里的 TeX 原文，**不取 textContent**（KaTeX 把每个公式
      排了两份：可见的 .katex-html + 给读屏 / 复制用的 .katex-mathml，textContent 会重复）。
   10) **引文口径只有一份 = 可见文本**（visTextOf）：文字选区的 quote、四处字符偏移
      （rangeOfQuote / occOfRange / textOffsetOf / rangeFromOffsets）与拖选手柄都吃它 ——
      .katex-mathml 整棵子树跳过，.rv-math 换成一段 `$tex$` / `$$tex$$` 占位（与 blockQuote
      共用 mathTexOf）。早先文字选区取 range.toString()，同一句里夹行内公式时「> 原文」就成
      了两遍公式（批注 #ufiwdu）。老会话里已存成「两遍」的 quote，rangeOfQuote 会按旧的
      全拼接口径再找一次兜底，不会变成「锚点已变更」。 */

(function () {
  "use strict";
  const SA = (window.SessionAnnotate = window.SessionAnnotate || {});
  if (SA.__ready) return;
  SA.__ready = true;

  const T = (s, v) => (window.I18n && typeof I18n.t === "function" ? I18n.t(s, v) : s);
  const RAIL_W = 22; /* 收起：一条窄条（只有编号点，不显示批注内容） */
  const PANEL_W = 252; /* 展开：左侧面板宽（写批注 / 读批注都在这里） */
  const RAIL_GAP = 8; /* 边栏与正文列之间的空隙 */
  const SAVE_MS = 450;
  const MAX_QUOTE = 300; /* 写进正文的引用最多这么长（超出截断加省略号） */
  /* 可以整块批注的渲染块（复杂内容：表格 / 代码块 / 引用 / 图片 / LaTeX 公式）
     · img —— AI 正文里的 markdown 图（`![alt](url)`；用户那侧的内嵌图也走这条，但用户消息不挂批注）；
     · .rv-math / .katex-display —— renderer/math-render.js 的公式外壳（行内 `$…$` 与
       整段 `$$…$$` 都是它），嵌套时只认最外层那一颗（见 blockEls 的 outermost 过滤）。 */
  const BLOCK_SEL = "table, pre, blockquote, figure, img, .rv-math, .katex-display";

  const st = {
    sid: "",
    listEl: null,
    mode: "", /* session / assist */
    annos: [],
    cache: new Map(), /* sid -> {annos, loaded, promise} */
    layer: null,
    wires: null,
    glow: null, /* 当前这一条的金色呼吸灯虚线框（svg，压在 .sa-marks 之上） */
    cardsBox: null, /* = 左侧边栏的面板体（.sa-rail-body）：批注卡都挂在这里 */
    boxesBox: null,
    rail: null,
    railHead: null,
    railMarks: null,
    railOpen: false, /* 边栏展开 / 收起（缺省收起：只留窄条） */
    railPad: 0, /* 当前给会话区补的左侧内边距（0 = 用自然留白） */
    railPane: null,
    railBasePad: "", /* 会话区原本的内联 padding-left（还原用） */
    railBaseSize: 0, /* 会话区 CSS 的 padding-left（补 padding 时加在它上面） */
    cards: new Map(), /* annoId -> {el, ta, tag, quoteEl, who} */
    marks: new Map(), /* annoId -> {rects:[{left,top,right,bottom}], range, blockEl} */
    dead: new Set(), /* 这一帧锚点没对上（卡片照显示，打「锚点已变更」） */
    activeId: "",
    prefer: "", /* 用户最近动手的那一片（session / assist）：两处同时开着时按它画 */
    selBtn: null,
    hoverBtn: null,
    hoverBlk: null,
    drag: null,
    saveTimer: 0,
    raf: 0,
    lx: -1,
    ly: -1,
  };

  function api() {
    return window.api || null;
  }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function clamp(n, a, b) {
    return n < a ? a : n > b ? b : n;
  }
  function annoById(id) {
    for (const a of st.annos) if (a.id === id) return a;
    const b = st.sid ? st.cache.get(st.sid) : null;
    if (b) for (const a of b.annos) if (a.id === id) return a;
    return null;
  }

  /* ── 数据层：按会话缓存 + 防抖落盘 ─────────────────────────────────────── */
  function norm(a) {
    const o = a && typeof a === "object" ? a : {};
    const body = String(o.body || "");
    const used = !!o.used;
    return {
      id: String(o.id || ""),
      msgKey: String(o.msgKey || ""),
      aiIdx: Number.isFinite(Number(o.aiIdx)) ? Number(o.aiIdx) : -1,
      quote: String(o.quote || ""),
      occ: Math.max(0, Number(o.occ) || 0),
      body: body,
      scope: o.scope === "block" ? "block" : "text",
      blockIdx: Number.isFinite(Number(o.blockIdx)) ? Number(o.blockIdx) : -1,
      at: Number(o.at) || Date.now(),
      /* 「有字就算随消息发出」（用户口径 · 第三轮）：applied 不再靠一枚按钮置位，
         所以读回时按 body 补一次 —— 老数据里写了字却没点过「加到这条消息」的那条
         也按新口径处理；已经发出过的（used）不算 pending。 */
      applied: !!o.applied || (!!body.trim() && !used),
      used: used,
      usedAt: Number(o.usedAt) || 0,
    };
  }
  function bucket(sid) {
    const key = String(sid || "");
    let b = st.cache.get(key);
    if (!b) {
      b = { annos: [], loaded: false, promise: null };
      st.cache.set(key, b);
    }
    return b;
  }
  function loadAnnos(sid) {
    const b = bucket(sid);
    if (b.loaded) return Promise.resolve(b.annos);
    if (b.promise) return b.promise;
    const A = api();
    if (!A || typeof A.sessionAnnosLoad !== "function") {
      b.loaded = true;
      return Promise.resolve(b.annos);
    }
    b.promise = Promise.resolve(A.sessionAnnosLoad(sid))
      .then((r) => {
        let dropped = 0;
        if (r && r.ok && Array.isArray(r.annos))
          b.annos = r
            .annos.map(norm)
            .filter((x) => {
              /* 第四轮口径「发出即消失」：更早的版本把发过的留在表里标 used，
                 读回来时直接丢掉，不再让它占着左侧边栏（丢过就顺手回写一次盘）。 */
              if (!x.id) return false;
              if (x.used) {
                dropped++;
                return false;
              }
              return true;
            });
        b.loaded = true;
        b.promise = null;
        if (dropped) saveSoon(sid);
        if (st.sid === String(sid)) {
          st.annos = b.annos;
          schedule();
        }
        return b.annos;
      })
      .catch(() => {
        b.loaded = true;
        b.promise = null;
        return b.annos;
      });
    return b.promise;
  }
  function saveSoon(sid) {
    const key = String(sid || "");
    if (st.saveTimer) clearTimeout(st.saveTimer);
    st.saveTimer = setTimeout(() => {
      st.saveTimer = 0;
      const A = api();
      if (!A || typeof A.sessionAnnosSave !== "function" || !key) return;
      const b = bucket(key);
      Promise.resolve(A.sessionAnnosSave({ id: key, annos: b.annos.map(norm) })).catch(() => {});
    }, SAVE_MS);
  }

  /* ── 引用登记：批注正文里的图（并进 app-assist.js 的无引用回收判据）────────────
     批注卡里可以插图（「插图」键 → 正文里一行 ![](C:\…\paste-xxx.png)），落盘复用输入框
     那条路（app-assist.js 的 chatImgWriteBase64：<工作区>/.mtnode-input/，没有工作目录时
     退数据目录 chat-input，命名 paste-<时间戳36进制>.<ext>）—— 也就是说批注图与输入框的
     图同目录、同命名，本来就落在「可回收候选」那一类里。而回收判据（chatImgGc 的
     orphanImages）只看「现存的每一处引用」：会话消息 / 草稿 / 画布节点 / 输入框正文。
     批注正文不在这几处里，于是「只有批注在用」的那张图会被判成无人引用而删盘 ——
     这一节就是把它登记出去（收集口径不另写一套：走 MTInlineImg.imgRefsIn）：

       · imgRefs()      全部会话批注正文里的图（引用侧：app-assist.js 的 chatImgRefs 并入）；
       · imgRefs(sid)   某一会话的批注正文（候选侧：删会话时 chatImgSessionCandidates 并入
                        它 —— 那条会话一删，这些图就失去这一处引用，别处还引用就保留）；
       · imgRefsReady() 批注表按会话懒加载（loadAnnos），**没打开过的会话在内存里还是空表**，
                        盘上那份却可能引着图。所以第一次要引用时发起一轮预取（每会话一次
                        sessionAnnos:load，只发起一次），它兑现之后 imgRefs() 才是全集；
                        没兑现之前调用方应当这一轮不删（宁可留一张孤儿图，也绝不误删别人
                        还在引用的图）。

     删除批注 / 删掉卡片里的一行图，这里都**不**触发回收（不调 chatImgGcSoon）：那一瞬
     正是判据最可能没查全的时候，而「批注里删掉一行图」并不等于那张图没人用（消息正文 /
     别的批注 / 画布节点都可能还引用着）。孤儿统一交给工作目录清理面板（用户看得见清单
     再清），本模块一次都不主动删图。 */
  let _annosRefsPrefetch = null;
  function annoBodiesOf(list) {
    const out = [];
    for (const a of list || []) if (a && a.body) out.push(String(a.body));
    return out;
  }
  /* 一轮预取：把「盘上可能有批注、内存里还没读过」的会话各读一遍（只发起一次） */
  function annosRefsPrefetch() {
    const A = api();
    if (!A || typeof A.sessionAnnosLoad !== "function") return Promise.resolve(true);
    const ids = [];
    try {
      const list =
        (typeof agentSessions === "function" ? agentSessions() : null) ||
        (typeof S !== "undefined" && S && S.agentSessions) ||
        [];
      for (const s of list) if (s && s.id) ids.push(String(s.id));
    } catch (_) {}
    if (st.sid && ids.indexOf(st.sid) < 0) ids.push(st.sid);
    const jobs = [];
    for (const sid of ids) {
      const b = st.cache.get(sid);
      if (b && b.loaded) continue;
      jobs.push(Promise.resolve(loadAnnos(sid)).catch(() => []));
    }
    return jobs.length ? Promise.all(jobs).then(() => true, () => true) : Promise.resolve(true);
  }
  function imgRefsReady() {
    if (!_annosRefsPrefetch) _annosRefsPrefetch = annosRefsPrefetch();
    return _annosRefsPrefetch;
  }
  /* 批注正文里的图引用；sid 省略 = 全部会话（已读进内存的那一份，见 imgRefsReady） */
  function annosImgRefs(sid) {
    /* 顺手把预取发起来（不阻塞本次调用）：下一次要判据时手上这份才是接近全集的 */
    if (!_annosRefsPrefetch) imgRefsReady();
    const m = imgMod();
    if (!m || typeof m.imgRefsIn !== "function") return [];
    const key = sid == null ? "" : String(sid || "");
    const lists = [];
    if (key) lists.push(st.cache.get(key) || null);
    else for (const b of st.cache.values()) lists.push(b);
    const out = [];
    for (const b of lists) {
      const bodies = annoBodiesOf(b && b.annos);
      if (!bodies.length) continue;
      const refs = m.imgRefsIn(bodies);
      if (refs && refs.length) out.push(...refs);
    }
    return out;
  }

  /* ── 当前该画哪一片：会话视图优先，其次智能助手栏（两处可能同时显示同一条会话） ── */
  function shown(node) {
    if (!node || !node.isConnected) return false;
    const r = node.getBoundingClientRect();
    return r.width > 60 && r.height > 40;
  }
  function visibleHost() {
    /* 用户刚在哪一片里动的手（拖选 / hover）就画哪一片：会话视图与智能助手栏可能同时开着，
       两处都渲染同一条会话。没有偏好时按「会话视图优先」的默认顺序。 */
    if (st.prefer) {
      const pref = hostOfMode(st.prefer);
      if (pref) return pref;
      st.prefer = "";
    }
    const list = document.getElementById("agentList");
    /* 只看列表自己有没有尺寸：会话视图被托管到开发页时 #agentPane 是隐藏的，
       但 #agentList 连壳一起搬过去仍然可见 —— 那一处照样要能批注。 */
    if (list && shown(list)) return { list: list, mode: "session" };
    const al = document.getElementById("assistList");
    if (al && shown(al)) return { list: al, mode: "assist" };
    return null;
  }
  function hostOfMode(mode) {
    if (mode === "assist") {
      const al = document.getElementById("assistList");
      return al && shown(al) ? { list: al, mode: "assist" } : null;
    }
    if (mode === "session") {
      const list = document.getElementById("agentList");
      return list && shown(list) ? { list: list, mode: "session" } : null;
    }
    return "";
  }
  function modeOfNode(node) {
    if (!node || !node.closest) return "";
    if (node.closest("#assistList")) return "assist";
    if (node.closest("#agentList")) return "session";
    return "";
  }
  function sessionOfHost(mode) {
    try {
      if (mode === "session" && typeof agentSessionState === "function") return agentSessionState();
      if (mode === "assist" && typeof assistBoundSession === "function") return assistBoundSession();
    } catch (_) {}
    return null;
  }

  /* 绘制入口（会话 / 助手栏每次重绘后由 app-assist.js 调；幂等，自己合并帧） */
  function sync() {
    const host = visibleHost();
    if (!host) {
      st.sid = "";
      st.listEl = null;
      st.mode = "";
      hideLayer();
      return;
    }
    const session = sessionOfHost(host.mode);
    const sid = session && session.id ? String(session.id) : "";
    st.listEl = host.list;
    st.mode = host.mode;
    st.sid = sid;
    if (!sid) {
      st.annos = [];
      hideLayer();
      return;
    }
    const b = bucket(sid);
    if (!b.loaded) loadAnnos(sid);
    st.annos = b.annos;
    schedule();
  }

  function schedule() {
    if (st.raf) return;
    const raf = window.requestAnimationFrame || ((fn) => setTimeout(fn, 16));
    st.raf = raf(() => {
      st.raf = 0;
      try {
        paint(false);
      } catch (e) {
        try {
          console.error("批注绘制失败", e);
        } catch (_) {}
      }
    });
  }

  /* 只有位置变了（滚动 / 缩放）：锚点能复用上一帧的 Range，只重算 rects 与卡片位置 */
  let _layoutRaf = 0;
  function scheduleLayout() {
    if (_layoutRaf) return;
    const raf = window.requestAnimationFrame || ((fn) => setTimeout(fn, 16));
    _layoutRaf = raf(() => {
      _layoutRaf = 0;
      try {
        paint(true);
      } catch (_) {}
    });
  }

  /* ── 锚点：Range / 整块，一律只读 ─────────────────────────────────────── */
  /* ── 可见文本口径（quote / 偏移 / Range 四处共用这一份序列）：
     KaTeX 给每个公式排两份：可见的 .katex-html，与给读屏 / 复制用的 .katex-mathml
     （后者的 <annotation> 里还留着整段原始 TeX）。range.toString() 与 textContent 会把
     两份都读出来 —— 一条批注的「> 原文」就成了两遍公式（批注 #ufiwdu 就是这个）。
     可见文本按下面三条拼：
       · 普通文本节点：原样；
       · .rv-math（带 data-rv-tex）：只留一段 `$tex$` / `$$tex$$` 占位（与 blockQuote 同一口径，
         都由 mathTexOf 产出），整棵子树 —— .katex-html 的排版碎片与 .katex-mathml 的副本 —— 跳过；
       · .katex-mathml：整棵子树跳过（兜底：没套 .rv-math 的裸 KaTeX）。
     段里仍指回真实文本节点 / 公式元素，所以「偏移 → Range」还落得回 DOM。 */
  const MATH_SKIP_SEL = ".katex-mathml";
  /* 一颗公式块的「原文」= TeX 原文 + 定界符（行内 $…$ / 整段 $$…$$）。
     块批注（blockQuote）与可见文本（visTextOf）共用这一份，两处口径不会再分叉。 */
  function mathTexOf(el) {
    if (!el || !el.getAttribute) return "";
    const tex = String(el.getAttribute("data-rv-tex") || "").trim();
    if (!tex) return "";
    const disp =
      el.getAttribute("data-rv-display") === "1" ||
      /(^|\s)rv-math-display(\s|$)/.test(String(el.className || ""));
    const d = disp ? "$$" : "$";
    return d + tex + d;
  }
  function visTextOf(root) {
    const out = { full: "", segs: [], byNode: new Map(), byEl: new Map() };
    const addText = (node) => {
      const s = String(node.nodeValue || "");
      if (!s) return;
      const seg = { from: out.full.length, to: out.full.length + s.length, node: node, el: null };
      out.segs.push(seg);
      out.byNode.set(node, seg);
      out.full += s;
    };
    const addGhost = (box, text) => {
      const seg = { from: out.full.length, to: out.full.length + text.length, node: null, el: box };
      out.segs.push(seg);
      out.byEl.set(box, seg);
      out.full += text;
    };
    const walk = (node) => {
      if (!node) return;
      if (node.nodeType === 3) return addText(node);
      if (node.nodeType !== 1) return;
      if (node.matches && node.matches(MATH_SKIP_SEL)) return;
      const tex = mathTexOf(node);
      if (tex) return addGhost(node, tex);
      for (let c = node.firstChild; c; c = c.nextSibling) walk(c);
    };
    if (root) for (let c = root.firstChild; c; c = c.nextSibling) walk(c);
    return out;
  }
  /* 老口径（兼容用）：所有文本节点原样拼起来，含 .katex-mathml 那份副本 ——
     老会话里存下来的 quote 就是「公式读两遍」的样子，按它兜底再找一次。 */
  function legacyTextOf(root) {
    const out = { full: "", segs: [], byNode: null, byEl: null };
    const walk = (node) => {
      if (!node) return;
      if (node.nodeType === 3) {
        const s = String(node.nodeValue || "");
        if (!s) return;
        out.segs.push({ from: out.full.length, to: out.full.length + s.length, node: node, el: null });
        out.full += s;
        return;
      }
      if (node.nodeType !== 1) return;
      for (let c = node.firstChild; c; c = c.nextSibling) walk(c);
    };
    if (root) for (let c = root.firstChild; c; c = c.nextSibling) walk(c);
    return out;
  }
  /* 偏移 → Range 边界：落在文本段里取该节点 + 段内偏移；落在公式占位段里取公式元素本身
     （起边取元素头、终边取元素尾，整个公式一起进选区）。 */
  function segAt(segs, off, isEnd) {
    for (const sp of segs) {
      if (off >= sp.from && off < sp.to) {
        if (sp.node) return { node: sp.node, off: off - sp.from };
        return { node: sp.el, off: isEnd ? sp.el.childNodes.length : 0 };
      }
      if (isEnd && off === sp.to && off > sp.from) {
        if (sp.node) return { node: sp.node, off: sp.to - sp.from };
        return { node: sp.el, off: sp.el.childNodes.length };
      }
    }
    const last = segs[segs.length - 1];
    if (!last) return null;
    if (last.node) return { node: last.node, off: String(last.node.nodeValue || "").length };
    return { node: last.el, off: last.el.childNodes.length };
  }
  /* (node, off) 在可见文本里的字符偏移：文本节点精确；公式里的排版碎片（.katex-html 里
     上下标 / 分式那几段）折到公式那一段的首 / 尾（side:"s" 取首、side:"e" 取尾）。 */
  function visOffset(v, node, off, side) {
    if (!node) return -1;
    const end = side === "e";
    const n = Number(off) || 0;
    if (node.nodeType === 3) {
      const seg = v.byNode ? v.byNode.get(node) : null;
      if (seg) return seg.from + Math.max(0, Math.min(n, seg.to - seg.from));
      const ghost = ghostSegOf(v, node);
      return ghost ? (end ? ghost.to : ghost.from) : -1;
    }
    if (node.nodeType !== 1) return -1;
    const seg = v.byEl ? v.byEl.get(node) : null;
    if (seg) return n >= (node.childNodes ? node.childNodes.length : 0) ? seg.to : seg.from;
    return visNearSeg(v, node, n, end);
  }
  function ghostSegOf(v, node) {
    let up = node && node.parentElement;
    while (up) {
      const seg = v.byEl ? v.byEl.get(up) : null;
      if (seg) return seg;
      up = up.parentElement;
    }
    return null;
  }
  /* 元素边界（三击选中整段 / 跨块拖选时端点是容器节点）→ 折成段表里的偏移：
     起点取该边界之后的第一段，终点取之前最后一段。 */
  function visNearSeg(v, el, off, end) {
    const kids = el.childNodes || [];
    const n = Math.max(0, Math.min(off, kids.length));
    const pivot = n < kids.length ? kids[n] : null;
    let before = null;
    let after = null;
    let last = null;
    for (const seg of v.segs) {
      const t = seg.node || seg.el;
      if (!el.contains(t)) continue;
      last = seg;
      if (!pivot || pivot === t || (pivot.compareDocumentPosition(t) & 4) === 4) {
        if (!after) after = seg;
      } else before = seg;
    }
    if (end) {
      if (!pivot) return last ? last.to : -1;
      return before ? before.to : after ? after.from : -1;
    }
    return after ? after.from : before ? before.to : -1;
  }
  function blockEls(row) {
    const body = row.querySelector(".dsh-msg-body");
    if (!body) return [];
    /* 只认「最外层」那一颗：figure > img、.rv-math > .katex-display 这类嵌套，
       否则同一处会出现两条可批注项（序号还会打架）。 */
    return Array.from(body.querySelectorAll(BLOCK_SEL)).filter(
      (b) => !b.closest(".dsh-tools") && !(b.parentElement && b.parentElement.closest(BLOCK_SEL)),
    );
  }
  /* 目标元素所在的「最外层可批注块」（hover 时命中 img / 公式内部也归到整块） */
  function outerBlockOf(node) {
    if (!node || !node.closest) return null;
    let hit = node.closest(BLOCK_SEL);
    if (!hit) return null;
    for (;;) {
      const up = hit.parentElement ? hit.parentElement.closest(BLOCK_SEL) : null;
      if (!up) break;
      hit = up;
    }
    return hit;
  }
  /* 整块批注的「原文」：公式取 TeX 原文（data-rv-tex，与可见文本同一份 mathTexOf），
     图取 alt / src，其余取文本。公式不能取 textContent —— KaTeX 每个公式排两份
     （.katex-html 可见 + .katex-mathml 给读屏 / 复制），textContent 会把公式读成两遍。 */
  function blockQuote(block) {
    if (!block) return "";
    const mt = mathTexOf(block);
    if (mt) return mt;
    if (block.tagName === "IMG")
      return String(block.getAttribute("alt") || block.getAttribute("src") || "").trim();
    return String(block.textContent || "").replace(/\s+/g, " ").trim();
  }
  /* 块锚点：先按原文片段认（BLOCK_SEL 加进公式后块序号会整体后移，老数据靠这一条续命），
     认不出来再退回块序号。 */
  function blockForAnno(row, anno) {
    const blocks = blockEls(row);
    if (!blocks.length) return null;
    const q = String((anno && anno.quote) || "").trim();
    if (q) {
      for (const b of blocks) if (blockQuote(b) === q) return b;
      for (const b of blocks) {
        const t = blockQuote(b);
        if (t && (t.indexOf(q) >= 0 || q.indexOf(t) >= 0)) return b;
      }
    }
    return blocks[anno && anno.blockIdx >= 0 ? anno.blockIdx : 0] || null;
  }
  /* 元素在屏幕上的矩形（行内公式 / 图可能跨行，一块给多条） */
  function elRects(node) {
    let list = [];
    try {
      list = node.getClientRects ? node.getClientRects() : [];
    } catch (_) {
      list = [];
    }
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (!r || r.width < 0.5 || r.height < 0.5) continue;
      out.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    }
    if (!out.length) {
      const r = node.getBoundingClientRect();
      if (r && (r.width || r.height))
        out.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    }
    return out;
  }
  /* 引文 → Range：先按可见文本口径找；找不到再退回「全文拼接」的老口径 ——
     老会话里已存的 quote 是「公式读两遍」的样子，不能让它们变成「锚点已变更」。 */
  function rangeOfQuote(root, quote, occ) {
    if (!quote) return null;
    const want = Math.max(0, Number(occ) || 0);
    const hit = quoteHit(visTextOf(root), quote, want) || quoteHit(legacyTextOf(root), quote, want);
    if (!hit) return null;
    const a = segAt(hit.segs, hit.from, false);
    const b = segAt(hit.segs, hit.to, true);
    if (!a || !b) return null;
    const r = document.createRange();
    try {
      r.setStart(a.node, a.off);
      r.setEnd(b.node, b.off);
    } catch (_) {
      return null;
    }
    return r;
  }
  /* 第 occ 次出现的位置（越界回退到第一次）；返回段表 + 起止偏移 */
  function quoteHit(v, quote, want) {
    let idx = -1;
    let from = 0;
    for (let k = 0; k <= want; k++) {
      idx = v.full.indexOf(quote, from);
      if (idx < 0) break;
      from = idx + 1;
    }
    if (idx < 0) idx = v.full.indexOf(quote);
    if (idx < 0) return null;
    return { segs: v.segs, from: idx, to: idx + quote.length };
  }
  function rowForAnno(anno) {
    const list = st.listEl;
    if (!list) return null;
    if (anno.msgKey) {
      const hit = list.querySelector('[data-hist-key="' + cssEsc(anno.msgKey) + '"]');
      if (hit && hit.classList.contains("dsh-ai")) return hit;
    }
    const rows = Array.from(list.querySelectorAll(".dsh-msg.dsh-ai")).filter(
      (r) => r.dataset && r.dataset.histKey,
    );
    if (anno.msgKey) {
      /* msgKey 命中不了：按「原文片段落在这行里」找（换视图 / 载入更早内容后的兜底）。
         两套口径都试：新批注的 quote 是可见文本（公式写作 $tex$，textContent 里找不到），
         老批注的 quote 是「公式读两遍」的全文（只有在 textContent 里才找得到）。 */
      const q = (anno.quote || "").slice(0, 24);
      if (q) {
        for (const r of rows) {
          const body = r.querySelector(".dsh-msg-body");
          if (!body) continue;
          if (String(body.textContent || "").indexOf(q) >= 0 || visTextOf(body).full.indexOf(q) >= 0)
            return r;
        }
      }
    }
    if (anno.aiIdx >= 0 && rows[anno.aiIdx]) return rows[anno.aiIdx];
    return null;
  }
  function cssEsc(s) {
    if (window.CSS && typeof CSS.escape === "function") return CSS.escape(String(s));
    return String(s).replace(/["\\]/g, "\\$&");
  }
  function aiIndexOfRow(row) {
    if (!st.listEl || !row) return -1;
    const rows = Array.from(st.listEl.querySelectorAll(".dsh-msg.dsh-ai"));
    return rows.indexOf(row);
  }
  /* Range 的每行矩形（第五轮重写 · 用户截图「一句话里夹行内公式，框选乱作一团」）：
     KaTeX 的行内公式在几何上是「碎块」—— .katex-html 里的上下标 / \sqrt / cases 把一句话
     切成好几段，每段的 top / height 跟正文字行差十几 px；.katex-mathml 那一份还被裁成
     1px 见方、贴在容器角上（原因见 blockQuote 的注释），range.getClientRects() 会把它当成
     一个真实矩形吐出来。早先这里按「top 差 < 2px 且左边界接着上一块」合并 —— 公式碎块
     永远合并不进去，一句话就被拆成一堆小框（截图里那几层叠在一起的虚线 + 伸出画面的幽灵框）。
     现在改成「按视觉行聚簇再取并集」：
       ① 先丢退化碎块：0 尺寸、两个方向都 < 2px 的 mathml 裁切副本、离群的极小块；
       ② 垂直重叠率 > 50% 的碎块归同一「视觉行」（不再要求 top 相同）；
       ③ 行高不取簇的 max（\sqrt / 上标 / cases 会把框撑高），取该行「文本碎块」的
          代表 top / height（中位数）—— 框仍贴在文字行上，公式被整行吞掉；
       ④ 同一行内 left 取最小、right 取最大（缩进以该行实际 min left 为准）：
          一句话 = 一条连续框，跨行选区逐行一条。
     对外签名与返回结构（{left,top,right,bottom}[]）不变：drawBoxes / drawGlow / markAtPoint
     / paintHandles / 拖选预览全都只认这份矩形，调用方零改动。 */
  function mergeLineRects(raw) {
    const items = [];
    for (let i = 0; i < (raw ? raw.length : 0); i++) {
      const r = raw[i];
      if (!r) continue;
      const left = Number(r.left);
      const top = Number(r.top);
      const right = Number(r.right);
      const bottom = Number(r.bottom);
      if (
        !isFinite(left) ||
        !isFinite(top) ||
        !isFinite(right) ||
        !isFinite(bottom)
      )
        continue;
      const w = right - left;
      const h = bottom - top;
      /* ① 退化碎块：0 尺寸，以及任一方向不足 2px 的细条 —— KaTeX 的 .katex-mathml 副本
         被 CSS 裁成 1px 见方贴在容器角上，让 range.getClientRects() 吐出位置完全不对的
         「幽灵框」（截图里那条伸出画面外的虚线）。真文字碎块最小也有 4px 宽 / 一行高。*/
      if (!(w >= 2) || !(h >= 2)) continue;
      items.push({ left: left, top: top, right: right, bottom: bottom, h: h });
    }
    if (!items.length) return [];
    items.sort((a, b) => a.top - b.top || a.left - b.left);
    /* ② 按垂直重叠率 > 50% 聚成视觉行：先归簇，再补一轮「簇吃掉簇」处理链式重叠 */
    const clusters = [];
    for (const it of items) {
      let best = null;
      let bestRatio = 0;
      for (const c of clusters) {
        const ov = Math.min(c.bottom, it.bottom) - Math.max(c.top, it.top);
        if (!(ov > 0)) continue;
        const base = Math.min(c.bottom - c.top, it.h);
        const ratio = base > 0 ? ov / base : 0;
        if (ratio > bestRatio) {
          bestRatio = ratio;
          best = c;
        }
      }
      if (best && bestRatio > 0.5) {
        best.items.push(it);
        if (it.left < best.left) best.left = it.left;
        if (it.right > best.right) best.right = it.right;
        if (it.top < best.top) best.top = it.top;
        if (it.bottom > best.bottom) best.bottom = it.bottom;
      } else {
        clusters.push({
          items: [it],
          left: it.left,
          right: it.right,
          top: it.top,
          bottom: it.bottom,
        });
      }
    }
    const joined = [];
    for (const c of clusters) {
      let merged = false;
      for (const j of joined) {
        const ov = Math.min(j.bottom, c.bottom) - Math.max(j.top, c.top);
        if (!(ov > 0)) continue;
        const base = Math.min(j.bottom - j.top, c.bottom - c.top);
        if (!(base > 0) || ov / base <= 0.5) continue;
        j.items = j.items.concat(c.items);
        if (c.left < j.left) j.left = c.left;
        if (c.right > j.right) j.right = c.right;
        if (c.top < j.top) j.top = c.top;
        if (c.bottom > j.bottom) j.bottom = c.bottom;
        merged = true;
        break;
      }
      if (!merged)
        joined.push({
          items: c.items,
          left: c.left,
          right: c.right,
          top: c.top,
          bottom: c.bottom,
        });
    }
    /* 正文字行的参考高度：全选区的碎块高度中位数（一句话里绝大多数碎块是正文） */
    const allH = items.map((i) => i.h).sort((a, b) => a - b);
    const hRef = allH[Math.floor((allH.length - 1) / 2)] || 0;
    const out = [];
    for (const c of joined) {
      const hs = c.items.map((i) => i.h).sort((a, b) => a - b);
      const hMed = hs[Math.floor((hs.length - 1) / 2)] || 0;
      /* ① 尾巴：整簇都是远小于正文行的碎点、且窄到不成行 → 离群幽灵块，丢掉 */
      const maxH = hs[hs.length - 1] || 0;
      const wSum = c.right - c.left;
      if (hRef > 0 && maxH < hRef * 0.55 && wSum < 10) continue;
      /* ③ 行高 / 行顶取「文本碎块」（高度接近中位数的那批）的中位数：
         公式把碎块撑高到 1.4 倍以上时它不参与定框，但它的 left / right 已经被并进来了 */
      const txt = c.items.filter((i) => i.h <= hMed * 1.4);
      const tops = txt.map((i) => i.top).sort((a, b) => a - b);
      const top = tops[Math.floor((tops.length - 1) / 2)];
      const height = Math.max(1, hMed);
      /* ④ 一句 = 一条连续框：左右取整簇的极值（行内公式 / 行内 code 的缺口一并吞掉） */
      out.push({ left: c.left, top: top, right: c.right, bottom: top + height });
    }
    out.sort((a, b) => a.top - b.top || a.left - b.left);
    return out;
  }
  function rangeRects(range) {
    let list = [];
    try {
      list = range.getClientRects ? range.getClientRects() : [];
    } catch (_) {
      list = [];
    }
    return mergeLineRects(list);
  }
  function boxOf(rects) {
    if (!rects || !rects.length) return null;
    const b = {
      left: rects[0].left,
      top: rects[0].top,
      right: rects[0].right,
      bottom: rects[0].bottom,
    };
    for (const r of rects) {
      if (r.left < b.left) b.left = r.left;
      if (r.top < b.top) b.top = r.top;
      if (r.right > b.right) b.right = r.right;
      if (r.bottom > b.bottom) b.bottom = r.bottom;
    }
    b.width = b.right - b.left;
    b.height = b.bottom - b.top;
    return b;
  }
  /* 量一条批注现在在屏幕上的位置（纯读；reuse = 复用上一帧还连在文档里的 Range） */
  function measure(anno, reuse) {
    const row = rowForAnno(anno);
    if (!row) return null;
    if (anno.scope === "block") {
      const b = blockForAnno(row, anno);
      if (!b) return null;
      const rects = elRects(b);
      if (!rects.length) return null;
      return { rects: rects, range: null, blockEl: b };
    }
    const body = row.querySelector(".dsh-msg-body");
    if (!body) return null;
    let range = null;
    const prev = reuse ? st.marks.get(anno.id) : null;
    if (
      prev &&
      prev.range &&
      prev.range.startContainer &&
      prev.range.startContainer.isConnected &&
      body.contains(prev.range.startContainer) &&
      /* 比的是「可见文本」而不是 range.toString()：后者会把公式读两遍，跟新口径的 quote 永远不等 */
      quoteOfRange(body, prev.range) === String(anno.quote || "").trim()
    )
      range = prev.range;
    if (!range) range = rangeOfQuote(body, anno.quote, anno.occ);
    if (!range) return null;
    const rects = rangeRects(range);
    if (!rects.length) return null;
    return { rects: rects, range: range, blockEl: null };
  }

  /* ── 卡片层 / 虚线框层 / 左侧边栏（整屏 fixed，见文件头要点 1） ────────────── */
  function ensureLayer() {
    if (st.layer && st.layer.isConnected) return st.layer;
    const layer = el("div", "sa-layer");
    layer.id = "saLayer";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "sa-wires");
    const boxes = el("div", "sa-marks");
    /* 当前这一条的金色呼吸灯虚线框：独立一层 svg（div 的 dashed 边框没法跑马灯），
       压在虚线框层之上、边栏之下 —— drawWires 每帧清空 svg.sa-wires 时不会连它一起清掉。 */
    const glow = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    glow.setAttribute("class", "sa-glow");
    /* 左侧边栏：头部（收起 / 展开）+ 收起时的编号点 + 展开时的批注卡 */
    const rail = el("div", "sa-rail");
    rail.classList.toggle("is-open", !!st.railOpen);
    const head = el("button", "sa-rail-head");
    head.type = "button";
    head.addEventListener("mousedown", (ev) => ev.preventDefault());
    head.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      st.railOpen = !st.railOpen;
      schedule();
    });
    const railMarks = el("div", "sa-rail-marks");
    const body = el("div", "sa-rail-body");
    rail.appendChild(head);
    rail.appendChild(railMarks);
    rail.appendChild(body);
    layer.appendChild(svg);
    layer.appendChild(boxes);
    layer.appendChild(glow);
    layer.appendChild(rail);
    document.body.appendChild(layer);
    st.layer = layer;
    st.wires = svg;
    st.glow = glow;
    st.boxesBox = boxes;
    st.rail = rail;
    st.railHead = head;
    st.railMarks = railMarks;
    st.cardsBox = body;
    return layer;
  }
  function hideLayer() {
    st.marks.clear();
    if (st.boxesBox) st.boxesBox.innerHTML = "";
    if (st.glow) st.glow.innerHTML = "";
    if (st.railMarks) st.railMarks.innerHTML = "";
    if (st.layer) st.layer.style.display = "none";
    if (st.selBtn) st.selBtn.style.display = "none";
    if (st.hoverBtn) st.hoverBtn.style.display = "none";
    applyRailPad(0);
  }
  function clearCards() {
    st.cards.clear();
    if (st.cardsBox) st.cardsBox.innerHTML = "";
  }
  /* ── 左侧留白不够时，给会话区补 padding-left（面板落在这里，绝不压正文）──
     · 只改内联 padding-left；CSS 原有那一条先量出来，补的时候加在它上面；
     · 切会话 / 删光批注 / 视图收起 → applyRailPad(0) 原样还原（railBasePad）。
     为什么补在会话区（.agent-body / .assist-pane）而不是消息列上：这两只是消息列与
     输入区的共同父级，补在它们身上，消息与输入框一起右移、仍然对齐；补在消息列上
     只会让正文变窄、跟输入框错位。 */
  function railPaneEl() {
    const list = st.listEl;
    if (!list) return null;
    return (
      (list.closest && (list.closest(".agent-body") || list.closest(".assist-pane"))) ||
      list.parentElement ||
      null
    );
  }
  function applyRailPad(px) {
    const pane = railPaneEl();
    if (!pane) return 0;
    if (st.railPane !== pane) {
      /* 换了会话区（切会话 / 会话页 ↔ 助手栏）：先把上一只补过的内边距原样还回去 */
      const old = st.railPane;
      if (old && old.isConnected && old.style.paddingLeft !== st.railBasePad) {
        old.style.paddingLeft = st.railBasePad;
      }
      st.railPane = pane;
      st.railBasePad = pane.style.paddingLeft || "";
      let base = 0;
      try {
        base = parseFloat(window.getComputedStyle(pane).paddingLeft) || 0;
      } catch (_) {
        base = 0;
      }
      st.railBaseSize = base;
    }
    const pad = Math.max(0, Math.round(px || 0));
    if (pad > 0) pane.style.paddingLeft = Math.round(st.railBaseSize + pad) + "px";
    else if (pane.style.paddingLeft !== st.railBasePad) pane.style.paddingLeft = st.railBasePad;
    st.railPad = pad;
    return pad;
  }
  /* 被批注的每一段 = 一层虚线框（不填充；正文一个字都不动） */
  function drawBoxes() {
    const box = st.boxesBox;
    if (!box) return;
    box.innerHTML = "";
    for (const [id, m] of st.marks) {
      const on = st.activeId === id;
      for (const r of m.rects) {
        const d = el("div", "sa-mark" + (on ? " on" : "") + (st.drag && st.drag.id === id ? " is-drag" : ""));
        d.style.left = Math.round(r.left - 3) + "px";
        d.style.top = Math.round(r.top - 3) + "px";
        d.style.width = Math.max(2, Math.round(r.right - r.left + 6)) + "px";
        d.style.height = Math.max(2, Math.round(r.bottom - r.top + 6)) + "px";
        box.appendChild(d);
      }
    }
    drawGlow();
  }
  /* 当前这一条的金色呼吸灯细虚线（用户口径 · 第四轮）：虚线的「跑马灯」由 svg 的
     stroke-dashoffset 动画演，呼吸感由 stroke-opacity + drop-shadow 的 keyframes 演
     （见 css 的 .sa-glow-box）—— div 的 dashed 边框动不了，所以在叠层里再描一层。
     选中正文那段、鼠标停在它的卡片上、正在卡片里写字，三种情况都落在 st.activeId 上。 */
  function drawGlow() {
    const g = st.glow;
    if (!g) return;
    while (g.firstChild) g.removeChild(g.firstChild);
    const id = st.activeId;
    if (!id) return;
    const m = st.marks.get(id);
    if (!m || !m.rects.length) return;
    const NS = "http://www.w3.org/2000/svg";
    for (const r of m.rects) {
      const rect = document.createElementNS(NS, "rect");
      rect.setAttribute("x", String(Math.round(r.left - 3)));
      rect.setAttribute("y", String(Math.round(r.top - 3)));
      rect.setAttribute("width", String(Math.max(2, Math.round(r.right - r.left + 6))));
      rect.setAttribute("height", String(Math.max(2, Math.round(r.bottom - r.top + 6))));
      rect.setAttribute("rx", "5");
      rect.setAttribute("class", "sa-glow-box");
      g.appendChild(rect);
    }
  }
  function markAtPoint(x, y) {
    if (!(x >= 0) || !(y >= 0)) return "";
    for (const [id, m] of st.marks) {
      for (const r of m.rects) {
        if (x >= r.left - 4 && x <= r.right + 4 && y >= r.top - 3 && y <= r.bottom + 3) return id;
      }
    }
    return "";
  }

  /* ── 批注框里的截图 / 图片（本次需求）──────────────────────────────────
     批注卡只是一只裸 <textarea>；「粘贴截图 / 拖入图片 / 选本机图片 → 落盘 → 正文里写一行
     ![名称](绝对路径)」这套内核已经在 renderer/app-inline-img.js（window.MTInlineImg 的
     textarea 版）里，会话 / 助手两只输入框用的就是它 —— 这里只接线，不另写一套。
     落盘复用 app-assist.js 的 chatImgWriteBase64（会话工作目录的 .mtnode-input/，没有工作
     目录时退数据目录 chat-input，命名 paste-*.png），所以「工作目录清理面板」一处就能看到
     批注图与输入框的图。图行是**独占一行**的，发送拼块时 MTInlineImg.absImgPaths 才认得出
     它是附件（网关 attachImages 只认真路径）。 */
  function imgMod() {
    return window.MTInlineImg || null;
  }
  /* saveBase64 钩子：落盘目录 = 这条批注所属会话的当前工作目录（切会话跟着换） */
  function annoImgSaveBase64(picked) {
    const fn = window.chatImgWriteBase64;
    if (typeof fn !== "function") return null;
    return fn(picked, () => {
      try {
        const s = sessionOfHost(st.mode);
        return s && typeof agentRunWorkspace === "function" ? agentRunWorkspace(s) : "";
      } catch (_) {
        return "";
      }
    });
  }
  /* 「插图」键的取图 → 插行：有本机路径就整路径引用（不复制文件）；剪贴板截图 / 内存位图
     交给 saveBase64 落成真文件再插。两条路都与两只输入框完全同一份实现。 */
  function insertImgIntoCard(ta, opts) {
    const m = imgMod();
    if (!m || typeof m.pickImage !== "function") return;
    Promise.resolve(m.pickImage(opts.target)).then(
      (picked) => {
        if (!picked) return;
        const p = String(picked.srcPath || "").trim();
        if (p) {
          if (typeof m.insertFromPathLine === "function") m.insertFromPathLine(p, ta, opts);
          return;
        }
        if (typeof m.saveImage !== "function" || typeof m.insertImgLine !== "function") return;
        Promise.resolve(m.saveImage(picked, opts.target())).then((saved) => {
          if (saved) m.insertImgLine(ta, saved, opts);
        });
      },
      () => {},
    );
  }

  /* ── 批注卡里的图行投影（缩略图 + 文件名 + ✕；窄版胶囊）───────────────────
     卡片只有 252px 宽，正文里一行 `![截图](C:\…\paste-xxx.png)` 裸在 textarea 里既看不清
     也不好操作。所以在 textarea 上方投影一排**窄版**胶囊（视觉沿用 inline-img.css 的胶囊
     语言 —— 边框 / 圆角 / 悬停变青，但一处一枚、22px 缩略图，不搬 .ii-line-chips 进来）：
       · 点缩略图 → 光标进正文那一行并整行选中；
       · ✕ → 删掉整行（连同它独占的那个换行），派一次 input 让既有 commit 生效
         （正文 hit.body / applied / 保存 / 状态标签 / 发送栏胶囊全挂在 commit 上）。
     图行判据与下发同源：window.MTInlineImg.imgLines（整行只有一张图才算一张图）。渲染幂等
     —— 按「正文里的图行签名」比对，签名没变就不动 DOM（paint 每帧都会走到这里）。 */
  function imgFileNameOf(ref) {
    const s = String(ref == null ? "" : ref).split(/[?#]/)[0];
    const seg = s.split(/[\\/]/).pop() || "";
    try {
      return decodeURIComponent(seg);
    } catch (_) {
      return seg;
    }
  }
  /* 点 / 删之前按当前正文重算这一行：投影是按 body 画的，正文若从别的路径变过，
     拿旧偏移去选 / 去删就会动到别的行。找不到 = 那行已经没了。 */
  function cardImgLineNow(ta, l) {
    const m = imgMod();
    if (!m || !ta || !l || typeof m.imgLines !== "function") return null;
    const lines = m.imgLines(ta.value);
    return (
      lines.find((x) => x.start === l.start && x.ref === l.ref) ||
      lines.find((x) => x.n === l.n && x.ref === l.ref) ||
      lines.find((x) => x.ref === l.ref) ||
      null
    );
  }
  /* 点缩略图：光标落进正文那一行并整行选中 */
  function cardImgFocus(c, l) {
    if (!c || !c.ta) return;
    const now = cardImgLineNow(c.ta, l);
    if (!now) return;
    try {
      c.ta.focus();
      c.ta.setSelectionRange(now.start, now.end);
    } catch (_) {}
  }
  /* ✕：删掉整行 + 派 input（既有 commit 接住，不另加钩子） */
  function cardImgRemove(c, l) {
    if (!c || !c.ta) return;
    const ta = c.ta;
    const now = cardImgLineNow(ta, l);
    if (!now) {
      /* 正文已经不是画投影时那一帧了：按现正文重画，绝不按旧偏移乱删 */
      renderCardImgs(c, annoById(c.id));
      return;
    }
    const v = String(ta.value || "");
    let s = now.start;
    let e = now.end;
    if (v.slice(e, e + 1) === "\n") e++;
    else if (v.slice(s - 1, s) === "\n") s--;
    ta.value = v.slice(0, s) + v.slice(e);
    try {
      ta.setSelectionRange(s, s);
    } catch (_) {}
    try {
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    } catch (_) {}
  }
  function renderCardImgs(c, anno) {
    const box = c && c.imgs;
    if (!box) return;
    const m = imgMod();
    const lines = m && typeof m.imgLines === "function" ? m.imgLines(String((anno && anno.body) || "")) : [];
    const sig = String((anno && anno.id) || "") + "|" + lines.map((l) => l.n + ":" + l.alt + ":" + l.ref).join("\n");
    if (box._saImgSig === sig) return; /* 幂等：签名没变就不动 DOM */
    box._saImgSig = sig;
    box.innerHTML = "";
    box.hidden = !lines.length;
    if (!lines.length) return;
    for (const l of lines) {
      const row = el("div", "sa-card-img");
      row.title = T("点击缩略图定位到正文里的这一行（整行选中）") + "\n" + l.ref;
      /* 缩略图：本机绝对路径 / file:/// 直接显示；相对引用没有基准目录 → 退回图标，
         但点击照样是「定位到正文那一行」。 */
      const thumb = el(l.url ? "img" : "span", "sa-card-img-thumb");
      if (l.url) {
        thumb.src = l.url;
        thumb.alt = l.alt || "";
        thumb.loading = "lazy";
      } else {
        thumb.textContent = "🖼";
      }
      thumb.onclick = (ev) => {
        ev.stopPropagation();
        cardImgFocus(c, l);
      };
      row.appendChild(thumb);
      row.appendChild(el("span", "sa-card-img-name", l.alt || imgFileNameOf(l.ref) || T("图片")));
      const x = el("button", "sa-card-img-x", "✕");
      x.type = "button";
      x.title = T("从正文里删掉这一行");
      x.onclick = (ev) => {
        ev.stopPropagation();
        cardImgRemove(c, l);
      };
      row.appendChild(x);
      box.appendChild(row);
    }
  }

  function cardFor(anno) {
    const id = anno.id;
    let c = st.cards.get(id);
    if (c && c.el && c.el.isConnected) return c;
    const box = ensureLayer() && st.cardsBox;
    const root = el("div", "sa-card");
    root.dataset.id = id;
    const head = el("div", "sa-card-head");
    const who = el("b", "sa-card-who");
    const tag = el("span", "sa-card-tag");
    head.appendChild(who);
    head.appendChild(tag);
    const quote = el("div", "sa-card-quote");
    const ta = document.createElement("textarea");
    ta.className = "sa-card-ta";
    ta.rows = 3;
    ta.placeholder = T("写你的批注 / 质疑 / 想展开的点…（写完自动随下一条消息发出）");
    /* 图行投影（缩略图 + 文件名 + ✕）：默认收起，正文里有图行时由 renderCardImgs 填 */
    const imgs = el("div", "sa-card-imgs");
    imgs.hidden = true;
    const foot = el("div", "sa-card-foot");
    /* 用户口径（第三轮）：不再有「加到这条消息」—— 写了字就等于「随消息发出」，
       所以这里只剩「插图」「定位」「删除」三枚小键（插图 = 本次需求）。 */
    const ins = el("button", "sa-btn sa-ins", T("插图"));
    const go = el("button", "sa-btn sa-go", T("定位"));
    const del = el("button", "sa-btn sa-del", T("删除"));
    ins.type = "button";
    go.type = "button";
    del.type = "button";
    ins.title = T("插入截图或本机图片（图会随这条批注一起发给模型）");
    foot.appendChild(ins);
    foot.appendChild(go);
    foot.appendChild(del);
    root.appendChild(head);
    root.appendChild(quote);
    root.appendChild(imgs);
    root.appendChild(ta);
    root.appendChild(foot);
    box.appendChild(root);

    /* 写进去即生效（applied = 批注框里有字）：发送时 takeForSend 只认这一位，
       所以「自动入消息」不需要用户再点任何按钮。 */
    const commit = () => {
      const hit = annoById(id);
      if (!hit) return;
      const v = String(ta.value || "");
      if (hit.body === v) return;
      hit.body = v;
      hit.applied = !!v.trim();
      saveSoon(st.sid || "");
      paintTag(hit, tag);
      renderAllStrips();
      /* 正文变了 → 图行投影跟着变（✕ 删行 / 插图 / 手打图行都走这一条） */
      renderCardImgs(st.cards.get(id), hit);
    };
    ta.addEventListener("input", commit);
    ta.addEventListener("blur", commit);
    ta.addEventListener("focus", () => {
      st.activeId = id;
      schedule();
    });
    /* 粘贴截图 / 拖入图片：共享模块的 textarea 版（与两只输入框同一份内核）。
       插进来的是独占一行的图行；插入是程序写 value（不派 input），所以收尾靠
       onInserted 立刻 commit —— 批注正文始终以 hit.body 为准。 */
    const imgOpts = {
      target: () => ({ kind: "path", name: "", saveBase64: annoImgSaveBase64 }),
      onInserted: commit,
    };
    const im = imgMod();
    if (im && typeof im.bindTextarea === "function") im.bindTextarea(ta, imgOpts);
    ins.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      insertImgIntoCard(ta, imgOpts);
    });
    go.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      focusAnno(id);
    });
    del.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      removeAnno(id);
    });
    root.addEventListener("mouseenter", () => {
      st.activeId = id;
      schedule();
    });
    root.addEventListener("mouseleave", () => {
      if (st.drag) return;
      setTimeout(() => {
        if (st.drag) return;
        if (st.layer && st.layer.querySelector(".sa-card:hover")) return;
        if (markAtPoint(st.lx, st.ly)) return;
        if (st.activeId === id) {
          st.activeId = "";
          schedule();
        }
      }, 160);
    });
    c = { id: id, el: root, ta: ta, tag: tag, quoteEl: quote, who: who, imgs: imgs };
    st.cards.set(id, c);
    return c;
  }
  /* 状态标签（与「自动入消息」同一口径）：写没写字 / 有没有随消息发过 */
  function paintTag(anno, tag) {
    if (!tag) return;
    tag.textContent = anno.used
      ? T("已随消息发出")
      : anno.applied
        ? T("随本条消息发出")
        : T("待填写");
    tag.className = "sa-card-tag" + (anno.used ? " is-used" : anno.applied ? " is-on" : "");
  }

  /* ── 发给模型的那段正文（只在发送那一瞬拼，绝不进输入框） ─────────────── */
  /* body 里有没有「整行一张图」的图行 —— 判据与渲染 / 下发同源（共享模块的 imgLines，
     整行只有 `![名称](引用)` 才算一张图）。模块缺席（切片冒烟）时退回同形整行正则。 */
  function bodyHasImgLine(s) {
    const m = typeof window !== "undefined" ? window.MTInlineImg : null;
    if (m && typeof m.imgLines === "function") {
      try {
        if (m.imgLines(s).length) return true;
      } catch (_) {}
    }
    return /^[ \t]*!\[[^\]]*\]\(.*\)[ \t]*$/m.test(String(s == null ? "" : s));
  }
  function blockText(anno) {
    const q = String(anno.quote || "")
      .replace(/\s+/g, " ")
      .trim();
    const cut = q.length > MAX_QUOTE ? q.slice(0, MAX_QUOTE) + "…" : q;
    const n = anno.aiIdx >= 0 ? anno.aiIdx + 1 : 1;
    const body = String(anno.body || "").trim();
    /* 图行必须**独占一行**才被认成附件（共享模块 imgLines / absImgPaths 的口径：整行只有
       一张图才算）。所以「批注：」后面直接接 body 只在 body 是单行纯文字时才对 ——
       body 以图行开头会被拼成「批注：![截图](C:\…)」，那一行不再是「整行一张图」，图就
       不会随消息下发；多行正文同理（首行会被「批注：」吞掉，粘成一行）。这两种情况另起
       一行写，其余保持原来的行内写法（消息更紧凑）。 */
    const ownLine = body.indexOf("\n") >= 0 || bodyHasImgLine(body);
    return (
      "【批注 #" +
      anno.id +
      " · 第 " +
      n +
      " 条回复】\n> " +
      (cut || T("（整块内容）")) +
      "\n批注：" +
      (ownLine ? "\n" : "") +
      body
    );
  }
  /* 发送那一刻取走要拼进消息的批注块 —— 用户口径（第四轮）：**发出去的那些随即消失**，
     不留「已发出」的残条占版面。所以拼完就 purgeAnno（卡片 / 虚线框 / 编号点一起收），
     剩下没写的批注照旧留着。返回 "" = 这一轮没有批注要带。 */
  function takeForSend(session) {
    const sid = String((session && session.id) || "");
    if (!sid) return "";
    const b = bucket(sid);
    const list = b.annos.filter((a) => String(a.body || "").trim());
    if (!list.length) return "";
    const out = list.map(blockText).join("\n\n");
    for (const a of list) purgeAnno(a.id, sid);
    if (st.sid === sid) {
      schedule();
      renderAllStrips();
    }
    saveSoon(sid);
    return out;
  }

  /* 这一条会话里「有字、会随下一句发出去」的批注条数 —— 与 takeForSend 的取件口径
     完全同一套（body 非空）。用途只有一个：**输入框可以留空就发送**（用户口径 ·
     本次需求「当存在批注时，输入框可以为空并发送」）。判断点有三处（会话视图
     doSend / 助手栏 doAssistSend / 发送按钮的 ↑ 与 ■ 着色），口径只写在这一个函数里。
     还没从盘上读回来的会话先点火读，这一拍按 0 算（与发送栏胶囊条同一节奏）。 */
  function pendingCount(session) {
    const sid = String((session && session.id) || "");
    if (!sid) return 0;
    const b = bucket(sid);
    if (!b.loaded) loadAnnos(sid);
    return b.annos.filter((a) => String(a.body || "").trim()).length;
  }

  /* ── 发送栏胶囊（与图片胶囊同排；点一下定位正文那段，✕ 删掉这条批注） ── */
  function blockTextas() {
    const out = [];
    for (const id of ["agentInput", "assistInput"]) {
      const ta = document.getElementById(id);
      if (ta) out.push(ta);
    }
    return out;
  }
  function sessionForTa(ta) {
    if (!ta) return null;
    try {
      if (ta.id === "assistInput")
        return typeof assistBoundSession === "function" ? assistBoundSession() : null;
      if (ta.id === "agentInput")
        return typeof agentSessionState === "function" ? agentSessionState() : null;
    } catch (_) {}
    return null;
  }
  function stripEl(ta) {
    if (!ta) return null;
    if (ta._saStrip && ta._saStrip.isConnected) return ta._saStrip;
    const card = ta.closest(".agent-composer-card") || ta.closest(".assist-input-row");
    const host = card ? card.parentElement : ta.parentElement;
    if (!host) return null;
    const box = el("div", "sa-line-chips");
    box.hidden = true;
    if (card) host.insertBefore(box, card);
    else host.appendChild(box);
    ta._saStrip = box;
    return box;
  }
  function renderStrip(ta) {
    if (!ta || !ta.isConnected) return;
    const box = stripEl(ta);
    if (!box) return;
    const sess = sessionForTa(ta);
    const sid = sess && sess.id ? String(sess.id) : "";
    if (!sid) {
      box.hidden = true;
      box.innerHTML = "";
      ta._saSig = "";
      return;
    }
    const b = bucket(sid);
    if (!b.loaded) loadAnnos(sid);
    const list = b.annos.filter((a) => a.applied);
    const sig = sid + "|" + list.map((a) => a.id + ":" + (a.body || "").length).join(",");
    if (ta._saSig === sig) return;
    ta._saSig = sig;
    box.innerHTML = "";
    box.hidden = !list.length;
    if (!list.length) return;
    for (const anno of list) {
      const n = anno.aiIdx >= 0 ? anno.aiIdx + 1 : 1;
      const chip = el("div", "sa-chip");
      chip.title =
        T("点击定位到正文里的这一段（第 ") +
        n +
        T(" 条回复）") +
        "\n" +
        String(anno.body || "");
      chip.appendChild(el("b", "sa-chip-id", "#" + anno.id));
      chip.appendChild(el("span", "sa-chip-t", T("第 ") + n + T(" 条回复")));
      chip.appendChild(el("span", "sa-chip-q", String(anno.body || "").replace(/\s+/g, " ").slice(0, 24)));
      const x = el("button", "sa-chip-x", "✕");
      x.type = "button";
      x.title = T("删掉这条批注");
      x.onclick = (ev) => {
        ev.stopPropagation();
        removeAnno(anno.id);
      };
      chip.appendChild(x);
      chip.onclick = () => focusAnno(anno.id);
      box.appendChild(chip);
    }
  }
  function renderAllStrips() {
    for (const ta of blockTextas()) renderStrip(ta);
  }
  /* 定位到某条批注：展开边栏 + 滚动正文到那段 + 把那张卡滚进面板可见区 */
  function focusAnno(id) {
    st.activeId = id;
    if (!st.railOpen) st.railOpen = true;
    const m = st.marks.get(id);
    const b = m ? boxOf(m.rects) : null;
    if (b && st.listEl) {
      const lr = st.listEl.getBoundingClientRect();
      if (b.top < lr.top + 24 || b.bottom > lr.bottom - 24) {
        st.listEl.scrollTop += b.top - lr.top - Math.min(90, (lr.height || 400) / 3);
      }
    }
    schedule();
    setTimeout(() => scrollCardIntoView(id), 30);
  }

  /* ── 增 / 删 ───────────────────────────────────────────────────────────── */
  function newId() {
    let s = "";
    while (s.length < 6) s += Math.random().toString(36).slice(2);
    return s.slice(0, 6).replace(/[^0-9a-z]/g, "") || "a1b2c3";
  }
  function addAnno(spec) {
    if (!st.sid) return null;
    const b = bucket(st.sid);
    const anno = norm(
      Object.assign(
        {
          id: newId(),
          msgKey: "",
          aiIdx: -1,
          quote: "",
          occ: 0,
          body: "",
          scope: "text",
          blockIdx: -1,
          at: Date.now(),
        },
        spec || {},
      ),
    );
    b.annos.push(anno);
    st.annos = b.annos;
    /* 新建一条 = 用户要写字：边栏直接展开，并把光标落进这一条的批注框 */
    st.railOpen = true;
    st.activeId = anno.id;
    saveSoon(st.sid);
    schedule();
    setTimeout(() => {
      const c = st.cards.get(anno.id);
      if (c && c.ta) {
        scrollCardIntoView(anno.id);
        try {
          c.ta.focus();
        } catch (_) {}
      }
    }, 40);
    return anno;
  }
  /* 从表里彻底摘掉一条（连同卡片 / 虚线框 / 金色高亮）—— 手删与「发出去」共用这一条 */
  function purgeAnno(id, sid) {
    const key = String(sid || st.sid || "");
    const b = key ? st.cache.get(key) : null;
    if (b) {
      const i = b.annos.findIndex((a) => a.id === id);
      if (i >= 0) b.annos.splice(i, 1);
      if (st.sid === key) st.annos = b.annos;
    }
    const c = st.cards.get(id);
    if (c && c.el) c.el.remove();
    st.cards.delete(id);
    st.marks.delete(id);
    if (st.activeId === id) st.activeId = "";
  }
  function removeAnno(id) {
    const sid = st.sid;
    if (!sid) return;
    purgeAnno(id, sid);
    saveSoon(sid);
    schedule();
    renderAllStrips();
  }

  /* ── 选区 / 手柄 相关的入口按钮 ────────────────────────────────────────── */
  function ensureSelBtn() {
    if (st.selBtn && st.selBtn.isConnected) return st.selBtn;
    const btn = el("button", "sa-sel-btn", T("批注"));
    btn.type = "button";
    btn.title = T("给选中的这段回复加一条批注");
    document.body.appendChild(btn);
    btn.addEventListener("mousedown", (ev) => ev.preventDefault());
    btn.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      takeSelection();
    };
    st.selBtn = btn;
    return btn;
  }
  function ensureHoverBtn() {
    if (st.hoverBtn && st.hoverBtn.isConnected) return st.hoverBtn;
    const btn = el("button", "sa-hover-btn", T("批注"));
    btn.type = "button";
    btn.title = T("给这一整块加一条批注");
    document.body.appendChild(btn);
    btn.addEventListener("mousedown", (ev) => ev.preventDefault());
    btn.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (st.hoverBlk) takeBlock(st.hoverBlk);
    };
    st.hoverBtn = btn;
    return btn;
  }

  /* ── 画：虚线框 + 卡片 + 连线 + 手柄 ───────────────────────────────────── */
  function paint(layoutOnly) {
    const host = visibleHost();
    if (!host) {
      hideLayer();
      return;
    }
    st.listEl = host.list;
    st.mode = host.mode;
    if (!st.annos.length) {
      st.marks.clear();
      if (st.boxesBox) st.boxesBox.innerHTML = "";
      if (st.glow) st.glow.innerHTML = "";
      if (st.cardsBox) st.cardsBox.innerHTML = "";
      if (st.railMarks) st.railMarks.innerHTML = "";
      st.cards.clear();
      if (st.layer) st.layer.style.display = "none";
      st.dead.clear();
      /* 没有批注 = 不该再占会话区左侧的空白（补过的内边距原样退回） */
      applyRailPad(0);
      if (!layoutOnly) renderAllStrips();
      return;
    }
    ensureLayer();
    st.layer.style.display = "";
    st.dead.clear();
    const next = new Map();
    for (const anno of st.annos) {
      const m = measure(anno, layoutOnly);
      if (m) next.set(anno.id, m);
      else st.dead.add(anno.id);
    }
    st.marks = next;
    drawBoxes();
    if (!layoutOnly) {
      /* 批注表整份换过（读回 / 别处删过）时，先收掉已经不在表里的旧卡片 —— 否则面板里
         会挂着一条点不开也删不掉的僵尸卡。 */
      for (const [id, c] of st.cards) {
        if (st.annos.some((a) => a.id === id)) continue;
        if (c && c.el) c.el.remove();
        st.cards.delete(id);
      }
      st.annos.forEach((anno, i) => {
        const c = cardFor(anno);
        const n = anno.aiIdx >= 0 ? anno.aiIdx + 1 : 1;
        /* 卡片头带编号，与收起态边栏上的编号点一一对得上 */
        c.who.textContent = "#" + (i + 1) + " · " + T("第 ") + n + T(" 条回复");
        const q = String(anno.quote || "").replace(/\s+/g, " ").trim();
        c.quoteEl.textContent = q ? "「" + (q.length > 60 ? q.slice(0, 60) + "…" : q) + "」" : T("（整块内容）");
        if (c.ta !== document.activeElement && c.ta.value !== anno.body) c.ta.value = anno.body;
        paintTag(anno, c.tag);
        /* textarea 上方那排图行投影（缩略图 + 文件名 + ✕）：与正文同步、渲染幂等 */
        renderCardImgs(c, anno);
        /* 当前这一条：卡片左边框跟着走金色呼吸灯（与正文那段 / 连线同一个「高亮」） */
        c.el.classList.toggle("is-active", st.activeId === anno.id);
        c.el.classList.toggle("is-dead", st.dead.has(anno.id));
        const deadTag = c.el.querySelector(".sa-card-dead");
        if (st.dead.has(anno.id) && !deadTag) {
          c.el.insertBefore(el("div", "sa-card-dead", T("锚点已变更：正文里找不到这段原文")), c.quoteEl);
        } else if (!st.dead.has(anno.id) && deadTag) {
          deadTag.remove();
        }
      });
      renderAllStrips();
    }
    railLayout();
    paintHandles();
  }

  /* ── 左侧边栏落点（用户口径 · 第三轮修正）─────────────────────────────────
     批注卡一律放在会话区**左边的空白**里，收成一条可收纳的窄边栏：
       · 收起（缺省）= 22px 窄条 + 每条批注一个编号点（不显示内容），点一下展开；
       · 展开 = 252px 面板，批注卡竖着排在里面，可直接编辑 / 删除 / 定位；
       · 左边留白不够 → 给会话区补 padding-left（applyRailPad），面板落进补出来的空白，
         **绝不压到正文**（上一轮那套「贴正文右侧」正是盖字的元凶）。
     边栏的上下沿跟消息列的可见区对齐，滚动时跟着重排（scheduleLayout）。 */
  function railLayout() {
    const rail = st.rail;
    if (!rail || !st.listEl) return;
    const vh = window.innerHeight || 800;
    const pane = railPaneEl();
    const paneRect = pane ? pane.getBoundingClientRect() : st.listEl.getBoundingClientRect();
    const padBefore = st.railPad;
    /* 窄会话区（助手栏 320–480px）：**不挤正文**，面板浮在它的左侧（画布那一侧），
       正文列一个字都不动；宽会话区（会话页主区）才用「补左内边距」把面板安置在列左侧。
       两处都不压正文 —— 用户口径「不要覆盖正文」。 */
    const narrowPane = paneRect.width < 520;
    const panelW = narrowPane
      ? Math.max(180, Math.min(PANEL_W, Math.round(paneRect.width * 0.62)))
      : Math.min(PANEL_W, Math.max(200, Math.round(paneRect.width * 0.55)));
    const need = st.railOpen ? panelW : RAIL_W;
    if (!narrowPane) {
      const gapNow = () => st.listEl.getBoundingClientRect().left - paneRect.left;
      /* ① 左空白不足：补内联 padding（补一次就够；消息列居中会再让出一半，所以最多补 4 轮） */
      for (let i = 0; i < 4; i++) {
        const gap = gapNow();
        if (gap >= need + RAIL_GAP + 2) break;
        applyRailPad(st.railPad + (need + RAIL_GAP + 2 - gap));
      }
      /* ② 窗口变宽 / 收起面板后把多余的补白退回去（留 60px 余量，避免来回抖） */
      if (st.railPad > 0 && gapNow() > need + RAIL_GAP + 60) {
        applyRailPad(Math.max(0, st.railPad - (gapNow() - need - RAIL_GAP - 10)));
      }
    } else if (st.railPad > 0) {
      applyRailPad(0);
    }
    /* 补 / 退内边距会让正文整体移位 —— 这一帧量到的虚线框 / 连线坐标随即作废，
       下一帧按新位置重量一次（layoutOnly：Range 复用，不再全文查找）。 */
    if (st.railPad !== padBefore) scheduleLayout();
    const lr = st.listEl.getBoundingClientRect();
    const top = Math.max(6, Math.round(lr.top));
    const h = Math.max(120, Math.round(Math.min(lr.height, vh - top - 10)));
    let left = Math.round(lr.left - need - RAIL_GAP);
    if (narrowPane) left = Math.round(paneRect.left - need - RAIL_GAP);
    if (left < 2) left = 2;
    rail.style.left = left + "px";
    rail.style.top = top + "px";
    rail.style.width = need + "px";
    rail.style.height = h + "px";
    const open = !!st.railOpen;
    rail.classList.toggle("is-open", open);
    /* ③ 头部：「批注 N」+ 开合箭头（收起时竖排，整条都能点） */
    const head = st.railHead;
    if (head) {
      head.innerHTML = "";
      head.title = open ? T("收起批注边栏") : T("展开批注边栏");
      const t = el("span", "sa-rail-t", T("批注"));
      const n = st.annos.length;
      if (n) head.appendChild(t);
      if (n) head.appendChild(el("span", "sa-rail-n", String(n)));
      head.appendChild(el("span", "sa-rail-arrow", open ? "‹" : "›"));
    }
    /* ④ 收起态：每条批注一个编号点，纵向对齐它那段正文（叠了就往下错开） */
    const items = [];
    if (st.railMarks) {
      st.railMarks.innerHTML = "";
      st.railMarks.hidden = open;
      if (!open) {
        st.annos.forEach((anno, i) => {
          const m = st.marks.get(anno.id);
          const b = m ? boxOf(m.rects) : null;
          items.push({
            id: anno.id,
            n: i + 1,
            box: b,
            y: b ? b.top - top + 4 : 8,
          });
        });
        items.sort((a, b) => a.y - b.y);
        let cursor = 2;
        for (const it of items) {
          const y = clamp(it.y, cursor, Math.max(cursor, h - 24));
          cursor = y + 24;
          const dot = el("button", "sa-rail-dot" + (st.activeId === it.id ? " on" : ""), String(it.n));
          dot.type = "button";
          dot.dataset.id = it.id;
          dot.style.top = y + "px";
          dot.title = T("第 ") + it.n + T(" 条批注：点一下展开边栏");
          dot.addEventListener("mousedown", (ev) => ev.preventDefault());
          dot.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            st.railOpen = true;
            st.activeId = it.id;
            schedule();
            setTimeout(() => scrollCardIntoView(it.id), 30);
          });
          st.railMarks.appendChild(dot);
        }
      }
    }
    /* ⑤ 连线：被批注那段 → 边栏里的卡片 / 编号点（收起态只有 hover 到那段才亮） */
    const wires = [];
    if (open) {
      for (const anno of st.annos) {
        const m = st.marks.get(anno.id);
        const c = st.cards.get(anno.id);
        if (!m || !c) continue;
        wires.push({ id: anno.id, box: boxOf(m.rects), target: c.el });
      }
    } else if (st.railMarks) {
      const dots = st.railMarks.querySelectorAll(".sa-rail-dot");
      for (let i = 0; i < dots.length; i++) {
        const id = dots[i].dataset.id || "";
        const it = items.find((x) => x.id === id);
        if (it && id) wires.push({ id: id, box: it.box, target: dots[i] });
      }
    }
    drawWires(wires);
  }
  function drawWires(items) {
    const svg = st.wires;
    if (!svg) return;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const NS = "http://www.w3.org/2000/svg";
    for (const it of items) {
      if (!it.box || !it.target || !it.target.isConnected) continue;
      const t = it.target.getBoundingClientRect();
      if (!t.width) continue;
      const x1 = t.right;
      const x2 = it.box.left - 3;
      if (x2 <= x1 + 4) continue;
      const y1 = clamp(it.box.top + 10, t.top + 6, t.bottom - 6);
      const y2 = it.box.top + Math.min(10, Math.max(2, it.box.height / 2));
      const mid = Math.max(8, (x2 - x1) * 0.45);
      const path = document.createElementNS(NS, "path");
      path.setAttribute(
        "d",
        "M" + x1 + " " + y1 + " C" + (x1 + mid) + " " + y1 + "," + (x2 - mid) + " " + y2 + "," + x2 + " " + y2,
      );
      path.setAttribute("class", "sa-wire" + (st.activeId === it.id ? " on" : ""));
      svg.appendChild(path);
    }
  }
  /* 在边栏面板里把某条批注滚进可见区（点编号点 / 胶囊定位时用） */
  function scrollCardIntoView(id) {
    const c = st.cards.get(id);
    const body = st.cardsBox;
    if (!c || !c.el || !body) return;
    try {
      const cr = c.el.getBoundingClientRect();
      const br = body.getBoundingClientRect();
      if (cr.top < br.top || cr.bottom > br.bottom) {
        body.scrollTop += cr.top - br.top - 8;
      }
    } catch (_) {}
  }

  /* 手柄：只在「当前这条」文本批注上出现（整块批注没有手柄 —— 整块吸附就是它的语义） */
  function paintHandles() {
    if (!st.layer) return;
    if (st.drag) return; /* 拖动期间由 onDragMove 自己摆 */
    clearHandles();
    const id = st.activeId;
    if (!id) return;
    const anno = annoById(id);
    if (!anno || anno.scope === "block") return;
    const m = st.marks.get(id);
    if (!m || !m.rects.length) return;
    const first = m.rects[0];
    const last = m.rects[m.rects.length - 1];
    const hs = mkHandle("s", id);
    const he = mkHandle("e", id);
    hs.style.left = Math.round(first.left - 8) + "px";
    hs.style.top = Math.round((first.top + first.bottom) / 2 - 5) + "px";
    he.style.left = Math.round(last.right - 2) + "px";
    he.style.top = Math.round((last.top + last.bottom) / 2 - 5) + "px";
  }
  function clearHandles() {
    if (!st.layer) return;
    const old = st.layer.querySelectorAll(".sa-h");
    for (let i = 0; i < old.length; i++) old[i].remove();
  }
  function mkHandle(side, id) {
    const h = el("div", "sa-h sa-h-" + side);
    h.title = T("拖动增减被批注的文字");
    h.addEventListener("mousedown", (ev) => startDrag(id, side, ev));
    st.layer.appendChild(h);
    return h;
  }

  /* ── 拖选：iOS 式手柄（字符级；同一消息内可跨段） ──────────────────────── */
  /* 偏移一律按「可见文本」那一份段表算（见 visTextOf）：公式只有 $tex$ 占位那么长，
     所以拖过公式时手柄不会错位，存下来的 quote 也不会带上公式判重的第二份。 */
  function textOffsetOf(root, node, off, side) {
    return visOffset(visTextOf(root), node, off, side);
  }
  /* 正文可见文本里的字符区间 → Range（拖选手柄每动一下都按「干净 DOM + 字符偏移」重建，
     绝不复用上一帧的 Range：重绘换掉文本节点后，旧 Range 的边界可能已经不在文档里） */
  function rangeFromOffsets(root, s, e) {
    if (!(e > s)) return null;
    const segs = visTextOf(root).segs;
    const a = segAt(segs, s, false);
    const b = segAt(segs, e, true);
    if (!a || !b) return null;
    const fit = (node, off) =>
      node.nodeType === 3
        ? Math.max(0, Math.min(String(node.nodeValue || "").length, off))
        : Math.max(0, Math.min(node.childNodes ? node.childNodes.length : 0, off));
    const r = document.createRange();
    try {
      r.setStart(a.node, fit(a.node, a.off));
      r.setEnd(b.node, fit(b.node, b.off));
    } catch (_) {
      return null;
    }
    return r;
  }
  /* 选区的「可见文本起止偏移」：端点对不上段表时给 -1（调用方照旧兜底） */
  function offsetsOfRange(v, range) {
    return {
      s: visOffset(v, range.startContainer, range.startOffset, "s"),
      e: visOffset(v, range.endContainer, range.endOffset, "e"),
    };
  }
  /* 选区 / Range 的原文（可见口径：公式只留一份 `$tex$`，不再读两遍） */
  function quoteOfRange(root, range) {
    try {
      const v = visTextOf(root);
      const o = offsetsOfRange(v, range);
      if (o.s < 0 || o.e <= o.s) return "";
      return String(v.full.slice(o.s, o.e) || "").trim();
    } catch (_) {
      return "";
    }
  }
  function occOfRange(root, range) {
    try {
      const v = visTextOf(root);
      const o = offsetsOfRange(v, range);
      if (o.s <= 0 || o.e <= o.s) return 0;
      const quote = String(v.full.slice(o.s, o.e) || "").trim();
      if (!quote) return 0;
      return occOfText(v.full.slice(0, o.s), quote);
    } catch (_) {
      return 0;
    }
  }
  function occOfText(before, quote) {
    let occ = 0;
    let i = String(before || "").indexOf(quote);
    while (i >= 0) {
      occ++;
      i = String(before).indexOf(quote, i + 1);
    }
    return occ;
  }
  function startDrag(id, side, ev) {
    const anno = annoById(id);
    const m = st.marks.get(id);
    const row = anno ? rowForAnno(anno) : null;
    const body = row ? row.querySelector(".dsh-msg-body") : null;
    if (!anno || !m || !m.range || !body) return;
    /* 起边按 "s"、终边按 "e" 折公式段：整颗公式一起进 / 出选区，不做半个公式 */
    const s = textOffsetOf(body, m.range.startContainer, m.range.startOffset, "s");
    const e = textOffsetOf(body, m.range.endContainer, m.range.endOffset, "e");
    if (s < 0 || e < s) return;
    ev.preventDefault();
    ev.stopPropagation();
    /* 只记「字符区间」这一个事实：之后每次移动都按偏移在正文上重算 Range（不写 DOM） */
    st.drag = { id: id, side: side, body: body, s0: s, e0: e, preview: null };
    st.activeId = id;
    document.addEventListener("mousemove", onDragMove, true);
    document.addEventListener("mouseup", onDragEnd, true);
    clearHandles();
  }
  function caretRangeAt(x, y) {
    if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (!p) return null;
      const r = document.createRange();
      r.setStart(p.offsetNode, p.offset);
      r.collapse(true);
      return r;
    }
    return null;
  }
  function onDragMove(ev) {
    const d = st.drag;
    if (!d) return;
    let cr = caretRangeAt(ev.clientX, ev.clientY);
    if (!cr || !d.body.contains(cr.startContainer)) {
      /* 光标落在正文块外面（拖到行尾空白、卡片或留白上）→ 先把它夹回正文块的横向范围再取一次：
         卡片现在紧贴正文右侧，不夹的话往右拖一下就「拖不动」了。 */
      const br = d.body.getBoundingClientRect();
      const x = Math.min(Math.max(ev.clientX, br.left + 1), br.right - 2);
      if (x !== ev.clientX) cr = caretRangeAt(x, ev.clientY);
      if (!cr || !d.body.contains(cr.startContainer)) return;
    }
    /* 公式占位段按拖的那一侧吸附（拖起始柄取段首、拖结束柄取段尾），手柄不会卡在公式中间 */
    const at = textOffsetOf(d.body, cr.startContainer, cr.startOffset, d.side === "s" ? "s" : "e");
    if (at < 0) return;
    let s = d.s0;
    let e = d.e0;
    if (d.side === "s") {
      if (at <= d.e0) s = at;
      else {
        /* 拖过了另一端：反手把另一端当起点 */
        s = d.e0;
        e = at;
      }
    } else if (at >= d.s0) e = at;
    else {
      s = at;
      e = d.s0;
    }
    if (e - s < 1) return;
    const r = rangeFromOffsets(d.body, s, e);
    if (!r) return;
    const rects = rangeRects(r);
    if (!rects.length) return;
    st.marks.set(d.id, { rects: rects, range: r, blockEl: null });
    d.preview = { s: s, e: e, range: r };
    drawBoxes();
    clearHandles();
    const first = rects[0];
    const last = rects[rects.length - 1];
    const hs = mkHandle("s", d.id);
    const he = mkHandle("e", d.id);
    hs.style.left = Math.round(first.left - 8) + "px";
    hs.style.top = Math.round((first.top + first.bottom) / 2 - 5) + "px";
    he.style.left = Math.round(last.right - 2) + "px";
    he.style.top = Math.round((last.top + last.bottom) / 2 - 5) + "px";
  }
  function onDragEnd() {
    const d = st.drag;
    document.removeEventListener("mousemove", onDragMove, true);
    document.removeEventListener("mouseup", onDragEnd, true);
    st.drag = null;
    if (!d) return;
    if (d.preview) {
      /* 手上拖完的这段同样按可见文本口径回写（旧写法 range.toString() 会把行内公式读两遍） */
      const quote = quoteOfRange(d.body, d.preview.range);
      const anno = annoById(d.id);
      if (anno && quote) {
        anno.quote = quote;
        anno.occ = occOfRange(d.body, d.preview.range);
        saveSoon(st.sid || "");
      }
    }
    schedule();
  }

  /* ── 选区 → 新建批注 ───────────────────────────────────────────────────── */
  function selInAiRow() {
    const sel = window.getSelection ? window.getSelection() : null;
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!String(range.toString()).trim()) return null;
    const node = range.commonAncestorContainer;
    const host = node.nodeType === 1 ? node : node.parentElement;
    if (!host || !host.closest) return null;
    if (host.closest(".sa-layer") || host.closest(".sa-card") || host.closest(".sa-line-chips")) return null;
    const row = host.closest(".dsh-msg.dsh-ai");
    if (!row) return null;
    const body = row.querySelector(".dsh-msg-body");
    if (!body) return null;
    if (!body.contains(range.startContainer) || !body.contains(range.endContainer)) return null;
    return { range: range, row: row, body: body };
  }
  /* 显形必须写死一个非 none 的值：两枚按钮的 CSS 缺省就是 display:none（防首帧闪一下），
     早先这里写 style.display = "" ——去掉内联样式之后落回 CSS 的 none，拖选永远不会浮出
     「批注」键（真机上就是这个表现）。 */
  function showBtn(btn) {
    btn.style.display = "inline-flex";
  }
  function placeAt(btn, rect) {
    showBtn(btn);
    const w = btn.offsetWidth || 44;
    const h = btn.offsetHeight || 24;
    const left = clamp(rect.left + rect.width / 2 - w / 2, 8, (window.innerWidth || 900) - w - 8);
    const top =
      rect.bottom + 6 + h > (window.innerHeight || 700) ? Math.max(4, rect.top - h - 6) : rect.bottom + 6;
    btn.style.left = Math.round(left) + "px";
    btn.style.top = Math.round(top) + "px";
  }
  function onMouseUp(ev) {
    if (st.drag) return;
    const t = ev.target;
    if (
      t &&
      t.closest &&
      (t.closest(".sa-layer") || t.closest(".sa-card") || t.closest(".sa-sel-btn") || t.closest(".sa-hover-btn"))
    ) {
      return;
    }
    const m = modeOfNode(t);
    if (m && m !== st.prefer) {
      st.prefer = m;
      schedule();
    }
    setTimeout(() => {
      const hit = selInAiRow();
      const btn = ensureSelBtn();
      if (!hit) {
        btn.style.display = "none";
        return;
      }
      const rects = hit.range.getClientRects();
      const last = rects[rects.length - 1] || hit.range.getBoundingClientRect();
      placeAt(btn, last);
    }, 0);
  }
  function takeSelection() {
    const hit = selInAiRow();
    if (!hit) return;
    const math = mathBlockOfSelection(hit.range);
    if (math) {
      takeBlock(math);
      if (st.selBtn) st.selBtn.style.display = "none";
      try {
        window.getSelection().removeAllRanges();
      } catch (_) {}
      return;
    }
    /* 原文按可见文本取：range.toString() 会把行内公式读两遍（.katex-mathml 那一份） */
    const quote = quoteOfRange(hit.body, hit.range) || String(hit.range.toString()).trim();
    if (!quote) return;
    const occ = occOfRange(hit.body, hit.range);
    addAnno({
      msgKey: String(hit.row.dataset.histKey || ""),
      aiIdx: aiIndexOfRow(hit.row),
      quote: quote,
      occ: occ,
      scope: "text",
    });
    if (st.selBtn) st.selBtn.style.display = "none";
    try {
      window.getSelection().removeAllRanges();
    } catch (_) {}
  }
  /* 整块（表格 / 代码块 / 引用 / 图片 / LaTeX 公式）→ 批注：
     用块在该条消息里的序号当锚点，原文片段（公式取 TeX）当首选锚点 */
  function takeBlock(block) {
    const target = outerBlockOf(block) || block;
    const row = target.closest(".dsh-msg.dsh-ai");
    if (!row) return;
    const blocks = blockEls(row);
    const idx = blocks.indexOf(target);
    const quote = blockQuote(target);
    addAnno({
      msgKey: String(row.dataset.histKey || ""),
      aiIdx: aiIndexOfRow(row),
      quote: quote,
      occ: 0,
      scope: "block",
      blockIdx: idx >= 0 ? idx : 0,
    });
    if (st.hoverBtn) st.hoverBtn.style.display = "none";
  }
  /* 选区落在公式里（整颗 KaTeX 被选中，或选区两端都在同一个 .rv-math 内）→ 按整块批注，
     不按字符区间：公式的 textContent 里有两份排版（见 blockQuote 的注释），拿它当 quote
     下一条消息就找不回来了。 */
  function mathBlockOfSelection(range) {
    const node = range.commonAncestorContainer;
    const host = node && node.nodeType === 1 ? node : node && node.parentElement;
    const m = host && host.closest ? host.closest(".rv-math, .katex-display") : null;
    if (!m) return null;
    if (!m.contains(range.startContainer) || !m.contains(range.endContainer)) return null;
    return outerBlockOf(m);
  }

  /* ── 复杂块 hover → 右上角「批注」键；hover 到被批注的那段 → 卡片成为当前条 ── */
  function onOver(ev) {
    const t = ev.target;
    if (!t || !t.closest) return;
    st.lx = ev.clientX;
    st.ly = ev.clientY;
    if (t.closest(".sa-layer") || t.closest(".sa-sel-btn") || t.closest(".sa-hover-btn")) return;
    /* 悬停在哪一片就画哪一片（两处可能同时开着同一条会话） */
    const mm = modeOfNode(t);
    if (mm && mm !== st.prefer) {
      st.prefer = mm;
      schedule();
    }
    /* 1) 悬停到被批注的那段文字（按坐标命中虚线框）→ 让它那张卡「成为当前这一条」 */
    const at = markAtPoint(ev.clientX, ev.clientY);
    if (at && st.activeId !== at) {
      st.activeId = at;
      schedule();
    }
    /* 2) 复杂块（表格 / 代码块 / 引用 / 图 / 公式）右上角的「批注」键 */
    const body = t.closest(".dsh-msg.dsh-ai .dsh-msg-body");
    if (!body) {
      if (st.hoverBtn) st.hoverBtn.style.display = "none";
      st.hoverBlk = null;
      return;
    }
    const blk = outerBlockOf(t);
    if (!blk || !body.contains(blk) || blk.closest(".dsh-tools")) {
      if (st.hoverBtn) st.hoverBtn.style.display = "none";
      st.hoverBlk = null;
      return;
    }
    st.hoverBlk = blk;
    const btn = ensureHoverBtn();
    const r = blk.getBoundingClientRect();
    showBtn(btn);
    const W = window.innerWidth || 900;
    const H = window.innerHeight || 700;
    const bw = btn.offsetWidth || 44;
    const bh = btn.offsetHeight || 22;
    /* 行内小块（行内公式 / 一张图）没有「块内右上角」可言：贴着它的右外侧竖排居中，
       不压在公式 / 图上；整块的（表格 / 代码块 / 引用）照旧落在块内右上角。 */
    const inline =
      blk.tagName === "IMG" ||
      /^inline/.test(
        (typeof window.getComputedStyle === "function" ? window.getComputedStyle(blk).display : "") || "",
      );
    if (inline) {
      btn.style.left = Math.round(clamp(r.right + 6, 8, W - bw - 8)) + "px";
      btn.style.top = Math.round(clamp(r.top + (r.height - bh) / 2, 4, Math.max(4, H - bh - 8))) + "px";
    } else {
      btn.style.left = Math.round(clamp(r.right - bw - 8, 8, W - bw - 8)) + "px";
      btn.style.top = Math.round(Math.max(4, r.top + 4)) + "px";
    }
  }
  function onOut(ev) {
    const t = ev.target;
    if (!t || !t.closest || st.drag) return;
    if (!t.closest(".dsh-msg-body") && !t.closest(".sa-card")) return;
    setTimeout(() => {
      if (st.drag) return;
      if (st.layer && st.layer.querySelector(".sa-card:hover")) return;
      if (markAtPoint(st.lx, st.ly)) return;
      if (st.activeId) {
        st.activeId = "";
        schedule();
      }
    }, 220);
  }

  /* ── 发送后：这一轮带过的批注标「已用过」 ─────────────────────────────── */
  function markSent(session, text) {
    const sid = String((session && session.id) || st.sid || "");
    if (!sid) return 0;
    const b = bucket(sid);
    if (!b.annos.length) return 0;
    const s = String(text || "");
    let n = 0;
    for (const a of b.annos) {
      if (s.indexOf("【批注 #" + a.id + " ") < 0) continue;
      a.used = true;
      a.usedAt = Date.now();
      a.applied = false;
      n++;
    }
    if (n) {
      saveSoon(sid);
      schedule();
      renderAllStrips();
    }
    return n;
  }
  /* 会话被删掉：顺手回收它的批注文件 */
  function dropSession(sid) {
    const key = String(sid || "");
    if (!key) return;
    st.cache.delete(key);
    const A = api();
    if (A && typeof A.sessionAnnosRemove === "function")
      Promise.resolve(A.sessionAnnosRemove(key)).catch(() => {});
  }

  /* ── 接线：全局监听只挂一次 ───────────────────────────────────────────── */
  function bindComposer(ta) {
    if (!ta || ta._saBound) return;
    ta._saBound = true;
    ta.addEventListener("input", () => renderStrip(ta));
    ta.addEventListener("focus", () => renderStrip(ta));
    ta.addEventListener("change", () => renderStrip(ta));
    renderStrip(ta);
  }
  function boot() {
    document.addEventListener("mouseup", onMouseUp, true);
    document.addEventListener("mouseover", onOver, true);
    document.addEventListener("mouseout", onOut, true);
    window.addEventListener(
      "scroll",
      () => {
        if (st.annos.length) scheduleLayout();
      },
      true,
    );
    window.addEventListener("resize", () => {
      if (st.annos.length) scheduleLayout();
    });
    /* 两只输入框（会话 #agentInput / 助手 #assistInput）：视图搬家时节点不换，监听挂一次就够；
       容器（.agent-composer / .assist-input-row）被搬到开发页时胶囊条跟着一起走。 */
    for (const ta of blockTextas()) bindComposer(ta);
  }

  SA.sync = sync;
  SA.markSent = markSent;
  SA.takeForSend = takeForSend;
  SA.pendingCount = pendingCount;
  SA.dropSession = dropSession;
  /* 引用登记（本节见文件前段「引用登记」）：app-assist.js 把它并进内嵌图的回收判据 */
  SA.imgRefs = annosImgRefs;
  SA.imgRefsReady = imgRefsReady;
  SA.repaint = schedule;
  SA.open = function (sid) {
    if (sid && String(sid) !== st.sid) return loadAnnos(String(sid));
    return Promise.resolve(st.annos);
  };
  SA._state = st;
  SA.textOf = blockText;

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
