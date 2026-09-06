# Function node (JS compute)

Write a short piece of **pure JS** on the canvas and compute outputs from inputs — a lightweight compute node. Params are ports, so it wires, cascades, batches and saves like any node.

Create: right-click empty canvas → **Tools** → **Function (JS compute · custom input/output params)**.

## Settings
Click **Settings** in the node header to open the settings window (every parameter is edited there; the card itself keeps just two read-only lines — inputs / outputs):

- **Function name (fnName)** (optional, for reference only)
- **Description**
- **Input param type (text / image)**: one input port each (text values are strings; image values are `{kind:"image", path}` path objects).
- **Array · accepts many wires** (shown on **input** param rows only): tick it and this port takes a *group* of values — see “Array input ports” below.
- **Output param type (text / image)**: one output port each, and **outputs declare a type exactly like inputs** — mark an output result as "image" and it becomes an image port. Output ports are always **one port, one value** — there is no array output.

Param rows can be **reordered**: drag the ⠿ handle on a row to insert it anywhere, or use the ▲▼ buttons at the row end to move one step — param order is port order, and wired data lines follow the param (they never drift onto another param).

## Array input ports (when one wire is not enough — like extra reference images for image-to-image)
Some computations want a **group** of inputs: image-to-image with several reference images, or N text wires folded into one array to process in a loop. Previously you had to add "param 1, param 2, param 3…" and rewrite how the code reads them; now just tick **Array · accepts many wires** on that input param:

- **The same port accepts multiple data wires** (exactly like the reference-image slots of the image-generation node — want one more, connect one more), instead of refusing with "this input port is already occupied".
- The port renders as a **growing slot group**: the badge shows the param name plus one lit slot per connected wire (`参考图[1] [2] …`) and a trailing empty slot for the next wire — each new wire adds another slot, just like ordinary processing nodes growing a new input port after each connection. Hovering a slot names that source; right-click one slot to disconnect only that wire. The underlying engine still reads one logical port that may take many wires, so the param stays an array.
- **In the code this param is always an array**: `[]` when nothing is wired, an array of length 1 when a single wire is connected — so you can `for` / `map` unconditionally instead of first asking "is it one value or a list?".
- An array changes the **shape, not the type**: a port declared as "image" still only accepts image sources, and a mismatch is still refused with a message naming where to change it.
- Element order = the order you wired them; each element is still normalised to the type declared on that port (path text arriving at an image port becomes `{kind:"image", path}`).

```js
// Input params: 提示词 (text) · 参考图 (image · with "Array · accepts many wires" ticked)
const refs = input["参考图"];          // always an array: [] with no wire, 3 entries with 3 wires
if (!refs.length) return "At least one reference image";
return { list: refs.length + " images: " + refs.map((r) => r.path).join(" | ") };
```

No wires needed to try a batch either: press **Test** and that param renders as **addable / removable rows** (one value per row, blank rows are not injected).

## What the port type is for (user-visible payoff)
The type declared on a port is the single source of truth for **wire validation, save selection and wire colouring**:

- **Drag a wire from an image output port into a save node and it automatically saves as an image (the extension flips to `.png`)**; from a text output port it saves as text (`.yaml`) — no more picking "text save / image save" by hand.
- Image wires may only enter image ports and text wires only text ports (audio/video file paths count as text); a mismatch is refused with a message naming which port is which type and where to change it.
- Image ports and image wires get their own colour, and the output line in the node summary is labelled "(image)".

## Writing code
Edit the JS directly on the node (a comment template is pre-filled). **Your code does not run in the canvas process**: each time the function node runs, the MTNode main process starts a dedicated **execution thread** for it (`fn-runtime.js`); the canvas only hands the code over and waits for the result —

- Full language support (you can write an `async` body and `await` directly), and no matter how long a wait or a loop is, **the UI never freezes**;
- While it runs the node shows **Running** and appears in the **run queue** at the bottom left, where you can stop it anytime;
- When the run finishes, is stopped or times out (default 10 minutes): the thread is terminated right away and any external process it started is **reclaimed together with its whole process tree** — as long as a function node is not running, its thread and processes do not exist;
- A thrown error or a timeout only becomes that node's ✕ error — other runs on the canvas are not interrupted.

**Input object** (every wired value is available three ways — use whichever suits):
- `$<port number>`: port 1 = 1st input param, port 2 = 2nd, and so on (port 0, control in, is not included)
- source title / param name: e.g. the title of a wired-in text node
- `values`: array in wiring order

