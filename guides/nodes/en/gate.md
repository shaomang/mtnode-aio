# Gate

![diagram](img/gate.svg)

AND join: with the configured input count, **every** port must receive a pulse before it releases once, then the arrival marks reset. Unwired ports still block the release.

## Ports
- **In**: 2–8 lanes (fixed numbering; disconnecting does not shift them)
- **Out**: control ×1

## Settings
- In the settings window opened by **⚙ Settings** in the node header; **Input count (2–8)**: default 2
- The node shows a one-line summary; “Clear arrivals” stays on the node as an action

## Usage
- **▶ Force release** ignores arrival state, clears the marks and releases once.
