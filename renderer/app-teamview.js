"use strict";
/* ============ 一人公司（团队）视图 · 项目 / 专家 / 会话 + 专家聊天 ============
 *
 * 加载顺序：renderer/index.html 中位于 app-team.js 之后、app-boot.js 之前。
 * 职责边界：本文件只负责「团队视图」的界面与运行编排 ——
 *   · 数据一律走 app-team.js 的 getter / mutator（teamCanvases / teamExperts / teamChats /
 *     teamAddChat / teamUpdateChat …），绝不自抄一份字段表或默认值；
 *   · 聊天气泡与流式行复用 app-assist.js 的 .dsh-msg / .dsh-msg-body.dsh-stream 写法
 *     （dshMsgBlock 直接渲染，思考槽与工具链同会话视图一致），不另起一套渲染；
 *   · 一次运行走 dshRunTask（与助手 / 会话同一条链路），runKey = "team:<chatId>"，
 *     终止走 dshCancelActive(runKey)。
 * 若后续有独立的团队执行引擎，只要挂上 window.MTNodeTeamChat.run / .stop，这里自动让位。
 *
 * 面板约定（AGENTS.md）：视图面板一律 persistent，不做「点外部关闭」；
 * 视图互斥由 setView 的 body.view-* 类 + css/layout.css 的硬闸收口。
 */

/* 团队视图的运行态：**按会话隔离**（chatId → live 记录）
   { chatId, group, running, pending, reasoning, tools[], streams{expertId→…}, order[],
     err, stopped, speaker }。
   多个会话可以同时各跑一轮（后端 runKey 本就按「会话 × 专家」隔离），互不覆盖流式内容；
   只有当前显示的会话才渲染「运行中」流式行，发送 / 终止键也只作用于当前会话。
   群聊一轮有多位专家并行作答：每人各占一条分路（streams），各占一行实时刷新，
   全部结束后按参与顺序（order）落为署名消息，再由主持人汇总。
   跑完不删记录：err 与「↻ 重发」要留在该会话里。 */
var teamLives = Object.create(null);
/* 取 / 装 / 清某会话的运行态。 */
function teamLiveOf(chatId) {
  var k = str(chatId);
  return k ? teamLives[k] || null : null;
}
function teamLivePut(chatId, live) {
  var k = str(chatId);
  if (!k) return null;
  if (live) teamLives[k] = live;
  else delete teamLives[k];
  return live;
}
/* 当前视图所选会话的运行态（发送键 / 终止键的唯一判据）。 */
function teamLiveCurrent() {
  var view = teamViewSel();
  return teamLiveOf(view && view.chatId);
}

/* 群聊并行作答：按专家分路的流式缓冲（expertId → { speaker, pending, reasoning, tools }）。
   并行时多位专家同时吐字，若共用一个 pending 会互相覆盖 —— 每位专家各占一路、各占一行。
   live.order = 本轮参与顺序（先按 selectParticipants 落下的 chat.lastParticipants 铺底，
   事件先到的专家不会把顺序打乱），运行结束后按它落为署名消息。 */
function teamLiveStreamEnsure(live, exp) {
  if (!live) return null;
  if (!live.streams || typeof live.streams !== "object") live.streams = {};
  if (!Array.isArray(live.order)) live.order = [];
  /* 参与顺序铺底：本轮决策结果已在 chat.lastParticipants（runGroupRound 起跑前写入）。 */
  if (!live.order.length && typeof teamChat === "function") {
    try {
      var TEAM = window.MTNodeTeam;
      var chat = teamChat(live.chatId);
      if (TEAM && typeof TEAM.lastRoundIds === "function") {
        (TEAM.lastRoundIds(chat) || []).forEach(function (id) {
          if (live.order.indexOf(id) < 0) live.order.push(id);
        });
      }
    } catch (_) {}
  }
  var id = str(exp && exp.id) || "__host";
  var s = live.streams[id];
  if (!s)
    s = live.streams[id] = {
      expertId: id,
      speaker: exp || null,
      pending: "",
      reasoning: "",
      tools: [],
    };
  if (exp) s.speaker = exp;
  if (live.order.indexOf(id) < 0) live.order.push(id);
  return s;
}

/* 把一次流式事件落到某一路缓冲上（单聊 = 会话自己的记录；群聊 = 该专家那一路）。
   返回是否值得重绘（retry 的「续写」不重绘，与旧行为一致）。 */
function teamLiveApply(target, type, data) {
  if (!target) return false;
  if (type === "text" && data && data.text) {
    target.pending = (target.pending || "") + String(data.text);
    return true;
  }
  if (type === "reasoning" && data && data.text) {
    target.reasoning = (target.reasoning || "") + String(data.text);
    return true;
  }
  if (type === "tool" && data && data.name) {
    target.tools = target.tools || [];
    if (
      !target.tools.some(function (x) {
        return x.callId === data.callId;
      })
    ) {
      target.tools.push({
        callId: data.callId,
        turn: data.turn,
        step: data.step,
        name: data.name,
        args: data.args || "",
        result: null,
        error: null,
        at: Date.now(),
      });
    }
    return true;
  }
  if (type === "tool-result" && data && data.callId) {
    target.tools = target.tools || [];
    var tool = target.tools.find(function (x) {
      return x.callId === data.callId;
    });
    if (tool) {
      tool.result = Array.isArray(data.content) ? data.content : [];
      tool.error = data.error || null;
      return true;
    }
    return false;
  }
  if (type === "retry") {
    /* 整轮重发清掉残文；续写（resumed）保留已显示内容 */
    if (data && data.resumed) return false;
    target.pending = "";
    target.reasoning = "";
    target.tools = [];
    return true;
  }
  return false;
}
var teamViewBound = false;
var teamViewRaf = 0;
/* 专家卡折叠区当前展开的专家 id（"" = 全部收起）；默认收起，只读。 */
var teamViewCardOpen = "";
/* 画布剪枝是否正在跑（同一时刻只跑一次，剪完才重渲染）。 */
var teamViewPruneBusy = false;

/* 词条取词 + 占位符替换：第二参 vars 交给 I18n.t 做 {name}/{n} 等替换；
   无 I18n 时本地兜底同一套替换，保证「删除专家「{name}」？」不会把 {name} 原样显示给用户。 */
function teamViewT(s, vars) {
  if (window.I18n && window.I18n.t) return window.I18n.t(s, vars);
  var out = String(s);
  if (vars && typeof vars === "object")
    out = out.replace(/\{(\w+)\}/g, function (_, k) {
      return vars[k] == null ? "" : String(vars[k]);
    });
  return out;
}

/* 本文件自己的 str 兜底：app-team.js / app-team-recruit.js 里的 str 只是各自 IIFE 的
   局部函数，这里直接用会抛 Uncaught ReferenceError（曾致整个团队视图崩溃）。
   全文件一律用这一个。 */
function str(v) {
  return v == null ? "" : String(v);
}

