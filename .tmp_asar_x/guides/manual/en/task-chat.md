# Tasks and chat

## Task node

An inner control graph: pinned **start**, steps / sub-tasks / judges, and **success / fail ends**. The parent shows sub-tasks as a grid. ▶ fires start. See [Task graph](#task-flow).

## Super node

Packs related nodes into a subgraph (not a control-flow container). Expand the shell or **↪ Enter**; tunnel data via edge ports; optional subfolder for relative paths. See [Super nodes](#super-nodes).

## Chat node

WeChat-style bubbles (assistant left, user right). System prompt, provider, thinking effort. History saves with the workflow; the output port emits the transcript. Enable **Agent** to read files / search / run commands.

## Control · Run / Clear

Wire a control node to targets (or wire targets in), switch **Run / Clear**, then ▶ applies it to all connected nodes. Gold wires are not data.
