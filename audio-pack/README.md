# audio-pack —— MTNode 音频分析后端（纯 Python）

这是 MTNode「音频分析」后端随包放进来的脚手架：一个只绑 `127.0.0.1` 的本地 HTTP 服务，
`POST /analyze` 把一段音频/视频的音轨跑成**剪辑可用的结构化结果**（BPM、拍点、downbeat、
小节/乐句、敲击事件、能量相位、段落、频谱/波形 PNG、切点建议），另带一份给 Agent 读的
中文字段字典 `diagnostics.fieldGuide`。唯一依赖是 **numpy**（没有 librosa / scipy / Pillow /
matplotlib / torch）；解码走本机 `ffmpeg` 子进程，PNG 用 numpy + zlib 自己写。

真源（不要改）：
[`docs/audio-analysis/service-contract.md`](../../docs/audio-analysis/service-contract.md)（HTTP 面 ·
鉴权 · 并发 · 超时 · 降采样 · 缓存 · 错误码 · 日志）、
[`analyze-contract.md`](../../docs/audio-analysis/analyze-contract.md)（响应 10 个块与 9 条不变量）、
[`analyze.schema.json`](../../docs/audio-analysis/analyze.schema.json) +
[`analyze.example.json`](../../docs/audio-analysis/analyze.example.json)（机器可读形状）。

## 怎么起

宿主的口径（cwd 必须是数据目录那一层，里面要有 `app/ cache/ artifacts/ api-key.txt`）：

```
cwd = %APPDATA%\pipeline-console\audio-analysis
<venv>\Scripts\pythonw.exe -m app --port 8774 --ffmpeg "C:\...\ffmpeg.exe"
```

手工调试：

```powershell
$env:MT_AUDIO_ROOT = "$env:TEMP\audio-analysis"     # 可选：换数据目录（默认取 cwd）
python -m app --port 8774 --ffmpeg "C:\ProgramData\chocolatey\bin\ffmpeg.exe"
# 另开一个窗口：
$k = Get-Content "$env:MT_AUDIO_ROOT\api-key.txt" -Raw
Invoke-RestMethod http://127.0.0.1:8774/health
$body = @{ audioPath = "D:\media\bgm.mp3"; options = @{ viz = @{ kinds = @("spectrogram","beatOverlay") } } } | ConvertTo-Json -Depth 6
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8774/analyze -Headers @{ Authorization = "Bearer $k" } -ContentType 'application/json' -Body $body
```

参数只有三个：`--port` / `--ffmpeg` / `--no-auth`（**不接受 `--host`**，绑回环是硬约束）。
端口优先级 `--port` > `MT_AUDIO_PORT` > 8774；被占用时在 8774–8783 顺序顺延。
就绪后 stdout 打 `[audio] ready port=8774 pid=23144`（宿主按这一行判定就绪），退出前打 `[audio] bye`。

`api-key.txt` 首次启动自动生成（32 位 hex），已存在则复用；请求头二选一：
`Authorization: Bearer <key>` 或 `X-Api-Key: <key>`。`GET /` 与 `GET /health` 免鉴权。
`--no-auth` 关闭鉴权（`/health.auth` 回 `"off"`，仅本机调试用）。

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 自述 JSON（免鉴权） |
| GET | `/health` | 探活：`decoder.found/version`、`busy`、`limits`、缓存条目（免鉴权，不 spawn ffmpeg） |
| POST | `/analyze` | `{audioPath, options}` → 契约响应体；300 s 预算、单并发、按 mtime+size+options 缓存 |
| GET | `/artifact/<key16>/<kind>.png` | 取图（`spectrogram`/`waveform`/`beatOverlay`/`energyCurve`） |
| POST | `/shutdown` | 退出（宿主 `before-quit` 调） |

## 依赖

```
numpy>=1.24,<3        # 唯一硬依赖（app/requirements.txt 与根 requirements.txt 各一份，内容相同）
ffmpeg / ffprobe      # 由宿主注入（--ffmpeg），找不到也不阻止服务启动，/analyze 会回 E_INTERNAL
```

## 目录

