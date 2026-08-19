"""MiniMax H3 scaffold helpers (smoke / health)."""

from __future__ import annotations

__all__ = ["ROOT", "comfy_root"]

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def comfy_root() -> Path:
    return ROOT / "ComfyUI"
