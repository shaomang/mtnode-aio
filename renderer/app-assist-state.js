"use strict";
/* ============================================================
 * renderer/app-assist-state.js — 助手侧三股流的独立状态仓（进程无关）
 *
 * 为什么有它（任务 8/8 · 会话流 / 活动流 / 文件树进程隔离）：
 *   这三股流原本各自散在三个渲染模块的私有状态里（app-assist.js 的 S.agentSessions /
 *   app-browser.js 的 BA.rows / app-sidebar-files.js 的 SF.cache），谁也不能离开画布进程。
 *   本文件把它们收成一份**纯数据**状态仓（只有数据 + 归一化 + 订阅，不碰 DOM、不碰
 *   window.api、不读盘），因此同一份代码能在两个进程里各跑一份：
 *     · 画布主窗：把 S / BA / SF 里的现况发布进来（旧的渲染路径一字未改，仍然读各自的源）；
 *     · 隔离渲染进程：吃主进程转发来的 patch，按这份状态自己画。
 *   两条通道并存，开关是 config 的 assist.isolation = off|on|window（off = 今天的内嵌路径）。
 *
 * 口径（与派单一致，改动前先读）：
 *   · 状态只增不改语义：sessions / stream / activity / tree 四块，各自带 rev；
 *   · 每次变更产出一条**可序列化 patch**（IPC 只传这个，不传 DOM / 函数 / 大对象）；
 *   · 会话流走**增量**（streamDelta：只追加尾巴段 + 回填变过的那一两段），绝不整表重发；
 *     整份 items 只在「首次 / 换会话 / 重连对齐」这三处发一次（reset 那一条）；
 *   · 容量一律有上限（流 600 段、活动 1200 条、每层目录 400 项），超了丢最旧；
 *   · 任何脏数据只丢字段、绝不抛 —— 这条链上抛一次就会把主进程的事件循环带塌。
 *
 * 用法：
 *   const store = MTAssistState.createStore();
 *   const off = store.subscribe((patch) => send(patch));
 *   store.setSessions(rows, currentId);
 *   另一侧：store.applyPatch(patch)（等价于本地发生同一次变更）。
 * ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root) root.MTAssistState = api;
})(typeof window !== "undefined" ? window : null, function () {
  const STREAM_CAP = 600; /* 会话流：一段 = 一次连续输出 / 一条工具 / 一条用户行 */
  const ACTIVITY_CAP = 1200; /* 活动流：内存里最多留这么多条（库里另有上限） */
  const TREE_DIR_CAP = 400; /* 文件树：单层最多记这么多项 */
  const TEXT_CAP = 20000; /* 单段文本上限：超长回答只留尾部（滚上去的没人看） */

  function text(v, cap) {
    const s = v == null ? "" : String(v);
    const n = cap || TEXT_CAP;
    return s.length > n ? s.slice(s.length - n) : s;
  }

  /* ── 归一化（脏数据只丢字段，不抛） ────────────────────────────────── */

  /* 会话行：只留左栏 / 隔离视图要画的那几格（正文不进来 —— 那是会话库的事）。 */
  function normSession(s) {
    const o = s && typeof s === "object" ? s : {};
    return {
      id: String(o.id || ""),
      title: text(o.title, 200),
      canvas: String(o.canvas || ""),
      assist: !!o.assist,
      running: !!o.running,
      archived: !!o.archived,
      lastAt: Number(o.lastAt) || 0,
      msgCount: Number(o.msgCount) || 0,
    };
  }

  /* 活动行：与 activity-store.js 落库的形状同一份（at / kind / sessionId / text / path / status）。 */
  function normActivity(r) {
    const o = r && typeof r === "object" ? r : {};
    return {
      at: Number(o.at) || Date.now(),
      kind: String(o.kind || "activity").slice(0, 32),
      sessionId: String(o.sessionId || ""),
      text: text(o.text, 2000),
      path: text(o.path, 600),
      status: String(o.status || "").slice(0, 32),
    };
  }

  /* ── 会话流：把 dsh 的一帧并进段列表 ──────────────────────────────────
     · text / reasoning：同 (reqId,turn,step,index) 的连续增量并进同一段（不新起段）；
     · tool / tool-result / tool-preparing：按 callId 归位，结果回填同一段；
     · say-end：给当前正文段收尾（下一段从这里重新起）；
     · error / done：留一行状态行，done 顺手把「运行中」清掉。
     返回 { items, changed }（items 可能是同一个数组引用 —— 调用方按 changed 决定是否派发）。 */
  function streamApply(items, ev) {
    const list = Array.isArray(items) ? items : [];
    const e = ev && typeof ev === "object" ? ev : {};
    const type = String(e.type || "");
    const d = e.data && typeof e.data === "object" ? e.data : {};
    const reqId = e.reqId == null ? "" : String(e.reqId);
    const turn = d.turn == null ? "" : d.turn;
    const step = d.step == null ? "" : d.step;
    const index = d.index == null ? "" : d.index;
    const segKey = reqId + "\u0001" + turn + "\u0001" + step + "\u0001" + index;
    const callId = String(d.callId == null ? "" : d.callId);
    const now = Date.now();
    const last = list.length ? list[list.length - 1] : null;
    let changed = false;

    const push = (item) => {
      list.push(item);
      changed = true;
      return item;
    };

    if (type === "text" || type === "reasoning") {
      const k = type === "text" ? "say" : "think";
      const chunk = typeof d.text === "string" ? d.text : "";
      if (!chunk) return { items: list, changed: false };
      /* 只与**队尾同键同种**的段合并：换块 / 换轮 / 换流一律另起一段 */
      if (last && last.k === k && last.key === segKey && !last.closed) {
        last.text = text(last.text + chunk);
        last.at = now;
        changed = true;
      } else {
        push({ k: k, key: segKey, text: text(chunk), at: now, closed: false });
      }
    } else if (type === "say-end") {
      if (last && (last.k === "say" || last.k === "think") && !last.closed) {
        last.closed = true;
        changed = true;
      }
    } else if (type === "tool-preparing") {
      if (!callId) return { items: list, changed: false };
      const seg = findTool(list, callId);
      const bytes = Number(d.bytes) || 0;
      if (seg) {
        seg.bytes = bytes;
        seg.name = String(d.name || seg.name || "");
        seg.at = now;
        changed = true;
      } else {
        push({
          k: "tool",
          key: callId,
          name: String(d.name || ""),
          status: "preparing",
          bytes: bytes,
          text: "",
          at: now,
        });
      }
    } else if (type === "tool") {
      if (!callId && !d.name) return { items: list, changed: false };
      const seg = findTool(list, callId);
      if (seg) {
        seg.name = String(d.name || seg.name || "");
        seg.status = "running";
        seg.at = now;
        changed = true;
      } else {
        push({
          k: "tool",
          key: callId,
          name: String(d.name || ""),
          status: "running",
          text: argLine(d.args),
          at: now,
        });
      }
    } else if (type === "tool-result") {
      const seg = findTool(list, callId);
      if (seg) {
        seg.status = d.ok === false ? "failed" : "done";
        seg.at = now;
        if (d.error) seg.text = text(String(d.error), 2000);
        changed = true;
      }
    } else if (type === "error") {
      push({ k: "err", text: text(d.message || "出错了"), at: now, closed: true });
    } else if (type === "done") {
      if (last && last.k === "running") {
        list.pop();
        changed = true;
      }
      if (d.paused) push({ k: "note", text: "本轮已暂停（保留上下文，可继续）", at: now, closed: true });
      else if (d.stopped) push({ k: "note", text: "本轮已终止", at: now, closed: true });
      else if (d.resumeUnavailable) push({ k: "note", text: "上下文已不可续，需要新起一轮", at: now, closed: true });
    }
    if (changed && list.length > STREAM_CAP) {
      list.splice(0, list.length - STREAM_CAP);
    }
    return { items: list, changed: changed };
  }

  function findTool(list, callId) {
    if (!callId) return null;
    for (let i = list.length - 1; i >= 0; i--) {
      const it = list[i];
      if (it && it.k === "tool" && it.key === callId) return it;
    }
    return null;
  }

  /* 按段编号找那一段（增量补丁的回填口）：从尾巴往前找，越新的越先命中。 */
  function findSegById(list, id) {
    if (!id) return null;
    for (let i = list.length - 1; i >= 0; i--) {
      const it = list[i];
      if (it && Number(it.id) === id) return it;
    }
    return null;
  }

  /* 工具入参一行摘要：只给「参数长什么样」，不序列化整棵树（大参数会拖垮这一帧）。 */
  function argLine(args) {
    if (args == null) return "";
    let s = "";
    try {
      s = typeof args === "string" ? args : JSON.stringify(args);
    } catch {
      s = "";
    }
    if (!s) return "";
    return text(s, 240);
  }

  function sessionsSig(rows) {
    let out = "";
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      out += r.id + "\u0002" + r.title + "\u0002" + (r.running ? 1 : 0) + "\u0002" + (r.archived ? 1 : 0) +
        "\u0002" + r.lastAt + "\u0002" + r.canvas + "\u0002" + (r.assist ? 1 : 0) + "\u0002" + r.msgCount + "\u0001";
    }
    return out;
  }

  /* ── 流式增量的两件小工具（发布侧算「这一段变没变」，接收侧照单回填） ──────────
     指纹只看「会变的那几格」：正文长度 / 时刻 / 收口 / 工具状态与名字 / 参数字节数。
     流式尾巴每帧都在变长（长度变），定稿段与历史段指纹恒定 → 不会进增量。 */
  function itemFp(it) {
    const o = it || {};
    return [
      String(o.text == null ? "" : o.text).length,
      Number(o.at) || 0,
      o.closed ? 1 : 0,
      String(o.status || ""),
      String(o.name || ""),
      Number(o.bytes) || 0,
    ].join("\u0001");
  }
  function itemPatch(it) {
    const o = it || {};
    const p = { text: o.text, at: Number(o.at) || 0 };
    if (o.closed) p.closed = true;
    if (o.status !== undefined) p.status = String(o.status || "");
    if (o.name !== undefined) p.name = String(o.name || "");
    if (o.bytes !== undefined) p.bytes = Number(o.bytes) || 0;
    return p;
  }

  function createStore() {
    const state = {
      rev: 0,
      sessions: { rows: [], currentId: "", sig: "" },
      stream: { sessionId: "", items: [], running: false, seq: 0 },
      activity: { rows: [], onlyCurrent: true, filter: "" },
      tree: { root: "", rootKind: "", dirs: {}, loading: {} },
    };
    const subs = new Set();
    let dirty = null; /* { kinds:Set } 攒着的变更种类（发布侧按拍取走） */
    /* ── 增量发布游标（只在发布侧用）────────────────────────────────────────
       fps：上次发出去的每一段「编号 → 指纹」，用来认出「这一段变过」；
       reset：下一拍必须发整份（首次 / 换会话 / 重连对齐之后）；
       sid / run：上次发出去的会话归属与运行位（它俩变了也得发一拍）。 */
    const sent = { fps: new Map(), reset: true, sid: "", run: false };

    /* 每段一个单调编号：两个进程按同一份事件序列各跑一遍，编号一致 ——
       增量补丁靠它归位，不靠下标（换成下标，头部一裁就全错位）。 */
    function stampIds() {
      const items = state.stream.items;
      let max = Number(state.stream.seq) || 0;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (!it) continue;
        const id = Number(it.id) || 0;
        if (!id) {
          it.id = max + 1;
          max = it.id;
        } else if (id > max) max = id;
      }
      state.stream.seq = max;
    }

    function mark(kind) {
      if (!dirty) dirty = { kinds: new Set() };
      dirty.kinds.add(kind);
    }
    function emit(patch) {
      if (!subs.size) return;
      for (const fn of Array.from(subs)) {
        try {
          fn(patch);
        } catch (e) {
          /* 订阅者自己炸了不该带塌状态仓 */
          if (typeof console !== "undefined" && console.error) console.error("assist-state sub:", e);
        }
      }
    }
    function commit(kind) {
      state.rev++;
      mark(kind);
      return { kind: kind, rev: state.rev };
    }

    const store = {
      state: state,

      subscribe(fn) {
        if (typeof fn !== "function") return () => {};
        subs.add(fn);
        return () => subs.delete(fn);
      },

      /* 发布侧用：取走「自上次以来变更过哪些块」（没有变更 = null）。 */
      takeDirty() {
        if (!dirty) return null;
        const kinds = Array.from(dirty.kinds);
        dirty = null;
        return { kinds: kinds, rev: state.rev };
      },

      /* 一条可分片的完整快照（隔离进程刚起来 / 重连时对齐用）。 */
      snapshot() {
        return {
          rev: state.rev,
          sessions: { rows: state.sessions.rows.slice(), currentId: state.sessions.currentId },
          stream: {
            sessionId: state.stream.sessionId,
            items: state.stream.items.slice(-200),
            running: state.stream.running,
          },
          activity: {
            rows: state.activity.rows.slice(-300),
            onlyCurrent: state.activity.onlyCurrent,
            filter: state.activity.filter,
          },
          tree: { root: state.tree.root, rootKind: state.tree.rootKind },
        };
      },

      /* ── 会话流的**增量**补丁（本次需求：只追加尾巴段，不整表重发）──────────────
         为什么不再整表发：一帧真正变动的只有「尾段那一格」与「刚回来的那张工具卡」，
         而整表一发就是 600 段（长回答一段能到 20KB）—— 每帧几百 KB 过 IPC，主进程
         还要 copy 一遍再发一遍，长回答期间这条链自己就成了瓶颈。
         返回（null = 自上次以来流没变，不必发）：
           { append:true, reset?, sessionId, running, drop, upd:[{id,patch}], rows:[新段] }
             · reset = 这一拍是整份对齐（首次 / 换会话 / 重连），data 里另带 items；
             · drop  = 从头部裁掉了几段（容量上限到了）；
             · upd   = 已发过、这一拍变了的段（流式尾巴变长 / 工具卡转「已完成」）；
             · rows  = 新追加的段（只追加尾巴）。
         接收侧 applyPatch 照这份协议「追加 + 回填」，不整表替换。 */
      streamDelta(opts) {
        stampIds();
        const o = opts || {};
        const items = state.stream.items;
        const head = {
          append: true,
          sessionId: String(state.stream.sessionId || ""),
          running: !!state.stream.running,
        };
        if (o.reset || sent.reset) {
          sent.reset = false;
          sent.sid = head.sessionId;
          sent.run = head.running;
          sent.fps = new Map();
          for (const it of items) {
            const id = Number(it && it.id) || 0;
            if (id) sent.fps.set(id, itemFp(it));
          }
          return Object.assign({ reset: true, drop: 0, upd: [], rows: [], items: items.slice() }, head);
        }
        const upd = [];
        const rows = [];
        const now = new Map();
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          const id = Number(it && it.id) || 0;
          if (!id) continue; /* 没编号的脏段不进增量（下一条 reset 会带上它） */
          const fp = itemFp(it);
          now.set(id, fp);
          const prev = sent.fps.get(id);
          if (prev === undefined) rows.push(it);
          else if (prev !== fp) upd.push({ id: id, patch: itemPatch(it) });
        }
        let drop = 0;
        for (const id of sent.fps.keys()) if (!now.has(id)) drop++;
        const moved = head.sessionId !== sent.sid || head.running !== sent.run;
        if (!rows.length && !upd.length && !drop && !moved) return null;
        sent.fps = now;
        sent.sid = head.sessionId;
        sent.run = head.running;
        return Object.assign({ drop: drop, upd: upd, rows: rows }, head);
      },

      /* ── 会话流 ── */
      setSessions(rows, currentId) {
        const list = (Array.isArray(rows) ? rows : []).map(normSession).filter((r) => r.id);
        const sig = sessionsSig(list);
        const cur = String(currentId || "");
        if (sig === state.sessions.sig && cur === state.sessions.currentId) return null;
        state.sessions.rows = list;
        state.sessions.sig = sig;
        state.sessions.currentId = cur;
        return commit("sessions");
      },
      setStreamSession(sessionId, opts) {
        const id = String(sessionId || "");
        const o = opts || {};
        if (id === state.stream.sessionId && !o.reset) return null;
        state.stream.sessionId = id;
        if (o.reset) {
          state.stream.items = [];
          state.stream.seq = 0;
          sent.reset = true; /* 换会话 = 整份重新对齐（增量的基线作废） */
        }
        state.stream.running = !!o.running;
        return commit("stream");
      },
      /* 一帧 dsh 事件进流（合批已在主进程做过，这里只管归位）。 */
      applyEvent(ev) {
        const e = ev && typeof ev === "object" ? ev : {};
        const sid = String((e.data && e.data.sessionId) || e.sessionId || "");
        if (sid && state.stream.sessionId && sid !== state.stream.sessionId) {
          /* 不是眼前这条会话的帧：留一行归属提示，不进流（否则界面上两个会话的话掺在一起） */
          return null;
        }
        const r = streamApply(state.stream.items, e);
        let touched = r.changed;
        if (e.type === "done") {
          state.stream.running = false;
          touched = true;
        } else if (!state.stream.running && (e.type === "text" || e.type === "reasoning" || e.type === "tool")) {
          state.stream.running = true;
          touched = true;
        }
        if (!touched) return null;
        stampIds(); /* 新起的段就地编号（增量补丁靠它归位） */
        return commit("stream");
      },
      pushUser(textValue) {
        const t = text(textValue, 4000);
        if (!t) return null;
        state.stream.items.push({ k: "user", text: t, at: Date.now(), closed: true });
        if (state.stream.items.length > STREAM_CAP)
          state.stream.items.splice(0, state.stream.items.length - STREAM_CAP);
        stampIds();
        return commit("stream");
      },

      /* ── 活动流 ── */
      pushActivity(rows) {
        const list = (Array.isArray(rows) ? rows : []).map(normActivity);
        if (!list.length) return null;
        for (const r of list) state.activity.rows.push(r);
        if (state.activity.rows.length > ACTIVITY_CAP)
          state.activity.rows.splice(0, state.activity.rows.length - ACTIVITY_CAP);
        return commit("activity");
      },
      setActivityPrefs(prefs) {
        const p = prefs || {};
        let touched = false;
        if (p.onlyCurrent !== undefined && !!p.onlyCurrent !== state.activity.onlyCurrent) {
          state.activity.onlyCurrent = !!p.onlyCurrent;
          touched = true;
        }
        if (p.filter !== undefined && String(p.filter) !== state.activity.filter) {
          state.activity.filter = String(p.filter);
          touched = true;
        }
        return touched ? commit("activity") : null;
      },
      clearActivity(sessionId) {
        const sid = String(sessionId || "");
        if (sid) state.activity.rows = state.activity.rows.filter((r) => r.sessionId !== sid);
        else state.activity.rows = [];
        return commit("activity");
      },

      /* ── 文件树 ── */
      setTreeRoot(root, rootKind) {
        const r = String(root || "");
        const k = String(rootKind || "");
        if (r === state.tree.root && k === state.tree.rootKind) return null;
        /* 换根 = 旧目录清单作废（沿用会让新根下面挂着一堆别处的路径） */
        if (r !== state.tree.root) {
          state.tree.dirs = {};
          state.tree.loading = {};
        }
        state.tree.root = r;
        state.tree.rootKind = k;
        return commit("tree");
      },
      setTreeDir(dir, entries, opts) {
        const d = String(dir || "");
        if (!d) return null;
        const o = opts || {};
        const list = (Array.isArray(entries) ? entries : [])
          .slice(0, TREE_DIR_CAP)
          .map((e) => {
            const it = e && typeof e === "object" ? e : {};
            return {
              name: text(it.name, 260),
              isDir: !!it.isDir,
              size: Number(it.size) || 0,
              mtime: Number(it.mtime) || 0,
              hidden: !!it.hidden,
            };
          })
          .filter((e) => e.name);
        state.tree.dirs[d] = { entries: list, error: String(o.error || ""), exists: o.exists !== false, at: Date.now() };
        delete state.tree.loading[d];
        return commit("tree");
      },
      treeLoading(dir) {
        const d = String(dir || "");
        if (!d) return null;
        state.tree.loading[d] = true;
        return commit("tree");
      },

      /* ── 隔离侧：吃一条 patch（与本地那次变更等价） ── */
      applyPatch(patch) {
        const p = patch && typeof patch === "object" ? patch : {};
        const kind = String(p.kind || "");
        const d = p.data && typeof p.data === "object" ? p.data : {};
        if (kind === "sessions") {
          state.sessions.rows = (Array.isArray(d.rows) ? d.rows : []).map(normSession);
          state.sessions.currentId = String(d.currentId || "");
          state.sessions.sig = sessionsSig(state.sessions.rows);
        } else if (kind === "stream") {
          if (d.reset || !d.append) {
            /* 整份对齐（首次 / 换会话 / 重连 / 老口径的调用方）：照旧整表替换 —— 只这一次 */
            state.stream.sessionId = String(d.sessionId != null ? d.sessionId : state.stream.sessionId);
            if (Array.isArray(d.items)) state.stream.items = d.items.slice();
            if (d.running !== undefined) state.stream.running = !!d.running;
            stampIds();
          } else {
            /* 增量（append-only）：upd 按编号就地回填 → rows 只追加尾巴 → drop 从头部裁。
               三条都是「与发布侧那次变更等价」的做法，不整表重发。 */
            const ups = Array.isArray(d.upd) ? d.upd : [];
            for (const one of ups) {
              const id = Number(one && one.id) || 0;
              const pp = one && one.patch && typeof one.patch === "object" ? one.patch : null;
              if (!id || !pp) continue;
              const seg = findSegById(state.stream.items, id);
              if (!seg) continue; /* 这一段已经被容量裁掉：静默跳过 */
              if (pp.text !== undefined) seg.text = text(pp.text);
              if (pp.at !== undefined) seg.at = Number(pp.at) || seg.at;
              if (pp.closed !== undefined) seg.closed = !!pp.closed;
              if (pp.status !== undefined) seg.status = String(pp.status || "");
              if (pp.name !== undefined) seg.name = String(pp.name || "");
              if (pp.bytes !== undefined) seg.bytes = Number(pp.bytes) || 0;
            }
            const rows = Array.isArray(d.rows) ? d.rows : [];
            for (const r of rows) if (r && typeof r === "object") state.stream.items.push(r);
            const drop = Math.max(0, Number(d.drop) || 0);
            if (drop) state.stream.items.splice(0, Math.min(drop, state.stream.items.length));
            /* 兜底：接收侧自己也守一道容量（漂移时不至于越长越大） */
            if (state.stream.items.length > STREAM_CAP)
              state.stream.items.splice(0, state.stream.items.length - STREAM_CAP);
            if (d.sessionId !== undefined) state.stream.sessionId = String(d.sessionId || "");
            if (d.running !== undefined) state.stream.running = !!d.running;
            stampIds();
          }
        } else if (kind === "activity") {
          const incoming = (Array.isArray(d.rows) ? d.rows : []).map(normActivity);
          /* append = 主进程转发来的**新条目**（活动流唯一来路，见 assist-isolation.js）；
             不带 append 的整份替换用于「换会话 / 重连对齐」。 */
          if (d.append) {
            for (const r of incoming) state.activity.rows.push(r);
            if (state.activity.rows.length > ACTIVITY_CAP)
              state.activity.rows.splice(0, state.activity.rows.length - ACTIVITY_CAP);
          } else if (Array.isArray(d.rows)) {
            state.activity.rows = incoming.slice(-ACTIVITY_CAP);
          }
          if (d.onlyCurrent !== undefined) state.activity.onlyCurrent = !!d.onlyCurrent;
          if (d.filter !== undefined) state.activity.filter = String(d.filter);
        } else if (kind === "tree") {
          if (d.root !== undefined) state.tree.root = String(d.root || "");
          if (d.rootKind !== undefined) state.tree.rootKind = String(d.rootKind || "");
          if (Array.isArray(d.dirs)) {
            for (const one of d.dirs) {
              if (!one || !one.dir) continue;
              const dir = String(one.dir);
              state.tree.dirs[dir] = {
                entries: (Array.isArray(one.entries) ? one.entries : []).slice(0, TREE_DIR_CAP),
                error: String(one.error || ""),
                exists: one.exists !== false,
                at: Number(one.at) || Date.now(),
              };
              delete state.tree.loading[dir];
            }
          }
          if (Array.isArray(d.loading)) for (const dir of d.loading) state.tree.loading[String(dir)] = true;
        } else if (kind === "snapshot" || kind === "all") {
          store.replace(d);
          return state.rev;
        } else {
          return null;
        }
        state.rev = Math.max(state.rev, Number(p.rev) || 0);
        emit({ kind: kind, rev: state.rev });
        return state.rev;
      },

      /* 整份替换（隔离进程刚起来 / 重连对齐）：不做 diff，直接换掉并通知一次。 */
      replace(snap) {
        const s = snap && typeof snap === "object" ? snap : {};
        if (s.sessions) {
          state.sessions.rows = (Array.isArray(s.sessions.rows) ? s.sessions.rows : []).map(normSession);
          state.sessions.currentId = String(s.sessions.currentId || "");
          state.sessions.sig = sessionsSig(state.sessions.rows);
        }
        if (s.stream) {
          state.stream.sessionId = String(s.stream.sessionId || "");
          state.stream.items = Array.isArray(s.stream.items) ? s.stream.items.slice() : [];
          state.stream.running = !!s.stream.running;
          state.stream.seq = 0;
          stampIds();
          sent.reset = true; /* 对齐全份之后，增量基线从这里重新起 */
        }
        if (s.activity) {
          state.activity.rows = (Array.isArray(s.activity.rows) ? s.activity.rows : []).map(normActivity);
          state.activity.onlyCurrent = s.activity.onlyCurrent !== false;
          state.activity.filter = String(s.activity.filter || "");
        }
        if (s.tree) {
          state.tree.root = String(s.tree.root || "");
          state.tree.rootKind = String(s.tree.rootKind || "");
          state.tree.dirs = {};
          state.tree.loading = {};
        }
        state.rev = Math.max(state.rev, Number(s.rev) || 0);
        emit({ kind: "snapshot", rev: state.rev });
        return state.rev;
      },
    };

    return store;
  }

  return {
    STREAM_CAP: STREAM_CAP,
    ACTIVITY_CAP: ACTIVITY_CAP,
    TREE_DIR_CAP: TREE_DIR_CAP,
    createStore: createStore,
    normSession: normSession,
    normActivity: normActivity,
    streamApply: streamApply,
  };
});
