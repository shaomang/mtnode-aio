"""速度（BPM）：三路并行估计 + 候选表 + 倍频（fold）纠正。

三路（契约 §4.2 的 source 枚举里对应三条）：

1. `tempogram` —— onset 包络的自相关，按「谐波梳」打分（lag、2lag、3lag、4lag 加权求和），
   解决「自相关在周期的整数倍上都有峰」导致的半速误判。
2. `medianInterBeat` —— 已精修到 attack 的 onset 事件之间的间隔，取强度加权中位数。
3. `beatTrack` —— 用上面的周期跑 DP 拍轨，再取拍间隔中位数。

选值与 fold：把候选两两按 log2 比值折叠到 ±0.5 个八度来判断「是不是同一速度的不同倍频」，
再用一个以 120 BPM 为心的宽先验（σ≈0.9 八度）在多路同分的近似平局里选八度
（60 与 120 都能解释一段 120 BPM 的点击轨 —— 但 60 解释不了的另一半 onset 会由 DP 与
中位间隔两路拉回来，所以这里只做「平局裁决」，不做「强行拉到 120」）。

`tempoVerified` 是严格口径：三路**原始值**（不折叠）与最终 bpm 的 log2 比值都要落 ±0.02。

除此之外本模块还负责**分段速度图**（`tempo_map`）：把拍序号当自变量、拍时刻当因变量的
Huber 稳健直线回归，按残差突变（或调用方给的段落边界提示）切段，每段给
`{start, end, bpm, beat0}`，并由图重生成整条拍点（`beats_from_map`，去抖动但保留真实变速）。
半步 / 倍步用 onset 包络自相关在同一段上复核，给出 `tempo_confidence`。
最后三个纯函数 `beat_at` / `phase_at` / `bar_at` 供逐帧与渲染共用（无 I/O、无全局状态）。

全部注释与消息为中文。
"""

from __future__ import annotations

import math

import numpy as np

_EPS = 1e-12
BPM_MIN = 45.0
BPM_MAX = 240.0
#: 速度先验中心与宽度（八度）
PRIOR_CENTER = 120.0
PRIOR_SIGMA_OCT = 0.9
#: 三路一致判定阈值（log2 比值）
VERIFY_TOL = 0.02

# —— 分段速度图（tempoMap）参数
#: 段数上限：超了就合并最短段（契约里也是 64）
MAX_TEMPO_SEGMENTS = 64
#: 每段最少拍数（少于此不单独成段）
MIN_SEG_BEATS = 8
#: 递归二分的最小增益（1 - 子段 SSE / 父段 SSE）
SEG_GAIN_MIN = 0.25
#: 切点两侧的平均对数周期至少要差这么多（≈1.5% 速度差），挡住抖出来的假切点
SEG_MIN_DELTA_LOG = 0.0149
#: 段落边界提示点的增益折扣（提示点不强制切段，只降门槛）
SEG_HINT_GAIN = 0.35
#: 局部周期的半窗（拍）
SEG_PERIOD_WINDOW = 8
#: 切点吸附到段落边界提示的最大距离（秒）
SEG_SNAP_SEC = 1.5
#: 半步 / 倍步复核余量（自相关系数差）
OCTAVE_MARGIN = 0.18


def _acf(env: np.ndarray) -> np.ndarray:
    """自相关（FFT 版），归一到 acf[0]=1。"""
    n = int(env.size)
    if n < 8:
        return np.zeros(1, np.float64)
    e = np.asarray(env, dtype=np.float64)
    e = e - float(e.mean())
    size = 1 << int(np.ceil(np.log2(max(2, 2 * n))))
    spec = np.fft.rfft(e, size)
    acf = np.fft.irfft(np.abs(spec) ** 2, size)[:n]
    return acf / max(float(acf[0]), _EPS)


def _acf_at(acf: np.ndarray, lag: float) -> float:
    """自相关在非整数 lag 上线性插值。"""
    if acf.size < 2 or lag <= 0:
        return 0.0
    if lag >= acf.size - 1:
        return 0.0
    i = int(np.floor(lag))
    f = lag - i
    return float(acf[i] * (1.0 - f) + acf[i + 1] * f)


def _prior(bpm: float) -> float:
    """速度先验：以 120 BPM 为中心的宽高斯（只在近似平局时起作用）。"""
    if bpm <= 0:
        return 0.0
    x = np.log2(bpm / PRIOR_CENTER) / PRIOR_SIGMA_OCT
    return float(np.exp(-0.5 * x * x))


