# Take over sessions from your phone (Paseo)

Install the **Paseo** app on your phone ([paseo.sh](https://paseo.sh), open source), pair it once, and from then on you can watch and take over the **agent sessions** in MTNode's left sidebar: read messages and tool calls, follow live output, send messages, steer mid-turn, stop a turn, and answer whatever stops and waits for a human — tool approvals and canvas-change confirmations arrive as cards, **model questions arrive as a plain readable message you simply reply to**.

What your phone shows is that very session inside MTNode — **one single set of books**: a message you send on the phone shows up in the desktop sidebar, and a session started on the desktop can be continued from the phone.

## 1. Prepare (on the computer, all inside the plugin)

Open **Plugins** in the top bar -> **Paseo phone handoff**. Install first, then work through its console:

**Install**: click **Install** on the card (it reads **Reinstall** once installed). The install window first looks for a Paseo already on this machine (the CLI bundled with Paseo Desktop, or `paseo` on PATH) and reuses it — it only runs `npm i @getpaseo/cli` into `<plugin root>\paseo` when there is none, and it installs a managed real Node for you when the machine lacks one. Tick **Build our own copy anyway** in that window to ignore a Paseo you already have. To clean up, use **Uninstall** in the same window: it only removes this plugin's own data and never touches Paseo Desktop or `~/.paseo`.

**Configure**: click **Console** on the card and:

1. **Generate the pairing QR code** and scan it with the Paseo app. The pairing link is shown next to it if you would rather copy it to the phone. (Direct connections still work: on the phone use **Add host -> Direct connection** with your Tailscale IP and port `6767`.)
2. **Register with Paseo**.
3. Turn on the **Remote access** master switch - or, simpler, click **Enable** on the plugin card (it starts the backend and opens the master switch; **disabled by default**, nothing runs until you do).

> The bridge must be launched with a **real Node** (the install window installs a managed one when needed; the console shows the exact path the app uses).
> When it cannot connect, click **Bridge self-check**: it probes every data-directory candidate and lists the results.
> A self-built backend is **run silently in the background by MTNode** (no terminal window pops up any more); **Enable / Disable** live on the card and **Enable backend / Disable backend** in the console (same thing). It **stops together with MTNode** — keep MTNode open while you want the phone attached.

## 2. Using it

- When creating an agent in Paseo, pick **MTNode 会话 / MTNode sessions**; the mode list lets you start a new one or **continue an existing session**.
- **Models are picked in Paseo too**: the bridge hands over the model list configured on this computer. The model you pick takes effect on the session you **create**, and **an existing session can switch models mid-flight as well** — the session's provider/model change, the **next message** uses the new model, and the history is untouched (a turn that is already running keeps the old model and the phone shows a short note saying so). It is the same thing as switching the model in the session menu on the desktop, not a "pretend" success. **Bridge self-check** tells you how many models and how many existing sessions the phone can actually see, plus whether both model-switch channels are live.
- Sending, steering and stopping mean exactly what they mean on the desktop:
  - while a session is running, your message **queues behind** the current turn instead of interrupting it;
  - “steer” first tries to slip into the running turn and otherwise falls back to the queue — nothing is ever dropped;
  - “stop” is the desktop's ■ (it clears queued messages too).
- **Anything that needs your nod is pushed to the phone**: writing outside the workspace, running commands, changing the canvas — you get allow once / allow for this session / reject. The same card is on the desktop, and **whoever answers first wins**.
- **When the AI asks you something, the phone gets an ordinary message**: the question, the options and a short "how to answer" note are all in the text (no code, no JSON). **Replying with a message in the composer is the answer** — it is delivered as the answer to that question (not as a new instruction), and the AI carries on. Press stop to abort instead. If you already answered on the desktop, your message is forwarded as an ordinary message instead of being swallowed as an answer.
- A session the phone has taken over **no longer pops a question card on the desktop** (you are not sitting there, so the card would just sit and wait). It becomes one line in the session saying the question goes to the phone as plain text — reply in the phone's composer and that is the answer. **Approval cards are unaffected** (writing files, running commands, canvas edits): both the desktop and the phone can still answer them.
- If the phone drops offline, MTNode **keeps waiting** — no auto-reject, no timeout. Answer when you are back.
- **The desktop follows along**: when the phone sends a message, MTNode switches that session to the current one (that is what makes the transcript persist to disk), and switches back to whatever you were viewing once the turn finishes — unless you moved away yourself in the meantime.

## 3. What it does not do

- **It does not edit the canvas from the phone**: canvas changes are still initiated by the AI in the session; you merely press the confirmation button for it.
- This version does not show the model's thinking stream or token usage, and forwards text only (no images or attachments).
- MTNode opens no external port: remote access rides on Paseo's own relay or on Tailscale. MTNode only hands sessions to the bridge.

## 4. Troubleshooting

- **The console says no Paseo CLI was found**: Paseo is not installed here - click **Install** on the plugin card (then **Start install** in the install window), or install the official desktop app.
- **Pairing reports that relay is off**: a freshly installed Paseo home starts with relay disabled; click **Enable relay** in the console (relay is an end-to-end encrypted rendezvous; you do not open any port).
- **No MTNode provider in Paseo**: click **Register with Paseo** again in the console; also check that the first entry of `command` is a real Node, not the app executable.
- **The phone says "no Model detected"**: run **Bridge self-check** and read the `models: N` line. A 0 means the bridge could not obtain the model list - usually MTNode's main window is closed, or no provider is configured yet. Fix that, click **Register with Paseo** so Paseo reloads, then refresh on the phone.
- **Picking a model reports `... does not expose ACP model selection`**: that message comes from Paseo's model-switch flow (`acp` is the protocol base name it records, not a provider). The bridge now implements both channels (`session/set_model` plus the `category: model` config option), so it should not appear any more; if it still does, the phone is talking to an **older bridge script** — repackage, or let the console's **Register with Paseo** point `command` at the new script and reload. The `model switching:` and `configOptions(model):` lines in the self-check confirm both channels.
- **No existing sessions on the phone**: read the `sessions: M` line of the self-check - that count is what the bridge hands over from the desktop sidebar. If the count looks right but the phone is empty, refresh on the phone or reopen the provider from the console. (The history you see on the phone is replayed by the bridge: the last 80 messages, 4000 characters each at most.)
- **It worked yesterday, not today**: MTNode's server **port changes on every launch**. Reopen the provider in Paseo (or restart the daemon); **Bridge self-check** probes the current port.
- **Sending from the phone does nothing**: check that the console says "taking over N session(s)" rather than 0 (0 = the phone is not attached), that the **Remote access** switch is on, and that MTNode's main window is open (sessions execute inside the UI process).
- **You answered an approval but the desktop card is still there**: the card had already expired (the turn ended, or someone else answered it). The phone says so explicitly; ask the model to retry.
- **A question shows up as `Other` with raw JSON inside** (older builds): the phone is talking to an **older bridge script**. Click **Register with Paseo** in the console so `command` points at the new script (reinstall for packaged builds), then reload the provider. New builds send the question as a plain readable message, so that card no longer appears.
- **You replied on the phone but the AI treated it as a new instruction**: same cause, an older bridge script. New builds treat a reply as the answer while a question is pending. One other case exists: if the question was already answered on the desktop (or that turn had ended), your message is forwarded as an ordinary message instead.
- **Revoking a pairing code you already handed out**: Paseo has no "unpair" - use **Reset pairing credentials** in the console. It rotates the daemon keypair and restarts the backend, so **every paired device is invalidated** and must pair again.
- **The phone cannot connect once MTNode is closed**: that is the current design — the self-built backend is a child process of MTNode and **stops with it** (no orphan process, and no terminal window that could be closed by accident). Keep MTNode open while you want the phone attached.
- **The backend does not come back after restarting MTNode**: it is **disabled by default** — only **Enable** on the card, **Enable backend** in the console, or a finished install writes the enabled flag, and only then does the next start resume it; **Disable** clears the flag. Machines upgraded from an older build are silently marked as disabled on first start, with no popup.
- **The console marks the daemon as "legacy (with window)"**: you are still running a backend that opens its own terminal window. Restart MTNode (or click **Disable backend** and then **Enable backend**) and it is switched to the silent mode; pairing is untouched, the phone may drop for a moment.
- **"Paseo version too low"**: the bridge declares a minimum compatible version (shown in the console). Upgrade Paseo.
