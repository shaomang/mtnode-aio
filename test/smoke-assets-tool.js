/* test/smoke-assets-tool.js — 智能体的「素材库 / 窗口截图」工具（mtnode_assets）
 * ============================================================================
 * 运行：node test/smoke-assets-tool.js
 *
 * 背景（本模块契约的来源）：为「版本 1.4.0 - 动画」画布中的 交付 · 素材交付 准备素材 ——
 * Agent 要能从素材库里取人物三视图（拿到本机绝对路径交给识图 / 交付端子），并能把
 * MTNode 窗口当下拍成全屏静帧 PNG（交付清单里的界面类 1920x1080 截图）。
 *
 * 分档：**新开一只工具** mtnode_assets（list / read / screenshot）。为什么不并进
 * mtnode_app：素材库与截图都不是「画布 / 应用」范畴，且它们必须能被单独关掉
 * （一个许可项 = 一个工具）；canvas-plugin 的 4 只工具数断言也因此不受影响。
 *
 * 只读断言（不改任何文件）：
 *   [1] 插件面：assets-plugin.mjs 存在、只注册一只工具、三动作 + 全部参数
 *   [2] 协议与网关：帧 t:'asset' → asset-result / abort；gateway 放行 + 回写
 *   [3] 挂载：cordis.yml 有 mtnode-assets 行（且随 CHAT_ISOLATE / PURE 关闭）
 *   [4] 宿主实现：app-assets.js 读库 / 读条目 / 拍图落盘；app-db.js 事件分发
 *   [5] 许可与裁剪：assets_read 一档、拒 = 整只不注册、团队面板默认拒绝
 *   [6] i18n：新文案中英齐备（真跑 I18n 模块核对译文）
 *   [7] 定位逻辑真跑：assetAgentFindItem 按 id / rel / path 三种方式取条目
 * ============================================================================
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const PLUGIN = read("dsh", "gateway", "assets-plugin.mjs");
const GATEWAY = read("dsh", "gateway", "gateway.mjs");
const CORDIS = read("dsh", "gateway", "cordis.yml");
const VIS = read("dsh", "gateway", "tool-visibility.mjs");
const ASSETS = read("renderer", "app-assets.js");
const DB = read("renderer", "app-db.js");
const NODES = read("renderer", "app-nodes.js");
const TEAM = read("renderer", "app-team.js");
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

/* 取顶格函数体（到下一个顶格 "}" 为止），与 smoke-canvas-shot-tool.js 同一口径 */
const fnOf = (src, name) => {
  const at = src.indexOf("function " + name + "(");
  if (at < 0) return "";
  const end = src.indexOf("\n}", at);
  return end > at ? src.slice(at, end + 2) : "";
};

console.log("\n[1] 插件面：一只工具、三个动作、参数齐备");
{
  ok(PLUGIN.length > 0, "dsh/gateway/assets-plugin.mjs 存在");
  has(PLUGIN, "name: 'mtnode_assets',", "注册的工具名 = mtnode_assets");
  has(PLUGIN, "enum: ['list', 'read', 'screenshot'],", "三个动作：list / read / screenshot");
  const toolCount = count(PLUGIN, "ctx.tools.register(");
  ok(toolCount === 1, "整只插件只注册 1 只工具（实测 " + toolCount + "）");
  for (const p of [
    "filter:",
    "type:",
    "limit:",
    "id:",
    "rel:",
    "path:",
    "itemId:",
    "index:",
    "asText:",
    "canvasOnly:",
    "width:",
    "height:",
    "maximize:",
    "hideUI:",
  ]) {
    has(PLUGIN, "\n      " + p, "参数表收下 " + p.replace(":", ""));
  }
  has(PLUGIN, "timeoutMs: 60000", "截图 + 读大图留足超时（60s）");
  has(PLUGIN, "三视图", "工具描述点名「人物三视图」这类素材（模型一眼知道该往哪找）");
  has(PLUGIN, "mtnode_vision", "工具描述指路识图（拿 path 交给 mtnode_vision 真看图）");
  has(
    PLUGIN,
    "never guess that a file exists",
    "卡口：文件是否存在只能靠 read 回执，不许猜",
  );
  has(PLUGIN, "it never writes into it", "卡口：素材库只读，绝不写回用户的目录");
  has(
    PLUGIN,
    "ask the user to show the MTNode window",
    "截图失败（窗口最小化）时给模型一句可照做的下一步",
  );
  ok(
    PLUGIN.indexOf("isToolHidden('mtnode_assets')") > 0,
    "注册口先过隐藏名单（被拒的轮整只不注册）",
  );
  has(VIS, "'mtnode_assets',", "可裁名单（HIDEABLE_TOOLS）收了 mtnode_assets");
}

