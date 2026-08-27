import json
import sys
from pathlib import Path

# 1) import the patched train.py and point ENGINE_DIR at the real install
sys.path.insert(0, r"E:\dev\tools\pipeline-console\tts-pack\app")
import train

train.ENGINE_DIR = Path(r"E:\mtnode-plugins\tts")
real_pretrained = Path(r"E:\mtnode-plugins\tts\engine\GPT_SoVITS\pretrained_models\s2G488k.pth")
print("pretrained exists:", real_pretrained.exists(), "size:", real_pretrained.stat().st_size)

cfg_path = train._build_s2_config("probe", "probe", "probe", Path(r"E:\mtnode-plugins\tts\engine"))
cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
print("generated config:", cfg_path)
print("model.version =", cfg["model"].get("version"))
print("pretrained_s2G =", cfg["train"].get("pretrained_s2G"))
assert cfg["model"]["version"] == "v1", "version must be v1 for s2G488k"

# 2) build the model exactly like s2_train.py does and load the pretrained ckpt
import torch

sys.path.insert(0, r"E:\mtnode-plugins\tts\engine\GPT_SoVITS")
from module.models import SynthesizerTrn

hps = cfg
net_g = SynthesizerTrn(
    hps["data"]["filter_length"] // 2 + 1,
    hps["train"]["segment_size"] // hps["data"]["hop_length"],
    n_speakers=hps["data"]["n_speakers"],
    **hps["model"],
)
print("net_g text_embedding:", tuple(net_g.enc_p.text_embedding.weight.shape))

ck = torch.load(str(real_pretrained), map_location="cpu", weights_only=False)["weight"]
r = net_g.load_state_dict(ck, strict=False)
print("LOAD OK  missing:", len(r.missing_keys), " unexpected:", len(r.unexpected_keys))
for k in r.missing_keys[:15]:
    print("  MISS", k)
for k in r.unexpected_keys[:15]:
    print("  UNEXP", k)
print("RESULT: no size mismatch -> s2 pretrained load succeeds")
