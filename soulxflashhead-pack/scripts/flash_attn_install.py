#!/usr/bin/env python
"""Install flash-attn 2 into the SoulX-FlashHead venv (MANDATORY for this plugin).

Why this script exists: SoulX-FlashHead's attention layer prefers FlashAttention 3, then
FlashAttention 2, then SageAttention, then PyTorch SDPA. The user consensus for this plugin is
"flash-attn must be installed, otherwise the install fails", and the real-time promise depends
on it, so this step has to pick a wheel that actually matches this venv.

Windows reality: PyPI / the upstream project ship no Windows wheel. The community builds
(kingbri1/flash-attention) publish wheels whose file name encodes cu + torch + python:

    flash_attn-2.8.3+cu128torch2.8.0cxx11abiFALSE-cp311-cp311-win_amd64.whl

so the wheel MUST match this venv's torch version exactly. Order of attempts:
  1. local wheel from MT_FLASHHEAD_FLASH_ATTN_WHEEL (offline escape hatch)
  2. direct URL from MT_FLASHHEAD_FLASH_ATTN_WHEEL_URL
  3. release assets from kingbri1/flash-attention matched to this venv (github + gh proxies)
  4. source build: pip install flash_attn==<ver> --no-build-isolation (needs nvcc + VS tools)

Output contract (parsed by scripts/install.ps1 -> steps.json):
  success : exit 0, last meaningful line "FLASHATTN-OK=1 ..."
  failure : exit 1, "FLASHATTN-<KIND>=<detail>" + "FAILED ..."

Pure ASCII on purpose (shipped inside the install pack).
"""

import glob
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.request

API = "https://api.github.com/repos/kingbri1/flash-attention/releases?per_page=10"
PROXIES = ["", "https://ghfast.top/", "https://gh-proxy.com/"]
FA_VERSION = "2.8.3"


