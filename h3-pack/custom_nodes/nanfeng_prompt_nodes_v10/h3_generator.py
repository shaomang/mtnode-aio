"""南风 H3 多参视频生成：把官方 Ref2VA 工作流封装为单节点。"""
from __future__ import annotations

import os
import re
import math
from collections import OrderedDict

CATEGORY = "南风节点/视频生成"
FPS = 24

SAGE_MODES = [
    "disabled", "auto", "sageattn_qk_int8_pv_fp16_cuda",
    "sageattn_qk_int8_pv_fp16_triton", "sageattn_qk_int8_pv_fp8_cuda",
    "sageattn_qk_int8_pv_fp8_cuda++", "sageattn3", "sageattn3_per_block_mean",
]
H3_DEDICATED_ATTENTION_OFF = "关闭"
H3_DEDICATED_ATTENTION_AUTO = "自动"
H3_DEDICATED_ATTENTION_ON = "H3专用Sage加速"
SLA_DENSE_BACKENDS = [
    "comfy_kitchen", "pytorch", "sage:auto",
    "sage:qk_int8_pv_fp16_cuda", "sage:qk_int8_pv_fp16_triton",
    "sage:qk_int8_pv_fp8_cuda", "sage:qk_int8_pv_fp8_cuda++", "auto",
]
V7_GENERAL_SAGE_MODES = [
    H3_DEDICATED_ATTENTION_AUTO,
    "sageattn_qk_int8_pv_fp16_cuda",
    "sageattn_qk_int8_pv_fp16_triton",
    "sageattn_qk_int8_pv_fp8_cuda",
    "sageattn_qk_int8_pv_fp8_cuda++",
]
V7_ATTENTION_MODES = [
    H3_DEDICATED_ATTENTION_OFF,
    *V7_GENERAL_SAGE_MODES,
    H3_DEDICATED_ATTENTION_ON,
]


def _is_h3_video_model(filename: str) -> bool:
    """接受H3目录中的任意重命名权重，以及目录外官方/第三方H3 Ref2VA/FL2VA命名。"""
    normalized = str(filename or "").replace("\\", "/").strip("/")
    parts = normalized.split("/")
    name = parts[-1].lower() if parts else ""
    in_h3_folder = any(part.lower() == "h3" for part in parts[:-1])
    return in_h3_folder or ("h3" in name and any(tag in name for tag in ("ref2va", "fl2va")))


def _select_fl2va_model(selected_model: str, installed: list[str]) -> str:
    """FL模式优先保留用户选择的FL2VA模型，否则回退官方标准权重。"""
    selected_name = str(selected_model or "").lower()
    if "fl2va" in selected_name and selected_model in installed:
        return selected_model
    found = next((x for x in installed if "fl2va" in x.replace("\\", "/").lower()), None)
    if found:
        return found
    raise ValueError("当前ComfyUI实例未检测到已安装的MiniMax H3 FL2VA模型")


SECOND_MODEL_SAME = "跟随一采模型（质量优先）"
SECOND_MODEL_AUTO = "自动轻量模型（Ref / FL匹配）"


class NanFengH3NativePrefixLoraLoader:
    """加载原生MiniMax H3 LoRA；为缺少diffusion_model前缀的官方/LightX2V键补齐ComfyUI命名空间。"""

    @classmethod
    def INPUT_TYPES(cls):
        try:
            import folder_paths
            names = folder_paths.get_filename_list("loras")
        except Exception:
            names = []
        return {"required": {
            "model": ("MODEL",), "lora_name": (names or [""],),
            "strength_model": ("FLOAT", {"default": 0.75, "min": -2.0, "max": 2.0, "step": 0.05}),
        }}

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "load"
    CATEGORY = "南风节点/内部"

    def load(self, model, lora_name, strength_model=0.75):
        import folder_paths
        import comfy.utils
        import comfy.sd
        path = folder_paths.get_full_path_or_raise("loras", lora_name)
        lora = comfy.utils.load_torch_file(path, safe_load=True)
        normalized = {}
        native_prefixes = ("blocks.", "token_refiner.", "final_layer.")
        changed = 0
        for key, value in lora.items():
            if key.startswith(native_prefixes):
                key = "diffusion_model." + key
                changed += 1
            normalized[key] = value
        patched, _ = comfy.sd.load_lora_for_models(
            model, None, normalized, float(strength_model), 0.0,
        )
        if changed:
            print(f"[南风H3 V7] 原生4步LoRA键已转换为ComfyUI命名：{changed}/{len(lora)} tensors，{lora_name}")
        return (patched,)


def _select_second_pass_model(requested: str, installed: list[str], fl_mode: bool, first_model: str) -> str:
    """二采自动选择同任务家族的轻量权重；没有轻量版时回退当前一采模型。"""
    family = "fl2va" if fl_mode else "ref2va"
    requested = str(requested or SECOND_MODEL_SAME)
    compatible = [x for x in installed if _is_h3_video_model(x) and family in x.lower()]
    if requested == SECOND_MODEL_SAME:
        return first_model
    if requested != SECOND_MODEL_AUTO:
        if requested not in installed:
            raise ValueError(f"二采模型不存在或尚未被ComfyUI扫描：{requested}")
        if family not in requested.lower():
            raise ValueError(f"当前模式需要{family.upper()}二采模型，不能使用：{requested}")
        return requested
    for marker in ("pruned_w4a8_mixed", "w4a8_mixed", "pruned_int8", "pruned_fp8"):
        match = next((x for x in compatible if marker in x.lower()), None)
        if match:
            return match
    if family in str(first_model).lower():
        return first_model
    return compatible[0] if compatible else first_model

RATIOS = {
    "1:1 (Square)": (1, 1), "2:3 (Portrait Photo)": (2, 3),
    "3:2 (Photo)": (3, 2), "3:4 (Portrait Standard)": (3, 4),
    "4:3 (Standard)": (4, 3), "9:16 (Portrait Widescreen)": (9, 16),
    "16:9 (Widescreen)": (16, 9), "21:9 (Ultrawide)": (21, 9),
}
MEGAPIXELS = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.98, 1.0, 1.2, 1.5, 1.8, 2.0]


def resolution_from_megapixels(aspect_ratio: str, megapixels: float, multiple: int = 32) -> tuple[int, int]:
    w_ratio, h_ratio = RATIOS[aspect_ratio]
    scale = math.sqrt(float(megapixels) * 1024 * 1024 / (w_ratio * h_ratio))
    width = round(w_ratio * scale / multiple) * multiple
    height = round(h_ratio * scale / multiple) * multiple
    return max(multiple, width), max(multiple, height)


def v81_resolution_from_megapixels(aspect_ratio: str, megapixels: float, latent_align: int = 2) -> tuple[int, int]:
    """V8.1一采与官方latent二采共用同一套十进制MP和latent网格对齐尺寸规则。"""
    w_ratio, h_ratio = RATIOS[aspect_ratio]
    scale = math.sqrt(float(megapixels) * 1_000_000 / (w_ratio * h_ratio))
    latent_width = math.ceil((w_ratio * scale) / 16)
    latent_height = math.ceil((h_ratio * scale) / 16)
    align = max(1, int(latent_align))
    latent_width = math.ceil(latent_width / align) * align
    latent_height = math.ceil(latent_height / align) * align
    return latent_width * 16, latent_height * 16


class NanFengH3ImageCanvasSize32:
    """沿用首帧宽高比，按所选百万像素计算画布；最长边不超过1920并对齐32。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "image": ("IMAGE",),
            "megapixels": ("FLOAT", {"default": 0.6, "min": 0.2, "max": 2.0, "step": 0.1}),
        }}

    RETURN_TYPES = ("INT", "INT")
    RETURN_NAMES = ("width", "height")
    FUNCTION = "calculate"
    CATEGORY = CATEGORY

    def calculate(self, image, megapixels):
        source_height, source_width = int(image.shape[1]), int(image.shape[2])
        target_area = float(megapixels) * 1024 * 1024
        scale = math.sqrt(target_area / (source_width * source_height))
        width = source_width * scale
        height = source_height * scale
        if max(width, height) > 1920:
            cap_scale = 1920.0 / max(width, height)
            width *= cap_scale
            height *= cap_scale
        width = max(32, round(width / 32) * 32)
        height = max(32, round(height / 32) * 32)
        return min(1920, width), min(1920, height)


def duration_to_frames(seconds: float) -> int:
    """H3 要求帧数满足 17n+5；与原工作流公式完全一致。"""
    frames = max(5, round(float(seconds) * FPS))
    return frames + (5 - frames % 17) % 17


def _result(value):
    return value.result if hasattr(value, "result") else value


def _clean_filename(value: str) -> str:
    value = str(value or "").strip()
    return "" if value in {"未选择", "None", "null"} else value


def _parse_manual_sigmas(text: str) -> list[float]:
    """校验H3手动Sigma：从高到低、至少一个有效步骤，并且必须以0收尾。"""
    tokens = re.findall(r"[-+]?(?:\d*\.)?\d+(?:[eE][-+]?\d+)?", str(text or ""))
    values = [float(token) for token in tokens]
    if len(values) < 2:
        raise ValueError("手动西格玛至少需要两个数值，例如：1, 0.8, 0。")
    if any(not math.isfinite(value) or value < 0.0 for value in values):
        raise ValueError("手动西格玛只能填写有限的非负数值。")
    if any(current <= following for current, following in zip(values, values[1:])):
        raise ValueError("手动西格玛必须严格从高到低排列，不能重复或回升。")
    if abs(values[-1]) > 1e-8:
        raise ValueError("手动西格玛最后一个数值必须是0。")
    return values


def _build_h3_four_step_refine_sigmas(value) -> list[float]:
    """读取V8二采手动Sigma序列；兼容旧工作流保存的单个起始Sigma。"""
    tokens = re.findall(r"[-+]?(?:\d*\.)?\d+(?:[eE][-+]?\d+)?", str(value or ""))
    if len(tokens) >= 2:
        values = _parse_manual_sigmas(str(value))
        if values[0] > 1.0:
            raise ValueError("H3二采Sigma首值不能超过1。")
        return values
    if not tokens:
        raise ValueError("H3二采Sigma必须填写从高到低并以0结尾的序列。")
    # 旧V8只保存0.35这类单值；升级后继续还原成原先的固定四步轨迹。
    start = float(tokens[0])
    if not math.isfinite(start) or start <= 0.0 or start > 1.0:
        raise ValueError("H3二采Sigma必须大于0且不超过1。")
    ratios = (1.0, 22.0 / 35.0, 12.0 / 35.0, 5.0 / 35.0)
    return [start * ratio for ratio in ratios] + [0.0]


class NanFengH3UpscaleForSecondPass:
    """按目标百万像素逐帧放大一采视频，并保持原始宽高比与32倍数。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "image": ("IMAGE",),
            "megapixels": ("FLOAT", {"default": 1.0, "min": 0.2, "max": 2.0, "step": 0.1}),
            "method": (["lanczos", "bicubic", "bilinear", "nearest-exact"], {"default": "lanczos"}),
        }}

    RETURN_TYPES = ("IMAGE", "INT", "INT")
    RETURN_NAMES = ("image", "width", "height")
    FUNCTION = "upscale"
    CATEGORY = CATEGORY

    def upscale(self, image, megapixels, method):
        import comfy.utils
        source_height, source_width = int(image.shape[1]), int(image.shape[2])
        source_area = source_width * source_height
        target_area = float(megapixels) * 1024 * 1024
        if target_area <= source_area:
            return image, source_width, source_height
        scale = math.sqrt(target_area / max(1, source_area))
        width = max(32, round(source_width * scale / 32) * 32)
        height = max(32, round(source_height * scale / 32) * 32)
        samples = image[..., :3].movedim(-1, 1)
        resized = comfy.utils.common_upscale(samples, width, height, str(method), "disabled").movedim(1, -1)
        return resized, width, height


