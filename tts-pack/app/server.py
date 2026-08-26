"""FastAPI management server + OpenAI-compatible TTS API (GPT-SoVITS backend)."""
from __future__ import annotations

import os
import secrets
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
API_KEY_PATH = ROOT / ".api-key"
DEFAULT_PORT = int(os.environ.get("TTS_API_PORT", "8770"))
DEFAULT_SOVITS_PORT = int(os.environ.get("TTS_SOVITS_PORT", "9880"))


def _log(msg: str) -> None:
    line = f"[{time.strftime('%H:%M:%S')}] {msg}\n"
    log_path = ROOT / ".console.log"
    try:
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception:
        pass


def _ensure_multipart() -> None:
    """python-multipart is REQUIRED by Starlette's request.form() — every
    upload (audio / transcript) dies with 500 / connection reset without it.
    The venv may be read-only for the service user, so self-heal by pip
    installing into a writable ROOT/.pylibs and injecting it into sys.path.

    CRITICAL: this MUST run BEFORE `from fastapi import ...` — starlette's
    formparsers caches `parse_options_header` at import time; if
    python-multipart is missing then, request.form() raises
    AssertionError on EVERY upload no matter what we do later."""
    try:
        import multipart  # noqa: F401

        return
    except Exception:
        pass
    libdir = ROOT / ".pylibs"
    try:
        libdir.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass
    if str(libdir) not in sys.path:
        sys.path.insert(0, str(libdir))
    try:
        import multipart  # noqa: F401

        _log("python-multipart ready (.pylibs)")
        return
    except Exception:
        pass
    for idx in ("https://pypi.tuna.tsinghua.edu.cn/simple", "https://mirrors.aliyun.com/pypi/simple/"):
        try:
            _log("installing python-multipart -> " + str(libdir) + " (index " + idx + ")")
            r = subprocess.run(
                [
                    sys.executable, "-m", "pip", "install",
                    "--target", str(libdir),
                    "-i", idx,
                    "python-multipart>=0.0.9",
                ],
                capture_output=True,
                text=True,
                timeout=180,
            )
            if r.returncode == 0:
                import multipart  # noqa: F401

                _log("python-multipart installed (self-heal)")
                return
            _log("self-heal pip failed: " + (r.stderr or r.stdout or "")[-300:])
        except Exception as e:
            _log("self-heal pip error: " + str(e))
    _log("python-multipart unavailable — uploads will fail until installed")


_ensure_multipart()

import uvicorn
from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel

from app import train, tts
from app.console_banner import show_service_banner
from app.gpu import query_gpu

