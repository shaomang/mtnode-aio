# Asset library

Brand guidelines, style sheets, recurring character portraits, and reference voice clips belong in the **Asset library** so you never have to hunt for them across folders.

## Managing your assets

Open **Asset library (`L`)** from the top bar to organize reusable text snippets, images, audio, and video:

- **Drag & drop import**: Import files in batches, and edit saved text snippets directly inside the library.
- **Stored locally**: Everything lives in your local MTNode data folder and survives app upgrades.

## Using assets on the canvas

1. Add an **Asset node** (or drag items straight from the Asset library onto the canvas).
2. Check the entries you want — each selected item becomes its own output port.
3. Wire any port to a downstream node and reference it with `@` in your prompt. Whenever you update that asset in the library, every canvas connected to it uses the latest version automatically.
