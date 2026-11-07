# Browser tools (session capability)

The session's own browser: no bundled engine — it drives the Edge / Chrome already installed on this machine with a separate user-data directory (its own logins). This tool family is **registered for sessions only**: canvas agent nodes and agent tasks do not get it, and neither does pure mode.

Manual entry: the **Browser activity** button in the session composer opens the right-hand activity panel (hidden entirely until called or until the browser starts). The **real window** is toggled by “Open in a real window / Take back” in the panel's live header; **takeover** has no button — login help is taken over by the gateway automatically and handed back once the user answers.

## Ports
- **In**: none (not a canvas node — a session tool family)
- **Out**: none

## Settings
There is no **⚙ settings** window; these are fixed:

- **User-data directory**: `%APPDATA%\pipeline-console\browser-profile` (separate, logins survive across sessions); screenshots and downloads have their own folders.
- **Dangerous-action approval**: always on (submit / pay / delete / send / publish clicks raise a confirmation card every time; there is no switch).
- **The domain lists are gone**: no blocked or risky list and no first-visit confirmation; decide per task which site to visit.

## Usage
- Start with **`browser_snapshot`**: title / URL / clickable elements / visible text / page errors, with `textLimit` defaulting to 4000 chars. Screenshots are expensive — use `browser_screenshot` only when “what does it look like” really matters.
- The rest: `browser_launch` (start on demand, reuse an existing one), `browser_navigate` (`url`, `waitMs`), `browser_click` (`selector` or `text`), `browser_type` (`selector`, `text`, `submit`), `browser_key` (`key`), `browser_eval` (`expression`, returns a summary), `browser_wait` (`selector` / `text` / `ms`), `browser_tabs` (`action`, `targetId`), `browser_network` (`limit`), `browser_release` (hand the driver back).
- **`browser_help` asks the user for help**: only for things about the browser / the current page (login wall, captcha, verifying or choosing on the page, a site blocking you, a dangerous page action); anything unrelated goes through `ask_user_question` — the gateway **refuses** an out-of-scope call. Parameters `kind`, `questions[]` (legacy `message` + `options` still accepted), `screenshotPath`, `note`; the reply is `answers[]`. `kind:"login"` takes over automatically and hands back when answered.

## Notes
- **Credentials never enter the chat**: logins, captchas and payments are done by the user; **never** fill a password with `browser_type`.
- If the user picks “later / interrupt”, this help call **fails** — that is “no one answered”, not consent; do not treat an empty answer as a conclusion.
- While the user drives the window (takeover), your browser actions are **refused** (not queued): wait for the help card to be answered, or use `browser_help` to say what you need.
- Every action and result goes into the activity panel and the local activity store, and into your delivery notes (page state, download and screenshot paths, commands run) so the user can check the work.
