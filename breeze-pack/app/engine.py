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

# 只护「要不要 spawn」这一小段。以前是整把锁包住最长 900s 的就绪等待，
# 于是 stop()（以及 /api/shutdown）排在它后面：用户点停引擎 / 关后端，看着就是「点了没反应、
# 关不掉」。等待期间不再持锁，stop 随时能杀。
_spawn_lock = threading.Lock()
# 停止信号：stop() 递增序号，正在等的 start() 看到序号变了就立刻退出（不靠清 Event 的时序）。
_stop_seq = 0
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


def gpu_mem_gib() -> tuple[float, float]:
    """(总显存, 当前可用) GiB —— 走 nvidia-smi，绝不在本进程里初始化 CUDA。"""
    out = subprocess.run(
        ["nvidia-smi", "--query-gpu=memory.total,memory.free", "--format=csv,noheader,nounits"],
        capture_output=True,
        text=True,
        timeout=15,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0,
    )
    line = (out.stdout or "").strip().splitlines()[0]
    total, free = [float(x) for x in line.split(",")[:2]]
    return total / 1024.0, free / 1024.0


def preflight() -> None:
    """起引擎前的环境体检：缺什么就报带 code 的错误，让宿主给出中文指路。

    torch 只查「装没装」（find_spec，不 import）；CUDA 只看 nvidia-smi 有没有卡。
    以前这里 import torch 并 torch.cuda.is_available()，等于把 CUDA 上下文拉进管理服务进程，
    引擎卸载后那几百 MB 也一直挂着 —— 显存「回落不干净」的一大来源。
    """
    if not config.python_version_ok():
        raise EngineError("bad_python", f"需要 Python 3.10+，当前 {sys.version.split()[0]}")
    if not config.engine_ready():
        raise EngineError("not_installed", f"推理引擎源码缺失：{config.ENGINE_DIR / 'infer.py'}")
    if not config.weights_ready():
        wd = config.weights_dir()
        raise EngineError("no_weights", f"未找到 Breeze TTS 2 权重：{wd}")
    try:
        import importlib.util

        if importlib.util.find_spec("torch") is None:
            raise EngineError("torch_missing", "虚拟环境缺少 torch")
    except EngineError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise EngineError("torch_missing", f"虚拟环境缺少 torch：{exc}") from exc
    try:
        total, _free = gpu_mem_gib()
    except Exception as exc:  # noqa: BLE001
        raise EngineError(
            "cuda_unavailable",
            f"nvidia-smi 看不到可用 GPU（Breeze TTS 2 需要 NVIDIA GPU，eager 约 7.7GB 显存）：{exc}",
        ) from exc
    if total <= 0:
        raise EngineError("cuda_unavailable", "nvidia-smi 报总显存 0：驱动或显卡不可用")


# 长台词必须**一次**合成完：引擎是零样本 TTS，同一段文本拆成两次独立生成，
# 音色 / 语气 / 响度都会各走各的（用户听到的就是「播到 70~80 秒突然换了个人」）。
# 引擎有两条实现层限制会让管理层被迫拆段，这里在启动时把两条都放宽（不改引擎源码文件）：
#   1) 暖机档默认 freeze_after_warmup=true：文本比暖机桶长就硬报
#      "text encoder CUDA graph (4, 352) has no fitting bucket"。关掉 freeze 后，
#      首次遇到更长文本会按需补抓一张 CUDA Graph（一次性，之后复用）。
#   2) 常量 max_new_tokens=1500（≈120s）/ max_seq_len=2048 装不下常见长台词，超了被静默截断。
#      用一段引导代码把两个常量放宽（`python -c` 启动，引擎文件一个字节都不动）。
ENGINE_MAX_NEW_TOKENS = 2400  # ≈185s 音频，够 600~700 字中文口播
ENGINE_MAX_SEQ_LEN = 4096
_ENGINE_BOOTSTRAP = (
    "import breeze_infer.api as _api\n"
    f"if hasattr(_api, 'MAX_NEW_TOKENS'):\n    _api.MAX_NEW_TOKENS = {ENGINE_MAX_NEW_TOKENS}\n"
    f"if hasattr(_api, 'MAX_SEQ_LEN'):\n    _api.MAX_SEQ_LEN = {ENGINE_MAX_SEQ_LEN}\n"
    "_api.main()\n"
)


def relax_warmup_profile() -> str:
    """暖机档改成「按需补图」：长文本不再因为桶不够直接失败，而是自动补一张图。"""
    p = config.ENGINE_DIR / "configs" / "fast.json"
    try:
        raw = json.loads(p.read_text("utf-8"))
    except Exception as exc:  # noqa: BLE001
        return f"读取暖机档失败，跳过（{exc}）"
    service = raw.get("service")
    if not isinstance(service, dict):
        return "暖机档没有 service 段，跳过"
    if service.get("freeze_after_warmup") is False:
        return "已是按需补图"
    service["freeze_after_warmup"] = False
    tmp = p.with_suffix(".json.tmp")
    try:
        tmp.write_text(json.dumps(raw, ensure_ascii=False, indent=2) + "\n", "utf-8")
        os.replace(tmp, p)
    except Exception as exc:  # noqa: BLE001
        return f"写回暖机档失败，跳过（{exc}）"
    return "已改为按需补图"


