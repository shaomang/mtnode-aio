# Counter

![diagram](img/counter.svg)

Release once every N control pulses, then reset the count.

## Ports
- **In**: control
- **Out**: control

## Settings
- In the settings window opened by **⚙ Settings** in the node header; **Pass every N hits (2–99)**: default 2
- The node shows a one-line summary; “Reset count” stays on the node as an action

## Usage
- **▶** counts once; it releases when the threshold is reached
