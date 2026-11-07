# Network · receive

Listens on one `host:port` channel (TCP / UDP); every text it receives goes downstream and also pulses the control port. No data input — it is a pure source.

## Ports
- **In**: none
- **Out**: port 0 = info (received text) · port 1 = control (one pulse per message)

## Settings
- All of these are edited in the settings window opened by **⚙ Settings** in the node header:
- **Listen port**: 0–65535, 40999 on a new node; 0 = use the global port (Settings · Network, default 40999)
- **Channel number (16-bit)**: 0–65535; one port splits traffic by channel, a `net_send` must use the same channel
- **Protocol**: TCP / UDP (TCP by default)
- **Listen automatically at startup**: on by default — opening MTNode or switching back to this canvas starts listening
- Changing port / channel / protocol restarts the listener right away; “▶ Start listening / ■ Stop listening / Clear / netdebug” stay on the card together with a one-line summary of the current settings

## Usage
- With auto-listen on there is nothing to press: `net_send` pushes a string, this node stores it, runs its data downstream silently and fires control port 1

## Notes
- Frames are MTNode's own format (2-byte channel + 4-byte length + UTF-8 body); plain-text senders will not be understood
- If another program owns the port, listening fails and the node shows why; several receivers on the same port / protocol share one listener and are told apart by channel
- Channel and protocol must both match — one matching is not enough
