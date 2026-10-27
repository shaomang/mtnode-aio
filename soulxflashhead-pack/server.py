#!/usr/bin/env python
"""SoulX-FlashHead Lite backend service (one model, one GPU, infinite streaming).

The model repo (SoulX-AILab/SoulX-FlashHead) ships generate_video.py + gradio demos, not a
service. MTNode needs a stable local HTTP contract instead, so this file wraps the very same
pipeline functions (flash_head.inference) and the very same streaming loop as
generate_video.py --audio_encode_mode stream:

  * 33 frames per window, 9 motion frames carried over, 24 new frames per chunk
    (vae_stride[0] = 8 -> motion_frames_num = 9), 25 fps, 512x512 by default;
  * each chunk is written straight into an ffmpeg rawvideo pipe, so a long audio track never
    has to sit in RAM as one giant tensor;
  * the produced mp4 is muxed with the ORIGINAL audio track (-shortest).

Endpoints (all JSON, 127.0.0.1 only):
  GET  /health                 fast probe, never loads weights
  POST /generate               {image_path, audio_path, out_path, seed?, steps?, height?, width?,
                                use_face_crop?, fps?} -> {id}
  GET  /job?id=...             job state incl. per-chunk timings + fps / rtf
  POST /cancel                 {id}
  POST /benchmark              {image_path, audio_path, chunks?} -> fps / rtf on real weights
  POST /free                   unload weights, empty CUDA cache
  POST /api/shutdown           stop the service

Run:  python server.py --install-dir <dir> --port 8198
Check: python server.py --install-dir <dir> --check        (loads weights + 2-chunk benchmark)
"""

import argparse
import collections
import json
import os
import subprocess
import sys
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

MODEL_DIRNAME = "SoulX-FlashHead-1_3B"
WAV2VEC_DIRNAME = "wav2vec2-base-960h"
REPO_DIRNAME = "SoulX-FlashHead"
DEFAULT_PORT = 8198
LOAD_TIMEOUT_SEC = 900

STATE_LOCK = threading.Lock()
JOBS = {}
ENGINE = {
    "pipeline": None,
    "infer": None,
    "params": None,
    "loading": False,
    "loaded_at": 0,
    "error": "",
    "compile": True,
    "fallback": "",
    "last_bench": None,
}
JOB_RUN_LOCK = threading.Lock()
STOP = {"flag": False}

ARGS = None


def log(msg):
    line = "[%s] %s" % (time.strftime("%H:%M:%S"), msg)
    try:
        print(line, flush=True)
    except Exception:
        pass


def ffmpeg_exe():
    return os.environ.get("MT_FFMPEG", "ffmpeg")


