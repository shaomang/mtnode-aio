"""拍点：拾取 → attack 精修 → downbeat → bars/phrases → onset 落格。

**核心纪律（契约不变量第 9 条）**：绝不允许「按 bpm 等间隔外推出整条网格却当成检测结果」。
本实现的顺序是：

1. `tempo.dp_beats` 在 onset 包络上做 DP 拍轨 —— 每一拍都必须由包络上的真实峰支撑；
2. 每拍在 ±40 ms 内找真实 attack（1 ms 细栅格上找包络上升最快处）并**吸附**过去；
3. `gridConfidence = attackCoverage`：粗网格落在真实 attack ±25 ms 的拍占比；
   <0.5 立刻降级（`downbeatMethod:"none"`、`downbeatsSec:[]`、`bars:[]` 并给 `NO_GRID`），
   `===0` 时整块拍位字段降级为 `unknown`（宁可空，不许编）。

在 1 与 3 之间插一步**分段速度图**（`tempo.tempo_map` + `tempo.beats_from_map`）：用检测到的
拍点做 Huber 稳健回归、按段给出 bpm 与相位，再由图重生成整条网格（去掉逐拍抖动，但仍跟真实变速）。
原始检测值留在 `beatsRaw` 里备查，网格与原始检测的偏差（coverage / snapped / offsetMs）照旧如实报。

downbeat 判据优先级：`lowBandPhase`（<150 Hz 低频相位，唯一主判据）→ `energyOnset`
（全带 onset 强度）→ `barAccent`（小节电平）→ `none`（空数组）。

全部注释与消息为中文。
"""

from __future__ import annotations

import numpy as np

from . import contract
from . import sections as sections_mod
from . import tempo as tempo_mod
from .dsp import FrameFeatures, frame_sec, sec_frame

_EPS = 1e-12
#: attack 精修搜索半径（秒）
ATTACK_SEARCH_SEC = 0.04
#: 判定「这一拍落在真实 attack 上」的容差（秒）
ATTACK_TOL_SEC = 0.025
#: 拍位最小间隔（秒）：保证 beatsSec 严格升序
MIN_BEAT_GAP_SEC = 0.02
#: 拍号候选（分母固定 4）
BAR_LENGTHS = (4, 3, 2, 6, 7)


# ---------------------------------------------------------------- 精修


