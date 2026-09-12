"""GPT-SoVITS engine orchestration: weights, voices, api_v2 subprocess, synthesis proxy."""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parent.parent
ENGINE_DIR = ROOT / "engine"
PRETRAINED_DIR = ENGINE_DIR / "GPT_SoVITS" / "pretrained_models"
VOICES_DIR = ROOT / "voices"
LOG_DIR = ROOT / "logs"
DEFAULT_SOVITS_PORT = 9880

# ---------------- 语种解析（中文里"突然冒出日语"的根治处） ----------------
#
# 中日共用汉字（"情報/未来/会社/大丈夫"…），单看字面**无法**区分。引擎在
# text_lang="auto"（多语种混合）时会把每个分句交给 split_lang + fast_langdetect
# 去"猜"语种；猜成 ja 的分句会走 pyopenjtalk 音读 → 中文句子里蹦出日语。
# 实测（本插件 venv + 引擎自带 lite 模型）21 条纯中文句有 7 条被切出 ja 分句。
#
# 假名（ひらがな/カタカナ）和谚文（한글）是日/韩独有的，只要一段里一个都没有，
# 就不可能是日文/韩文 —— 所以：
#   1) 插件默认不再往引擎发 "auto"，改按字符构成直接定语种（见 guess_lang）；
#   2) 引擎侧再加"共用汉字守卫"补丁，别的调用方发 auto 也不会误判
#   （见 _patch_engine_lang_guard）。
_KANA_RE = re.compile(r"[\u3041-\u3096\u30a1-\u30fa\u31f0-\u31ff\uff66-\uff9d]")
_HANGUL_RE = re.compile(r"[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]")
_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
_LATIN_RE = re.compile(r"[A-Za-z]")

# 引擎（api_v2 / TTS_Config.v2_languages）真正认识的语言码
ENGINE_LANGS = (
    "auto", "auto_yue", "en", "zh", "ja", "yue", "ko",
    "all_zh", "all_ja", "all_yue", "all_ko",
)
_LANG_ALIAS = {
    "auto": "auto", "自动": "auto", "自动判断": "auto", "多语种": "auto", "多语种混合": "auto",
    "zh": "zh", "中文": "zh", "chinese": "zh", "cn": "zh", "zh-cn": "zh", "zh-hans": "zh", "mandarin": "zh",
    "中英": "zh", "中英混合": "zh", "zh-en": "zh", "纯中文": "all_zh",
    "ja": "ja", "日文": "ja", "日语": "ja", "japanese": "ja", "jp": "ja",
    "日英": "ja", "日英混合": "ja", "ja-en": "ja", "纯日文": "all_ja",
    "en": "en", "英文": "en", "英语": "en", "english": "en",
    "ko": "ko", "韩文": "ko", "韩语": "ko", "korean": "ko", "纯韩文": "all_ko",
    "yue": "yue", "粤语": "yue", "cantonese": "yue", "纯粤语": "all_yue",
}


def normalize_lang(value: Any, default: str = "") -> str:
    """把用户/前端写法（中文、English、zh-CN、all_zh…）归一成引擎语言码。"""
    raw = str(value or "").strip()
    if not raw:
        return default
    low = raw.lower()
    if low in ENGINE_LANGS:
        return low
    return _LANG_ALIAS.get(low) or _LANG_ALIAS.get(raw) or default


def guess_lang(text: str, default: str = "") -> str:
    """只依据字符构成定语种：假名=日文、谚文=韩文、无假名的汉字=中文、纯拉丁=英文。

    含少量假名的"夹日"文本返回 auto（多语种混合）——此时引擎守卫补丁会把纯汉字
    分句按中文读、假名分句按日文读，两边都不吃亏。
    """
    if not text:
        return default
    kana = len(_KANA_RE.findall(text))
    hangul = len(_HANGUL_RE.findall(text))
    cjk = len(_CJK_RE.findall(text))
    latin = 1 if _LATIN_RE.search(text) else 0
    if not (kana or hangul or cjk):
        return "en" if latin else default
    if kana and hangul:  # 日韩同现，只能交给切分器
        return "auto"
    ratio = (kana or hangul) / float(kana + hangul + cjk or 1)
    main = ("ja" if kana else "ko") if ratio >= 0.35 else (("auto" if ratio >= 0.12 else "zh"))
    if main == "zh" and not cjk:
        main = "ko" if hangul else "ja"
    if main == "ja":
        return "ja" if latin else "all_ja"
    if main == "ko":
        return "ko" if latin else "all_ko"
    if main == "zh":
        return "zh" if latin else "all_zh"
    return "auto"


def resolve_lang(requested: Any, text: str = "", prompt_text: str = "", voice_lang: Any = "") -> str:
    """显式指定（非 auto）> 正文构成 > 参考文本构成 > 音色语言 > auto。"""
    lang = normalize_lang(requested)
    if lang and lang != "auto":
        return lang
    for hint in (text, prompt_text):
        got = guess_lang(hint)
        if got and got != "auto":
            return got
    return normalize_lang(voice_lang) or lang or guess_lang(text) or "auto"


# ---------------- 语种策略（面板「语种」下拉菜单，默认「仅中文」） ----------------
#
# 下拉菜单选的是**策略**（mode），不是引擎语言码：策略在插件里翻译成引擎认识的
# all_zh / zh / ja / … 再发给 api_v2。这样两件事才能同时成立：
#   1) 面板能一眼看懂（"仅中文"而不是"all_zh"）；
#   2) 默认根本不让 fast_langdetect 去猜语种 —— 猜不动的共用汉字就是本次 bug。
#
# lock=true（默认）时**所有**调用方（面板、画布节点、/v1/audio/speech、脚本）
# 一律按所选语种走，请求里带的 text_lang 被忽略；这就是"仅允许说中文"。
# 想按句混读：把语种改成「自动（按字符构成判定）」并勾掉锁定。

LANG_POLICY_FILE = "language.json"
DEFAULT_LANG_MODE = "zh_only"
DEFAULT_LANG_LOCK = True

LANG_MODES: list[dict[str, str]] = [
    {
        "value": "zh_only",
        "label": "仅中文（默认）",
        "hint": "只说中文：出现日文假名/韩文谚文会直接拒绝合成，绝不会突然冒出日语。",
    },
    {
        "value": "zh_mix",
        "label": "中文 + 英文",
        "hint": "中英混合（zh）：英文单词按英文读，其余按中文读。",
    },
    {
        "value": "auto_char",
        "label": "自动（按字符构成判定）",
        "hint": "有假名=日文、有谚文=韩文、纯汉字=中文、纯拉丁=英文；不去问引擎的语种识别器。",
    },
    {"value": "all_zh", "label": "纯中文 all_zh", "hint": "整段强制中文 G2P，英文也当中文读。"},
    {"value": "ja", "label": "日文", "hint": "整段按日文读（含拉丁字母时日英混合）。"},
    {"value": "en", "label": "英文", "hint": "整段按英文读。"},
    {"value": "ko", "label": "韩文", "hint": "整段按韩文读。"},
    {"value": "yue", "label": "粤语", "hint": "整段按粤语读。"},
    {
        "value": "engine_auto",
        "label": "引擎多语种混合（不推荐）",
        "hint": "每个分句交给 fast_langdetect 猜语种；实测约 1/4 纯中文句会被猜成日语。",
    },
]
_LANG_MODE_VALUES = {m["value"] for m in LANG_MODES}

# 老写法 / 引擎码 / 中文别名 → 策略值（面板与脚本都能直接传）
_MODE_ALIAS = {
    "zh_only": "zh_only", "仅中文": "zh_only", "只说中文": "zh_only", "中文only": "zh_only",
    "zh_mix": "zh_mix", "中英": "zh_mix", "中英混合": "zh_mix", "zh-en": "zh_mix",
    "auto_char": "auto_char", "自动": "auto_char", "自动判定": "auto_char", "按字符": "auto_char",
    "all_zh": "all_zh", "纯中文": "all_zh", "chinese": "all_zh", "cn": "all_zh", "zh-cn": "all_zh",
    "zh": "zh_mix", "中文": "zh_mix", "mandarin": "zh_mix",
    "ja": "ja", "all_ja": "ja", "日文": "ja", "日语": "ja", "japanese": "ja", "jp": "ja",
    "en": "en", "英文": "en", "英语": "en", "english": "en",
    "ko": "ko", "all_ko": "ko", "韩文": "ko", "韩语": "ko", "korean": "ko",
    "yue": "yue", "all_yue": "yue", "auto_yue": "yue", "粤语": "yue", "cantonese": "yue",
    "auto": "engine_auto", "多语种": "engine_auto", "多语种混合": "engine_auto", "auto_mix": "engine_auto",
}


