"""能量相位、关键转折与段落切分（默认 energyPhase）。

口径（analyze-contract §4.5 / §4.6）：

* 0.1 s RMS 先归一到全曲最大=1，再按 **0.2 / 0.4 / 0.65** 三阈值分四档
  （VOID / LOW / MEDIUM / HIGH），合并相邻同档 → `energy.phases`。
  分档前对 rmsNorm 做 1 s 平滑：鼓点密集处逐点抖动会切出几百个「相位」，那不是段落信息。
* `keyMoments`：**真实电平台阶** —— 0.4 s 中值滤波后，前后各 0.3 s 的均电平差 ≥ 8 dB，
  同一次跳变 0.8 s 内只留一个点（按 |Δ| 取前 24，再按时间排序）。
  旧口径「相邻 1 s 归一化 RMS 差 >0.12 取前 8」是错的：0.1 s 栅格上同一次台阶会
  连出 4 个点、前 8 名全挤在 1–2 次跳变上，1 s 窗口还把位置糊掉 ±0.5 s、δB 摊平。
* `bar_perceptual_energy`：逐小节感知能量（6 带近似 K 加权 → 功率域平均 → p5–p95 稳健
  归一到 0–1），给小节级直方图 / 卡点用 —— 逐小节 RMS 只差几 dB，听感差异读不出来。
* 段落：首段 startSec=0、末段 endSec=durationSec、段间不重叠不留缝；
  段界可吸附最近 downbeat（`snappedToDownbeat` + `downbeatOffsetMs`）；
  9 类标签全部是启发式，`confidence` 如实反映证据强弱。

全部注释与消息为中文。
"""

from __future__ import annotations

import numpy as np

from .dsp import BANDS6_NAMES, FrameFeatures, sec_frame

_EPS = 1e-12
PHASE_THRESHOLDS = (0.2, 0.4, 0.65)      # VOID / LOW / MEDIUM / HIGH 的分界
PHASE_SMOOTH_SEC = 2.0                   # 分档前的平滑窗（秒）：鼓点密集处逐点抖动会切出
#                                         几百个 0.2s 的「相位」，那不是段落信息
PHASE_MIN_SEC = 1.0                      # 相位最小长度（秒）：更短的碎段并进邻居
KEY_MOMENT_DB = 8.0                      # 电平台阶阈值（dB）：下面这个量才是"变响了/变轻了"
KEY_MOMENT_WIN_SEC = 0.3                 # 台阶两侧各取多长（秒）：越短越接近真实跳变的位置
KEY_MOMENT_MED_SEC = 0.4                 # 测台阶前先做中值滤波：鼓点脉冲会让局部电平在该尺度抖 6 dB
KEY_MOMENT_GAP_SEC = 0.8                 # 同一次跳变的最小间隔（秒）：不这么卡会一点出四个
KEY_MOMENT_LIMIT = 24                    # 最多给几个点（按 |Δ| 取，再按时间排序）
KEY_MOMENT_FLOOR_DB = -55.0              # 两侧都在这条线以下（基本是数字静音）不算台阶
#: 段落最小长度（秒）：比这短的段并进邻居，避免碎段
MIN_SECTION_SEC_FLOOR = 2.0
MIN_SECTION_SEC_CAP = 8.0


def _label_for(value: float) -> str:
    if value < PHASE_THRESHOLDS[0]:
        return "VOID"
    if value < PHASE_THRESHOLDS[1]:
        return "LOW"
    if value < PHASE_THRESHOLDS[2]:
        return "MEDIUM"
    return "HIGH"


def _band_of(label: str) -> tuple[float, float]:
    """某档位的归一化 RMS 区间（用于滞后判定）。"""
    if label == "VOID":
        return (-1e9, PHASE_THRESHOLDS[0])
    if label == "LOW":
        return (PHASE_THRESHOLDS[0], PHASE_THRESHOLDS[1])
    if label == "MEDIUM":
        return (PHASE_THRESHOLDS[1], PHASE_THRESHOLDS[2])
    return (PHASE_THRESHOLDS[2], 1e9)