function teamViewEl(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/* 头像：底色一律用主题色（var(--panel2)，见 css/team.css），专家色只落在 icon 描边上；
   图标走 teamIconSvg（16×16 空心线条 SVG，stroke=currentColor），
   容器 flex 居中 + line-height:0，不再用 emoji。 */
function teamViewAvatar(exp, cls, tag) {
  var av = teamViewEl(tag || "div", "team-avatar" + (cls ? " " + cls : ""));
  var g = teamViewEl("span", "team-avatar-glyph");
  var key = str(exp && exp.icon);
  if (!key && typeof teamIconFromGlyph === "function")
    key = str(teamIconFromGlyph(exp && exp.glyph));
  if (typeof teamIconSvg === "function") {
    var size = cls === "lg" ? 28 : cls === "sm" ? 14 : 18;
    g.innerHTML = teamIconSvg(key || "person", { size: size });
  }
  if (exp && exp.color) g.style.color = exp.color;
  av.appendChild(g);
  return av;
}

/* 选择状态（canvasId / expertId / chatId）挂在 S.config.teamView 上，随配置落盘；
   缺省值每次渲染时就地补全，不为此单独写盘。
   v1 旧键 projectId → canvasId：读到旧键就迁移（旧键保留不删，只作读兼容）。 */
function teamViewSel() {
  if (!S.config.teamView || typeof S.config.teamView !== "object")
    S.config.teamView = {};
  var v = S.config.teamView;
  if (!str(v.canvasId) && str(v.projectId)) v.canvasId = str(v.projectId);
  return v;
}

function teamViewSetSel(patch) {
  var v = teamViewSel();
  Object.keys(patch || {}).forEach(function (k) {
    v[k] = patch[k];
  });
  try {
    window.api.configSave(S.config).catch(function () {});
  } catch (_) {}
}

/* 当前画布 / 当前专家可见的会话：先该专家的单聊，再该画布的孤儿单聊（原专家已删除、
   仅可回看），最后该画布下的群聊（各自按更新时间倒序）。
   群聊属于画布锚点、不属于单个专家，所以不能再用 teamChats(expertId) 一把捞。 */
function teamViewChatsFor(proj, exp) {
  var byUpdated = function (a, b) {
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  };
  var canvasId = proj ? str(proj.id) : "";
  var singles = teamChats().filter(function (c) {
    if (c.kind === "group") return false;
    if (exp && c.expertId === exp.id) return true;
    /* 孤儿单聊：专家已删除，按画布锚点保留，避免信息丢失（仅可回看历史）。 */
    return (
      !!canvasId &&
      !teamExpert(c.expertId) &&
      str(c.canvasId || c.projectId) === canvasId
    );
  });
  singles.sort(byUpdated);
  var groups = proj
    ? teamChats().filter(function (c) {
        return c.kind === "group" && (c.canvasId || c.projectId) === proj.id;
      })
    : [];
  groups.sort(byUpdated);
  return singles.concat(groups);
}

/* 进视图先剪枝：把已经删掉的画布上的团队（专家 / 会话 / 招聘草稿）一并清掉，
   否则左栏会留下永远打不开的孤儿团队。异步执行、不阻塞首帧；真剪掉了才重渲染。 */
function teamViewPrune() {
  if (teamViewPruneBusy) return;
  if (typeof window.teamPruneCanvases !== "function") return;
  teamViewPruneBusy = true;
  var done = function (n) {
    teamViewPruneBusy = false;
    if (n) renderTeamPane();
  };
  var r;
  try {
    r = window.teamPruneCanvases();
  } catch (_) {
    teamViewPruneBusy = false;
    return;
  }
  if (r && typeof r.then === "function")
    r.then(done).catch(function () {
      teamViewPruneBusy = false;
    });
  else done(r);
}

/* 把选择补成一个自洽的组合（当前画布 → 该画布下的专家 → 会话；会话可为群聊）。
   团队恒绑定**当前画布**：切画布即自动换团队，不再手动选锚点（跨画布内容只走「复制」）。
   当前画布按需建锚点：没有锚点，招聘出来的专家会挂到空 id 上、左栏看不到。 */
function teamViewEnsure() {
  teamViewPrune();
  var view = teamViewSel();
  if (typeof teamEnsureCanvas === "function") {
    try {
      teamEnsureCanvas();
    } catch (_) {}
  }
  var curId = typeof teamCanvasId === "function" ? str(teamCanvasId()) : "";
  var proj = curId ? teamCanvas(curId) : null;
  if (!proj) proj = teamCanvases()[0] || null;
  view.canvasId = proj ? proj.id : "";
  var exps = proj ? teamExperts(proj.id) : teamExperts();
  var exp = teamExpert(view.expertId);
  if (!exp || (proj && str(exp.canvasId || exp.projectId) !== proj.id))
    exp = exps[0] || null;
  view.expertId = exp ? exp.id : "";
  var chats = teamViewChatsFor(proj, exp);
  var chat = teamChat(view.chatId);
  if (!chat || chats.indexOf(chat) < 0) chat = chats[0] || null;
  /* 孤儿会话（原专家已删除）：不把它当成当前专家的会话 —— 右栏改为「专家已删除」提示，
     只回看历史、不再发消息；选择键清空专家，避免错挂在别的专家上。 */
  var orphan = !!(chat && chat.kind !== "group" && !teamExpert(chat.expertId));
  if (orphan) exp = null;
  view.expertId = exp ? exp.id : "";
  view.chatId = chat ? chat.id : "";
  return {
    proj: proj,
    canvasId: proj ? proj.id : "",
    exp: exp,
    chat: chat,
    chats: chats,
    orphan: orphan,
    group: !!(chat && chat.kind === "group"),
  };
}

/* ── 供应商 / 模型选项（与 app-assist.js renderAgentSession 同一口径） ── */
function teamViewProviders() {
  var out = [];
  try {
    var dp = typeof dshProvider === "function" ? dshProvider() : null;
    out.push({
      id: "deepseek-official",
      name: (dp && dp.name) || teamViewT("DeepSeek 官方"),
    });
    (typeof mtnodePiProviders === "function" ? mtnodePiProviders() : []).forEach(
      function (p) {
        out.push({ id: "mtnode_" + p.route, name: p.name || p.route });
      },
    );
  } catch (_) {}
  if (!out.length)
    out.push({ id: "deepseek-official", name: teamViewT("DeepSeek 官方") });
  return out;
}

function teamViewModelsFor(prov) {
  var out = [];
  try {
    if (prov === "deepseek-official") {
      var dp = typeof dshProvider === "function" ? dshProvider() : null;
      if (dp && Array.isArray(dp.models) && dp.models.length)
        out = dp.models.map(String);
      else
        out = ((S.providerCatalog && S.providerCatalog.deepseek) || []).map(
          function (m) {
            return m.id;
          },
        );
    } else {
      var mp = (typeof mtnodePiProviders === "function"
        ? mtnodePiProviders()
        : []
      ).find(function (x) {
        return "mtnode_" + x.route === prov;
      });
      out = ((mp && mp.models) || []).slice();
    }
  } catch (_) {}
  if (!out.length) out = ["deepseek-v4-flash"];
  return out;
}

function teamViewModelLabel(exp) {
  var m = exp && exp.model ? exp.model : {};
  return String(m.model || m.provider || "").trim() || teamViewT("未设模型");
}

/* ── 两段列表（专家 / 会话） ── */

/* 标题 = 当前画布名（不再显示「AI团队」）；团队恒绑定当前画布，切画布即换标题与内容。 */
function teamViewRenderTitle(st) {
  var el = document.getElementById("teamSideLogo");
  if (!el) return;
  var name = st && st.proj ? str(st.proj.name) : "";
  if (!name && typeof teamCanvasName === "function") name = str(teamCanvasName());
  el.textContent = name || teamViewT("未命名画布");
  el.title = teamViewT("当前画布：") + el.textContent;
}

/* ── 复制团队到其他画布（标题右侧「复制」按钮） ──
   仅增量复制：只往目标画布追加，绝不删除或覆盖目标画布已有内容，当前画布不受影响。
   可选目标 = 磁盘画布列表里除当前画布外的所有画布（不要求已有团队）。 */
function teamCopyDlgHost() {
  return document.getElementById("teamCopyDlg");
}

/* 目标画布候选：wfList 为准，拿不到时退回团队锚点（至少能选有团队的画布）。 */
function teamCopyCandidates() {
  return new Promise(function (resolve) {
    var cur = typeof teamCanvasId === "function" ? str(teamCanvasId()) : "";
    var out = [];
    var seen = {};
    var push = function (id, name) {
      id = str(id);
      if (!id || id === cur || seen[id]) return;
      seen[id] = true;
      out.push({ id: id, name: str(name) || id });
    };
    var fallback = function () {
      (typeof teamCanvases === "function" ? teamCanvases() : []).forEach(function (p) {
        if (p) push(p.id, p.name);
      });
      resolve(out);
    };
    try {
      if (window.api && typeof window.api.wfList === "function") {
        window.api
          .wfList()
          .then(function (list) {
            (Array.isArray(list) ? list : []).forEach(function (w) {
              if (w) push(w.id, w.name);
            });
            fallback();
          })
          .catch(fallback);
        return;
      }
    } catch (_) {}
    fallback();
  });
}

function ensureTeamCopyDlg() {
  var host = teamCopyDlgHost();
  if (host) return host;
  host = teamViewEl("div", "mt-dialog team-copy-dlg");
  host.id = "teamCopyDlg";
  host.tabIndex = -1;
  var box = teamViewEl("div", "mt-dialog-box team-copy-box");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");

  var head = teamViewEl("div", "mt-dialog-head");
  head.appendChild(teamViewEl("b", "", teamViewT("复制团队到其他画布")));
  head.appendChild(teamViewEl("span", "team-spacer"));
  var x = teamViewEl("button", "mini node-guide-x", "✕");
  x.type = "button";
  head.appendChild(x);

  var body = teamViewEl("div", "mt-dialog-body team-copy-body");
  body.appendChild(
    teamViewEl(
      "p",
      "mt-dialog-msg",
      teamViewT(
        "把当前画布的团队（专家、会话、招聘草稿）复制到另一张画布。仅增量复制：只追加，不删除、不覆盖目标画布已有内容；当前画布不受影响。",
      ),
    ),
  );
  var row = teamViewEl("div", "team-copy-row");
  row.appendChild(teamViewEl("span", "team-copy-label", teamViewT("目标画布")));
  var sel = document.createElement("select");
  sel.id = "teamCopyTarget";
  sel.className = "team-copy-sel";
  row.appendChild(sel);
  body.appendChild(row);
  var hint = teamViewEl("div", "team-copy-hint", "");
  hint.id = "teamCopyHint";
  body.appendChild(hint);

  var foot = teamViewEl("div", "mt-dialog-foot");
  var cancel = teamViewEl("button", "mini", teamViewT("取消"));
  cancel.type = "button";
  var go = teamViewEl("button", "mini primary", teamViewT("复制"));
  go.type = "button";
  foot.appendChild(cancel);
  foot.appendChild(go);

  box.appendChild(head);
  box.appendChild(body);
  box.appendChild(foot);
  host.appendChild(box);
  document.body.appendChild(host);

  x.onclick = closeTeamCopyDlg;
  cancel.onclick = closeTeamCopyDlg;
  go.onclick = function () {
    var t = document.getElementById("teamCopyTarget");
    var to = t ? str(t.value) : "";
    if (!to) return;
    var from = typeof teamCanvasId === "function" ? str(teamCanvasId()) : "";
    var r = typeof teamCopyCanvas === "function" ? teamCopyCanvas(from, to) : null;
    if (!r || !(r.experts || r.chats || r.drafts)) {
      if (typeof toast === "function")
        toast(teamViewT("当前画布还没有可复制的团队内容"), "warn");
      return;
    }
    var name = "";
    if (t)
      for (var i = 0; i < t.options.length; i++)
        if (t.options[i].value === to) name = str(t.options[i].textContent);
    if (typeof toast === "function")
      toast(
        teamViewT("已复制到「") +
          name +
          "」" +
          teamViewT("：专家 ") +
          r.experts +
          teamViewT(" 位、会话 ") +
          r.chats +
          teamViewT(" 个会话"),
        "ok",
      );
    closeTeamCopyDlg();
  };
  /* persistent：点蒙层不关；Esc 是显式关闭路径（AGENTS.md 对话框约定）。 */
  host.addEventListener("keydown", function (ev) {
    if (ev.key !== "Escape") return;
    ev.preventDefault();
    closeTeamCopyDlg();
  });
  return host;
}

function openTeamCopyDlg() {
  ensureTeamCopyDlg();
  var host = teamCopyDlgHost();
  if (!host) return;
  var sel = document.getElementById("teamCopyTarget");
  var hint = document.getElementById("teamCopyHint");
  if (sel) sel.innerHTML = "";
  if (hint) hint.textContent = teamViewT("正在读取画布列表…");
  host.classList.add("on");
  teamCopyCandidates().then(function (list) {
    var s = document.getElementById("teamCopyTarget");
    var h = document.getElementById("teamCopyHint");
    if (!s) return;
    s.innerHTML = "";
    if (!list.length) {
      if (h) h.textContent = teamViewT("没有其他画布可复制。先新建一张画布再来。");
      return;
    }
    list.forEach(function (c) {
      var o = document.createElement("option");
      o.value = c.id;
      o.textContent = c.name;
      s.appendChild(o);
    });
    if (h) h.textContent = "";
  });
}

function closeTeamCopyDlg() {
  var host = teamCopyDlgHost();
  if (host) host.classList.remove("on");
}

/* ── 专家树：按分类分组（分类可折叠，用户可自建） ── */

function teamViewCatOpenMap() {
  var v = teamViewSel();
  if (!v.catOpen || typeof v.catOpen !== "object") v.catOpen = {};
  return v.catOpen;
}
function teamViewCatIsOpen(name) {
  var m = teamViewCatOpenMap();
  return m[str(name) || "__none__"] !== false;
}
function teamViewToggleCat(name) {
  var m = teamViewCatOpenMap();
  var k = str(name) || "__none__";
  m[k] = !teamViewCatIsOpen(name);
  teamViewSetSel({ catOpen: m });
}

/* 分类下拉选项：已有分类 + 当前值（可能是别处写进来的名字）+「＋ 新建分类…」哨兵。 */
function teamViewCategoryOptions(cur) {
  var opts = [["", teamViewT("未分类")]];
  teamCategories().forEach(function (c) {
    if (c && c.name) opts.push([c.name, c.name]);
  });
  var k = str(cur).trim();
  if (k && !opts.some(function (o) {
    return o[0] === k;
  }))
    opts.push([k, k]);
  opts.push(["__new__", teamViewT("＋ 新建分类…")]);
  return opts;
}

/* 新建分类：优先复用招聘模块的输入框（同一实现），否则退回通用 promptDialog。 */
function teamViewNewCategory() {
  if (typeof window.teamRecruitNewCategory === "function")
    return window.teamRecruitNewCategory();
  if (typeof promptDialog !== "function") return Promise.resolve("");
  return promptDialog(teamViewT("新分类名称（≤12 字）"), "", {
    title: teamViewT("新建分类"),
    placeholder: teamViewT("例如：产品 / 技术 / 商业 / 增长"),
  }).then(function (v) {
    var name = str(v).trim().slice(0, 12);
    if (name && typeof teamAddCategory === "function") teamAddCategory({ name: name });
    return name;
  });
}

/* 为某位角色新建一段单聊：左栏角色行右侧的「＋」走这里（顶部不再有「＋ 新会话」）。
   选中的专家一并落定，右栏立刻显示这位角色的会话。 */
function teamViewNewChatFor(exp) {
  if (!exp || !exp.id) return null;
  var canvasId = str(exp.canvasId || exp.projectId);
  var c = teamAddChat({
    expertId: exp.id,
    canvasId: canvasId,
    title: teamViewT("新对话"),
  });
  if (!c) return null;
  teamViewSetSel({ canvasId: canvasId, expertId: exp.id, chatId: c.id });
  renderTeamPane();
  return c;
}

/* 删除专家：二次确认后摘掉专家；其会话**一律保留**（标成「专家已删除」，仅可回看），
   避免信息丢失。删除后清掉选择键，交给 ensure 自动补一个自洽的组合（通常落到保留下来的会话）。 */
function teamViewRemoveExpert(exp) {
  if (!exp || !exp.id) return;
  var name = exp.name || exp.id;
  var n = teamChats(exp.id).filter(function (c) {
    return c.kind !== "group";
  }).length;
  var go = function (yes) {
    if (!yes || typeof teamRemoveExpert !== "function") return;
    teamRemoveExpert(exp.id);
    if (str(teamViewSel().expertId) === exp.id)
      teamViewSetSel({ expertId: "" });
    renderTeamPane();
    if (typeof toast === "function")
      toast(
        n
          ? teamViewT("已删除专家「{name}」，{n} 个会话已保留（仅可回看）", {
              name: name,
              n: String(n),
            })
          : teamViewT("已删除专家「{name}」", { name: name }),
        "ok",
      );
  };
  var msg = n
    ? teamViewT(
        "删除专家「{name}」？其 {n} 个会话会保留（专家已删除，仅可回看），避免信息丢失。",
        { name: name, n: String(n) },
      )
    : teamViewT("删除专家「{name}」？该操作不可恢复。", { name: name });
  if (typeof confirmDialog === "function")
    Promise.resolve(
      confirmDialog(msg, {
        title: teamViewT("删除专家"),
        danger: true,
        okText: teamViewT("删除"),
      }),
    ).then(go);
  else go(true);
}

/* 删除会话：二次确认后连聊天记录一起删（不可恢复）。 */
function teamViewRemoveChat(chat) {
  if (!chat || !chat.id) return;
  var title = chat.title || chat.id;
  var go = function (yes) {
    if (!yes || typeof teamRemoveChat !== "function") return;
    teamRemoveChat(chat.id);
    /* 会话删了就丢掉它的运行态记录，别留在 map 里。 */
    teamLivePut(chat.id, null);
    if (str(teamViewSel().chatId) === chat.id) teamViewSetSel({ chatId: "" });
    renderTeamPane();
    if (typeof toast === "function")
      toast(teamViewT("已删除会话「{title}」", { title: title }), "ok");
  };
  if (typeof confirmDialog === "function")
    Promise.resolve(
      confirmDialog(
        teamViewT("删除会话「{title}」？聊天记录会一并删除，且不可恢复。", {
          title: title,
        }),
        {
          title: teamViewT("删除会话"),
          danger: true,
          okText: teamViewT("删除"),
        },
      ),
    ).then(go);
  else go(true);
}

/* ── 事实库（左栏专家列表末尾的分组） ──
   每个画布锚点至多一份事实库（app-factlib.js：库内多篇 <doc>.md 正文 / 每篇一份
   <doc>.review.json 审阅 sidecar / assets/ 共享插图目录）。分组形态：
     · 库行 = 库名 + 文档数 + 常显「＋ 新建文档」；hover 出现「打开所在文件夹」与「✕ 删除事实库」，
       点整行 = 未建库则先建库再打开首篇审阅（openFactReview，app-review.js）；
     · 库行下逐个文档行 = 文档名 + 更新时间（取配置时间与磁盘 mtime 较大者），hover 出现
       「✕ 删除该文档」，点整行打开该篇审阅；
     · 空库给「由专家建档或手动新建」提示。
   删除（库与文档皆然）：一律先弹确认框，确认后由主进程把 md / sidecar / 整库目录搬进
   **系统回收站**（shell.trashItem，可在资源管理器还原），绝不物理删除；
   数据一律走 app-team.js 的 fact getter 与 mutator；磁盘操作走 app-factlib.js
   （主进程 fact:removeLibrary）。 */
function teamViewFactLabel(fact) {
  return str(fact && fact.name).trim() || teamViewT("事实库");
}

/* 确认框：删除是危险操作，统一 danger 样式 + 点名的目标名（口径同删除会话 / 删除专家）。 */
function teamViewFactConfirmAsk(msg, title, go) {
  if (typeof confirmDialog === "function")
    Promise.resolve(
      confirmDialog(msg, {
        title: teamViewT(title),
        danger: true,
        okText: teamViewT("删除"),
      }),
    ).then(go);
  else go(true);
}

/* 删除库内单篇文档：确认后进系统回收站（可在资源管理器还原），随后刷新左栏。 */
function teamViewRemoveFactDoc(canvasId, doc) {
  if (!doc || !str(doc.id)) return;
  var name = str(doc.name) || teamViewT("文档");
  teamViewFactConfirmAsk(
    teamViewT(
      "删除文档「{name}」？正文、批注与插图会移入系统回收站（可在资源管理器里还原）。",
      { name: name },
    ),
    "删除文档",
    function (yes) {
      if (!yes) return;
      var lib = window.MTNodeFactLib;
      if (!lib || typeof lib.removeDoc !== "function") {
        toast(teamViewT("事实库模块未就绪，无法删除文档"), "err");
        return;
      }
      Promise.resolve(lib.removeDoc(canvasId, doc.id)).then(
        function (r) {
          if (!r || r.ok === false) {
            toast(str(r && r.error) || teamViewT("无法删除"), "err");
            return;
          }
          renderTeamPane();
          toast(
            teamViewT("已删除文档「{name}」（进系统回收站）", { name: name }),
            "ok",
          );
        },
        function () {
          toast(teamViewT("无法删除"), "err");
        },
      );
    },
  );
}

/* 删除整个事实库：确认后把「团队事实库」目录整目录搬进系统回收站，并摘掉库记录。 */
function teamViewRemoveFact(canvasId) {
  var fact = typeof teamFact === "function" ? teamFact(canvasId) : null;
  if (!fact) return;
  var name = teamViewFactLabel(fact);
  teamViewFactConfirmAsk(
    teamViewT(
      "删除事实库「{name}」？正文、批注与插图会一并移入系统回收站（可在资源管理器里还原）。",
      { name: name },
    ),
    "删除事实库",
    function (yes) {
      if (!yes) return;
      var lib = window.MTNodeFactLib;
      if (!lib || typeof lib.removeLibrary !== "function") {
        toast(teamViewT("事实库未就绪"), "err");
        return;
      }
      Promise.resolve(lib.removeLibrary(canvasId)).then(
        function (r) {
          if (!r || r.ok === false) {
            toast(str(r && r.error) || teamViewT("无法删除"), "err");
            return;
          }
          renderTeamPane();
          toast(teamViewT("已删除事实库「{name}」（进系统回收站）", { name: name }), "ok");
        },
        function () {
          toast(teamViewT("无法删除"), "err");
        },
      );
    },
  );
}

/* 「✕」危险操作按钮：与会话 / 角色行同款（.team-side-act danger，hover 出现）。 */
function teamViewFactDelBtn(title, fn) {
  var b = teamViewEl("button", "team-side-act danger", "✕");
  b.type = "button";
  b.title = title;
  b.setAttribute("aria-label", title);
  b.addEventListener("click", function (ev) {
    if (ev && ev.stopPropagation) ev.stopPropagation();
    if (ev && ev.preventDefault) ev.preventDefault();
    fn();
  });
  return b;
}

/* 更新时间文案：刚刚 / N 分钟前 / N 小时前，超过 24h 用本地 YYYY-MM-DD HH:mm。 */
function teamViewFactStamp(at) {
  var t = Number(at) || 0;
  if (!t) return "";
  var min = Math.floor((Date.now() - t) / 60000);
  if (min < 1) return teamViewT("刚刚");
  if (min < 60) return min + teamViewT(" 分钟前");
  var hr = Math.floor(min / 60);
  if (hr < 24) return hr + teamViewT(" 小时前");
  var d = new Date(t);
  function p2(n) {
    return String(n).padStart(2, "0");
  }
  return (
    d.getFullYear() +
    "-" +
    p2(d.getMonth() + 1) +
    "-" +
    p2(d.getDate()) +
    " " +
    p2(d.getHours()) +
    ":" +
    p2(d.getMinutes())
  );
}

function teamViewFillFactStats(doc, sub) {
  if (!doc || !sub) return;
  var lib = window.MTNodeFactLib;
  if (!lib || typeof lib.statsOf !== "function") return;
  Promise.resolve(lib.statsOf(doc)).then(
    function (stats) {
      if (!sub.isConnected) return;
      /* 更新时间取配置 updatedAt 与磁盘 mtime 的较大者（专家直接写文件也能反映）。 */
      var at = Math.max(Number(doc.updatedAt) || 0, Number(stats && stats.mtime) || 0);
      sub.textContent = at ? teamViewFactStamp(at) : teamViewT("空");
    },
    function () {},
  );
}

/* 保存即刷新更新时间：app-factlib.js 每次写盘成功都广播 factlib:saved（detail = { file }），
   这里只更新对得上的文档行（不整面重渲染，避免打断用户输入 / 滚动位置）。
   传 file 时只刷该篇；不传则全刷。返回刷新行数，便于测试断言。 */
function teamViewRefreshFactStats(file) {
  var pane = document.getElementById("teamPane");
  if (!pane || typeof pane.querySelectorAll !== "function") return 0;
  var want = str(file);
  var rows = pane.querySelectorAll(".team-side-fact-doc");
  var n = 0;
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var f = row.getAttribute ? str(row.getAttribute("data-fact-file")) : "";
    if (!f || (want && f !== want)) continue;
    var sub = row.querySelector ? row.querySelector(".team-side-sub") : null;
    if (!sub) continue;
    teamViewFillFactStats({ file: f }, sub);
    n++;
  }
  return n;
}

