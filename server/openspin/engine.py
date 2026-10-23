"""Server-side ride engine: a port of the page's ride loop so the ride survives page reloads.

One tick per second reads the device hub, records a sample, auto-pauses, writes the coach event
lines, applies ERG/grade targets and coach overrides. The ride in progress is written to
<data>/coach/engine.json (atomic) every 5 samples and after every control action, and is resumed
(paused, waiting for pedaling) when the server restarts.
"""
from __future__ import annotations

import json
import os
import math
import random
import re
import threading
import time
from pathlib import Path
from typing import Any, Callable

from . import events as E
from .devices import DeviceHub
from .workout import WorkoutError, compile_workout, parse_workout, step_at, step_watts, to_text

STALE_RESUME_S = 6 * 3600


def _mean(a):
    return sum(a) / len(a) if a else 0


class Ride:
    def __init__(self, name: str, text: str, test: bool, ftp: int):
        self.name, self.text, self.test, self.ftp = name, text, test, ftp
        self.steps: list[dict] | None = None
        self.total = 0
        if text:
            self.steps, self.total = compile_workout(text)
        self.el = 0.0
        self.started = False
        self.paused = False
        self.auto = False
        self.pp = False
        self.idle = 0
        self.k = 1.0
        self.samples: list[list] = []
        self.jr = {"m": "g", "g": 0.0, "w": round(ftp * 0.6), "r": 5.0}  # grade %, ERG watts, resistance level
        self.start_ts: int | None = None
        self.ov: dict[int, int] = {}
        self.last_step = -1
        self.acc: dict | None = None
        self.last_line = 0.0
        self.events: list[list] = []  # [epoch_ms, line] for this ride's transcript
        self.last_mono: float | None = None  # monotonic time of the last sample (None after a restart)
        self.overtime = False  # the plan ended; riding free until the athlete ends the ride
        self.agent_wakes = 0   # agent-stream batches during this ride (one batch = one agent turn)
        self.agent_seen = False  # an agent connected during this ride (shows the usage meter)
        self.local_cues = 0    # cues the local rule coach spoke instead of waking the agent
        self.usage: dict = {}  # token usage the agent reported for this ride

    @property
    def id(self) -> str:
        return f"r-{self.start_ts or 0}"

    def apply_override(self, idx: int, w: int) -> bool:
        if not self.steps or not 0 <= idx < len(self.steps) or self.steps[idx].get("free"):
            return False
        s = self.steps[idx]
        s["a"] = s["b"] = w
        s["u"] = "w"
        self.ov[idx] = w
        return True

    def retime(self) -> None:
        t = 0
        for s in self.steps or []:
            s["t0"] = t
            t += s["d"]
        self.total = t

    def plain_steps(self) -> list[dict] | None:
        if not self.steps:
            return None
        return [{k: v for k, v in s.items() if k != "t0"} for s in self.steps]

    def payload(self) -> dict:
        return {"id": self.id, "name": self.name, "text": self.text, "steps": self.plain_steps(), "test": self.test, "ftp": self.ftp,
                "events": self.events, "overtime": self.overtime,
                "agent": {"wakes": self.agent_wakes, "local_cues": self.local_cues, "usage": self.usage, "seen": self.agent_seen},
                "start": self.start_ts, "samples": self.samples, "el": self.el, "k": self.k, "jr": self.jr,
                "ov": {str(k): v for k, v in self.ov.items()}, "source": "server"}


