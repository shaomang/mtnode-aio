"use strict";
/* test/smoke-apps-dev-workspace.js — 渲染层回归
 *   ① 应用开发页不再出现「下载根」（顶栏 chip + 左导航页脚两个地方）；
 *   ② **不再要求用户手选应用根目录**（本轮需求）：下载 / 新建前的强制选目录弹框、开发页
 *      「未设置」红字、项目根一键恢复那一行**全部删除**，默认根由主进程固化；
 *   ③ 点左栏应用条目 → 底部会话对话框的「工作区」跟着切到该应用目录（含首轮态），
 *      会话里工作区为空 / 已失效时回填，用户自己填的目录保留。
 *
 * 口径：源码断言钉「接线点没被改掉」，vm 真跑钉「判定真的这么走」（切出函数原样执行，
 * 不抄一份逻辑）。零依赖、不启动 Electron、不碰真实 %APPDATA%。
 *
 * 运行：node test/smoke-apps-dev-workspace.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

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

/* 从源码里原样切出一个函数（按大括号配平；字符串与模板串里的括号不算）。
   async 前缀一起带上 —— 少了它 vm 里一遇 await 就 SyntaxError。 */
function pickFn(src, name) {
  let i = src.indexOf("function " + name + "(");
  if (i < 0) throw new Error("切不出函数：" + name);
  if (src.slice(Math.max(0, i - 6), i) === "async ") i -= 6;
  let depth = 0;
  let str = "";
  let started = false;
  for (let k = i; k < src.length; k++) {
    const c = src[k];
    if (str) {
      if (c === "\\") {
        k++;
        continue;
      }
      if (c === str) str = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      str = c;
      continue;
    }
    if (c === "{") {
      depth++;
      started = true;
      continue;
    }
    if (c === "}") {
      depth--;
      if (started && depth === 0) return src.slice(i, k + 1);
    }
  }
  throw new Error("括起来没配平：" + name);
}

const APPS = read("renderer/app-apps.js");
const DEV = read("renderer/app-apps-dev.js");
const ASSIST = read("renderer/app-assist.js");
const I18N = read("renderer/i18n.js");
const CSS = read("renderer/css/apps.css");
const PRELOAD = read("preload.js");
const STORE = read("apps-store.js");

console.log("smoke-apps-dev-workspace：开发页不出现下载根 + 不再要求手选根目录 + 会话目录跟着应用走\n");

/* ═══════════ [1] 需求一：开发页两处都不出现「下载根」 ═══════════ */
section("1 开发页不再出现下载根（本轮：连项目根那一块也收进设置窗了）");
{
  /* 本轮需求（用户口径：「移除项目根等内容，统一放进右上角那只设置按钮」）：
     开发页工具栏上的 appsDevRootItem / appsDevRootChip 整块删除，路径只在设置窗里只读显示。 */
  ok(DEV.indexOf("function appsDevRootItem(") < 0, "工具栏不再有「项目根」那一块（appsDevRootItem 已删）");
  ok(DEV.indexOf("function appsDevRootChip(") < 0, "chip 本体（appsDevRootChip）也一起删了");
  ok(DEV.indexOf('appsDevRootChip("down")') < 0, "整个开发页模块里没有下载根 chip 的调用点");
  ok(DEV.indexOf('addSlot(5, appsDevRootItem(), "项目根")') < 0, "「更多 ▾」面板里那一项也跟着没了");
  ok(
    APPS.indexOf('["down", "库目录') >= 0 &&
      APPS.indexOf('["dev", "开发目录') >= 0 &&
      APPS.indexOf("function appsRootAppsOfKind(kind)") >= 0,
    "两套根的路径只在设置窗里（库目录 / 开发目录各一行，本轮起每行「修改 + 打开」）",
  );
  /* 左导航页脚（本轮需求：整块清空 —— 项目根那一行也随「移除项目根等内容」下线） */
  const navFn = pickFn(APPS, "appsHubPaintNav");
  ok(navFn.indexOf("下载根目录（从应用中心下载的）") < 0, "页脚不再画下载根那一行");
  ok(navFn.indexOf('appsT("已下载 ") + count') < 0, "页脚不再画「已下载 N 个应用」条数行");
  ok(navFn.indexOf('appsT("开发中 ") + count') < 0, "页脚不再画「开发中 N 个应用」条数行");
  ok(navFn.indexOf("apps-hub-footdim") < 0, "页脚不再挂条数行的 apps-hub-footdim 那一行");
  ok(navFn.indexOf('appsT("项目根目录（开发中的应用）")') < 0, "页脚的项目根那一行也下线（路径只在设置窗里）");
  ok(/foot\.innerHTML = "";/.test(navFn), "页脚整块清空（容器留着，避免左栏底部跳动）");
}

