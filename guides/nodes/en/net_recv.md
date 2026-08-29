# Network · receive

Listens on a `host:port` channel (TCP / UDP) and **asynchronously forwards** received text downstream — an async source with no data input.

## Ports
- **Input**: none
- **Output**: port 0 = data (received text) · port 1 = control (pulse on message)

## Options
- **Protocol**: TCP / UDP
- **Channel**: multiplexed per channel id (0–65535) on one port; a `net_send` to the same channel is received here
- **Host / port**: default port comes from global settings (Settings · Network, default 40999); per-node override allowed
- **Auto listen**: on by default when the workflow starts

## Typical use
Pair with **Network · send** for cross-canvas / cross-machine text channels: `net_send` pushes to `host:port`, `net_recv` on the same channel feeds processing nodes.
