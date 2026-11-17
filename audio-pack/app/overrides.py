"""人工覆盖（overrides）：把调用方给的修正值**作为最后一步**合并进分析结果。

覆盖项（`options.overrides`，全部可省略）：

* `globalVisualOffsetMs` —— 全局音画偏移（毫秒，正 = 所有时间字段后移）。作用在**全部**时间字段上
  （拍点 / 重拍 / 小节 / 乐句 / 速度图 / onset 事件 / 段落 / 切点 / 强调点 / 手写 cue），
  偏移后统一钳到 `[0, duration]` —— 声学时间仍然是真的，画面对齐靠这一条。
* `forcedBpm` —— 强制速度（45-240）。改写 `global.bpm` / `beatPeriodSec`，往 `bpmCandidates`
  插一条 `userHint`，并按新拍长重算 `edit.shotDurationTiers`；**拍网格本身不按它重生成**
  （beatsSec 仍是 attack 拟合结果），这条口径写进 caveat。
* `downbeatShift` —— 重拍相位平移（整数拍）。按新相位从 `beatsSec` 重建 `downbeatsSec`、
  `global.downbeatPhase`、`bars` / `phrases`，并重算 onset 的 `beatInBar` / `step16` / `grid`，
  切点的 `barIndex` / `beatInBar` 同步重定位。
* `sections` —— 段落重命名 / 合并：`{"index": 2, "label": "chorus"}`（或 `{"at": "1:30.000", ...}`
  按时间定位）、`{"merge": [1, 2, 3], "label": "chorus"}`。动过的段落 `method=manual`、`confidence=1`。
* `cues` —— 手写 cue 点：`{"t": 92.4, "name": "big hit", "strength": 0.9}`，也接受
  `"1:32.400 big hit"` 这种一行写法（时间在前、名字在后）。落到 `edit.cues`。

合并完统一校验：时间单调、落在 `[0, duration]`、cue 名去重、`forcedBpm` 落在 45-240。
不合格的条目进 `ignored`（不报错、不中断分析）；与自动值冲突时**一律以人工值为准**，
自动值留在 `conflicts` 里做对照。全部结果写进 `diagnostics.overridesApplied`，并在
`diagnostics.method` / `caveat` 里留一句人话，报告里能直接读到。

全部注释与消息为中文。
"""

from __future__ import annotations

import numpy as np

from . import beats as beats_mod
from . import contract

#: 速度上下限（人工值必须落在区间内，否则不应用）
BPM_MIN = 45.0
BPM_MAX = 240.0
#: 偏移上限（±60 s）：再大基本是把素材对错号了
MAX_OFFSET_MS = 60000.0
#: cue 的默认强度 / 默认名
CUE_DEFAULT_STRENGTH = 0.8
DEFAULT_CUE_NAME = "hit"
#: 时间去重容差（0.05 ms；下发精度是 0.1 ms）
_TIME_EPS = 5e-5


# ---------------------------------------------------------------- 解析（时间 / 数字 / cue 文本）


def _as_float(value):
    """数字（含数字字符串）→ float；不合格回 None。"""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        v = float(value)
        return v if np.isfinite(v) else None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            v = float(text)
        except Exception:
            return None
        return v if np.isfinite(v) else None
    return None


def _as_int(value):
    """整数（含 `1` / `1.0` / `"1"`）→ int；不合格回 None。"""
    v = _as_float(value)
    if v is None or abs(v - round(v)) > 1e-6:
        return None
    return int(round(v))


def _as_time(value):
    """时间 → 秒：接受秒数、`m:ss.mmm`、`h:mm:ss.mmm`（也接受纯数字字符串）。"""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        v = float(value)
        return v if np.isfinite(v) else None
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    # 中文标点与逗号都当小数点（「1:32,4」这种手写习惯）
    text = text.replace("，", ".").replace(",", ".").replace("。", ".")
    if ":" in text:
        parts = [p.strip() for p in text.split(":")]
        if len(parts) > 3 or any(p == "" for p in parts):
            return None
        total = 0.0
        try:
            for part in parts:
                total = total * 60.0 + float(part)
        except Exception:
            return None
        return total if np.isfinite(total) else None
    return _as_float(text)


def _split_cue_text(text: str):
    """`"1:32.400 big hit"` → (92.4, "big hit")；找不到时间回 (None, "")。"""
    tokens = [t for t in str(text or "").split() if t]
    for i, tok in enumerate(tokens):
        t = _as_time(tok)
        if t is not None:
            name = " ".join(tokens[:i] + tokens[i + 1:]).strip()
            return t, name
    return None, ""