/* ═══════════ [2] 需求二：不再要求手选根目录（强制弹框 / 红字 / 恢复行全删） ═══════════ */
section("2 不再要求手选根目录（本轮需求）");
{
  const FLOW = read("renderer/app-app-flow.js");
  /* ① 下载 / 新建前的强制选目录弹框：整条删除（连它的函数一起） */
  ok(APPS.indexOf("function appsEnsureRoot(") < 0, "appsEnsureRoot（下载前弹系统选目录框）整条删除");
  ok(APPS.indexOf("appsEnsureRoot(") < 0, "下载路径里不再有这道前置");
  ok(FLOW.indexOf("appsEnsureRoot") < 0, "新建应用的路径里也不再调它");
  ok(
    APPS.indexOf("还没指定应用根目录：下载前要先选一个文件夹") < 0,
    "「下载前要先选一个文件夹」这套话术也不留",
  );
  /* ② 开发页「未设置」红字 + 项目根一键恢复那一行：整条删除 */
  ok(DEV.indexOf("apps-badge-bad") < 0, "开发页不再打「未设置」红字 badge");
  ok(APPS.indexOf("function appsDevRootRecoverEl(") < 0, "一键恢复行（appsDevRootRecoverEl）整条删除");
  ok(APPS.indexOf("appsRootSetNow") < 0, "跟着它一起用的 appsRootSetNow 也删了");
  ok(
    APPS.slice(APPS.indexOf("async function appsPaintLibPage(")).indexOf("appsDevRootRecoverEl") < 0,
    "库页正文里不再挂恢复行",
  );
  ok(
    DEV.slice(DEV.indexOf("if (!cur) {")).indexOf("appsDevRootRecoverEl") < 0,
    "开发页左栏空态里也不再挂它",
  );
  /* ③ 主进程一侧：候选推断（suggestDevRoot）与它的 IPC / 桥一起下线，改由默认根固化接管 */
  ok(STORE.indexOf("apps:devRootSuggest") < 0, "apps-store 不再注册 apps:devRootSuggest");
  ok(/\n  suggestDevRoot,/.test(STORE) === false, "suggestDevRoot 不再挂进模块导出");
  ok(PRELOAD.indexOf("appsDevRootSuggest") < 0, "preload 不再暴露 appsDevRootSuggest");
  ok(/\n  ensureRootPersisted,/.test(STORE), "ensureRootPersisted（默认根固化）挂进模块导出");
  const listFn = pickFn(STORE, "listApps");
  ok(
    /for \(const k of APP_KINDS\) ensureRootPersisted\(k\);/.test(listFn),
    "listApps（库页 / 开发页列应用）第一次就固化两套根",
  );
  ok(
    /ensureRootPersisted\(APP_KIND_DOWN\)/.test(pickFn(STORE, "installApp")),
    "installApp（下载 / 更新 / 回滚）用默认根并固化",
  );
  ok(
    /ensureRootPersisted\(APP_KIND_DEV\)\.root/.test(pickFn(STORE, "createApp")),
    "createApp（新建应用）用默认根并固化",
  );
  /* ④ 保留下来的人工入口（**本轮恢复**：用户口径「目录设置无法更改，右侧需要有两个按钮，
      一个是修改，一个是打开」）——换根只在右上角齿轮的目录设置窗里，走
      appsRootChange → api.appsRootPick（系统选目录框）+ 按需搬迁。库页那枚「应用目录」按钮与
      它的小菜单**仍然没有**（本轮没把它加回来：入口只在设置窗里）。 */
  ok(
    APPS.indexOf("async function appsRootPickNow(kind)") < 0 &&
      APPS.indexOf("function appsRootFolderNow(kind)") < 0 &&
      APPS.indexOf("function appsRootMenuToggle()") < 0,
    "库页那套「更改目录…」动作函数与小菜单仍是删掉的（换根入口只在目录设置窗里）",
  );
  ok(
    APPS.indexOf('appsIcoBtnEl("folder"') < 0 &&
      PRELOAD.indexOf("appsRootPick:") >= 0 &&
      PRELOAD.indexOf("appsRootSet:") >= 0 &&
      STORE.indexOf('ipcMain.handle("apps:rootSet"') >= 0 &&
      STORE.indexOf('ipcMain.handle("apps:rootPick"') >= 0,
    "壳上那枚「应用目录」按钮仍没有；preload 与主进程的 appsRootPick / appsRootSet 两条桥本轮恢复（目录设置窗的「修改」）",
  );
  ok(
    APPS.indexOf("async function appsRootChange(kind, moveApps)") >= 0 &&
      APPS.indexOf("function appsRootResultEl(last)") >= 0 &&
      APPS.indexOf("APPS_ROOT_LAST") >= 0,
    "目录设置窗的「修改」= appsRootChange（选目录 → 换根 → 按需搬迁 → 回执 + 重开窗）",
  );
  ok(
    STORE.indexOf("function moveAppsToRoot(fromRoot, toRoot, kind)") >= 0 &&
      STORE.indexOf("function setRootAndMaybeMove(arg)") >= 0 &&
      STORE.indexOf("if (kindOfManifest(raw, src) !== k) continue;") >= 0 &&
      STORE.indexOf("新目录里已经有一个同名应用文件夹：不覆盖，这一份原样留在旧目录") >= 0,
    "主进程搬迁口径：只搬这一行那一类、认不出的目录不动、同名跳过不覆盖（moveAppsToRoot）",
  );
  ok(
    FLOW.indexOf("async function appsRootHealAfterMove(moved)") >= 0 &&
      FLOW.indexOf("async function appCanvasPathHealById(appId, appDir)") >= 0 &&
      FLOW.indexOf("appCanvasPathHeal(wf, dir)") >= 0,
    "搬完自动校准路径：应用画布的 devPath / 工作目录（复用 appCanvasPathHeal）+ 会话工作区",
  );
  ok(DEV.indexOf("appsDevRootChip(") < 0, "开发页那一行根目录 chip 也不再有");
  /* ⑤ 根目录回执同步进 S.config（双保险的另一半）—— 手改入口撤了，但这条同步仍要在：
     它守住的是「主进程已固化的根别被渲染层整份回写盖掉」（老机器的自定义根仍生效）。 */
  ok(APPS.indexOf("function appsRootsSyncConfig(roots)") >= 0, "渲染层有 roots → S.config.apps 的同步函数");
  /* 同步点跟着「本机列表收下」那一步走（本轮把收下逻辑收口到 appsListAccept：轻表与完整那一趟
     共用同一处，roots 也在那里对齐）。断言口径不变：拿到清单就必须同步，重启后也能自愈内存副本。 */
  ok(
    /function appsListAccept\(r\)[\s\S]{0,900}if \(r\.roots\) appsRootsSyncConfig\(r\.roots\);/.test(APPS),
    "本机列表一收下就同步 roots（appsListAccept 是轻表与完整那一趟的共同出口）",
  );
  const syncFn = pickFn(APPS, "appsRootsSyncConfig");
  ok(/if \(!r\.configured\) continue;/.test(syncFn),
    "只写「已配置」的那一套键（configured=true 现在只可能来自主进程已固化 / 老机器的自定义根）");
  /* 迁移旧布局**整条功能已移除**（本轮用户口径：移除「迁移旧布局」按钮与功能）：
     跟着它一起删掉的还有「搬完把旧路径改指新目录」那套改写（appsRewriteMovedAppPaths）。 */
  ok(
    APPS.indexOf("async function appsRewriteMovedAppPaths(moves)") < 0 &&
      APPS.indexOf("async function appsMigrateLayoutNow") < 0,
    "「迁移旧布局」的功能代码已整条删除（按钮与改写逻辑一起走）",
  );
}

