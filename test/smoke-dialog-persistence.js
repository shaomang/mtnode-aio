"use strict";
/* 对话框 persistent 回归（全应用开发原则）
 *   node test/smoke-dialog-persistence.js
 * 需求：**所有对话框 / 参数面板都要 persistent，不许「点外部 / 点蒙层自动关闭」**。
 * 用户在窗里改到一半，随手点一下画布空白就把改动丢掉，是最伤的交互；关窗必须走
 * 显式路径（窗内「取消 / 完成并关闭 / 确定」、面板 ✕、Esc、再点一次触发它的开关）。
 * 口径写在 AGENTS.md「协作约定」，这里把它钉成回归测试：
 *   [1] #overlay 蒙层：不再挂「点背景关闭」的监听（closeOverlay 只由按钮 / 生命周期调用）
 *   [2] 节点参数面板（抠图 / 画幅锁定 / Agent 设定 / 外框色）：全局 mousedown 里不再收起
 *   [3] 其它对话框宿主（素材库 / 素材设置 / 素材表单 / 扩展能力管理 / 商店二级浮层 /
 *       YAML·Markdown 编辑器 / 手册窗 / 插件详情 / 审批与权限）：一律去掉点空白关闭
 *   [4] 顶掉点外部之后必须补上的两件事：面板互斥（closeNodePopsExcept）+ 跟画布重定位
 *       （applyTransform → repositionNodePops），且每块面板都还有显式关闭出口
 *   [5] 真跑：用 vm 抠出 placeNodePop / closeNodePopsExcept / repositionNodePops 跑几何与回收
 *   [6] 豁免名单（不是对话框）：瞬时菜单与图片预览灯箱 —— 它们保留点外部即收
 *   [7] AGENTS.md 已把这条写成开发原则（含适用面与豁免），避免下个会话又写回去
 *   [8] 弹窗尺寸不许跨窗残留：共享的 #overlay .overlay-box 每次开窗都清内联样式，
 *       作者小窗改走 .author-box 类；#overlay 溢出可滚动兜底（窄宽 / 超高关不掉的 bug） */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

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
/* 源码统一按 \n 处理（仓库是 CRLF，切段与断言不必管行尾差异） */
const read = (rel) =>
  fs
    .readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8")
    .replace(/\r\n/g, "\n");
const show = (v) => JSON.stringify(v);

const ROOT = path.join(__dirname, "..");
const rendererFiles = fs
  .readdirSync(path.join(ROOT, "renderer"))
  .filter((f) => f.endsWith(".js"))
  .map((f) => "renderer/" + f);

/* 取「起点关键字 → 终点关键字」之间的一段源码（比 indexOf 存在性判定严格得多） */
function seg(src, from, to, label) {
  const a = src.indexOf(from);
  if (a < 0) throw new Error("找不到起点：" + label);
  const b = src.indexOf(to, a);
  return src.slice(a, b < 0 ? src.length : b);
}

const boot = read("renderer/app-boot.js");
const app = read("renderer/app.js");
const devnode = read("renderer/app-devnode.js");
const nodes = read("renderer/app-nodes.js");
const assets = read("renderer/app-assets.js");
const plugins = read("renderer/app-plugins.js");
const store = read("renderer/app-store.js");
const agentsMd = read("AGENTS.md");

console.log("\n[1] #overlay 蒙层不再点一下就关窗");
{
  ok(
    boot.indexOf('$("#overlay").addEventListener("click"') < 0 &&
      boot.indexOf('$("#overlay").addEventListener("mousedown"') < 0,
    "app-boot.js 里 #overlay 背景上不挂任何关闭监听",
  );
  ok(
    boot.indexOf("closeOverlay()") < 0,
    "app-boot.js 全文没有 closeOverlay() 调用（关窗完全交回各对话框自己的按钮 / 生命周期）",
  );
  /* 「点外部是否关闭」的判据函数如果还有人引用，说明有第二条蒙层关闭路径没拆干净 */
  const strays = rendererFiles.filter((f) =>
    /overlayShouldStayOpen|overlayHasEditableFields|_overlayBgPointerDown/.test(read(f)),
  );
  ok(strays.length === 0, "没有残留的「蒙层可关」判据（残留文件：" + show(strays) + "）");
  ok(
    app.indexOf("let overlayPersistent = false;") > 0 &&
      app.indexOf("overlayPersistent = !!opts.persistent;") > 0,
    "overlayPersistent 仍在（调用方照旧声明意图，冒烟照旧读得到），但已不是「可点外部关」的开关",
  );
}

