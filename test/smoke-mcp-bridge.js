"use strict";
/* MCP 执行桥（renderer/mcp-bridge.js）—— 真渲染引擎里跑一遍的回归
 *   node test/smoke-mcp-bridge.js
 * 为什么单独一只：mcp-bridge.js 的职责是「把主进程推来的帧接到既有宿主处理函数上」，
 * 纯文本断言证明不了它真的会调对函数、真的会开关授权、真的会在版本不一致时拒绝。
 * 做法（与 test/smoke-slash-menu-reuse.js 同思路）：起一只离屏 BrowserWindow 加载真 index.html
 * （去掉应用脚本），把 **产品代码原文** mcp-bridge.js 注入渲染层，配一层可观测的宿主桩，
 * 然后喂真帧、看回执。
 * 覆盖：
 *   [1] 脚本可加载且暴露 window.MTNodeMcp（handleFrame / resolveWf / note）
 *   [2] get → handleCanvasEvent（带 op/params/sessionId/runKey/canvasTarget/settle）
 *   [3] 多画布：canvas 参数解析成画布对象并进 runCtx.canvasTarget；名字有歧义给明确错误
 *   [4] 回执：settle 出来的 result/error 原样走 mcpInteract
 *   [5] 授权开关：调用期间 S._mcpAuthorized 为真，结束后复原（绝不常驻）
 *   [6] 版本闸：edit + 过期 baseHash → 不落到 handleCanvasEvent，直接回错误
 *   [7] 数据库 / 事实库 / 素材 / 长任务 四个 op 各自落到对应的既有处理函数
 *   [8] 只读资源：canvasList 走 wfList；skillList / skillBody 走技能 IPC 且形状正确
 *   [9] 未知 op 给明确错误（不静默）
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const rel = (...p) => path.join(ROOT, ...p);

if (!process.versions.electron) {
  const { spawn } = require("child_process");
  const bin = require("electron");
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(String(bin), [__filename], { stdio: "inherit", env });
  child.on("exit", (c, s) => process.exit(s ? 1 : c == null ? 1 : c));
} else {
  main().catch((e) => {
    console.error("[smoke-mcp-bridge] 失败：", (e && e.stack) || e);
    try {
      require("electron").app.exit(1);
    } catch (_) {}
  });
}

let fails = 0;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
}

const PROBE = `(async function () {
  const out = {};
  const calls = { canvas: [], db: [], facts: [], asset: [], lt: [], interact: [], settled: [] };
  window.__calls = calls;

  /* ── 宿主桩（与真实全局同名同形，只记调用）── */
  const WF_A = { id: 'wf-a', name: '示例画布' };
  const WF_B = { id: 'wf-b', name: '另一张画布' };
  window.S = { wf: WF_A, wfs: [WF_A, WF_B], _mcpAuthorized: false };
  window.currentVisibleWf = function () { return WF_A; };
  window.canvasTargetWf = function () { return WF_A; };
  window.runAgainstWf = function (wf, fn) { return Promise.resolve(fn()); };
  window.canvasSnapshotFull = function (opts, scopeOpts) {
    return Promise.resolve({ ok: true, workflow: { id: (scopeOpts && scopeOpts.wf && scopeOpts.wf.id) || 'wf-a' }, contentHash: 'HASH-NOW' });
  };
  window.handleCanvasEvent = function (frame, ctx) {
    calls.canvas.push({ frame: frame, ctx: ctx, authDuring: window.S._mcpAuthorized });
    ctx.mcpFrameSettle({ ok: true, echo: frame.op, canvas: ctx.canvasTarget ? ctx.canvasTarget.id : '' }, undefined);
    return Promise.resolve();
  };
  window.handleDbToolEvent = function (frame, node, wf) {
    calls.db.push({ frame: frame, wf: wf && wf.id });
    window.api.mcpInteract({ id: frame.id, result: { ok: true, db: true } });
    return Promise.resolve();
  };
  window.handleAiFactsToolEvent = function (frame, wf) {
    calls.facts.push({ frame: frame, wf: wf && wf.id });
    window.api.mcpInteract({ id: frame.id, result: { ok: true, facts: true } });
    return Promise.resolve();
  };
  window.handleAssetToolEvent = function (frame, runKey) {
    calls.asset.push({ frame: frame, runKey: runKey });
    window.api.mcpInteract({ id: frame.id, result: { ok: true, asset: true } });
    return Promise.resolve();
  };
  window.LT = { stateRead: function () { return { pool_ok: true }; } };

  window.wfListStub = [WF_A, WF_B];
  window.api = {
    mcpOnEvent: function (cb) { window.__onFrame = cb; return function () {}; },
    mcpInteract: function (p) { calls.interact.push(p); return Promise.resolve({ ok: true }); },
    wfList: function () { return Promise.resolve(window.wfListStub); },
    mtnodeAgentSkillIndex: function () {
      return Promise.resolve({ ok: true, libraryPath: '/lib', index: { mtnode: { skills: [ { name: 'mtnode-canvas-edit-rules', title: '画布编辑硬规则', description: 'd', path: 'mtnode/canvas-edit-rules/SKILL.md' } ] } } });
    },
    mtnodeAgentSkillGet: function (name) {
      return name === 'mtnode-canvas-edit-rules' ? Promise.resolve({ ok: true, body: '# 画布编辑硬规则\\n正文' }) : Promise.resolve({ ok: false, error: '技能不存在' });
    },
  };

  __BRIDGE__

  out.exposed = !!window.MTNodeMcp && typeof window.MTNodeMcp.handleFrame === 'function' && typeof window.MTNodeMcp.resolveWf === 'function';
  out.subscribed = typeof window.__onFrame === 'function';

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const pick = (id) => calls.interact.filter((x) => x.id === id)[0] || {};
  /* 轮询等待某条回执出现：回执是异步（runAgainstWf / await）来的，固定 sleep 会假红 */
  const waitFor = async (id, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 1500)) {
      if (calls.interact.some((x) => x.id === id)) return true;
      await wait(15);
    }
    return false;
  };

  /* [2][4][5] 普通读：get */
  window.S._mcpAuthorized = false;
  await window.__onFrame({ id: 'f1', sessionId: 's1', clientId: 'c1', op: 'get', params: { detail: 'minimal' }, write: false });
  await wait(30);
  await waitFor('f1');
  const c1 = calls.canvas[0] || {};
  out.getOp = c1.frame && c1.frame.op;
  out.getDetail = c1.frame && c1.frame.params && c1.frame.params.detail;
  out.getSession = c1.ctx && c1.ctx.sessionId;
  out.getRunKey = c1.ctx && c1.ctx.runKey;
  out.getHasSettle = !!(c1.ctx && typeof c1.ctx.mcpFrameSettle === 'function');
  out.getCanvasTarget = c1.ctx && c1.ctx.canvasTarget ? c1.ctx.canvasTarget.id : null;
  out.authDuring = c1.authDuring;
  out.authAfter = window.S._mcpAuthorized;
  out.settleReply = calls.interact[0] || null;

  /* [3] 多画布：点名 wf-b */
  await window.__onFrame({ id: 'f2', sessionId: 's1', op: 'get', params: { canvas: 'wf-b', detail: 'minimal' }, write: false });
  await wait(30);
  await waitFor('f2');
  const c2 = calls.canvas[1] || {};
  out.target2 = c2.ctx && c2.ctx.canvasTarget ? c2.ctx.canvasTarget.id : null;
  out.canvasParamStripped = c2.frame && c2.frame.params && !('canvas' in c2.frame.params);

  /* [3b] 名字有歧义 → 明确错误 */
  window.wfListStub = [WF_A, WF_B, { id: 'wf-c', name: '示例画布二' }];
  window.S.wfs = window.wfListStub;
  await window.__onFrame({ id: 'f3', sessionId: 's1', op: 'get', params: { canvas: '示例' }, write: false });
  await wait(30);
  await waitFor('f3');
  const r3 = calls.interact.filter((x) => x.id === 'f3')[0] || {};
  out.ambiguousError = String(r3.error || '');

  /* [6] 版本闸：edit + 过期 baseHash */
  const before = calls.canvas.length;
  await window.__onFrame({ id: 'f4', sessionId: 's1', op: 'edit', params: { canvas: 'wf-a', baseHash: 'STALE', create: [] }, write: true });
  await wait(60);
  await waitFor('f4');
  const r4 = calls.interact.filter((x) => x.id === 'f4')[0] || {};
  out.staleError = String(r4.error || '');
  out.staleSkippedHost = calls.canvas.length === before;

  /* [6b] 版本一致 → 真的落到宿主 */
  await window.__onFrame({ id: 'f5', sessionId: 's1', op: 'edit', params: { canvas: 'wf-a', baseHash: 'HASH-NOW', create: [] }, write: true });
  await wait(60);
  out.editOk = !!(calls.interact.filter((x) => x.id === 'f5')[0]);

  /* [7] 另外四族 */
  await window.__onFrame({ id: 'f6', sessionId: 's1', op: 'db', params: { action: 'list', canvas: 'wf-b' }, write: false });
  await window.__onFrame({ id: 'f7', sessionId: 's1', op: 'facts', params: { action: 'list' }, write: false });
  await window.__onFrame({ id: 'f8', sessionId: 's1', op: 'asset', params: { action: 'list' }, write: false });
  await window.__onFrame({ id: 'f9', sessionId: 's1', op: 'lt', params: {}, write: false });
  await waitFor('f6');
  await waitFor('f7');
  await waitFor('f8');
  await waitFor('f9');
  out.dbHit = calls.db.length === 1 && calls.db[0].wf === 'wf-b';
  out.factsHit = calls.facts.length === 1;
  out.assetHit = calls.asset.length === 1;
  const r9 = calls.interact.filter((x) => x.id === 'f9')[0] || {};
  out.ltNote = !!(r9.result && r9.result.note);

  /* [8] 只读资源 */
  await window.__onFrame({ id: 'f10', sessionId: 's1', op: 'canvasList', params: {}, write: false });
  await window.__onFrame({ id: 'f11', sessionId: 's1', op: 'skillList', params: {}, write: false });
  await window.__onFrame({ id: 'f12', sessionId: 's1', op: 'skillBody', params: { name: 'mtnode-canvas-edit-rules' }, write: false });
  await window.__onFrame({ id: 'f13', sessionId: 's1', op: 'skillBody', params: { name: 'nope' }, write: false });
  await waitFor('f10');
  await waitFor('f11');
  await waitFor('f12');
  await waitFor('f13');
  const r10 = pick('f10');
  out.canvasList = Array.isArray(r10.result) ? r10.result.length : -1;
  out.canvasListActive = Array.isArray(r10.result) && r10.result[0].active === true;
  const r11 = pick('f11');
  out.skillListName = r11.result && r11.result.skills && r11.result.skills[0] && r11.result.skills[0].name;
  const r12 = pick('f12');
  out.skillBody = r12.result;
  const r13 = pick('f13');
  out.skillMissingError = String(r13.error || '');

  /* [9] 未知 op */
  await window.__onFrame({ id: 'f14', sessionId: 's1', op: 'nope', params: {}, write: false });
  await waitFor('f14');
  out.unknownError = String((pick('f14').error) || '');

  return out;
})()`;

function runProbe() {
  const { BrowserWindow } = require("electron");
  return (async () => {
    let html = fs.readFileSync(rel("renderer", "index.html"), "utf8");
    html = html.replace(/<script[^>]*src="[^"]+"[^>]*><\/script>/g, "");
    const tmp = path.join(os.tmpdir(), "mtnode-mcp-bridge-probe.html");
    fs.writeFileSync(tmp, html, "utf8");
    const win = new BrowserWindow({
      show: false,
      width: 1200,
      height: 800,
      webPreferences: { offscreen: true, contextIsolation: false, nodeIntegration: false },
    });
    await win.loadFile(tmp);
    const bridge = fs.readFileSync(rel("renderer", "mcp-bridge.js"), "utf8");
    const code = PROBE.replace("__BRIDGE__", () => bridge);
    const out = await win.webContents.executeJavaScript(code, true);
    try {
      fs.unlinkSync(tmp);
    } catch (_) {}
    return out;
  })();
}

async function main() {
  const { app } = require("electron");
  await app.whenReady();

  console.log("\n[1]-[9] 真跑：把 renderer/mcp-bridge.js 原文注入真实渲染引擎，喂真帧看回执");
  const r = await runProbe();

  ok(r.exposed, "window.MTNodeMcp 暴露 handleFrame / resolveWf");
  ok(r.subscribed, "启动即订阅主进程 mcp:event 帧");

  ok(r.getOp === "get" && r.getDetail === "minimal", "get 帧原样交给 handleCanvasEvent");
  ok(r.getSession === "s1" && /^mcp:s1:/.test(String(r.getRunKey)), "runKey 带 mcp: 命名空间与会话章");
  ok(r.getHasSettle === true, "回执通道（mcpFrameSettle）随 runCtx 交给宿主");
  ok(r.getCanvasTarget === null, "不点名画布时不强塞 canvasTarget（沿用既有口径）");
  ok(r.authDuring === true, "调用期间 S._mcpAuthorized = true");
  ok(r.authAfter === false, "调用结束立刻复原（授权不常驻）");
  ok(r.settleReply && r.settleReply.id === "f1" && r.settleReply.result && r.settleReply.result.echo === "get", "宿主回执经 mcpInteract 原样送回主进程");

  ok(r.target2 === "wf-b", "canvas 参数解析成目标画布并进 runCtx.canvasTarget");
  ok(r.canvasParamStripped === true, "canvas 是 MCP 侧路由参数，不下发插件处理函数");
  ok(/歧义/.test(r.ambiguousError), "画布名有歧义给明确错误（实得 " + JSON.stringify(r.ambiguousError).slice(0, 60) + "）");

  ok(/版本不一致/.test(r.staleError), "过期 baseHash 被拒（实得 " + JSON.stringify(r.staleError).slice(0, 60) + "）");
  ok(r.staleSkippedHost === true, "被拒的写根本不落到宿主（不做半截修改）");
  ok(r.editOk === true, "哈希一致时写正常落到宿主");

  ok(r.dbHit === true, "db 落到 handleDbToolEvent 且按目标画布解析");
  ok(r.factsHit === true, "facts 落到 handleAiFactsToolEvent");
  ok(r.assetHit === true, "asset 落到 handleAssetToolEvent");
  ok(r.ltNote === true, "lt 返回能力边界说明（不假装能推进长任务）");

  ok(r.canvasList === 3 && r.canvasListActive === true, "canvasList 走 wfList 并标出当前画布");
  ok(r.skillListName === "mtnode-canvas-edit-rules", "skillList 走内置技能索引");
  ok(typeof r.skillBody === "string" && r.skillBody.indexOf("画布编辑硬规则") >= 0, "skillBody 回技能正文原文");
  ok(/技能不存在/.test(r.skillMissingError), "技能名不存在给明确错误");

  ok(/未知的 MCP 操作/.test(r.unknownError), "未知 op 给明确错误（不静默成功）");

  console.log("");
  console.log(fails ? "✗ " + fails + " / " + checks + " 项未通过" : "✓ 全部 " + checks + " 项通过");
  app.exit(fails ? 1 : 0);
}
