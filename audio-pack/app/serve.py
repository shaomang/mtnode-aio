"""HTTP 壳：ThreadingHTTPServer + 路由表 + 鉴权 + body 上限 + 单并发 + 同 key single-flight。

契约口径（service-contract）：

| 方法 | 路径 | 鉴权 | 上限 |
|---|---|---|---|
| GET  | `/` | 免 | 1 s |
| GET  | `/health` | 免 | 1 s |
| POST | `/analyze` | 需要 | 300 s / 64 KiB body |
| GET  | `/artifact/<key16>/<kind>.png` | 需要 | 10 s / 8 MB |
| POST | `/shutdown` | 需要 | 5 s |

* **只绑 127.0.0.1**（没有 --host 开关，绑回环是硬约束）；
* 路由用**整体匹配**的正则：`/artifact/../x` 这类拼接进不来；artifact 另做 realpath 归属校验；
* 分析单并发（`threading.Semaphore(1)`）：占满 → 429 `E_BUSY` + `Retry-After: 5`；
  `/health`、`/artifact` 不占这个坑（否则探活会被一次长分析拖成超时）；
* 同 key single-flight：并发同素材不排队等信号量，而是挂在第一个请求的 Event 上；
* 300 s 预算超时 → 504 `E_TIMEOUT`，**分析线程不中断**，跑完照常写缓存；
* 连接数 16，超出直接关连接（不排队）；
* 协议层错误（404 / 405 / 400 JSON 解析失败 / 413 body 超限）回**纯文本**，不套 JSON 契约。

全部注释与消息为中文。
"""

from __future__ import annotations

import json
import os
import re
import secrets
import socket
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from . import analysis
from . import contract
from .cache import Cache
from .decode import ffmpeg_version, find_ffmpeg
from .contract import AnalyzeError

#: 路由表：方法 + 整体匹配正则 + 处理名（顺序即 Allow 头的顺序）
ROUTES = (
    ("GET", re.compile(r"/"), "index"),
    ("GET", re.compile(r"/health"), "health"),
    ("POST", re.compile(r"/analyze"), "analyze"),
    ("GET", re.compile(r"/artifact/([0-9a-f]{16})/(spectrogram|waveform|beatOverlay|energyCurve)\.png"), "artifact"),
    ("POST", re.compile(r"/shutdown"), "shutdown"),
)


def log(message: str) -> None:
    """所有日志行：前缀 `[audio] `，UTF-8，逐行 flush。"""
    try:
        sys.stdout.write("[audio] " + str(message) + "\n")
        sys.stdout.flush()
    except Exception:
        pass


# ---------------------------------------------------------------- API Key


def key_file(root: str) -> str:
    return os.path.join(root, "api-key.txt")


def ensure_api_key(root: str) -> str:
    """首次启动生成 32 位 hex 写进 api-key.txt；已存在则复用。"""
    path = key_file(root)
    try:
        with open(path, "r", encoding="utf-8") as fh:
            existing = fh.read().strip()
        if existing:
            return existing
    except OSError:
        pass
    key = secrets.token_hex(16)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(key)
        fh.flush()
        os.fsync(fh.fileno())
    return key


def mask_key(key: str) -> str:
    """日志里只打前 4 后 4 位。"""
    if not key:
        return "(空)"
    if len(key) <= 8:
        return key[:2] + "…"
    return key[:4] + "…" + key[-4:]


# ---------------------------------------------------------------- 服务对象


