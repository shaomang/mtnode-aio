"""合成素材生成器（真值已知）：定速点击轨 / 变速斜坡 / 稀疏脉冲 + MP3/AAC 副本。

用法（数据只落调用方给的目录，默认不碰仓库）：

    python scripts/make_fixtures.py --out <目录>
    python scripts/make_fixtures.py --out <目录> --ffmpeg ffmpeg --long-sec 300
    python scripts/make_fixtures.py --out <目录> --only click120_30s

产物（全部登记进 `<目录>/fixtures.json`，含真值 `beatTimesSec`）：

    click120_30s.wav       30 s 定速 120 BPM 点击轨（首拍 0.5 s，0.5 s 一拍）
    click120_300s.wav      300 s（5 分钟）同款 —— 验证「末尾零漂移」
    ramp112to128_60s.wav   60 s 变速斜坡（112 → 128 BPM，按时间线性加速）
    pulse_silence_10s.wav  10 s 稀疏脉冲 + 静音填充 —— 曲线 / 逐帧对齐与容器一致性用
    *.mp3 / *.m4a          上面前两条的 MP3（libmp3lame）与 AAC（m4a）副本

真值口径（写进 manifest，测试断言一律按它算，不靠耳朵）：

* 点击轨的「拍点」= 点击波形第 0 个采样点的时刻（不是包络峰、不是谱通量峰）；
* 斜坡轨的瞬时速度 `bpm(t) = bpmFrom + (bpmTo-bpmFrom) * t / durationSec`，拍点表见 `beatTimesSec`；
* 脉冲轨每个事件是一个采样点的 Dirac（能量集中，对齐判定无歧义），其余全是数字静音；
* 全部素材 16-bit PCM / 22050 Hz 单声道（= 分析采样率，避免重采样再引入一层偏移）。

依赖只有 numpy + 标准库；MP3/AAC 副本要 ffmpeg（没有就只出 WAV，manifest 里如实写）。

全部注释与消息为中文。
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import wave

import numpy as np

#: 合成采样率 = 分析采样率（22050）：素材不做重采样，拍点真值就是采样点真值
SR_DEFAULT = 22050
#: 点击波形：1 kHz 正弦 × 6 ms 指数衰减，30 ms 长（宽而陡，够谱通量峰也够 1 ms attack 精修）
CLICK_HZ = 1000.0
CLICK_DECAY_SEC = 0.006
CLICK_LEN_SEC = 0.03
CLICK_AMP = 0.7
#: 脉冲轨的 Dirac 幅度（单个采样点，0.9 不削顶）
PULSE_AMP = 0.9
#: 固定档位（manifest 与测试都按这几个名字取，别随参数漂移）
LONG_SEC = 300.0
RAMP_FROM = 112.0
RAMP_TO = 128.0
RAMP_SEC = 60.0
PULSE_TIMES = (0.7123, 2.1041, 3.3567, 4.5009, 5.7321, 6.8903, 8.0437, 9.2011)


# ---------------------------------------------------------------- 波形


def click_wave(sr: int = SR_DEFAULT, hz: float = CLICK_HZ, amp: float = CLICK_AMP,
               decay: float = CLICK_DECAY_SEC, length: float = CLICK_LEN_SEC) -> np.ndarray:
    """点击波形（float32）：第 0 个采样点就是拍点，波形只有一个陡峭的上升沿。"""
    n = int(round(float(length) * float(sr)))
    if n <= 0:
        return np.zeros(0, np.float32)
    t = np.arange(n, dtype=np.float64) / float(sr)
    return (float(amp) * np.exp(-t / float(decay)) * np.sin(2.0 * np.pi * float(hz) * t)).astype(np.float32)


def _place(x: np.ndarray, click: np.ndarray, at_sample: int) -> None:
    """把点击波形叠加到 at_sample（越界部分丢弃，不环绕、不补零外推）。"""
    i = int(at_sample)
    if i < 0 or i >= x.size or click.size == 0:
        return
    k = int(min(click.size, x.size - i))
    x[i:i + k] += click[:k]


def click_track(bpm: float = 120.0, duration_sec: float = 30.0, first_beat_sec: float = 0.5,
                sr: int = SR_DEFAULT) -> tuple[np.ndarray, list]:
    """定速点击轨 → (float32 波形, 拍点秒数表)。"""
    x = np.zeros(int(round(float(duration_sec) * sr)), np.float32)
    click = click_wave(sr)
    period = 60.0 / float(bpm)
    times: list[float] = []
    t = float(first_beat_sec)
    while t < float(duration_sec) - 0.02:
        i = int(round(t * sr))
        _place(x, click, i)
        times.append(round(i / float(sr), 6))
        t += period
    return x, times


def ramp_track(bpm_from: float = RAMP_FROM, bpm_to: float = RAMP_TO,
               duration_sec: float = RAMP_SEC, first_beat_sec: float = 0.5,
               sr: int = SR_DEFAULT) -> tuple[np.ndarray, list]:
    """变速斜坡（加速度）：拍间隔按「该拍起点处的瞬时 bpm」推进 → (波形, 拍点秒数表)。

    瞬时速度是时间的线性函数 `bpm(t) = from + (to-from)·t/dur`，所以拍点表天然是
    一条密度渐增的序列：tempoMap 应切出多段、段 bpm 单调上升、末段明显快于首段。
    """
    x = np.zeros(int(round(float(duration_sec) * sr)), np.float32)
    click = click_wave(sr)
    times: list[float] = []
    t = float(first_beat_sec)
    dur = float(duration_sec)
    while t < dur - 0.02:
        i = int(round(t * sr))
        _place(x, click, i)
        times.append(round(i / float(sr), 6))
        bpm_t = float(bpm_from) + (float(bpm_to) - float(bpm_from)) * (t / dur)
        t += 60.0 / bpm_t
    return x, times


def pulse_track(times_sec=PULSE_TIMES, duration_sec: float = 10.0, sr: int = SR_DEFAULT,
                amp: float = PULSE_AMP) -> tuple[np.ndarray, list]:
    """稀疏脉冲 + 静音填充：每个事件一个采样点的 Dirac → (波形, 事件秒数表)。"""
    x = np.zeros(int(round(float(duration_sec) * sr)), np.float32)
    times: list[float] = []
    for t in times_sec:
        i = int(round(float(t) * sr))
        if 0 <= i < x.size:
            x[i] += float(amp)
            times.append(round(i / float(sr), 6))
    return x, times


def write_wav(path: str, x: np.ndarray, sr: int = SR_DEFAULT) -> str:
    """写 16-bit PCM 单声道 WAV（削顶保护在这一处做）。"""
    pcm = (np.clip(np.asarray(x, dtype=np.float32), -1.0, 1.0) * 32767.0).astype("<i2")
    with wave.open(path, "wb") as fh:
        fh.setnchannels(1)
        fh.setsampwidth(2)
        fh.setframerate(int(sr))
        fh.writeframes(pcm.tobytes())
    return path


# ---------------------------------------------------------------- 容器副本


def _run(cmd: list, timeout: float = 120.0) -> int:
    """跑一条外部命令（不弹窗），返回退出码。"""
    try:
        kwargs = {}
        if os.name == "nt":
            kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           timeout=timeout, **kwargs)
        return int(p.returncode)
    except Exception:
        return -1


def transcode(ffmpeg: str | None, src: str, dst: str, args: list) -> bool:
    """用 ffmpeg 把 WAV 转成容器副本；ffmpeg 缺失 / 编码器缺失都回 False（不抛异常）。"""
    if not ffmpeg:
        return False
    code = _run([ffmpeg, "-hide_banner", "-v", "error", "-y", "-i", src] + list(args) + [dst])
    return code == 0 and os.path.isfile(dst) and os.path.getsize(dst) > 0


#: 容器 → ffmpeg 参数（都是 22050 Hz 单声道；码率给足，别让编码器自己把瞬态磨掉）
CONTAINERS = {
    "mp3": ["-c:a", "libmp3lame", "-b:a", "192k"],
    "m4a": ["-c:a", "aac", "-b:a", "192k"],
}


# ---------------------------------------------------------------- 总装


def build(out_dir: str, ffmpeg: str | None = "ffmpeg", sr: int = SR_DEFAULT,
          long_sec: float = LONG_SEC, only: list | None = None,
          with_containers: bool = True) -> dict:
    """生成全部（或 `only` 指定的）素材，返回 manifest（同时写 `<out_dir>/fixtures.json`）。"""
    os.makedirs(out_dir, exist_ok=True)
    wanted = set(str(x) for x in (only or []))
    want = lambda name: (not wanted) or (name in wanted)  # noqa: E731
    fixtures: list[dict] = []

    def _emit(name: str, kind: str, x: np.ndarray, times: list, extra: dict,
              containers=("mp3", "m4a")) -> None:
        wav = os.path.join(out_dir, name + ".wav")
        write_wav(wav, x, sr)
        have = {"wav": os.path.basename(wav)}
        if with_containers:
            for ext in containers:
                dst = os.path.join(out_dir, "%s.%s" % (name, ext))
                if transcode(ffmpeg, wav, dst, CONTAINERS[ext]):
                    have[ext] = os.path.basename(dst)
        item = {
            "name": name,
            "kind": kind,
            "sampleRate": int(sr),
            "durationSec": round(float(x.size) / float(sr), 6),
            "beatTimesSec": [round(float(t), 6) for t in times],
            "beatCount": len(times),
            "containers": have,
        }
        item.update(extra)
        fixtures.append(item)

    if want("click120_30s"):
        x, times = click_track(120.0, 30.0, sr=sr)
        _emit("click120_30s", "click", x, times,
              {"bpm": 120.0, "firstBeatSec": 0.5, "periodSec": 0.5,
               "note": "定速 120 BPM：拍点误差 <5 ms、三种容器一致（±1 帧）都按它判"})

    if want("click120_300s"):
        x, times = click_track(120.0, float(long_sec), sr=sr)
        _emit("click120_300s", "click", x, times,
              {"bpm": 120.0, "firstBeatSec": 0.5, "periodSec": 0.5,
               "note": "5 分钟定速点击轨：末尾拍点仍要贴住真值（零漂移），文件大，按需生成"})

    if want("ramp112to128_60s"):
        x, times = ramp_track(RAMP_FROM, RAMP_TO, RAMP_SEC, sr=sr)
        _emit("ramp112to128_60s", "ramp", x, times,
              {"bpmFrom": RAMP_FROM, "bpmTo": RAMP_TO, "firstBeatSec": 0.5,
               "bpmAtSec": "bpmFrom + (bpmTo - bpmFrom) * t / durationSec",
               "note": "变速斜坡：tempoMap 要切出多段、段 bpm 单调上升、每段贴住 bpmAtSec(段中点)"},
              containers=())

    if want("pulse_silence_10s"):
        x, times = pulse_track(duration_sec=10.0, sr=sr)
        _emit("pulse_silence_10s", "pulse", x, times,
              {"note": "Dirac 脉冲 + 静音填充：energy.curves 与 energy.perFrame 的峰值要对齐到 <1 帧"},
              containers=())

    manifest = {
        "version": 1,
        "generator": "audio-pack/scripts/make_fixtures.py",
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "sampleRate": int(sr),
        "ffmpeg": bool(ffmpeg),
        "fixtures": fixtures,
    }
    with open(os.path.join(out_dir, "fixtures.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=1)
    return manifest


def main(argv: list | None = None) -> int:
    ap = argparse.ArgumentParser(description="生成真值已知的合成素材（点击轨 / 斜坡 / 脉冲 + 容器副本）")
    ap.add_argument("--out", required=True, help="输出目录（不存在会建；素材与 fixtures.json 都写这里）")
    ap.add_argument("--ffmpeg", default=os.environ.get("MT_AUDIO_FFMPEG") or "ffmpeg",
                    help="ffmpeg 路径（做 MP3/AAC 副本；没有就只出 WAV）")
    ap.add_argument("--sr", type=int, default=SR_DEFAULT, help="合成采样率（默认 22050 = 分析采样率）")
    ap.add_argument("--long-sec", type=float, default=LONG_SEC, help="5 分钟档的实际时长（默认 300 s）")
    ap.add_argument("--only", action="append", default=[], help="只生成这一条（可重复）")
    ap.add_argument("--no-containers", action="store_true", help="不生成 MP3/AAC 副本")
    ap.add_argument("--quiet", action="store_true", help="只打一行汇总")
    args = ap.parse_args(argv)

    ffmpeg = args.ffmpeg
    if ffmpeg and not os.path.isfile(ffmpeg):
        ffmpeg = "ffmpeg"          # 让 PATH 再试一次
    if ffmpeg and _run([ffmpeg, "-version"]) != 0:
        print("  [..]   没有可用的 ffmpeg → 只出 WAV（容器一致性用例会自动跳过）")
        ffmpeg = None

    started = time.perf_counter()
    manifest = build(os.path.abspath(args.out), ffmpeg=ffmpeg, sr=int(args.sr),
                     long_sec=float(args.long_sec), only=list(args.only or []),
                     with_containers=not args.no_containers)
    cost = (time.perf_counter() - started) * 1000.0
    if not args.quiet:
        for f in manifest["fixtures"]:
            print("  [OK]   %-22s %6.2f s  %4d 拍  容器=%s"
                  % (f["name"], f["durationSec"], f["beatCount"],
                     ",".join(sorted(f["containers"]))))
    print("[fixtures] out=%s n=%d %d ms" % (os.path.abspath(args.out),
                                            len(manifest["fixtures"]), int(cost)))
    return 0 if manifest["fixtures"] else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
