"""Ride history analytics on the server: summaries, laps, zones, best efforts, trends, FIT/TCX export.

summarize(), fit_encode() and tcx() are ports of app/js/core.js; tests/test_history.py checks that
the Python FIT bytes equal the JS ones.
"""
from __future__ import annotations

import datetime as dt
import math
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from .course import track
from .events import js_round
from .workout import WorkoutError, compile_workout, step_at

ZONES = [(0.55, "Z1"), (0.76, "Z2"), (0.91, "Z3"), (1.06, "Z4"), (1.21, "Z5"), (math.inf, "Z6")]
BEST_WINDOWS = (60, 300, 1200)
FIT_EPOCH = 631065600


def zone_idx(f: float) -> int:
    return next(i for i, (hi, _) in enumerate(ZONES) if f < hi)


def hr_zone(h: int, floors: list | None) -> int:
    if not floors or not h > 0:
        return -1
    i = -1
    for k, f in enumerate(floors):
        if h >= f:
            i = k
    return i


HR_MAX_DEFAULT = 185
HRZ_PCT = (50, 60, 70, 80, 90)


def _num(x) -> float | None:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def valid_hr_floors(z) -> bool:
    if not isinstance(z, list) or len(z) != 5:
        return False
    if not all(isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) and 30 < x < 230 for x in z):
        return False
    return all(b > a for a, b in zip(z, z[1:]))


def default_hr_floors(hr_max: float) -> list[int]:
    return [js_round(hr_max * p / 100) for p in HRZ_PCT]


def active_hr_zones(s: dict | None) -> dict:
    """Manual or Garmin floors when set, else 50/60/70/80/90 % of max HR (185 when unset).
    Mirrors core.js activeHrZones."""
    s = s or {}
    src, m = s.get("hrZonesSrc"), _num(s.get("hrMax"))
    hr_max = (int(m) if m == int(m) else m) if m is not None and 100 <= m <= 230 else None
    if src != "default" and valid_hr_floors(s.get("hrZones")):
        return {"floors": s["hrZones"], "max": hr_max, "src": src or "manual"}
    mx = hr_max or HR_MAX_DEFAULT
    return {"floors": default_hr_floors(mx), "max": mx, "src": "default"}


def norm_power(p: list[float]) -> float:
    if len(p) < 30:
        return sum(p) / len(p) if p else 0
    s = acc = 0.0
    n = 0
    for i, x in enumerate(p):
        s += x
        if i >= 30:
            s -= p[i - 30]
        if i >= 29:
            acc += (s / 30) ** 4
            n += 1
    return (acc / n) ** 0.25


def best_mean(p: list[float], w: int) -> float:
    if len(p) < w:
        return 0.0
    s = sum(p[:w])
    best = s
    for i in range(w, len(p)):
        s += p[i] - p[i - w]
        best = max(best, s)
    return best / w


def ftp_estimate(r: dict, m: dict, P: list[float]) -> int | None:
    """FTP from a test ride: 95% of the best 20 min when the plan has a 20 min free effort, else 75% of the best minute (ramp)."""
    if not r.get("test"):
        return None
    try:
        twenty = any(s.get("free") and s["d"] >= 1200 for s in compile_workout(r.get("text") or "")[0])
    except WorkoutError:
        twenty = False
    if twenty:
        return js_round(best_mean(P, 1200) * 0.95) if len(P) >= 1200 else None
    return js_round(m["best60"] * 0.75) if m["best60"] else None


def best_efforts(P: list[float]) -> dict:
    """Best mean power for 1/5/20 min; None when the ride is shorter than the window (never 0)."""
    return {f"{w // 60}m": (round(best_mean(P, w)) if len(P) >= w else None) for w in BEST_WINDOWS}


def _on_course(s: list) -> bool:
    """Course rides add [altitude m, distance m] to every sample."""
    return bool(s) and len(s[-1]) > 8


