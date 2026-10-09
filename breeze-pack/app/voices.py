"""参考片段音色库：voices/<id>/{ref.wav, ref.txt}。

与 tts-local（GPT-SoVITS）同形态、**不共用目录**：Breeze TTS 2 没有训练概念，
一个「音色」就是一段干净的参考音频 + 它的准确文稿（官方 Voice Clone 口径）。
"""
from __future__ import annotations

import re
import unicodedata
from pathlib import Path

from . import config

ALLOWED_AUDIO_EXT = {".wav", ".flac", ".mp3", ".m4a", ".ogg", ".opus", ".aac"}
_ID_BAD = re.compile(r"[\\/:*?\"<>|\x00-\x1f]")


class VoiceError(Exception):
    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code = code
        self.message = message or code


def sanitize_id(raw: str) -> str:
    """音色 id 必须是安全目录名：去非法字符、限长、不许留空与点开头。"""
    s = unicodedata.normalize("NFC", str(raw or "")).strip()
    s = _ID_BAD.sub("_", s)
    s = re.sub(r"\s+", " ", s).strip(" .")
    if not s:
        raise VoiceError("voice_id_required", "音色名不能为空")
    if len(s) > 64:
        s = s[:64].rstrip(" .")
    if s in {".", ".."}:
        raise VoiceError("voice_id_invalid", "音色名不合法")
    return s


def voices_root() -> Path:
    config.VOICES_DIR.mkdir(parents=True, exist_ok=True)
    return config.VOICES_DIR


def voice_dir(voice_id: str) -> Path:
    return voices_root() / sanitize_id(voice_id)


def read_ref_text(d: Path) -> str:
    try:
        return (d / "ref.txt").read_text("utf-8").strip()
    except Exception:
        return ""


def read_ref_audio(d: Path) -> Path | None:
    for name in ("ref.wav", "ref.flac", "ref.mp3", "ref.m4a", "ref.ogg", "ref.opus", "ref.aac"):
        p = d / name
        if p.is_file():
            return p
    return None


def voice_entry(d: Path) -> dict | None:
    if not d.is_dir():
        return None
    audio = read_ref_audio(d)
    text = read_ref_text(d)
    created = None
    try:
        created = int(d.stat().st_mtime * 1000)
    except Exception:
        created = None
    return {
        "id": d.name,
        "name": d.name,
        "audio": str(audio) if audio else "",
        "hasAudio": bool(audio),
        "text": text,
        "hasText": bool(text),
        "ready": bool(audio and text),
        "createdAt": created,
    }


def list_voices() -> list[dict]:
    out: list[dict] = []
    for d in sorted(voices_root().iterdir() if voices_root().is_dir() else []):
        if not d.is_dir():
            continue
        e = voice_entry(d)
        if e:
            out.append(e)
    return out


def get_voice(voice_id: str) -> dict | None:
    return voice_entry(voice_dir(voice_id))


def save_voice(voice_id: str, audio_bytes: bytes | None, filename: str, ref_text: str) -> dict:
    """新增 / 覆盖一个音色。audio_bytes 为空表示只更新文稿。"""
    vid = sanitize_id(voice_id)
    text = str(ref_text or "").strip()
    d = voice_dir(vid)
    d.mkdir(parents=True, exist_ok=True)
    if audio_bytes:
        ext = Path(str(filename or "ref.wav")).suffix.lower()
        if ext not in ALLOWED_AUDIO_EXT:
            ext = ".wav"
        # 参考音频统一存 ref.<ext>，换格式时清掉旧的
        for old in d.iterdir():
            if old.is_file() and old.stem == "ref" and old.suffix.lower() in ALLOWED_AUDIO_EXT:
                if old.suffix.lower() != ext:
                    try:
                        old.unlink()
                    except Exception:
                        pass
        # 引擎只能可靠吃 wav / flac / mp3 这类；原样落盘，转换交给引擎侧
        (d / ("ref" + ext)).write_bytes(audio_bytes)
    if text:
        (d / "ref.txt").write_text(text, "utf-8")
    entry = voice_entry(d)
    if not entry or not entry["hasAudio"]:
        raise VoiceError("voice_audio_required", "音色缺少参考音频")
    return entry


def delete_voice(voice_id: str) -> bool:
    d = voice_dir(voice_id)
    if not d.is_dir():
        return False
    removed = False
    for f in list(d.iterdir()):
        try:
            if f.is_file():
                f.unlink()
                removed = True
        except Exception:
            pass
    try:
        d.rmdir()
        removed = True
    except Exception:
        pass
    return removed


def rename_voice(voice_id: str, new_id: str) -> dict:
    src = voice_dir(voice_id)
    if not src.is_dir():
        raise VoiceError("voice_not_found", "音色不存在")
    dst = voice_dir(new_id)
    if dst.exists():
        raise VoiceError("voice_exists", "同名音色已存在")
    src.rename(dst)
    e = voice_entry(dst)
    if not e:
        raise VoiceError("voice_not_found", "音色不存在")
    return e
