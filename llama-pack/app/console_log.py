"""管理服务的日志落点（唯一真源）。

为什么单独一个模块：`.console.log` 原先在 server.py 与 console_banner.py 里各写一份路径，
**横幅那次改动**（不再 AllocConsole，见 console_banner.py 头部）又需要「往日志里写一行」这个动作，
两处再各写一份就迟早会分叉（改一处忘一处 → 横幅写进了别的文件，用户按插件提示去翻日志却看不到）。
本模块只做两件事：给路径、追加一行（零依赖，任何模块都能 import）。
"""
from __future__ import annotations

import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOG_PATH = ROOT / ".console.log"


def log_line(msg: str) -> str:
    """把一行带时间戳的日志追加进 .console.log，返回真正写下的那一行（失败时返回原样，绝不抛）。"""
    line = f"[{time.strftime('%H:%M:%S')}] {msg}\n"
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception:
        pass
    return line