def _labels_hysteresis(smooth: np.ndarray) -> list:
    """带滞后的逐点定档：越过阈值 ±0.03 才换档。

    稀疏脉冲素材（点击轨：0.5 s 一下、每下只占 0.02 s）的 2 s 滑动均值会在阈值附近
    抖动 ±0.09，无滞后会切出几千个 0.1 s 的「相位」——那不是段落信息。
    """
    n = int(smooth.size)
    if n == 0:
        return []
    labels = [""] * n
    cur = _label_for(float(smooth[0]))
    labels[0] = cur
    margin = 0.03
    for k in range(1, n):
        v = float(smooth[k])
        nxt = _label_for(v)
        if nxt != cur:
            lo, hi = _band_of(cur)
            if v < lo - margin or v > hi + margin:
                cur = nxt
        labels[k] = cur
    return labels


def _smooth(values: np.ndarray, win: int) -> np.ndarray:
    """滑动均值（边界用可用样本数归一，不做零填充）。"""
    n = int(values.size)
    if n == 0 or win <= 1:
        return values.astype(np.float64)
    win = int(min(win, n))
    cum = np.concatenate([[0.0], np.cumsum(values, dtype=np.float64)])
    half = win // 2
    out = np.empty(n, dtype=np.float64)
    for k in range(n):
        lo = max(0, k - half)
        hi = min(n, k + half + 1)
        out[k] = (cum[hi] - cum[lo]) / float(hi - lo)
    return out


def _band_shares(ff: FrameFeatures, start: float, end: float) -> dict | None:
    """区间内 6 带能量占比（和≈1）；无帧时回 None。"""
    if ff.n_frames <= 0:
        return None
    f0 = int(np.clip(sec_frame(start, ff.sr, ff.hop), 0, ff.n_frames - 1))
    f1 = int(np.clip(sec_frame(end, ff.sr, ff.hop), f0 + 1, ff.n_frames))
    block = ff.bands6[f0:f1]
    if block.size == 0:
        return None
    tot = float(block.sum())
    if tot <= _EPS:
        return None
    shares = block.sum(axis=0) / tot
    return {name: round(float(v), 4) for name, v in zip(BANDS6_NAMES, shares)}


def _character(shares: dict | None, label: str, onset_rate: float, level: float) -> str:
    """6 带占比 + 密度 → 音色印象（full/heavy/bright/intimate/sparse）。"""
    if label == "VOID":
        return "sparse"
    if not shares:
        return "full"
    low = shares.get("sub", 0.0) + shares.get("bass", 0.0)
    mid = shares.get("lowMid", 0.0) + shares.get("mid", 0.0)
    high = shares.get("presence", 0.0) + shares.get("air", 0.0)
    if low >= 0.45:
        return "heavy"
    if high >= 0.35:
        return "bright"
    if mid >= 0.55 and high < 0.12 and onset_rate < 2.0:
        return "intimate"
    if onset_rate < 1.0 and level < 0.35:
        return "sparse"
    return "full"


# ---------------------------------------------------------------- 小节感知能量
#
# 为什么要另算一份：逐小节 RMS 只差几 dB（副歌与主歌常在 4 dB 内），按全曲 dB 范围线性
# 拉伸成柱高时几乎全顶到同一高度 —— 用户实测「能量直方图几乎反映不出听觉上的能量」。
# 这里的做法：
#   ① 逐帧 6 带功率按近似 K 加权（100 Hz 高通：sub/bass 压低；高频高架：presence/air 抬高）
#      合成感知功率 —— 低频很响但听感不吵，中高频的镲 / 人声才决定「听起来有多满」；
#   ② 小节内按**功率域**平均（不是 dB 平均：dB 平均会让安静段被拖高，听感差异又被抹平），
#      再换成相对全曲最响帧的 dB；
#   ③ 按 p5–p95 稳健分位归一到 0–1：个别爆音 / 静音尾巴不会把整条压扁。

#: 6 带感知权重（与 dsp.BANDS6_NAMES 的顺序一致：sub/bass/lowMid/mid/presence/air）
PERCEPTUAL_BAND_WEIGHTS = (0.05, 0.45, 0.95, 1.05, 1.45, 1.75)
#: 感知能量下限（dB，相对全曲最响帧）
PERCEPTUAL_FLOOR_DB = -70.0
#: 稳健归一的分位（低 / 高）
PERCEPTUAL_PCT_LO = 5.0
PERCEPTUAL_PCT_HI = 95.0
#: 归一区间的最小跨度（dB）：整段一样响时也不至于除以 0
PERCEPTUAL_MIN_SPAN_DB = 6.0


