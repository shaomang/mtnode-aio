# Image generate

![diagram](img/proc_image.svg)

Generate an image from a prompt. Accepts text or image input. Supports size and transparent background.

## Transparent background (two-pass difference matting)
The **transparent toggle** in the title bar (small checkerboard chip) is off by default.

- **Click** to toggle. When on, the icon disappears and the button becomes a **spinning rainbow edge**.
- Every run then generates **2 images** (white + black pass): about **2× tokens** and wait — use with care.
- How it works (fully internal — just write your prompt as usual):
  1. Pass 1: the app appends "the background must be uniform pure white #FFFFFF" to the prompt and generates;
  2. Pass 2: it strips that block, appends "the background must be uniform pure black #000000" and sends a second request; OpenAI-compatible image APIs also receive pass 1 as a **reference image** with a pixel-identical instruction, which is what keeps the two passes **perfectly aligned**;
  3. Alpha is solved per pixel as `α = (255 − white + black) / 255`, refined by foreground-box alignment, then un-premultiplied and written out as a PNG with a real alpha channel.
- Unlike a chroma key, **white or black subjects survive**, and semi-transparent edges (hair, motion blur, glass) keep genuine alpha.
- **Right-click** the toggle for matte settings: noise floor, edge feather, auto alignment, plus "re-matte from the stored two passes" (tune the result without spending another token).
- If pass 2 fails, you still get the white-background image plus a warning — the run never breaks.
- The preview gets a checkerboard backdrop while the toggle is on.

## Ports
- **In**: text or image
- **Out**: image
