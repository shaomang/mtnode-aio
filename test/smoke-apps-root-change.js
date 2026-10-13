/* test/smoke-apps-root-change.js — 「目录设置窗能改根 + 按需搬应用」与「开发页顶栏整体移除」
 *
 * 本轮需求（用户共识）两件事，本文件各钉一段：
 *   A. 目录设置窗每行两枚按钮「修改 / 打开」；点「修改」先在行内问一句旧目录里的应用要不要
 *      一起搬过去，再弹系统选目录框；换根后把搬过家的路径（应用画布 devPath / 工作目录、
 *      该应用开发会话的工作区）自动校准到新目录。
 *   B. 开发页顶栏整体移除：左上角只剩「新建应用」文字按钮；「启动 / 上架 / 📂（不带路径）」
 *      搬进中栏预览列头条（📂 · 启动 · 上架 · 刷新 · 应用设置 · 画布，放不下的收进「更多 ▾」）；
 *      预览条那串状态文字整体移除；「先拷问需求」「维持状态」两枚开关撤下（后者进
 *      「应用设置」窗并落盘记住）；左栏底部「＋ 新建应用」改成「＋ 新会话」。
 *
 * 口径：零依赖、不启动 electron（把 require("electron") 打桩）、不碰真实 %APPDATA%、
 * 所有真跑都落在临时目录里。
 *
 * 运行：node test/smoke-apps-root-change.js
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");
let checks = 0;
let fails = 0;
const ok = (cond, msg) => {
  checks++;
  console.log((cond ? "  ok    " : "FAIL  ") + msg);
  if (!cond) fails++;
};
const section = (t) => console.log("\n[" + t + "]");

/* ---------- electron 打桩（apps-store 只在调用期用它的少数 API） ---------- */
const electronStub = {
  app: {
    getAppPath: () => ROOT,
    getPath: () => "C:\\\\mtnode-fake-exe\\app.exe",
    isPackaged: false,
  },
  BrowserWindow: class {},
  ipcMain: { handle() {} },
  dialog: {},
  shell: {},
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  protocol: { registerSchemesAsPrivileged() {}, handle() {} },
  session: {},
  nativeImage: {},
};
const load = Module._load;
Module._load = function (req) {
  if (req === "electron") return electronStub;
  return load.apply(this, arguments);
};
const store = require(path.join(ROOT, "apps-store.js"));

/* ---------- 临时现场 ---------- */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-apps-rootchange-"));
const DATA = path.join(TMP, "data");
const OLD_DEV = path.join(TMP, "old-dev-root");
const NEW_DEV = path.join(TMP, "new-dev-root");
const OLD_DOWN = path.join(TMP, "old-lib-root");
const NEW_DOWN = path.join(TMP, "new-lib-root");
for (const d of [DATA, OLD_DEV, NEW_DEV, OLD_DOWN, NEW_DOWN]) fs.mkdirSync(d, { recursive: true });
store.registerAppsIpc({ getDataDir: () => DATA, t: (s) => String(s == null ? "" : s) });
const cfgPath = path.join(DATA, "config.json");
const writeCfg = (obj) => fs.writeFileSync(cfgPath, JSON.stringify(obj, null, 2), "utf8");
const readCfg = () => JSON.parse(fs.readFileSync(cfgPath, "utf8"));
writeCfg({ apps: { installDir: OLD_DOWN, projectDir: OLD_DEV } });

function makeApp(root, id, manifest) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), "<html><body>" + id + "</body></html>", "utf8");
  fs.writeFileSync(path.join(dir, "app.json"), JSON.stringify(manifest), "utf8");
  return dir;
}
/* 开发根里：两个开发中的应用 + 一个下载类的应用（不该被「开发目录」那一行搬走）
   + 一个认不出的目录（用户自己的东西，谁都不许动）。 */
makeApp(OLD_DEV, "devone", { id: "devone", name: "开发一", version: "0.1.0", entry: "index.html", dev: true });
makeApp(OLD_DEV, "devtwo", { id: "devtwo", name: "开发二", version: "0.1.0", entry: "index.html", dev: true });
makeApp(OLD_DEV, "downinDevRoot", { id: "downinDevRoot", name: "下载类", version: "1.0.0", entry: "index.html", dev: false });
fs.mkdirSync(path.join(OLD_DEV, "我的笔记"), { recursive: true });
fs.writeFileSync(path.join(OLD_DEV, "我的笔记", "a.txt"), "keep me", "utf8");
/* 新根里预置一个同名目录：必须跳过、不覆盖 */
const clash = path.join(NEW_DEV, "devtwo");
fs.mkdirSync(clash, { recursive: true });
fs.writeFileSync(path.join(clash, "app.json"), JSON.stringify({ id: "devtwo", dev: true, keep: "这一份别动" }), "utf8");
/* 下载根里：一个下载中的应用（「库目录」那一行该搬它） */
makeApp(OLD_DOWN, "libone", { id: "libone", name: "库应用", version: "1.0.0", entry: "index.html", dev: false });

