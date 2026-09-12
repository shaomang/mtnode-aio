# GPT-SoVITS 本地 TTS（MTNode 插件后端）

基于 [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) 的本地文本转语音：音色（参考音频）管理、OpenAI 兼容 `/v1/audio/speech` API、API Key 鉴权。

## 结构

- `app/` — FastAPI 管理服务 + GPT-SoVITS `api_v2.py` 进程编排
- `engine/` — GPT-SoVITS 源码克隆（安装时创建）
- `voices/` — 音色库：每个音色一个子目录（`ref.wav` + `ref.txt` 提示文本 + `ref.lang` 语言）；训练完成的音色额外带 `weights.json`（GPT/SoVITS 权重）
- `projects/` — 训练项目：每个项目一个子目录（`audio/` 上传音频、`text/` 文字标注、`logs/train.log` 训练日志、`manifest.json` 记录）
- `scripts/install.ps1` — 创建 venv、装依赖、克隆 GPT-SoVITS、下载预训练权重

## 安装

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -InstallDir .
```

或使用 MTNode 插件 UI / `skills/tts-local-install` Agent 流程。

## 国内镜像（必须）

> **中国大陆网络下必须使用镜像**：HuggingFace 无法直连，Python 库须走清华/中科院镜像。

- **Python 库**：清华 `https://pypi.tuna.tsinghua.edu.cn/simple`（或中科院 USTC `https://mirrors.ustc.edu.cn/pypi/simple/`）
- **预训练权重**：优先 **ModelScope(魔搭)** `lj1995/GPT-SoVITS`（可用 `TTS_MODELSCOPE_REPO` 覆盖），失败自动回退 `hf-mirror.com`
- **GitHub**（GPT-SoVITS 源码）：直连失败自动回退 `ghproxy.com` 镜像
- 安装脚本 `scripts/install.ps1` 已内置以上镜像与回退，无需手动配置。

## 运行（通常由插件启停）

```bat
start_backend.cmd
```

管理 API 默认 `http://127.0.0.1:8770`；GPT-SoVITS 推理端口 `9880`。

> 两个端口都是**本机回环**，后端访问它们时强制绕开系统代理（`ProxyHandler({})`）。
> 挂着 Clash / v2rayN 等"系统代理"时，代理常会把发往 `127.0.0.1:9880` 的请求回一个
> 空 body 的 503，表现成"引擎没起来 / 合成失败"，且随代理软件是否运行而时好时坏。
> 下载模型/依赖仍走系统代理（那是外网请求，需要代理）。

## API（OpenAI 兼容）

```bash
# 文本转语音
curl -X POST http://127.0.0.1:8770/v1/audio/speech \
  -H "Authorization: Bearer $TTS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-sovits","input":"你好，世界","voice":"my-voice","response_format":"wav"}' \
  -o out.wav

# 管理
curl http://127.0.0.1:8770/api/status          # 状态 + API Key + 音色
curl http://127.0.0.1:8770/api/voices          # 音色列表

# 采样步数（SoVITS 声码器合成步数）：服务端默认值，存安装目录 infer.json
curl http://127.0.0.1:8770/api/infer           # -> {"sampleSteps":32,"choices":[4,8,16,32,64,128],...}
curl -X POST http://127.0.0.1:8770/api/infer -H "Authorization: Bearer $TTS_API_KEY" \
  -H "Content-Type: application/json" -d '{"sampleSteps":128}'

# 单次调用可覆盖默认值：body 里的 sample_steps，或 ?steps=，或 X-Sample-Steps 头
curl -X POST "http://127.0.0.1:8770/v1/audio/speech?steps=64" -H "Authorization: Bearer $TTS_API_KEY" \
  -H "Content-Type: application/json" -d '{"model":"gpt-sovits","input":"你好","voice":"my-voice"}' -o out.wav
```

