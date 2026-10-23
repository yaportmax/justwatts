"""Python port of the workout text DSL in app/js/core.js (used by the headless simulator).

Grammar (case-insensitive, items separated by commas/semicolons/whitespace):
  10m 50%        steady, percent of FTP
  5m 50-90%      ramp
  1m 300w        absolute watts
  10m free       free ride (no ERG target)
  5x(3m 115%, 3m 50%)   repeats, nestable
Durations: 1h, 10m, 10min, 30s, 30sec, combinable (1m30s).

tests/test_workout_parity.py checks this against the JS implementation.
"""
from __future__ import annotations

import re
from decimal import ROUND_HALF_UP, Decimal

from .events import js_round

_DUR = r"((?:\d+(?:\.\d+)?\s*(?:h|min|m|sec|s)(?![a-z])\s*)+)"  # 1m30s is one duration
_RE_REP = re.compile(r"^(\d+)\s*x\s*\(")
_RE_FREE = re.compile("^" + _DUR + r"\s*@?\s*free")
_RE_STEP = re.compile("^" + _DUR + r"\s*@?\s*(\d+(?:\.\d+)?)\s*(?:-\s*(\d+(?:\.\d+)?))?\s*(%|w)?")
_RE_DUR = re.compile(r"(\d+(?:\.\d+)?)\s*(h|min|m|sec|s)")


class WorkoutError(ValueError):
    pass


def parse_dur(text: str) -> int:
    t = 0.0
    for num, unit in _RE_DUR.findall(text):
        t += float(num) * (3600 if unit == "h" else 60 if unit[0] == "m" else 1)
    return js_round(t)


def parse_workout(src: str) -> list[dict]:
    s = src.lower()
    pos = 0

    def ws():
        nonlocal pos
        while pos < len(s) and s[pos] in " \t\r\n\f\v,;":
            pos += 1

    def lst(end):
        out = []
        while True:
            ws()
            if pos >= len(s) or s[pos] == end or s[pos] == ")":
                break
            out.extend(item())
        return out

    def item():
        nonlocal pos
        rest = s[pos:]
        m = _RE_REP.match(rest)
        if m:
            pos += len(m[0])
            inner = lst(")")
            if pos >= len(s) or s[pos] != ")":
                raise WorkoutError("Missing )")
            pos += 1
            return [dict(x) for _ in range(int(m[1])) for x in inner]
        m = _RE_FREE.match(rest)
        if m:
            pos += len(m[0])
            return [{"d": parse_dur(m[1]), "free": True}]
        m = _RE_STEP.match(rest)
        if m:
            pos += len(m[0])
            u = m[4] or "%"
            a = float(m[2])
            b = float(m[3]) if m[3] is not None else a
            if u == "%":
                a /= 100
                b /= 100
            d = parse_dur(m[1])
            if not d:
                raise WorkoutError(f'Zero duration near "{rest[:14]}"')
            return [{"d": d, "a": a, "b": b, "u": u}]
        raise WorkoutError(f"Can't read \"{rest[:16].strip()}\"")

    steps = lst(None)
    if pos < len(s):
        raise WorkoutError("Unexpected )")
    if not steps:
        raise WorkoutError("Empty workout")
    return steps


def _fixed1(x: float) -> str:
    v = Decimal(x).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)
    out = format(v, "f")
    return out[:-2] if out.endswith(".0") else out


def _fmt_dur_short(d: int) -> str:
    m, s = d // 60, d % 60
    return f"{m}m{s}s" if m and s else f"{m}m" if m else f"{s}s"


def step_text(s: dict) -> str:
    if s.get("free"):
        return f"{_fmt_dur_short(s['d'])} free"
    k = 1 if s["u"] == "w" else 100
    v = lambda x: _fixed1(x * k)  # noqa: E731
    rng = f"-{v(s['b'])}" if s["a"] != s["b"] else ""
    return f"{_fmt_dur_short(s['d'])} {v(s['a'])}{rng}{'w' if s['u'] == 'w' else '%'}"


def to_text(steps: list[dict]) -> str:
    tok = [step_text(s) for s in steps]
    out, i = [], 0
    while i < len(tok):
        best = None
        L = 1
        while L <= 6 and i + L * 2 <= len(tok):
            k = 1
            while tok[i + k * L:i + (k + 1) * L] == tok[i:i + L]:
                k += 1
            if k >= 2 and (best is None or k * L > best[0] * best[1]):
                best = (k, L)
            L += 1
        if best:
            k, L = best
            out.append(f"{k}x({', '.join(tok[i:i + L])})")
            i += k * L
        else:
            out.append(tok[i])
            i += 1
    return ", ".join(out)


def compile_workout(text: str) -> tuple[list[dict], int]:
    steps = parse_workout(text)
    t = 0
    for s in steps:
        s["t0"] = t
        t += s["d"]
    return steps, t


def step_at(steps: list[dict], el: float):
    for i, s in enumerate(steps):
        if el < s["t0"] + s["d"]:
            return i, s, el - s["t0"]
    return None


def step_watts(s: dict, into: float, ftp: float, k: float = 1) -> int | None:
    if s.get("free"):
        return None
    x = s["a"] + (s["b"] - s["a"]) * (min(1, into / s["d"]) if s["d"] > 0 else 1)
    return js_round((x if s["u"] == "w" else x * ftp) * k)
