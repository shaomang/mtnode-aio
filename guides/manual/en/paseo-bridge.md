# Take over sessions from your phone (Paseo)

Install the **Paseo** app on your phone ([paseo.sh](https://paseo.sh), open source), pair it once, and from then on you can watch and take over the **agent sessions** in MTNode's left sidebar: read messages and tool calls, follow live output, send messages, steer mid-turn, stop a turn, and answer the cards that stop and wait for a human (tool approvals, canvas-change confirmations, model questions).

What your phone shows is that very session inside MTNode — **one single set of books**: a message you send on the phone shows up in the desktop sidebar, and a session started on the desktop can be continued from the phone.

## 1. Prepare (on the computer, all inside the plugin)

Open **Plugins** in the top bar -> **Paseo phone handoff**, then work through its console:

1. **Detect the backend**: the console first looks for a Paseo already on this machine (the CLI bundled with Paseo Desktop, or `paseo` on PATH). If it finds none, click **Install backend** and pick a directory - it installs its own copy (a separate home, so it never fights the desktop one for port 6767).
2. **Generate the pairing QR code** and scan it with the Paseo app. The pairing link is shown next to it if you would rather copy it to the phone. (Direct connections still work: on the phone use **Add host -> Direct connection** with your Tailscale IP and port `6767`.)
3. **Register with Paseo**, then turn on the **Remote access** master switch - it is off by default and you open it yourself after pairing.

> The bridge must be launched with a **real Node** (the console shows the exact path the app uses).
> When it cannot connect, click **Bridge self-check**: it probes every data-directory candidate and lists the results.

## 2. Using it

- When creating an agent in Paseo, pick **MTNode 会话 / MTNode sessions**; the mode list lets you start a new one or **continue an existing session**.
- **Models are picked in Paseo too**: the bridge hands over the model list configured on this computer. The model you pick takes effect on the session you **create**, and **an existing session can switch models mid-flight as well** — the session's provider/model change, the **next message** uses the new model, and the history is untouched (a turn that is already running keeps the old model and the phone shows a short note saying so). It is the same thing as switching the model in the session menu on the desktop, not a "pretend" success. **Bridge self-check** tells you how many models and how many existing sessions the phone can actually see, plus whether both model-switch channels are live.
- Sending, steering and stopping mean exactly what they mean on the desktop:
  - while a session is running, your message **queues behind** the current turn instead of interrupting it;
  - “steer” first tries to slip into the running turn and otherwise falls back to the queue — nothing is ever dropped;
  - “stop” is the desktop's ■ (it clears queued messages too).
- **Anything that needs your nod is pushed to the phone**: writing outside the workspace, running commands, changing the canvas — you get allow once / allow for this session / reject. The same card is on the desktop, and **whoever answers first wins**.
- If the phone drops offline, MTNode **keeps waiting** — no auto-reject, no timeout. Answer when you are back.
- **The desktop follows along**: when the phone sends a message, MTNode switches that session to the current one (that is what makes the transcript persist to disk), and switches back to whatever you were viewing once the turn finishes — unless you moved away yourself in the meantime.

## 3. What it does not do

- **It does not edit the canvas from the phone**: canvas changes are still initiated by the AI in the session; you merely press the confirmation button for it.
- This version does not show the model's thinking stream or token usage, and forwards text only (no images or attachments).
- MTNode opens no external port: remote access rides on Paseo's own relay or on Tailscale. MTNode only hands sessions to the bridge.

## 4. Troubleshooting

- **The console says no Paseo CLI was found**: Paseo is not installed here - click **Install backend** in the console, or install the official desktop app.
- **Pairing reports that relay is off**: a freshly installed Paseo home starts with relay disabled; click **Enable relay** in the console (relay is an end-to-end encrypted rendezvous; you do not open any port).
- **No MTNode provider in Paseo**: click **Register with Paseo** again in the console; also check that the first entry of `command` is a real Node, not the app executable.
- **The phone says "no Model detected"**: run **Bridge self-check** and read the `models: N` line. A 0 means the bridge could not obtain the model list - usually MTNode's main window is closed, or no provider is configured yet. Fix that, click **Register with Paseo** so Paseo reloads, then refresh on the phone.
- **Picking a model reports `... does not expose ACP model selection`**: that message comes from Paseo's model-switch flow (`acp` is the protocol base name it records, not a provider). The bridge now implements both channels (`session/set_model` plus the `category: model` config option), so it should not appear any more; if it still does, the phone is talking to an **older bridge script** — repackage, or let the console's **Register with Paseo** point `command` at the new script and reload. The `model switching:` and `configOptions(model):` lines in the self-check confirm both channels.
- **No existing sessions on the phone**: read the `sessions: M` line of the self-check - that count is what the bridge hands over from the desktop sidebar. If the count looks right but the phone is empty, refresh on the phone or reopen the provider from the console. (The history you see on the phone is replayed by the bridge: the last 80 messages, 4000 characters each at most.)
- **It worked yesterday, not today**: MTNode's server **port changes on every launch**. Reopen the provider in Paseo (or restart the daemon); **Bridge self-check** probes the current port.
- **Sending from the phone does nothing**: check that the console says "taking over N session(s)" rather than 0 (0 = the phone is not attached), that the **Remote access** switch is on, and that MTNode's main window is open (sessions execute inside the UI process).
- **You answered an approval but the desktop card is still there**: the card had already expired (the turn ended, or someone else answered it). The phone says so explicitly; ask the model to retry.
- **Revoking a pairing code you already handed out**: Paseo has no "unpair" - use **Reset pairing credentials** in the console. It rotates the daemon keypair and restarts the backend, so **every paired device is invalidated** and must pair again.
- **"Paseo version too low"**: the bridge declares a minimum compatible version (shown in the console). Upgrade Paseo.
