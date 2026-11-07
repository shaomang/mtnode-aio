# Text QA

![diagram](img/qa_text.svg)

Scores text against a JSON criteria template: 0–100 per dimension, weighted into a 0–100 total, then pass / fail against the template's pass line. It only judges, never re-runs upstream.

## Ports
- **In**: 3 — 0 Content (a text node's body, or a .md / .txt / .json path), 1 QA requirement (several wires: written criteria + reference samples; once wired it decides the criteria), 2 Ctrl.
- **Out**: 3 — 0 Report (this run's full report JSON), 1 Passed (control), 2 Fail (control).

## Settings
In the settings window opened by **⚙ Settings** in the node header (titled “QA criteria / model”):
- **Criteria**: pick a JSON template (default `builtin/text-general`); the pass line and each dimension's weight are shown read-only below. **Reload** rescans the template folders, **Open template folder** opens `<data dir>/qa-templates/`.
- **QA model**: provider + model.
- **Thinking effort**: defaults to Off.

## Usage
- Wire the content into port 0 and the criteria / samples into port 1, then hit ▶.
- The JSON in the node body is this node's criteria: edit it right there (this node only). **Save as a new template** to reuse it, **Restore template** to undo. With port 1 wired, that JSON turns read-only.

## Notes
- Criteria live in templates, not in code: `<app dir>/qa-templates/` (bundled, read-only), `<data dir>/qa-templates/`, `<project>/qa/templates/` — same file name, later wins. `kind` must match the node (text / image / video / audio / file, or any). Total = Σ(dimension score × `weight`) / Σ`weight`; `passLine` is the bar and `minScore` an optional hard floor per dimension.
- A fail only sets “Needs attention” and takes the Fail control out; it does not re-run upstream or pop a card. To let it through, click **Human call** on the node → **Accept (manual override)** records manualOverride and passes without re-triggering downstream, or **Give up (fail)**.
- A run is refused when the QA model is the same model the upstream generator used (a generator never reviews itself). The agent loop has no turn cap and stops only manually; it aborts after 3 unparseable replies in a row. Blocked only sets “Needs attention” and never writes pass.
- The first turn carries only the first 8000 chars of text and 6000 chars of requirement, so long text must be read in full with `read` offset / limit. Reports land in `<project>/qa/reports/{id}.json`; pass / fail also writes `shots[id].qa` in the semantic project `manifest.json`.
