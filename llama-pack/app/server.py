"""FastAPI management server + OpenAI-compatible proxy to llama-server."""
from __future__ import annotations

import asyncio
import json
import os
import secrets
import sys
import threading
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import httpx
import uvicorn
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from app import catalog, models
from app.console_banner import show_service_banner
from app.console_log import log_line
from app.gpu import query_gpu

ROOT = Path(__file__).resolve().parent.parent
API_KEY_PATH = ROOT / ".api-key"
DEFAULT_PORT = int(os.environ.get("LLAMA_API_PORT", "8765"))


# 日志落点唯一真源在 app/console_log.py（启动横幅也写它）——服务器不再自己拼 .console.log 路径。
_log = log_line

# ── 后台增量（固化表自动补新）──────────────────────────────────────────────
# 为什么要有它：固化表是「首拉整页落盘冻结 + 只按时间拿增量」，没人点刷新就永远停在
# 上一次的日期，新模型要等用户手动刷新才看得到。这里在服务启动后延迟跑一轮增量，
# 之后每 6h 一轮；失败退避 30min；距上次成功不足 10min 直接跳过（与 _STORE_MIN_INTERVAL 同闸）。
# 硬约束：与 /health 完全解耦 —— 任务里任何异常只记日志，绝不冒泡（否则整个进程起不来）。
_AUTOSYNC_INITIAL_DELAY = 15.0        # 启动后先让界面把固化表画出来，再开始联网
_AUTOSYNC_INTERVAL = 6 * 3600.0       # 稳态间隔
_AUTOSYNC_RETRY = 30 * 60.0           # 失败退避


def _autosync_enabled() -> bool:
    raw = str(os.environ.get("LLAMA_CATALOG_AUTOSYNC", "1")).strip().lower()
    return raw not in ("0", "false", "off", "no")


async def _autosync_loop() -> None:
    delay = _AUTOSYNC_INITIAL_DELAY
    while True:
        await asyncio.sleep(delay)
        delay = _AUTOSYNC_INTERVAL
        try:
            if _refresh_running():
                continue
            # 与 /api/catalog 的「10 分钟免费期」同一口径（catalog._interval_fresh）：
            # 刚核过增量就不再打镜像。
            if catalog._interval_fresh(catalog._store_load()):
                _log("catalog autosync skipped (checked <10min ago)")
                continue
            await catalog.search_models(q="")
            st = catalog.sync_state()
            if st.get("phase") == "error":
                delay = _AUTOSYNC_RETRY
                _log("catalog autosync failed: " + str(st.get("error") or ""))
            else:
                _log(
                    "catalog autosync done: added={} count={}".format(
                        int(st.get("added") or 0), int(catalog.store_info().get("count") or 0)
                    )
                )
        except asyncio.CancelledError:
            raise
        except Exception as e:  # 只记录，绝不抛出（与 /health 解耦）
            delay = _AUTOSYNC_RETRY
            _log("catalog autosync error: " + str(e))


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    # Default idle: scan local registry only, do not auto-deploy.
    try:
        models.scan_existing_models()
    except Exception as e:
        _log("scan existing failed: " + str(e))
    task: asyncio.Task | None = None
    if _autosync_enabled():
        task = asyncio.create_task(_autosync_loop(), name="catalog-autosync")
    else:
        _log("catalog autosync disabled (LLAMA_CATALOG_AUTOSYNC=0)")
    try:
        yield
    finally:
        if task is not None:
            task.cancel()


