"""Breeze TTS 2 本地管理服务的公共配置与路径口径。

目录（全部落在插件的**安装目录**，用户自己选的普通文件夹）：
    engine/                       breeze-tts 推理源码（安装时克隆）
    .venv/                        隔离虚拟环境
    checkpoints/breeze-tts-2/     Breeze TTS 2 权重
    voices/<音色id>/{ref.wav,ref.txt}   参考片段音色库
    tools/ffmpeg/ffmpeg.exe       便携 ffmpeg（mp3 用，缺失不影响 wav/flac）
    logs/manager.log              管理服务日志
    out/                          控制台试听产物

数据纪律：用户数据只写这里或 %APPDATA%，**绝不写应用目录**。
"""
from __future__ import annotations

import json
import os
import secrets
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

ENGINE_DIR = ROOT / "engine"
VENV_DIR = ROOT / ".venv"
CKPT_DIR = ROOT / "checkpoints" / "breeze-tts-2"
VOICES_DIR = ROOT / "voices"
TOOLS_DIR = ROOT / "tools"
LOGS_DIR = ROOT / "logs"
OUT_DIR = ROOT / "out"
CONFIG_PATH = ROOT / "manager.json"
APIKEY_PATH = ROOT / "api-key.txt"
PID_PATH = ROOT / "engine-pid.json"
LOCAL_WEIGHTS_HINT = CKPT_DIR / "USE_LOCAL_WEIGHTS.txt"

DEFAULT_API_PORT = 8772
DEFAULT_ENGINE_PORT = 8773
ENGINE_MODULE = "breeze_infer.api"

# 权重的许可：代码 Apache-2.0，权重与自托管输出仅限研究 / 非商用
LICENSE_NOTE_ZH = (
    "推理代码为 Apache-2.0；模型权重、衍生模型与自托管输出受 BreezeBlue Research and "
    "Non-Commercial License 约束，仅限研究与**非商用**用途（Apache-2.0 不授予商用权）。"
)
LICENSE_NOTE_EN = (
    "Inference code is Apache-2.0. Model weights, derivative models and self-hosted outputs are "
    "for research and NON-COMMERCIAL use only under the BreezeBlue Research and Non-Commercial License."
)


def ensure_dirs() -> None:
    for d in (ENGINE_DIR, VOICES_DIR, TOOLS_DIR, LOGS_DIR, OUT_DIR, CKPT_DIR):
        d.mkdir(parents=True, exist_ok=True)


def load_config() -> dict:
    try:
        return json.loads(CONFIG_PATH.read_text("utf-8"))
    except Exception:
        return {}


def save_config(patch: dict) -> dict:
    cfg = load_config()
    cfg.update(patch or {})
    tmp = CONFIG_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), "utf-8")
    os.replace(tmp, CONFIG_PATH)
    return cfg


def load_api_key() -> str:
    """管理服务的 API Key：首次启动生成并落盘（与 tts-local 同一套口径）。"""
    try:
        key = APIKEY_PATH.read_text("utf-8").strip()
        if key:
            return key
    except Exception:
        pass
    key = "breeze-" + secrets.token_hex(20)
    try:
        APIKEY_PATH.write_text(key, "utf-8")
    except Exception:
        pass
    return key


def ffmpeg_exe() -> str | None:
    """便携 ffmpeg 优先，其次系统 PATH。没有就返回 None（mp3 会给出明确提示）。"""
    import shutil

    local = TOOLS_DIR / "ffmpeg" / "ffmpeg.exe"
    if local.is_file():
        return str(local)
    return shutil.which("ffmpeg")


def weights_dir() -> Path:
    """实际使用的权重目录：USE_LOCAL_WEIGHTS.txt 里有手填目录就用它。"""
    try:
        hint = LOCAL_WEIGHTS_HINT.read_text("utf-8").strip()
        if hint and Path(hint).is_dir():
            return Path(hint)
    except Exception:
        pass
    return CKPT_DIR


def weights_ready() -> bool:
    d = weights_dir()
    if not d.is_dir():
        return False
    has_cfg = (d / "config.json").is_file() or any(d.glob("config.json"))
    has_w = any(d.rglob("*.safetensors")) or any(d.rglob("*.pt")) or any(d.rglob("*.bin"))
    return bool(has_cfg and has_w)


def engine_ready() -> bool:
    return (ENGINE_DIR / "infer.py").is_file()


def venv_python() -> Path:
    if os.name == "nt":
        return VENV_DIR / "Scripts" / "python.exe"
    return VENV_DIR / "bin" / "python"


def temp_root() -> Path:
    """跨平台临时区（**不落应用目录**）：上传的参考音频、mp3 转码中间件都放这里。"""
    p = Path(tempfile.gettempdir()) / ("breeze-tts-" + str(os.getpid()))
    p.mkdir(parents=True, exist_ok=True)
    return p


def engine_pythonpath() -> str:
    """让 engine 里的 breeze_infer / models 可被 import。"""
    return str(ENGINE_DIR)


def log(msg: str) -> None:
    line = str(msg)
    print(line, flush=True)
    try:
        LOGS_DIR.mkdir(parents=True, exist_ok=True)
        with (LOGS_DIR / "manager.log").open("a", encoding="utf-8") as fh:
            fh.write(line.rstrip("\n") + "\n")
    except Exception:
        pass


def python_version_ok() -> bool:
    return sys.version_info >= (3, 10)
