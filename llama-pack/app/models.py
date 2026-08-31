"""GGUF model registry, download, deploy via llama-server."""
from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path
from typing import Any, Callable

from huggingface_hub import hf_hub_download, list_repo_files

from app.gpu import estimate_vram_gb, query_gpu

ROOT = Path(__file__).resolve().parent.parent
MODELS_DIR = ROOT / "models"
REGISTRY_PATH = ROOT / ".registry.json"
DEPLOYED_PATH = ROOT / ".deployed.json"
WANT_DEPLOYED_PATH = ROOT / ".want-deployed.json"
BIN_DIR = ROOT / "bin"
MANIFEST_PATH = ROOT / "manifest.json"
TEMPLATES_DIR = ROOT / "templates"
LLAMA_PORT_BASE = 8100

# HF model id -> GGUF source (Unsloth preferred; see avenchat Gemma 4 + llama.cpp guide)
GGUF_SOURCES: dict[str, dict[str, Any]] = {
    "google/gemma-4-E4B-it": {
        "repo": "unsloth/gemma-4-E4B-it-GGUF",
        "file": "gemma-4-E4B-it-Q8_0.gguf",
        "chat_template_repo": "google/gemma-4-E4B-it",
        "quant": "Q8_0",
        "fallbacks": [
            {
                "repo": "unsloth/gemma-4-E4B-it-GGUF",
                "file": "gemma-4-E4B-it-Q4_K_M.gguf",
                "quant": "Q4_K_M",
            },
            {
                "repo": "daniloreddy/gemma-4-E4B-it_GGUF",
                "file": "gemma-4-E4B-it_Q4_K_M.gguf",
                "quant": "Q4_K_M",
            },
            {
                "repo": "mradermacher/gemma-4-E4B-it-GGUF",
                "file": "gemma-4-E4B-it.Q4_K_M.gguf",
                "quant": "Q4_K_M",
            },
        ],
    },
    "google/gemma-4-E2B-it": {
        "repo": "unsloth/gemma-4-E2B-it-GGUF",
        "file": "gemma-4-E2B-it-Q8_0.gguf",
        "chat_template_repo": "google/gemma-4-E2B-it",
        "quant": "Q8_0",
        "fallbacks": [
            {
                "repo": "unsloth/gemma-4-E2B-it-GGUF",
                "file": "gemma-4-E2B-it-Q4_K_M.gguf",
                "quant": "Q4_K_M",
            },
            {
                "repo": "daniloreddy/gemma-4-E2B-it_GGUF",
                "file": "gemma-4-E2B-it_Q4_K_M.gguf",
                "quant": "Q4_K_M",
            },
        ],
    },
}

_log_fn: Callable[[str], None] | None = None
_json_lock = threading.Lock()
_deploy_lock = threading.Lock()
_restore_lock = threading.Lock()

# In-flight model download progress (model_id -> snapshot), served to the UI via /api/downloads.
_downloads: dict[str, dict[str, Any]] = {}
_downloads_lock = threading.Lock()


def _set_download(
    model_id: str,
    phase: str,
    message: str,
    pct: float | None = None,
    received: int = 0,
    total: int = 0,
) -> None:
    with _downloads_lock:
        _downloads[model_id] = {
            "modelId": model_id,
            "phase": phase,
            "message": message,
            "pct": None if pct is None else round(float(pct), 1),
            "received": int(received or 0),
            "total": int(total or 0),
            "updatedAt": time.time(),
        }


def _clear_download(model_id: str) -> None:
    with _downloads_lock:
        _downloads.pop(model_id, None)


def list_downloads() -> list[dict[str, Any]]:
    with _downloads_lock:
        return [dict(v) for v in _downloads.values()]


def _fmt_bytes(n: int) -> str:
    try:
        n = int(n or 0)
        if n <= 0:
            return "0 B"
        if n >= 1024**3:
            return f"{n / 1024**3:.2f} GB"
        if n >= 1024**2:
            return f"{n / 1024**2:.1f} MB"
        return f"{n} B"
    except Exception:
        return ""


