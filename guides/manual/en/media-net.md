# Network & launch

> In one sentence: carry text between two machines or two canvases with net_recv / net_send, and start a local program from the canvas with one click via the execute node.

![Network nodes](img/mtnode-flow-09-flow.svg)
*Figure 1: net_send and net_recv talk to each other over the same channel number.*

## Goal

After this page you can set up a cross-machine / cross-canvas text channel (TCP / UDP), and make the execute node a "one-click launch" button on the canvas.

## Before you start

- Knowing that `net_recv` / `net_send` live under **Other nodes** in the right-click menu, and **Execute** lives under **Dev node** — see [Nodes, wires, @ refs](#nodes-wires).
- For cross-machine transfer, both machines must be reachable from each other and the firewall must let the port through.
- To launch a project script from the canvas, the script file must already exist on this machine.

## Steps

### 1. Place the network nodes

1. **Right-click empty canvas** → **Other nodes** → **net_recv (receive)** or **net_send (send)**.
2. **Put one on each machine**: one receives, one sends; the same works between two canvases on one machine.

### 2. Line up the channel

1. **Pick the protocol**: TCP or UDP — both ends must match.
2. **Set address and port**: fill in `host:port`; a port of **0** means use the **default port from global settings** (receive 40999 / send 41000, changeable in Settings · Network), and you can also override it per node.
3. **Pick a channel number**: the same port is multiplexed by **channel number (0–65535)**; send and receive that use the **same channel talk to each other**, and different channels never interfere.

### 3. Wire the receiving end

1. `net_recv` listens on `host:port` and **forwards received text downstream asynchronously**: port 0 = data, port 1 = control.
2. It **listens automatically** by default; for manual control, turn off "listen on start" and trigger it from a control wire.

### 4. Wire the sending end

1. `net_send` pushes the text on its data input port to the target `host:port`: port 0 = data, port 1 = control trigger.
2. It is a **terminal node**: all it does is send the content out, and it passes no data further downstream.

### 5. Place an execute node

1. **Right-click** → **Dev node (project architecture · feature block)** → **Execute**.
2. **Bind a file**: `.exe` / `.bat` / `.cmd` / `.lnk`, or anything the system can open.
3. **Double-click the node to run it** (or click the play button twice) and it starts through the **operating system's default handler**; the execute node has **no data ports** and takes no data wires.
4. **Set an icon and theme colour** so the launch entry is easy to spot next to an architecture diagram.

![Execute node](img/mtnode-flow-10-flow.svg)
*Figure 2: the execute node binds .exe / .bat / .cmd / .lnk, starts on double-click, and has no data ports.*

> 💡 Tip: The media generation nodes (music / speech / video) have moved to [Music / speech / video](#media-gen) — this page covers only networking and launching.

## Result

- ▶ on one machine triggers a send, and the receiving node on the other machine gets the text on the same channel and carries on running downstream.
- The canvas gains a program entry that starts on double-click, handy next to a dev node's project architecture.
- Channel, port and protocol can all be overridden per node, and one port can carry several mutually independent channels in parallel.

## Common mistakes

| Symptom | Cause | Fix |
| --- | --- | --- |
| The receiver never gets a message | Protocol / port / channel number differ between the two ends | Align proto + port + channel item by item; with port 0 the defaults in Settings · Network apply |
| Clicking send does nothing | The control port was never triggered | Trigger net_send's control port with a control wire or ▶ |
| It reports the port is in use | The target port is already listened on by another process | Change the port, or change the default ports in Settings · Network |
| Double-clicking the execute node does not launch | The bound path is stale, or the file is not a type the system can open | Pick the bound file again and make sure the extension is within `.exe / .bat / .cmd / .lnk` |
| You want to take data out of the execute node | The execute node has no data ports | Carry the data flow with network or save nodes; the execute node only launches |
| You cannot find the media generation nodes on this page | Media generation moved onto its own page | Go to [Music / speech / video](#media-gen) |

## Next

- [Control flow & judges](#control-flow)
- [Music / speech / video](#media-gen)
- [Node guide index](#node-guide)
- [Settings](#settings)
