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

import hashlib
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
# 语料统一到的采样率。s2（SoVITS）模型本来就是 32 kHz，引擎的 5-wav32k 也是 32k；
# 再往下降（以前写死 16k）就是把高频直接丢掉 —— 见 _convert_to_wav 的说明。
TARGET_SR = 32000

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
    # 存量项目回填：早期上传只对 wav 记时长，mp3 全部是 0s（UI 显示「0s 音频」）。
    # 有音频但时长还是 0 时，用实际文件重算一次并持久化（之后不再重复计算）。
    # 按内容哈希去重：同一音频被重复上传（或遗留孤儿副本）只计一次时长。
    if int(m.get("audioCount") or 0) > 0 and not (m.get("durationSec") or 0):
        try:
            total = 0.0
            seen: set[str] = set()
            for f in _project_files(slug):
                if f["kind"] != "audio":
                    continue
                p = PROJECTS_DIR / slug / "audio" / f["name"]
                h = _file_hash(p)
                if h:
                    if h in seen:
                        continue
                    seen.add(h)
                total += f.get("dur") or 0.0
            if total:
                m["durationSec"] = round(total, 1)
                _write_manifest(slug, m)
        except Exception:
            pass
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
            dur = _wav_duration(p) if p.suffix.lower() == ".wav" else _audio_duration(p)
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


def _audio_duration(path: Path) -> float:
    """Duration of any audio file (wav/mp3/flac/…) — wav via the stdlib wave
    module, everything else via ffprobe. 0.0 on any failure."""
    if path.suffix.lower() == ".wav":
        d = _wav_duration(path)
        if d:
            return d
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return 0.0
    try:
        r = subprocess.run(
            [
                ffprobe, "-v", "error", "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1", str(path),
            ],
            capture_output=True, text=True, timeout=30,
        )
        if r.returncode == 0:
            try:
                return round(float(r.stdout.strip()), 2)
            except ValueError:
                return 0.0
    except Exception:
        pass
    return 0.0


def _file_hash(path: Path, chunk: int = 1 << 20) -> str:
    """SHA-256 of a file's content (for duplicate upload detection)."""
    h = hashlib.sha256()
    try:
        with open(path, "rb") as f:
            while True:
                b = f.read(chunk)
                if not b:
                    break
                h.update(b)
    except Exception:
        return ""
    return h.hexdigest()


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
        # 去重：同一音频被重复选择（同名/改名再传一次）会把同一段内容以 N 倍
        # 塞进训练集，白白浪费训练时间且造成数据不平衡。按内容哈希跳过重复文件。
        _dig = hashlib.sha256(data).hexdigest()
        _dup = next(
            (p for p in audio_dir.iterdir() if p.is_file() and _file_hash(p) == _dig),
            None,
        )
        if _dup is not None:
            log(f"upload skip: {fname} 与已有 {_dup.name} 内容完全相同（已去重）")
            continue
        target = _uniq_path(audio_dir, fname)
        target.write_bytes(data)
        dur = _audio_duration(target)
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
    epoch_total: int | None = None,
    epoch_zero_based: bool = False,
) -> None:
    """Run one training/prep step; streams output to log_path; raises on failure.

    epoch_total / epoch_zero_based: 让进度条按「第几轮 / 共几轮」精确推进。
    s1(Lightning) 打印的是 0-based 的 `Epoch 29:`，s2 打印的是 1-based 的
    `====> Epoch: 97`，所以 s1 传 epoch_zero_based=True。
    """
    st = _running.get(slug)
    if st is None:
        raise RuntimeError("not_running")
    st.update({"phase": phase, "phaseLabel": phase_label, "pct": pct_from, "cancel": False})
    if parse_epoch:
        st["epoch"] = None
        st["epochTotal"] = int(epoch_total) if epoch_total else None
        st["loss"] = None

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
        # 实测日志格式（GPT-SoVITS + Lightning + tqdm），别指望 X/Y 写法：
        #   s1: "Epoch 29: 100%|...| 25/25 [..., total_loss_epoch=12.60, ...]"
        #   s2: "INFO:aoi:====> Epoch: 97" / "saving ckpt aoi_e97:Success."
        #       "Train Epoch: 93 [86%]" 紧跟一行 "[loss_d, loss_g, loss_fm, ...]"
        epoch_re = [
            re.compile(r"Epoch\s+(\d+)\s*/\s*(\d+)", re.I),
            re.compile(r"epoch\s*[:=]\s*(\d+)\s*/\s*(\d+)", re.I),
            re.compile(r"epoch\s+(\d+)\s+of\s+(\d+)", re.I),
        ]
        rx_epoch_only = re.compile(r"(?:====>\s*Epoch:|Train Epoch:|saving ckpt \S*?_?e)\s*(\d+)", re.I)
        rx_s1_epoch = re.compile(r"^\s*Epoch\s+(\d+)[:\s]", re.I)
        rx_s1_loss = re.compile(r"total_loss_epoch=([0-9.]+)", re.I)
        rx_s1_loss_step = re.compile(r"total_loss_step=([0-9.]+)", re.I)
        rx_loss_any = re.compile(r"(?<![a-z_])loss[=:]\s*([0-9]*\.?[0-9]+(?:e[-+]?[0-9]+)?)", re.I)
        rx_loss_list = re.compile(r"^\s*\[([-\d.eE+,\s]+)\]\s*$")
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
                    matched = False
                    for rx in epoch_re:
                        mm = rx.search(txt)
                        if mm:
                            try:
                                cur, den = int(mm.group(1)), int(mm.group(2))
                                if den:
                                    st["epoch"] = cur
                                    st["epochTotal"] = den
                                    st["pct"] = min(pct_to - 0.5, pct_from + (cur / den) * band)
                            except Exception:
                                pass
                            matched = True
                            break
                    if not matched:
                        mm = rx_s1_epoch.search(txt) or rx_epoch_only.search(txt)
                        if mm:
                            try:
                                cur = int(mm.group(1)) + (1 if epoch_zero_based else 0)
                                st["epoch"] = cur
                                den = int(epoch_total or 0)
                                if den:
                                    st["epochTotal"] = den
                                    st["pct"] = min(
                                        pct_to - 0.5, pct_from + (min(cur, den) / den) * band
                                    )
                            except Exception:
                                pass
                    lm = rx_s1_loss.search(txt) or rx_loss_any.search(txt) or rx_s1_loss_step.search(txt)
                    if lm:
                        try:
                            st["loss"] = round(float(lm.group(1)), 4)
                        except Exception:
                            pass
                    elif rx_loss_list.match(txt) and "Train Epoch" in (tail[-2] if len(tail) >= 2 else ""):
                        # s2 的 loss 单独占一行：[loss_d, loss_g, loss_fm, loss_mel, kl, kl_ssl, step, lr]
                        try:
                            vals = [float(x) for x in rx_loss_list.match(txt).group(1).split(",") if x.strip()]
                            if len(vals) >= 2:
                                st["loss"] = round(vals[1], 4)
                        except Exception:
                            pass
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
        # 实时轮数 + loss（训练中面板直接显示「第 12/30 轮 · loss 12.6」）
        for k in ("epoch", "epochTotal", "loss", "mode"):
            if st.get(k) is not None:
                m[k] = st.get(k)
    m["trainMode"] = m.get("trainMode") or (st.get("mode") if st else "") or ""
    m["model"] = _model_state(slug, ENGINE_DIR / "data" / slug / slug)
    # 训练中的「中间模型」（面板测试合成用它做实时试听）
    try:
        m["live"] = live_model(slug)
    except Exception as e:  # noqa: BLE001
        m["live"] = {"ok": False, "error": str(e)[:200], "usable": False}
    m["steps"] = [{"phase": ph, "label": lb} for ph, lb in TRAIN_STEPS]
    m["stepIndex"] = _step_index(m.get("phase") or "")
    m["files"] = _project_files(slug)
    m["transcript"] = _read_transcript(PROJECTS_DIR / slug / "text" / "transcript.txt")
    m["logTail"] = _log_tail(slug)
    return m


def _norm_train_opts(opts: dict[str, Any] | None) -> dict[str, Any]:
    """规范化训练选项（面板 / HTTP / 画布节点都走这里）。

    mode:      fresh|retrain|重新训练 -> fresh ；continue|resume|继续迭代 -> continue
                其它（含 auto）-> auto（有模型就继续迭代，没有就全新训练）
    reuseData: 是否复用已整理好的音频/文字/特征（默认 True）
    dither:    是否对低带宽语料做高频空带填充（默认 False；缓解电流音的缓解手段）
    s1Epochs:  fresh=总轮数 / continue=在已完成轮数上追加的轮数
    s2Epochs:  同上
    """
    o = dict(opts or {})
    raw = str(o.get("mode") or "auto").strip().lower()
    alias = {
        "fresh": "fresh", "retrain": "fresh", "new": "fresh", "restart": "fresh", "重新训练": "fresh",
        "从头训练": "fresh", "从头重训": "fresh",
        "continue": "continue", "resume": "continue", "iterate": "continue", "keep": "continue",
        "继续迭代": "continue", "继续训练": "continue", "增量训练": "continue",
        "auto": "auto", "": "auto",
    }
    mode = alias.get(raw, "")
    if mode == "":
        mode = "auto"
    o["mode"] = mode
    rd = o.get("reuseData")
    if rd is None:
        rd = o.get("reusePrep")
    o["reuseData"] = True if rd is None else bool(rd)
    o["dither"] = True if o.get("dither") in (True, 1, "1", "true", "True", "on") else False

    def _ep(k: str) -> int | None:
        v = o.get(k)
        if v is None or str(v).strip() == "":
            return None
        try:
            n = int(round(float(str(v).strip())))
        except Exception:
            return None
        if n < 1 or n > 2000:
            return None
        return n

    o["s1Epochs"] = _ep("s1Epochs")
    o["s2Epochs"] = _ep("s2Epochs")
    return o


def start_train(name: str, opts: dict[str, Any] | None = None) -> dict[str, Any]:
    _ensure_train_deps()
    slug = _slug(name)
    o = _norm_train_opts(opts)
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
        _running[slug] = {
            "proc": None, "phase": "prep", "phaseLabel": "准备", "pct": 0, "cancel": False, "detail": "",
            "epoch": None, "epochTotal": None, "loss": None, "mode": o["mode"],
            # 「中间模型试听」用它区分"本轮练出来的权重"和"上一次训练残留的同名权重"
            "startedAt": time.time(),
        }
        m["trainMode"] = o["mode"]
        m["reuseData"] = o["reuseData"]
        m["status"] = "training"
        _write_manifest(slug, m)
        threading.Thread(target=_run_train, args=(slug, o), daemon=True, name=f"train-{slug}").start()
        return {"ok": True, "status": "training", "mode": o["mode"], "reuseData": o["reuseData"]}
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


