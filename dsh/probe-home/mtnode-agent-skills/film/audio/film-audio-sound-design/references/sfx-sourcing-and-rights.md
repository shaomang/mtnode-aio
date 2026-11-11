# 音效选材、清单与授权

## 1. 从画面写声音需求（cue 行）

每个 cue 一行，字段固定，缺一列就不许下搜索：

```csv
cue_id,shot,action,source_material,target_duration,attack_tail,license
sfx01,S03,纸卡滑入,cardstock/paper,0.2-0.8s,dry single no tail,cc0
sfx02,S05,镜头快速右移,fabric whoosh,0.4-0.9s,soft attack short tail,cc0
sfx03,S09,金属门关上,metal door indoor,0.8-1.5s,hard attack deep tail,by
```

- `source_material` 写**真实发声物**，不写情绪词。
- `target_duration` 是成片里要用的长度，不是素材长度；素材可以更长，但必须能干净裁出。
- `attack_tail` 决定能不能卡点：有长尾的音效不适合密集切点。

## 2. Freesound 检索（脚本 CLI）

脚本只用 Python 3.9+ 标准库，不需要 Freesound API key；下载与分析需要 `ffmpeg` / `ffprobe`。

```bash
# 基础检索：时长上限 1 秒，取 5 条，结果落 JSON
python3 assets/scripts/sfx-source.py search "paper slide" --max-duration 1 --limit 5 --output audio-search.json

# 要署名的许可，最多翻 3 页
python3 assets/scripts/sfx-source.py search "short cinematic impact" --license by --max-duration 3 --pages 2

# 下载已选 ID（可多个）
python3 assets/scripts/sfx-source.py get fs:12345 fs:67890 --out-dir public/audio/sfx

# 单独分析处理后的文件
python3 assets/scripts/sfx-source.py analyze public/audio/sfx/fs-12345.mp3 --output audio-analysis.json
```

搜索输出字段：ID、标题、作者、素材页 URL、预览地址、描述、时长、下载量、评分、评分人数。保留**相关性顺序**，本地再按许可与时长过滤；`--pages` 最多 3 页，先缩窄关键词，不要靠翻页代替选材。搜索输出只是比较依据，**不是下载时的许可凭据**。

许可参数：默认 `cc0`；`--license by` 允许 CC0 与 CC BY；`get` 时同样要传 `--license by` 才能下 CC BY 条目。

## 3. 下载产物

| 文件 | 内容 |
| --- | --- |
| `fs-<id>.mp3` | Freesound 的高质量**有损 MP3 预览**，不是上传者原始 WAV |
| `audio-manifest.json` | 来源、作者、素材页、许可 URL/版本、预览标记、下载时间、SHA-256、改动记录、实测音频分析 |
| `FREESOUND-CREDITS.md` | 可随片交付的来源与署名清单 |

清单单条示例：

```json
{
  "id": "fs:12345",
  "file": "fs-12345.mp3",
  "title": "Paper slide on desk",
  "author": "someone",
  "page": "https://freesound.org/s/12345/",
  "license": {"code": "CC0-1.0", "url": "https://creativecommons.org/publicdomain/zero/1.0/", "version": "1.0"},
  "preview": true,
  "downloaded_at": "2026-11-04T10:00:00+08:00",
  "sha256": "<64 hex>",
  "changes": [{"op": "trim", "range": "0.12-0.64s"}],
  "analysis": {"format": "mp3", "sample_rate": 44100, "channels": 1, "duration": 0.72,
               "sample_peak_db": -3.1, "rms_db": -22.4, "peak_10ms_at": 0.14,
               "active_span_rel_peak_minus_40db": [0.09, 0.58]}
}
```

纪律：

- 改动（剪辑、变速、归一）必须补写 `changes`，否则清单与文件对不上。
- 重复下载先核对哈希，不覆盖自行修改或来源不明的同名文件。
- 每个输出目录同一时间只跑一个 `get`；部分失败时成功项仍保留清单，命令非零退出，只重试失败 ID。
- 网站超时/限流/结构变化时停止自动调用，说明具体问题；可给素材页让人工下载，再按同样字段记录。
- 下载文件必须随工程保存，不能只引用远程 URL。

## 4. 分析能说明什么、不能说明什么

`get` 自动记录：实际格式、采样率、声道、时长、sample peak、整体 RMS、10 ms RMS 能量峰、相对峰值 -40 dB 的活动区间。

- 这些**不是** LUFS、true peak 或精确动作起点；要 LUFS/峰值走 `film-audio-loudness` 的 `loudnorm`/`ebur128`。
- 多动作录音要挑**正确的那个峰**，不能把全文件最大峰套给所有 cue。
- 只有元数据与测量时，必须写「未试听」；下载量、波形、`ffmpeg` 分析都不能描述成听感。

## 5. 授权

| 许可 | 商用 | 署名 | 允许改编 | 本项目结论 |
| --- | --- | --- | --- | --- |
| CC0 | 可以 | 不需要 | 可以 | 默认选项 |
| CC BY | 可以 | **必须** | 可以 | 允许，但署名要进成片或发布页 |
| CC BY-NC | 不可以 | 必须 | 可以 | 商用片不接受 |
| Sampling+ | 受限 | 必须 | 受限 | 不接受 |
| 未知 / 无标注 | 不可判定 | — | — | 不接受 |

CC BY 的署名要写进 `FREESOUND-CREDITS.md` **且**进发布页说明或片尾字幕，只留在工程文件里不算履行义务。音乐（BGM）授权与音效分开记录，不能把 CC0 音效许可套到用户提供的音乐上。

## 6. 生成式音效（没有合适素材时）

ElevenLabs `text_to_sound_effects`：

```python
audio = client.text_to_sound_effects.convert(
    text="Heavy footsteps on wooden floorboards, slow and deliberate, with creaking",
    duration_seconds=1.0,     # 0.5–30 s（保守上限 22 s，见冲突说明）
    prompt_influence=0.8,     # 0–1，越高越贴提示词
    loop=False,               # 无缝循环需 v2 模型
)
```

提示词写法：**发声物 + 动作 + 空间 + 质感 + 节奏**。反例：「恐怖的声音」。正例：「Metal gate closing in a concrete stairwell, heavy latch, short reverb tail」。

- `prompt_influence`：写实拟音 `0.7–0.9`；氛围纹理 `0.3–0.5`（留模型发挥）。
- 循环铺底：`loop=True` + `duration_seconds` 取 8–15 s，接缝处用 20–50 ms 交叉淡化兜底。
- 生成素材同样要进清单（provider、prompt、seed、时长、许可条款），不要因为「自己生成的」就免记账。
