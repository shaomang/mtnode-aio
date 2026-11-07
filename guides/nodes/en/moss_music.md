# MOSS-Music music understanding (local · audio / video → analysis)

Right-click the canvas → **Process Node › Audio generation › MOSS-Music music understanding** (node kind `moss_music`). A resident local backend (default port 8790) runs OpenMOSS's 8B music-understanding Instruct model: feed it audio or a video with a soundtrack and it returns a **written analysis**. It only understands, it never generates audio — for “lyrics → full song” use `yue_gen` / `music_gen`.

## Ports
- **In**: port 0 = audio / video (required; the audio track is extracted from video) · port 1 = free-form question (text; empty = task preset) · port 2 = control input
- **Out**: port 0 = result text · port 1 = JSON (model / quantization / duration / segments / cues / artifact paths) · port 2 = absolute path of the md artifact

## Settings
- Change them in the **⚙ Settings** window opened from the node header.
- **Task preset**: Full analysis (default) / Whole-track description / Timestamped lyrics / Form & chords / Mood tags; a free-form question (on port 1 or typed on the node) **overrides** the preset
- **Quantization**: `int8` (≥16GB, default) / `int4` (≥12GB)
- **Long audio (auto-chunking; turn on for 30+ minutes)**: off by default; splits at silences, analyses each chunk and merges — slower but never truncated
- **Output cap per segment**: 2048 / 4096 (default) / 8192 tokens; hitting the cap re-splits that stretch in half and merges it
- There is no output-path setting: artifacts always land in the app-managed canvas asset folder (md / json / srt with the same stem); take the path from port 2 to archive them

## Notes
- With nothing on port 0, ▶ stops immediately with “no audio / video path” and never starts the backend.
- The backend is a resident singleton and does not stop when MTNode exits; the node's ■ makes it stop at a chunk boundary and **unload the model too**, freeing VRAM at once — the next ▶ reloads it.
- Only **1 audio/video task** runs globally at a time (same media lock as the music / speech / video nodes); one analysis times out after 45 minutes.
- Until it is installed the node shows a “plugin not installed” bar: in the **Plugins › MOSS-Music local music understanding** card pick the install folder and press **Install (domestic mirror)**; allow ≥60GB. On failure use **Hand to an mtnode session**, which follows the `moss-music-install` skill.
