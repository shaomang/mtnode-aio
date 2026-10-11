"""`jieba_fast.posseg` shim -> `jieba.posseg`.

See jieba_fast/__init__.py for why the fork is aliased to plain jieba. Only the
POS-tagging entry points the engine uses are re-exported explicitly
(`psg.lcut` in text/chinese2.py and text/tone_sandhi.py); everything else falls
through to the real module via __getattr__.

`pair` / `POSTokenizer` / `dt` are the real jieba objects, so tagging results
are plain jieba.posseg.pair instances and stay isinstance-compatible with the
engine's own checks.
"""
from __future__ import annotations

try:
    import jieba.posseg as _posseg
except ImportError as exc:  # pragma: no cover - install-time diagnostic
    raise ImportError(
        "tts-pack shim 'jieba_fast.posseg' forwards to 'jieba.posseg', but the real "
        "'jieba' package is not importable. Install the engine requirements (jieba is "
        "one of them) into tts-pack/.pylibs."
    ) from exc

pair = _posseg.pair
POSTokenizer = _posseg.POSTokenizer
dt = _posseg.dt
initialize = _posseg.initialize
cut = _posseg.cut
lcut = _posseg.lcut


def __getattr__(name):
    return getattr(_posseg, name)


def __dir__():
    return sorted(set(globals()) | set(dir(_posseg)))
