"use strict";

/* ── 应用窗口专属 preload（唯一桥 = window.appHost）────────────────────────────
 *
 * 每个「应用窗口」由主进程 apps-store.js 开：BrowserWindow + 本文件，
 * loadFile 应用根目录里的 <AppName>/index.html（app id 经 additionalArguments 下发）。
 *
 * 白名单纪律（**只暴露下面这几项，多一个都不给**）：
 *   · 只有下面这些方法，逐一对应主进程 apps:* 通道（apps-store.js 按**发送方窗口**认应用，
 *     认不出不是应用窗口就一律拒绝）；
 *   · 不暴露任何 Node 能力：没有 fs / path / ipcRenderer 本身，也没有画布、文件系统、
 *     账号 token 与其它窗口的能力；
 *   · 不注册自定义协议、不给网络面：应用侧没有 fetch 代理 / 外链 / 服务端请求入口；
 *   · 服务商与 API Key 只留主进程（apps-store 自己从本机 config.json 解析），应用侧
 *     只能给 prompt / messages / 温度等白名单字段，不能指定服务商、模型或密钥；
 *   · 应用本体**不依赖这座桥也能跑**：桥缺席时 window.appHost 是 undefined，应用照常启动。
 *
 * 能力（九项）：
 *   textGenStream(opts, cb)       → { ok, text, reasoningChars, finishReason, truncated }
 *                                  文本生成（流式；cb 收 delta/reasoning/done/error）
 *     · opts.messages[].content 支持**多模态**：字符串，或 [{type:'text'},{type:'image_url',image_url:{url}}]
 *       数组；url = 本机绝对路径（主进程读盘并缩放到长边 ≤1080）或 data:image/...;base64,…
 *       上限：一条消息 8 张图、单次请求原始字节合计 10MB；
 *       失败回结构化错误码：bad_image / too_many_images / too_large / no_provider / no_vision /
 *       bad_model / bad_thinking / offline / http_401…（ok:false 时看 code）
 *     · opts.model = MTNode 已配置的模型 id（见 hostModels()）；省略 / "auto" = 跟随宿主默认
 *     · opts.thinking = 思考档：省略 = off（**应用通道默认关思考**），认 off / on(=high) / low / high / max。
 *       别拿 maxTokens 去卡「思考 + 正文」共用的预算：思考会把正文吃光，正文变半截
 *       （finishReason="length"、truncated=true），应用只好报「回复不是可用 JSON」。
 *     · opts.maxTokens 省略 = 不下发上限（推荐）；给了才下发
 *   hostModels()                  → { ok, models, selected, hasAny, hasVision, defaultModel }
 *                                  列出 MTNode 已配置的全部文本模型 + 首项「跟随默认」；服务商与 Key 不回传
 *   hostModel() / hostSetModel(id) 读 / 改本应用的模型选择（按应用 id 持久化，关窗重启还记得）
 *   pickImage()                   → { ok, path, name }      弹系统选图框（用户亲自选的那一次才生效）；
 *                                  取消回 { ok:false, code:"cancelled" }，**不是错误**
 *   imageGen(opts)                → { ok, base64, dataUrl } 图像生成（每次一张）
 *   storageGet / storageSet / storageAll / storageRemove    本机存储（落该应用数据文件夹的 data.json）
 *   dataDirGet / dataDirPick / dataDirOpen / dataRead / dataWrite
 *                                                           数据文件夹与整份数据落盘（原子写）
 *   account()                     → { ok, loggedIn, user }  当前账号摘要（**无 token**）
 *   close() / quit() / onWillClose(cb)                      关自己窗口 / 退出 MTNode / 关窗前的收尾钩子
 *
 *   语音转写那一组（官方本地 SenseVoice，识别跑在 dsh 运行时里）算一项能力「语音转写」：
 *   pickAudio / transcribe（本机音频或应用自录的 base64 WAV）/ asrStatus / asrPrepare /
 *   asrMic / onSpeechState。它只回**文本与状态**：读盘、解码、模型下载都在主进程 / 运行时。
 * ↑ 本机存储那一组算一项（「本机存储读写」），数据文件夹那一组算一项（「数据落盘」）；
 *   关自己窗口的 close() 与退出 MTNode 的 quit() 属于窗口自身，不是宿主能力。
 * ─────────────────────────────────────────────────────────────────────── */

const { contextBridge, ipcRenderer } = require("electron");

/* 关窗收尾钩子（r1 共识：宿主 close 之前先发 apps:willClose，等应用跑完收尾再真关）：
 * 登记的回调按登记顺序串行跑，全部跑完（或超时上限）才回包 __appHost_ackClose。
 * 应用忘了登记也能关：宿主有 WILL_CLOSE_MS 上限，到点直接关。 */
