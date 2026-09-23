# Long-running tasks (state machine, human in the loop)

Some work is not a pipeline you run once and finish: partway through it needs your approval, needs you to supply material, needs several branches running in parallel, and a rejection has to send it back a step for a redo.
**Long-running tasks** exist for exactly that kind of work — they draw the whole job as a **state machine graph**, the app advances it according to the graph, stops where it should stop and waits for you, and carries on once you have dealt with it.

It **coexists** with ordinary pipelines on the canvas: pipelines are still one-click re-runnable; a long-running task is something else entirely, living in the thin line you pull open.

## 1. What the thin line is

Between the menu bar and the canvas there is a 6px thin line (the hairline is the 2px strip in the middle), with only a small gap above and below — it takes up no room.
It lights up when you hover, and **dragging it down** expands it: the canvas and the tabs are pushed below, and the space above becomes the long-running task's
**state machine editor + live view**. The line hangs on the **bottom edge** of the long-task area — it is the divider between that area and the canvas tabs:
drag down and the line follows the mouse while the tabs and canvas sink together, all the way until the **tabs sit against the bottom of the window** (the canvas squeezed to a sliver) —
the ceiling is the height the window can actually hold right now, so tabs / canvas / bottom status bar are never pushed off-screen; **and the line does not change colour when you drag it down**.
Push it back up, or double-click the line, to collapse it. The line's height and open/closed state are remembered **per canvas**: wherever you left it on this canvas is
where it is when you switch away and back (other canvases are unaffected and each keep their own).

The line is also this task's **status light**: with the panel collapsed you can tell how the run is going just by looking at it —
**orange while running, yellow while it waits for you (approval / delivery), red when stuck or failed**; those three pulse.
**Green when finished**, lit steadily. While this canvas has no long task, it is just an ordinary thin line with nothing on it yet (once you create one, see the next paragraph).