# ---------------- 续训 / 数据复用（已存在模型 & 已整理数据） ----------------
#
# 用户诉求：「如果已存在模型，可选择重新训练还是继续迭代；已经整理过的音频和文字
# 不要再重新处理。」两件事分别落在两个开关上：
#
#   mode = "fresh"     重新训练：删掉 logs_s1 / logs_s2_*，从官方预训练底模重训
#   mode = "continue"  继续迭代：保留引擎断点，在当前轮数上再加 N 轮
#                      （没有 Lightning 断点时，退回用已导出的 eNN 权重当底模）
#
#   reusePrep = True   数据集指纹（音频集合 + 文字）与上次一致时，直接复用已转换/
#                      已切分的分段与已写好的 .list，跳过 ffmpeg、静音切分和
#                      faster-whisper ASR；特征产物按「逐段内容哈希」增量判定，
#                      只有内容变了的分段才清掉重算。
#                      旧实现每轮无条件 rmtree 3-bert/4-cnhubert/5-wav32k，那才是
#                      真正的重复处理来源——现在改成条件化。
#
# 续训轮数语义（逐行读过引擎源码，别搞反）：
#   s1_train.py  get_newest_ckpt(logs_s1/ckpt) -> trainer.fit(ckpt_path=...)
#                Lightning 恢复 current_epoch 后一路训到 train.epochs；文件名
#                epoch=(\d+) 是 0-based，所以「已完成轮数 = 该值 + 1」
#   s2_train.py  utils.load_checkpoint(logs_s2_<ver>/G_*.pth) 取 iteration，
#                epoch_str = iteration + 1，for epoch in range(epoch_str, epochs+1)
#                即 train.epochs 同样是「总轮数」
#   => 配置里写的永远是总轮数；继续迭代 = 已完成 + 追加。

# ---------------- 默认轮数（「练完有电流音」的其中一环） ----------------
#
# 轮数不是电流音的主因（主因是语料带宽，见 _convert_to_wav），但它是放大器：
# 同一句话换不同轮数的权重实测（aoi · GPT e31 · 6 句平均，指标=有声帧 8–16 kHz
# 能量占比 / 相对语音段 dB / 谱平坦度）——
#   SoVITS e16 → 0.041% / −33.9 dB / 0.967
#   SoVITS e40 → 0.038% / −34.2 dB / 0.964
#   SoVITS e120→ 0.038% / −34.2 dB / 0.936   ← 4–8k 与 8–16k 的能量比从 8.4 涨到 28.8
# e120 的高频已经不像噪声、更像窄带尖峰（金属味），而且样本间跳变 d_over_med
# 从 46 涨到 58。小语料练到 100+ 轮纯属反复背同几段音频，收益为负。
# 官方 webui 的默认量级也是 s1≈15 / s2≈10，从来不是 100。
# 所以默认改成 GPT 10 轮 / SoVITS 40 轮；数据多（>10 分钟）就在面板上直接填更大的数。
S1_FRESH_EPOCHS = 10
S2_FRESH_EPOCHS = 40
S1_CONTINUE_EPOCHS = 10
S2_CONTINUE_EPOCHS = 10
# v3：转换/切分不再把语料压到 16 kHz（见 _convert_to_wav）。旧的已整理数据是
# 16 kHz 产物，必须作废重做一遍，否则改了也白改。
PREP_VER = "3"

# 每 1 分钟语料大约能撑多少轮 SoVITS（经验值，超过就提示过拟合风险）；
# 下限 40 —— 也就是插件的默认值本身不会被这条提示判成"练过头"。
EPOCHS_PER_MINUTE = 15.0
EPOCHS_SAFE_FLOOR = 40


