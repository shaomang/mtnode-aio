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

修法：在构造 GraphAR 之前，把 `attention_backend="auto"` 换成**本机默认档 `cudnn`**
（`_DEFAULT_BACKEND`）—— 不再按 flash → cudnn → sdpa 依次探针选档：那套要白等最长 180 s，
探针失败还会回落 sdpa、却报出「已改用 cudnn」的自相矛盾文案。只包一层 `GraphAR.__init__`，
不改 upstream 源码，重复调用幂等；因此重装 yue2 包也无需重新打补丁。

要换档只有显式一条路（**默认档不自动降级**）：`YUE2_ATTENTION_BACKEND`（最高优先），
或在 `<INSTALL_DIR>\\.attention-backend` 里写**单行纯文本** `sdpa` / `flash`。
真跑一次的确认由宿主在启动后端前做（`scripts\\probe_attention.py --only <档>`），
后端进程内也可用 `best_attention_backend(verify=True)` 就地验一次。

**接线（重要）**：本模块自身不会生效，必须有人在构造 pipeline 之前调用
`apply_yue2_windows_patch()`。接线点就在 `app/engine.py`（import 期 + `_new_pipeline()` 前各一次）。
另外：MTNode 插件每次启服务都会用 `yue-pack/app/*.py` 覆盖安装目录的 `app/`
（`yue/main-yue.js` 的 `syncPackAppToInstall`），所以 `engine.py` 与本文件必须**同时**存在
安装目录和仓库脚手架 `yue-pack/app/`，只改安装目录会在下一次 `[sync] pack app/*.py` 时被回滚。

环境变量：
    YUE2_ATTENTION_BACKEND=flash|cudnn|sdpa  （显式指定，最高优先：直接信任该档，不探针）
    YUE2_ATTENTION=...                       （旧名，等价；两都设时以 YUE2_ATTENTION_BACKEND 为准）
    YUE2_SKIP_ATTENTION_PATCH=1              （跳过补丁，纯排查用）

档位记录：`<INSTALL_DIR>\\.attention-backend`（JSON：生效档位 + 来源 + 各档 PASS/FAIL + torch / 设备），
供安装脚本、宿主与人工排查共用；对应脚本 `scripts\\probe_attention.py`。
**这份 JSON 是记录，不是设置**：带 `{` 的文件一律不当作覆盖（旧的 `source=probe:…` / `forced:…` /
`fallback:…` 都是上一版宿主与探针自己留下的痕迹）；只有**单行纯文本**才算人写的覆盖。

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
BACKENDS = ("flash", "cudnn", "sdpa")
# 默认档：本机实测可用档里最快的那档（flash 在 Windows 轮子里没编 kernel，永不自动选）
_DEFAULT_BACKEND = "cudnn"
# 诊断 / 手工排查的展示顺序（默认档在最前）；**不再用于自动选档**
_ORDER = ("cudnn", "sdpa", "flash")
_VALID = ("auto",) + BACKENDS
_ENV_PRIMARY = "YUE2_ATTENTION_BACKEND"
_ENV_LEGACY = "YUE2_ATTENTION"

_LOCK = threading.Lock()
_CACHED: Optional[str] = None
_CHECKED: Dict[str, Dict[str, Any]] = {}
_APPLIED = False

_LABELS = {
    "flash": "flash（aten 原生 op）",
    "cudnn": "cudnn（SDPA CUDNN_ATTENTION）",
    "sdpa": "sdpa（SDPA 默认后端）",
}


