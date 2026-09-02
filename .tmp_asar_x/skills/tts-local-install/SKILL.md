---
name: tts-local-install
title: GPT-SoVITS 本地 TTS 安装
description: 在用户指定目录安装 GPT-SoVITS 本地 TTS 后端：创建 venv、安装 Python 依赖（含 torch 训练依赖）、克隆 GPT-SoVITS、下载预训练权重（GPT/SoVITS + 中文 BERT/HuBERT）、建立 OpenAI 兼容管理服务契约（音色库 voices/ + 训练项目 projects/ + API Key 鉴权）、冒烟验证。含自我修复指引。
---

# GPT-SoVITS 本地 TTS 插件 — 安装 / 修复

当用户或 MTNode 插件要求在某目录安装 / **自我修复** **GPT-SoVITS 本地 TTS 管理后端** 时使用本 skill。

插件调用时：

- **当前工作区就是 `INSTALL_DIR`**，可直接读写并执行命令
- **`SCAFFOLD_REF`（或 `.scaffold-ref`）仅作参考**：内置脚手架/脚本是示例实现，不是已完成的安装。请按下方目标自行准备目录；可按需从参考路径复制或改写，也可等价实现
- 不要假设插件已替你复制好脚手架
- 若任务附带 **CONSOLE_LOG**（插件 console 最近日志），优先根据日志定位并修复，不要盲目重装全部模型

## 目标

在 `INSTALL_DIR` 建立可运行的 GPT-SoVITS TTS 管理服务（FastAPI 管理 + GPT-SoVITS api_v2 推理），供 MTNode 插件启停。

完成后应满足：

- `INSTALL_DIR\.venv\Scripts\python.exe` 存在且 `import fastapi; from app import server, tts` 成功
- `INSTALL_DIR\engine\api_v2.py` 存在（GPT-SoVITS 官方仓库克隆）
- `INSTALL_DIR\engine\GPT_SoVITS\pretrained_models\` 下有 GPT 权重（`s1bert25hz-2kh-longer-epoch=68e-step=50232.ckpt` 或 v2 `s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt`）与 SoVITS 权重（`s2G233k.pth` 或 `s2G488k.pth`），以及 `chinese-hubert-base`、`chinese-roberta-wwm-ext-large`
- `INSTALL_DIR\voices\` 目录存在（音色库）
- `INSTALL_DIR\projects\` 目录存在（微调训练项目库）
- `INSTALL_DIR\.api-key` 存在（管理服务 API Key，插件与调用方以 `Authorization: Bearer <key>` 鉴权）
- **不要**启动 `python -m app` 或 `api_v2.py` 推理进程（启停由插件负责）

## 目录约定

- `INSTALL_DIR/app/` — Python 管理服务（`python -m app <port>`；含 server.py / tts.py / train.py / gpu.py / __main__.py）
- `INSTALL_DIR/.venv/` — 虚拟环境
- `INSTALL_DIR/engine/` — GPT-SoVITS 源码克隆
- `INSTALL_DIR/engine/GPT_SoVITS/pretrained_models/` — 预训练权重
- `INSTALL_DIR/voices/` — 音色库（每音色一子目录：`ref.wav` + `ref.txt` 提示文本 + `ref.lang` 语言；训练完成的音色带 `weights.json`）
- `INSTALL_DIR/projects/` — 训练项目（每项目一子目录：`audio/` 上传音频、`text/` 文字标注、`logs/train.log` 训练日志、`manifest.json` 记录）
- `INSTALL_DIR/.api-key` — API Key 鉴权文件（服务启动时若无则自动生成；插件在服务未起时也读它作回退）
- `INSTALL_DIR/infer.json` / `INSTALL_DIR/language.json` — 服务端采样步数与语种策略（缺失即用内置默认，勿手工建）
- `INSTALL_DIR/requirements.txt` — 管理服务依赖（fastapi、uvicorn、httpx、pydantic、**python-multipart**、huggingface_hub、soundfile、numpy）
- `INSTALL_DIR/scripts/install.ps1` — 参考安装脚本（国内 pip 镜像 + 克隆 GPT-SoVITS + 下载权重 + 引擎训练依赖）
- `SCAFFOLD_REF` — 内置脚手架参考路径（可复制 app/scripts/requirements/manifest，含完整 API 实现）

## 国内镜像（必须）

> **中国大陆网络下，以下镜像必须使用**：HuggingFace 无法直连，Python 库必须走清华/中科院镜像。

- pip：**清华** `https://pypi.tuna.tsinghua.edu.cn/simple`（或**中科院 USTC** `https://mirrors.ustc.edu.cn/pypi/simple/`、阿里云 `https://mirrors.aliyun.com/pypi/simple/`）
- 模型权重：**优先 ModelScope(魔搭)** `lj1995/GPT-SoVITS`（可用环境变量 `TTS_MODELSCOPE_REPO` 覆盖）；失败再回退 `HF_ENDPOINT=https://hf-mirror.com`（建议 `HF_HUB_DISABLE_XET=1`）
- GitHub：克隆 GPT-SoVITS 直连失败时用 `ghproxy.com` 前缀镜像
- torch（训练依赖）：清华镜像只有 CPU 轮子，须走阿里云 PyTorch 镜像 `https://mirrors.aliyun.com/pytorch-wheels/cu126`（失败回退官方 `https://download.pytorch.org/whl/cu126`）
- 安装示例：
  ```powershell
  .venv\Scripts\python.exe -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple --trusted-host pypi.tuna.tsinghua.edu.cn
  ```

