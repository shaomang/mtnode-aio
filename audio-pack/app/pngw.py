"""PNG 编码器 + 四种图（纯 numpy + zlib，不用 Pillow / matplotlib）。

PNG 规格：RGB8（colortype=2）、无隔行、每行 filter=0、zlib 压缩；
宽高写真实像素（不变量第 7 条要求 widthPx/heightPx 与文件一致）。

四种图：

* `spectrogram`：对数频率 × 时间的热力图（数据来自 dsp 的分块聚合，不整段落内存）；
* `waveform`：每列 min/max 的波形柱；
* `beatOverlay`：波形（暗）+ **只用 beatsSec 画**的拍点竖线（重拍用 downbeatsSec 加粗）；
* `energyCurve`：归一化 RMS 面积图 + 相位档位底色 + 段落边界竖线。

全部注释与消息为中文。
"""

from __future__ import annotations

import os
import struct
import tempfile
import zlib

import numpy as np

#: 图的默认尺寸（px）—— 响应里的 widthPx/heightPx 就写这里算出的真实值
SIZES = {
    "spectrogram": (1024, 384),
    "waveform": (1024, 384),
    "beatOverlay": (1024, 384),
    "energyCurve": (1024, 256),
}

#: 频谱色带锚点（0-1 → RGB），近似 magma：低=近黑紫，高=暖黄
_CMAP_POS = (0.00, 0.15, 0.35, 0.55, 0.75, 0.90, 1.00)
_CMAP_R = (4, 40, 101, 159, 212, 245, 252)
_CMAP_G = (0, 11, 21, 42, 72, 125, 255)
_CMAP_B = (8, 84, 110, 99, 66, 21, 164)

_BG = (14, 16, 22)
_FG = (120, 200, 255)
_BEAT = (222, 232, 245)
_DOWNBEAT = (255, 176, 32)
_SECTION = (80, 230, 160)
_AXIS = (60, 66, 80)


# ---------------------------------------------------------------- PNG 编码


def _chunk(tag: bytes, data: bytes) -> bytes:
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def encode_png(rgb: np.ndarray) -> bytes:
    """HxWx3 uint8 → PNG 字节流。"""
    if rgb.ndim != 3 or rgb.shape[2] != 3:
        raise ValueError("PNG 需要 HxWx3 的 RGB 数组")
    img = np.ascontiguousarray(np.clip(rgb, 0, 255).astype(np.uint8))
    h, w = int(img.shape[0]), int(img.shape[1])
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    rows = np.concatenate([np.zeros((h, 1), np.uint8), img.reshape(h, w * 3)], axis=1)
    idat = zlib.compress(rows.tobytes(), 6)
    return (b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", ihdr)
            + _chunk(b"IDAT", idat) + _chunk(b"IEND", b""))


def write_png(path: str, rgb: np.ndarray) -> int:
    """原子写 PNG（先写同目录临时文件再 os.replace），返回字节数。"""
    data = encode_png(rgb)
    out_dir = os.path.dirname(os.path.abspath(path))
    os.makedirs(out_dir, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".png-", suffix=".tmp", dir=out_dir)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except Exception:
            pass
        raise
    return len(data)


def png_size(data: bytes) -> tuple[int, int]:
    """从 PNG 字节流读宽高（自检脚本用；不依赖 Pillow）。"""
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("不是 PNG")
    w, h = struct.unpack(">II", data[16:24])
    return int(w), int(h)


# ---------------------------------------------------------------- 画布工具


def _new_canvas(h: int, w: int, color=_BG) -> np.ndarray:
    img = np.zeros((h, w, 3), np.uint8)
    img[:, :] = np.array(color, np.uint8)
    return img


def _vline(img: np.ndarray, x: int, y0: int, y1: int, color, width: int = 1) -> None:
    h, w = img.shape[0], img.shape[1]
    x = int(x)
    if x < 0 or x >= w:
        return
    x0 = max(0, x)
    x1 = min(w, x + max(1, width))
    y0 = max(0, min(y0, h - 1))
    y1 = max(y0 + 1, min(y1, h))
    img[y0:y1, x0:x1] = np.array(color, np.uint8)


def _hline(img: np.ndarray, y: int, x0: int, x1: int, color, width: int = 1) -> None:
    h, w = img.shape[0], img.shape[1]
    if y < 0 or y >= h:
        return
    x0 = max(0, min(x0, w - 1))
    x1 = max(x0 + 1, min(x1, w))
    img[y:max(0, min(y + max(1, width), h)), x0:x1] = np.array(color, np.uint8)


def _time_to_x(t: float, duration: float, w: int) -> int:
    if duration <= 0:
        return 0
    return int(round(float(t) / float(duration) * (w - 1)))


def _cmap(values: np.ndarray) -> np.ndarray:
    """0-1 数组 → RGB（三通道 float→uint8）。"""
    v = np.clip(np.asarray(values, dtype=np.float64), 0.0, 1.0)
    r = np.interp(v, _CMAP_POS, _CMAP_R)
    g = np.interp(v, _CMAP_POS, _CMAP_G)
    b = np.interp(v, _CMAP_POS, _CMAP_B)
    return np.stack([r, g, b], axis=-1).astype(np.uint8)


def _resize_rows(canvas: np.ndarray, h: int) -> np.ndarray:
    """按行最近邻拉伸到 h 行（列数不变）。"""
    rows = int(canvas.shape[0])
    if rows == h or rows <= 0:
        return canvas
    idx = (np.arange(h, dtype=np.int64) * rows) // h
    return canvas[np.clip(idx, 0, rows - 1)]


