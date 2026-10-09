"""Breeze TTS 2 权重下载：ModelScope（魔搭）优先 → hf-mirror 回退 → HF 官方兜底。

用法：
    python scripts/download_weights.py --repo BreezeBlue/breeze-tts-2 --dest <安装目录>/checkpoints/breeze-tts-2

进度口径：打印 "progress: NN.N"（安装脚本按它换算进度条）。
许可提示：Breeze TTS 2 权重受 BreezeBlue Research and Non-Commercial License 约束，
         仅限研究与**非商用**用途；推理代码本身是 Apache-2.0。
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
    """粗判权重是否齐：config.json + 至少一个权重文件。"""
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
        log(f"ModelScope SDK 不可用（{exc}）")
        return False
    try:
        log(f"ModelScope 下载 {repo} → {dest}")
        snapshot_download(repo, local_dir=str(dest), repo_type="model")
        log_progress(100)
        return _report_downloaded(dest)
    except Exception as exc:  # noqa: BLE001
        log(f"ModelScope 失败：{exc}")
        return False


def try_hf(repo: str, dest: Path, endpoint: str, revision: str | None) -> bool:
    try:
        from huggingface_hub import snapshot_download  # type: ignore
    except Exception as exc:  # noqa: BLE001
        log(f"huggingface_hub 不可用（{exc}）")
        return False
    try:
        log(f"{endpoint} 下载 {repo} → {dest}")
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
        log(f"{endpoint} 失败：{exc}")
        return False


def main() -> int:
    ap = argparse.ArgumentParser(description="下载 Breeze TTS 2 权重")
    ap.add_argument("--repo", default="BreezeBlue/breeze-tts-2")
    ap.add_argument("--dest", required=True)
    ap.add_argument("--revision", default=os.environ.get("BREEZE_WEIGHTS_REVISION") or None)
    args = ap.parse_args()

    dest = Path(args.dest).expanduser().resolve()
    dest.mkdir(parents=True, exist_ok=True)

    if _report_downloaded(dest):
        log(f"权重已在 {dest}，跳过")
        log_progress(100)
        return 0

    log("权重许可：BreezeBlue Research and Non-Commercial License（仅限研究 / 非商用）")

    # 1) ModelScope 优先（国内直连）
    if try_modelscope(args.repo, dest):
        log(f"完成（ModelScope）：{dest}")
        return 0

    # 2) hf-mirror 回退
    if try_hf(args.repo, dest, "https://hf-mirror.com", args.revision):
        log(f"完成（hf-mirror）：{dest}")
        return 0

    # 3) HF 官方兜底（有代理时才可能通）
    if try_hf(args.repo, dest, "https://huggingface.co", args.revision):
        log(f"完成（huggingface.co）：{dest}")
        return 0

    log("三条通道都失败。请手工下载权重到该目录，或设置 BREEZE_WEIGHTS_DIR 指向已有权重目录后重跑安装。")
    log(f"目标目录：{dest}")
    return 2


if __name__ == "__main__":
    sys.exit(main())
