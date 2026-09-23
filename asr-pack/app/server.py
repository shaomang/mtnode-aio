"""Qwen3-ASR 本地语音识别后端 —— 只用 Python 标准库写的 HTTP 服务。

契约（上层 `asr/main-asr.js` 已按这份契约写，字段名不要改）：
- 启动：`<INSTALL_DIR>\\.venv\\Scripts\\python.exe -m app <port>`，cwd = INSTALL_DIR，
  只监听 127.0.0.1，默认端口 8772；启动成功 stdout 打一行 `[asr] ready`。
- 环境变量：ASR_PORT / ASR_MODEL_DIR / ASR_DEVICE / ASR_FFMPEG / MTNODE_ASR_MOCK / HF_ENDPOINT。
- `GET  /health`                    → 存活与配置（模型懒加载，未加载也秒回）
- `POST /v1/audio/transcriptions`   → OpenAI 兼容（multipart 上传 或 JSON 传本机路径）
- `POST /api/shutdown`              → 响应后进程退出
- `GET  /v1/models`                 → 固定只有一个模型
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
import traceback
import uuid
from email.parser import BytesParser
from email.policy import default as _email_default
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from app import __version__ as APP_VERSION
from app import audio as audio_mod
from app import engine as engine_mod
from app import vad as vad_mod

# 安装目录：asr-pack/app/server.py -> asr-pack/（= 运行时的 INSTALL_DIR）
ROOT = Path(__file__).resolve().parent.parent
MODEL_ID = engine_mod.MODEL_ID
DEFAULT_PORT = 8772
HOST = "127.0.0.1"


def _log(msg: str) -> None:
    """行式 stdout 日志（UTF-8），关键节点统一 `[asr] ` 前缀，便于上层追加进 console.log。"""
    line = f"[asr] {msg}"
    try:
        print(line, flush=True)
    except Exception:
        pass


engine_mod.set_logger(_log)
vad_mod.set_logger(_log)

# 全局唯一引擎实例 + 转写互斥（同一时刻只允许一个转写，忙时回 429 busy）
_ENGINE = engine_mod.Qwen3AsrEngine()
_BUSY = threading.Lock()
_SERVER: Optional[ThreadingHTTPServer] = None

JSON_CT = "application/json; charset=utf-8"
TEXT_CT = "text/plain; charset=utf-8"
# 上传体上限 1GB：长音频（1 小时 16k wav ≈ 115MB）也要能收下
MAX_UPLOAD_BYTES = 1024 * 1024 * 1024
MAX_JSON_BYTES = 16 * 1024 * 1024


def _json_bytes(obj: Any) -> bytes:
    return json.dumps(obj, ensure_ascii=False).encode("utf-8")


def _resolved_port() -> int:
    """端口优先级：命令行参数 > ASR_PORT > 默认 8772。"""
    if len(sys.argv) > 1:
        try:
            return int(sys.argv[1])
        except ValueError:
            pass
    try:
        v = int((os.environ.get("ASR_PORT") or "").strip() or DEFAULT_PORT)
    except ValueError:
        v = DEFAULT_PORT
    return v if 1 <= v <= 65535 else DEFAULT_PORT


def _ffmpeg_path() -> str:
    """当前生效的 ffmpeg 路径（找不回报空串）。"""
    try:
        return audio_mod.resolve_ffmpeg()
    except Exception:
        return ""


def _health_payload() -> Dict[str, Any]:
    """健康检查必须秒回：这里只报状态，绝不触发模型加载。"""
    return {
        "ok": True,
        "model": MODEL_ID,
        "device": _ENGINE.device,
        "loaded": bool(_ENGINE.loaded),
        "vad": bool(_ENGINE.vad_ready),
        "ffmpeg": _ffmpeg_path(),
        "mock": bool(_ENGINE.mock),
        "version": APP_VERSION,
    }


def _ok_payload(text: str, segments: int, duration: float, language: str, cached: bool, mock: bool) -> Dict[str, Any]:
    return {
        "text": text,
        "segments": segments,
        "duration_sec": duration,
        "model": MODEL_ID,
        "language": language,
        "cached": cached,
        "mock": mock,
    }


def _error_payload(code: str, message: str) -> Dict[str, Any]:
    return {"ok": False, "error": code, "message": message}


# ---------------- 参数解析 ----------------

def _parse_multipart(body: bytes, content_type: str) -> Tuple[Dict[str, str], List[Tuple[str, bytes]]]:
    """解析 multipart/form-data：返回 (普通字段, [(文件名, 字节)...])。

    用标准库 email 解析（比手写切分稳，能把二进制体里恰好出现 boundary 的坑避开）。
    只挑 `file` 字段的字节，其余字段当普通表单值。
    """
    header = f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("utf-8")
    msg = BytesParser(policy=_email_default).parsebytes(header + body)
    fields: Dict[str, str] = {}
    files: List[Tuple[str, bytes]] = []
    if not msg.is_multipart():
        return fields, files
    for part in msg.iter_parts():
        name = (part.get_param("name", header="content-type") or "").strip()
        filename = part.get_filename()
        payload = part.get_payload(decode=True) or b""
        if filename is not None or name == "file":
            if payload:
                files.append((filename or name or "upload.bin", payload))
            continue
        if not name:
            continue
        try:
            fields[name] = payload.decode(part.get_content_charset() or "utf-8", errors="replace").strip()
        except Exception:
            fields[name] = ""
    return fields, files


def _as_list(v: Any) -> List[str]:
    if v is None:
        return []
    if isinstance(v, str):
        return [s.strip() for s in v.replace("，", ",").replace("、", ",").split(",") if s.strip()]
    if isinstance(v, (list, tuple)):
        return [str(s).strip() for s in v if str(s).strip()]
    return [str(v).strip()]


class TranscriptionRequest:
    """一次转写请求解码后的形态：要么给本机路径，要么给上传的字节。"""

    def __init__(self) -> None:
        self.audio_path: str = ""
        self.upload_name: str = ""
        self.upload_bytes: bytes = b""
        self.hotwords: List[str] = []
        self.prompt: str = ""
        self.language: str = "auto"
        self.response_format: str = "json"

    def finish(self, fields: Dict[str, str], files: List[Tuple[str, bytes]], blob: Dict[str, Any]) -> None:
        self.upload_name = fields.get("filename") or str(blob.get("filename") or "")
        self.hotwords = _as_list(blob.get("hotwords")) or _as_list(fields.get("hotwords"))
        self.prompt = str(blob.get("prompt") or fields.get("prompt") or "")
        self.language = str(blob.get("language") or fields.get("language") or "auto").strip() or "auto"
        self.response_format = str(
            blob.get("response_format") or fields.get("response_format") or "json"
        ).strip().lower() or "json"
        if files:
            name, data = files[0]
            self.upload_bytes = data
        self.audio_path = str(blob.get("audio_path") or blob.get("path") or fields.get("audio_path") or "").strip()


class AsrHandler(BaseHTTPRequestHandler):
    server_version = "mtnode-asr/" + APP_VERSION
    protocol_version = "HTTP/1.1"

    # ---------- 基础工具 ----------

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003 - 覆盖基类
        """把 BaseHTTPRequestHandler 的默认 access log 收敛成 [asr] 行。"""
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

    # ---------- 路由 ----------

    def do_OPTIONS(self) -> None:  # noqa: N802 - 基类命名
        self._send(204, b"", "text/plain; charset=utf-8")

    def do_GET(self) -> None:  # noqa: N802
        path = (self.path or "").split("?")[0].rstrip("/") or "/"
        if path in ("/health", "/api/health"):
            self._send_json(200, _health_payload())
            return
        if path == "/v1/models":
            self._send_json(200, {"object": "list", "data": [{"id": MODEL_ID, "object": "model", "owned_by": "local"}]})
            return
        if path == "/":
            self._send_json(200, {"ok": True, "service": "mtnode-asr", "version": APP_VERSION, "model": MODEL_ID})
            return
        self._fail(404, "not_found", f"未知路径：{path}")

    def do_POST(self) -> None:  # noqa: N802
        path = (self.path or "").split("?")[0].rstrip("/") or "/"
        try:
            if path == "/v1/audio/transcriptions":
                self._handle_transcribe()
                return
            if path == "/api/shutdown":
                self._handle_shutdown()
                return
        except ValueError as e:
            self._fail(400, "bad_request", str(e))
            return
        except Exception as e:  # 兜底：任何未预期异常都转成 JSON，绝不吐 traceback
            _log("未处理异常：" + traceback.format_exc(limit=6).replace("\n", " | ")[:600])
            self._fail(500, "internal_error", f"后端内部错误：{str(e)[:300]}")
            return
        self._fail(404, "not_found", f"未知路径：{path}")

    # ---------- 转写 ----------

    def _handle_transcribe(self) -> None:
        ctype = (self.headers.get("Content-Type") or "").lower()
        req = TranscriptionRequest()
        upload_tmp = ""

        if "multipart/form-data" in ctype:
            body = self._read_body(MAX_UPLOAD_BYTES)
            if not body:
                self._fail(400, "bad_request", "multipart 请求体为空，请用 file 字段上传音频字节。")
                return
            try:
                fields, files = _parse_multipart(body, self.headers.get("Content-Type") or "")
            except Exception as e:
                self._fail(400, "bad_request", f"multipart 解析失败：{str(e)[:200]}")
                return
            req.finish(fields, files, {})
        elif "application/json" in ctype:
            raw = self._read_body(MAX_JSON_BYTES)
            try:
                blob = json.loads(raw.decode("utf-8") or "{}")
            except Exception as e:
                self._fail(400, "bad_request", f"JSON 解析失败：{str(e)[:200]}")
                return
            if not isinstance(blob, dict):
                self._fail(400, "bad_request", "JSON 请求体必须是对象。")
                return
            req.finish({}, [], blob)
        else:
            self._fail(400, "bad_request", "Content-Type 必须是 multipart/form-data 或 application/json。")
            return

        if req.upload_bytes and not req.audio_path:
            # 上传字节落成临时文件（后缀尽量保留，便于 ffmpeg 识别容器）
            suffix = Path(req.upload_name or "upload.bin").suffix or ".bin"
            upload_tmp = str(Path(os.environ.get("TEMP") or "/tmp") / f"mtnode-asr-upload-{uuid.uuid4().hex}{suffix}")
            try:
                Path(upload_tmp).write_bytes(req.upload_bytes)
            except Exception as e:
                self._fail(500, "decode_failed", f"无法保存上传音频：{str(e)[:200]}")
                return
            req.audio_path = upload_tmp

        converted = ""
        try:
            if not req.audio_path:
                self._fail(400, "audio_missing", "未提供音频：multipart 请用 file 字段上传，JSON 请给 audio_path（本机绝对路径）。")
                return
            if not Path(req.audio_path).is_file():
                self._fail(400, "audio_missing", f"音频文件不存在：{req.audio_path}")
                return

            # 按路径请求命中缓存（同一文件没改过就不重复跑模型；段数/时长也一并回填）
            cached = _ENGINE.cache_get(req.audio_path) if not req.upload_bytes else None
            if cached is not None:
                if req.response_format == "text":
                    self._send(200, str(cached.get("text") or "").encode("utf-8"), TEXT_CT)
                else:
                    self._send_json(
                        200,
                        _ok_payload(
                            str(cached.get("text") or ""),
                            int(cached.get("segments") or 0),
                            float(cached.get("duration_sec") or 0.0),
                            str(cached.get("language") or req.language),
                            True,
                            bool(_ENGINE.mock),
                        ),
                    )
                return

            # 并发保护：同一时刻只允许一个转写，忙时 429 + busy
            if not _BUSY.acquire(blocking=False):
                self._fail(429, "busy", "后端正忙（同一时刻只允许一个转写），请稍后重试。")
                return
            try:
                try:
                    converted = audio_mod.to_wav16k_mono(req.audio_path)
                except audio_mod.AudioError as e:
                    self._fail(400 if e.code == "audio_missing" else 500, e.code, e.message)
                    return
                try:
                    result = _ENGINE.transcribe(converted, req.hotwords, req.prompt, req.language)
                except engine_mod.EngineError as e:
                    # busy 之外还有：no_ffmpeg / decode_failed / model_load_failed / audio_missing
                    self._fail(500, e.code, e.message)
                    return
                except Exception as e:
                    self._fail(500, "decode_failed", f"转写失败：{str(e)[:300]}")
                    return
            finally:
                _BUSY.release()

            text = str(result.get("text") or "")
            if not req.upload_bytes:
                _ENGINE.cache_put(req.audio_path, result)
            if req.response_format == "text":
                self._send(200, text.encode("utf-8"), TEXT_CT)
                return
            self._send_json(
                200,
                _ok_payload(
                    text,
                    int(result.get("segments") or 0),
                    float(result.get("duration_sec") or 0.0),
                    str(result.get("language") or "zh"),
                    False,
                    bool(_ENGINE.mock),
                ),
            )
        finally:
            audio_mod.cleanup(converted, upload_tmp)

    # ---------- 退出 ----------

    def _handle_shutdown(self) -> None:
        self._send_json(200, {"ok": True})
        _log("收到 shutdown 请求，进程即将退出")

        def _exit_soon() -> None:
            time.sleep(0.4)
            try:
                if _SERVER is not None:
                    _SERVER.shutdown()
            except Exception:
                pass
            os._exit(0)

        threading.Thread(target=_exit_soon, daemon=True, name="asr-exit").start()


class AsrServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> None:
    global _SERVER
    port = _resolved_port()
    _log(f"启动中：http://{HOST}:{port}（install dir: {ROOT}）")
    if _ENGINE.mock:
        _log("MTNODE_ASR_MOCK=1 —— mock 模式：不加载任何模型，按音频文件名回假转写文本")
    else:
        _log(f"模型：{MODEL_ID}；模型源：{engine_mod.resolve_model_source() or '（由 modelscope/hf 缓存解析）'}")
        _log(f"ffmpeg：{_ffmpeg_path() or '未找到（wav/mp3/flac/m4a/ogg/aac 解码会报 no_ffmpeg）'}")
    try:
        _SERVER = AsrServer((HOST, port), AsrHandler)
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
            _SERVER.server_close()
        except Exception:
            pass


if __name__ == "__main__":
    main()