def _resize_cols(values: np.ndarray, w: int) -> np.ndarray:
    """一维数组按列最近邻拉伸到 w 列。"""
    n = int(values.size)
    if n == w or n <= 0:
        return values
    idx = (np.arange(w, dtype=np.int64) * n) // w
    return values[np.clip(idx, 0, n - 1)]


def waveform_columns(x: np.ndarray, cols: int) -> tuple[np.ndarray, np.ndarray]:
    """每列的 (min, max)（波形图用）。"""
    x = np.asarray(x, dtype=np.float32).ravel()
    n = int(x.size)
    cols = int(max(1, cols))
    if n == 0:
        z = np.zeros(cols, np.float32)
        return z, z
    edges = (np.arange(cols + 1, dtype=np.int64) * n) // cols
    starts = edges[:-1]
    np.maximum.accumulate(starts, out=starts)
    lo = np.minimum.reduceat(x, starts)
    hi = np.maximum.reduceat(x, starts)
    return lo, hi


# ---------------------------------------------------------------- 四种图


def render_spectrogram(spec: np.ndarray, duration: float) -> np.ndarray:
    """频谱图：行=频率（上高下低）、列=时间。"""
    w, h = SIZES["spectrogram"]
    if spec is None or np.asarray(spec).size == 0:
        img = _new_canvas(h, w)
        _hline(img, h // 2, 0, w, _AXIS)
        return img
    canvas = np.asarray(spec, dtype=np.float32)
    if canvas.ndim != 2:
        canvas = canvas.reshape(1, -1)
    rows = _resize_rows(canvas[::-1], h)            # 反转：高频在上
    # 逐行横向拉伸到 w 列，拼成 (h, w) —— 行=频率、列=时间（别写反，否则图是躺着的）
    cols = np.stack([_resize_cols(rows[i, :], w) for i in range(rows.shape[0])], axis=0)
    img = _cmap(cols)
    # 时间坐标轴刻度线（每 10% 一根，纯装饰，不做文字）
    for k in range(1, 10):
        _vline(img, int(w * k / 10) - 0, 0, 4, _AXIS)
    return img


def render_waveform(x: np.ndarray, duration: float) -> np.ndarray:
    """波形图：每列一根 min→max 柱。"""
    w, h = SIZES["waveform"]
    img = _new_canvas(h, w)
    lo, hi = waveform_columns(x, w)
    peak = float(np.max(np.abs(np.concatenate([lo, hi])))) if lo.size else 0.0
    scale = (h * 0.45) / peak if peak > 1e-9 else 0.0
    mid = h / 2.0
    _hline(img, int(mid), 0, w, _AXIS)
    for c in range(w):
        y0 = int(mid - float(hi[c]) * scale)
        y1 = int(mid - float(lo[c]) * scale)
        if y1 < y0:
            y0, y1 = y1, y0
        img[max(0, y0):min(h, y1 + 1), c] = np.array(_FG, np.uint8)
    return img


def render_beat_overlay(x: np.ndarray, duration: float, beats_sec, downbeats_sec,
                        sections_start) -> np.ndarray:
    """波形 + 拍点竖线。竖线**只从 beatsSec 取时间**（downbeat 只是加粗同一根线）。"""
    w, h = SIZES["beatOverlay"]
    img = render_waveform(x, duration).copy()
    img = (img.astype(np.float32) * 0.55).astype(np.uint8)   # 压暗波形，突出竖线
    db = set()
    for t in downbeats_sec or []:
        db.add(round(float(t), 4))
    for t in beats_sec or []:
        t = float(t)
        if t < 0 or t > duration + 1e-6:
            continue
        x_col = _time_to_x(t, duration, w)
        thick = 3 if round(t, 4) in db else 1
        color = _DOWNBEAT if round(t, 4) in db else _BEAT
        _vline(img, x_col, 2, h - 2, color, thick)
    for t in sections_start or []:
        _vline(img, _time_to_x(float(t), duration, w), 0, 6, _SECTION, 2)
    return img


def render_energy_curve(rms_norm: np.ndarray, rms_db: np.ndarray, phases: list,
                        duration: float, sections_start) -> np.ndarray:
    """归一化 RMS 面积图 + 相位底色 + 段落边界。"""
    w, h = SIZES["energyCurve"]
    img = _new_canvas(h, w)
    if rms_norm is not None and np.asarray(rms_norm).size:
        # 相位底色（VOID 最深 → HIGH 最亮）
        shade = {"VOID": (18, 18, 24), "LOW": (26, 30, 44), "MEDIUM": (34, 42, 62),
                 "HIGH": (44, 56, 82)}
        for ph in phases or []:
            s = float(ph.get("startSec", 0.0))
            e = float(ph.get("endSec", duration))
            x0 = _time_to_x(s, duration, w)
            x1 = _time_to_x(e, duration, w)
            col = shade.get(str(ph.get("label")), (24, 24, 32))
            img[:, max(0, x0):max(x0 + 1, min(w, x1))] = np.array(col, np.uint8)
        vals = _resize_cols(np.asarray(rms_norm, dtype=np.float32), w)
        for c in range(w):
            y = int(round((h - 1) * (1.0 - float(np.clip(vals[c], 0.0, 1.0)))))
            y = max(0, min(h - 1, y))
            img[y:h, c] = np.array((90, 190, 255), np.uint8)
            img[y:min(h, y + 2), c] = np.array((200, 240, 255), np.uint8)
        # 0.5 参考线
        _hline(img, h // 2, 0, w, (52, 58, 74))
    for t in sections_start or []:
        _vline(img, _time_to_x(float(t), duration, w), 0, h, _SECTION, 2)
    return img
