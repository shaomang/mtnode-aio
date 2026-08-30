# Dev nodes (software project architecture)

A dev node is a **special super node** (`dev:true`) that breaks a software project into a **tree of feature blocks** right on the canvas — architecture design plus development management. Every dev node is bound to a real project and has three header buttons: 建议 (Suggest) / 开发 (Develop) / 细化 (Refine).

## Element hierarchy (distinct frame colors)

| Type | Frame | Purpose |
| --- | --- | --- |
| **Module (feature block)** | green | A module / subsystem of the project; its overview (note) states its role |
| **File** | blue | Refinement product pointing to a source file |
| **Class / Interface / Enum** | orange / purple / pink | Class-diagram elements, usually refined from a File |

Default frames by element type: module `#6fe3a5` · file `#6db4ff` · class `#ffb454` · interface `#c792ea` · enum `#ff8fa3`.

Create: right-click empty canvas → **Dev node (project architecture · feature block)** → pick an element type (module / file / class / interface / enum). The same menu also holds the **Execute node**, for binding a project's launcher script or executable.

## Function color cards (automatic coloring by role)

When a feature block is created, the engine picks its frame color from a **function color card** — one color per kind of responsibility — so an architecture reads as color-coded zones without you tinting block by block.

| Function card | Frame | Typical keywords (title / overview) |
| --- | --- | --- |
| **Core runtime** | `#6db4ff` blue | 主进程 · 启动 · 窗口 · 菜单 · 快捷键 · 编辑器 · 引擎 · `main` `runtime` `electron` `core` |
| **Canvas & interaction** | `#45cfe6` cyan | 画布 · 连线 · 排版 · 面板 · 视图 · 缩放 · 拖拽 · `canvas` `layout` `ui` `css` |
| **AI & agents** | `#c792ea` purple | 智能体 · 会话 · 助手 · 提示词 · 模型 · 推理 · `agent` `llm` `model` `prompt` |
| **Data & storage** | `#4dd0c4` teal | 数据库 · 存储 · 缓存 · 配置 · 导入导出 · 副本 · 迁移 · `db` `storage` `json` |
| **Media & local backends** | `#ff8fa3` pink | 文生图 · 音乐 · 视频 · 音频 · 语音 · 显存 · 后端 · 权重 · `music` `video` `tts` `gpu` |
| **Plugins & ecosystem** | `#f0c14d` yellow | 插件 · 技能 · 扩展 · 商店 · 云端 · 服务端 · `plugin` `skill` `store` `server` |
| **Build & diagnostics** | `#ff9d5c` warm orange | 构建 · 打包 · 发布 · 脚本 · 更新 · 日志 · 崩溃 · `build` `npm` `updater` `ci` |
| **Tests & quality** | `#a8e05f` lime | 测试 · 冒烟 · 断言 · 覆盖率 · 用例 · 回归 · `test` `smoke` `lint` `e2e` |

- **What it reads**: only the block's **title + overview** are keyword-matched (Chinese as substrings, English as whole words, so `ai` never matches `chain` / `detail`). A title hit counts double versus an overview hit; the highest score wins. **No hit at all = no coloring**, the block keeps the default module green.
- **Modules only**: function colors apply to the **Module** layer; `File / Class / Interface / Enum` keep their own element-type colors, so the hierarchy stays readable by color alone.
- **Priority: your manual pick > function color > element-type default.** Auto-coloring writes once, at creation — afterwards you can recolor freely in the picker. "Restore element-type color" drops the manual pick *and* the automatic function color.
- Blocks an agent creates get the same automatic coloring, and you can simply ask the assistant to "color these blocks as X"; it asks before restyling anything.

## Key settings

- **Overview note** (required, ≤200 chars total): **two sections**, one line each, fixed order — never write only one section.
  - **【功能】≤80 chars · for non-technical readers**: business/user language on what the module does, who it serves, and what problem it solves — no filenames, function names, class names, or framework names. Example: “Lets users assemble workflows like building blocks: place nodes on the canvas, wire them, hit run, and watch each step's output.”
  - **【实现】≤120 chars · for engineers**: an implementation summary — tech stack / language, key files or directories, data flow and external interfaces, dependencies and boundaries (what this block is *not* responsible for). Example: “Electron renderer, directory: renderer/. app-canvas.js draws nodes and wires; app-nodes.js handles add/remove and batch edits; state flows one way.”
  - Old single-section overviews still display normally and are auto-upgraded to two sections on the next 细化 / 开发 / 建议 (Refine / Develop / Suggest) run.
