"""Pure-python `jieba_fast` shim for the GPT-SoVITS text front-end.

The engine imports the C-accelerated fork `jieba_fast` at module top level of
its text pipeline:

    text/chinese2.py    -> import jieba_fast as jieba  (setLogLevel / lcut /
                                                       cut_for_search)
    text/chinese.py     -> import jieba_fast / jieba_fast.posseg
    text/tone_sandhi.py -> jieba_fast.posseg.lcut

The fork ships no wheel for this interpreter/ABI (tar.gz only, and its setup.py
compiles the C extension unconditionally), so pip installs of the engine
requirements could never provide it. Plain `jieba` is part of those same
requirements, is pure python and exposes the identical API, so this package just
forwards every attribute to it — nothing is re-implemented, and the objects that
come back (e.g. `posseg.pair` instances) are the real jieba ones, so any
isinstance / identity check inside the engine keeps working.

Like the gradio stub next door it lives in tts-pack/shims, which sits FIRST on
PYTHONPATH for the api_v2 subprocess (app/tts.py) and for the training
subprocess (app/train.py) — it is never written into site-packages. The two
generators of requirements-train.txt know it (tts-pack/reqs-fixups.json
"shims"), so jieba_fast is dropped before pip ever sees it.
"""
from __future__ import annotations

try:
    import jieba as _jieba
except ImportError as exc:  # pragma: no cover - install-time diagnostic
    raise ImportError(
        "tts-pack shim 'jieba_fast' is a pure-python alias of 'jieba', but the real "
        "'jieba' package is not importable. Install the engine requirements (jieba is "
        "one of them) into tts-pack/.pylibs."
    ) from exc

from . import posseg as posseg  # noqa: F401  (our shim -> jieba.posseg)

# The engine-facing API, forwarded 1:1 from the real jieba module.
dt = _jieba.dt
initialize = _jieba.initialize
setLogLevel = _jieba.setLogLevel
cut = _jieba.cut
lcut = _jieba.lcut
cut_for_search = _jieba.cut_for_search
lcut_for_search = _jieba.lcut_for_search
tokenize = _jieba.tokenize
add_word = _jieba.add_word
del_word = _jieba.del_word
suggest_freq = _jieba.suggest_freq
load_userdict = _jieba.load_userdict
set_dictionary = _jieba.set_dictionary
get_dict_file = _jieba.get_dict_file
get_FREQ = _jieba.get_FREQ
enable_parallel = _jieba.enable_parallel
disable_parallel = _jieba.disable_parallel
__version__ = getattr(_jieba, "__version__", "0.0.0-shim")


def __getattr__(name):
    # anything else the engine may reach for (Tokenizer, re_han_default, ...)
    return getattr(_jieba, name)


def __dir__():
    return sorted(set(globals()) | set(dir(_jieba)))