class NanFengH3AddFinalSigmaStep:
    """只在最后一个非零Sigma区间增加一个中点，供FL2VA做极轻微高频收尾。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"sigmas": ("SIGMAS",)}}

    RETURN_TYPES = ("SIGMAS",)
    FUNCTION = "add"
    CATEGORY = CATEGORY

    def add(self, sigmas):
        import torch
        if len(sigmas) < 2:
            return (sigmas,)
        midpoint = (sigmas[-2] + sigmas[-1]) * 0.5
        return (torch.cat((sigmas[:-1], midpoint.reshape(1), sigmas[-1:])),)


class NanFengH3TrimSigmasAtStart:
    """为高清二采从用户指定的精确Sigma开始，保留其后的原生下降轨迹。"""
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "sigmas": ("SIGMAS",),
            "start_sigma": ("FLOAT", {"default": 0.2, "min": 0.01, "max": 1.0, "step": 0.01}),
        }}

    RETURN_TYPES = ("SIGMAS",)
    FUNCTION = "trim"
    CATEGORY = "南风节点/内部"

    def trim(self, sigmas, start_sigma):
        import torch
        start = float(start_sigma)
        if not math.isfinite(start) or start <= 0.0:
            raise ValueError("二采起始Sigma必须是大于0的有限数值。")
        flat = sigmas.flatten()
        if flat.numel() < 2:
            raise ValueError("二采Sigma轨迹至少需要两个值。")
        if start >= float(flat[0]):
            return (flat,)
        tail = flat[flat < start]
        if tail.numel() == 0 or float(tail[-1]) != 0.0:
            tail = torch.cat((tail, flat.new_zeros(1)))
        return (torch.cat((flat.new_tensor([start]), tail)),)


def _aggressive_h3_vram_release(mm, collect_garbage):
    """卸载模型并清掉ComfyUI动态加载/异步权重转换缓冲区。"""
    mm.unload_all_models()
    # 当前ComfyUI的动态VRAM路径会保留STREAM_CAST_BUFFERS与AIMDO缓冲区；
    # 单独empty_cache不能释放仍被这些全局字典引用的GPU Tensor。
    reset_cast_buffers = getattr(mm, "reset_cast_buffers", None)
    if reset_cast_buffers is not None:
        reset_cast_buffers()
    collect_garbage()
    mm.cleanup_models()
    mm.cleanup_models_gc()
    mm.soft_empty_cache(force=True)


def _clear_optional_easy_use_cache():
    """清理已加载的EasyUse对象缓存；未安装EasyUse时保持静默。"""
    import sys
    cleared = False
    for module_name, module in list(sys.modules.items()):
        if not module_name.startswith("comfyui_easy_use") and "easy-use" not in module_name.lower():
            continue
        cache_module = module
        remove_cache = getattr(cache_module, "remove_cache", None)
        if callable(remove_cache):
            remove_cache("*")
            cleared = True
        cache_obj = getattr(cache_module, "cache", None)
        clear = getattr(cache_obj, "clear", None)
        if callable(clear):
            clear()
            cleared = True
    return cleared


def _vram_snapshot(mm):
    """返回ComfyUI可用显存、PyTorch保留池空闲和当前loaded-model数量。"""
    total_free, torch_pool_free = mm.get_free_memory(torch_free_too=True)
    loaded = len(getattr(mm, "current_loaded_models", ()))
    return total_free, torch_pool_free, loaded


def build_native_prompt(prompt: str, image_count: int, videos_with_audio: list[bool], audio_count: int) -> str:
    """将固定槽位别名转换为 H3 按实际呈现顺序生成的原生标签。"""
    mapping = {}
    for index in range(1, image_count + 1):
        mapping[f"@图片{index}"] = f"<Picture {index}>"
    audio_ordinal = 1
    for index, has_soundtrack in enumerate(videos_with_audio, 1):
        if has_soundtrack:
            mapping[f"@视频音频{index}"] = f"<Audio {audio_ordinal}>"
            audio_ordinal += 1
        mapping[f"@视频{index}"] = f"<Video {index}>"
    for index in range(1, audio_count + 1):
        mapping[f"@音频{index}"] = f"<Audio {audio_ordinal}>"
        audio_ordinal += 1

    text = str(prompt or "").strip()
    aliases = set(re.findall(r"@(图片|视频音频|视频|音频)(\d+)", text))
    unknown = sorted(f"@{kind}{number}" for kind, number in aliases if f"@{kind}{number}" not in mapping)
    if unknown:
        raise ValueError("以下@引用没有对应素材：" + "、".join(unknown))
    for source in sorted(mapping, key=len, reverse=True):
        text = text.replace(source, mapping[source])
    return text


def _load_media(image_names, video_names, audio_names):
    import folder_paths
    import nodes
    from comfy_api.latest import InputImpl
    from comfy_extras.nodes_audio import LoadAudio

    images = []
    for name in image_names:
        if name:
            images.append(nodes.LoadImage().load_image(name)[0])

    videos, video_audios, soundtrack_flags = [], [], []
    for name in video_names:
        if not name:
            continue
        path = folder_paths.get_annotated_filepath(name)
        components = InputImpl.VideoFromFile(path).get_components()
        videos.append(components.images)
        soundtrack = components.audio
        has_audio = soundtrack is not None
        soundtrack_flags.append(has_audio)
        video_audios.append(soundtrack if has_audio else None)

    audios = []
    for name in audio_names:
        if name:
            audios.append(_result(LoadAudio.execute(name))[0])
    return images, videos, video_audios, soundtrack_flags, audios


def _sample_progress_only(noise, guider, sampler, sigmas, latent):
    """等价执行 SamplerCustomAdvanced，但不生成/保留 Latent 预览图和 denoised 副本。"""
    import comfy.sample
    import comfy.model_management
    import comfy.utils

    source = latent
    latent_image = source["samples"]
    out = source.copy()
    latent_image = comfy.sample.fix_empty_latent_channels(
        guider.model_patcher,
        latent_image,
        source.get("downscale_ratio_spacial"),
        source.get("downscale_ratio_temporal"),
    )
    out["samples"] = latent_image
    noise_mask = source.get("noise_mask")
    total = max(0, int(sigmas.shape[-1]) - 1)
    pbar = comfy.utils.ProgressBar(total)

    # 保留 ComfyUI 原生进度/取消链路，只省略 latent_preview.prepare_callback 的图像解码。
    def callback(step, _x0, _x, total_steps):
        pbar.update_absolute(step + 1, total_steps, None)

    samples = guider.sample(
        noise.generate_noise(out), latent_image, sampler, sigmas,
        denoise_mask=noise_mask,
        callback=callback,
        disable_pbar=not comfy.utils.PROGRESS_BAR_ENABLED,
        seed=noise.seed,
    )
    samples = samples.to(comfy.model_management.intermediate_device())
    result = source.copy()
    result.pop("downscale_ratio_spacial", None)
    result.pop("downscale_ratio_temporal", None)
    result["samples"] = samples
    return result


class NanFengH3PrepareReferences:
    """子图内部节点：只负责素材读取和H3条件编码，可独立缓存。"""
    @classmethod
    def INPUT_TYPES(cls):
        required = {
            "clip": ("CLIP",), "video_vae": ("VAE",), "audio_vae": ("VAE",),
            "prompt": ("STRING", {"multiline": True}),
            "width": ("INT",), "height": ("INT",), "length": ("INT",),
            "reference_size": (["match", "max"],),
        }
        for kind, count in (("image", 9), ("video", 3), ("audio", 3)):
            for i in range(1, count + 1):
                required[f"{kind}_{i}"] = ("STRING", {"default": ""})
        return {"required": required}

    RETURN_TYPES = ("CONDITIONING", "LATENT")
    FUNCTION = "prepare"
    CATEGORY = "南风节点/内部"

    def prepare(self, clip, video_vae, audio_vae, prompt, width, height, length, reference_size, **kwargs):
        from comfy_extras.nodes_minimax_h3 import MiniMaxH3ReferenceToVideo
        image_names = [_clean_filename(kwargs.get(f"image_{i}")) for i in range(1, 10)]
        video_names = [_clean_filename(kwargs.get(f"video_{i}")) for i in range(1, 4)]
        audio_names = [_clean_filename(kwargs.get(f"audio_{i}")) for i in range(1, 4)]
        images, videos, video_audios, soundtrack_flags, audios = _load_media(
            [x for x in image_names if x], [x for x in video_names if x], [x for x in audio_names if x]
        )
        native_prompt = build_native_prompt(prompt, len(images), soundtrack_flags, len(audios))
        result = _result(MiniMaxH3ReferenceToVideo.execute(
            clip, video_vae, audio_vae, native_prompt, int(width), int(height), int(length), reference_size,
            {f"ref_image_{i}": v for i, v in enumerate(images)},
            {f"ref_video_{i}": v for i, v in enumerate(videos)},
            {f"ref_video_audio_{i}": v for i, v in enumerate(video_audios) if v is not None},
            {f"ref_audio_{i}": v for i, v in enumerate(audios)},
        ))
        return tuple(result)


class NanFengH3LimitImageLongEdge:
    """内部无损通路：小图原样返回；大图按比例缩小到最长边不超过1920。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "image": ("IMAGE",),
            "max_long_edge": ("INT", {"default": 1920, "min": 32, "max": 8192, "step": 32}),
        }}

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "limit"
    CATEGORY = "南风节点/内部"

    def limit(self, image, max_long_edge=1920):
        from comfy.utils import common_upscale

        height, width = int(image.shape[1]), int(image.shape[2])
        longest = max(width, height)
        maximum = int(max_long_edge)
        if longest <= maximum:
            return (image,)
        scale = maximum / longest
        target_width = max(1, round(width * scale))
        target_height = max(1, round(height * scale))
        samples = image.movedim(-1, 1)
        resized = common_upscale(samples, target_width, target_height, "lanczos", "disabled")
        return (resized.movedim(1, -1),)


