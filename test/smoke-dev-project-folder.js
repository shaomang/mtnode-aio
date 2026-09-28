"use strict";
/* 开发节点「设置项目文件夹」（devPath）—— 冒烟测试（纯 Node：源码切片进 vm，真跑顶层块判定；不依赖 Electron）
 *   node test/smoke-dev-project-folder.js
 * 覆盖：
 *   [1] 入口只给「最外层开发块」：devTopBlockForProjectFolder 对 顶层 dev / 子 dev / 数据库 / 普通超节点 / 普通节点 的判定
 *   [2] 右键菜单：最外层块给「设置项目文件夹…」，其余超节点仍给「设置子文件夹…」
 *   [3] 节点头部：最外层块那一格是项目文件夹（不显示子文件夹），点击走 promptDevProjectFolder
 *   [4] 对话框：写 node.devPath（只此一处）· 系统文件夹选择器 · 清空 = 清除 · 持久化跳窗
 *   [5] i18n：新入口用到的词条中英齐备（英文界面不漏中文）
 */
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
const read = (rel) =>
  fs.readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8");

const APP = read("renderer/app.js");
const CANVAS = read("renderer/app-canvas.js");

function between(src, aMark, bMark, label) {
  const i = src.indexOf(aMark);
  const j = i < 0 ? -1 : src.indexOf(bMark, i + aMark.length);
  const good = i > 0 && j > i;
  ok(good, "定位到源码段：" + label);
  return good ? src.slice(i, j) : "";
}

/* ==================== [1] 顶层块判定（真跑源码切片） ==================== */
console.log("\n[1] 入口只给最外层开发块（devTopBlockForProjectFolder）");
{
  const SRC_PARENT = between(
    APP,
    "function devParentOf(node, wf) {",
    "/* 开发节点块判定（单一真源）",
    "app.js devParentOf / devPathOfIn",
  );
  const SRC_DEVBLOCK = between(
    APP,
    "function devIsDevBlock(node) {",
    "/* 画布项目根（单一真源）",
    "app.js devIsDevBlock / devIsTopBlock",
  );
  const SRC_TOPDEV = between(
    CANVAS,
    "function devTopBlockForProjectFolder(node) {",
    "/* 「设置项目文件夹」",
    "app-canvas.js devTopBlockForProjectFolder",
  );
  const nodes = [
    { id: "top", kind: "super", dev: true, devKind: "module", title: "MTNode 编排器" },
    { id: "mid", kind: "super", dev: true, devKind: "module", title: "渲染层", parentSuperId: "top" },
    { id: "leaf", kind: "super", dev: true, devKind: "file", title: "app-canvas.js", parentSuperId: "mid" },
    { id: "wrap", kind: "super", title: "普通超级节点" },
    { id: "wrapped", kind: "super", dev: true, devKind: "module", title: "被普通壳包住的顶层块", parentSuperId: "wrap" },
    { id: "db", kind: "super", dev: true, db: true, title: "数据库超级节点" },
    { id: "txt", kind: "proc_text", title: "普通节点" },
  ];
  const byId = (id) => nodes.filter((n) => n.id === id)[0] || null;
  const sb = {
    console,
    nodeById: byId,
    S: { wf: { nodes } },
    I18n: { t: (k) => k },
    toast: () => {},
    isAbsPath: (p) => path.win32.isAbsolute(String(p || "")),
  };
  const ctx = vm.createContext(sb);
  vm.runInContext(SRC_PARENT, ctx, { filename: "app.js#dev-parent" });
  vm.runInContext(SRC_DEVBLOCK, ctx, { filename: "app.js#dev-block" });
  vm.runInContext(SRC_TOPDEV, ctx, { filename: "app-canvas.js#top-dev" });
  const pred = (id) => vm.runInContext("devTopBlockForProjectFolder(nodeById(" + JSON.stringify(id) + "))", sb);
  ok(pred("top") === true, "顶层功能块 → 给「设置项目文件夹」入口");
  ok(pred("mid") === false, "开发节点内部的子块 → 不给（改走子文件夹）");
  ok(pred("leaf") === false, "更深一层的子块 → 不给（改走子文件夹）");
  ok(pred("wrapped") === true, "被普通超级壳包住的开发块仍算最外层（与 devIsTopBlock 同口径）");
  ok(pred("wrap") === false, "普通超级节点不是开发块 → 走的还是子文件夹");
  ok(pred("db") === false, "数据库超级节点不算开发块（子文件夹是它的入库目录，必须保留）");
  ok(pred("txt") === false, "非超节点 → 不给");
  ok(pred(null) === false, "空节点 → 不给（不抛异常）");
}

