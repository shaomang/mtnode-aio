#!/usr/bin/env python
"""Install the MANDATORY Sage Attention pair into the H3 ComfyUI venv.

Why this script exists: Sage Attention used to be an optional "click the button if you
want it" speed tier. It is now a hard requirement of the H3 backend (no Sage => the host
refuses to start the backend and refuses to generate), so the install chain has to put it
in place itself instead of hoping the user finds a button later.

Windows needs two packages as a pair:
  * triton-windows   - sageattention's core pulls Triton kernels at import time and PyPI
                       has no `triton` build for Windows.
  * sageattention 2.x - PyPI only carries the old 1.0.6 (v1, source build). 2.x ships as
                       prebuilt wheels on woct0rdho/SageAttention releases; the file name
                       encodes the CUDA major, the torch version and the Python tag, so the
                       wheel MUST be picked to match this venv.

Escape hatch (the only way to declare "this machine really cannot"):
  MT_H3_SAGE_EXEMPT=1       - the host reads it; here it only suppresses nothing: the
                              caller (install.ps1) decides to keep going with a warning.
  MT_H3_SAGE_WHEEL=<path>   - local .whl to install instead of downloading one (offline).
  MT_H3_SAGE_WHEEL_URL=<u>  - direct URL to a wheel to install instead of the release API.

Output contract (parsed by scripts/install.ps1 -> steps.json):
  successful run : exit 0, last meaningful line "SAGE-OK=1 ..."
  failed run     : exit 1, a line starting with "SAGE-<KIND>=<detail>" plus "FAILED ..."
                   (never print "ok=false": the host treats that as a failure marker even
                   on the success path of a parent step)

The file is deliberately pure ASCII: it is shipped inside the install pack and read on
machines whose console code page is not UTF-8.
"""

import json
import os
import re
import subprocess
import sys
import urllib.request

SAGE_RELEASES_API = "https://api.github.com/repos/woct0rdho/SageAttention/releases?per_page=30"
SAGE_RELEASES_PAGE = "https://github.com/woct0rdho/SageAttention/releases"
SAGE_SUPPORTED_SM = ["sm75", "sm80", "sm86", "sm87", "sm89", "sm90", "sm100", "sm120", "sm121"]
# torch minor -> matching triton-windows major (a torch build pins its triton)
TORCH_TRITON = {
    "2.5": "3.1",
    "2.6": "3.2",
    "2.7": "3.3",
    "2.8": "3.4",
    "2.9": "3.5",
    "2.10": "3.6",
}
# sageattention-2.2.0+cu130torch2.9.1.post6-cp310-abi3-win_amd64.whl
WHEEL_RE = re.compile(
    r"^sageattention-(\d+\.\d+(?:\.\d+)?)\+cu(\d+)torch(\d+)\.(\d+)(?:\.(\d+))?"
    r"(andhigher)?(?:\.post(\d+))?-(cp\d+)-(abi3|cp\d+)-win_amd64\.whl$"
)

SMOKE_CODE = """
import torch
from sageattention import sageattn
q = torch.randn(1, 2, 128, 64, device='cuda', dtype=torch.float16)
o = sageattn(q, q, q, tensor_layout='NHD')
torch.cuda.synchronize()
assert bool(torch.isfinite(o.float()).all().item()), 'nonfinite'
print('KERNEL_OK')
"""


def say(msg):
    print("[sage] " + str(msg), flush=True)


def start_fail(kind, detail):
    print("[sage] SAGE-%s=%s" % (kind, str(detail).replace("\n", " ")[:400]), flush=True)
    print("[sage] FAILED " + str(detail).replace("\n", " ")[:400], flush=True)
    sys.exit(1)


def run_pip(args):
    cmd = [sys.executable, "-m", "pip", "install", "--disable-pip-version-check"] + args
    say("pip install " + " ".join(args))
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    out = p.stdout.decode("utf-8", "replace")
    for line in out.splitlines():
        t = line.strip()
        if t:
            print("[pip] " + t, flush=True)
    return p.returncode, out


