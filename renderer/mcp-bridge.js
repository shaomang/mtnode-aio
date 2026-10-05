/**
 * MTNode MCP · 渲染层执行桥
 *
 * 主进程 MCP 服务端（mcp-server.js）把客户端调用推成 {id, sessionId, clientId, op, params, write}
 * 帧（webContents.send('mcp:event')），这里负责把它接到**既有的宿主执行路径**上：
 *   op=get/edit/app/vision → handleCanvasEvent（与自家 Agent 同一套确认 / 准入 / 落盘逻辑）
 *   op=db                  → handleDbToolEvent（找本轮画布上挂着的数据库副本节点）
 *   op=facts               → handleAiFactsToolEvent（本画布 ai-facts.json）
 *   op=asset               → handleAssetToolEvent（素材库 / 窗口截图）
 *   op=lt                  → 长任务状态（只在长任务 Agent 环节内有意义，见下方注释）
 *   op=canvasList/skillList/skillBody → 只读资源
 * 回执经 window.api.mcpInteract 回主进程。
 *
 * 三条纪律：
 *   1) 画布真源只在渲染层：这里不改画布文件、不另写一套执行器。
 *   2) 一次连接同一时刻只有一笔写（主进程已排队，这里再按 runKey 把写入串起来）。
 *   3) 第三方连接的画布写**按首次连接授权生效**（共识），不再逐笔弹确认框 ——
 *      确认状态放在 S._mcpAuthorized，由本桥在每次调用前后开关，绝不常驻。
 *
 * 多画布：MCP 用 canvas 参数（id / 精确名称）选目标；解析结果经 runCtx.canvasTarget
 *   交给 canvasTargetWf()（app.js），于是「用户正开着别的画布」也不会改错图。
 */
"use strict";

