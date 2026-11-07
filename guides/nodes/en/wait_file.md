# Wait for file

![diagram](img/wait_file.svg)

Watch a file path: block downstream until the file exists, then release. It does not emit the file contents — downstream reads the agreed path itself.

## Ports
- **In**: none
- **Out**: control (wire it downstream so they do not start early)

## Settings
- In the settings window opened by **⚙ Settings** in the node header; **Watched path (the file to wait for)**: absolute, or relative once a working directory is set
- **Poll interval (sec)**: how often to check, 1–60, default 2
- Browse / Location are action buttons on the node, not settings

## Usage
- Use Browse to pick an existing file, or type the not-yet-created path in the settings window
- Location shows the watched path in its folder (it may fail while the file does not exist)
