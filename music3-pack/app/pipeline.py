"""MiniMax Music 3 generation helpers for 24GB VRAM."""

from __future__ import annotations

import gc
import os
import re
import threading
from datetime import datetime
from pathlib import Path
from typing import Any

import soundfile as sf
import torch

try:
    from accelerate.utils.modeling import convert_file_size_to_int
    from diffusers.modular_pipelines.components_manager import AutoOffloadStrategy
except ImportError:  # pragma: no cover — older diffusers
    convert_file_size_to_int = None  # type: ignore[misc, assignment]
    AutoOffloadStrategy = None  # type: ignore[misc, assignment]


DEFAULT_MODEL_ID = "MiniMaxAI/MiniMax-Music3"
DEFAULT_LOCAL_MODEL = Path(__file__).resolve().parent.parent / "models" / "MiniMax-Music3"
DEFAULT_OUTPUT_DIR = Path(__file__).resolve().parent.parent / "output"

# LM + RVQ must stay on the same device during autoregressive sampling (diffusers encoders.py).
_AR_OFFLOAD_PAIR = frozenset({"language_model", "rvq_depth_decoder"})

# One generation at a time: concurrent CUDA + auto-offload deadlocks / OOMs on 24G.
_GENERATE_LOCK = threading.Lock()


def _memory_reserve_margin() -> str:
    return str(os.environ.get("MUSIC3_MEMORY_RESERVE_MARGIN", "6GB")).strip() or "6GB"


def _pipeline_components_manager(pipe: Any) -> Any:
    return getattr(pipe, "_components_manager", None) or getattr(pipe, "components_manager", None)


class Music3AutoregressiveOffloadStrategy:
    """Offload strategy aligned with diffusers MiniMaxMusic3SemanticGenerationStep.

    When placing language_model or rvq_depth_decoder on GPU, offload every other
  component first so both AR models can colocate (default AutoOffloadStrategy may
    leave LM on GPU and RVQ on CPU → RuntimeError).
    """

    def __init__(self, memory_reserve_margin: str = "6GB") -> None:
        self.memory_reserve_margin = memory_reserve_margin
        self._fallback = (
            AutoOffloadStrategy(memory_reserve_margin=memory_reserve_margin)
            if AutoOffloadStrategy is not None
            else None
        )

    def __call__(self, hooks, model_id, model, execution_device):
        if model_id in _AR_OFFLOAD_PAIR:
            return [h for h in hooks if h.model_id not in _AR_OFFLOAD_PAIR]
        if self._fallback is not None:
            return self._fallback(hooks, model_id, model, execution_device)
        return list(hooks)


def resolve_model_path(model_path: str | Path | None = None) -> str:
    if model_path:
        return str(Path(model_path).expanduser().resolve())
    if DEFAULT_LOCAL_MODEL.is_dir() and any(DEFAULT_LOCAL_MODEL.iterdir()):
        return str(DEFAULT_LOCAL_MODEL)
    return DEFAULT_MODEL_ID


def slugify(text: str, max_len: int = 48) -> str:
    text = text.strip().lower()
    text = re.sub(r"[^\w\s-]+", "", text, flags=re.UNICODE)
    text = re.sub(r"[\s_-]+", "-", text).strip("-")
    return (text[:max_len] or "song").rstrip("-")


def build_output_path(
    output_dir: str | Path,
    filename: str | None = None,
    prompt: str = "",
    seed: int = 0,
) -> Path:
    out_dir = Path(output_dir).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    if filename:
        path = out_dir / filename
        if path.suffix.lower() not in {".wav", ".flac"}:
            path = path.with_suffix(".wav")
        return path
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    base = slugify(prompt.split("\n", 1)[0]) if prompt else "minimax-music3"
    return out_dir / f"{stamp}_{base}_seed{seed}.wav"