def normalize_lang_mode(value: Any, default: str = "") -> str:
    """把面板选项值 / 引擎码 / 中文写法归一成策略值；认不出来返回 default。"""
    raw = str(value or "").strip()
    if not raw:
        return default
    if raw in _LANG_MODE_VALUES:
        return raw
    low = raw.lower()
    if low in _LANG_MODE_VALUES:
        return low
    got = _MODE_ALIAS.get(low) or _MODE_ALIAS.get(raw)
    if got:
        return got
    return normalize_lang(raw) or default


def mode_to_engine(mode: str, text: str) -> tuple[str, str]:
    """策略值 → 引擎语言码。返回 (语言码, 拒绝原因)；语言码为空表示不许合成。"""
    m = mode or DEFAULT_LANG_MODE
    has_latin = bool(_LATIN_RE.search(text or ""))
    if m == "zh_only":
        if _KANA_RE.search(text or "") or _HANGUL_RE.search(text or ""):
            return "", "当前语种为「仅中文」：文本里含日文假名或韩文谚文，已拒绝合成。请删掉外语字符，或把语种改成「自动（按字符构成判定）」。"
        return ("zh" if has_latin else "all_zh"), ""
    if m == "zh_mix":
        return "zh", ""
    if m == "all_zh":
        return "all_zh", ""
    if m == "engine_auto":
        return "auto", ""
    if m == "ja":
        return ("ja" if has_latin else "all_ja"), ""
    if m == "ko":
        return ("ko" if has_latin else "all_ko"), ""
    if m == "yue":
        return ("yue" if has_latin else "all_yue"), ""
    if m == "en":
        return "en", ""
    return guess_lang(text, default="all_zh"), ""


_policy_cache: dict[str, Any] = {}
_policy_stamp: tuple[int, int] = (0, 0)
# 独立于 _lock：_lock 会被 start_engine 长时间持有，避免任何嵌套死锁
_policy_lock = threading.Lock()


def lang_policy_path() -> Path:
    return ROOT / LANG_POLICY_FILE


def _truthy(v: Any, default: bool) -> bool:
    if v is None:
        return default
    if isinstance(v, bool):
        return v
    s = str(v).strip().lower()
    if s in ("1", "true", "yes", "y", "on", "lock", "强制", "锁定"):
        return True
    if s in ("0", "false", "no", "n", "off", "unlocked", "不锁定"):
        return False
    return default


def load_lang_policy() -> dict[str, Any]:
    """读 language.json（mtime 缓存）。文件不在时退到环境变量 / 内置默认。"""
    global _policy_cache, _policy_stamp
    with _policy_lock:
        path = lang_policy_path()
        stamp: tuple[int, int] = (0, 0)
        try:
            st = path.stat()
            stamp = (st.st_mtime_ns, st.st_size)
        except Exception:
            pass
        if _policy_cache and _policy_stamp == stamp:
            return dict(_policy_cache)
        data: dict[str, Any] = {}
        if stamp != (0, 0):
            try:
                got = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(got, dict):
                    data = got
            except Exception as e:  # noqa: BLE001
                log(f"warn: 读取 {LANG_POLICY_FILE} 失败：{e}")
        raw_mode = data.get("mode")
        if raw_mode in (None, ""):
            raw_mode = os.environ.get("TTS_LANG_MODE") or DEFAULT_LANG_MODE
        mode = normalize_lang_mode(raw_mode, "") or DEFAULT_LANG_MODE
        raw_lock = data.get("lock")
        if raw_lock is None:
            raw_lock = os.environ.get("TTS_LANG_LOCK")
        lock = _truthy(raw_lock, DEFAULT_LANG_LOCK)
        _policy_cache = {"mode": mode, "lock": lock}
        _policy_stamp = stamp
        return dict(_policy_cache)


def save_lang_policy(mode: Any = "", lock: Any = None) -> dict[str, Any]:
    """写 language.json；面板（主进程直接写文件）和 HTTP 都走这里。"""
    cur = load_lang_policy()
    nxt_mode = normalize_lang_mode(mode, "") if mode not in (None, "") else cur["mode"]
    if not nxt_mode or nxt_mode not in _LANG_MODE_VALUES:
        return {"ok": False, "error": "unknown_lang_mode", "mode": str(mode or ""), "modes": LANG_MODES}
    nxt_lock = _truthy(lock, cur["lock"])
    path = lang_policy_path()
    payload = {"mode": nxt_mode, "lock": bool(nxt_lock)}
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(path)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}
    global _policy_cache, _policy_stamp
    with _policy_lock:
        _policy_cache = payload
        try:
            _policy_stamp = (path.stat().st_mtime_ns, path.stat().st_size)
        except Exception:
            _policy_stamp = (0, 0)
    log(f"语种策略：{lang_mode_label(payload['mode'])} · {'锁定（其他调用方不可覆盖）' if payload['lock'] else '不锁定'}")
    return {"ok": True, **payload}


def lang_mode_label(mode: str) -> str:
    for m in LANG_MODES:
        if m["value"] == mode:
            return str(m["label"])
    return mode or ""


def lang_mode_hint(mode: str) -> str:
    for m in LANG_MODES:
        if m["value"] == mode:
            return str(m.get("hint") or "")
    return ""


# ---------------- 采样步数 sample_steps（面板上那个「采样数」） ----------------
#
# 引擎 api_v2（9880，我们连的就是它）的默认值是 **32**：api_v2.py:175
# `sample_steps: int = 32`，它自己不校验取值，直接塞给 TTS。老接口 api.py:854 才校验
# `if sample_steps not in [4, 8, 16, 32, 64, 128]: sample_steps = 32`。
# 官方 webui 的取值也印证了家族差异：inference_webui.py:306
# `choices=[4, 8, 16, 32, 64, 128] if model_version == "v3" else [4, 8, 16, 32]`，
# 标签直接写着「采样步数(仅对V3/4生效)」。
#
# 但要说清楚：**只有走声码器（CFM）的 s2 —— 也就是 v3 / v4 —— 才真的消费它**。
# v1 / v2 / v2Pro 用的是 SynthesizerTrn.decode(...)，官方实现压根不往下传 sample_steps。
# 实测（当前训练的 aoi＝SoVITS v2、同一句、同一 seed）32 / 64 / 128 三次合成的
# **字节完全一致** —— 所以想靠加采样数治电流音是走不通的，真凶在语料带宽
# （见 train._convert_to_wav：以前转换环节写死 -ar 16000）。
# 选项照旧加上：以后换 v3 / v4 底模训练，它就是个有效旋钮（128 最细也最慢）。
SAMPLE_STEPS_CHOICES = (4, 8, 16, 32, 64, 128)
DEFAULT_SAMPLE_STEPS = 32
INFER_FILE = ROOT / "infer.json"

# 走声码器（CFM）的 s2 家族 —— 只有这些才真的消费 sample_steps。
# 本引擎副本 TTS.py:515/538-554：use_vocoder = version in {"v3","v4"}；
# v1/v2/v2Pro/v2ProPlus 都走 SynthesizerTrn（VITS）那条 decode(...)，参数不下发。
# （新版上游还有 v5 也带声码器，但这个引擎 update_version 只认 v1..v4/Pro。）
_VOCODER_MODELS = {"v3", "v4"}
# 目录名 -> 模型家族（引擎权重目录就是这套命名）
_DIR_MODEL_HINT = {
    "SoVITS_weights": "v1",
    "SoVITS_weights_v2": "v2",
    "SoVITS_weights_v2Pro": "v2Pro",
    "SoVITS_weights_v2ProPlus": "v2ProPlus",
    "SoVITS_weights_v3": "v3",
    "SoVITS_weights_v4": "v4",
    "SoVITS_weights_v5": "v5",
}

_infer_cache: dict[str, Any] | None = None
_infer_stamp: tuple[int, int] = (0, 0)
_infer_lock = threading.Lock()


