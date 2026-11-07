# Network · send

Pushes the upstream text as a frame to one channel on `host:port` (TCP / UDP). Terminal node, no output.

## Ports
- **In**: port 0 = info (text to send) · port 1 = control (triggers a send)
- **Out**: none

## Settings
- All of these are edited in the settings window opened by **⚙ Settings** in the node header:
- **Target address**: 127.0.0.1 by default, a remote IP is fine
- **Target port**: 0–65535, 41000 on a new node (kept apart from the listen port for two-way debugging on one machine); 0 = use the global port (Settings · Network, default 40999)
- **Channel number (16-bit)**: 0–65535; the peer `net_recv` must listen on the same channel
- **Protocol**: TCP / UDP (TCP by default) and it must match the peer
- “▶ Send / Clear count / netdebug” stay on the card together with a one-line summary of the current settings

## Usage
- Wire port 0 to an upstream node (text / asset), then press “▶ Send” or let a control wire on port 1 trigger it

## Notes
- With nothing wired to port 0 it reports that no info input is connected; empty upstream content is not sent either
- Frames are MTNode's own format (2-byte channel + 4-byte length + UTF-8 body), not bare text
- If TCP cannot reach the peer, it reports a send timeout after about 4 seconds
