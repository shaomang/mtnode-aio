"use strict";
/* ============================================================================
 * 应用窗口 · 语音听写条 + 左下角浮动话筒（renderer/app-speech-ui.js）
 * ----------------------------------------------------------------------------
 * 需求：「应用界面的 footer 也要能用内置 ASR」—— 应用是自己写的页面（下载来的应用
 * 只有一份 index.html，没人会回去改它），所以这条 footer 语音条由**宿主注入**：
 * preload-app.js 在 DOMContentLoaded 后插本脚本，本模块负责画界面与调桥。
 * 没装桥（老版 MTNode / 不是应用窗口）时整体不出现，应用照常跑。
 *
 * 可见性：这条条**只在应用声明了 capabilities.showDictate 时才会被宿主注入**
 *   （闸门在 preload-app.js）—— 既然用户显式声明要它，注入进来就**默认露面**，落到应用自己的
 *   footer（装不下才落宿主自建的固定底栏）。条尾有「收起」按钮 = 本窗口内藏起来（不写回
 *   app.json，下次打开窗口按声明重新出现）；程序化入口两个方向都在：
 *   apSpeechReveal() / apSpeechHide()，现状问 apSpeechHidden()。
 *
 * 本轮（改口径：与画布那枚话筒对齐 = 两种转录模式 + 落字 + AI 增强）：
 *   ① **三态模式**（照画布 renderer/app-voice.js 的 MODE_OFF / MODE_LIVE / MODE_PTT 同源）：
 *      **持续转录**（点一下一直听，按「说完一句的停顿」逐句交出去识别）与**按键转录**
 *      （按住 **F1** 说话、松开**立刻**交这一句，不等静音门 —— 语音指令要低延迟）。
 *      条上话筒 / 左下角浮动话筒点一下 = 三态循环（关闭 → 持续转录 → 按键转录 → 关闭）；
 *      **F2** 是持续转录的总开关（关闭 ↔ 持续转录；在按键转录下按 F2 回关闭）—— 与旧版
 *      「F2 呼出并开始听写」的语义一致，老应用与老文档不受影响。Esc / 「收起」都停止。
 *      判键用 **ev.code === "F1"**（无字符、不污染输入框，与键盘布局无关）；keydown 起录
 *      （ev.repeat 只吞键、不重复起停），keyup 立即把这一句交出去；带 Ctrl/Alt/Meta 的组合键放行。
 *      开始采集前留一点**前卷**（按住前那 300ms），首字不会被切掉。
 *      句长不封顶，只在撞到后端单次请求的硬顶（约 131 秒）时切一刀（那不是句末，是硬顶）。
 *   ② **落字**（照画布的锚点机制）：采集开始时记住当前焦点输入框的插入点（input / textarea /
 *      contenteditable），定稿用**原生插入**（execCommand("insertText")，失败才退化为改 value +
 *      派发 input），行尾补一个空格；交付时焦点已经离开那个框就**挂住**（pendingInsert），
 *      焦点回来再补上 —— 识别出来的字一个字都不丢，也不会硬塞进别的控件。
 *      结果小窗仍然逐行累加（增强文本在上，「原文 / 增强」可切换查看原始识别）；
 *      apSpeechLast() 与 window 的 "mtnode-dictate" 事件语义不变（每句定稿一次、detail.text
 *      同一份全篇）—— 但**默认会把文本插进当前输入框**，自己监听事件又自己写一遍的应用请调
 *      apSpeechInsert(false) 关掉自动落字，免得同一句写两遍。
 *   ③ **AI 增强 Toggle**（话筒右侧那枚 ✨）：打开后每一句识别完先过一次**默认 LLM**
 *      （appHost.textGenStream 不带 model = 跟随该应用的选择 / 宿主默认；thinking:"off"，
 *      不传 maxTokens），system prompt 只让它做同音字 / 标点 / 断句 / 语气词与口语残渣清理，
 *      保持原意与原语言、只回这一句正文；user 消息 = 这一句 + 极短上下文（上一两句定稿 +
 *      当前输入框尾部，合计约 400 字符）。**增强失败 / 超时（8 秒）/ 没配文本模型一律原样交
 *      原始识别**（绝不吞话），状态行说清原因；结果小窗保留原文可查。开关状态按应用持久化
 *      （appHost.storageSet("dictateEnhance")），桥缺席退内存态。默认**关**（不替用户花模型调用）。
 *   ④ **左下角浮动话筒**：常驻在左下角（宿主自建的角落区 #mtnode-dictate-zone）；按键转录态下
 *      鼠标**按住它就是按住说话**（松开即交），给不方便按 F1 的场景留一条路。正在听时它变成
 *      红点脉冲的「录音中」状态。位置纪律：角落区是**一列**（浮动话筒在下、作者标签在上），
 *      听写条若落在宿主自建的固定底栏里会左让一块给这列，互不压盖。
 *
 * 界面（与画布状态栏那枚话筒同族）：
 *   🎤 听写 / ■ 持续转录 / F1 按键转录   点一下按三态循环 → 逐句转写 → 结果小窗累加
 *   ✨ AI 增强                          默认 LLM + 无思考，按简短上下文逐句润色（可关）
 *   结果小窗：贴着听写条上方，全文 + 一键复制 + 「原文 / 增强」切换；同时把定稿写进当时
 *             焦点所在的输入框（可关，见上）。应用也可以取 apSpeechLast()（最近一次识别到的
 *             **全篇**，没识别过是空串）、apSpeechRawLast()（未增强的原始识别），或监听 window
 *             的 "mtnode-dictate" 事件（detail.text 同一份文字，每句定稿各发一次）。
 *
 * 桥（preload-app.js 注入的 window.appHost，本模块只认这几个，别的能力一概不碰）：
 *   asrStatus() / asrPrepare()            现况与首次下载（约 239MB 权重，进度走 onSpeechState）
 *   transcribeWav(base64, { language })   应用自录的 16 kHz 单声道 PCM16 WAV
 *   asrMic() / onSpeechState(cb)
 *   textGenStream(opts)                   AI 增强用的文本生成（不带 model = 跟随宿主默认；
 *                                         thinking:"off"；不传 maxTokens）
 *   storageGet(key) / storageSet(key,v)   增强开关的持久化（该应用自己的 data.json）
 *
 * 词条：本模块跑在**应用窗口**里（宿主注入的 <script>），renderer/i18n.js 并不在这个窗口里，
 * 所以中英文案一律走本文件内的 t(zh, en)，不再往 i18n.js 加词条（加了也没人读得到）。
 *
 * 音频整形（16k 单声道 PCM16 WAV）用页面里的 WebAudio 做：SenseVoice 的音频契约就是这一个口径，
 * 主进程只搬字节、不认格式 —— 整形与切片必须在这里。
 * ==========================================================================*/

