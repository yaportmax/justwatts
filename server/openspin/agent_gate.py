"""Cut LLM usage: an event gate that decides what is worth waking the coach agent for, and a local
rule-based coach that handles routine cues without any agent.

AgentGate turns the full event firehose (a line every 30 s, every transcript, every step) into a
short agent stream: step summaries, FEEL presses, voice transcripts, alerts computed from the live
state, and at most one status line per few minutes in steady riding. Events arriving within a few
seconds are coalesced into one batch, and one batch is one agent wake. Agents read it with
GET /api/agent-events?since=N&wait=60 (long poll), the MCP tool wait_for_events, or
`openspin tail --agent`.

LocalCoach speaks routine cues itself (interval start and countdown, cadence nags, rep recaps,
recovery HR) through the normal coach message path, so the athlete hears them without the agent
being woken.
"""
from __future__ import annotations

import threading
import time
from collections import deque
from typing import Any, Callable

from .events import fmt_t, parse_line

GATE_DEFAULTS = {
    "coalesce_s": 5,          # events within this window become one batch (one wake)
    "status_every_s": 180,    # at most one periodic status per this many seconds of quiet riding
    "power_dev": 0.08,        # ERG power off target by more than this fraction...
    "power_dev_s": 15,        # ...for this long raises an alert
    "cadence_low_s": 20,      # cadence under the athlete's range for this long raises an alert
    "hr_cap": None,           # bpm; default 95 % of max HR, else the Z5 floor
}
LOCAL_DEFAULTS = {"enabled": True, "countdown": True, "cadence": True, "recap": True, "recovery": True,
                  # target changes from FEEL presses and the HR cap: "no_agent" (default), "always", "off"
                  "auto_adjust": "no_agent", "easier_pct": 5, "harder_pct": 3, "hr_cap_pct": 5}

PASS_TYPES = {"step_start", "step_end", "feel", "said", "paused", "resumed", "ride_start", "ride_end",
              "ride_resumed", "workout_done", "edit"}


