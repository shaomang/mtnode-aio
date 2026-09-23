"""V10 scoped model-list refresh without restarting ComfyUI."""


def _register_routes() -> None:
    try:
        from aiohttp import web
        import folder_paths
        from server import PromptServer
        from .h3_generator import _is_h3_video_model
    except Exception:
        return

    prompt_server = getattr(PromptServer, "instance", None)
    if prompt_server is None:
        return

    @prompt_server.routes.post("/nanfeng/v10/h3/refresh-models")
    async def refresh_models(_request):
        # Clear ComfyUI's persistent filename cache, then scan the live folders.
        for folder_name in ("diffusion_models", "text_encoders", "vae", "loras", "latent_upscale_models"):
            folder_paths.filename_list_cache.pop(folder_name, None)
        folder_paths.cache_helper.clear()

        models = [name for name in folder_paths.get_filename_list("diffusion_models") if _is_h3_video_model(name)]
        text_encoders = [name for name in folder_paths.get_filename_list("text_encoders") if "minimax_h3" in name.lower()]
        vaes = folder_paths.get_filename_list("vae")
        loras = folder_paths.get_filename_list("loras")
        upscalers = (
            folder_paths.get_filename_list("latent_upscale_models")
            if "latent_upscale_models" in folder_paths.folder_names_and_paths else []
        )
        return web.json_response({
            "ok": True,
            "模型": models,
            "文本编码器": text_encoders,
            "视频VAE": [name for name in vaes if "minimax_h3_video_vae" in name.lower()],
            "音频VAE": [name for name in vaes if "minimax_h3_audio_vae" in name.lower()],
            "LoRA": loras,
            "H3潜空间放大模型": [name for name in upscalers if "minimax_h3" in name.lower()],
        })


_register_routes()