def run_ffmpeg(args, timeout=None):
    return subprocess.run(
        [ffmpeg_exe()] + args,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


def audio_dur(path):
    try:
        r = run_ffmpeg(["-i", path], timeout=60)
        text = (r.stderr or b"").decode("utf-8", "ignore")
        for line in text.splitlines():
            if "Duration:" in line:
                part = line.split("Duration:")[1].split(",")[0].strip()
                h, m, s = part.split(":")
                return int(h) * 3600 + int(m) * 60 + float(s)
    except Exception:
        pass
    return 0.0


# ─────────────────────────── engine ───────────────────────────


def repo_dir():
    return os.path.join(ARGS.install_dir, REPO_DIRNAME)


def ckpt_dir():
    return os.path.join(repo_dir(), "models", MODEL_DIRNAME)


def wav2vec_dir():
    return os.path.join(repo_dir(), "models", WAV2VEC_DIRNAME)


def _import_torch():
    import torch  # noqa: F401

    return torch


def load_engine():
    """Load the Lite pipeline once. Heavy: first call does cuDNN/inductor warmup."""
    with STATE_LOCK:
        if ENGINE["pipeline"] is not None and not ENGINE["error"]:
            return ENGINE
        if ENGINE["loading"]:
            t0 = time.time()
            while ENGINE["loading"] and time.time() - t0 < LOAD_TIMEOUT_SEC:
                time.sleep(0.5)
            if ENGINE["pipeline"] is None:
                raise RuntimeError(ENGINE["error"] or "model load timed out")
            return ENGINE
        ENGINE["loading"] = True
        ENGINE["error"] = ""

    try:
        t0 = time.time()
        torch = _import_torch()
        repo = repo_dir()
        if not os.path.isdir(repo):
            raise RuntimeError("model repo missing: " + repo)
        if not os.path.isdir(ckpt_dir()):
            raise RuntimeError("weights missing: " + ckpt_dir())
        # inference.py opens flash_head/configs/infer_params.yaml with a relative path
        os.chdir(repo)
        if repo not in sys.path:
            sys.path.insert(0, repo)

        import flash_head.src.pipeline.flash_head_pipeline as fhp
        from flash_head.inference import (
            get_pipeline,
            get_base_data,
            get_infer_params,
            get_audio_embedding,
            run_pipeline,
        )

        want_compile = str(os.environ.get("MT_FLASHHEAD_COMPILE", "1")).strip() != "0"
        compiled = want_compile
        fhp.COMPILE_MODEL = want_compile
        fhp.COMPILE_VAE = want_compile
        try:
            pipeline = get_pipeline(
                world_size=1, ckpt_dir=ckpt_dir(), model_type="lite", wav2vec_dir=wav2vec_dir()
            )
        except Exception as exc:  # torch.compile / inductor is the usual Windows casualty
            if not want_compile:
                raise
            log("compile failed (%s); retrying without torch.compile" % str(exc)[:200])
            fhp.COMPILE_MODEL = False
            fhp.COMPILE_VAE = False
            compiled = False
            pipeline = get_pipeline(
                world_size=1, ckpt_dir=ckpt_dir(), model_type="lite", wav2vec_dir=wav2vec_dir()
            )

        params = get_infer_params()
        ENGINE.update(
            {
                "pipeline": pipeline,
                "infer": {
                    "get_base_data": get_base_data,
                    "get_infer_params": get_infer_params,
                    "get_audio_embedding": get_audio_embedding,
                    "run_pipeline": run_pipeline,
                },
                "params": params,
                "loaded_at": time.time(),
                "compile": compiled,
                "error": "",
            }
        )
        log("pipeline loaded in %.1fs (torch %s, compile=%s)" % (time.time() - t0, torch.__version__, compiled))
        return ENGINE
    except Exception as exc:
        ENGINE["error"] = str(exc)
        log("pipeline load failed: %s" % str(exc)[:400])
        raise
    finally:
        with STATE_LOCK:
            ENGINE["loading"] = False


def unload_engine():
    with STATE_LOCK:
        ENGINE["pipeline"] = None
        ENGINE["infer"] = None
        ENGINE["params"] = None
    try:
        import torch

        torch.cuda.empty_cache()
    except Exception:
        pass
    try:
        import gc

        gc.collect()
    except Exception:
        pass
    return {"ok": True}


def accel_report():
    out = {"torch": "", "cuda": "", "gpu": "", "vram_gb": 0, "flash_attn": "", "sage": "", "compile": None}
    try:
        import torch

        out["torch"] = torch.__version__
        out["cuda"] = torch.version.cuda or ""
        out["cuda_available"] = bool(torch.cuda.is_available())
        if torch.cuda.is_available():
            out["gpu"] = torch.cuda.get_device_name(0)
            out["vram_gb"] = round(torch.cuda.get_device_properties(0).total_memory / 1024 ** 3, 1)
    except Exception as exc:
        out["torch_error"] = str(exc)[:200]
    for mod, key in (("flash_attn", "flash_attn"), ("sageattention", "sage")):
        try:
            m = __import__(mod)
            ver = getattr(m, "__version__", "")
            if not ver:
                # these wheels ship no __version__; the installed distribution does know it
                try:
                    from importlib.metadata import version as _dist_version

                    ver = _dist_version(mod)
                except Exception:
                    ver = "installed"
            out[key] = ver
        except Exception:
            out[key] = ""
    out["compile"] = ENGINE["compile"] if ENGINE["pipeline"] is not None else None
    return out


# ─────────────────────────── generation ───────────────────────────


def _job_new(kind, total_chunks, extra):
    jid = uuid.uuid4().hex[:12]
    job = {
        "id": jid,
        "kind": kind,
        "status": "queued",
        "chunks_done": 0,
        "chunks_total": total_chunks,
        "frames": 0,
        "fps": 0.0,
        "rtf": 0.0,
        "ms_per_chunk": 0.0,
        "chunk_ms": [],
        "chunk_frames": [],
        "elapsed_sec": 0.0,
        "video_sec": 0.0,
        "video_path": "",
        "error": "",
        "cancel": False,
        "started_at": time.time(),
        "log": [],
    }
    job.update(extra or {})
    with STATE_LOCK:
        JOBS[jid] = job
    return job


def _job_update(job, **kw):
    with STATE_LOCK:
        job.update(kw)


def _job_note(job, line):
    with STATE_LOCK:
        job["log"] = (job["log"] + [line])[-40:]


class Session:
    """One image + one audio track driven through the official streaming loop."""

    def __init__(self, image_path, seed=42, steps=4, height=512, width=512, use_face_crop=False):
        eng = load_engine()
        self.pipe = eng["pipeline"]
        self.infer = eng["infer"]
        params = eng["params"]
        self.params = dict(params)
        self.params["height"] = int(height)
        self.params["width"] = int(width)
        self.params["sample_steps"] = int(steps) if steps else 4
        self.audio_ready = False
        self.infer["get_base_data"](self.pipe, image_path, int(seed), bool(use_face_crop))
        # prepare_params fixes frame_num/height/width from infer_params.yaml; override the
        # geometry the same way generate_video.py's yaml does (512x512 is the official default).
        self.frame_num = self.params["frame_num"]
        self.motion_frames_num = self.params["motion_frames_num"]
        self.slice_len = self.frame_num - self.motion_frames_num
        self.sample_rate = self.params["sample_rate"]
        self.fps = self.params["tgt_fps"]
        self.cached = self.params["cached_audio_duration"]
        self.height = self.params["height"]
        self.width = self.params["width"]

    def prepare_audio(self, audio_path):
        import numpy as np
        import librosa

        wav, _ = librosa.load(audio_path, sr=self.sample_rate, mono=True)
        slice_samples = self.slice_len * self.sample_rate // self.fps
        remainder = len(wav) % slice_samples
        if remainder > 0:
            wav = np.concatenate([wav, np.zeros(slice_samples - remainder, dtype=wav.dtype)])
        self.wav = wav
        self.slices = list(wav.reshape(-1, slice_samples))
        self.audio_ready = True
        return len(self.slices)

    def run(self, job=None, on_chunk=None, max_chunks=0):
        import numpy as np
        import torch

        if not self.audio_ready:
            raise RuntimeError("audio not prepared")
        # max_chunks > 0 = stop early (the install / console benchmark only needs a couple of
        # chunks to measure real per-chunk latency; the full audio belongs to /generate).
        slices = self.slices[:max_chunks] if max_chunks and max_chunks > 0 else self.slices
        cached_len = self.sample_rate * self.cached
        audio_dq = collections.deque([0.0] * cached_len, maxlen=cached_len)
        audio_start_idx = self.cached * self.fps - self.frame_num
        audio_end_idx = self.cached * self.fps
        t_start = time.time()
        frames_done = 0
        for idx, chunk in enumerate(slices):
            if job is not None and job["cancel"]:
                raise _Cancelled()
            t0 = time.time()
            audio_dq.extend(chunk.tolist())
            emb = self.infer["get_audio_embedding"](self.pipe, np.array(audio_dq), audio_start_idx, audio_end_idx)
            video = self.infer["run_pipeline"](self.pipe, emb)
            video = video[self.motion_frames_num:]
            # run_pipeline already maps the latent to 0..255 and returns (T,H,W,C) on the GPU
            # (see flash_head/inference.py: sample_frames = ((sample+1)/2)...*255), so only the
            # device move and the uint8 cast are left -- same numbers as upstream generate_video.py.
            frames = video.detach().to(torch.uint8).cpu().numpy()
            if frames.ndim == 4 and frames.shape[1] == 3:
                frames = np.transpose(frames, (0, 2, 3, 1))
            elif frames.ndim == 5 and frames.shape[1] == 3:
                frames = np.transpose(frames.reshape(-1, 3, frames.shape[-2], frames.shape[-1]), (0, 2, 3, 1))
            if on_chunk is not None:
                on_chunk(frames, idx)
            frames_done += int(frames.shape[0])
            dt = time.time() - t0
            elapsed = max(time.time() - t_start, 1e-6)
            if job is not None:
                chunk_ms = list(job.get("chunk_ms") or []) + [round(dt * 1000.0, 1)]
                chunk_frames = list(job.get("chunk_frames") or []) + [int(frames.shape[0])]
                # chunk 1 also pays for the compiled-graph warm-up; the per-chunk numbers the
                # user cares about ("is this real time?") are the steady ones.
                s_ms = chunk_ms[1:] if len(chunk_ms) > 1 else chunk_ms
                s_fr = chunk_frames[1:] if len(chunk_frames) > 1 else chunk_frames
                s_sec = sum(s_ms) / 1000.0
                s_fps = (sum(s_fr) / s_sec) if s_sec > 0 else 0.0
                s_audio = (sum(s_fr) / float(self.fps)) if self.fps else 0.0
                _job_update(
                    job,
                    chunks_done=idx + 1,
                    frames=frames_done,
                    elapsed_sec=round(elapsed, 2),
                    video_sec=round(frames_done / float(self.fps), 2),
                    fps=round(frames_done / elapsed, 2),
                    rtf=round(elapsed / (frames_done / float(self.fps)), 3),
                    ms_per_chunk=round(dt * 1000.0, 1),
                    fps_steady=round(s_fps, 2),
                    rtf_steady=round((s_sec / s_audio) if s_audio > 0 else 0.0, 3),
                    ms_per_chunk_steady=round(sum(s_ms) / len(s_ms), 1) if s_ms else 0.0,
                    chunk_ms=chunk_ms,
                    chunk_frames=chunk_frames,
                )
            log(
                "chunk %d/%d %.0fms fps=%.1f"
                % (idx + 1, len(slices), dt * 1000.0, frames_done / elapsed)
            )
        return frames_done, time.time() - t_start


class _Cancelled(Exception):
    pass


def _write_video(session, job, out_path):
    """Stream chunks into ffmpeg; returns the video-only temp path."""
    tmp = os.path.splitext(out_path)[0] + ".video.mp4"
    size = "%dx%d" % (session.width, session.height)
    cmd = [
        ffmpeg_exe(),
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-s",
        size,
        "-r",
        str(session.fps),
        "-i",
        "-",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        tmp,
    ]
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )

    def on_chunk(frames, idx):
        proc.stdin.write(frames.tobytes())
        proc.stdin.flush()
        _job_note(job, "chunk %d written (%d frames)" % (idx + 1, frames.shape[0]))

    try:
        frames_done, _ = session.run(job=job, on_chunk=on_chunk)
    except BaseException:
        try:
            proc.kill()
        except Exception:
            pass
        raise
    finally:
        try:
            proc.stdin.close()
        except Exception:
            pass
    err = proc.stderr.read()
    code = proc.wait()
    if code != 0:
        raise RuntimeError("ffmpeg encode failed: " + err.decode("utf-8", "ignore")[-400:])
    return tmp, frames_done