def tempogram_bpm(env: np.ndarray, fps: float) -> tuple[float | None, float]:
    """自相关谐波梳 → (bpm, 质量 0-1)。"""
    n = int(env.size)
    if n < 16 or fps <= 0:
        return None, 0.0
    acf = _acf(env)
    if acf.size < 4 or float(np.max(np.abs(acf[1:]))) <= _EPS:
        return None, 0.0
    lo_bpm = max(BPM_MIN, 60.0 * fps / max(1.0, acf.size - 2.0))
    bpms = np.arange(lo_bpm, BPM_MAX, 0.25, dtype=np.float64)
    if bpms.size == 0:
        return None, 0.0
    scores = np.zeros(bpms.size, dtype=np.float64)
    for k in (1, 2, 3, 4):
        lags = (60.0 * fps / bpms) * k
        vals = np.array([_acf_at(acf, float(l)) for l in lags], dtype=np.float64)
        scores += vals / k
    priors = np.array([_prior(b) for b in bpms], dtype=np.float64)
    summed = scores * priors
    if not np.isfinite(summed).any() or float(summed.max()) <= 0:
        return None, 0.0
    j = int(np.argmax(summed))
    bpm = float(bpms[j])
    # 质量：峰值相对平均水平（0-1）
    mean = float(np.mean(np.abs(scores))) + _EPS
    quality = float(np.clip((float(scores[j]) / mean - 1.0) / 3.0, 0.0, 1.0))
    return bpm, quality


def onset_spacing_bpm(times: np.ndarray, strengths: np.ndarray) -> tuple[float | None, float]:
    """**诊断用**：onset 事件间隔的强度加权中位数 → (bpm, 质量 0-1)。

    它量的是「敲击事件之间的间隔」，所以八分音符踩镲会把间隔砍半
    （120 BPM 的曲子读出 240）——**不许**拿它参与三路互验，只写进
    `diagnostics.parameters.onsetSpacingBpm` 给人工诊断用。
    """
    if times.size < 4:
        return None, 0.0
    d = np.diff(times)
    w = 0.5 * (strengths[:-1] + strengths[1:]) if strengths.size == times.size else np.ones(d.size)
    mask = (d >= 0.2) & (d <= 2.0) & (w > 0.05)
    if int(mask.sum()) < 3:
        return None, 0.0
    dd = d[mask]
    ww = w[mask]
    order = np.argsort(dd)
    dd, ww = dd[order], ww[order]
    cw = np.cumsum(ww) / max(float(ww.sum()), _EPS)
    k = int(np.searchsorted(cw, 0.5))
    k = min(k, dd.size - 1)
    period = float(dd[k])
    if period <= 0:
        return None, 0.0
    bpm = 60.0 / period
    # 质量：落在中位数 ±10% 的权重占比
    near = float(ww[np.abs(dd - period) <= 0.1 * period].sum()) / max(float(ww.sum()), _EPS)
    return bpm, float(np.clip(near, 0.0, 1.0))


def median_inter_beat_bpm(beat_times: np.ndarray) -> tuple[float | None, float]:
    """**拍轨中位间隔**（契约 §4.2 的 medianInterBeat 原生口径）：DP 拍轨间隔的中位数。

    与 `beatTrack` 天然同倍频（同一份拍轨的两种统计），所以它不会因为踩镲/八分音
    而跑到两倍速上 —— 那正是「onset 事件间隔」不能参与互验的原因。

    量化补偿：帧长 23.22 ms，单个拍间隔只能落在整数帧上（21 或 22 帧 → 117.9/123.6 BPM），
    中位数会系统性偏一档。所以优先用**两拍跨度的一半**做中位数（同一段量化误差被摊薄一半），
    没有任何两拍跨度样本时才退回单拍间隔。
    """
    if beat_times.size < 4:
        return None, 0.0
    t = beat_times.astype(np.float64)
    iv1 = np.diff(t)
    iv1 = iv1[iv1 > 1e-6]
    if iv1.size < 3:
        return None, 0.0
    iv2 = (t[2:] - t[:-2]) / 2.0 if t.size >= 6 else np.zeros(0)
    iv2 = iv2[iv2 > 1e-6]
    iv = iv2 if iv2.size >= 3 else iv1
    med = float(np.median(iv))
    if med <= 0:
        return None, 0.0
    near = float(np.mean(np.abs(iv - med) <= 0.10 * med))
    return 60.0 / med, float(np.clip(near, 0.0, 1.0))


def beat_track_bpm(beat_times: np.ndarray) -> tuple[float | None, float]:
    """拍轨速度：用「首末拍跨越的总时长 / 拍数」算（比逐拍中位数更抗帧长量化）。"""
    if beat_times.size < 4:
        return None, 0.0
    span = float(beat_times[-1] - beat_times[0])
    if span <= 1e-6:
        return None, 0.0
    bpm = 60.0 * (beat_times.size - 1) / span
    iv = np.diff(beat_times.astype(np.float64))
    iv = iv[iv > 1e-6]
    med = float(np.median(iv)) if iv.size else 0.0
    q = float(np.mean(np.abs(iv - med) <= 0.10 * med)) if med > 0 else 0.0
    return bpm, float(np.clip(q, 0.0, 1.0))


def octave_apart(a: float, b: float, tol: float = 0.05) -> bool:
    """两者是否差正好一个八度（log2 比值 ≈ ±1，容差 ±0.05）。"""
    if a <= 0 or b <= 0:
        return False
    r = abs(float(np.log2(a / b)))
    return abs(r - 1.0) <= tol