def summarize(r: dict) -> dict:
    """Same numbers as core.js summarize()."""
    s = r["samples"]
    n = len(s)
    P = [x[2] for x in s]
    avg = lambda a: sum(a) / len(a) if a else 0  # noqa: E731
    ftp = r["ftp"]
    np_ = norm_power(P)
    IF = np_ / ftp
    hr = [x[4] for x in s if x[4] > 0]
    cad = [x[3] for x in s if x[3] > 0]
    dist = s[-1][8] if _on_course(s) else sum(x[5] / 3.6 for x in s)
    zt = [0] * len(ZONES)
    for p in P:
        zt[zone_idx(p / ftp)] += 1
    return {"dur": n, "avgP": avg(P), "np": np_, "IF": IF, "tss": n * np_ * IF / (ftp * 3600) * 100,
            "maxP": max([0, *P]), "kJ": sum(P) / 1000, "avgHR": avg(hr), "maxHR": max([0, *hr]), "avgC": avg(cad),
            "dist": dist, "best60": best_mean(P, 60), "zt": zt,
            "elapsed": (s[-1][0] - s[0][0]) / 1000 + 1 if n else 0}


def ride_steps(r: dict) -> list[dict] | None:
    """The ridden step list: stored steps (edits included), else the text with overrides applied."""
    if r.get("steps"):
        steps = [dict(x) for x in r["steps"]]
        t = 0
        for x in steps:
            x["t0"] = t
            t += x["d"]
        return steps
    if not r.get("text"):
        return None
    try:
        steps, _ = compile_workout(r["text"])
    except WorkoutError:
        return None
    for i, w in (r.get("ov") or {}).items():
        i = int(i)
        if 0 <= i < len(steps) and not steps[i].get("free"):
            a, b = (w[0], w[1]) if isinstance(w, (list, tuple)) else (w, w)
            steps[i].update(a=a, b=b, u="w")
    return steps


def laps(r: dict) -> list[dict]:
    """One lap per workout step (or one lap for a free ride): avg/max W, HR, cadence, target."""
    s = r["samples"]
    steps = ride_steps(r)
    groups: dict[int, list] = {}
    for x in s:
        if steps:
            at = step_at(steps, max(0.0, x[1] - 0.5))
            i = at[0] if at else len(steps)  # after the plan ended: one free "overtime" lap
        else:
            i = 0
        groups.setdefault(i, []).append(x)
    out = []
    for i in sorted(groups):
        g = groups[i]
        P = [x[2] for x in g]
        hr = [x[4] for x in g if x[4] > 0]
        cad = [x[3] for x in g if x[3] > 0]
        tg = [x[6] for x in g if x[6]]
        st = steps[i] if steps and i < len(steps) else None
        out.append({"index": i + 1, "planned_s": st["d"] if st else None, "time_s": len(g),
                    "free": bool(st and st.get("free")) or (bool(steps) and st is None),
                    "overtime": bool(steps) and st is None, "target_w": js_round(sum(tg) / len(tg)) if tg else None,
                    "avg_w": js_round(sum(P) / len(P)), "max_w": max(P), "np": js_round(norm_power(P)),
                    "avg_hr": js_round(sum(hr) / len(hr)) if hr else None, "max_hr": max(hr) if hr else None,
                    "avg_cad": js_round(sum(cad) / len(cad)) if cad else None, "kJ": round(sum(P) / 1000, 1),
                    "start_s": g[0][1] - 1})
    return out


def detail(r: dict, hr_floors: list | None = None, meta: dict | None = None) -> dict:
    m = summarize(r)
    P = [x[2] for x in r["samples"]]
    hz = [0] * 5
    for x in r["samples"]:
        i = hr_zone(x[4], hr_floors)
        if i >= 0:
            hz[i] += 1
    out = {
        "id": r.get("id"), "name": r.get("name"), "start": r.get("start"), "ftp": r.get("ftp"), "test": r.get("test"),
        "summary": {"time_s": m["dur"], "elapsed_s": round(m["elapsed"]), "avg_w": round(m["avgP"]), "np": round(m["np"]),
                    "max_w": m["maxP"], "if": round(m["IF"], 2), "tss": round(m["tss"]), "kJ": round(m["kJ"]),
                    "avg_hr": round(m["avgHR"]) or None, "max_hr": m["maxHR"] or None, "avg_cad": round(m["avgC"]),
                    "distance_km": round(m["dist"] / 1000, 2)},
        "best": best_efforts(P),
        "power_zones_s": dict(zip([z for _, z in ZONES], m["zt"])),
        "hr_zones_s": dict(zip([f"Z{i + 1}" for i in range(5)], hz)) if hr_floors else None,
        "laps": laps(r),
        "events": r.get("events") or [],
        "garmin": (meta or {}).get("garmin"), "strava": (meta or {}).get("strava"),
        "description": (meta or {}).get("description"),
        "agent": r.get("agent") or {"wakes": None, "local_cues": None, "usage": {}},
    }
    est = ftp_estimate(r, m, P)
    if est:
        out["ftp_estimate"] = est
    return out


