"use strict";
/* ============================================================
 * 画布左栏「文件」页（VSCode explorer 式文件树）
 * —— 链路级冒烟测试（纯 Node，不依赖 Electron）
 *   node test/smoke-sidebar-files.js
 *
 * 被测代码是真实源码，不抄逻辑：
 *   renderer/app-sidebar-files.js  纯函数段切片真跑（类型分档 / 预览判据 / 排序 /
 *                                  重名加 (2) / 拖入汇总 / 路径拼接）
 *   renderer/index.html            Tabs 与工具条 DOM + 脚本注册顺序
 *   renderer/style.css             @import css/sidebar-files.css
 *   renderer/css/sidebar-files.css 运行时真实吐出的每个 class 都有规则
 *   main.js                        file:readDir / rename / copy / move / trash 五个通道
 *                                  + 删除走 shell.trashItem + 应用目录守卫
 *   preload.js                     五个桥暴露给渲染层
 *   renderer/app.js                drop 里先认左侧文件页的内部拖拽
 *   renderer/i18n.js               本轮新增中文串在 EN 表逐条命中
 * ============================================================ */
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
  fs
    .readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8")
    .replace(/\r\n?/g, "\n");
const HAS = (src, needle, msg) => ok(src.indexOf(needle) >= 0, msg);
const EQS = (got, want, msg) =>
  ok(
    got === want,
    msg +
      (got === want
        ? ""
        : "\n        实际=" + JSON.stringify(got) + "\n        期望=" + JSON.stringify(want)),
  );

const MOD = read("renderer/app-sidebar-files.js");
const HTML = read("renderer/index.html");
const STYLE = read("renderer/style.css");
const CSS = read("renderer/css/sidebar-files.css");
const MAIN = read("main.js");
const PRELOAD = read("preload.js");
const APP = read("renderer/app.js");
const I18N = read("renderer/i18n.js");

/* ── [1] 纯函数段切片真跑 ── */
console.log("\n[1] 纯函数段（真源码切片）");
const PURE_BEGIN = "/* ===== 纯函数段";
const PURE_END = "/* ===== 纯函数段结束 ===== */";
const i0 = MOD.indexOf(PURE_BEGIN);
const i1 = MOD.indexOf(PURE_END);
ok(i0 >= 0 && i1 > i0, "app-sidebar-files.js 有可切片的纯函数段");
const PURE = MOD.slice(MOD.indexOf("\n", i0) + 1, i1);
const sandbox = {
  fileviewLangOf: (p) => (/\.(md|txt|js|ts|json|yaml|yml|py|css|html)$/i.test(p) ? "text" : ""),
  fileviewIsImagePath: (p) => /\.(png|jpe?g|gif|webp|svg|ico)$/i.test(p),
  I18n: undefined,
};
vm.createContext(sandbox);
vm.runInContext(PURE, sandbox);
const S = sandbox;

/* 路径层 */
EQS(S.sfBaseName("E:\\dev\\proj\\renderer\\app.js"), "app.js", "sfBaseName 认反斜杠");
EQS(S.sfBaseName("/home/u/proj/a.md"), "a.md", "sfBaseName 认正斜杠");
EQS(S.sfBaseName("E:\\dev\\proj\\"), "proj", "sfBaseName 吃掉尾部反斜杠");
EQS(S.sfDirOf("E:\\dev\\proj\\a.md"), "E:\\dev\\proj", "sfDirOf 反斜杠目录");
EQS(S.sfDirOf("/home/u/a.md"), "/home/u", "sfDirOf 正斜杠目录");
EQS(S.sfDirOf("E:\\"), "E:\\", "sfDirOf 盘符根不退化");
EQS(S.sfJoin("E:\\dev\\proj", "a.md"), "E:\\dev\\proj\\a.md", "sfJoin 反斜杠目录用 \\");
EQS(S.sfJoin("/home/u", "a.md"), "/home/u/a.md", "sfJoin 正斜杠目录用 /");
EQS(S.sfJoin("E:\\dev\\proj\\", "a.md"), "E:\\dev\\proj\\a.md", "sfJoin 不吃出双分隔符");
EQS(S.sfExtOf("E:\\a\\README.MD"), "md", "sfExtOf 扩展名小写");
EQS(S.sfExtOf("E:\\a\\.gitignore"), "", "sfExtOf 整段即名字 → 空");
EQS(JSON.stringify(S.sfSplitName("note.md")), '{"stem":"note","ext":".md"}', "sfSplitName 拆主名");
EQS(JSON.stringify(S.sfSplitName("README")), '{"stem":"README","ext":""}', "sfSplitName 无扩展名");

