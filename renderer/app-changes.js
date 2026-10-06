/* ============================================================================
 * 会话 · 「改动」视图（renderer/app-changes.js + css/dsh-tokens.css 的 .dsh-chg-*）
 * ----------------------------------------------------------------------------
 * 需求（本模块的唯一职责）：会话头部的 View 标签从「对话 / 轨迹」扩成
 * 「对话 / 轨迹 / 改动」——「改动」这一栏列出**本会话对所有文件进行的所有改动**，
 * 每一项 = 一个被改过的文件（同一文件的多笔改动合并成一项，带「共 N 次」）；
 * 选中某一项后右侧自上而下列出该文件的**历次 diff 片段**，每一项都带时间。
 * 用途：用户回过头来核对「这个会话到底动了哪些文件、每一笔改了什么」。
 *
 * 数据来自哪里（不新增任何采集）：
 *   · 历史轮次 —— 每条助手消息的 m.tools（app-assist.js 的 agentRoundMsgTail 落盘，
 *     记录形状 {callId,turn,step,name,args,result,error,at}，at = 这次调用发起的时刻）；
 *   · 正在跑的这一轮 —— 会话对象上的 st._liveTools（形状同上）；
 *   · 轮号 —— 段快照里 tool 段的 round（app-db.js traceSegmentsOf 写）或
 *     app-assist.js 的 agentTraceRound("agent:<sid>")。
 *   三样都是会话本来就有的数据，重启后照样读得出来 —— 所以老会话切进来立刻就有内容。
 *
 * diff 只算一次、只写一处：
 *   · 判据与行级算法在 app-assist.js，经 window.MTNodeChatDiff 挂出来（全仓唯一一处：
 *     of / el = 对话与轨迹的原口径；ofFull / elFull = 本栏口径，**不看 30 万字符上限**，
 *     折叠阈值 240 行、每批 200 行由本文件传进去）；
 *   · 本文件**不重写**任何 diff 算法与皮肤，只负责「收 → 合并 → 摆位置 → 分批续画」。
 *
 * 口径（用户逐条定过，别再自行发挥）：
 *   · 常显，不受「设置 · 开发者工具」开关影响（它只是回看清单，不给参数 / 结果明细）；
 *   · 默认不选中：右侧置空并提示「左侧选一个文件」；
 *   · 左侧一行：时间（最新一笔的绝对时刻，同一天省日期）· **项目根相对路径**（超长在
 *     中间省略、文件名整段留着；悬停看全路径）· ±行数 · 共 N 次；
 *   · 右侧每笔一块：小抬头（时刻 · 轮次 · ±行数 · 工具）+ 与对话同款的 .dsh-diff 块；
 *   · 空态：左侧一句「本次会话还没有文件改动」，右侧留空。
 *
 * 本次需求（用户逐条点名的两条，别再改回去）：
 *   · **左栏占主体宽度、中缝可拖**：默认 52%（`--dsh-chg-list-w` 不给时由 CSS 兜底），
 *     夹在 220px 与宿主宽 80% 之间，双击中缝复位到默认占比；拖过的宽度只写本机
 *     localStorage 一条（mtnode.chgListW），数据不落应用目录（与轨迹检查器
 *     mtnode.traceInspW、文件预览栏 mtnode.baW 同一口径）。
 *   · **滚动不再被顶回顶端**：会话在跑时 renderAgentSession 每来一帧就 sync 一次
 *     （app-assist.js 末尾 → MTNodeTrajectory.sync → renderChanges → mount），过去每次
 *     mount 都整块重建 DOM —— 用户往下滚的 diff 被一次次顶回顶端。现在按「会话 + 各组
 *     （路径 · 笔数 · 最新时刻）」算一条渲染签名：签名没变就一个节点都不动；真要重建
 *     （真有新改动）时也把左栏与右栏的滚动位置原样接回来。
 *
 * 自包含：不引框架，不碰 app-trajectory.js 的轨迹内部与 app-assist.js 的渲染；
 * 出口 window.MTNodeChanges（只读渲染 + 一个 mount 入口，见文件末尾）。
 * ========================================================================== */
