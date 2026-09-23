#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
stream_upscale.py —— 逐帧分块流式超分（Real-ESRGAN x4plus / x2plus，纯 torch）

为什么不用 ComfyUI 图（对齐 h3/main-h3.js 的「系统内存（RAM）闸」注释口径）：
    旧链是 LoadVideo → GetVideoComponents → ImageUpscaleWithModelBatched → CreateVideo。
    KJNodes 的 ImageUpscaleWithModelBatched 是「逐批过 GPU、结果 .cpu() 攒在 RAM」，
    最后 torch.cat + .float() 再复制一份 —— 也就是**整段视频的所有帧张量同时躺在系统内存里**，
    峰值 ≈ 帧数 × 源像素 × 模型倍数² × 4B（15s@720p 走 x4 中间张量就 ~21GB，与显存无关）。
    图上的 tile / per_batch 只能让显存小一点，压不住 RAM：所以 64G 也会见顶、16G 根本跑不动。

本脚本换成与时长无关的流式管线：
    PyAV 顺序 decode 一帧 → 按 tile 分块过模型（default 512，overlap 线性羽化拼接）
    → 立刻按目标长边缩回 → 立刻编码写盘 → 丢掉这一帧的张量。
    常驻内存只与「单个 tile + 一帧的输出画布」有关，与视频多长无关；
    音轨用 PyAV 从源文件原样直拷（不重编码）。16G 内存机器也能跑 15 秒级 x2/x4 超分。

依赖只用 ComfyUI venv 里已有的 torch / av / numpy / cv2 / kornia（零新增依赖）；
**绝不 import basicsr / realesrgan**（venv 里本来就没有，RRDBNet 在这里用纯 torch 复刻）。

CLI：
    python stream_upscale.py --input in.mp4 --output out.mp4 --model <RealESRGAN_x4plus.pth>
        [--scale 2|4] [--target-long-side 3840] [--tile 512] [--overlap 16]
        [--precision auto|fp16|fp32] [--device auto|cuda|cpu] [--crf 17] [--preset medium]
        [--fps N] [--progress-every N] [--json-out FILE] [--quiet]
    python stream_upscale.py --self-test [--json-out FILE]   # 无 GPU / 无权重也能跑通整链

stdout 只打换行分隔 JSON：meta / progress / done / error。
stdin 收到 cancel（或 stop / quit / abort）、或收到 SIGINT / SIGTERM 时中断并清理半成品。

