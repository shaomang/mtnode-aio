"use strict";
/* 本地语音转写（Qwen3-ASR）—— 链路级冒烟测试（纯 Node）
 *   node test/smoke-asr.js
 * 被测对象是「真实源码 / 真实模块 / 真实切片」，不是抄一份逻辑：
 *   asr/main-asr.js          主进程模块：IPC 契约、静默起停、随 MTNode 退出、空闲释放、
 *                            全局媒体互斥、转写缓存（路径+mtime+size+热词指纹）
 *   main.js / preload.js     注册与退出回收、渲染层桥（asr:* 通道）
 *   renderer/app-asr.js      真实执行（vm 沙箱）：消费者判定、音频来源解析、转写文本
 *                            注入块、运行前准备（无卡/未装/成功三条路径）、热词解析、
 *                            agent_task 任务段落
 *   renderer/app.js          钩子接线（allTextItems / resolveRefs.addText / 自动注入放行）
 *   renderer/app-nodes.js    运行前准备钩子（失败即中止本轮）+ 连线时的安装弹窗
 *   renderer/app-canvas.js   节点 body 尾部的转写区块
 *   renderer/app-plugins.js  插件卡片（打开 / 关闭控制台 · 不再有删除 · 封面图标 asr-local.png）
 *   renderer/index.html / style.css / css/asr.css / i18n.js   接入与词条
 *   build.json / plugins/*   打包白名单 + 插件目录 + kind 识别
 *   asr-pack/** + skills/asr-local-install/SKILL.md           后端脚手架与安装技能
 *   docs/asr-local-backend.md                                 设计文档
 * 覆盖：
 *   [1] 主进程模块契约（导出 / 端口 / 模型 / 缓存 / 互斥 / 空闲释放 / 随退出）
 *   [2] 渲染层桥与接入（preload 通道 · index.html · style.css · 钩子接线）
 *   [3] renderer/app-asr.js 真实执行：消费者判定 / 音频来源 / 注入块 / 运行前准备
 *   [4] 生态与打包（build.json · 插件目录 · kind 识别 · 插件卡片）
 *   [5] 后端脚手架与安装技能（真实源码断言：接口、错误码、marker、mock、进度）
 *   [6] 文档口径（设计文档 / i18n 词条齐备）
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
const exists = (rel) =>
  fs.existsSync(path.join(__dirname, "..", rel.split("/").join(path.sep)));

console.log("smoke-asr：本地语音转写（Qwen3-ASR）链路\n");

/* ============ [1] 主进程模块契约 ============ */
{
  console.log("[1] 主进程模块 asr/main-asr.js");
  ok(exists("asr/main-asr.js"), "模块文件存在");
  const src = read("asr/main-asr.js");
  ok(/module\.exports\s*=\s*\{/.test(src) && src.indexOf("registerAsrIpc") >= 0, "导出 registerAsrIpc");
  ok(src.indexOf("shutdownAsr") >= 0, "导出 shutdownAsr（结束语音后端）");
  ok(src.indexOf('const PLUGIN_ID = "asr-local"') >= 0, "插件 id = asr-local");
  ok(src.indexOf("const DEFAULT_PORT = 8772") >= 0, "默认端口 8772");
  ok(
    src.indexOf('const ASR_MODEL = "Qwen/Qwen3-ASR-0.6B"') >= 0,
    "固定模型 Qwen/Qwen3-ASR-0.6B（不做模型切换）",
  );
  ok(
    src.indexOf("iic/speech_fsmn_vad_zh-cn-16k-common-pytorch") >= 0,
    "分段模型 = ModelScope fsmn-vad",
  );
  ok(src.indexOf("IDLE_DEFAULT_MIN = 10") >= 0, "空闲释放默认 10 分钟");
  ok(
    src.indexOf("mediaLock.tryAcquireLock") >= 0 &&
      src.indexOf("mediaLock.releaseLock") >= 0,
    "转写与音乐/视频/TTS 共用 media-gen-global-lock（acquire/release 成对）",
  );
  ok(
    src.indexOf('kind: "asr"') >= 0 && src.indexOf("busyMessage") >= 0,
    "抢不到全局锁 → 报忙碌（busyMessage）",
  );
  ok(
    src.indexOf("function cacheKey") >= 0 &&
      src.indexOf("mtimeMs") >= 0 &&
      src.indexOf("hotwordSig") >= 0,
    "缓存键 = 路径 + mtime + size + 热词指纹",
  );
  ok(
    src.indexOf("function cacheSetEdited") >= 0 && src.indexOf("edited: true") >= 0,
    "节点内编辑 = 覆盖该音频的转写缓存（edited: true）",
  );
  ok(
    src.indexOf("windowsHide: true") >= 0 && src.indexOf("detached") < 0,
    "静默 spawn（无窗口、非 detached：随 MTNode 一起收）",
  );
  ok(
    src.indexOf("function armIdleTimer") >= 0 && src.indexOf("clearIdleTimer") >= 0,
    "空闲计时器（可调 / 可关）",
  );
  ok(
    src.indexOf("no_cuda") >= 0 && src.indexOf("hasNvidia") >= 0,
    "无 N 卡 → no_cuda（不引导下载）",
  );
  ok(
    src.indexOf("allowCpu") >= 0 && src.indexOf("仍装 CPU 版（很慢）") >= 0,
    "保留「仍装 CPU 版（很慢）」高级开关",
  );
  ok(
    src.indexOf("asr-local-install") >= 0 && src.indexOf("dsh.run({") >= 0,
    "安装走 Agent 会话 + skill（asr-local-install）",
  );
  ok(
    src.indexOf(".install-ok") >= 0 && src.indexOf(".asr-agent-result") >= 0,
    "marker 约定：.install-ok + .asr-agent-result",
  );
  ok(
    src.indexOf('ipcMain.handle("asr:transcribe"') >= 0 &&
      src.indexOf('ipcMain.handle("asr:getStatus"') >= 0 &&
      src.indexOf('ipcMain.handle("asr:install"') >= 0 &&
      src.indexOf('ipcMain.handle("asr:agentRecoverInstall"') >= 0,
    "IPC 处理器齐备（getStatus / transcribe / install / agentRecoverInstall）",
  );
  ok(
    src.indexOf('broadcast("asr:progress"') >= 0,
    "进度事件 asr:progress（进度窗与插件卡片共用）",
  );
  /* 插件控制台窗口（与其他本地后端同构）+ ffmpeg 补装通道 */
  ok(
    src.indexOf("function openUiWindow") >= 0 &&
      src.indexOf("function closeUiWindow") >= 0 &&
      src.indexOf('join(__dirname, "ui", "index.html")') >= 0,
    "插件控制台窗口：openUiWindow / closeUiWindow + asr/ui/index.html",
  );
  ok(
    src.indexOf('preload: join(__dirname, "preload-asr.js")') >= 0,
    "控制台窗口用专属 preload（asr/preload-asr.js）",
  );
  ok(
    src.indexOf('ipcMain.handle("asr:open"') >= 0 &&
      src.indexOf('ipcMain.handle("asr:close"') >= 0 &&
      src.indexOf('ipcMain.handle("asr:installFfmpeg"') >= 0,
    "IPC：asr:open / asr:close / asr:installFfmpeg（再次安装与补装入口）",
  );
  ok(
    src.indexOf("consoleOpen: isUiOpen()") >= 0 && src.indexOf("function isUiOpen") >= 0,
    "状态快照带 consoleOpen（卡片据此显示打开 / 关闭控制台）",
  );
  ok(
    src.indexOf("async function ffmpegStatus") >= 0 &&
      src.indexOf("function portableFfmpeg") >= 0 &&
      src.indexOf("function whichFfmpeg") >= 0,
    "ffmpeg 状态：便携版优先、回退系统 PATH（ffmpegStatus / portableFfmpeg / whichFfmpeg）",
  );
  ok(
    /closeUiWindow\(\);/.test(src.slice(src.indexOf("async function shutdownAsr"))) &&
      src.indexOf("async function shutdownAsr") >= 0,
    "退出时先关控制台窗口再结束后端",
  );
  ok(
    src.indexOf('"-FfmpegOnly"') >= 0 && src.indexOf("ffmpegOnly") >= 0,
    "installByScript 支持 ffmpegOnly（脚本 -FfmpegOnly）",
  );

  const main = read("main.js");
  ok(
    main.indexOf('require("./asr/main-asr.js")') >= 0 &&
      main.indexOf("registerAsrIpc({") >= 0,
    "main.js 注册 asr IPC",
  );
  ok(
    /before-quit[\s\S]{0,1200}shutdownAsr\(\)/.test(main),
    "before-quit 调 shutdownAsr（MTNode 关闭 → 后端随之关闭）",
  );
}

/* ============ [2] 渲染层桥与接入 ============ */
{
  console.log("\n[2] 渲染层桥与接入");
  const pre = read("preload.js");
  for (const ch of [
    "asr:getStatus",
    "asr:transcribe",
    "asr:install",
    "asr:agentInstall",
    "asr:agentRecoverInstall",
    "asr:cacheGet",
    "asr:cacheSet",
    "asr:cacheClear",
    "asr:pickInstallDir",
    "asr:pickModelDir",
    "asr:setConfig",
  ]) {
    ok(pre.indexOf("'" + ch + "'") >= 0 || pre.indexOf('"' + ch + '"') >= 0, "preload 暴露 " + ch);
  }
  ok(pre.indexOf("onAsrProgress") >= 0, "preload 暴露 onAsrProgress（安装进度）");
  for (const ch of ["asr:open", "asr:close", "asr:installFfmpeg"]) {
    ok(pre.indexOf("'" + ch + "'") >= 0, "preload 暴露 " + ch);
  }
  ok(pre.indexOf("asrOpen:") >= 0 && pre.indexOf("asrClose:") >= 0, "preload 暴露 asrOpen / asrClose");
  ok(exists("asr/preload-asr.js"), "控制台窗口 preload 文件存在");
  ok(exists("asr/ui/index.html") && exists("asr/ui/ui.js") && exists("asr/ui/ui.css"), "控制台界面 asr/ui/* 存在");
  {
    const ui = read("asr/ui/index.html");
    const uijs = read("asr/ui/ui.js");
    const uipre = read("asr/preload-asr.js");
    ok(ui.indexOf("ui.js") >= 0 && ui.indexOf("ui.css") >= 0, "index.html 接入 ui.js / ui.css");
    ok(uijs.indexOf("btnFfmpeg") >= 0 && uijs.indexOf("installFfmpeg") >= 0, "控制台有「补装 ffmpeg」按钮与调用");
    ok(uijs.indexOf("btnInstall") >= 0 && uijs.indexOf("重新安装 / 补充安装") >= 0, "控制台安装按钮支持重复安装");
    ok(
      uipre.indexOf('exposeInMainWorld("asrApi"') >= 0 && uipre.indexOf("asr:getStatus") >= 0,
      "preload-asr.js 暴露 asrApi 白名单桥",
    );
  }

  const html = read("renderer/index.html");
  ok(html.indexOf('src="app-asr.js"') >= 0, "index.html 引入 renderer/app-asr.js");
  const style = read("renderer/style.css");
  ok(style.indexOf('css/asr.css') >= 0, "style.css 引入 css/asr.css");
  ok(exists("renderer/css/asr.css"), "css/asr.css 存在");

  const appjs = read("renderer/app.js");
  ok(
    appjs.indexOf("asrTextItemsOf") >= 0 && appjs.indexOf("asrTranscriptBlockFor") >= 0,
    "app.js：allTextItems / resolveRefs.addText 双向钩子（音频 → 转写文本注入）",
  );

  const nodes = read("renderer/app-nodes.js");
  ok(
    /asrPrepareForRun\(node\)[\s\S]{0,120}return;/.test(nodes),
    "app-nodes.js：运行前准备失败即中止本轮（不静默跳过）",
  );
  ok(nodes.indexOf("asrMaybePromptOnWire") >= 0, "app-nodes.js：连线时触发安装弹窗");
  ok(
    nodes.indexOf("asrTaskAppendText") >= 0,
    "app-nodes.js：agent_task 会话模式补「【音频转写】」段落",
  );

  const canvas = read("renderer/app-canvas.js");
  ok(canvas.indexOf("asrAppendNodeBody") >= 0, "app-canvas.js：节点 body 尾部转写区块");

  const plugins = read("renderer/app-plugins.js");
  ok(
    plugins.indexOf("refreshAsrPluginCard") >= 0 &&
      plugins.indexOf("bindAsrProgress") >= 0,
    "app-plugins.js：插件卡片状态 + 安装进度",
  );
  /* 卡片「开始 / 关闭」= 打开 / 关闭插件控制台窗口（asr:open / asr:close），不是设置弹窗 */
  ok(
    plugins.indexOf('addBtn("play", I18n.t("打开控制台"), openConsole') >= 0 &&
      plugins.indexOf('addBtn("stop", I18n.t("关闭控制台"), closeConsole') >= 0,
    "ASR 卡片：开始 / 关闭 → 打开 / 关闭控制台窗口",
  );
  ok(
    plugins.indexOf("window.api.asrOpen ?") >= 0 && plugins.indexOf("window.api.asrClose") >= 0,
    "ASR「打开」走 asr:open、「关闭」走 asr:close",
  );
  /* 此前「打开控制台 / 状态与设置」用了 PLUGIN_ACT_SVG 里不存在的 gear → 按钮渲染成空白方块 */
  ok(plugins.indexOf("gear:") >= 0, "PLUGIN_ACT_SVG 补齐 gear（否则设置 / 打开按钮是空方块）");
  ok(/addBtn\("gear"/.test(plugins), "ASR 卡片的设置入口仍走 gear 按钮（图标已存在）");
  /* 所有插件卡片不再有「删除 / 卸载 / 移除入口」 */
  ok(plugins.indexOf('"trash"') < 0, "插件卡片不再有 trash（删除）动作");
  ok(plugins.indexOf("appPluginsUninstall") < 0, "插件卡片不再调用插件卸载 IPC");

  /* 插件封面：ASR 此前没有 asr-local.png → 卡片显示空白占位；现由脚本可复现生成 1:1 图标 */
  ok(exists("plugins/icons/asr-local.png"), "ASR 插件封面 plugins/icons/asr-local.png 存在");
  ok(exists("scripts/make-asr-icon.js"), "封面由 scripts/make-asr-icon.js 可复现生成");
  {
    const png = fs.readFileSync(path.join(__dirname, "..", "plugins", "icons", "asr-local.png"));
    ok(png.slice(0, 8).toString("hex") === "89504e470d0a1a0a", "封面是合法 PNG");
    const w = png.readUInt32BE(16);
    const h = png.readUInt32BE(20);
    ok(w > 0 && w === h, "封面是 1:1（" + w + "×" + h + "）");
    ok(png[25] === 6, "封面带 Alpha 通道（圆角外透明）");
  }
}

/* ============ [3] renderer/app-asr.js 真实执行（vm 沙箱） ============ */
{
  console.log("\n[3] renderer/app-asr.js 真实执行");
  const src = read("renderer/app-asr.js");

  /* 假环境：只提供 app-asr.js 运行期真正会用到的全局（取自 app.js 的真实同名函数已被
     单测覆盖，这里只验「接线语义」） */
  const audioSrc = { id: "a1", kind: "input_audio", title: "录音 1" };
  const textSrc = { id: "t1", kind: "input_text", title: "文本 1" };
  const consumer = { id: "p1", kind: "proc_text" };
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    S: { wf: { id: "wf1", nodes: [audioSrc, textSrc, consumer], wires: [] } },
    I18n: { t: (s, vars) => String(s).replace(/\{(\w+)\}/g, (_m, k) => (vars && vars[k]) || "") },
    document: { createElement: () => ({ style: {}, appendChild() {}, classList: { add() {}, remove() {} } }) },
    toast: () => {},
    scheduleSave: () => {},
    renderCanvas: () => {},
    nodeById: (id) => ({ a1: audioSrc, t1: textSrc, p1: consumer }[id] || null),
    /* 画布：音频输入节点 a1 → 文字处理节点 p1（这是本功能的核心接线） */
    wiresTo: (id) =>
      id === "p1"
        ? [{ id: "w1", from: "a1", to: "p1", fromIndex: 0, toIndex: 0 }]
        : [],
    wireFromIsControl: () => false,
    wireSourceMediaType: (n) => (n.kind === "input_audio" ? "audio" : "text"),
    refInputIdxFor: () => 0,
    itemTitleOf: (n) => n.title,
    valueForInput: (n) => (n.kind === "input_audio" ? { kind: "audio", path: "E:\\a\\rec1.wav", text: "file:///E:/a/rec1.wav" } : { kind: "text", text: "x" }),
  };
  sandbox.window = {
    api: {
      asrStatus: async () => sandbox.__st,
      asrTranscribe: async () => sandbox.__tr,
      asrCacheSet: async () => ({ ok: true }),
      asrCacheClear: async () => ({ ok: true }),
      asrSetConfig: async () => ({ ok: true }),
    },
  };
  sandbox.window.api.asrCacheSet = async () => ({ ok: true });
  const ctx = vm.createContext(sandbox);
  try {
    vm.runInContext(src, ctx, { filename: "renderer/app-asr.js" });
    ok(true, "app-asr.js 在沙箱中加载（无语法/顶层错误）");
  } catch (e) {
    ok(false, "app-asr.js 加载失败：" + ((e && e.message) || e));
  }

  ok(typeof ctx.isAsrConsumerNode === "function", "isAsrConsumerNode 已定义");
  ok(ctx.isAsrConsumerNode({ kind: "proc_text" }) === true, "普通文字处理节点是消费者");
  ok(ctx.isAsrConsumerNode({ kind: "proc_text", agent: true }) === true, "智能模式文字节点是消费者");
  ok(ctx.isAsrConsumerNode({ kind: "agent_task" }) === true, "agent_task 是消费者");
  ok(ctx.isAsrConsumerNode({ kind: "input_audio" }) === false, "音频输入节点本身不是消费者");

  /* 有转写 → 注入块；无转写 → null（维持旧行为，不塞 file:/// URL） */
  ok(ctx.asrTextItemsOf(audioSrc, consumer, 0) === null, "未转写：不产出背景块（null）");
  consumer.asrTranscripts = [{ path: "E:\\a\\rec1.wav", text: "大家好，这是会议记录。" }];
  const items = ctx.asrTextItemsOf(audioSrc, consumer, 0);
  ok(!!items && items.length === 1, "已转写：产出 1 个背景块");
  ok(
    !!items && items[0].title.indexOf("音频转写") === 0 && items[0].title.indexOf("录音 1") >= 0,
    "背景块标题 = 「音频转写 · 来源标题」",
  );
  ok(!!items && items[0].text === "大家好，这是会议记录。", "背景块正文 = 转写文本");

  const blk = ctx.asrTranscriptBlockFor(consumer, audioSrc, 0);
  ok(!!blk && blk.text.indexOf("会议记录") >= 0, "asrTranscriptBlockFor 同口径（供连线自动注入）");
  ok(ctx.asrTranscriptBlockFor(consumer, textSrc, 0) === null, "文本来源不走音频分支");
  ok(
    ctx.asrTranscriptBlockFor({ kind: "input_image" }, audioSrc, 0) === null,
    "非文字处理节点不注入",
  );

  /* agent_task：任务描述里的【音频转写】段落 */
  const agent = { kind: "agent_task", asrTranscripts: [{ path: "E:\\a\\rec1.wav", title: "录音 1", text: "第一句。" }] };
  const seg = ctx.asrTaskAppendText(agent);
  ok(seg.indexOf("【音频转写 · 录音 1】") === 0 && seg.indexOf("第一句。") > 0, "agent_task 任务段落含标题与正文");

  /* 热词解析 */
  ok(
    JSON.stringify(ctx.asrHotwordsOf({ asrHotwords: "MTNode，Qwen3-ASR、张伟" })) ===
      JSON.stringify(["MTNode", "Qwen3-ASR", "张伟"]),
    "热词按中英文逗号/顿号/分号切分",
  );

  /* 运行前准备：无卡 / 未安装 / 成功 */
  (async () => {
    sandbox.__st = { supported: false, installed: false };
    const n1 = { id: "p1", kind: "proc_text", asrTranscripts: [] };
    const r1 = await ctx.asrPrepareForRun(n1);
    ok(r1.ok === false && r1.error === "no_cuda" && n1.asrState === "no_cuda", "无 N 卡：拦下本轮 + 节点标 no_cuda");

    sandbox.__st = { supported: true, installed: false };
    const n2 = { id: "p1", kind: "proc_text", asrTranscripts: [] };
    const r2 = await ctx.asrPrepareForRun(n2);
    ok(
      r2.ok === false && r2.error === "not_installed" && n2.asrState === "not_installed",
      "未安装：拦下本轮 + 节点标 not_installed（并弹安装窗）",
    );

    sandbox.__st = { supported: true, installed: true };
    sandbox.__tr = { ok: true, text: "转写结果。", cached: false, segments: 2, duration_sec: 3.5 };
    const n3 = { id: "p1", kind: "proc_text", asrTranscripts: [] };
    const r3 = await ctx.asrPrepareForRun(n3);
    ok(r3.ok === true, "已安装：运行前准备通过");
    ok(
      Array.isArray(n3.asrTranscripts) &&
        n3.asrTranscripts.length === 1 &&
        n3.asrTranscripts[0].text === "转写结果。" &&
        n3.asrTranscripts[0].path === "E:\\a\\rec1.wav",
      "转写结果写入节点（path + text + 标题），供提示词同步取用",
    );
    ok(n3.asrState === "ok", "节点状态 = 已转写");

    sandbox.__tr = { ok: false, error: "busy_media", message: "已有音视频任务进行中" };
    const n4 = { id: "p1", kind: "proc_text", asrTranscripts: [] };
    const r4 = await ctx.asrPrepareForRun(n4);
    ok(r4.ok === false && r4.error === "busy_media", "全局锁繁忙：拦下本轮并回传原因");

    console.log(
      "\n" + (fails ? "FAILED " + fails + " / " + checks + " checks" : "ALL OK  " + checks + " checks"),
    );
    process.exit(fails ? 1 : 0);
  })();
}

/* 注意：[4]~[6] 在异步块之前同步跑完（见下方立即执行段） */
function restChecks() {
  console.log("\n[4] 生态与打包");
  const build = read("build.json");
  ok(build.indexOf('"asr/**"') >= 0, "build.json files 含 asr/**（主进程新模块必须进白名单）");
  const extraOk =
    /"from":\s*"asr-pack"[\s\S]{0,240}?"to":\s*"asr-pack"/.test(build) ||
    build.indexOf('"asr-pack"') >= 0;
  ok(extraOk, "build.json extraResources 含 asr-pack（否则打包后 pack_missing）");

  const cat = read("plugins/catalog.default.json");
  ok(cat.indexOf('"id": "asr-local"') >= 0 && cat.indexOf('"handler": "asr"') >= 0, "插件目录含 asr-local 卡片");
  ok(cat.indexOf("Qwen3-ASR-0.6B") >= 0 && cat.indexOf("随 MTNode 退出而结束") >= 0, "卡片文案写明模型与「随退出结束」");

  const mp = read("plugins/main-app-plugins.js");
  ok(mp.indexOf('"asr"') >= 0 && mp.indexOf('raw.handler === "asr"') >= 0, "kind 识别接受 asr");

  console.log("\n[5] 后端脚手架与安装技能");
  for (const f of [
    "asr-pack/manifest.json",
    "asr-pack/requirements.txt",
    "asr-pack/app/__init__.py",
    "asr-pack/app/__main__.py",
    "asr-pack/app/server.py",
    "asr-pack/app/engine.py",
    "asr-pack/app/audio.py",
    "asr-pack/app/vad.py",
    "asr-pack/scripts/install.ps1",
    "asr-pack/README.md",
    "asr-pack/.gitignore",
    "skills/asr-local-install/SKILL.md",
    "docs/asr-local-backend.md",
  ]) {
    ok(exists(f), "存在 " + f);
  }
  const man = read("asr-pack/manifest.json");
  ok(man.indexOf('"asr-local"') >= 0 && man.indexOf("Qwen/Qwen3-ASR-0.6B") >= 0, "manifest 钉住 id 与模型");
  const srv = read("asr-pack/app/server.py");
  ok(srv.indexOf("/v1/audio/transcriptions") >= 0, "后端实现 OpenAI 兼容 /v1/audio/transcriptions");
  ok(srv.indexOf("/health") >= 0 && srv.indexOf("/api/shutdown") >= 0, "后端实现 /health 与 /api/shutdown");
  ok(srv.indexOf("MTNODE_ASR_MOCK") >= 0, "后端支持 MTNODE_ASR_MOCK（联调 / 冒烟）");
  ok(srv.indexOf("busy") >= 0 && srv.indexOf("429") >= 0, "后端并发保护：忙时 429 + busy");
  ok(srv.indexOf("127.0.0.1") >= 0, "只监听 127.0.0.1");
  const engine = read("asr-pack/app/engine.py");
  ok(engine.indexOf("Qwen3ASRForConditionalGeneration") >= 0, "engine 优先走 Qwen3ASR 专用类");
  ok(engine.indexOf("AutoModelForSpeechSeq2Seq") >= 0, "engine 保留 transformers 兜底路径");
  const audio = read("asr-pack/app/audio.py");
  ok(audio.indexOf("no_ffmpeg") >= 0 && audio.indexOf("16000") >= 0, "audio 用 ffmpeg 转 16k 单声道，缺 ffmpeg 报 no_ffmpeg");
  const vad = read("asr-pack/app/vad.py");
  ok(vad.indexOf("fsmn") >= 0 && vad.indexOf("30") >= 0, "vad 用 fsmn-vad，拿不到则退固定窗口");
  const ps = read("asr-pack/scripts/install.ps1");
  ok(ps.indexOf(".install-ok") >= 0, "install.ps1 写 .install-ok marker");
  ok(ps.indexOf("progress:") >= 0, "install.ps1 输出进度（上层进度条）");
  ok(ps.indexOf("pytorch.org") >= 0 && ps.indexOf("cu1") >= 0, "install.ps1 按 CUDA 索引装 torch（可降档）");
  ok(ps.indexOf("modelscope") >= 0 && ps.indexOf("hf-mirror") >= 0, "install.ps1：ModelScope 为主、hf-mirror 回退");
  ok(ps.indexOf("-Cpu") >= 0, "install.ps1 保留 -Cpu 后门");
  ok(ps.indexOf("-FfmpegOnly") >= 0 && ps.indexOf("-ForceFfmpeg") >= 0, "install.ps1 支持 -FfmpegOnly / -ForceFfmpeg（补装通道）");
  ok(ps.indexOf("SecurityProtocol") >= 0 && ps.indexOf("Tls12") >= 0, "install.ps1 显式启用 TLS1.2（WinPS 5.1 下 ffmpeg 下载失败根因）");
  ok(ps.indexOf(".ffmpeg-ok") >= 0, "install.ps1 写 .ffmpeg-ok（ffmpeg 就位标记）");
  ok(
    ps.indexOf("reason=ffmpeg_failed") >= 0 && ps.indexOf("if (-not $ffmpegOk)") >= 0,
    "缺 ffmpeg = 安装不完整：不写 .install-ok，回执 ok=false / reason=ffmpeg_failed",
  );
  ok(ps.indexOf("Get-Command ffmpeg") >= 0, "install.ps1 回退检测系统 PATH 中的 ffmpeg");
  ok((ps.match(/https:\/\//g) || []).length >= 8, "install.ps1 提供多个下载源（含镜像前缀）");
  const skill = read("skills/asr-local-install/SKILL.md");
  ok(skill.indexOf("name: asr-local-install") >= 0, "SKILL.md 名称正确（Agent 安装按名取用）");
  ok(skill.indexOf("修复") >= 0 && skill.indexOf(".asr-agent-result") >= 0, "SKILL.md 含【修复】模式与结果 marker");
  ok(skill.indexOf("no_cuda") >= 0, "SKILL.md 写明无 N 卡口径");
}

/* ============ [6] i18n 词条 ============ */
function i18nChecks() {
  console.log("\n[6] i18n 与文档口径");
  const zh = read("renderer/i18n.js");
  const keys = [
    "音频转写",
    "本地语音转写（Qwen3-ASR）",
    "缺语音后端",
    "无可用显卡",
    "重新转写",
    "术语 / 热词",
    "一键安装",
    "下载并安装（脚本）",
    "交给 AI 安装 / 自我修复",
    "空闲释放（分钟，0 = 不释放）",
    "停止后端",
    "重新安装 / 补充安装",
    "补装 ffmpeg",
    "打开控制台",
    "关闭控制台",
    "ffmpeg（音频解码）",
  ];
  let miss = keys.filter((k) => zh.indexOf('"' + k + '"') < 0);
  ok(miss.length === 0, "中英词条齐备（缺：" + (miss.join(" / ") || "无") + "）");

  const doc = read("docs/asr-local-backend.md");
  ok(doc.indexOf("8772") >= 0, "文档写明端口 8772");
  ok(doc.indexOf("media-gen-global-lock") >= 0, "文档写明全局互斥口径");
  ok(doc.indexOf("随 MTNode 退出") >= 0 || doc.indexOf("退出而结束") >= 0, "文档写明随 MTNode 退出");
  ok(doc.indexOf("MTNODE_ASR_MOCK") >= 0, "文档写明 mock 模式");
}

restChecks();
i18nChecks();
/* 兜底：异步块正常会 process.exit；异常时也要给出结论，避免静默挂死 */
setTimeout(() => {
  console.log("\n" + (fails ? "FAILED " + fails + " / " + checks + " checks" : "ALL OK  " + checks + " checks"));
  process.exit(fails ? 1 : 0);
}, 8000).unref?.();
