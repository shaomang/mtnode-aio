# Image input

![diagram](img/input_image.svg)

Hold local images as material and pass them to image-processing or save nodes.

## Ports
- **In**: 1 data port + one control port at the end; wiring upstream inherits that image read-only
- **Out**: 1 = image (a batch of images in batch mode)

## Settings
- No ⚙ settings window: picking an image and the batch toggle live on the node body / header.

## Usage
- Click **Choose image** or drop a picture onto the node (png / jpg / jpeg / webp / gif / bmp).
- Batch: click **Batch** in the header, then **+ Add image** for each one; switch back to a single image with the **S** button.
- Click the image to preview it large; **Clear** empties the slot.

## Notes
- Images are copied into workflow assets with the long edge scaled to 1080 or less; the original file is untouched.
- If the file is moved away, pick it again.