def pip(*args):
    print("[pip] " + " ".join(args), flush=True)
    r = subprocess.run([sys.executable, "-m", "pip"] + list(args), stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    out = (r.stdout or b"").decode("utf-8", "ignore")
    for line in out.splitlines()[-12:]:
        print("  " + line, flush=True)
    return r.returncode


def py_run(code):
    r = subprocess.run([sys.executable, "-c", code], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    return r.returncode, ((r.stdout or b"").decode("utf-8", "ignore") or "").strip()


def fetch(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": "MTNode-flashhead-installer"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def torch_info():
    code = "import torch,sys;print(torch.__version__.split('+')[0]);print(torch.version.cuda or '')"
    rc, out = py_run(code)
    if rc != 0:
        return "", "", ""
    lines = out.splitlines()
    return lines[0].strip(), (lines[1].strip() if len(lines) > 1 else ""), "cp%d%d" % sys.version_info[:2]


def find_assets(torch_ver, py_tag):
    """Return candidate asset URLs for this torch version + python tag, best first.

    A release carries several wheels for the same torch (cp310/cp311/cp312 and
    cxx11abiTRUE/FALSE). Only the file that matches BOTH this venv's torch and its
    python tag can be installed, so filter here instead of letting pip reject each
    candidate one by one.
    """
    matches = []
    for proxy in PROXIES[:1] + PROXIES[1:2]:
        try:
            data = json.loads(fetch(proxy + API).decode("utf-8"))
        except Exception as exc:
            print("release api failed via %s: %s" % (proxy or "github", str(exc)[:120]), flush=True)
            continue
        for rel in data:
            for asset in rel.get("assets") or []:
                name = asset.get("name") or ""
                if not name.startswith("flash_attn-") or not name.endswith("-win_amd64.whl"):
                    continue
                if torch_ver and ("torch%s" % torch_ver) not in name:
                    continue
                if py_tag and ("-%s-%s-" % (py_tag, py_tag)) not in name:
                    continue
                matches.append((rel.get("tag_name") or "", name, asset.get("browser_download_url") or ""))
        if matches:
            break
    # cxx11abiFALSE is what the official torch wheels use; TRUE needs a different MSVC ABI
    matches.sort(key=lambda m: 0 if "cxx11abiFALSE" in m[1] else 1)
    return matches


def try_wheel(name, url):
    dest = os.path.join(tempfile.gettempdir(), name)
    for proxy in PROXIES:
        try:
            print("downloading %s%s" % (proxy or "", url), flush=True)
            data = fetch(proxy + url if proxy else url, timeout=600)
            if len(data) < 5_000_000:
                print("  too small (%d bytes), trying next mirror" % len(data), flush=True)
                continue
            with open(dest, "wb") as fh:
                fh.write(data)
            break
        except Exception as exc:
            print("  download failed: %s" % str(exc)[:160], flush=True)
    if not os.path.exists(dest) or os.path.getsize(dest) < 5_000_000:
        return False
    print("installing %s" % dest, flush=True)
    return pip("install", "--no-deps", "--force-reinstall", dest) == 0


def kernel_smoke():
    code = (
        "import torch\n"
        "from flash_attn import flash_attn_func\n"
        "q=torch.randn(1,64,8,64,device='cuda',dtype=torch.float16)\n"
        "k=torch.randn_like(q); v=torch.randn_like(q)\n"
        "o=flash_attn_func(q,k,v)\n"
        "torch.cuda.synchronize()\n"
        "import flash_attn\n"
        "print('FAOK', flash_attn.__version__, tuple(o.shape))\n"
    )
    rc, out = py_run(code)
    return rc == 0 and "FAOK" in out, out


def main():
    torch_ver, cuda_ver, tag = torch_info()
    if not torch_ver:
        print("FLASHATTN-FAIL=no torch in this venv", flush=True)
        return 1
    print("venv torch=%s cuda=%s python=%s" % (torch_ver, cuda_ver, tag), flush=True)

    # Re-run fast path: a previous install already put a working wheel here, so do not pull
    # another 1.5GB just to reach the same state (the kernel smoke is the real check).
    try:
        import flash_attn  # noqa: F401

        good, out = kernel_smoke()
        print(out, flush=True)
        if good:
            print("FLASHATTN-OK=1 already installed and kernel ran", flush=True)
            return 0
        print("FLASHATTN-SMOKE=installed copy cannot run its kernel; reinstalling", flush=True)
    except Exception:
        pass

    local = os.environ.get("MT_FLASHHEAD_FLASH_ATTN_WHEEL", "").strip()
    if local:
        ok = pip("install", "--no-deps", "--force-reinstall", local) == 0
    else:
        direct = os.environ.get("MT_FLASHHEAD_FLASH_ATTN_WHEEL_URL", "").strip()
        ok = False
        if direct:
            name = os.path.basename(direct.split("?")[0]) or "flash_attn.whl"
            ok = try_wheel(name, direct)
        if not ok:
            for tag_name, name, url in find_assets(torch_ver, tag):
                print("candidate %s (%s)" % (name, tag_name), flush=True)
                if try_wheel(name, url):
                    ok = True
                    break
    if ok:
        good, out = kernel_smoke()
        print(out, flush=True)
        if good:
            print("FLASHATTN-OK=1 wheel installed and kernel ran", flush=True)
            return 0
        print("FLASHATTN-SMOKE=installed but kernel run failed", flush=True)
    # last resort: build from source (needs nvcc + MSVC build tools)
    print("falling back to source build flash_attn==%s" % FA_VERSION, flush=True)
    if pip("install", "--no-build-isolation", "flash_attn==%s" % FA_VERSION) == 0:
        good, out = kernel_smoke()
        print(out, flush=True)
        if good:
            print("FLASHATTN-OK=1 built from source and kernel ran", flush=True)
            return 0
        print("FLASHATTN-SMOKE=source build kernel run failed", flush=True)
    else:
        print("FLASHATTN-WHEEL=no matching wheel and source build failed", flush=True)
    print("FAILED flash-attn install", flush=True)
    return 1


if __name__ == "__main__":
    sys.exit(main())
