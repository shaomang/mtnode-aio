"""Breeze TTS 2 本地管理服务入口：`python -m app [端口]`。

端口优先级：命令行参数 > 环境变量 BREEZE_API_PORT > 安装目录 manager.json 的 apiPort > 8772。
只监听 127.0.0.1（本机回环），不对外暴露。
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from . import config  # noqa: E402
from .console_banner import print_banner  # noqa: E402
from .server import app  # noqa: E402


def resolve_port(argv: list[str]) -> int:
    import os

    for a in argv[1:]:
        try:
            p = int(str(a).strip())
            if 1024 <= p <= 65535:
                return p
        except Exception:
            continue
    env = os.environ.get("BREEZE_API_PORT")
    if env:
        try:
            p = int(env)
            if 1024 <= p <= 65535:
                return p
        except Exception:
            pass
    cfg = config.load_config()
    try:
        p = int(cfg.get("apiPort") or config.DEFAULT_API_PORT)
    except Exception:
        p = config.DEFAULT_API_PORT
    return p if 1024 <= p <= 65535 else config.DEFAULT_API_PORT


def main() -> int:
    import uvicorn

    config.ensure_dirs()
    port = resolve_port(sys.argv)
    config.save_config({"apiPort": port})
    print_banner(port)
    config.log(f"[manager] listen 127.0.0.1:{port}")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
    return 0


if __name__ == "__main__":
    sys.exit(main())
