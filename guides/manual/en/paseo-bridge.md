# Take over sessions from your phone (Paseo)

Install the **Paseo** app on your phone ([paseo.sh](https://paseo.sh), open source), pair it once, and from then on you can watch and take over the **agent sessions** in MTNode's left sidebar: read messages and tool calls, follow live output, send messages, steer mid-turn, stop a turn, and answer the cards that stop and wait for a human (tool approvals, canvas-change confirmations, model questions).

What your phone shows is that very session inside MTNode — **one single set of books**: a message you send on the phone shows up in the desktop sidebar, and a session started on the desktop can be continued from the phone.

## 1. Prepare (on the computer)

1. Install Paseo (Desktop or CLI) and let it run the local daemon.
2. Open MTNode's **Extension capabilities → Server** page and scroll to the **Paseo bridge** block:
   click **Copy provider snippet**, merge it into `agents.providers` in `~/.paseo/config.json`, then run `paseo reload`.
   The block also shows where the bridge script lives, which Node launches it, the data directory, and the protocol / minimum Paseo version.
3. In Paseo, pair a device (relay QR code), or on the phone use **Add host → Direct connection** with your Tailscale IP and port `6767`.

> The bridge must be launched with a **real Node** (the panel hands you the exact path the app uses).
> When it cannot connect, run **Bridge self-check** on that panel: it lists every data-directory candidate and the result of probing them.

## 2. Using it

- When creating an agent in Paseo, pick **MTNode 会话 / MTNode sessions**; the mode list lets you start a new one or **continue an existing session**.
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

- **No MTNode provider in Paseo**: `~/.paseo/config.json` is wrong or `paseo reload` was not run; also check that the first entry of `command` is a real Node, not the app executable.
- **It worked yesterday, not today**: MTNode's server **port changes on every launch**. Reopen the provider in Paseo (or restart the daemon); **Bridge self-check** probes the current port.
- **Sending from the phone does nothing**: check that the panel says “remote takeover: N session(s)” rather than 0 (0 = the phone is not attached), and that MTNode's main window is open (sessions execute inside the UI process).
- **You answered an approval but the desktop card is still there**: the card had already expired (the turn ended, or someone else answered it). The phone says so explicitly; ask the model to retry.
- **“Paseo version too low”**: the bridge declares a minimum compatible version (shown on the panel). Upgrade Paseo.
