"""Minimal gradio stub for headless GPT-SoVITS training.

The official engine imports `gradio` unconditionally at module top level of
tools/my_utils.py (plus other webui helpers), but the training / prep scripts
never use the WebUI — they only need clean_path / load_audio.

Installing real gradio would drag fastapi/starlette/httpx into .pylibs and
risk conflicting with the management service's own stack (the server process
also has .pylibs on sys.path for the python-multipart self-heal). So instead
we inject this stub on the training subprocess PYTHONPATH only
(tts-pack/shims -> ROOT/shims, listed BEFORE .pylibs).

`gr.Warning/Info/Error` print to stderr; every other gr.<attr> resolves to a
no-op callable stub (webui scripts never run in the training chain).
"""
from __future__ import annotations

import sys

__version__ = "0.0.0-stub"


class _Stub:
    """Generic no-op stand-in: callable, context-manager, attribute holder."""

    def __init__(self, *args, **kwargs):
        pass

    def __call__(self, *args, **kwargs):
        return self

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def __getattr__(self, name):
        return _Stub()

    def __getitem__(self, key):
        return self

    def __iter__(self):
        return iter(())

    def __bool__(self):
        return False


def _warn(*args, **kwargs):
    print("[gradio-stub] Warning:", *args, file=sys.stderr)
    return None


def _noop(*args, **kwargs):
    return None


# commonly used directly by engine helper modules
Warning = _warn
Info = _noop
Error = _noop
Markdown = _noop
HTML = _noop
Blocks = _Stub
Row = _Stub
Column = _Stub
Group = _Stub
Accordion = _Stub
Tab = _Stub
Tabs = _Stub
Button = _Stub
Textbox = _Stub
Audio = _Stub
File = _Stub
Dropdown = _Stub
Slider = _Stub
Radio = _Stub
Checkbox = _Stub
Number = _Stub
Dataframe = _Stub
Image = _Stub
Video = _Stub
Label = _Stub
Progress = _Stub


def __getattr__(name):
    # any other gr.<attr> referenced by imported-but-never-run code paths
    return _Stub()


__all__ = ["Warning", "Info", "Error", "Blocks"]
