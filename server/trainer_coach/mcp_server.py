"""MCP server (stdio) that lets an agent read the ride and coach it through the local HTTP API.

Run: `trainer-coach mcp` (needs the [mcp] extra). It talks to http://127.0.0.1:$HW_PORT using
the token in $HW_DATA/token, so point it at the same HW_PORT/HW_DATA as `trainer-coach serve`.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

try:  # mcp >= 2
    from mcp.server.mcpserver import MCPServer
    from mcp.server.mcpserver.exceptions import ToolError
except ImportError:  # mcp 1.x
    from mcp.server.fastmcp import FastMCP as MCPServer  # type: ignore[no-redef]
    from mcp.server.fastmcp.exceptions import ToolError  # type: ignore[no-redef]

from .client import ClientError, CoachClient
from .safety import GuardError, Limits, check_edit, check_target

INSTRUCTIONS = """\
You are coaching a live indoor bike workout on a smart trainer. Poll get_ride_status about every
30 s (more often near interval changes). Read docs/COACHING.md via get_coaching_playbook before
the first change. Messages: short, numbers first (e.g. "HR 168, +6/30s. Holding 250."). Change
targets in small steps, never raise while paused, back off on FEEL EASIER, HR drift or cadence
collapse. FEEL buttons are requests from the athlete: EASIER = less, HARDER = more, GOOD = keep.
athlete_said holds what the athlete said aloud; treat it like a FEEL press and answer briefly.
The workout can be edited mid-ride: insert_steps, replace_step, delete_step, set_step_duration,
extend_current_step. Prefer a real edit (add a rep, lengthen a recovery) over target tricks.
"""

mcp = MCPServer("trainer-coach", instructions=INSTRUCTIONS)
_client: CoachClient | None = None


def client() -> CoachClient:
    global _client
    if _client is None:
        _client = CoachClient()
    return _client


def set_client(c: CoachClient | None) -> None:
    """Point the tools at a specific server (tests)."""
    global _client
    _client = c


def _call(fn, *a, **kw):
    try:
        return fn(*a, **kw)
    except ClientError as e:
        raise ToolError(str(e)) from None


def _state() -> tuple[dict | None, float | None]:
    r = _call(client().state)
    return r.get("state"), r.get("age_s")


def _step_brief(s: dict | None) -> dict | None:
    if not s:
        return None
    return {k: s.get(k) for k in ("index", "duration_s", "free", "start_w", "end_w", "override_w")}


@mcp.tool()
def get_ride_status(telemetry_lines: int = 6) -> dict[str, Any]:
    """Current ride snapshot: live power/cadence/HR, current and next step with targets, pause state,
    the last 30 s averages, the last few 30 s telemetry lines and step summaries (parsed), the
    latest athlete FEEL signal and what the athlete said out loud (voice transcripts, newest last). `connected` is false when the page has not reported for 10 s."""
    st, age = _state()
    evs = _call(client().events, 200)
    tele = [e for e in evs if e["type"] in ("tick", "step_end")][-max(0, telemetry_lines):]
    feel = next((e for e in reversed(evs) if e["type"] == "feel"), None)
    said = [{"time": e["time"], "text": e["said"]} for e in evs if e["type"] == "said"][-3:]
    out: dict[str, Any] = {"connected": age is not None and age < 10, "state_age_s": age,
                           "recent_telemetry": tele, "last_feel": feel, "athlete_said": said}
    if not st:
        out["note"] = "the app has not reported any state yet"
        return out
    out["live"] = st.get("live")
    out["devices"] = st.get("devices")
    ride = st.get("ride")
    if ride:
        r = {k: v for k, v in ride.items() if k != "steps"}
        steps = ride.get("steps") or []
        cur = (ride.get("step") or {}).get("index")
        if cur:
            r["current_step"] = _step_brief(steps[cur - 1]) | (ride.get("step") or {})
            r["next_step"] = _step_brief(steps[cur]) if cur < len(steps) else None
        out["ride"] = r
    else:
        out["ride"] = None
    return out


@mcp.tool()
def get_recent_events(n: int = 30) -> list[dict[str, Any]]:
    """Last n event-log lines, parsed. Types: tick (30 s telemetry), step_start, step_end, feel,
    ride_start, ride_resumed, ride_end, paused, resumed, coach (commands already sent), other.
    Each item keeps `raw` (the original line) and `time` (server local HH:MM:SS)."""
    return _call(client().events, max(1, min(500, n)))


@mcp.tool()
def get_workout() -> dict[str, Any]:
    """All workout steps with resolved watts (start_w/end_w after the athlete's intensity %),
    the plan (a/b as FTP fraction when unit is %, or watts), coach overrides, and which step is
    current. Step numbers are 1-based, the same numbers set_step_target takes."""
    st, age = _state()
    ride = (st or {}).get("ride")
    if not ride or not ride.get("steps"):
        return {"workout": None, "note": "no structured workout loaded", "state_age_s": age}
    return {"name": ride.get("name"), "ftp": ride.get("ftp"), "intensity": ride.get("intensity"),
            "total_s": ride.get("total_s"), "elapsed_s": ride.get("elapsed_s"),
            "current_step": (ride.get("step") or {}).get("index"), "steps": ride["steps"], "state_age_s": age}


@mcp.tool()
def get_telemetry_history(seconds: int = 300) -> list[dict[str, Any]]:
    """State snapshots (about one per 3 s) for the last `seconds`: elapsed, step, target, power,
    3 s power, cadence, HR, paused. Use it to look at trends (HR drift, cadence fade)."""
    return _call(client().history, max(10, min(3600, seconds)))


@mcp.tool()
def get_athlete_profile() -> dict[str, Any]:
    """FTP, weight, HR zone floors (lower bpm of Z1..Z5) and max HR, as set in the app."""
    st, age = _state()
    if not st:
        raise ToolError("the app has not reported any state yet")
    return {**(st.get("athlete") or {}), "state_age_s": age}


def _set(step: int | str, watts: int, message: str | None) -> dict[str, Any]:
    st, age = _state()
    evs = _call(client().events, 300)
    try:
        info = check_target(st, age, evs, step, int(watts), Limits())
    except GuardError as e:
        raise ToolError(f"refused: {e}") from None
    # Always send the resolved step number: if the step ends before the page polls (2 s), the
    # change lands on the step that was checked, never silently on the next one.
    cmd = _call(client().coach, msg=message, step=info["step"], watts=int(watts))
    return {"sent": cmd, "check": info}


@mcp.tool()
def set_step_target(step: int, watts: int, message: str | None = None) -> dict[str, Any]:
    """Override the ERG target of a 1-based workout step (current or upcoming) to `watts`, with an
    optional on-screen message. Guard rails apply (max change per command, ceiling, no raises while
    paused, feel signal needed above threshold); a refusal explains why."""
    return _set(int(step), watts, message)


@mcp.tool()
def set_current_target(watts: int, message: str | None = None) -> dict[str, Any]:
    """Override the ERG target of the step being ridden right now. Same guard rails as set_step_target."""
    return _set("cur", watts, message)


def _edit(edit: dict, message: str | None) -> dict[str, Any]:
    st, age = _state()
    evs = _call(client().events, 300)
    try:
        info = check_edit(st, age, evs, edit, Limits())
    except GuardError as e:
        raise ToolError(f"refused: {e}") from None
    # resolve "cur" to the checked step number so a step change in between cannot retarget the edit
    key = "after" if edit["op"] == "insert" else "step"
    if edit.get(key, "cur") == "cur" and edit["op"] != "extend":
        edit = {**edit, key: info["step"]}
    cmd = _call(client().coach, msg=message, edit=edit)
    return {"sent": {k: v for k, v in cmd.items() if k != "result"}, "result": cmd.get("result"), "check": info}


@mcp.tool()
def insert_steps(steps: str, after_step: int | None = None, message: str | None = None) -> dict[str, Any]:
    """Insert workout steps mid-ride. `steps` uses the workout text format, any count and nesting:
    "2x(5m 250w, 3m 50%)", "10m 88%", "1m30s 120%, 2m free". Inserted after `after_step`
    (1-based; default: after the current step). The timeline, chart and later step numbers update.
    Guard rails: max 30 min added per edit, FTP ceiling, hard additions need a FEEL HARDER/GOOD."""
    return _edit({"op": "insert", "steps": steps, "after": after_step or "cur"}, message)


@mcp.tool()
def replace_step(step: int, steps: str, message: str | None = None) -> dict[str, Any]:
    """Replace one step (current or upcoming) with new steps in workout text format. Replacing the
    current step keeps what was already ridden and starts the replacement now. Use it to change a
    step's target and duration together, or split a block into reps."""
    return _edit({"op": "replace", "step": step, "steps": steps}, message)


@mcp.tool()
def delete_step(step: int, message: str | None = None) -> dict[str, Any]:
    """Remove an upcoming step. Deleting the current step ends it now (the next step starts).
    Removing a recovery step counts as making the workout harder (needs a feel signal)."""
    return _edit({"op": "delete", "step": step}, message)


@mcp.tool()
def set_step_duration(step: int, seconds: int, message: str | None = None) -> dict[str, Any]:
    """Set the duration of the current or an upcoming step, in seconds. The current step cannot be
    shortened below what was already ridden (it then ends now)."""
    return _edit({"op": "duration", "step": step, "seconds": seconds}, message)


@mcp.tool()
def extend_current_step(seconds: int, message: str | None = None) -> dict[str, Any]:
    """Lengthen (positive) or shorten (negative) the step being ridden, in seconds."""
    return _edit({"op": "extend", "seconds": seconds}, message)


@mcp.tool()
def set_workout_length(total_seconds: int, how: str = "last", message: str | None = None) -> dict[str, Any]:
    """Change the total planned workout length. how="last" changes the last block (dropping trailing
    steps when shortening past them); how="scale" stretches or squeezes every remaining step."""
    return _edit({"op": "total", "seconds": int(total_seconds), "how": "scale" if how == "scale" else "last"}, message)


# ---------- everything the athlete can do in the UI ----------
def _control(action: str, **kw) -> dict[str, Any]:
    return _call(client().request, "POST", "/api/ride/control", {"action": action, **kw})


@mcp.tool()
def load_workout(text: str | None = None, name: str = "Coach workout", test: bool = False,
                 end_current: bool = False) -> dict[str, Any]:
    """Load a workout (workout text format) or, with text=None, a free ride. Refuses to replace a ride
    in progress unless end_current=True (that ends and saves it). Then call ride_control("start")."""
    st, _ = _state()
    ride = (st or {}).get("ride")
    if ride and ride.get("started") and not end_current:
        raise ToolError("a ride is in progress; pass end_current=True to end and save it first")
    wk = {"name": name, "text": text, "test": test} if text else None
    if wk:
        from .workout import WorkoutError, parse_workout
        try:
            parse_workout(text)
        except WorkoutError as e:
            raise ToolError(f"bad workout text: {e}") from None
    return _control("load", workout=wk)


@mcp.tool()
def ride_control(action: str, confirm: bool = False) -> dict[str, Any]:
    """start | pause | resume | skip | save | end. "save" stores the ride so far in History without
    ending it. "end" finishes and saves the ride and needs confirm=True (ask the athlete first)."""
    m = {"start": "start", "pause": "hold", "resume": "resume", "skip": "skip", "save": "save", "end": "end"}
    if action not in m:
        raise ToolError(f"action must be one of {sorted(m)}")
    if action == "end" and not confirm:
        raise ToolError("ending the ride needs confirm=True; ask the athlete first")
    return _control(m[action])


@mcp.tool()
def set_intensity(percent: int) -> dict[str, Any]:
    """Scale every workout target (the athlete's +/- control), 50..150 %. Changes above the guard
    limits need the same care as target changes: at most +/-15 % at once, raises need a feel signal."""
    st, age = _state()
    ride = (st or {}).get("ride")
    if not ride:
        raise ToolError("no ride loaded")
    cur = round((ride.get("intensity") or 1) * 100)
    lim = Limits()
    if abs(percent - cur) > lim.max_change_pct:
        raise ToolError(f"refused: {percent - cur:+d} % at once exceeds {lim.max_change_pct:g} %")
    if percent > cur and percent > 100:
        from .safety import recent_feel
        feel = recent_feel(_call(client().events, 300), lim.feel_window_s)
        if feel not in ("harder", "good"):
            raise ToolError("refused: raising intensity above 100 % needs a recent FEEL HARDER or GOOD")
    return _control("intensity", percent=percent)


@mcp.tool()
def free_ride(mode: str, value: float) -> dict[str, Any]:
    """In a free ride (load_workout(None)): mode "grade" (sim slope %, -10..20), "erg" (watts) or
    "resistance" (FTMS level 0..25). ERG watts are capped at the FTP ceiling; grades above 8 % need
    a recent FEEL HARDER or GOOD."""
    m = {"grade": "g", "erg": "w", "resistance": "r"}.get(mode)
    if not m:
        raise ToolError("mode must be grade, erg or resistance")
    st, _ = _state()
    ftp = float(((st or {}).get("athlete") or {}).get("ftp") or 200)
    lim = Limits()
    if m == "w" and value > lim.max_pct / 100 * ftp:
        raise ToolError(f"refused: {value:g} W is above the {lim.max_pct:g}% FTP ceiling")
    if m == "g" and value > 8:
        from .safety import recent_feel
        if recent_feel(_call(client().events, 300), lim.feel_window_s) not in ("harder", "good"):
            raise ToolError("refused: grades above 8 % need a recent FEEL HARDER or GOOD")
    return _control("free", m=m, value=value)


@mcp.tool()
def set_voice_mode(mode: str) -> dict[str, Any]:
    """How much the coach speaks aloud: "all", "important" (only important messages) or "silent"
    (messages still show on screen). Respect the athlete: if they muted you, stay muted."""
    if mode not in ("all", "important", "silent"):
        raise ToolError("mode must be all, important or silent")
    return _call(client().request, "POST", "/api/settings", {"voiceMode": mode})["settings"]


@mcp.tool()
def update_settings(ftp: int | None = None, weight_kg: float | None = None, hr_zone_floors: list[int] | None = None,
                    hr_max: int | None = None, cadence_range: list[int] | None = None,
                    after_workout: str | None = None, beeps: bool | None = None) -> dict[str, Any]:
    """Athlete settings. hr_zone_floors = lower bpm of Z1..Z5 (5 rising numbers). after_workout:
    "hold" keeps the last target when the plan ends, "grade0" switches to a flat free ride."""
    body: dict[str, Any] = {}
    if ftp is not None:
        body["ftp"] = ftp
    if weight_kg is not None:
        body["weight"] = weight_kg
    if hr_zone_floors is not None:
        if len(hr_zone_floors) != 5 or any(b <= a for a, b in zip(hr_zone_floors, hr_zone_floors[1:])):
            raise ToolError("hr_zone_floors must be 5 rising numbers")
        body.update(hrZones=hr_zone_floors, hrZonesSrc="manual")
    if hr_max is not None:
        body["hrMax"] = hr_max
    if cadence_range is not None:
        body["cadRange"] = cadence_range[:2]
    if after_workout is not None:
        body["afterWorkout"] = after_workout
    if beeps is not None:
        body["beeps"] = beeps
    return _call(client().request, "POST", "/api/settings", body)["settings"]


@mcp.tool()
def devices(action: str = "status", kind: str = "trainer", address: str | None = None,
            name: str | None = None) -> Any:
    """Bluetooth devices owned by the server. action: status | scan | connect | disconnect | sim.
    kind: trainer | hr. scan returns [{address, name, rssi}]; connect needs an address from scan.
    sim toggles the simulated trainer (for testing without hardware)."""
    if action == "status":
        return _call(client().request, "GET", "/api/devices", auth=False)
    body = {"action": action, "kind": kind}
    if action == "connect":
        if not address:
            raise ToolError("connect needs an address (scan first)")
        body.update(address=address, name=name)
    return _call(client().request, "POST", "/api/devices", body)


@mcp.tool()
def list_rides(limit: int = 20) -> list[dict[str, Any]]:
    """Ride history, newest first: date, time, avg W, NP, IF, TSS, kJ, avg HR, best 1/5/20 min,
    Garmin upload status."""
    return _call(client().request, "GET", "/api/rides", auth=False)["rides"][:max(1, limit)]


@mcp.tool()
def get_ride_detail(ride_id: str) -> dict[str, Any]:
    """One ride: summary, best efforts, power and HR zone times, laps per interval (avg/max W, HR,
    cadence), FTP test estimate, the coach transcript, Garmin status."""
    return _call(client().request, "GET", f"/api/rides/{ride_id}/detail", auth=False)


@mcp.tool()
def get_trends(weeks: int = 12) -> dict[str, Any]:
    """Weekly TSS/time/kJ, FTP history and all-time best 1/5/20 min efforts."""
    return _call(client().request, "GET", f"/api/trends?weeks={int(weeks)}", auth=False)


@mcp.tool()
def upload_ride_to_garmin(ride_id: str) -> dict[str, Any]:
    """Upload an archived ride to Garmin Connect (only when Garmin is enabled on this server)."""
    return _call(client().request, "POST", f"/api/rides/{ride_id}/garmin", {})


@mcp.tool()
def send_message(text: str, important: bool = False) -> dict[str, Any]:
    """Show a short message on the athlete's screen (with a beep) and read it aloud unless the athlete
    muted the coach. With voice set to "important only", only important messages are spoken: use
    important=True for safety, interval changes and answers to the athlete. Messages sent with a
    target change or workout edit are always important. Under ~60 characters, numbers first."""
    if not text.strip():
        raise ToolError("empty message")
    return {"sent": _call(client().coach, msg=text, important=important)}


@mcp.tool()
def get_coaching_playbook() -> str:
    """The coaching playbook (docs/COACHING.md): how to read telemetry, when to adjust, message
    style and safety limits. Read it before the first change of a session."""
    here = Path(__file__).resolve().parent
    for p in (here / "COACHING.md", here.parent.parent / "docs" / "COACHING.md"):
        if p.exists():
            return p.read_text(encoding="utf-8")
    return INSTRUCTIONS


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
