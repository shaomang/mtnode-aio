# Tasks and chat

## Task node

An inner control graph: pinned **start**, steps / sub-tasks / judges, and **success / fail ends**. The parent shows sub-tasks as a grid. ▶ fires start. See [Task graph](#task-flow).

## Super node

Packs related nodes into a subgraph (not a control-flow container). Expand the shell or **↪ Enter**; tunnel data via edge ports; optional subfolder for relative paths. See [Super nodes](#super-nodes).

## Agent node chat mode (💬)

The standalone **Chat node was removed**. For WeChat-style multi-turn chat (assistant left, user right, history saved with the canvas), click **💬** in an **Agent task** node header to turn on chat mode — older canvases migrate their chat nodes into that on open. See [Agent task & session](#agent-nodes).

## Control · Run / Clear

Wire a control node to targets (or wire targets in), switch **Run / Clear**, then ▶ applies it to all connected nodes. Gold wires are not data.
