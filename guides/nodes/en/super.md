# Node layer

![diagram](img/super.svg)

Packs a group of nodes into one shell: collapsed it takes a single cell, expanded or **↪ entered** it is edited as-is; data only crosses the shell boundary through its edge ports.

## Ports
- **In / Out (outer)**: the wiring when collapsed — both data wires and control wires use them
- **Inner bridge (left) / inner sink (right)**: after expand or Enter, the left and right columns of the inner canvas — outside data comes in through the left bridge ports, inner results leave through the right sink ports
- **Group output**: the last port of the right-hand column (purple dot). Drag it onto the group input port of an “Agent task” node, or of a “Text processing” node with the assistant enabled, and that node gets this layer's full node list and hierarchy for the run (the layer on its own line, inner nodes indented; each line is title · kind · description · node id). It is a list only, no bodies — the agent fetches bodies by id, and wiring it does not run anything inside the layer. The wire is dropped automatically if the layer is deleted or emptied

## Settings
- No ⚙ settings window: everything is on the header — **subfolder** puts inner relative paths under “workspace / subfolder” (existing inner relative paths get the prefix added); **Description** and **Cover** are the small caption under the folder title and the body cover image

## Usage
- Toolbar “Node layer” wraps the selection into a new layer; with a single layer selected, press it again to unwrap (contents move back out as they are, the empty shell is deleted)
- Header: ▶ Run this layer (runs the executable inner nodes upstream → downstream), ↪ enter, expand / collapse; drag in or out to pack / unpack; the sidebar “Node layer” tree jumps in and fits

## Three special modes

| Mode | How to get it | What it does |
| --- | --- | --- |
| **Dev node** | Add from the right-click menu “Dev Nodes (project architecture · module blocks)” | Software project architecture: module → file → class / interface / enum, bound to a project root (`devPath`); card buttons “Develop / Refine / Open”, “Suggest” lives in the right-click menu; elements are linked with relationship wires (rel) for dependencies / calls |
| **Database node** | Mark a node layer as a database (`db`); there is no separate menu entry, so let the canvas assistant create it | Fact storage: inner “File node / Table”, the header **⚙** compiles a “Database replica”, agent nodes query it with `mtnode_db` |
| **Long-task shell** | Nothing to create by hand: a long-running task places the parent shell and each step's child shell when it is created (built, never run; a step added later is built once it produces output) | Output collection: one “Long task · <task name>” parent shell per task, one child shell per step, output / artifact nodes land in their step's shell (read-only badge on the header; a deleted shell is not rebuilt silently — use “Rebuild shell” in the strip's “⋯ More”) |

## Notes
- An inner node cannot wire straight to an outside node: the wire must hop the boundary ports layer by layer (inner → this layer's outer output port → … → the target layer's outer input port → inner)
- Copying a layer that has a subfolder asks for a new path first; otherwise a run writes back into the original folder and overwrites it
- The group output only accepts smart nodes' group input port — an ordinary data port will not take the wire

See the manual [Node layers](#node-layers), [Dev nodes](#dev-nodes), [Database nodes](#database-nodes).