def _norm_section_op(item):
    """段落操作规范化：{index?, at?, label?, merge?}；一点信息都没有回 None。"""
    if not isinstance(item, dict):
        return None
    op = {"index": None, "at": None, "label": None, "merge": None}
    if item.get("index") is not None:
        op["index"] = _as_int(item.get("index"))
    for key in ("at", "t", "startSec", "start", "from"):
        if op["at"] is None and item.get(key) is not None:
            op["at"] = _as_time(item.get(key))
    label = item.get("label", item.get("name", item.get("rename")))
    if label is not None:
        text = str(label).strip().lower()
        op["label"] = text or None
    merge = item.get("merge", item.get("mergeInto", item.get("group")))
    if merge is not None:
        seq = merge if isinstance(merge, (list, tuple)) else [merge]
        idxs = [_as_int(v) for v in seq]
        if not idxs or any(v is None for v in idxs):
            return None
        op["merge"] = [int(v) for v in idxs]
    if op["index"] is None and op["at"] is None and op["label"] is None and op["merge"] is None:
        return None
    return op


def _norm_cue(item):
    """cue 规范化：{t, name, strength}；时间解析不出来回 None。"""
    if isinstance(item, dict):
        t = None
        for key in ("t", "at", "time", "sec", "startSec"):
            if item.get(key) is not None:
                t = _as_time(item.get(key))
                break
        name = str(item.get("name", item.get("label", item.get("text", ""))) or "").strip()
        strength = _as_float(item.get("strength", item.get("power")))
    elif isinstance(item, str):
        t, name = _split_cue_text(item)
        strength = None
    else:
        t = _as_time(item)
        name = ""
        strength = None
    if t is None:
        return None
    return {"t": float(t), "name": name, "strength": strength}


def normalize(raw) -> tuple[dict, list]:
    """`options.overrides` → (规范结构, 无法识别的条目)。

    幂等：把 normalize 的结果再喂进来不会丢东西（缓存键与第二次合并都靠这条）。
    """
    out = {"globalVisualOffsetMs": None, "forcedBpm": None, "downbeatShift": None,
           "sections": [], "cues": []}
    ignored: list[str] = []
    if not isinstance(raw, dict):
        if raw not in (None, [], ""):
            ignored.append("overrides 应为对象，收到 %s" % type(raw).__name__)
        return out, ignored
    for key, value in raw.items():
        name = str(key)
        if value is None:
            continue
        if name == "globalVisualOffsetMs":
            v = _as_float(value)
            if v is None or abs(v) > MAX_OFFSET_MS:
                ignored.append("overrides.globalVisualOffsetMs=%s（要求 ±%d ms 内的数字）"
                               % (value, int(MAX_OFFSET_MS)))
            else:
                out["globalVisualOffsetMs"] = round(v, 3)
        elif name in ("forcedBpm", "bpm"):
            v = _as_float(value)
            if v is None:
                ignored.append("overrides.forcedBpm=%s（要求数字）" % (value,))
            else:
                out["forcedBpm"] = round(float(v), 3)   # 45-240 在 apply 里统一校验
        elif name == "downbeatShift":
            v = _as_int(value)
            if v is None:
                ignored.append("overrides.downbeatShift=%s（要求整数拍）" % (value,))
            else:
                out["downbeatShift"] = int(v)
        elif name == "sections":
            items = value if isinstance(value, (list, tuple)) else [value]
            for k, item in enumerate(items):
                op = _norm_section_op(item)
                if op is None:
                    ignored.append("overrides.sections[%d] 无法解析：%s" % (k, item))
                else:
                    out["sections"].append(op)
        elif name == "cues":
            items = value if isinstance(value, (list, tuple)) else [value]
            for k, item in enumerate(items):
                cue = _norm_cue(item)
                if cue is None:
                    ignored.append("overrides.cues[%d] 无法解析：%s" % (k, item))
                else:
                    out["cues"].append(cue)
        else:
            ignored.append("overrides.%s" % name)
    return out, ignored


# ---------------------------------------------------------------- 主入口


