"""YuE2 的 Gradio 入口（宿主唯一认的 `python -m app.ui`）。

与 music3-pack/app/ui.py 同一套契约：模块级唯一的引擎实例 + 单函数 `run_generate`，
参数顺序与宿主下发的 8 槽 data 严格一致：

    data = [ 提示词(style), 歌词(lyrics), 时长秒(durationSec), 种子(seed),
             输出目录(outputDir), 输出文件名(filename), 模型路径(modelDir), 显存 offload ]

推理与进度全部复用 `app/engine.py`：模块级 `YuE2Engine` 懒加载并常驻，进度走引擎自己的
`Progress` 总线（与 HTTP 服务的 `/progress` 同一份口径），产物落调用方给的 `outputDir`。

注意：本文件是宿主启动用的入口；`python -m app`（`app/__main__.py`）是标准库 HTTP 服务的
自查入口（`/health /generate /progress /cancel /shutdown`），宿主不会走它。
"""
from __future__ import annotations

import asyncio
import logging
import os
import shutil
import sys
import tempfile
import threading
from pathlib import Path

# Windows Proactor + Gradio 长任务在客户端断开时经常刷 WinError 10054；
# 切 Selector 策略是 Gradio/A1111 在 win32 上的稳定做法。
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

# ---------------------------------------------------------------------------
# 依赖守卫：必须在其它 import 之前，缺 gradio 时给宿主一行机器可读的标记。
# ---------------------------------------------------------------------------
try:
    import gradio as gr
except Exception as _exc:  # noqa: BLE001 - 缺依赖 / 装坏了都要能报出来
    print("MTNODE_MISSING_DEP=gradio", flush=True)
    print(
        "缺少依赖 gradio，YuE2 的 Gradio 入口无法启动。"
        "请在安装目录的 venv 里安装（或重跑 scripts\\install.ps1）：\n"
        '  .\\.venv\\Scripts\\python.exe -m pip install "gradio>=4.44,<6"\n'
        f"原始错误：{_exc}",
        flush=True,
    )
    raise SystemExit(3)

from app import engine as engine_mod  # noqa: E402 - 守卫之后再导入
from app.engine import YuE2Engine  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT_DIR = ROOT / "outputs"
DEFAULT_PORT = 7861

# 模块级唯一引擎：懒加载 + 常驻，进度总线与 HTTP 服务口径一致
_ENGINE = YuE2Engine()
engine_mod.set_logger(lambda msg: print(f"[yue2] {msg}", flush=True))

# 最近一次下发给引擎的模型目录（变了就重载，保证「模型路径」这一槽真的生效）
_model_dir_lock = threading.Lock()
_applied_model_dir = ""


# ---------------------------------------------------------------------------
# 工具
# ---------------------------------------------------------------------------


def _resolve_port() -> int:
    """端口优先级：GRADIO_SERVER_PORT > YUE_PORT > YUE2_PORT > 7861。"""
    for key in ("GRADIO_SERVER_PORT", "YUE_PORT", "YUE2_PORT"):
        raw = (os.environ.get(key) or "").strip()
        if not raw:
            continue
        try:
            n = int(raw)
        except ValueError:
            continue
        if 1 <= n <= 65535:
            return n
    return DEFAULT_PORT


def _gradio_preview_path(src: str | Path) -> str:
    """Gradio Audio(filepath) 只缓存 cwd / temp / allowed_paths 下的文件。

    宿主给的 outputDir 常在安装目录之外，先拷进 temp 再回给前端预览，
    避免保存成功后返回值被 Gradio 拒绝。真实路径仍在 status 文本里。
    """
    src_path = Path(src).expanduser().resolve()
    if not src_path.is_file():
        return str(src_path)
    dest = Path(tempfile.gettempdir()) / f"yue2_preview_{src_path.name}"
    try:
        if dest.resolve() != src_path:
            shutil.copy2(src_path, dest)
        return str(dest)
    except OSError:
        return str(src_path)


def _allowed_paths() -> list[str]:
    paths: list[str] = [str(ROOT), str(DEFAULT_OUTPUT_DIR), tempfile.gettempdir()]
    extra = os.environ.get("YUE2_ALLOWED_PATHS", "")
    for part in extra.replace(";", os.pathsep).split(os.pathsep):
        p = part.strip().strip('"')
        if p:
            paths.append(p)
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


def _clip(s: str, n: int = 160) -> str:
    t = " ".join(str(s or "").split())
    return t if len(t) <= n else t[: n - 1] + "…"


def _attention_hint(exc: BaseException) -> str:
    """生成失败的中文文案：注意力档位问题就补一句档位 + 排查口径（别的失败不打扰）。"""
    text = str(exc)
    if getattr(exc, "code", "") != "attention_backend_unsupported" and not any(
        h in text for h in ("USE_FLASH_ATTENTION", "No available kernel")
    ):
        return ""
    backend = engine_mod.attention_backend()
    return (
        f"\n提示：本机注意力档位 attention={backend}（Windows 版 torch 常带 flash 的 schema "
        f"却没编 CUDA kernel，yue2 的 auto 会误判成 flash）。"
        f"可设 YUE2_ATTENTION_BACKEND=sdpa（或 cudnn）后重启再试；"
        f"各档实测与推荐见 scripts\\probe_attention.py，探针记录在 <INSTALL_DIR>\\.attention-backend。"
    )