console.log("smoke-apps-root-change：换根（修改 + 按需搬迁 + 路径校准）与开发页顶栏移除\n");

/* ═══════════ [1] 主进程：换根 + 按需搬迁（真跑，临时目录） ═══════════ */
section("1 主进程换根与搬迁（真跑）");
{
  /* 1.1 只换根、不搬（moveApps 缺省）：旧目录里的应用原样留着 */
  const r1 = store.setRootAndMaybeMove({ kind: "dev", path: NEW_DEV, moveApps: false });
  ok(r1.ok === true && r1.path === path.resolve(NEW_DEV), "「修改」写进 config.json 的 apps.projectDir");
  ok(readCfg().apps.projectDir === path.resolve(NEW_DEV), "配置文件里的开发根已更新");
  ok(r1.changed === true && r1.previous === OLD_DEV, "回执带上「从哪来」（previous / changed）");
  ok(r1.moved.length === 0, "只换根（moveApps:false）= 一个应用都不搬");
  ok(fs.existsSync(path.join(OLD_DEV, "devone")), "旧目录里的应用原样留着（不搬就是不动它）");

  /* 1.2 换回去，这次带上 moveApps: 只搬「开发目录」那一类 */
  store.setRootAndMaybeMove({ kind: "dev", path: OLD_DEV, moveApps: false });
  const r2 = store.setRootAndMaybeMove({ kind: "dev", path: NEW_DEV, moveApps: true });
  const movedIds = r2.moved.map((m) => m.id).sort();
  ok(r2.ok === true && movedIds.join(",") === "devone", "只搬开发类里**新根没有同名**的那些（devone）");
  ok(fs.existsSync(path.join(NEW_DEV, "devone", "app.json")), "搬过去的应用真在新根下（移动，不是复制）");
  ok(!fs.existsSync(path.join(OLD_DEV, "devone")), "旧目录里那一份已经不在（移动语义）");
  ok(
    r2.skipped.length === 1 && r2.skipped[0].id === "devtwo",
    "新根已有同名目录 → 跳过并如实回执（skipped 里点名）",
  );
  const kept = JSON.parse(fs.readFileSync(path.join(NEW_DEV, "devtwo", "app.json"), "utf8"));
  ok(kept.keep === "这一份别动", "被跳过的那个目录字节未动（绝不覆盖）");
  ok(fs.existsSync(path.join(OLD_DEV, "devtwo", "app.json")), "跳过的那一份仍留在旧目录");
  ok(
    fs.existsSync(path.join(OLD_DEV, "downinDevRoot", "app.json")),
    "只搬「这一行那一类」：换开发目录不会把 dev:false 的应用一起搬走",
  );
  ok(fs.existsSync(path.join(OLD_DEV, "我的笔记", "a.txt")), "认不出的目录（没有 app.json）= 用户自己的东西，一律不动");
  ok(r2.scanned === 2, "scanned 只数这一类的应用（devone + devtwo）");

  /* 1.3 「库目录」那一行：搬下载类 */
  const r3 = store.setRootAndMaybeMove({ kind: "down", path: NEW_DOWN, moveApps: true });
  ok(r3.ok === true && r3.moved.length === 1 && r3.moved[0].id === "libone", "库目录那一行搬下载类应用");
  ok(fs.existsSync(path.join(NEW_DOWN, "libone", "app.json")), "下载类的应用真的落到新库根");

  /* 1.4 守卫：不落在应用目录内 / 非绝对路径 / 磁盘根 */
  const bad1 = store.setRootAndMaybeMove({ kind: "dev", path: path.join(ROOT, "sub"), moveApps: true });
  ok(bad1.ok === false && bad1.reason === "app", "换到应用目录内被拒（reason=app），一个文件都不动");
  const bad2 = store.setRootAndMaybeMove({ kind: "dev", path: "relative/dir", moveApps: true });
  ok(bad2.ok === false, "非绝对路径被拒（reason=relative）");
  ok(
    readCfg().apps.projectDir === path.resolve(NEW_DEV),
    "被拒的那两次没有改写配置（根仍是上一次成功的那一个）",
  );

  /* 1.5 选到同一个文件夹（picker 里点回原目录）不算换根，不搬 */
  const same = store.setRootAndMaybeMove({ kind: "dev", path: NEW_DEV, moveApps: true });
  ok(same.ok === true && same.changed === false && same.moved.length === 0, "同一个目录 = 不算换根，不搬也不报错");
}