def apply(body: dict, options: dict, duration: float, rms_db=None, feats=None) -> tuple[dict, dict]:
    """把人工覆盖合并进响应体（就地），并在 diagnostics 里留痕。

    返回 `(overridesApplied 块, {method/caveat 追加句})`。顺序：
    速度 → 重拍相位 → 段落 → cue → 全局偏移 → 统一校验。
    """
    opts = options if isinstance(options, dict) else {}
    norm, fresh_ignored = normalize(opts.get("overrides"))
    ignored = list(opts.get("overridesIgnored") or []) + [x for x in fresh_ignored if x not in (opts.get("overridesIgnored") or [])]
    duration = max(1e-6, float(duration or 0.0))
    report = {
        "applied": False,
        "count": 0,
        "summary": "没有人工覆盖（options.overrides 为空）",
        "entries": [],
        "globalVisualOffsetMs": 0.0,
        "forcedBpm": None,
        "downbeatShift": None,
        "sections": [],
        "cues": [],
        "conflicts": [],
        "ignored": list(ignored),
        "validation": {"clamped": 0, "dropped": 0, "notes": []},
    }
    entries: list[str] = report["entries"]
    conflicts: list[dict] = report["conflicts"]
    notes: list[str] = report["validation"]["notes"]

    _apply_bpm(body, norm, report, entries, conflicts)
    _apply_downbeat_shift(body, norm, duration, rms_db, feats, report, entries, conflicts, notes)
    _apply_sections(body, norm, report, entries, conflicts)
    _apply_cues(body, norm, duration, report, entries, notes)
    _apply_offset(body, norm, duration, report, entries)

    # 只有真的动过结果才做统一校验：没有覆盖时整份 body 一个字节都不碰
    if entries:
        _validate(body, duration, report)

    report["count"] = len(entries)
    report["applied"] = bool(entries)
    report["summary"] = _summary(report)

    diagnostics = body.setdefault("diagnostics", {})
    diagnostics["overridesApplied"] = report
    params = diagnostics.get("parameters")
    if isinstance(params, dict):
        params["overridesCount"] = int(report["count"])
        raw_in = opts.get("overrides")
        params["overridesKeys"] = sorted(str(k) for k in raw_in) if isinstance(raw_in, dict) else []
        params["overridesIgnored"] = list(report["ignored"])

    tail = {"method": "", "caveat": ""}
    if entries:
        tail["method"] = ("人工覆盖已作为最后一步合并（明细见 diagnostics.overridesApplied）：%s；"
                          "合并后统一校验时间单调与 [0,duration] 落界" % "；".join(entries))
        tail["caveat"] = ("人工覆盖的值优先于自动值（自动值对照见 overridesApplied.conflicts）："
                          "forcedBpm 只改速度描述与镜头时长档位、不重生成拍网格；"
                          "downbeatShift 改了重拍相位但 downbeatMethod 仍是检测器口径；"
                          "edit.cues 是手写 cue（name 唯一、按 t 升序），与自动 accents/cutPoints 并存；"
                          "globalVisualOffsetMs 已推移全部时间字段，与声学时间的差就是它。")
        diagnostics["method"] = _append_sentence(diagnostics.get("method", ""), tail["method"])
        diagnostics["caveat"] = _append_sentence(diagnostics.get("caveat", ""), tail["caveat"])
    return report, tail


def _append_sentence(base, extra) -> str:
    base = str(base or "").strip()
    extra = str(extra or "").strip()
    if not extra:
        return base
    if not base:
        return extra
    if base.endswith(("。", "；", "！", "？", ".", ";")):
        return base + extra
    return base + "；" + extra


# ---------------------------------------------------------------- 1) 强制速度


def _apply_bpm(body, norm, report, entries, conflicts) -> None:
    manual = norm.get("forcedBpm")
    if manual is None:
        return
    if not (BPM_MIN <= float(manual) <= BPM_MAX):
        report["ignored"].append("overrides.forcedBpm=%.3f 超出 %.0f-%.0f，未应用"
                                 % (float(manual), BPM_MIN, BPM_MAX))
        return
    manual = round(float(manual), 3)
    g = body.setdefault("global", {})
    auto = g.get("bpm")
    g["bpm"] = manual
    g["beatPeriodSec"] = round(60.0 / manual, 6)
    cands = g.get("bpmCandidates")
    if isinstance(cands, list):
        cands[:] = [c for c in cands
                    if not (isinstance(c, dict) and str(c.get("source")) == "userHint")]
        cands.insert(0, {"bpm": manual, "source": "userHint", "score": 1.0})
    # 镜头时长档位由 beatPeriodSec×beats 推出，速度改了就得跟着重算，否则自相矛盾
    period = 60.0 / manual
    for item in ((body.get("edit") or {}).get("shotDurationTiers") or []):
        try:
            beats = float(item.get("beats") or 0.0)
        except Exception:
            continue
        if beats <= 0:
            continue
        mid = period * beats
        item["minSec"] = round(max(0.05, mid * 0.9), 3)
        item["maxSec"] = round(max(0.06, mid * 1.1), 3)
    report["forcedBpm"] = manual
    conflicts.append({"kind": "bpm", "target": "global.bpm",
                      "auto": _round_num(auto), "manual": manual,
                      "note": "速度被人工强制；beatsSec 仍是 attack 拟合结果，未按新速度重生成"})
    entries.append("forcedBpm=%.3f（自动 %s）" % (manual, _fmt_num(auto)))


# ---------------------------------------------------------------- 2) 重拍相位平移


def _bar_length(body) -> int:
    ts = (body.get("global") or {}).get("timeSignature") or {}
    try:
        n = int(ts.get("numerator") or 4)
    except Exception:
        n = 4
    return n if n in (2, 3, 4, 5, 6, 7) else 4