const closeHooks = [];
let closing = false;
function runCloseHooks() {
  if (closing) return Promise.resolve();
  closing = true;
  const list = closeHooks.slice();
  let p = Promise.resolve();
  for (const fn of list) {
    p = p.then(() => {
      try {
        return Promise.resolve(fn());
      } catch (err) {
        console.error("appHost close hook error:", err);
        return null;
      }
    });
  }
  return p.catch(() => null).then(() => {
    try {
      ipcRenderer.invoke("apps:ackClose");
    } catch (_) {}
  });
}
ipcRenderer.on("apps:willClose", () => {
  runCloseHooks();
});

const appHost = {
  /* 文本生成（流式）：opts = { prompt, system?, messages?, model?, temperature?, maxTokens? }；
     messages[].content 支持字符串或多模态数组（见文件头）；cb 依次收 {type:'delta'|'reasoning', text}
     与收尾的 {type:'done', text} / {type:'error', error, code}；done / error 后自动摘掉监听。
     返回 invoke 的 Promise（{ok, text, model} 或 {ok:false, error, code}）。 */
  textGenStream: (opts, cb) => {
    const reqId = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const onEv = (ev, msg) => {
      if (!msg || msg.reqId !== reqId) return;
      if (msg.type === "done" || msg.type === "error") ipcRenderer.removeListener("apps:hostStream", onEv);
      try {
        if (typeof cb === "function") cb(msg);
      } catch (err) {
        console.error("appHost.textGenStream cb error:", err);
      }
    };
    ipcRenderer.on("apps:hostStream", onEv);
    return ipcRenderer.invoke("apps:hostTextStream", Object.assign({}, opts || {}, { reqId: reqId }));
  },

  /* 图像生成：opts = { prompt, size?, quality?, background? }（每次只出一张，回 base64 + dataUrl） */
  imageGen: (opts) => ipcRenderer.invoke("apps:hostImage", opts || {}),

  /* 模型继承：列出 MTNode 已配置的全部文本模型（首项 = 跟随默认，每项带 vision 是否支持识图），
     读当前选择，改当前选择（只认清单里的 id；服务商与 Key 一律不回传）。 */
  hostModels: () => ipcRenderer.invoke("apps:hostModels"),
  hostModel: () => ipcRenderer.invoke("apps:hostModel"),
  hostSetModel: (model) => ipcRenderer.invoke("apps:hostSetModel", { model: model }),

  /* 选一张本机图（系统对话框，用户亲自选的那一次才生效）：只回路径，读盘 / 缩放留在主进程。
     用户取消 → { ok:false, code:"cancelled" }，调用方不要当报错弹提示。 */
  pickImage: () => ipcRenderer.invoke("apps:hostPickImage"),

  /* ── 语音转写（官方本地 SenseVoice，识别跑在 dsh 运行时里；需求：该能力要能被应用直接调用）──
     pickAudio()                  弹系统选音频框 → { ok, path, name }；取消回 { ok:false, code:"cancelled" }
     transcribe({ path|url, language? }) → { ok, text, audioSeconds, inferenceSeconds }
                                  只允许转写「应用在本窗口里亲选过的音频」或「本应用数据文件夹里的音频」；
                                  任意路径一律回 path_denied（不给应用页开文件系统）
     status()                     → { ok, available, phase, ready, downloading, completedBytes, totalBytes, … }
     prepare({ providerId?, downloadSource? }) → 同一份状态（首次使用下载权重约 239MB，进度经 onSpeechState/onSpeechProgress 推）
     mic()                        → { ok, mic:true }：麦克风由**宿主放行**（应用窗口会话的 media 权限），
                                  采集在应用页里用 getUserMedia + AudioContext 做，再用下面的
                                  16 kHz 单声道 PCM16 WAV 口径发 transcribeWav()
     transcribeWav(base64Wav, { language? }) → { ok, text }：应用自己录好的 16k 单声道 PCM16 WAV
                                  （base64，别带 data: 前缀；传输上限 64MB）
     onSpeechState(cb)            准备 / 下载状态变化的订阅，返回退订函数 */
  pickAudio: () => ipcRenderer.invoke("apps:hostPickAudio"),
  transcribe: (opts) => ipcRenderer.invoke("apps:hostAsrTranscribe", opts || {}),
  transcribeWav: (base64Wav, opts) =>
    ipcRenderer.invoke(
      "apps:hostAsrTranscribe",
      Object.assign({}, opts || {}, { base64: String(base64Wav || "") }),
    ),
  asrStatus: () => ipcRenderer.invoke("apps:hostAsrStatus"),
  asrPrepare: (opts) => ipcRenderer.invoke("apps:hostAsrPrepare", opts || {}),
  asrMic: () => ipcRenderer.invoke("apps:hostAsrMic"),
  onSpeechState: (cb) => {
    const onEv = (ev, msg) => {
      if (!msg || msg.type !== "speech-state") return;
      try {
        cb(msg.data || {});
      } catch (err) {
        console.error("appHost.onSpeechState cb error:", err);
      }
    };
    ipcRenderer.on("dsh:event", onEv);
    return () => ipcRenderer.removeListener("dsh:event", onEv);
  },

  /* 本机存储：每应用一份（只在该应用自己的数据文件夹里读写），键为字符串、
     值任意可结构化克隆的 JSON 值（整份上限 2MB） */
  storageGet: (key) => ipcRenderer.invoke("apps:hostStorageGet", { key: key }),
  storageSet: (key, value) => ipcRenderer.invoke("apps:hostStorageSet", { key: key, value: value }),
  storageAll: () => ipcRenderer.invoke("apps:hostStorageAll"),
  storageRemove: (key) => ipcRenderer.invoke("apps:hostStorageRemove", { key: key }),

  /* 数据文件夹：默认 <数据目录>/apps-data/<id>/；dataDirPick() 弹系统选择框，**只有用户
     亲自选过的那一次**才会改（agent / 页面自己传路径一律不认）。dataDirOpen() 在资源管理器中打开。 */
  dataDirGet: () => ipcRenderer.invoke("apps:hostDataDirGet"),
  dataDirPick: () => ipcRenderer.invoke("apps:hostDataDirPick", { q: true }),
  dataDirOpen: () => ipcRenderer.invoke("apps:hostDataDirOpen"),
  /* 回到默认数据文件夹（<数据目录>/apps-data/<id>/）：只删「用户选过」的指针，
     原目录里的数据一个字节都不动 */
  dataDirReset: () => ipcRenderer.invoke("apps:hostDataDirReset"),

  /* 数据落盘：dataRead() 取整份 data.json（{} = 还没存过；老 storage/store.json 会自动迁移过来），
     dataWrite(data) 整份替换写盘（原子 tmp+rename，超 2MB 拒绝）。 */
  dataRead: (opts) => ipcRenderer.invoke("apps:hostDataRead", opts || {}),
  dataWrite: (data, opts) =>
    ipcRenderer.invoke("apps:hostDataWrite", Object.assign({}, opts || {}, { data: data })),

  /* 账号摘要（无 token）：{ ok, loggedIn, user, encryption } */
  account: () => ipcRenderer.invoke("apps:hostAccount"),

  /* 关窗收尾钩子：cb 可以是 async（宿主等它跑完再关，上限 1.5s）。
     返回退订函数；不打这个钩子也能关，宿主到点自己关。 */
  onWillClose: (cb) => {
    if (typeof cb !== "function") return () => {};
    closeHooks.push(cb);
    return () => {
      const i = closeHooks.indexOf(cb);
      if (i >= 0) closeHooks.splice(i, 1);
    };
  },

  /* 关掉本应用窗口（窗口自身动作，不是宿主能力） */
  close: () => ipcRenderer.invoke("apps:closeWindow"),
  /* 退出 MTNode 本身（先让本应用收尾）：给「应用里带一个退出按钮」的场景用 */
  quit: () => ipcRenderer.invoke("apps:quit"),
};

