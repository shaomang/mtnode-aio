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
    # 浏览器里的调用方默认只能看到少数响应头；X-TTS-* 不 expose 出去，
    # 前端就永远读不到"这次用的是哪份权重"。
    expose_headers=[
        "Content-Type", "Content-Length", "X-TTS-Voice", "X-TTS-Lang", "X-TTS-Lang-Mode",
        "X-TTS-Prompt-Lang", "X-TTS-Weights", "X-TTS-Live", "X-TTS-Lang-Error", "X-TTS-Live-Error",
        "X-TTS-Sample-Steps", "X-TTS-Sample-Steps-Apply", "X-TTS-SoVITS-Family",
    ],
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
    try:
        # 引擎侧补丁（含"共用汉字守卫"，防止中文里突然冒出日语）。新补丁会重启
        # 推理引擎；此刻还没有在途请求，重启最安全。
        threading.Thread(target=tts.ensure_engine_patches, daemon=True, name="tts-patch").start()
    except Exception as e:
        _log("engine patches failed: " + str(e))


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
        "liveVoices": tts.list_live_voices(),
        "projects": train.list_projects(),
        "gpu": query_gpu(),
        "language": tts.language_status(),
    }


@app.get("/api/languages")
async def languages():
    """面板「语种」下拉菜单的数据源：可选策略 modes + 当前生效的语种策略。

    value 是**策略值**（zh_only / zh_mix / auto_char / …），不是引擎语言码；
    插件内部再翻译成引擎认识的 all_zh / zh / ja…。老前端可以直接把返回的
    policy.mode 当默认值显示。
    """
    st = tts.language_status()
    pol = st.get("policy") or {}
    return {
        "ok": True,
        "modes": tts.LANG_MODES,
        "options": tts.LANG_MODES,
        "policy": pol,
        "defaultMode": tts.DEFAULT_LANG_MODE,
        "defaultLock": tts.DEFAULT_LANG_LOCK,
        "status": st,
    }


@app.post("/api/lang/policy")
async def lang_policy(
    body: dict,
    authorization: str | None = Header(None),
    x_api_key: str | None = Header(None),
):
    """设语种策略：body = {"mode": "zh_only", "lock": true}。
    mode 也接受中文别名（"仅中文"/"中英混合"/"日文"…）和引擎语言码。"""
    require_key(authorization, x_api_key)
    r = tts.save_lang_policy(body.get("mode", ""), body.get("lock"))
    if not r.get("ok"):
        raise HTTPException(status_code=400, detail=r.get("error", "lang_policy_failed"))
    return {"ok": True, "policy": tts.lang_policy_status(), "guard": tts.language_status()}


@app.get("/api/infer")
async def infer_settings():
    """面板「采样步数」下拉菜单的数据源 + 当前服务端默认值。

    choices 是引擎认的那几个值；appliesTo 说明它只对走声码器的 s2（v3 / v4）有效
    —— v1 / v2 / v2Pro 的 VITS 解码路径不消费 sample_steps（实测 32/64/128
    三次合成输出的字节完全相同）。
    """
    st = tts.load_infer_settings()
    return {
        "ok": True,
        "sampleSteps": st["sampleSteps"],
        "default": tts.DEFAULT_SAMPLE_STEPS,
        "choices": list(tts.SAMPLE_STEPS_CHOICES),
        "engineDefault": tts.DEFAULT_SAMPLE_STEPS,
        "appliesTo": ["v3", "v4"],
        "note": (
            "采样步数只影响带声码器的 s2（v3 / v4）。v1 / v2 / v2Pro 权重"
            "（本插件当前训练的就是 v2）不消费这个参数，实测 32 / 64 / 128 合成结果"
            "字节完全相同；练完有电流音请先看训练卡片里的「语料体检」。"
        ),
    }


