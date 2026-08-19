# Save

![diagram](img/save.svg)

One save node infers type from its input (legacy save_text / save_image upgrade on load):

- **text** → `.yaml`
- **image** → `.png`
- **audio** (music gen) → `.wav`
- **video** (video gen) → `.mp4`

Placing music or video gen also creates a bound save node on the right (fixed offset, pinned wire). The gen node writes its filename into that save node.

## Ports
- **In**: text / image / audio / video
- **Out**: none