console.log("\n[2] 协议与网关：asset 帧 → asset-result");
{
  has(
    PLUGIN,
    "send({ t: 'asset', id, sessionId, action, params: params || {} })",
    "上行帧：t:'asset' + 发起轮 sessionId 盖章（与 canvas / db 同一契约）",
  );
  has(PLUGIN, "if (m.t === 'asset-result')", "下行帧：asset-result 解析");
  has(PLUGIN, "} else if (m.t === 'abort') {", "放弃的帧按 abort 收场");
  has(
    PLUGIN,
    "send({ t: 'drop', id, sessionId })",
    "工具被中止时发 drop，别让宿主留一张死框",
  );
  has(
    PLUGIN,
    "exec.agent ? String(exec.agent.id || '') : ''",
    "sessionId 取不到就发空串 → 网关 fail closed",
  );
  has(
    GATEWAY,
    "m.t !== 'lt' && m.t !== 'asset') return",
    "网关放行 asset 帧（与 canvas / db / tool / lt 同一张白名单）",
  );
  has(
    GATEWAY,
    "data.tool = m.tool && typeof m.tool === 'object' ? m.tool : {}",
    "tool 帧仍走自己的分支（没被 asset 挤掉）",
  );
  ok(
    GATEWAY.indexOf("} else if (p.kind === 'asset') {") <
      GATEWAY.indexOf("} else if (p.kind === 'tool') {"),
    "asset 分支插在 tool 分支之前（tool 的回执仍是 tool-result）",
  );
  has(
    GATEWAY,
    "} else if (p.kind === 'asset') {",
    "interact 回写分支：kind:'asset' → asset-result",
  );
  has(
    GATEWAY,
    "t: 'asset-result',",
    "回写的帧名就是插件在等的那一个",
  );
  /* 两处新分支都必须带 ok/error，否则运行时侧拿不到失败原因 */
  const assetWrite = GATEWAY.slice(
    GATEWAY.indexOf("} else if (p.kind === 'asset') {"),
    GATEWAY.indexOf("} else if (p.kind === 'tool') {"),
  );
  has(assetWrite, "ok: !err", "回执带 ok 判据（宿主失败时工具以失败收场）");
  has(assetWrite, "error: err", "回执带错误文本（会话不中断）");
}

console.log("\n[3] 挂载：cordis.yml");
{
  const at = CORDIS.indexOf("- id: mtnode-assets");
  ok(at > 0, "cordis.yml 有 mtnode-assets 行");
  const seg = CORDIS.slice(at, at + 400);
  has(seg, "name: './assets-plugin.mjs'", "行名指向 ./assets-plugin.mjs");
  has(
    seg,
    "disabled: !!js process.env.MTNODE_CHAT_ISOLATE === '1' || process.env.MTNODE_PURE === '1'",
    "与画布 / 数据库 / 工具插件同一道档（BongoChat 隔离轮与 pure 轮不挂）",
  );
  has(
    CORDIS,
    "canvas-plugin / db-plugin / assets-plugin 的注册口",
    "裁剪名单的注释也认了这只插件（真源指路不落空）",
  );
}

