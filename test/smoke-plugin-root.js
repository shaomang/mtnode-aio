"use strict";
/* 插件根目录（本轮需求：插件界面一个总的根目录 + 第一次打开时提示设置）的回归
 *   node test/smoke-plugin-root.js
 *
 * 锁住本轮共识：
 *   1. 插件对话框顶部一行「插件根目录」：没设时是醒目提示 +「选择目录…」，设了之后可「换目录…」。
 *   2. 需要目录的插件默认用「根目录 + 默认子目录名」；**插件自己的 installDir 一设就优先**
 *      （插件里仍然允许单独更换安装目录 —— 安装窗 / 控制台里的入口不动）。
 *   3. 预填值 = 按现有各插件 installDir 的公共父目录推断出来的，**只预填不写盘**，
 *      用户点「选择目录…」确认后才落到 <数据目录>/config.json 的 plugins.installDir。
 *   4. 推断边界：只算已设过 installDir 的插件 · 至少 2 个同属一个父目录 · 父目录不能是盘符根 ·
 *      命中应用目录 / 数据目录一律丢弃（数据不落应用文件夹）。
 *   5. 已装的不动：本模块只在「插件自己没设过目录」时给默认值，绝不改写已设的 installDir。
 *   6. 写入护栏：盘符根 / 应用目录 / 数据目录拒收（拒收理由回给界面当 toast）。
 *   7. 子目录名沿用用户现有安装目录名；两侧（主进程推导与渲染层展示）共用同一份桥。
 *
 * 覆盖：
 *   [1] plugins/plugin-root.js：真源、推断、预填不写盘、写入护栏
 *   [2] plugins/main-app-plugins.js：安装目录推导 + 根目录 IPC + 首次提示
 *   [3] preload.js 六条桥 + renderer/app-plugins.js 的界面接线
 *   [4] i18n 中英词条 + CSS
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

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
const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");
const show = (v) => JSON.stringify(v);
const has = (hay, needle, msg) => {
  const c = String(hay).indexOf(needle) >= 0;
  ok(c, msg + (c ? "" : "（缺 " + show(needle) + "）"));
};
const hasnt = (hay, needle, msg) => {
  const c = String(hay).indexOf(needle) < 0;
  ok(c, msg + (c ? "" : "（仍含 " + show(needle) + "）"));
};
function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v), "utf8");
}

const { createPluginRoot, subDirNameOf, PLUGIN_SUBDIR } = require(path.join(
  ROOT,
  "plugins",
  "plugin-root.js",
));

/* 8 个本地后端插件：目录配置目录名 → 默认子目录名（沿用用户现有安装目录名） */
const PLUGINS = {
  "minimax-music3": { cfg: "music3", sub: "music" },
  "yue2-local": { cfg: "yue", sub: "yue2" },
  "sensenova-local": { cfg: "sensenova", sub: "sense" },
  "minimax-h3": { cfg: "h3", sub: "video" },
  "llama-local": { cfg: "llama", sub: "vLLM" },
  "tts-local": { cfg: "tts", sub: "tts" },
  "breeze-tts-local": { cfg: "breeze-tts", sub: "breeze" },
  remotion: { cfg: "remotion", sub: "remotion" },
};

/* 隔离现场：假数据目录 + 假应用目录 + 假「插件安装区」（TestDrive 不一定存在，只当字符串判据用）。
   插件安装区必须建在数据目录**之外**（否则推断出来的父目录命中数据目录，会被护栏丢弃）。 */
function freshData(installDirs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-plugin-root-"));
  const anyDir = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-plugin-installs-"));
  for (const [id, rel] of Object.entries(installDirs || {})) {
    writeJson(path.join(dir, id, "config.json"), { installDir: path.join(anyDir, rel) });
  }
  const appDir = path.join(dir, "app");
  fs.mkdirSync(appDir, { recursive: true });
  return { dir, appDir, root: anyDir };
}

