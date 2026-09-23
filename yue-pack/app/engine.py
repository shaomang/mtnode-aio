"""YuE2 推理引擎：懒加载 m-a-p/YuE2-3B + m-a-p/YuE2-Vae，一次生成一首歌。

官方用法（YuE2-3B 模型卡 Quick start）::

    from yue2 import YuE2Pipeline

    with YuE2Pipeline.from_pretrained("m-a-p/YuE2-3B", device="cuda") as pipe:
        song = pipe(style=style, lyrics=lyrics, cot="full", seed=seed)
        song.save("song.flac")
        song.save_artifacts("outputs/song")   # ABC、语义 token、latent、音频、settings

本后端把 `with` 块的生命周期从「一次请求」扩到「一次服务进程」：权重只在第一次
/generate 时加载并常驻（官方 4090 数据：一首 3.6 分钟的歌整段 71 秒，重新加载权重
占大头），关闭走 `/shutdown` 或 `engine.close()`。要官方的「每个请求重载一次」语义，
设 `YUE2_LOAD_PER_REQUEST=1`（此时每次 /generate 内部就是完整的一次 with 块）。

进度：`_StdoutTee` 把 pipeline 自己的英文阶段日志透传出去，同时映射成 staged 进度
（plan → semantic → synth → decode → save）；百分比只保证单调不回退，不承诺精确。
取消：`cancel()` 置位后在**下一条阶段日志**处抛 Cancelled 中止（torch kernel 已在跑时
不能抢占），中止后不写任何产物。
"""
from __future__ import annotations

import contextlib
import json
import os
import random
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

MODEL_ID = "m-a-p/YuE2-3B"
VAE_ID = "m-a-p/YuE2-Vae"
# cot（chain-of-thought 符号规划）三档：full = 旋律 + 和弦，melody = 只给旋律（翻唱推荐），off = 不做符号规划
COT_MODES = ("full", "melody", "off")
DEFAULT_COT = "full"

_ROOT = Path(__file__).resolve().parent.parent

_LOGGER: List[Optional[Callable[[str], None]]] = [None]

# Windows 注意力补丁的一次性状态（见 apply_windows_patch）；import 期即接线，
# 保证宿主（python -m app.ui）与自查服务（python -m app）两条入口都吃得到补丁。
_WINDOWS_PATCH: List[str] = [""]


def set_logger(fn: Callable[[str], None]) -> None:
    _LOGGER[0] = fn


def log(msg: str) -> None:
    fn = _LOGGER[0]
    if fn:
        fn(msg)
    else:
        try:
            print(f"[yue2] {msg}", flush=True)
        except Exception:
            pass


def apply_windows_patch() -> str:
    """幂等应用 `app/windows_patch.py` 的 GraphAR 注意力后端修正，返回一行说明（缓存）。

    为什么必须有这一步：Windows 版 torch 轮子**带 `_flash_attention_forward` 的 schema、
    却没编 CUDA flash kernel**，yue2 的 `attention_backend="auto"` 因此误判成 flash，
    真实生成必报 `USE_FLASH_ATTENTION was not enabled for build.`（本机实测：
    一次 31.9s 音频真实生成就是这么失败的，而同一环境走 cudnn 档可正常出歌）。

    注意：MTNode 插件每次启服务都会用 `yue-pack/app/*.py` 覆盖安装目录的 `app/`
    （main-yue2.js 的 syncPackAppToInstall），所以本文件与 `windows_patch.py`
    必须**同时**存在于安装目录与 `SCAFFOLD_REF\\yue-pack\\app\\`，只改一边会被回滚。
    """
    if _WINDOWS_PATCH[0]:
        return _WINDOWS_PATCH[0]
    try:
        from app import windows_patch  # app.engine 与 app 同包，两种入口都命中
    except Exception as exc:  # noqa: BLE001 - 补丁缺失不该拖垮引擎
        _WINDOWS_PATCH[0] = f"未接线（{str(exc)[:160]}）"
    else:
        try:
            applied = windows_patch.apply_yue2_windows_patch()
        except Exception as exc:  # noqa: BLE001
            _WINDOWS_PATCH[0] = f"应用失败（{str(exc)[:200]}）"
        else:
            _WINDOWS_PATCH[0] = windows_patch.describe() if applied else "未生效（yue2.cuda_graph 不可导入）"
            _WINDOWS_PATCH[0] += f"（探针记录：{windows_patch.cache_file()}）"
    log("注意力补丁：" + _WINDOWS_PATCH[0])
    return _WINDOWS_PATCH[0]


