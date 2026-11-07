# File node (upload any file)

Right-click an empty spot on the canvas → "Input nodes" → "File node". The node has a single **Upload file** button: pick a file and it turns in place into the matching input node.

## Ports
- **In**: none before upload; none in the path-only state; after conversion it follows the target kind
- **Out**: none before upload; 1 (that local file path) in the path-only state; after conversion 1 content port — or 2 for audio / video (URL + transcript)

## Settings
- No ⚙ settings window: convert with the **Text / Image / Audio / Video** mini buttons in the header, or right-click → **Convert to input node**.

## Usage
- Click **Upload file** (the dialog defaults to "All files (\*.\*)").
- Images → Image node (copied into assets at the original size); text and code → Text node; PDF → Text node (body is parsed Markdown); audio / video → Audio / Video node (outputs a `file:///` URL).
- Files that cannot be parsed (archives / Office / executables / binaries) keep only their path; downstream gets that path and can use it to call a tool.

## Notes
- There is no way back to a file node after conversion (Ctrl+Z still undoes the step).
- A text-suffixed file whose content is binary or not UTF-8 also stays path-only instead of putting mojibake into a text body.
- An unrecognised file larger than 1 MB is not read in full — it goes straight to path-only.
