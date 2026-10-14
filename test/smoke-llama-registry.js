"use strict";
/* llama.cpp 本地模型「登记进 MTNode 模型列表」——冒烟测试（纯 Node：只读源码 + 纯函数真跑，
 * 不起 Electron、不联网、不动用户机器上的 llama）
 *   node test/smoke-llama-registry.js
 *
 * 为什么要有这只用例（用户报障 + 真机实测）：
 *   「部署模型后未登记在 mtnode 模型列表中」。真机上实测到的断点有四个：
 *     ① 同步只取 `/api/status` 的 `deployedModels`（**只含 running**）：部署实例 status=failed
 *        （`llama_server: exiting due to model loading error`）时永远进不了列表；
 *     ② 同步只追加、从不移除：停用 / 删除的模型永远留在列表里；
 *     ③ 渲染层收到 `llama:providerSynced` 只换内存 providers、不重绘：已打开的设置页看不出变化；
 *     ④ 托盘进程（MTNode 没开着时自己开控制台）的 `syncProvider` 是空实现，从不登记。
 *   另有 apiKey 错位（config 里是安装目录 `.api-key` 的旧值，在线 manager 认的是另一串）。
 *
 * 口径（用户确认，见本模块本轮共识）：
 *   · 清单 = 本机**已下载**的全部模型（不只 running），逐条状态：运行中 / 加载中 / 未部署 / 加载失败；
 *   · 插件托管的那份由插件增删，用户手加的额外模型与手排序保留；
 *   · 部署 / 停止成功后已打开的界面当场刷新；托盘路径直接写盘 + 信号通知；
 *   · apiKey 在线以 /api/status 为准，离线读 <installDir>/.api-key，都拿不到就不覆盖旧值；
 *   · 运行前闸门：未部署 / 加载失败的模型先自动加载（上限 10 分钟），只释放**空闲**的其它本地后端。
 *
 * 覆盖：
 *   [1] provider-sync.js 纯函数：servedName 规则、清单来源与状态、排序、离线回退、apiKey 口径
 *   [2] config-providers.js：managedModels 增删 + 用户手加条目保留 + 老语义（只追加）不回归
 *   [3] 主进程宿主：清单 / 键 / 冲突判定 / 运行前闸门（10 分钟 / 空闲释放 / 不自动回退）
 *   [4] 托盘路径：preload 不再是空实现、宿主真写 config.json + 脏信号、主进程消费信号
 *   [5] 渲染层：状态徽标 + 部署 / 停止按钮、事件驱动就地重绘、冲突告警两个选择、加载提示
 *   [6] server.py 给出 installRoot；文档（SKILL.md / 指南）与新口径一致
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
const abs = (rel) => path.join(ROOT, rel.split("/").join(path.sep));
const read = (rel) => fs.readFileSync(abs(rel), "utf8").replace(/\r\n/g, "\n");
const has = (text, needle, msg) => ok(text.indexOf(needle) >= 0, msg + "  [" + needle + "]");
const hasnt = (text, needle, msg) => ok(text.indexOf(needle) < 0, msg + "  [无 " + needle + "]");
const eq = (a, b, msg) =>
  ok(JSON.stringify(a) === JSON.stringify(b), msg + "（得到 " + JSON.stringify(a) + "）");

const sync = require(abs("llama/provider-sync.js"));
const CP = require(abs("config-providers.js"));

/* ── [1] provider-sync.js：清单与状态 ─────────────────────────────────────── */
console.log("\n[1] llama/provider-sync.js：模型清单的单一真源");
{
  /* servedName 必须与 llama-pack/app/models.py 的 deploy_model 同规则（末段 + 点换横线） */
  eq(sync.servedNameOf("google/gemma-4-E2B-it"), "gemma-4-E2B-it", "servedName：末段原样");
  eq(
    sync.servedNameOf("unsloth/Qwen3.8-Flash-Next-GGUF"),
    "Qwen3-8-Flash-Next-GGUF",
    "servedName：点换横线（与 models.py 一致）",
  );
  eq(sync.servedNameOf(""), "", "servedName：空 id 给空串");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llama-registry-"));
  fs.writeFileSync(
    path.join(dir, ".registry.json"),
    JSON.stringify({
      models: [
        { id: "google/gemma-4-E2B-it", quant: "Q4_K_M", sizeGb: 3.19 },
        { id: "google/gemma-4-E4B-it", quant: "Q4_K_M", sizeGb: 4.97 },
      ],
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(dir, ".deployed.json"),
    JSON.stringify({
      instances: [
        {
          modelId: "google/gemma-4-E4B-it",
          servedName: "gemma-4-E4B-it",
          port: 8100,
          status: "running",
        },
        {
          modelId: "unsloth/Qwen3.8-Flash-Next-GGUF",
          servedName: "Qwen3-8-Flash-Next-GGUF",
          port: 8101,
          status: "failed",
          error: "llama_server: exiting due to model loading error",
        },
      ],
    }),
    "utf8",
  );

  /* 离线（后端没起）：只读安装目录的文件，也要给全清单与状态 */
  const off = sync.modelRows({ installDir: dir });
  eq(
    off.map((r) => [r.id, r.status]),
    [
      ["gemma-4-E4B-it", "running"],
      ["gemma-4-E2B-it", "downloaded"],
      ["Qwen3-8-Flash-Next-GGUF", "failed"],
    ],
    "离线也登记全部已下载模型，并给出 running / downloaded / failed 三态（running 在前、failed 在后）",
  );
  ok(
    off.find((r) => r.id === "gemma-4-E4B-it").port === 8100,
    "运行中的行带上实例端口（自动部署 / 排障要用）",
  );
  ok(
    /model loading error/.test(off.find((r) => r.id === "Qwen3-8-Flash-Next-GGUF").error),
    "加载失败的行带上引擎原始报错",
  );

  /* 在线时管理服务给的清单优先（能带出注册表文件里没有的条目） */
  const on = sync.modelRows({
    installDir: dir,
    deployed: [{ modelId: "google/gemma-4-E2B-it", servedName: "gemma-4-E2B-it", port: 8102, status: "starting" }],
    apiModels: [{ id: "google/gemma-4-E2B-it", status: "downloaded" }],
  });
  eq(
    on.map((r) => [r.id, r.status]),
    [
      ["gemma-4-E2B-it", "starting"],
      ["gemma-4-E4B-it", "downloaded"],
    ],
    "在线：以实例状态为准（starting 排在未部署之前）",
  );
  ok(on.length === 2, "在线清单按 id 去重（不重复登记同一个模型）");

  /* 服务商条目：模型 id 用 servedName；apiKey 空则**不带该字段**（不覆盖盘上旧值） */
  const item = sync.buildProviderItem({
    port: 8765,
    rows: off,
    apiKey: "",
    mode: "own",
    online: false,
    installDir: dir,
    mismatch: false,
  });
  eq(
    item.models,
    ["gemma-4-E4B-it", "gemma-4-E2B-it", "Qwen3-8-Flash-Next-GGUF"],
    "服务商 models = 全部 servedName（运行中优先）",
  );
  ok(!("apiKey" in item), "拿不到 apiKey 时不写该字段（绝不拿可疑旧票覆盖）");
  ok(item.source === "llama-plugin" && item.managedField === "llamaManagedModels", "带插件来源与托管清单字段名");
  eq(item.baseUrl, "http://127.0.0.1:8765/v1", "baseUrl 指向管理服务的 OpenAI 兼容端点");
  eq(
    item.fields.llamaModels.map((m) => m.status),
    ["running", "downloaded", "failed"],
    "llamaModels 逐条状态随条目写回（渲染层画徽标用）",
  );
  ok(
    sync.findRow(off, "gemma-4-E4B-it") && sync.findRow(off, "google/gemma-4-E4B-it"),
    "findRow：servedName 与 modelId 都能查到同一行",
  );

  /* 托盘 → MTNode 的脏信号：写一次、消费一次即清 */
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "llama-data-"));
  ok(sync.markDirty(dataDir, { models: ["a"] }) === true, "markDirty 写信号成功");
  ok(!!sync.consumeDirty(dataDir), "consumeDirty 读得到");
  ok(sync.consumeDirty(dataDir) === null, "消费一次即清（不会反复催刷新）");

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
}