class NanFengH3BlockOffloadPatch:
    """为H3开启ComfyUI原生动态权重块预取。

    对应LightX2V的Block级CPU Offload语义：完整50层仍逐层执行，只改变权重驻留与预取，
    不切Latent、不跳Block。当前ComfyUI通过动态VBAR提供等价的按块流式权重路径。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "model": ("MODEL",),
            "enabled": ("BOOLEAN", {"default": True}),
            "blocks_to_offload": ("INT", {"default": 50, "min": 50, "max": 50, "step": 1}),
        }}

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "patch"
    CATEGORY = "南风节点/内部"

    def patch(self, model, enabled=True, blocks_to_offload=50):
        blocks_to_offload = int(blocks_to_offload)
        if not enabled:
            return (model,)
        # Fail closed：AIMDO/VBAR能完成执行并不代表量化H3权重在逐层换入后数值正确。
        # 实机已出现“任务成功、编码正常、但生成画面花屏”，说明当前适配破坏了模型数值；
        # 在完成真正的H3 CPU源权重 + GPU双Block缓冲实现前，禁止继续产出错误视频。
        raise RuntimeError(
            "H3分块处理已暂时禁用：当前ComfyUI DynamicVRAM适配会导致生成画面花屏。"
            "请将“分块处理（节约显存）”设为关闭；待专用H3双缓冲Block Swap完成后再开启。"
        )


class NanFengH3ProgressSampler:
    """子图内部采样节点：保留进度，不制作Latent预览图。"""
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "noise": ("NOISE",), "guider": ("GUIDER",), "sampler": ("SAMPLER",),
            "sigmas": ("SIGMAS",), "latent_image": ("LATENT",),
        }}
    RETURN_TYPES = ("LATENT",)
    FUNCTION = "sample"
    CATEGORY = "南风节点/内部"

    def sample(self, noise, guider, sampler, sigmas, latent_image):
        return (_sample_progress_only(noise, guider, sampler, sigmas, latent_image),)


class NanFengH3ReleaseAtStart:
    """每次新任务最先执行：设置运行时显存预留并清理旧GPU驻留。"""
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "unet_name": ("STRING", {"default": ""}),
            "clip_name": ("STRING", {"default": ""}),
            "video_vae_name": ("STRING", {"default": ""}),
            "audio_vae_name": ("STRING", {"default": ""}),
            "reserved_vram_gb": ("FLOAT", {"default": 0.6, "min": 0.0, "max": 24.0, "step": 0.1}),
        }}

    RETURN_TYPES = ("STRING", "STRING", "STRING", "STRING")
    RETURN_NAMES = ("unet_name", "clip_name", "video_vae_name", "audio_vae_name")
    FUNCTION = "release"
    CATEGORY = "南风节点/内部"
    NOT_IDEMPOTENT = True

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # NOT_IDEMPOTENT在当前ComfyUI中只会把稳定node_id加入缓存键，第二次队列仍可能命中缓存。
        # NaN永不等于自身，强制每次Queue都真正执行“加载前释放”，并使下游Loader不复用旧任务对象。
        return float("NaN")

    def release(self, unet_name, clip_name, video_vae_name, audio_vae_name, reserved_vram_gb=0.0):
        import gc
        import comfy.model_management as mm
        # 与ComfyUI-ReservedVRAM相同的运行时入口；在本任务任何Loader之前设置。
        # 这是实际传给ComfyUI和AIMDO的GiB数，不做百分比换算，也不再静默截断到8 GiB。
        reserved_vram_gb = max(0.0, min(24.0, round(float(reserved_vram_gb), 1)))
        reserved_bytes = int(reserved_vram_gb * 1024 ** 3)
        mm.EXTRA_RESERVED_VRAM = reserved_bytes
        # 当前V15默认启用AIMDO DynamicVRAM；只改model_management变量并不足够。
        # 同步更新AIMDO原生simple_vram_headroom，才与main.py --reserve-vram初始化语义一致。
        try:
            import comfy_aimdo.control as aimdo_control
            if getattr(aimdo_control, "lib", None) is not None:
                aimdo_control.lib.set_simple_vram_headroom(reserved_bytes)
                aimdo_synced = True
            else:
                aimdo_synced = bool(aimdo_control.init(simple_vram_headroom=reserved_bytes))
        except Exception as exc:
            aimdo_synced = False
            print(f"[南风H3 V7] AIMDO预留显存同步失败：{exc}")
        print(f"[南风H3] 本次任务预留显存：{reserved_vram_gb:.1f} GB；AIMDO同步：{'是' if aimdo_synced else '否'}")
        before, before_pool, before_loaded = _vram_snapshot(mm)
        # 放在Loader之前而不是采样前：避免第二次任务先构造新patcher，再与旧任务驻留交叠。
        _aggressive_h3_vram_release(mm, gc.collect)
        after, after_pool, after_loaded = _vram_snapshot(mm)
        print(f"[南风H3] 新任务加载前释放显存：{before / 1024**2:.0f}→{after / 1024**2:.0f} MiB；"
              f"PyTorch池空闲 {before_pool / 1024**2:.0f}→{after_pool / 1024**2:.0f} MiB；"
              f"loaded_models {before_loaded}→{after_loaded}")
        return (unet_name, clip_name, video_vae_name, audio_vae_name)


class NanFengH3ReleaseBeforeDecode:
    """采样完成后、双VAE解码前，明确卸载扩散/文本模型的GPU驻留。"""
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"samples": ("LATENT",)}}

    RETURN_TYPES = ("LATENT",)
    FUNCTION = "release"
    CATEGORY = "南风节点/内部"
    NOT_IDEMPOTENT = True

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("NaN")

    def release(self, samples):
        import gc
        import time
        import comfy.model_management as mm
        started = time.perf_counter()
        before, before_pool, before_loaded = _vram_snapshot(mm)
        _aggressive_h3_vram_release(mm, gc.collect)
        after, after_pool, after_loaded = _vram_snapshot(mm)
        print(f"[南风H3] VAE解码前释放显存：{before / 1024**2:.0f}→{after / 1024**2:.0f} MiB；"
              f"PyTorch池空闲 {before_pool / 1024**2:.0f}→{after_pool / 1024**2:.0f} MiB；"
              f"loaded_models {before_loaded}→{after_loaded}；耗时={time.perf_counter() - started:.2f}秒")
        return (samples,)


class NanFengH3TimedVideoVAEDecode:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"samples": ("LATENT",), "vae": ("VAE",)}}

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "decode"
    CATEGORY = "南风节点/内部"

    def decode(self, samples, vae):
        import time
        started = time.perf_counter()
        latent = samples["samples"]
        if latent.is_nested:
            latent = latent.unbind()[0]
        images = vae.decode(latent)
        if len(images.shape) == 5:
            images = images.reshape(-1, images.shape[-3], images.shape[-2], images.shape[-1])
        print(f"[南风H3 V8.1] Video VAE解码耗时={time.perf_counter() - started:.2f}秒；"
              f"输出={images.shape[0]}帧 {images.shape[2]}x{images.shape[1]}")
        return (images,)


class NanFengH3TimedAudioVAEDecode:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"samples": ("LATENT",), "vae": ("VAE",)}}

    RETURN_TYPES = ("AUDIO",)
    FUNCTION = "decode"
    CATEGORY = "南风节点/内部"

    def decode(self, samples, vae):
        import time
        from comfy_extras.nodes_audio import vae_decode_audio
        started = time.perf_counter()
        audio = vae_decode_audio(vae, samples)
        waveform = audio["waveform"]
        print(f"[南风H3 V8.1] Audio VAE解码耗时={time.perf_counter() - started:.2f}秒；"
              f"采样率={audio['sample_rate']}Hz，样本={waveform.shape[-1]}")
        return (audio,)


class NanFengH3ReleaseBeforeLatentUpscale:
    """一采完成后卸载H3/条件模型，再让3D Latent Upscaler独占运行。"""
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"latent": ("LATENT",)}}

    RETURN_TYPES = ("LATENT",)
    FUNCTION = "release"
    CATEGORY = "南风节点/内部"
    NOT_IDEMPOTENT = True

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("NaN")

    def release(self, latent):
        import gc
        import comfy.model_management as mm
        _clear_optional_easy_use_cache()
        before, before_pool, before_loaded = _vram_snapshot(mm)
        _aggressive_h3_vram_release(mm, gc.collect)
        after, after_pool, after_loaded = _vram_snapshot(mm)
        print(f"[南风H3 V8] 潜空间放大前释放H3显存：{before / 1024**2:.0f}→{after / 1024**2:.0f} MiB；"
              f"PyTorch池空闲 {before_pool / 1024**2:.0f}→{after_pool / 1024**2:.0f} MiB；"
              f"loaded_models {before_loaded}→{after_loaded}")
        return (latent,)


class NanFengH3LowPeakLatentUpscaler:
    """复用官方完整3D放大器，但先在CPU转换权重精度，避免FP32整模型搬入CUDA后的转换峰值。"""
    @classmethod
    def INPUT_TYPES(cls):
        try:
            import nodes
            upstream = nodes.NODE_CLASS_MAPPINGS["H3LatentUpscalerNodeMegapixels"]
            schema = upstream.INPUT_TYPES()
            schema["required"]["aspect_ratio"] = (["latent", *RATIOS.keys()], {"default": "latent"})
            return schema
        except Exception:
            return {"required": {
                "latent": ("LATENT",), "model_name": ([''],),
                "target_megapixels": ("FLOAT", {"default": 1.0, "min": 0.1, "max": 8.0, "step": 0.1}),
                "align": ("INT", {"default": 2, "min": 2, "step": 2}),
                "device": (["cuda"], {"default": "cuda"}),
                "precision": (["fp16", "bf16"], {"default": "bf16"}),
                "aspect_ratio": (["latent", *RATIOS.keys()], {"default": "latent"}),
            }}

    RETURN_TYPES = ("LATENT",)
    FUNCTION = "run"
    CATEGORY = "南风节点/内部"

    @staticmethod
    def _upstream_common():
        import importlib
        import nodes
        upstream = nodes.NODE_CLASS_MAPPINGS["H3LatentUpscalerNodeMegapixels"]
        package = upstream.__module__.rsplit(".", 1)[0]
        return importlib.import_module(f"{package}.h3_upscaler_common")

    @staticmethod
    def _load_low_peak(common, name, device, precision):
        import gc
        import os
        import torch

        cache_key = f"{name}::{device}::{precision}"
        if cache_key in common.MODEL_CACHE:
            return common.MODEL_CACHE[cache_key]
        path = os.path.join(common.get_models_dir(), name)
        if not os.path.exists(path):
            raise FileNotFoundError(f"模型文件不存在: {path}")
        raw_sd = common._load_raw_sd(path)
        up_sd = common._extract_upscaler_sd(raw_sd)
        cfg = common._detect_arch(up_sd)
        dtype = common._PRECISION_MAP.get(precision, torch.float32)
        if dtype == torch.float32:
            raise ValueError("V8.1潜空间放大只允许fp16或bf16，禁止FP32造成显存峰值。")
        model = common.LatentResizer3D(
            in_channels=cfg["in_channels"], in_blocks=cfg["in_blocks"],
            out_blocks=cfg["out_blocks"], channels=cfg["channels"],
            dropout=cfg["dropout"], attn=cfg["attn"],
            temporal_every=cfg["temporal_every"], temporal_kernel=cfg["temporal_kernel"],
        ).to(dtype=dtype)
        model.load_state_dict(up_sd, strict=True)
        del up_sd, raw_sd
        gc.collect()
        model = model.to(device=device, dtype=dtype).eval()
        common.MODEL_CACHE[cache_key] = model
        print(f"[南风H3 V8.1] 低峰值加载放大模型：CPU {precision} → {device}；"
              f"Params={sum(p.numel() for p in model.parameters()):,}；完整Temporal推理")
        return model

    def run(self, latent, model_name, target_megapixels, align, device, precision, aspect_ratio="latent"):
        import math
        import torch
        from comfy_extras.nodes_lt import LTXVSeparateAVLatent

        if device != "cuda":
            raise ValueError("V8.1生产潜空间放大固定使用CUDA，不提供CPU回退。")
        if not str(model_name or "").strip():
            raise ValueError("当前ComfyUI实例未检测到H3潜空间放大模型；请先安装到V16的latent_upscale_models目录并刷新")
        common = self._upstream_common()
        video_latent, audio_latent = LTXVSeparateAVLatent.execute(latent)
        source = video_latent["samples"]
        source_height, source_width = int(source.shape[-2]), int(source.shape[-1])
        target_pixels = float(target_megapixels) * 1_000_000
        if aspect_ratio == "latent":
            aspect = source_width / source_height
        else:
            ratio_width, ratio_height = RATIOS[str(aspect_ratio)]
            aspect = ratio_width / ratio_height
        target_height_pixels = math.sqrt(target_pixels / aspect)
        target_width_pixels = target_height_pixels * aspect
        target_width, target_height = common._align_latent_to_grid(
            target_width_pixels, target_height_pixels, int(align),
        )
        if target_width < source_width or target_height < source_height:
            raise ValueError("target_megapixels 不能小于当前latent对应的总像素数")
        actual_megapixels = target_width * target_height * 256 / 1_000_000
        if actual_megapixels > float(target_megapixels) * 1.25:
            raise ValueError(
                f"二采Latent网格对齐={align}使目标{float(target_megapixels):g}MP膨胀到"
                f"{actual_megapixels:.3f}MP（{target_width*16}×{target_height*16}），显存风险过高；"
                "请把二采Latent网格对齐改为2。"
            )
        target_scale = math.sqrt((target_width * target_height) / (source_width * source_height))
        free = torch.cuda.mem_get_info()[0] / 1024**2 if torch.cuda.is_available() else 0
        print(f"[南风H3 V8.1] 放大准备：latent {source_width}×{source_height} → "
              f"{target_width}×{target_height}；最终像素 {target_width*16}×{target_height*16}；"
              f"实际={actual_megapixels:.3f}MP；比例={aspect_ratio}；align={align}；"
              f"precision={precision}；可用显存={free:.0f}MiB")
        dev = torch.device("cuda")
        cache_key = f"{model_name}::{dev}::{precision}"
        if cache_key not in common.MODEL_CACHE:
            self._load_low_peak(common, model_name, dev, precision)
        return common.run_upscale(
            video_latent, audio_latent, model_name, "cuda", precision,
            target_width, target_height, target_scale,
        )


class NanFengH3ReleaseLatentUpscalerBeforeSecondPass:
    """放大完成后移除上游插件模型缓存，再允许二采H3重新加载。"""
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "latent": ("LATENT",),
            "conditioning": ("CONDITIONING",),
        }}

    RETURN_TYPES = ("LATENT", "CONDITIONING")
    RETURN_NAMES = ("latent", "conditioning")
    FUNCTION = "release"
    CATEGORY = "南风节点/内部"
    NOT_IDEMPOTENT = True

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("NaN")

    def release(self, latent, conditioning):
        import gc
        import sys
        import torch
        import comfy.model_management as mm

        easy_use_cleared = _clear_optional_easy_use_cache()
        cleared = 0
        moved = 0
        # 上游3D放大器把CUDA模型保存在模块级MODEL_CACHE；torch.empty_cache不能释放这些引用。
        for module_name, module in list(sys.modules.items()):
            if "h3_upscaler_common" not in module_name.lower():
                continue
            cache = getattr(module, "MODEL_CACHE", None)
            if not isinstance(cache, dict):
                continue
            for model in list(cache.values()):
                try:
                    model.to("cpu")
                    moved += 1
                except Exception:
                    pass
            cleared += len(cache)
            cache.clear()

        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.synchronize()
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
        # 再清理ComfyUI/AIMDO动态缓冲，确保二采H3加载前没有放大器或一采残留。
        _aggressive_h3_vram_release(mm, gc.collect)
        free, pool_free, loaded = _vram_snapshot(mm)
        print(f"[南风H3 V8] 二采前已清除放大器缓存：cache={cleared}，CPU归位={moved}，"
              f"EasyUse缓存={'是' if easy_use_cleared else '无'}；"
              f"可用显存={free / 1024**2:.0f} MiB，PyTorch池空闲={pool_free / 1024**2:.0f} MiB，"
              f"loaded_models={loaded}")
        return (latent, conditioning)


class NanFengH3ClearUpscalerCacheResident:
    """V8.1按参考工作流只清放大器/EasyUse缓存，保留同一个H3 ModelPatcher供连续二采。"""
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"latent": ("LATENT",), "conditioning": ("CONDITIONING",)}}

    RETURN_TYPES = ("LATENT", "CONDITIONING")
    RETURN_NAMES = ("latent", "conditioning")
    FUNCTION = "release"
    CATEGORY = "南风节点/内部"
    NOT_IDEMPOTENT = True

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("NaN")

    def release(self, latent, conditioning):
        import gc
        import sys
        import torch
        import comfy.model_management as mm
        easy_use_cleared = _clear_optional_easy_use_cache()
        cleared = 0
        moved = 0
        for module_name, module in list(sys.modules.items()):
            if "h3_upscaler_common" not in module_name.lower():
                continue
            cache = getattr(module, "MODEL_CACHE", None)
            if not isinstance(cache, dict):
                continue
            for model in list(cache.values()):
                try:
                    model.to("cpu")
                    moved += 1
                except Exception:
                    pass
            cleared += len(cache)
            cache.clear()
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.synchronize()
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
        free, pool_free, loaded = _vram_snapshot(mm)
        print(f"[南风H3 V8.1] 二采前仅清放大器缓存并保留H3：cache={cleared}，CPU归位={moved}，"
              f"EasyUse缓存={'是' if easy_use_cleared else '无'}；"
              f"可用显存={free / 1024**2:.0f} MiB，PyTorch池空闲={pool_free / 1024**2:.0f} MiB，"
              f"loaded_models={loaded}")
        return (latent, conditioning)


class NanFengH3LoadSecondModelAfterCleanup:
    """依赖二采清理屏障后才加载干净H3，避免GraphBuilder提前物化二采模型。"""
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "unet_name": ("STRING", {"default": ""}),
            "weight_dtype": (["default", "fp8_e4m3fn", "fp8_e5m2"], {"default": "default"}),
            "dependency": ("LATENT",),
        }}

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "load"
    CATEGORY = "南风节点/内部"

    def load(self, unet_name, weight_dtype, dependency):
        import nodes
        return nodes.UNETLoader().load_unet(unet_name, weight_dtype)


class NanFengH3RebuildRefConditioningForUpscaledLatent:
    """按二采画布重新编码Ref2VA条件，避免上游通用4D resize破坏minimax_refs布局。"""
    @classmethod
    def INPUT_TYPES(cls):
        required = {
            "clip_name": ("STRING", {"default": ""}),
            "video_vae_name": ("STRING", {"default": ""}),
            "audio_vae_name": ("STRING", {"default": ""}),
            "latent": ("LATENT",),
            "prompt": ("STRING", {"multiline": True, "default": ""}),
            "length": ("INT", {"default": 124, "min": 5, "max": 3600, "step": 17}),
            "reference_size": (["max"], {"default": "max"}),
        }
        for kind, count in (("image", 9), ("video", 3), ("audio", 3)):
            for index in range(1, count + 1):
                required[f"{kind}_{index}"] = ("STRING", {"default": ""})
        return {"required": required}

    RETURN_TYPES = ("LATENT", "CONDITIONING")
    RETURN_NAMES = ("latent", "conditioning")
    FUNCTION = "rebuild"
    CATEGORY = "南风节点/内部"
    NOT_IDEMPOTENT = True

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("NaN")

    def rebuild(self, clip_name, video_vae_name, audio_vae_name, latent, prompt, length,
                reference_size="max", **kwargs):
        import gc
        import torch
        import comfy.model_management as mm
        import nodes
        from comfy_extras.nodes_minimax_h3 import MiniMaxH3ReferenceToVideo
        from comfy_extras.nodes_lt import LTXVSeparateAVLatent

        # latent已经由Upscaler写回CPU；先清空放大器GPU缓存，再加载CLIP/VAE重建目标画布条件。
        NanFengH3ReleaseLatentUpscalerBeforeSecondPass().release(latent, [])
        video_latent, _ = LTXVSeparateAVLatent.execute(latent)
        samples = video_latent["samples"]
        width, height = int(samples.shape[-1]) * 16, int(samples.shape[-2]) * 16
        del video_latent, samples

        image_names = [_clean_filename(kwargs.get(f"image_{i}")) for i in range(1, 10)]
        video_names = [_clean_filename(kwargs.get(f"video_{i}")) for i in range(1, 4)]
        audio_names = [_clean_filename(kwargs.get(f"audio_{i}")) for i in range(1, 4)]
        images, videos, video_audios, soundtrack_flags, audios = _load_media(
            [x for x in image_names if x], [x for x in video_names if x], [x for x in audio_names if x]
        )
        native_prompt = build_native_prompt(prompt, len(images), soundtrack_flags, len(audios))
        clip = nodes.CLIPLoader().load_clip(clip_name, type="minimax", device="default")[0]
        video_vae = nodes.VAELoader().load_vae(video_vae_name)[0]
        audio_vae = nodes.VAELoader().load_vae(audio_vae_name)[0]
        result = _result(MiniMaxH3ReferenceToVideo.execute(
            clip, video_vae, audio_vae, native_prompt, width, height, int(length), "max",
            {f"ref_image_{i}": value for i, value in enumerate(images)},
            {f"ref_video_{i}": value for i, value in enumerate(videos)},
            {f"ref_video_audio_{i}": value for i, value in enumerate(video_audios) if value is not None},
            {f"ref_audio_{i}": value for i, value in enumerate(audios)},
        ))
        conditioning = tuple(result)[0]
        # 目标画布重建必须产生原生minimax_refs；禁止通用4D图像Tensor插值进入二采。
        for item in conditioning:
            if not isinstance(item, (list, tuple)) or len(item) < 2 or not isinstance(item[1], dict):
                continue
            params = item[1]
            refs = params.get("minimax_refs", [])
            for ref in refs:
                z = ref.get("latent")
                if z is not None and (not isinstance(z, torch.Tensor) or z.ndim != 5 or z.shape[1] != 24):
                    raise ValueError(f"二采minimax_refs含非法视频Latent形状：{getattr(z, 'shape', None)}")
            for key, value in params.items():
                if isinstance(value, torch.Tensor) and value.ndim == 4 and value.shape[-1] in (1, 3, 4):
                    raise ValueError(f"二采Conditioning仍含BHWC图像张量 {key}={tuple(value.shape)}，已阻止高风险错误插值。")
        del clip, video_vae, audio_vae, result, images, videos, video_audios, audios
        _aggressive_h3_vram_release(mm, gc.collect)
        print(f"[南风H3 V8] 二采Ref2VA条件已按目标画布重建：{width}x{height}，随后已卸载CLIP/双VAE。")
        return (latent, conditioning)


class NanFengH3ReleaseBeforeConditioning:
    """FL2VA条件编码前释放旧GPU驻留，再按需加载CLIP与视频VAE。"""
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"clip": ("CLIP",), "vae": ("VAE",)}}

    RETURN_TYPES = ("CLIP", "VAE")
    RETURN_NAMES = ("clip", "vae")
    FUNCTION = "release"
    CATEGORY = "南风节点/内部"
    NOT_IDEMPOTENT = True

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("NaN")

    def release(self, clip, vae):
        import gc
        import comfy.model_management as mm
        before, before_pool, before_loaded = _vram_snapshot(mm)
        _aggressive_h3_vram_release(mm, gc.collect)
        after, after_pool, after_loaded = _vram_snapshot(mm)
        print(f"[南风H3] FL2VA条件编码前释放显存：{before / 1024**2:.0f}→{after / 1024**2:.0f} MiB；"
              f"PyTorch池空闲 {before_pool / 1024**2:.0f}→{after_pool / 1024**2:.0f} MiB；"
              f"loaded_models {before_loaded}→{after_loaded}")
        return (clip, vae)


class NanFengH3ReleaseBeforeConditionLoaders:
    """V3条件模型加载前屏障：先清空GPU驻留，再放行CLIP与双VAE文件名。"""
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "clip_name": ("STRING", {"default": ""}),
            "video_vae_name": ("STRING", {"default": ""}),
            "audio_vae_name": ("STRING", {"default": ""}),
        }}

    RETURN_TYPES = ("STRING", "STRING", "STRING")
    RETURN_NAMES = ("clip_name", "video_vae_name", "audio_vae_name")
    FUNCTION = "release"
    CATEGORY = "南风节点/内部"
    NOT_IDEMPOTENT = True

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("NaN")

    def release(self, clip_name, video_vae_name, audio_vae_name):
        import gc
        import comfy.model_management as mm
        before, before_pool, before_loaded = _vram_snapshot(mm)
        _aggressive_h3_vram_release(mm, gc.collect)
        after, after_pool, after_loaded = _vram_snapshot(mm)
        print(f"[南风H3 V3] 文本/参考条件模型加载前释放显存：{before / 1024**2:.0f}→{after / 1024**2:.0f} MiB；"
              f"PyTorch池空闲 {before_pool / 1024**2:.0f}→{after_pool / 1024**2:.0f} MiB；"
              f"loaded_models {before_loaded}→{after_loaded}")
        return (clip_name, video_vae_name, audio_vae_name)


class NanFengAudioPadToDuration:
    """Right-pad a trimmed AUDIO waveform with deterministic silence to the requested integer duration."""
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"audio": ("AUDIO",), "duration": ("FLOAT", {"default": 5.0, "min": 1.0, "max": 15.0, "step": 1.0})}}

    RETURN_TYPES = ("AUDIO",)
    FUNCTION = "pad"
    CATEGORY = "南风节点/内部"

    def pad(self, audio, duration):
        import torch
        waveform = audio["waveform"]
        sample_rate = int(audio["sample_rate"])
        target_samples = int(round(float(duration) * sample_rate))
        current_samples = int(waveform.shape[-1])
        if current_samples < target_samples:
            silence = torch.zeros(*waveform.shape[:-1], target_samples - current_samples, dtype=waveform.dtype, device=waveform.device)
            waveform = torch.cat((waveform, silence), dim=-1)
        elif current_samples > target_samples:
            waveform = waveform[..., :target_samples]
        return ({"waveform": waveform, "sample_rate": sample_rate},)


class NanFengH3ReleaseBeforeSampling:
    """条件编码完成后、扩散采样前释放CLIP/VAE驻留，保留已生成的条件与latent。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "model": ("MODEL",),
            "conditioning": ("CONDITIONING",),
            "latent": ("LATENT",),
        }}

    RETURN_TYPES = ("MODEL", "CONDITIONING", "LATENT")
    RETURN_NAMES = ("model", "conditioning", "latent")
    FUNCTION = "release"
    CATEGORY = "南风节点/内部"
    NOT_IDEMPOTENT = True

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("NaN")

    def release(self, model, conditioning, latent):
        import gc
        import comfy.model_management as mm
        before, before_pool, before_loaded = _vram_snapshot(mm)
        _aggressive_h3_vram_release(mm, gc.collect)
        after, after_pool, after_loaded = _vram_snapshot(mm)
        print(f"[南风H3] 条件编码后、采样前释放显存：{before / 1024**2:.0f}→{after / 1024**2:.0f} MiB；"
              f"PyTorch池空闲 {before_pool / 1024**2:.0f}→{after_pool / 1024**2:.0f} MiB；"
              f"loaded_models {before_loaded}→{after_loaded}")
        return (model, conditioning, latent)