## 安装步骤（按序）

1. **准备工程文件**  
   若缺 `app/server.py` / `app/tts.py` / `app/train.py` / `app/__main__.py` / `scripts/install.ps1` / `requirements.txt` / `manifest.json`：从 `SCAFFOLD_REF` 复制或按参考自行生成。保留用户已有的 `.venv` / `engine` / `voices` / `projects`。

2. **探测 Python 3.10+**（优先 `py -3.10` 或 `python`）

3. **创建 venv 并安装管理服务依赖**（可参考 `SCAFFOLD_REF\scripts\install.ps1`）  
   ```powershell
   cd INSTALL_DIR
   powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -InstallDir INSTALL_DIR
   ```
   脚本会：
   - 创建 `.venv` 并用国内镜像安装 `requirements.txt`
   - `git clone --depth 1 https://github.com/RVC-Boss/GPT-SoVITS.git` 到 `engine/`（GitHub 失败则尝试 `ghproxy.com` 镜像）
   - **引擎训练依赖**：装 torch + torchaudio（CUDA cu126，见上镜像）；从引擎官方 `requirements.txt` 过滤掉 webui/asr/onnx 膨胀项（gradio、funasr、onnxruntime、fastapi[standard]、`--no-binary`），并**显式补回** `pandas` `matplotlib` `torch-einops-utils` `einx` `loguru` `onnxruntime`（CPU 版，g2pw 必需）`faster-whisper`（长音频 ASR 必需）
   - 权重下载：**优先 ModelScope(魔搭)** `lj1995/GPT-SoVITS`（可用 `TTS_MODELSCOPE_REPO` 覆盖），失败回退 `huggingface_hub`（hf-mirror）——GPT/SoVITS 权重与 `chinese-hubert-base`、`chinese-roberta-wwm-ext-large` 到 `engine/GPT_SoVITS/pretrained_models/`
   - 若 `INSTALL_DIR\.api-key` 不存在则生成一个随机 key（`python -c "import secrets; print(secrets.token_hex(16))"` 写入）

4. **冒烟测试**  
   ```powershell
   .\.venv\Scripts\python.exe -c "import fastapi; from app import server, tts; print('ok')"
   Test-Path .\engine\api_v2.py
   Test-Path .\.api-key
   ```