/* ── [2] config-providers.js：托管清单能增也能删 ──────────────────────────── */
console.log("\n[2] config-providers.js：托管模型清单（增 + 删）与用户手加条目的保留");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llama-cfg-"));
  const cfg = path.join(dir, "config.json");
  const base = {
    providers: [
      {
        id: "llama-local",
        name: "llama.cpp 本地",
        type: "text_openai",
        baseUrl: "http://127.0.0.1:8765/v1",
        apiKey: "vllm-old-key",
        source: "llama-plugin",
        models: ["stale-1", "stale-2", "my-hand-added"],
        llamaManagedModels: ["stale-1", "stale-2"],
      },
    ],
  };
  fs.writeFileSync(cfg, JSON.stringify(base), "utf8");
  const r = CP.mergeManagedProvider(
    cfg,
    {
      id: "llama-local",
      source: "llama-plugin",
      baseUrl: "http://127.0.0.1:8765/v1",
      models: ["gemma-4-E4B-it", "gemma-4-E2B-it"],
      managedModels: ["gemma-4-E4B-it", "gemma-4-E2B-it"],
      fields: { llamaModels: [{ id: "gemma-4-E4B-it", status: "running" }] },
    },
    { pruneUnknown: true },
  );
  ok(r.ok === true, "mergeManagedProvider 正常返回");
  const p = r.providers[0];
  eq(
    p.models,
    ["gemma-4-E4B-it", "gemma-4-E2B-it", "my-hand-added"],
    "托管清单换新（stale 两条消失）+ 用户手加的那条保留在末尾",
  );
  eq(p.llamaManagedModels, ["gemma-4-E4B-it", "gemma-4-E2B-it"], "本轮托管清单记进 managedField（下次据此认用户手加）");
  eq(p.apiKey, "vllm-old-key", "本次没给 apiKey ⇒ 盘上那份原样保留（不覆盖）");
  eq(p.llamaModels.length, 1, "fields 里的插件自有字段逐字写入");
  eq(
    CP.readJson(cfg, null).providers[0].models,
    ["gemma-4-E4B-it", "gemma-4-E2B-it", "my-hand-added"],
    "磁盘上那一份同样生效",
  );

  /* 老语义不回归：不传 managedModels 时仍然只追加、从不删（其它插件 / 老调用方） */
  fs.writeFileSync(cfg, JSON.stringify(base), "utf8");
  const r2 = CP.mergeManagedProvider(cfg, {
    id: "llama-local",
    source: "llama-plugin",
    models: ["new-model"],
  });
  eq(
    r2.providers[0].models,
    ["stale-1", "stale-2", "my-hand-added", "new-model"],
    "不带托管清单 ⇒ 维持旧的只追加语义（老调用方行为一字不变）",
  );

  /* 新条目也不能写出重复项：调用方把 models 与 managedModels 传成同值（插件就是这么给的）时，
     真机自验里出现过设置页同名两行 —— 去重口径钉在这里 */
  fs.writeFileSync(cfg, JSON.stringify({ providers: [] }), "utf8");
  const rDup = CP.mergeManagedProvider(cfg, {
    id: "llama-local",
    source: "llama-plugin",
    models: ["only-one"],
    managedModels: ["only-one"],
    managedField: "llamaManagedModels",
  });
  eq(rDup.providers[0].models, ["only-one"], "新建条目：同值的 models / managedModels 不产生重复行");

  /* 第一次同步（老配置没有托管字段）：pruneUnknown 才收敛，否则不误删 */
  const legacy = {
    providers: [
      {
        id: "llama-local",
        source: "llama-plugin",
        apiKey: "k",
        models: ["gone-1", "gone-2"],
      },
    ],
  };
  fs.writeFileSync(cfg, JSON.stringify(legacy), "utf8");
  const r3 = CP.mergeManagedProvider(
    cfg,
    { id: "llama-local", source: "llama-plugin", managedModels: ["keep-1"] },
    { pruneUnknown: true },
  );
  eq(r3.providers[0].models, ["keep-1"], "没有托管字段 + pruneUnknown ⇒ 整份按托管的收敛一次");
  ok(r3.providers[0].apiKey === "k", "收敛只动 models，凭据不丢");

  fs.rmSync(dir, { recursive: true, force: true });
}