def pip_tail(out):
    lines = [l.strip() for l in str(out).splitlines() if l.strip()]
    return " / ".join(lines[-4:])[-400:]


def probe():
    fact = {"py": "%d.%d" % sys.version_info[:2], "torch": "", "cuda": "", "sm": "", "why": []}
    try:
        import torch

        fact["torch"] = str(torch.__version__)
        fact["cuda"] = str(torch.version.cuda or "")
        if torch.cuda.is_available():
            fact["sm"] = "sm%d%d" % torch.cuda.get_device_capability(0)
    except Exception as e:  # noqa: BLE001 - report, never raise
        fact["why"].append("torch:" + type(e).__name__)
    return fact


def have(module):
    try:
        __import__(module)
        return True
    except Exception:  # noqa: BLE001
        return False


def pick_wheel(releases, py_minor, torch_parts, cuda_major):
    def vparts(s):
        m = re.search(r"(\d+)\.(\d+)(?:\.(\d+))?", str(s or ""))
        return [int(m.group(1)), int(m.group(2)), int(m.group(3) or 0)] if m else []

    def vcmp(a, b):
        a = a or []
        b = b or []
        for i in range(3):
            d = (a[i] if len(a) > i else 0) - (b[i] if len(b) > i else 0)
            if d:
                return 1 if d > 0 else -1
        return 0

    picked = []
    for rel in releases if isinstance(releases, list) else []:
        for asset in rel.get("assets") or []:
            name = str(asset.get("name") or "")
            m = WHEEL_RE.match(name)
            if not m:
                continue
            abi3 = m.group(9) == "abi3"
            cp_minor = int(str(m.group(8))[3:])
            if (cp_minor > py_minor) if abi3 else (cp_minor != py_minor):
                continue
            cu = int(m.group(2))
            if cuda_major and int(cu / 10) != cuda_major:
                continue
            base = [int(m.group(3)), int(m.group(4)), int(m.group(5) or 0)]
            and_higher = bool(m.group(6))
            if and_higher:
                if torch_parts and vcmp(torch_parts, base) < 0:
                    continue
                score = 1
            else:
                if torch_parts and (torch_parts[0] != base[0] or torch_parts[1] != base[1]):
                    continue
                score = 2
            picked.append(
                {
                    "file": name,
                    "url": str(asset.get("browser_download_url") or ""),
                    "ver": m.group(1),
                    "cu": "cu" + str(cu),
                    "score": score,
                    "post": int(m.group(7) or 0),
                    "release": str(rel.get("tag_name") or ""),
                }
            )
    if not picked:
        return None
    picked.sort(key=lambda w: (vparts(w["ver"]), w["score"], w["post"], w["release"]), reverse=True)
    return picked[0]


def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "mtnode-h3-install", "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def download(url, dest):
    say("downloading " + url)
    req = urllib.request.Request(url, headers={"User-Agent": "mtnode-h3-install"})
    with urllib.request.urlopen(req, timeout=60) as r, open(dest, "wb") as f:
        total = int(r.headers.get("Content-Length") or 0)
        got = 0
        step = 0
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
            got += len(chunk)
            pct = int(got * 100 / total) if total else 0
            if total and pct >= step + 20:
                step = pct - (pct % 20)
                print("[sage] download %d%%" % step, flush=True)
    say("downloaded %d bytes" % got)
    return dest


