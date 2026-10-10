"""Breeze TTS 2 weight download: ModelScope first -> hf-mirror fallback -> official HF as a last resort.

Usage:
    python scripts/download_weights.py --repo BreezeBlue/breeze-tts-2 --dest <install dir>/checkpoints/breeze-tts-2

Progress contract: prints "progress: NN.N" (the installer script turns it into a progress bar).
License note: the Breeze TTS 2 weights are bound by the BreezeBlue Research and Non-Commercial License
         and are for research and **non-commercial** use only; the inference code itself is Apache-2.0.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

os.environ.setdefault("HF_HUB_DISABLE_XET", "1")


def log(msg: str) -> None:
    print(f"[breeze-weights] {msg}", flush=True)


def log_progress(pct: float) -> None:
    print(f"progress: {pct:.1f}", flush=True)


def _report_downloaded(dest: Path) -> bool:
    """Rough check that the weights are complete: config.json plus at least one weight file."""
    if not dest.is_dir():
        return False
    has_cfg = any(dest.glob("config.json"))
    patterns = ("*.safetensors", "*.pt", "*.bin")
    has_w = any(any(dest.rglob(p)) for p in patterns)
    return has_cfg and has_w


def try_modelscope(repo: str, dest: Path) -> bool:
    try:
        from modelscope.hub.snapshot_download import snapshot_download  # type: ignore
    except Exception as exc:  # noqa: BLE001
        log(f"ModelScope SDK unavailable ({exc})")
        return False
    try:
        log(f"ModelScope downloading {repo} -> {dest}")
        snapshot_download(repo, local_dir=str(dest), repo_type="model")
        log_progress(100)
        return _report_downloaded(dest)
    except Exception as exc:  # noqa: BLE001
        log(f"ModelScope failed: {exc}")
        return False


def try_hf(repo: str, dest: Path, endpoint: str, revision: str | None) -> bool:
    try:
        from huggingface_hub import snapshot_download  # type: ignore
    except Exception as exc:  # noqa: BLE001
        log(f"huggingface_hub unavailable ({exc})")
        return False
    try:
        log(f"{endpoint} downloading {repo} -> {dest}")
        kwargs: dict = {
            "repo_id": repo,
            "local_dir": str(dest),
            "endpoint": endpoint,
        }
        if revision:
            kwargs["revision"] = revision
        snapshot_download(**kwargs)
        log_progress(100)
        return _report_downloaded(dest)
    except Exception as exc:  # noqa: BLE001
        log(f"{endpoint} failed: {exc}")
        return False


def main() -> int:
    ap = argparse.ArgumentParser(description="download the Breeze TTS 2 weights")
    ap.add_argument("--repo", default="BreezeBlue/breeze-tts-2")
    ap.add_argument("--dest", required=True)
    ap.add_argument("--revision", default=os.environ.get("BREEZE_WEIGHTS_REVISION") or None)
    args = ap.parse_args()

    dest = Path(args.dest).expanduser().resolve()
    dest.mkdir(parents=True, exist_ok=True)

    if _report_downloaded(dest):
        log(f"weights are already in {dest}, skipping")
        log_progress(100)
        return 0

    log("weight license: BreezeBlue Research and Non-Commercial License (research / non-commercial only)")

    # 1) ModelScope first (direct connection inside China)
    if try_modelscope(args.repo, dest):
        log(f"done (ModelScope): {dest}")
        return 0

    # 2) hf-mirror fallback
    if try_hf(args.repo, dest, "https://hf-mirror.com", args.revision):
        log(f"done (hf-mirror): {dest}")
        return 0

    # 3) official HF as a last resort (only reachable behind a proxy)
    if try_hf(args.repo, dest, "https://huggingface.co", args.revision):
        log(f"done (huggingface.co): {dest}")
        return 0

    log("all three channels failed. Download the weights into that directory by hand, or set BREEZE_WEIGHTS_DIR to an existing weights directory and rerun the installer.")
    log(f"target directory: {dest}")
    return 2


if __name__ == "__main__":
    sys.exit(main())