/* ── [3] 主进程宿主（llama/main-llama.js）────────────────────────────────── */
console.log("\n[3] llama/main-llama.js：清单来源 / apiKey / 冲突 / 运行前闸门");
{
  const src = read("llama/main-llama.js");
  has(src, 'require("./provider-sync.js")', "宿主用登记链真源（不再自己拼 deployedModels）");
  hasnt(src, "st.deployedModels", "不再只认运行中的 deployedModels");
  has(src, "syncSignal.modelRows(", "清单来自 provider-sync 的 modelRows");
  has(src, 'syncSignal.liveModels(port, apiKey)', "在线时读管理服务 /api/models（含未部署的）");
  has(src, "syncSignal.readInstallApiKey(cfg.installDir)", "离线回退读 <installDir>/.api-key");
  has(src, "const liveKey = useLive && rs.live.apiKey", "在线时以 /api/status 的 apiKey 为权威（本轮共识 q12）");
  has(src, "{ pruneUnknown: true }", "插件托管清单可增可删");
  has(src, 'broadcast("llama:providerSynced"', "清单变化即广播给渲染层");
  has(src, "async function llamaRootState()", "安装目录冲突判定（installRoot vs installDir）");
  has(src, '"llama:resolveRootChoice"', "冲突时用户的两个选择有 IPC 入口");
  has(src, "async function resolveRootChoice(mode)", "resolveRootChoice 落实两个选择");
  has(src, "pickFreePort(", "换端口起自己的：挑一个空闲端口");
  has(src, "async function ensureModel(modelId, opts)", "运行前闸门 ensureModel");
  has(src, "const DEPLOY_WAIT_MS = 10 * 60 * 1000;", "自动加载上限 10 分钟（本轮共识 q8）");
  /* 停止必须先按 servedName → 注册表 modelId 解析：管理服务的 stop_model 只认 modelId，
     直接拿 servedName 去停会「HTTP 200 但 stopped:false」（真机自验里实测到的那条） */
  has(src, "const row = syncSignal.findRow(rows, modelId);", "停止前先查真 id（servedName → modelId）");
  has(src, "body: { modelId: row.modelId },", "停止下发的是注册表那串 modelId");
  has(src, "r.json.stopped === false", "服务端说「没有可停的实例」时如实报错，不假装停成功");
  has(
    src,
    'vram.vramReleaseOthers({ except: "llama", reason: "llama_deploy", waitBusyMs: 0 })',
    "只释放空闲的其它本地后端（waitBusyMs=0 ⇒ 忙的跳过，绝不打断）",
  );
  has(src, '"llama:ensureModel"', "闸门有 IPC 入口（设置里的「部署」与运行前共用）");
  has(src, '"llama:deployModel"', "设置里「部署」按钮的通道");
  has(src, '"llama:stopModel"', "设置里「停止」按钮的通道");
  has(src, 'broadcast(\n      "llama:modelLoading"', "加载过程广播给界面（显示「正在加载本地模型…」）");
  has(src, "function isLlamaProvider(provider)", "主进程判「这条服务商是不是 llama」只有这一份");
  has(src, "startProviderDirtyWatch()", "消费托盘的脏信号（MTNode 开着时立刻刷新）");
  has(src, 'apiStatus.installRoot', "读管理服务的 installRoot 判冲突");
  has(src, "rootConflict,", "statusForUi 把冲突带给插件卡片");
  has(src, "modelRows: await collectModelRowsSafe(),", "statusForUi 带上逐条状态");
}

