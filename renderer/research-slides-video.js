/* ===== 研究演示「视频工程生成器」· renderer/research-slides-video.js =====
 *
 * window.MTResearchSlidesVideo（UMD：浏览器挂全局，node 里可直接 require —— 纯函数，不碰盘、不联网）
 *
 * 一句话：把 deck（页 / 要点 / 备注 / 眉题）+ styleTokens(theme) + brief 编译成一棵 **Remotion 工程源码树**
 * （Composition.tsx + 若干组件），外加整片时长 / 分辨率参数（calculateMetadata 用）与逐词字幕数据。
 *
 * 为什么单独一份（不放内核、不放编辑器）：
 *   · 内核只管「页是什么样」，编辑器只管「怎么改页」，视频是**第三种渲染介质** ——
 *     它要回答的是「先出哪一页、这页停多久、第 i 条要点第几帧升起来」，这些不该塞回页模型；
 *   · 生成器是纯函数：同样的 deck / theme / brief 一定生成同样的源码与时间轴（可对账、可断言）；
 *   · 宿主（app-research.js）只做三件事：调这里拿 files + meta → 交给 remotion 宿主写盘渲染 → 落 research/exports。
 *
 * 口径全部来自 docs/research-slides-video-spec.md：
 *   §3  styleTokens 是颜色与运动量的唯一真源 —— 视频侧只从它取色（工程里没有第二处颜色字面量）；
 *   §5.1 单页秒数 = 字速算出来的读的时间，再乘 brief 的节奏系数 k（夹在 0.75–1.35，只乘读的时间）；
 *   §5.2 章节卡按可见页序列里 kicker 的首段（› 前那段）变化处插一张，不写进 deck.pages；
 *   §5.4 页间转场发生在上一页尾巴里（两页交叠，总时长不增加），要点按 stagger 逐条入场、最后一条留 0.6s；
 *   §5.5 旁白可选：notes 逐句 → 时间轴；工程里留一个可空的 audio 端子，空 = 不铺旁白音轨
 *     （字幕仍按脚本「旁白：」逐句的时间轴照常铺 —— 字幕是脚本的时间轴，不依赖有没有录音）。
 *   §展示风格：styleTokens().style 决定**怎么演** —— 镜头编排（学术＝建立镜 + 图注 / 公式特写、慢推；
 *     Motion＝数字与对比动效镜 + 遮罩转场 + 更大字号；2.5D＝多层卡片分层位移 + 轻微视差；
 *     3D＝轨道相机 + 场景镜）、3D 场景页预算（用 tokens.sceneMax：3D 6 / 学术 1 / Motion 0 / 2.5D 2）、
 *     背景装饰强度与字幕节奏。颜色 / 字体仍只来自 theme，import 白名单与依赖不动。
 *
 * 两条「纯函数拿不到」的事，如实写在返回值里而不是假装做到：
 *   · 旁白音频**时长**：本模块不读盘，量不到 TTS 有多长 —— 时间轴按 notes 文字排（narration 给出逐句 ms 窗口），
 *     宿主拿着这些窗口去裁 / 生成音频；音频比窗口长就由宿主决定加长页（这里只保证文字与帧对得上）。
 *   · 公式与叠加图：上屏的式子必须是**排好版的文字**（生成期由内核 typesetMath 翻好；翻不动的整支片子拒渲），
 *     图由 props.media 传字节（导出侧读 slides/media 里的图），工程本身不带素材。
 *
 * 依赖白名单（renderer/app-nodes.js:8789 与 remotion/main-remotion.js:2437 同一份）：
 *   **只允许 react / remotion + 工程内相对文件** —— 所以：
 *   · 不用 @remotion/transitions / @remotion/media / 字体包：转场用 interpolate + Easing 手写；
 *   · Audio 用 remotion 自带的那个（src 来自合同端子落进 public/ 的裸文件名 → staticFile）；
 *   · 字体只用 T.font（= FONTS[theme.font].family 的系统字体栈）。
 *
 * 工程结构（每次全量重写，组件文件名稳定 —— remotion 宿主会清掉上一版多余源码）：
 *   Composition.tsx   入口：export const Main + export const inputs + calculateMetadata
 *   data.ts           时间轴数据（页 / 章节 / 字幕；帧是落点，秒是预算）
 *   theme.ts          颜色 / 字体 / 圆角 / 阴影（全片唯一一处颜色字面量，逐字来自 styleTokens().css）
 *   motion.ts         运动量常量（缓动 / 入场 / 转场帧数 / 字速 / 节拍 / 背景）+ 展示风格演法参数
 *                     （STYLE / TYPE_SCALE / DECOR / PARALLAX / USE_MASK / CAPTION_WINDOW）+ 版式钩子
 *                     （缩放 / 入场 / 转场 / 镜头 / 2.5D 分层视差）
 *   types.ts          类型
 *   Backdrop.tsx      背景（none / grain / grid / vignette，只用 rgba 遮罩）
 *   PageBody.tsx      单页版式（封面 / 大纲 / 正文 / 术语 / 公式 / 文献 / 结语，未知 kind 退化成正文）
 *   PageFrame.tsx     页级转场（fade / push，尾巴里交叠）
 *   Bullets.tsx       要点逐条入场（距上一页尾留 0.6s）
 *   ChapterCard.tsx   章节过场卡（序号 + 段标题）
 *   Captions.tsx      逐词字幕（按 notes 逐句时间轴铺：无音轨也铺，有音轨时与音轨同步）
 *
 * 产出（build 的返回）：
 *   { ok, files, entry, contract, meta, timeline, captions, narration, colors, buildKey, audit, warnings, error }
 *   meta      → 宿主交 remotion 宿主的时长 / 分辨率（calculateMetadata 同值）；
 *               另带展示风格 style / styleLabel / stylePicked（auto 已判成具体档）与 styleSceneMax，
 *               以及这一档的演法（shotFocusMax / cameraEstablish / cameraFocus / typeScale / decor /
 *               maskTransition / layeredCards / captionWindowMs / captionSize / sceneMax），
 *               界面与日志读这一份，不在别处再判一次
 *   timeline  → 页序列与帧落点（可对账：页 id 序列 === 可见页 id 序列）
 *   captions  → remotion-audio-captions 的逐词格式 {text, startMs, endMs, timestampMs, confidence}
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else if (root) root.MTResearchSlidesVideo = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const VER = 2;
  /* 入口固定 src/Composition.tsx（remotion 宿主的 buildIndexSource 只认这个名） */
  const ENTRY = "Composition.tsx";
  /* 章节卡上限：再多就不是「过场」而是另一份目录了（口径见 spec §5.2） */
  const MAX_CHAPTERS = 8;
  /* 分辨率与静态 PDF 同一把尺子（144 dpi，spec §3.3 规则 3） */
  const RES = {
    "16:9": { width: 1920, height: 1080 },
    "4:3": { width: 1440, height: 1080 },
    "9:16": { width: 1080, height: 1920 },
  };
  /* 端子契约：只有旁白音轨可选（其余全是生成期编译进源码的数据） */
  const CONTRACT = [{ key: "narration", kind: "audio", label: "旁白音轨（可空）", required: false }];
  /* 字幕每屏窗口（与 remotion-audio-captions 的 combineTokensWithinMilliseconds 同量级） */
  const CAPTION_WINDOW_MS = 1600;

  /* 页模型内核：浏览器里按 index.html 的加载顺序取全局，node 里就是同目录那一份 */
  function core() {
    if (typeof window !== "undefined" && window && window.MTResearchSlides) return window.MTResearchSlides;
    if (typeof require === "function") {
      try {
        return require("./research-slides.js");
      } catch (_) {
        return null;
      }
    }
    return null;
  }

  /* ── 小工具（与内核同口径，不引内核的私有函数）────────────────────────── */
  function str(v) {
    return v == null ? "" : String(v);
  }
  function round2(n) {
    const x = Number(n);
    return Number.isFinite(x) ? Math.round(x * 100) / 100 : 0;
  }
  function roundInt(n) {
    const x = Number(n);
    return Number.isFinite(x) ? Math.round(x) : 0;
  }
  function clampNum(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }
  function charLen(s) {
    return Array.from(str(s)).length;
  }
  /* 一页上那张图的取图键：页号 + 文件名定死（换机器 / 换工程目录都一样，导出侧按同一个键传字节）。
     只用 [a-z0-9-_]，撞名时加 -2、-3 —— 键要能用进 data URL 表，也要能一眼看出是哪一页的哪张图。 */
  function mediaNameOf(index, no, src, used) {
    const file = str(src).split("/").pop();
    const ext = ((/\.([a-z0-9]+)$/i.exec(file) || [])[1] || "png").toLowerCase();
    const base = file.replace(/\.[a-z0-9]+$/i, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
    const stem = "p" + String(index + 1).padStart(2, "0") + "-" + (base || "fig") + (no > 1 ? "-" + no : "");
    let name = stem + "." + ext;
    let i = 2;
    while (used.has(name)) name = stem + "-" + i++ + "." + ext;
    used.add(name);
    return name;
  }
  /* 上屏文字的硬闸：TeX 源码一个都不许上屏（内核已把能翻的翻成排好的文字，翻不动的在这里拦住）。
     返回 [{ page, field, text, leftover }] —— 空数组 = 全片干净。 */
  function texOnScreenOf(pages, RS) {
    const out = [];
    if (!RS || typeof RS.texLeftover !== "function") return out;
    const fields = ["title", "kicker", "quote", "formula"];
    for (const pg of pages) {
      for (const f of fields) {
        const left = RS.texLeftover(pg[f]);
        if (left.length) out.push({ page: pg.title || pg.id, field: f, text: str(pg[f]).slice(0, 80), leftover: left });
      }
      for (const b of pg.bullets || []) {
        const left = RS.texLeftover(b.text);
        if (left.length) out.push({ page: pg.title || pg.id, field: "bullets", text: str(b.text).slice(0, 80), leftover: left });
      }
    }
    return out;
  }
  function resolutionOf(aspect) {
    return RES[aspect] || RES["16:9"];
  }

  /* ── 章节：kicker 的首段（› 前那段）；续页的「续 2/4」不算章节 ──────────── */
  function chapterKeyOf(pg) {
    const kind = str(pg && pg.kind);
    if (kind === "cover" || kind === "toc" || kind === "end") return "";
    let s = str(pg && pg.kicker).trim();
    const at = s.indexOf("›");
    if (at >= 0) s = s.slice(0, at).trim();
    if (!s) return "";
    if (/^续\s*\d+\s*\/\s*\d+$/.test(s)) return "";
    return s.slice(0, 40);
  }

  /* ── 旁白：notes → 逐句 → 逐词（中文按字、英文按词，与字幕格式一致）───── */
  function sentencesOf(text) {
    return str(text)
      .split(/(?<=[。！？!?；;…])\s*|\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  /* 一页的 note 里，「旁白：」之后是**要念出来的话**，「讲法 / 备注 / 提示：」之后是给讲者的
     提示（板书怎么写、哪里别展开）—— 字幕只铺前者。没有「旁白：」标记就整段都算（老 deck
     的 note 本来就是照读稿）。 */
  function narrationTextOf(note) {
    const s = str(note);
    const m = /旁白\s*[:：]/.exec(s);
    if (!m) return s;
    let body = s.slice(m.index + m[0].length);
    const cut = /(?:\n|｜)\s*(?:讲法|备注|提示)\s*[:：]/.exec(body);
    if (cut) body = body.slice(0, cut.index);
    return body.replace(/^[｜|\s]+/, "").trim();
  }
  /* 字幕切块：按短语成块（标点断块、最长 12 字），拉丁词 / 数字 / 希腊字母整体保留。
     逐字切块（一汉字一块）在字幕窗口里只露出五六个字，读不成句；
     四字硬切又会把「三件事」切成「秒说清三 | 件事」——所以块长按标点定、只在上限处兜底。 */
  function tokenize(text) {
    const s = str(text);
    const out = [];
    const MAXC = 12;
    let buf = "";
    const flush = () => {
      const t = buf.trim();
      if (t) {
        /* 纯标点的块并回前一块：字幕里不该单独闪一个「，」 */
        if (out.length && !/[\u4e00-\u9fffA-Za-z0-9]/.test(t)) out[out.length - 1] += t;
        else out.push(t);
      }
      buf = "";
    };
    const LATIN = /[A-Za-z0-9\u0370-\u03FF'’._√≥≤≍×·∞∑+\-*/^=()–]/;
    const PUNCT = /[，。、；：！？…—－「」『』（）《》〈〉“”‘’"'·]/;
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (/\s/.test(c)) {
        /* 拉丁词之间的空格要留着：拆成两块再靠 flex gap 拼，人眼看到的是「SethHardy」
           （中文块之间可以靠 gap，西文词之间必须是真空格）。只有两侧都是拉丁/数字时才并块。 */
        const prevLatin = /[A-Za-z0-9]$/.test(buf);
        const nextLatin = /[A-Za-z0-9\u0370-\u03FF]/.test(s[i + 1] || "");
        if (prevLatin && nextLatin && charLen(buf) < MAXC) {
          buf += " ";
          i++;
          continue;
        }
        flush();
        i++;
        continue;
      }
      if (LATIN.test(c)) {
        let j = i;
        while (j < s.length && LATIN.test(s[j]) && !/\s/.test(s[j])) j++;
        const w = s.slice(i, j);
        /* 长词（人名、公式片段）自己成块；短词（N、e(x)、≍）粘在中文里 */
        if (charLen(w) >= 6) {
          flush();
          out.push(w);
        } else {
          buf += w;
          if (charLen(buf) >= MAXC) flush();
        }
        i = j;
        continue;
      }
      if (PUNCT.test(c)) {
        buf += c;
        flush();
        i++;
        continue;
      }
      buf += c;
      if (charLen(buf) >= MAXC) flush();
      i++;
    }
    flush();
    return out;
  }

  /* ── 时长：单页（spec §5.1）× 节奏系数，章节卡（§5.2）────────────────── */
  function pageSecPaced(pg, motion, pace, RS) {
    const base = RS.pageSecOf(pg, motion);
    return round2(clampNum(base * pace, motion.minPageSec, motion.maxPageSec));
  }
  function chapterSecPaced(label, motion, pace) {
    const base = 1.4 + 0.6 * (charLen(label) / motion.cpsTitle);
    return round2(clampNum(base * pace, 1.8, 3.2));
  }

  /* 要点逐条入场的相对帧（spec §5.4）：lead + i × stagger，间距过密时压到
     「最后一条在页尾前 0.6s 出现」为止（动作不因压时长而变快，只调间距）。
     整条就是公式的要点在这里剔掉：公式已经由 formula 卡片单独排版（TeX 源码在大字号下
     会被当成「一条念不出来的要点」，镜头聚焦它也没有意义）。 */
  function bulletFramesOf(pg, motion, displayFrames, fps) {
    const all = Array.isArray(pg && pg.bullets) ? pg.bullets : [];
    const formulaKey = str(pg && pg.formula).replace(/\s+/g, "");
    const list = all.filter((b) => {
      const t = str(b).trim();
      if (!t) return false;
      if (/^\$\$?[\s\S]*\$\$?$/.test(t)) return false;
      const key = t.replace(/\s+/g, "");
      if (formulaKey && key === formulaKey) return false;
      return true;
    });
    const n = list.length;
    if (!n) return [];
    const lead = Math.max(2, roundInt(motion.enterFrames));
    const lastCap = Math.max(lead, displayFrames - Math.round(0.6 * fps));
    let stagger = Math.max(2, roundInt(motion.staggerFrames * (n > 3 ? 1 : 1.2)));
    if (lead + (n - 1) * stagger > lastCap) {
      stagger = Math.max(1, Math.floor((lastCap - lead) / Math.max(1, n - 1)));
    }
    const out = [];
    for (let i = 0; i < n; i++) out.push({ text: str(list[i]), from: Math.max(0, lead + i * stagger) });
    return out;
  }

  /* ── 展示风格怎么「演」：镜头编排 / 运镜 / 字号 / 转场 / 装饰 / 字幕节奏 ──────
     风格的唯一真源是 styleTokens().style（brief.style = auto 时已判成具体档），
     这里只把「怎么演」翻成参数 —— 颜色与字体一概不碰（那是 theme 的事）：
       scholarly 学术            建立镜 + 图注 / 公式特写、慢推（pushIn 只推 0.035）、几乎不加装饰；
       motion    Motion Graphics 数字与对比要点各一个动效镜（snapZoom）、遮罩转场、字号 × 1.14；
       d2_5      2.5D            多层卡片按景深分层位移 + 轻微视差（PARALLAX），镜头几乎不动；
       d3        3D              轨道相机（orbit）+ 有 scene 的页先给场景镜。
     focusMax = 每页最多几个细节镜；spots = 先特写什么（scene / formula / quote / stat / layer，要点兜底）。 */
  const STYLE_PLAY = {
    scholarly: {
      focusMax: 1,
      spots: ["formula", "quote"],
      moves: { establish: "pushIn", focus: "pushIn" },
      establishShare: 0.46,
      depth: 3,
      typeScale: 1,
      decor: 0.45,
      mask: false,
      captionWindowMs: 2400,
      captionSize: 34,
      captionLeadMs: 500,
      captionTailMs: 380,
    },
    motion: {
      focusMax: 3,
      spots: ["stat"],
      moves: { establish: "snapZoom", focus: "snapZoom" },
      establishShare: 0.3,
      depth: 4,
      typeScale: 1.14,
      decor: 1,
      mask: true,
      captionWindowMs: 2400,
      captionSize: 38,
      captionLeadMs: 260,
      captionTailMs: 200,
    },
    d2_5: {
      focusMax: 2,
      spots: ["layer"],
      moves: { establish: "parallax", focus: "parallax" },
      establishShare: 0.36,
      depth: 2,
      typeScale: 1.05,
      decor: 0.8,
      mask: false,
      cards: true,
      captionWindowMs: 1800,
      captionSize: 34,
      captionLeadMs: 380,
      captionTailMs: 300,
    },
    d3: {
      focusMax: 2,
      spots: ["scene", "bullet"],
      moves: { establish: "orbit", focus: "orbit" },
      establishShare: 0.34,
      depth: 2,
      typeScale: 1.04,
      decor: 0.7,
      mask: false,
      captionWindowMs: 1900,
      captionSize: 34,
      captionLeadMs: 400,
      captionTailMs: 300,
    },
  };
  /* 风格缺省 = 学术（与内核 DEFAULT_STYLE 一致）：认不出的值不另编一套演法 */
  function stylePlayOf(style) {
    return STYLE_PLAY[str(style).trim()] || STYLE_PLAY.scholarly;
  }

  /* ── 镜头（shot）规划：一页拆成 1–4 个镜头，怎么切由展示风格决定 ─────────────
     为什么要镜头而不是「一页一个画面」：成片感来自**镜头内的运动**与**镜头之间的切**，
     不是页与页之间的淡入淡出。每页：
       · establish  建立镜头：整页入画，运镜按风格（学术慢推 / motion 快推 / 2.5D 视差 / 3D 轨道）；
       · focus      细节镜头：特写一样东西 —— spot 说明特写谁（formula / quote / bullet / scene），
                    focus = 聚焦那条要点的下标（-1 = 不是要点），tag = 这一镜把数字做大（numeric / compare / layer）；
     规则（确定性，同输入同输出）：镜头帧数首尾必须对齐页时长；页太短（< 1.2s 量级）只留一个镜头；
     封面 / 章节 / 结语只给一个运镜（不切碎）。同一份 shots 同时决定画面怎么动与谁被点亮。 */
  const SHOT_MAX = 4;
  const SHOT_MIN_FRAMES = 14;
  /* 「讲得出变化」的两类要点：数字（motion 的头号主角）与对比词（A 对 B） */
  const STAT_RE = /[0-9０-９]/;
  const COMPARE_RE = /对比|相比|高出|低于|提升|下降|增长|减少|占比|倍|前后/;
  /* 公式整行不算一条能念的要点（它由 formula 卡片单独排版、单独给特写镜） */
  function isFormulaBullet(t) {
    return /^\$\$?[\s\S]*\$\$?$/.test(str(t).trim());
  }
  /* 这一页在这档风格下值得特写的对象（有序，去重；同一输入永远同一份清单） */
  function spotTargetsOf(pg, play) {
    const out = [];
    const formula = str(pg && pg.formula).trim();
    const quote = str(pg && pg.quote).trim();
    const scene = str(pg && pg.scene).trim();
    const bullets = Array.isArray(pg && pg.bullets) ? pg.bullets : [];
    /* 图注镜排在最前：一页有图时，先让人看图，再讲字（学术档的图注镜 = 这张图） */
    if (Array.isArray(pg && pg.media) && pg.media.length) out.push({ spot: "figure", focus: -1, tag: "" });
    if (play.spots.indexOf("scene") >= 0 && scene) out.push({ spot: "scene", focus: -1, tag: "" });
    if (play.spots.indexOf("formula") >= 0 && formula) out.push({ spot: "formula", focus: -1, tag: "" });
    if (play.spots.indexOf("quote") >= 0 && quote) out.push({ spot: "quote", focus: -1, tag: "" });
    if (play.spots.indexOf("stat") >= 0) {
      const stat = [];
      const cmp = [];
      bullets.forEach((b, i) => {
        const t = str(b).trim();
        if (!t || isFormulaBullet(t)) return;
        if (STAT_RE.test(t)) stat.push(i);
        else if (COMPARE_RE.test(t)) cmp.push(i);
      });
      for (const i of stat) out.push({ spot: "bullet", focus: i, tag: "numeric" });
      for (const i of cmp) out.push({ spot: "bullet", focus: i, tag: "compare" });
    }
    if (play.spots.indexOf("layer") >= 0) {
      bullets.forEach((b, i) => {
        const t = str(b).trim();
        if (t && !isFormulaBullet(t)) out.push({ spot: "bullet", focus: i, tag: "layer" });
      });
    }
    /* 兜底：有字要点按序（学术没公式没图注、3D 没场景时，仍然切出细节镜） */
    bullets.forEach((b, i) => {
      const t = str(b).trim();
      if (t && !isFormulaBullet(t)) out.push({ spot: "bullet", focus: i, tag: "" });
    });
    const seen = new Set();
    const uniq = [];
    for (const t of out) {
      const key = t.spot + ":" + t.focus;
      if (seen.has(key)) continue;
      seen.add(key);
      uniq.push(t);
    }
    return uniq;
  }
  function planShots(pg, motion, displayFrames, fps, style) {
    const play = stylePlayOf(style);
    const total = Math.max(1, roundInt(displayFrames));
    const kind = str(pg && pg.kind);
    const single = ["cover", "end", "toc", "chapter"].indexOf(kind) >= 0;
    const targets = single ? [] : spotTargetsOf(pg, play);
    /* 一页最多 SHOT_MAX 镜（含建立镜）：再切就不是「一页」而是一串闪回了 */
    const cuts = Math.min(SHOT_MAX - 1, play.focusMax, targets.length);
    /* 封面 / 章节 / 结语：一个运镜到底（深度 5 = 背景最虚，画面最干净） */
    const establish = {
      kind: "establish",
      from: 0,
      frames: total,
      move: single && kind === "end" ? "pullOut" : play.moves.establish,
      focus: -1,
      spot: "none",
      tag: "",
      depth: single ? 5 : play.depth,
    };
    if (total < SHOT_MIN_FRAMES * 4 || !cuts) return [establish];
    const est = clampNum(
      Math.round(total * play.establishShare),
      SHOT_MIN_FRAMES,
      Math.max(SHOT_MIN_FRAMES, total - SHOT_MIN_FRAMES * cuts),
    );
    const shots = [Object.assign({}, establish, { frames: est })];
    let from = est;
    for (let i = 0; i < cuts; i++) {
      const left = Math.max(1, total - from);
      if (from >= total) break;
      const last = i === cuts - 1;
      const frames = last ? left : Math.max(SHOT_MIN_FRAMES, Math.floor(total > from ? (total - from) / (cuts - i) : left));
      const span = Math.min(frames, left);
      const t = targets[i];
      shots.push({
        kind: "focus",
        from: from,
        frames: span,
        move: play.moves.focus,
        focus: Number(t.focus),
        spot: str(t.spot),
        tag: str(t.tag),
        depth: t.spot === "scene" ? 1 : 2,
      });
      from += span;
    }
    /* 收尾对齐：最后一镜吃掉余下的帧（不多不少，页时长不变） */
    const tail = shots[shots.length - 1];
    tail.frames = Math.max(1, total - tail.from);
    return shots;
  }
  /* 页内某帧属于哪个镜头（Camera 与 PageBody 共用同一份判断，画面与高亮不会错位） */
  function shotAt(pg, frame) {
    const list = Array.isArray(pg && pg.shots) && pg.shots.length ? pg.shots : null;
    if (!list) {
      return { kind: "establish", from: 0, frames: Number(pg && pg.frames) || 1, move: "pushIn", focus: -1, spot: "none", tag: "", depth: 3 };
    }
    let cur = list[0];
    for (const s of list) if (Number(frame) >= Number(s.from)) cur = s;
    return cur;
  }

  /* ── 源码模板：全部静态（数据走 data.ts / theme.ts / motion.ts 三个模块）── */
  function typesSrc() {
    return [
      "/* 工程内共用类型（纯类型，没有运行时代码）：由 research-slides-video.js 生成，别手改。 */",
      "",
      "export interface Bullet {",
      "  text: string;",
      "  from: number;",
      "}",
      "",
      "export interface SlidePage {",
      "  id: string;",
      "  kind: string;",
      "  title: string;",
      "  kicker: string;",
      "  bullets: Bullet[];",
      "  quote: string;",
      "  formula: string;",
      "  note: string;",
      "  partLabel: string;",
      "  index: number;",
      "  total: number;",
      "  from: number;",
      "  frames: number;",
      "  sec: number;",
      "  scene: string;",
      "  /* 叠加图（幻灯片上那张图）：视频侧按 media 表取字节，取不到就画占位，不会崩 */",
      "  media: MediaItem[];",
      "  shots: Shot[];",
      "}",
      "",
      "/* 一页上的一张图：name = 取字节的键（由生成期按页号 + 文件名定死）；x/y/w/h 是静态版里的版面（视频没用到，留着对账） */",
      "export interface MediaItem {",
      "  name: string;",
      "  src: string;",
      "  x: number;",
      "  y: number;",
      "  w: number;",
      "  h: number;",
      "  fit: string;",
      "}",
      "",
      "/* 图字节：name → data URL（由导出/渲染那一侧传进 props.media；空 = 这张图没随工程过来） */",
      "export type MediaMap = { [name: string]: string };",
      "",
      "/* 一个镜头：页内的一段连续画面（from 相对页起点；move 是相机运动，focus = 高亮的要点下标，-1 = 无）",
      "   spot = 这一镜特写谁（none / formula / quote / bullet / scene），tag = 要不要把数字做大（numeric / compare / layer） */",
      "export interface Shot {",
      "  kind: \"establish\" | \"focus\";",
      "  from: number;",
      "  frames: number;",
      "  move: string;",
      "  focus: number;",
      "  spot: string;",
      "  tag: string;",
      "  depth: number;",
      "}",
      "",
      "export interface ChapterSeg {",
      "  id: string;",
      "  label: string;",
      "  no: number;",
      "  from: number;",
      "  frames: number;",
      "  sec: number;",
      "}",
      "",
      "export interface Segment {",
      "  id: string;",
      "  kind: \"page\" | \"chapter\";",
      "  from: number;",
      "  frames: number;",
      "}",
      "",
      "export interface Caption {",
      "  text: string;",
      "  startMs: number;",
      "  endMs: number;",
      "  timestampMs: number;",
      "  confidence: number | null;",
      "}",
      "",
      "export interface DeckInfo {",
      "  title: string;",
      "  date: string;",
      "}",
      "",
    ].join("\n");
  }

  /* theme.ts：styleTokens(theme).css 的 12 个变量原样搬进来（去掉 --rs-slide- 前缀） */
  function themeTableOf(tokens) {
    const css = tokens && tokens.css ? tokens.css : {};
    const out = {};
    for (const key of Object.keys(css)) {
      const name = key.indexOf("--rs-slide-") === 0 ? key.slice("--rs-slide-".length) : key;
      out[name] = css[key];
    }
    if (out.font == null) out.font = str(tokens && tokens.font);
    if (out.radius == null) out.radius = str(tokens && tokens.radius);
    if (out.shadow == null) out.shadow = str(tokens && tokens.shadow);
    return out;
  }
  function themeSrc(table) {
    const out = [
      "/* 颜色 / 字体 / 圆角 / 阴影：逐字来自内核 styleTokens(theme).css ——",
      "   视频侧只允许从这里取色，工程里没有第二处颜色字面量（rgba 遮罩除外）。 */",
      "export const T = {",
    ];
    for (const key of Object.keys(table)) out.push("  " + JSON.stringify(key) + ": " + JSON.stringify(str(table[key])) + ",");
    out.push("} as const;", "", "export type Theme = typeof T;", "");
    return out.join("\n");
  }

  /* motion.ts：运动量常量 + 展示风格的演法参数 + 四个版式钩子（缩放 / 入场 / 转场 / 镜头）
     transition 单独传：它是 deck.theme 的字段（只有 fade / push 两档），不在 motion 表里 ——
     转场只换手感（transitionFrames），不新增枚举，静态版与视频版才不会分叉。
     mask 是风格层的**叠加**（motion 档的遮罩转场），不改 theme.transition，fade / push 仍然有效。 */
  function motionSrc(motion, transition, dims, totalFrames, style, play) {
    const ease =
      motion.ease === "inOut"
        ? "Easing.inOut(Easing.cubic)"
        : motion.ease === "outBack"
          ? "Easing.out(Easing.back(1.6))"
          : "Easing.out(Easing.cubic)";
    return [
      "/* 运动量：逐字来自内核 motion 表（缓动 / 入场 / 转场帧数 / 字速 / 节拍 / 背景）。",
      "   切主题换的就是这里的数字 —— 工程要重新生成（宿主按 buildKey 判失效）。",
      "   展示风格（STYLE 那几行）再叠一层演法：字号 / 装饰 / 视差 / 遮罩转场 / 字幕节奏。 */",
      "import type { CSSProperties } from \"react\";",
      "import { Easing, interpolate, useCurrentFrame, useVideoConfig } from \"remotion\";",
      "",
      "export const FPS = " + roundInt(dims.fps) + ";",
      "export const WIDTH = " + roundInt(dims.width) + ";",
      "export const HEIGHT = " + roundInt(dims.height) + ";",
      "export const DURATION_IN_FRAMES = " + Math.max(1, roundInt(totalFrames)) + ";",
      "/* 版式按这个宽度设计，换比例时整体等比缩放 */",
      "export const BASE_WIDTH = 1920;",
      "",
      "export const EASE = " + ease + ";",
      "/* 写成 string：下面几个分支是按值比较的（不写死成字面量类型，换主题重新生成即可） */",
      "export const ENTER: string = " + JSON.stringify(str(motion.enter)) + ";",
      "export const ENTER_FRAMES = " + Math.max(1, roundInt(motion.enterFrames)) + ";",
      "export const STAGGER_FRAMES = " + Math.max(0, roundInt(motion.staggerFrames)) + ";",
      "export const TRANSITION: string = " + JSON.stringify(str(transition)) + ";",
      "export const TRANSITION_FRAMES = " + Math.max(0, roundInt(motion.transitionFrames)) + ";",
      "export const BG: string = " + JSON.stringify(str(motion.bg)) + ";",
      "export const CPS_TITLE = " + Number(motion.cpsTitle) + ";",
      "export const CPS_BULLET = " + Number(motion.cpsBullet) + ";",
      "export const BPM = " + Math.max(1, roundInt(motion.bpm)) + ";",
      "",
      "/* ── 展示风格（怎么演）：只影响演法，不碰颜色与字体 ────────────────────────── */",
      "export const STYLE: string = " + JSON.stringify(str(style)) + ";",
      "/* 字号系数：Motion Graphics 更大（大字色块），学术 1.0 */",
      "export const TYPE_SCALE = " + (Number(play && play.typeScale) || 1) + ";",
      "/* 装饰强度：学术 0.45（背景光斑压到几乎看不见）→ motion 1 */",
      "export const DECOR = " + (Number(play && play.decor) || 0) + ";",
      "/* 2.5D 分层视差：每层按 depth 分层位移的幅度（px）；0 = 不分层（其余档） */",
      "export const PARALLAX = " + (play && play.cards ? 26 : 0) + ";",
      "/* 遮罩转场（motion 档）：入场用 clipPath 扫过；主题的 fade / push 不动 */",
      "export const USE_MASK = " + (play && play.mask ? "true" : "false") + ";",
      "/* 字幕节奏：一屏窗口（ms）与字号跟风格走（学术慢而少，Motion 快而大） */",
      "export const CAPTION_WINDOW = " + Math.max(600, roundInt((play && play.captionWindowMs) || CAPTION_WINDOW_MS)) + ";",
      "export const CAPTION_SIZE = " + Math.max(20, roundInt((play && play.captionSize) || 34)) + ";",
      "/* 这一档的运镜（写进来只为让工程自解释；镜头切分在 data.ts 的 shots 里） */",
      "export const CAMERA_ESTABLISH: string = " + JSON.stringify(str(play && play.moves && play.moves.establish)) + ";",
      "export const CAMERA_FOCUS: string = " + JSON.stringify(str(play && play.moves && play.moves.focus)) + ";",
      "",
      "/* 画框缩放：设计稿按 1920 宽排，9:16 / 4:3 等比缩（字与间距一起缩，不各缩一样） */",
      "export const useScale = (): number => {",
      "  const { width } = useVideoConfig();",
      "  return width / BASE_WIDTH;",
      "};",
      "",
      "/* 入场：rise / fade / wipe / scale（与 motion.enter 同一份口径） */",
      "export const enterStyle = (progress: number, k: number): CSSProperties => {",
      "  const p = Math.max(0, Math.min(1, progress));",
      "  if (ENTER === \"fade\") return { opacity: p };",
      "  if (ENTER === \"wipe\")",
      "    return {",
      "      opacity: Math.min(1, p * 1.6),",
      "      clipPath: \"inset(0 \" + Math.round((1 - p) * 100) + \"% 0 0)\",",
      "    };",
      "  if (ENTER === \"scale\") return { opacity: p, transform: \"scale(\" + (0.94 + 0.06 * p) + \")\" };",
      "  return { opacity: p, transform: \"translateY(\" + Math.round((1 - p) * 20 * k) + \"px)\" };",
      "};",
      "",
      "/* 页间转场：发生在上一页尾巴里（两页交叠，总时长不额外增加）；最后一段只淡出。",
      "   push 用位移（进来的从右 56px 抬起，出去的往左让位），fade 只改透明度。 */",
      "export const useTransitionStyle = (frames: number, isLast: boolean): CSSProperties => {",
      "  const frame = useCurrentFrame();",
      "  const k = useScale();",
      "  const fps = useVideoConfig().fps;",
      "  const span = Math.max(1, frames - 1);",
      "  const enterEnd = Math.max(1, Math.min(ENTER_FRAMES, span));",
      "  const p = interpolate(frame, [0, enterEnd], [0, 1], {",
      "    extrapolateLeft: \"clamp\",",
      "    extrapolateRight: \"clamp\",",
      "    easing: EASE,",
      "  });",
      "  /* 末页收尾是 0.5s 整页淡出到纸色（spec §5.2），前后页则是 motion 表的转场帧数 */",
      "  const outLen = isLast ? Math.max(1, Math.round(0.5 * fps)) : TRANSITION_FRAMES;",
      "  const outStart = Math.max(enterEnd, frames - outLen);",
      "  const q = interpolate(frame, [outStart, Math.max(outStart + 1, frames)], [0, 1], {",
      "    extrapolateLeft: \"clamp\",",
      "    extrapolateRight: \"clamp\",",
      "    easing: EASE,",
      "  });",
      "  const opacity = Math.max(0, Math.min(1, Math.min(p, 1 - q)));",
      "  /* 遮罩转场（Motion Graphics 档）：clipPath 从右往左揭开一条竖缝，比淡入「有动作」；",
      "     它是主题 fade / push 之上的叠加，不替换主题转场。 */",
      "  if (USE_MASK && !isLast) {",
      "    const inset = Math.max(0, Math.min(100, Math.round((1 - p) * 100)));",
      "    return { opacity: opacity, clipPath: \"inset(0 \" + inset + \"% 0 0)\" };",
      "  }",
      "  if (TRANSITION === \"push\" && !isLast) {",
      "    const x = (1 - p) * 56 * k - q * 56 * k;",
      "    return { opacity: opacity, transform: \"translateX(\" + Math.round(x) + \"px)\" };",
      "  }",
      "  return { opacity: opacity };",
      "};",
      "",
      "/* 镜头运镜：move × 镜头内进度 → CSS 变换（画面按中心缩放，位移按 k 缩）。",
      "   一镜只做一件事（叠加就是晃）：",
      "     pushIn 慢推（学术档，0.035 一口气推完）· snapZoom 快推（motion 档，0.065 起跳：再大就把 96px 页边距推出画外，标题首字会被切）·",
      "     pullOut / dolly 只动 scale · pan / tilt 只动位移 · parallax 轻微视差 · orbit 轨道相机（绕画心转一点）。 */",
      "export const cameraStyle = (move: string, progress: number, k: number): CSSProperties => {",
      "  const p = Math.max(0, Math.min(1, progress));",
      "  const e = Easing.inOut(Easing.cubic)(p);",
      "  const snap = Easing.out(Easing.cubic)(p);",
      "  const drift = 42 * k;",
      "  const panX = move === \"panLeft\" ? drift * (0.5 - e) : move === \"panRight\" ? -drift * (0.5 - e) : 0;",
      "  const panY = move === \"tiltUp\" ? drift * (0.5 - e) : 0;",
      "  /* 2.5D / 3D 的位移都很小（它们靠分层与三维本身，不靠甩镜头） */",
      "  const slide = move === \"parallax\" ? Math.round((0.5 - e) * 14 * k) : 0;",
      "  const orbitX = move === \"orbit\" ? Math.round(Math.sin(p * Math.PI) * 18 * k) : 0;",
      "  const rotate = move === \"orbit\" ? Math.sin(p * Math.PI * 2) * 3.2 : 0;",
      "  const scale =",
      "    move === \"pushIn\" ? 1 + 0.035 * e",
      "      : move === \"snapZoom\" ? 1 + 0.065 * snap",
      "      : move === \"pullOut\" ? 1.06 - 0.06 * e",
      "      : move === \"dolly\" ? 1 + 0.065 * e",
      "      : move === \"parallax\" ? 1.02",
      "      : move === \"orbit\" ? 1.03",
      "      : 1.03;",
      "  return {",
      "    transform:",
      "      \"translate3d(\" + Math.round(panX + slide + orbitX) + \"px,\" + Math.round(panY) + \"px,0) rotate(\" + rotate.toFixed(3) + \"deg) scale(\" + scale.toFixed(4) + \")\",",
      "    transformOrigin: \"50% 50%\",",
      "  };",
      "};",
      "",
      "/* 2.5D 分层：同一页的每张卡片按 depth 分层位移（层越靠前动得越多），随页内进度走完一个来回。",
      "   其余档 PARALLAX = 0 → 返回空对象（版式一个字都不变）。 */",
      "export const parallaxStyle = (depth: number, progress: number, k: number): CSSProperties => {",
      "  if (!PARALLAX) return {};",
      "  const d = Math.max(0, Math.min(5, Number(depth) || 0));",
      "  const p = Math.max(0, Math.min(1, progress));",
      "  const shift = PARALLAX * (0.4 + (d / 5) * 0.6) * (p - 0.5) * 2;",
      "  return {",
      "    transform:",
      "      \"translate3d(\" + Math.round(shift * k) + \"px,\" + Math.round(shift * 0.35 * k) + \"px,0)\",",
      "    transformOrigin: \"50% 50%\",",
      "  };",
      "};",
      "",
      "/* 景深：depth 越大越虚（0 = 实焦）。只给背景层用，正文永远实焦。 */",
      "export const depthBlur = (depth: number): CSSProperties => ({",
      "  filter: \"blur(\" + Math.max(0, Math.min(8, Math.round(depth))) + \"px)\",",
      "});",
      "",
    ].join("\n");
  }

  /* data.ts：时间轴（页 / 章节 / 片段 / 字幕）—— 全部是纯数据，没有一处颜色 */
  function dataSrc(parts) {
    const out = [
      "/* 时间轴：由 deck + brief + styleTokens 在生成期算好（帧是落点，秒是预算）。",
      "   页 id 序列 === 可见页 id 序列；章节卡只是时间轴上多出来的片段，不写进页模型。",
      "   CAPTIONS 是按 notes（「旁白：」逐句）排的逐词时间轴 —— 没有旁白音轨时同样有值、同样铺。 */",
      "import type { ChapterSeg, Caption, DeckInfo, Segment, SlidePage } from \"./types\";",
      "",
      "export const DECK: DeckInfo = " + JSON.stringify(parts.deck, null, 2) + ";",
      "",
      "export const PAGES: SlidePage[] = " + JSON.stringify(parts.pages, null, 2) + ";",
      "",
      "export const CHAPTERS: ChapterSeg[] = " + JSON.stringify(parts.chapters, null, 2) + ";",
      "",
      "export const SEGMENTS: Segment[] = " + JSON.stringify(parts.segments, null, 2) + ";",
      "",
      "export const CAPTIONS: Caption[] = " + JSON.stringify(parts.captions, null, 2) + ";",
      "",
    ];
    return out.join("\n");
  }

  function backdropSrc() {
    return [
      "/* 背景：纸色 + 两团缓慢漂移的光斑 + BG 遮罩 + 暗角；depth 越大越虚（景深由 Camera 算）。",
      "   光斑只用 T.accent / T.primary 两色，透明度压到 0.1–0.16，绝不抢正文。",
      "   光斑与颗粒的强度再乘 DECOR（学术 0.45 = 几乎不加装饰，Motion 1 = 网格底 + 满强度）。 */",
      "import React from \"react\";",
      "import { AbsoluteFill, useCurrentFrame } from \"remotion\";",
      "import { BG, DECOR } from \"./motion\";",
      "import { T } from \"./theme\";",
      "",
      "export const Backdrop: React.FC<{ depth?: number }> = ({ depth }) => {",
      "  const frame = useCurrentFrame();",
      "  const t = frame / 90;",
      "  const blur = Math.max(0, Math.min(8, Math.round(Number(depth) || 0)));",
      "  const drift = (amp: number, speed: number, phase: number) => Math.sin(t * speed + phase) * amp;",
      "  const glowA =",
      "    \"radial-gradient(circle at \" + (30 + drift(6, 0.6, 0)).toFixed(2) + \"% \" + (28 + drift(4, 0.5, 1)).toFixed(2) + \"%, \" + T.accent + \" 0%, rgba(0,0,0,0) 52%)\";",
      "  const glowB =",
      "    \"radial-gradient(circle at \" + (76 + drift(7, 0.4, 2)).toFixed(2) + \"% \" + (70 + drift(5, 0.55, 3)).toFixed(2) + \"%, \" + T.primary + \" 0%, rgba(0,0,0,0) 46%)\";",
      "  return (",
      "    <AbsoluteFill",
      "      style={{ backgroundColor: T.paper, filter: blur ? \"blur(\" + blur + \"px)\" : undefined }}",
      "    >",
      "      <AbsoluteFill style={{ background: glowA, opacity: 0.14 * DECOR }} />",
      "      <AbsoluteFill style={{ background: glowB, opacity: 0.1 * DECOR }} />",
      "      {BG === \"grain\" ? (",
      "        <AbsoluteFill",
      "          style={{",
      "            backgroundImage:",
      "              \"repeating-linear-gradient(0deg, rgba(0,0,0,0.035) 0px, rgba(0,0,0,0.035) 1px, rgba(0,0,0,0) 1px, rgba(0,0,0,0) 3px)\",",
      "            opacity: DECOR,",
      "          }}",
      "        />",
      "      ) : null}",
      "      {BG === \"grid\" ? (",
      "        <AbsoluteFill",
      "          style={{",
      "            backgroundImage:",
      "              \"linear-gradient(rgba(0,0,0,0.05) 1px, rgba(0,0,0,0) 1px), linear-gradient(90deg, rgba(0,0,0,0.05) 1px, rgba(0,0,0,0) 1px)\",",
      "            backgroundSize: \"64px 64px\",",
      "            opacity: DECOR,",
      "          }}",
      "        />",
      "      ) : null}",
      "      <AbsoluteFill",
      "        style={{ background: \"radial-gradient(circle at 50% 44%, rgba(0,0,0,0) 42%, rgba(0,0,0,0.28) 100%)\" }}",
      "      />",
      "    </AbsoluteFill>",
      "  );",
      "};",
      "",
    ].join("\n");
  }

  function bulletsSrc() {
    return [
      "/* 要点逐条入场：起帧由生成期算好（字速与 stagger 在 motion.ts），这里只做插值。",
      "   focus / spot = 当前镜头特写的那一条（正文页的细节镜头会用）：那一条起、其余压暗；",
      "   tag = numeric / compare 时把这条里的数字做大做亮（Motion Graphics 的「数字当主角」）；",
      "   cards = 2.5D 档：每条要点是一张卡片，按层（depth = i + 1）做分层位移。 */",
      "import React from \"react\";",
      "import type { CSSProperties } from \"react\";",
      "import { interpolate, useCurrentFrame } from \"remotion\";",
      "import { EASE, ENTER_FRAMES, enterStyle, parallaxStyle, useScale } from \"./motion\";",
      "import { T } from \"./theme\";",
      "import type { Bullet } from \"./types\";",
      "",
      "const STAT_PARTS = /([0-9]+(?:[.,][0-9]+)?\\s*(?:%|％|倍|ms|s)?)/g;",
      "",
      "/* 数字当主角：只把这几个字符放大加色，其余原样（不改文本、不加字） */",
      "const StatText: React.FC<{ text: string }> = ({ text }) => (",
      "  <>",
      "    {String(text).split(STAT_PARTS).map((part, i) =>",
      "      part && /[0-9]/.test(part) ? (",
      "        <span",
      "          key={i}",
      "          style={{ color: T.accent, fontSize: \"1.14em\", fontWeight: 800, fontVariantNumeric: \"tabular-nums\" }}",
      "        >",
      "          {part}",
      "        </span>",
      "      ) : (",
      "        <React.Fragment key={i}>{part}</React.Fragment>",
      "      ),",
      "    )}",
      "  </>",
      ");",
      "",
      "export const Bullets: React.FC<{",
      "  bullets: Bullet[];",
      "  size: number;",
      "  numbered?: boolean;",
      "  focus?: number;",
      "  tag?: string;",
      "  cards?: boolean;",
      "  progress?: number;",
      "}> = ({ bullets, size, numbered, focus, tag, cards, progress }) => {",
      "  const frame = useCurrentFrame();",
      "  const k = useScale();",
      "  const prog = typeof progress === \"number\" ? progress : 0;",
      "  const statOn = tag === \"numeric\" || tag === \"compare\";",
      "  return (",
      "    <div style={{ display: \"flex\", flexDirection: \"column\", gap: Math.round(22 * k) }}>",
      "      {bullets.map((b, i) => {",
      "        const p = interpolate(frame, [b.from, b.from + ENTER_FRAMES], [0, 1], {",
      "          extrapolateLeft: \"clamp\",",
      "          extrapolateRight: \"clamp\",",
      "          easing: EASE,",
      "        });",
      "        const enter = enterStyle(p, k);",
      "        const active = typeof focus === \"number\" && focus === i;",
      "        const dim = typeof focus === \"number\" && focus >= 0 && !active ? 0.34 : 1;",
      "        const layer: CSSProperties = cards ? parallaxStyle(i + 1, prog, k) : {};",
      "        const cardStyle: CSSProperties = cards",
      "          ? {",
      "              background: T.paper2,",
      "              borderRadius: T.radius,",
      "              boxShadow: T.shadow,",
      "              padding: Math.round(18 * k) + \"px \" + Math.round(22 * k) + \"px\",",
      "            }",
      "          : {};",
      "        return (",
      "          <div",
      "            key={i}",
      "            style={{",
      "              ...cardStyle,",
      "              display: \"flex\",",
      "              flexDirection: \"row\",",
      "              alignItems: \"flex-start\",",
      "              ...enter,",
      "              opacity: (enter.opacity == null ? 1 : Number(enter.opacity)) * dim,",
      "              transform:",
      "                (enter.transform ? enter.transform + \" \" : \"\") +",
      "                (layer.transform ? layer.transform + \" \" : \"\") +",
      "                \"translateX(\" + (active ? Math.round(8 * k) : 0) + \"px)\",",
      "            }}",
      "          >",
      "            {numbered ? (",
      "              <span",
      "                style={{",
      "                  flex: \"0 0 auto\",",
      "                  width: Math.round(44 * k),",
      "                  color: T.muted,",
      "                  fontSize: Math.round(size * 0.8),",
      "                  fontVariantNumeric: \"tabular-nums\",",
      "                  lineHeight: 1.42,",
      "                }}",
      "              >",
      "                {i + 1}",
      "              </span>",
      "            ) : (",
      "              <span",
      "                style={{",
      "                  flex: \"0 0 auto\",",
      "                  width: Math.round(24 * k),",
      "                  height: Math.round(3 * k),",
      "                  marginTop: Math.round(size * 0.62),",
      "                  marginRight: Math.round(18 * k),",
      "                  background: T.accent,",
      "                  borderRadius: \"999px\",",
      "                }}",
      "              />",
      "            )}",
      "            <span style={{ flex: \"1 1 auto\", color: T.ink, fontSize: size, lineHeight: 1.42 }}>",
      "              {statOn && active ? <StatText text={b.text} /> : b.text}",
      "            </span>",
      "          </div>",
      "        );",
      "      })}",
      "    </div>",
      "  );",
      "};",
      "",
    ].join("\n");
  }

  function pageBodySrc() {
    return [
      "/* 单页版式：封面 / 大纲 / 正文 / 精读 / 术语 / 公式 / 文献 / 结语；未知 kind 退化成正文。",
      "   有 scene 的页走两栏：左边讲字，右边真 3D（Scene3D，three.js）；有叠加图的页也走两栏（右栏一张图）；",
      "   都没有就整页文字。展示风格在这一层落三件事：字号乘 TYPE_SCALE（motion 更大）、2.5D 的卡片按层位移、",
      "   以及 spot 指向的那一样东西（formula / quote / figure / scene / bullet）被点亮、其余压暗。",
      "   页上的式子已经是排好版的文字（内核 typesetMath 翻过），这里**不做任何 TeX 解析**——视频里没有 KaTeX，",
      "   也不该有：上屏的每一个字都必须是能直接看懂的排版结果。 */",
      "import React from \"react\";",
      "import { AbsoluteFill, Img, interpolate, useCurrentFrame, useVideoConfig } from \"remotion\";",
      "import { Bullets } from \"./Bullets\";",
      "import { Scene3D } from \"./Scene3D\";",
      "import { EASE, ENTER_FRAMES, enterStyle, PARALLAX, parallaxStyle, TYPE_SCALE, useScale } from \"./motion\";",
      "import { T } from \"./theme\";",
      "import type { MediaMap, SlidePage } from \"./types\";",
      "",
      "export const PageBody: React.FC<{ page: SlidePage; media?: MediaMap; focus?: number; spot?: string; tag?: string }> = ({",
      "  page,",
      "  media,",
      "  focus,",
      "  spot,",
      "  tag,",
      "}) => {",
      "  const k = useScale();",
      "  const frame = useCurrentFrame();",
      "  /* 页内进度（0 → 1）：2.5D 的分层位移按它走完一个来回 */",
      "  const prog = Math.max(0, Math.min(1, frame / Math.max(1, page.frames)));",
      "  const titleP = interpolate(frame, [2, 2 + ENTER_FRAMES], [0, 1], {",
      "    extrapolateLeft: \"clamp\",",
      "    extrapolateRight: \"clamp\",",
      "    easing: EASE,",
      "  });",
      "  const titleIn = enterStyle(titleP, k);",
      "  const isCover = page.kind === \"cover\";",
      "  const isEnd = page.kind === \"end\";",
      "  const isFormula = page.kind === \"formula\";",
      "  const withScene = !!page.scene;",
      "  /* 一页一张图：视频版先铺第一张（多张的页在 warnings 里点名，静态版仍然都铺） */",
      "  const fig = page.media && page.media.length ? page.media[0] : null;",
      "  const withFigure = !withScene && !!fig;",
      "  const imgOf = (name: string) => {",
      "    const map: MediaMap = media || {};",
      "    return name ? map[name] || \"\" : \"\";",
      "  };",
      "  const spotFormula = spot === \"formula\";",
      "  const spotQuote = spot === \"quote\";",
      "  const spotScene = spot === \"scene\";",
      "  const spotFigure = spot === \"figure\";",
      "  const spotBullet = spot === \"bullet\";",
      "  /* 没被点亮的块压暗（建立镜 spot = none 时一页都是亮的） */",
      "  const dimOthers = spot != null && spot !== \"none\";",
      "  const cards = PARALLAX > 0;",
      "  /* 2.5D 的三层（标题 / 图注 / 公式）各自一个景深，随页内进度位移；其余档是空对象 */",
      "  const titleLayer = parallaxStyle(1, prog, k);",
      "  const quoteLayer = parallaxStyle(2, prog, k);",
      "  const formulaLayer = parallaxStyle(3, prog, k);",
      "  const pad = Math.round((isCover || isEnd ? 120 : 96) * k);",
      "  /* 底部字幕带：字幕条贴底 72k + 自身约 84k 高 —— 正文与页码都必须让开这条带，",
      "     否则字幕会压住最后一条要点（这是上一版实拍里发现的硬伤）。 */",
      "  const CAPTION_BAND = Math.round(186 * k);",
      "  const titleSize0 = Math.round((isCover ? 104 : isEnd ? 88 : isFormula ? 40 : withScene ? 56 : 72) * k * TYPE_SCALE);",
      "  const metaSize0 = Math.round(26 * k * TYPE_SCALE);",
      "  const listSize0 = Math.round((withScene ? 32 : page.kind === \"toc\" || isEnd ? 34 : 42) * k * TYPE_SCALE);",
      "  /* 自适应字号：一页字多就把字号收一档，保证要点**不会溢出到字幕带里**（宁可小一点，不许压字）。",
      "     估算：可用高度 vs「每行能放几个字（中文字宽≈字号）× 每条折几行」，按倍率迭代三次收敛；",
      "     有图的页文字只占半版，收得更多（半版还要给图让位）。 */",
      "  const { width: VW, height: VH } = useVideoConfig();",
      "  const availH = VH - pad - (pad + CAPTION_BAND);",
      "  const textW = withScene || withFigure ? (VW - 2 * pad) * (withFigure ? 0.52 : 0.46) - 34 * k : VW - 2 * pad;",
      "  const needOf = (s: number) => {",
      "    const l = listSize0 * s;",
      "    const t = titleSize0 * s;",
      "    const m = metaSize0 * s;",
      "    /* 行数用连续估算（len / 每行字数 + 0.4）：整数 ceil 会在折行边界上跳，迭代就收敛不回去 */",
      "    const lines = (len: number, cpl: number) => len / Math.max(6, cpl) + 0.4;",
      "    const cpl = textW / (l * 1.02);",
      "    let need = 0;",
      "    if (page.kicker) need += m * 1.9;",
      "    need += lines(Array.from(page.title || \"\").length, textW / (t * 0.98)) * (t * 1.2) + 34 * k;",
      "    if (page.formula) {",
      "      const fw = (isFormula ? 0.86 : 1) * textW - 92 * k;",
      "      const fsz = (isFormula ? 64 : 44) * k * TYPE_SCALE;",
      "      need += lines(Array.from(page.formula).length, fw / (fsz * 0.62)) * fsz * 1.42 + 72 * k;",
      "    }",
      "    if (page.quote) need += lines(Array.from(page.quote).length, textW / (l * 0.72)) * l * 0.72 * 1.5 + 26 * k;",
      "    for (const b of page.bullets || []) need += lines(Array.from(String(b)).length, cpl) * l * 1.5 + 26 * k;",
      "    /* 实拍标定：这个估算系统性偏乐观约 25%（行首破折号、拉丁串、行内上标都会多折一行）——",
      "       乘上去宁可小半档，也不要让最后一行掉进字幕里。 */",
      "    return need * 1.26;",
      "  };",
      "  let fit = 1;",
      "  for (let i = 0; i < 6; i++) fit = Math.max(0.58, Math.min(1, (fit * availH) / Math.max(1, needOf(fit))));",
      "  /* 估算不是实测：收敛后再留 3% 余量（估计偏乐观时靠它兜住最后一行） */",
      "  fit = Math.max(0.58, Math.min(1, fit * 0.97));",
      "  const titleSize = Math.round(titleSize0 * fit);",
      "  const metaSize = Math.round(metaSize0 * fit);",
      "  const listSize = Math.round(listSize0 * fit);",
      "  const textCol = (",
      "    <div",
      "      style={{",
      "        flex: withScene ? \"0 0 46%\" : withFigure ? \"0 0 52%\" : \"1 1 auto\",",
      "        minWidth: 0,",
      "        display: \"flex\",",
      "        flexDirection: \"column\",",
      "        alignItems: isFormula ? \"center\" : undefined,",
      "        textAlign: isFormula ? \"center\" : undefined,",
      "        justifyContent: isCover || isEnd || isFormula ? \"center\" : \"flex-start\",",
      "        paddingRight: withScene || withFigure ? Math.round(34 * k) : 0,",
      "      }}",
      "    >",
      "      {page.kicker ? (",
      "        <div",
      "          style={{",
      "            color: T.muted,",
      "            fontSize: metaSize,",
      "            letterSpacing: Math.round(2 * k) + \"px\",",
      "            marginBottom: Math.round(18 * k),",
      "          }}",
      "        >",
      "          {page.kicker}",
      "        </div>",
      "      ) : null}",
      "      <div",
      "        style={{",
      "          ...titleIn,",
      "          ...titleLayer,",
      "          /* 入场位移与分层位移叠在一起（2.5D 不再吃掉标题的入场） */",
      "          transform: [titleIn.transform, titleLayer.transform].filter(Boolean).join(\" \") || undefined,",
      "          color: T.ink,",
      "          fontSize: titleSize,",
      "          fontWeight: 700,",
      "          lineHeight: 1.16,",
      "          letterSpacing: isCover ? \"-0.02em\" : undefined,",
      "          marginBottom: Math.round(24 * k),",
      "        }}",
      "      >",
      "        {page.title}",
      "      </div>",
      "      <div",
      "        style={{",
      "          width: Math.round(isCover ? 200 : 132) * k,",
      "          height: Math.round(5 * k),",
      "          background: T.accent,",
      "          borderRadius: T.radius,",
      "          marginBottom: Math.round(34 * k),",
      "        }}",
      "      />",
      "      {page.formula ? (",
      "        <div",
      "          style={{",
      "            ...formulaLayer,",
      "            color: T.primary,",
      "            background: T.paper2,",
      "            borderLeft: Math.round((spotFormula ? 12 : 6) * k) + \"px solid \" + T.accent,",
      "            borderRadius: T.radius,",
      "            boxShadow: T.shadow,",
      "            /* 公式镜：把式子本身放大（学术档的「公式特写」就是这一下） */",
      "            fontSize: Math.round((isFormula ? 64 : 44) * k * TYPE_SCALE * (spotFormula ? 1.16 : 1)),",
      "            lineHeight: 1.42,",
      "            alignSelf: isFormula ? \"center\" : undefined,",
      "            maxWidth: isFormula ? \"86%\" : undefined,",
      "            overflowWrap: \"anywhere\",",
      "            marginBottom: Math.round((isFormula ? 22 : 28) * k),",
      "            opacity: dimOthers && !spotFormula ? 0.72 : 1,",
      "            padding: Math.round((isFormula ? 36 : 24) * k) + \"px \" + Math.round((isFormula ? 46 : 32) * k) + \"px\",",
      "          }}",
      "        >",
      "          {page.formula}",
      "        </div>",
      "      ) : null}",
      "      {page.quote ? (",
      "        <div",
      "          style={{",
      "            ...quoteLayer,",
      "            /* 图注镜：引文提亮、左边线加粗（学术档的第二号特写对象） */",
      "            color: spotQuote ? T.ink : T.muted,",
      "            borderLeft: Math.round((spotQuote ? 9 : 5) * k) + \"px solid \" + (spotQuote ? T.accent : T.rule),",
      "            fontSize: Math.round(30 * k * TYPE_SCALE * (spotQuote ? 1.1 : 1)),",
      "            lineHeight: 1.5,",
      "            marginBottom: Math.round(26 * k),",
      "            opacity: dimOthers && !spotQuote ? 0.72 : 1,",
      "            paddingLeft: Math.round(22 * k),",
      "          }}",
      "        >",
      "          {page.quote}",
      "        </div>",
      "      ) : null}",
      "      {page.bullets.length ? (",
      "        <Bullets",
      "          bullets={page.bullets}",
      "          size={listSize}",
      "          numbered={page.kind === \"toc\"}",
      "          focus={focus}",
      "          tag={spotBullet ? tag : \"\"}",
      "          cards={cards}",
      "          progress={prog}",
      "        />",
      "      ) : null}",
      "    </div>",
      "  );",
      "  return (",
      "    <AbsoluteFill",
      "      style={{",
      "        /* AbsoluteFill 默认是 content-box：内边距会加在 100% 高度之外，正文直接被顶出画面。",
      "           这里必须 border-box —— 有它 padding + 字幕带才算「画内可用高度」。 */",
      "        boxSizing: \"border-box\",",
      "        overflow: \"hidden\",",
      "        padding: pad,",
      "        paddingBottom: pad + CAPTION_BAND,",
      "        display: \"flex\",",
      "        flexDirection: \"row\",",
      "        alignItems: \"stretch\",",
      "        backgroundColor: \"transparent\",",
      "        color: T.ink,",
      "        fontFamily: T.font,",
      "      }}",
      "    >",
      "      {textCol}",
      "      {withFigure ? (",
      "        <div",
      "          style={{",
      "            position: \"relative\",",
      "            flex: \"1 1 auto\",",
      "            minWidth: 0,",
      "            display: \"flex\",",
      "            alignItems: \"center\",",
      "            justifyContent: \"center\",",
      "            /* 图注镜：图点亮、轻推近一点，文字让开（其余镜里图仍在，只是压暗） */",
      "            opacity: spotFigure || !dimOthers ? 1 : 0.6,",
      "            transform: \"scale(\" + (spotFigure ? 1.04 : 1) + \")\",",
      "          }}",
      "        >",
      "          <div",
      "            style={{",
      "              width: \"100%\",",
      "              height: \"100%\",",
      "              display: \"flex\",",
      "              alignItems: \"center\",",
      "              justifyContent: \"center\",",
      "              background: T.paper2,",
      "              border: Math.round((spotFigure ? 3 : 2) * k) + \"px solid \" + (spotFigure ? T.accent : T.rule),",
      "              borderRadius: T.radius,",
      "              boxShadow: T.shadow,",
      "              padding: Math.round(16 * k) + \"px\",",
      "              boxSizing: \"border-box\",",
      "            }}",
      "          >",
      "            {imgOf(fig ? fig.name : \"\") ? (",
      "              <Img",
      "                src={imgOf(fig ? fig.name : \"\")}",
      "                style={{",
      "                  maxWidth: \"100%\",",
      "                  maxHeight: \"100%\",",
      "                  objectFit: \"contain\",",
      "                  borderRadius: Math.round(6 * k) + \"px\",",
      "                }}",
      "              />",
      "            ) : (",
      "              <div style={{ color: T.muted, fontSize: Math.round(24 * k * TYPE_SCALE), lineHeight: 1.6, textAlign: \"center\" }}>",
      "                {\"这一页有图：放映版里有；\"}",
      "                <br />",
      "                {\"视频工程没拿到图片字节（导出时会把 slides/media 里的图一起带上）\"}",
      "              </div>",
      "            )}",
      "          </div>",
      "        </div>",
      "      ) : null}",
      "      {withScene ? (",
      "        <div",
      "          style={{",
      "            position: \"relative\",",
      "            flex: \"1 1 auto\",",
      "            minWidth: 0,",
      "            /* 场景镜：三维画面收到正位、其余要素让开（轨道相机自己会转） */",
      "            opacity: spotScene || !dimOthers ? 1 : 0.62,",
      "            filter: spotScene ? undefined : \"saturate(0.86)\",",
      "          }}",
      "        >",
      "          <Scene3D scene={page.scene} />",
      "        </div>",
      "      ) : null}",
      "      <div",
      "        style={{",
      "          position: \"absolute\",",
      "          left: pad,",
      "          right: pad,",
      "          bottom: Math.round(46 * k) + CAPTION_BAND,",
      "          display: \"flex\",",
      "          justifyContent: \"space-between\",",
      "          color: T.muted,",
      "          fontSize: Math.round(22 * k * TYPE_SCALE),",
      "        }}",
      "      >",
      "        <span>{page.partLabel}</span>",
      "        <span>{page.index + \" / \" + page.total}</span>",
      "      </div>",
      "    </AbsoluteFill>",
      "  );",
      "};",
      "",
    ].join("\n");
  }

  function pageFrameSrc() {
    return [
      "/* 页级：转场（入场 + 尾部交叠）+ 背景（景深虚化）+ 镜头相机 */",
      "import React from \"react\";",
      "import { AbsoluteFill } from \"remotion\";",
      "import { Backdrop } from \"./Backdrop\";",
      "import { Camera } from \"./Camera\";",
      "import { useTransitionStyle } from \"./motion\";",
      "import type { MediaMap, SlidePage } from \"./types\";",
      "",
      "export const PageFrame: React.FC<{ page: SlidePage; media?: MediaMap }> = ({ page, media }) => {",
      "  const style = useTransitionStyle(page.frames, page.index === page.total);",
      "  return (",
      "    <AbsoluteFill style={style}>",
      "      <Backdrop depth={4} />",
      "      <Camera page={page} media={media} />",
      "    </AbsoluteFill>",
      "  );",
      "};",
      "",
    ].join("\n");
  }

  function cameraSrc() {
    return [
      "/* 镜头：按页内时间挑当前镜头（establish / focus），算出运镜与特写对象，交给 PageBody。",
      "   同一份 shots 既决定画面怎么动，也决定谁被点亮（focus = 要点下标，spot = 特写谁）—— 两者不会错位。 */",
      "import React from \"react\";",
      "import { AbsoluteFill, useCurrentFrame } from \"remotion\";",
      "import { PageBody } from \"./PageBody\";",
      "import { cameraStyle, useScale } from \"./motion\";",
      "import type { MediaMap, Shot, SlidePage } from \"./types\";",
      "",
      "const FALLBACK: Shot = { kind: \"establish\", from: 0, frames: 1, move: \"pushIn\", focus: -1, spot: \"none\", tag: \"\", depth: 3 };",
      "",
      "export const Camera: React.FC<{ page: SlidePage; media?: MediaMap }> = ({ page, media }) => {",
      "  const frame = useCurrentFrame();",
      "  const k = useScale();",
      "  const list = page.shots && page.shots.length ? page.shots : [FALLBACK];",
      "  let cur = list[0];",
      "  for (const s of list) if (frame >= s.from) cur = s;",
      "  const span = Math.max(1, cur.frames - 1);",
      "  const p = Math.max(0, Math.min(1, (frame - cur.from) / span));",
      "  return (",
      "    <AbsoluteFill style={{ overflow: \"hidden\", ...cameraStyle(cur.move, p, k) }}>",
      "      <PageBody page={page} media={media} focus={cur.focus} spot={cur.spot} tag={cur.tag} />",
      "    </AbsoluteFill>",
      "  );",
      "};",
      "",
    ].join("\n");
  }

  function scene3dSrc() {
    return [
      "/* 真 3D 场景（three.js，经 @remotion/three 的 ThreeCanvas）：",
      "   orbit  层级 / 系统：中心多面体 + 三条轨道；",
      "   grid   空间 / 结构：地面网格 + 高度随时间变化的柱；",
      "   signal 波 / 传播：一排球沿正弦起伏。",
      "   颜色只取 theme.ts 的 T.*；动画只由 useCurrentFrame 驱动（同输入同输出，可逐帧复核）。 */",
      "import React from \"react\";",
      "import { ThreeCanvas } from \"@remotion/three\";",
      "import { useCurrentFrame, useVideoConfig } from \"remotion\";",
      "import { T } from \"./theme\";",
      "",
      "const OrbitScene: React.FC = () => {",
      "  const frame = useCurrentFrame();",
      "  const a = frame * 0.012;",
      "  return (",
      "    <group rotation={[0.12, a, 0]}>",
      "      <ambientLight intensity={0.85} />",
      "      <directionalLight position={[3, 5, 4]} intensity={1.25} />",
      "      <mesh>",
      "        <icosahedronGeometry args={[0.92, 1]} />",
      "        <meshStandardMaterial color={T.primary} roughness={0.4} metalness={0.15} />",
      "      </mesh>",
      "      {[1.55, 2.0, 2.45].map((r, i) => (",
      "        <mesh key={i} rotation={[Math.PI / 2 + i * 0.32, 0, i * 0.2]}>",
      "          <torusGeometry args={[r, 0.012, 8, 128]} />",
      "          <meshStandardMaterial color={i === 0 ? T.accent : T.rule} />",
      "        </mesh>",
      "      ))}",
      "    </group>",
      "  );",
      "};",
      "",
      "const GridScene: React.FC = () => {",
      "  const frame = useCurrentFrame();",
      "  const t = frame * 0.045;",
      "  const bars = [-2.4, -1.6, -0.8, 0, 0.8, 1.6, 2.4];",
      "  return (",
      "    <group position={[0, 0.15, 0]} rotation={[0.16, -0.42 + Math.sin(t * 0.5) * 0.12, 0]}>",
      "      <ambientLight intensity={0.9} />",
      "      <directionalLight position={[2, 6, 3]} intensity={1.1} />",
      "      <gridHelper args={[16, 16, T.rule, T.rule]} position={[0, -1.3, 0]} />",
      "      {bars.map((x, i) => {",
      "        const h = 0.7 + Math.abs(Math.sin(t + i * 0.7)) * 1.5;",
      "        return (",
      "          <mesh key={i} position={[x, -1.3 + h / 2, 0]}>",
      "            <boxGeometry args={[0.42, h, 0.42]} />",
      "            <meshStandardMaterial color={i % 3 === 0 ? T.accent : T.primary} roughness={0.45} />",
      "          </mesh>",
      "        );",
      "      })}",
      "    </group>",
      "  );",
      "};",
      "",
      "const SignalScene: React.FC = () => {",
      "  const frame = useCurrentFrame();",
      "  const t = frame * 0.08;",
      "  const dots = Array.from({ length: 16 }, (_, i) => i);",
      "  return (",
      "    <group rotation={[0.1, -0.25, 0]}>",
      "      <ambientLight intensity={0.9} />",
      "      <directionalLight position={[1, 4, 5]} intensity={1} />",
      "      <mesh position={[0, 0, -0.4]}>",
      "        <boxGeometry args={[7.2, 0.02, 0.02]} />",
      "        <meshStandardMaterial color={T.rule} />",
      "      </mesh>",
      "      {dots.map((i) => {",
      "        const x = -3.4 + i * 0.45;",
      "        const y = Math.sin(t + i * 0.55) * 0.75;",
      "        return (",
      "          <mesh key={i} position={[x, y, 0]}>",
      "            <sphereGeometry args={[0.085 + Math.abs(y) * 0.06, 16, 16]} />",
      "            <meshStandardMaterial color={i % 4 === 0 ? T.accent : T.primary} emissive={T.primary} emissiveIntensity={0.25} />",
      "          </mesh>",
      "        );",
      "      })}",
      "    </group>",
      "  );",
      "};",
      "",
      "export const Scene3D: React.FC<{ scene: string }> = ({ scene }) => {",
      "  const { width, height } = useVideoConfig();",
      "  const w = Math.round(width * 0.5);",
      "  const h = Math.round(height * 0.78);",
      "  const body = scene === \"grid\" ? <GridScene /> : scene === \"signal\" ? <SignalScene /> : <OrbitScene />;",
      "  return (",
      "    <div",
      "      style={{",
      "        position: \"absolute\",",
      "        inset: 0,",
      "        display: \"flex\",",
      "        alignItems: \"center\",",
      "        justifyContent: \"center\",",
      "      }}",
      "    >",
      "      <ThreeCanvas",
      "        width={w}",
      "        height={h}",
      "        camera={{ position: [0, 0.6, 5.4], fov: 42 }}",
      "        style={{ width: w, height: h }}",
      "        gl={{ antialias: true, alpha: true }}",
      "      >",
      "        {body}",
      "      </ThreeCanvas>",
      "    </div>",
      "  );",
      "};",
      "",
    ].join("\n");
  }

  function chapterSrc() {
    return [
      "/* 章节过场卡：大号序号 + 竖分隔 + 段标题 + 一条扫过的进度线（标题取自页的 kicker，不新造文案） */",
      "import React from \"react\";",
      "import { AbsoluteFill, interpolate, useCurrentFrame } from \"remotion\";",
      "import { EASE, useScale, useTransitionStyle } from \"./motion\";",
      "import { T } from \"./theme\";",
      "import type { ChapterSeg } from \"./types\";",
      "",
      "export const ChapterCard: React.FC<{ seg: ChapterSeg }> = ({ seg }) => {",
      "  const k = useScale();",
      "  const frame = useCurrentFrame();",
      "  const style = useTransitionStyle(seg.frames, false);",
      "  const no = seg.no < 10 ? \"0\" + seg.no : String(seg.no);",
      "  const sweep = interpolate(frame, [4, 4 + Math.round(seg.frames * 0.42)], [0, 1], {",
      "    extrapolateLeft: \"clamp\",",
      "    extrapolateRight: \"clamp\",",
      "    easing: EASE,",
      "  });",
      "  return (",
      "    <AbsoluteFill",
      "      style={{",
      "        ...style,",
      "        backgroundColor: T.paper,",
      "        color: T.ink,",
      "        fontFamily: T.font,",
      "        justifyContent: \"center\",",
      "        paddingLeft: Math.round(160 * k),",
      "      }}",
      "    >",
      "      <div style={{ display: \"flex\", flexDirection: \"row\", alignItems: \"center\", gap: Math.round(40 * k) }}>",
      "        <div",
      "          style={{",
      "            color: T.rule,",
      "            fontSize: Math.round(180 * k),",
      "            fontWeight: 800,",
      "            letterSpacing: Math.round(-6 * k) + \"px\",",
      "            lineHeight: 1,",
      "          }}",
      "        >",
      "          {no}",
      "        </div>",
      "        <div style={{ width: Math.round(1.5 * k), height: Math.round(160 * k), background: T.rule }} />",
      "        <div>",
      "          <div",
      "            style={{",
      "              color: T.muted,",
      "              fontSize: Math.round(26 * k),",
      "              letterSpacing: Math.round(4 * k) + \"px\",",
      "              marginBottom: Math.round(14 * k),",
      "            }}",
      "          >",
      "            {\"第 \" + seg.no + \" 章\"}",
      "          </div>",
      "          <div style={{ color: T.ink, fontSize: Math.round(64 * k), fontWeight: 700, lineHeight: 1.16 }}>",
      "            {seg.label}",
      "          </div>",
      "        </div>",
      "      </div>",
      "      <div",
      "        style={{",
      "          position: \"absolute\",",
      "          left: Math.round(160 * k),",
      "          bottom: Math.round(150 * k),",
      "          width: Math.round(560 * k),",
      "          height: Math.round(4 * k),",
      "          background: T.rule,",
      "          borderRadius: T.radius,",
      "        }}",
      "      >",
      "        <div",
      "          style={{",
      "            width: Math.round(560 * k * sweep) + \"px\",",
      "            height: \"100%\",",
      "            background: T.accent,",
      "            borderRadius: T.radius,",
      "          }}",
      "        />",
      "      </div>",
      "    </AbsoluteFill>",
      "  );",
      "};",
      "",
    ].join("\n");
  }

  function captionsSrc() {
    return [
      "/* 逐词字幕：按脚本旁白（notes「旁白：」逐句）的时间轴铺 —— 没有旁白音轨也照常铺，",
      "   有音轨时它就是音轨的逐词时间轴（两条路径不各算一份）。",
      "   一屏显示当前整句（说到哪个词就亮哪个，数据是 ms 级真值）；",
      "   字号跟展示风格走（学术小而稳、Motion 快而大），不在这里再判一次风格。 */",
      "import React from \"react\";",
      "import { AbsoluteFill, useCurrentFrame, useVideoConfig } from \"remotion\";",
      "import { CAPTION_SIZE, useScale } from \"./motion\";",
      "import { T } from \"./theme\";",
      "import type { Caption } from \"./types\";",
      "",
      "export const Captions: React.FC<{ captions: Caption[] }> = ({ captions }) => {",
      "  const frame = useCurrentFrame();",
      "  const { fps } = useVideoConfig();",
      "  const k = useScale();",
      "  const nowMs = (frame / fps) * 1000;",
      "  let cur = -1;",
      "  for (let i = 0; i < captions.length; i++) {",
      "    if (captions[i].startMs <= nowMs) cur = i;",
      "    else break;",
      "  }",
      "  if (cur < 0) return null;",
      "  /* 一屏显示「当前整句」：从上一个句末块之后起，到当前句的句末块止。",
      "     按时间窗滚动的写法在中文里只露出五六个字，观众读不到上下文（旁白音轨可能根本没有）。",
      "     句子太长就从句首往前裁（最多 MAXC 字，仍然一屏），句与句之间靠句末标点与时间空档断开。 */",
      "  const GAP = 700;",
      "  /* 分号也算断句：一屏只放一个分句，长句就不会被掐头成残句。 */",
      "  const isEnd = (t: string) => /[。！？!?；;]$/.test((t || \"\").trim());",
      "  let from = 0;",
      "  for (let i = cur - 1; i >= 0; i--) {",
      "    if (isEnd(captions[i].text) || captions[i + 1].startMs - captions[i].endMs > GAP) {",
      "      from = i + 1;",
      "      break;",
      "    }",
      "  }",
      "  let to = cur;",
      "  for (let i = cur; i < captions.length; i++) {",
      "    to = i;",
      "    if (isEnd(captions[i].text)) break;",
      "    if (i + 1 < captions.length && captions[i + 1].startMs - captions[i].endMs > GAP) break;",
      "  }",
      "  const MAXC = 34;",
      "  const lenOf = (a: number, b: number) => {",
      "    let n = 0;",
      "    for (let i = a; i <= b; i++) n += (captions[i].text || \"\").length;",
      "    return n;",
      "  };",
      "  while (from < cur && lenOf(from, to) > MAXC) from++;",
      "  /* 掐头不许掐在拉丁／数字串中间：起点必须是中文或开括号，否则再往后挪一块",
      "     （否则会出现「logN；而独立系数…」这种半截残句）。 */",
      "  while (from < cur && !/^[\\u4e00-\\u9fff（(《「“]/.test((captions[from].text || \"\").trim())) from++;",
      "  const shown = captions.slice(from, to + 1);",
      "  const chars = lenOf(from, to);",
      "  return (",
      "    <AbsoluteFill style={{ alignItems: \"center\", justifyContent: \"flex-end\", paddingBottom: Math.round(72 * k) }}>",
      "      <div",
      "        style={{",
      "          background: T.paper,",
      "          border: Math.round(2 * k) + \"px solid \" + T.rule,",
      "          borderRadius: T.radius,",
      "          boxShadow: T.shadow,",
      "          color: T.muted,",
      "          display: \"flex\",",
      "          flexDirection: \"row\",",
      "          flexWrap: \"wrap\",",
      "          fontSize: Math.round(CAPTION_SIZE * k * (chars > 34 ? 0.85 : 1)),",
      "          fontWeight: 600,",
      "          gap: Math.round(6 * k) + \" \" + Math.round(12 * k),",
      "          justifyContent: \"center\",",
      "          maxWidth: \"82%\",",
      "          padding: Math.round(16 * k) + \"px \" + Math.round(28 * k) + \"px\",",
      "        }}",
      "      >",
      "        {shown.map((c, i) => {",
      "          const active = nowMs >= c.startMs && nowMs < c.endMs;",
      "          return (",
      "            <span key={i} style={{ color: active ? T.primary : T.muted }}>",
      "              {c.text}",
      "            </span>",
      "          );",
      "        })}",
      "      </div>",
      "    </AbsoluteFill>",
      "  );",
      "};",
      "",
    ].join("\n");
  }

  function compositionSrc(contract) {
    return [
      "/* 研究演示 · 视频版合成入口：页 → 序列（片头 → 章节 → 要点逐条 → 结尾）。",
      "   数据全在 data.ts / theme.ts / motion.ts（生成期算好），这里只排时间轴与转场。",
      "   端子：唯一可选的是旁白音轨（空 = 不铺旁白音轨；字幕仍按脚本旁白逐句的时间轴铺）。 */",
      "import React from \"react\";",
      "import { AbsoluteFill, Audio, Sequence, staticFile } from \"remotion\";",
      "import { CHAPTERS, CAPTIONS, PAGES, SEGMENTS } from \"./data\";",
      "import { Backdrop } from \"./Backdrop\";",
      "import { Captions } from \"./Captions\";",
      "import { ChapterCard } from \"./ChapterCard\";",
      "import { PageFrame } from \"./PageFrame\";",
      "import { DURATION_IN_FRAMES, FPS, HEIGHT, WIDTH } from \"./motion\";",
      "import { T } from \"./theme\";",
      "import type { ChapterSeg, MediaMap, SlidePage } from \"./types\";",
      "",
      "/* 端子契约：旁白音轨（可空）—— 有它就铺 <Audio>；逐词字幕不看它，有 CAPTIONS 就铺 */",
      "export const inputs = " + JSON.stringify(contract) + ";",
      "",
      "/* media：叠加图的字节（name → data URL）。工程本身不带图（那是可执行代码，不是素材包），",
      "   由导出 / 渲染那一侧在 props 里给；没给的页画占位框，不会因为缺一张图整支片子渲不出来。 */",
      "export type MainProps = { narration?: string; media?: MediaMap };",
      "",
      "const PAGES_BY_ID: { [key: string]: SlidePage } = {};",
      "for (const p of PAGES) PAGES_BY_ID[p.id] = p;",
      "const CHAPTERS_BY_ID: { [key: string]: ChapterSeg } = {};",
      "for (const c of CHAPTERS) CHAPTERS_BY_ID[c.id] = c;",
      "",
      "/* calculateMetadata：时长 / 分辨率 / 帧率全部由生成期算好（与宿主 render.json 同值） */",
      "export const calculateMetadata = () => ({",
      "  durationInFrames: DURATION_IN_FRAMES,",
      "  fps: FPS,",
      "  width: WIDTH,",
      "  height: HEIGHT,",
      "});",
      "",
      "export const Main: React.FC<MainProps> = (props) => {",
      "  const narration = props && props.narration ? String(props.narration) : \"\";",
      "  const media: MediaMap = (props && props.media) || {};",
      "  const src = narration ? (narration.indexOf(\"http\") === 0 ? narration : staticFile(narration)) : \"\";",
      "  return (",
      "    <AbsoluteFill style={{ backgroundColor: T.paper, color: T.ink, fontFamily: T.font }}>",
      "      <Backdrop />",
      "      {SEGMENTS.map((seg) => {",
      "        const pg = PAGES_BY_ID[seg.id];",
      "        const ch = CHAPTERS_BY_ID[seg.id];",
      "        return (",
      "          <Sequence key={seg.id} from={seg.from} durationInFrames={seg.frames} layout=\"none\">",
      "            {seg.kind === \"chapter\" ? (",
      "              ch ? (",
      "                <ChapterCard seg={ch} />",
      "              ) : null",
      "            ) : pg ? (",
      "              <PageFrame page={pg} media={media} />",
      "            ) : null}",
      "          </Sequence>",
      "        );",
      "      })}",
      "      {src ? <Audio src={src} /> : null}",
      "      {CAPTIONS.length ? <Captions captions={CAPTIONS} /> : null}",
      "    </AbsoluteFill>",
      "  );",
      "};",
      "",
    ].join("\n");
  }

  /* ── 主入口：deck + theme + brief → 工程源码树 + 时间轴 ───────────────────── */
  function build(input) {
    const RS = core();
    const warnings = [];
    if (!RS) {
      return { ok: false, error: "页模型内核（research-slides.js）没加载，视频工程生成不了", files: null, warnings: warnings };
    }
    const o = input && typeof input === "object" ? input : {};
    const deck = o.deck && typeof o.deck === "object" ? o.deck : null;
    if (!deck || !Array.isArray(deck.pages) || !deck.pages.length) {
      return { ok: false, error: "没有可排的页（先有主稿与演示页再出视频）", files: null, warnings: warnings };
    }
    const fps = RS.FPS || 30;
    const brief = RS.normalizeBrief(o.brief != null ? o.brief : RS.briefOf(deck));
    const theme = RS.normalizeTheme(o.theme || deck.theme || {});
    const aspect = RS.normalizeAspect(o.aspect || deck.aspect);
    const dims = Object.assign({}, resolutionOf(aspect), { fps: fps });
    /* 可见页 → 视频计划（时长目标只影响「留哪几页」，从不动 deck） */
    const visible = RS.visiblePages(deck);
    if (!visible.length) {
      return { ok: false, error: "所有页都被隐藏了，视频没有内容", files: null, warnings: warnings };
    }
    const tokens = RS.styleTokens(brief, theme, visible);
    const motion = tokens.motion;
    /* 展示风格：styleTokens 已经判好（auto → 具体档），meta 与 warnings 都写这一个值，
       界面上的「风格：X」与派单指示读的是同一份，不会各判一次。 */
    const style = str(tokens.style) || str(RS.DEFAULT_STYLE) || "scholarly";
    const styleLabel = str(tokens.styleLabel) || style;
    const stylePicked = str(brief.style) === "auto" || !str(brief.style);
    const transition = RS.TRANSITIONS.indexOf(str(tokens.transition)) >= 0 ? str(tokens.transition) : "fade";
    /* 展示风格的演法参数（镜头 / 运镜 / 字号 / 遮罩转场 / 字幕节奏 / 装饰）：只在这里取一份，
       镜头编排、工程源码、meta 与 warnings 全读它，不会各判一次。 */
    const play = stylePlayOf(style);
    const typeScale = Number(play.typeScale) || 1;
    const captionWindowMs = Math.max(600, roundInt(play.captionWindowMs) || CAPTION_WINDOW_MS);
    const pace = Number(motion.pace) > 0 ? Number(motion.pace) : 1;
    const plan = tokens.plan || { keep: visible.map((pg) => str(pg.id)), drop: [], note: "" };
    const keep = new Set((Array.isArray(plan.keep) ? plan.keep : []).map((id) => str(id)));
    const selected = visible.filter((pg) => (keep.size ? keep.has(str(pg.id)) : true));

    /* ① 章节卡：按 kicker 首段的变化处插（同一段只插一次，最多 8 张） */
    const chapterBefore = new Map();
    const seenChapter = new Set();
    let chapterNo = 0;
    for (let i = 1; i < selected.length; i++) {
      const key = chapterKeyOf(selected[i]);
      if (!key || seenChapter.has(key) || chapterNo >= MAX_CHAPTERS) continue;
      seenChapter.add(key);
      chapterNo += 1;
      chapterBefore.set(str(selected[i].id), { label: key, no: chapterNo });
    }

    /* ② 片段序列：页秒数 × 节奏系数；章节卡另算 */
    const items = [];
    let pageIndex = 0;
    for (const pg of selected) {
      const ch = chapterBefore.get(str(pg.id));
      if (ch) items.push({ type: "chapter", label: ch.label, no: ch.no, sec: chapterSecPaced(ch.label, motion, pace), id: "chapter-" + ch.no });
      pageIndex += 1;
      items.push({
        type: "page",
        page: pg,
        index: pageIndex,
        sec: pageSecPaced(pg, motion, pace, RS),
        id: str(pg.id),
      });
    }

    /* ③ 帧落点：转场交叠在上一页尾巴里 → 每段多渲染 tailSec，起始时刻仍是累积秒 */
    const tailSec = Math.max(0, Number(motion.transitionFrames) || 0) / fps;
    let cum = 0;
    items.forEach((it, i) => {
      const isLast = i === items.length - 1;
      it.sec = round2(it.sec);
      it.from = Math.round(cum * fps);
      it.frames = Math.max(1, Math.round((it.sec + (isLast ? 0 : tailSec)) * fps));
      cum = round2(cum + it.sec);
    });
    const totalSec = round2(cum);
    const totalFrames = Math.max(1, Math.round(totalSec * fps));

    /* ④ 三份数据：页 / 章节 / 片段 */
    const pages = [];
    const chapters = [];
    const segments = [];
    /* 3D 场景页预算按展示风格给（内核 STYLE_SCENE_MAX：3D 6 页 / 学术 1 页 / Motion 0 页 / 2.5D 2 页）；
       每个 ThreeCanvas 一个 WebGL context（Chromium 上限约 16），超预算的页降级成纯文字页并点名（不静默丢场景）。 */
    const SCENE_MAX = Number.isFinite(Number(tokens.sceneMax)) ? Math.max(0, Math.round(Number(tokens.sceneMax))) : 6;
    let sceneCount = 0;
    const sceneDropped = [];
    /* 叠加图清单：视频工程不带素材字节（它是可执行代码），只带「哪一页有哪张图」的键；
       导出 / 渲染那一侧按 name 把 slides/media 里的图读成 data URL 塞进 props.media。 */
    const mediaList = [];
    const mediaNames = new Set();
    const mediaMulti = [];
    const mediaVideo = [];
    for (const it of items) {
      if (it.type === "chapter") {
        chapters.push({ id: it.id, label: it.label, no: it.no, from: it.from, frames: it.frames, sec: it.sec });
        segments.push({ id: it.id, kind: "chapter", from: it.from, frames: it.frames });
        continue;
      }
      const pg = it.page;
      const displayFrames = Math.max(1, roundInt(it.sec * fps));
      /* 先算要点（已剔掉公式行），镜头规划按**同一份**要点数切 focus 镜 —— 否则会聚焦到不存在的条目 */
      const bullets = bulletFramesOf(pg, motion, it.frames, fps);
      let scene = str(pg.scene);
      if (scene) {
        if (sceneCount < SCENE_MAX) sceneCount++;
        else {
          sceneDropped.push(str(pg.title));
          scene = "";
        }
      }
      const pageMedia = [];
      const srcMedia = Array.isArray(pg.media) ? pg.media : [];
      let figNo = 0;
      for (const m of srcMedia) {
        if (!m || !str(m.src)) continue;
        if (str(m.kind) === "video") {
          mediaVideo.push(str(pg.title));
          continue;
        }
        figNo++;
        const name = mediaNameOf(it.index, figNo, m.src, mediaNames);
        const one = {
          name: name,
          src: str(m.src),
          x: Number(m.x) || 0,
          y: Number(m.y) || 0,
          w: Number(m.w) || 0,
          h: Number(m.h) || 0,
          fit: str(m.fit) === "cover" ? "cover" : "contain",
        };
        pageMedia.push(one);
        mediaList.push(Object.assign({ pageId: str(pg.id), page: it.index, title: str(pg.title) }, one));
      }
      if (pageMedia.length > 1) mediaMulti.push(str(pg.title) + "（" + pageMedia.length + " 张）");
      pages.push({
        id: str(pg.id),
        kind: str(pg.kind),
        title: str(pg.title),
        kicker: str(pg.kicker),
        bullets: bullets,
        quote: str(pg.quote),
        formula: str(pg.formula),
        note: str(pg.note),
        partLabel: Number(pg.part) > 1 ? "续 " + Number(pg.part) : "",
        index: it.index,
        total: selected.length,
        from: it.from,
        frames: it.frames,
        sec: it.sec,
        scene: scene,
        /* 叠加图（只认图片；视频叠加物在 warnings 里点名，不进这一版） */
        media: pageMedia,
        /* 镜头必须铺满 it.frames（含尾部交叠），否则最后一镜会提前收尾；
           怎么切按展示风格（学术：建立镜 + 图注 / 公式特写、慢推；motion：数字与对比镜；2.5D / 3D：分层与场景镜） */
        shots: planShots(
          Object.assign({}, pg, { scene: scene, media: pageMedia, bullets: bullets.map((b) => b.text) }),
          motion,
          it.frames,
          fps,
          style,
        ),
      });
      segments.push({ id: str(pg.id), kind: "page", from: it.from, frames: it.frames });
    }

    /* ⑤ 旁白：notes 逐句 → 页内时间窗 → 逐词字幕（无 notes = 空数组，不铺字幕）
       这条时间轴是脚本自己的（「旁白：」写的那几句），与有没有旁白音轨无关 ——
       无音轨时 data.ts 里同样有 CAPTIONS，Main 照常铺字幕。
       节奏跟展示风格走：学术留的白多（起 500ms 收 380ms），Motion 贴着画面走（260 / 200）。
       两个留白都夹在本页时间窗的比例内 —— 页再短也不会把字幕挤到窗外。 */
    const captions = [];
    const narration = [];
    for (const pg of pages) {
      const sentences = sentencesOf(narrationTextOf(pg.note));
      if (!sentences.length) continue;
      const winStart = Math.round((pg.from / fps) * 1000);
      const winEnd = Math.round(((pg.from + roundInt(pg.sec * fps)) / fps) * 1000);
      const winLen = Math.max(1, winEnd - winStart);
      const startMs = winStart + Math.max(0, Math.min(roundInt(play.captionLeadMs) || 0, Math.round(winLen * 0.25)));
      const endMs = winEnd - Math.max(0, Math.min(roundInt(play.captionTailMs) || 0, Math.round(winLen * 0.2)));
      const span = Math.max(600, endMs - startMs);
      const totalChars = sentences.reduce((n, s) => n + Math.max(1, charLen(s)), 0);
      let cursor = startMs;
      for (const sentence of sentences) {
        const len = Math.max(1, charLen(sentence));
        const dur = (len / totalChars) * span;
        const sMs = Math.round(cursor);
        const eMs = Math.round(cursor + dur);
        narration.push({ pageId: pg.id, text: sentence, startMs: sMs, endMs: eMs });
        const tokens = tokenize(sentence);
        const tokenChars = tokens.reduce((n, t) => n + Math.max(1, charLen(t)), 0);
        let tCursor = sMs;
        for (const tk of tokens) {
          const share = (Math.max(1, charLen(tk)) / Math.max(1, tokenChars)) * Math.max(1, eMs - sMs);
          const tStart = Math.round(tCursor);
          const tEnd = Math.round(tCursor + share);
          captions.push({
            text: tk,
            startMs: tStart,
            endMs: Math.max(tStart + 20, tEnd),
            timestampMs: Math.round((tStart + tEnd) / 2),
            confidence: null,
          });
          tCursor += share;
        }
        cursor += dur;
      }
    }

    /* ⑥ 工程源码树：每次全量重写，组件文件名稳定（宿主会清掉上一版多余源码） */
    const themeTable = themeTableOf(tokens);
    const files = {
      "types.ts": typesSrc(),
      "theme.ts": themeSrc(themeTable),
      "motion.ts": motionSrc(motion, transition, dims, totalFrames, style, play),
      "data.ts": dataSrc({
        deck: { title: str(deck.title), date: str(deck.date) },
        pages: pages,
        chapters: chapters,
        segments: segments,
        captions: captions,
      }),
      "Backdrop.tsx": backdropSrc(),
      "Bullets.tsx": bulletsSrc(),
      "PageBody.tsx": pageBodySrc(),
      "Camera.tsx": cameraSrc(),
      "Scene3D.tsx": scene3dSrc(),
      "PageFrame.tsx": pageFrameSrc(),
      "ChapterCard.tsx": chapterSrc(),
      "Captions.tsx": captionsSrc(),
      [ENTRY]: compositionSrc(CONTRACT),
    };

    /* ⑦ 颜色清单：工程里出现的每个 #hex 都必须在这里（= 全部来自 styleTokens） */
    const colors = [];
    for (const key of Object.keys(themeTable)) {
      const v = str(themeTable[key]);
      if (/^#[0-9a-fA-F]{3,8}$/.test(v)) colors.push(v.toLowerCase());
    }

    /* buildKey = hash(页 id 序列 + 每页 title/bullets/quote + 镜头编排 + theme + brief + aspect + fps)：
       改任意一样就变（换展示风格会让镜头 / 字号 / 转场一起变，所以 style 与 shots 都在里面）→
       编辑器据此把「已生成」置灰（spec §6 补充口径），放不出旧片。 */
    const buildKey = RS.hashString(
      JSON.stringify({
        ver: VER,
        pages: pages.map((pg) => [
          pg.id,
          pg.title,
          pg.kicker,
          pg.quote,
          pg.formula,
          pg.scene,
          pg.media.map((m) => m.name),
          pg.bullets.map((b) => b.text),
          pg.shots.map((s) => [s.kind, s.from, s.frames, s.move, s.focus, s.spot, s.tag]),
        ]),
        style: style,
        theme: tokens.theme,
        motion: motion,
        brief: brief,
        aspect: aspect,
        fps: fps,
      }),
    );

    const meta = {
      id: "Main",
      entry: ENTRY,
      fps: fps,
      width: dims.width,
      height: dims.height,
      durationInFrames: totalFrames,
      durationSec: totalSec,
      aspect: aspect,
      pageCount: pages.length,
      chapterCount: chapters.length,
      captionCount: captions.length,
      narrationSentences: narration.length,
      shotCount: pages.reduce((n, pg) => n + (pg.shots ? pg.shots.length : 0), 0),
      sceneCount: sceneCount,
      /* 叠加图清单（name / src / 页）：导出侧按 name 把图读成 data URL 传进 props.media */
      mediaCount: mediaList.length,
      media: mediaList,
      briefMode: brief.mode,
      /* 展示风格（怎么演）：meta.style = 具体档（auto 已判成具体那一种），stylePicked = 是不是自动判的 */
      style: style,
      styleLabel: styleLabel,
      stylePicked: stylePicked,
      styleSceneMax: Math.max(0, Math.round(Number(tokens.sceneMax) || 0)),
      /* 这一档的演法（镜头 / 字号 / 转场 / 字幕 / 装饰）：界面与日志读这一份，不在别处再判一次 */
      shotFocusMax: Math.max(0, roundInt(play.focusMax)),
      cameraEstablish: str(play.moves && play.moves.establish),
      cameraFocus: str(play.moves && play.moves.focus),
      typeScale: typeScale,
      decor: Number(play.decor) || 0,
      maskTransition: !!play.mask,
      layeredCards: !!play.cards,
      captionWindowMs: captionWindowMs,
      captionSize: Math.max(20, roundInt(play.captionSize) || 34),
      sceneMax: SCENE_MAX,
      pace: pace,
      transition: transition,
      ease: str(motion.ease),
      enter: str(motion.enter),
      bg: str(motion.bg),
      planNote: str(plan.note),
      audioTerminal: CONTRACT[0].key,
      buildKey: buildKey,
    };

    /* 展示风格记一行：界面 / 日志一眼能看出这条片按哪种风格演（auto 也写明是自动判的） */
    warnings.push(
      "展示风格：" +
        styleLabel +
        "（" +
        (stylePicked ? "按内容自动判定" : "初始化卡上选定") +
        "）—— 缓动 " +
        str(motion.ease) +
        " / 入场 " +
        str(motion.enter) +
        " " +
        Math.max(1, roundInt(motion.enterFrames)) +
        " 帧 / 节拍 " +
        Math.max(1, roundInt(motion.bpm)) +
        " · 背景 " +
        str(motion.bg) +
        "；每页秒数按这套字速与节拍算",
    );
    /* 这一档怎么演：镜头 / 转场 / 字号 / 字幕 / 3D 预算，与上面那行同一个 style（不另判一次） */
    warnings.push(
      "这一档的演法：" +
        play.moves.establish +
        " 建立镜 + 最多 " +
        Math.max(0, roundInt(play.focusMax)) +
        " 个 " +
        str(play.moves.focus) +
        " 细节镜（学术特写图注与公式 / Motion 特写数字与对比 / 2.5D 分层卡片 / 3D 场景镜）· " +
        (play.mask ? "遮罩转场" : "淡入淡出") +
        " · 字号 × " +
        typeScale +
        " · 字幕一屏 " +
        captionWindowMs +
        "ms · 装饰 " +
        (Number(play.decor) || 0) +
        " · 3D 场景预算 " +
        SCENE_MAX +
        " 页",
    );
    /* ⑧ 如实记下没做进来的东西（不静默） */
    const dropped = Array.isArray(plan.drop) ? plan.drop : [];
    if (dropped.length) warnings.push("按目标时长裁掉了 " + dropped.length + " 页（文献 → 公式 → 术语，正文一页不砍）：" + dropped.join("、"));
    if (Number(brief.durationSec) > 0) {
      warnings.push(
        "排片：" +
          str(plan.note) +
          "；加上 " +
          chapters.length +
          " 张章节卡，全片 " +
          totalSec +
          " 秒（" +
          totalFrames +
          " 帧）",
      );
    }
    if (brief.avoid.length) warnings.push("忌口（" + brief.avoid.join("、") + "）只进重写派单，不在时间轴上删页 —— 页仍留在静态版里");
    const withMedia = pages.filter((pg) => {
      const src = RS.pageById(deck, pg.id);
      return !!(src && ((src.media && src.media.length) || (src.objects && src.objects.length)));
    });
    if (mediaList.length) {
      warnings.push(
        "叠加图 " +
          mediaList.length +
          " 张已铺进视频（" +
          pages.filter((pg) => pg.media.length).length +
          " 页）：" +
          mediaList.map((m) => str(m.name)).join("、") +
          " —— 图片字节经 props.media 传入（导出会自动带上 slides/media 里的图；工程本身不带素材）",
      );
    }
    if (mediaMulti.length) warnings.push("这几页不止一张图，视频版先铺第一张（静态版仍然都铺）：" + mediaMulti.join("、"));
    if (mediaVideo.length) warnings.push("这几页的叠加物是视频，不进视频版（先出图与字）：" + mediaVideo.join("、"));
    if (!mediaList.length && withMedia.length) {
      warnings.push("有 " + withMedia.length + " 页在静态版里带叠加媒体 / 自由版面对象，视频版没有可铺的图（objects 不进视频）");
    }
    if (sceneDropped.length) {
      warnings.push(
        "3D 场景页上限 " +
          SCENE_MAX +
          " 页（" +
          styleLabel +
          "档预算；每个 ThreeCanvas 一个 WebGL context），这几页降级成纯文字：" +
          sceneDropped.join("、"),
      );
    }
    if (sceneCount) {
      warnings.push("3D 场景 " + sceneCount + " 页：three.js 经 @remotion/three 渲染（依赖白名单已放行 three / @remotion/three / @react-three/fiber）");
    }
    if (pages.some((pg) => pg.formula)) {
      warnings.push(
        "公式页 " +
          pages.filter((pg) => pg.formula).length +
          " 页：式子在生成期已排成文字（真上标 / √ / a/b / 「的 … 次方」），视频里不做 TeX 解析 —— 上屏的每一个字都能直接看懂",
      );
    }
    /* 硬闸：翻不动的 TeX（矩阵 / align 环境、不认识的宏）绝不带上屏 —— 宁可这一版不出片，也不出印着源码的片子 */
    const texBad = texOnScreenOf(pages, RS);
    if (texBad.length) {
      return {
        ok: false,
        error:
          "上屏文字里还有 LaTeX 源码（视频拒绝出片）：" +
          texBad
            .slice(0, 6)
            .map((t) => "「" + t.page + "」" + t.field + " " + t.leftover.join(" ") + " ← " + t.text)
            .join("；") +
          "。改法：把式子写成排好的样子（真上标 / √ / a/b /「的 … 次方」），或改写成人话。",
        files: null,
        audit: { errors: ["latex_on_screen"], warnings: warnings },
        warnings: warnings,
        meta: meta,
      };
    }

    const result = {
      ok: true,
      ver: VER,
      entry: ENTRY,
      files: files,
      contract: CONTRACT,
      meta: meta,
      timeline: {
        fps: fps,
        width: dims.width,
        height: dims.height,
        durationInFrames: totalFrames,
        durationSec: totalSec,
        pages: pages,
        chapters: chapters,
        segments: segments,
      },
      captions: captions,
      narration: narration,
      colors: colors,
      buildKey: buildKey,
      theme: tokens.theme,
      brief: brief,
      warnings: warnings,
      error: "",
    };
    result.audit = audit(result.files, colors);
    return result;
  }

  /* ── 静态自检：与 renderer/app-nodes.js 的 remotionStaticCheck 同一口径 ─────
     只做「生成器自己这一侧」的断言（宿主拿到 files 之后仍会再跑一遍那道关）：
       ① 入口存在且导出 Main；② 依赖只允许 react / remotion + 工程内相对文件；
       ③ 相对 import 必须落在文件树里；④ 工程里出现的每个 #hex 都来自 styleTokens；
       ⑤ 括号平衡（粗检，只作为「模板写坏了」的早期信号）。 */
  function importSpecsOf(src) {
    const specs = [];
    const push = (s) => {
      if (s && specs.indexOf(s) < 0) specs.push(s);
    };
    let m;
    const reStatic = /(?:^|[\s;{}])import\s[^'"`]*?['"]([^'"]+)['"]/g;
    const text = String(src || "");
    while ((m = reStatic.exec(text))) push(m[1]);
    const reCall = /(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = reCall.exec(text))) push(m[1]);
    return specs;
  }
  /* 依赖白名单：react / remotion 家族，外加 three 这一簇（3D 场景页用）。
     与 remotion/main-remotion.js 的 CUSTOM_IMPORT_ALLOWED、renderer/app-nodes.js 的
     remotionStaticCheck 保持同一份口径 —— 三处任一改成别的簇，另两处必须同步。 */
  const IMPORT_ALLOWED = /^(?:react|react-dom|remotion|three|@remotion\/three|@react-three\/fiber)(?:\/|$)/;

  function relativeExists(spec, fromName, tree) {
    const parts = str(fromName).split("/").slice(0, -1);
    for (const seg of str(spec).split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") {
        if (!parts.length) return false;
        parts.pop();
        continue;
      }
      parts.push(seg);
    }
    const joined = parts.join("/");
    if (!joined) return false;
    if (Object.prototype.hasOwnProperty.call(tree, joined)) return true;
    for (const ext of [".tsx", ".ts", ".jsx", ".js", ".css", ".json"]) {
      if (Object.prototype.hasOwnProperty.call(tree, joined + ext)) return true;
    }
    return Object.prototype.hasOwnProperty.call(tree, joined + "/index.tsx");
  }

  /* 括号平衡（跳过字符串与注释）：只当早期信号，不当语法校验 */
  function balanceOf(src) {
    const text = String(src || "");
    const pairs = { "{": "}", "(": ")", "[": "]" };
    const stack = [];
    let quote = null;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quote) {
        if (c === "\\") {
          i++;
          continue;
        }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        quote = c;
        continue;
      }
      if (c === "/" && text[i + 1] === "/") {
        const nl = text.indexOf("\n", i);
        i = nl < 0 ? text.length : nl;
        continue;
      }
      if (c === "/" && text[i + 1] === "*") {
        const end = text.indexOf("*/", i + 2);
        i = end < 0 ? text.length : end + 1;
        continue;
      }
      if (pairs[c]) stack.push(pairs[c]);
      else if (c === "}" || c === ")" || c === "]") {
        if (stack.pop() !== c) return false;
      }
    }
    return stack.length === 0 && !quote;
  }

  function audit(files, colors) {
    const errors = [];
    const warnings = [];
    const tree = files && typeof files === "object" ? files : {};
    const names = Object.keys(tree).filter((k) => str(tree[k]).trim());
    if (!names.length) errors.push("工程是空的（没有源码）");
    if (names.indexOf(ENTRY) < 0) errors.push("入口文件缺失：" + ENTRY);
    const entrySrc = str(tree[ENTRY]);
    if (names.indexOf(ENTRY) >= 0 && !/export\s+(?:const|let|var|function|class)\s+Main\b/.test(entrySrc)) {
      errors.push("入口没有导出 Main 组件（export const Main = ...）");
    }
    if (entrySrc && !/export\s+(?:const|let|var)\s+inputs\b/.test(entrySrc)) {
      errors.push("入口没有导出 inputs 契约");
    }
    /* 字幕：CAPTIONS 是「有就铺」的数据（时间轴按 notes 排，与有没有旁白音轨无关），
       所以在 Main 里它参与渲染、不算未使用变量；反过来，若入口又把字幕绑回音轨
       （src && CAPTIONS.length），那就是「没录音就不铺字幕」的旧口径，直接判错。 */
    const dataFileSrc = str(tree["data.ts"]);
    const hasCaptionData = /export\s+const\s+CAPTIONS\b[^=]*=\s*\[\s*\{/.test(dataFileSrc);
    if (entrySrc && /src\s*&&\s*CAPTIONS\.length/.test(entrySrc)) {
      errors.push("入口把字幕绑回了旁白音轨（src && CAPTIONS.length）：无音轨就不铺字幕，应只判 CAPTIONS.length");
    }
    if (hasCaptionData && entrySrc && entrySrc.indexOf("CAPTIONS") < 0) {
      warnings.push("data.ts 里有字幕数据，但入口没用到 CAPTIONS（这一版不会铺字幕）");
    }
    for (const name of names) {
      const src = str(tree[name]);
      const bad = [];
      for (const spec of importSpecsOf(src)) {
        if (spec.charAt(0) === ".") {
          if (!relativeExists(spec, name, tree)) bad.push(spec);
          continue;
        }
        if (!IMPORT_ALLOWED.test(spec)) bad.push(spec);
      }
      if (bad.length) errors.push(name + " 里有不允许的 import：" + bad.join(", ") + "（只允许 react / remotion / three 与工程内相对文件）");
      if (!balanceOf(src)) errors.push(name + " 的括号不平衡（模板写坏了）");
    }
    /* 颜色：工程里每个 #hex 都必须来自 styleTokens（rgba 遮罩不受这条管） */
    const allowed = new Set((Array.isArray(colors) ? colors : []).map((c) => str(c).toLowerCase()));
    const hexes = [];
    const offenders = [];
    for (const name of names) {
      const found = str(tree[name]).match(/#[0-9a-fA-F]{3,8}\b/g) || [];
      for (const h of found) {
        if (hexes.indexOf(h) < 0) hexes.push(h);
        if (!allowed.has(h.toLowerCase())) offenders.push(name + ":" + h);
      }
    }
    if (offenders.length) errors.push("工程里出现了不来自 styleTokens 的颜色：" + offenders.join(", "));
    if (!allowed.size) warnings.push("这份主题没有解析出颜色（styleTokens 为空？）");
    return { ok: errors.length === 0, errors: errors, warnings: warnings, files: names.length, hexes: hexes, colors: allowed.size };
  }

  return {
    VER: VER,
    ENTRY: ENTRY,
    RES: RES,
    CONTRACT: CONTRACT,
    MAX_CHAPTERS: MAX_CHAPTERS,
    CAPTION_WINDOW_MS: CAPTION_WINDOW_MS,
    build: build,
    buildProject: build,
    compile: build,
    audit: audit,
    resolutionOf: resolutionOf,
    /* 纯函数小工具（宿主 / 自检两边都可复核，不另抄一份） */
    chapterKeyOf: chapterKeyOf,
    sentencesOf: sentencesOf,
    tokenize: tokenize,
    /* 镜头：宿主 / 编辑器 / 自检三处都能复核「这一页切了几镜、哪一帧在哪一镜」 */
    planShots: planShots,
    shotAt: shotAt,
    SHOT_MAX: SHOT_MAX,
    /* 展示风格怎么演（镜头 / 运镜 / 字号 / 装饰 / 字幕节奏 / 3D 预算）：只此一份，宿主不再另编一套 */
    STYLE_PLAY: STYLE_PLAY,
    stylePlayOf: stylePlayOf,
    spotTargetsOf: spotTargetsOf,
  };
});


