# Inline completion (FIM)

With inline completion enabled, pausing briefly in any text box shows a subtle prediction of what you're about to write next. Press `Tab` to accept it and keep moving.

## Toggle & settings

Click the leftmost icon on the **bottom status bar** to open the completion settings panel, or press **`Ctrl + Tab`** anytime to turn it on or off.

Inside the panel, changes save immediately:

- **Master switch**: On by default. Turn it off and zero completion requests are sent.
- **Trigger modes**: Independently toggle **Auto-complete** (suggests after a brief pause) and **Manual Tab complete** (press `Tab` once to request a suggestion, press `Tab` again to accept).
- **Provider / Model**: Pick any available text model — fast, low-cost `flash` models are marked **Recommended**.
- **Trigger delay & max length**: Increase the delay if suggestions pop up too eagerly; raise max length for longer completions.
- **Usage report**: Click **Cost report** to see total requests, accepted completions, and token spend.

## How it works while you type

1. Type in any regular input box — session chat, node prompts, forms, research notes, or standalone desktop apps you build in MTNode.
2. Pause briefly (or press `Tab` if using manual trigger):
   - **Single-line suggestions** appear inline right after your cursor.
   - **Multi-line suggestions** appear in a solid, readable card just below the current line so they never obscure text underneath.
3. **Accept or dismiss**:
   - Press `Tab` to insert;
   - Press `Esc` to dismiss;
   - Keep typing or move the cursor to clear it automatically.

> **What about regular Tab indentation?** When no suggestion is showing, `Tab` indents or moves focus as usual. If a suggestion appears when you want to indent, tap `Esc` first and then `Tab`.

## Privacy & safety

- Only a short window of text **around your cursor** is sent to the provider you chose — never the rest of the document or other windows.
- **Password fields, read-only fields, and active IME composition** never trigger completions and send nothing.
- Turning off the master switch clears any active suggestion immediately and stops all requests.
