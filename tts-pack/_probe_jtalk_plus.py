# -*- coding: utf-8 -*-
"""Isolation probe: is pyopenjtalk-plus a drop-in for pyopenjtalk?

Mirrors every pyopenjtalk API the GPT-SoVITS engine actually uses,
see engine/GPT_SoVITS/text/japanese.py lines 7-74 and 164, 205.
"""
import io
import os
import re
import sys
import traceback

os.environ.setdefault("PYTHONIOENCODING", "utf-8")
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

results = []


def check(name, fn):
    try:
        detail = fn()
        results.append((name, True, detail))
    except Exception as e:
        results.append((name, False, "%s: %s" % (type(e).__name__, e)))
        traceback.print_exc()


# --- [1] import pyopenjtalk must resolve to pyopenjtalk_plus -------------
def t_import():
    import pyopenjtalk
    mod_file = getattr(pyopenjtalk, "__file__", "")
    ver = getattr(pyopenjtalk, "__version__", None)
    try:
        from importlib.metadata import version as _v
        dist_ver = _v("pyopenjtalk-plus")
    except Exception:
        dist_ver = None
    return "module=%s __version__=%s dist(pyopenjtalk-plus)=%s" % (mod_file, ver, dist_ver)


check("1. import pyopenjtalk (no pyopenjtalk dist installed)", t_import)

import pyopenjtalk  # noqa: E402

# --- [2] OPEN_JTALK_DICT_DIR is bytes, decodable utf-8, and real dir -----
def t_dictdir():
    d = pyopenjtalk.OPEN_JTALK_DICT_DIR
    assert isinstance(d, (bytes, bytearray)), "expected bytes, got %r" % type(d)
    s = d.decode("utf-8")  # japanese.py line 14 - crashes if not bytes
    assert os.path.isdir(s), "dict dir does not exist: %s" % s
    # japanese.py line 32 writes it back as bytes
    pyopenjtalk.OPEN_JTALK_DICT_DIR = s.encode("utf-8")
    assert pyopenjtalk.OPEN_JTALK_DICT_DIR == d
    # japanese.py line 15 regex - a non-ascii path would take the copytree branch
    ascii_safe = bool(re.match(r"^[A-Za-z0-9_/\\:.\-]*$", s))
    return "bytes len=%d decoded=%r ascii_safe=%s" % (len(d), s, ascii_safe)


check("2. OPEN_JTALK_DICT_DIR bytes + .decode('utf-8') + rewrite", t_dictdir)


# --- [3] all 6 APIs used by the engine exist and are callable ------------
NEEDED = [
    "g2p",
    "make_label",
    "run_frontend",
    "mecab_dict_index",
    "update_global_jtalk_with_user_dict",
    "OPEN_JTALK_DICT_DIR",
]


def t_api_surface():
    missing = [n for n in NEEDED if not hasattr(pyopenjtalk, n)]
    assert not missing, "missing: %s" % missing
    notcallable_ = [
        n for n in NEEDED
        if n != "OPEN_JTALK_DICT_DIR" and not callable(getattr(pyopenjtalk, n))
    ]
    assert not notcallable_, "not callable: %s" % notcallable_
    return "all present: %s" % ", ".join(NEEDED)


check("3. API surface (g2p/make_label/run_frontend/mecab_dict_index/update_global_jtalk_with_user_dict/OPEN_JTALK_DICT_DIR)", t_api_surface)


# --- [4] g2p actually phonemizes (japanese.py line 164) ------------------
def t_g2p():
    out = pyopenjtalk.g2p("こんにちは、世界。")
    assert isinstance(out, str) and out.strip(), "empty g2p output: %r" % out
    return "g2p('こんにちは、世界。') -> %r" % out


check("4. g2p real phonemization", t_g2p)