/* 类型分档 / 预览判据 */
EQS(S.sfTypeBucket("a.md"), "text", "md 归文本档");
EQS(S.sfTypeBucket("a.txt"), "text", "txt 归文本档");
EQS(S.sfTypeBucket("a.js"), "text", "js 归文本档");
EQS(S.sfTypeBucket("a.png"), "image", "png 归图像档");
EQS(S.sfTypeBucket("a.mp4"), "media", "mp4 归媒体档");
EQS(S.sfTypeBucket("a.wav"), "media", "wav 归媒体档");
EQS(S.sfTypeBucket("a.exe"), "other", "exe 归其他档（→ 文件节点）");
ok(S.sfPreviewable("a.md") && S.sfPreviewable("a.txt") && S.sfPreviewable("a.png"), "md / 文本 / 图像都可预览");
ok(!S.sfPreviewable("a.zip") && !S.sfPreviewable("a.mp4"), "压缩包与媒体不给预览字样");
EQS(S.sfIconKind("x.md", false), "md", "md 有专属图标");
EQS(S.sfIconKind("x.js", false), "code", "代码图标");
EQS(S.sfIconKind("x.png", false), "image", "图像图标");
EQS(S.sfIconKind("x.mp3", false), "media", "媒体图标");
EQS(S.sfIconKind("x.bin", false), "file", "其他文件图标");
EQS(S.sfIconKind("x", true), "dir", "文件夹图标");

/* 筛选 / 搜索 / 排序 */
ok(S.sfMatchQuery("app.js", "APP"), "搜索忽略大小写");
ok(S.sfMatchQuery("app.js", "  "), "空关键词全命中");
ok(!S.sfMatchQuery("app.js", "zzz"), "不匹配返回 false");
ok(S.sfMatchType("a.md", "all") && S.sfMatchType("a.md", "") && S.sfMatchType("a.md", "text"), "类型筛选 all/空/命中");
ok(!S.sfMatchType("a.png", "text"), "类型筛选不命中");
const sorted = S.sfSortEntries([
  { name: "file10.md", isDir: false },
  { name: "file2.md", isDir: false },
  { name: "zzz", isDir: true },
  { name: "Images", isDir: true },
]);
EQS(
  sorted.map((e) => e.name).join(","),
  "Images,zzz,file2.md,file10.md",
  "排序：目录在前 + 名字数值序",
);

/* 重名自动加 (2) */
EQS(S.sfUniqueName("a.md", new Set()), "a.md", "无重名保持原名");
EQS(S.sfUniqueName("a.md", new Set(["a.md"])), "a (2).md", "重名加 (2) 且保留扩展名");
EQS(S.sfUniqueName("a.md", new Set(["a.md", "a (2).md", "a (3).md"])), "a (4).md", "连续重名递增");
EQS(S.sfUniqueName("README", new Set(["README"])), "README (2)", "无扩展名也加 (2)");
EQS(S.sfUniqueName("a.md", (n) => n === "a.md"), "a (2).md", "exists 也接受函数");