class Service:
    """进程内共享状态：缓存、并发闸、single-flight 表、启动时间。"""

    def __init__(self, root: str, ffmpeg: str | None, auth_enabled: bool, api_key: str):
        self.root = os.path.abspath(root)
        self.artifacts_dir = os.path.join(self.root, "artifacts")
        self.cache = Cache(self.root)
        self.ffmpeg = ffmpeg
        self.ffmpeg_version = ffmpeg_version(ffmpeg) if ffmpeg else ""
        self.auth_enabled = bool(auth_enabled)
        self.api_key = api_key
        self.started_at = time.time()
        self.started_iso = contract_iso_now()
        self.semaphore = threading.Semaphore(1)
        self.flight: dict[str, dict] = {}
        self.flight_lock = threading.Lock()
        self.stop_event = threading.Event()

    # —— /health 用的便宜指标（不 spawn、不扫盘）
    def busy(self) -> bool:
        # Semaphore 没有公开的「是否被占」，用 _value 只在探活时读一下（不修改）
        return getattr(self.semaphore, "_value", 1) <= 0

    def health(self) -> dict:
        entries, nbytes = self.cache.counts()
        ffmpeg = self.ffmpeg or ""
        return {
            "ok": True,
            "name": contract.SERVICE_NAME,
            "version": contract.VERSION,
            "contractVersion": contract.VERSION,
            "pid": os.getpid(),
            "startedAt": self.started_iso,
            "uptimeSec": round(time.time() - self.started_at, 1),
            "auth": "key" if self.auth_enabled else "off",
            "busy": self.busy(),
            "concurrency": 1,
            "limits": {
                "maxDurationSec": contract.MAX_DURATION_SEC,
                "maxSourceBytes": contract.MAX_SOURCE_BYTES,
                "analyzeBudgetSec": contract.ANALYZE_BUDGET_SEC,
                "downsampleOverSec": contract.DOWNSAMPLE_OVER_SEC,
                "requestBodyBytes": contract.REQUEST_BODY_BYTES,
            },
            "decoder": {
                "ffmpeg": ffmpeg,
                "version": self.ffmpeg_version,
                "found": bool(ffmpeg and os.path.isfile(ffmpeg)),
            },
            "cache": {
                "dir": self.cache.cache_dir,
                "entries": entries,
                "bytes": nbytes,
                "maxBytes": contract.CACHE_MAX_BYTES,
            },
            "artifacts": {"dir": self.artifacts_dir, "count": self.cache.artifact_count()},
        }


def contract_iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# ---------------------------------------------------------------- HTTP 服务器


class AudioHTTPServer(ThreadingHTTPServer):
    """带连接数上限的 ThreadingHTTPServer（daemon 线程，退出不挂）。"""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, addr, handler, service: Service):
        self.service = service
        self._conn_lock = threading.Lock()
        self._conns = 0
        super().__init__(addr, handler)

    def process_request(self, request, client_address):
        with self._conn_lock:
            if self._conns >= contract.CONNECTION_LIMIT:
                over = True
            else:
                self._conns += 1
                over = False
        if over:
            # 连接数超限：直接关（不排队），符合契约「避免半开连接堆积」
            try:
                request.close()
            except Exception:
                pass
            return
        super().process_request(request, client_address)

    def shutdown_request(self, request):
        with self._conn_lock:
            self._conns = max(0, self._conns - 1)
        super().shutdown_request(request)