def dp_beats(env: np.ndarray, period_frames: float, tightness: float = 100.0) -> np.ndarray:
    """Ellis 式 DP 拍轨：在包络上找「间隔接近 period 且落在 onset 上」的最优链，返回帧下标。

    * 长素材（>40000 帧）按 2/4 倍最大池化抽稀再跑，最后乘回去：2 小时素材也是秒级。
    * 不是等间隔外推：链上的每一拍都必须由包络上的真实峰支撑（否则被别处的链取代）。
    """
    n = int(env.size)
    if n < 4:
        return np.zeros(0, np.int64)
    if not np.isfinite(period_frames) or period_frames < 2:
        return np.zeros(0, np.int64)
    dec = 1
    if n > 120000:
        dec = 4
    elif n > 40000:
        dec = 2
    if dec > 1:
        m = n // dec
        if m < 8:
            dec, m = 1, n
        e = env[: m * dec].reshape(m, dec).max(axis=1)
    else:
        e = np.asarray(env, dtype=np.float64)
        m = n
    P = max(2.0, float(period_frames) / dec)
    lo_off = max(1, int(round(P * 0.6)))
    hi_off = max(lo_off + 1, int(round(P * 1.4)))
    cs = np.zeros(m, dtype=np.float64)
    bl = np.full(m, -1, dtype=np.int64)
    for i in range(m):
        lo = max(0, i - hi_off)
        hi = i - lo_off
        if hi < 0:
            cs[i] = float(e[i])
            continue
        iv = (i - np.arange(lo, hi + 1, dtype=np.float64))
        with np.errstate(divide="ignore", invalid="ignore"):
            pen = -float(tightness) * np.log(iv / P) ** 2
        cand = cs[lo: hi + 1] + pen
        j = int(np.argmax(cand))
        cs[i] = float(e[i]) + float(cand[j])
        bl[i] = lo + j
    tail_from = max(0, m - int(round(2 * P)))
    i = int(np.argmax(cs[tail_from:])) + tail_from
    chain: list[int] = []
    guard = 0
    while i >= 0 and guard <= m:
        chain.append(int(i))
        i = int(bl[i])
        guard += 1
    frames = np.array(chain[::-1], dtype=np.int64) * dec
    if frames.size and frames.max() >= n:
        frames = frames[frames < n]
    return frames


def _fold_log2(value: float, ref: float) -> float:
    """把 log2(value/ref) 折叠到 [-0.5, 0.5)（同一速度的不同倍频视为一致）。"""
    if value <= 0 or ref <= 0:
        return 9.0
    r = float(np.log2(value / ref))
    return r - float(np.round(r))


