---
name: remotion-audio-captions
title: 音频、字幕与卡点
description: 在 Remotion 里铺音频与字幕：Audio/staticFile、音量包络与旁白闪避、逐词字幕数据格式、卡点对齐与带字幕导出。做口播、讲解、带 BGM 的片子时读它。
tags: 音频,字幕,卡点,BGM,音量包络,导出
version: 1.0.0
---

# 音频、字幕与卡点

声音占观感的一半，字幕决定"能不能静音看完"。两者都必须以**秒**为真值、只在进 Remotion 时换算成帧；
时间轴一旦用帧拍脑袋，卡点就一定偏。

## 何时用

- 给片子铺 BGM / 旁白 / 音效，需要淡入淡出、旁白段压低音乐、多轨叠加。
- 要做逐词字幕（karaoke 式高亮）、整句字幕、或从 `.srt` / ASR JSON 导入字幕。
- 要把切点、动效、音效钉在 BGM 的拍上（卡点片）。
- 要交付"带字幕版 / 无字幕版"或"带 BGM / 无 BGM 版"。
- 不适用：动画手感（去 animation 技能）、镜头配方（去 shot-recipes）。

## 核心原则

1. **音乐先行**：有 BGM 的片子先定曲、先测节拍网格，再排分镜；网格没验收不写镜头。
2. **秒记真值，最后一刻才换帧**：分析全程用浮点秒，`Math.round(秒 × fps)` 只在写进组件时发生一次；提前取整会让误差在管线里滚雪球。
3. **`volume` 是乘法系数，不是响度**：0.3 不等于 -10dB；多轨叠加后必须实听有没有削波、旁白是否被盖。
4. **旁白段必须闪避**：BGM 常驻 0.20–0.35，说话段压到 0.08–0.12，句间回升用 6–10 帧过渡。
5. **音效早 2–3 帧**：SFX 起点比画面落点早 2–3 帧才是"同步"，晚 1 帧就"脱手"。
6. **字幕一屏 2–4 个词（中文 6–16 字）**：超了就换页，不缩字号；字幕基线放在画面 65% 高度、竖屏上下各留 220px 安全区。
7. **字幕数据必须有毫秒级起止**：`startMs/endMs` 是唯一的时间源，不要在渲染时按字数猜时长。
8. **渲染不联网**：所有音频先落到 `public/`，用 `staticFile()` 引用；远程 URL 只在预览时用。

## 工作流

1. **备料**（输入：配音/BGM 文件）→ `ffprobe` 看时长、采样率、声道；旁白抽成 16k 单声道 WAV 喂 ASR。产出：`public/audio/` 下的固定文件。
2. **量时长**（输入：音频文件）→ `getAudioDurationInSeconds(staticFile(...))`（`@remotion/media-utils`）拿到秒数，回填合成时长。产出：`durationInFrames`。
3. **取时间戳**（输入：旁白音频）→ 走 ASR/对齐工具拿词级 `startMs/endMs`，存成 JSON。产出：`captions.json`，格式见 `references/caption-data-format.md`。
4. **测节拍**（输入：BGM，仅卡点片）→ 最小二乘拟合节拍网格，验收残差 ≤ ±15ms；算 `framesPerBeat = fps × 60 / BPM`。产出：`beat-grid.json`。
5. **铺轨**（输入：时间戳 + 节拍）→ `<Audio>` 逐条铺：BGM 在底、旁白在中、SFX 钉帧在顶；每轨独立 `Sequence`。产出：能听的时间轴。
6. **写包络**（输入：旁白段落起止）→ 用 `interpolate` 多点曲线做闪避与首尾淡入淡出。产出：`volume` 曲线。
7. **排字幕**（输入：`captions.json`）→ 按页切分（`createTikTokStyleCaptions` 或自己按标点合并），每页一个 `Sequence`，页内按 token 高亮。产出：逐词字幕组件。
8. **验片**（输入：渲染成片）→ 抽 3–5 个切点做交叉相关，误差 ≤0.5 帧；实听有没有削波、字幕有没有折行压到内容。产出：验收表。
9. **导出多版**（输入：成片）→ 带字幕 / 无字幕、带 BGM / 无 BGM 各一版，文件命名写清版本。产出：交付包。