def refine(beat_frames: np.ndarray, fps: float, lag_sec: float, attack_env: np.ndarray,
           attack_dt: float, duration_sec: float) -> dict:
    """把 DP 拍轨（帧下标）精修到真实 attack。

    返回 {beatsSec, offsetsMs, coverage, calibrationMs, snapped(list[bool])}。
    """
    empty = {"beatsSec": [], "coarseSec": [], "offsetsMs": [], "coverage": 0.0,
             "calibrationMs": 0.0, "snapped": []}
    if beat_frames.size == 0 or fps <= 0:
        return empty
    coarse = beat_frames.astype(np.float64) / float(fps) + float(lag_sec)
    coarse = np.clip(coarse, 0.0, max(0.0, duration_sec))
    if coarse.size == 0:
        return empty
    # 极短素材：砍掉落在末尾之外的拍
    coarse = coarse[coarse <= duration_sec + 1e-9]
    if coarse.size == 0:
        return empty

    refined = np.empty(coarse.size, dtype=np.float64)
    offsets = np.zeros(coarse.size, dtype=np.float64)
    snapped = np.zeros(coarse.size, dtype=bool)
    hits = np.zeros(coarse.size, dtype=bool)
    if attack_env.size >= 3 and attack_dt > 0:
        n = int(attack_env.size)
        # attack 的最低上升幅度：既要明显高于本窗底噪，也要占全曲 attack 峰的一点比例
        # （否则稳态长音上的包络抖动会被当成「真实 attack」，尾部会多出假拍）
        global_rise = 0.05 * float(np.max(np.diff(attack_env.astype(np.float64)))) \
            if n >= 2 else 0.0
        for k, t0 in enumerate(coarse):
            lo = int(max(0, min(n - 2, round((t0 - ATTACK_SEARCH_SEC) / attack_dt))))
            hi = int(max(lo + 1, min(n - 1, round((t0 + ATTACK_SEARCH_SEC) / attack_dt))))
            seg = attack_env[lo: hi + 1].astype(np.float64)
            if seg.size < 2:
                refined[k] = t0
                continue
            d = np.diff(seg)
            j = int(np.argmax(d))
            ta = (lo + j + 1) * attack_dt
            # attack 必须有实质上升，否则视为「这一拍没有真实 attack」
            rise = float(d[j])
            floor = max(0.02 * float(seg.max()), global_rise)
            if rise >= floor and rise > 0.0:
                refined[k] = ta
                offsets[k] = ta - t0
                snapped[k] = abs(offsets[k]) <= ATTACK_SEARCH_SEC
                hits[k] = True
            else:
                # 附近没有真实上升：这一拍只是「预测位」，不算命中（会计入 coverage 分母）
                refined[k] = t0
                offsets[k] = 0.0
    else:
        refined[:] = coarse

    # —— 系统延迟校正：1 ms attack 栅格上的平滑偏置（contract.DETECTOR_LATENCY_MS["beats"]）
    # 让整条拍点平移同样多的毫秒；onsets.events[].t 走同一个常数，两边口径才对得上。
    latency_sec = contract.detector_latency_sec("beats")
    if latency_sec:
        refined = refined - latency_sec

    # 严格升序：同一位置只留第一个，间隔不足 MIN_BEAT_GAP_SEC 的丢掉
    keep = np.ones(refined.size, dtype=bool)
    last = -1e9
    for k in range(refined.size):
        t = float(min(max(refined[k], 0.0), duration_sec))
        if t <= last + MIN_BEAT_GAP_SEC:
            keep[k] = False
            continue
        refined[k] = t
        last = t
    refined = refined[keep]
    offsets = offsets[keep]
    snapped = snapped[keep]
    hits = hits[keep]
    if refined.size == 0:
        return empty

    hit_offsets = offsets[hits]
    coverage = float(hits.sum()) / float(refined.size)
    calibration = float(np.median(hit_offsets)) * 1000.0 if hit_offsets.size else 0.0
    return {
        "beatsSec": [round(float(t), 4) for t in refined],
        "coarseSec": [round(float(t), 4) for t in coarse],
        "offsetsMs": [round(float(o) * 1000.0, 2) for o in offsets],
        "coverage": round(float(np.clip(coverage, 0.0, 1.0)), 3),
        "calibrationMs": round(float(np.clip(calibration, -500.0, 500.0)), 2),
        "snapped": [bool(s) for s in snapped],
        "hits": [bool(s) for s in hits],
    }


# ---------------------------------------------------------------- downbeat


def _phase_scores(values: np.ndarray, bar_len: int) -> np.ndarray:
    """按小节内位置分组求均值（4 组），返回长度 bar_len 的数组。"""
    out = np.zeros(bar_len, dtype=np.float64)
    for p in range(bar_len):
        sel = values[p::bar_len]
        out[p] = float(sel.mean()) if sel.size else 0.0
    return out


def _contrast(scores: np.ndarray) -> tuple[int, float]:
    """最突出的相位与它的相对对比度。"""
    if scores.size == 0:
        return 0, 0.0
    order = np.argsort(-scores)
    phase = int(order[0])
    lead = float(scores[order[0]])
    rest = scores[order[1:]]
    base = float(rest.mean()) if rest.size else 0.0
    denom = abs(lead) + abs(base) + _EPS
    return phase, float((lead - base) / denom)


