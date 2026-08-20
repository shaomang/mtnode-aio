"""Gradio UI for MiniMax Music 3 with explicit output folder."""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import sys
import tempfile
from pathlib import Path

# Windows Proactor + Gradio long jobs often spam WinError 10054 on client disconnect.
# Selector policy is the stable Gradio/A1111 workaround on win32.
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

import gradio as gr

from app.pipeline import DEFAULT_OUTPUT_DIR, Music3Generator, resolve_model_path

ROOT = Path(__file__).resolve().parent.parent
EXAMPLE_PROMPT = (ROOT / "prompts" / "example_lofi.txt").read_text(encoding="utf-8")
EXAMPLE_LYRICS = (ROOT / "prompts" / "example_lyrics.txt").read_text(encoding="utf-8")

_generator: Music3Generator | None = None


def _gradio_preview_path(src: str | Path) -> str:
    """Gradio Audio(filepath) may only cache files under cwd / temp / allowed_paths.

    Canvas nodes often write outside the install dir; copy to temp for preview so
    Gradio does not reject the return value after a successful save.
    """
    src_path = Path(src).expanduser().resolve()
    if not src_path.is_file():
        return str(src_path)
    dest = Path(tempfile.gettempdir()) / f"music3_preview_{src_path.name}"
    try:
        if dest.resolve() != src_path:
            shutil.copy2(src_path, dest)
        return str(dest)
    except OSError:
        return str(src_path)


def _allowed_paths() -> list[str]:
    paths: list[str] = [str(ROOT), str(DEFAULT_OUTPUT_DIR), tempfile.gettempdir()]
    extra = os.environ.get("MUSIC3_ALLOWED_PATHS", "")
    for part in extra.replace(";", os.pathsep).split(os.pathsep):
        p = part.strip().strip('"')
        if p:
            paths.append(p)
    # Dedupe while preserving order
    seen: set[str] = set()
    out: list[str] = []
    for p in paths:
        key = os.path.normcase(os.path.abspath(p))
        if key in seen:
            continue
        seen.add(key)
        out.append(p)
    return out