class AgentGate:
    def __init__(self, settings: Callable[[], dict], clock: Callable[[], float] = time.time,
                 on_wake: Callable[[dict], None] | None = None):
        self.settings = settings
        self.clock = clock
        self.on_wake = on_wake
        self.lock = threading.Condition()
        self.batches: deque = deque(maxlen=500)
        self.seq = 0
        self.pending: list[dict] = []
        self.first_pending: float | None = None
        self.last_emit = 0.0
        self.last_status = 0.0
        self.suppress_edits = 0  # edits the agent made itself (it already knows)
        self.seen = 0            # every event line offered to the gate
        self.ride_wakes = 0
        self.delivered = 0       # highest batch seq handed to an agent
        self.agent_seen: float | None = None
        self._a: dict[str, Any] = {}  # alert trackers

    def cfg(self) -> dict:
        return {**GATE_DEFAULTS, **(self.settings().get("agentGate") or {})}

    # ---------- inputs ----------
    def on_event(self, line: str, now: float | None = None) -> None:
        now = self.clock() if now is None else now
        ev = parse_line(line)
        with self.lock:
            self.seen += 1
            t = ev["type"]
            if t == "ride_start":
                self.ride_wakes = 0
                self._a = {}
            if t == "edit" and self.suppress_edits > 0:
                self.suppress_edits -= 1
                return
            if t not in PASS_TYPES:
                return  # 30 s ticks, coach commands and local cues, voice on/off, Garmin, other
            data = {k: v for k, v in ev.items() if k not in ("raw", "text", "time")}
            self._add(t, ev["text"], data, now)

    def observe(self, st: dict, now: float | None = None) -> None:
        """Called once a second with the live state: computes alerts, periodic status, flushes."""
        now = self.clock() if now is None else now
        c = self.cfg()
        with self.lock:
            self._devices(st, now)
            ride = st.get("ride")
            riding = bool(ride and ride.get("started") and not ride.get("paused"))
            if riding:
                self._alerts(st, ride, c, now)
                quiet = now - max(self.last_emit, self.last_status, self._a.get("ride_t0", now)) >= c["status_every_s"]
                if quiet and not self.pending:
                    self._add("status", self._status_text(st, ride), {"elapsed_s": ride.get("elapsed_s")}, now)
                    self.last_status = now
            elif not ride:
                self._a.pop("ride_t0", None)
            if riding:
                self._a.setdefault("ride_t0", now)
            self._flush(now, c)

    # ---------- alerts ----------
    def _devices(self, st: dict, now: float) -> None:
        d = st.get("devices") or {}
        mode, hr = d.get("trainer"), bool(d.get("hr_connected") or d.get("hr"))
        pm, ph = self._a.get("dev_mode"), self._a.get("dev_hr")
        if pm == "ble" and mode in ("wait", "none"):
            self._add("alert", "Trainer disconnected (server is reconnecting)", {"alert": "trainer_lost"}, now)
        elif pm == "wait" and mode == "ble":
            self._add("alert", "Trainer reconnected", {"alert": "trainer_back"}, now)
        if ph and not hr and d.get("hr_name"):
            self._add("alert", "HR strap lost", {"alert": "hr_lost"}, now)
        self._a["dev_mode"], self._a["dev_hr"] = mode, hr

    def _alerts(self, st: dict, ride: dict, c: dict, now: float) -> None:
        a, live, ath = self._a, st.get("live") or {}, st.get("athlete") or {}
        hr = live.get("hr") or 0
        floors, hmax = ath.get("hr_zones"), ath.get("hr_max")
        cap = c["hr_cap"] or (round(hmax * 0.95) if hmax else (floors[4] if floors else None))
        if cap and hr:
            if hr >= cap and not a.get("hr_cap"):
                a["hr_cap"] = True
                self._add("alert", f"HR {hr} at or over cap {cap}", {"alert": "hr_cap", "hr": hr, "cap": cap}, now)
            elif hr <= cap - 5:
                a["hr_cap"] = False
        if floors and hr:
            z = sum(1 for f in floors if hr >= f) - 1
            hist = a.setdefault("hr_z", deque(maxlen=60))
            hist.append((now, z))
            lo = min(zz for t, zz in hist if now - t <= 60)
            if z - lo >= 2 and not a.get("zone_jump"):
                a["zone_jump"] = True
                self._add("alert", f"HR zone jump to Z{z + 1} (HR {hr}) within a minute",
                          {"alert": "zone_jump", "zone": z + 1, "hr": hr}, now)
            elif z - lo < 1:
                a["zone_jump"] = False
        lo_cad = (ath.get("cadence_range") or [85, 95])[0]
        cad = live.get("cadence") or 0
        if 0 < cad < lo_cad:
            a.setdefault("cad_low_since", now)
            if now - a["cad_low_since"] >= c["cadence_low_s"] and not a.get("cad_alerted"):
                a["cad_alerted"] = True
                self._add("alert", f"Cadence {cad} under {lo_cad} for {c['cadence_low_s']}s",
                          {"alert": "cadence_low", "cadence": cad}, now)
        else:
            a.pop("cad_low_since", None)
            if cad >= lo_cad:
                a["cad_alerted"] = False
        tgt, p3 = ride.get("target_w"), live.get("power_3s")
        step = ride.get("step") or {}
        if tgt and p3 is not None and ride.get("mode") == "workout" and (step.get("into_s") or 0) >= 10:
            dev = (p3 - tgt) / tgt
            if abs(dev) > c["power_dev"]:
                a.setdefault("pdev_since", now)
                if now - a["pdev_since"] >= c["power_dev_s"] and not a.get("pdev_alerted"):
                    a["pdev_alerted"] = True
                    self._add("alert", f"Power {p3} W vs target {tgt} ({dev:+.0%}) for {c['power_dev_s']}s",
                              {"alert": "power_dev", "power": p3, "target": tgt}, now)
            else:
                a.pop("pdev_since", None)
                if abs(dev) <= c["power_dev"] / 2:
                    a["pdev_alerted"] = False
        else:
            a.pop("pdev_since", None)

    def _status_text(self, st: dict, ride: dict) -> str:
        live, step, l30 = st.get("live") or {}, ride.get("step") or {}, ride.get("last30") or {}
        where = f"step {step['index']}/{step['count']}, {fmt_t(step['left_s'])} left" if step else ride.get("mode", "")
        return (f"T+{fmt_t(ride.get('elapsed_s') or 0)} {where} | tgt {ride.get('target_w') or '-'} | "
                f"30s {l30.get('power', '-')}W | HR {live.get('hr') or '-'} ({l30.get('hr_delta') if l30.get('hr_delta') is not None else '?'}/30s) | "
                f"cad {l30.get('cadence', '-')}")

    # ---------- batching ----------
    def _add(self, kind: str, text: str, data: dict, now: float) -> None:
        if not self.pending:
            self.first_pending = now
        self.pending.append({"ts": round(now, 1), "kind": kind, "text": text, "data": data})

    def _flush(self, now: float, c: dict | None = None, force: bool = False) -> None:
        c = c or self.cfg()
        if not self.pending or (not force and now - (self.first_pending or now) < c["coalesce_s"]):
            return
        self.seq += 1
        b = {"seq": self.seq, "ts": round(now, 1), "events": self.pending}
        self.batches.append(b)
        self.pending, self.first_pending = [], None
        self.last_emit = now
        self.lock.notify_all()

    def flush(self, now: float | None = None) -> None:
        with self.lock:
            self._flush(self.clock() if now is None else now, force=True)

    def tick(self, now: float | None = None) -> None:
        """Flush coalesced events when nothing calls observe() (no ride running)."""
        with self.lock:
            self._flush(self.clock() if now is None else now)

    # ---------- output ----------
    def since(self, seq: int, wait: float = 0) -> dict:
        deadline = time.monotonic() + max(0.0, min(wait, 120))
        with self.lock:
            while True:
                self.agent_seen = time.time()  # server.mark_agent() also tags the current ride
                got = [b for b in self.batches if b["seq"] > seq]
                left = deadline - time.monotonic()
                if got or left <= 0:
                    new = [b for b in got if b["seq"] > self.delivered]
                    if new:  # only batches an agent really received count as wakes
                        self.delivered = max(b["seq"] for b in new)
                        self.ride_wakes += len(new)
                        if self.on_wake:
                            for b in new:
                                self.on_wake(b)
                    return {"batches": got, "next": self.seq, "ride_wakes": self.ride_wakes, "seen": self.seen}
                self.lock.wait(min(left, 5))


