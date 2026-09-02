# Global node (broadcast)

Input-only: **broadcast** text / image sources to any number of consumers without repeated wiring.

## How to reference (both steps required)
1. Wire source node(s) into the global node.
2. On the consumer node (text process / **image process** / agent task / judge) **click the top-left type icon** to enable refs (the icon turns rainbow), and write **`@源节点标题`** (source title) — or the source's `@tag` — in the prompt / task.

> Enabling refs alone or writing `@` alone does nothing. Even with the rainbow on, **only global sources you actually `@`-mention** enter this run's input; un-mentioned ones are skipped (the `@` menu still lists every source for picking). Never wire control nodes into a global node.

## Ports
- **Input**: text / image sources (multiple)
- **Output**: none
