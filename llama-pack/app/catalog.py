"""HF catalog helpers for GGUF models (online search via hf-mirror)."""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

HF_MIRROR = os.environ.get("HF_ENDPOINT", "https://hf-mirror.com").rstrip("/")
HF_API = f"{HF_MIRROR}/api"

# Curated boost list (shown first when matching)
CURATED: list[dict[str, Any]] = [
    {
        "id": "google/gemma-4-E4B-it",
        "name": "google/gemma-4-E4B-it",
        "kind": "llm",
        "pipelineTag": "text-generation",
        "sizeGb": 8.2,
        "quant": "Q8_0",
        "ggufRepo": "unsloth/gemma-4-E4B-it-GGUF",
        "downloads": 1000,
        "likes": 50,
        "createdAt": "2026-04-01",
    },
    {
        "id": "google/gemma-4-E2B-it",
        "name": "google/gemma-4-E2B-it",
        "kind": "llm",
        "pipelineTag": "text-generation",
        "sizeGb": 5.7,
        "quant": "Q8_0",
        "ggufRepo": "unsloth/gemma-4-E2B-it-GGUF",
        "downloads": 800,
        "likes": 40,
        "createdAt": "2026-04-01",
    },
    {
        "id": "Qwen/Qwen2.5-7B-Instruct",
        "name": "Qwen/Qwen2.5-7B-Instruct",
        "kind": "llm",
        "pipelineTag": "text-generation",
        "sizeGb": 4.5,
        "quant": "Q4_K_M",
        "ggufRepo": "bartowski/Qwen2.5-7B-Instruct-GGUF",
        "downloads": 50000,
        "likes": 200,
        "createdAt": "2024-09-01",
    },
    {
        "id": "Qwen/Qwen2.5-3B-Instruct",
        "name": "Qwen/Qwen2.5-3B-Instruct",
        "kind": "llm",
        "pipelineTag": "text-generation",
        "sizeGb": 2.0,
        "quant": "Q4_K_M",
        "ggufRepo": "bartowski/Qwen2.5-3B-Instruct-GGUF",
        "downloads": 30000,
        "likes": 120,
        "createdAt": "2024-09-01",
    },
    {
        "id": "Qwen/Qwen2.5-1.5B-Instruct",
        "name": "Qwen/Qwen2.5-1.5B-Instruct",
        "kind": "llm",
        "pipelineTag": "text-generation",
        "sizeGb": 1.1,
        "quant": "Q4_K_M",
        "ggufRepo": "bartowski/Qwen2.5-1.5B-Instruct-GGUF",
        "downloads": 20000,
        "likes": 80,
        "createdAt": "2024-09-01",
    },
    {
        "id": "microsoft/Phi-4-mini-instruct",
        "name": "microsoft/Phi-4-mini-instruct",
        "kind": "llm",
        "pipelineTag": "text-generation",
        "sizeGb": 2.5,
        "quant": "Q4_K_M",
        "ggufRepo": "bartowski/Phi-4-mini-instruct-GGUF",
        "downloads": 15000,
        "likes": 90,
        "createdAt": "2025-01-01",
    },
    {
        "id": "BAAI/bge-m3",
        "name": "BAAI/bge-m3",
        "kind": "embedding",
        "pipelineTag": "feature-extraction",
        "sizeGb": 0.6,
        "quant": "Q4_K_M",
        "ggufRepo": "gpustack/bge-m3-GGUF",
        "downloads": 25000,
        "likes": 150,
        "createdAt": "2024-06-01",
    },
    {
        "id": "BAAI/bge-large-zh-v1.5",
        "name": "BAAI/bge-large-zh-v1.5",
        "kind": "embedding",
        "pipelineTag": "feature-extraction",
        "sizeGb": 0.4,
        "quant": "Q4_K_M",
        "ggufRepo": "gpustack/bge-large-zh-v1.5-GGUF",
        "downloads": 12000,
        "likes": 60,
        "createdAt": "2024-01-01",
    },
    {
        "id": "sentence-transformers/all-MiniLM-L6-v2",
        "name": "sentence-transformers/all-MiniLM-L6-v2",
        "kind": "embedding",
        "pipelineTag": "sentence-similarity",
        "sizeGb": 0.05,
        "quant": "Q4_K_M",
        "ggufRepo": "second-state/All-MiniLM-L6-v2-Embedding-GGUF",
        "downloads": 40000,
        "likes": 100,
        "createdAt": "2023-01-01",
    },
]


def _kind_of(pipeline_tag: str, model_id: str = "") -> str:
    tag = (pipeline_tag or "").lower()
    mid = (model_id or "").lower()
    if tag in ("feature-extraction", "sentence-similarity") or "embed" in mid or "bge-" in mid:
        return "embedding"
    return "llm"


