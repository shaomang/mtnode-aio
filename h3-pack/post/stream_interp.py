#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
stream_interp.py —— 逐帧流式补帧（RIFE 4.x / IFNet，纯 torch）

为什么不用 ComfyUI 图（对齐 h3/main-h3.js 的「系统内存（RAM）闸」注释口径）：
    旧链是 LoadVideo → GetVideoComponents → RIFE VFI → CreateVideo。
    GetVideoComponents 一次性把所有帧解成 IMAGE 批量张量（float32）交出去，
    ComfyUI-Frame-Interpolation 的 RIFE VFI 内部再把所有中间帧收集成列表、
    最后 torch.cat 出一整段输出帧，CreateVideo 还要再持有全片 ——
    也就是**整段视频的输入帧与输出帧同时躺在系统内存里**，
    峰值 ≈ 帧数 × 分辨率 × 通道 × 4B × 2~3 份（15s@1080p30 = 450 帧 ≈ 11GB/份，
    补 4x 后输出帧数 ×4 ≈ 45GB）—— 与显存无关，所以 64G 也会见顶、16G 根本跑不动。

本脚本换成与时长无关的流式管线：
    PyAV 顺序 decode 一帧 → 只保留「相邻两帧」→ 逐对算出中间帧 → 每帧立刻编码写盘
    → 丢掉这一帧的张量。
    常驻内存只与「两帧源图 + 模型 + 若干待写盘的中间帧」有关，与视频多长无关；
    音轨用 PyAV 从源文件原样直拷（不重编码）。16G 内存机器也能跑 15 秒级 2x/4x 补帧。

网络来源：ComfyUI-Frame-Interpolation/ckpts/rife/rife47.pth（本机已装）等 RIFE 4.x 权重。
本脚本用纯 torch 逐键复刻 IFNet（ResConv / ResidualDenseBlock 无关，PReLU 与 LeakyReLU
两族都实现），weights_only=True 直载 state_dict；**绝不 import 任何 rife / 官方包**
（venv 里也没有），架构按 state_dict 键名判定，判不出来就退出码 2 交宿主回退图路径。

依赖只用 ComfyUI venv 里已有的 torch / av / numpy / cv2 / psutil（零新增依赖）。

CLI：
    python stream_interp.py --input in.mp4 --output out.mp4 --model <rife47.pth>
        [--multiplier 2|4] [--max-long-side 0] [--precision auto|fp16|fp32]
        [--device auto|cuda|cpu] [--scale-factor 1.0] [--ensemble] [--fast-mode]
        [--crf 17] [--preset medium] [--fps N] [--clear-cache-every 10]
        [--progress-every N] [--json-out FILE] [--quiet]
    python stream_interp.py --self-test [--json-out FILE]   # 无 GPU / 无权重也能跑通整链

--model 省略时按 --weights-dir / --comfy-root / 环境变量 MTNODE_COMFY_ROOT 自动探测
custom_nodes/ComfyUI-Frame-Interpolation/ckpts/rife/rife*.pth（优先 rife49 > rife47 >
rife417 > rife426）。

输出帧率：省略 --fps 时 = 源帧率 × 倍数（时长与播放速度不变，只是更顺滑）；
显式给 --fps 则按给定值封装。输出分辨率与源一致（给 --max-long-side 才预先缩放）。

stdout 只打换行分隔 JSON：meta / progress / done / error。
stdin 收到 cancel（或 stop / quit / abort）、或收到 SIGINT / SIGTERM 时中断并清理半成品。

退出码：0 成功 · 1 一般失败 · 2 参数错误 / 权重或架构无法识别 · 3 显存/内存不足（可降档重试）· 4 已取消。
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
import torch
import torch.nn as nn
import torch.nn.functional as F

# ── 退出码（宿主据此选路：3 = OOM 可降档重试，4 = 用户取消） ──────────────────────
EXIT_OK = 0
EXIT_FAIL = 1
EXIT_ARGS = 2
EXIT_OOM = 3
EXIT_CANCEL = 4

# ── 默认档位 ─────────────────────────────────────────────────────────────────
DEFAULT_MULTIPLIER = 2
DEFAULT_CRF = 17
DEFAULT_PRESET = "medium"
DEFAULT_SCALE_FACTOR = 1.0
DEFAULT_CLEAR_CACHE_EVERY = 10

# 本脚本能逐键复刻的 RIFE 架构版本（按 state_dict 键名判定，见 detect_arch）
SUPPORTED_ARCHS = ("4.0", "4.2", "4.3", "4.5", "4.6", "4.7", "4.10", "4.17", "4.26")


# ════════════════════════════════════════════════════════════════════════════
# RIFE / IFNet：纯 torch 逐键复刻（与 ComfyUI-Frame-Interpolation 的
#   vfi_models/rife/rife_arch.py 结构一一对应，只去掉 comfy 依赖与训练态无用分支）
#   4.0 族：conv() 尾接 PReLU，convblock 为 8 层普通 conv，末层 ConvTranspose2d(c,5)
#           （另带 Contextnet / Unet，仅 fastmode=False 时用到）
#   4.2/4.3：同上但活动层为 LeakyReLU（无参数）
#   4.5+ 族：convblock 为 8 层 ResConv（conv*beta + x 残差）
#           lastconv = ConvTranspose2d(c, 4*K) + PixelShuffle(2)，K=5(4.5) / 6(4.6/4.7/4.10/4.17) / 13(4.26)
#   4.7+ 族：block0/1/2/3 入通道各多 8（f0/f1 各 4 通道的编码特征），需 encode 子网
# ════════════════════════════════════════════════════════════════════════════
class ResConv(nn.Module):
    """4.5+ 的残差卷积块：LeakyReLU(conv(x) * beta + x)，beta 为可学习缩放。"""

    def __init__(self, c: int, dilation: int = 1) -> None:
        super().__init__()
        self.conv = nn.Conv2d(c, c, 3, 1, dilation, dilation=dilation, groups=1)
        self.beta = nn.Parameter(torch.ones((1, c, 1, 1)), requires_grad=True)
        self.relu = nn.LeakyReLU(0.2, True)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.relu(self.conv(x) * self.beta + x)


def conv(in_planes: int, out_planes: int, kernel_size: int = 3, stride: int = 1,
         padding: int = 1, dilation: int = 1, arch_ver: str = "4.0") -> nn.Sequential:
    """Conv2d + 活动层：4.0 用 PReLU（带权重），4.2+ 用 LeakyReLU（无参数）。"""
    layer = nn.Conv2d(in_planes, out_planes, kernel_size=kernel_size, stride=stride,
                      padding=padding, dilation=dilation, bias=True)
    if arch_ver == "4.0":
        return nn.Sequential(layer, nn.PReLU(out_planes))
    return nn.Sequential(layer, nn.LeakyReLU(0.2, True))


def deconv(in_planes: int, out_planes: int, kernel_size: int = 4, stride: int = 2,
           padding: int = 1, arch_ver: str = "4.0") -> nn.Sequential:
    layer = nn.ConvTranspose2d(in_channels=in_planes, out_channels=out_planes,
                               kernel_size=kernel_size, stride=stride, padding=padding, bias=True)
    if arch_ver == "4.0":
        return nn.Sequential(layer, nn.PReLU(out_planes))
    return nn.Sequential(layer, nn.LeakyReLU(0.2, True))


