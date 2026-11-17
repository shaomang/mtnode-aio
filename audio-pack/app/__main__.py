"""进程入口：`python -m app --port 8774 --ffmpeg "C:\\...\\ffmpeg.exe"`。

宿主这样起（cwd = `<数据目录>\\pipeline-console\\audio-analysis`，这一层里有
`app/ cache/ artifacts/ api-key.txt`）：

    <venv>\\Scripts\\pythonw.exe -m app --port 8774 --ffmpeg "C:\\...\\ffmpeg.exe"

参数只有三个：`--port` / `--ffmpeg` / `--no-auth`（**不接受 `--host`**：绑回环是硬约束）。
就绪行由 `serve.main()` 在端口**真正绑定成功之后**打印 —— 端口可能被顺延到 8774-8783，
先打印再绑会骗到宿主：

    [audio] ready port=8774 pid=23144

退出前打印 `[audio] bye`。日志前缀一律 `[audio] `，UTF-8，逐行 flush。

全部注释与消息为中文。
"""

from __future__ import annotations

import argparse
import os
import sys


def _force_utf8_stdout() -> None:
    """pythonw 下 stdout 可能是 None；能配就配成 UTF-8（宿主按 UTF-8 读 console.log）。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except Exception:
            pass


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m app",
        description="MTNode 音频分析后端（只绑 127.0.0.1 的本地 HTTP 服务）",
    )
    parser.add_argument(
        "--port", type=int, default=None,
        help="监听端口；不给则取环境变量 MT_AUDIO_PORT，再不给用 8774（被占用时在 8774-8783 顺延）",
    )
    parser.add_argument(
        "--ffmpeg", default=None,
        help="ffmpeg 可执行文件绝对路径（不给则查 PATH；找不到也不阻止服务启动）",
    )
    parser.add_argument(
        "--no-auth", action="store_true",
        help="关闭 API Key 鉴权（仅本机调试用；/health 的 auth 会回 \"off\"）",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    _force_utf8_stdout()
    if args.port is not None and not (0 <= int(args.port) <= 65535):
        sys.stderr.write("端口不合法：%r（范围 0-65535）\n" % (args.port,))
        return 2
    from . import serve   # 延迟导入：--help 不必加载 numpy
    try:
        return serve.main(port=args.port, ffmpeg=args.ffmpeg, no_auth=bool(args.no_auth),
                          root=os.environ.get("MT_AUDIO_ROOT") or os.getcwd())
    except OSError as exc:
        serve.log("error 启动失败：%s" % exc)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
