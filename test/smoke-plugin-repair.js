"use strict";
/* 插件报错 → 弹窗报告 → 交给可见会话自动修复 → 修完重启服务 —— 冒烟测试（纯 Node，无 Electron / 无 DOM）
 *   node test/smoke-plugin-repair.js
 * 需求：① 任何插件（需要第三方安装的本地后端 H3 / Music3 / YuE2 / TTS / llama.cpp / ASR / Remotion，
 *          以及桌宠 BongoChat 与顶栏「插件」里的可下载安装插件）报错时，主窗口必须弹一只**错误报告窗**
 *          （错误码 / 正文 / 日志尾部 / 出问题的节点），并问用户要不要
 *          「自动修复」；点了就在左侧栏**新建一条看得见的会话**（工作区 = 该插件 INSTALL_DIR）按
 *          skill 的【自我修复】模式修，修完**自动重启该插件对应的服务**（无常驻服务则重跑报错节点）。
 *       ② 安装链路的技能真源必须唯一：Agent 拿到的 minimax-h3-install（及 music3 / tts / llama / asr）
 *          正文只能来自仓库根 `skills/<name>/SKILL.md`，宿主目录不留副本。
 * 覆盖：
 *   [1] 宿主注册表：所有插件都注册进报错总线（id / skillName / 日志 / 自我修复 / 重启）且接了上报点
 *       —— 七个后端宿主（H3 / Music3 / YuE2 / TTS / llama / ASR / Remotion）+ 桌宠（BongoChat）
 *          + 窗口插件安装链（plugins/main-app-plugins.js）
 *   [2] 技能真源单一：INSTALL_SKILL_SOURCES ↔ 宿主 sync 指向同一份真源、.install-only 语义、旧副本目录已删
 *   [3] 打包与入口：plugin-error-repair.js 在 build.json files 白名单里、main.js 先 init 再注册宿主 IPC、
 *       并接住弹窗侧两条回执（pluginRepair:report / pluginRepair:result → 落主日志 + 清去抖 + 广播刷新）
 *   [4] 报错总线行为（真跑 plugin-error-repair.js）：双通道推送 / 去抖合并 / 不可修判定 / 错误码归一 / token 一次性 / 重启与兜底
 *   [5] 渲染层入口：preload 三桥齐备 + app-repair.js 启动即订阅 + 脚本与样式接入顺序
 *   [6] 弹窗 persistent：本模块两只窗都不挂「点外部即关」（与 test/smoke-dialog-persistence.js 同口径）
 *   [7] 修复提示词与「修完重启」服务表：skill 名 + INSTALL_DIR + 纪律 + repair_ok；重启入口指向真存在的桥；
 *       服务表按插件目录逐张卡片覆盖（含桌宠 / Remotion 这类无常驻服务的）
 *   [8] H3 安装链按当前方案：交付要件（南风包 / soundfile / latent 占位 / 后处理权重 / cu130）+ 健康检查收尾 + CPU VAE 默认关
 *   [9] i18n：app-repair.js 的 I18n.t 字面量 + 主进程「为什么按不动」指路文案，在英文档逐条命中（不得回落中文）
 *  [10] 文档收口：docs/plugin-auto-repair.md、手册中英段、节点指南中英同步、节点指南不被生成器回滚
 *  [11] 端到端契约（总线 → 弹窗）：同一次报错既推原始事件 `pluginError:report`，也推渲染层订阅的
 *       扁平 `pluginRepair:error`（字段名与 pluginRepairNormalize 对齐，带 repairToken / repairable / why）；
 *       「会话修复」优先的可修判定（没有隐藏 selfRepair 也能修）；main.js 两条回执 handler 齐。 */
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
const ROOT = path.join(__dirname, "..");
/* 源码统一按 \n 处理（仓库是 CRLF，切段与断言不必管行尾差异） */
const read = (rel) =>
  fs
    .readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8")
    .replace(/\r\n/g, "\n");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel.split("/").join(path.sep)));
const show = (v) => JSON.stringify(v);
const count = (src, re) => (src.match(re) || []).length;
/* 取「起点 → 终点」之间的一段源码：存在性判定太松，容易把「提到了」当成「做了」 */
function seg(src, from, to, label) {
  const a = src.indexOf(from);
  if (a < 0) throw new Error("找不到起点：" + label);
  const b = src.indexOf(to, a + from.length);
  return src.slice(a, b < 0 ? src.length : b);
}
/* 从源码里抠出一个完整函数体（照 test/smoke-dialog-persistence.js 的做法），丢进 vm 真跑 */
function fnBody(src, name) {
  const m = src.indexOf("function " + name + "(");
  if (m < 0) throw new Error("找不到函数：" + name);
  const at = src.indexOf("{", src.indexOf(")", m));
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
      if (!depth) return src.slice(m, j + 1);
    }
  }
  throw new Error("函数体没闭合：" + name);
}

/* 所有插件对报错总线的注册契约（字段一一对应 plugin-error-repair.js 的 registerPluginHost）
   hasSkillField = 注册里是否写了 skillName；selfRepair = 是否还带主进程内的隐藏回落入口 */
const HOSTS = [
  { file: "h3/main-h3.js", id: "minimax-h3", skill: "minimax-h3-install", fn: "syncH3InstallSkill", selfRepair: true, restart: true, reports: 20 },
  { file: "music3/main-music3.js", id: "minimax-music3", skill: "minimax-music3-install", fn: "syncMusic3InstallSkill", selfRepair: true, restart: true, reports: 15 },
  { file: "tts/main-tts.js", id: "tts-local", skill: "tts-local-install", fn: "syncTtsInstallSkill", selfRepair: true, restart: true, reports: 8 },
  { file: "llama/main-llama.js", id: "llama-local", skill: "llama-local-install", fn: "syncLlamaInstallSkill", selfRepair: true, restart: true, reports: 8 },
  { file: "asr/main-asr.js", id: "asr-local", skill: "asr-local-install", fn: "syncAsrInstallSkill", selfRepair: true, restart: true, reports: 15 },
  /* YuE2：skill 名走常量（宿主内 INSTALL_SKILL），注册形态与 h3 / music3 同构 */
  { file: "yue/main-yue.js", id: "yue", skill: "yue2-local-install", fn: "", selfRepair: true, restart: true, reports: 20, skillConst: true },
  /* SenseNova 本地图像生成：同构（skill 名走宿主内 INSTALL_SKILL，兜底同步同步一份到 dshHome） */
  { file: "sensenova/main-sensenova.js", id: "sensenova-local", skill: "sensenova-local-install", fn: "syncSensenovaInstallSkill", selfRepair: true, restart: true, reports: 20, skillConst: true },
  /* Remotion 走 npm 安装、没有 Agent 安装链：只注册「取可用目录 + 取日志」，可修性靠会话修复那条路 */
  { file: "remotion/main-remotion.js", id: "remotion", skill: "", fn: "", selfRepair: false, restart: false, reports: 9 },
  /* 桌宠（BongoChat）：下载形象包型插件，连 skillName 都不注册（没有配套 skill），只给现场目录 */
  { file: "pet/main-pet.js", id: "bongochat", skill: "", fn: "", selfRepair: false, restart: false, reports: 5, noSkillField: true },
];
const INSTALL_SKILLS = [
  "minimax-h3-install",
  "minimax-music3-install",
  "tts-local-install",
  "llama-local-install",
  "asr-local-install",
  "sensenova-local-install",
];

const dsh = read("dsh/main-dsh.js");
const mainJs = read("main.js");
const preload = read("preload.js");
const repair = read("renderer/app-repair.js");
const h3 = read("h3/main-h3.js");
const skillH3 = read("skills/minimax-h3-install/SKILL.md");
const rendererFiles = fs
  .readdirSync(path.join(ROOT, "renderer"))
  .filter((f) => f.endsWith(".js"))
  .map((f) => "renderer/" + f);