# import 期就接线：任何一条入口（app.ui / app.server / 脚本）拿到引擎时补丁都已生效。
WINDOWS_PATCH: str = apply_windows_patch()


def attention_backend() -> str:
    """当前生效的注意力档位：flash / cudnn / sdpa / unsupported / unknown。

    供 `app/ui.py` 启动日志与失败文案使用；探针有进程内缓存，重复调用不重复真跑。
    """
    try:
        from app import windows_patch  # app.engine 与 app 同包，两种入口都命中
    except Exception:
        return "unknown"
    try:
        return windows_patch.best_attention_backend()
    except Exception as exc:  # noqa: BLE001 - 只为回一行状态
        if getattr(exc, "code", "") == "attention_backend_unsupported":
            return "unsupported"
        return "unknown"


class EngineError(Exception):
    """带短码的引擎错误，服务层直接转成 {"ok":false,"error":短码}。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class Cancelled(Exception):
    """用户在阶段边界取消了本次生成。"""


# 裸 torch 的注意力断言（补丁没生效时就会漏出来）——一律收敛成短码，别丢给宿主和用户
_ATTENTION_FAIL_HINTS = ("USE_FLASH_ATTENTION", "No available kernel")


def _is_attention_error(exc: BaseException) -> bool:
    if getattr(exc, "code", "") == "attention_backend_unsupported":
        return True
    text = str(exc)
    return any(h in text for h in _ATTENTION_FAIL_HINTS)


def _attention_engine_error(exc: BaseException) -> "EngineError":
    """注意力档位不可用 → EngineError 短码 `attention_backend_unsupported`（附中文排查指引）。"""
    try:
        from app import windows_patch

        where = windows_patch.cache_file()
    except Exception:  # noqa: BLE001
        where = r"<INSTALL_DIR>\.attention-backend"
    return EngineError(
        "attention_backend_unsupported",
        f"注意力后端不可用（{WINDOWS_PATCH}）：{str(exc)[:300]}；"
        f"可跑 scripts\\probe_attention.py 看各档实测，或设 YUE2_ATTENTION_BACKEND=sdpa|cudnn|flash "
        f"强制档位后重启；探针记录：{where}",
    )


def _precheck_attention_backend(device: str) -> str:
    """CUDA 设备上先确认有可用档位；三档全失败即抛短码（不等 torch 裸断言）。"""
    if device != "cuda":
        return ""
    try:
        from app import windows_patch
    except Exception as exc:  # noqa: BLE001 - 补丁缺失不拖垮引擎
        log(f"注意力探针不可用（忽略）：{str(exc)[:160]}")
        return ""
    try:
        backend = windows_patch.best_attention_backend()
    except Exception as exc:  # noqa: BLE001
        if getattr(exc, "code", "") == "attention_backend_unsupported":
            raise _attention_engine_error(exc) from exc
        log(f"注意力探针异常（忽略）：{str(exc)[:200]}")
        return ""
    log(f"注意力档位：{backend}（记录：{windows_patch.cache_file()}）")
    return backend


# pipeline 英文阶段日志 → (阶段名, 百分比)，只前进不回退
_STAGE_HINTS = (
    (("planning", "plan ", " plan", "cot", "abc", "score"), "plan", 35),
    (("semantic",), "semantic", 55),
    (("synthes", "flow matching", "latent"), "synth", 72),
    (("decod", "vae", "waveform", "48 khz", "48khz"), "decode", 86),
    (("saving", "save", "writ", "export"), "save", 92),
)


def auto_model_dir(env_key: str, flat_name: str, model_id: str) -> str:
    """探测本地已有的模型目录：env → <INSTALL_DIR>\\models\\<flat> → HF / ModelScope 缓存。

    都找不到返回空串（空串 = 交给 yue2 / huggingface_hub 按 repo id 自己解析缓存或下载）。
    """
    env = (os.environ.get(env_key) or "").strip()
    if env and Path(env).is_dir():
        return str(Path(env))
    bases: List[Path] = [_ROOT / "models"]
    hf_home = (os.environ.get("HF_HOME") or "").strip()
    if hf_home:
        bases += [Path(hf_home) / "hub", Path(hf_home)]
    bases += [Path.home() / ".cache" / "huggingface" / "hub"]
    for base in bases:
        for name in (flat_name, model_id):
            d = base / name
            if d.is_dir() and (d / "config.json").is_file():
                return str(d)
    for base in bases:
        try:
            if not base.is_dir():
                continue
            for d in base.iterdir():
                low = d.name.lower()
                if d.is_dir() and ("yue2" in low) and (d / "config.json").is_file():
                    return str(d)
        except Exception:
            continue
    return ""


class Progress:
    """staged 进度快照（供 `GET /progress` 轮询）。线程安全、单调不回退。"""

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
        self.started_at = 0.0
        self.updated_at = 0.0
        self.elapsed_sec = 0.0

    def start(self, seed: Optional[int], output_dir: str) -> None:
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
                "elapsedSec": round(time.time() - self.started_at, 3) if self.started_at else 0.0,
            }


class _StdoutTee:
    """把 pipeline 自己的阶段日志透传出去，同时推进 staged 进度与检查取消。"""

    def __init__(self, engine: "YuE2Engine") -> None:
        self._engine = engine
        self._real = sys.stdout
        self._buf = ""

    def write(self, s: str) -> int:
        try:
            self._real.write(s)
        except Exception:
            pass
        if s:
            self._buf += s
            while "\n" in self._buf:
                line, self._buf = self._buf.split("\n", 1)
                self._engine._on_pipeline_line(line)
        return len(s or "")

    def flush(self) -> None:
        try:
            self._real.flush()
        except Exception:
            pass

    def isatty(self) -> bool:  # pragma: no cover - 只为兼容 tqdm 之类的探测
        return False

    def fileno(self) -> int:
        raise OSError("stdout tee 没有 fileno")


class YuE2Engine:
    """懒加载 + 常驻 pipeline，一次只跑一首歌（并发保护在 server 层）。"""

    def __init__(self) -> None:
        self.mock = (os.environ.get("MTNODE_YUE2_MOCK") or "").strip() == "1"
        self.progress = Progress()
        self.load_path = ""
        self.infer_version = ""
        self._pipe: Any = None
        self._pipe_lock = threading.RLock()
        self._cancel = threading.Event()

    # ---------------- 设备 / 路径 ----------------

    @property
    def device(self) -> str:
        return self._pick_device()

    @property
    def loaded(self) -> bool:
        return bool(self.mock or self._pipe is not None)

    def _pick_device(self) -> str:
        env = (os.environ.get("YUE2_DEVICE") or "").strip().lower()
        if env in ("cpu", "cuda"):
            return env
        try:
            import torch

            if torch.cuda.is_available():
                return "cuda"
        except Exception:
            pass
        return "cpu"

    def repo_source(self) -> str:
        """YuE2-3B 加载源：本地目录优先，否则回官方 repo id（YuE2 要求 cuda）。"""
        d = auto_model_dir("YUE2_MODEL_DIR", "m-a-p__YuE2-3B", MODEL_ID)
        return d if d else MODEL_ID

    def vae_source(self) -> str:
        env = (os.environ.get("YUE2_VAE") or "").strip()
        if env:
            return env
        d = auto_model_dir("YUE2_VAE_DIR", "m-a-p__YuE2-Vae", VAE_ID)
        return d if d else VAE_ID

    def _infer_pkg_version(self) -> str:
        try:
            from importlib.metadata import version

            return version("yue2-infer")
        except Exception:
            return ""

    # ---------------- 加载 / 关闭 ----------------

    def _load_kwargs(self) -> Dict[str, Any]:
        return {"device": self._pick_device(), "vae": self.vae_source()}

    def _new_pipeline(self) -> Any:
        """构造 pipeline（官方 `YuE2Pipeline.from_pretrained(repo, device=..., vae=...)`）。"""
        apply_windows_patch()  # 幂等；再压一道，确保 GraphAR 构造前补丁在位
        _precheck_attention_backend(self._pick_device())  # 三档全失败 → 短码，别等 torch 裸断言
        try:
            from yue2 import YuE2Pipeline
        except Exception as e:
            raise EngineError(
                "model_load_failed",
                f"yue2 推理包不可用（yue2_infer 是否装好？）：{str(e)[:200]}",
            ) from e
        repo = self.repo_source()
        kwargs = self._load_kwargs()
        try:
            return YuE2Pipeline.from_pretrained(repo, **kwargs)
        except TypeError:
            legacy = dict(kwargs)
            legacy.pop("vae", None)
            return YuE2Pipeline.from_pretrained(repo, **legacy)

    def ensure_loaded(self) -> Any:
        """懒加载并常驻 pipeline；mock 模式什么都不做。加载失败抛 EngineError。"""
        if self.mock:
            raise EngineError("bad_request", "mock 模式不加载模型")
        with self._pipe_lock:
            if self._pipe is not None:
                return self._pipe
            src = self.repo_source()
            self.infer_version = self._infer_pkg_version()
            log(f"正在加载 YuE2：{src}（vae={self.vae_source()}，device={self._pick_device()}）")
            try:
                self._pipe = self._new_pipeline()
            except EngineError:
                raise
            except Exception as e:
                if _is_attention_error(e):
                    raise _attention_engine_error(e) from e
                raise EngineError("model_load_failed", f"YuE2 加载失败（{src}）：{str(e)[:400]}") from e
            self.load_path = str(src)
            log(f"YuE2 就绪：{src}（infer={self.infer_version or '未知'}）")
            return self._pipe

    def close(self) -> None:
        """关闭 pipeline（等价于退出官方 `with` 块）。"""
        with self._pipe_lock:
            pipe, self._pipe = self._pipe, None
        if pipe is None:
            return
        for name in ("close", "__exit__"):
            fn = getattr(pipe, name, None)
            if not callable(fn):
                continue
            try:
                fn(None, None, None) if name == "__exit__" else fn()
            except Exception as e:
                log(f"关闭 pipeline 时忽略异常：{str(e)[:200]}")
            return

    # ---------------- 取消 ----------------

    def cancel(self) -> bool:
        """请求取消本次生成；在下一个阶段日志边界生效（不抢占正在跑的 kernel）。"""
        if not self.progress.running:
            return False
        self._cancel.set()
        self.progress.set("cancelling", None, "已请求取消，将在下一个阶段边界中止")
        return True

    def _on_pipeline_line(self, line: str) -> None:
        if self._cancel.is_set():
            raise Cancelled("用户取消")
        low = (line or "").lower()
        if not low.strip():
            return
        for keys, stage, percent in _STAGE_HINTS:
            if any(k in low for k in keys):
                self.progress.set(stage, percent, line.strip()[:200])
                return

    @contextlib.contextmanager
    def _capture_stdout(self):
        tee = _StdoutTee(self)
        old = sys.stdout
        sys.stdout = tee
        try:
            yield tee
        finally:
            try:
                tee.flush()
            except Exception:
                pass
            sys.stdout = old

    # ---------------- 生成 ----------------

    def generate(self, req: Dict[str, Any]) -> Dict[str, Any]:
        """一次完整生成：校验入参 → 跑 pipeline → 产物落 outputDir → 回真实路径。"""
        style = str(req.get("style") or "").strip()
        lyrics = str(req.get("lyrics") or "")
        cot = str(req.get("cot") or DEFAULT_COT).strip().lower() or DEFAULT_COT
        abc = str(req.get("abc") or "")
        seed = _as_int(req.get("seed"))
        cfg_scale = _as_float(req.get("cfgScale", req.get("cfg_scale")))
        extra = req.get("extra") if isinstance(req.get("extra"), dict) else {}

        if cot not in COT_MODES:
            raise EngineError("unknown_cot", f"cot 必须是 {' / '.join(COT_MODES)} 之一，收到：{cot}")
        if not style:
            raise EngineError("bad_request", "style（风格提示词）不能为空")
        if not lyrics.strip():
            raise EngineError("bad_request", "lyrics（歌词）不能为空")
        if seed is None or seed < 0:
            seed = random.randrange(1, 2 ** 31 - 1)
        # 校验通过后才落目录：无效请求不该在磁盘上留下空目录
        out_dir = self._resolve_output_dir(req.get("outputDir"))

        self._cancel.clear()
        self.progress.start(seed=seed, output_dir=str(out_dir))
        t0 = time.time()
        try:
            if self.mock:
                result = self._mock_run(style, lyrics, cot, abc, seed, out_dir)
            else:
                result = self._real_run(style, lyrics, cot, abc, seed, cfg_scale, extra, out_dir)
        except Cancelled as e:
            self.progress.cancelled = True
            self.progress.fail(str(e), stage="cancelled")
            raise EngineError("cancelled", "本次生成已取消（未写出任何产物）") from e
        except EngineError as e:
            self.progress.fail(e.message)
            raise
        except Exception as e:
            if _is_attention_error(e):
                err = _attention_engine_error(e)
                self.progress.fail(err.message)
                raise err from e
            log("生成未预期异常：" + traceback.format_exc(limit=6).replace("\n", " | ")[:600])
            self.progress.fail(f"生成失败：{str(e)[:300]}")
            raise EngineError("generate_failed", f"生成失败：{str(e)[:400]}") from e

        result.update({"cot": cot, "seed": seed, "mock": bool(self.mock), "elapsedSec": round(time.time() - t0, 2)})
        self.progress.finish()
        return result

    def _resolve_output_dir(self, raw: Any) -> Path:
        """输出目录：必须由调用方给（相对路径按进程 cwd 解析）；缺省落到 <INSTALL_DIR>\\outputs\\yue2-<ts>。"""
        s = str(raw or "").strip().strip('"')
        if s:
            p = Path(s).expanduser()
            if not p.is_absolute():
                p = (Path.cwd() / p)
        else:
            p = _ROOT / "outputs" / f"yue2-{time.strftime('%Y%m%d-%H%M%S')}-{random.randrange(0x1000, 0xFFFF):04x}"
        p = p.resolve()
        try:
            p.mkdir(parents=True, exist_ok=True)
        except Exception as e:
            raise EngineError("bad_request", f"无法创建 outputDir（{p}）：{str(e)[:200]}") from e
        if not p.is_dir():
            raise EngineError("bad_request", f"outputDir 不是目录：{p}")
        return p

    def _real_run(
        self,
        style: str,
        lyrics: str,
        cot: str,
        abc: str,
        seed: int,
        cfg_scale: Optional[float],
        extra: Dict[str, Any],
        out_dir: Path,
    ) -> Dict[str, Any]:
        kwargs: Dict[str, Any] = {"style": style, "lyrics": lyrics, "cot": cot, "seed": int(seed)}
        if abc.strip():
            kwargs["abc"] = abc
        if cfg_scale is not None:
            kwargs["cfg_scale"] = float(cfg_scale)
        for k, v in extra.items():
            if k not in kwargs and k not in ("outputDir", "output_dir", "cot_scale"):
                kwargs[str(k)] = v

        per_request = (os.environ.get("YUE2_LOAD_PER_REQUEST") or "").strip() == "1"
        if per_request:
            # 官方 `with ... as pipe` 语义：每个请求加载一次、用完即关
            self.progress.set("load_model", 8, "加载 YuE2 权重（YUE2_LOAD_PER_REQUEST=1）")
            pipe = self._new_pipeline()
            entered = False
            try:
                if hasattr(pipe, "__enter__"):
                    pipe.__enter__()
                    entered = True
                return self._render(pipe, kwargs, out_dir)
            except Cancelled:
                raise
            except EngineError:
                raise
            except Exception as e:
                if _is_attention_error(e):
                    raise _attention_engine_error(e) from e
                raise EngineError("generate_failed", f"生成失败：{str(e)[:400]}") from e
            finally:
                close = getattr(pipe, ("__exit__" if entered else "close"), None)
                if callable(close):
                    try:
                        close(None, None, None) if entered else close()
                    except Exception:
                        pass
        self.progress.set("load_model", 8, "准备 YuE2 权重（首次请求会加载，之后常驻）")
        pipe = self.ensure_loaded()
        self.progress.set("generate", 25, "开始生成（符号规划 → 语义 token → 声学 latent → VAE 解码）")
        try:
            return self._render(pipe, kwargs, out_dir)
        except Cancelled:
            raise
        except EngineError:
            raise
        except Exception as e:
            if _is_attention_error(e):
                raise _attention_engine_error(e) from e
            raise EngineError("generate_failed", f"生成失败：{str(e)[:400]}") from e

    def _render(self, pipe: Any, kwargs: Dict[str, Any], out_dir: Path) -> Dict[str, Any]:
        """一次 pipeline 调用 + 产物落盘；pipeline 的阶段日志经 tee 推进进度。"""
        if self._cancel.is_set():
            raise Cancelled("用户取消")
        song = None
        with self._capture_stdout():
            song = pipe(**kwargs)
        if self._cancel.is_set():
            raise Cancelled("用户取消")
        if song is None:
            raise EngineError("generate_failed", "pipeline 未返回 song 对象")

        self.progress.set("save", 92, f"写出 audio.flac 与 artifact → {out_dir}")
        audio_path = out_dir / "audio.flac"
        self._save_audio(song, audio_path)

        warnings: List[str] = []
        try:
            song.save_artifacts(str(out_dir))
        except Exception as e:
            warnings.append(f"save_artifacts 失败：{str(e)[:200]}")

        if not audio_path.is_file():
            # 兜底：个别版本可能由 save_artifacts 落音频，或 save() 换了后缀
            cands = sorted(list(out_dir.glob("audio.*")) + list(out_dir.glob("*.flac")))
            if cands:
                audio_path = cands[0]

        if not audio_path.is_file():
            raise EngineError("save_failed", f"音频未落盘：{audio_path}")

        files = sorted(str(p) for p in out_dir.rglob("*") if p.is_file())
        score = out_dir / "score.abc"
        duration = _audio_duration(audio_path)
        log(f"生成完成：{audio_path}（artifact {len(files)} 个，用时 {self.progress.elapsed_sec:.1f}s）")
        return {
            "audioPath": str(audio_path),
            "outputDir": str(out_dir),
            "artifacts": files,
            "scoreAbc": str(score) if score.is_file() else "",
            "scoreAbcLen": len(score.read_text(encoding="utf-8", errors="replace")) if score.is_file() else 0,
            "durationSec": duration,
            "warnings": warnings,
        }

    @staticmethod
    def _save_audio(song: Any, audio_path: Path) -> None:
        for name in ("save", "write", "save_audio"):
            fn = getattr(song, name, None)
            if not callable(fn):
                continue
            try:
                fn(str(audio_path))
                return
            except TypeError:
                try:
                    fn(str(audio_path), "flac")
                    return
                except Exception as e:
                    raise EngineError("save_failed", f"音频写出失败（{audio_path}）：{str(e)[:300]}") from e
            except Exception as e:
                raise EngineError("save_failed", f"音频写出失败（{audio_path}）：{str(e)[:300]}") from e
        raise EngineError("save_failed", "song 对象没有 save()/write()，无法写出音频")

    # ---------------- mock（冒烟 / 联调，不加载模型） ----------------

    def _mock_run(self, style: str, lyrics: str, cot: str, abc: str, seed: int, out_dir: Path) -> Dict[str, Any]:
        self.progress.set("generate", 40, "mock 模式：不加载模型，按入参造占位产物")
        time.sleep(0.2)
        if self._cancel.is_set():
            raise Cancelled("用户取消")
        audio_path = out_dir / "audio.flac"
        warnings: List[str] = []
        try:
            _write_mock_flac(audio_path)
        except Exception as e:  # soundfile 缺失 → 退回 wav（mock 专用）
            warnings.append(f"soundfile 不可用，mock 音频改写成 audio.wav：{str(e)[:120]}")
            audio_path = out_dir / "audio.wav"
            _write_mock_wav(audio_path)
        score = out_dir / "score.abc"
        score.write_text(
            "X:1\nT:mock\nM:4/4\nL:1/8\nK:C\n% YuE2 mock artifact（真实生成时这里是规划出的 ABC 乐谱）\nC D E F | G A B c |\n",
            encoding="utf-8",
        )
        (out_dir / "semantic_tokens.json").write_text(
            json.dumps({"mock": True, "cot": cot, "seed": seed, "tokens": [1, 2, 3, 4]}, ensure_ascii=False),
            encoding="utf-8",
        )
        (out_dir / "settings.json").write_text(
            json.dumps(
                {
                    "mock": True,
                    "model": MODEL_ID,
                    "vae": VAE_ID,
                    "style": style,
                    "cot": cot,
                    "seed": seed,
                    "lyricsLen": len(lyrics),
                    "abcSupplied": bool(abc.strip()),
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        self.progress.set("save", 95, f"mock 产物已落盘 → {out_dir}")
        files = sorted(str(p) for p in out_dir.rglob("*") if p.is_file())
        return {
            "audioPath": str(audio_path),
            "outputDir": str(out_dir),
            "artifacts": files,
            "scoreAbc": str(score),
            "scoreAbcLen": len(score.read_text(encoding="utf-8", errors="replace")),
            "durationSec": _audio_duration(audio_path),
            "warnings": warnings,
        }


def _as_int(v: Any) -> Optional[int]:
    if v is None or v == "":
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _as_float(v: Any) -> Optional[float]:
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _audio_duration(path: Path) -> float:
    """读音频时长（soundfile 优先，失败回 0）。"""
    try:
        import soundfile as sf

        info = sf.info(str(path))
        return round(float(info.frames) / float(info.samplerate or 1), 3)
    except Exception:
        return 0.0


def _write_mock_flac(path: Path) -> None:
    import numpy as np
    import soundfile as sf

    sr = 48000
    t = np.linspace(0.0, 1.0, sr, endpoint=False)
    left = (0.2 * np.sin(2 * np.pi * 440.0 * t)).astype("float32")
    right = (0.2 * np.sin(2 * np.pi * 554.37 * t)).astype("float32")
    sf.write(str(path), np.stack([left, right], axis=1), sr, format="FLAC")


def _write_mock_wav(path: Path) -> None:
    import math
    import wave

    sr = 48000
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(
            b"".join(
                int(0.2 * 32767 * math.sin(2 * math.pi * 440.0 * i / sr)).to_bytes(2, "little", signed=True)
                for i in range(sr)
            )
        )
