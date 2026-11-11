# 节拍网格、BGM 结构与混音命令

## 1. 节拍网格（不要相信 tempo 标量）

```python
import numpy as np, librosa

y, sr = librosa.load("bgm.mp3", sr=None, mono=True)
tempo, beats = librosa.beat.beat_track(y=y, sr=sr, tightness=400, units="time")

# 用整个 beat 序列拟合 t_i = t0 + i*T，求真实 BPM 与相位
i = np.arange(len(beats))
A = np.vstack([i, np.ones_like(i)]).T
(T, t0), *_ = np.linalg.lstsq(A, beats, rcond=None)
bpm = 60.0 / T
residual = beats - (t0 + i * T)
print(f"BPM={bpm:.2f} t0={t0:.4f}s T={T:.5f}s 残差±{np.abs(residual).max()*1000:.0f}ms")
```

`beat_track` 的 tempo 标量可能偏 2% 以上（实测 129.2 vs 真值 131.97），但 beat 时刻序列本身可用；拟合后以 **BPM + `t0`** 作为全片唯一网格。

验收：残差 ≤ ±15 ms。不通过时依次尝试：

1. `librosa.effects.hpss` 分离打击成分，只测 `y_percussive`；
2. Demucs 分鼓轨：`uvx --from demucs demucs --two-stems=drums -n htdemucs bgm.mp3 -o analysis/`，之后全部在 `drums.wav` 上跑；
3. 多方法交叉验证（madmom RNN+DBN、Essentia `RhythmExtractor2013`），三者不一致就回到瞬态覆盖率投票，不猜；
4. 变速曲（DJ 转场、accelerando）：5 s 窗局部 tempogram 找变速点，分段各自拟合 `t0`/`T`。

拍号换算：第 n 拍时间 `t_n = t0 + n·T`；第 n 帧 `round(t_n · fps)`。**全程用浮点秒记录，最后一步才换算成帧**，提前取整会让误差在管线里滚雪球。

## 2. 钉帧与补偿

```text
预期画面对齐时刻 = 镜头切点（帧）
实际钉帧位置     = 切点 - 音源攻击延迟（峰值时间）- 输出偏移
```

- 音源攻击延迟取 10 ms RMS 能量峰相对文件头的时间（常 0.03–0.2 s）。
- 补偿后不给 `durationInFrames` 加偏移：窗口整体前移即可，给截断型音效加长窗口会多播本该裁掉的部分。
- `Math.max(0, …)` 一类兜底意味着片头约 2 帧内的钉点无法完全补偿，残差记进验收表；**片头重音不要设计在前 2 帧**。
- 30 fps 下 1 帧 = 33.3 ms，3 帧 ≈ 100 ms；这是「看着对」的感知阈值，不是精确对齐标准。

复测：重渲后对 2–3 个探针重跑互相关，残差 ≤ 0.5 帧为合格。

## 3. BGM 结构与提示词

### 3.1 结构表（按总时长取比例）

| 段 | 占比 | 配器动作 | 剪辑动作 |
| --- | --- | --- | --- |
| intro | 0–10% | pad/环境，无鼓 | 第 1 个重音落在首个切点 |
| build | 10–45% | 加 riser、加军鼓层 | 切点密度提高，riser 切在 drop 前 1 帧 |
| drop / chorus | 45–70% | 全编制进入 | 只给 1–2 个关键 impact，不每拍加 |
| sustain | 70–88% | 抽 riser，留主律动 | 中速切点，留呼吸 |
| outro | 88–100% | 抽低频与鼓 | 末帧前 0.5 s 收干净 |

### 3.2 提示词骨架（Lyria / ACE-Step 通用）

```text
Purpose: [产品发布 60 秒 underscore / 教程背景 / 片尾 CTA]，目标 [N] 秒。
Tempo & harmony: [BPM]，[4/4]，[调性或无调性]。
Instrumentation: [乐器 3–5 件]，[是否含人声：instrumental only]。
Structure: intro 0–6s / build 6–27s / drop 27–42s / outro 42–60s。
Dynamics: [克制 → 推进 → 峰值 → 收束]，不要全程满编制。
Ending: [干净收尾 / 淡出 2 秒]，末帧不留残响。
```

