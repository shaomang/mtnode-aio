# Global node (broadcast)

Input-only: **broadcast** text / image sources to any number of consumers without repeating wires.

## Ports
- **In**: several text / image sources (control nodes cannot be wired in).
- **Out**: none.

## Settings
- No settings: the node header has no **⚙ settings** window; behaviour comes from the wiring and the rainbow switch on each consumer. Click empty space in the node body to list everything wired in.

## Usage
- Wire the source node(s) into the global node (multiple allowed).
- On a consumer **click the top-left type icon** to enable refs (it turns rainbow), then write **`@源节点标题`** (source title, or that source's `@tag`) in the prompt / task. Enabling refs alone or writing `@` alone does nothing — both are required.
- Valid consumers: Text process / **image process** / FLUX 3 / Qwen Image / Agent task / Judge.

## Notes
- Even with the rainbow on, **only global sources you actually `@`-mention** enter this run's input; un-mentioned ones are skipped (the `@` menu still lists every source for picking).
- When nothing matches, the node says “Global references are on, but the prompt @-mentions none of the global sources — nothing was injected this run” instead of staying silent.
- Never wire control nodes into a global node.
