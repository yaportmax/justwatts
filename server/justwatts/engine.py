"""Server-side ride engine: a port of the page's ride loop so the ride survives page reloads.

One tick per second reads the device hub, records a sample, auto-pauses, writes the ride event
lines and applies ERG/grade targets. The ride in progress is written to
<data>/live/engine.json (atomic) every 30 samples and after every control action, and is resumed
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
from .course import DRAFT_MAX, G_MAX, G_MIN, check_ride_course, ele_at, grade_at, mass_of, profile_of, ridden, road_extend, speed_step
from .devices import DeviceHub
from .workout import WorkoutError, compile_workout, parse_workout, step_at, step_watts, to_text

STALE_RESUME_S = 6 * 3600


def _mean(a):
    return sum(a) / len(a) if a else 0


def _r1(x: float) -> float:
    return math.floor(x * 10 + 0.5) / 10


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
        # free ride: m = g|w|r (grade %, ERG watts, resistance level). Workouts: wm = e (ERG follows the plan),
        # g or r (ERG off: the rider sets grade or level; the plan still shows and records its target)
        self.jr = {"m": "g", "g": 0.0, "w": round(ftp * 0.6), "r": 5.0, "wm": "e"}
        self.start_ts: int | None = None
        self.ov: dict[int, int] = {}
        self.last_step = -1
        self.acc: dict | None = None
        self.events: list[list] = []  # [epoch_ms, line]: this ride's event log
        self.last_mono: float | None = None  # monotonic time of the last sample (None after a restart)
        self.overtime = False  # the plan ended; riding free until the athlete ends the ride
        # course: the road under the rider. cs = {d: metres ridden, v: virtual speed m/s, up: metres climbed,
        # end: reached the finish}. sg/st: last grade sent and when (ride seconds), for rate limiting.
        self.course: dict | None = None
        self.cs = {"d": 0.0, "v": 0.0, "up": 0.0, "end": False}
        self.prof: list | None = None
        self.sg: float | None = None
        self.st = -1e9

    def set_course(self, c: dict | None) -> None:
        self.course = c
        self.prof = profile_of(c) if c else None

    def resume_course(self) -> None:
        """Position from the last recorded sample (the journal is newer than the snapshot's cs)."""
        s = [x for x in self.samples if len(x) > 8]
        if not s:
            return
        up = max(0.0, s[0][7] - self.course["ele"][0]) + sum(max(0.0, b[7] - a[7]) for a, b in zip(s, s[1:]))
        end = not self.course.get("open") and bool(self.cs["end"] or s[-1][8] >= self.course["dist"])
        self.cs.update(d=float(s[-1][8]), v=s[-1][5] / 3.6, up=up, end=end)

    @property
    def id(self) -> str:
        return f"r-{self.start_ts or 0}"

    def apply_override(self, idx: int, w) -> bool:
        """w: watts for a steady step, or [start, end] watts for a ramp (a ramp keeps its shape)."""
        if not self.steps or not 0 <= idx < len(self.steps) or self.steps[idx].get("free"):
            return False
        s = self.steps[idx]
        s["a"], s["b"] = (w[0], w[1]) if isinstance(w, (list, tuple)) else (w, w)
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
                "events": self.events, "overtime": self.overtime, "start": self.start_ts, "samples": self.samples, "el": self.el, "k": self.k, "jr": self.jr,
                "ov": {str(k): v for k, v in self.ov.items()}, "source": "server",
                "course": self.course, "cs": self.cs}


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
        self.last_finished: dict | None = None  # {id, name, samples, ts, saved}
        self.last_saved: dict | None = None
        self.on_finish: Callable[[dict], None] | None = None  # server hook (auto Garmin upload)
        self._notice: str | None = None
        self.notice_id = 0  # increases with every new notice: pages show each one once, nobody has to dismiss it
        self.version = 0
        self._last_tick = clock()
        self._jf = None
        self.sim_t = 0
        self.rng = random.Random()

    @property
    def notice(self) -> str | None:
        return self._notice

    @notice.setter
    def notice(self, text: str | None) -> None:
        if text and text != self._notice:
            self.notice_id = max(self.notice_id + 1, int(self.wall() * 1000))  # unique across restarts
        self._notice = text

    # ---------- paths ----------
    @property
    def current_file(self) -> Path:
        return self.data / "live" / "engine.json"

    @property
    def journal_file(self) -> Path:
        """One JSON sample per line, appended every second; folded into engine.json on each snapshot."""
        return self.data / "live" / "engine.journal"

    @property
    def rides_dir(self) -> Path:
        return self.data / "rides"

    def note(self, line: str) -> None:
        """Called for every event line: keep a per-ride log (archived with the ride)."""
        with self.lock:
            r = self.ride
            if r is not None and (r.started or line.startswith("RIDE START")):
                r.events.append([int(self.wall() * 1000), line])

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
                    if isinstance(x, list) and len(x) in (7, 9) and x[1] > last_el:
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
            r.ov = {int(k): v for k, v in (cur.get("ov") or {}).items()}
            if cur.get("course"):
                try:
                    r.set_course(check_ride_course(cur["course"]))
                    r.cs = {**r.cs, **(cur.get("cs") or {})}
                    r.resume_course()
                except ValueError:
                    pass
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

    def control_mode(self) -> str | None:
        """What the trainer follows and +/- changes: k (ERG at the plan times intensity), w (ERG watts),
        g (grade) or r (resistance level). Free steps and a flat finish ride by grade."""
        r = self.ride
        if not r:
            return None
        if not r.steps:
            return r.jr["m"]
        wm = r.jr.get("wm", "e")
        if wm in ("g", "r"):
            return wm
        return "k" if self.cur_target() is not None else "g"

    def apply_target(self) -> None:
        r = self.ride
        if not r:
            return
        m = self.control_mode()
        if m == "k":
            self.hub.want({"k": "erg", "w": self.cur_target()})
        elif m == "w":
            self.hub.want({"k": "erg", "w": r.jr["w"]})
        elif m == "r":
            self.hub.want({"k": "res", "r": r.jr["r"]})
        else:
            self.hub.want({"k": "sim", "g": self.course_grade() if r.course else r.jr["g"]})

    def course_grade(self) -> float:
        """Grade sent on a course: the road under the rider plus the rider's +/- offset (jr.g). After the finish
        it holds the last grade, or 0 % with afterWorkout grade0. Rate limited: a change over 0.1 % goes out
        at once, smaller ones at most every 2 s (many trainers dislike floods)."""
        r = self.ride
        base = 0.0 if r.cs["end"] and self.settings().get("afterWorkout", "hold") != "hold" else grade_at(r.course, r.cs["d"])
        want = _r1(min(G_MAX, max(G_MIN, base + r.jr["g"])))
        if r.sg is None or abs(want - r.sg) > 0.1 + 1e-9 or r.el - r.st >= 2:
            r.sg, r.st = want, r.el
        return r.sg

    # ---------- controls (HTTP threads) ----------
    def control(self, action: str, body: dict) -> dict:
        """One rider action. Target and plan changes are logged as MANUAL lines and echoed as `did`."""
        with self.lock:
            fn = {"load": self.load, "start": self.start, "pause": self.toggle_pause, "skip": self.skip,
                  "back": self.back, "end": self.finish, "adjust": self.adjust, "mode": self.set_mode,
                  "dismiss": self.dismiss, "resume": self.resume_ride, "hold": self.hold,
                  "intensity": self.set_intensity, "free": self.set_free, "target": self.set_target,
                  "save": self.save_copy, "edit": lambda b: self.edit(b.get("edit") or {}), "road": self.road,
                  "draft": self.set_draft}.get(action)
            if not fn:
                raise ValueError(f"unknown action {action!r}")
            self._did = None
            res = fn(body) or {}
            if self._did:
                res = {**res, "did": self._did}  # the page confirms exactly what changed
            self.save()
            self._bump()
            return res

    _did: str | None = None  # what the current control action changed

    def _changed(self, what: str) -> None:
        """A target or plan change by the rider: logged as a MANUAL line."""
        if self.ride is None:
            return
        self._did = what
        self.log_event(f"MANUAL {what}")

    def load(self, body: dict):
        """{workout: {name, text, test} | null, course: course | null}. A course alone is a free ride on it;
        with a workout, ERG segments keep their watts and free segments ride the course grade."""
        w = body.get("workout")
        c = check_ride_course(body["course"]) if body.get("course") else None
        if self.ride and self.ride.started:
            self.finish({})
        ftp = int(self.settings().get("ftp") or 200)
        try:
            r = Ride(w["name"], w["text"], bool(w.get("test")), ftp) if w else Ride(c["name"] if c else "Just ride", "", False, ftp)
        except ValueError as e:
            raise ValueError(str(e)) from None
        r.set_course(c)
        self.ride = r
        self.notice = None
        self.apply_target()
        return {"loaded": r.name}

    def road(self, body: dict):
        """Open world: the page extends the road ahead ({at, ele, ll, nd}, see course.road_extend)."""
        r = self.ride
        if not r or not r.course:
            raise ValueError("no open-world ride")
        r.set_course(road_extend(r.course, body, r.cs["d"]))
        return {"n": len(r.course["ele"])}

    def start(self, body: dict | None = None):
        r = self.ride
        if not r or r.started:
            return
        r.started = True
        r.start_ts = int(self.wall() * 1000)
        r.pp = False
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
        """Pause (not a toggle). During an auto-pause it makes the pause stick: pedaling no longer resumes."""
        r = self.ride
        if r and r.started and (not r.paused or r.auto):
            if r.paused and r.pp:  # already logged as an auto-pause: say it is a pause by hand now
                self.log_event("PAUSED")
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
        if r.test:
            raise ValueError("FTP test: intensity is fixed")
        pct = float(body.get("percent", 100))
        if not 50 <= pct <= 150:
            raise ValueError("percent must be 50..150")
        r.k = round(pct / 100, 2)
        self.apply_target()
        self._changed(f"intensity {E.js_round(r.k * 100)}%")

    def set_free(self, body: dict):
        """Free ride target: {m: g|w|r, value}: grade %, ERG watts or resistance level. In a workout, g and r
        set the grade or level used with ERG off, in free steps and after the plan."""
        r = self.ride
        if not r:
            raise ValueError("no ride loaded")
        m = body.get("m")
        if m not in ("g", "w", "r"):
            raise ValueError("m must be g (grade), w (ERG watts) or r (resistance level)")
        if r.steps and m == "w":
            raise ValueError("in a workout, set watts with the target action")
        v = float(body["value"]) if body.get("value") is not None else r.jr[m]
        lim = {"g": (-10, 20), "w": (30, 1500), "r": (0, 25)}[m]
        if not lim[0] <= v <= lim[1]:
            raise ValueError(f"value out of range {lim[0]}..{lim[1]}")
        if not r.steps:
            r.jr["m"] = m
        r.jr[m] = round(v) if m == "w" else round(v, 1)
        self.apply_target()
        self._changed(self._jr_text(m))

    def _jr_text(self, m: str) -> str:
        v = self.ride.jr[m]
        return f"grade {v:.1f}%" if m == "g" else f"level {v:.1f}" if m == "r" else f"erg {v}W"

    def set_target(self, body: dict):
        """A step's target in watts as the trainer gets it now: {w} or {delta}, optional step (1-based, default
        the current one). Later intensity changes still scale it. In a free ride it sets the ERG watts."""
        r = self.ride
        if not r:
            raise ValueError("no ride loaded")
        if not r.steps:
            w = float(body["w"]) if body.get("w") is not None else r.jr["w"] + float(body.get("delta", 0))
            return self.set_free({"m": "w", "value": min(1500, max(30, w))})
        at = step_at(r.steps, r.el)
        step = body.get("step", "cur")
        if step in ("cur", None):
            if not at:
                raise ValueError("workout finished")
            idx = at[0]
        else:
            idx = int(step) - 1
            if not at or not at[0] <= idx < len(r.steps):
                raise ValueError(f"step {step} is not the current or an upcoming step")
        s = r.steps[idx]
        if s.get("free"):
            raise ValueError("free step: no ERG target")
        kk = 1 if r.test else r.k
        now_w = self.cur_target() if idx == at[0] else step_watts(s, 0, r.ftp, kk)
        w = float(body["w"]) if body.get("w") is not None else (now_w or 0) + float(body.get("delta", 0))
        w = max(0, min(2000, E.js_round(w)))
        if s["a"] != s["b"] and now_w:  # a ramp moves up or down as a whole
            plan = lambda x: x if s.get("u") == "w" else x * r.ftp
            d = (w - now_w) / kk
            r.apply_override(idx, [max(0, E.js_round(plan(s["a"]) + d)), max(0, E.js_round(plan(s["b"]) + d))])
        else:
            r.apply_override(idx, E.js_round(w / kk))
        self.apply_target()
        self._changed(f"target step {idx + 1} {w}W")
        return {"step": idx + 1, "w": w}

    def skip(self, body: dict | None = None):
        r = self.ride
        if not r or not r.steps:
            return
        at = step_at(r.steps, r.el)
        if at:  # the rest of the step leaves the plan, so ride time and plan time stay the same clock
            i, s, into = at
            if into >= 1:
                s["d"] = max(1, math.ceil(into))
            else:
                r.steps.pop(i)
                r.ov = {(k - 1 if k > i else k): v for k, v in r.ov.items() if k != i}
            r.retime()
            if into >= 1:
                r.el = max(r.el, s["t0"] + s["d"] + 0.01)
            self.apply_target()
            self._changed(f"skip step {at[0] + 1}")

    def back(self, body: dict | None = None):
        """Like a music player's previous button: restart the current step, or in its first 10 s go back to
        the previous one. Time only moves forward, so this inserts copies of those steps now. After the
        plan it rides the last step again."""
        r = self.ride
        if not r or not r.steps:
            return
        copy = lambda s: {k: v for k, v in s.items() if k != "t0"}  # noqa: E731
        at = step_at(r.steps, r.el)
        if not at:
            src = len(r.steps) - 1
            new = [copy(r.steps[src])]
            gap = math.ceil(r.el - r.total)
            if gap > 0:  # the time ridden since the plan ended becomes a free step
                r.steps.append({"d": gap, "free": True})
            r.overtime = False
            pos = len(r.steps)
        else:
            i, s, into = at
            prev = i > 0 and into < 10
            src = i - 1 if prev else i
            if into >= 1:
                new = [copy(r.steps[i - 1]), copy(s)] if prev else [copy(s)]
                s["d"] = max(1, math.ceil(into))
                pos = i + 1
            elif prev:  # the current step has barely started: put the previous one back in front of it
                new, pos = [copy(r.steps[i - 1])], i
                r.acc, r.last_step = None, -1
            else:
                return
        old = dict(r.ov)
        r.steps[pos:pos] = new
        r.ov = {(k + len(new) if k >= pos else k): v for k, v in old.items()}
        for j in range(len(new)):  # copies keep the overrides of the steps they repeat
            if old.get(src + j) is not None:
                r.ov[pos + j] = old[src + j]
        r.retime()
        r.text = to_text(r.plain_steps())
        self.apply_target()
        self._changed(f"back step {src + 1}")

    def adjust(self, body: dict):
        """+/-: intensity 1 % in ERG workouts, else grade 0.5 %, level 0.5 or 5 W; big: five times that."""
        r = self.ride
        if not r:
            return
        d = (1 if (body.get("dir") or 1) > 0 else -1) * (5 if body.get("big") else 1)
        m = self.control_mode()
        if m == "k":
            if r.test:
                raise ValueError("FTP test: intensity is fixed")
            r.k = max(0.5, min(1.5, round(r.k + d * 0.01, 2)))
            self.apply_target()
            return self._changed(f"intensity {E.js_round(r.k * 100)}%")
        if m == "g":
            r.jr["g"] = max(-10, min(20, round(r.jr["g"] + d * 0.5, 1)))
        elif m == "r":
            r.jr["r"] = max(0, min(25, round(r.jr.get("r", 5) + d * 0.5, 1)))
        else:
            r.jr["w"] = max(30, min(1500, r.jr["w"] + d * 5))
        self.apply_target()
        self._changed(self._jr_text(m))

    MODE_NAMES = {"g": "grade", "w": "erg", "r": "level", "e": "erg"}

    def set_mode(self, body: dict):
        """Free ride: m = g|w|r. Workout: m = e (ERG follows the plan), g or r (ERG off)."""
        r = self.ride
        if not r:
            return
        m = body.get("m")
        if r.steps:
            m = "e" if m == "w" else m
            if m not in ("e", "g", "r"):
                raise ValueError("m must be e (ERG), g (grade) or r (level)")
            r.jr["wm"] = m
        else:
            if m not in ("g", "w", "r"):
                raise ValueError("m must be g (grade), w (ERG watts) or r (level)")
            r.jr["m"] = m
        self.apply_target()
        self._changed(f"mode {self.MODE_NAMES[m]}")

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
        if r.course and r.course.get("open"):
            r.course = ridden(r.course, r.cs["d"])
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

    # ---------- workout edits ----------
    def edit(self, e: dict) -> dict:
        """Insert, delete or retime steps of the running workout. Raises ValueError."""
        with self.lock:
            r = self.ride
            if not r or not r.steps:
                raise ValueError("no structured workout loaded on the server")
            at = step_at(r.steps, r.el)
            if not at and e.get("op") in ("insert", "rest"):
                # plan already ended: the time ridden since becomes a free step, new steps start now
                try:  # check before anything changes
                    if not parse_workout(str(e.get("steps") or "")):
                        raise WorkoutError("empty")
                except WorkoutError as err:
                    raise ValueError("nothing to add" if not str(e.get("steps") or "").strip() else f"bad steps: {err}") from None
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
            elif op == "rest":  # replace everything after the current step (the rider's "next steps" box)
                text = str(e.get("steps") or "").strip()
                try:
                    new = parse_workout(text) if text else []
                except WorkoutError as err:
                    raise ValueError(f"bad steps: {err}") from None
                keep = cur if at else len(r.steps) - 1  # 0-based index of the last step kept
                if e.get("after") is not None and int(e["after"]) - 1 != keep:
                    raise ValueError("the step changed; check the next steps and apply again")
                if not at and not new:
                    raise ValueError("nothing to add")
                if e.get("with_current") and at and new:
                    # new[0] is the current step as edited: what was ridden stays as it was, the rest follows the edit
                    s, first, ridden = r.steps[cur], dict(new[0]), math.ceil(into)
                    if ridden < 1:
                        keep = cur - 1
                        r.acc, r.last_step = None, -1
                    else:
                        if not s.get("free") and s["a"] != s["b"]:
                            s["b"] = s["a"] + (s["b"] - s["a"]) * min(1, ridden / s["d"])
                        s["d"] = ridden
                        if first["d"] > ridden:
                            if not first.get("free") and first["a"] != first["b"]:
                                first["a"] = first["a"] + (first["b"] - first["a"]) * ridden / first["d"]
                            first["d"] -= ridden
                            new = [first] + new[1:]
                        else:
                            new = new[1:]
                r.steps[keep + 1:] = new
                r.ov = {k: v for k, v in r.ov.items() if k <= keep}
                desc = f"rest after step {keep + 1}: {to_text(new) or 'none'}"
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
                raise ValueError("edit.op must be insert, replace, delete, duration, extend, total or rest")
            r.retime()
            r.text = to_text(r.plain_steps())
            self.log_event(f"EDIT {desc} | {len(r.steps)} steps, {E.fmt_t(r.total)}")
            self.apply_target()
            self.save()
            self._bump()
            return {"op": op, "detail": desc, "steps": len(r.steps), "total_s": r.total}

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
                # coasting downhill on a course still moves: only a stop pauses
                pedaling = d.cadence > 0 or d.power > 0 or (r.course is not None and r.cs["v"] > 0.5)
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
                    self._course_tick(dt)
                    self._record()
                    self._step_tick()
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

    _draft: tuple[float, float] = (0.0, 0.0)  # open world: (share of air drag taken away, clock it lapses at)

    def set_draft(self, body: dict) -> dict:
        """Open world: a rider close ahead takes some of the air drag ({k}: 0 .. DRAFT_MAX); it lapses unless sent again."""
        try:
            k = max(0.0, min(DRAFT_MAX, float(body.get("k") or 0)))
        except (TypeError, ValueError):
            k = 0.0
        self._draft = (k, self.clock() + 5)
        return {"draft": k}

    def _course_tick(self, dt: float) -> None:
        """Move along the course at the speed the rider's power gives on the road under them."""
        r = self.ride
        if not r.course:
            return
        c, cs = r.course, r.cs
        draft = self._draft[0] if c.get("open") and self.clock() < self._draft[1] else 0.0
        cs["v"] = speed_step(cs["v"], self.hub.r.power, grade_at(c, cs["d"]), mass_of(self.settings().get("weight")), dt, draft)
        e0 = ele_at(c, cs["d"])
        cs["d"] += cs["v"] * dt
        if c.get("open"):  # open world: wait at the end of the known road until the page adds more
            cs["d"] = min(cs["d"], c["dist"])
        cs["up"] += max(0.0, ele_at(c, cs["d"]) - e0)
        if cs["d"] >= c["dist"] and not cs["end"] and not c.get("open"):
            cs["end"] = True
            self.log_event(f"COURSE DONE at T+{E.fmt_t(r.el)}, riding on until End")
            self.notice = "Course done. Keep riding or press End ride."

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
        x = [self._timestamp(r), round(r.el, 1), round(d.power), round(d.cadence), self._hr_now(),
             round(d.speed, 2), self.cur_target() or 0]
        if r.course:  # virtual speed, then altitude and distance on the course
            x[5] = math.floor(r.cs["v"] * 360 + 0.5) / 100
            x += [_r1(ele_at(r.course, r.cs["d"])), _r1(r.cs["d"])]
        r.samples.append(x)
        n = len(r.samples)
        if n == 1 or n % 30 == 0:
            self.save()  # snapshot (the first one at once: the journal needs it to resume from)
        else:
            self._journal(r.samples[-1])  # every other sample: one fsync'd line

    def _step_tick(self):
        """START/END lines per step, with the step's averages."""
        r = self.ride
        if not r.steps:
            return
        x = r.samples[-1]
        at = step_at(r.steps, r.el)
        if not at:
            return
        i, s = at[0], at[1]
        if i != r.last_step:
            if r.acc and r.acc["p"]:
                self.log_event(E.line_step_end(**r.acc))
            r.acc = {"i": i, "p": [], "h": [], "c": [], "tg": []}
            r.last_step = i
            self.log_event(E.line_step_start(i, len(r.steps), s["d"], self.cur_target()))
        r.acc["p"].append(x[2])
        if x[4]:
            r.acc["h"].append(x[4])
        r.acc["c"].append(x[3])
        r.acc["tg"].append(x[6])

    # ---------- state ----------
    def state(self, athlete: dict) -> dict:
        with self.lock:
            d = self.hub.r
            st: dict[str, Any] = {
                "v": 1, "source": "server", "ts": int(self.wall() * 1000), "athlete": athlete,
                "devices": self.hub.status(),
                "live": {"power": round(d.power), "power_3s": round(_mean(self.p_hist)) if self.p_hist else 0,
                         "cadence": round(d.cadence), "hr": self._hr_now() or None, "speed_kmh": round(d.speed, 1)},
                "ride": None, "last_finished": self.last_finished, "last_saved": self.last_saved, "notice": self.notice, "notice_id": self.notice_id,
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
                "jr": r.jr, "samples": len(r.samples), "control": self.control_mode(),
                "ov": {str(k): v for k, v in r.ov.items()},
                "last30": {"power": E.js_round(_mean([x[2] for x in l30])), "cadence": E.js_round(_mean([x[3] for x in l30])),
                           "hr": h[-1] if h else None, "hr_delta": (h[-1] - h[0]) if h else None},
                "total_s": None, "step": None, "steps": None, "course": None,
            }
            if r.course:
                c, cs = r.course, r.cs
                ride["course"] = {"name": c["name"], "dist_m": c["dist"], "gain_m": c["gain"], "done_m": _r1(min(cs["d"], c["dist"])),
                                  "odo_m": _r1(cs["d"]), "ele_m": _r1(ele_at(c, cs["d"])), "climbed_m": _r1(cs["up"]),
                                  "grade": grade_at(c, cs["d"]), "speed_kmh": _r1(cs["v"] * 3.6), "end": cs["end"],
                                  "profile": r.prof, "open": bool(c.get("open")), "n": len(c["ele"])}
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

    def course_payload(self) -> dict:
        with self.lock:
            r = self.ride
            return {"course": r.course, "d": r.cs["d"]} if r and r.course else {"course": None, "d": 0}

    def samples_since(self, ride_id: str | None, n: int) -> tuple[str | None, list]:
        with self.lock:
            r = self.ride
            if not r:
                return None, []
            if ride_id != r.id:
                return r.id, list(r.samples)
            return r.id, r.samples[n:]