/* ═════════ [1] plugins/plugin-root.js：真源 / 推断 / 预填不写盘 / 写入护栏 ═════════ */
console.log("\n[1] plugins/plugin-root.js：推断规则、预填不写盘、写入护栏");
{
  const { dir, appDir, root } = freshData({
    music3: "music",
    yue: "yue2",
    h3: "video",
    llama: "vLLM",
  });
  const mod = createPluginRoot({ getDataDir: () => dir, getAppDirs: () => [appDir] });
  const st = mod.status();
  ok(st.ok === true, "status 可用");
  ok(st.set === false && st.installDir === "", "从没设过 → set=false、installDir 为空");
  ok(st.inferred === root, "推断值 = 已设目录的公共父目录（得到 " + show(st.inferred) + "）");
  ok(st.inferIds.length === 4, "推断只算已设过 installDir 的插件（4 个，得到 " + st.inferIds.length + "）");
  ok(
    fs.existsSync(path.join(dir, "config.json")) === false,
    "推断**只预填不写盘**：<数据目录>/config.json 没被创建",
  );
  ok(mod.get() === "", "get() 仍是空（用户没确认前不算已设）");

  /* 至少 2 个插件同属一个父目录才采用 */
  const one = createPluginRoot({
    getDataDir: () => dir,
    getAppDirs: () => [appDir],
  });
  const solo = freshData({ music3: "music" });
  const soloMod = createPluginRoot({ getDataDir: () => solo.dir, getAppDirs: () => [solo.appDir] });
  ok(soloMod.status().inferred === "", "只有 1 个插件设过目录 → 不推断（宁缺毋滥）");
  ok(soloMod.status().inferReason === "no_common_parent", "不推断时给出原因 no_common_parent");
  void one;

  /* 父目录是盘符根 / 命中应用目录 → 丢弃 */
  const atRoot = createPluginRoot({ getDataDir: () => dir, getAppDirs: () => [appDir] });
  const driveRoot = freshData({ music3: "", yue: "" });
  writeJson(path.join(driveRoot.dir, "music3", "config.json"), { installDir: "E:\\" });
  writeJson(path.join(driveRoot.dir, "yue", "config.json"), { installDir: "E:\\" });
  const driveMod = createPluginRoot({
    getDataDir: () => driveRoot.dir,
    getAppDirs: () => [driveRoot.appDir],
  });
  ok(driveMod.status().inferred === "", "父目录是盘符根 → 丢弃推断");
  const insideApp = freshData({ music3: "a", yue: "b" });
  writeJson(path.join(insideApp.dir, "music3", "config.json"), {
    installDir: path.join(insideApp.appDir, "music"),
  });
  writeJson(path.join(insideApp.dir, "yue", "config.json"), {
    installDir: path.join(insideApp.appDir, "yue2"),
  });
  const appMod = createPluginRoot({
    getDataDir: () => insideApp.dir,
    getAppDirs: () => [insideApp.appDir],
  });
  ok(appMod.status().inferred === "", "父目录命中应用目录 → 丢弃推断（数据不落应用文件夹）");
  void atRoot;

  /* 写入护栏：盘符根 / 应用目录 / 数据目录拒收，合格目录才写 */
  const g = createPluginRoot({ getDataDir: () => dir, getAppDirs: () => [appDir] });
  ok(g.set("E:\\").ok === false && g.set("E:\\").error === "refuse_root", "写盘符根被拒（refuse_root）");
  ok(g.set(appDir).error === "refuse_app_dir", "写应用目录被拒（refuse_app_dir）");
  ok(g.set(path.join(dir, "x")).error === "refuse_data_dir", "写数据目录被拒（refuse_data_dir）");
  const good = path.join(root, "mtnode-plugins");
  const wr = g.set(good);
  ok(wr.ok === true && wr.installDir === path.resolve(good), "合格目录写成功（" + show(wr.installDir) + "）");
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
  ok(
    cfg && cfg.plugins && cfg.plugins.installDir === path.resolve(good),
    "值落在 <数据目录>/config.json 的 plugins.installDir",
  );
  ok(
    cfg.apps === undefined,
    "不碰 config.json 里的其它小节（apps.installDir 是应用中心的根，与本设置无关）",
  );
  const st2 = g.status();
  ok(st2.set === true && st2.installDir === path.resolve(good), "设过之后 status.set=true");
  ok(
    g.defaultDir("minimax-h3") === path.join(path.resolve(good), "video"),
    "defaultDir = 根目录 + 子目录名（" + show(g.defaultDir("minimax-h3")) + "）",
  );
  ok(g.defaultDir("forum") === "", "窗口插件（没默认子目录名）不给默认目录");
  ok(g.set("").ok === true && g.get() === "", "传空串 = 清掉，回到「未设 → 首次提示设置」");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(solo.dir, { recursive: true, force: true });
  fs.rmSync(solo.root, { recursive: true, force: true });
  fs.rmSync(driveRoot.dir, { recursive: true, force: true });
  fs.rmSync(driveRoot.root, { recursive: true, force: true });
  fs.rmSync(insideApp.dir, { recursive: true, force: true });
  fs.rmSync(insideApp.root, { recursive: true, force: true });
}

