# Dev nodes

> One-sentence goal: describe a real project as a feature-block tree of “module → file → class / interface / enum”, then let bound sessions write the code into the project root block by block.

![开发节点](img/mtnode-agent-10-ui.svg)
*Figure 1: a dev node — the three header buttons 建议 / 开发 / 细化 (Suggest / Develop / Refine), and 打开 / 文件 N / 会话 N (Open / Files N / Sessions N) on the collapsed card*

## Goal

After this page you can build a **multi-level feature-block tree** covering a whole project on one canvas, bind a project root `devPath` to the top-level block, give each block a model / preset / thinking level with the 🧠 Agent 设定 (Agent settings) popover, drive the design down into real code with the 建议 / 开发 / 细化 (Suggest / Develop / Refine) buttons, and produce an `AGENTS.md` in the project root that every session shares.

## Before you start

- Providers and models configured in [Providers & API](#providers).
- The **absolute path** of a real project (the top-level feature block needs its `devPath`).
- Know [Super nodes](#super-nodes): a dev node is a special kind of super node (`dev:true`), and the only input / output ports it exposes are its boundary ports.
- Know [Approvals](#approvals): dev sessions read and write real files in your project.

## Steps

1. **Create the block**: right-click empty canvas → **开发节点（项目架构 · 功能块）(Dev node — project architecture · feature block)** → pick an element type. The same menu also has the **执行节点 (Execute node)**, which can bind a project's launcher script / executable so you can start it in one click.
2. **Fill in the overview**: the overview note is required, ≤200 characters in total, **in two sections**, one line each, in a fixed order — never write only one:
   - **【功能】([Function]) ≤80 characters · for non-technical readers**: say in business language what the module “does, who it is for, what problem it solves”; file names, function names and framework names are forbidden.
   - **【实现】([Implementation]) ≤120 characters · for engineers**: tech stack / language, key files or directories, data flow and external interfaces, dependencies and boundaries (what this block is not responsible for). Example: “Electron renderer, directory: renderer/. app-canvas.js draws nodes and wires, app-nodes.js handles add / remove / edit and batch editing, state renders one way”.

   A single-section overview on an old canvas still displays normally and is upgraded to two sections on the next 细化 / 开发 / 建议 (Refine / Develop / Suggest).
3. **Bind the project root**: fill in **devPath** (an absolute path) on the **top-level feature block**; child blocks inherit the nearest ancestor's project root automatically. It also decides where agents on this canvas write files — see “Project root = the agent workspace” below.
4. **细化 (Refine)**: click 细化 (Refine) → pick the **refine depth** → look at the **depth statistics** → confirm the **multi-level plan tree (outline list)**. The default is 深度细化到无法再细 (refine deep until nothing more can be split): every child block it produces is checked again for whether it can be split further, drilling all the way down, usually to file level; a file can then be split further into class / interface / enum.
5. **Record core files**: use the **文件 N (Files N)** button on the collapsed card to expand this module's key source files (**up to 10 · relative to the project root**), and click any row to reveal that file in the OS file manager; the panel header also has 打开项目根 (Open project root).
6. **开发 (Develop)**: click 开发 (Develop) → describe what to build or iterate this time → after confirmation it runs in a **newly created bound session** (workspace = project root, session title “开发 · 模块名 (Develop · module name)”, history kept).
7. **建议 (Suggest)**: click 建议 (Suggest) → the AI does a **read-only** investigation (reading the project's real code plus this module's development progress) and returns **exactly 4** next-step options; in the same dialog you **multi-select freely and add notes**, then click 开发 (Develop) in that dialog to start on the chosen options. The result is cached, and only 换一批 (another batch) re-runs it.

![细化逐层下钻](img/mtnode-agent-10-demo.svg)
*Figure 2: refine drills down layer by layer by depth — one click on 细化 (Refine) and child blocks grow out one level at a time along the plan tree (about a 5-second loop; static fallback `img/mtnode-agent-10-demo-static.svg`)*

### Hierarchy and colors

| Type | Frame | Notes |
| --- | --- | --- |
| **模块（功能块）(Module — feature block)** | green | A module / subsystem of the project; its overview (note) states what it does for the project |
| **文件 (File)** | blue | A refinement product pointing at a source file |
| **类 / 接口 / 枚举 (Class / Interface / Enum)** | orange / purple / pink | Class-diagram elements, usually refined from a File |

Default frame colors (element type): module `#6fe3a5` · file `#6db4ff` · class `#ffb454` · interface `#c792ea` · enum `#ff8fa3`.

**功能色卡 (Function color card)**: when a feature block is created the engine keyword-matches **title + overview** and colors it automatically — core runtime `#6db4ff` blue, canvas & interaction `#45cfe6` cyan, AI & agents `#c792ea` purple, data & storage `#4dd0c4` teal, media & local backends `#ff8fa3` pink, plugins & ecosystem `#f0c14d` yellow, build & diagnostics `#ff9d5c` warm orange, tests & quality `#a8e05f` lime. A title hit weighs twice an overview hit, and a keyword that hits nothing means no coloring at all (the module keeps its default green). Function colors apply **to the module layer only**; the priority is **your hand-picked color > function color > element-type default**, and automatic coloring writes only once, at creation. To recolor, use the small color button next to the element-type badge (field `devColor`) → the HSV swatch (you can also type a Hex directly), or click a category swatch in the color card; 恢复元素类型默认色 (Restore element-type default) goes back to the type color.

### 🧠 Agent settings: model / preset / thinking effort

The 🧠 button in the header opens the **Agent 设定 (Agent settings)** popover, with **three cells** side by side at the top — preset / model / thinking effort — the same ladder table and the same semantics as the Agent menu in an agent session. Once set, this feature block's 建议 (Suggest) read-only investigation, its 开发 / 细化 (Develop / Refine) bound sessions and its 问询 (Ask) session all run with these three; with all three unset the app default applies (**default = 极简 (Minimal) preset** plus the 标准 (Standard) `high` thinking effort).

- **预设 `devPreset`**: an `AGENT_PRESETS` entry — 极简 (Minimal, default) / 标准 (Standard) / 思维精简 (Lean Thinking) / PTC 模式 (PTC) / 创造 (Creative); the list order is the ladder order and hovering gives a description (the legacy name sketch is recognised as 思维精简 (Lean Thinking)).
- **模型 `devModel` (+`devProvider`)**: the model list grouped by provider; `devProvider` can be omitted, and the app resolves the route from the model backwards.
- **思考强度 `devEffort`**: `low`=轻 (Light) / `medium`=中 / `high`=标准 (Standard, default) / `xhigh`=强 (Strong) / `max`=最强 (Max); the popover surfaces **four levels: 轻 (Light) / 标准 (Standard) / 强 (Strong) / 最强 (Max)** (`medium` is a legal vocabulary value, but the default DeepSeek route clamps it to `low`, which is why it is not shown in the UI). **The thinking level follows the setting alone**: the level picked in the cell is exactly the one sent this round, and a preset no longer rewrites the thinking level (earlier 思维精简 (Lean Thinking) pushed 标准 down to `low`, and that is gone); when the route cannot serve the chosen level, the gateway clamps it to the nearest lower level on the same side and echoes “chosen level → actually applied level”.
- **The three inherit upward on their own**: model / preset / thinking effort **each** walk up the parent chain to the **first block that picked a value**, independently of the other two — so you can set the model and preset for the whole tree once on the top-level block and still give a single child a different thinking level; if a child picked its own value, the child wins. **Empty = follow the default** (not “nothing inherited, so it does not run”). An inherited value is marked “（继承）(inherited)” with a ↩, and the line below the cells says which block it is inherited from; to clear it, switch to that cell and click 跟随默认（不指定）(follow default — unset) at the bottom, which releases only that cell and is undoable.
- **Agent read / write**: `mtnode_canvas_get` returns `devPreset` / `devEffort`; the create / update patches of `mtnode_canvas_edit` can set them directly (an empty string = clear back to follow-default; an unknown preset id is refused with a report, thinking effort accepts only `low` / `medium` / `high` / `xhigh` / `max`, and any value outside that set is dropped with a report).

### Core file list (the “文件 N” button)

- **Where**: in the button group under the collapsed card's body, after 打开 (Open) and before 会话 N (Sessions N); click it to expand the list and click again to collapse it.
- **Where the list comes from (three sources)**: ① **session write-back** — when the module's 开发 / 细化 / 建议 (Develop / Refine / Suggest) session wraps up it writes the real core files back here, and this is the key to long-term accuracy; ② **you edit it by hand** — click 编辑 (Edit) in the list header and type one path per line, relative to the project root (e.g. `renderer/app-devnode.js`); you can click 自动收集 (Auto-collect) or 清空 (Clear), and **nothing is written until you click 确定 (OK)**; ③ **automatic fallback** — when the first two are both empty, the app collects the list from the titles of this block's lower-level 文件 (File) blocks and from the paths in the 【实现】([Implementation]) section of this block's overview, and the panel then reads “自动收集 · 点『编辑』确认 (auto-collected · click Edit to confirm)”.
- **Cap and exceptions**: beyond 10 entries only the first 10 are kept, with a notice that the excess was ignored; both relative and absolute paths can be written, and an absolute path inside the project root is folded into a relative one for display. **The outermost (project) node lists nothing**: it shows no 文件 (Files) button and does not accept session write-back.
- **Prerequisite**: relative paths resolve against the project root this block resolves to (`devPath`); without a project root the list can still be saved, but opening it tells you to set the project path on the top-level feature block first. On the assistant side, read it with `mtnode_canvas_get` (marked `devFilesAuto` when it is only the automatic collection) and write or clear it with `mtnode_canvas_edit`'s `devFiles` (pass `[]` to clear).

### The three buttons and bound sessions

- **开发 / 细化 (Develop / Refine)** both run in a **newly created bound session** after confirmation: its canvas is the canvas that feature block lives on, and its workspace is written as the project root at creation time (equivalent to a hand-typed directory, so changing the top-level `devPath` afterwards will not go back and rewrite older sessions); model / preset / thinking effort use that block's picked or nearest inherited effective values.
- **A bound session does not read the canvas and writes back by id at the end**: this session has **no** `mtnode_canvas_get` / `mtnode_app` this round (the host does not register them, so a call fails), and the canvas state is whatever the **dev task brief** says; the brief carries **this node's id**, so at the end it uses the `update` of `mtnode_canvas_edit` to write back **概述 (note) · 状态 (devStatus) · 核心文件列表 (devFiles)** by id, without reading the whole graph first just to get the id. If you want the AI to change other nodes on the graph along the way, do it in an [agent session](#agent-nodes).
- **建议 / 问询 (Suggest / Ask)** are read-only: they create no session, change no files and change no canvas, and they recognise only this block's project root.
- **The 先拷问需求（grill-me）(grill me) switch**: when ticked, this session does not start work in its first round; instead it uses the built-in skill `mtnode-grill-me` to map the requirement into a decision tree and works through the whole frontier **round by round** through the “🐋 模型等待你的回应 (the model is waiting for you)” question dialog (the recommended option sits first and is marked “（推荐）(recommended)”), until the frontier is empty and you have confirmed in the dialog — only then does implementation start. The switch is stored on the node as `devGrill` and saved with the canvas.
- **Status `devStatus`**: pending / wip / done.
- **Questions left over from a finished round disappear on their own**: only the questions, approvals and confirmations raised by the current round pop up in front of you; when the round a confirmation belongs to has ended, it closes itself and explains “发起轮已结束，未执行 (the round that raised it has ended, nothing ran)”.

### Relationship wires and layout

Express dependencies / calls / implementations between elements with **relationship wires** (`rel:true`): when wiring, choose 关系 (Relationship), and you can add a text label and an arrow direction. A relationship wire is a **plain straight line** (no elbow routing) and **does not take part in execution** — it is pure architecture; arrows can be → forward / ← backward / ←→ both ways / — none, and double-clicking the line or its label lets you edit the label. When an expanded feature block has many relationship wires, the engine plans the entry and exit points and the fan-out order of all the wires in the same layer as a whole; two nearly overlapping straight lines slide apart along their own edges, and line labels keep out of each other's way automatically. **Click any node**: its relationship wires light up immediately (cyan + glow) while unrelated ones fade into the background; clicking a line itself is still orange = that line is selected.

**Layout**: the top-bar 一键排版 (Auto layout) and a dev node's right-click 按关系线整理内部排版（分层 · 可撤销）(Tidy the inside by relationship wires — layered, undoable) arrange feature blocks **in layers** (left → right) along the arrow direction and reorder them to reduce crossings; wires that form a cycle are demoted to a soft constraint that “only affects order and takes no part in layering”, so two-way / back references do not deadlock the layout. An expanded shell grows to fit its content, while a dev node's 整理内部排版 (Tidy the inside) tightens the shell to fit the content.

### Project root = the agent workspace

As soon as one dev node on a canvas sets a **devPath**, that canvas becomes a “project canvas”: **the effective workspace of every agent run on it becomes the project root**, no longer the canvas directory in the top bar. This is what lets the AI read and write your real code directly, and it is also the place most likely to make you think “the file went to the wrong place”.

The effective workspace per entry point (first hit wins):

- **助手 (Assistant)** (✦ at the right of the canvas): hand-typed working directory > canvas project root > canvas working directory (top bar) > app default directory (when the work scope is 仅当前画布 (current canvas only), hand-typing has no effect).
- **智能会话 (Agent session)**: hand-typed / 📂 picked > **the project root of the canvas it belongs to** > app default directory (the canvas working directory is not a step in this ladder).
- **功能块「开发」/「细化」 (Feature block Develop / Refine)**: the project root resolved for that block > generic canvas resolution (falls back when the block sets none, and a yellow bar at the top of the dialog reminds you).
- **功能块「建议」/「问询」 (Feature block Suggest / Ask)**: the same, recognising only this block's project root, written in the UI as “未设置 · 用默认工作区 (not set · default workspace)”.
- **画布上的智能节点 (Agent nodes on the canvas)**: the node's hand-typed working directory > canvas project root > canvas working directory (top bar) > app default directory.

**How the project root is resolved (one single source)**: only dev nodes on the canvas count (`dev:true`; database super nodes do not); each block takes the nearest `devPath`, walking up the parent chain to the closest dev block that set one when it has none; empty values and relative paths are ignored (an absolute path is required); when several different roots come out, if they all live under one upper directory the common ancestor is used, and if that cannot cover them all the first block in order wins with the message “本画布有多个项目根，已用第一个 (this canvas has several project roots — using the first one)”.

**Side effect: relative paths land in the project root, not in the canvas directory.** Say “write a notes.md” on a project canvas and it appears under the project root. To write into the canvas directory or elsewhere, pick one of three: give an absolute path; hand-type a working directory in the assistant / session / node (a hand-typed directory always outranks the project root); or work on a canvas with no dev nodes. Note that **save nodes and the 子文件夹 (subfolder) of a super node follow a different rule**: their relative paths are always relative to the top-bar canvas working directory and are unaffected by the project root. To confirm which directory is in use, hover the assistant / session working-directory field and read 来源 (Source).

### The consensus file AGENTS.md

When a dev-node architecture is generated (scanning and building a graph with the built-in skill `mtnode-dev-architect`, or setting up a new project), an `AGENTS.md` is also produced in the **project root directory** (directory conventions + a “do not modify” list), as the core consensus shared by every Develop / Refine / Suggest session in this project — a new session reads it before starting: where files go, and which paths (such as `dist/`, migrations, secrets) must never be changed. The outermost level of the architecture holds an **`agent.md` entry node** (File type): clicking its 打开 (Open) opens this consensus file in the in-app **Markdown reader** for viewing / editing / saving (when the project root has no `agent.md`, the existing `AGENTS.md` is opened instead).

## Result

- A multi-level feature-block tree appears on the canvas, with modules zoned by function color and element types distinguishable at a glance by frame color.
- The top-level block is bound to the project root; after 开发 / 细化 (Develop / Refine) run, real files in the project root are rewritten and the node's overview, status and core file list are written back by id.
- The project root gains an `AGENTS.md`, and the outermost level has an `agent.md` entry node you can open and read.
- Relationship wires make the dependency direction clear, and after auto layout the architecture is layered left → right instead of blurring into one mass.

## Common mistakes

| Symptom | Cause | Fix |
| --- | --- | --- |
| A file is written into the project root, not the top-bar canvas directory | A dev node on the canvas sets `devPath`, so the agent workspace becomes the project root | By design; to write into the canvas directory, hand-type the working directory, give an absolute path, or move to a canvas with no dev nodes |
| Clicking the core file list says to set the project path first | That block resolves no project root | Set `devPath` (an absolute path) on the top-level feature block |
| The 文件 (Files) button has disappeared | That is the **outermost project node**, which lists no core files | Look at a lower-level module; the project node does not accept session write-back |
| A child block's thinking level differs from its parent's | The three inherit nearest-first independently, and a child's own pick wins | Open that child's 🧠 and click 跟随默认（不指定）(follow default — unset) to release that one cell |
| Refining did not build the whole structure / only one layer | The refine depth was set to 只展开本层 (this layer only) | Switch to 深度细化到无法再细 (refine deep until nothing more can be split) and run again, or click 细化 (Refine) on each child block |
| You wanted the bound session to change another node on the canvas and it failed | A bound session does not register `mtnode_canvas_get` / `mtnode_app`, keeping only `mtnode_canvas_edit` and only for this node | Do it in an [agent session](#agent-nodes), and make sure 与画布无关 (canvas-free) is off |
| The assistant wrote a file somewhere else | A hand-typed working directory or an absolute path outranks the project root | Clear the hand-typed directory, or state an absolute path explicitly |

## Next

- [Agent task & session](#agent-nodes)
- [Super nodes](#super-nodes)
- [Workspace & archives](#workspace)
- [AI review: notes & revisions](#ai-review)