def _remote_file_size(repo: str, fname: str) -> int:
    """Total size in bytes of a remote HF file (0 when unknown)."""
    try:
        from huggingface_hub import get_hf_file_metadata, hf_hub_url

        meta = get_hf_file_metadata(hf_hub_url(repo_id=repo, filename=fname))
        return int(getattr(meta, "size", 0) or 0)
    except Exception:
        return 0


# Quantization preference when a GGUF repo offers several files (lower = better).
_QUANT_PREFERENCE = [
    "q4_k_m",
    "q5_k_m",
    "q8_0",
    "q6_k",
    "q4_0",
    "q3_k_m",
    "q2_k",
    "f16",
    "bf16",
]


def _quant_of(fname: str) -> str:
    """Extract the quant label from a GGUF filename, e.g. 'Qwen-27B-Q4_K_M.gguf' -> 'Q4_K_M'."""
    m = re.search(r"(?:[-_.])(q\d(?:_[a-z0-9]+)*|f16|bf16|fp16)(?:\.|$)", fname, re.IGNORECASE)
    if m:
        return m.group(1).upper()
    return ""


def _quant_rank(fname: str) -> int:
    lower = (fname or "").lower()
    for i, q in enumerate(_QUANT_PREFERENCE):
        if q in lower:
            return i
    return len(_QUANT_PREFERENCE)


def _pick_gguf_file(repo: str) -> dict[str, str]:
    """Pick the best single-file GGUF of a HF repo via list_repo_files.

    Split shards (*-00001-of-00002.gguf) are rejected because downloading a
    single shard yields an unusable model; a repo with only shards is skipped.
    """
    try:
        files = list_repo_files(repo_id=repo)
    except Exception as e:
        log(f"list_repo_files failed {repo}: {str(e)[:160]}")
        return {}
    candidates: list[str] = []
    for f in files or []:
        name = str(f)
        low = name.lower()
        if not low.endswith(".gguf"):
            continue
        if "-of-" in low or "split" in low:
            continue
        candidates.append(name)
    if not candidates:
        return {}
    candidates.sort(key=_quant_rank)
    best = candidates[0]
    return {"repo": repo, "file": best, "quant": _quant_of(best)}


def _find_partial_size(dest_dir: Path, fname: str) -> int:
    """Largest on-disk byte count of the target file (or its .incomplete temp)."""
    if not fname:
        return 0
    best = 0
    try:
        for p in dest_dir.rglob("*"):
            if not p.is_file():
                continue
            if p.name == fname or p.name.endswith(".incomplete"):
                try:
                    best = max(best, p.stat().st_size)
                except OSError:
                    pass
    except Exception:
        pass
    return best


def _spawn_download_watcher(model_id: str, dest_dir: Path, state: dict[str, Any]) -> threading.Event:
    """Poll the partial file size every second and publish progress to _downloads."""
    stop = threading.Event()

    def watch() -> None:
        while not stop.is_set():
            fname = str(state.get("fname") or "")
            total = int(state.get("total") or 0)
            received = _find_partial_size(dest_dir, fname)
            pct = (received / total * 100.0) if total > 0 else None
            if total > 0:
                message = f"下载中 {_fmt_bytes(received)} / {_fmt_bytes(total)}"
            else:
                message = "下载中（未知大小）…"
            _set_download(model_id, "download", message, pct, received, total)
            stop.wait(1.0)

    t = threading.Thread(target=watch, daemon=True, name="dl-watch")
    t.start()
    return stop


def set_logger(fn: Callable[[str], None]) -> None:
    global _log_fn
    _log_fn = fn


def log(msg: str) -> None:
    line = f"[models] {msg}"
    if _log_fn:
        _log_fn(line)
    else:
        print(line, flush=True)


def _read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(data, indent=2, ensure_ascii=False)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{int(time.time() * 1000)}.tmp")
    tmp.write_text(payload, encoding="utf-8")
    os.replace(str(tmp), str(path))


def load_registry() -> list[dict[str, Any]]:
    data = _read_json(REGISTRY_PATH, {"models": []})
    return list(data.get("models") or [])


def save_registry(models: list[dict[str, Any]]) -> None:
    with _json_lock:
        _write_json(REGISTRY_PATH, {"models": models, "updatedAt": time.time()})


