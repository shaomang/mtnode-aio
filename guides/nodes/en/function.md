# Function node (JS compute)

Write a short piece of **pure JS** on the canvas and compute outputs from inputs. Params are ports, so it wires, cascades, batches and saves like any node.

Create: right-click → **Other Nodes** → **Function (JS compute · custom input/output params)**.

## Ports
- **In**: port 0 = control in (fixed) + one port per input param (text / image / video / audio); a param marked as an array takes many wires
- **Out**: one port per output param (0..n-1) + last = control out (fixed); an output always carries a single value

## Settings
Change these in the settings window opened by **Settings** in the node header; the card keeps two read-only lines (inputs / outputs):

- **Function name (fnName)**: optional, reference only.
- **Description**: one line for humans.
- **Input / output param type**: text / image / video / audio, one entry per port. Text values are strings; image / video / audio values are `{kind, path, text}` objects whose `path` is an absolute local path.
- **Array · accepts many wires**: input rows only, see below.
- Drag ⠿ or use ▲▼ to reorder rows; order is port order and wired lines follow the param.
- **Parameters** (9001): a default JSON, deep-merged at run time with whatever JSON is wired into 9001 (objects merge level by level, arrays replace, `null` is kept) and delivered whole as `input.params`. Bad JSON is normally a warning and that source is skipped; tick **Strict parameter validation** and it rejects the run instead.

## Usage
- **Array input ports** (one wire is not enough — like several reference images for image-to-image): tick **Array · accepts many wires** and the same port accepts multiple wires, rendering as a growing slot group. In code the param is **always an array** — `[]` with no wire, length 1 with a single wire — so `for` / `map` unconditionally. An array changes the shape, not the type; element order = wiring order.
- **Writing code**: edit it right on the node (a comment template is pre-filled). Code does not run in the canvas process: each run gets a dedicated thread in the main process (`fn-runtime.js`) so the UI never freezes. Timeout is 10 minutes by default; finishing, stopping or timing out reclaims the whole process tree it started.
- **The `input` object**: `input.params` (from 9001), `input.$1` / `$2`… by port number, the source title / param name, and `input.values` in wiring order. `return` the result; a plain object whose keys match output param names is dispatched per port.
- **The `mtnode` bridge**: there is no `window` / `document` in the thread, so use `mtnode.exec(program, args, {cwd})` (hidden, waits for exit), `spawn` / `wait` / `kill` / `processes`, `sleep`, `log` / `progress`, `readText` / `writeText` / `readFile` / `fileInfo`, `join` / `abs` / `cwd` / `platform`, `readPdf` / `pdfInfo`, `subtitle` (audio/video to captions), `screenList` / `windowList` / `screenShot`, and `ai(prompt)` (a real request with this node's "AI call" model).
- **AI call**: pick model / preset / thinking effort with the 🤖 button in the header, then `await mtnode.ai(...)` in code; with nothing picked it returns `ok:false` instead of running silently.

## Notes
- **While unselected it shows its content** (function name, description, in/out params, code, last result); click the node and the editable code block appears.
- Return values normalize: string / number / boolean → text; `{kind, path}` → that media; any other object → JSON text. Every output port is normalized once more to its declared type (a path arriving at an image port becomes an image value).
- A function node has no separate test bench: press ▶ for a real run and read each port; image / video / audio outputs show a read-only preview.
- **Develop** binds a session that only edits this one node's code and param tables; after a param-table change, re-check the wiring on the canvas (ports may shift).
