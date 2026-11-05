/* renderer/app-apphost-bridge.js — 应用 / 插件窗口的宿主桥执行端
 * ============================================================================
 * 主进程 app-host-bridge.js 把「应用中心窗口 / 插件窗口」的调用推成一帧
 * （webContents.send('appHost:event')：{id, op, params}），这里负责接到**既有执行体**上：
 *
 *   canvasCall   → renderer/app-appnode.js 的 APPNODE_ROUTES.canvas（window.MTNodeAppCanvas）
 *                  + runAgainstWf(目标画布)：目标画布没打开也照跑，且不动用户当前视图
 *   agent*       → renderer/app-session-bridge.js 的会话族（window.MTNodeSession）
 *   tools / net  → window.api 的既有主进程通道（backendRegistry* / netFetch）
 *   pickCanvas   → 主窗口里一张画布清单小窗（用户亲自选的那一张才生效）
 *   grantAsk     → 主窗口的确认框（与面板里那颗「确认」同一个 mtDialog）
 *
 * 三条纪律：
 *   1) **画布真源只在渲染层**：本文件不读画布文件、不另写一套执行器；
 *   2) **目标画布由调用方给**（app-host-bridge.js 已按「应用对应的那张」算好），
 *      这里只用 runAgainstWf 把那张图换上手，收尾一定还原（用户视图不抖）；
 *   3) **选中 / 视图 / 相机**只对用户当前打开的那张画布有效（否则会改到别人眼前那张图），
 *      后台画布一律回 not_foreground —— 如实告知，不假装成功。
 *
 * 挂在 window.MTNodeAppHostBridge。加载顺序：app-session-bridge.js / app-appnode.js 之后。
 * ========================================================================== */
"use strict";