def load_deployed() -> dict[str, Any]:
    with _json_lock:
        return _read_json(DEPLOYED_PATH, {"instances": []})


def save_deployed(data: dict[str, Any]) -> None:
    with _json_lock:
        _write_json(DEPLOYED_PATH, data)


def load_want_deployed() -> list[str]:
    with _json_lock:
        data = _read_json(WANT_DEPLOYED_PATH, {"modelIds": []})
    out: list[str] = []
    seen: set[str] = set()
    for x in data.get("modelIds") or []:
        s = str(x or "").strip()
        if s and s not in seen:
            out.append(s)
            seen.add(s)
    return out


def save_want_deployed(ids: list[str]) -> None:
    unique: list[str] = []
    seen: set[str] = set()
    for x in ids:
        s = str(x or "").strip()
        if s and s not in seen:
            unique.append(s)
            seen.add(s)
    with _json_lock:
        _write_json(WANT_DEPLOYED_PATH, {"modelIds": unique})


def remember_want_deployed(model_id: str) -> None:
    mid = str(model_id or "").strip()
    if not mid:
        return
    ids = load_want_deployed()
    if mid not in ids:
        ids.append(mid)
        save_want_deployed(ids)


def forget_want_deployed(model_id: str) -> None:
    mid = str(model_id or "").strip()
    save_want_deployed([x for x in load_want_deployed() if x != mid])


def snapshot_want_deployed() -> list[str]:
    ids = load_want_deployed()
    for inst in load_deployed().get("instances", []):
        if inst.get("status") not in ("running", "starting"):
            continue
        mid = str(inst.get("modelId") or "").strip()
        if mid and mid not in ids:
            ids.append(mid)
    save_want_deployed(ids)
    return ids


def model_dir(model_id: str) -> Path:
    safe = model_id.replace("/", "__")
    return MODELS_DIR / safe


def _bundled_gemma4_template() -> Path:
    return TEMPLATES_DIR / "gemma-4-it.jinja"


def _is_gemma4_model(model_id: str) -> bool:
    mid = str(model_id or "").lower()
    return "gemma" in mid and ("gemma-4" in mid or "gemma4" in mid)


def _ensure_chat_template(model_id: str, entry: dict[str, Any] | None = None) -> Path | None:
    """Ensure Gemma 4 has the official Jinja chat template on disk."""
    if not _is_gemma4_model(model_id):
        return None
    mdir = model_dir(model_id)
    mdir.mkdir(parents=True, exist_ok=True)
    target = mdir / "chat_template.jinja"
    if target.is_file() and target.stat().st_size > 500:
        return target
    src = GGUF_SOURCES.get(model_id) or entry or {}
    repo = str(src.get("chat_template_repo") or model_id).strip()
    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
    os.environ["HF_HUB_DISABLE_XET"] = "1"
    try:
        hf_hub_download(
            repo_id=repo,
            filename="chat_template.jinja",
            local_dir=str(mdir),
        )
        if target.is_file():
            log(f"chat template ready {model_id} <- {repo}")
            return target
    except Exception as e:
        log(f"chat template download failed {model_id}: {str(e)[:160]}")
    bundled = _bundled_gemma4_template()
    if bundled.is_file():
        import shutil

        shutil.copy2(bundled, target)
        log(f"chat template copied from bundle -> {target}")
        return target
    return None


def _chat_template_args(model_id: str, entry: dict[str, Any]) -> list[str]:
    tpl_path = _ensure_chat_template(model_id, entry)
    if tpl_path and tpl_path.is_file():
        return ["--jinja", "--chat-template-file", str(tpl_path)]
    chat_tpl = str(entry.get("chatTemplate") or "").strip()
    if chat_tpl:
        return ["--chat-template", chat_tpl]
    return []


def _inference_server_args(model_id: str) -> list[str]:
    """Gemma 4 defaults per Google / avenchat llama.cpp guide."""
    if not _is_gemma4_model(model_id):
        return []
    return [
        "--temp",
        "1.0",
        "--top-p",
        "0.95",
        "--top-k",
        "64",
        "--reasoning",
        "off",
    ]


