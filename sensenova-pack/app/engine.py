"""SenseNova（SenseNova-U1.5-8B-MoT）文生图推理引擎：懒加载 + 常驻 + 分层卸载。

上游口径（已逐条核对 OpenSenseNova/SenseNova-U1 标签 ``comfyui-v0.3.0`` 的
``examples/t2i/inference.py`` 与 ``apps/comfyui/local_pipeline.py``）::

    import sensenova_u1                      # import 即把 NEO-Unify 注册进 transformers.Auto*
    from sensenova_u1.utils import (
        load_model_and_tokenizer, make_offload_ctx,
        vram_mode_to_prefetch_count, vram_mode_keeps_generation_resident,
    )

    sensenova_u1.set_attn_backend("sdpa")    # auto | flash | sdpa
    model, tokenizer = load_model_and_tokenizer(path, dtype=torch.bfloat16, device="cuda",
                                                for_offload=prefetch_count > 0)
    with make_offload_ctx(model, prefetch_count, device,
                          keep_generation_resident=(vram_mode == "fast")) as m:
        out = m.t2i_generate(tokenizer, prompt, image_size=(w, h), cfg_scale=4.0,
                             cfg_norm="none", timestep_shift=3.0, cfg_interval=(0.0, 1.0),
                             num_steps=50, batch_size=1, seed=42, think_mode=False)
    # out 为归一化空间的 [B,3,H,W] float；think_mode=True 时是 (tensor, think 文本)
    img = ((out.float() * 0.5 + 0.5).clamp(0, 1) * 255).round().to(torch.uint8)  # → PIL

与 YuE2 / Music3 那两个宿主不同，SenseNova 官方**没有** pipeline 封装、也没有阶段日志，
``t2i_generate`` 内部只有一个 ``for step_i in range(num_steps)`` 的采样循环。因此：

* **进度**：官方 ComfyUI 版靠临时替换 ``model.unpatchify``（每个采样步恰好调用一次）当
  步进信号（``apps/comfyui/local_pipeline.py`` 的 ``_progress_hook``）。本引擎照抄这个
  口径，并顺手把「取消」也挂在同一个钩子上——这是唯一能在采样中途停下来的办法。
* **取消**：置位后在下一个采样步（unpatchify 调用处）抛 :class:`Cancelled`；正在跑的
  torch kernel 不能抢占，所以不是「立即停」。中止后**不写任何产物**。
* **显存**：``SenseNova-U1.5-8B-MoT`` 的 bf16 权重约 32.66GB（8 片 safetensors），
  **超过 24GB 单卡显存**，所以 ``vram_mode`` 不能是 ``full``（官方 ``full`` = 整模进显存，
  只适合 48G+ / 多卡）。本引擎默认 ``fast``（官方给 24GB 卡的档位：异步预取 + 预算内常驻
  generation 层），并在遇到 CUDA OOM 时**自动降一档重试一次**（fast → balanced → low），
  把降级过程写进响应的 ``warnings``，用户不用自己猜。
* **注意力**：Windows 上没有 flash-attn 官方轮子，``auto`` 会回退 SDPA；本引擎默认
  ``sdpa``（显式、可复现），可用 ``SENSENOVA_ATTN_BACKEND`` 或请求里的 ``attnBackend`` 覆盖。

分辨率：官方只有 11 个训练桶（最小约 4M 像素），**不能靠降分辨率省显存**；非桶值只告警
不拦（与上游 ``_warn_if_unsupported`` 一致）。
"""
from __future__ import annotations

import gc
import json
import os
import random
import re
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

# ---------------------------------------------------------------- 常量（对齐上游）

MODEL_REPO = "sensenova/SenseNova-U1.5-8B-MoT"          # HuggingFace repo id
MODEL_REPO_MODELSCOPE = "SenseNova/SenseNova-U1.5-8B-MoT"  # ModelScope repo id（国内主下载源）
PACKAGE_NAME = "sensenova-u1"

# vram_mode -> prefetch_count（0 = 不卸载，1 = 同步逐层，>=2 = 异步预取）
VRAM_MODES: Tuple[str, ...] = ("full", "fast", "balanced", "low")
VRAM_MODE_TO_PREFETCH: Dict[str, int] = {"full": 0, "fast": 2, "balanced": 2, "low": 1}
# OOM 自动降档顺序（24GB 卡上 full 必炸）
VRAM_MODE_FALLBACK: Dict[str, str] = {"full": "fast", "fast": "balanced", "balanced": "low", "low": ""}
DEFAULT_VRAM_MODE = "fast"

DTYPES: Tuple[str, ...] = ("bfloat16", "float16", "float32")
DEFAULT_DTYPE = "bfloat16"
CFG_NORMS: Tuple[str, ...] = ("none", "global", "channel", "cfg_zero_star")
ATTN_BACKENDS: Tuple[str, ...] = ("auto", "flash", "sdpa")
DEFAULT_ATTN_BACKEND = "sdpa"  # Windows 无 flash-attn 轮子；sdpa 是确定性可用的那一档

# 上游 examples/t2i/inference.py 的 SUPPORTED_RESOLUTIONS（11 个训练桶）
SUPPORTED_RESOLUTIONS: Dict[str, Tuple[int, int]] = {
    "1:1": (2048, 2048),
    "16:9": (2720, 1536),
    "9:16": (1536, 2720),
    "3:2": (2496, 1664),
    "2:3": (1664, 2496),
    "4:3": (2368, 1760),
    "3:4": (1760, 2368),
    "1:2": (1440, 2880),
    "2:1": (2880, 1440),
    "1:3": (1152, 3456),
    "3:1": (3456, 1152),
}
DEFAULT_WIDTH, DEFAULT_HEIGHT = SUPPORTED_RESOLUTIONS["1:1"]

# 上游 CLI 默认值（examples/t2i/inference.py parse_args）
DEFAULT_CFG_SCALE = 4.0
DEFAULT_CFG_NORM = "none"
DEFAULT_TIMESTEP_SHIFT = 3.0
DEFAULT_NUM_STEPS = 50
MIN_NUM_STEPS, MAX_NUM_STEPS = 1, 200
DEFAULT_SEED = 42
# 图像编辑（参考图条件生成）默认值：img_cfg_scale=1.0 即关闭图像 CFG（对齐上游
# examples/editing/inference.py 的 parser 默认），需显式加大才生效。
DEFAULT_IMG_CFG_SCALE = 1.0
# 参考图数量上限：再多显存与语义都会崩；上游 interleave 同样以 10 为上限、编辑示例也按
# 「1~2 张 2048x2048 全分辨率」给显存预算，这里取 4 张作为稳妥闸门。
MAX_REF_IMAGES = 4
# 参考图输入像素预算（= 上游 examples/editing/inference.py 的 ``--input_max_pixels auto`` 口径）：
# 前 2 张各按 2048x2048 给足，更多张按 (4096^2)/n 摊分，下限 512x512（上游 MIN_INPUT_MAX_PIXELS）。
# 上游编辑示例 ``--do_resize`` 默认 True 就是这个预算；我们照做，避免把 4K 截图这类超大参考图
# 原样喂进 ViT / 前缀阶段 —— 那是编辑模式「非常慢」的主要来源之一。
REF_INPUT_FULL_PIXELS = 2048 * 2048
REF_INPUT_MIN_PIXELS = 512 * 512
REF_INPUT_FULL_RES_BUDGET = 2
# 图像 token 网格因子（patch_size * downsample_ratio 的约定值）；能从上游拿到就用上游的。
REF_GRID_FACTOR_FALLBACK = 16

