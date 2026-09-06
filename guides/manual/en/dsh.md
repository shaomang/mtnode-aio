# What agent mode is

![Agent](img/dsh.svg)

With DeepSeek Harness (dsh) the model can **read/write the workspace, search the web, run commands, and spawn sub-agents**. The runtime ships with the app—**no extra Node install**.

Configure a **text provider** with an API Key first. Agent task (chat mode included), agent session and text-process **🐋 Agent** all use this engine.

A set of **built-in skills** ships with the engine: they sync automatically, need no install, and the AI loads them by name with the `skill` tool — `mtnode-dev-architect` (dev-node architecture), **`mtnode-grill-me` (interrogate the requirement: map it into a decision tree, ask the whole frontier round by round through MTNode's question dialog (`ask_user_question`) with a recommended option each, and only build once you confirm the shared understanding)**, `mtnode-canvas-batch-safety`, `mtnode-canvas-layout-ux`, `mtnode-db-facts`, `mtnode-media-gen-nodes` (music / speech / video generation nodes). See [Plugins, skills, MCP](#plugins-skills).

## Visible process

Runs show **◉ Thinking** with expandable thoughts and **🔧 tool calls**. Billing is per completed task and may call the model several times.

Confirm the [workspace](#workspace) before writes. See [Approvals](#approvals) for permission presets.

## Segmented thinking and output

A run renders as **chronological segments**, each with its own look:

- **◉ Thinking · N chars** — the model's private reasoning, collapsed by default; N counts **reasoning only**, not tools or prose.
- **Body text** — what the model actually says, normal size, rendered as Markdown, one block per paragraph. Text produced mid-run shows up as text instead of being buried in the thinking block.
- **🔧 Tools** — call chips inline where they happened (click for args and result); errors appear in the body as **⚠**.

A new segment starts on every tool call and on every reasoning step (turn / step). Agent task nodes (chat mode included), agent sessions and the global assistant all share this rendering; the node's Thinking overlay keeps reasoning on top and output (the tool trace) below.

**Downstream data is unchanged**: the output port and save nodes still receive the full text. Sessions archived before this change render exactly as before.

## Agent presets: pick a voice

A preset decides which role and style the agent works in. Pick it in four places: the **model menu → Preset** of agent sessions, the **Preset** dropdown in the right-hand assistant bar, the **Preset** dropdown in an agent node's **⚙ Settings** window, and **Settings → agent capabilities → Agent preset** (the dev-node 🧠 popover reads the same ladder). Five are offered — **the order below is the order in the menus, and the first row is the default**:

| Preset | What it's for |
| --- | --- |
| **Minimal** (极简模式, default) | Minimal steps, minimal talk — straight to the result |
| **Standard** (标准模式) | General purpose: canvas work plus file and content tasks, with fuller explanations |
| **Lean Thinking** (思维精简) | **Compressed-thinking** preset: reasoning collapsed into a symbolic skeleton — the cheapest on tokens (the thinking level still follows your own setting; this preset never lowers it) |
| **PTC** (PTC 模式) | Engineering: write code / edit files / run commands; reads before editing, then reports what changed and how to verify |
| **Cordis** (创造模式) | Cordis plugin development: Service / ctx.effect / typed-event conventions |

> **The default is 极简模式 (Minimal)**: new agent sessions, new agent nodes, and any settings left untouched all run with it. Switch to **标准模式 (Standard)** in those same four places when you want the fuller general-purpose voice. (A configuration that already saved a choice keeps that choice — nothing is silently rewritten.)

### Why Lean Thinking saves tokens

Agent tasks are billed for what the model outputs, and **reasoning is output too** — a single request can burn over a thousand tokens of inner monologue to deliver two lines. Lean Thinking squeezes from three sides:

- **Structure first**: before acting, compress the request into one line — `GOAL/GIVEN/DECIDE` — and reason only from it.
- **Fixed skeleton**: thinking may only run `GOAL` (one line) → `APPROACH` (≤3 symbolic steps, written as `A→B`, `{candidate}/✔`) → `EDGE` (one line) → `DO` (the concrete next action). No added or removed sections, and never restate user wording or tool output.
- **Prune**: any sentence that does not change the next decision is dropped; a missing fact is looked up at the source (read / grep / query) instead of being guessed.

The preset text itself is written the same way: one compact paragraph of rules, with no method labels and no declaration of tool permissions — those are granted solely by the runtime tool-permission section, which this preset never touches.

What actually gets saved is the **expression** of reasoning: this preset only shapes how thinking is written (skeleton + symbols + pruning). It **does not touch the thinking level** — whatever you pick, 标准 (Standard) or 最强 (Max), is exactly what gets sent (earlier builds silently lowered it to `low` for this preset; that behaviour has been removed). **Delivery is unaffected**: tool permissions still come from the runtime tool-preset section (Lean Thinking neither claims nor changes any permission), and the output port and save nodes still receive the full body text.

> This preset used to be called "Sketch mode" (internal id `sketch`); it is now **Lean Thinking** (internal id `lean`). Values saved as `sketch` in older sessions and agent nodes are normalized to `lean`, so the preset text keeps working with no re-setting.

### The cost

- **It may think one step less**: branches outside the skeleton never get expanded, so judgement calls that need repeated weighing can lose detail.
- **When you do need deep reasoning**: pick **Max** as the thinking effort, or switch back to **Standard / PTC** — Lean Thinking no longer decides that level for you; what you select is what runs.
- **The UI says what runs**: the model chip and the thinking-effort item show only the level you picked (Standard / Max) — there are no longer two names for one setting ("nominal" vs "effective").

## Communication language (agent taste)

Whichever language you pick with the top-bar **中 / EN** button ships with every agent run as a *taste*: converse in that language and expect the agent to answer in it — questions, plans, progress notes and final answers, and the same for every sub-agent or bound dev session it spawns. Settings → agent capabilities shows which language is active.

The taste covers **conversation only**. Code, paths, commands and API fields stay verbatim, and fact records, table cells and file bodies keep the language of the source material — switching the UI language never translates them. An explicit language request from the user wins for that conversation.

## Complex tasks plan first (confirm the list, then execute)

When an agent session or a smart task node receives a request it first judges complexity: anything already explicit or trivial gets done straight away, and anything it calls complex changes **nothing in that turn** — it only returns a plan. The app then plays the alert sound and opens the **Plan confirmation** dialog: drag the bottom-right corner (or hit ⤢) to enlarge it, one task per card with three columns (title / detail / execution model), add, delete and reorder rows, give tasks the same *parallel group* name to run them concurrently; after you confirm, each item runs as its own turn with its own model. The **Plan** panel at the bottom of the session keeps that list alive, so an interrupted run can be resumed with ▶.

**Plan dialog never appeared? The app asks once for a redo.** Models occasionally fail at exactly this step: they mangle the plan-block markers, forget the closing marker, or just print the JSON in the body. Such a plan cannot be parsed, so no dialog shows up and the session looks like it "ended mid-sentence". Every turn now ends with a small **keyword check**: it only fires when that turn was actually asked for a plan *and* the text carries a plan-block marker or both `"goal":` and `"tasks":` keys (both together — so ordinary answers never trigger it). Then the app automatically sends a correction message asking the model to **emit the same plan again in the contractual format**. Deliberately restrained: at most one redo per user turn, a still-invalid answer only shows a hint to resend your request, and a turn you cancelled — or a session with your own queued messages — is never touched.