def normalize_sample_steps(value: Any, default: int | None = DEFAULT_SAMPLE_STEPS) -> int | None:
    """把任意写法收敛到引擎允许的那几个采样步数；空/0 返回 default。"""
    try:
        v = int(float(str(value).strip()))
    except Exception:  # noqa: BLE001
        return default
    if v <= 0:
        return default
    if v in SAMPLE_STEPS_CHOICES:
        return v
    # 取最接近的允许值（48 -> 64，100 -> 128，2 -> 4）；正好卡在中间时向上取
    return min(SAMPLE_STEPS_CHOICES, key=lambda c: (abs(c - v), -c))


def load_infer_settings() -> dict[str, Any]:
    """读 infer.json（采样步数等服务端默认，面板改一次，画布节点/OpenAI 接口都跟着走）。"""
    global _infer_cache, _infer_stamp
    with _infer_lock:
        stamp: tuple[int, int] = (0, 0)
        try:
            st = INFER_FILE.stat()
            stamp = (st.st_mtime_ns, st.st_size)
        except Exception:
            pass
        if _infer_cache and _infer_stamp == stamp:
            return dict(_infer_cache)
        data: dict[str, Any] = {}
        if stamp != (0, 0):
            try:
                got = json.loads(INFER_FILE.read_text(encoding="utf-8"))
                if isinstance(got, dict):
                    data = got
            except Exception as e:  # noqa: BLE001
                log(f"warn: 读取 {INFER_FILE.name} 失败：{e}")
        steps = normalize_sample_steps(data.get("sampleSteps") or os.environ.get("TTS_SAMPLE_STEPS"),
                                       DEFAULT_SAMPLE_STEPS)
        _infer_cache = {"sampleSteps": int(steps or DEFAULT_SAMPLE_STEPS)}
        _infer_stamp = stamp
        return dict(_infer_cache)


def save_infer_settings(sample_steps: Any = None) -> dict[str, Any]:
    """写 infer.json；面板下拉框和 HTTP 都走这里。

    取值：None / 空 = 保持原值；能解析成数字的都归一到最近的允许档（48→64）；
    完全解析不了的（"abc"、"0x10"）直接报错，不静默改掉用户设过的值。
    """
    cur = load_infer_settings()
    raw_blank = sample_steps is None or (isinstance(sample_steps, str) and not sample_steps.strip())
    if raw_blank:
        steps = cur["sampleSteps"]
    else:
        steps = normalize_sample_steps(sample_steps, None)
        if steps is None:
            return {"ok": False, "error": "bad_sample_steps", "value": str(sample_steps)[:40],
                    "choices": list(SAMPLE_STEPS_CHOICES)}
    payload = {"sampleSteps": int(steps)}
    try:
        INFER_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = INFER_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(INFER_FILE)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}
    global _infer_cache, _infer_stamp
    with _infer_lock:
        _infer_cache = payload
        try:
            _infer_stamp = (INFER_FILE.stat().st_mtime_ns, INFER_FILE.stat().st_size)
        except Exception:
            _infer_stamp = (0, 0)
    log(f"采样步数默认值：{steps}（v2Pro/v3/v4/v5 音色才会真的用它）")
    return {"ok": True, **payload}


def sovits_model_family(voice: dict | None) -> str:
    """从音色的 s2 权重路径猜模型家族（v1/v2/v2Pro/v3/v4/v5）。判不出返回 ""。"""
    p = str(((voice or {}).get("weights") or {}).get("sovits") or "")
    if not p:
        return ""
    parts = Path(p).parts
    for seg in reversed(parts):
        if seg in _DIR_MODEL_HINT:
            return _DIR_MODEL_HINT[seg]
        low = str(seg).lower()
        for d, fam in _DIR_MODEL_HINT.items():
            if low == d.lower():
                return fam
    low = p.lower()
    for tag, fam in (("v2proplus", "v2ProPlus"), ("v2pro", "v2Pro"), ("sv5", "v5"),
                     ("v5", "v5"), ("gv4", "v4"), ("v4", "v4"), ("gv3", "v3"), ("v3", "v3")):
        if tag in low:
            return fam
    if "sovit" in low:
        return "v2"
    return ""


def sample_steps_apply(voice: dict | None) -> bool:
    """这次合成里 sample_steps 到底起不起作用（只有 v3 / v4 的声码器路径接这个参数）。"""
    fam = sovits_model_family(voice)
    if not fam:
        return True  # 不知道是什么底模：宁可当作生效，别乱下结论
    return fam.lower() in _VOCODER_MODELS



def decide_text_lang(requested: Any = "", text: str = "", prompt_text: str = "", voice_lang: Any = "") -> tuple[str, str]:
    """本次合成实际发给引擎的 text_lang。返回 (语言码, 拒绝原因)。"""
    pol = load_lang_policy()
    req = normalize_lang(requested)
    if req and not pol.get("lock"):
        # 显式指定且没锁定 → 听调用方的。auto 也照给：此时引擎侧的「共用汉字守卫」
        # 补丁（_patch_engine_cjk_guard）仍在兜底，纯汉字分句不会被误判成日/韩。
        return req, ""
    return mode_to_engine(str(pol.get("mode") or DEFAULT_LANG_MODE), text)


def lang_policy_status() -> dict[str, Any]:
    pol = load_lang_policy()
    mode = str(pol.get("mode") or DEFAULT_LANG_MODE)
    return {
        "mode": mode,
        "label": lang_mode_label(mode),
        "hint": lang_mode_hint(mode),
        "lock": bool(pol.get("lock")),
        "defaultMode": DEFAULT_LANG_MODE,
        "modes": LANG_MODES,
        "policyFile": str(lang_policy_path()),
    }


_log_fn: Callable[[str], None] | None = None
_lock = threading.Lock()


def set_logger(fn: Callable[[str], None]) -> None:
    global _log_fn
    _log_fn = fn


def log(msg: str) -> None:
    line = f"[tts] {msg}"
    if _log_fn:
        _log_fn(line)
    else:
        print(line, flush=True)


def engine_ready() -> bool:
    """True when the GPT-SoVITS clone + pretrained weights are on disk."""
    if not (ENGINE_DIR / "api_v2.py").is_file():
        return False
    gpt = _default_gpt_weights()
    sovits = _default_sovits_weights()
    return bool(gpt and gpt.is_file() and sovits and sovits.is_file())


def _default_gpt_weights() -> Path | None:
    candidates = [
        PRETRAINED_DIR / "s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt",
        PRETRAINED_DIR / "s1bert25hz-2kh-longer-epoch=68e-step=50232.ckpt",
        PRETRAINED_DIR / "GPT_weights_v2.ckpt",
        PRETRAINED_DIR / "GPT_weights_v1.ckpt",
    ]
    for p in candidates:
        if p.is_file():
            return p
    return None


def _default_sovits_weights() -> Path | None:
    candidates = [
        PRETRAINED_DIR / "s2G488k.pth",
        PRETRAINED_DIR / "s2G233k.pth",
        PRETRAINED_DIR / "SoVITS_weights_v2.pth",
        PRETRAINED_DIR / "SoVITS_weights_v1.pth",
    ]
    for p in candidates:
        if p.is_file():
            return p
    return None


# ---------------- voices ----------------

def list_voices() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if not VOICES_DIR.is_dir():
        return out
    for sub in sorted(VOICES_DIR.iterdir()):
        if not sub.is_dir():
            continue
        wav = sub / "ref.wav"
        if not wav.is_file():
            continue
        txt = sub / "ref.txt"
        lang = sub / "ref.lang"
        prompt = ""
        langv = "auto"
        try:
            if txt.is_file():
                prompt = txt.read_text(encoding="utf-8").strip()
        except Exception:
            pass
        try:
            if lang.is_file():
                langv = normalize_lang(lang.read_text(encoding="utf-8"), "auto")
        except Exception:
            pass
        if langv == "auto" and prompt:
            # 老音色（ref.lang=auto）自愈一次：按参考文本字符定语种并写回，免得
            # 每次合成都让识别器去猜参考文本语种（猜错=整条音频带外语腔）
            guess = guess_lang(prompt, default="")
            if guess and guess != "auto":
                try:
                    lang.write_text(guess, encoding="utf-8")
                    log(f"voice {sub.name}: ref.lang auto → {guess}（按参考文本判定）")
                except Exception:  # noqa: BLE001
                    pass
                langv = guess
        weights = None
        trained = False
        try:
            if (sub / "weights.json").is_file():
                weights = json.loads((sub / "weights.json").read_text(encoding="utf-8"))
                trained = bool(weights and weights.get("gpt") and weights.get("sovits"))
        except Exception:
            pass
        out.append(
            {
                "id": sub.name,
                "name": sub.name,
                "refAudio": str(wav),
                "promptText": prompt,
                "lang": langv,
                "sizeBytes": wav.stat().st_size if wav.exists() else 0,
                "trained": trained,
                "weights": weights,
            }
        )
    return out