def gguf_path_for(entry: dict[str, Any]) -> Path:
    fname = entry.get("ggufFile") or entry.get("fileName") or ""
    return model_dir(entry["id"]) / fname


def llama_server_bin() -> Path:
    for name in ("llama-server.exe", "llama-server"):
        p = BIN_DIR / name
        if p.is_file():
            return p
    raise FileNotFoundError("llama-server not found; run install first")


def local_model_info(entry: dict[str, Any]) -> dict[str, Any]:
    mid = entry["id"]
    mdir = model_dir(mid)
    gpath = gguf_path_for(entry)
    size = gpath.stat().st_size if gpath.is_file() else 0
    deployed = next(
        (i for i in load_deployed().get("instances", []) if i.get("modelId") == mid),
        None,
    )
    quant = entry.get("quant") or entry.get("ggufQuant") or ""
    vram = entry.get("vramGb") or estimate_vram_gb(mid, size, quant)
    return {
        **entry,
        "path": str(gpath),
        "sizeBytes": size,
        "sizeGb": round(size / (1024**3), 2) if size else 0,
        "vramGb": vram,
        "deployed": bool(deployed),
        "port": deployed.get("port") if deployed else None,
        "status": deployed.get("status") if deployed else "idle",
        "servedName": deployed.get("servedName") if deployed else None,
        "error": deployed.get("error") if deployed else None,
    }


def list_local_models() -> list[dict[str, Any]]:
    return [local_model_info(e) for e in load_registry()]


def _upsert_registry(model_id: str, **fields: Any) -> dict[str, Any]:
    models = load_registry()
    idx = next((i for i, m in enumerate(models) if m["id"] == model_id), -1)
    base = {"id": model_id, "downloadedAt": time.time(), "kind": "llm"}
    if idx >= 0:
        base.update(models[idx])
    base.update(fields)
    if idx >= 0:
        models[idx] = base
    else:
        models.append(base)
    save_registry(models)
    return base


def download_model(
    model_id: str,
    kind: str = "llm",
    pipeline_tag: str = "",
    gguf_repo: str = "",
    gguf_file: str = "",
    quant: str = "",
) -> dict[str, Any]:
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    with _downloads_lock:
        if model_id in _downloads:
            return {"ok": False, "error": "already_downloading", "modelId": model_id}
    src = GGUF_SOURCES.get(model_id)
    dest_dir = model_dir(model_id)
    dest_dir.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
    os.environ["HF_HUB_DISABLE_XET"] = "1"
    candidates: list[dict[str, str]] = []
    if src:
        # Whitelisted models keep their primary + fallback chain.
        if src.get("repo") and src.get("file"):
            candidates.append(
                {
                    "repo": src["repo"],
                    "file": src["file"],
                    "quant": str(src.get("quant") or ""),
                }
            )
        for fb in src.get("fallbacks") or []:
            if fb.get("repo") and fb.get("file"):
                candidates.append(
                    {
                        "repo": fb["repo"],
                        "file": fb["file"],
                        "quant": str(fb.get("quant") or src.get("quant") or ""),
                    }
                )
    elif gguf_repo:
        # Explicit GGUF repo passed from the catalog (e.g. bartowski/Qwen2.5-7B-Instruct-GGUF).
        if gguf_file:
            candidates.append(
                {
                    "repo": gguf_repo,
                    "file": gguf_file,
                    "quant": quant or _quant_of(gguf_file),
                }
            )
        else:
            picked = _pick_gguf_file(gguf_repo)
            if picked:
                candidates.append(picked)
    else:
        # Generic: treat the model id itself as a GGUF repo (catalog search result,
        # e.g. unsloth/Qwen3.8-27B-GGUF) and pick the best single-file quant.
        picked = _pick_gguf_file(model_id)
        if picked:
            candidates.append(picked)
    if not candidates:
        return {"ok": False, "error": "no_gguf_source", "modelId": model_id}
    last_err = ""
    path = ""
    matched: dict[str, str] = {}
    watcher_state: dict[str, Any] = {"fname": "", "total": 0}
    watcher_stop: threading.Event | None = None
    _set_download(model_id, "start", "准备下载…", 0)
    try:
        for cand in candidates:
            repo = cand["repo"]
            fname = cand["file"]
            total = _remote_file_size(repo, fname)
            watcher_state["fname"] = fname
            watcher_state["total"] = total
            if watcher_stop is None:
                watcher_stop = _spawn_download_watcher(model_id, dest_dir, watcher_state)
            _set_download(
                model_id,
                "download",
                f"下载 {repo}/{fname}" + (f"（{_fmt_bytes(total)}）" if total > 0 else ""),
                0,
                0,
                total,
            )
            log(f"downloading {repo}/{fname} -> {dest_dir}")
            try:
                path = hf_hub_download(
                    repo_id=repo,
                    filename=fname,
                    local_dir=str(dest_dir),
                )
                matched = cand
                break
            except Exception as e:
                last_err = str(e)
                log(f"download failed {repo}/{fname}: {last_err[:200]}")
    finally:
        if watcher_stop is not None:
            watcher_stop.set()
    if not path:
        _clear_download(model_id)
        return {"ok": False, "error": last_err or "download_failed", "modelId": model_id}
    repo = matched["repo"]
    fname = matched["file"]
    quant = matched.get("quant") or (src or {}).get("quant") or ""
    _set_download(model_id, "template", "整理对话模板…", 100)
    tpl_path = _ensure_chat_template(model_id, src)
    entry = _upsert_registry(
        model_id,
        kind=kind,
        pipelineTag=pipeline_tag,
        ggufRepo=repo,
        ggufFile=fname,
        chatTemplate="",
        chatTemplateFile=str(tpl_path) if tpl_path else "",
        quant=quant,
        status="downloaded",
    )
    log(f"download complete {model_id} -> {path}")
    _clear_download(model_id)
    return local_model_info(entry)


