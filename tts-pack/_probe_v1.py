import sys

sys.path.insert(0, r"E:\mtnode-plugins\tts\engine\GPT_SoVITS")
from text import symbols_v1, symbols_v2

s1 = set(symbols_v1.symbols)
s2 = set(symbols_v2.symbols)
m1, m2 = set(), set()
n = 0
with open(r"E:\mtnode-plugins\tts\engine\data\aoi\aoi\2-name2text.txt", encoding="utf-8") as f:
    for ln in f:
        ln = ln.rstrip("\n")
        if not ln:
            continue
        parts = ln.split("\t")
        if len(parts) < 2:
            continue
        for tok in parts[1].split():
            n += 1
            if tok not in s1:
                m1.add(tok)
            if tok not in s2:
                m2.add(tok)
print("total tokens:", n)
print("len v1:", len(s1), "len v2:", len(s2))
print("missing in v1:", sorted(m1))
print("missing in v2:", sorted(m2))