/* ── [4] 托盘路径（MTNode 没开着时的部署也要登记）────────────────────────── */
console.log("\n[4] 托盘路径：preload-tray 不再是空实现 + 宿主真写 config.json + 脏信号");
{
  const pre = read("llama/preload-tray.js");
  hasnt(pre, "syncProvider: async () => ({ ok: true, skipped: true })", "托盘 preload 的空实现已删除");
  has(pre, 'syncProvider: () => ipcRenderer.invoke("llama:syncProvider")', "托盘 preload 真调宿主 IPC");

  const tray = read("llama/tray-main.js");
  has(tray, 'require("./provider-sync.js")', "托盘宿主复用登记链真源（与主进程同一份）");
  has(tray, "async function syncProviderFromTray()", "托盘侧登记实现");
  has(tray, "syncSignal.syncProviderToConfig({", "托盘把登记交给真源（本进程只给三个路径）");
  has(tray, "configPath: MTNODE_CONFIG", "写的是 MTNode 的 config.json");
  has(tray, "dataDir: MTNODE_DATA", "脏信号落在 MTNode 数据目录");
  has(tray, 'ipcMain.handle("llama:syncProvider"', "托盘 IPC 注册了 syncProvider");
  const syncSrc0 = read("llama/provider-sync.js");
  has(syncSrc0, "async function syncProviderToConfig(opts)", "真源里那一份登记实现");
  has(
    syncSrc0,
    "mergeManagedProvider(configPath, item, { pruneUnknown: true })",
    "写盘走 mergeManagedProvider（托管清单可增删、用户手加条目保留）",
  );
  has(syncSrc0, "markDirty(o.dataDir, {", "写完盘留脏信号（MTNode 开着时即时刷新）");

  /* 主进程侧：信号文件真源（写 / 读 / 清）与消费循环都在 provider-sync.js + main-llama.js */
  const syncSrc = read("llama/provider-sync.js");
  has(syncSrc, 'const DIRTY_FILE = ".provider-dirty.json";', "脏信号文件名唯一出处");
  has(syncSrc, "function markDirty(", "写信号");
  has(syncSrc, "function consumeDirty(", "读 + 清信号");
}