(function () {
  /** 每次调用允许的最长等待（主进程另有 15 分钟上限，这里只是保险） */
  const MCP_CALL_TIMEOUT_MS = 15 * 60 * 1000;

  /** runKey 前缀：与自家会话 / 节点 / 助手的 runKey 命名空间分开，绝不撞车 */
  const RUN_PREFIX = "mcp:";

  /** lt_state 的能力边界（如实告知，不假装能推进长任务）： */
  const LT_NOTE =
    "lt_state 只在**长任务的 Agent 环节内部**可用（那里的伪节点声明了本轮可写的输出键）。" +
    "MCP 连接不在任何长任务环节里，因此这里没有可读写的本轮状态。" +
    "要查看 / 修改长任务图与运行状态，用 mtnode_app 的 get_longtask / update_longtask / create_longtask；" +
    "「启用运行 / 推进 / 审批交付」由应用侧的人在界面上操作，MCP 不做。";

  let seq = 0;

  function nextRunKey(sessionId) {
    seq += 1;
    return RUN_PREFIX + String(sessionId || "anon") + ":" + seq;
  }

  function reply(id, result, error) {
    try {
      return window.api
        .mcpInteract({ id, result: result === undefined ? null : result, error: error || undefined })
        .catch(() => {});
    } catch (_) {
      return Promise.resolve();
    }
  }

  /** 带超时的等待：既有的 canvasConfirm* 回执只认 window.api.dshInteract 的 kind，
   *  所以 MCP 帧的收口走 handleCanvasEvent 里的 mcpFrameSettle（见 app-nodes.js）。 */
  function withTimeout(promise, what) {
    let timer = null;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(what + "：渲染层处理超时（" + Math.round(MCP_CALL_TIMEOUT_MS / 1000) + "s）")),
        MCP_CALL_TIMEOUT_MS,
      );
    });
    return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
  }

  /* ── 画布目标解析 ─────────────────────────────────────────────────────── */

  /** canvas 参数：空 = 当前画布（返回 null，交给既有口径）；否则解析成画布对象。
   *  支持 id、精确名称、唯一前缀（与 mtnode_app 的 workflow 参数同一宽容度）。 */
  function resolveWf(ref) {
    const want = String(ref || "").trim();
    if (!want || want === "current") return null;
    const cur = typeof currentVisibleWf === "function" ? currentVisibleWf() : null;
    if (cur && (String(cur.id) === want || String(cur.name || "") === want)) return cur;
    const all = (S.wfs || []).concat(cur ? [cur] : []);
    const seen = new Set();
    const list = all.filter((w) => w && !seen.has(w.id) && seen.add(w.id));
    let hit = list.find((w) => String(w.id) === want);
    if (!hit) hit = list.find((w) => String(w.name || "") === want);
    if (!hit) {
      const pre = list.filter((w) => String(w.name || "").indexOf(want) === 0);
      if (pre.length === 1) hit = pre[0];
      else if (pre.length > 1)
        throw new Error(
          "画布名有歧义（" + want + "）：" + pre.map((w) => w.name).join("、") + "；请用画布 id。",
        );
    }
    if (!hit) throw new Error("找不到画布：" + want + "（用 mtnode_app 的 list_workflows 或资源 mtnode://canvases 看清单）");
    return hit;
  }

  /** 画布内容版本：读一次拿 contentHash（与自家 Agent 的乐观并发同一真源）。 */
  async function contentHashOf(wf) {
    const snap = await runAgainstWf(wf, () =>
      canvasSnapshotFull({ detail: "minimal" }, { wf: wf, restrict: false }),
    );
    return String((snap && snap.contentHash) || "");
  }

  /* ── 各 op 的落地 ─────────────────────────────────────────────────────── */

  function mcpHandleCanvas(frame, runKey) {
    const p = Object.assign({}, frame.params || {});
    const ref = String(p.canvas || "").trim();
    delete p.canvas;
    const baseHash = String(p.baseHash || "").trim();
    delete p.baseHash;
    const op = String(frame.op || "get");
    const target = ref ? resolveWf(ref) : null;
    const runKeyOfFrame = runKey;
    const run = () =>
      handleCanvasEvent(
        { id: frame.id, sessionId: frame.sessionId, op: op, params: p, database: p.database },
        {
          runKey: runKeyOfFrame,
          sessionId: frame.sessionId,
          wf: target || (typeof currentVisibleWf === "function" ? currentVisibleWf() : S.wf),
          canvasTarget: target,
          mcpFrameSettle: (result, error) => reply(frame.id, result, error),
          /* 无本轮 planMode / nodeLock：MCP 连接不是画布智能节点，也不是规划模式 */
        },
      );
    if (!baseHash || (op !== "edit" && op !== "app")) return run();
    /* 写操作 + 客户端声明了 baseHash：先比一次内容哈希（过期即拒，不做半截修改） */
    return (async () => {
      const cur = await contentHashOf(target || (typeof currentVisibleWf === "function" ? currentVisibleWf() : S.wf));
      if (cur && cur !== baseHash) {
        reply(
          frame.id,
          { ok: false, error: "画布已被改动（版本不一致），本次修改未执行" },
          "画布已被改动（版本不一致），本次修改未执行：请重新 mtnode_canvas_get 读一遍再改",
        );
        return;
      }
      run();
    })();
  }

  function mcpHandleDb(frame, runKey) {
    const p = Object.assign({}, frame.params || {});
    const ref = String(p.canvas || "").trim();
    delete p.canvas;
    const target = ref ? resolveWf(ref) : null;
    const wf = target || (typeof currentVisibleWf === "function" ? currentVisibleWf() : S.wf);
    const replyToMcp = (result, error) => reply(frame.id, result, error);
    return runAgainstWf(wf, () =>
      handleDbToolEvent(
        {
          id: frame.id,
          params: p,
          action: p.action,
          database: p.database,
        },
        null,
        wf,
        replyToMcp,
      ),
    );
  }

  function mcpHandleFacts(frame) {
    const p = Object.assign({}, frame.params || {});
    const ref = String(p.canvas || "").trim();
    delete p.canvas;
    const target = ref ? resolveWf(ref) : null;
    const wf = target || (typeof currentVisibleWf === "function" ? currentVisibleWf() : S.wf);
    const replyToMcp = (result, error) => reply(frame.id, result, error);
    return handleAiFactsToolEvent({ id: frame.id, params: p, action: p.action }, wf, replyToMcp);
  }

  function mcpHandleAsset(frame) {
    const p = Object.assign({}, frame.params || {});
    delete p.canvas;
    const replyToMcp = (result, error) => reply(frame.id, result, error);
    return handleAssetToolEvent({ id: frame.id, params: p, action: p.action }, null, replyToMcp);
  }

  function mcpHandleLt(frame) {
    /* 只读：把长任务的定义与运行态（若在跑）交给客户端 —— 走既有的 LT 只读入口，
       不做任何状态写入（写入只在长任务 Agent 环节里有归属，见 LT_NOTE）。 */
    const p = Object.assign({}, frame.params || {});
    const ref = String(p.canvas || "").trim();
    delete p.canvas;
    const target = ref ? resolveWf(ref) : null;
    const wf = target || (typeof currentVisibleWf === "function" ? currentVisibleWf() : S.wf);
    if (!wf || !window.LT || typeof window.LT.stateRead !== "function") {
      reply(frame.id, { ok: false, error: LT_NOTE }, "lt_state 不可用");
      return;
    }
    try {
      const out = window.LT.stateRead();
      reply(frame.id, { ok: true, note: LT_NOTE, state: out == null ? null : out });
    } catch (e) {
      reply(frame.id, { ok: false, error: LT_NOTE }, (e && e.message) || String(e));
    }
  }

  async function mcpCanvasList(frame) {
    let list = [];
    try {
      list = (await window.api.wfList()) || [];
    } catch (_) {}
    const cur = typeof currentVisibleWf === "function" ? currentVisibleWf() : S.wf;
    reply(
      frame.id,
      (list || []).map((w) => ({
        id: w.id,
        name: w.name,
        nodes: w.nodes,
        active: !!(cur && String(cur.id) === String(w.id)),
      })),
    );
  }

  async function mcpSkillList(frame) {
    try {
      const r = await window.api.mtnodeAgentSkillIndex();
      const idx = (r && r.index) || {};
      const flat = [];
      const walk = (node, cat) => {
        if (!node) return;
        if (Array.isArray(node)) return node.forEach((x) => walk(x, cat));
        if (typeof node !== "object") return;
        if (node.name && node.path) {
          flat.push({
            name: String(node.name),
            title: String(node.title || ""),
            description: String(node.description || ""),
            category: String(cat || node.category || ""),
            path: String(node.path),
          });
        }
        for (const [k, v] of Object.entries(node)) {
          if (k === "name" || k === "path" || k === "title" || k === "description") continue;
          if (v && typeof v === "object") walk(v, cat || k);
        }
      };
      walk(idx, "");
      reply(frame.id, { libraryPath: (r && r.libraryPath) || "", count: flat.length, skills: flat });
    } catch (e) {
      reply(frame.id, { ok: false, error: (e && e.message) || String(e) }, (e && e.message) || String(e));
    }
  }

  async function mcpSkillBody(frame) {
    const name = String((frame.params || {}).name || "").trim();
    if (!name) {
      reply(frame.id, { ok: false, error: "缺少技能名" }, "缺少技能名");
      return;
    }
    try {
      const r = await window.api.mtnodeAgentSkillGet(name);
      if (!r || r.ok === false || !r.body) {
        const err = "技能不存在：" + name;
        reply(frame.id, { ok: false, error: err }, err);
        return;
      }
      reply(frame.id, r.body);
    } catch (e) {
      reply(frame.id, { ok: false, error: (e && e.message) || String(e) }, (e && e.message) || String(e));
    }
  }

  /* ── 入口 ─────────────────────────────────────────────────────────────── */

  /** 写操作串行化：同一连接同一时刻只有一笔写（主进程也已排队，这里是第二道）。 */
  const writeChains = new Map();

  async function handleMcpFrame(frame) {
    if (!frame || !frame.id) return;
    const sessionKey = String(frame.sessionId || "anon");
    const runKey = nextRunKey(sessionKey);
    const isWrite = !!frame.write;
    /* 这一帧的「在途轮」登记：宿主用 S._runCancels 判活（canvasConfirmRunLive）。
       MCP 调用不属于任何 dsh 轮，不登记就会被判成「发起轮已结束」而整帧被拒
       （canvas 族 get/edit/app 全走这条路），所以在这一帧的生命周期内占一个位，
       finally 里立刻撤掉 —— 只覆盖这一帧，别处一律看不到常驻痕迹。 */
    S._runCancels = S._runCancels || {};
    const runTicket = { cancelTag: runKey, mcp: true };
    S._runCancels[runKey] = runTicket;
    const releaseRun = () => {
      if (S._runCancels && S._runCancels[runKey] === runTicket) delete S._runCancels[runKey];
    };
    const body = async () => {
      /* 首次连接授权 = 不再逐笔弹确认框：把开关打开，跑完立刻恢复原值。
         授权窗口只覆盖这一帧（同步设、finally 复原），不常驻、不影响用户自己的会话。 */
      const prevAuth = S._mcpAuthorized;
      S._mcpAuthorized = true;
      try {
        switch (String(frame.op || "")) {
          case "get":
          case "edit":
          case "app":
          case "vision":
            return await mcpHandleCanvas(frame, runKey);
          case "db":
            return mcpHandleDb(frame, runKey);
          case "facts":
            return mcpHandleFacts(frame);
          case "asset":
            return mcpHandleAsset(frame);
          case "lt":
            return mcpHandleLt(frame);
          case "canvasList":
            return mcpCanvasList(frame);
          case "skillList":
            return mcpSkillList(frame);
          case "skillBody":
            return mcpSkillBody(frame);
          default: {
            const err = "未知的 MCP 操作：" + frame.op;
            reply(frame.id, { ok: false, error: err }, err);
          }
        }
      } finally {
        S._mcpAuthorized = prevAuth;
      }
    };
    if (!isWrite) {
      try {
        await withTimeout(body(), "MCP 调用");
      } catch (e) {
        reply(frame.id, { ok: false, error: (e && e.message) || String(e) }, (e && e.message) || String(e));
      } finally {
        releaseRun();
      }
      return;
    }
    const prev = writeChains.get(sessionKey) || Promise.resolve();
    const next = prev.then(
      () => withTimeout(body(), "MCP 写调用"),
      () => withTimeout(body(), "MCP 写调用"),
    );
    writeChains.set(
      sessionKey,
      next.then(
        () => {},
        () => {},
      ),
    );
    try {
      await next;
    } catch (e) {
      reply(frame.id, { ok: false, error: (e && e.message) || String(e) }, (e && e.message) || String(e));
    } finally {
      releaseRun();
    }
  }

  window.MTNodeMcp = {
    handleFrame: handleMcpFrame,
    resolveWf: resolveWf,
    note: LT_NOTE,
  };

  /* 帧入口：主进程 mcp-server.js 每收到一次客户端调用就推一帧过来。
     只订阅一次（脚本只加载一次）；卸载函数留给将来热重载用。 */
  if (window.api && typeof window.api.mcpOnEvent === "function") {
    window.MTNodeMcp.off = window.api.mcpOnEvent((frame) => handleMcpFrame(frame));
  }
})();