/* 挂一次监听：任何保存路径（审阅写回 / AI 修订落盘 / 建档写模板）都能触发更新时间刷新。 */
if (typeof document !== "undefined" && document.addEventListener)
  document.addEventListener("factlib:saved", function (ev) {
    var d = ev && ev.detail;
    teamViewRefreshFactStats(d && d.file);
  });

/* 点库行：建库（幂等）+ 打开首篇文档审阅。
   openFactReview 接收单篇文档记录 { file, name, reviewFile, assetsDir }
   （assetsDir 为库级共享插图目录，同库多篇文档共用一份 assets/）。 */
function teamViewOpenFact(canvasId) {
  var id = str(canvasId);
  if (!id) {
    toast(teamViewT("当前没有画布，无法创建事实库"), "warn");
    return;
  }
  /* 先体检库落点：历史版本把库建在了应用文件夹里（跟着开发画布的项目根走），
     这里问用户是否迁回画布文件夹（见 app-factlib.js relocateLibrary / docs/fact-library.md §六）。 */
  var fixed =
    typeof factlibRelocate === "function"
      ? factlibRelocate(id)
      : Promise.resolve(false);
  Promise.resolve(fixed)
    .then(function () {
      var fact = typeof teamFact === "function" ? teamFact(id) : null;
      return fact && str(fact.file)
        ? Promise.resolve(fact)
        : typeof factlibEnsure === "function"
          ? factlibEnsure(id)
          : Promise.resolve(null);
    })
    .then(
      function (lib) {
        if (!lib) {
          toast(teamViewT("事实库创建失败"), "err");
          return;
        }
        var fl = window.MTNodeFactLib;
        var paths = fl && typeof fl.pathsOf === "function" ? fl.pathsOf(lib) : null;
        var doc = paths && paths.docs && paths.docs.length ? paths.docs[0] : null;
        if (doc && typeof openFactReview === "function")
          openFactReview({
            file: str(doc.file),
            name: str(doc.name),
            reviewFile: str(doc.reviewFile),
            assetsDir: str(paths.assetsDir),
            canvasId: id,
          });
        else toast(teamViewT("审阅模块未就绪，无法打开事实库"), "err");
        renderTeamPane();
      },
      function () {
        toast(teamViewT("事实库创建失败"), "err");
      },
    );
}

/* 打开所在文件夹：定位到正文 md（没有则退回资产目录）。 */
function teamViewFactReveal(fact) {
  var p = str(fact && (fact.file || fact.assetsDir));
  if (!p) return;
  if (window.api && typeof window.api.shellShowItem === "function")
    window.api.shellShowItem(p);
}

/* 行内操作按钮（库行与文档行共用）：icon 优先，没有图标就用文字。 */
function teamViewFactAct(iconKey, text, title, fn) {
  var b = teamViewEl("button", "team-side-act");
  b.type = "button";
  b.title = title;
  b.setAttribute("aria-label", title);
  if (iconKey && typeof teamIconSvg === "function")
    b.innerHTML = teamIconSvg(iconKey, { size: 13 });
  else b.textContent = text || "";
  b.addEventListener("click", function (ev) {
    if (ev && ev.stopPropagation) ev.stopPropagation();
    if (ev && ev.preventDefault) ev.preventDefault();
    fn();
  });
  return b;
}

/* 新建文档：弹名称 → 幂等建档（同名原样返回，不覆盖正文）→ 刷新左栏。
   建档前先跑错位体检（库若还落在应用 / 项目源码目录，先问用户是否迁到画布文件夹）——
   否则新建的文档会顺着旧路径继续写进开发项目目录。 */
function teamViewFactNewDoc(canvasId) {
  if (typeof promptDialog !== "function") return;
  var fix =
    typeof factlibRelocate === "function"
      ? factlibRelocate(canvasId)
      : Promise.resolve(false);
  Promise.resolve(fix).then(function () {
    return Promise.resolve(
      promptDialog(teamViewT("新建文档"), "", {
        title: teamViewT("新建文档"),
        placeholder: teamViewT("例如：产品规格"),
      }),
    );
  }).then(function (v) {
    var name = str(v).trim();
    if (!name) return;
    var lib = window.MTNodeFactLib;
    if (!lib || typeof lib.ensureDocByName !== "function") {
      toast(teamViewT("事实库模块未就绪，无法新建文档"), "err");
      return;
    }
    Promise.resolve(lib.ensureDocByName(canvasId, name)).then(
      function (d) {
        if (!d) {
          toast(teamViewT("新建文档失败"), "err");
          return;
        }
        renderTeamPane();
        toast(
          teamViewT("已新建文档「{name}」", { name: str(d.name) || name }),
          "ok",
        );
      },
      function () {
        toast(teamViewT("新建文档失败"), "err");
      },
    );
  });
}

/* 点文档行：打开该篇审阅（openFactReview 接收 { file, name } 形态的记录）。
   与点库行同口径先跑错位体检：库若还在应用文件夹里，确认迁移后按新路径打开这一篇。 */
