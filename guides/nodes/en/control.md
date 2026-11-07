# Run / Clear

![diagram](img/control.svg)

Batch control: wire the target nodes to it (in or out), then ▶ runs or clears them with the current action.

## Ports
- **In**: control (nodes wired in also count as targets)
- **Out**: control (nodes wired out are the targets)

## Settings
- In the settings window opened by **⚙ Settings** in the node header; **Action**: run / clear (default run)
- **Fill gaps: only run nodes that have no output yet** (off by default)
- **Pinned node (cannot be deleted)** (off by default)
- Which nodes it governs is still set by wiring on the canvas; the window only lists them

## Usage
- The header also has **Clear / Run / Fill** toggles, then **▶** and **■**
- **Run** runs the wired nodes; **Clear** wipes their results; **Fill gaps** only runs nodes with no output yet

## Notes
- If a target is running, both run and clear are refused — stop it first.
- Clear ignores fill gaps and always clears everything.
