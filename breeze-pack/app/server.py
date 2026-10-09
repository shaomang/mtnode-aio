"""Breeze TTS 2 本地管理服务（FastAPI）。

对外契约（宿主与第三方都用这一套）：
    GET  /health                  → {"ok":true}（服务自身；引擎状态在 /api/status）
    GET  /api/health              → 同上（兼容旧口径 / 探活）
    GET  /api/status              → 安装 / 引擎 / GPU / 音色 / 许可 汇总（**含 apiKey**，本机回环）
    GET  /api/voices              → 音色库
    POST /api/voices/add          → multipart：voiceId + ref_text + ref_audio
    POST /api/voices/delete       → {"voiceId"}
    POST /api/voices/rename       → {"voiceId","newId"}
    POST /v1/audio/speech         → OpenAI 兼容：JSON 或 multipart，返回音频字节（**引擎没起会自动拉起**）
    POST /api/engine/start|stop   → 起停引擎
    POST /api/shutdown            → 停引擎并退出本服务

引擎按需拉起：`/v1/audio/speech` 与 `/api/preview` 进来先 `ensure_engine()` —— 引擎已在跑就直接用；
没起就在后台线程里拉一次，**本次请求等它就绪**（上限 `BREEZE_ENGINE_WAIT_S`，默认 900s），
超过上限回 `engine_loading`（503，可重试）。以前只有 `/api/engine/start` 会拉起引擎，
「后端在跑但引擎未加载」时合成直接吃 `engine_down` —— 控制台上写着「引擎未加载」，用户以为装坏了。

鉴权：除 /health、/api/health 外都要 `Authorization: Bearer <apiKey>`。
许可：权重与自托管输出受 BreezeBlue Research and Non-Commercial License 约束（仅限研究 / 非商用）。
"""
from __future__ import annotations

import os
import re
import sys
import threading
import time
import uuid
from pathlib import Path

# 允许 `python -m app <port>` 在安装目录里跑到同目录的包
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile  # noqa: E402
from fastapi.responses import JSONResponse, Response, StreamingResponse  # noqa: E402
from starlette.concurrency import run_in_threadpool  # noqa: E402

from . import audio as audio_mod  # noqa: E402
from . import config, engine, voices  # noqa: E402

app = FastAPI(title="Breeze TTS 2 Manager", version="1.0.0")
STARTED_AT = int(time.time() * 1000)
API_KEY = config.load_api_key()
ENGINE_BUSY_RETRY_S = float(os.environ.get("BREEZE_BUSY_RETRY_S") or 180.0)
# 按需拉起引擎时，单次请求最多等多久就绪（首次要载 ~7.7GB 权重；与 engine.start 的内层等待同量级）。
ENGINE_WAIT_S = float(os.environ.get("BREEZE_ENGINE_WAIT_S") or 900.0)


# ── 鉴权 ──────────────────────────────────────────────────────────────
def require_key(authorization: str | None, x_api_key: str | None) -> None:
    tok = ""
    if authorization and authorization.lower().startswith("bearer "):
        tok = authorization[7:].strip()
    elif x_api_key:
        tok = x_api_key.strip()
    if API_KEY and tok != API_KEY:
        raise HTTPException(status_code=401, detail="unauthorized")


def _err(code: str, message: str = "", status: int = 400) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message or code})


# ── GPU ───────────────────────────────────────────────────────────────
def query_gpu() -> dict | None:
    import subprocess

    try:
        kwargs: dict = {}
        if hasattr(subprocess, "CREATE_NO_WINDOW"):
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        p = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.used,memory.total,utilization.gpu", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=6,
            **kwargs,
        )
        line = (p.stdout or "").strip().splitlines()
        if not line:
            return None
        parts = [s.strip() for s in line[0].split(",")]
        if len(parts) < 4:
            return None
        return {
            "name": parts[0],
            "memUsedMb": int(float(parts[1])),
            "memTotalMb": int(float(parts[2])),
            "utilPct": int(float(parts[3])),
        }
    except Exception:
        return None


def _log_tail_lines(n: int = 60) -> list[str]:
    try:
        p = config.LOGS_DIR / "manager.log"
        if not p.is_file():
            return []
        lines = p.read_text("utf-8", "replace").splitlines()
        return lines[-max(1, n) :]
    except Exception:
        return []


