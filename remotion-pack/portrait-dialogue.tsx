/* portrait-dialogue.tsx — 内置「角色动态 + 台词卡」合成（随 remotion-pack 发版）
 *
 * 用法（不是给用户手改的文件，而是主进程的兜底模板）：
 *   · 节点侧在描述里写了 {{hero}} / {{narration}} / {{voice}} / {{bg}} 占位、
 *     或主进程识别出「左角色 + 右侧金边台词卡」这类描述时，main-remotion.js 选中它；
 *   · render.json 的 inputProps 里带 hero / narration / voice / bg / accent / lineStarts，
 *     模板按 props 取值：hero = 循环视频（本机路径 / data URL / http），
 *     narration = 台词正文（换行分句），voice = 语音（本机路径 / data URL），bg = 左侧底色。
 *   · 全部样式内联、只 import react / remotion：与安装目录只装这两者的前提一致。
 *
 * 2026-10 改版「全屏叠加 + 卡框内叠字」：
 *   ① 背景铺满全屏（poster 图，object-fit: cover），hero 视频作为叠加层叠在整屏上，
 *      不再把画面切成 52% / 48% 两栏（旧版式会把左侧素材裁掉一部分）；
 *   ② 台词卡按 cardRect（0–1 相对整屏）定位到「底图上画好的金框」内沿：
 *      cardRect 可以由节点按底图自动量出（见画布的「卡框定位」节点，输出一行
 *      CARD_RECT {"l":…,"t":…,"r":…,"b":…} 参与片描述），也可以手写；
 *   ③ hero 循环段按 heroSpeed 变速闭合铺满：播放速度略小于 1 时，段尾恰好落在原片首帧上，
 *      于是「循环接缝」在物理上就是连续的（不会从偏晚的画面跳回开头）。
 *   以上全是可选能力：一个都不给时行为与老版本一致（两栏 + 右侧金边卡）。
 */
import React, {useMemo} from "react";
import {
  AbsoluteFill,
  Audio,
  Html5Video,
  OffthreadVideo,
  Img,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

type CardRect = {l: number; t: number; r: number; b: number};

type Props = {
  hero?: string;
  narration?: string;
  voice?: string;
  bg?: string;
  accent?: string;
  linesPerPage?: number;
  /** 每句台词的「起帧」：给了就按它对齐打字节拍（来自 audioDurations 的朗读时长），否则整片均分 */
  lineStarts?: number[];
  /** 全屏背景图（给了就走「背景铺满 + hero 叠加 + 卡框内叠字」的新版式） */
  poster?: string;
  /** 台词卡内沿（相对整屏 0–1）：按背景图里画好的卡框定位 */
  cardRect?: CardRect;
  /** hero 视频的播放速度（循环段长度与成片长度不整除时用；略小于 1 = 段尾精确落回首帧） */
  heroSpeed?: number;
  /** hero 源片的循环帧数（如 H3 片 = 124 帧 / 5.17s）。给了就**按帧驱动**时间轴：
   *  每帧显式把 video.currentTime 设到源片对应帧，整段从首帧走到末帧再回开头，
   *  接缝在物理上不跳帧、不漂移；不给则退回老做法（loop + playbackRate）。 */
  heroLoopFrames?: number;
  /** hero 源片帧率（与 heroLoopFrames 配套，默认 24） */
  heroSrcFps?: number;
};

const clamp = {extrapolateLeft: "clamp", extrapolateRight: "clamp"} as const;
const CJK_FONT =
  '"Noto Sans CJK SC", "Microsoft YaHei", "PingFang SC", "Source Han Sans SC", sans-serif';

/** 是否视频 / 图片素材（按扩展名与 data URL 头判定） */
const isVideoSrc = (s: string) =>
  /^data:video\//i.test(s) || /\.(mp4|webm|mov|m4v)(\?.*)?$/i.test(s);
const isImageSrc = (s: string) =>
  /^data:image\//i.test(s) || /\.(png|jpe?g|webp|gif|avif)(\?.*)?$/i.test(s);

/** cardRect 归一：四个数都在 0–1 且 l<r、t<b 才认，否则返回 null（退回老版式） */
function normalizeCardRect(input: unknown): CardRect | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const l = Number(o.l);
  const t = Number(o.t);
  const r = Number(o.r);
  const b = Number(o.b);
  if (![l, t, r, b].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) return null;
  if (r - l < 0.1 || b - t < 0.1) return null;
  return {l, t, r, b};
}