def get_voice(voice_id: str) -> dict[str, Any] | None:
    vid = str(voice_id or "").strip()
    if not vid:
        return None
    for v in list_voices():
        if v["id"] == vid or v["name"] == vid:
            return v
    return None


# ---------------- 训练中中间模型（live 音色） ----------------
#
# 「训练过程中能不能直接试听中间模型」= 把训练每轮导出的权重当成一个**虚拟音色**
# 喂给测试合成。id 形如：
#     live:Deepseek          跟着训练走，永远是盘上最新一轮（默认，用户要的"会更新"）
#     live:Deepseek@g12_s5   固定 GPT 第 12 轮 + SoVITS 第 5 轮，用来横向比较
# 发现逻辑与参考音频选择都在 train.live_model() 里（它掌握 data/ 与权重目录）。
# 注册音色优先：训完注册的 voices/<slug> 走普通分支，不会被这里拦截。

def _train_mod() -> Any:
    try:
        from app import train as _train

        return _train
    except Exception:  # 允许 tts.py 被单独 import（无包上下文时）
        try:
            import train as _train  # type: ignore[no-redef]

            return _train
        except Exception:  # noqa: BLE001
            return None


def live_voice(voice_id: Any) -> dict[str, Any] | None:
    """live:<项目> → 中间模型音色（含 usable=False + reason 的情况）。"""
    tr = _train_mod()
    if tr is None:
        return None
    try:
        return tr.live_voice(voice_id)
    except Exception as e:  # noqa: BLE001
        log(f"live voice resolve failed for {voice_id}: {e}")
        return None


def resolve_voice(voice_id: Any) -> dict[str, Any] | None:
    """先查注册音色，再查 live 中间模型音色。"""
    vid = str(voice_id or "").strip()
    if not vid:
        return None
    v = get_voice(vid)
    if v:
        return v
    if vid.lower().startswith("live:"):
        return live_voice(vid)
    return None


def list_live_voices() -> list[dict[str, Any]]:
    """面板「测试合成」的中间模型列表：正在训练、或有权重且比已注册音色更新的项目。"""
    tr = _train_mod()
    if tr is None:
        return []
    try:
        return tr.list_live_models()
    except Exception as e:  # noqa: BLE001
        log(f"list live voices failed: {e}")
        return []


def add_voice(voice_id: str, wav_bytes: bytes, prompt_text: str = "", lang: str = "auto") -> dict[str, Any]:
    vid = str(voice_id or "").strip().replace("\\", "_").replace("/", "_")
    if not vid:
        raise ValueError("voice_id_required")
    if not wav_bytes:
        raise ValueError("wav_required")
    d = VOICES_DIR / vid
    d.mkdir(parents=True, exist_ok=True)
    (d / "ref.wav").write_bytes(wav_bytes)
    (d / "ref.txt").write_text(str(prompt_text or ""), encoding="utf-8")
    # 参考音频的语种决定整段合成的"口音基调"，绝不能留 auto 让识别器去猜：
    # 参考文本是纯汉字时被猜成 ja，整条音频就会带日语腔。按字符构成定下来。
    langv = normalize_lang(lang)
    if not langv or langv == "auto":
        langv = guess_lang(str(prompt_text or ""), default="")
        if not langv or langv == "auto":
            try:  # 参考文本为空/纯符号 → 用音色名里带的语言标记（如 aoi-ja），否则保守按中文
                langv = normalize_lang(vid.rsplit("-", 1)[-1]) or "zh"
            except Exception:  # noqa: BLE001
                langv = "zh"
        log(f"voice {vid}: ref.lang auto → {langv}（按参考文本字符判定）")
    (d / "ref.lang").write_text(langv, encoding="utf-8")
    log(f"voice added: {vid}")
    return get_voice(vid)  # type: ignore[return-value]


def remove_voice(voice_id: str) -> bool:
    vid = str(voice_id or "").strip()
    if not vid:
        return False
    d = VOICES_DIR / vid
    if d.is_dir():
        import shutil

        shutil.rmtree(d, ignore_errors=True)
        log(f"voice removed: {vid}")
        return True
    return False


# ---------------- engine subprocess ----------------

_engine_proc: subprocess.Popen | None = None
_engine_port = DEFAULT_SOVITS_PORT


def set_voice_lang(voice_id: str, lang: str) -> dict[str, Any]:
    """改音色语种（影响 prompt_lang，也就是整条音频的口音基调）。"""
    vid = str(voice_id or "").strip()
    d = VOICES_DIR / vid
    if not vid or not d.is_dir():
        return {"ok": False, "error": "voice_not_found"}
    lv = normalize_lang(lang)
    if not lv or lv == "auto":
        try:
            lv = guess_lang((d / "ref.txt").read_text(encoding="utf-8"), default="")
        except Exception:  # noqa: BLE001
            lv = ""
    if not lv:
        return {"ok": False, "error": "lang_required"}
    try:
        (d / "ref.lang").write_text(lv, encoding="utf-8")
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}
    log(f"voice {vid}: lang → {lv}")
    return {"ok": True, "lang": lv}