# fast 路径（CUDA Graph）的显存门槛：官方 README 标注 --fast-all 约 14.4GB，
# 推荐 24GB 卡；低于门槛直接回退 eager，避免「开了 fast 反而 OOM 崩引擎」。
FAST_MIN_VRAM_GIB = 18.0
FAST_MIN_FREE_GIB = 18.0


def _env_bool(name: str) -> bool | None:
    """环境变量三态：未设置 → None；1/true/yes/on → True；其余非空 → False。"""
    raw = os.environ.get(name)
    if raw is None or not str(raw).strip():
        return None
    return str(raw).strip().lower() in {"1", "true", "yes", "on"}


def _fast_fits() -> tuple[bool, str]:
    """fast 路径能不能开：triton 是否可用（depth decoder 要 torch.compile）+ 显存门槛。

    显存一律走 nvidia-smi 查，**不在管理服务进程里 import torch**：一旦 import 并在本进程
    初始化 CUDA，管理服务自己就会常驻几百 MB 显存，而且引擎停了也不还（用户看到的
    「停掉以后显存还是被占着 / 一启动就吃满」）。
    """
    try:
        import triton  # noqa: F401
    except Exception as exc:  # noqa: BLE001
        # Windows 上 triton 要装 triton-windows（install.ps1 的依赖步骤），缺了 --fast-all
        # 会直接在 warmup 里 TritonMissing 崩启动 —— 宁可关掉 fast 也别让引擎起不来。
        return False, f"缺少 triton（{exc}）：fast 路径需要 triton，先重装 / 修好依赖"
    try:
        total, free = gpu_mem_gib()
    except Exception as exc:  # noqa: BLE001
        return False, f"显存查询失败：{exc}"
    if total < FAST_MIN_VRAM_GIB:
        return False, f"总显存 {total:.1f}G < {FAST_MIN_VRAM_GIB:g}G"
    if free < FAST_MIN_FREE_GIB:
        return False, f"当前可用显存 {free:.1f}G < {FAST_MIN_FREE_GIB:g}G（其它任务占着卡）"
    return True, f"总显存 {total:.1f}G / 当前可用 {free:.1f}G"


def resolve_fast(explicit: bool | None = None) -> tuple[bool, str]:
    """决定是否给引擎加 `--fast-all`（官方推荐的最优配置：CUDA Graph + 预热）。

    优先级：显式参数 > 环境变量 BREEZE_FAST_ALL（宿主 fastAll 开关）> manager.json 的 fastAll
    > 默认关（fast 会把显存占满，需用户在宿主开关里显式打开）。以前只读 manager.json，而宿主把开关放在插件 config.json 里、只发环境变量，
    于是引擎 62 次启动全是 fast=False —— 这是「比预期慢很多」的主因。
    """
    source = "参数"
    wanted = explicit
    if wanted is None:
        wanted = _env_bool("BREEZE_FAST_ALL")
        source = "环境变量 BREEZE_FAST_ALL"
    if wanted is None:
        value = config.load_config().get("fastAll")
        if isinstance(value, bool):
            wanted, source = value, "manager.json"
    if wanted is None:
        wanted, source = False, "默认"
    if not wanted:
        return False, f"{source}=off"
    if _env_bool("BREEZE_FAST_FORCE"):
        return True, f"{source}=on（BREEZE_FAST_FORCE 跳过显存校验）"
    fits, why = _fast_fits()
    if not fits:
        return False, f"{source}=on 但 {why}，回退 eager"
    return True, f"{source}=on（{why}）"