def downbeat(beats_sec: np.ndarray, beat_frames: np.ndarray, ff: FrameFeatures,
             env: np.ndarray, duration_sec: float) -> dict:
    """判 downbeat：低频相位 → onset 强度 → 小节电平 → none。"""
    res = {"method": "none", "phase": 0, "downbeatsSec": [], "barLength": 4,
           "confidence": 0.0, "scores": None}
    n = int(beats_sec.size)
    if n < 4:
        return res
    f_idx = np.clip(beat_frames, 0, max(0, ff.n_frames - 1)) if ff.n_frames else None

    cands: list[tuple[str, np.ndarray]] = []
    if f_idx is not None and f_idx.size == n:
        low_pow = ff.low[f_idx].astype(np.float64)
        tot_pow = ff.total[f_idx].astype(np.float64)
        # 低频占比（比绝对功率更抗整体响度变化）
        share = low_pow / np.maximum(tot_pow, _EPS)
        cands.append(("lowBandPhase", share))
        ons = env[f_idx].astype(np.float64) if env.size else np.zeros(n)
        cands.append(("energyOnset", ons))
        cands.append(("barAccent", tot_pow))

    best = None
    for method, values in cands:
        for bar_len in BAR_LENGTHS:
            scores = _phase_scores(values, bar_len)
            phase, contrast = _contrast(scores)
            if best is None or contrast > best[0]:
                best = (contrast, method, phase, bar_len, scores)
    if best is None:
        return res

    contrast, method, phase, bar_len, scores = best
    # 阈值：低频相位要求更低（它是主判据），其余更严
    need = {"lowBandPhase": 0.10, "energyOnset": 0.12, "barAccent": 0.10}[method]
    if contrast < need:
        return res

    downbeats = []
    for k in range(n):
        if (k - phase) % bar_len == 0:
            t = float(beats_sec[k])
            if t <= duration_sec + 1e-9:
                downbeats.append(round(t, 4))
    if len(downbeats) < 2:
        return res
    conf = float(np.clip(0.35 + 2.0 * (contrast - need), 0.0, 0.95))
    return {"method": method, "phase": int(phase % bar_len), "downbeatsSec": downbeats,
            "barLength": int(bar_len), "confidence": round(conf, 3), "scores": scores}


# ---------------------------------------------------------------- bars / phrases


def bars_and_phrases(downbeats: list[float], beats_sec: np.ndarray, duration_sec: float,
                     rms_db: np.ndarray, energy_hop: float, ff: FrameFeatures) -> tuple[list, list]:
    """由 downbeat 切小节；小节首尾相接，末小节收口到 durationSec。"""
    if not downbeats or beats_sec.size == 0:
        return [], []
    starts = [float(d) for d in downbeats if float(d) < duration_sec - 1e-6]
    if not starts:
        return [], []
    bars: list[dict] = []
    for i, s in enumerate(starts):
        e = starts[i + 1] if i + 1 < len(starts) else float(duration_sec)
        if e <= s + 1e-6:
            continue
        sel = beats_sec[(beats_sec >= s - 1e-6) & (beats_sec < e - 1e-6)]
        if sel.size == 0:
            continue
        bars.append({"index": len(bars), "startSec": round(s, 4), "endSec": round(e, 4),
                     "downbeatSec": round(s, 4), "beatCountInBar": int(sel.size),
                     "_frames": None, "rmsDb": -80.0, "lowDb": -80.0})
    if not bars:
        return [], []
    bars[-1]["endSec"] = round(float(duration_sec), 4)
    # 末小节若一拍都没有（downbeat 贴着结尾），并进前一小节
    if len(bars) >= 2 and bars[-1]["beatCountInBar"] == 0:
        bars.pop()
    # —— 每小节电平：rmsDb 取 0.1s 栅格真值，lowDb = rmsDb + 低频占比
    for b in bars:
        s, e = b["startSec"], b["endSec"]
        if rms_db.size and energy_hop > 0:
            k0 = int(max(0, np.floor(s / energy_hop)))
            k1 = int(min(rms_db.size, max(k0 + 1, np.ceil(e / energy_hop))))
            seg = rms_db[k0:k1]
            b["rmsDb"] = round(float(seg.mean()) if seg.size else -80.0, 2)
        else:
            b["rmsDb"] = -80.0
        rel = _low_share_db(ff, s, e)
        b["lowDb"] = round(float(np.clip(b["rmsDb"] + rel, -80.0, 0.0)), 2)
        b.pop("_frames", None)
    # —— 每小节感知能量（近似 K 加权 + p5–p95 稳健归一）：直方图柱高与卡点密度用它，
    #    rmsDb 保留原义（真 RMS 电平），两者不互相覆盖。没有帧特征就整块不写。
    perc = sections_mod.bar_perceptual_energy(ff, [(b["startSec"], b["endSec"]) for b in bars])
    for b, (db, norm) in zip(bars, perc):
        b["energyDb"] = db
        b["energy01"] = norm
    phrases = []
    for i in range(0, len(bars), 4):
        grp = bars[i:i + 4]
        phrases.append({
            "index": len(phrases),
            "startSec": grp[0]["startSec"],
            "endSec": grp[-1]["endSec"] if i + 4 < len(bars) else round(float(duration_sec), 4),
            "barStart": grp[0]["index"],
            "barEnd": grp[-1]["index"],
        })
    if phrases:
        phrases[-1]["endSec"] = round(float(duration_sec), 4)
    return bars, phrases