5. **（可选）放置示例音色**  
   在 `voices\示例音色\` 放置 `ref.wav` + `ref.txt`（该音频的转写文本）+ `ref.lang`（`zh`/`en`/`ja`/`auto`）。音色越多越好用；无音色时合成会报 `no_voice`。

6. **标记完成**  
   - 创建空文件 `INSTALL_DIR\.install-ok`
   - 写入 `INSTALL_DIR\.tts-agent-result` 首行 `ok=true`
   - **不要**启动管理服务或 api_v2 推理进程

## 管理服务 API 契约（插件依赖，实现 app/ 时勿缺）

以 `SCAFFOLD_REF` 的 `app/` 为权威实现；若自行生成需覆盖以下契约，否则插件面板/画布节点/训练功能不可用：

- **端口**：管理 `8770`（env `TTS_API_PORT`），GPT-SoVITS 推理 `9880`（env `TTS_SOVITS_PORT`）。回环端口访问须**绕过系统代理**（`ProxyHandler({})`）；挂着 Clash/v2rayN 时代理会把发往 127.0.0.1 的请求回成空 body 503，表现成"引擎没起来/合成失败"
- **鉴权**：`.api-key` 内容作 Bearer token；除 `/api/health` 免鉴权外其余接口校验 `Authorization: Bearer`
- **端点**：
  - `GET /api/health` → `{"ok": true}`（插件存活探测）
  - `GET /api/status` → `{"apiKey","apiBase","voices":[{id,name}...],"liveVoices":[...],"language":{...}}`（插件同步提供商与音色）
  - `POST /v1/audio/speech`（OpenAI 兼容：`model:"gpt-sovits"`、`input`、`voice`、`response_format:"wav"`、`speed`）→ 返回 WAV 二进制
  - `POST /api/shutdown`（插件停止时调用，优雅退出）
  - `GET /api/voices`、`POST /api/voices/add`（multipart：`file`=wav、`name`、`prompt_text`、`lang`）
  - `GET/POST /api/infer`（采样步数，存 `infer.json`；默认 32，档位 4/8/16/32/64/128）
  - `GET /api/languages`、`POST /api/lang/policy`（语种策略，存 `language.json`；默认仅中文 `zh_only`，拒绝时 400 + 头 `X-TTS-Lang-Error: lang_denied`）
  - 训练项目：`GET/POST /api/projects`、`POST /api/projects/{slug}/upload`（multipart `files`+可选 `text_file`）、`POST .../train`（body `mode:auto|fresh|continue`、`reuseData`、`s1Epochs/s2Epochs`）、`GET .../model`、`GET .../status`（含 pct/phaseLabel/epoch/loss/logTail）、`POST .../cancel`、`GET .../files`、`GET .../audio/{filename}`
  - `GET /api/live-models`（训练中间模型试听，形状同音色）
- **引擎适配**：启动时若 `engine/GPT_SoVITS/TTS_infer_pack/TextPreprocessor.py` 缺少"共用汉字守卫"补丁（判 `ja/ko` 却无假名/谚文的分句改判回中文），按脚手架补丁写入（`GET /api/status` 的 `language.cjkLangGuard` 可查）

## 音色与训练项目

- `voices/<音色>/`：`ref.wav` + `ref.txt`（转写文本）+ `ref.lang`（`zh`/`en`/`ja`/`auto`）；训练完成的音色自动注册进该目录并带 `weights.json`（GPT/SoVITS 权重），可直接 `voice=<项目名>` 合成
- `projects/<项目>/`：`audio/` 上传音频、`text/` 文字标注（可选，缺省自动 ASR，.txt 每行对应一个音频）、`logs/train.log`、`manifest.json`
- 数据要求（参考 GPT-SoVITS）：建议 3–10 分钟单人干净音频（可分多段，≥30 秒亦可）；音频整理按 **32 kHz**（`TARGET_SR`）转换切分，勿降采样到 16 kHz（否则训练完有电流音/发沙）

## 自我修复模式（CONSOLE_LOG 已由插件提交给 dsh）

1. 以「最近失败焦点」为准判断根因；更早日志仅参考。
2. 常见修复：
   - 缺 `engine/api_v2.py` → 重跑 git clone（换镜像）；无 git 则安装 git 或改用下载 zip 解压
   - pip 失败 → 换国内镜像重装 requirements；api_v2 缺 torch → 用官方 GPT-SoVITS requirements 装 torch（CUDA 版本按 nvidia-smi 驱动匹配）
   - 权重缺失 → 重下到 `engine/GPT_SoVITS/pretrained_models/`（hf-mirror）；单个文件失败不影响整体，能跑即可
   - import 失败 → 检查 venv 与 `app/` 是否完整
   - 管理服务启动即退出 / `uvloop` 报错 → `pip uninstall -y uvloop`，并确保 `app/server.py` 使用 `loop="asyncio"`
   - 上传 500 / `request.form()` AssertionError → 缺 `python-multipart`（脚手架会自愈 pip 装进 `ROOT/.pylibs` 并注入 sys.path，须在 `from fastapi import ...` 之前生效）；确认 requirements.txt 含 `python-multipart>=0.0.9`
   - "引擎没起来/合成失败"、请求回空 body 503 → 系统代理劫持回环端口（Clash/v2rayN），后端须绕过代理；可重启插件服务验证
   - 训练中断在整理/特征阶段 → 检查 `faster-whisper`（ASR）、`onnxruntime`（g2pw）、`chinese-hubert-base`/`chinese-roberta-wwm-ext-large`（特征）是否装齐/在齐
3. 已下载权重勿删；仅修 venv / engine / 脚本。
4. 冒烟后写 `.install-ok` 与 `.tts-agent-result`；回复 `repair_ok=1`。
5. **不要启动** `python -m app` 或 `api_v2.py`。

## 约束

- 不要启动管理服务或推理进程（启停由插件负责）。
- 不要删除用户已有的 `engine/` 权重（除非损坏且任务明确要求重下）。
- 磁盘不足时先警告用户再继续（GPT-SoVITS 全套约 6–12GB，建议预留 ≥12GB）。

## 成功标准

- `INSTALL_DIR\.install-ok` 存在
- `.venv\Scripts\python.exe -c "from app import server"` 成功
- `engine\api_v2.py` 存在
- `.api-key` 存在
- 写入 `.tts-agent-result`（`ok=true`）；失败写 `ok=false` + `reason=`
- 回复：`install_ok=1`、`venv_ok=`、`engine_ok=`、`gpt_weights=`、`sovits_weights=`（若已下载）
