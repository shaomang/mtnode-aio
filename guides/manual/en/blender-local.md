# Blender local plugin: let the agent drive Blender

The **Blender local plugin** installs three things in one pass: an **official** portable Blender
(into a folder you pick), the community-standard **mcp-for-blender** addon, and its MCP server —
then registers that MCP server in MTNode's MCP config. After you restart MTNode, **your agent
sessions gain `blender` tools**, so the agent can build scenes, place cameras, tweak materials and
render a preview for you.

## 1. Install (once)

Top bar **Plugins** → **Blender Local** → **Install**. The install window runs, in order:

1. **Version**: reads the official `download.blender.org` listing and takes the **latest stable**
   (currently 5.2.x). If Blender is already installed it skips the download (**no auto-upgrade**).
2. **Download**: the official windows-x64 portable zip (~405MB), **sha256 verified**, resumable.
3. **Extract** into the folder you chose in the plugin screen (default: `blender` under your plugin
   root). No registry writes, no admin rights.
4. **uv**: the MCP server runs through `uvx`; if uv is missing it installs the official one
   (falling back to the official release zip).
5. **Addon**: installs into your Blender user config, then **enables it and saves preferences**
   (your `userpref` is backed up first).
6. **Register MCP**: writes `serverName=blender` into MTNode's MCP config; if 9876 is busy it picks a
   free port in 9876–9886.
7. **Smoke test**: really launches Blender, waits for the addon socket, then performs an MCP
   handshake (and reads the tool list). A Blender window flashes briefly and is closed afterwards —
   **this step passing is what "installed" means**.

Restart MTNode afterwards: the MCP config is read at startup only.

While it runs, the window keeps **Close window**: closing only hides the window, the install keeps
going in the background and reopening shows live progress. To really stop it, hit **Cancel**: the
chain halts right there (no addon, no MCP registration, no Blender smoke test), already downloaded
files are kept, and **Retry** picks up where it left off.

## 2. Use

- Just ask in a session: "use blender to add a cube, a light, and render an image" — the agent calls
  the `blender` tools.
- On the plugin card:
  - **Enable** launches a Blender owned by the plugin with the addon server up (only shown once installed);
  - **Disable** closes **that** Blender only — **a Blender you opened yourself is never touched**;
  - **Console** shows per-item status (Blender / addon / uv / MCP / port), logs, **Test connection**,
    **Check for updates** (notify only, never auto-upgrades), **Open install folder**, and **Uninstall**.
- To let the agent drive **a project you already have open**: enable "MCP for Blender" in that Blender
  and start its server (MCP panel in the sidebar) using the port shown in the console — or let the
  plugin launch a fresh instance and open the project there.

## 3. When install fails

The install window shows a Chinese reason and next step at the failing step; **Hand to an MTNode
session** opens a session with the log and follows the `blender-local-install` skill's
"self-repair" section. Common cases:

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| Download keeps failing | Official site unreachable / proxy | Retry on another network (it resumes); check the HTTP code in the log |
| sha256 mismatch | Truncated transfer | Just retry (the bad zip was deleted) |
| Addon enable failed | Blender is running and holds the preferences file | Close all Blender instances and retry, or tick "MCP for Blender" manually in Preferences |
| Smoke timeout (port never opens) | Addon not enabled / port taken | Read Blender's output in the log; free the port and hit "Test connection" |
| No blender tools after restart | MCP config not picked up | Make sure MTNode was restarted; `blender` should be listed in Settings → Capabilities → MCP |
| Console says "MCP not registered" | The MCP row was deleted / the config file was rewritten | Click "Install / Reinstall": when Blender is already installed it only re-registers that row and does not download again |

## 4. Uninstall

**Uninstall plugin…** at the bottom of the console shows the list and asks for confirmation: it
removes the MCP entry, deletes the addon, **and deletes the Blender install folder** (this plugin owns
what it installed). It **keeps**: the `userpref` backup, an existing uv on the machine, and your own
`.blend` project files.

## 5. Boundaries

- Blender comes **only** from the official `download.blender.org`, sha256-verified; no third-party mirrors.
- No auto-upgrade; to move to a newer version, uninstall and install again.
- It only starts/stops the Blender **it launched**; your own instances and projects are left alone.
- Dependencies: Blender from the official site; uv / PyPI official first, automatic fallback to CN
  mirrors on failure (the log says which source was used).