app = FastAPI(title="llama.cpp Local Manager", version="2.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


models.set_logger(_log)




def get_api_key() -> str:
    if API_KEY_PATH.exists():
        key = API_KEY_PATH.read_text(encoding="utf-8").strip()
        if key:
            return key
    key = "llama-" + secrets.token_urlsafe(24)
    API_KEY_PATH.write_text(key, encoding="utf-8")
    _log(f"generated api key {key[:12]}…")
    return key


def require_key(authorization: str | None, x_api_key: str | None = None) -> None:
    key = get_api_key()
    token = ""
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
    elif x_api_key:
        token = x_api_key.strip()
    if token != key:
        raise HTTPException(status_code=401, detail="invalid_api_key")


def _instance_for_model(model_name: str) -> dict[str, Any] | None:
    models.refresh_deployed_status()
    for inst in models.load_deployed().get("instances", []):
        if inst.get("servedName") == model_name or inst.get("modelId") == model_name:
            return inst
        mid = str(inst.get("modelId") or "")
        if mid.endswith("/" + model_name) or mid.split("/")[-1] == model_name:
            return inst
    return None


class DownloadBody(BaseModel):
    modelId: str
    kind: str = "llm"
    pipelineTag: str = ""
    ggufRepo: str = ""
    ggufFile: str = ""
    quant: str = ""


class DeployBody(BaseModel):
    modelId: str


@app.get("/api/health")
async def health():
    return {"ok": True, "ts": time.time(), "engine": "llama.cpp"}


@app.get("/api/status")
async def status():
    key = get_api_key()
    deployed = models.refresh_deployed_status()
    return {
        "ok": True,
        "apiBase": f"http://127.0.0.1:{DEFAULT_PORT}/v1",
        "manageBase": f"http://127.0.0.1:{DEFAULT_PORT}",
        "apiKey": key,
        "port": DEFAULT_PORT,
        # 本进程的脚手架根目录（MTNode 插件用它认出「端口上跑的是不是我自己配置的那一份」：
        # 不一致时不静默复用，插件卡片会出告警让用户选，见 llama/main-llama.js 的 llamaRootState）
        "installRoot": str(ROOT),
        "deployed": deployed,
        "deployedModels": models.deployed_model_names(),
        "downloads": models.list_downloads(),
        "gpu": query_gpu(),
        "allocatedVramGb": models._allocated_vram_gb(),
        "engine": "llama.cpp",
    }


@app.get("/api/gpu")
async def gpu_info():
    return {"ok": True, "gpu": query_gpu(), "allocatedVramGb": models._allocated_vram_gb()}


def _frozen_catalog(
    q: str,
    kind: str,
    limit: int,
    sort: str,
    size_band: str,
    recent_only: bool,
) -> list[dict[str, Any]]:
    """只读固化表（零网络请求）：过滤 / 排序口径与 catalog.search_models 收尾那段一致。

    为什么单独写这一段：菜单默认必须「无网秒回、离线可用」—— 原路径即便走固化口径
    也会顺手问一次增量（页面挂住几秒到几十秒）。想让后台去补新，走 /api/catalog/refresh，
    别让一次列表请求去碰网络。
    """
    items = catalog._store_frozen_items(kind)
    query = (q or "").strip().lower()
    if query:
        items = [
            x
            for x in items
            if query in str(x.get("id") or "").lower() or query in str(x.get("name") or "").lower()
        ]
    items = catalog._filter_size(items, size_band)
    items = catalog._filter_recent(items, recent_only)
    if sort == "likes":
        items.sort(key=lambda x: int(x.get("likes") or 0), reverse=True)
    else:
        items.sort(key=lambda x: int(x.get("downloads") or 0), reverse=True)
    if not query:
        curated_ids = {x["id"] for x in catalog.CURATED}
        head = [x for x in items if x["id"] in curated_ids]
        tail = [x for x in items if x["id"] not in curated_ids]
        items = head + tail
    limit = max(1, min(int(limit or 50), 100))
    return items[:limit]


@app.get("/api/catalog")
async def model_catalog(
    q: str = "",
    kind: str = "all",
    limit: int = 50,
    sort: str = "downloads",
    sizeBand: str = "",
    recentOnly: bool = False,
    force: bool = False,
    refresh: bool = False,
):
    # 在线模型列表是固化口径（见 app/catalog.py 的 CACHE_PATH）：首拉整页落盘冻结，
    # 之后只按时间拿增量。force=true 才整页重拉（界面不暴露，需要时手工带这个参数）。
    # 默认 refresh=false：只读固化表，一个网络请求都不发（无网秒回、离线可用）；
    # refresh=true 才走原来那条同步路径（拉列表 + 补体积 + 探架构），旧行为原样保留。
    if refresh or force:
        items = await catalog.search_models(q, kind, limit, sort, sizeBand, recentOnly, force)
    else:
        items = _frozen_catalog(q, kind, limit, sort, sizeBand, recentOnly)
    return {
        "ok": True,
        "items": items,
        "mirror": catalog.HF_MIRROR,
        "kinds": list(catalog._CATALOG_KINDS),
        "cache": catalog.store_info(),
    }


@app.get("/api/catalog/sync")
async def catalog_sync():
    """这一轮拉取走到哪一步（界面轮询它画状态条：阶段 / 已用时间 / 已探数量 / 错误）。"""
    st = catalog.sync_state()
    return {
        "phase": str(st.get("phase") or "idle"),
        "elapsedMs": int(st.get("elapsedMs") or 0),
        "page": int(st.get("page") or 0),
        "candTotal": int(st.get("candTotal") or 0),
        "probedSizes": int(st.get("probedSizes") or 0),
        "probedArch": int(st.get("probedArch") or 0),
        "added": int(st.get("added") or 0),
        "error": str(st.get("error") or ""),
        "cache": catalog.store_info(),
    }


# 单飞：一轮刷新在跑时再点刷新只回 running=true，不排队、不叠加。
_REFRESH_TASK: asyncio.Task | None = None


def _refresh_running() -> bool:
    if _REFRESH_TASK is not None and not _REFRESH_TASK.done():
        return True
    return bool(catalog.sync_state().get("running"))


async def _refresh_once() -> None:
    try:
        await catalog.search_models(q="")
    except Exception as e:
        _log("catalog refresh failed: " + str(e))


@app.post("/api/catalog/refresh")
async def catalog_refresh():
    """起一轮增量（后台跑，立刻返回）。

    绝不 await 在这里：search_models 要联网几十秒，同步等会把单进程 uvicorn 的事件循环
    占死（同类教训见 download 里的 to_thread 注释），界面轮询 /api/catalog/sync 拿不到进度。
    """
    global _REFRESH_TASK
    if _refresh_running():
        return {"ok": True, "running": True}
    _REFRESH_TASK = asyncio.create_task(_refresh_once(), name="catalog-refresh")
    return {"ok": True, "running": False}


@app.get("/api/catalog/detail")
async def catalog_detail(modelId: str = ""):
    if not modelId.strip():
        raise HTTPException(status_code=400, detail="modelId_required")
    detail = await catalog.model_detail(modelId.strip())
    return {"ok": True, "detail": detail}


@app.get("/api/models")
async def local_models():
    return {"ok": True, "items": models.list_local_models()}


@app.get("/api/downloads")
async def downloads():
    return {"ok": True, "items": models.list_downloads()}


@app.post("/api/models/download")
async def download(body: DownloadBody, authorization: str | None = Header(None)):
    require_key(authorization)
    try:
        # 下载必须离开事件循环：models.download_model 是**全同步**的（内部 hf_hub_download
        # 阻塞几分钟到几十分钟），直接 await 会把单进程 uvicorn 的循环占死 ——
        # 于是 /api/downloads 与 /api/status 在下载期间连不上、界面进度永远停在 0%
        # （真机复现：27B 下到 14.9GB 时本机 8765 端口完全无响应）。to_thread 之后
        # 下载期间接口照常应答，进度轮询才拿得到数（Python 3.10+ 内置）。
        info = await asyncio.to_thread(
            models.download_model,
            body.modelId,
            body.kind,
            body.pipelineTag,
            gguf_repo=body.ggufRepo,
            gguf_file=body.ggufFile,
            quant=body.quant,
        )
        if info.get("ok") is False:
            raise HTTPException(status_code=400, detail=str(info.get("error") or "download_failed"))
        return {"ok": True, "model": info}
    except HTTPException:
        raise
    except Exception as e:
        _log(f"download error {body.modelId}: {e}")
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.post("/api/models/deploy")
async def deploy(body: DeployBody, authorization: str | None = Header(None)):
    require_key(authorization)
    # deploy_model 会同步扫架构 / 起子进程 / 落盘（秒级），同样别占着事件循环。
    result = await asyncio.to_thread(models.deploy_model, body.modelId, get_api_key())
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error", "deploy_failed"))
    return result


@app.post("/api/models/restore")
async def restore_wanted(authorization: str | None = Header(None)):
    require_key(authorization)
    # 恢复要逐个部署（每个都要起进程），同步跑会把界面卡到「恢复」整段结束。
    return await asyncio.to_thread(models.restore_wanted_deploys, get_api_key())


@app.post("/api/models/stop")
async def stop(body: DeployBody, authorization: str | None = Header(None)):
    require_key(authorization)
    # stop_model 里有 taskkill（同步等待），挪出循环免得「停止」期间界面假死。
    return await asyncio.to_thread(models.stop_model, body.modelId)


@app.delete("/api/models/{model_id:path}")
async def delete_model(model_id: str, authorization: str | None = Header(None)):
    require_key(authorization)
    # delete_model = 停引擎 + shutil.rmtree（几十 GB 的目录，同步删要好几秒）。
    return await asyncio.to_thread(models.delete_model, model_id)


@app.post("/api/shutdown")
async def shutdown(authorization: str | None = Header(None)):
    require_key(authorization)
    models.stop_all(clear_want=True)
    _log("shutdown requested — exiting manager")

    def _exit_soon() -> None:
        time.sleep(0.4)
        os._exit(0)

    threading.Thread(target=_exit_soon, daemon=True, name="llama-exit").start()
    return {"ok": True}




@app.get("/v1/models")
async def openai_models(authorization: str | None = Header(None)):
    require_key(authorization)
    names = models.deployed_model_names()
    data = [{"id": n, "object": "model"} for n in names]
    return {"object": "list", "data": data}


@app.api_route("/v1/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
async def proxy_v1(path: str, request: Request, authorization: str | None = Header(None)):
    require_key(authorization)
    body = await request.body()
    model_name = ""
    if body:
        try:
            payload = json.loads(body)
            model_name = str(payload.get("model") or "")
        except Exception:
            pass
    inst = _instance_for_model(model_name) if model_name else None
    if not inst:
        running = [i for i in models.load_deployed().get("instances", []) if i.get("status") == "running"]
        inst = running[0] if len(running) == 1 else None
    if not inst:
        raise HTTPException(status_code=503, detail="no_running_model")
    port = int(inst.get("port") or 0)
    if not port:
        raise HTTPException(status_code=503, detail="engine_not_ready")
    url = f"http://127.0.0.1:{port}/v1/{path}"
    headers = {k: v for k, v in request.headers.items() if k.lower() not in ("host", "content-length")}
    try:
        async with httpx.AsyncClient(timeout=600.0) as client:
            resp = await client.request(
                request.method,
                url,
                content=body,
                headers=headers,
            )
    except httpx.ConnectError as e:
        raise HTTPException(status_code=502, detail="engine_unreachable") from e
    if "text/event-stream" in resp.headers.get("content-type", ""):
        async def stream():
            async for chunk in resp.aiter_bytes():
                yield chunk

        return StreamingResponse(stream(), media_type="text/event-stream")
    return JSONResponse(content=resp.json() if resp.content else {}, status_code=resp.status_code)


def main() -> None:
    port = DEFAULT_PORT
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            pass
    _log(f"starting manager on :{port}")
    show_service_banner(port)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning", loop="asyncio")


if __name__ == "__main__":
    main()