def _apply_downbeat_shift(body, norm, duration, rms_db, feats, report, entries, conflicts,
                          notes) -> None:
    shift = norm.get("downbeatShift")
    if not shift:
        return
    bg = body.setdefault("beatGrid", {})
    beats = np.asarray(bg.get("beatsSec") or [], dtype=np.float64)
    if beats.size < 4:
        report["ignored"].append("overrides.downbeatShift=%d 未应用：没有可用拍网格（beatCount=%d）"
                                 % (int(shift), int(beats.size)))
        return
    bar_len = _bar_length(body)
    old_phase = int((body.get("global") or {}).get("downbeatPhase") or 0) % bar_len
    phase = (old_phase + int(shift)) % bar_len
    new_dbs = [round(float(beats[k]), 4) for k in range(int(beats.size))
               if (k - phase) % bar_len == 0 and float(beats[k]) <= duration + 1e-9]
    if len(new_dbs) < 2:
        report["ignored"].append("overrides.downbeatShift=%d 未应用：新相位下只有 %d 个重拍"
                                 % (int(shift), len(new_dbs)))
        return

    body.setdefault("global", {})["downbeatPhase"] = int(phase)
    bg["downbeatsSec"] = new_dbs
    bars, phrases = _rebuild_bars(new_dbs, beats, duration, rms_db, feats, notes)
    bg["bars"] = bars
    bg["phrases"] = phrases

    # onset 的 beatInBar / step16 / grid 都相对小节起点，相位变了必须重算
    events = (body.get("onsets") or {}).get("events") or []
    if events:
        beats_mod.associate_onsets(events, beats, new_dbs, bar_len, phase, duration)
    _relocate_cut_points(body, bars, beats, duration)

    report["downbeatShift"] = {
        "shift": int(shift), "phaseFrom": int(old_phase), "phaseTo": int(phase),
        "barLength": int(bar_len), "downbeats": len(new_dbs),
        "note": "相位由人工平移；downbeatMethod 仍是检测器口径，downbeatsSec/bars 已按新相位重建",
    }
    conflicts.append({"kind": "downbeatPhase", "target": "global.downbeatPhase",
                      "auto": int(old_phase), "manual": int(phase),
                      "note": "重拍相位被人工平移，downbeatsSec/bars/phrases 已重建"})
    entries.append("downbeatShift=%+d（相位 %d→%d，%d 个重拍）"
                   % (int(shift), old_phase, int(phase), len(new_dbs)))


def _rebuild_bars(downbeats, beats, duration, rms_db, feats, notes):
    """按新重拍重建 bars/phrases：有帧特征就用 beats 的同一套实现，否则退化。"""
    if feats is not None and rms_db is not None:
        try:
            return beats_mod.bars_and_phrases(downbeats, beats, duration,
                                              np.asarray(rms_db, dtype=np.float64),
                                              contract.ENERGY_HOP_SEC, feats)
        except Exception as exc:                     # 不让覆盖把整次分析弄挂
            notes.append("小节重建异常（%s），改用 RMS 栅格手工拼接" % type(exc).__name__)
    arr = np.asarray(rms_db if rms_db is not None else [], dtype=np.float64)
    starts = [float(d) for d in downbeats if float(d) < duration - 1e-6]
    bars: list[dict] = []
    for i, s in enumerate(starts):
        e = starts[i + 1] if i + 1 < len(starts) else float(duration)
        if e <= s + 1e-6:
            continue
        sel = beats[(beats >= s - 1e-6) & (beats < e - 1e-6)]
        if sel.size == 0:
            continue
        level = -80.0
        if arr.size:
            k0 = int(max(0, np.floor(s / contract.ENERGY_HOP_SEC)))
            k1 = int(min(arr.size, max(k0 + 1, np.ceil(e / contract.ENERGY_HOP_SEC))))
            seg = arr[k0:k1]
            if seg.size:
                level = round(float(seg.mean()), 2)
        bars.append({"index": len(bars), "startSec": round(s, 4), "endSec": round(e, 4),
                     "downbeatSec": round(s, 4), "beatCountInBar": int(sel.size),
                     "rmsDb": level, "lowDb": level})
    if bars:
        bars[-1]["endSec"] = round(float(duration), 4)
        if len(bars) >= 2 and bars[-1]["beatCountInBar"] == 0:
            bars.pop()
        notes.append("小节低频电平 lowDb 退化为全带（没有帧特征可算低频占比）")
    phrases = []
    for i in range(0, len(bars), 4):
        grp = bars[i:i + 4]
        phrases.append({"index": len(phrases), "startSec": grp[0]["startSec"],
                        "endSec": grp[-1]["endSec"] if i + 4 < len(bars) else round(float(duration), 4),
                        "barStart": grp[0]["index"], "barEnd": grp[-1]["index"]})
    if phrases:
        phrases[-1]["endSec"] = round(float(duration), 4)
    return bars, phrases


