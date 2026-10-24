"""Coach event lines: formatting (mirrors app/js/core.js) and parsing into dicts.

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


def line_tick(el, i, n, into, d, tgt, l30, step_p) -> str:
    """l30: last 30 samples [ts, el, w, cad, hr, speed, tgt]."""
    h = [s[4] for s in l30 if s[4]]
    if h:
        dlt = h[-1] - h[0]
        hd = f"{'+' if dlt >= 0 else ''}{dlt}"
    else:
        hd = "?"
    return (f"T+{fmt_t(el)} step {i + 1}/{n} {fmt_t(into)} in, {fmt_t(d - into)} left | "
            f"tgt {'free' if tgt is None else tgt} | 30s {js_round(_mean([s[2] for s in l30]))}W | "
            f"step avg {js_round(_mean(step_p))}W | HR {h[-1] if h else '-'} ({hd}/30s) | "
            f"cad {js_round(_mean([s[3] for s in l30]))}")


def line_feel(feel: str, step_no: int | None, l30, hr) -> str:
    return (f"FEEL {feel.upper()} | step {'-' if step_no is None else step_no} | "
            f"30s {js_round(_mean([s[2] for s in l30]))}W | HR {hr or '-'}")


def line_coach(cmd: dict) -> str:
    parts = [f"COACH {cmd['seq']}"]
    if "set" in cmd:
        parts.append(f"set {cmd['set']['step']} {cmd['set']['w']}W")
    if "edit" in cmd:
        e = cmd["edit"]
        parts.append("edit " + " ".join(f"{k}={v}" for k, v in e.items()))
    if "msg" in cmd:
        parts.append(f"msg {cmd['msg']}")
    return " | ".join(parts)


# ---------- parsing ----------

T = r"(\d+(?::\d\d){1,2})"
NUM = r"(-?\d+|-)"
_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("tick", re.compile(
        rf"^T\+{T} step (\d+)/(\d+) {T} in, {T} left \| tgt (\d+|free) \| 30s (\d+)W \| "
        rf"step avg (\d+)W \| HR (\d+|-) \(([+-]?\d+|\?)/30s\) \| cad (\d+)$")),
    ("step_start", re.compile(rf"^START step (\d+)/(\d+) {T} @(\d+|free)W$")),
    ("step_end", re.compile(
        rf"^END step (\d+): avg (\d+)W \(tgt (\d+)\) \| HR avg {NUM} max {NUM} end {NUM} \| cad (\d+)$")),
    ("feel", re.compile(r"^FEEL (EASIER|GOOD|HARDER|[A-Z]+) \| step (\d+|-) \| 30s (\d+)W \| HR (\d+|-)$")),
    ("ride_start", re.compile(rf"^RIDE START (.*) \| FTP (\d+) \| (?:(\d+) steps, {T}|free)$")),
    ("ride_resumed", re.compile(rf"^RIDE RESUMED after (reload|restart) at T\+{T} \((\d+) samples kept\)$")),
    ("ride_end", re.compile(rf"^RIDE END {T}$")),
    ("paused", re.compile(r"^PAUSED(?: \((stopped pedaling)\))?$")),
    ("resumed", re.compile(r"^RESUMED$")),
    ("coach", re.compile(r"^COACH (\d+)((?: \| .*)?)$")),
    ("edit", re.compile(rf"^EDIT (insert|replace|delete|end|duration|rest) (.*) \| (\d+) steps, {T}$")),
    ("manual", re.compile(r"^MANUAL (\w+)(?: (.*))?$")),
    ("workout_done", re.compile(rf"^WORKOUT DONE at T\+{T}, riding free until End$")),
    ("said", re.compile(r'^SAID(?: \((\w+)\))?: "(.*)"$')),
    ("voice", re.compile(r"^VOICE (ON|OFF|MUTED|UNMUTED)(?: \((\w+)\))?$")),
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
        if typ == "tick":
            ev.update(elapsed_s=parse_t(g[1]), step=int(g[2]), steps=int(g[3]), into_s=parse_t(g[4]),
                      left_s=parse_t(g[5]), target_w=_int(g[6]), power_30s=int(g[7]), step_avg_w=int(g[8]),
                      hr=_int(g[9]), hr_delta_30s=_int(g[10]), cadence_30s=int(g[11]))
        elif typ == "step_start":
            ev.update(step=int(g[1]), steps=int(g[2]), duration_s=parse_t(g[3]), target_w=_int(g[4]))
        elif typ == "step_end":
            ev.update(step=int(g[1]), avg_w=int(g[2]), target_w=int(g[3]), hr_avg=_int(g[4]),
                      hr_max=_int(g[5]), hr_end=_int(g[6]), cadence=int(g[7]))
        elif typ == "feel":
            ev.update(feel=g[1].lower(), step=_int(g[2]), power_30s=int(g[3]), hr=_int(g[4]))
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
        elif typ == "workout_done":
            ev.update(elapsed_s=parse_t(g[1]))
        elif typ == "said":
            ev.update(source=g[1] or "browser", said=g[2])
        elif typ == "voice":
            ev.update(on=g[1] in ("ON", "UNMUTED"), state=g[1].lower(), source=g[2])
        elif typ == "coach":
            ev["seq"] = int(g[1])
            rest = g[2]
            if " | msg " in rest:  # msg is always last and may itself contain " | "
                rest, ev["msg"] = rest.split(" | msg ", 1)
            sm = re.search(r" \| set (cur|\d+) (\d+)W", rest)
            if sm:
                ev["set"] = {"step": sm[1] if sm[1] == "cur" else int(sm[1]), "w": int(sm[2])}
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