def status_payload() -> dict:
    eng = engine.status()
    man: dict = {}
    try:
        import json

        man = json.loads((config.ROOT / "manifest.json").read_text("utf-8"))
    except Exception:
        man = {}
    wd = config.weights_dir()
    vs = voices.list_voices()
    return {
        "ok": True,
        "id": str(man.get("id") or "breeze-tts-local"),
        "version": str(man.get("version") or "1.0.0"),
        "apiKey": API_KEY,
        "port": int(config.load_config().get("apiPort") or config.DEFAULT_API_PORT),
        "project": {
            "root": str(config.ROOT),
            "engine": config.engine_ready(),
            "venv": config.venv_python().is_file(),
            "installed": (config.ROOT / ".install-ok").is_file(),
            "weights": config.weights_ready(),
            "weightsDir": str(wd),
        },
        "engine": eng,
        "gpu": query_gpu(),
        "ffmpeg": bool(config.ffmpeg_exe()),
        "formats": list(audio_mod.FORMATS),
        "voices": vs,
        "voiceCount": len(vs),
        "license": {
            "code": "Apache-2.0",
            "weights": "BreezeBlue Research and Non-Commercial License",
            "zh": config.LICENSE_NOTE_ZH,
            "en": config.LICENSE_NOTE_EN,
        },
        "uptimeMs": int(time.time() * 1000) - STARTED_AT,
        "logPath": str(config.LOGS_DIR / "manager.log"),
    }


# ── 基础端点 ──────────────────────────────────────────────────────────
@app.get("/health")
@app.get("/api/health")
def health() -> JSONResponse:
    return JSONResponse({"ok": True, "id": "breeze-tts-local", "uptimeMs": int(time.time() * 1000) - STARTED_AT})


@app.get("/api/status")
def api_status(authorization: str | None = Header(None), x_api_key: str | None = Header(None)) -> JSONResponse:
    # 未鉴权也回一份「不含密钥」的状态：宿主首次探活不需要先拿 key
    if not _key_ok(authorization, x_api_key):
        p = status_payload()
        p.pop("apiKey", None)
        p["needsKey"] = True
        return JSONResponse(p)
    return JSONResponse(status_payload())


def _key_ok(authorization: str | None, x_api_key: str | None) -> bool:
    try:
        require_key(authorization, x_api_key)
        return True
    except HTTPException:
        return False


# ── 引擎按需拉起 ──────────────────────────────────────────────────────
"""引擎默认不常驻（eager 约 7.7GB 显存），但「按需」必须真的按需：

以前只有 `/api/engine/start` 会拉起引擎，管理服务起来后引擎一直是未加载态 ——
控制台显示「引擎未加载」，第一次合成直接吃 `engine_down`（无法连接推理引擎），
用户以为装坏了。现在合成入口先过 `ensure_engine()`：没起就在后台线程拉一次，
本次请求等它就绪（上限 `ENGINE_WAIT_S`），超过上限回可重试的 `engine_loading`。

并发的多个请求共用同一次拉起（`_pull_job`），不会把 7.7GB 权重重复载进显存。
"""
_pull_lock = threading.Lock()
_pull_job: dict = {"job": None}


def _engine_ready() -> bool:
    h = engine.health(engine.engine_port(), timeout=2.0)
    return bool(h and h.get("_code") == 200)


def _run_pull(job: dict, wait_s: float) -> None:
    try:
        job["result"] = engine.start(wait_s=wait_s)
    except engine.EngineError as exc:
        job["error"] = exc
    except Exception as exc:  # noqa: BLE001
        job["error"] = engine.EngineError("engine_spawn_failed", f"拉起引擎时出错：{exc}")
    finally:
        job["done"] = True