def _relocate_cut_points(body, bars, beats, duration) -> None:
    """切点的 barIndex / beatInBar 跟着新小节走。"""
    cps = ((body.get("edit") or {}).get("cutPoints")) or []
    if not cps:
        return
    if not bars:
        for cp in cps:
            cp.pop("barIndex", None)
            cp.pop("beatInBar", None)
        return
    starts = np.asarray([float(b["startSec"]) for b in bars], dtype=np.float64)
    for cp in cps:
        t = float(cp.get("t") or 0.0)
        k = int(np.searchsorted(starts, t, side="right") - 1)
        k = max(0, min(k, len(bars) - 1))
        bar = bars[k]
        cp["barIndex"] = int(k)
        if beats.size:
            j = int(np.searchsorted(beats, t, side="right") - 1)
            j0 = int(np.searchsorted(beats, float(bar["startSec"]) - 1e-6, side="left"))
            span = int(bar.get("beatCountInBar") or 1)
            cp["beatInBar"] = int(max(0, min(j - j0, max(0, span - 1))))
        else:
            cp["beatInBar"] = 0


# ---------------------------------------------------------------- 3) 段落重命名 / 合并


def _index_of(seq, obj):
    for i, item in enumerate(seq):
        if item is obj:
            return i
    return -1


def _locate_section(secs, op):
    """按 index 或 at（时间落在哪一段）定位段落对象。"""
    if op.get("index") is not None:
        k = int(op["index"])
        return secs[k] if 0 <= k < len(secs) else None
    if op.get("at") is not None:
        t = float(op["at"])
        best = None
        for sec in secs:
            s = float(sec.get("startSec") or 0.0)
            e = float(sec.get("endSec") or 0.0)
            if s - 1e-6 <= t < e + 1e-6:
                return sec
            d = min(abs(t - s), abs(t - e))
            if best is None or d < best[0]:
                best = (d, sec)
        return best[1] if best else None
    return None


def _dominant_label(members) -> str:
    """合并段的默认标签：占时长最多的那个成员段（并列取靠前的）。"""
    best_label, best_len = "unknown", -1.0
    for sec in members:
        try:
            span = float(sec.get("endSec") or 0.0) - float(sec.get("startSec") or 0.0)
        except Exception:
            span = 0.0
        if span > best_len + 1e-9:
            best_len = span
            best_label = str(sec.get("label") or "unknown")
    return best_label


def _apply_sections(body, norm, report, entries, conflicts) -> None:
    ops = norm.get("sections") or []
    if not ops:
        return
    secs = body.get("sections")
    if not isinstance(secs, list) or not secs:
        report["ignored"].append("overrides.sections 未应用：本次结果没有段落数组")
        return
    orig = list(secs)
    renames: list[tuple[int, dict, str]] = []
    merges: list[tuple[list[int], str]] = []
    for op in ops:
        label = op.get("label")
        if label is not None and label not in contract.SECTION_LABELS:
            report["ignored"].append("overrides.sections label=%s 不在 9 个枚举内，未应用" % label)
            label = None
        if op.get("merge"):
            idxs = sorted({int(k) for k in op["merge"] if 0 <= int(k) < len(orig)})
            if len(idxs) < 2:
                report["ignored"].append("overrides.sections merge=%s 至少要给两个有效段落索引，未应用"
                                         % (op["merge"],))
                continue
            merges.append((idxs, label or ""))
            continue
        target = _locate_section(orig, op)
        if target is None:
            report["ignored"].append("overrides.sections 找不到目标段落：index=%s at=%s"
                                     % (op.get("index"), op.get("at")))
            continue
        if label is None:
            report["ignored"].append("overrides.sections index=%s 只给了定位、没给 label，未应用"
                                     % (op.get("index"),))
            continue
        renames.append((_index_of(orig, target), target, label))

    for at_index, target, label in renames:
        auto = str(target.get("label"))
        target["label"] = label
        target["confidence"] = 1.0
        target["method"] = "manual"
        target["snappedToDownbeat"] = False
        target["downbeatOffsetMs"] = 0.0
        report["sections"].append({"op": "rename", "index": int(at_index),
                                   "label": label, "auto": auto})
        conflicts.append({"kind": "sectionLabel", "target": "sections[%d]" % int(at_index),
                          "auto": auto, "manual": label,
                          "note": "段落标签人工指定（method=manual、confidence=1）"})
        entries.append("section#%d 标签 %s→%s" % (int(at_index), auto, label))

    for idxs, label in sorted(merges, key=lambda it: it[0][0], reverse=True):
        first, last = orig[idxs[0]], orig[idxs[-1]]
        lo, hi = _index_of(secs, first), _index_of(secs, last)
        if lo < 0 or hi < 0:
            report["ignored"].append("overrides.sections merge=%s 未应用：目标段已被前一步合并掉" % (idxs,))
            continue
        if hi <= lo:
            report["ignored"].append("overrides.sections merge=%s 未应用：区间为空" % (idxs,))
            continue
        members = secs[lo:hi + 1]
        final_label = label or _dominant_label(members)
        if final_label not in contract.SECTION_LABELS:
            final_label = _dominant_label(members)
        auto = [str(m.get("label")) for m in members]
        merged = {
            "index": lo, "label": final_label,
            "startSec": float(members[0]["startSec"]), "endSec": float(members[-1]["endSec"]),
            "confidence": 1.0, "method": "manual",
            "snappedToDownbeat": False, "downbeatOffsetMs": 0.0,
        }
        secs[lo:hi + 1] = [merged]
        report["sections"].append({"op": "merge", "index": int(lo), "label": final_label,
                                   "from": list(idxs), "auto": auto})
        conflicts.append({"kind": "sectionMerge", "target": "sections[%d..%d]" % (lo, hi),
                          "auto": auto, "manual": final_label,
                          "note": "段落按人工要求合并（method=manual、confidence=1）"})
        entries.append("section 合并 %d-%d → %s" % (lo, hi, final_label))

    for i, sec in enumerate(secs):
        sec["index"] = i


