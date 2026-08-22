# Super nodes

A super node **packs** related nodes into a subgraph to declutter the main canvas. Unlike a **task** (control flow from start to end), a super is about **structure and data tunnels**.

## Create and wrap

- Right-click empty canvas → **Super node**.
- Select nodes and click toolbar **Wrap super**: creates an expanded super covering the selection and packs the nodes in.
- Create / pack often needs **canvas_super** approval (also when the agent edits the canvas).

## Expand vs Enter

On the header, to the right of **Enter**:

| Action | Effect |
| --- | --- |
| **Expand / collapse** (icon) | Opens an inner stage on the main canvas for editing children; click again to collapse. On expand, content is aligned to the stage top-left. |
| **Enter ↪** | Full-canvas focus on that super’s children; use the breadcrumb to go back. |

Inside the shell: drag empty area to pan, wheel zooms the outer camera, right-click to add nodes; drag nodes in/out to pack/unpack. Supers can nest.

## Outer and inner ports

There are no inner “input/output” proxy nodes—only **edge ports**:

- **Outer inputs** (when collapsed): wires into the super from outside.
- **Inner inputs (bridge)**: left edge of the expanded shell, or the **left edge of the canvas** after Enter; drag from here into children.
- **Inner outputs (sink)**: children wire to the shell’s right edge / full-canvas right edge.
- **Outer outputs**: the super wires out.

Right-click a port to remove its inner wires.

## Subfolder and relative paths

Set a **subfolder** on the header (relative to the toolbar workspace). Then:

- Relative paths on save / music / video / wait-file nodes inside resolve under `workspace / subfolder / …` (nested supers concatenate ancestor subfolders).
- Packing into a super or changing the subfolder prefixes existing relative paths; absolute paths are left alone.
- To target the canvas root or elsewhere, use an **absolute path**.

The subfolder is shown on the header (not drawn on the inner stage).

## Layout

Toolbar **Layout** asks whether to tidy **inside supers** as well when relevant.

## Sidebar

☰ splits into:

1. **Current canvas**: nodes / tags / drawings in scope (click to center).
2. **Super node** tree: nested list; click **enters** that super and fits its children. The active focus is highlighted.

The filter box matches nodes, drawings, and super titles / subfolders.