def ride_meta_row(r: dict, meta: dict | None = None) -> dict:
    m = summarize(r)
    P = [x[2] for x in r["samples"]]
    return {"id": r.get("id"), "name": r.get("name"), "start": r.get("start") or (r["samples"][0][0] if r["samples"] else None),
            "samples": len(r["samples"]), "source": r.get("source"), "ftp": r.get("ftp"), "test": bool(r.get("test")),
            "time_s": m["dur"], "avg_w": round(m["avgP"]), "np": round(m["np"]), "tss": round(m["tss"]),
            "if": round(m["IF"], 2), "kJ": round(m["kJ"]), "avg_hr": round(m["avgHR"]) or None,
            "best": best_efforts(P),
            "ftp_estimate": ftp_estimate(r, m, P),
            "garmin": (meta or {}).get("garmin"), "strava": (meta or {}).get("strava"),
            "agent_wakes": (r.get("agent") or {}).get("wakes"), "local_cues": (r.get("agent") or {}).get("local_cues"),
            "agent_tokens": _tokens((r.get("agent") or {}).get("usage") or {}),
            "agent_cost_usd": ((r.get("agent") or {}).get("usage") or {}).get("cost_usd")}


def _tokens(u: dict) -> int | None:
    keys = ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens")
    return sum(int(u.get(k) or 0) for k in keys) if any(k in u for k in keys) else None


def trends(rows: list[dict], weeks: int = 12, today: dt.date | None = None) -> dict:
    """Weekly load, FTP history and all-time best efforts from ride rows (ride_meta_row)."""
    today = today or dt.date.today()
    monday = today - dt.timedelta(days=today.weekday())
    buckets = []
    for k in range(weeks - 1, -1, -1):
        start = monday - dt.timedelta(weeks=k)
        buckets.append({"week": start.isoformat(), "tss": 0, "time_s": 0, "kJ": 0, "rides": 0})
    index = {b["week"]: b for b in buckets}
    ftp_hist: list[dict] = []
    best: dict[str, dict] = {}
    for r in sorted(rows, key=lambda x: x.get("start") or 0):
        if not r.get("start"):
            continue
        d = dt.datetime.fromtimestamp(r["start"] / 1000).date()
        wk = (d - dt.timedelta(days=d.weekday())).isoformat()
        if wk in index:
            b = index[wk]
            b["tss"] += r["tss"]
            b["time_s"] += r["time_s"]
            b["kJ"] += r["kJ"]
            b["rides"] += 1
        f = r.get("ftp_estimate") or r.get("ftp")
        if f and (not ftp_hist or ftp_hist[-1]["ftp"] != f):
            ftp_hist.append({"date": d.isoformat(), "ftp": f, "source": "test" if r.get("ftp_estimate") else "setting",
                             "ride": r["id"]})
        for k, v in (r.get("best") or {}).items():
            if v and v > best.get(k, {}).get("w", 0):
                best[k] = {"w": v, "date": d.isoformat(), "ride": r["id"]}
    return {"weeks": buckets, "ftp_history": ftp_hist, "best": best}


# ---------- export ----------
def _put(b: bytearray, v: int, n: int) -> None:
    for i in range(n):
        b.append((v >> (8 * i)) & 255)


