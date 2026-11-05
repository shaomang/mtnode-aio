#!/usr/bin/env python
"""MOSS-Music local backend service (one model resident at a time, stdlib HTTP only).

Why this file exists: the official repo ships ``infer.py`` / ``app.py`` (Gradio), not a
service. MTNode needs a stable local JSON contract, long-song slicing, and files on disk,
so this wrapper keeps the official inference path and only adds the service shell around it.

Quant tiers: only ``int8`` / ``int4`` (bitsandbytes). The full-precision ``bf16`` tier was
removed on purpose (it needs 24GB and gave no benefit over int8 in practice); an old caller
still sending ``bf16`` is normalised to ``int8`` and the response carries ``migrated``.

Models: only ``instruct`` ships. The ``thinking`` tier was removed on purpose; an old caller
still sending it is normalised to ``instruct`` and the response carries ``migrated`` too.

Endpoints (all JSON, 127.0.0.1 only):
  GET  /health      fast probe, never loads weights (includes generating / cancelRequested)
  POST /load        {model: "instruct", quant: "int8"|"int4"} -> load
  POST /unload      free the model and empty the CUDA cache
  POST /cancel      ask the in-flight /generate to stop at the next chunk boundary
  POST /generate    {audioPath, question, outputDir?, model?, quant?, maxNewTokens?,
                     temperature?, topP?, topK?, longAudio?, stem?}
                    -> {ok, text, files:{md,json,srt}, cues, chunks, durationSeconds}
                    -> {ok:false, error:"cancelled"} when /cancel landed first

Long audio: longer than ``triggerSec`` (300s) is cut into ``segmentSec`` (180s) windows with
``overlapSec`` (5s) of shared audio; each window is transcribed on its own and the
timestamped lines are shifted back onto the original timeline and de-duplicated inside the
overlap, then md / json / srt are written into ``outputDir``.

Output cap: one decode stops at ``maxNewTokens`` (default 4096, hard ceiling 8192) — the
official default of 1024 is what cut answers mid-sentence before. A segment that hits the cap
is split in half again (with overlap, up to ``SPLIT_MAX_DEPTH``) so a dense lyric passage
still comes back complete; the response carries ``truncated`` / ``autoSplit`` either way.

Run:    python app\\server.py --install-dir <dir> --port 8790
Check:  python app\\server.py --install-dir <dir> --check
"""

import argparse
import gc
import json
import os
import re
import shutil
import sys
import tempfile
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

DEFAULT_PORT = 8790
MODEL_DIRS = {
    "instruct": "MOSS-Music-8B-Instruct",
}
LONG_TRIGGER_SEC = 300
SEGMENT_SEC = 180
OVERLAP_SEC = 5
# 单次解码的输出上限（token）。官方 infer.py 的默认就是 1024，而一句中文歌词带时间戳
# 约 12~20 token，一首 4 分钟歌的光歌词就 2000+，再加曲式 / 调式分析必超 —— 超了模型
# 只说半句就停，节点上看到的就是「输出被截断」。所以默认抬到 4096，并且撞上限时自动
# 把这段音频对半再切（见 transcribe_range），直到不再撞上限或切到 SPLIT_MIN_SEC。
DEFAULT_MAX_NEW_TOKENS = 4096
MAX_NEW_TOKENS_LIMIT = 8192
SPLIT_MIN_SEC = 24
SPLIT_MAX_DEPTH = 3
DEFAULT_QUESTION = "请完整分析这首歌：歌词逐句转写（带时间戳）、曲风与情绪、配器、曲式结构、调式 / 速度 / 和弦进行。"

STATE_LOCK = threading.Lock()
LOAD_LOCK = threading.Lock()
GENERATE_LOCK = threading.Lock()
# 协作式取消：/cancel 置位，generate 在每个分块边界检查；/load 与新的 /generate 会清掉它。
CANCEL = threading.Event()
QUANTS = ("int8", "int4")
STATE = {
    "runner": None,
    "model": "",
    "quant": "",
    "loaded_at": 0,
    "loading": False,
    "generating": False,
    "error": "",
    "last_load_seconds": 0,
}


class CancelledGeneration(Exception):
    """Raised inside generate() when /cancel asked the current job to stop."""


def normalize_quant(quant):
    """Map any incoming tier to int8 / int4; bf16 (removed) falls back to int8."""
    q = (quant or "").strip().lower()
    if q in QUANTS:
        return q, False
    if q == "bf16":
        return "int8", True
    return "", False


def normalize_model(model_key):
    """Only the Instruct model ships now; the removed thinking tier falls back to instruct.

    Unknown values are returned untouched so callers can still answer ``bad_model``.
    """
    m = (model_key or "").strip().lower()
    if not m or m == "instruct":
        return "instruct", False
    if m == "thinking":
        return "instruct", True
    return m, False