Keys come from **this node's own param names** (params are ports), and `input.$1` always equals the value of input port 1 regardless of the order wires were attached in. **An array port (the param with "Array · accepts many wires" ticked) yields an array** — `[]` when nothing is wired; see "Array input ports" above.

`return` the result; you may also write an arrow/named function `(input) => ...` — if the returned value is a function it is called again with `input`.

### What the thread can do (the `mtnode` bridge)
The function body is **no longer in the renderer**, so there is no `window` / `document` / `window.api.*`; to reach the local machine, use the injected `mtnode`:

| Write this | What it does |
| --- | --- |
| `const r = await mtnode.exec("git", ["status"], { cwd })` | Start an external program **hidden** and wait for it to exit → `{ ok, pid, code, signal, killed, stdout, stderr }` (no console window ever pops up) |
| `const p = await mtnode.spawn("chrome", ["--headless=new"])` | Start hidden, **do not wait**, keep going; returns `{ ok, pid, id }` |
| `await mtnode.wait(p)` | Wait for that `spawn`'ed process to exit and get its exit code and output |
| `await mtnode.kill(p)` | Kill just this process (together with its child process tree) |
| `await mtnode.processes()` | Which external processes of this run are still alive |
| `await mtnode.sleep(1500)` | Wait (no UI blocking, no CPU burn) |
| `mtnode.log(...)` / `mtnode.progress(0.4, "batch 3")` | Progress output (sent to the UI as events, not to stdout) |
| `mtnode.readText(p)` / `mtnode.writeText(p, s)` / `mtnode.fileExists(p)` | Local file reads and writes |
| `mtnode.join(...)` / `mtnode.abs(p)` / `mtnode.cwd()` / `mtnode.platform` | Paths and platform |

All of these external processes are **booked under this run**: the instant the function `return`s, is stopped or times out, the main process reclaims them — children included — by runId. Entries that could take down MTNode itself, like `process.exit()`, are turned into a thrown error inside the thread.

### Migration example: you used to launch programs with `window.api`
The old form only worked in the renderer; inside the isolated thread it is guaranteed to throw `window is not defined` (the error message points you to this migration note):

```js
// ❌ Old: popped up a visible console window, and closing it left the process running
window.api.shellOpenPathDetached("E:\\tools\\render\\run.bat");
return { started: true };

// ✅ New: start hidden, wait for it to finish and get the output; an error shows as ✕ on the node
const r = await mtnode.exec("E:\\tools\\render\\run.bat", [], {
  cwd: "E:\\tools\\render",
});
if (!r.ok || r.code !== 0)
  return "render failed (code " + r.code + "): " + (r.stderr || r.error || "");
return r.stdout;

// ✅ Need it running in the background for a while? It is still reclaimed with this run (killed on return)
const p = await mtnode.spawn("E:\\tools\\server\\app.exe", [], {
  cwd: "E:\\tools\\server",
});
await mtnode.sleep(2000); // give the server 2 s to come up
mtnode.log("server pid =", p.pid);
const st = await mtnode.wait(p); // exit code and output
return { code: st.code, out: st.stdout };
```

Likewise, to read a local file stop reaching for `window.api.readFileText` — just use `mtnode.readText(path)`.

Return-value normalization:
- string / number / boolean → text
- `{kind:"image"|"audio"|"video"|"path", path}` → the matching media kind (decided by file extension)
- any other object → auto JSON-serialized to text

On top of that, **every output port is normalized once more to the type it declares** (shape only — nothing is swallowed):
- a port declared **image** that receives a path string is completed into `{kind:"image", path}` (only then does a downstream save node treat it as an image);
- a port declared **text** that receives an image keeps its path as text, and the node summary notes "the image was taken as its path text".

### Multi-output dispatch
When `return` gives a **plain object** whose keys match **output param names**, each key is dispatched to its own output port (the i-th output param = port i):

```js
// output params: main (text), digest (text), picture (image)
return {
  main: big,
  digest: big.slice(0, 40),
  picture: { kind: "image", path: "E:/out/a.png" },
};
```

- Only the ports whose keys matched get a value; the others read as null downstream.
- Scalars / strings / arrays / objects that match no output param name → legacy **single output**: only port 0 is written.
- With no output params defined, the result still lands on port 0.
- Once an output param like `picture` is marked **image** in Settings, returning even a bare path string `"E:/out/a.png"` is completed into an image value — wire it straight into a save node and it saves as `.png`.

Example (a numeric text source wired into each of the two input param ports):

```js
const x = Number(input.$1);
const y = Number(input.$2);
if (!Number.isFinite(x) || !Number.isFinite(y))
  return "Connect numeric text into both input param ports";
return "sum: " + (x + y) + " · product: " + (x * y);
```

