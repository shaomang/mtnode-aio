# Nodes, wires, @ refs

> One-sentence goal: add nodes from the right-click menu, connect them at the ports, reference upstream with `@` inside a prompt, and read the three kinds of wire.

![Nodes and ports](img/mtnode-canvas-01-ui.svg)
*Figure 1: the node categories in the right-click menu (input / process / save / agent / task / control / tool / dev / database / split-merge / draw)*

![Dragging, wiring and running](img/mtnode-canvas-02-flow.svg)
*Figure 2: the three kinds of wire — a **data wire** carries a value, a **gold control wire** carries only a pulse, and a **relationship wire** only expresses a dependency.*

![Drag and wire animation](img/mtnode-canvas-02-demo.svg)
*Figure 3 (looping animation, about 6 seconds): drag a node → pull a wire from an output port → drop it on an input port (green on success / red when it misses) → release on empty canvas to create a new node right there; for the static fallback see `img/mtnode-canvas-02-demo-static.svg`.*

## Goal

After reading this you can pick the right node type, connect wires correctly (and know why one refuses to connect), reference upstream content precisely with `@`, and tell "browse form" from "edit form".

## Before you start

- You have a canvas. Wiring itself costs nothing; only running with ▶ calls a provider.

## Steps

1. **Add a node**: **right-click on empty canvas** to expand the node-category menu and choose a type. Control nodes carry a **gold outer ring**.
2. **Rename it**: click the node title to rename it. The title is what `@` references are based on, so give it a name you will recognize.
3. **Wire them**: drag from the upstream **output port** (the dot on the right) to the downstream **input port** (the dot on the left). **Loops are not allowed**; there is one input port by default, and connecting it often frees up another one automatically.
4. **When it will not connect, look at the port types**: data ports match by type (text / image / audio / video are all different), and when they do not match the wire will not drag across or the drop point turns red.
5. **Releasing on empty canvas = create and connect right there**: drag out from an output port and release over empty canvas, and a menu pops up listing only the node types this wire **can really connect into** (an image wire will not offer Minimax Music 3, which only takes text). Pick one and the node is created at that spot and wired up; press `Esc` or click elsewhere to cancel. Releasing on a node does not count — that is treated as aiming at that node.
6. **Write an `@` reference**: type `@` in a prompt and the candidates list only **connected** nodes (and, if the rainbow icon in the top-left is on, the global node sources wired in). Keep typing to filter (title substring matching, prefix hits first), `↑` `↓` to move the highlight, Enter (or `Tab`) to confirm, `Esc` to dismiss — **no mouse needed at any point**. `Shift+Enter` is still a newline in the body, and while the menu is open Enter only picks an entry, never runs the node.
7. **Tell the three kinds of wire apart**: a **data wire** passes the upstream result down the connection as an input; a **control wire is gold** and carries only a pulse (timer, gate, run / clear), never as a data input; a **relationship wire** only expresses a dependency (used a lot by dev nodes) and takes no part in execution.
8. **Turn reference sources on / off**: text processing / image processing / agent task / judge nodes **click the type icon in the top-left corner** to subscribe (the icon turns rainbow); dragging the icon only moves the node and does not toggle it by accident.

### Browse form and edit form

- **A node that is not selected is in browse form**, and its body is read-only: content with Markdown signals renders as **Markdown**, a solid run of `key: value` lines renders as **YAML** (indentation and coloring kept), and anything doubtful is shown as plain text; `@title` / `@tag` are highlighted in the reference color. Images fill the node. In this form only the row of small buttons on the header is clickable (▶, parameters, browse…); the wheel scrolls the body and dragging the body moves the node.
- **Clicking a node to select it returns it to editable form**: the body becomes an input box again and the caret lands at the end of the main input; clicking empty canvas or selecting another node goes back to browse form.
- Only input (text / image), text processing, image processing, agent task, chat and save nodes take part in browse form; control / judge / task / super / dev / database / media / network nodes are **always in edit form**.

> 💡 Tip: parameter names next to ports are ellipsized by width normally, and hovering over the node expands them to full length — tool / function node parameter names and asset node entry titles are shown in full.

> ⚠️ Danger: a control wire (gold) is not a data wire. Connect a gold wire to an input port that needs data and the node receives nothing; conversely, treat a data wire as a control wire and it will not trigger downstream either.

## Result

You can build the shortest "input → process → save" pipeline from scratch and explain the type and purpose of every wire; `@` references point precisely at a chosen upstream node.

## Common mistakes

| Symptom | Cause | Fix |
| --- | --- | --- |
| The wire will not drag across / the drop point turns red | Port types do not match, or it would create a loop | Switch to a node that accepts that type, and first disconnect the wire that closes the loop |
| An input node can no longer be edited | It is wired to upstream, so its content became **read-only and inherited from upstream** | Disconnect the wire to make it editable again |
| The `@` menu does not list the node you want | It is not connected to the current node | Connect the wire first, or turn on the rainbow icon in the top-left to include global sources |
| You wrote `@` but nothing was injected at run time | The rainbow is on but no `@` was written, or `@` was written without the rainbow | A global source needs both conditions at once; see [Global node](#global-broadcast) |
| Port labels overlap each other | You expected the names to sit inside the port strip | Port names are always written outside the node, on the same horizontal line as their port |
| YAML text turned into several entries on its own | The content was judged to be YAML batch entries | This is expected; adjust the content format if you want it treated as plain text |

## Next

- [Box, groups, layout](#marks-groups)
- [Super nodes](#super-nodes)
- [Input / process / save](#io-proc)
