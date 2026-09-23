"""SenseNova 本地图像生成后端 —— 只用 Python 标准库写的 HTTP 服务。

**这是冻结的对接面（宿主 / 画布节点按这份契约写，字段名不要改）**：

- 启动：``<INSTALL_DIR>\\.venv\\Scripts\\python.exe -m app <port>``，cwd = INSTALL_DIR，
  只监听 127.0.0.1，默认端口 8774；启动成功 stdout 打一行 ``[sensenova] ready``。
- 环境变量：``SENSENOVA_PORT`` / ``SENSENOVA_MODEL_DIR`` / ``SENSENOVA_DEVICE`` /
  ``SENSENOVA_VRAM_MODE`` / ``SENSENOVA_DTYPE`` / ``SENSENOVA_ATTN_BACKEND`` /
  ``MTNODE_SENSENOVA_MOCK`` / ``HF_ENDPOINT``。
- ``GET  /health``   → 存活与配置（权重懒加载，未加载也秒回）
- ``POST /generate`` → 同步生成一张图（24G 卡 + 分层卸载：首次含加载，数分钟级长请求）；
  带 ``refImages`` 时走**图像编辑 / 参考图条件生成**（``model.it2i_generate``），不带则是纯文生图
- ``GET  /progress`` → staged 进度（生成期间轮询；百分比单调不回退，不承诺精确）
- ``POST /cancel``   → 请求取消（在下一个采样步边界生效）
- ``POST /shutdown`` → 响应后释放显存并退出进程
- ``GET  /``         → 服务自述

``/generate`` 入参（application/json，除注明外均可省）：
  prompt        string  必填，图像提示词
  refImages     array   可选，**参考图 / 编辑底图的本机绝对路径**（1~4 张，缺失文件跳过）；
                        给了就走图像编辑（it2i_generate，参考图作为图像条件参与生成），
                        不给仍是纯文生图（t2i_generate）。画布 sensenova_gen 节点的图像连线 /
                        @ 引用图由宿主收齐后从这里下发。
  imgCfgScale   float   可选，缺省 1.0（图像 CFG 权重；1.0 = 关闭图像 CFG，官方默认）
  width/height  int     可选，缺省 2048x2048；官方只有 11 个训练分辨率桶
                        （见 /health 的 resolutions），非桶值只告警不拦
  ratio         string  可选，直接给 ``1:1`` / ``16:9`` … 官方档位（等价于填 W/H）
  numSteps      int     可选，缺省 50（官方默认），clamp 到 1~200
  cfgScale      float   可选，缺省 4.0（官方默认）
  cfgNorm       string  可选，``none``（默认）/ ``global`` / ``channel`` / ``cfg_zero_star``
  timestepShift float   可选，缺省 3.0（官方默认）
  cfgInterval   [lo,hi] 可选，缺省 [0,1]
  seed          int     可选，缺省随机（<0 或非法也随机；响应里回真实使用的种子）
  vramMode      string  可选，``fast``（默认，24G 卡档位）/ ``balanced`` / ``low`` / ``full``
  dtype         string  可选，``bfloat16``（默认）/ ``float16`` / ``float32``
  attnBackend   string  可选，``sdpa``（默认，Windows 无 flash-attn 轮子）/ ``auto`` / ``flash``
  think         bool    可选，官方 think 模式；true 时额外落 ``<名>.think.txt`` 并回 thinkText
  outputDir     string  可选，产物目录（相对路径按后端 cwd 解析）；缺省 ``<INSTALL_DIR>\\outputs\\sensenova-<ts>``
  filename      string  可选，输出文件名（强制 .png）；缺省 ``sensenova-<时间戳>.png``
  device        string  可选，``cuda`` / ``cuda:0`` / ``cpu``；空 = 自动（有 CUDA 就用 CUDA）

成功 200：{"ok":true,"imagePath":"<绝对路径>","outputDir":"<绝对路径>","artifacts":[...],
          "width":2048,"height":2048,"ratio":"1:1","vramMode":"fast","dtype":"bfloat16",
          "attnBackend":"sdpa","peakVramGiB":22.7,"thinkText":"","thinkPath":"",
          "seed":123,"numSteps":50,"cfgScale":4.0,"cfgNorm":"none","timestepShift":3.0,
          "think":false,"mock":false,"elapsedSec":184.2,"warnings":[],
          "mode":"t2i"|"edit","refImages":[...],"imgCfgScale":1.0,"refImagesUsed":0}

失败非 200：{"ok":false,"error":"<短码>","message":"<中文可读原因>"}
短码：bad_request(400) · busy(429) · cancelled(409) · model_load_failed(500)
      · generate_failed(500) · save_failed(500) · internal_error(500)
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from app import SERVICE, __version__ as APP_VERSION
from app import engine as engine_mod

# 安装目录：sensenova-pack/app/server.py -> sensenova-pack/（= 运行时的 INSTALL_DIR）
ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PORT = 8774
HOST = "127.0.0.1"

JSON_CT = "application/json; charset=utf-8"
MAX_JSON_BYTES = 8 * 1024 * 1024

_ERROR_HTTP: Dict[str, int] = {
    "bad_request": 400,
    "cancelled": 409,
    "busy": 429,
    "model_load_failed": 500,
    "generate_failed": 500,
    "save_failed": 500,
    "internal_error": 500,
    "not_found": 404,
}


def _log(msg: str) -> None:
    """行式 stdout 日志（UTF-8），统一 ``[sensenova] `` 前缀，上层追加进 ``<DATA>\\sensenova\\console.log``。"""
    line = f"[sensenova] {msg}"
    try:
        print(line, flush=True)
    except Exception:
        pass


engine_mod.set_logger(_log)

# 全局唯一引擎 + 生成互斥（SenseNova 一次只出一张图，忙时 429 busy）
_ENGINE = engine_mod.SenseNovaEngine()
_BUSY = threading.Lock()
_SERVER: Optional[ThreadingHTTPServer] = None


def _json_bytes(obj: Any) -> bytes:
    return json.dumps(obj, ensure_ascii=False).encode("utf-8")


def _resolved_port() -> int:
    """端口优先级：命令行参数 > SENSENOVA_PORT > 默认 8774。"""
    if len(sys.argv) > 1:
        try:
            return int(sys.argv[1])
        except ValueError:
            pass
    try:
        v = int((os.environ.get("SENSENOVA_PORT") or "").strip() or DEFAULT_PORT)
    except ValueError:
        v = DEFAULT_PORT
    return v if 1 <= v <= 65535 else DEFAULT_PORT


def _health_payload() -> Dict[str, Any]:
    """健康检查必须秒回：只报状态，绝不触发模型加载。"""
    snapshot = _ENGINE.progress.snapshot()
    return {
        "ok": True,
        "service": SERVICE,
        "version": APP_VERSION,
        "model": engine_mod.MODEL_REPO,
        "modelModelScope": engine_mod.MODEL_REPO_MODELSCOPE,
        "backend": "sensenova_u1",
        "packageVersion": _ENGINE.package_version or engine_mod._package_version(),
        "device": _ENGINE.pick_device(),
        "gpu": _ENGINE.gpu_info(),
        "loaded": bool(_ENGINE.loaded),
        "busy": _BUSY.locked(),
        "mock": bool(_ENGINE.mock),
        "modelSource": _ENGINE.model_source,
        "modelReady": bool((ROOT / "models" / ".ok").is_file()),
        "installDir": str(ROOT),
        "outputsRoot": str(ROOT / "outputs"),
        "vramModes": list(engine_mod.VRAM_MODES),
        "vramMode": _ENGINE.env_vram_mode(),
        "dtypes": list(engine_mod.DTYPES),
        "dtype": _ENGINE.env_dtype(),
        "attnBackends": list(engine_mod.ATTN_BACKENDS),
        "attnBackend": _ENGINE.env_attn_backend(),
        "effectiveAttnBackend": _ENGINE.effective_attn_backend,
        "cfgNorms": list(engine_mod.CFG_NORMS),
        "defaults": {
            "width": engine_mod.DEFAULT_WIDTH,
            "height": engine_mod.DEFAULT_HEIGHT,
            "numSteps": engine_mod.DEFAULT_NUM_STEPS,
            "cfgScale": engine_mod.DEFAULT_CFG_SCALE,
            "cfgNorm": engine_mod.DEFAULT_CFG_NORM,
            "timestepShift": engine_mod.DEFAULT_TIMESTEP_SHIFT,
            "imgCfgScale": engine_mod.DEFAULT_IMG_CFG_SCALE,
            "maxRefImages": engine_mod.MAX_REF_IMAGES,
            "seed": engine_mod.DEFAULT_SEED,
        },
        # 官方 11 个训练分辨率桶（宿主/节点下拉直接用它，别在渲染层再抄一份）
        "resolutions": [
            {"ratio": ratio, "width": w, "height": h}
            for ratio, (w, h) in engine_mod.SUPPORTED_RESOLUTIONS.items()
        ],
        "progress": {"stage": snapshot["stage"], "percent": snapshot["percent"]},
    }


def _error_payload(code: str, message: str) -> Dict[str, Any]:
    return {"ok": False, "error": code, "message": message}


class SenseNovaHandler(BaseHTTPRequestHandler):
    server_version = "mtnode-sensenova/" + APP_VERSION
    protocol_version = "HTTP/1.1"

    # ---------- 基础工具 ----------

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003 - 覆盖基类
        try:
            _log("http " + (fmt % args))
        except Exception:
            pass

    def _read_body(self, limit: int) -> bytes:
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n <= 0:
            return b""
        if n > limit:
            raise ValueError(f"请求体过大（{n} 字节，上限 {limit} 字节）")
        return self.rfile.read(n)

    def _send(self, code: int, body: bytes, content_type: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        # 本机回环服务，方便画布节点 / 脚本直接调
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _send_json(self, code: int, obj: Any) -> None:
        self._send(code, _json_bytes(obj), JSON_CT)

    def _fail(self, code: int, error: str, message: str) -> None:
        _log(f"错误 {code} {error}：{message}")
        self._send_json(code, _error_payload(error, message))

    def _fail_engine(self, e: engine_mod.EngineError) -> None:
        self._fail(_ERROR_HTTP.get(e.code, 500), e.code, e.message)

    def _read_json(self) -> Tuple[bool, Dict[str, Any]]:
        ctype = (self.headers.get("Content-Type") or "").lower()
        if "application/json" not in ctype:
            self._fail(400, "bad_request", "Content-Type 必须是 application/json。")
            return False, {}
        try:
            raw = self._read_body(MAX_JSON_BYTES)
        except ValueError as e:
            self._fail(400, "bad_request", str(e))
            return False, {}
        try:
            blob = json.loads(raw.decode("utf-8") or "{}")
        except Exception as e:
            self._fail(400, "bad_request", f"JSON 解析失败：{str(e)[:200]}")
            return False, {}
        if not isinstance(blob, dict):
            self._fail(400, "bad_request", "JSON 请求体必须是对象。")
            return False, {}
        return True, blob

    # ---------- 路由 ----------

    def do_OPTIONS(self) -> None:  # noqa: N802 - 基类命名
        self._send(204, b"", "text/plain; charset=utf-8")

    def do_GET(self) -> None:  # noqa: N802
        path = (self.path or "").split("?")[0].rstrip("/") or "/"
        if path in ("/health", "/api/health"):
            self._send_json(200, _health_payload())
            return
        if path == "/progress":
            snapshot = _ENGINE.progress.snapshot()
            snapshot["ok"] = True
            snapshot["busy"] = _BUSY.locked()
            self._send_json(200, snapshot)
            return
        if path == "/":
            self._send_json(200, {
                "ok": True,
                "service": SERVICE,
                "version": APP_VERSION,
                "model": engine_mod.MODEL_REPO,
                "port": _resolved_port(),
                "endpoints": ["/health", "/generate", "/progress", "/cancel", "/shutdown"],
            })
            return
        self._fail(404, "not_found", f"未知路径：{path}")

    def do_POST(self) -> None:  # noqa: N802
        path = (self.path or "").split("?")[0].rstrip("/") or "/"
        try:
            if path == "/generate":
                self._handle_generate()
                return
            if path == "/cancel":
                self._handle_cancel()
                return
            if path == "/shutdown":
                self._handle_shutdown()
                return
        except ValueError as e:
            self._fail(400, "bad_request", str(e))
            return
        except Exception as e:  # 兜底：任何未预期异常都转 JSON，绝不吐 traceback
            _log("未处理异常：" + traceback.format_exc(limit=6).replace("\n", " | ")[:600])
            self._fail(500, "internal_error", f"后端内部错误：{str(e)[:300]}")
            return
        self._fail(404, "not_found", f"未知路径：{path}")

    # ---------- 生成 ----------

    def _handle_generate(self) -> None:
        ok, blob = self._read_json()
        if not ok:
            return
        # `ratio` 只是 W/H 的糖：填了桶名就换算成官方分辨率（显式 W/H 优先）
        ratio = str(blob.get("ratio") or "").strip()
        if ratio and not blob.get("width") and not blob.get("height"):
            pair = engine_mod.SUPPORTED_RESOLUTIONS.get(ratio)
            if pair is None:
                known = " / ".join(engine_mod.SUPPORTED_RESOLUTIONS)
                self._fail(400, "bad_request", f"ratio 必须是官方档位之一：{known}；收到：{ratio}")
                return
            blob["width"], blob["height"] = pair[0], pair[1]
        if not _BUSY.acquire(blocking=False):
            self._fail(429, "busy", "后端正忙（同一时刻只允许生成一张图），请等本次结束或先 POST /cancel。")
            return
        try:
            result = _ENGINE.generate(blob)
        except engine_mod.EngineError as e:
            self._fail_engine(e)
            return
        except Exception as e:
            _log("生成未预期异常：" + traceback.format_exc(limit=6).replace("\n", " | ")[:600])
            self._fail(500, "internal_error", f"后端内部错误：{str(e)[:300]}")
            return
        finally:
            _BUSY.release()
        result["ok"] = True
        self._send_json(200, result)

    # ---------- 取消 / 退出 ----------

    def _handle_cancel(self) -> None:
        self._read_body(1024)  # 允许带空体或 {}；不解析内容
        accepted = _ENGINE.cancel()
        self._send_json(200, {
            "ok": True,
            "cancelled": bool(accepted),
            "running": bool(_ENGINE.progress.running),
            "note": "取消在下一个采样步边界生效（正在跑的 torch kernel 不能抢占）；中止后不写出任何图像。"
            if accepted else "当前没有正在进行的生成。",
            "progress": _ENGINE.progress.snapshot(),
        })

    def _handle_shutdown(self) -> None:
        self._read_body(1024)
        self._send_json(200, {"ok": True})
        _log("收到 shutdown 请求，进程即将退出")

        def _exit_soon() -> None:
            time.sleep(0.4)
            try:
                _ENGINE.cancel()
            except Exception:
                pass
            try:
                _ENGINE.close()
            except Exception:
                pass
            try:
                if _SERVER is not None:
                    _SERVER.shutdown()
            except Exception:
                pass
            os._exit(0)

        threading.Thread(target=_exit_soon, daemon=True, name="sensenova-exit").start()


class SenseNovaServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request, client_address):
        """客户端中途断开（/progress 轮询超时、窗口关闭等）不吐 traceback，只记一行。"""
        exc = sys.exc_info()[1]
        name = type(exc).__name__ if exc else "Unknown"
        if name in (
            "ConnectionAbortedError",
            "ConnectionResetError",
            "BrokenPipeError",
            "ConnectionError",
            "TimeoutError",
            "OSError",
        ):
            _log(f"客户端提前断开（{name}），忽略")
            return
        super().handle_error(request, client_address)


def main() -> None:
    global _SERVER
    port = _resolved_port()
    _log(f"启动中：http://{HOST}:{port}（install dir: {ROOT}）")
    if _ENGINE.mock:
        _log("MTNODE_SENSENOVA_MOCK=1 —— mock 模式：不加载模型，按入参造占位 PNG（冒烟 / 联调）")
    else:
        info = engine_mod.describe_env()
        _log(f"模型：{_ENGINE.model_source}；device：{info['device']}；"
             f"vramMode：{info['vramMode']}；dtype：{info['dtype']}；attn：{info['attnBackend']}")
        if not _ENGINE.loaded:
            _log("权重懒加载：第一次 /generate 才加载（32.66GB 权重 + 分层卸载，可能要几分钟）")
    try:
        _SERVER = SenseNovaServer((HOST, port), SenseNovaHandler)
    except OSError as e:
        _log(f"监听 {HOST}:{port} 失败：{e}")
        raise SystemExit(2)
    _log("ready")
    try:
        _SERVER.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        _log("收到中断，退出")
    finally:
        try:
            _ENGINE.close()
        except Exception:
            pass
        try:
            _SERVER.server_close()
        except Exception:
            pass


if __name__ == "__main__":
    main()
