"""HF catalog helpers for GGUF models (online search via hf-mirror)."""
from __future__ import annotations

import asyncio
import json
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
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

# ── 架构收窄：只留当前引擎真能加载的 GGUF ────────────────────────────────
# 用户报障：列表把 llama-server 根本不认识的架构也摆出来，装完几个 GB 才在部署时
# `unknown model architecture: 'deepseek4_mtp_support'` 上炸掉（详见 llama-<port>.log）。
# pipeline_tag 白名单（_kind_of）管不到这一层 —— 那些仓库的 pipeline_tag 就是
# text-generation，谎只在 GGUF 文件头的 general.architecture 里。
# HF 的 /api/models 元数据**不返回**这个键（实测 hf-mirror 的 full=true 也没有），
# 所以只能自己读文件头：Range 只取前 256KB 起步（实测 0.4~1.7s/仓库），
# 该窗口里没解析到键再扩到 2MB；并发 8 + 单请求 6s + 整段 75s 预算。
_ARCH_PROBE_RANGE = 256 * 1024
_ARCH_PROBE_RANGE_MAX = 2 * 1024 * 1024
_ARCH_PROBE_CONCURRENCY = 8
_ARCH_PROBE_TIMEOUT = 6.0
_ARCH_PROBE_TOTAL_BUDGET = 75.0
_ARCH_CACHE_TTL = 24 * 3600.0      # 命中的架构（含「引擎不支持」）缓存一天
_ARCH_UNKNOWN_TTL = 600.0          # 没探出结果：短 TTL，别把一次网络抖动记成半天
_ARCH_CACHE_MAX = 512
_ARCH_CACHE: dict[str, tuple[float, str]] = {}

# ── 在线模型列表「固化」表（.catalog-cache.json）────────────────────────────
# 用户口径：拉取过模型菜单就把它固化下来；之后**再拉取只按时间拿最新的增量，其余一概不管**。
# 背景：整页拉取要为 40~100 个仓库各补一次体积 + 探一次架构，慢且吃网络；
# 而这些结果一旦拿到就不会变（仓库的体积与文件头架构是既成事实）。
# 所以第一次整页拉到的条目连同体积 / 架构一起写盘冻结，之后：
#   · 菜单打开 = 直接读固化表（离线也有内容），再用 **sort=createdAt 倒序** 只问
#     「比固化表里最新一条还新」的那几页，逐条探完并入表；
#   · 结果按时间并入（同 id 覆盖，绝不因为这次没返回就删掉已固化的条目）；
#   · 想整页重新拉一遍，删掉 <安装目录>/.catalog-cache.json 即可（下一次重拉后重新固化）。
# 两个护栏（都是真机踩出来的）：
#   · 整页拉取**空手而归**（镜像 503 / 超时）时绝不写 frozenAt / items，只把 fullOk 标成
#     false —— 否则聚合推荐那几条会被当成「整份在线列表」冻结，从此永不再整页拉，
#     列表就永远只有几个模型（真机现场：6 条 / newestCreatedAt=2026-04-01）；
#   · 增量核对有 lastCheckedAt + 最小间隔，10 分钟内重复开菜单不再打镜像。
CACHE_PATH = Path(__file__).resolve().parent.parent / ".catalog-cache.json"
_STORE_VERSION = 1
# 上限 1200 条（实测真机 59 条 / 30KB ≈ 510 B/条 ⇒ 满载约 0.6MB）。
# 曾经写 3000：条目越多，「按 id 去重 + 每轮落盘」的线性成本越高，而列表根本翻不到那么远；
# 今天实有 59 条，降到 1200 对现有用户没有任何淘汰。
_STORE_MAX_ITEMS = 1200
_STORE_NEWEST_PAGES = 3        # 增量最多追问几页（100 条/页）；再多留给下一次拉取
_STORE_NEWEST_PAGE_LIMIT = 100
_STORE_NEWEST_BUDGET = 15.0    # 增量整段预算（秒）：镜像挂着时也不能让菜单等半分钟才出来
# 增量「握手」闸：上次**成功核过增量**的时刻（ISO UTC）与最小间隔（秒）。
# 10 分钟内再开一次菜单 / 再点一次刷新，直接拿固化表回话，一个网络请求都不发（force 可越过）。
# 没有这道闸时，界面上的「刷新」≈ 人肉重试撞镜像：每次 1~3 页请求 + 十几秒等待，
# 换回来的通常还是「没有新增」。
# 注意：整页拉取**不**重置这一格 —— 它记的是「增量核对」，这样刚整页拉完再开一次菜单
# 仍能确认一遍最新（1 页，然后才进入 10 分钟免费期）。
_STORE_MIN_INTERVAL = 600.0
_STORE: dict[str, Any] | None = None          # 进程内副本（省掉每次搜索都读盘）
_LAST_SYNC: dict[str, Any] = {"mode": "", "added": 0}

