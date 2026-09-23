"""YuE2 本地音乐生成后端 —— 只用 Python 标准库写的 HTTP 服务。

**这是冻结的对接面（任务 2 按这份契约写，字段名不要改）**：

- 启动：`<INSTALL_DIR>\\.venv\\Scripts\\python.exe -m app <port>`，cwd = INSTALL_DIR，
  只监听 127.0.0.1，默认端口 8773；启动成功 stdout 打一行 `[yue2] ready`。
- 环境变量：YUE2_PORT / YUE2_MODEL_DIR / YUE2_VAE / YUE2_VAE_DIR / YUE2_DEVICE /
  YUE2_LOAD_PER_REQUEST / MTNODE_YUE2_MOCK / HF_ENDPOINT。
- `GET  /health`   → 存活与配置（模型懒加载，未加载也秒回）
- `POST /generate` → 同步生成一首歌（一首 3–5 分钟，客户端超时要放长），产物落 outputDir
- `GET  /progress` → staged 进度（生成期间轮询；百分比单调不回退，不承诺精确）
- `POST /cancel`   → 请求取消（在下一个阶段边界生效）
- `POST /shutdown` → 响应后进程退出
- `GET  /`         → 服务自述

`/generate` 入参（application/json，除注明外均可省）：
  style       string  必填，风格提示词（英文/中文均可）
  lyrics      string  必填，歌词正文（可含 [verse] / [chorus] 等段落标签）
  cot         string  "full"（默认，旋律+和弦规划）| "melody"（只给旋律，翻唱推荐）| "off"
  abc         string  可选，自带 ABC 乐谱（配合 cot="melody"/"full" 做翻唱或改谱）
  seed        int     可选，缺省随机（响应里回真实使用的种子）
  outputDir   string  可选，产物目录（相对路径按后端 cwd 解析）；缺省 <INSTALL_DIR>\\outputs\\yue2-<ts>
  cfgScale    float   可选，文本引导强度（官方建议试 1.2）
  extra       object  可选，透传给 pipeline 的额外命名参数（与上面重名的键会被忽略）

成功 200：{"ok":true,"audioPath":"<绝对路径>","outputDir":"<绝对路径>","artifacts":[...],
          "scoreAbc":"<score.abc 绝对路径 或 ''>","scoreAbcLen":0,"durationSec":214.9,
          "cot":"full","seed":123,"mock":false,"elapsedSec":97.5,"warnings":[]}

失败非 200：{"ok":false,"error":"<短码>","message":"<中文可读原因>"}
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

# 安装目录：yue-pack/app/server.py -> yue-pack/（= 运行时的 INSTALL_DIR）
ROOT = Path(__file__).resolve().parent.parent
MODEL_ID = engine_mod.MODEL_ID
VAE_ID = engine_mod.VAE_ID
DEFAULT_PORT = 8773
HOST = "127.0.0.1"

JSON_CT = "application/json; charset=utf-8"
MAX_JSON_BYTES = 32 * 1024 * 1024


def _log(msg: str) -> None:
    """行式 stdout 日志（UTF-8），统一 `[yue2] ` 前缀，上层追加进 <DATA>\\yue2\\console.log。"""
    line = f"[yue2] {msg}"
    try:
        print(line, flush=True)
    except Exception:
        pass


engine_mod.set_logger(_log)

# 全局唯一引擎实例 + 生成互斥（同一时刻只允许一首歌，忙时 429 busy）
_ENGINE = engine_mod.YuE2Engine()
_BUSY = threading.Lock()
_SERVER: Optional[ThreadingHTTPServer] = None

# 引擎短码 → HTTP 状态码
_ERROR_HTTP: Dict[str, int] = {
    "bad_request": 400,
    "unknown_cot": 400,
    "cancelled": 409,
    "busy": 429,
    "model_load_failed": 500,
    "generate_failed": 500,
    "save_failed": 500,
    "no_cuda": 503,
    "internal_error": 500,
}


def _json_bytes(obj: Any) -> bytes:
    return json.dumps(obj, ensure_ascii=False).encode("utf-8")


def _resolved_port() -> int:
    """端口优先级：命令行参数 > YUE2_PORT > 默认 8773。"""
    if len(sys.argv) > 1:
        try:
            return int(sys.argv[1])
        except ValueError:
            pass
    try:
        v = int((os.environ.get("YUE2_PORT") or "").strip() or DEFAULT_PORT)
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
        "model": MODEL_ID,
        "vae": VAE_ID,
        "backend": "yue2_infer",
        "inferVersion": _ENGINE.infer_version,
        "device": _ENGINE.device,
        "loaded": bool(_ENGINE.loaded),
        "busy": _BUSY.locked(),
        "mock": bool(_ENGINE.mock),
        "cots": list(engine_mod.COT_MODES),
        "modelSource": _ENGINE.repo_source(),
        "vaeSource": _ENGINE.vae_source(),
        "outputsRoot": str(ROOT / "outputs"),
        "installDir": str(ROOT),
        "progress": {"stage": snapshot["stage"], "percent": snapshot["percent"]},
    }


def _error_payload(code: str, message: str) -> Dict[str, Any]:
    return {"ok": False, "error": code, "message": message}


class Yue2Handler(BaseHTTPRequestHandler):
    server_version = "mtnode-yue2/" + APP_VERSION
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
            self._send_json(
                200,
                {
                    "ok": True,
                    "service": SERVICE,
                    "version": APP_VERSION,
                    "model": MODEL_ID,
                    "vae": VAE_ID,
                    "port": _resolved_port(),
                    "endpoints": ["/health", "/generate", "/progress", "/cancel", "/shutdown"],
                },
            )
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
        if not _BUSY.acquire(blocking=False):
            self._fail(429, "busy", "后端正忙（同一时刻只允许生成一首歌），请等本次结束或先 POST /cancel。")
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
        self._send_json(
            200,
            {
                "ok": True,
                "cancelled": bool(accepted),
                "running": bool(_ENGINE.progress.running),
                "note": "取消在下一个阶段边界生效（正在跑的推理 kernel 不能抢占）；中止后不写出任何产物。"
                if accepted
                else "当前没有正在进行的生成。",
                "progress": _ENGINE.progress.snapshot(),
            },
        )

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

        threading.Thread(target=_exit_soon, daemon=True, name="yue2-exit").start()


class Yue2Server(ThreadingHTTPServer):
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
        _log("MTNODE_YUE2_MOCK=1 —— mock 模式：不加载模型，按入参造占位产物（冒烟 / 联调）")
    else:
        _log(f"模型：{MODEL_ID}；vae：{_ENGINE.vae_source()}；device：{_ENGINE.device}")
        _log(f"加载源：{_ENGINE.repo_source()}")
    try:
        _SERVER = Yue2Server((HOST, port), Yue2Handler)
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
