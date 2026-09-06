# Image generate

![diagram](img/proc_image.svg)

Generate an image from a prompt. Accepts text or image input. Supports size, transparent background, and matching the first reference image's aspect ratio.

## Settings
**Provider / model / size** are edited in the settings window opened by **⚙ Settings** in the node header, and they apply immediately; the card itself keeps a one-line summary (provider / model / size). The header **◈** is the preview of the exact request that will be sent — a separate thing from the settings window. The prompt is content, so it stays in the node.

## Transparent background (two-pass difference matting)
The **transparent toggle** in the title bar (small checkerboard chip) is off by default.

- **Click** to toggle. When on, the icon disappears and the button becomes a **spinning rainbow edge**.
- Every run then generates **2 images** (pure-black baseline + pure-white replica): about **2× tokens** and wait — use with care.
- The pipeline (order is fixed; all of it happens internally — just write your prompt as usual):
  1. **Pass 1 (the baseline) · pure black**: the app appends "the background must be uniform pure black #000000" to the prompt and generates. This image is the **sole baseline** for the whole matte and the authority on the final foreground colour, so render the subject to finished quality;
  2. **Pass 2 · pure white**: it strips that block, appends a pure-white #FFFFFF block demanding a pixel-for-pixel identical replica apart from the background colour, and sends **pass 1 as the only reference image** — your own reference images are deliberately left out (two conflicting images in one edits call make the model repaint from your original, and pass 2 stops matching the baseline). That baseline is sent **at its native size, bypassing the normal 1080 reference downscale** (shrinking it and asking the model to blow it back up always drifts the subject), and the request size is pinned to the baseline's real pixels, so both passes are **the same width and height**;
  3. Alpha is solved per pixel as `α = (bgRange − white + black) / bgRange`, where `bgRange` is the background level **actually measured on the two images** (models usually deliver a fake 250/8 rather than a perfect 255/0 — hard-coding the ideal value fogs the whole picture); it is then refined by foreground-box alignment and edge feathering, un-premultiplied, and written out as a PNG with a real alpha channel.
- **Only providers that can receive the baseline as a reference image (OpenAI-compatible / Stability) get matted**; every other provider is **skipped explicitly** with a notice and pass 1 (pure black) alone is delivered — no second image is painted from scratch, because two independently generated images never line up and the difference step returns mid-range alpha wherever they disagree, which looks like full-frame ghosting.
- Unlike a chroma key, **white or black subjects survive**, and semi-transparent edges (hair, motion blur, glass) keep genuine alpha.
- **Right-click** the toggle for matte settings: noise floor, edge feather (smooths the alpha channel only), auto alignment fix (matches pass 2 to pass 1 by foreground box and edge agreement), plus "re-matte from the stored two passes" (tune the result without spending another token).
- If pass 2 fails, you still get the pass-1 (pure black background) image plus a warning — the run never breaks.
- The **◈ preview** shows the pass-1 (pure black · sole baseline) request and states that pass 2 will be auto-sent as a strict replica; for a provider that cannot be anchored it says up front that matting will be skipped.
- The preview gets a checkerboard backdrop while the toggle is on.

## Match the first reference's aspect ratio (ratio lock)
The **ratio lock toggle** in the title bar (a small solid tile inside a dashed frame) is off by default. **Click** to toggle, **right-click** for padding settings. It exists so the output lines up with the reference — the usual case for background swaps, material swaps and inpainting.

Each run then does three things automatically (write your prompt normally, no size maths needed):

1. **Copy and pad**: the **first reference image** is scaled proportionally (never stretched, never cropped), centred inside the target canvas and padded on all sides into a temporary copy; your reference file itself is never rewritten.
2. **Generate from that copy**: the request size is pinned to the target canvas, and a block is appended to the prompt explaining that the padded ring is free space to extend and that the subject must not move or rescale (wrapped in paired ASCII markers, so reruns never stack it up).
3. **Crop back after generation**: the same rectangle is cut out of the result, so the output aspect ratio equals the first reference's. If the provider returns a different resolution, the rectangle is mapped proportionally and still lands correctly.

Notes:

- **Requires at least one reference image**; with pure text-to-image it skips itself and says why instead of breaking the run.
- If the reference already matches a supported canvas, it neither pads nor crops — no extra files.
- **No extra generation cost** (unlike the two-pass transparent background): one extra local read/write only.
- Right-click settings: target canvas (**auto** = the size closest to the reference ratio / **follow the node's Size**), padding fill (edge stretch / mirror / pure white / pure black / custom colour), and "**restore the reference's original pixel size on output**" (off by default: keeps the generated resolution, guarantees the ratio).
- Combines with **transparent background**: matting happens on the padded canvas first, the crop is applied last.
- If cropping fails, you still get the uncropped full image plus a warning — a paid generation is never thrown away.
- The **◈ preview** states which canvas it pads to and which rectangle it crops back to, so you can check before sending.

## Ports
- **In**: text or image
- **Out**: image