def start(*, fast_all: bool | None = None, wait_s: float = 900.0) -> dict:
    """拉起引擎并等 /health 就绪；已在跑（含上次遗留 / 自己那只还活着）则复用。"""
    global _proc
    port = engine_port()
    stop_mark = _stop_seq
    h = health(port, timeout=1.5)
    if h and h.get("_code") == 200:
        _state.update({"reused": True, "port": port, "startedAt": _state.get("startedAt") or int(time.time() * 1000)})
        config.log(f"[engine] 复用已在运行的引擎 :{port} pid={find_listening_pid(port)}")
        return {"ok": True, "reused": True, "port": port, "pid": find_listening_pid(port)}

    with _spawn_lock:
        if stop_mark != _stop_seq:
            raise EngineError("engine_stopped", "引擎启动已被取消")
        h = health(port, timeout=1.5)
        if h and h.get("_code") == 200:
            _state.update({"reused": True, "port": port, "startedAt": _state.get("startedAt") or int(time.time() * 1000)})
            return {"ok": True, "reused": True, "port": port, "pid": find_listening_pid(port)}
        if h and h.get("_code") == 503:
            config.log(f"[engine] :{port} 上已有引擎正在加载权重，等它就绪")

        # **绝不在自己那只引擎还活着时再 spawn 一只**：长台词合成时 /health 会被前处理占住，
        # 探活超时被误判成「引擎没起」→ 再拉一只 = 两份 16GB 权重抢一张卡（显存占满 + 双双卡死）。
        if alive():
            config.log(f"[engine] 自有引擎进程仍在（pid={_proc.pid}）：等它就绪，不重复拉起")
        elif h is not None:
            config.log(f"[engine] :{port} 已有监听者（status={h.get('status')}）：等它就绪，不重复拉起")
        else:
            preflight()
            fast, fast_reason = resolve_fast(fast_all)
            config.log(f"[engine] fast 路径：{'开' if fast else '关'}（{fast_reason}）")
            wd = config.weights_dir()
            config.log(f"[engine] 长文本暖机档：{relax_warmup_profile()}")
            args = [sys.executable, "-c", _ENGINE_BOOTSTRAP, str(wd), "--host", "127.0.0.1", "--port", str(port)]
            if fast:
                args.append("--fast-all")
            env = dict(os.environ)
            env.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
            env.setdefault("HF_HUB_DISABLE_XET", "1")
            # 16GB 级别权重 + 多次 CUDA Graph 抓取很容易把显存切碎：开着可扩展段分配，
            # 峰值更低、也不会因为碎片把「本来装得下」的桶挤成 OOM。
            env.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
            env["PYTHONUNBUFFERED"] = "1"
            env["PYTHONIOENCODING"] = "utf-8"
            env["PYTHONPATH"] = str(config.ENGINE_DIR) + os.pathsep + env.get("PYTHONPATH", "")
            if os.name == "nt":
                # torch 2.9 的 inductor 静态 CUDA launcher 在 Windows 上会抛
                # OverflowError: Python int too large to convert to C long（fast 路径 warmup 里
                # 编译 depth decoder 时必现）。关掉它改走 triton 自带 launcher，fast 才能起来。
                env.setdefault("TORCHINDUCTOR_USE_STATIC_CUDA_LAUNCHER", "0")
            kwargs: dict = {"cwd": str(config.ENGINE_DIR)}
            if os.name == "nt":
                kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            # 引导代码里带换行，别整段打进控制台
            config.log(
                f"[engine] spawn {sys.executable} -c <bootstrap MAX_NEW_TOKENS={ENGINE_MAX_NEW_TOKENS} "
                f"MAX_SEQ_LEN={ENGINE_MAX_SEQ_LEN}> {wd} --host 127.0.0.1 --port {port}"
                + (" --fast-all" if fast else "")
            )
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
            _state.update({"startedAt": int(time.time() * 1000), "port": port, "reused": False, "fast": bool(fast)})
            save_pid_meta(
                {
                    "pid": _proc.pid,
                    "port": port,
                    "startedAt": _state["startedAt"],
                    "weights": str(wd),
                    "fast": bool(fast),
                }
            )
            config.log(f"[engine] spawned pid={_proc.pid} weights={wd} fast={bool(fast)}")

    # 就绪等待不持锁：stop() 期间随时能杀掉进程（否则「停止」要等到 900s 超时才生效）。
    deadline = time.time() + max(30.0, float(wait_s))
    t0 = time.time()
    last_log = 0.0
    while time.time() < deadline:
        if stop_mark != _stop_seq:
            raise EngineError("engine_stopped", "引擎启动已被停止")
        # 进程活着却一直不就绪（加载卡死 / CUDA 初始化挂住）：杀掉它给出明确错误，
        # 而不是让调用方干等满 900s（上层看到的就是「节点卡死」）。
        if _proc is not None and time.time() - t0 > 420 and health(port, timeout=2.0) is None:
            config.log("[engine] 进程 420s 仍未就绪 → 判定加载卡死，杀掉后报错（下次会重新拉起）")
            kill_pid_tree(_proc.pid)
            _proc = None
            clear_pid_meta()
            raise EngineError("engine_start_timeout", "引擎加载 420s 仍未就绪（已杀掉卡住的进程），请重试")
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
    """停引擎：先温柔（terminate），超时再杀整棵进程树；顺手清掉端口孤儿。

    不排 `start()` 的就绪等待（那把锁只在 spawn 段短暂持有），所以「停止 / 关后端」
    在加载权重期间也能立刻生效 —— 以前 stop 要排在最长 900s 的 start 后面，
    用户看到的就是「停了没反应、关不掉、显存一直占着」。
    """
    global _proc, _stop_seq
    _stop_seq += 1
    port = engine_port()
    got = _spawn_lock.acquire(timeout=8.0)
    try:
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
    finally:
        if got:
            _spawn_lock.release()
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
    meta = load_pid_meta()
    return {
        "port": port,
        "up": code == 200,
        "loading": code == 503,
        "pid": pid(),
        "fast": bool(_state.get("fast") if _state.get("fast") is not None else meta.get("fast")),
        "sampleRate": (h or {}).get("sample_rate"),
        "startedAt": _state.get("startedAt") or 0,
        "reused": bool(_state.get("reused")),
        "logTail": log_tail(80),
    }
