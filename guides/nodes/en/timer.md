# Timer

![diagram](img/timer.svg)

At the scheduled **local time**, send a “you may start” pulse to whatever is wired on the output.

## Turn it on / off

The node’s **▶** does **not** run targets immediately. It **starts the alarm**:

1. Pick a mode and time.
2. Click **▶** to watch the clock until the next due time.
3. Click **stop** to cancel waiting.

The status line shows the next fire time. **Fire now** sends one pulse immediately without changing whether the alarm is on.

## Modes
- **Once**: fires once, then turns itself off
- **Interval**: repeats every given days / hours / minutes
- **Cron**: five-field expression; use Smart fill

## Ports
- **In**: none
- **Out**: control (wire to nodes that should start on schedule)

In a task control flow, an incoming pulse waits until the **next** scheduled time, then continues downstream.