_ROOT = Path(__file__).resolve().parent.parent

_LOGGER: List[Optional[Callable[[str], None]]] = [None]


def set_logger(fn: Optional[Callable[[str], None]]) -> None:
    """由 server 层注入行式日志器（统一 ``[sensenova]`` 前缀，上层追加进 console.log）。"""
    _LOGGER[0] = fn


def log(msg: str) -> None:
    fn = _LOGGER[0]
    if fn:
        fn(msg)
    else:
        try:
            print(f"[sensenova] {msg}", flush=True)
        except Exception:
            pass


# ---------------------------------------------------------------- 错误类型


class EngineError(Exception):
    """带短码的引擎错误，服务层直接转成 ``{"ok":false,"error":短码}``。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class Cancelled(Exception):
    """用户在采样步边界取消了本次生成。"""


_OOM_HINTS = ("out of memory", "cublas_status_alloc_failed", "defaultcudacallocator", "no available memory",
              "显存不足")


def _looks_oom(text: str) -> bool:
    low = (text or "").lower()
    return any(h in low for h in _OOM_HINTS)


# ---------------------------------------------------------------- 进度


class Progress:
    """staged 进度快照（供 ``GET /progress`` 轮询）。线程安全、百分比单调不回退。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.stage = "idle"
        self.percent = 0
        self.message = ""
        self.running = False
        self.done = False
        self.cancelled = False
        self.error = ""
        self.seed: Optional[int] = None
        self.output_dir = ""
        self.step = 0
        self.total_steps = 0
        self.started_at = 0.0
        self.updated_at = 0.0
        self.elapsed_sec = 0.0

    def start(self, seed: Optional[int], output_dir: str, total_steps: int = 0) -> None:
        with self._lock:
            self.stage = "queued"
            self.percent = 1
            self.message = "已入队，等待模型"
            self.running = True
            self.done = False
            self.cancelled = False
            self.error = ""
            self.seed = seed
            self.output_dir = output_dir
            self.step = 0
            self.total_steps = max(0, int(total_steps))
            self.started_at = time.time()
            self.updated_at = self.started_at
            self.elapsed_sec = 0.0

    def set(self, stage: str, percent: Optional[int] = None, message: Optional[str] = None) -> None:
        with self._lock:
            if not self.running:
                return
            self.stage = stage
            if percent is not None and percent > self.percent:
                self.percent = min(percent, 99)
            if message:
                self.message = message
            self.updated_at = time.time()
            self.elapsed_sec = round(self.updated_at - self.started_at, 3)

    def step_done(self, step: int, total: int) -> None:
        """采样循环里的一步走完：由 ``model.unpatchify`` 钩子调用（唯一的中途进度源）。"""
        with self._lock:
            if not self.running:
                return
            self.step = int(step)
            self.total_steps = int(total) or self.total_steps
            self.stage = "sample"
            if self.total_steps > 0:
                # 采样阶段占 15%~95%
                pct = 15 + int(80.0 * min(1.0, self.step / float(self.total_steps)))
                if pct > self.percent:
                    self.percent = min(pct, 99)
            self.message = f"采样 {self.step}/{self.total_steps} 步"
            self.updated_at = time.time()
            self.elapsed_sec = round(self.updated_at - self.started_at, 3)

    def finish(self, stage: str = "done", percent: int = 100, message: str = "完成") -> None:
        with self._lock:
            self.stage = stage
            self.percent = percent
            self.message = message
            self.running = False
            self.done = True
            self.updated_at = time.time()
            self.elapsed_sec = round(self.updated_at - self.started_at, 3)

    def fail(self, message: str, stage: str = "failed") -> None:
        with self._lock:
            self.stage = stage
            self.error = message
            self.message = message
            self.running = False
            self.done = True
            self.updated_at = time.time()
            self.elapsed_sec = round(self.updated_at - self.started_at, 3)

    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "stage": self.stage,
                "percent": int(self.percent),
                "message": self.message,
                "running": bool(self.running),
                "done": bool(self.done),
                "cancelled": bool(self.cancelled),
                "error": self.error,
                "seed": self.seed,
                "outputDir": self.output_dir,
                "step": int(self.step),
                "totalSteps": int(self.total_steps),
                "elapsedSec": round(time.time() - self.started_at, 3) if self.started_at else 0.0,
            }


# ---------------------------------------------------------------- 模型目录探测


def _model_dir_candidates() -> List[Path]:
    bases: List[Path] = [_ROOT / "models"]
    ms_home = (os.environ.get("MODELSCOPE_CACHE") or os.environ.get("MODELSCOPE_HOME") or "").strip()
    if ms_home:
        bases += [Path(ms_home), Path(ms_home) / "models"]
    hf_home = (os.environ.get("HF_HOME") or "").strip()
    if hf_home:
        bases += [Path(hf_home) / "hub", Path(hf_home)]
    bases += [Path.home() / ".cache" / "modelscope" / "hub", Path.home() / ".cache" / "huggingface" / "hub"]
    flat_names = (
        "SenseNova__SenseNova-U1.5-8B-MoT",
        "SenseNova_U1.5-8B-MoT",
        MODEL_REPO_MODELSCOPE,
        MODEL_REPO,
    )
    out: List[Path] = []
    for base in bases:
        for name in flat_names:
            out.append(base / name)
    return out


def resolve_model_source() -> str:
    """模型加载源：``SENSENOVA_MODEL_DIR`` → 本地目录 → HF repo id（交给 transformers 解析/下载）。

    返回**本地目录存在且含 config.json 时的绝对路径**，否则返回 HuggingFace repo id
    （``sensenova/SenseNova-U1.5-8B-MoT``；此时 ``HF_ENDPOINT`` 一般已被设成 hf-mirror）。
    """
    env = (os.environ.get("SENSENOVA_MODEL_DIR") or "").strip().strip('"')
    if env:
        p = Path(env).expanduser()
        if p.is_dir() and (p / "config.json").is_file():
            return str(p.resolve())
        log(f"SENSENOVA_MODEL_DIR 指向的目录不完整（缺 config.json）：{env}；改走自动探测")
    for cand in _model_dir_candidates():
        try:
            if cand.is_dir() and (cand / "config.json").is_file():
                return str(cand.resolve())
        except OSError:
            continue
    return MODEL_REPO


def _package_version() -> str:
    try:
        from importlib.metadata import version

        return version(PACKAGE_NAME)
    except Exception:
        return ""


def _as_int(v: Any) -> Optional[int]:
    if v is None or v == "":
        return None
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def _as_float(v: Any) -> Optional[float]:
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


_SAFE_NAME = re.compile(r"[^0-9A-Za-z._\-\u4e00-\u9fff]+")


def _safe_filename(raw: Any, ts: str) -> str:
    """输出文件名：去路径分隔符与非法字符，强制 .png；空值给 sensenova-<ts>.png。"""
    s = str(raw or "").strip().strip('"').replace("\\", "/")
    s = s.rsplit("/", 1)[-1]
    s = _SAFE_NAME.sub("-", s).strip("-._") or f"sensenova-{ts}"
    low = s.lower()
    if low.endswith(".png"):
        s = s[:-4] + ".png"
    elif low.endswith((".jpg", ".jpeg", ".webp", ".bmp")):
        s = s.rsplit(".", 1)[0] + ".png"
    else:
        s = s + ".png"
    return s[:180]