function teamViewOpenFactDoc(canvasId, doc) {
  if (!doc || !str(doc.file)) {
    toast(teamViewT("该文档还没有正文文件"), "warn");
    return;
  }
  if (typeof openFactReview !== "function") {
    toast(teamViewT("审阅模块未就绪，无法打开事实库"), "err");
    return;
  }
  var fix =
    typeof factlibRelocate === "function"
      ? factlibRelocate(canvasId)
      : Promise.resolve(false);
  Promise.resolve(fix).then(function () {
    var team = window.MTNodeTeam;
    var fresh =
      team && typeof team.factDoc === "function" && doc.id
        ? team.factDoc(canvasId, doc.id) || doc
        : doc;
    if (!str(fresh.file)) {
      toast(teamViewT("该文档还没有正文文件"), "warn");
      return;
    }
    openFactReview(
      Object.assign({}, fresh, { canvasId: canvasId, projectId: canvasId }),
    );
  });
}

/* 库内单篇文档行：文档名 + 更新时间；hover 出现「✕ 删除该文档」（确认后进系统回收站），
   点整行打开审阅。 */
function teamViewFactDocRow(canvasId, doc) {
  var row = teamViewEl("div", "team-side-item team-side-fact-doc");
  /* 保存广播（factlib:saved）靠这个属性认行，只刷新对得上的那篇文档。 */
  var docFile = str(doc && doc.file);
  if (docFile) row.setAttribute("data-fact-file", docFile);
  row.appendChild(
    teamViewEl("span", "team-side-name", str(doc && doc.name) || teamViewT("文档")),
  );
  var sub = teamViewEl("span", "team-side-sub", teamViewT("读取中…"));
  row.appendChild(sub);
  teamViewFillFactStats(doc, sub);

  /* 尾部：hover 出现的「✕」＝删除这一篇（与会话行同款；确认后进系统回收站）。 */
  var tail = teamViewEl("div", "team-side-tail");
  var acts = teamViewEl("div", "team-side-acts");
  acts.appendChild(
    teamViewFactDelBtn(teamViewT("删除该文档（移入系统回收站）"), function () {
      teamViewRemoveFactDoc(canvasId, doc);
    }),
  );
  tail.appendChild(acts);
  row.appendChild(tail);

  row.addEventListener("click", function () {
    teamViewOpenFactDoc(canvasId, doc);
  });
  return row;
}

/* 事实库分组本体：库行（book 图标 + 库名 + 文档数 + 新建文档 ＋；已建库才给
   「打开所在文件夹 / ✕ 删除事实库」两个 hover 操作按钮）+ 库行下的文档子行；空库给提示。 */
function teamViewFactRow(st) {
  var canvasId = str(st && st.canvasId);
  var fact = typeof teamFact === "function" ? teamFact(canvasId) : null;
  var docs = fact && Array.isArray(fact.docs) ? fact.docs : [];
  var wrap = teamViewEl("div", "team-side-fact-group");

  var row = teamViewEl("div", "team-side-item team-side-fact");
  var glyph = teamViewEl("span", "team-side-glyph team-side-icon");
  if (typeof teamIconSvg === "function")
    glyph.innerHTML = teamIconSvg("book", { size: 15 });
  row.appendChild(glyph);
  row.appendChild(teamViewEl("span", "team-side-name", teamViewFactLabel(fact)));
  row.appendChild(
    teamViewEl(
      "span",
      "team-side-sub",
      fact ? teamViewT("{n} 篇", { n: String(docs.length) }) : teamViewT("未建库"),
    ),
  );

  if (fact) {
    var tail = teamViewEl("div", "team-side-tail");
    var acts = teamViewEl("div", "team-side-acts");
    acts.appendChild(
      teamViewFactAct("folder", "", teamViewT("打开所在文件夹"), function () {
        teamViewFactReveal(fact);
      }),
    );
    /* hover 出现的「✕」＝删除整个事实库（与会话行同款；确认后整目录进系统回收站）。 */
    acts.appendChild(
      teamViewFactDelBtn(teamViewT("删除该事实库（移入系统回收站）"), function () {
        teamViewRemoveFact(canvasId);
      }),
    );
    tail.appendChild(acts);

    /* 常显「＋」＝在库内新建一篇文档（不 hover 也能点到）。 */
    var add = teamViewEl("button", "team-side-add-chat", "＋");
    add.type = "button";
    add.title = teamViewT("新建文档");
    add.setAttribute("aria-label", teamViewT("新建文档"));
    add.addEventListener("click", function (ev) {
      if (ev && ev.stopPropagation) ev.stopPropagation();
      if (ev && ev.preventDefault) ev.preventDefault();
      teamViewFactNewDoc(canvasId);
    });
    tail.appendChild(add);
    row.appendChild(tail);
  }

  row.addEventListener("click", function () {
    teamViewOpenFact(canvasId);
  });
  wrap.appendChild(row);

  if (fact) {
    var kids = teamViewEl("div", "team-side-fact-docs");
    if (!docs.length) {
      kids.appendChild(
        teamViewEl(
          "div",
          "team-side-empty team-side-fact-empty",
          teamViewT("由专家建档或手动新建"),
        ),
      );
    } else {
      docs.forEach(function (d) {
        kids.appendChild(teamViewFactDocRow(canvasId, d));
      });
    }
    wrap.appendChild(kids);
  }
  return wrap;
}

/* 分类树只负责折叠与浏览；新建 / 改名 / 删除统一在招聘对话框的「管理分类」里。 */
function teamViewRenderExperts(st) {
  var box = document.getElementById("teamExpertList");
  if (!box) return;
  box.innerHTML = "";
  var list = st && st.canvasId ? teamExperts(st.canvasId) : teamExperts();
  var buckets = [];
  var byName = {};
  teamCategories().forEach(function (c) {
    if (!c || !c.name || byName[c.name]) return;
    byName[c.name] = { name: c.name, items: [] };
    buckets.push(byName[c.name]);
  });
  var uncat = { name: "", items: [] };
  list.forEach(function (exp) {
    var n = str(exp.category).trim();
    if (!n) {
      uncat.items.push(exp);
      return;
    }
    if (!byName[n]) {
      byName[n] = { name: n, items: [] };
      buckets.push(byName[n]);
    }
    byName[n].items.push(exp);
  });
  if (uncat.items.length) buckets.push(uncat);
  /* 没有角色的分类不予显示：空分类只在招聘 /「管理分类」里维护，不占左栏（也不给空壳折叠头）。 */
  buckets = buckets.filter(function (b) {
    return b.items.length > 0;
  });
  if (!buckets.length) {
    box.appendChild(
      teamViewEl(
        "div",
        "team-side-empty",
        teamViewT("该画布下还没有专家，点上方 ＋ 招聘。"),
      ),
    );
    /* 全部分类之后：本画布的事实库入口（不存在时点击即建库）。 */
    if (st && st.canvasId) box.appendChild(teamViewFactRow(st));
    return;
  }

  buckets.forEach(function (b) {
    var open = teamViewCatIsOpen(b.name);
    var row = teamViewEl("div", "team-cat-row" + (open ? "" : " closed"));
    row.appendChild(teamViewEl("span", "team-cat-caret", open ? "▾" : "▸"));
    row.appendChild(
      teamViewEl("span", "team-cat-name", b.name || teamViewT("未分类")),
    );
    row.appendChild(teamViewEl("span", "team-cat-count", String(b.items.length)));
    row.addEventListener("click", function () {
      teamViewToggleCat(b.name);
      renderTeamPane();
    });
    box.appendChild(row);
    if (!open) return;

    var kids = teamViewEl("div", "team-cat-kids");
    b.items.forEach(function (exp) {
      var on = st && st.exp && st.exp.id === exp.id;
      var it = teamViewEl("div", "team-side-item" + (on ? " on" : ""));
      it.appendChild(teamViewAvatar(exp, "sm"));
      it.appendChild(teamViewEl("span", "team-side-name", exp.name || exp.id));
      /* 左栏角色行不再显示模型标签（挤占空间）：模型只在右栏头部 / 招聘面板里改。
         右侧尾部：hover 出现的「✕」＝删除这位专家（其会话保留）；常显「＋」＝新建单聊。 */
      var tail = teamViewEl("div", "team-side-tail");
      var acts = teamViewEl("div", "team-side-acts");
      var del = teamViewEl("button", "team-side-act danger", "✕");
      del.type = "button";
      del.title = teamViewT("删除该专家（保留其会话）");
      del.setAttribute("aria-label", teamViewT("删除该专家（保留其会话）"));
      del.addEventListener("click", function (ev) {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        if (ev && ev.preventDefault) ev.preventDefault();
        teamViewRemoveExpert(exp);
      });
      acts.appendChild(del);
      tail.appendChild(acts);

      var addChat = teamViewEl("button", "team-side-add-chat", "＋");
      addChat.type = "button";
      addChat.title = teamViewT("为当前专家新建会话");
      addChat.setAttribute("aria-label", teamViewT("为当前专家新建会话"));
      addChat.addEventListener("click", function (ev) {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        if (ev && ev.preventDefault) ev.preventDefault();
        teamViewNewChatFor(exp);
      });
      tail.appendChild(addChat);
      it.appendChild(tail);
      it.addEventListener("click", function () {
        teamViewSetSel({
          canvasId:
            str(exp.canvasId || exp.projectId) || (st && st.canvasId) || "",
          expertId: exp.id,
          chatId: "",
        });
        renderTeamPane();
      });
      kids.appendChild(it);
    });
    box.appendChild(kids);
  });
  /* 全部分类之后：本画布的事实库入口（不存在时点击即建库）。 */
  if (st && st.canvasId) box.appendChild(teamViewFactRow(st));
}

function teamViewRenderChats(st) {
  var box = document.getElementById("teamChatList");
  if (!box) return;
  box.innerHTML = "";
  var list = (st && st.chats) || [];
  if (!list.length) {
    box.appendChild(
      teamViewEl(
        "div",
        "team-side-empty",
        teamViewT("还没有会话，点左栏角色右侧的「＋」开一段新对话。"),
      ),
    );
    return;
  }
  list.forEach(function (c) {
    var on = st && st.chat && st.chat.id === c.id;
    var it = teamViewEl("div", "team-side-item" + (on ? " on" : ""));
    var group = c.kind === "group";
    /* 孤儿会话：原专家已删除，会话仍保留（仅可回看）。 */
    var orphan = !group && !teamExpert(c.expertId);
    var glyph = teamViewEl("span", "team-side-glyph team-side-icon");
    if (typeof teamIconSvg === "function")
      glyph.innerHTML = teamIconSvg(group ? "users" : "chat", { size: 15 });
    if (orphan) glyph.style.opacity = "0.5";
    it.appendChild(glyph);
    it.appendChild(teamViewEl("span", "team-side-name", c.title || c.id));

    /* 尾部：群聊人数 / 孤儿标记 / 消息数，再挂 hover 出现的「✕」删除会话。 */
    var tail = teamViewEl("div", "team-side-tail");
    if (group) {
      var n = teamChatParticipants(c).length;
      tail.appendChild(
        teamViewEl(
          "span",
          "team-badge team-side-sub",
          teamViewT("圆桌 ") + n,
        ),
      );
    } else if (orphan) {
      var ob = teamViewEl(
        "span",
        "team-badge team-side-sub team-side-orphan",
        teamViewT("专家已删除"),
      );
      ob.title =
        (str(c.expertName)
          ? teamViewT("原专家：") + str(c.expertName)
          : teamViewT("原专家已删除")) + teamViewT(" · 仅可回看历史");
      tail.appendChild(ob);
    } else {
      var mn = (c.messages || []).length;
      if (mn) tail.appendChild(teamViewEl("span", "team-side-sub", String(mn)));
    }
    /* 后台会话仍在跑：条目上标「运行中」——同时与多位专家对话时能一眼分辨。 */
    var clive = teamLiveOf(c.id);
    if (clive && clive.running && !(st && st.chat && st.chat.id === c.id))
      tail.appendChild(
        teamViewEl("span", "team-badge team-side-sub", teamViewT("运行中")),
      );
    var acts = teamViewEl("div", "team-side-acts");
    var del = teamViewEl("button", "team-side-act danger", "✕");
    del.type = "button";
    del.title = teamViewT("删除该会话");
    del.setAttribute("aria-label", teamViewT("删除该会话"));
    del.addEventListener("click", function (ev) {
      if (ev && ev.stopPropagation) ev.stopPropagation();
      if (ev && ev.preventDefault) ev.preventDefault();
      teamViewRemoveChat(c);
    });
    acts.appendChild(del);
    tail.appendChild(acts);
    it.appendChild(tail);

    it.addEventListener("click", function () {
      teamViewSetSel({ chatId: c.id });
      renderTeamPane();
    });
    box.appendChild(it);
  });
}

/* ── 右栏头部：专家身份 + 供应商 / 模型选择 ── */

