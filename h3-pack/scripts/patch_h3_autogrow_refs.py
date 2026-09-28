"""Idempotently patch ComfyUI's MiniMaxH3ReferenceToVideo to fold flat ref keys.

Newer ComfyUI ships the node with io.Autogrow inputs (ref_images / ref_videos /
ref_video_audios / ref_audios). The MTNode plugin (and the renderer's video_gen
wrapper) still POST flat keys like ref_image_0, ref_video_0, ref_audio_0,
ref_video_audio_0. Those bypass the nesting and raise

    TypeError: MiniMaxH3ReferenceToVideo.execute() got an unexpected
               keyword argument 'ref_image_0'

which the plugin surfaces as comfy_execution_error. This script appends a
**legacy_refs catch-all that folds the flat keys back into the nested dicts.

Safe to run repeatedly: it exits 0 if the patch is already present or the file
/ class is absent.
"""

import io
import os
import re
import sys


def comfy_extras_path():
    cwd = os.getcwd()
    for base in (cwd, os.path.dirname(cwd)):
        cand = os.path.join(base, "ComfyUI", "comfy_extras", "nodes_minimax_h3.py")
        if os.path.isfile(cand):
            return cand
    return None


def main():
    path = comfy_extras_path()
    if not path:
        sys.exit(0)

    with open(path, "r", encoding="utf-8") as f:
        src = f.read()

    if "**legacy_refs" in src and "def fold_flat" in src:
        return  # already patched

    old = (
        '                ref_images=None, ref_videos=None, ref_video_audios=None, ref_audios=None) -> io.NodeOutput:'
    )
    new = (
        '                ref_images=None, ref_videos=None, ref_video_audios=None, ref_audios=None,\n'
        '                **legacy_refs) -> io.NodeOutput:\n'
        '        def fold_flat(prefix, base):\n'
        '            folded = dict(base or {})\n'
        '            for name in [k for k in legacy_refs if k.startswith(prefix)]:\n'
        '                folded[name] = legacy_refs.pop(name)\n'
        '            return folded\n'
        '        ref_video_audios = fold_flat("ref_video_audio_", ref_video_audios)\n'
        '        ref_videos = fold_flat("ref_video_", ref_videos)\n'
        '        ref_images = fold_flat("ref_image_", ref_images)\n'
        '        ref_audios = fold_flat("ref_audio_", ref_audios)'
    )

    if old not in src:
        return  # class not found / already different shape; leave untouched

    src = src.replace(old, new)
    with open(path, "w", encoding="utf-8") as f:
        f.write(src)

    try:
        import py_compile
        py_compile.compile(path, doraise=True)
    except Exception as e:  # pragma: no cover - defensive
        sys.exit("patch produced invalid python: %s" % e)

    return 0


if __name__ == "__main__":
    sys.exit(main())
