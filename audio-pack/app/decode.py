"""解码层：ffprobe 元信息 + ffmpeg 管道解码 + 上限判定 + 额外 LUFS。

契约口径（service-contract §八）：

* 解码命令固定 `-hide_banner -nostdin -v error -vn -ac 1 -ar <sr> -f f32le pipe:1`，
  `-vn` 保证视频文件只取音轨。
* 时长先由 ffprobe 取（`-show_format -show_streams`），>7200 s 或源文件 >2 GiB → E_TOO_LONG，
  **不截断**（截断会让 beatsSec 与真实素材错位，比明确失败更危险）。
* 无音轨 → E_NO_AUDIO_STREAM；ffmpeg 非 0 → E_DECODE_FAILED（detail 带 stderr 尾 800 字）。

全部注释与消息为中文。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading

import numpy as np

from . import contract
from .contract import AnalyzeError

#: 每次从管道读多少字节（1 MiB）；2 小时素材约 317 MB，绝不一次 read() 到底
_READ_CHUNK = 1 << 20
#: stderr 只留尾部这么多字符
_STDERR_KEEP = 800

#: 宿主用 pythonw.exe（GUI 子系统、没有控制台）拉起本服务：
#: 子进程必须 CREATE_NO_WINDOW，否则每分析一次就在用户屏幕上闪一只黑窗
#: （仓库 backend-python.js 记过同类事故）。所有 ffmpeg / ffprobe 调用只经下面两个包装。
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0


def _spawn_kwargs(kw: dict) -> dict:
    """给 subprocess 调用补上「不弹窗 + 不抢 stdin」的默认值。

    注意：Python 3.10 的 `subprocess.Popen` **不接受** `windowsHide` 关键字
    （那是 node 的 child_process 口径），传了会 TypeError；Windows 上压窗口靠
    `creationflags=CREATE_NO_WINDOW`，这是唯一有效且必须的口子。
    """
    if _NO_WINDOW:
        kw.setdefault("creationflags", _NO_WINDOW)
    kw.setdefault("stdin", subprocess.DEVNULL)
    return kw


def _run(cmd: list[str], **kw):
    """统一封装的 subprocess.run（不弹窗）。"""
    return subprocess.run(cmd, **_spawn_kwargs(kw))


def _popen(cmd: list[str], **kw):
    """统一封装的 subprocess.Popen（不弹窗）。"""
    return subprocess.Popen(cmd, **_spawn_kwargs(kw))


# ---------------------------------------------------------------- 工具发现


def find_ffmpeg(explicit: str | None = None) -> str | None:
    """按 --ffmpeg → PATH 的顺序找 ffmpeg；找不到回 None（不阻止服务启动）。"""
    if explicit:
        p = explicit.strip().strip('"')
        if p and os.path.isfile(p):
            return os.path.abspath(p)
        if p:
            found = shutil.which(p)
            if found:
                return os.path.abspath(found)
            return None
    return shutil.which("ffmpeg")


def find_ffprobe(ffmpeg_path: str | None) -> str | None:
    """ffprobe 优先取 ffmpeg 同目录，其次 PATH。"""
    if ffmpeg_path:
        d = os.path.dirname(ffmpeg_path)
        for name in ("ffprobe.exe", "ffprobe"):
            cand = os.path.join(d, name)
            if os.path.isfile(cand):
                return os.path.abspath(cand)
    return shutil.which("ffprobe")


_version_cache: dict[str, str] = {}


def ffmpeg_version(ffmpeg_path: str | None, timeout: float = 8.0) -> str:
    """取 `ffmpeg -version` 首行（进程内缓存）。失败回空串。"""
    if not ffmpeg_path:
        return ""
    if ffmpeg_path in _version_cache:
        return _version_cache[ffmpeg_path]
    text = ""
    try:
        p = _run([ffmpeg_path, "-hide_banner", "-version"],
                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
        line = (p.stdout or b"").decode("utf-8", "replace").splitlines()
        if line:
            text = line[0].strip()
    except Exception:
        text = ""
    # 只要版本号那一段：`ffmpeg version 7.1-full_build-... Copyright ...` → 7.1-full_build-...
    if text.lower().startswith("ffmpeg version "):
        text = text[len("ffmpeg version "):].split(" ")[0]
    _version_cache[ffmpeg_path] = text
    return text


def _tail(text: str, n: int = _STDERR_KEEP) -> str:
    return (text or "").strip()[-n:]


# ---------------------------------------------------------------- ffprobe 元信息

AUDIO_EXTS = {
    ".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".opus", ".wma", ".aiff", ".aif",
    ".mp4", ".mkv", ".mov", ".avi", ".webm", ".flv", ".ts", ".m4v", ".3gp",
}
VIDEO_ONLY_HINT = {".mp4", ".mkv", ".mov", ".avi", ".webm", ".flv", ".ts", ".m4v", ".3gp"}


def probe(ffprobe: str | None, path: str) -> dict:
    """读容器与流信息。

    返回 {hasAudio, durationSec|None, sourceSampleRateHz|None, sourceChannels|None,
          container, streams: [{codec_type, codec_name, sample_rate, channels}], formatName}
    ffprobe 缺失时回一个只有 container 的最小字典（时长随后由解码结果给出）。
    """
    ext = os.path.splitext(path)[1].lower()
    info = {
        "hasAudio": None,          # None = 未知（没有 ffprobe）
        "durationSec": None,
        "sourceSampleRateHz": None,
        "sourceChannels": None,
        "container": ext.lstrip("."),
        "formatName": "",
        "streams": [],
    }
    if not ffprobe:
        return info
    cmd = [ffprobe, "-hide_banner", "-v", "error", "-of", "json",
           "-show_format", "-show_streams", path]
    try:
        p = _run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
    except Exception as exc:  # 超时 / 无法执行
        raise AnalyzeError("E_INTERNAL", "ffprobe 无法执行", f"{type(exc).__name__}: {exc}")
    if p.returncode != 0:
        err = _tail((p.stderr or b"").decode("utf-8", "replace"))
        raise AnalyzeError(
            "E_UNSUPPORTED_FORMAT",
            "无法解析该文件的媒体信息",
            f"扩展名={ext or '(无)'} ffprobe={err.splitlines()[0] if err else '无输出'}",
        )
    try:
        data = json.loads((p.stdout or b"{}").decode("utf-8", "replace") or "{}")
    except Exception:
        data = {}
    fmt = data.get("format") or {}
    streams = data.get("streams") or []
    info["formatName"] = str(fmt.get("format_name") or "")
    if info["formatName"]:
        info["container"] = info["container"] or info["formatName"].split(",")[0]
    dur = fmt.get("duration")
    try:
        info["durationSec"] = float(dur) if dur not in (None, "", "N/A") else None
    except Exception:
        info["durationSec"] = None
    audio = [s for s in streams if str(s.get("codec_type")) == "audio"]
    info["hasAudio"] = bool(audio)
    info["streams"] = [
        {
            "codec_type": s.get("codec_type"),
            "codec_name": s.get("codec_name"),
            "sample_rate": s.get("sample_rate"),
            "channels": s.get("channels"),
        }
        for s in streams
    ]
    if audio:
        a = audio[0]
        try:
            info["sourceSampleRateHz"] = float(a.get("sample_rate")) if a.get("sample_rate") else None
        except Exception:
            info["sourceSampleRateHz"] = None
        try:
            info["sourceChannels"] = int(a.get("channels")) if a.get("channels") else None
        except Exception:
            info["sourceChannels"] = None
    return info


def streams_summary(info: dict) -> str:
    """容器里流清单的一行摘要（E_NO_AUDIO_STREAM 的 detail 用）。"""
    streams = info.get("streams") or []
    if not streams:
        return f"容器={info.get('formatName') or info.get('container') or '未知'} 流=0"
    parts = []
    for s in streams:
        parts.append(str(s.get("codec_type") or "?") + "/" + str(s.get("codec_name") or "?"))
    return f"容器={info.get('formatName') or info.get('container') or '未知'} 流={'+'.join(parts)}"


# ---------------------------------------------------------------- 解码


def decode(ffmpeg: str, path: str, sr: int) -> np.ndarray:
    """把音轨解成单声道 float32（`-f f32le` 管道），返回一维 numpy 数组。"""
    if not ffmpeg:
        raise AnalyzeError("E_INTERNAL", "找不到 ffmpeg，无法解码",
                           "去插件里安装 Remotion（会一并装下 ffmpeg），或用 --ffmpeg 指定绝对路径")
    cmd = [ffmpeg, "-hide_banner", "-nostdin", "-v", "error", "-i", path, "-vn",
           "-ac", "1", "-ar", str(int(sr)), "-f", "f32le", "pipe:1"]
    try:
        proc = _popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                      stdin=subprocess.DEVNULL, bufsize=0)
    except Exception as exc:
        raise AnalyzeError("E_INTERNAL", "无法启动 ffmpeg", f"{type(exc).__name__}: {exc}")

    err_box: list[bytes] = []

    def _drain() -> None:
        try:
            err_box.append(proc.stderr.read() or b"")
        except Exception:
            err_box.append(b"")

    reader = threading.Thread(target=_drain, daemon=True)
    reader.start()

    chunks: list[np.ndarray] = []
    rest = b""
    total = 0
    assert proc.stdout is not None
    while True:
        block = proc.stdout.read(_READ_CHUNK)
        if not block:
            break
        block = rest + block
        usable = len(block) - (len(block) % 4)   # f32 = 4 字节，跨块的半帧留到下一轮
        if usable:
            chunks.append(np.frombuffer(block[:usable], dtype="<f4"))
            total += usable // 4
        rest = block[usable:]
        if total > int(contract.MAX_DURATION_SEC * sr) + sr:
            # 超出时长上限：立刻掐掉解码（正常路径已在 probe 阶段拒绝）
            try:
                proc.kill()
            except Exception:
                pass
            raise AnalyzeError(
                "E_TOO_LONG",
                "素材超过时长上限",
                f"解码已超过 {contract.MAX_DURATION_SEC} 秒上限（上限 {contract.MAX_DURATION_SEC}s）",
            )

    reader.join(timeout=15)
    try:
        rc = proc.wait(timeout=15)
    except Exception:
        rc = -1
    stderr_text = (err_box[0] if err_box else b"").decode("utf-8", "replace")

    if rc != 0:
        raise AnalyzeError("E_DECODE_FAILED", "解码失败：ffmpeg 返回非 0", _tail(stderr_text))
    if not chunks:
        raise AnalyzeError("E_DECODE_FAILED", "解码后没有任何采样点",
                           _tail(stderr_text) or "ffmpeg 输出为空")
    x = np.concatenate(chunks).astype(np.float32, copy=False)
    chunks.clear()
    # 防御：NaN/Inf 会让后面所有统计变成 NaN
    np.nan_to_num(x, copy=False, nan=0.0, posinf=0.0, neginf=0.0)
    return x


# ---------------------------------------------------------------- 额外：整体响度 LUFS


def lufs_integrated(ffmpeg: str, path: str, timeout: float = 120.0) -> float | None:
    """用 ffmpeg ebur128 求整体响度（LUFS）；算不出回 None（契约允许 null）。"""
    if not ffmpeg:
        return None
    cmd = [ffmpeg, "-hide_banner", "-nostdin", "-v", "info", "-i", path, "-vn",
           "-af", "ebur128", "-f", "null", "-"]
    try:
        p = _run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    except Exception:
        return None
    text = (p.stderr or b"").decode("utf-8", "replace")
    value = None
    for line in text.splitlines():
        line = line.strip()
        # Summary 段：`  I:         -14.1 LUFS`
        if line.startswith("I:") and "LUFS" in line:
            token = line[2:].strip().split(" ")[0]
            try:
                value = float(token)
            except Exception:
                continue
    if value is None or not np.isfinite(value) or value < -70.0:
        return None
    return round(float(value), 1)