/* 本轮参与人标记文案：主持人选定 / 被 @ 指定 / 按相关性选定。 */
function teamViewRoundModeLabel(mode) {
  if (mode === "mention") return teamViewT("被 @ 指定");
  if (mode === "host") return teamViewT("主持人选定");
  return teamViewT("按相关性选定");
}

/* 本轮参与人回执（chat.lastParticipants，selectParticipants 的决策结果）。
   有就按它回显；没有（旧数据 / 刚建的圆桌）才退回全体参与者。 */
function teamViewRoundInfo(chat) {
  var TEAM = window.MTNodeTeam;
  var lp =
    TEAM && typeof TEAM.lastRoundOf === "function" ? TEAM.lastRoundOf(chat) : null;
  return lp && Array.isArray(lp.ids) && lp.ids.length ? lp : null;
}

/* 群聊头部：圆桌标题 + **本轮实际参与人**头像 + 选人标记与理由 + 「收敛出建议」。
   头部不再显示全体候选人（谁上桌由 selectParticipants 每轮决定，不全员）；
   群聊里每位专家有自己的模型，所以头部不提供供应商 / 模型下拉（改模型去左栏专家或编辑面板）。 */
function teamViewRenderGroupHead(head, chat) {
  var all = teamChatParticipants(chat);
  var fac = teamFacilitatorOf(chat);
  var lp = teamViewRoundInfo(chat);
  var parts = lp
    ? lp.ids
        .map(function (id) {
          return teamExpert(id);
        })
        .filter(Boolean)
    : all;
  var box = teamViewEl("div", "team-main-id");
  box.appendChild(
    teamViewEl("div", "team-main-name", chat.title || teamViewT("圆桌讨论")),
  );
  var sub = teamViewT("圆桌") + " · " + parts.length + teamViewT(" 位专家");
  if (lp) sub += " · " + teamViewT("本轮参与");
  if (fac) sub += " · " + teamViewT("主持：") + (fac.name || "");
  box.appendChild(teamViewEl("div", "team-main-role", sub));
  /* 选人理由：常显一行（过长省略），完整理由挂 title，鼠标悬停可读。 */
  if (lp && lp.reason) {
    var rl = teamViewEl("div", "team-round-reason", lp.reason);
    rl.title = lp.reason;
    box.appendChild(rl);
  }
  head.appendChild(box);

  var avs = teamViewEl("div", "team-group-avs");
  parts.forEach(function (e) {
    var a = teamViewAvatar(e, "sm");
    a.title = (e.name || "") + (e.role ? " · " + e.role : "");
    avs.appendChild(a);
  });
  head.appendChild(avs);
  if (lp) {
    var tag = teamViewEl(
      "span",
      "team-badge team-round-tag",
      teamViewRoundModeLabel(lp.mode),
    );
    tag.title = lp.reason || "";
    head.appendChild(tag);
  }
  head.appendChild(teamViewEl("div", "team-spacer"));

  var agg = teamViewEl("button", "team-chat-send team-aggregate-btn", teamViewT("收敛出建议"));
  agg.type = "button";
  agg.title = teamViewT("让主持人汇总讨论，生成建议卡（不采纳、不执行）");
  agg.addEventListener("click", function () {
    teamGroupAggregateNow();
  });
  head.appendChild(agg);
}

function teamViewRenderMain(st) {
  var head = document.getElementById("teamMainHead");
  if (!head) return;
  head.innerHTML = "";
  var exp = st && st.exp;
  var chat = st && st.chat;
  if (chat && chat.kind === "group") {
    teamViewRenderGroupHead(head, chat);
    return;
  }
  /* 孤儿会话：原专家已删除，会话被保留下来。右栏只回看历史，不再发消息。 */
  if (st && st.orphan) {
    head.appendChild(
      teamViewAvatar(
        { icon: chat && chat.expertIcon, color: chat && chat.expertColor },
        "lg",
      ),
    );
    var obox = teamViewEl("div", "team-main-id");
    obox.appendChild(
      teamViewEl(
        "div",
        "team-main-name",
        (chat && chat.title) || teamViewT("历史会话"),
      ),
    );
    obox.appendChild(
      teamViewEl(
        "div",
        "team-main-role",
        (str(chat && chat.expertName)
          ? teamViewT("原专家：") + str(chat.expertName) + " · "
          : "") + teamViewT("专家已删除 · 仅可回看历史，无法继续对话"),
      ),
    );
    head.appendChild(obox);
    return;
  }
  if (!exp) {
    head.appendChild(
      teamViewEl(
        "div",
        "team-main-role",
        teamViewT("还没有专家：点左栏「专家」旁的 ＋ 新建一位。"),
      ),
    );
    return;
  }
  var av = teamViewAvatar(exp, "lg");
  head.appendChild(av);

  var idbox = teamViewEl("div", "team-main-id");
  idbox.appendChild(teamViewEl("div", "team-main-name", exp.name || exp.id));
  idbox.appendChild(
    teamViewEl(
      "div",
      "team-main-role",
      (exp.role || teamViewT("专家")) + (chat ? " · " + (chat.title || "") : ""),
    ),
  );
  head.appendChild(idbox);

  /* 分类下拉：直接改这位专家的分组（左侧栏树状图随之重排）。 */
  var catSel = document.createElement("select");
  catSel.className = "team-cat-sel";
  teamViewCategoryOptions(exp.category).forEach(function (o) {
    var opt = document.createElement("option");
    opt.value = o[0];
    opt.textContent = o[1];
    catSel.appendChild(opt);
  });
  catSel.value = str(exp.category);
  catSel.title = teamViewT("该专家所属分类");
  catSel.addEventListener("change", function () {
    if (catSel.value !== "__new__") {
      teamUpdateExpert(exp.id, { category: catSel.value });
      renderTeamPane();
      return;
    }
    var back = str(exp.category);
    teamViewNewCategory().then(function (name) {
      if (!name) {
        catSel.value = back;
        return;
      }
      teamUpdateExpert(exp.id, { category: name });
      renderTeamPane();
    });
  });
  head.appendChild(catSel);
  head.appendChild(teamViewEl("div", "team-spacer"));

  /* 供应商 / 模型：改动直接写回该专家的 model（teamUpdateExpert 深合并），
     即「这位专家用哪个模型」，不是全局设置。 */
  var curProv = (exp.model && exp.model.provider) || "deepseek-official";
  var provSel = document.createElement("select");
  teamViewProviders().forEach(function (p) {
    var o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.name;
    provSel.appendChild(o);
  });
  if (
    !Array.prototype.some.call(provSel.options, function (o) {
      return o.value === curProv;
    })
  ) {
    var extra = document.createElement("option");
    extra.value = curProv;
    extra.textContent = curProv;
    provSel.appendChild(extra);
  }
  provSel.value = curProv;
  provSel.title = teamViewT("该专家使用的服务商");
  provSel.addEventListener("change", function () {
    var list = teamViewModelsFor(provSel.value);
    teamUpdateExpert(exp.id, {
      model: { provider: provSel.value, model: list[0] || "" },
    });
    renderTeamPane();
  });
  head.appendChild(provSel);

  var models = teamViewModelsFor(curProv);
  var curModel = (exp.model && exp.model.model) || models[0] || "";
  if (curModel && models.indexOf(curModel) < 0) models = [curModel].concat(models);
  var modelSel = document.createElement("select");
  models.forEach(function (m) {
    var o = document.createElement("option");
    o.value = m;
    o.textContent = m;
    modelSel.appendChild(o);
  });
  modelSel.value = curModel;
  modelSel.title = teamViewT("该专家使用的模型");
  modelSel.addEventListener("change", function () {
    teamUpdateExpert(exp.id, { model: { model: modelSel.value } });
  });
  head.appendChild(modelSel);
}

/* ── 聊天区 ── */

function teamViewNearBottom(list) {
  if (!list) return true;
  return list.scrollHeight - list.scrollTop - list.clientHeight < 80;
}

function teamViewLastUserText(chat) {
  var msgs = (chat && chat.messages) || [];
  for (var i = msgs.length - 1; i >= 0; i--)
    if (msgs[i] && msgs[i].role === "user") return String(msgs[i].content || "");
  return "";
}

/* 单路运行行：署名 = 这一路的专家（stream.speaker），内容只取该路自己的流式缓冲。
   并行作答时每位专家各占一行，互不覆盖；单聊沿用同一实现（stream 省略即用会话记录）。 */
function teamViewLiveRow(chat, stream) {
  var live = teamLiveOf(chat && chat.id) || {};
  var s = stream || live;
  var row = teamViewEl("div", "dsh-msg dsh-ai team-live-row");
  var head = teamViewEl("div", "dsh-msg-head");
  var sp = s.speaker || live.speaker;
  var label = teamViewT("AI · 运行中");
  if (sp) {
    label = (sp.name || teamViewT("专家")) + teamViewT(" · 运行中");
    var av = teamViewAvatar(
      { icon: sp.icon, glyph: sp.glyph, color: sp.color },
      "",
      "span",
    );
    av.classList.add("team-msg-av");
    head.appendChild(av);
  }
  var roleEl = teamViewEl("span", "dsh-role live", label);
  if (sp && sp.color) roleEl.style.color = sp.color;
  head.appendChild(roleEl);
  row.appendChild(head);
  if (s.reasoning && String(s.reasoning).trim()) {
    var det = teamViewEl("details", "dsh-think");
    det.appendChild(
      teamViewEl(
        "summary",
        null,
        teamViewT("思考过程 · ") +
          String(s.reasoning).length +
          teamViewT(" 字"),
      ),
    );
    var pre = document.createElement("pre");
    pre.textContent = s.reasoning;
    det.appendChild(pre);
    row.appendChild(det);
  }
  if (s.tools && s.tools.length && typeof dshToolDetailsEl === "function") {
    var chips = teamViewEl("div", "dsh-tools");
    s.tools.forEach(function (t) {
      try {
        chips.appendChild(dshToolDetailsEl(t, true, chat.id));
      } catch (_) {}
    });
    row.appendChild(chips);
  }
  var body = teamViewEl("div", "dsh-msg-body dsh-stream");
  body.textContent = s.pending || "";
  row.appendChild(body);
  return row;
}

/* 当前会话的运行行：单聊一行；群聊按本轮参与顺序，每位在跑的专家各一行（并行流式）。 */
function teamViewLiveRows(chat) {
  var live = teamLiveOf(chat && chat.id);
  if (!live || !live.running) return [];
  if (!live.group) return [teamViewLiveRow(chat, live)];
  var ids = Array.isArray(live.order)
    ? live.order.slice()
    : Object.keys(live.streams || {});
  var rows = [];
  ids.forEach(function (id) {
    var s = live.streams && live.streams[id];
    if (s) rows.push(teamViewLiveRow(chat, s));
  });
  /* 兜底：分路还没建起来（主持人选人中 / 首个事件未到）时给一行整体运行提示。 */
  if (!rows.length) rows.push(teamViewLiveRow(chat, live));
  return rows;
}

/* ── 群聊消息：按头像 + 角色名署名；建议卡单独成卡 ── */

function teamViewGroupMsg(m, chat, idx) {
  if (m && m.kind === "advice") return teamViewAdviceCardEl(m, chat, idx);
  var row =
    typeof dshMsgBlock === "function"
      ? dshMsgBlock(m, chat.id, idx, {})
      : teamViewEl("div", "dsh-msg");
  if (m && m.role === "assistant") {
    var head = row.querySelector ? row.querySelector(".dsh-msg-head") : null;
    if (head) {
      var role = head.querySelector(".dsh-role");
      if (role) {
        role.textContent = m.name || teamViewT("专家");
        if (m.color) role.style.color = m.color;
      }
      var av = teamViewAvatar(
        { icon: m.icon, glyph: m.glyph, color: m.color },
        "",
        "span",
      );
      av.classList.add("team-msg-av");
      head.insertBefore(av, head.firstChild);
    }
    if (m.error)
      row.appendChild(teamViewEl("div", "team-msg-err", "⚠ " + m.error));
  }
  return row;
}

function teamViewAdviceSec(title, arr, fmt) {
  if (!arr || !arr.length) return null;
  var d = teamViewEl("div", "team-advice-sec");
  d.appendChild(teamViewEl("div", "team-advice-sec-t", title));
  var ul = teamViewEl("ul", "team-advice-list");
  arr.forEach(function (x) {
    ul.appendChild(teamViewEl("li", null, fmt ? fmt(x) : String(x)));
  });
  d.appendChild(ul);
  return d;
}

