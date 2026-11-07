# App node (appnode)

Pin an app from the Apps center onto the canvas: click the card and a closable full-screen UI opens in the **canvas area**, running that app's static page (`index.html` plus relative assets).

## Ports
- **In**: none
- **Out**: none (a pure launcher — it never takes part in runs and no wire can feed it data)

## Settings
There is no **⚙ settings** window — everything is on the card:

- **Pick an app**: choose from every app on this machine (in-development and downloaded ones are both listed). **Chosen once and fixed**: afterwards the card has no way to switch apps, and **Re-bind** only appears when the app can no longer be found locally (it needs two clicks to confirm).
- Binding also creates this node's data folder inside the canvas working folder.

## Usage
1. Right-click the canvas → **App node (pin an app · open full screen)** → **App node (bind an app · open its full-screen UI)**, or add one from the sidebar's **App node** category.
2. Click the card body to open the UI. Top-right has two buttons: **Collapse** (✕ / Esc) sends it to the background and keeps it running; **Stop** really ends this run and frees memory (data is saved), and the next card click starts it again. While collapsed the card reads **Running in background** and keeps **Stop app completely**.
3. The UI follows the canvas: sidebars, the assistant panel and window resizes all resize it live. Switching to the session / team view hides it (still running in the background) and coming back restores it.

## Notes
- The UI is an iframe at `mtnode-preview://<app id>/<entry page>?_host=1&_anode=1` and uses the injected `window.appHost`: `dataRead / dataWrite / storage* / dataDir*`, `canvas` (read/write the whole graph, `runNode` to really run a node and await its result, `nodeOutput` for the last result, `cancelNode` like the canvas Stop), `agent` (sessions), `fs` (canvas working folder only), `tools`, `net`, `textGenStream / imageGen / imageEdit / transcribe …`. The bridge opens methods **one by one per namespace** — it does not hand the page the whole `window.api`.
- `canvas.runNode` uses the same path as clicking ▶: upstream auto-runs, cascades, assets land in the canvas asset folder. `attempts` defaults to 1 image (1–10); if a run is already going it waits for that one instead of paying twice; with no working folder it returns `no_workspace` and shows no dialog; the host sets no timeout, so long tasks race their own `Promise.race` + `cancelNode`. It needs the `capabilities.canvasHost` capability and asks for permission once.
- Data lives at `<canvas working folder>/apps-data/<app id>/data.json`, travels with the canvas working folder, is capped at 2 MB and written atomically (tmp + rename); the card shows the path and can open the folder.
- Only one UI is open at a time, and only one app node may stay alive in the background (opening a new one stops the old). It lives until the node is deleted / the canvas is switched / MTNode quits / Stop is pressed. Pages can only read and write files inside the canvas working folder; anything outside is refused.
