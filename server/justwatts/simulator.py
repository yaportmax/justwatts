"""Headless ride simulator: plays the page's role against the server API, no browser or trainer.

It posts the same event lines and /api/state snapshots as app/js/app.js, polls /api/coach and
applies `set`/`msg` commands, so an agent (or a test) can exercise the whole coach loop.

  justwatts simulate --workout "5m 50-70%, 3x(3m 110%, 2m 50%), 5m 50%" --speed 10 --scenario fade
"""
from __future__ import annotations

import math
import random
import time
from typing import Any, Callable

from . import events as E
from .client import CoachClient
from .workout import compile_workout, step_at, step_watts

SCENARIOS = ("steady", "fade", "pause", "easier", "harder")


class Simulator:
    def __init__(self, client: CoachClient, text: str, ftp: int = 200, name: str = "Simulated workout",
                 speed: float = 10.0, scenarios: str | list[str] = "steady", seed: int = 1,
                 weight_kg: float | None = 75, hr_zones: list[int] | None = None, hr_max: int | None = 190,
                 log: Callable[[str], None] | None = print):
        self.c = client
        self.steps, self.total = compile_workout(text)
        self.text, self.ftp, self.name, self.speed = text, ftp, name, speed
        sc = scenarios.split(",") if isinstance(scenarios, str) else list(scenarios)
        self.scen = {s.strip() for s in sc if s.strip()}
        bad = self.scen - set(SCENARIOS)
        if bad:
            raise ValueError(f"unknown scenario(s) {sorted(bad)}; choose from {SCENARIOS}")
        self.rng = random.Random(seed)
        self.athlete = {"ftp": ftp, "weight_kg": weight_kg, "hr_zones": hr_zones or [100, 120, 140, 160, 175],
                        "hr_max": hr_max, "hr_zones_source": "sim"}
        self.log = log or (lambda _m: None)
        self.el = 0.0
        self.samples: list[list] = []
        self.ov: dict[int, int] = {}
        self.paused = False
        self.auto = False
        self.idle = 0
        self.power = self.cad = 0.0
        self.hr = 70.0
        self.fatigue = 0.0
        self.coach_seq = 0
        self.messages: list[str] = []
        self.applied: list[dict] = []
        self.last_step = -1
        self.acc: dict[str, Any] | None = None
        self.last_line = 0.0
        self.ticks = 0
        self.ts = time.time() * 1000
        self.p3: list[float] = []
        self.pause_window = (round(self.total * 0.4), round(self.total * 0.4) + 20) if "pause" in self.scen else None
        self.feel_at = {}
        if "harder" in self.scen:
            self.feel_at[max(5, round(self.total * 0.25))] = "harder"
        if "easier" in self.scen:
            hard = next((s for s in self.steps if not s.get("free") and self._planned_frac(s) >= 1.0), None)
            t = hard["t0"] + hard["d"] // 2 if hard else round(self.total * 0.5)
            self.feel_at[max(5, t)] = "easier"

    # ---------- model ----------
    def _planned_frac(self, s):
        return max(s["a"], s["b"]) / (self.ftp if s["u"] == "w" else 1)

    def target(self) -> int | None:
        at = step_at(self.steps, self.el)
        return None if at is None else step_watts(at[1], at[2], self.ftp)

    def _physio(self, tgt: int | None):
        el = self.el
        idle = self.pause_window and self.pause_window[0] <= self.ticks < self.pause_window[1]
        if idle:
            self.power = self.cad = 0
        else:
            want = tgt if tgt is not None else 0.6 * self.ftp
            cad = 88 + 3 * math.sin(self.ticks / 40)
            at = step_at(self.steps, el)
            if "fade" in self.scen and at and want > self.ftp and at[2] > 0.5 * at[1]["d"]:
                frac_in = (at[2] - 0.5 * at[1]["d"]) / (0.5 * at[1]["d"])
                cad -= 25 * frac_in        # cadence collapse late in hard steps
                want *= 1 - 0.08 * frac_in  # ERG can't hold the athlete up forever
            self.power = max(0.0, self.power + (want - self.power) * 0.5 + self.rng.uniform(-9, 9))
            self.cad = max(0.0, cad + self.rng.uniform(-1.5, 1.5))
        rel = self.power / self.ftp
        self.fatigue = max(0.0, self.fatigue + (rel - 0.8) / 600)
        drift = (0.4 if "fade" in self.scen else 0.15) * el / 60
        hr_t = min(195.0, 62 + rel * 95 + drift + 25 * self.fatigue)
        self.hr += (hr_t - self.hr) * 0.04

    # ---------- page-equivalent behavior ----------
    def _sample(self, tgt):
        self.samples.append([round(self.ts), round(self.el, 1), round(self.power), round(self.cad),
                             round(self.hr), round(self.power * 0.12, 2), tgt or 0])

    def _coach_tick(self):
        at = step_at(self.steps, self.el)
        if at is None:
            return
        i, s, into = at
        x = self.samples[-1]
        if i != self.last_step:
            if self.acc and self.acc["p"]:
                self.c.event(E.line_step_end(**self.acc))
            self.acc = {"i": i, "p": [], "h": [], "c": [], "tg": []}
            self.last_step, self.last_line = i, self.el
            self.c.event(E.line_step_start(i, len(self.steps), s["d"], self.target()))
        self.acc["p"].append(x[2])
        if x[4]:
            self.acc["h"].append(x[4])
        self.acc["c"].append(x[3])
        self.acc["tg"].append(x[6])
        if self.el - self.last_line >= 30:
            self.last_line = self.el
            self.c.event(E.line_tick(self.el, i, len(self.steps), into, s["d"], self.target(), self.samples[-30:], self.acc["p"]))

    def _apply(self, cmd: dict):
        if cmd.get("msg"):
            self.messages.append(cmd["msg"])
            self.log(f"  coach> {cmd['msg']}")
        st = cmd.get("set")
        if st:
            at = step_at(self.steps, self.el)
            idx = (at[0] if at else None) if st["step"] == "cur" else st["step"] - 1
            if idx is not None and 0 <= idx < len(self.steps) and not self.steps[idx].get("free"):
                s = self.steps[idx]
                s["a"] = s["b"] = st["w"]
                s["u"] = "w"
                self.ov[idx] = st["w"]
                self.applied.append({"step": idx + 1, "w": st["w"], "at_s": round(self.el)})
                self.log(f"  coach> step {idx + 1} -> {st['w']} W")

    def _poll(self):
        for cmd in self.c.commands(self.coach_seq):
            self.coach_seq = cmd["seq"]
            self._apply(cmd)

    def state(self, done: bool = False) -> dict:
        p3 = round(sum(self.p3) / len(self.p3)) if self.p3 else 0
        st = {"v": 1, "source": "sim", "ts": round(self.ts), "athlete": self.athlete,
              "devices": {"trainer": "sim", "trainer_name": "headless simulator", "hr": "sim"},
              "live": {"power": round(self.power), "power_3s": p3, "cadence": round(self.cad),
                       "hr": round(self.hr), "speed_kmh": round(self.power * 0.12, 1)},
              "ride": None}
        if done:
            return st
        l30 = self.samples[-30:]
        h = [x[4] for x in l30 if x[4]]
        at = step_at(self.steps, self.el)
        st["ride"] = {
            "name": self.name, "mode": "workout", "started": True, "paused": self.paused, "auto_paused": self.auto,
            "elapsed_s": round(self.el), "ftp": self.ftp, "intensity": 1, "test": False, "target_w": self.target(),
            "grade": None, "samples": len(self.samples),
            "last30": {"power": E.js_round(E._mean([x[2] for x in l30])), "cadence": E.js_round(E._mean([x[3] for x in l30])),
                       "hr": h[-1] if h else None, "hr_delta": (h[-1] - h[0]) if h else None},
            "total_s": self.total,
            "step": None if at is None else {"index": at[0] + 1, "count": len(self.steps), "duration_s": at[1]["d"],
                                             "into_s": round(at[2]), "left_s": round(at[1]["d"] - at[2]),
                                             "free": bool(at[1].get("free"))},
            "steps": [{"index": i + 1, "start_s": s["t0"], "duration_s": s["d"], "free": bool(s.get("free")),
                       "start_w": step_watts(s, 0, self.ftp), "end_w": step_watts(s, s["d"], self.ftp),
                       "planned": None if s.get("free") else {"a": s["a"], "b": s["b"], "unit": s["u"]},
                       "override_w": self.ov.get(i)} for i, s in enumerate(self.steps)],
        }
        return st

    def _ride_payload(self):
        return {"id": f"r-{round(self.samples[0][0]) if self.samples else 0}", "name": self.name, "text": self.text,
                "test": False, "ftp": self.ftp, "start": self.samples[0][0] if self.samples else None,
                "samples": self.samples, "el": self.el, "k": 1, "jr": {"m": "g", "g": 0, "w": round(self.ftp * 0.6)},
                "ov": {str(k): v for k, v in self.ov.items()}, "source": "sim"}

    def start(self) -> None:
        self.log(f"sim: {self.name}, {len(self.steps)} steps, {E.fmt_t(self.total)}, FTP {self.ftp}, "
                 f"x{self.speed:g}, {sorted(self.scen)}")
        self.c.event(E.line_ride_start(self.name, self.ftp, len(self.steps), self.total))
        self._pp = False

    @property
    def done(self) -> bool:
        return self.el >= self.total

    def tick(self) -> None:
        """One simulated second, same order as the page's tick()."""
        c = self.c
        self.ticks += 1
        self.ts += 1000
        self._physio(self.target())
        self.p3 = (self.p3 + [self.power])[-3:]
        if not (self.cad > 0 or self.power > 0):
            self.idle += 1
            if self.idle >= 3 and not self.paused:
                self.paused = self.auto = True
        else:
            self.idle = 0
            if self.auto:
                self.paused = self.auto = False
        if not self.paused:
            self.el += 1
            self._sample(self.target())
            self._coach_tick()
            if len(self.samples) % 15 == 0:
                c.post_current(self._ride_payload())
        if self.paused != self._pp:
            self._pp = self.paused
            c.event(("PAUSED (stopped pedaling)" if self.auto else "PAUSED") if self.paused else "RESUMED")
        feel = self.feel_at.pop(self.ticks, None)
        if feel:
            self.feel(feel)
        if self.ticks % 3 == 0:
            c.post_state(self.state())
        if self.ticks % 2 == 0:
            self._poll()

    def feel(self, feel: str) -> None:
        at = step_at(self.steps, self.el)
        self.c.event(E.line_feel(feel, at[0] + 1 if at else None, self.samples[-30:], round(self.hr)))
        self.log(f"  athlete> FEEL {feel.upper()}")

    def finish(self) -> dict:
        c = self.c
        if self.acc and self.acc["p"]:
            c.event(E.line_step_end(**self.acc))
        c.event(E.line_ride_end(self.el))
        c.post_current({})
        c.post_state(self.state(done=True))
        self.log(f"sim: done at {E.fmt_t(self.el)}, {len(self.applied)} target changes, {len(self.messages)} messages")
        return {"finished": self.done, "elapsed_s": round(self.el), "ticks": self.ticks, "applied": self.applied,
                "messages": self.messages, "samples": len(self.samples)}

    def run(self, max_ticks: int | None = None) -> dict:
        self.start()
        while not self.done and (max_ticks is None or self.ticks < max_ticks):
            self.tick()
            if self.speed > 0:
                time.sleep(1 / self.speed)
        return self.finish()
