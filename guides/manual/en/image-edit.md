# Image editing & masks

When an AI image is 90% right and only one detail needs fixing — an awkward hand, a stray passerby, or a different jacket — use **mask inpainting** to redraw just that spot instead of starting over.

![Local repaint with a mask](img/mtnode-edit-02-ui.svg)

## Step by step

1. **Connect the original image**: Place your image in an Image input node and wire it to the first image port of an Image generation node.
2. **Paint the mask**: Open **Edit mask** on the node and brush over the exact area you want replaced (the masked/transparent area is what AI will redraw).
3. **Describe only the change**: In the prompt, write only what should appear inside the masked area — for example, "a sleeping orange tabby cat" or "clean grass and stone path matching the surroundings."
4. **Generate & save**: Click **▶**, then wire the result to a Save node.

## Tips for clean results

- **Don't re-describe the whole picture**: Focus your prompt on the masked area and how it blends with its neighbors.
- **Leave a slight margin**: Paint slightly beyond the object's edge so lighting and shadows blend naturally.
- **Outside pixels stay untouched**: When a mask is attached, MTNode locks the output resolution to your original image and preserves pixels outside the mask — even if the model tries to drift.
- **Masks are painted by hand**: The assistant can't draw masks for you, and brushing the spot yourself takes only a few seconds.
