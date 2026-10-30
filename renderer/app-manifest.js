"use strict";
/**
 * 项目 manifest · 渲染层执行桥（Agent 工具 mtnode_manifest + 生成节点的 requireAsset 闸门）
 *
 * 三段职责：
 *   ① 定位工程根：显式 root > 当前画布工作目录（wf.workspace）；都没有 → 明确报错
 *      （共识：不隐式兜底到数据目录，也不静默建空档）。
 *   ② 把网关推来的 manifest 帧（{action, params}，来自 dsh/gateway/manifest-plugin.mjs）
 *      接到主进程 manifest:op，回执经 dshInteract kind:'manifest' 原路回去。
 *      `ok:false` 一律折成**工具错误**（error 文本），会话不中断 —— 与 db / facts 同口径。
 *   ③ 生成节点的 requireAsset 闸门：节点显式开了它，就必须在 assetRefs 里声明
 *      "id@rev"，且这些引用要在工程 manifest 里真实存在、rev 对得上；否则拒跑并点名缺哪一项。
 *      纯文本直出（没有 assetRefs）直接拒跑 —— 这就是缺口文档 G3 规则 2 的执行体。
 *
 * 真源分工：manifest 的读写与推导全在 manifest-store.js（主进程），这里只做路径定位与
 * 回执搬运，绝不自己写文件、也不缓存一份 manifest。
 */

/** 当前画布（与本轮绑定画布无关：playNode / 工具帧都按运行时的前台画布取） */
function mfCurrentWf() {
  try {
    if (typeof currentVisibleWf === "function") return currentVisibleWf();
  } catch (_) {}
  return typeof S === "object" && S ? S.wf : null;
}

/**
 * 工程根：显式 root > 画布工作目录。
 * @returns {{root:string, source:string}|{error:string}}
 */
function mfRootOf(wf, explicit) {
  const ex = String(explicit == null ? "" : explicit).trim();
  if (ex) return { root: ex, source: "explicit" };
  const w = wf && typeof wf === "object" ? wf : mfCurrentWf();
  const ws = String((w && w.workspace) || "").trim();
  if (ws) return { root: ws, source: "canvas" };
  return {
    error:
      "没有工程根目录：请给这张画布设置「画布工作目录」（顶栏），或在调用里显式传 root" +
      "（manifest.json 就在该目录下）",
  };
}

function mfCall(root, action, params) {
  const api = typeof window === "object" && window ? window.api : null;
  if (!api || typeof api.manifestOp !== "function") {
    return Promise.resolve({ ok: false, code: "no_bridge", error: "manifest 桥未就绪（preload 未加载 manifestOp）" });
  }
  return api
    .manifestOp({ root, action, params: params || {} })
    .catch((e) => ({ ok: false, code: "ipc", error: String((e && e.message) || e) }));
}

/** 节点上声明的资产引用（数组或逗号 / 空白分隔的字符串都收） */
function mfRefsOf(node) {
  const raw = node && node.assetRefs;
  const list = Array.isArray(raw) ? raw : String(raw == null ? "" : raw).split(/[,，\s]+/);
  const out = [];
  for (const x of list) {
    const v = String(x == null ? "" : x).trim();
    if (v && out.indexOf(v) < 0) out.push(v);
  }
  return out;
}

/**
 * Agent 工具帧：mtnode_manifest → 主进程。
 * @param {object} data 帧（{id, action, params}）
 * @param {object} [node] 发起方节点（智能节点 / 空）
 * @param {object} [wf] 本轮绑定画布
 * @param {(result:any, error?:string)=>void} [replyOverride] MCP 通道用
 */
async function handleManifestToolEvent(data, node, wf, replyOverride) {
  const id = data && data.id;
  const reply =
    typeof replyOverride === "function"
      ? replyOverride
      : (result, error) =>
          window.api
            .dshInteract({ kind: "manifest", id, result, error: error || undefined })
            .catch(() => {});
  if (!id) return;
  const p = Object.assign({}, (data && data.params) || {});
  const action = String((data && data.action) || p.action || "get");
  const r = mfRootOf(wf, p.root);
  delete p.root;
  if (r.error) {
    reply({ ok: false, code: "no_root", error: r.error }, r.error);
    return;
  }
  const out = await mfCall(r.root, action, p);
  if (out && out.ok === false) {
    reply(out, String(out.error || "manifest 操作失败"));
    return;
  }
  reply(out == null ? { ok: true } : out);
}

/**
 * 生成节点闸门（requireAsset）：关着就是直通，开着就必须有真实可用的资产引用。
 * @returns {{ok:true}|{ok:false, error:string}}
 */
async function mfAssetGate(node) {
  if (!node || !node.requireAsset) return { ok: true };
  const kind = String(node.kind || "");
  const refs = mfRefsOf(node);
  if (!refs.length) {
    return {
      ok: false,
      error:
        "「必须引用资产」(requireAsset) 已开，但 assetRefs 为空：" +
        kind +
        " 不允许纯文本直出。请先把角色 / 主场景的参考图接进图像端子，并在设置里填资产引用（形如 char_lin@3）。",
    };
  }
  const r = mfRootOf(mfCurrentWf(), "");
  if (r.error) return { ok: false, error: r.error };
  const out = await mfCall(r.root, "validate_refs", { refs });
  if (!out || out.ok === false) {
    const detail =
      out && Array.isArray(out.errors) && out.errors.length
        ? out.errors.map((e) => e.msg || e.error || "").filter(Boolean).join("；")
        : String((out && out.error) || "校验失败");
    return { ok: false, error: "资产引用校验未通过，本节点不运行：" + (detail || "（无详情）") };
  }
  return { ok: true };
}