def perceptual_frame_power(ff: FrameFeatures) -> np.ndarray:
    """逐帧感知功率（6 带功率 × 近似 K 加权），静音返回全零。"""
    if ff is None or ff.n_frames <= 0 or ff.bands6.size == 0:
        return np.zeros(0, dtype=np.float64)
    w = np.asarray(PERCEPTUAL_BAND_WEIGHTS, dtype=np.float64)
    if ff.bands6.shape[1] != w.size:
        return np.zeros(0, dtype=np.float64)
    return np.maximum(ff.bands6 @ w, 0.0)


def bar_perceptual_energy(ff: FrameFeatures, spans: list) -> list:
    """逐小节感知能量 → [(energyDb, energy01)]，顺序与 spans 一致。

    `energyDb` 是相对全曲最响帧的 dB（≤0，底 -70）；`energy01` 是 p5–p95 稳健归一的 0–1。
    没有帧特征（或整段无声）时回空列表，调用方保留旧的 rmsDb 口径，不要瞎补。
    """
    n = len(spans or [])
    if n <= 0:
        return []
    p = perceptual_frame_power(ff)
    if p.size == 0 or float(p.max()) <= _EPS:
        return []
    ref = float(p.max())
    dbs: list[float] = []
    for start, end in spans:
        f0 = int(np.clip(sec_frame(start, ff.sr, ff.hop), 0, p.size - 1))
        f1 = int(np.clip(sec_frame(end, ff.sr, ff.hop), f0 + 1, p.size))
        seg = p[f0:f1]
        mean = float(seg.mean()) if seg.size else 0.0
        db = 10.0 * float(np.log10(mean / ref)) if mean > _EPS else PERCEPTUAL_FLOOR_DB
        dbs.append(float(max(db, PERCEPTUAL_FLOOR_DB)))
    lo = float(np.percentile(dbs, PERCEPTUAL_PCT_LO))
    hi = float(np.percentile(dbs, PERCEPTUAL_PCT_HI))
    if not (hi - lo >= PERCEPTUAL_MIN_SPAN_DB):
        hi = lo + PERCEPTUAL_MIN_SPAN_DB
    out = []
    for db in dbs:
        norm = float(np.clip((db - lo) / (hi - lo), 0.0, 1.0))
        out.append((round(db, 2), round(norm, 4)))
    return out


def energy_phases(rms: np.ndarray, rms_db: np.ndarray, rms_norm: np.ndarray, hop_sec: float,
                  duration_sec: float, ff: FrameFeatures, event_times: np.ndarray) -> list:
    """按归一化 RMS 分档并合并相邻同档 → phases[]。

    三段式：① 平滑后逐点定档 → ② 取档位变化处当候选边界 → ③ 把短于
    `PHASE_MIN_SEC` 的碎段并进邻居（0.1 s 栅格上的抖动不是相位信息），
    最后每段的档位用**该段均值**重算（避免边界处左右摇摆切出 0.1 s 的碎相位）。
    """
    n = int(rms_norm.size)
    if n == 0 or duration_sec <= 0:
        return []
    win = max(1, int(round(PHASE_SMOOTH_SEC / hop_sec)))
    smooth = _smooth(rms_norm, win)
    labels = _labels_hysteresis(smooth)

    # ① 候选边界（档位变化处）+ ② 线性一次扫描合并：相邻边界至少隔 min_points
    bounds = [0]
    for k in range(1, n):
        if labels[k] != labels[k - 1]:
            bounds.append(k)
    bounds.append(n)
    min_points = max(2, int(round(PHASE_MIN_SEC / hop_sec)))
    kept = [0]
    for b in bounds[1:-1]:
        if b - kept[-1] >= min_points:
            kept.append(b)
    kept.append(n)
    bounds = kept

    events = np.sort(np.asarray(event_times, dtype=np.float64)) if event_times.size else None
    phases: list[dict] = []
    for i in range(len(bounds) - 1):
        k0, k1 = bounds[i], bounds[i + 1]
        s = k0 * hop_sec
        e = float(duration_sec) if i == len(bounds) - 2 else k1 * hop_sec
        if e <= s + 1e-6 or k1 <= k0:
            continue
        mean_level = float(np.mean(smooth[k0:k1]))
        label = _label_for(mean_level)
        peak_db = round(float(np.max(rms_db[k0:k1])), 2)
        rate = 0.0
        if events is not None and e > s:
            cnt = int(np.searchsorted(events, e) - np.searchsorted(events, s))
            rate = round(cnt / (e - s), 3)
        shares = _band_shares(ff, s, e)
        item = {
            "label": label,
            "startSec": round(float(s), 3),
            "endSec": round(float(e), 3),
            "character": _character(shares, label, rate, mean_level),
            "onsetRate": rate,
            "peakDb": peak_db,
        }
        if shares:
            item["bands"] = shares
        phases.append(item)
    if not phases:
        return []
    phases[0]["startSec"] = 0.0
    phases[-1]["endSec"] = round(float(duration_sec), 3)
    return phases