def ensure_engine(wait_s: float | None = None) -> dict:
    """引擎没起就拉起并等它就绪（同一时刻只拉一次）；失败抛 engine.EngineError（带短错误码）。"""
    port = engine.engine_port()
    if _engine_ready():
        return {"ok": True, "port": port, "reused": True, "pid": engine.pid()}
    limit = max(30.0, float(wait_s if wait_s is not None else ENGINE_WAIT_S))
    with _pull_lock:
        job = _pull_job.get("job")
        if job is None or job.get("done"):
            job = {"done": False, "result": None, "error": None, "startedAt": time.time()}
            _pull_job["job"] = job
            config.log(f"[engine] 按需拉起（本次最多等 {int(limit)}s 就绪）")
            threading.Thread(target=_run_pull, args=(job, limit), name="breeze-engine-pull", daemon=True).start()
        else:
            config.log("[engine] 已有一次拉起在进行：本次请求等同一个结果")
    deadline = time.time() + limit + 20.0
    while time.time() < deadline:
        if job.get("error") is not None:
            raise job["error"]
        res = job.get("result")
        if res and res.get("ok"):
            return res
        if job.get("done"):
            if _engine_ready():
                return {"ok": True, "port": port, "reused": True, "pid": engine.pid()}
            raise engine.EngineError("engine_start_failed", "引擎拉起流程结束但没有就绪（详情见引擎日志）")
        time.sleep(1.0)
    raise engine.EngineError(
        "engine_loading",
        f"引擎仍在加载权重（已等 {int(limit)}s）：加载完成后这一步会自动可用，稍后重试即可",
    )


# 错误码 → HTTP 状态：输入 / 环境类回 4xx（宿主据此指路），进程与超时类回 5xx（交 Agent 修）。
ENGINE_ERR_STATUS = {
    "engine_loading": 503,
    "not_installed": 400,
    "no_weights": 400,
    "bad_python": 400,
    "torch_missing": 400,
    "cuda_unavailable": 400,
}


def ensure_engine_http(wait_s: float | None = None) -> dict:
    """`ensure_engine` 的 HTTP 版：失败转成带 code 的 HTTPException（宿主按 code 分派自愈）。"""
    try:
        return ensure_engine(wait_s)
    except engine.EngineError as exc:
        head = str(exc.message or "").splitlines()[0] if exc.message else ""
        config.log(f"[engine] 拉起失败 {exc.code}: {head}")
        raise _err(exc.code, exc.message, ENGINE_ERR_STATUS.get(exc.code, 500))


# ── 引擎起停 ──────────────────────────────────────────────────────────
@app.post("/api/engine/start")
def engine_start(authorization: str | None = Header(None), x_api_key: str | None = Header(None)) -> JSONResponse:
    require_key(authorization, x_api_key)
    return JSONResponse(ensure_engine_http())


@app.post("/api/engine/stop")
def engine_stop(authorization: str | None = Header(None), x_api_key: str | None = Header(None)) -> JSONResponse:
    require_key(authorization, x_api_key)
    return JSONResponse(engine.stop())


@app.get("/api/engine/log")
def engine_log(n: int = 200, authorization: str | None = Header(None), x_api_key: str | None = Header(None)) -> JSONResponse:
    require_key(authorization, x_api_key)
    return JSONResponse({"ok": True, "tail": engine.log_tail(n)})


@app.get("/api/log")
def manager_log(n: int = 200, authorization: str | None = Header(None), x_api_key: str | None = Header(None)) -> JSONResponse:
    require_key(authorization, x_api_key)
    return JSONResponse({"ok": True, "tail": _log_tail_lines(n)})


# ── 音色库 ────────────────────────────────────────────────────────────
@app.get("/api/voices")
def api_voices(authorization: str | None = Header(None), x_api_key: str | None = Header(None)) -> JSONResponse:
    require_key(authorization, x_api_key)
    return JSONResponse({"ok": True, "items": voices.list_voices()})


@app.post("/api/voices/add")
async def api_voices_add(
    voiceId: str = Form(...),
    ref_text: str = Form(""),
    ref_audio: UploadFile | None = File(None),
    authorization: str | None = Header(None),
    x_api_key: str | None = Header(None),
) -> JSONResponse:
    require_key(authorization, x_api_key)
    data = None
    name = "ref.wav"
    if ref_audio is not None and ref_audio.filename:
        data = await ref_audio.read()
        name = ref_audio.filename
    try:
        entry = voices.save_voice(voiceId, data, name, ref_text)
    except voices.VoiceError as exc:
        raise _err(exc.code, exc.message)
    config.log(f"[voices] add {entry['id']} audio={entry['hasAudio']} text={entry['hasText']}")
    return JSONResponse({"ok": True, "voice": entry})


