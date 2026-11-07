# Save

![diagram](img/save.svg)

One node infers the file type from whatever is wired in: text → `.md` (batch / aggregate entries still use `.yaml`), image → `.png`, audio (music gen) → `.wav`, video (video gen) → `.mp4`.

## Ports
- **In**: text / image / audio / video, inferred from the source; with no input wired the type is undecided and no suffix is guessed before saving.
- **Out**: 1 port = **the content saved this run** (a data port): a text save yields the body written last, an image / audio / video save yields the file written last, PDF export yields the written PDF path; before the first save it falls back to the upstream input, so you can wire it before pressing ▶. It can feed further nodes and be `@referenced` (text saves).

## Settings
- **File name** is edited right on the node card: it swaps only the last path segment, and the chip beside it shows the suffix that will be appended (`.md` / `.png` / `.wav` / `.mp4`); Enter / blur commits, Esc reverts.
- Edit them in the **settings window** opened by **⚙ Settings** in the node header:
  - **Save path**: relative to the workspace or absolute; the suffix is fixed by the input type and auto-corrected; inside a **node layer** with a subfolder, relative paths resolve under that subfolder.
  - **Auto-save on input change**: rewrite whenever the upstream output updates (on by default).
  - **Image output (size / crop / format / quality)**: appears only when saving an image; press "Image output settings…" to open the panel. Default is as-is + PNG.

## Usage
- Wire the upstream, set the save path, press ▶; **Browse / Reveal / Open** on the node are actions.
- Placing **music generation** or **video generation** auto-binds a save node on its right (fixed offset, pinned wire) and the generator writes its file name into it.

## Notes
- With an empty save path, ▶ only warns "Set a save path first (use "Browse" to choose)".
- The output path of an upstream generator (music / speech / video gen, video upscale / interpolation) may be left empty: wire its data output into this node and the file lands in the app-managed folder first, then this node writes it to its own save path; without this node the generator still needs its own path.
- **Quality** in the image-output panel is 0.1–1.0, lossy formats (JPG / WebP) only, and transparent areas become white; batch / multi-image saves apply the same settings to every file, while aggregate mode writes only the first image of the first entry.
- Save → save never cascades: the downstream save node still needs its own ▶. The card's text preview shows the first 20,000 characters only, and binary or 4 MB+ files get a one-line note instead.
