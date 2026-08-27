"""Project-based audio fine-tune for GPT-SoVITS (GPT-TTS training).

Flow (mirrors the official GPT-SoVITS pipeline):
  1. create project (name)  -> projects/<name>/
  2. upload audio (+ optional transcript .txt) -> saved & recorded in the project folder
  3. train: 1-get-text.py (ASR, skipped when transcript provided)
           -> 2-get-hubert-wav32k.py -> 3-get-semantic.py
           -> s1_train.py (GPT) -> s2_train.py (SoVITS)
  4. on success: register a voice named after the project (ref audio + trained
     weights) so the plugin UI can synthesize with it right away.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import wave
import zipfile
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parent.parent
ENGINE_DIR = ROOT / "engine"
PROJECTS_DIR = ROOT / "projects"
VOICES_DIR = ROOT / "voices"
DEFAULT_SOVITS_PORT = 9880

_log_fn: Callable[[str], None] | None = None


def set_logger(fn: Callable[[str], None]) -> None:
    global _log_fn
    _log_fn = fn


def log(msg: str) -> None:
    line = f"[train] {msg}"
    if _log_fn:
        _log_fn(line)
    else:
        print(line, flush=True)


# ---------------- project fs ----------------

def _slug(name: str) -> str:
    s = str(name or "").strip()
    s = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", s)
    s = re.sub(r"\s+", "_", s).strip("._ ")
    return (s[:64] or "project")


def _manifest_path(slug: str) -> Path:
    return PROJECTS_DIR / slug / "manifest.json"


def _default_manifest(name: str) -> dict[str, Any]:
    slug = _slug(name)
    return {
        "name": name.strip(),
        "slug": slug,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "status": "created",  # created|ready|training|trained|failed
        "phase": "",
        "phaseLabel": "",
        "pct": 0,
        "detail": "",
        "error": "",
        "files": [],
        "audioCount": 0,
        "hasTranscript": False,
        "durationSec": 0.0,
        "expName": "",
        "speaker": "",
        "weights": None,
        "trainedAt": "",
    }


_manifest_lock = threading.RLock()


def _read_manifest(slug: str) -> dict[str, Any] | None:
    p = _manifest_path(slug)
    if not p.is_file():
        return None
    with _manifest_lock:
        try:
            m = json.loads(p.read_text(encoding="utf-8"))
            base = _default_manifest(m.get("name") or slug)
            base.update(m)
            return base
        except Exception:
            return None


def _write_manifest(slug: str, m: dict[str, Any]) -> None:
    """Persist the project manifest. NEVER raises: a failed persist must not
    kill the training thread or 500 the status endpoint. In-process reads and
    writes are serialized with _manifest_lock; the atomic replace is retried
    (on Windows the destination can be briefly locked by a concurrent read or
    by antivirus scanning — WinError 5), and falls back to a plain write."""
    p = _manifest_path(slug)
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
    except Exception:
        return
    data = json.dumps(m, ensure_ascii=False, indent=2)
    with _manifest_lock:
        tmp = p.with_suffix(".tmp")
        for attempt in range(6):
            try:
                tmp.write_text(data, encoding="utf-8")
                tmp.replace(p)
                return
            except OSError:
                try:
                    tmp.unlink(missing_ok=True)
                except Exception:
                    pass
                time.sleep(0.05 * (attempt + 1))
        # fallback: best-effort direct write
        try:
            p.write_text(data, encoding="utf-8")
        except Exception as e:  # noqa: BLE001
            log(f"manifest persist failed for {slug}: {e}")


def _normalize(m: dict[str, Any], slug: str) -> dict[str, Any]:
    """Mark a dangling 'training' status (backend restarted mid-train) as failed."""
    if m.get("status") == "training" and slug not in _running:
        m["status"] = "failed"
        m["phaseLabel"] = "训练中断"
        m["error"] = m.get("error") or "interrupted"
        _write_manifest(slug, m)
    return m


def list_projects() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if not PROJECTS_DIR.is_dir():
        return out
    for sub in sorted(PROJECTS_DIR.iterdir()):
        if not sub.is_dir():
            continue
        m = _read_manifest(sub.name)
        if not m:
            continue
        m = _normalize(m, sub.name)
        m = dict(m)
        m["running"] = sub.name in _running
        out.append(m)
    return out


def create_project(name: str) -> dict[str, Any]:
    slug = _slug(name)
    if not slug:
        raise ValueError("name_required")
    d = PROJECTS_DIR / slug
    if d.is_dir() and _manifest_path(slug).is_file():
        raise ValueError("project_exists")
    d.mkdir(parents=True, exist_ok=True)
    (d / "audio").mkdir(exist_ok=True)
    (d / "text").mkdir(exist_ok=True)
    (d / "logs").mkdir(exist_ok=True)
    m = _default_manifest(name)
    _write_manifest(slug, m)
    log(f"project created: {slug}")
    return m


def get_project(name: str) -> dict[str, Any] | None:
    slug = _slug(name)
    m = _read_manifest(slug)
    if not m:
        return None
    m = _normalize(m, slug)
    m = dict(m)
    m["running"] = slug in _running
    return m


# ---------------- project detail (preview) ----------------

def _project_files(slug: str) -> list[dict[str, Any]]:
    """Actual files under projects/<slug>/audio + text, with wav duration."""
    d = PROJECTS_DIR / slug
    out: list[dict[str, Any]] = []
    audio_dir = d / "audio"
    if audio_dir.is_dir():
        for p in sorted(audio_dir.iterdir()):
            if not p.is_file():
                continue
            dur = _wav_duration(p) if p.suffix.lower() == ".wav" else 0.0
            try:
                size = p.stat().st_size
            except Exception:
                size = 0
            out.append({"name": p.name, "kind": "audio", "size": size, "dur": round(dur, 2)})
    text_dir = d / "text"
    if text_dir.is_dir():
        for p in sorted(text_dir.iterdir()):
            if not p.is_file():
                continue
            try:
                size = p.stat().st_size
            except Exception:
                size = 0
            out.append({"name": p.name, "kind": "text", "size": size})
    return out


def _read_transcript(p: Path) -> str:
    try:
        if p.is_file():
            return p.read_text(encoding="utf-8-sig").strip()
    except Exception:
        pass
    return ""


def project_detail(name: str) -> dict[str, Any]:
    """Project view for the UI: files (with durations) + transcript text."""
    slug = _slug(name)
    m = _read_manifest(slug)
    if not m:
        raise ValueError("project_not_found")
    m = _normalize(m, slug)
    m = dict(m)
    m["running"] = slug in _running
    m["files"] = _project_files(slug)
    m["transcript"] = _read_transcript(PROJECTS_DIR / slug / "text" / "transcript.txt")
    return m


def project_audio_path(name: str, filename: str) -> Path:
    """Resolve an uploaded audio file by name; raises ValueError on bad input."""
    slug = _slug(name)
    if not _manifest_path(slug).is_file():
        raise ValueError("project_not_found")
    base = Path(str(filename or "")).name
    if not base or base in (".", ".."):
        raise ValueError("invalid_filename")
    p = PROJECTS_DIR / slug / "audio" / base
    if not p.is_file():
        raise ValueError("file_not_found")
    return p


# ---------------- upload ----------------

def _wav_duration(path: Path) -> float:
    try:
        with wave.open(str(path), "rb") as w:
            fr = w.getframerate()
            return round(w.getnframes() / fr, 2) if fr else 0.0
    except Exception:
        return 0.0


def upload_files(
    name: str,
    files: list[tuple[str, bytes]] | None = None,
    transcript_text: str = "",
    transcript_file: tuple[str, bytes] | None = None,
) -> dict[str, Any]:
    slug = _slug(name)
    m = _read_manifest(slug)
    if not m:
        raise ValueError("project_not_found")
    d = PROJECTS_DIR / slug
    audio_dir = d / "audio"
    text_dir = d / "text"
    audio_dir.mkdir(exist_ok=True)
    text_dir.mkdir(exist_ok=True)
    total_dur = float(m.get("durationSec") or 0.0)
    audio_count = int(m.get("audioCount") or 0)

    for fname, data in files or []:
        if not data:
            continue
        fname = Path(str(fname or "")).name or "file.bin"
        if fname.lower().endswith((".txt", ".list", ".lab")):
            text_dir.joinpath("transcript.txt").write_bytes(data)
            m["hasTranscript"] = True
            m["files"].append({"name": fname, "kind": "text", "size": len(data), "ts": time.time()})
            continue
        target = _uniq_path(audio_dir, fname)
        target.write_bytes(data)
        dur = _wav_duration(target) if target.suffix.lower() == ".wav" else 0.0
        total_dur += dur
        audio_count += 1
        m["files"].append({"name": fname, "kind": "audio", "size": len(data), "dur": round(dur, 2), "ts": time.time()})

    if transcript_file and transcript_file[1]:
        text_dir.joinpath("transcript.txt").write_bytes(transcript_file[1])
        m["hasTranscript"] = True
        m["files"].append({"name": transcript_file[0] or "transcript.txt", "kind": "text", "size": len(transcript_file[1]), "ts": time.time()})
    if str(transcript_text or "").strip():
        text_dir.joinpath("transcript.txt").write_text(str(transcript_text), encoding="utf-8")
        m["hasTranscript"] = True

    m["audioCount"] = audio_count
    if audio_count:
        m["durationSec"] = round(total_dur, 1)
    if m["status"] in ("created", "failed"):
        m["status"] = "ready"
        m["error"] = ""
    _write_manifest(slug, m)
    log(f"project {slug} upload: audio={audio_count} dur={m['durationSec']}s transcript={m['hasTranscript']}")
    return m


def _uniq_path(d: Path, fname: str) -> Path:
    p = d / fname
    if not p.exists():
        return p
    stem, suf = p.stem, p.suffix
    i = 1
    while True:
        q = d / f"{stem}_{i}{suf}"
        if not q.exists():
            return q
        i += 1


# ---------------- training runner ----------------

_train_lock = threading.Lock()
_running: dict[str, dict[str, Any]] = {}  # slug -> {proc, phase, phaseLabel, pct, cancel, detail}

# ordered fine-grained training steps (phase -> label) surfaced to the UI
TRAIN_STEPS: list[tuple[str, str]] = [
    ("prep", "准备数据集"),
    ("audio", "整理音频"),
    ("list", "文字标注"),
    ("text", "文字转音素 (BERT)"),
    ("hubert", "HuBERT 特征"),
    ("semantic", "语义 token"),
    ("s1", "GPT 模型训练 (s1)"),
    ("s2", "SoVITS 模型训练 (s2)"),
    ("final", "注册音色"),
]

_STEP_ORDER: dict[str, int] = {ph: i for i, (ph, _lb) in enumerate(TRAIN_STEPS)}


def _step_index(phase: str) -> int:
    return _STEP_ORDER.get(phase or "", -1)


class _TrainCancelled(BaseException):
    """Raised inside the train thread when the user cancels a run."""

    def __init__(self) -> None:
        super().__init__("training cancelled by user")


def _cuda_available() -> bool:
    """Lazy CUDA probe — only imports torch once training actually starts."""
    try:
        import torch

        return bool(torch.cuda.is_available())
    except Exception:
        return False


_PYLIBS = ROOT / ".pylibs"


def _has_nvidia_gpu() -> bool:
    """CUDA-capable GPU probe (nvidia-smi) — decides CPU vs CUDA torch."""
    for cand in ("nvidia-smi", r"C:\Windows\System32\nvidia-smi.exe"):
        p = shutil.which(cand) or (cand if os.path.exists(cand) else None)
        if not p:
            continue
        try:
            r = subprocess.run([p], capture_output=True, timeout=10)
            return r.returncode == 0
        except Exception:
            return False
    return False


def _clean_pylibs_torch() -> None:
    """Remove a corrupted / CPU-only torch install from .pylibs before reinstalling."""
    for name in ("torch", "torchaudio", "torchgen", "functorch", "torchvision", "torch_einops_utils"):
        shutil.rmtree(_PYLIBS / name, ignore_errors=True)
    for di in (
        list(_PYLIBS.glob("torch-*.dist-info"))
        + list(_PYLIBS.glob("torchaudio-*.dist-info"))
        + list(_PYLIBS.glob("torchvision-*.dist-info"))
        + list(_PYLIBS.glob("torch_einops_utils-*.dist-info"))
    ):
        shutil.rmtree(di, ignore_errors=True)


def _semantic_stack_error() -> str | None:
    """Verify the exact import chain 3-get-semantic needs (module.models ->
    f5_tts.model.DiT -> x_transformers). Returns an error description when
    broken, None when importable.

    x_transformers>=2.28 hard-requires torch-einops-utils, einx and loguru.
    _clean_pylibs_torch() deletes the torch_einops_utils PACKAGE dir when
    repairing a CPU-only torch, but the torch-only reinstall never brings its
    dependencies back — leaving dist-info without the package body, which makes
    `from x_transformers.x_transformers import ...` die with ModuleNotFoundError
    exactly where the semantic phase failed."""
    gpt_root = str(ENGINE_DIR / "GPT_SoVITS")
    old_path = list(sys.path)
    # Mirror the subprocess PYTHONPATH order (gpt_root BEFORE engine root so
    # 'module' / 'text' / 'tools' resolve inside GPT_SoVITS/, not engine/).
    for p in (gpt_root, str(ENGINE_DIR)):
        if p not in sys.path:
            sys.path.insert(0, p)
    try:
        try:
            import x_transformers.x_transformers  # noqa: F401
        except Exception as e:  # noqa: BLE001
            return f"x_transformers import failed: {e}"
        try:
            from GPT_SoVITS.f5_tts.model.backbones.dit import DiT  # noqa: F401
        except Exception as e:  # noqa: BLE001
            return f"f5_tts/model import failed: {e}"
        return None
    finally:
        sys.path[:] = old_path


def _ensure_nltk_data() -> None:
    """Best-effort download of the NLTK averaged_perceptron_tagger_eng data.

    1-get-text.py routes lines whose language is detected as English through
    text/english.py, which calls nltk.pos_tag -> the averaged_perceptron_tagger
    data. The engine never ships it, so English lines (e.g. ASR fragments like
    "no CGI") fail with LookupError and those clips are silently dropped from
    the s1 dataset. Download into ROOT/nltk_data (owned by the backend process)
    and let subprocesses find it via the NLTK_DATA env var. Non-fatal: if every
    mirror fails we just log a warning and training continues without those
    clips."""
    data_dir = ROOT / "nltk_data"
    tag_dir = data_dir / "taggers" / "averaged_perceptron_tagger_eng"
    try:
        if tag_dir.is_dir() and any(tag_dir.iterdir()):
            return
        data_dir.mkdir(parents=True, exist_ok=True)
        # migrate the misplaced layout from an earlier bug (zip extracted to
        # data_dir root instead of taggers/ — NLTK then reports "resource not
        # found" because it searches nltk_data/taggers/...)
        misplaced = data_dir / "averaged_perceptron_tagger_eng"
        if misplaced.is_dir() and any(misplaced.iterdir()):
            (data_dir / "taggers").mkdir(parents=True, exist_ok=True)
            shutil.move(str(misplaced), str(tag_dir))
            log("NLTK tagger data migrated to taggers/")
            return
    except Exception:  # noqa: BLE001
        return

    zname = "averaged_perceptron_tagger_eng.zip"
    urls = [
        "https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages/taggers/" + zname,
        "https://ghfast.top/https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages/taggers/" + zname,
        "https://gh-proxy.com/https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages/taggers/" + zname,
    ]
    tmp_zip = data_dir / zname
    for url in urls:
        try:
            log("downloading NLTK tagger data (english g2p)…")
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=45) as r, open(tmp_zip, "wb") as f:
                shutil.copyfileobj(r, f)
            # the zip's top-level folder is "averaged_perceptron_tagger_eng",
            # so extract under taggers/ to match NLTK's expected layout
            (data_dir / "taggers").mkdir(parents=True, exist_ok=True)
            with zipfile.ZipFile(tmp_zip) as zf:
                zf.extractall(data_dir / "taggers")
            try:
                tmp_zip.unlink()
            except Exception:  # noqa: BLE001
                pass
            if tag_dir.is_dir() and any(tag_dir.iterdir()):
                log("NLTK tagger data ready: " + str(tag_dir))
                return
        except Exception as e:  # noqa: BLE001
            log(f"warn: NLTK tagger download failed ({url}): {e}")
            try:
                tmp_zip.unlink()
            except Exception:  # noqa: BLE001
                pass
    log("warn: NLTK tagger data unavailable — 英文片段将跳过（不影响训练）")


def _ensure_train_deps() -> None:
    """Make sure the training stack (torch CUDA, pandas, matplotlib,
    transformers, librosa, ...) is importable. The backend process can write
    the install dir, so we pip install --target ROOT/.pylibs (same trick as
    the python-multipart self-heal) and prepend it to sys.path. Runs only
    when something is missing; a CPU-only torch on a CUDA machine counts as
    missing and is repaired with the cu126 build."""
    _PYLIBS.mkdir(parents=True, exist_ok=True)
    if str(_PYLIBS) not in sys.path:
        sys.path.insert(0, str(_PYLIBS))
    _ensure_nltk_data()
    gpu = _has_nvidia_gpu()

    torch_ok = False
    try:
        import torch  # noqa: F401

        torch_ok = (not gpu) or bool(torch.cuda.is_available())
    except Exception:
        torch_ok = False
    core_ok = False
    try:
        import pandas  # noqa: F401
        import matplotlib  # noqa: F401
        import transformers  # noqa: F401
        import librosa  # noqa: F401

        core_ok = True
    except Exception:
        core_ok = False
    extra_ok = False
    try:
        import onnxruntime  # noqa: F401  # g2pw 拼音推理（engine requirements 误过滤）
        import faster_whisper  # noqa: F401  # 长音频切分后的逐段 ASR 转写

        extra_ok = True
    except Exception:
        extra_ok = False
    sem_err = _semantic_stack_error()
    if torch_ok and core_ok and sem_err is None and extra_ok:
        log("train deps ready: torch " + torch.__version__ + " cuda=" + str(torch.cuda.is_available()))
        return

    idx = "https://pypi.tuna.tsinghua.edu.cn/simple"
    host = "pypi.tuna.tsinghua.edu.cn"

    def _pip(args: list[str]) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, "-m", "pip", "install", "--target", str(_PYLIBS)] + args,
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )

    if not torch_ok:
        if gpu:
            log("torch missing or CPU-only on a CUDA machine — installing CUDA build into .pylibs (torch 2.6.0+cu126 ~2.5GB, may take minutes)")
            # Pin the exact +cu126 local version so pip can never satisfy the
            # requirement with the CPU wheel (a bare "torch==2.6.0" on a cu126
            # index silently installed CPU torch, leaving .cuda_available() False).
            # Install straight from download.pytorch.org: the aliyun cu126 mirror
            # is unreliable for the multi-GB wheels (serves CPU for the bare pin
            # and hangs mid-transfer), which left training stuck.
            _clean_pylibs_torch()
            r = _pip([
                "torch==2.6.0+cu126", "torchaudio==2.6.0+cu126",
                "--index-url", "https://download.pytorch.org/whl/cu126",
                "--timeout", "120",
            ])
        else:
            log("torch missing — installing CPU build into .pylibs")
            r = _pip(["torch==2.6.0", "torchaudio==2.6.0", "-i", idx, "--trusted-host", host])
        if r.returncode != 0:
            raise RuntimeError("torch install failed:\n" + (r.stdout or "")[-600:] + (r.stderr or "")[-600:])
        try:
            import torch  # noqa: F401

            torch_ok = (not gpu) or bool(torch.cuda.is_available())
        except Exception:
            torch_ok = False
        if not torch_ok:
            raise RuntimeError("torch still not CUDA-ready after install — see project logs")

    if not core_ok:
        req = ENGINE_DIR / "requirements.txt"
        if req.is_file():
            filtered = [
                ln for ln in req.read_text(encoding="utf-8").splitlines()
                if ln.strip()
                and not ln.lstrip().startswith(
                    ("--no-binary", "gradio", "funasr", "onnxruntime", "modelscope", "fastapi[standard]")
                )
            ]
            reqf = ENGINE_DIR / "requirements-train.txt"
            reqf.write_text("\n".join(filtered) + "\n", encoding="utf-8")
            r = _pip(["-r", str(reqf), "-i", idx, "--trusted-host", host])
            if r.returncode != 0:
                raise RuntimeError("engine train deps install failed:\n" + (r.stdout or "")[-600:] + (r.stderr or "")[-600:])
        # pandas + matplotlib are imported at module top level by the engine
        # (module/AR datasets, tools.my_utils) but are NOT in requirements.txt.
        # The "numpy<2.0" constraint keeps pip from upgrading the pinned
        # numpy 1.26.x already in .pylibs (engine requires numpy<2.0 and
        # librosa 0.10.2 breaks on numpy 2).
        try:
            import pandas  # noqa: F401
        except Exception:
            r = _pip(["pandas", "numpy<2.0", "-i", idx, "--trusted-host", host])
            if r.returncode != 0:
                raise RuntimeError("pandas install failed:\n" + (r.stdout or "")[-600:] + (r.stderr or "")[-600:])
        try:
            import matplotlib  # noqa: F401
        except Exception:
            r = _pip(["matplotlib", "numpy<2.0", "-i", idx, "--trusted-host", host])
            if r.returncode != 0:
                raise RuntimeError("matplotlib install failed:\n" + (r.stdout or "")[-600:] + (r.stderr or "")[-600:])

    # f5_tts / x_transformers semantic stack (3-get-semantic -> module.models ->
    # f5_tts.model.DiT). A previous CPU->cu126 torch repair deleted the
    # torch_einops_utils package dir while keeping its dist-info, so the
    # x_transformers import died mid-training. Repair with --no-deps: letting
    # pip re-resolve would pull the CPU torch wheels from the tsinghua index
    # over the cu126 build in .pylibs (the exact trap that caused the CPU torch).
    if sem_err is not None:
        log(f"semantic stack broken: {sem_err} — repairing x_transformers deps into .pylibs")
        r = _pip(["--no-deps", "torch-einops-utils", "einx", "loguru", "x_transformers", "-i", idx, "--trusted-host", host])
        if r.returncode != 0:
            raise RuntimeError("x_transformers deps repair failed:\n" + (r.stdout or "")[-600:] + (r.stderr or "")[-600:])
        sem_err = _semantic_stack_error()
        if sem_err is not None:
            raise RuntimeError(f"semantic stack still broken after repair: {sem_err}")
        log("semantic stack repaired (x_transformers ready)")

    # g2pw 拼音推理需要 onnxruntime（engine requirements 把它与 onnxruntime-gpu
    # 一起过滤掉了，导致 1-get-text 音素化全挂）；CPU wheel 足够，numpy<2.0
    # 约束防止 pip 把 .pylibs 里钉死的 numpy 1.26.x 升级到 2.x。
    try:
        import onnxruntime  # noqa: F401
    except Exception:
        log("onnxruntime missing (g2pw 拼音推理需要) — installing into .pylibs")
        r = _pip(["onnxruntime", "numpy<2.0", "-i", idx, "--trusted-host", host])
        if r.returncode != 0:
            raise RuntimeError("onnxruntime install failed:\n" + (r.stdout or "")[-600:] + (r.stderr or "")[-600:])

    # 长音频自动切分后需要逐段转写（无匹配的逐句文字时）——faster-whisper
    # （ctranslate2/av/huggingface_hub 已随引擎依赖就位，只补包本体）。
    try:
        import faster_whisper  # noqa: F401
    except Exception:
        log("faster-whisper missing (长音频 ASR 转写需要) — installing into .pylibs")
        r = _pip(["faster-whisper", "numpy<2.0", "-i", idx, "--trusted-host", host])
        if r.returncode != 0:
            raise RuntimeError("faster-whisper install failed:\n" + (r.stdout or "")[-600:] + (r.stderr or "")[-600:])

    try:
        import torch  # noqa: F401
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(f"train deps still not importable: {e}") from e
    log("train deps ready: torch " + torch.__version__ + " cuda=" + str(torch.cuda.is_available()))


def _is_windows() -> bool:
    return sys.platform == "win32"


def _proc_flags() -> int:
    if not _is_windows():
        return 0
    return subprocess.CREATE_NEW_PROCESS_GROUP | getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)


def _kill_tree(proc: subprocess.Popen | None) -> None:
    if not proc or not proc.pid:
        return
    if _is_windows():
        subprocess.run(
            ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    else:
        try:
            proc.terminate()
        except Exception:
            pass


def _engine_installed() -> bool:
    return (ENGINE_DIR / "api_v2.py").is_file()


def _script_candidates(*names: str) -> list[Path]:
    out: list[Path] = []
    for n in names:
        for base in (ENGINE_DIR, ENGINE_DIR / "GPT_SoVITS"):
            p = base / n
            if p.is_file() and p not in out:
                out.append(p)
    return out


def _find_script(*names: str) -> Path | None:
    cands = _script_candidates(*names)
    return cands[0] if cands else None


def _load_config_template(name: str) -> str | None:
    for cand in _script_candidates(name):
        try:
            return cand.read_text(encoding="utf-8")
        except Exception:
            continue
    return None


def _cfg_dir() -> Path:
    p = ENGINE_DIR / "train_cfg"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _patch_engine_ckpt_save() -> None:
    """Make checkpoint saving robust on Windows BEFORE s1/s2 start.

    The stock GPT-SoVITS process_ckpt.my_save writes the tmp .pth into CWD and
    then shutil.move()s it into GPT_weights_v2 — that dir is never created by
    the headless pipeline, so every s1 epoch save dies with PermissionError /
    FileNotFoundError and the tmp file is abandoned in the engine root
    (observed: a 155MB '<float>.pth' orphan). It also has no retry, so a
    momentarily locked destination (Windows Defender scanning a fresh multi-hundred
    MB file) kills the run. Patch it in place (idempotent) and create the weight
    dirs up front. Runs inside the backend process, which owns the install dir."""
    # s2 (SoVITS) saves checkpoints via GPT_SoVITS/utils.py my_save — the same
    # fragile pattern (tmp file in CWD + shutil.move into a RELATIVE dir
    # data/<exp>/<spk>/logs_s2_<ver> that the headless pipeline never creates).
    # The very first s2 save dies with FileNotFoundError (observed:
    # 'data/aoi/aoi/logs_s2_v1/G_233333333333.pth'). Patch it identically:
    # mkdir + same-volume tmp + retry + direct fallback.
    utils_py = ENGINE_DIR / "GPT_SoVITS" / "utils.py"
    if not utils_py.is_file():
        log("warn: GPT_SoVITS/utils.py not found — skip utils my_save patch")
    else:
        try:
            usrc = utils_py.read_text(encoding="utf-8")
        except Exception as e:  # noqa: BLE001
            log(f"warn: cannot read utils.py: {e}")
            usrc = ""
        if usrc and "MTNode GPT-TTS" not in usrc:
            new_utils_save = '''def my_save(fea, path):  ##### patched by MTNode GPT-TTS: robust Windows save (mkdir + same-volume tmp + retry)
    import time
    dir = os.path.dirname(path)
    name = os.path.basename(path)
    if not dir:
        dir = "."
    try:
        os.makedirs(dir, exist_ok=True)
    except Exception:
        pass
    if os.path.exists(path):
        try:
            os.chmod(path, 0o666)
        except Exception:
            pass
        try:
            os.remove(path)
        except Exception:
            pass
    tmp_path = os.path.join(dir, "%s.pth" % (ttime()))
    torch.save(fea, tmp_path)
    last_err = None
    for i in range(10):
        try:
            os.replace(tmp_path, path)
            return
        except Exception as e:  # noqa: BLE001
            last_err = e
            time.sleep(0.3 * (i + 1))
    try:
        if os.path.exists(path):
            os.remove(path)
    except Exception:
        pass
    torch.save(fea, path)
    if os.path.exists(tmp_path):
        try:
            os.remove(tmp_path)
        except Exception:
            pass
'''
            try:
                start = usrc.index("def my_save(")
                end = usrc.index("def save_checkpoint(")
                usrc = usrc[:start] + new_utils_save + "\n" + usrc[end:]
                if "MTNode GPT-TTS" not in usrc:
                    raise RuntimeError("marker missing after utils patch")
            except Exception as e:  # noqa: BLE001
                log(f"warn: utils.py patch failed: {e}")
                usrc = ""
        if usrc:
            tmp = utils_py.with_suffix(".py.tmp")
            try:
                tmp.write_text(usrc, encoding="utf-8")
                for i in range(6):
                    try:
                        os.replace(str(tmp), str(utils_py))
                        break
                    except OSError:
                        time.sleep(0.3 * (i + 1))
                log("GPT_SoVITS/utils.py patched (robust my_save)")
            except Exception as e:  # noqa: BLE001
                log(f"warn: cannot write utils.py: {e}")

    gpt_weights = ENGINE_DIR / "GPT_weights_v2"
    sovits_weights = ENGINE_DIR / "SoVITS_weights_v2"
    logs_dir = ENGINE_DIR / "logs"
    for d in (gpt_weights, sovits_weights, logs_dir):
        try:
            d.mkdir(parents=True, exist_ok=True)
            log(f"weight dir ready: {d.name}")
        except Exception as e:  # noqa: BLE001
            log(f"warn: cannot mkdir {d}: {e}")

    # clean abandoned "<float>.pth" temp files left by the stock my_save
    try:
        tmp_re = re.compile(r"^\d+\.\d+\.pth$")
        for p in ENGINE_DIR.glob("*.pth"):
            if tmp_re.match(p.name):
                try:
                    p.unlink()
                    log(f"removed leftover ckpt tmp: {p.name}")
                except Exception:
                    pass
    except Exception:
        pass

    ckpt_py = ENGINE_DIR / "GPT_SoVITS" / "process_ckpt.py"
    if not ckpt_py.is_file():
        log("warn: process_ckpt.py not found — skip ckpt-save patch")
        return
    try:
        src = ckpt_py.read_text(encoding="utf-8")
    except Exception as e:  # noqa: BLE001
        log(f"warn: cannot read process_ckpt.py: {e}")
        return
    if "MTNode GPT-TTS" in src:
        log("process_ckpt.py already patched")
        return

    new_save = '''def my_save(fea, path):  ##### patched by MTNode GPT-TTS: robust Windows save (mkdir + retry + direct fallback)
    import time
    dir = os.path.dirname(path)
    name = os.path.basename(path)
    if not dir:
        dir = "."
    try:
        os.makedirs(dir, exist_ok=True)
    except Exception:
        pass
    # drop a stale/read-only destination so the atomic replace can win
    if os.path.exists(path):
        try:
            os.chmod(path, 0o666)
        except Exception:
            pass
        try:
            os.remove(path)
        except Exception:
            pass
    # write the temp file next to the destination (same volume -> atomic replace)
    tmp_path = os.path.join(dir, "%s.pth" % (ttime()))
    torch.save(fea, tmp_path)
    last_err = None
    for i in range(10):
        try:
            os.replace(tmp_path, path)  # fails only if dst is momentarily locked (AV scan etc.)
            return
        except Exception as e:  # noqa: BLE001
            last_err = e
            time.sleep(0.3 * (i + 1))
    # final fallback: direct overwrite
    try:
        if os.path.exists(path):
            os.remove(path)
    except Exception:
        pass
    torch.save(fea, path)
    if os.path.exists(tmp_path):
        try:
            os.remove(tmp_path)
        except Exception:
            pass
'''
    new_save2 = '''def my_save2(fea, path, model_version):  ##### patched by MTNode GPT-TTS: mkdir + retry
    import time
    dir = os.path.dirname(path)
    if dir:
        try:
            os.makedirs(dir, exist_ok=True)
        except Exception:
            pass
    bio = BytesIO()
    torch.save(fea, bio)
    bio.seek(0)
    data = bio.getvalue()
    byte = model_version2byte[model_version]
    data = byte + data[2:]
    last_err = None
    for i in range(10):
        try:
            with open(path, "wb") as f:
                f.write(data)
            return
        except Exception as e:  # noqa: BLE001
            last_err = e
            time.sleep(0.3 * (i + 1))
    raise last_err
'''
    try:
        start = src.index("def my_save(")
        end = src.index("from io import BytesIO")
        src = src[:start] + new_save + "\n" + src[end:]
        start2 = src.index("def my_save2(")
        end2 = src.index("def savee(")
        src = src[:start2] + new_save2 + "\n" + src[end2:]
        if "MTNode GPT-TTS" not in src:
            raise RuntimeError("marker missing after patch")
    except Exception as e:  # noqa: BLE001
        log(f"warn: process_ckpt.py patch failed: {e}")
        return
    tmp = ckpt_py.with_suffix(".py.tmp")
    try:
        tmp.write_text(src, encoding="utf-8")
        for i in range(6):
            try:
                os.replace(str(tmp), str(ckpt_py))
                break
            except OSError:
                time.sleep(0.3 * (i + 1))
        log("process_ckpt.py patched (robust my_save / my_save2)")
    except Exception as e:  # noqa: BLE001
        log(f"warn: cannot write process_ckpt.py: {e}")




def _run_step(
    slug: str,
    args: list[str],
    cwd: Path,
    phase: str,
    phase_label: str,
    pct_from: float,
    pct_to: float,
    log_path: Path,
    parse_epoch: bool = False,
    retry_alt_flag: bool = False,
    env: dict[str, str] | None = None,
) -> None:
    """Run one training/prep step; streams output to log_path; raises on failure."""
    st = _running.get(slug)
    if st is None:
        raise RuntimeError("not_running")
    st.update({"phase": phase, "phaseLabel": phase_label, "pct": pct_from, "cancel": False})

    def _try_run(alt: bool) -> int:
        run_args = list(args)
        if alt and retry_alt_flag:
            run_args = [run_args[0]] + [a.replace("--config_file", "--config") for a in run_args[1:]]
        step_env = os.environ.copy()
        if env:
            step_env.update(env)
        # torch>=2.6 默认 torch.load(weights_only=True)：引擎自产 ckpt 里含
        # pathlib.WindowsPath 等非白名单对象（Lightning hparams 里的 Path），
        # s1/s2 断点续训（resume）与部分预训练加载会抛 pickle.UnpicklingError。
        # 引擎是本地可信代码，强制未显式指定 weights_only 的加载回退旧默认
        # (False)；显式传 True 的调用不受影响。
        step_env["TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD"] = "1"
        # English g2p 的 NLTK 词性标注数据（自愈下载到 ROOT/nltk_data）。
        step_env["NLTK_DATA"] = str(ROOT / "nltk_data")
        # GPT-SoVITS repo root must be importable (feature_extractor / tools / text / module / utils).
        # ROOT/shims provides a gradio stub (engine imports gradio at top level
        # in tools.my_utils but training never uses the WebUI); it MUST come
        # before .pylibs so a real gradio can never shadow it.
        gpt_root = str(ENGINE_DIR / "GPT_SoVITS")
        step_env["PYTHONPATH"] = os.pathsep.join(
            [str(ROOT / "shims"), str(_PYLIBS), gpt_root, str(ENGINE_DIR), step_env.get("PYTHONPATH", "")]
        ).strip(os.pathsep)
        proc = subprocess.Popen(
            run_args,
            cwd=str(cwd),
            env=step_env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            creationflags=_proc_flags(),
        )
        st["proc"] = proc
        log(f"[{slug}] {phase} pid={proc.pid} cmd={' '.join(run_args)}")
        tail: list[str] = []
        last_tick = time.time()
        last_line = time.time()
        epoch_re = [
            re.compile(r"Epoch\s+(\d+)\s*/\s*(\d+)", re.I),
            re.compile(r"epoch\s*[:=]\s*(\d+)\s*/\s*(\d+)", re.I),
            re.compile(r"epoch\s+(\d+)\s+of\s+(\d+)", re.I),
        ]
        band = max(pct_to - pct_from, 1.0)
        while True:
            line = proc.stdout.readline()
            if line:
                last_line = time.time()
                txt = line.rstrip("\n")
                _append_log(log_path, txt)
                tail.append(txt)
                if len(tail) > 240:
                    tail = tail[-240:]
                if txt.strip():
                    st["detail"] = txt.strip()[:220]
                if parse_epoch:
                    for rx in epoch_re:
                        mm = rx.search(txt)
                        if mm:
                            try:
                                cur, den = int(mm.group(1)), int(mm.group(2))
                                if den and cur is not None:
                                    st["pct"] = min(pct_to - 0.5, pct_from + (cur / den) * band)
                            except Exception:
                                pass
                            break
            else:
                if proc.poll() is not None:
                    break
                if time.time() - last_line > 600:
                    _kill_tree(proc)
                    tail.append("[train] step stalled >10min — killed")
                    _append_log(log_path, "[train] step stalled >10min — killed")
                    break
            if st.get("cancel"):
                _kill_tree(proc)
                raise _TrainCancelled()
            if time.time() - last_tick >= 5:
                last_tick = time.time()
                st["pct"] = min(pct_to - 0.5, float(st.get("pct") or pct_from) + band * 0.02)
        code = proc.wait()
        if code != 0:
            joined = "\n".join(tail[-20:]).lower()
            if retry_alt_flag and not alt and ("unrecognized" in joined or "usage:" in joined):
                return _try_run(True)
            raise RuntimeError(f"{phase} failed (exit {code})\n" + "\n".join(tail[-12:]))
        return 0

    try:
        _try_run(False)
    finally:
        st.pop("proc", None)


def _append_log(log_path: Path, line: str) -> None:
    try:
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(f"[{time.strftime('%H:%M:%S')}] {line}\n")
    except Exception:
        pass


def _log_tail(slug: str, max_chars: int = 4000) -> str:
    p = PROJECTS_DIR / slug / "logs" / "train.log"
    try:
        if not p.is_file():
            return ""
        size = p.stat().st_size
        n = min(size, max_chars)
        with open(p, "rb") as f:
            f.seek(size - n)
            raw = f.read()
        text = raw.decode("utf-8", errors="replace")
        return text[-max_chars:]
    except Exception:
        return ""


def train_status(name: str) -> dict[str, Any]:
    slug = _slug(name)
    m = _read_manifest(slug)
    if not m:
        raise ValueError("project_not_found")
    m = _normalize(m, slug)
    st = _running.get(slug)
    m = dict(m)
    m["running"] = st is not None
    if st:
        m["phase"] = st.get("phase") or m.get("phase") or ""
        m["phaseLabel"] = st.get("phaseLabel") or m.get("phaseLabel") or ""
        m["pct"] = float(st.get("pct") or m.get("pct") or 0)
        m["detail"] = st.get("detail") or m.get("detail") or ""
    m["steps"] = [{"phase": ph, "label": lb} for ph, lb in TRAIN_STEPS]
    m["stepIndex"] = _step_index(m.get("phase") or "")
    m["files"] = _project_files(slug)
    m["transcript"] = _read_transcript(PROJECTS_DIR / slug / "text" / "transcript.txt")
    m["logTail"] = _log_tail(slug)
    return m


def start_train(name: str) -> dict[str, Any]:
    _ensure_train_deps()
    slug = _slug(name)
    if not _train_lock.acquire(blocking=False):
        return {"ok": False, "error": "training_busy"}
    try:
        if slug in _running:
            return {"ok": False, "error": "already_training"}
        m = _read_manifest(slug)
        if not m:
            return {"ok": False, "error": "project_not_found"}
        if not _engine_installed():
            return {"ok": False, "error": "engine_not_installed"}
        if int(m.get("audioCount") or 0) < 1:
            return {"ok": False, "error": "no_audio"}
        _running[slug] = {"proc": None, "phase": "prep", "phaseLabel": "准备", "pct": 0, "cancel": False, "detail": ""}
        threading.Thread(target=_run_train, args=(slug,), daemon=True, name=f"train-{slug}").start()
        return {"ok": True, "status": "training"}
    finally:
        _train_lock.release()


def cancel_train(name: str) -> dict[str, Any]:
    slug = _slug(name)
    st = _running.get(slug)
    if st:
        st["cancel"] = True
        _kill_tree(st.get("proc"))
        return {"ok": True}
    m = _read_manifest(slug)
    if m:
        m["status"] = m["status"] if m["status"] != "training" else "ready"
        _write_manifest(slug, m)
    return {"ok": False, "error": "not_training"}


def cancel_all() -> None:
    for slug in list(_running.keys()):
        st = _running.get(slug)
        if st:
            st["cancel"] = True
            _kill_tree(st.get("proc"))


# ---------------- main training flow ----------------

def _run_train(slug: str) -> None:
    m = _read_manifest(slug)
    if m is None:
        _running.pop(slug, None)
        return
    d = PROJECTS_DIR / slug
    log_path = d / "logs" / "train.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    m["status"] = "training"
    m["phase"] = "prep"
    m["phaseLabel"] = "准备数据"
    m["pct"] = 2
    m["detail"] = "正在启动…"
    m["error"] = ""
    _write_manifest(slug, m)
    st0 = _running.get(slug)
    if st0 is not None:
        st0.update({"phase": "prep", "phaseLabel": "准备数据", "pct": 2, "detail": "正在启动…"})
    _append_log(log_path, "=== GPT-TTS 训练开始 (project=" + slug + ") ===")

    exp_name = slug
    speaker = slug
    ds_dir = ENGINE_DIR / "data" / exp_name / speaker
    try:
        # 0a) engine ckpt save robustness: weight dirs (GPT_weights_v2 /
        #     SoVITS_weights_v2 / logs) are never created by the headless
        #     pipeline, so the stock my_save -> shutil.move dies with
        #     PermissionError at the first checkpoint save. Patch + mkdir here.
        _update(m, "prep", "准备环境", 3, "检查权重保存目录…")
        _patch_engine_ckpt_save()
        # 0) prep dataset dir
        _update(m, "prep", "准备数据集", 3, "创建数据集目录…")
        # 注意：官方脚本产出的是 3-bert / 4-cnhubert / 5-wav32k / 6-name2semantic.tsv，
        # 早期这里误删了不存在的 wav32k/hubert/semantic，导致旧毒数据（如 0001 的
        # 187s 整段音频特征）跨运行残留。这里必须按真实目录清理，保证每次数据全新。
        for sub in ("3-bert", "4-cnhubert", "5-wav32k"):
            shutil.rmtree(ds_dir / sub, ignore_errors=True)
        for fn in ("2-name2text.txt", "2-name2text-0.txt", "6-name2semantic.tsv", "6-name2semantic-0.tsv"):
            try:
                (ds_dir / fn).unlink(missing_ok=True)
            except Exception:
                pass
        ds_dir.mkdir(parents=True, exist_ok=True)

        # 1) convert uploads -> 16k mono raw wav (per-file progress 5→7)
        _update(m, "audio", "整理音频", 5, "扫描音频文件…")
        audio_files = sorted((d / "audio").iterdir()) if (d / "audio").is_dir() else []
        n_audio = len(audio_files)
        if not n_audio:
            raise RuntimeError("no_audio_files")
        raw_dir = d / "seg_raw"
        shutil.rmtree(raw_dir, ignore_errors=True)
        raw_dir.mkdir(parents=True, exist_ok=True)
        raws: list[Path] = []
        for i, src in enumerate(audio_files, 1):
            raw = raw_dir / f"raw_{i:03d}.wav"
            _update(
                m, "audio", f"转换音频 {i}/{n_audio}", 5 + (i / n_audio) * 2,
                f"转换 {i}/{n_audio}: {src.name}…",
            )
            _convert_to_wav16k(src, raw)
            raws.append(raw)

        # 1b) segment long audio into short clips — GPT-SoVITS 需要 3–15 秒短段
        #     (max_sec=54s)，单条长音频会被 s1 数据集整个过滤掉（空数据集→除零）。
        _update(m, "audio", "切分音频", 7, "按静音切分长音频…")
        wav_list = _segment_audio_files(raws, ds_dir, log_path, m, slug)
        if not wav_list:
            raise RuntimeError("segmentation produced no clips")
        _append_log(log_path, f"{len(wav_list)} clips ready for training")

        # 2) transcript list — 逐句文字能对齐切分后的音频时直接使用，否则 ASR 转写
        _update(m, "list", "文字标注", 9, "写入文字标注列表…")
        list_path = ds_dir / f"{speaker}.list"
        use_asr = True
        if m.get("hasTranscript"):
            lines = _read_transcript_lines(d / "text" / "transcript.txt")
            if len(lines) >= len(wav_list):
                _write_list_file(list_path, wav_list, lines, exp_name, speaker)
                use_asr = False
                _append_log(log_path, f"using provided transcript ({len(lines)} lines, {len(wav_list)} clips)")
            else:
                _append_log(
                    log_path,
                    f"transcript lines({len(lines)}) < clips({len(wav_list)}) — 使用 ASR 转写逐段文字",
                )
        if use_asr:
            _update(m, "list", "语音识别转写 (ASR)", 9, "准备 ASR…")
            texts = _asr_transcribe(wav_list, log_path, m, slug)
            if not any(t.strip() for t in texts):
                raise RuntimeError("ASR 未识别出任何语音内容（音频可能无人声或过短）")
            _write_list_file(list_path, wav_list, texts, exp_name, speaker)
            _append_log(log_path, f"ASR transcript written ({len(texts)} lines)")

        # 2b) 自愈旧版毒数据：0001 曾把整段 187s 音频当成分段特征（wav32k/hubert/
        #     semantic），且 2-get-hubert / 3-get-semantic 对已存在的产物会跳过，
        #     导致毒数据跨运行残留。检测到时长失配时清理对应产物并强制重训 s2。
        _repair_dataset(ds_dir, log_path)

        gpt_root = ENGINE_DIR / "GPT_SoVITS"
        prep_env = {
            "inp_text": str(list_path),
            "inp_wav_dir": str(ds_dir),
            "exp_name": exp_name,
            "i_part": "0",
            "all_parts": "1",
            "opt_dir": str(ds_dir),
            "is_half": "True" if _cuda_available() else "False",
            "version": "v2",
            # 国内网络兜底：g2pw 首次使用会从 ModelScope 下载模型（可直连），
            # 若某处仍走 HF 则一律经 hf-mirror。
            "HF_ENDPOINT": "https://hf-mirror.com",
        }
        # 3a) text -> phoneme + bert features (1-get-text.py)
        _update(m, "text", "文字转音素 (BERT)", 12, "启动 1-get-text.py…")
        script = _find_script("1-get-text.py", "prepare_datasets/1-get-text.py")
        if script is None:
            raise RuntimeError("1-get-text.py not found in engine")
        txt_env = dict(prep_env)
        txt_env["bert_pretrained_dir"] = str(gpt_root / "pretrained_models" / "chinese-roberta-wwm-ext-large")
        _run_step(slug, [sys.executable, str(script)], ENGINE_DIR, "text", "文字转音素 (BERT)", 12, 27, log_path, env=txt_env)
        # 3b) hubert features + 32k wav (2-get-hubert-wav32k.py)
        _update(m, "hubert", "提取 HuBERT 特征", 27, "启动 2-get-hubert-wav32k.py…")
        hubert = _find_script("2-get-hubert-wav32k.py", "prepare_datasets/2-get-hubert-wav32k.py")
        if hubert is None:
            raise RuntimeError("2-get-hubert-wav32k.py not found")
        hu_env = dict(prep_env)
        hu_env["cnhubert_base_dir"] = str(gpt_root / "pretrained_models" / "chinese-hubert-base")
        _run_step(slug, [sys.executable, str(hubert)], ENGINE_DIR, "hubert", "HuBERT 特征", 27, 45, log_path, env=hu_env)
        # 3c) semantic tokens (3-get-semantic.py; needs the s2 config first)
        _update(m, "semantic", "语义 token", 45, "启动 3-get-semantic.py…")
        sem = _find_script("3-get-semantic.py", "prepare_datasets/3-get-semantic.py")
        if sem is None:
            raise RuntimeError("3-get-semantic.py not found")
        sem_env = dict(prep_env)
        sem_env["pretrained_s2G"] = str(gpt_root / "pretrained_models" / "s2G488k.pth")
        sem_env["s2config_path"] = str(_build_s2_config(slug, exp_name, speaker, ds_dir, for_semantic=True))
        _run_step(slug, [sys.executable, str(sem)], ENGINE_DIR, "semantic", "语义 token", 45, 60, log_path, env=sem_env)
        # 3d) official scripts name outputs with a "-0" suffix; trainers expect no suffix
        for src_name, dst_name in (
            ("2-name2text-0.txt", "2-name2text.txt"),
            ("6-name2semantic-0.tsv", "6-name2semantic.tsv"),
        ):
            src = ds_dir / src_name
            dst = ds_dir / dst_name
            if src.is_file():
                if dst.exists():
                    dst.unlink()
                shutil.move(str(src), str(dst))
                _append_log(log_path, f"renamed {src_name} -> {dst_name}")
        # 3e) s1 的 Text2SemanticDataset 用 pd.read_csv(delimiter="\t") 读
        #     6-name2semantic.tsv（默认把首行当表头）——只有 1 个样本时整行被当表头
        #     -> 0 行数据 -> s1 除零崩溃。显式补一个表头行，让每个样本都保留。
        tsv = ds_dir / "6-name2semantic.tsv"
        if tsv.is_file():
            raw = tsv.read_text(encoding="utf-8")
            first = raw.split("\n", 1)[0] if raw else ""
            if first and "\t" in first and first.split("\t", 1)[0].strip() not in ("name", "item_name"):
                tsv.write_text("name\tsemantic\n" + raw, encoding="utf-8")
                _append_log(log_path, "prepended header to 6-name2semantic.tsv")

        # 4) s1 GPT training
        s1_cfg = _build_s1_config(slug, exp_name, speaker, ds_dir)
        s1 = _find_script("s1_train.py", "GPT_SoVITS/s1_train.py")
        if s1 is None:
            raise RuntimeError("s1_train.py not found")
        _update(m, "s1", "GPT 模型训练 (s1)", 60, "启动 s1_train.py…")
        _run_step(
            slug, [sys.executable, str(s1), "--config_file", str(s1_cfg)], ENGINE_DIR,
            "s1", "GPT 模型训练 (s1)", 60, 85, log_path, parse_epoch=True,
        )

        # 5) s2 SoVITS training
        s2_cfg = _build_s2_config(slug, exp_name, speaker, ds_dir)
        s2 = _find_script("s2_train.py", "GPT_SoVITS/s2_train.py")
        if s2 is None:
            raise RuntimeError("s2_train.py not found")
        _update(m, "s2", "SoVITS 模型训练 (s2)", 85, "启动 s2_train.py…")
        _run_step(
            slug, [sys.executable, str(s2), "--config", str(s2_cfg)], ENGINE_DIR,
            "s2", "SoVITS 模型训练 (s2)", 85, 97, log_path, parse_epoch=True,
        )

        # 6) register trained voice
        _update(m, "final", "注册音色", 98, "查找训练权重…")
        gpt = (
            _find_newest_weight(ENGINE_DIR / "GPT_weights_v2", (".ckpt", ".pth"), slug)
            or _find_newest_weight(ds_dir, (".ckpt", ".pth"), slug)
            or _find_newest_weight(ENGINE_DIR / "logs", (".ckpt", ".pth"), slug)
        )
        sovits = (
            _find_newest_weight(ENGINE_DIR / "SoVITS_weights_v2", (".pth",), slug)
            or _find_newest_weight(ds_dir, (".pth",), slug)
            or _find_newest_weight(ENGINE_DIR / "logs", (".pth",), slug)
        )
        if not gpt or not sovits:
            raise RuntimeError("trained weights not found (GPT/SoVITS_weights_v2)")
        _register_trained_voice(slug, wav_list, gpt, sovits, m)
        m["status"] = "trained"
        m["pct"] = 100
        m["phaseLabel"] = "训练完成"
        m["detail"] = "训练完成，音色已注册"
        m["trainedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        m["weights"] = {"gpt": str(gpt), "sovits": str(sovits)}
        m["expName"] = exp_name
        m["speaker"] = speaker
        _write_manifest(slug, m)
        _append_log(log_path, "=== 训练完成，音色已注册: " + slug + " ===")
        log(f"training done: {slug}")
    except _TrainCancelled:
        m["status"] = m["status"] if m["status"] != "training" else "ready"
        m["phaseLabel"] = "已取消"
        m["detail"] = "训练已取消"
        m["error"] = "cancelled"
        _write_manifest(slug, m)
        _append_log(log_path, "=== 训练已取消 ===")
        log(f"training cancelled: {slug}")
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        m["status"] = "failed"
        m["phaseLabel"] = "训练失败"
        m["detail"] = msg[:220]
        m["error"] = msg[:500]
        _write_manifest(slug, m)
        _append_log(log_path, "=== 训练失败: " + msg + " ===")
        log(f"training failed: {slug} — {msg}")
    finally:
        _running.pop(slug, None)


def _update(
    m: dict[str, Any], phase: str, label: str, pct: float, detail: str = ""
) -> None:
    """Record progress into the manifest AND the live in-memory state so the
    status endpoint reflects it immediately without waiting for a disk read."""
    m["phase"] = phase
    m["phaseLabel"] = label
    m["pct"] = pct
    if detail:
        m["detail"] = detail
    st = _running.get(str(m.get("slug") or ""))
    if st is not None:
        st["phase"] = phase
        st["phaseLabel"] = label
        st["pct"] = pct
        if detail:
            st["detail"] = detail
    _write_manifest(m["slug"], m)


def _convert_to_wav16k(src: Path, dst: Path) -> None:
    ff = shutil.which("ffmpeg")
    if not ff:
        # try common bundled location
        cand = ENGINE_DIR / "ffmpeg.exe"
        if cand.is_file():
            ff = str(cand)
    if not ff:
        raise RuntimeError(f"ffmpeg not found — cannot convert {src.name}; upload wav files instead")
    r = subprocess.run(
        [ff, "-y", "-i", str(src), "-ar", "16000", "-ac", "1", str(dst)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    if r.returncode != 0 or not dst.is_file():
        raise RuntimeError(f"ffmpeg convert failed: {src.name}")


def _read_transcript_lines(p: Path) -> list[str]:
    try:
        raw = p.read_text(encoding="utf-8-sig")
    except Exception:
        return []
    out = []
    for line in raw.splitlines():
        line = line.strip()
        if line:
            out.append(line)
    return out


def _write_list_file(list_path: Path, wav_list: list[Path], lines: list[str], exp: str, speaker: str) -> None:
    parts = []
    for i, w in enumerate(wav_list):
        rel = f"data/{exp}/{speaker}/{w.name}"
        text = lines[i] if i < len(lines) else ""
        if re.search(r"[\u4e00-\u9fff]", text):
            lang = "zh"
        elif re.search(r"[A-Za-z]", text):
            lang = "en"
        else:
            lang = "zh"
        parts.append(f"{rel}|{speaker}|{lang}|{text}")
    list_path.write_text("\n".join(parts) + "\n", encoding="utf-8")


def _segment_audio_files(
    raws: list[Path], out_dir: Path, log_path: Path, m: dict[str, Any], slug: str
) -> list[Path]:
    """Split long audio into short clips (GPT-SoVITS needs 3–15s samples).

    Uses librosa silence detection (top_db RMS) on 16k mono wavs; merges gaps
    <0.5s, drops regions <1.5s, re-splits regions >15s at internal silences,
    and falls back to fixed 10s chunks when no silence is found (music-like
    input). Returns the clip paths written into out_dir as NNNN.wav.
    """
    import librosa
    import numpy as np  # noqa: F401
    import soundfile as sf

    out_dir.mkdir(parents=True, exist_ok=True)
    clips: list[Path] = []
    clip_idx = 1
    n_raw = len(raws)
    for ri, raw in enumerate(raws, 1):
        try:
            y, sr = librosa.load(str(raw), sr=16000, mono=True)
        except Exception as e:  # noqa: BLE001
            _append_log(log_path, f"load failed {raw.name}: {e}")
            continue
        dur = len(y) / sr
        segs: list[tuple[int, int]] = []
        if dur <= 20.0:
            segs = [(0, len(y))]
        else:
            try:
                parts = librosa.effects.split(y, top_db=30, frame_length=512, hop_length=256)
                merged: list[list[int]] = []
                gap = int(0.5 * sr)
                for a, b in parts:
                    if not merged or a - merged[-1][1] > gap:
                        merged.append([a, b])
                    else:
                        merged[-1][1] = b
                for a, b in merged:
                    if b - a < int(1.5 * sr):
                        continue
                    if b - a <= int(15 * sr):
                        segs.append((a, b))
                    else:
                        # re-split long region at its internal silences, pack to <=15s
                        sub = librosa.effects.split(y[a:b], top_db=40, frame_length=512, hop_length=256)
                        cur: list[int] | None = None
                        for sa, sb in sub:
                            if cur is None:
                                cur = [sa, sb]
                            elif sb - cur[0] <= int(15 * sr):
                                cur[1] = sb
                            else:
                                segs.append((a + cur[0], a + cur[1]))
                                cur = [sa, sb]
                        if cur:
                            segs.append((a + cur[0], a + cur[1]))
            except Exception as e:  # noqa: BLE001
                _append_log(log_path, f"silence split failed ({e}) — falling back to 10s chunks")
                segs = []
            if not segs:
                step = int(10 * sr)
                for s in range(0, len(y), step):
                    e = min(len(y), s + step)
                    if e - s >= int(3 * sr):
                        segs.append((s, e))
        for a, b in segs:
            if b - a < int(1.0 * sr):
                continue
            dst = out_dir / f"{clip_idx:04d}.wav"
            try:
                sf.write(str(dst), y[a:b], sr, subtype="PCM_16")
            except Exception as e:  # noqa: BLE001
                _append_log(log_path, f"write {dst.name} failed: {e}")
                continue
            clips.append(dst)
            clip_idx += 1
        _update(m, "audio", f"切分音频 {ri}/{n_raw}", 7 + (ri / n_raw) * 2, f"切分 {ri}/{n_raw}: {raw.name} → {len(segs)} 段")
        _append_log(log_path, f"segmented {raw.name}: {dur:.1f}s -> {len(segs)} clips (total {len(clips)})")
    return clips


def _asr_transcribe(clips: list[Path], log_path: Path, m: dict[str, Any], slug: str) -> list[str]:
    """Transcribe each clip with faster-whisper (hf-mirror for the model
    download). Returns one text line per clip, aligned by index."""
    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
    try:
        from faster_whisper import WhisperModel
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(f"faster-whisper 不可用: {e}") from e
    cuda = _cuda_available()
    model = None
    last_err: Exception | None = None
    for size in ("small", "base"):
        try:
            _update(m, "list", "语音识别转写 (ASR)", 9, f"加载 faster-whisper {size} 模型…")
            _append_log(log_path, f"[asr] loading faster-whisper-{size} (device={'cuda' if cuda else 'cpu'})")
            model = WhisperModel(size, device="cuda" if cuda else "cpu", compute_type="float16" if cuda else "int8")
            break
        except Exception as e:  # noqa: BLE001
            last_err = e
            _append_log(log_path, f"[asr] model {size} load failed: {e}")
    if model is None:
        raise RuntimeError(f"ASR 模型加载失败: {last_err}")
    texts: list[str] = []
    n = len(clips)
    for i, clip in enumerate(clips, 1):
        if _running.get(slug, {}).get("cancel"):
            raise _TrainCancelled()
        try:
            segs, _info = model.transcribe(
                str(clip), language=None, beam_size=5 if cuda else 1, vad_filter=False
            )
            txt = "".join(s.text for s in segs).strip()
        except Exception as e:  # noqa: BLE001
            _append_log(log_path, f"[asr] {clip.name} failed: {e}")
            txt = ""
        texts.append(txt)
        _update(m, "list", f"语音识别转写 {i}/{n}", 9 + (i / n) * 2.5, f"ASR {i}/{n}: {txt[:50] or '(空)'}")
        _append_log(log_path, f"[asr] {clip.name}: {txt}")
    return texts


def _find_s1_pretrained() -> Path | None:
    """s1 (GPT) 微调必须从预训练底模初始化，否则模型从随机权重开始训练，
    小数据集下根本学不出来（推理时立刻输出 EOS → 音频只有零点几秒）。
    官方流程由 WebUI 注入 pretrained_s1；插件此前漏了这一步。"""
    cands = [
        ENGINE_DIR / "GPT_SoVITS" / "pretrained_models" / "s1bert25hz-2kh-longer-epoch=68e-step=50232.ckpt",
        ENGINE_DIR / "GPT_SoVITS" / "pretrained_models" / "s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt",
        ENGINE_DIR / "GPT_SoVITS" / "pretrained_models" / "GPT_weights_v2.ckpt",
        ENGINE_DIR / "GPT_SoVITS" / "pretrained_models" / "GPT_weights_v1.ckpt",
    ]
    for p in cands:
        if p.is_file():
            return p
    return None


def _repair_dataset(ds_dir: Path, log_path: Path | None = None) -> bool:
    """自愈早期 bug 留下的毒数据（决定性案例）：
    data/<exp>/<spk>/5-wav32k/0001.wav 曾是整段 raw 音频（186.78s）而不是
    14.16s 分段；其 4-cnhubert/0001.wav.pt 与 6-name2semantic.tsv 的 0001 行
    也随之全错（4669 个语义 token vs 正常 ~354），直接毒化 s1/s2 训练。
    由于 2-get-hubert / 3-get-semantic 对已存在产物直接跳过，必须显式清理。

    这里在每次训练前对比每个分段与其 5-wav32k 副本的时长，失配即删除旧产物
    （随后固定清理逻辑会整目录重建）；若发现毒数据，同时删除 logs_s2_v1 让
    SoVITS 从预训练重训。返回是否修复过。"""
    import wave as _wave

    repaired = False
    try:
        if not ds_dir.is_dir():
            return False
        wav32dir = ds_dir / "5-wav32k"
        hubert_dir = ds_dir / "4-cnhubert"
        for src in sorted(ds_dir.glob("*.wav")):
            dst = wav32dir / src.name
            if not dst.is_file():
                continue
            try:
                with _wave.open(str(src), "rb") as w:
                    d1 = w.getnframes() / max(1, w.getframerate())
                with _wave.open(str(dst), "rb") as w:
                    d2 = w.getnframes() / max(1, w.getframerate())
            except Exception:  # noqa: BLE001
                continue
            if d2 > d1 * 1.5:
                _append_log(log_path, f"repair: {src.name} wav32k stale ({d1:.1f}s -> {d2:.1f}s), will regenerate")
                for p in (dst, hubert_dir / f"{src.name}.pt"):
                    try:
                        p.unlink(missing_ok=True)
                    except Exception:  # noqa: BLE001
                        pass
                repaired = True
        if repaired:
            # 语义文件来自 5-wav32k/4-cnhubert，毒数据下必须整表重算；
            # s2 的 logs_s2_v1 是在毒数据上训出来的，一并清掉强制从预训练重训。
            for fn in ("6-name2semantic.tsv", "6-name2semantic-0.tsv"):
                try:
                    (ds_dir / fn).unlink(missing_ok=True)
                except Exception:  # noqa: BLE001
                    pass
            s2resume = ds_dir / "logs_s2_v1"
            if s2resume.is_dir():
                shutil.rmtree(s2resume, ignore_errors=True)
                _append_log(log_path, "repair: removed logs_s2_v1 (retrain SoVITS from pretrained)")
    except Exception as e:  # noqa: BLE001
        _append_log(log_path, f"repair: dataset self-heal failed: {e}")
    return repaired


def _build_s1_config(slug: str, exp: str, speaker: str, ds_dir: Path) -> Path:
    rel = f"data/{exp}/{speaker}"
    tpl = _load_config_template("configs/s1longer.yaml")
    if tpl:
        import yaml

        cfg = yaml.safe_load(tpl) or {}
    else:
        cfg = {}
    train = cfg.setdefault("train", {})
    train.setdefault("seed", 1234)
    train.setdefault("epochs", 20)
    train["batch_size"] = 4  # conservative VRAM; edit train_cfg/<slug>/s1.yaml to tune
    train.setdefault("save_every_n_epoch", 1)
    train.setdefault("gradient_clip", 1.0)
    train["precision"] = "16-mixed" if _cuda_available() else "32"
    train["if_save_latest"] = True
    train["if_save_every_weights"] = True
    train["half_weights_save_dir"] = str(ENGINE_DIR / "GPT_weights_v2")
    train["exp_name"] = exp
    cfg.setdefault(
        "optimizer",
        {"lr": 0.01, "lr_init": 0.00001, "lr_end": 0.0001, "warmup_steps": 50, "decay_steps": 4000},
    )
    cfg.setdefault("data", {"max_eval_sample": 8, "max_sec": 54, "num_workers": 2, "pad_val": 1024})
    cfg.setdefault(
        "model",
        {
            "vocab_size": 1025,
            "phoneme_vocab_size": 512,
            "embedding_dim": 512,
            "hidden_dim": 512,
            "head": 16,
            "linear_units": 2048,
            "n_layer": 24,
            "dropout": 0,
            "EOS": 1024,
            "random_bert": 0,
        },
    )
    cfg.setdefault("inference", {"top_k": 5})
    # 关键：s1 必须从预训练底模初始化（官方 WebUI 会注入 pretrained_s1，插件此前
    # 漏了 → 模型从随机权重训练，小数据集根本学不出来 → 推理立刻 EOS/零点几秒音频）。
    pretrained = _find_s1_pretrained()
    if pretrained:
        cfg["pretrained_s1"] = str(pretrained)
    cfg["output_dir"] = f"{rel}/logs_s1"
    cfg["train_semantic_path"] = f"{rel}/6-name2semantic.tsv"
    cfg["train_phoneme_path"] = f"{rel}/2-name2text.txt"
    import yaml

    text = yaml.safe_dump(cfg, allow_unicode=True, sort_keys=False)
    cfgp = _cfg_dir() / slug / "s1.yaml"
    cfgp.parent.mkdir(parents=True, exist_ok=True)
    cfgp.write_text(text, encoding="utf-8")
    return cfgp


def _build_s2_config(slug: str, exp: str, speaker: str, ds_dir: Path, for_semantic: bool = False) -> Path:
    rel = f"data/{exp}/{speaker}"
    tpl = _load_config_template("configs/s2.json")
    if tpl:
        cfg = json.loads(tpl)
    else:
        cfg = {
            "train": {
                "log_interval": 100,
                "eval_interval": 500,
                "seed": 1234,
                "epochs": 100,
                "learning_rate": 0.0001,
                "betas": [0.8, 0.99],
                "eps": 1e-09,
                "batch_size": 8,
                "fp16_run": True,
                "lr_decay": 0.999875,
                "segment_size": 20480,
                "init_lr_ratio": 1,
                "warmup_epochs": 0,
                "c_mel": 45,
                "c_kl": 1.0,
                "text_low_lr_rate": 0.4,
                "grad_ckpt": False,
            },
            "data": {
                "max_wav_value": 32768.0,
                "sampling_rate": 32000,
                "filter_length": 2048,
                "hop_length": 640,
                "win_length": 2048,
                "n_mel_channels": 128,
                "mel_fmin": 0.0,
                "mel_fmax": None,
                "add_blank": True,
                "n_speakers": 300,
                "cleaned_text": True,
            },
            "model": {
                "inter_channels": 192,
                "hidden_channels": 192,
                "filter_channels": 768,
                "n_heads": 2,
                "n_layers": 6,
                "kernel_size": 3,
                "p_dropout": 0.1,
                "resblock": "1",
                "resblock_kernel_sizes": [3, 7, 11],
                "resblock_dilation_sizes": [[1, 3, 5], [1, 3, 5], [1, 3, 5]],
                "upsample_rates": [10, 8, 2, 2, 2],
                "upsample_initial_channel": 512,
                "upsample_kernel_sizes": [16, 16, 8, 2, 2],
                "n_layers_q": 3,
                "use_spectral_norm": False,
                "gin_channels": 512,
                "semantic_frame_rate": "25hz",
                "freeze_quantizer": True,
            },
            "s2_ckpt_dir": "logs/s2/big2k1",
            "content_module": "cnhubert",
        }
    train = cfg.setdefault("train", {})
    train["gpu_numbers"] = "0"
    train["pretrained_s2G"] = str(ENGINE_DIR / "GPT_SoVITS" / "pretrained_models" / "s2G488k.pth")
    train["pretrained_s2D"] = ""
    train["save_every_epoch"] = 1
    train["if_save_latest"] = 1
    train["if_save_every_weights"] = True
    train["fp16_run"] = bool(_cuda_available())
    train["batch_size"] = 8  # conservative VRAM; edit train_cfg/<slug>/s2.json to tune
    data = cfg.setdefault("data", {})
    data["exp_dir"] = rel
    model = cfg.setdefault("model", {})
    if not for_semantic:
        # 3-get-semantic.py calls SynthesizerTrn(..., version=version, **hps.model),
        # so its config must NOT carry a version key.
        # Version MUST match the pretrained s2G weights' symbol table: s2G488k.pth is
        # v1 (322 symbols -> text_embedding (322,192)); hardcoding "v2" (732 symbols)
        # made load_state_dict fail with "size mismatch for enc_p.text_embedding".
        # Mirror 3-get-semantic.py's size-based rule so any pretrained file self-aligns.
        _sz = 0
        try:
            _sz = Path(train.get("pretrained_s2G", "") or "").stat().st_size
        except Exception:
            _sz = 0
        if _sz < 82978 * 1024:
            model["version"] = "v1"
        elif _sz < 100 * 1024 * 1024:
            model["version"] = "v2"
        elif _sz < 103520 * 1024:
            model["version"] = "v1"
        elif _sz < 700 * 1024 * 1024:
            model["version"] = "v2"
        else:
            model["version"] = "v3"
    cfg["save_weight_dir"] = str(ENGINE_DIR / "SoVITS_weights_v2")
    cfg["name"] = slug
    cfg.setdefault("s2_ckpt_dir", "logs/s2/big2k1")
    cfg.setdefault("content_module", "cnhubert")
    cfgp = _cfg_dir() / slug / ("s2-semantic.json" if for_semantic else "s2.json")
    cfgp.parent.mkdir(parents=True, exist_ok=True)
    cfgp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    return cfgp


def _find_newest_weight(root: Path, exts: tuple[str, ...], slug: str = "") -> Path | None:
    if not root.is_dir():
        return None
    best: Path | None = None
    best_m = -1.0
    for p in root.rglob("*"):
        if not p.is_file() or p.suffix.lower() not in exts:
            continue
        if slug and slug not in str(p):
            continue
        try:
            m = p.stat().st_mtime
        except Exception:
            continue
        if m > best_m:
            best_m = m
            best = p
    return best


def _wav_dur_sec(p: Path) -> float:
    """Duration of a wav in seconds (stdlib only)."""
    try:
        import wave

        with wave.open(str(p), "rb") as w:
            return w.getnframes() / max(w.getframerate(), 1)
    except Exception:
        return 0.0


def _find_segment_transcript(slug: str, wav_name: str) -> str | None:
    """Per-clip transcript lookup for voice registration.

    Official GPT-SoVITS synthesis conditions the voice on prompt_text, which must
    be the verbatim transcript of the reference audio. The per-clip transcripts
    live in the training list data/<slug>/<slug>/<slug>.list (wav|spk|lang|text)
    — NOT in the user's raw transcript.txt (a full-page scene description that
    never matches a single 3–10s clip). Falls back to 2-name2text.txt (tab
    separated, last column)."""
    list_path = ENGINE_DIR / "data" / slug / slug / f"{slug}.list"
    try:
        if list_path.is_file():
            for line in list_path.read_text(encoding="utf-8").splitlines():
                parts = line.split("|")
                if len(parts) >= 4 and Path(parts[0]).name == wav_name:
                    return parts[3].strip()
    except Exception:  # noqa: BLE001
        pass
    txt_path = ENGINE_DIR / "data" / slug / slug / "2-name2text.txt"
    try:
        if txt_path.is_file():
            for line in txt_path.read_text(encoding="utf-8").splitlines():
                parts = line.split("\t")
                if len(parts) >= 4 and Path(parts[0]).name == wav_name:
                    return parts[3].strip()
    except Exception:  # noqa: BLE001
        pass
    return None


def _register_trained_voice(slug: str, wav_list: list[Path], gpt: Path, sovits: Path, m: dict[str, Any]) -> None:
    # api_v2 rejects ref audio outside 3~10s ("参考音频在3~10秒范围外"), and the
    # first segment is often the longest/first chunk (observed 14.16s) — pick
    # the first segment whose duration is inside [3,10]s; fall back to [0].
    ref = next((p for p in wav_list if 3.0 <= _wav_dur_sec(p) <= 10.0), None) or wav_list[0]
    vdir = VOICES_DIR / slug
    vdir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ref, vdir / "ref.wav")
    # prompt_text 必须与参考音频内容一致（官方 GPT-SoVITS 语义）：优先取该
    # 片段的逐段 ASR 转写；原始 transcript.txt 是整页画面描述，与单个
    # 3~10s 参考音频不匹配，会严重劣化音色，仅作最后兜底。
    prompt = _find_segment_transcript(slug, ref.name)
    if not prompt:
        lines = _read_transcript_lines(PROJECTS_DIR / slug / "text" / "transcript.txt")
        prompt = lines[0] if lines else ""
    (vdir / "ref.txt").write_text(prompt, encoding="utf-8")
    lang = "auto"
    if re.search(r"[\u4e00-\u9fff]", prompt or ""):
        lang = "zh"
    elif re.search(r"[A-Za-z]", prompt or ""):
        lang = "en"
    (vdir / "ref.lang").write_text(lang, encoding="utf-8")
    (vdir / "weights.json").write_text(json.dumps({"gpt": str(gpt), "sovits": str(sovits)}), encoding="utf-8")
    (vdir / "trained.json").write_text(
        json.dumps({"project": slug, "expName": m.get("expName") or slug, "speaker": m.get("speaker") or slug, "trainedAt": time.strftime("%Y-%m-%dT%H:%M:%S")}),
        encoding="utf-8",
    )
    log(f"trained voice registered: {slug} (gpt={gpt.name}, sovits={sovits.name})")
