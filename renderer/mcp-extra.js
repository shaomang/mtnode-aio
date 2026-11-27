/* mcp-extra.js — MCP 自用回环在**渲染层**的三件执行体（跑节点 / 用户工具 / 会话）
 *
 * 谁调它：主进程 mcp-server.js 把 mtnode_run / mtnode_tools / mtnode_session 推成帧
 *   （op = "run" / "tool" / "sessionTask"），renderer/mcp-bridge.js 在本文件登记的
 *   window.MTNodeMcpExtra 上找对应函数执行。
 *
 * 为什么是渲染层：这三件事的真源都在这里 —— 画布对象（S.wf）、节点运行器（playNode /
 *   playControlNode）、用户工具快照与执行（agentUserToolsSnapshot / executeAgentToolCall）、
 *   会话（agentSessions / agentSessionSend）。主进程另造一套就等于多一条不受同一批闸门
 *   （模型闸、批次、全局音视频锁、会话落盘）约束的执行路。
 *
 * 与自家 agent 同源：跑节点用的就是画布上那颗 ▶ 的同一个函数（quiet 档），跑工具用的是
 *   agent 调用户工具的同一条 executeAgentToolCall，开会话用的是「新会话 + 发送」同一个入口。
 */
(function () {
  "use strict";

  function t(s) {
    return typeof I18n !== "undefined" && I18n && typeof I18n.t === "function" ? I18n.t(s) : s;
  }

  function wfNow() {
    return typeof currentVisibleWf === "function" ? currentVisibleWf() : S.wf;
  }

  function errOut(e) {
    return { ok: false, error: String((e && e.code) || ""), message: String((e && e.message) || e) };
  }

  /* ── 画布内容哈希（与 canvas_edit / app 的 baseHash 同一真源）──────────────── */

  async function contentHashOf(wf) {
    const snap = await runAgainstWf(wf, () =>
      canvasSnapshotFull({ detail: "minimal" }, { wf: wf, restrict: false }),
    );
    return String((snap && snap.contentHash) || "");
  }

  /* ── 节点定位 ─────────────────────────────────────────────────────────────── */

  /* 动作词：`action` 是 mtnode_run 的**动作**（node / graph / status …），不是节点标识。
     早期版本直接拿 p.nodeId 定位，主进程那边把动作字段一起下发了，于是「给了 nodeId 也
     回 缺少 nodeId」；这里统一先剥掉动作词，两种入参都认。 */
  const RUN_ACTIONS = new Set(["node", "graph", "status", "list", "cancel", "wait"]);

  function cleanRef(v) {
    const s = String(v || "").trim();
    return RUN_ACTIONS.has(s.toLowerCase()) ? "" : s;
  }

  function findNode(wf, id, title) {
    const nodes = (wf && Array.isArray(wf.nodes) && wf.nodes) || [];
    const nid = cleanRef(id);
    if (nid) {
      const hit = nodes.find((n) => n && n.id === nid);
      if (hit) return { node: hit };
      return { error: "画布上没有节点 " + nid };
    }
    const want = cleanRef(title);
    if (!want) return { error: "缺少 nodeId 或 nodeTitle" };
    const same = nodes.filter((n) => n && String(n.title || "").trim() === want);
    if (!same.length) return { error: "画布上没有标题为「" + want + "」的节点" };
    if (same.length > 1) return { error: "有 " + same.length + " 个节点都叫「" + want + "」，请改用 nodeId" };
    return { node: same[0] };
  }

  /** 节点输出 → 纯 JSON（文本给 text、媒体给绝对路径；批次给数组）。 */
  function nodeResult(node) {
    const norm = (v) => {
      if (v == null) return null;
      if (typeof v === "string") return { kind: "text", text: v };
      if (typeof v !== "object") return { kind: "text", text: String(v) };
      if (v.kind === "image" || v.kind === "audio" || v.kind === "video")
        return { kind: v.kind, path: String(v.path || ""), text: String(v.text || "") };
      if (Array.isArray(v)) return v.map(norm);
      const out = {};
      if (v.text != null) out.text = String(v.text);
      if (v.path != null) out.path = String(v.path);
      if (v.kind != null) out.kind = String(v.kind);
      if (v.title != null) out.title = String(v.title);
      return Object.keys(out).length ? out : null;
    };
    const r = {
      ok: !node.error,
      nodeId: node.id,
      title: String(node.title || ""),
      kind: String(node.kind || ""),
    };
    if (node.error) r.error = String(node.error);
    const out = norm(node.output);
    if (out) r.output = out;
    if (Array.isArray(node.batchOutputs) && node.batchOutputs.length)
      r.batch = node.batchOutputs.map((x) => ({ ok: !(x && x.error), error: (x && x.error) || "", output: norm(x && x.output) }));
    if (node.ranAt) r.ranAt = node.ranAt;
    return r;
  }

  /* ── 跑节点 / 跑整图（与界面上那颗 ▶ 同一条执行链）──────────────────────────── */

  async function runOne(params) {
    const p = params || {};
    const wf = p.canvasRef ? await window.MTNodeMcp.resolveWf(p.canvasRef) : wfNow();
    if (!wf) return { ok: false, error: "NO_CANVAS", message: "没有可用的画布" };
    const hit = findNode(wf, p.nodeId, p.nodeTitle);
    if (hit.error) return { ok: false, error: "NO_NODE", message: hit.error };
    const node = hit.node;
    /* 写前版本校验：跑节点会改节点输出（= 改画布），与 canvas_edit 同一口径 */
    const want = String(p.baseHash || "").trim();
    if (!want)
      return {
        ok: false,
        error: "BASE_HASH_REQUIRED",
        message: "跑单个节点会写回节点输出，必须给 baseHash（先 mtnode_canvas_get 拿 contentHash）",
      };
    const cur = await contentHashOf(wf);
    if (cur && cur !== want)
      return {
        ok: false,
        error: "STALE_CANVAS",
        message: "画布已被改动（版本不一致），本次运行未执行：请重新 mtnode_canvas_get 读一遍再跑",
      };
    await runAgainstWf(wf, () => playNode(node, true, {}));
    return Object.assign({ ok: true, canvas: String(wf.id || wf.name || "") }, nodeResult(node));
  }

  async function runGraph(params) {
    const p = params || {};
    const wf = p.canvasRef ? await window.MTNodeMcp.resolveWf(p.canvasRef) : wfNow();
    if (!wf) return { ok: false, error: "NO_CANVAS", message: "没有可用的画布" };
    const nodes = (wf && Array.isArray(wf.nodes) && wf.nodes) || [];
    const wantId = String(p.controlNodeId || "").trim();
    let ctrl = null;
    if (wantId) {
      ctrl = nodes.find((n) => n && n.id === wantId) || null;
      if (!ctrl) return { ok: false, error: "NO_NODE", message: "画布上没有节点 " + wantId };
      if (ctrl.kind !== "control")
        return { ok: false, error: "NOT_CONTROL", message: "节点 " + wantId + " 不是控制节点" };
    } else {
      ctrl =
        nodes.find((n) => n && n.kind === "control" && (n.ctrlAction || "run") === "run") || null;
      if (!ctrl)
        return { ok: false, error: "NO_CONTROL", message: "画布上没有 ctrlAction=run 的控制节点（请给 controlNodeId）" };
    }
    const startedAt = Date.now();
    await runAgainstWf(wf, () => playControlNode(ctrl, new Set()));
    const ran = nodes
      .filter((n) => n && n.kind !== "control" && Number(n.ranAt || 0) >= startedAt - 1000)
      .map(nodeResult);
    return {
      ok: ran.every((r) => r.ok),
      canvas: String(wf.id || wf.name || ""),
      controlNodeId: ctrl.id,
      count: ran.length,
      nodes: ran,
    };
  }

  async function run(params) {
    const p = params || {};
    const action = String(p.action || "node");
    if (action === "graph") return runGraph(p);
    return runOne(p);
  }

  /* ── 用户工具（工具节点 + 工具库 always 条目）───────────────────────────────── */

  function briefDesc(d) {
    return {
      name: String(d.name || ""),
      toolName: String(d.toolName || ""),
      key: String(d.key || ""),
      origin: String(d.origin || ""),
      description: String(d.description || ""),
    };
  }

  function fullDesc(d) {
    return Object.assign(briefDesc(d), {
      example: String(d.example || ""),
      limits: String(d.limits || ""),
      inputs: (d.inputs || []).map((x) => ({
        name: String((x && x.name) || ""),
        kind: String((x && x.kind) || "text"),
        required: !(x && x.optional === true),
        description: String((x && x.description) || ""),
      })),
      outputs: (d.outputs || []).map((x) => ({
        name: String((x && x.name) || ""),
        kind: String((x && x.kind) || "text"),
        description: String((x && x.description) || ""),
      })),
    });
  }

  async function tools(params) {
    const p = params || {};
    const wf = p.canvasRef ? await window.MTNodeMcp.resolveWf(p.canvasRef) : wfNow();
    if (!wf) return { ok: false, error: "NO_CANVAS", message: "没有可用的画布" };
    const snap = await runAgainstWf(wf, () => agentUserToolsSnapshot(wf));
    const descs = (snap && snap.descs) || [];
    const action = String(p.action || "list");
    if (action === "list") {
      const full = String(p.detail || "") === "full";
      return {
        ok: true,
        canvas: String(wf.id || wf.name || ""),
        count: descs.length,
        tools: descs.map(full ? fullDesc : briefDesc),
        hint: full ? "" : 'detail:"full" 可看完整入参表；调用用 action:"call" + name + args。',
      };
    }
    const want = String(p.name || "").trim();
    if (!want) return { ok: false, error: "NO_NAME", message: 'call 需要 name（先 action:"list"）' };
    const d =
      descs.find((x) => String(x.name || "") === want) ||
      descs.find((x) => String(x.key || "") === want) ||
      descs.find((x) => String(x.toolName || "") === want) ||
      null;
    if (!d)
      return {
        ok: false,
        error: "NO_TOOL",
        message: "没有这个用户工具：" + want + "（可用：" + descs.map((x) => x.name).join(" / ") + "）",
      };
    const args = p.args && typeof p.args === "object" ? p.args : {};
    try {
      const payload = await runAgainstWf(wf, () => executeAgentToolCall(d, args, wf));
      return { ok: true, tool: briefDesc(d), result: payload == null ? null : payload };
    } catch (e) {
      return Object.assign(errOut(e), { tool: briefDesc(d) });
    }
  }

  /* ── 会话（新建 / 发消息等回复 / 读 / 删）──────────────────────────────────── */

  const EXTERNAL_PREFIX = "外部调用 · ";
  /** 这一批外部会话的 keep 标记：会话 id → true（只活在本进程） */
  const keepSet = new Set();

  function sessionOf(id) {
    const list = typeof agentSessions === "function" ? agentSessions() || [] : [];
    return list.find((x) => x && x.id === String(id || "")) || null;
  }

  function lastAssistantText(st) {
    const msgs = (st && Array.isArray(st.messages) && st.messages) || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m && m.role === "assistant" && String(m.content || "").trim()) return String(m.content);
    }
    return "";
  }

  function createSession(p) {
    if (typeof newAgentSession !== "function") throw new Error("渲染层没有 newAgentSession");
    const prevActive = String((typeof activeAgentId === "function" ? activeAgentId() : "") || "");
    const st = newAgentSession();
    const wantTitle = String((p && p.title) || "").trim();
    st.title = EXTERNAL_PREFIX + (wantTitle || "MCP");
    if (p && p.provider) st.provider = String(p.provider);
    if (p && p.model != null) st.model = String(p.model);
    if (p && p.effort) st.effort = String(p.effort);
    /* 不绑画布：外部调用不该悄悄改「用户正看着的那张图」的归属 */
    st.canvasWfId = "";
    st.external = true;
    st.keep = !!(p && p.keep);
    if (st.keep) keepSet.add(st.id);
    else keepSet.delete(st.id);
    try {
      if (typeof agentMarkSessionDirty === "function") agentMarkSessionDirty(st.id);
      if (typeof agentFlushSessionSave === "function") agentFlushSessionSave();
    } catch (_) {}
    try {
      S.agentActiveId = prevActive;
      if (typeof agentFlushSessionSaveQuiet === "function") agentFlushSessionSaveQuiet();
    } catch (_) {}
    try {
      if (typeof renderAgentSessionSidebar === "function") renderAgentSessionSidebar();
    } catch (_) {}
    return st;
  }

  async function discardSession(sid) {
    if (keepSet.has(String(sid))) return { ok: true, discarded: false, sessionId: String(sid) };
    try {
      if (typeof deleteAgentSessionCore === "function") {
        const n = await deleteAgentSessionCore(String(sid));
        return { ok: n !== -1, discarded: n !== -1, sessionId: String(sid) };
      }
    } catch (_) {}
    return { ok: false, discarded: false, sessionId: String(sid) };
  }

  async function sessionTask(params) {
    const p = params || {};
    const action = String(p.action || "create");
    if (action === "create") {
      const st = createSession(p);
      return {
        ok: true,
        sessionId: st.id,
        title: st.title,
        keep: !!st.keep,
        note: st.keep ? "已建（keep:true，留在左栏）" : "已建（用完即弃：send 完成后自动删除）",
      };
    }
    if (action === "read") {
      const sid = String(p.sessionId || "").trim();
      if (!sid) return { ok: false, error: "NO_SESSION", message: "read 需要 sessionId" };
      const st = sessionOf(sid);
      if (!st) return { ok: false, error: "SESSION_GONE", message: "会话不存在或已被删除：" + sid };
      if (!st._lcLoaded && typeof agentEnsureSessionBody === "function") {
        try {
          await agentEnsureSessionBody(st);
        } catch (_) {}
      }
      const limit = Math.max(1, Math.min(200, Number(p.limit) || 20));
      const msgs = (st.messages || []).slice(-limit).map((m) => ({
        role: String((m && m.role) || ""),
        content: String((m && m.content) || ""),
        at: Number((m && m.at) || 0),
      }));
      return {
        ok: true,
        sessionId: sid,
        title: String(st.title || ""),
        running: !!st.running,
        count: msgs.length,
        messages: msgs,
      };
    }
    if (action === "close") {
      const sid = String(p.sessionId || "").trim();
      if (!sid) return { ok: false, error: "NO_SESSION", message: "close 需要 sessionId" };
      const st = sessionOf(sid);
      if (!st) return { ok: true, sessionId: sid, discarded: false, note: "会话已经不在了" };
      if (keepSet.has(sid))
        return {
          ok: true,
          sessionId: sid,
          discarded: false,
          note: "这条会话是 keep:true 建的，留在左栏（要删请在界面上删）",
        };
      const r = await discardSession(sid);
      return Object.assign({ ok: true }, r);
    }
    /* send（默认） */
    const text = String(p.text || "").trim();
    if (!text) return { ok: false, error: "NO_TEXT", message: "send 需要 text" };
    let sid = String(p.sessionId || "").trim();
    let made = null;
    if (!sid) {
      made = createSession(p);
      sid = made.id;
    }
    const st = sessionOf(sid);
    if (!st) return { ok: false, error: "SESSION_GONE", message: "会话不存在或已被删除：" + sid };
    const wait = p.wait === undefined ? true : !!p.wait;
    if (!wait) {
      /* 不等回复：只把这一轮发出去，会话留着（不在这一轮后删） */
      keepSet.add(sid);
      try {
        await agentSessionSend(text, { sessionId: sid });
      } catch (e) {
        return errOut(e);
      }
      return {
        ok: true,
        sessionId: sid,
        running: true,
        note: "已发出（wait:false）。用 action:\"read\" 取回复；这条会话这次留在左栏，读完用 action:\"close\" 删。",
      };
    }
    try {
      if (!st._lcLoaded && typeof agentEnsureSessionBody === "function") {
        try {
          await agentEnsureSessionBody(st);
        } catch (_) {}
      }
      await agentSessionSend(text, { sessionId: sid });
    } catch (e) {
      const out = errOut(e);
      return Object.assign(out, { sessionId: sid });
    }
    const reply = lastAssistantText(st);
    const out = {
      ok: true,
      sessionId: sid,
      title: String(st.title || ""),
      running: !!st.running,
      reply: reply,
      error: st.error ? String(st.error) : undefined,
    };
    if (made) out.created = true;
    if (!keepSet.has(sid)) {
      const d = await discardSession(sid);
      out.discarded = !!d.discarded;
      out.note = d.discarded
        ? "已用完即弃（会话已从左栏删除）；要保留请下次传 keep:true。"
        : "这一轮已结束；会话没删掉（可能正被界面使用）。";
    } else {
      out.discarded = false;
      out.note = "keep:true：会话留在左栏。";
    }
    return out;
  }

  /* ── 生成后的「建一个画布节点」（只有显式 createNode:true 才走）────────────── */

  async function mediaNode(params) {
    const p = params || {};
    const wf = p.canvasRef ? await window.MTNodeMcp.resolveWf(p.canvasRef) : wfNow();
    if (!wf) return { ok: false, error: "NO_CANVAS", message: "没有可用的画布" };
    const file = String(p.path || "").trim();
    if (!file) return { ok: false, error: "NO_PATH", message: "建节点需要产物路径 path" };
    const want = String(p.baseHash || "").trim();
    if (!want)
      return { ok: false, error: "BASE_HASH_REQUIRED", message: "建节点会改画布，必须给 baseHash" };
    const cur = await contentHashOf(wf);
    if (cur && cur !== want)
      return { ok: false, error: "STALE_CANVAS", message: "画布已被改动（版本不一致），节点未建" };
    const kind = String(p.kind || "image");
    const nkind = kind === "image" ? "input_image" : kind === "video" ? "input_video" : "input_audio";
    return runAgainstWf(wf, async () => {
      const warnings = [];
      const node = makeNode(nkind, 48, 48);
      const wantTitle =
        String(p.title || "").trim() ||
        String(file)
          .split(/[\\/]/)
          .pop()
          .replace(/\.[^.]+$/, "");
      node.title = uniqueNodeTitle(wantTitle || "产物");
      if (nkind === "input_image") {
        /* 图片走与拖入 / canvas_edit 同一条资产拷贝（画布要靠资产目录里的副本显示与复用） */
        await importImagePathsForNode(node, [file], warnings);
      } else {
        /* 音频 / 视频输入节点的文件就挂在节点自己身上（mediaAsset），与选文件那条路一致 */
        node.mediaAsset = file;
      }
      S.wf.nodes.push(node);
      if (typeof sizeNodeForContent === "function") sizeNodeForContent(node);
      if (typeof applyNewNodePlacement === "function")
        applyNewNodePlacement([node], { origin: { x: 48, y: 48 } });
      if (typeof scheduleSave === "function") scheduleSave(true);
      if (typeof renderCanvas === "function") renderCanvas();
      return {
        ok: true,
        nodeId: node.id,
        title: node.title,
        kind: nkind,
        warnings: warnings.slice(0, 8),
      };
    });
  }

  /* ── 交接（外部 agent → MTNode 自己的 agent）──────────────────────────────
     主进程 mcp-server.js 的 mtnode_agent 推这两个 op：
       handoffPrepare：项目文件夹 → 画布（按工作目录匹配 / 没有就新建）
                       + 常驻「外部交接 · 项目名」会话（复用 / 新建）
       handoffSend：往那条会话发一轮并**等它结束**（模型提问卡住时会一直等，
                    外部调用方作答后这一轮继续 —— 主进程那边靠作业表回 needs_answer）
     为什么在渲染层：画布对象与会话的真源都只在这里（与 mtnode_run / mtnode_session 同源）。 */

  const HANDOFF_PREFIX = "外部交接 · ";

  function baseNameOf(p) {
    const s = String(p || "").replace(/[\\/]+$/, "");
    const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
    return i >= 0 ? s.slice(i + 1) : s;
  }

  /** 同一个文件夹的比较口径：统一分隔符、去尾斜杠、大小写不敏感（Windows）。
   *  只用于「这张画布是不是这个项目的」，不用于落盘路径。 */
  function samePath(a, b) {
    const norm = (v) =>
      String(v || "")
        .trim()
        .replace(/\//g, "\\")
        .replace(/\\+$/, "")
        .toLowerCase();
    return !!a && !!b && norm(a) === norm(b);
  }

  function sessionRunning(st) {
    return typeof sessionIsRunning === "function" ? !!sessionIsRunning(st) : !!(st && st.running);
  }

  function modelNow(st) {
    const dsh = (S && S.config && S.config.dsh) || {};
    return {
      provider: String((st && st.provider) || dsh.provider || ""),
      model: String((st && st.model) || dsh.model || ""),
      effort: String((st && st.effort) || dsh.effort || ""),
    };
  }

  async function resolveCanvasForFolder(folder, wantRef) {
    if (wantRef) {
      const wf = await window.MTNodeMcp.resolveWf(wantRef);
      if (!wf) return { error: "画布不存在：" + wantRef };
      return { wf: wf, matchedBy: "explicit" };
    }
    const list = (await window.api.wfList()) || [];
    /* wfList 已按 mtime 倒序 = 最近活跃在前（用户口径：同文件夹多张图取最近活跃那张） */
    const hit = list.find((x) => x && samePath(x.workspace, folder));
    if (!hit) return { wf: null, matchedBy: "none" };
    const r = await window.api.wfLoad(hit.id);
    const wf = r && r.ok ? r.data : null;
    if (!wf) return { error: "画布读不出来：" + hit.id };
    return { wf: wf, matchedBy: "workspace" };
  }

  async function createCanvasForFolder(folder) {
    const id = "wf_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const name = baseNameOf(folder) || "外部交接";
    /* 与「新建画布」对话框同一份最小结构（工作目录必填；不抢用户的页签与前台画布） */
    const wf = { id: id, name: name, nodes: [], wires: [], groups: [], marks: [], workspace: folder };
    const r = await window.api.wfSave(id, wf);
    if (r && r.ok === false) return { error: "新建画布失败：" + String(r.error || "写盘失败") };
    return { wf: wf };
  }

  function handoffSessionsOf(canvasId) {
    const list = typeof agentSessions === "function" ? agentSessions() || [] : [];
    return list.filter(
      (s) =>
        s &&
        !s.archived &&
        String(s.canvasWfId || "") === String(canvasId || "") &&
        String(s.title || "").indexOf(HANDOFF_PREFIX) === 0,
    );
  }

  /** 「设置 · 默认模型提供商」此刻解析出来的那一只（全应用唯一一份解析 = dshDefaultModelPick）。
   *  解析不出来就**如实报错并指路**，绝不偷偷换一只 —— 交接跑的是用户的钱与配额。 */
  function handoffModel() {
    if (typeof dshDefaultModelPick !== "function") return { ok: true, model: null };
    let pick = null;
    try {
      pick = dshDefaultModelPick();
    } catch (e) {
      return { ok: false, error: "DEFAULT_MODEL_UNAVAILABLE", message: String((e && e.message) || e) };
    }
    if (!pick || !pick.ok)
      return {
        ok: false,
        error: "DEFAULT_MODEL_UNAVAILABLE",
        message: String((pick && pick.reason) || "默认模型不可用：请到 设置 · 默认模型提供商 里选一只模型。"),
      };
    return {
      ok: true,
      model: {
        provider: String(pick.route || ""),
        model: String(pick.model || ""),
        effort: typeof dshDefaultEffortValue === "function" ? String(dshDefaultEffortValue() || "") : "",
      },
    };
  }

  function createHandoffSession(p, wf, folder, model) {
    if (typeof newAgentSession !== "function") throw new Error("渲染层没有 newAgentSession");
    const prevActive = String((typeof activeAgentId === "function" ? activeAgentId() : "") || "");
    const st = newAgentSession();
    st.title = HANDOFF_PREFIX + (String((p && p.title) || "").trim() || String(wf.name || baseNameOf(folder) || "项目"));
    /* 标题锁死：首轮自动命名不许把它改成「项目里的第一句话」，否则下次交接就找不到这条会话了 */
    st.titleLocked = true;
    st.canvasWfId = String(wf.id || "");
    st.workspace = folder;
    st.external = true;
    st.handoffFolder = folder;
    /* 模型一律跟「设置 · 默认模型提供商」：新建会话本来会沿用上一条会话的选择，
       外部交接不该继承用户上一次的临时换模型（用户口径）。 */
    if (model) {
      st.provider = String(model.provider || "");
      st.model = String(model.model || "");
      if (model.effort) st.effort = String(model.effort);
    }
    try {
      if (typeof agentMarkSessionDirty === "function") agentMarkSessionDirty(st.id);
      if (typeof agentFlushSessionSave === "function") agentFlushSessionSave();
    } catch (_) {}
    try {
      S.agentActiveId = prevActive;
      if (typeof agentFlushSessionSaveQuiet === "function") agentFlushSessionSaveQuiet();
    } catch (_) {}
    try {
      if (typeof renderAgentSessionSidebar === "function") renderAgentSessionSidebar();
    } catch (_) {}
    return st;
  }

  async function handoffPrepare(params) {
    const p = params || {};
    const folder = String(p.projectFolder || "").trim();
    if (!folder) return { ok: false, error: "NO_PROJECT_FOLDER", message: "handoffPrepare 需要 projectFolder" };
    const wantSid = String(p.sessionId || "").trim();
    if (wantSid) {
      const st0 = typeof agentSessionById === "function" ? agentSessionById(wantSid) : null;
      if (!st0) return { ok: false, error: "SESSION_GONE", message: "会话不存在或已被删除：" + wantSid };
      if (sessionRunning(st0))
        return {
          ok: false,
          error: "SESSION_BUSY",
          message: "这条会话正在跑（" + String(st0.title || wantSid) + "）：先 status / read 看进度，或等它跑完。",
        };
      return {
        ok: true,
        sessionId: wantSid,
        sessionTitle: String(st0.title || ""),
        sessionReused: true,
        canvasId: String(st0.canvasWfId || ""),
        canvasName: "",
        workspace: String(st0.workspace || folder),
        model: modelNow(st0),
      };
    }
    /* 默认模型先解析：不可用就别白建画布 / 会话（也避免「跑起来才发现模型没了」） */
    const pick = handoffModel();
    if (!pick.ok) return { ok: false, error: pick.error, message: pick.message };
    const res = await resolveCanvasForFolder(folder, String(p.canvas || "").trim());
    if (res.error) return { ok: false, error: "CANVAS_UNRESOLVED", message: res.error };
    let wf = res.wf;
    let canvasCreated = false;
    if (!wf) {
      const made = await createCanvasForFolder(folder);
      if (made.error) return { ok: false, error: "CANVAS_CREATE_FAILED", message: made.error };
      wf = made.wf;
      canvasCreated = true;
    }
    const canvasId = String(wf.id || "");
    /* 一个项目文件夹一条常驻交接会话：在跑就如实报忙，不排队、不重复起会话 */
    const same = handoffSessionsOf(canvasId);
    const busy = same.find((s) => sessionRunning(s));
    if (busy)
      return {
        ok: false,
        error: "SESSION_BUSY",
        message: "这个项目的交接会话正在跑（" + String(busy.title || "") + "）：先 status / read，或 steer / stop 后再交接。",
      };
    let st = same[0] || null;
    let sessionCreated = false;
    if (!st) {
      st = createHandoffSession(p, wf, folder, pick.model);
      sessionCreated = true;
    } else if (pick.model) {
      /* 复用的常驻会话也跟着「默认模型提供商」走（用户改了设置，下次交接立刻生效） */
      if (pick.model.provider) st.provider = String(pick.model.provider);
      if (pick.model.model) st.model = String(pick.model.model);
      if (pick.model.effort) st.effort = String(pick.model.effort);
      try {
        if (typeof agentMarkSessionDirty === "function") agentMarkSessionDirty(st.id);
        if (typeof agentFlushSessionSave === "function") agentFlushSessionSave();
      } catch (_) {}
    }
    return {
      ok: true,
      sessionId: String(st.id),
      sessionTitle: String(st.title || ""),
      sessionReused: !sessionCreated,
      sessionCreated: sessionCreated,
      canvasId: canvasId,
      canvasName: String(wf.name || ""),
      workspace: String(wf.workspace || folder),
      canvasCreated: canvasCreated,
      canvasMatchedBy: res.matchedBy,
      model: pick.model || modelNow(st),
    };
  }

  function buildHandoffMessage(p, st) {
    const folder = String((p && p.projectFolder) || (st && st.workspace) || "").trim();
    return [
      "[外部交接] 这条消息由外部 agent 经 MCP 交来，请你直接动手做完。",
      "项目文件夹：" + folder + "（画布已绑定到它；读写都落在这个目录里）",
      "",
      String((p && p.task) || "").trim(),
      "",
      "要求：把事情做完再回话；确需澄清时用 ask_user_question 提一个具体问题（外部调用方会回答）；" +
        "收尾用一两句说清改了什么、产物在哪（外部调用方只能看到你的最后一段回复与工具时间线）。",
    ].join("\n");
  }

  async function handoffSend(params) {
    const p = params || {};
    const sid = String(p.sessionId || "").trim();
    const task = String(p.task || "").trim();
    if (!sid) return { ok: false, error: "NO_SESSION", message: "handoffSend 需要 sessionId" };
    if (!task) return { ok: false, error: "NO_TASK", message: "handoffSend 需要 task" };
    const st = typeof agentSessionById === "function" ? agentSessionById(sid) : null;
    if (!st) return { ok: false, error: "SESSION_GONE", message: "会话不存在或已被删除：" + sid };
    if (!st._lcLoaded && typeof agentEnsureSessionBody === "function") {
      try {
        await agentEnsureSessionBody(st);
      } catch (_) {}
    }
    if (sessionRunning(st)) return { ok: false, error: "SESSION_BUSY", message: "这条会话正在跑：等它跑完再交接。" };
    if (typeof agentSessionSend !== "function") return { ok: false, error: "NO_SENDER", message: "渲染层没有 agentSessionSend" };
    /* 切成活动会话是为了**落盘**（与手机端 sessionSend 同一理由）；跑完还原，不抢用户正在看的会话 */
    const prevActive = String((typeof activeAgentId === "function" ? activeAgentId() : "") || "");
    try {
      S.agentActiveId = sid;
    } catch (_) {}
    let err = "";
    try {
      await agentSessionSend(buildHandoffMessage({ task: task, projectFolder: p.projectFolder }, st), { sessionId: sid });
    } catch (e) {
      err = String((e && e.message) || e);
    }
    try {
      S.agentActiveId = prevActive;
      if (typeof renderAgentSessionSidebar === "function") renderAgentSessionSidebar();
    } catch (_) {}
    const reply = lastAssistantText(st);
    if (err) return { ok: false, error: "ROUND_FAILED", message: err, sessionId: sid, reply: reply };
    return {
      ok: true,
      sessionId: sid,
      reply: reply,
      running: sessionRunning(st),
      error: st.error ? String(st.error) : "",
    };
  }

  window.MTNodeMcpExtra = {
    run: run,
    tools: tools,
    sessionTask: sessionTask,
    mediaNode: mediaNode,
    handoffPrepare: handoffPrepare,
    handoffSend: handoffSend,
  };
})();