console.log("\n[4] 宿主实现：读库 / 读条目 / 拍图落盘 + 事件分发");
{
  ok(typeof fnOf(ASSETS, "handleAssetEvent") === "string" && fnOf(ASSETS, "handleAssetEvent").length > 0,
    "app-assets.js 有 handleAssetEvent（唯一入口）");
  has(ASSETS, "window.__mtnodeAssetOp = handleAssetEvent;", "入口挂到 window 供 app-db.js 调");
  const list = fnOf(ASSETS, "assetAgentList");
  has(list, "await assetAgentRoot()", "list 先取库根（未指定要报引导语，不是空列表）");
  has(list, "assetAgentScan()", "list 走既有 assetsScan 重扫（库是用户自己的目录，随时会变）");
  has(list, "assets: list.slice(0, limit).map(assetAgentAssetBrief)", "list 只回素材摘要");
  ok(
    list.indexOf("tree:") < 0 && list.indexOf("categories: assetAgentCatNames") > 0,
    "分类只回平铺名字清单，整套 tree 不进模型上下文",
  );
  const read = fnOf(ASSETS, "assetAgentRead");
  has(read, "assetsItemRead(assetId", "read 用 assets:itemRead 拿绝对路径与正文（不自己拼路径）");
  has(read, "asText", "read 支持跳过正文（只要路径时不烧 token）");
  const find = fnOf(ASSETS, "assetAgentFindItem");
  has(find, "a.rel) === norm(rel)", "定位：按库内相对路径精确定位");
  has(find, "endsWith(\"/\" + norm(rel))", "定位：相对路径可只给尾段");
  has(find, "it.absPath) === pth", "定位：绝对文件路径反查所属素材");
  has(find, "I18n.t(\"素材库里没有这个素材：\")", "找不到素材时报明确错误，不糊一个空结果");
  const shot = fnOf(ASSETS, "assetAgentShot");
  has(shot, "captureRect(rect)", "截图走主进程 capturePage（与画布拍照同一条链路）");
  has(shot, "width: window.innerWidth, height: window.innerHeight", "默认整窗口径");
  has(shot, "canvasOnly === true", "可切画布视口口径");
  has(shot, "assetAgentShotHide()", "拍前收掉瞬时浮层（交付静帧不留残影）");
  has(shot, "fileWriteBytes(dest, buf)", "给了 path 就写那个绝对路径（交付目录在工作区之外，只有宿主能写）");
  has(shot, "assetWriteBase64(", "没给 path 时落本画布资产目录（默认不落应用文件夹）");
  has(shot, "/\\.(png|jpg|jpeg|webp)$/i.test(outPath)", "输出后缀卡在图片格式内");
  has(shot, "base64ToBytes(cv.toDataURL(\"image/png\").split(\",\")[1])", "width/height 指定时按像素缩放输出");
  ok(
    /finally\s*\{[\s\S]{0,120}?restoreUI\(\);/.test(shot),
    "finally 里兜底恢复被隐藏的 UI（拍失败也不把界面留在「收起来」的样子）",
  );
  has(
    shot,
    "请先把窗口显示出来再拍。",
    "窗口最小化导致 capturePage 回 empty 时给一句用户能照做的提示",
  );
  has(
    shot,
    "p.maximize === true && window.api.winMaximize",
    "maximize 是显式选项（默认不动用户的窗口）",
  );
  ok(ASSETS.indexOf("assetAgentReadItem") < 0, "没有留下没人调用的半截辅助函数");

  has(DB, 'if (msg.type === "asset") {', "app-db.js 收 asset 事件");
  has(DB, "handleAssetToolEvent(msg.data || {}, runKey);", "事件分发给宿主实现");
  const ev = fnOf(DB, "handleAssetToolEvent");
  has(ev, 'kind: "asset", id, result', "结果经 dshInteract kind:'asset' 回写网关");
  has(ev, "agentToolMode(key, runKey)", "许可按本轮 runKey 判（专家自带策略也生效）");
  has(ev, "agentToolDeniedError(key", "被拒时回错误文本（ok:false，会话不中断）");
  has(ev, "window.__mtnodeAssetOp", "实现体缺席时报「界面未就绪」，不静默吞掉");
}

console.log("\n[5] 许可与排序：assets_read 一档，拒 = 整只不注册");
{
  has(NODES, 'key: "assets_read",', "许可目录新增 assets_read 一项");
  has(NODES, 'id: "assets",', "许可面板新增「素材库与截图」一档");
  has(NODES, 'function assetsToolKeyOf()', "动作→许可键的唯一映射点存在");
  const denied = fnOf(NODES, "agentDeniedToolNames");
  has(denied, 'if (has("assets_read")) out.push("mtnode_assets");', "拒 assets_read → 隐藏 mtnode_assets");
  /* 裁剪名单一致性：agentDeniedToolNames 只准产出白名单内的名字（与 smoke-token-budget 同口径） */
  const TV = require(path.join(ROOT, "dsh", "gateway", "tool-visibility.mjs"));
  ok(
    TV.HIDEABLE_TOOLS.indexOf("mtnode_assets") > 0,
    "mtnode_assets 在可裁名单内（否则网关会把整条名单当垃圾丢掉）",
  );
  ok(
    TV.normalizeHiddenTools("mtnode_assets, mtnode_assets ,bogus").join(",") === "mtnode_assets",
    "归一化：去重 + 丢非法名 + 字典序（同档每轮逐字相同，提示缓存不碎）",
  );
  has(TEAM, 'key: "assets_read"', "团队专家面板也列出这一档（与 agentToolCatalog 对齐）");
  ok(
    /assets_read:\s*"deny",/.test(TEAM),
    "专家默认许可：素材库 / 截图默认拒绝（与专家角色无关的能力不默认开）",
  );
}

console.log("\n[6] i18n：新文案中英齐备");
{
  const keys = [
    "素材库里没有匹配的素材",
    "素材库里没有这个素材：",
    "该素材里没有匹配的内容条目",
    "没有取到内容条目",
    "素材库还没有指定保存位置（顶栏「素材库」→ 指定根目录）",
    "当前环境不支持窗口截图",
    "截图只能保存为 .png / .jpg / .webp：",
    "截图失败：",
    "截图失败：主进程没取到画面（MTNode 窗口最小化或不可见）。请先把窗口显示出来再拍。",
    "未知素材操作：",
    "素材库与截图",
    "读素材库 / 窗口截图",
    "列出素材库、取内容条目的本机路径、把 MTNode 窗口拍成静帧 PNG",
  ];
  const I18n = require(path.join(ROOT, "renderer", "i18n.js"));
  I18n.setLocale("en");
  for (const k of keys) {
    const t = I18n.t(k);
    ok(t !== k && !!t, "EN 有译文：「" + k.slice(0, 18) + "…」");
  }
  I18n.setLocale("zh");
  for (const k of keys) ok(I18n.t(k) === k, "ZH 原样回显（缺字不会漏）：「" + k.slice(0, 14) + "…」");
}

console.log("\n[7] 定位逻辑真跑：assetAgentFindItem 三种方式");
{
  const src =
    "var I18n = { t: function (s) { return s; } };\n" +
    "var window = { api: {} };\n" +
    fnOf(ASSETS, "assetAgentFindItem") +
    "\nreturn assetAgentFindItem;";
  /* eslint-disable no-new-func */
  const find = new Function(src)();
  const scan = {
    root: "E:\\mtnode-plugins\\assets",
    scan: {
      assets: [
        {
          id: "asmu2mginfwgd8qj",
          rel: "DS Adventure/Characters/AI娘原人设",
          displayName: "AI娘原人设",
          items: [
            {
              id: "itmu2mgsv2ceopv0",
              title: "Deepseek",
              type: "image",
              absPath: "E:\\mtnode-plugins\\assets\\DS Adventure\\Characters\\AI娘原人设\\items\\a.jpg",
            },
          ],
        },
        {
          id: "asview",
          rel: "DS Adventure/Characters/AI娘原人设Q版三视图",
          displayName: "AI娘原人设Q版三视图",
          items: [
            {
              id: "itv1",
              title: "正面",
              type: "image",
              absPath: "E:\\mtnode-plugins\\assets\\DS Adventure\\Characters\\AI娘原人设Q版三视图\\items\\f.png",
            },
            {
              id: "itv2",
              title: "侧面",
              type: "image",
              absPath: "E:\\mtnode-plugins\\assets\\DS Adventure\\Characters\\AI娘原人设Q版三视图\\items\\s.png",
            },
          ],
        },
      ],
    },
  };
  const byId = find(scan, { id: "asview", itemId: "itv2" });
  ok(byId.asset && byId.asset.rel === "DS Adventure/Characters/AI娘原人设Q版三视图", "按 id 定位素材");
  ok(byId.items.length === 1 && byId.items[0].title === "侧面", "按 itemId 取到那一条");
  const byRel = find(scan, { rel: "AI娘原人设Q版三视图", index: 0 });
  ok(byRel.asset && byRel.items[0].title === "正面", "按相对路径尾段定位 + index 取第 0 条");
  const byPath = find(scan, {
    path: "E:\\mtnode-plugins\\assets\\DS Adventure\\Characters\\AI娘原人设\\items\\a.jpg",
  });
  ok(byPath.asset && byPath.asset.displayName === "AI娘原人设", "按绝对文件路径反查所属素材");
  const byType = find(scan, { id: "asview", type: "image", limit: 5 });
  ok(byType.items.length === 2, "按 type 批量取（limit 生效前先筛出全部匹配项）");
  const outside = find(scan, { path: "E:\\dev\\tools\\tutorial\\update_1.4\\shot.png" });
  ok(
    outside.items && outside.items.length === 1 && outside.items[0].path === undefined,
    "库外路径：当作本机文件原样交回（不假装它是素材）",
  );
  const miss = find(scan, { id: "nope" });
  ok(!!miss.error && miss.error.indexOf("素材库里没有这个素材：") === 0, "找不到时回明确错误");
}

console.log(
  fails
    ? "\n " + fails + " / " + checks + " 项失败  (smoke-assets-tool)\n"
    : "\n✓ 全部 " + checks + " 项通过  (smoke-assets-tool)\n",
);
process.exit(fails ? 1 : 0);