# Super node

![diagram](img/super.svg)

Pack related nodes into a subgraph. **Expand** to edit in a shell, or **↪ Enter** for a full inner canvas. Outer / inner edge ports tunnel data; optional **subfolder** places relative paths under the workspace.

## Ports
- **Outer in / out**: when collapsed, connect to the outside
- **Inner bridge (left) / sink (right)**: expanded shell or full-canvas left/right edges after Enter

## Common actions
- Toolbar **Wrap super**: merge selection
- Header: subfolder, Enter, expand / collapse
- Drag in / out to pack / unpack
- Sidebar **Super node** tree: jump in and fit

## Two special modes

| Mode | Enable | Purpose |
| --- | --- | --- |
| **Dev node** (功能块) | Add via the “Dev node” menu, or set a node to dev | Software project architecture: module → file → class / interface / enum, bound to a project root (`devPath`); header buttons 建议 / 开发 / 细化; elements linked with **relationship wires** (rel) for dependencies / calls |
| **Database node** | Enable “Beta” in Settings, then add from the context menu | Fact storage: inner “File node / Table”; header **⚙ Compile** produces a “Database replica”; agent nodes query with `mtnode_db` |

See the manual [Super nodes](#super-nodes), [Dev nodes](#dev-nodes), [Database nodes](#database-nodes).
