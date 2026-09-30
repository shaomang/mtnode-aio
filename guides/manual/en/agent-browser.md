# The session's browser

A session can open a browser of its own to get work done (research, logging in and pulling data, saving results to files) — and you can watch what it is doing at any moment, or take the wheel and drive yourself.

> This browser is **only available to sessions you open yourself**. Canvas agent nodes and agent tasks do not register these tools (an unattended run should not go clicking around the web on its own), and neither does pure mode.

## Whose browser is it

- A separate window with its **own user-data directory** (`%APPDATA%\pipeline-console\browser-profile`), independent of the browser you use every day: logins and cookies here belong to these sessions only.
- It drives the **Edge / Chrome already on your machine** (nothing extra to download, no disk cost). Only if neither is installed does it fail — and the error says what to install.
- **Started on demand, kept afterwards**: it launches the first time a session needs it; when the work ends the window stays (logins survive, ready to hand over), and only the panel's "Stop" closes it.
- **Docked in the session's right panel by default**: while it runs the real window gives way and the live picture appears in the right panel's "Live view" area — you can watch, click, scroll and type right there (click "Own window" to turn it back into a window of its own, "Dock back" to return it). Nothing shows until it is called or the browser is started; **the panel appears by itself the first time the session uses the browser** (if you collapsed it by hand it stays collapsed for that run — the "Browser activity" button in the composer brings it back any time). If that panel is **already open** (left open, or restored from memory after a restart) it also connects the live view by itself — no click needed, otherwise the browser window would stay on screen that run.
- One process, many tabs; at any moment exactly **one session** may drive it (another session asking gets a clear message instead of a queue of random clicks).

## The "Browser activity" panel on the right

The **right-hand column** of the session content is this browser's live ledger; it **stays completely hidden (zero width) until it is called, the browser is started, or the current chat has ever touched the browser**, so the session sidebar and chat area look exactly as before. **It appears by itself as soon as the session touches the browser** (that is also what lets the real window dock); collapse it by hand and it stays collapsed for that run. Entry point: the "Browser activity" button in the composer (click again to collapse; the ✕ in its header does the same):

- Each row is one action or result: which URL was opened, which element was clicked, what was typed, which command ran, which file was read/written, what error the page raised, where downloads and screenshots landed.
- Colour-coded by class: 🌐 browser / `>_` command / 📄 file / other — so you can tell at a glance whether it is online or touching your machine.
- Control it right on the panel: **Open browser** (bring the window up so you can log in by hand first), **Stop**, **Take over / Hand back**, **Lists** (blocked / risky domains and the dangerous-action approval switch), **↻ Refresh**, **Clear** (clears the current chat by default; tick "Include other chats" to clear everything).
- **The panel follows the current chat**: switch chats and the ledger switches with it — every row is attributed to the turn that produced it, not to whoever moved last. **When the current chat has no browser the whole panel collapses** — a chat that never called it and is not driving the browser should not hold an empty column; switch back to a chat that did use it and the panel returns from memory with that chat's ledger. If you opened or closed it by hand for a chat, that choice is remembered for the run and the automatic rules will not override it. The live picture is drawn only for the chat that currently **holds the browser driver lock**: while another chat drives the browser this panel will not pull its picture (only one chat may drive at a time).
- Tick "Include other chats" to see their rows too (whole-database query); leave it unticked to see only the current chat. Rows left over from older builds whose attribution is not a chat id only show up under that tick.
- **Follow latest / Stop following** (bottom of the panel, left of "Clear"): following is the default — every new activity keeps the list at the newest row. Scroll back up and it **stops following by itself** (the button flips to "Follow latest" and loses its highlight); new activity still arrives, but your view stays where you put it instead of being pulled back to the bottom. Scrolling back to the bottom resumes following — or click the button to switch by hand. The choice is remembered and restored the next time you open the panel.
- The same records go into a local activity store (`%APPDATA%\pipeline-console\activity.sqlite`), so you can look back after closing the panel or restarting the app; 4000 rows per session and 30000 in total, oldest trimmed first.
- **The activity stream never enters the model's context.** It is an account kept for you, not material fed to the AI — so reading the ledger costs no tokens at all.