/* ═══════════ [3] 需求三：开发页首轮态芯片 / 三处触发 / 判据 ═══════════ */
section("3 会话目录跟着应用走");
{
  ok(ASSIST.indexOf("function agentViewBlankWorkspaceSet(dir)") >= 0,
    "app-assist.js 给首轮态（占位空会话）留了工作区写入点");
  const blankFn = pickFn(ASSIST, "agentViewBlankWorkspaceSet");
  ok(blankFn.indexOf("st._appDirWorkspace = true;") >= 0, "标出「这份目录是跟着应用来的」");
  ok(ASSIST.indexOf('if (src === "app") return I18n.t("所属应用的目录（开发页）");') >= 0,
    "工作区来源标签认这个来源（悬浮说明不写成「手填指定」）");
  ok(/_appDirWorkspace/.test(pickFn(ASSIST, "agentWorkspaceInfo")), "生效工作区解析认得它");
  /* 首轮态渲染时写进去 */
  ok(/agentViewBlankWorkspaceSet\(appsDevProjectDir\(\)\)/.test(DEV), "首轮态渲染时把应用目录写进占位会话");
  /* 三处触发 */
  ok(DEV.indexOf("async function appsDevAlignAppWorkspace(appId)") >= 0, "对齐函数存在");
  ok(/appsDevAlignAppWorkspace\(cur\)\.catch\(\(\) => \{\}\);/.test(DEV), "① 打开开发页时对齐");
  ok(/appsDevAlignAppWorkspace\(id\)\.catch\(\(\) => \{\}\);/.test(DEV), "② 点左栏应用条目 / 切到该应用时对齐");
  const tickFn = pickFn(DEV, "appsDevTick");
  ok(/appsDevAlignAppWorkspace\(DEVD\.appId\)\.catch\(\(\) => \{\}\);/.test(tickFn),
    "③ 每轮 tick 兜底（开轮前一定核过；运行中的会话不动）");
  const sendFn = pickFn(DEV, "appsDevComposerSend");
  ok(/st\.workspace = dir;/.test(sendFn), "非首轮态发送前补一道「空 → 应用目录」");
  const alignFn = pickFn(DEV, "appsDevAlignAppWorkspace");
  ok(/if \(!st \|\| appsDevSessionRunning\(st\)\) continue;/.test(alignFn), "运行中的会话不动");
  ok(/isDir = !!\(await window\.api\.fileIsDir\(cur\)\);/.test(alignFn), "「填过但目录没了」靠主进程判存在性");
  ok(/if \(isDir\) continue;/.test(alignFn), "目录还在（用户自己选的）一个字不动");
  ok(alignFn.indexOf("st.workspace = dir;") >= 0 && /persistAgentSession\(\)/.test(alignFn),
    "回填写进会话的 workspace 并落盘");
  ok(/renderAgentComposer\(\)/.test(alignFn), "回填后立刻刷底部那颗芯片");
}