def language_status() -> dict[str, Any]:
    """给界面/健康检查看：语种策略与引擎守卫补丁是否已生效。"""
    fp = ENGINE_DIR / "GPT_SoVITS" / "TTS_infer_pack" / "TextPreprocessor.py"
    guard = False
    try:
        guard = "MTNode GPT-TTS" in fp.read_text(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass
    return {
        "cjkLangGuard": bool(guard),
        "engineLangs": list(ENGINE_LANGS),
        "defaultPolicy": "面板「语种」下拉菜单（默认：仅中文，且锁定不可被调用方覆盖）",
        "policy": lang_policy_status(),
    }


def apply_language_guard() -> dict[str, Any]:
    """打（或补装）引擎的共用汉字守卫补丁；新写入时重启引擎使其生效。"""
    applied = _patch_engine_cjk_guard()
    restarted = False
    if applied and engine_up():
        stop_engine()
        restarted = True
        log("CJK 守卫补丁已写入，引擎已停止；下次合成自动以新代码启动")
    return {"ok": True, "applied": applied, "engineRestarted": restarted}


def _is_alive(pid: int | None) -> bool:
    if not pid or pid <= 0:
        return False
    if sys.platform == "win32":
        try:
            out = subprocess.check_output(
                ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
                stderr=subprocess.DEVNULL,
                text=True,
                errors="ignore",
            )
            return str(pid) in out and "No tasks" not in out
        except Exception:
            return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


# 给本机回环地址（127.0.0.1 的推理引擎 / 自己的管理口）发请求用的 opener：
# **必须绕开系统代理**。开了 Clash / v2rayN / 公司代理的用户机器上，urllib 会照
# 注册表把 http://127.0.0.1:9880 也交给 127.0.0.1:7890 之类的代理端口，代理不认
# 这个目标就回一个空 body 的 503 —— 表现成"引擎没起来 / 合成失败"，而且是否复发
# 完全取决于代理软件在不在跑，极难排查。下载外网模型仍然用 urllib.request.urlopen
# （那种请求正是需要代理的）。
_LOCAL_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
os.environ.setdefault("NO_PROXY", "127.0.0.1,localhost")
os.environ.setdefault("no_proxy", "127.0.0.1,localhost")


def _open(req: "urllib.request.Request", timeout: float = 120.0):
    return _LOCAL_OPENER.open(req, timeout=timeout)


def _http_ok(url: str, timeout: float = 3.0) -> bool:
    """True when the HTTP server answers at all. This engine's api_v2 has NO
    root '/' route (GET / -> 404), so a 2xx-only check would report the engine
    as never-ready; any HTTP response means uvicorn is up and TTS initialized."""
    import urllib.error

    try:
        with _open(urllib.request.Request(url), timeout=timeout) as resp:
            return True
    except urllib.error.HTTPError:
        return True
    except Exception:
        return False


def engine_http_base(port: int | None = None) -> str:
    return f"http://127.0.0.1:{int(port or _engine_port)}"


def engine_up(port: int | None = None) -> bool:
    return _http_ok(engine_http_base(port) + "/", timeout=2.0)


def _kill_pid(pid: int) -> None:
    if not pid:
        return
    if sys.platform == "win32":
        subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    else:
        try:
            os.kill(pid, 15)
        except OSError:
            pass


def start_engine(port: int | None = None) -> dict[str, Any]:
    global _engine_proc, _engine_port
    with _lock:
        port = int(port or _engine_port or DEFAULT_SOVITS_PORT)
        if engine_up(port):
            _engine_port = port
            return {"ok": True, "reused": True, "port": port}
        if not engine_ready():
            return {"ok": False, "error": "engine_not_ready"}
        _patch_engine_langdetect()
        _patch_engine_cjk_guard()
        _ensure_nltk_data()
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        log_file = LOG_DIR / f"sovits-{port}.log"
        flags = 0
        if sys.platform == "win32":
            flags = subprocess.CREATE_NEW_PROCESS_GROUP | getattr(
                subprocess, "CREATE_NO_WINDOW", 0x08000000
            )
        log_fp = open(log_file, "ab")
        cfg = _ensure_default_tts_config()
        args = [
            sys.executable,
            "api_v2.py",
            "-c",
            str(cfg),
            "-a",
            "127.0.0.1",
            "-p",
            str(port),
        ]
        log(f"starting api_v2 on :{port} cfg={cfg.name}")
        proc_env = os.environ.copy()
        proc_env["NLTK_DATA"] = str(ROOT / "nltk_data")
        # api_v2 子进程与训练子进程（train._run_step）一样必须拿到
        # shims(→gradio stub) → .pylibs(torch/torchaudio/numpy<2 等) → GPT_SoVITS → engine
        # 的 PYTHONPATH。后端进程只把 .pylibs 注入自己的 sys.path，子进程继承不到；
        # 缺了它 api_v2 一启动就 ModuleNotFoundError: torchaudio（引擎起不来=合成卡死）。
        proc_env["TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD"] = "1"
        gpt_root = str(ENGINE_DIR / "GPT_SoVITS")
        proc_env["PYTHONPATH"] = os.pathsep.join(
            [
                str(ROOT / "shims"),
                str(ROOT / ".pylibs"),
                gpt_root,
                str(ENGINE_DIR),
                proc_env.get("PYTHONPATH", ""),
            ]
        ).strip(os.pathsep)
        _engine_proc = subprocess.Popen(
            args,
            cwd=str(ENGINE_DIR),
            env=proc_env,
            stdout=log_fp,
            stderr=subprocess.STDOUT,
            creationflags=flags,
        )
        _engine_port = port

    def _wait() -> None:
        deadline = time.time() + 300
        while time.time() < deadline:
            if not _is_alive(_engine_proc.pid if _engine_proc else None):
                log("engine process exited early; see " + str(log_file))
                return
            if engine_up(port):
                log(f"engine ready :{port}")
                return
            time.sleep(3)
        log(f"engine start timeout :{port}")

    threading.Thread(target=_wait, daemon=True).start()
    return {"ok": True, "port": port, "pid": _engine_proc.pid}


def stop_engine() -> dict[str, Any]:
    global _engine_proc, _current_weights
    _current_weights = None
    with _lock:
        proc = _engine_proc
        _engine_proc = None
    if proc and proc.pid:
        _kill_pid(proc.pid)
    # kill port listener as fallback
    if sys.platform == "win32":
        try:
            out = subprocess.check_output(
                [
                    "powershell.exe",
                    "-NoProfile",
                    "-Command",
                    f"(Get-NetTCPConnection -LocalPort {_engine_port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)",
                ],
                stderr=subprocess.DEVNULL,
                text=True,
                errors="ignore",
                timeout=10,
            )
            pid = int(str(out or "").strip())
            if pid:
                _kill_pid(pid)
        except Exception:
            pass
    return {"ok": True}


def _post_json(url: str, payload: dict[str, Any], timeout: float = 120.0) -> dict[str, Any]:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with _open(req, timeout=timeout) as resp:
        raw = resp.read()
        try:
            return {"ok": True, "json": json.loads(raw.decode("utf-8"))}
        except Exception:
            return {"ok": True, "raw": raw}


def _get_json(url: str, params: dict[str, Any], timeout: float = 120.0) -> dict[str, Any]:
    """GET with query params — this engine's api_v2 weight/refer-audio
    endpoints are GET (?weights_path= / ?refer_audio_path=), NOT POST bodies."""
    import urllib.parse

    qs = urllib.parse.urlencode({k: str(v) for k, v in params.items() if v is not None})
    sep = "&" if "?" in url else "?"
    req = urllib.request.Request(url + sep + qs)
    try:
        with _open(req, timeout=timeout) as resp:
            raw = resp.read()
            try:
                return {"ok": True, "json": json.loads(raw.decode("utf-8"))}
            except Exception:
                return {"ok": True, "raw": raw}
    except urllib.error.HTTPError as e:
        # api_v2 的 400 响应体里才是真原因（{"message":..., "Exception":...}）。
        # 不把它读出来，面板只能显示 "HTTP Error 400: Bad Request"——试听中间
        # 模型时"权重正在被替换 / 显存不够 / 文件名猜错"全靠这句话定位。
        detail = ""
        try:
            body = e.read().decode("utf-8", "replace")
            try:
                j = json.loads(body)
                detail = str(j.get("Exception") or j.get("message") or body)[:300]
            except Exception:
                detail = body[:300]
        except Exception:  # noqa: BLE001
            detail = str(e)
        return {"ok": False, "status": int(e.code), "error": detail or str(e)}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


def _ensure_default_tts_config() -> Path:
    """This engine's api_v2 accepts ONLY -c/-a/-p (no -gpt_weights CLI), and the
    stock GPT_SoVITS/configs/tts_infer.yaml points at gsv-v2final-pretrained
    weights that are not bundled — so the engine would crash at startup. Write a
    plugin-managed default config (the bundled v1 pair s1bert25hz-2kh + s2G488k)
    into the writable train_cfg dir and point api_v2 at it. Trained voices then
    hot-swap weights via /set_gpt_weights + /set_sovits_weights."""
    cfg = ENGINE_DIR / "train_cfg" / "tts_infer_default.yaml"
    try:
        if cfg.is_file() and "MTNode GPT-TTS default" in cfg.read_text(encoding="utf-8"):
            return cfg
        body = (
            "# MTNode GPT-TTS default (api_v2 -c)\n"
            "custom:\n"
            "  bert_base_path: GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large\n"
            "  cnhuhbert_base_path: GPT_SoVITS/pretrained_models/chinese-hubert-base\n"
            "  device: cuda\n"
            "  is_half: true\n"
            "  t2s_weights_path: GPT_SoVITS/pretrained_models/s1bert25hz-2kh-longer-epoch=68e-step=50232.ckpt\n"
            "  version: v1\n"
            "  vits_weights_path: GPT_SoVITS/pretrained_models/s2G488k.pth\n"
        )
        cfg.parent.mkdir(parents=True, exist_ok=True)
        cfg.write_text(body, encoding="utf-8")
        log(f"default tts config written: {cfg}")
    except Exception as e:  # noqa: BLE001
        log(f"warn: cannot write default tts config: {e}")
    return cfg


def _write_patch(fp: Path, content: str, msg: str) -> None:
    tmp = fp.with_suffix(".py.tmp")
    try:
        tmp.write_text(content, encoding="utf-8")
        for i in range(6):
            try:
                os.replace(str(tmp), str(fp))
                break
            except OSError:
                time.sleep(0.3 * (i + 1))
        log(msg)
    except Exception as e:  # noqa: BLE001
        log(f"warn: cannot write {fp.name}: {e}")


def _patch_engine_langdetect() -> None:
    """split_lang forces fast_langdetect.detect(..., model='full') which
    downloads the ~126MB lid.176.bin into GPT_SoVITS/pretrained_models/
    fast_langdetect; when that dir is missing, every /tts dies with
    'fast-langdetect: Cache directory not found'. Patch both call sites to use
    the bundled lite model (lid.176.ftz ships inside .pylibs) — offline, no
    cache dir, no download. Idempotent."""
    fp = ROOT / ".pylibs" / "split_lang" / "detect_lang" / "detector.py"
    if fp.is_file():
        try:
            src = fp.read_text(encoding="utf-8")
        except Exception as e:  # noqa: BLE001
            src = ""
            log(f"warn: cannot read {fp.name}: {e}")
        if src and "MTNode GPT-TTS" not in src:
            src2 = src.replace('model="full"', 'model="lite"')
            if src2 != src:
                src2 = src2.replace(
                    "from ..model import LangSectionType",
                    "from ..model import LangSectionType  # MTNode GPT-TTS (lite langdetect)",
                    1,
                )
                _write_patch(fp, src2, "split_lang detector.py patched (lite langdetect)")

    fp = ENGINE_DIR / "GPT_SoVITS" / "text" / "LangSegmenter" / "langsegmenter.py"
    if fp.is_file():
        try:
            src = fp.read_text(encoding="utf-8")
        except Exception as e:  # noqa: BLE001
            src = ""
            log(f"warn: cannot read {fp.name}: {e}")
        old = (
            'fast_langdetect.infer._default_detector = fast_langdetect.infer.LangDetector('
            'fast_langdetect.infer.LangDetectConfig(cache_dir=Path(__file__).parent.parent.parent / '
            '"pretrained_models" / "fast_langdetect"))'
        )
        new = (
            'fast_langdetect.infer._default_detector = fast_langdetect.infer.LangDetector('
            'fast_langdetect.infer.LangDetectConfig(cache_dir=Path(__file__).parent.parent.parent / '
            '"pretrained_models" / "fast_langdetect", model="lite"))  ##### patched by MTNode GPT-TTS'
        )
        if src and "MTNode GPT-TTS" not in src and old in src:
            _write_patch(fp, src.replace(old, new), "langsegmenter.py patched (lite langdetect)")


# 要写进引擎 TextPreprocessor.py 的守卫代码（纯 stdlib，不依赖 torch）
_CJK_GUARD_HELPER = r'''##### MTNode GPT-TTS (CJK lang guard) #####
# 中日共用汉字（情報/未来/会社/大丈夫…）无法靠字面区分；fast_langdetect(lite)
# 经常把纯汉字分句判成 ja，于是"中文读着读着突然冒出日语"。假名/谚文是日/韩的
# 独有证据——一段里一个都没有，就不该按日韩读，退回按整段字符构成算出的主导语种。
_MT_KANA_RE = re.compile(r"[\u3041-\u3096\u30a1-\u30fa\u31f0-\u31ff\uff66-\uff9d]")
_MT_HANGUL_RE = re.compile(r"[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]")
_MT_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")


def mtnode_lang_guard(lang: str, seg: str, whole: str = "") -> str:
    """分句被判 ja/ko 却没有任何假名/谚文时，改判为主导语种（一般是中文）。"""
    try:
        if lang not in ("ja", "ko"):
            return lang
        if _MT_KANA_RE.search(seg) or _MT_HANGUL_RE.search(seg):
            return lang  # 确有假名/谚文，识别器没说错
        kana = len(_MT_KANA_RE.findall(whole or ""))
        hangul = len(_MT_HANGUL_RE.findall(whole or ""))
        cjk = len(_MT_CJK_RE.findall(whole or ""))
        total = kana + hangul + cjk
        if total and (kana + hangul) / float(total) >= 0.35:
            return "ja" if kana >= hangul else "ko"  # 整段以日/韩为主，汉字按日韩读
        return "zh"
    except Exception:
        return lang

##### end MTNode GPT-TTS patch #####


'''

_CJK_GUARD_BLOCKS = (
    (
        '            elif language == "auto":\n'
        "                for tmp in LangSegmenter.getTexts(text):\n"
        '                    langlist.append(tmp["lang"])\n',
        '            elif language == "auto":\n'
        "                for tmp in LangSegmenter.getTexts(text):\n"
        '                    tmp["lang"] = mtnode_lang_guard(tmp["lang"], tmp["text"], text)\n'
        '                    langlist.append(tmp["lang"])\n',
    ),
    (
        '            elif language == "auto_yue":\n'
        "                for tmp in LangSegmenter.getTexts(text):\n"
        '                    if tmp["lang"] == "zh":\n',
        '            elif language == "auto_yue":\n'
        "                for tmp in LangSegmenter.getTexts(text):\n"
        '                    tmp["lang"] = mtnode_lang_guard(tmp["lang"], tmp["text"], text)\n'
        '                    if tmp["lang"] == "zh":\n',
    ),
)


def _patch_engine_cjk_guard() -> bool:
    """兜底补丁：就算调用方（WebUI、旧前端、自建脚本）仍发 text_lang=auto，
    纯汉字分句也不会被读成日语。幂等；返回 True = 本次新写入（需重启引擎生效）。"""
    fp = ENGINE_DIR / "GPT_SoVITS" / "TTS_infer_pack" / "TextPreprocessor.py"
    if not fp.is_file():
        return False
    try:
        src = fp.read_text(encoding="utf-8")
    except Exception as e:  # noqa: BLE001
        log(f"warn: cannot read {fp.name}: {e}")
        return False
    if "MTNode GPT-TTS" in src:
        return False
    out = src
    for old, new in _CJK_GUARD_BLOCKS:
        if old in out:
            out = out.replace(old, new, 1)
    if out == src or "mtnode_lang_guard" not in out:
        log("warn: TextPreprocessor.py 结构不认识（官方改版？）跳过 CJK 守卫补丁")
        return False
    out = out.replace("class TextPreprocessor:", _CJK_GUARD_HELPER + "class TextPreprocessor:", 1)
    try:
        import ast

        ast.parse(out)  # 只查语法，绝不在后端进程里 import torch
    except SyntaxError as e:
        log(f"warn: CJK 守卫补丁语法自检失败，放弃写入: {e}")
        return False
    _write_patch(fp, out, "TextPreprocessor.py patched (CJK lang guard)")
    return True


def ensure_engine_patches() -> dict[str, Any]:
    """应用（并必要时重启引擎以生效）所有引擎侧补丁。后端启动时调用一次。"""
    applied: list[str] = []
    try:
        _patch_engine_langdetect()
    except Exception as e:  # noqa: BLE001
        log(f"warn: langdetect patch: {e}")
    try:
        if _patch_engine_cjk_guard():
            applied.append("cjk_lang_guard")
    except Exception as e:  # noqa: BLE001
        log(f"warn: CJK guard patch: {e}")
    if applied and engine_up():
        # 引擎已经把旧模块加载进内存，补丁要重启后才生效。后端刚起来时没有
        # 在途请求，这里停一次最安全；下一次合成会自动重新拉起引擎。
        log("引擎补丁已更新，重启推理引擎以生效")
        try:
            stop_engine()
        except Exception as e:  # noqa: BLE001
            log(f"warn: restart engine failed: {e}")
    return {"ok": True, "applied": applied}


def _ensure_nltk_data() -> None:
    """Ensure NLTK averaged_perceptron_tagger_eng for English g2p during
    synthesis (api_v2's English phonemization). Same data train.py downloads;
    the api_v2 subprocess finds it via NLTK_DATA. Non-fatal."""
    import shutil as _shutil
    import zipfile as _zipfile

    data_dir = ROOT / "nltk_data"
    tag_dir = data_dir / "taggers" / "averaged_perceptron_tagger_eng"
    try:
        if tag_dir.is_dir() and any(tag_dir.iterdir()):
            return
        data_dir.mkdir(parents=True, exist_ok=True)
        misplaced = data_dir / "averaged_perceptron_tagger_eng"
        if misplaced.is_dir() and any(misplaced.iterdir()):
            (data_dir / "taggers").mkdir(parents=True, exist_ok=True)
            _shutil.move(str(misplaced), str(tag_dir))
            log("NLTK tagger data migrated to taggers/")
            return
    except Exception as e:  # noqa: BLE001
        log(f"warn: NLTK data check failed: {e}")
        return
    zname = "averaged_perceptron_tagger_eng.zip"
    urls = [
        "https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages/taggers/" + zname,
        "https://ghfast.top/https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages/taggers/" + zname,
        "https://gh-proxy.com/https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages/taggers/" + zname,
    ]
    tmp_zip = data_dir / zname
    for url in urls:
        try:
            log("downloading NLTK tagger data (english g2p)…")
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=45) as r, open(tmp_zip, "wb") as f:
                _shutil.copyfileobj(r, f)
            (data_dir / "taggers").mkdir(parents=True, exist_ok=True)
            with _zipfile.ZipFile(tmp_zip) as zf:
                zf.extractall(data_dir / "taggers")
            try:
                tmp_zip.unlink()
            except Exception:  # noqa: BLE001
                pass
            if tag_dir.is_dir() and any(tag_dir.iterdir()):
                log("NLTK tagger data ready: " + str(tag_dir))
                return
        except Exception as e:  # noqa: BLE001
            log(f"warn: NLTK tagger download failed ({url}): {e}")
            try:
                tmp_zip.unlink()
            except Exception:  # noqa: BLE001
                pass
    log("warn: NLTK tagger data unavailable — 英文文本的 g2p 可能失败")