### The "Live view" picture in the right panel

The **Live view** area at the top of the panel *is* this browser, **docked in the right panel by default** (not a separate window):

- The picture is streamed in real time (~10 fps, quality reduced as needed) and **stays in memory only — never stored, never fed to the model**: watching it costs no tokens.
- Operate it in place: clicks, scrolling and typing are forwarded to the page (IME included). For passwords and the like, click "Own window" and use the real window.
- **Own window / Dock back**: "Own window" restores the real window (it becomes a window of its own again) and the panel just says "in its own window" (the picture is not decoded twice); "Dock back" returns the picture to the right panel. The choice is remembered and restored next time; docked is the default. While it is its own window it **will not be docked back automatically** — it stays a real window until you click "Dock back".
- **Pause live view**: stop decoding the picture temporarily (click again to resume); collapsing the panel or switching to the canvas / team view also stops the frames.
- **Fallback mode**: on some machines a window moved off-screen stops rendering — the app then falls back to "window kept on screen + panel still streaming" and says so in the live area (the real window is authoritative).

## When it needs your help: the help card

When a session hits something it cannot get past, it raises a **browser help card** in the chat (blue card, with a screenshot of the page at that moment) offering whatever fits:

| Situation | What the card gives you |
| --- | --- |
| It needs a login / the page wants a check | "Take over the browser (I'll do it)" — you type the account and password in the window yourself; **the password never passes through the session or the chat** |
| It is unsure about a result | "Please verify this result" + screenshot; click "Done — continue" and it moves on |
| It needs a missing fact or a decision | Option buttons (which account, which file, …) |
| A dangerous action (submit / pay / delete / send / publish) | "Allow once" / "Reject" |
| It is completely stuck | It says what it tried and what it needs; you reply, or just take over |

While you are driving, **the session's browser actions are refused** (not queued up to sneak in later); it continues after you hand control back — and it takes a fresh look at the page first.

## Safety defaults

- **Blocked list**: those domains are refused outright; **risky list**: a one-time confirmation card on first visit (mail, online banking and government sites are in there by default). Edit both under "Lists" on the panel — **effective from the very next action**.
- **Dangerous actions**: submit / pay / delete / send / publish clicks ask first by default (the whole switch can be turned off on the panel).
- **Credentials**: the session never types your password; secrets and tokens appear in the activity stream as a length, never as text.
- Console errors and failed requests from the page land in the activity stream — when something breaks, the cause is the first thing you see.

## Long-horizon work: auto-continue

When a round finishes but **the goal is not met and a next step exists**, the session starts the next round by itself (the **"Auto-continue" toggle inside the "Modes" menu** above the composer is the master switch; on by default):

- The cumulative status (rounds continued, time spent, tokens used when countable) lives in the hover tip of the same "Modes" chip.
- It stops when it judges **the goal is reached** (an explicit sign-off plus a delivery list), when the checklist is fully closed, when you cancel or pause it, or at the safety cap (30 rounds, to stop a runaway).
- **It will never stop to ask you just because it has been running long or spending a lot** — thresholds are display only; watching is your job. Turn the toggle off in the "Modes" menu to make it stop.
- For work that takes hours or must survive a restart, it will **suggest** promoting it to a Long-running task graph (with stages and breakpoints) — but it never edits the canvas for you.
- Every round starts with a self-check: what is done with evidence, what is left, whether the previous step's output is sound; **it fixes and re-runs problems itself** instead of treating a doubtful result as final or handing you anything short of "I cannot fix this".

## See also

- Tool family and calling conventions (when writing flows or delegating): the node guide "Browser tools".
- Design and contracts: `docs/agent-browser.md`.
- Approvals: the manual page "Approvals".