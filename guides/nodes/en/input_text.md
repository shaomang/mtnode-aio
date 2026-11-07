# Text input

![diagram](img/input_text.svg)

Write text directly on the node; it becomes the text source for downstream nodes.

## Ports
- **In**: 1 data port + one control port at the end; wiring upstream makes this node read-only — the text you wrote here no longer counts
- **Out**: 1 = text; YAML / JSON from upstream is shown as multiple (batch) entries that downstream can run one by one or aggregate

## Settings
- No ⚙ settings window: the body, font size and JSON view are changed on the node body and header.

## Usage
- Type in the body box; on blur it renders as Markdown.
- Click **✎** in the header for the Markdown editor: WYSIWYG / Source, annotations and "Ask AI to revise from annotations".
- Click **A** to change the body font size; a pure-JSON body gets a **JSON** chip that switches to a form view.
- Inherited YAML becomes batch entries — click the **YAML** chip to turn parsing off and show the raw text; old batch nodes can be split back with the **S** button.

## Notes
- Wired upstream means read-only: to use your own text again, disconnect the incoming wire.
- Images inserted in the Markdown editor are copied into `assets/` under the canvas working directory and referenced by a relative path; with no working directory you are asked to pick one first.
- Images in batch entries also live in workflow assets, never as machine-absolute paths.
