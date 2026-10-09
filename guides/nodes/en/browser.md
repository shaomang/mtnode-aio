# Browser tools (session capability)

The session's own browser: no bundled browser engine, it drives the Edge / Chrome already installed on the machine and uses a separate user-data directory (its own set of logins). This tool family is **registered for sessions only** — canvas agent nodes and agent tasks do not get it (an unattended run should not go clicking around the web on its own), and neither does pure mode.

Manual entry points (no commands needed): the **Browser activity** button in the session composer opens the right-hand column of the session content (it stays completely hidden until called or until the browser is started) → "Open browser" / "Take over" / "Lists".

## Tool list

| Tool | What it does | Key parameters |
| --- | --- | --- |
| `browser_launch` | Start the browser on demand (reuses an existing one) | — |
| `browser_snapshot` | **Preferred** way to read a page: title / URL / clickable elements / visible text / page errors | `textLimit` (default 4000 chars) |
| `browser_navigate` | Open a URL (goes through the safety gate: blocked list refuses, risky list confirms first) | `url`, `waitMs` |
| `browser_click` | Click an element (dangerous actions ask first) | `selector` or `text` |
| `browser_type` | Type into an input (**never for credentials**) | `selector`, `text`, `submit` |
| `browser_key` | Press a key (`Enter` / `Escape` / `Tab` …) | `key` |
| `browser_eval` | Run JS in the page to extract data (returns a structured summary, not the whole HTML) | `expression` |
| `browser_wait` | Wait for an element / text, or simply wait | `selector` / `text` / `ms` |
| `browser_screenshot` | Save a screenshot (use only when needed — **the model reads summaries by default**) | `fullPage` |
| `browser_tabs` | List / switch / open / close tabs | `action`, `targetId` |
| `browser_network` | Inspect page requests (method / status / URL) to debug failing calls | `limit` |
| `browser_help` | **Ask the user for help** (login / verify / choice / blocked / danger). **Browser-related asks only** — anything unrelated to the browser goes through `ask_user_question` (the gateway REFUSES an out-of-scope call; nothing pops up) | `kind`, `questions[]` (legacy `message` + `options` still accepted, folded into one question), `screenshotPath`, `note` |
| `browser_release` | Hand the driver back (at the end of a stretch of work) | — |

## Calling conventions (the discipline written for the session itself)

- **Start with `browser_snapshot`**: read pages through the structured summary; do not screenshot first (screenshots are expensive and only worth it when "what does it look like" really matters).
- **Credentials never enter the chat**: for logins, captchas or payments, call `browser_help` (`kind:"login"`) and let the user act themselves; **never** fill a password with `browser_type`. By default this browser is docked in the session's right panel (the window gives way and the panel is operable); it becomes a window of its own only when the user pops it out — either way the user does the typing.
- **Only ask about the browser**: `browser_help` is for things that are really about the browser / the current page (a login wall, a captcha, verifying a page result, choosing between page options, a site that blocks you, a dangerous page action). Plan/spec confirmations, scope or code choices, missing information and "may I go ahead" go through `ask_user_question` — the gateway refuses out-of-scope `browser_help` calls (the tool fails with a guidance error and **no card pops up**). The judge is "did this round call any `browser_*` tool, or is this session driving the browser".
- **Ask before dangerous actions**: submit / pay / delete / send / publish clicks raise a confirmation card automatically; if rejected, stop and change approach — never retry the same click another way.
- **Stand down while the user drives**: when the user is working in the window, your browser actions are **refused** (not queued) — on a refusal, use `browser_help` to say what you need, or wait for control to come back.
- **Leave a trail**: every action and result goes into the activity stream (the session's right-hand "Browser activity" panel + local activity store) and into your delivery notes (page state, download and screenshot paths, commands run), so the user can check the work.

## Safety gate (defaults)

- **Blocked list**: refused outright; **risky list**: one confirmation card on first visit. Both are edited under the session's right-hand "Browser activity" → "Lists", effective from the next action.
- **Dangerous-action approval**: on by default (can be turned off).
- **User-data directory**: `%APPDATA%\pipeline-console\browser-profile` (separate, logins survive across sessions); screenshots and downloads have their own directories.

## See also

- In-app manual: **"The session's browser"** (the user-facing view: right-hand activity panel, help cards, takeover, auto-continue).
- Design and contracts (frame type / ports / visibility gate): `docs/agent-browser.md`.