@app.post("/api/infer")
async def save_infer_settings(
    body: dict,
    authorization: str | None = Header(None),
    x_api_key: str | None = Header(None),
):
    """设服务端推理默认：body = {"sampleSteps": 128}。存安装目录 infer.json，
    面板 / 画布节点 / OpenAI 接口 /v1/audio/speech 之后都按这个值走。"""
    require_key(authorization, x_api_key)
    r = tts.save_infer_settings(body.get("sampleSteps", body.get("sample_steps")))
    if not r.get("ok"):
        raise HTTPException(status_code=400, detail=r.get("error", "infer_settings_failed"))
    return {"ok": True, "settings": tts.load_infer_settings()}



def _raise_tts_error(r: dict) -> None:
    """把 synthesize() 的失败转成 HTTP 错误：语种拒绝/中间模型还没练出来=400，其它=500。"""
    err = str(r.get("error") or "tts_failed")
    code = str(r.get("errorCode") or "")
    if code == "lang_denied":
        raise HTTPException(
            status_code=400,
            detail=err,
            headers={"X-TTS-Lang-Error": "lang_denied"},
        )
    if code == "live_model_unready":
        raise HTTPException(status_code=400, detail=err, headers={"X-TTS-Live-Error": "unready"})
    raise HTTPException(status_code=500, detail=err)


def _tts_headers(r: dict) -> dict[str, str]:
    """合成响应头：语种 + 这次真正用的权重（试听中间模型时要能确认听到第几轮）。

    HTTP 头只能是 latin-1 —— 项目名允许中文（_slug 不剥非 ASCII），所以文件名一律
    percent-encode，面板 decode 回来显示；不这么做的话中文项目名会直接把响应打崩。
    """
    import urllib.parse

    def _h(v: Any) -> str:
        s = str(v or "")
        # 纯 ASCII 原样输出（老客户端读 X-TTS-Voice 的行为不变），否则 percent-encode
        if all(32 <= ord(c) < 127 for c in s):
            return s
        return urllib.parse.quote(s, safe="+._-~")

    h = {
        "X-TTS-Voice": _h(r.get("voice", "")),
        "X-TTS-Lang": str(r.get("textLang", "")),
        "X-TTS-Lang-Mode": str(r.get("langMode", "")),
        "X-TTS-Prompt-Lang": str(r.get("promptLang", "")),
    }
    if r.get("sampleSteps"):
        h["X-TTS-Sample-Steps"] = str(r["sampleSteps"])
        # 这次发的采样步数到底起没起作用：v1/v2 的 VITS 路径不消费它（诚实反馈，
        # 免得用户以为调大采样数能治电流音）。详见 tts.SAMPLE_STEPS_CHOICES 注释。
        h["X-TTS-Sample-Steps-Apply"] = "yes" if r.get("sampleStepsApply") else "no"
        if r.get("sovitsFamily"):
            h["X-TTS-SoVITS-Family"] = str(r["sovitsFamily"])
    if r.get("weights"):
        h["X-TTS-Weights"] = _h(r["weights"])
    live = r.get("live") or {}
    if live:
        h["X-TTS-Live"] = _h(
            "%s|GPT e%s|SoVITS e%s|%s"
            % (live.get("project") or "", live.get("gptEpoch"), live.get("sovitsEpoch"), "pinned" if live.get("pinned") else "latest")
        )
    return h


@app.post("/api/voices/lang")
async def voices_set_lang(
    body: dict,
    authorization: str | None = Header(None),
    x_api_key: str | None = Header(None),
):
    require_key(authorization, x_api_key)
    r = tts.set_voice_lang(str(body.get("voice") or ""), str(body.get("lang") or ""))
    if not r.get("ok"):
        raise HTTPException(status_code=400, detail=r.get("error", "lang_failed"))
    return r


