# Tool node (agent-callable)

Package a piece of canvas processing (text / agent / function / save — any inner subgraph) into a tool **the agent can call directly**: give it a tool name, a description and input/output params, and the model in a session calls it like a function — params in through ports, results back to the session.

Create: right-click empty canvas → **Other Nodes** → **Tool (agent-callable · input/output param ports)**.

## Ports
- **In**: port 0 = control in (fixed) + one port per input param
- **Out**: one port per output param (0..n-1) + **last = control out** (fixed)
- **Group**: a **Parameters** port (9001) carries the inner graph's shared params, inherited automatically by inner function nodes (their own keys win)
- Every data port carries a declared type (text / image / video / audio); disconnecting does not rearrange or add ports, and agent calls only touch data ports

## Settings
Change these in the settings window opened by **Settings** in the node header; the card keeps the name / description and the input/output summary:

- **Tool name (name)**: also the agent's call name; the title follows it by default and becomes independent once you rename the title.
- **Description**: what it does / when to use it / what to watch out for — the agent decides from this whether to call it.
- **Input / output param type**: one entry per port; outputs declare a type too, so marking one "image" makes it an image port. Adding/removing a param adds/removes a port, and deleting one drops its wires.
- **Six description slots**: purpose, a note per input, a note per output, optionality (tick **Optional**; express "one of these two" in **At least one of**), call example (minimal JSON, keys = param names), and limits / failure cases. Descriptions, examples and notes may use `{{outDir}}`, replaced at call time by the writable user output folder.
- A yellow "Description not self-sufficient (missing …)" line only warns; it never blocks saving or running.

## Usage
- **The inner graph defines behaviour**: a tool runs its inner subgraph. Outer input ports become value sources for inner nodes, and inner outputs wire back to the outer output ports; each value is normalized to the output port's declared type (a path arriving at an image port becomes an image value).
- **Running**: ▶ runs upstream first, then every runnable inner node topologically, writes results to the output ports and keeps going downstream. What downstream gets is decided by the output port — an image port into a save node saves `.png` automatically. For batches use batchMode on inner or downstream nodes (one item per run).
- **Develop**: the button under the card binds a session that only touches this tool node: it may change `toolConfig` name / description / inputs / outputs and add / remove nodes and wires **inside** the tool; when it edits the param table it reminds you to re-check the wiring.
- **Reuse across canvases**: the top-bar **Tool library** button wears the program's own icon and lists the **saved tool / function packages** plus the **built-in entries** (built-ins wear a grey "Built-in" badge: insert / test-run, but no rename or delete); nodes are still created from the right-click menu. Saving stores the node plus an inner-graph snapshot; **Insert** clones it into any canvas; the **Callable by sessions anytime** switch (off by default) lets sessions call it without a canvas copy.

## Notes
- A thin description only lowers the odds the agent gets it right first time; built-ins fill all six slots, and older copies refresh their description and param notes when the canvas opens (count and order never change).
- When an inner node fails or there is nothing runnable inside, the tool shows ✕ with the reason; a failed agent call returns error text without interrupting the session.
