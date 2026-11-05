"use strict";

/* ═══════════════ 应用能力清单（app.json 的 capabilities）═══════════════
 *
 * 需求背景（两条口径来自用户共识）：
 *   ① 应用默认**不再携带语音转文字**：脚手架、宿主注入的听写条、默认欢迎页三层都改成
 *      「声明了文字输入（textInput）才带」；
 *   ② 能力位是**静态声明**，不是权限闸：它只决定「脚手架 / 入口页带不带语音 UI」与卡片上的
 *      能力标识，**不拦应用自己写的代码** —— 桥上的语音接口（pickAudio / transcribe /
 *      transcribeWav / asrStatus…）与图像接口（imageGen…）始终存在，旧应用不会因为
 *      升级突然报错。
 *
 * 声明形状（app.json）：
 *   "capabilities": { "textInput": true, "imageGen": false, "showDictate": false, "showAuthor": true,
 *                     "voiceGen": false, "canvasHost": true, "agentHost": true }
 *
 * ★ 前四位与后两位不是一回事（2026-10 本轮新增后两位时定下的口径）：
 *   · 前四位是**静态声明**：只决定脚手架 / 注入的 UI / 卡片小标，不拦代码；
 *   · canvasHost / agentHost 是**能力的声明面**：appHost.canvas / fs / tools / net 与
 *     appHost.agent 的每一次调用都要先看它（主进程 app-host-bridge.js 的 ensureDeclared），
 *     没声明直接回 not_declared；声明了还要用户首次授权一次（grants 在
 *     <数据目录>/apps-host.json），关掉这一位 = 撤销授权。
 *
 * 缺省值（缺字段 / 非法值一律按此归一，绝不写脏数据）：
 *   · textInput   缺省 **false** —— 存量应用、云端下载的应用都没声明过，按「不携带语音」处理
 *     （用户共识：已装的不动，也不给它们注入听写条；需要时在开发页补声明）；
 *   · showDictate 缺省 **false** —— 应用窗口 footer 里那条宿主注入的听写条**默认没有**：宿主只在
 *     这一位为真时才注入 renderer/app-speech-ui.js，注入进来即**默认可见**（那是用户显式开的能力；
 *     条尾有「收起」按钮，只藏本次窗口，不写回 app.json）。缺省的存量应用宿主根本不注入。
 *   · showAuthor  缺省 **false** —— 应用窗口**左下角**那枚宿主注入的作者标签（平时隐藏、hover 出
 *     `@作者 - v版本`、点击看只读应用详情）：宿主只在这一位为真时才注入 renderer/app-author-ui.js。
 *     与 showDictate 同一条纪律（新建应用默认开、存量应用不动），见本文件 APP_CAPABILITIES 的注释。
 *   · imageGen    缺省 false（同理）。
 *   · voiceGen    缺省 false（同理）：应用要出声得单独勾这一位（appHost.audio / appHost.tts）。
 *   新建应用不走这几个缺省：`renderer/app-app-flow.js` 的 appsCreateApp 给的是**显式全开**
 *   （新建浮层里那段复选框已删，见那里的注释）；存量应用才按上面的 false 归一（一律不动）。
 *
 * 本模块只做纯计算（无 fs / 无 electron），可被 test/ 直接切片真跑。
 * ───────────────────────────────────────────────────────────────────── */