## 关键参数与模板

### 音频：@remotion/media 的 Audio

```tsx
import { Audio } from "@remotion/media";                       // 新版推荐
import { Sequence, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";

const { fps } = useVideoConfig();   // 下面所有帧数都由它换算

// 1) 最简：整条铺满
<Audio src={staticFile("audio/bgm.mp3")} volume={0.28} />;

// 2) 裁切：只播第 2s 到第 10s（单位是帧，不是秒）
<Audio src={staticFile("audio/bgm.mp3")} trimBefore={2 * fps} durationInFrames={8 * fps} />;

// 3) 延迟起播：包一层 Sequence（Audio 本身不做延迟）
<Sequence from={45} durationInFrames={300}>
  <Audio src={staticFile("audio/vo-01.mp3")} volume={1} />
</Sequence>;

// 4) 循环垫底
<Audio src={staticFile("audio/loop.mp3")} loop volume={0.18} />;
```

| 属性 | 说明 |
| --- | --- |
| `src` | `staticFile("audio/x.mp3")`，不要带前导斜杠 |
| `trimBefore` | 从源文件第几**帧**开始播（旧版叫 `startFrom`，已废弃） |
| `trimAfter` | 到源文件第几帧结束；新代码优先用 `durationInFrames` |
| `durationInFrames` | 本轨播放多少帧（裁长样本用） |
| `volume` | 0–1 的系数；也可传 `(f) => number`，但官方推荐用 `interpolate(useCurrentFrame())` |
| `loop` | 循环播放（配合 `volume` 做多圈衰减） |
| `playbackRate` | 变速；`0.5`–`2` 之外会明显变调 |
| `toneFrequency` | 变调不变速（0.01–2），**只在服务端渲染生效**，Studio 预览听不出 |
| `muted` | 静音但保留时间轴 |

旧写法 `<Audio>` 来自 `remotion`（用 `startFrom/endAt`），新项目统一用 `@remotion/media`；
两者不要混用同一轨。

### 音量包络：闪避 + 首尾淡入淡出

```tsx
import { Audio } from "@remotion/media";
import { interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";

// voRanges: 旁白段落（秒），由字幕 JSON 的首尾句聚合而来
const voRanges = [
  [1.2, 6.4],
  [8.0, 14.2],
] as const;

export const Bgm: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const points: number[] = [0];
  const values: number[] = [0];

  for (const [start, end] of voRanges) {
    points.push(start * fps - 8, start * fps + 4, end * fps - 4, end * fps + 8);
    values.push(0.28, 0.10, 0.10, 0.28);   // 说话压到 0.10，句间回 0.28
  }
  points.push(durationInFrames - fps, durationInFrames);
  values.push(0.28, 0);

  return (
    <Audio
      src={staticFile("audio/bgm.mp3")}
      volume={interpolate(frame, points, values, {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      })}
    />
  );
};
```

- `points` 必须严格递增；多段旁白按时间顺序 push，否则 `interpolate` 报错。
- 首帧给 0、末帧给 0：不做淡入会有"啪"的爆音；淡出至少 0.8–1.0s。
- 音量参考值：BGM 0.20–0.35、旁白 1.0、whoosh 0.5–0.7、impact 0.6–0.8、tick 0.2–0.3。
  以上是系数起点，最终以实听为准（通用经验值）。

### 字幕数据结构

```ts
import type { Caption } from "@remotion/captions";

// 一条 Caption = 一个词（或一个短 token）
const captions: Caption[] = [
  { text: "这", startMs: 0, endMs: 180, timestampMs: 90, confidence: 0.98 },
  { text: "一", startMs: 180, endMs: 320, timestampMs: 250, confidence: 0.97 },
  { text: "帧", startMs: 320, endMs: 520, timestampMs: 420, confidence: 0.99 },
];

// 按 1.2s 内合并成"一页"
const { pages } = createTikTokStyleCaptions({
  captions,
  combineTokensWithinMilliseconds: 1200,
});
// pages[i] = { text: "这一帧", startMs, tokens: Caption[] }
```

