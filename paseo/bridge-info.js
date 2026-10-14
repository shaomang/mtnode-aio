/* paseo/bridge-info.js — 「Paseo 桥」的落点与配置片段（**单一真源**）
 *
 * 为什么单独一个 CJS 文件：同一份事实有两位读者 ——
 *   · 主进程（main.js 的 paseo:status IPC）要给「Paseo 桥」面板算脚本路径与
 *     provider 配置片段，而它是 CJS，不方便 import 一份 ESM；
 *   · 桥自己（paseo/acp-bridge.mjs）要用同一份口径做 --config / --check。
 * 两边各抄一份必然漂移（历史教训：MCP 的 stdio 片段曾出现「/meta 说 exe、面板说 node」），
 * 所以这里放纯函数，ESM 与 CJS 都能取（ESM 用 default import）。
 *
 * 新增根目录之外的模块也要进 build.json 白名单吗？—— 看**谁 require 它**：
 *   · 桥脚本自己（acp-bridge.mjs）走 extraResources → resources/paseo（asar 外，外部 Node 读得到），
 *     这条链**不需要** files 白名单；
 *   · 但 main.js 顶层 `require("./paseo/bridge-info.js")` 是按 asar 内路径解析的，
 *     所以 bridge-info.js 必须同时写进 build.json 的 files 白名单 —— 否则打包后启动即
 *     Cannot find module './paseo/bridge-info.js'，main.js 求值中断、窗口都出不来
 *     （2026-10-14 实发过一次，见 test/smoke-session-bridge.js [7] 的白名单断言）。
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

/** 桥的 ACP 协议版本与最低兼容 Paseo 版本（改了要同步 test/smoke-paseo-bridge.mjs 的口径）。 */
const ACP_PROTOCOL_VERSION = 1;
const PASEO_MIN_VERSION = process.env.MTNODE_PASEO_MIN_VERSION || "0.1.0";

/** MTNode 数据目录候选（与 mcp-stdio.js 同一顺序：环境变量 → 应用数据根\pipeline-console
 *  → data-root.json 指定的自定义目录 → 应用数据根）。第一个存在的就是面板要显示的那个。 */
function dataDirCandidates() {
  const out = [];
  const env = String(process.env.MTNODE_DATA_DIR || "").trim();
  if (env) out.push(env, path.join(env, "pipeline-console"));
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const base = path.join(appData, "pipeline-console");
  out.push(path.join(base, "pipeline-console"), base);
  for (const root of [...out]) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(root, "data-root.json"), "utf8"));
      const dir = String((j && (j.dataDir || j.dir || j.path)) || "").trim();
      if (dir) out.push(dir, path.join(dir, "pipeline-console"));
    } catch {
      /* 没有就是没有 */
    }
  }
  return [...new Set(out.filter(Boolean))];
}

/** 桥脚本与真 Node 的落点。opts = { resourcesDir?, nodeBin?, dataDir?, appRoot? }。
 *  打包态脚本在 resources/paseo/（extraResources，asar 外 —— 外部 Node 读不了 asar 内路径）；
 *  开发态在项目根 paseo/。找不到任何一个时按第一个候选返回（面板会照实显示，便于排障）。 */
function bridgePaths(opts) {
  const o = opts || {};
  const appRoot = String(o.appRoot || path.join(__dirname, "..")).trim();
  const packagedRoot = String(o.resourcesDir || "").trim();
  const candidates = [
    packagedRoot ? path.join(packagedRoot, "paseo", "acp-bridge.mjs") : "",
    path.join(appRoot, "paseo", "acp-bridge.mjs"),
    path.join(__dirname, "acp-bridge.mjs"),
  ].filter(Boolean);
  const exists = (p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  };
  const script = candidates.find(exists) || candidates[0];
  const node = String(o.nodeBin || "").trim() || process.execPath;
  const dataDir = String(o.dataDir || "").trim() || dataDirCandidates()[0] || "";
  return { script, node, dataDir, packaged: !!packagedRoot, candidates };
}

/** 要写进 ~/.paseo/config.json 的那一段（面板一键复制与桥的 --config 同一份）。 */
function providerSnippet(opts) {
  const p = bridgePaths(opts);
  return JSON.stringify(
    {
      agents: {
        providers: {
          mtnode: {
            extends: "acp",
            label: "MTNode 会话",
            command: [p.node, p.script],
            env: { MTNODE_DATA_DIR: p.dataDir },
          },
        },
      },
    },
    null,
    2,
  );
}

/** 面板用的状态摘要：**不探活、不调 MTNode**（面板渲染要快，探活交给桥的 --check）。 */
function bridgeStatus(opts) {
  const p = bridgePaths(opts);
  return {
    ok: true,
    script: p.script,
    scriptExists: (() => {
      try {
        return fs.existsSync(p.script);
      } catch {
        return false;
      }
    })(),
    node: p.node,
    dataDir: p.dataDir,
    packaged: p.packaged,
    protocolVersion: ACP_PROTOCOL_VERSION,
    paseoMinVersion: PASEO_MIN_VERSION,
    snippet: providerSnippet(opts),
    checkCommand: '"' + process.execPath + '" "' + p.script + '" --check',
    dataDirs: dataDirCandidates(),
  };
}

module.exports = {
  ACP_PROTOCOL_VERSION,
  PASEO_MIN_VERSION,
  dataDirCandidates,
  bridgePaths,
  providerSnippet,
  bridgeStatus,
};