def _mux(tmp_video, audio_path, out_path):
    r = run_ffmpeg(
        [
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            tmp_video,
            "-i",
            audio_path,
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-shortest",
            out_path,
        ],
        timeout=1800,
    )
    if r.returncode != 0:
        raise RuntimeError("ffmpeg mux failed: " + (r.stderr or b"").decode("utf-8", "ignore")[-400:])
    try:
        os.remove(tmp_video)
    except Exception:
        pass
    return out_path


def run_generate(job, req):
    out_path = req.get("out_path") or ""
    if not out_path:
        raise RuntimeError("out_path required")
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    sess = Session(
        req["image_path"],
        seed=req.get("seed", 42),
        steps=req.get("steps", 4),
        height=req.get("height", 512),
        width=req.get("width", 512),
        use_face_crop=bool(req.get("use_face_crop")),
    )
    total = sess.prepare_audio(req["audio_path"])
    _job_update(job, chunks_total=total, status="running")
    tmp, frames_done = _write_video(sess, job, out_path)
    _mux(tmp, req["audio_path"], out_path)
    _job_update(
        job,
        status="done",
        video_path=out_path,
        frames=frames_done,
        video_sec=round(frames_done / float(sess.fps), 2),
        audio_sec=round(audio_dur(req["audio_path"]), 2),
    )
    return out_path


