# MCP extensions & external clients

MCP (Model Context Protocol) lets AI apps share tools cleanly. MTNode works in both directions: connect external MCP tools **into** MTNode, or let external AI clients like **Claude Code** and **Cursor** connect **to** MTNode to work with your canvases.

## 1. Adding external tools & skills to MTNode

Open **Settings → Extensions → Manage…** to manage everything in one place:

- **MCP servers**: Register external MCP servers (databases, note apps, dev tools) so Agent sessions can call them. Select any server and click **List resources** to inspect read-only resources and copy URIs.
- **Skills**: Manage built-in and custom skills you invoke with `/` in chat or the assistant bar.
- **Blender Local plugin (3D)**: Want AI to model or render in Blender? Install **Blender Local** from the top bar **Plugins** window — it downloads an official portable Blender, configures the MCP bridge automatically, and leaves any Blender window you open manually untouched.

## 2. Connecting external clients to MTNode (built-in MCP server)

Let **Claude Code**, **Cursor**, or custom MCP clients read and edit your MTNode canvases, query your Asset library and AI fact library, or analyze images through MTNode.

### Setup in two steps

1. Open **Settings → Extensions → Manage…** and switch to the **Server** tab (enabled by default, listening on localhost only so no other machine on your network can reach it).
2. Click to copy the ready-made **stdio client config** (powered by the bundled `mcp-stdio.js` bridge with your local Bearer token) and paste it into your client's MCP settings.
3. Click **Self-check** to verify the full connection end to end.

### Security & audit logs

- **Toggle or rotate token anytime**: Turn off the master switch to stop listening immediately, or click **Reset token** if you ever want to revoke old configs.
- **Audit trail**: See exactly when an external client called which tool on which canvas right inside the panel (logs rotate daily in `mcp-audit/` inside your data folder for 7 days).
- **Local-only boundary**: Traffic never leaves localhost, and external clients cannot bypass your local approval rules.