## Code editor (highlighting / line numbers / indentation / format)
**While the node is unselected it shows its content** — just like other nodes you see the function name, description, input / output summary, the code itself and the last result, nothing else on screen. **Click the node and the editable code block appears**, with the caret already inside the code; click empty canvas to deselect and it goes back to the read-only view. In edit mode this area is an editor built for "a few dozen lines of small function" — and it is **the same implementation and the same `node.jscode`** as the one in the **Test** dialog, so both sides stay in sync:

- **Syntax highlighting**: comments / strings / numbers / keywords / literals each get their own colour, call names and property names another; the contract words `input` and `values` plus port keys like `$1`, `$2` are colour-coded, so you can see at a glance which port you are reading.
- **Line-number gutter**: one number per line, the caret's line highlighted, scrolling kept in sync with the code.
- **Indentation**: `Tab` inserts 2 spaces; with a multi-line selection `Tab` / `Shift+Tab` shift the whole block one level in / out; `Enter` inherits the previous line's indent, adds a level right after an opening bracket, and expands an empty pair of brackets into a block with the caret inside. While an IME is composing, Enter is never hijacked.
- **Format**: the **Format** button in the toolbar above the code re-indents **in place** with 2 spaces — it never joins or splits a line and never touches a single character of content; a `switch` body counts one extra level; consecutive blank lines fold to one, trailing spaces go, no trailing blank line (pressing it again changes nothing). Lines inside template literals or an unterminated block comment are left exactly as they are (spaces there are content). If the code is already formatted, it tells you so.
- The toolbar also shows "line X / N lines" all the time, and code inserted by **Generate scaffold** goes through the very same formatter, so it looks tidy from the first glance.

## Develop (a session bound to this function)
The **Develop** button under the node card (hint "use a session to change / extend this function"; hovering shows how many development sessions are already bound) is a session **bound to this one function node**:

- Clicking opens a dialog that first echoes the current state (function name, node title, description, input ports, output ports, JS line count, session workspace, last request); you then write **what to change or extend this round**. Your draft is saved as you type — cancelling or pressing Esc does not lose it and it is back next time. `Ctrl+Enter` submits.
- Confirming = **a new session bound to this function is created and runs in the background**: titled "Develop · <function name>", workspace = the canvas folder the node belongs to, preset / model / thinking effort following your current defaults. You stay on the canvas; progress is in the run queue at the bottom left and in the session list.
- The session **changes only this function node**: what it edits is the node's **JS code (jscode) and its parameter tables (inputs / outputs)**, plus the description and function name when needed. It does not create, delete or alter any other node, nor add or remove wires.
- **Re-check the wires after a param change**: params are ports, so touching `inputs` / `outputs` changes the ports — once the port count shifts, already-connected wires may point at a different port. Whenever the session does touch the param table it explicitly reminds you to review that node's wiring on the canvas — do not skip that step.
- If the requirement is unclear it asks before acting, and it reports in one line what changed and whether the param table was touched. It works with an empty function too: the session writes the body from the existing input / output params.

## Test (not part of canvas runs)
Click **Test** in the header to open its own dialog (separate from **Settings**): a large JS area on top, **one field per input param** in the middle (text = multiline box, image = path field + file picker, **array param = addable / removable rows, one value per row**), and the result **per output port** plus the error after you press "▶ Run test".

- Test inputs are stored on the node (they are still there next time), but this is **test-only**: it never writes the node output, never cascades downstream, never enters the undo history.
- For an array param, blank rows are not injected and all rows blank = an empty array — exactly the shape the port has on the canvas with nothing wired to it; the footer echoes "Injecting N".
- The test bench is the quickest way to see what a given port will actually carry; press ▶ when you want a real run.

## Ports and running
- **Input**: port 0 = control in (fixed) + one port per input param (the port marked as an **array** takes any number of data wires)
- **Output**: one port per output param (0..n-1) + last = control out (fixed); an output port always carries a single value
- Every data port carries a declared type (text / image); control ports carry none and fall back to the value actually present
- Press ▶: upstream nodes are auto-run first → the code executes in an isolated thread of the main process (the UI stays responsive; the node shows **Running** and enters the run queue at the bottom left) → results are dispatched to the output ports as above and downstream keeps running; a thrown error shows ✕ (also written to the error port) without stopping other runs.
- **Stopped / timed out**: the thread of that run is terminated immediately and the external processes it started — children included — are reclaimed together, and the node reads "stopped manually" — no window or process is left behind outside a running state.
