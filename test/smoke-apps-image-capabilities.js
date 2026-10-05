"use strict";
/* 冒烟：应用侧图像生成通道（需求 1）与应用能力位（需求 2）
 *   node test/smoke-apps-image-capabilities.js
 *
 * 只钉本轮这两条需求，不重复 smoke-apps.js 已覆盖的窗口 / 数据 / 风格等口径：
 *   需求 1（图像通道）：云端「可用图像后端」按**模型形态**认（不再只看服务商 type 是否 image_*）、
 *     按应用 id 持久化的图像后端选择、云端 spec 下发（含 provider 形态纠偏）、参考图（路径 / dataURL）
 *     读盘、本机 SenseNova 后端出图（产物落应用数据目录 + 进度 + 取消）、全局互斥锁忙时的
 *     busy_media、旧签名 imageGen(opts) 行为不变；
 *   需求 2（能力位）：app.json 的 capabilities 归一（缺字段 = false = 不携带语音）、默认欢迎页
 *     按能力位注入 templates/app-default/dict.js、宿主只为声明了 textInput 的应用注入听写条、
 *     创建 / 切换能力位（含入口页重生成与 speech.js / speech.css 的补撤）、卡片能力小标。
 *
 * 被测对象是真源码：apps-store.js（真 require，只把 electron 换成桩）、apps-capabilities.js、
 * preload-app.js / preload.js / templates/ 与 renderer 的接线（源码口径断言）。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const os = require("os");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel.split("/").join(path.sep)));

let checks = 0;
let fails = 0;
function ok(cond, msg) {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
}

console.log("smoke-apps-image-capabilities：图像通道 + 应用能力位\n");

/* 1x1 真 PNG：参考图那几条要过 imagePartUrl 的「能解码成图」判据（假字节会被判 bad_image） */
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AGtE0kAAAAASUVORK5CYII=",
  "base64",
);

/* ---------- 假 electron（只提供 apps-store.js 真正用到的那几样）---------- */
const wcCalls = [];
function fakeWebContents() {
  const wc = {
    on() {},
    setWindowOpenHandler() {},
    send() {},
    isDestroyed: () => false,
  };
  wcCalls.push(wc);
  return wc;
}
function fakeWindow() {
  const w = {
    webContents: fakeWebContents(),
    isDestroyed: () => false,
    on() {},
    once() {},
    setMenu() {},
    setAlwaysOnTop() {},
    loadFile() {},
    show() {},
    focus() {},
    close() {},
    isVisible: () => false,
    getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    setBounds() {},
  };
  return w;
}
const ipcMainMock = {
  __handlers: Object.create(null),
  handle(ev, cb) {
    this.__handlers[ev] = cb;
  },
  on() {},
  removeHandler() {},
};
const electronMock = {
  app: {
    getPath: (k) =>
      k === "exe" ? path.join(ROOT, "node_modules", "electron", "dist", "electron.exe") : ROOT,
    getAppPath: () => ROOT,
    getVersion: () => "9.9.9",
    isPackaged: false,
    on() {},
    whenReady: async () => {},
    quit() {},
  },
  ipcMain: ipcMainMock,
  BrowserWindow: Object.assign(function () {
    return fakeWindow();
  }, {
    getAllWindows: () => [],
    fromWebContents: () => null,
  }),
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openExternal: async () => {}, openPath: async () => "", trashItem: async () => {} },
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  protocol: { registerSchemesAsPrivileged() {}, handle() {} },
  session: { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }) },
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return electronMock;
  return realLoad.call(this, request, parent, isMain);
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-apps-img-"));
const DATA = path.join(TMP, "data");
const APPS_ROOT = path.join(TMP, "apps-root");
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(APPS_ROOT, { recursive: true });
const REF_PNG = path.join(TMP, "ref.png");
fs.writeFileSync(REF_PNG, PNG_1PX);
const cfgPath = path.join(DATA, "config.json");
fs.writeFileSync(cfgPath, JSON.stringify({ apps: { installDir: APPS_ROOT } }, null, 2), "utf8");

const store = require("../apps-store.js");

/* 内核桩：把宿主真正下发的 spec 记下来（图像那一路就是靠它钉住「下发了什么」） */
const aiSpecs = [];
const localGen = [];
const localCancels = [];
let localInfo = { ok: true, installed: true, running: false, phase: "idle", vramMode: "fast", port: 8774 };
let mediaLock = null;

store.registerAppsIpc({
  getDataDir: () => DATA,
  getMainWin: () => null,
  getAppVersion: () => "9.9.9",
  t: (s) => String(s == null ? "" : s),
  authState: () => ({ ok: true, loggedIn: false, user: null, encryption: "plain" }),
  aiCall: async (spec) => {
    aiSpecs.push(spec || {});
    return { base64: Buffer.from("fake-png").toString("base64"), ext: "png" };
  },
  aiCallStream: async (spec) => {
    aiSpecs.push(spec || {});
    return { text: "x", reasoning: "", finishReason: "stop" };
  },
  localImageHost: () => localInfo,
  localImageGenerate: async (params) => {
    localGen.push(params || {});
    const p = REF_PNG;
    fs.writeFileSync(p, PNG_1PX);
    return { ok: true, path: p, bytes: 15, width: 1024, height: 1024, ratio: "1:1", seed: 7, warnings: [] };
  },
  localImageCancel: async (nodeId) => {
    localCancels.push(String(nodeId || ""));
    return { ok: true };
  },
  localImageSnapshot: async () => ({ stage: "generate", message: "采样中", pct: 42, step: 21, totalSteps: 50, elapsedSec: 9 }),
  readMediaLock: () => mediaLock,
});