def _worker(job, req):
    got = JOB_RUN_LOCK.acquire(blocking=False)
    if not got:
        _job_update(job, status="error", error="another job is already running")
        return
    try:
        run_generate(job, req)
    except _Cancelled:
        _job_update(job, status="cancelled")
    except Exception as exc:
        _job_update(job, status="error", error=str(exc)[:800])
        log("job %s failed: %s" % (job["id"], traceback.format_exc()[-800:]))
    finally:
        JOB_RUN_LOCK.release()


# ─────────────────────────── benchmark ───────────────────────────


def run_benchmark(req):
    """Real-weights speed check: N streaming chunks of the bundled example audio."""
    chunks = int(req.get("chunks") or 3)
    image = req.get("image_path")
    audio = req.get("audio_path")
    if not image or not audio:
        raise RuntimeError("image_path and audio_path required")
    t_load = time.time()
    sess = Session(image, seed=req.get("seed", 42), steps=req.get("steps", 4))
    load_sec = time.time() - t_load
    total = sess.prepare_audio(audio)
    job = _job_new("benchmark", min(chunks, total) if total else chunks, {"status": "running"})
    sess.run(job=job, on_chunk=None, max_chunks=chunks)
    ms = list(job.get("chunk_ms") or [])
    fr = list(job.get("chunk_frames") or [])
    # The FIRST chunk also pays for the graph warm-up (torch.compile traces on the real shapes),
    # so it is not speaker throughput: report the steady chunks as THE number, and keep the
    # first-chunk cost next to it so nobody mistakes a 10s warm-up for a 10s per-chunk runtime.
    steady_ms = ms[1:] if len(ms) > 1 else ms
    steady_fr = fr[1:] if len(fr) > 1 else fr
    fps_target = float(sess.fps)
    steady_sec = sum(steady_ms) / 1000.0
    steady_frames = sum(steady_fr)
    fps = (steady_frames / steady_sec) if steady_sec > 0 else 0.0
    audio_sec = steady_frames / fps_target if fps_target else 0.0
    rtf = (steady_sec / audio_sec) if audio_sec > 0 else 0.0
    per_chunk_ms = (sum(steady_ms) / len(steady_ms)) if steady_ms else 0.0
    result = {
        "ok": True,
        "chunks": job["chunks_done"],
        "frames": job["frames"],
        "fps": round(fps, 2),
        "rtf": round(rtf, 3),
        "ms_per_chunk": round(per_chunk_ms, 1),
        "first_ms": ms[0] if ms else 0.0,
        "realtime": bool(rtf and rtf < 1.0),
        "load_sec": round(load_sec, 1),
        "width": sess.width,
        "height": sess.height,
        "fps_target": sess.fps,
        "compile": bool(ENGINE["compile"]),
        "accel": accel_report(),
    }
    ENGINE["last_bench"] = dict(result, at=time.time())
    return result