function teamViewAdviceCardEl(m, chat, idx) {
  var card =
    window.MTNodeTeam && window.MTNodeTeam.normalizeAdviceCard
      ? window.MTNodeTeam.normalizeAdviceCard(m.card)
      : m.card || {};
  var wrap = teamViewEl("div", "team-advice");

  var head = teamViewEl("div", "team-advice-head");
  head.appendChild(
    teamViewEl("span", "team-advice-badge", "💡 " + teamViewT("建议卡")),
  );
  head.appendChild(
    teamViewEl(
      "span",
      "team-advice-title",
      card.title || card.conclusion.slice(0, 40) || teamViewT("建议"),
    ),
  );
  if (card.confidence)
    head.appendChild(
      teamViewEl("span", "team-advice-conf", teamViewT("置信度 ") + card.confidence),
    );
  wrap.appendChild(head);

  var body = teamViewEl("div", "team-advice-body");
  if (card.conclusion) {
    var cd = teamViewEl("div", "team-advice-sec");
    cd.appendChild(teamViewEl("div", "team-advice-sec-t", teamViewT("结论")));
    cd.appendChild(teamViewEl("div", "team-advice-concl", card.conclusion));
    body.appendChild(cd);
  }
  if (card.rationale) {
    var rd = teamViewEl("div", "team-advice-sec");
    rd.appendChild(teamViewEl("div", "team-advice-sec-t", teamViewT("理由")));
    rd.appendChild(teamViewEl("div", "team-advice-concl", card.rationale));
    body.appendChild(rd);
  }
  [
    teamViewAdviceSec(teamViewT("依据"), card.evidence),
    teamViewAdviceSec(teamViewT("少数意见（原文保留）"), card.dissent, function (d) {
      return (
        (d.role ? d.role + "：" : "") +
        d.point +
        (d.reason ? "（未采纳：" + d.reason + "）" : "")
      );
    }),
    teamViewAdviceSec(teamViewT("未收敛分歧"), card.unresolved),
    teamViewAdviceSec(teamViewT("待验证假设"), card.assumptions),
    teamViewAdviceSec(teamViewT("下一步"), card.nextActions, function (a) {
      return (
        a.action +
        (a.owner ? "（" + a.owner + "）" : "") +
        (a.due ? " 截止 " + a.due : "")
      );
    }),
  ].forEach(function (el) {
    if (el) body.appendChild(el);
  });
  wrap.appendChild(body);

  var foot = teamViewEl("div", "team-advice-foot");
  if (m.adopted) {
    var done =
      m.adopted === "decision"
        ? teamViewT("已采纳为决策记录")
        : m.adopted === "todo"
          ? teamViewT("已采纳为待办")
          : teamViewT("已存档");
    foot.appendChild(teamViewEl("span", "team-advice-done", done));
    if (m.adoptedPath)
      foot.appendChild(teamViewEl("span", "team-advice-path", m.adoptedPath));
  } else {
    var b1 = teamViewEl("button", "team-advice-btn", teamViewT("采纳并生成待办"));
    b1.type = "button";
    b1.addEventListener("click", function () {
      teamAdviceAdopt(chat, idx, "todo");
    });
    var b2 = teamViewEl(
      "button",
      "team-advice-btn",
      teamViewT("采纳为决策记录"),
    );
    b2.type = "button";
    b2.addEventListener("click", function () {
      teamAdviceAdopt(chat, idx, "decision");
    });
    var b3 = teamViewEl("button", "team-advice-btn ghost", teamViewT("仅存档"));
    b3.type = "button";
    b3.addEventListener("click", function () {
      teamAdviceAdopt(chat, idx, "archive");
    });
    foot.appendChild(b1);
    foot.appendChild(b2);
    foot.appendChild(b3);
  }
  if (m.advicePath)
    foot.appendChild(
      teamViewEl("span", "team-advice-path", teamViewT("建议文件：") + m.advicePath),
    );
  wrap.appendChild(foot);
  return wrap;
}

/* 一键采纳：只有用户点按钮才写文件；采纳前不写 decisions/、不生成待办。 */
async function teamAdviceAdopt(chat, idx, mode) {
  var live = teamChat(chat && chat.id);
  if (!live) return;
  var msgs = (live.messages || []).slice();
  var m = msgs[idx];
  if (!m || m.kind !== "advice" || m.adopted) return;
  var path = "";
  try {
    if (mode !== "archive" && window.MTNodeTeam && window.MTNodeTeam.adoptAdvice)
      path = await window.MTNodeTeam.adoptAdvice(live, m.card, mode);
  } catch (err) {
    if (typeof toast === "function")
      toast((err && err.message) || String(err || ""), "warn");
    return;
  }
  m.adopted = mode;
  if (path) m.adoptedPath = path;
  teamUpdateChat(live.id, { messages: msgs });
  if (typeof toast === "function")
    toast(
      (mode === "archive"
        ? teamViewT("已存档")
        : teamViewT("已采纳")) + (path ? " · " + path : ""),
      "ok",
    );
  renderTeamPane();
}

function teamViewRenderMsgs(chat) {
  var list = document.getElementById("teamChatListMsgs");
  if (!list) return;
  var stick = teamViewNearBottom(list);
  var live = teamLiveOf(chat && chat.id);
  var runningHere = !!(live && live.running);
  list.innerHTML = "";
  var msgs = (chat && chat.messages) || [];
  if (!msgs.length && !runningHere) {
    list.appendChild(
      teamViewEl(
        "div",
        "team-chat-empty",
        chat
          ? chat.kind === "group"
            ? teamViewT(
                "向圆桌提问：主持人为本轮挑选相关专家（不全员），专家并行独立作答，再由主持人汇总建议卡；也可以 @某位专家定向提问。",
              )
            : teamViewT("开始和这位专家聊聊你的项目。")
          : teamViewT("在左侧选择一位专家开始对话。"),
      ),
    );
  }
  if (chat && chat.kind === "group") {
    for (var i = 0; i < msgs.length; i++) {
      try {
        list.appendChild(teamViewGroupMsg(msgs[i], chat, i));
      } catch (e) {
        try {
          console.error("群聊消息渲染失败: idx=" + i, e);
        } catch (_) {}
      }
    }
  } else if (chat && typeof dshMsgBlock === "function") {
    for (var j = 0; j < msgs.length; j++) {
      try {
        list.appendChild(dshMsgBlock(msgs[j], chat.id, j, {}));
      } catch (e) {
        try {
          console.error("团队消息渲染失败: idx=" + j, e);
        } catch (_) {}
      }
    }
  }
  if (runningHere)
    teamViewLiveRows(chat).forEach(function (row) {
      list.appendChild(row);
    });
  if (live && !live.running) {
    if (live.err) {
      var er = teamViewEl("div", "dsh-msg dsh-ai");
      er.appendChild(teamViewEl("div", "dsh-msg-head", teamViewT("运行失败")));
      er.appendChild(teamViewEl("div", "dsh-msg-body", "⚠ " + live.err));
      list.appendChild(er);
    }
    /* 重发：接在最后一条 AI 回复尾部（复用会话视图的 .dsh-msg-rollback 小按钮样式）。
       群聊的重发在建议卡上走自己的按钮，这里只服务单聊。 */
    if (!(chat && chat.kind === "group") && teamViewLastUserText(chat)) {
      var rows = list.querySelectorAll(".dsh-msg.dsh-ai");
      var last = rows[rows.length - 1];
      if (last) {
        var tail = last.querySelector(".dsh-msg-tail");
        if (!tail) {
          tail = teamViewEl("div", "dsh-msg-tail");
          last.appendChild(tail);
        }
        var rb = teamViewEl("button", "dsh-msg-rollback", teamViewT("↻ 重发"));
        rb.type = "button";
        rb.title = teamViewT("重发上一条消息");
        rb.addEventListener("click", function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          teamChatRetry();
        });
        tail.appendChild(rb);
      }
    }
  }
  if (stick) list.scrollTop = list.scrollHeight;
}

function teamViewPaintSend() {
  var b = document.getElementById("teamChatSend");
  if (!b) return;
  var live = teamLiveCurrent();
  var running = !!(live && live.running);
  b.textContent = running ? teamViewT("终止") : teamViewT("发送");
  b.classList.toggle("danger", running);
  b.title = running
    ? teamViewT("终止当前运行")
    : teamViewT("发送（Enter 发送，Shift+Enter 换行）");
}

function teamViewSchedulePaint() {
  if (teamViewRaf) return;
  teamViewRaf = requestAnimationFrame(function () {
    teamViewRaf = 0;
    var st = teamViewEnsure();
    teamViewRenderMsgs(st.chat);
    teamViewPaintSend();
  });
}

/* ── 运行 ── */

function teamViewSystemPrompt(exp) {
  /* 人设装配的真源在 app-team.js（与运行接线同处一处，避免两份拼法漂移）；
     该模块未加载时才退回本文件的兜底拼装。 */
  if (typeof window.teamExpertSystemPrompt === "function")
    return window.teamExpertSystemPrompt(exp);
  var p = (exp && exp.prompt) || {};
  var pe = (exp && exp.persona) || {};
  var lines = [];
  lines.push(
    teamViewT("你是「") +
      (exp.name || teamViewT("专家")) +
      "」" +
      (exp.role ? "（" + exp.role + "）" : "") +
      "。",
  );
  if (p.identity) lines.push(p.identity);
  if (pe.tagline) lines.push(teamViewT("简介：") + pe.tagline);
  if (pe.background) lines.push(teamViewT("背景：") + pe.background);
  if (pe.expertise && pe.expertise.length)
    lines.push(teamViewT("专长：") + pe.expertise.join("、"));
  if (pe.style) lines.push(teamViewT("表达风格：") + pe.style);
  if (pe.tone) lines.push(teamViewT("语气：") + pe.tone);
  if (pe.language) lines.push(teamViewT("回答语言：") + pe.language);
  if (p.goal) lines.push(teamViewT("目标：") + p.goal);
  if (p.constraints) lines.push(teamViewT("约束：") + p.constraints);
  if (p.output) lines.push(teamViewT("输出要求：") + p.output);
  lines.push(
    teamViewT(
      "你只做文本工作：不读写文件、不操作画布。工具回执里没有的结果不要声称已完成。",
    ),
  );
  return lines.join("\n");
}

/* 历史 + 最新一轮：团队会话不续跑 dsh 会话，每轮把可见上下文重新拼进去（最近 12 条） */
function teamViewBuildInput(chat) {
  var msgs = ((chat && chat.messages) || []).slice(-12);
  var parts = [];
  msgs.forEach(function (m, i) {
    var last = i === msgs.length - 1;
    var who =
      m.role === "user"
        ? last
          ? teamViewT("用户(最新)")
          : teamViewT("用户")
        : teamViewT("助手");
    parts.push(who + "：" + String(m.content || ""));
  });
  return parts.join("\n\n");
}

/* 事件入口：live = **该会话自己的运行态**（不再读写全局单例，多个会话可同时流式）。
   群聊一轮有多位专家并行 → 事件按 exp 分路落入 live.streams[expertId]，各占一行互不覆盖；
   单聊没有分路，仍落回会话自己的记录。 */
function teamViewOnEvent(live, type, data, exp) {
  if (!live) return;
  var target = live;
  if (live.group) {
    target = teamLiveStreamEnsure(live, exp || live.speaker);
  } else if (exp) {
    live.speaker = exp;
  }
  if (teamLiveApply(target, type, data)) teamViewSchedulePaint();
}

/* 按会话生成 onEvent 回调：运行链路只拿到这个闭包，用户切到别的会话后
   流式内容仍落回它自己的会话运行态，不会串到当前显示的会话上。 */
function teamViewOnEventFor(chatId) {
  return function (type, data, exp) {
    teamViewOnEvent(teamLiveOf(chatId), type, data, exp);
  };
}

function teamViewAppendAssistant(chat, content, reasoning, tools) {
  var msgs = (chat.messages || []).slice();
  var m = { role: "assistant", content: String(content == null ? "" : content) };
  if (reasoning && String(reasoning).trim()) m.reasoning = String(reasoning);
  if (tools && tools.length) m.tools = tools.slice();
  msgs.push(m);
  teamUpdateChat(chat.id, { messages: msgs });
}