class RideEngine:
    def __init__(self, hub: DeviceHub, data: Path, log_event: Callable[[str], None],
                 settings: Callable[[], dict], clock: Callable[[], float] = time.monotonic,
                 wall: Callable[[], float] = time.time):
        self.hub = hub
        self.data = Path(data)
        self.log_event = log_event
        self.settings = settings
        self.clock, self.wall = clock, wall
        self.lock = threading.RLock()
        self.changed = threading.Condition(self.lock)
        self.ride: Ride | None = None
        self.p_hist: list[float] = []
        self.messages: list[dict] = []  # newest last: {seq, msg, ts}
        self.last_finished: dict | None = None  # {id, name, samples, ts, saved}
        self.last_saved: dict | None = None
        self.on_finish: Callable[[dict], None] | None = None  # server hook (auto Garmin upload)
        self.notice: str | None = None
        self.version = 0
        self._last_tick = clock()
        self._jf = None
        self.sim_t = 0
        self.rng = random.Random()

    # ---------- paths ----------
    @property
    def current_file(self) -> Path:
        return self.data / "coach" / "engine.json"

    @property
    def journal_file(self) -> Path:
        """One JSON sample per line, appended every second; folded into engine.json on each snapshot."""
        return self.data / "coach" / "engine.journal"

    @property
    def rides_dir(self) -> Path:
        return self.data / "rides"

    def note(self, line: str) -> None:
        """Called for every event line: keep a per-ride transcript (archived with the ride)."""
        with self.lock:
            r = self.ride
            if r is not None and (r.started or line.startswith("RIDE START")):
                r.events.append([int(self.wall() * 1000), line])

    def count_agent(self, wakes: int = 0, cues: int = 0, usage: dict | None = None, total: bool = False) -> None:
        with self.lock:
            r = self.ride
            if r is None:
                return
            r.agent_wakes += wakes
            r.local_cues += cues
            if usage:
                for k, v in usage.items():
                    if isinstance(v, (int, float)) and not isinstance(v, bool):
                        r.usage[k] = v if total else round(r.usage.get(k, 0) + v, 6)
                r.usage["reports"] = r.usage.get("reports", 0) + 1

    def _bump(self):
        self.version += 1
        self.changed.notify_all()

    # ---------- persistence ----------
    def save(self) -> None:
        """Full snapshot (atomic), then start a fresh journal."""
        from .server import atomic_write
        r = self.ride
        if r and r.started and r.samples:
            atomic_write(self.current_file, json.dumps(r.payload()).encode("utf-8"))
            self._close_journal()
            self.journal_file.write_text("", encoding="utf-8")

    def _journal(self, sample: list) -> None:
        try:
            if self._jf is None:
                self.journal_file.parent.mkdir(parents=True, exist_ok=True)
                self._jf = self.journal_file.open("a", encoding="utf-8")
            self._jf.write(json.dumps(sample) + "\n")
            self._jf.flush()
            os.fsync(self._jf.fileno())  # each second is on disk before the next one is recorded
        except OSError:
            self._jf = None

    def _close_journal(self) -> None:
        if self._jf is not None:
            try:
                self._jf.close()
            except OSError:
                pass
            self._jf = None

    def clear_saved(self) -> None:
        self._close_journal()
        self.current_file.unlink(missing_ok=True)
        self.journal_file.unlink(missing_ok=True)

    def resume(self) -> bool:
        """Restore an unfinished ride from disk after a server restart."""
        try:
            cur = json.loads(self.current_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return False
        if not cur or not cur.get("samples"):
            return False
        with self.lock:
            if self.wall() * 1000 - cur["samples"][-1][0] > STALE_RESUME_S * 1000:
                cur["name"] += " (recovered)"
                self._archive(cur)
                self.clear_saved()
                self.notice = "Saved an old unfinished ride to History"
                return False
            r = Ride(cur["name"], cur.get("text") or "", bool(cur.get("test")), cur["ftp"])
            if cur.get("steps"):
                r.steps = [dict(x) for x in cur["steps"]]
                r.retime()
            for i, w in (cur.get("ov") or {}).items():
                r.apply_override(int(i), w)
            r.el = max(cur.get("el", 0), cur["samples"][-1][1])
            r.started, r.paused, r.auto, r.pp = True, True, True, True
            r.k = cur.get("k") or 1
            r.samples = cur["samples"]
            try:  # samples recorded after the last snapshot
                last_el = r.samples[-1][1]  # elapsed is strictly increasing while recording
                for ln in self.journal_file.read_text(encoding="utf-8").splitlines():
                    try:
                        x = json.loads(ln)
                    except ValueError:
                        continue  # a torn last line after a crash
                    if isinstance(x, list) and len(x) == 7 and x[1] > last_el:
                        r.samples.append(x)
                        last_el = x[1]
                if r.samples[-1][1] > r.el:
                    r.el = r.samples[-1][1]
            except OSError:
                pass
            r.jr = {**r.jr, **(cur.get("jr") or {})}
            r.start_ts = cur.get("start")
            r.events = cur.get("events") or []
            r.overtime = bool(cur.get("overtime"))
            ag = cur.get("agent") or {}
            r.agent_wakes, r.local_cues, r.usage = ag.get("wakes", 0), ag.get("local_cues", 0), ag.get("usage") or {}
            r.agent_seen = bool(ag.get("seen"))
            r.ov = {int(k): v for k, v in (cur.get("ov") or {}).items()}
            self.ride = r
            self.log_event(f"RIDE RESUMED after restart at T+{E.fmt_t(r.el)} ({len(r.samples)} samples kept)")
            self.notice = "Ride restored. Pedal to continue."
            self.apply_target()
            self._bump()
        return True

    def _archive(self, payload: dict) -> Path:
        from .server import atomic_write
        rid = re.sub(r"[^\w\-]+", "", str(payload.get("id", "ride"))) or "ride"
        dest = self.rides_dir / f"{rid}.json"
        atomic_write(dest, json.dumps(payload).encode("utf-8"))
        return dest

    # ---------- targets ----------
    def cur_target(self) -> int | None:
        r = self.ride
        if not r:
            return None
        if not r.steps:
            return r.jr["w"] if r.jr["m"] == "w" else None
        at = step_at(r.steps, r.el)
        if not at:
            if r.overtime and self.settings().get("afterWorkout", "hold") == "hold":
                last = r.steps[-1]
                return step_watts(last, last["d"], r.ftp, 1 if r.test else r.k)
            return None
        return step_watts(at[1], at[2], r.ftp, 1 if r.test else r.k)

    def apply_target(self) -> None:
        r = self.ride
        if not r:
            return
        if not r.steps:
            m = r.jr["m"]
            self.hub.want({"k": "erg", "w": r.jr["w"]} if m == "w" else {"k": "res", "r": r.jr["r"]} if m == "r"
                          else {"k": "sim", "g": r.jr["g"]})
            return
        t = self.cur_target()
        self.hub.want({"k": "sim", "g": 0} if t is None else {"k": "erg", "w": t})

    # ---------- controls (HTTP threads) ----------
    def control(self, action: str, body: dict) -> dict:
        with self.lock:
            fn = {"load": self.load, "start": self.start, "pause": self.toggle_pause, "skip": self.skip,
                  "end": self.finish, "adjust": self.adjust, "mode": self.set_mode, "feel": self.feel,
                  "dismiss": self.dismiss, "resume": self.resume_ride, "hold": self.hold,
                  "intensity": self.set_intensity, "free": self.set_free, "save": self.save_copy,
                  "edit": lambda b: self.edit(b.get("edit") or {})}.get(action)
            if not fn:
                raise ValueError(f"unknown action {action!r}")
            res = fn(body) or {}
            self.save()
            self._bump()
            return res

    def load(self, body: dict):
        w = body.get("workout")
        if self.ride and self.ride.started:
            self.finish({})
        ftp = int(self.settings().get("ftp") or 200)
        try:
            r = Ride(w["name"], w["text"], bool(w.get("test")), ftp) if w else Ride("Just ride", "", False, ftp)
        except ValueError as e:
            raise ValueError(str(e)) from None
        self.ride = r
        self.notice = None
        self.apply_target()
        return {"loaded": r.name}

    def start(self, body: dict | None = None):
        r = self.ride
        if not r or r.started:
            return
        r.started = True
        r.start_ts = int(self.wall() * 1000)
        r.pp = False
        self.messages = []  # the coach bar starts clean: no messages from the previous ride
        self.log_event(E.line_ride_start(r.name, r.ftp, len(r.steps) if r.steps else None, r.total if r.steps else None))
        if self.hub.mode == "ble" and not (self.hub.r.cadence > 0 or self.hub.r.power > 0):
            r.paused = r.auto = True

    def toggle_pause(self, body: dict | None = None):
        r = self.ride
        if not r:
            return
        if not r.started:
            return self.start()
        r.paused = not r.paused
        r.auto = False

    def hold(self, body: dict | None = None):
        """Pause (not a toggle)."""
        r = self.ride
        if r and r.started and not r.paused:
            r.paused, r.auto = True, False

    def resume_ride(self, body: dict | None = None):
        """Resume (not a toggle); starts the ride if it was only loaded."""
        r = self.ride
        if not r:
            return
        if not r.started:
            return self.start()
        r.paused = r.auto = False

    def set_intensity(self, body: dict):
        r = self.ride
        if not r:
            raise ValueError("no ride loaded")
        pct = float(body.get("percent", 100))
        if not 50 <= pct <= 150:
            raise ValueError("percent must be 50..150")
        r.k = round(pct / 100, 2)
        self.apply_target()

    def set_free(self, body: dict):
        """Free ride target: {m: g|w|r, value}: grade %, ERG watts or resistance level."""
        r = self.ride
        if not r or r.steps:
            raise ValueError("free-ride targets need a free ride (load with workout null)")
        m = body.get("m")
        if m not in ("g", "w", "r"):
            raise ValueError("m must be g (grade), w (ERG watts) or r (resistance level)")
        v = float(body["value"]) if body.get("value") is not None else r.jr[m]
        lim = {"g": (-10, 20), "w": (30, 1500), "r": (0, 25)}[m]
        if not lim[0] <= v <= lim[1]:
            raise ValueError(f"value out of range {lim[0]}..{lim[1]}")
        r.jr["m"] = m
        r.jr[m] = round(v) if m == "w" else round(v, 1)
        self.apply_target()

    def skip(self, body: dict | None = None):
        r = self.ride
        if not r or not r.steps:
            return
        at = step_at(r.steps, r.el)
        if at:
            r.el = at[1]["t0"] + at[1]["d"] + 0.01
            self.apply_target()

    def adjust(self, body: dict):
        r = self.ride
        if not r:
            return
        d = 1 if body.get("dir", 1) > 0 else -1
        if r.steps:
            r.k = max(0.5, min(1.5, round(r.k + d * 0.01, 2)))
        elif r.jr["m"] == "g":
            r.jr["g"] = max(-10, min(20, round(r.jr["g"] + d * 0.5, 1)))
        elif r.jr["m"] == "r":
            r.jr["r"] = max(0, min(25, round(r.jr.get("r", 5) + d * 0.5, 1)))
        else:
            r.jr["w"] = max(30, min(1500, r.jr["w"] + d * 5))
        self.apply_target()

    def set_mode(self, body: dict):
        r = self.ride
        if r and body.get("m") in ("g", "w", "r"):
            r.jr["m"] = body["m"]
            self.apply_target()

    def feel(self, body: dict):
        f = str(body.get("feel", "")).lower()
        if f not in ("easier", "good", "harder"):
            raise ValueError("feel must be easier, good or harder")
        r = self.ride
        l30 = r.samples[-30:] if r else []
        at = step_at(r.steps, r.el) if r and r.steps else None
        hr = self.hub.r.hr
        self.log_event(E.line_feel(f, at[0] + 1 if at else None, l30, hr))

    def save_copy(self, body: dict | None = None):
        """Save the ride so far to History without ending it (the final save overwrites it)."""
        r = self.ride
        if not r or not r.started or len(r.samples) < 10:
            raise ValueError("nothing to save yet")
        p = r.payload()
        self._archive(p)
        self.last_saved = {"id": p["id"], "samples": len(r.samples), "ts": int(self.wall() * 1000)}
        return {"saved": True, "id": p["id"], "samples": len(r.samples)}

    def dismiss(self, body: dict | None = None):
        self.notice = None

    def finish(self, body: dict | None = None):
        r = self.ride
        if not r:
            return
        if r.acc and r.acc["p"]:
            self.log_event(E.line_step_end(**r.acc))
            r.acc = None
        self.log_event(E.line_ride_end(r.el))
        self.ride = None
        self.hub.want({"k": "sim", "g": 0})
        self.clear_saved()
        if len(r.samples) < 10:
            self.notice = "Ride too short, not saved"
            self.last_finished = None
            return {"saved": False}
        p = r.payload()
        self._archive(p)
        self.last_finished = {"id": p["id"], "name": r.name, "samples": len(r.samples), "ts": int(self.wall() * 1000)}
        if self.on_finish:
            self.on_finish(p)
        return {"saved": True, "id": p["id"]}

    # ---------- workout edits (coach API) ----------
    def edit(self, e: dict) -> dict:
        """Insert, delete or retime steps of the running workout. Raises ValueError."""
        with self.lock:
            r = self.ride
            if not r or not r.steps:
                raise ValueError("no structured workout loaded on the server")
            at = step_at(r.steps, r.el)
            if not at and e.get("op") == "insert":
                # plan already ended: the time ridden since becomes a free step, new steps start now
                gap = math.ceil(r.el - r.total)
                if gap > 0:
                    r.steps.append({"d": gap, "free": True})
                    r.retime()
                r.overtime = False
                at = None
                cur = len(r.steps)
                e = {**e, "after": len(r.steps)}
                into = 0
            else:
                cur = at[0] if at else len(r.steps)
                into = at[2] if at else 0

            def index(v, name):
                if v == "cur" or v is None:
                    if not at:
                        raise ValueError("workout already finished")
                    return cur
                i = int(v) - 1
                if not 0 <= i < len(r.steps):
                    raise ValueError(f"{name} {v} out of range 1..{len(r.steps)}")
                if i < cur and not (name == "after step" and i == cur - 1 and at is None):
                    raise ValueError(f"{name} {v} is already done (current step {cur + 1})")
                return i

            op = e.get("op")
            if op == "insert":
                try:
                    new = parse_workout(str(e.get("steps", "")))
                except WorkoutError as err:
                    raise ValueError(f"bad steps: {err}") from None
                after = index(e.get("after", "cur"), "after step")
                pos = after + 1
                r.steps[pos:pos] = new
                r.ov = {(k + len(new) if k >= pos else k): v for k, v in r.ov.items()}
                desc = f"insert {len(new)} after step {after + 1}: {to_text(new)}"
            elif op == "replace":
                i = index(e.get("step", "cur"), "step")
                try:
                    new = parse_workout(str(e.get("steps", "")))
                except WorkoutError as err:
                    raise ValueError(f"bad steps: {err}") from None
                if i == cur and into >= 1:  # keep what was ridden of the current step, the replacement starts now
                    r.steps[i]["d"] = max(1, math.ceil(into))
                    r.steps[i + 1:i + 1] = new
                    r.ov = {(k + len(new) if k > i else k): v for k, v in r.ov.items()}
                else:  # an upcoming step, or the current one before anything of it was ridden
                    if i == cur:
                        r.acc, r.last_step = None, -1
                    r.steps[i:i + 1] = new
                    r.ov = {(k + len(new) - 1 if k > i else k): v for k, v in r.ov.items() if k != i}
                desc = f"replace step {i + 1} with {len(new)}: {to_text(new)}"
            elif op == "delete":
                i = index(e.get("step"), "step")
                if i == cur and (into >= 1 or len(r.steps) == 1):  # the step being ridden ends now
                    r.steps[i]["d"] = max(1, math.ceil(into))
                    desc = f"end step {i + 1} now"
                else:  # an upcoming step, or the current one at its very start: remove it
                    if i == cur:
                        r.acc, r.last_step = None, -1
                    del r.steps[i]
                    r.ov = {(k - 1 if k > i else k): v for k, v in r.ov.items() if k != i}
                    desc = f"delete step {i + 1}"
            elif op == "total":
                if not at:
                    raise ValueError("workout finished: insert steps instead")
                want = int(e["seconds"])
                minimum = math.ceil(r.el)
                if want < minimum:
                    want = minimum  # ends the plan now
                delta = want - r.total
                how = e.get("how", "last")
                if how == "scale" and delta:
                    # stretch or squeeze the remaining time of every step left, proportionally
                    left = [(i, (r.steps[i]["d"] - (into if i == cur else 0))) for i in range(cur, len(r.steps))]
                    rem = sum(d for _, d in left) or 1
                    for i, d in left:
                        base = into if i == cur else 0
                        r.steps[i]["d"] = max(1 if i != cur else math.ceil(into), round(base + d * (rem + delta) / rem))
                else:  # change the last block; drop trailing steps if shortening past them
                    while delta < 0 and len(r.steps) - 1 > cur and r.steps[-1]["d"] <= -delta:
                        delta += r.steps[-1]["d"]
                        r.ov.pop(len(r.steps) - 1, None)
                        r.steps.pop()
                    last = r.steps[-1]
                    floor = max(1, math.ceil(into)) if len(r.steps) - 1 == cur else 1
                    last["d"] = max(floor, last["d"] + delta)
                old_total = r.total
                r.retime()
                desc = f"duration total {E.fmt_t(old_total)} -> {E.fmt_t(r.total)}"
            elif op in ("duration", "extend"):
                i = index(e.get("step", "cur") if op == "duration" else "cur", "step")
                s = r.steps[i]
                d = int(e["seconds"]) if op == "duration" else s["d"] + int(e["seconds"])
                d = max(1, min(4 * 3600, d))
                if i == cur:
                    d = max(d, math.ceil(into))  # cannot end a step in the past
                old = s["d"]
                s["d"] = d
                desc = f"duration step {i + 1} {E.fmt_t(old)} -> {E.fmt_t(d)}"
            else:
                raise ValueError("edit.op must be insert, replace, delete, duration, extend or total")
            r.retime()
            r.text = to_text(r.plain_steps())
            self.log_event(f"EDIT {desc} | {len(r.steps)} steps, {E.fmt_t(r.total)}")
            self.apply_target()
            self.save()
            self._bump()
            return {"op": op, "detail": desc, "steps": len(r.steps), "total_s": r.total}

    # ---------- coach commands ----------
    def coach(self, cmd: dict) -> None:
        with self.lock:
            if cmd.get("msg"):
                self.messages.append({"seq": cmd["seq"], "msg": cmd["msg"], "ts": int(self.wall() * 1000),
                                      "important": bool(cmd.get("important"))})
                del self.messages[:-10]
            s = cmd.get("set")
            r = self.ride
            if s and r and r.steps:
                at = step_at(r.steps, r.el)
                idx = (at[0] if at else None) if s["step"] == "cur" else s["step"] - 1
                if idx is not None and r.apply_override(idx, s["w"]):
                    self.apply_target()
                    self.save()
            self._bump()

    # ---------- tick ----------
    def _sim_step(self):
        h, r = self.hub, self.hub.r
        self.sim_t += 1
        want = h.wanted_cmd or {}
        k = want.get("k")
        tgt = want.get("w", 0) if k == "erg" else 60 + (want.get("r") or 0) * 12 if k == "res" else 150 + (want.get("g") or 0) * 25
        r.power = max(0, round(r.power + (tgt - r.power) * 0.5 + (self.rng.random() - 0.5) * 18))
        r.cadence = round(88 + math.sin(self.sim_t / 40) * 4 + (self.rng.random() - 0.5) * 3)
        r.speed = round((r.power / 0.0055) ** (1 / 3) * 0.1 * 3.6 / 1.6, 1)
        ftp = (self.ride.ftp if self.ride else self.settings().get("ftp")) or 200
        hr_t = 95 + r.power / ftp * 70
        r.hr = round((r.hr or 90) + (hr_t - (r.hr or 90)) * 0.04)
        r.hr_last = r.last = self.clock()

    def tick(self, dt: float | None = None) -> None:
        with self.lock:
            now = self.clock()
            if dt is None:
                dt = min(5.0, now - self._last_tick)
            self._last_tick = now
            h, d = self.hub, self.hub.r
            if h.mode == "sim":
                self._sim_step()
            elif now - d.last > 3:
                d.power = d.cadence = d.speed = 0
            self.p_hist = (self.p_hist + [d.power])[-3:]
            r = self.ride
            if r and r.started:
                pedaling = d.cadence > 0 or d.power > 0
                if h.mode != "sim":
                    if not pedaling:
                        r.idle += 1
                        if r.idle >= 3 and not r.paused:
                            r.paused = r.auto = True
                    else:
                        r.idle = 0
                        if r.auto:
                            r.paused = r.auto = False
                elif r.auto:  # the simulated rider always pedals (e.g. after a resume)
                    r.paused = r.auto = False
                if not r.paused:
                    r.el += dt
                    self._record()
                    self._coach_tick()
                    if r.steps and r.el >= r.total and not r.overtime:
                        r.overtime = True
                        if r.acc and r.acc["p"]:
                            self.log_event(E.line_step_end(**r.acc))
                        r.acc, r.last_step = None, -1
                        self.log_event(f"WORKOUT DONE at T+{E.fmt_t(r.el)}, riding free until End")
                        self.notice = "Workout done. Keep riding or press End ride."
                        self.save()
                if r.paused != r.pp:
                    r.pp = r.paused
                    self.log_event(("PAUSED (stopped pedaling)" if r.auto else "PAUSED") if r.paused else "RESUMED")
                self.apply_target()
            self._bump()

    def _hr_now(self) -> int:
        d = self.hub.r
        return d.hr if d.hr and self.clock() - d.hr_last < 5 else 0

    def _timestamp(self, r: "Ride") -> int:
        """Sample time in ms: wall clock, but strictly increasing and immune to clock jumps.
        If the wall clock disagrees with the monotonic clock by more than 5 s since the last
        sample (NTP step, manual change, DST bug), keep counting from the monotonic clock."""
        wall_ms, mono = int(self.wall() * 1000), self.clock()
        prev, prev_mono = (r.samples[-1][0], r.last_mono) if r.samples else (None, None)
        if prev is None or prev_mono is None:
            ts = wall_ms if prev is None else max(wall_ms, prev + 1)
        else:
            expected = prev + (mono - prev_mono) * 1000
            ts = wall_ms if abs(wall_ms - expected) <= 5000 else int(expected)
            ts = max(ts, prev + 1)
        r.last_mono = mono
        return ts

    def _record(self):
        r, d = self.ride, self.hub.r
        r.samples.append([self._timestamp(r), round(r.el, 1), round(d.power), round(d.cadence), self._hr_now(),
                          round(d.speed, 2), self.cur_target() or 0])
        n = len(r.samples)
        if n == 1 or n % 30 == 0:
            self.save()  # snapshot (the first one at once: the journal needs it to resume from)
        else:
            self._journal(r.samples[-1])  # every other sample: one fsync'd line

    def _coach_tick(self):
        r = self.ride
        if not r.steps:
            return
        x = r.samples[-1]
        at = step_at(r.steps, r.el)
        if not at:
            return
        i, s, into = at
        if i != r.last_step:
            if r.acc and r.acc["p"]:
                self.log_event(E.line_step_end(**r.acc))
            r.acc = {"i": i, "p": [], "h": [], "c": [], "tg": []}
            r.last_step, r.last_line = i, r.el
            self.log_event(E.line_step_start(i, len(r.steps), s["d"], self.cur_target()))
        r.acc["p"].append(x[2])
        if x[4]:
            r.acc["h"].append(x[4])
        r.acc["c"].append(x[3])
        r.acc["tg"].append(x[6])
        if r.el - r.last_line >= 30:
            r.last_line = r.el
            self.log_event(E.line_tick(r.el, i, len(r.steps), into, s["d"], self.cur_target(), r.samples[-30:], r.acc["p"]))

    # ---------- state ----------
    def state(self, athlete: dict, said: list | None = None) -> dict:
        with self.lock:
            d = self.hub.r
            st: dict[str, Any] = {
                "v": 1, "source": "server", "ts": int(self.wall() * 1000), "athlete": athlete,
                "devices": self.hub.status(),
                "live": {"power": round(d.power), "power_3s": round(_mean(self.p_hist)) if self.p_hist else 0,
                         "cadence": round(d.cadence), "hr": self._hr_now() or None, "speed_kmh": round(d.speed, 1)},
                "ride": None, "messages": self.messages[-3:], "said": said or [],
                "last_finished": self.last_finished, "last_saved": self.last_saved, "notice": self.notice,
                "version": self.version,
            }
            r = self.ride
            if not r:
                return st
            l30 = r.samples[-30:]
            h = [x[4] for x in l30 if x[4]]
            kk = 1 if r.test else r.k
            ride = st["ride"] = {
                "id": r.id, "name": r.name, "text": r.text,
                "mode": "workout" if r.steps else {"w": "erg", "r": "resistance"}.get(r.jr["m"], "grade"),
                "started": r.started, "paused": r.paused, "auto_paused": r.auto, "elapsed_s": round(r.el), "el": r.el,
                "ftp": r.ftp, "intensity": r.k, "test": r.test, "target_w": self.cur_target(),
                "grade": None if r.steps else r.jr["g"], "level": None if r.steps else r.jr.get("r"),
                "overtime": r.overtime, "after_workout": self.settings().get("afterWorkout", "hold"),
                "agent": {"wakes": r.agent_wakes, "local_cues": r.local_cues, "usage": r.usage, "seen": r.agent_seen},
                "jr": r.jr, "samples": len(r.samples),
                "ov": {str(k): v for k, v in r.ov.items()},
                "last30": {"power": E.js_round(_mean([x[2] for x in l30])), "cadence": E.js_round(_mean([x[3] for x in l30])),
                           "hr": h[-1] if h else None, "hr_delta": (h[-1] - h[0]) if h else None},
                "total_s": None, "step": None, "steps": None,
            }
            if r.steps:
                at = step_at(r.steps, r.el)
                ride["total_s"] = r.total
                if at:
                    ride["step"] = {"index": at[0] + 1, "count": len(r.steps), "duration_s": at[1]["d"],
                                    "into_s": round(at[2]), "left_s": round(at[1]["d"] - at[2]), "free": bool(at[1].get("free"))}
                ride["steps"] = [{"index": i + 1, "start_s": s["t0"], "duration_s": s["d"], "free": bool(s.get("free")),
                                  "start_w": step_watts(s, 0, r.ftp, kk), "end_w": step_watts(s, s["d"], r.ftp, kk),
                                  "planned": None if s.get("free") else {"a": s["a"], "b": s["b"], "unit": s["u"]},
                                  "override_w": r.ov.get(i)} for i, s in enumerate(r.steps)]
            return st

    def samples_since(self, ride_id: str | None, n: int) -> tuple[str | None, list]:
        with self.lock:
            r = self.ride
            if not r:
                return None, []
            if ride_id != r.id:
                return r.id, list(r.samples)
            return r.id, r.samples[n:]
