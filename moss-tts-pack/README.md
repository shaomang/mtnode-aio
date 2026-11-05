# moss-tts-pack — MOSS-TTS-Nano 内置语音脚手架

MTNode 的**内置** TTS 后端（不是插件卡）。状态栏那枚 🔊 按钮第一次启用时，主进程
（`moss-tts/main-moss-tts.js`）会把这个目录同步到数据目录，然后建 venv、装依赖、
从 hf-mirror 下 ONNX 权重，最后用 `app/serve.py` 起一个常驻工作进程。

- 模型：[OpenMOSS/MOSS-TTS-Nano](https://github.com/OpenMOSS/MOSS-TTS-Nano)（0.1B，48 kHz，多语言，支持参考音频克隆）
- 推理：官方 **ONNX** 版（`onnxruntime`；有可用 N 卡时装 `onnxruntime-gpu`，见下文「推理设备」）
- 权重：`OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX` + `OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX`（首次下载，约 500MB）

## 目录

```
app/
  serve.py                            工作进程（JSON 行协议，见文件头）
  onnx_tts_runtime.py                 上游推理代码（本仓已打「去掉 torch」补丁）
  ort_cpu_runtime.py                  ONNX 会话 / 采样（上游原样）
  text_normalization_pipeline.py      文本归一化（上游原样；WeText 关闭时不加载 pynini）
  tts_robust_normalizer_single_script.py
  moss_tts_nano/                      上游包里的 defaults / 版本号
  seed/deepseek.wav                   内置默认音色（取自 Breeze 第一个角色「Deepseek · 日常」）
  seed/deepseek.json                  该音色的名字与参考文稿
  requirements.txt                    运行依赖（**不含 torch / torchaudio**；其中 onnxruntime 那一行由宿主
                                      跳过不装 —— CPU / GPU 版由设备探测决定，见下文）
LICENSE                               上游 Apache-2.0 许可
```

主进程侧的两只文件不在本目录，随包进 `files`：

```
moss-tts/main-moss-tts.js             宿主：安装链 / 音色 / 设备偏好 / 常驻 worker
moss-tts/gpu-detect.js                设备探测（纯判定 + 一次 nvidia-smi 读数）
```

运行时数据全在 `%APPDATA%\pipeline-console\pipeline-console\moss-tts\`（不写应用安装目录）：
`config.json`（启用开关 / 音色指针 / 设备偏好 / 上次设备）、`models/`、`voices/`、`out/`、`console.log`。

## 为什么去掉 torch

上游 `onnx_tts_runtime.py` 在文件头 `import torch / torchaudio`，但只在
`_load_reference_audio()` 里用来「读参考音频 + 重采样」。本仓把它换成
`soundfile` 读 + numpy 线性重采样，返回形状与上游一致（`(1, channels, frames)` float32），
安装体积从约 2GB 降到约 80MB —— 这是「内置、随开随用」的前提。
升级上游时只需同步其余逻辑，这一个函数保持本地补丁。

## 推理设备（装哪一版 / 怎么回落）

「装 CPU 版还是 GPU 版 onnxruntime」在装之前就定，不等运行期崩；判定真源是
`moss-tts/gpu-detect.js`，展示与日志真源是 worker 上报的 `device` 事件。

**探测（启用 / 安装时探一次，绝不轮询、不在合成路径上量卡）**

- 一次 `nvidia-smi --query-gpu=name,memory.total,memory.free,driver_version`，4 秒超时（走 `gpu-poll.js` 的
  `gpuExecFile`，不占主进程线程）。
- 判 CUDA 要四条同时成立：① 有 NVIDIA 卡；② 不是集显 / 核显 / 别家卡（名字含
  Intel / AMD / Radeon / UHD / Iris / Vega / Graphics 一律 CPU）；③ 总显存 ≥ **6GB**；④ 驱动主版本
  ≥ **527**（Windows）/ **525**（Linux），即 CUDA 12 的底线。
- 多卡挑「合格且空闲最多」的一张；都不合格时报**显存最大那张**的原因，code ∈
  `no_gpu` / `not_nvidia` / `driver_unknown` / `driver_old` / `vram_low`。
- **探测失败一律 CPU，永不抛**：没 `nvidia-smi`、超时、输出为空、字段 `[N/A]` 都只是「量不到」
  （code = `probe_failed`）—— CPU 版一定能跑，GPU 版不一定。

**装**

- 判 CPU → `onnxruntime>=1.20`；判 CUDA → `onnxruntime-gpu>=1.20,<1.23`（这一段是 CUDA 12 + cuDNN 9
  的构建；1.23+ 跟 CUDA 13 走，会找不到 DLL）。两版同名同 DLL，**先清干净另一只再装**（`pip uninstall` +
  删残留目录 / dist-info / `capi` DLL），装完 `import onnxruntime` 自检读 `get_available_providers()`。
- GPU 版**装不上**或**装上但自检里没有 `CUDAExecutionProvider`** → 自动改装 CPU 版，**安装不判失败**；
  `pipInstall()` 返回 `{mode:"cpu", fallback:"gpu_failed", error}`，日志与进度行写明原因。
- 已装 CPU 版而这次探测判 CUDA → 重装为 GPU 版（否则永远 CPU 推理）；两者一致就走快速通道，不重复下网络。

**跑**

- 给 worker 拼 `--provider`：偏好 `cpu` → `cpu`；偏好 `auto` 且本次进程没探过 → `auto`（交给 worker 自己探）；
  探过且判 CPU → 直接 `cpu`（别让 worker 白试一遍 CUDA）；探过判 CUDA 但装的是 CPU 版 → `auto`（让 worker 试，
  失败原因原样报回来）。
- `serve.py` 的 `auto` 先按 `CUDAExecutionProvider` 建 runtime 并校验 session 真的含该 EP；DLL 缺失 / 算子不支持 /
  显存不足 / **预热合成失败**，任何异常都重建 CPU runtime，并上报
  `{"type":"device","provider":"cpu","requested":…,"reason":"…"}` —— 进程一定能出声。
- 用户可见口径（状态栏按钮 tooltip + 右键「推理设备」）：`CUDA` / `CPU（已在右键菜单强制）` /
  `CPU（回落：原因）` / `CUDA（待首次合成确认）`。右键两项 = `自动 · GPU 优先（失败回落 CPU）` 与
  `强制 CPU（不试 CUDA，最稳）`；改偏好只写 `config.json` 并停掉 worker，下次合成按新偏好重拉。

## 音色（含复用 Breeze 音色库）

三种来源，写在 `config.json` 的 `voice`：

- `kind:"builtin"` — 随包 `app/seed/deepseek.wav`（Breeze 第一个角色的参考音频）。
- `kind:"custom"` — 用户上传的 prompt 音频，拷进数据目录 `voices/`。
- `kind:"breeze"` — **指针，不复制音频**：读 `<数据目录>/breeze-tts/presets/index.json`（默认
  `%APPDATA%\pipeline-console\pipeline-console\breeze-tts\presets\index.json`）里 Breeze 已建好的角色与分组，
  运行时按 `{presetId, groupId}` 现取同级 `audio/<audioFile>` 的绝对路径交给 worker。
  只收「音频文件真实存在」的组；`groupId` 缺省取该角色第一组。

回落口径（都不报错，照常出声）：

- Breeze 未安装 / 索引读不到 / 一个角色都不可用 → 菜单里那条显示「引用 Breeze 角色：未检测到 Breeze 角色」，
  内置 Deepseek 音色照常可用（启用时只写一条日志，不拦安装）。
- Breeze 指针失效（角色或分组被删、音频被移走）→ 现读不到就**回落内置 Deepseek**，并在返回的音色对象上带
  `fallback: true`（菜单显示「Breeze 角色已失效，已回落内置默认」）。
- 自定义音频被删 → 同样回落内置（`fallback: true`）；选音色时 `audioPath` 不存在会直接拒掉，不写进配置。
- 参考音频最终解析为 `{kind, name, audioPath}`；`audioPath` 为空时不合成，返回 `voice_missing`。

## 手动冒烟

```
powershell -File scripts/smoke-moss-tts.ps1
```

在 `%TEMP%\moss-tts-smoke` 里复刻整条安装链（venv → pip → hf-mirror 权重 → 合成一句），
最后打印生成的 wav 数量与字节数。

这个目录装好之后，可以只跑「启停 + 设备上报」这一段（不重复下载）：

```
node test/smoke-moss-tts.js              # 接线 / 白名单 / 后端纪律（不联网）
node scripts/e2e-moss-tts-host.js        # 主进程宿主：启用 → 合成 → 取消 → 停用
```

单独验 worker 启停（在 `%TEMP%\moss-tts-smoke\app` 里，用冒烟目录的 venv；只装了 CPU 版 onnxruntime 时
`auto` 会走回落）：

```
python serve.py --model-dir ..\models --provider auto     # 读 stdin 的 JSON 行
{"cmd":"ping"} → {"type":"device","provider":"cpu","requested":"auto","reason":"cuda 初始化失败: …"}
{"cmd":"shutdown"}                                        # → {"type":"bye"}，进程退出码 0
```
