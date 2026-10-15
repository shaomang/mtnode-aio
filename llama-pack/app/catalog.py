"""HF catalog helpers for GGUF models (online search via hf-mirror)."""
from __future__ import annotations

import asyncio
import os
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

# 「这次会下载哪一份 GGUF」的唯一口径在下载侧 app/models.py（_pick_gguf_file / _quant_rank：
# 按量化偏好挑单文件件，跳过 *-of-* 分片）。体积必须按那一份算，所以这里复用同一个偏好函数，
# 绝不再复写一份量化偏好表（两处漂移 = 筛出来的体积与真下载的那份对不上）。
from app.models import _quant_rank as _gguf_quant_rank

HF_MIRROR = os.environ.get("HF_ENDPOINT", "https://hf-mirror.com").rstrip("/")
HF_API = f"{HF_MIRROR}/api"

# ── 仓库体积解析（搜索时按 GGUF 文件真实字节数补齐）──────────────────────────
# 搜索接口不给文件体积（实测 /api/models?blobs=true 的 siblings 里没有 size），
# 只有单仓库详情接口 /api/models/{repo}?blobs=true 才有。一次搜索 40~100 个仓库
# 就得补 40~100 次请求，因此：受控并发 + 短超时 + 整段预算 + TTL 缓存；
# 任一仓库失败只让它自己「体积未知」，绝不让整次搜索失败，也不会拖到几十秒。
_SIZE_CONCURRENCY = 8           # 同时在飞的元数据请求数
_SIZE_TIMEOUT = 5.0             # 单仓库请求超时（秒）
_SIZE_TOTAL_BUDGET = 6.0        # 体积解析整段预算（秒）：超时未回的仓库按「未知」处理
# 整段预算用 asyncio.wait 而不是 wait_for(gather)：预算到点时已经拿到的体积必须保住，
# 而 wait_for 超时会连整批 gather 一起取消（已完成的仓库也一起丢）。
_SIZE_CACHE_TTL = 6 * 3600.0    # 命中缓存有效期（秒）
_SIZE_CACHE_MISS_TTL = 600.0    # 「未知」缓存有效期短一些，别把一次网络抖动记半天
_SIZE_CACHE_MAX = 512
_SIZE_CACHE: dict[str, tuple[float, int | None]] = {}

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


# ── 列表口径（白名单式分类）────────────────────────────────────────────────
# 旧写法是「非 embedding 即 llm」的兜底判定：只要 pipeline_tag 不是 embedding 类，
# 不管它是 VL 多模态（image-text-to-text）、重排（text-ranking）、分类（text-classification）
# 还是别的任务，统统被算成 LLM 摆进列表 —— llama-server 拉不起来这些仓库，
# 用户装完才发现白下载几个 GB。现在改成白名单：认得的标签才归类，认不出的单独标
# kind="other"，不再冒充 LLM（见 _hf_search / _merge_curated 的过滤）。
_EMBEDDING_TAGS = ("feature-extraction", "sentence-similarity", "text-embedding")
_LLM_TAGS = ("text-generation", "conversational")
_VL_TAGS = ("image-text-to-text", "visual-question-answering")
# 标签认不出时给界面看的猜测（不进白名单）：pipeline_tag 有大量别名，
# 但「能不能算 LLM」只由上面的白名单说了算，这里只影响兜底条目的归类显示。
_VL_ID_HINTS = ("qwen2-vl", "qwen2.5-vl", "qwen3-vl", "llava", "minicpm-v", "internvl", "moondream", "vl-")
_EMBED_ID_HINTS = ("embed", "bge-", "gte-", "e5-", "reranker")
# 无标签时的「非文本模型」迹象（实测这类仓库也有不带 pipeline_tag 的，如 Serveurperso/YuE2-GGUF、
# audio-cpp/audio.cpp-gguf、*-asr-*）：命中就不收进 LLM 列表。
_NON_TEXT_ID_HINTS = ("music", "yue", "-asr", "asr-", "whisper", "tts", "audio", "speech", "voice", "image", "diffusion", "sd-", "flux", "video")
# 少数 GGUF 仓库确实没有 pipeline_tag（实测 100 条里 3 条，如 unsloth/Qwen3.8-27B-GGUF）。
# 它们既没标签也没别名，白名单判不出类别；一律按 other 丢掉会让用户搜「Qwen3.8-27B-GGUF」
# 明明存在却查不到（死路一条）。所以：无标签 → 归 llm 但标 kindGuessed=True（界面可提示
# 「未标注，默认按文本模型处理」），有标签但不认识（object-detection / text-to-speech …）→ other 丢掉。