def _set_ref_audio(voice: dict[str, Any], port: int) -> dict[str, Any]:
    base = engine_http_base(port)
    for _ in range(40):
        if engine_up(port):
            break
        time.sleep(1.5)
    if not engine_up(port):
        return {"ok": False, "error": "engine_not_ready"}
    try:
        r = _get_json(
            base + "/set_refer_audio",
            {"refer_audio_path": voice["refAudio"]},
        )
        if r.get("ok"):
            log(f"ref audio set: {voice['id']} <- {Path(str(voice['refAudio'])).name}")
            return {"ok": True}
        return {"ok": False, "error": "set_refer_audio_failed：%s" % (r.get("error") or r)}
    except Exception as e:
        return {"ok": False, "error": "set_refer_audio_failed: %s" % e}


# cache of currently loaded weights (pid, gpt, sovits) to avoid redundant reloads
_current_weights: tuple[int | None, str | None, str | None] | None = None


def _set_voice_weights(weights: dict[str, Any], port: int) -> dict[str, Any]:
    """Switch the running engine to trained weights (api_v2 /set_gpt_weights + /set_sovits_weights)."""
    global _current_weights
    gpt = str(weights.get("gpt") or "")
    sovits = str(weights.get("sovits") or "")
    if not gpt or not sovits:
        return {"ok": False, "error": "weights_incomplete"}
    # 训练中间模型每轮都在变，读到的瞬间文件也可能已被替换 —— 先确认在盘上
    for p, tag in ((gpt, "GPT"), (sovits, "SoVITS")):
        try:
            if not Path(p).is_file():
                return {"ok": False, "error": "%s 权重文件不存在：%s" % (tag, Path(p).name)}
        except Exception:  # noqa: BLE001
            pass
    pid = _engine_proc.pid if _engine_proc else None
    if _current_weights and _current_weights[0] == pid and _current_weights[1] == gpt and _current_weights[2] == sovits:
        return {"ok": True}
    base = engine_http_base(port)
    for _ in range(40):
        if engine_up(port):
            break
        time.sleep(1.5)
    if not engine_up(port):
        return {"ok": False, "error": "engine_not_ready"}
    t0 = time.time()
    try:
        r1 = _get_json(base + "/set_gpt_weights", {"weights_path": gpt}, timeout=300.0)
        if not r1.get("ok"):
            return {"ok": False, "error": "加载 GPT 权重失败（%s）：%s" % (Path(gpt).name, r1.get("error") or "set_gpt_weights_failed")}
        r2 = _get_json(base + "/set_sovits_weights", {"weights_path": sovits}, timeout=300.0)
        if not r2.get("ok"):
            return {"ok": False, "error": "加载 SoVITS 权重失败（%s）：%s" % (Path(sovits).name, r2.get("error") or "set_sovits_weights_failed")}
    except Exception as e:
        hint = ""
        s = str(e).lower()
        if "out of memory" in s or "cublas" in s or "cudnn" in s:
            hint = "（显存不足：训练正占用 GPU，等这一轮练完或先停训练再试听）"
        return {"ok": False, "error": "切换权重异常：%s%s" % (e, hint)}
    _current_weights = (pid, gpt, sovits)
    dt = round(time.time() - t0, 1)
    log("voice weights loaded (%ss): gpt=%s sovits=%s" % (dt, Path(gpt).name, Path(sovits).name))
    return {"ok": True, "loaded": {"gpt": Path(gpt).name, "sovits": Path(sovits).name, "sec": dt}}