合成响应头会回显这次实际发的步数：`X-TTS-Sample-Steps: 64`、
`X-TTS-Sample-Steps-Apply: yes|no`、`X-TTS-SoVITS-Family: v2`。
**`no` 不是出错**：官方只有走声码器的 s2（`v3` / `v4`）消费这个参数，`v1` / `v2` / `v2Pro`
用的是 `SynthesizerTrn.decode(...)`，参数不下发——实测同一句同一 seed 下 32/64/128 输出的
**字节完全相同**（见 `TTS.py:515` 的 `v3v4set` 与 `TTS.py:538-554` 的 `use_vocoder`）。
本插件训练的 s2 是 **v2**，所以采样步数目前只是个"以后换底模就有用"的旋钮，
想治电流音请看下一节。取值会被归一到最接近的允许档（48→64，100→128，卡在中间向上取）。

`POST /api/voices/add`（multipart：`file`=wav、`name`、`prompt_text`、`lang`）添加音色。

### 输出格式（`response_format` / `media_type`）

推理引擎（api_v2 的 `/tts`）的 `media_type` **白名单只有 `wav` / `raw` / `ogg` / `aac`**，
别的值会被引擎直接 `400 media_type: mp3 is not supported`。所以插件在这里收敛：
`wav`（默认）、`ogg`、`aac` 直接向引擎要；`mp3` / `flac`（以及 `mpeg` / `mp4` / `mpga`
这些别名）先要 `wav`，再用本机 `ffmpeg` 转码后返回（`PATH` → 引擎目录 → 安装根）。
找不到 `ffmpeg` 时返回 `400 missing_ffmpeg` 并说明改用 wav，不做静默降级——
否则用户拿到的是 `.mp3` 扩展名的 wav 文件。画布「SoVITS 语音」节点的「输出格式」
（wav / mp3）走的就是这条链。引擎自己的 400/500 响应体现在会被读出
（`{"message":…,"Exception":…}`）再转发，节点上不再是干巴巴的一句 `HTTP Error 400`。

## 语种（面板「语种」下拉菜单）

中文句子里突然冒出日语，根因不是模型：`text_lang="auto"` 时引擎会把每个分句交给
`fast_langdetect` 去**猜**语种，而中日共用汉字没有硬证据——实测约 1/4 的纯中文句会被
猜成 `ja` 并走 pyopenjtalk 音读。假名/谚文才是日韩独有证据，所以插件默认**根本不让引擎猜**。

面板「测试合成 → 语种」选择的是**策略**，插件再翻译成引擎语言码；策略存在
`<安装目录>/language.json`（缺失即内置默认），对**所有**调用方生效：面板、画布节点、
`/v1/audio/speech`、自建脚本。

| 策略值 | 面板文案 | 发给引擎 | 说明 |
|---|---|---|---|
| `zh_only` | 仅中文（默认） | `all_zh` / `zh` | **内置默认**。含拉丁字母走 `zh`；出现假名/谚文直接 `400 lang_denied`，宁可不发声 |
| `zh_mix` | 中文 + 英文 | `zh` | 英文词按英文读，其余中文 |
| `auto_char` | 自动（按字符构成判定） | `all_zh`/`all_ja`/`ja`/`en`… | 按字符构成判定，仍不调用语种识别器 |
| `all_zh` | 纯中文 all_zh | `all_zh` | 整段强制中文 G2P，英文也当中文读 |
| `ja` / `en` / `ko` / `yue` | 日文/英文/韩文/粤语 | `all_*`（含拉丁则 `ja`/`ko`/`yue`） | 整段按该语种读 |
| `engine_auto` | 引擎多语种混合（不推荐） | `auto` | 交给识别器猜，会重现"突然说日语" |

**锁定**（默认开）：勾上时请求里带的 `text_lang` / `?lang=` / `X-Text-Lang` 一律忽略，
全按面板策略读——这就是「仅允许说中文」。取消锁定后，显式指定的语种才会生效。

```bash
curl http://127.0.0.1:8770/api/languages                        # 面板数据源：9 个策略 + 当前策略（免鉴权）
curl -X POST http://127.0.0.1:8770/api/lang/policy \
  -H "Authorization: Bearer $TTS_API_KEY" -H "Content-Type: application/json" \
  -d '{"mode":"auto_char","lock":false}'                        # mode 也接受"仅中文/中英混合/日文"等写法
```