def _parse_dt(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except Exception:
        return None


def _from_hf_item(raw: dict[str, Any]) -> dict[str, Any]:
    mid = str(raw.get("id") or raw.get("modelId") or "")
    tag = str(raw.get("pipeline_tag") or raw.get("pipelineTag") or "")
    created = raw.get("createdAt") or raw.get("created_at") or ""
    size_gb = None
    used = raw.get("usedStorage") or raw.get("used_storage")
    if used:
        try:
            size_gb = round(float(used) / (1024**3), 2)
        except Exception:
            size_gb = None
    return {
        "id": mid,
        "name": mid,
        "kind": _kind_of(tag, mid),
        "pipelineTag": tag or "text-generation",
        "sizeGb": size_gb,
        "quant": "GGUF",
        "ggufRepo": mid,
        "downloads": int(raw.get("downloads") or 0),
        "likes": int(raw.get("likes") or 0),
        "createdAt": str(created)[:10] if created else "",
    }


def _filter_size(items: list[dict[str, Any]], size_band: str) -> list[dict[str, Any]]:
    band = (size_band or "").strip()
    if not band:
        return items
    out = []
    for x in items:
        gb = x.get("sizeGb")
        if gb is None:
            out.append(x)
            continue
        gb = float(gb)
        if band in ("<16", "lt16") and gb < 16:
            out.append(x)
        elif band in ("<32", "lt32") and gb < 32:
            out.append(x)
        elif band in ("<64", "lt64") and gb < 64:
            out.append(x)
        elif band in (">64", "gt64") and gb >= 64:
            out.append(x)
    return out


def _filter_recent(items: list[dict[str, Any]], recent_only: bool) -> list[dict[str, Any]]:
    if not recent_only:
        return items
    cutoff = datetime.now(timezone.utc) - timedelta(days=183)
    out = []
    for x in items:
        dt = _parse_dt(x.get("createdAt"))
        if dt is None:
            out.append(x)
            continue
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        if dt >= cutoff:
            out.append(x)
    return out


async def _hf_search(q: str, kind: str, limit: int, sort: str) -> list[dict[str, Any]]:
    """Search Hugging Face for GGUF repos (LLM + embedding)."""
    limit = max(1, min(int(limit or 40), 100))
    search = (q or "").strip()
    if kind == "embedding":
        search = (search + " embedding gguf").strip()
    elif not search:
        search = "gguf"
    elif "gguf" not in search.lower():
        search = search + " gguf"

    params: dict[str, Any] = {
        "search": search,
        "filter": "gguf",
        "limit": min(limit * 2, 100),
        "full": "true",
        "config": "false",
        "direction": "-1",
    }
    params["sort"] = "likes" if sort == "likes" else "downloads"

    try:
        async with httpx.AsyncClient(timeout=45.0) as client:
            r = await client.get(f"{HF_API}/models", params=params)
            r.raise_for_status()
            raw_list = r.json()
    except Exception:
        return []

    if not isinstance(raw_list, list):
        return []

    items = [_from_hf_item(x) for x in raw_list if x.get("id")]
    if kind == "embedding":
        items = [x for x in items if x["kind"] == "embedding"]
    elif kind == "llm":
        items = [x for x in items if x["kind"] != "embedding"]
    return items[:limit]


def _merge_curated(
    remote: list[dict[str, Any]],
    q: str,
    kind: str,
) -> list[dict[str, Any]]:
    query = (q or "").strip().lower()
    curated = list(CURATED)
    if query:
        curated = [
            x
            for x in curated
            if query in x["id"].lower() or query in x.get("name", "").lower()
        ]
    if kind == "embedding":
        curated = [x for x in curated if x.get("kind") == "embedding"]
    elif kind == "llm":
        curated = [x for x in curated if x.get("kind") == "llm"]

    seen = set()
    out: list[dict[str, Any]] = []
    for x in curated + remote:
        mid = x.get("id")
        if not mid or mid in seen:
            continue
        seen.add(mid)
        out.append(x)
    return out


async def search_models(
    q: str = "",
    kind: str = "all",
    limit: int = 50,
    sort: str = "downloads",
    size_band: str = "",
    recent_only: bool = False,
) -> list[dict[str, Any]]:
    os.environ.setdefault("HF_ENDPOINT", HF_MIRROR)
    kind = (kind or "all").strip().lower()
    limit = max(1, min(int(limit or 50), 100))

    remote = await _hf_search(q, kind, limit, sort)
    items = _merge_curated(remote, q, kind)
    items = _filter_size(items, size_band)
    items = _filter_recent(items, recent_only)

    if sort == "likes":
        items.sort(key=lambda x: int(x.get("likes") or 0), reverse=True)
    else:
        items.sort(key=lambda x: int(x.get("downloads") or 0), reverse=True)

    # Keep curated matches near top when query empty
    if not (q or "").strip():
        curated_ids = {x["id"] for x in CURATED}
        head = [x for x in items if x["id"] in curated_ids]
        tail = [x for x in items if x["id"] not in curated_ids]
        items = head + tail

    return items[:limit]


async def model_detail(model_id: str) -> dict[str, Any]:
    os.environ.setdefault("HF_ENDPOINT", HF_MIRROR)
    mid = str(model_id or "").strip()
    hit = next((x for x in CURATED if x["id"] == mid), None)
    if hit:
        return {
            "id": mid,
            "kind": hit.get("kind") or "llm",
            "pipelineTag": hit.get("pipelineTag") or "text-generation",
            "sizeGb": hit.get("sizeGb"),
            "downloads": hit.get("downloads"),
            "likes": hit.get("likes"),
            "cardData": hit,
            "readme": f"GGUF via {hit.get('ggufRepo', '')} ({hit.get('quant', 'Q4_K_M')})",
            "files": [str(hit.get("quant", "Q4_K_M")) + ".gguf"],
        }

    try:
        async with httpx.AsyncClient(timeout=45.0) as client:
            r = await client.get(f"{HF_API}/models/{mid}")
            r.raise_for_status()
            raw = r.json()
    except Exception as e:
        return {"id": mid, "error": str(e), "cardData": {}, "files": []}

    tag = str(raw.get("pipeline_tag") or "")
    used = raw.get("usedStorage")
    size_gb = round(float(used) / (1024**3), 2) if used else None
    return {
        "id": mid,
        "kind": _kind_of(tag, mid),
        "pipelineTag": tag,
        "sizeGb": size_gb,
        "downloads": int(raw.get("downloads") or 0),
        "likes": int(raw.get("likes") or 0),
        "cardData": raw,
        "readme": "",
        "files": [s.get("rfilename") for s in (raw.get("siblings") or []) if str(s.get("rfilename") or "").endswith(".gguf")][:20],
    }