console.log("\n[2] 节点上的四块参数面板：点外部不收");
{
  const h = seg(app, 'window.addEventListener(\n    "mousedown",', "/* ============ 右键菜单", "全局 mousedown");
  ok(h.indexOf("closeBgRmPop()") < 0, "抠图面板（bgRmPop）不在全局点击里收起");
  ok(h.indexOf("closeRatioLockPop()") < 0, "画幅锁面板（ratioLockPop）不在全局点击里收起");
  ok(h.indexOf("closeDevModelPicker()") < 0, "Agent 设定面板（devModelPop）不在全局点击里收起");
  ok(h.indexOf("closeDevColorPicker()") < 0, "外框色面板（devColorPop）不在全局点击里收起");
  ok(
    h.indexOf("closeRefMenu()") > 0 && h.indexOf("closeSlashMenu()") > 0,
    "该收的照旧收：@ 引用候选与斜杠候选是菜单，不是对话框（点外部即收没错）",
  );
  /* 面板自己的按钮：左键切开关、右键开面板；关它只走这两条 + ✕ */
  const rl = seg(app, "function ratioLockButtonEl", "/* ============ 思考内容", "ratioLockButtonEl");
  ok(
    rl.indexOf("closeRatioLockPop();") > 0 && rl.indexOf("openRatioLockPop(node, btn)") > 0,
    "画幅锁定：单击切开关会顺手收面板，右键再点一次也收（显式路径齐备）",
  );
  const br = seg(app, "function bgRmButtonEl", "/* ═", "bgRmButtonEl");
  ok(
    br.indexOf("closeBgRmPop();") > 0 && br.indexOf("openBgRmPop(node, btn)") > 0,
    "透明背景：同一套显式开关 / 收起路径",
  );
}

