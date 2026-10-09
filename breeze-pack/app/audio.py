"""PCM 流 → 音频文件（wav / flac / mp3）与各类音频读取。

Breeze 官方 `/v1/audio/speech` 返回的是**流式单声道 24kHz s16le PCM**（媒体类型
audio/pcm，采样率在 X-Sample-Rate 响应头里），不是音频容器 —— 必须自己封装。
mp3 走 ffmpeg（安装时下过的便携版优先，其次系统 PATH），wav/flac 走 soundfile。
"""
from __future__ import annotations

import io
import subprocess

import numpy as np

from . import config

SAMPLE_RATE_DEFAULT = 24000
FORMATS = ("wav", "flac", "mp3")


class AudioError(Exception):
    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code = code
        self.message = message or code


def pcm16_to_float(data: bytes) -> np.ndarray:
    """s16le 小端 PCM → [-1,1] float32 单声道。"""
    if not data:
        return np.zeros(0, dtype=np.float32)
    a = np.frombuffer(data, dtype="<i2").astype(np.float32)
    return a / 32768.0


def float_to_pcm16(a: np.ndarray) -> bytes:
    x = np.clip(np.asarray(a, dtype=np.float32), -1.0, 1.0)
    return (x * 32767.0).astype("<i2").tobytes()


def write_audio(samples: np.ndarray, sample_rate: int, fmt: str) -> tuple[bytes, str]:
    """把单声道 float 波形写成指定格式的字节。返回 (bytes, mime)。"""
    import soundfile as sf

    f = str(fmt or "wav").strip().lower()
    if f in ("wav", "wave"):
        buf = io.BytesIO()
        sf.write(buf, samples, int(sample_rate or SAMPLE_RATE_DEFAULT), format="WAV", subtype="PCM_16")
        return buf.getvalue(), "audio/wav"
    if f == "flac":
        buf = io.BytesIO()
        sf.write(buf, samples, int(sample_rate or SAMPLE_RATE_DEFAULT), format="FLAC", subtype="PCM_16")
        return buf.getvalue(), "audio/flac"
    if f == "mp3":
        wav, _ = write_audio(samples, sample_rate, "wav")
        return _wav_to_mp3(wav), "audio/mpeg"
    raise AudioError("unsupported_format", f"不支持的输出格式：{fmt}（可选 {'/'.join(FORMATS)}）")


def _wav_to_mp3(wav_bytes: bytes) -> bytes:
    exe = config.ffmpeg_exe()
    if not exe:
        raise AudioError(
            "missing_ffmpeg",
            "本机缺少 ffmpeg，无法把音频转成 mp3（请改用 wav / flac 输出，或重新安装本插件后端）",
        )
    args = [
        exe,
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-f",
        "mp3",
        "-codec:a",
        "libmp3lame",
        "-b:a",
        "192k",
        "pipe:1",
    ]
    kwargs: dict = {}
    if hasattr(subprocess, "CREATE_NO_WINDOW"):
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    try:
        p = subprocess.run(args, input=wav_bytes, capture_output=True, timeout=300, **kwargs)
    except Exception as exc:  # noqa: BLE001
        raise AudioError("transcode_failed", f"ffmpeg 执行失败：{exc}") from exc
    if p.returncode != 0 or not p.stdout:
        detail = (p.stderr or b"").decode("utf-8", "replace").strip()[:400]
        raise AudioError("transcode_failed", f"音频转码失败（ffmpeg 退出码 {p.returncode}）：{detail}")
    return p.stdout


def read_audio_mono(path: str, target_rate: int | None = None) -> tuple[np.ndarray, int]:
    """读任意受支持音频为单声道 float32；必要时线性重采样。

    显存里的引擎按 wav 参考音频最稳，但用户手里的参考片段可能是 mp3 —— 顺手转一道。
    """
    import soundfile as sf

    try:
        data, rate = sf.read(str(path), dtype="float32", always_2d=True)
    except Exception as exc:  # noqa: BLE001
        raise AudioError("bad_ref_audio", f"参考音频无法读取（{path}）：{exc}") from exc
    mono = data.mean(axis=1) if data.shape[1] > 1 else data[:, 0]
    if target_rate and int(rate) != int(target_rate):
        mono = resample_linear(mono, int(rate), int(target_rate))
        rate = int(target_rate)
    return mono, int(rate)


def resample_linear(x: np.ndarray, src_rate: int, dst_rate: int) -> np.ndarray:
    if src_rate == dst_rate or x.size == 0:
        return x
    n_out = max(1, int(round(x.size * float(dst_rate) / float(src_rate))))
    idx = np.linspace(0.0, float(x.size - 1), num=n_out, dtype=np.float64)
    lo = np.floor(idx).astype(np.int64)
    hi = np.minimum(lo + 1, x.size - 1)
    frac = (idx - lo).astype(np.float32)
    return (x[lo] * (1.0 - frac) + x[hi] * frac).astype(np.float32)


def to_wav_bytes(samples: np.ndarray, sample_rate: int) -> bytes:
    data, _ = write_audio(samples, sample_rate, "wav")
    return data


def duration_s(samples: np.ndarray, sample_rate: int) -> float:
    if not sample_rate:
        return 0.0
    return float(len(samples)) / float(sample_rate)


def normalize_ref_audio(src_path: str, dst_wav: str, target_rate: int = SAMPLE_RATE_DEFAULT) -> dict:
    """把用户给的参考音频统一成 24kHz 单声道 wav（引擎最稳的输入）。"""
    import soundfile as sf

    mono, rate = read_audio_mono(src_path, target_rate=target_rate)
    sf.write(str(dst_wav), mono, int(rate), format="WAV", subtype="PCM_16")
    return {"path": str(dst_wav), "sampleRate": int(rate), "durationSec": duration_s(mono, int(rate))}
