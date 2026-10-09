# Audio input (pick a file · outputs a URL)

![diagram](img/input_audio.svg)

Hold a local audio file as **material**: click “Pick audio”, or drop an mp3 / wav / ogg / flac / m4a / aac file onto the node.

## Ports
- **In**: 1 by default (the port exists and can be wired, but the content is the file you picked here — an upstream connection has no effect)
- **Out**: **fixed** 2 data ports
  - **Port 1 · Audio output** — the file's `file:///…` URL (CJK and spaces percent-encoded)
  - **Port 2 · Transcript output** — the text this node transcribed (local SenseVoice, see below); **empty text while nothing has been transcribed** (not a broken wire, and not that URL)

## Using it
- Wire **port 1 (Audio output)** into a **Minimax H3** reference-audio slot: the receiver turns the URL back into a local absolute path before handing it to the backend
- Wire **port 1** into a **Save** node: written out as audio (copied to your path)
- Wire **port 2 (Transcript output)** into a text / agent / save port: you get this audio's **text** (click “Transcribe” on this node first, or let the downstream run transcribe it)
- `@` reference: the text injected into a prompt is that URL (the transcript is used instead once one exists)

## Notes
- Stores the file's **original absolute path** only (nothing is copied into the workflow assets, audio can be large). Move the file away and you need to pick it again.
- Dropping the wrong media type is refused with a hint.
- To **generate** audio: speech via “Audio gen › SoVITS speech”, music via “Audio gen › Minimax Music 3”.