class Handler(BaseHTTPRequestHandler):
    server_version = "MTNodeAudio/" + contract.VERSION
    protocol_version = "HTTP/1.1"

    # —— 关掉默认的 stderr 访问日志（我们自己按契约格式打）
    def log_message(self, fmt, *args):  # noqa: A003
        return

    # —— 方法入口
    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def do_HEAD(self):
        self._dispatch("HEAD")

    def do_OPTIONS(self):
        self._dispatch("OPTIONS")

    # ------------------------------------------------------------ 路由

    def _dispatch(self, method: str) -> None:
        svc: Service = self.server.service  # type: ignore[attr-defined]
        path = urlsplit(self.path).path
        allowed = [m for m, rx, _name in ROUTES if rx.fullmatch(path)]
        route = None
        for m, rx, name in ROUTES:
            if m == method and rx.fullmatch(path):
                route = (name, rx.fullmatch(path))
                break
        if not allowed:
            self._send_text(404, "找不到该路由：%s" % path)
            return
        if route is None:
            self._send_text(405, "方法不允许：%s %s" % (method, path),
                            {"Allow": ", ".join(allowed)})
            return
        name, match = route
        if name in ("analyze", "artifact", "shutdown") and not self._authorized(svc):
            self._send_json(401, {
                "ok": False,
                "contract": contract.contract_block(contract.GRID_FULL),
                "error": {
                    "code": "E_UNAUTHORIZED",
                    "message": contract.ERRORS["E_UNAUTHORIZED"][1],
                    "detail": "请带 Authorization: Bearer <key> 或 X-Api-Key: <key>（key 在 <数据目录>\\audio-analysis\\api-key.txt）",
                },
            })
            log('error code=E_UNAUTHORIZED path="%s" method=%s' % (path, method))
            return
        try:
            if name == "index":
                self._send_json(200, {
                    "ok": True,
                    "name": contract.SERVICE_NAME,
                    "version": contract.VERSION,
                    "contractVersion": contract.VERSION,
                    "endpoints": [
                        "GET /health", "POST /analyze",
                        "GET /artifact/<key16>/<kind>.png", "POST /shutdown",
                    ],
                    "hint": "POST /analyze 要带 Authorization: Bearer <api-key.txt>；"
                            "响应体字段说明见 diagnostics.fieldGuide。",
                })
            elif name == "health":
                self._send_json(200, svc.health())
            elif name == "analyze":
                self._analyze(svc)
            elif name == "artifact":
                self._artifact(svc, match.group(1), match.group(2))
            elif name == "shutdown":
                self._send_json(200, {"ok": True, "message": "正在退出", "pid": os.getpid()})
                log("shutdown requested pid=%d" % os.getpid())
                threading.Timer(0.05, svc.stop_event.set).start()
                threading.Thread(target=self.server.shutdown, daemon=True).start()
        except AnalyzeError as exc:
            log('error code=%s path="%s" detail="%s"' % (exc.code, path, exc.detail.replace("\n", " ")))
            self._send_json(exc.http, self._error_body(exc))
        except Exception as exc:  # 兜底：绝不让 handler 抛出去
            tb = traceback.format_exc()
            log("error code=E_INTERNAL path=\"%s\"\n%s" % (path, tb))
            err = AnalyzeError("E_INTERNAL", "后端内部错误：%s" % type(exc).__name__,
                               analysis.traceback_tail(exc, 3))
            self._send_json(500, self._error_body(err))

    def _authorized(self, svc: Service) -> bool:
        if not svc.auth_enabled:
            return True
        token = ""
        auth = self.headers.get("Authorization") or ""
        if auth.lower().startswith("bearer "):
            token = auth[7:].strip()
        if not token:
            token = (self.headers.get("X-Api-Key") or "").strip()
        if not token or not svc.api_key:
            return False
        return secrets.compare_digest(token, svc.api_key)

    # ------------------------------------------------------------ /analyze

    def _analyze(self, svc: Service) -> None:
        t_start = time.perf_counter()
        raw = self._read_body()
        if raw is None:
            return
        try:
            payload = json.loads(raw.decode("utf-8", "replace") or "{}")
        except Exception:
            self._send_text(400, "请求体不是合法 JSON")
            return
        if not isinstance(payload, dict):
            self._send_text(400, "请求体必须是 JSON 对象")
            return
        audio_path = payload.get("audioPath") or payload.get("path")
        options = payload.get("options")
        ctx = analysis.prepare(audio_path, options, svc.cache)   # 失败抛 AnalyzeError → 400/413

        key = ctx["key"]
        # —— 同 key single-flight：挂第一个请求的 Event，不再抢信号量
        with svc.flight_lock:
            slot = svc.flight.get(key)
            owner = slot is None
            if owner:
                slot = {"event": threading.Event(), "body": None, "error": None}
                svc.flight[key] = slot
        deadline = t_start + contract.ANALYZE_BUDGET_SEC
        if not owner:
            remainder = max(0.1, deadline - time.perf_counter())
            got = slot["event"].wait(timeout=remainder)
            if not got:
                err = AnalyzeError("E_TIMEOUT", "等待同素材分析超时",
                                   "该素材的分析仍在进行（single-flight），已等待 %.0f 秒"
                                   % contract.ANALYZE_BUDGET_SEC)
                self._send_json(504, self._error_body(err))
                return
            if slot["error"] is not None:
                self._send_json(slot["error"].http, self._error_body(slot["error"]))
                return
            body = slot["body"]
            if body is None:
                err = AnalyzeError("E_INTERNAL", "同素材分析未产出结果", "single-flight 槽为空")
                self._send_json(500, self._error_body(err))
                return
            self._respond_body(body, t_start, shared=True)
            return

        # —— 占并发闸（非阻塞：占满就 429，不排队）
        if not svc.semaphore.acquire(blocking=False):
            with svc.flight_lock:
                svc.flight.pop(key, None)
            slot["event"].set()
            err = AnalyzeError("E_BUSY", "后端忙：已有分析在跑（单并发）",
                               "队列长度 1（同一时刻只允许一份分析）")
            self._send_json(429, self._error_body(err), {"Retry-After": "5"})
            log('busy path="%s"' % ctx["path"])
            return

        def worker() -> None:
            """分析线程：即使请求侧超时也继续跑完（写缓存），下次同素材直接命中。"""
            try:
                body = analysis.run(ctx, svc.cache, svc.ffmpeg)
                slot["body"] = body
            except AnalyzeError as exc:
                slot["error"] = exc
                log('error code=%s path="%s" detail="%s"'
                    % (exc.code, ctx["path"], (exc.detail or "").replace("\n", " ")))
            except BaseException as exc:  # noqa: BLE001
                tb = traceback.format_exc()
                log("error code=E_INTERNAL path=\"%s\"\n%s" % (ctx["path"], tb))
                slot["error"] = AnalyzeError("E_INTERNAL", "分析失败：%s" % type(exc).__name__,
                                             analysis.traceback_tail(exc, 3))
            finally:
                svc.semaphore.release()
                with svc.flight_lock:
                    svc.flight.pop(key, None)
                slot["event"].set()

        threading.Thread(target=worker, daemon=True, name="analyze-%s" % key[:8]).start()
        remainder = max(0.1, deadline - time.perf_counter())
        if not slot["event"].wait(timeout=remainder):
            err = AnalyzeError(
                "E_TIMEOUT", "超过分析预算",
                "已耗时 %.0f 秒（上限 %d 秒），分析线程继续跑完并写缓存，重试一次多半命中缓存"
                % (contract.ANALYZE_BUDGET_SEC, contract.ANALYZE_BUDGET_SEC))
            self._send_json(504, self._error_body(err))
            log('timeout path="%s" ms=%.0f' % (ctx["path"], contract.ANALYZE_BUDGET_SEC * 1000.0))
            return
        if slot["error"] is not None:
            err = slot["error"]
            self._send_json(err.http, self._error_body(err))
            log('error code=%s path="%s" detail="%s"'
                % (err.code, ctx["path"], (err.detail or "").replace("\n", " ")))
            return
        self._respond_body(slot["body"], t_start)

    def _respond_body(self, body: dict, t_start: float, shared: bool = False) -> None:
        """成功响应：X-Cache / X-Analysis-Ms + 契约日志行。"""
        diag = body.get("diagnostics") or {}
        cache_info = diag.get("cache") or {}
        ms = int((time.perf_counter() - t_start) * 1000.0)
        total_ms = int((diag.get("timingsMs") or {}).get("total") or 0)
        self._send_json(200, body, {
            "X-Cache": "hit" if cache_info.get("hit") else "miss",
            "X-Analysis-Ms": str(total_ms if cache_info.get("hit") else ms),
        })
        log('analyze path="%s" dur=%.1f cache=%s ms=%d beats=%d onsets=%d sections=%d warnings=%d status=200%s'
            % (body.get("meta", {}).get("source", {}).get("path", ""),
               float(body.get("meta", {}).get("durationSec") or 0.0),
               "hit" if cache_info.get("hit") else "miss",
               total_ms if cache_info.get("hit") else ms,
               int(body.get("beatGrid", {}).get("beatCount") or 0),
               int(body.get("onsets", {}).get("count") or 0),
               len(body.get("sections") or []),
               len(diag.get("warnings") or []),
               " shared=1" if shared else ""))

    # ------------------------------------------------------------ 请求体

    def _read_body(self) -> bytes | None:
        """"读请求体；超限回 413（纯文本）并返回 None。

        两处都卡：先看 Content-Length，再边读边数（防 chunked / 撒谎的长度）。
        """
        length_text = self.headers.get("Content-Length")
        if length_text is None:
            return b""
        try:
            length = int(length_text)
        except Exception:
            self._send_text(400, "Content-Length 不是整数")
            return None
        if length < 0:
            self._send_text(400, "Content-Length 非法")
            return None
        if length > contract.REQUEST_BODY_BYTES:
            self._send_text(413, "请求体超过 %d 字节上限" % contract.REQUEST_BODY_BYTES)
            return None
        chunks = []
        read_total = 0
        try:
            self.connection.settimeout(10.0)      # 读超时 10 s（半开连接不留）
            while read_total < length:
                block = self.rfile.read(min(65536, length - read_total))
                if not block:
                    break
                chunks.append(block)
                read_total += len(block)
                if read_total > contract.REQUEST_BODY_BYTES:
                    self._send_text(413, "请求体超过 %d 字节上限" % contract.REQUEST_BODY_BYTES)
                    return None
        except (socket.timeout, TimeoutError):
            self._send_text(408, "读取请求体超时")
            return None
        except Exception:
            self._send_text(400, "读取请求体失败")
            return None
        return b"".join(chunks)

    # ------------------------------------------------------------ /artifact

    def _artifact(self, svc: Service, key16: str, kind: str) -> None:
        name = "%s/%s.png" % (key16, kind)
        base = os.path.realpath(svc.artifacts_dir)
        path = os.path.realpath(os.path.join(base, key16, "%s.png" % kind))
        if not path.startswith(base + os.sep) or not os.path.isfile(path):
            self._send_text(404, "没有这张图：%s" % name)
            return
        try:
            size = os.path.getsize(path)
            mtime_ms = int(os.path.getmtime(path) * 1000)
        except OSError:
            self._send_text(404, "没有这张图：%s" % name)
            return
        if size > contract.ARTIFACT_MAX_BYTES:
            self._send_text(404, "图超过 %d 字节上限" % contract.ARTIFACT_MAX_BYTES)
            return
        etag = '"%s-%d"' % (name.replace("/", "-"), mtime_ms)
        headers = {"ETag": etag, "Cache-Control": "no-store"}
        if (self.headers.get("If-None-Match") or "").strip() == etag:
            self.send_response(304)
            for k, v in headers.items():
                self.send_header(k, v)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        try:
            with open(path, "rb") as fh:
                data = fh.read()
        except OSError:
            self._send_text(404, "读取图片失败：%s" % name)
            return
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(data)))
        for k, v in headers.items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(data)
        except Exception:
            pass

    # ------------------------------------------------------------ 响应工具

    def _error_body(self, err: AnalyzeError) -> dict:
        return {
            "ok": False,
            "contract": contract.contract_block(contract.GRID_FULL),
            "error": err.to_error_block(),
        }

    def _send_json(self, status: int, obj: dict, extra: dict | None = None) -> None:
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Contract-Version", contract.VERSION)
        for k, v in (extra or {}).items():
            self.send_header(k, str(v))
        if self._needs_close(status):
            self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(data)
            except Exception:
                pass

    def _send_text(self, status: int, text: str, extra: dict | None = None) -> None:
        data = str(text).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        for k, v in (extra or {}).items():
            self.send_header(k, str(v))
        if self._needs_close(status):
            self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(data)
            except Exception:
                pass

    def _needs_close(self, status: int) -> bool:
        """错误响应可能发生在我们读请求体之前（401 / 404 / 405 / 413 早退）。

        HTTP/1.1 是 keep-alive：不把残余的请求体读掉、又不关连接，下一轮
        `handle_one_request` 会把这段 JSON 当成请求行，回一份 http.server 自带的
        **HTML** 400 —— 客户端（宿主 / Node http）拿到的是 HTML 而不是契约里的 JSON。
        所以错误且方法带体时一律「回完就关」；成功响应路径都读过体，不受影响。
        """
        if status < 400:
            return False
        return self.command in ("POST", "PUT", "PATCH", "DELETE")


