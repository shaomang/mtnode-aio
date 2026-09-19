# Minimax H3 (video generation)

![diagram](img/video_gen.svg)

Right-click the canvas → **Process › Video generation › Minimax H3**. Local MiniMax H3 backend (ComfyUI). **Each run produces exactly one video file** (`.mp4`) written to the node's own `outputPath` — no separate save node needed.

## Ports
- **Input**: **port 0 = control input (pinned as the first terminal, same shape as video upscale / interpolation / Remotion)** · **port 1 = prompt** · **R2V** mode: ports 2–10 = reference images I1–I9, ports 11–13 = reference videos V1–V3, ports 14–16 = reference audios A1–A3 (all three groups exposed at once) · **FL2VA** mode: ports 2–3 = first frame F / last frame L · with **segment chaining** on, one more **↩ previous segment video** port is added (FL2VA = port 4 · R2V = port 17, see the section below). Data port numbers are **identical to the "terminal N" numbers** shown in the panel / docs (data slot numbers), matching the backend `ref_image_0..8` / `ref_video_0..2` / `ref_audio_0..2`; a data wire on port 0 is rejected — that one is the control switch
- **Output**: port 0 = video (preview downstream) · port 1 = control output

## Options
Click **⚙ Settings** in the node header to open the settings window; changes apply immediately and the card itself keeps showing just a one-line summary.

- **Output path**: `.mp4` destination (relative to workspace / super subfolder)
- **Mode**: `fl2va` = first/last frame (default); `r2v` = multiple references (images / videos / audio)
- **Duration**: 4–15 s (default 5)
- **Resolution**: auto (proportional) / 480p / 720p / 1080p (auto-downscaled when VRAM is low)
- **Post**: this node **no longer** runs upscale / interpolation — add a **Video upscale** / **Video interpolation** node and run it separately
- **Attempts**: gacha rolls (1–10)

## Segment chaining (seamless long video)

H3 generates at most **15 s** per run; longer cuts are made by generating segments and chaining them. In the settings window's **Generate** section, turn on **segment chaining** (available in **both** built-in modes — `fl2va` and `r2v`; off by default; **not offered in custom ComfyUI workflow mode**, where the ports come from your graph).

