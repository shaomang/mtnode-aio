"use strict";
/**
 * 项目 manifest · 主进程宿主（数据层在 manifest-store.js）
 *
 * 只有一件事：把渲染层送来的 `{root, action, params}` 交给 manifest-store 执行，
 * 并把结果（含错误文本）原样回给调用方。**不解析画布、不知道画布工作目录** ——
 * root 由渲染层按「显式 root > 当前画布工作目录」定好后传进来（共识口径），
 * 主进程不猜路径，也不静默兜底到数据目录。
 *
 * Agent 链路：dsh/gateway/manifest-plugin.mjs（mtnode_manifest）→ 网关帧 →
 * renderer/app-manifest.js → IPC `manifest:op` → 这里。
 */

const { ipcMain } = require("electron");
const store = require("./manifest-store.js");

let registered = false;

function publicResult(r) {
  if (!r || typeof r !== "object") return { ok: false, error: "manifest 操作没有返回结果" };
  return r;
}

function registerManifestIpc() {
  if (registered) return;
  registered = true;
  ipcMain.handle("manifest:op", (_e, payload) => {
    const p = payload && typeof payload === "object" ? payload : {};
    const root = String(p.root || "").trim();
    const action = String(p.action || "get").trim();
    try {
      const out = store.applyOp(root, action, p.params && typeof p.params === "object" ? p.params : {});
      return publicResult(out);
    } catch (e) {
      return {
        ok: false,
        code: "exception",
        error: String((e && e.message) || e),
      };
    }
  });
}

module.exports = { registerManifestIpc };
