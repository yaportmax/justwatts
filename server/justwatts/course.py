"""Courses: a Python port of app/js/course.js (GPX/TCX import, 10 m elevation profile, grade lookup,
virtual speed from power). tests/test_course.py checks both give the same numbers."""
from __future__ import annotations

import html
import math
import re

STEP_M, G_MIN, G_MAX, MAX_M, MIN_M = 10, -15, 20, 500000, 100
PHYS = {"crr": 0.004, "cda": 0.32, "rho": 1.2, "eta": 0.97, "bike": 9, "rider": 75, "g": 9.81, "vmax": 30}
R_EARTH = 6371000


def _rad(x: float) -> float:
    return x * math.pi / 180


def _r1(x: float) -> float:
    return math.floor(x * 10 + 0.5) / 10


def _clamp(x, a, b):
    return min(b, max(a, x))


def _finite(x) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def haversine(a: dict, b: dict) -> float:
    s1, s2 = math.sin(_rad(b["lat"] - a["lat"]) / 2), math.sin(_rad(b["lon"] - a["lon"]) / 2)
    h = s1 * s1 + math.cos(_rad(a["lat"])) * math.cos(_rad(b["lat"])) * s2 * s2
    return 2 * R_EARTH * math.asin(min(1, math.sqrt(h)))


def track(c):
    """Position on the map line at d metres -> [lat, lon] (1e-6 deg), or None without a line. Mirrors course.js track()."""
    ll = c.get("ll") if isinstance(c, dict) and isinstance(c.get("ll"), list) else []
    if len(ll) < 2:
        return None
    D = [0.0]
    for i in range(1, len(ll)):
        D.append(D[-1] + haversine({"lat": ll[i - 1][0], "lon": ll[i - 1][1]}, {"lat": ll[i][0], "lon": ll[i][1]}))
    k = c["dist"] / D[-1] if D[-1] > 0 else 0
    D = [x * k for x in D]
    r6 = lambda x: math.floor(x * 1e6 + 0.5) / 1e6  # noqa: E731
    st = {"j": 1}

    def at(d):
        d = min(D[-1], max(0, d))
        j = 1 if D[st["j"] - 1] > d else st["j"]
        while j < len(D) - 1 and D[j] < d:
            j += 1
        st["j"] = j
        f = (d - D[j - 1]) / (D[j] - D[j - 1]) if D[j] > D[j - 1] else 0
        a, b = ll[j - 1], ll[j]
        return [r6(a[0] + (b[0] - a[0]) * f), r6(a[1] + (b[1] - a[1]) * f)]
    return at


# ---------- import ----------
NUM = r"([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)"


def _tag(name: str, body: str) -> float | None:
    m = re.search(rf"<(?:\w+:)?{name}>\s*{NUM}\s*</(?:\w+:)?{name}>", body)
    return float(m.group(1)) if m else None


def _attr(name: str, s: str) -> float | None:
    m = re.search(rf"\b{name}\s*=\s*[\"']{NUM}[\"']", s)
    return float(m.group(1)) if m else None


def _xml_text(s: str) -> str:
    s = re.sub(r"<!\[CDATA\[(.*?)\]\]>", r"\1", s, flags=re.S)
    return html.unescape(s).strip()


def parse_track(text: str) -> dict:
    """GPX (trkpt, else rtept) or TCX (Trackpoint with a position) -> {name, pts: [{lat, lon, ele|None}]}"""
    text = str(text or "")
    pts: list[dict] = []
    name = ""
    if re.search(r"<(?:\w+:)?TrainingCenterDatabase\b", text):
        for m in re.finditer(r"<(?:\w+:)?Trackpoint>(.*?)</(?:\w+:)?Trackpoint>", text, re.S):
            lat, lon = _tag("LatitudeDegrees", m.group(1)), _tag("LongitudeDegrees", m.group(1))
            if lat is not None and lon is not None:
                pts.append({"lat": lat, "lon": lon, "ele": _tag("AltitudeMeters", m.group(1))})
        n = re.search(r"<(?:\w+:)?(?:Name|Id)>(.*?)</(?:\w+:)?(?:Name|Id)>", text, re.S)
    else:
        for kind in ("trkpt", "rtept"):
            for m in re.finditer(rf"<(?:\w+:)?{kind}\b([^>]*?)(?:/>|>(.*?)</(?:\w+:)?{kind}>)", text, re.S):
                lat, lon = _attr("lat", m.group(1)), _attr("lon", m.group(1))
                if lat is not None and lon is not None:
                    pts.append({"lat": lat, "lon": lon, "ele": _tag("ele", m.group(2)) if m.group(2) else None})
            if pts:
                break
        n = re.search(r"<(?:\w+:)?name>(.*?)</(?:\w+:)?name>", text, re.S)
    if n:
        name = _xml_text(n.group(1))
    return {"name": name[:80], "pts": pts}


