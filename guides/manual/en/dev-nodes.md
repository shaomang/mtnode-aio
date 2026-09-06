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
- **Project root devPath**: set on the **top-level module** (absolute path); children inherit the nearest ancestor’s project root. It also decides where agents on this canvas write files — see “Project root = the agent workspace” below.
- **Status devStatus**: pending / wip / done.
- **Nesting**: **refining is measured in depth, not in how many children a single level gets** — by default it refines **deep until nothing more can be split** (every child re-checked: module → file → class / interface / enum), or you can choose **this layer only** (create 1 layer here, then press 细化 on each child separately). The result should be a **multi-level tree of feature blocks**. Always propose the outline before creating children.
- **Node color devColor**: the small **color button** next to the element-type badge (dot = current color) opens an **HSV picker** (S×V square + hue bar, or type a hex) and recolors that block's frame and running glow; "restore element-type color" reverts it. The picker also has a **function color card row**: 8 category swatches (hover for the name) — **click one to set this block to that function color** (exactly the same as picking the same value in HSV, and undoable); ignore the row and keep dragging HSV / typing hex if you prefer.
- **Agent model / preset / thinking effort — devModel · devPreset · devEffort**: the 🧠 button in the header opens the **Agent settings** popover with **three cells — Preset / Model / Thinking**, the very same ladder and semantics the agent-session menu uses (click a cell to list only that cell's options). Whatever resolves here is what this block's 建议 (Suggest) read-only run, its 开发 / 细化 (Develop / Refine) bound sessions **and** its 问询 (Ask) session run with; with nothing picked anywhere the app default applies (**default = 极简 (Minimal) preset** with 标准 / `high` effort).
  - **Preset `devPreset`**: an `AGENT_PRESETS` entry — 极简 (Minimal, **default**) / 标准 (Standard) / 思维精简 (Lean Thinking) / PTC 模式 / 创造 — listed in ladder order, first row = the default (hover an option for its one-line description; the legacy `sketch` id is recognized as 思维精简).
  - **Model `devModel` (+`devProvider`)**: models grouped by provider (`devProvider` optional — the app resolves the route from the model).
  - **Thinking `devEffort`**: a value from the shared thinking-effort ladder (the same table the new-session / assistant thinking menus use) — `low`=轻 (Light) / `medium`=中 / `high`=标准 (Standard, **default**) / `xhigh`=强 / `max`=最强 (Max). The cell surfaces **four levels — 轻 (Light) / 标准 (Standard) / 强 (Strong) / 最强 (Max)** (`medium` is a legal vocabulary value, but the default DeepSeek route clamps it to `low`, so it is not surfaced in the UI); the level you pick is what runs, and anything outside the vocabulary is never stored.
- **Each of the three inherits up on its own**: model, preset and thinking are resolved **independently** by walking the parent chain to the **first block that picked a value** — so you can set model + preset once on the top-level block and still give one child a different thinking level, and a child's own pick always wins. **Empty = follow the default** (never "no value, no run"). Inherited values are tagged “（继承）/ (inherited)” with a ↩ marker, and the line under the cells says which block you're inheriting from. The node button reads `model · preset · thinking` (dashed = the model comes from an ancestor; all three unset = 自动); the **建议 (Suggest)** and **问询 (Ask)** dialogs each list three rows — Agent model / Agent preset / Thinking effort — while the **开发 (Develop)** dialog lists the resolved model (preset and thinking are passed down just the same); the collapsed card body stays lean. **Clear**: switch to that cell and hit “follow default (unset)” at the bottom — it only resets that one cell, and it's undoable.
- **The thinking level comes from the setting alone**: what a cell shows — 轻 (Light) / 标准 (Standard) / 强 (Strong) / 最强 (Max), i.e. `low` / `high` / `xhigh` / `max` — is exactly what this round runs. **Presets no longer rewrite it** (previously 思维精简 (lean) silently capped 标准 down to `low`; that cap has been removed), so there are no longer two names, "nominal" vs "effective", for one setting; when a route cannot serve the chosen level the gateway clamps the request to the nearest lower supported one and reports an `effort` event (the UI shows “chosen → actually applied”). Each 建议 (Suggest) job logs one line — `This round: provider · model · preset · thinking` — naming only the items actually picked and the ancestor block whenever a value is inherited.
- **Agent read / write**: `mtnode_canvas_get` returns `devPreset` / `devEffort`; `mtnode_canvas_edit` create / update patches accept them just like `devModel` (empty string clears back to the default; an unknown preset id is refused with a warning, and thinking only accepts the vocabulary `low` / `medium` / `high` / `xhigh` / `max` — anything else is dropped with a warning).
- **Core file list devFiles**: the **“文件 N”** button under the collapsed card expands this module's most important source files (**up to 10, relative to the project root**); clicking a row reveals the file in the OS file manager. Written back by 开发 / 细化 (Develop / Refine) sessions, hand-editable, and auto-collected as a fallback when empty. **The outermost (project) block lists nothing.** See “Core file list” below.
- **Consensus file AGENTS.md**: when a dev-node architecture is generated (built-in skill scan mode / new-project build), an `AGENTS.md` is also produced at the **project root** (directory conventions + a do-not-modify list). It is the shared core consensus for every Suggest / Develop / Refine session — new sessions read it first: where files belong, and which paths (e.g. `dist/`, migrations, secrets) must never be touched. The architecture puts an **`agent.md` entry node** (file type) at the outermost level: its **Open** button opens this consensus file in the in-app **Markdown reader** for viewing / editing / saving (falls back to the existing AGENTS.md when agent.md is absent).
- **Readers (Markdown / YAML)**: the two in-app text readers support **viewing, outline jump, editing and saving** — open `.md` / `.yaml` files (save-node Open, dev file-node Open, or from the OS) to pop one up; hit **Edit** to edit the full text, then `Ctrl+S` or **Save** writes it back.

## Three buttons (each opens a confirmation dialog)

- **建议 (Suggest)**: after confirm, the AI does a **read-only** pass (real project code + this module’s dev progress) and returns **exactly 4** next-step options. In the same dialog you **multi-select + add a supplement**, then click **开发 (Develop)** inside that dialog to start with your chosen plan. Results are cached (viewing the last suggestion does not re-run; “换一批 / another batch” does).
- **开发 (Develop)**: shows the module title / overview / status / **Agent model**; you type what to build or iterate, then it runs in a **new bound session** (workspace = project root, titled 开发 · 模块名, history kept — and it runs with the block's own or inherited model, preset **and** thinking effort).
  - **“先拷问需求 (grill-me)” checkbox**: when ticked, that session does **not** start building — it first applies the built-in skill `mtnode-grill-me`, maps the requirement into a decision tree and works off the **whole frontier** round by round. **Every round goes through MTNode's own question dialog** (the “🐋 模型等待你的回应 / the model is waiting for you” card at the bottom of the screen): all of that round's questions pop up at once, each with its candidates and **the recommended option listed first, labelled “（推荐）/ (recommended)”**, so you just click an option (or type your own under 其他 / Other) instead of typing answers into the chat box; facts it could look up itself are never put to you. It only starts implementing once the frontier is empty and you explicitly pick “确认无歧义 / no ambiguity” in the dialog. **The switch sticks to the feature block** (stored as the node's `devGrill`, saved with the canvas), so it is still ticked next time you open 开发 and you can untick it any time; when off, the session contract is **byte-identical** to before. 细化 and 建议 → 开发 share the same task brief, so the switch applies there too; the read-only **问询 (Ask)** session is unaffected.
- **细化 (Refine)**: confirms whether to expand children. **Refine means depth, not one layer's child count**: the dialog adds a **“细化深度 / refine depth” radio** — “深度细化到无法再细 / refine deep until nothing more can be split” (default: keep drilling every child down until it truly cannot be split, usually to file level) or “只展开本层 / this layer only” (create 1 layer here, then refine each child on its own) — plus a **depth statistics line** for the current subtree (e.g. “当前已 3 层 · 5 个块未到文件级（如 A、B、C）” / “当前已 4 层 · 已细化到文件级” / “当前 0 层（尚未展开下层元素）”). It first reports a **multi-level plan tree (outline list)**, creates the nodes layer by layer after **one single** confirmation, and tells you clearly when refining is unnecessary or impossible (including “already refined as deep as it can go”).
- **Prompts / confirmations left over from a finished turn dismiss themselves**: 建议 / 开发 / 细化 each run as their own turn, and only the questions, approvals and canvas / database confirmations that **this** turn actually raised reach you. Late frames from a previous turn's background jobs — or from a fresh runtime's warm-up turn — are rejected at the gateway (that tool call simply fails and the AI carries on), and a confirmation dialog already on screen whose turn has ended **closes itself** with “发起轮已结束，未执行 / the turn that raised it has ended, nothing ran”. No more “an extra prompt window pops up mid-run and does nothing when you answer it”.

## Core file list (the “文件 N” button)

Every feature block can record **the few source files that matter most for that module**, so you can jump straight to them on disk instead of expanding the shell and hunting through the project tree.

- **Where**: in the button row under the collapsed card's body, after 打开 (Open) and before 会话 N (Sessions), there is a **“文件 N”** button (N = number of entries; with none it just reads 文件). **Click it to expand the list**, click again to collapse.
- **Clicking a row opens the folder that contains the file** (reveals it in the OS file manager). Each row shows the file name plus a grey relative path; entries that no longer exist are marked 不存在 (missing). The panel header also has **打开项目根 (Open project root)**, which opens this block's project root folder.
- **At most 10 entries**: anything beyond the cap is dropped with a toast telling you the excess was ignored. Relative and absolute paths are both accepted — an absolute path inside the project root is folded into a relative one for display.
- **The outermost (project) block lists nothing**: the top block stands for the whole project, so a “core file” list there is meaningless. It shows **no 文件 button** and rejects session write-backs.
- **Where the entries come from (three sources)**:
  1. **Session write-back** — when the module's 开发 / 细化 / 建议 (Develop / Refine / Suggest) session wraps up, it writes the real core files back here (this is a standing requirement in the task brief), which is what keeps the list trustworthy over time;
  2. **You edit it** — click **编辑 (Edit)** in the panel header and type one path per line (relative to the project root, e.g. `renderer/app-devnode.js`); “自动收集 / Auto-collect” and “清空 / Clear” only change the input box, and **nothing is stored until you press 确定 (OK)** (and it stays undoable);
  3. **Automatic fallback** — when neither of the above has content, the app collects a list from the titles of this block's descendant **file** blocks plus path-like tokens in the 【实现】 section of its overview. The header then says **“自动收集 · 点『编辑』确认” (auto-collected · press Edit to confirm)**; glance at it and press OK to turn it into a confirmed list.
- **Prerequisite**: relative paths resolve against the project root this block inherits (`devPath`). Without one the list can still be saved, but revealing a file tells you to set the project root on the top-level block first.
- **For assistants**: `mtnode_canvas_get` returns this list (plus `devFilesAuto` when it is only the automatic fallback), and `mtnode_canvas_edit` writes or clears it via the `devFiles` patch (`[]` clears) — so you can simply ask “fill in the core files for these blocks”.

## Project root = the agent workspace

As soon as one dev node on a canvas has a **devPath**, that canvas becomes a **project canvas**: **every agent run on it resolves its working directory to the project root** — not to the canvas folder you picked in the toolbar. That is what lets the AI read and edit your real code, and it is also where “the file ended up in the wrong place” confusion comes from, so it gets its own section.

### Effective workspace per entry point (left → right, first hit wins)

| Entry point | Priority | Notes |
| --- | --- | --- |
| **Assistant** (the ✦ panel right of the canvas) | typed-in directory > **canvas project root** > canvas working directory (toolbar) > app default directory | While the scope is **current canvas**, the typed directory is **ignored** (the field is read-only; it always follows the canvas, project root first) — switch the scope to **global** to pin a folder. Each run freezes its directory at start; switching canvases mid-run changes nothing. |
| **Agent session** (toolbar “Agent sessions”) | the session's typed / 📂 picked directory > **canvas project root** > app default directory | The canvas working directory is **not** a step here: a session with no manual pick follows the project root, and the session list groups by that effective value too. |
| **Feature block 开发 / 细化 (Develop / Refine)** | the project root resolved for that block > generic canvas resolution | Each confirmation **creates a new bound session** whose workspace is written as **the project root** at creation time (so it behaves like a manual pick: editing the top-level devPath later does not rewrite past sessions — change the directory inside that session instead). If the block resolves no project root, it falls back to the generic order (another dev block's root → canvas folder → default), and the dialog warns you. |
| **Feature block 建议 / 问询 (Suggest / Ask)** | the project root resolved for that block > generic canvas resolution | 建议 is a read-only investigation, 问询 lets the AI **read-only** answer a question about this block — neither creates a session, writes a file, or touches the canvas, and neither has a directory you can type into: only this block's project root counts. If the block resolves no root, it falls back to the generic order (another dev block's root → canvas folder → default), shown as “(not set · default workspace)”, and the dialog's yellow banner tells you to set devPath on the top block. |
| **Agent nodes on the canvas** (agent task, text nodes with 🐋 agent on) | the node's typed directory > **canvas project root** > canvas working directory (toolbar) > app default directory | If the toolbar sets a shared working directory, the node's field is **read-only** and inherits it. The run-confirmation preview shows the effective “Working directory”. |

### How the project root is resolved (one single source)

- Only **dev nodes** count (`dev:true`; database super nodes do not).
- Each block resolves devPath **nearest-first**: if it has none, the chain of parents is walked up to the closest dev block that does — so by convention you **fill it once on the top-level module** and the whole tree shares it.
- **Top-level modules win**; empty values and relative paths are ignored (absolute paths only).
- When several **different roots** come out of that scan: if they all live under one parent folder, that **common ancestor** is used (one root covers everything); otherwise the first block in document order wins and you get “This canvas declares several project roots — using the first one.” To pick another: edit the top block's devPath, or **type a directory by hand** in that entry point.
- If the canvas has dev nodes but **no devPath anywhere**, nothing changes (canvas folder / default directory as before) and the assistant notes: set devPath on the top-level module and the working directory will prefer it.

### Side effect: where relative paths actually land

- **They land in the project root, not in the canvas folder.** Ask for “notes.md” on a project canvas and the file appears **under the project root**, not in the folder you picked in the toolbar. Think of this first when a file seems missing.
- To write into the canvas folder (or anywhere else), pick one: **use an absolute path**; **type a directory by hand** in the assistant / session / node (a manual pick always outranks the project root); or work on a canvas **without dev nodes**.
- **Save nodes and super-node subfolders follow a different rule**: their relative paths always resolve against the **toolbar canvas working directory** (plus the ancestor subfolder chain) and are **never redirected by the project root**. So on one project canvas save nodes write the canvas folder while agents write the project root — the two never overlap, which is the number one cause of “where did my files go?”. See [Workspace & archives](#workspace).
- To check what is really in use: the assistant and session directory fields show the **effective** value (not the raw manual text), hover them to read “Source: set by hand / canvas project root (dev node devPath) / canvas working directory / app default directory”, or hit 📂 to open that exact folder.

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
