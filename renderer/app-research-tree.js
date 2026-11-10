/* ===== 研究视图左栏「内容树」（renderer/app-research-tree.js · window.MTResearchTree）=====
 *
 * 一句话：把左栏原来那两份平铺清单（笔记列表 / 折叠列表）换成一棵树，
 * 结构固定为「索引根 → 原文 → 衍生物 → 折叠（参考资料）」四段。
 *
 *   ▾ 索引   课题那一篇（meta.corePath，默认选中并展开）
 *       中译 / 摘要 / 节选（该篇的变体，只显示标签，点了打开那一稿）
 *   ▾ 原文 (n)        core/*.md：核心文件转出来的正文，可读可改
 *   ▾ 衍生物 (n)      notes/ 下除索引以外：按 derivedFrom 的层缩进（>4 层收进一个收纳节点）
 *       中译 / 摘要 / 节选
 *   ▾ 折叠（参考资料）(n)  literature/folds/*.md：三层折叠视图，点了进只读层
 *
 * 口径（与本轮共识一致）：
 *   · 文档的子内容 = **它的变体**（不再是章节）：成员表取 research-versions.js 的版本组，
 *     只列盘上已有的兄弟稿，子行只显示规则表里的标签；章节导航只留在阅读态右侧大纲。
 *   · 树只是**投影**：笔记真源仍是 notes/*.md 与 core/*.md，本模块只读 RS.notes / RS.folds，
 *     自己不扫盘、不写正文；唯一的写入是右键「新建衍生稿 / 删除」，且都经 app-research.js
 *     的 API 落盘并记进 research/changes.jsonl。
 *   · 折叠状态跟 research.json 的 ui.treeCollapsed 走（与 ui.sideCollapsed 同一套持久化）。
 *     键：条目的 "note:<rel>"（变体随所属条目一起收起/展开）/ 分组的 "grp:original" 等 /
 *     更深层的收纳节点 "col:deep"。值 1 = 收起；缺省 = 展开（子项缺省收起，索引根缺省展开）。
 *   · 衍生物的层：frontmatter 写了 derivedFrom（也认 derived_from / parent / draftOf）就按父子链
 *     往上数；没写就用 layer（也认 level），再没有就是第 1 层。成环 / 断链一律就地断开按第 1 层算。
 *
 * 依赖注入：本模块不引用任何全局（除 window / document），全部走 create(ctx)：
 *   ctx.el / ctx.t / ctx.state(RS) / ctx.root() / ctx.joinP / ctx.api / ctx.C /
 *   ctx.openNote / ctx.openFold / ctx.prompt / ctx.confirm / ctx.toast / ctx.revealPath /
 *   ctx.reload / ctx.logChange / ctx.noteBadge / ctx.generateMany / ctx.multiChanged /
 *   ctx.versions（版本组内核，判绿 / 金的唯一来源）/ ctx.spread（右键「扩散到其他版本」）
 *
 * 多选：Ctrl 追加 / Shift 连选（集合存 RS.multiSel，与 RS.curPath 分开），被选行带 .is-multi；
 *   右键「生成所选变体」与阅读区入口条的同一颗钮都交给 ctx.generateMany(paths) ——
 *   按版本组展开成 jobs 的逻辑在 research-derive.js 的 openMany 里，本模块只认「选了哪几篇」。
 */