class NanFengH3ReleaseBeforeSecondModel:
    """放大Latent就绪后卸载一采/CLIP/VAE，再按文件名加载独立二采模型。"""
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "unet_name": ("STRING", {"default": ""}),
            "conditioning": ("CONDITIONING",),
            "latent": ("LATENT",),
        }}

    RETURN_TYPES = ("STRING", "CONDITIONING", "LATENT")
    RETURN_NAMES = ("unet_name", "conditioning", "latent")
    FUNCTION = "release"
    CATEGORY = "南风节点/内部"
    NOT_IDEMPOTENT = True

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("NaN")

    def release(self, unet_name, conditioning, latent):
        import gc
        import comfy.model_management as mm
        _aggressive_h3_vram_release(mm, gc.collect)
        return (unet_name, conditioning, latent)


class NanFengH3ApplyUniBlockSwap:
    """Dependency-aware adapter: install upstream UniBlockSwap only after H3 conditioning completes."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "model": ("MODEL",), "conditioning_dependency": ("CONDITIONING",),
            "num_blocks": ("INT", {"default": 1, "min": 1, "max": 49, "step": 1}),
        }}

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "apply"
    CATEGORY = CATEGORY

    def apply(self, model, conditioning_dependency, num_blocks=1):
        try:
            import importlib
            module = importlib.import_module("ComfyUI_UniBlockSwap.uniblockswap_node")
        except Exception as exc:
            raise RuntimeError("V8已开启UniBlockSwap，但插件未成功加载；请检查ComfyUI_UniBlockSwap安装。") from exc
        return module.UniBlockSwap().apply_swap(model, int(num_blocks))


class NanFengH3MultiReferenceGenerator:
    @staticmethod
    def _live_combo(values, preferred=None):
        live = list(dict.fromkeys(str(value) for value in values if str(value).strip()))
        options = {}
        if preferred in live:
            options["default"] = preferred
        elif live:
            options["default"] = live[0]
        return (live, options)

    @classmethod
    def INPUT_TYPES(cls):
        try:
            import folder_paths
            model_options = folder_paths.get_filename_list("diffusion_models")
            text_encoders = folder_paths.get_filename_list("text_encoders")
            vaes = folder_paths.get_filename_list("vae")
        except Exception:
            model_options = []
            text_encoders = []
            vaes = []

        # 与当前ComfyUI原生KSampler保持同一来源；第三方注册的新采样器也会自动进入列表。
        try:
            import comfy.samplers
            sampler_options = list(comfy.samplers.KSampler.SAMPLERS)
            scheduler_options = list(comfy.samplers.KSampler.SCHEDULERS)
        except Exception:
            sampler_options = ["res_multistep"]
            scheduler_options = ["simple"]

        h3_models = [x for x in model_options if _is_h3_video_model(x)]
        source_model = next(
            (x for x in h3_models if "ref2va" in x.replace("\\", "/").lower() and "pruned" not in x.lower()),
            next((x for x in h3_models if "ref2va" in x.replace("\\", "/").lower()), h3_models[0] if h3_models else None),
        )
        h3_text_encoders = [x for x in text_encoders if "minimax_h3" in x.lower()]
        h3_video_vaes = [x for x in vaes if "minimax_h3_video_vae" in x.lower()]
        h3_audio_vaes = [x for x in vaes if "minimax_h3_audio_vae" in x.lower()]

        required = OrderedDict([
            ("模型", cls._live_combo(h3_models, source_model)),
            ("文本编码器", cls._live_combo(h3_text_encoders)),
            ("文本编码器类型", (["minimax"], {"default": "minimax"})),
            ("文本编码器设备", (["default", "cpu"], {"default": "default"})),
            ("视频VAE", cls._live_combo(h3_video_vaes)),
            ("音频VAE", cls._live_combo(h3_audio_vaes)),
            ("模型权重精度", (["default", "fp8_e4m3fn", "fp8_e5m2"], {"default": "default"})),
            # 与 F:/video_minimax_h3_r2v (1).json 一致：KJ SageAttention=auto。
            ("SageAttention", (SAGE_MODES, {"default": "auto"})),
            ("允许编译", ("BOOLEAN", {"default": False})),
            ("画面比例", (list(RATIOS), {"default": "16:9 (Widescreen)"})),
            ("百万像素", (MEGAPIXELS, {"default": 0.4})),
            ("尺寸倍数", ([32], {"default": 32})),
            ("时长秒", ("FLOAT", {"default": 5.0, "min": 1.0, "max": 15.0, "step": 0.5})),
            ("提示词", ("STRING", {"multiline": True, "dynamicPrompts": True, "default": ""})),
            ("随机种子", ("INT", {"default": 470115107471061, "min": 0, "max": 0xffffffffffffffff, "control_after_generate": True})),
            ("采样器", (sampler_options, {"default": "res_multistep" if "res_multistep" in sampler_options else sampler_options[0]})),
            ("调度器", (scheduler_options, {"default": "simple" if "simple" in scheduler_options else scheduler_options[0]})),
            ("采样步数", ("INT", {"default": 20, "min": 1, "max": 100})),
            ("降噪强度", ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01})),
            ("参考图尺寸", (["match", "max"], {"default": "match"})),
        ])
        # 文件由前端素材卡上传到 ComfyUI/input；普通下拉作为无 JS 时的兼容回退。
        try:
            files = sorted(os.listdir(folder_paths.get_input_directory()))
        except Exception:
            files = []
        choices = ["未选择"] + files
        for kind, count in (("图片", 9), ("视频", 3), ("音频", 3)):
            for index in range(1, count + 1):
                required[f"{kind}{index}"] = (choices, {"default": "未选择"})
        # 序列化层必须追加在全部旧字段之后，避免升级时把旧工作流的降噪、参考图和素材按位置错写。
        # 自定义DOM仍把它们显示在采样步数正下方。
        required["文生视频"] = ("BOOLEAN", {"default": False})
        required["图生视频"] = ("BOOLEAN", {"default": False})
        required["首尾帧"] = ("BOOLEAN", {"default": False})
        return {"required": required}

    RETURN_TYPES = ("IMAGE", "AUDIO")
    RETURN_NAMES = ("图像", "音频")
    FUNCTION = "generate"
    CATEGORY = CATEGORY
    DESCRIPTION = "本地 MiniMax H3 Ref2VA 一体化生成：9图、3视频、3音频，输出最终图像帧与音频。"

    def generate(self, 模型, 文本编码器, 文本编码器类型, 文本编码器设备, 视频VAE, 音频VAE,
                 模型权重精度, SageAttention, 允许编译, 画面比例, 百万像素, 尺寸倍数, 时长秒, 提示词, 随机种子,
                 采样器, 调度器, 采样步数, 降噪强度, 参考图尺寸="match", 文生视频=False, 图生视频=False, 首尾帧=False, unique_id=None, **kwargs):
        # Public V10 distribution: second-pass paths are intentionally disabled.
        # Force every legacy/imported workflow onto the original single-pass path.
        kwargs["启用H3潜空间放大二采"] = False
        kwargs["启用高清二采"] = False
        kwargs["启用双采样"] = False
        from comfy_execution.graph_utils import GraphBuilder
        image_names = [_clean_filename(kwargs.get(f"图片{i}")) for i in range(1, 10)]
        video_names = [_clean_filename(kwargs.get(f"视频{i}")) for i in range(1, 4)]
        audio_names = [_clean_filename(kwargs.get(f"音频{i}")) for i in range(1, 4)]
        audio_lock_enabled = (
            type(self) is NanFengH3MultiReferenceGeneratorV10
            and bool(kwargs.get("启用锁音频", False))
        )
        audio_drive_enabled = (
            type(self) is NanFengH3MultiReferenceGeneratorV10
            and bool(kwargs.get("开启音频驱动模式", False))
        )
        if audio_drive_enabled and not audio_lock_enabled:
            # 智能音频驱动负责分镜拆分；真正采样必须显式勾选锁音频，避免只按画面分镜生成却重绘音轨。
            raise ValueError("智能音频驱动生成必须同时勾选“开启锁音频”，才能把当前音频分段锁入NativeAudioLock。")
        audio_drive_filename = _clean_filename(kwargs.get("音频驱动文件")) if audio_drive_enabled else ""
        if type(self) is NanFengH3MultiReferenceGeneratorV10:
            trigger = str(kwargs.get("恒定触发词", "")).strip()
            body = str(提示词 or "").lstrip("\r\n")
            提示词 = f"{trigger}\n{body}" if trigger and body else (trigger or body)
        if audio_drive_enabled and not audio_drive_filename:
            raise ValueError("智能音频驱动已开启，但没有可用于锁定的音频驱动文件。")
        selected_modes = [name for name, enabled in (("文生视频", 文生视频), ("图生视频", 图生视频), ("首尾帧", 首尾帧)) if enabled]
        if len(selected_modes) > 1:
            raise ValueError("文生视频、图生视频、首尾帧只能开启一个。")
        fl_mode = selected_modes[0] if selected_modes else ""
        # 槽位编号必须连续，确保可见 @编号 与 H3 原生编号完全一致。
        for label, values in (("图片", image_names), ("视频", video_names), ("音频", audio_names)):
            seen_gap = False
            for value in values:
                if not value:
                    seen_gap = True
                elif seen_gap:
                    raise ValueError(f"{label}槽位必须从1开始连续添加，不能跳号。")

        if fl_mode and any(video_names + audio_names):
            raise ValueError(f"{fl_mode}模式不接受视频或音频参考，请清空对应素材。")
        image_count = sum(bool(x) for x in image_names)
        if fl_mode == "文生视频" and image_count:
            raise ValueError("文生视频模式不能上传图片。")
        if fl_mode == "图生视频" and image_count != 1:
            raise ValueError("图生视频模式必须上传1张图片作为首帧。")
        if fl_mode == "首尾帧" and image_count != 2:
            raise ValueError("首尾帧模式必须上传2张图片：图片1为首帧、图片2为尾帧。")
        effective_audio_names = [audio_drive_filename] if audio_drive_enabled else audio_names
        if not fl_mode and not any(image_names + video_names + effective_audio_names):
            raise ValueError("请至少拖入一张图片、一个视频或一段音频。")
        if audio_lock_enabled and fl_mode:
            raise ValueError("锁音频只适用于多参Ref2VA模式；文生、图生和首尾帧模式不接受音频输入。")
        if audio_lock_enabled and not (audio_drive_filename if audio_drive_enabled else audio_names[0]):
            raise ValueError("开启锁音频后必须提供要锁定的完整源音轨；智能音频驱动模式使用其专属上传音频。")
        if audio_lock_enabled and not audio_drive_enabled and (audio_names[1] or audio_names[2]):
            raise ValueError("普通锁音频模式只锁定音频1；请清空音频2和音频3，避免最终音轨含义不明确。")
        original_ratio = isinstance(self, NanFengH3MultiReferenceGeneratorV4) and 画面比例 == "原图比例"
        if original_ratio and fl_mode not in {"图生视频", "首尾帧"}:
            raise ValueError("原图比例只适用于图生视频或首尾帧。")
        width, height = (
            (32, 32)
            if original_ratio
            else v81_resolution_from_megapixels(
                画面比例, 百万像素, int(kwargs.get("H3潜空间对齐", 2)),
            )
            if isinstance(self, NanFengH3MultiReferenceGeneratorV81)
            else resolution_from_megapixels(画面比例, 百万像素, int(尺寸倍数))
        )
        length = duration_to_frames(时长秒)
        reference_long_edge = int(kwargs.get("参考图最长边", 1920)) if isinstance(self, NanFengH3MultiReferenceGeneratorV81) else 1920
        if reference_long_edge not in {1280, 1536, 1920}:
            raise ValueError("参考图最长边只能选择1280、1536或1920")

        # 关键修复：展开成真实ComfyUI子图。Loader/条件/采样/解码重新成为独立缓存节点，
        # 不再在一个Python函数中手工持有整套模型对象。
        g = GraphBuilder()
        selected_model = 模型
        # V6起，模式切换只改变条件节点，不得替用户改动“模型”下拉选择。
        # V1-V5保留既有自动Ref/FL家族切换，避免破坏旧工作流行为。
        if fl_mode and not isinstance(self, NanFengH3MultiReferenceGeneratorV6):
            try:
                import folder_paths
                installed = folder_paths.get_filename_list("diffusion_models")
            except Exception:
                installed = []
            selected_model = _select_fl2va_model(模型, installed)
        # 起始释放节点同时作为四个Loader名称的依赖屏障，保证它必定先于任何大模型加载执行。
        start = g.node(
            "NanFengH3ReleaseAtStart", unet_name=selected_model, clip_name=文本编码器,
            video_vae_name=视频VAE, audio_vae_name=音频VAE,
            reserved_vram_gb=(
                float(kwargs.get("运行时预留显存GB", 0.6))
                if isinstance(self, NanFengH3MultiReferenceGeneratorV8) and bool(kwargs.get("启用运行时预留显存", False))
                else 0.0
            ),
        )
        model = g.node("UNETLoader", unet_name=start.out(0), weight_dtype=模型权重精度)
        # V8潜空间二采可从未叠加主生成LoRA的基础ModelPatcher另开分支。
        # 这里只保存图输出引用，不额外加载一份H3权重。
        base_model_for_v8_second_pass = model.out(0)
        # V2-only chain. LoRA belongs immediately after the base diffusion model so every
        # later model patch (Sage/Sol-Attn) sees the LoRA-patched weights. V1 does not
        # expose these kwargs and therefore remains byte-for-byte equivalent at runtime.
        individual_lora_slots = isinstance(self, NanFengH3MultiReferenceGeneratorV9)
        for lora_name, strength in _enabled_lora_stack(kwargs, individual=individual_lora_slots):
            model = g.node(
                "LoraLoaderModelOnly", model=model.out(0),
                lora_name=lora_name, strength_model=strength,
            )
        sol_enabled = bool(kwargs.get("启用SolAttn", False))
        t8_enabled = bool(kwargs.get("启用T8缓存", False))
        selected_h3_attention = kwargs.get(
            "H3专用注意力",
            H3_DEDICATED_ATTENTION_ON if isinstance(self, NanFengH3MultiReferenceGeneratorV7) else H3_DEDICATED_ATTENTION_OFF,
        )
        sla_enabled = isinstance(self, NanFengH3MultiReferenceGeneratorV9) and bool(kwargs.get("启用H3 SLA", False))
        h3_dedicated_attention = (
            isinstance(self, (NanFengH3MultiReferenceGeneratorV6, NanFengH3MultiReferenceGeneratorV7))
            and selected_h3_attention == H3_DEDICATED_ATTENTION_ON
            and not sla_enabled
        )
        if sla_enabled:
            # SLA owns H3 self-attention. Existing generic/H3 Sage choices are bypassed,
            # while SLA may independently use Sage only for its dense fallback backend.
            SageAttention = "disabled"
            sol_enabled = False
            t8_enabled = False
        if isinstance(self, NanFengH3MultiReferenceGeneratorV7):
            # V7统一下拉：关闭、40系可用的通用Sage各后端、H3专用Sage；旧Sol/T8字段不再执行。
            SageAttention = (
                "auto" if selected_h3_attention == H3_DEDICATED_ATTENTION_AUTO
                else selected_h3_attention if selected_h3_attention in V7_GENERAL_SAGE_MODES
                else "disabled"
            )
            sol_enabled = False
            t8_enabled = False
        if h3_dedicated_attention and (sol_enabled or t8_enabled):
            raise ValueError("H3专用注意力与 Sol-Attn、T8 Block Cache 互斥；请只开启一种加速机制。")
        # Sage and Sol both replace the attention backend. T8 uses exception-based
        # block short-circuiting and has not been proven safe when combined with the
        # generic Sage override on long H3 sequences. V3 therefore selects exactly
        # one acceleration branch: Sol, T8, or Sage/base.
        skip_sage_for_specialized = (
            isinstance(self, NanFengH3MultiReferenceGeneratorV3)
            and (sol_enabled or t8_enabled)
        )
        if sla_enabled:
            model = g.node(
                "H3SLAAttention", model=model.out(0), enabled=True,
                sparsity_ratio=float(kwargs.get("SLA稀疏率", 0.90)),
                block_size=str(kwargs.get("SLA块大小", "64")),
                min_seq_len=int(kwargs.get("SLA最短序列", 4096)),
                dense_last_steps=int(kwargs.get("SLA末尾稠密步数", 1)),
                protect_audio=bool(kwargs.get("SLA保护音频", True)),
                dense_steps=str(kwargs.get("SLA指定稠密步", "0")),
                dense_backend=str(kwargs.get("SLA稠密后端", "comfy_kitchen")),
                disable_fp16_accum=bool(kwargs.get("SLA关闭FP16累加", True)),
                stabilize_motion=bool(kwargs.get("SLA稳定运动", True)),
            )
        elif h3_dedicated_attention:
            model = g.node("MiniMaxH3MemoryEfficientSageAttentionPatch", model=model.out(0))
        elif SageAttention != "disabled" and not skip_sage_for_specialized:
            model = g.node("PathchSageAttentionKJ", model=model.out(0), sage_attention=SageAttention, allow_compile=bool(允许编译))
        # V8二采只记录LoRA模式；二采模型必须等CUDA放大器清理屏障完成后再重新加载。
        # 禁止在这里从一采UNETLoader预建第二ModelPatcher，否则GraphBuilder可能提前物化它，
        # 并让一采模型、放大器与二采模型在显存中重叠。
        second_lora_mode = "继承一采LoRA"
        if isinstance(self, NanFengH3MultiReferenceGeneratorV8) and not isinstance(self, NanFengH3MultiReferenceGeneratorV81) and bool(kwargs.get("启用H3潜空间放大二采", False)):
            second_lora_mode = str(kwargs.get("H3二采LoRA模式", "继承一采LoRA"))
            if second_lora_mode not in {"独立4步LoRA", "继承一采LoRA", "不使用LoRA"}:
                raise ValueError(f"未知H3二采LoRA模式：{second_lora_mode}")
        # V7不再执行KJ低显存注意力；旧字段仅保留序列化兼容。
        if sol_enabled and t8_enabled:
            raise ValueError("Sol-Attn 与 T8 Block Cache 不能同时开启；请只勾选其中一个，或将两者都关闭。")
        # 条件阶段结束前只建立基础模型/LoRA/Sage/T8的普通patch链。
        # Sol的flex wrapper会在首次采样时编译；必须放到强制清理屏障之后创建，
        # 否则reset_cast_buffers/force empty cache可能破坏其刚建立的编译状态，卡在0% Model Initializing。
        sol_config = None
        defer_sol_until_after_release = isinstance(self, NanFengH3MultiReferenceGeneratorV3)
        if sol_enabled:
            sol_config = {
                "tau": float(kwargs.get("SolAttn_tau", 1.2)),
                "thresh_type": str(kwargs.get("SolAttn阈值类型", "diag")),
                "exact_mode": str(kwargs.get("SolAttn精确模式", "exact_kv")),
                "dense_steps": int(kwargs.get("SolAttn完整末步", 1)),
                "step_off": float(kwargs.get("SolAttn末段比例", 0.0)),
                "sink_tokens": int(kwargs.get("SolAttn前缀Token", 0)),
            }
            if not defer_sol_until_after_release:
                model = g.node(
                    "SolAttnMiniMaxH3Patcher", model=model.out(0), enabled=True, **sol_config,
                )
                sol_config = None
        # V3 T8 branch: T8 alone after LoRA/base model. The generic Sage override is
        # intentionally skipped for this branch until a real cache-hit compatibility run passes.
        if t8_enabled:
            model = g.node(
                "MiniMaxH3BlockCacheT8", model=model.out(0),
                residual_diff_threshold=float(kwargs.get("T8残差阈值", 0.12)),
                start_percent=float(kwargs.get("T8开始比例", 0.08)),
                end_percent=float(kwargs.get("T8结束比例", 0.95)),
                max_consecutive_hits=int(kwargs.get("T8连续命中", 2)),
                cache_device=str(kwargs.get("T8缓存设备", "cpu")),
                metric_stride=int(kwargs.get("T8指标步幅", 8)),
                verbose=bool(kwargs.get("T8详细日志", False)),
            )
        # V8可选接入上游UniBlockSwap。放在LoRA与注意力补丁之后，使主采样和潜空间二采
        # 共用同一个已打补丁模型；默认关闭时V7图完全不变。
        if isinstance(self, NanFengH3MultiReferenceGeneratorV8) and bool(kwargs.get("启用UniBlockSwap", False)):
            # UniBlockSwap自身会清理除传入DiT外的已加载模型；必须等条件编码结束后再安装，
            # 否则GraphBuilder的执行调度可能让它提前卸载正在使用的CLIP/VAE。
            # 这里只记录参数，实际接入点在条件后的NanFengH3ReleaseBeforeSampling之前。
            uniblockswap_blocks = int(kwargs.get("UniBlockSwap常驻块数", 1))
        else:
            uniblockswap_blocks = None
        # V3专用条件相位屏障只依赖起始释放节点，不依赖DiT/LoRA/加速patch链。
        # 这样条件编码阶段沿用官方工作流的“CLIP+双VAE先执行”节奏，不会提前prepare MiniMaxH3。
        if isinstance(self, NanFengH3MultiReferenceGeneratorV3):
            conditioning_phase = g.node(
                "NanFengH3ReleaseBeforeConditionLoaders",
                clip_name=start.out(1), video_vae_name=start.out(2), audio_vae_name=start.out(3),
            )
            clip_name, video_vae_name, audio_vae_name = conditioning_phase.out(0), conditioning_phase.out(1), conditioning_phase.out(2)
        else:
            clip_name, video_vae_name, audio_vae_name = start.out(1), start.out(2), start.out(3)
        clip = g.node("CLIPLoader", clip_name=clip_name, type=文本编码器类型, device=文本编码器设备)
        video_vae = g.node("VAELoader", vae_name=video_vae_name)
        audio_vae = g.node("VAELoader", vae_name=audio_vae_name)
        if fl_mode:
            # 1:1复刻 F:/video_minimax_h3_i2v (5).json 的官方原生条件节点。
            conditioning_release = g.node("NanFengH3ReleaseBeforeConditioning", clip=clip.out(0), vae=video_vae.out(0))
            condition_inputs = {
                "clip": conditioning_release.out(0), "vae": conditioning_release.out(1), "prompt": 提示词,
                "width": width, "height": height, "length": length,
            }
            if image_count:
                first = g.node("LoadImage", image=image_names[0])
                first_limited = g.node("NanFengH3LimitImageLongEdge", image=first.out(0), max_long_edge=reference_long_edge)
                condition_inputs["first_frame"] = first_limited.out(0)
                if original_ratio:
                    image_size = g.node("NanFengH3ImageCanvasSize32", image=first_limited.out(0), megapixels=float(百万像素))
                    condition_inputs["width"] = image_size.out(0)
                    condition_inputs["height"] = image_size.out(1)
            if fl_mode == "首尾帧":
                last = g.node("LoadImage", image=image_names[1])
                last_limited = g.node("NanFengH3LimitImageLongEdge", image=last.out(0), max_long_edge=reference_long_edge)
                condition_inputs["last_frame"] = last_limited.out(0)
            prepared = g.node("MiniMaxH3ImageToVideo", **condition_inputs)
        else:
            # 1:1复刻Ref2VA：素材保持独立原生子节点缓存边界。
            reference_audio_names = [audio_drive_filename] if audio_drive_enabled else audio_names
            condition_inputs = {
                "clip": clip.out(0), "vae": video_vae.out(0), "audio_vae": audio_vae.out(0),
                "prompt": build_native_prompt(提示词, image_count, [True for x in video_names if x], sum(bool(x) for x in reference_audio_names)), "width": width, "height": height, "length": length,
                # One sizing authority: upstream longest-edge 1920. Native "max" never upscales
                # and therefore leaves this capped input unchanged apart from required 32px alignment.
                # The legacy serialized widget remains for old-workflow index compatibility only.
                "ref_image_size": "max",
            }
            for i, filename in enumerate((x for x in image_names if x)):
                loaded = g.node("LoadImage", image=filename)
                limited = g.node("NanFengH3LimitImageLongEdge", image=loaded.out(0), max_long_edge=reference_long_edge)
                condition_inputs[f"ref_images.ref_image_{i}"] = limited.out(0)
            for i, filename in enumerate((x for x in video_names if x)):
                loaded = g.node("LoadVideo", file=filename)
                components = g.node("GetVideoComponents", video=loaded.out(0))
                condition_inputs[f"ref_videos.ref_video_{i}"] = components.out(0)
                condition_inputs[f"ref_video_audios.ref_video_audio_{i}"] = components.out(1)
            for i, filename in enumerate((x for x in reference_audio_names if x)):
                loaded = g.node("LoadAudio", audio=filename)
                if audio_drive_enabled:
                    loaded = g.node(
                        "TrimAudioDuration", audio=loaded.out(0),
                        start_index=float(kwargs.get("音频驱动当前起点", 0.0)), duration=float(时长秒),
                    )
                condition_inputs[f"ref_audios.ref_audio_{i}"] = loaded.out(0)
            prepared = g.node("MiniMaxH3ReferenceToVideo", **condition_inputs)
        # 明确依赖屏障：只有条件编码完成后才安装可选Swap并释放CLIP/VAE，再开始采样。
        sampling_model_input = model.out(0)
        sampling_latent_input = prepared.out(1)
        exact_audio_output = None
        if uniblockswap_blocks is not None:
            sampling_model_input = g.node(
                "NanFengH3ApplyUniBlockSwap", model=sampling_model_input,
                conditioning_dependency=prepared.out(0), num_blocks=uniblockswap_blocks,
            ).out(0)
        audio_lock_enabled = (
            type(self) is NanFengH3MultiReferenceGeneratorV10
            and bool(kwargs.get("启用锁音频", False))
        )
        if audio_lock_enabled:
            # 对齐桌面【MiniMax】数字人唱歌工作流：同一条音频1既进入Ref2VA参考条件，
            # 又编码进目标AV latent；视频mask=1继续生成，音频mask=0保持不被采样器重绘。
            lock_audio_name = audio_drive_filename if audio_drive_enabled else audio_names[0]
            lock_audio_start = float(kwargs.get("音频驱动当前起点", 0.0)) if audio_drive_enabled else 0.0
            audio_drive_end = float(kwargs.get("音频驱动当前终点", 0.0)) if audio_drive_enabled else float(时长秒)
            if audio_drive_enabled:
                if audio_drive_end <= lock_audio_start:
                    raise ValueError("智能音频驱动当前分镜的音频终点必须大于起点。")
                expected_duration = max(1, math.ceil(audio_drive_end - lock_audio_start))
                if expected_duration != int(float(时长秒)):
                    raise ValueError(f"智能音频驱动分镜整数时长与裁切范围不一致：基本参数{int(float(时长秒))}秒，音频范围向上补齐后{expected_duration}秒。")
            lock_audio_source = g.node("LoadAudio", audio=lock_audio_name)
            lock_audio_trimmed = g.node(
                "TrimAudioDuration", audio=lock_audio_source.out(0),
                start_index=lock_audio_start, duration=float(时长秒),
            )
            if audio_drive_enabled:
                lock_audio_trimmed = g.node(
                    "NanFengAudioPadToDuration", audio=lock_audio_trimmed.out(0), duration=float(时长秒),
                )
            audio_lock = g.node(
                "MiniMaxH3NativeAudioLock", model=sampling_model_input,
                av_latent=sampling_latent_input, audio_vae=audio_vae.out(0),
                audio=lock_audio_trimmed.out(0),
            )
            sampling_model_input = audio_lock.out(0)
            sampling_latent_input = audio_lock.out(1)
            exact_audio_output = audio_lock.out(2)
        sampling_ready = g.node(
            "NanFengH3ReleaseBeforeSampling",
            model=sampling_model_input, conditioning=prepared.out(0), latent=sampling_latent_input,
        )
        sampling_model = sampling_ready.out(0)
        if sol_config is not None:
            # 在最后一次激进清理完成后才创建Sol wrapper；其编译/缓存状态不会再被清除。
            sampling_model = g.node(
                "SolAttnMiniMaxH3Patcher", model=sampling_model, enabled=True, **sol_config,
            ).out(0)
        noise = g.node("RandomNoise", noise_seed=int(随机种子))
        # V8.1的完整轨迹只由H3完整Sigma序列或自动完整轨迹决定；旧V4/V7 Sigma字段即使存在于旧工作流也不得介入。
        sigma_requested = (
            isinstance(self, NanFengH3MultiReferenceGeneratorV4)
            and not isinstance(self, NanFengH3MultiReferenceGeneratorV81)
            and bool(kwargs.get("启用西格玛调节", False))
        )
        hd_second_pass = (
            isinstance(self, NanFengH3MultiReferenceGeneratorV5)
            and not isinstance(self, NanFengH3MultiReferenceGeneratorV7)
            and bool(kwargs.get("启用高清二采", False))
        )
        global_refine = False
        # 旧双区全局重绘实现与序列化字段继续保留，但V7不再执行该实验分支。
        if hd_second_pass and sigma_requested:
            raise ValueError("V5高清二采与西格玛调节不能同时开启；请关闭其中一个。")
        # V1-V6保留原自动分流；V7完全服从用户显式Sigma策略，不读取模式、LoRA或全局修复状态。
        lora_active = bool(_enabled_lora_stack(
            kwargs, individual=isinstance(self, NanFengH3MultiReferenceGeneratorV9)
        ))
        is_v7 = isinstance(self, NanFengH3MultiReferenceGeneratorV7)
        sigma_strategy = str(kwargs.get("Sigma策略", "原生轨迹（不加步）")) if is_v7 else ""
        sigma_enabled = (
            sigma_requested and sigma_strategy != "原生轨迹（不加步）"
            if is_v7 else sigma_requested and not lora_active
        )
        if sigma_enabled:
            # Sigma Shift belongs after every model/attention/cache patch and immediately before
            # both sampling consumers. This keeps BasicGuider and BasicScheduler on one coherent
            # MiniMax H3 video/audio shift model instead of patching only the scheduler branch.
            sampling_model = g.node(
                "MiniMaxH3SigmaShift", model=sampling_model,
                shift_video=float(kwargs.get("视频西格玛偏移", 12.0)),
                shift_audio=float(kwargs.get("音频西格玛偏移", 3.0)),
            ).out(0)
        is_v81 = isinstance(self, NanFengH3MultiReferenceGeneratorV81)
        is_v9 = isinstance(self, NanFengH3MultiReferenceGeneratorV9)
        if is_v9 and bool(kwargs.get("启用实时预览", True)):
            sampling_model = g.node(
                "NanFengH3KJPreviewBridge", model=sampling_model, target_node_id=str(unique_id or ""),
                max_resolution=int(kwargs.get("实时预览最长边", 512)),
                jpeg_quality=int(kwargs.get("实时预览JPEG质量", 75)),
                preview_frames=int(kwargs.get("实时预览帧数", 12)),
                preview_fps=int(kwargs.get("实时预览帧率", 8)),
            ).out(0)
        guider = g.node("BasicGuider", model=sampling_model, conditioning=sampling_ready.out(1))
        sampler = g.node("KSamplerSelect", sampler_name=采样器)
        is_v81 = isinstance(self, NanFengH3MultiReferenceGeneratorV81)
        latent_upscale_enabled = isinstance(self, NanFengH3MultiReferenceGeneratorV8) and bool(kwargs.get("启用H3潜空间放大二采", False))
        v81_first_steps = int(kwargs.get("H3一采步数", 6))
        v81_second_steps = int(kwargs.get("H3二采步数", 4))
        scheduler_steps = (
            v81_first_steps + v81_second_steps
            if is_v81 and latent_upscale_enabled
            else int(kwargs.get("一采步数", 20)) if hd_second_pass else int(采样步数)
        )
        base_sigmas = g.node("BasicScheduler", model=sampling_model, scheduler=调度器, steps=scheduler_steps, denoise=float(降噪强度))
        sigmas = base_sigmas.out(0)
        manual_full_sigma = str(kwargs.get("H3完整Sigma序列", "")).strip() if is_v81 else ""
        single_pass_manual = is_v81 and (not latent_upscale_enabled) and bool(kwargs.get("V81一采使用手动Sigma", False))
        use_manual_full_sigma = bool(manual_full_sigma) and (latent_upscale_enabled or single_pass_manual)
        if use_manual_full_sigma:
            manual_values = _parse_manual_sigmas(manual_full_sigma)
            if latent_upscale_enabled:
                expected = scheduler_steps + 1
                if len(manual_values) != expected:
                    phase = "一采+二采"
                    raise ValueError(
                        f"V8.1完整Sigma序列在{phase}模式下需要{expected}个值"
                        f"（{scheduler_steps}步+结尾0），当前为{len(manual_values)}个。"
                    )
            elif len(manual_values) < 2:
                raise ValueError(
                    "V8.1一采手动Sigma至少需要一个采样区间并以0结尾。"
                )
            sigmas = g.node(
                "ManualSigmas", sigmas=", ".join(f"{value:g}" for value in manual_values),
            ).out(0)
        # V8.1潜空间二采只有一个Sigma来源：H3完整Sigma序列（留空则用上面的自动完整轨迹）。
        # 旧V4/V7 Sigma面板不再覆盖V8.1，避免6+4被9值旧序列切成6+2。
        if is_v81 and latent_upscale_enabled:
            pass
        elif sigma_enabled and is_v7 and sigma_strategy == "最终区间增加1步":
            sigmas = g.node("NanFengH3AddFinalSigmaStep", sigmas=sigmas).out(0)
        elif sigma_enabled and (not is_v7) and fl_mode:
            # V1-V6兼容：FL2VA仅在最后的非零→0区间增加1步。
            sigmas = g.node("NanFengH3AddFinalSigmaStep", sigmas=sigmas).out(0)
        elif sigma_enabled:
            sigma_mode = str(kwargs.get("西格玛模式", "低西格玛加密"))
            if sigma_mode == "手动序列":
                manual = str(kwargs.get("手动西格玛", "")).strip()
                values = _parse_manual_sigmas(manual)
                sigmas = g.node("ManualSigmas", sigmas=", ".join(f"{value:g}" for value in values)).out(0)
            else:
                start_sigma = float(kwargs.get("低西格玛开始", 0.8))
                end_sigma = float(kwargs.get("低西格玛结束", 0.0))
                if end_sigma > start_sigma:
                    raise ValueError("低西格玛结束值不能大于开始值。")
                sigmas = g.node(
                    "ExtendIntermediateSigmas", sigmas=sigmas,
                    steps=int(kwargs.get("每区间细分", 2)),
                    start_at_sigma=start_sigma, end_at_sigma=end_sigma,
                    spacing=str(kwargs.get("加密曲线", "cosine")),
                ).out(0)
        # 关闭Sigma时仍是V3原来的单次原生采样路径。双采开启后，第二段从第一段latent
        # 无新增噪声接续；这是真正的两次SamplerCustomAdvanced，不是重复从头生成。
        # V8.1严格复用参考工作流语义：先生成一条完整Sigma轨迹，再按一采步数切成连续6+4两段。
        # 两段共享切点Sigma；二采从一采denoised latent续采，不重新起一条任意短轨迹。
        v81_sigma_split = None
        if is_v81 and latent_upscale_enabled:
            v81_sigma_split = g.node("SplitSigmas", sigmas=sigmas, step=v81_first_steps)
            sampled = g.node(
                "SamplerCustomAdvanced", noise=noise.out(0), guider=guider.out(0), sampler=sampler.out(0),
                sigmas=v81_sigma_split.out(0), latent_image=sampling_ready.out(2),
            )
        elif type(self) is NanFengH3MultiReferenceGeneratorV4 and sigma_enabled and bool(kwargs.get("启用双采样", False)):
            split = g.node("SplitSigmasDenoise", sigmas=sigmas, denoise=float(kwargs.get("双采后段比例", 0.5)))
            first = g.node(
                "SamplerCustomAdvanced", noise=noise.out(0), guider=guider.out(0), sampler=sampler.out(0),
                sigmas=split.out(0), latent_image=sampling_ready.out(2),
            )
            second_sampler = g.node("KSamplerSelect", sampler_name=str(kwargs.get("双采后段采样器", "res_multistep")))
            no_noise = g.node("DisableNoise")
            sampled = g.node(
                "SamplerCustomAdvanced", noise=no_noise.out(0), guider=guider.out(0), sampler=second_sampler.out(0),
                sigmas=split.out(1), latent_image=first.out(0),
            )
        else:
            # 使用和用户原始工作流完全相同的原生采样节点，排除自定义采样语义/显存差异。
            sampled = g.node("SamplerCustomAdvanced", noise=noise.out(0), guider=guider.out(0), sampler=sampler.out(0), sigmas=sigmas, latent_image=sampling_ready.out(2))
        if hd_second_pass:
            # 真正的高清二采：一采AV latent先解码视频、按目标MP放大、重新编码视频，
            # 再把一采音频latent原样重组回NestedTensor，以独立低强度Sigma轨迹重绘。
            first_released = g.node("NanFengH3ReleaseBeforeDecode", samples=sampled.out(0))
            first_images = g.node("VAEDecode", samples=first_released.out(0), vae=video_vae.out(0))
            upscaled = g.node(
                "NanFengH3UpscaleForSecondPass", image=first_images.out(0),
                megapixels=float(kwargs.get("二采百万像素", 1.0)),
                method=str(kwargs.get("二采放大方法", "lanczos")),
            )
            encoded_video = g.node("VAEEncode", pixels=upscaled.out(0), vae=video_vae.out(0))
            rebuilt = g.node(
                "NanFengH3RebuildAVLatent", video_latent=encoded_video.out(0),
                source_av_latent=first_released.out(0),
            )
            try:
                import folder_paths
                installed_models = folder_paths.get_filename_list("diffusion_models")
            except Exception:
                installed_models = []
            second_model_name = _select_second_pass_model(
                kwargs.get("二采模型", SECOND_MODEL_SAME), installed_models, bool(fl_mode), selected_model,
            )
            # 条件张量直接复用一采结果，所以文本编码器不会重复加载/编码。独立屏障只在
            # 放大重编码完成后才卸载一采和VAE，然后加载用户选择的二采DiT，避免双模型并驻。
            second_ready = g.node(
                "NanFengH3ReleaseBeforeSecondModel", unet_name=second_model_name,
                conditioning=sampling_ready.out(1), latent=rebuilt.out(0),
            )
            second_model = g.node(
                "UNETLoader", unet_name=second_ready.out(0), weight_dtype=模型权重精度,
            ).out(0)
            if sla_enabled:
                second_model = g.node(
                    "H3SLAAttention", model=second_model, enabled=True,
                    sparsity_ratio=float(kwargs.get("SLA稀疏率", 0.90)),
                    block_size=str(kwargs.get("SLA块大小", "64")),
                    min_seq_len=int(kwargs.get("SLA最短序列", 4096)),
                    dense_last_steps=int(kwargs.get("SLA末尾稠密步数", 1)),
                    protect_audio=bool(kwargs.get("SLA保护音频", True)),
                    dense_steps=str(kwargs.get("SLA指定稠密步", "0")),
                    dense_backend=str(kwargs.get("SLA稠密后端", "comfy_kitchen")),
                    disable_fp16_accum=bool(kwargs.get("SLA关闭FP16累加", True)),
                    stabilize_motion=bool(kwargs.get("SLA稳定运动", True)),
                ).out(0)
            elif h3_dedicated_attention:
                second_model = g.node(
                    "MiniMaxH3MemoryEfficientSageAttentionPatch", model=second_model,
                ).out(0)
            elif SageAttention != "disabled" and not (sol_enabled or t8_enabled):
                second_model = g.node(
                    "PathchSageAttentionKJ", model=second_model,
                    sage_attention=SageAttention, allow_compile=bool(允许编译),
                ).out(0)
            if sigma_enabled:
                second_model = g.node(
                    "MiniMaxH3SigmaShift", model=second_model,
                    shift_video=float(kwargs.get("视频西格玛偏移", 12.0)),
                    shift_audio=float(kwargs.get("音频西格玛偏移", 3.0)),
                ).out(0)
            second_guider = g.node("BasicGuider", model=second_model, conditioning=second_ready.out(1))
            second_sampler = g.node(
                "KSamplerSelect", sampler_name=str(kwargs.get("二采采样器", "res_multistep")),
            )
            second_sigmas = g.node(
                "BasicScheduler", model=second_model,
                scheduler=str(kwargs.get("二采调度器", "simple")),
                steps=int(kwargs.get("二采步数", 6)),
                denoise=1.0,
            )
            second_sigmas = g.node(
                "NanFengH3TrimSigmasAtStart", sigmas=second_sigmas.out(0),
                start_sigma=float(kwargs.get("二采起始Sigma", kwargs.get("二采降噪", 0.2))),
            )
            sampled = g.node(
                "SamplerCustomAdvanced", noise=noise.out(0), guider=second_guider.out(0),
                sampler=second_sampler.out(0), sigmas=second_sigmas.out(0),
                latent_image=second_ready.out(2),
            )
        # V8 H3潜空间放大：取一采denoised latent直接神经放大，跳过中间VAE解码/重编码，
        # 同步Conditioning到目标尺寸后，以用户给定的短Sigma轨迹继续高清精修。
        if isinstance(self, NanFengH3MultiReferenceGeneratorV8) and bool(kwargs.get("启用H3潜空间放大二采", False)):
            # V8.1对齐F:/Unsaved Workflow.json：保持同一H3 ModelPatcher，放大后只清
            # upscaler/EasyUse缓存再连续二采；V8旧路径仍采用放大器独占显存策略。
            upscale_input = sampled.out(1)
            if not is_v81:
                upscale_input = g.node("NanFengH3ReleaseBeforeLatentUpscale", latent=upscale_input).out(0)
            latent_upscaled = g.node(
                "NanFengH3LowPeakLatentUpscaler" if is_v81 else "H3LatentUpscalerNodeMegapixels", latent=upscale_input,
                model_name=str(kwargs.get("H3潜空间放大模型") or ""),
                target_megapixels=float(kwargs.get("H3潜空间目标百万像素", 1.0)),
                align=int(kwargs.get("H3潜空间对齐", 2)), device="cuda",
                precision=str(kwargs.get("H3潜空间精度", "fp16")),
                **({"aspect_ratio": 画面比例} if is_v81 else {}),
            )
            if is_v81 and not fl_mode:
                # Ref2VA的参考条件由提示词与原始参考素材编码而成；当前固定ref_image_size=max，
                # 不依赖生成画布尺寸。V8.1直接复用一采条件，避免放大后再次加载25GB文本模型和双VAE。
                second_ready = g.node(
                    "NanFengH3ClearUpscalerCacheResident",
                    latent=latent_upscaled.out(0), conditioning=sampling_ready.out(1),
                )
            elif fl_mode:
                # FL2VA条件包含画布相关关键帧，仍使用上游同步节点。
                synced = g.node(
                    "H3LatentUpscalerNode3DV3", latent=latent_upscaled.out(0),
                    positive=sampling_ready.out(1),
                )
                second_ready = g.node(
                    "NanFengH3ClearUpscalerCacheResident" if is_v81 else "NanFengH3ReleaseLatentUpscalerBeforeSecondPass",
                    latent=synced.out(0), conditioning=synced.out(1),
                )
            else:
                rebuild_inputs = {
                    "clip_name": start.out(1), "video_vae_name": start.out(2), "audio_vae_name": start.out(3),
                    "latent": latent_upscaled.out(0), "prompt": 提示词, "length": length, "reference_size": "max",
                }
                for i, filename in enumerate(image_names, 1):
                    rebuild_inputs[f"image_{i}"] = filename or ""
                for i, filename in enumerate(video_names, 1):
                    rebuild_inputs[f"video_{i}"] = filename or ""
                for i, filename in enumerate(audio_names, 1):
                    rebuild_inputs[f"audio_{i}"] = filename or ""
                second_ready = g.node("NanFengH3RebuildRefConditioningForUpscaledLatent", **rebuild_inputs)
            if is_v81:
                # 保留一采ModelPatcher及其LoRA/注意力补丁描述，中间只卸载GPU权重。
                latent_second_model = sampling_model
            else:
                second_model_loader = g.node(
                    "NanFengH3LoadSecondModelAfterCleanup",
                    unet_name=selected_model, weight_dtype=模型权重精度,
                    dependency=second_ready.out(0),
                )
                latent_second_model = second_model_loader.out(0)
            if not is_v81 and second_lora_mode == "独立4步LoRA":
                requested = _clean_filename(kwargs.get("H3二采LoRA"))
                if not requested or requested == "自动选择4步LoRA":
                    try:
                        import folder_paths
                        requested = _select_face_refine_turbo_lora(folder_paths.get_filename_list("loras"))
                    except Exception as exc:
                        raise ValueError(f"无法选择H3二采4步LoRA：{exc}") from exc
                latent_second_model = g.node(
                    "NanFengH3NativePrefixLoraLoader", model=latent_second_model,
                    lora_name=requested,
                    strength_model=float(kwargs.get("H3二采LoRA强度", 0.6)),
                ).out(0)
            elif not is_v81 and second_lora_mode == "继承一采LoRA":
                for lora_name, strength in _enabled_lora_stack(kwargs, individual=False):
                    latent_second_model = g.node(
                        "LoraLoaderModelOnly", model=latent_second_model,
                        lora_name=lora_name, strength_model=strength,
                    ).out(0)
            if not is_v81 and sla_enabled:
                latent_second_model = g.node(
                    "H3SLAAttention", model=latent_second_model, enabled=True,
                    sparsity_ratio=float(kwargs.get("SLA稀疏率", 0.90)),
                    block_size=str(kwargs.get("SLA块大小", "64")),
                    min_seq_len=int(kwargs.get("SLA最短序列", 4096)),
                    dense_last_steps=int(kwargs.get("SLA末尾稠密步数", 1)),
                    protect_audio=bool(kwargs.get("SLA保护音频", True)),
                    dense_steps=str(kwargs.get("SLA指定稠密步", "0")),
                    dense_backend=str(kwargs.get("SLA稠密后端", "comfy_kitchen")),
                    disable_fp16_accum=bool(kwargs.get("SLA关闭FP16累加", True)),
                    stabilize_motion=bool(kwargs.get("SLA稳定运动", True)),
                ).out(0)
            elif not is_v81 and h3_dedicated_attention:
                latent_second_model = g.node(
                    "MiniMaxH3MemoryEfficientSageAttentionPatch", model=latent_second_model,
                ).out(0)
            elif not is_v81 and SageAttention != "disabled" and not skip_sage_for_specialized:
                latent_second_model = g.node(
                    "PathchSageAttentionKJ", model=latent_second_model,
                    sage_attention=SageAttention, allow_compile=bool(允许编译),
                ).out(0)
            if not is_v81 and sigma_enabled:
                latent_second_model = g.node(
                    "MiniMaxH3SigmaShift", model=latent_second_model,
                    shift_video=float(kwargs.get("视频西格玛偏移", 12.0)),
                    shift_audio=float(kwargs.get("音频西格玛偏移", 3.0)),
                ).out(0)
            second_guider = g.node("BasicGuider", model=latent_second_model, conditioning=second_ready.out(1))
            if is_v81:
                # V8.1后4步必须使用完整10步轨迹切分出的后段，保证与一采在同一Sigma切点连续承接。
                second_sigmas = v81_sigma_split
                second_sigma_output = 1
            else:
                second_sigma_values = _build_h3_four_step_refine_sigmas(
                    kwargs.get("H3二采Sigma", "0.35, 0.22, 0.12, 0.05, 0"),
                )
                second_sigmas = g.node(
                    "ManualSigmas", sigmas=", ".join(f"{value:g}" for value in second_sigma_values),
                )
                second_sigma_output = 0
            sampled = g.node(
                "SamplerCustomAdvanced", noise=noise.out(0), guider=second_guider.out(0),
                sampler=sampler.out(0), sigmas=second_sigmas.out(second_sigma_output), latent_image=second_ready.out(0),
            )
        if is_v81:
            decode_samples = sampled.out(0)
            released = None
        else:
            released = g.node("NanFengH3ReleaseBeforeDecode", samples=sampled.out(0))
            decode_samples = released.out(0)
        video_decoder = "NanFengH3TimedVideoVAEDecode" if is_v81 else "VAEDecode"
        audio_decoder = "NanFengH3TimedAudioVAEDecode" if is_v81 else "VAEDecodeAudio"
        image_decode = g.node(video_decoder, samples=decode_samples, vae=video_vae.out(0))
        audio_decode = None
        if exact_audio_output is None:
            audio_decode = g.node(audio_decoder, samples=decode_samples, vae=audio_vae.out(0))

        final_images = image_decode.out(0)
        if isinstance(self, NanFengH3MultiReferenceGeneratorV9) and bool(kwargs.get("启用RTX视频超分", False)):
            resize_mode = "target dimensions" if str(kwargs.get("RTX缩放方式", "倍数缩放")) == "目标尺寸" else "scale by multiplier"
            rtx_vsr = g.node(
                "NanFengH3RTXVideoSuperResolution", images=final_images,
                resize_mode=resize_mode,
                scale=float(kwargs.get("RTX缩放倍数", 2.0)),
                width=int(kwargs.get("RTX目标宽度", 1920)),
                height=int(kwargs.get("RTX目标高度", 1080)),
                quality=str(kwargs.get("RTX质量", "ULTRA")),
            )
            final_images = rtx_vsr.out(0)
        final_audio = exact_audio_output if exact_audio_output is not None else audio_decode.out(0)
        return {"result": (final_images, final_audio), "expand": g.finalize()}


def _enabled_lora_stack(kwargs, *, individual=False):
    """Return enabled LoRAs in visible slot order; V9/V10 use per-slot switches."""
    limit = 8 if individual else 3
    if not individual and not bool(kwargs.get("启用LoRA", False)):
        return []
    rows = []
    for index in range(1, limit + 1):
        if individual and not bool(kwargs.get(f"LoRA{index}启用", index <= 3)):
            continue
        lora_name = _clean_filename(kwargs.get(f"LoRA{index}"))
        strength = float(kwargs.get(f"LoRA{index}强度", 1.0))
        if lora_name and strength != 0.0:
            rows.append((lora_name, strength))
    return rows


class NanFengH3MultiReferenceGeneratorV2(NanFengH3MultiReferenceGenerator):
    """V2：在V1完整行为之上追加LoRA与Blackwell Sol-Attn控制。"""

    @classmethod
    def INPUT_TYPES(cls):
        schema = super().INPUT_TYPES()
        required = schema["required"]
        try:
            import folder_paths
            loras = folder_paths.get_filename_list("loras")
        except Exception:
            loras = []
        lora_choices = ["未选择"] + list(loras)
        # 只能追加，不能插入旧字段中间：保护ComfyUI按位置保存的旧工作流。
        required["启用LoRA"] = ("BOOLEAN", {"default": False})
        for index in range(1, 4):
            required[f"LoRA{index}"] = (lora_choices, {"default": "未选择"})
            required[f"LoRA{index}强度"] = ("FLOAT", {"default": 1.0, "min": -4.0, "max": 4.0, "step": 0.05})
        required["启用SolAttn"] = ("BOOLEAN", {"default": False})
        required["SolAttn_tau"] = ("FLOAT", {"default": 1.2, "min": 0.1, "max": 5.0, "step": 0.1})
        required["SolAttn阈值类型"] = (["diag", "exact"], {"default": "diag"})
        required["SolAttn精确模式"] = (["off", "exact_kv", "exact_kv_and_rows"], {"default": "exact_kv"})
        required["SolAttn完整末步"] = ("INT", {"default": 1, "min": 0, "max": 100, "step": 1})
        required["SolAttn末段比例"] = ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.05})
        required["SolAttn前缀Token"] = ("INT", {"default": 0, "min": 0, "max": 1000000, "step": 128})
        return schema

    DESCRIPTION = "南风H3 V2：V1完整功能 + 3组模型LoRA + Blackwell Sol-Attn稀疏注意力加速。"


class NanFengH3MultiReferenceGeneratorV3(NanFengH3MultiReferenceGeneratorV2):
    """V3：V2全部功能 + MiniMax H3 Block Cache (T8)，提示词支持STRING连线输入。"""

    @classmethod
    def INPUT_TYPES(cls):
        schema = super().INPUT_TYPES()
        required = schema["required"]
        # 只更新已有提示词字段的展示元数据，不插入或移动任何序列化字段：
        # 保留DOM文本框，同时在节点左侧暴露STRING连接口，可接南风提示词列表等上游输出。
        prompt_type, prompt_options = required["提示词"]
        required["提示词"] = (prompt_type, {**prompt_options, "defaultInput": True})
        required["启用T8缓存"] = ("BOOLEAN", {"default": False})
        required["T8残差阈值"] = ("FLOAT", {"default": 0.12, "min": 0.0, "max": 1.0, "step": 0.01})
        required["T8开始比例"] = ("FLOAT", {"default": 0.08, "min": 0.0, "max": 1.0, "step": 0.01})
        required["T8结束比例"] = ("FLOAT", {"default": 0.95, "min": 0.0, "max": 1.0, "step": 0.01})
        required["T8连续命中"] = ("INT", {"default": 2, "min": 1, "max": 10, "step": 1})
        required["T8缓存设备"] = (["cpu", "gpu"], {"default": "cpu"})
        required["T8指标步幅"] = ("INT", {"default": 8, "min": 1, "max": 32, "step": 1})
        required["T8详细日志"] = ("BOOLEAN", {"default": False})
        # 只能追加到V3既有字段末尾，避免旧工作流widgets_values位置整体错位。
        # 该字段只控制前端种子控件的control_after_generate；后端仍接收同一个随机种子整数。
        required["固定随机种子"] = ("BOOLEAN", {"default": False})
        return schema

    DESCRIPTION = "南风H3 V3：LoRA + Sage/Sol-Attn + MiniMax H3 Block Cache (T8)。"


class NanFengH3MultiReferenceGeneratorV4(NanFengH3MultiReferenceGeneratorV3):
    """V4：V3全部功能 + H3原生Sigma Shift、自定义Sigma及可选双阶段采样。"""

    @classmethod
    def INPUT_TYPES(cls):
        schema = super().INPUT_TYPES()
        required = schema["required"]
        # 不移动既有字段；仅扩充现有画面比例选项。前端只在图生/首尾模式显示原图比例。
        ratio_options, ratio_config = required["画面比例"]
        required["画面比例"] = (["原图比例"] + list(ratio_options), ratio_config)
        # V4字段只能追加在V3完整序列末尾。DOM可把折叠视觉放到T8下方，不能移动序列化位置。
        required["启用西格玛调节"] = ("BOOLEAN", {"default": False})
        required["视频西格玛偏移"] = ("FLOAT", {"default": 12.0, "min": 0.01, "max": 100.0, "step": 0.01})
        required["音频西格玛偏移"] = ("FLOAT", {"default": 3.0, "min": 0.01, "max": 100.0, "step": 0.01})
        required["西格玛模式"] = (["低西格玛加密", "手动序列"], {"default": "低西格玛加密"})
        required["低西格玛开始"] = ("FLOAT", {"default": 0.8, "min": 0.0, "max": 1.0, "step": 0.01})
        required["低西格玛结束"] = ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.01})
        required["每区间细分"] = ("INT", {"default": 2, "min": 1, "max": 8, "step": 1})
        required["加密曲线"] = (["cosine", "linear", "sine"], {"default": "cosine"})
        required["手动西格玛"] = ("STRING", {"default": "1, 0.988235, 0.972973, 0.952381, 0.923077, 0.878049, 0.8, 0.631579, 0", "multiline": True})
        required["启用双采样"] = ("BOOLEAN", {"default": False})
        required["双采后段比例"] = ("FLOAT", {"default": 0.5, "min": 0.05, "max": 0.95, "step": 0.05})
        required["双采后段采样器"] = (["res_multistep", "euler"], {"default": "res_multistep"})
        return schema

    DESCRIPTION = "南风H3 V4：V3完整功能 + 可关闭的Sigma Shift、低Sigma加密、手动Sigma与双阶段采样。"


class NanFengH3MultiReferenceGeneratorV5(NanFengH3MultiReferenceGeneratorV4):
    """V5：以真正的解码→放大→重编码→独立低强度H3二采取代V4 Sigma双阶段采样。"""

    @classmethod
    def INPUT_TYPES(cls):
        schema = super().INPUT_TYPES()
        required = schema["required"]
        # V5继续严格追加，V1-V4的序列化Widget位置完全不动；V4旧双阶段字段仅隐藏/忽略。
        required["启用高清二采"] = ("BOOLEAN", {"default": False})
        required["一采步数"] = ("INT", {"default": 20, "min": 1, "max": 100, "step": 1})
        required["二采百万像素"] = (MEGAPIXELS, {"default": 1.0})
        required["二采放大方法"] = (["lanczos", "bicubic", "bilinear", "nearest-exact"], {"default": "lanczos"})
        required["二采步数"] = ("INT", {"default": 6, "min": 1, "max": 30, "step": 1})
        required["二采降噪"] = ("FLOAT", {"default": 0.2, "min": 0.05, "max": 0.6, "step": 0.01})
        required["二采采样器"] = (["res_multistep", "euler"], {"default": "res_multistep"})
        required["二采调度器"] = (["simple", "beta"], {"default": "simple"})
        try:
            import folder_paths
            installed = [x for x in folder_paths.get_filename_list("diffusion_models") if _is_h3_video_model(x)]
        except Exception:
            installed = []
        required["二采模型"] = ([SECOND_MODEL_SAME, SECOND_MODEL_AUTO] + installed, {"default": SECOND_MODEL_SAME})
        required["二采起始Sigma"] = ("FLOAT", {"default": 0.2, "min": 0.01, "max": 1.0, "step": 0.01})
        return schema

    DESCRIPTION = "南风H3 V5：V4完整功能 + 可选高清放大二采重绘；开启后主控步数失效，改用独立一采/二采步数。"


class NanFengH3MultiReferenceGeneratorV6(NanFengH3MultiReferenceGeneratorV5):
    """V6：V5完整功能 + H3专用注意力。"""

    @classmethod
    def INPUT_TYPES(cls):
        schema = super().INPUT_TYPES()
        schema["required"]["H3专用注意力"] = (
            [H3_DEDICATED_ATTENTION_OFF, H3_DEDICATED_ATTENTION_ON],
            {"default": H3_DEDICATED_ATTENTION_OFF},
        )
        # 这些字段只保留原widgets_values位置，防止旧工作流后续参数整体错位。
        # 前端不渲染，generate不读取，节点包也不再注册任何人脸修复执行节点。
        schema["required"]["启动准备"] = (["关闭（原始输出）"], {"default": "关闭（原始输出）"})
        schema["required"]["单人小脸修复"] = ("BOOLEAN", {"default": False})
        schema["required"]["多人小脸修复"] = ("BOOLEAN", {"default": False})
        identity_slots = [f"图片{i}" for i in range(1, 10)]
        schema["required"]["人物1身份参考"] = (identity_slots, {"default": "图片1"})
        schema["required"]["人物2身份参考"] = (identity_slots, {"default": "图片2"})
        identity_positions = ["自动（最大脸）", "最左人物", "左起第2人", "左起第3人", "最右人物"]
        schema["required"]["人物1图中位置"] = (identity_positions, {"default": "自动（最大脸）"})
        schema["required"]["人物2图中位置"] = (identity_positions, {"default": "自动（最大脸）"})
        schema["required"]["全局修复"] = ("BOOLEAN", {"default": False})
        schema["required"]["全局修复倍率"] = ([1.25, 1.5, 1.75, 2.0], {"default": 1.5})
        return schema

    DESCRIPTION = "南风H3 V6：V5完整功能 + H3专用注意力。"


class NanFengH3MultiReferenceGeneratorV7(NanFengH3MultiReferenceGeneratorV6):
    """V7：统一注意力和显存控制，不含人脸修复链路。"""

    @classmethod
    def INPUT_TYPES(cls):
        schema = super().INPUT_TYPES()
        schema["required"]["H3专用注意力"] = (
            V7_ATTENTION_MODES,
            {"default": H3_DEDICATED_ATTENTION_ON},
        )
        # V7只追加一个显式策略字段，旧字段位置完全不动。模式和LoRA不再自动改Sigma。
        schema["required"]["Sigma策略"] = (
            ["原生轨迹（不加步）", "面板Sigma轨迹", "最终区间增加1步"],
            {"default": "原生轨迹（不加步）"},
        )
        schema["required"]["分块处理（节约显存）"] = (
            ["关闭"],
            {"default": "关闭"},
        )
        schema["required"]["分块卸载层数"] = (
            "INT",
            # 保留字段仅用于兼容已经保存的V7；当前H3实现固定完整50层动态流式加载。
            {"default": 50, "min": 0, "max": 50, "step": 1},
        )
        # V7旧修复字段同样只占据原序列化位置；不显示、不读取、不执行。
        schema["required"]["全局修复LoRA模式"] = (["专用4步LoRA", "继承主生成LoRA", "不使用LoRA"], {"default": "专用4步LoRA"})
        schema["required"]["全局修复LoRA"] = (["自动选择4步LoRA"], {"default": "自动选择4步LoRA"})
        schema["required"]["全局修复LoRA强度"] = ("FLOAT", {"default": 0.75, "min": -2.0, "max": 2.0, "step": 0.05})
        schema["required"]["全局修复步数"] = ("INT", {"default": 4, "min": 1, "max": 20, "step": 1})
        schema["required"]["全局修复降噪"] = ("FLOAT", {"default": 0.28, "min": 0.01, "max": 1.0, "step": 0.01})
        schema["required"]["全局修复Sigma策略"] = (["原生修复轨迹", "最终区间增加1步", "低Sigma加密"], {"default": "最终区间增加1步"})
        schema["required"]["全局修复范围"] = (["全画面双区", "仅第一区（横图左/竖图上）", "仅第二区（横图右/竖图下）"], {"default": "全画面双区"})
        # 新字段必须追加在全部旧V7字段之后，避免旧工作流widgets_values位置错位。
        schema["required"]["低显存注意力分头数"] = (
            "INT", {"default": 10, "min": 1, "max": 56, "step": 1},
        )
        schema["required"]["运行时预留显存GB"] = (
            "FLOAT", {"default": 0.6, "min": 0.0, "max": 24.0, "step": 0.1},
        )
        # 追加主开关，旧V7工作流默认关闭，避免保存过的滑块值在升级后被静默启用。
        schema["required"]["启用运行时预留显存"] = ("BOOLEAN", {"default": False})
        return schema

    DESCRIPTION = "南风H3 V7：统一注意力和显存控制；不含人脸修复链路。"


class NanFengH3MultiReferenceGeneratorV8(NanFengH3MultiReferenceGeneratorV7):
    """V8：V7完整功能 + 可选UniBlockSwap与H3神经潜空间放大二采。"""

    @classmethod
    def INPUT_TYPES(cls):
        schema = super().INPUT_TYPES()
        required = schema["required"]
        # V8字段严格追加在V7完整序列之后，旧工作流位置不变。
        required["启用UniBlockSwap"] = ("BOOLEAN", {"default": False})
        required["UniBlockSwap常驻块数"] = (
            "INT", {"default": 1, "min": 1, "max": 49, "step": 1},
        )
        try:
            import folder_paths
            latent_models = (
                folder_paths.get_filename_list("latent_upscale_models")
                if "latent_upscale_models" in folder_paths.folder_names_and_paths else []
            )
            h3_loras = [x for x in folder_paths.get_filename_list("loras") if "h3" in x.lower()]
        except Exception:
            latent_models = []
            h3_loras = []
        required["启用H3潜空间放大二采"] = ("BOOLEAN", {"default": False})
        required["H3潜空间放大模型"] = cls._live_combo(latent_models)
        required["H3潜空间目标百万像素"] = (
            "FLOAT", {"default": 1.0, "min": 0.1, "max": 8.0, "step": 0.1},
        )
        # 上游Megapixels节点的align作用于latent尺寸且逐边向上取整。
        # 16:9下align=32会把1.0MP膨胀到1536x1024（1.573MP）；2是上游节点允许的最小值。
        required["H3潜空间对齐"] = ([2, 4, 8, 16, 32], {"default": 2})
        required["H3潜空间精度"] = (["fp16", "bf16", "fp32"], {"default": "fp16"})
        required["H3二采Sigma"] = (
            "STRING", {"default": "0.35, 0.22, 0.12, 0.05, 0", "multiline": False},
        )
        # 后续V8新增项继续追加，不能插入上面的既有V8字段，避免已保存工作流错位。
        preferred_4step = next((
            x for x in h3_loras
            if "turbo" in x.lower() and ("4step" in x.lower() or "4_step" in x.lower()) and "comfy" in x.lower()
        ), None)
        required["H3二采LoRA模式"] = (
            ["独立4步LoRA", "继承一采LoRA", "不使用LoRA"], {"default": "独立4步LoRA"},
        )
        required["H3二采LoRA"] = (
            ["自动选择4步LoRA"] + h3_loras,
            {"default": preferred_4step or "自动选择4步LoRA"},
        )
        required["H3二采LoRA强度"] = (
            "FLOAT", {"default": 0.6, "min": -2.0, "max": 2.0, "step": 0.05},
        )
        return schema

    DESCRIPTION = (
        "南风H3 V8：V7完整功能 + 可选UniBlockSwap模型权重换入 + H3 24通道神经潜空间放大二采。"
        "两项默认关闭；潜空间放大跳过中间VAE往返，但高清二采仍会执行。"
    )


class NanFengH3MultiReferenceGeneratorV81(NanFengH3MultiReferenceGeneratorV8):
    """V8.1：保守6+4路径；一采/二采复用同一组LoRA，不提供独立二采LoRA。"""

    @classmethod
    def INPUT_TYPES(cls):
        schema = super().INPUT_TYPES()
        required = schema["required"]
        # V8.1新字段继续追加；V8及其序列化顺序保持不变。
        required["H3一采步数"] = ("INT", {"default": 6, "min": 1, "max": 20, "step": 1})
        required["H3二采步数"] = ("INT", {"default": 4, "min": 1, "max": 12, "step": 1})
        required["H3完整Sigma序列"] = (
            "STRING", {"default": "", "multiline": False, "placeholder": "留空=自动；手动需总步数+1个值并以0结尾"},
        )
        # V8.1固定复用一采LoRA；旧字段位置保留为普通空字符串，避免ComfyUI将其扫描为模型依赖。
        required["H3二采LoRA模式"] = (["继承一采LoRA"], {"default": "继承一采LoRA"})
        required["H3二采LoRA"] = ("STRING", {"default": ""})
        required["参考图最长边"] = ([1280, 1536, 1920], {"default": 1920})
        # 新开关追加在所有既有V8.1字段之后，避免旧工作流widgets_values位置发生偏移。
        required["V81一采使用手动Sigma"] = (
            "BOOLEAN", {"default": False, "label_on": "手动Sigma", "label_off": "上方采样步数"},
        )
        return schema

    DESCRIPTION = (
        "南风H3 V8.1：保守6+4潜空间二采；一采与二采复用同一组LoRA，"
        "官方3D latent upscaler保持整段推理，不使用独立二采LoRA。"
    )


class NanFengH3RTXVideoSuperResolution:
    """V9内部RTX桥接：用普通ComfyUI输入调用V3 DynamicCombo节点，避免子图展开丢失resize_type。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "images": ("IMAGE",),
            "resize_mode": (["scale by multiplier", "target dimensions"], {"default": "scale by multiplier"}),
            "scale": ("FLOAT", {"default": 2.0, "min": 1.0, "max": 4.0, "step": 0.01}),
            "width": ("INT", {"default": 1920, "min": 64, "max": 8192, "step": 8}),
            "height": ("INT", {"default": 1080, "min": 64, "max": 8192, "step": 8}),
            "quality": (["LOW", "MEDIUM", "HIGH", "ULTRA"], {"default": "ULTRA"}),
        }}

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "upscale"
    CATEGORY = "南风节点/内部"

    def upscale(self, images, resize_mode="scale by multiplier", scale=2.0, width=1920, height=1080, quality="ULTRA"):
        import importlib
        try:
            module = importlib.import_module("custom_nodes.Nvidia_RTX_Nodes_ComfyUI")
            rtx_class = module.RTXVideoSuperResolution
        except Exception:
            try:
                module = importlib.import_module("custom_nodes.comfyui_nvidia_rtx_nodes")
                rtx_class = module.RTXVideoSuperResolution
            except Exception as exc:
                raise RuntimeError("无法加载已安装的RTX Video Super Resolution节点") from exc
        resize_type = (
            {"resize_type": "target dimensions", "width": int(width), "height": int(height)}
            if resize_mode == "target dimensions"
            else {"resize_type": "scale by multiplier", "scale": float(scale)}
        )
        output = rtx_class.execute(images=images, resize_type=resize_type, quality=str(quality))
        if hasattr(output, "result"):
            result = output.result
            if result:
                return (result[0],)
        if isinstance(output, (tuple, list)) and output:
            return (output[0],)
        raise RuntimeError("RTX Video Super Resolution没有返回图像")