(function () {
  "use strict";

  var T = function (s) {
    try {
      if (typeof I18n !== "undefined" && I18n && typeof I18n.t === "function") return I18n.t(s);
    } catch (_) {
      /* 拿不到词条就走原文 */
    }
    return String(s);
  };
  /* 带占位符的词条：{a} / {r} / {n} 逐个替换 */
  function Tf(s, p) {
    var t = String(T(s));
    if (!p) return t;
    for (var k in p)
      if (Object.prototype.hasOwnProperty.call(p, k))
        t = t.split("{" + k + "}").join(String(p[k]));
    return t;
  }

  /* 折叠阈值 / 首屏与每批行数（用户口径：折叠 240 行、首屏 200 行、滚到底再续 200 行） */
  var CHG_FOLD_ROWS = 240;
  var CHG_BATCH_ROWS = 200;
  /* 滚到离底这么多像素就续画一批 */
  var CHG_SCROLL_NEAR = 120;
  /* 左侧列表的路径锚点：太长时以项目根相对路径为锚做中间省略 */
  var CHG_ROOT_HINT = "pipeline-console";
  /* 左栏宽度（本次需求「左侧占主体、中间可调」）：默认占比 / 下限 / 上限占比 / 落盘键。
     落盘只写本机 localStorage —— 与轨迹检查器（mtnode.traceInspW）、文件预览栏
     （mtnode.baW）同一口径：数据不落应用目录。 */
  var CHG_LIST_W_LS = "mtnode.chgListW";
  var CHG_LIST_W_RATIO = 0.52;
  var CHG_LIST_W_MIN = 220;
  var CHG_LIST_W_MAX_RATIO = 0.8;
  /* 一行里除路径之外的宽度（时刻 50 + ±行数 57 + 共 N 次 55 + 三个 8px 列距 + 左右内边距
     ≈ 202px，取 210 留一点余量）：只在折算「能放几个字」时用一次经验值，宁可估大一点 ——
     宁可早一个字符省，也不要让 CSS 的尾部省略把文件名切掉。 */
  var CHG_ROW_CHROME = 210;

  /* ── 数据层 ─────────────────────────────────────────────────────────────── */

  function sessionsList() {
    try {
      if (typeof agentSessions === "function") return agentSessions() || [];
    } catch (_) {
      /* 回落下面那条 */
    }
    try {
      return typeof S !== "undefined" && S && Array.isArray(S.agentSessions)
        ? S.agentSessions
        : [];
    } catch (_) {
      return [];
    }
  }
  function sessionOf(sid) {
    var id = String(sid || "");
    if (!id) return null;
    try {
      if (typeof agentSessionById === "function") {
        var st = agentSessionById(id);
        if (st) return st;
      }
    } catch (_) {
      /* 回落 */
    }
    var list = sessionsList();
    for (var i = 0; i < list.length; i++) if (list[i] && String(list[i].id) === id) return list[i];
    return null;
  }
  function traceRoundOf(sid) {
    try {
      if (typeof agentTraceRound === "function") return agentTraceRound("agent:" + sid);
    } catch (_) {
      /* 拿不到就不编号 */
    }
    return null;
  }

  /* 本会话的工具调用记录（历史 + 正在跑的这一轮），已去重、已配轮号。
     返回 [{rec, round}]（rec 形状 = 存档里的工具记录，含 name / args / at）。 */
  function collectToolRecords(sid) {
    var st = sessionOf(sid);
    if (!st) return [];
    var out = [];
    var seen = {};
    var roundByCall = {};
    /* 第一遍：历史消息里的工具清单 + 段快照上的轮号（callId → 第 N 轮） */
    var msgs = Array.isArray(st.messages) ? st.messages : [];
    var idx = 0;
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      if (!m || m.role !== "assistant") continue;
      idx++;
      var segs = Array.isArray(m.segments)
        ? m.segments
        : Array.isArray(m._segs)
          ? m._segs
          : null;
      if (segs) {
        for (var s = 0; s < segs.length; s++) {
          var sg = segs[s];
          if (!sg || sg.k !== "tool" || !sg.callId) continue;
          if (sg.round != null) roundByCall[String(sg.callId)] = Number(sg.round);
        }
      }
      var list = Array.isArray(m.tools) ? m.tools : [];
      for (var j = 0; j < list.length; j++) {
        var t = list[j];
        if (!t || !t.callId || seen[String(t.callId)]) continue;
        seen[String(t.callId)] = 1;
        out.push({
          rec: t,
          round: roundByCall[String(t.callId)] != null ? roundByCall[String(t.callId)] : idx,
        });
      }
    }
    /* 第二遍：正在跑的这一轮（还没收尾落盘的那批）—— 轮号取本会话本条轨迹上的号 */
    var live = Array.isArray(st._liveTools) ? st._liveTools : [];
    var liveRound = traceRoundOf(sid);
    for (var k = 0; k < live.length; k++) {
      var lv = live[k];
      if (!lv || !lv.callId || seen[String(lv.callId)]) continue;
      seen[String(lv.callId)] = 1;
      out.push({ rec: lv, round: liveRound });
    }
    return out;
  }

  /* 是不是「看得见文件改动」的工具调用：判据**只在 app-assist.js 那一处**（dshDiffPartsOf
     经过 window.MTNodeChatDiff 暴露的 of / ofFull 间接体现）——本文件不看工具名单，
     免得两边名单走神。这里只做一件事：问一次「这次调用有没有 diff」。 */
  function diffOfFull(rec) {
    try {
      var api = typeof window !== "undefined" ? window.MTNodeChatDiff : null;
      if (!api) return null;
      if (typeof api.ofFull === "function") return api.ofFull(rec) || null;
      /* 老壳（还没挂 ofFull）：退回对话口径（有字符上限），至少不是空白 */
      if (typeof api.of === "function") return api.of(rec) || null;
    } catch (_) {
      /* 抽不到就当这次调用看不到改动 */
    }
    return null;
  }
  function diffElOf(diff) {
    try {
      var api = typeof window !== "undefined" ? window.MTNodeChatDiff : null;
      if (!api) return null;
      var opts = { foldCap: CHG_FOLD_ROWS, rowsLimit: CHG_BATCH_ROWS, batchRows: CHG_BATCH_ROWS };
      if (typeof api.elFull === "function") return api.elFull(diff, opts) || null;
      if (typeof api.el === "function") return api.el(diff) || null;
    } catch (_) {
      /* 画不出来就不画（其余内容照常给） */
    }
    return null;
  }

  /* 本会话的全部改动 → 按文件合并成项（最新一笔在最上面）。
     返回 [{path, times, added, removed, rounds, items:[{at,round,step,name,added,removed,diff}]}] */
  function collectGroups(sid) {
    var recs = collectToolRecords(sid);
    var byPath = {};
    var order = [];
    for (var i = 0; i < recs.length; i++) {
      var rec = recs[i].rec;
      var diff = diffOfFull(rec);
      if (!diff || !diff.rows || !diff.rows.length) continue;
      var path = String(diff.path || "");
      if (!path) continue;
      var g = byPath[path];
      if (!g) {
        g = byPath[path] = { path: path, items: [], added: 0, removed: 0 };
        order.push(g);
      }
      var at = Number(rec.at) || 0;
      g.items.push({
        at: at,
        round: recs[i].round == null ? null : Number(recs[i].round),
        step: rec.step == null ? null : rec.step,
        name: String(rec.name || ""),
        added: Number(diff.added) || 0,
        removed: Number(diff.removed) || 0,
        diff: diff,
      });
      g.added += Number(diff.added) || 0;
      g.removed += Number(diff.removed) || 0;
    }
    /* 组内按时间升序（右侧是「历次」的读法），组间按最新一笔降序（最相关的最上面） */
    for (var a = 0; a < order.length; a++) {
      order[a].items.sort(function (x, y) {
        return (x.at || 0) - (y.at || 0);
      });
      var last = order[a].items[order[a].items.length - 1];
      order[a].lastAt = last ? last.at : 0;
      order[a].count = order[a].items.length;
    }
    order.sort(function (x, y) {
      return (y.lastAt || 0) - (x.lastAt || 0);
    });
    return order;
  }

  /* ── 时间与路径的显示口径 ───────────────────────────────────────────────── */

  function pad2(n) {
    return String(n).padStart(2, "0");
  }
  function clockOf(ms) {
    var t = Number(ms) || 0;
    if (!t) return "";
    try {
      if (typeof fmtTime === "function") return fmtTime(t);
    } catch (_) {
      /* 回落本地时间 */
    }
    var d = new Date(t);
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
  }
  function dayStart(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }
  /* 绝对时刻 + 日期，同一天省日期（用户口径）；跨天带 M-D，昨天写「昨天」 */
  function stampOf(ms) {
    var t = Number(ms) || 0;
    if (!t) return "";
    var d = new Date(t);
    var now = new Date();
    var day = dayStart(d);
    var today = dayStart(now);
    var clock = clockOf(t);
    if (day === today) return clock;
    if (day === today - 86400000) return Tf("昨天 {t}", { t: clock });
    return d.getMonth() + 1 + "-" + d.getDate() + " " + clock;
  }
  /* 项目根相对路径（拿不到就没有，绝不编一个）：优先按**会话的生效工作区**（与运行时同一
     口径 agentRunWorkspace）剥前缀 —— 换到别的项目目录照样显示相对路径；工作区取不到才
     退回落在本机路径里的项目名（CHG_ROOT_HINT）那一段。 */
  function rootOf(sid) {
    try {
      var st = sessionOf(sid);
      if (st && typeof agentRunWorkspace === "function") {
        var ws = String(agentRunWorkspace(st) || "").trim();
        if (ws) return ws;
      }
    } catch (_) {
      /* 取不到就退回下面那条 */
    }
    return "";
  }
  function relPathOf(p, root) {
    var s = String(p || "");
    var r = String(root || "").replace(/[\\/]+$/, "");
    if (r && s.length > r.length && s.slice(0, r.length).toLowerCase() === r.toLowerCase()) {
      var tail = s.slice(r.length).replace(/^[\\/]+/, "");
      if (tail) return tail;
    }
    var i = s.lastIndexOf(CHG_ROOT_HINT);
    if (i < 0) return s;
    var t2 = s.slice(i + CHG_ROOT_HINT.length);
    return t2.replace(/^[\\/]+/, "") || s;
  }
  function baseNameOf(p) {
    var s = String(p || "");
    var i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    return i >= 0 ? s.slice(i + 1) : s;
  }
  function dirOf(p) {
    var s = String(p || "");
    var i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    return i > 0 ? s.slice(0, i) : "";
  }
  function deltaText(added, removed) {
    var a = Number(added) || 0;
    var r = Number(removed) || 0;
    return "+" + a + " −" + r;
  }
  /* 超长中间省略（本次需求）：文件名整段留在尾部（它才是这一行要认人的部分），
     前面按剩下的字符预算给路径开头，中间一个「…」；预算连文件名都放不下时才截文件名
     自己的尾巴，预算只够放文件名就整个省掉目录（不留一个空头的「…/」）。 */
  function midEllipsis(p, budget) {
    var s = String(p || "");
    var n = Math.floor(Number(budget) || 0);
    if (n <= 0 || s.length <= n) return s;
    if (n <= 1) return "…";
    var base = baseNameOf(s);
    if (base.length > n) return base.slice(0, n - 1) + "…";
    var headLen = n - base.length - 1;
    if (headLen <= 0) return base;
    return s.slice(0, headLen) + "…" + base;
  }
  /* 工具名 → 中文标签（唯一真源在 app-assist.js 的 dshToolTitleOf；抽不到就退回原名） */
  function toolLabelOf(name) {
    try {
      if (typeof dshToolTitleOf === "function") {
        var s = dshToolTitleOf({ name: name });
        if (s) return s;
      }
    } catch (_) {
      /* 退回原名 */
    }
    return String(name || "");
  }

  /* ── 左栏宽度（本次需求「左侧占主体、中间可调」）────────────────────────────
     宽度只写 .dsh-chg-cols 的 CSS 变量 --dsh-chg-list-w（样式表里 .dsh-chg-list 读它，
     缺省 52%）；拖动中每帧只改 DOM，松手那一次才落盘。总宽量不到（无布局 / 迷你 DOM）
     就不夹上限，由调用方传进来的宽兜底 —— 绝不因此抛错（冒烟与老壳都要跑得通）。 */
  var listW = 0; /* 当前宽度（px）；0 = 还没定过，用默认占比 */
  var splitDrag = null;

  function boxesW(el) {
    if (!el) return 0;
    try {
      if (typeof el.getBoundingClientRect === "function") {
        var w = Number(el.getBoundingClientRect().width) || 0;
        if (w) return w;
      }
    } catch (_) {
      /* 量不到走下面两条 */
    }
    var n = Number(el.clientWidth || el.offsetWidth) || 0;
    return n > 0 ? n : 0;
  }
  function clampListW(w, hostW) {
    var h = Number(hostW) || 0;
    var cap = h > 0 ? Math.max(CHG_LIST_W_MIN, Math.floor(h * CHG_LIST_W_MAX_RATIO)) : 0;
    var n = Math.round(Number(w) || 0);
    if (n < CHG_LIST_W_MIN) n = CHG_LIST_W_MIN;
    if (cap > 0 && n > cap) n = cap;
    return n;
  }
  function listWStore(w) {
    try {
      if (typeof localStorage !== "undefined" && localStorage)
        localStorage.setItem(CHG_LIST_W_LS, String(Math.round(w)));
    } catch (_) {
      /* 无 localStorage（隐私模式 / 冒烟沙箱）：这次拖的宽度照用，只是不记忆 */
    }
  }
  function listWLoad() {
    try {
      if (typeof localStorage === "undefined" || !localStorage) return;
      var v = Number(localStorage.getItem(CHG_LIST_W_LS));
      if (v > 0) listW = v;
    } catch (_) {
      /* 读不到就沿用默认占比 */
    }
  }
  /* 落到 DOM 上：persist = 松手 / 双击那一次才落盘（拖动中每帧只改变量）。
     w <= 0（没有记住过的宽度、也量不到宿主宽）就**什么都不设** —— CSS 里那档 52% 兜底，
     绝不把「量不到」当成「220px」写死。 */
  function applyListW(cols, w, persist) {
    if (!cols) return listW;
    var n = Math.round(Number(w) || 0);
    if (n <= 0) return listW;
    listW = clampListW(n, boxesW(cols));
    try {
      if (cols.style && typeof cols.style.setProperty === "function")
        cols.style.setProperty("--dsh-chg-list-w", listW + "px");
    } catch (_) {
      /* 无 style 的迷你 DOM：跳过（断言读 listW） */
    }
    if (persist) listWStore(listW);
    return listW;
  }
  /* 每行路径的字符预算：等宽字体下按左栏实测宽度折算（量不到回 0 = 不截，交给 CSS 兜底）。 */
  function charWidthIn(list) {
    if (!list || typeof document === "undefined" || !document.createElement) return 0;
    try {
      var probe = document.createElement("span");
      probe.className = "dsh-chg-probe";
      probe.textContent = "0000000000";
      list.appendChild(probe);
      var w = boxesW(probe);
      if (list.removeChild) list.removeChild(probe);
      return w > 0 ? w / 10 : 0;
    } catch (_) {
      return 0;
    }
  }
  function nameBudget(list) {
    var w = boxesW(list);
    if (!w) return 0;
    var cw = charWidthIn(list);
    if (!cw) return 0;
    return Math.max(10, Math.floor((w - CHG_ROW_CHROME) / cw));
  }
  /* 按预算重写每一行的路径（拖动中缝 / 重建后都走它，不重建 DOM）。 */
  function applyNameBudget(host, list) {
    if (!host || !list) return 0;
    var budget = nameBudget(list);
    var rows = host.querySelectorAll ? host.querySelectorAll(".dsh-chg-row") : [];
    for (var i = 0; i < rows.length; i++) {
      var el = rows[i].querySelector ? rows[i].querySelector(".dsh-chg-row-name") : null;
      if (!el) continue;
      var rel = relPathOf(rows[i].dataset ? rows[i].dataset.path : "", host._chgRoot);
      el.textContent = midEllipsis(rel, budget);
    }
    return budget;
  }
  /* 中缝拖动：与轨迹检查器的分隔条同一套读法（拖动中不落盘、松手 / 双击才落一次）。 */
  function splitMoveEnd() {
    if (!splitDrag) return;
    splitDrag = null;
    try {
      if (typeof document !== "undefined" && document.removeEventListener) {
        document.removeEventListener("mousemove", splitMove);
        document.removeEventListener("mouseup", splitMoveEnd);
      }
    } catch (_) {
      /* 摘不掉也留着（下一次拖动会覆盖） */
    }
    try {
      if (document.body && document.body.classList)
        document.body.classList.remove("dsh-chg-dragging");
    } catch (_) {
      /* 无 body 的迷你 DOM */
    }
  }
  function splitMove(ev) {
    var d = splitDrag;
    if (!d) return;
    var x = Number(ev && ev.clientX);
    if (!x && x !== 0) return;
    var next = d.w + (x - d.x);
    var w = applyListW(d.cols, next, false);
    if (d.onResize) d.onResize(w);
  }
  function bindSplit(split, cols, host, list) {
    if (!split || !split.addEventListener) return;
    split.addEventListener("mousedown", function (ev) {
      if (ev && ev.preventDefault) ev.preventDefault();
      if (ev && ev.stopPropagation) ev.stopPropagation();
      splitDrag = {
        x: Number(ev && ev.clientX) || 0,
        w: listW || boxesW(list) || 0,
        cols: cols,
        onResize: function () {
          applyNameBudget(host, list);
        },
      };
      try {
        if (document.body && document.body.classList)
          document.body.classList.add("dsh-chg-dragging");
      } catch (_) {
        /* 无 body 的迷你 DOM */
      }
      try {
        if (typeof document !== "undefined" && document.addEventListener) {
          document.addEventListener("mousemove", splitMove);
          document.addEventListener("mouseup", splitMoveEnd);
        }
      } catch (_) {
        /* 挂不上就只保留点击不拖（模态 DOM） */
      }
    });
    /* 双击中缝复位：回到默认占比（占主体那档），并把这次的宽度落盘 */
    split.addEventListener("dblclick", function (ev) {
      if (ev && ev.preventDefault) ev.preventDefault();
      if (ev && ev.stopPropagation) ev.stopPropagation();
      var hostW = boxesW(cols);
      var def = hostW > 0 ? Math.round(hostW * CHG_LIST_W_RATIO) : CHG_LIST_W_MIN;
      applyListW(cols, def, true);
      applyNameBudget(host, list);
    });
  }

  /* ── 视图层 ─────────────────────────────────────────────────────────────── */

  /* 左栏选中态：按会话记（不落盘 —— 每次进「改动」栏都从「未选中」开始，用户口径）。
     切会话即清，绝不把 A 会话选的文件带到 B 会话。 */
  var pickedBySid = {};

  function mkEl(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = String(text);
    return el;
  }
  function clearEl(el) {
    if (el) el.textContent = "";
  }

  /* 左栏一行：时刻 · 项目根相对路径 · ±行数 · 共 N 次
     （路径先按整名放进去，随后由 applyNameBudget 按左栏实测宽度做中间省略） */
  function listRow(group, on, root) {
    var row = mkEl("button", "dsh-chg-row" + (on ? " on" : ""));
    row.type = "button";
    row.dataset.path = group.path;
    row.title = relPathOf(group.path, root);
    row.appendChild(mkEl("span", "dsh-chg-row-time", stampOf(group.lastAt)));
    row.appendChild(mkEl("span", "dsh-chg-row-name", relPathOf(group.path, root)));
    row.appendChild(mkEl("span", "dsh-chg-row-stat", deltaText(group.added, group.removed)));
    row.appendChild(mkEl("span", "dsh-chg-row-count", Tf("共 {n} 次", { n: group.count })));
    return row;
  }

  /* 右侧一笔：小抬头（时刻 · ±行数 · 工具 · 第 N 轮）+ 与对话同款的 diff 块 */
  function diffCard(item) {
    var card = mkEl("div", "dsh-chg-card");
    var head = mkEl("div", "dsh-chg-card-head");
    head.appendChild(mkEl("span", "dsh-chg-card-time", stampOf(item.at)));
    if (item.round != null && Number(item.round) > 0)
      head.appendChild(mkEl("span", "dsh-chg-card-round", Tf("第 {n} 轮", { n: item.round })));
    head.appendChild(mkEl("span", "dsh-chg-card-stat", deltaText(item.added, item.removed)));
    var nm = mkEl("span", "dsh-chg-card-tool", toolLabelOf(item.name));
    if (item.name) nm.title = String(item.name);
    head.appendChild(nm);
    card.appendChild(head);
    var el = diffElOf(item.diff);
    if (el) card.appendChild(el);
    return card;
  }

  /* 已挂上的、还能再续画几行的 diff 块（滚到底时按顺序各续一批） */
  function diffBlocksIn(root) {
    var out = [];
    if (!root) return out;
    var all = root.querySelectorAll ? root.querySelectorAll(".dsh-diff") : [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el && typeof el._diffMoreRows === "function") out.push(el);
    }
    return out;
  }
  /* 滚到底自动再续一批（本次需求）：本栏把 .dsh-diff-body 的 max-height 放开了，滚动落在
     **本视图自己的滚动容器**上 —— 所以在容器上监听，把容器里所有还能续画的 diff 块各续
     一批（每块自己的 _diffMoreRows() 会判断还能不能续）。对话 / 轨迹那两处是块内滚，
     它们的续画由各自那一层负责，本函数不掺和。 */
  function bindScrollMore(host, box) {
    if (!box || !box.addEventListener) return;
    box.addEventListener("scroll", function () {
      var near = false;
      try {
        near = box.scrollHeight - box.scrollTop - box.clientHeight <= CHG_SCROLL_NEAR;
      } catch (_) {
        return;
      }
      if (!near) return;
      var blocks = diffBlocksIn(host);
      for (var n = 0; n < blocks.length; n++) blocks[n]._diffMoreRows();
    });
  }

  /* 渲染签名（本次修的 bug）：会话 + 每一组（路径 · 笔数 · 最新时刻）。这一串相同 ⟹
     画出来的东西一模一样。会话在跑时 renderAgentSession 每来一帧就 sync 一次 → 每次都
     mount 一次；签名用来跳过整块重建，用户往下滚的 diff 才不会被一次次顶回顶端。 */
  function groupsSig(sid, groups) {
    var parts = [];
    for (var i = 0; i < groups.length; i++)
      parts.push(groups[i].path + "#" + groups[i].count + "#" + (groups[i].lastAt || 0));
    return String(sid || "") + "|" + parts.join("|");
  }

  /* 空态 / 未选中态：两侧各一句，信息量最小（用户口径：不写引导长文）。
     重建时把两栏的滚动位置接回来（pick = 要保住的滚动位置，只有「同一次选中被重建」
     才接 —— 换文件读的是另一份内容，理应从顶端看起）。 */
  function render(host, sid, groupsIn) {
    if (!host) return;
    var keepListTop = host._chgList ? Number(host._chgList.scrollTop) || 0 : 0;
    var keepPaneTop = host._chgScroll ? Number(host._chgScroll.scrollTop) || 0 : 0;
    var hadPane = !!host._chgScroll;
    clearEl(host);
    host._chgScroll = null;
    host._chgPane = null;
    host._chgList = null;
    var groups = groupsIn || collectGroups(sid);
    var list = mkEl("div", "dsh-chg-list");
    var split = mkEl("div", "dsh-chg-split");
    split.title = T("拖动调整左栏宽度（双击复位）");
    if (split.setAttribute) split.setAttribute("role", "separator");
    var pane = mkEl("div", "dsh-chg-pane");
    var cols = mkEl("div", "dsh-chg-cols");
    cols.appendChild(list);
    cols.appendChild(split);
    cols.appendChild(pane);
    host.appendChild(cols);
    host._chgPane = pane;
    host._chgList = list;
    host._chgGroups = groups;
    host._chgRoot = rootOf(sid);
    host._chgSig = groupsSig(sid, groups);
    host.dataset.chgGroups = String(groups.length);
    /* 左栏宽度：拖过 / 落过盘的按那一档来；没有记住过就按宿主宽算默认占比（占主体）。
       两者都量不到（无布局）时一个数都不设 —— 交给 CSS 那档 52% 兜底。 */
    if (!listW) listWLoad();
    var hostW = boxesW(cols);
    applyListW(cols, listW || (hostW > 0 ? Math.round(hostW * CHG_LIST_W_RATIO) : 0), false);
    bindSplit(split, cols, host, list);

    var empty = groups.length ? "" : T("本次会话还没有文件改动");
    host.dataset.chgEmpty = empty;
    if (!groups.length) {
      var e = mkEl("div", "dsh-chg-empty", empty);
      list.appendChild(e);
      var pe = mkEl("div", "dsh-chg-pane-empty", T("左侧选一个文件"));
      pane.appendChild(pe);
      host.dataset.chgPicked = "";
      return;
    }

    var picked = pickedBySid[String(sid)] || "";
    var hit = null;
    for (var i = 0; i < groups.length; i++) if (groups[i].path === picked) hit = groups[i];

    for (var j = 0; j < groups.length; j++) {
      var g = groups[j];
      var on = !!hit && hit.path === g.path;
      var row = listRow(g, on, host._chgRoot);
      row.addEventListener("mousedown", function (ev) {
        ev.stopPropagation();
      });
      row.addEventListener("click", function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        var p = String(this.dataset.path || "");
        pickedBySid[String(sid)] = p;
        paintPane(host, sid, p, 0);
        syncRows(host, p);
      });
      list.appendChild(row);
    }
    paintPane(host, sid, hit ? hit.path : "", hadPane ? keepPaneTop : 0);
    /* 路径的中间省略要按左栏实测宽度折算：首帧刚显形量不到宽（回 0）就下一帧再截一次，
       别让 CSS 的尾部省略把最要紧的文件名切掉。 */
    if (!applyNameBudget(host, list)) {
      try {
        if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
          var hostRef = host;
          window.requestAnimationFrame(function () {
            if (hostRef._chgList === list) applyNameBudget(hostRef, list);
          });
        }
      } catch (_) {
        /* 没有 rAF（迷你 DOM）：不截就不截，CSS 兜底 */
      }
    }
    if (keepListTop) {
      try {
        list.scrollTop = keepListTop;
      } catch (_) {
        /* 无布局的迷你 DOM：跳过 */
      }
    }
  }

  /* 换选中：只重画右侧（列表几十行不必整块重建）。
     keepTop > 0 = 这一次重建要把右栏的滚动位置接回来（同一次选中被整块重建的情形）；
     换文件时传 0 —— 读的是另一份内容，从顶端看起。 */
  function paintPane(host, sid, path, keepTop) {
    if (!host) return;
    var pane = host._chgPane;
    if (!pane) return;
    clearEl(pane);
    host._chgScroll = null;
    host.dataset.chgPicked = String(path || "");
    var groups = host._chgGroups || [];
    var hit = null;
    for (var i = 0; i < groups.length; i++) if (groups[i].path === path) hit = groups[i];
    if (!hit) {
      pane.appendChild(mkEl("div", "dsh-chg-pane-empty", T("左侧选一个文件")));
      return;
    }
    /* 右侧自己滚（列表与详情各滚各的）：diff 一批一批续画时，滚到底由这个盒子的
       scroll 事件触发 —— 分栏与滚动共用同一个容器，滚轮落在哪一栏就滚哪一栏。 */
    var scroll = mkEl("div", "dsh-chg-scroll");
    var head = mkEl("div", "dsh-chg-head");
    var hname = mkEl("div", "dsh-chg-head-name", baseNameOf(hit.path));
    hname.title = relPathOf(hit.path, host._chgRoot);
    head.appendChild(hname);
    head.appendChild(
      mkEl(
        "div",
        "dsh-chg-head-sub",
        relPathOf(hit.path, host._chgRoot) +
          " · " +
          Tf("共 {n} 次", { n: hit.count }) +
          " · " +
          deltaText(hit.added, hit.removed),
      ),
    );
    scroll.appendChild(head);
    for (var k = 0; k < hit.items.length; k++) scroll.appendChild(diffCard(hit.items[k]));
    pane.appendChild(scroll);
    host._chgScroll = scroll;
    if (keepTop > 0) {
      try {
        scroll.scrollTop = keepTop;
      } catch (_) {
        /* 无布局的迷你 DOM：跳过 */
      }
    }
    bindScrollMore(host, scroll);
  }

  /* 左侧选中态的刷新（不重建行） */
  function syncRows(host, path) {
    if (!host) return;
    var rows = host.querySelectorAll ? host.querySelectorAll(".dsh-chg-row") : [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r || !r.classList) continue;
      r.classList.toggle("on", String(r.dataset.path || "") === String(path || ""));
    }
  }

  /* 宿主：本视图自己的那块（由 app-trajectory.js 挂进主区，与轨迹主区并列）。
     **数据没变就一个节点都不动**（本次修的 bug）：签名 = 会话 + 每一组（路径 · 笔数 ·
     最新时刻）。会话在跑时 sync 每来一帧都调这里一次，签名一样时重建只会把用户往下滚的
     diff 顶回顶端、把展开的块重新折起来 —— 没有任何新信息，必须原样不动。 */
  function mount(host, sid) {
    if (!host) return null;
    var id = String(sid || "");
    var switched = !host.dataset || host.dataset.chgSid !== id;
    if (switched) {
      host.dataset.chgSid = id;
      /* 换会话：两侧都回到初始态（未选中） */
      host._chgGroups = [];
      host._chgSig = "";
    }
    var groups = collectGroups(id);
    var sig = groupsSig(id, groups);
    if (!switched && host._chgSig === sig && host._chgList) return host;
    host._chgGroups = groups;
    render(host, id, groups);
    return host;
  }

  /* 出口：mount 是外部唯一入口（renderer/app-trajectory.js 在切到「改动」栏时调它）；
     其余只给冒烟核对用 —— 只读、不落盘、不碰画布。 */
  window.MTNodeChanges = {
    mount: mount,
    /* 冒烟用：把「收 → 合并 → 摆位置」三段分别暴露出来，各自可单独核对 */
    _collect: function (sid) {
      return collectToolRecords(sid);
    },
    _groups: function (sid) {
      return collectGroups(sid);
    },
    _sig: function (sid) {
      return groupsSig(sid, collectGroups(sid));
    },
    _debug: function (sid) {
      return { groups: collectGroups(sid).length, listW: listW };
    },
    _consts: {
      foldCap: CHG_FOLD_ROWS,
      batchRows: CHG_BATCH_ROWS,
      listRatio: CHG_LIST_W_RATIO,
      listMin: CHG_LIST_W_MIN,
      listMaxRatio: CHG_LIST_W_MAX_RATIO,
      listWKey: CHG_LIST_W_LS,
    },
    /* 时间与路径口径（纯函数，冒烟可逐条核对） */
    _stampOf: stampOf,
    _relPathOf: relPathOf,
    _baseNameOf: baseNameOf,
    _midEllipsis: midEllipsis,
    _clampListW: clampListW,
    _deltaText: deltaText,
    _toolLabelOf: toolLabelOf,
  };
})();