/* ═══════════ [2] 源码接线：目录设置窗（修改 / 打开 + 行内确认 + 回执） ═══════════ */
section("2 渲染层：目录设置窗");
const APPS = read("renderer/app-apps.js");
const DEVJS = read("renderer/app-apps-dev.js");
const FLOW = read("renderer/app-app-flow.js");
const PRELOAD = read("preload.js");
const STORE = read("apps-store.js");
const CSS = read("renderer/css/apps.css");
const I18N = read("renderer/i18n.js");
{
  const dirWin = APPS.slice(
    APPS.indexOf("async function appsDirSettingsOpen("),
    APPS.indexOf("async function appsAppSettingsOpen("),
  );
  ok(dirWin.length > 400, "目录设置窗仍在 app-apps.js 里");
  ok(
    /appsSetMiniBtn\(\s*"修改",/.test(dirWin) && /appsSetMiniBtn\(\s*"打开",/.test(dirWin),
    "每行右侧两枚按钮：「修改」+「打开」（用户口径）",
  );
  ok(
    dirWin.indexOf("appsSetOpenPath(p)") >= 0 && dirWin.indexOf("window.api.appsRootPick(kind") < 0,
    "「打开」= 既有 shell 出口（在资源管理器里打开）",
  );
  ok(
    dirWin.indexOf("const ask = document.createElement(\"div\")") >= 0 &&
      dirWin.indexOf("appsRootAppsOfKind(kind)") >= 0 &&
      dirWin.indexOf("appsRootChange(kind, true)") >= 0 &&
      dirWin.indexOf("appsRootChange(kind, false)") >= 0 &&
      dirWin.indexOf('ask.className = "apps-set-ask"') >= 0,
    "点「修改」先在**行内**问一句「要不要一起搬过去」（另开浮层会把本窗换掉，所以不开窗）",
  );
  const changeFn = APPS.slice(
    APPS.indexOf("async function appsRootChange(kind, moveApps)"),
    APPS.indexOf("async function appsDirSettingsOpen("),
  );
  ok(
    changeFn.indexOf("api.appsRootPick(kind, { moveApps: !!moveApps })") >= 0,
    "选目录走 appsRootPick（系统目录框，主进程弹）——渲染层不拼路径",
  );
  ok(
    changeFn.indexOf("if (r && r.canceled) return;") >= 0,
    "用户在系统框里取消 = 什么都不做、也不提示（那是他的意思）",
  );
  ok(
    changeFn.indexOf("appsRootsSyncConfig(r.roots)") >= 0,
    "换根后把主进程写的根同步进 S.config（不跟的话下一次整份回写会把它盖掉）",
  );
  ok(
    changeFn.indexOf("await appsListLoad(true)") >= 0 && changeFn.indexOf("appsHubPaint()") >= 0,
    "换根即强制重扫应用名单并重绘当前页（名单整个换了一批）",
  );
  ok(
    changeFn.indexOf("appsRootHealAfterMove(APPS_ROOT_LAST.moved)") >= 0 &&
      changeFn.indexOf("APPS_ROOT_LAST = {") >= 0 &&
      changeFn.indexOf("appsDirSettingsOpen();") >= 0,
    "搬完校准路径，并重开这只窗把新路径与搬迁回执摆出来（APPS_ROOT_LAST 读一次即清）",
  );
  ok(
    APPS.indexOf("function appsRootAppsOfKind(kind)") >= 0 &&
      APPS.indexOf("function appsRootResultEl(last)") >= 0 &&
      APPS.indexOf("已搬过去 ") >= 0 &&
      APPS.indexOf("跳过 ") >= 0,
    "「旧目录里有 N 个应用」那句与搬完的回执（搬了哪些 / 跳过哪些）都在册",
  );
  ok(
    dirWin.indexOf("appsDataOpenNow") < 0 &&
      dirWin.indexOf("appsCapabilityChecks") < 0 &&
      dirWin.indexOf("预览地址") < 0,
    "这只窗仍然只管两套根目录（应用自己的事在「应用设置」窗里）",
  );
  ok(CSS.indexOf(".apps-set-ask {") >= 0, "行内确认条有样式（css/apps.css 的 .apps-set-ask）");
}

/* ═══════════ [3] 源码接线：搬完的路径校准 ═══════════ */
section("3 渲染层：搬完校准路径");
{
  ok(
    FLOW.indexOf("async function appsRootHealAfterMove(moved)") >= 0 &&
      FLOW.indexOf("appsDevAlignAppWorkspace(id)") >= 0 &&
      FLOW.indexOf("async function appCanvasPathHealById(appId, appDir)") >= 0 &&
      FLOW.indexOf("window.api.wfSave(id, wf)") >= 0,
    "搬过家的每个应用：会话工作区对齐（appsDevAlignAppWorkspace）+ 画布路径两件套（wfSave 落盘）",
  );
  const healFn = FLOW.slice(
    FLOW.indexOf("async function appCanvasPathHealById("),
    FLOW.indexOf("async function appsRootHealAfterMove("),
  );
  ok(
    healFn.indexOf("appCanvasPathHeal(wf, dir)") >= 0 && healFn.indexOf("if (!hit) return false;") >= 0,
    "只在真改了东西时回写（没改 = 一个字节都不写画布）",
  );
  ok(
    FLOW.indexOf("function appCanvasPathHeal(wf, appDir)") >= 0 &&
      FLOW.indexOf("gone = !(await window.api.fileIsDir(cur));") >= 0,
    "校准口径仍是「只改指向的目录已不存在的那些」（用户手填且还在的路径一字不动）",
  );
  ok(
    PRELOAD.indexOf("appsRootPick: (kind, opts)") >= 0 &&
      PRELOAD.indexOf("appsRootSet: (opts)") >= 0 &&
      STORE.indexOf('ipcMain.handle("apps:rootSet"') >= 0 &&
      STORE.indexOf('ipcMain.handle("apps:rootPick"') >= 0,
    "两条桥本轮恢复注册（preload + 主进程），语义见 apps-store 的 setRootAndMaybeMove",
  );
}

/* ═══════════ [4] 开发页：顶栏移除 / 预览栏六枚 / 左栏底部 ═══════════ */
section("4 开发页结构");
{
  ok(
    DEVJS.indexOf('top.className = "apps-dev-top";') >= 0 &&
      DEVJS.indexOf("top.appendChild(appsCreateAppBtnEl())") >= 0 &&
      DEVJS.indexOf("apps-dev-head") < 0 &&
      DEVJS.indexOf("apps-dev-topbar") < 0,
    "顶栏整体移除：那一行只剩左上角一枚「新建应用」",
  );
  ok(
    DEVJS.indexOf("function appsDevNewSessionBtnEl()") >= 0 &&
      DEVJS.indexOf('btn.textContent = "＋ " + appsDevT("新会话")') >= 0 &&
      DEVJS.indexOf("if (cur) sideFoot.appendChild(appsDevNewSessionBtnEl());") >= 0,
    "左栏底部：原来是「＋ 新建应用」，本轮改成「＋ 新会话」（没有应用时不摆）",
  );
  ok(
    DEVJS.indexOf('addSlot(1, appsDevRunBtnEl())') >= 0 &&
      DEVJS.indexOf('addSlot(2, appsDevFolderBtnEl(), "应用文件夹")') >= 0 &&
      DEVJS.indexOf('addSlot(3, appsDevPublishBtnEl())') >= 0 &&
      DEVJS.indexOf('addSlot(4, appsIcoTextBtnEl("refresh", "刷新"') >= 0 &&
      /addSlot\(\s*5,/.test(DEVJS) &&
      /addSlot\(\s*6,/.test(DEVJS),
    "预览栏六枚按 pri 组装：📂(2) · 启动(1) · 上架(3) · 刷新(4) · 应用设置(5) · 画布(6)",
  );
  ok(
    DEVJS.indexOf("function appsDevFolderRowEl()") < 0 &&
      DEVJS.indexOf("apps-dev-folderpath") < 0 &&
      CSS.indexOf(".apps-dev-folderrow") < 0 &&
      /appsIcoBtnEl\(\s*"folder",/.test(DEVJS),
    "「📂 + 路径 + 启动 + 上架」那一行整体下线；📂 只留一枚图标（不带路径）进预览栏",
  );
  ok(
    DEVJS.indexOf("function appsDevFitColHeadDo()") >= 0 &&
      DEVJS.indexOf("if (!head.clientWidth) return;") >= 0 &&
      DEVJS.indexOf("pop.appendChild(s)") >= 0 &&
      DEVJS.indexOf("appsDevStartColHeadWatch(viewHead)") >= 0 &&
      CSS.indexOf(".apps-dev-colhead-wrap {") >= 0,
    "窄窗：放不下的收进「更多 ▾」（面板挂在列头条外面的壳上，不被 overflow:hidden 裁）",
  );
  ok(
    DEVJS.indexOf("appsDevPaintPreviewStat") < 0 &&
      DEVJS.indexOf("DEVD.statEl") < 0 &&
      DEVJS.indexOf("function appsDevStatSnapText") < 0 &&
      DEVJS.indexOf("function appsDevStatBridgeText") < 0 &&
      CSS.indexOf(".apps-dev-stat") < 0,
    "预览条那串状态文字整体移除（JS 与 CSS 都不留残件）",
  );
  ok(
    DEVJS.indexOf("middle text") < 0 &&
      DEVJS.indexOf("appsDevFitHead") < 0 &&
      DEVJS.indexOf("DEVD.headSlots") < 0 &&
      DEVJS.indexOf("DEVD_STAT_MIN") < 0,
    "旧工具栏那套收窄 / 状态文字门槛也一并删除（不留死代码）",
  );
}

/* ═══════════ [5] 两枚开关的下场：先拷问需求 / 维持状态 ═══════════ */
section("5 两枚开关");
{
  ok(
    DEVJS.indexOf("mkSwitch(") < 0 &&
      DEVJS.indexOf("apps-dev-sw\"") < 0 &&
      DEVJS.indexOf("DEVD.grillEl") < 0 &&
      DEVJS.indexOf("function appsDevGrillOn()") >= 0,
    "开发页那一行里的两枚开关都撤了（devGrill 能力仍在：画布「开发」对话框里改）",
  );
  ok(
    DEVJS.indexOf("function appsDevKeepStateOn()") >= 0 &&
      DEVJS.indexOf("S.config.appsDevKeepState === false") >= 0 &&
      DEVJS.indexOf("function appsDevKeepStateSet(on)") >= 0 &&
      DEVJS.indexOf("window.api.configSave(S.config)") >= 0,
    "「维持状态」真源改成全局配置 appDevKeepState（缺省开，落盘记住）",
  );
  ok(
    DEVJS.indexOf("appsDevKeepStateOn() && frame.getAttribute(\"src\")") >= 0 &&
      DEVJS.indexOf("if (!id || !appsDevKeepStateOn() || !state) return;") >= 0,
    "两个真正用它读的地方（重载前存状态 / 跨应用状态表）都当场读配置",
  );
  const appWin = APPS.slice(
    APPS.indexOf("async function appsAppSettingsOpen("),
    APPS.indexOf("/* 设置窗里的小标题 + 一句说明"),
  );
  /* 本轮需求：这一枚在「应用设置」窗里**整节删掉**，新家 = 齿轮那只目录设置窗末尾的
     「预览」一节（见下面 dirWin 那一段断言）。 */
  ok(
    /appsSetSection\(\s*"维持状态"/.test(appWin) === false &&
      appWin.indexOf("appsDevKeepStateOn()") < 0 &&
      appWin.indexOf("appsDevKeepStateSet(on)") < 0 &&
      appWin.indexOf("apps-dev-sw apps-set-sw") < 0,
    "「维持状态」**不再住**「应用设置」窗（整节删除，不留半截）",
  );
  const dirWin2 = APPS.slice(
    APPS.indexOf("async function appsDirSettingsOpen("),
    APPS.indexOf("async function appsAppSettingsOpen("),
  );
  ok(
    /appsSetSection\(\s*"预览"/.test(dirWin2) &&
      dirWin2.indexOf("appsDevKeepStateOn()") >= 0 &&
      dirWin2.indexOf("appsDevKeepStateSet(on)") >= 0 &&
      dirWin2.indexOf("apps-dev-sw apps-set-sw") >= 0,
    "「维持状态」搬进「目录设置」窗的「预览」一节（勾选即写盘 + 一句回执）",
  );
  ok(CSS.indexOf(".apps-set-sw {") >= 0, "那一枚复选有样式（.apps-set-sw）");
}

/* ═══════════ [6] 词条 / 图标 ═══════════ */
section("6 词条与图标");
{
  const keys = [
    "改开发目录：给「自己开发的应用」换一个根目录（可顺带把旧目录里的应用搬过去）",
    "改库目录：给「从云端下载的应用」换一个根目录（可顺带把旧目录里的应用搬过去）",
    "旧目录里有 ",
    " 个这一类的应用：改完根目录后要把它们一起搬过去吗？",
    "旧目录里没有这一类的应用：直接选新文件夹即可。",
    "一起搬过去",
    "留在原处",
    "选新文件夹…",
    "已改到：",
    "已搬过去 ",
    " 个应用：",
    "没有需要搬动的应用（旧目录里没有这一类的应用）",
    "只改了根目录：旧目录里的应用留在原处，不再列出来",
    "跳过 ",
    " 个（原样留在旧目录）：",
    "修改失败：",
    "宿主桥未就绪：这次没能修改目录",
    "目录已改到：",
    "刷新预览时记住页面状态（滚动位置与表单内容）",
    "已开启：刷新预览时记住页面状态（滚动位置与表单内容）",
    "已关闭：刷新预览不再记住页面状态",
    "本机还没有「开发中」的应用：在「库」页点「二次开发」，或点左上角的「＋ 新建应用」。",
  ];
  for (const k of keys) ok(I18N.indexOf('"' + k + '":') >= 0, "英文词条：" + k);
  ok(
    I18N.indexOf('"新会话": "New session"') >= 0 &&
      I18N.indexOf('"上架": "Publish"') >= 0 &&
      I18N.indexOf('"应用文件夹": "App folder"') >= 0,
    "复用词的英文译文齐备（新会话 / 上架 / 应用文件夹）",
  );
  ok(
    APPS.indexOf("folder:") >= 0 && APPS.indexOf("upload:") >= 0 && APPS.indexOf("canvas:") >= 0,
    "图标表里 folder（📂）与 upload（上架）两枚新图标在册（内联 SVG）",
  );
  ok(
    I18N.indexOf('"📂 应用文件夹":') < 0 && I18N.indexOf('"打开应用文件夹":') < 0,
    "旧 📂 按钮那两条死词条已清（按钮本身已换成图标按钮）",
  );
}

/* ═══════════ [7] 样式表自检（本轮真机自验抓到的坑） ═══════════
 * 现场：删掉旧工具栏那批规则时，`renderer/css/apps.css` 里留下了一个**没有内容的选择器**；
 * CSS 解析器把后面整块规则吞进它里面 —— 于是 `.apps-dev-colhead` 的 display:flex 失效
 * （计算值变 block），预览栏六枚按钮每一枚都被算成整行宽，收窄逻辑把六枚全判成「放不下」。
 * **冒烟当时是绿的**（它们只按字面量扫源码），起真机实例读 DOM 才发现。所以补两条静态自检：
 *   ① 花括号必须配平（末尾深度 0）；② `.apps-dev-colhead` 那条规则必须真的写着 display: flex。 */
section("7 样式表自检（花括号配平 + 列头条仍是 flex）");
{
  const cssText = read("renderer/css/apps.css");
  let depth = 0;
  let negative = false;
  for (const c of cssText) {
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth < 0) negative = true;
    }
  }
  ok(depth === 0 && !negative, "apps.css 花括号配平（没有把后面的规则吞进一个没写完的选择器）");
  const colhead = cssText.slice(
    cssText.indexOf(".apps-dev-colhead {"),
    cssText.indexOf(".apps-dev-q {"),
  );
  ok(
    colhead.indexOf("display: flex") >= 0 && colhead.indexOf("overflow: hidden") >= 0,
    "`.apps-dev-colhead` 仍是 display:flex 的一行（六枚按钮按内容宽排，不是各占整行）",
  );
  ok(
    cssText.indexOf(".apps-dev-head {") < 0 &&
      cssText.indexOf(".apps-dev-topbar {") < 0 &&
      cssText.indexOf(".apps-dev-head-k {") < 0,
    "旧工具栏那几条规则（.apps-dev-head / .apps-dev-topbar / .apps-dev-head-k）都删干净了",
  );
}

console.log("\n" + (fails ? "FAILED " + fails + "/" + checks : "ALL PASS " + checks + " 项"));
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch (_) {}
process.exit(fails ? 1 : 0);
