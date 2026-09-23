"""VAD：用 ModelScope 的 fsmn-vad（iic/speech_fsmn_vad_zh-cn-16k-common-pytorch）做静音分段。

长音频的处理方式：先按静音切成一段段语音，逐段交给 ASR，再按顺序拼接 ——
这样既不限时长，也不会因为一次喂进几分钟音频而爆显存 / 掉精度。

拿不到 VAD 模型时**不报错**：退回固定 30 秒窗口（见 split_fixed），
保证「能转写」永远优先于「分段更漂亮」。
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any, List, Tuple

# 单段最长秒数：超过就拦腰切，防止极长的连续语音把显存吃光
MAX_SEG_SEC = 30.0
# 固定窗口模式的窗口长度
FIXED_WIN_SEC = 30.0
# 短于这个长度的段直接丢（VAD 偶尔会吐几十毫秒的碎屑，里面没有语音）
MIN_SEG_SEC = 0.25

# ModelScope 上的 fsmn-vad 模型 id
VAD_MODEL_ID = os.environ.get("ASR_VAD_MODEL") or "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch"

_ROOT = Path(__file__).resolve().parent.parent


def _log(msg: str) -> None:
    """行式日志，交给 server 注册的 logger；未注册时退回 print。"""
    logger = _LOGGER[0]
    if logger:
        logger(msg)
    else:
        try:
            print(msg, flush=True)
        except Exception:
            pass


_LOGGER: List[Any] = [None]


def set_logger(fn) -> None:
    _LOGGER[0] = fn


def auto_vad_dir() -> str:
    """自动探测本地已有的 VAD 模型目录。

    安装脚本把两个模型都下到 `<INSTALL_DIR>\\models\\`，目录名与 ModelScope 的
    id 同名（`iic__speech_fsmn_vad_...` 或 `iic/speech_fsmn_vad_...`）；
    再往下兼容 ModelScope / HuggingFace 的本地缓存布局。找不到返回空字符串。
    """
    env = (os.environ.get("ASR_VAD_MODEL_DIR") or "").strip()
    if env and Path(env).is_dir():
        return env
    flat = VAD_MODEL_ID.replace("/", "__")
    names = [flat, VAD_MODEL_ID.replace("__", "/")]
    bases: List[Path] = [_ROOT / "models"]
    for key in ("MODELSCOPE_CACHE", "MODELSCOPE_HOME"):
        v = (os.environ.get(key) or "").strip()
        if v:
            b = Path(v)
            bases += [b / "hub" / "models", b / "models", b]
    hf_home = (os.environ.get("HF_HOME") or "").strip()
    if hf_home:
        bases.append(Path(hf_home) / "hub")
    bases.append(Path.home() / ".cache" / "modelscope" / "hub" / "models")
    bases.append(Path.home() / ".cache" / "modelscope" / "hub")
    bases.append(Path.home() / ".cache" / "huggingface" / "hub")

    for base in bases:
        for name in names:
            d = base / name
            if d.is_dir() and (d / "configuration.json").is_file():
                return str(d)
            if d.is_dir() and (d / "config.yaml").is_file():
                return str(d)
    # 缓存目录里名字带哈希后缀（iic__speech_fsmn_vad_...-xxxx）；接受唯一命中
    for base in bases:
        try:
            if not base.is_dir():
                continue
            for d in base.iterdir():
                if not d.is_dir():
                    continue
                low = d.name.lower()
                if "fsmn_vad" in low or "fsmn-vad" in low:
                    if (d / "configuration.json").is_file() or (d / "config.yaml").is_file():
                        return str(d)
        except Exception:
            continue
    return ""


class FsmnVad:
    """fsmn-vad 的懒加载包装。加载失败时 `available=False`，调用方走固定窗口。"""

    def __init__(self, device: str = "cpu") -> None:
        self.device = device
        self.available = False
        self.reason = ""
        self._model = None

    def load(self) -> bool:
        model_dir = auto_vad_dir()
        if not model_dir:
            self.reason = "未找到本地 fsmn-vad 模型目录"
            return False
        try:
            from funasr import AutoModel  # 重量级依赖，缺它也算不可用

            _log(f"[asr] 加载 fsmn-vad：{model_dir}")
            kwargs: dict = {"model": model_dir, "disable_update": True, "disable_pbar": True}
            try:
                self._model = AutoModel(device=self.device, **kwargs)
            except TypeError:
                # 老版本 funasr 不认 disable_pbar 之类的参数
                self._model = AutoModel(model=model_dir, device=self.device)
            self.available = True
            return True
        except Exception as e:
            self.reason = f"fsmn-vad 加载失败：{str(e)[:200]}"
            _log("[asr] " + self.reason)
            return False

    def segments(self, audio, sr: int = 16000) -> List[Tuple[float, float]]:
        """返回 [(start_sec, end_sec), ...]；识别不到内容时返回空列表。"""
        if not self.available or self._model is None:
            return []
        try:
            res = self._model.generate(input=audio, fs=sr, cache={})
        except Exception as e:
            _log(f"[asr] fsmn-vad 推理失败，改用固定窗口：{str(e)[:160]}")
            self.available = False
            return []
        raw = []
        try:
            if isinstance(res, list) and res:
                raw = res[0].get("value") or []
        except Exception:
            raw = []
        out: List[Tuple[float, float]] = []
        for seg in raw:
            try:
                if isinstance(seg, (list, tuple)) and len(seg) >= 2:
                    s, e = float(seg[0]) / 1000.0, float(seg[1]) / 1000.0
                    if e - s >= MIN_SEG_SEC:
                        out.append((s, e))
            except Exception:
                continue
        return out


def split_fixed(total_sec: float, win_sec: float = FIXED_WIN_SEC) -> List[Tuple[float, float]]:
    """固定窗口切分（VAD 不可用时的兜底）：每段 win_sec 秒，尾巴不足也留着。"""
    out: List[Tuple[float, float]] = []
    t = 0.0
    while t < total_sec:
        e = min(total_sec, t + win_sec)
        if e - t >= MIN_SEG_SEC:
            out.append((t, e))
        t = e
    return out


def clamp_segments(segs: List[Tuple[float, float]], total_sec: float) -> List[Tuple[float, float]]:
    """收敛边界并限制单段长度：越界的裁掉，超长的拦腰切。"""
    out: List[Tuple[float, float]] = []
    for s, e in segs:
        s = max(0.0, float(s))
        e = min(float(total_sec), float(e))
        while e - s > MAX_SEG_SEC:
            out.append((s, s + MAX_SEG_SEC))
            s += MAX_SEG_SEC
        if e - s >= MIN_SEG_SEC:
            out.append((s, e))
    return out
