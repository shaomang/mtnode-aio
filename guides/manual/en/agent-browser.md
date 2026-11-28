# Browser automation

Inside an Agent session, the AI can open real web pages, click buttons, fill forms, and gather information across pages — while letting you watch live and step in whenever a site needs a login or verification.

## Watch live in "Browser activity"

When the agent starts using the browser, click **Browser activity** above the session composer to open the live side panel:

- **Live view**: See the current page and follow each click or navigation in real time.
- **Open real window / Dock back**: Need to sign in, enter a password, or complete a check yourself? Click **Open real window** to interact directly in a real browser window (passwords you type never enter the chat log), then dock it back when done.
- **Pause / Reconnect**: Pause live preview updates or reconnect the stream anytime without disturbing the running browser.

## When the agent asks for your help

The agent pauses and pops up a clear help card instead of guessing whenever it hits:

- A login page or QR sign-in;
- A CAPTCHA or human verification check;
- Payments, orders, destructive deletes, or public posting;
- A decision only you can make.

Handle the step in the real window (or reply on the card) and click continue to hand control back.

## Auto-continue for multi-step web tasks

By default, the agent pauses after each turn so you stay in charge. For multi-page browsing tasks, open the session **Mode** menu and turn on **Auto-continue**:

- If a turn finishes with clear remaining steps, the agent keeps going automatically;
- It stops cleanly when everything is done, nothing is left to do, or you click Stop.

> **Boundaries**: Browser automation is available in Agent sessions only. High-risk actions are blocked by default, and the live preview stream is purely for your eyes — it does not bloat the model's context.
