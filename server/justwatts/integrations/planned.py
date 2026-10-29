"""Planned workouts from calendars -> the app's workout text (docs/PROTOCOL.md "Workout text").

Tree nodes: a step {d, a, b, u} (a/b fractions of FTP for u "%", watts for "w"), a free step {d, free},
or a repeat {n, items}. Anything we cannot ride by power (HR or pace targets, open or distance steps, max
efforts) becomes a free segment of the same length, so the rider still gets the shape of the session.
web/api/_lib/integrations/planned.js is the JS twin; tests/test_integrations_planned.py checks they agree.
"""
from __future__ import annotations

import json

from ..events import js_round
from ..workout import WorkoutError, parse_workout, step_text

OPEN_S = 300          # a step with no time (lap button, open duration) rides 5 minutes free
FLAT_MPS = 30 / 3.6   # distance steps: time at 30 km/h
# Coggan power zone midpoints, % FTP (intervals.icu default zones) for "power_zone" targets
ZONE_MID = {1: 50, 2: 65, 3: 83, 4: 98, 5: 113, 6: 135, 7: 160}


def _r(x: float) -> float:
    return js_round(x * 1e4) / 1e4


def pct(a: float, b: float | None = None) -> dict:
    return {"a": _r(a / 100), "b": _r((a if b is None else b) / 100), "u": "%"}


def watts(a: float, b: float | None = None) -> dict:
    return {"a": js_round(a), "b": js_round(a if b is None else b), "u": "w"}


def tree_text(tree: list[dict]) -> str:
    out = []
    for x in tree:
        if "items" in x:
            out.append(f"{x['n']}x({tree_text(x['items'])})")
        else:
            out.append(step_text(x))
    return ", ".join(out)


def simplify(tree: list[dict]) -> list[dict]:
    """Drop empty repeats, inline 1x repeats, merge neighbouring free steps."""
    out: list[dict] = []
    for x in tree:
        if "items" in x:
            items = simplify(x["items"])
            if not items or x["n"] < 1:
                continue
            if x["n"] == 1:
                out.extend(items)
                continue
            x = {"n": x["n"], "items": items}
        elif x.get("d", 0) <= 0:
            continue
        if out and x.get("free") and out[-1].get("free"):
            out[-1] = {"d": out[-1]["d"] + x["d"], "free": True}
        else:
            out.append(x)
    return out


def tree_seconds(tree: list[dict]) -> int:
    return sum(x["n"] * tree_seconds(x["items"]) if "items" in x else x["d"] for x in tree)


def finish(tree: list[dict]) -> str | None:
    """Tree -> text, checked by the DSL parser. None when nothing rideable is left."""
    tree = simplify(tree)
    if not tree:
        return None
    text = tree_text(tree)
    try:
        parse_workout(text)
    except WorkoutError:
        return f"{max(1, js_round(tree_seconds(tree) / 60))}m free"
    return text


# ---------- intervals.icu workout_doc ----------
def _icu_target(st: dict, ftp: float | None) -> dict | None:
    """Power target of one intervals.icu step, or None (free)."""
    if st.get("freeride") or st.get("maxeffort"):
        return None
    p = st.get("power")
    if not isinstance(p, dict):
        return None
    units = p.get("units") or "%ftp"
    lo, hi = p.get("start"), p.get("end")
    val = p.get("value")
    ramp = bool(st.get("ramp")) and lo is not None and hi is not None

    def span(f):
        if ramp:
            return f(lo, hi)
        if lo is not None and hi is not None:  # a range target: ride its middle
            return f((lo + hi) / 2)
        return f(val) if val is not None else None

    if units == "%ftp":
        return span(pct)
    if units == "w":
        return span(watts)
    if units == "power_zone":
        z = val if val is not None else lo
        return pct(ZONE_MID[int(z)]) if isinstance(z, (int, float)) and int(z) in ZONE_MID else None
    rp = st.get("_power")  # resolve=true: watts worked out by intervals.icu (%mmp and anything else)
    if isinstance(rp, dict):
        rlo, rhi, rv = rp.get("start"), rp.get("end"), rp.get("value")
        if ramp and rlo is not None and rhi is not None:
            # a known intervals.icu bug flipped down-ramps once: follow the direction of the plan
            if lo is not None and hi is not None and (hi - lo) * (rhi - rlo) < 0:
                rlo, rhi = rhi, rlo
            t = watts(rlo, rhi)
        elif rv is not None:
            t = watts(rv)
        else:
            return None
        if ftp:
            return pct(t["a"] / ftp * 100, t["b"] / ftp * 100)
        return t
    return None