def _low_share_db(ff: FrameFeatures, start: float, end: float) -> float:
    """区间内低频（<150Hz）相对全带的电平差（dB），用于 lowDb 估算。"""
    if ff.n_frames <= 0:
        return -60.0
    f0 = sec_frame(start, ff.sr, ff.hop)
    f1 = sec_frame(end, ff.sr, ff.hop)
    f0 = int(np.clip(f0, 0, ff.n_frames - 1))
    f1 = int(np.clip(f1, f0 + 1, ff.n_frames))
    low = float(ff.low[f0:f1].mean()) if f1 > f0 else 0.0
    tot = float(ff.total[f0:f1].mean()) if f1 > f0 else 0.0
    if tot <= _EPS or low <= _EPS:
        return -60.0
    return float(np.clip(10.0 * np.log10(low / tot), -60.0, 0.0))


# ---------------------------------------------------------------- onset 落格


def associate_onsets(events: list[dict], beats_sec: np.ndarray, downbeats: list[float],
                     bar_len: int, phase: int, duration_sec: float) -> None:
    """就地给每个事件补 grid / beatIndex / beatInBar / step16 / offsetMs。"""
    n = int(beats_sec.size)
    if n < 2:
        for ev in events:
            ev["grid"] = "unknown"
        return
    period = float(np.median(np.diff(beats_sec))) if n > 1 else 0.0
    if period <= 1e-6:
        for ev in events:
            ev["grid"] = "unknown"
        return
    downbeats_arr = np.array(downbeats, dtype=np.float64) if downbeats else np.zeros(0)
    for ev in events:
        t = float(ev["t"])
        j = int(np.searchsorted(beats_sec, t, side="right") - 1)
        j = max(0, min(j, n - 1))
        t0 = float(beats_sec[j])
        if j + 1 < n:
            t1 = float(beats_sec[j + 1])
        else:
            t1 = t0 + period
        span = max(t1 - t0, 1e-6)
        sub = int(round((t - t0) / span * 4.0))
        if sub >= 4 and j + 1 < n:
            j += 1
            t0 = float(beats_sec[j])
            t1 = float(beats_sec[j + 1]) if j + 1 < n else t0 + period
            span = max(t1 - t0, 1e-6)
            sub = 0
        sub = max(0, min(3, sub))
        line = t0 + sub * span / 4.0
        offset_ms = (t - line) * 1000.0
        ev["beatIndex"] = int(j)
        # 小节内拍序号：有 downbeat 时按 downbeat 定位，否则按相位推
        if downbeats_arr.size:
            b = int(np.searchsorted(downbeats_arr, t, side="right") - 1)
            b = max(0, min(b, downbeats_arr.size - 1))
            bar_start_t = float(downbeats_arr[b])
            k = int(np.searchsorted(beats_sec, bar_start_t - 1e-6, side="left"))
            beat_in_bar = j - k
            beat_in_bar = max(0, min(beat_in_bar, bar_len - 1))
        else:
            beat_in_bar = int((j - phase) % max(1, bar_len))
        ev["beatInBar"] = int(beat_in_bar)
        ev["step16"] = int((beat_in_bar * 4 + sub) % 16)
        ev["offsetMs"] = round(float(offset_ms), 2)
        limit_ms = span / 8.0 * 1000.0
        if abs(offset_ms) > limit_ms:
            ev["grid"] = "offGrid"
        elif ev["step16"] in (0, 8):
            ev["grid"] = "strong"
        elif ev["step16"] in (2, 4, 6, 10, 12, 14):
            ev["grid"] = "weak"
        else:
            ev["grid"] = "syncopated"