async function teamViewRun(chat, exp) {
  var runKey = "team:" + chat.id;
  var live = teamLivePut(chat.id, {
    chatId: chat.id,
    running: true,
    pending: "",
    reasoning: "",
    tools: [],
    err: "",
    speaker: null,
    stopped: false,
  });
  var onEvent = teamViewOnEventFor(chat.id);
  teamViewRenderMsgs(chat);
  teamViewPaintSend();
  var input = teamViewBuildInput(chat);
  try {
    /* 后续若出现独立的团队执行引擎，优先让它接管这一轮 */
    if (
      window.MTNodeTeamChat &&
      typeof window.MTNodeTeamChat.run === "function"
    ) {
      var r = await window.MTNodeTeamChat.run({
        chat: chat,
        expert: exp,
        input: input,
        runKey: runKey,
        systemPrompt: teamViewSystemPrompt(exp),
        onEvent: onEvent,
      });
      var text = (r && (r.text || r.content)) || live.pending || "";
      teamViewAppendAssistant(chat, text, live.reasoning, live.tools);
    } else if (typeof dshRunTask === "function") {
      var final = await dshRunTask(input, {
        runKey: runKey,
        workspace: (S && S.dshWorkspaceFallback) || "",
        provider: (exp.model && exp.model.provider) || "deepseek-official",
        model: (exp.model && exp.model.model) || undefined,
        effort: (exp.model && exp.model.effort) || "high",
        preset: (exp.model && exp.model.preset) || undefined,
        permissionPreset: (exp.perm && exp.perm.permissionPreset) || undefined,
        systemPrompt: teamViewSystemPrompt(exp),
        /* 画布整档闸与 app-team.js expertRunParams 同口径（共用 MTNodeTeam.expertNoCanvas）：
           本专家把画布六类全拒才摘掉画布三件套；默认许可放行了「读画布」，故默认注册。
           取不到团队模块时退回旧行为（不碰画布）。 */
        noCanvas:
          window.MTNodeTeam && typeof window.MTNodeTeam.expertNoCanvas === "function"
            ? window.MTNodeTeam.expertNoCanvas(exp)
            : true,
        onEvent: onEvent,
      });
      teamViewAppendAssistant(
        chat,
        String(final == null ? "" : final),
        live.reasoning,
        live.tools,
      );
    } else {
      teamViewAppendAssistant(
        chat,
        teamViewT("（未接通智能引擎，无法回复）"),
        "",
        [],
      );
    }
  } catch (err) {
    live.err = (err && err.message) || String(err || "");
  } finally {
    live.running = false;
    renderTeamPane();
  }
}

/* ── 群聊：圆桌一轮 = 参与者并行独立 run（按专家分路流式）；主持聚合 = 建议卡 ── */

/* 初始化（或重置）某会话的群聊运行态；返回该 live 记录，后续读写都走它，
   不再碰别的会话的运行态（多个会话可同时各跑一轮）。
   streams / order 见 teamLiveStreamEnsure：并行作答按专家分路，一步一行。 */
function teamGroupLiveInit(chat) {
  return teamLivePut(chat && chat.id, {
    chatId: chat && chat.id,
    group: true,
    running: true,
    pending: "",
    reasoning: "",
    tools: [],
    streams: {},
    order: [],
    err: "",
    speaker: null,
    stopped: false,
  });
}

/* 圆桌一轮：selectParticipants 先决定本轮参与人（不全员，@ 定向优先），
   参与者**并行**各跑一次独立 run（各自 runKey / 模型 / 权限），跑完后按参与顺序
   落为署名消息；一轮结束即请主持人汇总出建议卡（「收敛出建议」按钮保留手动再汇总）。 */
async function teamGroupRun(chat, text) {
  var TEAM = window.MTNodeTeam;
  if (!TEAM || typeof TEAM.runGroupRound !== "function") {
    if (typeof toast === "function")
      toast(teamViewT("（未接通群聊引擎）"), "warn");
    return;
  }
  var round = Math.max(1, Math.floor(Number(chat.round) || 0) + 1);
  var live = teamGroupLiveInit(chat);
  teamViewRenderMsgs(chat);
  teamViewPaintSend();
  try {
    var r = await TEAM.runGroupRound({
      chat: chat,
      text: text,
      round: round,
      onEvent: function (type, data, exp) {
        teamViewOnEvent(live, type, data, exp);
      },
      shouldStop: function () {
        return !!live.stopped;
      },
    });
    /* 并行是「同时起跑、先后完成」：落库必须按参与顺序（r.messages 已按参与人序号回收），
       否则消息顺序会跟着完成快慢漂。 */
    var list = (r && r.messages) || [];
    if (list.length) {
      var cur = (teamChat(chat.id) || chat).messages || [];
      teamUpdateChat(chat.id, { messages: cur.concat(list) });
    }
    live.streams = {};
    live.order = [];
    teamUpdateChat(chat.id, { round: round });
    /* 一轮并行作答结束：自动请主持人汇总出建议卡（用户终止 / 全员失败则不汇总）。 */
    var spoke = list.some(function (m) {
      return !!(m && m.content);
    });
    if (spoke && !live.stopped) await teamGroupAggregate(teamChat(chat.id) || chat);
  } catch (err) {
    live.err = (err && err.message) || String(err || "");
  } finally {
    live.running = false;
    live.streams = {};
    live.order = [];
    renderTeamPane();
  }
}

/* 主持人聚合：跑一次主持人的独立 run → 解析建议卡 → 落 <工作区>/advice/*.md。
   只产出「建议」，采纳与否由用户在建议卡上点。聚合走自己的那一路流，
   不覆盖并行作答的专家行（先清空 streams / order 再起主持人的路）。 */
async function teamGroupAggregate(chat) {
  var TEAM = window.MTNodeTeam;
  if (!TEAM || typeof TEAM.aggregateGroup !== "function") return;
  chat = teamChat(chat && chat.id) || chat;
  if (!chat) return;
  var live = teamLiveOf(chat.id) || teamGroupLiveInit(chat);
  var fac = TEAM.facilitatorOf(chat);
  live.running = true;
  live.err = "";
  live.speaker = fac || null;
  live.pending = "";
  live.reasoning = "";
  live.tools = [];
  live.streams = {};
  live.order = [];
  teamViewRenderMsgs(chat);
  teamViewPaintSend();
  var r = await TEAM.aggregateGroup({
    chat: chat,
    onEvent: function (type, data) {
      teamViewOnEvent(live, type, data, fac || null);
    },
  });
  var path = "";
  try {
    path = await TEAM.writeAdviceFile(chat, r.card);
  } catch (e) {
    path = "";
  }
  var msg = {
    role: "assistant",
    kind: "advice",
    content: r.text,
    card: r.card,
    expertId: r.facilitator.id,
    name: r.facilitator.name,
    glyph: r.facilitator.glyph,
    color: r.facilitator.color,
  };
  if (path) msg.advicePath = path;
  var cur = (teamChat(chat.id) || chat).messages || [];
  var next = cur.slice();
  next.push(msg);
  teamUpdateChat(chat.id, { messages: next });
}

/* 「收敛出建议」按钮：不新开一轮，只让主持人汇总当前讨论。 */
async function teamGroupAggregateNow() {
  var st = teamViewEnsure();
  var chat = st && st.chat;
  if (!chat || chat.kind !== "group") return;
  /* 只挡「当前会话已在跑」，别的会话照旧可以继续对话 / 运行。 */
  if (teamLiveOf(chat.id) && teamLiveOf(chat.id).running) return;
  var live = teamGroupLiveInit(chat);
  try {
    await teamGroupAggregate(chat);
  } catch (err) {
    live.err = (err && err.message) || String(err || "");
  } finally {
    live.running = false;
    renderTeamPane();
  }
}

async function teamChatSend() {
  var st = teamViewEnsure();
  var chat = st && st.chat;
  var exp = st && st.exp;
  /* 并发闸只看「这条会话自己有没有在跑」：别的专家 / 别的会话可以同时对话。 */
  if (chat && teamLiveOf(chat.id) && teamLiveOf(chat.id).running) return;
  var group = !!(chat && chat.kind === "group");
  /* 孤儿会话（原专家已删除）：只可回看历史，不能继续对话。 */
  if (chat && !group && !teamExpert(chat.expertId)) {
    if (typeof toast === "function")
      toast(teamViewT("该会话的专家已删除，只能回看历史"), "warn");
    return;
  }
  /* 判据只看「有没有专家 / 群聊」，不再要求 chat 已存在：新招的角色还没开过会话时，
     chat 为 null 但专家已选中，不能因此报「先在左侧选择项目和专家」。 */
  if (!exp && !group) {
    if (typeof toast === "function")
      toast(teamViewT("先在左侧选择项目和专家"), "warn");
    return;
  }
  var inp = document.getElementById("teamChatInput");
  var text = inp ? String(inp.value || "").trim() : "";
  if (!text) return;
  /* 已选专家但还没有会话：就地补一段单聊（等价于点角色行右侧的「＋」），再发这条消息。 */
  if (!chat && exp) {
    chat = teamViewNewChatFor(exp);
    if (!chat) return;
    group = false;
    inp = document.getElementById("teamChatInput") || inp;
  }
  if (inp) inp.value = "";
  var msgs = (chat.messages || []).slice();
  msgs.push({ role: "user", content: text });
  teamUpdateChat(chat.id, { messages: msgs });
  if (
    !chat.title ||
    chat.title === teamViewT("新对话") ||
    chat.title === teamViewT("圆桌讨论")
  )
    teamUpdateChat(chat.id, { title: text.slice(0, 24) });
  if (group) await teamGroupRun(teamChat(chat.id) || chat, text);
  else await teamViewRun(chat, exp);
}

async function teamChatRetry() {
  var st = teamViewEnsure();
  var chat = st && st.chat;
  if (!chat) return;
  if (teamLiveOf(chat.id) && teamLiveOf(chat.id).running) return;
  /* 去掉上一次失败的尾部回复，回到「以用户消息结尾」的状态再跑 */
  var msgs = (chat.messages || []).slice();
  while (msgs.length && msgs[msgs.length - 1].role !== "user") msgs.pop();
  if (!msgs.length) return;
  teamUpdateChat(chat.id, { messages: msgs });
  if (chat.kind === "group")
    await teamGroupRun(teamChat(chat.id) || chat, teamViewLastUserText(chat));
  else if (st.exp) await teamViewRun(chat, st.exp);
}

/* 终止：只终止当前视图这条会话的运行（其它会话照旧跑，互不影响）。
   群聊一轮有多位专家并行在跑（runKey = team:<chatId>:<expertId>），
   这里传会话级 "team:<chatId>"：app-team.js 的 stopExpert 会一次取消该会话
   **本轮全部**在跑的 runKey（含主持人选人 / 聚合 run），不再只停第一位。 */
function teamChatStop() {
  var live = teamLiveCurrent();
  if (!live || !live.running) return;
  live.stopped = true;
  var runKey = "team:" + live.chatId;
  try {
    if (window.MTNodeTeamChat && typeof window.MTNodeTeamChat.stop === "function")
      window.MTNodeTeamChat.stop(runKey);
    else if (typeof dshCancelActive === "function") dshCancelActive(runKey);
  } catch (_) {}
}

/* ── 交互绑定（一次性） ── */

