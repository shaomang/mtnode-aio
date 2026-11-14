/**
 * CanvasTake —— 把一条画布录制账本（`canvas-doc/canvas-take.js` 的 take）渲成 Remotion 合成。
 *
 * 三段分工（本文件只做这一段，别的都不碰）：
 *   · 画面像素：**路 A = 帧序列**。`canvas-doc/canvas-replay-runner.js` 已经按 take 的帧号逐帧
 *     出图（`<framesDir>/%05d.png`，文件号 = take 帧号 + 1），这里用 `<Img>` 顺序取帧。
 *     路 B（场景树：docTrack + 同一份 cam 现场重绘）就是把 `FrameLayer` 换掉，叠加层与宿主契约
 *     都不用动 —— take 里已经有它需要的一切。
 *   · 镜头：`camTrack` 交给 `interpolate`，缓动表与录制端 `canvas-take.js` 的 EASINGS 逐条对齐
 *     （回放时相机是按同一份补间算出来的，这里换成另一套缓动就会「画面和光标对不上」）。
 *     注意帧序列**已经烘焙了机位**（runner 出图前先 `applyTransform`），所以缺省不再对帧二次
 *     变换；只有拿「没烘焙机位」的帧源时才把 `cameraBakedFrames` 置 false，让机位现场做
 *     `translate + scale`（transform-origin 0 0，与 `#stage` 的写法一字不差）。
 *   · 叠加层：字幕 / 旁白 / 光标强调**只活在合成里**，一个字节都不写回 take。光标的世界坐标
 *     取自 `take.pointer`，这里乘回同一份机位（`screen = world * z + (x, y)`）才落到屏幕上。
 *
 * 依赖口径（不新增宿主契约）：一切参数从 `render.json` 的 `inputProps` 进来；`concurrency` /
 * `crf` / `browserExecutable` 全在 `remotion-pack/render.mjs` 里处理，合成层一概不碰。
 * 渲染页禁止 `file://`，所以路径类 props 只认三种：http(s)/data URL、工程 `public/` 下的相对
 * 路径（`staticFile()` 取）、或由宿主读好直接给对象 / JSON 串（`take` / `takeJson`）。
 */
