"""一次分析的完整流程：解码 → 帧特征 → onset → 速度 → 拍网格 → 能量 → 段落 → 剪辑 → 图。

对外两个入口：

* `prepare(path, options, cache)` → 上下文（校验路径、stat、算缓存键）
* `run(ctx, cache)` → 响应体（可能命中缓存）
* `analyze_file(path, options, cache=None)` → 上面两步合一（`scripts/check.py` 直接调用）

响应体顶层 10 个块一个不多一个不少（schema `additionalProperties:false`）：
ok / contract / meta / global / beatGrid / onsets / energy / sections / visuals / edit / diagnostics。
服务层专属的新增字段全部落在子层（`diagnostics.cache` / `diagnostics.fieldGuide` / `visuals[].artifact`）。
高频曲线与逐帧池化是同一份数据的两种形态，都挂在 `energy.curves` / `energy.perFrame` 下
（顶层块数不变）：raw 曲线看包络、perFrame 按 `options.fps` 给逐帧强度，卡点闪拍直接用后者。
人工覆盖（`options.overrides`）是组装完、自检后的**最后一步**（`overrides.apply`）：合并完再跑一遍
同一套不变量校验，结果写进 `diagnostics.overridesApplied`。

全部注释与消息为中文。
"""

from __future__ import annotations

import os
import time
import traceback

import numpy as np

from . import beats as beats_mod
from . import cache as cache_mod
from . import contract
from . import decode as decode_mod
from . import dsp
from . import overrides as overrides_mod
from . import pngw
from . import sections as sections_mod
from . import tempo as tempo_mod
from .contract import AnalyzeError

_EPS = 1e-12
#: 默认选项（契约 §5.1）
DEFAULT_OPTIONS = {
    "detail": False,
    "onsetsLimit": 2000,
    "sections": {"method": "energyPhase", "snapToDownbeat": True},
    "viz": {"enabled": True, "kinds": ["spectrogram"]},
    "loudness": False,
    "cache": "auto",
    "fps": 30,
    "overrides": {},
}
VIZ_KINDS = ("spectrogram", "waveform", "beatOverlay", "energyCurve")
SECTION_METHODS = ("energyPhase", "recurrence", "manual")
CACHE_MODES = ("auto", "refresh", "bypass")
#: 逐帧池化的可选帧率（与节点 ⚙ 的选项一一对应，默认 30）
FPS_CHOICES = (24, 25, 30, 50, 60)
#: 鼓型 / 强度相关常量
ONSET_MIN_GAP_SEC = 0.03          # 峰拾取最小间隔（契约：30 ms）
ONSET_DELTA = 0.05                # 峰拾取阈值（归一化包络）
ATTACK_LAG_SEARCH_SEC = 0.06      # 谱通量峰 → 真实 attack 的搜索半径


# ---------------------------------------------------------------- 选项


def normalize_options(raw) -> tuple[dict, list]:
    """归一化选项（未知键忽略并回显），返回 (options, ignoredKeys)。"""
    raw = raw if isinstance(raw, dict) else {}
    ignored: list[str] = []
    opts = {
        "detail": bool(DEFAULT_OPTIONS["detail"]),
        "onsetsLimit": int(DEFAULT_OPTIONS["onsetsLimit"]),
        "sections": dict(DEFAULT_OPTIONS["sections"]),
        "viz": {"enabled": True, "kinds": list(DEFAULT_OPTIONS["viz"]["kinds"])},
        "loudness": bool(DEFAULT_OPTIONS["loudness"]),
        "cache": DEFAULT_OPTIONS["cache"],
        "fps": int(DEFAULT_OPTIONS["fps"]),
        "overrides": dict(DEFAULT_OPTIONS["overrides"]),
        "overridesIgnored": [],
    }
    for key, value in raw.items():
        if key == "detail":
            opts["detail"] = bool(value)
        elif key == "fps":
            try:
                n = int(value)
            except Exception:
                n = 0
            if n in FPS_CHOICES:
                opts["fps"] = int(n)
            else:
                ignored.append("fps=%s" % value)
        elif key == "onsetsLimit":
            try:
                n = int(value)
            except Exception:
                n = int(DEFAULT_OPTIONS["onsetsLimit"])
            opts["onsetsLimit"] = int(max(1, min(20000, n)))
        elif key == "loudness":
            opts["loudness"] = bool(value)
        elif key == "cache":
            mode = str(value or "").lower()
            if mode in CACHE_MODES:
                opts["cache"] = mode
            else:
                ignored.append("cache=%s" % value)
        elif key == "overrides":
            # 人工覆盖：规范成 JSON 安全的结构（进缓存键），不认识的条目回显进 ignoredOptions
            norm_overrides, override_ignored = overrides_mod.normalize(value)
            opts["overrides"] = norm_overrides
            opts["overridesIgnored"] = list(override_ignored)
            for name in override_ignored:
                ignored.append(str(name))
        elif key == "sections":
            sub = value if isinstance(value, dict) else {}
            for k, v in sub.items():
                if k == "method":
                    m = str(v)
                    if m in SECTION_METHODS:
                        opts["sections"]["method"] = m
                    else:
                        ignored.append("sections.method=%s" % v)
                elif k == "snapToDownbeat":
                    opts["sections"]["snapToDownbeat"] = bool(v)
                else:
                    ignored.append("sections.%s" % k)
        elif key == "viz":
            sub = value if isinstance(value, dict) else {}
            for k, v in sub.items():
                if k == "enabled":
                    opts["viz"]["enabled"] = bool(v)
                elif k == "kinds":
                    kinds = []
                    if isinstance(v, (list, tuple)):
                        for item in v:
                            name = str(item)
                            if name in VIZ_KINDS and name not in kinds:
                                kinds.append(name)
                            elif name not in VIZ_KINDS:
                                ignored.append("viz.kinds=%s" % item)
                    if kinds:
                        opts["viz"]["kinds"] = kinds
                else:
                    ignored.append("viz.%s" % k)
        else:
            ignored.append(str(key))
    if not opts["viz"]["enabled"]:
        opts["viz"]["kinds"] = []
    if not opts["viz"]["kinds"]:
        opts["viz"]["kinds"] = list(DEFAULT_OPTIONS["viz"]["kinds"]) if opts["viz"]["enabled"] else []
    return opts, ignored


def hashable_options(opts: dict) -> dict:
    """参与缓存键的选项（不含 cache 模式）。"""
    return {
        "detail": bool(opts["detail"]),
        "onsetsLimit": int(opts["onsetsLimit"]),
        "sections": {
            "method": str(opts["sections"]["method"]),
            "snapToDownbeat": bool(opts["sections"]["snapToDownbeat"]),
        },
        "viz": {"enabled": bool(opts["viz"]["enabled"]),
                "kinds": sorted(str(k) for k in opts["viz"]["kinds"])},
        "loudness": bool(opts["loudness"]),
        "fps": int(opts["fps"]),
        # 人工覆盖进键：换了 overrides 必须重算，不能拿旧结果顶
        "overrides": _override_key(opts.get("overrides")),
    }


def _override_key(norm: dict | None) -> dict:
    """人工覆盖的规范化摘要（用于缓存键；空覆盖折成同一份，别虚增缓存条目）。"""
    norm = norm if isinstance(norm, dict) else {}
    return {
        "globalVisualOffsetMs": norm.get("globalVisualOffsetMs"),
        "forcedBpm": norm.get("forcedBpm"),
        "downbeatShift": norm.get("downbeatShift"),
        "sections": list(norm.get("sections") or []),
        "cues": [{"t": c.get("t"), "name": str(c.get("name") or ""), "strength": c.get("strength")}
                 for c in (norm.get("cues") or [])],
    }


# ---------------------------------------------------------------- 路径与上下文


