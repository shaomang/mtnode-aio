# Nodes and wires

![Pipeline](img/nodes-wires.svg)

## Adding nodes

Right-click empty canvas: input, process, save, chat, agent, task, **super**, control-flow, drawing. Control nodes have a **gold outer ring**.

For large graphs, pack clusters with [Super nodes](#super-nodes), or select nodes and use toolbar **Wrap super**.

## Ports and wires

- Drag **output** (right) to **input** (left). Loops are rejected.
- **Release on empty canvas = create and connect in place.** Drag out from an output port and let go over blank canvas (also inside an expanded super node): a menu opens at that spot listing only the node types this wire can really connect into (an image wire will not offer text-only nodes such as Minimax Music 3). Pick one — the node is created there and wired into its input. `Esc` or a click elsewhere cancels; dropping onto another node's card does not open the menu.
- **Port text always sits outside the node**: input side to the left, output side to the right, on the same line as its port — ports are only 12 px apart, so text above a port would hide its neighbours. The port strip no longer carries extra **"Input / Output" captions**: the name on each port already says which way the data goes.
- **Long names are shortened by width until you highlight the node**: hover over a node (or select it) and the full text shows. Names are kept in full in the DOM (tool / function param names, asset entry titles), so a highlighted port is never chopped mid-character.
- Nodes start with one input; a new idle port often appears after you connect.
- **Control wires are gold**—pulses only (timer, gate, run/clear), not data.
- **Global node** takes inputs only. Text-process / image-process / agent-task / judge nodes **click the top-left type icon** to subscribe (icon turns rainbow). Dragging the icon moves the node and does not toggle.

## Inheritance and auto-run

A wired input node becomes **read-only and inherits upstream**. Disconnect to edit. YAML text becomes batch entries.

▶ recursively runs unprocessed upstream nodes first. After a process node finishes, **downstream runs automatically**; if those nodes already have output, choose overwrite or stop.

## @ references

Type `@` in a prompt to list **connected** nodes (and global-node sources if the top-left rainbow icon is on). Inputs go to “background”, the prompt to “content”. Image refs are reference images.

Keep typing to narrow the list (title substring, prefix matches first); **`↑` `↓` move the highlight and Enter (or Tab) confirms it right there**, `Esc` dismisses — no mouse needed. `Shift+Enter` still inserts a newline, and while the menu is open Enter only picks an entry — it never fires the node.

Global sources enter the input **only when you actually `@`-mention them**: rainbow on but no `@` injects nothing this run, and `@` without the rainbow does nothing either.

## Browse form vs edit form

- An **unselected node is in browse form** and its body is read-only: the renderer is picked from the content itself — Markdown signals render as **Markdown**, a solid run of `key: value` lines renders as **YAML** (indentation and colouring kept), anything doubtful stays **plain text** with its line breaks; `@title` / `@tag` references always keep their highlight colours. Images **fill the node** while staying fully visible. In this form **only the small header buttons are interactive** (▶, parameters, browse…) — the body takes no typing; the wheel scrolls through it and dragging it moves the node.
- **Click the node to select it and it turns back into the edit form**: the body becomes an input again with the caret placed at the end of the main field, ready to type. Clicking empty canvas or selecting another node returns it to browse form.
- Only input (text / image), text-process, image-process, agent-task, chat and save nodes take part in browse form; control-flow / judge / task / super / dev / database / media / network nodes **stay in edit form**.
- **How batch entries read in browse form**: entries stack one below another, each = a **title line** (small monospace cyan text, ellipsised when long) with its **entry content** underneath; text content is rendered as Markdown / YAML the same way, image entries show that item's thumbnail, and a thin divider separates entries. When there are many entries the body scrolls inside the node (scrollbar hidden until you hover the node); an empty body shows “(empty)”.