- **Project root devPath**: set on the **top-level module** (absolute path); children inherit the nearest ancestor’s project root.
- **Status devStatus**: pending / wip / done.
- **Nesting**: **refining is measured in depth, not in how many children a single level gets** — by default it refines **deep until nothing more can be split** (every child re-checked: module → file → class / interface / enum), or you can choose **this layer only** (create 1 layer here, then press 细化 on each child separately). The result should be a **multi-level tree of feature blocks**. Always propose the outline before creating children.
- **Node color devColor**: the small **color button** next to the element-type badge (dot = current color) opens an **HSV picker** (S×V square + hue bar, or type a hex) and recolors that block's frame and running glow; "restore element-type color" reverts it. The picker also has a **function color card row**: 8 category swatches (hover for the name) — **click one to set this block to that function color** (exactly the same as picking the same value in HSV, and undoable); ignore the row and keep dragging HSV / typing hex if you prefer.
- **Agent model devModel**: the 🧠 button in the header lists models grouped by provider. Once picked, this block's 建议 (Suggest) read-only run **and** its 开发 / 细化 (Develop / Refine) bound sessions use that model; **child blocks that never picked one inherit the nearest ancestor** (a child's own pick always wins). Every confirmation dialog has an "Agent model" row (the collapsed card body stays lean — no permanent effective-model row), and "follow default (unset)" clears it.
- **Consensus file AGENTS.md**: when a dev-node architecture is generated (built-in skill scan mode / new-project build), an `AGENTS.md` is also produced at the **project root** (directory conventions + a do-not-modify list). It is the shared core consensus for every Suggest / Develop / Refine session — new sessions read it first: where files belong, and which paths (e.g. `dist/`, migrations, secrets) must never be touched. The architecture puts an **`agent.md` entry node** (file type) at the outermost level: its **Open** button opens this consensus file in the in-app **Markdown reader** for viewing / editing / saving (falls back to the existing AGENTS.md when agent.md is absent).
- **Readers (Markdown / YAML)**: the two in-app text readers support **viewing, outline jump, editing and saving** — open `.md` / `.yaml` files (save-node Open, dev file-node Open, or from the OS) to pop one up; hit **Edit** to edit the full text, then `Ctrl+S` or **Save** writes it back.

## Three buttons (each opens a confirmation dialog)

- **建议 (Suggest)**: after confirm, the AI does a **read-only** pass (real project code + this module’s dev progress) and returns **exactly 4** next-step options. In the same dialog you **multi-select + add a supplement**, then click **开发 (Develop)** inside that dialog to start with your chosen plan. Results are cached (viewing the last suggestion does not re-run; “换一批 / another batch” does).
- **开发 (Develop)**: shows the module title / overview / status / **Agent model**; you type what to build or iterate, then it runs in a **new bound session** (workspace = project root, titled 开发 · 模块名, history kept, model = the block's own or inherited pick).
- **细化 (Refine)**: confirms whether to expand children. **Refine means depth, not one layer's child count**: the dialog adds a **“细化深度 / refine depth” radio** — “深度细化到无法再细 / refine deep until nothing more can be split” (default: keep drilling every child down until it truly cannot be split, usually to file level) or “只展开本层 / this layer only” (create 1 layer here, then refine each child on its own) — plus a **depth statistics line** for the current subtree (e.g. “当前已 3 层 · 5 个块未到文件级（如 A、B、C）” / “当前已 4 层 · 已细化到文件级” / “当前 0 层（尚未展开下层元素）”). It first reports a **multi-level plan tree (outline list)**, creates the nodes layer by layer after **one single** confirmation, and tells you clearly when refining is unnecessary or impossible (including “already refined as deep as it can go”).

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