def _median_filter(v: np.ndarray, k: int) -> np.ndarray:
    """滑窗中值滤波（只依赖 numpy）。k 为偶数时自动 +1，保证有中心点。"""
    k = max(1, int(k) | 1)
    if k <= 1 or int(v.size) < k:
        return v
    pad = k // 2
    p = np.pad(v, (pad, pad), mode="edge")
    try:
        win = np.lib.stride_tricks.sliding_window_view(p, k)
        return np.median(win, axis=1)
    except Exception:  # numpy 太老没有 sliding_window_view
        return np.array([float(np.median(p[i:i + k])) for i in range(int(v.size))])


def key_moments(rms_norm: np.ndarray, rms_db: np.ndarray, hop_sec: float) -> list:
    """真实电平台阶：中值滤波后前后各 0.3 s 的均电平差 ≥ 8 dB，同一次跳变只留一个点。

    为什么不能用「1 s 归一化幅度差 >0.12 取前 8」：0.1 s 栅格上同一次台阶的 |Δ| 是一个
    平台，前 8 名会把 4 个相邻格子（相差 0.1 s）全收进来 —— 一条三分钟的曲子只报出
    一两处跳变、而且挤在同一处；1 s 的均值窗又把位置糊掉 ±0.5 s、把台阶幅度摊薄，
    拿来当卡点完全对不上。这里改成：
      · 用 dB（这才是电平），并先做 0.4 s 中值滤波（鼓点脉冲会在这个尺度上制造假台阶）；
      · 两侧各 0.3 s 均值差，阈值 8 dB；
      · 极大值优先 + 0.8 s 最小间隔 → 一次跳变一个点；
      · t 落在 0.1 s 栅格的真实跳变处（±0.1 s），deltaDb 就是实测台阶。
    """
    n = int(min(rms_norm.size, rms_db.size))
    if n < 8:
        return []
    win = max(1, int(round(KEY_MOMENT_WIN_SEC / hop_sec)))
    src = _median_filter(rms_db[:n], int(round(KEY_MOMENT_MED_SEC / hop_sec)))
    cands: list[dict] = []
    # 首尾各让出 win（中值滤波的边缘外推会把开头糊成一个假台阶）
    for k in range(win * 2, n - win + 1):
        prev = float(np.mean(src[k - win:k]))
        nxt = float(np.mean(src[k:k + win]))
        if max(prev, nxt) < KEY_MOMENT_FLOOR_DB:
            continue
        step = nxt - prev
        if abs(step) < KEY_MOMENT_DB:
            continue
        cands.append({
            "t": round(float(k * hop_sec), 3),
            "kind": "SURGE" if step > 0 else "DROP",
            "deltaDb": round(float(step), 2),
            "abs": abs(float(step)),
        })
    if not cands:
        return []
    # 非极大抑制：强的先占位，0.8 s 之内的同伴丢掉（同一次跳变的平台）
    cands.sort(key=lambda d: (-d["abs"], d["t"]))
    picked: list[dict] = []
    for c in cands:
        if any(abs(c["t"] - p["t"]) < KEY_MOMENT_GAP_SEC for p in picked):
            continue
        picked.append(c)
        if len(picked) >= KEY_MOMENT_LIMIT:
            break
    for item in picked:
        item.pop("abs", None)
    picked.sort(key=lambda d: d["t"])
    return picked


# ---------------------------------------------------------------- 段落