def _icu_steps(steps: list, ftp: float | None) -> list[dict]:
    out: list[dict] = []
    for st in steps or []:
        if not isinstance(st, dict):
            continue
        if isinstance(st.get("steps"), list):
            n = int(st.get("reps") or 1)
            out.append({"n": n, "items": _icu_steps(st["steps"], ftp)})
            continue
        d = st.get("duration")
        target = _icu_target(st, ftp)
        if not d:
            dist = st.get("distance") or st.get("_distance")
            d, target = (js_round(dist / FLAT_MPS), None) if dist else (OPEN_S, None)
        d = int(js_round(d))
        out.append({"d": d, **target} if target else {"d": d, "free": True})
    return out


def from_intervals(doc: dict | None) -> str | None:
    if not isinstance(doc, dict) or not doc.get("steps"):
        return None
    return finish(_icu_steps(doc["steps"], doc.get("ftp")))


# ---------- TrainingPeaks structure ----------
LEN_S = {"second": 1, "minute": 60, "hour": 3600}
LEN_M = {"meter": 1, "kilometer": 1000, "mile": 1609.344}


def _tp_len(length: dict | None) -> tuple[int | None, bool]:
    """-> (seconds, known). Distance becomes time at 30 km/h, unknown units None."""
    if not isinstance(length, dict):
        return None, False
    v, unit = length.get("value"), str(length.get("unit") or "").lower()
    if not isinstance(v, (int, float)):
        return None, False
    if unit in LEN_S:
        return js_round(v * LEN_S[unit]), True
    if unit in LEN_M:
        return js_round(v * LEN_M[unit] / FLAT_MPS), False
    return None, False


def _tp_step(st: dict, metric: str) -> dict:
    d, timed = _tp_len(st.get("length"))
    if st.get("openDuration") or not d:
        return {"d": d or OPEN_S, "free": True}
    if not timed or metric != "percentofftp":
        return {"d": d, "free": True}
    t = next((t for t in st.get("targets") or [] if isinstance(t, dict) and not t.get("unit")), None)
    if not t or not isinstance(t.get("minValue"), (int, float)):
        return {"d": d, "free": True}
    lo, hi = t["minValue"], t.get("maxValue")
    return {"d": d, **pct((lo + hi) / 2 if isinstance(hi, (int, float)) else lo)}


def _tp_items(items: list, metric: str) -> list[dict]:
    out: list[dict] = []
    for it in items or []:
        if not isinstance(it, dict):
            continue
        typ = str(it.get("type") or "step")
        if isinstance(it.get("steps"), list):  # a block: step, repetition, rampUp, rampDown (stair steps)
            ln = it.get("length") or {}
            n = int(ln.get("value") or 1) if str(ln.get("unit") or "repetition") == "repetition" else 1
            out.append({"n": n if typ == "repetition" else 1, "items": _tp_items(it["steps"], metric)})
        else:
            out.append(_tp_step(it, metric))
    return out


def from_trainingpeaks(structure) -> str | None:
    if isinstance(structure, str):
        try:
            structure = json.loads(structure)
        except ValueError:
            return None
    if not isinstance(structure, dict) or not structure.get("structure"):
        return None
    metric = str(structure.get("primaryIntensityMetric") or "percentOfFtp").lower()
    return finish(_tp_items(structure["structure"], metric))


def free_for(seconds: float | None) -> str | None:
    """An unstructured planned ride: its planned time as one free segment."""
    if not seconds or seconds <= 0:
        return None
    return f"{max(1, js_round(seconds / 60))}m free"