class Conv2(nn.Module):
    def __init__(self, in_planes: int, out_planes: int, stride: int = 2, arch_ver: str = "4.0") -> None:
        super().__init__()
        self.conv1 = conv(in_planes, out_planes, 3, stride, 1, arch_ver=arch_ver)
        self.conv2 = conv(out_planes, out_planes, 3, 1, 1, arch_ver=arch_ver)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.conv2(self.conv1(x))


class IFBlock(nn.Module):
    """多尺度光流块：先把输入按 1/scale 下采样，再逐层提特征，末层上采样回原尺度出 4 通道流 + 1 通道掩膜。"""

    def __init__(self, in_planes: int, c: int = 64, arch_ver: str = "4.0") -> None:
        super().__init__()
        self.arch_ver = arch_ver
        self.conv0 = nn.Sequential(
            conv(in_planes, c // 2, 3, 2, 1, arch_ver=arch_ver),
            conv(c // 2, c, 3, 2, 1, arch_ver=arch_ver),
        )
        if arch_ver in ("4.0", "4.2", "4.3"):
            self.convblock = nn.Sequential(
                conv(c, c, arch_ver=arch_ver), conv(c, c, arch_ver=arch_ver),
                conv(c, c, arch_ver=arch_ver), conv(c, c, arch_ver=arch_ver),
                conv(c, c, arch_ver=arch_ver), conv(c, c, arch_ver=arch_ver),
                conv(c, c, arch_ver=arch_ver), conv(c, c, arch_ver=arch_ver),
            )
            self.lastconv = nn.ConvTranspose2d(c, 5, 4, 2, 1)
        else:
            self.convblock = nn.Sequential(
                ResConv(c), ResConv(c), ResConv(c), ResConv(c),
                ResConv(c), ResConv(c), ResConv(c), ResConv(c),
            )
            if arch_ver == "4.5":
                self.lastconv = nn.Sequential(nn.ConvTranspose2d(c, 4 * 5, 4, 2, 1), nn.PixelShuffle(2))
            elif arch_ver == "4.26":
                self.lastconv = nn.Sequential(nn.ConvTranspose2d(c, 4 * 13, 4, 2, 1), nn.PixelShuffle(2))
            else:
                self.lastconv = nn.Sequential(nn.ConvTranspose2d(c, 4 * 6, 4, 2, 1), nn.PixelShuffle(2))

    def forward(self, x: torch.Tensor, flow: torch.Tensor | None = None, scale: float = 1):
        x = F.interpolate(x, scale_factor=1.0 / scale, mode="bilinear", align_corners=False)
        if flow is not None:
            flow = F.interpolate(flow, scale_factor=1.0 / scale, mode="bilinear", align_corners=False) * 1.0 / scale
            x = torch.cat((x, flow), 1)
        feat = self.conv0(x)
        if self.arch_ver == "4.0":
            feat = self.convblock(feat) + feat
        else:
            feat = self.convblock(feat)
        tmp = self.lastconv(feat)
        if self.arch_ver in ("4.0", "4.2", "4.3"):
            tmp = F.interpolate(tmp, scale_factor=scale * 2, mode="bilinear", align_corners=False)
            flow = tmp[:, :4] * scale * 2
        elif self.arch_ver == "4.26":
            tmp = F.interpolate(tmp, scale_factor=scale, mode="bilinear", align_corners=False)
            flow = tmp[:, :4] * scale
            mask = tmp[:, 4:5]
            feat_out = tmp[:, 5:]
            return flow, mask, feat_out
        else:
            tmp = F.interpolate(tmp, scale_factor=scale, mode="bilinear", align_corners=False)
            flow = tmp[:, :4] * scale
        mask = tmp[:, 4:5]
        return flow, mask


class Contextnet(nn.Module):
    """仅 4.0/4.2/4.3 且 fastmode=False 时使用（多尺度上下文特征）。"""

    def __init__(self, arch_ver: str = "4.0") -> None:
        super().__init__()
        c = 16
        self.conv1 = Conv2(3, c, arch_ver=arch_ver)
        self.conv2 = Conv2(c, 2 * c, arch_ver=arch_ver)
        self.conv3 = Conv2(2 * c, 4 * c, arch_ver=arch_ver)
        self.conv4 = Conv2(4 * c, 8 * c, arch_ver=arch_ver)

    def forward(self, x: torch.Tensor, flow: torch.Tensor) -> list:
        x = self.conv1(x)
        flow = F.interpolate(flow, scale_factor=0.5, mode="bilinear", align_corners=False) * 0.5
        f1 = warp(x, flow)
        x = self.conv2(x)
        flow = F.interpolate(flow, scale_factor=0.5, mode="bilinear", align_corners=False) * 0.5
        f2 = warp(x, flow)
        x = self.conv3(x)
        flow = F.interpolate(flow, scale_factor=0.5, mode="bilinear", align_corners=False) * 0.5
        f3 = warp(x, flow)
        x = self.conv4(x)
        flow = F.interpolate(flow, scale_factor=0.5, mode="bilinear", align_corners=False) * 0.5
        f4 = warp(x, flow)
        return [f1, f2, f3, f4]


class Unet(nn.Module):
    """仅 4.0/4.2/4.3 且 fastmode=False 时使用（融合残差）。"""

    def __init__(self, arch_ver: str = "4.0") -> None:
        super().__init__()
        c = 16
        self.down0 = Conv2(17, 2 * c, arch_ver=arch_ver)
        self.down1 = Conv2(4 * c, 4 * c, arch_ver=arch_ver)
        self.down2 = Conv2(8 * c, 8 * c, arch_ver=arch_ver)
        self.down3 = Conv2(16 * c, 16 * c, arch_ver=arch_ver)
        self.up0 = deconv(32 * c, 8 * c, arch_ver=arch_ver)
        self.up1 = deconv(16 * c, 4 * c, arch_ver=arch_ver)
        self.up2 = deconv(8 * c, 2 * c, arch_ver=arch_ver)
        self.up3 = deconv(4 * c, c, arch_ver=arch_ver)
        self.conv = nn.Conv2d(c, 3, 3, 1, 1)

    def forward(self, img0, img1, warped_img0, warped_img1, mask, flow, c0, c1):
        s0 = self.down0(torch.cat((img0, img1, warped_img0, warped_img1, mask, flow), 1))
        s1 = self.down1(torch.cat((s0, c0[0], c1[0]), 1))
        s2 = self.down2(torch.cat((s1, c0[1], c1[1]), 1))
        s3 = self.down3(torch.cat((s2, c0[2], c1[2]), 1))
        x = self.up0(torch.cat((s3, c0[3], c1[3]), 1))
        x = self.up1(torch.cat((x, s2), 1))
        x = self.up2(torch.cat((x, s1), 1))
        x = self.up3(torch.cat((x, s0), 1))
        return torch.sigmoid(self.conv(x))


class Head(nn.Module):
    """4.26 的编码头（8 通道特征）。"""

    def __init__(self) -> None:
        super().__init__()
        self.cnn0 = nn.Conv2d(3, 16, 3, 2, 1)
        self.cnn1 = nn.Conv2d(16, 16, 3, 1, 1)
        self.cnn2 = nn.Conv2d(16, 16, 3, 1, 1)
        self.cnn3 = nn.ConvTranspose2d(16, 4, 4, 2, 1)
        self.relu = nn.LeakyReLU(0.2, True)

    def forward(self, x: torch.Tensor, feat: bool = False):
        x0 = self.cnn0(x)
        x = self.relu(x0)
        x1 = self.cnn1(x)
        x = self.relu(x1)
        x2 = self.cnn2(x)
        x = self.relu(x2)
        x3 = self.cnn3(x)
        return [x0, x1, x2, x3] if feat else x3


class Head_417(nn.Module):
    """4.17 的编码头（8 通道特征，32 通道中间层）。"""

    def __init__(self) -> None:
        super().__init__()
        self.cnn0 = nn.Conv2d(3, 32, 3, 2, 1)
        self.cnn1 = nn.Conv2d(32, 32, 3, 1, 1)
        self.cnn2 = nn.Conv2d(32, 32, 3, 1, 1)
        self.cnn3 = nn.ConvTranspose2d(32, 8, 4, 2, 1)
        self.relu = nn.LeakyReLU(0.2, True)

    def forward(self, x: torch.Tensor, feat: bool = False):
        x0 = self.cnn0(x)
        x = self.relu(x0)
        x1 = self.cnn1(x)
        x = self.relu(x1)
        x2 = self.cnn2(x)
        x = self.relu(x2)
        x3 = self.cnn3(x)
        return [x0, x1, x2, x3] if feat else x3


_GRID_CACHE: dict = {}


def warp(tenInput: torch.Tensor, tenFlow: torch.Tensor) -> torch.Tensor:
    """按光流做双线性反向采样（border 填充，align_corners=True），网格按设备+尺寸缓存。"""
    key = (str(tenFlow.device), tuple(tenFlow.shape))
    grid = _GRID_CACHE.get(key)
    if grid is None:
        flow_h, flow_w = tenFlow.shape[2], tenFlow.shape[3]
        ten_horizontal = (
            torch.linspace(-1.0, 1.0, flow_w, device=tenFlow.device)
            .view(1, 1, 1, flow_w)
            .expand(tenFlow.shape[0], -1, flow_h, -1)
        )
        ten_vertical = (
            torch.linspace(-1.0, 1.0, flow_h, device=tenFlow.device)
            .view(1, 1, flow_h, 1)
            .expand(tenFlow.shape[0], -1, -1, flow_w)
        )
        grid = torch.cat([ten_horizontal, ten_vertical], 1)
        _GRID_CACHE[key] = grid

    tenFlow = torch.cat(
        [
            tenFlow[:, 0:1, :, :] / ((tenInput.shape[3] - 1.0) / 2.0),
            tenFlow[:, 1:2, :, :] / ((tenInput.shape[2] - 1.0) / 2.0),
        ],
        1,
    )
    g = (grid + tenFlow).permute(0, 2, 3, 1)
    if g.dtype != tenInput.dtype:
        g = g.to(tenInput.dtype)
    padding_mode = "border"
    if tenFlow.device.type == "mps":  # https://github.com/pytorch/pytorch/issues/125098
        padding_mode = "zeros"
        g = g.clamp(-1, 1)
    return F.grid_sample(input=tenInput, grid=g, mode="bilinear",
                         padding_mode=padding_mode, align_corners=True)


class IFNet(nn.Module):
    """RIFE 光流插帧网络（多尺度 4 块，4.26 为 5 块）。"""

    def __init__(self, arch_ver: str = "4.0") -> None:
        super().__init__()
        self.arch_ver = arch_ver
        if arch_ver in ("4.0", "4.2", "4.3", "4.5", "4.6"):
            self.block0 = IFBlock(7, c=192, arch_ver=arch_ver)
            self.block1 = IFBlock(12, c=128, arch_ver=arch_ver)
            self.block2 = IFBlock(12, c=96, arch_ver=arch_ver)
            self.block3 = IFBlock(12, c=64, arch_ver=arch_ver)
        elif arch_ver == "4.7":
            self.block0 = IFBlock(7 + 8, c=192, arch_ver=arch_ver)
            self.block1 = IFBlock(8 + 4 + 8, c=128, arch_ver=arch_ver)
            self.block2 = IFBlock(8 + 4 + 8, c=96, arch_ver=arch_ver)
            self.block3 = IFBlock(8 + 4 + 8, c=64, arch_ver=arch_ver)
            self.encode = nn.Sequential(
                nn.Conv2d(3, 16, 3, 2, 1), nn.ConvTranspose2d(16, 4, 4, 2, 1)
            )
        elif arch_ver == "4.10":
            self.block0 = IFBlock(7 + 16, c=192, arch_ver=arch_ver)
            self.block1 = IFBlock(8 + 4 + 16, c=128, arch_ver=arch_ver)
            self.block2 = IFBlock(8 + 4 + 16, c=96, arch_ver=arch_ver)
            self.block3 = IFBlock(8 + 4 + 16, c=64, arch_ver=arch_ver)
            self.encode = nn.Sequential(
                nn.Conv2d(3, 32, 3, 2, 1),
                nn.LeakyReLU(0.2, True),
                nn.Conv2d(32, 32, 3, 1, 1),
                nn.LeakyReLU(0.2, True),
                nn.Conv2d(32, 32, 3, 1, 1),
                nn.LeakyReLU(0.2, True),
                nn.ConvTranspose2d(32, 8, 4, 2, 1),
            )
        elif arch_ver == "4.17":
            self.block0 = IFBlock(7 + 16, c=192, arch_ver=arch_ver)
            self.block1 = IFBlock(8 + 4 + 16, c=128, arch_ver=arch_ver)
            self.block2 = IFBlock(8 + 4 + 16, c=96, arch_ver=arch_ver)
            self.block3 = IFBlock(8 + 4 + 16, c=64, arch_ver=arch_ver)
            self.encode = Head_417()
        elif arch_ver == "4.26":
            self.block0 = IFBlock(7 + 8, c=192, arch_ver=arch_ver)
            self.block1 = IFBlock(8 + 4 + 8 + 8, c=128, arch_ver=arch_ver)
            self.block2 = IFBlock(8 + 4 + 8 + 8, c=96, arch_ver=arch_ver)
            self.block3 = IFBlock(8 + 4 + 8 + 8, c=64, arch_ver=arch_ver)
            self.block4 = IFBlock(8 + 4 + 8 + 8, c=32, arch_ver=arch_ver)
            self.encode = Head()
        else:
            raise ValueError("不支持的 RIFE 架构版本：" + str(arch_ver))

        if arch_ver in ("4.0", "4.2", "4.3"):
            self.contextnet = Contextnet(arch_ver=arch_ver)
            self.unet = Unet(arch_ver=arch_ver)

    def forward(
        self,
        img0: torch.Tensor,
        img1: torch.Tensor,
        timestep: float | torch.Tensor = 0.5,
        scale_list: list = None,
        training: bool = True,
        fastmode: bool = True,
        ensemble: bool = False,
        return_flow: bool = False,
    ) -> torch.Tensor:
        arch = self.arch_ver
        # 原实现直接用可变默认参数 scale_list 并在 4.0 自适应分支里就地翻倍 —— 这里复制一份，
        # 避免调用之间互相污染（本 CLI 恒以推理态调用，行为与参考实现一致）。
        scale_list = list(scale_list) if scale_list is not None else (
            [16, 8, 4, 2, 1] if arch == "4.26" else [8, 4, 2, 1]
        )

        img0 = torch.clamp(img0, 0, 1)
        img1 = torch.clamp(img1, 0, 1)

        n, c, h, w = img0.shape
        ph = ((h - 1) // 64 + 1) * 64
        pw = ((w - 1) // 64 + 1) * 64
        padding = (0, pw - w, 0, ph - h)
        img0 = F.pad(img0, padding)
        img1 = F.pad(img1, padding)
        x = torch.cat((img0, img1), 1)

        if training is False:
            channel = x.shape[1] // 2
            img0 = x[:, :channel]
            img1 = x[:, channel:]
        if not torch.is_tensor(timestep):
            timestep = (x[:, :1].clone() * 0 + 1) * timestep
        else:
            timestep = timestep.repeat(1, 1, img0.shape[2], img0.shape[3])

        flow_list = []
        merged = []
        mask_list = []

        if arch in ("4.7", "4.10", "4.17", "4.26"):
            f0 = self.encode(img0[:, :3])
            f1 = self.encode(img1[:, :3])

        warped_img0 = img0
        warped_img1 = img1
        flow = None
        mask = None
        feat = None

        if arch == "4.26":
            block = [self.block0, self.block1, self.block2, self.block3, self.block4]
            num_blocks = 5
        else:
            block = [self.block0, self.block1, self.block2, self.block3]
            num_blocks = 4

        for i in range(num_blocks):
            if flow is None:
                if arch == "4.26":
                    flow, mask, feat = block[i](
                        torch.cat((img0[:, :3], img1[:, :3], f0, f1, timestep), 1), None, scale=scale_list[i]
                    )
                elif arch in ("4.0", "4.2", "4.3", "4.5", "4.6"):
                    flow, mask = block[i](
                        torch.cat((img0[:, :3], img1[:, :3], timestep), 1), None, scale=scale_list[i]
                    )
                    if ensemble:
                        f_1, m_1 = block[i](
                            torch.cat((img1[:, :3], img0[:, :3], 1 - timestep), 1), None, scale=scale_list[i]
                        )
                        flow = (flow + torch.cat((f_1[:, 2:4], f_1[:, :2]), 1)) / 2
                        mask = (mask + (-m_1)) / 2
                if arch in ("4.7", "4.10", "4.17"):
                    flow, mask = block[i](
                        torch.cat((img0[:, :3], img1[:, :3], f0, f1, timestep), 1), None, scale=scale_list[i]
                    )
                    if ensemble:
                        f_, m_ = block[i](
                            torch.cat((img1[:, :3], img0[:, :3], f1, f0, 1 - timestep), 1),
                            None, scale=scale_list[i],
                        )
                        flow = (flow + torch.cat((f_[:, 2:4], f_[:, :2]), 1)) / 2
                        mask = (mask + (-m_)) / 2
            else:
                if arch == "4.26":
                    wf0 = warp(f0, flow[:, :2])
                    wf1 = warp(f1, flow[:, 2:4])
                    input_tensor = torch.cat(
                        (warped_img0[:, :3], warped_img1[:, :3], wf0, wf1, timestep, mask, feat), 1
                    )
                    fd, m0, feat = block[i](input_tensor, flow, scale=scale_list[i])
                    flow = flow + fd
                    mask = m0
                elif arch in ("4.0", "4.2", "4.3", "4.5", "4.6"):
                    f0, m0 = block[i](
                        torch.cat((warped_img0[:, :3], warped_img1[:, :3], timestep, mask), 1),
                        flow, scale=scale_list[i],
                    )
                if arch == "4.0":
                    if (i == 1 and f0[:, :2].abs().max() > 32 and f0[:, 2:4].abs().max() > 32
                            and not training):
                        for k in range(4):
                            scale_list[k] *= 2
                        flow, mask = block[0](
                            torch.cat((img0[:, :3], img1[:, :3], timestep), 1), None, scale=scale_list[0]
                        )
                        warped_img0 = warp(img0, flow[:, :2])
                        warped_img1 = warp(img1, flow[:, 2:4])
                        f0, m0 = block[i](
                            torch.cat((warped_img0[:, :3], warped_img1[:, :3], timestep, mask), 1),
                            flow, scale=scale_list[i],
                        )
                if arch in ("4.7", "4.10", "4.17"):
                    fd, m0 = block[i](
                        torch.cat(
                            (warped_img0[:, :3], warped_img1[:, :3],
                             warp(f0, flow[:, :2]), warp(f1, flow[:, 2:4]),
                             timestep, mask), 1,
                        ),
                        flow, scale=scale_list[i],
                    )
                    flow = flow + fd
                if ensemble and arch in ("4.0", "4.2", "4.3", "4.5", "4.6"):
                    f_1, m_1 = block[i](
                        torch.cat((warped_img1[:, :3], warped_img0[:, :3], 1 - timestep, -mask), 1),
                        torch.cat((flow[:, 2:4], flow[:, :2]), 1), scale=scale_list[i],
                    )
                    f0 = (f0 + torch.cat((f_1[:, 2:4], f_1[:, :2]), 1)) / 2
                    m0 = (m0 + (-m_1)) / 2
                if ensemble and arch in ("4.7", "4.10", "4.17"):
                    wf0 = warp(f0, flow[:, :2])
                    wf1 = warp(f1, flow[:, 2:4])
                    f_, m_ = block[i](
                        torch.cat((warped_img1[:, :3], warped_img0[:, :3], wf1, wf0, 1 - timestep, -mask), 1),
                        torch.cat((flow[:, 2:4], flow[:, :2]), 1), scale=scale_list[i],
                    )
                    fd = (fd + torch.cat((f_[:, 2:4], f_[:, :2]), 1)) / 2
                    mask = (m0 + (-m_)) / 2
                if arch in ("4.0", "4.2", "4.3", "4.5", "4.6"):
                    flow = flow + f0
                    mask = mask + m0
                if not ensemble and arch in ("4.7", "4.10", "4.17"):
                    mask = m0

            mask_list.append(mask)
            flow_list.append(flow)
            warped_img0 = warp(img0, flow[:, :2])
            warped_img1 = warp(img1, flow[:, 2:4])
            merged.append((warped_img0, warped_img1))

        if arch == "4.26":
            final_mask = mask_list[-1] if mask_list else mask
            final_mask = torch.sigmoid(final_mask)
            merged_final = warped_img0 * final_mask + warped_img1 * (1 - final_mask)
        else:
            if arch in ("4.0", "4.2", "4.3", "4.5", "4.6"):
                final_idx = min(3, len(mask_list) - 1) if len(mask_list) > 0 else 0
                if final_idx < len(mask_list):
                    mask_list[final_idx] = torch.sigmoid(mask_list[final_idx])
                    merged_final = (merged[final_idx][0] * mask_list[final_idx]
                                    + merged[final_idx][1] * (1 - mask_list[final_idx]))
                else:
                    mask = torch.sigmoid(mask)
                    merged_final = warped_img0 * mask + warped_img1 * (1 - mask)
            if arch in ("4.7", "4.10", "4.17"):
                mask = torch.sigmoid(mask)
                merged_final = warped_img0 * mask + warped_img1 * (1 - mask)

        if not fastmode and arch in ("4.0", "4.2", "4.3"):
            c0 = self.contextnet(img0, flow[:, :2])
            c1 = self.contextnet(img1, flow[:, 2:4])
            tmp = self.unet(img0, img1, warped_img0, warped_img1, mask, flow, c0, c1)
            res = tmp[:, :3] * 2 - 1
            merged_final = torch.clamp(merged_final + res, 0, 1)

        return merged_final[:, :, :h, :w]


# ════════════════════════════════════════════════════════════════════════════
# 架构判定 + 权重加载
# ════════════════════════════════════════════════════════════════════════════
def _strip_state_dict(obj):
    """权重文件顶层常见 params_ema / params / state_dict 包一层 —— 逐层剥到真正的参数表。"""
    if not isinstance(obj, dict):
        return obj
    for key in ("params_ema", "params", "state_dict"):
        inner = obj.get(key)
        if isinstance(inner, dict):
            return inner
    return obj


def detect_arch(state: dict) -> str:
    """按 state_dict 键名判定 RIFE 版本；判不出来抛 ValueError（宿主据此回退图路径）。"""
    if not isinstance(state, dict) or not state:
        raise ValueError("权重文件里读不出参数表")
    keys = set(state.keys())

    def out_channels(name: str) -> int:
        tensor = state.get(name)
        shape = getattr(tensor, "shape", None)
        return int(shape[0]) if shape is not None else -1

    # 4.26：多一个 block4
    if "block4.conv0.0.0.weight" in keys:
        return "4.26"
    # 4.17：Head_417（encode.cnn0，32 通道中间层）
    if "encode.cnn0.weight" in keys:
        return "4.17"
    # 4.10：encode 是 7 层 Sequential（第 6 项 ConvTranspose2d）
    if "encode.6.weight" in keys:
        return "4.10"
    # 4.7 / 4.9：encode 只有一层 Conv2d(3,16) + ConvTranspose2d(16,4)
    if "encode.0.weight" in keys:
        return "4.7"
    # 4.0 / 4.2 / 4.3：lastconv 是裸 ConvTranspose2d(c,5)（无 PixelShuffle 外包）
    if "block0.lastconv.weight" in keys:
        # 4.0 的 convblock 用 PReLU（带 weight），4.2/4.3 用 LeakyReLU（无参数）
        if "block0.convblock.0.1.weight" in keys:
            return "4.0"
        return "4.2"
    # 4.5 / 4.6：lastconv = Sequential(ConvTranspose2d(c, 4*K), PixelShuffle(2))
    lastconv_out = out_channels("block0.lastconv.0.weight")
    if lastconv_out == 4 * 5:
        return "4.5"
    if lastconv_out == 4 * 6:
        return "4.6"
    raise ValueError("无法识别的 RIFE 架构（state_dict 键名不在支持的版本内：" + ", ".join(SUPPORTED_ARCHS) + "）")


def build_model(model_path: str | None, arch_ver: str, device: torch.device, dtype: torch.dtype,
                allow_random: bool = False) -> tuple[IFNet, str]:
    """按 ref_arch 建网并 weights_only=True 严格加载；返回 (net, 架构版本)。"""
    state = None
    if model_path:
        if not os.path.isfile(model_path):
            raise FileNotFoundError("权重不存在：" + model_path)
        state = _strip_state_dict(torch.load(model_path, map_location="cpu", weights_only=True))
        if not isinstance(state, dict) or not state:
            raise RuntimeError("权重文件读不出参数表：" + model_path)
        if arch_ver in (None, "", "auto"):
            arch_ver = detect_arch(state)
    elif not allow_random:
        raise RuntimeError("缺少 --model（可加 --allow-random-weights 仅供自检）")

    if arch_ver in (None, "", "auto"):
        raise ValueError("没有权重可判定架构，且未显式给 --arch")

    net = IFNet(arch_ver=arch_ver)
    if isinstance(state, dict):
        try:
            net.load_state_dict(state, strict=True)
        except RuntimeError as exc:
            raise RuntimeError(
                "权重与本脚本复刻的 IFNet(" + str(arch_ver) + ") 结构不匹配：" + str(exc)
            ) from exc
    net.eval()
    net = net.to(device)
    if dtype == torch.float16:
        net = net.half()
    return net, str(arch_ver)


# ── 本机权重自动探测（宿主通常会显式给 --model，这里只作兜底） ────────────────────
RIFE_WEIGHT_PREFERENCE = ("rife49.pth", "rife47.pth", "rife417.pth", "rife426.pth")


def _rife_dirs(args) -> list:
    dirs = []
    if args.weights_dir:
        dirs.append(os.path.abspath(args.weights_dir))
    roots = []
    if args.comfy_root:
        roots.append(os.path.abspath(args.comfy_root))
    env_root = os.environ.get("MTNODE_COMFY_ROOT") or os.environ.get("H3_COMFY_ROOT")
    if env_root:
        roots.append(os.path.abspath(env_root))
    for root in roots:
        dirs.append(os.path.join(root, "custom_nodes", "ComfyUI-Frame-Interpolation", "ckpts", "rife"))
        dirs.append(os.path.join(root, "ckpts", "rife"))
    # 去重保序
    seen = set()
    out = []
    for d in dirs:
        if d not in seen:
            seen.add(d)
            out.append(d)
    return out


def discover_weights(args) -> tuple[str, list]:
    """返回 (命中的权重路径或 None, 搜过的目录清单)。优先官方文件名，其次目录内 rife*.pth 排序。"""
    searched = _rife_dirs(args)
    for d in searched:
        if not os.path.isdir(d):
            continue
        for name in RIFE_WEIGHT_PREFERENCE:
            cand = os.path.join(d, name)
            if os.path.isfile(cand):
                return cand, searched
    for d in searched:
        if not os.path.isdir(d):
            continue
        try:
            names = sorted(n for n in os.listdir(d) if n.lower().startswith("rife") and n.lower().endswith(".pth"))
        except Exception:
            continue
        if names:
            return os.path.join(d, names[0]), searched
    return None, searched


def resolve_weights(args, allow_random: bool = False) -> tuple[str | None, str, list]:
    """确定权重路径与架构：显式 --model 优先，否则自动探测；返回 (path|None, arch|auto, 搜索目录)。"""
    if args.model:
        path = os.path.abspath(args.model)
        if not os.path.isfile(path):
            raise FileNotFoundError("--model 指向的文件不存在：" + path)
        return path, (args.arch or "auto"), []
    path, searched = discover_weights(args)
    if not path:
        if allow_random:
            # 自检口径：没有权重就用随机初始化，架构必须显式（默认本机常见的 4.7）
            return None, (args.arch if args.arch and args.arch != "auto" else "4.7"), searched
        raise FileNotFoundError(
            "找不到本机已装的 RIFE 权重（rife*.pth）。已搜索：" + ("; ".join(searched) or "（无候选目录，可给 --comfy-root 或 --model）")
        )
    return path, (args.arch or "auto"), searched


def resolve_scale_list(arch_ver: str, scale_factor: float) -> list:
    """与 ComfyUI 节点口径一致：4.26 五档 [16,8,4,2,1]，其余四档 [8,4,2,1]，按 scale_factor 归一。"""
    sf = float(scale_factor) or 1.0
    if arch_ver == "4.26":
        return [16 / sf, 8 / sf, 4 / sf, 2 / sf, 1 / sf]
    return [8 / sf, 4 / sf, 2 / sf, 1 / sf]


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
# 帧互转 / 预缩放
# ════════════════════════════════════════════════════════════════════════════
def frame_to_tensor(rgb: np.ndarray, device: torch.device, dtype: torch.dtype) -> torch.Tensor:
    """uint8 HxWx3 → float32 1x3xHxW（0~1），按需降精度并送设备。"""
    arr = np.ascontiguousarray(rgb[:, :, :3])
    t = torch.from_numpy(arr).permute(2, 0, 1).unsqueeze(0).float().div_(255.0)
    return t.to(device=device, dtype=dtype)


def tensor_to_rgb(t: torch.Tensor) -> np.ndarray:
    """1x3xHxW（任意精度）→ uint8 HxWx3，值域夹到 0~1。"""
    arr = t[0].float().clamp(0.0, 1.0).permute(1, 2, 0).cpu().numpy()
    return (arr * 255.0 + 0.5).astype(np.uint8)


def even_dims(width: int, height: int) -> tuple[int, int]:
    """yuv420p / libx264 要求偶数边长；奇数时裁掉最后一行/列（补帧不改分辨率的口径）。"""
    return max(2, int(width) - (int(width) % 2)), max(2, int(height) - (int(height) % 2))


def prescale_to_long_side(rgb: np.ndarray, long_side: int) -> np.ndarray:
    """仅在显式给 --max-long-side 时调用：INTER_AREA 预缩放（取偶），进一步省显存。"""
    if not long_side or int(long_side) <= 0:
        return rgb
    import cv2  # noqa: PLC0415

    h, w = int(rgb.shape[0]), int(rgb.shape[1])
    long = max(h, w)
    if long <= int(long_side):
        return rgb
    s = float(long_side) / float(long)
    tw = max(2, int(round(w * s / 2.0)) * 2)
    th = max(2, int(round(h * s / 2.0)) * 2)
    return cv2.resize(rgb, (tw, th), interpolation=cv2.INTER_AREA)


# ════════════════════════════════════════════════════════════════════════════
# 单次插值 + 逐对中间帧（生成器：同一时刻最多持有「两帧源图 + 一张中间帧」）
# ════════════════════════════════════════════════════════════════════════════
def interp_middle_tensor(net: IFNet, f0: torch.Tensor, f1: torch.Tensor, timestep: float, ctx: dict) -> torch.Tensor:
    """一对待插帧 + 时间步 → 中间帧张量（1x3xHxW / ctx.dtype，值域约 0~1）。

    留在张量域是为了 multiplier=4 的递归插值：第二轮要拿第一轮的中点当输入，
    先量化成 uint8 再转回张量会白白丢精度（参考实现全程用 float 张量）。
    """
    ts = torch.full((1, 1, 1, 1), float(timestep), dtype=ctx["dtype"], device=ctx["device"])
    with torch.inference_mode():
        return net(
            f0, f1, ts, ctx["scale_list"],
            False,                      # training：推理态（会走 img0/img1 重取分支，结果等价）
            bool(ctx["fastmode"]),      # fastmode：True = 跳过 4.0 族的 contextnet/unet
            bool(ctx["ensemble"]),      # ensemble：双向平均，质量更好、算力翻倍
        )


def interp_once(net: IFNet, f0: torch.Tensor, f1: torch.Tensor, timestep: float, ctx: dict) -> np.ndarray:
    """一对待插帧 + 时间步 → 一张中间帧（uint8 HxWx3）。

    张量到 numpy 的转换放在 inference_mode 块内部 —— inference 标记的张量逃出块之后
    任何后续操作都可能被 torch 拒绝（超分脚本踩过「Inplace update to inference tensor」），
    在块内一次转成 numpy 就彻底绕开这类陷阱。
    """
    with torch.inference_mode():
        return tensor_to_rgb(interp_middle_tensor(net, f0, f1, timestep, ctx))


def iter_middles(net: IFNet, f0: torch.Tensor, f1: torch.Tensor, multiplier: int, ctx: dict):
    """按 multiplier 逐张产出中间帧（顺序即最终时间顺序）。

    multiplier 2 → 每对插 1 张（t=0.5）；
    multiplier 4 → 连续两轮插值（t=0.5 定住中点，再对两半各插一次 → t=0.25 / 0.5 / 0.75），
                   与 Practical-RIFE 的 non_timestep_inference 递归口径一致；
    其它倍数（如 3）用直接时间步 i/multiplier —— 递归口径在非 2 的幂次上不成立。
    """
    m = int(multiplier)
    if m <= 1:
        return
    if m == 4:
        yield from _recursive_middles(net, f0, f1, 3, ctx)
        return
    for i in range(1, m):
        yield interp_once(net, f0, f1, i / float(m), ctx)


def _recursive_middles(net: IFNet, a: torch.Tensor, b: torch.Tensor, n: int, ctx: dict):
    # 递归全程在张量域（numpy 帧绝不是合法的网络输入：会出现
    # 「clamp() received an invalid combination of arguments - got (numpy.ndarray, int, int)」），
    # 只在 yield 给调用方时才转 uint8。
    middle = interp_middle_tensor(net, a, b, 0.5, ctx)
    if n == 1:
        yield tensor_to_rgb(middle)
        return
    yield from _recursive_middles(net, a, middle, n // 2, ctx)
    if n % 2:
        yield tensor_to_rgb(middle)
    yield from _recursive_middles(net, middle, b, n // 2, ctx)


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


class _Cancelled(Exception):
    pass


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
# 环境解析
# ════════════════════════════════════════════════════════════════════════════
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
    return torch.float16 if device.type == "cuda" else torch.float32


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

    multiplier = max(1, int(args.multiplier))
    mem = MemTrack()
    cancel = Canceller()
    cancel.install()
    t0 = time.time()

    device = resolve_device(args.device)
    dtype = resolve_dtype(args.precision, device)
    model_path, arch_ver, searched = resolve_weights(args, allow_random=bool(args.allow_random_weights))
    net, arch_ver = build_model(model_path, arch_ver, device, dtype, allow_random=args.allow_random_weights)
    ctx = {
        "device": device,
        "dtype": dtype,
        "scale_list": resolve_scale_list(arch_ver, args.scale_factor),
        "fastmode": bool(args.fast_mode),
        "ensemble": bool(args.ensemble),
    }
    mem.sample()

    vin = av.open(src)
    out_w = out_h = 0
    in_frames = 0
    out_frames = 0
    peak_ram = 0.0
    peak_vram = 0.0
    audio_packets = 0
    cancelled = False
    first = None
    prev_t = None
    src_fps = Fraction(0)
    out_fps = Fraction(0)
    frames_total = 0
    try:
        vstream = vin.streams.video[0]
        vstream.thread_type = "AUTO"
        src_fps = _as_rate(vstream.average_rate or 24)
        out_fps = _as_rate(args.fps) if args.fps else src_fps * multiplier
        frames_total = int(vstream.frames or 0)
        if frames_total <= 0 and vstream.duration and vstream.time_base:
            frames_total = int(round(float(vstream.duration * vstream.time_base) * float(src_fps)))

        out = av.open(dst, "w", format="mp4")
        try:
            ostream = out.add_stream("libx264", rate=out_fps)
            ostream.pix_fmt = "yuv420p"
            ostream.options = {"crf": str(int(args.crf)), "preset": str(args.preset)}
            aout = None
            try:
                if len(vin.streams.audio):
                    aout = out.add_stream_from_template(vin.streams.audio[0])
            except Exception as exc:  # 音轨模板不兼容就放弃音轨，不拖垮视频
                sys.stderr.write("[stream-interp] 音轨模板不可用，输出无音轨：" + str(exc) + "\n")
                aout = None

            def encode(rgb: np.ndarray) -> None:
                nonlocal out_frames
                vframe = av.VideoFrame.from_ndarray(np.ascontiguousarray(rgb), format="rgb24")
                vframe = vframe.reformat(format="yuv420p")
                vframe.pts = out_frames
                for packet in ostream.encode(vframe):
                    out.mux(packet)
                out_frames += 1

            for frame in vin.decode(vstream):
                if cancel.cancelled:
                    cancelled = True
                    break
                arr = frame.to_ndarray(format="rgb24")
                arr = prescale_to_long_side(arr, args.max_long_side)
                if first is None:
                    sh, sw = int(arr.shape[0]), int(arr.shape[1])
                    out_w, out_h = even_dims(sw, sh)
                    if (out_w, out_h) != (sw, sh):
                        arr = np.ascontiguousarray(arr[:out_h, :out_w])
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
                        "sourceFps": float(src_fps),
                        "fps": float(out_fps),
                        "multiplier": multiplier,
                        "arch": arch_ver,
                        "weights": model_path or "random-init",
                        "scaleFactor": float(args.scale_factor),
                        "precision": "fp16" if dtype == torch.float16 else "fp32",
                        "device": str(device),
                        "fastMode": bool(args.fast_mode),
                        "ensemble": bool(args.ensemble),
                        "maxLongSide": int(args.max_long_side or 0),
                        "audio": bool(aout is not None),
                    })

                cur_t = frame_to_tensor(arr, device, dtype)
                if prev_t is not None:
                    for mid in iter_middles(net, prev_t, cur_t, multiplier, ctx):
                        if cancel.cancelled:
                            break
                        encode(mid)
                        del mid
                if cancel.cancelled:
                    cancelled = True
                    del cur_t
                    break
                encode(arr)
                prev_t = cur_t
                in_frames += 1
                del arr

                peak_ram = mem.sample()
                peak_vram = max(peak_vram, _vram_peak_mb(device))
                if not args.quiet and in_frames % max(1, int(args.progress_every)) == 0:
                    _emit({
                        "type": "progress",
                        "pct": round(in_frames * 100.0 / frames_total, 2) if frames_total else 0,
                        "frame": in_frames,
                        "frames": frames_total,
                        "outFrames": out_frames,
                        "peakRamMb": round(peak_ram, 1),
                        "peakVramMb": round(peak_vram, 1),
                    })
                if in_frames % max(1, int(args.clear_cache_every)) == 0:
                    gc.collect()
                    if device.type == "cuda":
                        try:
                            torch.cuda.empty_cache()
                        except Exception:
                            pass

            if cancelled:
                raise _Cancelled()

            if first is None:
                raise RuntimeError("源视频没有解出任何视频帧")

            for packet in ostream.encode():
                out.mux(packet)
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
        "frames": out_frames,
        "inFrames": in_frames,
        "framesTotal": frames_total,
        "width": out_w,
        "height": out_h,
        "multiplier": multiplier,
        "arch": arch_ver,
        "weights": model_path or "random-init",
        "scaleFactor": float(args.scale_factor),
        "precision": "fp16" if dtype == torch.float16 else "fp32",
        "device": str(device),
        "fastMode": bool(args.fast_mode),
        "ensemble": bool(args.ensemble),
        "crf": int(args.crf),
        "sourceFps": float(src_fps),
        "fps": float(out_fps),
        "maxLongSide": int(args.max_long_side or 0),
        "audioPackets": audio_packets,
        "searchedWeightsDirs": searched,
        "seconds": round(time.time() - t0, 3),
        "peakRamMb": round(peak_ram, 1),
        "peakVramMb": round(peak_vram, 1),
        "bytes": os.path.getsize(dst) if os.path.isfile(dst) else 0,
    }


# ════════════════════════════════════════════════════════════════════════════
# --self-test：无 GPU / 无权重也能跑通「假视频 → 解码 → 逐对插值 → 编码 + 音轨直拷」整链
#   · 4 帧假视频分别跑 2x 与 4x 两档，回读校验输出帧数 / 分辨率 / 音轨；
#   · 顺带对每个支持的架构版本用随机权重跑一次极小前向（CPU，仅验证纯 torch 复刻的网络可构建可前向）。
# ════════════════════════════════════════════════════════════════════════════
def _write_fake_video(path: str, w: int, h: int, frames: int, fps: int) -> bool:
    """纯色首尾帧 +（尽力而为的）静音 AAC 音轨，用来验证解码 / 编码 / 音轨直拷三段。"""
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
            rgb[..., i % 3] = 40 + i * 50
            rgb[(h // 4):(h // 2), (w // 4):(w // 2)] = (180, 200, 60)
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


def _arch_sweep() -> list:
    """随机权重下逐个架构版本建网 + 极小前向（CPU），验证纯 torch 复刻可构建可推理。"""
    out = []
    for arch in SUPPORTED_ARCHS:
        try:
            net = IFNet(arch_ver=arch).eval()
            ctx = {
                "device": torch.device("cpu"),
                "dtype": torch.float32,
                "scale_list": resolve_scale_list(arch, 1.0),
                "fastmode": arch in ("4.0", "4.2", "4.3"),   # 4.0 族强制走一次 contextnet/unet 之外的快路径
                "ensemble": False,
            }
            f0 = torch.rand(1, 3, 32, 32)
            f1 = torch.rand(1, 3, 32, 32)
            with torch.inference_mode():
                mid = interp_once(net, f0, f1, 0.5, ctx)
            # 4.0 族再跑一次 fastmode=False（真正用到 Contextnet/Unet）
            if arch in ("4.0", "4.2", "4.3"):
                ctx2 = dict(ctx)
                ctx2["fastmode"] = False
                with torch.inference_mode():
                    mid2 = interp_once(net, f0, f1, 0.5, ctx2)
                assert mid2.shape == (32, 32, 3), "arch " + arch + " fastmode=False 输出形状异常"
            out.append({"arch": arch, "ok": True, "shape": list(mid.shape)})
        except Exception as exc:  # noqa: BLE001
            out.append({"arch": arch, "ok": False, "error": str(exc)})
    return out


def run_self_test(args: argparse.Namespace) -> dict:
    tmpdir = tempfile.mkdtemp(prefix="stream-interp-selftest-")
    src = os.path.join(tmpdir, "in.mp4")
    w, h, frames, fps = 96, 64, 4, 8
    has_audio = _write_fake_video(src, w, h, frames, fps)

    model_path = None
    arch_ver = args.arch or "auto"
    if args.model and os.path.isfile(args.model):
        model_path = args.model
    else:
        auto_path, _searched = discover_weights(args)
        if auto_path:
            model_path = auto_path

    runs = {}
    for mult in (2, 4):
        dst = os.path.join(tmpdir, "out_%dx.mp4" % mult)
        sub = argparse.Namespace(**vars(args))
        sub.input = src
        sub.output = dst
        sub.model = model_path or ""
        sub.arch = arch_ver
        sub.device = "cpu"
        sub.precision = "fp32"
        sub.multiplier = mult
        sub.max_long_side = 0
        sub.fps = 0.0
        sub.progress_every = 1
        sub.quiet = True
        sub.allow_random_weights = True
        sub.weights_dir = ""
        sub.comfy_root = args.comfy_root

        rec = run_stream(sub)
        import av  # noqa: PLC0415

        with av.open(dst) as c:
            got_frames = sum(1 for _ in c.decode(c.streams.video[0]))
            got_w = int(c.streams.video[0].codec_context.width)
            got_h = int(c.streams.video[0].codec_context.height)
            got_audio = len(c.streams.audio)
            got_dur = float(c.duration / 1000000.0) if c.duration else 0.0
        want_frames = frames + (frames - 1) * (mult - 1)
        runs["%dx" % mult] = {
            "ok": bool(
                os.path.isfile(dst)
                and os.path.getsize(dst) > 0
                and got_frames == want_frames
                and got_w == w
                and got_h == h
            ),
            "wantFrames": want_frames,
            "verify": {"frames": got_frames, "width": got_w, "height": got_h,
                       "audioStreams": got_audio, "durationSec": round(got_dur, 3)},
            "seconds": rec["seconds"],
            "peakRamMb": rec["peakRamMb"],
            "peakVramMb": rec["peakVramMb"],
            "bytes": rec["bytes"],
            "arch": rec["arch"],
            "precision": rec["precision"],
        }

    archs = _arch_sweep()
    ok = all(r["ok"] for r in runs.values()) and all(a["ok"] for a in archs)
    rec = {
        "type": "done",
        "ok": bool(ok),
        "selfTest": True,
        "fake": {"width": w, "height": h, "frames": frames, "fps": fps, "audio": bool(has_audio)},
        "runs": runs,
        "archs": archs,
        "weights": model_path or "random-init",
        "seconds": round(sum(r["seconds"] for r in runs.values()), 3),
        "peakRamMb": max(r["peakRamMb"] for r in runs.values()),
        "peakVramMb": max(r["peakVramMb"] for r in runs.values()),
        "bytes": sum(r["bytes"] for r in runs.values()),
    }
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
        prog="stream_interp.py",
        description="逐帧流式补帧（RIFE 4.x / IFNet，纯 torch，内存与视频时长无关）",
    )
    p.add_argument("--input", "-i", default="", help="源视频路径")
    p.add_argument("--output", "-o", default="", help="输出 mp4 路径")
    p.add_argument("--model", default="", help="rife*.pth 权重路径；省略则自动探测")
    p.add_argument("--arch", default="auto",
                   help="RIFE 架构版本（auto = 按权重键名判定；判不出会 exit 2）")
    p.add_argument("--weights-dir", default="", help="自动探测权重的目录（优先于 --comfy-root）")
    p.add_argument("--comfy-root", default="", help="ComfyUI 根目录（探测其 custom_nodes 下的 RIFE 权重）")
    p.add_argument("--multiplier", "-m", type=int, default=DEFAULT_MULTIPLIER,
                   help="补帧倍数：2 = 每对插 1 张；4 = 连续两轮插值（2 的幂次最稳）")
    p.add_argument("--max-long-side", type=int, default=0,
                   help=">0 时先按该长边 INTER_AREA 预缩放（省显存；0 = 保持源分辨率）")
    p.add_argument("--scale-factor", type=float, default=DEFAULT_SCALE_FACTOR,
                   help="RIFE scale_list 归一系数（默认 1.0，与旧图一致）")
    p.add_argument("--precision", default="auto", choices=["auto", "fp16", "fp32"])
    p.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    p.add_argument("--ensemble", action=argparse.BooleanOptionalAction, default=False,
                   help="双向平均（质量更好、算力翻倍；默认关，与旧图的实际行为一致）")
    p.add_argument("--fast-mode", action=argparse.BooleanOptionalAction, default=True,
                   help="True = 跳过 4.0 族的 contextnet/unet（仅老架构受影响）")
    p.add_argument("--crf", type=int, default=DEFAULT_CRF, help="libx264 CRF（越小越清晰）")
    p.add_argument("--preset", default=DEFAULT_PRESET, help="libx264 preset")
    p.add_argument("--fps", type=float, default=0.0,
                   help="输出帧率；省略 = 源帧率 × 倍数（时长与速度不变）")
    p.add_argument("--clear-cache-every", type=int, default=DEFAULT_CLEAR_CACHE_EVERY,
                   help="每 N 帧清一次显存缓存并 gc（默认 10）")
    p.add_argument("--progress-every", type=int, default=1, help="每 N 帧打一行进度 JSON")
    p.add_argument("--json-out", default="", help="把事实回执写到该文件（含峰值内存 / 显存 / 耗时）")
    p.add_argument("--quiet", action="store_true", help="不打逐帧进度（仍打 meta / done）")
    p.add_argument("--self-test", action="store_true", help="CPU 小片冒烟：2x / 4x 假视频跑通整链后退出")
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
        sys.stderr.write("[stream-interp] 写 --json-out 失败：" + str(exc) + "\n")


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
                sys.stderr.write("[stream-interp] 需要 --input 与 --output\n")
                return EXIT_ARGS
            if int(args.multiplier) < 1:
                sys.stderr.write("[stream-interp] --multiplier 必须 ≥ 1\n")
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
    except (ValueError, FileNotFoundError, KeyError) as exc:
        # 参数 / 权重 / 架构无法识别 → 退出码 2，交宿主回退 ComfyUI 图路径
        _cleanup_partial(out_path)
        sys.stderr.write("[stream-interp] 无法识别或缺少必要输入：" + str(exc) + "\n")
        rec = {"type": "error", "ok": False, "error": "unrecognized", "message": str(exc), "output": out_path}
        _emit(rec)
        _write_receipt(args.json_out, rec)
        return EXIT_ARGS
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
