# Tool node (agent-callable)

Package a piece of canvas processing (text / agent / function / save — any inner subgraph) into a tool **the agent can call directly**: give it a tool name, a description and input/output params, and the model in a smart session can call it like a function — params flow in through ports, results flow back to the session.

A tool node is a **super-like container**: the processing it runs is its **inner subgraph** (child nodes attached under it, same mechanism as a super node), executed topologically on ▶ or an agent call; its configuration lives in `toolConfig` (`name` / `description` / `inputs` / `outputs`).

Create: right-click empty canvas → **Tools** → **Tool (agent-callable · input/output param ports)**.

## Settings (params are ports)
Click **Settings** in the node header to open the settings window (every parameter is edited there; the tool card itself keeps just the name / description and two read-only lines — inputs / outputs):

- **Tool name (name)**: also the call name the agent uses. The title follows the tool name by default; once you rename the title manually, the two stay independent.
- **Description**: say clearly *what it does / when to use / watch out for* — the agent decides whether to call this tool based on it.
- **Input param type (text / image)**: each entry is one input port and the param name is the port name; a text port carries a string, an image port carries a `{kind:"image", path}` path object.
- **Output param type (text / image)**: each entry is one output port, and **outputs declare a type exactly like inputs** — mark an output result as "image" and it becomes an image port (its value = the picture path).

Adding/removing a param adds/removes a port; deleting a param drops its wires too; changing a type changes the port itself (it is re-coloured and downstream reads it with the new type).
**Reordering params**: drag the ⠿ handle on a param row to insert it anywhere, or use the ▲▼ buttons at the row end to move one step — param order is port order, and wired data lines follow the param (they never drift onto another param).

## Develop (session bound to this tool)
Tool nodes support **Develop** too (button under the card, same mechanism as function nodes):

- Click **Develop** → the dialog shows the current state (tool name / description / in-out ports / inner sub-graph / session workspace), then type what to change or extend;
- On confirm a **session bound to this tool** runs in the background (title “Dev · tool name” · workspace = canvas folder);
- The session only touches **this one tool node**: it may change `toolConfig` name / description / inputs / outputs (params are ports — when it edits the param table it must remind you to re-check the wiring), and may create / delete / adjust nodes and wires **inside the tool** to rebuild behaviour — a tool's behaviour is its inner sub-graph;
- Track progress in the session list / bottom-left queue; click Develop again later to keep iterating on top of the previous request.

## What the port type is for (user-visible payoff)
The type declared on a port is the single source of truth for **wire validation, save selection and wire colouring**:

- **Drag a wire from an image output port into a save node and it automatically saves as an image (the extension flips to `.png`)**; from a text output port it saves as text (`.yaml`). No need to pick "text save / image save" by hand any more.
- Image wires may only enter image ports and text wires only text ports; a mismatch is refused with a message naming *which port is which type and where to change it* — an image is never quietly dumped into a text port (if you really feed an image into a text port, its path is taken as text and the node summary says so).
- Image ports and image wires get their own colour, so you can see at a glance which line carries a picture.

## Port layout
- **Input**: port 0 = control in (fixed), then one port per input param.
- **Output**: one port per output param (0..n-1), **last = control out** (fixed).
- Every data port carries a declared type (text / image); control ports carry none and fall back to the value actually present.
- Ports are fixed: disconnecting does not rearrange ports or auto-add new ones; agent calls only touch data ports, never the control port.

## Inner graph (what the tool does)
A tool executes its **inner subgraph** (child nodes attached under this node):

1. Build the inner subgraph — in the shell form (super node + tool variant), expand / enter the inner canvas and arrange it like a super node; a tool **inserted from the library** already carries its inner graph, expand it to inspect or adjust.
2. Outer input ports (including control in) automatically become value sources for inner nodes — wire them the same way as a super node's outer/inner bridging.
3. Wire inner outputs back to the outer output ports (inner converge); when the tool runs, each value is written back to its output param **normalised to that port's declared type** — an image port that receives a path string is completed into an image value, a text port that receives an image keeps its path as text (the node summary mentions it once, nothing is lost). The badge / colour of the outer output port and of the matching inner converge port follow the same rule.

## Running
- Press ▶ (or trigger via a control ▶): upstream nodes are processed first, then every runnable inner node runs topologically (text / agent / function / save…, inner cascades included), results are written to the output ports and downstream keeps running.
- A tool node can still be @-referenced / broadcast globally as text as before; **what downstream receives is decided by the output port you wired** — an image output port into a save node automatically saves as an image (`.png`), see "What the port type is for" above. For batches use batchMode on its inner or downstream nodes (batch mode processes exactly one item per run).

## Cross-canvas reuse and "callable anytime"
The top-bar **Tool library** button (it wears the program's own icon) opens a dialog that lists **only the saved tool / function packages** — nodes are not created there (use the right-click menu above):

- **Save to library**: saves this node plus a snapshot of its inner graph as a tool package (name / description / input-output params — each with its declared type — plus the inner graph JSON).
- **Insert**: the package can be inserted into any canvas repeatedly (cloned with new ids; inner parent-child relations and wires are rebuilt around the new ids).
- **Callable by sessions anytime** (off by default): when on, the agent can call this tool from a session **without a canvas copy**; tool nodes on the canvas are in the callable list anyway. Renaming / overwrite-saving keeps the same library record, so the switch carries over.

## When a tool fails
If an inner node fails or the tool has no runnable inner nodes, the tool node shows ✕ with the reason; when an agent call fails, the session receives an error text reply — the session is never interrupted.
