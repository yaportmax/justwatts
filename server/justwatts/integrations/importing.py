"""Data import (profile, past rides) from connected services: tolerant readers for Garmin Connect and intervals.icu
answers, and a small zip reader for Garmin's original-file download. Twin of web/api/_lib/integrations/importing.js.
Every piece is optional: a reader returns what it found and the names of the fields it could not read."""
from __future__ import annotations

import gzip
import io
import re
import zipfile
from datetime import datetime, timezone
from typing import Any

PROFILE_KEYS = ("ftp", "weight_kg", "hr_max", "hr_rest", "lthr", "hr_zones")


def _num(v: Any) -> float | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str) and v.strip():
        try:
            return float(v)
        except ValueError:
            return None
    return None


def _first(*vs):
    return next((v for v in vs if v is not None), None)


def _rng(v, lo, hi):
    return int(round(v)) if v is not None and lo <= round(v) <= hi else None


def _weight(v):
    if v is None:
        return None
    kg = round((v / 1000 if v > 1000 else v) * 10) / 10
    return kg if 25 <= kg <= 250 else None


def _zones(v):
    ok = isinstance(v, list) and len(v) == 5 and all(isinstance(x, (int, float)) and 30 < x < 230 for x in v) \
        and all(v[i] > v[i - 1] for i in range(1, 5))
    return [int(round(x)) for x in v] if ok else None


CHECK = {"ftp": lambda v: _rng(v, 50, 600), "weight_kg": _weight, "hr_max": lambda v: _rng(v, 100, 230),
         "hr_rest": lambda v: _rng(v, 25, 120), "lthr": lambda v: _rng(v, 80, 220), "hr_zones": _zones}


def finish(raw: dict, pieces: dict) -> dict:
    values, missing = {}, []
    for k in PROFILE_KEYS:
        v = None if raw.get(k) is None else CHECK[k](raw[k])
        if v is None:
            missing.append(k)
        else:
            values[k] = v
    errors = {k: str(p.get("error") or "failed")[:120] for k, p in pieces.items() if not p.get("ok")}
    return {"values": values, "missing": missing, "errors": errors}


def _obj(v):
    return v if isinstance(v, dict) else None


def _list(v):
    return v if isinstance(v, list) else []


def garmin_profile(pieces: dict) -> dict:
    def j(name):
        p = pieces.get(name) or {}
        return p.get("json") if p.get("ok") else None
    settings = _obj(j("settings")) or {}
    user = _obj(settings.get("userData")) or settings
    zl = [z for z in _list(j("zones")) if isinstance(z, dict)]
    z = next((x for x in zl if x.get("sport") == "CYCLING"), None) or next((x for x in zl if x.get("sport") in ("DEFAULT", None)), None) \
        or (zl[0] if zl else {})
    floors = [_num(z.get(f"zone{i}Floor")) for i in range(1, 6)]
    fr = j("ftp")
    fo = _obj(fr[0]) if isinstance(fr, list) and fr else _obj(fr)
    w = _obj(j("weight")) or {}

    def when(x):
        return _num(x.get("date")) or _num(x.get("timestampGMT")) or 0
    ins = sorted([x for x in _list(w.get("dateWeightList")) if isinstance(x, dict) and _num(x.get("weight")) is not None], key=when, reverse=True)
    lt = j("lactate")
    lo = (next((x for x in lt if isinstance(x, dict) and _num(x.get("heartRate")) is not None), None) or (lt[0] if lt else None)) \
        if isinstance(lt, list) else _obj(lt)
    hr = _obj(j("rhr")) or {}
    raw = {
        "ftp": _first(fo and _num(fo.get("functionalThresholdPower")), fo and _num(fo.get("value")), _num(user.get("functionalThresholdPower")), _num(user.get("ftp"))),
        "weight_kg": _first(_num(ins[0]["weight"]) if ins else None, _num((_obj(w.get("totalAverage")) or {}).get("weight")), _num(user.get("weight"))),
        "hr_max": _first(_num(z.get("maxHeartRateUsed")), _num(user.get("maxHeartRate"))),
        "hr_rest": _first(_num(hr.get("restingHeartRate")), _num(hr.get("lastSevenDaysAvgRestingHeartRate")), _num(z.get("restingHeartRateUsed"))),
        "lthr": _first(lo and _num(lo.get("heartRate")), _num(z.get("lactateThresholdHeartRateUsed")), _num(user.get("lactateThresholdHeartRate"))),
        "hr_zones": floors if all(f is not None for f in floors) else None,
    }
    return finish(raw, pieces)