# ---------------------------------------------------------------- 启动


def resolve_port(explicit: int | None) -> int:
    """优先级：--port > 环境变量 MT_AUDIO_PORT > 8774。"""
    if explicit:
        return int(explicit)
    env = os.environ.get("MT_AUDIO_PORT")
    if env:
        try:
            return int(env)
        except Exception:
            pass
    return 8774


def create_server(service: Service, port: int) -> AudioHTTPServer:
    """只绑 127.0.0.1；端口被占则在 8774-8783 里顺序顺延（port=0 → 交给系统挑）。"""
    if port == 0:
        return AudioHTTPServer(("127.0.0.1", 0), Handler, service)
    candidates = [port] + [p for p in range(8774, 8784) if p != port]
    last: Exception | None = None
    for p in candidates:
        try:
            return AudioHTTPServer(("127.0.0.1", p), Handler, service)
        except OSError as exc:
            last = exc
            continue
    raise last or OSError("没有可用端口")


def main(port: int | None = None, ffmpeg: str | None = None, no_auth: bool = False,
         root: str | None = None) -> int:
    """启动服务：建服务对象 → 绑端口 → 打印就绪行 → serve_forever。"""
    root = os.path.abspath(root or analysis._default_root())
    os.makedirs(root, exist_ok=True)
    api_key = ensure_api_key(root)
    resolved_ffmpeg = find_ffmpeg(ffmpeg or os.environ.get("MT_AUDIO_FFMPEG"))
    auth_enabled = not no_auth
    service = Service(root, resolved_ffmpeg, auth_enabled, api_key)
    server = create_server(service, resolve_port(port))
    actual_port = int(server.server_address[1])

    log("dir=%s auth=%s key=%s" % (root, "key" if auth_enabled else "off", mask_key(api_key)))
    if resolved_ffmpeg:
        log("decoder ffmpeg=%s version=%s"
            % (resolved_ffmpeg, service.ffmpeg_version or "unknown"))
    else:
        log("decoder ffmpeg=NOT-FOUND（服务照起，/analyze 会回 E_INTERNAL；去插件里装 Remotion 或用 --ffmpeg 指定）")
    # 就绪行：宿主按这一行判定就绪，再补一次 /health 探活
    log("ready port=%d pid=%d" % (actual_port, os.getpid()))

    def _sigterm(_signum, _frame):
        log("signal received，准备退出")
        service.stop_event.set()
        threading.Thread(target=server.shutdown, daemon=True).start()

    for name in ("SIGTERM", "SIGBREAK"):
        try:
            import signal
            signal.signal(getattr(signal, name), _sigterm)
        except Exception:
            pass

    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        try:
            server.server_close()
        except Exception:
            pass
        try:
            service.cache.close()
        except Exception:
            pass
        log("bye")
    return 0
