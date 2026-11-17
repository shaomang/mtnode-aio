"""DSP：分块 STFT / 谱通量 onset / 三带与鼓型 / 0.1s 能量 / attack 细栅格 /
高频曲线（hop≈5.8 ms）与逐帧池化 perFrame。

几条不许违反的口径：

* 帧下标与秒的换算**只在本文件实现一次**（`frame_sec` / `sec_frame`），别的模块调用它们；
  帧 i 的时间 = i * hop / sr（第 0 帧对应第 0 个采样点，窗居中靠前后各补 nFft/2 个零点）。
* 三带按**功率**求和后归一到和 ≈1（不变量第 6 条）；分界 low<150Hz / 150-2000Hz / ≥2000Hz。
* 0.1 s 能量栅格与帧网格**互不派生**：能量点 k 覆盖 [k*0.1, (k+1)*0.1)，按采样点精确切段。
* 高频曲线（rms/low/mid/high/onset/kick）的 hop 是**等时间**口径：256 采样点 @44.1k ≈ 5.8 ms，
  按分析采样率同步缩放（22050→128、11025→64），所以降采样档的时间分辨率与默认档完全一致。
* 块栅格与逐帧栅格都按 `contract.DETECTOR_LATENCY_MS` 做半格对齐（块 k 的中心 / 帧 k 的中心
  正好落在 k·hopSec 上）：不对齐的话点 k 的标签取的是块（帧）起点，会系统性早半个栅格。
  对齐量按采样点（块）/ 秒（帧）整数或浮点平移，不改数组长度、不改契约里「第 k 点的时刻」。
* 全程 float32/float64 分流：功率求和走 float64，避免 float32 溢出与累计误差。
* 空数组、全零、除零一律有兜底（宁可给 0 也不许出 NaN）。

全部注释与消息为中文。
"""

from __future__ import annotations

import numpy as np

from . import contract

# ---------------------------------------------------------------- 常量

#: 三带分界（Hz）
BAND_LOW_HZ = 150.0
BAND_HIGH_HZ = 2000.0
#: 6 带（sub/bass/lowMid/mid/presence/air）分界（Hz）
BANDS6_EDGES = (0.0, 60.0, 250.0, 500.0, 2000.0, 4000.0, 1e9)
BANDS6_NAMES = ("sub", "bass", "lowMid", "mid", "presence", "air")
#: 鼓型窄带核（Hz）：kick / snare / hat
DRUM_KICK_HZ = (40.0, 80.0)
DRUM_SNARE_HZ = (150.0, 900.0)
DRUM_HAT_HZ = (5000.0, 11000.0)
DRUM_HAT_HZ_DOWNSAMPLED = (5000.0, 5500.0)

_EPS = 1e-12


# ---------------------------------------------------------------- 坐标换算（唯一实现）


def frame_sec(idx, sr: int, hop: int) -> float:
    """帧下标 → 秒：t = idx * hop / sr。"""
    return float(idx) * hop / float(sr)


def sec_frame(t: float, sr: int, hop: int) -> int:
    """秒 → 帧下标（四舍五入）：frame = round(t * sr / hop)。"""
    return int(round(float(t) * sr / float(hop)))


def frame_sec_array(n: int, sr: int, hop: int) -> np.ndarray:
    """全部帧的时间（秒），float64。"""
    return np.arange(n, dtype=np.float64) * (hop / float(sr))


# ---------------------------------------------------------------- 帧级特征


class FrameFeatures:
    """整段音频的帧级特征（一次扫描得到，供 tempo/beats/sections/viz 复用）。"""

    __slots__ = ("sr", "hop", "n_fft", "n_frames", "flux", "total", "low", "mid", "high",
                 "bands6", "kick", "snare", "hat", "flat", "peakf", "db_offset",
                 "spec", "spec_rows", "spec_cols", "spec_norm", "downsampled")

    def __init__(self, sr: int, hop: int, n_fft: int, n_frames: int, downsampled: bool):
        self.sr = sr
        self.hop = hop
        self.n_fft = n_fft
        self.n_frames = n_frames
        self.downsampled = downsampled
        #: 功率 → dBFS 的换算偏移 = 20*log10(nFft/4)（hann 窗下半幅正弦的标定）
        self.db_offset = 20.0 * np.log10(max(1.0, n_fft / 4.0))
        self.flux = np.zeros(n_frames, np.float64)          # 谱通量（原始值）
        self.total = np.zeros(n_frames, np.float64)         # 全带功率
        self.low = np.zeros(n_frames, np.float64)           # <150 Hz 功率
        self.mid = np.zeros(n_frames, np.float64)           # 150-2000 Hz 功率
        self.high = np.zeros(n_frames, np.float64)          # ≥2000 Hz 功率
        self.bands6 = np.zeros((n_frames, 6), np.float64)   # 6 带功率
        self.kick = np.zeros(n_frames, np.float64)          # 40-80 Hz 幅度
        self.snare = np.zeros(n_frames, np.float64)         # 150-900 Hz 幅度
        self.hat = np.zeros(n_frames, np.float64)           # 5k-11k（降采样 5k-5.5k）幅度
        self.flat = np.zeros(n_frames, np.float64)          # 频谱平坦度 0-1
        self.peakf = np.zeros(n_frames, np.float64)         # 谱峰频率（Hz，判鼓型用）
        self.spec_norm = np.zeros((1, 1), np.float32)       # 频谱图（已归一 0-1，行=频率、列=时间）
        self.spec_rows = 0
        self.spec_cols = 0
        self.spec = None                                    # 占位（不用，保持 slots 完整）

    def frame_times(self) -> np.ndarray:
        return frame_sec_array(self.n_frames, self.sr, self.hop)

    @property
    def energy_scale(self) -> float:
        """全曲帧功率最大值（0 表示整段无声）。"""
        m = float(self.total.max()) if self.n_frames else 0.0
        return m if m > _EPS else 0.0


