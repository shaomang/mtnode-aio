# Text & image generation

The core canvas pattern is **Input → Process → Save**: place your source material on the left, let AI transform it in the middle, and save the finished result automatically on the right.

![Basic content generation chain](img/mtnode-flow-01-ui.svg)

## Text processing node

Sends upstream text, files, or images to an AI model and outputs fresh text.

### Two modes

- **Normal mode (default)**: One call in, one result out — fast and inexpensive for rewriting, translating, summarizing, or extracting structured data. Connect a **Save** node afterward to write `.md` or `.pdf`.
- **Agent mode**: Turns the node into a mini agent that can read project files, work through multiple steps, and write files itself — no separate Save node needed.

### Key settings

- **Prompt**: Be clear about role, goal, format, and length, and reference connected inputs with `@NodeTitle`.
- **Model & thinking effort**: Click **⚙ Settings** on the node to choose provider and model. `flash` models handle most everyday jobs quickly and cheaply; step up to stronger models and higher **thinking effort** when tackling long analysis or complex writing.

### Everyday recipes

- **Video script**: Text input (notes) → Text process ("Rewrite `@Notes` into a conversational 2-minute script") → Save (`.md`).
- **Image to copy**: Image input (product photo) → Text process ("Write 3 social captions based on this image") → Save.
- **Batch vs. Aggregate**: Feeding multiple files? Turn on **Batch mode** to process each item separately, or **Aggregate mode** when you want the model to see every item together in one pass.

## Image generation node

Describe a scene in words, or connect reference images to guide style and consistency.

- **Text to image**: Describe subject, framing, lighting, and style, then click **▶**.
- **Image editing & multi-reference**: Connect one or more Image input nodes and explain what to keep and what to change.
- **Multi-roll (1–10)**: Generate several variations in one run and pick your favorite.
- **Transparent background**: Enable transparent output when making stickers, icons, or clean product cutouts.
- **Free local generation**: Install **FLUX 3 Image Klein** or **Qwen Image 2.1** from **Plugins** to generate images locally on your own GPU with the same workflow.

## Saving results

- **Save node**: Connects after text, image, or Remotion nodes and writes `.md`, `.png`, `.mp4`, etc. directly to your chosen path.
- **Save PDF node**: Formats Markdown reports — headings, tables, lists, and math formulas — into a clean PDF document.
- **Built-in output paths**: Music, speech, and video generation nodes write directly to their own output path setting, so they don't need an extra Save node.

> **Tip**: For one-off casual questions, press `F2` to use the DeepSeek drawer instead. Put work on the canvas when you want to tweak, batch, or re-run it reliably.
