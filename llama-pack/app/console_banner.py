"""Windows service console banner for the llama.cpp plugin backend."""
from __future__ import annotations

import sys

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

HINT_EN = [
    "  Keep this window OPEN.",
    "  Closing it will STOP the local model service.",
    "  Stop from the MTNode plugin or the system tray instead.",
]
HINT_ZH = [
    "  请勿关闭此窗口。",
    "  关闭后本地模型服务将停止。",
    "  请从 MTNode 插件或系统托盘停止服务。",
]


def _bind_windows_console() -> None:
    if sys.platform != "win32":
        return
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32
        kernel32.AllocConsole()
        kernel32.SetConsoleTitleW("MTNode llama.cpp Plugin Service")
        kernel32.SetConsoleOutputCP(65001)
        kernel32.SetConsoleCP(65001)
        handle = kernel32.GetStdHandle(-10)
        mode = ctypes.c_uint()
        if kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
            mode.value = (mode.value | 0x0080) & ~0x0040
            kernel32.SetConsoleMode(handle, mode)
        sys.stdout = open("CONOUT$", "w", encoding="utf-8", errors="replace")
        sys.stderr = open("CONOUT$", "w", encoding="utf-8", errors="replace")
    except Exception:
        pass


def show_service_banner(port: int) -> None:
    _bind_windows_console()
    lines = [
        BANNER.rstrip(),
        "",
        f"  API   http://127.0.0.1:{port}/v1",
        "",
        *HINT_EN,
        "",
        *HINT_ZH,
        "",
        "  ----------------------------------------------------------",
        "  Service log",
        "  ----------------------------------------------------------",
        "",
    ]
    text = "\n".join(lines) + "\n"
    try:
        sys.stdout.write(text)
        sys.stdout.flush()
    except Exception:
        pass
    if sys.platform == "win32":
        try:
            with open("CONOUT$", "w", encoding="utf-8", errors="replace") as con:
                con.write(text)
                con.flush()
        except Exception:
            pass