| 字段 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `text` | string | 是 | 显示文本；中文按字、英文按词切 |
| `startMs` / `endMs` | number | 是 | 毫秒；决定这一 token 何时亮 |
| `timestampMs` | number \| null | 否 | 词中点，做高亮游标用 |
| `confidence` | number \| null | 否 | ASR 置信度，低于 0.6 的句子上屏前要人工核 |

`parseSrt({ input })` 可从 SRT 文本解析出同一结构；反向要 `.srt` 用 `serializeSrt()`。

### 逐词字幕组件（页 + 高亮）

```tsx
import { createTikTokStyleCaptions, type Caption } from "@remotion/captions";
import { AbsoluteFill, Sequence, useCurrentFrame } from "remotion";

export const Captions: React.FC<{ captions: Caption[]; fps: number }> = ({ captions, fps }) => {
  const { pages } = createTikTokStyleCaptions({
    captions,
    combineTokensWithinMilliseconds: 1200,
  });

  return (
    <AbsoluteFill>
      {pages.map((page, i) => {
        const from = Math.round((page.startMs / 1000) * fps);
        const next = pages[i + 1];
        const to = next ? Math.round((next.startMs / 1000) * fps) : from + Math.round(1.2 * fps);
        return (
          <Sequence key={i} from={from} durationInFrames={Math.max(1, to - from)} name={`字幕 ${i + 1}`}>
            <Page page={page} fps={fps} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};

const Page: React.FC<{ page: ReturnType<typeof createTikTokStyleCaptions>["pages"][number]; fps: number }> = ({
  page,
  fps,
}) => {
  const frame = useCurrentFrame();
  const nowMs = (frame / fps) * 1000 + page.startMs;

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", paddingBottom: "18%" }}>
      <div
        style={{
          fontSize: 64,
          fontWeight: 800,
          letterSpacing: "-0.01em",
          color: "#fff",
          WebkitTextStroke: "6px rgba(0,0,0,0.85)",  // 黑描边：任何底都能读
          paintOrder: "stroke fill",
        }}
      >
        {page.tokens.map((t, i) => {
          const active = nowMs >= t.startMs && nowMs < t.endMs;
          return (
            <span key={i} style={{ color: active ? "#22D3EE" : "#fff" }}>
              {t.text}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
```

字幕规格（实测口径）：

| 项目 | 值 |
| --- | --- |
| 字号（1080 宽） | 56–72px，粗体 ≥700 |
| 描边 | 4–8px 黑，`paintOrder: "stroke fill"` 保证描边在字下 |
| 每页字数 | 中文 ≤16 字 / 英文 ≤48 字符；TikTok 式 2–4 词 |
| 位置 | 距底 12–18%（竖屏 65% 高度处） |
| 高亮色 | 全片唯一主角色，别每页换色 |

### 卡点：从 BPM 到帧

```ts
const framesPerBeat = (fps * 60) / bpm;                 // 131.97 BPM @30fps ≈ 13.64 帧
const frameOfBeat = (n: number, beat0Sec: number) =>
  Math.round((beat0Sec + (n * 60) / bpm) * fps);
```

- 切点、重音、冲击帧一律用 `frameOfBeat()` 算，不要手写帧号。
- 实测口径：70s / 18 镜 / 131.97 BPM 的片子按此法制作，渲后回测切点误差 ≤2.2 帧（感知阈值约 3 帧）。
- BGM 整体有偏移时单独设 `OUTPUT_OFFSET_FRAMES` 常量，不要把偏移混进 BPM 常量。
- 详细测法与验收见 `references/beat-sync.md`。

### 导出带字幕的版本

