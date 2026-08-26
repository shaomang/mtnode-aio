"""GPU probing shared by TTS plugin backend (nvidia-smi)."""
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
            stderr=subprocess.DEVNULL,
            text=True,
            errors="ignore",
            timeout=8,
        )
    except Exception:
        return None
    line = out.strip().splitlines()
    if not line:
        return None
    parts = [p.strip() for p in line[0].split(",")]
    if len(parts) < 4:
        return None
    try:
        mem_used = float(parts[1])
        mem_total = float(parts[2])
        util = float(parts[3])
    except ValueError:
        return None
    return {
        "name": parts[0],
        "memUsedMb": int(mem_used),
        "memTotalMb": int(mem_total),
        "util": int(util),
        "memPct": round(mem_used / mem_total * 100, 1) if mem_total > 0 else 0.0,
    }