# ── 拉取状态机（控制台状态条的唯一真源）─────────────────────────────────────
# 为什么要有它：一次列表拉取是「拉列表 → 补体积 → 探架构 → 合并」四段串行，
# 真机实测 12.2~28.5s；而旧实现全程只有最后一刻才吐一个 JSON，中途没有任何可查询的状态 ——
# 于是「点刷新没反应」「镜像出错」「镜像没新东西」在界面上长得一模一样
# （错误还只写进默认收起的那块 Console）。这里把四段各自的进度原地记在进程内，
# 界面轮询 /api/catalog/sync 就能显示「正在补体积 12/40 · 已用 8s · 已固化 59 条」。
# 只存内存、绝不落盘：它是「这一次拉取」的临时状态，进程重启就该重新开始。
_SYNC: dict[str, Any] = {
    "seq": 0,                  # 每开一轮 +1：界面据此认出「这是新的一轮」
    "phase": "idle",           # idle | listing | sizes | arch | merge | done | error
    "mode": "",                # full = 整页拉取 / frozen = 只按时间取增量
    "startedAt": "",
    "updatedAt": "",
    "elapsedMs": 0,
    "page": 0,                 # 当前在第几页（1 起）
    "pagesFetched": 0,         # 本轮一共发了几页列表请求
    "candTotal": 0,            # 本轮要探测的仓库数（界面「12/40」的分母）
    "probedSizes": 0,          # 已补好体积的条数
    "probedArch": 0,           # 已探好架构的条数
    "added": 0,                # 本轮并入固化表的新条目数
    "error": "",               # 人话文案（控制台状态条直接显示）
    "errorKind": "",           # mirror_503 | mirror_http | timeout | empty | ""
    "intervalSkipped": False,  # 这一轮被「10 分钟最小间隔」挡下（没发任何网络请求）
}
_SYNC_STARTED = 0.0


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sync_reset(mode: str) -> None:
    """开一轮新的拉取：清掉上一轮的进度（界面靠 seq 变化认出「新一轮」）。"""
    global _SYNC_STARTED
    _SYNC_STARTED = time.time()
    _SYNC.update({
        "seq": int(_SYNC.get("seq") or 0) + 1,
        "phase": "listing",
        "mode": str(mode or ""),
        "startedAt": _iso_now(),
        "updatedAt": _iso_now(),
        "elapsedMs": 0,
        "page": 0,
        "pagesFetched": 0,
        "candTotal": 0,
        "probedSizes": 0,
        "probedArch": 0,
        "added": 0,
        "error": "",
        "errorKind": "",
        "intervalSkipped": False,
    })
    _LAST_SYNC["mode"] = str(mode or "")
    _LAST_SYNC["added"] = 0


def _sync_set(**kw: Any) -> None:
    """原地更新这一轮的部分字段（阶段转换 / 计数累加），并刷新已用时间。"""
    _SYNC.update({k: v for k, v in kw.items()})
    _SYNC["updatedAt"] = _iso_now()
    if _SYNC_STARTED:
        _SYNC["elapsedMs"] = int((time.time() - _SYNC_STARTED) * 1000)


def sync_state() -> dict[str, Any]:
    """这一轮拉取的进度（server 的 /api/catalog/sync 直接回它）。

    running=True 表示四段还没走完：界面据此决定要不要继续轮询、以及状态条该不该收起。
    """
    st = dict(_SYNC)
    if _SYNC_STARTED and st.get("phase") not in ("idle", "done", "error"):
        st["elapsedMs"] = int((time.time() - _SYNC_STARTED) * 1000)
    st["running"] = st.get("phase") not in ("idle", "done", "error")
    return st


def _note_error(kind: str, message: str, *, hard: bool = True) -> None:
    """记一条本轮失败：kind 机器可辨，message 给人看（状态条直接显示）。

    hard=True 表示「这一轮确实失败了」（连不上 / 5xx），状态机进 error；
    hard=False 表示「请求通了但结果是空的」，列表还能用固化表，状态机照常收尾。
    失败同时落进 store 的 lastError —— 进程重启后界面仍能说出「上次为什么没拉到」。
    """
    kw: dict[str, Any] = {"error": message, "errorKind": kind}
    if hard:
        kw["phase"] = "error"
    _sync_set(**kw)
    _store_note_error(kind, message)


def _note_search_error(exc: BaseException, *, what: str = "列表") -> None:
    """把一次 httpx 异常归成三类可读文案之一（不再静默 `return []`）。

    三类是用户/界面真正能分辨的：镜像 5xx（上游挂了）、超时（网络 / 代理）、其它 HTTP 错。
    """
    if isinstance(exc, httpx.HTTPStatusError):
        code = int(getattr(getattr(exc, "response", None), "status_code", 0) or 0)
        if code >= 500 or code == 429:
            _note_error("mirror_503", f"镜像返回 HTTP {code}（上游不可用，稍后重试）")
        else:
            _note_error("mirror_http", f"镜像返回 HTTP {code}")
        return
    if isinstance(exc, httpx.TimeoutException):
        _note_error("timeout", f"镜像响应超时（{what}请求没在超时内回话）")
        return
    if isinstance(exc, (httpx.TransportError, OSError)):
        _note_error("timeout", "连不上镜像（网络 / DNS / 代理）")
        return
    _note_error("mirror_http", f"{what}拉取失败：{exc}")

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
#
# 但「无标签 → llm」这条兜底会漏进向量模型：实测搜 bge- 时
# mradermacher/BGE_M3_Mindspore-GGUF 等三个仓库既没标签、名字别名也认不出，被当 llm 摆进列表，
# 可它们文件头里写着 general.architecture=bert —— 装完只会得到一个不会对话的模型。
# 所以再补一条**架构层面**的判据（探到架构之后才判得了，见 _apply_arch_kind）：
# 下面这些架构能跑文本向量 / 文本编码，但都不是可对话 LLM，一律归 other 丢掉。
# 只列有实测证据的（本机搜出来的原样样本），不写「猜着像」的名字：
#   · clip / t5encoder —— 多模态投影件与文本编码器（实测 prism-ml/Ternary-Bonsai-2-27B-gguf = clip）
#   · bert 家族 —— 向量 / 重排（实测 mradermacher/BGE_M3_Mindspore-GGUF = bert）
_NON_LLM_ARCHES = (
    "clip", "bert", "nomic-bert", "nomic-bert-moe", "jina-bert-v2",
    "t5", "t5encoder", "trocr", "wavtokenizer-dec",
)


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