EQS(S.sfFormatSize(0), "0 B", "体积 0");
EQS(S.sfFormatSize(2048), "2.0 KB", "体积 KB");
EQS(S.sfFormatSize(1024 * 1024 * 3), "3.0 MB", "体积 MB");

/* 拖入汇总（含文件夹只取第一层的说明） */
const sum = S.sfDropSummary({ image: 2, text: 1, other: 0, total: 3 }, { dirs: 1, files: 4 });
HAS(sum, "3", "汇总带节点总数");
HAS(sum, "图像 2", "汇总按类型列计数");
HAS(sum, "第一层", "汇总说明文件夹只取第一层、不递归");
/* 顶层 const 不进 sandbox 属性（词法作用域），用同上下文表达式取值 */
ok(
  vm.runInContext("SF_HEAVY_DIRS.has('node_modules') && SF_HEAVY_DIRS.has('.git')", sandbox),
  "重型目录只列不自动展开",
);
ok(vm.runInContext("SF_SEARCH_CAP > 0", sandbox), "搜索有条数上限");

/* ── [2] 侧栏 DOM 与脚本注册 ── */
console.log("\n[2] index.html：Tabs 与工具条");
HAS(HTML, 'id="sideTabs"', "边栏顶部有 Tabs 容器");
HAS(HTML, 'id="sideTabNodes"', "第一个 Tab = 节点");
ok(/class="side-tab on" id="sideTabNodes"/.test(HTML), "节点 Tab 默认选中（on）");
HAS(HTML, 'id="sideTabFiles"', "第二个 Tab = 文件");
HAS(HTML, 'id="sideFilesRoot"', "目录选择器");
HAS(HTML, 'id="sideFilesOpen"', "在资源管理器中打开按钮");
HAS(HTML, 'id="sideFilesSearch"', "文件搜索框");
HAS(HTML, 'id="sideFilesType"', "类型筛选下拉");
HAS(HTML, 'id="sideFilesRefresh"', "刷新按钮");
HAS(HTML, 'id="sideFilesPaste"', "粘贴按钮");
HAS(HTML, 'id="sideFilesTree"', "文件树容器");
ok(
  HTML.indexOf('id="sideTabs"') < HTML.indexOf('id="sideFilter"'),
  "Tabs 在节点搜索框之前（最上方）",
);
const ORDER_APP = HTML.indexOf('<script src="app.js">');
const ORDER_NEW = HTML.indexOf('<script src="app-sidebar-files.js">');
ok(ORDER_NEW > ORDER_APP && ORDER_APP >= 0, "app-sidebar-files.js 注册在 app.js 之后");
HAS(HTML, "app-factlib.js", "（保持原有模块顺序）");

/* ── [3] 样式链 ── */
console.log("\n[3] 样式");
HAS(STYLE, '@import url("./css/sidebar-files.css")', "style.css 已 @import css/sidebar-files.css");
const CLASSES = [
  "side-tabs", "side-tab", "side-files", "side-files-root", "side-files-tools",
  "side-files-tree", "side-ico-btn", "side-txt-btn",
  "sf-row", "sf-twisty", "sf-ico", "sf-name", "sf-name-input", "sf-prev",
  "sf-empty", "sf-search-head", "sf-sub", "sf-menu", "sf-menu-item", "sf-menu-sep",
];
for (const c of CLASSES) HAS(CSS, "." + c, "样式里有 ." + c);
for (const c of ["sf-ico-dir", "sf-ico-md", "sf-ico-code", "sf-ico-image", "sf-ico-media", "sf-ico-file"]) {
  HAS(MOD, '"' + c.slice("sf-ico-".length) + '"', "图标分档含 " + c.slice("sf-ico-".length));
}
HAS(CSS, "#sidebar.sf-on .sidebar-search", "文件页占位时收起节点搜索框");
HAS(CSS, "#sidebar:not(.sf-on) .side-files", "节点页占位时收起文件页");
ok(CSS.indexOf("body.theme-light") >= 0, "亮色主题覆盖");

