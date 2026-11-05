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
 *   imageGen(opts)                → { ok, base64, dataUrl } 图像生成（每次一张；文生图，opts.images 也可带参考图）
 *   imageEdit(opts, cb)           → 同一形状：**图生图 / 图像编辑**（opts.images 至少一张，必填）
 *   storageGet / storageSet / storageAll / storageRemove    本机存储（落该应用数据文件夹的 data.json）
 *   dataDirGet / dataDirPick / dataDirOpen / dataRead / dataWrite
 *                                                           数据文件夹与整份数据落盘（原子写）
 *   account()                     → { ok, loggedIn, user }  当前账号摘要（**无 token**）
 *   close() / quit() / onWillClose(cb)                      关自己窗口 / 退出 MTNode / 关窗前的收尾钩子
 *
 *   语音转写那一组（官方本地 SenseVoice，识别跑在 dsh 运行时里）算一项能力「语音转写」：
 *   pickAudio / transcribe（本机音频或应用自录的 base64 WAV）/ asrStatus / asrPrepare /
 *   asrMic / onSpeechState。它只回**文本与状态**：读盘、解码、模型下载都在主进程 / 运行时。
 *
 *   语音合成那一组（Breeze TTS 2，走 app-host-bridge.js 的 audio 命名空间）算一项能力「语音合成」：
 *   audio.synth（== tts）/ audio.presets / audio.status / audio.cancel。
 *   产物**写盘并回 path**（应用拿它 fs.exists 复核），outputPath 必填且只能落在画布工作目录内；
 *   同一后端一次只跑一个（忙时回 busy）。应用没有二进制写口，所以这一条不回 base64。
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

/* 宿主桥统一入口（一条通道 + 逐类白名单；主进程 app-host-bridge.js 再校一遍） */
const hostCall = (ns, method, args) =>
  ipcRenderer.invoke("apps:hostBridge", { ns: String(ns || ""), method: String(method || ""), args: args || {} });

/* ── 底部播放条的命令通道（appHost.media.* ↔ 页面世界里的 renderer/app-media-ui.js）──────
 * 播放条是**页面世界**的宿主注入模块，preload 与它隔着 world 边界，只能走 DOM 事件：
 *   · 这条往下发 "mtnode-media-cmd"，detail 是 JSON 字符串（纯值才过得了 world 边界）；
 *   · 播放条做完回 "mtnode-media-reply"（{ id, result }），这里按 id 认领并 resolve。
 * 没注入播放条（应用没声明 capabilities.showMediaPlayer）= 20 秒内没有回话 → no_player，
 * 调用方照实报「宿主没有播放条」，不悬挂、不假装播过。 */