def migration_fields(model_migrated, quant_migrated):
    """Response flags for tiers we no longer ship (thinking -> instruct, bf16 -> int8)."""
    froms = []
    if model_migrated:
        froms.append("thinking")
    if quant_migrated:
        froms.append("bf16")
    if not froms:
        return {}
    return {"migrated": True, "migratedFrom": ",".join(froms)}
ARGS = None


# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------

def log(msg):
    line = "[%s] %s" % (time.strftime("%H:%M:%S"), msg)
    try:
        print(line, flush=True)
    except Exception:
        pass


def read_env_file(install_dir):
    """Load <install dir>\\.env (KEY=VALUE, # comments) without overriding real env vars."""
    path = os.path.join(install_dir, ".env")
    if not os.path.isfile(path):
        return
    try:
        with open(path, "r", encoding="utf-8-sig", errors="ignore") as fh:
            for raw in fh:
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, val = line.split("=", 1)
                key = key.strip()
                val = val.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = val
    except Exception as exc:
        log("WARN: cannot read %s: %s" % (path, exc))


def ffmpeg_exe():
    cand = os.environ.get("MOSS_MUSIC_FFMPEG", "")
    if cand and os.path.isfile(cand):
        return cand
    if ARGS is not None:
        local = os.path.join(ARGS.install_dir, "tools", "ffmpeg", "ffmpeg.exe")
        if os.path.isfile(local):
            return local
    return shutil.which("ffmpeg") or "ffmpeg"