/* 应用安装根目录：与 smoke-apps.js 同一姿势（新建应用要落在这个临时根里） */
store.setRoot(APPS_ROOT);

/* 应用窗口事件：应用侧接口按**发送方窗口**认应用（apps-store 里是一张 WeakMap），
   所以断言必须用**真开出来的窗口**的 webContents —— 自造对象会认不出应用（not_app）。 */
const wcByApp = new Map();
function appEvt(id) {
  const sid = String(id || "");
  let wc = wcByApp.get(sid);
  if (!wc) {
    const opened = store.openAppWindow(sid);
    if (!opened || opened.ok !== true) throw new Error("开窗失败：" + sid);
    wc = wcCalls[wcCalls.length - 1];
    wcByApp.set(sid, wc);
  }
  return { sender: wc };
}

function setConfig(providers, modelKinds) {
  fs.writeFileSync(
    cfgPath,
    JSON.stringify({ apps: { installDir: APPS_ROOT }, providers: providers, modelKinds: modelKinds || {} }, null, 2),
    "utf8",
  );
}

(async () => {
  /* 开窗前先把测试用应用建出来：openAppWindow 会校验应用目录存在（认 id 也认目录） */
const appX = store.createApp({ name: "图像通道冒烟", id: "app-x" });
const appOther = store.createApp({ name: "别的应用", id: "another-app" });
if (!appX || appX.ok !== true || !appOther || appOther.ok !== true) {
  console.error("建测试应用失败：", appX, appOther);
  process.exit(1);
}

  /* ════════════════ [1] 需求 1：云端图像后端按模型形态认 ════════════════ */
  console.log("[1] 图像后端清单：按模型形态认（不再只看服务商 type）");
  setConfig(
    [
      { id: "pt", name: "纯文本家", type: "text_openai", baseUrl: "https://t.example", apiKey: "k", models: ["deepseek-v4-flash"], vision: true },
      { id: "pm", name: "混合家", type: "text_openai", baseUrl: "https://m.example", apiKey: "k", models: ["qwen3.7-plus", "gpt-image-2-vip"] },
      { id: "pi", name: "图像家", type: "image_openai", baseUrl: "https://i.example", apiKey: "k", models: ["img-1"] },
    ],
    { pm: { "gpt-image-2-vip": "image" }, pt: { "deepseek-v4-flash": "text" } },
  );
  const imgProviders = store.usableImageProviders().map((p) => String(p.id));
  ok(
    imgProviders.length === 2 && imgProviders.indexOf("pm") >= 0 && imgProviders.indexOf("pi") >= 0,
    "可用图像后端 = image_openai 卡 + text_openai 卡上被标成 image 的模型（本机最常见的错配也能用）",
  );
  const cloud = store.listCloudImageModels();
  ok(
    cloud.length === 2 && cloud[0].id === "gpt-image-2-vip" && cloud[0].providerName === "混合家" && cloud[1].id === "img-1",
    "云端图像模型清单：顺序照服务商优先级，每项带来源；纯文本模型不进清单",
  );
  ok(cloud.every((m) => m.apiKey === undefined && m.baseUrl === undefined), "清单里没有 apiKey / baseUrl（凭据不出主进程）");
  setConfig(
    [
      { id: "pt", name: "纯文本家", type: "text_openai", baseUrl: "https://t.example", apiKey: "k", models: ["deepseek-v4-flash"], vision: true },
      { id: "pm", name: "混合家", type: "text_openai", baseUrl: "https://m.example", apiKey: "k", models: ["qwen3.7-plus", "gpt-image-2-vip"] },
      { id: "pi", name: "图像家", type: "image_openai", baseUrl: "https://i.example", apiKey: "k", models: ["img-1"] },
    ],
    { pm: { "gpt-image-2-vip": "text" }, pt: { "deepseek-v4-flash": "text" } },
  );
  ok(store.listCloudImageModels().length === 1, "modelKinds 标成 text → 该模型退出图像清单（人工覆盖优先）");
  setConfig(
    [
      { id: "pt", name: "纯文本家", type: "text_openai", baseUrl: "https://t.example", apiKey: "k", models: ["deepseek-v4-flash"], vision: true },
      { id: "pm", name: "混合家", type: "text_openai", baseUrl: "https://m.example", apiKey: "k", models: ["qwen3.7-plus", "gpt-image-2-vip"] },
      { id: "pi", name: "图像家", type: "image_openai", baseUrl: "https://i.example", apiKey: "k", models: ["img-1"] },
    ],
    { pm: { "gpt-image-2-vip": "image" }, pt: { "deepseek-v4-flash": "text" } },
  );
  setConfig([{ id: "pt", name: "纯文本家", type: "text_openai", baseUrl: "https://t.example", apiKey: "k", models: ["deepseek-v4-flash"], vision: true }], {});
  ok(
    store.listCloudImageModels().length === 0 && store.imageModelsPayload(appEvt("app-x")).hasCloud === false,
    "只配了文本模型 → 云端图像清单为空（不把文本模型当图像后端）",
  );
  setConfig(
    [
      { id: "pt", name: "纯文本家", type: "text_openai", baseUrl: "https://t.example", apiKey: "k", models: ["deepseek-v4-flash"], vision: true },
      { id: "pm", name: "混合家", type: "text_openai", baseUrl: "https://m.example", apiKey: "k", models: ["qwen3.7-plus", "gpt-image-2-vip"] },
      { id: "pi", name: "图像家", type: "image_openai", baseUrl: "https://i.example", apiKey: "k", models: ["img-1"] },
    ],
    { pm: { "gpt-image-2-vip": "image" }, pt: { "deepseek-v4-flash": "text" } },
  );

  /* ════════════════ [2] 选择与持久化 ════════════════ */
  console.log("[2] 图像后端选择：auto / 显式 / 越界 / 按应用持久化");
  const autoPick = store.resolveImagePick("app-x", "");
  ok(autoPick.id === "gpt-image-2-vip" && autoPick.auto === true && autoPick.local !== true, "auto = 云端优先级第一条");
  ok(store.resolveImagePick("app-x", "img-1").id === "img-1", "显式给清单内的 id → 用它");
  ok(store.resolveImagePick("app-x", "no-such-model").error === "bad_model", "清单外的 id → bad_model");
  store.writeImageSelection("app-x", "img-1");
  ok(store.resolveImagePick("app-x", "").id === "img-1", "没显式给时用该应用存过的选择");
  const selFile = JSON.parse(fs.readFileSync(path.join(DATA, "apps-models.json"), "utf8"));
  ok(selFile.image && selFile.image["app-x"] === "img-1", "图像选择与文字选择同存 apps-models.json（image.<appId>）");
  const textSel = store.readModelSelection("app-x");
  ok(textSel === "", "图像选择不污染文字模型的选择（两套各存各的）");
  store.writeImageSelection("app-x", "auto");
  ok(store.readImageSelection("app-x") === "", "选回 auto = 删掉条目");

  /* ════════════════ [3] 云端出图：spec 下发与形态纠偏 ════════════════ */
  console.log("[3] 云端出图：spec 下发（提示词 / 模型 / 尺寸 / 形态纠偏）");
  const evt = appEvt("app-x");
  aiSpecs.length = 0;
  const cloudOut = await store.hostImageStream(evt, { prompt: "画一只猫", model: "gpt-image-2-vip", size: "1024x1024" });
  const spec1 = aiSpecs[aiSpecs.length - 1] || {};
  ok(cloudOut.ok === true && /^data:image\/png;base64,/.test(String(cloudOut.dataUrl)), "云端出图：回 base64 + dataUrl");
  ok(cloudOut.via === "cloud" && cloudOut.model === "gpt-image-2-vip", "回执带 via / model（应用看得出走的哪条路）");
  ok(
    spec1.kind === "image" && spec1.model === "gpt-image-2-vip" && spec1.prompt === "画一只猫" && spec1.size === "1024x1024",
    "下发的 spec = kind:image + 选中的模型 + 提示词与尺寸",
  );
  ok(
    spec1.provider && spec1.provider.type === "image_openai" && String(spec1.provider.baseUrl) === "https://m.example",
    "配成 text_openai 的混合端点被纠正成 image_openai 副本（与画布 proc_image 同一口径）",
  );
  ok(
    JSON.parse(fs.readFileSync(cfgPath, "utf8")).providers[1].type === "text_openai",
    "纠偏只发生在副本上：config.json 里的 type 没被改写",
  );
  ok((await store.hostImageStream(evt, { prompt: "   " })).code === "no_prompt", "空提示词 → no_prompt（不白烧一次调用）");
  const legacyOut = await store.hostImage(evt, { prompt: "旧调用", model: "gpt-image-2-vip" });
  ok(legacyOut.ok === true && !!legacyOut.base64 && !!legacyOut.mime, "旧签名 imageGen(opts) 行为不变（只多出 via / model 旁证）");

  /* ════════════════ [4] 参考图（图生图 / 图像编辑）════════════════ */
  console.log("[4] 参考图：本机路径与 dataURL 都收，坏图跳过并给警告");
  const refOk = store.imageRefDataUrls({ images: [REF_PNG] });
  ok(refOk.images.length === 1 && /^data:image\/png;base64,/.test(refOk.images[0]), "本机图片路径 → 主进程读盘成 dataURL");
  const refBad = store.imageRefDataUrls({ images: ["a.png", path.join(TMP, "nope.png")] });
  ok(refBad.images.length === 0 && refBad.warnings.length === 2, "相对路径 / 文件不存在一律跳过并如实给警告");
  const du = "data:image/png;base64," + Buffer.from("x").toString("base64");
  ok(store.imageRefDataUrls({ images: [du] }).images.length === 1, "dataURL 参考图原样可用");
  aiSpecs.length = 0;
  await store.hostImageStream(evt, { prompt: "改这张图", model: "gpt-image-2-vip", image: REF_PNG });
  const refSpec = aiSpecs[aiSpecs.length - 1] || {};
  ok(
    String(refSpec.refImage || "").indexOf("data:image/png") === 0,
    "带参考图的请求把第一张作为 refImage 下发（Stability 那条路吃它）",
  );
  /* A（本次修复）：参考图必须**整组**进 spec.images —— buildRequestSpec 的 OpenAI 兼容分支
     只在 images 非空时才走 /images/edits，只给 refImage 的话云端等于没收到参考图（回落纯文生图）。 */
  ok(
    Array.isArray(refSpec.images) &&
      refSpec.images.length === 1 &&
      String(refSpec.images[0]).indexOf("data:image/png") === 0,
    "参考图整组进 spec.images（下游才会走 /images/edits，不再回落 /images/generations）",
  );
  aiSpecs.length = 0;
  await store.hostImageStream(evt, {
    prompt: "两张一起改",
    model: "gpt-image-2-vip",
    images: [REF_PNG, du],
  });
  const multiSpec = aiSpecs[aiSpecs.length - 1] || {};
  ok(
    Array.isArray(multiSpec.images) &&
      multiSpec.images.length === 2 &&
      multiSpec.refImage === multiSpec.images[0],
    "多张参考图整组下发（images 2 条 · refImage 仍是第 1 张）—— 与画布 proc_image 同口径",
  );

  /* ════════════════ [4b] 参考强度（strength）与图像编辑入口 ════════════════ */
  console.log("[4b] 参考强度：本机后端生效（imgCfgScale）· 云端如实警告 · imageEdit 参考图必填");
  ok(
    store.strengthOf({ strength: 1.5 }) === 1 &&
      store.strengthOf({ strength: -1 }) === 0 &&
      store.strengthOf({}) === null &&
      store.strengthOf({ strength: "x" }) === null,
    "strength 归一：0–1 夹紧 · 空 / 非数 = 不传（null）",
  );
  ok(
    store.imgCfgScaleOf({ strength: 0 }) === 1 &&
      store.imgCfgScaleOf({ strength: 1 }) === 4 &&
      store.imgCfgScaleOf({}) === null,
    "strength → imgCfgScale：0 → 1.0（官方默认关闭图像 CFG）· 1 → 4.0（与 cfgScale 同尺度）",
  );
  aiSpecs.length = 0;
  const rStr = await store.hostImageStream(evt, {
    prompt: "参考强度",
    model: "gpt-image-2-vip",
    image: REF_PNG,
    strength: 0.8,
  });
  ok(
    rStr.ok === true &&
      Array.isArray(rStr.warnings) &&
      rStr.warnings.join(" ").indexOf("strength_unsupported") >= 0,
    "云端没有参考强度这个参数：如实进 warnings（不假装支持、也不静默丢）",
  );
  localGen.length = 0;
  store.writeImageSelection("app-x", store.LOCAL_IMAGE_PROVIDER_ID);
  await store.hostImageStream(evt, { prompt: "本机改图", image: REF_PNG, strength: 0.5 });
  store.writeImageSelection("app-x", "auto");
  ok(
    localGen.length === 1 && Math.abs(Number(localGen[0].imgCfgScale) - 2.5) < 1e-9,
    "本机后端：strength 0.5 → imgCfgScale 2.5（历史 bug：宿主适配器没透传，应用侧调不到强度）",
  );
  ok(
    Array.isArray(localGen[0].refImages) && localGen[0].refImages.length === 1,
    "本机后端：参考图走 refImages（后端一次吃 1–4 张）",
  );
  const noRef = await store.hostImageEdit(evt, { prompt: "改图" });
  ok(
    noRef.ok === false && noRef.code === "no_ref_image",
    "imageEdit：没有参考图 → no_ref_image（明确报错，**不降级**成文生图）",
  );
  aiSpecs.length = 0;
  const edOk = await store.hostImageEdit(evt, { prompt: "改图", images: [REF_PNG] });
  ok(
    edOk.ok === true &&
      Array.isArray((aiSpecs[aiSpecs.length - 1] || {}).images) &&
      aiSpecs[aiSpecs.length - 1].images.length === 1,
    "imageEdit：带参考图走与 imageGen 同一份实现（images 真下发）",
  );

  /* ════════════════ [4c] 后端能力声明 + 宿主内部出图（函数节点共用内核）════════════════ */
  console.log("[4c] hostImageModels 能力三字段 · imageBackendsForUi · hostImageGenerate");
  setConfig(
    [
      { id: "pi", name: "图像家", type: "image_openai", baseUrl: "https://i.example", apiKey: "k", models: ["img-1"] },
      { id: "ps", name: "稳定家", type: "image_stability", baseUrl: "https://s.example", apiKey: "k", models: ["sd-1"] },
      { id: "pmj", name: "MJ家", type: "image_mj", baseUrl: "https://m.example", apiKey: "k", models: ["mj-1"] },
    ],
    {},
  );
  const caps = (id) => store.listCloudImageModels().filter((m) => m.id === id)[0] || {};
  ok(
    caps("img-1").refImages === true && caps("img-1").maxRefImages === 8 && caps("img-1").strength === false,
    "OpenAI 兼容图像端点：支持参考图（≤8 张 = 一条消息的既有多模态配额）· 不支持参考强度",
  );
  ok(
    caps("sd-1").refImages === true && caps("sd-1").maxRefImages === 1,
    "Stability：只吃 1 张参考图（能力字段按真实接口族声明）",
  );
  ok(
    caps("mj-1").refImages === false && caps("mj-1").maxRefImages === 0,
    "MJ 自定义接口：不吃参考图（界面据此置灰，不让用户试错）",
  );
  localInfo = { ok: true, installed: true, running: false, phase: "idle", vramMode: "fast", port: 8774 };
  const localCaps = store.localImageBackend();
  ok(
    localCaps.refImages === true && localCaps.maxRefImages === 4 && localCaps.strength === true,
    "本机 SenseNova：多张参考图（1–4 张）+ 参考强度（唯一认 strength 的后端）",
  );
  const uiList = store.imageBackendsForUi();
  ok(
    uiList.ok === true &&
      uiList.hasCloud === true &&
      uiList.hasLocal === true &&
      uiList.models.length === store.listCloudImageModels().length + 1 &&
      typeof uiList.defaultModel === "string",
    "imageBackendsForUi：主窗口渲染层拿到的清单与应用窗口同一份（含本机那条）",
  );
  aiSpecs.length = 0;
  const hg = await store.hostImageGenerate({
    appId: "fn-n1",
    opts: { prompt: "宿主内部出图", model: "img-1" },
  });
  ok(
    hg.ok === true && aiSpecs.length === 1 && aiSpecs[0].kind === "image",
    "hostImageGenerate：函数节点的 mtnode.image 与应用通道共用同一份内核（同一个 spec 下发）",
  );
  const hgAuto = await store.hostImageGenerate({ appId: "fn-n1", opts: { prompt: "跟随默认" } });
  ok(hgAuto.ok === true, "hostImageGenerate：不给模型 → 走 auto（云端优先）");
  const hgNoPrompt = await store.hostImageGenerate({ appId: "fn-n1", opts: { prompt: "   " } });
  ok(
    hgNoPrompt.ok === false && hgNoPrompt.code === "no_prompt",
    "hostImageGenerate：空提示词 → no_prompt（不白烧一次调用）",
  );
  /* 能力字段这一段的配置只为这三条断言而设：用完恢复成 [3] 段那份（后面的段落接着用它） */
  setConfig(
    [
      { id: "pt", name: "纯文本家", type: "text_openai", baseUrl: "https://t.example", apiKey: "k", models: ["deepseek-v4-flash"], vision: true },
      { id: "pm", name: "混合家", type: "text_openai", baseUrl: "https://m.example", apiKey: "k", models: ["qwen3.7-plus", "gpt-image-2-vip"] },
      { id: "pi", name: "图像家", type: "image_openai", baseUrl: "https://i.example", apiKey: "k", models: ["img-1"] },
    ],
    { pm: { "gpt-image-2-vip": "image" }, pt: { "deepseek-v4-flash": "text" } },
  );

  /* ════════════════ [5] 本机 SenseNova 后端 ════════════════ */
  console.log("[5] 本机后端：清单 / 出图 / 进度 / 取消 / 忙时错误码");
  localInfo = { ok: true, installed: true, running: false, phase: "idle", vramMode: "fast", port: 8774 };
  const localModel = store.resolveImagePick("app-x", store.LOCAL_IMAGE_PROVIDER_ID);
  ok(localModel.id === store.LOCAL_IMAGE_PROVIDER_ID && localModel.local === true, "本机 SenseNova 装了就能被选中");
  const listPayload = store.imageModelsPayload(appEvt("app-x"));
  ok(
    listPayload.ok === true && listPayload.hasCloud === true && listPayload.hasLocal === true && listPayload.models.length === 3,
    "hostImageModels 清单：云端 2 + 本机 1（另带 hasCloud / hasLocal 便于界面提示）",
  );
  ok(store.hostImageModelSet(appEvt("app-x"), { model: "nope" }).code === "bad_model", "改图像后端：清单外的 id 一律拒绝");
  const setOk = store.hostImageModelSet(appEvt("app-x"), { model: store.LOCAL_IMAGE_PROVIDER_ID });
  ok(setOk.ok === true && setOk.selected === store.LOCAL_IMAGE_PROVIDER_ID, "改图像后端：选本机那条能存下来");
  store.hostImageModelSet(appEvt("app-x"), { model: "auto" });

  localGen.length = 0;
  const progress = [];
  const localOut = await store.hostImageStream(
    appEvt("app-x"),
    { prompt: "本机画一张", model: store.LOCAL_IMAGE_PROVIDER_ID, reqId: "req-local-1" },
  );
  ok(
    localOut.ok === true && localOut.via === "local" && String(localOut.file || "").indexOf("ref.png") > 0,
    "本机出图：回路径 + via:local（产物在应用数据目录，路径可直接交给 save / 素材库）",
  );
  ok(
    String(localOut.dataUrl || "").indexOf("data:image/png;base64,") === 0 && localOut.bytes > 0,
    "本机出图：同时回 base64 / dataUrl（与云端同一形状，应用只写一套）",
  );
  ok(localGen.length === 1 && String(localGen[0].nodeId || "").indexOf("app-") === 0, "本机适配器收到 nodeId（占全局互斥锁用）");
  void progress;
  const cancelOther = await store.hostImageCancel(appEvt("another-app"), { reqId: "req-local-1" });
  ok(cancelOther.cancelled === false, "取消只能撤自己那条请求（别的应用拿不到别人的 reqId）");
  localInfo = { ok: true, installed: false, running: false, phase: "not_installed" };
  ok(
    store.resolveImagePick("app-x", store.LOCAL_IMAGE_PROVIDER_ID).error === "bad_model",
    "本机后端没装 → 它不在清单里，显式点它也回 bad_model（不假装能用）",
  );
  localInfo = { ok: true, installed: true, running: false, phase: "idle" };
  /* 一个云端都没配 + 本机也没装 → 真的没有可用后端 */
  localInfo = { ok: true, installed: false, running: false, phase: "not_installed" };
  setConfig([], {});
  ok(store.resolveImagePick("app-x", "").error === "no_provider", "云端与本机都没有 → no_provider");
  localInfo = { ok: true, installed: true, running: false, phase: "idle" };
  const onlyLocal = store.resolveImagePick("app-x", "");
  ok(onlyLocal.local === true && onlyLocal.id === store.LOCAL_IMAGE_PROVIDER_ID, "一个云端都没配时 auto 落本机后端（不是 no_provider）");
  setConfig(
    [
      { id: "pm", name: "混合家", type: "text_openai", baseUrl: "https://m.example", apiKey: "k", models: ["gpt-image-2-vip"] },
    ],
    { pm: { "gpt-image-2-vip": "image" } },
  );
  mediaLock = { nodeId: "video-node-1", kind: "video_gen", startedAt: Date.now() };
  ok(store.imageModelsPayload(appEvt("app-x")).busy === true, "清单带 busy 位：全局互斥锁被占着时先告诉应用");
  mediaLock = null;

  /* ════════════════ [6] 应用能力位：归一口径 ════════════════ */
  console.log("[6] 能力位：归一（缺字段 = false = 默认不携带语音 / 不显示听写条）");
  const norm0 = store.normCapabilities({});
  ok(
    norm0.textInput === false && norm0.imageGen === false && norm0.showDictate === false,
    "缺字段的能力位一律 false（存量应用按不携带语音、不显示听写条处理）",
  );
  const norm1 = store.normCapabilities({ textInput: "yes", imageGen: 1, showDictate: "on", evil: true });
  ok(
    norm1.textInput === false && norm1.imageGen === false && norm1.showDictate === false && norm1.evil === undefined,
    "只认真布尔、不认识的键丢掉（不写脏数据）",
  );
  ok(store.capabilityOn({ textInput: true }, "textInput") === true && store.capabilityOn(null, "textInput") === false, "capabilityOn：没声明 = 关");
  ok(store.capabilityOn({ showDictate: true }, "showDictate") === true, "capabilityOn 认新位 showDictate（宿主注入闸门只看它）");
  ok(
    JSON.stringify(store.capabilityBadges({ textInput: true, showDictate: true, imageGen: true }, "zh")) ===
      JSON.stringify(["文字输入", "显示听写条", "图像生成"]),
    "卡片小标：只列已声明为真的能力（顺序固定）",
  );
  ok(
    store.capabilityBadges({ textInput: true }, "en").join(",") === "Text input",
    "卡片小标跟随界面语言（英文界面走 en 标签）",
  );

  /* ════════════════ [7] 默认欢迎页按能力位注入 ════════════════ */
  console.log("[7] 默认欢迎页：没声明不带听写条，声明了才内联 dict.js");
  const TPL = read("templates/app-default/index.html");
  ok(TPL.indexOf("DICT_SCRIPT") > 0, "模板留有 {{DICT_SCRIPT}} 注入位（由宿主按能力填）");
  ok(
    TPL.indexOf("dict-btn") < 0 && TPL.indexOf("dictPanel") < 0 && TPL.indexOf("const dict = (() => {") < 0,
    "模板本体不再含听写 UI（标记 / 结果小窗 / 内联实现全部搬走）",
  );
  /* 本轮共识：默认 footer 内容（页脚那一行说明）整块删掉 —— 页面底部不再凭空多一行字 */
  ok(
    TPL.indexOf('class="foot"') < 0 && TPL.indexOf("footText") < 0 && TPL.indexOf("说第一句就会变成你的应用") < 0,
    "默认页页脚说明文案整块删掉（.foot / .foot-line / #footText 与两语言文案都不在）",
  );
  const DICT = read("templates/app-default/dict.js");
  ok(
    DICT.indexOf("MTNDictate") > 0 && DICT.indexOf("transcribeWav") > 0 && DICT.indexOf("pickAudio") > 0 && DICT.indexOf("mtnode-dictate") > 0,
    "听写条搬到 templates/app-default/dict.js（走应用桥的 transcribeWav / pickAudio，结果事件名不变）",
  );
  const pageOff = store.defaultPageHtml({ id: "cap-smoke", name: "能力冒烟", capabilities: {} });
  ok(
    pageOff.indexOf("dict-btn") < 0 && pageOff.indexOf("dictPanel") < 0 && pageOff.indexOf("mtnode-dictate-css") < 0,
    "没声明显示听写条 → 入口页里没有任何听写 UI",
  );
  ok(pageOff.indexOf("DICT_SCRIPT") < 0, "注入位被替换（落盘页面里不留占位符）");
  /* 只声明 textInput（要语音模块）不再等于要显示听写条：入口页仍旧不带它。
     判据用内联进来才有的 'id = "mtnode-dictate-css"' —— 模板里那行 if (window.MTNDictate…) 一直在。 */
  const pageTyped = store.defaultPageHtml({ id: "cap-smoke", name: "能力冒烟", capabilities: { textInput: true } });
  ok(
    pageTyped.indexOf('id = "mtnode-dictate-css"') < 0,
    "只声明 textInput → 入口页仍不带听写条（要显示得声明 showDictate）",
  );
  const pageOn = store.defaultPageHtml({ id: "cap-smoke", name: "能力冒烟", capabilities: { showDictate: true } });
  ok(pageOn.indexOf("MTNDictate") > 0 && pageOn.indexOf('id = "mtnode-dictate-css"') > 0, "声明了 showDictate → 内联 dict.js（仍是单文件）");
  ok(pageOn.split("</script>").length > pageOff.split("</script>").length, "声明后多出一个 script 块（就是那份听写模块）");

  /* ════════════════ [8] 宿主注入闸门与桥的接口面 ════════════════ */
  console.log("[8] 宿主注入闸门：preload 先问能力位；桥上的接口始终保留");
  const PRE_APP = read("preload-app.js");
  ok(PRE_APP.indexOf("apps:hostCapabilities") > 0 && PRE_APP.indexOf("maybeInjectDictateBar") > 0, "注入前先问 apps:hostCapabilities（问不到 = 按没声明处理）");
  ok(
    PRE_APP.indexOf("capabilities.showDictate === true") > 0,
    "注入闸门看的是 showDictate（默认 false = 默认不注入听写条）",
  );
  /* 默认隐藏（本轮共识）：注入脚本挂上后自带隐藏标记，placeStrip 不动隐藏态；要露面走 apSpeechReveal */
  const SPEECH_UI = read("renderer/app-speech-ui.js");
  ok(
    SPEECH_UI.indexOf('"data-mtnode-hidden"') > 0 &&
      SPEECH_UI.indexOf("markHidden(root)") > 0 &&
      SPEECH_UI.indexOf("display:none !important") > 0,
    "听写条默认隐藏：@mtnode-dictate 带 data-mtnode-hidden + display:none（内联 + CSS 兜底）",
  );
  ok(
    /function placeStrip[\s\S]{0,260}hiddenNow\(root\)/.test(SPEECH_UI),
    "隐藏态不做落点搬移（不会把隐藏的条搬到宿主自建的固定底栏）",
  );
  ok(
    SPEECH_UI.indexOf("window.apSpeechHidden") > 0 && SPEECH_UI.indexOf("window.apSpeechReveal") > 0,
    "露出路径仍在：apSpeechHidden() / apSpeechReveal()",
  );
  ok(
    PRE_APP.indexOf("pickAudio") > 0 && PRE_APP.indexOf("transcribeWav") > 0 && PRE_APP.indexOf("asrStatus") > 0,
    "桥上的语音接口始终保留（能力位不是权限闸：应用自写的语音 UI 照旧能用）",
  );
  ok(
    PRE_APP.indexOf("hostImageModels") > 0 && PRE_APP.indexOf("hostImageSetModel") > 0 && PRE_APP.indexOf("imageGenCancel") > 0,
    "桥暴露 hostImageModels / hostImageModel / hostImageSetModel / imageGenCancel",
  );
  ok(PRE_APP.indexOf("imageGen: (opts, cb)") > 0, "imageGen 仍是一个函数（旧应用传一个参数照样跑）");
  const APP_SRC = read("apps-store.js");
  ok(
    APP_SRC.indexOf('ipcMain.handle("apps:hostCapabilities"') > 0 &&
      APP_SRC.indexOf('ipcMain.handle("apps:hostImageStream"') > 0 &&
      APP_SRC.indexOf('ipcMain.handle("apps:hostImageCancel"') > 0 &&
      APP_SRC.indexOf('ipcMain.handle("apps:hostImageModels"') > 0 &&
      APP_SRC.indexOf('ipcMain.handle("apps:capabilitiesGet"') > 0 &&
      APP_SRC.indexOf('ipcMain.handle("apps:capabilitiesSet"') > 0,
    "主进程注册齐了新增通道（图像 4 条 + 能力位 3 条）",
  );
  ok(read("preload.js").indexOf("appsCapabilitiesGet") > 0 && read("preload.js").indexOf("appsCapabilitiesSet") > 0, "主窗口桥转发能力位两条");

  /* ════════════════ [9] 创建 / 切换能力位（真建应用）════════════════ */
  console.log("[9] 创建与切换能力位：app.json / 入口页 / 语音文件");
  const made = store.createApp({ name: "能力冒烟", id: "cap-smoke", capabilities: { textInput: true, imageGen: true, showDictate: true } });
  ok(made.ok === true, "createApp 接受 capabilities（新建浮层那几个复选框）");
  const manRaw = JSON.parse(fs.readFileSync(path.join(made.dir, "app.json"), "utf8"));
  ok(
    manRaw.capabilities &&
      manRaw.capabilities.textInput === true &&
      manRaw.capabilities.imageGen === true &&
      manRaw.capabilities.showDictate === true,
    "capabilities 真写进 app.json（含新位 showDictate）",
  );
  ok(
    fs.readFileSync(path.join(made.dir, "index.html"), "utf8").indexOf("mtnode-dictate-css") > 0,
    "新建时声明了显示听写条 → 入口页当场带听写条",
  );
  const capGet = store.appCapabilitiesGet({ id: "cap-smoke" });
  ok(capGet.ok === true && capGet.list.length === 3 && capGet.list[0].on === true, "appCapabilitiesGet 回能力位 + 给界面用的清单（三项）");
  const capOff = store.appCapabilitiesSet({ id: "cap-smoke", capabilities: { textInput: false, imageGen: true, showDictate: true } });
  ok(capOff.ok === true && capOff.capabilities.textInput === false, "appCapabilitiesSet 整份替换能力位");
  ok(
    fs.readFileSync(path.join(made.dir, "index.html"), "utf8").indexOf("mtnode-dictate-css") > 0,
    "关掉文字输入但留着显示听写条 → 入口页里的听写条仍在（两位互不牵连）",
  );
  const capHide = store.appCapabilitiesSet({ id: "cap-smoke", capabilities: { textInput: false, imageGen: true, showDictate: false } });
  ok(capHide.ok === true && capHide.capabilities.showDictate === false, "关掉显示听写条 → 声明落盘");
  ok(
    fs.readFileSync(path.join(made.dir, "index.html"), "utf8").indexOf("mtnode-dictate-css") < 0,
    "关掉显示听写条 → 入口页重生成，听写 UI 随之消失",
  );
  ok(
    !fs.existsSync(path.join(made.dir, "speech.js")) && !fs.existsSync(path.join(made.dir, "speech.css")),
    "关掉文字输入 → 应用目录里不再留 speech.js / speech.css",
  );
  const capOn = store.appCapabilitiesSet({ id: "cap-smoke", capabilities: { textInput: true } });
  ok(
    capOn.ok === true && capOn.wroteFiles.indexOf("speech.js") >= 0 && capOn.wroteFiles.indexOf("speech.css") >= 0,
    "打开文字输入 → 把脚手架里的 speech.js / speech.css 补进应用目录",
  );
  ok(fs.existsSync(path.join(made.dir, "speech.js")), "语音文件真的落在应用目录里");
  const manAfter = JSON.parse(fs.readFileSync(path.join(made.dir, "app.json"), "utf8"));
  ok(manAfter.capabilities.imageGen === false, "没提到的位按 false 归一（整份替换语义）");
  const capNoRegen = store.appCapabilitiesSet({ id: "cap-smoke", capabilities: { textInput: true }, regenEntry: false });
  ok(capNoRegen.ok === true && !capNoRegen.regeneratedEntry, "regenEntry:false 只写声明、不碰入口页（给手写页面的应用留出口）");
  const list = store.listApps().apps.find((a) => a.id === "cap-smoke");
  ok(list && list.capabilityBadges.join(",") === "文字输入", "本机清单带能力位与卡片小标");
  const legacy = store.createApp({ name: "老应用", id: "legacy-cap" });
  const legacySum = store.listApps().apps.find((a) => a.id === "legacy-cap");
  ok(legacy.ok === true && legacySum.capabilityBadges.length === 0, "不传 capabilities 的老流程：卡片上没有任何能力小标");
  ok(
    fs.readFileSync(path.join(legacy.dir, "index.html"), "utf8").indexOf("dict-btn") < 0,
    "老应用的入口页里没有听写 UI",
  );

  /* ════════════════ [10] 界面接线与脚手架契约 ════════════════ */
  console.log("[10] 界面接线：新建浮层 / 开发页菜单 / 卡片小标 / 脚手架");
  const FLOW = read("renderer/app-app-flow.js");
  ok(
    FLOW.indexOf("appsCapabilityChecks") > 0 &&
      FLOW.indexOf("capBox") > 0 &&
      FLOW.indexOf("textInput: false, showDictate: false, imageGen: false") > 0,
    "新建应用浮层有「能力」一节，三项默认都不勾（默认不带语音听写）",
  );
  ok(
    FLOW.indexOf('id: "showDictate"') > 0 && FLOW.indexOf('I18n.t("显示听写条")') > 0,
    "开发页「应用能力…」多一项「显示听写条」（默认关）",
  );
  ok(
    FLOW.indexOf("textInput: false, showDictate: false, imageGen: false }") > 0,
    "创建调用的能力位缺省也是三项全 false（老调用方不传时不再默认带听写）",
  );
  ok(
    FLOW.indexOf("async function appCapabilitiesDialog(") > 0 && FLOW.indexOf("regenEntry") > 0 && FLOW.indexOf("confirmDialog") > 0,
    "开发页「应用能力…」：改能力先弹一次确认（重写入口页是破坏性动作）",
  );
  ok(read("renderer/app-apps-dev.js").indexOf("appCapabilitiesDialog") > 0, "开发页 ⋯ 菜单挂了「应用能力…」入口");
  const APPS_JS = read("renderer/app-apps.js");
  ok(APPS_JS.indexOf("capabilityBadges") > 0 && APPS_JS.indexOf("apps-badge-cap") > 0, "库页卡片画能力小标");
  const CSS = read("renderer/css/apps.css");
  ok(CSS.indexOf(".apps-badge-cap") > 0 && CSS.indexOf(".cap-row") > 0, "样式补齐：能力小标 + 能力复选框行");
  const I18N = read("renderer/i18n.js");
  ok(
    I18N.indexOf('"需要文字输入": "Needs text input"') > 0 && I18N.indexOf('"需要图像生成": "Needs image generation"') > 0,
    "中英词条齐备（能力位那两句）",
  );
  const SCAF = read("templates/app-scaffold/apphost.js");
  ok(SCAF.indexOf("imageModels") > 0 && SCAF.indexOf("cancelImage") > 0 && SCAF.indexOf("async function image(") > 0, "脚手架 apphost.js 封好 imageModels / image / cancelImage");
  const SM = read("templates/app-scaffold/app-model.js");
  ok(SM.indexOf("imageGroup") > 0 && SM.indexOf("textGroup") > 0 && SM.indexOf("setImageModel") > 0, "脚手架模型下拉分区：文本模型 / 图像后端两组");
  ok(SM.indexOf("busy_media") > 0 && SM.indexOf("cuda_oom") > 0, "脚手架错误码字典补了图像那条路（busy_media / cuda_oom…）");
  const README = read("templates/app-scaffold/README.md");
  ok(README.indexOf("textInput") > 0 && README.indexOf("只有声明") > 0, "脚手架 README 写明：只有声明了 textInput 才复制 speech.js / speech.css");
  ok(read("templates/app-default/dict.js").length > 4000, "dict.js 真在仓库里（默认页按需注入的源）");
  ok(exists("apps-capabilities.js"), "能力位纯模块 apps-capabilities.js 在仓库根（build.json 白名单已含它）");
  ok(read("build.json").indexOf("apps-capabilities.js") > 0, "build.json files 白名单含 apps-capabilities.js（否则打包后 Cannot find module）");

  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
  console.log("\n" + (fails ? "FAILED " + fails + " / " : "ALL PASS ") + checks + " 项检查");
  process.exit(fails ? 1 : 0);
})().catch((err) => {
  console.error("smoke 崩了：" + ((err && err.stack) || err));
  process.exit(1);
});