let mediaCmdSeq = 0;
const mediaPending = new Map();
function mediaReject(id, code, error) {
  const hit = mediaPending.get(id);
  if (!hit) return;
  mediaPending.delete(id);
  hit.resolve({ ok: false, code: code, error: error });
}
try {
  window.addEventListener("mtnode-media-reply", (ev) => {
    let msg = null;
    try {
      msg = JSON.parse(String((ev && ev.detail) || ""));
    } catch (_) {
      msg = null;
    }
    if (!msg || !msg.id) return;
    const hit = mediaPending.get(msg.id);
    if (!hit) return;
    mediaPending.delete(msg.id);
    clearTimeout(hit.timer);
    hit.resolve(msg.result && typeof msg.result === "object" ? msg.result : { ok: false, code: "no_result" });
  });
} catch (_) {}
function mediaCmd(cmd, opts) {
  return new Promise((resolve) => {
    const id = "m" + (++mediaCmdSeq) + "-" + Date.now();
    const timer = setTimeout(() => {
      mediaReject(id, "no_player", "宿主没有注入播放条（app.json 的 capabilities.showMediaPlayer 没打开？）");
    }, 20000);
    mediaPending.set(id, { resolve: resolve, timer: timer });
    try {
      window.dispatchEvent(
        new CustomEvent("mtnode-media-cmd", {
          detail: JSON.stringify(Object.assign({ id: id, cmd: cmd }, opts || {})),
        }),
      );
    } catch (err) {
      clearTimeout(timer);
      mediaReject(id, "no_player", String((err && err.message) || err));
    }
  });
}

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

  /* 图像生成（每次只出一张，回 base64 + dataUrl）：
     opts = { prompt, size?, quality?, background?, model?（见 hostImageModels）, images?（参考图：
       本机绝对路径或 data:image/...;base64,…，一张或多张，主进程读盘 / 缩放）, strength?, reqId? }
       · images 非空 = 图生图 / 图像编辑：**整组**下发（有几张发几张，上限见 hostImageModels()
         的 maxRefImages）。云端 OpenAI 兼容端点走 /images/edits，多图按顺序对应提示词里的
         「图1 / 图2…」。
       · strength = 参考强度，0–1 归一（0 = 参考图只作前缀条件，1 = 最强）。云端没有这个参数，
         传了会在 warnings 里如实说明并忽略（不假装支持）。
       · 要「必须带参考图」的显式语义用 imageEdit()，它参考图为空时直接回 no_ref_image。
     cb（可选）= 进度回调，收 { type:'progress', stage, message, pct, step, totalSteps, elapsedSec }
       与 { type:'error', error, code }；不传就与旧调用完全一致（同步等待，回同一个回执）。
     与 textGenStream 共用 apps:hostStream 事件，按 reqId 分流；取消走 imageGenCancel(reqId)。
     云端出图与音乐 / 视频共用一个全局互斥锁：
     忙时回 { ok:false, code:'busy_media' }（应用提示等待 / 重试即可）；用户在界面上点取消 → 
     { ok:false, code:'cancelled' }，**不是错误**。 */
  imageGen: (opts, cb) => {
    const o = Object.assign({}, opts || {});
    const reqId = String(o.reqId || Date.now().toString(36) + Math.random().toString(36).slice(2));
    o.reqId = reqId;
    if (typeof cb === "function") {
      const onEv = (ev, msg) => {
        if (!msg || msg.reqId !== reqId) return;
        if (msg.type === "error") ipcRenderer.removeListener("apps:hostStream", onEv);
        try {
          cb(msg);
        } catch (err) {
          console.error("appHost.imageGen cb error:", err);
        }
      };
      ipcRenderer.on("apps:hostStream", onEv);
      return ipcRenderer
        .invoke("apps:hostImageStream", o)
        .then((r) => {
          ipcRenderer.removeListener("apps:hostStream", onEv);
          return r;
        });
    }
    /* 不给回调 = 旧调用：走同一个实现，只是不订阅进度事件 */
    return ipcRenderer.invoke("apps:hostImageStream", o);
  },
  /* 图生图 / 图像编辑（显式入口）：opts.images（或 image / refImages / refImage）至少一张，
     否则回 { ok:false, code:'no_ref_image' } —— **不降级成文生图**。其余参数与 imageGen 完全一致
     （含 strength、进度回调 cb、取消 imageGenCancel(reqId)、busy_media / cancelled 等错误码）。 */
  imageEdit: (opts, cb) => {
    const o = Object.assign({}, opts || {});
    const reqId = String(o.reqId || Date.now().toString(36) + Math.random().toString(36).slice(2));
    o.reqId = reqId;
    if (typeof cb === "function") {
      const onEv = (ev, msg) => {
        if (!msg || msg.reqId !== reqId) return;
        if (msg.type === "error") ipcRenderer.removeListener("apps:hostStream", onEv);
        try {
          cb(msg);
        } catch (err) {
          console.error("appHost.imageEdit cb error:", err);
        }
      };
      ipcRenderer.on("apps:hostStream", onEv);
      return ipcRenderer
        .invoke("apps:hostImageEdit", o)
        .then((r) => {
          ipcRenderer.removeListener("apps:hostStream", onEv);
          return r;
        });
    }
    return ipcRenderer.invoke("apps:hostImageEdit", o);
  },
  /* 取消出图（请求不中断，只把登记撤掉；结果由调用方自己忽略） */
  imageGenCancel: (reqId) => ipcRenderer.invoke("apps:hostImageCancel", { reqId: String(reqId || "") }),
  /* 图像后端清单（云端服务商）：与 hostModels 同构，
     每项 { id, label, providerName, local, refImages, maxRefImages, strength }；
     后三项 = 这个后端能不能吃参考图 / 最多几张 / 认不认参考强度（界面据此置灰，别让用户试错）。
     首项不在清单里，模型位用 "auto" = 跟随 MTNode 默认 */
  hostImageModels: () => ipcRenderer.invoke("apps:hostImageModels"),
  hostImageModel: () => ipcRenderer.invoke("apps:hostImageModel"),
  hostImageSetModel: (model) => ipcRenderer.invoke("apps:hostImageSetModel", { model: model }),

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

  /* 本机清单摘要（作者 / 版本 / 说明 / 标签 / 图标 data URL / 数据目录）：宿主注入的
     作者标签读它，应用自己想在别处显示「谁做的、哪一版」也可以调。没声明作者或不适用时
     { ok:false }（调用方据此不显示，绝不编造作者）。 */
  authorTag: () => ipcRenderer.invoke("apps:hostAuthorTag"),

  /* ── 画布 / agent / 文件 / 工具 / 联网（本轮新增的重能力）────────────────────────
   *
   * 与文本 / 图像那几项不是一条路：画布真源与 agent 会话**只活在主窗口渲染层**，所以
   * 这里的每一次调用都经主进程 app-host-bridge.js 中继到主窗口执行，拿的是**同一套**
   * 画布写入口（撤销栈 / 落盘 / 表单归一化全同源）。
   *
   * 三条硬口径（用户共识，改之前先看）：
   *   ① **目标画布 = 这个应用对应的那张**，不是用户此刻打开的那张：
   *      默认是与应用同 id 的画布（新建应用时后台建好的那张）；不存在时宿主弹窗让用户选一次
   *      并记住（canvas.pick() 可主动重选）。目标画布没被打开时由宿主后台加载，不动用户视图。
   *   ② **声明 + 授权**：app.json 的 capabilities.canvasHost / agentHost 要勾上（否则回
   *      not_declared）；首次调用宿主弹一次窗，一次授权全部五类，可在应用设置里关掉能力位撤销。
   *   ③ **主窗口不在线回 not_ready**：不装成功、不悬挂。
   *
   * 通用错误码：not_declared / denied / not_ready / timeout / no_canvas / not_foreground。
   */
  canvas: {
    /* 这张画布的信息 / 清单 / 重选绑定 */
    info: () => hostCall("canvas", "info"),
    list: () => hostCall("canvas", "list"),
    pick: () => hostCall("canvas", "pick"),
    /* 读：整图 / 节点清单 / 单节点 / 表单（含 byLabel 便捷索引） */
    graph: () => hostCall("canvas", "graph"),
    nodes: () => hostCall("canvas", "nodes"),
    node: (id) => hostCall("canvas", "node", { id: id }),
    form: (id) => hostCall("canvas", "form", { id: id }),
    /* 写：全部先入撤销栈（用户 Ctrl+Z 可撤），并按画布自己的口径落盘 */
    updateForm: (id, values) => hostCall("canvas", "updateForm", { id: id, values: values }),
    addNode: (opts) => hostCall("canvas", "addNode", opts || {}),
    updateNode: (id, patch) => hostCall("canvas", "updateNode", { id: id, patch: patch || {} }),
    removeNode: (id) => hostCall("canvas", "removeNode", { id: id }),
    connect: (opts) => hostCall("canvas", "connect", opts || {}),
    disconnect: (id) => hostCall("canvas", "disconnect", { id: id }),
    /* 选中 / 相机视图：只对**用户当前打开的那张**画布有效（后台画布回 not_foreground） */
    select: (ids) => hostCall("canvas", "select", { ids: Array.isArray(ids) ? ids : [ids] }),
    view: () => hostCall("canvas", "view"),
    setView: (v) => hostCall("canvas", "setView", v || {}),
    save: () => hostCall("canvas", "save"),
    /* ── 执行 / 取产物 / 终止（图像生成那条闭环的最后一段）────────────────────
     * 建节点（addNode）+ 连线（connect）+ 改参数（updateForm / updateNode）之后，
     * 应用要能**真把它跑起来**并拿到图，否则画布上的图像节点对应用来说只是块板子：
     *   · runNode(id, { attempts? })：等到跑完再回，回执与 nodeOutput 同一形状
     *     （artifacts / images / paths / meta + elapsedMs）；
     *     attempts 默认 1 张（不继承节点自己的多次尝试），1-10；
     *     上游没跑过的自动补齐（与用户手点 ▶ 完全一致）；
     *     没有工作目录 → code:"no_workspace"（**不弹窗**）；
     *     被 cancelNode 停掉 → code:"cancelled"（不是错误，已落盘的产物还在）。
     *   · nodeOutput(id)：该节点**最近一次运行**的产物；从没跑过也回 ok:true（artifacts 为空）。
     *   · cancelNode(id)：= 画布上的「终止」，这颗节点上在跑的都停（含用户手点的那次）。
     * 三条都任意 kind 可用（宿主不设白名单）；主进程**不给 runNode 挂超时** ——
     * 出图可能几分钟，收口靠应用自己 cancelNode。
     */
    runNode: (id, opts) => hostCall("canvas", "runNode", Object.assign({}, opts || {}, { id: id })),
    nodeOutput: (id) => hostCall("canvas", "nodeOutput", { id: id }),
    cancelNode: (id) => hostCall("canvas", "cancelNode", { id: id }),
    /* ── 组（wf.groups）──────────────────────────────────────────────────────
     * 画布上「绘制」只剩文本，要把一批节点圈在一起用的是**组**（快捷键 G）：
     * 组 = { id, title, nodeIds, markIds }，组里只存 id，成员是全量清单。
     *   · addGroup({ title, nodeIds })           → { ok, id, group }
     *   · updateGroup({ id, title?, nodeIds? })  → { ok, id, group }（成员全量替换）
     *   · removeGroup({ id })                    → { ok, id, removed:true }（只删组，节点全留）
     * 只动指定的那个组；节点不存在就整笔拒绝（bad_arg），不半途写一半。
     */
    /* 素材节点：把素材库里的一份素材**新建并绑定**成画布上的素材节点（应用显式调用才建，
       不自动往画布摆东西）。assetId 或 rel 二选一；x / y 可选。
       回 { ok, id, node, asset }（node = 新节点摘要，asset = 绑定到的素材摘要）。 */
    addAssetNode: (opts) => hostCall("canvas", "addAssetNode", opts || {}),
    addGroup: (opts) => hostCall("canvas", "addGroup", opts || {}),
    updateGroup: (opts) => hostCall("canvas", "updateGroup", opts || {}),
    removeGroup: (id) => hostCall("canvas", "removeGroup", typeof id === "string" ? { id: id } : id || {}),
  },
  agent: {
    /* 这个应用绑定的那条会话：没有就 null（send 会自动建一条） */
    bound: () => hostCall("agent", "bound"),
    sessions: () => hostCall("agent", "sessions"),
    /* 新建一条会话（自动绑到本应用的画布，出现在左侧栏，用户可查看 / 中断 / 接着聊） */
    create: (opts) => hostCall("agent", "create", opts || {}),
    /* 手动绑定左侧栏里已有的某条会话 */
    bind: (sessionId) => hostCall("agent", "bind", { sessionId: sessionId }),
    /* 发一条消息：sessionId 省略 = 用绑定的那条（没有就新建）。返回 { ok, sessionId, queued } */
    send: (text, opts) =>
      hostCall("agent", "send", Object.assign({}, opts || {}, { text: String(text == null ? "" : text) })),
    /* 停这一轮（清排队） */
    cancel: (sessionId) => hostCall("agent", "cancel", { sessionId: sessionId }),
    /* 流式事件：cb 收 { type:'agent', sessionId, frame }，frame 与手机端/会话桥同一套
       （type: text / tool / approval / question / done / error …）。返回退订函数。 */
    onEvent: (cb) => {
      const onEv = (_e, msg) => {
        if (!msg || msg.type !== "agent") return;
        try {
          cb(msg);
        } catch (err) {
          console.error("appHost.agent.onEvent cb error:", err);
        }
      };
      ipcRenderer.on("appHost:stream", onEv);
      return () => ipcRenderer.removeListener("appHost:stream", onEv);
    },
  },
  /* ── 素材库（2026-11 新增 · 用户共识）────────────────────────────────────
   * 应用 ↔ 素材库双向互通：应用能列 / 读整个库、把本机文件收进库、新建自己的素材与条目，
   * 也能改删**自己创建的**素材与条目；用户自己那份对它只读（归属校验在主进程
   * assets-store.js 的 assetActorCall，越权回 code:"forbidden"）。
   *
   * 需要 app.json 的 capabilities.assetHost（否则 not_declared）；首次调用宿主弹一次授权。
   * 插件窗口拿不到这一路（本轮共识：只给应用）。
   *
   * 方法：
   *   root()                        → { ok, path, configured, exists }（没指定根目录时 configured:false）
   *   scan()                        → { ok, root, scan:{tree,categories,assets}, order }
   *   create({catRel?, displayName, desc?})            → { ok, asset }
   *   addItem({id, title?, type?, content?, srcPath?, base64?}) → { ok, item, asset }
   *   importFile({paths[], name?, category?, desc?})   → { ok, asset, added[], skipped[] }
   *   importFiles({id, paths[]})                       → { ok, items[], skipped[], asset }
   *   readItem({id, itemId?|index?, withDataUrl?})     → { ok, item, asset, file, text, dataUrl? }
   *   updateText({id, itemId, content, title?})        → { ok, item, asset, prevVersion, prevEmpty }
   *   updateMeta({id, displayName?, desc?, catRel?})   → { ok, asset }
   *   removeItem({id, itemId})                         → { ok, removed, trash, asset }
   *   deleteAsset({id})                                → { ok, trash, rel }（进回收站，可还原）
   */
  assets: {
    root: () => hostCall("assets", "root"),
    scan: () => hostCall("assets", "scan"),
    /* 建分类目录（幂等、可嵌套）：应用按「项目名 + 五个子分类」建，其中「场景图 / 道具图」
       本轮是空占位目录 —— create 只会建素材夹，没有这一条应用就绑不上素材库目录。
       入参形状跟本命名空间其余条目一致（应用侧 assetsMkdir() 递的是 { catRel } 对象），
       顺手兼容直接传字符串；主进程白名单（app-host-bridge.js）与存储层（assets-store.js）都已支持。 */
    mkdir: (opts) => hostCall("assets", "mkdir", typeof opts === "string" ? { catRel: opts } : opts || {}),
    create: (opts) => hostCall("assets", "create", opts || {}),
    addItem: (opts) => hostCall("assets", "addItem", opts || {}),
    importFile: (opts) => hostCall("assets", "importFile", opts || {}),
    importFiles: (opts) => hostCall("assets", "importFiles", opts || {}),
    readItem: (opts) => hostCall("assets", "readItem", opts || {}),
    updateText: (opts) => hostCall("assets", "updateText", opts || {}),
    updateMeta: (opts) => hostCall("assets", "updateMeta", opts || {}),
    removeItem: (opts) => hostCall("assets", "removeItem", opts || {}),
    deleteAsset: (opts) => hostCall("assets", "deleteAsset", opts || {}),
  },
  /* 文件：根 = 本应用那张画布的**工作目录**，越界一律 outside（主进程再守一道） */
  fs: {
    root: () => hostCall("fs", "root"),
    readText: (rel) => hostCall("fs", "readText", { rel: rel }),
    writeText: (rel, content) => hostCall("fs", "writeText", { rel: rel, content: content }),
    list: (rel) => hostCall("fs", "list", { rel: rel }),
    mkdir: (rel) => hostCall("fs", "mkdir", { rel: rel }),
    remove: (rel) => hostCall("fs", "remove", { rel: rel }),
    exists: (rel) => hostCall("fs", "exists", { rel: rel }),
    /* 读一张图回 dataURL：应用窗口的 <img> 只认 self / data: / blob:，磁盘上的图（含画布节点
       那张）读不了 —— 由宿主读字节转 dataURL。只读、只认图片扩展名、上限 8MB（见 app-host-bridge.js） */
    imageDataUrl: (p) => hostCall("fs", "imageDataUrl", { path: p }),
  },
  /* 本机已登记的重后端工具（音乐 / 视频 / 语音 / 渲染 / 数字人 / 出图） */
  tools: {
    list: () => hostCall("tools", "list"),
    call: (id, args) => hostCall("tools", "call", { id: id, args: args || {} }),
  },
  /* 语音合成（Breeze TTS 2）：应用窗口唯一能出声的出口。
     产物**写进画布工作目录**并回真实绝对路径（应用拿它 fs.exists 复核），绝不回 base64 ——
     应用没有二进制写口，回 base64 等于没给。
       synth({ text, presetId, instruction?, voice?, cfgScale?, seed?, speed?,
               outputPath, responseFormat? }) → { ok, path, bytes }
         · outputPath **必填**（相对工作目录或绝对路径都收，越界回 outside）；
         · 后端忙（含画布节点在合成）回 busy，不排队；
         · 合成失败原样透传 breeze 的错误码（如 preset_missing）。
       presets() → { ok, dir, presets }（与画布跳窗 / 管理台同一份清单）
       status()  → { ok, backend, running, busy }
       cancel()  → 叫停正在合成的任务（**全量**：画布节点在跑的也会停，显存立刻还回来） */
  audio: {
    presets: () => hostCall("audio", "presets"),
    status: () => hostCall("audio", "status"),
    synth: (opts) => hostCall("audio", "synth", opts || {}),
    cancel: () => hostCall("audio", "cancel"),
  },
  /* 同一条通道的另一种写法（老应用按 host.tts 探测时用）：与 audio.synth 逐字段一致 */
  tts: (opts) => hostCall("audio", "synth", opts || {}),
  /* 底部播放条（宿主注入的 renderer/app-media-ui.js）：应用里的音频 / 视频都走这一条。
     播放 / 暂停 / 点波形定位 / 时间 / 音量 / 倍速 / 全屏都在宿主那一份实现里，应用只调这里：
       play({ path, title?, kind? }) → { ok, kind, duration, url } 或 { ok:false, name, message, code }
         · path 传绝对路径（工作目录里的相对路径先自己拼好）；
         · kind 省略按扩展名判（wav/mp3/… = audio，mp4/… = video）；
         · **单实例**：新的播放会替换当前那一条（音频视频互斥），并自动起播；
         · 播不出来照实回 name / message —— 这是「报错」，不假装播过了。
       stop()            → { ok }
       state()           → { ok, path, title, kind, playing, duration, currentTime }
       fullscreen(on)    → { ok }（视频铺满窗口，Esc 退）
       waveform(path)    → { ok, peaks:[0..1], durationSec, bytes, mtimeMs, code? }
                           主进程读字节抽峰值（只回峰值，不回原始字节）；认不出编码回 peaks:[]。
     没声明 capabilities.showMediaPlayer 时宿主不注入播放条 → 每条命令回 no_player。 */
  media: {
    play: (opts) => mediaCmd("play", opts || {}),
    stop: () => mediaCmd("stop", {}),
    state: () => mediaCmd("state", {}),
    fullscreen: (on) => mediaCmd("fullscreen", { on: on !== false }),
    waveform: (p) => ipcRenderer.invoke("apps:hostMediaWave", { path: String(p == null ? "" : p) }),
  },
  /* 联网：经宿主代理取一个 http(s) 地址（应用页自己的 fetch 仍受 CSP / 跨域约束）
     · fetch(url)              取一段文本（老通道，回 { ok, text }）
     · search(url, opts)       素材站搜索：带 headers / timeoutMs，回 { ok, status, text }
     · download(url, rel, opts) 二进制落盘：rel 相对画布工作目录，回 { ok, path, bytes, ext }
     后两条是本轮新增的「从网上取素材」通道 —— 应用页自己是发不了请求的。 */
  net: {
    fetch: (url) => hostCall("net", "fetch", { url: url }),
    search: (url, opts) => hostCall("net", "search", Object.assign({ url: String(url == null ? "" : url) }, opts || {})),
    download: (url, rel, opts) =>
      hostCall(
        "net",
        "download",
        Object.assign({ url: String(url == null ? "" : url), rel: String(rel == null ? "" : rel) }, opts || {})
      ),
  },

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

