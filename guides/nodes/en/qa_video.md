# Video QA

![diagram](img/qa_video.svg)

Scores video against a JSON criteria template: 0–100 per dimension, weighted into a 0–100 total, then pass / fail against the template's pass line. It only judges, never re-runs upstream.

## Ports
- **In**: 3 — 0 Content (a video gen / digital human output, or a video file path), 1 QA requirement (several wires: written criteria + reference samples; once wired it decides the criteria), 2 Ctrl.
- **Out**: 3 — 0 Report (this run's full report JSON), 1 Passed (control), 2 Fail (control).

## Settings
In the settings window opened by **⚙ Settings** in the node header (titled “QA criteria / model”):
- **Criteria**: pick a JSON template (default `builtin/video-shot`); the pass line and each dimension's weight are shown read-only below. **Reload** rescans the template folders, **Open template folder** opens `<data dir>/qa-templates/`.
- **QA model**: provider + model — it must be able to see images.
- **Frames to sample**: 1–12, default 7 (video QA only).
- **Thinking effort**: defaults to Off.

## Usage
- Wire the video into port 0 and the criteria / samples into port 1, then hit ▶. A run probes with ffprobe first and samples frames evenly by time; those frames go with the first turn.
- The JSON in the node body is this node's criteria: edit it right there (this node only). **Save as a new template** to reuse it, **Restore template** to undo. With port 1 wired, that JSON turns read-only.

## Notes
- A failed probe or frame extraction is judged blocked outright instead of guessed. Evidence must carry a time point (“hand deforms at 3s”); to look closer, re-sample with `frames` `times` and inspect with `vision`.
- Hard metrics (duration / resolution / fps / bitrate / black segments) only go into the report's `probe` as evidence — whether they cost points is up to the template's dimensions. For lip-sync / speech work, get the transcript timeline with `transcribe` first.
- A fail only sets “Needs attention” and takes the Fail control out; it does not re-run upstream. To let it through, click **Human call** → **Accept (manual override)** / **Give up (fail)**. Runs are refused when the QA model is the upstream generator's own model.
- Templates: bundled read-only, `<data dir>/qa-templates/`, `<project>/qa/templates/` (same name, later wins); `kind` must be `video` (or any). Reports land in `<project>/qa/reports/{id}.json`.