- Once enabled the node gains an **↩ previous segment video** input (the control input stays pinned at port 0): wire the **previous segment's clip** in and this segment chains onto it automatically.
- **Guide frames** (1–60 · default 22): takes the **last N frames** of the previous segment as the inter-segment guide, locking composition, character placement and scene continuity.
- **Redraw strength** (0–1 · default 1): `0.3–0.6` is the recommended "**guide + redraw**" range — it anchors the composition while redrawing the guided region, resetting the frame and preventing cracked backgrounds / off-saturation characters as segments pile up. `0` = pure guide (use last frames only, no redraw); `1` = no guided redraw, reuse the internal denoise.
- **`fl2va` (first/last frame)**: the ↩ port sits right after the first / last frame (**data slot 4 · port 4**). With no first-frame input, the previous segment's last frame doubles as the first frame (composition anchor); **if the first-frame port is wired, your frame wins**.
- **`r2v` (multiple references)**: this mode has **no `first_frame` input**, so the anchor can only be **one reference-video slot** — the last N frames of the previous segment become a `<Video N>` reference (the official spec's `<Video N>` already means *video continuation* / continuation starting point).
  - The ↩ port comes **after all three reference groups** (images / videos / audios) → **data slot 17 · port 17**; it never steals I1–I9, V1–V3 or A1–A3.
  - The **3-reference-video cap stays 3**: with free slots the chain guide takes the next one (V1→V2→V3); when all three are wired it **replaces V3** (`ref_video_2`) — your own clip for that slot is not fed into this segment. The node status line shows **which slot it took** (`↩ chain 22 frames · redraw 0.4 · uses reference video V3`) and the H3 console spells out the replacement; nothing is dropped silently.
  - **Auto continuation note** (on by default): the prompt sent to the backend gets `Continue seamlessly from <Video N> as the starting point; keep subjects, scene and camera continuity.` appended, telling the model that this reference video is where the previous segment ended. Turn it off if you already wrote such a request.
  - The chain slot feeds **frames only, no audio track** (an N-frame window paired with a full-length audio track would desynchronise).
- Prompt continuity: keep character appearance and scene wording **identical across segments** (even more important in `r2v`, otherwise the character drifts); the action must pick up where the previous segment ended; cut between segments if you want a new shot, keep the camera wording continuous for one-take shots.
- Workflow: generate segment 1 normally → from segment 2 on, wire the previous output into the **↩** port → repeat to the target length → stitch in order in your editor and check the joints. A missing chain file is only logged and skipped — it never blocks this segment.

## Custom ComfyUI workflow (optional)

By default the node runs the built-in H3 chain (first/last frame or multi-reference). To run **a graph you built yourself**: click **⚙ Settings** in the node header → set **Workflow source** to **Custom ComfyUI workflow**.

- **Library**: workflows live in a machine-wide library (`<data dir>/h3-workflows/`), imported in the **H3 manager window · custom workflow library** (drop a JSON file / paste JSON). Both the ComfyUI **API format** and the **UI format** are detected (UI graphs are converted, front-end-only nodes such as Reroute / Note / primitives are dropped). The **Manage** button opens that window.
- **Open**: every library entry carries an **Open** action — it edits *that one workflow* inside an **embedded ComfyUI editor** (if the backend is down it asks before starting it). This only hands the graph out for editing and **never overwrites the library entry** — getting your edits back into the library (and onto the canvas) still has exactly one route: ComfyUI's **Export (API)** → **Import JSON** in the manager window.
- **Ports**: every field you promote to a node parameter takes one data terminal — **terminal 1 = text · terminal 2+ = media (image / video / audio)** (in v5 the port number equals the terminal number; **port 0 stays the control input**), in parameter-table order (▲▼ reorders), all listed in the settings window. The initial table comes from the graph scan (prompt / LoadImage / seed…) and is fully editable.
- **Manual values**: each parameter also accepts a literal value in the settings window; **a wired port wins over the manual value**, and if neither is given the value stored in the workflow JSON is kept. Media values are absolute local paths, uploaded to ComfyUI at run time.
- **Output node**: when the graph has several `Save*` nodes, pick which artifact this node returns (blank = last video output).
- **Refresh & validation**: ↻ re-syncs the parameter table with the stored graph (targets that vanished are flagged, never silently deleted); **Validate nodes** diffs node classes against the backend `/object_info` (skipped while the backend is down — it never blocks generation).
- The node's **Seed / Reroll** control drives seeding: one run writes that seed into **every** `seed` / `noise_seed`-style field in the graph.
- In custom mode the built-in **duration / resolution / sampler** options no longer apply — the graph decides them and the settings window stops showing them; no 24G clamping happens either. Rolls, progress, cancel, output path and the global media lock stay as they are.

## Notes
- Only **1 audio/video task** is allowed globally at a time (music and video are mutually exclusive).
- **This node outputs the native clip only**: upscale / interpolation are separate nodes (Process › Video generation › Video upscale / Video interpolation); run them on demand, or chain **H3 → Video upscale → Video interpolation**.
- 24G VRAM caps the resolution tiers; upscale / interpolation VRAM guidance lives in their own node guides.
- Reference images / audio / video can come straight from an **image / audio / video input** node: media ports carry a `file:///…` URL and this node normalizes it back to a local path.
- **Sage Attention** (optional speed tier, about 1.5–2×) needs `triton-windows` *and* a prebuilt `sageattention` wheel matching this venv — one without the other counts as missing. **Nothing breaks when they are absent**: the plugin probes the venv before every run and simply leaves the Sage node out (just slower). Probe and install are one click in the **H3 plugin window → the `Sage 加速` button** (it picks the wheel for your Python / torch / CUDA and re-verifies right after).
- **Backend errors pop a dialog**: H3 installs a local environment, so when that install or the running backend breaks, the main window shows an **error report** (error code, error body, console log tail, the node that failed) and offers **🤖 Auto-repair** — one visible session that works in the `minimax-h3-install` skill's self-repair mode inside this plugin's **INSTALL_DIR** and, on success, **restarts the H3 backend** and refreshes this node's status. Cancelled-by-you / busy / out of disk / no NVIDIA GPU / driver too old / invalid install directory get the report only, never an auto-repair (see "Plugin error dialogs and auto-repair" in the manual).
- **Not failures — don't have them "fixed"**: the long side clamped to ≤1280 (the 24G safety line), no 4K / no interpolation after generating (post-processing is separate nodes now), `--cpu-vae` off by default (turning it on always crashes VideoVAE decode with a dtype error), and EasyCache clamped to 0.08 / 0.30 / 0.90.
