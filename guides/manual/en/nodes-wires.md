# Canvas basics: nodes, wires & layout

On the canvas, each card is a **node** and each line is a **wire** carrying data from one step to the next. Breaking work into nodes lets you tweak one step and re-run only what changed instead of repeating instructions in chat.

## Adding nodes & getting quick help

- **Add a node**: **Right-click** empty canvas space or pick from the bottom **Build bar**.
- **Not sure what a node does?**: Click the **?** button on a node's header for a one-sentence plain explanation, or right-click the node and open **Node guide** for full details.
- **Pan & zoom**: Drag empty space to pan, scroll to zoom, and press `Space` (or click **Fit**) to recenter everything.
- **Find anything fast**: Press `Ctrl + F` (or click **Find**) to jump to any node, session, project file, or manual page.

## Wires & `@` references

Drag from a node's right output port to another node's left input port to connect them.

- **Use `@` in prompts**: Type `@` inside a text or image prompt to pick an upstream node by title (use arrow keys + Enter to insert `@Title`). Whenever the upstream node changes, downstream nodes automatically use the updated content.
- **Data wires vs. control wires**: Data wires pass text, images, or files. Control wires trigger execution order. Connect a **Control Start (▶)** node to the front of a chain so one click runs everything in sequence.
- **Form input node**: Need structured inputs (text, options, images, videos, files)? Add a Form node, define your fields once, and fill or drag assets in like a clean questionnaire. Double-click to open the full editor.
- **Parameter override port**: Many processing nodes expose a `Params` input port — feed a JSON object into it to override settings like model, size, or steps dynamically.

## Keeping big canvases tidy

- **Box-select & duplicate**: Drag across multiple nodes to select them together; press `Ctrl + D` to clone the selection and its internal wires.
- **Groups**: Select nodes and click **Group** to wrap them in a labeled frame you can drag as one section.
- **Node layers**: Select nodes and click **Node layer** to pack them inside a collapsible container. Double-click to step inside and click **← Back** at the top-left to return.
- **Auto-layout & hide wires**: Click **Layout** to neaten positions automatically; press `D` to temporarily hide wires when reading dense prompts.
- **Lean mode**: Working with lots of images or running heavy local video models? Click **Lean** on the top bar to pause image/video thumbnails on the canvas and free GPU memory.

## Undo, redo & rollback

- **Everyday undo**: `Ctrl + Z` undoes and `Ctrl + Y` redoes moves, edits, wires, and even flows built by the assistant.
- **Draft recovery**: Unsent text in inputs is preserved automatically across restarts.
- **Revision rollback**: When revising text with [AI review](#ai-review), every revision is saved so you can roll back to any earlier version anytime.
