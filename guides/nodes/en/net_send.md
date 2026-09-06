# Network · send

Pushes the data input text to a target `host:port` channel (TCP / UDP). Terminal node with no output.

## Ports
- **Input**: port 0 = data (text to send) · port 1 = control input (trigger)
- **Output**: none

## Settings
Target address / port / channel / protocol are all edited in the settings window opened by **⚙ Settings** in the node header; “Send / Clear / netdebug” stay on the node as actions, and the node shows just a one-line summary of the current settings.

## Options
- **Protocol**: TCP / UDP
- **Channel**: multiplexed per channel id (0–65535) on one port; a `net_recv` on the same channel receives it
- **Host / port**: target address; port 0 means the global default (Settings · Network, default 41000)

## Typical use
Pair with **Network · receive** for cross-canvas / cross-machine text channels: process node → `net_send` → (network) → `net_recv` → downstream.