/* 子目录名表：8 个后端插件一套，别名与 id 同名一份 */
console.log("\n[1b] 默认子目录名表（沿用用户现有安装目录名）");
{
  for (const [id, want] of Object.entries(PLUGINS)) {
    ok(subDirNameOf(id) === want.sub, "「" + id + "」的默认子目录名 = " + want.sub);
  }
  ok(PLUGIN_SUBDIR.music3 === "music", "别名 music3 与 minimax-music3 同表");
  ok(subDirNameOf("bongochat") === "", "桌宠 bongochat 不属「需目录的插件」（本轮明确不碰）");
  ok(subDirNameOf("forum") === "", "窗口插件 forum 不属「需目录的插件」");
}

/* ═════════ [2] 主进程接线：安装目录推导 + 根目录 IPC ═════════ */
console.log("\n[2] plugins/main-app-plugins.js：目录推导 + 根目录 IPC");
{
  const src = read("plugins/main-app-plugins.js");
  has(src, 'require("./plugin-root.js")', "主进程 require 唯一真源 plugins/plugin-root.js");
  has(src, "function installDirOf(id)", "有统一的安装目录口径 installDirOf");
  has(src, "function resolvePluginInstallDir(id)", "有「这次该装到哪」resolvePluginInstallDir");
  has(src, 'error: "need_root"', "根目录没设 → 回 need_root（渲染层据此提示去设置）");
  has(src, 'appPlugins:rootStatus', "IPC appPlugins:rootStatus");
  has(src, 'appPlugins:rootSet', "IPC appPlugins:rootSet");
  has(src, 'appPlugins:rootPick', "IPC appPlugins:rootPick（系统目录框，取消回 cancelled）");
  has(src, 'appPlugins:rootOpen', "IPC appPlugins:rootOpen（打开根目录）");
  has(src, 'appPlugins:installDirOfPlugin', "IPC appPlugins:installDirOfPlugin");
  has(src, 'appPlugins:pluginInstallDir', "IPC appPlugins:pluginInstallDir（读 / 恢复默认）");
  has(src, 'appPlugins:openPath', "IPC appPlugins:openPath（详情面板「打开目录」）");
  has(src, 'properties: ["openDirectory", "createDirectory", "dontAddToRecent"]', "目录选择框口径（openDirectory + createDirectory）");
  has(src, "defaultPath: cur || inf || undefined", "目录框用当前值 / 推断值预填");
  has(src, "installDirOf,\n  resolvePluginInstallDir,", "两个口径都导出（main-install.js 与渲染层各取所需）");
  hasnt(src, 'installDir: pluginDir(id)', "installWindowPlugin 不再写死 app-plugins 目录");

  /* 安装窗 / 权重指路那一侧（plugins/main-install.js）也认同一份口径 */
  const ins = read("plugins/main-install.js");
  has(ins, "function installDirOf(id)", "安装窗 installDirOf 仍在");
  has(ins, "const mod = getPluginRootMod();", "安装窗 installDirOf 接上插件根目录口径");
  has(ins, "mod.needsDir(sid)", "只对「需目录的插件」用根目录默认值");
  has(ins, 'require("./plugin-root.js")', "安装窗懒加载同一份真源（避免与 main-app-plugins 循环 require）");
}

