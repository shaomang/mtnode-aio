"""MiniMax Music 3 generation helpers for 24GB VRAM."""

from __future__ import annotations

import gc
import re
import threading
from datetime import datetime
from pathlib import Path
from typing import Any

import soundfile as sf
import torch


DEFAULT_MODEL_ID = "MiniMaxAI/MiniMax-Music3"
DEFAULT_LOCAL_MODEL = Path(__file__).resolve().parent.parent / "models" / "MiniMax-Music3"
DEFAULT_OUTPUT_DIR = Path(__file__).resolve().parent.parent / "output"

# One generation at a time: concurrent CUDA + auto-offload deadlocks / OOMs on 24G.
_GENERATE_LOCK = threading.Lock()


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
            # Keep a larger free margin so consecutive runs can reload LM/DiT without stalling.
            manager.enable_auto_cpu_offload(
                device=self.device,
                memory_reserve_margin="4GB",
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

        cm = getattr(pipe, "components_manager", None)
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