/* ==================== [2] 右键菜单 ==================== */
console.log("\n[2] 右键菜单：最外层块给「设置项目文件夹…」，其余超节点仍是「设置子文件夹…」");
{
  ok(CANVAS.indexOf('I18n.t("设置项目文件夹…")') >= 0, "菜单有「设置项目文件夹…」项");
  ok(CANVAS.indexOf('I18n.t("设置子文件夹…")') >= 0, "菜单仍有「设置子文件夹…」项（子块 / 普通壳 / 数据库壳）");
  const menu = CANVAS.slice(
    CANVAS.indexOf('I18n.t("将选中节点移入此超级节点")') - 900,
    CANVAS.indexOf('I18n.t("将选中节点移入此超级节点")'),
  );
  ok(
    menu.indexOf("devTopBlockForProjectFolder(node)") >= 0,
    "两项互斥：同一处按 devTopBlockForProjectFolder(node) 二选一",
  );
  ok(
    menu.indexOf("() => promptDevProjectFolder(node)") >= 0 &&
      menu.indexOf("() => promptSuperSubFolder(node)") >= 0,
    "两项各自接到 promptDevProjectFolder / promptSuperSubFolder",
  );
}

/* ==================== [3] 节点头部 ==================== */
console.log("\n[3] 节点头部：最外层块那一格是项目文件夹（不显示子文件夹）");
{
  ok(
    CANVAS.indexOf("const topDev = devTopBlockForProjectFolder(node);") >= 0,
    "头部按同一判定取 topDev",
  );
  ok(
    CANVAS.indexOf('const sf = topDev ? "" : String(node.subFolder || "").trim();') >= 0,
    "最外层块清空 sf → 子文件夹文案与徽标都不渲染",
  );
  ok(
    CANVAS.indexOf('I18n.t("项目文件夹：") + headPath') >= 0 &&
      CANVAS.indexOf('I18n.t("子文件夹：") + headPath') >= 0,
    "同一个徽标位：最外层块显示项目文件夹，其余显示子文件夹",
  );
  ok(
    CANVAS.indexOf('I18n.t("设置项目文件夹（本功能块的项目根 devPath）")') >= 0 &&
      CANVAS.indexOf('I18n.t("设置子文件夹（内部节点默认相对路径）")') >= 0,
    "文件夹按钮的 tooltip 按层级分叉",
  );
  ok(
    CANVAS.indexOf("if (topDev) promptDevProjectFolder(node);") >= 0 &&
      CANVAS.indexOf("else promptSuperSubFolder(node);") >= 0,
    "文件夹按钮点击按层级分叉",
  );
}

/* ==================== [4] 对话框 ==================== */
console.log("\n[4] 对话框：写 node.devPath 一处 · 系统文件夹选择 · 可清除 · 持久化");
{
  const fn = between(
    CANVAS,
    "function promptDevProjectFolder(node) {",
    "/* 编辑核心文件",
    "app-canvas.js promptDevProjectFolder",
  );
  ok(fn.indexOf("node.devPath = next;") >= 0, "确定 = 写 node.devPath（子块靠就近继承，不改子节点）");
  ok(
    fn.split("node.devPath").length - 1 === 1,
    "devPath 全函数只写一处（无第二处漂移）",
  );
  ok(fn.indexOf("directory: true") >= 0, "系统文件夹选择器（directory: true）");
  ok(fn.indexOf("persistent: true") >= 0, "跳窗 persistent（点外部不丢输入）");
  ok(fn.indexOf("pushHistory()") >= 0, "写入前记历史（可撤销）");
  ok(fn.indexOf("scheduleSave(true)") >= 0, "写入后落盘");
  ok(
    fn.indexOf('I18n.t("清除")') >= 0 &&
      fn.indexOf('I18n.t("项目文件夹已设为：")') >= 0 &&
      fn.indexOf('I18n.t("已清除项目文件夹")') >= 0,
    "可清除（清空 = devPath 置空，toast 区分设置 / 清除）",
  );
  ok(
    fn.indexOf("!devTopBlockForProjectFolder(node)") >= 0,
    "绕过菜单直接调用也拦：非最外层块拒绝写入",
  );
}

/* ==================== [5] i18n 词条 ==================== */
console.log("\n[5] i18n 词条：新入口与对话框用到的键中英齐备");
{
  const I18n = require("../renderer/i18n.js");
  I18n.setLocale("en");
  const newFn = between(
    CANVAS,
    "function devTopBlockForProjectFolder(node) {",
    "/* 编辑核心文件",
    "app-canvas.js 项目文件夹入口",
  );
  const re = /I18n\.t\(\s*(["'])((?:\\.|(?!\1)[^\\])*)\1/g;
  const keys = new Set();
  let m;
  while ((m = re.exec(newFn))) keys.add(m[2]);
  for (const extra of [
    "设置项目文件夹…",
    "设置子文件夹…",
    "项目文件夹：",
    "子文件夹：",
    "设置项目文件夹（本功能块的项目根 devPath）",
    "设置子文件夹（内部节点默认相对路径）",
  ])
    keys.add(extra);
  ok(keys.size >= 18, "采集到入口 + 对话框的词条键（" + keys.size + " 个）");
  const missing = [...keys].filter((k) => I18n.t(k) === k);
  ok(missing.length === 0, "词条齐备，缺：" + (missing.join(" / ") || "无"));
  ok(
    I18n.t("设置项目文件夹") === "Set project folder" &&
      I18n.t("项目文件夹已设为：") !== "项目文件夹已设为：",
    "英文界面不漏中文（抽查两条）",
  );
}

console.log(
  "\n" + (fails ? "FAIL " + fails + " / " : "OK ") + checks + " 项检查" + (fails ? "" : "全绿"),
);
process.exit(fails ? 1 : 0);