import React, {useEffect, useState} from 'react';
import {
  AbsoluteFill,
  Audio,
  Img,
  Sequence,
  cancelRender,
  continueRender,
  delayRender,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

/* ── 常量（与录制 / 出帧端同一口径） ─────────────────────────────────────── */

/** 帧名模板：与 canvas-replay-runner.js 的 frameFileName() 一致 */
export const DEFAULT_FRAME_PATTERN = '%05d.png';
/** 帧号起点：与 runner 回执里的 firstNumber 一致（take 帧 0 → 00001.png） */
export const DEFAULT_FIRST_FRAME_NUMBER = 1;
/** 与 runner 那只离屏窗口的 backgroundColor 一致（帧没盖满时的底色） */
export const DEFAULT_CANVAS_BACKGROUND = '#0d1016';

const FONT_STACK =
  '"Noto Sans SC","Source Han Sans SC","Microsoft YaHei","PingFang SC",sans-serif';

/* ── 类型：take 里本合成会用到的部分（整份 take 由 canvas-take.js 定义） ──── */

export type CanvasTakeCamSample = {
  f: number;
  x: number;
  y: number;
  z: number;
  /** 这一条不补间（切镜 / 定位），直接取本条的值 */
  cut?: boolean;
  /** 补间缓动名，缺省 easeInOut */
  e?: string;
};

export type CanvasTakePointerSample = {
  f: number;
  x: number;
  y: number;
  down?: boolean;
};

export type CanvasTakeDoc = {
  v?: number;
  id?: string;
  wfId?: string;
  wfName?: string;
  fps?: number;
  width?: number;
  height?: number;
  dpr?: number;
  durationFrames?: number;
  startedAtMs?: number;
  finalHash?: string;
  camTrack?: CanvasTakeCamSample[];
  pointer?: CanvasTakePointerSample[];
  docTrack?: unknown[];
  uiTrack?: unknown[];
  meta?: Record<string, unknown>;
};

export type CanvasTakeCamState = {x: number; y: number; z: number};

export type CanvasTakePointerState = {
  x: number;
  y: number;
  down: boolean;
  /** 这一笔采样落在哪一帧（点击脉冲从这里起算） */
  at: number;
};

/** 字幕一条：秒为单位（合成层自己按 fps 换帧，不往 take 里写） */
export type CanvasTakeSubtitleCue = {
  start: number;
  end: number;
  text: string;
};

export type CanvasTakeSubtitleStyle = {
  /** 字号；缺省按画面高度算 */
  fontSize?: number;
  color?: string;
  background?: string;
  /** 距画面底部的比例（0–0.4），缺省 0.08 */
  bottom?: number;
  /** 文本最大宽度比例（0.2–1），缺省 0.84 */
  maxWidth?: number;
  lineHeight?: number;
  fontFamily?: string;
};

export type CanvasTakeVoiceover = {
  /** 音频：public/ 下的相对名 / http(s) URL / data URL（本机绝对路径会被 render.mjs 的 mediaBlobs 落成 public 裸名） */
  src: string;
  volume?: number;
  /** 从第几秒开始念，缺省 0 */
  from?: number;
  /** 念到第几秒，缺省到片尾 */
  to?: number;
};

export type CanvasTakeCursorStyle = {
  /** 光环半径（画面 CSS px），缺省 22 */
  radius?: number;
  color?: string;
  ring?: number;
  /** 点击脉冲（按下后 10 帧内的扩散圈），缺省开 */
  pulse?: boolean;
};

/** 叠加层：全部只在合成里画，不写回 take */
export type CanvasTakeOverlays = {
  subtitles?: CanvasTakeSubtitleCue[];
  subtitleStyle?: CanvasTakeSubtitleStyle;
  voiceover?: CanvasTakeVoiceover | null;
  cursor?: CanvasTakeCursorStyle | null;
};

export type CanvasTakeProps = {
  /** take 的路径：http(s) / data URL，或工程 public/ 下的相对名（如 "takes/wf/take-x.json"） */
  takePath?: string;
  /** 宿主读好的 take 对象（最稳的一条：渲染页不用再读盘） */
  take?: CanvasTakeDoc;
  /** 宿主读好的 take 正文（JSON 串） */
  takeJson?: string;
  /** 覆盖 take.fps（片子的时钟；帧号换算只认它） */
  fps?: number;
  /** 帧序列目录：public/ 下的相对目录或 http(s) 前缀（本机绝对路径会被拒，渲染页禁止 file://） */
  framesDir?: string;
  framePattern?: string;
  /** 与 runner 回执的 firstNumber 对齐，缺省 1 */
  firstFrameNumber?: number;
  /** 帧序列是否已烘焙机位（runner 出图就是烘焙过的），缺省 true */
  cameraBakedFrames?: boolean;
  background?: string;
  /** 缺省取 take.fps / take.durationFrames */
  durationInFrames?: number;
  overlays?: CanvasTakeOverlays;
};

/* ── 小工具 ─────────────────────────────────────────────────────────────── */

const num = (v: unknown, fb: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
};
const int = (v: unknown, fb: number): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : fb;
};
const clampInt = (v: unknown, lo: number, hi: number, fb: number): number => {
  const n = int(v, fb);
  return Math.max(lo, Math.min(hi, n));
};
const r2 = (v: number): number => Math.round(v * 100) / 100;
const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const messageOf = (err: unknown): string =>
  String((err && (err as Error).message) || err || '未知错误');

const isUrl = (s: string): boolean => /^(https?:|data:|blob:)/i.test(s);
const isFileUrl = (s: string): boolean => /^file:/i.test(s);
/**
 * 本机绝对路径：`E:\…` / `\\server\…`。只认这两种 —— 宿主给的是 Windows 路径；
 * 开头的单个 `/` 按「工程 public/ 根」处理（`staticFile('/frames/x.png')` 是合法写法）。
 */