def estimate(env: np.ndarray, event_times: np.ndarray, event_strength: np.ndarray,
             fps: float, duration_sec: float, tightness: float = 100.0) -> dict:
    """三路估速 → 最终 bpm + 候选表 + 是否互验通过。

    返回 dict：bpm / bpmConfidence / beatPeriodSec / candidates / tempoVerified /
    periodFrames / gridPeriodUsed / warnings（只含本模块负责的两个码）/ onsetCoverage。
    """
    out = {
        "bpm": float(PRIOR_CENTER),
        "bpmConfidence": 0.0,
        "beatPeriodSec": 60.0 / PRIOR_CENTER,
        "candidates": [],
        "tempoVerified": False,
        "periodFrames": fps * 60.0 / PRIOR_CENTER,
        "warnings": [],
        "onsetCoverage": 0.0,
        "beatTrackBpm": None,
        "onsetSpacingBpm": None,
        "beatFrames": np.zeros(0, np.int64),
    }
    if duration_sec <= 0 or fps <= 0:
        out["warnings"].append("NO_ONSET")
        return out

    tg_bpm, tg_q = tempogram_bpm(env, fps)
    # 诊断支路：onset 事件间隔（踩镲会把它砍半）→ 只进 parameters，不进候选表、不参与互验
    onset_sp_bpm, onset_sp_q = onset_spacing_bpm(event_times, event_strength)
    out["onsetSpacingBpm"] = None if onset_sp_bpm is None else round(float(onset_sp_bpm), 2)

    # —— 先用 tempogram 跑一遍 DP 拿拍轨；beatTrack / medianInterBeat 都从这条拍轨来
    seed_bpm = tg_bpm or onset_sp_bpm or PRIOR_CENTER
    seed_period = 60.0 * fps / max(seed_bpm, 1.0)
    beats = dp_beats(env, seed_period, tightness)
    beat_times = beats.astype(np.float64) / fps
    bt_bpm, bt_q = beat_track_bpm(beat_times)
    mi_bpm, mi_q = median_inter_beat_bpm(beat_times)
    if bt_bpm is not None:
        idx = np.clip(beats, 0, max(0, env.size - 1))
        bt_q = float(np.clip(np.mean(env[idx]) / (np.mean(env) + _EPS) / 3.0, 0.0, 1.0))

    raws: list[dict] = []
    if bt_bpm:
        raws.append({"bpm": float(bt_bpm), "source": "beatTrack", "w": 1.0, "q": bt_q})
    if mi_bpm:
        raws.append({"bpm": float(mi_bpm), "source": "medianInterBeat", "w": 0.8, "q": mi_q})
    if tg_bpm:
        raws.append({"bpm": float(tg_bpm), "source": "tempogram", "w": 0.9, "q": tg_q})

    # 兜底：三路都没成 → 用先验 120 并降级（配合 NO_ONSET / NO_GRID 警告）
    if not raws:
        out["warnings"].append("NO_ONSET")
        out["candidates"] = [{"bpm": PRIOR_CENTER, "source": "tempogram", "score": 0.0}]
        return out

    # —— 选值：折叠一致的支持度 × 八度先验（只在近似平局时起作用）
    totals: dict[float, float] = {}
    for cand in raws:
        v = cand["bpm"]
        if not (BPM_MIN <= v <= BPM_MAX):
            continue
        support = 0.0
        for other in raws:
            r = _fold_log2(other["bpm"], v)
            support += other["w"] * float(np.exp(-(r / 0.03) ** 2))
        totals[v] = support * _prior(v) ** 0.35      # 先验只做弱裁决，压不过强一致
    if not totals:
        out["warnings"].append("NO_ONSET")
        return out
    v_max = max(totals.items(), key=lambda kv: kv[1])[0]
    # 八度由**拍轨**定（它真的在包络上找过峰）：拍轨那一档的支持度只要不明显落后
    # （≥85% 最高分）就用拍轨的八度，先验不许把一首 60 BPM 的曲子硬拉到 120。
    bpm = float(v_max)
    if bt_bpm is not None:
        bt_key = None
        for v in totals:
            if abs(_fold_log2(v, float(bt_bpm))) <= 0.02:
                bt_key = v if bt_key is None or abs(v - float(bt_bpm)) < abs(bt_key - float(bt_bpm)) else bt_key
        # 八度归拍轨：只要拍轨那一档不明显落后（≥70% 最高分）就用它的八度
        if bt_key is not None and totals[bt_key] >= 0.70 * totals[v_max]:
            bpm = float(bt_key)
    bpm = float(np.clip(bpm, BPM_MIN, BPM_MAX))

    # —— foldRefine 候选：最终值本身
    # 注意：`tempoVerified` 用**原始** log2 比值（不折叠），这是契约 §4.2 的字面口径：
    # 有一路差一个八度就是「没落在 ±0.02」，不许靠折叠把它抹平。
    agree = [float(np.log2(c["bpm"] / bpm)) if c["bpm"] > 0 and bpm > 0 else 9.0 for c in raws]
    agree_frac = float(np.mean([abs(r) <= VERIFY_TOL for r in agree])) if agree else 0.0
    verified = bool(agree) and all(abs(r) <= VERIFY_TOL for r in agree)

    candidates = [{"bpm": round(c["bpm"], 2), "source": c["source"],
                   "score": round(float(np.clip(0.35 + 0.65 * c["q"] * agree_frac, 0.0, 1.0)), 3)}
                  for c in raws]
    candidates.append({"bpm": round(bpm, 2), "source": "foldRefine",
                       "score": round(float(np.clip(0.30 + 0.70 * agree_frac, 0.0, 1.0)), 3)})
    candidates.sort(key=lambda d: -d["score"])

    # —— 拍轨改用最终 bpm 的周期再跑一次（周期对了，链才对）
    period_frames = 60.0 * fps / max(bpm, 1.0)
    if abs(bpm - seed_bpm) > 1e-6:
        beats2 = dp_beats(env, period_frames, tightness)
        if beats2.size >= beats.size:
            beats = beats2
    beat_times = beats.astype(np.float64) / fps

    # —— 质量三合一：折叠一致率 / tempogram 峰质量 / 网格解释了多少 onset
    coverage = 0.0
    if beat_times.size >= 2 and event_times.size:
        pos = np.searchsorted(beat_times, event_times)
        near = []
        for k, t in enumerate(event_times):
            j = min(max(int(pos[k]), 0), beat_times.size - 1)
            best_d = abs(t - beat_times[j])
            if j > 0:
                best_d = min(best_d, abs(t - beat_times[j - 1]))
            near.append(best_d)
        near = np.asarray(near, dtype=np.float64)
        tol = 0.125 * (60.0 / max(bpm, 1.0))
        wsum = float(event_strength.sum()) + _EPS
        coverage = float(np.clip(event_strength[near <= tol].sum() / wsum, 0.0, 1.0))

    conf = 0.40 * agree_frac + 0.25 * max(tg_q, mi_q, bt_q) + 0.35 * coverage
    if not verified:
        conf *= 0.75
    out.update({
        "bpm": round(bpm, 3),
        "bpmConfidence": round(float(np.clip(conf, 0.0, 1.0)), 3),
        "beatPeriodSec": round(60.0 / max(bpm, 1e-6), 5),
        "candidates": candidates,
        "tempoVerified": verified,
        "periodFrames": period_frames,
        "onsetCoverage": round(coverage, 3),
        "beatFrames": beats,
        "beatTrackBpm": round(float(bt_bpm), 3) if bt_bpm else None,
        "onsetSpacingBpm": out.get("onsetSpacingBpm"),
        "onsetSpacingQuality": round(float(onset_sp_q), 3),
    })

    if out["bpmConfidence"] < 0.5:
        out["warnings"].append("LOW_CONFIDENCE_BPM")
    # TEMPO_HALF_DOUBLE 只在「**主判据三路**（beatTrack / medianInterBeat / tempogram）里
    # 有一路与最终 bpm 差正好一个八度」时给。诊断支路（onsetSpacing，踩镲会把事件间隔
    # 砍半）偏一个八度不算数 —— 那种假警报比漏报更伤信任。
    octave_conflict = [c["bpm"] for c in raws if octave_apart(float(c["bpm"]), bpm)]
    out["octaveConflict"] = [round(float(v), 2) for v in octave_conflict]
    if octave_conflict:
        out["warnings"].append("TEMPO_HALF_DOUBLE")
    return out