/* ── 宿主注入的应用窗口 UI（两条，同一套机制）─────────────────────────────────
 * ① footer 语音听写条（需求：应用界面的 footer 也要能用内置 ASR）
 * ② **左下角作者标签**（需求：平时隐藏、hover 出 `@作者 - v版本`、点击看应用详情）
 * 为什么由宿主注入、而不是等应用自己写：应用是**用户自己的页面**（下载来的只有一份
 * index.html，没人会回去改它），所以这些能力必须对任何应用都自动出现。
 *
 * 注入方式：往页面主世界插一张 <script src="…/renderer/<模块>.js">（渲染层模块，与本仓
 * 主窗口共用同一份构建产物）。**不能**直接把 appHost 递给它：preload 与页面是两个 JS 世界，
 * contextBridge 暴露的对象过不了 world 边界。所以那些脚本自己去读 window.appHost（页面
 * 世界里本来就有），并在挂载失败时等宿主派发的 "mtnode-apphost" 事件兜底。
 *
 * 纪律（两条一模一样）：只在「DOM 就绪 + 页面世界真的拿到了 appHost + **这个应用声明了对应
 * 能力位**（app.json 的 capabilities.showDictate / showAuthor）」三条都满足时才注入 ——
 * **没声明一律不注入**（宿主侧也就没有那条 UI）；声明了的应用注入进来即生效（听写条默认可见，
 * 作者标签平时隐藏、hover 才露）。桥上的接口始终在，能力位不是权限闸。
 * 作者标签还多一道闸：清单里**名字与版本缺任一个**也不注入（authorTagOf 回 null）——
 * 标签上要写的字凑不齐就不显示这枚标签，不写「未知作者」。 */
