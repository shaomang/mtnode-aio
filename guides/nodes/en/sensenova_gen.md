# SenseNova image generation (local text-to-image / image editing)

![diagram](img/sensenova_gen.svg)

Right-click the canvas → **Process › Image generation › SenseNova**. Local SenseNova-U1.5-8B-MoT backend (the “SenseNova Local Image Generation” plugin, ported after the open-source [OpenSenseNova/SenseNova-U1](https://github.com/OpenSenseNova/SenseNova-U1) project). **Each run produces exactly one image** (`.png`); the result lands in the app asset directory automatically and is handed downstream on the node's output port (port 0, image), so you can wire `save_image` / preview directly — no path to fill in. A leftover `outputPath` on an old canvas is ignored.

It differs from the cloud **Text-to-image (cloud provider)** node (`proc_image`) in exactly three ways: it **runs on your machine** (offline, prompts are never uploaded, no per-image billing), the **resolution can only be one of the 11 official training buckets** (not arbitrary width/height), and it **needs an NVIDIA card**. Its ports and its output shape (`{kind:"image", path}`) are identical to `proc_image`, so image preview / `save_image` / `@` references downstream need no changes at all.

## Ports
- **Input**: port 0 = prompt text · port 1+ = incremental data slots (text / **image references**) · control input
- **Output**: port 0 = image (preview / save downstream) · port 1 = control output

When port 0 is not wired, the node reads the prompt typed on the node itself. **Wiring in an image (an image node on a data slot, or an image picked up through `@` references / global broadcast) automatically switches the run to image-editing mode**: those images are sent to the local backend as reference images and condition the result through `it2i_generate` (restyle, local edits, follow the reference composition). Reference images that cannot be read are reported one by one in the node status and warnings — never dropped silently; if none can be read, the run falls back to plain text-to-image.

## Options
Click **⚙ Settings** in the node header to open the settings window; changes apply immediately and the card itself keeps showing just a one-line summary.

- **Resolution bucket (official training size)**: only the **11 official training buckets** exist — `1:1` = 2048×2048, `16:9` = 2720×1536, `3:2` = 2496×1664, `4:3` = 2368×1760, `2:3` = 1664×2496, `3:4` = 1760×2368, `1:2` = 1440×2880, `2:1` = 2880×1440, `1:3` = 1152×3456, `3:1` = 3456×1152 (up to native 4K); picking a bucket fixes width/height, arbitrary sizes are not offered
- **Sampling steps**: `1–200`, node default 30 (official default 50); **this is the main lever for time and VRAM** — drop below 20 for a quick test
- **CFG Scale**: prompt adherence, official default 4.0; higher sticks closer to the prompt and oversaturates more easily
- **CFG Norm**: `none` (default) / `global` / `channel` / `cfg_zero_star`
- **Timestep Shift**: noise-schedule shift, official default 3.0
- **Reference image strength**: only applies in image-editing mode (a reference image is wired) and maps to the backend's `img_cfg_scale`; `1.0` = image CFG off (official default), raise to `1.5–2.0` to follow the reference image more closely; the value is not sent when there is no reference image
- **Attempts**: gacha rolls (1–10), one image per roll, named `#1`, `#2` …
- **Seed**: a fixed seed reproduces; with **reroll** on, each roll bumps the seed by +1
- **VRAM tier**: `fast` (default, the official 24G-card tier) / `balanced` / `low` / `full` (needs 48G+); on OOM the backend **automatically drops one tier and retries once**, and reports it on the node's status line
- **Weight dtype**: `bfloat16` (default) / `float16` / `float32`
- **think mode**: the model first writes a planning text and then the image; the planning text is saved next to the image as `.think.txt`

## Notes
- **No install, no image**: until the plugin is installed the node shows a “plugin not installed” bar and ▶ aborts with an install entry point instead of degrading silently. Install it in **Plugins › SenseNova Local Image Generation** (the console installs, starts/stops, test-generates and shows logs; its resolution dropdown and defaults all come from the backend's `/health`, never a second copy).
- **Hardware**: an NVIDIA GPU is required, and **24G VRAM is the official tier** (the bf16 weights are ~**32.66GB** and run on one 24G card thanks to layered offload); 20G is marginal, below 20G is refused. RAM should be **≥40GB** (32GB is the hard gate — offloaded weights live in host memory) and you should **reserve ≥60GB of disk**.
- Only **1 audio/video task** is allowed globally at a time (music / speech / video / image generation are mutually exclusive); other tasks queue. On a 24G card this is the same fight over VRAM as H3 / Music3 — **do not run them in parallel**.
- **A very slow first generation is normal**: lazy weight loading plus layered offload loads in ~30s (measured 28–32s here), and the **cold first image is noticeably slower** (first entry into the offload context, pinned host cache, cudnn warm-up); progress can sit at “sampling 15%” for a while — watch whether **“sampling N/M steps”** is advancing, not just the percentage, and never force-kill it.
- **Reference timings / VRAM** (4090, bf16, `sdpa`): 2048×2048 / 4 steps / `fast` = **~63s for the first image → ~24s for the second**, peak **15.9GiB**; 2048×2048 / 12 steps + think ≈ **6.5 min**, peak 16.0GiB; the `low` tier peaks at only ~**3GiB** but is ~2.4× slower. **The second image onwards being faster is expected** (the model stays resident — no need to restart the backend).
- **Lowering the resolution does not save VRAM**: the smallest bucket is already 2048×2048 (~4M pixels), so the only levers are fewer sampling steps or a lower VRAM tier.
- There is no `flash-attn` wheel on Windows, so attention defaults to `sdpa`; a `USE_FLASH_ATTENTION` error means the attention tier was set wrong — **do not install flash-attn to fix it**.
- **Backend errors pop a dialog**: when that install or the running backend breaks, the main window shows an **error report** (error code, error body, console log tail, the node that failed) and offers **🤖 Auto-repair** — a visible session that works in the `sensenova-local-install` skill's self-repair mode inside this plugin's **INSTALL_DIR** and, on success, **restarts the SenseNova backend** and refreshes this node's status. Cancelled-by-you / busy / out of disk / no NVIDIA GPU / driver too old / invalid install directory get the report only, never an auto-repair (see “Plugin error dialogs and auto-repair” in the manual).
- For backend details (port / endpoints / error codes / environment variables) see `docs/sensenova-local-backend.md`.