# ---------------------------------------------------------------- 总装


def build(ff: FrameFeatures, env: np.ndarray, tempo_info: dict, attack_env: np.ndarray,
          attack_dt: float, lag_sec: float, duration_sec: float,
          rms_db: np.ndarray, energy_hop: float, detail: bool,
          map_hints=None) -> dict:
    """总装 beatGrid 块 + 相关警告。`map_hints` 是分段速度图的切段提示（段落边界秒数）。"""
    fps = ff.sr / float(ff.hop) if ff.hop else 0.0
    out = {
        "beatsSec": [], "beatCount": 0, "downbeatsSec": [], "firstBeatSec": 0.0,
        "downbeatMethod": "none", "gridConfidence": 0.0, "gridCalibrationMs": 0.0,
        "bars": [], "phrases": [], "warnings": [], "detail": None,
        "beatFrames": np.zeros(0, np.int64), "barLength": 4, "downbeatPhase": 0,
        "tempoMap": [], "tempoConfidence": 0.0, "tempoRange": {"min": 0.0, "max": 0.0},
        "octaveReview": [], "beatTimesRaw": np.zeros(0, np.float64),
    }
    ref = refine(tempo_info.get("beatFrames", np.zeros(0, np.int64)), fps, lag_sec,
                 attack_env, attack_dt, duration_sec)
    raw = np.array(ref["beatsSec"], dtype=np.float64) if ref["beatsSec"] else np.zeros(0)
    out["beatTimesRaw"] = raw

    # —— 分段速度图（Huber 稳健回归 → tempoMap）→ 由图重生成整条网格（去抖动、保留真实变速）
    # 没有一拍落在真实 attack 上（静音 / 纯长音）就整块不做：不许给出拟合出来的假网格与假速度图。
    beats = raw
    if raw.size >= 2 and float(ref["coverage"]) > 0.0:
        map_info = tempo_mod.tempo_map(raw, duration_sec, env=env, fps=fps,
                                       snap_points=map_hints or ())
        out["tempoMap"] = map_info["segments"]
        out["tempoConfidence"] = float(map_info.get("tempoConfidence") or 0.0)
        out["tempoRange"] = map_info.get("bpmRange") or {"min": 0.0, "max": 0.0}
        out["octaveReview"] = list(map_info.get("octaveReview") or [])
        if out["tempoMap"]:
            tail_period = 60.0 / max(1e-6, float(out["tempoMap"][-1].get("bpm") or 120.0))
            grid_end = min(float(duration_sec), float(raw[-1]) + tail_period)
            regenerated = tempo_mod.beats_from_map(out["tempoMap"], duration_sec, grid_end=grid_end)
            if regenerated.size >= 2:
                beats = regenerated

    # —— 网格 vs 真实 attack：coverage 只认「精修时真的命中 attack」的那些拍
    hits = np.array(ref.get("hits") or [], dtype=bool)
    ref_times = raw[hits] if hits.size == raw.size else raw
    snapped: list[bool] = []
    offsets_ms: list[float] = []
    coverage = float(ref["coverage"])
    if beats.size and ref_times.size:
        j = np.searchsorted(ref_times, beats)
        k0 = np.clip(j - 1, 0, ref_times.size - 1)
        k1 = np.clip(j, 0, ref_times.size - 1)
        use0 = np.abs(beats - ref_times[k0]) <= np.abs(beats - ref_times[k1])
        near = np.where(use0, k0, k1)
        dist = np.abs(beats - ref_times[near])
        coverage = float(np.mean(dist <= ATTACK_TOL_SEC))
        snapped = [bool(d <= ATTACK_SEARCH_SEC) for d in dist]
        offsets_ms = [round(float(o), 2) for o in ((beats - ref_times[near]) * 1000.0)]

    if beats.size == 0 or coverage <= 0.0:
        # 没有真实 attack 支撑 → 空网格（不是「外推出一条凑数的网格」），速度图也一并清空
        out["gridConfidence"] = 0.0
        out["beatsSec"] = []
        out["beatCount"] = 0
        out["firstBeatSec"] = 0.0
        out["tempoMap"] = []
        out["tempoConfidence"] = 0.0
        out["tempoRange"] = {"min": 0.0, "max": 0.0}
        out["octaveReview"] = []
        out["warnings"].append("NO_GRID")
        out["warnings"].append("NO_DOWNBEAT")
        return out

    degraded = coverage < 0.5
    out.update({
        "beatsSec": [round(float(t), 4) for t in beats],
        "beatCount": int(beats.size),
        "firstBeatSec": round(float(beats[0]), 4),
        "gridConfidence": round(float(np.clip(coverage, 0.0, 1.0)), 3),
        "gridCalibrationMs": float(ref["calibrationMs"]),
    })
    frames = np.array([sec_frame(t, ff.sr, ff.hop) for t in beats], dtype=np.int64)
    out["beatFrames"] = frames
    snap_ref = {"snapped": snapped, "offsetsMs": offsets_ms}

    if degraded:
        # 降级：网格不可信 → 不给 downbeat / bars，并如实警告
        out["gridConfidence"] = round(float(coverage), 3)
        out["downbeatMethod"] = "none"
        out["downbeatsSec"] = []
        out["bars"] = []
        out["phrases"] = []
        out["warnings"].append("NO_GRID")
        out["warnings"].append("NO_DOWNBEAT")
        if detail:
            out["detail"] = _beats_detail(beats, frames, env, [], 4, 0, snap_ref, out["beatsSec"])
        return out

    db = downbeat(beats, frames, ff, env, duration_sec)
    beats_sub = beats[beats < duration_sec - 1e-6] if beats.size else beats
    downbeats = [d for d in db["downbeatsSec"] if any(abs(d - b) < 1e-6 for b in beats_sub)]
    method = db["method"] if len(downbeats) >= 2 else "none"
    if method == "none":
        downbeats = []
        out["warnings"].append("NO_DOWNBEAT")
    bars, phrases = bars_and_phrases(downbeats, beats, duration_sec, rms_db, energy_hop, ff)
    out.update({
        "downbeatsSec": [round(float(d), 4) for d in downbeats],
        "downbeatMethod": method,
        "bars": bars,
        "phrases": phrases,
        "barLength": int(db["barLength"]) if method != "none" else 4,
        "downbeatPhase": int(db["phase"]) if method != "none" else 0,
    })
    if detail:
        out["detail"] = _beats_detail(beats, frames, env, downbeats, out["barLength"],
                                      out["downbeatPhase"], snap_ref, out["beatsSec"])
    return out


