"""Ride event lines: formatting (mirrors app/js/core.js) and parsing into dicts.

The log file stores one event per line: ``[HH:MM:SS] <line>``. See docs/PROTOCOL.md.
"""
from __future__ import annotations

import math
import re
from typing import Any


def js_round(x: float) -> int:
    """Math.round semantics (half up), unlike Python's banker's rounding."""
    return int(math.floor(x + 0.5))


def fmt_t(s: float) -> str:
    s = max(0, js_round(s))
    h, m, x = s // 3600, s % 3600 // 60, s % 60
    return f"{h}:{m:02d}:{x:02d}" if h else f"{m}:{x:02d}"


def parse_t(t: str) -> int:
    parts = [int(p) for p in t.split(":")]
    out = 0
    for p in parts:
        out = out * 60 + p
    return out


def _mean(a):
    return sum(a) / len(a) if a else 0


# ---------- formatting (same strings as the page) ----------

def line_ride_start(name: str, ftp: int, n_steps: int | None, total_s: int | None) -> str:
    tail = f"{n_steps} steps, {fmt_t(total_s)}" if n_steps else "free"
    return f"RIDE START {name} | FTP {ftp} | {tail}"


def line_ride_end(el: float) -> str:
    return f"RIDE END {fmt_t(el)}"


def line_step_start(i: int, n: int, d: int, tgt: int | None) -> str:
    return f"START step {i + 1}/{n} {fmt_t(d)} @{'free' if tgt is None else tgt}W"


def line_step_end(i: int, p: list, h: list, c: list, tg: list) -> str:
    def dash(v):
        return v if v else "-"
    return (f"END step {i + 1}: avg {js_round(_mean(p))}W (tgt {js_round(_mean(tg))}) | "
            f"HR avg {dash(js_round(_mean(h)))} max {dash(max([0, *h]))} end {dash(h[-1] if h else 0)} | "
            f"cad {js_round(_mean(c))}")


# ---------- parsing ----------

T = r"(\d+(?::\d\d){1,2})"
NUM = r"(-?\d+|-)"
_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("step_start", re.compile(rf"^START step (\d+)/(\d+) {T} @(\d+|free)W$")),
    ("step_end", re.compile(
        rf"^END step (\d+): avg (\d+)W \(tgt (\d+)\) \| HR avg {NUM} max {NUM} end {NUM} \| cad (\d+)$")),
    ("ride_start", re.compile(rf"^RIDE START (.*) \| FTP (\d+) \| (?:(\d+) steps, {T}|free)$")),
    ("ride_resumed", re.compile(rf"^RIDE RESUMED after (reload|restart) at T\+{T} \((\d+) samples kept\)$")),
    ("ride_end", re.compile(rf"^RIDE END {T}$")),
    ("paused", re.compile(r"^PAUSED(?: \((stopped pedaling)\))?$")),
    ("resumed", re.compile(r"^RESUMED$")),
    ("edit", re.compile(rf"^EDIT (insert|replace|delete|end|duration|rest) (.*) \| (\d+) steps, {T}$")),
    ("manual", re.compile(r"^MANUAL (\w+)(?: (.*))?$")),
    ("workout_done", re.compile(rf"^WORKOUT DONE at T\+{T}, riding free until End$")),
    ("course_done", re.compile(rf"^COURSE DONE at T\+{T}, riding on until End$")),
]
_LOG_RE = re.compile(r"^\[(\d\d:\d\d:\d\d)\] ?(.*)$")


def _int(v):
    if v in (None, "-", "?", "free"):
        return None
    return int(v)


def parse_line(line: str) -> dict[str, Any]:
    """Parse one log line (with or without the ``[HH:MM:SS]`` prefix)."""
    raw = line.rstrip("\r\n")
    ev: dict[str, Any] = {"time": None, "type": "other", "raw": raw}
    m = _LOG_RE.match(raw)
    body = raw
    if m:
        ev["time"], body = m[1], m[2]
    ev["text"] = body
    for typ, rx in _PATTERNS:
        g = rx.match(body)
        if not g:
            continue
        ev["type"] = typ
        if typ == "step_start":
            ev.update(step=int(g[1]), steps=int(g[2]), duration_s=parse_t(g[3]), target_w=_int(g[4]))
        elif typ == "step_end":
            ev.update(step=int(g[1]), avg_w=int(g[2]), target_w=int(g[3]), hr_avg=_int(g[4]),
                      hr_max=_int(g[5]), hr_end=_int(g[6]), cadence=int(g[7]))
        elif typ == "ride_start":
            ev.update(name=g[1], ftp=int(g[2]), steps=_int(g[3]), total_s=parse_t(g[4]) if g[4] else None)
        elif typ == "ride_resumed":
            ev.update(after=g[1], elapsed_s=parse_t(g[2]), samples=int(g[3]))
        elif typ == "ride_end":
            ev.update(elapsed_s=parse_t(g[1]))
        elif typ == "paused":
            ev.update(auto=bool(g[1]))
        elif typ == "edit":
            ev.update(op=g[1], detail=f"{g[1]} {g[2]}", steps=int(g[3]), total_s=parse_t(g[4]))
        elif typ == "manual":
            ev.update(action=g[1], detail=g[2] or "")
        elif typ in ("workout_done", "course_done"):
            ev.update(elapsed_s=parse_t(g[1]))
        break
    return ev


def tail_lines(path, n: int) -> list[str]:
    """Last n lines of a text file (reads from the end, fine for large logs)."""
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            block, data = 8192, b""
            while size > 0 and data.count(b"\n") <= n:
                step = min(block, size)
                size -= step
                f.seek(size)
                data = f.read(step) + data
    except OSError:
        return []
    lines = data.decode("utf-8", "replace").splitlines()
    return lines[-n:] if n > 0 else []