# ---------------------------------------------------------------- 4) 手写 cue


def _apply_cues(body, norm, duration, report, entries, notes) -> None:
    cues = norm.get("cues") or []
    if not cues:
        return
    edit = body.setdefault("edit", {})
    bucket = edit.get("cues")
    bucket = bucket if isinstance(bucket, list) else []
    seen = {str(c.get("name")) for c in bucket if isinstance(c, dict)}
    fresh: list[dict] = []
    for k, cue in enumerate(cues):
        try:
            t = float(cue.get("t"))
        except Exception:
            report["validation"]["dropped"] += 1
            notes.append("cue#%d 时间不可用，已丢弃" % k)
            continue
        if t < -1e-6 or t > duration + 1e-6:
            clamped = round(min(max(t, 0.0), duration), 4)
            report["validation"]["clamped"] += 1
            notes.append("cue#%d t=%.4f 超出 [0,%.4f]，已钳到 %.4f" % (k, t, duration, clamped))
            t = clamped
        name = str(cue.get("name") or "").strip() or DEFAULT_CUE_NAME
        if name in seen:
            report["validation"]["dropped"] += 1
            notes.append("cue 名重复「%s」，后一条已丢弃（名字必须唯一）" % name)
            continue
        strength = cue.get("strength")
        strength = CUE_DEFAULT_STRENGTH if strength is None else float(np.clip(float(strength), 0.0, 1.0))
        seen.add(name)
        fresh.append({"t": round(t, 4), "name": name,
                      "strength": round(float(strength), 3), "source": "manual"})
    if not fresh:
        report["cues"] = [_cue_out(c) for c in bucket]
        return
    merged = bucket + fresh
    merged.sort(key=lambda c: float(c.get("t") or 0.0))
    edit["cues"] = merged
    report["cues"] = [_cue_out(c) for c in merged]
    entries.append("手写 cue %d 条" % len(fresh))


def _cue_out(cue) -> dict:
    return {"t": round(float(cue.get("t") or 0.0), 4),
            "name": str(cue.get("name") or DEFAULT_CUE_NAME),
            "strength": round(float(cue.get("strength") or 0.0), 3)}


# ---------------------------------------------------------------- 5) 全局音画偏移


def _apply_offset(body, norm, duration, report, entries) -> None:
    ms = norm.get("globalVisualOffsetMs")
    if not ms:
        return
    moved, clamped = _shift_times(body, float(ms) / 1000.0, duration)
    report["globalVisualOffsetMs"] = round(float(ms), 3)
    report["validation"]["clamped"] += clamped
    extra = "，%d 个越界点已钳到边界" % clamped if clamped else ""
    entries.append("globalVisualOffsetMs=%+.1f ms（推移 %d 个时间点%s）" % (float(ms), moved, extra))


