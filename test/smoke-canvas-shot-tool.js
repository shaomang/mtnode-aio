/* test/smoke-canvas-shot-tool.js — 画布拍照（生成高清总览图）作为工具交给智能体调用
 * ============================================================================
 * 运行：node test/smoke-canvas-shot-tool.js
 *
 * 需求：把页脚相机按钮的「画布拍照」也做成工具，允许 mtnode 调用 ——
 * 拍下整张画布（节点 + 连线 + 标注）成一张 PNG 并落盘，路径交给模型（可再喂给识图）。
 *
 * 分档（本轮取舍）：**不加新工具**，而是给已有的 mtnode_app 加一只 action
 * `export_canvas_png`。理由：mtnode_app 的动作 enum 只是几个字符串，加一只动作
 * 的固定前缀开销 ≈150 字符；新注册一只工具则要额外进 tool-visibility 的可裁名单、
 * 每轮重发一份完整 schema，并让 test/smoke-token-budget.js 的工具集断言全部重算。
 *
 * 本测试只读断言（不改任何文件）：
 *   [1] 工具面：enum / APP_DESC / path 参数齐备，且**没有**多出第五只工具
 *   [2] 宿主分发：许可两道闸、前台口径、落盘两条路、PNG 路径校验
 *   [3] 拍照链路：按钮路径一字未变、工具路径不弹保存框且失败原样抛出
 *   [4] 基座助手 / i18n：safeApp 与系统提示词列出该动作；新文案中英齐备
 *   [5] base64 互转函数可用（真跑一遍字节往返）
 * ============================================================================
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const PLUGIN = read("dsh", "gateway", "canvas-plugin.mjs");
const NODES = read("renderer", "app-nodes.js");
const APP = read("renderer", "app.js");
const ASSIST = read("renderer", "app-assist.js");
const I18N = read("renderer", "i18n.js");

let fails = 0;
let checks = 0;
const ok = (cond, msg) => {
  checks++;
  if (cond) console.log("  ok  " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
};
const has = (src, needle, msg) => ok(src.indexOf(needle) >= 0, msg);
const count = (src, needle) => src.split(needle).length - 1;

/* 取顶格函数体（到下一个顶格 "}" 为止） */
const fnOf = (src, name) => {
  const at = src.indexOf("function " + name + "(");
  if (at < 0) return "";
  const end = src.indexOf("\n}", at);
  return end > at ? src.slice(at, end + 2) : "";
};

console.log("\n[1] 工具面：mtnode_app 的 export_canvas_png（不加新工具）");
{
  has(PLUGIN, "'export_canvas_png',", "mtnode_app 的 action enum 收了 export_canvas_png");
  const appDesc = PLUGIN.slice(
    PLUGIN.indexOf("const APP_DESC"),
    PLUGIN.indexOf("/* 工具描述只留「卡口」"),
  );
  has(appDesc, "export_canvas_png: take a high-resolution PNG", "APP_DESC 有这只动作的条目");
  has(appDesc, "footer camera button", "APP_DESC 说清它就是页脚相机按钮那条链路");
  has(appDesc, "mtnode_vision", "APP_DESC 指路：要真的看懂图就交给 mtnode_vision");
  has(appDesc, "in the background", "APP_DESC 说清前台口径（不在前台会被拒）");
  has(PLUGIN, "For export_canvas_png: absolute .png output path", "path 参数写明是绝对 .png 路径");
  const toolCount = count(PLUGIN, "    name: 'mtnode_");
  ok(toolCount === 4, "canvas-plugin 仍只注册 4 只工具（实测 " + toolCount + "），没为拍照多开一只");
  const visibility = read("dsh", "gateway", "tool-visibility.mjs");
  ok(visibility.indexOf("export_canvas_png") < 0, "可裁名单无需追加（没有新工具名）");
}

