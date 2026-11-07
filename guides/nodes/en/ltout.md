# Output node (ltout)

The **editable output landing point** a long-running task leaves behind: the information and file contents each step produces are written into this node as they happen, so you never wait for the whole task. You cannot add it by hand — only an enabled long-running task creates it when a step produces something (title like `Output · Draft`) and places it inside **that step's node-layer shell** (if the shell has been deleted it falls back to the main canvas layer).

## Ports
- **In**: none.
- **Out**: none. It never participates in wiring — it is a place for humans to read and edit.

## Settings
- There is no ⚙ settings window: the body is the thing you change — type in the node directly, or press **✎** in the node header to edit it in the built-in Markdown editor (saving writes it back to the node).
- Below the body is a read-only file list: the files this step wrote (name + size; hover for the full path).

## Usage
- Watch the step's output while it runs; fix the body directly when something is off.
- No need to tell anyone: later steps continue with your edits.

## Notes
- Your edits win: if the body changed, or a file changed (mtime / size mismatch), later steps use your edited version and never overwrite it with the old one.
- If it cannot tell (output node deleted, file unreadable, no output baseline for that step), the system does not guess: a human card "The output could not be verified — please confirm" appears on the strip, and the run continues only after you answer and confirm.
- One step has exactly one output node: re-runs and back-jumps reuse it (identified by `ltTaskUid + ltPath`); delete it and the next run of that step recreates it.
- It cannot be copied or added manually (context menu, copy / paste, templates, global search and agent-built graphs all refuse); creating it stays out of the undo stack.
