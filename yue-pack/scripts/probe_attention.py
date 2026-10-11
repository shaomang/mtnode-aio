"""Probe: is one attention backend really usable on this machine?

Background: yue2's ``cuda_graph.py`` decides flash availability with
``hasattr(torch.ops.aten, "_flash_attention_forward")`` plus the schema, but the local
``torch 2.10.0+cu130`` (Windows) has **the schema present and the CUDA kernel not compiled in**,
so attention_backend is mis-detected as "flash" and the real generation reports
``USE_FLASH_ATTENTION was not enabled for build.``

This port no longer picks a tier by probing all three: the tier is ``cudnn`` by default
(``app/windows_patch.py`` -> ``resolve_backend()``; override = ``YUE2_ATTENTION_BACKEND`` or a
single-line ``.attention-backend`` text file). This script exists for two jobs only:

* the host's startup quick check -- ``--only <tier>`` runs **one** tiny real forward pass and
  exits 0/3, so an unusable tier is reported *before* the model loads instead of half way
  through a generation (and nothing is auto-downgraded: the user changes the tier explicitly);
* manual diagnosis -- ``--all`` runs every tier once and prints PASS/FAIL for each.

The probe implementation lives in **exactly one place**: ``app/windows_patch.py``; this script is
only its command-line front end, so the host, the install script and manual debugging all see one
identical contract.

Usage::

    <INSTALL_DIR>\\.venv\\Scripts\\python.exe scripts\\probe_attention.py --only cudnn --json
    <INSTALL_DIR>\\.venv\\Scripts\\python.exe scripts\\probe_attention.py --all

Exit codes: 0 = the checked tier passed / 3 = it failed (or nothing could be imported) /
2 = no torch or no CUDA, so there is nothing to check (CPU runs sdpa).
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
    ap = argparse.ArgumentParser(description="check whether an attention tier is really usable (default tier: cudnn)")
    ap.add_argument("--json", action="store_true", help="print a single JSON document only (host contract)")
    ap.add_argument("--only", choices=list(wp.BACKENDS), default="", help="check just this tier (host startup quick check)")
    ap.add_argument("--all", action="store_true", help="check every tier once (manual diagnosis)")
    args = ap.parse_args(argv)

    info = _torch_info()
    backend, source = wp.resolve_backend()
    checked = args.only or backend
    cache = wp.cache_file()

    if not info["ok"]:
        payload = {
            "ok": True,
            "skipped": True,
            "checked": checked,
            "backend": backend,
            "source": source,
            "override": source != "default",
            "all": bool(args.all),
            "cuda": False,
            "torch": info["torch"],
            "device": "",
            "probes": {},
            "cacheFile": cache,
            "reason": info["error"] or "CUDA unavailable",
        }
        _emit(payload, args.json, skipped=payload["reason"])
        return 2

    probes = wp.probe_backends(only="" if args.all else checked)
    picked = probes.get(checked) or {"ok": False, "label": checked, "detail": "unknown tier"}
    ok = bool(picked["ok"])
    payload = {
        "ok": ok,
        "skipped": False,
        "checked": checked,
        "backend": backend,
        "source": source,
        "override": source != "default",
        "all": bool(args.all),
        "cuda": True,
        "torch": info["torch"],
        "cudaVersion": info["cuda"],
        "device": info["device"],
        "probes": probes,
        "cacheFile": cache,
        "reason": "" if ok else str(picked["detail"]),
    }

    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2), flush=True)
    else:
        print(f"[probe] torch={info['torch']}+cu{info['cuda']} device={info['device']}", flush=True)
        for name, p in probes.items():
            print(f"[probe] {'PASS' if p['ok'] else 'FAIL'} {p['label']} - {p['detail']}", flush=True)
        print(f"[probe] effective tier = {backend} (source={source}); checked = {checked}", flush=True)
        print(f"[probe] {'usable' if ok else 'NOT usable'}: {picked['detail']}", flush=True)
        print(
            f"[probe] override: YUE2_ATTENTION_BACKEND={ '|'.join(wp.BACKENDS) } (or a single-line"
            f" .attention-backend text file); record: {cache}",
            flush=True,
        )
    return 0 if ok else 3


def _emit(payload: dict, as_json: bool, skipped: str) -> None:
    if as_json:
        print(json.dumps(payload, ensure_ascii=False, indent=2), flush=True)
    else:
        print(f"[probe] skipped ({skipped}): no CUDA means no probe is needed, yue2 uses sdpa", flush=True)


if __name__ == "__main__":
    sys.exit(main())
