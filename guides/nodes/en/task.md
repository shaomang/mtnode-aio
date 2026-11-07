# Task

![diagram](img/task.svg)

A container node holding a control graph: start → work / subtasks / judge → success or fail end; outside it is one cell that stands for the whole chunk of work.

## Ports
- **In**: port 0 = control (activates the inner start)
- **Out**: port 0 = success · port 1 = fail (whichever end the pulse reaches, only that one fires)

## Settings
- No ⚙ settings window: everything is on the card — the goal is the “Goal / what this task should solve” text box in the card

## Usage
- Write the goal, then “+ Task” adds an inner subtask with its own start and end, or “Assist split” breaks the goal into an inner task graph; then press ▶ to pulse from the inner start
- The parent card shows child tasks as cells; click a cell to enter that task

## Notes
- With no start inside, it reports a missing start; if the pulse reaches no end at all it reports that the control flow never reached an end and counts as failed
- When the run needs a human to step in (blocked), it is neither success nor fail and neither output fires
- Success and fail are two separate ports, so downstream must be wired to the one it needs
