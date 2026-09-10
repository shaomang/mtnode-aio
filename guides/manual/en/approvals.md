# Approvals

> One-sentence goal: get clear on what the two switches in the top-right 审批 (Approvals) panel each control, when a card pops up, and which operations are always blocked.

![审批与权限](img/mtnode-agent-05-ui.svg)
*Figure 1: the top-right 审批 (Approvals) panel — permission presets on the top half, tool permissions on the bottom half*

## Goal

After this page you can pick the right permission preset for a job: leave the default unattended mode for everyday runs, and switch to approve-each when you are touching real code or important files; tick off capabilities by category that should not be granted; read the approval card that pops up when a tool oversteps and know what to click; and know the few operations that are hard-blocked no matter how loose the preset is.

## Before you start

- You can already run an agent node or an agent session — see [Agent task & session](#agent-nodes).
- Decide first what it should touch this time: read-only material, workspace files, commands, the web, or images.
- Note that these two groups of settings are **global**: changing them affects every later run, not only the current one.

## Steps

1. **Open the panel**: click **审批 (Approvals)** at the top right of the top bar.
2. **Pick a permission preset**: the top half is 权限预设 (Permission presets), choose one of four:
   - **无人值守 (Unattended)** — workspace read/write, no prompts (default): read and write files in the workspace, no dialogs.
   - **工作区读写 · 逐项审批 (Workspace read/write · approve each)** — can read and write the workspace, and asks you item by item when it needs to overstep.
   - **只读 · 逐项审批 (Read-only · approve each)** — read-only, asking you item by item to overstep.
   - **完全放行 (Full access)** — no directory limit, no prompts.

> ⚠️ Danger: 完全放行 (Full access) opens up both the sandbox and the prompting, so the agent can write paths outside the workspace. Use it only in a throwaway, disposable environment.

3. **Tick tool permissions**: the bottom half lists the capabilities available to the agent, by category. It is **independent of** the permission preset — that one governs the sandbox and “do we ask before overstepping”, this one governs “which capabilities may be called at all”.
4. **Save your own**: the tool permissions can be ticked to change the current preset, or click **＋ 新建 (New)** to **save the current ticks as a custom preset**, which you can then switch to, rename and delete (built-in default presets cannot be renamed or deleted).
5. **Run a task after changing them**: the settings take effect **from the next task**, with no app restart.

### Tool permission categories

- **Canvas**: nodes and wires, control, drawing, layout and grouping, app actions (status / list / rename / select / undo-redo), delete canvas.
- **Core capabilities (engine)**: read file, write file, terminal command, network, sub-agent tasks, goals and task checklists, stream / stop for background commands and sub-agents, ask the user.
- **Vision**: the vision sub-agent.

Each category is either **批准 (approve)** (usable straight away) or **拒绝 (deny)** (hard-blocked); depending on the wording of the product it can also be **询问 (ask — confirm before the call)**. Ticked changes only affect the permission set written into the system prompt **from the next task on**: canvas / app / vision refuse unauthorised calls outright, while core capabilities such as file read, terminal and network are written into the system prompt as constraints.

> 💡 Tip: when unsure, run one round on the default “无人值守 (Unattended) + default tool permissions”, see which tools it actually calls, and only then loosen or tighten — far more accurate than asking for everything up front.

### How to choose a preset (quick reference)

- Just reading material / writing documents, no system access needed: **无人值守 (Unattended)** (default).
- Changing real project code and running commands: **工作区读写 · 逐项审批 (Workspace read/write · approve each)**.
- Let it look but not touch: **只读 · 逐项审批 (Read-only · approve each)**.
- A disposable sandbox environment: **完全放行 (Full access)** (see the warning above).

### What happens with approve-each

With 工作区读写 · 逐项审批 (Workspace read/write · approve each) or 只读 · 逐项审批 (Read-only · approve each) selected, as soon as a task uses a tool that oversteps, an **approval card** appears on screen, stating what is about to happen and offering **允许一次 (Allow once) / 拒绝 (Deny)**.

![审批卡片](img/mtnode-agent-05-demo.svg)
*Figure 2: the approval card slides in from the right → click 允许一次 (Allow once) → the card folds away and the task keeps running (roughly a 4-second looping animation; static fallback `img/mtnode-agent-05-demo-static.svg`)*

Denying does not crash the task: the model receives a failure receipt and then takes a route that does not overstep, or explains in its reply which permission it needs.

### Hard blocks

**Canvas changes, dangerous app-level operations and vision** are hard blocks: even with a loose preset these calls are confirmed or refused outright — they change the thing you are editing (the canvas, app state), or they send your images to an external model. If an agent task reports `mtnode_vision` failing or being disabled, click 始终允许 (Always allow) or 本会话允许 (Allow for this session) in the vision permission; the unattended preset never raises a tool approval, so switch to 工作区读写 · 逐项审批 (Workspace read/write · approve each) when you want item-by-item confirmation.

### The model asks you a question

Mid-task the model can also **ask the user**: a “🐋 模型等待你的回应 (the model is waiting for you)” question dialog appears at the bottom of the screen, listing all of that round's questions at once, each with candidate options (**the small line under an option is the reason the model gives**, the recommended one sits first and is marked “（推荐）(recommended)”), and you can also write your own answer under 其他（自定义回答，选填）(Other — optional custom answer).

- Click **回答 (Answer)** and the round continues.
- **稍后（终止本轮）(Later — stop this round)**: do not answer now and stop the round.
- **中断任务 (Abort task)**: give the question up explicitly (the model receives a failure receipt and is not pushed on with an empty answer).

Requirement grilling (the built-in skill `mtnode-grill-me`) goes through this same dialog.

## Result

- The current preset is visible at a glance in the top-right 审批 (Approvals): unattended for everyday scripts, approve-each when changing a real project.
- A tool that oversteps raises a card where you click 允许一次 (Allow once) / 拒绝 (Deny), and after a denial the task routes around it instead of exiting with an error.
- Canvas changes, dangerous app-level operations and vision are always confirmed or blocked.
- The presets you made stay in the list, ready to switch to at any time.

## Common mistakes

| Symptom | Cause | Fix |
| --- | --- | --- |
| A task reports “current tool preset does not allow: …” | That capability is denied in the tool permissions | Change the tool permissions in the top-right 审批 (Approvals), or switch to another preset |
| With approve-each the task sits there doing nothing | The approval card is waiting for a button | Click 允许一次 (Allow once) or 拒绝 (Deny) on the card and the task continues |
| Vision keeps failing | The vision permission was not granted, or the unattended tier raises no card | Click 始终允许 (Always allow) / 本会话允许 (Allow for this session) in the vision permission, or switch to 工作区读写 · 逐项审批 (Workspace read/write · approve each) |
| Too noisy, dialogs popping up everywhere | You are on an approve-each tier | Switch back to the default 无人值守（工作区读写 · 不询问）(Unattended — workspace read/write, no prompts) |
| You want to delete a custom preset but the button is grey | Built-in default presets cannot be renamed or deleted | Copy it into a new preset and edit that, or simply switch without deleting |

## Next

- [What agent mode is](#dsh)
- [Agent task & session](#agent-nodes)
- [Plugins, skills, MCP](#plugins-skills)
- [FAQ](#faq)