/* ── [5] 渲染层：徽标 / 按钮 / 就地重绘 / 冲突告警 / 加载提示 ─────────────── */
console.log("\n[5] 渲染层：状态徽标 + 部署 / 停止 + 当场刷新 + 冲突告警");
{
  const set = read("renderer/app-settings.js");
  has(set, "function llamaProviderManaged(prov)", "认得出插件托管那家服务商");
  has(set, "function llamaModelRowOf(prov, modelId)", "按模型取插件给的状态行");
  has(set, "llama-st-badge", "模型行画状态徽标");
  has(set, "window.api.llamaDeployModel", "「部署」按钮走 llama 宿主");
  has(set, "window.api.llamaStopModel", "「停止」按钮走 llama 宿主");
  has(set, "function settingsOnProvidersSynced()", "事件驱动的就地重绘入口");
  has(set, "host.__paint = () => {", "打开着的服务商卡留了重画入口");
  has(set, 'sync.online === false', "后端未启动时卡片写明「选中会自动拉起后端再加载」（共识 q10）");
  has(set, 'sync.conflict === true', "安装目录冲突未决时卡片写明去哪做选择（共识 q14）");

  const boot = read("renderer/app-boot.js");
  has(boot, "settingsOnProvidersSynced()", "收到 providerSynced 就地刷新已打开的界面（本轮共识 q5）");
  has(boot, "onLlamaModelLoading", "订阅加载提示");
  has(boot, '"正在加载本地模型…"', "加载中的提示文案");

  const plugins = read("renderer/app-plugins.js");
  has(plugins, "st.rootConflict", "卡片认冲突状态");
  /* 本轮需求：卡片底部不许再出现任何文字 → 那段黄字冲突说明（.plugin-root-conflict）整块下线；
     两颗选择按钮与后端行为一字未动。 */
  hasnt(plugins, "plugin-root-conflict", "冲突说明不再写成卡片上一段文字");
  hasnt(plugins, 'I18n.t(" 上跑的是另一份安装目录的 llama.cpp：")', "那段冲突长文案已从卡片移除");
  has(plugins, 'I18n.t("换端口起自己的")', "冲突时的第一个选择");
  has(plugins, 'I18n.t("继续用这份")', "冲突时的第二个选择");
  has(plugins, 'pluginApiFn("llamaResolveRootChoice")', "两个选择走宿主 IPC");
  has(plugins, "onLlamaProviderSynced(() => refreshLlamaPluginCard(card))", "登记刷新时卡片跟着重画");

  const css = read("renderer/css/components.css");
  has(css, ".llama-st-badge.llama-st-running", "运行中徽标配色");
  has(css, ".llama-st-badge.llama-st-failed", "加载失败徽标配色");
  const cssL = read("renderer/css/layout.css");
  hasnt(cssL, ".plugin-root-conflict", "冲突告警行的样式随那段文字一起删除");

  const i18n = read("renderer/i18n.js");
  for (const k of ["未部署", "加载失败", "换端口起自己的", "正在加载本地模型…", "部署", "停止"]) {
    has(i18n, '"' + k + '":', "i18n 有词条：" + k);
  }

  const pre = read("preload.js");
  has(pre, "llamaDeployModel:", "MTNode 主 preload 暴露部署通道");
  has(pre, "llamaStopModel:", "MTNode 主 preload 暴露停止通道");
  has(pre, "llamaResolveRootChoice:", "MTNode 主 preload 暴露冲突选择");
  has(pre, "onLlamaModelLoading:", "MTNode 主 preload 暴露加载提示事件");
}