/**
 * 从文本里抠出卡框参数：节点按底图量出的一行 `CARD_RECT {"l":…,"t":…,"r":…,"b":…}`。
 * 这条文本会随「片描述」一起进 props.texts，模板从里面把最新一条读出来 ——
 * 于是卡框位置可以完全由画布自动测量，不必写死在模板里。
 */
function parseCardRectFromTexts(texts: unknown): CardRect | null {
  const list = Array.isArray(texts) ? texts.map((t) => String(t || "")) : [];
  for (const t of list) {
    const m = t.match(/CARD_RECT\s*(\{[^}]*\})/i);
    if (!m) continue;
    try {
      const rect = normalizeCardRect(JSON.parse(m[1]));
      if (rect) return rect;
    } catch {
      /* 不是合法 JSON 就跳过，继续找下一条 */
    }
  }
  return null;
}

/** 台词 → 句子：先按换行，再按中文句末标点，长句按逗号兜底切短。
 *  带 {{...}} 占位的行是「描述口径的写法」（hero / narration / voice …），
 *  绝不能当台词念出来 —— 整行跳过。 */
function splitLines(text: string): string[] {
  const raw = String(text || "").replace(/\r/g, "");
  const out: string[] = [];
  for (const para of raw.split("\n")) {
    const p = para.trim();
    if (!p) continue;
    if (/\{\{[^}]*\}\}/.test(p)) continue;
    const parts = p.split(/(?<=[。！？!?；;…])/);
    for (const s of parts) {
      const t = s.trim();
      if (!t) continue;
      if (t.length <= 16) {
        out.push(t);
        continue;
      }
      /* 长句：按逗号切成不超过 16 字的小段 */
      let buf = "";
      for (const piece of t.split(/(?<=[，,、])/)) {
        if ((buf + piece).length > 16 && buf) {
          out.push(buf);
          buf = piece;
        } else {
          buf += piece;
        }
      }
      if (buf) out.push(buf);
    }
  }
  return out.length ? out : [""];
}

function chunk<T>(arr: T[], n: number): T[][] {
  const pages: T[][] = [];
  for (let i = 0; i < arr.length; i += n) pages.push(arr.slice(i, i + n));
  return pages.length ? pages : [[]];
}

