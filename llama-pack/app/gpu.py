"""GPU / VRAM utilities via nvidia-smi."""
from __future__ import annotations

import subprocess
from typing import Any


def query_gpu() -> dict[str, Any] | None:
    try:
        out = subprocess.check_output(
            [
                "nvidia-smi",
                "--query-gpu=name,memory.used,memory.total,utilization.gpu",
                "--format=csv,noheader,nounits",
            ],
            text=True,
            timeout=5,
        )
        line = out.strip().splitlines()[0] if out.strip() else ""
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 4:
            return None
        used = float(parts[1])
        total = float(parts[2])
        util = float(parts[3])
        return {
            "name": parts[0],
            "memUsedMb": used,
            "memTotalMb": total,
            "utilPct": util,
            "memFreeMb": max(0.0, total - used),
            "memPct": round(used / total * 1000) / 10 if total else 0,
        }
    except Exception:
        return None


def estimate_vram_gb(model_id: str, size_bytes: int = 0, quant: str = "") -> float:
    q = (quant or "").upper()
    if size_bytes > 0:
        return max(1.0, round(size_bytes / (1024**3) * 1.1, 1))
    mid = model_id.lower()
    if "q2" in q:
        mult = 0.35
    elif "q3" in q:
        mult = 0.45
    elif "q4" in q:
        mult = 0.55
    elif "q5" in q:
        mult = 0.65
    elif "q6" in q or "q8" in q:
        mult = 0.85
    elif "fp16" in q:
        mult = 1.0
    else:
        mult = 0.55
    if "e4b" in mid or "4b" in mid:
        base = 4.0
    elif "e2b" in mid or "2b" in mid:
        base = 2.5
    elif "12b" in mid:
        base = 8.0
    elif "26b" in mid or "31b" in mid:
        base = 16.0
    elif "7b" in mid or "8b" in mid:
        base = 6.0
    else:
        base = 5.0
    return round(base * mult, 1)
