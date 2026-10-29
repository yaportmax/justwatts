"""The web build's engine (app/js/web/engine.js) and the server engine answer every manual control the same."""
import json
import random
import subprocess

import pytest

from conftest import REPO
from justwatts import events as E
from justwatts.engine import RideEngine

SCRIPT = REPO / "tests" / "js" / "engine_parity.mjs"


class Reading:
    power = cadence = speed = hr = 0
    hr_last = last = 0.0


class Hub:
    mode = "sim"

    def __init__(self):
        self.r, self.wanted_cmd = Reading(), None

    def want(self, c):
        self.wanted_cmd = c

    def status(self):
        return {}


def run_python(tmp_path, workout, settings, script):
    t, wall, lines = [1000.0], [1.7e9], []
    s = {"ftp": 200, "afterWorkout": "hold", **settings}
    hub = Hub()
    eng = RideEngine(hub, tmp_path, lambda l: (lines.append(l), eng.note(l)), lambda: s, clock=lambda: t[0], wall=lambda: wall[0])
    eng.rng = random.Random(1)
    eng.control("load", {"workout": workout})
    eng.control("start", {})

    def view():
        r = eng.state({})["ride"]
        if not r:
            return None
        return {"el": E.js_round(r["el"]), "intensity": r["intensity"], "target_w": r["target_w"], "control": r["control"],
                "overtime": r["overtime"], "total_s": r["total_s"], "paused": r["paused"], "jr": r["jr"], "ov": r["ov"],
                "step": r["step"] and [r["step"]["index"], r["step"]["duration_s"], r["step"]["into_s"]],
                "steps": r["steps"] and [[x["duration_s"], x["free"], x["start_w"]] for x in r["steps"]], "want": hub.wanted_cmd}
    out = []
    for op, *a in script:
        res = None
        if op == "tick":
            for _ in range(a[0]):
                t[0] += 1
                wall[0] += 1
                eng.tick(1.0)
        elif op == "set":
            s.update(a[0])
        else:
            try:
                eng.control(op, a[0] if a else {})
                res = "ok"
            except ValueError:
                res = "error"
        out.append({"op": op, "res": res, "view": view()})
    out.append({"lines": [x for x in lines if x.split(" ")[0] in ("MANUAL", "EDIT", "PAUSED", "RESUMED")]})
    return out


SCRIPTS = {
    "workout": ({"name": "P", "text": "1m 50%, 2m 100%, 1m 50%, 1m free"}, {}, [
        ["tick", 5], ["adjust", {"dir": 1}], ["adjust", {"dir": -1, "big": True}], ["intensity", {"percent": 110}],
        ["tick", 60], ["target", {"w": 250}], ["target", {"delta": -5}], ["target", {"step": 3, "w": 90}],
        ["target", {"step": 1, "w": 90}], ["back", {}], ["tick", 3], ["back", {}], ["tick", 12], ["back", {}],
        ["skip", {}], ["tick", 1], ["edit", {"edit": {"op": "extend", "seconds": 45}}], ["edit", {"edit": {"op": "extend", "seconds": -999}}],
        ["tick", 1], ["edit", {"edit": {"op": "total", "seconds": 900}}], ["mode", {"m": "g"}], ["adjust", {"dir": 1}],
        ["free", {"m": "g", "value": 2.5}], ["free", {"m": "w", "value": 200}], ["mode", {"m": "r"}], ["adjust", {"dir": 1, "big": True}],
        ["mode", {"m": "e"}], ["mode", {"m": "x"}], ["hold", {}], ["skip", {}], ["tick", 3], ["resume", {}],
        ["edit", {"edit": {"op": "rest", "after": 1, "steps": "2m 60%"}}], ["edit", {"edit": {"op": "rest", "steps": "bad"}}],
        ["tick", 1], ["edit", {"edit": {"op": "rest", "steps": "1m 60%, 30s free"}}], ["tick", 200], ["adjust", {"dir": 1}],
        ["set", {"afterWorkout": "grade0"}], ["tick", 1], ["adjust", {"dir": 1}], ["target", {"w": 150}],
        ["edit", {"edit": {"op": "rest", "steps": ""}}], ["back", {}], ["tick", 2], ["skip", {}], ["tick", 70],
        ["edit", {"edit": {"op": "rest", "steps": "1m 70%"}}], ["tick", 1],
    ]),
    "free_ride": (None, {}, [
        ["adjust", {"dir": 1}], ["mode", {"m": "w"}], ["adjust", {"dir": 1, "big": True}], ["target", {"w": 180}],
        ["target", {"delta": 10}], ["mode", {"m": "r"}], ["adjust", {"dir": -1}], ["free", {"m": "g", "value": 4}],
        ["free", {"m": "w", "value": 5000}], ["mode", {"m": "e"}], ["skip", {}], ["back", {}], ["tick", 3],
    ]),
    "ramp_test": ({"name": "Ramp", "text": "1m 100w, 1m 120w, 1m 140w", "test": True}, {}, [
        ["tick", 10], ["adjust", {"dir": 1}], ["intensity", {"percent": 110}], ["target", {"w": 130}], ["skip", {}],
        ["tick", 1], ["back", {}], ["tick", 1],
    ]),
}


@pytest.mark.parametrize("name", SCRIPTS)
def test_js_engine_matches_python_engine(node, tmp_path, name):
    workout, settings, script = SCRIPTS[name]
    py = run_python(tmp_path, workout, settings, script)
    p = subprocess.run([node, str(SCRIPT)], input=json.dumps({"workout": workout, "settings": settings, "script": script}),
                       capture_output=True, text=True, timeout=60, encoding="utf-8")
    assert p.returncode == 0, p.stderr
    js = json.loads(p.stdout)
    assert len(js) == len(py)
    for i, (a, b) in enumerate(zip(py, js)):
        assert a == b, f"step {i} {script[i] if i < len(script) else 'lines'}:\npy {a}\njs {b}"
    assert any(x["res"] == "error" for x in py[:-1]) and any(x["res"] == "ok" for x in py[:-1])
