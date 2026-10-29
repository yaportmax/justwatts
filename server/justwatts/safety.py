"""Guard rails for agent-issued target changes (enforced by the MCP tools, not by the HTTP API).

Humans using the CLI can still set anything 0..2000 W. Agents going through MCP get these limits.
Tune with environment variables (percent values are of the athlete's FTP):
  JUSTWATTS_MAX_CHANGE_PCT   largest change per command vs the step's current target (default 15)
  JUSTWATTS_MAX_PCT          absolute ceiling, unless the step is already planned higher (default 150)
  JUSTWATTS_FEEL_GATE_PCT    raising a step above this needs a recent FEEL HARDER/GOOD (default 105)
  JUSTWATTS_FEEL_WINDOW_S    how recent that feel signal must be, seconds (default 600)
  JUSTWATTS_STALE_S          refuse changes if the page state is older than this (default 15)
  JUSTWATTS_MANUAL_HOLD_S    after the athlete changes something by hand, wait this long (default 60)
"""
from __future__ import annotations

import os
import time
from dataclasses import dataclass, field


def _env(name: str, default: float) -> float:
    """JUSTWATTS_<X>, falling back to the old TC_<X> name."""
    v = os.environ.get(name) or os.environ.get(name.replace("JUSTWATTS_", "TC_", 1))
    try:
        return float(v) if v else default
    except ValueError:
        return default


@dataclass
class Limits:
    max_change_pct: float = field(default_factory=lambda: _env("JUSTWATTS_MAX_CHANGE_PCT", 15))
    max_pct: float = field(default_factory=lambda: _env("JUSTWATTS_MAX_PCT", 150))
    feel_gate_pct: float = field(default_factory=lambda: _env("JUSTWATTS_FEEL_GATE_PCT", 105))
    feel_window_s: float = field(default_factory=lambda: _env("JUSTWATTS_FEEL_WINDOW_S", 600))
    stale_s: float = field(default_factory=lambda: _env("JUSTWATTS_STALE_S", 15))
    max_insert_s: float = field(default_factory=lambda: _env("JUSTWATTS_MAX_INSERT_S", 1800))
    max_extend_s: float = field(default_factory=lambda: _env("JUSTWATTS_MAX_EXTEND_S", 600))
    manual_hold_s: float = field(default_factory=lambda: _env("JUSTWATTS_MANUAL_HOLD_S", 60))
    recovery_pct: float = 75


class GuardError(Exception):
    pass


def _clock_age(hhmmss: str | None, now: float | None = None) -> float | None:
    """Seconds since a local HH:MM:SS stamp from the event log (assumes within the last day)."""
    if not hhmmss:
        return None
    h, m, s = (int(x) for x in hhmmss.split(":"))
    lt = time.localtime(now)
    age = (lt.tm_hour * 3600 + lt.tm_min * 60 + lt.tm_sec) - (h * 3600 + m * 60 + s)
    return age + 86400 if age < 0 else age


def recent_feel(events: list[dict], window_s: float, now: float | None = None) -> str | None:
    """Latest FEEL value inside the window, considering only the current ride."""
    for ev in reversed(events):
        if ev["type"] in ("ride_start", "ride_end"):
            return None
        if ev["type"] == "feel":
            age = _clock_age(ev.get("time"), now)
            return ev["feel"] if age is not None and age <= window_s else None
    return None


def check_manual(ride: dict, lim: "Limits", step: int | None = None) -> None:
    """The athlete's own changes win: no agent change right after one, and none to a step they set by hand."""
    m = ride.get("manual")
    if m and (m.get("ago_s") or 0) < lim.manual_hold_s:
        wait = round(lim.manual_hold_s - (m.get("ago_s") or 0))
        raise GuardError(f"the athlete changed {m.get('what')} by hand {m.get('ago_s') or 0}s ago; their change wins. "
                         f"Ask before changing it (or wait {wait}s)")
    steps = ride.get("steps") or []
    if step is not None and 1 <= step <= len(steps) and steps[step - 1].get("manual"):
        raise GuardError(f"the athlete set step {step} by hand; ask before changing it")


