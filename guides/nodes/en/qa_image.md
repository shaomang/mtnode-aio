# Image QA

![diagram](img/qa_image.svg)

Scores images against a JSON criteria template: 0–100 per dimension, weighted into a 0–100 total, then pass / fail against the template's pass line. It only judges, never re-runs upstream.

## Ports
- **In**: 3 — 0 Content (an image node's output, or an image file path), 1 QA requirement (several wires: written criteria + reference samples; once wired it decides the criteria), 2 Ctrl.
- **Out**: 3 — 0 Report (this run's full report JSON), 1 Passed (control), 2 Fail (control).

## Settings
In the settings window opened by **⚙ Settings** in the node header (titled “QA criteria / model”):
- **Criteria**: pick a JSON template (default `builtin/image-general`); the pass line and each dimension's weight are shown read-only below. **Reload** rescans the template folders, **Open template folder** opens `<data dir>/qa-templates/`.
- **QA model**: provider + model — it must be able to see images (with vision off, images are not sent with the request).
- **Thinking effort**: defaults to Off.

## Usage
- Wire the image into port 0 and reference samples (character turnarounds / scene sheets) into port 1, then hit ▶.
- The JSON in the node body is this node's criteria: edit it right there (this node only). **Save as a new template** to reuse it, **Restore template** to undo. With port 1 wired, that JSON turns read-only.

## Notes
- The first turn already sends the image (plus up to 8 reference samples from port 1), so overall judgement can be made at once; for local defects (fingers, text, eyes, seams) call `vision` yourself and say what to look at.
- Consistency needs reference samples on port 1; without them, judge only whether the image is self-consistent and never guess “it doesn't match the design”. Use `probe` for size / aspect evidence.
- A fail only sets “Needs attention” and takes the Fail control out; it does not re-run upstream. To let it through, click **Human call** → **Accept (manual override)** / **Give up (fail)**. Runs are refused when the QA model is the upstream generator's own model.
- Templates: bundled read-only, `<data dir>/qa-templates/`, `<project>/qa/templates/` (same name, later wins); `kind` must be `image` (or any). Reports land in `<project>/qa/reports/{id}.json`.
