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
 *   8. 落地（ensureDir，本轮需求）：安装真正开始时把「根目录 + 默认子目录名」建出来
 *      （连根目录一起，已存在就直接复用，绝不删改里面已有的内容）并写回该插件自己的
 *      installDir —— 用户设过根目录后不必再去系统框里手建一个文件夹；
 *      插件自己设过目录 / 窗口插件 / 桌宠一律不动，只读入口（status / entries）不建目录。
 *
 * 覆盖：
 *   [1] plugins/plugin-root.js：真源、推断、预填不写盘、写入护栏
 *   [1b] 默认子目录名表
 *   [1c] ensureDir：安装开始时的落地（建目录 + 写回 + 复用 + 三条例外）
 *   [2] plugins/main-app-plugins.js：安装目录推导 + 根目录 IPC + 首次提示
 *   [3] preload.js 六条桥 + renderer/app-plugins.js 的界面接线 + 安装窗的落地接线
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

/* 7 个本地后端插件：目录配置目录名 → 默认子目录名（沿用用户现有安装目录名）。
   已移除的 tts-local 只有「配置目录名」这一半（卸载要认路），没有默认子目录名。 */
const PLUGINS = {
  "minimax-music3": { cfg: "music3", sub: "music" },
  "yue2-local": { cfg: "yue", sub: "yue2" },
  "sensenova-local": { cfg: "sensenova", sub: "sense" },
  "minimax-h3": { cfg: "h3", sub: "video" },
  "llama-local": { cfg: "llama", sub: "vLLM" },
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

/* 子目录名表：7 个后端插件一套，别名与 id 同名一份 */
console.log("\n[1b] 默认子目录名表（沿用用户现有安装目录名）");
{
  for (const [id, want] of Object.entries(PLUGINS)) {
    ok(subDirNameOf(id) === want.sub, "「" + id + "」的默认子目录名 = " + want.sub);
  }
  ok(PLUGIN_SUBDIR.music3 === "music", "别名 music3 与 minimax-music3 同表");
  ok(subDirNameOf("bongochat") === "", "桌宠 bongochat 不属「需目录的插件」（本轮明确不碰）");
  ok(subDirNameOf("forum") === "", "窗口插件 forum 不属「需目录的插件」");
  ok(subDirNameOf("tts-local") === "", "已移除的 tts-local 不再有默认子目录名（没有安装入口，只剩卸载认路）");
  ok(
    JSON.stringify(Object.keys(PLUGIN_SUBDIR).filter((k) => k === "tts" || k === "tts-local")) === "[]",
    "PLUGIN_SUBDIR 里没有 tts 相关键了",
  );
}

/* ═════════ [1c] ensureDir：安装开始时把默认目录落地（本轮需求） ═════════ */
console.log("\n[1c] ensureDir：安装真正开始时建目录 + 写回插件自己的 installDir");
{
  const { dir, appDir, root } = freshData({});
  const mod = createPluginRoot({ getDataDir: () => dir, getAppDirs: () => [appDir] });
  const cfgOf = (rel) => path.join(dir, rel, "config.json");

  /* ① 根目录还没设：不建任何东西，如实回 need_root */
  const before = mod.ensureDir("minimax-h3");
  ok(before.ok === false && before.error === "need_root", "根目录没设 → need_root（不建目录）");
  ok(before.dir === "", "need_root 时不回目录");
  ok(!fs.existsSync(path.join(dir, "h3")), "need_root 时不写该插件的配置");

  /* ② 设一个「本身还不存在」的根目录：安装时连根目录一起建出来 */
  const plugRoot = path.join(root, "plugins-root");
  ok(!fs.existsSync(plugRoot), "假现场：根目录此刻还不存在");
  ok(mod.set(plugRoot).ok === true, "先把插件根目录设上");
  ok(!fs.existsSync(plugRoot), "只设置根目录**不建**目录（创建推迟到安装时）");
  const r1 = mod.ensureDir("minimax-h3");
  const want1 = path.join(path.resolve(plugRoot), "video");
  ok(r1.ok === true && r1.dir === want1, "ensureDir 回「根目录 + 默认子目录名」（得到 " + show(r1.dir) + "）");
  ok(r1.source === "root" && r1.created === true, "source=root、created=true");
  ok(fs.existsSync(plugRoot) && fs.existsSync(want1), "目录真被建出来（根目录一起建）");
  ok(r1.wrote === true, "写回了插件自己的 installDir");
  ok(fs.existsSync(cfgOf("h3")), "该插件此前没落过盘 → 由 ensureDir 起一份最小配置");
  ok(JSON.parse(fs.readFileSync(cfgOf("h3"), "utf8")).installDir === want1, "config.json 的 installDir = 建出来的目录");

  /* ③ 已存在就复用，绝不删改里面已有的内容（重装 / 续装靠它们跳过已完成步骤） */
  fs.writeFileSync(path.join(want1, "已下好的权重.bin"), "keep");
  const r2 = mod.ensureDir("minimax-h3");
  ok(r2.ok === true && r2.dir === want1 && r2.created === false, "再调一次：直接复用（created=false）");
  ok(fs.readFileSync(path.join(want1, "已下好的权重.bin"), "utf8") === "keep", "目录里已有的文件原样保留");

  /* ④ 插件自己设过 installDir → 原样返回：不跟随根目录、不新建、不改写 */
  const own = path.join(root, "my-own-h3");
  ok(mod.writePluginDir(dir, "minimax-h3", own).ok === true, "假设用户手动给 h3 换过目录");
  const anotherRoot = path.join(root, "another-root");
  ok(mod.set(anotherRoot).ok === true, "再换一次插件根目录");
  const r3 = mod.ensureDir("minimax-h3");
  ok(r3.ok === true && r3.dir === path.resolve(own) && r3.source === "plugin", "插件自己设过 → 原样用它");
  ok(r3.created === false && r3.wrote === false, "既不建目录也不改写配置");
  ok(!fs.existsSync(path.join(path.resolve(anotherRoot), "video")), "不按新根目录另建一个目录");
  ok(!fs.existsSync(path.resolve(own)), "自己设的目录不由这一步创建（宿主安装时自己 mk）");

  /* ⑤ 无需目录的插件（窗口插件 / 桌宠）：不建不写，交回老口径 */
  const r4 = mod.ensureDir("forum");
  ok(r4.ok === true && r4.dir === "" && r4.source === "legacy", "窗口插件 → dir 空串（老口径）");
  const r4b = mod.ensureDir("bongochat");
  ok(r4b.ok === true && r4b.dir === "" && r4b.source === "legacy", "桌宠 → dir 空串（老口径）");
  ok(!fs.existsSync(path.join(dir, "forum")) && !fs.existsSync(path.join(dir, "bongochat")), "两者都不产生目录 / 配置");
  ok(mod.ensureDir("").ok === false, "空 id → 直接失败（bad_id）");

  /* ⑥ 建不出来时如实回错（不静默、不写配置）：拿一个同名文件当父目录。
      用一个**自己没设过目录**的插件（llama-local）—— 设过的插件走的是「原样返回」那条路。 */
  const blocked = path.join(root, "blocked");
  fs.writeFileSync(blocked, "x");
  ok(mod.set(blocked).ok === true, "把根目录设到一个**同名文件**上（假故障现场）");
  const r5 = mod.ensureDir("llama-local");
  ok(r5.ok === false && r5.error === "mkdir_failed", "建不出来 → mkdir_failed（如实回错）");
  ok(r5.wrote === false, "建不出来时不写配置（不留下一个指向不存在目录的 installDir）");
  ok(!fs.existsSync(path.join(dir, "llama")), "建不出来时也不留下该插件的配置");

  /* ⑦ 老配置 / 手改配置把根目录指到危险处：兜一道，不建危险目录且把话说清 */
  const { dir: dirG, appDir: appDirG, root: rootG } = freshData({});
  writeJson(path.join(dirG, "config.json"), { plugins: { installDir: path.join(dirG, "plugins-root") } });
  const modG = createPluginRoot({ getDataDir: () => dirG, getAppDirs: () => [appDirG] });
  const rg = modG.ensureDir("llama-local");
  ok(rg.ok === false && rg.error === "refuse_data_dir", "根目录（手改）落在数据目录里 → 拒收，不建目录");
  ok(!!rg.message && rg.message.indexOf("数据目录") >= 0, "拒收时给一句看得懂的话（安装窗直接显示）");
  ok(!fs.existsSync(path.join(dirG, "plugins-root")), "真的没建任何危险目录");

  /* ⑧ 7 个「需目录」的插件都能落地，子目录名与表一致（干净现场） */  const { dir: dir7, appDir: appDir7, root: root7 } = freshData({});
  const mod7 = createPluginRoot({ getDataDir: () => dir7, getAppDirs: () => [appDir7] });
  const root7dir = path.join(root7, "all-root");
  ok(mod7.set(root7dir).ok === true, "设一个干净的根目录");
  for (const [id, spec] of Object.entries(PLUGINS)) {
    const r = mod7.ensureDir(id);
    ok(
      r.ok === true && r.dir === path.join(path.resolve(root7dir), spec.sub) && r.created === true,
      "「" + id + "」落地到 " + spec.sub + "（得到 " + show(r.dir) + "）",
    );
  }
  ok(
    fs.readdirSync(path.resolve(root7dir)).sort().join(",") === Object.values(PLUGINS).map((p) => p.sub).sort().join(","),
    "根目录下正好这 7 个子目录（不多建别的）",
  );

  for (const p of [dir, root, dir7, root7, dirG, rootG]) fs.rmSync(p, { recursive: true, force: true });
}

/* ═════════ [1d] 落地口径的兜底：空现场真建 + 通用化（本轮共识重做[1c] 的兜底） ═════════ */
console.log("\n[1d] ensureDir：空数据目录下真建目录 + 写回；「有自己目录的插件」不再靠写死的表");
{
  /* ① 空现场（插件配置一份都没有）+ 已设根目录：必须真建目录并写回该插件的配置文件。
     为什么会漏：配置文件按**文件名映射**（minimax-music3 → music3/config.json，不是同名目录），
     写歪了就会出现「目录建了、宿主读不到 installDir」→ 宿主报 empty_dir。 */
  const { dir, appDir, root } = freshData({});
  const mod = createPluginRoot({ getDataDir: () => dir, getAppDirs: () => [appDir] });
  const plugRoot = path.join(root, "fresh-root");
  ok(mod.set(plugRoot).ok === true, "空现场：设一个插件根目录");
  const r = mod.ensureDir("minimax-music3");
  const want = path.join(path.resolve(plugRoot), "music");
  ok(r.ok === true && r.dir === want && r.created === true && r.wrote === true, "空现场真建目录并写回（created/wrote 都为真）");
  ok(fs.existsSync(want), "目录真被建出来");
  ok(!fs.existsSync(path.join(dir, "minimax-music3")), "不按插件 id 另建一个同名目录（配置落在映射出来的文件名上）");
  ok(
    r.cfgPath === path.join(dir, "music3", "config.json") && fs.existsSync(r.cfgPath),
    "回执带 cfgPath = 真正写回的那份配置（music3/config.json）",
  );
  ok(JSON.parse(fs.readFileSync(r.cfgPath, "utf8")).installDir === want, "那份配置里的 installDir = 建出来的目录（宿主读的就是它）");
  ok(r.needs === true, "回执标明「这个插件本该有目录」（安装窗据此判故障）");
  const r2 = mod.ensureDir("minimax-music3");
  ok(r2.source === "plugin" && r2.dir === want && r2.created === false, "再调一次：认自己写回的配置，直接复用");

  /* ② 通用化：不在 PLUGIN_SUBDIR 里、但**有自己 installDir 配置**的插件（遗留 / 云端新插件）也纳入 */
  for (const [id, sub] of [
    ["asr", "asr"],                 /* 已从插件目录移除、老机器上还留着的遗留插件（PLUGIN_CFG 里有它） */
    ["sensenova", "sense"],         /* 别名（表里只有 sensenova-local）→ 跟着别名走同一个子目录 */
  ]) {
    const rr = mod.ensureDir(id);
    ok(
      rr.ok === true && rr.dir === path.join(path.resolve(plugRoot), sub) && rr.wrote === true && rr.needs === true,
      "「" + id + "」按自己的配置目录名落地到 " + sub + "（得到 " + show(rr.dir) + "）",
    );
  }
  ok(mod.needsDir("asr") === true, "needsDir 认「有自己配置的插件」（不止显式表里那 7 个）");

  /* ③ 认不出的 id（窗口插件 / 桌宠 / 未知）：不建不写，老口径空串 ——
     这条边界本轮**故意不放宽**：窗口插件 / 桌宠有它们自己的目录与卸载路由，
     硬塞插件根目录会踩到那条路（test/smoke-plugin-uninstall 的 [4b] 钉着它）。 */
  for (const id of ["forum", "pet", "bongochat", "totally-unknown-plugin"]) {
    const rr = mod.ensureDir(id);
    ok(rr.ok === true && rr.dir === "" && rr.source === "legacy" && rr.needs === false, "「" + id + "」→ 老口径空串（needs=false）");
  }
  ok(
    fs.readdirSync(path.resolve(plugRoot)).sort().join(",") === "asr,music,sense",
    "根目录下正好这 3 个子目录（不认出的 id 一个目录也不建）",
  );

  /* ③b 宿主自己的 id 也得认（真事故的第二半）：yue/main-yue.js 的 PLUGIN_ID = "yue"，
     安装通道 yue:install 也用它，而卡片 id 是 "yue2-local" —— 两个 id 必须落**同一个**子目录。
     从前表里只有卡片 id：宿主 id 那条路上 needsDir 回 false，ensureDir 只回一个空目录又说
     「不需要目录」，安装链照样落成宿主的 empty_dir。 */
  ok(mod.needsDir("yue") === true && mod.subDir("yue") === "yue2", "宿主 id「yue」按卡片同一个子目录纳入（yue2）");
  {
    const ry = mod.ensureDir("yue");
    ok(
      ry.ok === true && ry.dir === path.join(path.resolve(plugRoot), "yue2") && ry.wrote === true && ry.needs === true,
      "「yue」也真落地到 yue2 并写回配置（得到 " + show(ry.dir) + "）",
    );
  }

  /* ④ 传进来的子目录名优先（调用方已知别名口径时不被推导覆盖） */
  const r4 = mod.ensureDir("remotion", "remotion");
  ok(r4.ok === true && r4.dir === path.join(path.resolve(plugRoot), "remotion"), "显式传子目录名时用它（remotion）");

  for (const p of [dir, root]) fs.rmSync(p, { recursive: true, force: true });
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
  /* 本轮需求：安装真正开始时落地（建目录 + 写回该插件自己的 installDir） */
  has(ins, "function ensureInstallDirFor(id)", "有 ensureInstallDirFor（安装开始时把默认目录落地）");
  has(ins, "mod.ensureDir(sid)", "落地口径复用 plugin-root 的 ensureDir（不在别处再拼一次路径）");
  has(ins, 'ipcMain.handle("mtnodeInstall:ensureDir"', "IPC mtnodeInstall:ensureDir（安装窗调它）");
  has(ins, "snap.installDir = String(r.dir)", "落地后同步快照里的安装目录（窗与宿主看同一份现场）");
  hasnt(
    ins.slice(ins.indexOf("function installDirOf(id)"), ins.indexOf("let pluginRootMod = null;")),
    "ensureDir",
    "只读入口 installDirOf 不建目录（插件界面一打开就会问一遍各插件目录）",
  );
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
  /* 本轮需求：**插件界面不写安装目录**（路径只在安装窗里显示与修改）。
     卡片状态行与详情浮层原先那行目录都已摘掉，这里钉「不再出现」，免得日后又被加回来。 */
  hasnt(app, "async function mountPluginPopDir(pop, item)", "详情浮层不再有「安装目录」一行（目录只在安装窗里显示）");
  hasnt(app, 'I18n.t("安装目录：") + dir', "卡片状态行不再写安装目录路径");
  has(app, "function backendCardLine(st, spec)", "卡片状态行仍在（只写启动中 / 失败原因 / 后端提示）");
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

  /* 安装窗那一侧：安装真正开始时先让主进程把默认目录建出来，再调安装桥 */
  const insWin = read("install/app.js");
  const insPre = read("plugins/install-preload.js");
  has(insPre, "ensureDir: (id) => ipcRenderer.invoke(\"mtnodeInstall:ensureDir\"", "安装窗桥暴露 ensureDir");
  has(insWin, "api.ensureDir(id)", "安装窗在安装开始时调 ensureDir");
  ok(
    insWin.indexOf("api.ensureDir(id)") < insWin.indexOf("api.api(m.install, installArgs)"),
    "顺序：先落地目录、再调安装桥（宿主读的配置此时已经写好）",
  );
  has(insWin, 'ens.error === "need_root"', "need_root 不当作故障（根目录没设仍走老口径的手动选目录）");
  has(insWin, "取不到这个插件的安装目录", "回执说成功却没给目录 → 当场如实拦下（不再一路走到宿主，报一句 empty_dir）");
  has(insWin, 'T("已自动创建（插件根目录 + 默认子目录名）"', "建出来时给一句可见回执（顶部副行，不静默）");
  has(insWin, "创建默认安装目录失败：", "建失败时如实报错（保留「选择安装目录」兜底）");
  has(insWin, "if (!dir && m.pick)", "老口径（没目录时弹系统目录框）原样保留");
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
  ]) {
    has(i18n, '"' + k + '"', "i18n 有词条（键即中文原文）：「" + k + "」");
  }
  /* 目录行整块摘除后，那几个只服务于它的词条不许再留着（放着就会被人当成活词条复用） */
  for (const k of ["安装目录：", "安装目录", "已恢复默认安装目录：", "先设置插件根目录再恢复默认。"]) {
    hasnt(i18n, '"' + k + '":', "详情浮层目录行删掉后，「" + k + "」词条也一并摘除");
  }
  has(css, ".plug-root-bar {", "样式 .plug-root-bar");
  has(css, ".plug-root-bar.need {", "未设状态 .plug-root-bar.need（醒目提示）");
  has(css, ".plug-root-bar.warn {", "被拦时闪一下 .plug-root-bar.warn");
  hasnt(css, ".plugin-pop-dir {", "详情面板目录行样式 .plugin-pop-dir 已随目录行一起删除");
  hasnt(css, "--plug-root-", "不新造色板变量（只取既有语义变量）");
}

console.log("");
if (fails) {
  console.log("FAILED " + fails + " / " + checks + " checks");
  process.exit(1);
}
console.log("ALL PASS " + checks + " checks");
