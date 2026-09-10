# What agent mode is

> One-sentence goal: work out what “agent mode” can and cannot do, and how to choose a preset and a thinking level.

![智能引擎能力与边界](img/mtnode-agent-01-ui.svg)
*Figure 1: the agent reads / writes / edits files in the **workspace**, searches the web, runs commands and spawns sub-agents — but it **never edits the canvas***

![Agent 预设](img/mtnode-agent-06-ui.svg)
*Figure 2: presets can be picked in four places — the agent session's model menu, the right-hand assistant bar, an agent node's ⚙ settings, and Settings · agent capabilities*

## Goal

After this page you can judge whether a job belongs on an ordinary process node or an agent node, you know where the agent is hard-blocked, and you can pick the right preset and thinking level for the task at hand.

## Before you start

- A **text provider** with an API key (see [Providers & API](#providers)). Agent tasks, agent sessions and the 🐋 Smart mode of a text-process node all run on this engine.
- The agent runtime ships with the app — **no separate Node install**.
- If you plan to have it write files, first check that the current canvas's [workspace](#workspace) is correct.

## Steps

1. **Recognise the entry points**: an agent task node, an agent session (the top-bar view) and a text-process node with 🐋 Smart turned on all run on the same engine.
2. **Know what it can do**: read / write / edit workspace files, search the web and fetch pages, run commands in the workspace, spawn sub-agents, use installed skills and connected MCP tools, read images (`mtnode_vision`), use wired-in `@` references, batch / aggregate, and the model you picked. It **cannot** read or edit the canvas, create nodes and wires, or change workflows — use an agent session or the global assistant to build a graph.
3. **Watch the process**: a run shows “◉ 思考中 (Thinking)”, and you can expand the reasoning and the **🔧 tool calls**. Agent mode is billed per completed task, and one task may call the model several times.
4. **Pick a preset** (see the table below): switch it in any of four places — the agent session's model menu, the right-hand assistant bar, an agent node's **⚙ 设置 (Settings)** window, and **设置 · 智能能力 · Agent 预设 (Settings · agent capabilities · Agent preset)**.
5. **Pick a thinking level**: the UI offers only two levels, 标准 (Standard) / 最强 (Max) — whatever you pick is what runs, and a preset **never** rewrites the thinking level for you.
6. **Check permissions**: the agent's actual authorisation comes solely from the runtime tool permissions — see [Approvals](#approvals).

## Agent presets: pick a voice

| Preset | What it's for |
| --- | --- |
| **极简模式 (Minimal)** (default) | The easy-going one: fewest steps, least talk, straight to the result |
| **标准模式 (Standard)** | General purpose: canvas orchestration plus file and content tasks, with fairly complete explanations |
| **思维精简 (Lean Thinking)** | The **compressed-thinking** preset: reasoning squeezed into a symbolic skeleton — cheapest on tokens (the thinking level still follows your own setting, and this preset no longer lowers it by itself) |
| **PTC 模式 (PTC)** | Engineering: write code / edit files / run commands; read before you change, then say what changed and how to verify it |
| **创造模式 (Creative)** | Cordis plugin development: follow the Service / ctx.effect / typed-event conventions |

> **The default is 极简模式 (Minimal)**: new agent sessions, new agent nodes, and settings you have never touched all use it. When you want the fuller general-purpose voice, switch to **标准模式 (Standard)** in any of the four places above. (A configuration that already saved a choice keeps running on that choice — nothing is silently rewritten.)

### Why Lean Thinking saves tokens

Agent tasks are billed on what the model outputs, and **reasoning content is output too** — one request can burn a thousand-odd tokens of inner monologue to deliver a few lines. Lean Thinking squeezes from three sides at once: **structure first** (compress the task into one `GOAL/GIVEN/DECIDE` line before you start), **fixed skeleton** (reasoning may only run `GOAL` → `APPROACH` → `EDGE` → `DO` — no added sections, no restating the request or tool output), and **cut the filler** (any sentence that does not change the next decision is left out; a missing fact is read / searched / queried at the source).

What you save is the **expression** of reasoning: this preset only shapes how thinking is written, and it **does not touch the thinking level**. **Delivery is unaffected** — tool authorisation still comes from the runtime tool permissions, and the output port and save nodes still receive the complete body text.

> This preset was once called “Sketch mode” (internal id `sketch`); it is now **思维精简 (Lean Thinking)** (internal id `lean`). A `sketch` stored in an older session or agent node is normalised to `lean` automatically, so there is nothing to re-set.

### The cost

- **It may think one step less**: branches outside the skeleton never get expanded, and the more a judgement call needs repeated weighing, the easier it is to miss detail.
- **When you do need deep reasoning**: pick 最强 (Max) as the thinking level, or switch back to **标准模式 (Standard) / PTC 模式 (PTC)**.
- **What the UI shows is what runs**: the model chip and the thinking-level item show only the level you picked — there is no longer a “nominal vs effective” pair of names for one setting.

## While it runs: thinking and output are separate

A run is displayed in **chronological segments**, and the three kinds each look different:

- **◉ 思考 · N 字 (Thinking · N chars)**: the model's internal reasoning, collapsed by default; N counts **reasoning characters only**, not tools or body text.
- **Body text**: what the model actually says — normal font size, rendered as Markdown, one block per paragraph; text spoken at intermediate steps appears as body text too.
- **🔧 工具 (Tools)**: the call trace sits inline where it happened, and you can open it for arguments and results; an error appears as **⚠** attached to the body text.

Every tool call, and every entry into a new reasoning step (turn / step), starts a new segment. An agent task node (chat mode included), an agent session and the right-hand global assistant use **the same segmentation**; the big “Thinking” window on a node shows reasoning on the top half and output on the bottom half. **Downstream data is unaffected**: the output port, and whatever a save node stores, still receive the complete body text.

## Communication language (agent taste)

Once you pick the UI language with the top-bar **中 / EN** button, that language ships with every agent run as a “taste”: **converse in that language, and expect the agent to answer in it** — questions, plans, progress notes and final answers all follow the UI language, and so do the sub-tasks and dev-block bound sessions it spawns. Settings · agent capabilities shows which language is currently in use.

The taste constrains **conversation** only. Code, paths, commands and API field names stay verbatim; fact-library records, table cells and the bodies written back into files keep the language of the source material — switching the UI language never translates them. When the user names another language explicitly in a turn, the user wins.

## Complex tasks plan first (confirm, then run item by item)

When an agent session or an agent task node receives a request, it first judges complexity: anything already spelled out, or simple, starts right away; anything judged complex **changes nothing in that turn** and only replies with a plan. The app then plays a sound and opens the **计划确认 (Plan confirmation)** window — resizable, with a ⤢ maximise button, one task per row in three columns (title / detail / execution model), rows you can add, delete and reorder, and same-named 并行组 (parallel groups) that run concurrently; after you confirm, the list runs item by item, each in its own turn with its own chosen model. The **计划 (Plan)** panel at the bottom of the session is the persistent view of that list, and after an interruption you can **▶ 继续执行 (resume)**.

**Plan dialog never appeared? The app adds one more try.** The model occasionally slips up at exactly this step (markers mangled, closing marker missing, or the JSON printed straight into the body). At the end of every turn the app runs a **keyword check**: only when that turn really was asked for a plan *and* the body shows plan-block markers or both `goal` + `tasks` field characteristics (the two together) does it call it a missed dialog and automatically send back a correction asking for the output once more. The boundaries are deliberately tight: at most one retry per user turn, and never when you stopped that turn or your own messages are still queued.

## Auto-resend on failure · Stop means stop right now

A failed agent run (most often a 429 rate limit, a 5xx, or a network blip) is no longer simply skipped: the app **waits 5 seconds and resends the same turn unchanged**, up to 5 times, and only then reports failure. While it waits, the turn still counts as “running” — the plan does not advance, new input still queues, and the run queue still holds it. A resend **prefers to continue from where it stopped** (same engine session, reusing the text already produced, so no tokens are burned twice); only when it cannot continue does it resend the whole turn, and a full resend clears the previous turn's leftover text first so nothing is doubled up.

**Pressing ■ stops immediately and never enters the resend ladder.** Agent sessions, agent task nodes, the global assistant, run-queue rows, the 稍后 / 中断任务 (later / abort task) buttons on question cards and 全部终止 (stop all) share one termination verdict: once a turn is declared dead, the remaining resend budget is void on the spot. Termination applies precisely per runKey — stopping one session never drags another parallel session's resend down with it.

## Result

You can say whether a job should use an agent node, you can switch the preset to a suitable level in any of the four places, and you can read the division of labour between the thinking / body / tool segments during a run.

## Common mistakes

| Symptom | Cause | Fix |
| --- | --- | --- |
| The agent node says “turn off the canvas-unrelated switch first” | The session has 与画布无关 (canvas-free) on, so no canvas tools are registered this turn | Turn the switch off and run again — see [Agent task & session](#agent-nodes) |
| You asked it to build a workflow and nothing happened | An agent **node** does not edit the canvas | Use an agent session or the right-hand global assistant |
| Output seems to be buried inside “Thinking” and you cannot see it | That is the model's reasoning segment, collapsed by design | Expand “◉ 思考 (Thinking)” to read it; the body segment is the deliverable |
| The result repeats itself / looks like doubled text | A full resend clears leftover text first, so it normally does not happen | If it still looks wrong, stop and run one item again |
| It burned more tokens than expected | You used the Standard preset or a long context | Try **思维精简 (Lean Thinking)** on long sessions, and consider 与画布无关 (canvas-free) to trim the prefix |
| It wrote the file somewhere else | Wrong working directory | Set the current canvas's working directory in the top bar — see [Workspace & archives](#workspace) |

## Next

- [Agent task & session](#agent-nodes)
- [Approvals](#approvals)
- [Plugins, skills, MCP](#plugins-skills)
