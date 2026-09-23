"""Windows 移植补丁：修正 yue2 的 GraphAR 注意力后端自动判定（upstream 在 Windows 上会误判）。

问题（本机 RTX 4090 / torch 2.10.0+cu130 / Windows，实测）：

    yue2/cuda_graph.py 用
        hasattr(torch.ops.aten, "_flash_attention_forward")
        and "seqused_k" in <该 op 的 schema>
    来判断「本机能不能用原生 flash attention」。

    Windows 版 PyTorch 轮子**带 op 的 schema，却没把 CUDA flash kernel 编进来**：
    schema 判断通过 → attention_backend="auto" 选成 "flash" →
    真实生成时报 `USE_FLASH_ATTENTION was not enabled for build.`（生成直接失败）。

实测（`scripts\\probe_attention.py` 的原始输出）：
    flash（aten 原生 op）        FAIL  USE_FLASH_ATTENTION was not enabled for build.
    flash（SDPA FLASH_ATTENTION）FAIL  No available kernel.
    sdpa（默认）                 PASS
    cudnn（SDPA CUDNN_ATTENTION）PASS   ← 本机可用的最快档

修法：在构造 GraphAR 之前，把 `attention_backend="auto"` 换成**实测探针**得到的可用档位
（flash → cudnn → sdpa 依次降级）。只包一层 `GraphAR.__init__`，不改 upstream 源码，
重复调用幂等；因此重装 yue2 包也无需重新打补丁。

**接线（重要）**：本模块自身不会生效，必须有人在构造 pipeline 之前调用
`apply_yue2_windows_patch()`。接线点就在 `app/engine.py`（import 期 + `_new_pipeline()` 前各一次）。
另外：MTNode 插件每次启服务都会用 `yue-pack/app/*.py` 覆盖安装目录的 `app/`
（`yue/main-yue.js` 的 `syncPackAppToInstall`），所以 `engine.py` 与本文件必须**同时**存在
安装目录和仓库脚手架 `yue-pack/app/`，只改安装目录会在下一次 `[sync] pack app/*.py` 时被回滚。

环境变量：
    YUE2_ATTENTION_BACKEND=auto|flash|cudnn|sdpa  （默认 auto = 实测探针；显式值 = 直接信任该档，跳过探针）
    YUE2_ATTENTION=...                            （旧名，等价；两都设时以 YUE2_ATTENTION_BACKEND 为准）
    YUE2_SKIP_ATTENTION_PATCH=1                   （跳过补丁，纯排查用）

探针记录：`<INSTALL_DIR>\\.attention-backend`（JSON：最终档位 + 各档 PASS/FAIL + torch / 设备），
供安装脚本、宿主与人工排查共用；对应脚本 `scripts\\probe_attention.py`。

代价：本机用 cuDNN attention 而不是 flash，速度略慢，但能跑 —— 这正是本 skill
「Windows 移植口径」要说明的取舍。
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

_INSTALL_DIR = Path(__file__).resolve().parent.parent
_ORDER = ("flash", "cudnn", "sdpa")
_VALID = ("auto",) + _ORDER
_ENV_PRIMARY = "YUE2_ATTENTION_BACKEND"
_ENV_LEGACY = "YUE2_ATTENTION"

_LOCK = threading.Lock()
_CACHED: Optional[str] = None
_APPLIED = False

_LABELS = {
    "flash": "flash（aten 原生 op）",
    "cudnn": "cudnn（SDPA CUDNN_ATTENTION）",
    "sdpa": "sdpa（SDPA 默认后端）",
}


class AttentionBackendUnsupported(RuntimeError):
    """实测所有注意力档位都跑不通（CUDA 在，但 flash / cudnn / sdpa 全 FAIL）。

    `code` 与 `EngineError` 同一套短码口径，`app/engine.py` 会把它翻成
    `EngineError("attention_backend_unsupported", ...)`，避免宿主只看到裸英文 torch 断言。
    """

    code = "attention_backend_unsupported"

    def __init__(self, message: str, probes: Optional[Dict[str, Dict[str, Any]]] = None) -> None:
        super().__init__(message)
        self.message = message
        self.probes = probes or {}


def cache_file() -> str:
    """探针记录文件（JSON）路径：`<INSTALL_DIR>\\.attention-backend`。"""
    return str(_INSTALL_DIR / ".attention-backend")


def forced_backend() -> str:
    """读显式覆盖：`YUE2_ATTENTION_BACKEND`（优先）→ `YUE2_ATTENTION`（旧名）。

    合法值直接强制该档；空 / 非法 → "auto"（走实测探针）。
    """
    for key in (_ENV_PRIMARY, _ENV_LEGACY):
        raw = (os.environ.get(key) or "").strip().lower()
        if raw:
            return raw if raw in _VALID else "auto"
    return "auto"


def _skip_patch() -> bool:
    return (os.environ.get("YUE2_SKIP_ATTENTION_PATCH") or "").strip() == "1"


# ---------------------------------------------------------------------------
# 真跑探针：schema 在 ≠ kernel 在，三个档各跑一次极小前向
# ---------------------------------------------------------------------------


def _probe_flash() -> Tuple[bool, str]:
    """原生 aten flash attention：真调一次（Windows 轮子常常只有 schema）。"""
    try:
        import torch

        if not hasattr(torch.ops.aten, "_flash_attention_forward"):
            return False, "aten._flash_attention_forward 不存在"
        if not torch.cuda.is_available():
            return False, "无 CUDA"
        dtype = torch.bfloat16
        q = torch.randn(1, 2, 4, 64, device="cuda", dtype=dtype)
        k = torch.randn(1, 2, 6, 64, device="cuda", dtype=dtype)
        v = torch.randn(1, 2, 6, 64, device="cuda", dtype=dtype)
        torch.ops.aten._flash_attention_forward(q, k, v, None, None, 4, 6, 0.0, False, False)
        torch.cuda.synchronize()
        return True, "调用成功"
    except Exception as e:  # noqa: BLE001 - 探针只回结论
        return False, str(e)[:200]


def _probe_cudnn() -> Tuple[bool, str]:
    """cuDNN attention（SDPA 的 CUDNN_ATTENTION 后端）实际能不能跑。"""
    try:
        import torch
        import torch.nn.functional as F
        from torch.nn.attention import SDPBackend, sdpa_kernel

        if not torch.cuda.is_available():
            return False, "无 CUDA"
        if not torch.backends.cudnn.is_available():
            return False, "torch.backends.cudnn 不可用"
        q = torch.randn(1, 2, 8, 64, device="cuda", dtype=torch.bfloat16)
        with sdpa_kernel(SDPBackend.CUDNN_ATTENTION):
            out = F.scaled_dot_product_attention(q, q, q)
        torch.cuda.synchronize()
        return True, f"前向成功 {tuple(out.shape)}"
    except Exception as e:  # noqa: BLE001
        return False, str(e)[:200]


def _probe_sdpa() -> Tuple[bool, str]:
    """SDPA 默认后端（auto 选核）：作为最后兜底档，必须真跑一次确认。"""
    try:
        import torch
        import torch.nn.functional as F

        if not torch.cuda.is_available():
            return False, "无 CUDA"
        q = torch.randn(1, 2, 8, 64, device="cuda", dtype=torch.bfloat16)
        out = F.scaled_dot_product_attention(q, q, q)
        torch.cuda.synchronize()
        return True, f"前向成功 {tuple(out.shape)}"
    except Exception as e:  # noqa: BLE001
        return False, str(e)[:200]


_PROBES = {"flash": _probe_flash, "cudnn": _probe_cudnn, "sdpa": _probe_sdpa}


def probe_backends(*, force_cpu: bool = False) -> Dict[str, Dict[str, Any]]:
    """逐档真跑探针，按 flash → cudnn → sdpa 返回 {档位: {ok, label, detail}}。"""
    out: Dict[str, Dict[str, Any]] = {}
    for name in _ORDER:
        if force_cpu:
            out[name] = {
                "ok": name == "sdpa",
                "label": _LABELS[name],
                "detail": "CPU 设备：不用探针，直接走 sdpa",
            }
            continue
        try:
            ok, detail = _PROBES[name]()
        except Exception as e:  # noqa: BLE001 - 探针自身异常也算 FAIL
            ok, detail = False, str(e)[:200]
        out[name] = {"ok": bool(ok), "label": _LABELS[name], "detail": detail}
    return out


def _env_info() -> Dict[str, Any]:
    info: Dict[str, Any] = {}
    try:
        import torch

        info["torch"] = str(torch.__version__)
        info["cuda"] = str(getattr(torch.version, "cuda", "") or "")
        if torch.cuda.is_available():
            try:
                info["device"] = str(torch.cuda.get_device_name(0))
            except Exception:  # noqa: BLE001
                info["device"] = "cuda"
    except Exception:  # noqa: BLE001 - 没装 torch 也能落一份记录
        pass
    return info


def _write_cache(backend: str, probes: Dict[str, Dict[str, Any]], source: str) -> None:
    """探针结果落 `<INSTALL_DIR>\\.attention-backend`（排查用，失败不影响生成）。"""
    payload: Dict[str, Any] = {
        "backend": backend,
        "source": source,
        "probes": probes,
        "at": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    payload.update(_env_info())
    try:
        Path(cache_file()).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass


def best_attention_backend(*, force_cpu: bool = False, use_cache: bool = True) -> str:
    """返回本机 GraphAR 该用的注意力后端：flash / cudnn / sdpa。

    - `YUE2_ATTENTION_BACKEND` 显式给了合法值 → 直接信任（跳过探针，排查时不必等）；
    - 否则真跑探针，flash → cudnn → sdpa 取第一档 PASS；结果缓存（进程内 + 落盘记录）；
    - CUDA 在但三档全 FAIL → 抛 `AttentionBackendUnsupported`（短码 attention_backend_unsupported）。
    """
    global _CACHED
    forced = forced_backend()
    if forced != "auto":
        if use_cache and _CACHED is None:
            _CACHED = forced
            _write_cache(forced, {}, f"forced:{forced}（{_ENV_PRIMARY} / {_ENV_LEGACY}）")
        return forced
    with _LOCK:
        if use_cache and _CACHED:
            return _CACHED
        probes = probe_backends(force_cpu=force_cpu)
        picked = next((name for name in _ORDER if probes[name]["ok"]), "")
        if not picked:
            _write_cache("", probes, "probe: 全部 FAIL")
            detail = "；".join(f"{_LABELS[n]} = {probes[n]['detail']}" for n in _ORDER)
            raise AttentionBackendUnsupported(
                "本机没有可用的注意力后端（flash / cudnn / sdpa 实测全部失败）："
                + detail
                + f"。可设 {_ENV_PRIMARY}=sdpa|cudnn|flash 强制，或跑 scripts\\probe_attention.py 排查；"
                + f"探针记录：{cache_file()}",
                probes,
            )
        _CACHED = picked
        _write_cache(picked, probes, "probe: flash → cudnn → sdpa 依次降级")
        return picked


def apply_yue2_windows_patch() -> bool:
    """把 GraphAR 的 attention_backend="auto" 换成实测可用档位。返回是否已生效。"""
    global _APPLIED
    if _skip_patch():
        return False
    with _LOCK:
        if _APPLIED:
            return True
        try:
            from yue2 import cuda_graph as cg
        except Exception:
            return False

        original = cg.GraphAR.__init__

        def patched(self, model, prefixes, max_tokens, *, capture=True, attention_backend="auto",
                    fuse_projections=False):
            if attention_backend == "auto":
                forced = forced_backend()
                if forced != "auto":
                    attention_backend = forced  # 显式覆盖：直接信任，不探针
                else:
                    try:
                        device_type = next(model.parameters()).device.type
                    except Exception:
                        device_type = "cuda"
                    attention_backend = best_attention_backend() if device_type == "cuda" else "sdpa"
            return original(self, model, prefixes, max_tokens, capture=capture,
                            attention_backend=attention_backend, fuse_projections=fuse_projections)

        patched.__wrapped__ = original  # type: ignore[attr-defined]
        patched.__name__ = getattr(original, "__name__", "__init__")
        cg.GraphAR.__init__ = patched
        _APPLIED = True
        return True


def describe() -> str:
    """一行说明当前补丁与档位（写日志 / 排查用）。"""
    forced = forced_backend()
    if _skip_patch():
        return "已禁用（YUE2_SKIP_ATTENTION_PATCH=1）"
    if not _APPLIED:
        return "未生效（GraphAR 未打补丁，真实生成可能报 USE_FLASH_ATTENTION）"
    if forced != "auto":
        return f"已生效（{_ENV_PRIMARY}={forced} 强制档）"
    if _CACHED:
        return f"已生效（运行时实测探针，当前档位 = {_CACHED}）"
    return "已生效（运行时实测探针：flash → cudnn → sdpa 依次降级）"