# ---------- profile ----------
def _median(a: list[float], k: int) -> list[float]:
    out = []
    for i in range(len(a)):
        w = sorted(a[max(0, i - k):i + k + 1])
        out.append(w[len(w) // 2])
    return out


def _moving_avg(a: list[float], k: int) -> list[float]:
    out = []
    for i in range(len(a)):
        s, n = 0.0, 0
        for j in range(max(0, i - k), min(len(a) - 1, i + k) + 1):
            s += a[j]
            n += 1
        out.append(s / n)
    return out


def smooth_ele(raw: list[float]) -> list[float]:
    """50 m median, then 90 m moving average, 0.1 m."""
    return [_r1(x) for x in _moving_avg(_median(raw, 2), 4)]


def gain_of(ele: list[float]) -> int:
    g = 0.0
    for i in range(1, len(ele)):
        if ele[i] > ele[i - 1]:
            g += ele[i] - ele[i - 1]
    return math.floor(g + 0.5)


def build_course(name: str, pts: list[dict]) -> dict:
    """Track points -> compact course. Raises ValueError on a track that is too short or too long."""
    P: list[dict] = []
    D: list[float] = []
    for p in pts or []:
        lat, lon = p.get("lat"), p.get("lon")
        if not _finite(lat) or not _finite(lon) or abs(lat) > 90 or abs(lon) > 180:
            continue
        if P:
            s = haversine(P[-1], p)
            if not s > 0:
                continue
            D.append(D[-1] + s)
        else:
            D.append(0.0)
        P.append(p)
    total = D[-1] if D else 0
    if total < MIN_M:
        raise ValueError("Course too short")
    if total > MAX_M:
        raise ValueError("Course too long (500 km max)")
    first = next((p["ele"] for p in P if _finite(p.get("ele"))), None)
    E, last = [], first if first is not None else 0
    for p in P:
        if _finite(p.get("ele")):
            last = p["ele"]
        E.append(last)
    n = math.floor(total / STEP_M) + 1
    raw, j = [], 0
    for i in range(n):
        x = i * STEP_M
        while j < len(D) - 2 and D[j + 1] < x:
            j += 1
        f = _clamp((x - D[j]) / (D[j + 1] - D[j]), 0, 1) if D[j + 1] > D[j] else 0
        raw.append(E[j] + (E[j + 1] - E[j]) * f)
    ele = smooth_ele(raw)
    ll, m, q = [], min(200, len(P)), 0
    for k in range(m):
        want = k * total / (m - 1) if m > 1 else 0
        while q < len(P) - 1 and D[q] < want:
            q += 1
        ll.append([math.floor(P[q]["lat"] * 1e5 + 0.5) / 1e5, math.floor(P[q]["lon"] * 1e5 + 0.5) / 1e5])
    return {"name": str(name or "Course")[:80], "dist": math.floor(total + 0.5), "gain": gain_of(ele), "ele": ele, "ll": ll}


# ---------- lookups ----------
def ele_at(c: dict, d: float) -> float:
    e = c["ele"]
    x = _clamp(d, 0, (len(e) - 1) * STEP_M)
    i = min(len(e) - 2, math.floor(x / STEP_M))
    return e[i] + (e[i + 1] - e[i]) * ((x - i * STEP_M) / STEP_M)


def grade_at(c: dict, d: float) -> float:
    """Grade (%) of the 10 m segment under position d, clamped, 0.1 resolution. Past the end: the last one."""
    e = c["ele"]
    i = _clamp(math.floor(max(0, d) / STEP_M), 0, len(e) - 2)
    return _r1(_clamp((e[i + 1] - e[i]) / STEP_M * 100, G_MIN, G_MAX))


def profile_of(c: dict, n: int = 300) -> list[float]:
    e = c["ele"]
    if len(e) <= n:
        return list(e)
    return [e[math.floor(k * (len(e) - 1) / (n - 1) + 0.5)] for k in range(n)]


# ---------- speed from power, with momentum ----------
def speed_step(v: float, watts: float, grade: float, mass: float, dt: float) -> float:
    a = math.atan(grade / 100)
    n = max(1, math.ceil(dt / 0.25 - 1e-9))
    h = dt / n
    p = max(0, watts) * PHYS["eta"]
    fk = mass * PHYS["g"] * (PHYS["crr"] * math.cos(a) + math.sin(a))
    air = 0.5 * PHYS["rho"] * PHYS["cda"]
    for _ in range(n):
        e = 0.5 * mass * v * v + (p - (fk + air * v * v) * v) * h
        v = min(PHYS["vmax"], math.sqrt(2 * e / mass)) if e > 0 else 0.0
    return v


def mass_of(weight_kg) -> float:
    w = float(weight_kg) if _finite(weight_kg) else 0
    return (w if w > 0 else PHYS["rider"]) + PHYS["bike"]


MAX_N, MAX_ND = MAX_M // STEP_M + 2, 100000


def _int(x) -> bool:
    return isinstance(x, int) and not isinstance(x, bool) or isinstance(x, float) and x.is_integer()


def _open_parts(ele, ll, nd, least: int):
    """Open-world parts: ele and ll the same length (one point per STEP_M), nd ascending [metres, node id]."""
    if not isinstance(ele, list) or not least <= len(ele) <= MAX_N or not all(_finite(x) and abs(x) < 10000 for x in ele):
        raise ValueError("course.ele must be numbers")
    if (not isinstance(ll, list) or len(ll) != len(ele)
            or not all(isinstance(p, list) and len(p) == 2 and _finite(p[0]) and _finite(p[1]) and abs(p[0]) <= 90 and abs(p[1]) <= 180 for p in ll)):
        raise ValueError("course.ll must be one [lat, lon] per point")
    if (not isinstance(nd, list) or len(nd) > MAX_ND
            or not all(isinstance(x, list) and len(x) == 2 and _finite(x[0]) and _int(x[1]) and (i == 0 or x[0] >= nd[i - 1][0]) for i, x in enumerate(nd))):
        raise ValueError("course.nd must be ascending [metres, id]")
    return list(ele), [[p[0], p[1]] for p in ll], [[x[0], int(x[1])] for x in nd]


def check_ride_course(c) -> dict:
    """A course sent with a load: an open-world course or a plain one."""
    return check_open(c) if isinstance(c, dict) and c.get("open") is True else check_course(c)


def check_open(c: dict) -> dict:
    ele, ll, nd = _open_parts(c.get("ele"), c.get("ll"), c.get("nd", []), math.ceil(MIN_M / STEP_M) + 1)
    return {"name": str(c.get("name") or "Open world")[:80], "dist": (len(ele) - 1) * STEP_M, "gain": gain_of(ele),
            "ele": ele, "ll": ll, "open": True, "nd": nd}


def check_course(c) -> dict:
    """Validate a course sent with a load control. Raises ValueError."""
    if not isinstance(c, dict):
        raise ValueError("course must be an object")
    ele = c.get("ele")
    if (not isinstance(ele, list) or not 2 <= len(ele) <= MAX_M // STEP_M + 2
            or not all(_finite(x) and abs(x) < 10000 for x in ele)):
        raise ValueError("course.ele must be 2.. numbers")
    dist = c.get("dist")
    if not _finite(dist) or not MIN_M <= dist <= MAX_M:
        raise ValueError("course.dist out of range")
    ll = [p for p in (c.get("ll") if isinstance(c.get("ll"), list) else [])
          if isinstance(p, list) and len(p) == 2 and all(_finite(x) for x in p)][:500]
    return {"name": str(c.get("name") or "Course")[:80], "dist": dist, "gain": gain_of(ele), "ele": list(ele), "ll": ll}


def road_extend(c, b, d: float) -> dict:
    """Open world: replace the points from index at on ({at, ele, ll, nd}); d = metres ridden. Never touches the
    segment under the rider (a plain append always fits). nd entries from the first new one on are replaced."""
    if not isinstance(c, dict) or not c.get("open"):
        raise ValueError("not an open-world ride")
    n, at = len(c["ele"]), b.get("at") if isinstance(b, dict) else None
    if not (isinstance(at, int) and not isinstance(at, bool)) or not 1 <= at <= n:
        raise ValueError("road.at out of range")
    if at < min(n, math.floor(max(0, d) / STEP_M) + 2):
        raise ValueError("road.at is behind the rider")
    ele, ll, nd = _open_parts(b.get("ele"), b.get("ll"), b.get("nd", []), 1)
    if at + len(ele) > MAX_N:
        raise ValueError("course too long")
    cut, E = nd[0][0] if nd else math.inf, c["ele"][:at] + ele
    return {**c, "dist": (len(E) - 1) * STEP_M, "gain": gain_of(E), "ele": E, "ll": c["ll"][:at] + ll,
            "nd": [x for x in c["nd"] if x[0] < cut] + nd}


def ridden(c, d: float):
    """Open world at the end of a ride: only the road ridden (d metres), so the saved ride shows where the rider went."""
    if not isinstance(c, dict) or not c.get("open"):
        return c
    n = max(2, min(len(c["ele"]), math.floor(max(0, d) / STEP_M) + 2))
    ele = c["ele"][:n]
    return {**c, "dist": (n - 1) * STEP_M, "gain": gain_of(ele), "ele": ele, "ll": c["ll"][:n],
            "nd": [x for x in c["nd"] if x[0] <= (n - 1) * STEP_M]}