def resolve_audio_path(raw) -> str:
    """audioPath / path → 本机绝对路径（接受 file:// URL）。非法一律 E_INPUT_MISSING。"""
    text = str(raw or "").strip()
    if not text:
        raise AnalyzeError("E_INPUT_MISSING", "缺少 audioPath（或旧字段名 path）", "audioPath 为空")
    if text.lower().startswith("file://"):
        from urllib.parse import unquote, urlparse
        parsed = urlparse(text)
        path = unquote(parsed.path or "")
        if parsed.netloc and parsed.netloc not in ("", "localhost"):
            path = "//" + parsed.netloc + path
        if os.name == "nt" and path.startswith("/") and len(path) > 2 and path[2] == ":":
            path = path[1:]
        text = path
    elif "://" in text:
        raise AnalyzeError("E_INPUT_MISSING", "只接受本机文件路径或 file:// URL",
                           "拒绝远程地址：%s" % text[:120])
    if not os.path.isabs(text):
        raise AnalyzeError("E_INPUT_MISSING", "audioPath 必须是本机绝对路径",
                           "收到相对路径：%s" % text[:260])
    if os.path.isdir(text):
        raise AnalyzeError("E_INPUT_MISSING", "audioPath 指向目录而不是文件",
                           text[:260])
    if not os.path.isfile(text):
        raise AnalyzeError("E_INPUT_MISSING", "输入文件不存在",
                           text[:260])
    return os.path.realpath(text)


