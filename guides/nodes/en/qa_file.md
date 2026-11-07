# File QA

![diagram](img/qa_file.svg)

Scores any file against a JSON criteria template: 0–100 per dimension, weighted into a 0–100 total, then pass / fail against the template's pass line. It only judges, never re-runs upstream.

## Ports
- **In**: 3 — 0 Content (any node that produces a file, or a file path of any type), 1 QA requirement (several wires: written criteria + reference samples; once wired it decides the criteria), 2 Ctrl.
- **Out**: 3 — 0 Report (this run's full report JSON), 1 Passed (control), 2 Fail (control).

## Settings
In the settings window opened by **⚙ Settings** in the node header (titled “QA criteria / model”):
- **Criteria**: pick a JSON template (default `builtin/file-general`); the pass line and each dimension's weight are shown read-only below. **Reload** rescans the template folders, **Open template folder** opens `<data dir>/qa-templates/`.
- **QA model**: provider + model.
- **Thinking effort**: defaults to Off.

## Usage
- Wire the file into port 0 and the criteria / baseline file into port 1, then hit ▶.
- The JSON in the node body is this node's criteria: edit it right there (this node only). **Save as a new template** to reuse it, **Restore template** to undo. With port 1 wired, that JSON turns read-only.

## Notes
- Work out what the file is before reading it: `list` for folders and sizes, `read` for text, `pdf` for a PDF text layer, `probe` for media metrics, `shell` for local checks (unzip, `file`, checksums, schema…).
- Never brute-read binary: `read` only makes sense for text — check the header / size / whether the right tool parses it. Verify the file really opens, is not 0 bytes and is structurally complete before judging content quality.
- A fail only sets “Needs attention” and takes the Fail control out; it does not re-run upstream. To let it through, click **Human call** → **Accept (manual override)** / **Give up (fail)**. Runs are refused when the QA model is the upstream generator's own model.
- Templates: bundled read-only, `<data dir>/qa-templates/`, `<project>/qa/templates/` (same name, later wins); `kind` must be `file` (or any). Reports land in `<project>/qa/reports/{id}.json`.
