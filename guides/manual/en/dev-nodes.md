# Dev nodes (software project architecture)

A dev node is a **special super node** (`dev:true`) that breaks a software project into a **tree of feature blocks** right on the canvas — architecture design plus development management. Every dev node is bound to a real project and has three header buttons: 建议 (Suggest) / 开发 (Develop) / 细化 (Refine).

## Element hierarchy (distinct frame colors)

| Type | Frame | Purpose |
| --- | --- | --- |
| **Module (feature block)** | green | A module / subsystem of the project; its overview (note) states its role |
| **File** | blue | Refinement product pointing to a source file |
| **Class / Interface / Enum** | orange / purple / pink | Class-diagram elements, usually refined from a File |

Create: right-click empty canvas → **Dev node (project architecture · feature block)** → pick an element type (module / file / class / interface / enum). The same menu also holds the **Execute node**, for binding a project's launcher script or executable.

## Key settings

- **Overview note** (required, ≤200 chars): one sentence on the module’s role in the project — agents locate modules by it.
- **Project root devPath**: set on the **top-level module** (absolute path); children inherit the nearest ancestor’s project root.
- **Status devStatus**: pending / wip / done.
- **Nesting**: refine one layer at a time (onion-peel), always propose the outline before creating children.
- **Node color devColor**: the small **color button** next to the element-type badge (dot = current color) opens an **HSV picker** (S×V square + hue bar, or type a hex) and recolors that block's frame and running glow; "restore element-type color" reverts it.
- **Agent model devModel**: the 🧠 button in the header lists models grouped by provider. Once picked, this block's 建议 (Suggest) read-only run **and** its 开发 / 细化 (Develop / Refine) bound sessions use that model; **child blocks that never picked one inherit the nearest ancestor** (a child's own pick always wins). The collapsed card shows the effective model (with its source block when inherited), every confirmation dialog has an "Agent model" row, and "follow default (unset)" clears it.

## Three buttons (each opens a confirmation dialog)

- **建议 (Suggest)**: after confirm, the AI does a **read-only** pass (real project code + this module’s dev progress) and returns **exactly 4** next-step options. In the same dialog you **multi-select + add a supplement**, then click **开发 (Develop)** inside that dialog to start with your chosen plan. Results are cached (viewing the last suggestion does not re-run; “换一批 / another batch” does).
- **开发 (Develop)**: shows the module title / overview / status / **Agent model**; you type what to build or iterate, then it runs in a **new bound session** (workspace = project root, titled 开发 · 模块名, history kept, model = the block's own or inherited pick).
- **细化 (Refine)**: confirms whether to expand children. It first reports an **outline list**, creates nodes only after your confirmation, and tells you clearly when refining is unnecessary or impossible.

## Relationship wires (rel)

Express dependencies / calls / implementations between elements with **relationship wires** (choose “relationship” when wiring; optional text label and arrowheads). Each one is a **plain straight line** (no elbow routing) and never executes — pure architecture. Arrowheads can be **→ forward / ← backward / ←→ two-way / — none**; double-click the line (or its label) to edit the label.

When an expanded module block has many relation lines, the engine plans **all lines of that level together**: each line leaves and enters a block where the centre-to-centre line crosses its border, several lines on the same edge fan out to different anchors, near-coincident straight lines slide apart along their edges until they are distinguishable, and line labels push each other apart. The fan order starts from the opposite block's centre, then converges one or two passes toward the **actual incoming direction** — a pass is kept only if straight-line crossings strictly decrease, otherwise the previous arrangement is restored (no flapping).

The shell's **“Input / Output” captions sit outside the board** (input beyond the left edge, output beyond the right edge, level with the first inner port row), so they never cover ports inside the sub-canvas; a side with no ports shows no caption at all.

**Click any node** (including a block inside an expanded shell): its relationship lines light up (cyan + glow, arrowheads follow) while unrelated ones fade into the background. Clicking a line itself still means **orange = this line selected**; click empty space to clear.

## Layout (architecture stops collapsing into one blob)

- **Relationship wires now take part in auto layout**: the top-bar “Auto layout” and the dev node's right-click **“Tidy Inside by Relations (layered · undoable)”** put blocks into **layers along the arrow direction** (left → right) and reduce crossings. Wires that would close a cycle are automatically demoted to *soft* constraints (ordering only, no layering), so two-way / back references can't deadlock the layout.
- Layered graphs automatically get **wider gaps** (~196px between columns, ~92px between rows) so straight lines cross fewer blocks and never stack.
- **Expanded shells grow to fit their content** after refining / bulk creation / packing children — no more clipping by the default 720×480 stage.
- Conversely, tidying a dev node's inside **shrinks the shell to fit** the architecture.

## Where to start

- Existing project: let the AI use the built-in skill **mtnode-dev-architect** to scan the project folder and generate a dev-node architecture covering the whole project.
- New project: build the architecture first (top modules → refine files / classes); after your confirmation, develop block by block on the canvas.
- When uncertain (add a plugin? tech choice?), the AI asks you first — it never decides on its own.
