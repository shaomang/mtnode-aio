# Image editing & masks

> In one sentence: make a local change to an existing image — paint the region to repaint and let the model change only that part, while the remaining pixels stay unchanged during generation.

![Base image → paint a mask → local repaint → save](img/mtnode-edit-02-ui.svg)

*Figure: paint the repaint region (transparent = repaint); write in the prompt only what should appear in that region.*

## Image editing (mask) · Node description

### What image editing (mask) is

Besides repainting the whole picture, an image generation node can change just a small part when the model allows mask editing: paint the region to repaint (the mask) on the node, and the remaining pixels will be kept unchanged during generation. Not every model supports this, but even when it does not, MTNode pins down what lies outside the mask, which may still get you the result you need.

### How to use it

1. Wire one image upstream (an input node / an asset / the previous generation result).
2. Turn on the "Mask" switch on the node.
3. Paint the region to repaint in the mask editor in the node header (transparent area = repaint area) — the mask must be painted by hand; no AI can paint it for you.
4. Write in the prompt only "what this region should contain"; do not describe the whole picture again.
5. Size: with a mask on, the requested size is pinned to the pixel size of the first reference image, and the size selected on the node does not apply this round.
6. It applies to the first reference image only; keep the size consistent with the size the model works with.
7. The model does not always follow the mask, so MTNode applies a post-process that forces pixels outside the mask to stay unchanged.

## Image editing (mask) · Steps

### Typical scenarios

- Replace part of it: swap a garment; erase clutter in the background and replace it with a wall.
- Add one element: put a cup of coffee on the desk, add a line of text to a signboard.
- Fix defects: remove an extra finger, a reflection or a watermark.

### Prompt template

Describe the repaint region only, for example "a beige knitted cardigan, laid flat face up, soft even lighting"; do not write "the whole image is…".

### The neighbouring feature: transparent background

If the model supports it, you can turn on "Background – transparent" in the model selection area (GPT-Image-2.5 supports a transparent background, for example). Otherwise, turn on the "Transparent background" switch and use the difference algorithm to generate (it costs 2× the tokens).