/* ────────────────────────── [1] 宿主注册表 ────────────────────────── */
console.log("\n[1] 所有插件都注册进报错总线，并接上了失败出口");
for (const h of HOSTS) {
  const src = read(h.file);
  ok(src.indexOf('require("../plugin-error-repair.js")') > 0, h.file + " 引用报错总线");
  ok(new RegExp('const PLUGIN_ID = "' + h.id + '";').test(src), h.file + " 的 PLUGIN_ID = " + h.id);
  const reg = seg(src, "registerPluginHost({", "  });", h.file + " registerPluginHost");
  ok(reg.indexOf("id: PLUGIN_ID") > 0, h.file + " 注册带插件 id");
  ok(reg.indexOf("getInstallDir:") > 0 && reg.indexOf("tailConsole:") > 0, h.file + " 注册带安装目录与日志尾部取值口");
  ok(
    h.noSkillField
      ? reg.indexOf("skillName:") < 0 /* 没有配套 skill：不注册空字段，弹窗侧按「无 skill 自行判断根因」分支走 */
      : h.skillConst
        ? reg.indexOf("skillName: INSTALL_SKILL") > 0 && new RegExp('const INSTALL_SKILL = "' + h.skill + '";').test(src)
        : reg.indexOf('skillName: "' + h.skill + '"') > 0,
    h.file + (h.noSkillField ? " 不注册 skillName（该插件没有配套的内置 skill）" : " 注册 skillName = " + (h.skill || "(空：无 Agent 安装链)")),
  );
  ok(
    (reg.indexOf("selfRepair:") > 0) === h.selfRepair,
    h.file + (h.selfRepair ? " 带隐藏自我修复回落入口（pluginError:repair）" : " 不注册隐藏入口（只走弹窗那条可见会话修复）"),
  );
  ok(
    (reg.indexOf("restart:") > 0) === h.restart,
    h.file + (h.restart ? " 提供重启入口（修完自动重启该服务）" : " 无常驻后端 → 不注册重启"),
  );
  if (h.restart)
    ok(
      /restart:\s*async[\s\S]{0,220}stopBackend\([\s\S]{0,220}startBackend\(/.test(reg),
      h.file + " 重启 = 先停旧进程再拉起（半死进程否则会被判「端口已有人 = reused」）",
    );
  ok(src.indexOf("function reportErr(") > 0, h.file + " 有 reportErr 包装（自带 try/catch）");
  ok(src.indexOf("pluginErrors.reportPluginError(") > 0, h.file + " 包装落到总线 reportPluginError");
  const calls = count(src, /\breportErr\(/g) - 1; /* 减掉定义那一处 */
  ok(calls >= h.reports, h.file + " 失败出口接了上报（" + calls + " 处 ≥ " + h.reports + "）");
}
{
  const asr = read("asr/main-asr.js");
  const music3 = read("music3/main-music3.js");
  ok(count(h3, /\bnodeId\b/g) >= 6, "h3 的上报点带得出「出问题的节点」（nodeId 多处出现）");
  ok(count(asr, /\bnodeId\b/g) >= 4, "asr 的上报点同样带 nodeId（转写失败要能指认节点）");
  ok(music3.indexOf("emitProgress") > 0, "music3 保留原进度广播（上报是并行加的一层，不替换旧口径）");
  /* tts / llama / asr 原本只有 agentRecoverInstall：自我修复要等价实现 */
  for (const f of ["tts/main-tts.js", "llama/main-llama.js", "asr/main-asr.js"]) {
    const src = read(f);
    ok(src.indexOf("function selfRepairFromConsole") > 0, f + " 补了 selfRepairFromConsole（控制台尾部 → Agent 恢复安装）");
    ok(/selfRepairFromConsole[\s\S]{0,1200}(agentRecoverInstall|recoverInstall)/.test(src), f + " 的自我修复复用既有 Agent 恢复安装链");
  }
}
{
  /* 新接入的两个「没有 Agent 安装链」的宿主：现场必须给得出来，否则报告窗指不了路 */
  const pet = read("pet/main-pet.js");
  const rem = read("remotion/main-remotion.js");
  ok(/installPet[\s\S]{0,4000}reportErr\(/.test(pet), "pet 的安装终态失败出口接了上报（远程失败且离线包也没有）");
  ok(pet.indexOf("downloadErrCode") > 0, "pet 把下载失败归成 HTTP / 网络超时两类码（不让总线拿整串当错误码）");
  ok(pet.indexOf('"device_hook_failed"') > 0 && pet.indexOf('"tray_failed"') > 0, "pet 的 uiohook 与托盘启动失败也上报（不止安装链）");
  ok(/getInstallDir:\s*\(\)\s*=>\s*usableInstallDir\(\)/.test(rem), "remotion 交出的是「真实存在、可写」的安装目录（拿不到就回落数据目录）");
  ok(rem.indexOf("function usableInstallDir(") > 0 && rem.indexOf("function auditReportBusSources(") > 0, "remotion 有可用目录解析 + 注册后自检（现场取不到要留一行）");
  ok(rem.indexOf("installReportCtx") > 0 && rem.indexOf("renderReportCtx") > 0, "remotion 的安装 / 渲染上报都带 phase 与节点上下文（报告窗才指得出重跑谁）");
  ok(rem.indexOf('"busy_other_node"') > 0 && rem.indexOf('"missing_node_id"') > 0, "remotion 的并发被占与节点缺 id 也上报");
}
{
  /* 顶栏「插件」的下载 / 安装 / 更新链（非后端类）：失败也要弹窗 */
  const ap = read("plugins/main-app-plugins.js");
  ok(ap.indexOf('require("../plugin-error-repair.js")') > 0, "plugins/main-app-plugins.js 引用报错总线");
  ok(ap.indexOf("function ensureReportHost(") > 0, "窗口插件按需登记宿主（失败过一次才登记，不在启动期铺一堆）");
  ok(
    /ensureReportHost[\s\S]{0,600}getInstallDir:[\s\S]{0,120}pluginDir/.test(ap),
    "按需登记的宿主给出现场目录 = 该插件在 %APPDATA% 下的安装目录",
  );
  ok(/function ensureReportHost[\s\S]{0,700}getPluginHost\(sid\)\)\s*return/.test(ap), "同名 id 已被后端宿主占用时不覆盖既有入口");
  ok(ap.indexOf("function reportErr(id, code, message") > 0 && ap.indexOf("pluginErrors.reportPluginError(") > 0, "插件安装链的 reportErr 落到总线");
  ok(count(ap, /\breportErr\(/g) - 1 >= 2, "插件安装链接了上报（并发被拒 + 整条链 catch）");
  ok(ap.indexOf('phase: isWindowInstalled(id) ? "update" : "install"') > 0, "报告按实际动作分「安装失败 / 更新失败」");
  ok(ap.indexOf("function installFailHint(") > 0, "安装失败错误码翻译成中文是哪一步炸的（认不出只带原文，不编造）");
}

/* ────────────────────────── [2] 技能真源 ────────────────────────── */
console.log("\n[2] 安装技能真源唯一：根 skills/<name>/SKILL.md，宿主目录不留副本");
{
  const table = seg(dsh, "const INSTALL_SKILL_SOURCES = {", "\n}", "INSTALL_SKILL_SOURCES");
  for (const name of INSTALL_SKILLS) {
    ok(
      table.indexOf("'" + name + "': path.join(__dirname, '..', 'skills', '" + name + "', 'SKILL.md')") > 0,
      "INSTALL_SKILL_SOURCES[" + name + "] 指向仓库根 skills/ 真源",
    );
    const p = "skills/" + name + "/SKILL.md";
    ok(exists(p) && fs.statSync(path.join(ROOT, p.split("/").join(path.sep))).size > 4000, p + " 在盘上且非空壳");
  }
  ok(count(table, /SKILL\.md/g) === INSTALL_SKILLS.length, "映射表恰好 " + INSTALL_SKILLS.length + " 条（新增后端宿主时必须同步）");
  const sync = seg(dsh, "syncInstallSkills() {", "\n    },", "syncInstallSkills");
  ok(sync.indexOf("'.install-only'") > 0, "syncInstallSkills 给每个安装技能写 .install-only（不进用户技能列表 / 工坊）");
  ok(count(dsh, /INSTALL_SKILL_NAMES/g) >= 3, "INSTALL_SKILL_NAMES 在 skillList / skillAdd / skillGet 多处复用");
  /* 宿主侧下发路径必须与上表同一真源 */
  for (const h of HOSTS) {
    if (!h.fn) continue;
    const src = read(h.file);
    const body = seg(src, "function " + h.fn, "\n}", h.file + " " + h.fn);
    ok(body.indexOf("syncInstallSkills") > 0, h.file + " 的 " + h.fn + " 先叫网关统一同步（一份逻辑）");
    ok(
      /["']skills["']/.test(body) &&
        (h.skillConst ? body.indexOf("INSTALL_SKILL") > 0 : body.indexOf('"' + h.skill + '"') > 0) &&
        body.indexOf('"SKILL.md"') > 0,
      h.file + " 的兜底拷贝读仓库根 skills/" + h.skill + "/SKILL.md",
    );
    ok(!/h3[\\/]skills|music3[\\/]skills/.test(body), h.file + " 的兜底拷贝不指向宿主目录副本");
  }
  ok(!exists("h3/skills"), "h3/skills/ 旧副本目录已删除");
  ok(!exists("music3/skills"), "music3/skills/ 旧副本目录已删除");
  const scan = ["main.js", "preload.js", "plugin-error-repair.js", "build.json", "dsh/main-dsh.js"].concat(
    rendererFiles,
    HOSTS.map((h) => h.file),
  );
  const stray = scan.filter((f) => /h3[\\/]skills|music3[\\/]skills/.test(read(f)));
  ok(stray.length === 0, "全仓源码不再引用宿主目录下的技能副本（残留：" + show(stray) + "）");
}

/* ────────────────────────── [3] 打包白名单与入口 ────────────────────────── */
console.log("\n[3] 打包白名单与主进程入口");
{
  /* build.json 里带注释（electron-builder 容忍），不能 JSON.parse —— 直接抠 files 数组那一段 */
  const buildSrc = read("build.json");
  const filesBlock = seg(buildSrc, '"files": [', "\n  ],", "build.json files");
  ok(count(filesBlock, /^\s*"!\w/gm) > 5, "build.json files 读到了（含取反规则）");
  ok(filesBlock.indexOf('"plugin-error-repair.js"') > 0, "files 含 plugin-error-repair.js（漏了 = 打包后 Cannot find module）");
  ok(filesBlock.indexOf('"pet/main-pet.js"') > 0 && filesBlock.indexOf('"plugins/**"') > 0, "files 覆盖新接线的 pet/main-pet.js 与 plugins/**");
  for (const need of ["skills/**", "renderer/**", "h3/**", "music3/**", "tts/**", "llama/**", "asr/**", "remotion/**", "sensenova/**"]) {
    ok(filesBlock.indexOf('"' + need + '"') > 0, "files 含 " + need);
  }
  ok(mainJs.indexOf('require("./plugin-error-repair.js")') > 0, "main.js 引用总线模块");
  const at = mainJs.indexOf("initPluginErrorBus({");
  ok(at > 0, "main.js 调 initPluginErrorBus（注入主窗 getter）");
  ok(mainJs.indexOf("getMainWin: () => mainWin") > 0, "init 时给的是主窗口 getter（错误只送主窗一处）");
  for (const fn of ["registerMusic3Ipc(", "registerYueIpc(", "registerH3Ipc(", "registerLlamaIpc(", "registerTtsIpc(", "registerRemotionIpc(", "registerAsrIpc(", "registerSensenovaIpc("]) {
    ok(mainJs.indexOf(fn) > at, fn.replace("(", "") + " 排在总线 init 之后（后端宿主注册不丢第一批错误）");
  }
  /* 桌宠与插件安装链排在 init 之前：宿主表是模块级 Map，注册不丢；
     主窗 getter 还没注入时 sendToMainWindow 只静默返回 false（见 [4] 的「没窗口也不抛」）。 */
  ok(mainJs.indexOf("registerPetIpc(") > 0, "main.js 起桌宠宿主（BongoChat 因此进了总线）");
  ok(mainJs.indexOf("registerAppPluginsIpc(") > 0, "main.js 起插件安装链宿主（下载 / 更新失败因此进了总线）");
  /* 弹窗侧回执：preload 白名单里的两条 invoke 通道，主进程必须真有人接（否则渲染层吞异常 = 静默丢日志） */
  for (const ch of ["pluginRepair:report", "pluginRepair:result"]) {
    ok(mainJs.indexOf('ipcMain.handle("' + ch + '"') > 0, "main.js 注册 ipcMain handler：" + ch);
  }
  const ack = seg(mainJs, 'ipcMain.handle("pluginRepair:result"', "\n});");
  ok(ack.indexOf("resetDebounce(") > 0, "修复结论判成 repairOk 才清去抖（同类错误再犯要能重新弹一条）");
  ok(ack.indexOf('send("pluginRepair:done"') > 0, "修完向存活窗口广播 pluginRepair:done（控制台窗跟着刷新）");
  ok(ack.indexOf("errLog(") > 0, "修复结论落主日志（事后可复盘「报错 → 弹窗 → 修没修」）");
  ok(
    /const\s*\{[^}]*\bresetDebounce\b[^}]*\}\s*=\s*require\(["']\.\/plugin-error-repair\.js["']\)/.test(mainJs),
    "main.js 从总线解构了 resetDebounce（清去抖只有一个真源，不在别处自造）",
  );
}

/* ────────────────────────── [4] 总线行为（真跑） ────────────────────────── */
async function groupBus() {
  console.log("\n[4] 报错总线行为（真跑 plugin-error-repair.js）");
  const bus = require("../plugin-error-repair.js");
  const sent = [];
  const logs = [];
  const fakeWin = { isDestroyed: () => false, webContents: { send: (ch, e) => sent.push({ ch, e }) } };
  const inited = bus.initPluginErrorBus({ getMainWin: () => fakeWin, log: (l) => logs.push(l) });
  ok(inited && inited.ok === true, "initPluginErrorBus 在没有 Electron ipcMain 的环境下也返回 ok（不抛）");
  ok(bus.DEBOUNCE_MS === 60 * 1000, "去抖窗口 60s");
  const last = () => sent[sent.length - 1];

  let repairedWith = "";
  let repairVia = "";
  let restarts = 0;
  ok(
    bus
      .registerPluginHost({
        id: "smoke-host",
        name: "冒烟宿主",
        skillName: "smoke-install",
        getInstallDir: () => "D:\\smoke\\install",
        tailConsole: () => ({ ok: true, text: "line1\n\u001b[31mTraceback (most recent call last):\u001b[0m" }),
        selfRepair: async (o) => {
          repairedWith = String((o && o.error) || "");
          repairVia = String((o && o.via) || "");
          return { ok: true };
        },
        restart: async () => {
          restarts++;
          return { ok: true };
        },
      })
      .ok === true,
    "registerPluginHost 接受一个假宿主",
  );
  ok(
    bus.listPluginHosts().some((h) => h.id === "smoke-host" && h.hasSelfRepair && h.canRestart && h.installDir === "D:\\smoke\\install"),
    "listPluginHosts 给出 hasSelfRepair / canRestart / installDir",
  );

  const r1 = bus.reportPluginError("smoke-host", {
    code: "backend_exited",
    message: "后端进程启动后退出：exit 1",
    nodeId: "n42",
    nodeKind: "video_gen",
    canvasWorkflowId: "wf7",
    workflowName: "短片",
  });
  ok(r1.ok === true && r1.merged === false, "首次上报：新建事件（未合并）");
  /* 端到端契约（过去只分别钉两侧）：一次事件推两条 —— 先弹窗吃的扁平载荷，再原始事件 */
  const pair = sent.slice(-2);
  ok(pair.length === 2 && pair[0].ch === "pluginRepair:error" && pair[1].ch === "pluginError:report",
    "一次报错推两条：pluginRepair:error（弹窗）→ pluginError:report（原始事件），顺序固定");
  ok(last().ch === "pluginError:report", "原始事件仍是最后一个出口（老消费方读法不变）");
  const flat = pair[0].e;
  ok(
    ["pluginId", "pluginName", "kind", "skill", "installDir", "code", "message", "phase", "log", "nodeId", "nodeTitle", "nodeKind", "workflowId", "workflowName", "repairToken", "repairable", "why", "hasRestart", "count", "eventId", "at"].every((k) => k in flat),
    "扁平载荷字段齐（renderer/app-repair.js 的 pluginRepairNormalize 吃的就是这套名字）",
  );
  ok(flat.pluginId === "smoke-host" && flat.pluginName === "冒烟宿主" && flat.skill === "smoke-install", "扁平载荷带插件 id / 名称 / skill");
  ok(flat.code === "backend_exited" && flat.log === last().e.logTail, "扁平载荷把 logTail 改名成 log（弹窗侧字段）");
  ok(flat.nodeId === "n42" && flat.nodeKind === "video_gen" && flat.workflowId === "wf7", "扁平载荷带节点与画布");
  ok(/^rpt_/.test(flat.repairToken) && flat.repairable === true && flat.why === "", "可修：扁平载荷带 repairToken 且 why 为空");
  ok(flat.at === last().e.ts && flat.count === 1, "扁平载荷带发生时刻与计数（渲染层按 at 做 45s 去重）");
  ok(
    last().e.plugin.id === "smoke-host" && last().e.plugin.name === "冒烟宿主" && last().e.plugin.skillName === "smoke-install",
    "事件带插件 id / 名称 / skill",
  );
  ok(last().e.code === "backend_exited" && /exit 1/.test(last().e.message), "事件带错误码与错误正文");
  ok(
    last().e.node.id === "n42" && last().e.node.kind === "video_gen" && last().e.node.workflowId === "wf7",
    "事件带出问题的节点与所属画布（canvasWorkflowId 别名也吃）",
  );
  ok(last().e.installDir === "D:\\smoke\\install", "installDir 缺省时从宿主取（渲染层据此定可写工作区）");
  ok(last().e.logTail.indexOf("line1") === 0 && last().e.logTail.indexOf("\u001b[") < 0, "日志尾部去了 ANSI 码（进 UI 不是乱码）");
  ok(last().e.autoFix.repairable === true && /^rpt_/.test(last().e.autoFix.repairToken), "可修：发下一枚 repairToken");
  ok(last().e.autoFix.hasRestart === true, "事件标明该插件有可重启的后端");

  const r2 = bus.reportPluginError("smoke-host", { code: "backend_exited", message: "又退了一次" });
  ok(r2.merged === true && r2.count === 2 && r2.eventId === r1.eventId, "60s 内同插件同码只累加计数（同一 eventId）");
  ok(last().e.suppressed === true && last().e.count === 2 && last().e.eventId === r1.eventId, "合并推送带 suppressed:true（UI 只更计数，不再弹一次）");
  const countCh = (ch) => sent.filter((x) => x.ch === ch).length;
  ok(sent.length === 3 && countCh("pluginRepair:error") === 1, "合并事件只推原始通道（绝不再弹一次报告窗 —— 弹窗侧那 45s 去重之外还有一层闸）");
  ok(bus.reportPluginError("smoke-host", { code: "not_installed", message: "尚未安装" }).merged === false, "不同错误码不合并（各算一条事件）");

  for (const [code, kw] of [
    ["cancelled", "主动取消"],
    ["busy", "等它结束"],
    ["low_disk", "清理磁盘"],
    ["no_cuda", "NVIDIA"],
    ["driver_too_old", "驱动"],
    ["bad_dir", "安装目录"],
  ]) {
    bus.reportPluginError("smoke-host", { code, message: "冒烟：" + code });
    ok(last().e.autoFix.repairable === false && last().e.autoFix.repairToken === "", "不弹自动修复：" + code);
    ok(String(last().e.autoFix.why || "").indexOf(kw) >= 0, code + " 带回中文指路文案（含「" + kw + "」）");
    const f = sent[sent.length - 2];
    ok(f.ch === "pluginRepair:error" && f.e.repairable === false && f.e.repairToken === "" && f.e.why === last().e.autoFix.why,
      code + "：弹窗那一条同样带 repairable:false + why（置灰与指路由主进程一处定，渲染层不再抄错误码）");
  }
  bus.reportPluginError("smoke-host", { code: "install_cancelled", message: "x" });
  ok(last().e.code === "cancelled", "历史别名 install_cancelled 归一到 cancelled");
  bus.reportPluginError("smoke-host", { error: "Traceback (most recent call last): ModuleNotFoundError: soundfile" });
  ok(last().e.code === "python_env_broken", "整段异常文本兜底识别成 python_env_broken（不拿长文本当错误码）");
  ok(bus.judgeRepairability(null, "backend_exited", "x").repairable === false, "宿主没进总线时判不可修（连现场都取不到，修什么）");
  /* 会话修复优先：可修性不再以「有没有隐藏 selfRepair」为门槛 —— remotion / 桌宠这类没有 Agent 安装链
     的宿主也必须有「让 AI 修一次」这条路（弹窗里新建可见会话，工作区 = INSTALL_DIR）。 */
  ok(
    bus.judgeRepairability({ getInstallDir: () => "D:\\no\\hidden" }, "backend_exited", "x").repairable === true,
    "有 INSTALL_DIR、没有 selfRepair 的宿主 → 判可修（会话修复优先）",
  );
  ok(
    bus.judgeRepairability({ tailConsole: () => "log" }, "backend_exited", "x").repairable === true,
    "只有日志尾部、没有目录与 selfRepair → 也判可修（现场至少有一份）",
  );
  ok(
    bus.judgeRepairability({ name: "x" }, "backend_exited", "x").repairable === false &&
      /INSTALL_DIR/.test(bus.judgeRepairability({ name: "x" }, "backend_exited", "x").why),
    "目录与日志都没有 → 不可修，且 why 说清「没有可写工作区」（指回控制台）",
  );
  {
    /* 隐藏回落路径（pluginError:repair）如实拒绝，并指回弹窗那颗「自动修复」 */
    bus.registerPluginHost({
      id: "smoke-visible-only",
      name: "只有可见会话",
      getInstallDir: () => "D:\\visible\\only",
      tailConsole: () => ({ ok: true, text: "boom" }),
    });
    bus.reportPluginError("smoke-visible-only", { code: "backend_exited", message: "没有隐藏入口也能修" });
    const vFlat = sent[sent.length - 2].e;
    ok(vFlat.repairable === true && /^rpt_/.test(vFlat.repairToken), "无 selfRepair 的宿主照样拿到 repairToken（弹窗里按钮按得下去）");
    const vRep = await bus.runRepairByToken(vFlat.repairToken, "");
    ok(vRep.ok === false && vRep.error === "no_hidden_repair", "隐藏通道对这类宿主如实拒绝：no_hidden_repair（不假装修了）");
    ok(/自动修复/.test(String(vRep.message || "")), "拒绝文案指回弹窗那颗「自动修复」（可见会话才是主路径）");
  }

  bus.reportPluginError("smoke-host", { code: "no_venv", message: "venv 还没装好" });
  const token = last().e.autoFix.repairToken;
  ok(/^rpt_/.test(token), "no_venv 这条错误拿到 token");
  const rep = await bus.runRepairByToken(token, "补充：soundfile 也装不上");
  ok(rep.ok === true && rep.hostId === "smoke-host" && rep.code === "no_venv", "runRepairByToken 交宿主 selfRepair 并回执 hostId / code");
  ok(repairedWith.indexOf("venv 还没装好") >= 0 && repairedWith.indexOf("补充说明") >= 0, "selfRepair 收到错误正文 + 用户补充说明");
  ok(repairVia === "pluginErrorBus", "selfRepair 被告知来源 via=pluginErrorBus（宿主可少弹自己那套提示）");
  ok(sent.some((x) => x.e && x.e.kind === "repairResult" && x.e.state === "start"), "修复开始回推 repairResult(start)（UI 能显示进行中）");
  ok(
    !sent.some((x) => x.ch === "pluginRepair:error" && x.e && x.e.kind === "repairResult"),
    "修复回执不推弹窗通道（否则会话刚跑起来那一刻又会弹一只「插件出错」）",
  );
  const rep2 = await bus.runRepairByToken(token);
  ok(rep2.ok === false && rep2.error === "repair_token_expired", "同一 token 不能用第二次（防连点把会话叠起来）");
  ok((await bus.runRepairByToken("rpt_nope")).error === "repair_token_expired", "假 token 一律拒绝");
  ok((await bus.runRepairByToken("")).error === "repair_token_expired", "空 token 一律拒绝");

  ok((await bus.restartByToken("")).error === "no_restart", "没 token 时不猜宿主：no_restart");
  bus.reportPluginError("smoke-host", { code: "backend_start_timeout", message: "启动超时" });
  const rst = await bus.restartByToken(last().e.autoFix.repairToken);
  ok(rst.ok === true && restarts === 1, "restartByToken 调宿主 restart 一次（修完自动重启服务的落点）");

  const ghost = bus.reportPluginError("smoke-ghost", { code: "whatever", message: "没人注册" });
  ok(ghost.ok === true && last().e.plugin.id === "smoke-ghost" && last().e.autoFix.repairable === false, "未注册宿主：报告照发、不弹自动修复、不抛异常");
  ok(bus.reportPluginError("", { message: "" }).ok === true, "空 id / 空 payload 也不抛（宿主主流程永不受影响）");
  bus.registerPluginHost({
    id: "smoke-host",
    tailConsole: () => "纯字符串日志",
    selfRepair: async () => ({ ok: false, error: "agent_failed" }),
  });
  bus.reportPluginError("smoke-host", { code: "custom_workflow_missing", message: "工作流不存在" });
  const rep3 = await bus.runRepairByToken(last().e.autoFix.repairToken);
  ok(rep3.ok === false, "宿主 selfRepair 报失败时如实回失败（不粉饰成成功 → 渲染层就不会去重启服务）");
  bus.resetDebounce("smoke-host", "backend_exited");
  ok(bus.reportPluginError("smoke-host", { code: "backend_exited", message: "修好后再犯" }).merged === false, "resetDebounce 后同类错误能重新弹一条（修好了再坏要看得见）");
  ok(logs.some((l) => /\[plugin-error\]/.test(l)), "总线日志走注入的 log（本模块不写任何文件）");
  const busSrc = read("plugin-error-repair.js");
  for (const ch of ["pluginError:listHosts", "pluginError:repair", "pluginError:restart", "pluginError:dismiss"]) {
    ok(busSrc.indexOf('ipcMain.handle("' + ch + '"') > 0, "Electron 下注册的 IPC 通道含 " + ch);
  }
  ok(busSrc.indexOf("w.webContents.send(") > 0, "推送只写在 sendToMainWindow 里（错误不各窗各发一套）");
  const sendSeg = seg(busSrc, "function sendToMainWindow(event) {", "\n}");
  ok(count(sendSeg, /webContents\.send\(/g) === 2 && count(busSrc, /webContents\.send\(/g) === 2, "全模块只有这一处出口、发两条通道（弹窗 + 原始事件），别处不再偷偷多推");
  ok(sendSeg.indexOf('send("pluginRepair:error", repairDialogPayload(event))') > 0 && sendSeg.indexOf('send("pluginError:report", event)') > 0, "两条通道的先后与载荷来源固定：扁平载荷由 repairDialogPayload 现算");
  ok(/!event\.suppressed/.test(sendSeg) && /event\.eventId/.test(sendSeg), "合并计数不重复推弹窗通道（闸在总线上，不依赖渲染层去重）");
  ok(sendSeg.indexOf("} catch {}") > 0, "弹窗那条 send 单独吞异常（它挂了也不影响原始事件与宿主主流程）");
  ok(busSrc.indexOf("function repairDialogPayload(ev)") > 0, "映射函数在总线上（弹窗侧不必再猜字段名）");
  ok(/kind: "repairResult"/.test(busSrc), "修复回执事件带 kind=repairResult（只走原始通道，见 sendToMainWindow）");
  ok(typeof bus.repairDialogPayload === "function", "repairDialogPayload 有导出（冒烟与文档据此钉两端契约）");
}

/* ────────────────────────── [5]..[10]（同步组，排在 [4] 之后跑，保持编号顺序） ────────────────────────── */
function groupTail() {
  console.log("\n[5] 渲染层入口：preload 三桥 + 启动即订阅 + 脚本与样式接入");
  {
    ok(preload.indexOf("onPluginRepairError: (cb) => {") > 0, "preload 暴露 onPluginRepairError（主进程 push → 渲染层）");
    ok(
      preload.indexOf("ipcRenderer.on('pluginRepair:error'") > 0 && preload.indexOf("removeListener('pluginRepair:error'") > 0,
      "订阅返回退订函数（不留重复监听）",
    );
    ok(preload.indexOf("pluginRepairReport: (payload) => ipcRenderer.invoke('pluginRepair:report'") > 0, "preload 暴露 pluginRepairReport（本窗处理回执）");
    ok(preload.indexOf("pluginRepairResult: (payload) => ipcRenderer.invoke('pluginRepair:result'") > 0, "preload 暴露 pluginRepairResult（修复结论回主进程）");
    ok(repair.indexOf("window.api.onPluginRepairError(pluginRepairHandleError)") > 0, "app-repair.js 脚本加载即订阅（不等插件对话框打开）");
    ok(repair.indexOf("PLUGIN_REPAIR_DUP_MS = 45 * 1000") > 0, "同一条错误 45s 去重（上游重试链不刷窗）");
    ok(repair.indexOf("_pluginRepairQueue") > 0 && repair.indexOf("pluginRepairOverlayBusy()") > 0, "#overlay 被占时排队显示，绝不顶掉用户改到一半的窗");
    const html = read("renderer/index.html").replace(/<!--[\s\S]*?-->/g, "\n");
    ok(html.indexOf('<script src="app-repair.js">') > html.indexOf('<script src="app-plugins.js">'), "index.html：app-repair.js 挂在 app-plugins.js 之后");
    ok(read("renderer/style.css").indexOf("./css/repair.css") > 0, "style.css @import css/repair.css");
    const css = read("renderer/css/repair.css");
    ok(css.indexOf(".plg-repair-") > 0, "repair.css 用 .plg-repair-* 前缀（不污染既有样式）");
    ok(css.indexOf("theme-light") > 0, "repair.css 带亮色主题覆盖");
    ok(count(repair, /catch \(_\)/g) >= 6, "回执与副作用一律吞异常（主进程 handler 没接上也不炸）");
  }

  console.log("\n[6] 两只窗都是 persistent（点外部 / 点蒙层一律不关）");
  {
    const dlg = seg(repair, "function openPluginRepairDialog", "function pluginRepairClose(");
    const res = seg(repair, "function openPluginRepairResultDialog", "function pluginRepairShowResultReport");
    for (const [name, s] of [["错误报告窗", dlg], ["修复结果窗", res]]) {
      ok(s.indexOf("overlayPersistent = true;") > 0, name + "：显式声明 persistent");
      ok(s.indexOf("ev.target === ") < 0, name + "：窗体内没有「比中宿主就关」的路径");
    }
    ok(count(repair, /addEventListener\(\s*["'](mousedown|click|pointerdown)/g) === 0, "app-repair.js 不挂任何文档级 / 窗级外部点击监听");
    ok(count(repair, /closeOverlay\(\)/g) === 3, "关窗只在显式路径里（本模块共 3 处 closeOverlay 调用）");
    ok(dlg.indexOf('I18n.t("插件出错")') > 0, "报告窗标题 = 插件出错 · <插件名>");
    ok(dlg.indexOf("pluginRepairBlockedReason(info)") > 0 && dlg.indexOf("disabled: !canRepair") > 0, "置灰只看一个真源：blocked（= 主进程 repairable/why + 可写工作区），不是点了才报错");
    ok(dlg.indexOf("if (blocked) pluginRepairHint(body, I18n.t(blocked))") > 0, "不可修时窗内直接把 why 显示成指路文案（不是只灰个按钮）");
    ok(/:\s*blocked\s*\?\s*blocked/.test(dlg), "按钮 tooltip 在不可修时就是那句 why（悬停也知道为什么按不动）");
    ok(dlg.indexOf("🤖 自动修复") > 0 && dlg.indexOf("打开控制台看日志") > 0 && dlg.indexOf("忽略") > 0, "三颗按钮齐：自动修复 / 打开控制台看日志 / 忽略");
    ok(dlg.indexOf("pluginRepairDetails(") > 0, "日志尾部与失败焦点是可折叠 details（长日志不撑爆窗）");
    ok(res.indexOf("pluginRepairRun(") < 0 && res.indexOf("🤖 自动修复") < 0, "修复结果窗里没有「自动修复」按钮（结构上不可能成环）");
    const CLOSEISH = /(?:\bclose[A-Za-z]*|\bfinish)\s*\(/;
    const hits = [];
    for (const f of rendererFiles) {
      const lines = read(f).split("\n");
      lines.forEach((L, i) => {
        if (!/if\s*\(\s*(?:ev|e)\.target\s*===/.test(L)) return;
        const blk = lines.slice(i, i + 4).join(" ");
        if (!CLOSEISH.test(blk)) return;
        if (blk.includes("closeImageLightbox")) return;
        hits.push(f + ":" + (i + 1));
      });
    }
    ok(hits.length === 0, "全 renderer/ 扫描（含本模块）：点空白即关只剩图片灯箱（命中：" + show(hits) + "）");
  }

  console.log("\n[7] 修复提示词与「修完重启」的服务表");
  {
    const prompt = seg(repair, "function pluginRepairPromptText", "function pluginRepairVerdictFromText");
    ok(prompt.indexOf('I18n.t("请使用 skill「")') > 0 && prompt.indexOf("info.skill") > 0, "提示词第一句就点名用哪个 skill");
    ok(prompt.indexOf("【自我修复】") > 0, "提示词要求走 skill 的【自我修复】模式（口径真源在 skill 正文）");
    ok(prompt.indexOf("INSTALL_DIR=") > 0 && prompt.indexOf("info.installDir") > 0, "提示词给出可写工作区 INSTALL_DIR");
    ok(prompt.indexOf("SCAFFOLD_REF") > 0, "提示词区分 SCAFFOLD_REF（仅参考，不改那个目录）");
    ok(prompt.indexOf("info.code") > 0 && prompt.indexOf("出问题的节点") > 0 && prompt.indexOf("所属画布") > 0, "提示词带错误码与节点 / 画布上下文");
    ok(prompt.indexOf("info.focus") > 0 && prompt.indexOf("最近失败焦点") > 0, "提示词以「最近失败焦点」为准（更早的 Traceback 可能已过时）");
    ok(
      prompt.indexOf("只允许修改 INSTALL_DIR 内的文件") > 0 &&
        prompt.indexOf("不要启动后端服务") > 0 &&
        prompt.indexOf("output/") > 0 &&
        prompt.indexOf("勿重复下载") > 0,
      "提示词四条纪律齐（只改安装目录 / 不自行启动服务 / 不删产物 / 模型齐了勿重下）",
    );
    ok(prompt.indexOf("repair_ok=1") > 0 && prompt.indexOf("info.marker") > 0 && prompt.indexOf("info.resultFile") > 0, "提示词要求回写标记 + 结果文件 + 回复 repair_ok=1");
    ok(prompt.indexOf("ok=false") > 0 && prompt.indexOf("reason=") > 0, "修不动要求 ok=false + reason=（结论得能被判定）");

    const skillTable = seg(repair, "const PLUGIN_REPAIR_SKILLS = {", "\n};");
    for (const h of HOSTS) if (h.skill) ok(skillTable.indexOf('"' + h.skill + '"') > 0, "PLUGIN_REPAIR_SKILLS 覆盖 " + h.skill);
    const svcTable = seg(repair, "const PLUGIN_REPAIR_SERVICE_BASE = {", "\n};");
    ok(/remotion:\s*\{[\s\S]{0,220}resident: false/.test(svcTable), "Remotion 标 resident:false（无常驻服务 → 改成重跑节点）");
    for (const fn of ["h3Start", "h3Stop", "h3Status", "music3Start", "music3Stop", "music3Status", "yue2Start", "yue2Stop", "yue2Status", "ttsStart", "ttsStop", "ttsStatus", "llamaStart", "llamaStop", "llamaStatus", "asrStart", "asrStop", "asrStatus"]) {
      ok(svcTable.indexOf('"' + fn + '"') > 0 && new RegExp("\\n\\s*" + fn + ":").test(preload), "重启表里的 " + fn + " 在 preload 真有这个桥");
    }
    for (const fn of ["refreshH3PluginCard", "refreshMusic3PluginCard", "refreshYuePluginCard", "refreshTtsPluginCard", "refreshLlamaPluginCard", "refreshAsrPluginCard", "refreshRemotionPluginCard", "refreshPetPluginCard"]) {
      ok(read("renderer/app-plugins.js").indexOf("async function " + fn) > 0, "卡片刷新口 " + fn + " 存在（修完就地刷那张卡）");
    }
    /* 「所有插件都接了自我修复」的硬口径：插件目录里每张卡片都要在渲染层服务表查得到条目 */
    {
      const svcSb = { Object, Array, String, JSON };
      vm.createContext(svcSb);
      vm.runInContext(
        [seg(repair, "const PLUGIN_REPAIR_SERVICE_BASE = {", "\n};") + "\n};", seg(repair, "const PLUGIN_REPAIR_SERVICE = (function", "\n})();") + "\n})();"].join("\n"),
        svcSb,
      );
      const cards = JSON.parse(read("plugins/catalog.default.json")).plugins.map((p) => p.id);
      ok(cards.length >= 8, "插件目录读到 " + cards.length + " 张卡片（解析没空转）");
      for (const id of cards) {
        const e = vm.runInContext("PLUGIN_REPAIR_SERVICE[" + JSON.stringify(id) + "]", svcSb);
        ok(!!e, "卡片 " + id + " 在修复服务表里查得到条目（报告窗指得出控制台 / 卡片 / 收尾方式）");
        if (e)
          ok(
            e.resident ? !!(e.start && e.stop && e.status) : !e.start && !!e.card,
            "卡片 " + id + (e.resident ? "：常驻服务 → 重启三件套齐" : "：无常驻服务 → 不配重启入口，改走重跑 / 刷卡片收尾"),
          );
      }
    }
    ok(svcTable.indexOf('".h3-agent-result"') > 0, "结果文件兼容清单含宿主既有的 .h3-agent-result 命名");
    ok(/await api\[svc\.status\]\(\)/.test(repair) && /await api\[svc\.stop\]\(\)/.test(repair), "重启前先 status → stop（不留半死旧进程）");
    ok(repair.indexOf("pluginRepairRerunNode") > 0 && repair.indexOf("playNode") > 0, "无常驻服务的插件（Remotion）修完改成重跑报错节点");
    ok(repair.indexOf("_pluginRepairAutoUsed") > 0 && repair.indexOf("function pluginRepairClaimAuto") > 0, "一条 repairToken 只发一次自动修复额度");
    ok(repair.indexOf("_pluginRepairReportShown") > 0 && repair.indexOf("function pluginRepairClaimReport") > 0, "二次报告窗也只发一次（报错风暴的闸门）");
    ok(repair.indexOf('I18n.t("服务已重启")') > 0, "重启成功给「<插件> 服务已重启」toast");
    ok(/修复完成，但服务重启失败/.test(repair), "重启失败只 toast 不重试（真修好了只是拉不起来，不必再弹窗）");

    /* 判定三态真跑：从源码抠函数进 vm */
    const sb = { console, JSON, String, RegExp, Array, Number };
    vm.createContext(sb);
    vm.runInContext(
      [fnBody(repair, "pluginRepairVerdictFromText"), fnBody(repair, "pluginRepairReasonFromText"), fnBody(repair, "pluginRepairJoinPath")].join("\n"),
      sb,
    );
    const run = (e) => vm.runInContext(e, sb);
    ok(run('pluginRepairVerdictFromText("已修复依赖，repair_ok=1")') === true, "判定：repair_ok=1 → 成功");
    ok(run('pluginRepairVerdictFromText("install_ok=1")') === true, "判定：安装链那套 install_ok=1 也算成功");
    ok(run('pluginRepairVerdictFromText("结果文件首行 ok=true")') === true, "判定：ok=true → 成功");
    ok(run('pluginRepairVerdictFromText("ok=false reason=no soundfile")') === false, "判定：ok=false → 失败");
    ok(run('pluginRepairVerdictFromText("ok=true\\n最后又写了 ok=false")') === false, "判定：明确失败记号压过成功（宁可不去重启）");
    ok(run('pluginRepairVerdictFromText("我改了几个文件，你看看")') === null, "判定：正文没结论 → null（判不出来就不重启）");
    ok(run('pluginRepairReasonFromText("ok=false\\nreason=缺 soundfile")') === "缺 soundfile", "判定：reason= 摘得出来（进二次报告窗）");
    ok(run('pluginRepairJoinPath("D:\\\\x\\\\", ".h3-agent-result")') === "D:\\x\\.h3-agent-result", "结果文件路径拼接吃 Windows 反斜杠且不重复分隔符");
    ok(run('pluginRepairJoinPath("", ".agent-repair-result")') === ".agent-repair-result", "没给 INSTALL_DIR 时退化成相对名（上层已禁用自动修复，不崩）");
    /* 载荷归一：主进程给 id 还是 kind 都接得住，节点标题只按 id 现查、绝不瞎编 */
    const nm = seg(repair, "function pluginRepairNormalize", "\n}");
    ok(nm.indexOf("p.pluginId, p.plugin, p.id") > 0 && nm.indexOf("p.logTail") > 0 && nm.indexOf("p.errCode") > 0, "归一函数吃多种字段别名（logTail / errCode / …）");
    ok(nm.indexOf('p.markerFile) || ".repair-ok"') > 0 && nm.indexOf('p.resultMarker) || ".agent-repair-result"') > 0, "主进程没点名就用通用标记名（不抢插件自己的 .install-ok）");
    ok(nm.indexOf('typeof nodeById === "function"') > 0 && nm.indexOf('typeof S === "object"') > 0, "节点标题 / 画布名只在拿得到时补（拿不到不显示，绝不编）");
    ok(nm.indexOf('typeof p.repairable === "boolean" ? p.repairable : null') > 0, "repairable 严格三态：只采信布尔，缺字段 = null（老宿主、不走总线的直推不 regress）");
    ok(nm.indexOf("p.why, p.whyNot, p.notRepairableWhy") > 0, "why 吃多种别名（指路文案不会莫名变空）");
    const blk = seg(repair, "function pluginRepairBlockedReason", "\n}");
    ok(blk.indexOf("info.repairable === false") > 0 && /String\(info\.why/.test(blk), "置灰第一优先级 = 主进程说了不可修，文案原样用它的 why（错误码清单不在渲染层抄第二份）");
    ok(blk.indexOf("if (!info.installDir)") > 0, "第二道闸：没有可写工作区（INSTALL_DIR）仍拦下来 —— 主进程判「值不值得修」，本层管「修的地方在哪」");
    ok(seg(repair, "async function pluginRepairRun", "\n  if (!pluginRepairClaimAuto").indexOf("if (blocked)") > 0, "pluginRepairRun 入口守卫也走 blocked（绕过按钮直接调修复口也修不动）");
    const svcPet = seg(repair, "const PLUGIN_REPAIR_SERVICE_BASE = {", "\n};");
    ok(/pet:\s*\{[\s\S]{0,260}resident: false[\s\S]{0,260}bongochat/.test(svcPet), "桌宠进了服务表（resident:false → 修完不重启服务，刷那张卡就行）");
    ok(/remotion:\s*\{[\s\S]{0,220}resident: false/.test(svcPet) && /pet:\s*\{[\s\S]{0,220}resident: false/.test(svcPet), "remotion 与桌宠都标 resident:false（无常驻服务 → 收尾改成重跑，不空等重启）");
    const alias = seg(repair, "const PLUGIN_REPAIR_SERVICE = (function expandPluginRepairService", "\n})();");
    ok(/pet:\s*\[[^\]]*"bongochat"/.test(alias), "别名表把 bongochat / deskpet 归到 pet（卡片 id 与查表口径一致）");
    ok(seg(repair, "const PLUGIN_REPAIR_SKILLS = {", "\n};").indexOf("remotion") < 0, "PLUGIN_REPAIR_SKILLS 故意不含 remotion（没有配套 skill → 提示词走「自行判断根因」分支）");
    ok(repair.indexOf("没有配套的内置 skill") > 0, "无配套 skill 的插件有专门提示词分支（桌宠与 remotion 就靠它）");
  }

  console.log("\n[8] H3 安装链与自修复提示词符合当前方案");
  {
    const req = seg(h3, "const requirements = [", "].join");
    ok(req.indexOf("NANFENG_NODE_PKG") > 0 && req.indexOf("Deploy-LocalCustomNode") > 0 && req.indexOf("*.api.py") > 0, "要件含南风节点包部署（保留 web/ + *.api.py）");
    ok(req.indexOf("import soundfile") > 0, "要件含 venv 内 import soundfile 自检");
    ok(req.indexOf("latent_upscale_models") > 0 && req.indexOf("占位") > 0, "要件含 latent_upscale_models ≥1 文件（幂等占位，不删真实模型）");
    ok(req.indexOf("POST_MODELS.upscale") > 0 && req.indexOf("POST_MODELS.rife") > 0 && req.indexOf("ComfyUI-Frame-Interpolation") > 0, "要件含 4K 后处理两份权重落点");
    ok(req.indexOf("REQUIRED_CUSTOM_NODE_DIRS") > 0 && req.indexOf("OPTIONAL_CUSTOM_NODE_DIRS") > 0, "要件区分必装 custom_nodes 与备用（TeaCache 不再算缺项）");
    ok(req.indexOf("2.9.1") > 0 && req.indexOf("cu130") > 0 && req.indexOf("comfy_kitchen") > 0, "要件含 torch ≥2.9.1+cu130 硬校验与 comfy_kitchen 自检");
    ok(req.indexOf("-m app") > 0, "要件要求收尾前自跑 python -m app 并回报退出码");
    ok(
      ["1)", "2)", "3)", "4)", "5)", "6)", "7)", "8)", "9)", "10)", "11)", "12)"].every((k) => req.indexOf(k) > 0),
      "交付要件编号 1)–12) 齐（一条一句，Agent 才有一条条可交付的东西）",
    );
    const disc = seg(h3, "const disciplines =", "const handoff");
    for (const keep of ["不要启动 ComfyUI", "output/", "勿重下", "Sage"]) {
      ok(disc.indexOf(keep) > 0, "四条纪律保留其一：「" + keep + "」");
    }
    const sp = seg(h3, "const prompt = opts.selfRepair", "handoff;");
    ok(sp.indexOf("请使用 skill「minimax-h3-install」的【自我修复】模式") > 0, "自我修复支点名 skill + 模式");
    ok(sp.indexOf("INSTALL_DIR=${installDir}") > 0 && sp.indexOf("SCAFFOLD_REF=${pack}") > 0, "自我修复支给出可写目录与仅参考脚手架");
    ok(sp.indexOf("requirements") > 0 && sp.indexOf("逐条") > 0, "自我修复支也逐条下达交付要件（已满足的直接跳过）");
    ok(sp.indexOf("repair_ok=1") > 0, "自我修复支要求回 repair_ok=1（与渲染层判定的记号同一套）");
    ok(h3.indexOf("install_ok=1") > 0 && h3.indexOf("const handoff =") > 0, "安装支的回写记号是 install_ok=1（两套判据各归各）");
    const sig = seg(h3, "function projectSignals", "\n}");
    ok(sig.indexOf("nanfeng") > 0 && sig.indexOf("latentFiles") > 0 && sig.indexOf("installComplete") > 0, "projectSignals 扩出南风 / latent / installComplete");
    ok(h3.indexOf("function installDeliverableGaps") > 0, "缺项翻译成中文条目（进收尾 reason）");
    ok(h3.indexOf("function healthCheckInstall") > 0, "健康检查函数就位（python -m app）");
    ok(h3.indexOf("deliverable_missing") > 0 && h3.indexOf("health_check_failed") > 0, "收尾两条失败路径各有 reason");
    ok(/installComplete[\s\S]{0,1600}healthCheckInstall/.test(h3), "成功判定：要件齐了才跑健康检查（只看 .install-ok 不再算成功）");
    ok(h3.indexOf("failWith") > 0 && h3.indexOf(".h3-agent-result") > 0, "失败也回写结果文件（ok=false + reason=）并取消 Agent 会话");
    ok(h3.indexOf("noteCpuVaeLaunchFailure") > 0 && h3.indexOf("cpuVaeFailHinted") > 0, "带 --cpu-vae 启动失败时记一条指回技能的提示（进程内一次）");
    ok(/function defaultConfig[\s\S]{0,1400}cpuVae: false/.test(h3), "defaultConfig().cpuVae = false（与技能口径一致）");
    ok(h3.indexOf("!!cfg.cpuVae") > 0 || h3.indexOf("launchCpuVae") > 0, "启动参数按实际值决定，不再「默认兜成开」");
    const uiHtml = read("h3/ui/index.html");
    ok(/<input[^>]*id="optCpuVae"[^>]*>/.test(uiHtml) && !/<input[^>]*id="optCpuVae"[^>]*checked/.test(uiHtml), "控制台 #optCpuVae 不再默认勾选");
    ok(uiHtml.indexOf("dtype") > 0 && uiHtml.indexOf("南风") > 0, "该选项文案写明开了会怎样（dtype 崩 / 南风链不可用）");
    ok(read("h3/ui/ui.js").indexOf("!!st.cpuVae") > 0, "ui.js 回显口径与后端一致");

    ok(skillH3.indexOf("EASY_SAFE") > 0 && skillH3.indexOf("0.08") > 0 && skillH3.indexOf("0.30") > 0 && skillH3.indexOf("0.90") > 0, "技能 EasyCache 档 = 实现真源口径并指向 EASY_SAFE");
    ok(skillH3.indexOf("0.95") > 0 && skillH3.indexOf("官方默认") > 0, "技能说明官方默认档为何在 H3 20 步下会坏（别改回去）");
    ok(skillH3.indexOf("h3:postProcess") > 0 && skillH3.indexOf("VHS_VideoCombine") > 0 && skillH3.indexOf("per_batch") > 0, "技能把 4K 后处理写成独立通道（生成链不再内联 VHS）");
    ok(skillH3.indexOf("--cpu-vae") > 0 && skillH3.indexOf("默认关") > 0, "技能：--cpu-vae 默认关闭，开启必致 dtype 崩");
    ok(skillH3.indexOf("VRAM_SAFE_MAX_DIM") > 0 && skillH3.indexOf("1280") > 0 && skillH3.indexOf("0.98") > 0, "技能写清 24G 分辨率红线（超限是自动钳制，不是故障）");
    ok(skillH3.indexOf("chainDenoise") > 0 && skillH3.indexOf("chainFrames") > 0, "技能记内置 fl2va 分段衔接子图契约");
    ok(skillH3.indexOf("outputRes") > 0, "技能说明 outputRes 档位与红线的先后");
    ok(skillH3.indexOf("python -m app") > 0, "技能把 python -m app 当完成判定（与收尾判定同一口径）");
    ok(skillH3.indexOf("soundfile") > 0 && skillH3.indexOf("nanfeng_prompt_nodes_v10") > 0, "技能覆盖南风包与 soundfile");
    ok(skillH3.indexOf("自我修复") > 0, "技能有【自我修复】章节（弹窗那条链指的就是它）");
  }

  console.log("\n[9] i18n：app-repair.js 的字面量与主进程 why 文案在英文档逐条命中");
  {
    const I18n = require("../renderer/i18n.js");
    I18n.setLocale("en");
    const keys = new Set();
    const re = /I18n\.t\(\s*"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = re.exec(repair))) {
      try {
        keys.add(JSON.parse('"' + m[1] + '"'));
      } catch (_) {}
    }
    const missing = [...keys].filter((k) => /[一-鿿]/.test(k) && I18n.t(k) === k);
    ok(keys.size >= 60, "扫到 app-repair.js 的 I18n.t 字面量 " + keys.size + " 条（≥60 = 扫描没空转）");
    ok(missing.length === 0, "英文词条全覆盖（缺失：" + show(missing.slice(0, 6)) + "）");
    /* 窗内还有一句是**动态**过 I18n.t 的：blocked / why 来自主进程（渲染层没有字面量可扫）——
       所以「为什么按不动」那句指路文案必须在英文档有译文，否则英文界面会回落中文。 */
    const busSrc = read("plugin-error-repair.js");
    const nb = seg(busSrc, "const NOT_REPAIRABLE = {", "\n};");
    const notRepairable = {};
    const kre = /([A-Za-z_]\w*)\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    let km;
    while ((km = kre.exec(nb))) notRepairable[km[1]] = JSON.parse('"' + km[2] + '"');
    const codes = Object.keys(notRepairable);
    ok(codes.length >= 15, "NOT_REPAIRABLE 读到 " + codes.length + " 条（解析没空转）");
    const bus = require("../plugin-error-repair.js");
    const whys = [
      ...new Set([
        ...Object.values(notRepairable),
        bus.judgeRepairability(null, "backend_exited", "x").why,
        bus.judgeRepairability({ name: "无现场宿主" }, "backend_exited", "x").why,
      ]),
    ].filter((s) => /[一-鿿]/.test(String(s)));
    ok(whys.length >= codes.length + 2, "收集到全部指路文案（清单 " + codes.length + " 条 + judgeRepairability 两条 → 实收 " + whys.length + " 条）");
    const whyMissing = whys.filter((k) => I18n.t(k) === k);
    ok(whyMissing.length === 0, "主进程 why 文案在英文档逐条有译文（缺失：" + show(whyMissing.map((s) => s.slice(0, 24))) + "）");
    const i18nSrc = read("renderer/i18n.js");
    const whyUnpinned = whys.filter((k) => i18nSrc.indexOf(JSON.stringify(k)) < 0);
    ok(whyUnpinned.length === 0, "这些译文确实写在 i18n.js 里（不是靠 t() 回落混过去：" + show(whyUnpinned.map((s) => s.slice(0, 24))) + "）");
  }

  console.log("\n[10] 文档收口");
  {
    ok(exists("docs/plugin-auto-repair.md"), "docs/plugin-auto-repair.md 存在");
    const doc = exists("docs/plugin-auto-repair.md") ? read("docs/plugin-auto-repair.md") : "";
    for (const kw of ["plugin-error-repair.js", "app-repair.js", "自动修复", "重启", "不弹自动修复", "smoke-plugin-repair"]) {
      ok(doc.indexOf(kw) > 0, "plugin-auto-repair.md 讲到「" + kw + "」");
    }
    const zh = read("guides/manual/media-gen.md");
    const en = read("guides/manual/en/media-gen.md");
    ok(zh.indexOf("## 插件报错弹窗与自动修复") > 0, "中文手册补了「插件报错弹窗与自动修复」一节");
    ok(en.indexOf("## Plugin error dialogs and auto-repair") > 0, "英文手册补同名一节");
    ok(/服务已重启/.test(zh) && /restart/i.test(en), "两版都写了「修完自动重启该服务」");
    ok(zh.indexOf("INSTALL_DIR") > 0 && en.indexOf("INSTALL_DIR") > 0, "两版都写了修复会话的工作区 = INSTALL_DIR");
    for (const f of ["guides/nodes/video_gen.md", "guides/nodes/music_gen.md", "guides/nodes/tts_gen.md"]) {
      ok(read(f).indexOf("插件报错弹窗") > 0, f + " 的错误提示同步（指向报错弹窗与自动修复）");
    }
    for (const f of ["guides/nodes/en/video_gen.md", "guides/nodes/en/music_gen.md", "guides/nodes/en/tts_gen.md"]) {
      ok(read(f).indexOf("Plugin error dialog") > 0, f + " 同步英文版");
    }
    /* 节点指南由 guides/nodes/_write.mjs 生成：磁盘正文已比内嵌模板新 → 必须进 diskOwned，否则重生成会覆盖回去 */
    const owned = seg(read("guides/nodes/_write.mjs"), "const diskOwned = new Set([", "])");
    for (const id of ["video_gen", "music_gen", "tts_gen"]) {
      ok(owned.indexOf('"' + id + '"') > 0, "diskOwned 含 " + id + "（本轮同步的段落不会被生成器回滚）");
    }
    const s3 = seg(read("docs/nanfeng-h3-port.md"), "## 三、安装链", "## 四、");
    ok(s3.indexOf("skills/minimax-h3-install/SKILL.md") > 0, "§三 指的是仓库根那份技能真源");
    ok(s3.indexOf("唯一") > 0 && s3.indexOf("smoke-plugin-repair") > 0, "§三 写明「唯一真源 + 回归钉住」，不再是一句无据的「已同步」");
  }
}

/* ────────────────────────── [11] 端到端契约（总线 → 报告窗） ────────────────────────── */
async function groupE2E() {
  console.log("\n[11] 端到端：一次上报 → 扁平载荷 → 渲染层归一 → 「自动修复」按不按得下去");
  {
    const bus = require("../plugin-error-repair.js");
    const push = [];
    const win = { isDestroyed: () => false, webContents: { send: (ch, e) => push.push({ ch, e }) } };
    ok(bus.initPluginErrorBus({ getMainWin: () => win, log: () => {} }).ok === true, "重指主窗 getter（端到端跑的就是同一条总线实例）");
    /* 两类现场：会话修复型宿主（remotion / 桌宠这类**没有**隐藏 selfRepair 的）与什么现场都取不到的 */
    bus.registerPluginHost({
      id: "e2e-visible",
      name: "会话修复型",
      skillName: "",
      getInstallDir: () => "D:\\e2e\\install",
      tailConsole: () => ({ ok: true, text: "Traceback: boom" }),
    });
    bus.registerPluginHost({ id: "e2e-blind", name: "无现场型" });
    const flatOf = () => [...push].reverse().find((x) => x.ch === "pluginRepair:error");

    bus.reportPluginError("e2e-visible", { code: "npm_exit_1", message: "npm install 退出码 1", nodeId: "n9", nodeKind: "remotion", workflowId: "wf9" });
    const a = flatOf();
    ok(!!a && a.e.pluginId === "e2e-visible" && a.e.code === "npm_exit_1", "弹窗订阅的 channel 真收到本次报错（过去这里根本没人在推）");
    bus.reportPluginError("e2e-blind", { code: "backend_exited", message: "取不到目录也取不到日志" });
    const b = flatOf();
    ok(b.e.pluginId === "e2e-blind" && b.e.repairable === false && b.e.repairToken === "", "无现场宿主：弹窗收到载荷但 repairable:false 且不发 token（按不动）");
    const c0 = push.length;
    bus.reportPluginError("e2e-blind", { code: "backend_exited", message: "又犯一次" });
    ok(push.length === c0 + 1, "合并计数不再推弹窗通道（只多发一条原始事件）");

    /* 渲染层这一侧：从源码抠真函数进 vm，吃上面那份**真实扁平载荷**（字段名对不上就是 here 挂） */
    const sb = { console, JSON, String, Number, Array, Object, Date, RegExp, Math, I18n: { t: (s) => String(s) } };
    vm.createContext(sb);
    vm.runInContext(
      [
        /* seg 切到 "\n};" 之前为止 → 补回收尾花括号，否则拼起来是半截对象 */
        seg(repair, "const PLUGIN_REPAIR_SKILLS = {", "\n};") + "\n};",
        fnBody(repair, "pluginRepairPick"),
        fnBody(repair, "pluginRepairText"),
        fnBody(repair, "pluginRepairKey"),
        fnBody(repair, "pluginRepairNormalize"),
        fnBody(repair, "pluginRepairBlockedReason"),
      ].join("\n"),
      sb,
    );
    const run = (e) => vm.runInContext(e, sb);
    ok(run("pluginRepairNormalize(" + JSON.stringify(a.e) + ").repairable === true"), "真实载荷 → normalize：repairable 原样是三态里的 true");
    ok(run("pluginRepairNormalize(" + JSON.stringify(b.e) + ").why").length > 0, "真实载荷 → normalize：why 带得出去（就是窗内那句指路）");
    const noDir = JSON.stringify(Object.assign({}, a.e, { installDir: "" }));
    ok(
      run('pluginRepairBlockedReason(pluginRepairNormalize(' + JSON.stringify(a.e) + ')) === ""'),
      "A：可修 → 不置灰，「自动修复」按得下去",
    );
    ok(
      run("(function(){ var i = pluginRepairNormalize(" + noDir + "); return i.repairable === true && pluginRepairBlockedReason(i).length > 10; })()"),
      "主进程说可修、但可写工作区丢了 → 渲染层第二道闸仍拦住（不让 Agent 跑去改别的目录）",
    );
    ok(run('pluginRepairBlockedReason(pluginRepairNormalize(' + JSON.stringify(b.e) + '))').length > 10, "B：不可修 → 置灰并给出原因（不是点了才 toast）");
    ok(
      run('pluginRepairBlockedReason(pluginRepairNormalize(' + JSON.stringify(b.e) + ')) === pluginRepairNormalize(' + JSON.stringify(b.e) + ').why'),
      "置灰原因逐字等于主进程的 why（指路文案只有一个真源）",
    );
    ok(
      bus.repairDialogPayload({}).repairable === false && bus.repairDialogPayload({}).pluginId === "",
      "空事件也不抛（映射函数吃残缺载荷只出空字段）",
    );
  }
}

groupBus()
  .then(groupTail)
  .then(groupE2E)
  .catch((e) => {
    fails++;
    checks++;
    console.log("FAIL  冒烟脚本自己抛了：" + ((e && e.stack) || e));
  })
  .then(() => {
    console.log("\n" + (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ 全部 " + checks + " 项通过"));
    process.exit(fails ? 1 : 0);
  });