- 生成模型不会精确给时长：Lyria 3 Clip 固定 30 秒；Pro 靠提示词与时间戳影响，最长约 3 分钟，返回值里的 `duration_seconds` 是请求值不是实测值，**一律 `ffprobe` 复核**。
- ACE-Step 场景预设有现成 BPM/调性：`corporate-bg` 110/C、`upbeat-tech` 128/G、`ambient` 72/D、`dramatic` 90/Dm、`tension` 85/Am、`hopeful` 120/C、`cta` 135/E、`lofi` 85/F。
- 需要精确时长：保留 provider 原始文件不动，另做一条 production master（裁切/补静音/淡出），两条都记录来源与实测时长。

## 4. 混音命令

### 4.1 闪避（人声压音乐）

```bash
ffmpeg -i bgm.wav -i voice.wav -filter_complex \
"[0:a]volume=0.34[m];\
 [1:a]asplit=2[v1][sc];\
 [m][sc]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=300[duck];\
 [duck][v1]amix=inputs=2:duration=longest:normalize=0[a]" \
-map "[a]" -c:a pcm_s24le mix.wav
```

- `threshold` 0.02–0.05：越低越容易被触发；`ratio` 6–12；`attack` 10–30 ms（不要压掉字头）；`release` 250–400 ms。
- 闪避量目标 6–12 dB；超过 15 dB 会被听成「音乐在躲」。
- 不想用 sidechain 就做包络自动化：按台词段落给 BGM 打 `volume` 关键帧，段前 150 ms 降、段后 300 ms 升。

### 4.2 淡入淡出与首尾

```bash
ffmpeg -i bgm.wav -af "afade=t=in:st=0:d=1.2,afade=t=out:st=58.5:d=1.5" bgm_faded.wav
```

### 4.3 多轨合成后的峰值检查

```bash
ffmpeg -i mix.wav -af "ebur128=peak=true" -f null - 2>&1 | tail -n 12
```

- 真峰值 > -1 dBTP → 整体降 1–2 dB 或上 `alimiter=limit=0.89`（≈ -1 dBFS），不要靠压限掩盖编排问题。
- 人声段与 SFX 段分别抽 10 s 复测，确认没有一层被另一层盖住。

### 4.4 分轨处理（素材自带音乐时）

```bash
# Demucs 拆人声/伴奏
uvx --from demucs demucs --two-stems=vocals -n htdemucs source.mp3 -o stems/
# ACE-Step 分轨（vocals/drums/bass/guitar/piano/...）
python tools/music_gen.py --extract source.mp3 --output stems/
```

拆出来的伴奏只能当参考或临时垫底；交付前确认授权允许改编。

## 5. 双版本交付

```bash
# 带 BGM
ffmpeg -i picture.mp4 -i mix.wav -map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k final_bgm.mp4
# 无 BGM（保留 SFX 与人声）
ffmpeg -i picture.mp4 -i mix_nobgm.wav -map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k final_nobgm.mp4
```

清单里写清两版差异：`{"bgm": false}` 一类开关要能被渲染器读到，不能靠人工删轨。

## 6. 终检

- [ ] 每个 cue 都有钉帧时间、素材 ID、许可与署名状态。
- [ ] 节拍残差 ≤ ±15 ms，切点复测 ≤ 0.5 帧。
- [ ] 说话段 BGM 闪避 6–12 dB，人声清晰可懂。
- [ ] 整体真峰值 ≤ -1 dBTP；环境铺底不低于 -40 LUFS 才当内容。
- [ ] 两版（带/不带 BGM）同时间线、同长度、同编码参数。
- [ ] 清单、署名清单、`audio-manifest.json` 与文件哈希一致。