# ---------------- 输出容器（media_type）：引擎只认 wav / raw / ogg / aac ----------------
#
# api_v2 的 /tts 对 media_type 做**白名单**校验，不在 ["wav","raw","ogg","aac"] 里的
# 直接 400（body 形如 {"message":"media_type: mp3 is not supported"}）。画布语音节点的
# 「输出格式」有 mp3、OpenAI 兼容接口的 response_format 还接受 flac/opus/mpeg…，
# 照原样转发就是每次必 400 —— 而且旧代码把这个 400 的响应体丢掉，最终只剩一句
# "HTTP Error 400: Bad Request"，用户无从下手（本次 bug 的根因）。
# 这里统一收敛：引擎自己会的（wav/ogg/aac）直接要；mp3 / flac 先要 wav 再由本机
# ffmpeg 转码。转码不可用时给一句能照着做的错误，而不是猜。
ENGINE_MEDIA_TYPES = ("wav", "raw", "ogg", "aac")
_TRANSCODE_MEDIA_TYPES = ("mp3", "flac")
_MEDIA_ALIAS = {
    "wave": "wav",
    "mpeg": "mp3", "mp4": "mp3", "mpga": "mp3",
    "oga": "ogg", "opus": "ogg",
    "m4a": "aac",
}
_MEDIA_CONTENT_TYPE = {
    "wav": "audio/wav",
    "ogg": "audio/ogg",
    "aac": "audio/aac",
    "raw": "audio/raw",
    "mp3": "audio/mpeg",
    "flac": "audio/flac",
}


def normalize_media_type(value: Any) -> str:
    """调用方写法（mp3 / mpeg / .flac / auto / 空）→ 规范容器名。"""
    raw = str(value or "").strip().lower().lstrip(".")
    if not raw or raw == "auto":
        return "wav"
    return _MEDIA_ALIAS.get(raw, raw)


def engine_media_type(media_type: str) -> str:
    """真正发给 api_v2 的 media_type：必须落在它的白名单里，否则引擎 400。"""
    mt = normalize_media_type(media_type)
    return mt if mt in ENGINE_MEDIA_TYPES else "wav"


def content_type_of(media_type: str) -> str:
    return _MEDIA_CONTENT_TYPE.get(normalize_media_type(media_type), "audio/wav")


def _ffmpeg_exe() -> str:
    """ffmpeg 位置：PATH > 引擎目录（GPT-SoVITS 的 install 脚本就把它下载在这）> 安装根。"""
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    for cand in (ENGINE_DIR / "ffmpeg.exe", ENGINE_DIR / "ffmpeg", ROOT / "ffmpeg.exe"):
        try:
            if cand.is_file():
                return str(cand)
        except Exception:  # noqa: BLE001
            pass
    return ""


def _transcode_audio(data: bytes, fmt: str) -> dict[str, Any]:
    """把引擎出来的 wav 字节转成 mp3 / flac（stdin → stdout，不落临时文件）。"""
    fmt = normalize_media_type(fmt)
    exe = _ffmpeg_exe()
    if not exe:
        return {
            "ok": False,
            "error": "missing_ffmpeg: 本机没有找到 ffmpeg，无法把输出转成 %s（请改用 wav 输出，或在插件里重新安装后端）" % fmt,
            "errorCode": "missing_ffmpeg",
            "mediaType": fmt,
        }
    cmd = [exe, "-hide_banner", "-loglevel", "error", "-f", "wav", "-i", "pipe:0"]
    if fmt == "mp3":
        cmd += ["-codec:a", "libmp3lame", "-b:a", "192k", "-f", "mp3", "-"]
    elif fmt == "flac":
        cmd += ["-codec:a", "flac", "-f", "flac", "-"]
    else:
        return {"ok": False, "error": "unsupported_media_type: %s" % fmt, "errorCode": "unsupported_media_type"}
    try:
        proc = subprocess.run(cmd, input=data, capture_output=True, timeout=300)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": "transcode_failed: %s" % e, "errorCode": "transcode_failed"}
    if proc.returncode != 0 or not proc.stdout:
        detail = (proc.stderr or b"").decode("utf-8", "replace").strip()[:300]
        log(f"transcode {fmt} failed rc={proc.returncode}: {detail}")
        return {
            "ok": False,
            "error": "transcode_failed: %s" % (detail or ("ffmpeg rc=%s" % proc.returncode)),
            "errorCode": "transcode_failed",
        }
    log(f"transcoded wav -> {fmt}（{len(data)} -> {len(proc.stdout)} bytes）")
    return {"ok": True, "audio": proc.stdout, "contentType": content_type_of(fmt), "mediaType": fmt}