def _clips_seconds_estimated(clips: list) -> float:
    """分段总时长（秒）。超过 60 段改为抽样推算 —— 面板每次刷新项目都会调
    train_plan，一千多段逐个开文件读头就没必要了。"""
    ps = [Path(str(c)) for c in (clips or []) if c]
    if not ps:
        return 0.0
    if len(ps) <= 60:
        return round(sum(_wav_dur_sec(p) for p in ps), 1)
    step = max(1, len(ps) // 60)
    got = [_wav_dur_sec(p) for p in ps[::step]]
    got = [g for g in got if g and g > 0]
    if not got:
        return 0.0
    return round(sum(got) * (len(ps) / float(len(got))), 1)


def _buzz_risk(total_sec: float, s2_total: int) -> str:
    """按语料长度估算「练太久 → 电流音」的风险。只提示，绝不拦训练。"""
    if total_sec <= 0 or s2_total <= 0:
        return ""
    minutes = total_sec / 60.0
    cap = int(max(float(EPOCHS_SAFE_FLOOR), minutes * EPOCHS_PER_MINUTE))
    if s2_total <= cap:
        return ""
    return (
        f"语料 {minutes:.1f} 分钟，SoVITS 计划练 {s2_total} 轮（这个量级的经验上限约 {cap} 轮）："
        "练过头容易出电流音 / 金属声。可以降到 "
        f"{cap} 轮以内重训，或在「测试合成」里选训练中间模型 + 勾「固定轮次」，"
        "挑一版不发虚的直接用。"
    )



def _prep_stamp_path(ds_dir: Path) -> Path:
    return ds_dir / ".mtnode-prep.json"


def _read_prep_stamp(ds_dir: Path) -> dict[str, Any] | None:
    p = _prep_stamp_path(ds_dir)
    if not p.is_file():
        return None
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else None
    except Exception:
        return None


def _write_prep_stamp(ds_dir: Path, data: dict[str, Any]) -> None:
    try:
        _prep_stamp_path(ds_dir).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as e:  # noqa: BLE001
        log(f"warn: cannot write prep stamp: {e}")


def _clips_on_disk(ds_dir: Path) -> list[Path]:
    try:
        return [p for p in sorted(ds_dir.glob("*.wav")) if p.is_file() and p.stat().st_size > 44]
    except Exception:
        return []


def _list_matches(list_path: Path, names: list[str]) -> bool:
    """已写好的文字标注表是否仍然对齐这批分段（段数一致且名字一一对应）。"""
    try:
        if not list_path.is_file():
            return False
        rows = [ln for ln in list_path.read_text(encoding="utf-8").splitlines() if ln.strip()]
    except Exception:
        return False
    if len(rows) != len(names):
        return False
    got = set()
    for ln in rows:
        parts = ln.split("|")
        if len(parts) < 3:
            return False
        got.add(Path(parts[0]).name)
    return got == set(names)


def _prep_signature(files: list[Path], transcript: str) -> str:
    """数据集指纹：上传音频（内容哈希，与训练时同一套去重结果）+ 文字标注。
    内容没变 -> 指纹一致 -> 允许复用已切好的分段与已写好的 .list。"""
    h = hashlib.sha256()
    h.update(f"ver={PREP_VER}\n".encode("utf-8"))
    for p in sorted(files, key=lambda x: x.name):
        try:
            h.update(f"{p.name}|{p.stat().st_size}|{_file_hash(p)}\n".encode("utf-8"))
        except Exception:
            continue
    h.update(f"txt={hashlib.sha256((transcript or '').encode('utf-8')).hexdigest()}\n".encode("utf-8"))
    return h.hexdigest()[:24]


def _clip_hash_one(c: Path) -> str:
    return f"{c.stat().st_size}:{_file_hash(c)}"


def _feature_signature(clips: list[Path]) -> str:
    """分段内容指纹（逐段哈希）：决定 1/2/3-get-*.py 能否整步跳过。"""
    h = hashlib.sha256()
    h.update(f"ver={PREP_VER}\n".encode("utf-8"))
    for c in clips:
        try:
            h.update(f"{c.name}|{_clip_hash_one(c)}\n".encode("utf-8"))
        except Exception:
            continue
    return h.hexdigest()[:24]


def _clips_ok(ds_dir: Path, names: list[str]) -> bool:
    if not names:
        return False
    for n in names:
        try:
            p = ds_dir / str(n)
            if not p.is_file() or p.stat().st_size <= 44:
                return False
        except Exception:
            return False
    return True


def _list_langs(list_path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        for line in list_path.read_text(encoding="utf-8").splitlines():
            parts = line.split("|")
            if len(parts) >= 3:
                out[Path(parts[0]).name] = (parts[2].strip() or "zh")
    except Exception:
        pass
    return out


def _table_names(path: Path, skip: set[str]) -> set[str]:
    out: set[str] = set()
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            first = line.split("\t", 1)[0].strip()
            if not first or first in skip:
                continue
            out.add(Path(first).name)
    except Exception:
        return set()
    return out


def _features_ok(ds_dir: Path, clips: list[Path], list_path: Path) -> bool:
    """逐段核对官方特征产物是否齐全（齐全才能整步跳过 1/2/3-get-*.py）。
    只信磁盘上的文件，不信内存——服务重启、上次中断同样 covered。"""
    names = [c.name for c in clips]
    if not names:
        return False
    n2t = ds_dir / "2-name2text.txt"
    sem = ds_dir / "6-name2semantic.tsv"
    if not n2t.is_file() or not sem.is_file():
        return False
    want = set(names)
    if not want <= _table_names(n2t, set()) or not want <= _table_names(sem, {"name", "item_name"}):
        return False
    langs = _list_langs(list_path) if list_path.is_file() else {}
    for n in names:
        if not (ds_dir / "4-cnhubert" / f"{n}.pt").is_file():
            return False
        if not (ds_dir / "5-wav32k" / n).is_file():
            return False
        if langs.get(n, "zh") == "zh" and not (ds_dir / "3-bert" / f"{n}.pt").is_file():
            return False
    return True


def _prune_stale_features(
    ds_dir: Path, clips: list[Path], stamp: dict[str, Any] | None, log_path: Path | None = None
) -> int:
    """分段是 0001.wav 这种位置编号：新增/替换音频会让「同名分段」的内容变掉，而官方
    2-get-hubert / 3-get-semantic 对已存在产物直接跳过 → 旧内容的特征会毒化新训练。
    按逐段哈希比对，只把内容变了的分段特征删掉，其余原样保留（= 增量处理）。"""
    prev = (stamp or {}).get("clipHashes")
    if not isinstance(prev, dict) or not prev:
        return 0
    dropped = 0
    for c in clips:
        try:
            want = _clip_hash_one(c)
        except Exception:
            continue
        old = prev.get(c.name)
        if old and old == want:
            continue
        for p in (
            ds_dir / "4-cnhubert" / f"{c.name}.pt",
            ds_dir / "5-wav32k" / c.name,
            ds_dir / "3-bert" / f"{c.name}.pt",
        ):
            try:
                if p.is_file():
                    p.unlink()
            except Exception:
                pass
        if old:
            dropped += 1
    if dropped:
        _append_log(log_path, f"prep: {dropped} 个同名分段内容变了 -> 只重算这些段的特征")
    return dropped


def _exported_epoch(path: Path | None, pattern: str) -> int:
    if path is None:
        return 0
    try:
        mm = re.search(pattern, path.name)
        return int(mm.group(1)) if mm else 0
    except Exception:
        return 0


def _find_best_weight(
    root: Path, exts: tuple[str, ...], slug: str, epoch_rx: str, prefer: str = "max"
) -> tuple[Path | None, int]:
    """挑一个导出权重，返回 (路径, 轮数)。prefer="max" 取轮数最高的（最强模型），
    prefer="newest" 取最近写出的那个（= 和 logs_* 断点同一次训练）。

    不能只信 mtime 也不能只信轮数：
      · 只看 mtime —— 同一秒写入的多个权重会挑错文件（曾经踩到）；
      · 只看最大轮数 —— 上一轮迭代练到 e53，之后「重新训练」只到 e30，此时
        logs_s2_v1 是 e30 那次训的，报 53 会让「继续迭代」多练 23 轮。
    """
    cands: list[Path] = []
    try:
        if root.is_dir():
            for ext in exts:
                for p in root.rglob(f"*{ext}"):
                    try:
                        if p.is_file() and (not slug or slug in str(p)):
                            cands.append(p)
                    except Exception:
                        continue
    except Exception:
        return (None, 0)
    if not cands:
        return (None, 0)

    def _mt(p: Path) -> float:
        try:
            return p.stat().st_mtime
        except Exception:
            return 0.0

    if prefer == "newest":
        pick = max(cands, key=_mt)
        return (pick, _exported_epoch(pick, epoch_rx))
    scored = [(_exported_epoch(p, epoch_rx), p) for p in cands]
    best_epoch = max(e for e, _ in scored)
    if best_epoch <= 0:
        return (max(cands, key=_mt), 0)
    tied = [p for e, p in scored if e == best_epoch]
    tied.sort(key=_mt)
    return (tied[-1], best_epoch)


def _model_state(slug: str, ds_dir: Path) -> dict[str, Any]:
    """盘点现有模型：能否续训、已完成多少轮、权重文件在哪。"""
    s1_ckpt: Path | None = None
    s1_lightning_done = 0
    d1 = ds_dir / "logs_s1" / "ckpt"
    if d1.is_dir():
        best = -1
        for p in d1.glob("*.ckpt"):
            mm = re.search(r"epoch=(\d+)", p.name)
            if mm and int(mm.group(1)) > best:
                best = int(mm.group(1))
                s1_ckpt = p
        if best >= 0:
            s1_lightning_done = best + 1
    s1_exp, s1_exp_e = _find_best_weight(
        ENGINE_DIR / "GPT_weights_v2", (".ckpt", ".pth"), slug, r"[-_]e(\d+)", "max"
    )
    # 有 Lightning 断点时以断点为准（那才是真正会续训的位置）
    s1_done = s1_lightning_done if s1_ckpt is not None else s1_exp_e

    s2_dir: Path | None = None
    try:
        for cand in sorted(ds_dir.glob("logs_s2*")):
            if cand.is_dir() and any(cand.glob("G_*.pth")):
                s2_dir = cand
                break
    except Exception:
        pass
    s2_exp, s2_exp_e = _find_best_weight(
        ENGINE_DIR / "SoVITS_weights_v2", (".pth",), slug, r"_e(\d+)_s\d+",
        "newest" if s2_dir is not None else "max",
    )
    s2_done = s2_exp_e

    def _mt(p: Path | None) -> str:
        try:
            return time.strftime("%Y-%m-%d %H:%M", time.localtime(p.stat().st_mtime)) if p else ""
        except Exception:
            return ""

    return {
        "s1": {
            "canContinue": bool(s1_ckpt) or bool(s1_exp),
            "resumable": bool(s1_ckpt),
            "epochsDone": s1_done,
            "exportedEpoch": s1_exp_e,
            "ckpt": str(s1_ckpt) if s1_ckpt else "",
            "weights": str(s1_exp) if s1_exp else "",
            "weightsName": s1_exp.name if s1_exp else "",
            "updatedAt": _mt(s1_ckpt or s1_exp),
            "how": "lightning" if s1_ckpt else ("weights" if s1_exp else ""),
        },
        "s2": {
            "canContinue": bool(s2_dir) or bool(s2_exp),
            "resumable": bool(s2_dir),
            "epochsDone": s2_done,
            "exportedEpoch": s2_exp_e,
            "ckpt": str(s2_dir / "G_233333333333.pth") if s2_dir else "",
            "weights": str(s2_exp) if s2_exp else "",
            "weightsName": s2_exp.name if s2_exp else "",
            "updatedAt": _mt(s2_dir or s2_exp),
            "how": "lightning" if s2_dir else ("weights" if s2_exp else ""),
        },
    }


def _dedup_audio(files: list[Path], log_path: Path | None = None) -> list[Path]:
    """按内容去重：早期上传没有去重，项目里可能残留同名/重复音频（例如 voice.mp3
    与 d2856bce….mp3 是同一文件），不清理会让同一段内容以 N 倍进入训练集。"""
    seen: dict[str, Path] = {}
    out: list[Path] = []
    for p in files:
        try:
            if not p.is_file():
                continue
        except Exception:
            continue
        h = _file_hash(p)
        if h and h in seen:
            _append_log(log_path, f"skip duplicate audio {p.name} (same content as {seen[h].name})")
            continue
        if h:
            seen[h] = p
        out.append(p)
    return out


def _reuse_state(
    d: Path, ds_dir: Path, speaker: str, audio_files: list[Path], sig: str, stamp: dict[str, Any] | None,
    reuse_req: bool,
) -> dict[str, Any]:
    """音频/文字/特征三层复用判定（只读盘，不动任何东西）。"""
    prev = [str(x) for x in (stamp or {}).get("clips") or []]
    list_path = ds_dir / f"{speaker}.list"
    clips = [ds_dir / n for n in prev]
    reuse_clips = bool(
        reuse_req and stamp and stamp.get("sig") == sig and _clips_ok(ds_dir, prev)
    )
    reuse_list = bool(reuse_clips and _list_matches(list_path, prev))
    reuse_feats = bool(
        reuse_list
        and stamp
        and stamp.get("featSig") == _feature_signature(clips)
        and _features_ok(ds_dir, clips, list_path)
    )
    return {
        "clips": prev,
        "listPath": list_path,
        "reuseClips": bool(reuse_clips),
        "reuseList": bool(reuse_list),
        "reuseFeatures": bool(reuse_feats),
    }


def _resolve_epochs(
    mode: str, ms: dict[str, Any], extra_s1: int | None, extra_s2: int | None
) -> dict[str, Any]:
    """把「重新训练 / 继续迭代 + 轮数输入」换算成引擎要的总轮数。

    fresh：train.epochs 就是总轮数，从预训练底模开始（base=0）。
    continue：base = 已完成轮数，total = base + 追加；
              有 Lightning 断点 -> 引擎自动续训（我们只改总数）；
              只剩导出权重   -> 用导出权重当 pretrained_*，轮数从 1 重新计。
    """
    if mode != "continue":
        t1 = max(1, int(extra_s1 or S1_FRESH_EPOCHS))
        t2 = max(1, int(extra_s2 or S2_FRESH_EPOCHS))
        return {
            "s1Base": 0, "s1Total": t1, "s1Extra": t1,
            "s2Base": 0, "s2Total": t2, "s2Extra": t2,
            "s1From": None, "s2From": None,
        }
    s1_ok = bool(ms["s1"]["canContinue"])
    s2_ok = bool(ms["s2"]["canContinue"])
    # 只有 Lightning 断点 / logs_s2_*/G_*.pth 才会「轮数累加」：引擎自己恢复已完成轮数，
    # train.epochs 是总数。若只剩导出的半权重（logs_* 被删/换机器），引擎走
    # pretrained_* 分支，轮数从第 1 轮重新计 —— 这时总数就只能等于本次要练的轮数，
    # 否则用户点「+10 轮」会实际跑 40 轮。
    s1_from = Path(ms["s1"]["weights"]) if (s1_ok and ms["s1"]["how"] == "weights") else None
    s2_from = Path(ms["s2"]["weights"]) if (s2_ok and ms["s2"]["how"] == "weights") else None
    s1_base = int(ms["s1"]["epochsDone"]) if (s1_ok and s1_from is None) else 0
    s2_base = int(ms["s2"]["epochsDone"]) if (s2_ok and s2_from is None) else 0
    e1 = max(1, int(extra_s1 or S1_CONTINUE_EPOCHS))
    e2 = max(1, int(extra_s2 or S2_CONTINUE_EPOCHS))
    return {
        "s1Base": s1_base, "s1Extra": e1, "s1Total": max(1, s1_base + e1),
        "s2Base": s2_base, "s2Extra": e2, "s2Total": max(1, s2_base + e2),
        "s1From": s1_from, "s2From": s2_from,
        "s1CountedFromZero": s1_from is not None,
        "s2CountedFromZero": s2_from is not None,
    }


def train_plan(name: str, opts: dict[str, Any] | None = None) -> dict[str, Any]:
    """不动 GPU，只回答：按这个选项跑，实际会发生什么（面板/脚本预览用）。"""
    slug = _slug(name)
    m = _read_manifest(slug)
    if not m:
        raise ValueError("project_not_found")
    o = _norm_train_opts(opts)
    d = PROJECTS_DIR / slug
    ds_dir = ENGINE_DIR / "data" / slug / slug
    audio_files = _dedup_audio(sorted((d / "audio").iterdir()) if (d / "audio").is_dir() else [])
    sig = _prep_signature(audio_files, _read_transcript(d / "text" / "transcript.txt"))
    stamp = _read_prep_stamp(ds_dir)
    rs = _reuse_state(d, ds_dir, slug, audio_files, sig, stamp, o["reuseData"])
    ms = _model_state(slug, ds_dir)
    has_model = bool(ms["s1"]["canContinue"] or ms["s2"]["canContinue"])
    mode = o["mode"]
    if mode == "auto":
        mode = "continue" if has_model else "fresh"
    if mode == "continue" and not has_model:
        mode = "fresh"
    ep = _resolve_epochs(mode, ms, o["s1Epochs"], o["s2Epochs"])
    clip_paths = [ds_dir / str(n) for n in (rs["clips"] or [])]
    clips_sec = _clips_seconds_estimated(clip_paths)
    return {
        "ok": True,
        "slug": slug,
        "mode": mode,
        "modeRequested": o["mode"],
        "reuseData": o["reuseData"],
        "hasModel": has_model,
        "reuseClips": rs["reuseClips"],
        "reuseList": rs["reuseList"],
        "reuseFeatures": rs["reuseFeatures"],
        "clips": len(rs["clips"]),
        "clipsSec": clips_sec,
        "clipsMinutes": round(clips_sec / 60.0, 1),
        # 「练完有电流音」的两条体检：轮数是否超过这份语料撑得住的量 + 音频带宽
        "buzzRisk": _buzz_risk(clips_sec, ep["s2Total"]),
        "audioQuality": m.get("audioQuality") or (audio_bandwidth_audit(clip_paths) if clip_paths else {}),
        "s1": {"base": ep["s1Base"], "extra": ep["s1Extra"], "total": ep["s1Total"],
               "from": str(ep["s1From"] or "")},
        "s2": {"base": ep["s2Base"], "extra": ep["s2Extra"], "total": ep["s2Total"],
               "from": str(ep["s2From"] or "")},
    }


def model_info(name: str) -> dict[str, Any]:
    """面板用：这个项目现在有什么（模型 / 已整理数据），能选哪些训练方式。"""
    slug = _slug(name)
    m = _read_manifest(slug)
    if not m:
        raise ValueError("project_not_found")
    ds_dir = ENGINE_DIR / "data" / slug / slug
    st = _model_state(slug, ds_dir)
    stamp = _read_prep_stamp(ds_dir)
    clips: list[Path] = []
    total = 0.0
    try:
        clips = sorted(ds_dir.glob("*.wav"))
        total = round(sum(_wav_dur_sec(c) for c in clips), 1)
    except Exception:
        pass
    return {
        "ok": True,
        "slug": slug,
        "hasModel": bool(st["s1"]["canContinue"] or st["s2"]["canContinue"]),
        "s1": st["s1"],
        "s2": st["s2"],
        "dataset": {
            "clips": len(clips),
            "totalSec": total,
            "prepared": bool(stamp),
            "updatedAt": str((stamp or {}).get("updatedAt") or ""),
        },
        # 语料体检（采样的采样率 + 99% 能量截止）：面板据此提示电流音风险。
        # manifest 里有训练时算好的就直接用，避免每次开面板都重扫。
        "audioQuality": m.get("audioQuality") or (audio_bandwidth_audit(clips) if clips else {}),
        "trainedAt": m.get("trainedAt") or "",
        "lastMode": str(m.get("trainMode") or ""),
        "defaults": {
            "fresh": {"s1": S1_FRESH_EPOCHS, "s2": S2_FRESH_EPOCHS},
            "continue": {"s1": S1_CONTINUE_EPOCHS, "s2": S2_CONTINUE_EPOCHS},
        },
        # 面板据此算「轮数相对语料量是否偏多」的提示，避免前后端两套经验值各写一遍
        "epochGuidance": {"perMinute": EPOCHS_PER_MINUTE, "safeFloor": EPOCHS_SAFE_FLOOR},
    }


# ---------------- 训练中间产物 = 随时可试听的「live 模型」 ----------------
#
# 用户诉求：训练过程中，中间模型应当出现在「测试合成」的音色列表里，方便直接
# 试听、判断当前练到哪一步是不是能用；而且这个模型要随训练自动更新。
#
# 可行性（逐行核过引擎源码，不用额外导出任何东西）：
#   · s1_train.py 的 my_model_ckpt.on_train_epoch_end：每个 epoch 都 my_save 出
#     GPT_weights_v2/<exp>-e<N>.ckpt，内容就是 {"weight","config","info"} 半精度
#     推理格式 —— 和训练结束后注册进 voices/ 的那份是同一种文件；
#   · s2_train.py 每个 epoch savee 出 SoVITS_weights_v2/<name>_e<N>_s<step>.pth；
#   · api_v2 的 /set_gpt_weights、/set_sovits_weights 接受绝对路径热切换。
#   → 训练每推进一轮，盘上就多一个能直接推理的权重，"随训练更新"= 取最新那个。
#
# 两个必须处理的坑：
#   1) 写入竞态。my_save 先写同目录的 <时间戳>.pth 再 os.replace 到目标名（同卷
#      原子），但替换前会 os.remove(目标名)。所以只接受 mtime 距今 >= 2 秒、体积
#      正常的权重（实测每 11~16 秒出一轮，2 秒门槛既避开竞态又不影响新鲜度）。
#   2) 同名项目可能残留**上一次训练**的高轮数权重（重新训练后 e100 还是旧数据）。
#      训练线程启动时记录 startedAt，优先只认本次训练产出的文件，并把来路如实标
#      成 fromCurrentRun，绝不拿旧模型冒充新进度。

LIVE_VOICE_PREFIX = "live:"
_LIVE_MIN_AGE_SEC = 2.0            # 刚写完 2 秒内的权重不采信（见上）
_LIVE_MIN_BYTES = 2 * 1024 * 1024  # 半精度 GPT ~148MB / SoVITS ~81MB，小于 2MB 必是残file
_LIVE_TTL_SEC = 3.0                # /api/status 每 5 秒轮询一次，扫盘结果缓存 3 秒
_LIVE_REF_TTL_SEC = 120.0
_LIVE_FRESH_SEC = 180.0            # 3 分钟内还在导权重 = 确有训练在跑（不是本后端起的也算）
_live_entry_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_live_ref_cache: dict[str, tuple[float, dict[str, Any]]] = {}

_LIVE_ID_RE = re.compile(r"^live:([^@:]+)(?:@g(\d+)_s(\d+))?$", re.I)


def live_voice_id(slug: str, gpt_epoch: int = 0, sovits_epoch: int = 0) -> str:
    """live 虚拟音色 id。不带轮数 = 永远跟着训练走最新一轮；带 @gN_sM = 固定轮次。"""
    s = _slug(slug)
    if int(gpt_epoch or 0) > 0 and int(sovits_epoch or 0) > 0:
        return "%s%s@g%d_s%d" % (LIVE_VOICE_PREFIX, s, int(gpt_epoch), int(sovits_epoch))
    return LIVE_VOICE_PREFIX + s


def parse_live_voice_id(voice_id: Any) -> tuple[str, int, int] | None:
    """解析 live 音色 id -> (slug, gptEpoch, sovitsEpoch)；不是 live 音色返回 None。"""
    m = _LIVE_ID_RE.match(str(voice_id or "").strip())
    if not m:
        return None
    return _slug(m.group(1)), int(m.group(2) or 0), int(m.group(3) or 0)


def is_live_voice_id(voice_id: Any) -> bool:
    return parse_live_voice_id(voice_id) is not None


def _live_rx(slug: str, kind: str) -> re.Pattern:
    """只认训练导出名的权重文件。
    必须按**文件名**匹配，不能按路径包含 slug —— data/<slug>/<slug>/logs_s1/ckpt
    里的 Lightning 断点（epoch=12-step=369668.ckpt）路径也含 slug，但它不是
    {"weight","config"} 推理格式，喂给 init_t2s_weights 会直接 KeyError。"""
    esc = re.escape(slug)
    if kind == "gpt":
        return re.compile(r"^%s[-_]e(\d+)\.(?:ckpt|pth)$" % esc, re.I)
    return re.compile(r"^%s[-_]e(\d+)_s(\d+)\.(?:pth|ckpt)$" % esc, re.I)


def _live_weight_dirs(kind: str) -> list[Path]:
    if kind == "gpt":
        names = ("GPT_weights_v2", "GPT_weights_v3", "GPT_weights_v2Pro", "GPT_weights")
    else:
        names = ("SoVITS_weights_v2", "SoVITS_weights_v3", "SoVITS_weights_v2Pro", "SoVITS_weights")
    return [ENGINE_DIR / n for n in names]


def _ago_label(ts: float) -> str:
    d = max(0.0, time.time() - float(ts or 0))
    if d < 5:
        return "刚刚"
    if d < 60:
        return "%d 秒前" % int(d)
    if d < 3600:
        return "%d 分钟前" % int(d // 60)
    if d < 86400:
        return "%.1f 小时前" % (d / 3600)
    return "%.1f 天前" % (d / 86400)


def _scan_live_weights(
    slug: str, kind: str, after_ts: float = 0.0, want_epoch: int = 0, prefer_recent: bool = False
) -> dict[str, Any] | None:
    """找该项目最新（或指定轮数）的导出权重。want_epoch>0 时只认那一轮。

    after_ts>0（= 正在训练，本轮开始时间）时**硬性只认本轮产出的文件**：
    同名项目上一次训练留下的 e30 会比本轮的 e5 轮数更高，若不按时间过滤，
    "跟随最新"的中间模型会在本轮刚练到第 5 轮时报出第 30 轮 —— 那是拿旧模型
    冒充新进度，比报不出来更糟。本轮还没有产物时宁可返回 None（面板显示"还没
    有训练产物"），用户想听上一版可以显式固定轮次（live:<slug>@gN_sM）。

    prefer_recent=True：训练在跑、但这个后端不知道开始时间（后端重启过、或训练
    是另一个进程起的，例如继续迭代时本轮轮数比上次留下的文件名还小）—— 这时按
    **最后写入时间**认定最新，而不是按轮数大小，否则会把上一次训练的 e100 当成
    这次的进度。
    """
    rx = _live_rx(slug, kind)
    found: list[tuple[int, int, float, Path]] = []
    for d in _live_weight_dirs(kind):
        try:
            if not d.is_dir():
                continue
            for p in d.iterdir():
                try:
                    mm = rx.match(p.name)
                    if not mm or not p.is_file():
                        continue
                    stt = p.stat()
                    if stt.st_size < _LIVE_MIN_BYTES:
                        continue
                    if want_epoch <= 0 and (time.time() - stt.st_mtime) < _LIVE_MIN_AGE_SEC:
                        continue  # 可能还在 os.replace 的窗口里
                    if want_epoch > 0 and int(mm.group(1)) != int(want_epoch):
                        continue
                    if after_ts and want_epoch <= 0 and stt.st_mtime + 1.0 < after_ts:
                        continue  # 上一轮训练留下的同名权重，不属于本次
                    step = 0
                    if len(mm.groups()) >= 2 and mm.group(2):
                        try:
                            step = int(mm.group(2))
                        except Exception:  # noqa: BLE001
                            step = 0
                    found.append((int(mm.group(1)), step, stt.st_mtime, p))
                except Exception:  # noqa: BLE001
                    continue
        except Exception:  # noqa: BLE001
            continue
    if not found:
        return None
    # 默认"轮数最大者优先"；训练进行中（prefer_recent）时改成"最后写入者优先"
    found.sort(key=(lambda f: (f[2], f[0], f[1])) if prefer_recent else (lambda f: (f[0], f[1], f[2])))
    ep, step, mt, p = found[-1]
    size = 0.0
    try:
        size = round(p.stat().st_size / 1048576.0, 1)
    except Exception:  # noqa: BLE001
        pass
    return {
        "path": str(p),
        "name": p.name,
        "epoch": ep,
        "step": step,
        "sizeMB": size,
        "mtime": mt,
        "updatedAt": time.strftime("%H:%M:%S", time.localtime(mt)),
        "ago": _ago_label(mt),
        "fromCurrentRun": bool(after_ts and mt >= after_ts) if after_ts else False,
        "all": [f[0] for f in found],
    }


def _live_last_export(slug: str) -> float:
    """该项目最近一次往权重目录**写文件**的时间（不做任何过滤）。
    用来判断"是不是真有训练在跑"—— 训练是另一个后端/进程起的时也只能靠这个。"""
    newest = 0.0
    for kind in ("gpt", "s2"):
        rx = _live_rx(slug, kind)
        for d in _live_weight_dirs(kind):
            try:
                if not d.is_dir():
                    continue
                for p in d.iterdir():
                    try:
                        if not rx.match(p.name) or not p.is_file():
                            continue
                        stt = p.stat()
                        if stt.st_size < _LIVE_MIN_BYTES:
                            continue
                        newest = max(newest, stt.st_mtime)
                    except Exception:  # noqa: BLE001
                        continue
            except Exception:  # noqa: BLE001
                continue
    return newest


def _live_trial_ref(slug: str, ds_dir: Path) -> dict[str, Any]:
    """试听用的参考音频 + 参考文本。

    优先用项目**已注册音色**的 ref.wav（和最终效果同源，试听结果可直接对比）；
    没有（训练还没跑完 / 中途取消）就用数据集里 3–10 秒、且有文字标注的分段
    —— api_v2 硬性要求参考音频 3~10 秒，prompt_text 必须与参考音频内容逐字一致，
    否则会拉低音色相似度（这也是 aoi 那个"图片描述当参考文本"的问题所在）。
    """
    key = slug
    now = time.time()
    hit = _live_ref_cache.get(key)
    if hit and (now - hit[0]) < _LIVE_REF_TTL_SEC:
        return hit[1]
    out: dict[str, Any] = {}
    vdir = VOICES_DIR / slug
    ref = vdir / "ref.wav"
    try:
        if ref.is_file():
            dur = _wav_dur_sec(ref)
            if 3.0 <= dur <= 10.0:
                txt = ""
                try:
                    if (vdir / "ref.txt").is_file():
                        txt = (vdir / "ref.txt").read_text(encoding="utf-8").strip()
                except Exception:  # noqa: BLE001
                    txt = ""
                out = {"path": str(ref), "file": ref.name, "dur": round(dur, 2), "source": "voice", "promptText": txt}
    except Exception:  # noqa: BLE001
        pass
    if not out:
        # 数据集分段：按名字顺序找第一个时长合格、且能查到逐段文字的
        picked: tuple[Path, float] | None = None
        try:
            if ds_dir.is_dir():
                # 大项目（上万分段）不能让面板轮询去全量 open wav 探时长：
                # 找到第一个合格分段就走，最多看 300 个。
                for i, p in enumerate(sorted(ds_dir.iterdir())):
                    if i > 300:
                        break
                    if not p.name.lower().endswith(".wav"):
                        continue
                    try:
                        d = _wav_dur_sec(p)
                    except Exception:  # noqa: BLE001
                        continue
                    if 3.0 <= d <= 10.0:
                        picked = (p, d)
                        break
                    if picked is None and 2.0 <= d <= 12.0:
                        picked = (p, d)  # 兜底：时长略偏也先记下
        except Exception:  # noqa: BLE001
            picked = None
        if picked:
            p, d = picked
            txt = _find_segment_transcript(slug, p.name) or ""
            out = {"path": str(p), "file": p.name, "dur": round(d, 2), "source": "dataset", "promptText": txt}
    _live_ref_cache[key] = (now, out)
    return out


def live_model(name: str, gpt_epoch: int = 0, sovits_epoch: int = 0, use_cache: bool = True) -> dict[str, Any]:
    """一个项目的「训练中间模型」快照：最新可用的 GPT/SoVITS 权重 + 试听参考音。
    返回值同时是**音色形状**（refAudio/promptText/weights/lang），可直接喂给
    tts.synthesize()，所以 live:<项目> 能像普通音色一样出现在测试合成里。"""
    slug = _slug(name)
    pinned = bool(gpt_epoch and sovits_epoch)
    ckey = "%s@%d_%d" % (slug, gpt_epoch, sovits_epoch)
    now = time.time()
    if use_cache and not pinned:
        hit = _live_entry_cache.get(ckey)
        if hit and (now - hit[0]) < _LIVE_TTL_SEC:
            return hit[1]
    m = _read_manifest(slug) or {}
    ds_dir = ENGINE_DIR / "data" / slug / slug
    st = _running.get(slug) or {}
    started = float(st.get("startedAt") or 0.0)
    # 训练确实在跑、但这个后端不知道开始时间（后端重启过 / 训练是别的进程起的）：
    # 按"最近还在导权重"推断进行中，并改按写入时间认定最新 —— 否则继续迭代时
    # 本轮的 e74 会被上一次留下的 e100 顶掉，面板报出一个假的轮数。
    inferred = False
    if not started and not st and not pinned:
        try:
            last_exp = _live_last_export(slug)
        except Exception:  # noqa: BLE001
            last_exp = 0.0
        inferred = bool(last_exp) and (now - last_exp) <= _LIVE_FRESH_SEC
    g = _scan_live_weights(slug, "gpt", started, gpt_epoch, prefer_recent=inferred)
    s = _scan_live_weights(slug, "s2", started, sovits_epoch, prefer_recent=inferred)
    ref = _live_trial_ref(slug, ds_dir) if (g or s) else {}

    newest = max([x["mtime"] for x in (g, s) if x] or [0.0])
    usable = bool(g and s and ref.get("path"))
    reason = ""
    if not usable:
        if not g and not s:
            reason = "还没有任何训练产物（开始训练后，每练完一轮就会出现一次）"
        elif not g:
            reason = "GPT (s1) 还没有导出权重"
        elif not s:
            reason = "SoVITS (s2) 还没有导出权重 —— 训练走到第 8 步「SoVITS 模型训练」练完第 1 轮即可试听"
        else:
            reason = "找不到 3–10 秒的参考音频，无法试听"
    bits: list[str] = []
    stale_run = False
    if g:
        bits.append("GPT 第 %d 轮%s" % (g["epoch"], "（上次训练）" if (st and not g["fromCurrentRun"]) else ""))
        stale_run = stale_run or bool(st and not g["fromCurrentRun"])
    if s:
        bits.append("SoVITS 第 %d 轮%s" % (s["epoch"], "（上次训练）" if (st and not s["fromCurrentRun"]) else ""))
        stale_run = stale_run or bool(st and not s["fromCurrentRun"])
    total1, total2 = m.get("s1Epochs") or 0, m.get("s2Epochs") or 0
    label = " · ".join(bits) if bits else "无中间模型"
    entry: dict[str, Any] = {
        "ok": True,
        "kind": "live",
        "id": live_voice_id(slug, gpt_epoch if pinned else 0, sovits_epoch if pinned else 0),
        "voiceId": live_voice_id(slug, gpt_epoch if pinned else 0, sovits_epoch if pinned else 0),
        "project": slug,
        "name": "%s（中间模型）" % (m.get("name") or slug),
        "label": label,
        "pinned": pinned,
        "running": bool(st) or inferred,
        "runningInferred": bool(inferred and not st),
        "phase": str(st.get("phase") or m.get("phase") or ""),
        "phaseLabel": str(st.get("phaseLabel") or m.get("phaseLabel") or ""),
        "pct": float(st.get("pct") or m.get("pct") or 0),
        "epoch": st.get("epoch"),
        "epochTotal": st.get("epochTotal"),
        "loss": st.get("loss"),
        "epochTotals": {"gpt": int(total1 or 0), "sovits": int(total2 or 0)},
        "gpt": g,
        "sovits": s,
        "ref": ref,
        "usable": usable,
        "reason": reason,
        "updatedAt": newest,
        "updatedLabel": _ago_label(newest) if newest else "",
        # ---- 音色形状（tts.synthesize 直接可用）----
        "trained": True,
        "lang": "",
        "refAudio": str(ref.get("path") or ""),
        "promptText": str(ref.get("promptText") or ""),
        "weights": {"gpt": str((g or {}).get("path") or ""), "sovits": str((s or {}).get("path") or "")},
    }
    if usable:
        entry["hint"] = (
            "训练中间产物：%s，%s更新" % (label, entry["updatedLabel"] or "刚刚")
            + ("；再点一次「合成」即自动用最新一轮权重" if not pinned else "；已固定轮次，不会随训练更新")
            + ("；注意 GPT 权重来自上一次训练" if stale_run else "")
            + ("；训练进程不是本后端起的，轮数按最近写入的权重判定" if inferred else "")
        )
    else:
        entry["hint"] = reason
    if not pinned:
        _live_entry_cache[ckey] = (now, entry)
    return entry


def list_live_models() -> list[dict[str, Any]]:
    """给面板 / HTTP 用的 live 模型列表。

    收录条件（刻意收窄，免得音色下拉被历史权重淹没）：
      · 正在训练的项目 —— 一定要出现，这就是"训练中试听"的主场景；
      · 或者磁盘上的最新导出权重 ≠ voices/<slug>/weights.json 里那份 —— 也就是
        "有比已注册音色更新的模型"（训练中断、失败、或刚加练完还没注册）。
    """
    out: list[dict[str, Any]] = []
    try:
        slugs = set(_running.keys())
    except Exception:  # noqa: BLE001
        slugs = set()
    try:  # 所有项目都盘一遍：训练中断/失败的项目同样有值得试听的中途权重
        for pm in PROJECTS_DIR.glob("*/manifest.json") if PROJECTS_DIR.is_dir() else []:
            slugs.add(pm.parent.name)
    except Exception:  # noqa: BLE001
        pass
    for slug in sorted(slugs):
        try:
            e = live_model(slug)
        except Exception:  # noqa: BLE001
            continue
        if not (e.get("gpt") or e.get("sovits")):
            continue
        if not e.get("running"):
            # 只有"比已注册音色更新"的中间模型才值得列出来
            reg = ""
            try:
                wj = VOICES_DIR / slug / "weights.json"
                if wj.is_file():
                    reg = str(json.loads(wj.read_text(encoding="utf-8")).get("sovits") or "")
            except Exception:  # noqa: BLE001
                reg = ""
            cur = str((e.get("sovits") or {}).get("path") or "")
            if reg and cur and Path(reg).name == Path(cur).name:
                continue
        out.append(e)
    out.sort(key=lambda x: (not x.get("running"), -float(x.get("updatedAt") or 0)))
    return out


def live_voice(voice_id: Any) -> dict[str, Any] | None:
    """把 live:<项目>[@gN_sM] 解析成音色字典（tts.get_voice 的 live 分支）。"""
    got = parse_live_voice_id(voice_id)
    if not got:
        return None
    slug, ge, se = got
    try:
        e = live_model(slug, ge, se)
    except Exception:  # noqa: BLE001
        return None
    if not e.get("usable"):
        e["error"] = e.get("reason") or "live_model_unusable"
        return e
    return e


# ---------------- main training flow ----------------

def _run_train(slug: str, opts: dict[str, Any] | None = None) -> None:
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
    opts: dict[str, Any] = opts if isinstance(opts, dict) else {}
    mode_req = str(opts.get("mode") or "auto").strip().lower()
    if mode_req not in ("auto", "fresh", "continue"):
        mode_req = "auto"
    reuse_req = opts.get("reuseData")
    reuse_req = True if reuse_req is None else bool(reuse_req)

    def _ep(name: str, dflt: int) -> int | None:
        try:
            v = opts.get(name)
        except Exception:
            return None
        if v is None or str(v).strip() == "":
            return None
        try:
            n = int(float(str(v).strip()))
        except Exception:
            return None
        return n if 1 <= n <= 2000 else None

    try:
        # 0a) engine ckpt save robustness: weight dirs (GPT_weights_v2 /
        #     SoVITS_weights_v2 / logs) are never created by the headless
        #     pipeline, so the stock my_save -> shutil.move dies with
        #     PermissionError at the first checkpoint save. Patch + mkdir here.
        _update(m, "prep", "准备环境", 3, "检查权重保存目录…")
        _patch_engine_ckpt_save()

        # 1) 音频清单 + 数据集指纹（内容没变 -> 允许整段复用已整理好的数据）
        _update(m, "audio", "整理音频", 4, "扫描音频文件…")
        audio_files = sorted((d / "audio").iterdir()) if (d / "audio").is_dir() else []
        audio_files = _dedup_audio(audio_files, log_path)
        n_audio = len(audio_files)
        if not n_audio:
            raise RuntimeError("no_audio_files")
        ds_dir.mkdir(parents=True, exist_ok=True)
        sig = _prep_signature(audio_files, _read_transcript(d / "text" / "transcript.txt"))
        stamp = _read_prep_stamp(ds_dir)
        rs = _reuse_state(d, ds_dir, speaker, audio_files, sig, stamp, reuse_req)
        prev_clips = rs["clips"]
        list_path = rs["listPath"]
        reuse_clips = rs["reuseClips"]
        reuse_list = rs["reuseList"]

        # 2) 现有模型盘点 —— 「已存在模型时可选择重新训练还是继续迭代」的判据
        ms = _model_state(slug, ds_dir)
        has_model = bool(ms["s1"]["canContinue"] or ms["s2"]["canContinue"])
        mode = mode_req
        if mode == "auto":
            # 「自动」= 用户没特别指定：已有模型就继续迭代（不重复处理数据、不从零
            # 重训），没有模型就全新训练。面板上会把这一步实际会做什么写清楚。
            mode = "continue" if has_model else "fresh"
            _append_log(log_path, "训练方式=自动 -> " + ("已有模型，按继续迭代处理" if mode == "continue" else "无模型，按重新训练处理"))
        if mode == "continue" and not has_model:
            _append_log(log_path, "mode=continue，但项目下没有任何已训权重 -> 自动改为重新训练")
            mode = "fresh"
        m["trainMode"] = mode
        m["reuseData"] = bool(reuse_clips)
        _append_log(
            log_path,
            "训练方式=" + ("继续迭代（在当前模型上加练）" if mode == "continue" else "重新训练（从预训练底模开始）")
            + f"；GPT 已完成 {ms['s1']['epochsDone']} 轮"
            + f"（{'Lightning 断点' if ms['s1']['how'] == 'lightning' else ('已导出权重' if ms['s1']['how'] == 'weights' else '无')}）"
            + f"，SoVITS 已完成 {ms['s2']['epochsDone']} 轮"
            + f"（{'Lightning 断点' if ms['s2']['how'] == 'lightning' else ('已导出权重' if ms['s2']['how'] == 'weights' else '无')}）",
        )
        # 追加轮数：继续迭代 = 在已完成轮数上再加；重新训练 = 直接就是总轮数。
        # 引擎里 train.epochs 永远是「总轮数」（s1 由 Lightning 恢复 current_epoch，
        # s2 由 logs_s2_*/G_*.pth 的 iteration 推 epoch_str），所以这里换算成总数。
        extra_s1 = _ep("s1Epochs", S1_CONTINUE_EPOCHS if mode == "continue" else S1_FRESH_EPOCHS)
        extra_s2 = _ep("s2Epochs", S2_CONTINUE_EPOCHS if mode == "continue" else S2_FRESH_EPOCHS)
        ep = _resolve_epochs(mode, ms, extra_s1, extra_s2)
        s1_base, s2_base = ep["s1Base"], ep["s2Base"]
        s1_total, s2_total = ep["s1Total"], ep["s2Total"]
        s1_from, s2_from = ep["s1From"], ep["s2From"]
        m["s1Epochs"], m["s2Epochs"] = s1_total, s2_total
        m["s1EpochsBase"], m["s2EpochsBase"] = s1_base, s2_base
        m["s1EpochsExtra"], m["s2EpochsExtra"] = ep["s1Extra"], ep["s2Extra"]
        _append_log(
            log_path,
            f"本轮 s1 目标总轮数 {s1_total}（已完成 {s1_base}）；s2 目标总轮数 {s2_total}（已完成 {s2_base}）"
            + (f"；s1 底模 {s1_from.name}" if s1_from else "")
            + (f"；s2 底模 {s2_from.name}" if s2_from else ""),
        )
        if mode == "continue" and st0 is not None:
            st0["detail"] = f"继续迭代：s1 {s1_base}->{s1_total} 轮，s2 {s2_base}->{s2_total} 轮"

        # 0) 数据集目录：全新重训时才清断点；继续迭代必须保留 logs_s1 / logs_s2_*
        _update(m, "prep", "准备数据集", 3, "创建数据集目录…")
        if mode == "fresh":
            # 旧 logs_s1 里的 ckpt 可能是「无 pretrained_s1 时代」随机初始化训出来的
            # 坏模型（推理立刻 EOS），而 s1_train.py 会优先从最新 ckpt 续训并忽略
            # pretrained_s1 —— 重新训练时必须删掉才会真正从底模开始。
            for _sub in ("logs_s1", "logs_s2_v1", "logs_s2_v2"):
                _p = ds_dir / _sub
                if _p.is_dir():
                    shutil.rmtree(_p, ignore_errors=True)
                    _append_log(log_path, f"clean: removed {_sub} (fresh start from pretrained)")
        else:
            _append_log(log_path, "continue: 保留 logs_s1 / logs_s2_* 断点（在当前模型上加练）")

        if not reuse_clips:
            # 音频内容变了（或首次训练）：整套特征必须作废重建。
            # 注意官方目录名是 3-bert / 4-cnhubert / 5-wav32k / 6-name2semantic.tsv，
            # 早期这里误删过不存在的目录名，导致旧毒数据（0001 的 187s 整段音频特征）
            # 跨运行残留。
            for sub in ("3-bert", "4-cnhubert", "5-wav32k"):
                shutil.rmtree(ds_dir / sub, ignore_errors=True)
            for fn in ("2-name2text.txt", "2-name2text-0.txt", "6-name2semantic.tsv", "6-name2semantic-0.tsv"):
                try:
                    (ds_dir / fn).unlink(missing_ok=True)
                except Exception:
                    pass
            for stale in sorted(ds_dir.glob("*.wav")):
                try:
                    stale.unlink(missing_ok=True)
                except Exception:
                    pass
            # 1) convert uploads -> 32k mono raw wav (per-file progress 5→7)
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
                _convert_to_wav(src, raw)
                raws.append(raw)

            # 1a) 可选高频空带填充（缓解电流音；默认关，勾选才启用）。
            # 只改 raw（32k mono），切分出的每段 clip 都带填充效果；且 raw 内容
            # 变了 -> 音频指纹变 -> 复用判定自然失效，重训即重新整理，无需手动删数据。
            dither_done = 0
            if o.get("dither"):
                _update(m, "audio", "高频空带填充", 7.1, "检测并填充低带宽音频…")
                for raw in raws:
                    if _dither_highband(raw):
                        dither_done += 1
                if dither_done:
                    _append_log(
                        log_path,
                        f"dither: {dither_done}/{len(raws)} 段音频命中低带宽"
                        f"（99% 能量截止 < {HIGHBAND_CUTOFF_KHZ} kHz），已在空高频带填充极低电平噪声"
                        "（缓解手段；根治仍建议换 ≥32 kHz 原始素材重训）",
                    )
                else:
                    _append_log(log_path, "dither: 所有音频高频带正常，无需填充")
                m["ditherDone"] = dither_done

            # 1b) segment long audio into short clips — GPT-SoVITS 需要 3–15 秒短段
            #     (max_sec=54s)，单条长音频会被 s1 数据集整个过滤掉（空数据集→除零）。
            _update(m, "audio", "切分音频", 7, "按静音切分长音频…")
            wav_list = _segment_audio_files(raws, ds_dir, log_path, m, slug)
            if not wav_list:
                raise RuntimeError("segmentation produced no clips")
            _append_log(log_path, f"{len(wav_list)} clips ready for training")
            _log_bandwidth(wav_list, log_path, m, s2_total=s2_total)
            reuse_list = False
        else:
            wav_list = [ds_dir / n for n in prev_clips]
            total_sec = round(sum(_wav_dur_sec(c) for c in wav_list), 1)
            _append_log(
                log_path,
                f"reuse: 音频内容未变，复用 {len(wav_list)} 段已整理音频（{total_sec}s），跳过转换与静音切分",
            )
            _update(m, "audio", "复用已整理音频", 7.5, f"复用 {len(wav_list)} 段（{total_sec}s），未重复切分")
            # 复用旧数据时也要体检：老版本把语料压成过 16 kHz，这份提醒就是给用户
            # 看的「为什么练完有电流音」——不拦训练，只如实说。
            if not m.get("audioQuality"):
                _log_bandwidth(wav_list, log_path, m, s2_total=s2_total)
            # 逐段哈希兜底：同名分段若内容变了，只作废这些段的特征
            _prune_stale_features(ds_dir, wav_list, stamp, log_path)

        # 2) transcript list — 逐句文字能对齐切分后的音频时直接使用，否则 ASR 转写
        if reuse_list:
            _append_log(log_path, f"reuse: 复用已有文字标注 {list_path.name}，跳过 ASR 转写")
            _update(m, "list", "复用文字标注", 9.5, f"复用 {len(wav_list)} 条已整理文字，未重跑 ASR")
        else:
            _update(m, "list", "文字标注", 9, "写入文字标注列表…")
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
        #     导致毒数据跨运行残留。检测到时长失配时清理对应产物。
        #     注意：重新训练时顺带删掉在毒数据上训出的 logs_*；继续迭代时不动模型，
        #     只把坏特征重算（否则用户点「继续迭代」会被静默改成从头重训）。
        _repair_dataset(ds_dir, log_path, drop_models=(mode == "fresh"))
        # 2c) 全新训练才强制从预训练底模开始（continue 保留断点，见上）
        if mode == "fresh" and _find_s1_pretrained():
            for _sub in ("logs_s1", "logs_s2_v1", "logs_s2_v2"):
                _p = ds_dir / _sub
                if _p.is_dir():
                    shutil.rmtree(_p, ignore_errors=True)
                    _append_log(log_path, f"clean: removed {_sub} (fresh start from pretrained)")

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
        # 3) 官方特征产物是否已经齐全？齐全就整步跳过（这就是「已整理过的文字/音频
        #    不再重新处理」在特征层的落点：1-get-text 的 BERT/音素、2-get-hubert 的
        #    wav32k+hubert、3-get-semantic 的语义 token 都是最花时间的一段）。
        feat_sig = _feature_signature(wav_list)
        # 特征层以「此刻磁盘」为准重新判定：_repair_dataset / _prune_stale_features
        # 可能刚清掉毒数据或内容变了的分段特征，用早先的结论会漏算。
        reuse_feats = bool(
            reuse_clips
            and reuse_list
            and stamp
            and stamp.get("featSig") == feat_sig
            and _features_ok(ds_dir, wav_list, list_path)
        )
        if reuse_feats:
            _append_log(
                log_path,
                "reuse: 音素/BERT、HuBERT、语义 token 特征均已存在 -> 跳过 1/2/3-get-*.py（%d 段）" % len(wav_list),
            )
            _update(m, "semantic", "复用已提取特征", 60, "特征已就绪，跳过 BERT / HuBERT / 语义 token")
        else:
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
                raw_tsv = tsv.read_text(encoding="utf-8")
                first = raw_tsv.split("\n", 1)[0] if raw_tsv else ""
                if first and "\t" in first and first.split("\t", 1)[0].strip() not in ("name", "item_name"):
                    tsv.write_text("name\tsemantic\n" + raw_tsv, encoding="utf-8")
                    _append_log(log_path, "prepended header to 6-name2semantic.tsv")
        # 记录本次整理结果，供下次判断「数据是否已经处理过」
        _write_prep_stamp(
            ds_dir,
            {
                "ver": PREP_VER,
                "sig": sig,
                "featSig": feat_sig,
                "clips": [c.name for c in wav_list],
                "clipHashes": {c.name: _clip_hash_one(c) for c in wav_list},
                "clipTotalSec": round(sum(_wav_dur_sec(c) for c in wav_list), 1),
                "listLang": "zh",
                "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "expName": exp_name,
                "speaker": speaker,
            },
        )

        # 4) s1 GPT training
        s1_cfg = _build_s1_config(slug, exp_name, speaker, ds_dir, epochs=s1_total, pretrained=s1_from)
        s1 = _find_script("s1_train.py", "GPT_SoVITS/s1_train.py")
        if s1 is None:
            raise RuntimeError("s1_train.py not found")
        _update(
            m, "s1", "GPT 模型训练 (s1)", 60,
            ("继续迭代：第 %d→%d 轮" % (s1_base + 1, s1_total)) if mode == "continue"
            else ("共 %d 轮" % s1_total),
        )
        _run_step(
            slug, [sys.executable, str(s1), "--config_file", str(s1_cfg)], ENGINE_DIR,
            "s1", "GPT 模型训练 (s1)", 60, 85, log_path, parse_epoch=True,
            epoch_total=s1_total, epoch_zero_based=True,
        )

        # 5) s2 SoVITS training
        s2_cfg = _build_s2_config(slug, exp_name, speaker, ds_dir, epochs=s2_total, pretrained_g=s2_from)
        s2 = _find_script("s2_train.py", "GPT_SoVITS/s2_train.py")
        if s2 is None:
            raise RuntimeError("s2_train.py not found")
        _update(
            m, "s2", "SoVITS 模型训练 (s2)", 85,
            ("继续迭代：第 %d→%d 轮" % (s2_base + 1, s2_total)) if mode == "continue"
            else ("共 %d 轮" % s2_total),
        )
        _run_step(
            slug, [sys.executable, str(s2), "--config", str(s2_cfg)], ENGINE_DIR,
            "s2", "SoVITS 模型训练 (s2)", 85, 97, log_path, parse_epoch=True,
            epoch_total=s2_total,
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


def _convert_to_wav(src: Path, dst: Path, sr: int = TARGET_SR) -> None:
    """统一成单声道 wav 交给切分管线。

    采样率：GPT-SoVITS 的 s2 模型本来就是 **32 kHz**（s2G488k 就是 32k 模型），
    引擎自己也会把语料转成 5-wav32k。以前这里写死 `-ar 16000`，等于在引擎看到
    音频之前先把 8 kHz 以上的信息全删了，之后只能把 16k 升采样回 32k 去训练 ——
    实测代价（aoi 语料）：5-wav32k 里 8–16 kHz 的能量只有 0.001~0.004%
    （真人录音同一段约 0.4~0.6%），整个高频带是空的，而声码器照样要出 32k，
    那一段就只能是"编"出来的 —— 听感就是练完之后出现的电流音 / 毛刺 / 发沙。
    所以这里改成保留到 32 kHz：源高于 32k 的降到 32k，源本来就低的不动它
    （低带宽是素材本身的问题，见下面的 bandwidthNote 体检提示）。
    """
    ff = shutil.which("ffmpeg")
    if not ff:
        # try common bundled location
        cand = ENGINE_DIR / "ffmpeg.exe"
        if cand.is_file():
            ff = str(cand)
    if not ff:
        raise RuntimeError(f"ffmpeg not found — cannot convert {src.name}; upload wav files instead")
    r = subprocess.run(
        [ff, "-y", "-i", str(src), "-ar", str(int(sr)), "-ac", "1", str(dst)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    if r.returncode != 0 or not dst.is_file():
        raise RuntimeError(f"ffmpeg convert failed: {src.name}")


# 兼容旧名字（历史脚本/测试里可能引用过）
_convert_to_wav16k = _convert_to_wav


# 高频空带填充（dither）：对 99% 能量截止 < HIGHBAND_CUTOFF_KHZ 的 32k raw，
# 在 [截止频率, DITHER_BAND_TOP] 频带叠加极低电平的白噪声。
# 目的：让声码器在该频带"看到"一点内容，而不是纯空白凭空生成（空白高频正是
# 训练完电流音 / 毛刺 / 发沙的来源，见 audio_bandwidth_audit 的 note）。
# 注意：这是缓解手段，不是修复 —— 根治仍是换 ≥32 kHz 原始素材重训。
HIGHBAND_CUTOFF_KHZ = 7.0    # 与 audio_bandwidth_audit 的体检阈值保持一致
DITHER_NOISE_RMS = 0.0005    # 极低电平：约 -66 dBFS，远低于语音能量，不引入可听噪声
DITHER_BAND_TOP_KHZ = 15.0   # 上限取 15k，避免碰 Nyquist（16k）附近的边缘伪影
DITHER_FADE_KHZ = 0.5        # 填充带两端 0.5 kHz 余弦淡入/淡出，避免带边缘突变


def _dither_highband(
    raw: Path,
    cutoff_khz: float = HIGHBAND_CUTOFF_KHZ,
    noise_rms: float = DITHER_NOISE_RMS,
) -> bool:
    """若 raw 的 99% 能量截止低于 cutoff，则在其空高频带叠加上极低电平白噪声。

    就地改写 raw（32k mono wav）。返回是否真的做了填充（True = 命中低带宽）。
    频域实现：噪声能量精确落在空频带内，不污染低频语音主能量区。
    """
    import numpy as np
    import soundfile as sf

    try:
        y, sr = sf.read(str(raw), dtype="float32", always_2d=True)
    except Exception:  # noqa: BLE001
        return False
    y = y.mean(axis=1) if y.ndim > 1 and y.shape[1] > 1 else y.ravel()
    if y.size < 2048 or sr <= 0:
        return False
    rolloff_khz = _rolloff_khz(raw)  # 复用现有 99% 能量截止计算
    if rolloff_khz <= 0 or rolloff_khz >= cutoff_khz:
        return False

    n = len(y)
    f_lo = int(rolloff_khz * 1000)
    f_hi = int(DITHER_BAND_TOP_KHZ * 1000)
    lo = max(0, int(f_lo * n / sr))
    hi = min(n, int(f_hi * n / sr))
    if hi - lo < 2048:
        return False

    spec = np.fft.rfft(y)
    freqs = np.fft.rfftfreq(n, 1.0 / sr)
    band = (freqs >= f_lo) & (freqs <= f_hi)
    n_bins = int(band.sum())
    if n_bins <= 0:
        return False
    # 噪声在频带内功率 ≈ (noise_rms^2 * n)，频域幅值取均方根
    amp = float(noise_rms) * np.sqrt(n) / np.sqrt(n_bins)
    fade_bins = max(1, int(DITHER_FADE_KHZ * 1000 * n / sr))
    edges = np.ones(n_bins, dtype=np.float32)
    if fade_bins < n_bins:
        r = min(fade_bins, n_bins // 4)
        edges[:r] = 0.5 - 0.5 * np.cos(np.linspace(0.0, np.pi, r))
        edges[-r:] = 0.5 - 0.5 * np.cos(np.linspace(0.0, np.pi, r)[::-1])
    noise = np.zeros_like(spec)
    noise[band] = amp * np.exp(2j * np.pi * np.random.default_rng().random(n_bins)) * edges
    y2 = y + np.fft.irfft(noise, n)
    peak = float(np.max(np.abs(y2)))
    if peak > 0.99:
        y2 = y2 * (0.99 / peak)
    try:
        sf.write(str(raw), y2.astype("float32"), sr, subtype="PCM_16")
    except Exception:  # noqa: BLE001
        return False
    return True


def _wav_sr(p: Path) -> int:
    try:
        with wave.open(str(p), "rb") as w:
            return int(w.getframerate())
    except Exception:  # noqa: BLE001
        return 0


def _rolloff_khz(p: Path, frac: float = 0.99) -> float:
    """99% 能量截止频率（kHz）。用来判断这份音频到底有没有高频内容。"""
    try:
        import numpy as np
        import soundfile as sf

        y, sr = sf.read(str(p), dtype="float32", always_2d=True)
        y = y.mean(axis=1)
        if y.size < 2048 or sr <= 0:
            return 0.0
        win = getattr(np, "hanning", np.hanning)(2048)
        n = y.size // 2048
        fr = y[: n * 2048].reshape(n, 2048) * win
        psd = (np.abs(np.fft.rfft(fr, axis=1)) ** 2).mean(axis=0)
        f = np.fft.rfftfreq(2048, 1.0 / sr)
        c = np.cumsum(psd) / (psd.sum() + 1e-20)
        i = int(np.searchsorted(c, frac))
        return round(float(f[min(i, f.size - 1)]) / 1000.0, 2)
    except Exception:  # noqa: BLE001
        return 0.0


def audio_bandwidth_audit(clips: list[Path], sample: int = 24) -> dict[str, Any]:
    """语料「体检」：采样率 + 高频带宽。只读，够用来判断会不会出电流音。

    返回 {"clips":N,"minSr":..,"lowSr":..,"rolloffKhz":..,"note":""}；
    note 非空就是需要告诉用户的话（不改训练流程，绝不拦训练）。
    """
    out: dict[str, Any] = {"clips": len(clips), "minSr": 0, "lowSr": 0, "rolloffKhz": 0.0, "note": ""}
    if not clips:
        return out
    srs = [_wav_sr(c) for c in clips[:40]]
    srs = [s for s in srs if s]
    ro = [
        _rolloff_khz(c)
        for c in (clips if len(clips) <= sample else clips[:: max(1, len(clips) // sample)])
    ]
    ro = [r for r in ro if r > 0]
    if srs:
        out["minSr"] = min(srs)
        out["lowSr"] = sum(1 for s in srs if s < TARGET_SR)
    if ro:
        ro.sort()
        out["rolloffKhz"] = ro[len(ro) // 2]
    if out["rolloffKhz"] and out["rolloffKhz"] < HIGHBAND_CUTOFF_KHZ:
        out["note"] = (
            f"语料高频内容不足（99% 能量截止约 {out['rolloffKhz']} kHz，采样率最低 {out['minSr'] or '?'} Hz）："
            "这类素材多半是被压过/降采样过的（例如 16 kHz 的转录音频、短视频提取音轨）。"
            "8 kHz 以上是空的，模型却要输出 32 kHz，那一段只能凭空生成 —— 训练完的"
            "电流音 / 毛刺 / 发沙基本都来自这里，且加练轮数只会更明显。"
            "换 32 kHz 以上的原始音频重训才是根治办法（重训前先删掉本项目的已整理数据，"
            "或在训练方式里选「重新训练」并取消「复用已整理音频」）。"
        )
    elif out["lowSr"]:
        out["note"] = (
            f"有 {out['lowSr']} 段音频的采样率低于 {TARGET_SR} Hz（最低 {out['minSr']} Hz）："
            "高频内容缺失会让合成更容易带毛刺，建议换更高采样率的原始素材。"
        )
    return out


def _log_bandwidth(clips: list[Path], log_path: Path, m: dict[str, Any] | None = None,
                   s2_total: int = 0) -> dict[str, Any]:
    """跑一次语料体检：写进训练日志 + manifest，面板与后续状态查询直接读。
    s2_total 传了就顺带算「轮数相对语料量是否偏多」的提示（只提示，不拦训练）。"""
    try:
        a = audio_bandwidth_audit(clips)
    except Exception as e:  # noqa: BLE001
        log(f"warn: 语料带宽体检失败：{e}")
        return {}
    try:
        a["clipsSec"] = _clips_seconds_estimated(clips)
        a["noteOverfit"] = _buzz_risk(a["clipsSec"], s2_total)
    except Exception:  # noqa: BLE001
        pass
    _append_log(
        log_path,
        f"语料体检：{a['clips']} 段 / 约 {round(float(a.get('clipsSec') or 0) / 60.0, 1)} 分钟，"
        f"采样率最低 {a['minSr'] or '?'} Hz，99% 能量截止约 {a['rolloffKhz']} kHz"
        + (f"（其中 {a['lowSr']} 段低于 {TARGET_SR} Hz）" if a["lowSr"] else ""),
    )
    if a.get("note"):
        _append_log(log_path, "⚠ " + a["note"])
    if a.get("noteOverfit"):
        _append_log(log_path, "⚠ " + a["noteOverfit"])
    if m is not None:
        m["audioQuality"] = a
    return a



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
            # 与 TARGET_SR 一致：以前这里固定 16k，等于把转换好的高频又丢一遍
            y, sr = librosa.load(str(raw), sr=TARGET_SR, mono=True)
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


def _repair_dataset(ds_dir: Path, log_path: Path | None = None, drop_models: bool = True) -> bool:
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
            # 语义文件来自 5-wav32k/4-cnhubert，毒数据下必须整表重算。
            for fn in ("6-name2semantic.tsv", "6-name2semantic-0.tsv", "2-name2text.txt", "2-name2text-0.txt"):
                try:
                    (ds_dir / fn).unlink(missing_ok=True)
                except Exception:  # noqa: BLE001
                    pass
            if drop_models:
                # 重新训练：logs_s2_v1 里的模型是在毒数据上训出来的，清掉强制从预训练重训。
                # 继续迭代（drop_models=False）时绝不动断点，否则用户选的「继续迭代」
                # 会被静默变成从头重训——只把坏特征重算即可。
                for sub in ("logs_s1", "logs_s2_v1", "logs_s2_v2"):
                    p = ds_dir / sub
                    if p.is_dir():
                        shutil.rmtree(p, ignore_errors=True)
                        _append_log(log_path, f"repair: removed {sub} (retrain from pretrained)")
            else:
                _append_log(log_path, "repair: 检测到毒数据，已清理对应特征并重算（保留现有模型断点）")
    except Exception as e:  # noqa: BLE001
        _append_log(log_path, f"repair: dataset self-heal failed: {e}")
    return repaired


def _build_s1_config(
    slug: str,
    exp: str,
    speaker: str,
    ds_dir: Path,
    epochs: int = S1_FRESH_EPOCHS,
    pretrained: Path | str | None = None,
) -> Path:
    rel = f"data/{exp}/{speaker}"
    tpl = _load_config_template("configs/s1longer.yaml")
    if tpl:
        import yaml

        cfg = yaml.safe_load(tpl) or {}
    else:
        cfg = {}
    train = cfg.setdefault("train", {})
    train.setdefault("seed", 1234)
    # 预训练底模微调：小数据集 30 epochs 收敛更稳（验证 29 epoch loss→13、acc→100%）。
    # 注意：这里是**总轮数**。继续迭代时上层会传「已完成 + 追加」，s1_train.py 会用
    # logs_s1/ckpt 的最新断点恢复 current_epoch，然后一路训到这个总数。
    train["epochs"] = max(1, int(epochs or S1_FRESH_EPOCHS))
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
    # 继续迭代时上层传 pretrained=<已导出的 eNN.ckpt>，同一套 load_state_dict 通路，
    # 只是底模换成自己上一轮的模型（logs_s1/ckpt 有 Lightning 断点时上层会保留断点，
    # 那种情况下 fit(ckpt_path=...) 会整体覆盖这里加载的权重，二者不冲突）。
    p1 = Path(pretrained) if pretrained else _find_s1_pretrained()
    if p1 and Path(p1).is_file():
        cfg["pretrained_s1"] = str(p1)
    elif p1:
        log(f"warn: pretrained s1 missing: {p1}")
        cfg.pop("pretrained_s1", None)
    else:
        cfg.pop("pretrained_s1", None)
    cfg["output_dir"] = f"{rel}/logs_s1"
    cfg["train_semantic_path"] = f"{rel}/6-name2semantic.tsv"
    cfg["train_phoneme_path"] = f"{rel}/2-name2text.txt"
    import yaml

    text = yaml.safe_dump(cfg, allow_unicode=True, sort_keys=False)
    cfgp = _cfg_dir() / slug / "s1.yaml"
    cfgp.parent.mkdir(parents=True, exist_ok=True)
    cfgp.write_text(text, encoding="utf-8")
    return cfgp


def _build_s2_config(
    slug: str,
    exp: str,
    speaker: str,
    ds_dir: Path,
    for_semantic: bool = False,
    epochs: int = S2_FRESH_EPOCHS,
    pretrained_g: Path | str | None = None,
) -> Path:
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
    # 总轮数（s2_train.py: epoch_str = 断点 iteration + 1; range(epoch_str, epochs+1)）
    train["epochs"] = max(1, int(epochs or S2_FRESH_EPOCHS))
    _official_g = ENGINE_DIR / "GPT_SoVITS" / "pretrained_models" / "s2G488k.pth"
    _pg = Path(pretrained_g) if pretrained_g else _official_g
    train["pretrained_s2G"] = str(_pg if _pg.is_file() else _official_g)
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
        # 用官方底模的体积算版本（继续迭代时 pretrained_s2G 会指向自己导出的权重，
        # 体积规则对它同样成立，但官方底模永远在，取它更稳）。
        _sz = 0
        try:
            _sz = Path(_official_g).stat().st_size
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