def import_local_gguf(model_id: str, gguf_file: Path) -> dict[str, Any]:
    dest_dir = model_dir(model_id)
    dest_dir.mkdir(parents=True, exist_ok=True)
    target = dest_dir / gguf_file.name
    if gguf_file.resolve() != target.resolve():
        import shutil

        shutil.copy2(gguf_file, target)
    entry = _upsert_registry(
        model_id,
        ggufFile=gguf_file.name,
        chatTemplate="gemma" if "gemma" in model_id.lower() else "chatml",
        quant="local",
        status="downloaded",
    )
    return local_model_info(entry)


def scan_existing_models() -> None:
    """Register GGUF files already on disk (e.g. migrated install dir)."""
    if not MODELS_DIR.is_dir():
        return
    for sub in MODELS_DIR.iterdir():
        if not sub.is_dir():
            continue
        ggufs = list(sub.glob("*.gguf"))
        if not ggufs:
            continue
        mid = sub.name.replace("__", "/")
        if any(m["id"] == mid for m in load_registry()):
            _ensure_chat_template(mid)
            continue
        g = max(ggufs, key=lambda p: p.stat().st_size)
        import_local_gguf(mid, g)
        _ensure_chat_template(mid)
        log(f"imported existing {mid} <- {g.name}")


def _allocated_vram_gb() -> float:
    total = 0.0
    for inst in load_deployed().get("instances", []):
        if inst.get("status") == "running":
            total += float(inst.get("vramGb") or 0)
    return total


def _next_port() -> int:
    used = {int(i.get("port") or 0) for i in load_deployed().get("instances", [])}
    port = LLAMA_PORT_BASE
    while port in used:
        port += 1
    return port


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


def _http_ready(port: int, timeout: float = 2.0) -> bool:
    if not port:
        return False
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{int(port)}/health")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return 200 <= int(resp.status) < 300
    except Exception:
        try:
            req = urllib.request.Request(f"http://127.0.0.1:{int(port)}/v1/models")
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return 200 <= int(resp.status) < 300
        except Exception:
            return False


def _instance_healthy(inst: dict[str, Any]) -> bool:
    port = int(inst.get("port") or 0)
    pid = int(inst.get("pid") or 0)
    if port and _http_ready(port):
        return True
    if pid and _is_alive(pid):
        return True
    return False