class _IgnoreWinConnectionReset(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        if "ConnectionResetError" in msg or "10054" in msg:
            return False
        if "_call_connection_lost" in msg:
            return False
        return True


def _quiet_windows_connection_noise() -> None:
    if sys.platform != "win32":
        return
    filt = _IgnoreWinConnectionReset()
    for name in ("asyncio", "uvicorn.error", "uvicorn.access", "gradio"):
        logging.getLogger(name).addFilter(filt)


def get_generator(model_path: str, offload: bool) -> Music3Generator:
    global _generator
    resolved = resolve_model_path(model_path or None)
    if (
        _generator is None
        or _generator.model_path != resolved
        or _generator.offload != offload
    ):
        if _generator is not None:
            _generator.unload()
        _generator = Music3Generator(model_path=resolved, offload=offload)
        _generator.load()
    return _generator


def _clip(s: str, n: int = 160) -> str:
    t = " ".join(str(s or "").split())
    return t if len(t) <= n else t[: n - 1] + "…"


def _log_generate_inputs(
    prompt: str,
    lyrics: str,
    audio_duration: float,
    seed: int,
    output_dir: str,
    filename: str,
) -> None:
    """Print + sidecar file so MTNode console / install dir can verify API inputs."""
    p = str(prompt or "")
    l = str(lyrics or "")
    line = (
        f"[run_generate] prompt={len(p)}c lyrics={len(l)}c "
        f"dur={audio_duration} seed={seed} file={filename or '-'}"
    )
    print(line, flush=True)
    print(f"[run_generate] prompt_head={_clip(p)}", flush=True)
    print(f"[run_generate] lyrics_head={_clip(l)}", flush=True)
    try:
        out = Path(output_dir or DEFAULT_OUTPUT_DIR).expanduser()
        out.mkdir(parents=True, exist_ok=True)
        side = out / "_last_generate_inputs.txt"
        side.write_text(
            line
            + "\n\n=== prompt ===\n"
            + p
            + "\n\n=== lyrics ===\n"
            + l
            + "\n",
            encoding="utf-8",
        )
    except OSError as exc:
        print(f"[run_generate] warn: cannot write sidecar: {exc}", flush=True)


def run_generate(
    prompt: str,
    lyrics: str,
    audio_duration: float,
    seed: int,
    output_dir: str,
    filename: str,
    model_path: str,
    offload: bool,
    progress: gr.Progress = gr.Progress(track_tqdm=True),
) -> tuple[str | None, str]:
    try:
        _log_generate_inputs(
            prompt, lyrics, audio_duration, seed, output_dir, filename or ""
        )
        progress(0, desc="Loading / preparing GPU…")
        gen = get_generator(model_path, offload)
        progress(0.05, desc="Generating (may take several minutes)…")
        result = gen.generate(
            prompt=prompt,
            lyrics=lyrics,
            audio_duration=float(audio_duration),
            seed=int(seed),
            output_dir=output_dir or str(DEFAULT_OUTPUT_DIR),
            filename=(filename or "").strip() or None,
        )
        progress(1.0, desc="Done")
        saved = str(result["path"])
        msg = (
            f"Saved: {saved}\n"
            f"Duration: {result['duration_sec']:.2f}s @ {result['sampling_rate']} Hz\n"
            f"Seed: {result['seed']}\n"
            f"Model: {result['model_path']}\n"
            f"Prompt: {len(str(prompt or ''))}c · Lyrics: {len(str(lyrics or ''))}c"
        )
        # Preview path for Gradio; real path remains in status text for API clients.
        return _gradio_preview_path(saved), msg
    except Exception as exc:  # noqa: BLE001 — surface to UI
        return None, f"Error: {exc}"


def build_ui() -> gr.Blocks:
    with gr.Blocks(title="MiniMax Music 3 (24G)") as demo:
        gr.Markdown(
            "# MiniMax Music 3\n"
            "24G 默认：**BF16 + auto CPU offload**。\n"
            "`prompt` = Structured Caption；`lyrics` = 带 `[Verse]`/`[Chorus]` 等标签的歌词。\n"
            "音频写入下方 **Output folder**（默认仓库 `output/`）。\n"
            "连续生成已串行化：每首歌结束后会把模型卸回 CPU 并清空显存，避免第二首卡死。\n"
            "生成中请勿刷新/关闭页面；完成后文件仍会写入 `output_dir`。\n"
            "画布 API 调用不会回填下方文本框；请看 status / 控制台的 `[run_generate]` 行确认入参。"
        )
        with gr.Row():
            # Empty defaults: avoid Gradio API silently falling back to demo examples.
            prompt = gr.Textbox(
                label="prompt (caption)",
                lines=14,
                value="",
                placeholder="Structured Caption…（网页手动生成时填写；画布 API 会传入）",
            )
            lyrics = gr.Textbox(
                label="lyrics",
                lines=14,
                value="",
                placeholder="[Verse] / [Chorus] … 或 [instrumental]",
            )
        with gr.Row():
            audio_duration = gr.Slider(10, 150, value=60, step=1, label="audio_duration (sec)")
            seed = gr.Number(value=7, precision=0, label="seed")
        with gr.Row():
            output_dir = gr.Textbox(label="output_dir", value=str(DEFAULT_OUTPUT_DIR))
            filename = gr.Textbox(label="filename (optional)", placeholder="my_song.wav")
        with gr.Row():
            model_path = gr.Textbox(
                label="model_path",
                value=resolve_model_path(),
                info="Local models/MiniMax-Music3 or HF id MiniMaxAI/MiniMax-Music3",
            )
            offload = gr.Checkbox(value=True, label="auto CPU offload (recommended on 24G)")
        btn = gr.Button("Generate", variant="primary")
        audio_out = gr.Audio(label="preview", type="filepath")
        log = gr.Textbox(label="status", lines=6)
        gr.Examples(
            examples=[[EXAMPLE_PROMPT, EXAMPLE_LYRICS]],
            inputs=[prompt, lyrics],
            label="Load demo caption + lyrics",
        )
        btn.click(
            fn=run_generate,
            inputs=[prompt, lyrics, audio_duration, seed, output_dir, filename, model_path, offload],
            outputs=[audio_out, log],
            concurrency_limit=1,
            api_name="run_generate",
        )
    return demo


def main() -> None:
    _quiet_windows_connection_noise()
    demo = build_ui()
    demo.queue(max_size=1, default_concurrency_limit=1).launch(
        server_name="127.0.0.1",
        server_port=7860,
        show_error=True,
        quiet=False,
        allowed_paths=_allowed_paths(),
    )


if __name__ == "__main__":
    main()