def _shift_times(body, dt: float, duration: float) -> tuple[int, int]:
    """把所有时间字段整体推 dt 秒；返回 (推移点数, 钳制点数)。"""
    moved = 0
    clamped = 0

    def sh(value):
        nonlocal moved, clamped
        try:
            f = float(value)
        except Exception:
            return value
        if not np.isfinite(f):
            return value
        moved += 1
        g = f + dt
        if g < 0.0:
            g, clamped = 0.0, clamped + 1
        elif g > duration:
            g, clamped = duration, clamped + 1
        return round(g, 4)

    bg = body.setdefault("beatGrid", {})
    bg["beatsSec"] = [sh(t) for t in (bg.get("beatsSec") or [])]
    bg["downbeatsSec"] = [sh(t) for t in (bg.get("downbeatsSec") or [])]
    if bg["beatsSec"]:
        bg["firstBeatSec"] = bg["beatsSec"][0]
    for bar in bg.get("bars") or []:
        for key in ("startSec", "endSec", "downbeatSec"):
            if key in bar:
                bar[key] = sh(bar[key])
    for phrase in bg.get("phrases") or []:
        for key in ("startSec", "endSec"):
            if key in phrase:
                phrase[key] = sh(phrase[key])
    for seg in bg.get("tempoMap") or []:
        for key in ("start", "end", "beat0"):
            if key in seg:
                seg[key] = sh(seg[key])
    for beat in bg.get("beats") or []:
        if "t" in beat:
            beat["t"] = sh(beat["t"])
    for ev in (body.get("onsets") or {}).get("events") or []:
        if "t" in ev:
            ev["t"] = sh(ev["t"])
    for sec in body.get("sections") or []:
        for key in ("startSec", "endSec"):
            if key in sec:
                sec[key] = sh(sec[key])
    edit = body.get("edit") or {}
    for cp in edit.get("cutPoints") or []:
        if "t" in cp:
            cp["t"] = sh(cp["t"])
    for ac in edit.get("accents") or []:
        if "t" in ac:
            ac["t"] = sh(ac["t"])
    for cue in edit.get("cues") or []:
        if "t" in cue:
            cue["t"] = sh(cue["t"])
    raw = (body.get("diagnostics") or {}).get("beatsRaw")
    if isinstance(raw, dict):
        for key in ("firstSec", "lastSec"):
            if key in raw:
                raw[key] = sh(raw[key])
        if raw.get("beatsSec"):
            raw["beatsSec"] = [sh(t) for t in raw["beatsSec"]]
    return moved, clamped


# ---------------------------------------------------------------- 6) 合并后统一校验