@app.post("/api/engine/lang-guard")
async def engine_lang_guard(authorization: str | None = Header(None), x_api_key: str | None = Header(None)):
    """补装引擎的「共用汉字守卫」补丁（会重启推理引擎）。"""
    require_key(authorization, x_api_key)
    return tts.apply_language_guard()


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
    # 留空/auto 时由 add_voice 按参考文本字符判定语种（不让引擎去猜参考文本）
    lang = str(form.get("lang") or "")
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


class ProjectTrainBody(BaseModel):
    """训练选项（全部可省略，省略即保持旧行为）。

    mode:      fresh/retrain/重新训练 = 删断点从预训练底模重训
               continue/resume/继续迭代 = 保留断点，在当前轮数上追加
               auto（默认）= 已有模型就继续迭代，没有就全新训练
    reuseData: 默认 True —— 已整理过的音频/文字/特征不重复处理
    dither:    默认 False —— 对低带宽语料做高频空带填充（缓解电流音的缓解手段）
    s1Epochs / s2Epochs: fresh 时为总轮数；continue 时为「追加轮数」
    """

    mode: str = "auto"
    reuseData: bool = True
    dither: bool = False
    s1Epochs: int | None = None
    s2Epochs: int | None = None


@app.post("/api/projects/{slug:path}/train")
async def projects_train(
    slug: str,
    body: ProjectTrainBody | None = None,
    authorization: str | None = Header(None),
    x_api_key: str | None = Header(None),
):
    require_key(authorization, x_api_key)
    # 规范化放在入口：别名（继续迭代/retrain）、越界轮数在这里一次性收敛，
    # 返回体也就能如实回显「本次实际会怎么做」。
    o = train._norm_train_opts(body.model_dump() if body else None)
    r = train.start_train(slug, o)
    if not r.get("ok"):
        raise HTTPException(status_code=400, detail=r.get("error", "train_failed"))
    r.update({"trainMode": o["mode"], "reuseData": o["reuseData"]})
    try:
        r["plan"] = train.train_plan(slug, o)
    except Exception:
        pass
    return r


@app.get("/api/projects/{slug:path}/model")
async def projects_model(slug: str, authorization: str | None = Header(None), x_api_key: str | None = Header(None)):
    """面板用：这个项目已有哪些模型/已整理数据，能选哪种训练方式。"""
    require_key(authorization, x_api_key)
    try:
        return {"ok": True, **train.model_info(slug)}
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


@app.get("/api/projects/{slug:path}/status")
async def projects_status(slug: str, authorization: str | None = Header(None), x_api_key: str | None = Header(None)):
    require_key(authorization, x_api_key)
    try:
        return {"ok": True, "project": train.train_status(slug)}
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


@app.get("/api/live-models")
async def live_models_list(authorization: str | None = Header(None), x_api_key: str | None = Header(None)):
    """训练中间模型列表（面板「测试合成」音色下拉的第二组）。

    训练每练完一轮，引擎就会在 GPT_weights_v2 / SoVITS_weights_v2 里写出一个
    **可直接推理**的权重（s1_train 的 my_save / s2_train 的 savee，格式和最终
    注册音色用的完全一样），这里把它按项目取最新一轮返回，所以同一个 id
    （live:<项目>）的内容会随训练自动往前更新。
    """
    require_key(authorization, x_api_key)
    return {"ok": True, "items": tts.list_live_voices(), "prefix": train.LIVE_VOICE_PREFIX}


