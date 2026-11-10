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
 *   §5.5 旁白可选：notes 逐句 → 时间轴；工程里留一个可空的 audio 端子，空 = 不铺旁白也不铺字幕。
 *
 * 两条「纯函数拿不到」的事，如实写在返回值里而不是假装做到：
 *   · 旁白音频**时长**：本模块不读盘，量不到 TTS 有多长 —— 时间轴按 notes 文字排（narration 给出逐句 ms 窗口），
 *     宿主拿着这些窗口去裁 / 生成音频；音频比窗口长就由宿主决定加长页（这里只保证文字与帧对得上）。
 *   · 公式页：工程只允许 react / remotion，引不进 KaTeX → 按 TeX 源码显示（warnings 里明说，且建议走静态版 PDF）。
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
 *   motion.ts         运动量常量（缓动 / 入场 / 转场帧数 / 字速 / 节拍 / 背景）+ 三个版式钩子
 *   types.ts          类型
 *   Backdrop.tsx      背景（none / grain / grid / vignette，只用 rgba 遮罩）
 *   PageBody.tsx      单页版式（封面 / 大纲 / 正文 / 术语 / 公式 / 文献 / 结语，未知 kind 退化成正文）
 *   PageFrame.tsx     页级转场（fade / push，尾巴里交叠）
 *   Bullets.tsx       要点逐条入场（距上一页尾留 0.6s）
 *   ChapterCard.tsx   章节过场卡（序号 + 段标题）
 *   Captions.tsx      逐词字幕（只在接了旁白音轨时铺）
 *
 * 产出（build 的返回）：
 *   { ok, files, entry, contract, meta, timeline, captions, narration, colors, buildKey, audit, warnings, error }
 *   meta      → 宿主交 remotion 宿主的时长 / 分辨率（calculateMetadata 同值）
 *   timeline  → 页序列与帧落点（可对账：页 id 序列 === 可见页 id 序列）
 *   captions  → remotion-audio-captions 的逐词格式 {text, startMs, endMs, timestampMs, confidence}
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else if (root) root.MTResearchSlidesVideo = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const VER = 1;
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
  function tokenize(text) {
    const s = str(text);
    const out = [];
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (/\s/.test(c)) {
        i++;
        continue;
      }
      if (/[A-Za-z0-9]/.test(c)) {
        let j = i;
        while (j < s.length && /[A-Za-z0-9'’._-]/.test(s[j])) j++;
        out.push(s.slice(i, j));
        i = j;
        continue;
      }
      out.push(c);
      i++;
    }
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

  /* ── 镜头（shot）规划：一页拆成 1–4 个镜头 ─────────────────────────────────
     为什么要镜头而不是「一页一个画面」：成片感来自**镜头内的运动**与**镜头之间的切**，
     不是页与页之间的淡入淡出。每页：
       · establish  建立镜头：整页入画（推 / 拉 / 摇），承载标题与第一眼信息；
       · focus      细节镜头：一条要点一个，画面轻摇 + 该条高亮（其余压暗）；
     规则（确定性，同输入同输出）：镜头帧数首尾必须对齐页时长；页太短（< 1.2s 量级）只留一个镜头；
     封面 / 章节 / 结语只给一个运镜（不切碎）。move 在相邻镜头上尽量不同向，避免「整片往一个方向飘」。 */
  const SHOT_MAX = 4;
  const SHOT_MIN_FRAMES = 14;
  const MOVES = ["pushIn", "pullOut", "panLeft", "panRight", "dolly", "tiltUp"];
  function shotMoveOf(index, kind) {
    if (kind === "cover") return "dolly";
    if (kind === "end") return "pullOut";
    if (index === 0) return "pullOut";
    return MOVES[index % MOVES.length];
  }
  function planShots(pg, motion, displayFrames, fps) {
    const total = Math.max(1, roundInt(displayFrames));
    const kind = str(pg && pg.kind);
    const bullets = Array.isArray(pg && pg.bullets) ? pg.bullets.length : 0;
    const single = ["cover", "end", "toc", "chapter"].indexOf(kind) >= 0;
    const focusCount = single ? 0 : Math.min(SHOT_MAX - 1, Math.max(0, Math.min(3, bullets)));
    if (total < SHOT_MIN_FRAMES * 4 || !focusCount) {
      return [{ kind: "establish", from: 0, frames: total, move: shotMoveOf(0, kind), focus: -1, depth: single ? 5 : 3 }];
    }
    const est = Math.max(SHOT_MIN_FRAMES, Math.round(total * 0.38));
    const rest = Math.max(SHOT_MIN_FRAMES, total - est);
    const per = Math.max(SHOT_MIN_FRAMES, Math.floor(rest / focusCount));
    const shots = [{ kind: "establish", from: 0, frames: est, move: shotMoveOf(0, kind), focus: -1, depth: 4 }];
    let from = est;
    for (let i = 0; i < focusCount; i++) {
      const last = i === focusCount - 1;
      const frames = last ? Math.max(SHOT_MIN_FRAMES, total - from) : Math.min(per, Math.max(SHOT_MIN_FRAMES, total - from));
      shots.push({ kind: "focus", from: from, frames: frames, move: shotMoveOf(i + 1, kind), focus: i, depth: 2 });
      from += frames;
      if (from >= total) break;
    }
    /* 收尾对齐：最后一镜吃掉余下的帧（不多不少，页时长不变） */
    const tail = shots[shots.length - 1];
    tail.frames = Math.max(1, total - tail.from);
    return shots;
  }
  /* 页内某帧属于哪个镜头（Camera 与 PageBody 共用同一份判断，画面与高亮不会错位） */
  function shotAt(pg, frame) {
    const list = Array.isArray(pg && pg.shots) && pg.shots.length ? pg.shots : null;
    if (!list) return { kind: "establish", from: 0, frames: Number(pg && pg.frames) || 1, move: "pushIn", focus: -1, depth: 3 };
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
      "  shots: Shot[];",
      "}",
      "",
      "/* 一个镜头：页内的一段连续画面（from 相对页起点；move 是相机运动，focus = 高亮的要点下标，-1 = 无） */",
      "export interface Shot {",
      "  kind: \"establish\" | \"focus\";",
      "  from: number;",
      "  frames: number;",
      "  move: string;",
      "  focus: number;",
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

  /* motion.ts：运动量常量 + 三个版式钩子（缩放 / 入场 / 转场）
     transition 单独传：它是 deck.theme 的字段（只有 fade / push 两档），不在 motion 表里 ——
     转场只换手感（transitionFrames），不新增枚举，静态版与视频版才不会分叉。 */
  function motionSrc(motion, transition, dims, totalFrames) {
    const ease =
      motion.ease === "inOut"
        ? "Easing.inOut(Easing.cubic)"
        : motion.ease === "outBack"
          ? "Easing.out(Easing.back(1.6))"
          : "Easing.out(Easing.cubic)";
    return [
      "/* 运动量：逐字来自内核 motion 表（缓动 / 入场 / 转场帧数 / 字速 / 节拍 / 背景）。",
      "   切主题换的就是这里的数字 —— 工程要重新生成（宿主按 buildKey 判失效）。 */",
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
      "  if (TRANSITION === \"push\" && !isLast) {",
      "    const x = (1 - p) * 56 * k - q * 56 * k;",
      "    return { opacity: opacity, transform: \"translateX(\" + Math.round(x) + \"px)\" };",
      "  }",
      "  return { opacity: opacity };",
      "};",
      "",
      "/* 镜头运镜：move × 镜头内进度 → CSS 变换（画面按中心缩放，位移按 k 缩）。",
      "   pushIn / pullOut / dolly 只动 scale，pan / tilt 只动位移 —— 一镜只做一件事，叠加就是晃。 */",
      "export const cameraStyle = (move: string, progress: number, k: number): CSSProperties => {",
      "  const p = Math.max(0, Math.min(1, progress));",
      "  const e = Easing.inOut(Easing.cubic)(p);",
      "  const drift = 42 * k;",
      "  const panX = move === \"panLeft\" ? drift * (0.5 - e) : move === \"panRight\" ? -drift * (0.5 - e) : 0;",
      "  const panY = move === \"tiltUp\" ? drift * (0.5 - e) : 0;",
      "  const scale =",
      "    move === \"pushIn\" ? 1 + 0.06 * e",
      "      : move === \"pullOut\" ? 1.06 - 0.06 * e",
      "      : move === \"dolly\" ? 1 + 0.12 * e",
      "      : 1.03;",
      "  return {",
      "    transform:",
      "      \"translate3d(\" + Math.round(panX) + \"px,\" + Math.round(panY) + \"px,0) scale(\" + scale.toFixed(4) + \")\",",
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
      "   页 id 序列 === 可见页 id 序列；章节卡只是时间轴上多出来的片段，不写进页模型。 */",
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
      "   光斑只用 T.accent / T.primary 两色，透明度压到 0.1–0.16，绝不抢正文。 */",
      "import React from \"react\";",
      "import { AbsoluteFill, useCurrentFrame } from \"remotion\";",
      "import { BG } from \"./motion\";",
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
      "      <AbsoluteFill style={{ background: glowA, opacity: 0.14 }} />",
      "      <AbsoluteFill style={{ background: glowB, opacity: 0.1 }} />",
      "      {BG === \"grain\" ? (",
      "        <AbsoluteFill",
      "          style={{",
      "            backgroundImage:",
      "              \"repeating-linear-gradient(0deg, rgba(0,0,0,0.035) 0px, rgba(0,0,0,0.035) 1px, rgba(0,0,0,0) 1px, rgba(0,0,0,0) 3px)\",",
      "          }}",
      "        />",
      "      ) : null}",
      "      {BG === \"grid\" ? (",
      "        <AbsoluteFill",
      "          style={{",
      "            backgroundImage:",
      "              \"linear-gradient(rgba(0,0,0,0.05) 1px, rgba(0,0,0,0) 1px), linear-gradient(90deg, rgba(0,0,0,0.05) 1px, rgba(0,0,0,0) 1px)\",",
      "            backgroundSize: \"64px 64px\",",
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
      "   focus = 当前镜头聚焦的那一条（正文页的细节镜头会用）：那一条起、其余压暗。 */",
      "import React from \"react\";",
      "import { interpolate, useCurrentFrame } from \"remotion\";",
      "import { EASE, ENTER_FRAMES, enterStyle, useScale } from \"./motion\";",
      "import { T } from \"./theme\";",
      "import type { Bullet } from \"./types\";",
      "",
      "export const Bullets: React.FC<{ bullets: Bullet[]; size: number; numbered?: boolean; focus?: number }> = ({",
      "  bullets,",
      "  size,",
      "  numbered,",
      "  focus,",
      "}) => {",
      "  const frame = useCurrentFrame();",
      "  const k = useScale();",
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
      "        return (",
      "          <div",
      "            key={i}",
      "            style={{",
      "              display: \"flex\",",
      "              flexDirection: \"row\",",
      "              alignItems: \"flex-start\",",
      "              ...enter,",
      "              opacity: (enter.opacity == null ? 1 : Number(enter.opacity)) * dim,",
      "              transform:",
      "                (enter.transform ? enter.transform + \" \" : \"\") + \"translateX(\" + (active ? Math.round(8 * k) : 0) + \"px)\",",
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
      "            <span style={{ flex: \"1 1 auto\", color: T.ink, fontSize: size, lineHeight: 1.42 }}>{b.text}</span>",
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
      "   有 scene 的页走两栏：左边讲字，右边真 3D（Scene3D，three.js）；没有就整页文字。 */",
      "import React from \"react\";",
      "import { AbsoluteFill, interpolate, useCurrentFrame } from \"remotion\";",
      "import { Bullets } from \"./Bullets\";",
      "import { Scene3D } from \"./Scene3D\";",
      "import { EASE, ENTER_FRAMES, enterStyle, useScale } from \"./motion\";",
      "import { T } from \"./theme\";",
      "import type { SlidePage } from \"./types\";",
      "",
      "export const PageBody: React.FC<{ page: SlidePage; focus?: number }> = ({ page, focus }) => {",
      "  const k = useScale();",
      "  const frame = useCurrentFrame();",
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
      "  const pad = Math.round((isCover || isEnd ? 120 : 96) * k);",
      "  const titleSize = Math.round((isCover ? 104 : isEnd ? 88 : isFormula ? 40 : withScene ? 56 : 72) * k);",
      "  const metaSize = Math.round(26 * k);",
      "  const listSize = Math.round((withScene ? 32 : page.kind === \"toc\" || isEnd ? 34 : 42) * k);",
      "  const textCol = (",
      "    <div",
      "      style={{",
      "        flex: withScene ? \"0 0 46%\" : \"1 1 auto\",",
      "        minWidth: 0,",
      "        display: \"flex\",",
      "        flexDirection: \"column\",",
      "        alignItems: isFormula ? \"center\" : undefined,",
      "        textAlign: isFormula ? \"center\" : undefined,",
      "        justifyContent: isCover || isEnd || isFormula ? \"center\" : \"flex-start\",",
      "        paddingRight: withScene ? Math.round(28 * k) : 0,",
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
      "            color: T.primary,",
      "            background: T.paper2,",
      "            borderLeft: Math.round(6 * k) + \"px solid \" + T.accent,",
      "            borderRadius: T.radius,",
      "            boxShadow: T.shadow,",
      "            fontSize: Math.round((isFormula ? 64 : 44) * k),",
      "            lineHeight: 1.42,",
      "            alignSelf: isFormula ? \"center\" : undefined,",
      "            maxWidth: isFormula ? \"86%\" : undefined,",
      "            overflowWrap: \"anywhere\",",
      "            marginBottom: Math.round((isFormula ? 22 : 28) * k),",
      "            padding: Math.round((isFormula ? 36 : 24) * k) + \"px \" + Math.round((isFormula ? 46 : 32) * k) + \"px\",",
      "          }}",
      "        >",
      "          {page.formula}",
      "        </div>",
      "      ) : null}",
      "      {page.formula && isFormula ? (",
      "        <div style={{ color: T.muted, fontSize: Math.round(22 * k), letterSpacing: Math.round(1.5 * k) + \"px\" }}>",
      "          {\"TeX 源码 · 视频版按源码显示（排版好的式子请走静态版 PDF）\"}",
      "        </div>",
      "      ) : null}",
      "      {page.quote ? (",
      "        <div",
      "          style={{",
      "            color: T.muted,",
      "            borderLeft: Math.round(5 * k) + \"px solid \" + T.rule,",
      "            fontSize: Math.round(30 * k),",
      "            lineHeight: 1.5,",
      "            marginBottom: Math.round(26 * k),",
      "            paddingLeft: Math.round(22 * k),",
      "          }}",
      "        >",
      "          {page.quote}",
      "        </div>",
      "      ) : null}",
      "      {page.bullets.length ? (",
      "        <Bullets bullets={page.bullets} size={listSize} numbered={page.kind === \"toc\"} focus={focus} />",
      "      ) : null}",
      "    </div>",
      "  );",
      "  return (",
      "    <AbsoluteFill",
      "      style={{",
      "        padding: pad,",
      "        display: \"flex\",",
      "        flexDirection: \"row\",",
      "        alignItems: \"stretch\",",
      "        backgroundColor: \"transparent\",",
      "        color: T.ink,",
      "        fontFamily: T.font,",
      "      }}",
      "    >",
      "      {textCol}",
      "      {withScene ? (",
      "        <div style={{ position: \"relative\", flex: \"1 1 auto\", minWidth: 0 }}>",
      "          <Scene3D scene={page.scene} />",
      "        </div>",
      "      ) : null}",
      "      <div",
      "        style={{",
      "          position: \"absolute\",",
      "          left: pad,",
      "          right: pad,",
      "          bottom: Math.round(46 * k),",
      "          display: \"flex\",",
      "          justifyContent: \"space-between\",",
      "          color: T.muted,",
      "          fontSize: Math.round(22 * k),",
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
      "import type { SlidePage } from \"./types\";",
      "",
      "export const PageFrame: React.FC<{ page: SlidePage }> = ({ page }) => {",
      "  const style = useTransitionStyle(page.frames, page.index === page.total);",
      "  return (",
      "    <AbsoluteFill style={style}>",
      "      <Backdrop depth={4} />",
      "      <Camera page={page} />",
      "    </AbsoluteFill>",
      "  );",
      "};",
      "",
    ].join("\n");
  }

  function cameraSrc() {
    return [
      "/* 镜头：按页内时间挑当前镜头（establish / focus），算出运镜与聚焦要点，交给 PageBody。",
      "   同一份 shots 既决定画面怎么动，也决定哪条要点被点亮 —— 两者不会错位。 */",
      "import React from \"react\";",
      "import { AbsoluteFill, useCurrentFrame } from \"remotion\";",
      "import { PageBody } from \"./PageBody\";",
      "import { cameraStyle, useScale } from \"./motion\";",
      "import type { Shot, SlidePage } from \"./types\";",
      "",
      "const FALLBACK: Shot = { kind: \"establish\", from: 0, frames: 1, move: \"pushIn\", focus: -1, depth: 3 };",
      "",
      "export const Camera: React.FC<{ page: SlidePage }> = ({ page }) => {",
      "  const frame = useCurrentFrame();",
      "  const k = useScale();",
      "  const list = page.shots && page.shots.length ? page.shots : [FALLBACK];",
      "  let cur = list[0];",
      "  for (const s of list) if (frame >= s.from) cur = s;",
      "  const span = Math.max(1, cur.frames - 1);",
      "  const p = Math.max(0, Math.min(1, (frame - cur.from) / span));",
      "  return (",
      "    <AbsoluteFill style={{ overflow: \"hidden\", ...cameraStyle(cur.move, p, k) }}>",
      "      <PageBody page={page} focus={cur.focus} />",
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
      "/* 逐词字幕：只在接了旁白音轨时才铺（无旁白不铺 —— 要点已经在画面上）",
      "   一屏取「当前句起的 1.6s 内」的词，说到哪个词就亮哪个（数据是 ms 级真值） */",
      "import React from \"react\";",
      "import { AbsoluteFill, useCurrentFrame, useVideoConfig } from \"remotion\";",
      "import { useScale } from \"./motion\";",
      "import { T } from \"./theme\";",
      "import type { Caption } from \"./types\";",
      "",
      "const WINDOW_MS = " + CAPTION_WINDOW_MS + ";",
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
      "  const startMs = captions[cur].startMs;",
      "  const shown: Caption[] = [];",
      "  for (let i = cur; i < captions.length; i++) {",
      "    if (captions[i].startMs - startMs > WINDOW_MS) break;",
      "    shown.push(captions[i]);",
      "  }",
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
      "          fontSize: Math.round(34 * k),",
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
      "   端子：唯一可选的是旁白音轨（空 = 无旁白、也不铺字幕）。 */",
      "import React from \"react\";",
      "import { AbsoluteFill, Audio, Sequence, staticFile } from \"remotion\";",
      "import { CHAPTERS, CAPTIONS, PAGES, SEGMENTS } from \"./data\";",
      "import { Backdrop } from \"./Backdrop\";",
      "import { Captions } from \"./Captions\";",
      "import { ChapterCard } from \"./ChapterCard\";",
      "import { PageFrame } from \"./PageFrame\";",
      "import { DURATION_IN_FRAMES, FPS, HEIGHT, WIDTH } from \"./motion\";",
      "import { T } from \"./theme\";",
      "import type { ChapterSeg, SlidePage } from \"./types\";",
      "",
      "/* 端子契约：旁白音轨（可空）—— 有它就铺 <Audio> 与逐词字幕，没有就纯画面 */",
      "export const inputs = " + JSON.stringify(contract) + ";",
      "",
      "export type MainProps = { narration?: string };",
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
      "              <PageFrame page={pg} />",
      "            ) : null}",
      "          </Sequence>",
      "        );",
      "      })}",
      "      {src ? <Audio src={src} /> : null}",
      "      {src && CAPTIONS.length ? <Captions captions={CAPTIONS} /> : null}",
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
    const transition = RS.TRANSITIONS.indexOf(str(tokens.transition)) >= 0 ? str(tokens.transition) : "fade";
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
    /* 3D 场景页上限：每个 ThreeCanvas 一个 WebGL context（Chromium 上限约 16），
       超出的页降级成纯文字页，并在 warnings 里点名（不静默丢场景）。 */
    const SCENE_MAX = 6;
    let sceneCount = 0;
    const sceneDropped = [];
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
        /* 镜头必须铺满 it.frames（含尾部交叠），否则最后一镜会提前收尾 */
        shots: planShots(
          Object.assign({}, pg, { scene: scene, bullets: bullets.map((b) => b.text) }),
          motion,
          it.frames,
          fps,
        ),
      });
      segments.push({ id: str(pg.id), kind: "page", from: it.from, frames: it.frames });
    }

    /* ⑤ 旁白：notes 逐句 → 页内时间窗 → 逐词字幕（无 notes = 空数组，不铺字幕） */
    const captions = [];
    const narration = [];
    for (const pg of pages) {
      const sentences = sentencesOf(pg.note);
      if (!sentences.length) continue;
      const startMs = Math.round((pg.from / fps) * 1000) + 400;
      const endMs = Math.round(((pg.from + roundInt(pg.sec * fps)) / fps) * 1000) - 300;
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
      "motion.ts": motionSrc(motion, transition, dims, totalFrames),
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

    /* buildKey = hash(页 id 序列 + 每页 title/bullets/quote + theme + brief + aspect + fps)：
       改任意一样就变 → 编辑器据此把「已生成」置灰（spec §6 补充口径），放不出旧片。 */
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
          pg.bullets.map((b) => b.text),
          pg.shots.map((s) => [s.kind, s.from, s.frames, s.move, s.focus]),
        ]),
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
      briefMode: brief.mode,
      pace: pace,
      transition: transition,
      ease: str(motion.ease),
      enter: str(motion.enter),
      bg: str(motion.bg),
      planNote: str(plan.note),
      audioTerminal: CONTRACT[0].key,
      buildKey: buildKey,
    };

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
    if (withMedia.length) warnings.push("视频版 v1 不铺叠加媒体 / 自由版面对象（" + withMedia.length + " 页）：先出字与式，图另行替换");
    if (sceneDropped.length) {
      warnings.push(
        "3D 场景页上限 " + SCENE_MAX + " 页（每个 ThreeCanvas 一个 WebGL context），这几页降级成纯文字：" + sceneDropped.join("、"),
      );
    }
    if (sceneCount) {
      warnings.push("3D 场景 " + sceneCount + " 页：three.js 经 @remotion/three 渲染（依赖白名单已放行 three / @remotion/three / @react-three/fiber）");
    }
    if (pages.some((pg) => pg.formula)) {
      warnings.push("公式页在视频里按 TeX 源码显示（工程只允许 react / remotion / three，引不进 KaTeX）：需要排版好的式子请走静态版 PDF");
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
  };
});
