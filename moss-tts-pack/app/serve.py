#!/usr/bin/env python3
"""MOSS-TTS-Nano 本地工作进程（MTNode 内置 TTS 后端）。

一个常驻进程：模型只在第一次 speak 时加载（约 1~3 秒），之后每次合成直接复用。
协议：stdin / stdout 各一行一条 JSON（UTF-8，flush 即时），stderr 只写日志。

入（宿主 → 本进程）
  {"cmd":"ping"}
  {"cmd":"speak","id":"<reqId>","text":"...","promptAudio":"<wav>","outDir":"<dir>","maxChars":42}
  {"cmd":"cancel","id":"<reqId>"}
  {"cmd":"shutdown"}

出（本进程 → 宿主）
  {"type":"ready","pid":1234}
  {"type":"device","provider":"cpu|cuda","requested":"auto|cpu|cuda","reason":"..."}
  {"type":"loaded","ms":1234}
  {"type":"chunk","id":"..","index":0,"path":"...","text":"...","ms":900}
  {"type":"done","id":"..","chunks":3,"ms":2400}
  {"type":"cancelled","id":".."}
  {"type":"error","id":"..","code":"synth_failed","message":"..."}
  {"type":"pong"}
  {"type":"bye"}

为什么要按句切：MOSS-TTS-Nano 是自回归流式模型，一次调用只出整句的音频；宿主把句子
一发一发播出去，用户听到的第一个字就不用等整段（实测一句 20 字约 0.6~1.2 秒）。

推理设备：--provider auto|cpu|cuda。auto 先按 CUDA 建 OnnxTtsRuntime 并校验 session 的
providers 真的含 CUDAExecutionProvider；DLL 缺失 / 算子不支持 / 显存不足等任何异常都
捕获后重建 CPU runtime（cuda 模式预热失败同样回落），保证进程永远能出声。
"""

from __future__ import annotations

import json
import logging
import os
import queue
import re
import sys
import threading
import time
import traceback
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(APP_DIR))

SESSION_END = set("。！？!?；;")
CLAUSE_END = set("，,、：:—…")
# 英文缩写 / 称呼后面的点不是句末（否则 "Mr. Smith" 会被切成两句）
ABBREVIATIONS = {
    "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc", "e.g", "i.e",
    "eg", "ie", "inc", "ltd", "co", "no", "fig", "al", "approx", "dept", "est", "min", "max",
}
_CJK_RE = re.compile(r"[\u3400-\u9fff]")
_TRAILING_JUNK = "，,、：:；;—-… \t"
OUT = sys.stdout
LOCK = threading.Lock()
PROVIDERS = ("auto", "cpu", "cuda")
CUDA_PROVIDER_ID = "CUDAExecutionProvider"


def normalize_provider(raw: str) -> str:
    value = str(raw or "").strip().lower()
    return value if value in PROVIDERS else "auto"


def emit(obj: dict) -> None:
    with LOCK:
        OUT.write(json.dumps(obj, ensure_ascii=False) + "\n")
        OUT.flush()


def log(line: str) -> None:
    try:
        sys.stderr.write("[moss-tts] " + str(line) + "\n")
        sys.stderr.flush()
    except Exception:
        pass


def _contains_cjk(text: str) -> bool:
    return bool(_CJK_RE.search(str(text or "")))


def _is_mostly_latin(text: str) -> bool:
    letters = [c for c in str(text or "") if c.isalpha()]
    if not letters:
        return False
    ascii_letters = sum(1 for c in letters if c.isascii())
    return ascii_letters >= len(letters) * 0.8


def _ensure_terminal(piece: str) -> str:
    """每一段都必须带句末标点：模型靠它判断 EOS。
    英文长句硬切后没有结尾标点时，模型会一路念到 max_new_frames（听感就是「英文
    播不出来 / 一直嗡嗡念」）；这里统一补上，逗号 / 冒号这种半句尾巴也换成句号。"""
    p = str(piece or "").strip().rstrip(_TRAILING_JUNK)
    if not p:
        return ""
    if p[-1] in "。！？!?….":
        return p
    return p + ("。" if _contains_cjk(p) else ".")