被语种策略拒绝时返回 `400`，响应头 `X-TTS-Lang-Error: lang_denied`，`detail` 是中文提示。
合成成功时响应头带 `X-TTS-Lang`（实际语言码）与 `X-TTS-Lang-Mode`（策略值）。

例外：**纯汉字写成的日文**（如标题「明日、病院。」）会被读成中文——这是不猜语种的代价，
此时在面板选「日文」，或请求里显式带 `text_lang="all_ja"`（需先取消锁定）。

另有引擎侧「共用汉字守卫」补丁（启动时自动写入 `engine/GPT_SoVITS/TTS_infer_pack/TextPreprocessor.py`）：
任何被判 `ja/ko` 却一个假名/谚文都没有的分句按主导字符改判回中文，所以旧前端、WebUI 直接发
`auto` 也不会误判。`GET /api/status` 的 `language.cjkLangGuard` 可查是否已装上。

## 音频训练（GPT-SoVITS 微调）

数据要求（参考 GPT-SoVITS）：建议 **3–10 分钟**单人干净音频（可分多段，≥30 秒亦可）；文字标注**可选**——不提供将自动 ASR，提供（.txt 每行对应一个音频文件）更准更快。

```bash
# 新建项目
curl -X POST http://127.0.0.1:8770/api/projects \
  -H "Authorization: Bearer $TTS_API_KEY" -H "Content-Type: application/json" \
  -d '{"name":"我的音色"}'

# 上传数据（multipart：files=音频可多个，text_file=可选 .txt）
curl -X POST http://127.0.0.1:8770/api/projects/我的音色/upload \
  -H "Authorization: Bearer $TTS_API_KEY" \
  -F "files=@a.wav" -F "files=@b.wav" -F "text_file=@transcript.txt"

# 看有哪些已训好的模型 / 已整理数据（决定能选哪种方式）
curl http://127.0.0.1:8770/api/projects/我的音色/model \
  -H "Authorization: Bearer $TTS_API_KEY"
# -> {"hasModel":true,"s1":{"epochsDone":31,"how":"lightning",...},
#     "s2":{"epochsDone":120,...},"dataset":{"clips":25,"prepared":true,...},
#     "defaults":{"fresh":{"s1":10,"s2":40},"continue":{"s1":10,"s2":10}},
#     "epochGuidance":{"perMinute":15.0,"safeFloor":40},
#     "audioQuality":{"clips":25,"minSr":16000,"rolloffKhz":2.66,"note":"…"}}

# 开始训练（进度：GET /api/projects/我的音色/status，含 pct / phaseLabel / epoch / loss / logTail）
curl -X POST http://127.0.0.1:8770/api/projects/我的音色/train \
  -H "Authorization: Bearer $TTS_API_KEY" -H "Content-Type: application/json" \
  -d '{"mode":"continue","reuseData":true,"s1Epochs":10,"s2Epochs":10}'
curl http://127.0.0.1:8770/api/projects/我的音色/status -H "Authorization: Bearer $TTS_API_KEY"

# 取消
curl -X POST http://127.0.0.1:8770/api/projects/我的音色/cancel \
  -H "Authorization: Bearer $TTS_API_KEY"
```

### 训练方式：重新训练 / 继续迭代（body 全部可省略，省略=auto）

| 参数 | 取值 | 说明 |
| --- | --- | --- |
| `mode` | `auto` / `fresh`(`retrain`,`重新训练`) / `continue`(`resume`,`继续迭代`) | `auto`：已有模型就继续迭代，没有就全新训练 |
| `reuseData` | 默认 `true` | 已整理过的音频/文字/特征**不再重复处理**（跳过格式转换、静音切分、ASR、BERT/HuBERT/语义 token） |
| `s1Epochs` / `s2Epochs` | 1–2000 | `fresh` 时是**总轮数**（默认 **10 / 40**）；`continue` 时是**追加轮数**（默认 10 / 10）。默认值就是"够用且不练过头"的量级，见下面「电流音」一节 |