# 列表只认 llm 一类（用户口径：仅允许 llm —— embedding / 向量模型也一并从在线列表里收掉，
# 类型下拉同时收敛为「全部 / LLM」）。embedding 的判据函数保留：分类与界面回显还要用，
# 只是不再是「能进列表」的类型（见 _filter_kind）。
_CATALOG_KINDS = ("llm",)


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
        # 与架构探测同一份「该探哪个仓库」的口径（见 _probe_repo）：聚合推荐条目的
        # 体积也该按 ggufRepo 里那份算，别拿原始权重仓库的文件列表糊弄。
        repo = _probe_repo(x)
        if repo and repo not in repos:
            repos.append(repo)
    if not repos:
        return
    # 状态机：分母 = 这一轮真要探的仓库数（界面「补体积 12/40」）。
    _sync_set(phase="sizes", candTotal=len(repos))
    sizes: dict[str, int | None] = {}
    done_n = 0
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
                # 每回来一个就推进一格：界面显示的是真实进度，不是「整段预算走完才有数」。
                done_n += 1
                try:
                    repo, n = t.result()
                except Exception:
                    repo, n = "", None
                if repo:
                    sizes[repo] = n
                _sync_set(probedSizes=done_n)
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
    except Exception:
        pass  # 拿到多少算多少，其余留「未知」，绝不因此让整次搜索失败
    for x in items:
        n = sizes.get(_probe_repo(x))
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
        # 架构一律留待 _attach_arch 读 GGUF 文件头补齐（搜索接口不给 general.architecture）。
        "arch": None,
        # confirmed = 探到且当前引擎支持；unsupported = 探到但引擎不支持（列表里根本不出现）；
        # unconfirmed = 没探到（网络超时 / 仓库里没有可下载的单文件 GGUF）→ 保留并标注。
        "archStatus": "unconfirmed",
        "quant": "GGUF",
        "ggufRepo": mid,
        "downloads": int(raw.get("downloads") or 0),
        "likes": int(raw.get("likes") or 0),
        "createdAt": str(created)[:10] if created else "",
    }


def _probe_repo(item: dict[str, Any]) -> str:
    """要拿哪一份 GGUF 来判架构。

    聚合推荐（CURATED）条目正文写的是 HF 上的**原始权重**仓库（google/gemma-4-E4B-it），
    真正下载的 GGUF 在 ggufRepo 指的那个仓库；探错仓库会得出「架构未确认」这种假结论。
    """
    gguf_repo = str(item.get("ggufRepo") or "").strip()
    if gguf_repo and gguf_repo != str(item.get("id") or "").strip():
        return gguf_repo
    return str(item.get("id") or "").strip()


# ── 固化表：读 / 写 / 并入 / 回填缓存 ─────────────────────────────────────────


def _store_load() -> dict[str, Any]:
    """读固化表（只读一次盘，之后走进程内副本）。坏文件一律当空表，绝不因此报错。"""
    global _STORE
    if _STORE is not None:
        return _STORE
    data: Any = {}
    try:
        if CACHE_PATH.exists():
            data = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
    except Exception:
        data = {}
    if not isinstance(data, dict):
        data = {}
    items = data.get("items")
    if not isinstance(items, dict):
        items = {}
    items = {str(k): v for k, v in items.items() if isinstance(v, dict) and v.get("id")}
    full_ok = data.get("fullOk")
    if full_ok is None:
        # 老版本固化的表没有这一格。只有「一条远程条目都没有、全是聚合推荐」的才当整页失败 ——
        # 真机现场就是它：镜像 503 时 _hf_search 返回 []，6 条 CURATED 被当成整份在线列表冻结，
        # 之后 frozen=true 永远不再整页拉，列表从此只有 6 个模型。健康的表一律当 fullOk=true，
        # 免得给所有老用户白跑一次整页重拉。
        curated_ids = {c["id"] for c in CURATED}
        full_ok = not (items and set(items) <= curated_ids)
    _STORE = {
        "version": _STORE_VERSION,
        "frozenAt": str(data.get("frozenAt") or ""),
        "refreshedAt": str(data.get("refreshedAt") or ""),
        # 已固化的最新条目时间（按 createdAt 的日期，YYYY-MM-DD）：增量口径的切点之一。
        "newestCreatedAt": str(data.get("newestCreatedAt") or ""),
        # 上次成功核过增量的时刻（ISO UTC）：_STORE_MIN_INTERVAL 那道闸就比它。
        "lastCheckedAt": str(data.get("lastCheckedAt") or ""),
        # 上一轮整页拉取是否成功（false = 镜像挂着；下一轮会自动补拉一次整页）。
        "fullOk": bool(full_ok),
        # 最近一次镜像失败（{kind, message, at}）：给控制台红条一行字，不参与任何逻辑。
        "lastError": data.get("lastError") if isinstance(data.get("lastError"), dict) else {},
        "items": items,
    }
    return _STORE


def _interval_fresh(store: dict[str, Any]) -> bool:
    """距上次成功核过增量是否还在 _STORE_MIN_INTERVAL 之内（在 → 这一轮不用联网）。"""
    ts = _parse_dt(str(store.get("lastCheckedAt") or ""))
    if ts is None:
        return False
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - ts).total_seconds() < _STORE_MIN_INTERVAL


def _store_note_error(kind: str, message: str) -> None:
    """把最近一次镜像失败记进固化表（store_info()['lastError'] 回给控制台）。

    同一句重复失败不重写盘；写不进去也不影响任何行为 —— 它只是给界面看的一行字。
    """
    store = _store_load()
    prev = store.get("lastError") or {}
    if str(prev.get("kind") or "") == str(kind) and str(prev.get("message") or "") == str(message):
        return
    store["lastError"] = {"kind": str(kind), "message": str(message), "at": _iso_now()}
    _store_save(store)


def _store_mark_checked() -> None:
    """核过一次增量（拿到了真实响应）：记下时刻，10 分钟内不再打镜像。

    **整页拉取不调用它**（见 _STORE_MIN_INTERVAL 的注释）：刚整页拉完再开一次菜单
    仍会做一轮 1 页的增量确认，之后才进入免费期。
    """
    store = _store_load()
    store["lastCheckedAt"] = _iso_now()
    store["lastError"] = {}
    _store_save(store)


