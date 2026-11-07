# Sequencer

![diagram](img/sequencer.svg)

One in, many outs: after a pulse it fires lanes 1…N **in order**, with an optional gap (all zero = back-to-back).

## Ports
- **In**: control
- **Out**: 2–8 numbered lanes

## Settings
- In the settings window opened by **⚙ Settings** in the node header; **Output count (2–8)**: default 3
- **Step gap (day / hour / min, may be all zero)**: default 0, i.e. no gap
- The node shows only a one-line summary