def check_target(st: dict, age_s: float | None, events: list[dict], step: int | str, watts: int,
                 limits: Limits | None = None) -> dict:
    """Validate an agent's target change. Returns details; raises GuardError with a reason."""
    lim = limits or Limits()
    if st is None or age_s is None:
        raise GuardError("no ride state yet: is the app open and the ride loaded?")
    if age_s > lim.stale_s:
        raise GuardError(f"ride state is {age_s:.0f}s old: the page is not reporting, do not change targets blind")
    ride = st.get("ride")
    if not ride or ride.get("mode") != "workout" or not ride.get("steps"):
        raise GuardError("no structured workout running (free ride or nothing loaded)")
    if ride.get("test"):
        raise GuardError("this is an FTP test: targets are fixed, send messages only")
    cur = (ride.get("step") or {}).get("index")
    idx = cur if step == "cur" else int(step)
    if idx is None:
        raise GuardError("workout finished")
    steps = ride["steps"]
    if not 1 <= idx <= len(steps):
        raise GuardError(f"step {idx} out of range 1..{len(steps)}")
    if cur is not None and idx < cur:
        raise GuardError(f"step {idx} is already done (current step {cur})")
    check_manual(ride, lim, idx)
    s = steps[idx - 1]
    if s.get("free"):
        raise GuardError(f"step {idx} is a free-ride step with no ERG target")
    ftp = float(ride.get("ftp") or (st.get("athlete") or {}).get("ftp") or 0)
    if ftp <= 0:
        raise GuardError("FTP unknown")
    now_w = max(s.get("start_w") or 0, s.get("end_w") or 0)
    delta = watts - now_w
    info = {"step": idx, "from_w": now_w, "to_w": watts, "delta_w": delta, "ftp": ftp,
            "to_pct_ftp": round(watts / ftp * 100)}
    if delta > 0 and ride.get("paused"):
        raise GuardError("ride is paused: never raise targets while the athlete is stopped")
    if abs(delta) > lim.max_change_pct / 100 * ftp:
        raise GuardError(f"change of {delta:+d} W exceeds {lim.max_change_pct:g}% FTP "
                         f"({round(lim.max_change_pct / 100 * ftp)} W) per command; step it in smaller moves")
    ceiling = max(lim.max_pct / 100 * ftp, now_w)
    if watts > ceiling:
        raise GuardError(f"{watts} W is above the {lim.max_pct:g}% FTP ceiling ({round(ceiling)} W)")
    if delta > 0 and watts > lim.feel_gate_pct / 100 * ftp:
        feel = recent_feel(events, lim.feel_window_s)
        if feel not in ("harder", "good"):
            raise GuardError(f"raising above {lim.feel_gate_pct:g}% FTP needs a recent FEEL HARDER or GOOD "
                             f"from the athlete (last feel: {feel or 'none'}); ask them first")
        info["feel"] = feel
    return info


def _common(st, age_s, lim):
    if st is None or age_s is None:
        raise GuardError("no ride state yet: is the app open and the ride loaded?")
    if age_s > lim.stale_s:
        raise GuardError(f"ride state is {age_s:.0f}s old: the page is not reporting, do not edit blind")
    ride = st.get("ride")
    if not ride or ride.get("mode") != "workout" or not ride.get("steps"):
        raise GuardError("no structured workout running (free ride or nothing loaded)")
    if ride.get("test"):
        raise GuardError("this is an FTP test: the workout is fixed, send messages only")
    ftp = float(ride.get("ftp") or 0)
    if ftp <= 0:
        raise GuardError("FTP unknown")
    return ride, ftp


def _step_max_w(s: dict, ftp: float, k: float = 1) -> float:
    if s.get("free"):
        return 0
    x = max(s["a"], s["b"])
    return (x if s["u"] == "w" else x * ftp) * k