(function () {
  function T(s) {
    try {
      return typeof I18n !== "undefined" && I18n.t ? I18n.t(s) : s;
    } catch (_) {
      return s;
    }
  }
  function api() {
    return window.api || {};
  }
  function reply(id, result, error) {
    try {
      const p = api().appHostReply({ id: id, result: result === undefined ? null : result, error: error || undefined });
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (_) {}
  }

  /* ── 目标画布解析：前台 / 袋里 / 后台加载（读盘 + 入袋，不切视图）──────────── */
  async function resolveWf(canvasId) {
    const id = String(canvasId || "").trim();
    const fg = typeof currentVisibleWf === "function" ? currentVisibleWf() : null;
    if (!id) return fg;
    if (fg && String(fg.id) === id) return fg;
    if (S.wfBag && S.wfBag[id]) return S.wfBag[id];
    if (typeof wfOfCanvasIdForRun === "function") return await wfOfCanvasIdForRun(id);
    throw new Error(T("找不到画布：") + id);
  }
  function isBg(wf) {
    const fg = typeof currentVisibleWf === "function" ? currentVisibleWf() : null;
    return !fg || String(fg.id) !== String(wf && wf.id);
  }

  /* 只属于「用户眼前那张图」的操作：后台画布上一律拒绝（否则会改到别人的视图 / 选中） */
  const FG_ONLY = { select: 1, setView: 1, view: 1 };

  async function canvasCall(p) {
    const wf = await resolveWf(p.canvasId);
    if (!wf) return { ok: false, code: "no_canvas", error: T("没有这张画布") };
    const method = String(p.method || "");
    const table = window.MTNodeAppCanvas || null;
    if (!table || typeof table[method] !== "function")
      return { ok: false, code: "bad_method", error: T("不认识的画布操作：") + method };
    if (isBg(wf) && FG_ONLY[method])
      return {
        ok: false,
        code: "not_foreground",
        error: T("选中 / 相机视图只对用户当前打开的那张画布有效（后台画布不抢用户的视图）"),
      };
    const args = p.args && typeof p.args === "object" ? p.args : {};
    return runAgainstWf(wf, () => table[method](args));
  }

  /* ── 会话绑定：把「这张画布」写进会话自己的 canvasWfId（agent 改的就是它）──── */
  function sessionOf(sid) {
    try {
      return typeof agentSessionById === "function" ? agentSessionById(String(sid || "")) : null;
    } catch (_) {
      return null;
    }
  }
  function markSession(st) {
    try {
      if (typeof agentMarkSessionDirty === "function") agentMarkSessionDirty(st.id);
      if (typeof agentFlushSessionSave === "function") agentFlushSessionSave();
      if (typeof renderAgentSessionSidebar === "function") renderAgentSessionSidebar();
    } catch (_) {}
  }
  async function bindCanvasToSession(canvasId, sid) {
    const wf = await resolveWf(canvasId);
    if (!wf) return { ok: false, code: "no_canvas", error: T("没有这张画布") };
    const st = sessionOf(sid);
    if (!st) return { ok: false, code: "missing", error: T("没有这条会话") };
    st.canvasWfId = String(wf.id);
    markSession(st);
    return { ok: true, sessionId: String(st.id), canvasId: String(wf.id), canvasName: String(wf.name || "") };
  }

  /* ── 画布清单 / 选择窗 ─────────────────────────────────────────────────── */
  async function canvasList() {
    let list = [];
    try {
      const r = await api().wfList();
      list = Array.isArray(r) ? r : (r && (r.items || r.list)) || [];
    } catch (err) {
      list = [];
    }
    return {
      ok: true,
      list: list
        .filter((w) => w && w.id)
        .map((w) => ({ id: String(w.id), name: String(w.name || w.id), workspace: String(w.workspace || "") })),
    };
  }

  /** 画布选择小窗（主窗口里）：用户点一张才回 id；**Esc / 取消**算「没选」。
   *  按仓里的浮层纪律（AGENTS.md）：点蒙层**不关**，出口只有窗内的「取消」与 Esc。 */
  function pickCanvasModal(suggest) {
    return canvasList().then(
      (r) =>
        new Promise((resolve) => {
          const list = (r && r.list) || [];
          if (!list.length) {
            resolve({ ok: false, code: "no_canvas", error: T("本机还没有画布") });
            return;
          }
          const mask = document.createElement("div");
          /* 层级：高于画布上所有 UI（最高 find.css 12100），但**低于询问窗 #ixPanel(12600)** ——
             仓里的层级不变式是「询问窗永远最上面」，原来这里写 2147483000 会把助手正在等答案的
             那一问整个盖住（用户看不到、也就答不了）。 */
          mask.style.cssText =
            "position:fixed;inset:0;z-index:12400;background:rgba(0,0,0,.42);display:flex;" +
            "align-items:center;justify-content:center;";
          const box = document.createElement("div");
          box.style.cssText =
            "width:min(520px,86vw);max-height:70vh;display:flex;flex-direction:column;gap:10px;" +
            "background:var(--panel,#1f232b);color:var(--fg,#e8eaee);border:1px solid rgba(255,255,255,.14);" +
            "border-radius:12px;padding:16px;box-shadow:0 18px 50px rgba(0,0,0,.45);font:13px/1.6 system-ui,sans-serif;";
          const title = document.createElement("div");
          title.style.cssText = "font-weight:600;font-size:14px;";
          title.textContent = T("选择这个应用对应的画布");
          const hint = document.createElement("div");
          hint.style.cssText = "opacity:.72;font-size:12px;";
          hint.textContent = T("选一次就会记住；之后它读写的永远是这张画布。");
          const listBox = document.createElement("div");
          listBox.style.cssText = "overflow:auto;display:flex;flex-direction:column;gap:6px;padding:2px;";
          let done = false;
          const finish = (out) => {
            if (done) return;
            done = true;
            document.removeEventListener("keydown", onKey, true);
            try {
              mask.remove();
            } catch (_) {}
            resolve(out);
          };
          const onKey = (ev) => {
            if (ev.key === "Escape") {
              ev.preventDefault();
              ev.stopPropagation();
              finish({ ok: false, code: "cancelled", error: T("没有选择画布") });
            }
          };
          for (const w of list) {
            const b = document.createElement("button");
            b.type = "button";
            b.style.cssText =
              "text-align:left;padding:9px 12px;border-radius:8px;cursor:pointer;" +
              "border:1px solid " +
              (suggest && String(w.id) === String(suggest) ? "rgba(120,180,255,.7)" : "rgba(255,255,255,.12)") +
              ";background:rgba(255,255,255,.04);color:inherit;font:inherit;";
            b.textContent = w.name + "（" + w.id + "）";
            b.onclick = () => finish({ ok: true, id: String(w.id), name: String(w.name) });
            listBox.appendChild(b);
          }
          const foot = document.createElement("div");
          foot.style.cssText = "display:flex;justify-content:flex-end;";
          const cancel = document.createElement("button");
          cancel.type = "button";
          cancel.style.cssText =
            "padding:6px 14px;border-radius:8px;cursor:pointer;border:1px solid rgba(255,255,255,.16);" +
            "background:transparent;color:inherit;font:inherit;";
          cancel.textContent = T("取消");
          cancel.onclick = () => finish({ ok: false, code: "cancelled", error: T("没有选择画布") });
          foot.appendChild(cancel);
          box.appendChild(title);
          box.appendChild(hint);
          box.appendChild(listBox);
          box.appendChild(foot);
          mask.appendChild(box);
          document.body.appendChild(mask);
          document.addEventListener("keydown", onKey, true);
        }),
    );
  }

  /* ── 授权窗（一次授权该应用的全部重能力）────────────────────────────────── */
  async function grantAsk(p) {
    const lines = Array.isArray(p.lines) ? p.lines.map(String) : [];
    const msg = lines.join("\n");
    if (typeof confirmDialog !== "function") return { ok: false, code: "no_ui", error: T("主窗口确认框不可用") };
    const yes = await confirmDialog(msg, {
      title: String(p.title || T("应用请求画布与 agent 能力")),
      okText: T("允许"),
      cancelText: T("拒绝"),
    });
    if (!yes) return { ok: false, code: "denied", error: T("用户拒绝了这次授权") };
    return { ok: true };
  }

  /* ── 帧分派 ───────────────────────────────────────────────────────────── */
  const HANDLERS = {
    canvasList: () => canvasList(),
    pickCanvas: (p) => pickCanvasModal(p.suggest),
    canvasInfo: async (p) => {
      const wf = await resolveWf(p.canvasId);
      if (!wf) return { ok: false, code: "no_canvas", error: T("没有这张画布") };
      return {
        ok: true,
        id: String(wf.id),
        name: String(wf.name || ""),
        workspace: String(wf.workspace || ""),
        nodes: Array.isArray(wf.nodes) ? wf.nodes.length : 0,
        foreground: !isBg(wf),
      };
    },
    currentCanvas: async () => {
      const fg = typeof currentVisibleWf === "function" ? currentVisibleWf() : null;
      if (!fg) return { ok: false, code: "no_canvas", error: T("当前没有打开的画布") };
      return { ok: true, id: String(fg.id), name: String(fg.name || ""), workspace: String(fg.workspace || "") };
    },
    canvasCall: (p) => canvasCall(p),
    agentSessions: async () => {
      const list = typeof agentSessions === "function" ? agentSessions() || [] : [];
      return {
        ok: true,
        sessions: list.map((s) => ({
          id: String(s.id || ""),
          title: String(s.title || ""),
          busy: typeof agentSessionBusy === "function" ? !!agentSessionBusy(s) : !!s.running,
          canvasWfId: String(s.canvasWfId || ""),
        })),
      };
    },
    agentCreate: async (p) => {
      const ses = window.MTNodeSession;
      if (!ses || typeof ses.handleFrame !== "function")
        return { ok: false, code: "no_agent", error: T("会话桥渲染层未加载（renderer/app-session-bridge.js）") };
      const out = await ses.handleFrame({
        op: "sessionCreate",
        params: { title: String(p.title || "") },
      });
      if (!out || out.ok !== true) return out || { ok: false, code: "failed", error: T("新建会话失败") };
      const bind = await bindCanvasToSession(p.canvasId, out.sessionId);
      if (!bind.ok) return bind;
      return { ok: true, sessionId: out.sessionId, title: out.title || "", canvasId: bind.canvasId };
    },
    agentBindCanvas: (p) => bindCanvasToSession(p.canvasId, p.sessionId),
    agentSend: async (p) => {
      const ses = window.MTNodeSession;
      if (!ses || typeof ses.handleFrame !== "function")
        return { ok: false, code: "no_agent", error: T("会话桥渲染层未加载（renderer/app-session-bridge.js）") };
      const sid = String(p.sessionId || "").trim();
      if (!sid) return { ok: false, code: "not_bound", error: T("会话 id 为空") };
      /* 会话必须绑在这张画布上：agent 这一轮改的就是它（绑定失败就说失败，不放行） */
      const bind = await bindCanvasToSession(p.canvasId, sid);
      if (!bind.ok) return bind;
      /* 观察这条会话：事件经 appHostStream 转给发起调用的那只应用窗口 */
      const callerKey = String(p.callerKey || "");
      if (callerKey && typeof ses.watchHost === "function") {
        ses.watchHost(sid, (frame) => {
          try {
            api().appHostStream({ callerKey: callerKey, sessionId: sid, frame: frame });
          } catch (_) {}
        });
      }
      const out = await ses.handleFrame({ op: "sessionSend", params: { sessionId: sid, text: String(p.text || "") } });
      return out || { ok: false, code: "failed", error: T("发送失败") };
    },
    agentCancel: async (p) => {
      const ses = window.MTNodeSession;
      if (!ses || typeof ses.handleFrame !== "function")
        return { ok: false, code: "no_agent", error: T("会话桥渲染层未加载（renderer/app-session-bridge.js）") };
      return ses.handleFrame({ op: "sessionStop", params: { sessionId: String(p.sessionId || "") } });
    },
    grantAsk: (p) => grantAsk(p),
    /* 工具清单 / 调用与应用节点**同一份实现**（renderer/app-appnode.js 的 MTNodeAppTools）：
       注册中心登记的工具 + 已安装的插件本机后端（breeze / qwen-image / flux3-klein…）。
       窗口应用以前只拿到 `items`，插件后端一个都看不见 —— 这就是应用侧「取不到 mtnode 能力」。 */
    toolsList: async () => {
      try {
        if (window.MTNodeAppTools && typeof window.MTNodeAppTools.list === "function")
          return { ok: true, tools: await window.MTNodeAppTools.list() };
        const r = await api().backendRegistryList();
        return { ok: true, tools: (r && (r.items || r.tools)) || r || [] };
      } catch (err) {
        return { ok: false, code: "failed", error: (err && err.message) || String(err) };
      }
    },
    toolsCall: async (p) => {
      const id = String(p.id || "");
      if (!id) return { ok: false, code: "bad_arg", error: T("工具 id 必填") };
      try {
        if (window.MTNodeAppTools && typeof window.MTNodeAppTools.call === "function")
          return await window.MTNodeAppTools.call(id, p.args || {});
        const r = await api().backendRegistryCall({ id: id, args: p.args || {} });
        return r || { ok: true };
      } catch (err) {
        return { ok: false, code: "failed", error: (err && err.message) || String(err) };
      }
    },
    netFetch: async (p) => {
      const url = String(p.url || "");
      if (!/^https?:\/\//i.test(url)) return { ok: false, code: "bad_url", error: T("只支持 http(s) 地址") };
      try {
        const r = await api().netFetch(url);
        return r && typeof r === "object" ? r : { ok: true, body: r };
      } catch (err) {
        return { ok: false, code: "failed", error: (err && err.message) || String(err) };
      }
    },
  };

  async function handleFrame(frame) {
    const f = frame || {};
    const id = f.id;
    if (!id) return;
    const op = String(f.op || "");
    const fn = HANDLERS[op];
    if (!fn) {
      reply(id, { ok: false, code: "bad_op", error: T("未知的宿主操作：") + op });
      return;
    }
    try {
      const out = await fn(f.params || {});
      reply(id, out === undefined ? { ok: true } : out);
    } catch (e) {
      reply(id, { ok: false, code: "failed", error: (e && e.message) || String(e) });
    }
  }

  window.MTNodeAppHostBridge = {
    handleFrame: handleFrame,
    pickCanvas: pickCanvasModal,
    canvasList: canvasList,
    ops: Object.keys(HANDLERS),
  };
  if (window.api && typeof window.api.appHostOnEvent === "function") {
    window.MTNodeAppHostBridge.off = window.api.appHostOnEvent((frame) => handleFrame(frame));
  }
})();
