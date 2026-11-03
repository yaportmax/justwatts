"""A // comment that swallowed code (a sed join put code after a trailing comment on one line: three cases in A17/A19).
Fails on any app/js line whose // comment holds code-looking text: a dotted call closed by ');', an arrow '=>', '&&', '||',
'===', '!==', '++', or 'return x;' (prose in the comments uses none of these)."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "app" / "js"
CODE = re.compile(r"(\w\.\w+\([^()]*\)\s*;|\breturn\s+[\w.]+\s*;|\b(?:const|let)\s+\w+\s*=)")


def comment_of(line):
    # the text after a // that is not inside a string or a regex literal (rough: quotes and template literals counted)
    q = None
    for i, ch in enumerate(line):
        if q:
            if ch == "\\":
                continue
            if ch == q:
                q = None
        elif ch in "'\"`":
            q = ch
        elif line.startswith("//", i) and (i == 0 or line[i - 1] != ":"):
            return line[i + 2:]
    return None


def test_no_code_swallowed_by_a_comment():
    bad = []
    for f in ROOT.rglob("*.js"):
        if "vendor" in f.parts:
            continue
        for n, line in enumerate(f.read_text(encoding="utf8").splitlines(), 1):
            c = comment_of(line)
            if c and CODE.search(c):
                bad.append(f"{f.relative_to(ROOT)}:{n}: {line.strip()[:140]}")
    assert bad == [], "\n".join(bad)