def intervals_profile(pieces: dict) -> dict:
    p = pieces.get("athlete") or {}
    a = _obj(p.get("json")) if p.get("ok") else None
    a = a or {}
    ss = [s for s in _list(a.get("sportSettings")) if isinstance(s, dict)]
    ride = next((s for s in ss if "Ride" in _list(s.get("types"))), None) or next((s for s in ss if "VirtualRide" in _list(s.get("types"))), None) or {}
    raw = {"ftp": _first(_num(ride.get("ftp")), _num(ride.get("indoor_ftp"))), "weight_kg": _first(_num(a.get("icu_weight")), _num(a.get("weight"))),
           "hr_max": _num(ride.get("max_hr")), "hr_rest": _num(a.get("icu_resting_hr")), "lthr": _num(ride.get("lthr")), "hr_zones": None}
    return finish(raw, pieces)


INDOOR_GARMIN = re.compile(r"indoor|virtual|trainer", re.I)
CYCLING_GARMIN = re.compile(r"cycl|bik|ride|velo", re.I)


def _gmt_ms(s) -> int | None:
    m = re.match(r"^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)", str(s or ""))
    if not m:
        return None
    return int(datetime(*map(int, m.groups()), tzinfo=timezone.utc).timestamp() * 1000)


def _iso_ms(s) -> int | None:
    try:
        d = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return int(d.timestamp() * 1000)


def garmin_activity(a) -> dict | None:
    if not isinstance(a, dict) or _num(a.get("activityId")) is None:
        return None
    t = _obj(a.get("activityType")) or {}
    typ = str(t.get("typeKey") or a.get("activityTypeKey") or "")
    if not CYCLING_GARMIN.search(typ):
        return None
    start = _first(_num(a.get("beginTimestamp")), _gmt_ms(a.get("startTimeGMT")))
    if start is None:
        return None
    return {"id": str(int(_num(a["activityId"]))), "name": str(a.get("activityName") or "Ride")[:120], "start_ms": int(start),
            "duration_s": round(_num(a.get("duration")) or 0), "distance_m": round(_num(a.get("distance")) or 0), "type": typ,
            "indoor": bool(INDOOR_GARMIN.search(typ)), "power": _num(a.get("avgPower")) is not None}


def intervals_activity(a) -> dict | None:
    if not isinstance(a, dict) or a.get("id") is None:
        return None
    typ = str(a.get("type") or "")
    if "Ride" not in typ:
        return None
    start = _first(_iso_ms(a["start_date"]) if a.get("start_date") else None, _iso_ms(a["start_date_local"]) if a.get("start_date_local") else None)
    if start is None:
        return None
    out = {"id": str(a["id"]), "name": str(a.get("name") or "Ride")[:120], "start_ms": start,
           "duration_s": round(_num(a.get("elapsed_time")) or _num(a.get("moving_time")) or 0), "distance_m": round(_num(a.get("distance")) or 0),
           "type": typ, "indoor": typ.startswith("Virtual") or a.get("trainer") is True, "power": _num(a.get("icu_average_watts")) is not None}
    if a.get("source") == "STRAVA":
        out["no_file"] = True
    return out


def fit_from_zip(data: bytes) -> bytes:
    """zip (or gzip, or a plain FIT) -> the FIT inside."""
    b = bytes(data)
    if len(b) >= 12 and b[8:12] == b".FIT":
        return b
    if b[:2] == b"\x1f\x8b":
        return fit_from_zip(gzip.decompress(b))
    try:
        with zipfile.ZipFile(io.BytesIO(b)) as z:
            for n in z.namelist():
                if n.lower().endswith(".fit"):
                    out = z.read(n)
                    if out[8:12] == b".FIT":
                        return out
    except zipfile.BadZipFile:
        raise ValueError("not a zip") from None
    raise ValueError("no .fit in the zip")
