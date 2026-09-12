# Save

![diagram](img/save.svg)

One save node infers type from its input (legacy save_text / save_image upgrade on load):

- **text** → `.yaml`
- **image** → `.png`
- **audio** (music gen) → `.wav`
- **video** (video gen) → `.mp4`

Paths are relative to the workspace or absolute. Inside a **super** with a subfolder, relative paths resolve under that subfolder (see [Super nodes](#super-nodes)). Auto-save is optional. Previews differ by media (text / thumbnail / audio / video).

Placing music or video gen also creates a bound save node on the right (fixed offset, pinned wire). The gen node writes its filename into that save node.

## Settings
**The file name** is edited right on the node card: a "File name" field with a read-only chip beside it showing the suffix that will be appended (`.md` / `.png` / `.wav` / `.mp4`). The name carries **no extension by default**; the extension is only decided once the input content type is known (an input is wired, or you typed a recognizable suffix yourself) — until then the chip reads "suffix pending" and nothing is guessed before saving. Renaming only swaps the last path segment and keeps the folder; Enter / blur commits, Esc reverts.

**The save folder and auto-save** are still edited in the settings window opened by **⚙ Settings** in the node header (that window also takes a full path), and they apply immediately; the card keeps another one-line summary (the path it really resolves to + auto-save on / off). Browse / Reveal / Open stay on the node — those are actions, not settings.

## Image output (only when saving an image)
A save node copies images **as-is** by default (suffix follows the save path, normally `.png`). To reshape the image in the same step, click the **image output** button in the node header (or "Image output settings…" in the ⚙ window):

- **Size**: as-is / scale by ratio (proportional resample up or down, aspect kept) / custom pixel width and height (one side is enough)
- **Crop**: none / crop center (largest centered rect matching the target ratio) / custom rect (x / y / width / height in source pixels, clamped inside the image)
- **Format**: `.png` (lossless, keeps transparency) / `.jpg` / `.jpeg` / `.webp` (lossy, smaller) / `.bmp`; picking a format also switches the save path suffix
- **Quality**: 0.1–1.0, lossy formats only (JPG / WebP); transparent areas become white in those formats

"Preview" really encodes one frame with the current settings (the line below reports output size / format / quality / crop source size). "Reset default" goes back to as-is + PNG. Batch / multi-image saves apply the same settings to every file; aggregate mode still writes only the first image of the first entry.

## Ports
- **In**: text / image / audio / video
- **Out**: none
