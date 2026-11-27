/* ============================================================================
   MT 音频频谱分析（画布节点 kind = audio_spectrum）· 渲染层
   ----------------------------------------------------------------------------
   一句话：把一个音频 / 视频文件交给本机音频分析后端，拿回「拍点 / BPM / 小节 /
   onset / 能量包络」这类**底层可测**的结构化 JSON，并把热力图频谱画在节点上；频谱与波形
   播放器共用同一只播放引擎，播放时频谱上有一条跟着走的播放头。

   端子（与 app.js 的 IN_PORT_DATA_KINDS / outPortCount 同口径）：
     输入 0 = 音频（**单个端子**，任意本机路径 / file:/// URL；视频自动取其音轨）
     输出 0 = 分析结果（JSON，给 Agent / 下游节点读，自带 fieldGuide 字段字典）
     输出 1 = 频谱图（PNG 的本机绝对路径 · 图像值 · 接「保存图像」即落盘）
     输出 2 = 控制输出（分析完成后触发下游控制目标）

   为什么输出是「摘要 + fieldGuide」而不是一整份 body：
     契约里的 body 含 rmsNorm / rmsDb（>2 小时素材是 7 万个数）与逐条 onset 明细，
     整份塞进文本端子会把 Agent 的上下文吃光、画布也会卡。所以这里给的是**自描述摘要**：
     每个字段的一句话说明写在 fieldGuide 里（来自服务的 diagnostics.fieldGuide），
     逐拍 / 逐事件明细留在 fullJsonPath 指向的 analysis.json 里（要就读文件）。
     摘要按字符预算逐级裁剪（bars → onset 明细 → beatsSec 抽样），裁了什么写进
     truncated[]，绝不让「悄悄变短」发生。

   服务面（主进程 audio/main-audio.js）：端口 / key / 429 退避 / 504 重试全在宿主，
   这里只认 window.api 的 audioState / audioEnsure / audioAnalyze / onAudioProgress。

   板身（自上而下）：波形播放器（复用 app-audioview.js 的 wavePreviewCreate）→
   频谱图 + 播放头 → 一枚「查看分析报告」入口。摘要 / 输入提示 / ⚙ 参数摘要 /
   状态行都不在 body 里（用户口径：body 下方的文字全部移除）；报告本身在
   aaOpenReport 开的那只大窗 dialogue 里排版展示。
   事件是**叠在频谱图上**的一层（不是频谱上方另开一条带）：两条轨道各占一角、互不重叠 ——
   能量直方图（每小节一根柱 + 顶端亮度轮廓）压在底边重拍齿那一带之上，重拍齿贴底边。
   图例里每一项都能单独开关，右侧那颗「事件」是总开关
   （全关 / 全开），默认显示；数据取自输出 0 的摘要。播放头的呼吸由拍内相位连续驱动
   （每拍一次 0→1→0 的正弦，没跨拍也不会死平），跨过**重拍**时再额外变粗变色强调一下，
   用来核对节拍对不对。
   **不做段落 / 曲式命名**（前奏 / 主歌 / 副歌这类判断不准确）：只给拍点、小节、
   onset、能量相位这些能直接从信号里量出来的东西。
   ========================================================================== */

/* ============================================================================
   【成本账】这颗节点在画布上还剩哪些开销（静态核对代码得出 · 后续几条改动的唯一依据）
   ----------------------------------------------------------------------------
   先记「已经做过的」，避免重复分析、也避免把已解决的事再改一遍：
     · 收纳态（node.aaViewOpen !== true）不建波形播放器 / 热力图 img / 事件叠加 canvas /
       ResizeObserver —— 见下面 aaAppendBody 的早退分支，节点上零图像。
     · 播放头只有**一只全局 ticker**（aaHeadFrame）：静置时不再排 rAF，不按节点各起定时器。
     · 叠加层有绘制控制器 aaOverlayPainter：同一帧只画一次、整数尺寸真变才画、
       ResizeObserver 随节点脱离 DOM 自动 kill。
     · 画布上所有 <img> / <video> 的「视口外摘 src」已由 renderer/app-preview-lazy.js
       接管（IntersectionObserver，rootMargin ≈ 一屏；无 IO 的运行时它整个不接管）。

   剩下的三类开销 —— 下面每条待办各消掉一类：

   ① 展开态的「重内容」与**可见性完全脱钩**（真缺口 · 最大的一笔）
      aaAppendBody 只要 node.aaViewOpen 为 true 就无条件做全套：
        wavePreviewCreate + wavePreviewSetSource → app-audioview.js 的
        wavePreviewSetSource → waveLoadData → waveDecode：主进程 file:readAudio 读全文件
        字节 → new AudioContext + decodeAudioData **整段解码**（PCM 常驻内存：3 分钟
        立体声 44.1kHz ≈ 1600 万个采样 × 4 字节 ≈ 60MB Float32，解码那一刻还有一次 CPU
        峰值）→ 再线性扫一遍取 WAVE_BUCKETS = 900 桶峰值；
        同时建频谱 <img>（1024×384 位图 = 一块 GPU 纹理，只有渲染进程销毁才归还）、
        事件叠加 canvas 与其 ResizeObserver。
      这些**不看远近也不看缩略态**：节点在一屏之外、画布已经进入 lod-mini 缩略总览，
      照样全套照建。app-preview-lazy.js 只管 img/video 的 src，管不到解码与 canvas。
      → 已落地（本文件 aaVisGate / aaVisMount / aaVisUnmount）：一屏之内才挂重内容，离开一屏拆掉、回来自动重建（无 IntersectionObserver 的运行时「挂上即建」，功能不缺）。
      → 已落地（app-audioview.js 的全局 FIFO 队列 + wavePreviewSetSource 的 lazy 选项）：
         展开时只挂音源与外壳（时间 / 时长先出占位），峰值等「空闲」才取、一次只解一件，
         多颗节点同时展开不并发解码；点播放 / 点波形 / 点频谱把它提到队首。整段解码这笔
         CPU 与内存仍在，只是不再「一展开就付」，也不再乘上同时展开的节点数。

   ② 收纳态几何与绘制没收敛（每次重绘都在按面积光栅化）
      收纳态 body 只剩 3 个元素（折叠条 + .n-aa-pad + 报告入口），但 .n-aa-pad
      （css/components.css 的 .n-aa-pad）用 repeating-linear-gradient 45° 斜纹铺满整块
      图像区，而节点默认 380×380（app.js 的 KIND_DEFAULT.audio_spectrum h: 380；最小高
      minHFor(audio_spectrum) = 280）。#stage 带 transform + scale，那片斜纹是要按节点面积
      光栅化的纹理，一屏上叠几颗就是几块大面积重绘（拖动 / 缩放 / 拍总览图时最贵）。
      另：收纳态每次都 createElement 组 3 棵树，没有模板复用。
      → 已落地（css/components.css 的 .n-aa-pad 换成纯色底 + 原虚线框：那片要按节点面积
         光栅化的 45° 斜纹纹理没有了，占位照样一眼看出来是占位）。
      → 高度：点「收起」把高度收到 minHFor(audio_spectrum) = 280，把展开高度记在
         node.aaHOpen、展开时还回去（用户收起后又手拖改高则保留手拖值）。
      → 已落地（本文件 aaFoldBarNode / aaReportRow + aaFoldHeightCollapse / aaFoldHeightOpen）：
         折叠条与报告行各建一份 <template> 一次，之后每颗节点只 cloneNode(true) 一棵树，
         文案 / 类名 / 属性都在克隆件上原地改 —— 不再「按节点数 × 元素数」createElement；
         点「收起」只动本节点自己的 n.h（不碰 app.js 的 minHFor / clampNodeToMinSize / 手势
         resize，也不碰组布局函数）。
         评估结论：改高度**不会**在端子 / 连线 / 组框上造成回归 —— 手拖 resize 走的就是这条路
         （app.js 的 d.mode === "resize"：n.h → refreshPorts → updateGroupFrames → updateWires）。
         本次照同一条收尾做：refreshNodeEl 已含 refreshPorts + updateWires，另补一次
         updateGroupFrames（组框跟着成员贴合是既有行为）；只改 n.h 而不重排端子，连线才会错位。

   ③ lod-mini 缩略总览下内容照建
      app.js 的 syncNodeLod 在 z ≤ 0.25 时只给 #canvas 加一个 .lod-mini 类，
      css/canvas.css 那一族规则（缩略模式一节）把 .n-body 设成 visibility: hidden ——
      **DOM 一个都没少、解码一次都没省**（用 visibility 不用 display 是为了让 fitCanvas /
      自动排版在低缩放下仍量得到真矩形）。所以缩到总览时，展开态的节点依旧持有位图纹理、
      解码后的 PCM 与叠加层观察器。叠加层的绘制入口只判 canvas.hidden 与 0 尺寸，
      并不知道当前处于缩略总览。
      → 已落地（本文件 aaLodBind / aaLodDropHeavy / aaLodRestore）：syncNodeLod 切档时在
         document 上广播 mtnode:lod-mini（只在类名真的翻转时发一次）；进缩略总览 = 全部登记
         节点 aaStopLive + aaVisUnmount 拆掉重内容（折叠条 / 报告入口这些轻元素原样留着），
         回普通档不由本模块自己建，而是把占位重新 observe 一次交给 ① 的观察器重建。
      → 已落地（aaOverlayPainter 的 paintNow 早退）：canvas.hidden / 处于缩略总览时直接跳过，
         且**不再排下一帧** —— 原来 body 在 lod-mini 下尺寸照旧是真的，缓存判定永远命中，
         看着「没画」其实一直在排 rAF。

   ④ 运行期状态刷新不再查 DOM
      aaPaintStatus 原来每步都 document.querySelector 找节点、再遍历 .n-chip / .n-play /
      .n-aa-report —— 分析期间一秒数次回调 × N 颗节点，是现成的运行期热点。
      → 已落地（本文件 aaStatusRefs / aaStatusBindRow / aaStatusResolve）：报告行由
         aaReportRow 建它时把三只元素（button 本身 + .aa-rp-t + .aa-rp-go）直接登记进
         WeakMap(node → refs)；头部 chip「频谱」与 ▶ 在每次 DOM 换代后**只解析一次**
         （它们不归本模块建，且 appendBody 那一刻 body 还没进节点、够不到 .n-head，
         见 app-canvas.js nodeElement 的时序），之后状态回调只改 textContent / class /
         title / disabled。元素脱离文档（重绘 / 切画布 / body 换掉）即作废登记，下一次
         刷新解析一次再继续吃缓存。
         文案与状态口径仍是 aaReportRowState 唯一真源，这里不碰任何文案。
   ========================================================================== */
/* ============================================================================
   【三条不变量】上面【成本账】那几条把板身拆成了「轻壳 + 按需重内容」，所以有三条
   必须一直成立的东西 —— 以后动这块代码前先对着这三条读一遍，破了就是功能回归：
   ----------------------------------------------------------------------------
   ① 无 IO 退化：没有 IntersectionObserver 的运行时，功能一个都不少
      aaVisGate 拿不到观察器就**当场** aaVisMount（挂上即建）；aaLodRestore 同理直接建；
      aaLodMiniOn 读 #canvas 上的 .lod-mini 类作权威判定，事件漏发也不会判错档。
      也就是说「省成本」永远只是优化：任何宿主 / 冒烟桩里都还必须看得见波形与频谱。
      （观察器以窗口为根 + rootMargin ≈ 一屏，与 renderer/app-preview-lazy.js 同口径。）

   ② 播放中断保护：外壳要拆，声音必须先停；等效换代不许断播
      · 本模块自己拆的那一侧（aaVisUnmount 离开一屏 / aaLodDropHeavy 进缩略总览）：
        先 aaStopLive（播放头从全局 ticker 注销 + aaOverlayStop 收叠加层 ResizeObserver 与
        rAF），拆每个外壳前再判 wavePreviewPlayingOf(el) → waveStopPlayback(el) —— 只停
        「这一个真在播的」，别的节点不受影响；音频绝不能在 UI 已经没了之后继续响。
      · 收起（aaViewBar）只做 aaStopLive，随后 refreshNodeEl 走整画布重绘收尾：
        app-canvas.js 的 afterCanvasRender 会调 app-audioview.js 的 wavePreviewStopAll(false)，
        它只停「宿主外壳已经不在文档里」的那些 —— 收起 / 删节点 / 切画布都在这一条上收干净。
      · 不该停的那一侧（aaVisForget：body 等效换代）：本模块**不碰播放**，「重绘不断播」靠
        全局播放引擎复用（引擎挂在 body 上、与节点 DOM 无关，新外壳 waveEngineClaim 接过来
        接着放）；这也是那条 wavePreviewStopAll(false) 只收 detached 的原因 ——
        分界线只有「元素要不要离开文档」。

   ③ 收纳展开状态记忆：用户点过一次，就一直是那个状态
      node.aaViewOpen 只由折叠条上的点击翻转（aaNormalize 归一成布尔），重绘 / 重开画布都按它
      决定建不建重内容，绝不自己缩回去；展开高度记在 node.aaHOpen（收起时写入、展开时还给
      n.h；收起后又手拖改高则保留手拖值）。这两个都是**节点数据**，不进 WeakMap、不进
      模块级状态 —— 换一份运行时也照样读得回来。

   【口径免责】本轮的占用下降依据是**成本路径消除**（【成本账】① ~ ④ 一条条对应的解码 /
   位图纹理 / 按面积光栅化 / 每帧 rAF / 每次回调的选择器解析），**未做帧率与内存实测**：
   没跑 docs/audio-spectrum-perf-baseline.md 第 E 节那套 bench 复测，也没量堆内存与 GPU 纹理
   占用。要数字就按第 E 节用同一套脚本与参数复测，再与噪音底表逐列比。
   ========================================================================== */