def _log_generate_inputs(
    style: str,
    lyrics: str,
    duration_sec: float,
    seed: int,
    output_dir: str,
    filename: str,
) -> None:
    """打印 + 落 sidecar，方便 MTNode 控制台 / 安装目录核对实际入参。"""
    s = str(style or "")
    l = str(lyrics or "")
    line = (
        f"[run_generate] style={len(s)}c lyrics={len(l)}c "
        f"dur={duration_sec} seed={seed} file={filename or '-'}"
    )
    print(line, flush=True)
    print(f"[run_generate] style_head={_clip(s)}", flush=True)
    print(f"[run_generate] lyrics_head={_clip(l)}", flush=True)
    try:
        out = Path(output_dir or DEFAULT_OUTPUT_DIR).expanduser()
        out.mkdir(parents=True, exist_ok=True)
        (out / "_last_generate_inputs.txt").write_text(
            line
            + "\n\n=== style ===\n"
            + s
            + "\n\n=== lyrics ===\n"
            + l
            + "\n",
            encoding="utf-8",
        )
    except OSError as exc:
        print(f"[run_generate] warn: cannot write sidecar: {exc}", flush=True)


def _apply_model_dir(model_dir: str) -> None:
    """宿主下发的模型路径槽：非空且存在时经 YUE2_MODEL_DIR 交给引擎；变了就重载。"""
    global _applied_model_dir
    raw = str(model_dir or "").strip().strip('"')
    with _model_dir_lock:
        if raw and Path(raw).is_dir():
            if raw != _applied_model_dir:
                os.environ["YUE2_MODEL_DIR"] = raw
                _ENGINE.close()
                _applied_model_dir = raw
                print(f"[run_generate] model_dir={raw}（已重载引擎）", flush=True)
            return
        if raw:
            print(
                f"[run_generate] warn: model_dir 不是目录，按自动探测处理：{raw}",
                flush=True,
            )


def _materialize_audio(audio_path: Path, out_dir: Path, filename: str) -> Path:
    """按宿主给的文件名落一份产物（扩展名以真实音频为准，wav 走 soundfile 直写）。"""
    name = str(filename or "").strip()
    if not name:
        return audio_path
    stem = Path(name).stem or "audio"
    want = Path(name).suffix.lower()
    actual = audio_path.suffix.lower()
    if want and want == actual:
        dest = out_dir / (stem + actual)
    elif want == ".wav":
        dest = out_dir / (stem + ".wav")
        try:
            import soundfile as sf

            data, sr = sf.read(str(audio_path), always_2d=True)
            sf.write(str(dest), data, sr, format="WAV")
            return dest
        except Exception as exc:  # noqa: BLE001 - 转不动就退回原音频
            print(f"[run_generate] warn: wav 直写失败，保留原音频：{str(exc)[:160]}", flush=True)
            return audio_path
    else:
        dest = out_dir / (stem + actual)
    try:
        if dest.resolve() != audio_path.resolve():
            shutil.copy2(audio_path, dest)
        return dest
    except OSError as exc:
        print(f"[run_generate] warn: 复制产物失败，保留原音频：{str(exc)[:160]}", flush=True)
        return audio_path


# ---------------------------------------------------------------------------
# 宿主调用的 8 槽函数（顺序 = 宿主的 data 顺序，勿改）
# ---------------------------------------------------------------------------