def _warmup_engine(port: int, served_name: str, timeout: float = 600.0) -> bool:
    """Run a tiny completion so weights are loaded before marking running."""
    payload = json.dumps(
        {
            "model": served_name,
            "messages": [{"role": "user", "content": "1+1"}],
            "max_tokens": 16,
            "temperature": 0,
        }
    ).encode("utf-8")
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not _http_ready(port, timeout=3.0):
            time.sleep(2)
            continue
        try:
            req = urllib.request.Request(
                f"http://127.0.0.1:{int(port)}/v1/chat/completions",
                data=payload,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=120) as resp:
                if 200 <= int(resp.status) < 300:
                    return True
        except Exception:
            time.sleep(3)
    return False


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
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass


def can_deploy(vram_gb: float) -> tuple[bool, str, dict[str, Any] | None]:
    gpu = query_gpu()
    if not gpu:
        return False, "no_gpu", gpu
    allocated = _allocated_vram_gb()
    free = (gpu["memFreeMb"] / 1024.0) - allocated
    if vram_gb > free + 0.3:
        return False, f"insufficient_vram: need {vram_gb:.1f}GB, free ~{free:.1f}GB", gpu
    return True, "ok", gpu


def _tail_log_error(log_file: Path, max_lines: int = 12) -> str:
    try:
        if not log_file.exists():
            return ""
        lines = log_file.read_text(encoding="utf-8", errors="ignore").splitlines()
        tail = [ln.strip() for ln in lines[-max_lines:] if ln.strip()]
        for ln in reversed(tail):
            if "error" in ln.lower() or "Error" in ln:
                return ln[:240]
        return tail[-1][:240] if tail else ""
    except Exception:
        return ""


def _reuse_instance(model_id: str) -> dict[str, Any] | None:
    for inst in load_deployed().get("instances", []):
        if inst.get("modelId") != model_id:
            continue
        if inst.get("status") not in ("running", "starting"):
            continue
        if not _instance_healthy(inst):
            continue
        if inst.get("status") != "running":
            inst["status"] = "running"
            inst.pop("error", None)
            d = load_deployed()
            for i, x in enumerate(d.get("instances", [])):
                if x.get("modelId") == model_id:
                    d["instances"][i] = inst
            save_deployed(d)
        remember_want_deployed(model_id)
        return {"ok": True, "reused": True, **inst}
    return None


def deploy_model(model_id: str, api_key: str = "") -> dict[str, Any]:
    entry = next((m for m in load_registry() if m["id"] == model_id), None)
    if not entry:
        return {"ok": False, "error": "not_found"}
    info = local_model_info(entry)
    gpath = Path(info["path"])
    if not gpath.is_file():
        return {"ok": False, "error": "not_downloaded"}
    reused = _reuse_instance(model_id)
    if reused:
        return reused
    ok, reason, gpu = can_deploy(float(info["vramGb"]))
    if not ok:
        return {"ok": False, "error": reason, "gpu": gpu}
    port = _next_port()
    served_name = model_id.split("/")[-1].replace(".", "-")
    try:
        server = llama_server_bin()
    except FileNotFoundError as e:
        return {"ok": False, "error": str(e)}
    args = [
        str(server),
        "-m",
        str(gpath),
        "--host",
        "127.0.0.1",
        "--port",
        str(port),
        "-ngl",
        "99",
    ]
    args.extend(_chat_template_args(model_id, entry))
    args.extend(_inference_server_args(model_id))
    log(f"deploy {model_id} port={port} vram~{info['vramGb']}GB")
    log_dir = ROOT / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / f"llama-{port}.log"
    flags = 0
    if sys.platform == "win32":
        flags = subprocess.CREATE_NEW_PROCESS_GROUP | getattr(
            subprocess, "CREATE_NO_WINDOW", 0x08000000
        )
    with _deploy_lock:
        reused = _reuse_instance(model_id)
        if reused:
            return reused
        log_fp = open(log_file, "ab")
        proc = subprocess.Popen(
            args,
            cwd=str(ROOT),
            stdout=log_fp,
            stderr=subprocess.STDOUT,
            creationflags=flags,
        )
        inst = {
            "modelId": model_id,
            "servedName": served_name,
            "port": port,
            "pid": proc.pid,
            "vramGb": info["vramGb"],
            "status": "starting",
            "startedAt": time.time(),
            "kind": entry.get("kind") or "llm",
        }
        deployed = load_deployed()
        instances = [i for i in deployed.get("instances", []) if i.get("modelId") != model_id]
        instances.append(inst)
        save_deployed({"instances": instances})
        remember_want_deployed(model_id)

    def _wait_ready() -> None:
        deadline = time.time() + 600
        http_ok = False
        while time.time() < deadline:
            if not _is_alive(proc.pid):
                inst["status"] = "failed"
                inst["error"] = _tail_log_error(log_file) or "process_exited"
                break
            if _http_ready(port):
                http_ok = True
                break
            time.sleep(2)
        else:
            if not http_ok and inst.get("status") == "starting":
                inst["status"] = "failed"
                inst["error"] = "engine_start_timeout"
        if inst.get("status") != "failed" and http_ok:
            log(f"deploy {model_id} warming up on port {port}…")
            if _warmup_engine(port, served_name):
                inst["status"] = "running"
                inst.pop("error", None)
            else:
                inst["status"] = "failed"
                inst["error"] = "engine_warmup_timeout"
        d = load_deployed()
        for i, x in enumerate(d.get("instances", [])):
            if x.get("modelId") == model_id:
                d["instances"][i] = inst
        save_deployed(d)
        if inst.get("status") != "running":
            log(f"deploy {model_id} failed; see {log_file}")
        log(f"deploy {model_id} -> {inst['status']}")

    threading.Thread(target=_wait_ready, daemon=True).start()
    return {"ok": True, **inst}