@app.post("/api/voices/delete")
async def api_voices_delete(request: Request, authorization: str | None = Header(None), x_api_key: str | None = Header(None)) -> JSONResponse:
    require_key(authorization, x_api_key)
    body = await _json_body(request)
    vid = str(body.get("voiceId") or body.get("id") or "").strip()
    if not vid:
        raise _err("voice_id_required", "缺少 voiceId")
    ok = voices.delete_voice(vid)
    if not ok:
        raise _err("voice_not_found", "音色不存在", 404)
    config.log(f"[voices] delete {vid}")
    return JSONResponse({"ok": True})


@app.post("/api/voices/rename")
async def api_voices_rename(request: Request, authorization: str | None = Header(None), x_api_key: str | None = Header(None)) -> JSONResponse:
    require_key(authorization, x_api_key)
    body = await _json_body(request)
    vid = str(body.get("voiceId") or "").strip()
    nid = str(body.get("newId") or "").strip()
    if not vid or not nid:
        raise _err("voice_id_required", "缺少 voiceId / newId")
    try:
        entry = voices.rename_voice(vid, nid)
    except voices.VoiceError as exc:
        raise _err(exc.code, exc.message)
    return JSONResponse({"ok": True, "voice": entry})


@app.get("/api/voices/audio")
def api_voice_audio(voiceId: str, authorization: str | None = Header(None), x_api_key: str | None = Header(None)) -> Response:
    require_key(authorization, x_api_key)
    v = voices.get_voice(voiceId)
    if not v or not v["hasAudio"]:
        raise _err("voice_not_found", "音色或参考音频不存在", 404)
    p = Path(v["audio"])
    mime = "audio/wav"
    if p.suffix.lower() == ".flac":
        mime = "audio/flac"
    elif p.suffix.lower() == ".mp3":
        mime = "audio/mpeg"
    return Response(content=p.read_bytes(), media_type=mime)


@app.post("/api/voices/preview")
async def api_voices_preview(
    voiceId: str = Form(""),
    ref_text: str = Form(""),
    ref_audio: UploadFile | None = File(None),
    authorization: str | None = Header(None),
    x_api_key: str | None = Header(None),
) -> JSONResponse:
    """试听参考片段本身（不做合成）：回 wav 的 base64，控制台直接播。"""
    require_key(authorization, x_api_key)
    import base64

    src_path: Path | None = None
    tmp_created: list[Path] = []
    try:
        if ref_audio is not None and ref_audio.filename:
            tmp = config.temp_root() / ("preview-" + uuid.uuid4().hex + Path(ref_audio.filename).suffix)
            tmp.write_bytes(await ref_audio.read())
            tmp_created.append(tmp)
            src_path = tmp
        elif voiceId:
            v = voices.get_voice(voiceId)
            if not v or not v["hasAudio"]:
                raise _err("voice_not_found", "音色或参考音频不存在", 404)
            src_path = Path(v["audio"])
        if src_path is None:
            raise _err("ref_audio_required", "没有可试听的参考音频")
        mono, rate = audio_mod.read_audio_mono(str(src_path))
        wav = audio_mod.to_wav_bytes(mono, rate)
        return JSONResponse(
            {
                "ok": True,
                "wavBase64": base64.b64encode(wav).decode("ascii"),
                "sampleRate": rate,
                "durationSec": audio_mod.duration_s(mono, rate),
            }
        )
    except audio_mod.AudioError as exc:
        raise _err(exc.code, exc.message)
    finally:
        for p in tmp_created:
            try:
                p.unlink()
            except Exception:
                pass


# ── 合成 ──────────────────────────────────────────────────────────────
async def _json_body(request: Request) -> dict:
    try:
        j = await request.json()
        return j if isinstance(j, dict) else {}
    except Exception:
        return {}


async def _collect_speech_params(request: Request) -> dict:
    """同时吃 JSON（OpenAI 兼容）与 multipart（官方示例口径）两种请求体。"""
    ctype = str(request.headers.get("content-type") or "")
    if "multipart/form-data" in ctype or "application/x-www-form-urlencoded" in ctype:
        form = await request.form()
        out: dict = {k: v for k, v in form.items() if isinstance(v, str)}
        up = form.get("ref_audio")
        if up is not None and getattr(up, "filename", ""):
            out["_refAudioBytes"] = await up.read()
            out["_refAudioName"] = up.filename
        return out
    return await _json_body(request)


def _pick(d: dict, *names: str) -> str:
    for n in names:
        v = d.get(n)
        if v is not None and str(v).strip() != "":
            return str(v).strip()
    return ""