def check_edit(st: dict, age_s: float | None, events: list[dict], edit: dict, limits: Limits | None = None) -> dict:
    """Validate an agent's workout edit (insert/replace/delete/duration/extend). Raises GuardError."""
    from .workout import WorkoutError, parse_workout

    lim = limits or Limits()
    ride, ftp = _common(st, age_s, lim)
    steps = ride["steps"]
    cur = (ride.get("step") or {}).get("index")
    if cur is None:
        raise GuardError("workout finished")
    op = edit.get("op")
    ref = edit.get("after" if op == "insert" else "step", "cur")
    idx = cur if ref in ("cur", None) or op in ("total", "extend") else int(ref)
    if not 1 <= idx <= len(steps):
        raise GuardError(f"step {idx} out of range 1..{len(steps)}")
    if idx < cur:
        raise GuardError(f"step {idx} is already done (current step {cur})")
    k = ride.get("intensity") or 1
    check_manual(ride, lim, idx if op in ("replace", "delete", "duration") else None)
    info = {"op": op, "step": idx}
    harder = False

    def step_w(s):  # resolved watts of an existing step from state
        return max(s.get("start_w") or 0, s.get("end_w") or 0)

    if op in ("insert", "replace"):
        try:
            new = parse_workout(edit.get("steps", ""))
        except WorkoutError as e:
            raise GuardError(f"bad steps: {e}") from None
        added = sum(s["d"] for s in new)
        if op == "replace":
            added -= steps[idx - 1]["duration_s"]
        if added > lim.max_insert_s:
            raise GuardError(f"adds {added // 60} min; more than {lim.max_insert_s / 60:g} min per edit")
        top = max([_step_max_w(s, ftp, k) for s in new] + [0])
        ceiling = lim.max_pct / 100 * ftp
        if top > ceiling:
            raise GuardError(f"a new step reaches {round(top)} W, above the {lim.max_pct:g}% FTP ceiling ({round(ceiling)} W)")
        old_top = step_w(steps[idx - 1]) if op == "replace" else 0
        harder = top > lim.feel_gate_pct / 100 * ftp and top > old_top
        if op == "replace" and steps[idx - 1].get("free") is False and top > old_top:
            harder = harder or top - old_top > lim.max_change_pct / 100 * ftp
        info.update(added_s=added, max_w=round(top), steps=len(new))
    elif op == "delete":
        s = steps[idx - 1]
        info["deleted_w"] = step_w(s)
        # removing a recovery makes the session harder
        harder = not s.get("free") and step_w(s) <= lim.recovery_pct / 100 * ftp
    elif op == "total":
        delta = int(edit["seconds"]) - int(ride.get("total_s") or 0)
        if delta > lim.max_insert_s:
            raise GuardError(f"adds {delta // 60} min; more than {lim.max_insert_s / 60:g} min per edit")
        last = steps[-1]
        harder = delta > 0 and step_w(last) > lim.feel_gate_pct / 100 * ftp
        info.update(delta_s=delta, last_w=step_w(last))
    elif op in ("duration", "extend"):
        s = steps[idx - 1] if op == "duration" else steps[cur - 1]
        delta = (int(edit["seconds"]) - s["duration_s"]) if op == "duration" else int(edit["seconds"])
        if delta > lim.max_extend_s:
            raise GuardError(f"lengthens a step by {delta}s; max {lim.max_extend_s:g}s per edit")
        w = step_w(s)
        is_recovery = not s.get("free") and w <= lim.recovery_pct / 100 * ftp
        harder = (delta > 0 and w > lim.feel_gate_pct / 100 * ftp) or (delta < 0 and is_recovery)
        info.update(delta_s=delta, step_w=w)
    else:
        raise GuardError("op must be insert, replace, delete, duration, extend or total")
    if harder:
        if ride.get("paused"):
            raise GuardError("ride is paused: never make the workout harder while the athlete is stopped")
        feel = recent_feel(events, lim.feel_window_s)
        if feel not in ("harder", "good"):
            raise GuardError("this edit makes the workout harder (more hard time, more watts, or less recovery); "
                             f"it needs a recent FEEL HARDER or GOOD (last feel: {feel or 'none'}). Ask first.")
        info["feel"] = feel
    info["harder"] = harder
    return info
