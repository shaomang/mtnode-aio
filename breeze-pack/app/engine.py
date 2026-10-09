"""Breeze 推理引擎进程的编排：拉起官方 breeze_infer.api、探活、停掉。

引擎 = 官方 `python -m breeze_infer.api <权重目录> --host 127.0.0.1 --port 8773`，
首次启动要把权重载进显存（eager 约 7.7GB），所以 /health 会先回 503 loading。
本模块只负责进程；合成走 HTTP 代理（见 server.py）。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from . import config

_lock = threading.Lock()
_proc: subprocess.Popen | None = None
_log_tail: list[str] = []
_LOG_CAP = 4000
_state: dict = {"startedAt": 0, "port": config.DEFAULT_ENGINE_PORT, "reused": False}


class EngineError(Exception):
    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code = code
        self.message = message or code


def _remember(line: str) -> None:
    _log_tail.append(line)
    if len(_log_tail) > _LOG_CAP:
        del _log_tail[: len(_log_tail) - _LOG_CAP]


def log_tail(n: int = 400) -> list[str]:
    return _log_tail[-max(1, int(n)) :]


def _pump(stream, tag: str) -> None:
    try:
        for raw in iter(stream.readline, b""):
            line = raw.decode("utf-8", "replace").rstrip()
            if not line:
                continue
            _remember(line)
            config.log(f"[engine:{tag}] {line}")
    except Exception:
        pass
    finally:
        try:
            stream.close()
        except Exception:
            pass


def engine_port() -> int:
    cfg = config.load_config()
    try:
        p = int(cfg.get("enginePort") or config.DEFAULT_ENGINE_PORT)
    except Exception:
        p = config.DEFAULT_ENGINE_PORT
    return p if 1024 <= p <= 65535 else config.DEFAULT_ENGINE_PORT


def health(port: int | None = None, timeout: float = 2.0) -> dict | None:
    """引擎 /health：{"status":"ok","sample_rate":24000} / 503 {"status":"loading"}。"""
    p = int(port or engine_port())
    url = f"http://127.0.0.1:{p}/health"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as res:
            body = res.read().decode("utf-8", "replace")
            try:
                j = json.loads(body)
            except Exception:
                j = {"status": "unknown"}
            j["_code"] = res.status
            return j
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode("utf-8", "replace")
            j = json.loads(body)
        except Exception:
            j = {"status": "error"}
        j["_code"] = e.code
        return j
    except Exception:
        return None


def alive() -> bool:
    if _proc is not None and _proc.poll() is None:
        return True
    return False


def pid() -> int:
    if _proc is not None and _proc.poll() is None:
        return int(_proc.pid)
    meta = load_pid_meta()
    if meta:
        n = int(meta.get("pid") or 0)
        if n and _pid_alive(n):
            return n
    return 0


def _pid_alive(n: int) -> bool:
    if not n or n <= 0:
        return False
    if os.name == "nt":
        try:
            out = subprocess.run(
                ["tasklist", "/FI", f"PID eq {n}", "/NH"],
                capture_output=True,
                text=True,
                timeout=8,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            ).stdout
            return str(n) in out
        except Exception:
            return False
    try:
        os.kill(n, 0)
        return True
    except Exception:
        return False


def save_pid_meta(d: dict) -> None:
    try:
        config.PID_PATH.write_text(json.dumps(d, ensure_ascii=False, indent=2), "utf-8")
    except Exception:
        pass


def load_pid_meta() -> dict:
    try:
        return json.loads(config.PID_PATH.read_text("utf-8"))
    except Exception:
        return {}


def clear_pid_meta() -> None:
    try:
        config.PID_PATH.unlink()
    except Exception:
        pass


def kill_pid_tree(n: int) -> None:
    if not n:
        return
    try:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(n), "/T", "/F"],
                capture_output=True,
                timeout=20,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        else:
            os.kill(n, 15)
    except Exception:
        pass


def find_listening_pid(port: int) -> int:
    """端口占用者（Windows 用 netstat，其它平台用 lsof），供停止后端时清孤儿。"""
    try:
        if os.name == "nt":
            out = subprocess.run(
                ["netstat", "-ano", "-p", "TCP"],
                capture_output=True,
                text=True,
                timeout=15,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            ).stdout
            needle = f":{int(port)}"
            for line in out.splitlines():
                parts = line.split()
                if len(parts) >= 5 and parts[0].upper() == "TCP" and parts[1].endswith(needle) and parts[3].upper() == "LISTENING":
                    try:
                        return int(parts[4])
                    except Exception:
                        continue
            return 0
        out = subprocess.run(["lsof", "-t", f"-i:{int(port)}"], capture_output=True, text=True, timeout=15).stdout
        return int(out.strip().splitlines()[0]) if out.strip() else 0
    except Exception:
        return 0


def preflight() -> None:
    """起引擎前的环境体检：缺什么就报带 code 的错误，让宿主给出中文指路。"""
    if not config.python_version_ok():
        raise EngineError("bad_python", f"需要 Python 3.10+，当前 {sys.version.split()[0]}")
    if not config.engine_ready():
        raise EngineError("not_installed", f"推理引擎源码缺失：{config.ENGINE_DIR / 'infer.py'}")
    if not config.weights_ready():
        wd = config.weights_dir()
        raise EngineError("no_weights", f"未找到 Breeze TTS 2 权重：{wd}")
    try:
        import torch  # noqa: F401
    except Exception as exc:  # noqa: BLE001
        raise EngineError("torch_missing", f"虚拟环境缺少 torch：{exc}") from exc
    try:
        import torch

        if not torch.cuda.is_available():
            raise EngineError("cuda_unavailable", "torch 看不到 CUDA（Breeze TTS 2 需要 NVIDIA GPU，eager 约 7.7GB 显存）")
    except EngineError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise EngineError("cuda_unavailable", f"CUDA 检测失败：{exc}") from exc


def start(*, fast_all: bool | None = None, wait_s: float = 900.0) -> dict:
    """拉起引擎并等 /health 就绪；已在跑（含上次遗留）则复用。"""
    with _lock:
        port = engine_port()
        h = health(port, timeout=1.5)
        if h and h.get("_code") == 200:
            _state.update({"reused": True, "port": port, "startedAt": _state.get("startedAt") or int(time.time() * 1000)})
            config.log(f"[engine] 复用已在运行的引擎 :{port} pid={find_listening_pid(port)}")
            return {"ok": True, "reused": True, "port": port, "pid": find_listening_pid(port)}
        if h and h.get("_code") == 503:
            config.log(f"[engine] :{port} 上已有引擎正在加载权重，等它就绪")

        preflight()

        if h is None:
            cfg = config.load_config()
            fast = cfg.get("fastAll") if fast_all is None else fast_all
            wd = config.weights_dir()
            args = [sys.executable, "-m", config.ENGINE_MODULE, str(wd), "--host", "127.0.0.1", "--port", str(port)]
            if fast:
                args.append("--fast-all")
            env = dict(os.environ)
            env.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
            env.setdefault("HF_HUB_DISABLE_XET", "1")
            env["PYTHONUNBUFFERED"] = "1"
            env["PYTHONIOENCODING"] = "utf-8"
            env["PYTHONPATH"] = str(config.ENGINE_DIR) + os.pathsep + env.get("PYTHONPATH", "")
            kwargs: dict = {"cwd": str(config.ENGINE_DIR)}
            if os.name == "nt":
                kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            config.log("[engine] spawn " + " ".join(args))
            global _proc
            try:
                _proc = subprocess.Popen(
                    args,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    stdin=subprocess.DEVNULL,
                    env=env,
                    **kwargs,
                )
            except Exception as exc:  # noqa: BLE001
                raise EngineError("engine_spawn_failed", f"引擎进程启动失败：{exc}") from exc
            threading.Thread(target=_pump, args=(_proc.stdout, "out"), daemon=True).start()
            threading.Thread(target=_pump, args=(_proc.stderr, "err"), daemon=True).start()
            _state.update({"startedAt": int(time.time() * 1000), "port": port, "reused": False})
            save_pid_meta({"pid": _proc.pid, "port": port, "startedAt": _state["startedAt"], "weights": str(wd)})
            config.log(f"[engine] spawned pid={_proc.pid} weights={wd} fast={bool(fast)}")

        deadline = time.time() + max(30.0, float(wait_s))
        last_log = 0.0
        while time.time() < deadline:
            if _proc is not None and _proc.poll() is not None and not alive():
                tail = "\n".join(log_tail(40))
                raise EngineError("engine_exited", "引擎进程启动后退出：\n" + tail)
            hh = health(port, timeout=2.0)
            if hh and hh.get("_code") == 200:
                _state["port"] = port
                _state["pid"] = pid()
                config.log(f"[engine] ready :{port} sample_rate={hh.get('sample_rate')}")
                return {"ok": True, "port": port, "pid": pid(), "sampleRate": hh.get("sample_rate")}
            if time.time() - last_log > 10:
                last_log = time.time()
                config.log("[engine] 等待就绪…（首次需加载约 7.7GB 权重）")
            time.sleep(1.5)
        raise EngineError("engine_start_timeout", f"等待引擎就绪超时（>{int(wait_s)}s）。最近日志：\n" + "\n".join(log_tail(30)))


def stop(*, timeout_s: float = 25.0) -> dict:
    """停引擎：先温柔（terminate），超时再杀整棵进程树；顺手清掉端口孤儿。"""
    global _proc
    with _lock:
        port = engine_port()
        meta = load_pid_meta()
        targets = []
        if _proc is not None and _proc.poll() is None:
            targets.append(int(_proc.pid))
        if meta.get("pid"):
            targets.append(int(meta["pid"]))
        orphan = find_listening_pid(port)
        if orphan:
            targets.append(orphan)

        for n in dict.fromkeys(targets):
            try:
                if os.name == "nt":
                    subprocess.run(
                        ["taskkill", "/PID", str(n), "/T", "/F"],
                        capture_output=True,
                        timeout=20,
                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                    )
                else:
                    os.kill(n, 15)
            except Exception:
                pass
        if _proc is not None:
            try:
                _proc.wait(timeout=max(5.0, timeout_s))
            except Exception:
                pass
        _proc = None
        clear_pid_meta()
        deadline = time.time() + max(5.0, timeout_s)
        while time.time() < deadline:
            if find_listening_pid(port) == 0:
                break
            n = find_listening_pid(port)
            if n:
                kill_pid_tree(n)
            time.sleep(0.5)
        stopped = find_listening_pid(port) == 0
        config.log(f"[engine] stop → listening={not stopped}")
        _state["startedAt"] = 0
        return {"ok": True, "stopped": stopped}


def status() -> dict:
    port = engine_port()
    h = health(port, timeout=2.0)
    code = (h or {}).get("_code")
    return {
        "port": port,
        "up": code == 200,
        "loading": code == 503,
        "pid": pid(),
        "sampleRate": (h or {}).get("sample_rate"),
        "startedAt": _state.get("startedAt") or 0,
        "reused": bool(_state.get("reused")),
        "logTail": log_tail(80),
    }