def _validate(body, duration, report) -> None:
    """时间单调 + 落在 [0,duration] + cue 名去重：不合规就地修，修正量进 report。"""
    notes = report["validation"]["notes"]

    def fix(seq):
        out: list[float] = []
        for value in seq or []:
            try:
                f = float(value)
            except Exception:
                _bump(report, "dropped")
                continue
            if not np.isfinite(f):
                _bump(report, "dropped")
                continue
            if f < 0.0 or f > duration:
                f = min(max(f, 0.0), duration)
                _bump(report, "clamped")
            out.append(round(f, 4))
        out.sort()
        uniq: list[float] = []
        for v in out:
            if uniq and abs(v - uniq[-1]) <= _TIME_EPS:
                _bump(report, "dropped")
                continue
            uniq.append(v)
        return uniq

    bg = body.setdefault("beatGrid", {})
    beats = fix(bg.get("beatsSec"))
    bg["beatsSec"] = beats
    bg["beatCount"] = len(beats)
    bg["firstBeatSec"] = beats[0] if beats else 0.0
    dbs = fix(bg.get("downbeatsSec"))
    dbs = [t for t in dbs if any(abs(t - b) <= 1e-3 for b in beats)]
    bg["downbeatsSec"] = dbs
    if not dbs:
        bg["downbeatMethod"] = "none"
        bg["bars"] = []
        bg["phrases"] = []
    # 小节：首尾相接、有拍、末段收口到 duration
    prev_end = None
    kept = []
    for i, bar in enumerate(bg.get("bars") or []):
        start = round(float(bar.get("startSec") or 0.0), 4)
        end = round(float(bar.get("endSec") or 0.0), 4)
        if prev_end is not None:
            start = prev_end
        if end <= start + 1e-6:
            _bump(report, "dropped")
            continue
        bar["index"] = len(kept)
        bar["startSec"] = start
        bar["endSec"] = end
        bar["downbeatSec"] = start
        prev_end = end
        kept.append(bar)
    if kept:
        kept[-1]["endSec"] = round(duration, 4)
    bg["bars"] = kept
    phrases = []
    for i in range(0, len(kept), 4):
        grp = kept[i:i + 4]
        phrases.append({"index": len(phrases), "startSec": grp[0]["startSec"],
                        "endSec": grp[-1]["endSec"] if i + 4 < len(kept) else round(duration, 4),
                        "barStart": grp[0]["index"], "barEnd": grp[-1]["index"]})
    if phrases:
        phrases[-1]["endSec"] = round(duration, 4)
    bg["phrases"] = phrases
    # 速度图：首段 0 起、段段相接、末段收口
    if isinstance(bg.get("tempoMap"), list) and bg["tempoMap"]:
        prev = 0.0
        tm = []
        for seg in bg["tempoMap"]:
            start = prev
            end = min(max(float(seg.get("end") or 0.0), start + 0.001), duration)
            seg["start"] = round(start, 4)
            seg["end"] = round(end, 4)
            seg["beat0"] = round(min(max(float(seg.get("beat0") or 0.0), 0.0), duration), 4)
            prev = end
            tm.append(seg)
        if tm:
            tm[-1]["end"] = round(duration, 4)
        bg["tempoMap"] = [s for s in tm if float(s["end"]) > float(s["start"])]
    # 事件 / 切点 / 强调点
    events = (body.get("onsets") or {}).get("events") or []
    for ev in events:
        if "t" in ev:
            ev["t"] = round(min(max(float(ev["t"]), 0.0), duration), 4)
    events.sort(key=lambda e: float(e.get("t") or 0.0))
    edit = body.setdefault("edit", {})
    for cp in edit.get("cutPoints") or []:
        cp["t"] = round(min(max(float(cp.get("t") or 0.0), 0.0), duration), 4)
    (edit.get("cutPoints") or []).sort(key=lambda c: float(c["t"]))
    for ac in edit.get("accents") or []:
        ac["t"] = round(min(max(float(ac.get("t") or 0.0), 0.0), duration), 4)
        ac["strength"] = round(float(np.clip(float(ac.get("strength") or 0.0), 0.0, 1.0)), 3)
    (edit.get("accents") or []).sort(key=lambda a: (-float(a["strength"]), float(a["t"])))
    # 段落：无缝无叠、首 0 末 duration、至少一段
    secs = body.get("sections")
    if isinstance(secs, list) and secs:
        keep = []
        for sec in secs:
            start = float(sec.get("startSec") or 0.0)
            end = float(sec.get("endSec") or 0.0)
            if end <= start + 1e-6:
                _bump(report, "dropped")
                notes.append("段落 %s 长度为 0，已丢弃" % sec.get("label"))
                continue
            keep.append(sec)
        if keep:
            keep[0]["startSec"] = 0.0
            for i in range(len(keep) - 1):
                keep[i]["endSec"] = keep[i + 1]["startSec"]
            keep[-1]["endSec"] = round(duration, 4)
            keep = [s for s in keep if float(s["endSec"]) > float(s["startSec"])]
            if keep:
                keep[0]["startSec"] = 0.0
                keep[-1]["endSec"] = round(duration, 4)
                for i, sec in enumerate(keep):
                    sec["index"] = i
                    sec["confidence"] = round(float(np.clip(float(sec.get("confidence") or 0.0), 0.0, 1.0)), 3)
            body["sections"] = keep
    # cue：名唯一、按 t 升序、强度 0-1
    cues = edit.get("cues")
    if isinstance(cues, list) and cues:
        seen = set()
        out = []
        for cue in cues:
            name = str(cue.get("name") or "").strip() or DEFAULT_CUE_NAME
            if name in seen:
                _bump(report, "dropped")
                notes.append("cue 名重复「%s」，已去掉后一条" % name)
                continue
            seen.add(name)
            cue["name"] = name
            cue["t"] = round(min(max(float(cue.get("t") or 0.0), 0.0), duration), 4)
            cue["strength"] = round(float(np.clip(float(cue.get("strength") or 0.0), 0.0, 1.0)), 3)
            out.append(cue)
        out.sort(key=lambda c: float(c["t"]))
        edit["cues"] = out
        report["cues"] = [_cue_out(c) for c in out]
    # 重拍相位总在小节内
    g = body.get("global") or {}
    bar_len = _bar_length(body)
    try:
        g["downbeatPhase"] = int(g.get("downbeatPhase") or 0) % bar_len
    except Exception:
        g["downbeatPhase"] = 0


def _bump(report, key: str) -> None:
    report["validation"][key] = int(report["validation"].get(key) or 0) + 1


# ---------------------------------------------------------------- 报告文本


def _fmt_num(value) -> str:
    try:
        return "%.3f" % float(value)
    except Exception:
        return "无"


def _round_num(value):
    try:
        f = float(value)
    except Exception:
        return None
    return round(f, 3) if np.isfinite(f) else None


def _summary(report) -> str:
    entries = report.get("entries") or []
    if entries:
        head = "人工覆盖已生效 %d 条：%s" % (len(entries), "；".join(entries))
    elif not report.get("ignored") and not report.get("conflicts"):
        return "没有人工覆盖（options.overrides 为空）"
    else:
        head = "人工覆盖没有生效的条目"
    if report.get("ignored"):
        head += "；未应用 %d 条：%s" % (len(report["ignored"]), "；".join(str(x) for x in report["ignored"]))
    if report.get("conflicts"):
        head += "；与自动值冲突 %d 处，已按人工值（自动值见 conflicts）" % len(report["conflicts"])
    v = report.get("validation") or {}
    if v.get("clamped") or v.get("dropped"):
        head += "；统一校验修正：钳 %d 点、去重/丢弃 %d 点" % (int(v.get("clamped") or 0),
                                                     int(v.get("dropped") or 0))
    return head
