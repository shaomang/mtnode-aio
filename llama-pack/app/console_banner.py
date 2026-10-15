"""启动提示（横幅）——**不新建窗口**。

历史坑（本机 2026-10 实测）：这里原先调 `kernel32.AllocConsole()`，为了让后端「有一只自己的
控制台窗」把横幅打给人看 —— 但插件卡片点「启用」时后端是宿主用 `pythonw.exe` 静默拉起的
（`backend-python.js` 的 `quietPython`），进程里本来没有控制台、stdout 又是 `stdio:"ignore"`，
于是这一句 `AllocConsole()` 就**凭空给用户弹一只新的终端窗口**（标题 "MTNode llama.cpp Plugin
Service"，里面写着「请勿关闭此窗口」）。它是 llama.cpp 后端唯一一处自己开窗的地方，`pythonw`
与 `CREATE_NO_WINDOW` 都拦不住它 —— 只有「别调它」能拦。

现在的口径（唯一一份）：
  · stdout 真的通（用户自己在终端里跑 `start_backend.cmd` / `python -m app`）→ 照旧往那只终端打
    横幅，**不新开窗**；
  · stdout 不通（插件宿主静默拉起的常态：pythonw + `stdio:"ignore"` ⇒ `sys.stdout is None`）
    → 一个字都不打，横幅写进管理服务日志 `.console.log`（插件控制台 / ⓘ 信息浮层读的就是它，
    见 console_log.py）。

口径为什么写成「写一次 stdout 试试」而不是「问内核有没有控制台」：本机实测（PowerShell +
Store 版 Python）`kernel32.GetConsoleWindow()` 在**有**终端的会话里也返回 0 —— 拿它当判据会
把手动起后端的人一起静默掉。反过来，pythonw + `stdio:"ignore"` 时 `sys.stdout` 就是 `None`
（实测），写一次即知，没有猜测空间。

插件那侧还有一道「静默」口径（`shims/sitecustomize.py` 给子进程补 `CREATE_NO_WINDOW`），
那是拦**子进程**新建窗口的；本模块是「自己不主动开窗」那一半。
"""
from __future__ import annotations

import sys

from app.console_log import log_line

BANNER = r"""
  ============================================================
     __  __ _       _    _    ____ ____   ____  ____  
    |  \/  | |     / \  | |  / ___|  _ \ / ___||  _ \ 
    | |\/| | |    / _ \ | | | |   | |_) | |    | |_) |
    | |  | | |___/ ___ \| |__| |___|  __/| |___|  __/ 
    |_|  |_|_____/_/   \_\_____\____|_|    \____|_|    

         l l a m a . c p p   S e r v i c e
  ============================================================
"""

# 只对「手动起后端」的那种人（终端里跑 start_backend.cmd）说：服务在后台，启停走插件卡片。
# 静默拉起时不打这行 —— 那时候没有终端，写了只会误导。
FOOTER_EN = [
    "  This service runs in the background; MTNode starts and stops it from the plugin card.",
]
FOOTER_ZH = [
    "  本服务在后台运行，启停请用 MTNode 顶栏「插件」里的 llama.cpp 卡片。",
]


def _has_usable_stdout() -> bool:
    """stdout 现在真的能写字吗（**只探测，不新建任何东西**）。

    pythonw + `stdio:"ignore"`（插件静默拉起的常态）下 `sys.stdout` 就是 None → False；
    用户自己在终端里跑的时候是一个真流 → True。判断失败一律 False：拿不准就静默，
    宁可少打一行字，也不给用户弹一只窗口。
    """
    out = getattr(sys, "stdout", None)
    if out is None:
        return False
    try:
        out.write("")
        out.flush()
        return True
    except Exception:
        return False


def _banner_text(port: int) -> str:
    lines = [
        BANNER.rstrip(),
        "",
        f"  API   http://127.0.0.1:{port}/v1",
        "",
        *FOOTER_EN,
        "",
        *FOOTER_ZH,
        "",
        "  ----------------------------------------------------------",
        "  Service log",
        "  ----------------------------------------------------------",
        "",
    ]
    return "\n".join(lines) + "\n"


def show_service_banner(port: int) -> None:
    """stdout 通就打给它（手动起后端的人看得见），不通就只写日志 —— 两条路都不新建窗口。"""
    text = _banner_text(port)
    if _has_usable_stdout():
        sys.stdout.write(text)
        sys.stdout.flush()
    log_line(text.rstrip("\n"))
