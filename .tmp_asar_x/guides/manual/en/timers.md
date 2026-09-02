# Timer and delay

![Timer](img/timers.svg)

## Timer

Wire the alarm to nodes you want to start (gold control wires). Interval is **days / hours / minutes** (min 1 minute, max 7 days), or Cron **smart fill**.

**▶ opens the alarm**—it does not immediately run the business nodes. At fire time a pulse is sent downstream. ▶ again disarms.

## Delayer

Waits the configured time after an upstream pulse, then releases. Use it to space steps.

See each node’s **Node guide** for ports.
