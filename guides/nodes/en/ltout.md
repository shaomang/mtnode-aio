# Output node (ltout)

An **editable output landing point** the long-running task leaves on the canvas. It is not
something you add by hand: the long-running task system creates it when a step produces something,
bound to the task and the step (title looks like `Output · Draft`), and places it inside
**that step's super-node shell** (see `super.md`: every long task gets one "Long task · <task name>"
shell on the main canvas, each step owns a child shell inside it, **placed when the task is created**; if the shell has been deleted the
node falls back to the main canvas layer).

## What it is for

While a long task is running, **the information and file contents each step produces are written
into this node as they happen** — you do not have to wait for the whole task to finish. That is the
point: a two-hour run is no longer a black box; its in-progress output stays in front of you.

## How to edit it, and what happens then

- **The body is editable**: type directly in the node, or click the **✎** button in the node header
  to open the built-in Markdown editor (saving writes it back to the node).
- **Below the body is a read-only file list**: the files this step wrote (name + size; hover for the
  full path).
- **Your edits win**: before a later step continues, it checks whether you changed the output —
  - body differs, or a file changed (mtime / size mismatch) → later steps use **your edited version**,
    never overwriting it with the old one;
  - everything matches → it just continues;
  - **it cannot tell** (output node deleted, file unreadable, no output baseline for that step) → the
    system does not guess: a human card titled “The output could not be verified — please confirm”
    appears in the strip, and the step continues only after you answer and confirm.

## Identity and de-duplication

One step has exactly one output node: re-runs and back-jumps reuse it (identified by
`ltTaskUid + ltPath`); if you delete it, the next run of that step recreates it under the same
identity. Output nodes are saved with the canvas, so they are still there after you restart the app.

## Can I delete or copy it?

- **You can delete it**: the next run of that step recreates it (the body is rewritten with the
  latest output).
- **You cannot copy it or add it manually**: the context menu, copy / paste, templates, global search
  and agent-built graphs all refuse to create or duplicate this kind. Only the long-running task
  system creates it, and it does so **outside the undo stack** (Ctrl+Z on the canvas will not remove
  it).
- It has no input / output ports and never participates in wiring — it is a place for humans to read
  and edit, not a step in the pipeline.

## No type entry for this node?

Right — that is deliberate: like the deliverable node, only the long-running task system creates it.
To get one, expand the thin line above the canvas and create a long-running task (**created means shown — no need to enable it first**):
the parent shell and each step's child shell are already on the canvas from creation, and once a step produces output the node appears
inside that step's child shell (if the shell was deleted, the system rebuilds it on the spot by task identity).