# ---------------------------------------------------------------- 参考图

_REF_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif")


def _as_ref_path_list(raw: Any) -> List[str]:
    """入参归一：字符串 / 字符串数组 / ``{path|imagePath|file}`` 对象数组 → 去重后的路径数组。

    渲染层与第三方调用方给的形状不一（refImages / referenceImages / image_path…），
    这里只认路径，不猜语义；空值一律跳过。
    """
    if raw is None or raw == "":
        return []
    arr = raw if isinstance(raw, (list, tuple)) else [raw]
    out: List[str] = []
    seen = set()
    for it in arr:
        if isinstance(it, dict):
            p = it.get("path") or it.get("imagePath") or it.get("file") or ""
        else:
            p = it
        s = str(p or "").strip().strip('"')
        if not s:
            continue
        key = s.lower() if os.name == "nt" else s
        if key in seen:
            continue
        seen.add(key)
        out.append(s)
    return out


def ref_input_max_pixels(n_images: int) -> int:
    """参考图「每张」允许的最大像素数（对齐上游 ``_auto_input_max_pixels``）。

    ≤2 张各给满 2048x2048；更多张按 ``2 * 2048^2 / n`` 摊分，下限 512x512。
    """
    n = max(1, int(n_images or 1))
    if n <= REF_INPUT_FULL_RES_BUDGET:
        return REF_INPUT_FULL_PIXELS
    total = REF_INPUT_FULL_RES_BUDGET * REF_INPUT_FULL_PIXELS
    return max(REF_INPUT_MIN_PIXELS, total // n)


def _ref_grid_factor() -> int:
    """图像 token 网格因子：优先取上游 ``DEFAULT_IMAGE_PATCH_SIZE``（拿不到就 16）。"""
    try:
        from sensenova_u1.utils import DEFAULT_IMAGE_PATCH_SIZE

        v = int(DEFAULT_IMAGE_PATCH_SIZE)
        if v > 0:
            return v
    except Exception:
        pass
    return REF_GRID_FACTOR_FALLBACK


def _resize_to_pixel_budget(img: Any, budget: int, factor: int) -> Any:
    """把参考图按**总像素预算**等比缩到 ≤ budget（不放大、LANCZOS、边长对齐 factor）。

    与上游 ``_resize_to_max_budget`` 同口径（那边还把小于预算的图放大到预算，这里只缩不放，
    省一次无意义的放大）；尺寸已经够小就原样返回。
    """
    w, h = int(img.width), int(img.height)
    if w <= 0 or h <= 0 or budget <= 0 or w * h <= budget:
        return img
    factor = max(1, int(factor))
    scale = (float(budget) / float(w * h)) ** 0.5
    nw = max(factor, int(round(w * scale / factor)) * factor)
    nh = max(factor, int(round(h * scale / factor)) * factor)
    # 网格取整可能略微超出预算：按长边逐格外退到 ≤ budget 为止（上游 smart_resize 同口径）
    while nw * nh > budget and (nw > factor or nh > factor):
        if nw >= nh:
            nw = max(factor, nw - factor)
        else:
            nh = max(factor, nh - factor)
    if (nw, nh) == (w, h):
        return img
    try:
        from PIL import Image

        resample = getattr(Image, "Resampling", Image).LANCZOS
    except Exception:
        resample = 1
    return img.resize((nw, nh), resample)


def load_reference_images(paths: List[str], warnings: Optional[List[str]] = None) -> Tuple[List[Any], List[str]]:
    """参考图路径 → PIL RGB 图像数组 + 实际生效的路径数组。

    读不到的文件**不致命**：记一条 warning 后跳过（一张都读不出来时由调用方决定是退回纯文生图
    还是报错）。RGBA 平铺到白底（与上游 editing/inference.py 的 ``_load_input_image`` 同口径）。

    分辨率按上游 ``--input_max_pixels auto`` 的预算**就地等比缩小**（只缩不放）：编辑模式的
    前缀阶段要在参考图上跑 ViT + 前缀前向，原样喂 4K 截图会让「图参考模式」慢一个量级；
    上游编辑示例 ``--do_resize`` 默认 True 就是这个预算。开着的文件句柄读完即关。
    """
    try:
        from PIL import Image
    except Exception as e:  # 没有 PIL 时参考图无法解码：明确报错，不静默降级
        raise EngineError(
            "model_load_failed",
            f"参考图需要 Pillow 解码，但 PIL 不可用：{str(e)[:200]}；请重跑 scripts\\install.ps1 补依赖。",
        ) from e

    budget = ref_input_max_pixels(len(paths))
    factor = _ref_grid_factor()
    images: List[Any] = []
    used: List[str] = []
    resized: List[str] = []
    for p in paths:
        try:
            with Image.open(p) as src:
                if src.mode == "RGBA":
                    bg = Image.new("RGB", src.size, (255, 255, 255))
                    bg.paste(src, mask=src.split()[3])
                    img = bg
                else:
                    img = src.convert("RGB")
                resized_img = _resize_to_pixel_budget(img, budget, factor)
                if resized_img is not img:
                    resized.append(f"{p} {img.width}x{img.height}→{resized_img.width}x{resized_img.height}")
                img = resized_img
        except Exception as e:
            msg = f"参考图读取失败，已跳过：{p}（{str(e)[:160]}）"
            log(msg)
            if warnings is not None:
                warnings.append(msg)
            continue
        images.append(img)
        used.append(p)
    if resized:
        log(f"参考图按输入预算缩到 ≤{budget} 像素/张：" + "；".join(resized)[:400])
        if warnings is not None:
            warnings.append(
                f"参考图已按上游输入预算等比缩小（≤{budget} 像素/张，防止编辑模式被超大参考图拖慢）："
                + "；".join(resized)
            )
    return images, used


# ---------------------------------------------------------------- 引擎


class SenseNovaEngine:
    """懒加载 + 常驻的 SenseNova-U1 文生图引擎；一次只跑一张（并发保护在 server 层）。"""

    def __init__(self) -> None:
        self.mock = (os.environ.get("MTNODE_SENSENOVA_MOCK") or "").strip() == "1"
        self.progress = Progress()
        self.model_source = resolve_model_source()
        self.package_version = _package_version()
        self.effective_attn_backend = ""
        self.peak_vram_gib = 0.0
        self._model: Any = None
        self._tokenizer: Any = None
        self._lock = threading.RLock()
        self._cancel = threading.Event()
        # 加载期因 OOM 被自动降到的实际档位（generate() 每次开始会重置）
        self._forced_vram_mode = ""

    # ---------------- 只读状态（/health 用，绝不触发加载） ----------------

    @property
    def loaded(self) -> bool:
        return bool(self.mock or (self._model is not None and self._tokenizer is not None))

    def env_vram_mode(self) -> str:
        v = (os.environ.get("SENSENOVA_VRAM_MODE") or "").strip().lower() or DEFAULT_VRAM_MODE
        return v if v in VRAM_MODES else DEFAULT_VRAM_MODE

    def env_dtype(self) -> str:
        v = (os.environ.get("SENSENOVA_DTYPE") or "").strip().lower() or DEFAULT_DTYPE
        return v if v in DTYPES else DEFAULT_DTYPE

    def env_attn_backend(self) -> str:
        """注意力档位：``SENSENOVA_ATTN_BACKEND`` → 安装期探针 ``<INSTALL_DIR>/.attn-backend`` → sdpa。

        Windows 上没有 flash-attn 官方轮子，``flash`` 只在探针确认 ``import flash_attn``
        成功时才会被安装脚本写进 ``.attn-backend``（见 scripts/install.ps1）。
        """
        v = (os.environ.get("SENSENOVA_ATTN_BACKEND") or "").strip().lower()
        if v not in ATTN_BACKENDS:
            v = ""
        if not v:
            try:
                probe = (_ROOT / ".attn-backend").read_text(encoding="utf-8-sig").strip().lower()
                if probe in ATTN_BACKENDS:
                    v = probe
            except Exception:
                pass
        return v or DEFAULT_ATTN_BACKEND

    def pick_device(self) -> str:
        env = (os.environ.get("SENSENOVA_DEVICE") or "").strip().lower()
        if env in ("cuda", "cpu") or env.startswith("cuda:"):
            return env
        try:
            import torch

            if torch.cuda.is_available():
                return "cuda"
        except Exception:
            pass
        return "cpu"

    def gpu_info(self) -> Dict[str, Any]:
        """显存概况（总/已分配/峰值，GiB）；无 CUDA 返回 {}。给 /health 与文档实测用。"""
        try:
            import torch

            if not torch.cuda.is_available():
                return {}
            total = torch.cuda.get_device_properties(0).total_memory / (1024**3)
            return {
                "name": torch.cuda.get_device_name(0),
                "totalGiB": round(float(total), 2),
                "allocatedGiB": round(float(torch.cuda.memory_allocated(0)) / (1024**3), 2),
                "reservedGiB": round(float(torch.cuda.memory_reserved(0)) / (1024**3), 2),
                "peakGiB": round(float(self.peak_vram_gib), 2),
            }
        except Exception:
            return {}

    # ---------------- 加载 / 关闭 ----------------

    def ensure_loaded(self, dtype: str = DEFAULT_DTYPE, vram_mode: str = DEFAULT_VRAM_MODE,
                      attn_backend: str = DEFAULT_ATTN_BACKEND, device: str = "") -> Tuple[Any, Any]:
        """加载模型 + tokenizer 并常驻（mock 模式什么都不做）。失败抛 :class:`EngineError`。"""
        if self.mock:
            raise EngineError("bad_request", "mock 模式不加载模型")
        with self._lock:
            if self._model is not None and self._tokenizer is not None:
                return self._model, self._tokenizer
            device = device or self.pick_device()
            src = self.model_source
            log(f"正在加载 SenseNova：{src}（device={device} dtype={dtype} vram_mode={vram_mode} attn={attn_backend}）")
            t0 = time.time()
            try:
                import torch
            except Exception as e:
                raise EngineError(
                    "model_load_failed",
                    f"torch 不可用（CUDA 版 torch / torchvision 是否装好？）：{str(e)[:200]}",
                ) from e
            try:
                import sensenova_u1  # import 期把 NEO-Unify 注册进 AutoConfig / AutoModel
                from sensenova_u1.utils import load_model_and_tokenizer
            except Exception as e:
                raise EngineError(
                    "model_load_failed",
                    f"sensenova_u1 推理包不可用（pip install sensenova-u1 tarball --no-deps）：{str(e)[:300]}",
                ) from e
            try:
                # 档位映射优先用上游的表（上游若新增 / 改语义 vram_mode，这里先接管）
                from sensenova_u1.utils import vram_mode_to_prefetch_count as _upstream_prefetch

                VRAM_MODE_TO_PREFETCH[vram_mode] = int(_upstream_prefetch(vram_mode))
            except Exception:
                pass
            if attn_backend not in ATTN_BACKENDS:
                raise EngineError("bad_request", f"attnBackend 必须是 {' / '.join(ATTN_BACKENDS)}，收到：{attn_backend}")
            try:
                sensenova_u1.set_attn_backend(attn_backend)
                self.effective_attn_backend = str(sensenova_u1.effective_attn_backend())
                log(f"注意力档位：请求 {attn_backend} → 实际 {self.effective_attn_backend}")
            except Exception as e:
                log(f"设置注意力档位失败（按 auto 继续）：{str(e)[:200]}")
                try:
                    self.effective_attn_backend = str(sensenova_u1.effective_attn_backend())
                except Exception:
                    self.effective_attn_backend = ""
            torch_dtype = getattr(torch, dtype, torch.bfloat16)
            if device == "cpu" and torch_dtype == torch.bfloat16 and not getattr(torch.cpu, "has_bf16", lambda: False)():
                torch_dtype = torch.float32
                log("CPU 不支持 bf16，本次按 float32 加载")
            prefetch = VRAM_MODE_TO_PREFETCH.get(vram_mode, 2)
            try:
                model, tokenizer = load_model_and_tokenizer(
                    src,
                    dtype=torch_dtype,
                    device=device,
                    for_offload=prefetch > 0,
                )
            except Exception as e:
                if _looks_oom(str(e)) and VRAM_MODE_FALLBACK.get(vram_mode):
                    nxt = VRAM_MODE_FALLBACK[vram_mode]
                    log(f"加载阶段显存不足，按 vram_mode={nxt} 重试一次：{str(e)[:200]}")
                    try:
                        prefetch = VRAM_MODE_TO_PREFETCH[nxt]
                        model, tokenizer = load_model_and_tokenizer(
                            src, dtype=torch_dtype, device=device, for_offload=prefetch > 0
                        )
                        self._forced_vram_mode = nxt
                    except Exception as e2:
                        raise self._load_error(src, e2) from e2
                else:
                    raise self._load_error(src, e) from e
            self._model, self._tokenizer = model, tokenizer
            self.package_version = self.package_version or _package_version()
            self.model_source = src
            log(f"SenseNova 就绪：{src}（加载用时 {time.time() - t0:.1f}s，包版本 {self.package_version or '未知'}）")
            return model, tokenizer

    @staticmethod
    def _load_error(src: str, exc: BaseException) -> EngineError:
        text = str(exc)
        if _looks_oom(text):
            return EngineError(
                "model_load_failed",
                f"加载权重时显存不足（SenseNova-U1.5-8B-MoT bf16 权重约 32.66GB > 单卡显存，"
                f"必须走分层卸载）：{text[:300]}；处置：vramMode 依次试 fast → balanced → low，"
                f"并先关掉其它占显存的本地后端（H3 / Music3）",
            )
        if "sensenova_u1_min_version" in text or "requires sensenova-u1" in text:
            return EngineError(
                "model_load_failed",
                f"权重要求的 sensenova-u1 版本比已装的新（{src}）：{text[:300]}；"
                f"处置：重跑 install.ps1（会拉最新 tag 的 tarball），不要重下权重",
            )
        return EngineError("model_load_failed", f"SenseNova 加载失败（{src}）：{text[:400]}")

    def close(self) -> None:
        """释放权重与显存（/shutdown 与空闲自停时调用）。"""
        with self._lock:
            model, self._model, self._tokenizer = self._model, None, None
        if model is None:
            return
        try:
            del model
        except Exception:
            pass
        gc.collect()
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
        log("已释放模型与显存")

    def release_run_memory(self, reason: str = "run_done") -> None:
        """释放**本次运行**的显存 / 中间张量（模型本身仍常驻，供下次直接复用）。

        上游 ``make_offload_ctx`` 退上下文时已经 ``teardown`` + ``empty_cache``；这里再兜一层，
        保证三种情况都一定回收：① ``vram_mode=full`` 时 ``make_offload_ctx`` 是 nullcontext
        （根本没有卸载上下文可退）；② 生成中途抛异常 / 取消；③ 反归一化后的输出张量与
        参考图 PIL 还挂在调用栈上。日志把 allocated 前后变化写进 console.log，用户能直接看到
        「完成后到底释放了没有」。
        """
        gc.collect()
        try:
            import torch
        except Exception:
            return
        try:
            if not torch.cuda.is_available():
                return
            torch.cuda.synchronize()
            before = float(torch.cuda.memory_allocated()) / (1024 ** 3)
            torch.cuda.empty_cache()
            after = float(torch.cuda.memory_allocated()) / (1024 ** 3)
            reserved = float(torch.cuda.memory_reserved()) / (1024 ** 3)
            if before > 0.05 or after > 0.05:
                log(
                    f"本次运行显存已释放（{reason}）：allocated {before:.2f} → {after:.2f} GiB，"
                    f"reserved {reserved:.2f} GiB；权重按 vramMode 分层常驻，空闲自停时整进程释放"
                )
        except Exception:
            pass

    # ---------------- 取消 ----------------

    def cancel(self) -> bool:
        if not self.progress.running:
            return False
        self._cancel.set()
        self.progress.set("cancelling", None, "已请求取消，将在下一个采样步边界中止")
        return True

    def _check_cancel(self) -> None:
        if self._cancel.is_set():
            raise Cancelled("用户取消")

    # ---------------- 生成 ----------------

    def generate(self, req: Dict[str, Any]) -> Dict[str, Any]:
        """一次完整生成：校验入参 → t2i_generate / it2i_generate → 反归一化存 PNG → 回真实路径。"""
        prompt = str(req.get("prompt") or "").strip()
        if not prompt:
            raise EngineError("bad_request", "prompt（图像提示词）不能为空")

        ref_paths = _as_ref_path_list(
            req.get("refImages")
            if req.get("refImages") is not None
            else req.get("referenceImages")
        )
        if not ref_paths:
            # 兼容单图调用方的其它键名（refImage / image_path / init_image …）
            for k in ("refImage", "referenceImage", "refImagePaths", "image_path", "init_image", "ref_image"):
                ref_paths = _as_ref_path_list(req.get(k))
                if ref_paths:
                    break
        if len(ref_paths) > MAX_REF_IMAGES:
            ref_paths = ref_paths[:MAX_REF_IMAGES]

        width = _as_int(req.get("width")) or DEFAULT_WIDTH
        height = _as_int(req.get("height")) or DEFAULT_HEIGHT
        num_steps = _as_int(req.get("numSteps", req.get("num_steps")))
        num_steps = DEFAULT_NUM_STEPS if num_steps is None else max(MIN_NUM_STEPS, min(MAX_NUM_STEPS, num_steps))
        cfg_scale = _as_float(req.get("cfgScale", req.get("cfg_scale")))
        cfg_scale = DEFAULT_CFG_SCALE if cfg_scale is None else float(cfg_scale)
        cfg_norm = str(req.get("cfgNorm") or DEFAULT_CFG_NORM).strip().lower() or DEFAULT_CFG_NORM
        if cfg_norm not in CFG_NORMS:
            raise EngineError("bad_request", f"cfgNorm 必须是 {' / '.join(CFG_NORMS)}，收到：{cfg_norm}")
        img_cfg_scale = _as_float(req.get("imgCfgScale", req.get("img_cfg_scale")))
        img_cfg_scale = DEFAULT_IMG_CFG_SCALE if img_cfg_scale is None else float(img_cfg_scale)
        timestep_shift = _as_float(req.get("timestepShift", req.get("timestep_shift")))
        timestep_shift = DEFAULT_TIMESTEP_SHIFT if timestep_shift is None else float(timestep_shift)
        cfg_interval = req.get("cfgInterval", req.get("cfg_interval")) or (0.0, 1.0)
        try:
            lo, hi = float(cfg_interval[0]), float(cfg_interval[1])
        except Exception:
            raise EngineError("bad_request", f"cfgInterval 需是 [lo, hi] 两个 0~1 的数，收到：{cfg_interval}") from None
        seed = _as_int(req.get("seed"))
        if seed is None or seed < 0:
            seed = random.randrange(1, 2 ** 31 - 1)
        think = bool(req.get("think"))
        vram_mode = str(req.get("vramMode") or "").strip().lower() or self.env_vram_mode()
        if vram_mode not in VRAM_MODES:
            raise EngineError("bad_request", f"vramMode 必须是 {' / '.join(VRAM_MODES)} 之一，收到：{vram_mode}")
        dtype = str(req.get("dtype") or "").strip().lower() or self.env_dtype()
        if dtype not in DTYPES:
            raise EngineError("bad_request", f"dtype 必须是 {' / '.join(DTYPES)} 之一，收到：{dtype}")
        attn_backend = str(req.get("attnBackend") or "").strip().lower() or self.env_attn_backend()
        device = str(req.get("device") or "").strip().lower()

        warnings: List[str] = []
        if (width, height) not in SUPPORTED_RESOLUTIONS.values():
            buckets = ", ".join(f"{r}->{w}x{h}" for r, (w, h) in SUPPORTED_RESOLUTIONS.items())
            warnings.append(f"({width}x{height}) 不在官方 11 个训练分辨率桶内，画质可能下降；可用：{buckets}")
        ts = time.strftime("%Y%m%d-%H%M%S")
        out_dir = self._resolve_output_dir(req.get("outputDir"))
        file_name = _safe_filename(req.get("filename"), ts)
        image_path = out_dir / file_name

        self._cancel.clear()
        self._forced_vram_mode = ""
        self.progress.start(seed=seed, output_dir=str(out_dir), total_steps=num_steps)
        t0 = time.time()
        try:
            if self.mock:
                result = self._mock_run(
                    prompt, width, height, seed, num_steps, out_dir, image_path, think,
                    ref_paths=ref_paths, img_cfg_scale=img_cfg_scale,
                )
            else:
                result = self._real_run(
                    prompt=prompt, width=width, height=height, num_steps=num_steps, cfg_scale=cfg_scale,
                    cfg_norm=cfg_norm, timestep_shift=timestep_shift, cfg_interval=(lo, hi), seed=seed,
                    think=think, vram_mode=vram_mode, dtype=dtype, attn_backend=attn_backend,
                    device=device, out_dir=out_dir, image_path=image_path, warnings=warnings,
                    ref_paths=ref_paths, img_cfg_scale=img_cfg_scale,
                )
        except Cancelled as e:
            self.progress.cancelled = True
            self.progress.fail(str(e), stage="cancelled")
            self._discard(image_path)
            raise EngineError("cancelled", "本次生成已取消（未写出任何产物）") from e
        except EngineError as e:
            self.progress.fail(e.message)
            raise
        except Exception as e:
            log("生成未预期异常：" + traceback.format_exc(limit=6).replace("\n", " | ")[:600])
            self.progress.fail(f"生成失败：{str(e)[:300]}")
            self._discard(image_path)
            msg = str(e)[:400]
            if _looks_oom(msg):
                msg += "；处置：把 vramMode 降到 low、或关掉其它占显存的本地后端后重试"
            raise EngineError("generate_failed", f"生成失败：{msg}") from e
        finally:
            # 无论成功 / 取消 / 异常，本次运行的显存与中间张量都在这里回收
            self.release_run_memory("cancelled" if self._cancel.is_set() else "run_done")

        result.update({
            "prompt": prompt,
            "seed": seed,
            "numSteps": num_steps,
            "cfgScale": cfg_scale,
            "cfgNorm": cfg_norm,
            "timestepShift": timestep_shift,
            "think": bool(think),
            "mock": bool(self.mock),
            "elapsedSec": round(time.time() - t0, 2),
            "refImages": ref_paths,
            "imgCfgScale": img_cfg_scale,
        })
        result.setdefault("mode", "edit" if ref_paths else "t2i")
        result.setdefault("refImagesUsed", 0)
        result.setdefault("warnings", warnings)
        self.progress.finish()
        return result

    def _discard(self, image_path: Path) -> None:
        try:
            if image_path.is_file():
                image_path.unlink()
        except Exception:
            pass

    def _resolve_output_dir(self, raw: Any) -> Path:
        s = str(raw or "").strip().strip('"')
        if s:
            p = Path(s).expanduser()
            if not p.is_absolute():
                p = Path.cwd() / p
        else:
            p = _ROOT / "outputs" / f"sensenova-{time.strftime('%Y%m%d-%H%M%S')}-{random.randrange(0x1000, 0xFFFF):04x}"
        p = p.resolve()
        try:
            p.mkdir(parents=True, exist_ok=True)
        except Exception as e:
            raise EngineError("bad_request", f"无法创建 outputDir（{p}）：{str(e)[:200]}") from e
        if not p.is_dir():
            raise EngineError("bad_request", f"outputDir 不是目录：{p}")
        return p

    # ---------------- 真实推理 ----------------

    def _real_run(self, *, prompt: str, width: int, height: int, num_steps: int, cfg_scale: float,
                  cfg_norm: str, timestep_shift: float, cfg_interval: Tuple[float, float], seed: int,
                  think: bool, vram_mode: str, dtype: str, attn_backend: str, device: str,
                  out_dir: Path, image_path: Path, warnings: List[str],
                  ref_paths: Optional[List[str]] = None, img_cfg_scale: float = DEFAULT_IMG_CFG_SCALE) -> Dict[str, Any]:
        device = device or self.pick_device()
        if device.startswith("cuda"):
            try:
                import torch

                if not torch.cuda.is_available():
                    raise EngineError(
                        "model_load_failed",
                        "请求用 CUDA 但 torch 看不到可用的 CUDA 设备：装的是 CPU 版 torch，"
                        "或驱动太旧。重跑 scripts\\install.ps1（-TorchIndex 指定匹配档位）。",
                    )
            except EngineError:
                raise
            except Exception:
                pass
        self.progress.set("load_model", 8, "准备 SenseNova 权重（首次请求加载，之后常驻）")

        # 参考图：路径读不到只是警告 + 跳过（PIL 缺失 / 全读不出来才是硬错）。
        # 一张都读不出来时退回纯文生图，并在 warnings 里说清「参考图未生效」。
        ref_images: List[Any] = []
        ref_used: List[str] = []
        if ref_paths:
            try:
                ref_images, ref_used = load_reference_images(ref_paths, warnings)
            except EngineError:
                raise
            if not ref_images:
                warnings.append(
                    "参考图一张都读不出来（路径不存在 / 不是图片 / 无权限）：本次按**纯文生图**出图，"
                    "参考图未生效。请检查连线的图像节点是否已产出图。"
                )
                log("参考图全部不可用，退回纯文生图：" + ", ".join(ref_paths)[:400])
        if ref_images:
            budget = ref_input_max_pixels(len(ref_images))
            self.progress.set(
                "load_model", 8,
                f"已载入 {len(ref_images)} 张参考图（图像编辑模式 · it2i_generate，"
                f"输入预算 ≤{budget} 像素/张）",
            )
            log(
                f"图像编辑模式：{len(ref_images)} 张参考图 → {', '.join(ref_used)[:400]}"
                f"（输入预算 ≤{budget} 像素/张）"
            )
            if img_cfg_scale <= 1.0:
                warnings.append(
                    "参考图条件强度 imgCfgScale=1.0（图像 CFG 关闭，官方默认）：参考图只作为前缀图像条件，"
                    "不参与 CFG 对比；要更强地贴参考图可把它调到 1.5~2.0。"
                )
            # 编辑模式天然比文生图慢：上游 it2i 在 cfg_scale>1 且 img_cfg_scale=1 时，前缀阶段要把
            # **参考图**整个再跑一遍（query_condition + query_img_condition），采样期每步再算两遍
            # （out_cond / out_img_cond）。这句是「图参考模式为什么非常慢」的现场结论，别静默。
            if cfg_scale > 1.0:
                extra = (
                    "把 imgCfgScale 提到与 cfgScale 相同（如都 4.0）可省掉那次重复的参考图前缀；"
                    if abs(img_cfg_scale - cfg_scale) > 1e-6
                    else ""
                )
                warnings.append(
                    f"图像编辑模式慢于文生图属上游口径：cfgScale={cfg_scale:g} 且 imgCfgScale={img_cfg_scale:g} 时，"
                    f"参考图前缀要跑两遍、采样每步算两遍；{extra}降 cfgScale 到 1（单分支）或降 numSteps 都能显著提速。"
                )

        effective_mode = vram_mode
        attempt = 0
        model: Any = None
        tokenizer: Any = None
        while True:
            attempt += 1
            try:
                model, tokenizer = self.ensure_loaded(dtype, effective_mode, attn_backend, device)
                break
            except EngineError as e:
                # 加载期 OOM 已在 ensure_loaded 内部降过一次档；这里再兜一层：
                # 若用户显式传了 full 且机器确实装不下，给一次 low 的机会。
                nxt = VRAM_MODE_FALLBACK.get(effective_mode, "")
                if e.code == "model_load_failed" and _looks_oom(e.message) and nxt and attempt <= 2:
                    warnings.append(f"vramMode={effective_mode} 显存不足，已自动降到 {nxt} 重试")
                    log(f"加载 OOM：自动降级 vramMode={nxt}（第 {attempt} 次尝试）")
                    self.close()
                    effective_mode = nxt
                    continue
                raise
        forced = getattr(self, "_forced_vram_mode", "") or ""
        if forced and forced != effective_mode:
            warnings.append(f"加载期显存不足，实际按 vramMode={forced} 运行")
            effective_mode = forced

        self.progress.set("sample", 15, f"开始采样（{num_steps} 步 · {width}x{height} · vramMode={effective_mode}）")
        self._reset_peak(device)
        out = self._run_generate(
            model, tokenizer, prompt=prompt, width=width, height=height, num_steps=num_steps,
            cfg_scale=cfg_scale, cfg_norm=cfg_norm, timestep_shift=timestep_shift,
            cfg_interval=cfg_interval, seed=seed, think=think, device=device, mode=effective_mode,
            images=ref_images, img_cfg_scale=img_cfg_scale,
        )
        self._capture_peak(device)
        if isinstance(out, (tuple, list)) and len(out) == 2 and hasattr(out[0], "detach"):
            tensor, think_text = out[0], str(out[1] or "")
        else:
            tensor, think_text = out, ""
        self._check_cancel()

        self.progress.set("decode", 95, "反归一化并写出 PNG")
        try:
            self._save_png(tensor, image_path, device)
        except EngineError:
            raise
        except Exception as e:
            raise EngineError("save_failed", f"图片写出失败（{image_path}）：{str(e)[:300]}") from e
        if not image_path.is_file():
            raise EngineError("save_failed", f"图片未落盘：{image_path}")

        warnings.append(f"实际显存模式 vramMode={effective_mode}；峰值显存 "
                        f"{(self.peak_vram_gib or 0):.2f}GiB（不够就再降一档）")
        think_path: Optional[Path] = None
        if think and think_text:
            think_path = image_path.with_name(image_path.stem + ".think.txt")
            try:
                think_path.write_text(think_text, encoding="utf-8")
            except Exception as e:
                warnings.append(f"think 文本落盘失败：{str(e)[:160]}")
                think_path = None
        files = sorted(str(p) for p in out_dir.rglob("*") if p.is_file())
        log(f"生成完成：{image_path}（{width}x{height} / {num_steps} 步 / "
            f"用时 {self.progress.elapsed_sec:.1f}s / 峰值显存 {self.peak_vram_gib:.2f}GiB）")
        return {
            "imagePath": str(image_path),
            "outputDir": str(out_dir),
            "artifacts": files,
            "width": int(width),
            "height": int(height),
            "ratio": self._ratio_of(width, height),
            "vramMode": effective_mode,
            "dtype": dtype,
            "attnBackend": self.effective_attn_backend or attn_backend,
            "peakVramGiB": round(float(self.peak_vram_gib), 2),
            "thinkText": think_text,
            "thinkPath": str(think_path) if think_path else "",
            "mode": "edit" if ref_images else "t2i",
            "refImages": ref_used,
            "refImagesUsed": len(ref_images),
            "imgCfgScale": float(img_cfg_scale),
            "warnings": warnings,
        }

    def _run_generate(self, model: Any, tokenizer: Any, **kw: Any) -> Any:
        """进 offload 上下文跑一次 ``t2i_generate`` / ``it2i_generate``，进度与取消都挂在 unpatchify 钩子上。

        ``kw["images"]`` 非空 → 走 ``it2i_generate``（参考图作图像条件，官方 editing 示例口径）；
        空 → 走 ``t2i_generate``（纯文生图，与本引擎原行为逐字一致）。

        上下文每次生成各进一次（与上游 examples / ComfyUI 版一致）：官方
        ``LayerOffloadWrapper`` 在退出时会把层退回 CPU 并释放 pinned host cache，
        所以「权重常驻 Python 对象 + 每次生成重新进卸载上下文」才是省显存的正确姿势。
        """
        from sensenova_u1.utils import make_offload_ctx

        mode = str(kw["mode"])
        device = str(kw["device"])
        num_steps = int(kw["num_steps"])
        prefetch = VRAM_MODE_TO_PREFETCH.get(mode, 2)
        try:
            from sensenova_u1.utils import vram_mode_keeps_generation_resident

            keep_resident = bool(vram_mode_keeps_generation_resident(mode))
        except Exception:
            keep_resident = mode == "fast"  # 上游同名函数的实现口径（mode == "fast"）
        kwargs: Dict[str, Any] = {
            "keep_generation_resident": keep_resident,
            "fast_vram_fraction": _as_float(os.environ.get("SENSENOVA_FAST_VRAM_FRACTION")) or 0.90,
            "fast_vram_headroom_gib": _as_float(os.environ.get("SENSENOVA_FAST_VRAM_HEADROOM_GIB")) or 2.0,
            "fast_activation_reserve_gib": _as_float(os.environ.get("SENSENOVA_FAST_ACTIVATION_RESERVE_GIB")) or 4.0,
        }
        budget = _as_float(os.environ.get("SENSENOVA_FAST_VRAM_BUDGET_GIB"))
        if budget and budget > 0:
            kwargs["fast_vram_budget_gib"] = budget  # 绝对预算，覆盖 fraction 自动预算
        ctx = make_offload_ctx(model, prefetch, device, **kwargs)
        hook = self._install_step_hook(model, num_steps)
        try:
            with ctx as offloaded:
                import torch

                images = list(kw.get("images") or [])
                gen_name = "it2i_generate" if images else "t2i_generate"
                gen = getattr(offloaded, gen_name, None) or getattr(model, gen_name, None)
                if not callable(gen):
                    raise EngineError(
                        "model_load_failed",
                        f"已加载的模型没有 {gen_name}()：sensenova_u1 包版本过旧或与权重不匹配，"
                        "重跑 scripts\\install.ps1 更新到最新 tag",
                    )

                # 用 torch.no_grad() 而不是 torch.inference_mode()：
                # inference_mode 造出的张量带 "inference tensor" 标记，而 sensenova_u1 的
                # NEO-ViT 会把首次前向里现造的 rotary cos/sin 表**缓存在模块上**
                # （modeling_neo_vit.apply_rotary_emb_1d 里 `cos_cached[positions]`）。
                # 缓存张量因此成了 inference 张量，本进程第二次 /generate 复用它会直接抛
                # `RuntimeError: Inference tensors do not track version counter.`
                # —— 表现是「第一次出图成功，之后每次 500」。no_grad 下缓存张量是普通张量，
                # 跨次调用安全；本场景没有反传，省下的那点开销可忽略。
                with torch.no_grad():
                    common: Dict[str, Any] = {
                        "image_size": (int(kw["width"]), int(kw["height"])),
                        "cfg_scale": float(kw["cfg_scale"]),
                        "cfg_norm": str(kw["cfg_norm"]),
                        "timestep_shift": float(kw["timestep_shift"]),
                        "cfg_interval": tuple(kw["cfg_interval"]),
                        "num_steps": num_steps,
                        "batch_size": 1,
                        "seed": int(kw["seed"]),
                        "think_mode": bool(kw["think"]),
                    }
                    if images:
                        # 参考图路径：it2i_generate(tokenizer, prompt, images, …)，images 是 PIL 列表；
                        # img_cfg_scale 是它独有的参数（1.0 = 图像 CFG 关闭，官方默认）
                        return gen(
                            tokenizer,
                            str(kw["prompt"]),
                            images,
                            img_cfg_scale=float(kw.get("img_cfg_scale") or DEFAULT_IMG_CFG_SCALE),
                            **common,
                        )
                    return gen(tokenizer, str(kw["prompt"]), **common)
        finally:
            self._uninstall_step_hook(model, hook)

    def _install_step_hook(self, model: Any, total_steps: int) -> Dict[str, Any]:
        """临时替换 ``model.unpatchify``（每个采样步恰好调用一次）→ 进度 + 取消。

        与官方 ComfyUI 版 ``_progress_hook`` 同一口径；不可用时静默退回「只有阶段进度」。
        """
        original = getattr(model, "unpatchify", None)
        if not callable(original):
            return {}
        counter = {"n": 0}

        def wrapped(*args: Any, **kwargs: Any) -> Any:
            out = original(*args, **kwargs)
            counter["n"] += 1
            if self._cancel.is_set():
                raise Cancelled("用户取消")
            self.progress.step_done(counter["n"], total_steps)
            return out

        try:
            model.unpatchify = wrapped  # type: ignore[attr-defined]
        except Exception:
            return {}
        return {"original": original, "counter": counter}

    def _uninstall_step_hook(self, model: Any, hook: Dict[str, Any]) -> None:
        if not hook:
            return
        try:
            del model.unpatchify  # 恢复类级绑定（官方同款做法）
        except Exception:
            try:
                model.unpatchify = hook.get("original")  # type: ignore[attr-defined]
            except Exception:
                pass
        n = int((hook.get("counter") or {}).get("n") or 0)
        if n:
            log(f"采样共推进 {n} 步")

    @staticmethod
    def _save_png(tensor: Any, path: Path, device: str) -> None:
        """``[B,3,H,W]`` 归一化张量 → 反归一化 (x*0.5+0.5).clamp(0,1) → PNG（对齐上游 _denorm/_to_pil）。"""
        import numpy as np
        import torch
        from PIL import Image

        x = tensor
        if hasattr(x, "detach"):
            x = x.detach()
        if x.ndim == 3:
            x = x.unsqueeze(0)
        if x.dtype in (torch.float16, torch.bfloat16, torch.float32, torch.float64):
            x = (x.float() * 0.5 + 0.5).clamp(0, 1)
            arr = (x.permute(0, 2, 3, 1).cpu().numpy() * 255.0).round().astype(np.uint8)
        else:
            arr = x.permute(0, 2, 3, 1).cpu().numpy().astype(np.uint8)
        first = arr[0]
        Image.fromarray(first).save(str(path), format="PNG")
        try:
            if device.startswith("cuda"):
                torch.cuda.empty_cache()
        except Exception:
            pass

    def _reset_peak(self, device: str) -> None:
        self.peak_vram_gib = 0.0
        try:
            import torch

            if device.startswith("cuda") and torch.cuda.is_available():
                torch.cuda.reset_peak_memory_stats()
        except Exception:
            pass

    def _capture_peak(self, device: str) -> None:
        try:
            import torch

            if device.startswith("cuda") and torch.cuda.is_available():
                self.peak_vram_gib = float(torch.cuda.max_memory_allocated()) / (1024**3)
        except Exception:
            pass

    @staticmethod
    def _ratio_of(width: int, height: int) -> str:
        for ratio, (w, h) in SUPPORTED_RESOLUTIONS.items():
            if (w, h) == (int(width), int(height)):
                return ratio
        return f"{width}x{height}"

    # ---------------- mock（契约冒烟 / 联调，不加载模型、不需要 torch） ----------------

    def _mock_run(self, prompt: str, width: int, height: int, seed: int, num_steps: int,
                  out_dir: Path, image_path: Path, think: bool,
                  ref_paths: Optional[List[str]] = None,
                  img_cfg_scale: float = DEFAULT_IMG_CFG_SCALE) -> Dict[str, Any]:
        self.progress.set("generate", 40, "mock 模式：不加载模型，按入参造占位 PNG")
        # mock 也走一遍采样步计数，方便宿主/节点在**不加载模型**的情况下联调进度条与取消
        delay = _as_float(os.environ.get("SENSENOVA_MOCK_DELAY_SEC"))
        per_step = (delay if delay and delay > 0 else 0.2) / max(1, num_steps)
        for step in range(1, num_steps + 1):
            time.sleep(per_step)
            self.progress.step_done(step, num_steps)
            self._check_cancel()
        warnings: List[str] = []
        # mock 不加载模型，参考图只核「文件读得到」，用于联调宿主的图像编辑模式开关；
        # 读不到同样只警告 + 跳过（真实路径由模型侧解码，行为与本口径一致）
        ref_used: List[str] = []
        for p in ref_paths or []:
            try:
                if Path(p).is_file():
                    ref_used.append(p)
                else:
                    raise FileNotFoundError(p)
            except Exception as e:
                msg = f"参考图读取失败，已跳过：{p}（{str(e)[:160]}）"
                log(msg)
                warnings.append(msg)
        if ref_paths and not ref_used:
            warnings.append("参考图一张都读不出来：本次按**纯文生图**出图，参考图未生效。")
        try:
            _write_placeholder_png(image_path, width, height, prompt)
        except Exception as e:
            raise EngineError("save_failed", f"mock 占位图写出失败（{image_path}）：{str(e)[:200]}") from e
        self._check_cancel()
        think_text = ""
        think_path: Optional[Path] = None
        if think:
            think_text = (
                "<think>\n(mock) 这是一段占位思维链，真实生成时这里是模型的规划文本；"
                f"prompt={prompt[:80]}\n</think>\n"
            )
            think_path = image_path.with_name(image_path.stem + ".think.txt")
            think_path.write_text(think_text, encoding="utf-8")
        (out_dir / "settings.json").write_text(
            json.dumps(
                {
                    "mock": True, "model": MODEL_REPO, "modelSource": self.model_source,
                    "prompt": prompt, "width": width, "height": height, "seed": seed,
                    "numSteps": num_steps, "think": bool(think),
                    "mode": "edit" if ref_used else "t2i",
                    "refImages": ref_used, "imgCfgScale": float(img_cfg_scale),
                },
                ensure_ascii=False, indent=2,
            ),
            encoding="utf-8",
        )
        self.progress.set("save", 96, f"mock 产物已落盘 → {out_dir}")
        files = sorted(str(p) for p in out_dir.rglob("*") if p.is_file())
        return {
            "imagePath": str(image_path),
            "outputDir": str(out_dir),
            "artifacts": files,
            "width": int(width),
            "height": int(height),
            "ratio": self._ratio_of(width, height),
            "vramMode": self.env_vram_mode(),
            "dtype": self.env_dtype(),
            "attnBackend": self.env_attn_backend(),
            "peakVramGiB": 0.0,
            "thinkText": think_text,
            "thinkPath": str(think_path) if think_path else "",
            "mode": "edit" if ref_used else "t2i",
            "refImages": ref_used,
            "refImagesUsed": len(ref_used),
            "imgCfgScale": float(img_cfg_scale),
            "warnings": warnings,
        }


def _write_placeholder_png(path: Path, width: int, height: int, prompt: str) -> None:
    """占位图：优先 PIL（带分辨率与种子文字），PIL 不可用时退回纯标准库最小 PNG。"""
    try:
        from PIL import Image, ImageDraw

        img = Image.new("RGB", (int(width), int(height)), (24, 28, 38))
        d = ImageDraw.Draw(img)
        step = max(16, min(width, height) // 24)
        for y in range(0, height, step):
            tone = 40 + (y // step) * 3 % 90
            d.line([(0, y), (width, y)], fill=(tone, 30, 90 - tone // 3))
        d.rectangle([8, 8, min(width - 8, 560), min(height - 8, 200)], outline=(255, 214, 92), width=3)
        text = f"MTNode SenseNova MOCK {width}x{height}"
        d.text((20, 24), text, fill=(255, 255, 255))
        d.text((20, 48), (prompt or "")[:120], fill=(210, 210, 210))
        path.parent.mkdir(parents=True, exist_ok=True)
        img.save(str(path), format="PNG")
        return
    except Exception:
        pass
    import struct
    import zlib

    w, h = max(1, int(width)), max(1, int(height))
    row = bytearray()
    for x in range(w):
        row += bytes(((x * 7) % 256, (x * 13) % 128, 90))
    raw = b"".join(b"\x00" + bytes(row) for _ in range(h))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 6))
           + chunk(b"IEND", b""))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png)


def describe_env() -> Dict[str, Any]:
    """把当前生效的环境变量口径回一行，供启动日志打印（用户排错主要靠它）。"""
    eng = SenseNovaEngine()
    return {
        "vramMode": eng.env_vram_mode(),
        "dtype": eng.env_dtype(),
        "attnBackend": eng.env_attn_backend(),
        "device": eng.pick_device(),
        "modelSource": eng.model_source,
    }


# stdout 被宿主重定向到 console.log 时，print 到 stderr 的行缓冲行为不一致；
# 这里显式用 UTF-8 写，避免 GBK 控制台下模型库的进度条把服务进程打崩。
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except Exception:
        pass