# --- [5] run_frontend + make_label (japanese.py line 205) ----------------
def t_frontend_label():
    feats = pyopenjtalk.run_frontend("こんにちは、世界。")
    assert isinstance(feats, (list, tuple)) and feats, "empty frontend: %r" % (feats,)
    labels = pyopenjtalk.make_label(feats)
    # engine expects a list of full-context label strings it regexes (japanese.py:205-213)
    assert isinstance(labels, (list, tuple)) and labels, "empty label list: %r" % (labels,)
    assert all(isinstance(x, str) for x in labels), "non-str label"
    p3 = re.search(r"\-(.*?)\+", labels[1]).group(1)
    return "run_frontend -> %d items; make_label -> %d labels; label[1] phoneme=%r" % (
        len(feats), len(labels), p3)


check("5. run_frontend + make_label (full pipeline)", t_frontend_label)


# --- [6] mecab_dict_index + update_global_jtalk_with_user_dict ----------
# mirrors japanese.py lines 57-71 with a real userdict.csv
def t_userdict():
    tmp = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ja_userdic")
    os.makedirs(tmp, exist_ok=True)
    csv_path = os.path.join(tmp, "userdict.csv")
    bin_path = os.path.join(tmp, "user.dict")
    with io.open(csv_path, "w", encoding="utf-8") as f:
        f.write("测试词条,0,0,5000,名詞,一般,*,*,*,*,测试词条,テストジョウキ,テストジョウキ,0/4,*\n")
    if os.path.exists(bin_path):
        os.remove(bin_path)
    pyopenjtalk.mecab_dict_index(csv_path, bin_path)  # line 66
    assert os.path.exists(bin_path), "mecab_dict_index produced no file: %s" % bin_path
    sz = os.path.getsize(bin_path)
    pyopenjtalk.update_global_jtalk_with_user_dict(bin_path)  # line 71
    return "mecab_dict_index -> %s (%d bytes); update_global_jtalk_with_user_dict ok" % (bin_path, sz)


check("6. mecab_dict_index + update_global_jtalk_with_user_dict", t_userdict)


# --- [7] import japanese.py itself (the real consumer) -------------------
def t_engine_module():
    engine = r"E:\mtnode-test\tts\engine"
    if not os.path.isdir(engine):
        raise RuntimeError("engine dir not found: %s" % engine)
    sys.path.insert(0, engine)
    sys.path.insert(0, os.path.join(engine, "GPT_SoVITS"))
    os.chdir(engine)  # japanese.py uses relative TEMP/ paths on win
    try:
        import importlib
        m = importlib.import_module("GPT_SoVITS.text.japanese")
        has = [n for n in ("get_phones_and_bert",) if hasattr(m, n)]
        return "imported %s (cwd=%s) has=%s" % (m.__file__, os.getcwd(), has)
    finally:
        pass


check("7. real consumer GPT_SoVITS/text/japanese.py imports cleanly", t_engine_module)


# --- [8] end-to-end: engine's own phonemizer produces symbols ----------
def t_engine_g2p():
    import importlib
    m = importlib.import_module("GPT_SoVITS.text.japanese")
    ja_g2p = getattr(m, "g2p")
    prosody = getattr(m, "pyopenjtalk_g2p_prosody")
    ph = ja_g2p("こんにちは、世界。")  # japanese.py:267-271 returns the phone list
    assert ph and isinstance(ph, list), "empty phones: %r" % (ph,)
    raw = prosody("こんにちは。")
    return "japanese.g2p -> %d phones %r; prosody -> %r" % (len(ph), ph, raw)


check("8. engine japanese.g2p / pyopenjtalk_g2p_prosody end-to-end", t_engine_g2p)


# --- report -------------------------------------------------------------
print("\n" + "=" * 72)
ok = True
for name, passed, detail in results:
    flag = "PASS" if passed else "FAIL"
    if not passed:
        ok = False
    print("[%s] %s\n        %s" % (flag, name, detail))
print("=" * 72)
print("OVERALL: %s  (%d/%d)" % ("PASS" if ok else "FAIL",
                                sum(1 for r in results if r[1]), len(results)))
sys.exit(0 if ok else 1)
