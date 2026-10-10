"""Probe: which attention backends this machine's torch really supports (the Windows port must measure, not guess via hasattr).

Background: yue2's ``cuda_graph.py`` decides flash availability with
``hasattr(torch.ops.aten, "_flash_attention_forward")`` plus the schema, but the local
``torch 2.10.0+cu130`` (Windows) has **the schema present and the CUDA kernel not compiled in**,
so attention_backend is mis-detected as "flash" and the real generation reports
``USE_FLASH_ATTENTION was not enabled for build.``

This script runs one tiny real forward pass per path (flash / cudnn / sdpa), prints PASS/FAIL for
each tier plus the recommendation, and writes the same result to ``<INSTALL_DIR>\\.attention-backend``
(written by ``app/windows_patch.py``). The probe implementation lives in **exactly one place**:
``app/windows_patch.py``; this script is only its command-line front end, so the install script (``scripts\install.ps1``), the host and manual debugging all see one identical contract.

Usage::

    <INSTALL_DIR>\\.venv\\Scripts\\python.exe scripts\\probe_attention.py
    <INSTALL_DIR>\\.venv\\Scripts\\python.exe scripts\\probe_attention.py --json

Exit codes: 0 = a usable tier exists (with a recommendation) / 2 = no CUDA / no torch (skipped) / 3 = all three tiers failed.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# the app package sits in <INSTALL_DIR>\app: derive the install root from this script's path so any cwd can import it
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

try:
    from app import windows_patch as wp
except Exception as exc:  # noqa: BLE001 - a missing / broken package must still print one human-readable line
    print(f"[probe] cannot import app.windows_patch ({ROOT}): {exc}", flush=True)
    sys.exit(3)

_ORDER = ("flash", "cudnn", "sdpa")


def _torch_info() -> dict:
    info: dict = {"ok": False, "torch": "", "cuda": "", "device": "", "error": ""}
    try:
        import torch
    except Exception as exc:  # noqa: BLE001
        info["error"] = f"torch is not importable: {str(exc)[:160]}"
        return info
    info["torch"] = str(torch.__version__)
    info["cuda"] = str(getattr(torch.version, "cuda", "") or "")
    info["ok"] = bool(torch.cuda.is_available())
    if info["ok"]:
        try:
            info["device"] = str(torch.cuda.get_device_name(0))
        except Exception:  # noqa: BLE001
            info["device"] = "cuda"
    else:
        info["error"] = "CUDA unavailable"
    return info


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="measure which attention backends are usable on this machine (flash / cudnn / sdpa)")
    ap.add_argument("--json", action="store_true", help="print a single JSON document only (for the install script / host to parse)")
    args = ap.parse_args(argv)

    forced = wp.forced_backend()
    info = _torch_info()
    cache = wp.cache_file()

    if not info["ok"]:
        payload = {
            "ok": False,
            "cuda": False,
            "forced": forced,
            "backend": "",
            "probes": {},
            "cacheFile": cache,
            "torch": info["torch"],
            "device": "",
            "reason": info["error"] or "CUDA unavailable",
        }
        _emit(payload, args.json, skip_note=payload["reason"])
        return 2

    probes = wp.probe_backends()
    recommended = next((n for n in _ORDER if probes[n]["ok"]), "")
    payload = {
        "ok": bool(recommended),
        "cuda": True,
        "forced": forced,
        "backend": recommended or (forced if forced != "auto" else ""),
        "recommended": recommended,
        "probes": probes,
        "cacheFile": cache,
        "torch": info["torch"],
        "cudaVersion": info["cuda"],
        "device": info["device"],
        "reason": "" if recommended else "flash / cudnn / sdpa all failed in the real probes",
    }

    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2), flush=True)
    else:
        print(f"[probe] torch={info['torch']}+cu{info['cuda']} device={info['device']}", flush=True)
        for name in _ORDER:
            p = probes[name]
            print(f"[probe] {'PASS' if p['ok'] else 'FAIL'} {p['label']} - {p['detail']}", flush=True)
        if recommended:
            print(f"[probe] conclusion: recommended tier = {recommended} (GraphAR attention_backend)", flush=True)
        else:
            print("[probe] conclusion: no usable tier (generation fails with the short code attention_backend_unsupported)", flush=True)
        print(
            f"[probe] override: YUE2_ATTENTION_BACKEND=auto|flash|cudnn|sdpa (currently {forced},"
            f"auto = the probe set above); probe record: {cache}",
            flush=True,
        )
    return 0 if recommended else 3


def _emit(payload: dict, as_json: bool, skip_note: str) -> None:
    if as_json:
        print(json.dumps(payload, ensure_ascii=False, indent=2), flush=True)
    else:
        print(f"[probe] skipped ({skip_note}): no CUDA means no probe is needed, yue2 uses sdpa", flush=True)


if __name__ == "__main__":
    sys.exit(main())