def _kind_of(pipeline_tag: str, model_id: str = "") -> str:
    """按 pipeline_tag 白名单分类；标签为空时按名字别名兜底，认不出的返回 "other"。"""
    tag = (pipeline_tag or "").strip().lower()
    mid = (model_id or "").lower()
    if tag:
        if tag in _EMBEDDING_TAGS:
            return "embedding"
        if tag in _LLM_TAGS:
            return "llm"
        if tag in _VL_TAGS:
            return "vl"
        # 带前缀的同族标签（如某分支的 xxx/text-generation）
        if tag.endswith("/text-generation"):
            return "llm"
        if tag.endswith("/feature-extraction"):
            return "embedding"
        return "other"
    if any(h in mid for h in _VL_ID_HINTS):
        return "vl"
    if any(h in mid for h in _EMBED_ID_HINTS):
        return "embedding"
    if any(h in mid for h in _NON_TEXT_ID_HINTS):
        return "other"
    if mid:
        return "llm"  # 无标签、无别名：GGUF 里绝大多数是文本模型，先按 llm 收进来并标 kindGuessed
    return "other"


# 列表只认这两类（llm = llama-server 能对话的文本模型，embedding = 向量模型）
_CATALOG_KINDS = ("llm", "embedding")


def _parse_dt(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except Exception:
        return None


def _cache_key(repo: str) -> str:
    return f"{HF_MIRROR}|{repo}"


def _cache_get(repo: str) -> tuple[bool, int | None]:
    hit = _SIZE_CACHE.get(_cache_key(repo))
    if not hit:
        return False, None
    exp, val = hit
    if exp < time.time():
        _SIZE_CACHE.pop(_cache_key(repo), None)
        return False, None
    return True, val


def _cache_put(repo: str, nbytes: int | None) -> None:
    if len(_SIZE_CACHE) >= _SIZE_CACHE_MAX:
        now = time.time()
        for k in [k for k, (exp, _v) in _SIZE_CACHE.items() if exp < now]:
            _SIZE_CACHE.pop(k, None)
        if len(_SIZE_CACHE) >= _SIZE_CACHE_MAX:
            _SIZE_CACHE.clear()
    ttl = _SIZE_CACHE_TTL if nbytes else _SIZE_CACHE_MISS_TTL
    _SIZE_CACHE[_cache_key(repo)] = (time.time() + ttl, nbytes)


def _download_file_of(raw: dict[str, Any]) -> str:
    """仓库里「这次会下载的那一份」单文件 GGUF 的文件名（挑不到返回空串）。

    与 app/models.py 的 _pick_gguf_file 同规则：*.gguf、跳过 *-of-* 分片与名字带 split 的件、
    按同一个量化偏好稳定排序取第一份（并列时保持元数据里的文件顺序 = 下载侧 list_repo_files 的顺序）。
    """
    names: list[str] = []
    for s in raw.get("siblings") or []:
        name = str((s or {}).get("rfilename") or "")
        low = name.lower()
        if not low.endswith(".gguf"):
            continue
        if "-of-" in low or "split" in low:
            continue
        names.append(name)
    if not names:
        return ""
    names.sort(key=_gguf_quant_rank)
    return names[0]


def _file_bytes(raw: dict[str, Any], fname: str) -> int:
    """该文件在元数据里给出的真实字节数（拿不到 = 0）。"""
    for s in raw.get("siblings") or []:
        sib = s or {}
        if str(sib.get("rfilename") or "") != fname:
            continue
        for v in (sib.get("size"), (sib.get("lfs") or {}).get("size")):
            try:
                n = int(v or 0)
            except Exception:
                n = 0
            if n > 0:
                return n
    return 0


async def _repo_download_bytes(client: httpx.AsyncClient, repo: str) -> int | None:
    """该仓库将下载的那一份 GGUF 的真实字节数（未知 = None）。带 TTL 缓存。"""
    cached, val = _cache_get(repo)
    if cached:
        return val
    size: int | None = None
    try:
        r = await client.get(f"{HF_API}/models/{repo}", params={"blobs": "true"})
        if r.status_code == 200:
            raw = r.json()
            if isinstance(raw, dict):
                fname = _download_file_of(raw)
                n = _file_bytes(raw, fname) if fname else 0
                size = n if n > 0 else None
    except Exception:
        size = None  # 单仓库失败只影响它自己：这个仓库体积未知
    _cache_put(repo, size)
    return size


def _set_size(item: dict[str, Any], nbytes: int | None) -> None:
    """把真实体积写进条目。

    sizeGb = 筛选口径（体积档位按它比）；sizeUnknown = 供界面把「未知」标出来；
    totalSizeGb = 控制台行内体积显示读的字段（llama/ui/app.js 的 mkItemMeta 对目录项读它）。
    """
    gb = round(float(nbytes) / (1024**3), 2) if nbytes else None
    item["sizeGb"] = gb
    item["sizeUnknown"] = gb is None
    item["totalSizeGb"] = gb


async def _attach_sizes(items: list[dict[str, Any]]) -> None:
    """给搜索结果补真实体积：受控并发 + 短超时 + 整段预算 + 缓存，失败只留「未知」。"""
    repos: list[str] = []
    for x in items:
        repo = str(x.get("id") or "")
        if repo and repo not in repos:
            repos.append(repo)
    if not repos:
        return
    sizes: dict[str, int | None] = {}
    try:
        timeout = httpx.Timeout(_SIZE_TIMEOUT, connect=min(3.0, _SIZE_TIMEOUT))
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            sem = asyncio.Semaphore(_SIZE_CONCURRENCY)

            async def one(repo: str) -> tuple[str, int | None]:
                async with sem:
                    return repo, await _repo_download_bytes(client, repo)

            tasks = [asyncio.create_task(one(r)) for r in repos]
            done, pending = await asyncio.wait(tasks, timeout=_SIZE_TOTAL_BUDGET)
            for t in pending:
                t.cancel()
            for t in done:
                try:
                    repo, n = t.result()
                except Exception:
                    continue
                sizes[repo] = n
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
    except Exception:
        pass  # 拿到多少算多少，其余留「未知」，绝不因此让整次搜索失败
    for x in items:
        n = sizes.get(str(x.get("id") or ""))
        if n is None and x.get("sizeGb") is not None:
            # 网上没解析到（None）但条目自带体积（CURATED 随包写死的那几条）：保留原值 ——
            # 直接 _set_size(x, None) 会把它们盖成「体积未知」，聚合推荐里于是永远显示「—」。
            continue
        _set_size(x, n)


def _from_hf_item(raw: dict[str, Any]) -> dict[str, Any]:
    mid = str(raw.get("id") or raw.get("modelId") or "")
    tag = str(raw.get("pipeline_tag") or raw.get("pipelineTag") or "")
    created = raw.get("createdAt") or raw.get("created_at") or ""
    return {
        "id": mid,
        "name": mid,
        "kind": _kind_of(tag, mid),
        # 标签就照实回（空的写 unknown）：以前空标签被填成 "text-generation"，
        # 于是「没有标签」在列表里和真·文本生成模型长得一模一样，无从分辨。
        "pipelineTag": tag or "unknown",
        # 没有 pipeline_tag 时的归类是猜的（按别名兜底），标出来供界面对这类条目弱化/提示。
        "kindGuessed": not tag,
        # 体积一律留待 _attach_sizes 按真实 GGUF 字节数补齐（见下）。绝不用 usedStorage：
        # 它是整个仓库（含全部量化件与分片）的占用，实测 bartowski/Qwen2.5-7B-Instruct-GGUF
        # 报 338GB，而这次真会下载的那一份只有 4.4GB —— 拿它筛选等于把 4.4GB 的模型按 300GB 挡掉。
        "sizeGb": None,
        "sizeUnknown": True,
        "totalSizeGb": None,
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
            # 体积未知的不再无条件放行：带体积档位时一律排除（否则「<16GB」里会混进真实 300GB 的仓库）。
            # 档位 = 全部（空档）时照旧展示，界面上按 sizeUnknown 标「未知」。
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
    """Search Hugging Face for GGUF repos (whitelist: LLM + embedding only)."""
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
        # 多取一些：白名单会滤掉 VL / 重排 / 分类等条目，只取 limit*2 时过滤后可能凑不满一屏。
        "limit": min(limit * 3, 100),
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
    # 白名单过滤：kind=llm 只留 text-generation/conversational，kind=embedding 只留向量模型，
    # kind=all 只留这两类 —— VL（image-text-to-text）/ 重排 / 分类等一律不进列表（改用 _kind_of 白名单前
    # 「非 embedding 即 llm」，它们全被当 LLM 摆出来，装完 llama-server 根本拉不起来）。
    # 过滤在补体积之前：不该进列表的条目不该白花一次元数据请求。
    items = _filter_kind(items, kind)
    items = items[:limit]
    # 体积只能逐个仓库拉元数据补（搜索接口不给文件字节数），只给会被保留的这 limit 条补。
    await _attach_sizes(items)
    return items


def _filter_kind(items: list[dict[str, Any]], kind: str) -> list[dict[str, Any]]:
    """按白名单收窄 kind：llm / embedding 各自只留本类，all 也只留这两类。"""
    want = (kind or "all").strip().lower()
    if want not in _CATALOG_KINDS:
        want = "all"
    if want == "all":
        return [x for x in items if str(x.get("kind") or "") in _CATALOG_KINDS]
    return [x for x in items if str(x.get("kind") or "") == want]


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
    curated = _filter_kind(curated, kind)
    # remote 已经过 _hf_search 的白名单；这里再收一次，保证合并结果只含列表认的两类。
    remote = _filter_kind(remote, kind)

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
    # 体积口径与搜索结果同一份：仓库里「这次会下载的那一份」GGUF 的真实字节数。
    # 不用 usedStorage —— 那是整仓（含全部量化件与分片）的占用，实测同一个 4.4GB 的模型报 338GB。
    fname = _download_file_of(raw)
    nbytes = _file_bytes(raw, fname) if fname else 0
    return {
        "id": mid,
        "kind": _kind_of(tag, mid),
        "pipelineTag": tag or "unknown",
        "sizeGb": round(nbytes / (1024**3), 2) if nbytes > 0 else None,
        "sizeUnknown": nbytes <= 0,
        "ggufFile": fname,
        "downloads": int(raw.get("downloads") or 0),
        "likes": int(raw.get("likes") or 0),
        "cardData": raw,
        "readme": "",
        "files": [s.get("rfilename") for s in (raw.get("siblings") or []) if str(s.get("rfilename") or "").endswith(".gguf")][:20],
    }