def _is_sentence_period(text: str, index: int) -> bool:
    """英文 '.' 到底是不是句末：小数、缩写、文件名 / 域名里的点都不算。"""
    prev = text[index - 1] if index > 0 else ""
    nxt = text[index + 1] if index + 1 < len(text) else ""
    if prev.isdigit() and nxt.isdigit():
        return False
    if prev.isalpha() and nxt.isalpha():
        return False  # foo.py / e.g / example.com
    tail = re.search(r"([A-Za-z][A-Za-z.]{0,9})$", text[max(0, index - 12) : index])
    if tail and tail.group(1).lower().strip(".") in ABBREVIATIONS:
        return False
    if prev.isupper() and (nxt.isspace() or nxt == ""):
        return False  # J. Smith
    return True


def _word_cut(text: str, limit: int) -> int:
    """在 limit 附近找一个不切在英文单词中间的位置。"""
    if len(text) <= limit:
        return len(text)
    low = max(4, int(limit * 0.6))
    for i in range(min(limit, len(text)), low, -1):
        if text[i - 1] in " ，,、：:；;—…\t":
            return i
    space = text.rfind(" ", 0, limit)
    return space + 1 if space > 0 else limit


def _hard_split(piece: str, limit: int) -> list[str]:
    out: list[str] = []
    rest = str(piece or "").strip()
    while len(rest) > limit:
        cut = _word_cut(rest, limit)
        head = rest[:cut].strip()
        if head:
            out.append(head)
        rest = rest[cut:].strip()
    if rest:
        out.append(rest)
    return out


def split_sentences(text: str, max_chars: int = 42) -> list[str]:
    """把一段话切成「一口气能念完」的短句。

    中文：优先句末标点，超长再按逗号，最后硬切。
    英文（本次修复）：'.' 也是句末（避开小数 / 缩写 / 文件名），超长按空格切，
    绝不切在单词中间；每段补句末标点，避免英文没有 EOS 一路念到帧上限。
    """
    clean = " ".join(str(text or "").split())
    if not clean:
        return []
    latin = _is_mostly_latin(clean)
    safe_max = max(8, int(max_chars))
    if latin:
        # 英文按词切，块太小反而一顿一顿；上限仍控制在「首字 ~2 秒内出声」
        safe_max = max(48, min(140, int(safe_max * 2.5)))
    pieces: list[str] = []
    buf = ""
    pending_dot = False
    index = 0
    while index < len(clean):
        ch = clean[index]
        if pending_dot:
            pending_dot = False
            if ch.isspace():
                # 句点 + 空白 = 断句（空白丢弃）
                if buf.strip():
                    pieces.append(buf.strip())
                buf = ""
                index += 1
                continue
        buf += ch
        if ch in SESSION_END:
            if buf.strip():
                pieces.append(buf.strip())
            buf = ""
        elif ch == "." and len(buf.strip()) >= 4 and _is_sentence_period(clean, index):
            pending_dot = True  # 等下一个字符确认是不是句末
        elif len(buf) >= safe_max and ch in CLAUSE_END:
            if buf.strip():
                pieces.append(buf.strip())
            buf = ""
        elif len(buf) >= safe_max * 2:
            cut = _word_cut(buf, safe_max * 2)
            head = buf[:cut].strip()
            if head:
                pieces.append(head)
            buf = buf[cut:]
        index += 1
    if buf.strip():
        pieces.append(buf.strip())

    out: list[str] = []
    for piece in pieces:
        for part in _hard_split(piece, safe_max):
            normalized = _ensure_terminal(part)
            if normalized:
                out.append(normalized)
    return out



def _normalize_for_tts(text: str) -> str:
    """英文播报的常见坑：弯引号 / 长破折号 / 不换行空格会被 tokenizer 念成怪符号。"""
    s = str(text or "")
    s = (
        s.replace("\u2018", "'")
        .replace("\u2019", "'")
        .replace("\u201c", '"')
        .replace("\u201d", '"')
        .replace("\u00a0", " ")
        .replace("\u200b", "")
        .replace("\u2013", ", ")
        .replace("\u2014", ", ")
    )
    return " ".join(s.split())