def _band_slice(freqs: np.ndarray, lo: float, hi: float) -> slice:
    """频率数组里 [lo, hi) 的下标范围（保证非空）。"""
    i0 = int(np.searchsorted(freqs, lo, side="left"))
    i1 = int(np.searchsorted(freqs, hi, side="left"))
    i0 = max(0, min(i0, freqs.size - 1))
    i1 = max(i0 + 1, min(i1, freqs.size))
    return slice(i0, i1)


def frame_features(x: np.ndarray, sr: int, hop: int, n_fft: int,
                   downsampled: bool = False, spec_cols: int = 1024,
                   spec_rows: int = 256) -> FrameFeatures:
    """一次扫描得到全部帧级特征（分块处理，频谱按块聚合，不整段驻留）。"""
    x = np.ascontiguousarray(x, dtype=np.float32)
    n_samples = int(x.size)
    pad = n_fft // 2
    if n_samples <= 0:
        return FrameFeatures(sr, hop, n_fft, 0, downsampled)
    xp = np.concatenate([np.zeros(pad, np.float32), x,
                         np.zeros(pad + n_fft, np.float32)])
    win = np.hanning(n_fft).astype(np.float32)
    view = np.lib.stride_tricks.sliding_window_view(xp, n_fft)
    n_frames = 1 + (xp.size - n_fft) // hop
    n_frames = max(0, min(n_frames, view.shape[0] // hop if hop else 0))
    ff = FrameFeatures(sr, hop, n_fft, n_frames, downsampled)
    if n_frames <= 0:
        return ff

    freqs = np.fft.rfftfreq(n_fft, d=1.0 / sr)
    sl_low = _band_slice(freqs, 0.0, BAND_LOW_HZ)
    sl_mid = _band_slice(freqs, BAND_LOW_HZ, BAND_HIGH_HZ)
    sl_high = _band_slice(freqs, BAND_HIGH_HZ, float(freqs[-1]) + 1.0)
    sl_b6 = [_band_slice(freqs, lo, hi) for lo, hi in zip(BANDS6_EDGES[:-1], BANDS6_EDGES[1:])]
    sl_kick = _band_slice(freqs, *DRUM_KICK_HZ)
    sl_snare = _band_slice(freqs, *DRUM_SNARE_HZ)
    hat_hz = DRUM_HAT_HZ_DOWNSAMPLED if downsampled else DRUM_HAT_HZ
    sl_hat = _band_slice(freqs, *hat_hz)

    # 频谱图：行 = 对数频率（20Hz→Nyquist），列 = 时间（最多 1024 列）
    nyq = float(freqs[-1])
    rows = int(max(8, spec_rows))
    cols = int(max(1, min(spec_cols, n_frames)))
    ff.spec_rows, ff.spec_cols = rows, cols
    row_edges = np.geomspace(20.0, max(21.0, nyq), rows + 1)
    row_start = np.searchsorted(freqs, row_edges[:-1], side="left")
    row_start = np.clip(row_start, 0, freqs.size - 1).astype(np.int64)
    row_start = np.maximum.accumulate(row_start)     # 必须单调不减（reduceat 要求）
    col_of_frame = (np.arange(n_frames, dtype=np.int64) * cols) // n_frames
    spec_sum = np.zeros((rows, cols), np.float64)
    spec_cnt = np.zeros(cols, np.float64)

    block = 512
    prev_logmag = None
    mag_scale = 4.0 / float(n_fft)                   # 正弦幅度校准：A ≈ 4*Σmag/nFft
    for start in range(0, n_frames, block):
        stop = min(n_frames, start + block)
        frames = view[start * hop: stop * hop: hop]
        frames = frames[: stop - start]
        if frames.shape[0] == 0:
            break
        spec_block = np.fft.rfft(frames * win, n=n_fft, axis=1)
        mag = np.abs(spec_block).astype(np.float32)
        del spec_block
        power = mag.astype(np.float64) ** 2
        logmag = np.log1p(mag)

        # —— 谱通量（半波整流的对数幅度差，再对频点求和）
        if prev_logmag is not None:
            ff.flux[start] = float(np.maximum(logmag[0] - prev_logmag, 0.0).sum())
            diff = np.maximum(logmag[1:] - logmag[:-1], 0.0)
            ff.flux[start + 1: stop] = diff.sum(axis=1)
        else:
            ff.flux[start] = 0.0
            if logmag.shape[0] > 1:
                diff = np.maximum(logmag[1:] - logmag[:-1], 0.0)
                ff.flux[start + 1: stop] = diff.sum(axis=1)
        prev_logmag = logmag[-1]

        # —— 三带 / 6 带（功率和，float64）
        ff.low[start: stop] = power[:, sl_low].sum(axis=1)
        ff.mid[start: stop] = power[:, sl_mid].sum(axis=1)
        ff.high[start: stop] = power[:, sl_high].sum(axis=1)
        ff.total[start: stop] = power.sum(axis=1)
        for k, sl in enumerate(sl_b6):
            ff.bands6[start: stop, k] = power[:, sl].sum(axis=1)
        # —— 鼓型窄带（幅度和 × 校准）
        ff.kick[start: stop] = mag[:, sl_kick].sum(axis=1) * mag_scale
        ff.snare[start: stop] = mag[:, sl_snare].sum(axis=1) * mag_scale
        ff.hat[start: stop] = mag[:, sl_hat].sum(axis=1) * mag_scale
        # —— 频谱平坦度（几何均值 / 算术均值，0-1）
        m_pos = mag.astype(np.float64) + 1e-9
        geo = np.exp(np.mean(np.log(m_pos), axis=1))
        arith = np.mean(m_pos, axis=1)
        ff.flat[start: stop] = np.clip(geo / np.maximum(arith, _EPS), 0.0, 1.0)
        # —— 谱峰频率（判鼓型：峰不在任何窄带里就不许硬判成某个鼓）
        ff.peakf[start: stop] = freqs[np.argmax(mag, axis=1)]

        # —— 频谱图列聚合（同一列内多帧取均值，dB 域）
        rows_db = 20.0 * np.log10(np.maximum(
            np.maximum.reduceat(mag, row_start, axis=1), 1e-9))
        my_cols = col_of_frame[start: stop]
        lo_c, hi_c = int(my_cols[0]), int(my_cols[-1])
        for c in range(lo_c, hi_c + 1):
            sel = (my_cols == c)
            n_sel = int(sel.sum())
            if n_sel:
                spec_sum[:, c] += rows_db[sel].sum(axis=0)
                spec_cnt[c] += n_sel
        del power, mag, logmag

    # —— 频谱图归一（5% ~ 99.5% 分位拉伸，抗单点爆音）
    norm = spec_sum / np.maximum(spec_cnt, 1.0)[None, :]
    if np.isfinite(norm).any():
        lo = float(np.percentile(norm, 5.0))
        hi = float(np.percentile(norm, 99.5))
        if hi - lo < 6.0:
            hi = lo + 6.0
        ff.spec_norm = np.clip((norm - lo) / (hi - lo), 0.0, 1.0).astype(np.float32)
    else:
        ff.spec_norm = np.zeros((rows, cols), np.float32)
    return ff


def flux_norm(ff: FrameFeatures) -> np.ndarray:
    """谱通量归一到 [0,1]（全零时回全零，绝不除零）。"""
    if ff.n_frames <= 0:
        return np.zeros(0, np.float64)
    m = float(ff.flux.max())
    if m <= _EPS:
        return np.zeros(ff.n_frames, np.float64)
    return ff.flux / m


# ---------------------------------------------------------------- 0.1 s 能量栅格


def rms_grid(x: np.ndarray, sr: int, hop_sec: float = 0.1):
    """0.1 s RMS 栅格：返回 (rms float64[points], rms_db, global_rms_db, peak_db)。

    点 k 覆盖 [k*hop_sec, (k+1)*hop_sec) —— 用采样点精确切段，与帧网格无关；
    points = max(1, ceil(durationSec / hop_sec))。
    """
    x = np.ascontiguousarray(x, dtype=np.float32)
    n = int(x.size)
    dur = n / float(sr) if sr else 0.0
    points = int(max(1, np.ceil(dur / hop_sec - 1e-9))) if n else 0
    if n == 0 or points == 0:
        return (np.zeros(0, np.float64), np.zeros(0, np.float64), -80.0, -80.0)
    edges = np.round(np.arange(points + 1, dtype=np.float64) * hop_sec * sr).astype(np.int64)
    edges = np.clip(edges, 0, n)
    edges = np.maximum.accumulate(edges)
    sq = np.square(x, dtype=np.float64)
    starts = edges[:-1]
    if starts.size and starts[-1] >= n:      # 末段起点越界（极短素材）→ 去掉空段
        keep = starts < n
        starts = starts[keep]
        edges = np.concatenate([starts, [n]])
        points = int(starts.size)
        if points == 0:
            return (np.zeros(0, np.float64), np.zeros(0, np.float64), -80.0, -80.0)
    sums = np.add.reduceat(sq, starts)
    counts = np.diff(np.concatenate([starts, [n]])) if starts.size else np.zeros(0, np.int64)
    counts = np.maximum(counts.astype(np.float64), 1.0)
    rms = np.sqrt(np.maximum(sums, 0.0) / counts)
    rms_db = np.clip(20.0 * np.log10(np.maximum(rms, 1e-9)), -80.0, 0.0)
    g_rms = float(np.sqrt(max(float(np.mean(sq)), 0.0)))
    g_db = float(np.clip(20.0 * np.log10(max(g_rms, 1e-9)), -80.0, 0.0))
    peak = float(np.clip(20.0 * np.log10(max(float(np.abs(x).max()), 1e-9)), -80.0, 0.0))
    return rms, rms_db, g_db, peak


def norm01(values: np.ndarray) -> np.ndarray:
    """归一到 [0,1]（除以最大值；全零回全零）。"""
    v = np.asarray(values, dtype=np.float64)
    if v.size == 0:
        return v
    m = float(v.max())
    if m <= _EPS:
        return np.zeros_like(v)
    return np.clip(v / m, 0.0, 1.0)


# ---------------------------------------------------------------- attack 细栅格（1 ms）


def attack_curve(x: np.ndarray, sr: int, hop_sec: float = 0.001):
    """返回 (包络 float32, 每点秒数 dt, 每点采样数)：|x| 经 3 ms 平滑后按 1 ms 下采样。

    用途：把谱通量的峰（有半窗偏置）精修到真实 attack 起点。
    """
    x = np.ascontiguousarray(x, dtype=np.float32)
    if x.size == 0:
        return np.zeros(0, np.float32), float(hop_sec), max(1, int(round(hop_sec * sr)))
    h = max(1, int(round(hop_sec * sr)))
    k = max(1, int(round(0.003 * sr)))
    amp = np.abs(x)
    if k > 1 and amp.size > k:
        ker = np.ones(k, np.float32) / float(k)
        amp = np.convolve(amp, ker, mode="same")
    n = max(1, amp.size // h)
    env = amp[: n * h].reshape(n, h).mean(axis=1).astype(np.float32)
    return env, float(h) / float(sr), h


def refine_attack(env: np.ndarray, dt: float, t0: float, search_sec: float = 0.06) -> float:
    """在 [t0-search, t0+search] 内找包络上升最快的位置（真实 attack），返回秒。"""
    n = int(env.size)
    if n < 3:
        return max(0.0, float(t0))
    lo = int((t0 - search_sec) / dt)
    hi = int((t0 + search_sec) / dt)
    lo = max(0, min(lo, n - 2))
    hi = max(lo + 1, min(hi, n - 1))
    seg = env[lo: hi + 1]
    der = np.diff(seg.astype(np.float64))
    if der.size == 0:
        return max(0.0, float(t0))
    k = int(np.argmax(der))
    return max(0.0, (lo + k + 1) * dt)


# ---------------------------------------------------------------- 峰拾取


def pick_peaks(env: np.ndarray, min_gap_frames: int, delta: float = 0.05,
               pre: int = 3, post: int = 3, avg: int = 6) -> np.ndarray:
    """谱通量峰拾取（最小间隔按帧给），返回升序帧下标。

    判据与 librosa 同口径：局部前最大 + 后最大 + 前后均值 + delta 阈值。
    存在的意义是「否定」：噪底上的小起伏不许当 onset。
    """
    n = int(env.size)
    if n < 3:
        return np.zeros(0, np.int64)
    pad = max(1, pre)
    c = np.concatenate([np.zeros(pad), env, np.zeros(pad)])
    pre_max = np.max(np.lib.stride_tricks.sliding_window_view(c, 2 * pad + 1), axis=1)
    pa = max(1, avg)
    c2 = np.concatenate([np.zeros(pa), env, np.zeros(pa)])
    pre_avg = np.mean(np.lib.stride_tricks.sliding_window_view(c2, 2 * pa + 1), axis=1)
    post_max = np.zeros(n)
    post_avg = np.zeros(n)
    if n - post > 0:
        post_max[: n - post] = pre_max[post:]
        post_avg[: n - post] = pre_avg[post:]
    ok = (env == pre_max) & (env >= post_max) & \
         (env >= pre_avg + delta) & (env >= post_avg + delta) & (env > 0)
    idx = np.flatnonzero(ok)
    if idx.size == 0:
        return np.zeros(0, np.int64)
    gap = max(1, int(min_gap_frames))
    order = idx[np.argsort(-env[idx], kind="stable")]
    keep: list[int] = []
    for i in order:
        if all(abs(int(i) - j) >= gap for j in keep):
            keep.append(int(i))
    return np.array(sorted(keep), dtype=np.int64)


# ---------------------------------------------------------------- 三带 / 鼓型


def relative_bands(ff: FrameFeatures, idx: int) -> tuple[dict, dict]:
    """某帧的三带相对占比（和≈1）与三带绝对电平（dBFS）。"""
    lo = float(ff.low[idx])
    mi = float(ff.mid[idx])
    hi = float(ff.high[idx])
    tot = lo + mi + hi
    if tot <= _EPS:
        bands = {"low": 0.0, "mid": 0.0, "high": 0.0}
    else:
        bands = {"low": lo / tot, "mid": mi / tot, "high": hi / tot}
        # 归一残差并进最大的一带，保证三数和严格落在 [0.98, 1.02]
        s = bands["low"] + bands["mid"] + bands["high"]
        key = max(bands, key=bands.get)
        bands[key] += 1.0 - s
    db = {
        "low": _db(lo, ff.db_offset),
        "mid": _db(mi, ff.db_offset),
        "high": _db(hi, ff.db_offset),
    }
    return bands, db


def _db(power: float, offset: float = 0.0) -> float:
    """FFT 功率 → dBFS（0 = 满刻度，底 -80）。

    offset = 20*log10(nFft/4)：把「hann 窗下一根谱线的功率」标定成满刻度正弦的 0 dB。
    """
    if power <= _EPS:
        return -80.0
    return float(np.clip(10.0 * np.log10(power) - offset, -80.0, 0.0))


def classify_drum(ff: FrameFeatures, idx: int, downsampled: bool) -> tuple[str, float]:
    """窄带鼓型核：kick 40-80 / snare 150-900 / hat 5k-11k（降采样时 5k-5.5k，阈值更高）。

    两条纪律：
    * 该帧的**谱峰**必须落在某个窄带里，否则一律 `perc`（1 kHz 的点击不是军鼓，
      窄带里的那点能量只是矩形包络的旁瓣泄漏）；
    * 降采样时 hat 上限只到 5.5 kHz，证据更弱 → `drumConfidence` 门槛抬高，
      宁可给 `perc` 也不硬判成 hat。
    """
    k = float(ff.kick[idx])
    s = float(ff.snare[idx])
    h = float(ff.hat[idx])
    flat = float(ff.flat[idx])
    peak = float(ff.peakf[idx]) if ff.n_frames else 0.0
    if flat >= 0.30:
        # 频谱越平坦越像噪声/故障音
        return "glitch", float(np.clip(0.4 + (flat - 0.3), 0.0, 1.0))
    if k + s + h <= 1e-6:
        return "perc", 0.2
    hat_hi = DRUM_HAT_HZ_DOWNSAMPLED[1] if downsampled else DRUM_HAT_HZ[1]
    in_kick = DRUM_KICK_HZ[0] <= peak < DRUM_KICK_HZ[1]
    in_snare = DRUM_SNARE_HZ[0] <= peak < DRUM_SNARE_HZ[1]
    in_hat = DRUM_HAT_HZ[0] <= peak < hat_hi
    if not (in_kick or in_snare or in_hat):
        # 谱峰根本不在任何鼓的窄带里 → 只说「有一下敲击」，不猜是哪个鼓
        return "perc", 0.3
    shares = np.array([k / (k + s + h), s / (k + s + h), h / (k + s + h)], dtype=np.float64)
    order = np.argsort(-shares)
    lead, second = float(shares[order[0]]), float(shares[order[1]])
    conf = float(np.clip((lead - second) / 0.35, 0.0, 1.0))
    names = ("kick", "snare", "hat")
    name = names[int(order[0])]
    # 谱峰所在的带必须同时是窄带里的领先者，否则证据自相矛盾 → perc
    peak_band = "kick" if in_kick else ("snare" if in_snare else "hat")
    if peak_band != name:
        return "perc", max(0.2, min(conf, 0.5))
    if lead - second < 0.06:
        return "perc", max(0.2, conf)
    if name == "hat":
        need = 0.6 if downsampled else 0.55
        if conf < need:
            return "perc", max(0.2, conf)
    return name, conf


# ---------------------------------------------------------------- 高频曲线（hop≈5.8 ms）

#: 曲线 hop 的基准：256 采样点 @44.1k ≈ 5.805 ms；按分析采样率**等时间**缩放（22050→128、11025→64）
CURVE_HOP_SAMPLES_REF = 256
CURVE_SR_REF = 44100.0
#: 曲线名（顺序即下发顺序）
CURVE_KEYS = ("rms", "low", "mid", "high", "onset", "kick")
#: 瞬态类曲线（池化取 max，其余取 mean）
CURVE_TRANSIENT_KEYS = ("onset", "kick")
#: 逐帧池化的非对称平滑：5 ms 起 / 150 ms 落（卡点闪拍靠它不抖）
PERFRAME_ATTACK_SEC = 0.005
PERFRAME_RELEASE_SEC = 0.150
#: FIR 分带滤波器的抽头数（22050 下过渡带 ≈36 Hz；采样率减半时同比减半，过渡带不变）
CURVE_FIR_TAPS = 2048
#: 曲线标尺的绝对下限（-80 dBFS）：低于它一律当静音，避免把 ±1 LSB 的底噪放大成满量程
CURVE_FLOOR = 1e-4
#: 下发预算：raw 曲线 / perFrame 各给多少点（超出按整数 stride 抽稀；detail 开关放大预算）
#: perFrame 默认 7200 点 = 4 分钟 @30 fps 的**逐帧原生**数据（任务给的体积基准），
#: 更长的素材自动按整数 stride 合并（响应里给 stride 与真实 frameSec），所以体积有上限、不随时长爆；
#: raw 曲线只是「看包络」的那条支路，精度上限在 onsets.events，故给得紧（1024 / detail 4096）
CURVE_MAX_POINTS = 1024
CURVE_MAX_POINTS_DETAIL = 4096
PERFRAME_MAX_POINTS = 7200
PERFRAME_MAX_POINTS_DETAIL = 21600


def curve_hop(sr: int) -> int:
    """曲线 hop（采样点）：等时间口径 256@44.1k，采样率减半时同步减半（降采样档 64）。"""
    return int(max(1, round(CURVE_HOP_SAMPLES_REF * float(max(1, int(sr))) / CURVE_SR_REF)))


def _grid_align_sec(name: str, grid_sec: float, compensate: bool = True) -> float:
    """栅格类检测器的时间对齐量（秒，负 = 栅格提前）。

    取 `contract.DETECTOR_LATENCY_MS` 的标定值；若它与「半个栅格」的差落在容差内（栅格类本来
    就是结构性半格），就取**精确的半格** —— 常数是四舍五入过的毫秒值，差几十微秒就会让箱边界
    落在 0.4996 而不是 0.5，实测会出现「整格不移动」的假校正。
    """
    if not compensate or float(grid_sec) <= 0:
        return 0.0
    latency_sec = contract.detector_latency_sec(name, grid_sec=float(grid_sec))
    half = 0.5 * float(grid_sec)
    tol_sec = max(contract.LATENCY_TOLERANCE_MS / 1000.0, 1e-6)
    if abs(abs(latency_sec) - half) <= tol_sec:
        return -half if latency_sec < 0 else half
    return latency_sec


def align_offset_samples(sr: int, name: str, grid_sec: float, compensate: bool = True) -> int:
    """块栅格的半格对齐偏移（采样点，正 = 栅格向后挪）：块 k 覆盖 [k·hop+off, (k+1)·hop+off)。

    目的：让块 k 的**中心**落在 k·hopSec 上，这样契约里「第 k 个点的时刻 = k·hopSec」才成立。
    延迟常数为负（输出偏早半块）时 off 也是负（栅格提前半块），只平移不改变数组长度。
    `compensate=False` 给标定用（量原始延迟）。
    """
    if not compensate:
        return 0
    latency_sec = _grid_align_sec(name, float(grid_sec))
    return int(round(latency_sec * float(max(1, int(sr)))))


def _fir_band(sr: int, lo: float, hi: float, taps: int) -> np.ndarray:
    """窗函数 sinc 带通 FIR（线性相位）：通带 [lo, hi) Hz，hann 窗压旁瓣，峰值增益归一到 1。

    lo=0 时即低通。用 hann 而不是矩形窗，是为了让带外真的安静——
    否则低频带漏进大把中频，kick 曲线就没法当触发信号用。
    注意 sinc 的自变量是**采样点序号**（不是秒）：2fc·sinc(2fc·n) 才是截止 fc 的理想低通。
    """
    taps = int(max(9, int(taps) | 1))              # 奇数抽头 → 群延迟是整数采样
    n = np.arange(taps, dtype=np.float64) - (taps - 1) / 2.0
    fh = min(0.49, max(1e-6, float(hi) / float(sr)))       # 归一化到 cycles/sample
    fl = min(fh, max(0.0, float(lo) / float(sr)))
    h = 2.0 * fh * np.sinc(2.0 * fh * n)
    if fl > 1e-6:
        h -= 2.0 * fl * np.sinc(2.0 * fl * n)
    h *= np.hanning(taps)
    peak = float(np.abs(np.fft.rfft(h, n=8192)).max())
    if peak > _EPS:
        h = h / peak
    return h


def _fir_filter(x: np.ndarray, h: np.ndarray, block: int = 8192) -> np.ndarray:
    """FIR 分块卷积（overlap-save + 群延迟补偿，FFT 实现，不依赖 scipy）：输出与输入等长且**零相位对齐**。

    h 是线性相位（对称）的，因果卷积的群延迟是 (taps-1)/2；不补这一下，
    分带结果会整体晚 ~46 ms，`wide - lp` 这种差分会把相位差放大成假高频。
    全程 float32（FFT 也只到 complex64）：2 小时素材上亿个采样，float64 光缓冲就要几 GB。
    """
    n = int(x.size)
    taps = int(h.size)
    if n <= 0:
        return np.zeros(0, np.float32)
    if taps <= 1:
        return np.ascontiguousarray(x, dtype=np.float32).copy()
    delay = (taps - 1) // 2                     # 群延迟（采样点）
    blk = int(max(block, taps))
    span = blk + taps - 1
    nfft = 1 << int(np.ceil(np.log2(float(span))))
    spec = np.fft.rfft(np.asarray(h, dtype=np.float32), n=nfft)
    xf = np.ascontiguousarray(x, dtype=np.float32)
    # 两端用「边缘复制」而不是补零：补零等于给滤波器一个阶跃，会在首尾伪造出假高频
    # （首尾各 ~90 ms 仍有滤波器启动残差：这一段别把带能量当真）
    xp = np.concatenate([np.full(taps - 1, float(xf[0]), np.float32), xf,
                         np.full(span, float(xf[-1]), np.float32)])
    total = n + delay
    raw = np.zeros(total, np.float32)
    for start in range(0, total, blk):
        seg = xp[start: start + span]
        if seg.size < span:
            seg = np.concatenate([seg, np.full(span - seg.size, float(xf[-1]), np.float32)])
        y = np.fft.irfft(np.fft.rfft(seg, n=nfft) * spec, n=nfft)
        take = min(blk, total - start)
        raw[start: start + take] = y[taps - 1: taps - 1 + take]
    return raw[delay: delay + n]


def _block_rms(y: np.ndarray, hop: int, points: int, offset: int = 0,
               chunk: int = 4096) -> np.ndarray:
    """按 hop 采样点精确切块算 RMS（末块截断按真实长度平均，不补零）。

    块 k 覆盖 `[k*hop + offset, (k+1)*hop + offset)`：`offset` 用来做半格对齐
    （见 `align_offset_samples`），首个块被裁短时按它真实的采样数平均，不补零。
    分块算（每块 chunk 个点）而不是一口气 np.square 整个信号：长素材这样只占几 MB 临时内存。
    """
    n = int(y.size)
    count = int(max(0, points))
    if n <= 0 or count <= 0:
        return np.zeros(max(0, count), np.float64)
    step = int(max(1, int(hop)))
    off = int(offset)
    v = np.asarray(y).ravel()
    out = np.zeros(count, np.float64)
    for k0 in range(0, count, int(max(1, chunk))):
        k1 = min(count, k0 + int(max(1, chunk)))
        lo = k0 * step + off                     # 本段第一块的起点（可 <0）
        a = max(0, lo)
        b = min(n, (k1 - 1) * step + off + step)  # 本段最后一块的终点（可 >n）
        if b <= a:
            break
        seg = np.asarray(v[a:b], dtype=np.float64)
        if lo < 0:
            # 块 0 被信号起点裁短：它只覆盖 [0, -lo)，之后从 -lo 起按 hop 正常切
            starts = np.concatenate([[0], np.arange(-lo, seg.size, step, dtype=np.int64)])
        else:
            # 起点在 seg 内部：块边界相对 seg 从 0 起（不是从绝对下标 lo 起）
            starts = np.arange(0, seg.size, step, dtype=np.int64)
        if starts.size == 0:
            break
        starts = starts[starts < seg.size]
        if starts.size == 0:
            break
        sums = np.add.reduceat(np.square(seg), starts)
        counts = np.diff(np.concatenate([starts, [seg.size]])).astype(np.float64)
        values = np.sqrt(np.maximum(sums, 0.0) / np.maximum(counts, 1.0))
        take = int(min(values.size, count - k0))
        out[k0: k0 + take] = values[:take]
    return out


class HiRateCurves:
    """高频曲线容器：hop 栅格固定（≈5.8 ms），六条曲线各自归一到 0-1。

    * rms：全带块 RMS / 全曲最大块 RMS；
    * low / mid / high：带内块 RMS / **同一条**全曲最大全带 RMS（同一标尺，可横比，功率上三者之和 ≈ rms²）；
    * onset：块 RMS 的半波整流一阶差分 / 全曲最大差分（瞬态触发用）；
    * kick：40-80 Hz 窄带块 RMS / 全曲最大 kick（卡点闪拍用）。
    """

    __slots__ = ("sr", "hop", "points", "rms", "low", "mid", "high", "onset", "kick")

    def __init__(self, sr: int, hop: int):
        self.sr = int(sr)
        self.hop = int(max(1, hop))
        self.points = 0
        for key in CURVE_KEYS:
            setattr(self, key, np.zeros(0, np.float64))

    def hop_sec(self) -> float:
        """每个曲线点代表的秒数（≈0.0058）。"""
        return self.hop / float(self.sr) if self.sr else 0.0

    def duration(self) -> float:
        """曲线覆盖的时长（秒）。"""
        return self.points * self.hop_sec()

    def times(self) -> np.ndarray:
        """每个曲线点的时刻（秒）。"""
        return np.arange(self.points, dtype=np.float64) * self.hop_sec()


def _curve_norm(values: np.ndarray, scale: float) -> np.ndarray:
    """除以标尺并钳到 [0,1]；标尺低于静音门槛（-80 dBFS）时回全零，绝不把底噪放大成满量程。"""
    v = np.asarray(values, dtype=np.float64).ravel()
    if v.size == 0:
        return np.zeros(0, np.float64)
    if not np.isfinite(scale) or scale <= CURVE_FLOOR:
        return np.zeros(v.size, np.float64)
    return np.clip(v / scale, 0.0, 1.0)


def hi_rate_curves(x: np.ndarray, sr: int, hop: int | None = None,
                   compensate: bool = True) -> HiRateCurves:
    """高频曲线：hop≈5.8 ms 的 rms / low / mid / high / onset / kick 六条（各 0-1）。

    分带用线性相位 FIR（overlap-save 已在 `_fir_filter` 里对齐，无额外延迟）：
    low <150 Hz、mid 150-2000 Hz、high ≥2000 Hz（降采样档只到 Nyquist）、kick = 40-80 Hz。
    hop 随采样率等时间缩放，所以降采样档（>600 s，11025 Hz）的时间分辨率与默认档一致。
    `compensate` 打开时按 `contract.DETECTOR_LATENCY_MS`（curves / kick）对块栅格做半格对齐：
    点 k 报的时刻 k·hopSec 就是那一块的中心，未对齐时会系统性早半个 hop（≈2.9 ms）。
    """
    sig = np.ascontiguousarray(x, dtype=np.float32).ravel()
    s = int(max(1, int(sr)))
    step = int(max(1, int(hop) if hop else curve_hop(s)))
    out = HiRateCurves(s, step)
    n = int(sig.size)
    points = int(n // step)
    if points <= 0:
        return out
    out.points = points
    sig = sig[: points * step]
    taps = int(max(63, round(CURVE_FIR_TAPS * float(s) / 22050.0)))
    nyq = 0.5 * float(s)
    hop_sec = step / float(s)
    off_curve = align_offset_samples(s, "curves", hop_sec, compensate)
    off_kick = align_offset_samples(s, "kick", hop_sec, compensate)

    lp_low = _fir_filter(sig, _fir_band(s, 0.0, min(BAND_LOW_HZ, nyq * 0.9), taps))
    lp_mid = _fir_filter(sig, _fir_band(s, 0.0, min(BAND_HIGH_HZ, nyq * 0.9), taps))

    # 就地做差、用完就丢：三段能量同一趟算完，长素材的峰值内存只有 3 条 float32 曲线
    rms_lin = _block_rms(sig, step, points, off_curve)
    low_lin = _block_rms(lp_low, step, points, off_curve)
    np.subtract(lp_mid, lp_low, out=lp_low)          # mid = lp2000 - lp150
    mid_lin = _block_rms(lp_low, step, points, off_curve)
    del lp_low
    np.subtract(sig, lp_mid, out=lp_mid)             # high = 全带 - lp2000
    high_lin = _block_rms(lp_mid, step, points, off_curve)
    del lp_mid
    kick_lin = _block_rms(_fir_filter(sig, _fir_band(s, *DRUM_KICK_HZ, taps)), step, points, off_kick)

    # onset：块 RMS 的半波整流一阶差分（只要「起」，不要「落」）
    onset_lin = np.zeros(points, np.float64)
    if points > 1:
        onset_lin[1:] = np.maximum(np.diff(rms_lin), 0.0)

    scale = float(rms_lin.max())
    out.rms = _curve_norm(rms_lin, scale)
    out.low = _curve_norm(low_lin, scale)
    out.mid = _curve_norm(mid_lin, scale)
    out.high = _curve_norm(high_lin, scale)
    out.onset = _curve_norm(onset_lin, float(onset_lin.max()) if points else 0.0)
    out.kick = _curve_norm(kick_lin, float(kick_lin.max()) if points else 0.0)
    return out


def _pool_bins(values: np.ndarray, hop_sec: float, bin_sec: float, n_bins: int,
               offset_sec: float = 0.0) -> tuple[np.ndarray, np.ndarray]:
    """把 hop 栅格上的曲线按 bin_sec 宽的箱池化，返回 (mean, max) 两条（都用 bin 内真实成员）。

    箱 k 覆盖 `[k*bin_sec + offset_sec, (k+1)*bin_sec + offset_sec)`：`offset_sec` 用来做
    半帧对齐（负值 = 箱提前半帧，让箱 k 的中心落在 k*bin_sec 上）。
    """
    n = int(n_bins)
    v = np.asarray(values, dtype=np.float64).ravel()
    if n <= 0:
        return np.zeros(0, np.float64), np.zeros(0, np.float64)
    if v.size == 0:
        return np.zeros(n, np.float64), np.zeros(n, np.float64)
    width = max(float(bin_sec), float(hop_sec) * 1e-6)
    t = np.arange(v.size, dtype=np.float64) * float(hop_sec) - float(offset_sec)
    idx = np.floor(t / width + 1e-9).astype(np.int64)
    idx = np.maximum.accumulate(np.clip(idx, 0, n - 1))   # 浮点保护：保证非降序
    cnt = np.bincount(idx, minlength=n).astype(np.float64)
    sums = np.bincount(idx, weights=v, minlength=n)
    mean = sums / np.maximum(cnt, 1.0)
    grid = np.arange(n, dtype=np.int64)
    starts = np.searchsorted(idx, grid, side="left")
    ends = np.searchsorted(idx, grid, side="right")
    filled = ends > starts
    peak = np.zeros(n, np.float64)
    if filled.any():
        peak[filled] = np.maximum.reduceat(v, starts[filled])
    return mean, peak


def smooth_ar(values: np.ndarray, dt: float, attack_sec: float = PERFRAME_ATTACK_SEC,
              release_sec: float = PERFRAME_RELEASE_SEC) -> np.ndarray:
    """非对称一阶平滑：上升跟 attack（快）、下降跟 release（慢）。

    卡点闪拍要的是「一下亮起来、慢慢落回去」——对称低通会把瞬态压平、把尾巴拖脏。
    """
    v = np.asarray(values, dtype=np.float64).ravel()
    if v.size == 0:
        return np.zeros(0, np.float64)
    step = float(dt)
    if step <= 0:
        return np.clip(v.copy(), 0.0, 1.0)
    a_att = 1.0 if attack_sec <= 0 else float(min(1.0, 1.0 - np.exp(-step / float(attack_sec))))
    a_rel = 1.0 if release_sec <= 0 else float(min(1.0, 1.0 - np.exp(-step / float(release_sec))))
    out = np.empty(v.size, np.float64)
    prev = float(v[0])
    out[0] = prev
    for i in range(1, v.size):
        x_i = float(v[i])
        prev += (a_att if x_i >= prev else a_rel) * (x_i - prev)
        out[i] = prev
    return np.clip(out, 0.0, 1.0)


def per_frame_pool(curves: HiRateCurves, fps: float, duration: float,
                   max_points: int = PERFRAME_MAX_POINTS,
                   compensate: bool = True) -> dict:
    """逐帧池化：瞬态类取 max（onset/kick）、响度类取 mean（rms/low/mid/high），再套 5 ms/150 ms 平滑。

    每帧区间 [k/fps, (k+1)/fps) 内的曲线点参与池化；总帧数超过 max_points 时按整数
    stride 把若干帧并成一个点（响应里给 stride 与真实 frameSec），这样 2 小时素材也不会撑爆 JSON。
    `compensate` 打开时按 `contract.DETECTOR_LATENCY_MS`（perFrame）把箱提前半帧：
    点 k 报的时刻 k·frameSec 就是那一帧的中心（未对齐时系统性早半帧 ≈ 16.7 ms @30 fps）。
    返回 {fps, frameSec, stride, points, attackSec, releaseSec, rms/low/mid/high/onset/kick: ndarray}。
    """
    rate = float(fps) if fps and float(fps) > 0 else 30.0
    total = int(np.ceil(float(duration) * rate - 1e-9)) if duration > 0 else 0
    cap = int(max(1, int(max_points)))
    stride = int(max(1, int(np.ceil(total / float(cap))))) if total > 0 else 1
    points = int(np.ceil(total / float(stride))) if total > 0 else 0
    frame_sec = float(stride) / rate
    hop_sec = curves.hop_sec()
    offset_sec = _grid_align_sec("perFrame", frame_sec) if compensate else 0.0
    out = {
        "fps": rate,
        "frameSec": frame_sec,
        "stride": stride,
        "points": points,
        "attackSec": float(PERFRAME_ATTACK_SEC),
        "releaseSec": float(PERFRAME_RELEASE_SEC),
    }
    for key in CURVE_KEYS:
        mean, peak = _pool_bins(getattr(curves, key), hop_sec, frame_sec, points, offset_sec)
        raw = peak if key in CURVE_TRANSIENT_KEYS else mean
        out[key] = smooth_ar(raw, frame_sec, PERFRAME_ATTACK_SEC, PERFRAME_RELEASE_SEC)
    return out


def curve_series(curves: HiRateCurves, max_points: int = CURVE_MAX_POINTS,
                 compensate: bool = True) -> dict:
    """raw 曲线下发（不套平滑）：超过 max_points 时按整数 stride 抽稀。

    瞬态类（onset/kick）抽稀取 max、响度类取 mean —— 抽稀也不许把瞬态抹掉。
    返回 {hopSec（抽稀后的真实点距）, nativeHopSec, points, stride, 六条曲线: ndarray}。
    `compensate` 打开时按 `contract.DETECTOR_LATENCY_MS` 把抽稀箱提前半个箱宽：
    点 k 报的时刻 k·hopSec 就是那个箱的中心（不校正时会系统性早半个箱，stride>1 时最多早一箱）。
    """
    n = int(curves.points)
    cap = int(max(1, int(max_points)))
    stride = int(max(1, int(np.ceil(n / float(cap))))) if n > 0 else 1
    points = int(np.ceil(n / float(stride))) if n > 0 else 0
    hop_sec = curves.hop_sec()
    out = {
        "hopSec": hop_sec * stride,
        "nativeHopSec": hop_sec,
        "points": points,
        "stride": stride,
    }
    for key in CURVE_KEYS:
        offset_sec = 0.0
        if compensate:
            name = key if key in ("onset", "kick") else "curves"
            offset_sec = _grid_align_sec(name, hop_sec * stride)
        mean, peak = _pool_bins(getattr(curves, key), hop_sec, hop_sec * stride, points, offset_sec)
        out[key] = peak if key in CURVE_TRANSIENT_KEYS else mean
    return out