function teamViewBind() {
  if (teamViewBound) return;
  teamViewBound = true;

  /* 标题右侧「复制」：把当前画布团队增量复制到其他画布（弹说明 + 选目标画布）。 */
  var copyBtn = document.getElementById("teamCopyBtn");
  if (copyBtn)
    copyBtn.addEventListener("click", function () {
      openTeamCopyDlg();
    });

  /* 统一编辑权限：左栏「🔐 权限」→ 一次设置本画布 / 全部画布所有专家的审批档与工具许可。
     对话框在 app-team-recruit.js（权限 UI 单一真源）；模块未加载时 warn，不抛错。 */
  var permAll = document.getElementById("teamPermAllBtn");
  if (permAll)
    permAll.addEventListener("click", function () {
      var st = teamViewEnsure();
      var canvasId = (st && st.canvasId) || "";
      if (typeof window.teamPermBatchOpen !== "function") {
        if (typeof toast === "function") toast(teamViewT("统一编辑入口未就绪"), "warn");
        return;
      }
      window.teamPermBatchOpen(canvasId, function () {
        renderTeamPane();
      });
    });

  var addE = document.getElementById("teamAddExpert");
  if (addE)
    addE.addEventListener("click", function () {
      var st = teamViewEnsure();
      var canvasId = (st && st.canvasId) || "";
      /* 招募面板（app-team-recruit.js）在时走它：写人设 / 选模型 / 调许可，录用后自动选中。
         面板不在（该模块未加载）时退回「新建一位空白专家」，保证视图始终可用。 */
      if (typeof window.teamRecruitManual === "function") {
        window.teamRecruitManual(canvasId, null, function (e) {
          /* 录用成功后无条件重渲染：否则「外部 / 左栏」看不到刚招到的专家。 */
          if (e)
            teamViewSetSel({
              canvasId: str(e.canvasId || e.projectId) || canvasId,
              expertId: e.id,
              chatId: "",
            });
          renderTeamPane();
        });
        return;
      }
      var e = teamAddExpert({ projectId: canvasId, name: teamViewT("新专家") });
      if (!e) return;
      teamViewSetSel({
        canvasId: str(e.canvasId || e.projectId) || canvasId,
        expertId: e.id,
        chatId: "",
      });
      renderTeamPane();
    });

  /* 分类的新建 / 改名 / 删除已收口到招聘对话框（「管理分类」），
     左侧专家小节头不再放 🗂 新建分类按钮，分类树只保留折叠与浏览。 */

  /* 新建单聊已收口到左栏角色行右侧的「＋」（teamViewNewChatFor），顶部按钮已移除。 */

  /* ＋ 群聊：为当前项目开一张圆桌，参与者 = 该项目专家（最多 6 位，硬约束 3–6）。 */
  var newG = document.getElementById("teamNewGroup");
  if (newG)
    newG.addEventListener("click", function () {
      var st = teamViewEnsure();
      var proj = st && st.proj;
      if (!proj) {
        if (typeof toast === "function") toast(teamViewT("先建一个项目"), "warn");
        return;
      }
      var exps = teamExperts(proj.id);
      if (exps.length < 2) {
        if (typeof toast === "function")
          toast(teamViewT("至少需要 2 位专家才能开圆桌"), "warn");
        return;
      }
      var c = teamAddGroupChat({ projectId: proj.id });
      if (!c) return;
      teamViewSetSel({ canvasId: proj.id, chatId: c.id });
      renderTeamPane();
    });

  var send = document.getElementById("teamChatSend");
  if (send)
    send.addEventListener("click", function () {
      var live = teamLiveCurrent();
      if (live && live.running) teamChatStop();
      else teamChatSend();
    });

  var inp = document.getElementById("teamChatInput");
  if (inp)
    inp.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        /* 并发闸在 teamChatSend 内部按「当前会话」判，这里不再全局挡。 */
        teamChatSend();
      }
    });
}

/* ── 专家卡折叠区（右栏头部下方） ──
   默认收起；展开时复用招聘页的 renderExpertCard（单一真源，团队视图不另抄一份）。
   招聘模块未加载（renderExpertCard 不存在）时整块不渲染。
   展开态折叠头带「✎ 编辑」：复用招聘对话框的编辑模式（window.teamRecruitEdit），
   保存写回原专家（不新建），回调后重渲染卡片（teamViewCardOpen 保持该专家展开）。 */
function teamViewRenderExpertCard(st) {
  var box = document.getElementById("teamExpertCard");
  if (!box) return;
  box.innerHTML = "";
  var exp = st && st.exp;
  var chat = st && st.chat;
  if (!exp || (chat && chat.kind === "group") || typeof window.renderExpertCard !== "function") {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  var open = teamViewCardOpen === exp.id;
  var fold = teamViewEl("button", "team-card-fold" + (open ? " open" : ""));
  fold.type = "button";
  fold.appendChild(teamViewEl("span", "team-card-caret", open ? "▾" : "▸"));
  fold.appendChild(teamViewEl("span", "team-card-title", teamViewT("专家卡")));
  fold.appendChild(
    teamViewEl("span", "team-card-hint", teamViewT("✎ 可编辑设定与权限")),
  );
  if (open) {
    /* 编辑入口：独立按钮（点击不切换折叠），复用招聘对话框的编辑模式。 */
    var edit = teamViewEl("button", "team-card-edit", teamViewT("✎ 编辑"));
    edit.type = "button";
    edit.title = teamViewT("编辑该专家的设定与权限");
    edit.setAttribute("aria-label", teamViewT("编辑该专家的设定与权限"));
    edit.addEventListener("click", function (ev) {
      if (ev && ev.stopPropagation) ev.stopPropagation();
      if (ev && ev.preventDefault) ev.preventDefault();
      if (typeof window.teamRecruitEdit !== "function") {
        toast(teamViewT("编辑入口未就绪"), "warn");
        return;
      }
      window.teamRecruitEdit(exp.id, function () {
        renderTeamPane();
      });
    });
    fold.appendChild(edit);
  }
  fold.addEventListener("click", function () {
    teamViewCardOpen = open ? "" : exp.id;
    renderTeamPane();
  });
  box.appendChild(fold);
  if (!open) return;
  var body = teamViewEl("div", "team-card-body");
  box.appendChild(body);
  try {
    var fn = window.renderExpertCard;
    /* 两种签名都兼容：renderExpertCard(host, exp) 就地渲染，或 renderExpertCard(exp)
       返回 HTML 字符串 / 元素。 */
    var r = fn.length >= 2 ? fn(body, exp) : fn(exp);
    if (typeof r === "string") body.innerHTML = r;
    else if (r && r.nodeType === 1) body.appendChild(r);
  } catch (_) {
    body.innerHTML = "";
    body.appendChild(
      teamViewEl("div", "team-side-empty", teamViewT("专家卡渲染失败。")),
    );
  }
}

/* ── 切画布时的团队加载屏（防串线） ──
   上方切换画布 = 一次异步 loadWorkflow（先 flush 当前画布 → 读盘 → 清理环境 → 落配置），
   这段时间里 S.wf 还是走掉那张、新画布尚未就位。团队恒绑定当前画布，面板若此刻仍可交互，
   用户点到的就是上一张画布的专家 / 会话（串线），甚至把新会话挂到旧画布上。
   因此切换一开始就先盖住面板并屏蔽交互，等新画布对象落定（setForegroundWf →
   teamViewOnCanvasSwitch）再按新画布重渲染 + 撤屏；读取失败走 teamViewCancelCanvasSwitch。
   加载屏是 #teamPane 的最后一个子节点，重渲染只改内部容器，屏始终压在内容之上。 */
var teamViewSwitching = false;
var teamViewSwitchTimer = 0;

/* 目标画布名：优先画布 Tab 记忆（用户刚点的那个），拿不到退回 id。 */
function teamViewWfName(id) {
  var k = str(id);
  if (!k) return "";
  try {
    var list = (S && S.config && S.config.visitedWorkflows) || [];
    for (var i = 0; i < list.length; i++)
      if (list[i] && str(list[i].id) === k) return str(list[i].name) || k;
  } catch (_) {}
  return k;
}

/* 加载屏宿主：按需建一次，之后只切 .on。pane 不在（测试桩 / 视图未挂载）时返回 null。 */
function teamViewLoadingEl() {
  var pane = document.getElementById("teamPane");
  if (!pane) return null;
  var el = null;
  if (typeof pane.querySelector === "function")
    el = pane.querySelector(".team-pane-loading");
  if (!el) {
    el = teamViewEl("div", "team-pane-loading");
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.appendChild(teamViewEl("div", "team-pane-loading-spin"));
    el.appendChild(
      teamViewEl("div", "team-pane-loading-title", teamViewT("正在切换画布…")),
    );
    el.appendChild(teamViewEl("div", "team-pane-loading-name", ""));
    pane.appendChild(el);
  }
  return el;
}
function teamViewShowLoading(name) {
  var el = teamViewLoadingEl();
  if (!el) return;
  var nm = el.children[2];
  if (nm) nm.textContent = str(name);
  el.classList.add("on");
}
function teamViewHideLoading() {
  var el = teamViewLoadingEl();
  if (el) el.classList.remove("on");
}

/* 切换开始（loadWorkflow 开头调用）：只在团队视图盖屏，返回是否盖上了。
   兜底定时器：万一切换中途异常没走到收尾，8 秒后自动撤屏重渲染，不留死屏。 */
function teamViewBeginCanvasSwitch(id) {
  if (!S || S.view !== "team") return false;
  teamViewSwitching = true;
  teamViewShowLoading(teamViewWfName(id));
  if (teamViewSwitchTimer) clearTimeout(teamViewSwitchTimer);
  teamViewSwitchTimer = setTimeout(function () {
    teamViewSwitchTimer = 0;
    if (!teamViewSwitching) return;
    teamViewSwitching = false;
    if (S && S.view === "team") renderTeamPane();
    teamViewHideLoading();
  }, 8000);
  return true;
}

/* 切换落定（setForegroundWf 在「换的是另一张画布」时调用）：立刻按新画布重画团队并撤屏。 */
function teamViewOnCanvasSwitch() {
  if (teamViewSwitchTimer) {
    clearTimeout(teamViewSwitchTimer);
    teamViewSwitchTimer = 0;
  }
  var was = teamViewSwitching;
  teamViewSwitching = false;
  if (!was && (!S || S.view !== "team")) return false;
  if (S && S.view === "team") renderTeamPane();
  teamViewHideLoading();
  return true;
}

/* 切换取消（loadWorkflow 读盘失败等分支）：撤屏，按当前（仍是旧）画布重画。 */
function teamViewCancelCanvasSwitch() {
  return teamViewOnCanvasSwitch();
}

/* ── 总渲染入口（setView 与各交互都走它） ── */

/* 自动登记：专家用文件工具把新文档写进库目录后，配置里没有 docs[] 记录，左栏列不出来。
   渲染前先 fire-and-forget 扫一次库目录（app-factlib.js reconcile），把缺失的 .md 登记进库；
   确实新增了才再渲染一次。in-flight 标记防重入：reconcile 幂等，第二轮返回 added=0 即收敛。 */
var teamViewFactSyncing = {};
function teamViewFactSync(canvasId) {
  var id = str(canvasId);
  if (!id || teamViewFactSyncing[id]) return Promise.resolve(0);
  var lib = window.MTNodeFactLib;
  if (!lib || typeof lib.reconcile !== "function") return Promise.resolve(0);
  teamViewFactSyncing[id] = true;
  return Promise.resolve(lib.reconcile(id)).then(
    function (r) {
      delete teamViewFactSyncing[id];
      var added = Number(r && r.added) || 0;
      if (added > 0 && S && S.view === "team") renderTeamPane();
      return added;
    },
    function () {
      delete teamViewFactSyncing[id];
      return 0;
    },
  );
}

function renderTeamPane() {
  var pane = document.getElementById("teamPane");
  if (!pane) return;
  /* 切换中：保持加载屏，绝不画走掉那张画布的团队（串线根因）。 */
  if (teamViewSwitching) {
    var l = teamViewLoadingEl();
    if (l) l.classList.add("on");
    return;
  }
  teamViewBind();
  var st = teamViewEnsure();
  /* 先把专家直接写盘的新文档登记进库，再画左栏（登记到就自动再渲染一次）。 */
  teamViewFactSync(st && st.canvasId);
  teamViewRenderTitle(st);
  teamViewRenderExperts(st);
  teamViewRenderChats(st);
  teamViewRenderMain(st);
  teamViewRenderExpertCard(st);
  teamViewRenderMsgs(st && st.chat);
  teamViewPaintSend();
  /* 孤儿会话（专家已删除）：输入框禁用并改提示，避免用户白打一段发不出去的话。 */
  var inp = document.getElementById("teamChatInput");
  if (inp) {
    var dead = !!(st && st.orphan);
    inp.disabled = dead;
    inp.placeholder = dead
      ? teamViewT("专家已删除，只能回看历史")
      : teamViewT("给专家发消息…（Enter 发送，Shift+Enter 换行）");
  }
  /* 错位体检：库若还落在应用 / 项目源码目录，先问用户是否迁到画布文件夹 ——
     否则专家会话仍会顺着配置里的旧路径，把新文档继续写进开发项目目录。
     每个画布本次会话只问一遍（用户拒绝后不再打扰）；迁移成功则重画一次左栏。 */
  teamViewFactRelocateCheck(st && st.canvasId);
}

/* 错位体检节流表：画布 id → 本次会话已问过。 */
var teamViewFactRelocated = {};
function teamViewFactRelocateCheck(canvasId) {
  var id = str(canvasId);
  if (!id || teamViewFactRelocated[id]) return;
  teamViewFactRelocated[id] = true;
  if (typeof factlibRelocate !== "function") return;
  Promise.resolve(factlibRelocate(id)).then(
    function (moved) {
      if (moved) renderTeamPane();
    },
    function () {},
  );
}

window.renderTeamPane = renderTeamPane;
window.teamViewFactRelocateCheck = teamViewFactRelocateCheck;
window.teamViewFactSync = teamViewFactSync;
window.teamViewRefreshFactStats = teamViewRefreshFactStats;
window.teamChatSend = teamChatSend;
window.teamChatRetry = teamChatRetry;
window.teamChatStop = teamChatStop;
window.teamGroupRun = teamGroupRun;
window.teamGroupAggregateNow = teamGroupAggregateNow;
window.teamAdviceAdopt = teamAdviceAdopt;