class Music3Generator:
    """Lazy-loaded ModularPipeline wrapper with 24GB-safe defaults."""

    def __init__(
        self,
        model_path: str | Path | None = None,
        *,
        dtype: torch.dtype = torch.bfloat16,
        offload: bool = True,
        device: str = "cuda",
    ) -> None:
        self.model_path = resolve_model_path(model_path)
        self.dtype = dtype
        self.offload = offload
        self.device = device
        self.pipe: Any = None
        self.sampling_rate: int = 44100

    def load(self) -> None:
        if self.pipe is not None:
            return
        if self.device.startswith("cuda") and not torch.cuda.is_available():
            raise RuntimeError("CUDA is required for MiniMax Music 3 inference.")

        from diffusers import ComponentsManager, ModularPipeline

        if self.offload:
            manager = ComponentsManager()
            margin = _memory_reserve_margin()
            strategy = Music3AutoregressiveOffloadStrategy(memory_reserve_margin=margin)
            # Larger margin + AR-pair strategy: LM + RVQ must fit together on 24G.
            manager.enable_auto_cpu_offload(
                device=self.device,
                memory_reserve_margin=margin,
                offload_strategy=strategy,
            )
            pipe = ModularPipeline.from_pretrained(
                self.model_path,
                components_manager=manager,
            )
            pipe.load_components(dtype=self.dtype)
        else:
            pipe = ModularPipeline.from_pretrained(self.model_path)
            pipe.load_components(dtype=self.dtype)
            pipe.to(self.device)

        self.pipe = pipe
        self.sampling_rate = int(getattr(pipe, "sampling_rate", 44100))

    def unload(self) -> None:
        """Drop the pipeline and free CUDA memory (used when switching model/offload)."""
        self.release_vram()
        self.pipe = None
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

    def release_vram(self) -> None:
        """Force all auto-offload hooks back to CPU after a run.

        Without this, LM/DiT/vocoder often remain resident on GPU after the first song.
        The second generate then stalls or OOMs while the offload strategy juggles 24G.
        """
        pipe = self.pipe
        if pipe is None:
            return

        cm = _pipeline_components_manager(pipe)
        hooks = getattr(cm, "model_hooks", None) if cm is not None else None
        if hooks:
            for hook in hooks:
                try:
                    hook.offload()
                except Exception:
                    pass
        else:
            # No auto-offload hooks: move modules back to CPU manually.
            components = getattr(pipe, "components", None)
            if isinstance(components, dict):
                for component in components.values():
                    if isinstance(component, torch.nn.Module):
                        try:
                            component.to("cpu")
                        except Exception:
                            pass

        gc.collect()
        if torch.cuda.is_available():
            try:
                torch.cuda.synchronize()
            except Exception:
                pass
            torch.cuda.empty_cache()

    def prepare_for_autoregressive(self) -> None:
        """Reclaim GPU and pre-place LM + RVQ via the same hooks the AR step uses."""
        if not self.offload or self.pipe is None:
            return
        self.release_vram()
        pipe = self.pipe
        lm = pipe.components.get("language_model")
        rvq = pipe.components.get("rvq_depth_decoder")
        if lm is None or rvq is None:
            return
        hooked = [
            m
            for m in (lm, rvq)
            if getattr(m, "_hf_hook", None) is not None
            and hasattr(m._hf_hook, "pre_forward")
        ]
        for model in hooked:
            try:
                model._hf_hook.pre_forward(model)
            except Exception:
                pass
        if torch.cuda.is_available() and convert_file_size_to_int is not None:
            try:
                free_b, total_b = torch.cuda.mem_get_info()
                margin = convert_file_size_to_int(_memory_reserve_margin())
                print(
                    f"[music3] VRAM free {free_b / 1024**3:.2f}GB / "
                    f"{total_b / 1024**3:.2f}GB (margin {margin / 1024**3:.1f}GB)",
                    flush=True,
                )
            except Exception:
                pass

    def generate(
        self,
        prompt: str,
        lyrics: str,
        *,
        audio_duration: float = 60.0,
        seed: int = 7,
        output_dir: str | Path = DEFAULT_OUTPUT_DIR,
        filename: str | None = None,
    ) -> dict[str, Any]:
        prompt = (prompt or "").strip()
        lyrics = (lyrics or "").strip()
        if not prompt:
            raise ValueError("prompt (music description / caption) is required")
        if not lyrics:
            raise ValueError("lyrics are required (use [instrumental] for no vocals)")
        if audio_duration <= 0 or audio_duration > 150:
            raise ValueError("audio_duration must be in (0, 150] seconds")

        with _GENERATE_LOCK:
            self.load()
            assert self.pipe is not None

            # Free leftover residency from the previous song before allocating again.
            self.release_vram()
            self.prepare_for_autoregressive()

            try:
                # CPU generator avoids pinning CUDA RNG state across offload cycles.
                generator = torch.Generator(device="cpu").manual_seed(int(seed))
                audio = self.pipe(
                    prompt=prompt,
                    lyrics=lyrics,
                    audio_duration=float(audio_duration),
                    generator=generator,
                    output="audios",
                )[0]

                if hasattr(audio, "detach"):
                    wav = audio.detach().float().cpu().numpy()
                    del audio
                else:
                    wav = audio
                    if hasattr(wav, "astype"):
                        wav = wav.astype("float32", copy=False)

                # pipe returns [channels, samples] or [samples, channels]
                if getattr(wav, "ndim", 0) == 2 and wav.shape[0] <= 8 and wav.shape[0] < wav.shape[1]:
                    wav = wav.T

                out_path = build_output_path(
                    output_dir, filename=filename, prompt=prompt, seed=seed
                )
                sf.write(str(out_path), wav, self.sampling_rate)
                duration_sec = float(wav.shape[0]) / float(self.sampling_rate)
            finally:
                # Always reclaim VRAM so the next song can start cleanly.
                self.release_vram()

            return {
                "path": str(out_path),
                "sampling_rate": self.sampling_rate,
                "duration_sec": duration_sec,
                "seed": int(seed),
                "audio_duration_requested": float(audio_duration),
                "model_path": self.model_path,
            }