(function () {
  /** 采样与帧：与画布那枚话筒同一份口径（16 kHz 单声道 PCM16） */
  var SR = 16000;
  var FRAME_MS = 60; /* 帧步长（静音门计时单位） */
  var FRAME_SAMPLES = Math.round((SR * FRAME_MS) / 1000); /* 一帧 = 960 样本 */
  var ANALYSER_FFT = 2048; /* analyser 滑窗（约 128ms）：每帧只取「距上次读取新增」的那一截 */
  var FRAME_STALL_MS = 900; /* 采集停摆判据（累计这么久没帧就重启采集） */
  /** 句末判据：连续安静累计够这么久 = 这句说完（持续听写的分句点） */
  var SILENCE_MS = 1500;
  var SILENCE_MIN_MS = 300;
  var SILENCE_MAX_MS = 5000;
  /** 起音用的稳定电平窗口（帧）：单帧噪声不算起音 */
  var LEVEL_WIN_FRAMES = 6;
  /** 噪声底窗口（ms）：取窗口里 20% 分位，贴着环境底噪 */
  var NOISE_WIN_MS = 10000;
  /** 提交前保留的句尾静音（多出来的静音白占识别耗时） */
  var TAIL_SILENCE_MS = 300;
  var TAIL_SILENCE_SAMPLES = Math.round((SR * TAIL_SILENCE_MS) / 1000);
  /** 起音前卷：别把首字的起音切掉 */
  var PRE_ROLL_SAMPLES = Math.round(SR * 0.35);
  /** 太短的片段不送识别（咳一声 / 桌面噪声） */
  var MIN_SEG_SAMPLES = Math.round(SR * 0.25);
  /** 后端单次请求硬顶（4 MiB ≈ 131 秒）：绕不过去，撞到就在「最后一段安静处」切一刀 */
  var HARD_CAP_MS = 128000;
  /** 待转写队列上限（片数）：失焦 / 后端慢时别无限堆内存 */
  var QUEUE_MAX = 8;
  /** 现况轮询：语音运行时是冷起的，名单为空时再等一等再判「不可用」 */
  var READY_TRIES = 8;
  var READY_GAP_MS = 1500;
  /** 快捷键：F2 是**持续转录**的总开关（关闭 ↔ 持续转录；按键转录态下按它回关闭）。
   *  无字符、不会被录进输入框。老引擎只给 keyCode：**113 才是 F2**（旧版写 59 = F1，是错的：
   *  老引擎上按 F1 会误触听写，而 F1 现在是按键转录键）。另有 Ctrl+Shift+D 作为**备选**：
   *  应用自己也要用 F2 时，用户在它页面上仍有一条不会打架的入口。 */
  var HOTKEY_KEY = "F2";
  var HOTKEY_CODE = "F2";
  var HOTKEY_KEYCODE = 113;
  /** 按键转录（PTT）：与画布那枚话筒同一枚键、同一判据（按 ev.code 判，与输入法 / 布局无关）。
   *  F1 无字符 —— 不需要字符推导，也不存在「先插进输入框再吞」的竞态。 */
  var PTT_KEY = "F1";
  /** 三态模式（与画布 renderer/app-voice.js 同源口径） */
  var MODE_OFF = "off"; /* 关闭 */
  var MODE_LIVE = "live"; /* 持续转录 */
  var MODE_PTT = "ptt"; /* 按键转录（按住 F1） */
  var MODE_CYCLE = [MODE_OFF, MODE_LIVE, MODE_PTT];
  /** 按键前卷（帧数）：按住键之前那点音频也接上，首字不被切掉（4 帧 ≈ 240ms） */
  var PRE_ROLL_FRAMES = 4;
  /** AI 增强：超时上限与上下文预算（简短上下文就够，长上下文只会让模型开始「续写」） */
  var ENH_TIMEOUT_MS = 8000;
  var ENH_CTX_CHARS = 400;
  var ENH_STORE_KEY = "dictateEnhance";
  /** 增强结果的合理区间（按原句长度）：超出就当模型跑偏了，回落原始识别 */
  var ENH_MAX_RATIO = 4;
  var ENH_MIN_CHARS = 1;

  var root = null; /* 注入的那条听写条的根元素 */
  var zone = null; /* 左下角角落区（浮动话筒 + 作者标签让位都认它） */
  var zoneBtn = null; /* 左下角浮动话筒 */
  var host = null; /* window.appHost */
  var refs = {};
  var panel = null;
  var lastText = "";
  var busy = false; /* 在途转写（按钮置灰用；听写中不置灰） */
  var preparing = false; /* 模型准备 / 下载在跑（与 busy 分开：听不受它影响） */
  var listening = false; /* 是否正在采集（持续转录与按键转录都握着话筒；由 mode 决定交接口径） */
  var mode = MODE_OFF; /* 三态模式（MODE_OFF / MODE_LIVE / MODE_PTT） */
  var pttOn = false; /* 按键转录：F1（或浮动话筒鼠标）正按着 */
  var enhOn = false; /* AI 增强开关（默认关；按应用持久化） */
  var enhApplied = false; /* 本段里是否至少增强成功过一次（决定「原文 / 增强」切换显不显示） */
  var showRaw = false; /* 结果小窗当前看的是原文还是增强文本 */
  var rawText = ""; /* 未增强的原始识别全篇（与 lastText 平行） */
  var anchor = null; /* 落字锚点（采集开始时记下的那个输入框 + 插入点） */
  var pendingInsert = ""; /* 焦点离开时挂住的文字（焦点回来补写，一个字都不丢） */
  var insertOn = true; /* 自动落字（默认开；应用可调 apSpeechInsert(false) 关掉） */

  /* ── 语言：跟宿主界面语言（preload 把 --mtnode-lang 塞进 documentElement.lang）── */
  function zh() {
    try {
      var l = String(document.documentElement.getAttribute("lang") || "").toLowerCase();
      if (l.indexOf("zh") === 0) return true;
      if (l.indexOf("en") === 0) return false;
    } catch (_) {}
    try {
      return /^zh/i.test(String(navigator.language || ""));
    } catch (_) {
      return true;
    }
  }
  function t(zhText, enText) {
    return zh() ? zhText : enText || zhText;
  }

  /* ── 样式：全部走宿主给应用的主题变量（--bg/--fg/--accent…），缺了就取页面上算出来的
        实际颜色 —— 这样下载来、自己写了配色的应用也不会被塞进一块突兀的浅色方块 ── */
  function computed(el, prop, fallback) {
    try {
      var v = getComputedStyle(el).getPropertyValue(prop);
      v = String(v || "").trim();
      return v || fallback;
    } catch (_) {
      return fallback;
    }
  }
  function readVar(name) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name);
      v = String(v || "").trim();
      return v;
    } catch (_) {
      return "";
    }
  }
  function palette() {
    var body = document.body || document.documentElement;
    var bg = readVar("--bg") || readVar("--panel") || computed(body, "background-color", "#14171c");
    var fg = readVar("--fg") || readVar("--text") || computed(body, "color", "#e6e8eb");
    var accent = readVar("--accent") || readVar("--accent-dim") || "#8ab4ff";
    return {
      bg: bg,
      fg: fg,
      muted: readVar("--muted") || computed(body, "color", fg),
      accent: accent,
      line: readVar("--line") || readVar("--border") || "rgba(127,127,127,.35)",
      warn: readVar("--warn") || "#f0b34a",
      err: readVar("--danger") || readVar("--err") || "#ff7b72",
      font: computed(body, "font", "13px system-ui"),
    };
  }
  function styleTag() {
    var id = "mtnode-dictate-css";
    if (document.getElementById(id)) return;
    var p = palette();
    var css = document.createElement("style");
    css.id = id;
    css.textContent =
      ".mtn-dict{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:2px 0;color:" + p.fg + ";font:" + p.font + "}" +
      ".mtn-dict-btn{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:8px;border:1px solid " + p.line + ";background:transparent;color:inherit;font:inherit;cursor:pointer}" +
      ".mtn-dict-btn:hover:not(:disabled){border-color:" + p.accent + ";color:" + p.accent + "}" +
      ".mtn-dict-btn:disabled{opacity:.5;cursor:default}" +
      ".mtn-dict-btn.is-rec{border-color:" + p.err + ";color:" + p.err + "}" +
      /* 按键转录态（琥珀）与持续转录态（红）分开上色：一眼看出现在是哪一种（与画布的 is-live / is-ptt 同族） */
      ".mtn-dict-btn.is-ptt{border-color:" + p.warn + ";color:" + p.warn + "}" +
      /* AI 增强开关：打开时是「已启用」的实心感（与两个录音态区分开，走强调色而不是红/琥珀） */
      ".mtn-dict-btn.mtn-dict-tog.on{border-color:" + p.accent + ";color:" + p.accent + ";box-shadow:inset 0 0 0 999px rgba(127,127,127,.14)}" +
      ".mtn-dict-btn.mtn-dict-tog .mtn-dict-enh-dot{width:7px;height:7px;border-radius:50%;background:currentColor;opacity:.35}" +
      ".mtn-dict-btn.mtn-dict-tog.on .mtn-dict-enh-dot{opacity:1}" +
      ".mtn-dict-note{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.8}" +
      ".mtn-dict-note[data-kind=warn]{color:" + p.warn + "}" +
      ".mtn-dict-note[data-kind=err]{color:" + p.err + "}" +
      /* 「收起」按钮：只是本窗口内把这条藏起来，不是关能力位 —— 靠右放，样式比主按钮轻，
         免得抢它的视线 */
      ".mtn-dict-btn.mtn-dict-hide{margin-left:auto;padding:2px 8px;opacity:.75;font-size:.92em}" +
      ".mtn-dict-btn.mtn-dict-hide:hover:not(:disabled){border-color:" + p.line + ";color:inherit;opacity:1}" +
      /* 左下角角落区（本轮需求：浮动话筒 + 作者标签共用的**一列**）。
         为什么要有这层容器：两个模块各自 position:fixed 钉在左下角，同一个角上必然压盖；
         这里由角落区统一占位，听写条落进宿主底栏时按它的宽度左让一块。 */
      ".mtn-dict-zone{position:fixed;left:10px;bottom:8px;z-index:12545;display:flex;flex-direction:column;" +
      "align-items:flex-start;gap:6px;font:" + p.font + "}" +
      ".mtn-dict-zone-btn{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:6px;width:34px;height:34px;" +
      "padding:0;border-radius:999px;border:1px solid " + p.line + ";background:" + p.bg + ";color:" + p.fg + ";" +
      "font:inherit;font-size:16px;line-height:1;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.35);" +
      "opacity:.82;transition:opacity .14s ease,border-color .14s ease,color .14s ease}" +
      ".mtn-dict-zone-btn:hover:not(:disabled){opacity:1;border-color:" + p.accent + ";color:" + p.accent + "}" +
      ".mtn-dict-zone-btn:disabled{opacity:.45;cursor:default}" +
      ".mtn-dict-zone-btn.is-rec{opacity:1;border-color:" + p.err + ";color:" + p.err + ";animation:mtn-dict-pulse 1.2s ease-in-out infinite}" +
      /* 按键转录态：琥珀 + 更小的字号（"F1" 两个字要塞进 34px 的圆钮） */
      ".mtn-dict-zone-btn.is-ptt{opacity:.95;border-color:" + p.warn + ";color:" + p.warn + ";font-size:11px;font-weight:600}" +
      ".mtn-dict-zone-btn.is-ptt.is-rec{opacity:1;animation:mtn-dict-pulse 1.2s ease-in-out infinite}" +
      /* 录音中的小圆点：按钮保住话筒图标，只多一枚跳动红点（比整颗变方块更好认） */
      ".mtn-dict-zone-btn .mtn-dict-dot{position:absolute;top:3px;right:3px;width:7px;height:7px;border-radius:50%;" +
      "background:" + p.err + ";box-shadow:0 0 0 2px " + p.bg + "}" +
      ".mtn-dict-zone-btn .mtn-dict-dot[hidden]{display:none}" +
      "@keyframes mtn-dict-pulse{0%,100%{box-shadow:0 0 0 0 rgba(255,90,90,.35)}50%{box-shadow:0 0 0 6px rgba(255,90,90,0)}}" +
      ".mtn-dict-panel{position:fixed;left:50%;transform:translateX(-50%);z-index:12550;width:min(680px,92vw);" +
      "max-height:46vh;display:flex;flex-direction:column;border:1px solid " + p.line + ";border-radius:10px;" +
      "background:" + p.bg + ";color:" + p.fg + ";box-shadow:0 12px 40px rgba(0,0,0,.45);font:" + p.font + "}" +
      ".mtn-dict-panel[hidden]{display:none}" +
      ".mtn-dict-ph{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid " + p.line + "}" +
      ".mtn-dict-ph b{font-weight:600}" +
      ".mtn-dict-meta{opacity:.7;font-size:.92em}" +
      ".mtn-dict-x{margin-left:auto;border:0;background:transparent;color:inherit;cursor:pointer;font:inherit;opacity:.75}" +
      ".mtn-dict-body{padding:10px;overflow:auto;white-space:pre-wrap;word-break:break-word;line-height:1.6}" +
      ".mtn-dict-pf{display:flex;gap:8px;justify-content:flex-end;padding:8px 10px;border-top:1px solid " + p.line + "}" +
      /* 隐藏态的 CSS 兜底（内联 style 是主路，标记是给脚本认的）：!important 挡住应用
         自己的 footer 样式把 display 又掰回来。只有「收起」/ apSpeechHide() 之后才会命中。
         ⚠ 浮动话筒（#mtnode-dictate-zone）**不**在隐藏范围内：收起的是那条条，不是这枚呼出入口。 */
      "#mtnode-dictate[data-mtnode-hidden='1']{display:none !important}";
    (document.head || document.documentElement).appendChild(css);
  }

  /* ── 音频整形：Float32 帧 → 16k 单声道 PCM16 WAV（与画布侧同一算法）── */
  function encodeWav16kMono(samples) {
    var n = samples && samples.length ? samples.length : 0;
    var buf = new ArrayBuffer(44 + n * 2);
    var v = new DataView(buf);
    var str = function (off, s) {
      for (var i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
    };
    str(0, "RIFF");
    v.setUint32(4, 36 + n * 2, true);
    str(8, "WAVE");
    str(12, "fmt ");
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, 16000, true);
    v.setUint32(28, 16000 * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    str(36, "data");
    v.setUint32(40, n * 2, true);
    for (var i = 0, off = 44; i < n; i++, off += 2) {
      var x = samples[i];
      var c = x > 1 ? 1 : x < -1 ? -1 : x;
      v.setInt16(off, c < 0 ? Math.round(c * 32768) : Math.round(c * 32767), true);
    }
    return new Uint8Array(buf);
  }
  function bytesToBase64(bytes) {
    var s = "";
    var CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(bytes.length, i + CH)));
    }
    return btoa(s);
  }
  /** 一帧 Float32（16k 口径的样本窗口）里的 RMS（电平判据用它） */
  function rmsOf(f32) {
    var n = f32.length || 0;
    if (!n) return 0;
    var sum = 0;
    for (var i = 0; i < n; i++) sum += f32[i] * f32[i];
    return Math.sqrt(sum / n);
  }
  /** 句子片 → 16k 单声道 PCM16 WAV 的 base64 */
  function segB64(samples) {
    return bytesToBase64(encodeWav16kMono(samples));
  }
  /** 上一片尾部留一点重叠：下一片的第一个字不要因为切在起音上被吃掉 */
  function tailOverlap(samples) {
    var n = samples && samples.length ? samples.length : 0;
    if (!n) return new Float32Array(0);
    var keep = Math.min(n, TAIL_SILENCE_SAMPLES);
    return samples.subarray(n - keep);
  }
  /** 线性内插重采样到 16 kHz（识别对重采样质量不敏感，够用且零依赖）——
   *  与画布那枚话筒（renderer/app-voice.js 的 resampleTo16k）同一份算法。
   *
   *  为什么必须有这一步（本轮真机自验挖出来的真 bug）：SenseVoice 的音频契约是 **16 kHz 单声道
   *  PCM16**，而 AudioContext 默认按设备原生采样率跑（本机 48 kHz）。旧稿把 48 kHz 的帧**原样**
   *  按 16 kHz 写进 WAV 头 → 交付出去的音频慢了 3 倍（音高整体塌下来，识别出不来字：真机实测
   *  「明明说了两句中文，结果小窗说没有识别到文字」）；同时帧内样本数是 48 kHz 口径，而
   *  segSamples / 静音门 / 硬顶一律按 SR = 16000 换算 —— 等价于「静音 0.5 秒就断句」「42 秒就切
   *  一刀」，分句与句长也全是错的。修法照画布：优先直接要 16 kHz 的上下文，要不到就**逐帧重采样**。 */
  function resampleTo16k(src, rate) {
    var r = Number(rate) || SR;
    if (r === SR) return src;
    var ratio = r / SR;
    var n = Math.max(1, Math.floor(src.length / ratio));
    var out = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var pos = i * ratio;
      var i0 = Math.floor(pos);
      var i1 = Math.min(src.length - 1, i0 + 1);
      var frac = pos - i0;
      out[i] = src[i0] * (1 - frac) + src[i1] * frac;
    }
    return out;
  }
  /** 音频上下文：优先直接要 16 kHz（省一次重采样）；老引擎不支持该采样率就退回设备原生率
   *  （逐帧 resampleTo16k 会把任意采样率搬到 16 kHz，所以退回也不会错格式）。 */
  function createAudioCtx(AC) {
    try {
      return new AC({ sampleRate: SR });
    } catch (_) {
      return new AC();
    }
  }

  /* ── 结果小窗（展示 + 复制 + 「原文 / 增强」切换；同时按上面的锚点把定稿写进输入框）── */
  function panelEl() {
    if (panel) return panel;
    panel = document.createElement("div");
    panel.className = "mtn-dict-panel";
    panel.hidden = true;
    panel.innerHTML =
      '<div class="mtn-dict-ph"><b>' +
      esc(t("识别结果", "Transcript")) +
      '</b><span class="mtn-dict-meta"></span>' +
      '<button type="button" class="mtn-dict-x" data-act="raw" hidden>' +
      esc(t("原文", "Raw")) +
      "</button>" +
      '<button type="button" class="mtn-dict-x" data-act="close" title="' +
      esc(t("关闭", "Close")) +
      '">✕</button></div><div class="mtn-dict-body"></div>' +
      '<div class="mtn-dict-pf"><button type="button" class="mtn-dict-btn" data-act="copy">' +
      esc(t("复制", "Copy")) +
      "</button></div>";
    document.body.appendChild(panel);
    panel.querySelector('[data-act="close"]').addEventListener("click", function () {
      panel.hidden = true;
    });
    /* 「原文 / 增强」：只改看哪一份，两份都留着（增强文本是交付口径，原文随时可查） */
    panel.querySelector('[data-act="raw"]').addEventListener("click", function () {
      showRaw = !showRaw;
      renderPanel();
    });
    panel.querySelector('[data-act="copy"]').addEventListener("click", function () {
      copy(showRaw ? rawText : lastText);
    });
    return panel;
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  /** 结果小窗按当前视图（原文 / 增强）重画一次；切换按钮只在真的增强过才露面 */
  function renderPanel() {
    var d = panelEl();
    d.querySelector(".mtn-dict-body").textContent = showRaw ? rawText : lastText;
    var tog = d.querySelector('[data-act="raw"]');
    if (tog) {
      tog.hidden = !(enhApplied && rawText && rawText !== lastText);
      tog.textContent = showRaw ? t("看增强", "Enhanced") : t("看原文", "Raw");
      tog.title = showRaw
        ? t("切回 AI 增强后的文本", "Show the AI-enhanced text")
        : t("看这一段的原始识别（未经 AI 增强）", "Show the raw recognition text (before AI enhance)");
    }
    return d;
  }
  function copy(text) {
    var s = String(text || "");
    if (!s) return;
    var done = function () {
      say(t("已复制到剪贴板", "Copied"), "ok");
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(s).then(done, function () {
          fallbackCopy(s, done);
        });
        return;
      }
    } catch (_) {}
    fallbackCopy(s, done);
  }
  function fallbackCopy(s, done) {
    try {
      var ta = document.createElement("textarea");
      ta.value = s;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      done();
    } catch (_) {}
  }
  /** 把一行定稿追加进结果窗（逐句累加，不是每句重写整篇）。
   *  line = 交付的那一份（增强成功就是增强文本），raw = 原始识别（不传 = 与 line 相同）。 */
  function appendLine(line, meta, raw) {
    var s = String(line || "").trim();
    if (!s) return;
    var r = String(raw == null ? s : raw).trim() || s;
    lastText = lastText ? lastText + "\n" + s : s;
    rawText = rawText ? rawText + "\n" + r : r;
    var d = renderPanel();
    if (meta) d.querySelector(".mtn-dict-meta").textContent = meta;
    placePanel();
    d.hidden = false;
    emit();
  }
  /** 起一段新的听写：清掉上一篇（一段会话一份文本；清空由调用方在开始时做） */
  function resetLines() {
    lastText = "";
    rawText = "";
    enhApplied = false;
    showRaw = false;
    pendingInsert = "";
    if (panel) {
      var d = renderPanel();
      if (d) d.querySelector(".mtn-dict-meta").textContent = "";
    }
  }
  /** 贴着听写条上方（条在底栏里 / 在 footer 里都按实际位置算） */
  function placePanel() {
    if (!panel) return;
    try {
      var box = (root || document.body).getBoundingClientRect();
      panel.style.bottom = Math.max(12, window.innerHeight - box.top + 8) + "px";
    } catch (_) {}
  }
  /** 通知应用（应用想自动取用就监听这个事件）—— 派发失败绝不能影响结果 */
  function emit() {
    try {
      if (typeof window.dispatchEvent === "function" && typeof CustomEvent === "function") {
        window.dispatchEvent(new CustomEvent("mtnode-dictate", { detail: { text: lastText } }));
      }
    } catch (_) {}
  }
  /** 应用主动取最近一次识别结果（与 "mtnode-dictate" 事件同一口径：还没识别过就是空串）。
   *  这个口子写在文件头的桥清单里，必须真有 —— 上一版只写了 window.apSpeechLast = apSpeechLast
   *  而 apSpeechLast 从未定义，那行直接抛 ReferenceError 被 catch 吞掉：应用拿到 undefined，
   *  连带同一块 try 里的其它导出一起没挂上。 */
  function apSpeechLast() {
    return lastText;
  }
  /** 未增强的原始识别全篇（AI 增强开着时，这里才是 ASR 的原话） */
  function apSpeechRawLast() {
    return rawText;
  }
  function say(msg, kind) {
    if (!refs.note) {
      if (zoneBtn && msg) zoneBtn.setAttribute("title", String(msg));
      return;
    }
    refs.note.textContent = msg || "";
    refs.note.dataset.kind = kind || "";
  }
  function setBusy(on, label) {
    /* 在途转写：话筒置灰（听写中不置灰 —— 那时要能点它停） */
    busy = !!on;
    paintMic();
    if (label) say(label, "");
  }
  /** 模型准备（首次约 239MB）与「在途转写」分开：下载 / 加载要几秒到几分钟，那段时间里
   *  「听」这件事照旧进行（采到的句子排进队列），按钮不能被禁用 —— 否则用户既停不掉、
   *  也看不出发生了什么。 */
  function setPreparing(on, label) {
    preparing = !!on;
    if (label) say(label, "");
  }
  /** 按钮与浮动话筒的状态（三态 + 录音中 + 在途转写）：一处画三处（条上话筒 / 浮动话筒 / 增强开关） */
  function paintMic() {
    var live = mode === MODE_LIVE;
    var ptt = mode === MODE_PTT;
    /* 正在采集的视觉锚点：持续转录握着话筒就算在录；按键转录只在**按着**时才算在录 */
    var rec = live || (ptt && pttOn);
    var label = live ? t("持续转录", "Live") : ptt ? t("按键转录 F1", "Push-to-talk F1") : t("听写", "Dictate");
    if (refs.mic) {
      refs.mic.classList.toggle("is-rec", rec);
      refs.mic.classList.toggle("is-ptt", ptt && !rec);
      var span = refs.mic.querySelector("span");
      if (span) span.textContent = label;
      refs.mic.disabled = busy && !listening;
      refs.mic.setAttribute("aria-pressed", mode === MODE_OFF ? "false" : "true");
      refs.mic.title = modeHint(mode) + t("；点它按 关闭 → 持续转录 → 按键转录 循环", "; clicks cycle off → live → push-to-talk");
    }
    if (zoneBtn) {
      zoneBtn.classList.toggle("is-rec", rec);
      zoneBtn.classList.toggle("is-ptt", ptt);
      /* 图标按态换（🎤 关闭 / ■ 持续转录 / F1 按键转录）。注意顺序：textContent 会清掉子节点，
         所以先换字、再由 recordingDot 把红点挂回来（先挂点后换字的话点会被清掉）。 */
      var glyph = ptt ? "F1" : live ? "■" : "🎤";
      if (zoneBtn.getAttribute("data-mtnode-glyph") !== glyph) {
        zoneBtn.textContent = glyph;
        zoneBtn.setAttribute("data-mtnode-glyph", glyph);
      }
      recordingDot(zoneBtn, rec);
      zoneBtn.disabled = busy && !listening;
      zoneBtn.title =
        (ptt
          ? t("按键转录：按住 F1 说话（也可以按住这枚话筒说话），松开就识别", "Push-to-talk — hold F1 (or hold this mic) and release to recognize")
          : live
            ? t("持续转录中：点一下切到按键转录（再点一下关闭）", "Live transcription — click for push-to-talk (click again to stop)")
            : t("语音听写：点一下开启持续转录（快捷键 F2），再点切按键转录", "Voice dictation — click for live mode (F2), click again for push-to-talk")) +
        t("；条被收起时它仍在，随点随呼出", "; it stays here even when the bar is hidden");
      zoneBtn.setAttribute("aria-label", zoneBtn.title);
    }
    paintEnh();
  }
  /** AI 增强开关的外观（开关状态在 enhOn，一个开关只有两态） */
  function paintEnh() {
    if (!refs.enh) return;
    refs.enh.classList.toggle("on", !!enhOn);
    refs.enh.setAttribute("aria-pressed", enhOn ? "true" : "false");
    refs.enh.title =
      (enhOn
        ? t("AI 增强已开启：每句识别完用默认文本模型（无思考）按简短上下文润色一次", "AI enhance is on — each sentence is polished once by the default text model (thinking off)")
        : t("AI 增强已关闭：点一下打开（用默认文本模型 + 无思考，按简短上下文润色识别结果）", "AI enhance is off — click to polish each sentence with the default text model (thinking off)")) +
      t("；增强失败 / 超时 / 没配文本模型时一律原样交原始识别", "; on failure, timeout or no text model it falls back to the raw text");
  }
  /** 开关 AI 增强（持久化到该应用自己的 data.json；桥缺席就只在本窗口有效） */
  function setEnhance(on) {
    enhOn = !!on;
    paintEnh();
    say(
      enhOn
        ? t("AI 增强已开启：每句识别完用默认文本模型（无思考）润色一次", "AI enhance on — each sentence is polished once by the default text model (thinking off)")
        : t("AI 增强已关闭：交 ASR 原始识别", "AI enhance off — raw recognition is delivered"),
      "",
    );
    if (cap().store) {
      try {
        host.storageSet(ENH_STORE_KEY, enhOn);
      } catch (_) {}
    }
    return enhOn;
  }
  /** 挂载时读回上次的选择（读不到 / 桥缺席 = 默认关：不替用户花模型调用） */
  function loadEnhance() {
    if (!refs.enh) return false;
    if (!cap().store) {
      paintEnh();
      return false;
    }
    try {
      host.storageGet(ENH_STORE_KEY).then(
        function (r) {
          if (r && r.ok && r.value === true) setEnhance(true);
          else paintEnh();
        },
        function () {
          paintEnh();
        },
      );
    } catch (_) {
      paintEnh();
    }
    return true;
  }

  /** 按钮上的小圆点（录音中的视觉锚点）：保留图标、只加一个点，避免整颗按钮变成色块 */
  function recordingDot(btn, on) {
    try {
      var dot = btn.querySelector(".mtn-dict-dot");
      if (on && !dot) {
        dot = document.createElement("i");
        dot.className = "mtn-dict-dot";
        btn.appendChild(dot);
      }
      if (dot) dot.hidden = !on;
      return true;
    } catch (_) {
      return false;
    }
  }

  /* ── 现况 / 就绪 ───────────────────────────────────────────────────────── */
  function cap() {
    var h = host || {};
    return {
      status: typeof h.asrStatus === "function",
      prepare: typeof h.asrPrepare === "function",
      wav: typeof h.transcribeWav === "function",
      mic: typeof h.asrMic === "function",
      events: typeof h.onSpeechState === "function",
      gen: typeof h.textGenStream === "function", /* AI 增强用的文本生成 */
      store: typeof h.storageGet === "function" && typeof h.storageSet === "function",
    };
  }
  function pause(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }
  /** 现况：名单为空时**再等一会儿**（语音运行时冷起约 1~2 秒）。
   *  onTick 每拿到一份现况就调一次 —— 界面据此先显示「引擎正在启动」，而不是空着等。 */
  function statusSettled(onTick) {
    var tick = typeof onTick === "function" ? onTick : function () {};
    if (!cap().status) return Promise.resolve({ ok: false, code: "no_host" });
    var tries = 0;
    var once = function () {
      return host.asrStatus().then(
        function (st) {
          var s = st || { ok: false };
          try {
            tick(s);
          } catch (_) {}
          if (s.ok !== false && s.available !== true && tries < READY_TRIES) {
            tries += 1;
            return pause(READY_GAP_MS).then(once);
          }
          return s;
        },
        function (err) {
          var e = { ok: false, error: String((err && err.message) || err), code: "speech_failed" };
          try {
            tick(e);
          } catch (_) {}
          if (tries < READY_TRIES) {
            tries += 1;
            return pause(READY_GAP_MS).then(once);
          }
          return e;
        },
      );
    };
    return once();
  }
  function phaseText(st) {
    var s = st || {};
    if (s.ok === false) return String(s.error || t("语音服务不可用", "Speech service unavailable"));
    if (s.ready) return t("语音识别就绪", "Speech ready");
    if (s.downloading) {
      var pct = s.totalBytes ? Math.round((s.completedBytes / s.totalBytes) * 100) : 0;
      return t("正在下载语音模型", "Downloading speech model") + (pct ? " " + pct + "%" : "…");
    }
    if (String(s.phase || "") === "failed") return t("语音模型准备失败：点话筒重试下载", "Model preparation failed — click the mic to retry");
    if (s.available === false) return t("语音引擎还在启动，稍后再试", "Speech engine is still starting — try again shortly");
    return t("语音模型尚未下载（首次识别会自动下载）", "Model not downloaded yet (auto on first use)");
  }
  /** 首次使用把权重（约 239MB）下起来；已经在跑就复用同一只任务。
   *  与旧稿的关键差别：这里**不动 busy**（`preparing` 单记一份）—— 持续听写期间模型准备
   *  照跑（采到的句子排队等），话筒按钮必须仍可点（用户要能停），所以它不置灰。 */
  function ensureReady() {
    if (!cap().prepare || preparing) return Promise.resolve(null);
    return host.asrStatus().then(
      function (st) {
        if (st && (st.ready || st.downloading || st.available === false)) return st;
        setPreparing(true, t("正在准备语音模型（首次使用约 239MB）…", "Preparing the speech model (≈239MB first run)…"));
        return host.asrPrepare().then(
          function (r) {
            setPreparing(false, "");
            return r;
          },
          function (err) {
            setPreparing(false, "");
            fail(err);
            return null;
          },
        );
      },
      function () {
        setPreparing(false);
        return null;
      },
    );
  }

  /* ── 落字：定稿写进当时焦点的输入框（锚点机制，与画布 renderer/app-voice.js 同源）────────
   * 为什么用锚点而不是「交付时的当前焦点」：识别是异步的（本地 ASR 几百毫秒到几秒，开了
   * AI 增强还要多等一轮模型），交付那一刻用户的焦点常常已经挪到别处了。所以**采集开始时**
   * 就记下那个输入框与插入点（captureAnchor），交付时原位插入；焦点不在那个框里就挂住
   * （pendingInsert），焦点回来（focusin）再补写 —— 一个字都不丢，也不会硬塞进别的控件。 */
  function inputKind(el) {
    if (!el || el.nodeType !== 1) return "";
    var tag = String(el.tagName || "").toLowerCase();
    if (tag === "textarea") return "textarea";
    if (tag === "input") {
      var ty = String(el.type || "text").toLowerCase();
      var okTypes = ["text", "search", "url", "tel", "email", "password", "number", ""];
      return okTypes.indexOf(ty) >= 0 ? "input" : "";
    }
    if (el.isContentEditable) return "ce";
    return "";
  }
  function isWritable(el) {
    return !!inputKind(el);
  }
  function inputTextOf(el) {
    if (!el) return "";
    if (inputKind(el) === "ce") return String(el.textContent || "");
    return String(el.value == null ? "" : el.value);
  }
  /** contenteditable 里的纯文本偏移（与 inputTextOf 同一套计数） */
  function ceOffsetOf(el) {
    try {
      var sel = window.getSelection ? window.getSelection() : null;
      if (!sel || !sel.rangeCount) return null;
      var r = sel.getRangeAt(0);
      if (!el.contains(r.startContainer)) return null;
      var pre = r.cloneRange();
      pre.selectNodeContents(el);
      try {
        pre.setEnd(r.startContainer, r.startOffset);
      } catch (_) {
        return null;
      }
      return String(pre.toString() || "").length;
    } catch (_) {
      return null;
    }
  }
  function ceSetOffset(el, off) {
    try {
      var doc = el.ownerDocument || document;
      var walker = doc.createTreeWalker(el, 4 /* SHOW_TEXT */, null);
      var acc = 0;
      var node = walker.nextNode();
      var target = Math.max(0, Number(off) || 0);
      while (node) {
        var len = String(node.nodeValue || "").length;
        if (acc + len >= target) {
          var r = doc.createRange();
          r.setStart(node, Math.max(0, Math.min(len, target - acc)));
          r.collapse(true);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(r);
          return true;
        }
        acc += len;
        node = walker.nextNode();
      }
      var r2 = doc.createRange();
      r2.selectNodeContents(el);
      r2.collapse(false);
      var sel2 = window.getSelection();
      sel2.removeAllRanges();
      sel2.addRange(r2);
      return true;
    } catch (_) {
      return false;
    }
  }
  /** 记下这个框与插入点（没焦点 / 不是可输入控件 → null） */
  function captureAnchor(el) {
    if (!isWritable(el)) return null;
    var kind = inputKind(el);
    var start = null;
    var end = null;
    if (kind === "ce") {
      var off = ceOffsetOf(el);
      start = off == null ? inputTextOf(el).length : off;
      end = start;
    } else {
      var v = String(el.value || "");
      var focused = document.activeElement === el;
      var s = focused && isFinite(el.selectionStart) ? Number(el.selectionStart) : v.length;
      var e = focused && isFinite(el.selectionEnd) ? Number(el.selectionEnd) : v.length;
      start = Math.min(s, e);
      end = Math.max(s, e);
    }
    return { el: el, start: start, end: end, at: Date.now() };
  }
  /** 锚点还在文档里吗（只管「这个框还在不在」，不管焦点） */
  function anchorAttached() {
    var a = anchor;
    if (!a || !a.el) return false;
    try {
      return !!(a.el.isConnected !== undefined ? a.el.isConnected : a.el.ownerDocument && a.el.ownerDocument.contains(a.el));
    } catch (_) {
      return false;
    }
  }
  /** 现在能不能写：锚点还在、还挂在文档里、且**焦点仍在这个框里**（否则挂住，等它回来） */
  function anchorReady() {
    if (!anchorAttached()) return false;
    try {
      return document.activeElement === anchor.el;
    } catch (_) {
      return false;
    }
  }
  /** 插完把锚点往后挪，下一次接着写（不重排用户已经在框里的正文） */
  function advanceAnchor(a, len) {
    if (!a) return;
    a.start = Number(a.start || 0) + len;
    a.end = a.start;
    a.at = Date.now();
  }
  /** 原生插入（走浏览器撤销栈语义）；execCommand 不生效才退化为改 value + 派发 input */
  function insertText(text) {
    var txt = String(text == null ? "" : text);
    if (!txt) return false;
    var a = anchor;
    if (!a || !a.el) return false;
    if (!anchorAttached()) {
      anchor = null;
      return false;
    }
    var kind = inputKind(a.el);
    if (!kind) return false;
    var ok = false;
    try {
      if (document.activeElement !== a.el && a.el.focus) a.el.focus();
      if (kind === "ce") {
        ceSetOffset(a.el, a.start);
      } else {
        var v = String(a.el.value || "");
        var s = Math.max(0, Math.min(v.length, Number(a.start) || 0));
        var e = Math.max(s, Math.min(v.length, Number(a.end) || s));
        a.el.setSelectionRange(s, e);
      }
      ok = !!(document.execCommand && document.execCommand("insertText", false, txt));
    } catch (_) {
      ok = false;
    }
    if (!ok && kind !== "ce") {
      try {
        var v2 = String(a.el.value || "");
        var s2 = Math.max(0, Math.min(v2.length, Number(a.start) || 0));
        var e2 = Math.max(s2, Math.min(v2.length, Number(a.end) || s2));
        a.el.value = v2.slice(0, s2) + txt + v2.slice(e2);
        try {
          a.el.setSelectionRange(s2 + txt.length, s2 + txt.length);
        } catch (_) {}
        a.el.dispatchEvent(new Event("input", { bubbles: true }));
        ok = true;
      } catch (_) {
        ok = false;
      }
    }
    if (ok) advanceAnchor(a, txt.length);
    return ok;
  }
  /** 交付一句：能写就原位写进去，写不了就挂住（回来再补），一个字都不丢 */
  function insertAtAnchor(text) {
    var s = String(text || "").trim();
    if (!s || !insertOn) return false;
    if (!anchor || !anchor.el) return false; /* 一开始就没焦点输入框：只进结果小窗 + 事件 */
    if (!anchorAttached()) {
      anchor = null;
      return false;
    }
    if (!anchorReady()) {
      pendingInsert = pendingInsert ? pendingInsert + " " + s : s;
      say(t("焦点不在输入框里：这句先留住，回到那个框自动补写", "Focus left the input box — the sentence is held and written back when focus returns"), "warn");
      return false;
    }
    var ok = insertText(s + " ");
    if (!ok) {
      pendingInsert = pendingInsert ? pendingInsert + " " + s : s;
      say(t("没能写进输入框：这句先留住，焦点回来补写", "Could not write into the input box — held for a retry"), "warn");
    }
    return ok;
  }
  /** 焦点回到那个框时把挂住的字补上（focusin 调） */
  function flushPendingInsert() {
    if (!pendingInsert) return false;
    if (!anchorAttached()) anchor = null;
    if (!anchorReady()) return false;
    var txt = pendingInsert;
    pendingInsert = "";
    if (!insertText(txt + " ")) pendingInsert = pendingInsert ? pendingInsert + " " + txt : txt;
    return true;
  }

  /* ── AI 增强（默认文本模型 + system prompt + 无思考）─────────────────────────
   * 用户在话筒右侧打开那枚开关后：每一句 ASR 结果先过一次文本模型，再交付。
   * 三条硬纪律：
   *   · **默认模型**：不带 model（appHost.textGenStream 省略 model = 跟随该应用的模型选择 /
   *     宿主默认），thinking:"off"（应用通道本就默认关思考，这里写明意图），**不传 maxTokens**
   *     （思考与正文共用预算，传小了正文会被截断）；
   *   · **绝不吞话**：失败 / 超时（8 秒）/ 没配文本模型 / 结果离谱 → 原样交原始识别，
   *     状态行说清原因 —— 用户永远拿得到 ASR 的原话；
   *   · **只润色**：同音字、标点、断句、语气词与口语残渣；不改原意、不换语言、不续写。
   * 串行纪律：增强挂在转写队列里（q 是串行的），所以交付顺序与说话顺序一致。 */
  function enhSystem() {
    return t(
      "你是一个语音识别结果的润色器。用户发来一段 ASR 原始识别文本（可能带同音字错误、缺标点、" +
        "断句混乱或口语残渣）。要求：① 只在原意范围内修正同音字、补或改标点、理顺断句、" +
        "删掉「嗯 / 啊 / 那个」这类语气词与重复词；② 保持原语言与原来的长度量级，不扩写、不续写、" +
        "不补充用户没说的内容，不回答内容的提问；③ 只输出润色后的这一句正文 —— 不要解释、" +
        "不要加引号、不要编号或列表、不要 markdown。",
      "You polish ASR transcripts. The user sends one raw speech-recognition line which may contain " +
        "homophone errors, missing punctuation, broken sentence breaks or filler words. Rules: " +
        "(1) only fix homophones, punctuation, sentence breaks, filler words and accidental repeats; " +
        "(2) keep the original language and roughly the original length — never expand, continue, or add " +
        "anything the speaker did not say; never answer the content; (3) output ONLY the polished line: " +
        "no explanation, no quotes, no numbering, no markdown.",
    );
  }
  /** 极短上下文：上一两句定稿 + 当前输入框里插入点之前的那一段（合计截到 ~400 字符）——只用来消歧 */
  function enhContext(text) {
    var parts = [];
    var prev = lastText ? lastText.split("\n").filter(Boolean).slice(-2).join(" ") : "";
    if (prev) parts.push(t("上文：", "Context: ") + prev);
    var tail = "";
    try {
      if (anchor && anchor.el) {
        var v = inputTextOf(anchor.el) || "";
        var at = Math.max(0, Math.min(v.length, Number(anchor.start) || 0));
        tail = v.slice(0, at);
      }
    } catch (_) {}
    if (tail) parts.push(t("输入框已有：", "Already in the box: ") + tail);
    var head = parts.join("\n");
    if (head.length > ENH_CTX_CHARS) head = head.slice(head.length - ENH_CTX_CHARS);
    return (head ? head + "\n" : "") + t("这一句：", "This line: ") + text;
  }
  /** 模型输出 → 可直接交付的正文；不像正文（空的 / 带解释标签 / 长出一大截）就回空串（回落原文） */
  function enhSanitize(raw, src) {
    var s = String(raw == null ? "" : raw).trim();
    if (!s) return "";
    s = s
      .replace(/^(增强(后)?|润色(后)?|修正(后)?|修改(后)?|结果|正文|文本)\s*[:：]\s*/i, "")
      .replace(/^(enhanced|polished|corrected|output|result|text)\s*[:：]\s*/i, "");
    var lead = /^[「『"'“‘]+/;
    var tail = /[」』"'”’]+$/;
    for (var i = 0; i < 2; i++) s = s.replace(lead, "").replace(tail, "").trim();
    /* 折行：中文直接接上，西文补空格（模型偶尔会按标点换行） */
    var cjk = /[\u4e00-\u9fff]/.test(String(src || ""));
    s = s.replace(/\s*\n+\s*/g, cjk ? "" : " ").trim();
    if (s.length < ENH_MIN_CHARS) return "";
    var cap = Math.max(24, String(src == null ? "" : src).length * ENH_MAX_RATIO);
    if (s.length > cap) return "";
    return s;
  }
  /** 一句 → 增强后的一句；失败一律回 { ok:false, why }（调用方据 it 回落原始识别） */
  function enhanceText(text) {
    if (!cap().gen)
      return Promise.resolve({
        ok: false,
        why: t("宿主未提供文本生成能力", "host exposes no text generation"),
        code: "no_gen",
      });
    var opts = {
      /* model 省略 = 跟随该应用的选择 / 宿主默认文本模型；不传 maxTokens（见上） */
      messages: [
        { role: "system", content: enhSystem() },
        { role: "user", content: enhContext(text) },
      ],
      thinking: "off",
      temperature: 0.2,
    };
    var timer = 0;
    var timed = new Promise(function (resolve) {
      timer = setTimeout(function () {
        resolve({ ok: false, why: t("增强超时（8 秒）", "enhance timed out (8s)"), code: "timeout" });
      }, ENH_TIMEOUT_MS);
    });
    var call = Promise.resolve()
      .then(function () {
        return host.textGenStream(opts);
      })
      .then(function (r) {
        if (!r || r.ok === false) {
          var code = String((r && r.code) || "");
          var why =
            code === "no_provider"
              ? t("没配文本模型", "no text model configured")
              : String((r && r.error) || t("模型调用失败", "model call failed"));
          return { ok: false, why: why, code: code || "failed" };
        }
        var out = enhSanitize(r.text, text);
        if (!out)
          return { ok: false, why: t("增强结果不可用", "enhanced text unusable"), code: "bad_result" };
        return { ok: true, text: out };
      })
      .catch(function (err) {
        return { ok: false, why: String((err && (err.message || err)) || err), code: "failed" };
      });
    return Promise.race([call, timed]).then(function (r) {
      if (timer) clearTimeout(timer);
      return r;
    });
  }

  /* ── 转写（片材串行排队，按序增强 / 落字 / 追加）─────────────────────────── */
  /** 这一段的交付标签（结果小窗右上角那行小字） */
  function modeTag() {
    if (mode === MODE_LIVE) return t("持续转录中", "Live");
    if (mode === MODE_PTT) return t("按键转录", "Push-to-talk");
    return "";
  }
  /** 一句定稿 → 落字（锚点）+ 结果小窗 + "mtnode-dictate" 事件 */
  function deliver(text, raw, meta) {
    var s = String(text || "").trim();
    if (!s) return;
    var r = String(raw == null ? s : raw).trim() || s;
    if (r !== s) enhApplied = true;
    insertAtAnchor(s);
    appendLine(s, meta || modeTag(), r);
  }
  function finish(r) {
    /* r: { ok:true, text } | { ok:false, error } */
    if (!r || r.ok === false) {
      var msg = String((r && (r.error || r.message)) || t("转写失败", "Transcription failed"));
      say(msg, "err");
      return Promise.resolve();
    }
    var s = String(r.text || "").trim();
    if (!s) {
      say(t("没有识别到文字", "Nothing recognized"), "warn");
      return Promise.resolve();
    }
    if (!enhOn || !cap().gen) {
      say(
        enhOn
          ? t("AI 增强不可用（宿主无文本生成），已交原始识别", "AI enhance unavailable (no text generation) — raw text delivered")
          : t("识别完成（继续听写中）", "Done — still listening"),
        enhOn ? "warn" : "ok",
      );
      deliver(s, s, modeTag());
      return Promise.resolve();
    }
    say(t("识别完成，正在 AI 增强…", "Recognized — enhancing…"), "");
    return enhanceText(s).then(function (e) {
      if (e && e.ok) {
        say(t("已交付（AI 增强）", "Delivered (AI enhanced)"), "ok");
        deliver(e.text, s, t("AI 增强", "AI enhanced"));
        return;
      }
      say(
        t("AI 增强没生效，已交原始识别：", "AI enhance skipped — raw text delivered: ") +
          String((e && e.why) || t("增强失败", "enhance failed")),
        "warn",
      );
      deliver(s, s, t("原始识别", "Raw"));
    });
  }
  function fail(err) {
    say(String((err && (err.message || err.error)) || err || t("转写失败", "Transcription failed")), "err");
  }
  /** 一片 16k PCM16 WAV（base64）→ 文字；完成后按序增强 / 追加 */
  function transcribeSeg(pcm) {
    if (!cap().wav) {
      fail(new Error(t("宿主未提供音频转写能力", "Host exposes no audio transcription")));
      return Promise.resolve();
    }
    return Promise.resolve()
      .then(function () {
        return host.transcribeWav(segB64(pcm));
      })
      .then(function (r) {
        if (!r || r.ok === false) throw new Error(String((r && r.error) || t("转写失败", "Transcription failed")));
        return { ok: true, text: String(r.text || "") };
      })
      .catch(function (err) {
        return { ok: false, error: String((err && (err.message || err)) || err) };
      });
  }
  /** 队列口径：串行（本地 CPU 同时跑两片只会互相拖慢），按入队顺序追加，队列满丢最旧并说明 */
  var q = { list: [], running: false, dropped: 0, warned: false };
  function enqueueSeg(pcm) {
    if (!pcm || !pcm.length) return;
    q.list.push(pcm);
    while (q.list.length > QUEUE_MAX) {
      q.list.shift();
      q.dropped += 1;
    }
    if (q.dropped > 0 && !q.warned) {
      q.warned = true;
      say(t("识别跟不上，已丢掉较早的一段音频", "Recognition is lagging — dropped an earlier chunk"), "warn");
    }
    void drainQueue();
  }
  function drainQueue() {
    if (q.running) return Promise.resolve();
    var next = q.list.shift();
    if (!next) return Promise.resolve();
    q.running = true;
    /* 队列回到有余量：下一次再满时允许再提醒一次（不每一片都刷同一句提示） */
    if (q.list.length <= QUEUE_MAX / 2) q.warned = false;
    return transcribeSeg(next)
      .then(function (r) {
        return finish(r); /* 增强也在这条串行链上：交付顺序与说话顺序一致 */
      })
      .catch(function (err) {
        fail(err);
      })
      .then(function () {
        q.running = false;
        if (q.list.length) return drainQueue();
        if (!listening && !q.list.length && mode === MODE_OFF) say(t("听写已停止", "Dictation stopped"), "");
        return null;
      });
  }

  /* ── 采集（两种模式共用一条采集链：持续转录走静音门，按键转录走按键沿）──────────
   * 与画布那枚话筒（renderer/app-voice.js）同一套判据：
   *   · 采集：getUserMedia → AudioContext → AnalyserNode；analyser 窗口是**滑动**的（2048 样本
   *     ≈128ms），每 60ms 只取「距上次读取新增」的那一截拼成一帧 —— 整窗重复交上去会把同一段
   *     音频喂进识别好几遍；
   *   · 持续转录：起音看**最近若干帧的中位数**（单帧噪声不算起音）；句末看**连续安静累计**
   *     （低于「噪声底 + 动态范围 ×12%」）够 SILENCE_MS —— 一句说完就交，用户不用点第二次；
   *   · 按键转录：**按住 F1 起录、松开立刻把这一句交出去**（不等静音门 —— 语音指令要低延迟）。
   *     按键前留着 4 帧前卷（≈240ms），首字不被切；长按到硬顶才切一刀。这一态里麦克风
   *     保持开启（否则每次按键都要重新 getUserMedia，几百毫秒的起录延迟会把首字吃掉）。
   *   · 硬顶：某一句撑到 HARD_CAP_MS（后端 4 MiB ≈ 131 秒）还在说，就在尾部那段安静处切一刀
   *     （尾部静音裁到 300ms 后交出），后半截续着听；下一次按句末正常收口；
   *   · 停止：再点话筒循环到关闭 / F2 / Esc /「收起」→ 把手里还没交的那半句先交出去再收工。 */
  function silenceMs() {
    var v = Math.round(Number(silenceOverride) || SILENCE_MS);
    return Math.max(SILENCE_MIN_MS, Math.min(SILENCE_MAX_MS, v));
  }
  var silenceOverride = 0; /* 应用可调（apSpeechSilenceMs(n)）：不设就按 SILENCE_MS */
  function noiseFloorOf(obs) {
    if (!obs || !obs.length) return 0.002;
    var cut = Date.now() - NOISE_WIN_MS;
    var list = [];
    for (var i = 0; i < obs.length; i++) if (obs[i].at >= cut) list.push(obs[i].lv);
    if (!list.length) for (var j = 0; j < obs.length; j++) list.push(obs[j].lv);
    list.sort(function (a, b) {
      return a - b;
    });
    return Math.max(0.0004, list[Math.floor(list.length * 0.2)] || 0.002);
  }
  function medianLevel(win, k, w) {
    var from = Math.max(0, k - (w || LEVEL_WIN_FRAMES) + 1);
    var list = [];
    for (var i = from; i <= k && i < win.length; i++) list.push(win[i]);
    if (!list.length) return 0;
    list.sort(function (a, b) {
      return a - b;
    });
    var mid = list.length >> 1;
    return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
  }
  function micErrText(err) {
    var raw = String((err && err.name) || "") + " " + String((err && err.message) || "");
    if (/NotAllowedError|PermissionDeniedError|SecurityError/i.test(raw))
      return t("麦克风被拒绝：到系统设置里允许 MTNode（桌面应用）使用麦克风", "Microphone denied — allow desktop apps to use the microphone in system settings");
    if (/NotFoundError|DevicesNotFoundError/i.test(raw))
      return t("没找到输入设备：接一个麦克风，或到系统声音设置里确认输入设备", "No input device found — plug in a microphone or check the input device in system sound settings");
    if (/NotReadableError|TrackStartError/i.test(raw))
      return t("麦克风被占用或被系统隐私设置拦住：关掉其它正在用麦克风的程序，并允许桌面应用使用麦克风", "Microphone is busy or blocked by system privacy settings — close other apps using it and allow desktop apps to use the microphone");
    if (/AbortError/i.test(raw))
      return t("麦克风启动被中断，请再点一次", "Microphone start was interrupted — try again");
    if (/OverconstrainedError|ConstraintNotSatisfiedError/i.test(raw))
      return t("麦克风不支持所需的采集参数", "The microphone does not support the requested capture settings");
    var msg = String((err && err.message) || err || "");
    return t("麦克风启动失败", "Could not start the microphone") + (msg ? "：" + msg : "");
  }
  function stopStream(stream) {
    try {
      (stream.getTracks() || []).forEach(function (tr) {
        try {
          tr.stop();
        } catch (_) {}
      });
    } catch (_) {}
  }
  var rec = null; /* { stop, beginPtt, submitNow } —— 正在听的那一套采集 */
  /** 开始采集（两种模式共用）。落字锚点在**这里**记下来：采集全程的定稿都往这个框里写。 */
  function startLive() {
    if (listening) return true;
    if (!cap().mic) {
      say(t("宿主未放行麦克风", "Host did not grant microphone"), "warn");
      return false;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      say(t("本机不支持麦克风采集", "Microphone capture is unsupported here"), "err");
      return false;
    }
    listening = true;
    /* 锚点：**只认可输入控件**。点话筒那一刻焦点常常已经落在话筒按钮上（按钮抢了焦点），
       这时不能把之前记下的那个输入框抹掉 —— 所以只在「当前焦点真在可输入控件里」时覆盖，
       否则沿用 focusin 记下的那一个（见 hookHotkey 的 focusin 与按钮的 noFocusSteal）。 */
    try {
      var cur = captureAnchor(document.activeElement);
      if (cur) anchor = cur;
    } catch (_) {}
    pendingInsert = "";
    paintMic();
    say(modeBanner(), "");
    /* 首次使用要下 239MB 权重：这里把准备跑起来（不阻塞听 —— 采到的句子排进队列等它就绪） */
    ensureReady();
    /* 失败路径也要能把已经拿到的话筒关掉（以前失败时那只 MediaStream 一直开着） */
    var streamRef = null;
    navigator.mediaDevices
      .getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
      .then(function (stream) {
        if (!listening) {
          stopStream(stream);
          return;
        }
        streamRef = stream;
        var AC = window.AudioContext || window.webkitAudioContext;
        var ac = null;
        var src = null;
        var analyser = null;
        var buf = null;
        try {
          /* 优先要 16 kHz 的上下文（与画布同口径）；要不到就用设备原生率 + 逐帧重采样 */
          ac = createAudioCtx(AC);
          src = ac.createMediaStreamSource(stream);
          analyser = ac.createAnalyser();
          analyser.fftSize = ANALYSER_FFT;
          src.connect(analyser);
          buf = new Float32Array(analyser.fftSize);
        } catch (err) {
          stopStream(stream);
          listening = false;
          paintMic();
          rec = null;
          fail(new Error(micErrText(err)));
          return;
        }
        var rate = Number(ac.sampleRate) || 48000;
        var framesPerRead = Math.max(1, Math.round((FRAME_SAMPLES * rate) / SR));
        var lastReadAt = 0;
        var carry = new Float32Array(0);
        var seg = []; /* 当前这句已累计的帧 */
        var segSamples = 0;
        var quietSamples = 0; /* 当前这句尾巴上已攒的静音样本 */
        var gateArm = false; /* 本句已经出过声（静音门据此收口） */
        var lvlWin = []; /* 最近若干帧的电平（起音判据 = 中位数） */
        var noiseObs = []; /* {lv,at} 观察窗（噪声底取 20% 分位） */
        var preRoll = []; /* 按键转录：没按键时滚动保留的最后几帧（按住即接上，首字不被切） */
        var lastFrameAt = Date.now();
        var stopped = false;
        var frameTimer = 0;

        function frameLevel(f32) {
          var lv = rmsOf(f32);
          noiseObs.push({ lv: lv, at: Date.now() });
          var cut = Date.now() - NOISE_WIN_MS;
          while (noiseObs.length && noiseObs[0].at < cut) noiseObs.shift();
          lvlWin.push(lv);
          while (lvlWin.length > LEVEL_WIN_FRAMES) lvlWin.shift();
          return lv;
        }
        function dropSeg() {
          seg = [];
          segSamples = 0;
          quietSamples = 0;
          gateArm = false;
        }
        /** 按住 PTT 键：把前卷接上当这一句的开头，静音门与出声标记一起复位 */
        function beginPtt() {
          dropSeg();
          if (preRoll.length) {
            seg = preRoll.slice();
            for (var i = 0; i < seg.length; i++) segSamples += seg[i].length;
          }
          preRoll = [];
        }
        /** 本句 → 队列（提交前把尾巴静音裁到 300ms）。
         *  force=true（按键转录松开键）时：不必等静音门起音 —— 用户明确说了这一句就该交，
         *  只是太短的片段（< MIN_SEG_SAMPLES）仍然丢掉（咳一声 / 误碰按键）。 */
        function submitSeg(trimSilence, force) {
          var total = segSamples;
          if (total < MIN_SEG_SAMPLES || (!gateArm && !force)) {
            dropSeg();
            return;
          }
          var drop = 0;
          if (trimSilence) {
            var extra = quietSamples - TAIL_SILENCE_SAMPLES;
            if (extra > 0) drop = Math.min(extra, total - MIN_SEG_SAMPLES);
          }
          if (drop < 0) drop = 0;
          var keep = total - drop;
          if (keep < MIN_SEG_SAMPLES) {
            dropSeg();
            return;
          }
          var out = new Float32Array(keep);
          var off = 0;
          for (var i = 0; i < seg.length && off < keep; i++) {
            var take = Math.min(seg[i].length, keep - off);
            out.set(seg[i].subarray(0, take), off);
            off += take;
          }
          dropSeg();
          enqueueSeg(out);
        }
        function pushFrame(f32) {
          var lv = frameLevel(f32);
          var floor = noiseFloorOf(noiseObs);
          var thr = floor + Math.max(0.006, floor * 0.6); /* 起音线：贴着底噪的稳定电平 */
          var quietLine = Math.max(0.0008, floor * 1.35); /* 静音线：略高于底噪 */
          var k = lvlWin.length - 1;
          var stable = medianLevel(lvlWin, k, 3) >= thr;

          /* ⓪ 按键转录且**没按着**：只滚动保留前卷，不进这一句（按 F1 之前的音频不算数） */
          if (mode === MODE_PTT && !pttOn) {
            preRoll.push(f32);
            while (preRoll.length > PRE_ROLL_FRAMES) preRoll.shift();
            lastFrameAt = Date.now();
            return;
          }
          /* ① 缓冲：起音前卷已经在缓冲里（还没出过声的帧一直在攒），直接接上这一帧 */
          seg.push(f32);
          segSamples += f32.length;
          /* ② 静音 / 出声的计时 */
          if (lv < quietLine) {
            quietSamples += f32.length;
            if (!gateArm) {
              /* 还没起音：底噪帧不进缓冲，避免「一按就切出一堆噪声句」 */
              seg.pop();
              segSamples -= f32.length;
              quietSamples = 0;
            }
          } else {
            quietSamples = 0;
            if (stable) gateArm = true;
          }
          if (!gateArm) {
            lastFrameAt = Date.now();
            return;
          }
          /* ③ 句末：连续安静累计够阈值（有起音才算收口）。
             按键转录**不走这一条**：那一态的分句点是「松开键」，不是停顿 —— 语音指令要低延迟。 */
          if (mode !== MODE_PTT && quietSamples >= Math.round((silenceMs() * SR) / 1000) && quietSamples < segSamples) {
            submitSeg(true);
            lastFrameAt = Date.now();
            return;
          }
          /* ④ 硬顶：这一句撑到后端单次上限 → 交出去（尾部的安静裁到 300ms，等于在最后那段
             停顿处切一刀）；后半截续着听，下一次按句末正常收口 */
          if (segSamples >= Math.round((HARD_CAP_MS * SR) / 1000)) {
            submitSeg(true);
          }
          lastFrameAt = Date.now();
        }
        /** 从 analyser 的**滑动窗口**里只取「距上次读取新增」的那一截。
         *  analyser 缓冲区里**始终是最近 N 个样本**（N = fftSize，约 128ms @16k）。
         *  这里用「读取时刻」对齐窗口：窗口覆盖 [now - N/rate, now]，上次读到 readAtMs；
         *  于是新增的那一截 = [readAtMs, now] 在窗口里的那一段（左上界按窗口起点夹一下）。
         *  整窗重复交上去 = 同一段音频被喂进识别好几遍（旧稿 60ms 读 128ms 窗口 → 4.4 倍重复），
         *  所以「只取新增」这件事必须准；窗口里读不到新样本时返回空帧、由上层攒着下次再凑。 */
        function readNewSamples() {
          analyser.getFloatTimeDomainData(buf);
          var now = Date.now();
          if (!lastReadAt) lastReadAt = now - FRAME_MS;
          var readAtMs = lastReadAt;
          lastReadAt = now;
          var n = buf.length;
          var winSpanMs = (n * 1000) / rate;
          var winStartMs = Math.max(0, now - winSpanMs);
          var fromMs = Math.max(readAtMs, winStartMs);
          var toMs = now;
          if (!(toMs > fromMs)) return new Float32Array(0);
          /* 窗口起点随「丢掉的旧样本」平移：把落在窗外的那部分裁掉（数组不搬，索引夹一下就行） */
          winStartMs = Math.min(winStartMs, fromMs);
          var bufStart = Math.floor(((fromMs - winStartMs) * rate) / 1000);
          var cnt = Math.floor(((toMs - fromMs) * rate) / 1000);
          if (bufStart >= n) return new Float32Array(0);
          if (cnt < 1) cnt = 1;
          var end = Math.min(n, bufStart + cnt);
          if (end <= bufStart) return new Float32Array(0);
          return new Float32Array(buf.subarray(bufStart, end));
        }
        /** 把读到的样本补成整帧（960 样本 @16k）：余量攒着，下一轮接着凑 */
        function pump() {
          if (stopped) return;
          var got = new Float32Array(0);
          try {
            got = readNewSamples();
          } catch (err) {
            /* 单帧读失败（老引擎 / analyser 出错）不该把整条采集链掐死：记一句、下一轮接着读 */
            fail(err);
            lastReadAt = 0;
          }
          if (got.length) {
            var merged;
            if (carry.length) {
              merged = new Float32Array(carry.length + got.length);
              merged.set(carry, 0);
              merged.set(got, carry.length);
            } else merged = got;
            var per = Math.max(1, Math.round((FRAME_SAMPLES * rate) / SR));
            var off = 0;
            while (merged.length - off >= per) {
              var chunk = merged.subarray(off, off + per);
              /* 设备不是 16 kHz 时逐帧搬过去：帧里最终一定是 FRAME_SAMPLES（960）个 16 kHz 样本，
                 下游所有按 SR = 16000 换算的判据（静音门 / 最短片段 / 硬顶）才成立 */
              pushFrame(rate === SR ? chunk : resampleTo16k(chunk, rate));
              off += per;
            }
            carry = off < merged.length ? new Float32Array(merged.subarray(off)) : new Float32Array(0);
          }
          /* 采集停摆（定时器被挂起过）：这么久没读到新帧就重锚一次时间基准，别让下一轮算出
             一大截「新增」把窗口里那点陈音重复交上去 */
          if (Date.now() - lastFrameAt > FRAME_STALL_MS * 4) {
            lastFrameAt = Date.now();
            lastReadAt = 0;
            carry = new Float32Array(0);
          }
          frameTimer = setTimeout(pump, FRAME_MS);
        }
        function stop(commit) {
          if (stopped) return;
          stopped = true;
          if (frameTimer) clearTimeout(frameTimer);
          frameTimer = 0;
          /* 收工前把手里那半句先交出去（用户按停止时正在说的话不该丢）：
             按键转录态下即使还没到「起音稳定」的判据也要交（force）—— 用户明确说了这一句 */
          if (commit && segSamples >= MIN_SEG_SAMPLES && (gateArm || mode === MODE_PTT)) submitSeg(true, true);
          try {
            if (src) src.disconnect();
          } catch (_) {}
          try {
            if (analyser) analyser.disconnect();
          } catch (_) {}
          try {
            if (ac) ac.close();
          } catch (_) {}
          stopStream(stream);
          rec = null;
          markListening(false);
        }
        rec = { stop: stop, beginPtt: beginPtt, submitNow: function () { submitSeg(true, true); } };
        lastFrameAt = Date.now();
        pump();
      })
      .catch(function (err) {
        /* 失败收尾：把已经打开的话筒关掉（以前这条路径漏了它），再按 err.name 给准确文案 */
        stopStream(streamRef);
        streamRef = null;
        rec = null;
        markListening(false);
        fail(new Error(micErrText(err)));
      });
    return true;
  }
  /** 停：把还没交的半句交出去再收工（界面与快捷键都调它） */
  function stopLive() {
    if (!listening) return false;
    if (rec && rec.stop) {
      try {
        rec.stop(true);
      } catch (_) {}
    } else {
      markListening(false);
    }
    return true;
  }
  function markListening(on) {
    listening = !!on;
    if (!listening) pttOn = false;
    paintMic();
    if (!listening) {
      if (!q.running && !q.list.length) say(t("听写已停止", "Dictation stopped"), "");
      else say(t("正在收尾识别…", "Finishing recognition…"), "");
    }
  }
  /** 现在这一态该说哪句话（状态行 / 按钮 tooltip 共用） */
  function modeHint(m) {
    if (m === MODE_LIVE) return t("持续转录：说完一句自动识别", "Live: each sentence is recognized as you pause");
    if (m === MODE_PTT) return t("按键转录：按住 F1 说话，松开立刻识别", "Push-to-talk: hold F1 and release to recognize");
    return t("语音输入已关闭", "Voice input is off");
  }
  function modeBanner() {
    if (mode === MODE_PTT) return t("按键转录：按住 F1 说话（松开就识别；也可以按住左下角那枚话筒）", "Push-to-talk: hold F1 and release to recognize (or hold the bottom-left mic)");
    return t("正在听…（说完一句自动识别；再点话筒切到按键转录 / 关闭）", "Listening… (each sentence is recognized; click the mic again for push-to-talk / off)");
  }
  /** 三态切换（照画布那枚话筒的口径）：关 → 持续转录 → 按键转录 → 关 */
  function setMode(m) {
    var want = MODE_CYCLE.indexOf(String(m)) >= 0 ? String(m) : MODE_OFF;
    if (want === mode) return mode;
    if (want === MODE_OFF) {
      /* 离开按键态：先把手里的这一句交出去，再收采集（顺序不能反：交要读缓冲） */
      stopPtt("leave");
      mode = MODE_OFF;
      stopLive();
      paintMic();
      return mode;
    }
    show(); /* 收起状态下切模式：先让条露面（否则「开了却看不见」） */
    if (mode === MODE_OFF) resetLines(); /* 新的一段 */
    mode = want;
    pendingInsert = ""; /* 上一段挂住的字不再跨段补写（已经写进结果小窗，丢不了） */
    if (!listening) startLive();
    paintMic();
    say(modeBanner(), "");
    return mode;
  }
  function cycleMode() {
    return setMode(MODE_CYCLE[(MODE_CYCLE.indexOf(mode) + 1) % MODE_CYCLE.length]);
  }
  /** 一条路进出的开关（F2 / apSpeechToggle）：没在听就开始**持续转录**，在听就关掉。
   *  语义与旧版一致（老应用与老文档里 F2 就是「开/关持续听写」）；三态循环走话筒点击。 */
  function toggleLive() {
    if (mode !== MODE_OFF) {
      setMode(MODE_OFF);
      return false;
    }
    if (busy) return false;
    show(); /* 收起状态下按快捷键 / 浮动话筒：先让它露面（否则「呼出了但看不见」） */
    resetLines();
    setMode(MODE_LIVE);
    return true;
  }
  /** 按键转录的判键：只认 PTT 键本身（按 ev.code 判，与输入法 / 键盘布局无关） */
  function pttIsKey(ev) {
    return String((ev && ev.code) || "") === PTT_KEY;
  }
  /** 按住 = 起录（采集没起来就先起来） */
  function startPtt() {
    if (mode !== MODE_PTT || pttOn) return false;
    if (!listening && !startLive()) return false;
    pttOn = true;
    if (rec && rec.beginPtt) {
      try {
        rec.beginPtt(); /* 接上前卷：首字不被切 */
      } catch (_) {}
    }
    paintMic();
    say(t("正在录这一句（松开 F1 立刻识别）…", "Recording this sentence — release F1 to recognize…"), "");
    return true;
  }
  /** 松开 = 手动定稿：把这一句立刻交出去识别（**不等静音门** —— 语音指令要低延迟） */
  function stopPtt(reason) {
    if (!pttOn) return false;
    pttOn = false;
    if (rec && rec.submitNow) {
      try {
        rec.submitNow();
      } catch (_) {}
    } else if (rec && rec.stop) {
      try {
        rec.stop(true);
      } catch (_) {}
    }
    paintMic();
    say(t("正在识别这一句…", "Recognizing this sentence…"), "");
    return true;
  }
  /** 快捷键命中判据：F2（key / code / keyCode 三条都认）或备选 Ctrl+Shift+D */
  function isHotkey(ev) {
    if (!ev) return false;
    if (ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey) {
      var lk = String(ev.key || "").toLowerCase();
      if (lk === "d" || String(ev.code || "") === "KeyD") return true;
    }
    if (ev.ctrlKey || ev.altKey || ev.metaKey) return false;
    var k = String(ev.key || "");
    var c = String(ev.code || "");
    if (k === HOTKEY_KEY || c === HOTKEY_CODE) return true;
    /* 老引擎只给 keyCode：113 才是 F2（59 是 F1 —— 旧值会让老引擎上按 F1 误触听写） */
    return Number(ev.keyCode) === HOTKEY_KEYCODE && !k;
  }

  /* ── 落点：footer 装得下就贴应用自己的页脚，装不下改挂宿主的固定底栏 ──────────────
   * 为什么不能「挂进 footer 就完事」：应用页常见 height:100vh 且 overflow 收口，我们这条塞在
   * <footer> 末尾会把页脚撑高一行 —— 真机实测 sudoku / test 两个应用就是这样：DOM 里有，
   * 屏幕上看不到（条 top=748 + 高 34 = 782 > 视口 757），用户看到的就是「下方根本没有 asr」。
   * 所以落点每次都**先挂再量**：量出来不在视口里（或被祖先 overflow 裁掉 / 没有尺寸）就换到
   * 固定底栏；反过来，窗口变大后又装得下就挪回 footer。同一帧内先挂再量、不满意立即换宿主，
   * 用户看不到闪动。量不了几何（老引擎 / 微型 DOM）一律当可见 —— 绝不因为量不了把条挪走。 */
  var footEl = null; /* 应用自己的 footer（找到才用） */
  var barEl = null; /* 宿主自建的固定底栏（footer 装不下时的落点） */
  var resizeHooked = false;
  var missCount = 0; /* 连续量到「在 footer 里看不见」的次数（连中两次才搬走，见 placeStrip） */

  /* ── 收起态 ────────────────────────────────────────────────────────────
   * 隐藏标记 data-mtnode-hidden="1" + display:none（标记 + 内联样式双保险，标记是给脚本 / 冒烟认的），
   * CSS 兜底写在 styleTag 里。**挂载时不再打这个标记**（见 apSpeechMount 的 markShown）——
   * 只有「收起」按钮 / apSpeechHide() 会打上它，那是本窗口内的临时隐藏。
   * 隐藏态下**不做落点搬移**（placeStrip 直接返回）：不然它一被量成「看不见」就会被搬到宿主
   * 自建的固定底栏 #mtnode-dictate-bar 去，页面上凭空多一条底栏。
   * 要让它回来：删掉那个属性（或调 apSpeechReveal()）—— 下一次 placeStrip 会先补一次落点。
   * 本轮补一条：收起时**先把正在听的收掉**（条藏起来了还占着话筒，用户看不见也没法停止）。 */
  var HIDDEN_ATTR = "data-mtnode-hidden";
  function hiddenNow(el) {
    var t = el || root;
    try {
      return !!(t && t.getAttribute && t.getAttribute(HIDDEN_ATTR) === "1");
    } catch (_) {
      return false;
    }
  }
  function markHidden(el) {
    var t = el || root;
    if (!t) return false;
    try {
      t.setAttribute(HIDDEN_ATTR, "1");
      if (t.style) {
        t.style.display = "none";
        /* box-sizing 也一并钉住：露面时不会因为内联样式残留而变形 */
      }
    } catch (_) {}
    return true;
  }
  /** 露面的落点写法（挂载时用）：这个标记只在**宿主按 app.json 的 capabilities.showDictate
   *  注入进来**时才会走到这里 —— 用户显式声明了要这条条，所以挂载即可见，不再挂载即隐藏。
   *  与 reveal() 的区别：reveal() 是给运行期（收起后再要它出来）用的，会顺手补一次落点。 */
  function markShown(el) {
    var t = el || root;
    if (!t) return false;
    try {
      t.removeAttribute(HIDDEN_ATTR);
      if (t.style) t.style.display = "";
    } catch (_) {}
    return true;
  }
  /** 让听写条露面（收起后要它回来时调；幂等）。
   *  与 markShown 的差别只在这一步：顺手补一次落点，免得它挂在 footer 底下看不到。 */
  function show() {
    if (!root) return false;
    markShown(root);
    try {
      placeStrip({ allowReturn: true });
    } catch (_) {}
    paintZoneGap();
    return true;
  }
  /** 把这条听写条收起来（「收起」按钮 / 应用自己调 apSpeechHide()；幂等）。
   *  只写标记 + display:none，不碰 app.json 的能力位；下次打开应用窗口按声明照旧露面。
   *  正在听就先停（见上面那段注释）：藏起来的条不该还占着话筒。 */
  function hide() {
    if (!root) return false;
    /* 正在听（任何一态）就先停：藏起来的条不该还占着话筒，更不该还在录按键那一句 */
    if (mode !== MODE_OFF) setMode(MODE_OFF);
    else if (listening) stopLive();
    markHidden(root);
    missCount = 0; /* 隐藏态不算「装不下」：清掉计数，免得下次露面立刻被搬走 */
    paintZoneGap();
    return true;
  }
  /** 兼容既有名字：apSpeechReveal / reveal 是同一个动作 */
  var reveal = show;

  function rectOf(el) {
    try {
      return el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    } catch (_) {
      return null;
    }
  }
  function cssOf(el, prop) {
    try {
      var cs = getComputedStyle(el);
      var v = cs && cs.getPropertyValue ? cs.getPropertyValue(prop) : "";
      v = String(v || "").trim();
      return v || String((cs && cs[prop]) || "");
    } catch (_) {
      return "";
    }
  }
  /** 这一条现在真的看得见吗（量不出来就返回 true） */
  function visibleNow(el) {
    if (hiddenNow(el)) return false; /* 收起态：不算看得见（placeStrip 据此不搬它） */
    var r = rectOf(el);
    if (!r) return true;
    if (!r.width && !r.height) return false; /* display:none / 折叠：没有尺寸就是没显示 */
    var vh = 0;
    try {
      vh = Number(window.innerHeight || 0);
    } catch (_) {}
    if (vh && (r.bottom > vh + 1 || r.top < -1)) return false;
    var p = el.parentElement;
    var guard = 0;
    while (p && guard++ < 40) {
      if (cssOf(p, "display") === "none" || cssOf(p, "visibility") === "hidden") return false;
      if (/(hidden|clip|auto|scroll)/.test(cssOf(p, "overflow-y") || cssOf(p, "overflow"))) {
        var pr = rectOf(p);
        if (pr && (r.bottom > pr.bottom + 1 || r.top < pr.top - 1)) return false;
      }
      p = p.parentElement;
    }
    return true;
  }
  /** 固定底栏宿主：贴近视口底边、压在应用内容之上（footer 装不下 / 应用压根没有 footer 时用） */
  function barHost() {
    if (barEl && barEl.parentElement) return barEl;
    var p = palette();
    var bar = document.createElement("div");
    bar.id = "mtnode-dictate-bar";
    bar.style.cssText =
      "position:fixed;left:0;right:0;bottom:0;z-index:12540;display:flex;align-items:center;gap:10px;" +
      "padding:6px 12px;border-top:1px solid " +
      p.line +
      ";background:" +
      p.bg +
      ";color:" +
      p.fg +
      ";font:" +
      p.font;
    (document.body || document.documentElement).appendChild(bar);
    barEl = bar;
    return bar;
  }
  /** 底栏空了就收掉：不留一条空的固定底栏压着应用内容 */
  function dropEmptyBar() {
    if (barEl && !barEl.childNodes.length && barEl.parentElement) {
      barEl.parentElement.removeChild(barEl);
      barEl = null;
    }
  }
  /** 左下角角落区的宽度：听写条落在固定底栏里时按它左让一块（浮动话筒才不会被压住） */
  function zoneW() {
    var r = rectOf(zone);
    return r && r.width ? r.width : 0;
  }
  /** 按角落区实际宽度给底栏内那一条让位；退出底栏时把让位清掉（不留下永久缩进） */
  function paintZoneGap() {
    if (!root || !root.style) return;
    var gap = barEl && root.parentElement === barEl ? zoneW() : 0;
    root.style.marginLeft = gap ? gap + "px" : "";
  }
  /** 把条放到它该在的地方（一次复核）。
   *  opts.allowReturn=false（默认：应用页长高了 / 定时复核）只允许「footer → 固定底栏」这一个方向 ——
   *  搬动这条本身就会改页面高度（进 footer 会把页脚撑高一行），单向才不会自己触发自己来回弹；
   *  opts.allowReturn=true 只在窗口尺寸**真的**变了（用户拖窗口）时才用：搬回 footer 重量一次。 */
  function placeStrip(opts) {
    if (!root) return false;
    /* 收起态：一动不动 —— 既不算「装不下」，也不进宿主自建的固定底栏 */
    if (hiddenNow(root)) {
      missCount = 0;
      return true;
    }
    var allowReturn = !!(opts && opts.allowReturn);
    if (!footEl) {
      if (root.parentElement !== barEl) barHost().appendChild(root);
      paintZoneGap();
      return true;
    }
    if (root.parentElement !== footEl) {
      /* 现在在固定底栏里：默认复核不动它 */
      if (!allowReturn) {
        paintZoneGap();
        return true;
      }
      footEl.appendChild(root); /* 窗口尺寸变了：回 footer 再量一次，装得下就留在这儿 */
    }
    if (visibleNow(root)) {
      missCount = 0;
      dropEmptyBar();
      paintZoneGap();
      return true;
    }
    /* 要连中两次才搬：应用页中途会有那么一瞬量出来在视口外（真机复现：ai-battle 只在某一次复核
       上量到不可见），为一次瞬时测量就把条从应用自己的页脚搬到悬浮底栏，属于过度反应。 */
    missCount++;
    if (allowReturn || missCount >= 2) {
      barHost().appendChild(root);
      missCount = 0;
    }
    dropEmptyBar();
    paintZoneGap();
    return true;
  }
  function hookResize() {
    if (resizeHooked) return;
    resizeHooked = true;
    try {
      window.addEventListener("resize", function () {
        try {
          placeStrip({ allowReturn: true });
          placePanel();
        } catch (_) {}
      });
    } catch (_) {}
    /* 应用页几乎都是「先出壳、内容后到」：footer 被内容顶下去是**挂载之后**才发生的，所以挂载时那次
       测量会误判成「装得下」（真机复现：sudoku / test 挂载时量到可见，3 秒后条已经落到视口以下）。
       这里两种兜底：① 定时复核几次（没有 ResizeObserver 的老引擎也有救）② 盯 document.body 的尺寸
       变化（内容长出来就再量一次）。复核一律单向，「footer → 底栏」不会自激。 */
    [0, 250, 800, 2000].forEach(function (ms) {
      setTimeout(function () {
        try {
          placeStrip();
        } catch (_) {}
      }, ms);
    });
    try {
      if (window.ResizeObserver) {
        new ResizeObserver(function () {
          try {
            placeStrip();
          } catch (_) {}
        }).observe(document.body || document.documentElement);
      }
    } catch (_) {}
  }

  /* ── 左下角角落区（浮动话筒）────────────────────────────────────────────
   * 需求：听写条收下后，左下角那枚浮动话筒要能随时把它呼出来。它与作者标签共用同一个角落，
   * 所以这里建一个**列容器**（id mtnode-dictate-zone）统一占位：
   *   · 浮动话筒是本模块的元素（点一下 = 呼出 + 开始 / 停止听写，正在听时红点脉冲）；
   *   · 作者标签（renderer/app-author-ui.js）是**另一个模块**的元素，它按本容器的顶边把自己
   *     排到上面一行（见那边的 place()），因此这里变更（挂 / 挪 / 让位）要广播一次。 */
  function zoneEl() {
    if (zone && zone.parentElement) return zone;
    zone = document.createElement("div");
    zone.className = "mtn-dict-zone";
    zone.id = "mtnode-dictate-zone";
    (document.body || document.documentElement).appendChild(zone);
    return zone;
  }
  /** 角落区动了就喊一声：作者标签据此重新算「我该贴在哪一行」 */
  function tellZoneMoved() {
    try {
      window.dispatchEvent(new CustomEvent("mtnode-dictate-zone"));
    } catch (_) {}
    try {
      if (typeof window.apAuthorPlace === "function") window.apAuthorPlace();
    } catch (_) {}
  }
  function mountZoneButton() {
    if (zoneBtn && zoneBtn.parentElement) return zoneBtn;
    var z = zoneEl();
    zoneBtn = document.createElement("button");
    zoneBtn.type = "button";
    zoneBtn.id = "mtnode-dictate-zone-btn";
    zoneBtn.className = "mtn-dict-zone-btn";
    zoneBtn.innerHTML = "🎤";
    zoneBtn.setAttribute("aria-pressed", "false");
    /* 点一下 = 三态循环（与条上话筒同一口径）；按键转录态下**按住它就是按住说话**。
       两者靠按住时长区分：按住说了话（>=250ms）→ 这一次点击只算鼠标 PTT 的收尾；
       飞快点一下（<250ms）→ 仍按「点一下」处理（否则进了按键转录态就再也点不出来了）。 */
    var pressAt = 0;
    zoneBtn.addEventListener("click", function (ev) {
      if (ev && ev.preventDefault) ev.preventDefault();
      if (zoneBtn.dataset.mtnodePtt === "1") {
        zoneBtn.dataset.mtnodePtt = "";
        if (Date.now() - pressAt >= 250) return;
      }
      cycleMode();
    });
    ["pointerdown", "mousedown"].forEach(function (kind) {
      zoneBtn.addEventListener(kind, function (ev) {
        if (mode !== MODE_PTT) return;
        if (ev && ev.button) return; /* 只认左键 */
        if (ev && ev.preventDefault) ev.preventDefault();
        pressAt = Date.now();
        if (startPtt()) zoneBtn.dataset.mtnodePtt = "1";
      });
    });
    ["pointerup", "pointercancel", "mouseup", "mouseleave"].forEach(function (kind) {
      zoneBtn.addEventListener(kind, function () {
        if (mode === MODE_PTT && pttOn) stopPtt("pointer");
      });
    });
    z.appendChild(zoneBtn);
    noFocusSteal(zoneBtn); /* 鼠标点它不该把焦点从用户正在写的框里抢走 */
    paintMic();
    tellZoneMoved();
    return zoneBtn;
  }

  /* ── 挂载 ─────────────────────────────────────────────────────────────── */
  /** 挂载。桥的来源按顺序：① 宿主直接传进来；② 页面上的 window.appHost；
   *  ③ 宿主派发的 "mtnode-apphost" 事件（detail.host）—— 注入脚本与 preload 分处
   *  两个 JS 世界，对象过不来时就走事件这条。 */
  function apSpeechMount(api, opts) {
    host = api || (typeof window !== "undefined" ? window.appHost : null) || null;
    if (!host || root || !document.body) return false;
    if (typeof window !== "undefined") window.apSpeechHost = host;
    var o = opts || {};
    var c = cap();
    /* 这条条只做听写：至少要有一项转写能力（现况 / 自己录的 WAV）才值得出现 */
    if (!c.status && !c.wav) return false;
    styleTag();
    root = document.createElement("div");
    root.className = "mtn-dict";
    root.id = "mtnode-dictate";
    root.innerHTML =
      '<button type="button" class="mtn-dict-btn" id="mtn-dict-mic" data-act="mic" aria-pressed="false" title="' +
      esc(t("点一下按「关闭 → 持续转录 → 按键转录」循环：持续转录说完一句自动识别；按键转录按住 F1 说话、松开即识别。窗口内快捷键 F2 是持续转录的开关（备选 Ctrl+Shift+D），Esc 停止", "Click to cycle off → live → push-to-talk. Live recognizes each sentence as you pause; push-to-talk records while you hold F1 and recognizes on release. Window hotkey F2 toggles live (or Ctrl+Shift+D); Esc stops")) +
      '">🎤<span>' +
      esc(t("听写", "Dictate")) +
      '</span></button>' +
      /* AI 增强开关（需求：转录按钮**右侧**一枚 Toggle）：默认 LLM + system prompt + 无思考 */
      '<button type="button" class="mtn-dict-btn mtn-dict-tog" id="mtn-dict-enh" data-act="enh" aria-pressed="false" title="' +
      esc(t("AI 增强：每句识别完用默认文本模型（无思考）按简短上下文润色一次；失败 / 超时 / 没配模型时原样交原始识别", "AI enhance: each sentence is polished once by the default text model (thinking off) with a short context; on failure, timeout or no model the raw text is delivered")) +
      '">✨<span>' +
      esc(t("AI 增强", "AI enhance")) +
      '</span><i class="mtn-dict-enh-dot"></i></button>' +
      '<span class="mtn-dict-note"></span>' +
      '<button type="button" class="mtn-dict-btn mtn-dict-hide" id="mtn-dict-hide" data-act="hide" title="' +
      esc(t("收起这条听写条（只影响本次窗口；下次打开应用窗口按声明重新出现）。左下角那枚浮动话筒仍在，点它或按 F2 就能呼出来", "Hide this dictate bar (this window only; it comes back the next time the app window opens). The floating mic at the bottom-left stays — click it or press F2 to bring the bar back")) +
      '">' +
      esc(t("收起", "Hide")) +
      "</button>";
    /* 可见性：这条条只有在应用声明了 capabilities.showDictate 时才会被宿主注入
       （闸门在 preload-app.js），既然用户显式声明要它，注入进来就该**默认露面** —— 以前这里挂载即
       markHidden(root)，结果「勾了显示听写条却永远看不见」，只能靠应用自己调 apSpeechReveal()。
       标记 data-mtnode-hidden 与两个既有入口都保留：收起按钮 / apSpeechHide() 用它藏、
       apSpeechReveal() 用它显示；隐藏态下 placeStrip 不搬落点（既有逻辑，见 placeStrip）。 */
    markShown(root);
    refs.mic = root.querySelector('[data-act="mic"]');
    refs.enh = root.querySelector('[data-act="enh"]');
    refs.hide = root.querySelector('[data-act="hide"]');
    refs.note = root.querySelector(".mtn-dict-note");
    /* 本条自己的按钮一律不吃焦点（见 noFocusSteal）：点话筒 / 切增强时，用户正在写的输入框
       必须还握着焦点，落字才写得进去。 */
    noFocusSteal(refs.mic);
    noFocusSteal(refs.enh);
    noFocusSteal(refs.hide);

    /* 落点：① 应用自己的 <footer>（最自然，但**装得下**才用）② 宿主自建的固定底栏 */
    /* eslint-disable no-empty */
    var FOOT_SELS = ["footer", ".app-foot", ".foot", "#appFoot"];
    try {
      footEl = document.querySelector(FOOT_SELS.join(", "));
    } catch (_) {
      /* 老引擎 / 选择器语法不被支持：逐个试一遍，绝不因为找 footer 抛异常 */
      for (var fi = 0; fi < FOOT_SELS.length && !footEl; fi++) {
        try {
          footEl = document.querySelector(FOOT_SELS[fi]);
        } catch (__) {}
      }
    }
    if (footEl) {
      /* footer 现在是横排（自带说明文字）：让它换行，我们的条独占一行，不挤乱原有内容 */
      try {
        footEl.classList.add("mtn-dict-foot");
        var fcs = getComputedStyle(footEl);
        if (fcs.display === "flex" && fcs.flexDirection === "row") footEl.style.flexWrap = "wrap";
      } catch (_) {}
    }
    /* eslint-enable no-empty */
    /* 初始落点：有 footer 就先挂 footer（通常最好看），没有就直接上固定底栏。挂载这一帧量出来的
       位置基本不可信（应用内容还没长出来），所以真正的落点交给下面的复核（定时 + ResizeObserver）。 */
    if (footEl) footEl.appendChild(root);
    else barHost().appendChild(root);
    placeStrip();

    /* 左下角浮动话筒（本轮需求）：常驻，把条呼出来 / 停止听写的第二入口 */
    mountZoneButton();
    hookResize();

    if (refs.mic) refs.mic.disabled = !c.mic;
    paintMic();

    /* 「收起」= 本窗口内把这条藏起来（markHidden → display:none），并停掉正在听的。
       **不写回 app.json 的能力位**：收起是这一次看着碍事的临时动作，下次打开应用窗口按声明重新
       露面 —— 声明与界面不会变成两回事。要它回来：应用自己调 apSpeechReveal()、点左下角浮动
       话筒、按 F2，或重开窗口。 */
    if (refs.hide) {
      refs.hide.addEventListener("click", function () {
        hide();
      });
    }

    /* 话筒：点一下按三态循环（关闭 → 持续转录 → 按键转录 → 关闭） */
    refs.mic.addEventListener("click", function () {
      cycleMode();
    });
    /* AI 增强开关（话筒右侧那枚）：开关状态按应用持久化；桥缺席退内存态（本窗口内有效） */
    if (refs.enh) {
      refs.enh.addEventListener("click", function () {
        setEnhance(!enhOn);
      });
    }
    loadEnhance();
    if (c.events) {
      try {
        host.onSpeechState(function (st) {
          if (busy) return;
          say(phaseText(st), st && st.ok === false ? "warn" : "");
        });
      } catch (_) {}
    }

    /* 现况：每读一次就画一次 —— 先给「引擎正在启动」，冷起完成后自动变「就绪」 */
    var paint = function (st) {
      if (busy) return;
      say(phaseText(st), st && st.ok === false ? "warn" : "");
    };
    statusSettled(paint).then(paint);
    return true;
  }

  /* 快捷键：**窗口内 F2**（备选 Ctrl+Shift+D）是持续转录的开关 —— 条被「收起」或压根没露面时，
     按一下就把它请出来并开始听；正在听（任何一态）就停。只吞这一下按键
     （preventDefault + 捕获阶段 stopPropagation），页面自己绑的 F2 不再收到这一下；
     F2 无字符，输入框里按它也不会污染输入。
     按键转录态另加一条：**按住 F1 说话**（keydown 起录 / keyup 立刻交这一句），判键走 ev.code。 */
  function hookHotkey() {
    try {
      window.addEventListener(
        "keydown",
        function (ev) {
          /* PTT 键优先（只在按键转录态认它）：带 Ctrl/Alt/Meta 的组合键原样放行，不抢系统快捷键 */
          if (mode === MODE_PTT && pttIsKey(ev)) {
            if (ev.ctrlKey || ev.altKey || ev.metaKey) return;
            if (ev.preventDefault) ev.preventDefault();
            if (ev.stopPropagation) ev.stopPropagation();
            if (ev.repeat) return; /* 长按的系统重复：只吞键，不重复起停 */
            startPtt();
            return;
          }
          if (!isHotkey(ev)) return;
          if (!root && !zoneBtn) return; /* 这条 UI 没挂上（没声明 showDictate）：不劫持按键 */
          if (ev.preventDefault) ev.preventDefault();
          if (ev.stopPropagation) ev.stopPropagation();
          toggleLive();
        },
        true, /* 捕获阶段：先于页面自己的按键处理，吞掉后不再冒泡 */
      );
    } catch (_) {}
    /* 松开 F1 = 立刻把这一句交出去识别（不等静音门） */
    try {
      window.addEventListener(
        "keyup",
        function (ev) {
          if (mode !== MODE_PTT || !pttIsKey(ev)) return;
          if (ev.ctrlKey || ev.altKey || ev.metaKey) return; /* 与 keydown 同一口径 */
          if (ev.preventDefault) ev.preventDefault();
          if (ev.stopPropagation) ev.stopPropagation();
          if (pttOn) stopPtt("keyup");
        },
        true,
      );
    } catch (_) {}
    /* Esc：正在听（任何一态）就停（不关任何浮层；作者标签详情面板有自己的 Esc 处理） */
    try {
      window.addEventListener("keydown", function (ev) {
        if (!ev || ev.key !== "Escape") return;
        if (!listening && mode === MODE_OFF) return;
        setMode(MODE_OFF);
      });
    } catch (_) {}
    /* 窗口失焦（切走了）：松开键的 keyup 收不到，别让这一句一直按着 —— 先交出去再收手 */
    try {
      window.addEventListener("blur", function () {
        if (pttOn) stopPtt("blur");
      });
    } catch (_) {}
    /* 焦点落进某个输入框：**随时**记住它（这是落字的锚点），并把挂住没写进去的那几句补上。
       为什么要随时记（而不是等开始听再记）：用户总是先点进输入框打字，再点话筒 —— 点话筒
       那一下焦点已经跑到按钮上了，这时再读 activeElement 就什么也读不到。 */
    try {
      document.addEventListener(
        "focusin",
        function (ev) {
          if (!isWritable(ev && ev.target)) return;
          anchor = captureAnchor(ev.target);
          flushPendingInsert();
        },
        true,
      );
    } catch (_) {}
  }
  /** 本条自己的按钮不吃焦点：mousedown 上 preventDefault。
   *  否则点一下话筒，焦点就从用户正在写的输入框跑到按钮上 —— 落字判据（焦点还在那个框里）
   *  立刻不成立，这一段的字全被挂住，用户看到的就是「识别了却没写进去」。 */
  function noFocusSteal(el) {
    if (!el || !el.addEventListener) return;
    try {
      el.addEventListener("mousedown", function (ev) {
        if (ev && ev.preventDefault) ev.preventDefault();
      });
    } catch (_) {}
  }

  /* 宿主的收尾钩子：页面要关了就别让话筒一直开着（不依赖应用自己调） */
  try {
    window.addEventListener("pagehide", function () {
      if (listening) stopLive();
    });
    window.addEventListener("beforeunload", function () {
      if (listening) stopLive();
    });
  } catch (_) {}

  /* 宿主派发桥（注入脚本与 preload 分处两个世界时用这条）：DOM 就绪后自己挂上 */
  try {
    window.addEventListener("mtnode-apphost", function (ev) {
      try {
        apSpeechMount(ev && ev.detail ? ev.detail.host : null);
      } catch (_) {}
    });
  } catch (_) {}

  try {
    window.apSpeechMount = apSpeechMount;
    window.apSpeechLast = apSpeechLast;
    /* 未增强的原始识别全篇（AI 增强开着时，这里才是 ASR 的原话） */
    window.apSpeechRawLast = apSpeechRawLast;
    /* 落点自检（宿主 / 冒烟用）：placeStrip 重算一次落点，visibleNow 量「这条现在看得见吗」 */
    window.apSpeechPlace = placeStrip;
    window.apSpeechVisible = visibleNow;
    /* 可见性入口：注入进来即默认可见（能力位为真 = 用户要它）；hidden = 现在
       是不是隐藏态；reveal = 让它露面；hide = 收起它。两个方向都幂等，都只改本窗口的标记。 */
    window.apSpeechHidden = hiddenNow;
    window.apSpeechReveal = reveal;
    window.apSpeechHide = hide;
    /* 转录的对外入口：toggle = 持续转录的开 / 关（旧语义不变），live = 是否在采集，
       silence = 「说完一句」的停顿阈值（ms，不传 = 恢复默认），zone = 左下角那枚浮动话筒。 */
    window.apSpeechToggle = toggleLive;
    window.apSpeechLive = function () {
      return !!listening;
    };
    window.apSpeechSilenceMs = function (ms) {
      silenceOverride = Math.round(Number(ms) || 0);
      return silenceMs();
    };
    window.apSpeechZone = function () {
      return zoneBtn;
    };
    window.apSpeechHotkey = HOTKEY_KEY;
    window.apSpeechPttKey = PTT_KEY;
    /* 三态（本轮新增，与画布那枚话筒同源口径）：mode 问现状 / setMode 指定 / cycle 循环 */
    window.apSpeechMode = function () {
      return mode;
    };
    window.apSpeechSetMode = function (m) {
      return setMode(m);
    };
    window.apSpeechCycle = function () {
      return cycleMode();
    };
    /* 按键转录的鼠标路（浮动话筒按住）：起 / 交，给不方便按 F1 的场景用 */
    window.apSpeechPtt = function (on) {
      if (on === false) return stopPtt("api");
      return startPtt();
    };
    /* AI 增强开关：不传 = 只问现状；传布尔 = 开 / 关（会持久化） */
    window.apSpeechEnhance = function (on) {
      if (on === undefined) return !!enhOn;
      return setEnhance(on);
    };
    /* 自动落字开关（默认开）：应用自己监听 "mtnode-dictate" 又自己写一遍时，调它关掉免得写两遍 */
    window.apSpeechInsert = function (on) {
      if (on === undefined) return !!insertOn;
      insertOn = !!on;
      if (!insertOn) pendingInsert = "";
      return insertOn;
    };
    /* 挂住没写进去的文字（诊断 / 应用自己接管时用） */
    window.apSpeechPending = function () {
      return pendingInsert;
    };
    /* 落字锚点（自检用）：此刻锚在哪个框上 */
    window.apSpeechAnchor = function () {
      return anchor && anchor.el ? anchor.el : null;
    };
    /* AI 增强的清洗步骤（自检用）：模型输出 → 可交付正文；空串 = 不可用（交付回落原始识别） */
    window.apSpeechSane = enhSanitize;
  } catch (_) {}

  /* 自挂载（默认路径）：注入脚本在页面世界里跑，window.appHost 这时已经在了 —— 直接挂。
     极端时序下（页面脚本比本模块晚）再退避重试几次，最多 12 秒，绝不死循环。 */
  (function autoMount() {
    var tries = 0;
    var tick = function () {
      if (window.apSpeechMounted) return;
      var ok = false;
      try {
        ok = apSpeechMount();
      } catch (_) {}
      if (ok) {
        window.apSpeechMounted = true;
        hookHotkey();
        return;
      }
      if (tries++ < 40) setTimeout(tick, 300);
    };
    if (typeof document === "undefined") return;
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", tick, { once: true });
    else tick();
  })();
  /* 画布侧同名工具（encodeWav16kMono 等）不在这个窗口里，导出给宿主自检用 */
  try {
    window.apSpeechWav = encodeWav16kMono;
    /* 重采样（自检用）：任意采样率 → 16 kHz 单声道。旧稿缺这一步，交付的 WAV 被标成 16k
       却是设备原生率（48k）的样本，慢了 3 倍、识别出不来字 —— 这条口子钉住它。 */
    window.apSpeechResample16k = resampleTo16k;
  } catch (_) {}
})();