# ---------------------------------------------------------------- 分段速度图


def _local_periods(beats: np.ndarray, half_window: int = SEG_PERIOD_WINDOW) -> np.ndarray:
    """逐拍局部周期（秒）：以该拍为中心、±half_window 拍内所有拍间隔的中位数。"""
    n = int(beats.size)
    if n < 3:
        return np.zeros(0, dtype=np.float64)
    d = np.diff(np.asarray(beats, dtype=np.float64))
    d = np.maximum(d, 1e-4)
    out = np.empty(n, dtype=np.float64)
    for k in range(n):
        lo = max(0, k - half_window)
        hi = min(d.size, k + half_window)
        seg = d[lo:hi]
        out[k] = float(np.median(seg)) if seg.size else float(d[min(k, d.size - 1)])
    return out


def _huber_fit(x: np.ndarray, y: np.ndarray, delta: float = 1.345,
               iters: int = 30) -> dict | None:
    """Huber 稳健直线 y = a·(x-x̄) + b（IRLS）；返回 {a,b,xMean,scale}，点数不足回 None。

    a 的单位是「秒 / 拍」，所以 bpm = 60/a。残差用 MAD 定标（比标准差抗离群），
    权重 w = 1（|z|≤δ）/ δ/|z|（否则），迭代到截距变化 < 1e-9 为止。
    """
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    n = int(x.size)
    if n < 2 or y.size != n:
        return None
    xm = float(x.mean())
    xc = x - xm
    sxx = float((xc * xc).sum())
    if sxx <= _EPS:
        return {"a": 0.0, "b": float(y.mean()), "xMean": xm, "scale": 0.0}
    a = float((xc * y).sum()) / sxx
    b = float(y.mean())
    scale = 0.0
    for _ in range(max(1, iters)):
        r = y - (a * xc + b)
        mad = float(np.median(np.abs(r - np.median(r))))
        scale = max(1.4826 * mad, 1e-3)
        z = np.abs(r) / scale
        w = np.where(z <= delta, 1.0, delta / np.maximum(z, 1e-9))
        sw = float(w.sum())
        swx = float((w * xc).sum())
        swxx = float((w * xc * xc).sum())
        swy = float((w * y).sum())
        swxy = float((w * xc * y).sum())
        det = sw * swxx - swx * swx
        if abs(det) <= _EPS:
            break
        a_new = (sw * swxy - swx * swy) / det
        b_new = (swxx * swy - swx * swxy) / det
        done = abs(a_new - a) < 1e-12 and abs(b_new - b) < 1e-9
        a, b = a_new, b_new
        if done:
            break
    if not (np.isfinite(a) and np.isfinite(b)):
        return None
    return {"a": float(a), "b": float(b), "xMean": xm, "scale": float(scale)}