const isFsPath = (s: string): boolean => /^[A-Za-z]:[\\/]/.test(s) || s.startsWith('\\\\');

const joinUrl = (base: string, name: string): string =>
  String(base).replace(/[\\/]+$/, '').replace(/\\/g, '/') + '/' + String(name).replace(/^[\\/]+/, '');

/* ── 帧名 / 资源路径 ─────────────────────────────────────────────────────── */

/** `%05d.png` + 帧号 → 文件名（与 runner 的 frameFileName 同一条规则） */
export function frameFileName(number: number, pattern?: string): string {
  const tpl = String(pattern || DEFAULT_FRAME_PATTERN);
  const m = /%0(\d+)d/.exec(tpl);
  const width = m ? Math.max(1, Number(m[1])) : 5;
  const padded = String(Math.max(0, Math.round(number))).padStart(width, '0');
  return tpl.replace(/%0\d+d/, padded);
}

/** 第 frame 帧（take 帧号，0 起）的 `<Img>` src */
export function frameSrcOf(
  framesDir: string,
  frame: number,
  firstFrameNumber?: number,
  pattern?: string,
): string {
  const dir = String(framesDir || '').trim();
  const name = frameFileName(
    num(firstFrameNumber, DEFAULT_FIRST_FRAME_NUMBER) + Math.max(0, int(frame, 0)),
    pattern,
  );
  if (!dir) {
    throw new Error(
      'CanvasTake：缺 framesDir（帧序列目录）。给工程 public/ 下的相对目录，或 http(s) 前缀。',
    );
  }
  if (isFileUrl(dir) || isFsPath(dir)) {
    throw new Error(
      'CanvasTake：framesDir 是本机路径（' +
        dir +
        '）。渲染页禁止 file://，请把帧目录放进工程 public/ 后只给相对目录名。',
    );
  }
  if (isUrl(dir)) return joinUrl(dir, name);
  return staticFile(joinUrl(dir, name));
}

/** take 的取法：URL / public 相对名；本机绝对路径明确拒绝，不猜 */
export function takeUrlOf(takePath: string): string {
  const p = String(takePath || '').trim();
  if (!p) throw new Error('CanvasTake：takePath 为空。');
  if (isFileUrl(p) || isFsPath(p)) {
    throw new Error(
      'CanvasTake：takePath 是本机路径（' +
        p +
        '）。渲染页禁止 file://：把它放进工程 public/ 后给相对名，或让宿主读成对象 / JSON 串传 take / takeJson。',
    );
  }
  if (isUrl(p)) return p;
  return staticFile(p.replace(/\\/g, '/').replace(/^\/+/, ''));
}

/** 音频取法：与帧同一条口径（URL / public 相对名） */
function audioSrcOf(src: string): string {
  const s = String(src || '').trim();
  if (!s) throw new Error('CanvasTake：旁白 src 为空。');
  if (isFileUrl(s) || isFsPath(s)) {
    throw new Error(
      'CanvasTake：旁白是本机路径（' +
        s +
        '）。交给 render.mjs 的 mediaBlobs 落进工程 public/ 后只给文件名。',
    );
  }
  if (isUrl(s)) return s;
  return staticFile(s.replace(/\\/g, '/').replace(/^\/+/, ''));
}

/* ── 相机 / 光标（纯函数，返回与 canvas-take.js 逐位对齐的值） ───────────── */

/** 与 canvas-doc/canvas-take.js 的 EASINGS 同一张表（录制端是真源，这里只做镜像） */
export const CAM_EASINGS: Record<string, (t: number) => number> = {
  linear: (t) => t,
  easeInOut: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  easeOut: (t) => 1 - Math.pow(1 - t, 3),
  easeIn: (t) => t * t * t,
  hold: (t) => (t >= 1 ? 1 : 0),
};

const camOf = (s: CanvasTakeCamSample): CanvasTakeCamState => ({
  x: r3(num(s.x, 0)),
  y: r3(num(s.y, 0)),
  z: r3(Math.max(0.001, num(s.z, 1))),
});

