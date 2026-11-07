# Audio QA

![diagram](img/qa_audio.svg)

Scores audio against a JSON criteria template: 0–100 per dimension, weighted into a 0–100 total, then pass / fail against the template's pass line. It only judges, never re-runs upstream.

## Ports
- **In**: 3 — 0 Content (a speech gen output, or an audio file path), 1 QA requirement (several wires: written criteria + reference samples; once wired it decides the criteria), 2 Ctrl.
- **Out**: 3 — 0 Report (this run's full report JSON), 1 Passed (control), 2 Fail (control).

## Settings
In the settings window opened by **⚙ Settings** in the node header (titled “QA criteria / model”):
- **Criteria**: pick a JSON template (default `builtin/audio-general`); the pass line and each dimension's weight are shown read-only below. **Reload** rescans the template folders, **Open template folder** opens `<data dir>/qa-templates/`.
- **QA model**: provider + model.
- **Thinking effort**: defaults to Off.

## Usage
- Wire the audio into port 0 and the script / criteria into port 1, then hit ▶.
- The JSON in the node body is this node's criteria: edit it right there (this node only). **Save as a new template** to reuse it, **Restore template** to undo. With port 1 wired, that JSON turns read-only.

## Notes
- The model cannot hear audio: run `transcribe` first (local SenseVoice, sentence by sentence with timestamps) and compare it line by line with the script on port 1. Claims about timbre or emotion must rest on the transcript, measured values and that script; with thin evidence, score lower and say what is missing.
- Loudness / noise / clipping: get real numbers with `probe` and `shell` (ffmpeg `volumedetect` / `ebur128`), e.g. “around -16 LUFS”. Evidence goes to the line or second plus the transcript text or dB value.
- A fail only sets “Needs attention” and takes the Fail control out; it does not re-run upstream. To let it through, click **Human call** → **Accept (manual override)** / **Give up (fail)**. Runs are refused when the QA model is the upstream generator's own model.
- Templates: bundled read-only, `<data dir>/qa-templates/`, `<project>/qa/templates/` (same name, later wins); `kind` must be `audio` (or any). Reports land in `<project>/qa/reports/{id}.json`.
