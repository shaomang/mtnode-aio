"""MTNode · 插件后端子进程静默（唯一真源）

本文件是**唯一真源**，随包分发时逐字节复制到各 Python pack 的 `shims/sitecustomize.py`
（tts-pack / h3-pack / music3-pack / yue-pack / breeze-pack / llama-pack / sensenova-pack），
一致性由 `test/smoke-console-silent.js` 钉住；口径与 `pack-steps/step.ps1` 的「真源 + 各包副本」同例。

为什么需要它（根因，详见 docs/plugin-console-silence.md）
------------------------------------------------------------------
本地后端一律由宿主用 **pythonw.exe** 拉起（GUI 子系统 ⇒ 进程**完全没有控制台**，见 backend-python.js
的 quietPython 口径）。Windows 的规则是：一个「控制台子系统」的子进程如果没有控制台可继承，
Windows 就给它**新建一个可见的终端窗口**。于是引擎里任何没带 CREATE_NO_WINDOW 的外部调用都会弹窗：

  · GPT-SoVITS `tools/my_utils.py::load_audio()` 走 ffmpeg-python（`ffmpeg/_run.py` 里是裸 Popen），
    被 s1/s2 数据集逐音频条目调用 ⇒ 训练时每个音频文件一个终端窗（DataLoader 并发 5~12 个 worker）；
  · `tools/uvr5/*.py` 的 `os.system("ffmpeg ...")`；
  · ComfyUI 自定义节点装依赖、引擎里的 `git rev-parse`、pip ……

实测（本机 E:\\mtnode-plugins\\tts 真实引擎，2026-10 复核）：pythonw 下连调 12 次 `load_audio()`
→ 出现 22 个可见控制台窗口对象（CASCADIA_HOSTING_WINDOW_CLASS + PseudoConsoleWindow，≈ 每次 ffmpeg 一个）；
同一批调用带 CREATE_NO_WINDOW → 零新增窗口。

做法
------------------------------------------------------------------
本模块由 CPython 启动时自动导入：只要本文件所在目录在 **PYTHONPATH** 上，`site` 就会 import
`sitecustomize`。于是「新进程默认隐藏控制台」这条口径落在**进程级**，覆盖所有第三方库
（它们不会自己传 creationflags），而且子进程继承 PYTHONPATH ⇒ multiprocessing / DataLoader 的
worker 里同样自动生效。

  · `subprocess.Popen.__init__`：调用方没给 creationflags / startupinfo 时补 CREATE_NO_WINDOW
    （`subprocess.run / call / check_output / check_call` 都经由 Popen，一并覆盖）
  · `os.system` / `os.popen`：改走带同一标志的 subprocess（`os.system` 由 CRT 起 cmd.exe，
    同样是「无控制台可继承 → 新建窗口」）

不做的事
------------------------------------------------------------------
· 不改第三方引擎源码（引擎重装 / 升级都不会把这条口径弄丢）；
· 不动显式传了 creationflags 或 startupinfo 的调用（谁想要窗口谁自己传，我们只补默认值）；
· 不碰 `_winapi.CreateProcess` 直连（multiprocessing spawn 走那条路，它拉起来的是 GUI 子系统的
  pythonw，本来就不会有窗口）；
· 非 win32 平台整个模块空转。
"""

import os
import sys

# Win32 CreateProcess 标志：控制台子系统进程「跑起来但不要窗口」
_CREATE_NO_WINDOW = 0x08000000


def _patch_subprocess():
    """给 subprocess.Popen 补默认的 CREATE_NO_WINDOW。"""
    import subprocess

    popen = subprocess.Popen
    if getattr(popen, "_mtnode_silent", False):
        return
    orig_init = popen.__init__

    def _mtnode_init(self, *args, **kwargs):
        # creationflags 是 __init__ 的第 14 个形参（self 之后第 13 个位置参数）：调用方真按位置传了
        # 就别猜，原样放行；显式给了 startupinfo 的也放行（那是调用方在精细控制窗口行为）。
        if len(args) < 14 and kwargs.get("startupinfo") is None and not kwargs.get("creationflags"):
            kwargs["creationflags"] = _CREATE_NO_WINDOW
        orig_init(self, *args, **kwargs)

    _mtnode_init.__doc__ = orig_init.__doc__
    popen.__init__ = _mtnode_init
    popen._mtnode_silent = True


def _patch_os_shell():
    """os.system / os.popen 也走一遍 subprocess（否则它们经 CRT 起 cmd.exe，照样新建窗口）。"""
    import subprocess

    if not getattr(os.system, "_mtnode_silent", False):

        def _mtnode_system(command):
            return subprocess.call(command, shell=True)

        _mtnode_system._mtnode_silent = True
        _mtnode_system.__doc__ = os.system.__doc__
        os.system = _mtnode_system

    if not getattr(os.popen, "_mtnode_silent", False):

        def _mtnode_popen(cmd, mode="r", buffering=-1):
            if mode not in ("r", "w", "rw", "wr", "rb", "wb", "rwb", "wrb"):
                raise ValueError("invalid mode %r" % mode)
            reading = "r" in mode
            writing = "w" in mode
            binary = "b" in mode
            proc = subprocess.Popen(
                cmd,
                shell=True,
                bufsize=buffering,
                stdin=subprocess.PIPE if writing else None,
                stdout=subprocess.PIPE if reading else None,
                universal_newlines=not binary,
            )
            return proc.stdout if reading else proc.stdin

        _mtnode_popen._mtnode_silent = True
        _mtnode_popen.__doc__ = os.popen.__doc__
        os.popen = _mtnode_popen


if sys.platform == "win32":
    try:
        _patch_subprocess()
        _patch_os_shell()
    except Exception:  # noqa: BLE001 —— 钩子坏了也不许把插件拖崩：静默失败，退回原行为
        pass
