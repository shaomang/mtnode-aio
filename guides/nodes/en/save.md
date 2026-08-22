# Save

![diagram](img/save.svg)

One save node infers type from its input (legacy save_text / save_image upgrade on load):

- **text** → `.yaml`
- **image** → `.png`
- **audio** (music gen) → `.wav`
- **video** (video gen) → `.mp4`

Paths are relative to the workspace or absolute. Inside a **super** with a subfolder, relative paths resolve under that subfolder (see [Super nodes](#super-nodes)). Auto-save is optional. Previews differ by media (text / thumbnail / audio / video).

Placing music or video gen also creates a bound save node on the right (fixed offset, pinned wire). The gen node writes its filename into that save node.

## Ports
- **In**: text / image / audio / video
- **Out**: none