/** 某一帧的机位：区间两端之间按该条自带的缓动补间，cut 直接跳（= canvas-take.camAt） */
export function cameraAt(
  track: CanvasTakeCamSample[] | undefined,
  frame: number,
): CanvasTakeCamState | null {
  const arr = Array.isArray(track) ? track : [];
  if (!arr.length) return null;
  const f = Math.max(0, int(frame, 0));
  const first = arr[0];
  const last = arr[arr.length - 1];
  if (f <= int(first.f, 0)) return camOf(first);
  if (f >= int(last.f, 0)) return camOf(last);
  let i = 1;
  while (i < arr.length && int(arr[i].f, 0) < f) i++;
  const a = arr[i - 1];
  const b = arr[i];
  const af = int(a.f, 0);
  const bf = int(b.f, 0);
  if (b.cut || bf === af) return camOf(b);
  const ease = CAM_EASINGS[String(b.e || 'easeInOut')] || CAM_EASINGS.easeInOut;
  const mix = (p: number, q: number): number =>
    interpolate(f, [af, bf], [p, q], {
      easing: ease,
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });
  return {
    x: r3(mix(num(a.x, 0), num(b.x, 0))),
    y: r3(mix(num(a.y, 0), num(b.y, 0))),
    z: r3(Math.max(0.001, mix(num(a.z, 1), num(b.z, 1)))),
  };
}

/** 某一帧的光标：不落在采样点上就保持上一个位置（= canvas-take.pointerAt） */
export function pointerAt(
  track: CanvasTakePointerSample[] | undefined,
  frame: number,
): CanvasTakePointerState | null {
  const arr = Array.isArray(track) ? track : [];
  const f = Math.max(0, int(frame, 0));
  let pt: CanvasTakePointerState | null = null;
  for (const e of arr) {
    if (int(e.f, 0) > f) break;
    pt = {x: r2(num(e.x, 0)), y: r2(num(e.y, 0)), down: !!e.down, at: int(e.f, 0)};
  }
  return pt;
}

/** 轨道末帧（take.durationFrames 缺失时的兜底） */
export function lastFrameOf(take: CanvasTakeDoc): number {
  let f = 0;
  const tracks: unknown[] = [take.docTrack, take.camTrack, take.uiTrack, take.pointer];
  for (const track of tracks) {
    if (!Array.isArray(track) || !track.length) continue;
    const last = track[track.length - 1] as {f?: number} | undefined;
    f = Math.max(f, int(last && last.f, 0));
  }
  return f;
}

/* ── 画面层：路 A = 帧序列 ──────────────────────────────────────────────── */

type FrameLayerProps = {
  framesDir: string;
  frame: number;
  firstFrameNumber?: number;
  framePattern?: string;
  takeWidth: number;
  takeHeight: number;
  viewWidth: number;
  viewHeight: number;
  cameraBaked: boolean;
  cam: CanvasTakeCamState;
};

const FrameLayer: React.FC<FrameLayerProps> = (p) => {
  const src = frameSrcOf(p.framesDir, p.frame, p.firstFrameNumber, p.framePattern);
  /* 画幅比例一致就铺满（不缩边），否则 contain（宁可留底色也不裁掉画布） */
  const sameAspect =
    p.takeWidth > 0 &&
    p.takeHeight > 0 &&
    p.viewWidth > 0 &&
    p.viewHeight > 0 &&
    Math.abs(p.takeWidth / p.takeHeight - p.viewWidth / p.viewHeight) < 1e-3;
  const imageStyle: React.CSSProperties = {
    position: 'absolute',
    left: 0,
    top: 0,
    width: '100%',
    height: '100%',
    objectFit: sameAspect ? 'fill' : 'contain',
  };
  if (p.cameraBaked) {
    /* runner 出图前已经 applyTransform 过，这里再乘一次就是双倍机位 */
    return <Img src={src} style={imageStyle} />;
  }
  /* 路 B / 自定义帧源：帧是「世界」而不是「视口」，机位在现场做同一份变换 */
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: '100%',
        height: '100%',
        transform: `translate(${p.cam.x}px, ${p.cam.y}px) scale(${p.cam.z})`,
        transformOrigin: '0 0',
      }}
    >
      <Img src={src} style={imageStyle} />
    </div>
  );
};