def _engine_http_error(e: "urllib.error.HTTPError", media_type: str) -> dict[str, Any]:
    """把引擎的 4xx/5xx 响应体读出来 —— 真原因就在 {"message":…,"Exception":…} 里。"""
    body = ""
    try:
        body = e.read().decode("utf-8", "replace")
    except Exception:  # noqa: BLE001
        body = ""
    detail = body.strip()
    try:
        j = json.loads(body)
        detail = str(j.get("Exception") or j.get("message") or body).strip() or body.strip()
    except Exception:  # noqa: BLE001
        pass
    detail = detail[:400] or str(e)
    log(f"engine http {e.code} (media_type={media_type}): {detail}")
    return {
        "ok": False,
        "error": detail,
        "errorCode": "engine_http_%s" % e.code,
        "engineStatus": int(getattr(e, "code", 0) or 0),
        "mediaType": media_type,
    }


def synthesize(
    text: str,
    voice_id: str = "",
    port: int | None = None,
    speed: float = 1.0,
    media_type: str = "wav",
    **extra: Any,
) -> dict[str, Any]:
    port = int(port or _engine_port or DEFAULT_SOVITS_PORT)
    text = str(text or "").strip()
    if not text:
        return {"ok": False, "error": "text_required"}
    voice = None
    vid = str(voice_id or "").strip()
    if vid:
        voice = resolve_voice(vid)
        if not voice:
            return {"ok": False, "error": "voice_not_found", "voice": vid}
        if voice.get("kind") == "live" and not voice.get("usable"):
            # 训练中间模型还不能出声：如实说清楚在等哪一步，别让人以为是坏了
            return {
                "ok": False,
                "error": "训练中间模型还不能试听：%s" % (voice.get("reason") or "权重未就绪"),
                "errorCode": "live_model_unready",
                "voice": vid,
            }
    else:
        voices = list_voices()
        if not voices:
            return {"ok": False, "error": "no_voice"}
        voice = voices[0]
    # 语种：面板「语种」下拉菜单选中的策略说了算（默认 zh_only＝仅中文）。
    # lock=true 时调用方带的 text_lang / ?lang= / X-Text-Lang 全部忽略；
    # 仅中文模式下出现假名/谚文直接拒绝合成 —— 宁可不发声音，也不发日语。
    # 这步放在启动引擎之前：被拒绝的请求秒回，不用等模型加载。
    voice_lang = str((voice or {}).get("lang") or "")
    prompt_text = str((voice or {}).get("promptText") or "")
    req_lang = extra.get("text_lang") or extra.get("lang")
    text_lang, denied = decide_text_lang(req_lang, text, prompt_text, voice_lang)
    if denied:
        log(f"拒绝合成（{lang_mode_label(load_lang_policy()['mode'])}）：{denied}")
        return {"ok": False, "error": denied, "errorCode": "lang_denied"}
    if not text_lang:
        text_lang = resolve_lang(req_lang, text, prompt_text, voice_lang)
    if not engine_up(port):
        r = start_engine(port)
        if not r.get("ok"):
            return {"ok": False, "error": r.get("error", "engine_down")}
    wr: dict[str, Any] = {}
    if voice:
        if voice.get("weights"):
            wr = _set_voice_weights(voice["weights"], port)
            if not wr.get("ok"):
                return wr
        sr = _set_ref_audio(voice, port)
        if not sr.get("ok"):
            return sr
    prompt_lang = normalize_lang(extra.get("prompt_lang") or voice_lang)
    if not prompt_lang or prompt_lang == "auto":
        # 参考音频的语种只能靠参考文本判定；判错会让整条音频带外语腔
        prompt_lang = guess_lang(prompt_text, default="") or "auto"
    pol = load_lang_policy()
    # 采样步数：调用方给的优先，没给就用服务端默认（面板下拉框写进 infer.json）。
    # 注意 v1/v2 的 VITS 推理路径不接这个参数（见 SAMPLE_STEPS_CHOICES 上面的说明），
    # 我们照样发给引擎（无害），但会在日志/响应头里如实说清"这次它不起作用"。
    steps_val = normalize_sample_steps(extra.get("sample_steps"), None) or load_infer_settings()["sampleSteps"]
    steps_apply = sample_steps_apply(voice)
    log(f"sample_steps={steps_val}"
        + ("" if steps_apply else
           f"（当前 s2 是 {sovits_model_family(voice) or '未知版本'}，官方 VITS 解码路径不消费该参数，"
           "只有 v3 / v4 生效）")
        )
    log(f"lang: text_lang={text_lang}（策略={pol['mode']} lock={pol['lock']}）prompt_lang={prompt_lang}")
    # 输出容器：调用方要的（mp3 / flac / opus…）归一后决定「向引擎要什么 + 是否转码」，
    # 绝不把引擎白名单以外的值转发过去（那是必 400）。认不出的容器**在调引擎之前**就拒掉
    # —— 否则要先把模型加载起来才等回一个 400，白等几分钟。
    want_mt = normalize_media_type(media_type)
    if want_mt not in ENGINE_MEDIA_TYPES and want_mt not in _TRANSCODE_MEDIA_TYPES:
        return {"ok": False, "error": "unsupported_media_type: %s" % want_mt, "errorCode": "unsupported_media_type"}
    engine_mt = engine_media_type(want_mt)
    need_transcode = want_mt in _TRANSCODE_MEDIA_TYPES
    payload: dict[str, Any] = {
        "text": text,
        "text_lang": text_lang,
        "ref_audio_path": voice["refAudio"] if voice else "",
        "prompt_text": prompt_text,
        "prompt_lang": prompt_lang,
        "top_k": int(extra.get("top_k", 5)),
        "top_p": float(extra.get("top_p", 1.0)),
        "temperature": float(extra.get("temperature", 1.0)),
        "text_split_method": str(extra.get("text_split_method", "cut5")),
        "batch_size": int(extra.get("batch_size", 1)),
        "speed_factor": float(speed),
        "streaming_mode": False,
        "media_type": engine_mt,
        "seed": int(extra.get("seed", -1)),
        "sample_steps": int(steps_val),
    }
    try:
        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            engine_http_base(port) + "/tts",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with _open(req, timeout=600) as resp:
                audio = resp.read()
                ctype = resp.headers.get("content-type") or content_type_of(engine_mt)
        except urllib.error.HTTPError as he:
            # 引擎 400/500 的响应体里才是真原因（media_type 不支持 / tts failed + 异常），
            # 旧代码直接 str(e) 只剩 "HTTP Error 400: Bad Request"。
            return _engine_http_error(he, engine_mt)
        if not audio:
            return {"ok": False, "error": "empty_audio"}
        if need_transcode:
            tr = _transcode_audio(audio, want_mt)
            if not tr.get("ok"):
                return tr
            audio = tr["audio"]
            ctype = tr["contentType"]
        elif want_mt in _MEDIA_CONTENT_TYPE:
            ctype = content_type_of(want_mt)
        # 把"这次到底用的是哪份权重"回带给面板/接口：试听中间模型时，
        # 用户必须能确认听到的是第几轮，而不是事后猜。
        wgt = voice.get("weights") or {}
        used_g = Path(str(wgt.get("gpt") or "-")).name
        used_s = Path(str(wgt.get("sovits") or "-")).name
        live = None
        if voice.get("kind") == "live":
            live = {
                "project": voice.get("project"),
                "label": voice.get("label"),
                "pinned": bool(voice.get("pinned")),
                "gptEpoch": (voice.get("gpt") or {}).get("epoch"),
                "sovitsEpoch": (voice.get("sovits") or {}).get("epoch"),
                "ref": (voice.get("ref") or {}).get("file"),
                "updatedAt": voice.get("updatedAt"),
            }
        return {
            "ok": True,
            "audio": audio,
            "contentType": ctype,
            "mediaType": want_mt,
            "voice": voice["id"] if voice else "",
            "textLang": text_lang,
            "promptLang": prompt_lang,
            "langMode": pol["mode"],
            "langLock": bool(pol["lock"]),
            "weights": "%s + %s" % (used_g, used_s) if wgt.get("gpt") else "",
            "switchSec": ((wr or {}).get("loaded") or {}).get("sec"),
            "live": live,
            # 采样步数：发了多少 / 这次起不起作用 / s2 是哪个版本家族
            "sampleSteps": int(steps_val),
            "sampleStepsApply": bool(steps_apply),
            "sovitsFamily": sovits_model_family(voice),
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}