def fit_crc(data, c: int = 0) -> int:
    t_ = [0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401, 0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400]
    for x in data:
        t = t_[c & 0xF]
        c = (c >> 4) & 0x0FFF
        c = c ^ t ^ t_[x & 0xF]
        t = t_[c & 0xF]
        c = (c >> 4) & 0x0FFF
        c = c ^ t ^ t_[(x >> 4) & 0xF]
    return c


def fit_encode(r: dict, tz_offset_s: float | None = None) -> bytes:
    """Activity FIT file, byte-identical to core.js fitEncode() on the same machine."""
    ENUM, U8, U16, S32, U32, U32Z = 0x00, 0x02, 0x84, 0x85, 0x86, 0x8C
    SZ = {ENUM: 1, U8: 1, U16: 2, S32: 4, U32: 4, U32Z: 4}
    INV = {ENUM: 0xFF, U8: 0xFF, U16: 0xFFFF, S32: 0x7FFFFFFF, U32: 0xFFFFFFFF, U32Z: 0}
    b = bytearray()
    defs: dict[int, list] = {}

    def define(local, glob, fields):
        defs[local] = fields
        b.extend([0x40 | local, 0, 0])
        _put(b, glob, 2)
        b.append(len(fields))
        for num, t in fields:
            b.extend([num, SZ[t], t])

    def msg(local, vals):
        b.append(local)
        for (_, t), v in zip(defs[local], vals):
            if v is None or not math.isfinite(v):
                v = INV[t]
            elif t == S32:
                v = max(-0x7FFFFFFF, min(0x7FFFFFFE, js_round(v))) & 0xFFFFFFFF
            else:
                v = max(0, min(0xFFFFFFFE if INV[t] == 0 else INV[t] - 1, js_round(v)))
            _put(b, int(v), SZ[t])

    s, m = r["samples"], summarize(r)
    ts = lambda x: js_round(x / 1000) - FIT_EPOCH  # noqa: E731
    t0, t_end = ts(s[0][0]), ts(s[-1][0])
    define(0, 0, [(0, ENUM), (1, U16), (2, U16), (3, U32Z), (4, U32)])
    msg(0, [4, 255, 1, 0x48554221, t0])
    define(1, 21, [(253, U32), (0, ENUM), (1, ENUM)])
    msg(1, [t0, 0, 0])
    crs = _on_course(s)  # a course ride also records altitude (scale 5, offset 500) and its own distance
    pos = track(r.get("course")) if crs else None  # and, with a map line, a position
    semi = lambda x: x * 2 ** 31 / 180  # noqa: E731
    define(2, 20, [(253, U32), (7, U16), (4, U8), (3, U8), (6, U16), (5, U32)] + ([(2, U16)] if crs else [])
           + ([(0, S32), (1, S32)] if pos else []))
    dist, prev = 0.0, None
    for x in s:
        t = ts(x[0])
        if prev is not None and t - prev > 2:
            msg(1, [prev, 0, 4])
            msg(1, [t, 0, 0])
        if t == prev:
            continue
        dist = x[8] if crs else dist + x[5] / 3.6
        at = pos(dist) if pos else None
        msg(2, [t, x[2], x[3], x[4] or None, x[5] / 3.6 * 1000, dist * 100] + ([(x[7] + 500) * 5] if crs else [])
            + ([semi(at[0]), semi(at[1])] if at else []))
        prev = t
    msg(1, [t_end, 0, 4])
    kcal = m["kJ"]
    define(3, 19, [(253, U32), (2, U32), (7, U32), (8, U32), (9, U32), (11, U16), (15, U8), (16, U8), (17, U8),
                   (19, U16), (20, U16), (0, ENUM), (1, ENUM), (25, ENUM), (39, ENUM)])
    msg(3, [t_end, t0, m["elapsed"] * 1000, m["dur"] * 1000, dist * 100, kcal, m["avgHR"] or None, m["maxHR"] or None,
            m["avgC"], m["avgP"], m["maxP"], 9, 1, 2, 58 if pos else 6])
    define(4, 18, [(253, U32), (2, U32), (7, U32), (8, U32), (9, U32), (5, ENUM), (6, ENUM), (11, U16), (16, U8),
                   (17, U8), (18, U8), (20, U16), (21, U16), (34, U16), (35, U16), (36, U16), (45, U16), (25, U16),
                   (26, U16), (0, ENUM), (1, ENUM), (28, ENUM)])
    msg(4, [t_end, t0, m["elapsed"] * 1000, m["dur"] * 1000, dist * 100, 2, 58 if pos else 6, kcal, m["avgHR"] or None,
            m["maxHR"] or None, m["avgC"], m["avgP"], m["maxP"], m["np"], m["tss"] * 10, m["IF"] * 1000, r["ftp"],
            0, 1, 8, 1, 0])
    if tz_offset_s is None:
        tz_offset_s = dt.datetime.now().astimezone().utcoffset().total_seconds()
    define(5, 34, [(253, U32), (0, U32), (1, U16), (2, ENUM), (3, ENUM), (4, ENUM), (5, U32)])
    msg(5, [t_end, m["dur"] * 1000, 1, 0, 26, 1, t_end + tz_offset_s])
    n = len(b)
    h = bytearray([14, 0x20, 2132 & 255, 2132 >> 8, n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255,
                   0x2E, 0x46, 0x49, 0x54])
    hc = fit_crc(h)
    h.extend([hc & 255, hc >> 8])
    allb = h + b
    c = fit_crc(allb)
    allb.extend([c & 255, c >> 8])
    return bytes(allb)