/* ── 叠加层：字幕 ───────────────────────────────────────────────────────── */

type SubtitleLayerProps = {
  cues: CanvasTakeSubtitleCue[];
  seconds: number;
  height: number;
  style?: CanvasTakeSubtitleStyle;
};

const SubtitleLayer: React.FC<SubtitleLayerProps> = ({cues, seconds, height, style}) => {
  if (!Array.isArray(cues) || !cues.length) return null;
  let active: CanvasTakeSubtitleCue | null = null;
  for (const c of cues) {
    if (!c || !c.text) continue;
    const s = num(c.start, 0);
    const e = num(c.end, 0);
    if (seconds >= s && seconds < e) active = c;
  }
  if (!active) return null;
  const fontSize = Math.max(12, num(style && style.fontSize, Math.round(height * 0.042)));
  const bottom = Math.max(0, Math.min(0.4, num(style && style.bottom, 0.08)));
  const maxWidth = Math.max(0.2, Math.min(1, num(style && style.maxWidth, 0.84)));
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: Math.round(height * bottom),
        display: 'flex',
        justifyContent: 'center',
        padding: `0 ${Math.round((1 - maxWidth) * 50)}%`,
      }}
    >
      <div
        style={{
          maxWidth: `${Math.round(maxWidth * 100)}%`,
          padding: `${Math.round(fontSize * 0.3)}px ${Math.round(fontSize * 0.7)}px`,
          borderRadius: Math.round(fontSize * 0.35),
          background: (style && style.background) || 'rgba(8,10,14,0.62)',
          color: (style && style.color) || '#f6f8fb',
          fontFamily: (style && style.fontFamily) || FONT_STACK,
          fontSize,
          lineHeight: num(style && style.lineHeight, 1.42),
          fontWeight: 600,
          textAlign: 'center',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          textShadow: '0 1px 2px rgba(0,0,0,0.55)',
        }}
      >
        {active.text}
      </div>
    </div>
  );
};

/* ── 叠加层：光标强调（世界坐标 → 屏幕坐标走同一份机位） ────────────────── */

type CursorLayerProps = {
  pointer: CanvasTakePointerState | null;
  cam: CanvasTakeCamState;
  frame: number;
  style?: CanvasTakeCursorStyle | null;
};

const CursorLayer: React.FC<CursorLayerProps> = ({pointer, cam, frame, style}) => {
  if (!pointer || style === null) return null;
  const st = style || {};
  const radius = Math.max(6, num(st.radius, 22));
  const color = st.color || 'rgba(122,196,255,0.95)';
  const ring = Math.max(1, num(st.ring, 2));
  /* #stage 的变换是 translate(cam.x, cam.y) scale(cam.z)：世界点先缩放再平移 */
  const sx = pointer.x * cam.z + cam.x;
  const sy = pointer.y * cam.z + cam.y;
  const pulseOn = st.pulse !== false;
  const since = frame - pointer.at;
  const pulsing = pulseOn && pointer.down && since >= 0 && since <= 10;
  const k = pulsing ? since / 10 : 1;
  const pulseR = radius * (1 + 1.6 * k);
  return (
    <div style={{position: 'absolute', left: 0, top: 0, width: 0, height: 0}}>
      {pulsing ? (
        <div
          style={{
            position: 'absolute',
            left: sx - pulseR,
            top: sy - pulseR,
            width: pulseR * 2,
            height: pulseR * 2,
            borderRadius: '50%',
            border: `${ring}px solid ${color}`,
            opacity: 0.6 * (1 - k),
          }}
        />
      ) : null}
      <div
        style={{
          position: 'absolute',
          left: sx - radius,
          top: sy - radius,
          width: radius * 2,
          height: radius * 2,
          borderRadius: '50%',
          border: `${ring}px solid ${color}`,
          boxShadow: `0 0 ${Math.round(radius * 1.4)}px ${color}`,
          opacity: pointer.down ? 0.95 : 0.75,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: sx - 3,
          top: sy - 3,
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: color,
        }}
      />
    </div>
  );
};

