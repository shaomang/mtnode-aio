# Timer

![diagram](img/timer.svg)

At the scheduled **system local time**, send one “you may start” pulse to the nodes wired on the output.

## Ports
- **In**: none (control wires are rejected)
- **Out**: control (wire to the nodes that should start on schedule)

## Settings
- In the settings window opened by **⚙ Settings** in the node header; **Mode**: once (scheduled time) / interval repeat / Cron expression (default interval repeat)
- **Scheduled time (system local time)**: once mode only; fires once, then disarms itself
- **Every (day / hour / min)**: interval repeat mode only, default every 1 hour
- **Cron expression (minute hour day month weekday)**: Cron mode only, default `0 * * * *`; Smart fill writes one from a sentence

## Usage
- **▶** does not run targets now — it **arms** the alarm and watches the clock; **■** cancels the wait
- The status line shows the next fire time; **Fire now** sends one pulse immediately without changing the alarm
- To start a chain on schedule, wire the chain's first nodes to the timer's **output**