# ─────────────────────────── HTTP ───────────────────────────


class Handler(BaseHTTPRequestHandler):
    server_version = "MTNodeFlashHead/1.0"

    def log_message(self, fmt, *args):  # keep the console log clean
        return

    def _send(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        raw = self.rfile.read(n)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/health":
            return self._send(
                200,
                {
                    "ok": True,
                    "engine": "soulx-flashhead-lite",
                    "port": ARGS.port,
                    "install_dir": ARGS.install_dir,
                    "loaded": ENGINE["pipeline"] is not None,
                    "loading": ENGINE["loading"],
                    "load_error": ENGINE["error"],
                    "compile": ENGINE["compile"],
                    "bench": ENGINE["last_bench"],
                    "accel": accel_report() if ENGINE["pipeline"] is not None else None,
                },
            )
        if u.path == "/job":
            jid = (parse_qs(u.query).get("id") or [""])[0]
            with STATE_LOCK:
                job = JOBS.get(jid)
                if not job:
                    return self._send(404, {"ok": False, "error": "unknown job"})
                return self._send(200, {"ok": True, "job": dict(job)})
        if u.path == "/jobs":
            with STATE_LOCK:
                return self._send(200, {"ok": True, "jobs": [dict(j) for j in JOBS.values()]})
        return self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        u = urlparse(self.path)
        req = self._body()
        if u.path == "/generate":
            for k in ("image_path", "audio_path", "out_path"):
                if not req.get(k):
                    return self._send(400, {"ok": False, "error": "missing " + k})
            total = 0
            job = _job_new("generate", total, {"out_path": req.get("out_path"), "audio_path": req.get("audio_path")})
            th = threading.Thread(target=_worker, args=(job, req), daemon=True)
            th.start()
            return self._send(200, {"ok": True, "id": job["id"]})
        if u.path == "/cancel":
            jid = req.get("id") or ""
            with STATE_LOCK:
                job = JOBS.get(jid)
                if job:
                    job["cancel"] = True
            return self._send(200, {"ok": True})
        if u.path == "/benchmark":
            try:
                return self._send(200, run_benchmark(req))
            except Exception as exc:
                return self._send(500, {"ok": False, "error": str(exc)[:800]})
        if u.path == "/free":
            unload_engine()
            return self._send(200, {"ok": True})
        if u.path == "/api/shutdown":
            self._send(200, {"ok": True})
            STOP["flag"] = True
            threading.Thread(target=lambda: (time.sleep(0.3), os._exit(0)), daemon=True).start()
            return
        return self._send(404, {"ok": False, "error": "not found"})


def serve(port):
    srv = ThreadingHTTPServer(("127.0.0.1", int(port)), Handler)
    log("listening on 127.0.0.1:%d (install=%s)" % (int(port), ARGS.install_dir))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


def check_mode():
    """Install-time verification: load weights + run 2 streaming chunks of the example."""
    repo = repo_dir()
    image = os.path.join(repo, "examples", "girl.png")
    audio = os.path.join(repo, "examples", "podcast_sichuan_16k.wav")
    if not os.path.exists(image):
        cand = [f for f in os.listdir(os.path.join(repo, "examples")) if f.lower().endswith((".png", ".jpg", ".jpeg"))]
        if not cand:
            print("CHECK-FAIL=no example image")
            return 1
        image = os.path.join(repo, "examples", sorted(cand)[0])
    if not os.path.exists(audio):
        cand = [f for f in os.listdir(os.path.join(repo, "examples")) if f.lower().endswith((".wav", ".mp3"))]
        if not cand:
            print("CHECK-FAIL=no example audio")
            return 1
        audio = os.path.join(repo, "examples", sorted(cand)[0])
    try:
        # 3 chunks: the first one warms the compiled graph up, the remaining two are the
        # steady-state measurement (what "real time" actually means here).
        res = run_benchmark({"image_path": image, "audio_path": audio, "chunks": 3})
    except Exception as exc:
        print("CHECK-FAIL=" + str(exc)[:400])
        log(traceback.format_exc()[-1500:])
        return 1
    print(
        "BENCH-OK fps=%.2f rtf=%.3f ms_per_chunk=%.1f chunks=%d load=%.1fs compile=%s first_ms=%.0f realtime=%d"
        % (
            res["fps"],
            res["rtf"],
            res["ms_per_chunk"],
            res["chunks"],
            res["load_sec"],
            "1" if res["compile"] else "0",
            res["first_ms"],
            1 if res["realtime"] else 0,
        )
    )
    accel = res["accel"]
    print(
        "ACCEL torch=%s cuda=%s flash_attn=%s sage=%s gpu=%s vram=%sGB"
        % (
            accel.get("torch", ""),
            accel.get("cuda", ""),
            accel.get("flash_attn") or "none",
            accel.get("sage") or "none",
            accel.get("gpu", ""),
            accel.get("vram_gb", ""),
        )
    )
    return 0


def main():
    global ARGS
    ap = argparse.ArgumentParser()
    ap.add_argument("--install-dir", required=True)
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--check", action="store_true")
    ARGS = ap.parse_args()
    ARGS.install_dir = os.path.abspath(ARGS.install_dir)
    if ARGS.check:
        return check_mode()
    serve(ARGS.port)
    return 0


if __name__ == "__main__":
    sys.exit(main())
