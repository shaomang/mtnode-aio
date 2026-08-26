"""GPT-SoVITS engine orchestration: weights, voices, api_v2 subprocess, synthesis proxy."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parent.parent
ENGINE_DIR = ROOT / "engine"
PRETRAINED_DIR = ENGINE_DIR / "GPT_SoVITS" / "pretrained_models"
VOICES_DIR = ROOT / "voices"
LOG_DIR = ROOT / "logs"
DEFAULT_SOVITS_PORT = 9880

_log_fn: Callable[[str], None] | None = None
_lock = threading.Lock()


def set_logger(fn: Callable[[str], None]) -> None:
    global _log_fn
    _log_fn = fn


def log(msg: str) -> None:
    line = f"[tts] {msg}"
    if _log_fn:
        _log_fn(line)
    else:
        print(line, flush=True)


def engine_ready() -> bool:
    """True when the GPT-SoVITS clone + pretrained weights are on disk."""
    if not (ENGINE_DIR / "api_v2.py").is_file():
        return False
    gpt = _default_gpt_weights()
    sovits = _default_sovits_weights()
    return bool(gpt and gpt.is_file() and sovits and sovits.is_file())


def _default_gpt_weights() -> Path | None:
    candidates = [
        PRETRAINED_DIR / "s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt",
        PRETRAINED_DIR / "s1bert25hz-2kh-longer-epoch=68e-step=50232.ckpt",
        PRETRAINED_DIR / "GPT_weights_v2.ckpt",
        PRETRAINED_DIR / "GPT_weights_v1.ckpt",
    ]
    for p in candidates:
        if p.is_file():
            return p
    return None


def _default_sovits_weights() -> Path | None:
    candidates = [
        PRETRAINED_DIR / "s2G488k.pth",
        PRETRAINED_DIR / "s2G233k.pth",
        PRETRAINED_DIR / "SoVITS_weights_v2.pth",
        PRETRAINED_DIR / "SoVITS_weights_v1.pth",
    ]
    for p in candidates:
        if p.is_file():
            return p
    return None


# ---------------- voices ----------------

def list_voices() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if not VOICES_DIR.is_dir():
        return out
    for sub in sorted(VOICES_DIR.iterdir()):
        if not sub.is_dir():
            continue
        wav = sub / "ref.wav"
        if not wav.is_file():
            continue
        txt = sub / "ref.txt"
        lang = sub / "ref.lang"
        prompt = ""
        langv = "auto"
        try:
            if txt.is_file():
                prompt = txt.read_text(encoding="utf-8").strip()
        except Exception:
            pass
        try:
            if lang.is_file():
                langv = lang.read_text(encoding="utf-8").strip() or "auto"
        except Exception:
            pass
        weights = None
        trained = False
        try:
            if (sub / "weights.json").is_file():
                weights = json.loads((sub / "weights.json").read_text(encoding="utf-8"))
                trained = bool(weights and weights.get("gpt") and weights.get("sovits"))
        except Exception:
            pass
        out.append(
            {
                "id": sub.name,
                "name": sub.name,
                "refAudio": str(wav),
                "promptText": prompt,
                "lang": langv,
                "sizeBytes": wav.stat().st_size if wav.exists() else 0,
                "trained": trained,
                "weights": weights,
            }
        )
    return out


def get_voice(voice_id: str) -> dict[str, Any] | None:
    vid = str(voice_id or "").strip()
    if not vid:
        return None
    for v in list_voices():
        if v["id"] == vid or v["name"] == vid:
            return v
    return None


def add_voice(voice_id: str, wav_bytes: bytes, prompt_text: str = "", lang: str = "auto") -> dict[str, Any]:
    vid = str(voice_id or "").strip().replace("\\", "_").replace("/", "_")
    if not vid:
        raise ValueError("voice_id_required")
    if not wav_bytes:
        raise ValueError("wav_required")
    d = VOICES_DIR / vid
    d.mkdir(parents=True, exist_ok=True)
    (d / "ref.wav").write_bytes(wav_bytes)
    (d / "ref.txt").write_text(str(prompt_text or ""), encoding="utf-8")
    (d / "ref.lang").write_text(str(lang or "auto"), encoding="utf-8")
    log(f"voice added: {vid}")
    return get_voice(vid)  # type: ignore[return-value]


def remove_voice(voice_id: str) -> bool:
    vid = str(voice_id or "").strip()
    if not vid:
        return False
    d = VOICES_DIR / vid
    if d.is_dir():
        import shutil

        shutil.rmtree(d, ignore_errors=True)
        log(f"voice removed: {vid}")
        return True
    return False


# ---------------- engine subprocess ----------------

_engine_proc: subprocess.Popen | None = None
_engine_port = DEFAULT_SOVITS_PORT


def _is_alive(pid: int | None) -> bool:
    if not pid or pid <= 0:
        return False
    if sys.platform == "win32":
        try:
            out = subprocess.check_output(
                ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
                stderr=subprocess.DEVNULL,
                text=True,
                errors="ignore",
            )
            return str(pid) in out and "No tasks" not in out
        except Exception:
            return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _http_ok(url: str, timeout: float = 3.0) -> bool:
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return 200 <= int(resp.status) < 300
    except Exception:
        return False


def engine_http_base(port: int | None = None) -> str:
    return f"http://127.0.0.1:{int(port or _engine_port)}"


def engine_up(port: int | None = None) -> bool:
    return _http_ok(engine_http_base(port) + "/", timeout=2.0)


def _kill_pid(pid: int) -> None:
    if not pid:
        return
    if sys.platform == "win32":
        subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    else:
        try:
            os.kill(pid, 15)
        except OSError:
            pass


def start_engine(port: int | None = None) -> dict[str, Any]:
    global _engine_proc, _engine_port
    with _lock:
        port = int(port or _engine_port or DEFAULT_SOVITS_PORT)
        if engine_up(port):
            _engine_port = port
            return {"ok": True, "reused": True, "port": port}
        if not engine_ready():
            return {"ok": False, "error": "engine_not_ready"}
        gpt = _default_gpt_weights()
        sovits = _default_sovits_weights()
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        log_file = LOG_DIR / f"sovits-{port}.log"
        flags = 0
        if sys.platform == "win32":
            flags = subprocess.CREATE_NEW_PROCESS_GROUP | getattr(
                subprocess, "CREATE_NO_WINDOW", 0x08000000
            )
        log_fp = open(log_file, "ab")
        args = [
            sys.executable,
            "api_v2.py",
            "-a",
            "127.0.0.1",
            "-p",
            str(port),
            "-gpt_weights",
            str(gpt),
            "-sovits_weights",
            str(sovits),
        ]
        log(f"starting api_v2 on :{port} gpt={gpt.name} sovits={sovits.name}")
        _engine_proc = subprocess.Popen(
            args,
            cwd=str(ENGINE_DIR),
            stdout=log_fp,
            stderr=subprocess.STDOUT,
            creationflags=flags,
        )
        _engine_port = port

    def _wait() -> None:
        deadline = time.time() + 300
        while time.time() < deadline:
            if not _is_alive(_engine_proc.pid if _engine_proc else None):
                log("engine process exited early; see " + str(log_file))
                return
            if engine_up(port):
                log(f"engine ready :{port}")
                return
            time.sleep(3)
        log(f"engine start timeout :{port}")

    threading.Thread(target=_wait, daemon=True).start()
    return {"ok": True, "port": port, "pid": _engine_proc.pid}


def stop_engine() -> dict[str, Any]:
    global _engine_proc, _current_weights
    _current_weights = None
    with _lock:
        proc = _engine_proc
        _engine_proc = None
    if proc and proc.pid:
        _kill_pid(proc.pid)
    # kill port listener as fallback
    if sys.platform == "win32":
        try:
            out = subprocess.check_output(
                [
                    "powershell.exe",
                    "-NoProfile",
                    "-Command",
                    f"(Get-NetTCPConnection -LocalPort {_engine_port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)",
                ],
                stderr=subprocess.DEVNULL,
                text=True,
                errors="ignore",
                timeout=10,
            )
            pid = int(str(out or "").strip())
            if pid:
                _kill_pid(pid)
        except Exception:
            pass
    return {"ok": True}


def _post_json(url: str, payload: dict[str, Any], timeout: float = 120.0) -> dict[str, Any]:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        try:
            return {"ok": True, "json": json.loads(raw.decode("utf-8"))}
        except Exception:
            return {"ok": True, "raw": raw}


def _set_ref_audio(voice: dict[str, Any], port: int) -> dict[str, Any]:
    base = engine_http_base(port)
    for _ in range(40):
        if engine_up(port):
            break
        time.sleep(1.5)
    if not engine_up(port):
        return {"ok": False, "error": "engine_not_ready"}
    try:
        r = _post_json(
            base + "/set_ref_audio",
            {
                "ref_audio_path": voice["refAudio"],
                "prompt_text": voice["promptText"],
                "prompt_lang": voice["lang"],
            },
        )
        if r.get("ok"):
            log(f"ref audio set: {voice['id']}")
            return {"ok": True}
        return {"ok": False, "error": str(r)}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# cache of currently loaded weights (pid, gpt, sovits) to avoid redundant reloads
_current_weights: tuple[int | None, str | None, str | None] | None = None


def _set_voice_weights(weights: dict[str, Any], port: int) -> dict[str, Any]:
    """Switch the running engine to trained weights (api_v2 /set_gpt_weights + /set_sovits_weights)."""
    global _current_weights
    gpt = str(weights.get("gpt") or "")
    sovits = str(weights.get("sovits") or "")
    if not gpt or not sovits:
        return {"ok": False, "error": "weights_incomplete"}
    pid = _engine_proc.pid if _engine_proc else None
    if _current_weights and _current_weights[0] == pid and _current_weights[1] == gpt and _current_weights[2] == sovits:
        return {"ok": True}
    base = engine_http_base(port)
    for _ in range(40):
        if engine_up(port):
            break
        time.sleep(1.5)
    if not engine_up(port):
        return {"ok": False, "error": "engine_not_ready"}
    try:
        r1 = _post_json(base + "/set_gpt_weights", {"gpt_weights_path": gpt}, timeout=300.0)
        if not r1.get("ok"):
            return {"ok": False, "error": "set_gpt_weights_failed"}
        r2 = _post_json(base + "/set_sovits_weights", {"sovits_weights_path": sovits}, timeout=300.0)
        if not r2.get("ok"):
            return {"ok": False, "error": "set_sovits_weights_failed"}
    except Exception as e:
        return {"ok": False, "error": str(e)}
    _current_weights = (pid, gpt, sovits)
    log(f"voice weights loaded: gpt={Path(gpt).name} sovits={Path(sovits).name}")
    return {"ok": True}


def synthesize(
    text: str,
    voice_id: str = "",
    port: int | None = None,
    speed: float = 1.0,
    media_type: str = "wav",
    **extra: Any,
) -> dict[str, Any]:
    port = int(port or _engine_port or DEFAULT_SOVITS_PORT)
    if not engine_up(port):
        r = start_engine(port)
        if not r.get("ok"):
            return {"ok": False, "error": r.get("error", "engine_down")}
    text = str(text or "").strip()
    if not text:
        return {"ok": False, "error": "text_required"}
    voice = None
    if voice_id:
        voice = get_voice(voice_id)
        if not voice:
            return {"ok": False, "error": "voice_not_found"}
    else:
        voices = list_voices()
        if not voices:
            return {"ok": False, "error": "no_voice"}
        voice = voices[0]
    if voice:
        if voice.get("weights"):
            wr = _set_voice_weights(voice["weights"], port)
            if not wr.get("ok"):
                return wr
        sr = _set_ref_audio(voice, port)
        if not sr.get("ok"):
            return sr
    payload: dict[str, Any] = {
        "text": text,
        "text_lang": extra.get("text_lang", "auto"),
        "ref_audio_path": voice["refAudio"] if voice else "",
        "prompt_text": voice["promptText"] if voice else "",
        "prompt_lang": voice["lang"] if voice else "auto",
        "top_k": int(extra.get("top_k", 5)),
        "top_p": float(extra.get("top_p", 1.0)),
        "temperature": float(extra.get("temperature", 1.0)),
        "text_split_method": str(extra.get("text_split_method", "cut5")),
        "batch_size": int(extra.get("batch_size", 1)),
        "speed_factor": float(speed),
        "stream_mode": False,
        "media_type": str(media_type or "wav"),
        "seed": int(extra.get("seed", -1)),
    }
    try:
        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            engine_http_base(port) + "/tts",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=600) as resp:
            audio = resp.read()
            ctype = resp.headers.get("content-type") or "audio/wav"
        if not audio:
            return {"ok": False, "error": "empty_audio"}
        return {"ok": True, "audio": audio, "contentType": ctype, "voice": voice["id"] if voice else ""}
    except Exception as e:
        return {"ok": False, "error": str(e)}