def _min_section_sec(duration_sec: float) -> float:
    return float(np.clip(duration_sec / 8.0, MIN_SECTION_SEC_FLOOR, MIN_SECTION_SEC_CAP))


def _section_features(phases: list, rms_norm: np.ndarray, hop_sec: float,
                      events: np.ndarray, start: float, end: float) -> dict:
    """段落的电平/密度特征（用 0.1s 栅格与事件表算）。"""
    n = int(rms_norm.size)
    k0 = int(np.clip(np.floor(start / hop_sec), 0, max(0, n - 1)))
    k1 = int(np.clip(np.ceil(end / hop_sec), k0 + 1, max(1, n)))
    seg = rms_norm[k0:k1] if n else np.zeros(1)
    level = float(np.mean(seg)) if seg.size else 0.0
    rate = 0.0
    if events is not None and events.size and end > start:
        cnt = int(np.searchsorted(events, end) - np.searchsorted(events, start))
        rate = cnt / (end - start)
    return {"level": level, "onsetRate": rate, "lenSec": max(0.0, end - start)}


def _labels(segments: list, duration_sec: float) -> list[dict]:
    """9 类标签启发式：位置 + 电平 + 相邻段电平差 + 事件密度。"""
    n = len(segments)
    if n == 0:
        return []
    levels = [s["level"] for s in segments]
    out = []
    for i, seg in enumerate(segments):
        level = levels[i]
        prev_level = levels[i - 1] if i > 0 else level
        nxt_level = levels[i + 1] if i + 1 < n else level
        rise = level - prev_level
        label, conf = "unknown", 0.30
        is_first, is_last = i == 0, i == n - 1
        if n == 1:
            label, conf = "unknown", 0.30
        elif is_first:
            if level < 0.55 and nxt_level > level + 0.10:
                label, conf = "intro", 0.55 + min(0.25, (nxt_level - level))
            elif level < 0.45:
                label, conf = "intro", 0.55
            else:
                label, conf = "verse", 0.50
        elif is_last:
            if level < prev_level - 0.10:
                label, conf = "outro", 0.55 + min(0.25, prev_level - level)
            elif level < 0.5:
                label, conf = "outro", 0.55
            else:
                label, conf = "verse", 0.45
        else:
            if level >= 0.62 and rise > 0.15 and prev_level < 0.45:
                label, conf = "drop", 0.60 + min(0.25, rise)
            elif rise > 0.25 and prev_level < 0.30:
                label, conf = "drop", 0.58
            elif level >= 0.60:
                # 与之前的高能量段同档 → 仍判 chorus（副歌反复出现）
                label, conf = "chorus", 0.60 + min(0.20, level - 0.60)
            elif rise > 0.10:
                label, conf = "prechorus", 0.50 + min(0.20, rise)
            elif prev_level - level > 0.25 and prev_level > 0.60:
                label, conf = "breakdown", 0.55
            elif level < 0.30:
                label, conf = "breakdown", 0.45
            elif seg["onsetRate"] < 1.5 and level < 0.55:
                label, conf = "bridge", 0.45
            elif level >= 0.42:
                label, conf = "verse", 0.48
            else:
                label, conf = "unknown", 0.32
        out.append({"label": label, "confidence": round(float(np.clip(conf, 0.0, 0.95)), 3)})
    # 副歌同档复认：与某个 chorus 段电平接近的中段也标 chorus
    chorus_levels = [levels[i] for i, s in enumerate(out) if s["label"] == "chorus"]
    if chorus_levels:
        ref = float(np.mean(chorus_levels))
        for i, item in enumerate(out):
            if item["label"] in ("verse", "unknown") and abs(levels[i] - ref) <= 0.06:
                item["label"] = "chorus"
                item["confidence"] = round(max(item["confidence"], 0.55), 3)
    return out