退出码：0 成功 · 1 一般失败 · 2 参数错误 · 3 显存/内存不足（可降档重试）· 4 已取消。
"""

from __future__ import annotations

import argparse
import gc
import json
import os
import signal
import sys
import tempfile
import threading
import time
from fractions import Fraction

import numpy as np

# ── 退出码（宿主据此选路：3 = OOM 可降档重试，4 = 用户取消） ──────────────────────
EXIT_OK = 0
EXIT_FAIL = 1
EXIT_ARGS = 2
EXIT_OOM = 3
EXIT_CANCEL = 4

# ── 默认档位 ─────────────────────────────────────────────────────────────────
DEFAULT_TILE = 512
DEFAULT_OVERLAP = 16
DEFAULT_SCALE = 4
DEFAULT_TARGET_LONG_SIDE = 3840
DEFAULT_CRF = 17
DEFAULT_PRESET = "medium"


# ════════════════════════════════════════════════════════════════════════════
# 纯 torch 版 RRDBNet（与 RealESRGAN_x4plus.pth / x2plus.pth 权重逐键对齐）
#   结构：conv_first → 23 × RRDB → conv_body → 残差 → up1 → (up2) → conv_hr → conv_last
#   每个 RRDB = 3 个 ResidualDenseBlock，每个 RDB = 5 层 conv（密集连接 + 0.2 残差）
#   x4plus 有 conv_up1 / conv_up2（scale=4），x2plus 只有 conv_up1（scale=2）——
#   这里按 state_dict 里 conv_up2.weight 是否存在自动判档，权重文件不用改名。
# ════════════════════════════════════════════════════════════════════════════
import torch
import torch.nn as nn
import torch.nn.functional as F


class ResidualDenseBlock(nn.Module):
    def __init__(self, num_feat: int = 64, num_grow_ch: int = 32) -> None:
        super().__init__()
        self.conv1 = nn.Conv2d(num_feat, num_grow_ch, 3, 1, 1)
        self.conv2 = nn.Conv2d(num_feat + num_grow_ch, num_grow_ch, 3, 1, 1)
        self.conv3 = nn.Conv2d(num_feat + 2 * num_grow_ch, num_grow_ch, 3, 1, 1)
        self.conv4 = nn.Conv2d(num_feat + 3 * num_grow_ch, num_grow_ch, 3, 1, 1)
        self.conv5 = nn.Conv2d(num_feat + 4 * num_grow_ch, num_feat, 3, 1, 1)
        self.lrelu = nn.LeakyReLU(0.2, inplace=True)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x1 = self.lrelu(self.conv1(x))
        x2 = self.lrelu(self.conv2(torch.cat((x, x1), 1)))
        x3 = self.lrelu(self.conv3(torch.cat((x, x1, x2), 1)))
        x4 = self.lrelu(self.conv4(torch.cat((x, x1, x2, x3), 1)))
        x5 = self.conv5(torch.cat((x, x1, x2, x3, x4), 1))
        return x5 * 0.2 + x


class RRDB(nn.Module):
    def __init__(self, num_feat: int, num_grow_ch: int = 32) -> None:
        super().__init__()
        self.rdb1 = ResidualDenseBlock(num_feat, num_grow_ch)
        self.rdb2 = ResidualDenseBlock(num_feat, num_grow_ch)
        self.rdb3 = ResidualDenseBlock(num_feat, num_grow_ch)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        out = self.rdb1(x)
        out = self.rdb2(out)
        out = self.rdb3(out)
        return out * 0.2 + x


class RRDBNet(nn.Module):
    def __init__(
        self,
        num_in_ch: int = 3,
        num_out_ch: int = 3,
        num_feat: int = 64,
        num_block: int = 23,
        num_grow_ch: int = 32,
        num_up: int = 2,
    ) -> None:
        super().__init__()
        self.num_up = 2 if num_up >= 2 else 1
        self.scale = 2 ** self.num_up
        self.conv_first = nn.Conv2d(num_in_ch, num_feat, 3, 1, 1)
        self.body = nn.Sequential(*[RRDB(num_feat, num_grow_ch) for _ in range(num_block)])
        self.conv_body = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
        self.conv_up1 = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
        if self.num_up == 2:
            self.conv_up2 = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
        self.conv_hr = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
        self.conv_last = nn.Conv2d(num_feat, num_out_ch, 3, 1, 1)
        self.lrelu = nn.LeakyReLU(0.2, inplace=True)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        feat = self.conv_first(x)
        feat = feat + self.conv_body(self.body(feat))
        feat = self.lrelu(self.conv_up1(F.interpolate(feat, scale_factor=2, mode="nearest")))
        if self.num_up == 2:
            feat = self.lrelu(self.conv_up2(F.interpolate(feat, scale_factor=2, mode="nearest")))
        return self.conv_last(self.lrelu(self.conv_hr(feat)))


def _strip_state_dict(obj):
    """权重文件顶层常见 params_ema / params / state_dict 包一层 —— 逐层剥到真正的参数表。"""
    if not isinstance(obj, dict):
        return obj
    for key in ("params_ema", "params", "state_dict"):
        inner = obj.get(key)
        if isinstance(inner, dict):
            return inner
    return obj


def build_model(model_path: str | None, device: torch.device, dtype: torch.dtype,
                allow_random: bool = False) -> tuple[RRDBNet, int]:
    """按权重实际键名判档（conv_up2 有无 → x4 / x2），weights_only=True 加载。返回 (net, 模型原生倍数)。"""
    state = None
    if model_path:
        if not os.path.isfile(model_path):
            raise FileNotFoundError("权重不存在：" + model_path)
        state = _strip_state_dict(torch.load(model_path, map_location="cpu", weights_only=True))
        if not isinstance(state, dict) or not state:
            raise RuntimeError("权重文件读不出参数表：" + model_path)
    elif not allow_random:
        raise RuntimeError("缺少 --model（可加 --allow-random-weights 仅供自检）")

    num_up = 2
    if isinstance(state, dict) and "conv_up2.weight" not in state:
        num_up = 1
    net = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=23, num_grow_ch=32, num_up=num_up)
    if isinstance(state, dict):
        try:
            net.load_state_dict(state, strict=True)
        except RuntimeError as exc:
            raise RuntimeError(
                "权重与本脚本的 RRDBNet 结构不匹配（期望 RealESRGAN x4plus / x2plus）：" + str(exc)
            ) from exc
    net.eval()
    net = net.to(device)
    if dtype == torch.float16:
        net = net.half()
    return net, net.scale


# ════════════════════════════════════════════════════════════════════════════
# 内存 / 显存口径
# ════════════════════════════════════════════════════════════════════════════
class MemTrack:
    """峰值系统内存（MB）：psutil 当前 RSS 采样取最大；Windows 再看进程 peak_wset。"""

    def __init__(self) -> None:
        self.peak = 0.0
        self._proc = None
        try:
            import psutil  # noqa: PLC0415

            self._proc = psutil.Process()
        except Exception:
            self._proc = None

    def current(self) -> float:
        if self._proc is None:
            return 0.0
        try:
            info = self._proc.memory_info()
            cur = float(info.rss) / 1048576.0
            peak = getattr(info, "peak_wset", None)
            if peak:
                cur = max(cur, float(peak) / 1048576.0)
            return cur
        except Exception:
            return 0.0

    def sample(self) -> float:
        cur = self.current()
        if cur > self.peak:
            self.peak = cur
        return self.peak


def _vram_peak_mb(device: torch.device) -> float:
    try:
        if device.type == "cuda":
            return float(torch.cuda.max_memory_allocated()) / 1048576.0
    except Exception:
        pass
    return 0.0


# ════════════════════════════════════════════════════════════════════════════
# 分块 / 羽化拼接
# ════════════════════════════════════════════════════════════════════════════
def tile_starts(total: int, tile: int, overlap: int) -> list[int]:
    """按 step = tile - overlap 铺块，末尾对齐到 total - tile（不足一块就单块）。"""
    if tile >= total:
        return [0]
    step = max(1, tile - overlap)
    starts = list(range(0, total - tile + 1, step))
    if starts[-1] != total - tile:
        starts.append(total - tile)
    return starts


def _ramp_up(n: int, ov: int) -> torch.Tensor:
    idx = torch.arange(n, dtype=torch.float32) + 1.0
    return torch.clamp(idx / float(ov + 1), min=1.0 / float(ov + 1), max=1.0)


def make_window(th: int, tw: int, ov: int, top_edge: bool, left_edge: bool,
                bottom_edge: bool, right_edge: bool) -> torch.Tensor:
    """线性羽化窗：贴图像边的一侧不加权（=1），与邻块重叠的一侧从 1/(ov+1) 升到 1。
    sum(w) 归一化后与相邻块无缝拼接；权重恒 >0，重叠区不会出现除零黑洞。"""
    wy = torch.ones(th, dtype=torch.float32)
    if not top_edge:
        wy = torch.minimum(wy, _ramp_up(th, ov))
    if not bottom_edge:
        wy = torch.minimum(wy, torch.flip(_ramp_up(th, ov), dims=[0]))
    wx = torch.ones(tw, dtype=torch.float32)
    if not left_edge:
        wx = torch.minimum(wx, _ramp_up(tw, ov))
    if not right_edge:
        wx = torch.minimum(wx, torch.flip(_ramp_up(tw, ov), dims=[0]))
    return wy[:, None] * wx[None, :]


def upscale_frame(net: RRDBNet, frame_rgb: np.ndarray, device: torch.device,
                  dtype: torch.dtype, tile: int, overlap: int,
                  cancel: dict | None = None) -> torch.Tensor:
    """一帧 uint8 HxWx3 → 超分后的 float32 3x(H*s)x(W*s)，全程只用「一个 tile + 一张输出画布」。"""
    h, w = int(frame_rgb.shape[0]), int(frame_rgb.shape[1])
    scale = net.scale
    src = torch.from_numpy(np.ascontiguousarray(frame_rgb)).permute(2, 0, 1).float().div_(255.0)
    canvas = torch.zeros((3, h * scale, w * scale), dtype=torch.float32)
    wsum = torch.zeros((1, h * scale, w * scale), dtype=torch.float32)

    ys = tile_starts(h, tile, overlap)
    xs = tile_starts(w, tile, overlap)
    for yi, y0 in enumerate(ys):
        y1 = min(y0 + tile, h)
        for xi, x0 in enumerate(xs):
            if cancel and cancel.get("cancel"):
                return canvas
            x1 = min(x0 + tile, w)
            crop = src[:, y0:y1, x0:x1].unsqueeze(0).to(device=device, dtype=dtype)
            with torch.inference_mode():
                out = net(crop)
            # .clone()：inference_mode 产出的张量带 inference 标记，原地 mul_ / 累加会被 torch 拒绝
            out = out[0].float().cpu().clone()
            win = make_window(
                out.shape[1], out.shape[2], overlap * scale,
                top_edge=(yi == 0), left_edge=(xi == 0),
                bottom_edge=(yi == len(ys) - 1), right_edge=(xi == len(xs) - 1),
            )
            out.mul_(win)
            oy, ox = y0 * scale, x0 * scale
            canvas[:, oy:oy + out.shape[1], ox:ox + out.shape[2]] += out
            wsum[:, oy:oy + out.shape[1], ox:ox + out.shape[2]] += win
            del crop, out
    canvas.div_(wsum.clamp_min(1e-6))
    return canvas.clamp_(0.0, 1.0)


# ════════════════════════════════════════════════════════════════════════════
# 尺寸换算（与 h3/main-h3.js 的 postDimsForLongSide 同口径：取偶） 
# ════════════════════════════════════════════════════════════════════════════
def out_dims_for_long_side(width: int, height: int, long_side: int) -> tuple[int, int]:
    long = max(int(width), int(height))
    target = max(1, int(long_side))
    s = target / float(long)
    tw = max(2, int(round(width * s / 2.0)) * 2)
    th = max(2, int(round(height * s / 2.0)) * 2)
    return tw, th


def resize_to_long_side(torch_img: torch.Tensor, long_side: int) -> np.ndarray:
    """超分结果（float32 3xHxW）按目标长边缩回并转 uint8 HxWx3（cv2.INTER_AREA 抗锯齿）。"""
    import cv2  # noqa: PLC0415

    arr = (torch_img.permute(1, 2, 0).numpy() * 255.0 + 0.5).astype(np.uint8)
    h, w = arr.shape[0], arr.shape[1]
    if long_side and long_side > 0:
        want = min(int(long_side), max(w, h))
        if want != max(w, h):
            tw, th = out_dims_for_long_side(w, h, want)
            arr = cv2.resize(arr, (tw, th), interpolation=cv2.INTER_AREA)
    if arr.shape[0] % 2 or arr.shape[1] % 2:
        tw = max(2, arr.shape[1] - (arr.shape[1] % 2))
        th = max(2, arr.shape[0] - (arr.shape[0] % 2))
        arr = cv2.resize(arr, (tw, th), interpolation=cv2.INTER_AREA)
    return arr


# ════════════════════════════════════════════════════════════════════════════
# 输出尺寸：长边 = min(目标长边, 源长边 × 请求倍率)（倍率是上限，和旧链口径一致）
# ════════════════════════════════════════════════════════════════════════════
def resolve_output_long_side(src_long: int, request_scale: int, target_long_side: int) -> int:
    cap = max(2, int(src_long) * max(1, int(request_scale)))
    if target_long_side and int(target_long_side) > 0:
        return max(2, min(int(target_long_side), cap))
    return cap


# ════════════════════════════════════════════════════════════════════════════
# 取消 / 信号
# ════════════════════════════════════════════════════════════════════════════
class Canceller:
    def __init__(self) -> None:
        self.state = {"cancel": False}
        self._stop = threading.Event()
        self._thread = None

    def install(self) -> None:
        def _on_signal(_signum, _frame):
            self.state["cancel"] = True
            self._stop.set()

        for sig in (getattr(signal, "SIGINT", None), getattr(signal, "SIGTERM", None)):
            if sig is not None:
                try:
                    signal.signal(sig, _on_signal)
                except Exception:
                    pass

        def _watch():
            try:
                while not self._stop.is_set():
                    line = sys.stdin.readline()
                    if not line:
                        return
                    low = line.strip().lower()
                    if low in ("cancel", "stop", "quit", "abort") or '"cancel"' in low:
                        self.state["cancel"] = True
                        self._stop.set()
                        return
            except Exception:
                return

        if sys.stdin is not None:
            self._thread = threading.Thread(target=_watch, daemon=True, name="stdin-cancel")
            self._thread.start()

    @property
    def cancelled(self) -> bool:
        return bool(self.state["cancel"])


def _emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


# ════════════════════════════════════════════════════════════════════════════
# 音频直拷（PyAV remux，不重编码）
# ════════════════════════════════════════════════════════════════════════════
def copy_audio(src_path: str, out_container, out_stream) -> int:
    import av  # noqa: PLC0415

    n = 0
    with av.open(src_path) as ain:
        if not len(ain.streams.audio):
            return 0
        for packet in ain.demux(ain.streams.audio[0]):
            if packet.size == 0:
                continue
            packet.stream = out_stream
            out_container.mux(packet)
            n += 1
    return n


# ════════════════════════════════════════════════════════════════════════════
# 主链路
# ════════════════════════════════════════════════════════════════════════════
def run_stream(args: argparse.Namespace) -> dict:
    import av  # noqa: PLC0415

    src = os.path.abspath(args.input)
    dst = os.path.abspath(args.output)
    if not os.path.isfile(src):
        raise FileNotFoundError("输入视频不存在：" + src)
    os.makedirs(os.path.dirname(dst) or ".", exist_ok=True)

    mem = MemTrack()
    cancel = Canceller()
    cancel.install()
    t0 = time.time()

    device = resolve_device(args.device)
    dtype = resolve_dtype(args.precision, device)
    net, model_scale = build_model(args.model, device, dtype, allow_random=args.allow_random_weights)
    mem.sample()

    vin = av.open(src)
    try:
        vstream = vin.streams.video[0]
        vstream.thread_type = "AUTO"
        fps = _as_rate(args.fps) if args.fps else _as_rate(vstream.average_rate or 24)
        frames_total = int(vstream.frames or 0)
        if frames_total <= 0 and vstream.duration and vstream.time_base:
            frames_total = int(round(float(vstream.duration * vstream.time_base) * float(fps)))

        out = av.open(dst, "w", format="mp4")
        try:
            ostream = out.add_stream("libx264", rate=fps)
            ostream.pix_fmt = "yuv420p"
            ostream.options = {"crf": str(int(args.crf)), "preset": str(args.preset)}
            aout = None
            try:
                if len(vin.streams.audio):
                    aout = out.add_stream_from_template(vin.streams.audio[0])
            except Exception as exc:  # 音轨模板不兼容就放弃音轨，不拖垮视频
                sys.stderr.write("[stream-upscale] 音轨模板不可用，输出无音轨：" + str(exc) + "\n")
                aout = None

            first = None
            out_w = out_h = 0
            out_long = 0
            done = 0
            peak_ram = mem.sample()
            peak_vram = 0.0
            cancelled = False
            for frame in vin.decode(vstream):
                if cancel.cancelled:
                    cancelled = True
                    break
                arr = frame.to_ndarray(format="rgb24")
                if first is None:
                    sh, sw = int(arr.shape[0]), int(arr.shape[1])
                    out_long = resolve_output_long_side(max(sh, sw), args.scale, args.target_long_side)
                    # 模型原生倍数也是上限（x2 权重配 --scale 4 时最多到源 ×2）
                    out_long = min(out_long, max(sh, sw) * net.scale)
                    out_w, out_h = out_dims_for_long_side(sw, sh, out_long)
                    ostream.width, ostream.height = int(out_w), int(out_h)
                    first = True
                    _emit({
                        "type": "meta",
                        "input": src,
                        "output": dst,
                        "sourceWidth": sw,
                        "sourceHeight": sh,
                        "outWidth": out_w,
                        "outHeight": out_h,
                        "frames": frames_total,
                        "fps": float(fps),
                        "modelScale": model_scale,
                        "requestScale": int(args.scale),
                        "tile": int(args.tile),
                        "overlap": int(args.overlap),
                        "precision": "fp16" if dtype == torch.float16 else "fp32",
                        "device": str(device),
                        "audio": bool(aout is not None),
                    })

                hr = upscale_frame(net, arr, device, dtype, int(args.tile), int(args.overlap), cancel.state)
                if cancel.cancelled:
                    cancelled = True
                    del hr
                    break
                # 模型原生倍数可能高于请求倍率（x2 用 x4 权重）：按 min(目标长边, 源长边×倍率) 缩回
                if net.scale > 1 and max(hr.shape[1], hr.shape[2]) > out_long:
                    px = resize_to_long_side(hr, out_long)
                else:
                    px = (hr.permute(1, 2, 0).numpy() * 255.0 + 0.5).astype(np.uint8)
                    if px.shape[1] != out_w or px.shape[0] != out_h:
                        px = resize_to_long_side(hr, out_long if out_long else max(out_w, out_h))
                del hr

                vframe = av.VideoFrame.from_ndarray(np.ascontiguousarray(px), format="rgb24")
                vframe = vframe.reformat(format="yuv420p")
                vframe.pts = done
                for packet in ostream.encode(vframe):
                    out.mux(packet)
                del vframe, px
                done += 1

                peak_ram = mem.sample()
                peak_vram = max(peak_vram, _vram_peak_mb(device))
                if not args.quiet and done % max(1, int(args.progress_every)) == 0:
                    _emit({
                        "type": "progress",
                        "pct": round(done * 100.0 / frames_total, 2) if frames_total else 0,
                        "frame": done,
                        "frames": frames_total,
                        "peakRamMb": round(peak_ram, 1),
                        "peakVramMb": round(peak_vram, 1),
                    })
                if done % 24 == 0:
                    gc.collect()

            if cancelled:
                raise _Cancelled()

            if first is None:
                raise RuntimeError("源视频没有解出任何视频帧")

            for packet in ostream.encode():
                out.mux(packet)
            audio_packets = 0
            if aout is not None:
                audio_packets = copy_audio(src, out, aout)
        finally:
            try:
                out.close()
            except Exception:
                pass
    finally:
        try:
            vin.close()
        except Exception:
            pass

    peak_ram = mem.sample()
    peak_vram = max(_vram_peak_mb(device), 0.0)
    return {
        "type": "done",
        "ok": True,
        "input": src,
        "output": dst,
        "frames": done,
        "framesTotal": frames_total,
        "width": out_w,
        "height": out_h,
        "outLongSide": out_long,
        "sourceWidth": sh,
        "sourceHeight": sw,
        "modelScale": model_scale,
        "requestScale": int(args.scale),
        "tile": int(args.tile),
        "overlap": int(args.overlap),
        "precision": "fp16" if dtype == torch.float16 else "fp32",
        "device": str(device),
        "crf": int(args.crf),
        "audioPackets": audio_packets,
        "seconds": round(time.time() - t0, 3),
        "peakRamMb": round(peak_ram, 1),
        "peakVramMb": round(peak_vram, 1),
        "bytes": os.path.getsize(dst) if os.path.isfile(dst) else 0,
    }


class _Cancelled(Exception):
    pass


def _as_rate(v) -> Fraction:
    if isinstance(v, Fraction):
        return v
    return Fraction(str(v)).limit_denominator(1000000)


def resolve_device(name: str) -> torch.device:
    if name == "cpu":
        return torch.device("cpu")
    if name == "cuda":
        if not torch.cuda.is_available():
            raise RuntimeError("指定了 --device cuda，但当前环境 torch.cuda.is_available() 为 False")
        return torch.device("cuda")
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def resolve_dtype(name: str, device: torch.device) -> torch.dtype:
    if name == "fp32":
        return torch.float32
    if name == "fp16":
        return torch.float16 if device.type == "cuda" else torch.float32
    return torch.float16 if device.type == "cuda" else torch.float32


# ════════════════════════════════════════════════════════════════════════════
# --self-test：无 GPU / 无权重也能跑通「假视频 → 解码 → 分块超分 → 编码 + 音轨直拷」整链
# ════════════════════════════════════════════════════════════════════════════
def _write_fake_video(path: str, w: int, h: int, frames: int, fps: int) -> bool:
    """纯色三帧 +（尽力而为的）静音 AAC 音轨，用来验证解码 / 编码 / 音轨直拷三段。"""
    import av  # noqa: PLC0415

    has_audio = False
    with av.open(path, "w", format="mp4") as out:
        vs = out.add_stream("libx264", rate=fps)
        vs.width, vs.height = w, h
        vs.pix_fmt = "yuv420p"
        try:
            a = out.add_stream("aac", rate=44100)
            a.layout = "mono"
            has_audio = True
        except Exception:
            a = None
        for i in range(frames):
            rgb = np.zeros((h, w, 3), dtype=np.uint8)
            rgb[..., i % 3] = 60 + i * 40
            rgb[(h // 4):(h // 2), (w // 4):(w // 2)] = (200, 180, 40)
            vf = av.VideoFrame.from_ndarray(rgb, format="rgb24").reformat(format="yuv420p")
            vf.pts = i
            for p in vs.encode(vf):
                out.mux(p)
        for p in vs.encode():
            out.mux(p)
        if a is not None:
            try:
                n = int(44100 / fps)
                for i in range(frames):
                    data = np.zeros((1, n), dtype=np.int16)
                    af = av.AudioFrame.from_ndarray(data, format="s16", layout="mono")
                    af.sample_rate = 44100
                    af.pts = i * n
                    af.time_base = Fraction(1, 44100)
                    for p in a.encode(af):
                        out.mux(p)
                for p in a.encode():
                    out.mux(p)
            except Exception:
                has_audio = False
    return has_audio


def run_self_test(args: argparse.Namespace) -> dict:
    tmpdir = tempfile.mkdtemp(prefix="stream-upscale-selftest-")
    src = os.path.join(tmpdir, "in.mp4")
    dst = os.path.join(tmpdir, "out.mp4")
    w, h, frames, fps = 96, 64, 3, 8
    has_audio = _write_fake_video(src, w, h, frames, fps)

    sub = argparse.Namespace(**vars(args))
    sub.input = src
    sub.output = dst
    sub.device = "cpu"
    sub.precision = "fp32"
    sub.tile = 64
    sub.overlap = 8
    sub.scale = 4
    sub.target_long_side = 0  # 自检不缩放：直出模型原生尺寸，方便断言
    sub.progress_every = 1
    sub.allow_random_weights = True
    sub.model = args.model if (args.model and os.path.isfile(args.model)) else None
    sub.quiet = True

    rec = run_stream(sub)
    import av  # noqa: PLC0415

    with av.open(dst) as c:
        got_frames = sum(1 for _ in c.decode(c.streams.video[0]))
        got_w = int(c.streams.video[0].codec_context.width)
        got_h = int(c.streams.video[0].codec_context.height)
        got_audio = len(c.streams.audio)
    ok = (
        os.path.isfile(dst)
        and os.path.getsize(dst) > 0
        and got_frames == frames
        and got_w == w * rec["modelScale"]
        and got_h == h * rec["modelScale"]
    )
    rec.update({
        "type": "done",
        "selfTest": True,
        "ok": bool(ok),
        "fake": {"width": w, "height": h, "frames": frames, "fps": fps, "audio": bool(has_audio)},
        "verify": {"frames": got_frames, "width": got_w, "height": got_h, "audioStreams": got_audio},
        "weights": sub.model or "random-init",
    })
    try:
        import shutil  # noqa: PLC0415

        shutil.rmtree(tmpdir, ignore_errors=True)
    except Exception:
        pass
    return rec


# ════════════════════════════════════════════════════════════════════════════
# CLI
# ════════════════════════════════════════════════════════════════════════════
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="stream_upscale.py",
        description="逐帧分块流式超分（Real-ESRGAN x4plus / x2plus，纯 torch，内存与视频时长无关）",
    )
    p.add_argument("--input", "-i", default="", help="源视频路径")
    p.add_argument("--output", "-o", default="", help="输出 mp4 路径")
    p.add_argument("--model", default="", help="RealESRGAN_x4plus.pth / x2plus.pth（自检可省）")
    p.add_argument("--scale", type=int, default=DEFAULT_SCALE, choices=[2, 4], help="输出倍率（上限）")
    p.add_argument("--target-long-side", type=int, default=DEFAULT_TARGET_LONG_SIDE,
                   help="输出长边上限；0 = 只按倍率")
    p.add_argument("--tile", type=int, default=DEFAULT_TILE, help="分块边长（源像素，越小越省内存）")
    p.add_argument("--overlap", type=int, default=DEFAULT_OVERLAP, help="分块重叠（源像素，羽化拼接）")
    p.add_argument("--precision", default="auto", choices=["auto", "fp16", "fp32"])
    p.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    p.add_argument("--crf", type=int, default=DEFAULT_CRF, help="libx264 CRF（越小越清晰）")
    p.add_argument("--preset", default=DEFAULT_PRESET, help="libx264 preset")
    p.add_argument("--fps", type=float, default=0.0, help="输出帧率；省略 = 跟随源")
    p.add_argument("--progress-every", type=int, default=1, help="每 N 帧打一行进度 JSON")
    p.add_argument("--json-out", default="", help="把事实回执写到该文件（含峰值内存 / 显存 / 耗时）")
    p.add_argument("--quiet", action="store_true", help="不打逐帧进度（仍打 meta / done）")
    p.add_argument("--self-test", action="store_true", help="CPU 小图冒烟：假视频跑通整链后退出")
    p.add_argument("--allow-random-weights", action="store_true",
                   help="无权重时用随机初始化（仅供自检，画面无意义）")
    return p


def _write_receipt(path: str, rec: dict) -> None:
    if not path:
        return
    try:
        os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(rec, fh, ensure_ascii=False, indent=2)
    except Exception as exc:
        sys.stderr.write("[stream-upscale] 写 --json-out 失败：" + str(exc) + "\n")


def _cleanup_partial(path: str) -> None:
    try:
        if path and os.path.isfile(path):
            os.remove(path)
    except Exception:
        pass


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    out_path = os.path.abspath(args.output) if args.output else ""
    rec: dict
    try:
        if args.self_test:
            rec = run_self_test(args)
        else:
            if not args.input or not args.output:
                sys.stderr.write("[stream-upscale] 需要 --input 与 --output\n")
                return EXIT_ARGS
            rec = run_stream(args)
    except _Cancelled:
        _cleanup_partial(out_path)
        rec = {"type": "error", "ok": False, "error": "cancelled", "output": out_path}
        _emit(rec)
        _write_receipt(args.json_out, rec)
        return EXIT_CANCEL
    except KeyboardInterrupt:
        _cleanup_partial(out_path)
        rec = {"type": "error", "ok": False, "error": "cancelled", "output": out_path}
        _emit(rec)
        _write_receipt(args.json_out, rec)
        return EXIT_CANCEL
    except (torch.cuda.OutOfMemoryError, MemoryError) as exc:
        _cleanup_partial(out_path)
        rec = {"type": "error", "ok": False, "error": "oom", "message": str(exc), "output": out_path}
        _emit(rec)
        _write_receipt(args.json_out, rec)
        return EXIT_OOM
    except RuntimeError as exc:
        # 只认「显存 / 内存不足」这一族（含 Windows 的 "CUDA error: out of memory"），
        # 别的 CUDA 报错（非法访存等）不标 OOM，免得宿主的降档重试掩盖真问题。
        msg = str(exc).lower()
        oom = (
            "out of memory" in msg
            or "outofmemory" in msg
            or "insufficient memory" in msg
            or "allocation on device" in msg
            or "cublas_status_alloc_failed" in msg
            or "cudnn_status_alloc_failed" in msg
        )
        _cleanup_partial(out_path)
        rec = {"type": "error", "ok": False, "error": "oom" if oom else "failed",
               "message": str(exc), "output": out_path}
        _emit(rec)
        _write_receipt(args.json_out, rec)
        return EXIT_OOM if oom else EXIT_FAIL
    except Exception as exc:  # noqa: BLE001
        _cleanup_partial(out_path)
        rec = {"type": "error", "ok": False, "error": "failed", "message": str(exc), "output": out_path}
        _emit(rec)
        _write_receipt(args.json_out, rec)
        return EXIT_FAIL

    _emit(rec)
    _write_receipt(args.json_out, rec)
    return EXIT_OK if rec.get("ok") else EXIT_FAIL


if __name__ == "__main__":
    sys.exit(main())