class NanFengH3KJPreviewBridge:
    """V9内部桥接：复用KJ实时预览wrapper，但把事件定向回南风V9主节点。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "model": ("MODEL",),
            "target_node_id": ("STRING", {"default": ""}),
            "max_resolution": ("INT", {"default": 512, "min": 128, "max": 2048, "step": 8}),
            "jpeg_quality": ("INT", {"default": 75, "min": 30, "max": 100, "step": 1}),
            "preview_frames": ("INT", {"default": 12, "min": 1, "max": 48, "step": 1}),
            "preview_fps": ("INT", {"default": 8, "min": 1, "max": 24, "step": 1}),
        }}

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "apply"
    CATEGORY = "南风节点/内部"

    def apply(self, model, target_node_id, max_resolution=512, jpeg_quality=75, preview_frames=12, preview_fps=8):
        try:
            from custom_nodes.ComfyUI_KJNodes_main.nodes.preview_override_node import _PreviewOverrideWrapper
        except Exception:
            try:
                import nodes
                kj_cls = nodes.NODE_CLASS_MAPPINGS.get("ModelPreviewOverrideKJ")
                module = __import__(kj_cls.__module__, fromlist=["_PreviewOverrideWrapper"]) if kj_cls else None
                _PreviewOverrideWrapper = getattr(module, "_PreviewOverrideWrapper")
            except Exception as exc:
                raise RuntimeError("南风H3 V9实时预览需要已安装且可加载的KJNodes Model Preview Override") from exc
        import comfy.patcher_extension
        patched = model.clone()
        patched.add_wrapper_with_key(
            comfy.patcher_extension.WrappersMP.OUTER_SAMPLE,
            "nanfeng_v9_kj_preview",
            _PreviewOverrideWrapper(
                int(max_resolution), str(target_node_id), int(jpeg_quality), True,
                int(preview_frames), int(preview_fps), None, "none",
            ),
        )
        return (patched,)


## V8.1先不动：V9仅通过子类追加实时预览字段与桥接。
class NanFengH3MultiReferenceGeneratorV9(NanFengH3MultiReferenceGeneratorV81):
    """V9：V8.1完整生成逻辑 + KJ动态采样预览，V8.1保持不变。"""

    @classmethod
    def INPUT_TYPES(cls):
        schema = super().INPUT_TYPES()
        required = schema["required"]
        schema["hidden"] = {"unique_id": "UNIQUE_ID"}
        required["启用实时预览"] = ("BOOLEAN", {"default": True})
        required["实时预览最长边"] = ("INT", {"default": 512, "min": 128, "max": 2048, "step": 8})
        required["实时预览帧数"] = ("INT", {"default": 12, "min": 1, "max": 48, "step": 1})
        required["实时预览帧率"] = ("INT", {"default": 8, "min": 1, "max": 24, "step": 1})
        required["实时预览JPEG质量"] = ("INT", {"default": 75, "min": 30, "max": 100, "step": 1})
        # V9尾部追加RTX VSR字段，避免影响V8.1及旧工作流的位置序列化。
        required["启用RTX视频超分"] = ("BOOLEAN", {"default": False})
        required["RTX缩放方式"] = (["倍数缩放", "目标尺寸"], {"default": "倍数缩放"})
        required["RTX缩放倍数"] = ("FLOAT", {"default": 2.0, "min": 1.0, "max": 4.0, "step": 0.01})
        required["RTX目标宽度"] = ("INT", {"default": 1920, "min": 64, "max": 8192, "step": 8})
        required["RTX目标高度"] = ("INT", {"default": 1080, "min": 64, "max": 8192, "step": 8})
        required["RTX质量"] = (["LOW", "MEDIUM", "HIGH", "ULTRA"], {"default": "ULTRA"})
        # V9 SLA fields remain append-only after every existing V9 widget so saved workflows keep positional compatibility.
        required["启用H3 SLA"] = ("BOOLEAN", {"default": False})
        required["SLA稀疏率"] = ("FLOAT", {"default": 0.90, "min": 0.0, "max": 0.95, "step": 0.05})
        required["SLA块大小"] = (["64", "128"], {"default": "64"})
        required["SLA最短序列"] = ("INT", {"default": 4096, "min": 0, "max": 1000000, "step": 1024})
        required["SLA末尾稠密步数"] = ("INT", {"default": 1, "min": 0, "max": 8, "step": 1})
        required["SLA保护音频"] = ("BOOLEAN", {"default": True})
        required["SLA指定稠密步"] = ("STRING", {"default": "0", "multiline": False})
        required["SLA稠密后端"] = (SLA_DENSE_BACKENDS, {"default": "comfy_kitchen"})
        required["SLA关闭FP16累加"] = ("BOOLEAN", {"default": True})
        required["SLA稳定运动"] = ("BOOLEAN", {"default": True})
        # V9/V10 keep the legacy master widget serialized but no longer execute or show it.
        # Per-slot controls are appended so older workflows retain all positional values.
        lora_choices = required["LoRA1"][0]
        for index in range(1, 4):
            required[f"LoRA{index}启用"] = ("BOOLEAN", {"default": True})
        for index in range(4, 9):
            required[f"LoRA{index}"] = (lora_choices, {"default": "未选择"})
            required[f"LoRA{index}强度"] = ("FLOAT", {"default": 1.0, "min": -4.0, "max": 4.0, "step": 0.05})
            required[f"LoRA{index}启用"] = ("BOOLEAN", {"default": False})
        return schema

    DESCRIPTION = "南风H3 V9：继承V8.1连续Sigma同LoRA二采，并将KJ动态采样预览内嵌到主节点预览区。"


class NanFengH3MultiReferenceGeneratorV10(NanFengH3MultiReferenceGeneratorV9):
    """V10：完整复制V9；智能分镜默认使用独立NS提示词分镜Skill。"""

    @classmethod
    def INPUT_TYPES(cls):
        schema = super().INPUT_TYPES()
        # V10专属字段只追加在V9完整序列末尾，保持所有旧工作流的位置序列化兼容。
        schema["required"]["时长秒"] = ("FLOAT", {"default": 5.0, "min": 1.0, "max": 15.0, "step": 1.0})
        schema["required"]["启用锁音频"] = ("BOOLEAN", {"default": False})
        schema["required"]["开启音频驱动模式"] = ("BOOLEAN", {"default": False})
        schema["required"]["音频驱动文件"] = ("STRING", {"default": ""})
        schema["required"]["音频驱动打点"] = ("STRING", {"default": "[]"})
        schema["required"]["音频驱动分段图片"] = ("STRING", {"default": "{}"})
        schema["required"]["音频驱动分段分镜"] = ("STRING", {"default": "{}"})
        schema["required"]["音频驱动创意"] = ("STRING", {"default": "", "multiline": True})
        schema["required"]["音频驱动排除范围"] = ("STRING", {"default": "{}"})
        schema["required"]["音频驱动当前起点"] = ("FLOAT", {"default": 0.0, "min": 0.0, "max": 86400.0, "step": 0.001})
        schema["required"]["音频驱动当前终点"] = ("FLOAT", {"default": 0.0, "min": 0.0, "max": 86400.0, "step": 0.001})
        # 继续只在V10序列末尾追加：每次执行时作为单行前缀置于当前分镜提示词之前。
        schema["required"]["恒定触发词"] = ("STRING", {"default": "", "multiline": False})
        return schema

    DESCRIPTION = "南风H3 V10：完整继承V9功能，智能分镜支持NS提示词分镜Skill，并可将音频1锁入目标AV latent。"


from .native_audio_lock import MiniMaxH3NativeAudioLock

NODE_CLASS_MAPPINGS = {
    "NanFengH3MultiReferenceGeneratorV10": NanFengH3MultiReferenceGeneratorV10,
    "MiniMaxH3NativeAudioLock": MiniMaxH3NativeAudioLock,
    "NanFengAudioPadToDuration": NanFengAudioPadToDuration,
    "NanFengH3ApplyUniBlockSwap": NanFengH3ApplyUniBlockSwap,
    "NanFengH3NativePrefixLoraLoader": NanFengH3NativePrefixLoraLoader,
    "NanFengH3RTXVideoSuperResolution": NanFengH3RTXVideoSuperResolution,
    "NanFengH3KJPreviewBridge": NanFengH3KJPreviewBridge,
    "NanFengH3BlockOffloadPatch": NanFengH3BlockOffloadPatch,
    "NanFengH3ImageCanvasSize32": NanFengH3ImageCanvasSize32,
    "NanFengH3UpscaleForSecondPass": NanFengH3UpscaleForSecondPass,
    "NanFengH3AddFinalSigmaStep": NanFengH3AddFinalSigmaStep,
    "NanFengH3TrimSigmasAtStart": NanFengH3TrimSigmasAtStart,
    "NanFengH3LimitImageLongEdge": NanFengH3LimitImageLongEdge,
    "NanFengH3ReleaseAtStart": NanFengH3ReleaseAtStart,
    "NanFengH3ReleaseBeforeConditionLoaders": NanFengH3ReleaseBeforeConditionLoaders,
    "NanFengH3ReleaseBeforeSecondModel": NanFengH3ReleaseBeforeSecondModel,
    "NanFengH3ReleaseBeforeConditioning": NanFengH3ReleaseBeforeConditioning,
    "NanFengH3ReleaseBeforeSampling": NanFengH3ReleaseBeforeSampling,
    "NanFengH3ReleaseBeforeDecode": NanFengH3ReleaseBeforeDecode,
    "NanFengH3TimedVideoVAEDecode": NanFengH3TimedVideoVAEDecode,
    "NanFengH3TimedAudioVAEDecode": NanFengH3TimedAudioVAEDecode,
    "NanFengH3ReleaseBeforeLatentUpscale": NanFengH3ReleaseBeforeLatentUpscale,
    "NanFengH3LowPeakLatentUpscaler": NanFengH3LowPeakLatentUpscaler,
    "NanFengH3ReleaseLatentUpscalerBeforeSecondPass": NanFengH3ReleaseLatentUpscalerBeforeSecondPass,
    "NanFengH3ClearUpscalerCacheResident": NanFengH3ClearUpscalerCacheResident,
    "NanFengH3LoadSecondModelAfterCleanup": NanFengH3LoadSecondModelAfterCleanup,
    "NanFengH3RebuildRefConditioningForUpscaledLatent": NanFengH3RebuildRefConditioningForUpscaledLatent,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "NanFengH3MultiReferenceGeneratorV10": "南风H3 V10 多参视频生成",
    "NanFengAudioPadToDuration": "南风H3 音频尾段静音补齐",
    "NanFengH3ApplyUniBlockSwap": "南风H3 V8 UniBlockSwap延迟安装",
    "NanFengH3NativePrefixLoraLoader": "南风H3 原生4步LoRA加载器",
    "NanFengH3BlockOffloadPatch": "南风H3 分块处理（Block Offload）",
    "NanFengH3ImageCanvasSize32": "南风H3 原图比例画布尺寸",
    "NanFengH3AddFinalSigmaStep": "南风H3 FL2VA末段微量Sigma修复",
    "NanFengH3ReleaseAtStart": "南风H3 开始前释放显存",
    "NanFengH3ReleaseBeforeConditionLoaders": "南风H3 V3条件模型加载前释放显存",
    "NanFengH3ReleaseBeforeConditioning": "南风H3 FL2VA条件前释放显存",
    "NanFengH3ReleaseBeforeSampling": "南风H3 条件后采样前释放显存",
    "NanFengH3ReleaseBeforeDecode": "南风H3 VAE前释放显存",
}