console.log("\n[2] 宿主分发：许可两道闸 + 前台口径 + 落盘两条路");
{
  const gate = NODES.slice(
    NODES.indexOf('} else if (action === "export_canvas_png") {'),
    NODES.indexOf('} else if (action === "export_canvas_png") {') + 400,
  );
  has(gate, 'ensureAgentTool("app_ops"', "走「应用操作」许可（app_ops）");
  has(gate, 'ensureAgentTool("canvas_read"', "走「读画布」许可（canvas_read）");
  has(
    NODES,
    "return await captureCanvasForAgent(params, boundWf);",
    "action 分派到 captureCanvasForAgent",
  );
  has(
    NODES,
    "画布拍照是截屏：只能拍屏幕上正显示的那张画布。",
    "前台口径：所属画布不在前台时明确拒绝（截屏拍不到后台画布）",
  );
  const fgAt = NODES.indexOf("if (action === \"export_canvas_png\") {");
  const fgGuard = NODES.indexOf("String(boundWf.id) !== String(fg.id)", fgAt);
  ok(fgAt >= 0 && fgGuard > fgAt, "前台判定与 select_nodes / undo / redo 同一口径（currentVisibleWf）");

  const fn = fnOf(NODES, "captureCanvasForAgent");
  ok(fn.length > 0, "找得到 captureCanvasForAgent");
  has(fn, "exportCanvasOverviewPng({ fromAgent: true })", "复用页脚相机那条链路（同一套瓦片拼接 / 相机复位）");
  has(fn, "const restore = revealCanvasForShot();", "会话 / 团队视图下先把画布显示出来再拍");
  has(fn, "restore();", "拍完原样收回视图");
  ok(
    /finally\s*\{[\s\S]{0,300}?restore\(\);/.test(fn),
    "finally 里兜底收回视图（拍失败也不会把界面停在画布上）",
  );
  has(fn, "assetWriteBase64(", "默认落本画布资产目录（%APPDATA% 侧，不落应用文件夹）");
  has(fn, 'storedIn = "asset"', "回执说明落到了资产目录");
  has(fn, "fileWriteBytes(dest, base64ToBytes(shot.base64))", "给了 path 就写那个绝对路径（字节写入）");
  has(fn, "isAbsPath(outPath)", "path 必须是本机绝对路径");
  has(fn, "/\\.png$/i.test(outPath)", "只接受 .png 后缀");
  has(fn, "path: dest", "回执交出落盘路径（交给识图 / 用户）");
  has(fn, "mtnode_vision", "回执指路识图");
  ok(
    /if \(\/empty\/i\.test\(msg\)\)/.test(fn),
    "窗口最小化 / 不可见导致 capturePage 回 empty 时，给一句用户能照做的提示",
  );

  const denied = NODES.slice(
    NODES.indexOf("const PLAN_DENIED_APP_ACTIONS"),
    NODES.indexOf("function canvasOpMutates("),
  );
  ok(denied.indexOf("export_canvas_png") < 0, "规划模式下不拦（只读动作，不改画布内容）");
}

console.log("\n[3] 拍照链路：按钮路径一字未变、工具路径不弹保存框");
{
  const fn = fnOf(APP, "exportCanvasOverviewPng");
  ok(fn.length > 0, "找得到 exportCanvasOverviewPng");
  has(fn, "const fromAgent = !!o.fromAgent;", "用 opts.fromAgent 区分两条路径");
  ok(
    /if \(!fromAgent && S\.view === "agent"\)/.test(fn),
    "「请先切换到画布」的提示只留给按钮路径（工具路径自己会临时显示画布）",
  );
  ok(
    /if \(fromAgent\) throw new Error\(I18n\.t\("当前没有打开的画布"\)\)/.test(fn),
    "工具路径没有画布 / 没有内容时抛错（变成模型能读的失败回执），不弹 toast",
  );
  ok(
    /if \(S\._capturingCanvas\)[\s\S]{0,200}?fromAgent\) throw new Error/.test(fn),
    "重入保护：已在拍时工具路径明确失败（截图期间相机被瓦片循环反复指定）",
  );
  const retAt = fn.indexOf("if (fromAgent) {");
  const saveAt = fn.indexOf("const dest = await window.api.fileSaveDialog(");
  ok(retAt >= 0 && saveAt > retAt, "工具路径在保存框之前就返回（不弹保存框、不打开所在目录）");
  has(fn, "if (fromAgent) throw e;", "工具路径的失败原样抛出，不乱弹 toast");
  has(fn, "base64: bytesToBase64(new Uint8Array(shotBuf))", "以 base64 交回调用方落盘");
  /* 按钮路径的确认框仍在 */
  has(fn, "const ok = await confirmDialog(", "按钮路径仍先弹确认框");
  ok(
    /if \(!fromAgent\) \{\s*const ok = await confirmDialog\(/.test(fn),
    "确认框只在按钮路径（工具调用本身就是用户意图，不用模态框卡住一轮运行）",
  );

  const reveal = fnOf(APP, "revealCanvasForShot");
  ok(reveal.length > 0, "找得到 revealCanvasForShot");
  has(reveal, '$("#wfWrap")', "临时显示 #wfWrap");
  has(reveal, '$("#agentPane"), $("#teamPane")', "同时收掉会话 / 团队面板");
  has(reveal, "wrap.style.display = saved.wrap", "收回原样（按拍之前的 display 还原）");
  ok(reveal.indexOf("S.view =") < 0, "不动 S.view（只是临时显示，不切视图）");
}

console.log("\n[4] safeApp / 系统提示词 / i18n");
{
  has(ASSIST, "undo|redo|export_canvas_png", "app_state 的 safe 清单列出该动作（不触发确认框）");
  ok(
    count(ASSIST, "export_canvas_png") >= 3,
    "safeApp + 限定范围 / 全局两段系统提示词都列了它（实测 " +
      count(ASSIST, "export_canvas_png") +
      " 处）",
  );
  const keys = [
    "正在生成总览图，请稍后重试。",
    "当前环境不支持画布拍照",
    "生成总览图失败：主进程没取到画面（MTNode 窗口最小化或不可见）。请先把窗口显示出来再拍。",
    "画布拍照是截屏：只能拍屏幕上正显示的那张画布。本会话所属画布当前不在前台，请先切换到它再拍。",
    "path 必须是本机绝对路径：",
    "画布总览图只能保存为 .png：",
    "已拍下整张画布（节点 + 连线 + 标注）。要真的看懂图里内容，把 path 交给 mtnode_vision 识图；拍图期间画面会短暂移动，已自动恢复。",
  ];
  for (const k of keys) ok(I18N.indexOf('"' + k + '"') >= 0, "i18n 有词条：「" + k.slice(0, 16) + "…」");
  /* 词条后面必须跟着英文译文（下一行不是中文键再起一行） */
  for (const k of keys) {
    const at = I18N.indexOf('"' + k + '"');
    const seg = I18N.slice(at, at + k.length + 400);
    ok(/:\s*\n?\s*"/.test(seg.slice(k.length + 2)), "词条有英文译文：「" + k.slice(0, 16) + "…」");
  }
  ok(I18N.indexOf('"生成总览图失败："') >= 0, "复用既有「生成总览图失败：」词条（工具路径也报同一句）");
}

console.log("\n[5] base64 互转：真跑一遍字节往返");
{
  const src = fnOf(APP, "bytesToBase64") + "\n" + fnOf(APP, "base64ToBytes");
  ok(src.length > 0, "找得到两个转换函数");
  /* eslint-disable no-new-func */
  const fns = new Function(src + "\nreturn { bytesToBase64, base64ToBytes };")();
  const bytes = new Uint8Array(70000); /* 跨过 0x8000 分块边界，复现曾经的爆栈场景 */
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37) & 0xff;
  const b64 = fns.bytesToBase64(bytes);
  ok(b64.length === Math.ceil(bytes.length / 3) * 4, "base64 长度符合 4 的倍数口径（" + b64.length + "）");
  const back = fns.base64ToBytes(b64);
  let same = back.length === bytes.length;
  for (let i = 0; same && i < bytes.length; i++) if (back[i] !== bytes[i]) same = false;
  ok(same, "70,000 字节往返无损（分块不爆栈、字节不错位）");
  ok(fns.base64ToBytes("").length === 0, "空串安全");
}

console.log(
  fails
    ? "\n✗ " + fails + " / " + checks + " 项失败  (smoke-canvas-shot-tool)\n"
    : "\n✓ 全部 " + checks + " 项通过  (smoke-canvas-shot-tool)\n",
);
process.exit(fails ? 1 : 0);