# Nodes, wires, @ refs

> One-sentence goal: get the canvas operation tricks right — step in and out of super nodes, zoom and pan, run one branch, and drop files onto the canvas.

## Canvas operation tricks

- Double-click a super node to open it and look inside; double-click empty space to go back up a level.
- The wheel zooms and dragging empty space pans.
- The ▶ on a node runs that one branch in wire order; once upstream finishes, downstream follows automatically (this can be turned off in the settings).
- A wire is a data flow: change upstream and re-run it, and downstream updates along with it.
- Dropping a file onto the canvas creates an input node; dropping an image onto an image input node replaces its image.
- Use super nodes to group several nodes together, which helps the canvas render faster.