def stop_model(model_id: str, forget: bool = True) -> dict[str, Any]:
    deployed = load_deployed()
    found = None
    for inst in deployed.get("instances", []):
        if inst.get("modelId") == model_id:
            found = inst
            _kill_pid(int(inst.get("pid") or 0))
    instances = [i for i in deployed.get("instances", []) if i.get("modelId") != model_id]
    save_deployed({"instances": instances})
    if forget:
        forget_want_deployed(model_id)
    if found:
        log(f"stopped {model_id}")
    return {"ok": True, "stopped": bool(found)}


def stop_all(clear_want: bool = False) -> None:
    if clear_want:
        save_want_deployed([])
    else:
        snapshot_want_deployed()
    for inst in list(load_deployed().get("instances", [])):
        mid = inst.get("modelId") or inst.get("model_id") or ""
        stop_model(mid, forget=False)


def restore_wanted_deploys(api_key: str = "") -> dict[str, Any]:
    with _restore_lock:
        ids = snapshot_want_deployed()
        started: list[str] = []
        errors: list[dict[str, str]] = []
        for mid in ids:
            reused = _reuse_instance(mid)
            if reused:
                started.append(mid)
                continue
            result = deploy_model(mid, api_key)
            if result.get("ok"):
                started.append(mid)
            else:
                errors.append({"id": mid, "error": str(result.get("error") or "deploy_failed")})
                log(f"restore skip {mid}: {result.get('error')}")
        return {"ok": True, "modelIds": started, "errors": errors}


def refresh_deployed_status() -> list[dict[str, Any]]:
    deployed = load_deployed()
    changed = False
    for inst in deployed.get("instances", []):
        if inst.get("status") not in ("running", "starting"):
            continue
        if _instance_healthy(inst):
            if inst.get("status") != "running":
                inst["status"] = "running"
                inst.pop("error", None)
                changed = True
            continue
        inst["status"] = "dead"
        inst["error"] = "process_exited"
        changed = True
    if changed:
        save_deployed(deployed)
    return deployed.get("instances", [])


def deployed_model_names() -> list[str]:
    refresh_deployed_status()
    return [
        str(i.get("servedName"))
        for i in load_deployed().get("instances", [])
        if i.get("status") == "running" and i.get("servedName")
    ]


def delete_model(model_id: str) -> dict[str, Any]:
    stop_model(model_id)
    import shutil

    mdir = model_dir(model_id)
    if mdir.exists():
        shutil.rmtree(mdir, ignore_errors=True)
    models = [m for m in load_registry() if m["id"] != model_id]
    save_registry(models)
    log(f"deleted {model_id}")
    return {"ok": True, "id": model_id}