def main():
    fact = probe()
    if not fact["torch"]:
        start_fail("PROBE", "import torch failed in this venv (%s): fix the environment first" % (",".join(fact["why"]) or "unknown"))
    say("venv python %s / torch %s / cuda %s / %s" % (fact["py"], fact["torch"], fact["cuda"] or "?", fact["sm"] or "?"))
    if fact["sm"] and fact["sm"] not in SAGE_SUPPORTED_SM:
        start_fail("ARCH", "%s not in the Sage kernel whitelist %s" % (fact["sm"], ",".join(SAGE_SUPPORTED_SM)))

    py_minor = int(sys.version_info[1])
    torch_parts = [int(x) for x in re.findall(r"\d+", fact["torch"].split("+")[0])[:3]]
    cuda_major = 0
    try:
        cuda_major = int(str(fact["cuda"]).split(".")[0])
    except Exception:  # noqa: BLE001
        cuda_major = 0

    # 1) triton-windows: without it `import sageattention` dies at import time on Windows.
    if have("triton"):
        say("triton already present")
    else:
        key = "%d.%d" % (torch_parts[0], torch_parts[1]) if len(torch_parts) >= 2 else ""
        spec = "triton-windows==" + TORCH_TRITON[key] + ".*" if TORCH_TRITON.get(key) else "triton-windows"
        code, out = run_pip([spec])
        if code != 0 and spec != "triton-windows":
            say("pinned %s failed, retrying latest" % spec)
            code, out = run_pip(["triton-windows"])
        if code != 0:
            start_fail("TRITON", "triton-windows install failed: " + pip_tail(out))
        if not have("triton"):
            start_fail("TRITON", "triton-windows installed but `import triton` still fails")

    # 2) sageattention: keep an already working install (idempotent re-run of the installer).
    if have("sageattention"):
        say("sageattention already importable - verifying it")
        code = subprocess.run([sys.executable, "-c", SMOKE_CODE], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        if code.returncode == 0 and "KERNEL_OK" in code.stdout.decode("utf-8", "replace"):
            print("[sage] SAGE-OK=1 already installed and verified", flush=True)
            return
        say("existing sageattention does not pass the kernel smoke run - reinstalling the matched wheel")

    wheel = str(os.environ.get("MT_H3_SAGE_WHEEL") or "").strip()
    if wheel and os.path.isfile(wheel):
        say("using local wheel " + wheel)
        picked_path = wheel
    else:
        url = str(os.environ.get("MT_H3_SAGE_WHEEL_URL") or "").strip()
        if not url:
            say("looking up a matching wheel on " + SAGE_RELEASES_PAGE)
            try:
                releases = fetch_json(SAGE_RELEASES_API)
            except Exception as e:  # noqa: BLE001
                start_fail(
                    "WHEEL",
                    "cannot read the SageAttention release list (%s): %s - set MT_H3_SAGE_WHEEL to a local .whl to install offline"
                    % (type(e).__name__, e),
                )
            picked = pick_wheel(releases, py_minor, torch_parts, cuda_major)
            if not picked:
                start_fail(
                    "WHEEL",
                    "no prebuilt wheel for python 3.%d / torch %s / cuda %s on %s"
                    % (py_minor, ".".join(str(x) for x in torch_parts) or "?", cuda_major or "?", SAGE_RELEASES_PAGE),
                )
            say("picked %s" % picked["file"])
            url = picked["url"]
        tmp_dir = os.path.join(os.environ.get("TEMP") or os.environ.get("TMP") or ".", "mtnode-h3-sage")
        os.makedirs(tmp_dir, exist_ok=True)
        name = str(url).split("?")[0].rstrip("/").split("/")[-1] or "sageattention-win_amd64.whl"
        picked_path = download(url, os.path.join(tmp_dir, name))

    code, out = run_pip(["--no-deps", "--force-reinstall", picked_path])
    if code != 0:
        start_fail("PIP", "sageattention install failed: " + pip_tail(out))

    # 3) verify: import pair, then really run one small kernel (import != compute).
    if not (have("triton") and have("sageattention")):
        start_fail("VERIFY", "installed but `import triton, sageattention` fails")
    say("running the kernel smoke test")
    smoke = subprocess.run([sys.executable, "-c", SMOKE_CODE], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    smoke_out = smoke.stdout.decode("utf-8", "replace")
    for line in smoke_out.splitlines():
        if line.strip():
            print("[sage] " + line.strip(), flush=True)
    if smoke.returncode != 0 or "KERNEL_OK" not in smoke_out:
        start_fail("SMOKE", "kernel smoke run failed: " + smoke_out.strip().replace("\n", " ")[-300:])

    print("[sage] SAGE-OK=1 sageattention + triton verified (%s)" % (fact["sm"] or "?"), flush=True)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001 - never leak a bare traceback into the step log
        start_fail("UNEXPECTED", "%s: %s" % (type(e).__name__, e))