console.log("\n[3] 对话框宿主一律去掉「点空白关闭」（豁免只剩图片灯箱）");
{
  /* 违规形态：比中宿主 / 蒙层的 target 之后紧接着就关窗（画布空白取消选中不算） */
  const CLOSEISH = /(?:\bclose[A-Za-z]*|\bfinish)\s*\(/;
  const hits = [];
  for (const f of rendererFiles) {
    const lines = read(f).split("\n");
    lines.forEach((L, i) => {
      if (!/if\s*\(\s*(?:ev|e)\.target\s*===/.test(L)) return;
      const block = lines.slice(i, i + 4).join(" ");
      if (!CLOSEISH.test(block)) return;
      if (block.includes("closeImageLightbox")) return; /* 灯箱：明确豁免 */
      hits.push(f + ":" + (i + 1) + " :: " + L.trim());
    });
  }
  ok(hits.length === 0, "全 renderer/ 扫描：点空白即关只剩图片灯箱（命中：" + show(hits) + "）");
  for (const [file, id] of [
    ["renderer/app-assets.js", "assetLibClose"],
    ["renderer/app-assets.js", "assetSetClose"],
    ["renderer/app-plugins.js", "extManagerClose"],
    ["renderer/app-store.js", "tplSubClose"],
    ["renderer/app.js", "appDocsClose"],
    ["renderer/app.js", "yamlViewerCloseBtn"],
    ["renderer/app.js", "mdViewerCloseBtn"],
  ]) {
    ok(read(file).indexOf(id) > 0, file + " 仍留着显式关闭构件 #" + id);
  }
  ok(
    assets.indexOf('foot.append(cancel, ok);') > 0,
    "素材表单框有「取消」按钮（不给蒙层关闭也没关系，出口在窗里）",
  );
  ok(
    nodes.indexOf("function toggleApprovalsPanel") > 0 &&
      seg(nodes, "function openApprovalsPanel", "function paintApprovalsPanelBody", "审批面板").indexOf(
        "closeApprovalsPanel();",
      ) < 0,
    "审批与权限面板：不再挂点外部收起的监听，关它走顶栏同一个按钮",
  );
}

console.log("\n[4] 顶掉点外部要补的两件事：互斥 + 跟画布");
{
  ok(
    app.indexOf("function closeNodePopsExcept") > 0 && app.indexOf("function closeAllNodePops") > 0,
    "closeNodePopsExcept / closeAllNodePops 已就位",
  );
  for (const [src, name, key] of [
    [app, "openBgRmPop", '"bgRm"'],
    [app, "openRatioLockPop", '"ratioLock"'],
    [devnode, "openDevModelPop", '"devModel"'],
    [devnode, "openDevColorPop", '"devColor"'],
  ]) {
    const body = seg(src, "function " + name, "\nfunction ", name);
    ok(
      body.indexOf("closeNodePopsExcept(" + key + ")") > 0,
      name + " 打开时互斥收掉别的面板（keep=" + key + "）",
    );
  }
  ok(
    seg(app, "function applyTransform()", "function applyTransformSoon", "applyTransform").indexOf(
      "repositionNodePops();",
    ) > 0,
    "applyTransform → repositionNodePops()：平移 / 缩放后面板跟回它的按钮",
  );
  for (const s of [".n-bgrm-btn", ".n-rl-btn"]) {
    ok(app.indexOf(s) > 0, "抠图 / 画幅锁定面板登记了锚点选择器 " + s);
  }
  ok(
    (app.match(/nodePopAnchor\(/g) || []).length >= 3 &&
      (devnode.match(/nodePopAnchor\(/g) || []).length >= 2,
    "四块面板都走同一个 nodePopAnchor（锚点选择器 + 宿主节点 id）",
  );
  ok(
    devnode.indexOf('.n-dev-model') > 0 && devnode.indexOf(".n-dev-color") > 0,
    "Agent 设定 / 外框色面板登记了锚点选择器 .n-dev-model / .n-dev-color",
  );
  const life = [
    [4987, "撤销 / 重做换对象"],
    [24760, "切画布前"],
    [24799, "loadWorkflow 前"],
  ];
  const nCloseAll = (app.match(/closeAllNodePops\(\);/g) || []).length;
  ok(nCloseAll >= 3, "生命周期上的显式收面板次数（" + nCloseAll + " 处 ≥3）· " + life.map((x) => x[1]).join(" / "));
  ok(
    app.indexOf('if (ev.key === "Escape" && (S.uiDevColorNode || S.uiDevModelNode))') > 0,
    "Esc 仍能收起开发节点弹层（键盘是显式路径，不算自动关闭）",
  );
}

console.log("\n[5] 真跑：落位几何 / 互斥 / 无主浮层回收");
{
  function fnBody(src, name) {
    const m = src.match(new RegExp("\\nfunction " + name + "\\s*\\(", "m"));
    if (!m) throw new Error("找不到函数：" + name);
    const at = src.indexOf("{", m.index);
    let depth = 0;
    let inStr = null;
    for (let j = at; j < src.length; j++) {
      const c = src[j];
      if (inStr) {
        if (c === "\\") j++;
        else if (c === inStr) inStr = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") inStr = c;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (!depth) return src.slice(m.index + 1, j + 1);
      }
    }
    throw new Error("函数体没闭合：" + name);
  }
  const mkEl = (id, on) => ({
    id,
    style: {},
    offsetWidth: 300,
    offsetHeight: 200,
    _on: !!on,
    classList: {
      contains(c) {
        return this._p._on && c === "on";
      },
      add(c) {
        if (c === "on") this._p._on = true;
      },
      remove(c) {
        if (c === "on") this._p._on = false;
      },
    },
  });
  const els = {};
  const anchors = {};
  for (const id of ["bgRmPop", "ratioLockPop", "devModelPop", "devColorPop"]) {
    /* 宽高给 0：让 placeNodePop 走「opt.w / opt.h 兜底」那条路，断言才只取决于几何 */
    els[id] = mkEl(id, false);
    els[id].offsetWidth = 0;
    els[id].offsetHeight = 0;
    els[id].classList._p = els[id];
  }
  const closed = [];
  const sb = {
    console,
    __nodes: [],
    nodeById: (id) => sb.__nodes.find((n) => n.id === id) || null,
    window: { innerWidth: 1200, innerHeight: 800 },
    document: {
      body: { getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0 }) },
      getElementById: (id) => els[id] || null,
      querySelector: (sel) => anchors[sel] || null,
    },
    closeBgRmPop: () => {
      if (els.bgRmPop._on) closed.push("bgRm");
      els.bgRmPop.classList.remove("on");
    },
    closeRatioLockPop: () => {
      if (els.ratioLockPop._on) closed.push("ratioLock");
      els.ratioLockPop.classList.remove("on");
    },
    closeDevModelPicker: () => {
      if (els.devModelPop._on) closed.push("devModel");
      els.devModelPop.classList.remove("on");
    },
    closeDevColorPicker: () => {
      if (els.devColorPop._on) closed.push("devColor");
      els.devColorPop.classList.remove("on");
    },
  };
  vm.createContext(sb);
  const src = [
    "placeNodePop",
    "nodePopAnchor",
    "closeNodePopById",
    "closeNodePopsExcept",
    "closeAllNodePops",
    "repositionNodePops",
  ]
    .map((n) => fnBody(app, n))
    .join("\n");
  vm.runInContext(src, sb);
  const A = (sel, x, y) => {
    anchors[sel] = { getBoundingClientRect: () => ({ left: x, top: y, right: x + 20, bottom: y + 18 }) };
  };
  /* 落位：贴按钮下方，右侧越界翻到左边，底部越界翻到上方 */
  A("#a", 100, 100);
  vm.runInContext(
    "placeNodePop(document.getElementById('bgRmPop'), null, {w:300,h:200})",
    sb,
  );
  /* 上面这次 anchor 传 null → 退到 document.body（rect 全 0），只要求不炸 */
  ok(true, "placeNodePop 没有锚点时退回 body，不抛异常");
  A("SEL_RL", 1100, 100);
  els.ratioLockPop.classList.add("on");
  vm.runInContext(
    "nodePopAnchor(document.getElementById('ratioLockPop'),'SEL_RL',{w:300,h:340});repositionNodePops()",
    sb,
  );
  ok(
    els.ratioLockPop.style.left === "892px",
    "面板贴右边时横向夹住：left=" + els.ratioLockPop.style.left + "（1200-300-8）",
  );
  A("SEL_RL", 1100, 700);
  vm.runInContext("repositionNodePops()", sb);
  ok(
    els.ratioLockPop.style.top === "354px",
    "面板底部放不下时翻到按钮上方：top=" + els.ratioLockPop.style.top + "（700-340-6）",
  );
  /* 互斥：只留 keep 那一块 */
  els.bgRmPop.classList.add("on");
  els.devModelPop.classList.add("on");
  closed.length = 0;
  vm.runInContext("closeNodePopsExcept('devColor')", sb);
  ok(
    closed.join(",") === "bgRm,ratioLock,devModel" && !els.devColorPop._on,
    "closeNodePopsExcept('devColor') 收掉其它三块、留着 keep（实际收过：" + show(closed) + "）",
  );
  /* 无主浮层回收：节点已从画布上消失 → 关掉；只是这一帧没挂载（嵌在展开的壳里）→ 原地不动 */
  els.devColorPop.classList.add("on");
  A("SEL_DC", 40, 40);
  vm.runInContext(
    "nodePopAnchor(document.getElementById('devColorPop'),'SEL_DC',{w:200,h:200},'n7')",
    sb,
  );
  const before = els.devColorPop.style.left;
  delete anchors.SEL_DC;
  sb.__nodes = [{ id: "n7" }];
  closed.length = 0;
  vm.runInContext("repositionNodePops()", sb);
  ok(
    closed.length === 0 && els.devColorPop._on && els.devColorPop.style.left === before,
    "锚点暂时找不到（宿主节点还在）→ 不收也不乱挪（closed=" + show(closed) + "）",
  );
  sb.__nodes = [];
  closed.length = 0;
  vm.runInContext("repositionNodePops()", sb);
  ok(
    closed.join(",") === "devColor" && !els.devColorPop._on,
    "宿主节点没了（删节点 / 切画布 / 撤销换对象）→ 收掉这块无主浮层",
  );
}

console.log("\n[6] 豁免：瞬时菜单与图片灯箱照旧点外部即收");
{
  ok(
    app.indexOf("if (!m.contains(ev.target)) closeRefMenu();") > 0,
    "@ 引用候选菜单：保留点外部收起",
  );
  ok(
    assets.indexOf("if (m.contains(ev.target)) return;") > 0,
    "素材库小右键菜单：保留点外部收起",
  );
  ok(
    app.indexOf("if (ev.target === el) closeImageLightbox();") > 0,
    "图片预览灯箱：点外部关是常规交互，明确豁免",
  );
  ok(
    read("renderer/app-plan.js").indexOf("_planModelOutside") > 0,
    "计划窗的模型下拉：仍是菜单（点外部 / Esc 收起）",
  );
  ok(
    read("renderer/app-assist.js").indexOf("closeAgentMenus") < 0 ||
      read("renderer/app-boot.js").indexOf("closeAgentMenus()") > 0,
    "会话输入框的下拉菜单仍由点外部收起（app-boot.js 里那条监听保留）",
  );
}

console.log("\n[7] 原则写进 AGENTS.md，避免下个会话写回去");
{
  ok(agentsMd.indexOf("对话框 / 参数面板一律 persistent") > 0, "AGENTS.md「协作约定」有这条原则");
  ok(agentsMd.indexOf("禁止「点外部 / 点蒙层自动关闭」") > 0, "写清禁止什么");
  ok(
    agentsMd.indexOf("closeNodePopsExcept") > 0 && agentsMd.indexOf("repositionNodePops") > 0,
    "写清替代机制（互斥 + 跟随重定位）",
  );
  ok(agentsMd.indexOf("图片预览灯箱") > 0, "写清豁免边界（菜单 / 灯箱不算对话框）");
  ok(agentsMd.indexOf("smoke-dialog-persistence") > 0, "写了这条回归测试的指针");
}

console.log("\n[8] 弹窗尺寸不跨窗残留（窄宽 / 超高关不掉的 bug）");
{
  const componentsCss = read("renderer/css/components.css");
  const settings = read("renderer/app-settings.js");
  const openOv = seg(app, "function openOverlay(", "function closeOverlay", "openOverlay");
  const closeOv = seg(app, "function closeOverlay(", "let _mtDialogSeq", "closeOverlay");
  ok(
    openOv.indexOf('box.style.cssText = "";') > 0 &&
      openOv.indexOf('$("#overlay").style.alignItems = "";') > 0,
    "openOverlay 每次开窗都清掉共享 .overlay-box 的内联样式与内联居中",
  );
  ok(
    closeOv.indexOf('box.style.cssText = "";') > 0,
    "closeOverlay 收窗时同样清内联样式（下一窗从样式表默认尺寸起步）",
  );
  const author = seg(settings, "function openAuthorPopup(", "\n/* ============ 渲染外壳", "openAuthorPopup");
  ok(
    author.indexOf("box.style.cssText") < 0 && author.indexOf('classList.add("author-box")') > 0,
    "作者小窗改用 .author-box 类，不再内联改共享的 .overlay-box",
  );
  ok(
    /\.overlay-box\.author-box\s*\{[^}]*width:\s*min\(340px,\s*92%\)/.test(componentsCss) &&
      /\.overlay-box\.author-box\s*\{[^}]*border-top:\s*3px solid var\(--cyan\)/.test(componentsCss),
    "components.css 有 .overlay-box.author-box（窄身 340px + 青色顶边）",
  );
  ok(
    /#overlay\s*\{[^}]*overflow:\s*auto/.test(componentsCss) &&
      /\.overlay-box\s*\{[^}]*margin:\s*auto/.test(componentsCss),
    "#overlay overflow:auto + .overlay-box margin:auto：内容超高时可滚动，按钮不会被裁到屏幕外",
  );
}

console.log("\n" + (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ 全部 " + checks + " 项通过"));
process.exit(fails ? 1 : 0);
