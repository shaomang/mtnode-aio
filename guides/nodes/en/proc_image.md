# Image generate

![diagram](img/proc_image.svg)

Generate an image from a prompt; text or image input. Three title-bar toggles add mask inpainting, transparent background, and matching the first reference image's aspect ratio (ratio lock).

## Ports
- **In**: text or image (with several images, the first one is the basis for the mask and ratio lock)
- **Out**: image

## Settings
Change these in the settings window opened by **⚙ Settings** in the node header; they apply immediately. The card keeps a one-line summary, and the header **◈** previews the exact request that will be sent.

- **Provider / model**: any provider and model configured on this machine.
- **Size**: `auto` or 30 tiers.
- **Quality / background**: neither is sent by default (the provider uses auto); see the next section for allowed values.

## Quality / Background
- **Quality**: not sent by default; `auto` / `low` / `medium` / `high` / `xhigh` / `max` only — legacy DALL·E `standard` / `hd` either 400 or are silently billed as auto.
- **Background**: not sent by default; `auto` / `opaque` / `transparent`. `transparent` makes the API return an alpha PNG directly (forces png), appends a "truly transparent background" requirement to the prompt, and disables the difference-matting button.

## Mask inpainting
Click the mask button in the title bar to toggle (the first enable opens the editor), right-click to edit again. Transparent green = the model may repaint; the rest is kept.

- An image input is required (the first one is the mask background); the mask applies to image 1 only and must match its size.
- **The output follows the first reference image's pixel size**: the request `size` is pinned to image 1's pixels, so the node's own Size is ignored this run; turn the mask off to change the canvas.
- The provider must be OpenAI-compatible (`/images/edits`); others fail with an error. With ratio lock also on, the mask wins and padding is skipped.
- A mask is guided editing, not a hard cut: shadows and light outside it can shift, so paint slightly beyond the object's edge.

## Usage
- **Transparent background (two-pass difference matting)**: click the checkerboard toggle. Each run generates 2 images (pure-black baseline + pure-white replica), about 2× tokens and time. Right-click for noise floor / edge feather / auto alignment, or re-matte from the stored two passes. Only providers that can receive the baseline as a reference (OpenAI-compatible / Stability) get matted; others skip it and deliver pass 1 only.
- **Ratio lock**: click the dashed-frame toggle. The first reference image is scaled proportionally, centred and padded, generated at the target canvas, then the same rectangle is cropped back so the aspect ratio equals the first reference's. Needs at least one reference image (pure text-to-image skips it), and costs no extra generation. Right-click for target canvas (auto / follow the node's Size), padding fill (edge stretch / mirror / pure white / pure black / custom colour), and restore the reference's original pixels (off by default).

## Notes
- Background `transparent` and difference matting exclude each other: the former switches the latter off and greys its button out.
- If cropping fails you still get the uncropped image; if pass 2 fails you still get pass 1 — a paid generation is never thrown away.
