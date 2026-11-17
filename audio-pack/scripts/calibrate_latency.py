"""检测器系统延迟标定：在合成脉冲 / 点击轨（真值已知）上量每个检测器的固定延迟。

用法（cwd 任意；只读仓库代码，只写调用方给的 json 与临时目录）：

    python scripts/calibrate_latency.py                # 打表（原始延迟 / contract 值 / 校正后残差）
    python scripts/calibrate_latency.py --check        # 对账：偏差超容差就退出码 1
    python scripts/calibrate_latency.py --json <文件>  # 结果落盘（check.py 与冒烟读它）

量的是「输出时刻 − 真实事件时刻」的中位数（毫秒，正 = 输出偏晚）：

| 检测器   | 量什么                                        | 期望            |
|----------|-----------------------------------------------|-----------------|
| onsets   | `onsets.events[].t`（1 ms attack 精修链）      | 约 -1.5 ms      |
| beats    | `beatGrid.beatsSec`（同一条 attack 精修链）    | 与 onsets 同值  |
| curves   | `energy.curves.rms` 的峰位置（块 RMS 栅格）    | 约 -半块        |
| onset    | `energy.curves.onset` 的峰位置（差分派生）     | 与 curves 同值  |
| kick     | `energy.curves.kick` 的峰位置（40–80 Hz 块）   | 与 curves 同值  |
| perFrame | `energy.perFrame.onset` 的峰位置（逐帧池化）   | 约 -半帧        |

「原始延迟」= 把 contract 里的常数临时清零后量到的值（应当就是标定常数本身）；
「残差」= 常数生效后量到的值（应当落在半个栅格以内 —— 那是栅格量化的下限，不是误差）。

全部注释与消息为中文。
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
PACK_ROOT = os.path.dirname(HERE)
for p in (PACK_ROOT, HERE):
    if p not in sys.path:
        sys.path.insert(0, p)

from app import analysis, beats, contract, dsp, tempo  # noqa: E402
import make_fixtures  # noqa: E402  （脉冲 / 点击轨的真值只有一份，在生成器里）

SR = make_fixtures.SR_DEFAULT
#: 标定脉冲：12 个 Dirac，间隔 0.37 s（与块长 / 帧长都不成整数比，相位分布均匀）
PULSE_FIRST_SEC = 0.25
PULSE_GAP_SEC = 0.37
PULSE_COUNT = 12
PULSE_DUR_SEC = 5.2
#: 拍点误差复核用的点击轨
TRACK_BPM = 120.0
TRACK_SEC = 30.0
#: 逐帧标定用的帧率（与 contract 里 perFrame 的名义栅格一致）
FPS = 30.0

DETECTORS = ("onsets", "beats", "curves", "onset", "kick", "perFrame")


# ---------------------------------------------------------------- 量测工具


def _grid_ms(name: str) -> float:
    """该检测器的名义栅格（毫秒）：块长 / 帧长；标量类回 0。"""
    nominal = contract.GRID_LATENCY_NOMINAL_SEC.get(name)
    return float(nominal) * 1000.0 if nominal else 0.0


def _tolerance_ms(name: str) -> float:
    """对账容差：标量类给 LATENCY_TOLERANCE_MS，栅格类再放宽半格（相位均匀分布时的量化极限）。"""
    return contract.LATENCY_TOLERANCE_MS + 0.5 * _grid_ms(name)


def _peak_err_ms(series: np.ndarray, grid_sec: float, truth: list,
                 window: float = 0.1) -> float | None:
    """曲线 / 逐帧系列：每个真值附近 ±window 取峰位置，回相对该真值的中位偏差（毫秒）。"""
    v = np.asarray(series, dtype=np.float64).ravel()
    if v.size == 0 or float(grid_sec) <= 0:
        return None
    times = np.arange(v.size, dtype=np.float64) * float(grid_sec)
    errs = []
    for t in truth:
        sel = np.abs(times - float(t)) <= float(window)
        if not bool(sel.any()):
            continue
        idx = np.flatnonzero(sel)
        j = int(idx[int(np.argmax(v[sel]))])
        errs.append(float(times[j]) - float(t))
    if not errs:
        return None
    return round(float(np.median(np.asarray(errs, dtype=np.float64))) * 1000.0, 3)


def _nearest_err_ms(detected: list, truth: list) -> float | None:
    """事件表：每个真值取最近的检测时刻，回中位偏差（毫秒）。"""
    if not detected:
        return None
    arr = np.asarray(detected, dtype=np.float64)
    errs = []
    for t in truth:
        errs.append(float(arr[int(np.argmin(np.abs(arr - float(t))))]) - float(t))
    if not errs:
        return None
    return round(float(np.median(np.asarray(errs, dtype=np.float64))) * 1000.0, 3)


class _zeroed:
    """临时把 contract 里的延迟常数清零（量原始延迟用），退出时原样恢复。"""

    def __enter__(self):
        self._saved = dict(contract.DETECTOR_LATENCY_MS)
        for k in list(contract.DETECTOR_LATENCY_MS.keys()):
            contract.DETECTOR_LATENCY_MS[k] = 0.0
        return self

    def __exit__(self, *exc):
        contract.DETECTOR_LATENCY_MS.clear()
        contract.DETECTOR_LATENCY_MS.update(self._saved)
        return False


def _impulse_train():
    """标定脉冲轨 → (波形, 真值秒数表)。"""
    times = [PULSE_FIRST_SEC + k * PULSE_GAP_SEC for k in range(PULSE_COUNT)]
    return make_fixtures.pulse_track(times_sec=times, duration_sec=PULSE_DUR_SEC, sr=SR)


def _measure_once(x: np.ndarray, truth: list, fps: float = FPS) -> dict:
    """在当前 contract 常数下把六个检测器各量一遍，返回 {检测器: 毫秒 或 None}。"""
    duration = float(x.size) / float(SR)
    hop, n_fft = int(contract.GRID_FULL["hopLength"]), int(contract.GRID_FULL["nFft"])
    feats = dsp.frame_features(x, SR, hop, n_fft)
    env = dsp.flux_norm(feats)
    attack_env, attack_dt, _ = dsp.attack_curve(x, SR)
    frame_rate = SR / float(hop)
    out: dict = {}

    # —— onsets：完整 onset 链（谱通量峰拾取 → 1 ms attack 精修）
    events, lag = analysis._detect_onsets(feats, env, attack_env, attack_dt, duration)
    out["onsets"] = _nearest_err_ms([float(e["t"]) for e in events], truth)

    # —— beats：同一条 attack 精修链（拍轨帧轻微抖动，模拟 DP 落点不齐）
    frames = np.array([int(round(float(t) * frame_rate)) + (k % 3) - 1
                       for k, t in enumerate(truth)], dtype=np.int64)
    ref = beats.refine(frames, frame_rate, float(lag), attack_env, attack_dt, duration)
    out["beats"] = _nearest_err_ms([float(t) for t in ref["beatsSec"]], truth)

    # —— curves / onset / kick：块 RMS 栅格上的峰位置
    curves = dsp.hi_rate_curves(x, SR)
    hop_sec = curves.hop_sec()
    out["curves"] = _peak_err_ms(curves.rms, hop_sec, truth)
    out["onset"] = _peak_err_ms(curves.onset, hop_sec, truth)
    out["kick"] = _peak_err_ms(curves.kick, hop_sec, truth)

    # —— perFrame：逐帧池化后的逐帧 onset 峰位置
    pf = dsp.per_frame_pool(curves, fps, duration)
    out["perFrame"] = _peak_err_ms(pf["onset"], float(pf["frameSec"]), truth, window=0.12)
    return out


def _track_error() -> dict:
    """合成点击轨（120 BPM / 30 s）上的拍点误差：整条内部链跑一遍，再对真值。

    不经 ffmpeg、不落盘：与 analysis._compute 同一条链（帧特征 → onset → 速度 → 拍网格）。
    """
    x, truth = make_fixtures.click_track(TRACK_BPM, TRACK_SEC, sr=SR)
    duration = float(x.size) / float(SR)
    hop, n_fft = int(contract.GRID_FULL["hopLength"]), int(contract.GRID_FULL["nFft"])
    feats = dsp.frame_features(x, SR, hop, n_fft)
    env = dsp.flux_norm(feats)
    attack_env, attack_dt, _ = dsp.attack_curve(x, SR)
    events, lag = analysis._detect_onsets(feats, env, attack_env, attack_dt, duration)
    ev_t = np.array([e["t"] for e in events], dtype=np.float64) if events else np.zeros(0)
    ev_s = np.array([e["strength"] for e in events], dtype=np.float64) if events else np.zeros(0)
    info = tempo.estimate(env, ev_t, ev_s, SR / float(hop), duration)
    grid = beats.build(feats, env, info, attack_env, attack_dt, lag, duration,
                       np.zeros(0), contract.ENERGY_HOP_SEC, False)
    b = [float(v) for v in (grid.get("beatsSec") or [])]
    t_truth = [float(t) for t in truth]
    errs = []
    last = None
    if b:
        arr = np.asarray(b, dtype=np.float64)
        for t in t_truth:
            j = int(np.argmin(np.abs(arr - t)))
            errs.append(abs(float(arr[j]) - t) * 1000.0)
        j_last = int(np.argmin(np.abs(arr - t_truth[-1])))
        last = abs(float(arr[j_last]) - t_truth[-1]) * 1000.0
    return {
        "bpm": round(float(info["bpm"]), 3),
        "beats": len(b),
        "truthBeats": len(t_truth),
        "medianMs": round(float(np.median(errs)), 3) if errs else None,
        "maxMs": round(float(max(errs)), 3) if errs else None,
        "lastMs": round(float(last), 3) if last is not None else None,
    }


# ---------------------------------------------------------------- 对账


def calibrate(fps: float = FPS) -> dict:
    """量原始延迟与校正后残差，返回 {raw, residual, contract, tolerance, gridMs}。"""
    x, truth = _impulse_train()
    with _zeroed():
        raw = _measure_once(x, truth, fps)
    residual = _measure_once(x, truth, fps)
    return {
        "sampleRate": SR,
        "fps": float(fps),
        "pulses": len(truth),
        "raw": {k: (None if raw.get(k) is None else round(float(raw[k]), 3)) for k in DETECTORS},
        "residual": {k: (None if residual.get(k) is None else round(float(residual[k]), 3))
                     for k in DETECTORS},
        "contract": {k: round(float(contract.detector_latency_ms(k)), 3) for k in DETECTORS},
        "tolerance": {k: round(_tolerance_ms(k), 3) for k in DETECTORS},
        "gridMs": {k: round(_grid_ms(k), 3) for k in DETECTORS},
    }


def check(result: dict, track: dict | None = None) -> tuple[bool, list]:
    """对账：原始延迟 vs contract 常数、残差 vs 半格、点击轨拍点误差 < 5 ms。"""
    notes: list = []
    good = True
    for k in DETECTORS:
        raw = result["raw"].get(k)
        res = result["residual"].get(k)
        base = float(result["contract"][k])
        tol = float(result["tolerance"][k])
        if raw is None or res is None:
            good = False
            notes.append("%s：没量到峰（脉冲没落进栅格？）" % k)
            continue
        if abs(float(raw) - base) > tol:
            good = False
            notes.append("%s：原始延迟 %+.2f ms 与 contract 常数 %+.2f ms 差超容差 %.2f ms"
                         % (k, raw, base, tol))
        if abs(float(res)) > tol:
            good = False
            notes.append("%s：校正后残差 %+.2f ms 超过半格容差 %.2f ms" % (k, res, tol))
    if track is not None:
        med = track.get("medianMs")
        if med is None or float(med) >= 5.0:
            good = False
            notes.append("点击轨拍点误差中位 %s ms（要求 <5 ms）"
                         % ("—" if med is None else "%.2f" % float(med)))
        last = track.get("lastMs")
        if last is None or float(last) >= 5.0:
            good = False
            notes.append("点击轨末拍误差 %s ms（要求 <5 ms，末尾不许漂）"
                         % ("—" if last is None else "%.2f" % float(last)))
    return good, notes


def _print_table(result: dict, track: dict | None) -> None:
    print("[audio] 检测器延迟标定（合成脉冲 %d 点 · %d Hz · %g fps）"
          % (result["pulses"], result["sampleRate"], result["fps"]))
    print("  %-9s %10s %10s %10s %9s" % ("检测器", "原始ms", "contract", "残差ms", "容差ms"))
    for k in DETECTORS:
        raw = result["raw"].get(k)
        res = result["residual"].get(k)
        print("  %-9s %10s %10.2f %10s %9.2f"
              % (k, "—" if raw is None else "%+.2f" % raw, result["contract"][k],
                 "—" if res is None else "%+.2f" % res, result["tolerance"][k]))
    if track:
        print("  [..]   点击轨 %.0f BPM / %.0f s：%d 拍（真值 %d）· bpm %.2f · 拍点误差中位 %s ms · 末拍 %s ms"
              % (TRACK_BPM, TRACK_SEC, track["beats"], track["truthBeats"], track["bpm"],
                 track["medianMs"], track["lastMs"]))


def main(argv: list | None = None) -> int:
    ap = argparse.ArgumentParser(description="标定 / 对账各检测器的系统延迟（真值已知的合成素材）")
    ap.add_argument("--check", action="store_true", help="对账：偏差超容差退出码 1")
    ap.add_argument("--json", default="", help="结果写到这个路径（JSON）")
    ap.add_argument("--fps", type=float, default=FPS, help="逐帧标定用的帧率（默认 30）")
    args = ap.parse_args(argv)

    result = calibrate(float(args.fps))
    track = _track_error()
    _print_table(result, track)
    good, notes = check(result, track)
    if args.json:
        path = os.path.abspath(args.json)
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump({"ok": bool(good), "check": bool(args.check), "result": result,
                       "track": track, "notes": notes}, fh, ensure_ascii=False, indent=1)
        print("  [..]   结果：%s" % path)
    for n in notes:
        print("  [FAIL] " + n)
    if args.check and not good:
        print("[audio] latency check done ok=false")
        return 1
    print("[audio] latency check done ok=%s" % ("true" if good else "false"))
    return 0 if good else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