export const Main: React.FC<Props> = (props) => {
  const frame = useCurrentFrame();
  const {width, height, durationInFrames, fps} = useVideoConfig();
  const hero = String(props.hero || "").trim();
  const voice = String(props.voice || "").trim();
  const bg = String(props.bg || "").trim() || "#0b1730";
  const accent = String(props.accent || "").trim() || "#e8c88a";
  const poster = String(props.poster || "").trim();
  /* 卡框：优先用显式 cardRect；没给就从 texts 里的 CARD_RECT 行读（画布自动测量的那条） */
  const textsProp = (props as Record<string, unknown>).texts;
  const cardRect = useMemo(() => {
    const direct = normalizeCardRect(props.cardRect);
    if (direct) return direct;
    return parseCardRectFromTexts(textsProp);
  }, [props.cardRect, textsProp]);
  /* 有 poster + cardRect = 新版式（全屏背景 + 叠加层 + 卡框内叠字） */
  const overlayMode = !!(poster && isImageSrc(poster) && cardRect);
  const perPage = Math.max(1, Math.min(6, Number(props.linesPerPage) || 3));

  const lines = useMemo(() => splitLines(String(props.narration || "")), [props.narration]);
  const pages = useMemo(() => chunk(lines, perPage), [lines, perPage]);

  /* 每句的起帧（对齐语音朗读时长）。props.lineStarts 的每一头对应**一条原句**
     （来自台词节拍节点 / 语音段时长）；而 lines 可能把长句按标点切成了碎片，
     所以这里按「语句序号 → 该原句所占的碎片比例」把起帧摊到每个碎片上。
     缺失 / 不严格递增时回退「整片均分」。 */
  const beats = useMemo(() => {
    const raw = Array.isArray(props.lineStarts) ? props.lineStarts.map((x) => Number(x) || 0) : [];
    let ok = raw.length > 0;
    if (ok) {
      for (let i = 1; i < raw.length; i++) if (!(raw[i] > raw[i - 1])) ok = false;
    }
    return ok ? raw : [];
  }, [props.lineStarts]);

  const starts = useMemo(() => {
    if (!beats.length) {
      return lines.map((_, i) => (durationInFrames * i) / Math.max(1, lines.length));
    }
    const n = beats.length;
    /* 原句 i 覆盖 [beats[i], beats[i+1])；边界的碎片归后一句（与「先说标点、再起新句」一致） */
    const owner = (i: number) => Math.min(n - 1, Math.floor((i * n) / Math.max(1, lines.length)));
    const out: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      const k = owner(i);
      const k0 = owner(i - 1 >= 0 ? i - 1 : 0);
      const st = beats[k];
      if (i > 0 && k === k0) {
        /* 同一原句里的后续碎片：在本原句的时长里按字符数顺延 */
        const prev = out[i - 1];
        const segStart = beats[k];
        const segEnd = k + 1 < n ? beats[k + 1] : Math.max(durationInFrames, segStart + 1);
        const frac = lines[i].length / Math.max(1, lines[i].length + lines[i - 1].length);
        out.push(prev + Math.max(1, (segEnd - segStart) * frac));
      } else {
        out.push(st);
      }
    }
    /* 兜底：保证严格递增（插值 / 分页都依赖它） */
    let last = -1;
    for (let i = 0; i < out.length; i++) {
      if (!(out[i] > last)) out[i] = last + 1;
      last = out[i];
    }
    return out;
  }, [beats, lines, durationInFrames]);

  /* 分页：每页覆盖「本页第一句起 → 下一页第一句起」（最后一页到片尾）；
     页内前 78% 吐字、后 22% 停留。没有任何节拍时的兜底与老版本一致（整片均分）。 */
  const manual = beats.length > 0;
  const per = durationInFrames / Math.max(1, pages.length);

  const pageStartFrame = (pi: number) => {
    if (!manual) return pi * per;
    const li = pi * perPage;
    return starts[Math.min(li, starts.length - 1)] || 0;
  };
  const pageEndFrame = (pi: number) =>
    pi >= pages.length - 1 ? durationInFrames : pageStartFrame(pi + 1);

  let pageIndex = 0;
  for (let pi = 0; pi < pages.length; pi++) {
    if (frame >= pageStartFrame(pi)) pageIndex = pi;
  }
  const page = pages[pageIndex] || [];
  const pageStart = pageStartFrame(pageIndex);
  const pageSpan = Math.max(1, pageEndFrame(pageIndex) - pageStart);
  const typedFrames = Math.max(1, pageSpan * 0.78);
  const totalChars = page.reduce((a, s) => a + s.length, 0) || 1;
  const shown = Math.max(
    0,
    Math.min(totalChars, Math.round(((frame - pageStart) / typedFrames) * totalChars)),
  );
  /* 每行已显示的字数 */
  let rest = shown;
  const shownByLine = page.map((s) => {
    const n = Math.max(0, Math.min(s.length, rest));
    rest -= n;
    return n;
  });
  const stillTyping = shown < totalChars;
  const typingLine = shownByLine.findIndex((n, j) => n < page[j].length);

  /* 页与页交叉淡入淡出 */
  const pageFade = interpolate(frame, [pageStart, pageStart + Math.max(1, pageSpan * 0.12)], [0, 1], clamp);
  const cursorOn = stillTyping ? 0.25 + 0.75 * Math.abs(Math.sin(frame * 0.35)) : 0;

  /* ── 版式坐标 ───────────────────────────────────────────────────────────
     新版式（叠加）：卡位直接用 cardRect（相对整屏），hero 叠在全屏背景之上；
     老版式：左 52% 视频 + 右 42% 金边卡（坐标与历史版本一致）。 */
  const cardLeft = overlayMode ? cardRect!.l * width : width * 0.54;
  const cardTop = overlayMode ? cardRect!.t * height : height * 0.14;
  const cardW = overlayMode ? (cardRect!.r - cardRect!.l) * width : width * 0.42;
  const cardH = overlayMode ? (cardRect!.b - cardRect!.t) * height : height * 0.68;
  const heroW = overlayMode ? width : width * 0.52;
  const heroH = overlayMode ? height : height;
  /* 字号：横屏叠加时卡与屏同高，用屏宽 2.4%；卡窄时按卡宽收一档避免溢出 */
  const fontSize = overlayMode
    ? Math.max(18, Math.round(Math.min(width * 0.024, cardW * 0.062)))
    : Math.max(18, Math.round(width * 0.024));
  /* 内边距：老版式 56px 固定；新版式按卡尺寸比例，卡小也不挤 */
  const padX = overlayMode ? Math.max(18, Math.round(cardW * 0.07)) : 56;
  const padTop = overlayMode ? Math.max(20, Math.round(cardH * 0.08)) : 56;
  const padBottom = overlayMode ? Math.max(26, Math.round(cardH * 0.10)) : 72;

  /* ── 循环闭合：略慢于原速播放 ────────────────────────────────────────────
     heroSpeed < 1 时，播放到的「原始时间」增长慢于成片时间，
     于是成片第 n 秒只播到原片的 n×speed 秒：段尾不会越过原片长度，
     一段播完正好落回原片首帧 —— 视觉与物理上都连续，不会「跳回偏早的画面」。 */
  const heroSpeed = overlayMode ? Math.max(0.5, Math.min(2, Number(props.heroSpeed) || 1)) : 1;
  const heroIsVideo = !!hero && isVideoSrc(hero);

  /* ── 循环闭合（确定性按帧取帧）──────────────────────────────────────────
     老做法 loop + playbackRate 让播放头按真实时间走，成片帧与源片帧对不齐，
     接缝处会「跳回偏早的画面」，观感就是随机抖动 / 不像原片那样循环。
     这里改用 OffthreadVideo + trimBefore：整条 hero 只按成片帧号取帧，
     源片时间 = 段内帧号 / 源帧率，段首从第 0 帧起、段尾走到源片末帧，
     段段首末相接 —— 渲染结果是确定的（同一帧号永远同一画面），不依赖播放头。 */
  const loopFrames = Math.max(1, Math.round(Number(props.heroLoopFrames) || 0));
  const heroSrcFps = Math.max(1, Math.round(Number(props.heroSrcFps) || 24));
  const drivenByFrame = !!(overlayMode && heroIsVideo && loopFrames > 1 && heroSrcFps > 0);
  /* 一个循环段在成片里占多少帧：源片 N 帧按速度映射到成片帧率 */
  const segFrames = Math.max(
    1,
    Math.round((loopFrames / heroSrcFps) * fps / (heroSpeed || 1)),
  );
  const frameInSeg = ((frame % segFrames) + segFrames) % segFrames;
  /* 段内线性映射到源片 [0, N-1] 帧，再换算成秒 —— 段尾正好是源片最后一帧 */
  const srcTime = drivenByFrame
    ? (frameInSeg * (loopFrames - 1)) / Math.max(1, segFrames - 1) / heroSrcFps
    : 0;

  const corners: React.CSSProperties[] = [
    {left: 8, top: 8, borderLeftWidth: 1, borderTopWidth: 1},
    {right: 8, top: 8, borderRightWidth: 1, borderTopWidth: 1},
    {left: 8, bottom: 8, borderLeftWidth: 1, borderBottomWidth: 1},
    {right: 8, bottom: 8, borderRightWidth: 1, borderBottomWidth: 1},
  ];

  return (
    <AbsoluteFill style={{backgroundColor: "#070a12", fontFamily: CJK_FONT}}>
      {/* 背景：新版式用全屏 poster（object-fit: cover），老版式走左栏底色 */}
      {overlayMode ? (
        <Img
          src={poster}
          style={{position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover"}}
        />
      ) : null}

      {/* 叠加层：hero 视频 / 图片叠在整屏之上（无 poster 时就是老版式的左栏素材） */}
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: heroW,
          height: heroH,
          overflow: "hidden",
          backgroundColor: overlayMode ? "transparent" : bg,
        }}
      >
        {hero && heroIsVideo && drivenByFrame ? (
          <OffthreadVideo
            src={hero}
            muted
            trimBefore={Math.round(srcTime * heroSrcFps)}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
            }}
          />
        ) : null}
        {hero && heroIsVideo && !drivenByFrame ? (
          <Html5Video
            src={hero}
            muted
            loop
            playbackRate={heroSpeed}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
            }}
          />
        ) : null}
        {hero && !heroIsVideo && isImageSrc(hero) ? (
          <Img
            src={hero}
            style={{position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover"}}
          />
        ) : null}
        {/* 左右分界过渡：老版式用来盖住「左栏右缘」的硬边；叠加版式不需要 */}
        {!overlayMode ? (
          <div
            style={{
              position: "absolute",
              right: 0,
              top: 0,
              width: Math.round(width * 0.12),
              height: "100%",
              background: "linear-gradient(to right, rgba(7,10,18,0) 0%, rgba(7,10,18,0.55) 55%, rgba(7,10,18,1) 100%)",
            }}
          />
        ) : null}
        {/* 内测暗角：压住画面边缘、把视线收回人物 */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "linear-gradient(to bottom, rgba(7,10,18,0.45) 0%, rgba(7,10,18,0) 22%, rgba(7,10,18,0) 74%, rgba(7,10,18,0.55) 100%)",
          }}
        />
        {!hero ? (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "rgba(214,226,255,0.35)",
              fontSize: Math.round(fontSize * 0.6),
              letterSpacing: 4,
            }}
          >
            等待动态层
          </div>
        ) : null}
      </div>

      {/* 台词卡：新版式只用 cardRect 定位（金框由底图画好），老版式自带金边 */}
      <div
        style={{
          position: "absolute",
          left: cardLeft,
          top: cardTop,
          width: cardW,
          height: cardH,
          background: overlayMode ? "rgba(8,12,26,0.34)" : "rgba(10,16,32,0.82)",
          borderRadius: 2,
          boxShadow: overlayMode
            ? "inset 0 0 0 1px rgba(232,200,138,0.18)"
            : `0 0 0 1px ${accent}, inset 0 0 0 2px rgba(10,16,32,1), inset 0 0 0 3px rgba(232,200,138,0.55)`,
          opacity: pageFade,
        }}
      >
        {!overlayMode
          ? corners.map((c, i) => (
              <div
                key={"c" + i}
                style={{
                  position: "absolute",
                  width: 28,
                  height: 28,
                  borderColor: accent,
                  borderStyle: "solid",
                  borderWidth: 0,
                  ...c,
                }}
              />
            ))
          : null}
        {/* 上下边缘中央的小菱形（老版式装饰；叠加版式的装饰在底图上） */}
        {!overlayMode ? (
          <>
            <div
              style={{
                position: "absolute",
                left: "50%",
                top: -4,
                width: 8,
                height: 8,
                marginLeft: -4,
                transform: "rotate(45deg)",
                backgroundColor: accent,
              }}
            />
            <div
              style={{
                position: "absolute",
                left: "50%",
                bottom: -4,
                width: 8,
                height: 8,
                marginLeft: -4,
                transform: "rotate(45deg)",
                backgroundColor: accent,
              }}
            />
          </>
        ) : null}

        {/* 台词正文 */}
        <div
          style={{
            position: "absolute",
            inset: `${padTop}px ${padX}px ${padBottom}px`,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: overlayMode ? "center" : "flex-start",
          }}
        >
          {page.map((line, i) => {
            const visible = line.slice(0, shownByLine[i]);
            return (
              <div
                key={"l" + pageIndex + "-" + i}
                style={{
                  color: "#f6f1e6",
                  fontSize,
                  lineHeight: 1.55,
                  letterSpacing: 1,
                  textAlign: overlayMode ? "center" : "left",
                  textShadow: overlayMode ? "0 2px 10px rgba(0,0,0,0.85)" : "none",
                  whiteSpace: "pre-wrap",
                  display: "flex",
                  alignItems: "center",
                  minHeight: Math.round(fontSize * 1.55),
                }}
              >
                <span>{visible}</span>
                {stillTyping && i === typingLine ? (
                  <span
                    style={{
                      display: "inline-block",
                      width: 3,
                      height: Math.round(fontSize * 1.05),
                      marginLeft: 6,
                      backgroundColor: "#ffd98f",
                      opacity: cursorOn,
                    }}
                  />
                ) : null}
              </div>
            );
          })}
        </div>

        {/* 页码点 */}
        <div
          style={{
            position: "absolute",
            right: overlayMode ? padX : 56,
            bottom: overlayMode ? Math.max(10, Math.round(padBottom * 0.45)) : 36,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          {pages.map((_, i) => (
            <div
              key={"p" + i}
              style={{
                width: i === pageIndex ? 9 : 6,
                height: i === pageIndex ? 9 : 6,
                borderRadius: "50%",
                backgroundColor: i === pageIndex ? "#ffd98f" : "#5a6478",
              }}
            />
          ))}
        </div>
      </div>

      {voice ? <Audio src={voice} /> : null}
    </AbsoluteFill>
  );
};