/* ── [4] 主进程能力 + 桥 ── */
console.log("\n[4] 主进程与 preload");
for (const ch of ["file:readDir", "file:rename", "file:copy", "file:move", "file:trash"]) {
  HAS(MAIN, 'ipcMain.handle("' + ch + '"', "main.js 注册了 " + ch);
}
HAS(MAIN, "shell.trashItem", "删除走系统回收站（shell.trashItem）");
HAS(MAIN, "sfAppRootGuard", "有应用目录守卫");
HAS(MAIN, "node_modules", "（既有 file:listDir 递归口径仍在）");
const trashIdx = MAIN.indexOf('ipcMain.handle("file:trash"');
const trashBlock = MAIN.slice(trashIdx, trashIdx + 1200);
ok(
  trashIdx >= 0 &&
    trashBlock.indexOf("shell.trashItem") >= 0 &&
    !/unlink|rmSync|\.rm\(/.test(trashBlock),
  "file:trash 只走回收站、不做物理删除",
);
for (const fn of ["fileReadDir", "fileRename", "fileCopy", "fileMove", "fileTrash"]) {
  HAS(PRELOAD, fn + ":", "preload.js 暴露 " + fn);
}
HAS(PRELOAD, "ipcRenderer.invoke('file:trash'", "fileTrash 走 file:trash");

/* ── [5] 拖入画布接线 ── */
console.log("\n[5] 拖入画布");
HAS(APP, "sidebarFilesDropPayload", "app.js 的 drop 先认左侧文件页的内部拖拽");
HAS(APP, "await sidebarFilesDropToCanvas(sidebarPaths, pt)", "内部拖拽交给文件页模块处理");
HAS(MOD, 'x-mtnode-files', "内部拖拽用专属 MIME 类型，不混入系统文件拖放");
HAS(MOD, "createNodesFromDroppedFiles", "建节点复用 app.js 的既有映射（图像 / 文本 / 音视频 / 文件块）");
HAS(MOD, "sfPreviewable(path)", "只有可预览的文件才挂「预览」字样");
HAS(MOD, "openFilePeek", "预览复用已有右侧文件面板");
HAS(MOD, "confirmDialog", "拖入前弹窗确认");
HAS(MOD, "fileMove", "剪切粘贴走 move");
HAS(MOD, "sfUniqueName", "粘贴重名自动加 (2)（不覆盖）");

/* ── [6] i18n ── */
console.log("\n[6] i18n（本轮新增串在 EN 表命中）");
const EN_KEYS = [
  "粘贴", "剪切", "搜索文件…", "文件页显示的目录（按画布记忆）", "按类型筛选",
  "刷新文件树", "把剪贴板里的文件粘贴到当前选中文件夹", "（未设置）", "项目根：",
  "自定义：", "浏览…", "在右侧文件面板中预览", "搜索：", "没有匹配的文件",
  "读取中…", "目录不存在或不可读：", "这个目录是空的", "在资源管理器中显示",
  "复制完整路径", "已复制路径", "重命名失败：", "已重命名：", "剪贴板为空",
  "目标文件夹不存在：", "粘贴失败：", "确定删除「{name}」？它会移入系统回收站。",
  "确定删除选中的 {n} 项？它们会移入系统回收站。", "这里没有可建节点的文件",
  "拖入画布", "创建节点", "无法预览该文件", "将创建 {n} 个节点：",
  "{summary}？创建后可 Ctrl+Z 一次撤销。", "文件名不能为空",
  "文件名不能包含路径分隔符", "同名文件已存在", "不能改动应用目录本身",
];
for (const k of EN_KEYS) HAS(I18N, '"' + k + '"', "EN 表命中：" + k);

console.log(
  "\n" + (fails ? "FAIL " + fails + " / " : "全部通过 ") + checks + " 项检查" + (fails ? "" : " ✓"),
);
process.exit(fails ? 1 : 0);
