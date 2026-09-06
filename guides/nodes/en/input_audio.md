# Audio input (pick a file · outputs a URL)

![diagram](img/input_audio.svg)

Hold a local audio file as **material**: click “Pick audio”, or drop an mp3 / wav / ogg / flac / m4a / aac file onto the node.

## Ports
- **In**: 1 by default (the port exists and can be wired, but the content is the file you picked here — an upstream connection has no effect)
- **Out**: 1 data port — its value is the file's `file:///…` URL (CJK and spaces percent-encoded)

## Using it
- Wire it into a **Minimax H3** reference-audio slot: the receiver turns the URL back into a local absolute path before handing it to the backend
- Wire it into a **Save** node: written out as audio (copied to your path)
- `@` reference: the text injected into a prompt is that URL

## Notes
- Stores the file's **original absolute path** only (nothing is copied into the workflow assets, audio can be large). Move the file away and you need to pick it again.
- Dropping the wrong media type is refused with a hint.
- To **generate** audio: speech via “Audio gen › SoVITS speech”, music via “Audio gen › Minimax Music 3”.
