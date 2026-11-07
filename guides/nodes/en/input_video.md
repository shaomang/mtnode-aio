# Video input

![diagram](img/input_video.svg)

Hold a local video file as material: click **Choose video**, or drop the file onto the node.

## Ports
- **In**: 1 data port + one control port at the end; when wired, the content becomes the upstream video (read-only — unwire to get your own file back)
- **Out**: fixed 2 data ports
  - **Video output** — the file's `file:///…` URL (CJK and spaces percent-encoded)
  - **Transcript output** — the text produced by **Transcribe** on this node (from the video's audio track); empty text before anything is transcribed

## Settings
- No ⚙ settings window: picking the file and transcribing live in the node's action row.

## Usage
- Click **Choose video** (mp4 / webm / mov / mkv / avi …), or drop the file onto the node.
- Click **Transcribe** to get text with the local SenseVoice model; edit the result or transcribe again.
- Wire **Video output** into a Minimax H3 reference-video slot, or into a **Save** node; an `@` reference also injects this URL (the transcript once one exists).

## Notes
- Only the original absolute path is stored — nothing is copied into workflow assets. Move the file and you must pick it again.
- Playback uses the built-in player; an unsupported codec shows a hint instead.
- To generate video: live-action style via "Video gen › Minimax H3", motion graphics via "Video gen › Remotion video".