def run_generate(
    style: str,
    lyrics: str,
    durationSec: float,
    seed: int,
    outputDir: str,
    filename: str,
    modelDir: str,
    offload: bool,
    progress: gr.Progress = gr.Progress(),
) -> tuple[str | None, str]:
    try:
        _log_generate_inputs(style, lyrics, durationSec, seed, outputDir, filename or "")
        _apply_model_dir(modelDir)
        out_dir = Path(str(outputDir or DEFAULT_OUTPUT_DIR)).expanduser()
        print(
            f"[run_generate] offload={bool(offload)}（YuE2 无 offload 开关，仅记录）"
            f" model={_ENGINE.repo_source()} device={_ENGINE.device}",
            flush=True,
        )

        req = {
            "style": style,
            "lyrics": lyrics,
            "seed": int(seed),
            "outputDir": str(out_dir),
        }

        # 引擎在后台线程跑，处理器线程轮询引擎自己的进度总线（/progress 同一份数据）
        box: dict = {}

        def _work() -> None:
            try:
                box["result"] = _ENGINE.generate(req)
            except BaseException as exc:  # noqa: BLE001 - 交给处理器线程还原
                box["error"] = exc

        worker = threading.Thread(target=_work, name="yue2-generate", daemon=True)
        worker.start()
        progress(0.02, desc="准备 YuE2（首次请求会加载权重）…")
        while worker.is_alive():
            snap = _ENGINE.progress.snapshot()
            try:
                progress(
                    min(int(snap.get("percent") or 0), 99) / 100.0,
                    desc=f"{snap.get('stage') or ''} · {snap.get('message') or ''}".strip(" ·"),
                )
            except Exception:  # noqa: BLE001 - 进度只是展示，绝不打断生成
                pass
            worker.join(1.0)

        if "error" in box:
            raise box["error"]
        result = box.get("result") or {}
        saved = _materialize_audio(Path(str(result["audioPath"])), out_dir, filename or "")
        progress(1.0, desc="完成")
        msg = (
            f"Saved: {saved}\n"
            f"Duration: {float(result.get('durationSec') or 0.0):.2f}s\n"
            f"Seed: {result.get('seed')}\n"
            f"Output dir: {result.get('outputDir')}\n"
            f"Model: {_ENGINE.load_path or _ENGINE.repo_source()}\n"
            f"Artifacts: {len(result.get('artifacts') or [])} 个 · score.abc {result.get('scoreAbcLen') or 0}c\n"
            f"Style: {len(str(style or ''))}c · Lyrics: {len(str(lyrics or ''))}c"
        )
        for w in result.get("warnings") or []:
            msg += f"\nwarning: {w}"
        # 预览走 temp 路径，真实路径留在 status 文本里给 API 客户端
        return _gradio_preview_path(saved), msg
    except Exception as exc:  # noqa: BLE001 - 一律回给 UI
        return None, f"Error: {exc}{_attention_hint(exc)}"


def build_ui() -> gr.Blocks:
    with gr.Blocks(title="YuE2 本地音乐生成 (24G)") as demo:
        gr.Markdown(
            "# YuE2 本地音乐生成\n"
            "`style` = 风格提示词；`lyrics` = 带 `[verse]`/`[chorus]` 等标签的歌词。\n"
            "产物（`audio.flac` + `score.abc` + 语义 token / latent / settings）写入下方 **output_dir**。\n"
            "一次只跑一首（`queue(max_size=1)`）：忙时新请求会排队/被拒（429），等本次结束再试。\n"
            "生成中请勿刷新/关闭页面；完成后文件仍会写入 `output_dir`，请看 status / 控制台的 `[run_generate]` 行确认入参。"
        )
        with gr.Row():
            # 默认留空：避免 Gradio API 静默回退到示例值
            style = gr.Textbox(
                label="style (风格提示词)",
                lines=10,
                value="",
                placeholder="Mandarin funk / nu-disco, warm lead vocal, Rhodes piano…",
            )
            lyrics = gr.Textbox(
                label="lyrics (歌词)",
                lines=10,
                value="",
                placeholder="[verse] …\n[chorus] …",
            )
        with gr.Row():
            duration_sec = gr.Slider(10, 150, value=60, step=1, label="durationSec (sec，仅记录)")
            seed = gr.Number(value=7, precision=0, label="seed")
        with gr.Row():
            output_dir = gr.Textbox(label="output_dir", value=str(DEFAULT_OUTPUT_DIR))
            filename = gr.Textbox(label="filename (optional)", placeholder="my_song.wav")
        with gr.Row():
            model_dir = gr.Textbox(
                label="model_dir",
                value=engine_mod.auto_model_dir("YUE2_MODEL_DIR", "m-a-p__YuE2-3B", engine_mod.MODEL_ID),
                info="本地 models/m-a-p__YuE2-3B；留空 = 交给 yue2 按 repo id 解析缓存",
            )
            offload = gr.Checkbox(value=True, label="offload（YuE2 无此开关，仅记录）")
        btn = gr.Button("Generate", variant="primary")
        audio_out = gr.Audio(label="preview", type="filepath")
        log = gr.Textbox(label="status", lines=7)
        btn.click(
            fn=run_generate,
            inputs=[
                style,
                lyrics,
                duration_sec,
                seed,
                output_dir,
                filename,
                model_dir,
                offload,
            ],
            outputs=[audio_out, log],
            concurrency_limit=1,
            api_name="run_generate",
        )
    return demo


def main() -> None:
    _quiet_windows_connection_noise()
    port = _resolve_port()
    # 注意力档位单独打一行：Windows 移植后 flash 常常不可用，排查时先看这一行
    print(f"[yue2] attention={engine_mod.attention_backend()}", flush=True)
    print(
        f"[yue2] gradio 启动中：http://127.0.0.1:{port}"
        f"（install dir: {ROOT}，model: {_ENGINE.repo_source()}，device: {_ENGINE.device}）",
        flush=True,
    )
    demo = build_ui()
    demo.queue(max_size=1, default_concurrency_limit=1).launch(
        server_name="127.0.0.1",
        server_port=port,
        show_error=True,
        quiet=False,
        allowed_paths=_allowed_paths(),
    )


if __name__ == "__main__":
    main()