/* ═════════ [3] 渲染层：顶部那一行、安装拦截、详情面板目录行 ═════════ */
console.log("\n[3] renderer/app-plugins.js + preload.js：界面接线");
{
  const app = read("renderer/app-plugins.js");
  const pre = read("preload.js");
  has(app, "function buildPlugRootBar()", "对话框顶部那一行由 buildPlugRootBar 建");
  has(app, "function repaintPlugRootBar(info)", "由 repaintPlugRootBar 按现状重画");
  has(app, "function plugRootChange()", "「选择目录… / 换目录…」走 plugRootChange");
  has(app, 'pickBtn.textContent = set ? I18n.t("换目录…") : I18n.t("选择目录…")', "按钮文案随已设 / 未设切换");
  has(app, 'bar.setAttribute("data-need", set ? "" : "1")', "未设状态标在 data-need 上（CSS 由此给醒目提示）");
  has(app, "已按现有插件目录推断：", "未设提示里给出推断出来的预填值");
  has(app, "function plugRootWarn(msg)", "被拦时统一提示 + 顶部那一行闪一下");
  has(app, 'target.error === "need_root"', "点「安装」时根目录没设 → 先提示去设置，不开始安装");
  has(app, "const target = await plugInstallDir(id);", "先问「这次该装到哪」再开安装窗");
  has(app, "await openPluginInstallWindow({ id, action: \"install\", installDir: target.dir })", "安装窗拿到解析好的目录");
  has(app, "async function mountPluginPopDir(pop, item)", "详情浮层有「安装目录」一行");
  has(app, 'I18n.t("恢复默认")', "有「恢复默认」按钮");
  has(app, "后端正在运行：先停止后端再改目录", "后端运行中置灰并给出原因");
  has(app, 'fn({ id, default: true })', "「恢复默认」= 让主进程改写该插件的默认目录");
  has(app, '_plugRoots = new Map()', "根目录变了 → 各插件目录缓存作废重取");
  has(app, "repaintPlugRootBar(await plugRootInfo());", "开对话框时先读根目录现状再画");
  has(app, 'data-plugin-root-open', "底部「打开插件目录」改成打开当前插件根目录");
  has(app, 'I18n.t("插件默认装到该根目录下的子目录；单个插件仍可在它的安装窗里换成别的目录。")', "已设时给一句口径说明");
  hasnt(app, 'if (!st.installDir) {\n      const pickFn', "旧的「先弹系统目录框」分支已移除");

  for (const m of [
    "appPluginsRootStatus",
    "appPluginsRootSet",
    "appPluginsRootPick",
    "appPluginsRootOpen",
    "appPluginsInstallDirOf",
    "appPluginsPluginInstallDir",
    "appPluginsOpenPath",
  ]) {
    has(pre, m + ":", "preload 暴露 " + m);
  }
}

/* ═════════ [4] i18n 中英词条 + CSS ═════════ */
console.log("\n[4] i18n 词条与样式");
{
  const i18n = read("renderer/i18n.js");
  const css = read("renderer/css/layout.css");
  for (const k of [
    "插件根目录",
    "换目录…",
    "选择目录…",
    "打开插件根目录失败：",
    "在文件管理器里打开插件根目录",
    "已按现有插件目录推断：",
    "设置插件根目录失败：",
    "插件根目录已设为：",
    "还没有设置插件根目录：先在插件界面顶部选一个根目录，",
    "安装目录：",
    "安装目录",
    "默认子目录名：",
    "后端正在运行：先停止后端再改目录",
    "已恢复默认安装目录：",
    "先设置插件根目录再恢复默认。",
  ]) {
    has(i18n, '"' + k + '"', "i18n 有词条（键即中文原文）：「" + k + "」");
  }
  has(css, ".plug-root-bar {", "样式 .plug-root-bar");
  has(css, ".plug-root-bar.need {", "未设状态 .plug-root-bar.need（醒目提示）");
  has(css, ".plug-root-bar.warn {", "被拦时闪一下 .plug-root-bar.warn");
  has(css, ".plugin-pop-dir {", "详情面板目录行 .plugin-pop-dir");
  hasnt(css, "--plug-root-", "不新造色板变量（只取既有语义变量）");
}

console.log("");
if (fails) {
  console.log("FAILED " + fails + " / " + checks + " checks");
  process.exit(1);
}
console.log("ALL PASS " + checks + " checks");
