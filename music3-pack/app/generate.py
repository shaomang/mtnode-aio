"""CLI entry: generate a song and write WAV to --output-dir."""

from __future__ import annotations

import argparse
from pathlib import Path

from app.pipeline import DEFAULT_OUTPUT_DIR, Music3Generator, resolve_model_path


def read_text(value: str | None, file_path: str | None, name: str) -> str:
    if file_path:
        return Path(file_path).expanduser().resolve().read_text(encoding="utf-8")
    if value is not None and value.strip():
        return value
    raise SystemExit(f"Missing {name}: pass --{name} or --{name}-file")


def main() -> None:
    parser = argparse.ArgumentParser(description="MiniMax Music 3 local generator (24G)")
    parser.add_argument("--prompt", default=None, help="Music description / Structured Caption")
    parser.add_argument("--prompt-file", default=None, help="Path to caption text file")
    parser.add_argument("--lyrics", default=None, help="Lyrics with section tags")
    parser.add_argument("--lyrics-file", default=None, help="Path to lyrics text file")
    parser.add_argument("--audio-duration", type=float, default=60.0, help="Target duration seconds (max 150)")
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument(
        "--output-dir",
        default=str(DEFAULT_OUTPUT_DIR),
        help="Folder for WAV output (created if missing)",
    )
    parser.add_argument("--filename", default=None, help="Optional output filename (.wav)")
    parser.add_argument("--model-path", default=None, help="Local model dir or HF repo id")
    parser.add_argument(
        "--no-offload",
        action="store_true",
        help="Keep full model on GPU (may OOM on 24G; default uses auto CPU offload)",
    )
    args = parser.parse_args()

    prompt = read_text(args.prompt, args.prompt_file, "prompt")
    lyrics = read_text(args.lyrics, args.lyrics_file, "lyrics")
    model_path = resolve_model_path(args.model_path)

    gen = Music3Generator(model_path=model_path, offload=not args.no_offload)
    result = gen.generate(
        prompt=prompt,
        lyrics=lyrics,
        audio_duration=args.audio_duration,
        seed=args.seed,
        output_dir=args.output_dir,
        filename=args.filename,
    )
    print(f"saved={result['path']}")
    print(f"duration_sec={result['duration_sec']:.2f}")
    print(f"sampling_rate={result['sampling_rate']}")
    print(f"seed={result['seed']}")
    print(f"model_path={result['model_path']}")


if __name__ == "__main__":
    main()
