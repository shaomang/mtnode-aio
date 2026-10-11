"""控制台启动横幅：端口、目录、跑法（每次起后端都打一遍）。"""
from __future__ import annotations

from . import config


def print_banner(port: int) -> None:
    line = "=" * 68
    print(line, flush=True)
    print("  Breeze TTS 2 本地 TTS —— MTNode 插件后端", flush=True)
    print(line, flush=True)
    print(f"  管理服务   : http://127.0.0.1:{port}   （API Key 见 /api/status）", flush=True)
    print(f"  安装目录   : {config.ROOT}", flush=True)
    print(f"  推理引擎   : {config.ENGINE_DIR}", flush=True)
    print(f"  权重目录   : {config.weights_dir()}", flush=True)
    print(f"  音色库     : {config.VOICES_DIR}", flush=True)
    print(f"  ffmpeg     : {config.ffmpeg_exe() or '（未找到：mp3 输出会提示缺少 ffmpeg，wav/flac 不受影响）'}", flush=True)
    print(line, flush=True)
    print("  引擎会按需拉起：官方 breeze_infer.api，eager 约 7.7GB 显存（24G 卡够用）。", flush=True)
    print(line, flush=True)