**Created means shown**: a long-running task **appears in this line the moment it is created** — you no longer have to press **▶ 启用并绑定 (Enable & bind)** on the strip before you can see it.
At creation the strip **opens by itself** and lays the graph out (the open state is remembered per canvas, so switching away and back leaves it open), and the task's landing points are placed on the main canvas in one go
(parent shell + each step's child shell + generation workflows + deliverable nodes — see 5b); if the task was created on **another canvas** (a session / the assistant may do that), the canvas you are looking at is never yanked open — it is saved and reported in one line, and you see it when you switch to the canvas it belongs to.
**Creating only builds, never runs**: the task is still "not enabled" and no generation ever starts by itself — the run begins only when you click ▶ Enable & bind.

The right end of the strip holds the run controls (**▶ 启用并绑定 (Enable & bind) / ▶ 继续 (Continue) / ■ 停止 (Stop) / Re-enable (new run) / Disable & unbind**) plus
「记忆」(Memory) and "⚙".
**"Long-running tasks on this canvas" (switch), ＋ Create long task, 历史 run (run history) and 交付目录体检 (delivery-folder health check) all live under ⚙.**
But you do not have to go through ⚙ to switch: **the first crumb at the top-left of the state-machine canvas shows the name of the long task you are looking at** (it is no longer a hard-coded "Main"), and **clicking it** unfolds a task list — switch to an older long task, or create a new one right there. The current one carries a ✓ and does not respond (it is the task already on screen), and the hover text shows node count / graph version / whether it is bound.
**When this canvas has no long task yet, the space you expand *is* the create entry point.**

**＋ Create long task** opens a nearly full-screen window (minimisable to the status bar; resizable from the bottom-right corner, minimum width = half the viewport).
Both paths are in the window: on the left, write the agent one or two sentences of goal and let it first "grill" you until the requirements are clear, then store the graph;
the **＋ Create manually** button in the top-right starts directly from a blank template (Start → Agent 任务 → Done).
The **Agent 选型 (Agent picks)** at the top of the window (provider / model / preset / thinking effort) decide what this creation's **agent steps in the whole graph** inherit:
leaving all of them empty = follow the default, and you can still change each node in the inspector afterwards.
**Cancel** at the top-right (or Esc) only closes the window: **the text you wrote and this whole set of picks are kept** and come back next time you open it.

## 2. Which kinds of steps the graph has

| Step | What it does |
| --- | --- |
| Start / Success end / Fail end | One path running to the end finishes the job; reaching the Fail end makes that path a failure |
| **Agent 任务 (Agent task)** | Hand it to an agent: state the goal, which state keys it consumes and which it produces; model and preset can be pinned |
| **人工任务 (Human task)** | Stop and wait for a person: **Approvals** (pass / reject) or **Content delivery** (deliver against a checklist) |
| Join | Wait for parallel branches to line up before continuing: all arrived (AND) or any arrived (OR) |
| Fork | Follow one of the edges according to a condition (several may fire at once = parallel) |
| Map | Spread an array out and run each item through an inner subgraph, invisible to each other |
| Subgraph | Put a stretch of the flow into a container, double-click to drill in and edit it; nest as deep as you like (the breadcrumb's “← Back outer graph” walks back one level at a time and hides itself at the outermost graph) |
| Write files | Turn one state key into a file |

Wires can carry a **condition** (a small piece of restricted JS that reads the whole shared state — write `input.state.<key>`, or just `state.<key>`; `input.node` is the step the wire starts from and `input.runId` the run id. Either form works: `return <truthy>`, or a plain single-line expression such as `state.ok === false`. The pulse only goes through on a truthy return; a mistake or a timeout becomes
"needs a human" instead of crashing the task).

#### State keys are **one shared state** — the write-files step self-heals

Every step's state keys live in the same task state and **sibling steps can read them too** (only the parallel instances of a
"for each" step stay invisible to each other — that isolation is deliberate). So once a **Write files** step has a key picked in
its dropdown, it can read it whether an upstream or a sibling step wrote it back; Agent prompts see those keys as well.

If it really cannot read one, the step self-heals first and only then fails:

- **The key lives on another step's layer**: the engine looks it up across the whole shared state, and when the value comes
  from another step it names it in the run log — "auto-repaired: state key "x" taken from <step>". Values are never swapped silently.
- **No output path set**: it falls back to `<canvas workspace>/<step title>.md` and logs the real path.
- Only when both are missing does it fail — and the failure text lists the **state keys visible now**, so you can fix
  "which state key" / "which file" and hit **Re-run this step**.
- **A write-files step that already failed**: when you press **▶ 继续 (Continue)**, if its state key is readable by then the
  engine re-queues it automatically (it only writes a file — no tokens; steps you released by hand are left alone, your call stands).
- A write-files step with no key / path picked gets a warning in the pre-enable validation (a warning never blocks enabling).

**Adding a step**: **right-click** on the state machine canvas (on empty space, on a node or on a wire — all work); the menu lists the ten step kinds above.
**Deleting a step / a wire**: select it first (right-clicking it also selects it), then just press **Delete** (or pick "Delete selection" in the right-click menu).
These two used to be a row of buttons above the canvas; they now live in the right-click menu, so the strip is no longer crowded with buttons.

### Every step lists its own subtasks on the canvas

No need to open the inspector — just read the card. Under the step name and summary, each card lists that step's **subtasks** line by line:

- **🤖 = the AI does this automatically**: an Agent task's goal / steps (newlines inside `goal`, or items written as "1. 2.", are split into separate lines).
- **✋ = a human must intervene**: approval steps, plus checklist items not yet delivered, are marked in amber so you can see at a glance who is holding things up.
- **☐ / ☑**: delivery checklist items, one per line (pending / delivered).
- **⤵**: inner members of a subgraph / map step (members that need a human are amber too).
- **⚠ / ▸**: this step's errors and its live output.

Card height **grows with the number of subtasks**, and the wire endpoints follow it, so no matter how many lines there are the wires never run into the middle of a card.

Text on each card is **truncated to the card's width**, so it never pokes outside. To see more, grab the small handle at the card's **bottom-right corner** and drag it larger
— once wider, the text re-flows to the new width and shows a few more lines; card sizes are saved with the canvas.

### Zoom

**The scroll wheel zooms** on the state machine canvas (anchored on the point under the cursor, so it does not drift while zooming; 25%–400%).
The percentage at the right end of the canvas's **top row** (the breadcrumb row, "current long-task name ▾ ▸ …") is both a read-out and a **reset button**: click it to return to 100%.
Zoom is remembered **per canvas**, so switching away and back restores your last view.

## 3. Enabling and binding

A long task that lands on this canvas **shows up on the strip as soon as it is created** (the graph is laid out, and the canvas already holds its shells / generation workflows / deliverable nodes).
**Enabling only decides whether it runs**: creating never runs it for you — click **▶ 启用并绑定 (Enable & bind)** on the strip and from that moment it runs. Once enabled:

- This long task **binds to the current canvas**; each agent step only reaches the canvas content (`mtnode_canvas_get`) if "Allow reading the canvas" is ticked on it,
  and then **read-only**: this round the graph-editing and app-type canvas tools are not registered at all, and calling them fails (if you want the canvas changed, change it yourself on the canvas).
- The moment you enable it, a **snapshot of the graph** is taken as the skeleton of this run. Changing the graph afterwards **does not affect the run already going**;
  to make your changes take effect, click "Re-enable (new run)".
- After the app restarts, the **scene** is restored to where it was interrupted, but nothing **re-runs on its own** — anything that burns tokens is left for you to press **▶ 继续 (Continue)**.
- A canvas has only one enabled long-running task at a time; you can switch between them in **⚙**.

## 4. How human tasks are handled

The right column of the strip lists the cards that are "waiting for you":

- **Approvals**: write a note → **✓ 通过 (Pass)** continues downstream; **✗ 驳回 (Reject)** sends it back to the step you name for a redo. A rejection **must carry a reason**,
  and the reason is written into the shared state so the upstream agent can read it next round. Whatever you have **typed so far in the reason box stays there** —
  the strip redraws as progress arrives, and your text survives the redraw intact (losing focus elsewhere does not clear it either);
  whatever you are **typing, marquee-selecting or holding the mouse down on** in the right column also stays put (a redraw never wipes the selected text or breaks a selection drag in progress);
  only clicking ✓ 通过 / ✗ 驳回 submits it and clears it, and switching canvases clears it too.
  Jump-back is **unlimited by default** (you can keep sending it back for redos);
  if you set a cap in the step inspector or in ⚙, exceeding it turns that step "Failed" rather than looping forever.
  After a rejection, older builds could freeze **the whole graph into a stuck state** (the jump-back also cancelled the entry firing, so the target step could never start again):
  this is fixed — new runs will not hit it; for **an old scene that is already stuck**, pressing **▶ 继续 (Continue)** once re-queues the skipped steps and the run carries on.
- **Content delivery**: the card is a checklist (file / text / option confirmation / media, split into required and optional).
  A file can be **Upload**ed, or you can wire an upstream node into the deliverable node on the canvas and then press **从画布连线取 (Take from the canvas wire)**.
  While working, the agent may decide you still owe it something and **append** candidate items — those carry an amber outline and you must press
  **接受这条要求 (Accept this request)** or **驳回 (Reject)** on each one; unaccepted ones are not treated as demands. Once every required item is in,
  **you press 「确认交付完成」(Confirm delivery complete)** and only then does the step release (the system never decides on your behalf that delivery is done).
  Delivery works file by file: **a file item must carry a file name with an extension** (e.g. `分镜表.md`); with no name, or with just a description, the checklist shows
  **「文件名待补」(file name pending)** — a description is never taken as the file name. While a required file item still has no name you **cannot press
  「确认交付完成」**: the card blocks it and names the offending item, and warns in red above the card up front.

The deliverable node (the one on the main canvas) is this human step's **landing point**, and it can edit the checklist and take files itself (next paragraph):
**it is already on the canvas when the task is created** (its delivery folder and manifest are written into that canvas's working folder at the same time), so you do not have to wait for the run to reach that step before you can see it.
The controls are on the strip card, and the two never double-write.
Anything you add / edit / delete on the canvas (on the node or on the strip card) is also **written back into the task graph's checklist definition**, so the **next
enable / re-run never reads the old checklist again** (switching canvases or reopening the canvas to restore the scene tops it up as well); only the currently running round
keeps the snapshot taken at enable time.
The checklist is **two-way**: the app writes `manifest.json` and reads it back — values you edited by hand outside the app (Explorer / editor), `done` flags, filled-in
values and attachments dropped into the delivery folder are recognised again when **re-entering that step** or when you press **▶ 继续 (Continue)**, and are not treated as undelivered.

## 5. Output nodes: everything produced while running is written into the canvas

While the long task is running, **the information and file contents each step produces are synced into an "Output node" (产出节点) on the main canvas**
— its title is "Output · <step name>", so a step called 起草 shows as 产出 · 起草 — it lands in **that step's super-node shell** (see 5b; the shell is already placed when the task is created), so you do not wait for the whole job to finish: you can read it on the canvas any time, and edit it directly.

- **The text is directly editable**: edit it on the node body, or press **✎** in the node header to use the built-in Markdown editor
  (saving writes it back to the node). Below the node, the files that step wrote to disk are listed read-only (file name + size,
  hover for the full path).
- **Your edits count**: before a later step continues, it checks whether the output was changed by you —
  - the text differs from what was registered, or a file changed (time / size do not match) → later steps **take your current edited content as authoritative**
    (your edits count); the old version is never used to overwrite you;
  - everything matches → the run carries on as usual;
  - **it cannot be checked** (the output node was deleted, the file is unreadable, that step never registered an output) → the system does not guess: a
    「产出判不准，请确认」(output cannot be judged — please confirm) human card appears on the strip, and the run continues only after you answer and confirm.
- **One step has exactly one output node**: re-runs and jump-backs reuse it; if you delete it, the next time that step runs it is recreated under the same identity;
  it is created by the system, **cannot be added manually or copied**, and creating it does not enter the undo stack (Ctrl+Z does not take it away).
- Output nodes are saved with the canvas and are still there after you close and reopen the app.

### Artifact nodes laid out individually at the end

An output node records one step's text plus a file list, and a long list has to be read row by row. So **when each step finishes,
the system tallies what that step actually wrote this time and lays each piece out as an "Artifact node" on the main canvas**
(titled like `Artifact · Video · pilot.mp4`), placed to the right of the same step's output node, in a free-slot grid that
never covers your own nodes:

- **Visible**: images get a thumbnail (click for the full view / save as), video and audio **play right inside the node**,
  text / Markdown / tables get a summary, other types get the path. **⇢** in the node header opens it with the system default program,
  and the bottom line is the full path.
- **Editable in place**: text artifacts have **✎ Edit & save** in the header — open the in-app editable reader, fix a few lines,
  and **saving writes back to that artifact file**, with the node's size and summary refreshing immediately; the same reader is
  where you read the full text (it renders Markdown itself), so you can read and tweak in one step.
- **Only what this step itself produced**: input files handed down from upstream steps are not laid out again downstream, so every step does not
  re-plaster the screen with upstream images. At most 32 items per run.
- **What counts as "written by this step"**: every path the agent lands with a file-writing tool (write / edit and friends) is
  recorded — a **workspace-relative path** it gives (`assets/prompts/shot-01.md`) counts too, resolved against this canvas's working
  directory; paths inside the written-back state (whole, or buried in a paragraph of prose) are also extracted and checked one by one that the file
  really exists. And if an artifact never went through a tool argument (an external program wrote the file straight into the working directory), it falls back to
  scanning the working directory within **this step's time window**. Unreadable files are never laid out, so the canvas keeps no dead cards.
- **One node per artifact, reused by identity**: identity is "task + step + file path", so re-runs and jump-backs do not pile up new ones;
  you may drag, rename and delete them freely; deleted ones come back when that step runs again.
- **Old tasks get filled in**: steps that ran before the upgrade left no artifact tally, so opening this canvas (or pressing **▶ 继续 (Continue)**) makes the system
  re-tally that step's own time window and lay out the files it wrote this round — no need to burn an empty run just to see the artifacts.
- Same origin as output and deliverable nodes: **created by the system, cannot be added manually or copied**, and creating one does not enter the undo stack.

## 5b. Everything is collected inside the "super-node shell"

A step's output should not be scattered over the canvas, so a long task gives **every task one super node on the main canvas**
(named like "Long task · <task name>", with a pink-violet "Long task" badge in its header; **it is built when the task is created**), and **every step gets its own child shell
inside it** (named after the step, also placed at creation time). Output nodes and artifact nodes both land in **their step's child shell** —
open the shell and you see what this step produced, without cluttering the main canvas.

- **Built at creation, never run**: the moment the task exists, the parent shell + each step's child shell (+ that step's generation
  workflow) are placed on the canvas — no need to wait for the run to reach a step first; prebuilding **only creates nodes and wires, it runs nothing**.
- **Recognised by identity**: the shell records which long task and which step it belongs to, so re-runs, back-jumps and restarts reuse the same
  shell, matched by the task identity stored on it (task uid) plus the step path — no new shell per round. A **step you add to the graph later**
  gets its shell (and generation workflow) when that step first really produces something, again built but never run.
- **Bound to the task**: there is nothing to bind by hand and
  no extra entry on the strip's task card either — just use the shell on the canvas. Deleting the long task **keeps the shell and
  everything inside it** (only the task binding fields are cleared), so your edits inside the shell survive the task.
- **Deleting it does not grow it back quietly**: if you delete the shell (or one step's child shell), the engine will not silently
  recreate it — it logs one line and shows one notice, and that round's outputs fall back to the main canvas layer. Use "Rebuild shell"
  in the strip if you want it back.
- **Fully editable inside**: just like an ordinary super node — add your own nodes, move things, rename it (double-click the card to
  enter its inner canvas).
- **Older canvases**: output nodes that were already laid out on the main canvas before this change are moved into their step's child
  shell when you open the canvas or press "Continue" (artifact nodes are left alone — you may have edited them).

### When content generation is involved: the workflow is built for you, but **you run it**

Image / video / music / speech generation costs money, quota and VRAM, so the rule is **build the graph, never run it for you**:

- When a step has "Needs generated content" checked in the strip inspector (on by default for new tasks), the **generation workflow is placed
  in that step's child shell when the task is created**: one generation node per selected
  "Generation types" entry (image / video / music / speech; image only by default), laid out **side by side** (not chained), each with a
  prompt written from the step title + goal that you can edit freely, the control node near the top (**▶ I run the generation**) and the
  generation nodes below.
  (For **a step you add to the graph later**, see 5b: it is filled in the moment that step runs and its output really lands in the child
  shell; nodes of a type that already exist are reused.)
- **Nothing runs automatically**: the preset only creates nodes and wires; no generation ever starts by itself. Go into the shell, read
  the prompt and settings, decide you want to spend that money, then press the generation node's **▶**. Output and deliverable nodes follow
  the same rule: their landing points are placed at creation time, and none of them is ever run for you.
- A missing local backend still gets the node (the node shows its own red notice and ▶ stops hard) — it never "quietly tries one" for you.
- No manual filing afterwards: artifact tally picks the results up by path and lays them in the same step shell as every other artifact.
- Generation **never blocks the task**: if you do not want to generate now, the task keeps going — generation is extra material, not a
  required deliverable.

## 6. Long-term memory

The strip's **「记忆」(Memory)** holds this system's long-term memory store (SQLite + full-text search), in three layers — **Global / Projects / Current canvas**;
each step is injected from Current canvas → Projects → Global, filling upward layer by layer (TopK 8 by default), with sources carried back.

- After a step finishes, candidate facts are **extracted automatically** → the strip shows "Memories to confirm N" → they enter the store only once you accept them one by one (accept all / reject all both work).
- You can also record one by hand, or let the agent write one actively with `lt_memory` (it is told: anything it inferred must go through "propose").
- Retrieval: English / plain word queries go through the full-text index, while **a query containing Chinese characters matches as a substring** — the default tokenizer treats a whole
  run of Chinese characters as one word, so a full-text lookup of 「验收 (acceptance check)」 would never hit 「长任务验收 (long-task acceptance check)」. Chinese search therefore
  means "contained = hit".
- **Two-way sync with the Expert team's fact library** (the default target is **this canvas's fact library**, not some directory picked at random):
  - **Import** "Import from Expert team fact library": reads every document in this canvas's library, splits it by level 1–3 headings into searchable memory entries.
    Entry ids are pinned by "canvas + document name + heading", so **importing repeatedly refreshes rather than accumulating**.
  - **Export** "Export to Expert team fact library": writes into one fixed document in the library, "Long-running task memory digest" (only the first-written copy of that
    heading is kept; an expert's original text is never overwritten); the left pane refreshes as soon as it is written.
  - If the library does not exist yet, or you are wiring up to an external (third-party) Markdown library, use the adjacent "Import from external folder / Export to external folder"
    as the second entry; external exports are named by day and **read back before appending**, so exporting twice the same day does not clobber the first.
  The fact library remains the source of truth on the Expert team side; this is the retrieval surface for long tasks.

Memory is a hint, not a fact: when it conflicts with your files or a fact-library document, the system says so plainly and never quietly overwrites what you wrote.

## 7. Parallelism, retries and thresholds

The strip's **⚙** holds two things: **Long-running tasks on this canvas** (switch / ＋ New / 历史 run / 交付目录体检)
and the cross-canvas global thresholds: graph-level parallelism (default 4), agent failure retries (default 2),
reject jump-back limit (default 0 = unlimited), memory injection TopK (default 8). Individual steps can each override the first few.

Parallelism is **the total gate over all agent steps in the graph**: every instance spread out by a Map step shares the same quota —
spread 16 items with parallelism 4 and at most 4 agents run at once, the rest queue (queued steps show as "running" in the graph).
Container steps (subgraph / map / join) do not consume quota themselves, so "a parent holding a slot while waiting for its children" deadlock cannot happen.

When an agent step finishes but **has not written back the output state keys it declared**, it is not failed immediately: the same session is asked once more to
"only write the values back, do not redo the task", for up to 2 rounds (while asking, the artifact files already on disk this round are shown to the model — path-typed keys are taken from there);
only if it still cannot fill them in is it judged failed. The extra asking is written to the strip log and the run trace, so you can see what happened rather than quietly burning a few more rounds.

## 8. Run history and health check

- **The graph definition does not travel as a JSON file**: the import / export entries have been removed; the graph is edited on the strip and saved with the canvas.
- "⚙ → 历史 run (run history)" lists every run this canvas has had on this machine, and you can switch back to some checkpoint and continue.
- "⚙ → 交付目录体检 (delivery-folder health check)" only **reports** delivery folders that no longer have a matching task; it never deletes your files on its own.

## 9. Things to know

- Delivery folders live at `<canvas working folder>\mtnode-deliverables\<uid>\` (the uid is `lt` + a random tail + `-` + up to 14 characters of the step title, e.g. `ltxxxxxxx-交稿`,
  so it keeps the step's own language and the folder name makes the step recognisable at a glance); if the working folder is unavailable it falls back to the app data folder and tells you once.
- All user data stays under the working folder and `%APPDATA%\pipeline-console\longtask\` — **nothing is ever written into the app installation folder**.
- A deliverable node can be deleted — deleting it marks that human step as needing to be rebuilt, and the system creates a new one the next time the step runs (the uid does not change).
  But it cannot be copied and cannot be added manually. The system does not put it in the undo stack either: pressing Ctrl+Z on the canvas will not take away a
  deliverable node that is waiting for you (if it did, the run would still be waiting for delivery while the canvas had no landing point).