def _split_gains(logp: np.ndarray, s: int, e: int,
                 min_beats: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """区间 [s,e) 内所有合法切点的（SSE 增益，两侧平均对数周期差），向量化算。

    增益 = 1 - 子段 SSE / 父段 SSE；差 = |右半平均 log 周期 - 左半平均 log 周期|，
    用来挡住「抖动抖出来的假切点」（速度其实没变，只是局部周期晃了两三个毫秒）。
    """
    n = e - s
    if n < 2 * min_beats:
        return (np.zeros(0, dtype=np.int64), np.zeros(0, dtype=np.float64),
                np.zeros(0, dtype=np.float64))
    seg = logp[s:e]
    c1 = np.cumsum(seg)
    c2 = np.cumsum(seg * seg)
    total = float(c1[-1])
    total2 = float(c2[-1])
    sse_p = total2 - total * total / n
    if sse_p <= 1e-12:
        return (np.zeros(0, dtype=np.int64), np.zeros(0, dtype=np.float64),
                np.zeros(0, dtype=np.float64))
    ks = np.arange(s + min_beats, e - min_beats + 1, dtype=np.int64)
    left = (ks - s).astype(np.float64)
    right = (e - ks).astype(np.float64)
    sl = c1[(ks - s) - 1]
    s2l = c2[(ks - s) - 1]
    sr = total - sl
    s2r = total2 - s2l
    sse = (s2l - sl * sl / left) + (s2r - sr * sr / right)
    delta = np.abs(sr / right - sl / left)
    return ks, 1.0 - sse / sse_p, delta


def _hint_indices(beats: np.ndarray, snap_points) -> set[int]:
    """段落边界提示 → 最近的拍序号（只收 |Δt| ≤ SEG_SNAP_SEC 的）。"""
    out: set[int] = set()
    n = int(beats.size)
    if n == 0:
        return out
    for raw in snap_points or ():
        try:
            t = float(raw)
        except Exception:
            continue
        if not np.isfinite(t):
            continue
        j = int(np.searchsorted(beats, t))
        for k in (j - 1, j):
            if 0 <= k < n and abs(float(beats[k]) - t) <= SEG_SNAP_SEC:
                out.add(int(k))
    return out


def _merge_shortest(ranges: list[tuple[int, int]], limit: int) -> list[tuple[int, int]]:
    """段数超上限时反复把最短段并进较短的邻段（兜底，正常路径不会走到）。"""
    while len(ranges) > max(1, int(limit)) and len(ranges) > 1:
        lens = [(e - s) for (s, e) in ranges]
        i = int(np.argmin(lens))
        if i == 0:
            j = 1
        elif i == len(ranges) - 1:
            j = i - 1
        else:
            j = i - 1 if lens[i - 1] <= lens[i + 1] else i + 1
        lo, hi = min(i, j), max(i, j)
        ranges[lo:hi + 1] = [(ranges[lo][0], ranges[hi][1])]
    return ranges


def _segment_ranges(logp: np.ndarray, min_beats: int, gain_min: float,
                    hints: set[int], max_segments: int) -> list[tuple[int, int]]:
    """递归二分：只保留提升足够大的切点；段落边界提示点用打折的门槛。"""
    n = int(logp.size)
    if n <= 0:
        return []
    ranges: list[tuple[int, int]] = [(0, n)]
    hint_arr = np.array(sorted(hints), dtype=np.int64) if hints else np.zeros(0, np.int64)
    while len(ranges) < max(1, int(max_segments)):
        best = None
        for i, (s, e) in enumerate(ranges):
            ks, gains, deltas = _split_gains(logp, s, e, min_beats)
            if ks.size == 0:
                continue
            j = int(np.argmax(gains))
            ok = (float(gains[j]) >= gain_min
                  and float(deltas[j]) >= SEG_MIN_DELTA_LOG)
            if not ok and hint_arr.size:
                mask = np.isin(ks, hint_arr) & (deltas >= SEG_MIN_DELTA_LOG)
                if bool(mask.any()):
                    jj = int(np.argmax(np.where(mask, gains, -np.inf)))
                    if float(gains[jj]) >= gain_min * SEG_HINT_GAIN:
                        j, ok = jj, True
            if not ok:
                continue
            g = float(gains[j])
            if best is None or g > best[0]:
                best = (g, i, int(ks[j]))
        if best is None:
            break
        _, i, k = best
        s, e = ranges.pop(i)
        ranges.insert(i, (s, k))
        ranges.insert(i + 1, (k, e))
    return _merge_shortest(ranges, max_segments)


def _fit_ranges(beats: np.ndarray, ranges: list[tuple[int, int]], fallback_bpm: float) -> list[dict]:
    """逐段 Huber 回归 → [{fromIdx,toIdx,bpm,beat0,fitDevMs}]。"""
    out: list[dict] = []
    idx = np.arange(beats.size, dtype=np.float64)
    for (s, e) in ranges:
        e = min(int(e), int(beats.size))
        if e <= s:
            continue
        fit = _huber_fit(idx[s:e], beats[s:e]) if (e - s) >= 2 else None
        bpm = fallback_bpm
        beat0 = float(beats[s])
        dev = 0.0
        if fit is not None and fit["a"] > 1e-6:
            cand = 60.0 / float(fit["a"])
            if np.isfinite(cand) and BPM_MIN * 0.6 <= cand <= BPM_MAX * 1.5:
                bpm = float(cand)
                beat0 = float(fit["a"] * (s - fit["xMean"]) + fit["b"])
                res = beats[s:e] - (fit["a"] * (idx[s:e] - fit["xMean"]) + fit["b"])
                dev = float(np.median(np.abs(res))) * 1000.0
        out.append({"fromIdx": int(s), "toIdx": int(e),
                    "bpm": float(np.clip(bpm, BPM_MIN * 0.6, BPM_MAX * 1.5)),
                    "beat0": float(beat0), "fitDevMs": round(float(dev), 2)})
    return out


def tempo_confidence(env: np.ndarray | None, fps: float, bpm: float,
                     start_sec: float = 0.0, end_sec: float = 0.0,
                     fallback_acf: np.ndarray | None = None) -> tuple[float, str]:
    """用 onset 包络自相关复核这一段速度 → (置信度 0-1, 倍频提示)。

    提示取值：`none`（拍周期上就是主峰）/`double`（半拍处更强，真实速度可能是两倍）/
    `half`（两拍处更强，真实速度可能是一半）。段窗口太短就用全曲包络（fallback_acf）。
    """
    if env is None or env.size < 32 or fps <= 0 or bpm <= 0:
        return 0.0, "none"
    period_frames = 60.0 * float(fps) / float(bpm)
    if period_frames < 2.0 or period_frames * 2.5 > float(env.size):
        return 0.0, "none"
    lo = max(0, int(float(start_sec) * fps))
    hi = int(float(end_sec) * fps) if end_sec and end_sec > 0 else int(env.size)
    hi = min(int(env.size), hi)
    acf = None
    if hi - lo >= max(128, int(6.0 * period_frames)):
        acf = _acf(env[lo:hi])
    if acf is None or acf.size < 8:
        acf = fallback_acf if fallback_acf is not None else _acf(env)
    a1 = _acf_at(acf, period_frames)
    ah = _acf_at(acf, period_frames / 2.0)
    a2 = _acf_at(acf, period_frames * 2.0)
    hint = "none"
    if ah > a1 + OCTAVE_MARGIN:
        hint = "double"
    elif a2 > a1 + OCTAVE_MARGIN:
        hint = "half"
    # 局部基线：拍周期邻域之外的自相关水平（倍频 lag 是结构性高峰，不能当基线）
    base = 0.0
    lo_l = max(2, int(round(0.55 * period_frames)))
    hi_l = min(int(acf.size) - 1, int(round(1.8 * period_frames)))
    if hi_l > lo_l + 1:
        lags = np.arange(lo_l, hi_l + 1, dtype=np.float64)
        keep = np.abs(lags - period_frames) > 0.12 * period_frames
        if bool(keep.any()):
            base = float(np.median(acf[lags[keep].astype(np.int64)]))
    peak = float(np.clip((a1 - base) / 0.30, 0.0, 1.0))
    contrast = float(np.clip((a1 - base) / 0.15, 0.0, 1.0))
    conf = 0.65 * peak + 0.35 * contrast
    if hint != "none":
        conf *= 0.60
    return round(float(np.clip(conf, 0.0, 1.0)), 3), hint


def tempo_map(beats_sec, duration_sec: float, env: np.ndarray | None = None,
              fps: float = 0.0, snap_points=(), max_segments: int = MAX_TEMPO_SEGMENTS) -> dict:
    """拍点序列 → 分段速度图 `[{start,end,bpm,beat0,...}]` + 全局 tempoConfidence。

    * 切段依据：拍序号↔时刻的局部周期突变（对数周期的递归二分），段落边界提示点降门槛参与；
    * 每段用 Huber 稳健回归定 bpm（秒/拍取倒数）与相位 beat0（该段首拍时刻）；
    * 半步/倍步由 onset 包络自相关逐段复核，写进 `octaveHint` 并压低该段 confidence；
    * 段数超 `max_segments` 时合并最短段。

    返回 {segments, tempoConfidence, segmentsCount, bpmRange, octaveReview, hintCount}。
    """
    empty = {"segments": [], "tempoConfidence": 0.0, "segmentsCount": 0,
             "bpmRange": {"min": 0.0, "max": 0.0}, "octaveReview": [], "hintCount": 0}
    dur = float(duration_sec or 0.0)
    if dur <= 0:
        return empty
    beats = np.asarray(beats_sec if beats_sec is not None else [], dtype=np.float64)
    beats = beats[np.isfinite(beats)]
    beats = np.unique(np.clip(beats, 0.0, dur))
    n = int(beats.size)
    if n < 2:
        return empty

    periods = _local_periods(beats)
    fallback_bpm = float(np.clip(60.0 / max(1e-6, float(np.median(periods)) if periods.size
                                          else 60.0 / PRIOR_CENTER), 20.0, 400.0))
    hints = _hint_indices(beats, snap_points)
    if n < MIN_SEG_BEATS * 2:
        ranges = [(0, n)]
    else:
        logp = np.log(np.maximum(periods, 1e-4))
        ranges = _segment_ranges(logp, MIN_SEG_BEATS, SEG_GAIN_MIN, hints, max_segments)
    fits = _fit_ranges(beats, ranges, fallback_bpm)
    if not fits:
        return empty

    global_acf: list[np.ndarray | None] = [None]
    segments: list[dict] = []
    review: list[dict] = []
    for i, fit in enumerate(fits):
        start = 0.0 if i == 0 else float(beats[fit["fromIdx"]])
        end = dur if i == len(fits) - 1 else float(beats[fits[i + 1]["fromIdx"]])
        if end <= start:
            end = min(dur, start + 1e-3)
        if env is not None and global_acf[0] is None and float(fps) > 0:
            global_acf[0] = _acf(env)
        conf, hint = tempo_confidence(env, fps, fit["bpm"], start, end,
                                      fallback_acf=global_acf[0])
        if env is None or float(fps) <= 0:
            # 没有包络可比对时退回「拟合残差」口径：残差越小越可信，封顶 0.6
            dev = float(fit["fitDevMs"])
            conf = round(float(np.clip(1.0 - dev / 40.0, 0.0, 1.0)) * 0.6, 3)
            hint = "none"
        seg = {"start": round(start, 4), "end": round(end, 4),
               "bpm": round(float(fit["bpm"]), 3),
               "beat0": round(float(np.clip(fit["beat0"], 0.0, dur)), 4),
               "confidence": conf, "octaveHint": hint,
               "beatFrom": int(fit["fromIdx"]), "beatTo": int(fit["toIdx"]),
               "fitDevMs": float(fit["fitDevMs"])}
        segments.append(seg)
        if hint != "none":
            review.append({"index": i, "bpm": seg["bpm"], "hint": hint})

    total = sum(max(0.0, float(s["end"]) - float(s["start"])) for s in segments) or 1.0
    conf = sum(float(s["confidence"]) * max(0.0, float(s["end"]) - float(s["start"]))
               for s in segments) / total
    bpms = [float(s["bpm"]) for s in segments]
    return {
        "segments": segments,
        "tempoConfidence": round(float(np.clip(conf, 0.0, 1.0)), 3),
        "segmentsCount": len(segments),
        "bpmRange": {"min": round(min(bpms), 3), "max": round(max(bpms), 3)},
        "octaveReview": review,
        "hintCount": len(hints),
    }


def beats_from_map(segments: list[dict], duration_sec: float, min_gap: float = 0.02,
                   grid_end: float | None = None) -> np.ndarray:
    """按分段速度图重生成拍点（去抖动、但仍跟真实变速）：返回升序拍点数组。

    每段从 `beat0` 起按固定周期推进；段界与上一段末拍比相位（偏离 ≤ 半拍就采信拟合相位，
    否则贴回「上一段末拍 + 本段周期」，保证不出现跨拍空隙）。`grid_end` 用来收口末尾，
    避免把等间隔网格外推进静音里（契约不变量 9）。
    就地给每个 segment 补 `beatIndex0`（该段首拍的全局拍序号）与 `beats`（生成拍数）。
    """
    out: list[float] = []
    last: float | None = None
    dur = float(duration_sec or 0.0)
    for seg in segments or ():
        try:
            bpm = float(seg.get("bpm") or 0.0)
            t = float(seg.get("beat0") or 0.0)
            end = float(seg.get("end") if seg.get("end") is not None else dur)
        except Exception:
            continue
        if bpm <= 1.0 or not np.isfinite(bpm):
            continue
        period = 60.0 / bpm
        end = min(end, dur)
        if grid_end is not None and end >= dur - 1e-9:
            end = min(end, float(grid_end))
        seg["beatIndex0"] = len(out)
        before = len(out)
        if last is not None:
            guess = last + period
            if t <= last + min_gap or abs(t - guess) > 0.5 * period:
                t = guess
        guard = 0
        while t < end - 1e-9:
            if last is None or t > last + min_gap:
                out.append(round(float(t), 4))
                last = t
            t += period
            guard += 1
            if guard > 200000:
                break
        seg["beats"] = int(len(out) - before)
    return np.array(out, dtype=np.float64)


# ---------------------------------------------------------------- 纯函数（逐帧 / 渲染共用）


def _segment_at(segments: list[dict], t: float) -> dict | None:
    """t 落在哪一段（segments 按 start 升序；段数 ≤ 64，线性扫描足够）。"""
    pick = None
    for seg in segments or ():
        if float(seg.get("start") or 0.0) <= float(t):
            pick = seg
        else:
            break
    return pick


def beat_at(segments: list[dict], t: float) -> float:
    """t（秒）→ 连续拍位置（0 基，段内 beat0 记作该段第 0 拍）；t 在首拍前为负。"""
    if not segments:
        return 0.0
    seg = _segment_at(segments, t) or segments[0]
    bpm = float(seg.get("bpm") or 0.0)
    if bpm <= 0:
        return 0.0
    return float(seg.get("beatIndex0") or 0) + (float(t) - float(seg.get("beat0") or 0.0)) * bpm / 60.0


def beat_time(segments: list[dict], index: float) -> float:
    """连续拍位置 → 时刻（秒）：beat_at 的反函数，逐帧排时间线用。"""
    if not segments:
        return 0.0
    seg = None
    for item in segments:
        if int(item.get("beatIndex0") or 0) <= float(index):
            seg = item
        else:
            break
    seg = seg or segments[0]
    bpm = float(seg.get("bpm") or 0.0)
    if bpm <= 0:
        return 0.0
    return float(seg.get("beat0") or 0.0) + (float(index) - int(seg.get("beatIndex0") or 0)) * 60.0 / bpm


def phase_at(segments: list[dict], t: float) -> float:
    """拍内连续相位 [0,1)：0 = 正落在拍上，0.5 = 两拍正中。"""
    pos = beat_at(segments, t)
    return float(pos - math.floor(pos))


def bar_at(segments: list[dict], t: float, bar_length: int = 4,
           downbeat_phase: int = 0) -> dict:
    """t（秒）→ {barIndex, beatInBar, beatIndex, phase, barStartSec}。

    barIndex 可以 <0（首拍之前），下游自己判范围；downbeat_phase 取 global.downbeatPhase。
    """
    length = max(1, int(bar_length or 4))
    phase0 = int(downbeat_phase or 0) % length
    pos = beat_at(segments, t)
    idx = int(math.floor(pos))
    bar_index = int((idx - phase0) // length)
    beat_in_bar = int((idx - phase0) % length)
    return {
        "barIndex": bar_index,
        "beatInBar": beat_in_bar,
        "beatIndex": idx,
        "phase": float(pos - idx),
        "barStartSec": round(float(beat_time(segments, bar_index * length + phase0)), 4),
    }
