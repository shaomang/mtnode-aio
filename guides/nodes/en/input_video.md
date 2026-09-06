# Video input (pick a file · outputs a URL)

![diagram](img/input_video.svg)

Hold a local video file as **material**: click “Pick video”, or drop an mp4 / webm / mov / mkv / avi file onto the node.

## Ports
- **In**: 1 by default (the port exists and can be wired, but the content is the file you picked here — an upstream connection has no effect)
- **Out**: 1 data port — its value is the file's `file:///…` URL (CJK and spaces percent-encoded)

## Using it
- Wire it into a **Minimax H3** reference-video slot: the receiver turns the URL back into a local absolute path before handing it to the backend
- Wire it into a **Save** node: written out as video (copied to your path)
- `@` reference: the text injected into a prompt is that URL

## Notes
- Stores the file's **original absolute path** only (nothing is copied into the workflow assets, video can be large). Move the file away and you need to pick it again.
- Playback uses the built-in player; an unsupported codec shows a hint instead.
- To **generate** video: live-action style via “Video gen › Minimax H3”, motion graphics via “Video gen › Remotion video”.