`POST /train` 的返回里带 `plan`，写明本次实际会做什么（`{"mode":"continue","s1":{"base":30,"extra":10,"total":40},...}`），
脚本可据此确认而不是猜。

复用判定按**内容指纹**（上传音频的 sha256 + 文字标注 + 分段名/大小），写在
`engine/data/<项目>/<项目>/.mtnode-prep.json`：

- 指纹一致 → 整段数据处理直接跳过；
- 新增/替换了音频 → 只重做**内容变了的那几段**的 BERT/HuBERT 特征（`_prune_stale_features`），
  语义 token 表因为必须整表重建才会全量重算；
- 勾选「不复用」或指纹对不上 → 才会清空 `3-bert / 4-cnhubert / 5-wav32k / 2-name2text* / 6-name2semantic*`
  并重新切分。

两种方式的差别只在模型层：

- **继续迭代**：保留 `logs_s1/ckpt`、`logs_s2_v*/G_*.pth`，引擎自己 resume（`train.epochs` 是总数，
  所以已完成 10 轮 + 追加 10 轮 = 写 `epochs: 20`）；若断点已被删只剩导出权重，则用 `pretrained_s1/s2G`
  指向最强权重，轮数从第 1 轮重新计（这时 `s1Epochs` 就是实际要练的轮数）。
- **重新训练**：删掉 `logs_s1 / logs_s2_v1 / logs_s2_v2`，从官方预训练底模重来（**不动**已整理数据）。

### 试听训练中的中间模型（面板「测试合成」）

s1/s2 每练完一轮，引擎就会往权重目录多导出一份**推理格式**权重
（`GPT_weights_v2/<项目>-eN.ckpt` + `SoVITS_weights_v2/<项目>_eN_sM.pth`）。后端只按这两个
导出文件名识别中间模型（Lightning 断点 `last.ckpt`、`epoch=12-step=…ckpt`、`G_*.pth` 一律不认，
那些格式 `TTS.init_t2s_weights` 读不进去），于是训练进行时，面板「测试合成」的音色下拉里会出现一条：

```
⏳ 训练中 · <项目名> · GPT e30/30 · SoVITS e94/100 · 刚刚更新
```

选中它点「合成」即可试听；**每练完一轮，这条自动换成最新一轮**，再点一次就是新版。
勾「固定轮次」会把该条目锁成 `live:<项目>@gN_sM`，之后训练推进也不跳，方便反复对比同一版。

| 接口 | 说明 |
| --- | --- |
| `GET /api/live-models` | 中间模型列表（同一份形状也直接是音色形状，可当 voice 用） |
| `GET /api/status` → `liveVoices` | 面板每 2.5–5 秒轮询这一个口就能同步下拉框 |
| `GET /api/projects/<slug>/live?gpt=&s2=` | 单个项目快照；带 `gpt`/`s2` 即固定轮次 |
| `POST /api/tts` `{"voice":"live:<slug>"}` | 试听当前最新一轮；`live:<slug>@g30_s100` 试听指定轮次 |

响应头 `X-TTS-Weights: <gpt文件> + <sovits文件>`、`X-TTS-Live: <项目>|GPT eN|SoVITS eM|latest|pinned`
（面板「运行日志」也会记同一句，确保听到的是第几轮可核对）。

规则细节：训练进行中**只采信本次训练导出的文件**（按开始时间过滤，绝不拿上一次训练残留的
更高轮数冒充新进度）；刚写完 2 秒内、小于 2 MB 的文件不采信（`my_save` 是临时文件→`os.replace`，
避免读到半截）；SoVITS 还没导出时返回 400 `live_model_unready` 并说明"练到第 8 步第 1 轮即可试听"；
若本后端不知道训练何时开始（后端重启过/训练由别的进程起的），按"最近 3 分钟仍在导权重"推断
训练中，并改按**最后写入时间**认定最新一轮。语种门禁（默认仅中文）对中间模型同样生效。
`live:` 音色不写入 `voices/`，训练注册出正式音色后，列表自动不再重复列出同一份权重。

