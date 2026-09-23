"""音频处理：定位 ffmpeg、统一转 16kHz 单声道 wav、读回波形。

设计要点：
- ffmpeg 是**唯一**的解码入口（wav / mp3 / flac / m4a / ogg / aac 全覆盖），
  没有 ffmpeg 就不再自己用其它库硬解 —— 上层需要的是明确错误 `no_ffmpeg`。
- 临时文件统一放系统临时目录，用完即删，不往安装目录里丢垃圾。
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import wave
from pathlib import Path

# 统一的目标格式：16 kHz 单声道（Qwen3-ASR 与 fsmn-vad 都按这个采样率）
TARGET_SR = 16000

# 支持的后缀（只作提示用，真正能不能解由 ffmpeg 决定）
SUPPORTED_EXTS = (".wav", ".mp3", ".flac", ".m4a", ".ogg", ".oga", ".opus", ".aac", ".wma", ".mp4", ".mkv", ".webm")

# 安装目录：asr-pack/app/audio.py -> asr-pack/
_ROOT = Path(__file__).resolve().parent.parent


class AudioError(Exception):
    """音频类错误：带短码，服务层直接把它转成 {"ok":false,"error":短码}。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _env_path(name: str) -> str:
    return (os.environ.get(name) or "").strip()


def resolve_ffmpeg() -> str:
    """按优先级定位 ffmpeg.exe，找不到返回空字符串。

    1. 环境变量 ASR_FFMPEG（上层显式指定的绝对路径）
    2. <INSTALL_DIR>\\ffmpeg\\bin\\ffmpeg.exe（安装时下的便携版）
    3. PATH 里的 ffmpeg
    """
    env = _env_path("ASR_FFMPEG")
    if env and Path(env).is_file():
        return str(Path(env).resolve())
    for rel in (Path("ffmpeg") / "bin" / "ffmpeg.exe", Path("ffmpeg") / "ffmpeg.exe"):
        cand = _ROOT / rel
        if cand.is_file():
            return str(cand)
    found = shutil.which("ffmpeg")
    return str(Path(found).resolve()) if found else ""


def require_ffmpeg() -> str:
    """拿 ffmpeg，拿不到抛 no_ffmpeg（中文可读原因）。"""
    path = resolve_ffmpeg()
    if not path:
        raise AudioError(
            "no_ffmpeg",
            "未找到 ffmpeg：请设置 ASR_FFMPEG 环境变量，或把便携版放到 <INSTALL_DIR>\\ffmpeg\\bin\\ffmpeg.exe，"
            "或把 ffmpeg 加入系统 PATH（wav / mp3 / flac / m4a / ogg / aac 解码都依赖它）。",
        )
    return path


def probe_duration_sec(path: str) -> float:
    """用 ffprobe（与 ffmpeg 同目录）取时长，取不到返回 0.0。仅用于回填 duration_sec 与日志。"""
    ffmpeg = resolve_ffmpeg()
    if not ffmpeg:
        return 0.0
    ffprobe = Path(ffmpeg).with_name("ffprobe.exe" if os.name == "nt" else "ffprobe")
    exe = str(ffprobe) if ffprobe.is_file() else shutil.which("ffprobe")
    if not exe:
        return 0.0
    try:
        out = subprocess.run(
            [exe, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)],
            capture_output=True,
            text=True,
            timeout=60,
        )
        if out.returncode == 0:
            return max(0.0, float((out.stdout or "0").strip() or 0.0))
    except Exception:
        pass
    try:
        with wave.open(str(path), "rb") as w:
            return w.getnframes() / float(w.getframerate() or TARGET_SR)
    except Exception:
        return 0.0


def to_wav16k_mono(src: str) -> str:
    """把任意来源音频转成 16kHz 单声道 wav，返回临时文件绝对路径（调用方负责删除）。

    已经是 16kHz 单声道 wav 时也会重新走一遍 ffmpeg —— 免得信任一个「看起来对」但
    实际是 8kHz/立体声的文件；ffmpeg 极快，这点代价换来统一不变的输入格式。
    """
    ffmpeg = require_ffmpeg()
    src_path = Path(str(src))
    if not src_path.is_file():
        raise AudioError("audio_missing", f"音频文件不存在：{src_path}")

    fd, tmp = tempfile.mkstemp(prefix="mtnode-asr-", suffix=".wav")
    os.close(fd)
    try:
        proc = subprocess.run(
            [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(src_path),
             "-vn", "-ac", "1", "-ar", str(TARGET_SR), "-f", "wav", tmp],
            capture_output=True,
            text=True,
            timeout=1800,
        )
        if proc.returncode != 0 or not Path(tmp).is_file() or Path(tmp).stat().st_size <= 44:
            msg = (proc.stderr or proc.stdout or "").strip().splitlines()
            tail = msg[-1] if msg else "ffmpeg 未给出原因"
            try:
                os.remove(tmp)
            except Exception:
                pass
            raise AudioError("decode_failed", f"ffmpeg 解码失败（{src_path.suffix or '未知格式'}）：{tail}")
    except AudioError:
        raise
    except Exception as e:  # 超时 / 权限 / ffmpeg 进程起不来
        try:
            os.remove(tmp)
        except Exception:
            pass
        raise AudioError("decode_failed", f"ffmpeg 调用异常：{str(e)[:300]}") from e
    return tmp


def read_wav_mono16k(path: str):
    """把 16kHz 单声道 wav 读成 float32 numpy 波形（-1.0 ~ 1.0）。"""
    import numpy as np

    try:
        with wave.open(str(path), "rb") as w:
            ch = w.getnchannels()
            width = w.getsampwidth()
            sr = w.getframerate()
            frames = w.readframes(w.getnframes())
    except Exception as e:
        raise AudioError("decode_failed", f"读取 wav 失败：{str(e)[:200]}") from e

    if not frames:
        return np.zeros(0, dtype="float32")
    if width == 2:
        data = np.frombuffer(frames, dtype="<i2").astype("float32") / 32768.0
    elif width == 4:
        data = np.frombuffer(frames, dtype="<i4").astype("float32") / 2147483648.0
    elif width == 1:
        data = (np.frombuffer(frames, dtype="<u1").astype("float32") - 128.0) / 128.0
    else:
        raise AudioError("decode_failed", f"不支持的 wav 位宽：{width * 8} bit")
    if ch > 1:
        data = data.reshape(-1, ch).mean(axis=1).astype("float32")
    if sr != TARGET_SR and sr > 0:
        # 转换阶段已经统一成 16k，这里只是兜底（例如手工塞进来的 wav）
        import numpy as np  # noqa: F401

        idx = (np.arange(int(len(data) * TARGET_SR / sr)) * sr / TARGET_SR).astype("int64")
        idx = idx[idx < len(data)]
        data = data[idx]
    return np.ascontiguousarray(data, dtype="float32")


def cleanup(*paths: str) -> None:
    """删除临时文件，静默失败（清理不该影响转写结果）。"""
    for p in paths:
        if not p:
            continue
        try:
            os.remove(p)
        except Exception:
            pass