def _num(d: dict, *names: str, default: float | None = None) -> float | None:
    for n in names:
        v = d.get(n)
        if v is None or str(v).strip() == "":
            continue
        try:
            return float(v)
        except Exception:
            continue
    return default


def _resolve_mode(params: dict) -> str:
    """能力判定：显式 mode 优先；否则按官方语义推导。

    官方语义：有参考音频且无 instruction = 音色克隆；有 instruction = 音色导演；
    无参考音频 = 音色设计。
    """
    mode = _pick(params, "mode", "task").lower()
    alias = {"clone": "clone", "voice_clone": "clone", "克隆": "clone",
             "design": "design", "voice_design": "design", "设计": "design",
             "direction": "direction", "voice_direction": "direction", "导演": "direction"}
    if mode in alias:
        return alias[mode]
    return "auto"


def prepare_request(params: dict, *, tmp_dir: Path) -> dict:
    """把请求参数归一成引擎要的一份请求，并落实参考源优先级（端子 > 音色库）。"""
    text = _pick(params, "text", "input", "prompt")
    if not text:
        raise _err("text_required", "待合成文本为空")

    ref_audio_bytes = params.get("_refAudioBytes")
    ref_audio_path = ""
    if ref_audio_bytes:
        suffix = Path(str(params.get("_refAudioName") or "ref.wav")).suffix or ".wav"
        p = tmp_dir / ("ref-" + uuid.uuid4().hex + suffix)
        p.write_bytes(ref_audio_bytes)
        ref_audio_path = str(p)
    else:
        ref_audio_path = _pick(params, "refAudio", "ref_audio_path", "refAudioPath")
        if not ref_audio_path:
            vid = _pick(params, "voice", "voiceId")
            if vid:
                v = voices.get_voice(vid)
                if v and v["hasAudio"]:
                    ref_audio_path = v["audio"]
                    if not _pick(params, "refText", "ref_text") and v["hasText"]:
                        params = dict(params)
                        params["refText"] = v["text"]
                elif v is None:
                    raise _err("voice_not_found", f"音色不存在：{vid}")

    ref_text = _pick(params, "refText", "ref_text")
    instruction = _pick(params, "instruction", "instruct")
    mode = _resolve_mode(params)
    cfg_scale = _num(params, "cfg_scale", "cfgScale")
    seed = _num(params, "seed")
    speed = _num(params, "speed", default=1.0)
    fmt = (_pick(params, "response_format", "format") or "wav").lower()
    if fmt == "wave":
        fmt = "wav"
    if fmt not in audio_mod.FORMATS:
        raise _err("unsupported_format", f"不支持的输出格式：{fmt}")

    if ref_audio_path and not ref_text:
        raise _err(
            "ref_text_required",
            "给了参考音频就必须同时给参考文稿（两者在官方接口里必须成对）：请填「参考文稿」端子，或在控制台音色库里给该音色补上 ref.txt",
        )
    if ref_text and not ref_audio_path:
        raise _err("ref_audio_required", "给了参考文稿但没有参考音频：请接「参考音频」端子或选一个音色")

    if mode == "auto":
        # 官方语义：有参考音频且无 instruction = 音色克隆；有参考音频且有 instruction = 音色导演；
        # **没有参考音频就是音色设计**（它的音色来自 instruction）——不能因为带了 instruction
        # 就判成导演，否则「音色设计」这条无参考音频的路会被误判掉。
        if ref_audio_path:
            mode = "direction" if instruction else "clone"
        else:
            mode = "design"
    if mode == "clone" and not ref_audio_path:
        raise _err("ref_audio_required", "「音色克隆」需要参考音频（接端子或选音色）")
    if mode == "design" and ref_audio_path:
        # 官方语义：有参考音频 + 有 instruction = 音色导演；设计模式不接受参考音频
        raise _err(
            "mode_conflict",
            "「音色设计」不使用参考音频（它的音色来自 instruction）。请改用「音色导演」或清掉参考音频端子 / 音色",
        )
    if mode == "direction" and not instruction:
        raise _err("instruction_required", "「音色导演」需要 instruction（描述语气、情绪、节奏）")

    if cfg_scale is None:
        # 官方建议：instruction 场景用 4 加强指令跟随；克隆场景保持默认 1
        cfg_scale = 4.0 if instruction else 1.0
    if cfg_scale <= 0:
        raise _err("bad_cfg_scale", "cfg_scale 必须大于 0")
    if speed is not None and (speed < 0.25 or speed > 4.0):
        raise _err("bad_speed", "speed 需在 0.25 ~ 4.0 之间")

    return {
        "text": text,
        "mode": mode,
        "refAudioPath": ref_audio_path,
        "refText": ref_text,
        "instruction": instruction,
        "cfgScale": float(cfg_scale),
        "seed": int(seed) if seed is not None else 42,
        "speed": float(speed if speed else 1.0),
        "format": fmt,
    }