(function () {
  "use strict";

  const T = (s) => (typeof I18n !== "undefined" && I18n.t ? I18n.t(s) : s);
  const KIND = "audio_spectrum";

  /* 可视化图种类：默认出频谱（板身要用的就是它）+ 拍点叠加（验收网格用） */
  const VIZ_ALL = [
    ["spectrogram", "频谱图（热力图 · 板身显示的就是它）"],
    ["beatOverlay", "拍点叠加图（竖线压在拍上 · 验收网格用）"],
    ["waveform", "波形图"],
    ["energyCurve", "能量曲线（看能量起伏）"],
  ];
  const VIZ_DEFAULT = ["spectrogram", "beatOverlay"];
  const CACHE_MODES = [
    ["auto", "auto（命中缓存直接用）"],
    ["refresh", "refresh（强制重算）"],
    ["bypass", "bypass（只算不写缓存）"],
  ];

  /* 摘要的字符预算：Agent 侧工具回执上限 40000 字，这里留出余量 */
  const DIGEST_BUDGET = 32000;

  /* ── 字段归一 ─────────────────────────────────────────────────────────── */

  function aaNormalize(node) {
    if (!node) return;
    node.aaDetail = node.aaDetail === true;
    const lim = Number(node.aaOnsetsLimit);
    node.aaOnsetsLimit = isFinite(lim) && lim > 0 ? Math.max(50, Math.min(20000, Math.round(lim))) : 2000;
    const kinds = Array.isArray(node.aaVizKinds)
      ? node.aaVizKinds.filter((k) => VIZ_ALL.some((v) => v[0] === k))
      : [];
    node.aaVizKinds = kinds.length ? kinds : VIZ_DEFAULT.slice();
    node.aaLoudness = node.aaLoudness === true;
    const cm = String(node.aaCache || "");
    node.aaCache = cm === "refresh" || cm === "bypass" ? cm : "auto";
    /* 字段字典的详略：compact（默认 · 只给摘要里真出现的字段）/ full（服务端全量 186 条）/ off */
    const gm = String(node.aaGuide || "");
    node.aaGuide = gm === "full" || gm === "off" ? gm : "compact";
    if (typeof node.aaStatus !== "string") node.aaStatus = "";
    if (typeof node.aaSpectrogram !== "string") node.aaSpectrogram = "";
    if (typeof node.aaOverlay !== "string") node.aaOverlay = "";
    if (typeof node.aaJsonPath !== "string") node.aaJsonPath = "";
    const d = Number(node.aaDurationSec);
    node.aaDurationSec = isFinite(d) && d > 0 ? d : 0;
    /* 板身图像区（波形播放器 + 热力图 + 事件叠加层）的收纳状态：默认**收起**
       （用户口径：默认不画图像，免得一屏几颗频谱节点就为解码位图卡住）。
       展开后记在节点上，重绘 / 重开画布都维持展开。 */
    node.aaViewOpen = node.aaViewOpen === true;
    /* 频谱上那层事件：总开关（aaShowEvents）+ 每一层各自的开关（aaEvOn）。
       用户口径：每种 legend 都能单独选显示 / 不显示；缺键按「显示」，旧节点直接兼容 */
    node.aaShowEvents = node.aaShowEvents !== false;
    node.aaEvOn = aaEvOnOf(node);
    /* 卡点参数按哪个帧率换算（24/25/30/50/60）：做闪拍 / 逐帧工程时用得上 */
    const fps = Number(node.aaVideoFps);
    node.aaVideoFps = [24, 25, 30, 50, 60].indexOf(fps) >= 0 ? fps : 30;
    /* 视觉偏移（毫秒）：剪辑台 / 编码链常常比音频晚一两帧，把帧号整体挪一点来对齐。
       默认 0（不动），只影响帧号与报告，不改分析结果。钳在 ±2000 ms。 */
    const off = Number(node.aaVisualOffsetMs);
    node.aaVisualOffsetMs = isFinite(off) ? Math.max(-2000, Math.min(2000, Math.round(off))) : 0;
    if (!node.aaSummary || typeof node.aaSummary !== "object") node.aaSummary = null;
  }

  /** 发给服务的 options（键与 service-contract §5.1 同一张表） */
  function aaOptionsOf(node) {
    aaNormalize(node);
    return {
      detail: !!node.aaDetail,
      onsetsLimit: node.aaOnsetsLimit,
      viz: { enabled: true, kinds: node.aaVizKinds.slice() },
      loudness: !!node.aaLoudness,
      cache: node.aaCache,
    };
  }

  /* ── 输入取值（单个端子：音频或视频）──────────────────────────────────── */

  function aaToPath(raw) {
    let s = String(raw == null ? "" : raw).trim();
    if (!s || /\n/.test(s)) return "";
    if (/^file:\/\//i.test(s)) {
      s =
        typeof fileUrlToPath === "function"
          ? String(fileUrlToPath(s) || "")
          : s.replace(/^file:\/\//i, "");
    }
    return s.trim();
  }

  /** 端口 0 的本机路径。取值口径复用 app-ds-speech 的 audioPath（输入节点自带文件 /
     上游生成产物 / 保存节点 / 音频·视频 URL 都认），模块没加载时退化为直读线值。 */
  function aaInputPath(node) {
    if (!node || !node.id) return "";
    try {
      if (window.DsSpeech && typeof window.DsSpeech.audioPath === "function") {
        const p = aaToPath(window.DsSpeech.audioPath(node, 0));
        if (p) return p;
      }
    } catch (_) {}
    try {
      const w = typeof wiresTo === "function" ? wiresTo(node.id).find((x) => Number(x.toIndex) === 0) : null;
      if (!w) return "";
      const vals = typeof inputValuesFor === "function" ? inputValuesFor(node, 0) || [] : [];
      for (const it of vals) {
        const v = it && it.value;
        const p = aaToPath((v && (v.path || v.url || v.text)) || (typeof v === "string" ? v : ""));
        if (p) return p;
      }
      const src = typeof nodeById === "function" ? nodeById(w.from) : null;
      if (src && typeof displayValueOf === "function") {
        const d = displayValueOf(src, node);
        const p = aaToPath((d && (d.path || d.text)) || "");
        if (p) return p;
      }
    } catch (_) {}
    return "";
  }

  /** 端口 0 接的是什么（板身提示用）：视频会说明「取其音轨」 */  function aaInputHint(node) {
    const p = aaInputPath(node);
    if (!p) return T("端口 0：等待接入音频或视频（单个端子）");
    const name = p.split(/[\\/]/).pop() || p;
    const isVideo = /\.(mp4|mkv|mov|avi|webm|flv|wmv|m4v|ts)$/i.test(p);
    return (isVideo ? T("视频（只取音轨）：") : T("音频：")) + name;
  }

  /* ── 结果 → 摘要（给 Agent 的自描述 JSON）──────────────────────────────── */

  /** 数字保留几位（省 token；测不到的给 null，别给 0 冒充） */
  function aaRound(v, digits) {
    const n = Number(v);
    if (!isFinite(n)) return null;
    const f = Math.pow(10, digits == null ? 3 : digits);
    return Math.round(n * f) / f;
  }
  function aaRoundList(list, digits) {
    if (!Array.isArray(list)) return [];
    return list.map((v) => aaRound(v, digits));
  }

  /** 小节表归一：服务端是对象 {startSec,endSec,beatCountInBar,rmsDb,lowDb,energy01}，
      摘要里是数组（4 元 = 无低频 / 5 元 = 带低频 / 6 元 = 带感知能量，旧摘要也是 5 元）——
      三种都认，统一成对象再给报告与频谱上的直方图用，免得"摘要一变形状报告就空白"。 */
  function aaBarsOf(raw) {
    const out = [];
    for (const b of Array.isArray(raw) ? raw : []) {
      if (!b) continue;
      const arr = Array.isArray(b);
      const startSec = Number(arr ? b[0] : b.startSec);
      const endSec = Number(arr ? b[1] : b.endSec);
      const beatCountInBar = Number(arr ? b[2] : b.beatCountInBar) || 0;
      const rmsDb = Number(arr ? b[3] : b.rmsDb);
      const lowDb = arr ? Number(b[4]) : Number(b.lowDb);
      const energy01 = arr ? Number(b[5]) : Number(b.energy01);
      if (!isFinite(startSec) || !isFinite(rmsDb)) continue;
      out.push({
        startSec,
        endSec: isFinite(endSec) ? endSec : startSec,
        beatCountInBar,
        rmsDb,
        lowDb: isFinite(lowDb) ? lowDb : null,
        energy01: isFinite(energy01) ? energy01 : null,
      });
    }
    return out;
  }

  /** 参数表里与段落判断相关的键全部摘掉（节点不再暴露段落算法） */
  function aaParamsClean(raw) {
    const src = raw && typeof raw === "object" ? raw : {};
    const out = {};
    for (const k of Object.keys(src)) {
      if (/^sections?$|sectionsMethod|snapToDownbeat/i.test(k)) continue;
      out[k] = src[k];
    }
    return out;
  }
  /** 阶段耗时里的 sections 一档也摘掉（段落不再计算到节点可见的层） */
  function aaTimingClean(raw) {
    const src = raw && typeof raw === "object" ? raw : {};
    const out = {};
    for (const k of Object.keys(src)) {
      if (/^sections?$/i.test(k)) continue;
      out[k] = src[k];
    }
    return out;
  }

  /** 从事件表里挑「最强的前 n 条」，挑完再按时间排（图上与报告都要时间顺序）。 */
  function aaTopEvents(events, n) {
    const list = (Array.isArray(events) ? events : []).filter((e) => e && isFinite(Number(e.t)));
    const ranked = list.slice().sort((a, b) => (Number(b.strength) || 0) - (Number(a.strength) || 0));
    return ranked.slice(0, Math.max(0, n)).sort((a, b) => Number(a.t) - Number(b.t));
  }

  function aaVisualPathOf(body, kind) {
    const list = (body && body.visuals) || [];
    const hit = list.find((v) => v && v.kind === kind);
    return hit && hit.path ? String(hit.path) : "";
  }

  function aaSummaryOf(body) {
    const g = (body && body.global) || {};
    const bg = (body && body.beatGrid) || {};
    const meta = (body && body.meta) || {};
    const diag = (body && body.diagnostics) || {};
    return {
      durationSec: Number(meta.durationSec) || 0,
      bpm: Number(g.bpm) || 0,
      bpmConfidence: Number(g.bpmConfidence) || 0,
      tempoVerified: !!g.tempoVerified,
      beatCount: Number(bg.beatCount) || 0,
      gridConfidence: Number(bg.gridConfidence) || 0,
      downbeatCount: Array.isArray(bg.downbeatsSec) ? bg.downbeatsSec.length : 0,
      barCount: Array.isArray(bg.bars) ? bg.bars.length : 0,
      warnings: ((diag.warnings || []).map((w) => (w && w.code) || "").filter(Boolean)),
    };
  }

  /** 一行摘要（板身 / toast 用） */
  function aaSummaryLineText(sm) {
    if (!sm) return T("（还没有分析结果）");
    const bits = [];
    if (sm.durationSec) bits.push(sm.durationSec.toFixed(1) + T(" 秒"));
    if (sm.bpm) bits.push(sm.bpm.toFixed(1) + " BPM" + (sm.tempoVerified ? "" : T("（未交叉验证）")));
    if (sm.beatCount) bits.push(sm.beatCount + T(" 拍"));
    bits.push(T("网格可信度 ") + Math.round((sm.gridConfidence || 0) * 100) + "%");
    if (sm.barCount) bits.push(sm.barCount + T(" 小节"));
    if (sm.warnings.length) bits.push(T("警告 ") + sm.warnings.length);
    return bits.join(" · ");
  }

  /**
   * 组装给 Agent 的摘要对象。   * 原则：**每个字段都在 fieldGuide 里有一句话**；逐拍 / 逐事件留源头文件；
   * energy 的 rmsNorm / rmsDb 一律不带（那是给程序读的，给模型读只会烧 token）。
   */
  function aaDigest(body, fullJsonPath, guideMode, fpsHint, offsetHint) {
    const b = body || {};
    const meta = b.meta || {};
    const ctr = b.contract || {};
    const g = b.global || {};
    const bg = b.beatGrid || {};
    const on = b.onsets || {};
    const en = b.energy || {};
    const diag = b.diagnostics || {};
    const vis = Array.isArray(b.visuals) ? b.visuals : [];
    const edit = b.edit || {};
    const events = Array.isArray(on.events) ? on.events : [];
    /* 帧号唯一口径（与报告 / 卡点参数同一份实现）：summary 里所有 frame 字段都走它，
       禁止逐拍累加 —— 一拍常常不是整帧，累加会越到后面越偏。 */
    const frameOf = aaFrameOf(fpsHint, offsetHint);

    const digest = {
      schema: "mtnode.audio.analysis/1",
      about:
        "MT 音频频谱分析（audio_spectrum）的输出。时间字段一律「秒」，原点 = 解码后第 0 个采样点；" +
        "字段含义见 fieldGuide（键 = 字段路径）。卡点只读 beatGrid.beatsSec / downbeatsSec，" +
        "不要用 bpm 乘出时间轴（会漂）。",
      contract: {
        name: ctr.name || "mtnode.audio.analyze",
        version: ctr.version || "",
        timeBase: {
          origin: (ctr.timeBase && ctr.timeBase.origin) || "media_start",
          unit: (ctr.timeBase && ctr.timeBase.unit) || "s",
        },
        frameGrid: ctr.frameGrid || {},
      },
      source: {
        path: (meta.source && meta.source.path) || "",
        container: (meta.source && meta.source.container) || "",
        bytes: Number(meta.source && meta.source.bytes) || 0,
        durationSec: Number(meta.durationSec) || 0,
        sampleRateHz: Number(meta.sampleRateHz) || 0,
        sourceSampleRateHz: Number(meta.sourceSampleRateHz) || 0,
        analyzedAt: meta.analyzedAt || "",
        decoder: meta.decoder || null,
      },
      global: {
        bpm: Number(g.bpm) || 0,
        bpmConfidence: Number(g.bpmConfidence) || 0,
        beatPeriodSec: Number(g.beatPeriodSec) || 0,
        tempoVerified: !!g.tempoVerified,
        bpmCandidates: g.bpmCandidates || [],
        timeSignature: g.timeSignature || null,
        downbeatPhase: g.downbeatPhase != null ? g.downbeatPhase : null,
        key: g.key || null,
      },
      beatGrid: {
        beatCount: Number(bg.beatCount) || 0,
        firstBeatSec: Number(bg.firstBeatSec) || 0,
        gridConfidence: Number(bg.gridConfidence) || 0,
        gridCalibrationMs: Number(bg.gridCalibrationMs) || 0,
        downbeatMethod: bg.downbeatMethod || "none",
        downbeatsSec: aaRoundList(bg.downbeatsSec, 4),
        /* 小节给「起止 / 拍数 / RMS」：都是直接量出来的底层量，也是频谱上能量直方图的数据源。
           低频电平（lowDb）与逐拍落格在 fullJsonPath 里 —— 摘要要留出预算给直方图与击点，
           不能为了低频把它挤没（旧版把 bars 排第一裁剪，结果直方图整层消失） */
        bars: aaBarsOf(bg.bars).slice(0, 600).map((x) => [
          aaRound(x.startSec, 2),
          aaRound(x.endSec, 2),
          Number(x.beatCountInBar) || 0,
          aaRound(x.rmsDb, 1),
          aaRound(x.lowDb, 0),
          x.energy01 == null ? null : aaRound(x.energy01, 3),
        ]),
        barsNote: "每条 = [startSec, endSec, beatCount, rmsDb, lowDb, energy01]；lowDb = 该小节低频电平（dBFS，整数），与 rmsDb 的差即低频占比；energy01 = 感知能量 0-1（近似 K 加权 + p5–p95 稳健归一，旧报告为 null）",
        beatsSec: aaRoundList(bg.beatsSec, 4),
      },
      onsets: {
        count: Number(on.count) || 0,
        ratePerSec: Number(on.ratePerSec) || 0,
        truncated: !!on.truncated,
        limit: Number(on.limit) || 0,
        /* 摘要里只给「最值得卡的」60 条，且只带 t / 强度 / 鼓型 / 网格位：
           三带能量（bands）与偏差只在 detail=true 或 fullJsonPath 里（那是给程序读的）。
           **按强度挑、挑完再按时间排**：旧版直接 slice(0,60) 是"按时间的前 60 条"，
           长素材上强度最高的那几条就只出现在开头十几秒（用户实测报的正是这个）。 */
        events: aaTopEvents(events, 60).map((e) => ({
          t: aaRound(e && e.t, 4),
          strength: aaRound(e && e.strength, 3),
          drum: (e && e.drum) || "",
          snap: (e && e.snap) || "",
        })),
        eventsOmitted: Math.max(0, events.length - 60),
        eventsNote: "按强度取前 60 条、再按时间排序；bands / step16 / offsetMs / hardStop / riser 在 fullJsonPath",
      },
      energy: {
        hopSec: Number(en.hopSec) || 0.1,
        points: Number(en.points) || 0,
        globalDb: en.globalDb || null,
        /* 相位只留段界（label / 起 / 止）：character 与六带比例在完整 JSON 里，摘要不重复占预算 */
        phases: (Array.isArray(en.phases) ? en.phases : []).map((p) => ({
          label: (p && p.label) || "",
          startSec: aaRound(p && p.startSec, 2),
          endSec: aaRound(p && p.endSec, 2),
        })),
        note: "rmsNorm / rmsDb 逐 0.1 秒数组不在摘要里（给程序读，别进上下文）；需要就打开 fullJsonPath。",
      },
      visuals: vis.map((v) => ({
        kind: v.kind,
        path: v.path,
        widthPx: v.widthPx,
        heightPx: v.heightPx,
        bytes: v.bytes,
      })),
      edit: (() => {
        /* 段落判断已移除：section 派生的切点（snap = section）与段落进入强调点
           （kind = sectionEntry / drop）不再出现在摘要里 —— 那是不可靠的曲式判断，
           留下的只有拍点 / 重拍 / onset / 硬停顿这些能量出来的东西 */
        const cps = (Array.isArray(edit.cutPoints) ? edit.cutPoints : []).filter((x) => (x && x.snap) !== "section");
        const accs = (Array.isArray(edit.accents) ? edit.accents : []).filter(
          (a) => a && a.kind !== "sectionEntry" && a.kind !== "drop",
        );
        return {
          /* 切点：前置 120 条足够覆盖「前几分钟怎么剪」，完整表在 fullJsonPath。
             形状压成 {t, snap, strength, frame}（reason 只有中文短语，按需去完整表看）；
             frame 是实际触发帧 = round((t + 视觉偏移) × fps) */
          cutPoints: cps.slice(0, 120).map((x) => ({
            t: aaRound(x && x.t, 3),
            frame: frameOf(x && x.t),
            snap: (x && x.snap) || "",
            strength: aaRound(x && x.strength, 2),
          })),
          cutPointsOmitted: Math.max(0, cps.length - 120),
          accents: accs.slice(0, 40),
          shotDurationTiers: edit.shotDurationTiers || [],
        };
      })(),
      /* 做卡点闪拍时真正要写进时间线的数：拍长 / 小节长 / 一拍几帧 / 闪几帧 / 整帧对齐的漂移。
         一拍常常不是整帧（128 BPM @30fps = 14.06 帧），所以秒与帧都给，别让下游自己乘。 */
      video: (() => {
        const fps = frameOf.fps;
        const bpm = Number(g.bpm) || 0;
        const beatSec = bpm > 0 ? 60 / bpm : Number(g.beatPeriodSec) || 0;
        const beatsPerBar = (g.timeSignature && Number(g.timeSignature.numerator)) || 4;
        const barSec = beatSec * beatsPerBar;
        const fpb = beatSec * fps;
        const dnb = Array.isArray(bg.downbeatsSec) ? bg.downbeatsSec.filter((t) => isFinite(Number(t))) : [];
        /* 相邻切点挨得太近（<4 帧）时，@当前帧率下两个切点几乎在同一帧：提前告警。
           与 edit.cutPoints 同一口径（段落派生的切点不算），只看摘要里带出去的那批 */
        const cpFrames = (Array.isArray(edit.cutPoints) ? edit.cutPoints : [])
          .filter((x) => (x && x.snap) !== "section")
          .map((x) => frameOf(x && x.t))
          .sort((a, b) => a - b);
        let tooClose = 0;
        for (let i = 1; i < cpFrames.length; i++) if (cpFrames[i] - cpFrames[i - 1] < AA_MIN_CUT_GAP_FRAMES) tooClose++;
        return {
          fps: fps,
          visualOffsetMs: frameOf.offsetMs,
          frameOf: "round((t + visualOffsetMs/1000) × fps)",
          beatSec: aaRound(beatSec, 4),
          barSec: aaRound(barSec, 4),
          beatsPerBar: beatsPerBar,
          framesPerBeat: aaRound(fpb, 2),
          framesPerBar: aaRound(fpb * beatsPerBar, 2),
          flashFrames: Math.max(2, Math.min(6, Math.round(fpb * 0.2) || 2)),
          frameDriftMsPerBeat: aaRound((fpb - Math.round(fpb)) * (1000 / fps), 2),
          downbeatCount: dnb.length,
          downbeatFrames: dnb.slice(0, 24).map((t) => frameOf(t)),
          firstBeatSec: Number(bg.firstBeatSec) || 0,
          minCutGapFrames: AA_MIN_CUT_GAP_FRAMES,
          cutPointsTooClose: tooClose,
          note: "卡点闪拍照这里排：拍长给秒级时间线，帧数给逐帧工程，flashFrames 是建议的闪白长度（≈1/5 拍）；frameDriftMsPerBeat ≠ 0 说明一拍不是整帧，帧号一律用 frameOf(t)=round((t+visualOffsetMs/1000)*fps) 逐点算、别用「每拍 +N 帧」累加。cutPointsTooClose > 0 = 有相邻切点间隔不足 4 帧，改 60 fps 再排。",
        };
      })(),
      diagnostics: {
        warnings: diag.warnings || [],
        method: diag.method || "",
        caveat: diag.caveat || "",
        parameters: aaParamsClean(diag.parameters),
        timingsMs: aaTimingClean(diag.timingsMs),
        cache: diag.cache || null,
      },
      summary: aaSummaryOf(b),
      fullJsonPath: fullJsonPath || "",
    };
    /* 字段字典放在**摘要建好之后**再按模式过滤：只留「这份摘要里真出现的字段」，
       这样 Agent 读到的每条说明都对得上是眼前的数据，也不会为了 186 条字典烧掉几千 token */
    digest.fieldGuide = aaGuideFor(digest, Object.assign({}, AA_LOCAL_GUIDE, diag.fieldGuide || {}), guideMode);
    return digest;
  }

  /* 渲染层自己加的那几个字段（帧号 / 视觉偏移 / 快切告警）服务端不认识，字典在这里补齐：
     精简档按「摘要里真出现」过滤时它们照样有说明 */
  const AA_LOCAL_GUIDE = {
    "video.visualOffsetMs": "视觉偏移（毫秒，默认 0）：帧号统一按 round((t + 视觉偏移/1000) × fps) 算，用来对齐剪辑台 / 编码链的延迟。",
    "video.frameOf": "帧号的唯一算法（与报告同一份实现）：round((t + visualOffsetMs/1000) × fps)。",
    "video.downbeatFrames": "前 24 个重拍的实际触发帧号（同一份 frameOf 逐点算出来的，不是逐拍累加）。",
    "video.minCutGapFrames": "相邻切点最小帧间隔阈值（默认 4 帧）：低于它两个切点几乎同帧，闪拍 / 转场来不及显示。",
    "video.cutPointsTooClose": "相邻切点间隔 <4 帧的处数；>0 时建议把帧率改到 60 fps 再排，或把切点拉开。",
    "edit.cutPoints[].frame": "该切点的实际触发帧 = round((t + visualOffsetMs/1000) × fps)。",
  };

  /* fieldGuide 的详略控制：compact（默认 · 只给摘要里真出现的键）· full · off */
  function aaKeyExists(obj, keyPath) {
    const parts = String(keyPath || "").replace(/\[\]/g, "").split(".").filter(Boolean);
    let cur = obj;
    for (const raw of parts) {
      if (cur == null || typeof cur !== "object") return false;
      const p = raw.split("[")[0];
      if (!Object.prototype.hasOwnProperty.call(cur, p)) return false;
      cur = cur[p];
    }
    return true;
  }
  function aaGuideFor(digest, guide, mode) {
    const all = guide && typeof guide === "object" ? guide : {};
    const m = mode === "full" || mode === "off" ? mode : "compact";
    if (m === "off") return { note: "字段字典已关闭（节点 ⚙ → 字段字典 可打开）；字段含义按 docs/audio-analysis/analyze-contract.md 理解。" };
    if (m === "full") {
      /* 完整档也不带 sections*：节点不暴露段落判断，给了说明也没有对应数据 */
      const out = {};
      for (const k of Object.keys(all)) {
        if (/^sections(\[\])?($|\.)/.test(k)) continue;
        out[k] = all[k];
      }
      return out;
    }
    const out = {};
    let n = 0;
    for (const k of Object.keys(all)) {
      if (!aaKeyExists(digest, k)) continue;
      out[k] = all[k];
      if (++n >= 90) break;
    }
    if (!n) {
      /* 摘要字段名与服务端口径完全对不上时（契约改名）别给空字典：退回前 20 条 + 一句提示 */
      for (const k of Object.keys(all).slice(0, 20)) out[k] = all[k];
      out.__note = "字段字典已按摘要过滤，命中 0 条（可能是契约升级）：这里给前 20 条，完整见完整 JSON。";
    }
    return out;
  }

  /** 把摘要序列化成文本，并按预算逐级裁剪（裁了什么写进 truncated[]）。
      **裁剪顺序就是优先级**：重音 → 切点 → 拍表抽样 → 击点减半 → 小节抽样。
      小节（能量直方图）是频谱上要看的东西，绝不整段清空 ——
      旧版第一步就把 beatGrid.bars 清成空数组，频谱上的直方图整层消失，正是用户实测报的问题。 */
  function aaDigestText(digest) {
    const d = JSON.parse(JSON.stringify(digest || {}));
    const truncated = [];
    let text = JSON.stringify(d);
    const trim = [
      () => {
        const a = d.edit && d.edit.accents;
        if (!Array.isArray(a) || a.length <= 8) return false;
        d.edit.accentsOmitted = (d.edit.accentsOmitted || 0) + (a.length - 8);
        d.edit.accents = a.slice(0, 8);
        truncated.push("edit.accents(前 8)");
        return true;
      },
      () => {
        const c = d.edit && d.edit.cutPoints;
        if (!Array.isArray(c) || c.length <= 60) return false;
        d.edit.cutPointsOmitted = (d.edit.cutPointsOmitted || 0) + (c.length - 60);
        d.edit.cutPoints = c.slice(0, 60);
        truncated.push("edit.cutPoints(前 60)");
        return true;
      },
      () => {
        const beats = d.beatGrid && d.beatGrid.beatsSec;
        if (!Array.isArray(beats) || beats.length <= 480) return false;
        /* 等间隔抽样：卡点要的是「有哪些拍」，抽样后仍保留真实拍位（不重算、不外推） */
        const step = Math.ceil(beats.length / 480);
        const kept = beats.filter((_, i) => i % step === 0);
        d.beatGrid.beatsSec = kept;
        d.beatGrid.beatsTruncated = { kept: kept.length, total: beats.length, step: step };
        truncated.push("beatGrid.beatsSec(每 " + step + " 拍取 1)");
        return true;
      },
      () => {
        const ev = d.onsets && d.onsets.events;
        if (!Array.isArray(ev) || ev.length <= 24) return false;
        const keep = aaTopEvents(ev, 24);
        d.onsets.eventsOmitted = (d.onsets.eventsOmitted || 0) + (ev.length - keep.length);
        d.onsets.events = keep;
        d.onsets.eventsNote = "按强度取前 24 条、再按时间排序（摘要预算不足时减半）；完整明细在 fullJsonPath";
        truncated.push("onsets.events(按强度留 24)");
        return true;
      },
      () => {
        const bars = d.beatGrid && d.beatGrid.bars;
        if (!Array.isArray(bars) || bars.length <= 120) return false;
        /* 直方图可以降分辨率（每 2 小节一根），但不能整层清空 */
        const step = Math.ceil(bars.length / 600);
        const kept = bars.filter((_, i) => i % step === 0);
        d.beatGrid.bars = kept;
        d.beatGrid.barsNote = "小节按每 " + step + " 根抽稀（直方图仍按时间轴铺满）；明细见 fullJsonPath";
        truncated.push("beatGrid.bars(每 " + step + " 根取 1)");
        return true;
      },
    ];
    let guard = 0;
    for (const step of trim) {
      if (text.length <= DIGEST_BUDGET) break;
      if (guard++ > 12) break;
      const did = step();
      text = JSON.stringify(d);
      if (!did && text.length > DIGEST_BUDGET) continue;
    }
    if (truncated.length) {
      d.truncated = truncated;
      d.truncatedNote = "摘要按长度预算裁剪过；完整明细见 fullJsonPath";
      text = JSON.stringify(d);
    }
    return text;
  }

  /* ── 状态 / 重绘 ───────────────────────────────────────────────────────
     两件事必须分开：
       · **纯文本变化**（准备后端进度 / 状态 / 跑起来没有 / 失败原因）→ aaStatus 就地改元素；
       · **结构真变**（首次拿到结果：频谱 img 从无到有；图种变化；跑完 / 失败）→ aaRepaint 重建。
     以前每次进度回调都走 aaRepaint → refreshNodeEl → replaceWith 整颗 DOM：波形播放器、
     叠加 canvas、频谱 img、ResizeObserver 全部销毁重建（分析期间正在放的音乐被打断，
     进度一多就是连续的 DOM 重建）。 */

  /** 写状态文本 + 就地刷新落点（不重建节点） */
  function aaStatus(node, msg) {
    if (!node) return;
    node.aaStatus = String(msg || "");
    aaPaintStatus(node);
  }

  /* 状态文本的落点：body 下方那条状态行已按用户口径移除，现在真正承载状态的只有三处
     **已存在的**元素（不新加任何文字块）：
       ① 头部 chip「频谱」：运行中亮起，title = 状态 / 进度 / 失败原因；
       ② 头部 ▶：运行中变「…」且禁用，失败变红（与 app-canvas.js 里那份口径一致）；
       ③ body 里那枚「分析报告」入口 —— body 现在唯一的一行文字：没有结果时它的位置
          就显示进度，失败时显示「上次运行失败」（原因在 title 与报告窗里）。
     进度回调一秒可能来好几次，这里只改 textContent / class / title / disabled。

     **落点登记（成本账 ④）**：node → { el, chip, play, row, txt, go }。
     WeakMap 而不是挂到 node 上：节点被回收就自动消失，不往会落盘的数据里塞 DOM 引用。
        · 报告行（.n-aa-report / .aa-rp-t / .aa-rp-go）在 aaReportRow 建它时登记 ——
          元素引用当场就在手上，一个选择器都不用；
        · 头部 chip「频谱」与 ▶ 不归本模块建（app-canvas.js 的 head 装配），而且
          nodeElement 是**先**建 head、**再** buildBody(node, body)、**最后**才
          el.appendChild(body)，所以 appendBody 那一刻 body 还没进节点、够不到 .n-head
          （同一时序见 app-canvas.js 滚轮路由那段注释）。它们走 aaStatusResolve：每次
          DOM 换代后只解析一次，之后一秒数次的进度回调都只碰缓存下来的引用。 */
  const aaStatusRefs = new WeakMap();

  function aaStatusRefsOf(node) {
    let r = aaStatusRefs.get(node);
    if (!r) {
      r = { el: null, chip: null, play: null, row: null, txt: null, go: null };
      aaStatusRefs.set(node, r);
    }
    return r;
  }

  /** body 换掉（重绘 / 收起 / 重开画布）时清登记：旧那几只元素已经不在文档里了 */
  function aaStatusForget(node) {
    if (node) aaStatusRefs.delete(node);
  }

  /** 报告行登记：建它就登记（文案 span / › span 的引用当场都在手上） */
  function aaStatusBindRow(node, btn, txt, go) {
    if (!node || !btn) return;
    const r = aaStatusRefsOf(node);
    r.row = btn;
    r.txt = txt || null;
    r.go = go || null;
  }

  /** 解析节点元素与头部 chip / ▶（只有 DOM 换代之后才走这里，不是热路径） */
  function aaStatusResolve(node, r) {
    let el = null;
    try {
      el = document.querySelector('.wf-node[data-nid="' + node.id + '"]');
    } catch (_) {
      return false;
    }
    /* 没渲染出来（壳里收起 / 不在当前画布）：数据已写进 node，下一次重建自然带上 */
    if (!el) {
      r.el = r.chip = r.play = r.row = r.txt = r.go = null;
      return false;
    }
    r.el = el;
    r.chip = null;
    r.play = null;
    const head = el.querySelector(".n-head");
    if (head) {
      /* 头栏里同类的徽标 / 按钮还有别的用途，仍按建时的文案认（chip = 「频谱」，
         ▶ = 空闲的 ▶ 或运行中的 …）—— 这条口径只在换代时跑一次。 */
      for (const c of head.querySelectorAll(".n-chip")) {
        if (String(c.textContent || "") !== T("频谱")) continue;
        r.chip = c;
        break;
      }
      for (const b of head.querySelectorAll(".n-play")) {
        const t = String(b.textContent || "");
        if (t !== "▶" && t !== "…") continue;
        r.play = b;
        break;
      }
    }
    /* 报告行：appendBody 建它时已经登记过就是同一个元素，沿用它（body 此刻可能还没进
       节点，别再解析一次把它冲掉）；真没有才在这里补一次 */
    if (!r.row) {
      r.row = el.querySelector(".n-aa-report");
      r.txt = r.row ? r.row.querySelector(".aa-rp-t") : null;
      r.go = r.row ? r.row.querySelector(".aa-rp-go") : null;
    }
    return true;
  }

  function aaPaintStatus(node) {
    if (!node || !node.id || typeof document === "undefined") return false;
    const r = aaStatusRefsOf(node);
    /* 换代才解析（首次 / 重绘 / 切画布 / body 换掉）；平时的进度回调直接吃缓存 —
       这是分析期间一秒数次的那条路，不再出现任何选择器。 */
    if (!r.el || r.el.isConnected !== true) {
      if (!aaStatusResolve(node, r)) return false;
    }
    const status = String(node.aaStatus || "").trim();
    const running = !!node.running;
    const c = r.chip;
    if (c) {
      c.classList.toggle("on", running);
      if (status) c.title = status;
    }
    const b = r.play;
    if (b) {
      b.textContent = running ? "…" : "▶";
      b.classList.toggle("running", running);
      b.classList.toggle("error", !running && !!node.error);
      b.disabled = running;
      if (status) b.title = status;
    }
    const row = r.row;
    if (row) {
      const st = aaReportRowState(node);
      row.className = "n-aa-report" + st.cls;
      row.disabled = st.disabled;
      row.title = st.title;
      if (r.txt) r.txt.textContent = st.text;
      if (r.go) r.go.textContent = st.cls === " ready" ? "›" : "";
    }
    return true;
  }

  /* 只重建这一颗（画布走签名复用，不这么调状态行会停在上一次）。
     **只在结构真变时调**：首次拿到结果 / 图种变化 / 跑完 / 失败 —— 纯文本变化走 aaStatus。 */
  function aaRepaint(node) {
    try {
      if (node && node.id && typeof refreshNodeEl === "function") {
        refreshNodeEl(node.id);
        return;
      }
    } catch (_) {}
    try {
      if (typeof renderCanvas === "function") renderCanvas();
    } catch (_) {}
  }

  /* ── 运行 ────────────────────────────────────────────────────────────── */

  async function playAudioAnalysisNode(node, quiet) {
    if (!node) return;
    const api = window.api || {};
    if (typeof api.audioAnalyze !== "function") {
      toast(T("宿主桥未就绪（audioAnalyze）：请重启应用"), "err");
      return;
    }
    if (node.running) return;
    aaNormalize(node);
    const audioPath = aaInputPath(node);
    if (!audioPath) {
      const msg = T("没有音频输入：请从端口 0 接入音频或视频（音频 / 视频输入节点、生成节点、保存节点均可）");
      node.error = msg;
      aaStatus(node, msg); /* 只变文本（失败原因 / ▶ 变红）：就地改，不重建节点 */
      if (!quiet) toast(msg, "warn");
      return;
    }
    node.running = true;
    node.error = null;
    node.ranAt = 0;
    aaStatus(node, T("准备分析…")); /* 起跑：chip 亮 + ▶ 变「…」，仍然是就地改 */
    if (typeof beginNodeRun === "function") beginNodeRun(node);
    /* 首次使用要先建 venv / 装 numpy / 起服务：把宿主那条进度转成人话写进状态落点 */
    let unsub = null;
    try {
      if (typeof api.onAudioProgress === "function") {
        unsub = api.onAudioProgress((p) => {
          if (!p || !p.label) return;
          if (!node.running) return;
          /* 纯进度文本：绝不重建节点（旧写法每次都 refreshNodeEl → 整颗 DOM 换掉，
             波形播放器 / 叠加 canvas / 频谱 img / ResizeObserver 全被销毁重建） */
          aaStatus(node, T("准备后端：") + p.label);
        });
      }
    } catch (_) {}
    const t0 = Date.now();
    try {
      const r = await api.audioAnalyze({ audioPath, options: aaOptionsOf(node) });
      if (!r || !r.ok) {
        const e = (r && r.error) || {};
        const code = String(e.code || "");
        throw new Error(
          (e.message || T("分析失败")) + (code ? "［" + code + "］" : "") + (e.detail ? "：" + String(e.detail).slice(0, 300) : ""),
        );
      }
      const body = r.body || {};
      const sm = aaSummaryOf(body);
      node.aaAnalysis = null; /* 不把整份 body 存进节点（rmsNorm 数组会让存档暴涨） */
      node.aaSummary = sm;
      node.aaDurationSec = sm.durationSec;
      node.aaSpectrogram = aaVisualPathOf(body, "spectrogram");
      node.aaOverlay = aaVisualPathOf(body, "beatOverlay");
      node.aaJsonPath = String(r.fullJsonPath || "");
      const text = aaDigestText(
        aaDigest(body, node.aaJsonPath, node.aaGuide, node.aaVideoFps, node.aaVisualOffsetMs),
      );
      node.output = { kind: "text", text: text };
      node.ranAt = Date.now();
      aaStatus(node, aaSummaryLineText(sm));
      if (!quiet) {
        const sec = Math.round((Date.now() - t0) / 100) / 10;
        toast(T("音频分析完成（") + sec + T(" s）：") + aaSummaryLineText(sm), "ok");
      }
    } catch (e) {
      node.error = (e && e.message) || String(e);
      aaStatus(node, node.error);
      if (!quiet) toast(node.error, "err");
    } finally {
      node.running = false;
      try {
        if (typeof unsub === "function") unsub();
      } catch (_) {}
      /* 跑完 / 失败 = 结构真变：频谱 img 可能首次出现、图种可能变、报告入口要换成「查看分析报告」
         —— 这里重建**一次**（原先进度回调里每一次都重建） */
      aaRepaint(node);
      if (typeof scheduleSave === "function") scheduleSave();
      if (node.output && node.output.text && typeof fireControlOutgoing === "function")
        await fireControlOutgoing(node, 2, new Set([node.id]));
    }
  }

  /* ── 板身：波形播放器 + 频谱图（播放头同步）────────────────────────────── */

  /* ══ 全局播放头 ticker ══════════════════════════════════════════════════
     以前**每颗节点各起一套**：一只 300 ms setInterval 轮询「播没在播」+ 播放期一只 rAF，
     rAF 里还每帧 querySelector('.n-aa-time')。画布上 N 颗分析节点 = N 套，窗口缩放 /
     多节点同屏时逐套排队。现在全文件只有这一只 ticker：
       · 节点登记进 aaHeadLive（注销走 aaStopLive，掉出文档的在帧里顺手注销）；
       · 静置时 **0 只定时器**（没有播放中的节点就整只停掉，不空转）；
       · 播放时最多 **1 只 rAF**，与节点数无关（定时器常数级）。
     起播怎么发现（app-audioview 没暴露播放事件，别再为此每颗节点开一只轮询定时器）：
       · 外壳上的 pointerdown / click（**捕获阶段**：播放键与波形所在的 row 在冒泡阶段
         stopPropagation，冒泡 listener 收不到）—— 点播放键、点 / 拖波形都走这条路；
       · document 捕获阶段的 play / pause / ended —— 引擎 <audio> 上派发的媒体事件
         （不冒泡，但捕获阶段会经过 document），覆盖「点频谱 seek 起播」这类不经过外壳的入口。
     kick 之后 1 秒宽限窗口内即使还没读到 playing 也继续跑帧（引擎状态是异步翻的）；
     窗口过了且没有任何节点在播 —— 整只停掉。 */
  const aaHeadLive = new Map(); /* node.id -> item（见 aaBindPlayhead） */
  let aaHeadRaf = 0;
  let aaHeadGraceUntil = 0;
  let aaHeadMediaBound = false;

  function aaHeadNow() {
    return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
  }

  function aaHeadStopRaf() {
    if (!aaHeadRaf) return;
    try {
      cancelAnimationFrame(aaHeadRaf);
    } catch (_) {}
    aaHeadRaf = 0;
  }

  function aaHeadUnbind(nodeId) {
    const it = aaHeadLive.get(nodeId);
    if (!it) return;
    aaHeadLive.delete(nodeId);
    try {
      for (const host of [it.wave, it.spec]) {
        if (!host || !host.removeEventListener) continue;
        host.removeEventListener("pointerdown", it.kick, true);
        host.removeEventListener("click", it.kick, true);
      }
    } catch (_) {}
    if (!aaHeadLive.size) aaHeadStopRaf();
  }

  function aaHeadBindMedia() {
    if (aaHeadMediaBound) return;
    if (typeof document === "undefined" || !document.addEventListener) return;
    aaHeadMediaBound = true;
    for (const ev of ["play", "pause", "ended"]) {
      try {
        /* capture = true 是必须的：媒体事件 bubbles 为 false，只有捕获阶段经过 document */
        document.addEventListener(ev, () => aaHeadKick(), true);
      } catch (_) {}
    }
  }

  /** 该画一帧了（起播 / 停播 / 刚绑定）：同一帧内来几次都只排一帧 */
  function aaHeadKick() {
    aaHeadGraceUntil = aaHeadNow() + 1000;
    if (aaHeadRaf || !aaHeadLive.size) return;
    aaHeadRaf = requestAnimationFrame(aaHeadFrame);
  }

  /** 唯一那只帧循环：一次遍历所有登记节点（不是每节点一只 rAF） */
  function aaHeadFrame() {
    aaHeadRaf = 0;
    const items = Array.from(aaHeadLive.values());
    let live = 0;
    let anyPlaying = false;
    for (const it of items) {
      if (!it.spec || !it.spec.isConnected) {
        aaHeadUnbind(it.nodeId); /* 节点被删 / body 已重建：别留着对已脱离 DOM 的登记 */
        continue;
      }
      live++;
      const playing = typeof wavePreviewPlayingOf === "function" ? wavePreviewPlayingOf(it.wave) : false;
      if (playing) {
        anyPlaying = true;
        it.playing = true;
        paintItem(it, typeof wavePreviewTimeOf === "function" ? wavePreviewTimeOf(it.wave) : 0, true);
      } else if (it.playing) {
        /* 停下：这一帧把读数归位一次（与旧行为一致），之后不再画 */
        it.playing = false;
        paintItem(it, typeof wavePreviewTimeOf === "function" ? wavePreviewTimeOf(it.wave) : 0, false);
        paintItem(it, 0, false);
      }
    }
    if (!live) return;
    /* 还有人在播、或刚 kick 过（宽限窗口内）就继续；否则整只停下 —— 静置时不留定时器 */
    if (anyPlaying || aaHeadNow() < aaHeadGraceUntil) aaHeadRaf = requestAnimationFrame(aaHeadFrame);
  }

  function aaStopLive(nodeId) {
    /* 叠加层的重绘控制器一并收掉：断掉 ResizeObserver，别留下对已脱离 DOM 节点的观察 */
    aaOverlayStop(nodeId);
    /* 播放头从全局 ticker 注销（原来是这里按节点 clearInterval + cancelAnimationFrame） */
    aaHeadUnbind(nodeId);
  }

  /* 播放头呼吸：由**相位**连续驱动 —— 每拍走一个 0→1→0 的正弦（phase = 拍内位置），
     播放时竖线一直随拍起伏，没跨拍也不会「死平」；真的跨过重拍时再做一次强调
     （变粗 + 换青色，短暂衰减），那只是加分项，不是呼吸本身。 */
  const AA_BREATH = { depth: 0.55, w: 2.3 };
  const AA_PULSE = { down: { ms: 220, w: 3.4, color: "var(--cyan)" } };

  /** 重拍时间表（与叠加层同源：只从这里取，不另算一份） */
  function aaMarkTimes(node) {
    const layers = aaEventLayers(node);
    const marks = [];
    for (const t of layers.downbeats) marks.push({ t, kind: "down" });
    marks.sort((a, b) => a.t - b.t);
    return marks;
  }

  /** 呼吸用的拍时钟（秒）：一拍多长、第一拍在哪 —— 只从摘要里取 */
  function aaBeatClock(node) {
    const rep = aaReportOf(node) || {};
    const g = rep.global || {};
    const bg = rep.beatGrid || {};
    const bpm = Number(g.bpm) || 0;
    let beatSec = bpm > 0 ? 60 / bpm : Number(g.beatPeriodSec) || 0;
    const beats = (Array.isArray(bg.beatsSec) ? bg.beatsSec : []).map(Number).filter((v) => isFinite(v) && v >= 0);
    /* 拍表比 bpm 更贴实际网格（校准过 / 有微小时值摆动）：够长就按它的中位间隔量一拍 */
    if (beats.length >= 3) {
      const d = [];
      for (let i = 1; i < beats.length; i++) d.push(beats[i] - beats[i - 1]);
      d.sort((a, b) => a - b);
      const med = d[(d.length - 1) >> 1];
      if (isFinite(med) && med > 0.05) beatSec = med;
    }
    const firstSec = beats.length ? beats[0] : Number(bg.firstBeatSec) || 0;
    return { beatSec: beatSec > 0 ? beatSec : 0, firstSec };
  }

  /** 拍内相位 0→1（连续、不取整）：呼吸的主驱动 */
  function aaPhaseAt(clock, t) {
    const bs = clock && clock.beatSec;
    if (!(bs > 0)) return 0;
    const raw = (Number(t) - clock.firstSec) / bs;
    return raw - Math.floor(raw);
  }

  /* 三个内联变量写到播放头上：--aa-pulse（0..1，驱动粗细与光晕）/ --aa-pulse-w / --aa-pulse-c。
     headEl / timeEl 都是绑定时缓存的引用（建 DOM 时就传进来），帧里不查 DOM。 */
  function paintHeadOf(it, t, playing) {
    const headEl = it.headEl;
    if (!headEl) return;
    try {
      if (!playing) {
        headEl.style.removeProperty("--aa-pulse");
        headEl.style.removeProperty("--aa-pulse-w");
        headEl.style.removeProperty("--aa-pulse-c");
        return;
      }
      /* 这一帧的呼吸：相位正弦（基线，一直有）+ 跨拍强调（衰减的快闪，只加不减） */
      let k = AA_BREATH.depth * (0.5 - 0.5 * Math.cos(2 * Math.PI * aaPhaseAt(it.clock, t)));
      let w = AA_BREATH.w;
      let color = "var(--green)";
      const p = it.pulse;
      if (p) {
        const age = aaHeadNow() - p.at;
        if (age >= p.ms) it.pulse = null;
        else {
          const e = Math.sin(Math.PI * (age / p.ms));
          if (e > k) {
            k = e;
            w = p.w;
            color = p.color;
          }
        }
      }
      headEl.style.setProperty("--aa-pulse", k.toFixed(3));
      headEl.style.setProperty("--aa-pulse-w", w.toFixed(2) + "px");
      headEl.style.setProperty("--aa-pulse-c", color);
    } catch (_) {}
  }

  function pulseTo(item, kind) {
    const cfg = AA_PULSE[kind] || AA_PULSE.down;
    item.pulse = { at: aaHeadNow(), ms: cfg.ms, w: cfg.w, color: cfg.color };
  }

  /* 这一帧跨过了哪些重拍：取跨过的最后一个。两帧间隔过大（起播 / 拖动跳转）不算跨过 ——
     否则跳转一次就会糊出一串乱闪。 */
  function pulseIfCrossed(item, prevT, t) {
    const marks = item.marks;
    if (!marks.length) return;
    if (!(t > prevT) || t - prevT > 0.5) return;
    let lo = 0;
    let hi = marks.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (marks[mid].t <= t) {
        idx = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    let pick = null;
    for (let i = idx; i >= 0; i--) {
      const m = marks[i];
      if (m.t <= prevT) break;
      pick = m;
    }
    if (pick) pulseTo(item, pick.kind);
  }

  /** 画一只节点的播放头 + 时间读数（ticker 的帧里 / 绑定时各调一次，不再各起循环） */
  function paintItem(item, t, playing) {
    const total = item.dur;
    const now = Math.max(0, Number(t) || 0);
    if (playing) {
      pulseIfCrossed(item, item.lastT, now);
      item.lastT = now;
    }
    paintHeadOf(item, now, playing);
    const pct = total > 0 ? Math.max(0, Math.min(100, (now / total) * 100)) : 0;
    if (Math.abs(pct - item.last) < 0.05) return;
    item.last = pct;
    try {
      item.spec.style.setProperty("--aa-pos", pct.toFixed(2) + "%");
    } catch (_) {}
    if (item.timeEl) item.timeEl.textContent = aaFmtTime(now) + " / " + aaFmtTime(total);
  }

  /** 频谱上的播放头：跟着全局播放引擎走（引擎的口径只在 app-audioview.js 里判）。
      这里只**登记**进全局 ticker，不自己起定时器 / rAF。
      dom 是建 DOM 时缓存的 { headEl, timeEl }：给了就不查 DOM（不给才在这里查一次）。 */
  function aaBindPlayhead(node, waveEl, specEl, durSec, dom) {
    const nodeId = node.id;
    aaStopLive(nodeId);
    const pick = (sel) => (specEl && specEl.querySelector ? specEl.querySelector(sel) : null);
    const it = {
      nodeId,
      spec: specEl,
      wave: waveEl,
      headEl: (dom && dom.headEl) || pick(".n-aa-head"),
      timeEl: (dom && dom.timeEl) || pick(".n-aa-time"),
      dur: Number(durSec) || 0,
      marks: aaMarkTimes(node),
      clock: aaBeatClock(node),
      last: -1,
      lastT: 0,
      pulse: null,
      playing: false,
      kick: null,
    };
    it.kick = () => aaHeadKick();
    aaHeadLive.set(nodeId, it);
    aaHeadBindMedia();
    /* 起播意图 —— 一律挂**捕获阶段**（播放键 / 波形所在的 row 会在冒泡阶段 stopPropagation）：
       · 波形外壳：点播放键、点 / 拖波形；
       · 频谱块（spec 里含 plot）：点频谱 seek 起播，这条不经过外壳。 */
    try {
      for (const host of [waveEl, specEl]) {
        if (!host || !host.addEventListener) continue;
        host.addEventListener("pointerdown", it.kick, true);
        host.addEventListener("click", it.kick, true);
      }
    } catch (_) {}
    paintItem(it, 0, false);
    /* 绑定那一刻就已经在播（重绘时播放不断 / 切参数后 body 重建）：直接让 ticker 起来画，
       别等下一次点击或媒体事件 —— 否则这一路上头会僵在 0。 */
    if (typeof wavePreviewPlayingOf === "function" && wavePreviewPlayingOf(waveEl)) aaHeadKick();
  }

  /* ── 频谱上的事件叠加（重拍 / 能量直方图）──────────────────────────────
     用户口径：画频谱时在上方再叠一层事件（例如重拍），这层能隐藏 / 显示，默认显示。
     数据源 = 输出 0 的摘要 JSON（beatGrid.beatsSec / downbeatsSec / bars），
     不额外打后端、也不落第二份存档。
     **不做段落 / 曲式判断**：前奏 / 主歌 / 副歌这类命名不可靠，这里只画能直接从
     信号量出来的东西：重拍、小节电平。
     叠一层 canvas 而不是几百个 div：3 分钟素材 ≈ 90 小节 + 45 重拍，用 DOM 会拖垮重绘；
     这层 pointer-events:none，点频谱试听的手感一点不变。 */
  /* 事件轨道表：**图例与画布共用这一张表**（颜色 / 形状 / 名称 / 一句话含义都在这）。
     两条轨道各占一个高度带，谁也不压谁：齿一律 1px 宽（高 DPI 下也只是一条细线）。 */
  const AA_EV_TRACKS = [
    {
      key: "down",
      field: "downbeats",
      label: "重拍",
      color: "--cyan",
      shape: "tick",
      hint: "小节第一拍（强拍）：贴频谱底边的高齿 + 顶端小方块。卡点闪拍就闪这里",
    },
    {
      key: "energy",
      field: "bars",
      label: "能量直方图",
      color: "--yellow",
      shape: "bars",
      hint: "每小节一根柱（柱高 = 该小节感知能量：近似 K 加权 + 稳健归一，不是裸 RMS）：哪段满、哪段留白一眼看清，闪拍强度与切点照它挑",
    },
  ];
  const AA_EV_KEYS = AA_EV_TRACKS.map((t) => t.key);

  /** 每一层各自的开 / 关（缺键 = 显示；旧节点没有这个对象就全是默认显示） */
  function aaEvOnOf(node) {
    const raw = node && typeof node.aaEvOn === "object" && node.aaEvOn ? node.aaEvOn : {};
    const out = {};
    for (const k of AA_EV_KEYS) out[k] = raw[k] !== false;
    return out;
  }

  function aaEventLayers(node) {
    const m = aaMemoOf(node);
    /* 命中记忆就整份复用：重拍排序与小节归一都只在换键（新一次结果）时做一次 */
    if (m && m.layers) return m.layers;
    const out = { downbeats: [], bars: [] };
    const num = (v) => {
      const n = Number(v);
      return isFinite(n) && n >= 0 ? n : null;
    };
    const rep = m ? m.rep : null;
    if (rep) {
      const bg = rep.beatGrid || {};
      out.downbeats = (Array.isArray(bg.downbeatsSec) ? bg.downbeatsSec : [])
        .map(num)
        .filter((v) => v != null)
        .sort((a, b) => a - b);
      /* 能量直方图：一条柱 = 一个小节。摘要里 bars 是
         [startSec, endSec, beatCount, rmsDb, lowDb, energy01]（旧摘要是 5 元，完整 JSON 是对象）
         —— 一律走 aaBarsOf 归一；柱高吃 energy01（感知能量），没有它才退回 rmsDb 分位归一 */
      for (const b of aaBarsOfRep(node, rep)) {
        const t = num(b.startSec);
        if (t == null) continue;
        out.bars.push({ t, end: num(b.endSec) == null ? t : num(b.endSec), db: b.rmsDb, e: b.energy01 });
      }
      out.bars.sort((a, b) => a.t - b.t);
    }
    if (m) m.layers = out;
    return out;
  }

  /** rmsDb 的稳健归一区间（p5–p95，线性插值）：旧报告没有 energy01 时柱高吃它。
      叠加层每重绘一次就要用一次（窗口缩放 / 图片加载 / 切层都会重绘），
      所以与事件层同源缓存 —— 不在每次重绘里重排序几百个小节的 dB。 */
  function aaBuildBarsDbNorm(bars) {
    /* 分位（线性插值）：旧报告只有 rmsDb 时用它做稳健归一，抗爆音 */
    const pct = (arr, q) => {
      const s = arr.slice().sort((a, b) => a - b);
      if (!s.length) return 0;
      const i = (s.length - 1) * q;
      const lo = Math.floor(i);
      const hi = Math.ceil(i);
      return s[lo] + (s[hi] - s[lo]) * (i - lo);
    };
    const dbList = (Array.isArray(bars) ? bars : []).map((b) => Number(b.db)).filter((v) => isFinite(v));
    const loDb = pct(dbList, 0.05);
    const hiDb = pct(dbList, 0.95);
    /* 全曲一条平线时给 1 dB 的假范围：柱高一样高，但不至于除以 0 */
    return { loDb, span: hiDb - loDb > 0.5 ? hiDb - loDb : 1 };
  }
  function aaBarsDbNorm(node, layers) {
    const m = aaMemoOf(node);
    if (m && m.layers === layers) {
      if (!m.dbNorm) m.dbNorm = aaBuildBarsDbNorm(layers.bars);
      return m.dbNorm;
    }
    return aaBuildBarsDbNorm(layers && layers.bars);
  }

  function aaEventLayerCount(layers) {
    const l = layers || {};
    return (l.downbeats || []).length + (l.bars || []).length;
  }

  /* ── 叠加层的两张缓存（都挂在 canvas 元素上，WeakMap 里不留强引用）──────────────
     这一层会被反复重画：窗口缩放、节点改宽、图片加载、切层开关都会再调一次
     aaPaintEventOverlay。两样贵的东西都缓存，键就是 canvas 本身（节点扔掉时整格跟着
     回收，也不往 node 上加字段、不混进落盘的 JSON）：
       ① 像素列聚合（每小节 → 每个 CSS 像素列的最高柱）：只跟宽度 / 时长 / 小节表 /
          分位区间有关、**与高度无关** —— 只算一次，缓存到宽度或那几样变了为止；
       ② 画好的那一张位图（离屏 canvas）：像素宽高与全部输入都没变时只做一次 blit，
          几万个路径指令一条也不重画。 */
  const aaOvCacheMap = new WeakMap();
  const aaOvIdMap = new WeakMap(); /* 对象 -> 稳定 id：只用来判断"还是不是同一份输入" */
  let aaOvSeq = 0;
  function aaOvId(obj) {
    if (!obj || typeof obj !== "object") return 0;
    let id = aaOvIdMap.get(obj);
    if (!id) {
      id = ++aaOvSeq;
      aaOvIdMap.set(obj, id);
    }
    return id;
  }
  function aaOvCacheOf(canvas) {
    let c = aaOvCacheMap.get(canvas);
    if (!c) {
      c = {
        cols: null, /* Float32Array：每列最高的那个 k（−1 = 这列没有小节） */
        colsW: 0,
        colsTotal: 0,
        colsLayers: null,
        colsLo: 0,
        colsSpan: 0,
        bmp: null, /* 上一张位图（离屏 canvas） */
        bmpSig: "", /* 位图对应的输入签名；一致就直接复用，不重画 */
      };
      aaOvCacheMap.set(canvas, c);
    }
    return c;
  }

  /** 每小节 → 每个 CSS 像素列的最高柱（存归一后的 k，−1 = 这一列没有小节）。
      只跟宽度 / 时长 / 小节表 / 分位区间有关：高度变了照样复用，不重算。 */
  function aaEventCols(cache, layers, w, total, loDb, span) {
    if (
      cache.cols &&
      cache.cols.length === w &&
      cache.colsTotal === total &&
      cache.colsLayers === layers &&
      cache.colsLo === loDb &&
      cache.colsSpan === span
    ) {
      return cache.cols;
    }
    const cols = new Float32Array(w).fill(-1);
    const xOf = (t) => Math.max(0, Math.min(w, (Number(t) / total) * w));
    for (const b of layers.bars) {
      let x0 = Math.floor(xOf(b.t));
      let x1 = Math.ceil(xOf(b.end));
      if (!(x1 > x0)) x1 = x0 + 1;
      if (x0 > w - 1) x0 = w - 1;
      if (x1 > w) x1 = w;
      let k;
      if (b.e != null && isFinite(Number(b.e))) k = Math.max(0, Math.min(1, Number(b.e)));
      else if (isFinite(Number(b.db))) k = Math.max(0, Math.min(1, (Number(b.db) - loDb) / span));
      else k = 0;
      /* 一列里落了好几根小节：留最高的那根（与逐根比 cur 取最小等价，k 单调） */
      for (let x = x0; x < x1; x++) if (k > cols[x]) cols[x] = k;
    }
    cache.cols = cols;
    cache.colsW = w;
    cache.colsTotal = total;
    cache.colsLayers = layers;
    cache.colsLo = loDb;
    cache.colsSpan = span;
    return cols;
  }

  /** 画一次叠加层（返回 false = 尺寸还没算出来，调用方下一帧再试）。
      这层**就铺在频谱图上**（不是上方另开一条带）：两条轨道各占一角、谁也不压谁 ——
        ① 能量直方图：贴底边往上长的黄色柱（每小节一根）+ 顶端一条亮轮廓
        ② 重拍齿：贴底边往上长，1px 细齿 + 顶端小方块（青色）
      中间那块热力区始终空着。每一层都能单独关（aaEvOn），全关就清干净不留残影。
      真正画的是**离屏位图**：输入没变就把上一张位图 blit 过来（见 aaOvCacheOf）。 */
  function aaPaintEventOverlay(spec, canvas, node) {
    if (!spec || !canvas || !canvas.isConnected) return false;
    const w = Math.round(canvas.clientWidth || 0);
    const h = Math.round(canvas.clientHeight || 0);
    if (!(w > 0) || !(h > 0)) return false;
    const ctx = canvas.getContext ? canvas.getContext("2d") : null;
    if (!ctx) return false;
    const dpr = Math.max(1, Math.min(3, Number(window.devicePixelRatio) || 1));
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    const cache = aaOvCacheOf(canvas);
    /* 这一帧什么都不该有（全关 / 没数据 / 时长没算出来）：擦干净再返回，不留上一帧的残影 */
    const blank = () => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return true;
    };
    const on = aaEvOnOf(node);
    const all = node.aaShowEvents !== false;
    const layers = aaEventLayers(node);
    /* 一层都没开（或者都没数据）就别画 */
    const live =
      all &&
      AA_EV_KEYS.some(
        (k) => on[k] && (layers[(AA_EV_TRACKS.find((t) => t.key === k) || {}).field] || []).length
      );
    const total = Number(node.aaDurationSec) || 0;
    if (!live || !(total > 0)) return blank();
    const xOf = (t) => Math.max(0, Math.min(w, (Number(t) / total) * w));
    const css = (name, fallback) => {
      try {
        const v = getComputedStyle(spec).getPropertyValue(name).trim();
        return v || fallback;
      } catch (_) {
        return fallback;
      }
    };
    const cDown = css("--cyan", "#38d6ff");
    const cEng = css("--yellow", "#ffd166");
    /* 各轨道的高度按频谱本身的像素高换算（贴底各占一小条，中间留空）：
       高 150px 的频谱上重拍齿约 18px；窄高再小也不会细到看不见。 */
    const downH = Math.max(7, Math.min(20, Math.round(h * 0.17)));
    const wantEng = !!on.energy && layers.bars.length > 0;
    const wantDown = !!on.down && layers.downbeats.length > 0;
    const norm = wantEng ? aaBarsDbNorm(node, layers) : null;
    const loDb = norm ? norm.loDb : 0;
    const span = norm ? norm.span : 1;
    /* 输入签名：像素宽高 / CSS 宽高 / DPR / 时长 / 各层开关 / 事件层与分位区间（对象身份）
       / 两个颜色。签名一致 = 上一张位图就是这一帧要的像素。
       **仍然走一次 blit**（而不是直接 return）：图例那侧「全关」会把这块 canvas 擦掉，
       再打开时必须能把同一张位图原样贴回来。 */
    const sig = [
      pw,
      ph,
      w,
      h,
      dpr,
      total,
      downH,
      wantEng ? 1 : 0,
      wantDown ? 1 : 0,
      aaOvId(layers),
      aaOvId(norm),
      cDown,
      cEng,
    ].join("|");
    let bmp = cache.bmp;
    if (!(bmp && cache.bmpSig === sig)) {
      /* —— 缓存没命中才真正画：全部画进离屏位图 —— */
      if (!bmp || bmp.width !== pw || bmp.height !== ph) bmp = document.createElement("canvas");
      if (bmp.width !== pw) bmp.width = pw;
      if (bmp.height !== ph) bmp.height = ph;
      const bctx = bmp.getContext ? bmp.getContext("2d") : null;
      if (!bctx) return false;
      bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      bctx.clearRect(0, 0, w, h);

      /* ① 能量直方图（先画、在最底下）：每小节一根柱。柱高吃 `energy01`（小节感知能量：
         6 带近似 K 加权 + 全曲 p5–p95 稳健归一），再套 gamma 0.8 —— 安静段与副歌在小节
         粒度上能一眼看出高低差。旧报告没有这一列时退回 rmsDb 的 **p5–p95 分位归一**；
         旧的 min–max 线性拉伸正是「几乎全顶到同一高度、听感读不出来」的根源（逐小节 RMS
         只差几 dB，而个别爆音又独占高端）。
         基线压在重拍齿那一带**上面**（不叠在一起，否则底边那 18px 会糊成一片）。
         小节比像素还密时**按像素列取最大值合绘**（不是隔几根丢一根）—— 长素材上依然是完整的
         一条能量轮廓，不会变成稀疏虚线。像素列聚合本身走 aaEventCols：宽度没变就不重算。
         **底下先铺一块压暗的板**：热力图本身就是橙 / 紫 / 亮黄，黄柱直接压上去跟频谱融成一片
         （用户实测："能量直方图无法看到"）。压暗板只铺直方图那一带、半透明，频谱仍透得出来，
         柱子与顶端轮廓在亮区 / 暗区上都能一眼读出高低。 */
      if (wantEng) {
        /* 分位区间与事件层同源缓存（见 aaBarsDbNorm）：每次重绘不再重排序一遍 dB */
        const cols = aaEventCols(cache, layers, w, total, loDb, span);
        const bottom = Math.max(4, h - downH - 2);
        const maxH = Math.max(4, Math.round(h * 0.5));
        /* 每列的柱顶 y（−1 = 这列没有小节）：柱与顶端轮廓共用一份，只算一次 */
        const tops = new Int32Array(w);
        for (let x = 0; x < w; x++) {
          const k = cols[x];
          /* gamma 0.8：把安静段的差别抬起来一点，副歌仍然顶到高位；4% 底高让近乎无声的小节
             仍留一条可见的线（否则"留白"和"没数据"看起来一样） */
          tops[x] = k >= 0 ? bottom - Math.max(1, Math.round(maxH * (0.04 + 0.96 * Math.pow(k, 0.8)))) : -1;
        }
        bctx.fillStyle = "rgba(4, 6, 11, .52)";
        bctx.fillRect(0, bottom - maxH - 2, w, maxH + 2);
        bctx.fillStyle = cEng;
        bctx.globalAlpha = 0.55;
        bctx.beginPath();
        for (let x = 0; x < w; x++) {
          const y = tops[x];
          if (y < 0) continue;
          bctx.rect(x, y, 1, Math.max(1, bottom - y));
        }
        bctx.fill();
        /* 顶端轮廓：一条 1px 的亮线，柱高再密也读得出起伏 */
        bctx.globalAlpha = 1;
        bctx.beginPath();
        let pen = false;
        for (let x = 0; x < w; x++) {
          const y = tops[x];
          if (y < 0) {
            pen = false;
            continue;
          }
          if (pen) bctx.lineTo(x + 0.5, y + 0.5);
          else bctx.moveTo(x + 0.5, y + 0.5);
          pen = true;
        }
        bctx.lineWidth = 1;
        bctx.strokeStyle = cEng;
        bctx.stroke();
        bctx.globalAlpha = 1;
      }

      /* ② 重拍轨：贴底边往上，1px 细齿 + 顶端 2×2 小方块；
         齿挤到 3px 以内就抽稀 —— 长素材的小节数一多，不抽会连成一条实心带。
         **所有齿并成一条 path**：一次深色描边 + 一次填充。原来每根齿两发带
         shadowBlur 的 fillRect（几百根齿 = 几百次模糊 pass），窗口缩放 / 拖动画布时
         这一层就卡在这里。频谱本身是亮热力图，所以齿要先有一圈深色底才读得清；
         这里用两遍描边（外圈 3.5px / 6%、内圈 1px / 22%）替掉原来 2px 的糊边 —— 对着
         HEAD 版逐像素量过（见改前改后对照），平均差 0.03/255、RMSE 0.45，视觉等价，
         但整层只剩一条路径。直方图不加描边（几百根柱各自带底边会把半透明的黄柱糊成脏褐色）。 */
      if (wantDown) {
        bctx.beginPath();
        let lastDownX = -99;
        for (const t of layers.downbeats) {
          const x = Math.round(xOf(t));
          if (x - lastDownX < 3) continue;
          lastDownX = x;
          bctx.rect(x, h - downH, 1, downH);
          bctx.rect(x - 1, h - downH, 2, 2);
        }
        bctx.strokeStyle = "rgba(0, 0, 0, .06)";
        bctx.lineWidth = 3.5;
        bctx.stroke();
        bctx.strokeStyle = "rgba(0, 0, 0, .22)";
        bctx.lineWidth = 1;
        bctx.stroke();
        bctx.fillStyle = cDown;
        bctx.fill();
      }
      cache.bmp = bmp;
      cache.bmpSig = sig;
    }
    /* 位图 → 可见 canvas（1:1，不做缩放）：命中缓存时只有这一发 blit */
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0);
    return true;
  }

  /* ── 叠加层的**唯一重绘入口**（requestPaint）───────────────────────────────────
     这一层原来有三条各自为政的触发：首帧的 12 帧重试环、img 的 load 回调、
     ResizeObserver —— 每条都直接调 aaPaintEventOverlay 全量重画一遍。窗口拖大时
     ResizeObserver 每帧来一次、load 再来一次，几次绘制就排在同一个帧里，等于白干。
     现在全部收成一个控制器（每个 canvas 一个，按 node.id 登记在 aaOvLive 里）：
       ① request() 只认**整数尺寸真变**（lastW / lastH）：0.4px 的抖动不重画；
       ② 同一帧里来几次都只排一次 rAF —— 合并到**尾沿**，一帧最多画一次；
       ③ 尺寸还没量出来（首帧 body 尚未挂上 DOM / 图未加载）就在下一帧再试，封顶 12 帧
          （与原来同口径：约 200 ms 还不成就算了，不再空转）；
       ④ imageLoaded() 对同一张图（src 相同）只触发一次 —— 重跑后 src 带新 ?t=，才会再来；
       ⑤ 节点被拆掉（重绘 / 移除）时自己 kill()：断掉 ResizeObserver，不留下对已脱离
          DOM 节点的观察；aaStopLive 也会一并把它清掉。
     切层开关（图例 / 总开关）不走这儿：那是用户点一下要立刻见效的操作，直接画一次。 */
  const aaOvLive = new Map(); /* node.id -> 控制器 */

  /* 当前是否处在画布缩略总览（app.js 的 syncNodeLod 切的那个 .lod-mini 档）。
     权威值在 #canvas 的类上（见 aaLodMiniOn），这个变量只是事件回调里的去抖状态。 */
  let aaLodMiniState = false;
  let aaLodBound = false;

  function aaOverlayStop(nodeId) {
    const st = aaOvLive.get(nodeId);
    if (st) st.kill();
  }

  function aaOverlayPainter(spec, canvas, node, img) {
    const nodeId = node.id;
    /* 同一颗节点重建 body：上一轮的观察先收干净，绝不留两份观察盯同一个节点 */
    aaOverlayStop(nodeId);
    const st = {
      w: 0, /* 上次真正画过的整数 CSS 尺寸（0 = 还没画成过） */
      h: 0,
      dpr: 0, /* 上次画时的 devicePixelRatio（换屏才变，见 paintNow） */
      raf: 0, /* 已排队的 rAF（非 0 就不再排，合并成一帧一次） */
      tries: 0, /* 尺寸没量出来时的重试次数 */
      attached: false, /* 曾经挂上过 DOM */
      imgSrc: "", /* 触发过重绘的图片地址（同一张图只触发一次） */
      ro: null,
      dead: false,
    };
    const kill = () => {
      st.dead = true;
      if (st.raf) {
        try {
          cancelAnimationFrame(st.raf);
        } catch (_) {}
        st.raf = 0;
      }
      if (st.ro) {
        try {
          st.ro.disconnect();
        } catch (_) {}
        st.ro = null;
      }
      if (aaOvLive.get(nodeId) === st) aaOvLive.delete(nodeId);
    };
    const paintNow = () => {
      st.raf = 0;
      if (st.dead) return;
      if (!spec.isConnected || !canvas.isConnected) {
        /* body 是先建后插：还没进文档就下一帧再看；挂上过又被拆掉 = 节点没了，断开观察 */
        if (st.attached) {
          kill();
          /* 播放头也一并注销：否则「静置时删节点」没人发现 —— ticker 静置是 0 定时器，
             只能靠这条已经存在的脱离检测（观察回调 / 这一帧）把登记收掉 */
          aaHeadUnbind(nodeId);
          return;
        }
        if (st.tries++ < 12) request();
        return;
      }
      st.attached = true;
      /* 早退（成本账 ③）：图层被关掉、或画布已经缩到缩略总览 —— 这一发画了也没人看得见，
         直接跳过并且**不排下一帧**。缩略总览下 .n-body 只是 visibility: hidden，尺寸照旧是
         真的，所以旧行为在这里「缓存判定永远命中、看着没画其实一直在排 rAF」。
         回到普通档不靠这里重排：重内容在切档时已被拆掉，重建时会新建一个绘制控制器
         （aaOverlayPainter 自带首帧 request），ResizeObserver 也会在尺寸真变时 request。 */
      if (canvas.hidden || aaLodMiniOn()) return;
      const w = Math.round(canvas.clientWidth || 0);
      const h = Math.round(canvas.clientHeight || 0);
      if (!(w > 0) || !(h > 0)) {
        /* 元素量不到尺寸（首帧布局还没算出来 / 节点被折叠）：有界重试 12 帧内再看，
           缩略总览下不重试（那一档本来就该零 rAF） */
        if (!aaLodMiniOn() && st.tries++ < 12) request();
        return;
      }
      st.tries = 0;
      /* 整数尺寸没变就不用动（DPR 例外：换屏 / 缩放比例变了要按新像素比重画一次，
         否则上面那张位图会被拉伸） */
      const dpr = Math.max(1, Math.min(3, Number(window.devicePixelRatio) || 1));
      if (w === st.w && h === st.h && dpr === st.dpr) return;
      st.w = w;
      st.h = h;
      st.dpr = dpr;
      aaPaintEventOverlay(spec, canvas, node);
    };
    function request() {
      if (st.dead || st.raf) return;
      st.raf = requestAnimationFrame(paintNow);
    }
    const imageLoaded = () => {
      if (st.dead) return;
      const src = img ? String(img.currentSrc || img.src || "") : "";
      /* 同一张图只触发一次；换了图（重跑后 ?t= 变了）才再触发 */
      if (src && src === st.imgSrc) return;
      st.imgSrc = src;
      st.tries = 0; /* 图加载会改布局高度：尺寸真变了才真画，没变就白跑一趟 rAF */
      request();
    };
    const observe = (el) => {
      if (st.dead || !el || typeof ResizeObserver !== "function") return;
      try {
        st.ro = new ResizeObserver(() => {
          if (st.dead) return;
          if (!spec.isConnected) {
            kill();
            aaHeadUnbind(nodeId); /* 同上：节点没了，播放头的登记一起收掉 */
            return;
          }
          request(); /* 缩放 / 改宽：先记账，尺寸真变才画 */
        });
        st.ro.observe(el);
      } catch (_) {
        st.ro = null;
      }
    };
    const ctl = { request, imageLoaded, observe, kill };
    aaOvLive.set(nodeId, ctl);
    return ctl;
  }

  /** 图例 +「事件」总开关（一行，在频谱下面）：**每一项都是一颗按钮**，点一下只切这一层；
      右侧的总开关一次全关 / 全开。颜色与形状都取自 AA_EV_TRACKS —— 画布上画什么，
      这里就说明什么，不会说一套画一套。时间读数（timeEl）也在这行。 */
  function aaEventBar(node, spec, canvas, timeEl) {
    const bar = document.createElement("div");
    bar.className = "n-aa-evbar";
    const layers = aaEventLayers(node);
    const items = [];
    const sync = () => {
      const on = aaEvOnOf(node);
      const all = node.aaShowEvents !== false;
      const live = AA_EV_KEYS.some((k) => all && on[k]);
      if (canvas) canvas.hidden = !live;
      for (const it of items) {
        const k = it.dataset.kind;
        const show = all && on[k];
        it.classList.toggle("off", !show);
        it.setAttribute("aria-pressed", show ? "true" : "false");
      }
      master.classList.toggle("on", live);
      master.setAttribute("aria-pressed", live ? "true" : "false");
      if (live) aaPaintEventOverlay(spec, canvas, node);
      else if (canvas && canvas.getContext) {
        /* 全关时把上一帧的标记擦掉：虽然 hidden 了，但不留残影更干净（截图 / 打印也不会带出来） */
        try {
          const ctx = canvas.getContext("2d");
          if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
        } catch (_) {}
      }
    };
    for (const tr of AA_EV_TRACKS) {
      const n = (layers[tr.field] || []).length;
      const it = document.createElement("button");
      it.type = "button";
      it.className = "n-aa-lg" + (n ? "" : " is-empty");
      it.dataset.kind = tr.key;
      const sw = document.createElement("i");
      sw.className = "n-aa-lg-sw is-" + tr.shape;
      sw.style.setProperty("--c", "var(" + tr.color + ")");
      it.appendChild(sw);
      const nm = document.createElement("b");
      nm.textContent = T(tr.label);
      it.appendChild(nm);
      const ct = document.createElement("em");
      ct.textContent = n ? String(n) : "—";
      it.appendChild(ct);
      it.title =
        T(tr.label) +
        " · " +
        T(tr.hint) +
        (n ? "" : "（" + T("这次没有这类数据") + "）") +
        " · " +
        T("点一下只隐藏 / 显示这一层");
      if (!n) {
        it.disabled = true;
        it.title = T(tr.label) + " · " + T(tr.hint) + "（" + T("这次没有这类数据") + "）";
      }
      it.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      it.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (it.disabled) return;
        const cur = aaEvOnOf(node);
        cur[tr.key] = !cur[tr.key];
        node.aaEvOn = cur;
        /* 单层操作顺带把总开关打开：否则点了图例却什么都没发生 */
        node.aaShowEvents = true;
        if (typeof scheduleSave === "function") scheduleSave();
        sync();
      });
      bar.appendChild(it);
      items.push(it);
    }
    if (timeEl) bar.appendChild(timeEl);
    const master = aaEventToggle(node, () => sync());
    bar.appendChild(master);
    sync();
    return bar;
  }

  /** 「事件」总开关（默认开；点一下整层收起 / 展开，单层用左侧图例各项）。
      状态存在 node.aaShowEvents，重开节点还记得。 */
  function aaEventToggle(node, onChange) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "n-aa-ev-toggle";
    btn.textContent = T("事件");
    const anyData = aaEventLayerCount(aaEventLayers(node)) > 0;
    btn.disabled = !anyData;
    btn.title = anyData
      ? T("事件叠加层的总开关：一次全关 / 全开；单层请点左侧图例的每一项。默认显示。")
      : T("这次分析没有可叠的事件（跑一次 ▶ 后就有）");
    btn.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (btn.disabled) return;
      /* 这颗是「全关 / 全开」：还亮着就全关（记住各层选择）；已经全暗就全开 ——
         各层都被单独关掉时，点它也能一次都打开，不会出现"点了没反应" */
      const on = aaEvOnOf(node);
      const live = node.aaShowEvents !== false && AA_EV_KEYS.some((k) => on[k]);
      if (live) {
        node.aaShowEvents = false;
      } else {
        node.aaShowEvents = true;
        const all = {};
        for (const k of AA_EV_KEYS) all[k] = true;
        node.aaEvOn = all;
      }
      if (typeof scheduleSave === "function") scheduleSave();
      if (typeof onChange === "function") onChange();
    });
    return btn;
  }

  function aaFmtTime(sec) {
    const s = Math.max(0, Number(sec) || 0);
    const m = Math.floor(s / 60);
    const r = s - m * 60;
    return m + ":" + (r < 10 ? "0" : "") + r.toFixed(1);
  }

  /* ── 卡点闪拍要用的那几个数（做视频时真正会写进时间线的东西）──────────────────
     拍长 / 小节长 / 一拍几帧 / 闪几帧 / 整帧对齐会漂多少。
     一拍往往不是整帧（128 BPM @30fps = 14.06 帧），直接 round 会逐拍累积漂移 ——
     所以既给"帧"也给"每拍漂移"，让排时间线的人知道该 cumsum 取整还是直接用秒。 */

  /* 相邻切点至少隔这么多帧才看得出闪拍 / 转场；低于它就提示改 60 fps */
  const AA_MIN_CUT_GAP_FRAMES = 4;

  /* 帧号**唯一口径**：frameOf(t) = round((t + offsetMs/1000) × fps)。
     报告的帧号表、卡点参数、切点表与输出 0 的 JSON 全用这一份 ——
     一拍常常不是整帧（128 BPM@30fps = 14.06 帧），逐拍加固定帧数会越到后面越偏。 */
  function aaFrameOf(fpsHint, offsetHint) {
    const rawFps = Number(fpsHint);
    const fps = [24, 25, 30, 50, 60].indexOf(rawFps) >= 0 ? rawFps : 30;
    const rawOff = Number(offsetHint);
    const offsetMs = isFinite(rawOff) ? Math.max(-2000, Math.min(2000, Math.round(rawOff))) : 0;
    const frameOf = (t) => Math.round((Number(t) + offsetMs / 1000) * fps);
    frameOf.fps = fps;
    frameOf.offsetMs = offsetMs;
    return frameOf;
  }
  /** 节点口径的 frameOf（帧率 + 视觉偏移都从节点参数来） */
  function aaFrameOfNode(node) {
    return aaFrameOf(node && node.aaVideoFps, node && node.aaVisualOffsetMs);
  }

  function aaBeatParams(node, rep) {
    const r = rep || {};
    const g = r.global || {};
    const bg = r.beatGrid || {};
    const ts = g.timeSignature || {};
    const frameOf = aaFrameOfNode(node);
    const bpm = Number(g.bpm) || 0;
    const okFps = frameOf.fps;

    const beatSec = bpm > 0 ? 60 / bpm : Number(g.beatPeriodSec) || 0;
    const beatsPerBar = Number(ts.numerator) || Number(bg.barLength) || 4;
    const barSec = beatSec * beatsPerBar;
    const framesPerBeat = beatSec * okFps;
    const framesPerBar = barSec * okFps;
    /* 闪拍时长：约 1/5 拍（120 BPM 时 ≈3 帧 / 100 ms），钳在 2–6 帧——短了看不见，长了像频闪 */
    const flashFrames = Math.max(2, Math.min(6, Math.round(framesPerBeat * 0.2) || 2));
    const driftMsPerBeat = (framesPerBeat - Math.round(framesPerBeat)) * (1000 / okFps);
    const dnb = Array.isArray(bg.downbeatsSec) ? bg.downbeatsSec : [];
    return {
      ready: bpm > 0 && beatSec > 0,
      bpm,
      fps: okFps,
      beatsPerBar,
      beatSec,
      barSec,
      framesPerBeat,
      framesPerBar,
      flashFrames,
      driftMsPerBeat,
      downbeats: dnb.length,
      firstBeatSec: Number(bg.firstBeatSec) || 0,
      offsetMs: frameOf.offsetMs,
      frameOf,
    };
  }

  /** 板身上那行卡点参数（一行，可换行）：做闪拍 / 卡点剪辑要对着看的就是这几个数 */
  function aaVideoParamsRow(node, rep) {
    const p = aaBeatParams(node, rep);
    const row = document.createElement("div");
    row.className = "n-aa-evp";
    if (!p.ready) {
      row.classList.add("is-empty");
      row.textContent = T("卡点参数：等 BPM（跑一次 ▶ 后就有）");
      return row;
    }
    const bits = [
      p.bpm.toFixed(1) + " BPM",
      T("每拍 ") + p.beatSec.toFixed(3) + " s",
      T("每小节 ") + p.barSec.toFixed(3) + " s",
      p.fps + "fps " + T("每拍 ") + p.framesPerBeat.toFixed(1) + T(" 帧"),
      T("闪拍 ") + p.flashFrames + T(" 帧"),
      T("重拍 ") + p.downbeats,
    ];
    /* 视觉偏移非 0 时把它摆在这行里：排时间线的人一眼知道帧号已经挪过了 */
    if (p.offsetMs) bits.push(T("偏移 ") + aaSigned(p.offsetMs, 0) + " ms");
    row.textContent = T("卡点参数：") + bits.join(" · ");
    row.title = T(
      "做卡点闪拍时直接照这行排：拍长（秒）给时间线，帧数给逐帧工程；闪拍帧数 ≈ 1/5 拍（够亮一下、又不至于变频闪）。帧号一律 frame = round((t + 视觉偏移) × fps) 逐点算，别逐拍累加；漂移量见报告「视频卡点参数」。",
    );
    return row;
  }

  function aaMediaUrl(p) {
    try {
      if (typeof mediaFileUrlOf === "function") return mediaFileUrlOf(p);
    } catch (_) {}
    try {
      if (window.api && typeof window.api.toFileUrl === "function") return window.api.toFileUrl(p);
    } catch (_) {}
    return p;
  }

  /* ── 收纳态的两棵树：模板克隆（成本账 ② 的 DOM 部分）─────────────────────────
     折叠条是「1 个 button + 3 个 span」、报告行是「1 个 button + 3 个 span」，原先每颗节点
     每次重绘都要 createElement 组一遍（收纳态一屏几十颗就是几十 × 4 次建元素 + 挂子节点）。
     现在结构只在**第一次**建一份塞进 <template>，之后每颗节点 cloneNode(true) 一次就够；
     文案 / 类名 / 属性都在克隆件上原地改（用 children[i] 取固定槽位，模板结构是常量）。
     模板里不留任何节点数据与监听：监听只在克隆件上挂，语言切换也不受影响（文案每次重写）。 */
  let aaFoldTpl = null; /* <template> 里装着折叠条骨架 */
  let aaRepTpl = null; /* <template> 里装着报告行骨架 */

  /** 折叠条骨架：button.n-aa-fold > span.aa-fl-c + span.aa-fl-t + span.aa-fl-s */
  function aaFoldTemplate() {
    if (aaFoldTpl) return aaFoldTpl;
    const t = document.createElement("template");
    const b = aaEl("button", "n-aa-fold");
    b.type = "button";
    b.appendChild(aaEl("span", "aa-fl-c"));
    b.appendChild(aaEl("span", "aa-fl-t"));
    b.appendChild(aaEl("span", "aa-fl-s"));
    t.content.appendChild(b);
    aaFoldTpl = t;
    return t;
  }

  /** 报告行骨架：button.n-aa-report > span.aa-rp-ic + span.aa-rp-t + span.aa-rp-go */
  function aaRepTemplate() {
    if (aaRepTpl) return aaRepTpl;
    const t = document.createElement("template");
    const b = aaEl("button", "n-aa-report");
    b.type = "button";
    b.appendChild(aaEl("span", "aa-rp-ic"));
    b.appendChild(aaEl("span", "aa-rp-t"));
    b.appendChild(aaEl("span", "aa-rp-go"));
    t.content.appendChild(b);
    aaRepTpl = t;
    return t;
  }

  /* ── 收起 / 展开时的节点高度（成本账 ② 的第三件）──────────────────────────────
     收纳态 body 只剩折叠条 + 空槽 + 报告行，minHFor(audio_spectrum) = 280 就装得下，
     展开态多出来的高度（默认 380，用户手拖过的更高）在收纳时收掉、回到展开再还回去。
     **只动本节点自己的 n.h**：不碰 app.js 的 minHFor / clampNodeToMinSize / 手势 resize，
     也不碰组布局函数（组框跟着成员贴合是既有行为）。端子与连线按手拖 resize 的同一套收尾
     重排（refreshPorts / updateWires / updateGroupFrames）—— 只改 n.h 而不重排端子，
     连线才会错位，这也是「改高度安全」的评估结论依据。 */
  function aaNodeH(node) {
    const h = Math.round(Number(node && node.h) || 0);
    return h > 0 ? h : 0;
  }

  /** 收纳态的基准高度 = app.js 的 minHFor(audio_spectrum)；宿主函数取不到时回落 280 */
  function aaCollapsedH(node) {
    try {
      if (typeof minHFor === "function") {
        const m = Math.round(Number(minHFor(node)) || 0);
        if (m > 0) return m;
      }
    } catch (_) {}
    return 280;
  }

  /** 收起：记下展开高度、把高度收到最小。返回 true = 高度真的变了（要让组框重新贴合） */
  function aaFoldHeightCollapse(node) {
    if (!node) return false;
    const min = aaCollapsedH(node);
    const cur = aaNodeH(node);
    /* 已经不比最小高：不记（否则展开会把「本来就矮」的节点抬回去） */
    if (!(cur > min)) {
      node.aaHOpen = 0;
      return false;
    }
    node.aaHOpen = cur;
    node.h = min;
    return true;
  }

  /** 展开：还给 node.aaHOpen。收起后又手拖改高（比记下的值更高）则保留手拖值 */
  function aaFoldHeightOpen(node) {
    if (!node) return false;
    const want = Math.round(Number(node.aaHOpen) || 0);
    node.aaHOpen = 0;
    if (!(want > aaNodeH(node))) return false;
    node.h = want;
    return true;
  }

  /* ── 视图收纳（默认收起）────────────────────────────────────────────────
     用户口径：板身**默认不摆任何图像**（波形播放器 / 热力图 / 事件叠加层一个都不建），
     免得一张画布上放几颗频谱节点，就为了解码几张 1024×384 位图 + 跑一遍音频峰值而卡住；
     点这条折叠条才展开，展开状态记在节点上（node.aaViewOpen），重绘 / 重开画布都维持
     展开，不会自己缩回去。收纳时这条本身就是灰的（连结果都还没有时再灰一档）。 */
  function aaViewBar(node) {
    const open = node.aaViewOpen === true;
    const hasSpec = !!String(node.aaSpectrogram || "").trim();
    /* 一次 clone 拿整棵树（成本账 ②：不再 3 次 createElement 组树） */
    const btn = aaFoldTemplate().content.firstElementChild.cloneNode(true);
    btn.className =
      "n-aa-fold" + (open ? " is-open" : " is-off") + (hasSpec ? "" : " is-empty");
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    const sp = btn.children;
    sp[0].textContent = open ? "▾" : "▸";
    sp[1].textContent = T("波形与频谱");
    sp[2].textContent = open
      ? T("点一下收起")
      : hasSpec
        ? T("已收起 · 点开显示")
        : T("无内容 · 跑一次 ▶ 后显示");
    btn.title = open
      ? T("收起波形与频谱图：节点上不再绘制任何图像（默认收纳，避免多节点卡顿）")
      : T("展开波形播放器与频谱热力图（默认收纳：不绘制图像，省掉位图解码与叠加层重绘）");
    btn.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      node.aaViewOpen = !open;
      /* 收起 = 整块 DOM 拆掉：播放头 / 叠加层的登记先收干净，别留下对已脱离节点的每帧操作 */
      if (!node.aaViewOpen) {
        try {
          aaStopLive(node.id);
        } catch (_) {}
      }
      /* 高度：收起收到最小、展开还回去（只动本节点 n.h，见上面 aaFoldHeight* 的口径） */
      const hChanged = node.aaViewOpen
        ? aaFoldHeightOpen(node)
        : aaFoldHeightCollapse(node);
      if (typeof refreshNodeEl === "function") refreshNodeEl(node.id);
      /* refreshNodeEl 已重排端子与连线；组框不归它管，高度真变了才补一次（与手拖 resize 同一收尾） */
      if (hChanged && typeof updateGroupFrames === "function") {
        try {
          updateGroupFrames();
        } catch (_) {}
      }
    };
    btn.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    return btn;
  }

  /* ── 展开态重内容的可见性门控（上面「成本账 ①」的落地）───────────────────────
     展开分支不再「一展开就全套」：先只挂一块**轻占位**（纯 div，复用 .n-aa-spec /
     .n-aa-plot 的 aspect-ratio 把高度预留好，不画任何东西、不解码任何音频），由一只
     模块级 IntersectionObserver 判定 ——
       · 进了一屏（视口外扩一屏，与 renderer/app-preview-lazy.js 的 previewLazyMargin
         同口径：横竖各 max(320px, 窗口尺寸)）：才建波形播放器 / 频谱 img / 事件叠加
         canvas / ResizeObserver；
       · 离开一屏：aaStopLive + aaOverlayStop（复用收起时同一套收尾）后拆掉内容，
         占位装回来。
     node.aaViewOpen 的语义一动没动：它只决定「要不要这套东西」，回来了由观察器自动重建
     （重建不重新读文件、不重新解码：app-audioview.js 的 waveDecodeCache 按
     path|size|mtime 记着上次的峰值）。
     没有 IntersectionObserver 的运行时（老运行时 / 冒烟桩）退化成「挂上即建」，功能不缺。
     观察器以窗口为根（画布是 transform 平移，不是滚动容器 —— 与 preview-lazy 同一路判定），
     rootMargin 随窗口尺寸变，下次建 body 时按新值重建；不另外挂 resize 监听。 */
  const AA_VIS_MIN_MARGIN = 320; /* rootMargin 至少留这么多像素（同 previewLazyMargin） */
  let aaVisIo = null; /* IntersectionObserver（窗口为根，rootMargin ≈ 一屏） */
  let aaVisIoMargin = ""; /* 建它时用的 rootMargin：视口尺寸变了要重建 */
  /* 观察目标是 **body 本身**，不是那块占位：占位在挂上真内容时会被 display:none，那是个零尺寸
     盒子，IntersectionObserver 会立刻回一发 isIntersecting:false → 卸载把占位摆回来 → 又相交 →
     再挂 —— 一帧一轮的「挂载 / 卸载」循环，视觉上就是展开后疯狂闪烁。body 在节点活着的整个期间
     都有尺寸、从不隐藏，观察它才稳定；占位只当「真内容插在它前面」的锚点。 */
  const aaVisRecs = new Map(); /* 观察目标（body）-> rec（断开即删，不留悬挂记录） */
  const aaVisByNode = new Map(); /* node.id -> rec（body 换掉时按节点收干净） */

  /** rootMargin ≈ 一屏（横竖各一屏，最小 320px）：与 app-preview-lazy.js 的 previewLazyMargin 同口径 */
  function aaVisMargin() {
    const h = Math.max(AA_VIS_MIN_MARGIN, Number(window.innerHeight) || 0);
    const w = Math.max(AA_VIS_MIN_MARGIN, Number(window.innerWidth) || 0);
    return h + "px " + w + "px";
  }

  /** 建（或按新视口尺寸重建）观察器；重建时把还在观察的占位一并接上 */
  function aaVisEnsureIo() {
    if (typeof IntersectionObserver !== "function") return null;
    const margin = aaVisMargin();
    if (aaVisIo && aaVisIoMargin === margin) return aaVisIo;
    if (aaVisIo) {
      try {
        aaVisIo.disconnect();
      } catch (_) {}
    }
    aaVisIo = new IntersectionObserver(aaVisOnIntersect, {
      root: null,
      rootMargin: margin,
      threshold: 0,
    });
    aaVisIoMargin = margin;
    for (const obs of aaVisRecs.keys()) {
      try {
        aaVisIo.observe(obs);
      } catch (_) {}
    }
    return aaVisIo;
  }

  function aaVisOnIntersect(entries) {
    for (const e of entries) {
      const obs = e.target;
      const rec = aaVisRecs.get(obs);
      if (!rec || rec.dead) continue;
      /* 观察目标或占位已不在文档里（body 被换掉 / 节点被删）：当场解除观察，不留悬挂记录 */
      if (!obs.isConnected || !rec.ph.isConnected) {
        aaVisRecs.delete(obs);
        if (aaVisIo) {
          try {
            aaVisIo.unobserve(obs);
          } catch (_) {}
        }
        continue;
      }
      if (e.isIntersecting && !aaLodMiniOn()) aaVisMount(rec);
      else aaVisUnmount(rec);
    }
  }

  /** 扫掉「观察目标已经不在文档里」的登记：节点被删时观察器不会再有回调，只能靠这里收。
      每次建 body 顺手扫一遍（表很小，成本可忽略），不额外挂 MutationObserver。 */
  function aaVisPrune() {
    if (!aaVisRecs.size) return;
    for (const [obs, rec] of Array.from(aaVisRecs)) {
      if (rec.dead || (obs.isConnected && rec.ph.parentNode)) continue;
      rec.dead = true;
      rec.built = null;
      aaVisRecs.delete(obs);
      if (aaVisByNode.get(rec.node.id) === rec) aaVisByNode.delete(rec.node.id);
      if (aaVisIo) {
        try {
          aaVisIo.unobserve(obs);
        } catch (_) {}
      }
    }
  }

  /** body 被换掉 / 节点收起：把这一轮手上的观察与登记放掉。
      这里**不动播放**（重绘不断播，与 aaViewBar 收起时的口径一致）；旧 body 里的节点
      已经不在文档里，跟着那块 body 一起作废，不用逐个再摘。 */
  function aaVisForget(nodeId) {
    const rec = aaVisByNode.get(nodeId);
    if (!rec) return;
    rec.dead = true;
    rec.built = null;
    aaVisByNode.delete(nodeId);
    aaVisRecs.delete(rec.obs || rec.ph);
    if (aaVisIo) {
      try {
        aaVisIo.unobserve(rec.obs || rec.ph);
      } catch (_) {}
    }
    /* 播放头 / 叠加层先收掉：新一轮建起来时会重新登记，不收就会留下指向已脱离 DOM 的登记 */
    try {
      aaStopLive(nodeId);
    } catch (_) {}
  }

  /** 进了一屏：建真内容（插在占位之前），占位收起来但仍留在原地当锚点 */
  function aaVisMount(rec) {
    if (!rec || rec.dead || rec.built) return;
    /* 缩略总览下不建（成本账 ③）：没有 IntersectionObserver 的运行时这里是唯一入口，
       总览里建起来就是白付一次解码 / 一张位图纹理；回到普通档由 aaLodRestore 重新判可见性 */
    if (aaLodMiniOn()) return;
    const built = [];
    const host = rec.ph.parentNode || rec.body;
    const put = (el) => {
      try {
        host.insertBefore(el, rec.ph);
      } catch (_) {
        rec.body.appendChild(el);
      }
      built.push(el);
    };
    try {
      aaBuildHeavy(rec.node, put);
    } catch (_) {}
    rec.built = built;
    try {
      rec.ph.style.display = "none"; /* 内容顶上来了：占位不再占高度 */
    } catch (_) {}
  }

  /** 离开一屏：收干净再拆内容，占位装回来（高度按 aspect-ratio 立刻就有，节点不塌） */
  function aaVisUnmount(rec) {
    if (!rec || rec.dead || !rec.built) return;
    const node = rec.node;
    /* 复用既有收尾口径（与 aaViewBar 收起时同一套）：
       aaStopLive = 播放头从全局 ticker 注销 + aaOverlayStop（断掉叠加层的 ResizeObserver / rAF） */
    try {
      aaStopLive(node.id);
    } catch (_) {}
    try {
      aaOverlayStop(node.id);
    } catch (_) {}
    for (const el of rec.built) {
      /* 正在播的那只：外壳马上要拆，先把引擎停下（否则音频还在响、UI 已经没了）。
         只停「真在播」的这一只，别的节点不受影响（waveStopPlayback 只收自己持有的引擎）。 */
      try {
        if (typeof wavePreviewPlayingOf === "function" && wavePreviewPlayingOf(el)) {
          if (typeof waveStopPlayback === "function") waveStopPlayback(el);
        }
      } catch (_) {}
      try {
        el.remove();
      } catch (_) {}
    }
    rec.built = null;
    try {
      rec.ph.style.display = "";
    } catch (_) {}
  }

  /** 展开态的轻占位：只把「频谱 + 波形」那几块的高度按 .n-aa-spec / .n-aa-plot 的
      aspect-ratio 预留出来，纯 div、不画任何东西（真内容进了一屏才建） */
  function aaVisPlaceholder() {
    const ph = aaEl("div", "n-aa-ph");
    ph.title = T("波形与频谱将在进入可见范围时载入（滚到一屏之内即显示）");
    const spec = aaEl("div", "n-aa-spec");
    spec.appendChild(aaEl("div", "n-aa-plot"));
    ph.appendChild(spec);
    return ph;
  }

  /** 挂轻占位并登记观察；没有 IntersectionObserver 就当场建真内容（功能不缺） */
  function aaVisGate(node, body) {
    aaVisPrune(); /* 顺手把「节点已被删」的旧登记扫掉 */
    const ph = aaVisPlaceholder();
    /* 观察 body（不是 ph）：ph 在挂上真内容时会 display:none，零尺寸盒子会被 IO 判成
       「不相交」，于是卸载 → 占位回来 → 相交 → 再挂，一帧一轮地闪（见 aaVisRecs 的注释）。 */
    const rec = { node, body, ph, obs: body, built: null, dead: false };
    aaVisRecs.set(rec.obs, rec);
    aaVisByNode.set(node.id, rec);
    body.appendChild(ph);
    const io = aaVisEnsureIo();
    if (!io) {
      aaVisMount(rec);
      return rec;
    }
    try {
      io.observe(rec.obs);
    } catch (_) {}
    return rec;
  }

  /* ── 缩略总览（lod-mini）下强制卸载（上面「成本账 ③」的落地）─────────────────
     css/canvas.css 在 `#canvas.lod-mini` 下把 .n-body 设成 visibility: hidden —— 缩到总览时
     DOM 一个没少，展开态节点照样握着频谱位图纹理、解码后的 PCM 与叠加层观察器。
     app.js 的 syncNodeLod 切档时会在 document 上广播 mtnode:lod-mini（只在类名真的翻转时
     发一次，平移 / 缩放途中不发），这里接住：
       · 进缩略总览：全部登记节点走 aaStopLive（播放头注销 + 叠加层 ResizeObserver / rAF 收掉）
         再 aaVisUnmount 拆掉重内容 —— 折叠条、空槽、报告入口这些轻元素原样留在 body 里，
         节点的位置 / 尺寸 / 连线一概不动；
       · 回普通档：**不自己建**，把还在等内容的占位重新 observe 一次，交回 ① 的
         IntersectionObserver 判可见性（IO 对新观察的元素必发一次初始回调，等于当场判一遍）；
         没有 IO 的运行时「挂上即建」，功能不缺。
     没有这个事件（别的宿主 / 冒烟桩）时行为与改前一致：只由 ① 的观察器管。 */

  /** 当前是否缩略总览：以 #canvas 上的类为权威（事件漏一次也不会判错） */
  function aaLodMiniOn() {
    try {
      const cv = document.getElementById("canvas");
      if (cv && cv.classList) return cv.classList.contains("lod-mini");
    } catch (_) {}
    return aaLodMiniState === true;
  }

  /** 进缩略总览：全部登记节点收掉重内容（折叠条这类轻元素不动） */
  function aaLodDropHeavy() {
    for (const rec of Array.from(aaVisByNode.values())) {
      if (!rec || rec.dead) continue;
      const node = rec.node;
      /* 登记了播放头 / 叠加层的节点先收干净（aaVisUnmount 里也会收一次，这里覆盖
         「还没建真内容但登记过」的那一类） */
      try {
        aaStopLive(node && node.id);
      } catch (_) {}
      if (rec.built) aaVisUnmount(rec);
    }
  }

  /** 回普通档：把「还没有内容」的登记重新观察一次，可见性仍由观察器判 */
  function aaLodRestore() {
    const io = aaVisEnsureIo();
    for (const rec of Array.from(aaVisByNode.values())) {
      if (!rec || rec.dead || rec.built) continue;
      if (!io) {
        aaVisMount(rec); /* 没有 IO 的运行时：挂上即建 */
        continue;
      }
      try {
        const obs = rec.obs || rec.ph;
        io.unobserve(obs); /* 先断开再连：强制 IO 重新发一次初始回调 */
        io.observe(obs);
      } catch (_) {}
    }
  }

  /** 切档落地（同一个档位重复来只做一次） */
  function aaLodApply(mini) {
    const on = mini === true;
    if (on === aaLodMiniState) return;
    aaLodMiniState = on;
    if (on) aaLodDropHeavy();
    else aaLodRestore();
  }

  /** 接 app.js 的切档广播（模块加载时绑一次） */
  function aaLodBind() {
    if (aaLodBound) return;
    if (typeof document === "undefined" || !document.addEventListener) return;
    aaLodBound = true;
    try {
      document.addEventListener("mtnode:lod-mini", (ev) => {
        const d = (ev && ev.detail) || {};
        aaLodApply(d.mini === true);
      });
    } catch (_) {}
    /* 绑定时可能已经在缩略总览里（静默加载画布时缩放就已经很小）：按 DOM 判一次，
       别把「事件来之前就建起来」的重内容留在总览下 */
    if (aaLodMiniOn()) aaLodApply(true);
  }

  /** 建展开态的重内容：波形播放器 + 频谱（图 / 事件叠加层 / 播放头 / 图例 / 卡点参数）。
      put(el) 决定挂到哪儿 —— 门控命中时插在占位之前，退化时就是直接 append。 */
  function aaBuildHeavy(node, put) {
    const path = aaInputPath(node);

    /* 波形播放器（点波形任意位置就能从那里试听；切节点 / 重绘不断播）。
       **只挂音源、不立刻读波形**（lazy）：外壳与时间 / 时长占位先出来，峰值交给
       app-audioview.js 的全局 FIFO 队列 —— 一屏之内 + 空闲才取，多颗节点同时展开
       不并发解码；用户点播放 / 点波形 / 点频谱时把它提到队首（不等空闲）。 */
    let waveEl = null;
    if (typeof wavePreviewCreate === "function") {
      waveEl = wavePreviewCreate("aa-wave-" + node.id);
      try {
        if (path) wavePreviewSetSource(waveEl, path, "", { lazy: true });
        else wavePreviewSetSource(waveEl, "");
      } catch (_) {}
      put(waveEl);
    } else {
      const hint = document.createElement("div");
      hint.className = "n-empty";
      hint.textContent = T("波形播放器未加载（renderer/app-audioview.js）");
      put(hint);
    }

    /* 频谱：频谱图 + 播放头 → 图例（每层可单独开关）+ 卡点参数行
       叠加层（重拍 / 能量直方图）就铺在频谱图上，不再单独占一条带
       （没有结果时给一句「跑一次就有了」） */
    const specPath = String(node.aaSpectrogram || "").trim();
    if (specPath) {
      const spec = document.createElement("div");
      spec.className = "n-aa-spec";
      spec.title = T(
        "热力图频谱：横轴时间、纵轴频率、亮处=能量强。播放时竖线跟着走。图上叠了事件层：黄色柱=能量直方图（每小节一根）、青色齿=重拍，颜色与形状见下方图例（每一项都能单独关）；播放头的呼吸由相位连续驱动（每拍一次 0→1→0 的正弦），跨过重拍时再额外变色变粗强调一下。",
      );
      /* ① 频谱图 + 事件叠加层 + 播放头 + 时间读数（同一块坐标系，播放头与拍点天然对齐） */
      const plot = document.createElement("div");
      plot.className = "n-aa-plot";
      const img = document.createElement("img");
      /* ?t= 只在 node.ranAt 真有值时才拼（= 这一轮跑完的时刻）：同一次 body 重建内 ranAt 不变，
         所以重建多少次都得到同一个 URL，浏览器直接吃缓存位图，不额外发请求 / 不解码第二遍。
         ranAt 只在这颗节点「成功跑完」时写、起跑时清 0（见 playAudioAnalysisNode），
         中途的进度 / 状态更新一律就地改文本、不重建节点，所以不会凭空换 URL。 */
      img.src = aaMediaUrl(specPath) + (node.ranAt ? "?t=" + node.ranAt : "");
      img.alt = T("频谱图");
      img.draggable = false;
      /* 解码异步化：不抢主线程、不阻塞节点首帧（盒子高度已由 .n-aa-plot 的 aspect-ratio 预留） */
      img.decoding = "async";
      plot.appendChild(img);
      /* 叠加层铺在频谱图上（pointer-events:none，点穿到频谱，点哪试听照旧）；
         尺寸要等图片布局出来才算得准 —— 首帧量不到就下一帧再试（最多 12 帧，约 200 ms） */
      const evCanvas = document.createElement("canvas");
      evCanvas.className = "n-aa-events";
      plot.appendChild(evCanvas);
      const head = document.createElement("div");
      head.className = "n-aa-head";
      plot.appendChild(head);
      /* 时间读数放图例那行（压在图里会盖住底边的重拍齿） */
      const time = document.createElement("div");
      time.className = "n-aa-time";
      time.textContent = "0:00.0 / " + aaFmtTime(node.aaDurationSec);
      spec.appendChild(plot);
      /* ② 图例（每项一颗开关）+ 时间读数 +「事件」总开关：只切这些层，不重画节点、不打断播放 */
      spec.appendChild(aaEventBar(node, spec, evCanvas, time));
      /* ③ 卡点参数（拍长 / 小节长 / 帧数 / 闪拍帧数）：做卡点闪拍时对着排的那几个数 */
      spec.appendChild(aaVideoParamsRow(node, aaReportOf(node)));
      /* 点频谱 = 从该处试听（按频谱自己的坐标算比例，别借波形盒的坐标 —— 两者左边不对齐）；
         只绑 plot，点图例 / 开关不跳播放位置 */
      plot.addEventListener("pointerdown", (ev) => {
        ev.stopPropagation();
        if (!waveEl || typeof wavePreviewSeekTo !== "function") return;
        ev.preventDefault();
        const r = plot.getBoundingClientRect();
        if (!(r.width > 0) || !(node.aaDurationSec > 0)) return;
        const x = Math.max(0, Math.min(r.width, Number(ev.clientX) - r.left));
        wavePreviewSeekTo(waveEl, (x / r.width) * node.aaDurationSec);
      });
      plot.addEventListener("click", (ev) => ev.stopPropagation());
      put(spec);
      /* 播放头 / 时间读数的元素引用在这里（建 DOM 时）就传下去，播放期不再 querySelector */
      if (waveEl) aaBindPlayhead(node, waveEl, spec, node.aaDurationSec, { headEl: head, timeEl: time });
      /* 叠加层的重绘统一入口：首帧 / 图片加载 / 尺寸变化都走它（同一帧只画一次，整数尺寸
         真变才画）。**放在 aaBindPlayhead 之后**：那是唯一会在这里 aaStopLive 的地方，
         它会连带收掉上一轮的登记，先建会被自己清掉。 */
      const evPaint = aaOverlayPainter(spec, evCanvas, node, img);
      img.addEventListener("load", () => evPaint.imageLoaded());
      evPaint.observe(plot);
      evPaint.request();
    } else {
      const hint = document.createElement("div");
      hint.className = "n-empty";
      hint.textContent = T("跑一次 ▶ 后这里显示热力图频谱（与波形播放器同步）");
      put(hint);
    }
  }

  function aaAppendBody(node, body) {
    aaNormalize(node);

    /* 上一轮 body 已经换掉（重绘 / 重开画布 / 切参数 / 收起）：先把观察与登记放干净。
       状态落点的登记同理（成本账 ④）：旧 body 里那几只元素已经不在文档里，整份作废，
       下面 aaReportRow 建新的时候会重新登记。 */
    aaVisForget(node.id);
    aaStatusForget(node);

    /* ① 折叠条（永远在）。收纳 = 下面什么都不建：波形播放器 / 热力图 img / 事件叠加 canvas
       / 内容观测器全都不创建，节点上零图像 → 零解码、零重排。
       收纳时补一块**灰的空槽**占住图像区（纯 div，不画任何东西），这样 380 高的节点不会
       只剩一条细线 + 一大片空 body，看着像坏了。 */
    body.appendChild(aaViewBar(node));
    if (node.aaViewOpen !== true) {
      const pad = aaEl("div", "n-aa-pad");
      pad.title = T("图像区已收纳（点上面的「波形与频谱」展开）");
      body.appendChild(pad);
      body.appendChild(aaReportRow(node));
      return;
    }

    /* ② 展开态的「重内容」不再无条件建：先只挂轻占位（不建任何图像、不解码任何音频），
       进了一屏才由观察器建波形播放器 / 频谱 / 叠加层（成本账 ① 见文件头）。
       node.aaViewOpen 的语义不变：它只管「要不要这套东西」，回来自动重建。 */
    aaVisGate(node, body);

    /* ③ 分析报告入口（body 里唯一的一行文字）：报告本身在大窗 dialogue 里看 ——
       摘要 / 输入提示 / ⚙ 参数摘要 / 状态行都已按用户口径从 body 移除。 */
    body.appendChild(aaReportRow(node));
  }

  /* ══ 分析报告（dialogue）══════════════════════════════════════════════
     用户口径：body 只留波形 / 频谱，报告点开在大窗里看，且报告要「结构清晰、
     内容完整、便于浏览、美观」。所以这里做的是**一份排版过的报告**，不是把
     JSON 直接糊上去：
       ① 顶部 KPI 卡（时长 / BPM / 拍点 / 网格 / 小节）+ 来源与解码信息
       ② 两列卡片：节奏与网格 · 小节与能量 · 事件与切点 ‖ 能量相位 ·
          视频卡点参数 · 警告与诊断 · 产物与文件
     **不出现段落 / 曲式命名**（前奏 / 主歌 / 副歌这类判断不准确）：报告只给
     拍点、小节、onset、能量相位与实测电平台阶这些从信号里量出来的底层量。
     数据源就是输出 0 的那份自描述摘要（node.output.text）—— 不再落第二份存档，
     也不会因为重开窗多打一次后端。窗脚给「复制 JSON / 打开完整 JSON / 关闭」。 */

  const AA_DRUM_CN = { kick: "底鼓", snare: "军鼓", hat: "踩镲", perc: "打击乐", glitch: "故障音", unknown: "未识别" };
  const AA_PHASE_CN = { VOID: "静默", LOW: "低能量", MEDIUM: "中能量", HIGH: "高能量" };
  const AA_CAND_CN = {
    beatTrack: "拍轨",
    medianInterBeat: "中位拍间隔",
    tempogram: "自相关",
    foldRefine: "倍频纠正",
    userHint: "调用方先验",
  };
  const AA_VIZ_CN = {
    spectrogram: "频谱热力图",
    beatOverlay: "拍点叠加",
    waveform: "波形",
    energyCurve: "能量曲线",
  };
  
  function aaEl(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null && text !== "") e.textContent = String(text);
    return e;
  }
  function aaIsNode(v) {
    try {
      return typeof Node !== "undefined" && v instanceof Node;
    } catch (_) {
      return false;
    }
  }
  function aaFmtDur(sec) {
    const s = Math.max(0, Number(sec) || 0);
    const m = Math.floor(s / 60);
    const r = Math.floor(s - m * 60);
    return m + ":" + (r < 10 ? "0" : "") + r;
  }
  function aaNum(v, digits) {
    const n = Number(v);
    if (!isFinite(n)) return "—";
    return n.toFixed(digits == null ? 1 : digits);
  }
  function aaPct(v) {
    const n = Number(v);
    if (!isFinite(n)) return "—";
    return Math.round(n * 100) + "%";
  }
  function aaSigned(v, digits) {
    const n = Number(v);
    if (!isFinite(n)) return "—";
    return (n >= 0 ? "+" : "") + n.toFixed(digits == null ? 1 : digits);
  }
  function aaBytesText(b) {
    const n = Number(b) || 0;
    if (!n) return "—";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
    return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
  }

  /* ── 摘要 JSON 的节点级单槽记忆 ─────────────────────────────────────────
     一次 body 构建里 aaEventLayers / aaMarkTimes / aaBeatClock / aaEventBar /
     aaVideoParamsRow / aaPaintEventOverlay 读的都是**同一份**摘要 —— 原先每处各
     JSON.parse 一遍整份摘要，还要各自重排小节表、重算 rmsDb 的 p5–p95 分位。
     现在整份只解析一次，派生物（小节表 / 事件层 / 分位区间）存同一格、一起失效。

     键 = 输出文本的字符串值 + node.ranAt（跑完一次、结果被改写都会换键）。
     缓存挂在 WeakMap 上、键就是 node 本身：不在 node 之外持有任何强引用，节点被
     丢掉时整格跟着回收；也不往 node 上加字段，所以不会混进落盘的 JSON。 */
  const aaMemoMap = new WeakMap(); /* node -> { text, ranAt, rep, bars, layers, dbNorm } */

  function aaMemoOf(node) {
    if (!node || typeof node !== "object") return null;
    const text = node.output && node.output.kind === "text" ? String(node.output.text || "") : "";
    const ranAt = Number(node.ranAt) || 0;
    const cur = aaMemoMap.get(node);
    if (cur && cur.text === text && cur.ranAt === ranAt) return cur;
    const m = { text, ranAt, rep: null, bars: null, layers: null, dbNorm: null };
    if (text) {
      try {
        const o = JSON.parse(text);
        if (o && typeof o === "object") m.rep = o;
      } catch (_) {}
    }
    aaMemoMap.set(node, m);
    return m;
  }

  /** 报告的数据源：输出 0 的那份摘要 JSON（解析失败 / 空文本 = 没有报告）。
      走 aaMemoOf：同一份摘要只解析一次，多次调用拿到的是**同一个对象**。 */
  function aaReportOf(node) {
    const m = aaMemoOf(node);
    return m ? m.rep : null;
  }

  /** 摘要里的小节表（aaBarsOf 归一后）：报告主体与事件层共用同一份，不再各归一一次。
      rep 不是当前记忆的那一份（理论上不发生，防御性）就当场归一。 */
  function aaBarsOfRep(node, rep) {
    const m = aaMemoOf(node);
    const r = rep || null;
    if (m && m.rep && m.rep === r) {
      if (!m.bars) m.bars = aaBarsOf((m.rep.beatGrid || {}).bars);
      return m.bars;
    }
    return aaBarsOf((r && r.beatGrid ? r.beatGrid : {}).bars);
  }

  function aaKpi(label, value, sub) {
    const c = aaEl("div", "aa-kpi");
    c.appendChild(aaEl("div", "aa-kpi-l", label));
    c.appendChild(aaEl("div", "aa-kpi-v", value));
    if (sub) c.appendChild(aaEl("div", "aa-kpi-s", sub));
    return c;
  }
  function aaChip(text, cls) {
    return aaEl("span", "aa-chip" + (cls ? " " + cls : ""), text);
  }
  function aaCard(title, hint) {
    const c = aaEl("section", "aa-card");
    const h = aaEl("header", "aa-card-h");
    h.appendChild(aaEl("h4", "", title));
    if (hint) h.appendChild(aaEl("span", "aa-card-hint", hint));
    c.appendChild(h);
    return c;
  }
  function aaSub(text) {
    return aaEl("div", "aa-sub", text);
  }
  function aaDl(rows) {
    const dl = aaEl("div", "aa-dl");
    for (const r of rows) {
      if (!r) continue;
      const v = r[1];
      if (v == null || v === "" || v === "—") continue;
      const row = aaEl("div", "aa-dl-row");
      row.appendChild(aaEl("span", "aa-dl-k", r[0]));
      const val = aaEl("span", "aa-dl-v");
      if (aaIsNode(v)) val.appendChild(v);
      else val.textContent = String(v);
      row.appendChild(val);
      dl.appendChild(row);
    }
    return dl;
  }
  function aaTable(head, rows, cap) {
    const wrap = aaEl("div", "aa-tbl-wrap");
    const t = aaEl("table", "aa-tbl");
    const tr = aaEl("tr");
    for (const h of head) tr.appendChild(aaEl("th", "", h));
    const thead = aaEl("thead");
    thead.appendChild(tr);
    t.appendChild(thead);
    const tb = aaEl("tbody");
    const keep = cap ? rows.slice(0, cap) : rows;
    for (const row of keep) {
      const r = aaEl("tr");
      for (const cell of row) {
        const td = aaEl("td");
        if (aaIsNode(cell)) td.appendChild(cell);
        else td.textContent = cell == null ? "" : String(cell);
        r.appendChild(td);
      }
      tb.appendChild(r);
    }
    t.appendChild(tb);
    wrap.appendChild(t);
    if (cap && rows.length > cap) wrap.title = T("表里只列前 ") + cap + T(" 条（共 ") + rows.length + T(" 条）");
    return wrap;
  }

  /** 报告主体：整份 DOM（不碰 #ovBody，调用方负责挂） */
  function aaReportDom(rep, node) {
    const root = aaEl("div", "aa-rep");
    const src = rep.source || {};
    const g = rep.global || {};
    const bg = rep.beatGrid || {};
    const on = rep.onsets || {};
    const en = rep.energy || {};
    const diag = rep.diagnostics || {};
    const edit = rep.edit || {};
    const bars = aaBarsOfRep(node, rep);
    const dnb = Array.isArray(bg.downbeatsSec) ? bg.downbeatsSec : [];
    const dur = Number(src.durationSec) || 0;
    const ts = g.timeSignature || {};

    /* ① 概览 */
    const hero = aaEl("div", "aa-rep-hero");
    const kpis = aaEl("div", "aa-kpis");
    kpis.appendChild(aaKpi(T("时长"), dur ? aaFmtDur(dur) : "—", dur ? aaNum(dur, 1) + T(" 秒") : ""));
    kpis.appendChild(
      aaKpi(
        "BPM",
        g.bpm ? aaNum(g.bpm, 2) : "—",
        g.bpm
          ? T("置信度 ") + aaPct(g.bpmConfidence) + (g.tempoVerified ? T(" · 已交叉验证") : T(" · 未交叉验证"))
          : "",
      ),
    );
    kpis.appendChild(
      aaKpi(
        T("拍点"),
        bg.beatCount ? String(bg.beatCount) : "—",
        dnb.length ? dnb.length + T(" 个重拍") : T("未判出重拍"),
      ),
    );
    kpis.appendChild(aaKpi(T("网格可信度"), aaPct(bg.gridConfidence), T("校准 ") + aaSigned(bg.gridCalibrationMs, 2) + " ms"));
    kpis.appendChild(
      aaKpi(T("小节"), bars.length ? String(bars.length) : "—", ts.numerator ? ts.numerator + "/" + (ts.denominator || 4) : T("拍号未判定")),
    );
    hero.appendChild(kpis);

    const srTxt = src.sampleRateHz
      ? (Number(src.sampleRateHz) / 1000).toFixed(1) +
        " kHz" +
        (src.sourceSampleRateHz && Number(src.sourceSampleRateHz) !== Number(src.sampleRateHz)
          ? T("（源 ") + (Number(src.sourceSampleRateHz) / 1000).toFixed(1) + " kHz）"
          : "")
      : "—";
    hero.appendChild(
      aaDl([
        [T("文件"), String(src.path || "").split(/[\\/]/).pop() || "—"],
        [T("容器 / 采样率"), (src.container || "—") + " · " + srTxt],
        [T("大小"), aaBytesText(src.bytes)],
        [T("解码器"), (src.decoder && (src.decoder.version || src.decoder.ffmpeg)) || "—"],
        [T("分析时间"), src.analyzedAt || "—"],
        [T("缓存"), diag.cache ? (diag.cache.hit ? T("命中") : T("未命中")) + (diag.cache.key ? " · " + diag.cache.key : "") : "—"],
      ]),
    );
    root.appendChild(hero);

    /* ② 两列卡片 */
    const cardTempo = aaCard(T("节奏与网格"), g.tempoVerified ? T("四路交叉验证通过") : T("未通过交叉验证 · 仅供参考"));
    cardTempo.appendChild(
      aaDl([
        ["BPM", aaNum(g.bpm, 2) + (g.beatPeriodSec ? T(" · 每拍 ") + aaNum(g.beatPeriodSec, 3) + " s" : "")],
        [
          T("拍号"),
          (ts.numerator || "?") +
            "/" +
            (ts.denominator || 4) +
            (ts.confidence != null ? " · " + aaPct(ts.confidence) : "") +
            (ts.method && ts.method !== "none" ? " · " + ts.method : ""),
        ],
        [T("重拍相位"), g.downbeatPhase != null ? T("第 ") + (Number(g.downbeatPhase) + 1) + T(" 拍") : "—"],
        [T("首拍"), aaFmtTime(bg.firstBeatSec)],
        [T("重拍方法"), String(bg.downbeatMethod || "none")],
        [T("网格校准"), aaSigned(bg.gridCalibrationMs, 2) + " ms"],
      ]),
    );
    const cands = Array.isArray(g.bpmCandidates) ? g.bpmCandidates : [];
    if (cands.length) {
      cardTempo.appendChild(aaSub(T("候选速度（诊断半速 / 倍速误判用）")));
      cardTempo.appendChild(
        aaTable(
          [T("来源"), "BPM", T("分数")],
          cands.map((x) => [AA_CAND_CN[x.source] ? T(AA_CAND_CN[x.source]) : x.source || "—", aaNum(x.bpm, 2), x.score != null ? aaNum(x.score, 2) : "—"]),
        ),
      );
    }

    /* 小节与能量：都是直接量出来的底层量（每小节拍数 / RMS / 低频电平），
       不做段落 / 曲式命名 —— 那类判断不可靠，交给更高级的模型去做 */
    const cardBars = aaCard(
      T("小节与能量"),
      T(bars.length > 40 ? "前 40 小节 · 共 " : "共 ") + bars.length + T(" 小节"),
    );
    const beatsSec = Array.isArray(bg.beatsSec) ? bg.beatsSec : [];
    const bchips = aaEl("div", "aa-chips");
    bchips.appendChild(aaChip(T("拍点 ") + (bg.beatCount || beatsSec.length || 0)));
    bchips.appendChild(aaChip(T("重拍 ") + dnb.length));
    bchips.appendChild(aaChip(T("小节 ") + bars.length));
    if (bg.downbeatMethod && bg.downbeatMethod !== "none") bchips.appendChild(aaChip(String(bg.downbeatMethod)));
    cardBars.appendChild(bchips);
    if (bars.length) {
      cardBars.appendChild(
        aaTable(
          ["#", T("起止"), T("拍数"), "RMS dB", T("低频占比")],
          bars.map((b, i) => [
            String(i + 1),
            aaFmtTime(b.startSec) + " – " + aaFmtTime(b.endSec),
            String(Number(b.beatCountInBar) || 0),
            b.rmsDb != null ? aaNum(b.rmsDb, 1) : "—",
            b.lowDb != null && b.rmsDb != null ? aaSigned(Number(b.lowDb) - Number(b.rmsDb), 1) + " dB" : "—",
          ]),
          40,
        ),
      );
    }

    const cardEvt = aaCard(T("事件与切点"), T("事件密度 ") + aaNum(on.ratePerSec, 2) + T(" /秒"));
    const evs = Array.isArray(on.events) ? on.events : [];
    const drums = {};
    evs.forEach((e) => {
      const k = (e && e.drum) || "unknown";
      drums[k] = (drums[k] || 0) + 1;
    });
    const chips = aaEl("div", "aa-chips");
    chips.appendChild(aaChip(T("事件 ") + (on.count || 0)));
    if (on.limit) chips.appendChild(aaChip(T("上限 ") + on.limit));
    if (on.truncated) chips.appendChild(aaChip(T("已按上限截断"), "warn"));
    Object.keys(drums)
      .sort((a, b) => drums[b] - drums[a])
      .forEach((k) => chips.appendChild(aaChip((AA_DRUM_CN[k] ? T(AA_DRUM_CN[k]) : k) + " " + drums[k])));
    cardEvt.appendChild(chips);
    /* 段落派生的切点 / 强调点一律不列（段落判断已移除），只留拍点 / 重拍 / onset 那一层 */
    const cps = (Array.isArray(edit.cutPoints) ? edit.cutPoints : [])
      .filter((x) => (x && x.snap) !== "section")
      .sort((a, b) => Number(a && a.t) - Number(b && b.t));
    if (cps.length) {
      /* 帧号一律走同一个 frameOf（帧率 + 视觉偏移来自 ⚙）；相邻切点挨太近（<4 帧）的行标黄 */
      const cFrame = aaFrameOfNode(node);
      const frames = cps.map((x) => cFrame(x && x.t));
      const gaps = frames.map((f, i) => (i === 0 ? null : f - frames[i - 1]));
      const tight = gaps.filter((g) => g != null && g < AA_MIN_CUT_GAP_FRAMES).length;
      cardEvt.appendChild(
        aaSub(
          T("建议切点（共 ") +
            cps.length +
            T(" 条 · 这里列前 20）") +
            " · " +
            T("帧号 = 实际触发帧 = round((t + 偏移) × fps)"),
        ),
      );
      cardEvt.appendChild(
        aaTable(
          [T("时间"), T("网格位"), T("强度"), T("帧号"), T("相邻间隔")],
          cps.map((x, i) => {
            const g = gaps[i];
            const flag = g != null && g < AA_MIN_CUT_GAP_FRAMES;
            return [
              aaFmtTime(x.t),
              String(x.snap || "—"),
              aaNum(x.strength, 2),
              String(frames[i]),
              g == null ? "—" : flag ? aaEl("span", "aa-warn-code", "⚠ " + g + T(" 帧")) : g + T(" 帧"),
            ];
          }),
          20,
        ),
      );
      if (tight) {
        const ul = aaEl("ul", "aa-warns");
        const li = aaEl("li", "aa-warn");
        li.appendChild(aaEl("code", "aa-warn-code", "CUT-TOO-CLOSE"));
        li.appendChild(
          aaEl(
            "span",
            "aa-warn-msg",
            T("相邻切点间隔 <4 帧：共 ") +
              tight +
              T(" 对（当前 ") +
              cFrame.fps +
              T(" fps）：两个切点落在同一帧或相邻帧上，闪拍 / 转场来不及显示。把帧率改到 60 fps 再排，或者把切点拉开。"),
          ),
        );
        ul.appendChild(li);
        cardEvt.appendChild(ul);
      }
    }
    /* 重音（edit.accents）不再展示：字段仍留在摘要 JSON 里（别的链路在用），报告只列切点 */
    const tiers = Array.isArray(edit.shotDurationTiers) ? edit.shotDurationTiers : [];
    if (tiers.length) {
      cardEvt.appendChild(aaSub(T("镜头时长档（按拍数换算）")));
      cardEvt.appendChild(
        aaTable(
          [T("档位"), T("秒数"), T("用途")],
          tiers.map((x) => [String(x.name || "—"), aaNum(x.minSec, 2) + " – " + aaNum(x.maxSec, 2) + " s", String(x.useCase || "")]),
        ),
      );
    }

    const cardEng = aaCard(T("能量与相位"), T("每 ") + aaNum(en.hopSec, 2) + T(" 秒一格"));
    cardEng.appendChild(
      aaDl([
        [T("全局电平"), en.globalDb != null ? aaNum(en.globalDb, 1) + " dB" : "—"],
        [T("能量点"), (en.points || 0) + T(" 点")],
      ]),
    );
    const phases = Array.isArray(en.phases) ? en.phases : [];
    if (phases.length) {
      cardEng.appendChild(aaSub(T("能量相位")));
      cardEng.appendChild(
        aaTable(
          [T("相位"), T("起止"), T("时长")],
          phases.map((p) => [
            AA_PHASE_CN[p.label] ? T(AA_PHASE_CN[p.label]) : String(p.label || "—"),
            aaFmtTime(p.startSec) + " – " + aaFmtTime(p.endSec),
            aaNum((Number(p.endSec) || 0) - (Number(p.startSec) || 0), 1) + " s",
          ]),
          24,
        ),
      );
    }
    const warns = Array.isArray(diag.warnings) ? diag.warnings : [];
    const cardDiag = aaCard(T("警告与诊断"), warns.length ? warns.length + T(" 条警告") : T("无警告"));
    if (warns.length) {
      const list = aaEl("ul", "aa-warns");
      for (const w of warns) {
        const li = aaEl("li", "aa-warn");
        li.appendChild(aaEl("code", "aa-warn-code", (w && w.code) || "—"));
        li.appendChild(aaEl("span", "aa-warn-msg", (w && (w.message || w.detail)) || ""));
        if (w && w.t != null) li.appendChild(aaEl("span", "aa-warn-t", aaFmtTime(w.t)));
        list.appendChild(li);
      }
      cardDiag.appendChild(list);
    } else {
      cardDiag.appendChild(aaEl("div", "aa-ok", T("这份素材没有触发任何警告。")));
    }
    cardDiag.appendChild(
      aaDl([
        [T("方法"), diag.method || "—"],
        [T("注意"), diag.caveat || "—"],
      ]),
    );
    const tim = diag.timingsMs || {};
    const tkeys = Object.keys(tim);
    if (tkeys.length) {
      cardDiag.appendChild(aaSub(T("各阶段耗时")));
      cardDiag.appendChild(aaTable([T("阶段"), "ms"], tkeys.map((k) => [k, aaNum(tim[k], 0)])));
    }

    /* 视频卡点参数：做卡点闪拍 / 逐帧工程时真正要抄下来的数（也是输出 0 里 video 那块） */
    const vp = aaBeatParams(node, rep);
    const cardVid = aaCard(T("视频卡点参数"), vp.ready ? vp.fps + " fps · " + vp.beatsPerBar + T(" 拍 / 小节") : T("缺少 BPM"));
    if (vp.ready) {
      cardVid.appendChild(
        aaDl([
          ["BPM", aaNum(vp.bpm, 2) + T(" · 每拍 ") + aaNum(vp.beatSec, 3) + " s"],
          [T("小节"), aaNum(vp.barSec, 3) + " s" + T("（") + vp.beatsPerBar + T(" 拍）")],
          [T("帧数"), aaNum(vp.framesPerBeat, 2) + T(" 帧 / 拍 · ") + aaNum(vp.framesPerBar, 2) + T(" 帧 / 小节")],
          [T("建议闪拍"), vp.flashFrames + T(" 帧") + T("（≈") + aaNum((vp.flashFrames / vp.fps) * 1000, 0) + " ms）"],
          [T("整帧漂移"), aaSigned(vp.driftMsPerBeat, 1) + T(" ms / 拍（按帧取整后逐拍累积）")],
          [T("视觉偏移"), aaSigned(vp.offsetMs, 0) + " ms"],
          [T("可用重拍"), String(vp.downbeats) + (dnb.length ? T(" · 首个 ") + aaFmtTime(dnb[0]) : "")],
        ]),
      );
      /* 帧号的唯一算法摆在这里（报告里所有帧号都走它，不逐拍累加） */
      cardVid.appendChild(
        aaSub(
          T("实际触发帧 = round((t + 视觉偏移) × fps) · 当前 ") +
            vp.fps +
            T(" fps / 偏移 ") +
            aaSigned(vp.offsetMs, 0) +
            " ms",
        ),
      );
      const first = dnb.slice(0, 12);
      if (first.length) {
        cardVid.appendChild(
          aaSub(T("前 12 个重拍的实际触发帧（frame = round((t + 偏移) × ") + vp.fps + T(")）")),
        );
        cardVid.appendChild(
          aaTable(
            [T("时间"), T("帧号"), T("秒")],
            first.map((t) => [aaFmtTime(t), String(vp.frameOf(t)), aaNum(t, 3)]),
          ),
        );
      }
      cardVid.appendChild(
        aaEl(
          "div",
          "aa-sub",
          T(
            "一拍通常不是整帧（例如 128 BPM@30fps = 14.06 帧）：帧号一律按 round((t + 偏移) × fps) 逐点算，不要用「每拍 +14 帧」累加，否则越到后面越偏；相邻切点间隔不足 4 帧时改 60 fps 再排。闪拍长度取 1/5 拍：短闪一下看得见，长了会变成频闪。",
          ),
        ),
      );
    } else {
      cardVid.appendChild(aaEl("div", "aa-ok", T("还没测出 BPM：跑一次 ▶ 后有拍网格才能给帧数。")));
    }
    cardVid.appendChild(
      aaEl(
        "div",
        "aa-sub",
        T(
          "卡点工程不必再手算拍位：docs/audio-analysis/helpers/beatclock.mjs 的六个纯函数（beatAt / phaseAt / sectionAt / curveAt / nextEvent / frameOf）直接吃这份 JSON；Remotion 用法见 guides/nodes/audio_spectrum.md。",
        ),
      ),
    );

    const cardOut = aaCard(T("产物与文件"), "");
    const vis = Array.isArray(rep.visuals) ? rep.visuals : [];
    if (vis.length) {
      const grid = aaEl("div", "aa-viz-grid");
      for (const v of vis) {
        const tile = aaEl("div", "aa-viz");
        if (v && v.path) {
          const img = document.createElement("img");
          /* 与节点里那张频谱同一条 bust 口径（同一个 ranAt → 同一个 URL，同一张图只解一次） */
          img.src = aaMediaUrl(v.path) + (node.ranAt ? "?t=" + node.ranAt : "");
          img.alt = AA_VIZ_CN[v.kind] ? T(AA_VIZ_CN[v.kind]) : String(v.kind || "");
          /* 报告窗里的瓦片：**保持** loading="lazy"（滚到才拉），解码也异步 ——
             别改成首屏全量解码，一张 1024×384 的热力图 ×4 会卡住开窗 */
          img.loading = "lazy";
          img.decoding = "async";
          img.onerror = () => {
            img.style.display = "none";
          };
          tile.appendChild(img);
        }
        const cap = aaEl("div", "aa-viz-cap");
        cap.appendChild(aaEl("span", "", AA_VIZ_CN[v.kind] ? T(AA_VIZ_CN[v.kind]) : String(v.kind || "—")));
        const openBtn = aaEl("button", "mini", T("打开"));
        openBtn.type = "button";
        openBtn.onclick = () => {
          if (v.path && window.api && window.api.shellOpenPath)
            window.api.shellOpenPath(v.path).catch(() => toast(T("打开失败：") + v.path, "err"));
        };
        cap.appendChild(openBtn);
        tile.appendChild(cap);
        tile.appendChild(aaEl("div", "aa-viz-path", (v.path || "") + (v.widthPx ? " · " + v.widthPx + "×" + v.heightPx : "")));
        grid.appendChild(tile);
      }
      cardOut.appendChild(grid);
    }
    cardOut.appendChild(
      aaDl([
        [T("完整 JSON"), node.aaJsonPath || rep.fullJsonPath || "—"],
        [T("输出 0"), T("自描述摘要 + 字段字典 fieldGuide（同一份 JSON）")],
      ]),
    );
    const trunc = Array.isArray(rep.truncated) ? rep.truncated : [];
    if (trunc.length) {
      const tchips = aaEl("div", "aa-chips");
      trunc.forEach((x) => tchips.appendChild(aaChip(T("摘要裁剪：") + x, "warn")));
      cardOut.appendChild(tchips);
    }

    const cols = aaEl("div", "aa-cols");
    const colL = aaEl("div", "aa-col");
    const colR = aaEl("div", "aa-col");
    colL.appendChild(cardTempo);
    colL.appendChild(cardBars);
    colL.appendChild(cardEvt);
    /* 产物放右列：左列两张表本来就更长，右列补上产物才不会在窗底留一大块空白 */
    colR.appendChild(cardEng);
    colR.appendChild(cardVid);
    colR.appendChild(cardDiag);
    colR.appendChild(cardOut);
    cols.appendChild(colL);
    cols.appendChild(colR);
    root.appendChild(cols);
    return root;
  }

  /** 板身上的入口（一行；没有结果时是「跑一次就有」的禁用态）
      文案与状态口径只写在这一份里：建成（aaReportRow）与就地刷新（aaPaintStatus）共用，
      否则两处各写一套，就地刷新那一份迟早与重建后的样子对不上。 */
  function aaReportRowState(node) {
    const ready = !!(node && node.output && node.output.kind === "text" && node.output.text);
    const status = String((node && node.aaStatus) || "").trim();
    if (node && node.error) {
      /* 失败：状态行已从 body 移除，错误原因只能在这只窗（与 title）里看 */
      return {
        cls: " err",
        disabled: false,
        text: T("分析报告 · 上次运行失败"),
        title: String(node.error),
      };
    }
    if (node && node.running) {
      return {
        cls: ready ? " ready" : "",
        disabled: !ready,
        /* 已有上一次结果时不动入口文案（免得跑一次入口就消失），进度放 title；
           还没有结果时这一行本就没得点，直接把进度写上去 */
        text: ready ? T("查看分析报告") : status || T("分析中…"),
        title: status || T("正在分析…"),
      };
    }
    if (ready)
      return {
        cls: " ready",
        disabled: false,
        text: T("查看分析报告"),
        title: T("打开分析报告：概览 / 节奏 / 小节 / 事件 / 能量 / 诊断 / 产物"),
      };
    return {
      cls: "",
      disabled: true,
      text: T("分析报告 · 跑一次 ▶ 后生成"),
      title: T("还没有分析结果：点节点头部的 ▶ 跑一次"),
    };
  }

  function aaReportRow(node) {
    const st = aaReportRowState(node);
    /* 一次 clone 拿整棵树（成本账 ②：不再 3 次 createElement 组树；骨架见 aaRepTemplate） */
    const btn = aaRepTemplate().content.firstElementChild.cloneNode(true);
    btn.className = "n-aa-report" + st.cls;
    const sp = btn.children;
    sp[0].textContent = "▤";
    sp[1].textContent = st.text;
    sp[2].textContent = st.cls === " ready" ? "›" : "";
    btn.disabled = st.disabled;
    btn.title = st.title;
    btn.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      aaOpenReport(node);
    };
    btn.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    /* 状态刷新的落点就在这里登记（sp[1] = 文案、sp[2] = ›）：运行期一秒数次的回调
       只改上面这几只元素，不再 document.querySelector（成本账 ④，见 aaPaintStatus） */
    aaStatusBindRow(node, btn, sp[1], sp[2]);
    return btn;
  }

  /** 开那只大窗（#overlay 宿主，窗脚三颗按钮） */
  function aaOpenReport(node) {
    if (!node) return;
    if (typeof openOverlay !== "function") {
      toast(T("宿主未就绪（openOverlay）"), "err");
      return;
    }
    const rep = aaReportOf(node);
    openOverlay(T("分析报告 · ") + (node.title || ""));
    const box = document.querySelector("#overlay .overlay-box");
    if (box) box.classList.add("wide");
    const host = document.getElementById("ovBody");
    if (!host) return;
    if (node.error) host.appendChild(aaEl("div", "aa-rep-err", "✕ " + String(node.error)));
    if (!rep) {
      const empty = aaEl("div", "aa-rep-empty");
      empty.appendChild(aaEl("div", "aa-rep-empty-t", T("还没有分析报告")));
      empty.appendChild(
        aaEl(
          "div",
          "aa-rep-empty-s",
          T("点节点头部的 ▶ 跑一次：报告会写在这里，同时写进输出 0 的 JSON（自带 fieldGuide 字段字典）。"),
        ),
      );
      empty.appendChild(aaEl("div", "aa-rep-empty-s", aaInputHint(node)));
      host.appendChild(empty);
    } else {
      host.appendChild(aaReportDom(rep, node));
    }
    const foot = document.getElementById("ovFoot");
    if (!foot) return;
    const copy = aaEl("button", "mini primary", T("复制 JSON"));
    copy.type = "button";
    copy.disabled = !rep;
    copy.title = T("把输出 0 的那份分析 JSON 复制到剪贴板");
    copy.onclick = () => {
      const txt = rep && node.output && node.output.kind === "text" ? String(node.output.text || "") : "";
      if (!txt) {
        toast(T("还没有可复制的结果"), "warn");
        return;
      }
      /* 剪贴板写入只走唯一出口 appClipboardCopy（renderer/app-clipboard.js：navigator → 桥
         → execCommand 三级兜底）。本文件在 index.html 里排在它之后加载，这里再裸调
         navigator.clipboard 等于绕开出口开第二条路（回归口径 test/smoke-settings-copy-key.js）。 */
      appClipboardCopy(txt, T("已复制分析 JSON"));
    };
    const openJson = aaEl("button", "mini", T("打开完整 JSON"));
    openJson.type = "button";
    openJson.disabled = !(node.aaJsonPath && window.api && window.api.shellOpenPath);
    openJson.title = node.aaJsonPath || T("这次结果没有落盘路径（缓存 bypass 时仍会写图，但 JSON 随缓存条目）");
    openJson.onclick = () => {
      if (!node.aaJsonPath) return;
      window.api.shellOpenPath(node.aaJsonPath).catch(() => toast(T("打开失败：") + node.aaJsonPath, "err"));
    };
    const close = aaEl("button", "mini", T("关闭"));
    close.type = "button";
    close.onclick = () => {
      if (typeof closeOverlay === "function") closeOverlay();
    };
    foot.appendChild(copy);
    foot.appendChild(openJson);
    foot.appendChild(close);
  }

  /* ── ⚙ 设置 ──────────────────────────────────────────────────────────── */

  function aaNodeSummary(node) {
    aaNormalize(node);
    return [
      node.aaDetail ? T("逐拍明细：开") : T("逐拍明细：关"),
      T("事件上限 ") + node.aaOnsetsLimit,
      node.aaLoudness ? T("响度：开") : T("响度：关"),
      T("缓存：") + node.aaCache,
      T("图：") + node.aaVizKinds.join("/"),
    ].join(" · ");
  }

  function aaRegisterForm() {
    if (typeof registerNodeSettingsForm !== "function") return;
    registerNodeSettingsForm(KIND, {
      title: (node) => T("MT 音频频谱分析 · ") + (node.title || ""),
      gearTitle: () => T("分析档位 / 事件上限 / 可视化 / 缓存 / 帧率与偏移"),
      summary: aaNodeSummary,
      build: (ctx) => {
        const node = ctx.node;
        aaNormalize(node);
        ctx.hint(
          T(
            "输入端子 = 音频（音频或视频，视频只取音轨）。输出 0 = 分析结果（JSON + 字段字典 fieldGuide）· 输出 1 = 频谱图 · 输出 2 = 控制输出。跑完点 body 上的「查看分析报告」看排版好的报告。",
          ),
        );
        ctx.section(T("分析档位"));
        nsCheck(
          ctx,
          T("下发逐拍明细（detail）"),
          !!node.aaDetail,
          (v) => {
            node.aaDetail = !!v;
          },
          {
            tip: T(
              "开 = beatGrid.beats[] 逐拍带 onset 强度 / 偏差（更费 token）；关 = 只给 beatsSec 与小节表（推荐）",
            ),
          },
        );
        nsNumber(
          ctx,
          T("onset 事件上限（按强度取前 N）"),
          node.aaOnsetsLimit,
          { min: 50, max: 20000, step: 50, fallback: 2000 },
          (v) => {
            node.aaOnsetsLimit = v;
          },
        );
        nsCheck(
          ctx,
          T("额外算 LUFS 响度（慢）"),
          !!node.aaLoudness,
          (v) => {
            node.aaLoudness = !!v;
          },
          { tip: T("只在要按平台响度交付时开；默认关，省一半前端时间") },
        );
        ctx.section(T("可视化"));
        for (const [kind, label] of VIZ_ALL) {
          const on = node.aaVizKinds.indexOf(kind) >= 0;
          nsCheck(
            ctx,
            T(label),
            on,
            (v) => {
              const set = new Set(node.aaVizKinds || []);
              if (v) set.add(kind);
              else set.delete(kind);
              if (!set.size) set.add("spectrogram"); /* 板身要频谱，不允许全关 */
              node.aaVizKinds = Array.from(set);
            },
            kind === "spectrogram" ? { tip: T("板身显示的就是它，建议一直开") } : {},
          );
        }
        ctx.section(T("频谱图上的事件层"));
        nsCheck(
          ctx,
          T("总开关：显示事件层"),
          node.aaShowEvents !== false,
          (v) => {
            node.aaShowEvents = !!v;
          },
          {
            tip: T(
              "板身频谱图上那一整层（下面各项的合计）。关掉后频谱不变、图例还在，随时能再打开；每一项也能在图例上单独点",
            ),
          },
        );
        for (const tr of AA_EV_TRACKS) {
          const on = aaEvOnOf(node)[tr.key];
          nsCheck(
            ctx,
            T(tr.label),
            on,
            (v) => {
              const cur = aaEvOnOf(node);
              cur[tr.key] = !!v;
              node.aaEvOn = cur;
            },
            { tip: T(tr.hint) + " · " + T("只控这一层") },
          );
        }
        nsSelect(
          ctx,
          T("卡点参数按哪个帧率换算"),
          [
            ["24", "24 fps"],
            ["25", "25 fps"],
            ["30", "30 fps（默认）"],
            ["50", "50 fps"],
            ["60", "60 fps"],
          ],
          String(node.aaVideoFps),
          (v) => {
            const n = Number(v);
            node.aaVideoFps = [24, 25, 30, 50, 60].indexOf(n) >= 0 ? n : 30;
          },
          { id: "aa-fps", tip: T("板身那行「卡点参数」与报告里的帧数 / 闪拍帧数都按这个帧率算") },
        );
        nsNumber(
          ctx,
          T("视觉偏移（毫秒）"),
          node.aaVisualOffsetMs,
          { min: -2000, max: 2000, step: 1, fallback: 0 },
          (v) => {
            node.aaVisualOffsetMs = Math.max(-2000, Math.min(2000, Math.round(Number(v) || 0)));
          },
        );
        ctx.hint(
          T(
            "剪辑台 / 编码链比音频晚几帧时填这里：报告里的帧号一律是「实际触发帧 = round((t + 视觉偏移) × fps)」，填 0 就是纯 round(t × fps)。只挪帧号，不改分析结果；相邻切点间隔不足 4 帧时报告会标黄，建议改 60 fps 再排。",
          ),
        );
        ctx.section(T("缓存"));
        nsSelect(
          ctx,
          T("缓存策略"),
          CACHE_MODES,
          node.aaCache,
          (v) => {
            node.aaCache = ["refresh", "bypass"].indexOf(String(v)) >= 0 ? String(v) : "auto";
          },
          { id: "aa-cache" },
        );
        ctx.section(T("给 Agent 的字段字典"));
        nsSelect(
          ctx,
          T("字段字典（fieldGuide）"),
          [
            ["compact", T("精简（默认 · 只给摘要里出现的字段）")],
            ["full", T("完整（服务端全量约 186 条 · 更费 token）")],
            ["off", T("关闭（只给字段名，含义看节点指南）")],
          ],
          node.aaGuide,
          (v) => {
            node.aaGuide = ["full", "off"].indexOf(String(v)) >= 0 ? String(v) : "compact";
          },
          { id: "aa-guide" },
        );
        ctx.hint(
          T(
            "端口 0 的 JSON 第一层就有 fieldGuide（键 = 字段路径，值 = 一句话说明 + 单位）。精简档只保留这份摘要里真出现的键；完整档把服务端的 186 条全带上，适合把整份产物喂给 Agent 做长线剪辑。",
          ),
        );
        ctx.hint(
          T(
            "同一份素材 + 同一套参数第二次点 ▶ 会直接命中缓存（秒回）。产物（频谱 PNG）归缓存 LRU 管（2 GiB / 30 天），要长期留存就把输出 1 接「保存图像」节点。",
          ),
        );
      },
    });
  }

  /* ── 对外出口（app-canvas.js 的 buildBody / app-nodes.js 的 playNodeBody 按名字调用）── */
  window.AudioAnalysis = {
    KIND,
    normalize: aaNormalize,
    optionsOf: aaOptionsOf,
    inputPath: aaInputPath,
    summaryOf: aaSummaryOf,
    digest: aaDigest,
    digestText: aaDigestText,
    play: playAudioAnalysisNode,
    appendBody: aaAppendBody,
    eventLayers: aaEventLayers,
    paintEventOverlay: aaPaintEventOverlay,
    summaryLine: aaSummaryLineText,
    openReport: aaOpenReport,
    reportDom: aaReportDom,
  };
  window.aaAppendBody = aaAppendBody;
  window.playAudioAnalysisNode = playAudioAnalysisNode;
  window.aaOpenReport = aaOpenReport;

  /* 缩略总览切档广播先绑上（见「成本账 ③」）：节点在总览下建 body / 拉回 100% 都要靠它 */
  aaLodBind();

  aaRegisterForm();
})();
