# 卡点：节拍网格测定与帧对齐

目标：所有切点与关键动效落在拍上，渲后回测误差 ≤3 帧（感知阈值）；实测可达 ≤2.2 帧。

## 0. 何时启用

- 用户已指定强节奏 BGM → 必须走本文档：先测网格，再排分镜。
- 还没选曲 → 先按内容节奏排，不强行卡点；选曲后再吸附。
- 铁律：网格验收通过之前不设计分镜；时长对不上改时间参数，不删改用户文案。

## 1. 测 BPM 与相位（不要相信 tempo 标量）

```python
# uv run --with librosa --with scipy --python 3.11 beat_grid.py
import numpy as np, librosa

y, sr = librosa.load("bgm.mp3", sr=None, mono=True)
tempo, beats = librosa.beat.beat_track(y=y, sr=sr, tightness=400, units="time")

# beat_track 的 tempo 标量可能偏 2%+（实测 129.2 vs 真值 131.97），
# 但 beats 时刻序列是好的：用整条序列拟合 t_i = t0 + i*T
i = np.arange(len(beats))
A = np.vstack([i, np.ones_like(i)]).T
(T, t0), *_ = np.linalg.lstsq(A, beats, rcond=None)
bpm = 60.0 / T
residual = beats - (t0 + i * T)
print(f"BPM={bpm:.2f} t0={t0:.4f}s T={T:.5f}s 残差±{np.abs(residual).max()*1000:.0f}ms")
```

验收：

| 残差 | 判定 | 处理 |
| --- | --- | --- |
| ≤ ±15ms（半帧内） | 机器节拍，可直接用 | 通过 |
| ±15–40ms | 有人演奏的微漂 | 可用，切点靠近拍心 |
| > ±40ms | 测错了或曲子变速 | 见第 6 节，不要硬用 |

## 2. 换算成帧

```ts
const framesPerBeat = (fps * 60) / bpm;        // 131.97 BPM @30fps ≈ 13.64 帧
const beatFrame = (n: number) => Math.round((t0 + (n * 60) / bpm) * fps);
const barFrame = (bar: number) => beatFrame(bar * 4);   // 4/4 拍
```

- 帧号只在最后一刻取整：循环里保持浮点，写进 `Sequence from=` 时才 `Math.round`。
- 切点允许"贴拍心"偏移 ±1 帧，不要整体前移 3 帧——后者会让后半段累积漂移。

## 3. 鼓点分类决定编排

| 位置 | 典型事件 | 画面动作 |
| --- | --- | --- |
| 强拍（1、3 拍） | kick / bass | 切镜、硬转场、impact |
| 弱拍（2、4 拍） | snare / clap | 元素落位、字词揭示 |
| 八分 / 十六分 | hi-hat | 卡片逐张入场、光效脉冲 |
| 段落边界 | riser + 空拍 | 章节切换、留白 1 拍再起 |

**不给每一拍都配 impact**：重复冲击会饱和，30s 片子里重音 ≤6 次。

## 4. 音效钉帧

| 音效 | 相对画面 | 音量系数 | 说明 |
| --- | --- | --- | --- |
| whoosh（运镜/飞入） | 早 2–3 帧 | 0.5–0.7 | 晚一帧就"脱手" |
| impact（落地/砸入） | 与画面同帧 | 0.6–0.8 | 落点帧 = 压缩/震屏帧 |
| riser（铺垫） | 提前 0.8–1.5s 起 | 0.35–0.5 | 尾巴对齐切点 |
| click / tick（计数） | 与数字跳变同帧 | 0.2–0.3 | 密时降为一条 loop |
| shimmer（光效） | 早 1–2 帧 | 0.3–0.5 | 高频，别叠太多 |

连发落位音防"机枪感"三招：双样本交替、音量阶梯递减、间隔跟随动画曲线加速；
密到糊成一片时让它淡出成一条 swoosh，不逐卡配音。

## 5. 输出偏移与回测

若整条 BGM 在混音时被移动（加了淡入、裁了头），单独设常量，别改 BPM：

```ts
const OUTPUT_OFFSET_FRAMES = -2;   // 成片整体早 2 帧
const cue = (n: number) => beatFrame(n) + OUTPUT_OFFSET_FRAMES;
```

回测（渲后）：

1. 抽 3 个探针切点（如 f90 / f210 / f330），各取切点前后 ±6 帧。
2. 对音频做能量包络，找上升沿最大处；与设计帧做交叉相关。
3. 残差 ≤0.5 帧合格；2–3 帧需修；>3 帧说明网格或偏移错了。

```bash
# 抽探针帧 & 音频片段，肉眼 + 波形双验
ffmpeg -i out.mp4 -vf "select='eq(n\,90)+eq(n\,210)+eq(n\,330)'" -vsync 0 probe_%02d.png
ffmpeg -i out.mp4 -ss 6.8 -t 0.6 -vn -ac 1 probe.wav
```

## 6. 测不准时

- 只有人声/复杂编曲：先用 `librosa.effects.hpss` 分离打击成分再测；仍不干净就上 Demucs 取鼓轨：
  `uvx --from demucs demucs --two-stems=drums -n htdemucs bgm.mp3 -o analysis/`，之后全部在 `drums.wav` 上跑。
- 多方法交叉验证：madmom 的 RNN+DBN、Essentia 的 RhythmExtractor2013 作第二、三票；三者不齐时用瞬态覆盖率投票，不猜。
- 变速曲（DJ 转场、accelerando）：用局部 tempogram（约 5s 窗）找变速点，按能量段分段拟合，各段各自 `t0/T`。
- 没有可靠网格时报"按内容节奏排"，不要假装卡上了——错位的卡点比不卡点更廉价。

## 7. 与画面时间轴的接口

```ts
// timeline.ts —— 全片唯一的时间真源
export const BPM = 131.97;
export const T0 = 0.412;          // 第一拍（秒）
export const FPS = 30;
export const framesPerBeat = (FPS * 60) / BPM;

export const beatFrame = (n: number) => Math.round((T0 + (n * 60) / BPM) * FPS);

export const SHOTS = [
  { id: "hook",  fromBeat: 0,  beats: 8 },
  { id: "body1", fromBeat: 8,  beats: 12 },
  { id: "body2", fromBeat: 20, beats: 12 },
  { id: "payoff", fromBeat: 32, beats: 10 },
] as const;

export const shotFrames = SHOTS.map((s) => ({
  ...s,
  from: beatFrame(s.fromBeat),
  durationInFrames: beatFrame(s.fromBeat + s.beats) - beatFrame(s.fromBeat),
}));
```

镜头表按"拍"写、渲染时换算帧：改 BPM 或改 fps，整片自动重排；按帧硬编码的镜头表一改就全错。
