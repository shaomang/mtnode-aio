# File node (upload any file)

Right-click an empty spot on the canvas → "Input nodes" → "File node". A fresh node of this
kind holds exactly one control: an **Upload a file** button. Pick a file and the node turns
itself, in place, into the input node that matches the file type — you no longer have to
decide up front "which input node does this file belong to".

- Images (png / jpg / webp / gif …) → **Image node** (the picture is copied into workflow
  assets **at its original size**: pixel dimensions and encoding untouched, so the size note
  in the node's corner shows the file's real width × height)
- Text and code (txt / md / json / yaml / csv / js / py …) → **Text node** (the body is read in)
- PDF → **Text node** (through the PDF parsing pipeline, the body is Markdown)
- Audio (mp3 / wav / m4a …) → **Audio node** (outputs the file's `file:///` URL)
- Video (mp4 / mov / webm …) → **Video node** (same)
- **Files that cannot be parsed** (archives / Office / executables / extension-less binaries…) →
  **only the file path is kept**: nothing is read as text and no text node is created; the node
  holds that absolute local path and its single output port delivers exactly that path.

The file dialog's default type is **All files (\*.\*)**: any extension is selectable, and the
rules above decide what happens after you pick.

You can also skip uploading and pick the type manually: click the **Text / Image / Audio /
Video** mini button on the node's header bar, or right-click the node → "Convert to input
node" — both entries use the same target list.

## Three things to know

1. **No way back.** Once converted it is an ordinary text / image / audio / video node —
   there is no "turn back into a file node" entry anywhere (Ctrl+Z still undoes the step).
2. **It cannot be wired before you upload.** With no content there are no ports; the ports
   appear once it becomes a concrete input node. In the **path-only** state it has one output
   port (value = that path).
3. **Path-only means downstream gets the path — nothing else**: wiring it or referencing it
   with `@File node` injects that absolute local path (the file body is never read), so the
   downstream agent can call a tool / read the file from it — that is the intended use.
   A text-suffixed file whose content is actually binary (or not UTF-8) also stays path-only
   instead of putting mojibake into a text body.

## Compatibility

All four input node kinds (text / image / audio / video) are fully kept: old canvases still
open, run and wire exactly as before, and dropping files onto an empty canvas still creates
the matching node directly. Only the right-click menu collapsed four entries into one.

## Ports

- **Before uploading**: no inputs, no outputs (there is no content yet)
- **Path-only**: no inputs, **one output** (value = that absolute local file path; downstream
  can wire it or reference it)
- **After converting**: depends on the target kind — text / image / audio / video nodes each
  expose one content output port