@app.get("/api/projects/{slug:path}/live")
async def projects_live(
    slug: str,
    gpt: int = 0,
    s2: int = 0,
    authorization: str | None = Header(None),
    x_api_key: str | None = Header(None),
):
    """单个项目的中间模型快照。?gpt=12&s2=5 固定轮次（横向对比用），都不传＝跟随最新。"""
    require_key(authorization, x_api_key)
    try:
        return {"ok": True, **train.live_model(slug, int(gpt or 0), int(s2 or 0), use_cache=False)}
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
    # 语种：留空 = 按文本字符自动判定（推荐）。可显式给 zh / ja / en / ko / yue /
    # all_zh / all_ja / auto…，也接受"中文/日文/中英混合"这类写法。
    # 注意 "auto" 会让引擎用语言识别器去猜每个分句，纯汉字句常被误判成日语，
    # 所以留空时插件自己按字符判定（假名才是日文证据），而不是转发 auto。
    text_lang: str = ""
    lang: str = ""
    prompt_lang: str = ""
    top_k: int = 5
    top_p: float = 1.0
    temperature: float = 1.0
    text_split_method: str = "cut5"
    batch_size: int = 1
    seed: int = -1
    # 采样步数：0 = 用服务端默认（面板下拉框，存 infer.json）。
    # 只对 v2Pro/v3/v4/v5 的 s2 有效；v1/v2 会被引擎忽略。
    sample_steps: int = 0


def _steps_from_request(request: "Request", body_value: Any) -> int:
    """采样步数的取值优先级：X-Sample-Steps 头 > ?steps= > body.sample_steps > 服务端默认。"""
    raw = request.headers.get("x-sample-steps") or request.query_params.get("steps") or body_value
    return int(tts.normalize_sample_steps(raw, None) or 0)


@app.post("/api/tts")
async def api_tts(
    body: TtsBody,
    request: Request,
    authorization: str | None = Header(None),
    x_api_key: str | None = Header(None),
):
    # 语种优先级：面板「语种」策略（默认仅中文·锁定）> X-Text-Lang 头 > ?lang= >
    # body.lang > body.text_lang。锁定状态下后面的都会被忽略，详见 tts.decide_text_lang。
    require_key(authorization, x_api_key)
    tl = str(request.query_params.get("lang") or "") or body.lang or body.text_lang
    hdr = request.headers.get("x-text-lang")
    if hdr:
        tl = hdr
    r = tts.synthesize(
        body.text,
        voice_id=body.voice,
        speed=body.speed,
        media_type=body.media_type,
        text_lang=tl,
        prompt_lang=body.prompt_lang or (request.headers.get("x-prompt-lang") or ""),
        top_k=body.top_k,
        top_p=body.top_p,
        temperature=body.temperature,
        text_split_method=body.text_split_method,
        batch_size=body.batch_size,
        seed=body.seed,
        sample_steps=_steps_from_request(request, body.sample_steps),
    )
    if not r.get("ok"):
        _raise_tts_error(r)
    return Response(
        content=r["audio"],
        media_type=r.get("contentType", "audio/wav"),
        headers=_tts_headers(r),
    )


class OpenAiSpeechBody(BaseModel):
    model: str = "gpt-sovits"
    input: str
    voice: str = ""
    response_format: str = "wav"
    speed: float = 1.0
    # 非 OpenAI 标准字段，但透传很方便：留空 = 按文本判定语种
    lang: str = ""
    text_lang: str = ""
    # 非标准字段：采样步数（0 = 用服务端默认）。同样支持 ?steps= 与 X-Sample-Steps 头。
    sample_steps: int = 0


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
    request: Request,
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
    # 标准 OpenAI 客户端不会传语种 → 由面板「语种」策略决定（默认仅中文）。
    # 只有策略**未锁定**时，body.lang / ?lang= / X-Text-Lang 才会被采纳。
    tl = str(request.query_params.get("lang") or "") or body.lang or body.text_lang
    hdr = request.headers.get("x-text-lang")
    if hdr:
        tl = hdr
    r = tts.synthesize(
        str(body.input or ""),
        voice_id=str(body.voice or ""),
        speed=float(body.speed or 1.0),
        media_type=media_type,
        text_lang=tl,
        prompt_lang=request.headers.get("x-prompt-lang") or "",
        sample_steps=_steps_from_request(request, body.sample_steps),
    )
    if not r.get("ok"):
        _raise_tts_error(r)
    mime = r.get("contentType") or f"audio/{media_type}"
    return Response(
        content=r["audio"],
        media_type=mime,
        headers=_tts_headers(r),
    )


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