class AttentionBackendUnsupported(RuntimeError):
    """生效档位实测跑不起来（`best_attention_backend(verify=True)` 单档真跑 FAIL 时抛）。

    `code` 与 `EngineError` 同一套短码口径，`app/engine.py` 会把它翻成
    `EngineError("attention_backend_unsupported", ...)`，避免宿主只看到裸英文 torch 断言。
    **不自动降级**：换档由用户显式指定（env 或 `.attention-backend` 单行文本）。
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
    """读**环境变量**里的显式覆盖：`YUE2_ATTENTION_BACKEND`（优先）→ `YUE2_ATTENTION`（旧名）。

    合法值直接强制该档；空 / 非法 → "auto"（= 不是显式覆盖，走 `resolve_backend()` 的默认口径）。
    """
    for key in (_ENV_PRIMARY, _ENV_LEGACY):
        raw = (os.environ.get(key) or "").strip().lower()
        if raw:
            return raw if raw in _VALID else "auto"
    return "auto"


def file_backend() -> str:
    """读安装目录 `.attention-backend` 里**人写的**覆盖：单行纯文本才算。

    带 `{` 的 JSON 是探针 / 宿主留下的记录（`source=probe:…` / `forced:…` / `fallback:…`），
    一律不当设置 —— 旧版宿主自己注入 env 也会在那份记录里留 `forced:` 痕迹，
    若当作用户设置，本机会永远沿用旧档（实测就是 sdpa），改了默认也看不到效果。
    """
    try:
        raw = (_INSTALL_DIR / ".attention-backend").read_text(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001 - 没有文件就是没覆盖
        return ""
    text = raw.strip()
    if not text or text.startswith("{"):
        return ""
    first = text.splitlines()[0].strip().lower()
    return first if first in BACKENDS else ""


def resolve_backend() -> Tuple[str, str]:
    """生效档位 + 来源（同步口径，不探针）：env → 文件单行文本 → 默认 `cudnn`。

    返回 `(backend, source)`，source ∈ `"env"` / `"file"` / `"default"`。
    """
    forced = forced_backend()
    if forced != "auto":
        return forced, "env"
    from_file = file_backend()
    if from_file:
        return from_file, "file"
    return _DEFAULT_BACKEND, "default"


def _skip_patch() -> bool:
    return (os.environ.get("YUE2_SKIP_ATTENTION_PATCH") or "").strip() == "1"


# ---------------------------------------------------------------------------
# 真跑探针：schema 在 ≠ kernel 在 —— 每个档都真调一次极小前向
# （宿主启动快检只探生效档一档；--all 才三档都探，仅手工排查）
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


def probe_backends(*, only: str = "", force_cpu: bool = False) -> Dict[str, Dict[str, Any]]:
    """真跑探针，返回 {档位: {ok, label, detail}}。

    `only` 给合法档位时**只探那一档**（宿主启动快检只探生效档一档，几秒~十几秒）；
    留空 = 按 `_ORDER`（cudnn → sdpa → flash）全探一轮，仅供手工排查。
    """
    names = (only,) if only in BACKENDS else _ORDER
    out: Dict[str, Dict[str, Any]] = {}
    for name in names:
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


def check_backend(name: str, *, force_cpu: bool = False) -> Tuple[bool, str]:
    """就**一个档位**真跑一次前向并缓存结论（进程内），返回 (ok, detail)。

    这是本版唯一会自动跑的实测：宿主启动时对生效档（缺省 cudnn）做一次，
    引擎构造 pipeline 前再核一次（命中进程内缓存即零成本）。
    """
    key = "cpu" if force_cpu else name
    hit = _CHECKED.get(key)
    if hit:
        return bool(hit["ok"]), str(hit["detail"])
    probes = probe_backends(only=name, force_cpu=force_cpu)
    p = probes.get(name) or {"ok": False, "detail": "未知档位"}
    _CHECKED[key] = {"ok": bool(p["ok"]), "detail": str(p["detail"])}
    return bool(p["ok"]), str(p["detail"])


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
    """档位记录落 `<INSTALL_DIR>\\.attention-backend`（排查用，失败不影响生成）。

    注意：这份 JSON 是**记录不是设置**（`file_backend()` 只认单行纯文本）。
    """
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


def _source_label(source: str) -> str:
    return {
        "env": f"override:{_ENV_PRIMARY} / {_ENV_LEGACY}",
        "file": "override:.attention-backend（单行文本）",
        "default": f"default:{_DEFAULT_BACKEND}",
    }.get(source, source or "default")


def best_attention_backend(*, force_cpu: bool = False, use_cache: bool = True,
                           verify: bool = False) -> str:
    """返回本机 GraphAR 该用的注意力后端：`flash` / `cudnn` / `sdpa`。

    - 显式覆盖优先（env → 安装目录 `.attention-backend` 单行文本）→ 直接信任，不探针；
    - 否则就是**默认档 `cudnn`**（不再三档探针选档，启动不再白等那 180 s）；
    - `verify=True` 时只真跑**生效档一档**确认能跑，跑不了抛 `AttentionBackendUnsupported`
      （短码 attention_backend_unsupported）—— **不自动降级**：换档由用户显式指定。
    - CPU（`force_cpu=True`）→ `sdpa`（CPU 上没有 cuDNN attention）。
    """
    global _CACHED
    if force_cpu:
        return "sdpa"
    backend, source = resolve_backend()
    with _LOCK:
        if verify:
            ok, detail = check_backend(backend)
            if not ok:
                probes = {backend: {"ok": False, "label": _LABELS[backend], "detail": detail}}
                _write_cache(backend, probes, _source_label(source) + "（实测 FAIL）")
                raise AttentionBackendUnsupported(
                    f"本机注意力档位 {backend} 实测跑不起来：{detail}。本版默认 {_DEFAULT_BACKEND} 且"
                    f"**不自动降级**：请显式改档（{_ENV_PRIMARY}=sdpa|cudnn|flash，"
                    f"或在 .attention-backend 里写单行文本）后重启；"
                    f"各档实测见 scripts\\probe_attention.py，记录：{cache_file()}",
                    probes,
                )
        if use_cache and _CACHED == backend:
            return backend
        _CACHED = backend
        _write_cache(backend, {}, _source_label(source))
        return backend


def apply_yue2_windows_patch() -> bool:
    """把 GraphAR 的 attention_backend="auto" 换成生效档位（默认 cudnn）。返回是否已生效。"""
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
                try:
                    device_type = next(model.parameters()).device.type
                except Exception:
                    device_type = "cuda"
                if device_type == "cuda":
                    attention_backend = best_attention_backend()  # 默认 cudnn / 显式覆盖；不探针
                else:
                    attention_backend = "sdpa"
            return original(self, model, prefixes, max_tokens, capture=capture,
                            attention_backend=attention_backend, fuse_projections=fuse_projections)

        patched.__wrapped__ = original  # type: ignore[attr-defined]
        patched.__name__ = getattr(original, "__name__", "__init__")
        cg.GraphAR.__init__ = patched
        _APPLIED = True
        return True


def describe() -> str:
    """一行说明当前补丁与档位（写日志 / 排查用）。"""
    backend, source = resolve_backend()
    if _skip_patch():
        return "已禁用（YUE2_SKIP_ATTENTION_PATCH=1）"
    if not _APPLIED:
        return "未生效（GraphAR 未打补丁，真实生成可能报 USE_FLASH_ATTENTION）"
    if source == "env":
        return f"已生效（{_ENV_PRIMARY}={backend} 显式指定）"
    if source == "file":
        return f"已生效（.attention-backend 单行文本 = {backend}）"
    return f"已生效（默认档 {backend}；不自动降级，换档请显式指定）"
