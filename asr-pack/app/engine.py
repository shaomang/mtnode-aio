"""Qwen3-ASR 推理引擎：懒加载模型 + VAD 分段 + 逐段转写拼接。

防御式设计（上游 transformers / modelscope 的 API 一直在动，这里不赌任何一条路）：
1. 先试 transformers 的 `Qwen3ASRForConditionalGeneration`（`try: import` 探测，
   类不存在就跳过）配 `AutoProcessor`；
2. 再试通用的 `AutoProcessor` + `AutoModelForSpeechSeq2Seq`（`trust_remote_code=True`）；
3. 实际走通哪条路写进日志（`[asr] 模型加载路径：...`）。
任何加载异常都转成 `model_load_failed` + 原始异常摘要，绝不让 traceback 直接吐给上层。
输入按官方 chat 形式组装（user 消息里音频 + 文本提示）；拿不到 chat 模板就退回纯文本提示。
"""
from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from app import audio as audio_mod
from app import vad as vad_mod

MODEL_ID = "Qwen/Qwen3-ASR-0.6B"
# 语音段之间拼接用的分隔符（拼接结果里不出现任何分段标记）
JOIN_SEP = " "

_ROOT = Path(__file__).resolve().parent.parent
_LOGGER: List[Optional[Callable[[str], None]]] = [None]


def set_logger(fn: Callable[[str], None]) -> None:
    _LOGGER[0] = fn


def log(msg: str) -> None:
    fn = _LOGGER[0]
    if fn:
        fn(msg)
    else:
        try:
            print(msg, flush=True)
        except Exception:
            pass


