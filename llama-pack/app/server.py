"""FastAPI management server + OpenAI-compatible proxy to llama-server."""
from __future__ import annotations

import json
import os
import secrets
import sys
import threading
import time
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
from app.gpu import query_gpu

ROOT = Path(__file__).resolve().parent.parent
API_KEY_PATH = ROOT / ".api-key"
DEFAULT_PORT = int(os.environ.get("LLAMA_API_PORT", "8765"))

app = FastAPI(title="llama.cpp Local Manager", version="2.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _log(msg: str) -> None:
    line = f"[{time.strftime('%H:%M:%S')}] {msg}\n"
    log_path = ROOT / ".console.log"
    try:
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception:
        pass


models.set_logger(_log)


@app.on_event("startup")
def _on_startup() -> None:
    # Default idle: scan local registry only, do not auto-deploy.
    try:
        models.scan_existing_models()
    except Exception as e:
        _log("scan existing failed: " + str(e))




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


@app.get("/api/catalog")
async def model_catalog(
    q: str = "",
    kind: str = "all",
    limit: int = 50,
    sort: str = "downloads",
    sizeBand: str = "",
    recentOnly: bool = False,
):
    items = await catalog.search_models(q, kind, limit, sort, sizeBand, recentOnly)
    return {"ok": True, "items": items, "mirror": catalog.HF_MIRROR}


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
        info = models.download_model(
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
    result = models.deploy_model(body.modelId, get_api_key())
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error", "deploy_failed"))
    return result


@app.post("/api/models/restore")
async def restore_wanted(authorization: str | None = Header(None)):
    require_key(authorization)
    return models.restore_wanted_deploys(get_api_key())


@app.post("/api/models/stop")
async def stop(body: DeployBody, authorization: str | None = Header(None)):
    require_key(authorization)
    return models.stop_model(body.modelId)


@app.delete("/api/models/{model_id:path}")
async def delete_model(model_id: str, authorization: str | None = Header(None)):
    require_key(authorization)
    return models.delete_model(model_id)


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
