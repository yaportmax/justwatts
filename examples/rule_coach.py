"""A tiny rule-based coach over the HTTP API: a baseline to compare agents against, and a template
for writing your own loop without MCP.

  trainer-coach serve                         # terminal 1
  trainer-coach simulate --scenario fade      # terminal 2 (or ride for real)
  python examples/rule_coach.py               # terminal 3

Rules: on FEEL EASIER drop 5% FTP; if HR is in the top zone and rising in a step above 90% FTP drop
3%; if cadence sags 10 rpm under the step's start drop 5%. One change per step, never while paused.
"""
from __future__ import annotations

import time

from trainer_coach.client import ClientError, CoachClient
from trainer_coach.safety import GuardError, check_target


def main(poll_s: float = 5) -> None:
    c = CoachClient()
    changed: set[int] = set()
    cad_at_start: dict[int, int] = {}
    seen_feel = None
    while True:
        try:
            r = c.state()
            evs = c.events(100)
        except ClientError as e:
            print(e)
            time.sleep(poll_s)
            continue
        st, ride = r["state"], (r["state"] or {}).get("ride")
        if not ride or not ride.get("started") or not ride.get("step"):
            time.sleep(poll_s)
            continue
        step, ftp, l30 = ride["step"]["index"], ride["ftp"], ride["last30"]
        tgt = ride.get("target_w")
        zones = (st.get("athlete") or {}).get("hr_zones")
        if ride["step"]["into_s"] >= 30:
            cad_at_start.setdefault(step, l30["cadence"])
        feel = next((e for e in reversed(evs) if e["type"] == "feel"), None)
        new, why = None, None
        if feel and feel["raw"] != seen_feel:
            seen_feel = feel["raw"]
            if feel["feel"] == "easier" and tgt:
                new, why = tgt - round(0.05 * ftp), "Easier"
        if new is None and tgt and step not in changed and tgt > 0.9 * ftp:
            hr, dhr = l30.get("hr"), l30.get("hr_delta")
            if zones and hr and hr >= zones[4] and (dhr or 0) >= 4:
                new, why = tgt - round(0.03 * ftp), f"HR {hr}, +{dhr}"
            elif step in cad_at_start and l30["cadence"] <= cad_at_start[step] - 10:
                new, why = tgt - round(0.05 * ftp), f"Cadence {l30['cadence']}"
        if new is not None:
            new = max(0, new // 5 * 5)
            try:
                check_target(st, r["age_s"], evs, step, new)
                c.coach(msg=f"{why}. {new} now.", step=step, watts=new)
                changed.add(step)
                print(f"step {step}: {tgt} -> {new} ({why})")
            except GuardError as e:
                print(f"skip: {e}")
        time.sleep(poll_s)


if __name__ == "__main__":
    main()
