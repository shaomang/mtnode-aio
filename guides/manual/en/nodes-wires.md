# Nodes and wires

![Pipeline](img/nodes-wires.svg)

## Adding nodes

Right-click empty canvas: input, process, save, chat, agent, task, control-flow, drawing. Control nodes have a **gold outer ring**.

## Ports and wires

- Drag **output** (right) to **input** (left). Loops are rejected.
- Nodes start with one input; a new idle port often appears after you connect.
- **Control wires are gold**—pulses only (timer, gate, run/clear), not data.
- **Global node** takes inputs only. Process / agent-task / judge nodes **click the top-left type icon** to subscribe (icon turns rainbow). Dragging the icon moves the node and does not toggle.

## Inheritance and auto-run

A wired input node becomes **read-only and inherits upstream**. Disconnect to edit. YAML text becomes batch entries.

▶ recursively runs unprocessed upstream nodes first. After a process node finishes, **downstream runs automatically**; if those nodes already have output, choose overwrite or stop.

## @ references

Type `@` in a prompt to list **connected** nodes (and global-node sources if the top-left rainbow icon is on). Inputs go to “background”, the prompt to “content”. Image refs are reference images.
