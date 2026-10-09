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
section("1 开发页不再出现下载根");
{
  const itemFn = pickFn(DEV, "appsDevRootItem");
  ok(itemFn.indexOf('appsDevRootChip("dev")') >= 0, "工具栏那一组仍给项目根一枚");
  ok(itemFn.indexOf('appsDevRootChip("down")') < 0, "工具栏那一组不再给下载根那一枚");
  ok(DEV.indexOf('appsDevRootChip("down")') < 0, "整个开发页模块里没有下载根 chip 的调用点");
  ok(
    /addSlot\(5, appsDevRootItem\(\), "项目根"\)/.test(DEV),
    "「更多 ▾」面板里那一项的标题也跟着改成「项目根」",
  );
  /* 左导航页脚（本轮需求：只留项目根那一行 —— 下载根那一行与条数行都下线） */
  const navFn = pickFn(APPS, "appsHubPaintNav");
  ok(navFn.indexOf("下载根目录（从应用中心下载的）") < 0, "页脚不再画下载根那一行");
  ok(navFn.indexOf('appsT("已下载 ") + count') < 0, "页脚不再画「已下载 N 个应用」条数行");
  ok(navFn.indexOf('appsT("开发中 ") + count') < 0, "页脚不再画「开发中 N 个应用」条数行");
  ok(navFn.indexOf("apps-hub-footdim") < 0, "页脚不再挂条数行的 apps-hub-footdim 那一行");
  ok(navFn.indexOf('appsT("项目根目录（开发中的应用）")') >= 0, "页脚保留项目根那一行（下载页 / 开发页都一样）");
  ok(APPS.indexOf('line(appsT("项目根目录（开发中的应用）"), dev)') < 0 &&
    navFn.indexOf("appsEscape(appsT(\"项目根目录（开发中的应用）\"))") >= 0,
    "项目根那一行改成内联拼（不再走只服务两套根的 line() 助手）");
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
  /* ④ 保留下来的人工入口仍是两条（想改装到别的盘的人还有路） */
  ok(
    APPS.indexOf("async function appsRootPickNow(kind)") >= 0 &&
      APPS.indexOf("function appsRootFolderNow(kind)") >= 0,
    "「更改目录…」/「在资源管理器中打开」两个动作保留（库页「应用目录」按钮 + 开发页那一行）",
  );
  ok(DEV.indexOf('appsDevRootChip("dev")') >= 0 && DEV.indexOf('appsDevRootChip("down")') < 0,
    "开发页仍只给项目根那一枚 chip");
  /* ⑤ 根目录回执同步进 S.config（双保险的另一半） */
  ok(APPS.indexOf("function appsRootsSyncConfig(roots)") >= 0, "渲染层有 roots → S.config.apps 的同步函数");
  ok(/if \(APPS_ST\.list && APPS_ST\.list\.roots\) appsRootsSyncConfig\(APPS_ST\.list\.roots\);/.test(APPS),
    "appsListLoad 拿到清单后就同步（重启后也能自愈内存副本）");
  ok(/appsRootsSyncConfig\(r\.roots\);/.test(APPS), "根目录回执（pick / set）同样同步");
  const syncFn = pickFn(APPS, "appsRootsSyncConfig");
  ok(/if \(!r\.configured\) continue;/.test(syncFn),
    "只写「已配置」的那一套键（configured=true 现在只可能来自主进程已固化 / 用户手选）");
  /* 迁移旧布局**整条功能已移除**（本轮用户口径：移除「迁移旧布局」按钮与功能）：
     跟着它一起删掉的还有「搬完把旧路径改指新目录」那套改写（appsRewriteMovedAppPaths）。
     仍保留的路径动作：appsRootPickNow / appsRootFolderNow（下载根 / 项目根各一套）+ 小菜单。 */
  ok(
    APPS.indexOf("async function appsRewriteMovedAppPaths(moves)") < 0 &&
      APPS.indexOf("async function appsMigrateLayoutNow") < 0,
    "「迁移旧布局」的功能代码已整条删除（按钮与改写逻辑一起走）",
  );
  ok(
    APPS.indexOf("async function appsRootPickNow(kind)") >= 0 &&
      APPS.indexOf("function appsRootFolderNow(kind)") >= 0,
    "根目录的「选目录 / 在资源管理器中打开」两个动作仍在（改由小菜单调用）",
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
    /* 随本轮需求下线的死词条 / 死样式：一个字都不该留（否则英文界面留着旧话术） */
    const dead = [
      "项目根目录未配置",
      "正在查找本机的应用目录…",
      "选择目录…",
      "设为项目根：",
      "未设置：开发中的应用不会列出来 —— 点右边「更改…」指定项目根",
      "未设置：下载前会先让你选一个文件夹",
      "还没指定应用根目录：下载前要先选一个文件夹",
      "请先在设置里指定应用根目录",
      "选择应用根目录失败：",
      "尚未指定应用安装根目录",
    ];
    for (const k of dead) ok(I18N.indexOf('"' + k + '":') < 0, "死词条已清：" + k);
    ok(CSS.indexOf(".apps-rootline-recover") < 0, "恢复行的样式（橙色虚线告警底）跟着删了");
    ok(CSS.indexOf(".apps-badge-bad") < 0, "「未设置」红字的样式也删了");
  }

  console.log("\n" + (fails ? "FAILED " + fails + "/" + checks : "ALL PASS " + checks + " 项"));
  process.exit(fails ? 1 : 0);
})().catch((err) => {
  console.log("FAIL  用例抛错：" + ((err && err.stack) || err));
  process.exit(1);
});
