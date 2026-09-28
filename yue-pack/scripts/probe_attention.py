"""探针：本机 torch 到底支持哪些注意力后端（Windows 移植口径必须实测，不能靠 hasattr 猜）。

背景：yue2 的 ``cuda_graph.py`` 用
``hasattr(torch.ops.aten, "_flash_attention_forward")`` + schema 判断 flash 可用，
本机 torch 2.10.0+cu130（Windows）**schema 在、CUDA kernel 没编进来**，
于是 attention_backend 被误判成 "flash"，真实生成时报
``USE_FLASH_ATTENTION was not enabled for build.``

本脚本对 flash / cudnn / sdpa 三条路径各跑一次极小的真实前向，打印各档 PASS/FAIL 与推荐档，
并把同一份结果写进 ``<INSTALL_DIR>\\.attention-backend``（`app/windows_patch.py` 落盘）。
探针实现**只有一处**：``app/windows_patch.py``；本脚本只是它的命令行门面，
因此安装脚本（``scripts\\install.ps1``）、宿主与人工排查看到的口径完全一致。

用法::

    <INSTALL_DIR>\\.venv\\Scripts\\python.exe scripts\\probe_attention.py
    <INSTALL_DIR>\\.venv\\Scripts\\python.exe scripts\\probe_attention.py --json

退出码：0 = 有可用档（并给出推荐）· 2 = 无 CUDA / 无 torch（跳过）· 3 = 三档全失败。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# app 包就在 <INSTALL_DIR>\app：从本脚本位置反推安装根，保证任何 cwd 都能导入
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

try:
    from app import windows_patch as wp
except Exception as exc:  # noqa: BLE001 - 包不在 / 包坏了都要给一行人话
    print(f"[probe] 无法导入 app.windows_patch（{ROOT}）：{exc}", flush=True)
    sys.exit(3)

_ORDER = ("flash", "cudnn", "sdpa")


def _torch_info() -> dict:
    info: dict = {"ok": False, "torch": "", "cuda": "", "device": "", "error": ""}
    try:
        import torch
    except Exception as exc:  # noqa: BLE001
        info["error"] = f"torch 不可导入：{str(exc)[:160]}"
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
        info["error"] = "CUDA 不可用"
    return info


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="实测本机可用的注意力后端（flash / cudnn / sdpa）")
    ap.add_argument("--json", action="store_true", help="只输出一份 JSON（供安装脚本 / 宿主解析）")
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
            "reason": info["error"] or "CUDA 不可用",
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
        "reason": "" if recommended else "flash / cudnn / sdpa 实测全部失败",
    }

    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2), flush=True)
    else:
        print(f"[probe] torch={info['torch']}+cu{info['cuda']} device={info['device']}", flush=True)
        for name in _ORDER:
            p = probes[name]
            print(f"[probe] {'PASS' if p['ok'] else 'FAIL'} {p['label']} — {p['detail']}", flush=True)
        if recommended:
            print(f"[probe] 结论：推荐档位 = {recommended}（GraphAR attention_backend）", flush=True)
        else:
            print("[probe] 结论：没有可用档位（生成会以短码 attention_backend_unsupported 失败）", flush=True)
        print(
            f"[probe] 覆盖：YUE2_ATTENTION_BACKEND=auto|flash|cudnn|sdpa（当前 {forced}，"
            f"auto = 上面这套探针）；探针记录：{cache}",
            flush=True,
        )
    return 0 if recommended else 3


def _emit(payload: dict, as_json: bool, skip_note: str) -> None:
    if as_json:
        print(json.dumps(payload, ensure_ascii=False, indent=2), flush=True)
    else:
        print(f"[probe] 跳过（{skip_note}）：没有 CUDA 时无需探针，yue2 用 sdpa", flush=True)


if __name__ == "__main__":
    sys.exit(main())
