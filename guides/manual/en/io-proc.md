# Input / process / save

> In one sentence: the ① text and ② image generation groups — each with a node description and ways to use it — with their output landing on disk through a Save node.

![Input → process → save](img/mtnode-flow-01-ui.svg)

*Figure: input → process → save, then re-run the whole chain with one ▶ on a control node.*

## Text generation · node description

### What it is

Text processing is the most-used generation node on the canvas: it hands upstream text (a prompt, an article, table content) to a large model and outputs new text.

### The two modes

- **Ordinary mode (default)**: one request, one result — stable and cheap, and the result can go straight into a "Save text" node.
- **Agent mode**: treat the node as a small agent that can read files, write files and complete a task in several steps; because it reads and writes by itself, there is normally no need to hang a "Save" node after it.

### Key parameters

- **Prompt**: say clearly "what to do + what to output"; `@Node title` pulls in the content wired in upstream.
- Clicking the settings above switches the model, and the **thinking effort** button above changes the length of the model's chain of thought. A longer chain of thought generally means higher output quality but a larger token bill; in practice low or high is enough.
- **Provider / model**: a flash-class model is enough for most jobs; long-context reasoning and complex extraction deserve something stronger.

### Suggestions

- For general AI question answering or problem solving, go straight to the free DeepSeek web page: https://chat.deepseek.com . Simple text generation through the API is usually very cheap too — a few cents at most.
- The more specific the prompt, the steadier the result: give a role, a task, a format and a length limit rather than "write me something".

## Text generation · ways to use it

- **Use 1 · polish and rewrite**: wire a source text upstream → prompt "polish the text below into a spoken-word script, keep every fact: @source" → feed the output into "Save text".
- **Use 2 · translate**: prompt "translate @Chinese into English; output the translation only, no commentary", and store the result as `.txt` / `.yaml`.
- **Use 3 · structured extraction**: prompt "extract people, places and times from @body and output YAML" → the output can be parsed directly downstream.
- **Use 4 · template-constrained output**: put a JSON / YAML / Markdown template in the prompt and let the model fill it in, ready for programmatic use.
- **Use 5 · agent mode (click the whale icon to switch it on)**: switch it on when you need research, several files read, or a full document written; the product is normally a file.

Click the green triangle (play) button to run the node.

## Image generation · node description

### What it is

The image generation node both makes and edits images: text-to-image, image-to-image, masked inpainting and transparent-background output all happen on the same node.

### The single most important rule

Each run produces exactly 1 image. For 10 images prepare 10 input items (batch 1:1), place several image generation nodes, or raise **Attempts** for more rolls; never write "generate several images" in the prompt.

### Key parameters

- **Size**: pick from the sizes the canvas offers — portrait `848x1280` / character art, square `1280x1280`, landscape `1280x848` / cover, high definition `2048x1360`.
- **Quality**: default (not sent) / auto / low / medium / high / xhigh / max; use low for style drafts and high or above for finals.
- **Background**: default (not sent) / auto / opaque / transparent (a PNG with a real alpha channel straight out).
- **Provider**: it must be a provider of the "Image, OpenAI-compatible" type (GPT Image 2, for example); a text provider cannot produce images.

### Prompt structure

Subject + appearance detail + action and expression + environment + lighting + lens + art style + quality words.

## Image generation · ways to use it

- **Use 1 · text-to-image**: wire a prompt in upstream → wire the output into "Save image", which stores it as `.png` automatically.
- **Use 2 · image-to-image**: wire a reference image (an image input node, or a picture just generated upstream) into its image port and write "keep the subject and composition, replace the background with…" in the prompt.
- **Use 3 · masked inpainting**: turn on the "Mask" switch in the node header and paint the area to repaint by hand in the mask editor (transparent = repainted); it only affects the first reference image, and the size for that run follows the reference image.
- **Use 4 · transparent-background output**: for stickers / icons / sprites / cut-out character art: turn on the header button "Transparent background (two-pass difference matting)" (it first renders a black-background baseline and then differences out a PNG with an alpha channel, at roughly 2× the cost), or set Background to "transparent".
- **Use 5 · batch image production**: select several images at once in an image input node and switch on batch mode, switch on batch mode on the image generation node too and it runs item by item, 1 item = 1 image, wired into "Save image" to land the batch on disk.
- **Use 6 · iterating in rounds**: repeated image-to-image plus inpainting on the same picture, improving it step by step, is more controllable than one enormous prompt.