```
audio-pack/
  app/__init__.py        版本号（唯一来源是 contract.VERSION）
  app/__main__.py        入口：argparse（--port / --ffmpeg / --no-auth）
  app/contract.py        版本、contract 块、错误码表、警告码、字段字典 FIELD_GUIDE
  app/decode.py          ffprobe 元信息 + ffmpeg 管道解码 + 时长/体积上限 + LUFS
  app/dsp.py             STFT / 谱通量 onset / 三带 + 鼓型 / 0.1s RMS / attack 细栅格
  app/tempo.py           BPM 三路估计 + 候选表 + 倍频纠正 + DP 拍轨
  app/beats.py           拍点拾取 + attack 精修 + downbeat + bars/phrases + onset 落格
  app/sections.py        能量相位 + 关键转折 + 段落切分/吸附/9 类标签
  app/pngw.py            纯 numpy + zlib 的 PNG 编码器与四种图
  app/cache.py           缓存 key / index.json / 原子写 / 2GiB+30 天 LRU / 孤儿清理
  app/serve.py           ThreadingHTTPServer：路由 / 鉴权 / 并发 / single-flight / 错误映射
  app/analysis.py        总装：analyze_file(path, options) -> dict（不经 HTTP 也能调）
  app/requirements.txt   numpy>=1.24,<3
  requirements.txt       同上（安装链读根上这一份）
  scripts/check.py       自检：numpy / ffmpeg / api-key / 1 秒静音 / 合成素材真值（五步）
  scripts/make_fixtures.py     合成素材生成器：定速点击轨 / 变速斜坡 / 静音填充脉冲 + MP3·AAC 副本（真值进 fixtures.json）
  scripts/calibrate_latency.py 检测器系统延迟标定与对账（合成脉冲真值 → contract.DETECTOR_LATENCY_MS）
```

## 自检

```powershell
cd %APPDATA%\pipeline-console\audio-analysis
<venv>\Scripts\python.exe scripts\check.py
```

五步全过退出码 0，任一失败退出码 1 并打印中文 `[FAIL]` 行。第 5 步是**真值校验**（不是自证）：
合成素材的真值已知，所以能直接断言 —— 拍点误差 <5 ms、三种容器一致（±1 帧）、
`energy.curves` 与 `energy.perFrame` 在脉冲上对齐 <1 帧、变速轨的分段速度图单调且贴住真值，
同时把六个检测器的系统延迟与 `app/contract.py` 的 `DETECTOR_LATENCY_MS` 逐项对账。

单独跑标定 / 只生成素材：

```powershell
python scripts\calibrate_latency.py --check          # 对账，偏差超容差退出码 1
python scripts\make_fixtures.py --out $env:TEMP\fx   # 素材 + fixtures.json（真值）
```

## 实现要点（读代码前先知道这几条）

* **时间坐标不漂**：`T≤600s` 用 `sr=22050/hop=512`，`>600s` 用 `sr=11025/hop=256`，
  两者帧率都是 43.066 fps；降采样时 `contract.frameGrid` 如实写、`diagnostics.parameters.downsampled=true`、
  warnings 加 `DOWNSAMPLED`。
* **绝不外推网格**：拍点先由 DP 拍轨锁在 onset 包络峰上，再逐拍吸附 ±40 ms 内的真实 attack；
  `gridConfidence = attackCoverage`（落在真实 attack ±25 ms 的占比）。`<0.5` 降级
  （`downbeatMethod:"none"`、`downbeatsSec`/`bars` 空 + `NO_GRID`），`===0` 时整块拍位降级 `unknown`。
* **静音不是错误**：200 + `onsets.count=0` + `beatCount=0` + `NO_ONSET`/`NO_GRID`。
* **检测器延迟是标定常数，不是玄学**：`contract.DETECTOR_LATENCY_MS` 里记着六个检测器相对真实事件的
  固定延迟（1 ms attack 栅格上的平滑偏置、块 RMS / 逐帧池化的「标签取起点」偏置），分析链按它校正：
  `onsets.events[].t` / `beatGrid.beatsSec` 是标量平移，`energy.curves` / `kick` 是块栅格半格平移，
  `energy.perFrame` 是池化栅格半帧平移。数值由 `scripts/calibrate_latency.py` 在合成脉冲上标定并逐项对账，
  校正后残差 ≤ 半个栅格（≈2.9 ms / ≈17 ms @30 fps）；实际生效值见 `diagnostics.parameters.detectorLatencyMs`。
* **子进程不弹窗**：所有 ffmpeg/ffprobe 调用统一经 `decode._run` / `decode._popen`，
  带 `creationflags=CREATE_NO_WINDOW`（`os.name=="nt"`）+ `stdin=DEVNULL` —— 宿主用 `pythonw.exe`
  起服务，漏了这一条每分析一次就会在用户屏幕上闪一只黑窗。
* **数据只写数据目录**：`cache/`、`artifacts/`、`api-key.txt`；绝不写应用目录（AGENTS.md 硬约束）。