const capAnswer = { at: 0, dict: null, auth: null, player: false }; /* 主进程对「这个应用声明了什么」的答复（只问一次） */
function askCapabilities() {
  if (capAnswer.at) return Promise.resolve(capAnswer);
  const fallback = () => ({ dict: false, auth: null, player: false });
  return Promise.resolve(ipcRenderer.invoke("apps:hostCapabilities"))
    .then((r) => {
      if (!r || !r.ok || !r.capabilities) return fallback();
      capAnswer.at = Date.now();
      capAnswer.dict = r.capabilities.showDictate === true;
      /* 底部播放条（renderer/app-media-ui.js）：声明了 showMediaPlayer 才注入 —— 与听写条同一条闸 */
      capAnswer.player = r.capabilities.showMediaPlayer === true;
      /* author 只在主进程判定「名字 + 版本齐」时才带；老版主进程不带这一项 = 不注入 */
      capAnswer.auth = r.author && typeof r.author === "object" ? r.author : null;
      return capAnswer;
    })
    .catch(() => fallback());
}
function injectAppUiScript(fileName, marker) {
  try {
    const path = require("path");
    const url = require("url");
    const file = path.join(__dirname, "renderer", fileName);
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
    tag.dataset.mtnode = marker;
    (document.head || document.documentElement).appendChild(tag);
  } catch (err) {
    try {
      console.error(marker + " inject failed:", err);
    } catch {}
  }
}
/* 注入时机：DOM 就绪 → 一次性问主进程「这个应用声明了哪些窗口 UI」→ 声明了才注入。
   问不到（老版主进程 / 非应用窗口）按「没声明」处理：宁可不注入，也不给默认应用硬塞 UI。
   作者标签那一份数据顺手挂到 window.__mtnodeAuthorTag（同一世界，注入脚本直接读；
   它自己也会读 window.appHost.__authorTag 兜底）—— 注入脚本与 preload 是两个世界，
   事件 detail 里塞得进对象，但这份数据是**纯值**，挂在 window 上更省一次往返。 */
function maybeInjectAppUi() {
  askCapabilities().then((ans) => {
    if (ans.auth) {
      try {
        window.__mtnodeAuthorTag = ans.auth;
      } catch {}
    }
    if (ans.dict) injectAppUiScript("app-speech-ui.js", "dictate");
    /* 底部播放条（appHost.media.* 的落点）：声明了 showMediaPlayer 才注入，没点播时整条收起 */
    if (ans.player) injectAppUiScript("app-media-ui.js", "media");
    if (ans.auth) injectAppUiScript("app-author-ui.js", "author");
  });
}
if (typeof document !== "undefined") {
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", maybeInjectAppUi, { once: true });
  else maybeInjectAppUi();
}