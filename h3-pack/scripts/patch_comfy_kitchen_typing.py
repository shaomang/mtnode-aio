"""Patch comfy_kitchen annotations for torch.library.infer_schema.

Torch 2.6 (and some older builds) accept typing.List[int] but reject PEP585
list[int] / PEP604 float | None in custom_op schemas. Re-run after every
comfy-kitchen upgrade.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path


def patch_tree(root: Path) -> int:
    n_files = 0
    for p in root.rglob("*.py"):
        text = p.read_text(encoding="utf-8")
        orig = text
        text = re.sub(r"\blist\[int\]", "typing.List[int]", text)
        text = re.sub(r"\blist\[bool\]", "typing.List[bool]", text)
        text = re.sub(r"\blist\[float\]", "typing.List[float]", text)
        text = re.sub(r"\blist\[str\]", "typing.List[str]", text)
        text = re.sub(r"\bdict\[([^\]]+)\]", r"typing.Dict[\1]", text)
        text = re.sub(r"\btuple\[([^\]]+)\]", r"typing.Tuple[\1]", text)
        text = re.sub(r"\bfloat\s*\|\s*None\b", "typing.Optional[float]", text)
        text = re.sub(r"\bint\s*\|\s*None\b", "typing.Optional[int]", text)
        text = re.sub(r"\bbool\s*\|\s*None\b", "typing.Optional[bool]", text)
        text = re.sub(r"\bstr\s*\|\s*None\b", "typing.Optional[str]", text)
        if text == orig:
            continue
        if "import typing" not in text and "typing." in text:
            lines = text.splitlines(True)
            insert_at = 0
            for i, line in enumerate(lines):
                if line.startswith("from __future__") or line.startswith("import ") or line.startswith("from "):
                    insert_at = i + 1
                elif line.strip() == "" or line.startswith("#"):
                    if insert_at == 0:
                        continue
                    break
                elif insert_at:
                    break
            lines.insert(insert_at, "import typing\n")
            text = "".join(lines)
        p.write_text(text, encoding="utf-8")
        n_files += 1
        print("patched", p)
    return n_files


def main() -> int:
    if len(sys.argv) > 1:
        root = Path(sys.argv[1])
    else:
        import comfy_kitchen  # type: ignore

        root = Path(comfy_kitchen.__file__).resolve().parent
    if not root.is_dir():
        print("missing", root, file=sys.stderr)
        return 2
    n = patch_tree(root)
    print("patch_comfy_kitchen_typing files=", n)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
