import sys, os, torch

sys.path.insert(0, r"E:\mtnode-plugins\tts\engine\GPT_SoVITS")
from text import symbols_v1, symbols_v2

print("TORCH", torch.__version__, "cuda", torch.cuda.is_available())

ck = torch.load(
    r"E:\mtnode-plugins\tts\engine\GPT_SoVITS\pretrained_models\s2G488k.pth",
    map_location="cpu",
    weights_only=False,
)["weight"]
k = "enc_p.text_embedding.weight"
print("ckpt", k, tuple(ck[k].shape))
print("v1 symbols len", len(symbols_v1.symbols))
print("v2 symbols len", len(symbols_v2.symbols))
print("expected(v2, h=192)", (len(symbols_v2.symbols), 192))

# all enc_p.* keys and their shapes for comparison
for key in sorted(ck.keys()):
    if key.startswith("enc_p."):
        print("  ", key, tuple(ck[key].shape))
