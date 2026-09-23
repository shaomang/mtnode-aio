"""Bundled MiniMax H3 exact-audio locking node."""
import torch
import torch.nn.functional as F
import torchaudio

import comfy.nested_tensor


class MiniMaxH3NativeAudioLock:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"model": ("MODEL",), "av_latent": ("LATENT",), "audio_vae": ("VAE",), "audio": ("AUDIO",)}}

    RETURN_TYPES = ("MODEL", "LATENT", "AUDIO")
    RETURN_NAMES = ("model", "av_latent", "exact_audio")
    FUNCTION = "lock_audio"
    CATEGORY = "MiniMax H3/Native Audio"

    def lock_audio(self, model, av_latent, audio_vae, audio):
        samples = av_latent.get("samples")
        if samples is None or not getattr(samples, "is_nested", False):
            raise ValueError("MiniMaxH3NativeAudioLock requires a joint MiniMax H3 AV latent.")
        video_latent, target_audio_template = samples.unbind()[:2]
        waveform = audio["waveform"][:1]
        sample_rate = int(audio["sample_rate"])
        vae_rate = int(getattr(audio_vae, "audio_sample_rate", 32000))
        if sample_rate != vae_rate:
            waveform = torchaudio.functional.resample(waveform, sample_rate, vae_rate)
        exact_audio_latent = audio_vae.encode(waveform.movedim(1, -1))
        target_t = target_audio_template.shape[-1]
        if exact_audio_latent.shape[-1] > target_t:
            exact_audio_latent = exact_audio_latent[..., :target_t]
        elif exact_audio_latent.shape[-1] < target_t:
            exact_audio_latent = F.pad(exact_audio_latent, (0, target_t - exact_audio_latent.shape[-1]))
        locked = dict(av_latent)
        locked["samples"] = comfy.nested_tensor.NestedTensor((video_latent, exact_audio_latent))
        locked["noise_mask"] = comfy.nested_tensor.NestedTensor((torch.ones_like(video_latent), torch.zeros_like(exact_audio_latent)))
        patched_model = model.clone()
        transformer_options = patched_model.model_options["transformer_options"] = patched_model.model_options.get("transformer_options", {}).copy()
        transformer_options["minimax_h3_lock_audio_clean"] = True
        return patched_model, locked, audio