def run_ffmpeg(args, timeout=1800):
    import subprocess

    return subprocess.run(
        [ffmpeg_exe()] + args,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


def audio_duration(path):
    try:
        r = run_ffmpeg(["-hide_banner", "-i", path], timeout=120)
        text = (r.stderr or b"").decode("utf-8", "ignore")
        for line in text.splitlines():
            if "Duration:" in line:
                part = line.split("Duration:")[1].split(",")[0].strip()
                h, m, s = part.split(":")
                return int(h) * 3600 + int(m) * 60 + float(s)
    except Exception as exc:
        log("WARN: cannot read the duration of %s: %s" % (path, exc))
    return 0.0


def model_dir_for(model_key):
    name = MODEL_DIRS.get(model_key)
    if not name:
        return ""
    root = os.environ.get("MOSS_MUSIC_MODELS") or os.path.join(ARGS.install_dir, "models")
    return os.path.join(root, name)


def source_dir():
    return os.environ.get("MOSS_MUSIC_SOURCE") or os.path.join(ARGS.install_dir, "source", "MOSS-Music")


def ensure_source_on_path():
    src = source_dir()
    if not os.path.isfile(os.path.join(src, "src", "hf_inference.py")):
        raise RuntimeError("official repo missing: %s (re-run the installer)" % src)
    if src not in sys.path:
        sys.path.insert(0, src)
    return src


_AUDIO_IO_PATCHED = None  # None = not probed yet, True = ffmpeg fallback installed, False = torchcodec works


def decode_audio_with_ffmpeg(path, sample_rate):
    """Decode one audio file into a mono float32 array with the bundled ffmpeg.

    ``torchaudio`` 2.9 forwards ``load_audio`` to ``torchcodec``, and torchcodec needs the
    FFmpeg *shared* libraries (avcodec / avformat / ... DLLs). The portable ffmpeg we ship is
    the static build, so ``libtorchcodec_core*.dll`` fails to load. ffmpeg + soundfile yields
    the same mono / float32 waveform already resampled to ``sample_rate`` without that
    dependency.
    """
    import numpy as np
    import soundfile as sf

    fd, tmp = tempfile.mkstemp(prefix="moss-audio-", suffix=".wav")
    os.close(fd)
    try:
        r = run_ffmpeg(["-hide_banner", "-loglevel", "error", "-y", "-i", path, "-vn",
                        "-ac", "1", "-ar", str(int(sample_rate)), "-c:a", "pcm_s16le", tmp])
        if r.returncode != 0 or not os.path.isfile(tmp):
            raise RuntimeError("ffmpeg decode failed: %s"
                               % (r.stderr or b"").decode("utf-8", "ignore")[-400:])
        data, _sr = sf.read(tmp, dtype="float32", always_2d=True)
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass
    return np.ascontiguousarray(data.mean(axis=1), dtype=np.float32)


def patch_audio_io():
    """Pick the reference-audio loader once, before the official repo binds it.

    ``src/hf_inference.py`` does ``from src.audio_io import load_audio`` at import time, so the
    swap has to land before that import (both runners call this first).
    """
    global _AUDIO_IO_PATCHED
    if _AUDIO_IO_PATCHED is not None:
        return _AUDIO_IO_PATCHED
    ensure_source_on_path()
    try:
        import src.audio_io as audio_io
    except Exception as exc:  # pragma: no cover - only when the repo tree is broken
        log("WARN: cannot import src.audio_io: %s" % exc)
        _AUDIO_IO_PATCHED = False
        return False
    try:
        import torchcodec  # noqa: F401
    except Exception as exc:
        log("WARN: torchcodec unavailable (%s); decoding reference audio with ffmpeg + soundfile"
            % str(exc).splitlines()[0])
        audio_io.load_audio = decode_audio_with_ffmpeg
        mod = sys.modules.get("src.hf_inference")
        if mod is not None:
            mod.load_audio = decode_audio_with_ffmpeg
        _AUDIO_IO_PATCHED = True
        return True
    _AUDIO_IO_PATCHED = False
    return False


def human_ts(seconds):
    seconds = max(0.0, float(seconds))
    ms = int(round(seconds * 1000))
    h, rem = divmod(ms, 3600000)
    m, rem = divmod(rem, 60000)
    s, ms = divmod(rem, 1000)
    return "%02d:%02d:%02d,%03d" % (h, m, s, ms)


def mmss(seconds):
    seconds = max(0.0, float(seconds))
    m, s = divmod(int(seconds), 60)
    return "%02d:%02d" % (m, s)


# ---------------------------------------------------------------------------
# long-audio slicing + timestamp merge
# ---------------------------------------------------------------------------

LINE_TS_HMS = re.compile(r"^\s*[\[\(（]?\s*(\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?\s*[\]\)）]?\s*")
LINE_TS_MS = re.compile(r"^\s*[\[\(（]?\s*(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?\s*[\]\)）]?\s*")


def split_ts_prefix(line):
    """Return (seconds, rest) when the line starts with [mm:ss] / [hh:mm:ss]; else (None, line)."""
    text = line.rstrip()
    m = LINE_TS_HMS.match(text)
    if m:
        h, mi, s, frac = m.groups()
        sec = int(h) * 3600 + int(mi) * 60 + int(s)
        if frac:
            sec += float("0." + frac.ljust(3, "0"))
        rest = text[m.end():].lstrip(" -–—:：|")
        return sec, rest
    m = LINE_TS_MS.match(text)
    if m:
        mi, s, frac = m.groups()
        sec = int(mi) * 60 + int(s)
        if frac:
            sec += float("0." + frac.ljust(3, "0"))
        rest = text[m.end():].lstrip(" -–—:：|")
        return sec, rest
    return None, text


def parse_timestamped_lines(text, base_seconds):
    """Turn one chunk's answer into [{start, text, fromTs}] on the ORIGINAL timeline.

    Lines without a leading timestamp are appended to the previous entry (continuation),
    which is how the model emits multi-line lyrics under one timestamp. ``fromTs`` records
    whether the entry really carried a model timestamp, so the caller can flag estimates.
    """
    entries = []
    current = None
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        sec, rest = split_ts_prefix(line)
        if sec is not None:
            current = {"start": base_seconds + sec, "text": rest.strip(), "fromTs": True}
            entries.append(current)
        elif current is not None:
            current["text"] = (current["text"] + " " + line).strip()
        else:
            current = {"start": base_seconds, "text": line, "fromTs": False}
            entries.append(current)
    return [e for e in entries if e["text"]]


def merge_entries(per_chunk):
    """Merge chunk entries, dropping duplicates that fall inside the 5s overlap window."""
    merged = []
    for entries in per_chunk:
        for e in entries:
            start = float(e["start"])
            text = e["text"]
            dup = False
            for prev in merged[-6:]:
                if abs(prev["start"] - start) <= OVERLAP_SEC + 1 and prev["text"] == text:
                    dup = True
                    break
            if dup:
                continue
            if merged and start < merged[-1]["start"]:
                start = merged[-1]["start"]
            merged.append({"start": start, "text": text, "fromTs": bool(e.get("fromTs"))})
    for i, e in enumerate(merged):
        nxt = merged[i + 1]["start"] if i + 1 < len(merged) else None
        e["end"] = nxt if nxt is not None else e["start"] + max(2.0, len(e["text"]) * 0.18)
        if e["end"] <= e["start"]:
            e["end"] = e["start"] + 1.0
    return merged


def cues_without_timestamps(text, duration):
    """No timestamps in the answer: allocate the known duration by character count.

    The returned flags tell the caller this is an estimate (json carries the flag and the
    console says so) - we never pretend it is word-aligned.
    """
    parts = []
    for line in (text or "").splitlines():
        line = line.strip()
        if not line:
            continue
        for piece in re.split(r"(?<=[。！？!?；;])\s*", line):
            piece = piece.strip()
            if piece:
                parts.append(piece)
    if not parts:
        return []
    total_chars = float(sum(len(p) for p in parts)) or 1.0
    span = max(1.0, float(duration or len(parts) * 3))
    cues = []
    cursor = 0.0
    for p in parts:
        share = span * (len(p) / total_chars)
        cues.append({"start": cursor, "end": cursor + max(0.8, share), "text": p})
        cursor += max(0.8, share)
    return cues


def write_outputs(stem, out_dir, payload, cues, audio_path):
    os.makedirs(out_dir, exist_ok=True)
    md_path = os.path.join(out_dir, stem + ".md")
    json_path = os.path.join(out_dir, stem + ".json")
    srt_path = os.path.join(out_dir, stem + ".srt")

    lines = [
        "# " + stem,
        "",
        "- 音频 / Audio: `%s`" % audio_path,
        "- 模型 / Model: %s（%s）" % (payload.get("modelLabel") or payload.get("model"), payload.get("quant")),
        "- 时长 / Duration: %s" % mmss(payload.get("durationSeconds") or 0),
        "- 生成时间 / Generated: %s" % payload.get("generatedAt"),
        "",
        "## 提问 / Prompt",
        "",
        payload.get("question") or "",
        "",
        "## 结果 / Answer",
        "",
        payload.get("text") or "",
        "",
    ]
    if payload.get("truncated"):
        lines += ["> 注意 / Note: 本次输出达到上限（%s token / 段），自动拆分后仍未收满；"
                  "换更短的提问范围或把长音频分块再跑会更完整。"
                  % payload.get("maxNewTokens"), ""]
    if cues:
        lines += ["## 时间轴 / Timeline", ""]
        for c in cues:
            lines.append("- `%s - %s` %s" % (mmss(c["start"]), mmss(c["end"]), c["text"].replace("\n", " ")))
        lines.append("")
    with open(md_path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(lines))

    srt_lines = []
    for i, c in enumerate(cues, 1):
        srt_lines.append(str(i))
        srt_lines.append("%s --> %s" % (human_ts(c["start"]), human_ts(c["end"])))
        srt_lines.append(c["text"].replace("\n", " "))
        srt_lines.append("")
    with open(srt_path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(srt_lines))

    payload = dict(payload)
    payload["cues"] = cues
    payload["files"] = {"md": md_path, "json": json_path, "srt": srt_path}
    with open(json_path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
    return payload["files"]


# ---------------------------------------------------------------------------
# model runners
# ---------------------------------------------------------------------------

class QuantRunner:
    """BitsAndBytes tier (int8 / int4) — the only tiers left.

    The official wrapper only exposes a plain ``from_pretrained``; the quantized load needs a
    BitsAndBytesConfig, so this class repeats the official generate steps (same processor,
    same time markers, same kwargs) on a quantized model.
    """

    def __init__(self, model_path, quant, device="cuda:0"):
        ensure_source_on_path()
        import torch
        from transformers import BitsAndBytesConfig
        from src.modeling_moss_music import MossMusicModel
        from src.processing_moss_music import MossMusicProcessor

        if not torch.cuda.is_available():
            raise RuntimeError("quantized load needs CUDA; cuda.is_available() is false")
        self.torch = torch
        self.device = device
        self.processor = MossMusicProcessor.from_pretrained(
            model_path, trust_remote_code=True, enable_time_marker=True
        )
        cfg_kwargs = {"load_in_8bit": quant == "int8", "load_in_4bit": quant == "int4"}
        if quant == "int4":
            cfg_kwargs.update(bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_quant_type="nf4")
        cfg = BitsAndBytesConfig(**cfg_kwargs)
        self.model = MossMusicModel.from_pretrained(
            model_path,
            trust_remote_code=True,
            quantization_config=cfg,
            device_map=device,
            torch_dtype=torch.bfloat16,
        )
        self.model.eval()

    def generate(self, question, audio_path=None, max_new_tokens=DEFAULT_MAX_NEW_TOKENS,
                 temperature=1.0, top_p=1.0, top_k=50, do_sample=True):
        patch_audio_io()
        from src.audio_io import load_audio

        torch = self.torch
        max_new_tokens = int(max_new_tokens)
        if audio_path is not None:
            raw = load_audio(audio_path, sample_rate=self.processor.config.mel_sr)
            inputs = self.processor(text=question, audios=[raw], return_tensors="pt")
        else:
            inputs = self.processor(text=question, return_tensors="pt")
        inputs = inputs.to(self.model.device)
        if inputs.get("audio_data") is not None:
            inputs["audio_data"] = inputs["audio_data"].to(self.model.dtype)
        inputs["audio_input_mask"] = inputs["input_ids"] == self.processor.audio_token_id
        kwargs = dict(max_new_tokens=max_new_tokens, num_beams=1, use_cache=True)
        if do_sample:
            kwargs.update(do_sample=True, temperature=float(temperature),
                          top_p=float(top_p), top_k=int(top_k))
        else:
            kwargs["do_sample"] = False
        with torch.no_grad():
            generated = self.model.generate(**inputs, **kwargs)
        input_len = inputs["input_ids"].shape[1]
        new_tokens = int(generated.shape[-1]) - input_len
        text = self.processor.decode(generated[0, input_len:], skip_special_tokens=True)
        return {
            "text": text,
            # 撞上限（没吐出 EOS 就停）时由调用方决定要不要把这段音频再切细
            "newTokens": new_tokens,
            "truncated": new_tokens >= max_new_tokens > 0,
        }

    def close(self):
        self.model = None
        self.processor = None


def unload_locked():
    runner = STATE.get("runner")
    STATE["runner"] = None
    STATE["model"] = ""
    STATE["quant"] = ""
    STATE["loaded_at"] = 0
    if runner is not None:
        try:
            runner.close()
        except Exception:
            pass
    try:
        import torch

        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def load_model(model_key, quant):
    model_key, migrated_model = normalize_model(model_key)
    quant, migrated_quant = normalize_quant(quant or "int8")
    if model_key not in MODEL_DIRS:
        return {"ok": False, "error": "bad_model", "message": "unknown model: %s" % model_key}
    if quant not in QUANTS:
        return {"ok": False, "error": "bad_quant", "message": "unknown quant tier: %s" % quant}
    path = model_dir_for(model_key)
    if not os.path.isfile(os.path.join(path, "config.json")):
        return {"ok": False, "error": "model_missing",
                "message": "weights not installed: %s" % path}

    with LOAD_LOCK:
        CANCEL.clear()
        with STATE_LOCK:
            if STATE["runner"] is not None and STATE["model"] == model_key and STATE["quant"] == quant:
                out = {"ok": True, "cached": True, "model": model_key, "quant": quant}
                out.update(migration_fields(migrated_model, migrated_quant))
                return out
            STATE["loading"] = True
            STATE["error"] = ""
        started = time.time()
        try:
            unload_locked()
            log("loading %s (%s) from %s" % (model_key, quant, path))
            runner = QuantRunner(path, quant)
            elapsed = round(time.time() - started, 1)
            with STATE_LOCK:
                STATE["runner"] = runner
                STATE["model"] = model_key
                STATE["quant"] = quant
                STATE["loaded_at"] = time.time()
                STATE["last_load_seconds"] = elapsed
                STATE["loading"] = False
            log("loaded %s (%s) in %ss" % (model_key, quant, elapsed))
            out = {"ok": True, "model": model_key, "quant": quant, "loadSeconds": elapsed}
            out.update(migration_fields(migrated_model, migrated_quant))
            if migrated_model:
                log("model thinking is gone → using instruct")
            if migrated_quant:
                log("quant bf16 is gone → using int8")
            return out
        except Exception as exc:
            traceback.print_exc()
            with STATE_LOCK:
                STATE["loading"] = False
                STATE["error"] = "%s: %s" % (type(exc).__name__, exc)
            return {"ok": False, "error": "load_failed", "message": str(exc)}


# ---------------------------------------------------------------------------
# generation
# ---------------------------------------------------------------------------

def safe_stem(name):
    stem = os.path.splitext(os.path.basename(name or "moss-music"))[0]
    stem = re.sub(r"[^0-9A-Za-z._\u4e00-\u9fff-]+", "_", stem).strip("._")
    return (stem or "moss-music")[:80]


def cut_audio(src, start, length, out):
    """ffmpeg 把 src 的 [start, start+length) 转成一段 16k 单声道 wav。"""
    r = run_ffmpeg(["-hide_banner", "-loglevel", "error", "-y", "-ss", "%.3f" % start,
                    "-t", "%.3f" % max(0.2, length), "-i", src, "-ac", "1", "-ar", "16000",
                    "-vn", out])
    if r.returncode != 0 or not os.path.isfile(out):
        raise RuntimeError("ffmpeg slicing failed at %.1fs: %s"
                           % (start, (r.stderr or b"").decode("utf-8", "ignore")[-400:]))
    return out


def slice_audio(path, duration, work_dir):
    """Cut >triggerSec audio into segmentSec windows with overlapSec of shared audio."""
    pieces = []
    step = max(1.0, SEGMENT_SEC - OVERLAP_SEC)
    start = 0.0
    idx = 0
    while start < duration - 1.0:
        length = min(SEGMENT_SEC, duration - start)
        out = os.path.join(work_dir, "chunk-%03d.wav" % idx)
        cut_audio(path, start, length, out)
        pieces.append({"path": out, "start": start, "end": start + length})
        idx += 1
        if start + length >= duration - 0.5:
            break
        start += step
    return pieces


def transcribe_range(runner, question, src, start, end, total, work_dir, tag, gen_opts, depth=0):
    """转写原曲 [start, end) 这一段，撞 token 上限就自动对半再切。

    返回 (entries, text, metas)：entries 的时间戳已经落到原曲时间轴上；metas 记录每一段
    实际生成的字符数 / 是否仍然截断。对半切带 OVERLAP_SEC 重叠，接缝处的重复行由
    merge_entries 去掉。
    """
    whole = start <= 0.001 and end >= total - 0.5
    path = src if whole else cut_audio(src, start, end - start,
                                       os.path.join(work_dir, "cut-%s.wav" % tag))
    prompt = question
    if not whole:
        prompt = "%s\n（本段为原曲第 %.0f 秒至 %.0f 秒，请只针对这一段作答，时间戳用本段内的相对时间。）" % (
            question, start, end)
    res = runner.generate(prompt, audio_path=path, **gen_opts)
    text = res.get("text") or ""
    entries = parse_timestamped_lines(text, 0.0 if whole else start)
    meta = {"start": start, "end": end, "chars": len(text),
            "newTokens": res.get("newTokens"), "truncated": bool(res.get("truncated")),
            "split": depth}
    if meta["truncated"] and (end - start) > SPLIT_MIN_SEC and depth < SPLIT_MAX_DEPTH:
        mid = (start + end) / 2.0
        left = transcribe_range(runner, question, src, start, min(end, mid + OVERLAP_SEC),
                                total, work_dir, tag + "a", gen_opts, depth + 1)
        right = transcribe_range(runner, question, src, mid, end,
                                 total, work_dir, tag + "b", gen_opts, depth + 1)
        merged = merge_entries([left[0], right[0]])
        text = "\n".join(e["text"] for e in merged)
        meta["truncated"] = bool(left[2] and left[2][0].get("truncated")) or bool(
            right[2] and right[2][0].get("truncated"))
        return merged, text, [meta] + left[2] + right[2]
    return entries, text, [meta]


def generate(body):
    audio_path = (body.get("audioPath") or body.get("audio_path") or "").strip()
    if not audio_path or not os.path.isfile(audio_path):
        return {"ok": False, "error": "audio_missing", "message": "audio file not found: %s" % audio_path}
    question = (body.get("question") or body.get("prompt") or DEFAULT_QUESTION).strip()
    model_key, migrated_model = normalize_model(body.get("model") or STATE["model"] or "instruct")
    quant, migrated_quant = normalize_quant(body.get("quant") or STATE["quant"] or "int8")
    if not quant:
        return {"ok": False, "error": "bad_quant",
                "message": "unknown quant tier: %s" % (body.get("quant") or STATE["quant"] or "")}
    with STATE_LOCK:
        runner = STATE["runner"]
        loaded_model = STATE["model"]
        loaded_quant = STATE["quant"]
        loading = STATE["loading"]
    if loading:
        return {"ok": False, "error": "loading", "message": "the model is still loading"}
    if runner is None:
        return {"ok": False, "error": "model_not_loaded", "message": "call /load first"}
    if model_key != loaded_model or quant != loaded_quant:
        return {"ok": False, "error": "model_mismatch",
                "message": "loaded %s/%s, requested %s/%s" % (loaded_model, loaded_quant, model_key, quant)}
    if not GENERATE_LOCK.acquire(blocking=False):
        return {"ok": False, "error": "busy", "message": "another generation is running"}

    CANCEL.clear()
    with STATE_LOCK:
        STATE["generating"] = True
    work_dir = tempfile.mkdtemp(prefix="moss-music-")
    try:
        duration = audio_duration(audio_path)
        long_audio = bool(body.get("longAudio", body.get("long_audio", True)))
        use_slices = long_audio and duration > LONG_TRIGGER_SEC
        started = time.time()
        max_new_tokens = int(body.get("maxNewTokens") or body.get("max_new_tokens")
                             or DEFAULT_MAX_NEW_TOKENS)
        max_new_tokens = max(256, min(MAX_NEW_TOKENS_LIMIT, max_new_tokens))
        gen_opts = dict(
            max_new_tokens=max_new_tokens,
            temperature=float(body.get("temperature") or 1.0),
            top_p=float(body.get("topP") or body.get("top_p") or 0.8),
            top_k=int(body.get("topK") or body.get("top_k") or 50),
            do_sample=bool(body.get("doSample", True)),
        )
        per_chunk = []
        chunk_texts = []
        chunks_meta = []
        split_used = False
        if use_slices:
            pieces = slice_audio(audio_path, duration, work_dir)
        else:
            pieces = [{"path": audio_path, "start": 0.0, "end": duration}]
        for i, piece in enumerate(pieces):
            # 取消检查点：每个分块开始前看一次（模型内部的那次 generate 无法打断，
            # 所以 /cancel 的语义是「跑完当前分块就停」，不假装能立刻掐掉内核）。
            if CANCEL.is_set():
                raise CancelledGeneration()
            entries, text, metas = transcribe_range(
                runner, question, audio_path, piece["start"], piece["end"], duration,
                work_dir, "%03d" % i, gen_opts)
            if len(metas) > 1:
                split_used = True
            log("chunk %d/%d @%.1fs -> %.1fs chars=%d newTokens=%s truncated=%s" % (
                i + 1, len(pieces), piece["start"], piece["end"], len(text or ""),
                (metas[0].get("newTokens") if metas else None),
                any(m.get("truncated") for m in metas)))
            per_chunk.append(entries)
            chunk_texts.append(text or "")
            for m in metas:
                m["index"] = len(chunks_meta)
                m["timestamped"] = any(e.get("fromTs") for e in entries)
                chunks_meta.append(m)
        truncated = any(m.get("truncated") for m in chunks_meta)
        if use_slices or split_used:
            merged = merge_entries(per_chunk)
            text = "\n".join(c["text"] for c in merged)
            timestamped = any(c.get("fromTs") for c in merged)
            if timestamped:
                cues = merged
                estimated = False
            else:
                cues = cues_without_timestamps(text, duration)
                estimated = True
        else:
            text = (chunk_texts[0] if chunk_texts else "").strip()
            cues = parse_timestamped_lines(text, 0.0)
            if cues:
                for i, c in enumerate(cues):
                    c["end"] = (cues[i + 1]["start"] if i + 1 < len(cues)
                                else c["start"] + max(2.0, len(c["text"]) * 0.18))
                estimated = False
            else:
                cues = cues_without_timestamps(text, duration)
                estimated = True
        if duration > 0:
            for c in cues:
                c["start"] = min(c["start"], duration)
                c["end"] = min(c["end"], duration) if c["end"] > c["start"] else min(duration, c["start"] + 1.0)

        out_dir = (body.get("outputDir") or body.get("output_dir") or
                   body.get("saveDir") or os.path.join(ARGS.install_dir, "outputs"))
        stem = safe_stem(body.get("stem") or audio_path)
        payload = {
            "engine": "moss-music",
            "model": loaded_model,
            "modelLabel": MODEL_DIRS.get(loaded_model, loaded_model),
            "quant": loaded_quant,
            "audio": audio_path,
            "question": question,
            "text": text,
            "durationSeconds": round(duration, 3),
            "longAudio": use_slices,
            "slicing": {"triggerSec": LONG_TRIGGER_SEC, "segmentSec": SEGMENT_SEC,
                        "overlapSec": OVERLAP_SEC} if use_slices else None,
            "maxNewTokens": max_new_tokens,
            "autoSplit": split_used,
            "truncated": truncated,
            "chunks": chunks_meta,
            "estimatedTimestamps": estimated,
            "elapsedSeconds": round(time.time() - started, 2),
            "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        }
        files = write_outputs(stem, out_dir, payload, cues, audio_path)
        log("done in %.1fs -> %s" % (payload["elapsedSeconds"], files["md"]))
        return {
            "ok": True,
            "text": text,
            "files": files,
            "cues": cues,
            "chunks": chunks_meta,
            "durationSeconds": payload["durationSeconds"],
            "longAudio": use_slices,
            "maxNewTokens": max_new_tokens,
            "autoSplit": split_used,
            "truncated": truncated,
            "estimatedTimestamps": estimated,
            "elapsedSeconds": payload["elapsedSeconds"],
            "model": loaded_model,
            "quant": loaded_quant,
            **migration_fields(migrated_model, migrated_quant),
        }
    except CancelledGeneration:
        log("generate cancelled by /cancel")
        return {"ok": False, "error": "cancelled", "cancelled": True, "message": "已取消"}
    except Exception as exc:
        traceback.print_exc()
        return {"ok": False, "error": "generate_failed", "message": "%s: %s" % (type(exc).__name__, exc)}
    finally:
        with STATE_LOCK:
            STATE["generating"] = False
        GENERATE_LOCK.release()
        shutil.rmtree(work_dir, ignore_errors=True)


# ---------------------------------------------------------------------------
# HTTP shell
# ---------------------------------------------------------------------------

def health():
    with STATE_LOCK:
        loaded = STATE["runner"] is not None
        body = {
            "ok": True,
            "engine": "moss-music",
            "ready": loaded,
            "loading": STATE["loading"],
            "generating": STATE["generating"],
            "cancelRequested": CANCEL.is_set(),
            "quantTiers": list(QUANTS),
            "model": STATE["model"],
            "quant": STATE["quant"],
            "loadedAt": int(STATE["loaded_at"] or 0),
            "loadSeconds": STATE["last_load_seconds"],
            "error": STATE["error"],
            "models": {k: os.path.isfile(os.path.join(model_dir_for(k), "config.json"))
                       for k in MODEL_DIRS},
            "slicing": {"triggerSec": LONG_TRIGGER_SEC, "segmentSec": SEGMENT_SEC,
                        "overlapSec": OVERLAP_SEC},
            "pid": os.getpid(),
        }
    return body


class Handler(BaseHTTPRequestHandler):
    server_version = "MossMusic/1.0"

    def log_message(self, fmt, *args):
        log("%s %s" % (self.address_string(), fmt % args))

    def _send(self, code, payload):
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        try:
            self.wfile.write(raw)
        except Exception:
            pass

    def _body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except Exception:
            length = 0
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path in ("/health", "/"):
            self._send(200, health())
        elif path == "/models":
            self._send(200, {"ok": True, "models": {k: model_dir_for(k) for k in MODEL_DIRS}})
        else:
            self._send(404, {"ok": False, "error": "not_found"})

    def do_POST(self):
        path = urlparse(self.path).path
        body = self._body()
        if path == "/load":
            result = load_model(body.get("model"), body.get("quant"))
            self._send(200 if result.get("ok") else 500, result)
        elif path == "/cancel":
            # 协作取消：只置位，真正的退出点在 generate() 的分块边界。
            with STATE_LOCK:
                generating = STATE["generating"]
            CANCEL.set()
            log("cancel requested (generating=%s)" % generating)
            self._send(200, {"ok": True, "cancelled": True, "generating": generating})
        elif path == "/unload":
            # 推理在跑时把权重抽走会让内核在已释放的显存上继续跑：先请求取消，
            # 等它退到分块边界（最多 2.5s）；还不退就明确报 busy，由调用方决定杀进程。
            CANCEL.set()
            deadline = time.time() + 2.5
            while time.time() < deadline:
                with STATE_LOCK:
                    if not STATE["generating"]:
                        break
                time.sleep(0.1)
            with STATE_LOCK:
                still = STATE["generating"]
            if still:
                self._send(409, {"ok": False, "error": "busy_generating",
                                 "message": "generation still running; cancel or kill it first"})
            else:
                with LOAD_LOCK:
                    unload_locked()
                self._send(200, {"ok": True})
        elif path == "/generate":
            result = generate(body)
            self._send(200 if result.get("ok") else 500, result)
        else:
            self._send(404, {"ok": False, "error": "not_found"})


def run_check():
    ok = True
    src = source_dir()
    print("install dir : %s" % ARGS.install_dir)
    print("source      : %s (%s)" % (src, "ok" if os.path.isfile(
        os.path.join(src, "src", "hf_inference.py")) else "MISSING"))
    ok = ok and os.path.isfile(os.path.join(src, "src", "hf_inference.py"))
    for key in MODEL_DIRS:
        path = model_dir_for(key)
        present = os.path.isfile(os.path.join(path, "config.json"))
        print("model %-9s: %s (%s)" % (key, path, "ok" if present else "MISSING"))
        ok = ok and present
    try:
        import torch

        print("torch       : %s cuda=%s" % (torch.__version__, torch.cuda.is_available()))
    except Exception as exc:
        print("torch       : FAILED %s" % exc)
        ok = False
    print("ffmpeg      : %s" % ffmpeg_exe())
    return 0 if ok else 1


def main():
    global ARGS
    parser = argparse.ArgumentParser(description="MOSS-Music local HTTP service")
    parser.add_argument("--install-dir", default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--check", action="store_true", help="verify source / weights / torch, do not serve")
    parser.add_argument("--preload", default="", help="load this model id right after startup")
    parser.add_argument("--quant", default="", help="quant tier used with --preload")
    ARGS = parser.parse_args()
    ARGS.install_dir = os.path.abspath(ARGS.install_dir)
    read_env_file(ARGS.install_dir)

    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    if not ARGS.port:
        try:
            ARGS.port = int(os.environ.get("MOSS_MUSIC_PORT") or DEFAULT_PORT)
        except Exception:
            ARGS.port = DEFAULT_PORT

    if ARGS.check:
        sys.exit(run_check())

    if ARGS.preload:
        load_model(ARGS.preload, ARGS.quant or os.environ.get("MOSS_MUSIC_QUANT") or "int8")

    httpd = ThreadingHTTPServer((ARGS.host, ARGS.port), Handler)
    log("MOSS-Music backend listening on http://%s:%d (install dir %s)"
        % (ARGS.host, ARGS.port, ARGS.install_dir))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        with LOAD_LOCK:
            unload_locked()
        httpd.server_close()


if __name__ == "__main__":
    main()