| 交付 | 做法 |
| --- | --- |
| 硬字幕（平台兼容最好） | 字幕组件直接渲进画面（上面模板即是），出一个 mp4 |
| 软字幕（可开关） | 另存 `.srt`，用 ffmpeg 封装：`ffmpeg -i in.mp4 -i zh.srt -c copy -c:s mov_text out.mp4` |
| 两份字幕（中/英） | 两个字幕轨分别封装，播放器可选 |
| 无字幕版 | 字幕放进独立 `<Composition>`（如 `MainNoSub`），或给个 `showCaptions` prop 批量出两版 |
| 无 BGM 版 | BGM 用 `bgm` prop 控制（默认 true），批量渲染时传 `--props=props-nobgm.json`，内容 `{"bgm":false}` |

## 常见坑

- **音频播到一半断掉 / 比画面短**：`durationInFrames` 没给且源文件比合成短，或 `trimAfter` 写成了秒 → 先用 `getAudioDurationInSeconds()` 量出真实秒数再对齐。
- **切点总是差 2–4 帧**：BPM 取了 `beat_track` 的标量（实测偏差 2%+）→ 用整条 beat 序列做最小二乘拟合求真实 BPM 与相位（见 references）。
- **旁白听不清**：BGM 常驻 0.35 以上且没做闪避 → 说话段压到 0.10 左右，句间 6–10 帧回升。
- **字幕"跳字"或整页不同步**：每页 `Sequence` 的 `from` 用了 `Math.floor` 且页面首尾重叠 → 用 `Math.round`，并保证 `to` 取自下一页 `startMs`。
- **预览有声、渲染无声**：用了 `toneFrequency`（只在服务端生效）或资源走了远程 URL 且渲染机离线 → 全部改成 `public/` 本地文件。
- **上游写法差异**：部分上游把 `trimBefore/trimAfter` 标为"秒"，官方是**帧**；旧 `<Audio>` 的 `startFrom/endAt` 已被 `trimBefore/durationInFrames` 取代。本技能按官方口径，单位写错会整体偏 `fps` 倍。

## 来源与合并说明

| 上游仓库 | ★ | 许可 | 贡献内容 |
| --- | --- | --- | --- |
| calesthio/OpenMontage | 76149 | AGPL-3.0 | `remotion-best-practices` 的 audio / subtitles / display-captions / import-srt-captions 规则：`@remotion/media` Audio、裁切与延迟、Caption 结构与 TikTok 式分页 |
| Vincentwei1021/video-shotcraft | 16747 | Apache-2.0 | `music-beat-sync.md` 的节拍网格最小二乘拟合与验收口径、`sound-design.md` 的钉帧与音量纪律、SFX 早 2–3 帧 |
| Vincentwei1021/anything2explainer | 3033 | 无许可证 | 字幕规格（44px 白字黑边、每块 ≤16 字、折行即缺陷）与语速预算（中文 5.5 字/秒） |
| Vincentwei1021/video-talkcraft | 2063 | 无许可证 | 字级时间戳驱动画面切点、"画面跟话走"的单向对齐口径 |
| norahe0304-art/30x-video | 64 | MIT | 旁白段不拆句、一段连续音频的判例与 beat 边界吸附方法 |
| remotion-dev/remotion | 官方 | 见仓库 | `Audio` 属性、`Caption` 类型、`createTikTokStyleCaptions` 参数核对 |

- 抓取日期：2026-11-04
- 合并的上游技能：remotion-best-practices（audio / subtitles / display-captions / transcribe-captions / import-srt-captions）、video-shotcraft（music-beat-sync / sound-design）、anything2explainer（字幕与语速规范）、30x-video（rules/beat-sync、narration-sync）
- 冲突与取舍：字幕两套做法都保留——方案 A 逐词 TikTok 式（信息密度高、适合竖屏短视频），方案 B 整句 SRT 式（可读性好、适合讲解长片）；音量包络上游有 `volume={(f)=>...}` 与 `interpolate(useCurrentFrame())` 两种写法，按官方推荐统一为后者，前者只在需要读 `Audio` 自身时间轴时保留。
