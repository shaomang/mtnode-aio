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
 *   "capabilities": { "textInput": true, "imageGen": false, "showDictate": false }
 *
 * 缺省值（缺字段 / 非法值一律按此归一，绝不写脏数据）：
 *   · textInput   缺省 **false** —— 存量应用、云端下载的应用都没声明过，按「不携带语音」处理
 *     （用户共识：已装的不动，也不给它们注入听写条；需要时在开发页补声明）；
 *   · showDictate 缺省 **false** —— 应用窗口 footer 里那条宿主注入的听写条**默认隐藏**：宿主
 *     照旧把 renderer/app-speech-ui.js 挂上（仍可被脚本唤起，见 apSpeechMount 的可见性口径），
 *     但挂上时带 data-mtnode-hidden 标记 + display:none；要看得见必须在开发页显式勾这一位。
 *   · imageGen    缺省 false（同理）。
 *   新建应用由「新建应用」浮层显式勾选（浮层里三项都默认不勾），所以新应用不走这几个缺省。
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
    /* 应用窗口 footer 里那条宿主注入的听写条（🎤 听写 / 🎧 音频转文字）默认隐藏 */
    hint: {
      zh: "在应用窗口底部显示宿主注入的听写条（🎤 听写 / 🎧 音频转文字）；不勾就默认隐藏，应用自己的代码仍可唤起它",
      en: "Show the host-injected dictate bar (🎤 Dictate / 🎧 Audio → text) in the app window footer; off = hidden by default, app code can still reveal it",
    },
  },
  {
    id: "imageGen",
    label: { zh: "图像生成", en: "Image generation" },
    hint: {
      zh: "需要生成图片：用 MTNode 已配好的图像能力（云端服务商或本机 SenseNova 后端）",
      en: "The app generates images via MTNode's configured image backends",
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
  const cur = normCapabilities(caps);
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
  const cur = normCapabilities(caps);
  const zh = String(locale || "zh").toLowerCase().indexOf("en") !== 0;
  return APP_CAPABILITIES.filter((c) => cur[c.id] === true).map((c) => (zh ? c.label.zh : c.label.en));
}

module.exports = {
  APP_CAPABILITIES,
  APP_CAPABILITY_IDS,
  defaultCapabilities,
  normCapabilities,
  sameCapabilities,
  capabilityOn,
  capabilitiesForUi,
  capabilityBadges,
};