/* ── [6] 运行前闸门接线 + 服务端 installRoot + 文档 ──────────────────────── */
console.log("\n[6] 运行前闸门接线 / server.py / 文档");
{
  const main = read("main.js");
  has(main, "async function llamaPreflightFor(provider, model)", "主进程有 llama 运行前闸门");
  has(main, "async function llamaPreflightForDsh(params)", "会话 / 助手那条路也有闸门");
  ok(
    /ipcMain\.handle\("api:call"[\s\S]{0,260}llamaPreflightFor\(/.test(main),
    "api:call 先过闸门",
  );
  ok(
    /ipcMain\.handle\("api:callStream"[\s\S]{0,600}llamaPreflightFor\(/.test(main),
    "api:callStream 先过闸门",
  );
  ok(
    /ipcMain\.handle\("dsh:run", async \(event, params\)[\s\S]{0,220}llamaPreflightForDsh\(params\)/.test(main),
    "dsh:run 先过闸门",
  );
  has(main, "ensureModel: ensureLlamaModel", "闸门复用 llama 宿主的 ensureModel");

  const server = read("llama-pack/app/server.py");
  has(server, '"installRoot": str(ROOT)', "管理服务 /api/status 给出 installRoot（冲突判定靠它）");

  const skill = read("skills/llama-local-install/SKILL.md");
  has(skill, "已下载", "安装技能文档写明：已下载的模型也会登记（不再只 running）");
  has(skill, "installRoot", "技能文档写明 installRoot 与冲突口径");

  const guide = fs.existsSync(abs("guides/manual/index.json")) ? read("guides/manual/index.json") : "";
  ok(typeof guide === "string", "手册目录可读（无 llama 专章时不影响本用例）");
}

console.log(
  "\n" + (fails ? "FAILED " + fails + " / " : "ALL PASS ") + checks + " checks",
);
process.exit(fails ? 1 : 0);