/** 能力位定义：顺序即界面上的显示顺序，label 给卡片小标与对话框用 */
const APP_CAPABILITIES = [
  {
    id: "textInput",
    label: { zh: "文字输入", en: "Text input" },
    /* 勾上它 = 这个应用需要用户输入文字：脚手架里带上语音听写模块（本机 SenseVoice）。
       注意：**它不再决定听写条看不看得见** —— 应用窗口 footer 那条由 showDictate 决定。 */
    hint: {
      zh: "需要用户输入文字：脚手架会带上语音听写模块（本机语音识别）；要不要在窗口底部显示听写条，看下面那一项",
      en: "The app takes typed input: the scaffold ships the local dictate module. Whether the bar shows in the window footer is the next option",
    },
  },
  {
    id: "showDictate",
    label: { zh: "显示听写条", en: "Show dictate bar" },
    /* 应用窗口 footer 里那条宿主注入的听写条（🎤 听写）：为真 = 注入并默认可见。
       本轮：原来那枚「🎧 音频转文字」按钮与其功能已摘除，这条条只做听写。 */
    hint: {
      zh: "在应用窗口底部显示宿主注入的听写条（🎤 听写）；勾上就默认显示，条尾可「收起」（只藏本次窗口，下次打开仍按本声明显示）",
      en: "Show the host-injected dictate bar (🎤 Dictate) in the app window footer; on = visible by default, with a “Hide” button that lasts for this window only",
    },
  },
  {
    id: "showAuthor",
    label: { zh: "作者标签", en: "Author tag" },
    /* 应用窗口**左下角**那枚宿主注入的作者标签：为真 = 注入（平时隐藏，hover 出
       `@作者 - v版本`，点击弹只读应用详情）。与 showDictate 同一套机制：能力位是静态声明，
       宿主只在声明为真时注入 renderer/app-author-ui.js；新建应用默认三位全开（见
       renderer/app-app-flow.js 的 appsCreateApp），存量应用按 false 归一 = 不动。
       名字与版本缺任一个时标签整枚不出现（不写「未知作者」）。 */
    hint: {
      zh: "在应用窗口左下角显示作者标签（平时隐藏，鼠标移上去显示「@作者 - v版本」，点击看应用详情）；勾上即生效，不想要就取消勾选",
      en: "Show an author tag in the app window's bottom-left corner (hidden until hover, then “@author - vX.Y.Z”; click it for app details). On by default for new apps",
    },
  },
  {
    id: "showMediaPlayer",
    label: { zh: "底部播放条", en: "Media player bar" },
    /* 应用窗口**底部**那条宿主注入的播放条（renderer/app-media-ui.js）：音频画波形、视频带画面，
       播放 / 暂停 / 点波形定位 / 时间 / 音量 / 倍速 / 全屏都由宿主那一份实现，应用只调
       appHost.media.*（play / stop / state / waveform）。与听写条、作者标签同一条纪律：
       能力位缺省 false，宿主只在声明为真时注入；注入进来不占地方（没点播时整条收起）。 */
    hint: {
      zh: "在应用窗口底部显示宿主注入的播放条（音频画波形、视频带画面）：应用里的音频视频都走这一条。勾上就注入，没点播时自动收起",
      en: "Show the host-injected media bar at the bottom of the app window (waveform for audio, picture for video): all audio/video in the app plays through it. Collapsed until something is played",
    },
  },
  {
    id: "imageGen",
    label: { zh: "图像生成", en: "Image generation" },
    hint: {
      zh: "需要生成图片：用 MTNode 已配好的图像能力（云端图像服务商）",
      en: "The app generates images via MTNode's configured image backends",
    },
  },
  {
    id: "voiceGen",
    label: { zh: "语音合成", en: "Voice synthesis" },
    /* 应用侧唯一的声音出口（appHost.audio / tts → app-host-bridge.js 的 audio 命名空间，
       后端是本机 Breeze TTS 2）。原来这一族挂在 canvasHost 那一位下：想出声就得连画布读写
       一起授权 —— 用户报的「在应用里接不上 breeze 语音」就是这条（应用设置里根本没有可勾的语音项）。 */
    hint: {
      zh: "需要生成语音：用本机 Breeze TTS 2（选音色角色 + 文本 → wav 落进画布工作目录），首次调用宿主会让你确认一次",
      en: "The app synthesizes speech with the local Breeze TTS 2 backend (voice preset + text, wav written into the canvas workdir); the host asks you once before first use",
    },
  },
  {
    id: "assetHost",
    label: { zh: "素材库", en: "Asset library" },
    /* 应用 ↔ 素材库（2026-11 用户共识）：这是**能力的声明面**（与 canvasHost 同一条纪律）——
       appHost.assets.* 的每次调用都要先看这一位，没声明直接回 not_declared；声明了还要
       用户首次授权一次。归属硬口径：应用只能改 / 删自己创建的素材与条目，用户自己的只读。
       插件的原生目录 / 备份 / 换根目录不在这条通道里（那些只归用户）。 */
    hint: {
      zh: "读写素材库：列分类与素材、取内容、把本机文件收进库、新建素材与内容条目，以及删除自己创建的东西（进回收站）。你自己创建的素材与条目对它只读；首次使用时宿主会弹窗让你确认一次",
      en: "Read/write the asset library: list categories and assets, read items, import local files, create assets and items, and delete what it created (to the trash). Your own assets and items stay read-only for the app. The host asks you once before first use",
    },
  },
  {
    id: "canvasHost",
    label: { zh: "画布读写", en: "Canvas read/write" },
    /* 与上面四位不同的一条：这不是「声明了就有 UI」，而是**能力的声明面**——
       appHost.canvas / fs / tools / net 的调用要求这一位为真（host bridge 的 ensureDeclared），
       没声明直接回 not_declared。声明 ≠ 放行：首次调用还要用户弹窗授权一次（可在应用设置撤销）。
       作用域：只对这个应用自己绑定的那张画布（默认与应用同 id 的那张）生效。 */
    hint: {
      zh: "读写这个应用对应的那张画布（建/改/删节点、连线、改表单、存盘），以及画布工作目录里的文件、本机后端工具、联网。首次使用时宿主会弹窗让你确认一次，之后可在这里撤销",
      en: "Read/write the canvas this app is bound to (add/edit/remove nodes, wires, forms, save), plus files under that canvas workdir, local backend tools and http fetch. The host asks you once before first use; revoke it here anytime",
    },
  },
  {
    id: "agentHost",
    label: { zh: "Agent 调用", en: "Agent sessions" },
    /* 应用可以在左栏起一条会话、绑到自己的画布上发消息、收流式进度、随时叫停；
       会话在左栏可见，用户可以看、可以打断、可以接着聊（共识：不另起一套隐形 agent）。 */
    hint: {
      zh: "让应用起一条 MTNode 会话（出现在左栏）并对着自己的画布干活：发消息、看实时进度、随时叫停。会话你也能看、能打断、能接着聊",
      en: "Let the app open an MTNode session (visible in the left sidebar) that works on its own canvas: send messages, stream progress, cancel anytime. You can watch, interrupt and continue it too",
    },
  },
];

