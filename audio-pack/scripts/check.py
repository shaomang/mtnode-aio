"""自检脚本：numpy 版本 / ffmpeg 首行 / 1 秒静音跑出 200 且 warnings 含 NO_GRID / 生成 api-key.txt /
合成素材真值校验（检测器延迟标定 + 拍点误差 + 逐帧对齐 + 容器一致）。

用法（cwd = `<数据目录>\\audio-analysis`，与宿主启动口径一致）：

    <venv>\\Scripts\\python.exe scripts\\check.py
    # 或指定数据目录：
    $env:MT_AUDIO_ROOT = "C:\\temp\\audio-analysis"; python scripts\\check.py

五步全部通过才退出码 0；任一失败退出码 1，并把失败原因写清楚（中文）。

* 第 3 步同时验两条路：直接调 `analysis.analyze_file()`（不经 HTTP）与真起一次服务
  `POST /analyze`（HTTP 200，这才是宿主看到的那条路）。
* 静音素材是**合法输入**：期望 200 + `NO_ONSET` / `NO_GRID` + 空网格（契约「静音素材不是错误」）。
* 第 5 步是**真值校验**（不是自证）：用 `scripts/make_fixtures.py` 造的定速 120 BPM 点击轨、
  变速斜坡与稀疏脉冲，真值已知 —— 拍点误差 <5 ms、三种容器一致（±1 帧）、
  `energy.curves` 与 `energy.perFrame` 在脉冲上对齐 <1 帧、变速轨的分段速度图单调且贴住真值；
  同时用 `scripts/calibrate_latency.py` 把六个检测器的系统延迟与 `contract.DETECTOR_LATENCY_MS` 对账。

全部注释与消息为中文。
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PACK_ROOT = os.path.dirname(HERE)          # audio-pack/（`app` 包的上一级）
for _p in (PACK_ROOT, HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)


def _ok(msg: str) -> None:
    print("  [OK]   " + msg)


def _bad(msg: str) -> None:
    print("  [FAIL] " + msg)


def _info(msg: str) -> None:
    print("  [..]   " + msg)


def step_numpy() -> bool:
    """1) numpy 版本落在 requirements 声明区间。"""
    print("[1/5] numpy")
    try:
        import numpy
    except Exception as exc:
        _bad("import numpy 失败：%s" % exc)
        return False
    version = str(getattr(numpy, "__version__", "?"))
    _info("numpy %s（%s）" % (version, numpy.__file__))
    parts = version.split(".")
    try:
        major, minor = int(parts[0]), int(parts[1])
    except Exception:
        _bad("numpy 版本串无法解析：%s" % version)
        return False
    if major < 1 or (major == 1 and minor < 24) or major >= 3:
        _bad("numpy 版本 %s 不在 requirements 声明的 >=1.24,<3 区间" % version)
        return False
    _ok("numpy %s 可用（>=1.24,<3）" % version)
    return True


def step_ffmpeg() -> tuple[bool, str | None]:
    """2) ffmpeg 可执行 + 首行版本。"""
    print("[2/5] ffmpeg")
    from app import decode
    ffmpeg = decode.find_ffmpeg(os.environ.get("MT_AUDIO_FFMPEG"))
    if not ffmpeg:
        _bad("找不到 ffmpeg（PATH 里没有，也没给 --ffmpeg / MT_AUDIO_FFMPEG）")
        return False, None
    first = decode.ffmpeg_version(ffmpeg)
    if not first:
        _bad("ffmpeg 存在但取版本失败：%s" % ffmpeg)
        return False, None
    _info("ffmpeg 路径：%s" % ffmpeg)
    _ok("ffmpeg -version 首行：ffmpeg version %s" % first)
    return True, ffmpeg


def step_api_key(root: str) -> bool:
    """4) api-key.txt（先做，因为后面起服务要用）。"""
    print("[4/5] api-key.txt")
    from app import serve
    key = serve.ensure_api_key(root)
    path = serve.key_file(root)
    if len(key) != 32:
        _bad("api-key.txt 内容不是 32 位：%r" % key)
        return False
    try:
        int(key, 16)
    except Exception:
        _bad("api-key.txt 不是 hex：%r" % key)
        return False
    _ok("api-key.txt 就绪（%d 位 hex，%s，日志里只打 %s）" % (len(key), path, serve.mask_key(key)))
    return True


def _make_silence(ffmpeg: str, out_path: str, seconds: float = 1.0) -> bool:
    """用 ffmpeg lavfi 造一段静音 wav。"""
    import subprocess
    from app import decode as decode_mod
    cmd = [ffmpeg, "-hide_banner", "-y", "-f", "lavfi", "-i",
           "anullsrc=r=44100:cl=mono", "-t", str(seconds), "-ac", "1", out_path]
    p = decode_mod._run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
    return p.returncode == 0 and os.path.isfile(out_path)


def step_silence(root: str, ffmpeg: str) -> bool:
    """3) 1 秒静音：直接调用 + 真 HTTP 各跑一次。"""
    print("[3/5] 1 秒静音（期望 200 + NO_ONSET/NO_GRID + 空网格）")
    from app import analysis, serve
    tmpdir = tempfile.mkdtemp(prefix="audio-check-")
    wav = os.path.join(tmpdir, "silence-1s.wav")
    try:
        if not _make_silence(ffmpeg, wav):
            _bad("造静音素材失败：ffmpeg lavfi anullsrc")
            return False
        _info("静音素材：%s（%d 字节）" % (wav, os.path.getsize(wav)))

        # —— 3a) 直接调用（不经 HTTP）
        cache = serve.Cache(root)
        t0 = time.perf_counter()
        body = analysis.analyze_file(wav, {"cache": "refresh"}, cache=cache)
        direct_ms = int((time.perf_counter() - t0) * 1000.0)
        codes = [w.get("code") for w in body.get("diagnostics", {}).get("warnings", [])]
        if not body.get("ok"):
            _bad("analyze_file 没回 ok=true")
            return False
        if "NO_GRID" not in codes:
            _bad("warnings 里没有 NO_GRID（实际：%s）" % (codes or "空"))
            return False
        if int(body["beatGrid"]["beatCount"]) != 0 or len(body["beatGrid"]["beatsSec"]) != 0:
            _bad("静音却给出了拍网格：beatCount=%s" % body["beatGrid"]["beatCount"])
            return False
        if int(body["onsets"]["count"]) != 0:
            _bad("静音却给出了 onset：count=%s" % body["onsets"]["count"])
            return False
        _ok("analyze_file 直接调用：beatCount=0 onsets=0 %d ms warnings=%s"
            % (direct_ms, ",".join(codes)))
        if "NO_ONSET" not in codes:
            _info("提示：静音没有 NO_ONSET（本实现只在全零包络时给，属可接受差异）")

        # —— 3b) 真起服务 + POST /analyze（--no-auth，临时端口）
        service = serve.Service(root, ffmpeg, auth_enabled=False, api_key="")
        server = serve.create_server(service, 0)
        port = int(server.server_address[1])
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05},
                                  daemon=True)
        thread.start()
        try:
            base = "http://127.0.0.1:%d" % port
            h_status, health, _h_headers = _http_json(base + "/health", method="GET")
            if h_status != 200 or not isinstance(health, dict):
                _bad("GET /health 返回 %s：%s" % (h_status, str(health)[:300]))
                return False
            if not (health.get("ok") and health.get("decoder", {}).get("found")):
                _bad("/health 的 decoder.found 不是 true：%s" % json.dumps(health)[:300])
                return False
            _ok("/health 200：auth=%s decoder.found=%s version=%s"
                % (health.get("auth"), health["decoder"]["found"], health["decoder"]["version"]))
            status, payload, headers = _http_json(
                base + "/analyze", method="POST",
                body={"audioPath": wav, "options": {"cache": "refresh"}})
            if status != 200:
                _bad("POST /analyze 返回 %s（期望 200）：%s" % (status, str(payload)[:300]))
                return False
            codes = [w.get("code") for w in payload.get("diagnostics", {}).get("warnings", [])]
            if "NO_GRID" not in codes:
                _bad("HTTP 响应 warnings 里没有 NO_GRID：%s" % (codes or "空"))
                return False
            _ok("POST /analyze 200（X-Cache=%s X-Analysis-Ms=%s warnings=%s）"
                % (headers.get("X-Cache"), headers.get("X-Analysis-Ms"), ",".join(codes)))
        finally:
            server.shutdown()
            server.server_close()
            service.cache.close()
            thread.join(timeout=3)
        return True
    finally:
        try:
            for name in os.listdir(tmpdir):
                os.unlink(os.path.join(tmpdir, name))
            os.rmdir(tmpdir)
        except Exception:
            pass


def _beat_errors_ms(detected, truth) -> list:
    """每个真值取最近的检测时刻，回绝对误差（毫秒）列表（真值为空或没检测到就回空）。"""
    import numpy as np
    d = [float(x) for x in (detected or [])]
    t = [float(x) for x in (truth or [])]
    if not d or not t:
        return []
    arr = np.asarray(d, dtype=np.float64)
    return [float(np.min(np.abs(arr - float(x)))) * 1000.0 for x in t]


def _peak_sec(series, grid_sec: float, around: float, window: float = 0.12):
    """在 around±window 内取系列的峰值时刻（秒）；取不到回 None。"""
    import numpy as np
    v = np.asarray(series if series is not None else [], dtype=np.float64)
    if v.size == 0 or float(grid_sec) <= 0:
        return None
    k0 = int(max(0, np.floor((float(around) - float(window)) / float(grid_sec))))
    k1 = int(min(v.size, np.ceil((float(around) + float(window)) / float(grid_sec)) + 1))
    if k1 <= k0:
        return None
    k = k0 + int(np.argmax(v[k0:k1]))
    return float(k) * float(grid_sec)


def step_truth(ffmpeg: str) -> bool:
    """5) 合成素材真值校验：检测器延迟 / 拍点误差 / 容器一致 / 逐帧对齐 / 变速分段。"""
    print("[5/5] 合成素材真值（延迟标定 · 拍点误差 · 容器一致 · 逐帧对齐 · 变速分段）")
    import numpy as np
    from app import analysis, cache as cache_mod
    import calibrate_latency as calib
    import make_fixtures

    ok = True

    # —— 5a) 检测器系统延迟：与 contract.DETECTOR_LATENCY_MS 对账
    result = calib.calibrate()
    track = calib._track_error()
    good, notes = calib.check(result, track)
    for name in calib.DETECTORS:
        raw = result["raw"].get(name)
        res = result["residual"].get(name)
        _info("%-9s 原始 %8s ms · contract %+7.2f · 残差 %8s ms（容差 %.2f）"
              % (name, "—" if raw is None else "%+.2f" % raw, result["contract"][name],
                 "—" if res is None else "%+.2f" % res, result["tolerance"][name]))
    _info("点击轨 %.0f BPM：%s 拍（真值 %s）· 拍点误差中位 %s ms · 末拍 %s ms"
          % (calib.TRACK_BPM, track["beats"], track["truthBeats"],
             track["medianMs"], track["lastMs"]))
    if good:
        _ok("六个检测器的系统延迟与 contract 常数一致，校正后残差 ≤ 半格")
    else:
        ok = False
        for note in notes:
            _bad(note)

    # —— 5b) 合成素材（真值已知）→ 用与 /analyze 同一套 analyze_file 跑断言
    tmp = tempfile.mkdtemp(prefix="audio-truth-")
    try:
        man = make_fixtures.build(tmp, ffmpeg=ffmpeg, long_sec=30.0,
                                  only=["click120_30s", "ramp112to128_60s", "pulse_silence_10s"],
                                  with_containers=True)
        by_name = {f["name"]: f for f in man["fixtures"]}
        cache = cache_mod.Cache(os.path.join(tmp, "_cache"))
        opts = {"viz": {"enabled": False}}

        # 5b-1) 定速 120 BPM：拍点误差 <5 ms，三种容器一致（±1 帧）
        click = by_name.get("click120_30s") or {}
        beats: dict = {}
        frame_sec = 0.0
        for ext, fname in sorted((click.get("containers") or {}).items()):
            body = analysis.analyze_file(os.path.join(tmp, fname), opts, cache=cache)
            frame_sec = float(body["contract"]["frameGrid"]["frameSec"])
            b = [float(v) for v in body["beatGrid"]["beatsSec"]]
            beats[ext] = b
            errs = _beat_errors_ms(b, click["beatTimesSec"])
            hit = sum(1 for e in errs if e <= 5.0)
            fine = bool(errs) and max(errs) <= 5.0 and hit >= len(errs) - 1
            ok = fine and ok
            (_ok if fine else _bad)(
                "click120_30s.%s：%d 拍（真值 %d）· 拍点误差中位 %.2f / 最大 %.2f ms · ≤5ms %d/%d"
                % (ext, len(b), len(click["beatTimesSec"]),
                   float(np.median(errs)) if errs else -1.0, max(errs) if errs else -1.0,
                   hit, len(errs)))
            on = [float(e["t"]) for e in body["onsets"]["events"]]
            oerrs = _beat_errors_ms(on, click["beatTimesSec"])
            ofine = bool(oerrs) and max(oerrs) <= 5.0 and len(on) == len(click["beatTimesSec"])
            ok = ofine and ok
            (_ok if ofine else _bad)(
                "click120_30s.%s：onsets %d 个（真值 %d）· 误差最大 %.2f ms"
                % (ext, len(on), len(click["beatTimesSec"]), max(oerrs) if oerrs else -1.0))
        exts = sorted(beats)
        for i in range(len(exts)):
            for j in range(i + 1, len(exts)):
                left, right = beats[exts[i]], beats[exts[j]]
                n = min(len(left), len(right))
                diff = max((abs(left[k] - right[k]) for k in range(n)), default=-1.0)
                fine = n > 0 and diff <= frame_sec
                ok = fine and ok
                (_ok if fine else _bad)(
                    "容器一致 %s vs %s：%d 拍 · 最大差 %.2f ms（±1 帧 = %.2f ms）"
                    % (exts[i], exts[j], n, diff, frame_sec * 1000.0))

        # 5b-2) 变速斜坡：分段速度图要切出多段、单调上升、每段贴住真值
        ramp = by_name.get("ramp112to128_60s") or {}
        body = analysis.analyze_file(os.path.join(tmp, ramp["containers"]["wav"]), opts, cache=cache)
        segs = body["beatGrid"]["tempoMap"]
        dur = float(ramp.get("durationSec") or body["meta"]["durationSec"])
        bpm_from, bpm_to = float(ramp["bpmFrom"]), float(ramp["bpmTo"])
        rel = []
        for seg in segs:
            mid = 0.5 * (float(seg["start"]) + float(seg["end"]))
            truth_bpm = bpm_from + (bpm_to - bpm_from) * mid / dur
            rel.append(abs(float(seg["bpm"]) / truth_bpm - 1.0))
        mono = all(float(segs[k + 1]["bpm"]) > float(segs[k]["bpm"]) for k in range(len(segs) - 1))
        covers = bool(segs) and abs(float(segs[0]["start"])) < 1e-6 \
            and abs(float(segs[-1]["end"]) - dur) < 0.05
        fine = len(segs) >= 3 and mono and covers and bool(rel) and max(rel) <= 0.03
        ok = fine and ok
        (_ok if fine else _bad)(
            "ramp112to128_60s：tempoMap %d 段 · 单调=%s · 覆盖 0→%.1fs=%s · bpm 相对误差最大 %.2f%% · %.1f→%.1f BPM"
            % (len(segs), mono, dur, covers, (max(rel) * 100.0) if rel else -1.0,
               float(segs[0]["bpm"]) if segs else -1.0, float(segs[-1]["bpm"]) if segs else -1.0))

        # 5b-3) 稀疏脉冲 + 静音：energy.curves 与 energy.perFrame 的峰对齐 <1 帧
        pulse = by_name.get("pulse_silence_10s") or {}
        body = analysis.analyze_file(os.path.join(tmp, pulse["containers"]["wav"]), opts, cache=cache)
        cv = body["energy"]["curves"]
        pf = body["energy"]["perFrame"]
        hs, fs = float(cv["hopSec"]), float(pf["frameSec"])
        deltas, cerr, perr = [], [], []
        for t in pulse["beatTimesSec"]:
            tc = _peak_sec(cv.get("onset"), hs, t)
            tp = _peak_sec(pf.get("onset"), fs, t)
            if tc is None or tp is None:
                continue
            deltas.append(abs(tp - tc))
            cerr.append(abs(tc - t) * 1000.0)
            perr.append(abs(tp - t) * 1000.0)
        fine = len(deltas) >= len(pulse["beatTimesSec"]) - 1 and bool(deltas) and max(deltas) < fs
        ok = fine and ok
        (_ok if fine else _bad)(
            "pulse_silence_10s：%d 个脉冲 · perFrame vs curves 最大差 %.2f ms（<1 帧 = %.2f ms）"
            " · 曲线误差最大 %.2f ms · 逐帧误差最大 %.2f ms"
            % (len(deltas), (max(deltas) * 1000.0) if deltas else -1.0, fs * 1000.0,
               max(cerr) if cerr else -1.0, max(perr) if perr else -1.0))
        cache.close()
        return ok
    finally:
        try:
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)
        except Exception:
            pass


def _http_json(url: str, method: str = "GET", body: dict | None = None,
               timeout: float = 120.0):
    """极简 HTTP 客户端（标准库），返回 (status, json, headers)。"""
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return resp.status, _maybe_json(raw), dict(resp.headers)
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        return exc.code, _maybe_json(raw), dict(exc.headers or {})


def _maybe_json(raw: bytes):
    try:
        return json.loads(raw.decode("utf-8", "replace"))
    except Exception:
        return raw.decode("utf-8", "replace")[:500]


def main() -> int:
    # 数据目录：显式 MT_AUDIO_ROOT 优先；**没有就用系统临时目录**，绝不在仓库 / 应用目录里
    # 写 api-key.txt 与 cache/artifacts（AGENTS.md：数据只落 %APPDATA% 或用户选定目录）。
    env_root = (os.environ.get("MT_AUDIO_ROOT") or "").strip()
    root = os.path.abspath(env_root) if env_root else tempfile.mkdtemp(prefix="audio-check-root-")
    os.makedirs(root, exist_ok=True)
    print("[audio] check start root=%s python=%s" % (root, sys.version.split(" ")[0]))
    print("  [..]   数据目录：%s" % root)
    ok = True
    ok = step_numpy() and ok
    ff_ok, ffmpeg = step_ffmpeg()
    ok = ff_ok and ok
    ok = step_api_key(root) and ok
    if ffmpeg:
        ok = step_silence(root, ffmpeg) and ok
        ok = step_truth(ffmpeg) and ok
    else:
        print("[3/5] 1 秒静音：跳过（没有 ffmpeg）")
        print("[5/5] 合成素材真值：跳过（没有 ffmpeg）")
        ok = False
    print("[汇总]")
    if ok:
        _ok("自检通过：numpy / ffmpeg / api-key / 静音分析（直接 + HTTP 200 + NO_GRID）"
            " / 合成素材真值（延迟标定 · 拍点误差 · 容器一致 · 逐帧对齐 · 变速分段）")
        print("[audio] check done ok=true")
        return 0
    _bad("自检未通过，见上面的 [FAIL] 行")
    print("[audio] check done ok=false")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