def sections(phases: list, key_moments_list: list, rms_norm: np.ndarray, hop_sec: float,
             duration_sec: float, downbeats: list[float], beats_sec: np.ndarray,
             method: str = "energyPhase", snap: bool = True,
             event_times: np.ndarray | None = None) -> list:
    """段落切分（默认 energyPhase）：切 → 并碎段 → 吸附 downbeat → 打标签。"""
    if duration_sec <= 0:
        return []
    bounds: list[float] = [0.0]
    if method == "keyMoment":
        for km in key_moments_list:
            t = float(km["t"])
            if 0.0 < t < duration_sec:
                bounds.append(t)
    else:
        for ph in phases[1:]:
            t = float(ph["startSec"])
            if 0.0 < t < duration_sec:
                bounds.append(t)
        # 段落边界也认「关键转折」：能量相位没切出来的大跳变补进来
        for km in key_moments_list:
            if km["kind"] in ("SURGE", "DROP") and abs(km["deltaDb"]) >= 4.0:
                t = float(km["t"])
                if 0.0 < t < duration_sec:
                    bounds.append(t)
    bounds = sorted({round(float(b), 4) for b in bounds if 0.0 <= float(b) < duration_sec})
    if not bounds or bounds[0] > 0.0:
        bounds = [0.0] + bounds
    bounds.append(float(duration_sec))
    bounds = sorted(set(bounds))

    # —— 短段合并（线性一次扫描：相邻边界至少隔 min_len；末段不足则并进前一段）
    min_len = _min_section_sec(duration_sec)
    kept = [bounds[0]]
    for b in bounds[1:-1]:
        if b - kept[-1] >= min_len:
            kept.append(b)
    kept.append(bounds[-1])
    if len(kept) >= 3 and kept[-1] - kept[-2] < min_len:
        kept.pop(-2)
    bounds = kept

    events = np.asarray(event_times, dtype=np.float64) if event_times is not None else None
    segs = []
    for i in range(len(bounds) - 1):
        s, e = float(bounds[i]), float(bounds[i + 1])
        if e <= s:
            continue
        feat = _section_features(phases, rms_norm, hop_sec, events, s, e)
        feat["startSec"], feat["endSec"] = s, e
        segs.append(feat)
    if not segs:
        return []
    # 事件表用于 onsetRate（延迟到此处一次性取）
    labels = _labels(segs, duration_sec)

    # —— 吸附 downbeat
    out = []
    db = np.array(sorted(float(d) for d in downbeats), dtype=np.float64) if downbeats else np.zeros(0)
    period = float(np.median(np.diff(beats_sec))) if beats_sec.size > 1 else 0.0
    max_shift = min(1.2, (period if period > 0 else 1.2))
    snapped_flags = []
    offsets = []
    new_bounds = [0.0]
    for i in range(1, len(segs)):
        t = segs[i]["startSec"]
        snapped, off = False, 0.0
        if snap and db.size:
            j = int(np.argmin(np.abs(db - t)))
            delta = float(db[j]) - t
            lo, hi = new_bounds[-1] + MIN_SECTION_SEC_FLOOR, float(duration_sec) - 0.05
            if abs(delta) <= max_shift and lo <= float(db[j]) <= hi:
                t = float(db[j])
                snapped, off = True, delta * 1000.0
        new_bounds.append(t)
        snapped_flags.append(snapped)
        offsets.append(off)
    new_bounds = sorted(new_bounds)
    new_bounds.append(float(duration_sec))

    # —— 组装（用吸附后的边界重算长度，仍保证首 0 末 duration）
    out = []
    for i in range(len(new_bounds) - 1):
        s, e = float(new_bounds[i]), float(new_bounds[i + 1])
        if e <= s + 1e-9:
            continue
        lab = labels[min(i, len(labels) - 1)] if labels else {"label": "unknown", "confidence": 0.3}
        item = {
            "index": len(out),
            "label": lab["label"],
            "startSec": round(float(s), 4),
            "endSec": round(float(e), 4),
            "confidence": lab["confidence"],
            "method": method,
        }
        if i == 0:
            item["snappedToDownbeat"] = False
            item["downbeatOffsetMs"] = 0.0
        else:
            k = min(i - 1, len(snapped_flags) - 1)
            item["snappedToDownbeat"] = bool(snapped_flags[k]) if snapped_flags else False
            item["downbeatOffsetMs"] = round(float(offsets[k]), 2) if offsets else 0.0
        out.append(item)
    if out:
        out[0]["startSec"] = 0.0
        out[0]["snappedToDownbeat"] = False
        out[0]["downbeatOffsetMs"] = 0.0
        out[-1]["endSec"] = round(float(duration_sec), 4)
        for i, item in enumerate(out):
            item["index"] = i
    return out
