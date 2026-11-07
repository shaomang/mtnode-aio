# Execute node (one-click launch)

Bind an executable or any system-openable file (`.exe` / `.bat` / `.cmd` / `.lnk`, or documents / scripts) and **launch it from the canvas** in one click. No data ports — a standalone tool node.

Create: right-click empty canvas → **Dev node (project architecture · feature block)** → **Execute**; or right-click a feature block → “New Execute Node Inside” to keep the launcher in that module.

## Ports
- **In**: none
- **Out**: none

## Settings
There is no **⚙ settings** window — everything is on the node card:

- **Bind executable…**: pick the file to bind (absolute path).
- **Change icon…**: the default launcher icon, or rocket / gear / terminal / play / bolt / wrench / folder / file / power.
- **Change body color…**: no colour by default, or teal / blue / purple / orange / red / pink / green / brown / slate, to spot it fast.

## Usage
1. Bind a file; without one, running it says “Bind an executable first”.
2. **One click on the play button** launches it (double-clicking the node also works) — the OS default handler opens it; no second click needed.

## Notes
- It remembers the exact path from binding: a moved or deleted file reports “File not found”.
- It takes no part in runs: the engine never executes it and no wire can feed it data.
- Great for keeping “start a local tool / open a folder / run a script” actions on the canvas next to docs and notes.