/* ── 合成本体（拿到 take 之后） ─────────────────────────────────────────── */

type CanvasTakeViewProps = CanvasTakeProps & {
  take: CanvasTakeDoc;
  /** 拿不到 / 读不懂 take 时的明确说明（画在画面上，不静默出黑片） */
  problem?: string;
};

const CanvasTakeView: React.FC<CanvasTakeViewProps> = (props) => {
  const frame = useCurrentFrame();
  const cfg = useVideoConfig();
  const compFps = num(cfg.fps, 30) || 30;
  const take = props.take || {};
  const takeFps = num(props.fps != null ? props.fps : take.fps, compFps) || compFps;
  const takeFrameCount = Math.max(1, Math.max(num(take.durationFrames, 0), lastFrameOf(take)) + 1);
  const duration = clampInt(
    props.durationInFrames != null ? props.durationInFrames : cfg.durationInFrames,
    1,
    60 * 60 * 240,
    takeFrameCount,
  );
  /* 合成 fps 与 take fps 不一致时按时间换算帧号；一致（正常情况）就是自己 */
  const mapped = compFps === takeFps ? frame : Math.round((frame * takeFps) / compFps);
  const takeFrame = Math.max(0, Math.min(mapped, takeFrameCount - 1));
  const seconds = takeFrame / takeFps;
  const cam = cameraAt(take.camTrack, takeFrame) || {x: 0, y: 0, z: 1};
  const pointer = pointerAt(take.pointer, takeFrame);
  const overlays = props.overlays || {};
  const background = props.background || DEFAULT_CANVAS_BACKGROUND;
  const takeWidth = num(take.width, cfg.width) || cfg.width;
  const takeHeight = num(take.height, cfg.height) || cfg.height;

  if (props.problem) {
    return (
      <AbsoluteFill
        style={{
          backgroundColor: background,
          color: '#f2f4f8',
          fontFamily: FONT_STACK,
          alignItems: 'center',
          justifyContent: 'center',
          padding: '6%',
        }}
      >
        <div style={{fontSize: Math.round(cfg.height * 0.03), lineHeight: 1.5, textAlign: 'center'}}>
          {props.problem}
        </div>
      </AbsoluteFill>
    );
  }

  /* 旁白：只在合成里铺，take 不含音频 */
  const voice = overlays.voiceover;
  const voiceFrom = voice ? Math.max(0, Math.round(num(voice.from, 0) * compFps)) : 0;
  const voiceTo = voice && voice.to != null ? Math.round(num(voice.to, 0) * compFps) : duration;
  const voiceFrames = Math.max(0, Math.min(duration, voiceTo) - voiceFrom);
  const voiceVolume = Math.max(0, Math.min(2, num(voice && voice.volume, 1)));

  return (
    <AbsoluteFill style={{backgroundColor: background, overflow: 'hidden'}}>
      <FrameLayer
        framesDir={String(props.framesDir || '')}
        frame={takeFrame}
        firstFrameNumber={props.firstFrameNumber}
        framePattern={props.framePattern}
        takeWidth={takeWidth}
        takeHeight={takeHeight}
        viewWidth={cfg.width}
        viewHeight={cfg.height}
        cameraBaked={props.cameraBakedFrames !== false}
        cam={cam}
      />
      <SubtitleLayer
        cues={overlays.subtitles || []}
        seconds={seconds}
        height={cfg.height}
        style={overlays.subtitleStyle}
      />
      <CursorLayer
        pointer={pointer}
        cam={cam}
        frame={takeFrame}
        style={overlays.cursor === undefined ? {} : overlays.cursor}
      />
      {voice && voice.src && voiceFrames > 0 ? (
        <Sequence from={voiceFrom} durationInFrames={voiceFrames} layout="none">
          <Audio src={audioSrcOf(voice.src)} volume={voiceVolume} />
        </Sequence>
      ) : null}
    </AbsoluteFill>
  );
};

