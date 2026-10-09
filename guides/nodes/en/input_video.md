# Video input (pick a file · outputs a URL)

![diagram](img/input_video.svg)

Hold a local video file as **material**: click “Pick video”, or drop an mp4 / webm / mov / mkv / avi file onto the node.

## Ports
- **In**: 1 by default (the port exists and can be wired, but the content is the file you picked here — an upstream connection has no effect)
- **Out**: **fixed** 2 data ports
  - **Port 1 · Video output** — the file's `file:///…` URL (CJK and spaces percent-encoded)
  - **Port 2 · Transcript output** — the text this node transcribed (the video's audio track, local SenseVoice); **empty text while nothing has been transcribed**

## Using it
- Wire **port 1 (Video output)** into a **Minimax H3** reference-video slot: the receiver turns the URL back into a local absolute path before handing it to the backend
- Wire **port 1** into a **Save** node: written out as video (copied to your path)
- Wire **port 2 (Transcript output)** into a text / agent / save port: you get the text of this video's audio track (click “Transcribe” on this node first, or let the downstream run transcribe it)
- `@` reference: the text injected into a prompt is that URL (the transcript is used instead once one exists)

## Notes
- Stores the file's **original absolute path** only (nothing is copied into the workflow assets, video can be large). Move the file away and you need to pick it again.
- Playback uses the built-in player; an unsupported codec shows a hint instead.
- To **generate** video: live-action style via “Video gen › Minimax H3”, motion graphics via “Video gen › Remotion video”.