/* ═══════════ [4] vm 真跑：appsSamePath / 会话对齐 ═══════════ */
(async () => {
  section("4 vm 真跑（真代码，不是抄一份）");
  {
    /* 4.1 appsSamePath：Windows 盘上同一个目录的两种写法算同一个
       （迁移改写那一套已随「迁移旧布局」整条删除，所以这里只剩路径比较与会话对齐两段） */
    const sb0 = { console: console };
    sb0.window = sb0;
    vm.createContext(sb0);
    vm.runInContext(pickFn(APPS, "appsSamePath"), sb0);
    const same = (a, b) => vm.runInContext("appsSamePath", sb0)(a, b);
    ok(same("E:\\Apps\\dev\\x", "e:/apps/dev/x/") === true, "大小写 + 分隔符 + 尾斜杠都不敏感");
    ok(same("E:\\apps\\dev\\x", "E:\\apps\\dev\\y") === false, "不同目录不等");
    ok(same("", "E:\\apps") === false, "空值不算相等（不会把「没填」当命中）");

    const OTHER = path.join("E:", "work", "elsewhere");

    /* 4.2（原「迁移改写」用例随功能一起删除） */

    /* 4.3 会话工作区对齐：空 / 已失效 → 回填；存在的 / 运行中的 → 不动 */
    const APP_DIR = path.join("E:", "apps", "dev", "appA");
    const ast1 = { id: "a1", appId: "appA", workspace: "" };
    const ast2 = { id: "a2", appId: "appA", workspace: path.join("E:", "apps", "test", "appA") };
    const ast3 = { id: "a3", appId: "appA", workspace: OTHER };
    const ast4 = { id: "a4", appId: "appA", workspace: "", running: true };
    let saved = 0;
    let composer = 0;
    const sb2 = {
      console: console,
      DEVD: { appId: "appA" },
      appsLocalById: () => ({ id: "appA", dir: APP_DIR, dev: true }),
      appSessionsOf: () => [ast1, ast2, ast3, ast4],
      persistAgentSession: async () => {
        saved++;
      },
      renderAgentComposer: () => {
        composer++;
      },
    };
    sb2.window = {
      api: {
        fileIsDir: async (p) => String(p) === OTHER,
      },
    };
    vm.createContext(sb2);
    vm.runInContext(
      pickFn(APPS, "appsSamePath") +
        "\n" +
        pickFn(DEV, "appsDevProjectDir") +
        "\n" +
        pickFn(DEV, "appsDevSessionRunning") +
        "\n" +
        pickFn(DEV, "appsDevAlignAppWorkspace"),
      sb2,
    );
    const n = await vm.runInContext("appsDevAlignAppWorkspace", sb2)("appA");
    ok(n === 2, "改了 2 条（空值那条 + 目录已失效那条），实得 " + n);
    ok(ast1.workspace === APP_DIR, "没填过工作区 → 回填成该应用目录");
    ok(ast2.workspace === APP_DIR, "旧目录已经不存在 → 改写成本应用目录");
    ok(ast3.workspace === OTHER, "填过且目录还在（用户自己选的）→ 一个字不动");
    ok(ast4.workspace === "" && ast4.running === true, "运行中的会话不动（开轮时锁定的工作区不漂）");
    ok(saved === 1 && composer === 1, "落盘一次 + 立刻刷芯片一次");
    /* 再跑一遍：同一个应用目录已经命中，不再重复写 */
    const n2 = await vm.runInContext("appsDevAlignAppWorkspace", sb2)("appA");
    ok(n2 === 0 && saved === 1, "已经是应用目录 → 第二次不再改写（幂等）");
  }

  /* ═══════════ [4b] 二次开发 = 复制到开发目录 + 归页只看物理目录 ═══════════ */
  section("4b 二次开发改成「复制到开发目录」（旧：搬动库目录那一份）");
  {
    const FLOW6 = read("renderer/app-app-flow.js");
    const APPS6 = read("renderer/app-apps.js");
    /* ① 二次开发本轮从「搬到项目根」改成**复制到开发目录**（用户共识）：执行体是
          appsCopyToDevRun（导出 window.appsCopyToDevRun），底下调主进程 apps:copyToDev。
          老的搬移链（appsMigrateLayout + dryRun:false + 「搬完之后真的在盘上」复查 + appDirNow）
          必须连根拔掉 —— 留着任何一处，用户看到的就还是「库目录那一份被搬走了」。 */
    ok(
      /async function appsCopyToDevRun\(appId, opts\)/.test(FLOW6) &&
        /window\.appsCopyToDevRun = appsCopyToDevRun/.test(FLOW6) &&
        FLOW6.indexOf('await api.appsCopyToDev(id, o.mode === "overwrite" ? { mode: "overwrite" } : {})') >= 0,
      "二次开发调主进程 appsCopyToDev（复制一份到开发目录；覆盖 = 带 {mode:\"overwrite\"} 再调一次）",
    );
    ok(
      FLOW6.indexOf("appsMigrateToDev") < 0 &&
        FLOW6.indexOf("appsMigrateLayout") < 0 &&
        FLOW6.indexOf("dryRun") < 0 &&
        FLOW6.indexOf("appDirNow") < 0,
      "旧搬移链一条都不留（appsMigrateToDev / appsMigrateLayout / dryRun / appDirNow）—— 拦「又回到搬动库目录那一份」的回归",
    );
    /* 目标已存在时这条链不问也不覆盖：主进程回 code:"exists"（一个字节都不动），
       由渲染层（app-apps.js 的 appsSecondaryDevRun）弹「覆盖 / 交给 AI 合并」二选一。 */
    ok(
      /if \(r && String\(r\.code \|\| ""\) === "exists"\) return \{ exists: true, id: id \};/.test(FLOW6) &&
        APPS6.indexOf("await appsSecondaryDevChoice(appId, { name: name, canMerge: !!ownerId });") >= 0 &&
        APPS6.indexOf('await window.appsCopyToDevRun(appId, { mode: "overwrite" });') >= 0 &&
        /appsMergeStart\(\s*appId,\s*ownerId,\s*version,\s*[\s\S]{0,120}?"agent",\s*\)/.test(APPS6),
      "开发目录里已有同 id → 主进程如实回 exists，渲染层才问「覆盖（带 mode:overwrite 再调一次）/ 交给 AI 合并」（这条链自己绝不覆盖）",
    );
    /* 画布：有同名画布就复用（改 devPath / subFolder、不新增节点），没有才建 ——
       这条链真要跑起来得有一整条画布链现场，所以这里钉接线形状（行为口径见 smoke-apps.js 同一组断言） */
    ok(
      /if \(nodeBefore\) \{[\s\S]{0,400}?nodeBefore\.devPath = dir;[\s\S]{0,400}?nodeBefore\.subFolder = dir;/.test(FLOW6) &&
        /if \(fresh\) \{[\s\S]{0,700}?appsCreateDevNode\(\{/.test(FLOW6) &&
        FLOW6.indexOf("reused: !fresh") >= 0,
      "有同名画布 → 复用（只把已有开发节点的 devPath / subFolder 改指新的开发文件夹）；没有才 appCanvasWf + appsCreateDevNode",
    );

    /* ② 归页判据（本轮口径 · 用户共识）= **物理目录**：listKind（主进程标出的「扫到它的那一套根」）
          优先，其次 kind，最后才 dev 标记。vm 真跑真代码。
          「app.json 已 dev:true 却还躺在下载根」的那条旧预期**已翻转**：现在它算「库」——
          库页按下载根解析目录，把它列进开发页反而会让「打开数据目录 / 更新」全找不到人。 */
    const sb3 = { console: console };
    sb3.window = sb3;
    vm.createContext(sb3);
    vm.runInContext(pickFn(APPS, "appsLocalRootKind"), sb3);
    const rk = (a) => vm.runInContext("appsLocalRootKind", sb3)(a);
    ok(rk(null) === "", "空值回空串（不给假判定）");
    ok(
      rk({ id: "x", kind: "dev", listKind: "down", dev: true, kindMismatch: true }) === "down",
      "★ 清单 dev:true 却躺在**下载根**（listKind=down）→ 算「库」：归页只看物理目录，不看 app.json 的 dev 标记",
    );
    ok(
      rk({ listKind: "dev", kind: "down", dev: false }) === "dev",
      "★ 躺在**项目根**（listKind=dev）→ 算「开发中应用」，哪怕 kind / dev 都说 down",
    );
    ok(
      rk({ listKind: "down", kind: "dev", dev: true }) === "down",
      "★ 反方向也要拦住：listKind=down + kind=dev + dev:true → 仍算「库」（listKind 优先，两边都认同一件事）",
    );
    ok(rk({ kind: "down", listKind: "down", dev: false }) === "down", "正常下载的仍在「库」页");
    ok(rk({ kind: "dev", listKind: "dev", dev: true }) === "dev", "正常开发的仍在「开发」页");
    ok(
      rk({ kind: "down", listKind: "dev", dev: false }) === "dev",
      "躺在项目根、清单却写 dev:false → 也算开发页那份（否则库页按 down 解析目录会报「不在本机」）",
    );
    /* listKind 缺失（老主进程 / 老缓存）→ 退回 kind（仲裁后的身份） */
    ok(
      rk({ kind: "dev", dev: false }) === "dev" && rk({ kind: "down", dev: true }) === "down",
      "没有 listKind 时退回 kind（两层兜底里的第一层，比 dev 标记更可信）",
    );
    /* 连 kind 都没有（最老的缓存）→ 才按 dev 标记回落；都没有就当下载根 */
    ok(
      rk({ dev: true }) === "dev" && rk({ dev: false }) === "down" && rk({}) === "down",
      "kind / listKind 都缺时才按 dev 标记回落（都没有 = 当下载根），绝不把应用漏列",
    );
    ok(
      rk({ listKind: "别的值", kind: "dev" }) === "dev",
      "listKind 只认 down / dev 两个值：写别的（脏数据 / 未来的新根）一律不当判据，落回 kind",
    );

    /* ③ 画布路径自愈（q4）：空值补写 + 指向已不存在的目录 → 校准成应用目录；用户填过且目录还在的不动 */
    const APP_DIR = path.join("E:", "apps", "dev", "appA");
    const OTHER = path.join("E:", "work", "elsewhere");
    const GONE = path.join("E:", "apps", "dev", "appA-moved-away");
    const alive = new Set([APP_DIR, OTHER].map((p) => String(p).toLowerCase()));
    let probeThrows = false;
    const sb4 = { console: console };
    sb4.window = {
      api: {
        fileIsDir: async (p) => {
          if (probeThrows) throw new Error("bridge down");
          return alive.has(String(p || "").toLowerCase());
        },
      },
    };
    sb4.appsDevNodeOfWf = (wf) => (wf.nodes || []).find((n) => n && n.dev) || null;
    vm.createContext(sb4);
    vm.runInContext(pickFn(FLOW6, "appCanvasPathHeal"), sb4);
    const heal = (wf, dir) => vm.runInContext("appCanvasPathHeal", sb4)(wf, dir);
    /* 3.1 bug 现场：workspace 与 devPath / subFolder 都是「搬家的目标目录」（不存在） */
    const wf1 = {
      workspace: GONE,
      nodes: [{ kind: "super", dev: true, devPath: GONE, subFolder: GONE, note: "x" }],
    };
    const h1 = await heal(wf1, APP_DIR);
    ok(h1.workspace === true && wf1.workspace === APP_DIR, "workspace 指向不存在的目录 → 校准成应用目录");
    ok(
      h1.node === true &&
        wf1.nodes[0].devPath === APP_DIR &&
        wf1.nodes[0].subFolder === APP_DIR,
      "开发节点 devPath / subFolder 同一处病灶一起校准",
    );
    ok(wf1.nodes[0].note === "x", "节点其它配置一字不动");
    /* 3.2 空 workspace（老画布）：补写 */
    const wf2 = { workspace: "", nodes: [{ dev: true, devPath: APP_DIR, subFolder: APP_DIR }] };
    const h2 = await heal(wf2, APP_DIR);
    ok(h2.workspace === true && wf2.workspace === APP_DIR, "空工作目录补写（老画布那条口径不变）");
    ok(h2.node === false, "节点路径已对 → 一个字节不动");
    /* 3.3 用户自己填过、目录还在：不动 */
    const wf3 = { workspace: OTHER, nodes: [{ dev: true, devPath: OTHER, subFolder: OTHER }] };
    const h3 = await heal(wf3, APP_DIR);
    ok(
      h3.workspace === false && h3.node === false && wf3.workspace === OTHER,
      "填过且目录还在（用户自己选的）→ 一个字不动",
    );
    /* 3.4 应用目录本身不在盘上：什么也不做（绝不往画布上留一个不存在的路径） */
    const wf4 = { workspace: "", nodes: [{ dev: true, devPath: GONE, subFolder: GONE }] };
    const h4 = await heal(wf4, path.join("E:", "apps", "dev", "not-there"));
    ok(h4.workspace === false && h4.node === false && wf4.workspace === "", "应用目录不在盘上 → 原样不动");
    /* 3.5 桥探不动（老包 / 被裁剪）：一律当「没问题」，不乱改用户的画布 */
    probeThrows = true;
    const wf5 = { workspace: GONE, nodes: [{ dev: true, devPath: GONE, subFolder: GONE }] };
    const h5 = await heal(wf5, APP_DIR);
    ok(
      h5.workspace === false && h5.node === false && wf5.workspace === GONE,
      "桥抛错时不动任何字段（宁可少改一次）",
    );
    probeThrows = false;
    /* 3.6 幂等：已经是对的再跑一遍不再改写 */
    const h6 = await heal(wf1, APP_DIR);
    ok(h6.workspace === false && h6.node === false, "已经校准过 → 第二次不再改写（幂等）");
    ok(
      /appCanvasPathHeal\(S\.wf, appDir\)/.test(FLOW6) &&
        /if \(healed && \(healed\.workspace \|\| healed\.node\)\) scheduleSave\(true\);/.test(FLOW6),
      "openAppCanvas 调它并只在真改写时落盘",
    );
    ok(
      /appsLocalById\(id, "dev"\) \|\| appsLocalById\(id\)/.test(FLOW6),
      "取应用目录点「开发那一份」（还躺在下载根里的开发应用也拿得到真实目录）",
    );
  }

  /* ═══════════ [5] 词条与样式收尾 ═══════════ */
  section("5 词条 / 样式");
  {
    const keys = [
      "开发中 ",
      "所属应用的目录（开发页）",
      " 处记录已改指新目录",
      "更改…",
    ];
    for (const k of keys) ok(I18N.indexOf('"' + k + '":') >= 0, "英文词条：" + k);
    /* 随本轮需求下线的死词条 / 死样式：一个字都不该留（否则英文界面留着旧话术）。
       例外：`选择目录…` 被「插件根目录」那条需求重新用上了（插件对话框顶部那颗按钮），
       所以它不再算死词条 —— 单独在下面钉「现在确实在用」。 */
    const dead = [
      "项目根目录未配置",
      "正在查找本机的应用目录…",
      "设为项目根：",
      "未设置：开发中的应用不会列出来 —— 点右边「更改…」指定项目根",
      "未设置：下载前会先让你选一个文件夹",
      "还没指定应用根目录：下载前要先选一个文件夹",
      "请先在设置里指定应用根目录",
      "选择应用根目录失败：",
      "尚未指定应用安装根目录",
    ];
    for (const k of dead) ok(I18N.indexOf('"' + k + '":') < 0, "死词条已清：" + k);
    ok(I18N.indexOf('"选择目录…":') >= 0, "`选择目录…` 已被插件根目录那条需求重新用上（不再是死词条）");
    ok(
      read("renderer/app-plugins.js").indexOf('pickBtn.textContent = set ? I18n.t("换目录…") : I18n.t("选择目录…")') > 0,
      "`选择目录…` 真的在插件对话框顶部那颗按钮上（不是只留了个词条）",
    );
    ok(CSS.indexOf(".apps-rootline-recover") < 0, "恢复行的样式（橙色虚线告警底）跟着删了");
    ok(CSS.indexOf(".apps-badge-bad") < 0, "「未设置」红字的样式也删了");
  }

  console.log("\n" + (fails ? "FAILED " + fails + "/" + checks : "ALL PASS " + checks + " 项"));
  process.exit(fails ? 1 : 0);
})().catch((err) => {
  console.log("FAIL  用例抛错：" + ((err && err.stack) || err));
  process.exit(1);
});
