# MCP server (let outside clients in)

MTNode is normally an **MCP client**: it connects to MCP servers other people wrote and adds their tools to the Agent in a session (see “What agent mode is”). This page is about **the other half** — MTNode opening an MCP server of its own so other clients (Claude Code, Cursor, your own Agent) can connect and drive the MTNode on this machine: read and change the canvas, query database replicas and the AI fact library, browse the asset library, read images.

## Where it lives, how to turn it on

The top bar's “Plugins” dialog is not the way in — the entry is **Settings → Extension capabilities → Manage…**, on the **Server** page. It is **already on** by default (it starts listening on first launch). The page has:

- **Master switch**: off = stop listening (the port disappears; a client that is already connected gets a clear error on its next call).
- **Address**: `http://127.0.0.1:<random port>/mcp`, bound to the loopback interface only — other machines on your LAN cannot reach it.
- **Token**: a random Bearer token the client must send. You can **reset** it at any time (after a reset, configured clients must copy the config snippet again).
- **stdio client config snippet**: the JSON block Claude Code / Cursor style clients need, copied with one click.
- **Self-check**: without any external client, it walks “initialize → list tools → really read the canvas once” itself; green means the whole chain works.
- **Recent calls (audit)**: who, when, which tool, which canvas, success or failure. Logs land in `mcp-audit/` inside the data directory (rotated daily, kept 7 days).
- **Raw JSON-RPC capture**: for troubleshooting, must be switched on explicitly, keeps only the last 200 frames, memory only.

## Connecting a client

Both transports are offered by the same server:

**① stdio (what most local clients use)** — merge this into the client's MCP config:

```json
{
  "mcpServers": {
    "mtnode": {
      "command": "node",
      "args": ["<MTNode install dir or repo root>/mcp-stdio.js"]
    }
  }
}
```

That is exactly what “Copy config snippet” on the panel produces (with the path already filled in). The bridge script reads the port and token from the data directory itself, so you **never hand-fill an address and never paste the token into a config file**. When MTNode is not running the client sees “cannot reach the MTNode MCP server — open MTNode and try again”.

**② Local HTTP** — for your own client or a remote tool: `POST http://127.0.0.1:<port>/mcp` with the header `Authorization: Bearer <token>` and an MCP JSON-RPC body (`initialize` / `tools/list` / `tools/call` / `resources/list` / `resources/read` / `prompts/list` / `prompts/get`).

## What outside clients can do

Tool names and parameters are **identical** to MTNode's own Agent (`mtnode_canvas_get`, `mtnode_canvas_edit`, `mtnode_app`, `mtnode_db`, `mtnode_facts`, `lt_state`, `mtnode_assets`, `mtnode_vision`), so the existing node guides and skill docs apply to third parties unchanged.

Beyond tools, two more MCP capability kinds are open:

- **Resources**: canvas list, canvas snapshot, a single node's body, built-in skill text — a client can “browse” before it acts.
- **Prompts**: three templates — take over a canvas, build a workflow, review a canvas; MTNode's own hard rules (read the canvas before editing, batch safety) are written straight into the templates.

## Three hard rules

1. **Read before you write**: the `mtnode_canvas_get` receipt carries a `contentHash`; pass it back verbatim as `baseHash` to `mtnode_canvas_edit`. If the hash does not match (someone changed that canvas in between) the edit is rejected — read again, then edit. This is what stops two clients from overwriting each other.
2. **One write at a time**: canvas writes are queued and serialised, both between third-party connections and between a third party and yourself; reads run concurrently.
3. **The current canvas is the default target**: to touch another canvas, pass the `canvas` parameter (canvas id or exact name). One connection can work on every canvas on this machine.

## Permissions and audit

- **After the first-connection authorisation, full read/write**: server up plus a valid token is enough to change the canvas — no per-call confirmation dialog (otherwise third-party automation would be unusable). To take it back: turn the master switch off, or reset the token.
- Your **own** sessions, assistant and agent nodes are untouched: their confirmation dialogs, approval level and permission panel behave exactly as before.
- Every call (including rejected ones) is written to `mcp-audit/`: time, session, client identity, tool, canvas, duration, success/failure, error reason, parameter summary.

## What outside clients cannot do (stated plainly)

- **A long-running task cannot have its “confirm delivery” clicked for you**: MCP can read a long task's definition and run state and read/change this round's shared state, but “enable / advance / approve” stays in your hands on the strip.
- **Media generation is not a standalone tool**: text-to-image / music / speech / video are canvas **nodes**; what a third party can do is create those nodes and wire them up — actually running them is still your click (same rule as MTNode's own Agent).
- **The generic tools of the dsh engine** (file I/O, command execution, web search) are **not** exposed to third parties: clients already have those abilities themselves and need not go through MTNode.
- **A session's own browser control surface** (the 13 `browser_*` tools) is **not** exposed: that is your browser session and is not handed to an outside client.

## Troubleshooting

| Symptom | Where to look first |
| --- | --- |
| Client cannot connect | Is the panel's master switch “listening”; does the script path in the client config exist; is `node --version` ≥ 18 (a managed Node works too, see the notes in `dsh/`) |
| Client says “cannot find the MTNode MCP server's runtime info” | MTNode is not running; or the data directory is not the default one (portable build / custom data dir: give the client the `MTNODE_DATA_DIR` environment variable, or pass `MTNODE_MCP_URL` + `MTNODE_MCP_TOKEN` directly) |
| A call returns 401 | Wrong token (did you reset it?) — copy the config snippet again |
| A call returns “the canvas has been changed” | Someone edited that canvas after you read it: `mtnode_canvas_get` again, then edit |
| A call **hangs and never returns** (spinning until timeout) | Was the MTNode main window closed (execution happens in the renderer — no window, nobody to execute it); if it reproduces, note the tool name that was being called and report it to us (no receipt from the renderer is a defect) |
| You want to see exactly what the client sent | Switch on “Raw JSON-RPC capture” and reproduce once |

The machine-readable contract for the interface lives in the repo: `mcp-tools.json` (generated from `dsh/gateway/*-plugin.mjs` by `node scripts/build-mcp-contract.mjs`, never edit by hand); the integration guide and per-client config samples are in `guides/mcp-server.md`.