训练完成（ASR→HuBERT→语义→s1 GPT→s2 SoVITS）后，自动把该音色注册进 `voices/<项目名>/`（含训练权重），可直接用 `voice=<项目名>` 合成，如：

```bash
curl -X POST http://127.0.0.1:8770/v1/audio/speech \
  -H "Authorization: Bearer $TTS_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"gpt-sovits","input":"你好，欢迎使用MTNode AI编排器！","voice":"我的音色","response_format":"wav"}' \
  -o preview.wav
```

## 「训练完有电流音」：查到的真凶与两处体检

SoVITS 底模是 **32 kHz** 模型（`s2G488k.pth`，`5-wav32k` 就是它的训练目标采样率）。
早期版本插件在整理音频时把采样率写死成 16 kHz，等于把要模型"还原"的高频先删干净：

| 同一份 44.1 kHz 源，转换参数 | 8–16 kHz 能量占比 |
| --- | --- |
| 旧 `-ar 16000` | 0.07 % – 0.28 % |
| 新 `-ar 32000` | **2.0 % – 6.5 %**（多 20–50 倍） |

实测某 25 段 / 2.6 分钟的中文语料：转换后 `>16 kHz` 能量 **0.0000 %**、99 % 能量截止
**约 2.7 kHz**——8 kHz 以上是纯空的，模型却被要求输出 32 kHz，那段只能凭空生成，
听感就是电流音 / 毛刺 / 发沙。所以现在：

- `_convert_to_wav(src, dst, sr=TARGET_SR)`：转换按 32 kHz（`TARGET_SR`），不再降采样；
- `_segment_audio_files()` 里 `librosa.load(..., sr=TARGET_SR)`，切分也不再掉回 16 kHz；
- `PREP_VER` 升到 `"3"`：以前整理出来的 16 kHz 产物**自动作废重做**，不用手动删；
- 源音频本身就只有 16 kHz（转录音频、短视频提取的音轨）时，插件无能为力——只能换素材，
  这种情况会明确告诉你，而不是闷头练。

两处体检（**只提示，绝不拦训练**）：

1. `audio_bandwidth_audit(clips)` → 采样的采样率 / `lowSr` / 99 % 能量截止 kHz / `note`。
   截止 < 7 kHz 或存在低于 32 kHz 的分段就出话。训练时写进日志与 manifest
   （`m["audioQuality"]`），面板经 `GET /api/projects/<slug>/model` → `audioQuality` 显示在
   训练卡片的橙色提示行（`#trainWarn`）。
2. `_buzz_risk(total_sec, s2_total)` → 按语料长度估轮数上限：
   `cap = max(40, 分钟数 × 15)`，`s2` 总轮数超过才提示。默认 10 / 40 落在 `cap` 内，
   所以正常用不会被打扰；2.6 分钟语料练到 120 轮就会提示"降到 40 轮以内，或用中间模型
   挑一版不发虚的"。经验值由 `epochGuidance` 下发，前后端共用一份，不各写一遍。

同一份语料练到不同轮数实测（GPT e31 固定，6 句平均）：e16 / e40 的有声帧 8–16 kHz 能量
0.041 % / 0.038 %（相对语音段 −33.9 / −34.2 dB），e120 的 4–8 kHz 与 8–16 kHz 能量比从
约 8 涨到 29 —— 高频不再是噪声而是窄带尖峰，就是"金属味"。**所以轮数不是主因，是放大器**；
真正的修法是把语料带宽保住（上面那条），其次才是别把小语料练到上百轮。

排查顺序建议：训练卡片看 `audioQuality.note` → 换 32 kHz 以上素材、选「重新训练」并取消
「复用已整理音频」→ 轮数按默认的 10 / 40 起 → 中途用 `live:` 中间模型逐轮试听，
听到最好那轮就把总轮数定在那里。调 `sample_steps` 对 v2 权重无效（见上一节）。