# ── 播报文本清洗（MTNode patch）──────────────────────────────────────────────
# 摘要模型的输出直接喂给 TTS 是「错字」的主要来源：markdown 记号（** ` # | >）、
# emoji、URL、文件名里的点、以及阿拉伯数字 / 百分号 / 日期，0.1B 的模型不会自己
# 转成口语，要么念成怪音，要么跳过整段。这里在切句之前统一冲一遍。
_EMOJI_RE = re.compile(
    "[\U0001F000-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF\uFE0F\u200D\u20E3]"
)
_MD_LINK_RE = re.compile(r"\[([^\[\]]+?)\]\((?:https?://|www\.)[^)]*\)", re.I)
_URL_RE = re.compile(r"(?:https?://|www\.)\S+", re.I)
_MD_MARK_RE = re.compile(r"(\*{1,3}|_{1,3}|~~|`{1,3})")
_MD_LINE_RE = re.compile(r"^[ \t]{0,3}(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+[.)][ \t]+)", re.M)

_CN_DIGITS = "零一二三四五六七八九"
_CN_UNITS = ("", "十", "百", "千")
_CN_BIG = ("", "万", "亿", "万亿")


def _cn_integer(value: int) -> str:
    """整数读法：1234 → 一千二百三十四（0 → 零）。"""
    if value < 0:
        return "负" + _cn_integer(-value)
    if value == 0:
        return "零"
    groups: list[int] = []
    rest = value
    while rest > 0:
        groups.append(rest % 10000)
        rest //= 10000
    parts: list[str] = []
    for index in range(len(groups) - 1, -1, -1):
        group = groups[index]
        if group == 0:
            if parts and not parts[-1].endswith("零"):
                parts.append("零")
            continue
        text = ""
        pending_zero = False
        for position in range(3, -1, -1):
            digit = (group // (10 ** position)) % 10
            if digit == 0:
                if text and position > 0:
                    pending_zero = True
                continue
            if pending_zero:
                text += "零"
                pending_zero = False
            text += _CN_DIGITS[digit] + _CN_UNITS[position]
        parts.append(text + _CN_BIG[index])
    out = "".join(parts).strip("零")
    if out.startswith("一十"):
        out = out[1:]
    return out or "零"


def _cn_number_str(raw: str) -> str:
    """带符号 / 小数的口语读法：-3.14 → 负三点一四。"""
    text = str(raw or "").strip()
    negative = text.startswith("-")
    text = text.lstrip("-")
    if "." in text:
        integer, _, fraction = text.partition(".")
        spoken = _cn_integer(int(integer or "0")) + "点" + "".join(
            _CN_DIGITS[int(ch)] for ch in fraction if ch.isdigit()
        )
    else:
        spoken = _cn_integer(int(text or "0"))
    return ("负" + spoken) if negative else spoken


def _cn_digits(raw: str) -> str:
    """逐位读：2026 → 二零二六（年份 / 编号用）。"""
    return "".join(_CN_DIGITS[int(ch)] for ch in str(raw) if ch.isdigit())


def _expand_speech_numbers(text: str) -> str:
    """只对中文文本做数字口语化；英文句子里阿拉伯数字本来就念得对，不碰。"""
    s = str(text or "")
    if not _contains_cjk(s):
        return s
    s = re.sub(r"(-?\d+(?:\.\d+)?)\s*[%％]", lambda m: "百分之" + _cn_number_str(m.group(1)), s)
    s = re.sub(
        r"(-?\d+(?:\.\d+)?)\s*(?:℃|°C|°c)",
        lambda m: _cn_number_str(m.group(1)) + "摄氏度",
        s,
    )
    s = re.sub(r"(?<!\d)(\d{4})\s*年", lambda m: _cn_digits(m.group(1)) + "年", s)
    s = re.sub(r"(?<!\d)(\d{1,2})\s*月", lambda m: _cn_integer(int(m.group(1))) + "月", s)
    s = re.sub(r"(?<!\d)(\d{1,2})\s*[日号]", lambda m: _cn_integer(int(m.group(1))) + "日", s)
    s = re.sub(
        r"(?<!\d)(\d{1,2}):(\d{2})(?!\d)",
        lambda m: _cn_integer(int(m.group(1)))
        + "点"
        + (
            "零" + _CN_DIGITS[int(m.group(2)[1])]
            if m.group(2).startswith("0")
            else _cn_integer(int(m.group(2)))
        ),
        s,
    )
    for unit, spoken in (
        ("km", "公里"),
        ("kg", "千克"),
        ("cm", "厘米"),
        ("mm", "毫米"),
        ("ml", "毫升"),
    ):
        s = re.sub(rf"(\d)\s*{unit}\b", lambda m, u=spoken: m.group(1) + u, s, flags=re.I)
    s = re.sub(r"(?<![\d.])(\d+\.\d+)(?!\.?\d)", lambda m: _cn_number_str(m.group(1)), s)
    s = re.sub(
        r"(?<![A-Za-z0-9.])(\d{1,12})(?![A-Za-z0-9.])",
        lambda m: _cn_integer(int(m.group(1))),
        s,
    )
    return s


def _clean_for_speech(text: str) -> str:
    """把 markdown / emoji / 链接 / 数字冲成「能直接念」的中文口语文本。"""
    s = str(text or "")
    s = _MD_LINK_RE.sub(r"\1", s)
    s = _URL_RE.sub(" ", s)
    s = _EMOJI_RE.sub("", s)
    s = _MD_MARK_RE.sub("", s)
    s = _MD_LINE_RE.sub("", s)
    # 2026/03/31、2026-03-31 → 年月日，交给下面的数字口语化
    s = re.sub(
        r"(?<!\d)(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?!\d)",
        lambda m: m.group(1) + "年" + m.group(2) + "月" + m.group(3) + "日",
        s,
    )
    s = s.replace("|", "，").replace("\\", " ").replace("/", " ")
    s = _expand_speech_numbers(s)
    try:
        from tts_robust_normalizer_single_script import normalize_tts_text

        s = normalize_tts_text(s)
    except Exception as exc:  # 清洗器不可用不该让播报失败
        log("text clean skipped: " + str(exc))
    return s


def _estimate_tokens(piece: str) -> int:
    """不依赖 tokenizer 的保守估算（中文 1 字 ≈ 1 token，英文 ~4 字符 1 token）。"""
    cjk = len(_CJK_RE.findall(piece))
    return cjk + max(1, (len(piece) - cjk) // 4)


def _cap_piece_tokens(piece: str, limit: int = 75) -> list[str]:
    """单句 token 上限（上游 voice_clone_max_text_tokens 默认 75）：
    超过就按逗号折半——0.1B 模型吃长句会漏字、拖音、音色飘。"""
    if _estimate_tokens(piece) <= limit:
        return [piece]
    out: list[str] = []
    rest = piece
    while rest and _estimate_tokens(rest) > limit:
        cut = -1
        for mark in ("，", ",", "、", "：", ":", "；", ";"):
            index = rest.rfind(mark, 0, max(1, len(rest) // 2))
            if index > cut:
                cut = index
        if cut <= 0:
            cut = max(1, len(rest) // 2)
        head = rest[: cut + 1].strip()
        if head:
            out.append(head)
        rest = rest[cut + 1 :].strip()
    if rest:
        out.append(rest)
    return out


def _limit_peak(waveform, ceiling: float = 0.98):
    """输出防削波：模型偶尔会把一句推过 0 dBFS，直接写 wav 会硬切出爆音
    （听感像「音色崩了 / 破音」）。超过就整段等比压下来，不改音色只改电平。"""
    try:
        import numpy as np

        wav = np.asarray(waveform, dtype=np.float32)
        peak = float(np.abs(wav).max()) if wav.size else 0.0
        if peak > ceiling and peak > 0:
            wav = wav * (ceiling / peak)
        return wav
    except Exception:
        return waveform


def trim_silence(waveform, sample_rate: int, keep_ms: int = 60, thresh_ratio: float = 0.04):
    """掐掉首尾静音（含模型爱补的气口尾巴），只留真正说话的那一段。
    每 20ms 取一次包络峰值，以峰值的 4% 为界；两侧各留 keep_ms 的余量免得咬字。"""
    try:
        import numpy as np

        wav = np.asarray(waveform, dtype=np.float32)
        if wav.ndim == 2 and wav.shape[0] > 0:
            env = np.abs(wav).max(axis=1)
        elif wav.ndim == 1:
            env = np.abs(wav)
        else:
            return waveform
        win = max(1, int(sample_rate * 0.02))
        n = len(env) // win
        if n < 4:
            return waveform
        frames = env[: n * win].reshape(n, win).max(axis=1)
        peak = float(frames.max())
        if peak <= 1e-4:
            return waveform
        loud = frames > peak * float(thresh_ratio)
        if not loud.any():
            return waveform
        first = int(np.argmax(loud))
        last = n - 1 - int(np.argmax(loud[::-1]))
        pad = max(1, int(round(keep_ms / 20.0)))
        start = max(0, (first - pad) * win)
        end = min(len(env), (last + 1 + pad) * win)
        if end - start < win * 4:
            return waveform
        return wav[start:end]
    except Exception:
        return waveform


class Worker:
    def __init__(self, model_dir: str, threads: int = 4, provider: str = "auto") -> None:
        self.model_dir = str(model_dir or "").strip()
        self.threads = max(1, int(threads or 4))
        self.provider = normalize_provider(provider)
        self.runtime = None
        self.active_provider = "cpu"
        self.reported_device = ""
        self.cancel_ids: set[str] = set()
        self.current_id = ""
        self.lock = threading.Lock()
        self.speak_lock = threading.Lock()

    # ── 模型 ────────────────────────────────────────────────────────────
    def _report_device(self, provider: str, reason: str) -> None:
        """设备决策只上报一次（同一 provider 不重复刷）。"""
        if self.reported_device == provider:
            return
        self.reported_device = provider
        log("device: provider=%s requested=%s reason=%s" % (provider, self.provider, reason or "-"))
        emit(
            {
                "type": "device",
                "provider": provider,
                "requested": self.provider,
                "reason": reason,
            }
        )

    def _build_runtime(self, provider: str):
        from onnx_tts_runtime import OnnxTtsRuntime

        runtime = OnnxTtsRuntime(
            model_dir=self.model_dir,
            thread_count=self.threads,
            execution_provider=provider,
        )
        if provider == "cuda":
            actual: set[str] = set()
            for session in runtime.sessions.values():
                try:
                    actual.update(str(item) for item in session.get_providers())
                except Exception:
                    pass
            if CUDA_PROVIDER_ID not in actual:
                raise RuntimeError(
                    "CUDAExecutionProvider 未生效，实际 providers: %s" % (sorted(actual),)
                )
        return runtime

    def _use_runtime(self, runtime, provider: str) -> None:
        self.runtime = runtime
        self.active_provider = provider
        # 采样模式固定成 full（宿主采样 + 文本 EOS 判停）。
        # 上游默认的 fixed（本地预采样帧）在连续合成时会「停不下来」：同一进程里第二、
        # 第三句偶尔一路念到 max_new_frames（实测 13 字的句子出 28 秒音频），
        # full 每次都能在句末收住（单句 3 秒音频约 4 秒 CPU，fixed 是 1.6 秒但会跑飞）。
        self.runtime.manifest["generation_defaults"]["sample_mode"] = "full"
        self.runtime.manifest["generation_defaults"]["do_sample"] = True

    def ensure_runtime(self) -> None:
        if self.runtime is not None:
            return
        requested = self.provider
        if requested == "cpu":
            self._use_runtime(self._build_runtime("cpu"), "cpu")
            self._report_device("cpu", "按 --provider cpu 指定")
            return
        try:
            self._use_runtime(self._build_runtime("cuda"), "cuda")
        except Exception as exc:
            log(traceback.format_exc())
            log("cuda 初始化失败，回落 cpu: " + str(exc))
            self._use_runtime(self._build_runtime("cpu"), "cpu")
            self._report_device("cpu", "cuda 初始化失败: " + (str(exc) or exc.__class__.__name__))
            return
        self._report_device("cuda", "")

    def _fallback_to_cpu(self, reason: str) -> None:
        """CUDA runtime 不可用（预热失败 / 运行中出错）时重建 CPU runtime。"""
        self.runtime = None
        self._use_runtime(self._build_runtime("cpu"), "cpu")
        self.reported_device = ""  # 允许重新上报设备变化
        self._report_device("cpu", reason)

    def cancelled(self, req_id: str) -> bool:
        with self.lock:
            return req_id in self.cancel_ids
    # ── 预热 ────────────────────────────────────────────────────────────
    def _warmup_synth(self, seed: Path) -> None:
        codes = self.runtime.resolve_prompt_audio_codes(voice=None, prompt_audio_path=str(seed))
        self.runtime.synthesize_single_chunk(text="你好。", prompt_audio_codes=codes, streaming=True)

    def warmup(self) -> None:
        """把「第一次」全部提前：加载模型 + 参考音频编码 + 合成一小段。
        原因不是性能，而是 Windows 的线程安全：读 stdin 的线程一旦起来，
        主线程再 import C 扩展就会僵死（见 main 的说明）。预热过的进程之后只做计算、
        不再 LoadLibrary，读线程才能安全地跟合成并行跑。
        CUDA 预热失败（DLL / 算子 / 显存）同样回落 CPU，保证进程一定能出声。"""
        started = time.time()
        self.ensure_runtime()
        emit({"type": "loaded", "ms": int((time.time() - started) * 1000)})
        seed = APP_DIR / "seed" / "deepseek.wav"
        if not seed.is_file():
            log("warmup: 没有内置参考音频，跳过合成预热")
            return
        try:
            self._warmup_synth(seed)
        except Exception as exc:
            if self.active_provider != "cuda":
                raise
            log(traceback.format_exc())
            log("cuda 预热失败，回落 cpu: " + str(exc))
            self._fallback_to_cpu("cuda 预热失败: " + (str(exc) or exc.__class__.__name__))
            self._warmup_synth(seed)
        log("warmup done in %dms" % int((time.time() - started) * 1000))

    # ── 合成 ────────────────────────────────────────────────────────────
    def speak(self, msg: dict) -> None:
        """合成一次播报。永远在主线程里跑（模型不跨线程推进）；
        「新播报打断旧的」靠 reader 线程读到 cancel 即时记进 cancel_ids，
        本方法在每句边界自查（见 main 的 reader）。"""
        with self.speak_lock:
            self._speak(msg)

    def _speak(self, msg: dict) -> None:
        req_id = str(msg.get("id") or "req")
        text = _clean_for_speech(_normalize_for_tts(str(msg.get("text") or "")))
        prompt_audio = str(msg.get("promptAudio") or "")
        out_dir = Path(str(msg.get("outDir") or (APP_DIR / "out"))).expanduser()
        max_chars = int(msg.get("maxChars") or 42)
        pieces = [
            part
            for piece in split_sentences(text, max_chars)
            for part in _cap_piece_tokens(piece)
        ]
        if not pieces:
            emit({"type": "done", "id": req_id, "chunks": 0, "ms": 0})
            return
        if not prompt_audio or not Path(prompt_audio).is_file():
            emit(
                {
                    "type": "error",
                    "id": req_id,
                    "code": "voice_missing",
                    "message": "参考音频不存在：" + prompt_audio,
                }
            )
            return
        started = time.time()
        log('synth start: %d 句, 参考音频 %s' % (len(pieces), prompt_audio))
        try:
            self.ensure_runtime()
        except Exception as exc:  # 模型缺失 / onnxruntime 坏了
            log(traceback.format_exc())
            emit(
                {
                    "type": "error",
                    "id": req_id,
                    "code": "model_failed",
                    "message": str(exc),
                }
            )
            return
        out_dir.mkdir(parents=True, exist_ok=True)
        try:
            codes = self.runtime.resolve_prompt_audio_codes(voice=None, prompt_audio_path=prompt_audio)
        except Exception as exc:
            log(traceback.format_exc())
            emit(
                {
                    "type": "error",
                    "id": req_id,
                    "code": "voice_failed",
                    "message": str(exc),
                }
            )
            return

        index = 0
        for piece in pieces:
            # 每句都设一个「够念完」的帧上限当兜底：正常一句约 2.5 帧/字，
            # 给到 8 帧/字 + 24 帧余量（42 字 ≈ 336 帧 < 默认 375），跑飞时不会无限念。
            self.runtime.manifest["generation_defaults"]["max_new_frames"] = min(
                375, int(len(piece) * 8) + 24
            )
            if self.cancelled(req_id):
                emit({"type": "cancelled", "id": req_id})
                return
            chunk_started = time.time()
            try:
                result = self.runtime.synthesize_single_chunk(
                    text=piece,
                    prompt_audio_codes=codes,
                    streaming=True,
                )
                from onnx_tts_runtime import _write_waveform_to_wav

                sample_rate = int(self.runtime.codec_meta["codec_config"]["sample_rate"])
                wav_path = out_dir / ("%s_%03d.wav" % (req_id, index))
                _write_waveform_to_wav(
                    wav_path,
                    trim_silence(_limit_peak(result["waveform"]), sample_rate),
                    sample_rate,
                )
            except Exception as exc:
                log(traceback.format_exc())
                emit(
                    {
                        "type": "error",
                        "id": req_id,
                        "code": "synth_failed",
                        "message": str(exc),
                    }
                )
                return
            emit(
                {
                    "type": "chunk",
                    "id": req_id,
                    "index": index,
                    "path": str(wav_path),
                    "text": piece,
                    "ms": int((time.time() - chunk_started) * 1000),
                }
            )
            log('chunk %d done in %dms' % (index, int((time.time() - chunk_started) * 1000)))
            index += 1
        with self.lock:
            self.cancel_ids.discard(req_id)
        emit(
            {
                "type": "done",
                "id": req_id,
                "chunks": index,
                "ms": int((time.time() - started) * 1000),
            }
        )


def main() -> int:
    # 参考音频预处理 / 文本清洗的日志走 stderr（宿主收到 console.log），
    # 出音色问题时能直接看到「实际用了多长、峰值多少」。
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(message)s")
    model_dir = ""
    threads = 4
    provider = "auto"
    args = sys.argv[1:]
    for i, arg in enumerate(args):
        if arg == "--model-dir" and i + 1 < len(args):
            model_dir = args[i + 1]
        elif arg == "--cpu-threads" and i + 1 < len(args):
            try:
                threads = int(args[i + 1])
            except Exception:
                threads = 4
        elif arg == "--provider" and i + 1 < len(args):
            raw_provider = args[i + 1]
            provider = normalize_provider(raw_provider)
            if provider != str(raw_provider or "").strip().lower():
                log("未知 --provider %r，按 auto 处理" % raw_provider)
    worker = Worker(model_dir=model_dir, threads=threads, provider=provider)
    emit({"type": "ready", "pid": os.getpid()})

    """收尾：先把模型加载完，再开读线程。
    Windows 上的硬约束：**读 stdin 的线程阻塞着时，主线程千万不要再 LoadLibrary**
    （import onnxruntime 这类 C 扩展）—— 会与 CRT/加载器锁互等，进程直接僵住（实测）。
    所以模型加载与所有重活儿都排在读线程之前 / 之后由主线程做，读线程只做 recv。

    读管道放在单独线程：主线程合成时（一句 0.6~1.2 秒）也要能立刻读到 cancel，
    否则「新播报打断旧的」得等这一整段念完才生效。
    cancel 在读到的那一瞬就记进 cancel_ids（合成线程每句边界自查），
    其余命令排队给主线程顺序执行 —— 合成永远在主线程里跑，不跨线程推进模型。"""
    # 先热一遍：把模型、C 扩展、懒加载的东西全在主线程里过一遍，
    # 之后读线程才允许启动（见上面的 Windows 死锁约束）。
    try:
        worker.warmup()
    except Exception:
        log("warmup failed:")
        log(traceback.format_exc())

    q: "queue.Queue[str]" = queue.Queue()

    def reader() -> None:
        for raw in sys.stdin:
            # 容错：Windows 下管道偶尔带 BOM / NUL 填充（宿主正常写入时不会有）
            line = raw.strip().lstrip("\ufeff").replace("\x00", "")
            if not line:
                continue
            try:
                msg = json.loads(line)
            except Exception:
                log("bad json: " + line[:200])
                continue
            if str(msg.get("cmd") or "") == "cancel":
                target = str(msg.get("id") or "")
                if target:
                    with worker.lock:
                        worker.cancel_ids.add(target)
                continue
            log('cmd: ' + str(msg.get('cmd')))
            q.put(msg)
        q.put(None)

    threading.Thread(target=reader, daemon=True).start()
    while True:
        msg = q.get()
        if msg is None:
            log("stdin closed，退出")
            return 0
        cmd = str(msg.get("cmd") or "")
        if cmd == "ping":
            emit({"type": "pong"})
            continue
        if cmd == "shutdown":
            emit({"type": "bye"})
            return 0
        if cmd == "speak":
            worker.speak(msg)
            continue
        log("unknown cmd: " + cmd)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
