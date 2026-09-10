# Box, groups, layout

> One-sentence goal: tidy up nodes scattered across the canvas — box-select an area, collapse it into a group, run auto layout with one click, and draw annotations when you need them.

![From box-select to layout](img/mtnode-canvas-03-flow.svg)
*Figure 1: box-select a set of nodes → collapse them into a group (drag as a whole / scale per axis) → one-click auto layout*

## Goal

After reading this you can select a set of nodes, fold them into a group that moves as a whole, annotate zones on the canvas, and spread a messy layout out with one click.

## Before you start

- The canvas already has some nodes on it. An empty canvas has nothing to box-select.
- If you want "super node"-style storage, go to [Super nodes](#super-nodes) — a group is only a visual container, a super node is a real subgraph.

## Steps

1. **Add drawings and annotations**: right-click empty canvas → **Draw (绘制)** (arrow / box / note text). They are annotations only and take no part in execution; you can change their color, stroke and font size, and `Ctrl+C` copies a drawing.
2. **Box-select an area**: `Ctrl+left-click` drag over empty space, or turn on the top-bar **▭ Box (▭ 框选)** and drag directly. Nodes and drawings inside the box are selected together and can be moved / deleted / copied as one.
3. **Make a group**: select several nodes and press `G`, or click the top-bar **◫ Group (◫ 组)** and enter a title. The dashed rounded frame drags as a whole; handles on the frame edges **scale the two axes independently**.
4. **Dissolve a group**: press `G` again, or click the group button to dissolve it; **the nodes themselves are kept**.
5. **Auto layout**: click top-bar **Auto layout (自动排版)** to spread the nodes out along the wire direction and reduce overlap.
6. **Handle layout inside super nodes**: if the canvas has super nodes that are expanded or contain content, the layout asks whether to **lay out the inside as well**.
7. **Look at layout only**: press **Hide wires (隐藏线)** to fade wires to 95% transparency, inspect the layout, and press it again to restore (purely visual — it does not change data and does not enter the undo stack).

> 💡 Tip: when zoning a canvas, first draw a few areas with box drawings, then label them "Input area / Process area / Output area" with note text, and finally place the nodes inside — far easier to read than a pile of bare nodes.

> ⚠️ Danger: when a group is dissolved or deleted the nodes are kept, but **deleting nodes inside a group** is irreversible just like deleting ordinary nodes (only undo can bring them back). Confirm the selected range before a batch operation.

## Result

The canvas is arranged by zone and overlaps are clearly reduced; a set of nodes can be dragged as a whole; and readable arrows and note text remain on the canvas.

## Common mistakes

| Symptom | Cause | Fix |
| --- | --- | --- |
| You dragged out a box but nothing got selected | You used a plain left-drag, which pans the canvas | Hold `Ctrl` with the left button, or turn on the top-bar **▭ Box** first |
| The group came apart when dragged | You dragged a node inside the group instead of the group frame | Drag the dashed frame itself; nodes inside a group can still be selected and moved individually |
| The layout is messier after auto layout | The wire direction is unclear (only one node, or no wires) | Add the wires first, or arrange by hand with drawings |
| Super node interiors were not laid out | You chose "main canvas only" in the layout prompt | Click auto layout again and choose "lay out the inside as well" |
| A drawing covers the nodes | The drawing box sits on top of the nodes | Change the drawing's color / stroke, or move the drawing below the nodes |
| I want to use a group as a subgraph | A group is only a visual container | Use a [Super nodes](#super-nodes) instead |

## Next

- [Find, overview, sidebar](#canvas-tools)
- [Super nodes](#super-nodes)
- [Nodes, wires, @ refs](#nodes-wires)