def prepare(path, options, cache: "cache_mod.Cache | None" = None) -> dict:
    """校验输入 + stat + 算缓存键，返回上下文。"""
    real = resolve_audio_path(path)
    try:
        st = cache_mod.stat_of(real)
    except OSError as exc:
        raise AnalyzeError("E_INPUT_MISSING", "无法读取输入文件", "%s: %s" % (type(exc).__name__, exc))
    if st["size"] > contract.MAX_SOURCE_BYTES:
        limit = contract.MAX_SOURCE_BYTES
        limit_text = ("%d GiB" % (limit // (1024 ** 3))) if limit >= 1024 ** 3 \
            else ("%d MiB" % max(1, limit // (1024 ** 2)))
        raise AnalyzeError(
            "E_TOO_LONG",
            "源文件超过体积上限",
            "体积 %d 字节 > 上限 %s（%d 字节）" % (st["size"], limit_text, limit),
        )
    opts, ignored = normalize_options(options)
    opt_hash = cache_mod.options_hash(hashable_options(opts))
    key = cache_mod.key_for(real, st["size"], st["mtimeMs"], opt_hash)
    return {
        "path": real,
        "stat": st,
        "options": opts,
        "ignored": ignored,
        "optionsHash": opt_hash,
        "key": key,
        "key16": key[:16],
    }


def analyze_file(path, options=None, cache: "cache_mod.Cache | None" = None) -> dict:
    """直接调用入口（不经 HTTP）：校验 → 命中缓存或重算 → 响应体。"""
    if cache is None:
        cache = cache_mod.Cache(_default_root())
    ctx = prepare(path, options, cache)
    return run(ctx, cache)


#: 数据目录（`cache/` `artifacts/` `api-key.txt` 的父目录）。serve.main 起来时用 set_root()
#: 钉死，保证「产物路径」与「Cache 落盘目录」永远是同一个根；没钉时按 MT_AUDIO_ROOT → cwd。
_ROOT: dict[str, str] = {}


def set_root(root: str) -> str:
    """钉住本次进程的数据目录（serve.main / check.py 用）。"""
    _ROOT["path"] = os.path.abspath(root)
    _ARTIFACT_ROOT_CACHE.clear()
    return _ROOT["path"]


def _default_root() -> str:
    """数据目录：set_root() > MT_AUDIO_ROOT > 当前工作目录。"""
    pinned = _ROOT.get("path")
    if pinned:
        return pinned
    return os.path.abspath(os.environ.get("MT_AUDIO_ROOT") or os.getcwd())


# ---------------------------------------------------------------- 执行（含缓存）


def run(ctx: dict, cache: "cache_mod.Cache", ffmpeg: str | None = None) -> dict:
    """执行一次分析：命中缓存直接回；否则算完写缓存（策略见 options.cache）。"""
    opts = ctx["options"]
    mode = str(opts.get("cache") or "auto")
    key = ctx["key"]
    key16 = ctx["key16"]
    kinds = list(opts["viz"]["kinds"])

    if mode in ("auto",):
        entry = cache.entry(key)
        if entry is not None and cache.artifacts_exist(key16, kinds):
            body = cache.read_result(key)
            if body is not None:
                body.setdefault("diagnostics", {})["cache"] = {
                    "hit": True, "key": key,
                    "createdAt": entry.get("createdAt") or entry.get("lastUsedAt") or "",
                    "reason": "",
                }
                cache.touch()
                return body
    elif mode == "refresh" and cache.entry(key) is not None:
        # 强制重算：顺手把旧条目丢掉，避免新旧混着留在盘上
        cache._drop(key)

    body, pngs = _compute(ctx, ffmpeg)
    now = _iso_now()
    reason = ""
    if mode == "bypass":
        reason = "bypass"
    else:
        # 分析期间源文件被改 → 不写缓存（宁可下次重算，也不留对不上号的结果）
        try:
            after = cache_mod.stat_of(ctx["path"])
        except OSError:
            after = None
        if after is None or not cache_mod.same_stat(ctx["stat"], after):
            reason = "source_changed"
    if reason:
        _publish_artifacts(cache, key16, pngs)
    else:
        ok = cache.write(key, body, ctx["stat"], ctx["optionsHash"], pngs)
        if not ok:
            reason = "write_failed"
            _publish_artifacts(cache, key16, pngs)
    body["diagnostics"]["cache"] = {"hit": False, "key": key, "createdAt": now, "reason": reason}
    return body


def _publish_artifacts(cache: "cache_mod.Cache", key16: str, pngs: dict) -> None:
    """不写缓存时也要把 PNG 落到 artifacts（`visuals[].path` 必须真实存在）。"""
    import shutil
    base = os.path.join(cache.artifacts_dir, key16)
    tmp = base + ".tmp-%d" % os.getpid()
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp, exist_ok=True)
    for kind, data in pngs.items():
        with open(os.path.join(tmp, "%s.png" % kind), "wb") as fh:
            fh.write(data)
    shutil.rmtree(base, ignore_errors=True)
    try:
        os.replace(tmp, base)
    except Exception:
        shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------- 主体


def _compute(ctx: dict, ffmpeg: str | None = None) -> tuple[dict, dict]:
    """跑完整分析链，返回 (响应体, {kind: png 字节})。"""
    path = ctx["path"]
    opts = ctx["options"]
    st = ctx["stat"]
    t_all = time.perf_counter()

    ffmpeg = ffmpeg or decode_mod.find_ffmpeg(os.environ.get("MT_AUDIO_FFMPEG"))
    ffprobe = decode_mod.find_ffprobe(ffmpeg)
    ffmpeg_ver = decode_mod.ffmpeg_version(ffmpeg)

    # —— 1) 探测：先按时长/音轨判定，避免白跑一遍解码
    info = decode_mod.probe(ffprobe, path)
    if info.get("hasAudio") is False:
        raise AnalyzeError("E_NO_AUDIO_STREAM", "文件里没有音频流",
                           decode_mod.streams_summary(info))
    probe_dur = info.get("durationSec")
    grid, downsampled = contract.frame_grid(probe_dur)
    if probe_dur is not None and probe_dur > contract.MAX_DURATION_SEC:
        raise AnalyzeError(
            "E_TOO_LONG", "素材超过时长上限",
            "时长 %.1f 秒 > 上限 %d 秒（按契约不截断分析，请先切片）" % (
                probe_dur, contract.MAX_DURATION_SEC),
        )
    sr = int(grid["sr"])
    hop = int(grid["hopLength"])
    n_fft = int(grid["nFft"])

    # —— 2) 解码
    t0 = time.perf_counter()
    x = decode_mod.decode(ffmpeg, path, sr)
    duration = float(x.size) / float(sr) if sr else 0.0
    decode_ms = (time.perf_counter() - t0) * 1000.0
    if duration <= 0:
        raise AnalyzeError("E_NO_AUDIO_STREAM", "解码后长度为 0", "没有可分析的采样点")
    if duration > contract.MAX_DURATION_SEC:
        raise AnalyzeError(
            "E_TOO_LONG", "素材超过时长上限",
            "解码后时长 %.1f 秒 > 上限 %d 秒" % (duration, contract.MAX_DURATION_SEC))
    if probe_dur is None:
        # 没有 ffprobe 时长时，用解码结果补一次网格决策
        grid, downsampled = contract.frame_grid(duration)
        if int(grid["sr"]) != sr:
            sr = int(grid["sr"])
            hop = int(grid["hopLength"])
            n_fft = int(grid["nFft"])
            x = decode_mod.decode(ffmpeg, path, sr)
            duration = float(x.size) / float(sr)

    warnings: list[dict] = []

    # —— 3) 帧级特征（一次扫描：谱通量 / 三带 / 6 带 / 鼓型窄带 / 平坦度 / 频谱图）
    t0 = time.perf_counter()
    feats = dsp.frame_features(x, sr, hop, n_fft, downsampled=downsampled)
    env = dsp.flux_norm(feats)
    attack_env, attack_dt, _ = dsp.attack_curve(x, sr)
    events, lag_sec = _detect_onsets(feats, env, attack_env, attack_dt, duration)
    # 高频曲线（hop≈5.8 ms，等时间口径）+ 逐帧池化：瞬态与响度两条支路共用同一份曲线，
    # 给逐帧闪拍与渲染共用；体积按 detail 放大预算，超出按整数 stride 抽稀
    curves = dsp.hi_rate_curves(x, sr)
    per_frame = dsp.per_frame_pool(
        curves, float(opts["fps"]), duration,
        max_points=(dsp.PERFRAME_MAX_POINTS_DETAIL if opts["detail"]
                    else dsp.PERFRAME_MAX_POINTS))
    curve_block = dsp.curve_series(
        curves, max_points=(dsp.CURVE_MAX_POINTS_DETAIL if opts["detail"]
                            else dsp.CURVE_MAX_POINTS))
    # 曲线与 onset 同属瞬态分析，耗时一并计入 onsets 桶（timingsMs 的键是契约固定表，不加新键）
    onsets_ms = (time.perf_counter() - t0) * 1000.0

    # —— 4) 速度（三路互验 + 候选表 + fold）
    t0 = time.perf_counter()
    ev_times = np.array([e["t"] for e in events], dtype=np.float64) if events else np.zeros(0)
    ev_strength = np.array([e["strength"] for e in events], dtype=np.float64) if events else np.zeros(0)
    if events:
        order = np.argsort(ev_times, kind="stable")
        ev_times, ev_strength = ev_times[order], ev_strength[order]
    fps = sr / float(hop)
    tempo_info = tempo_mod.estimate(env, ev_times, ev_strength, fps, duration)
    for code in tempo_info.get("warnings", []):
        _add_warning(warnings, code, _warning_message(code, downsampled=downsampled,
                                                      duration=duration, extra=tempo_info))
    # —— 5) 能量相位 / 关键转折（先算：段落要用，也是分段速度图的切段提示）
    t0 = time.perf_counter()
    rms, rms_db, g_rms_db, g_peak_db = dsp.rms_grid(x, sr, contract.ENERGY_HOP_SEC)
    rms_norm = dsp.norm01(rms)
    phases = sections_mod.energy_phases(rms, rms_db, rms_norm, contract.ENERGY_HOP_SEC,
                                        duration, feats, ev_times)
    moments = sections_mod.key_moments(rms_norm, rms_db, contract.ENERGY_HOP_SEC)
    phases_ms = (time.perf_counter() - t0) * 1000.0

    # —— 6) 拍网格（DP 拍轨 → attack 精修 → 分段速度图重生成 → downbeat → bars/phrases）
    grid_info = beats_mod.build(feats, env, tempo_info, attack_env, attack_dt, lag_sec,
                                duration, rms_db, contract.ENERGY_HOP_SEC, bool(opts["detail"]),
                                map_hints=[float(p["startSec"]) for p in phases[1:]])
    beats_np = np.array(grid_info["beatsSec"], dtype=np.float64) if grid_info["beatsSec"] else np.zeros(0)
    for code in grid_info.get("warnings", []):
        _add_warning(warnings, code, _warning_message(code, downsampled=downsampled,
                                                      duration=duration, extra=grid_info,
                                                      coverage=grid_info.get("gridConfidence", 0.0)))

    # —— 7) onset 落格 + 特殊语义 + 截断
    beats_mod.associate_onsets(events, beats_np, grid_info["downbeatsSec"],
                               grid_info["barLength"], grid_info["downbeatPhase"], duration)
    _mark_specials(events, rms, contract.ENERGY_HOP_SEC, duration)
    total_events = len(events)
    if total_events == 0:
        _add_warning(warnings, "NO_ONSET", _warning_message("NO_ONSET", duration=duration))
    limit = int(opts["onsetsLimit"])
    truncated = total_events > limit
    shown = events
    if truncated:
        ranked = sorted(events, key=lambda e: (-e["strength"], e["t"]))[:limit]
        shown = sorted(ranked, key=lambda e: e["t"])
        _add_warning(warnings, "ONSETS_TRUNCATED",
                     "事件 %d 个超过上限 %d，events 只给最强的 %d 个（count 仍是真值）"
                     % (total_events, limit, limit))

    # —— 8) 段落（>1200 s 强制 energyPhase 并给 SECTIONS_FALLBACK）
    t0 = time.perf_counter()
    method = str(opts["sections"]["method"])
    if method == "recurrence" and duration > contract.SECTIONS_FALLBACK_OVER_SEC:
        method = "energyPhase"
        _add_warning(warnings, "SECTIONS_FALLBACK",
                     "素材 %.0f 秒超过 %d 秒，recurrence 自相似矩阵跑不动，已强制 energyPhase（段界仍准，标签只作参考）"
                     % (duration, contract.SECTIONS_FALLBACK_OVER_SEC))
    elif method == "recurrence":
        # 本实现只有 energyPhase 一套内核：recurrence 走同一套边界，标签诚实降权
        method = "energyPhase"
        _add_warning(warnings, "SECTIONS_FALLBACK",
                     "recurrence 段落法在本实现里退化为 energyPhase（边界来自能量相位），标签按启发式给")
    sec_list = sections_mod.sections(phases, moments, rms_norm, contract.ENERGY_HOP_SEC,
                                     duration, grid_info["downbeatsSec"], beats_np,
                                     method=method,
                                     snap=bool(opts["sections"]["snapToDownbeat"]),
                                     event_times=ev_times)
    sections_ms = phases_ms + (time.perf_counter() - t0) * 1000.0

    if duration < 6.0:
        _add_warning(warnings, "SHORT_AUDIO",
                     "素材只有 %.1f 秒，统计类字段（相位/段落/速度置信度）只作参考"
                     % duration)
    if downsampled:
        _add_warning(warnings, "DOWNSAMPLED",
                     "素材超过 %d 秒，分析采样率降为 %d Hz（Nyquist %d Hz），帧率仍是 43.066 fps、时间坐标不变；"
                     "高频带与 hat 判定收窄" % (contract.DOWNSAMPLE_OVER_SEC, sr, sr // 2))

    # —— 9) 剪辑建议
    edit_block = _edit_block(sec_list, grid_info, beats_np, events, tempo_info, duration)

    # —— 10) 图
    t0 = time.perf_counter()
    pngs = _visuals(opts, x, duration, feats, rms_norm, phases, sec_list,
                    grid_info["beatsSec"], grid_info["downbeatsSec"])
    visuals_ms = (time.perf_counter() - t0) * 1000.0

    total_ms = (time.perf_counter() - t_all) * 1000.0
    lufs = None
    if opts["loudness"]:
        lufs = decode_mod.lufs_integrated(ffmpeg, path)

    # —— 11) 组装 10 个块
    body = {
        "ok": True,
        "contract": contract.contract_block(grid),
        "meta": {
            "source": {
                "path": path,
                "bytes": int(st["size"]),
                "sha256": "",
                "container": str(info.get("container") or os.path.splitext(path)[1].lstrip(".") or ""),
            },
            "durationSec": round(duration, 4),
            "sampleRateHz": float(sr),
            "sourceSampleRateHz": info.get("sourceSampleRateHz") or float(sr),
            "channels": 1,
            "sourceChannels": int(info.get("sourceChannels") or 1),
            "decoder": {
                "tool": "ffmpeg",
                "version": ffmpeg_ver or "unknown",
                "args": "-vn -ac 1 -ar %d -f f32le" % sr,
            },
            "analyzedAt": _iso_now(),
        },
        "global": {
            "bpm": float(tempo_info["bpm"]),
            "bpmConfidence": float(tempo_info["bpmConfidence"]),
            "beatPeriodSec": float(tempo_info["beatPeriodSec"]),
            "bpmCandidates": tempo_info["candidates"],
            "timeSignature": {
                "numerator": int(grid_info["barLength"] if grid_info["downbeatMethod"] != "none" else 4),
                "denominator": 4,
                "confidence": float(_time_signature_confidence(grid_info)),
                "method": str(grid_info["downbeatMethod"] if grid_info["downbeatMethod"] != "none"
                              else "none"),
            },
            "downbeatPhase": int(grid_info["downbeatPhase"]),
            "tempoVerified": bool(tempo_info["tempoVerified"]),
            "tempoConfidence": float(grid_info.get("tempoConfidence") or 0.0),
            "key": None,
        },
        "beatGrid": {
            "beatsSec": grid_info["beatsSec"],
            "beatCount": int(grid_info["beatCount"]),
            "downbeatsSec": grid_info["downbeatsSec"],
            "firstBeatSec": float(grid_info["firstBeatSec"]),
            "downbeatMethod": str(grid_info["downbeatMethod"]),
            "gridConfidence": float(grid_info["gridConfidence"]),
            "gridCalibrationMs": float(grid_info["gridCalibrationMs"]),
            "tempoMap": grid_info.get("tempoMap") or [],
            "bars": grid_info["bars"],
            "phrases": grid_info["phrases"],
        },
        "onsets": {
            "count": int(total_events),
            "ratePerSec": round(float(total_events) / duration, 4) if duration > 0 else 0.0,
            "truncated": bool(truncated),
            "limit": int(limit),
            "events": [_event_out(e) for e in shown],
        },
        "energy": {
            "hopSec": contract.ENERGY_HOP_SEC,
            "points": int(rms.size),
            "rmsNorm": [round(float(v), 4) for v in rms_norm],
            "rmsDb": [round(float(v), 2) for v in rms_db],
            "globalDb": _global_db(g_rms_db, g_peak_db, lufs, opts["loudness"]),
            "phases": phases,
            # 两种形态同发：raw 高频曲线（hop≈5.8 ms）+ 逐帧池化 perFrame（按 options.fps）
            "curves": _curve_block(curve_block),
            "perFrame": _curve_block(per_frame, {"kick": "kickPulse"}),
        },
        "sections": sec_list,
        "visuals": [],
        "edit": edit_block,
        "diagnostics": {
            "warnings": warnings,
            "method": _method_text(downsampled, sr, n_fft, hop),
            "caveat": _caveat_text(),
            "parameters": _parameters(opts, ctx, grid, downsampled, lag_sec, tempo_info,
                                      ffmpeg_ver, total_events, grid_info,
                                      curve_block=curve_block, per_frame=per_frame),
            # 原始检测拍点（重生成网格之前那条）：网格是它的稳健拟合，对不上时看这里
            "beatsRaw": _beats_raw_block(grid_info, bool(opts["detail"])),
            "timingsMs": {
                "decode": round(decode_ms, 1),
                "onsets": round(onsets_ms, 1),
                "beats": round(max(0.0, total_ms - decode_ms - onsets_ms - sections_ms - visuals_ms), 1),
                "sections": round(sections_ms, 1),
                "visuals": round(visuals_ms, 1),
                "total": round(total_ms, 1),
            },
            "cache": {"hit": False, "key": ctx["key"], "createdAt": "", "reason": ""},
            "fieldGuide": contract.field_guide(),
        },
    }
    if opts["detail"] and grid_info.get("detail"):
        body["beatGrid"]["beats"] = grid_info["detail"]

    body["visuals"] = _visual_entries(opts, pngs, ctx["key16"])
    _sanitize(body, duration)
    # —— 12) 最后一步：人工覆盖合并（diagnostics.overridesApplied），合并后统一校验
    applied, _tail = overrides_mod.apply(body, opts, duration, rms_db=rms_db, feats=feats)
    if applied.get("applied"):
        _sanitize(body, duration)
    return body, pngs


# ---------------------------------------------------------------- onset 检测


def _detect_onsets(feats, env, attack_env, attack_dt, duration) -> tuple[list, float]:
    """谱通量峰 → attack 精修 → 事件表；返回 (events, onsetLagSec)。"""
    if feats.n_frames < 4 or env.size == 0 or float(env.max()) <= 0.0:
        return [], 0.0
    fps = feats.sr / float(feats.hop)
    min_gap = max(1, int(round(ONSET_MIN_GAP_SEC * fps)))
    pk = dsp.pick_peaks(env, min_gap, ONSET_DELTA)
    if pk.size == 0:
        return [], 0.0
    flux_t = pk.astype(np.float64) / fps
    attacks = np.array([dsp.refine_attack(attack_env, attack_dt, float(t), ATTACK_LAG_SEARCH_SEC)
                        for t in flux_t], dtype=np.float64)
    lag = float(np.median(attacks - flux_t)) if attacks.size else 0.0
    # 系统延迟校正：attack 精修链的固定偏置（contract.DETECTOR_LATENCY_MS["onsets"]），
    # 与 beats.refine 用同一个常数 —— 事件时刻与拍点必须落在同一条时间轴上。
    latency_sec = contract.detector_latency_sec("onsets")
    max_total = feats.energy_scale
    events = []
    for k, idx in enumerate(pk):
        i = int(idx)
        t = float(min(max(attacks[k] - latency_sec, 0.0), duration))
        bands, band_db = dsp.relative_bands(feats, i)
        drum, drum_conf = dsp.classify_drum(feats, i, feats.downsampled)
        energy = float(feats.total[i] / max_total) if max_total > _EPS else 0.0
        events.append({
            "t": round(t, 4),
            "strength": round(float(np.clip(env[i], 0.0, 1.0)), 3),
            "energy": round(float(np.clip(energy, 0.0, 1.0)), 3),
            "bands": {k2: round(float(v), 4) for k2, v in bands.items()},
            "bandDb": {k2: round(float(v), 2) for k2, v in band_db.items()},
            "drum": drum,
            "drumConfidence": round(float(np.clip(drum_conf, 0.0, 1.0)), 3),
            "_frame": i,
        })
    return events, lag


def _mark_specials(events: list, rms: np.ndarray, hop_sec: float, duration: float) -> None:
    """给事件补 special：hardStop（紧贴突然停顿）/ riser（爬升前奏）。宁缺毋滥。"""
    n = int(rms.size)
    if n == 0 or not events:
        return
    norm = dsp.norm01(rms)
    hard_stop = 0
    riser = 0
    for ev in events:
        t = float(ev["t"])
        k = int(t / hop_sec)
        pre = norm[max(0, k - int(0.6 / hop_sec)): max(0, k - 1)]
        post = norm[min(n, k + int(0.15 / hop_sec)): min(n, k + int(0.7 / hop_sec))]
        ev.pop("special", None)
        if pre.size >= 3 and post.size >= 3:
            pre_mean = float(pre.mean())
            post_mean = float(post.mean())
            if hard_stop < 8 and pre_mean > 0.30 and post_mean < 0.20 and pre_mean > 1.6 * post_mean:
                ev["special"] = "hardStop"
                hard_stop += 1
                continue
        far = norm[max(0, k - int(2.0 / hop_sec)): max(0, k - int(1.0 / hop_sec))]
        mid = norm[max(0, k - int(1.0 / hop_sec)): max(0, k - int(0.5 / hop_sec))]
        near = norm[max(0, k - int(0.45 / hop_sec)): max(0, k)]
        if riser < 8 and far.size >= 3 and mid.size >= 3 and near.size >= 3:
            far_mean = float(far.mean())
            mid_mean = float(mid.mean())
            near_mean = float(near.mean())
            # 真 riser：从安静处起步、单调上行、且这一下够响；稳态素材不该出 riser
            if (far_mean < 0.45 and near_mean > 1.5 * far_mean
                    and mid_mean > 1.15 * far_mean and float(ev["strength"]) > 0.5):
                ev["special"] = "riser"
                riser += 1


def _event_out(ev: dict) -> dict:
    """事件出参：去掉内部字段，保证 bands 三数和 ≈1。"""
    out = {k: v for k, v in ev.items() if not str(k).startswith("_")}
    bands = out.get("bands")
    if isinstance(bands, dict):
        total = sum(float(bands.get(k, 0.0)) for k in ("low", "mid", "high"))
        if total <= _EPS:
            out["bands"] = {"low": 0.0, "mid": 0.0, "high": 0.0}
        else:
            v = {k: float(bands.get(k, 0.0)) / total for k in ("low", "mid", "high")}
            key = max(v, key=v.get)
            v[key] += 1.0 - sum(v.values())
            out["bands"] = {k: round(max(0.0, min(1.0, x)), 4) for k, x in v.items()}
    return out


# ---------------------------------------------------------------- 高频曲线出参


def _curve_block(block: dict, rename: dict | None = None) -> dict:
    """曲线块 → 响应形态：曲线保留 4 位小数（值域 0-1），元数据按秒/帧率精度收敛。

    数组是给程序读的，别整段塞进上下文；`rename` 只用于把内部键名换成对外的名字
    （perFrame 的 `kick` → `kickPulse`）。
    """
    rename = rename or {}
    out: dict = {}
    for key, value in block.items():
        if key in dsp.CURVE_KEYS:
            out[rename.get(key, key)] = [round(float(v), 4) for v in value]
        elif key == "fps":
            out[key] = round(float(value), 3)
        elif key in ("frameSec", "attackSec", "releaseSec"):
            out[key] = round(float(value), 5)
        elif key in ("hopSec", "nativeHopSec"):
            out[key] = round(float(value), 6)
        else:
            out[key] = int(value)
    return out


# ---------------------------------------------------------------- 小节感知能量出参


def _bar_energy_block(bars: list) -> dict:
    """beatGrid.bars 的感知能量 → 独立的 energy.barEnergy 块（与 bars 同序同长）。

    逐小节 RMS 只差几 dB，按全曲 dB 范围线性拉伸成柱高时几乎一样高；这里给的是
    近似 K 加权 + p5–p95 稳健归一的 0–1 值，安静段与副歌在小节粒度上能拉开差距。
    没有能量字段（旧缓存 / 无帧特征）就回 `{method:"none", points:0, ...}`，不编造。
    """
    db: list = []
    norm: list = []
    for b in bars or []:
        v_db = b.get("energyDb") if isinstance(b, dict) else None
        v_n = b.get("energy01") if isinstance(b, dict) else None
        if v_db is None or v_n is None:
            continue
        db.append(round(float(v_db), 2))
        norm.append(round(float(np.clip(float(v_n), 0.0, 1.0)), 4))
    return {
        "method": "perceptualBarEnergy" if norm else "none",
        "percentile": [sections_mod.PERCEPTUAL_PCT_LO, sections_mod.PERCEPTUAL_PCT_HI],
        "floorDb": sections_mod.PERCEPTUAL_FLOOR_DB,
        "points": len(norm),
        "db": db,
        "norm": norm,
        "note": "第 i 个值对应 beatGrid.bars[i]；db 是相对全曲最响帧的感知电平（≤0），"
                "norm 是 p5–p95 稳健归一后的 0–1（柱高 / 卡点密度用这个，别用 rmsDb）",
    }


# ---------------------------------------------------------------- 剪辑建议


def _edit_block(sec_list, grid_info, beats_np, events, tempo_info, duration) -> dict:
    """cutPoints（段落 > downbeat > beat > onset）/ accents / shotDurationTiers。"""
    bpm = float(tempo_info.get("bpm") or 120.0)
    period = 60.0 / max(bpm, 1e-6)
    bars = grid_info.get("bars") or []
    downbeats = grid_info.get("downbeatsSec") or []
    bar_rms = [float(b.get("rmsDb", -60.0)) for b in bars]

    def bar_strength(idx: int) -> float:
        if not bar_rms:
            return 0.6
        lo, hi = min(bar_rms), max(bar_rms)
        if hi - lo < 1e-6:
            return 0.65
        return float(np.clip(0.45 + 0.5 * (bar_rms[min(idx, len(bar_rms) - 1)] - lo) / (hi - lo), 0.0, 0.95))

    cands: list[dict] = []
    for sec in sec_list[1:]:
        t = float(sec["startSec"])
        boost = 0.12 if sec["label"] in ("chorus", "drop") else 0.0
        cands.append({"t": t, "snap": "section", "strength": min(0.99, 0.80 + boost),
                      "reason": _section_reason(sec, duration)})
    for i, t in enumerate(downbeats):
        cands.append({"t": float(t), "snap": "downbeat", "strength": bar_strength(i),
                      "reason": "小节重音"})
    for ev in events:
        if ev.get("grid") in ("strong", "weak") and float(ev.get("strength", 0)) >= 0.45:
            cands.append({"t": float(ev["t"]), "snap": "onset",
                          "strength": float(min(0.85, 0.35 + 0.5 * float(ev.get("strength", 0)))),
                          "reason": "鼓点（%s）" % {"kick": "底鼓", "snare": "军鼓", "hat": "踩镲",
                                                  "perc": "打击", "glitch": "故障音"}.get(
                              str(ev.get("drum")), "敲击")})
    if not cands and beats_np.size:
        for k, t in enumerate(beats_np[::4]):
            cands.append({"t": float(t), "snap": "beat", "strength": 0.5, "reason": "网格拍点"})

    # 去重：80 ms 内只留 strength 最大的；每小节最多 2 个
    cands.sort(key=lambda c: (-c["strength"], c["t"]))
    picked: list[dict] = []
    for c in cands:
        if any(abs(c["t"] - p["t"]) < 0.08 for p in picked):
            continue
        picked.append(c)
    picked.sort(key=lambda c: c["t"])
    per_bar: dict[int, int] = {}
    cut_points: list[dict] = []
    for c in picked:
        bar_idx, beat_in_bar = _locate(c["t"], bars, beats_np, grid_info)
        key = bar_idx if bar_idx is not None else -1
        if key >= 0 and per_bar.get(key, 0) >= 2:
            continue
        if key >= 0:
            per_bar[key] = per_bar.get(key, 0) + 1
        item = {"t": round(float(c["t"]), 4), "snap": c["snap"],
                "strength": round(float(np.clip(c["strength"], 0.0, 1.0)), 3)}
        if bar_idx is not None:
            item["barIndex"] = int(bar_idx)
            item["beatInBar"] = int(beat_in_bar)
        item["reason"] = c["reason"]
        cut_points.append(item)

    # —— 强调点
    accents: list[dict] = []
    for i, t in enumerate(downbeats):
        accents.append({"t": round(float(t), 4), "kind": "strongBeat",
                        "strength": round(float(np.clip(0.5 + 0.45 * bar_strength(i), 0.0, 0.98)), 3)})
    for sec in sec_list:
        if sec["index"] == 0:
            continue
        kind = "drop" if sec["label"] == "drop" else "sectionEntry"
        accents.append({"t": round(float(sec["startSec"]), 4), "kind": kind,
                        "strength": round(float(np.clip(0.70 + 0.25 * float(sec["confidence"]), 0.0, 0.99)), 3)})
    for ev in events:
        special = ev.get("special")
        if special == "hardStop":
            accents.append({"t": round(float(ev["t"]), 4), "kind": "hardStop",
                            "strength": round(float(np.clip(0.75 + 0.2 * float(ev["strength"]), 0.0, 0.99)), 3)})
        elif special == "riser":
            accents.append({"t": round(float(ev["t"]), 4), "kind": "riser",
                            "strength": round(float(np.clip(0.4 + 0.3 * float(ev["strength"]), 0.0, 0.9)), 3)})
    # 没有 downbeat 时（或小节重音不足），用落在强位（16 分格 0/8）的强事件补 strongBeat
    used = {round(float(a["t"]), 3) for a in accents}
    strong_events = [e for e in events
                     if str(e.get("grid")) == "strong" and float(e.get("strength", 0.0)) >= 0.55]
    strong_events.sort(key=lambda e: -float(e["strength"]))
    for ev in strong_events[:12]:
        t = round(float(ev["t"]), 4)
        if t in used:
            continue
        used.add(t)
        accents.append({"t": t, "kind": "strongBeat",
                        "strength": round(float(np.clip(0.45 + 0.5 * float(ev["strength"]), 0.0, 0.95)), 3)})
    accents.sort(key=lambda a: (-a["strength"], a["t"]))
    # 同位置去重（保留最强的）
    dedup: list[dict] = []
    for a in accents:
        if any(abs(a["t"] - b["t"]) < 0.05 and a["kind"] == b["kind"] for b in dedup):
            continue
        dedup.append(a)
    dedup.sort(key=lambda a: (-a["strength"], a["t"]))
    accents = dedup[:40]

    tiers = [
        {"name": "fast", "beats": 0.5, "useCase": "拍点密集处，跟拍点快切"},
        {"name": "medium", "beats": 1, "useCase": "常规推进，一拍一切"},
        {"name": "slow", "beats": 2, "useCase": "稀疏 / 留白处，两拍一切"},
        {"name": "cinematic", "beats": 4, "useCase": "长镜头，四拍一切"},
    ]
    out_tiers = []
    for t in tiers:
        mid = period * float(t["beats"])
        out_tiers.append({
            "name": t["name"], "beats": float(t["beats"]),
            "minSec": round(max(0.05, mid * 0.9), 3),
            "maxSec": round(max(0.06, mid * 1.1), 3),
            "useCase": t["useCase"],
        })
    return {"cutPoints": cut_points, "accents": accents, "shotDurationTiers": out_tiers}


def _section_reason(sec: dict, duration: float) -> str:
    label = str(sec.get("label") or "unknown")
    zh = {"intro": "前奏进入", "verse": "主歌进入", "prechorus": "预副歌进入",
          "chorus": "副歌进入", "bridge": "桥段进入", "breakdown": "降段进入",
          "drop": "爆发点进入", "outro": "尾奏进入", "unknown": "段落边界"}.get(label, "段落边界")
    return zh


def _locate(t: float, bars: list, beats_np, grid_info) -> tuple[int | None, int]:
    """时间 → (小节序号, 小节内拍序号)；没有小节时回 (None, 0)。"""
    if not bars:
        return None, 0
    starts = [float(b["startSec"]) for b in bars]
    idx = int(np.searchsorted(starts, float(t), side="right") - 1)
    idx = max(0, min(idx, len(bars) - 1))
    b = bars[idx]
    beat_in_bar = 0
    if beats_np.size:
        k = int(np.searchsorted(beats_np, float(t), side="right") - 1)
        k0 = int(np.searchsorted(beats_np, float(b["startSec"]) - 1e-6, side="left"))
        beat_in_bar = max(0, min(k - k0, int(b.get("beatCountInBar") or 1) - 1))
    return idx, beat_in_bar


# ---------------------------------------------------------------- 图


def _visuals(opts, x, duration, feats, rms_norm, phases, sec_list, beats_sec, downbeats_sec) -> dict:
    """按 options.viz.kinds 生成 PNG 字节（纯 numpy + zlib）。"""
    kinds = list(opts["viz"]["kinds"]) if opts["viz"]["enabled"] else []
    out: dict[str, bytes] = {}
    if not kinds:
        return out
    starts = [float(s["startSec"]) for s in sec_list]
    for kind in kinds:
        if kind == "spectrogram":
            img = pngw.render_spectrogram(feats.spec_norm, duration)
        elif kind == "waveform":
            img = pngw.render_waveform(x, duration)
        elif kind == "beatOverlay":
            img = pngw.render_beat_overlay(x, duration, beats_sec, downbeats_sec, starts)
        elif kind == "energyCurve":
            img = pngw.render_energy_curve(rms_norm, None, phases, duration, starts)
        else:
            continue
        out[kind] = pngw.encode_png(img)
    return out


def _visual_entries(opts, pngs: dict, key16: str) -> list:
    """visuals[]：path 绝对且真实存在，尺寸写真实像素。"""
    entries = []
    for kind in opts["viz"]["kinds"]:
        if kind not in pngs:
            continue
        w, h = pngw.png_size(pngs[kind])
        name = "%s/%s.png" % (key16, kind)
        entries.append({
            "kind": kind,
            "path": os.path.join(_artifact_root(), key16, "%s.png" % kind),
            "widthPx": int(w),
            "heightPx": int(h),
            "format": "png",
            "bytes": int(len(pngs[kind])),
            "generatedBy": "numpy-zlib-png",
            "artifact": name,
            "artifactUrl": "/artifact/" + name,
        })
    return entries


_ARTIFACT_ROOT_CACHE: dict[str, str] = {}


def _artifact_root() -> str:
    """产物根目录（与 Cache 一致：<数据目录>/artifacts）。"""
    root = _default_root()
    key = os.path.abspath(root)
    if key not in _ARTIFACT_ROOT_CACHE:
        _ARTIFACT_ROOT_CACHE.clear()
        _ARTIFACT_ROOT_CACHE[key] = os.path.join(key, "artifacts")
    return _ARTIFACT_ROOT_CACHE[key]


# ---------------------------------------------------------------- diagnostics 文本


def _add_warning(warnings: list, code: str, message: str, t: float | None = None) -> None:
    """去重加入警告（同码只留第一条）。"""
    if not code or code not in contract.WARNING_CODES:
        return
    if any(w.get("code") == code for w in warnings):
        return
    item = {"code": code, "message": message or code}
    if t is not None:
        item["t"] = round(float(t), 3)
    warnings.append(item)


def _warning_message(code: str, **kw) -> str:
    downsampled = bool(kw.get("downsampled"))
    duration = float(kw.get("duration") or 0.0)
    extra = kw.get("extra") or {}
    if code == "NO_ONSET":
        return "没有检测到敲击事件（静音、弱鼓或纯人声长音）：onsets 为空，拍网格按无节奏处理"
    if code == "NO_GRID":
        cov = float(kw.get("coverage") or extra.get("gridConfidence") or 0.0)
        if cov <= 0:
            return "没有真实 attack 支撑拍网格：beatsSec 为空、downbeatMethod=none，禁止按拍剪"
        return ("拍点落在真实 attack ±25ms 的占比只有 %.2f（<0.5）：网格已降级"
                "（downbeatMethod=none、downbeatsSec/bars 为空），请按段落剪" % cov)
    if code == "NO_DOWNBEAT":
        return "没判出小节重拍（低频相位/onset 强度/小节电平证据都不足）：downbeatsSec 为空，按拍剪即可"
    if code == "LOW_CONFIDENCE_BPM":
        return ("BPM 置信度 %.2f < 0.5（三路估计分歧或素材没有稳定节拍）：bpm 只能当量级，"
                "卡点请改用 beatsSec" % float(extra.get("bpmConfidence") or 0.0))
    if code == "TEMPO_HALF_DOUBLE":
        cands = extra.get("candidates") or []
        top = "/".join("%.1f" % float(c["bpm"]) for c in cands[:4])
        bt = extra.get("beatTrackBpm")
        return ("最终 bpm %.2f 与拍轨候选 %s 差正好一个八度（候选 %s）：可能是半速/倍速误判，"
                "请对照 bpmCandidates 与拍点图复核；卡点仍以 beatsSec 为准"
                % (float(extra.get("bpm") or 0.0),
                   ("%.2f" % float(bt)) if bt else "无", top or "无"))
    if code == "SHORT_AUDIO":
        return "素材只有 %.2f 秒：统计类字段（相位/段落/速度置信度）只作参考" % duration
    if code == "ONSETS_TRUNCATED":
        return "事件数超过 onsetsLimit，events 已截断（count 仍是真值）"
    if code == "SECTIONS_FALLBACK":
        return "段落法已降级为 energyPhase（段界仍准，标签只作参考）"
    if code == "KEY_UNRELIABLE":
        return "调性估计不可靠（本实现不做调性估计，global.key 恒为 null）"
    if code == "DOWNSAMPLED":
        sr = int(extra.get("sr") or 11025)
        return ("素材超过 %d 秒：分析采样率降为 %d Hz（Nyquist %d Hz），帧率仍是 43.066 fps、"
                "时间坐标不变" % (contract.DOWNSAMPLE_OVER_SEC, sr, sr // 2))
    return code


def _method_text(downsampled: bool, sr: int, n_fft: int, hop: int) -> str:
    return (
        "ffmpeg 管道解码为 %d Hz 单声道 float32（%s）→ nFft=%d/hop=%d 的 STFT 分块扫描，"
        "一次得到对数谱通量、三带功率、6 带功率、鼓型窄带与频谱平坦度；同一趟音频再按等时间口径"
        "hop≈5.8ms（256 采样点 @44.1k，降采样档同比减半为 64）跑窗函数 sinc FIR 分带，"
        "得到 rms/low/mid/high/onset/kick 六条高频曲线 → 通量峰拾取（最小间隔 30ms，"
        "delta=0.05）+ 1ms 包络 attack 精修（并用中位偏移校正半窗偏置）→ 三路互验速度"
        "（tempogram 自相关谐波梳 / 中位拍间隔 / DP 拍轨）+ fold 倍频纠正 → DP 拍轨落在包络峰上，"
        "再逐拍吸附 ±40ms 内的真实 attack，attackCoverage 即 gridConfidence → 拍序号↔时刻做 Huber 稳健回归、"
        "按局部周期突变（含段落边界提示）切段成分段速度图 tempoMap，再按图重生成整条拍点（去抖动但保留变速；"
        "原始检测值留在 diagnostics.beatsRaw）→ 低频相位定 downbeat，"
        "不行再退 onset 强度 / 小节电平 → 0.1s RMS 分四档出能量相位与关键转折 → 段落边界按能量相位切"
        "并吸附最近 downbeat → 切点按段落>downbeat>beat>onset 预排。"
        "同一条高频曲线再按 options.fps 做逐帧池化（瞬态类 max、响度类 mean），"
        "套 5ms attack / 150ms release 非对称平滑出 energy.perFrame；"
        "raw 曲线与 perFrame 都按 detail 预算下发，超预算按整数 stride 抽稀（真实点距看 hopSec / frameSec）；"
        "拍点 / 事件 / 曲线 / 逐帧的时间轴都扣掉了各自检测器的系统延迟（contract.DETECTOR_LATENCY_MS，"
        "校正后残差 ≤ 半个栅格，实际生效值见 diagnostics.parameters.detectorLatencyMs）。"
        % (sr, "长素材降采样档" if downsampled else "默认档", n_fft, hop)
    )


def _caveat_text() -> str:
    return (
        "BPM 与拍点都是估计值：网格经 attack 精修后可能整体位移，卡点前请对着 music 抽帧或看图复核；"
        "gridConfidence<0.8 或 |gridCalibrationMs|>30 时应人工调整；tempoMap 是对检测拍点的稳健拟合，"
        "段内按 bpm 推进、跨段才变速，和 diagnostics.beatsRaw 对不上时以原始检测为准去查；"
        "downbeatMethod 只有 lowBandPhase 是"
        "主判据，energyOnset/barAccent 是启发式，none 表示没判出来（不要自己补）；段落标签只保证边界不保证命名；"
        "rmsNorm/rmsDb 是给程序读的包络，别塞进上下文；调性不做估计（global.key 恒 null）；"
        "energy.curves 是抽稀后的 raw 高频曲线（真实点距看 hopSec、原生 hop 看 nativeHopSec），"
        "要精确 attack 时刻仍以 onsets.events 为准；energy.perFrame 已经过池化 + 非对称平滑"
        "（快起慢落），可直接当闪拍强度用，但不能反推 exact attack；perFrame.stride>1 表示素材超过下发预算，"
        "每个点覆盖多帧；卡点位置一律回 beatsSec / onsets 复核，别用曲线的 argmax 当拍点。"
    )


def _parameters(opts, ctx, grid, downsampled, lag_sec, tempo_info, ffmpeg_ver, total_events,
                grid_info=None, curve_block=None, per_frame=None) -> dict:
    grid_info = grid_info or {}
    curve_block = curve_block or {}
    per_frame = per_frame or {}
    return {
        "sr": int(grid["sr"]),
        "hopLength": int(grid["hopLength"]),
        "nFft": int(grid["nFft"]),
        "frameRateHz": round(grid["sr"] / float(grid["hopLength"]), 3),
        "downsampled": bool(downsampled),
        "energyHopSec": contract.ENERGY_HOP_SEC,
        "attackHopMs": round(contract.ATTACK_HOP_SEC * 1000.0, 3),
        "onsetLagMs": round(float(lag_sec) * 1000.0, 2),
        "tightness": 100.0,
        "startBpm": 120,
        "detail": bool(opts["detail"]),
        "onsetsLimit": int(opts["onsetsLimit"]),
        "sectionsMethod": str(opts["sections"]["method"]),
        "snapToDownbeat": bool(opts["sections"]["snapToDownbeat"]),
        # 高频曲线 / 逐帧池化：hop 是等时间口径（256@44.1k，降采样档同比减半），
        # 下发时超预算按整数 stride 抽稀，真实点距看 hopSec / frameSec
        "fps": int(opts["fps"]),
        "curveHopSamples": dsp.curve_hop(int(grid["sr"])),
        "curveHopSec": round(float(curve_block.get("nativeHopSec") or 0.0), 6),
        "curvePoints": int(curve_block.get("points") or 0),
        "curveStride": int(curve_block.get("stride") or 1),
        "perFramePoints": int(per_frame.get("points") or 0),
        "perFrameStride": int(per_frame.get("stride") or 1),
        "perFrameFrameSec": round(float(per_frame.get("frameSec") or 0.0), 5),
        "perFrameAttackSec": float(per_frame.get("attackSec") or 0.0),
        "perFrameReleaseSec": float(per_frame.get("releaseSec") or 0.0),
        "vizKinds": list(opts["viz"]["kinds"]),
        "loudness": bool(opts["loudness"]),
        "cacheMode": str(opts["cache"]),
        # 检测器系统延迟（毫秒，负 = 该检测器输出比真实事件早）：contract 里的标定值按本次
        # 运行的栅格折算后的实际值，卡点误差复核 / 复现时先看这一块
        "detectorLatencyMs": _latency_block(grid, opts, per_frame),
        "eventCount": int(total_events),
        "tempoVerified": bool(tempo_info.get("tempoVerified")),
        "beatTrackBpm": tempo_info.get("beatTrackBpm"),
        # 分段速度图：段数 / 段级速度区间 / onset 自相关复核出的 tempoConfidence
        "tempoSegments": len(grid_info.get("tempoMap") or []),
        "tempoRangeBpm": grid_info.get("tempoRange") or {"min": 0.0, "max": 0.0},
        "tempoConfidence": float(grid_info.get("tempoConfidence") or 0.0),
        "octaveReview": list(grid_info.get("octaveReview") or []),
        # 诊断支路：onset 事件间隔（踩镲会把间隔砍半）——不进 bpmCandidates（schema 的
        # source 枚举只有 beatTrack/medianInterBeat/tempogram/foldRefine/userHint），
        # 也不参与 tempoVerified 的三路互验，只在这里给人工诊断。
        "onsetSpacingBpm": tempo_info.get("onsetSpacingBpm"),
        "analyzerVersion": contract.VERSION,
        "ffmpeg": ffmpeg_ver or "",
        "ignoredOptions": list(ctx.get("ignored") or []),
    }


def _latency_block(grid: dict, opts: dict, per_frame: dict | None = None) -> dict:
    """本次运行实际生效的检测器延迟（毫秒，负 = 检测器输出比真实事件早）。

    数值来自 `contract.DETECTOR_LATENCY_MS`（合成脉冲上标定的常数），栅格类按本次运行的
    真实栅格折算：curves/kick 是半个块（curve hop），perFrame 是半个帧（options.fps / stride）。
    """
    per_frame = per_frame or {}
    sr = int(grid["sr"])
    curve_sec = dsp.curve_hop(sr) / float(sr)
    frame_sec = float(per_frame.get("frameSec") or 0.0)
    if frame_sec <= 0:
        frame_sec = 1.0 / float(opts.get("fps") or 30)
    return {
        "onsets": round(contract.detector_latency_ms("onsets"), 2),
        "beats": round(contract.detector_latency_ms("beats"), 2),
        "curves": round(contract.detector_latency_ms("curves", curve_sec), 2),
        "onset": round(contract.detector_latency_ms("onset", curve_sec), 2),
        "kick": round(contract.detector_latency_ms("kick", curve_sec), 2),
        "perFrame": round(contract.detector_latency_ms("perFrame", frame_sec), 2),
        "gridSec": {"curves": round(curve_sec, 6), "perFrame": round(frame_sec, 5)},
    }


def _beats_raw_block(grid_info: dict, detail: bool) -> dict:
    """原始检测拍点（重生成网格之前那条）：给备查用的对账块。

    只报「重生成网格 vs 原始检测」的偏移统计；完整秒数表只在 detail=true 时下发（体积考虑）。
    """
    raw = grid_info.get("beatTimesRaw")
    raw = np.asarray(raw if raw is not None else [], dtype=np.float64)
    raw = raw[np.isfinite(raw)]
    grid = np.asarray(grid_info.get("beatsSec") or [], dtype=np.float64)
    out = {
        "count": int(raw.size),
        "firstSec": round(float(raw[0]), 4) if raw.size else 0.0,
        "lastSec": round(float(raw[-1]), 4) if raw.size else 0.0,
        "medianShiftMs": 0.0,
        "maxShiftMs": 0.0,
    }
    if raw.size and grid.size:
        j = np.searchsorted(raw, grid)
        k0 = np.clip(j - 1, 0, raw.size - 1)
        k1 = np.clip(j, 0, raw.size - 1)
        d = np.minimum(np.abs(grid - raw[k0]), np.abs(grid - raw[k1]))
        out["medianShiftMs"] = round(float(np.median(d)) * 1000.0, 2)
        out["maxShiftMs"] = round(float(d.max()) * 1000.0, 2)
    if detail and raw.size:
        out["beatsSec"] = [round(float(t), 4) for t in raw]
    return out


def _time_signature_confidence(grid_info: dict) -> float:
    if grid_info.get("downbeatMethod") == "none":
        return 0.2
    return round(float(np.clip(0.35 + 0.6 * float(grid_info.get("gridConfidence") or 0.0), 0.0, 0.95)), 3)


def _global_db(g_rms_db: float, g_peak_db: float, lufs, want_lufs: bool) -> dict:
    out = {"rms": round(float(g_rms_db), 2), "peak": round(float(g_peak_db), 2)}
    if want_lufs:
        out["lufsIntegrated"] = (None if lufs is None else round(float(lufs), 1))
    return out


# ---------------------------------------------------------------- 收尾与自检


def _sanitize(body: dict, duration: float) -> None:
    """兜底：所有 *Sec 落在 [0, duration]，序列单调，长度关系成立（不变量 1/3/4/5/8）。"""
    def clip(v):
        try:
            f = float(v)
        except Exception:
            return 0.0
        if not np.isfinite(f):
            return 0.0
        return float(min(max(f, 0.0), duration))

    meta = body["meta"]
    meta["durationSec"] = round(clip(meta["durationSec"]), 4) or round(duration, 4)
    bg = body["beatGrid"]
    seq = sorted({round(clip(t), 4) for t in bg["beatsSec"]})
    bg["beatsSec"] = seq
    bg["beatCount"] = len(seq)
    bg["firstBeatSec"] = seq[0] if seq else 0.0
    dbs = sorted({round(clip(t), 4) for t in bg["downbeatsSec"] if any(abs(clip(t) - b) < 1e-6 for b in seq)})
    bg["downbeatsSec"] = dbs
    if not dbs:
        bg["downbeatMethod"] = "none"
        bg["bars"] = []
        bg["phrases"] = []
    # bars：首尾相接 + index 连续
    prev_end = None
    for i, b in enumerate(bg["bars"]):
        b["index"] = i
        b["startSec"] = round(clip(b["startSec"]), 4)
        b["endSec"] = round(clip(b["endSec"]), 4)
        if prev_end is not None:
            b["startSec"] = prev_end
        if b["endSec"] <= b["startSec"]:
            b["endSec"] = round(min(duration, b["startSec"] + 0.001), 4)
        b["downbeatSec"] = b["startSec"]
        prev_end = b["endSec"]
    if bg["bars"]:
        bg["bars"][-1]["endSec"] = round(duration, 4)
    # energy.barEnergy：小节感知能量的独立出参（在 bars 定稿之后生成，保证同序同长；
    # overrides 重建 bars 后会再走一次 _sanitize，这里自然跟着更新）
    if isinstance(body.get("energy"), dict):
        body["energy"]["barEnergy"] = _bar_energy_block(bg["bars"])
    # tempoMap：段首尾相接、落在 [0, duration]、beat0 不越界
    tm = bg.get("tempoMap")
    if isinstance(tm, list) and tm:
        prev_end = 0.0
        kept = []
        for i, seg in enumerate(tm):
            seg["bpm"] = round(float(np.clip(seg.get("bpm", 120.0), 20.0, 400.0)), 3)
            start = prev_end if i > 0 else 0.0
            end = clip(seg.get("end"))
            if end <= start:
                end = round(min(duration, start + 0.001), 4)
            seg["start"] = round(float(start), 4)
            seg["end"] = round(float(end), 4)
            seg["beat0"] = round(clip(seg.get("beat0")), 4)
            seg["confidence"] = round(float(np.clip(seg.get("confidence", 0.0), 0.0, 1.0)), 3)
            prev_end = float(seg["end"])
            kept.append(seg)
        kept[-1]["end"] = round(duration, 4)
        bg["tempoMap"] = [s for s in kept if float(s["end"]) > float(s["start"])]
    # energy：三处同长
    en = body["energy"]
    n = int(min(len(en["rmsNorm"]), len(en["rmsDb"])))
    en["rmsNorm"] = [round(float(np.clip(v, 0.0, 1.0)), 4) for v in en["rmsNorm"][:n]]
    en["rmsDb"] = [round(float(min(max(v, -80.0), 0.0)), 2) for v in en["rmsDb"][:n]]
    en["points"] = n
    for ph in en["phases"]:
        ph["startSec"] = round(clip(ph["startSec"]), 3)
        ph["endSec"] = round(clip(ph["endSec"]), 3)
    if en["phases"]:
        en["phases"][0]["startSec"] = 0.0
        en["phases"][-1]["endSec"] = round(duration, 3)
    # 高频曲线 / 逐帧池化：各条同长、值域 [0,1]、points 与真实长度一致（不变量 4/6 的同口径）
    for block_name, rename in (("curves", None), ("perFrame", {"kick": "kickPulse"})):
        block = en.get(block_name)
        if not isinstance(block, dict):
            continue
        rename = rename or {}
        keys = [rename.get(k, k) for k in dsp.CURVE_KEYS]
        arrays = []
        for key in keys:
            raw = block.get(key)
            seq = raw if isinstance(raw, list) else []
            arrays.append([round(float(np.clip(v, 0.0, 1.0)), 4)
                           for v in seq if np.isfinite(v)])
        m = min([len(a) for a in arrays], default=0)
        for key, arr in zip(keys, arrays):
            block[key] = arr[:m]
        block["points"] = int(m)
        if block_name == "curves":
            block["hopSec"] = round(max(0.0, float(block.get("hopSec") or 0.0)), 6)
            block["nativeHopSec"] = round(max(0.0, float(block.get("nativeHopSec") or 0.0)), 6)
            block["stride"] = int(max(1, block.get("stride") or 1))
        else:
            stride = int(max(1, block.get("stride") or 1))
            fps = float(block.get("fps") or 0.0)
            block["stride"] = stride
            block["frameSec"] = round(stride / fps, 5) if fps > 0 else 0.0
    # sections：首 0 末 duration、无缝无叠
    for i, sec in enumerate(body["sections"]):
        sec["index"] = i
        sec["startSec"] = round(clip(sec["startSec"]), 4)
        sec["endSec"] = round(clip(sec["endSec"]), 4)
        sec["confidence"] = round(float(np.clip(sec.get("confidence", 0.3), 0.0, 1.0)), 3)
    if body["sections"]:
        body["sections"][0]["startSec"] = 0.0
        for i in range(len(body["sections"]) - 1):
            body["sections"][i]["endSec"] = body["sections"][i + 1]["startSec"]
        body["sections"][-1]["endSec"] = round(duration, 4)
        for i, sec in enumerate(body["sections"]):
            if sec["endSec"] <= sec["startSec"]:
                sec["endSec"] = round(min(duration, sec["startSec"] + 0.01), 4)
    # onsets：时间越界钳制、升序
    for ev in body["onsets"]["events"]:
        ev["t"] = round(clip(ev["t"]), 4)
    body["onsets"]["events"].sort(key=lambda e: e["t"])
    # edit：时间钳制、升序
    for cp in body["edit"]["cutPoints"]:
        cp["t"] = round(clip(cp["t"]), 4)
    body["edit"]["cutPoints"].sort(key=lambda c: c["t"])
    for ac in body["edit"]["accents"]:
        ac["t"] = round(clip(ac["t"]), 4)


def _iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def traceback_tail(exc: BaseException, n: int = 3) -> str:
    """异常 → 最后 n 行 traceback（响应 detail 用；完整栈只进日志）。"""
    return contract._tail_lines("".join(traceback.format_exception(
        type(exc), exc, exc.__traceback__)), n)