def call_engine(req: dict, *, busy_retry_s: float = ENGINE_BUSY_RETRY_S) -> tuple[bytes, int]:
    """调引擎 /v1/audio/speech，回 (PCM 字节, 采样率)。

    引擎是单并发的：同时两个请求，后到的会吃 409 —— 这里按空闲重试，最多等 busy_retry_s。
    """
    import urllib.error
    import urllib.request

    port = engine.engine_port()
    url = f"http://127.0.0.1:{port}/v1/audio/speech"
    boundary = "----breezemgr" + uuid.uuid4().hex
    parts: list[bytes] = []

    def field(name: str, value: str) -> None:
        parts.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode("utf-8")
        )

    field("text", req["text"])
    field("cfg_scale", str(req["cfgScale"]))
    field("seed", str(req["seed"]))
    if req["instruction"]:
        field("instruction", req["instruction"])
    if req["refAudioPath"]:
        p = Path(req["refAudioPath"])
        if not p.is_file():
            raise _err("ref_audio_missing", f"参考音频文件不存在：{p}")
        # 统一转成 24kHz 单声道 wav（引擎对 mp3/m4a 参考音频不一定稳）
        norm = config.temp_root() / ("norm-" + uuid.uuid4().hex + ".wav")
        try:
            audio_mod.normalize_ref_audio(str(p), str(norm))
        except audio_mod.AudioError as exc:
            raise _err(exc.code, exc.message)
        data = norm.read_bytes()
        parts.append(
            (
                f"--{boundary}\r\nContent-Disposition: form-data; name=\"ref_audio\"; filename=\"ref.wav\"\r\n"
                "Content-Type: audio/wav\r\n\r\n"
            ).encode("utf-8")
            + data
            + b"\r\n"
        )
        field("ref_text", req["refText"])
    body = b"".join(parts) + f"--{boundary}--\r\n".encode("ascii")

    deadline = time.time() + max(5.0, float(busy_retry_s))
    attempt = 0
    while True:
        attempt += 1
        r = urllib.request.Request(
            url,
            data=body,
            method="POST",
            headers={
                "Content-Type": f"multipart/form-data; boundary={boundary}",
                "Content-Length": str(len(body)),
            },
        )
        try:
            with urllib.request.urlopen(r, timeout=1800) as res:
                rate = 0
                try:
                    rate = int(res.headers.get("X-Sample-Rate") or 0)
                except Exception:
                    rate = 0
                chunks: list[bytes] = []
                while True:
                    c = res.read(65536)
                    if not c:
                        break
                    chunks.append(c)
                pcm = b"".join(chunks)
                if not pcm:
                    raise _err("empty_audio", "引擎返回空音频（可换一个参考片段或调整 cfg_scale 后重试）")
                return pcm, rate or audio_mod.SAMPLE_RATE_DEFAULT
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8", "replace")[:400]
            except Exception:
                detail = ""
            if e.code == 409 and time.time() < deadline:
                config.log(f"[speech] 引擎忙（409），第 {attempt} 次重试…")
                time.sleep(2.0)
                continue
            if e.code == 409:
                raise _err("busy_engine", "引擎正忙（同一时刻只跑一个合成请求），请稍后重试", 409)
            if e.code == 400:
                raise _err("engine_rejected", f"引擎拒绝了这次请求：{detail or '（无详情）'}")
            if e.code == 503:
                raise _err("engine_loading", "引擎还在加载权重（首次启动约需数十秒到数分钟），请稍后重试", 503)
            raise _err("engine_http_" + str(e.code), f"引擎返回 HTTP {e.code}：{detail}")
        except urllib.error.URLError as e:
            raise _err("engine_down", f"无法连接推理引擎（127.0.0.1:{port}）：{e.reason}")