class EngineError(Exception):
    """带短码的引擎错误，服务层直接转成 {"ok":false,"error":短码}。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def auto_model_dir() -> str:
    """自动探测本地已有的 Qwen3-ASR 模型目录。

    顺序：环境变量 ASR_MODEL_DIR → `<INSTALL_DIR>\\models\\Qwen__Qwen3-ASR-0.6B`
    → ModelScope / HuggingFace 本地缓存里带 qwen3-asr 的目录。都找不到返回空串
    （空串表示交给 modelscope / hf 自己按 id 下载缓存）。
    """
    env = (os.environ.get("ASR_MODEL_DIR") or "").strip()
    if env and Path(env).is_dir():
        return str(Path(env))
    flat = MODEL_ID.replace("/", "__")
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
        for name in (flat, MODEL_ID):
            d = base / name
            if d.is_dir() and (d / "config.json").is_file():
                return str(d)
    for base in bases:
        try:
            if not base.is_dir():
                continue
            for d in base.iterdir():
                low = d.name.lower()
                if d.is_dir() and "qwen3-asr" in low and (d / "config.json").is_file():
                    return str(d)
        except Exception:
            continue
    return ""


def resolve_model_source() -> str:
    """模型加载源：本地目录优先，否则回 ModelScope id。"""
    d = auto_model_dir()
    return d if d else MODEL_ID


class Qwen3AsrEngine:
    """懒加载 + 单次转写。模型只加载一次，进程内复用。"""

    def __init__(self) -> None:
        self.mock = (os.environ.get("MTNODE_ASR_MOCK") or "").strip() == "1"
        self.model_source = ""
        self.load_path = ""
        self._processor: Any = None
        self._model: Any = None
        self._torch: Any = None
        self._device = "cpu"
        self._vad: Optional[vad_mod.FsmnVad] = None
        # 路径 -> (mtime, {text, segments, duration_sec, language})：
        # 只对「按路径请求」的重复调用生效（上传字节每次都是新临时文件，不参与缓存）
        self._cache: Dict[str, Tuple[float, Dict[str, Any]]] = {}

    # ---------------- 设备 / 加载 ----------------

    @property
    def device(self) -> str:
        return self._device

    @property
    def loaded(self) -> bool:
        return self.mock or self._model is not None

    @property
    def vad_ready(self) -> bool:
        return bool(self._vad and self._vad.available)

    def _pick_device(self) -> str:
        env = (os.environ.get("ASR_DEVICE") or "").strip().lower()
        if env in ("cpu", "cuda"):
            return env
        try:
            import torch

            if torch.cuda.is_available():
                return "cuda"
        except Exception:
            pass
        return "cpu"

    def _load_torch_and_pty(self):
        """导入 torch / transformers / AutoProcessor。缺任何一项都是 model_load_failed。"""
        try:
            import torch  # noqa: F401
        except Exception as e:
            raise EngineError("model_load_failed", f"torch 不可用（是否装的是 CUDA 版？）：{str(e)[:200]}") from e
        try:
            from transformers import AutoProcessor
        except Exception as e:
            raise EngineError("model_load_failed", f"transformers 不可用：{str(e)[:200]}") from e
        return torch, AutoProcessor

    def ensure_loaded(self) -> None:
        """确保模型已加载；mock 模式下什么都不做。加载失败原样抛 EngineError。"""
        if self.mock or self._model is not None:
            return
        src = resolve_model_source()
        self.model_source = src
        torch, AutoProcessor = self._load_torch_and_pty()
        self._torch = torch
        self._device = self._pick_device()

        # 本地目录与 ModelScope id 都按「先试本地/缓存，再让上游自己解析」的次序来；
        # 只有 cuda 时才指定 dtype，CPU 上保持默认（bf16 在 CPU 上又慢又可能不支持）。
        kwargs: Dict[str, Any] = {"trust_remote_code": True}
        if self._device == "cuda":
            kwargs["torch_dtype"] = torch.bfloat16

        errors: List[str] = []
        _log_line = f"[asr] 正在加载模型：{src}（device={self._device}）"
        log(_log_line)

        try:
            self._processor = AutoProcessor.from_pretrained(src, trust_remote_code=True)
        except Exception as e:
            raise EngineError("model_load_failed", f"AutoProcessor 加载失败（{src}）：{str(e)[:300]}") from e

        # 路径 1：Qwen3-ASR 专用类（try: import 探测，类不存在就走路径 2）
        model_cls = None
        try:
            import transformers as _tf

            model_cls = getattr(_tf, "Qwen3ASRForConditionalGeneration", None)
        except Exception:
            model_cls = None
        if model_cls is not None:
            try:
                self._model = self._from_pretrained(model_cls, src, kwargs)
                self.load_path = "Qwen3ASRForConditionalGeneration"
            except Exception as e:
                errors.append(f"Qwen3ASRForConditionalGeneration: {str(e)[:200]}")
        else:
            errors.append("transformers 中不存在 Qwen3ASRForConditionalGeneration（跳过）")

        # 路径 2：通用序列到序列自动类
        if self._model is None:
            try:
                from transformers import AutoModelForSpeechSeq2Seq
            except Exception as e:
                errors.append(f"AutoModelForSpeechSeq2Seq 不可用: {str(e)[:160]}")
                AutoModelForSpeechSeq2Seq = None  # type: ignore
            if AutoModelForSpeechSeq2Seq is not None:
                try:
                    self._model = self._from_pretrained(AutoModelForSpeechSeq2Seq, src, kwargs)
                    self.load_path = "AutoModelForSpeechSeq2Seq"
                except Exception as e:
                    errors.append(f"AutoModelForSpeechSeq2Seq: {str(e)[:200]}")

        if self._model is None:
            raise EngineError("model_load_failed", "模型加载失败：" + "；".join(errors)[:500])

        try:
            self._model.eval()
        except Exception:
            pass
        log(f"[asr] 模型加载路径：{self.load_path}（source={src}）")

        # VAD 是可选增强：加载失败不影响转写（退回固定 30 秒窗口）
        self._vad = vad_mod.FsmnVad(device="cpu")
        if self._vad.load():
            log("[asr] fsmn-vad 就绪（静音分段）")
        else:
            log("[asr] fsmn-vad 不可用，改用固定 30 秒窗口：" + (self._vad.reason or "未知原因"))

    @staticmethod
    def _from_pretrained(cls: Any, src: str, kwargs: Dict[str, Any]) -> Any:
        """兼容新旧 transformers 的参数名（torch_dtype → dtype）。"""
        try:
            return cls.from_pretrained(src, **kwargs)
        except TypeError:
            legacy = dict(kwargs)
            if "torch_dtype" in legacy:
                legacy["dtype"] = legacy.pop("torch_dtype")
            return cls.from_pretrained(src, **legacy)

    # ---------------- 转写 ----------------

    def _build_hint(self, hotwords: List[str], prompt: str) -> str:
        """把 hotwords 与 OpenAI 的 prompt 合并成一段「热词/上下文」提示词。"""
        words = [str(w).strip() for w in (hotwords or []) if str(w).strip()]
        if not words:
            # prompt 里可能自带「热词：a、b」写法，此时不重复包装
            return (prompt or "").strip()
        hint = "热词：" + "、".join(words)
        extra = (prompt or "").strip()
        return (hint + "。" + extra) if extra else hint

    def _build_chat_inputs(self, processor: Any, audio, sr: int, hint: str):
        """按官方 chat 形式组装输入：user 消息里音频 + 文本提示。

        此处按官方 chat 模板组装，若上游 API 变化会退回纯文本提示（见 _build_text_inputs）。
        """
        content: List[Dict[str, Any]] = [{"type": "audio", "audio": audio, "sampling_rate": sr}]
        if hint:
            content.append({"type": "text", "text": hint})
        messages = [{"role": "user", "content": content}]
        text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        inputs = processor(text=text, audio=audio, sampling_rate=sr, return_tensors="pt")
        return inputs

    def _build_text_inputs(self, processor: Any, audio, sr: int, hint: str):
        """退回纯文本提示：直接把热词拼在文本里，不依赖 chat 模板。"""
        text = hint if hint else ""
        try:
            return processor(text=text, audio=audio, sampling_rate=sr, return_tensors="pt")
        except TypeError:
            # 有的 processor 用 audios= 复数形参名
            return processor(text=text, audios=audio, sampling_rate=sr, return_tensors="pt")

    def _prepare_inputs(self, audio, sr: int, hint: str):
        processor = self._processor
        try:
            return self._build_chat_inputs(processor, audio, sr, hint)
        except Exception as e:
            log(f"[asr] chat 模板组装失败，退回纯文本提示：{str(e)[:200]}")
            return self._build_text_inputs(processor, audio, sr, hint)

    def _to_device(self, inputs: Any) -> Any:
        torch = self._torch
        moved = {}
        for k, v in dict(inputs).items():
            try:
                if hasattr(v, "to"):
                    if getattr(v, "is_floating_point", None) and v.is_floating_point() and self._device == "cuda":
                        v = v.to(self._device, dtype=torch.bfloat16)
                    else:
                        v = v.to(self._device)
                moved[k] = v
            except Exception:
                moved[k] = v
        return moved

    def _decode(self, output_ids: Any, inputs: Any) -> str:
        """只解码「新生成」的 token；上游返回整段或只返回新段都能处理。"""
        gen = output_ids
        try:
            in_len = int(inputs["input_ids"].shape[-1])
            if int(gen.shape[-1]) > in_len:
                gen = gen[:, in_len:]
        except Exception:
            pass
        # 少数实现返回 (text, ...) 形式的元组
        if isinstance(gen, (tuple, list)):
            for item in gen:
                if isinstance(item, str):
                    return item.strip()
            gen = gen[0]
        try:
            return str(self._processor.batch_decode(gen, skip_special_tokens=True)[0]).strip()
        except Exception:
            pass
        try:
            return str(self._processor.decode(gen[0], skip_special_tokens=True)).strip()
        except Exception:
            return str(self._processor.tokenizer.decode(gen[0], skip_special_tokens=True)).strip()

    def _transcribe_chunk(self, audio, sr: int, hint: str) -> str:
        inputs = self._to_device(self._prepare_inputs(audio, sr, hint))
        gen_kwargs: Dict[str, Any] = {"max_new_tokens": 1024}
        try:
            with self._torch.inference_mode():
                out = self._model.generate(**inputs, **gen_kwargs)
        except TypeError:
            # 极少数版本 generate 不接受关键字参数
            out = self._model.generate(inputs["input_ids"])
        ids = getattr(out, "sequences", out)
        return self._decode(ids, inputs)

    def transcribe(self, wav_path: str, hotwords: List[str], prompt: str, language: str = "auto") -> Dict[str, Any]:
        """对外的唯一入口：输入 16k 单声道 wav 路径，返回文本与分段统计。"""
        hint = self._build_hint(hotwords, prompt)
        if language and language not in ("auto", "", "none"):
            hint = (hint + "。" if hint else "") + f"语种：{language}"

        total_sec = audio_mod.probe_duration_sec(wav_path)
        wave = audio_mod.read_wav_mono16k(wav_path)
        sr = audio_mod.TARGET_SR
        if total_sec <= 0:
            total_sec = len(wave) / float(sr)

        t0 = time.time()
        self.ensure_loaded()

        if self.mock:
            # mock 模式：不加载任何模型，按音频文件名回一段假文本（冒烟 / 联调用）
            name = Path(wav_path).name
            text = f"[mock 转写] 文件名={name}，时长={total_sec:.1f} 秒，热词={'、'.join(hotwords or []) or '无'}"
            return {"text": text, "segments": 1, "duration_sec": round(total_sec, 3), "language": "zh", "source": "mock"}

        segs: List[Tuple[float, float]] = []
        if self._vad is not None and self._vad.available:
            segs = self._vad.segments(wave, sr)
        if not segs:
            segs = vad_mod.split_fixed(total_sec)
        else:
            segs = vad_mod.clamp_segments(segs, total_sec)
        if not segs:  # 空音频 / 全静音
            segs = vad_mod.split_fixed(total_sec)

        parts: List[str] = []
        for i, (s, e) in enumerate(segs, 1):
            a = max(0, int(s * sr))
            b = min(len(wave), int(e * sr))
            if b - a < int(0.2 * sr):
                continue
            chunk = wave[a:b]
            log(f"[asr] 转写第 {i}/{len(segs)} 段：{s:.2f}s → {e:.2f}s")
            try:
                txt = self._transcribe_chunk(chunk, sr, hint)
            except Exception as ex:
                raise EngineError("decode_failed", f"第 {i} 段推理失败：{str(ex)[:300]}") from ex
            if txt:
                parts.append(txt)

        text = JOIN_SEP.join(p for p in parts if p).strip()
        log(f"[asr] 转写完成：{len(segs)} 段 / {total_sec:.2f}s / 用时 {time.time() - t0:.1f}s")
        return {
            "text": text,
            "segments": len(segs),
            "duration_sec": round(total_sec, 3),
            "language": "zh" if (language in ("", "auto", "none", None)) else str(language),
            "source": self.load_path or "model",
        }

    # ---------------- 缓存（只对按路径的重复请求生效） ----------------

    def cache_get(self, path: str) -> Optional[Dict[str, Any]]:
        """命中返回上次的完整结果（文本 + 段数 + 时长 + 语种）；未命中返回 None。"""
        try:
            key = str(Path(path).resolve())
            item = self._cache.get(key)
            if not item:
                return None
            if abs(item[0] - Path(path).stat().st_mtime) < 1e-6:
                return item[1]
        except Exception:
            pass
        return None

    def cache_put(self, path: str, result: Dict[str, Any]) -> None:
        try:
            key = str(Path(path).resolve())
            self._cache[key] = (
                Path(path).stat().st_mtime,
                {
                    "text": str(result.get("text") or ""),
                    "segments": int(result.get("segments") or 0),
                    "duration_sec": float(result.get("duration_sec") or 0.0),
                    "language": str(result.get("language") or "zh"),
                },
            )
            if len(self._cache) > 64:
                self._cache.pop(next(iter(self._cache)))
        except Exception:
            pass