const APP_CAPABILITY_IDS = APP_CAPABILITIES.map((c) => c.id);

const CAP_FALSE = Object.freeze(
  APP_CAPABILITY_IDS.reduce((o, k) => {
    o[k] = false;
    return o;
  }, {}),
);

/** 能力清单的缺省（全 false）：存量应用与云端包都按它归一 */
function defaultCapabilities() {
  return Object.assign({}, CAP_FALSE);
}

/** 任意输入 → 合法能力清单（只留认识的键，值只认真布尔，其余按 false） */
function normCapabilities(v) {
  const src = v && typeof v === "object" && !Array.isArray(v) ? v : {};
  const out = defaultCapabilities();
  for (const k of APP_CAPABILITY_IDS) out[k] = src[k] === true;
  return out;
}

/** 读清单里的能力位（**读口径**）：归一之外再补一条历史兼容 ——
 *  老应用的 app.json 里没有 voiceGen 这个键（这一位是后加的，以前音频那族挂在 canvasHost 下）：
 *  声明过画布读写就按「语音合成也开」读，否则存量应用一升级就集体失声（真机实测：回 not_declared）。
 *  app.json 里**显式写了** voiceGen（无论 true / false）就按写的来 —— 显式 false 不许被继承盖掉。 */
function effectiveCapabilities(v) {
  const src = v && typeof v === "object" && !Array.isArray(v) ? v : {};
  const out = normCapabilities(src);
  if (!Object.prototype.hasOwnProperty.call(src, "voiceGen") && src.canvasHost === true) out.voiceGen = true;
  return out;
}

/** 两位能力清单是否等价（省一次无意义的写盘 / 重生成入口页） */
function sameCapabilities(a, b) {
  const x = normCapabilities(a);
  const y = normCapabilities(b);
  return APP_CAPABILITY_IDS.every((k) => x[k] === y[k]);
}

/** 单问一位能力 */
function capabilityOn(caps, id) {
  return normCapabilities(caps)[String(id || "")] === true;
}

/** 给界面看的一份：id + 双语标签 + hint + 当前值 */
function capabilitiesForUi(caps, locale) {
  const cur = effectiveCapabilities(caps);
  const zh = String(locale || "zh").toLowerCase().indexOf("en") !== 0;
  return APP_CAPABILITIES.map((c) => ({
    id: c.id,
    label: zh ? c.label.zh : c.label.en,
    hint: zh ? c.hint.zh : c.hint.en,
    on: cur[c.id] === true,
  }));
}

/** 卡片小标：只列**已声明为真**的能力（顺序 = 定义顺序） */
function capabilityBadges(caps, locale) {
  const cur = effectiveCapabilities(caps);
  const zh = String(locale || "zh").toLowerCase().indexOf("en") !== 0;
  return APP_CAPABILITIES.filter((c) => cur[c.id] === true).map((c) => (zh ? c.label.zh : c.label.en));
}

module.exports = {
  APP_CAPABILITIES,
  APP_CAPABILITY_IDS,
  defaultCapabilities,
  normCapabilities,
  effectiveCapabilities,
  sameCapabilities,
  capabilityOn,
  capabilitiesForUi,
  capabilityBadges,
};