app = FastAPI(title="GPT-SoVITS Local TTS Manager", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


tts.set_logger(_log)
train.set_logger(_log)


@app.on_event("startup")
def _on_startup() -> None:
    try:
        tts.VOICES_DIR.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        _log("mkdir voices failed: " + str(e))
    try:
        train.PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        _log("mkdir projects failed: " + str(e))


def get_api_key() -> str:
    if API_KEY_PATH.exists():
        key = API_KEY_PATH.read_text(encoding="utf-8").strip()
        if key:
            return key
    key = "tts-" + secrets.token_urlsafe(24)
    API_KEY_PATH.write_text(key, encoding="utf-8")
    _log(f"generated api key {key[:12]}…")
    return key


def require_key(authorization: str | None, x_api_key: str | None = None) -> None:
    key = get_api_key()
    token = ""
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
    elif x_api_key:
        token = x_api_key.strip()
    if token != key:
        raise HTTPException(status_code=401, detail="invalid_api_key")


@app.get("/api/health")
async def health():
    return {"ok": True, "ts": time.time(), "engine": "GPT-SoVITS"}


@app.get("/api/status")
async def status():
    key = get_api_key()
    engine = tts.engine_up()
    return {
        "ok": True,
        "apiBase": f"http://127.0.0.1:{DEFAULT_PORT}/v1",
        "manageBase": f"http://127.0.0.1:{DEFAULT_PORT}",
        "apiKey": key,
        "port": DEFAULT_PORT,
        "sovitsPort": DEFAULT_SOVITS_PORT,
        "engine": "GPT-SoVITS",
        "engineUp": engine,
        "engineReady": tts.engine_ready(),
        "voices": tts.list_voices(),
        "projects": train.list_projects(),
        "gpu": query_gpu(),
    }


@app.get("/api/gpu")
async def gpu_info():
    return {"ok": True, "gpu": query_gpu()}


@app.get("/api/voices")
async def voices_list():
    return {"ok": True, "items": tts.list_voices()}


class VoiceAddForm:
    pass


@app.post("/api/voices/add")
async def voices_add(
    request: Request,
    authorization: str | None = Header(None),
    x_api_key: str | None = Header(None),
):
    require_key(authorization, x_api_key)
    form = await request.form()
    upload = form.get("file")
    if upload is None:
        raise HTTPException(status_code=400, detail="file_required")
    data = await upload.read()
    name = str(form.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name_required")
    prompt_text = str(form.get("prompt_text") or "")
    lang = str(form.get("lang") or "auto")
    try:
        voice = tts.add_voice(name, data, prompt_text, lang)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"ok": True, "voice": voice}


@app.delete("/api/voices/{voice_id:path}")
async def voices_remove(voice_id: str, authorization: str | None = Header(None), x_api_key: str | None = Header(None)):
    require_key(authorization, x_api_key)
    return {"ok": True, "removed": tts.remove_voice(voice_id)}


# ---------------- audio training (projects) ----------------

@app.get("/api/projects")
async def projects_list(authorization: str | None = Header(None), x_api_key: str | None = Header(None)):
    require_key(authorization, x_api_key)
    return {"ok": True, "items": train.list_projects()}


class ProjectCreateBody(BaseModel):
    name: str


@app.post("/api/projects")
async def projects_create(body: ProjectCreateBody, authorization: str | None = Header(None), x_api_key: str | None = Header(None)):
    require_key(authorization, x_api_key)
    try:
        m = train.create_project(body.name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"ok": True, "project": m}


@app.post("/api/projects/{slug:path}/upload")
async def projects_upload(
    slug: str,
    request: Request,
    authorization: str | None = Header(None),
    x_api_key: str | None = Header(None),
):
    require_key(authorization, x_api_key)
    form = await request.form()
    files: list[tuple[str, bytes]] = []
    for f in form.getlist("files"):
        try:
            data = await f.read()
        except Exception:
            continue
        if data:
            files.append((getattr(f, "filename", None) or "upload.bin", data))
    transcript_file: tuple[str, bytes] | None = None
    tf = form.get("text_file")
    if tf is not None:
        try:
            tf_data = await tf.read()
        except Exception:
            tf_data = b""
        if tf_data:
            transcript_file = (getattr(tf, "filename", None) or "transcript.txt", tf_data)
    transcript_text = str(form.get("text") or "")
    try:
        m = train.upload_files(slug, files, transcript_text=transcript_text, transcript_file=transcript_file)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"ok": True, "project": m}


@app.post("/api/projects/{slug:path}/train")
async def projects_train(slug: str, authorization: str | None = Header(None), x_api_key: str | None = Header(None)):
    require_key(authorization, x_api_key)
    r = train.start_train(slug)
    if not r.get("ok"):
        raise HTTPException(status_code=400, detail=r.get("error", "train_failed"))
    return r


@app.get("/api/projects/{slug:path}/status")
async def projects_status(slug: str, authorization: str | None = Header(None), x_api_key: str | None = Header(None)):
    require_key(authorization, x_api_key)
    try:
        return {"ok": True, "project": train.train_status(slug)}
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


@app.post("/api/projects/{slug:path}/cancel")
async def projects_cancel(slug: str, authorization: str | None = Header(None), x_api_key: str | None = Header(None)):
    require_key(authorization, x_api_key)
    return train.cancel_train(slug)


@app.get("/api/projects/{slug:path}/files")
async def projects_files(slug: str, authorization: str | None = Header(None), x_api_key: str | None = Header(None)):
    require_key(authorization, x_api_key)
    try:
        return {"ok": True, "project": train.project_detail(slug)}
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


_AUDIO_MIME = {
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".wma": "audio/x-ms-wma",
}


@app.get("/api/projects/{slug:path}/audio/{filename:path}")
async def projects_audio(slug: str, filename: str, authorization: str | None = Header(None), x_api_key: str | None = Header(None)):
    require_key(authorization, x_api_key)
    try:
        p = train.project_audio_path(slug, filename)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    mime = _AUDIO_MIME.get(p.suffix.lower(), "application/octet-stream")
    return FileResponse(str(p), media_type=mime, filename=p.name)