def _jsnum(x: float) -> str:
    """A number as JS prints it in a template (x is rounded to 1e-6, so repr matches for these values)."""
    return str(int(x)) if x == int(x) else repr(x)


def _fixed(x: float, n: int) -> str:
    return format(Decimal(x).quantize(Decimal(1).scaleb(-n), rounding=ROUND_HALF_UP), "f")


def _esc(s: str) -> str:
    return "".join({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}.get(ch, ch) for ch in str(s))


def tcx(r: dict) -> str:
    s, m = r["samples"], summarize(r)
    iso = lambda ms: dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")  # noqa: E731
    dist = 0.0
    pts = []
    crs = _on_course(s)
    pos = track(r.get("course")) if crs else None
    for x in s:
        dist = x[8] if crs else dist + x[5] / 3.6
        at = pos(dist) if pos else None
        where = f"<Position><LatitudeDegrees>{_jsnum(at[0])}</LatitudeDegrees><LongitudeDegrees>{_jsnum(at[1])}</LongitudeDegrees></Position>" if at else ""
        hr = f"<HeartRateBpm><Value>{x[4]}</Value></HeartRateBpm>" if x[4] else ""
        alt = f"<AltitudeMeters>{_fixed(x[7], 1)}</AltitudeMeters>" if crs else ""
        pts.append(f"<Trackpoint><Time>{iso(x[0])}</Time>{where}{alt}<DistanceMeters>{_fixed(dist, 1)}</DistanceMeters>{hr}"
                   f"<Cadence>{x[3]}</Cadence><Extensions><ns3:TPX><ns3:Speed>{_fixed(x[5] / 3.6, 2)}</ns3:Speed>"
                   f"<ns3:Watts>{x[2]}</ns3:Watts></ns3:TPX></Extensions></Trackpoint>")
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" '
            'xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">\n'
            f'<Activities><Activity Sport="Biking"><Id>{iso(s[0][0])}</Id><Lap StartTime="{iso(s[0][0])}">'
            f"<TotalTimeSeconds>{m['dur']}</TotalTimeSeconds><DistanceMeters>{_fixed(dist, 1)}</DistanceMeters>"
            f"<Calories>{js_round(m['kJ'])}</Calories><Intensity>Active</Intensity><TriggerMethod>Manual</TriggerMethod><Track>\n"
            + "\n".join(pts) +
            f"\n</Track></Lap><Notes>{_esc(r['name'])}</Notes></Activity></Activities></TrainingCenterDatabase>\n")


def file_base(r: dict) -> str:
    import re
    t = dt.datetime.fromtimestamp((r.get("start") or r["samples"][0][0]) / 1000, dt.timezone.utc)
    name = re.sub(r"[^\w\- ]+", "", r["name"])
    return f"{t.strftime('%Y-%m-%d-%H-%M')} {name}"
