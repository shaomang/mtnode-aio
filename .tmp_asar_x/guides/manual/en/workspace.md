# Workspace & archives

## Working directory

The toolbar can set a folder for this canvas. Agent nodes and **relative save paths** use it; change it to redirect writes. Leave empty for per-node paths or the app default data directory.

Invalid paths are cleared with a warning so the assistant does not write to the wrong place.

## Super node subfolder

A super can set a **subfolder** (relative to the workspace). Relative paths of nodes inside resolve under `workspace / subfolder / …` (nested supers concatenate ancestor subfolders). Packing in or changing the subfolder prefixes existing relative paths; absolute paths stay. See [Super nodes](#super-nodes).

## Archive folder

Workflow JSON lives under `save/` in the app data directory (Windows: often `%APPDATA%\pipeline-console\...`). Settings → **Open archive folder**.

**Workflows are not uploaded by default.** Prompts go to your provider only when you run a node. Workshop upload is an explicit template you choose.