(function () {
  "use strict";

  const UI_KEY = "treeCollapsed"; /* research.json → ui.treeCollapsed */
  const MAX_DEPTH = 4; /* 衍生物最多缩 4 层，第 5 层起收进「更深」节点 */
  const CSS_ID = "rs-tree-css";

  /* 只给这棵树用的样式：全部挂在 .rs-tree 下，不动 research.css 里已有的 .rs-note 那套 */
  const CSS = [
    ".rs-tree{overflow:auto;flex:1 1 auto;min-height:0;padding:4px 6px 12px;}",
    /* 树干是界面件：拖一下不该选出一行字（笔记正文在右侧阅读区选，那里不受影响） */
    ".rs-tree-row{display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:7px;",
    "cursor:pointer;border:1px solid transparent;min-width:0;",
    "-webkit-user-select:none;user-select:none;}",
    ".rs-tree-row:hover{background:var(--panel2);}",
    ".rs-tree-row.on{background:var(--panel2);border-color:var(--bd2);}",
    /* 多选（Ctrl / Shift）：描边 + 左侧一条色条，与 .on（正在读的那一篇）区分开、可并存 */
    ".rs-tree-row.is-multi{background:var(--panel2);border-color:var(--cyan);",
    "box-shadow:inset 2px 0 0 var(--cyan);}",
    ".rs-tree-row.is-multi .rs-tree-label{color:var(--ink);}",
    ".rs-tree-row.grp{margin-top:8px;cursor:default;color:var(--muted);}",
    ".rs-tree-row.grp:hover{background:transparent;}",
    ".rs-tree-row.sec{padding-top:3px;padding-bottom:3px;}",
    ".rs-tree-row.sec:hover{background:var(--panel2);}",
    /* 变体行：子项只写变体标签（中译 / 英译 / 摘要 / 节选），字号比条目小一档 */
    ".rs-tree-row.var{padding-top:3px;padding-bottom:3px;}",
    ".rs-tree-row.var .rs-tree-label{font-size:12px;color:var(--muted);}",
    ".rs-tree-row.var:hover .rs-tree-label{color:var(--ink);}",
    ".rs-tree-caret{flex:0 0 14px;width:14px;height:14px;line-height:12px;text-align:center;",
    "border:0;background:transparent;color:var(--muted);font-size:10px;padding:0;border-radius:4px;cursor:pointer;}",
    ".rs-tree-caret:hover{color:var(--ink);background:var(--panel);}",
    ".rs-tree-caret.ghost{visibility:hidden;}",
    ".rs-tree-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
    "font-size:13px;color:var(--ink);}",
    /* 题名里的行内公式：跟标签字号走，别用 KaTeX 默认的 1.21em 把一行小字顶大 */
    ".rs-tree-label .katex{font-size:1em;}",
    ".rs-tree-row.grp .rs-tree-label{font-size:11.5px;color:var(--muted);}",
    ".rs-tree-row.sec .rs-tree-label{font-size:12px;color:var(--muted);}",
    ".rs-tree-row.sec:hover .rs-tree-label{color:var(--ink);}",
    ".rs-tree-count{flex:0 0 auto;font-size:10.5px;color:var(--muted);background:var(--panel);",
    "border:1px solid var(--bd);border-radius:9px;padding:0 6px;line-height:15px;}",
    ".rs-tree-dot{flex:0 0 auto;width:6px;height:6px;border-radius:50%;background:var(--cyan);}",
    ".rs-tree-empty{padding:4px 10px 6px;font-size:11.5px;color:var(--muted);}",
    ".rs-tree-menu{position:fixed;z-index:9999;min-width:170px;background:var(--panel);",
    "border:1px solid var(--bd2);border-radius:8px;padding:4px;box-shadow:0 12px 28px rgba(0,0,0,.28);",
    "-webkit-user-select:none;user-select:none;}",
    ".rs-tree-menu button{display:block;width:100%;text-align:left;background:transparent;border:0;",
    "color:var(--ink);font-size:12.5px;padding:6px 9px;border-radius:6px;cursor:pointer;}",
    ".rs-tree-menu button:hover{background:var(--panel2);}",
    ".rs-tree-menu button.danger{color:var(--red);}",
  ].join("");

  function ensureCss() {
    if (document.getElementById(CSS_ID)) return;
    const st = document.createElement("style");
    st.id = CSS_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  /* ── 小工具（本模块自给自足，不依赖 app-research.js 的私有函数）── */
  function normRel(p) {
    return String(p == null ? "" : p)
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .replace(/\/+/g, "/");
  }
  function stripExt(p) {
    const s = normRel(p);
    return s.slice(s.lastIndexOf("/") + 1).replace(/\.md$/i, "");
  }
  function firstStr(obj, keys) {
    if (!obj) return "";
    for (let i = 0; i < keys.length; i++) {
      const v = obj[keys[i]];
      if (v != null && String(v).trim() !== "") return String(v).trim();
    }
    return "";
  }
  /* 章节 = 2–6 级标题（1 级就是文章标题，不再重复列；围栏代码块里的 # 不算） */
  function sectionsOf(md) {
    const lines = String(md || "").split(/\r?\n/);
    const out = [];
    let fence = "";
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      const f = /^\s*(```+|~~~+)/.exec(L);
      if (f) {
        const mark = f[1].charAt(0);
        if (!fence) fence = mark;
        else if (fence === mark) fence = "";
        continue;
      }
      if (fence) continue;
      const m = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(L);
      if (!m) continue;
      const level = m[1].length;
      if (level < 2) continue;
      out.push({ level: level, text: m[2].trim(), line: i + 1 });
    }
    return out;
  }

  function create(ctx) {
    const el = ctx.el;
    const t = ctx.t;
    let host = null;
    let box = null;
    let menu = null;
    let wired = false;

    ensureCss();

    /* 树行的标签（笔记题名 / 章节行）：`$…$` 与阅读正文同一套渲染，
       左栏里不该出现一段 LaTeX 源码；没有 MTRender 时退回纯文本。 */
    function labelEl(txt) {
      const e = el("span", "rs-tree-label");
      const s = String(txt == null ? "" : txt);
      const R = typeof window !== "undefined" ? window.MTRender : null;
      if (R && typeof R.inlineHtml === "function") e.innerHTML = R.inlineHtml(s);
      else e.textContent = s;
      return e;
    }

    /* ── 折叠状态（research.json → ui.treeCollapsed）── */
    function uiMap() {
      const meta = (ctx.state && ctx.state.meta) || {};
      const ui = meta.ui || {};
      const m = ui[UI_KEY];
      return m && typeof m === "object" ? m : {};
    }
    function isCollapsed(key, dflt) {
      const m = uiMap();
      if (Object.prototype.hasOwnProperty.call(m, key)) return !!m[key];
      return !!dflt;
    }
    function saveCollapsed(key, on) {
      const meta = (ctx.state && ctx.state.meta) || {};
      const ui = Object.assign({}, meta.ui || {});
      const map = Object.assign({}, ui[UI_KEY] && typeof ui[UI_KEY] === "object" ? ui[UI_KEY] : {});
      /* 1 = 收起 / 0 = 展开，两个值都显式写：
         键缺省时按「章节与收纳节点收起、分组与索引根展开」判读，删键并不能表达「展开」 */
      map[key] = on ? 1 : 0;
      ui[UI_KEY] = map;
      if (ctx.saveMeta) ctx.saveMeta({ ui: ui });
    }
    function toggle(key, dflt) {
      saveCollapsed(key, !isCollapsed(key, dflt));
      paint();
    }

    /* ── 搜索（左栏「核心」页顶上那行输入 → RS.sideFilter.core）──
       空 = 不过滤；有关键词时只画命中项，分组与索引根一律展开，让人一眼看到结果在哪。 */
    function searchKw() {
      const f = (ctx.state && ctx.state.sideFilter) || {};
      return String(f.core == null ? "" : f.core).trim().toLowerCase();
    }
    function noteHeadHit(n, kw) {
      const path = normRel(n.path);
      if (String(n.title || "").toLowerCase().indexOf(kw) >= 0) return true;
      return path.toLowerCase().indexOf(kw) >= 0;
    }
    function noteHit(n, kw) {
      if (!kw) return true;
      if (noteHeadHit(n, kw)) return true;
      const secs = sectionsOf(n.md);
      for (let i = 0; i < secs.length; i++) {
        if (String(secs[i].text || "").toLowerCase().indexOf(kw) >= 0) return true;
      }
      /* 子项现在是变体标签：搜「摘要」「节选」也该命中那一篇（不然标签看得见、搜不着） */
      const vars = variantsOf(n.path);
      for (let i = 0; i < vars.length; i++) {
        if (String(vars[i].label || "").toLowerCase().indexOf(kw) >= 0) return true;
      }
      /* 同组兄弟稿不在分组里各占一行了：它们的题名 / 正文命中也要把这一行留下来，
         否则「搜到了、树上却没有」 */
      return siblingHit(n.path, kw);
    }
    function siblingHit(rel, kw) {
      if (!kw) return true;
      const V = versions();
      if (!V || typeof V.groupOf !== "function") return false;
      let g = null;
      try {
        g = V.groupOf(normRel(rel));
      } catch (_) {
        return false;
      }
      const members = (g && Array.isArray(g.members) && g.members) || [];
      const want = normRel(rel);
      for (let i = 0; i < members.length; i++) {
        const m = members[i] || {};
        const p = normRel(m.path);
        if (!p || p === want) continue;
        if (String(m.title || "").toLowerCase().indexOf(kw) >= 0) return true;
        if (p.toLowerCase().indexOf(kw) >= 0) return true;
        const sib = noteByRel(p);
        if (!sib) continue;
        if (noteHeadHit(sib, kw)) return true;
        const secs = sectionsOf(sib.md);
        for (let k = 0; k < secs.length; k++) {
          if (String(secs[k].text || "").toLowerCase().indexOf(kw) >= 0) return true;
        }
      }
      return false;
    }
    function foldHit(f, kw) {
      if (!kw) return true;
      return (
        String(f.title || "").toLowerCase().indexOf(kw) >= 0 ||
        String(f.key || "").toLowerCase().indexOf(kw) >= 0 ||
        normRel(f.path).toLowerCase().indexOf(kw) >= 0
      );
    }

    /* ── 多选（Ctrl 追加 / Shift 连选）──
       选中集合的真源是 RS.multiSel（相对路径数组），**不碰 curPath**：单选管「正在读哪一篇」，
       多选管「要批量生成哪几篇」，两者可以同时成立。paint 按这份集合重画 .is-multi，
       所以重画 / reload 之后选中态仍在；Esc 与点击空白清空。 */
    let rowOrder = []; /* 本次 paint 里可选中条目的顺序（Shift 连选按它取区间） */
    function multiList() {
      const S = ctx.state || {};
      if (!Array.isArray(S.multiSel)) S.multiSel = [];
      return S.multiSel;
    }
    function isMulti(path) {
      return multiList().indexOf(normRel(path)) >= 0;
    }
    function setMulti(list) {
      const S = ctx.state || {};
      const out = [];
      for (let i = 0; i < (list || []).length; i++) {
        const p = normRel(list[i]);
        if (p && out.indexOf(p) < 0) out.push(p);
      }
      S.multiSel = out;
      /* 只通知宿主重画阅读区顶条（树自己 paint，不让宿主再画一遍） */
      if (ctx.multiChanged) {
        try {
          ctx.multiChanged(S.multiSel.slice());
        } catch (_) {}
      }
    }
    function clearMulti() {
      if (!multiList().length) return;
      setMulti([]);
      paint();
    }
    function toggleMulti(path) {
      const p = normRel(path);
      const list = multiList().slice();
      const i = list.indexOf(p);
      if (i >= 0) list.splice(i, 1);
      else list.push(p);
      if (ctx.state) ctx.state.multiAnchor = p;
      setMulti(list);
      paint();
    }
    /* Shift 连选：从锚点（上一次点的那一行）到这一行，按当前画出来的顺序取整段 */
    function rangeMulti(path) {
      const p = normRel(path);
      const S = ctx.state || {};
      const anchor = normRel(S.multiAnchor || S.curPath || "");
      const a = rowOrder.indexOf(anchor);
      const b = rowOrder.indexOf(p);
      if (a < 0 || b < 0 || a === b) {
        toggleMulti(p);
        return;
      }
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const list = multiList().slice();
      for (let i = lo; i <= hi; i++) if (list.indexOf(rowOrder[i]) < 0) list.push(rowOrder[i]);
      S.multiAnchor = p;
      setMulti(list);
      paint();
    }
    /* Esc 清空多选：菜单 / 衍生物面板开着时先让它们自己收（各自已有 Esc 监听），这里不动 */
    let keysWired = false;
    function wireKeys() {
      if (keysWired) return;
      keysWired = true;
      document.addEventListener(
        "keydown",
        function (ev) {
          if (ev.key !== "Escape" || !multiList().length) return;
          if (menu || document.querySelector(".rs-dv-mask")) return;
          if (!box || !box.isConnected) return;
          clearMulti();
        },
        true,
      );
    }

    /* 按相对路径找笔记（只读 RS.notes，不扫盘） */
    function noteByRel(rel) {
      const want = normRel(rel);
      const list = (ctx.state && ctx.state.notes) || [];
      for (let i = 0; i < list.length; i++) if (normRel(list[i] && list[i].path) === want) return list[i];
      return null;
    }

    /* ── 同一版本组只占一行 ──
     * 为什么要有它：core/ 里同一个题名常同时躺着原文与它的中译 / 摘要 / 节选
     * （sharp_bound_rmf_2.md 与 .zh / .summary-zh / .excerpt-zh 三个兄弟），
     * 四个文件都在「原文」分组里各占一行，而每行下面又把另外三稿列成变体子行 ——
     * 同一篇稿子在左栏里出现四遍，正是用户截图里那串重复。
     * 口径：一组的顶行只留**原文**（group.original），其余成员只作为它的变体子行出现。
     * 原文不在盘上时返回空 —— 那一稿就是这一组唯一可见的代表，绝不能藏掉。 */
    function groupHiddenBy(rel) {
      const want = normRel(rel);
      if (!want) return "";
      const V = versions();
      if (!V || typeof V.groupOf !== "function") return "";
      let g = null;
      try {
        g = V.groupOf(want);
      } catch (_) {
        return "";
      }
      const members = (g && Array.isArray(g.members) && g.members) || [];
      if (members.length < 2) return "";
      const mine = members.filter(function (m) {
        return m && normRel(m.path) === want;
      })[0];
      if (!mine) return "";
      const head = normRel((g && g.original) || "");
      if (!head || head === want) return "";
      const headOnDisk = members.filter(function (m) {
        return m && normRel(m.path) === head && m.exists !== false;
      })[0];
      return headOnDisk ? head : "";
    }

    /* ── 数据模型 ── */
    function model() {
      const S = ctx.state || {};
      const meta = S.meta || {};
      const notes = Array.isArray(S.notes) ? S.notes : [];
      const byPath = Object.create(null);
      for (let i = 0; i < notes.length; i++) byPath[normRel(notes[i].path)] = notes[i];
      const coreRel = normRel(meta.corePath || "notes/00-课题.md");
      const root =
        byPath[coreRel] ||
        notes.filter(function (n) {
          return n.meta && (n.meta.core === true || n.meta.core === "true");
        })[0] ||
        notes.filter(function (n) {
          return n.meta && String(n.meta.kind || "") === "topic";
        })[0] ||
        notes[0] ||
        null;
      const rootPath = root ? normRel(root.path) : coreRel;
      const isCore = function (n) {
        const p = normRel(n.path);
        return !!n.core || p.indexOf("core/") === 0;
      };
      /* 分组里一篇稿只占一行：属于别人版本组的成员（译稿 / 摘要 / 节选）让位给那一组的原文，
         自己只作为原文行下的变体子行出现（见 groupHiddenBy 的注释） */
      const originals = notes.filter(function (n) {
        return normRel(n.path) !== rootPath && isCore(n) && !groupHiddenBy(n.path);
      });
      const derived = notes.filter(function (n) {
        return normRel(n.path) !== rootPath && !isCore(n) && !groupHiddenBy(n.path);
      });

      /* 父子链：与 research-core.js 的衍生物约定同一口径 ——
         子笔记记 parent / parents / derivedFrom / derived_from；父笔记反记 derives: [衍生物标题]。
         两边都认路径也认标题；解析不出来就当没有父（落到 layer 兜底）。 */
      const titleIdx = Object.create(null);
      for (let i = 0; i < notes.length; i++) {
        const k = String(notes[i].title || "").trim();
        const p = normRel(notes[i].path);
        if (k && !titleIdx[k]) titleIdx[k] = p;
      }
      const derivedSet = Object.create(null);
      for (let i = 0; i < derived.length; i++) derivedSet[normRel(derived[i].path)] = 1;
      function rawParents(n) {
        const Cc = ctx.C ? ctx.C() : null;
        if (Cc && typeof Cc.readDeriveParents === "function") {
          try {
            return Cc.readDeriveParents(n.meta || {}) || [];
          } catch (_) {}
        }
        const out = [];
        const keys = ["parent", "parents", "derivedFrom", "derived_from", "derivesFrom", "derives_from"];
        for (let i = 0; i < keys.length; i++) {
          const v = (n.meta || {})[keys[i]];
          if (v == null) continue;
          const list = Array.isArray(v) ? v : [v];
          for (let k = 0; k < list.length; k++) {
            const s = String(list[k] == null ? "" : list[k]).trim();
            if (s && out.indexOf(s) < 0) out.push(s);
          }
        }
        return out;
      }
      function resolveRef(raw) {
        const key = String(raw == null ? "" : raw).trim();
        if (!key) return "";
        const asPath = normRel(key);
        if (byPath[asPath]) return asPath;
        return titleIdx[key] || "";
      }
      const parentOf = Object.create(null);
      for (let i = 0; i < derived.length; i++) {
        const n = derived[i];
        const p = normRel(n.path);
        const list = rawParents(n);
        for (let k = 0; k < list.length; k++) {
          const hit = resolveRef(list[k]);
          if (hit && hit !== p) {
            parentOf[p] = hit;
            break;
          }
        }
      }
      /* 父笔记反记的 derives：只补子笔记自己没声明的那些父子关系 */
      for (let i = 0; i < notes.length; i++) {
        const n = notes[i];
        const p = normRel(n.path);
        const raw = (n.meta || {}).derives;
        if (raw == null) continue;
        const list = Array.isArray(raw) ? raw : [raw];
        for (let k = 0; k < list.length; k++) {
          const hit = resolveRef(list[k]);
          if (hit && hit !== p && derivedSet[hit] && !parentOf[hit]) parentOf[hit] = p;
        }
      }
      const depthCache = Object.create(null);
      const inStack = Object.create(null);
      function depthOf(p) {
        if (p in depthCache) return depthCache[p];
        if (p === rootPath) return 0;
        if (inStack[p]) return 1; /* 成环：就地断成第 1 层，别把递归打爆 */
        inStack[p] = 1;
        let d;
        const up = parentOf[p];
        /* 父是原文（core/*.md）时，父那一层不占缩进：它的衍生物仍算第 1 层 */
        if (up && up !== p) d = Math.min(9, (derivedSet[up] ? depthOf(up) : 0) + 1);
        else {
          const lv = Number(firstStr((byPath[p] || {}).meta, ["layer", "level"])) || 1;
          d = Math.max(1, Math.min(9, lv));
        }
        inStack[p] = 0;
        depthCache[p] = d;
        return d;
      }
      const sorted = derived.slice().sort(function (a, b) {
        const pa = normRel(a.path);
        const pb = normRel(b.path);
        const da = depthOf(pa);
        const db = depthOf(pb);
        if (da !== db) return da - db;
        return pa.localeCompare(pb, "zh");
      });
      const folds = Array.isArray(S.folds) ? S.folds : [];
      /* 原件（只读）：core/ 与 literature/sources/ 里的非 md 文件（RS.originals）。
         它们只做打开入口 —— 不进 notes、不进版本组、不参与判色与衍生。 */
      const files = Array.isArray(S.originals) ? S.originals : [];
      return {
        root: root,
        rootPath: rootPath,
        files: files,
        originals: originals,
        derived: sorted,
        depthOf: depthOf,
        parentOf: parentOf,
        byPath: byPath,
        folds: folds,
      };
    }

    /* ── 衍生稿的两种读数：种类/语言徽标 + 三态（research-versions.js）──
     * 树只是投影：这里只读 versions.json 与 RS.notes 里的字节，不写任何东西；
     * 模块缺席（或 ctx.stateOf 已注入）时一律退回「不上色」，绝不猜。 */
    let verInst = null;
    let verLoaded = false;
    let verRoot = "";
    let verNotes = null;
    function versions() {
      if (ctx.versions) return ctx.versions;
      if (verInst) return verInst;
      if (typeof window === "undefined" || !window.MTResearchVersions) return null;
      verInst = window.MTResearchVersions.create({
        root: ctx.root,
        joinP: ctx.joinP,
        api: () => ctx.api,
        notes: () => (ctx.state && ctx.state.notes) || [],
        t: ctx.t,
      });
      return verInst;
    }
    /* 基线还没读进来时先拉一次，读完重画一遍。换根、或笔记被重读（基线可能刚被别的
       面板重写过）就丢掉旧实例重读一次 —— 每轮只读一次盘，且只多画一遍。 */
    function ensureVersions() {
      let root = "";
      try {
        root = String((typeof ctx.root === "function" ? ctx.root() : ctx.root) || "");
      } catch (_) {
        root = "";
      }
      const notes = (ctx.state && ctx.state.notes) || null;
      if (verLoaded && verRoot === root && verNotes === notes) return;
      verLoaded = true;
      verRoot = root;
      verNotes = notes;
      if (!ctx.versions) verInst = null;
      const V = versions();
      if (!V || typeof V.ensureLoaded !== "function") return;
      Promise.resolve(V.ensureLoaded())
        .then(function () {
          paint();
        })
        .catch(function () {});
    }
    /* 四态与阅读区平铺条 / 顶栏金色 chip 同一份判据：research-versions.js 的 statusOfGroup
       （absent 灰 / clean 绿 / stale 橙 / diverged 金）。这里只取自己那一行，不自己比哈希。
       宿主注入 ctx.stateOf 时以它为准（宿主封的就是同一个纯函数）。 */
    function statusOf(rel) {
      if (typeof ctx.stateOf === "function") {
        try {
          return String(ctx.stateOf(rel) || "");
        } catch (_) {}
      }
      const V = versions();
      if (!V) return "";
      const want = normRel(rel);
      try {
        if (typeof V.groupStatus === "function" && typeof V.groupOf === "function") {
          const g = V.groupOf(want);
          const rows = V.groupStatus((g && g.members) || [{ path: want }]) || [];
          for (let i = 0; i < rows.length; i++) {
            if (rows[i] && rows[i].path === want) return rows[i].status || "";
          }
          return "";
        }
        const st = V.stateOf(want);
        return (st && st.status) || "";
      } catch (_) {
        return "";
      }
    }
    /* 这一篇所在的版本组里还有没有别的版本（只有一篇就不摆「扩散到其他版本」：没处可扩散） */
    function hasSiblings(rel) {
      const V = versions();
      if (!V || typeof V.groupOf !== "function") return false;
      const want = normRel(rel);
      try {
        const g = V.groupOf(want);
        if (!g || !Array.isArray(g.members)) return false;
        return g.members.some(function (m) {
          return m && normRel(m.path) !== want;
        });
      } catch (_) {
        return false;
      }
    }
    const KIND_LABELS = { zh: "中译", en: "英译", skim: "略读", concept: "关键概念", tech: "技术细节" };
    /* 种类 / 语言：先问 research-versions.js（与归组同一口径），模块缺席时按文件名后缀兜底 */
    function variantInfo(n, path) {
      const V = typeof window !== "undefined" ? window.MTResearchVersions : null;
      const meta = (n && n.meta) || {};
      const derived = String(meta.derived != null ? meta.derived : meta.derive || "")
        .trim()
        .toLowerCase();
      const langMeta = String(meta.lang || "")
        .trim()
        .toLowerCase();
      let kind = "";
      try {
        if (V && typeof V.kindIdOf === "function") kind = V.kindIdOf(derived, langMeta) || "";
        if (!kind && V && typeof V.suffixOf === "function") {
          const s = V.suffixOf(path);
          if (s) kind = s.kind;
        }
      } catch (_) {
        kind = "";
      }
      if (!kind) {
        const m = /\.(zh|en|skim|concept|tech)\.md$/i.exec(path);
        if (m) kind = m[1].toLowerCase();
      }
      let label = KIND_LABELS[kind] || "";
      try {
        if (!label && V && typeof V.labelOfKind === "function") label = V.labelOfKind(kind) || "";
      } catch (_) {
        label = label || "";
      }
      const lang = langMeta || (kind === "zh" || kind === "en" ? kind : "");
      return { kind: kind, lang: lang, label: label || derived || t("衍生") };
    }

    /* 变体兜底标签（版本模块缺席时才用）：与 DEFAULT_RULES 的五条一一对应 */
    const VARIANT_LABEL = { zh: "中译", en: "英译", skim: "略读", concept: "关键概念", tech: "技术细节" };
    /* ── 文档的子内容 = 它的变体（不再是章节）──
       真源是 research-versions.js 的版本组（与平铺条、判色同一份成员表）：
       只列**盘上已有**的兄弟稿，去掉自己；标签取规则表里的 label（中译 / 英译 / 摘要 / 节选）。
       版本模块缺席时退回文件名后缀兜底，绝不猜不存在的稿子。 */
    function variantsOf(rel) {
      const want = normRel(rel);
      if (!want) return [];
      const out = [];
      const V = versions();
      try {
        if (V && typeof V.groupOf === "function") {
          const g = V.groupOf(want);
          const members = (g && g.members) || [];
          for (let i = 0; i < members.length; i++) {
            const m = members[i] || {};
            const p = normRel(m.path);
            if (!p || p === want || m.exists === false) continue;
            out.push({
              path: p,
              label: String(m.label || "").trim() || t("衍生"),
              kind: String(m.kind || ""),
              lang: String(m.lang || ""),
            });
          }
        }
      } catch (_) {
        out.length = 0;
      }
      if (out.length) return out;
      const notes = (ctx.state && ctx.state.notes) || [];
      const base = normRel(want.replace(/\.md$/i, "") + ".md");
      for (let i = 0; i < notes.length; i++) {
        const p = normRel(notes[i] && notes[i].path);
        const m = /^(.*)\.(zh|en|skim|concept|tech)\.md$/i.exec(p);
        if (!m || normRel(m[1] + ".md") !== base) continue;
        const k = m[2].toLowerCase();
        out.push({
          path: p,
          label: VARIANT_LABEL[k] || t("衍生"),
          kind: k,
          lang: k === "zh" || k === "en" ? k : "",
        });
      }
      return out;
    }

    /* ── 行 ── */
    function caret(expanded, has, onToggle) {
      const b = el("button", "rs-tree-caret" + (has ? "" : " ghost"), has ? (expanded ? "▾" : "▸") : "▸");
      b.type = "button";
      if (!has) {
        b.tabIndex = -1;
        return b;
      }
      b.title = expanded ? t("收起") : t("展开");
      b.onclick = function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        onToggle();
      };
      return b;
    }

    function groupHead(key, label, count, dfltCollapsed, hasItems, opt) {
      const o = opt || {};
      const head = el("div", "rs-tree-row grp");
      head.style.paddingLeft = "8px";
      const open = !isCollapsed(key, dfltCollapsed);
      head.appendChild(
        caret(open, hasItems, function () {
          toggle(key, dfltCollapsed);
        }),
      );
      /* 分组前缀图标（原件分组用锁形：这一组只读，永远不改） */
      if (o.icon) {
        const ic = el("span", "rs-tree-lock", o.icon);
        ic.title = o.title || "";
        ic.setAttribute("aria-hidden", "true");
        head.appendChild(ic);
      }
      head.appendChild(labelEl(label));
      head.appendChild(el("span", "rs-tree-count", String(count)));
      if (o.title) head.title = o.title;
      if (hasItems) {
        head.onclick = function () {
          toggle(key, dfltCollapsed);
        };
      }
      return head;
    }

    /* 变体行：**只显示变体标签**（中译 / 英译 / 摘要 / 节选），不写标题 ——
       标题与原文一样，列一遍只会把树撑长；点一下就是打开那一稿，正在读的那一稿高亮。 */
    function variantRow(v, depth) {
      const S = ctx.state || {};
      const path = normRel(v.path);
      const row = el("div", "rs-tree-row var");
      row.style.paddingLeft = 8 + depth * 12 + "px";
      row.setAttribute("role", "treeitem");
      row.appendChild(caret(false, false, null));
      const label = labelEl(v.label);
      label.title = path;
      row.appendChild(label);
      /* 标签就是全部信息（中译 / 英译 / 摘要 / 节选），不再挂语言 chip 或标题：
         用户要的是「一眼看出这篇有哪几稿」，多一颗 chip 反而又变成第二条信息。 */
      const st = statusOf(path);
      if (st === "diverged") row.classList.add("is-diverged");
      else if (st === "stale") row.classList.add("is-stale");
      else if (st === "absent") row.classList.add("is-nobase");
      if (normRel(S.curPath || "") === path) row.classList.add("on");
      row.onclick = function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (multiList().length) {
          setMulti([]);
          paint();
        }
        if (ctx.openNote) ctx.openNote(path);
      };
      /* 右键：变体这一层单独的短菜单（见 openMenu 的 kind === "var" 分支）。
         原文行与变体行都点得进「生成演示…」，口径一致。 */
      row.oncontextmenu = function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        openMenu(ev, { kind: "var", path: path, title: String(v.label || stripExt(path)), depth: depth });
      };
      return row;
    }

    function appendNote(parent, n, depth, o) {
      const opts = o || {};
      const S = ctx.state || {};
      const path = normRel(n.path);
      const vars = variantsOf(path);
      const key = "note:" + path;
      /* 索引根默认展开（一眼看到它的变体）；其余条目默认收起子项，树才不被长文撑爆。
         搜索中：题名没命中、只靠章节标题 / 变体标签命中的那一篇把子项摊开。 */
      const kwNow = searchKw();
      const open = kwNow && !noteHeadHit(n, kwNow) ? true : !isCollapsed(key, !opts.root);
      const row = el("div", "rs-tree-row");
      row.style.paddingLeft = 8 + depth * 12 + "px";
      row.setAttribute("role", "treeitem");
      row.appendChild(
        caret(open, vars.length > 0, function () {
          toggle(key, !opts.root);
        }),
      );
      if (opts.root) row.appendChild(el("span", "rs-tree-dot"));
      /* 衍生稿行：绿标签 + 前置一条指向原文的细箭头（点一下跳到原文） */
      if (opts.variant) {
        row.classList.add("is-variant");
        if (opts.parent) {
          const from = el("button", "rs-tree-from", "←");
          from.type = "button";
          from.title = t("指向原文：") + opts.parent;
          from.onclick = function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            if (ctx.openNote) ctx.openNote(opts.parent);
          };
          row.appendChild(from);
        }
      }
      const label = labelEl(String(n.title || stripExt(path)));
      label.title = path;
      row.appendChild(label);
      /* 语言 / 种类小徽标：只做提示，不参与任何判定 */
      if (opts.variant) {
        const info = variantInfo(n, path);
        if (info.label) row.appendChild(el("span", "rs-tree-chip", info.label));
        if (info.lang && info.lang !== info.kind) row.appendChild(el("span", "rs-tree-chip lang", info.lang));
      }
      const badge = ctx.noteBadge ? ctx.noteBadge(n) : null;
      if (badge) row.appendChild(badge);
      /* 四态（与阅读区平铺条同一份判据）：
         diverged = 有基线且当前字节与基线不一致 → 金色呼吸灯（被改过，待扩散）；
         stale    = 同组有人 diverged、这一份还没跟上 → 橙；
         absent   = 没有基线（旧稿 / 外部放进来的稿）→ 青（只有衍生物行标，原文行不涂色）；
         读不到字节 → 不上色。灰（未生成）在树上不出现：树只列盘上有的文件。 */
      const st = statusOf(path);
      if (st === "diverged") row.classList.add("is-diverged");
      else if (st === "stale") row.classList.add("is-stale");
      else if (st === "absent" && opts.variant) row.classList.add("is-nobase");
      const cur = normRel(S.curPath || "");
      if (cur === path || (!cur && opts.root)) row.classList.add("on");
      /* 多选描边：与 .on 并存（选中集合在 RS 里，重画后照样画回来） */
      if (isMulti(path)) row.classList.add("is-multi");
      rowOrder.push(path);
      row.onclick = function (ev) {
        const e = ev || {};
        /* Ctrl / Cmd：追加或取消这一行（不打开，不换 curPath） */
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          toggleMulti(path);
          return;
        }
        /* Shift：从锚点连选一整段 */
        if (e.shiftKey) {
          e.preventDefault();
          rangeMulti(path);
          return;
        }
        /* 普通点击 = 单选：先把手上的多选清掉，再打开这一篇 */
        if (multiList().length) {
          setMulti([]);
          paint();
        }
        if (ctx.openNote) ctx.openNote(path);
      };
      row.oncontextmenu = function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        openMenu(ev, {
          kind: "note",
          path: path,
          title: String(n.title || stripExt(path)),
          depth: opts.root ? 0 : depth,
        });
      };
      parent.appendChild(row);
      if (open) {
        for (let i = 0; i < vars.length; i++) parent.appendChild(variantRow(vars[i], depth + 1));
      }
    }

    function appendFold(parent, f) {
      const S = ctx.state || {};
      const path = normRel(f.path);
      const row = el("div", "rs-tree-row");
      row.style.paddingLeft = 20 + "px";
      row.appendChild(caret(false, false, null));
      row.appendChild(labelEl(String(f.title || stripExt(path))));
      row.appendChild(el("span", "rs-tree-count", String(f.count || 0)));
      row.title = path;
      if (normRel(S.curPath || "") === path) row.classList.add("on");
      row.onclick = function () {
        if (ctx.openFold) ctx.openFold(path);
      };
      row.oncontextmenu = function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        openMenu(ev, {
          kind: "fold",
          path: path,
          title: String(f.title || stripExt(path)),
          depth: 1,
        });
      };
      parent.appendChild(row);
    }

    /* ── 原件行（只读）──
       点一下打开原件：.pdf 由宿主交应用内只读翻页浮层，其它类型交系统默认程序；
       这里**不写盘、不打开成笔记**。右键只有「在文件夹中显示」——
       没有重命名 / 删除 / 编辑 / 派生：原件不是笔记，改了也不该由这棵树改。 */
    function appendOriginal(parent, o) {
      const path = normRel(o.path);
      const dot = path.lastIndexOf(".");
      const ext = String(o.ext || (dot >= 0 ? path.slice(dot) : "")).replace(/^\./, "").toLowerCase();
      const row = el("div", "rs-tree-row file");
      row.style.paddingLeft = 8 + 12 + "px";
      row.setAttribute("role", "treeitem");
      row.appendChild(caret(false, false, null));
      const lock = el("span", "rs-tree-lock", "🔒");
      lock.title = t("原件只读，不随编辑改动");
      lock.setAttribute("aria-hidden", "true");
      row.appendChild(lock);
      const label = labelEl(String(o.name || path.slice(path.lastIndexOf("/") + 1)));
      label.title = path + "\n" + t("原件只读，不随编辑改动");
      row.appendChild(label);
      if (ext) row.appendChild(el("span", "rs-tree-chip ext", ext.toUpperCase()));
      row.title = t("打开原件（只读，不随编辑改动）：") + path;
      row.onclick = function (ev) {
        const e = ev || {};
        e.preventDefault();
        e.stopPropagation();
        /* 原件不参与多选：先把手上的多选清掉，避免「选了笔记却点了原件」的错觉 */
        if (multiList().length) {
          setMulti([]);
          paint();
        }
        if (ctx.openOriginal) ctx.openOriginal(path);
      };
      row.oncontextmenu = function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        openMenu(ev, { kind: "file", path: path, title: String(o.name || path) });
      };
      parent.appendChild(row);
    }

    /* ── 画树（只画原文）──
       「核心」页的列表只剩原文（core/*.md）这一组：索引根 / 衍生物 / 折叠三组已从这里移除，
       列表上面只有「＋ 创建原文」一颗按钮（见 app-research.js 的 renderSide）。
       点开一篇原文仍可在它下面看到自己那一组变体（appendNote 的 variants）。 */
    function paint() {
      if (!box) return;
      wireKeys();
      /* 金色要等 research/versions.json 读进来才判得出：先画（绿），读完再补一次金色 */
      ensureVersions();
      /* 选中集合跟着数据走：笔记被删 / 改名后失效的路径不能留在集合里 */
      const known = Object.create(null);
      const allNotes = (ctx.state && ctx.state.notes) || [];
      for (let i = 0; i < allNotes.length; i++) known[normRel(allNotes[i].path)] = 1;
      const alive = multiList().filter(function (p) {
        return !!known[p];
      });
      if (alive.length !== multiList().length) setMulti(alive);
      rowOrder = [];
      const keep = box.scrollTop;
      box.innerHTML = "";
      const M = model();
      const originals = M.originals;
      const files = M.files;

      /* 原件（core/ 与 literature/sources/ 里的非 md 文件）：只读入口，锁形图标 + 悬停说明 */
      box.appendChild(
        groupHead("grp:file", t("原件"), files.length, false, files.length > 0, {
          icon: "🔒",
          title: t("原件只读，不随编辑改动"),
        }),
      );
      if (!isCollapsed("grp:file", false)) {
        if (!files.length) {
          box.appendChild(el("div", "rs-tree-empty", t("（core/ 与 literature/sources/ 里还没有原件）")));
        }
        for (let i = 0; i < files.length; i++) appendOriginal(box, files[i]);
      }

      /* 原文（core/*.md） */
      box.appendChild(groupHead("grp:original", t("原文"), originals.length, false, originals.length > 0));
      if (!isCollapsed("grp:original", false)) {
        if (!originals.length) box.appendChild(el("div", "rs-tree-empty", t("（core/ 里还没有原文）")));
        for (let i = 0; i < originals.length; i++) appendNote(box, originals[i], 1, {});
      }

      /* 术语页（terms/*.md）：初始化从原文归纳出的概念 / 公式页，以及「引申」长出的下一层。
         它们既不是 core/ 的原文，也不是某篇的变体稿 —— 但必须是**能点开的一等页**
         （每页都能再引申、能派生变体、能进图谱），所以在这里单独成一组。
         位置放在原文之后：先读原文，再顺着概念往下钻。 */
      const terms = [];
      for (let i = 0; i < allNotes.length; i++) {
        if (/^terms\//i.test(normRel(allNotes[i].path))) terms.push(allNotes[i]);
      }
      box.appendChild(
        groupHead("grp:term", t("术语页"), terms.length, false, terms.length > 0, {
          icon: "◇",
          title: t("从原文归纳出的术语 / 公式页；每页底部可继续「引申」出下一层"),
        }),
      );
      if (!isCollapsed("grp:term", false)) {
        if (!terms.length) {
          box.appendChild(el("div", "rs-tree-empty", t("（还没有术语页：初始化时按原文自动归纳）")));
        }
        for (let i = 0; i < terms.length; i++) appendNote(box, terms[i], 1, {});
      }
      box.scrollTop = keep;
    }

    /* ── 右键菜单 ── */
    function closeMenu() {
      if (menu && menu.parentNode) menu.parentNode.removeChild(menu);
      menu = null;
    }
    function wireDoc() {
      if (wired) return;
      wired = true;
      document.addEventListener(
        "mousedown",
        function (ev) {
          if (menu && !menu.contains(ev.target)) closeMenu();
        },
        true,
      );
      document.addEventListener(
        "keydown",
        function (ev) {
          if (ev.key === "Escape") closeMenu();
        },
        true,
      );
      window.addEventListener("blur", closeMenu);
      document.addEventListener("scroll", closeMenu, true);
    }
    function openMenu(ev, info) {
      closeMenu();
      const m = el("div", "rs-tree-menu");
      const add = function (label, fn, cls) {
        const b = el("button", cls || null, label);
        b.type = "button";
        b.onclick = function (e2) {
          e2.preventDefault();
          e2.stopPropagation();
          closeMenu();
          Promise.resolve()
            .then(fn)
            .catch(function (err) {
              if (ctx.toast) ctx.toast(String((err && err.message) || err), "err");
            });
        };
        m.appendChild(b);
      };
      /* 变体（.skim / .concept / .tech 这一层）：只给「生成演示…」+「在文件管理器打开」。
         变体不是一篇独立的稿子（不能派生 / 删除 / 扩散），所以不复用原文那张全菜单。 */
      if (info.kind === "var") {
        if (ctx.slides && (!ctx.canSlides || ctx.canSlides())) {
          add(t("生成演示…"), function () {
            return ctx.slides(info.path);
          });
        }
        add(t("在文件管理器打开"), function () {
          return ctx.revealPath ? ctx.revealPath(info.path) : null;
        });
        placeMenu(m, ev);
        return;
      }
      /* 原件：只给「在文件夹中显示」一条 —— 重命名 / 删除 / 编辑 / 派生一律不给
         （原件只读，不随编辑改动；它不是笔记，也不是一个能派生的一稿） */
      if (info.kind === "file") {
        add(t("在文件夹中显示"), function () {
          return ctx.revealPath ? ctx.revealPath(info.path) : null;
        });
        placeMenu(m, ev);
        return;
      }
      /* 「生成所选变体」：右键的这一行在多选集合里 → 对整个集合；否则只对当前这一行。
         折叠文件是只读投影，不能派生（不在集合里时整条不出现）。 */
      const sel = (function () {
        const p = normRel(info.path);
        const list = multiList().slice();
        if (list.indexOf(p) >= 0) return list;
        return info.kind === "fold" ? [] : [p];
      })();
      if (sel.length) {
        add(t("生成所选变体") + (sel.length > 1 ? "（" + sel.length + t(" 篇）") : "…"), function () {
          return ctx.generateMany ? ctx.generateMany(sel) : null;
        });
      }
      /* 「生成演示…」：把核心稿与 3-Pass 变体排成一套可放映的页（编辑器 / 放映 / 导出 HTML）。
         只在有 core 稿件时出现 —— 判据由宿主给（ctx.canSlides），这里不自己猜。 */
      if (info.kind === "note" && ctx.slides && (!ctx.canSlides || ctx.canSlides())) {
        add(t("生成演示…"), function () {
          return ctx.slides(info.path);
        });
      }
      /* 「扩散到其他版本」：把这一版的正文推到同组其它版本（面板 / 写盘 / 基线在
         research-derive.js 的 openSpread，这里只负责入口；组里只有它自己时不出现） */
      if (info.kind === "note" && hasSiblings(info.path)) {
        add(t("扩散到其他版本…"), function () {
          return ctx.spread ? ctx.spread(info.path) : null;
        });
      }
      /* 被改过的那一版（金 = diverged）没有「还原」入口：冲突只在阅读区上方的
         「变体一致化」里解 —— 基准自动取改动量最大的那一版，这里不给第二条路 */
      /* 索引页（research.json 的 corePath，缺省 notes/00-课题.md）是这棵库的索引根：
         它不需要衍生物 —— 三条衍生入口（衍生一份 / 新建空衍生稿 / 导入为衍生稿）一律不出现 */
      const metaNow = (ctx.state && ctx.state.meta) || {};
      const coreNow = normRel(metaNow.corePath || "notes/00-课题.md");
      if (!coreNow || normRel(info.path) !== coreNow) {
        add(t("衍生一份…"), function () {
          return ctx.derive ? ctx.derive(info.path, "one") : null;
        });
        add(t("新建空衍生稿"), function () {
          return newDerived(info);
        });
        add(t("导入为衍生稿…"), function () {
          return ctx.deriveImport ? ctx.deriveImport(info.path) : null;
        });
      }      add(t("在文件管理器打开"), function () {
        return ctx.revealPath ? ctx.revealPath(info.path) : null;
      });
      add(
        t("删除"),
        function () {
          return removeItem(info);
        },
        "danger",
      );
      placeMenu(m, ev);
    }
    /* 菜单定位 + 挂到 body（点外部 / Esc / 滚动收起见 wireDoc） */
    function placeMenu(m, ev) {
      document.body.appendChild(m);
      menu = m;
      const w = m.offsetWidth || 170;
      const h = m.offsetHeight || 96;
      const x = Math.max(8, Math.min(ev.clientX, window.innerWidth - w - 8));
      const y = Math.max(8, Math.min(ev.clientY, window.innerHeight - h - 8));
      m.style.left = x + "px";
      m.style.top = y + "px";
      wireDoc();
    }

    /* ── 写操作（都经 app-research.js 的 API 落盘）── */
    async function fileExists(rel) {
      const abs = ctx.joinP(ctx.root(), rel);
      try {
        const r = await ctx.api.fileStat(abs);
        if (r && typeof r.ok === "boolean") return !!r.ok;
      } catch (_) {}
      try {
        const r2 = await ctx.api.fileReadText(abs);
        return !!(r2 && r2.exists);
      } catch (_) {
        return false;
      }
    }
    function slugify(s) {
      const C = ctx.C ? ctx.C() : null;
      if (C && typeof C.slugify === "function") {
        const v = C.slugify(s);
        if (v) return v;
      }
      return (
        String(s || "")
          .trim()
          .replace(/[\\/:*?"<>|\s]+/g, "-")
          .replace(/^-+|-+$/g, "") || "note"
      );
    }
    function stringifyFm(meta, body) {
      const C = ctx.C ? ctx.C() : null;
      if (C && typeof C.stringifyFrontmatter === "function") return C.stringifyFrontmatter(meta, body);
      const keys = Object.keys(meta);
      const head = ["---"].concat(
        keys.map(function (k) {
          const v = meta[k];
          return k + ": " + (Array.isArray(v) ? "[" + v.join(", ") + "]" : JSON.stringify(v));
        }),
      );
      return head.join("\n") + "\n---\n\n" + String(body || "").replace(/^\s*\n/, "");
    }
    function deleteCollapsed(key) {
      const meta = (ctx.state && ctx.state.meta) || {};
      const ui = Object.assign({}, meta.ui || {});
      const map = Object.assign({}, ui[UI_KEY] && typeof ui[UI_KEY] === "object" ? ui[UI_KEY] : {});
      if (!(key in map)) return;
      delete map[key];
      ui[UI_KEY] = map;
      if (ctx.saveMeta) ctx.saveMeta({ ui: ui });
    }
    /* 父笔记声明的语言：空衍生稿的 lang 跟着它走（没写就按中文库算） */
    function parentLang(path) {
      const key = normRel(path);
      const list = (ctx.state && ctx.state.notes) || [];
      for (let i = 0; i < list.length; i++) {
        if (normRel(list[i].path) !== key) continue;
        const v = list[i].meta && list[i].meta.lang;
        return String(v || "").trim() || "zh";
      }
      return "zh";
    }
    async function newDerived(info) {
      if (!ctx.root()) return;
      const def = t("未命名衍生稿");
      const ans = ctx.prompt ? await ctx.prompt(t("新衍生稿标题"), def) : null;
      if (ans == null) return;
      const name = String(ans).trim() || def;
      const slug = slugify(name);
      let rel = "notes/" + slug + ".md";
      let i = 2;
      while (await fileExists(rel)) {
        rel = "notes/" + slug + "-" + i + ".md";
        i++;
        if (i > 50) break;
      }
      const meta = {
        title: name,
        kind: "note",
        /* 与 research-core.js 的衍生物约定一致：子笔记记 parent（路径或标题都认） */
        parent: info.path,
        /* 空稿也带壳：derived 先记 draft（生成出来的会是 translate / summary / excerpt），
           lang 跟父笔记走 —— 三个键齐了，树上的层与图谱里的推导边才认得出它 */
        derived: "draft",
        lang: parentLang(info.path),
        tags: [],
        verify: "unverified",
        date: new Date().toISOString().slice(0, 10),
      };
      const md = stringifyFm(meta, "\n# " + name + "\n\n");
      await ctx.api.fileWriteText(ctx.joinP(ctx.root(), rel), md);
      /* 记一笔「新建笔记」：撤销时 rsUndo 按这个 kind 把新文件收进回收站 */
      if (ctx.logChange) await ctx.logChange(t("新建笔记"), rel, "", md);
      saveCollapsed("note:" + info.path, false);
      deleteCollapsed("grp:derived");
      if (ctx.reload) await ctx.reload();
      if (ctx.openNote) await ctx.openNote(rel);
      if (ctx.toast) ctx.toast(t("已新建 ") + rel);
    }
    async function removeItem(info) {
      const M = model();
      const path = normRel(info.path);
      if (info.kind === "note" && path === M.rootPath) {
        if (ctx.toast) ctx.toast(t("索引根不能删：它是这棵树的根"), "warn");
        return;
      }
      const abs = ctx.joinP(ctx.root(), path);
      let before = "";
      try {
        const r = await ctx.api.fileReadText(abs);
        before = r && r.exists ? String(r.content || "") : "";
      } catch (_) {}
      const ok = ctx.confirm
        ? await ctx.confirm(t("移到回收站：") + path + t("？"), { title: t("删除") })
        : true;
      if (!ok) return;
      await ctx.api.fileTrash(abs);
      if (ctx.logChange) await ctx.logChange(t("删除"), path, before, "");
      if (ctx.reload) await ctx.reload();
      /* 删掉的这一篇可能正是别的笔记里 [[标题]] 指着的目标：交给宿主判断链并提醒
         （树不认得全库的 wikilink，也不该自己弹对话框） */
      if (ctx.afterRemove) await ctx.afterRemove({ path: path, before: before });
      if (ctx.toast) ctx.toast(t("已移到回收站：") + path);
    }

    return {
      version: 1,
      /* 由 renderSide 调：host = 应用左栏的 #sideCore（研究视图「核心」页），本模块自己建 .rs-tree 容器 */
      render: function (nextHost) {
        if (nextHost) host = nextHost;
        if (!host) return;
        closeMenu();
        if (!box || !box.parentNode) {
          box = el("div", "rs-tree");
          box.setAttribute("role", "tree");
          /* 点空白（容器本身，不是任何一行）= 清空多选 */
          box.onclick = function (ev) {
            if (ev && ev.target === box) clearMulti();
          };
          host.appendChild(box);
        }
        paint();
        wireKeys();
      },
      /* 数据被外部重读（新建 / 删除 / reload）后重画 */
      repaint: paint,
      closeMenu: closeMenu,
    };
  }

  window.MTResearchTree = { create: create, version: 1 };
})();
