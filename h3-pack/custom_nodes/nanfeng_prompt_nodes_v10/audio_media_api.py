"""Portable audio waveform/file routes for NanFeng H3 V10."""
from __future__ import annotations

import json
import mimetypes
import urllib.parse
from pathlib import Path

import numpy as np

ROUTE_PREFIX = "/nanfeng/v10/h3/audio-media"


def _input_root() -> Path:
    try:
        import folder_paths
        return Path(folder_paths.get_input_directory()).resolve()
    except Exception:
        return (Path(__file__).resolve().parents[2] / "input").resolve()


def _resolve_audio_path(value: str) -> Path:
    raw = urllib.parse.unquote(str(value or "")).replace("\\", "/").strip().lstrip("/")
    if not raw:
        raise ValueError("没有选择音频文件")
    root = _input_root()
    path = (root / raw).resolve()
    if root != path and root not in path.parents:
        raise ValueError("音频路径超出ComfyUI input目录")
    if not path.is_file():
        raise ValueError(f"音频文件不存在：{raw}")
    return path


def _waveform_payload(value: str, bins: int) -> dict:
    import soundfile as sf
    path = _resolve_audio_path(value)
    waveform, sample_rate = sf.read(str(path), dtype="float32", always_2d=True)
    mono = np.abs(waveform.mean(axis=1))
    bins = max(32, min(int(bins or 1400), 10000))
    if mono.size == 0:
        peaks = []
    else:
        edges = np.linspace(0, mono.size, bins + 1, dtype=np.int64)
        peaks = [float(mono[edges[i]:edges[i + 1]].max(initial=0.0)) for i in range(bins)]
    return {"peaks": peaks, "duration": float(mono.size / sample_rate), "sample_rate": int(sample_rate)}


def register_routes() -> None:
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception:
        return
    prompt_server = getattr(PromptServer, "instance", None)
    if prompt_server is None:
        return
    routes = prompt_server.routes

    @routes.get(f"{ROUTE_PREFIX}/file")
    async def audio_file(request):
        try:
            path = _resolve_audio_path(request.query.get("audio_file", ""))
            return web.FileResponse(path, headers={"Content-Type": mimetypes.guess_type(path)[0] or "application/octet-stream"})
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=400)

    @routes.get(f"{ROUTE_PREFIX}/waveform")
    async def audio_waveform(request):
        try:
            value = request.query.get("audio_file", "")
            payload = _waveform_payload(value, int(request.query.get("bins", "1400")))
            payload.update({"ok": True, "audio_url": f"{ROUTE_PREFIX}/file?audio_file={urllib.parse.quote(value, safe='')}"})
            return web.json_response(payload)
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=400)


register_routes()
