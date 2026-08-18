# First run

![Four steps](img/first-run.svg)

1. **Configure a provider**  
   Open **Settings · API/Config**, pick a text provider (e.g. DeepSeek Official), enter an **API Key**. Keys stay on this machine. Add an image provider for generation.
2. **Add nodes**  
   **Right-click empty canvas** → Text Node or Text Processing Node. Click the title to rename.
3. **Wire**  
   Drag from an output port (right) to an input port (left). Type `@` in a prompt to reference connected nodes.
4. **Run**  
   Click **▶** on a process node. Unprocessed upstream nodes run automatically first.

> Agent mode (files / web / shell) is in [What agent mode is](#dsh). Optional components: top-right **Plugins**.