def _beats_detail(beats: np.ndarray, frames: np.ndarray, env: np.ndarray,
                  downbeats: list[float], bar_len: int, phase: int,
                  snap_ref: dict, beats_sec: list) -> list:
    """逐拍明细（detail=true 才下发）。`snap_ref` 是网格相对原始检测的吸附情况。"""
    n = int(beats.size)
    if n == 0:
        return []
    db_arr = np.array(downbeats, dtype=np.float64) if downbeats else np.zeros(0)
    env_len = int(env.size)
    out = []
    for k in range(n):
        t = float(beats[k])
        f = int(np.clip(frames[k], 0, max(0, env_len - 1))) if env_len else 0
        strength = float(env[f]) if env_len else 0.0
        is_db = bool(db_arr.size) and bool(np.any(np.abs(db_arr - t) < 1e-6))
        if db_arr.size:
            b = int(np.searchsorted(db_arr, t, side="right") - 1)
            b = max(0, min(b, db_arr.size - 1))
            k0 = int(np.searchsorted(beats, float(db_arr[b]) - 1e-6, side="left"))
            beat_in_bar = max(0, min(k - k0, bar_len - 1))
            bar = b
        else:
            bar = 0
            beat_in_bar = int((k - phase) % max(1, bar_len))
        out.append({
            "t": round(t, 4),
            "index": int(k),
            "bar": int(bar),
            "beatInBar": int(beat_in_bar),
            "isDownbeat": is_db,
            "onsetStrength": round(float(np.clip(strength, 0.0, 1.0)), 3),
            "snapped": bool(snap_ref["snapped"][k]) if k < len(snap_ref["snapped"]) else False,
            "offsetMs": float(snap_ref["offsetsMs"][k]) if k < len(snap_ref["offsetsMs"]) else 0.0,
        })
    return out