/* ── take 的取法：对象 / JSON 串 / 路径（路径走一次 delayRender 的读盘） ─── */

type TakeRead = {take?: CanvasTakeDoc; problem?: string};

/** 直接给的对象 / JSON 串：拿不到就回 null（才轮到 takePath 那条异步路） */
function readTakeFromProps(props: CanvasTakeProps): TakeRead | null {
  if (props.take && typeof props.take === 'object') return {take: props.take};
  const json = props.takeJson;
  if (typeof json === 'string' && json.trim()) {
    try {
      const parsed = JSON.parse(json.replace(/^\uFEFF/, ''));
      if (parsed && typeof parsed === 'object') return {take: parsed as CanvasTakeDoc};
      return {problem: 'takeJson 不是对象（解析出 ' + typeof parsed + '）。'};
    } catch (err) {
      /* 落到 CanvasTakeView 的 problem 上，别把渲染弄成一句无头异常 */
      return {problem: 'takeJson 解析失败：' + messageOf(err)};
    }
  }
  return null;
}

const CanvasTakeLoader: React.FC<CanvasTakeProps & {takePath: string}> = (props) => {
  const {takePath, ...rest} = props;
  const [state, setState] = useState<{text?: string; problem?: string}>({});
  const [handle] = useState(() => delayRender('canvas-take:' + takePath));

  useEffect(() => {
    let alive = true;
    let done = false;
    /* 无论走哪条分支都只放行一次：放行早了会截到空画面，放行两次会打乱 Remotion 的计数 */
    const finish = () => {
      if (done) return;
      done = true;
      continueRender(handle);
    };
    let url = '';
    try {
      url = takeUrlOf(takePath);
    } catch (err) {
      setState({problem: messageOf(err)});
      finish();
      return () => {
        alive = false;
        finish();
      };
    }
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
        return res.text();
      })
      .then((text) => {
        if (!alive) return;
        setState({text});
        finish();
      })
      .catch((err) => {
        if (!alive) return;
        /* 读不到 take 就别悄悄出一部黑片：让这次渲染明确失败 */
        cancelRender(new Error('CanvasTake：读不到 take（' + url + '）：' + messageOf(err)));
      });
    return () => {
      alive = false;
      finish();
    };
  }, [takePath, handle]);

  if (state.problem) return <CanvasTakeView {...rest} take={{}} problem={state.problem} />;
  if (typeof state.text !== 'string') return null;
  let take: CanvasTakeDoc = {};
  try {
    take = JSON.parse(state.text.replace(/^\uFEFF/, '')) as CanvasTakeDoc;
  } catch (err) {
    return (
      <CanvasTakeView
        {...rest}
        take={{}}
        takePath={takePath}
        problem={'take JSON 解析失败：' + messageOf(err)}
      />
    );
  }
  return <CanvasTakeView {...rest} take={take} takePath={takePath} />;
};

/**
 * 合成入口：`inputProps` 直接喂进来即可（见 `CanvasTakeProps`）。
 * 入口 `index.tsx` 的注册由宿主 / 上层接线负责，本文件不碰宿主契约。
 */
export const CanvasTake: React.FC<CanvasTakeProps> = (props) => {
  const read = readTakeFromProps(props);
  if (read && read.take) return <CanvasTakeView {...props} take={read.take} />;
  if (read && read.problem) {
    return <CanvasTakeView {...props} take={{}} problem={read.problem} />;
  }
  const path = String(props.takePath || '').trim();
  if (!path) {
    return (
      <CanvasTakeView
        {...props}
        take={{}}
        problem={'CanvasTake：缺 take。给 take（对象）/ takeJson（JSON 串）/ takePath（public 相对名或 URL）之一。'}
      />
    );
  }
  return <CanvasTakeLoader {...props} takePath={path} />;
};

export default CanvasTake;