def sanitize_filename(name: str) -> str:
    raw = str(name or "").strip()
    if not raw:
        return ""
    raw = re.sub(r"[\\/:*?\"<>|\x00-\x1f]", "_", raw)
    return raw[:120]


def write_output(data: bytes, filename: str, fmt: str) -> Path:
    name = sanitize_filename(filename) or ("breeze-" + uuid.uuid4().hex[:10] + "." + fmt)
    p = config.OUT_DIR / name
    if p.exists():
        stamp = time.strftime("%Y%m%d-%H%M%S")
        p = config.OUT_DIR / (p.stem + "-" + stamp + p.suffix)
    config.OUT_DIR.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)
    return p


def _speech_body(params: dict) -> Response:
    """合成的同步主体（跑在工作线程里，见 speech 的注释）。"""
    tmp_dir = config.temp_root()
    req = prepare_request(params, tmp_dir=tmp_dir)
    config.log(
        f"[speech] mode={req['mode']} fmt={req['format']} cfg={req['cfgScale']} seed={req['seed']} "
        f"ref={'yes' if req['refAudioPath'] else 'no'} textLen={len(req['text'])}"
    )
    # 引擎没起就先拉起（首次要载 ~7.7GB 权重）：这才叫「按需」，而不是把失败丢回给用户。
    ensure_engine_http()
    pcm, rate = call_engine(req)
    samples = audio_mod.pcm16_to_float(pcm)
    try:
        data, mime = audio_mod.write_audio(samples, rate, req["format"])
    except audio_mod.AudioError as exc:
        raise _err(exc.code, exc.message, 500 if exc.code == "transcode_failed" else 400)

    # 客户端可要求落盘（画布节点直接用回传路径把音频交给下游）
    save = _pick(params, "save") in {"1", "true", "yes"} or bool(_pick(params, "filename"))
    headers = {
        "X-Sample-Rate": str(rate),
        "X-Breeze-Mode": req["mode"],
        "X-Breeze-Duration": f"{audio_mod.duration_s(samples, rate):.3f}",
    }
    if save:
        p = write_output(data, _pick(params, "filename"), req["format"])
        headers["X-Breeze-Path"] = str(p)
    return Response(content=data, media_type=mime, headers=headers)


@app.post("/v1/audio/speech")
async def speech(request: Request, authorization: str | None = Header(None), x_api_key: str | None = Header(None)):
    require_key(authorization, x_api_key)
    params = await _collect_speech_params(request)
    # 合成（含引擎按需拉起）动辄几十秒到几分钟，必须放到工作线程里跑：
    # 以前它在事件循环里同步阻塞，加载期间连 /api/status 都回不了 ——
    # 控制台的徽章就永远刷不出「引擎加载中…」，用户只能看到「未加载」发呆。
    return await run_in_threadpool(_speech_body, params)


def _preview_body(params: dict) -> dict:
    import base64

    params["response_format"] = "wav"
    req = prepare_request(params, tmp_dir=config.temp_root())
    ensure_engine_http()
    pcm, rate = call_engine(req)
    samples = audio_mod.pcm16_to_float(pcm)
    wav = audio_mod.to_wav_bytes(samples, rate)
    return {
        "ok": True,
        "mode": req["mode"],
        "sampleRate": rate,
        "durationSec": audio_mod.duration_s(samples, rate),
        "wavBase64": base64.b64encode(wav).decode("ascii"),
    }


@app.post("/api/preview")
async def api_preview(request: Request, authorization: str | None = Header(None), x_api_key: str | None = Header(None)) -> JSONResponse:
    """控制台试听：合成并回 wav 的 base64（避免控制台再走一次二进制下载）。"""
    require_key(authorization, x_api_key)
    params = await _collect_speech_params(request)
    return JSONResponse(await run_in_threadpool(_preview_body, params))


# ── 关停 ──────────────────────────────────────────────────────────────
@app.post("/api/shutdown")
def shutdown(authorization: str | None = Header(None), x_api_key: str | None = Header(None)) -> JSONResponse:
    require_key(authorization, x_api_key)
    config.log("[manager] shutdown requested")

    def _bye() -> None:
        time.sleep(0.4)
        try:
            engine.stop()
        except Exception as exc:  # noqa: BLE001
            config.log(f"[manager] 停引擎失败：{exc}")
        os._exit(0)

    import threading

    threading.Thread(target=_bye, daemon=True).start()
    return JSONResponse({"ok": True})