contextBridge.exposeInMainWorld("appHost", appHost);

/* ── 宿主注入的 footer 语音听写条（需求：应用界面的 footer 也要能用内置 ASR）────────
 * 为什么由宿主注入、而不是等应用自己写：应用是**用户自己的页面**（下载来的只有一份
 * index.html，没人会回去改它），所以这条能力必须对任何应用都自动出现。
 *
 * 注入方式：往页面主世界插一张 <script src="…/app-speech-ui.js">（渲染层模块，与本仓
 * 主窗口共用同一份构建产物）。**不能**直接把 appHost 递给它：preload 与页面是两个 JS 世界，
 * contextBridge 暴露的对象过不了 world 边界。所以那条脚本自己去读 window.appHost（页面
 * 世界里本来就有），并在挂载失败时等宿主派发的 "mtnode-apphost" 事件兜底。
 *
 * 纪律：只在「DOM 就绪且页面世界真的拿到了 appHost」之后才注入；拿不到就什么也不做
 * （老版宿主 / 非应用窗口下应用照常跑，前端不该因为这条能力起不来）。 */
function injectDictateBar() {
  try {
    const path = require("path");
    const url = require("url");
    const file = path.join(__dirname, "renderer", "app-speech-ui.js");
    const lang = (() => {
      try {
        const m = /--mtnode-lang=([A-Za-z-]+)/.exec((process.argv || []).join(" "));
        return m ? m[1] : "";
      } catch {
        return "";
      }
    })();
    if (lang) {
      try {
        document.documentElement.setAttribute("lang", lang);
      } catch {}
    }
    const tag = document.createElement("script");
    tag.src = url.pathToFileURL(file).href;
    tag.async = false;
    tag.dataset.mtnode = "dictate";
    (document.head || document.documentElement).appendChild(tag);
  } catch (err) {
    try {
      console.error("dictate bar inject failed:", err);
    } catch {}
  }
}
if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", injectDictateBar, { once: true });
  else injectDictateBar();
}