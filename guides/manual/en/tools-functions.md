# Tool & function nodes

When you find yourself rebuilding the same mini-flow across canvases — or needing exact math, text splitting, or JSON formatting — use **Tool nodes** and **Function nodes**.

![Packaging reusable steps into tools](img/mtnode-canvas-02-ui.svg)

## Tool nodes: turn a sub-flow into a reusable block

1. **Parameters become ports**: Add an input parameter in the Tool node's parameter table and a new input port appears on the left; add an output parameter and an output port appears on the right. Type labels (`text`, `image`, etc.) prevent mismatched wiring.
2. **Register to the Tool library**: Once saved, your tool appears in **Tool library (`K`)** on the top bar.
3. **Reuse everywhere**: Drag it onto any canvas like a built-in node, and let Agent sessions call it automatically as a tool.

## Function nodes: quick JS for exact logic

AI models shine at writing and reasoning, while small scripts shine at exact math, formatting, filtering, and zero-cost transforms.

- **How it works**: Drop a **Function node**, declare its inputs/outputs, and write a short JavaScript snippet that reads `input` and `return`s the result.
- **Don't code? Ask the assistant**: Tell the Global assistant "Create a Function node that splits text by blank lines and removes empty rows" and it will write and wire it for you.
- **Safe execution**: Function code runs in an isolated background worker so a typo or infinite loop never freezes MTNode.
