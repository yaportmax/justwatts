"""Server-side ride engine: a port of the page's ride loop so the ride survives page reloads.

One tick per second reads the device hub, records a sample, auto-pauses, writes the coach event
lines, applies ERG/grade targets and coach overrides. The ride in progress is written to
<data>/coach/engine.json (atomic) every 5 samples and after every control action, and is resumed
(paused, waiting for pedaling) when the server restarts.
"""
from __future__ import annotations

import json
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
        self.jr = {"m": "g", "g": 0.0, "w": round(ftp * 0.6)}
        self.start_ts: int | None = None
        self.ov: dict[int, int] = {}
        self.last_step = -1
        self.acc: dict | None = None
        self.last_line = 0.0

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
        self.notice: str | None = None
        self.version = 0
        self._last_tick = clock()
        self.sim_t = 0
        self.rng = random.Random()

    # ---------- paths ----------
    @property
    def current_file(self) -> Path:
        return self.data / "coach" / "engine.json"

    @property
    def rides_dir(self) -> Path:
        return self.data / "rides"

    def _bump(self):
        self.version += 1
        self.changed.notify_all()

    # ---------- persistence ----------
    def save(self) -> None:
        from .server import atomic_write
        r = self.ride
        if r and r.started and r.samples:
            atomic_write(self.current_file, json.dumps(r.payload()).encode("utf-8"))

    def clear_saved(self) -> None:
        self.current_file.unlink(missing_ok=True)

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
            r.el = cur.get("el", cur["samples"][-1][1])
            r.started, r.paused, r.auto, r.pp = True, True, True, True
            r.k = cur.get("k") or 1
            r.samples = cur["samples"]
            r.jr = cur.get("jr") or r.jr
            r.start_ts = cur.get("start")
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
            return None
        return step_watts(at[1], at[2], r.ftp, 1 if r.test else r.k)

    def apply_target(self) -> None:
        r = self.ride
        if not r:
            return
        if not r.steps:
            self.hub.want({"k": "erg", "w": r.jr["w"]} if r.jr["m"] == "w" else {"k": "sim", "g": r.jr["g"]})
            return
        t = self.cur_target()
        self.hub.want({"k": "sim", "g": 0} if t is None else {"k": "erg", "w": t})

    # ---------- controls (HTTP threads) ----------
    def control(self, action: str, body: dict) -> dict:
        with self.lock:
            fn = {"load": self.load, "start": self.start, "pause": self.toggle_pause, "skip": self.skip,
                  "end": self.finish, "adjust": self.adjust, "mode": self.set_mode, "feel": self.feel,
                  "dismiss": self.dismiss}.get(action)
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
        else:
            r.jr["w"] = max(30, min(1500, r.jr["w"] + d * 5))
        self.apply_target()

    def set_mode(self, body: dict):
        r = self.ride
        if r and body.get("m") in ("g", "w"):
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

    def dismiss(self, body: dict | None = None):
        self.notice = None

    def finish(self, body: dict | None = None):
        r = self.ride
        if not r:
            return
        self.ride = None
        if r.acc and r.acc["p"]:
            self.log_event(E.line_step_end(**r.acc))
        self.log_event(E.line_ride_end(r.el))
        self.hub.want({"k": "sim", "g": 0})
        self.clear_saved()
        if len(r.samples) < 10:
            self.notice = "Ride too short, not saved"
            self.last_finished = None
            return {"saved": False}
        p = r.payload()
        self._archive(p)
        self.last_finished = {"id": p["id"], "name": r.name, "samples": len(r.samples), "ts": int(self.wall() * 1000)}
        return {"saved": True, "id": p["id"]}

    # ---------- workout edits (coach API) ----------
    def edit(self, e: dict) -> dict:
        """Insert, delete or retime steps of the running workout. Raises ValueError."""
        with self.lock:
            r = self.ride
            if not r or not r.steps:
                raise ValueError("no structured workout loaded on the server")
            at = step_at(r.steps, r.el)
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
                if i < cur:
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
                if i == cur:  # keep what was ridden of the current step, the replacement starts now
                    r.steps[i]["d"] = max(1, math.ceil(into))
                    r.steps[i + 1:i + 1] = new
                    r.ov = {(k + len(new) if k > i else k): v for k, v in r.ov.items()}
                else:
                    r.steps[i:i + 1] = new
                    r.ov = {(k + len(new) - 1 if k > i else k): v for k, v in r.ov.items() if k != i}
                desc = f"replace step {i + 1} with {len(new)}: {to_text(new)}"
            elif op == "delete":
                i = index(e.get("step"), "step")
                if i == cur:  # the step being ridden ends now; the next one starts fresh
                    r.steps[i]["d"] = max(1, math.ceil(into))
                    desc = f"end step {i + 1} now"
                else:
                    del r.steps[i]
                    r.ov = {(k - 1 if k > i else k): v for k, v in r.ov.items() if k != i}
                    desc = f"delete step {i + 1}"
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
                raise ValueError("edit.op must be insert, replace, delete, duration or extend")
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
                self.messages.append({"seq": cmd["seq"], "msg": cmd["msg"], "ts": int(self.wall() * 1000)})
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
        tgt = want.get("w", 0) if want.get("k") == "erg" else 150 + (want.get("g") or 0) * 25
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
                if not r.paused:
                    r.el += dt
                    self._record()
                    self._coach_tick()
                    if r.steps and r.el >= r.total:
                        self.finish()
                        self._bump()
                        return
                if r.paused != r.pp:
                    r.pp = r.paused
                    self.log_event(("PAUSED (stopped pedaling)" if r.auto else "PAUSED") if r.paused else "RESUMED")
                self.apply_target()
            self._bump()

    def _hr_now(self) -> int:
        d = self.hub.r
        return d.hr if d.hr and self.clock() - d.hr_last < 5 else 0

    def _record(self):
        r, d = self.ride, self.hub.r
        r.samples.append([int(self.wall() * 1000), round(r.el, 1), round(d.power), round(d.cadence), self._hr_now(),
                          round(d.speed, 2), self.cur_target() or 0])
        if len(r.samples) % 5 == 0:
            self.save()

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
                "last_finished": self.last_finished, "notice": self.notice, "version": self.version,
            }
            r = self.ride
            if not r:
                return st
            l30 = r.samples[-30:]
            h = [x[4] for x in l30 if x[4]]
            kk = 1 if r.test else r.k
            ride = st["ride"] = {
                "id": r.id, "name": r.name, "text": r.text, "mode": "workout" if r.steps else "erg" if r.jr["m"] == "w" else "grade",
                "started": r.started, "paused": r.paused, "auto_paused": r.auto, "elapsed_s": round(r.el), "el": r.el,
                "ftp": r.ftp, "intensity": r.k, "test": r.test, "target_w": self.cur_target(),
                "grade": None if r.steps else r.jr["g"], "jr": r.jr, "samples": len(r.samples),
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