class LocalCoach:
    """Routine cues spoken without the agent. Settings: localCoach {enabled, countdown, cadence, recap, recovery}."""

    def __init__(self, settings: Callable[[], dict], say: Callable[[str, bool], None],
                 clock: Callable[[], float] = time.time, adjust: Callable[[int, int, str], None] | None = None,
                 agent_connected: Callable[[], bool] = lambda: False):
        self.settings = settings
        self.say = say
        self.adjust = adjust
        self.agent_connected = agent_connected
        self.last_st: dict | None = None
        self.hr_over_since: float | None = None
        self.hr_adjusted_steps: set = set()
        self.clock = clock
        self.lock = threading.RLock()  # cues re-enter through the event log
        self.ftp = 200
        self.countdown_done: set = set()
        self.cad_low_since: float | None = None
        self.last_cad_nag = -1e9
        self.last_work_hr: int | None = None
        self.cues = 0

    def cfg(self) -> dict:
        return {**LOCAL_DEFAULTS, **(self.settings().get("localCoach") or {})}

    def _say(self, text: str, important: bool = False) -> None:
        self.cues += 1
        self.say(text, important)

    def on_event(self, line: str) -> None:
        c = self.cfg()
        if not c["enabled"]:
            return
        ev = parse_line(line)
        t = ev["type"]
        with self.lock:
            if t == "ride_start":
                self.ftp = ev.get("ftp") or self.ftp
                self.countdown_done.clear()
                self.last_work_hr = None
            elif t == "feel":
                self._feel(ev["feel"], c)
            elif t == "step_start" and c["countdown"] and ev.get("target_w"):
                self._say(f"{_spoken_dur(ev['duration_s'])} at {ev['target_w']} watts")
            elif t == "step_end" and ev.get("target_w"):
                rel = ev["target_w"] / (self.ftp or 200)
                if rel >= 0.88:
                    self.last_work_hr = ev.get("hr_end")
                    if c["recap"]:
                        hr = f", heart rate {ev['hr_max']} max" if ev.get("hr_max") else ""
                        self._say(f"Rep done. {ev['avg_w']} average{hr}.")
                elif rel < 0.7 and c["recovery"] and self.last_work_hr and ev.get("hr_end"):
                    drop = self.last_work_hr - ev["hr_end"]
                    self._say(f"Recovery heart rate {ev['hr_end']}, down {drop}.")
                    self.last_work_hr = None

    # ---------- safe automatic target changes ----------
    def _may_adjust(self, c: dict) -> bool:
        mode = c.get("auto_adjust", "no_agent")
        return bool(self.adjust) and (mode == "always" or (mode == "no_agent" and not self.agent_connected()))

    def _current(self):
        st = self.last_st or {}
        ride = st.get("ride") or {}
        step = ride.get("step")
        if not ride.get("started") or not step or step.get("free") or not ride.get("target_w") or ride.get("test"):
            return None
        return st, ride, step

    def _feel(self, feel: str, c: dict) -> None:
        cur = self._current()
        if not cur or not self._may_adjust(c) or feel == "good":
            return
        st, ride, step = cur
        ftp, tgt = ride.get("ftp") or self.ftp, ride["target_w"]
        if feel == "easier":
            new = max(round(0.3 * ftp), round((tgt - c["easier_pct"] / 100 * ftp) / 5) * 5)
            self.adjust(step["index"], new, f"Easier: {new} watts.")
        elif feel == "harder":
            floors = (st.get("athlete") or {}).get("hr_zones")
            hr = (st.get("live") or {}).get("hr") or 0
            if floors and hr >= floors[4]:
                self._say("Heart rate is in zone 5. Holding the target.")
                return
            new = min(round(1.5 * ftp), round((tgt + c["harder_pct"] / 100 * ftp) / 5) * 5)
            if ride.get("paused") or new <= tgt:
                return
            self.adjust(step["index"], new, f"Harder: {new} watts.")

    def _hr_guard(self, st: dict, c: dict, now: float) -> None:
        cur = self._current()
        ath, live = st.get("athlete") or {}, st.get("live") or {}
        hmax, floors, hr = ath.get("hr_max"), ath.get("hr_zones"), live.get("hr") or 0
        cap = round(hmax * 0.95) if hmax else (floors[4] if floors else None)
        if not cur or not cap or not self._may_adjust(c) or hr < cap:
            self.hr_over_since = None
            return
        _, ride, step = cur
        self.hr_over_since = self.hr_over_since or now
        if now - self.hr_over_since >= 30 and step["index"] not in self.hr_adjusted_steps:
            self.hr_adjusted_steps.add(step["index"])
            ftp, tgt = ride.get("ftp") or self.ftp, ride["target_w"]
            new = max(round(0.3 * ftp), round((tgt - c["hr_cap_pct"] / 100 * ftp) / 5) * 5)
            self.adjust(step["index"], new, f"Heart rate {hr}. Easing to {new} watts.")

    def observe(self, st: dict) -> None:
        c = self.cfg()
        self.last_st = st
        if not c["enabled"]:
            return
        if st.get("ride"):
            # ride time, not wall time: pauses do not count and tests can run fast
            self._hr_guard(st, c, float(st["ride"].get("elapsed_s") or 0))
        ride = st.get("ride")
        if not ride or not ride.get("started") or ride.get("paused"):
            self.cad_low_since = None
            return
        now = self.clock()
        with self.lock:
            self.ftp = ride.get("ftp") or self.ftp
            step = ride.get("step")
            steps = ride.get("steps") or []
            if c["countdown"] and step and step["index"] < step["count"] and step["left_s"] == 10 and step["index"] not in self.countdown_done:
                nxt = steps[step["index"]] if step["index"] < len(steps) else None
                if nxt and step["duration_s"] >= 30:
                    self.countdown_done.add(step["index"])
                    what = "free ride" if nxt["free"] else f"{nxt['start_w']} watts"
                    self._say(f"10 seconds. Then {what}.")
            lo = (st.get("athlete") or {}).get("cadence_range", [85, 95])[0]
            cad = (st.get("live") or {}).get("cadence") or 0
            if c["cadence"] and 0 < cad < lo:
                self.cad_low_since = self.cad_low_since or now
                if now - self.cad_low_since >= 20 and now - self.last_cad_nag >= 120:
                    self.last_cad_nag = now
                    self._say(f"Cadence {cad}. Spin up.")
            else:
                self.cad_low_since = None


def _spoken_dur(s: int) -> str:
    m, x = divmod(int(s), 60)
    if m and x:
        return f"{m} minute{'s' * (m != 1)} {x} seconds"
    if m:
        return f"{m} minute{'s' * (m != 1)}"
    return f"{x} seconds"
