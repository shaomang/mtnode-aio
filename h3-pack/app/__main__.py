"""python -m app → print install health."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from app import ROOT, comfy_root


MODELS = {
    "fl2va": "models/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors",
    "ref2va": "models/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors",
    "clip": "models/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
    "vae_video": "models/vae/minimax_h3_video_vae_fp16.safetensors",
    "vae_audio": "models/vae/minimax_h3_audio_vae_fp32.safetensors",
}


def main() -> int:
    cr = comfy_root()
    venv_py = cr / "venv" / "Scripts" / "python.exe"
    report = {
        "root": str(ROOT),
        "comfy": str(cr),
        "comfy_main": (cr / "main.py").is_file(),
        "venv": venv_py.is_file(),
        "models": {},
        "cuda": None,
    }
    for k, rel in MODELS.items():
        p = cr / Path(rel)
        report["models"][k] = p.is_file() and p.stat().st_size > 1_000_000

    if venv_py.is_file():
        import subprocess

        try:
            out = subprocess.check_output(
                [str(venv_py), "-c", "import torch; print('1' if torch.cuda.is_available() else '0')"],
                text=True,
                timeout=60,
            ).strip()
            report["cuda"] = out == "1"
        except Exception as exc:  # noqa: BLE001
            report["cuda"] = False
            report["cuda_error"] = str(exc)

    print(json.dumps(report, ensure_ascii=False, indent=2))
    ok = report["comfy_main"] and report["venv"] and report["models"].get("fl2va") and report["models"].get("clip")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