def _store_mark_full_ok() -> None:
    """这一轮整页拉取成功（拿到了远程条目）：清掉失败标记。"""
    store = _store_load()
    store["fullOk"] = True
    store["lastError"] = {}
    _store_save(store)


def _store_mark_full_bad() -> None:
    """这一轮整页拉取空手而归（镜像 503 / 超时）：**不动** items / frozenAt，只标一次失败。

    标记本身由调用方写（_note_error）；这里只负责把 fullOk 置 false，
    让下一轮 search_models 把这个「不完整的表」当成需要补拉整页。
    """
    store = _store_load()
    store["fullOk"] = False
    _store_save(store)


def _store_save(store: dict[str, Any]) -> None:
    """落盘（先写临时文件再 replace，中断不会留下半个 JSON）。写不进去只影响下次省一次网络。"""
    try:
        items = store.get("items") or {}
        if len(items) > _STORE_MAX_ITEMS:
            keep = sorted(
                items.items(),
                key=lambda kv: str((kv[1] or {}).get("cachedAt") or ""),
                reverse=True,
            )[:_STORE_MAX_ITEMS]
            store["items"] = dict(keep)
        tmp = CACHE_PATH.with_name(CACHE_PATH.name + ".tmp")
        tmp.write_text(json.dumps(store, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, CACHE_PATH)
    except Exception:
        pass


def _store_items() -> list[dict[str, Any]]:
    """固化表里的条目（对外形态与搜索结果一致：内部用的 cachedAt / sizeBytes 不外露）。"""
    out: list[dict[str, Any]] = []
    for _mid, rec in (_store_load().get("items") or {}).items():
        if not isinstance(rec, dict):
            continue
        x = {k: v for k, v in rec.items() if k not in ("cachedAt", "sizeBytes")}
        if x.get("id"):
            out.append(x)
    return out


def _store_put(items: list[dict[str, Any]]) -> int:
    """把条目并入固化表（同 id 覆盖，已有条目不会因为这次没返回而消失）。返回新增条数。"""
    store = _store_load()
    table = store["items"]
    now = datetime.now(timezone.utc).isoformat()
    newest = str(store.get("newestCreatedAt") or "")
    added = 0
    for x in items:
        mid = str(x.get("id") or "").strip()
        if not mid:
            continue
        prev = table.get(mid)
        rec = dict(prev or {})
        # None 不算信息：这次网络没拿到体积 / 架构时，别把上次固化下来的真值盖成空。
        rec.update({k: v for k, v in x.items() if v is not None})
        rec["id"] = mid
        rec["cachedAt"] = now
        gb = rec.get("sizeGb")
        if gb is not None:
            try:
                rec["sizeBytes"] = int(round(float(gb) * (1024 ** 3)))
            except Exception:
                rec.pop("sizeBytes", None)
        if prev is None:
            added += 1
        table[mid] = rec
        created = str(rec.get("createdAt") or "")[:10]
        if created > newest:
            newest = created
    store["newestCreatedAt"] = newest
    store["refreshedAt"] = now
    if not store.get("frozenAt"):
        store["frozenAt"] = now
    _store_save(store)
    return added


def _store_seed_caches() -> None:
    """把固化表里的体积 / 架构灌进内存 TTL 缓存：已知条目于是不再发任何一个探测请求。"""
    now = time.time()
    for rec in (_store_load().get("items") or {}).values():
        if not isinstance(rec, dict):
            continue
        repo = _probe_repo(rec)
        if not repo:
            continue
        nbytes = rec.get("sizeBytes")
        try:
            n = int(nbytes) if nbytes is not None else None
        except Exception:
            n = None
        if n:
            _SIZE_CACHE[_cache_key(repo)] = (now + _SIZE_CACHE_TTL, n)
        status = str(rec.get("archStatus") or "unconfirmed")
        if status in ("confirmed", "unsupported", "non-llm"):
            _ARCH_CACHE[repo] = (now + _ARCH_CACHE_TTL, (str(rec.get("arch") or ""), status))


def store_info() -> dict[str, Any]:
    """固化表状态（/api/catalog 回给控制台：界面据此说「已固化 · 本次新增 N 条」）。"""
    store = _store_load()
    return {
        "path": str(CACHE_PATH),
        "frozen": bool(store.get("items")),
        "count": len(store.get("items") or {}),
        "frozenAt": str(store.get("frozenAt") or ""),
        "refreshedAt": str(store.get("refreshedAt") or ""),
        "newestCreatedAt": str(store.get("newestCreatedAt") or ""),
        "mode": str(_LAST_SYNC.get("mode") or ""),
        "added": int(_LAST_SYNC.get("added") or 0),
        # 增量口径的两格（界面据此说「已固化 · 10 分钟内不再联网」/「上次整页没成功，下一轮补拉」）。
        "fullOk": bool(store.get("fullOk", True)),
        "lastCheckedAt": str(store.get("lastCheckedAt") or ""),
        # 最近一次镜像失败：{kind, message, at}，没有失败时是空 dict。
        "lastError": dict(store.get("lastError") or {}),
        # 上一次拉取走到哪一步（与 /api/catalog/sync 同一份状态机；列表响应顺带带一份）。
        "sync": sync_state(),
    }


def _arch_cache_get(repo: str) -> tuple[bool, tuple[str, str]]:
    hit = _ARCH_CACHE.get(repo)
    if not hit:
        return False, ("", "unconfirmed")
    exp, val = hit
    if exp < time.time():
        _ARCH_CACHE.pop(repo, None)
        return False, ("", "unconfirmed")
    return True, val


def _arch_cache_put(repo: str, val: tuple[str, str]) -> None:
    if len(_ARCH_CACHE) >= _ARCH_CACHE_MAX:
        now = time.time()
        for k in [k for k, (exp, _v) in _ARCH_CACHE.items() if exp < now]:
            _ARCH_CACHE.pop(k, None)
        if len(_ARCH_CACHE) >= _ARCH_CACHE_MAX:
            _ARCH_CACHE.clear()
    # 「没探到」缓存短一点，别把一次网络抖动记半天；有结论的（含不支持 / 非对话）缓存一天。
    ttl = _ARCH_CACHE_TTL if val[1] in ("confirmed", "unsupported", "non-llm") else _ARCH_UNKNOWN_TTL
    _ARCH_CACHE[repo] = (time.time() + ttl, val)


def _gguf_arch_from_head(head: bytes) -> str:
    """从 GGUF 文件头解析 general.architecture（没有 / 解析不了 = 空串）。

    格式（GGUF v1..v3）：magic「GGUF」+ u32 版本 + u64 张量数 + u64 KV 数，
    随后是连续 KV：u64 键长 + 键名 + u32 值类型 + 值。取值只认字符串型（类型 8），
    KV 数量巨大但 general.architecture 永远在最前面（实测前 5~12 个键内），
    所以只解析到第一个 4KB 就用完的头部即可，遇到任何异常都退回空串。
    """
    import struct

    try:
        mv = memoryview(head)
        if len(head) < 24 or bytes(mv[:4]) != b"GGUF":
            return ""
        off = 4
        version = struct.unpack_from("<I", mv, off)[0]
        off += 4
        if not 1 <= version <= 3:
            return ""
        off += 8  # n_tensors
        n_kv = struct.unpack_from("<Q", mv, off)[0]
        off += 8
        if n_kv <= 0 or n_kv > 1_000_000:
            return ""
        fixed = {0: ("<B", 1), 1: ("<b", 1), 2: ("<H", 2), 3: ("<h", 2), 4: ("<I", 4),
                 5: ("<i", 4), 6: ("<f", 4), 7: ("<B", 1), 10: ("<Q", 8), 11: ("<q", 8), 12: ("<d", 8)}

        def _skip_value(typ: int, pos: int) -> int:
            """返回下一个键的起点；类型不认识就抛异常（由外层兜成空串）。"""
            if typ == 8:
                n = struct.unpack_from("<Q", mv, pos)[0]
                return pos + 8 + n
            if typ == 9:
                et = struct.unpack_from("<I", mv, pos)[0]
                cnt = struct.unpack_from("<Q", mv, pos + 4)[0]
                pos += 12
                if cnt > 1_000_000:
                    raise ValueError("array too big")
                for _ in range(cnt):
                    pos = _skip_value(et, pos)
                return pos
            fmt, size = fixed[typ]
            return pos + size

        for _ in range(n_kv):
            klen = struct.unpack_from("<Q", mv, off)[0]
            off += 8
            if klen > 4096:
                raise ValueError("key too long")
            key = bytes(mv[off:off + klen]).decode("utf-8", "replace")
            off += klen
            typ = struct.unpack_from("<I", mv, off)[0]
            off += 4
            if key == "general.architecture":
                if typ != 8:
                    return ""
                vlen = struct.unpack_from("<Q", mv, off)[0]
                if vlen > 512:
                    return ""
                return bytes(mv[off + 8:off + 8 + vlen]).decode("utf-8", "replace").strip().lower()
            off = _skip_value(typ, off)
        return ""
    except Exception:
        return ""


async def _repo_arch(client: httpx.AsyncClient, repo: str) -> tuple[str, str]:
    """该仓库「这次会下载的那一份 GGUF」的架构判定 → (arch, status)。

    status 四态（与界面上的 archStatus 同一套词）：
      · "confirmed"   —— 探到架构，且本机引擎认它，也是能对话的文本架构；
      · "non-llm"     —— 探到架构，引擎也认，但它不是可对话 LLM（clip / bert 家族 / t5encoder）；
      · "unsupported" —— 探到架构，但本机引擎不认识（实测 antirez/deepseek-v4-gguf = deepseek4_mtp_support）；
      · "unconfirmed" —— 没探到（网络失败 / 仓库里没有可下载的单文件 GGUF）。
    缓存值就是这一对，命中即返回，不再发请求。
    """
    cached, val = _arch_cache_get(repo)
    if cached:
        return val
    from urllib.parse import quote

    meta = await client.get(f"{HF_API}/models/{repo}")
    raw = meta.json() if meta.status_code == 200 else None
    if not isinstance(raw, dict):
        return "", "unconfirmed"  # 仓库元数据都没拿到 → 未确认（不是「不支持」）
    fname = _download_file_of(raw)
    if not fname:
        return "", "unconfirmed"  # 没有单文件 GGUF 可下（只有分片）→ 未确认
    url = f"{HF_MIRROR}/{repo}/resolve/main/{quote(fname)}"
    from app.models import engine_supports_arch as _engine_supports_arch

    arch = ""
    for size in (_ARCH_PROBE_RANGE, _ARCH_PROBE_RANGE_MAX):
        r = await client.get(url, headers={"Range": f"bytes=0-{size - 1}"})
        if int(getattr(r, "status_code", 0) or 0) not in (200, 206):
            continue
        arch = _gguf_arch_from_head(r.content)
        if arch:
            break
    if not arch:
        return "", "unconfirmed"  # 头部没读到架构键 → 未确认
    if not _engine_supports_arch(arch):
        val = ("", "unsupported")
    elif arch in _NON_LLM_ARCHES:
        val = (arch, "non-llm")
    else:
        val = (arch, "confirmed")
    _arch_cache_put(repo, val)
    return val


async def _attach_arch(items: list[dict[str, Any]]) -> None:
    """给条目补架构状态（arch / archStatus 两格），口径全在 _repo_arch 一处。

    收窄不在这里做（探测与收窄分开，测试可以分别钉住两边）：
    引擎不支持 → 由 _filter_arch 丢；非对话架构 → 由 _apply_arch_kind 改判 kind 后收。
    受控并发 + 超时 + 整段预算 + TTL 缓存，任何一个仓库失败只影响它自己，
    绝不让整次搜索失败；探不到的照样标 unconfirmed 保留。
    """

    repos: list[str] = []
    for x in items:
        repo = _probe_repo(x)
        if repo and repo not in repos:
            repos.append(repo)
    if not repos:
        return
    _sync_set(phase="arch", candTotal=len(repos))
    archs: dict[str, Any] = {}
    done_n = 0
    try:
        timeout = httpx.Timeout(_ARCH_PROBE_TIMEOUT, connect=min(3.0, _ARCH_PROBE_TIMEOUT))
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            sem = asyncio.Semaphore(_ARCH_PROBE_CONCURRENCY)

            async def one(repo: str) -> tuple[str, tuple[str, str]]:
                async with sem:
                    return repo, await _repo_arch(client, repo)

            tasks = [asyncio.create_task(one(r)) for r in repos]
            done, pending = await asyncio.wait(tasks, timeout=_ARCH_PROBE_TOTAL_BUDGET)
            for t in pending:
                t.cancel()
            for t in done:
                done_n += 1
                try:
                    repo, a = t.result()
                except Exception:
                    repo, a = "", ("", "unconfirmed")
                if repo:
                    archs[repo] = a
                _sync_set(probedArch=done_n)
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
    except Exception:
        pass  # 拿到多少算多少，其余留「未确认」，绝不因此让整次搜索失败
    for x in items:
        repo = _probe_repo(x)
        arch, status = archs.get(repo, ("", "unconfirmed"))
        x["arch"] = arch
        x["archStatus"] = status
        if status == "confirmed":
            _apply_arch_kind(x)


def _apply_arch_kind(item: dict[str, Any]) -> None:
    """按架构把「不是可对话 LLM」的条目改判成 other（列表于是收掉它）。

    只动那些靠 pipeline_tag / 名字别名认成 llm、但架构明确写着「非对话模型」的条目
    （见 _NON_LLM_ARCHES：clip / bert 家族 / t5encoder …）。
    """
    arch = str(item.get("arch") or "").strip().lower()
    if not arch or arch not in _NON_LLM_ARCHES:
        return
    if str(item.get("kind") or "") != "llm":
        return
    item["kind"] = "other"
    item["kindByArch"] = True
    item["kindGuessed"] = False


def _filter_arch(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """移除架构不受引擎支持的条目（「未确认」一律保留）。"""
    return [x for x in items if x.get("archStatus") != "unsupported"]


async def _arch_status(probe: dict[str, Any]) -> tuple[str, str]:
    """单条目的架构状态 → (arch, archStatus)，口径与 _attach_arch 完全同源。

    probe 传的是「该探哪个仓库」的那份最小条目（远程条目就是它自己，聚合推荐条目用 ggufRepo）。
    """
    repo = _probe_repo(probe)
    if not repo:
        return "", "unconfirmed"
    try:
        timeout = httpx.Timeout(_ARCH_PROBE_TIMEOUT, connect=min(3.0, _ARCH_PROBE_TIMEOUT))
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            return await _repo_arch(client, repo)
    except Exception:
        return "", "unconfirmed"


async def _with_arch(detail: dict[str, Any], probe: dict[str, Any]) -> dict[str, Any]:
    """详情里补 arch / archStatus（详情页要能说清「为什么这个不能下载」）。"""
    arch, status = await _arch_status(probe)
    detail["arch"] = arch
    detail["archStatus"] = status
    return detail


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
    """Search Hugging Face for GGUF repos (whitelist: LLM only)."""
    limit = max(1, min(int(limit or 40), 100))
    search = (q or "").strip()
    if not search:
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

    _sync_set(phase="listing", page=1, pagesFetched=1)
    try:
        async with httpx.AsyncClient(timeout=45.0) as client:
            r = await client.get(f"{HF_API}/models", params=params)
            r.raise_for_status()
            raw_list = r.json()
    except Exception as e:
        # 不再静默吞掉：整页拉取失败（镜像 503 / 超时）必须让界面看得见，
        # 否则「列表空」和「镜像挂了」在界面上是同一种样子（见 _SYNC 的注释）。
        _note_search_error(e)
        return []

    if not isinstance(raw_list, list) or not raw_list:
        # 请求通了但一条都没有：多半也是上游 503（真机实测 hf-mirror 会这样）。
        # 这一轮**不能**据此固化（见 search_models 的 fullOk 分支）。
        _note_error("empty", "镜像返回 0 条（可能上游 503，稍后重试）")
        return []

    items = [_from_hf_item(x) for x in raw_list if x.get("id")]
    # 标签白名单先粗筛（只留 text-generation / conversational 这一类 —— VL / 重排 / 分类
    # 一律不进列表），再探架构（pipeline_tag 管不到文件头那一层），
    # 探到「不是可对话 LLM 的架构」再改判一次 kind，最后才按 kind 收口。
    # 过滤放在补体积 / 探架构之前能省的请求：先粗筛一轮，只给会被保留的条目花探测开销。
    items = _filter_kind(items, kind)
    items = items[:limit]
    # 体积只能逐个仓库拉元数据补（搜索接口不给文件字节数），只给会被保留的这 limit 条补。
    await _attach_sizes(items)
    # 架构是第二道白名单：pipeline_tag 对了但 general.architecture 引擎不认识（实测
    # antirez/deepseek-v4-gguf = deepseek4_mtp_support）的一律不收，见 _filter_arch。
    await _attach_arch(items)
    items = _filter_kind(items, kind)
    return _filter_arch(items)


def _filter_kind(items: list[dict[str, Any]], kind: str) -> list[dict[str, Any]]:
    """按白名单收窄 kind：llm 一类，all 也只留这一类（embedding 已不在列表口径里）。

    认得出、但已不在口径里的档位（embedding）返回空 —— 老界面 / 老缓存里可能还留着这一档，
    它必须查不到东西，绝不能被当成 all 又把向量模型放回来。认不出的值才按 all 处理。
    """
    want = (kind or "all").strip().lower()
    if want == "embedding":
        return []
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
    curated = [dict(x) for x in CURATED]
    if query:
        curated = [
            x
            for x in curated
            if query in x["id"].lower() or query in x.get("name", "").lower()
        ]
    curated = _filter_kind(curated, kind)
    # remote 已经过 _hf_search 的白名单与架构收窄；这里再收一次，保证合并结果只含列表认的那一类。
    remote = _filter_kind(remote, kind)
    # 聚合推荐条目也补上架构状态（同样按 ggufRepo 探），否则它们会在界面上永远是「未确认」。
    for x in curated:
        x.setdefault("arch", None)
        x.setdefault("archStatus", "unconfirmed")
        x.setdefault("kindGuessed", False)

    seen = set()
    out: list[dict[str, Any]] = []
    for x in curated + remote:
        mid = x.get("id")
        if not mid or mid in seen:
            continue
        seen.add(mid)
        out.append(x)
    return out


async def _hf_search_newest(
    kind: str,
    cutoff: str,
    known_ids: set[str] | None = None,
) -> list[dict[str, Any]]:
    """只按时间拉最新：sort=createdAt 倒序逐页取，遇到「整页都已在固化表里」就收手。

    cutoff = 固化表里已固化的最新日期（YYYY-MM-DD），known_ids = 固化表已有的 id 集合。
    这一步是「后续再拉取仅根据时间拉取最新，其他忽略」的唯一实现：**不做**整页按下载量重搜，
    也不因为这次没返回就把老条目从列表里拿掉（它们在固化表里）。任何一页失败都只影响这一页。

    两处成本控制（真机实测每轮 3 页 / 12~17s 的来源）：
      · 已知 id 一律丢掉：它们连体积 / 架构都不用再探（否则每轮都给老条目白跑一遍对齐）；
      · 停页判据从「日期切点」换成「整页都是老 id」：HF 按 createdAt 倒序的第一页天天都
        「比上次新」（今天新建的仓库本来就有上百条），日期切点于是永远停不下来。
        日期 cut 仍然保留，作为镜像不认 sort=createdAt 时（返回顺序乱）的兜底。
    """
    if not cutoff:
        return []
    known = {str(x) for x in (known_ids or ())}
    out: list[dict[str, Any]] = []
    cursor = ""
    deadline = time.time() + _STORE_NEWEST_BUDGET
    pages = 0
    for page in range(_STORE_NEWEST_PAGES):
        left = deadline - time.time()
        if left <= 1.0:
            break  # 预算用完：固化表本来就能出列表，剩下的留给下一次拉取
        params: dict[str, Any] = {
            "search": "gguf",
            "filter": "gguf",
            "limit": _STORE_NEWEST_PAGE_LIMIT,
            "full": "true",
            "config": "false",
            "sort": "createdAt",
            "direction": "-1",
        }
        if page > 0:
            # HF 的分页游标（Link 头里的 next）；拿不到就到此为止，下一轮拉取再补。
            if not cursor:
                break
            params["cursor"] = cursor
        pages += 1
        _sync_set(phase="listing", page=pages, pagesFetched=pages)
        try:
            async with httpx.AsyncClient(timeout=max(3.0, min(15.0, left))) as client:
                r = await client.get(f"{HF_API}/models", params=params)
                r.raise_for_status()
                raw_list = r.json()
                cursor = _next_cursor(r.headers.get("link") or "")
        except Exception as e:
            _note_search_error(e, what="增量")
            break
        if not isinstance(raw_list, list) or not raw_list:
            if not out:
                # 通了但一条没有：多半上游 503。这一轮不算「核过」，10 分钟闸不会关上，
                # 用户再点一次刷新照样会真的去问一次。
                _note_error("empty", "镜像没有返回任何条目（可能上游 503）", hard=False)
            break
        items = [_from_hf_item(x) for x in raw_list if x.get("id")]
        fresh = [
            x for x in _only_newer_than(items, cutoff)
            if str(x.get("id") or "") not in known
        ]
        out.extend(fresh)
        if known:
            if not fresh:
                break  # 整页都是已固化的 id：增量取完了（这页之后的只会更老）
        elif len(fresh) < len(items):
            break  # 没有固化表时退回日期切点：这一页已经跨过切点
        if not cursor:
            break
    return out


def _next_cursor(link_header: str) -> str:
    """从 Link: <...?cursor=xxx>; rel="next" 里抠出 cursor（没有返回空串）。"""
    for part in str(link_header or "").split(","):
        if 'rel="next"' not in part:
            continue
        seg = part.split("cursor=")
        if len(seg) < 2:
            continue
        return seg[1].split(">")[0].split("&")[0].strip()
    return ""


def _only_newer_than(items: list[dict[str, Any]], cutoff: str) -> list[dict[str, Any]]:
    """只留 createdAt 不早于 cutoff 的条目（同一天也算：那天的仓库可能上一轮还没上）。"""
    if not cutoff:
        return list(items)
    out = []
    for x in items:
        created = str(x.get("createdAt") or "")[:10]
        if created and created >= cutoff:
            out.append(x)
    return out


def _store_frozen_items(kind: str) -> list[dict[str, Any]]:
    """固化表整份列表 + 补齐漏掉的聚合推荐条目（老版本固化的表里可能没有它们）。

    聚合推荐照样要过 kind 白名单：CURATED 里有 embedding 一类（bge / MiniLM），
    不筛就会让固化口径比整页口径多出「已经不该出现在列表里」的条目。
    """
    items = _store_items()
    have = {str(x.get("id") or "") for x in items}
    for c in CURATED:
        if c["id"] in have:
            continue
        y = dict(c)
        y.setdefault("arch", None)
        y.setdefault("archStatus", "unconfirmed")
        y.setdefault("kindGuessed", False)
        items.append(y)
    return _filter_kind(items, kind)


async def search_models(
    q: str = "",
    kind: str = "all",
    limit: int = 50,
    sort: str = "downloads",
    size_band: str = "",
    recent_only: bool = False,
    force: bool = False,
) -> list[dict[str, Any]]:
    """在线模型列表：固化表 + 只按时间取增量。

    四条口径（顺序即优先级，force 一律最优先）：
      · 带搜索词 / force / 表是空的 / 上一轮整页没成功（fullOk=false）→ 整页拉取，
        只有**真拿到远程条目**时才固化（空手而归不写 items，见 _store_mark_full_bad）；
      · 表已固化且距上次成功核增量不到 _STORE_MIN_INTERVAL → 直接拿固化表，零请求；
      · 其余 → 固化表 + 按 createdAt 只问「固化表里没有的 id」（稳态 ≤1 页），并入后落盘。
    全程原地更新 _SYNC 状态机（见 sync_state），界面轮询即可显示阶段与进度。
    """
    os.environ.setdefault("HF_ENDPOINT", HF_MIRROR)
    kind = (kind or "all").strip().lower()
    limit = max(1, min(int(limit or 50), 100))
    query = (q or "").strip()
    _store_seed_caches()
    store = _store_load()

    if not query and store.get("items") and not force and store.get("fullOk", True):
        # ── 固化了的口径 ────────────────────────────────────────────────
        # 列表直接用固化表（离线也有内容、秒开），再按时间问一次「固化表里没有的 id」
        # 的增量；新增条目探完体积 / 架构后并入表。其余一律不动。
        _sync_reset("frozen")
        _LAST_SYNC["mode"] = "frozen"
        _LAST_SYNC["added"] = 0
        if _interval_fresh(store):
            # 刚核过增量：这一轮一个网络请求都不发（force 才越过这道闸）。
            _sync_set(phase="done", intervalSkipped=True)
        else:
            known = {str(k) for k in (store.get("items") or {})}
            known |= {str(v["id"]) for v in (store.get("items") or {}).values() if v.get("id")}
            known.discard("")
            fresh = await _hf_search_newest(
                kind, str(store.get("newestCreatedAt") or ""), known
            )
            fresh = _filter_kind(fresh, kind)
            if fresh:
                await _attach_sizes(fresh)
                await _attach_arch(fresh)
                fresh = _filter_kind(fresh, kind)
                fresh = _filter_arch(fresh)
                _sync_set(phase="merge")
                _LAST_SYNC["added"] = _store_put(fresh)
                _store_seed_caches()
            # 拿到真实响应才算「核过」：空手而归就留给下一次，别把 10 分钟闸关上
            # （否则镜像挂一次，用户再点刷新也只会拿固化表糊弄过去）。
            if _SYNC.get("phase") != "error" and _SYNC.get("errorKind") != "empty":
                _store_mark_checked()
        items = _store_frozen_items(kind)
    else:
        # ── 首拉 / 搜索 / 强制整页重拉 / 上一轮整页没成功 ─────────────────
        _sync_reset("full")
        _LAST_SYNC["mode"] = "full"
        _LAST_SYNC["added"] = 0
        remote = await _hf_search(q, kind, limit, sort)
        if not remote and not query:
            # 整页空手（镜像 503 / 超时）：固化表一个字节都不动，列表回落到已固化条目。
            # 否则就会像真机那样「6 条聚合推荐被当成整份在线列表冻结，从此不再整页拉」。
            _store_mark_full_bad()
            if _SYNC.get("phase") != "error":
                _sync_set(
                    phase="error",
                    error="镜像没有返回任何条目（可能上游 503，稍后重试）",
                    errorKind="empty",
                )
            items = _store_frozen_items(kind) if store.get("items") else _merge_curated([], q, kind)
        else:
            items = _merge_curated(remote, q, kind)
            # 聚合推荐条目没经过 _hf_search，架构要在这里补（探到非 LLM 架构的在 _apply_arch_kind
            # 里改判成 other，下面那轮 _filter_kind 就会把它们收掉）。
            await _attach_arch(items)
            for x in items:
                _apply_arch_kind(x)
            items = _filter_kind(items, kind)
            items = _filter_arch(items)
            _sync_set(phase="merge")
            if not query:
                # 整页拉到的这一份就此固化（体积 / 架构一并落盘，下次不再重探）。
                _store_put(items)
                _store_mark_full_ok()

    items = _filter_size(items, size_band)
    items = _filter_recent(items, recent_only)

    if sort == "likes":
        items.sort(key=lambda x: int(x.get("likes") or 0), reverse=True)
    else:
        items.sort(key=lambda x: int(x.get("downloads") or 0), reverse=True)

    # Keep curated matches near top when query empty
    if not query:
        curated_ids = {x["id"] for x in CURATED}
        head = [x for x in items if x["id"] in curated_ids]
        tail = [x for x in items if x["id"] not in curated_ids]
        items = head + tail

    # 收尾：成功了就推到 done；失败保留 error —— 界面的红条与「重试」都要靠它。
    if _SYNC.get("phase") != "error":
        _sync_set(phase="done", added=int(_LAST_SYNC.get("added") or 0))

    return items[:limit]


async def model_detail(model_id: str) -> dict[str, Any]:
    os.environ.setdefault("HF_ENDPOINT", HF_MIRROR)
    mid = str(model_id or "").strip()
    hit = next((x for x in CURATED if x["id"] == mid), None)
    if hit:
        d = {
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
        return await _with_arch(d, dict(hit))

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
    d = {
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
    return await _with_arch(d, {"id": mid})