class TtsBody(BaseModel):
    text: str
    voice: str = ""
    speed: float = 1.0
    media_type: str = "wav"
    text_lang: str = "auto"
    top_k: int = 5
    top_p: float = 1.0
    temperature: float = 1.0
    text_split_method: str = "cut5"
    batch_size: int = 1
    seed: int = -1


@app.post("/api/tts")
async def api_tts(
    body: TtsBody,
    authorization: str | None = Header(None),
    x_api_key: str | None = Header(None),
):
    require_key(authorization, x_api_key)
    r = tts.synthesize(
        body.text,
        voice_id=body.voice,
        speed=body.speed,
        media_type=body.media_type,
        text_lang=body.text_lang,
        top_k=body.top_k,
        top_p=body.top_p,
        temperature=body.temperature,
        text_split_method=body.text_split_method,
        batch_size=body.batch_size,
        seed=body.seed,
    )
    if not r.get("ok"):
        raise HTTPException(status_code=500, detail=r.get("error", "tts_failed"))
    return Response(
        content=r["audio"],
        media_type=r.get("contentType", "audio/wav"),
        headers={"X-TTS-Voice": r.get("voice", "")},
    )


class OpenAiSpeechBody(BaseModel):
    model: str = "gpt-sovits"
    input: str
    voice: str = ""
    response_format: str = "wav"
    speed: float = 1.0


@app.get("/v1/models")
async def openai_models(authorization: str | None = Header(None), x_api_key: str | None = Header(None)):
    require_key(authorization, x_api_key)
    voices = tts.list_voices()
    data = [{"id": "gpt-sovits", "object": "model"}] + [
        {"id": v["id"], "object": "voice", "owned_by": "local"}
        for v in voices
    ]
    return {"object": "list", "data": data}


@app.post("/v1/audio/speech")
async def openai_speech(
    body: OpenAiSpeechBody,
    authorization: str | None = Header(None),
    x_api_key: str | None = Header(None),
):
    require_key(authorization, x_api_key)
    fmt = str(body.response_format or "wav").lower()
    if fmt in ("mp3", "mp4", "mpeg", "mpga"):
        media_type = "mp3"
    elif fmt in ("flac",):
        media_type = "flac"
    elif fmt in ("opus",):
        media_type = "opus"
    else:
        media_type = "wav"
    r = tts.synthesize(
        str(body.input or ""),
        voice_id=str(body.voice or ""),
        speed=float(body.speed or 1.0),
        media_type=media_type,
    )
    if not r.get("ok"):
        raise HTTPException(status_code=500, detail=r.get("error", "tts_failed"))
    mime = r.get("contentType") or f"audio/{media_type}"
    return Response(content=r["audio"], media_type=mime)


@app.post("/api/engine/start")
async def engine_start(authorization: str | None = Header(None), x_api_key: str | None = Header(None)):
    require_key(authorization, x_api_key)
    r = tts.start_engine(DEFAULT_SOVITS_PORT)
    if not r.get("ok"):
        raise HTTPException(status_code=400, detail=r.get("error", "engine_start_failed"))
    return r


@app.post("/api/engine/stop")
async def engine_stop(authorization: str | None = Header(None), x_api_key: str | None = Header(None)):
    require_key(authorization, x_api_key)
    return tts.stop_engine()


@app.post("/api/shutdown")
async def shutdown(authorization: str | None = Header(None), x_api_key: str | None = Header(None)):
    require_key(authorization, x_api_key)
    try:
        tts.stop_engine()
    except Exception:
        pass
    try:
        train.cancel_all()
    except Exception:
        pass
    _log("shutdown requested — exiting manager")

    def _exit_soon() -> None:
        time.sleep(0.4)
        os._exit(0)

    threading.Thread(target=_exit_soon, daemon=True, name="tts-exit").start()
    return {"ok": True}


def main() -> None:
    port = DEFAULT_PORT
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            pass
    _log(f"starting manager on :{port}")
    show_service_banner(port)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning", loop="asyncio")


if __name__ == "__main__":
    main()
