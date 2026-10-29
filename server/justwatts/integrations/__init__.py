"""Integrations hub: the services a rider connects, their auto-upload choice, upload jobs and planned workouts.

Non-secret state (auto flags, last success, last error) is in <data>/integrations/state.json; secrets in
<data>/integrations/<service>.json (0600, never sent to the page); jobs in <data>/integrations/jobs.json.
Garmin comes first and is the one riders are nudged to connect: Garmin Connect forwards rides to Strava,
TrainingPeaks and intervals.icu when the rider linked them there, so direct uploads to those default to off
while Garmin is connected (an explicit choice by the rider wins).
"""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Callable

from .base import (ACTION, AUTH, BLOCKED, DUPLICATE, KINDS, MANUAL, TEMPORARY, Connector, IntegrationError, RideMeta,
                   scrub)
from .jobs import JobRunner, public

ORDER = ("garmin", "strava", "trainingpeaks", "intervals", "coros", "polar", "suunto", "wahoo")
RECOMMENDED = ("garmin",)
GARMIN_REASON = "Uploads here can sync on to apps you link in Garmin Connect."
GARMIN_REASON_SYNCS = "Garmin also sends your rides to {names}."
SYNC_OPTIONS = ("strava", "trainingpeaks", "intervals", "other")  # what Garmin Connect can forward rides to
SYNC_QUESTION = {"id": "garmin_syncs", "text": "Does your Garmin account already send rides to:",
                 "options": [{"id": "strava", "label": "Strava"}, {"id": "trainingpeaks", "label": "TrainingPeaks"},
                             {"id": "other", "label": "other"}]}
DUP_WARNING = "Garmin already syncs to {name}. Uploading to both makes duplicates."
FIT_LABEL = "upload the .fit file manually"


class Integrations:
    def __init__(self, data: Path, connectors: list[Connector], load: Callable[[str], tuple[bytes, RideMeta] | None],
                 log: Callable[[str], None] | None = None, clock: Callable[[], float] = time.time,
                 auto_hooks: dict[str, tuple[Callable[[], bool], Callable[[bool], None]]] | None = None,
                 on_done: Callable[[str, str, dict], None] | None = None):
        self.dir = Path(data) / "integrations"
        self.conns = {c.id: c for c in sorted(connectors, key=lambda c: ORDER.index(c.id) if c.id in ORDER else 99)}
        self.log = log or (lambda line: None)
        self.clock = clock
        self.auto_hooks = auto_hooks or {}
        self.on_done = on_done or (lambda svc, rid, job: None)
        self.lock = threading.Lock()
        self.runner = JobRunner(self.dir / "jobs.json", self.conns, load, self._result, self.log, clock)

    # ---------- state ----------
    @property
    def state_file(self) -> Path:
        return self.dir / "state.json"

    def _state(self) -> dict:
        try:
            v = json.loads(self.state_file.read_text(encoding="utf-8"))
            return v if isinstance(v, dict) else {}
        except (OSError, ValueError):
            return {}

    def _patch(self, svc: str, **kw) -> None:
        with self.lock:
            st = self._state()
            st[svc] = {**st.get(svc, {}), **kw}
            self.dir.mkdir(parents=True, exist_ok=True)
            from ..server import atomic_write
            atomic_write(self.state_file, json.dumps(st).encode())

    def _result(self, svc: str, rid: str, job: dict) -> None:
        at = int(self.clock() * 1000)
        if job["state"] == "done":
            self._patch(svc, last_success={"ride_id": rid, "at": at}, last_error=None)
            self.on_done(svc, rid, job)
        elif job.get("kind"):
            self._patch(svc, last_error={"ride_id": rid, "kind": job["kind"], "error": job["error"], "at": at,
                                         "final": job["state"] == "failed"})

    def connected(self, svc: str) -> bool:
        c = self.conns.get(svc)
        try:
            return bool(c and c.status().get("connected"))
        except Exception:  # noqa: BLE001
            return False

    def auto(self, svc: str) -> bool:
        if not getattr(self.conns.get(svc), "uploads", False):
            return False
        if svc in self.auto_hooks:
            return bool(self.auto_hooks[svc][0]())
        v = self._state().get(svc, {}).get("auto")
        if v is not None:
            return bool(v)
        return not (svc in (self.syncs_to() or []) and self.connected("garmin"))

    # ---------- what Garmin Connect forwards rides to ----------
    def syncs_to(self) -> list[str] | None:
        """Services the rider's Garmin account sends rides on to, as the rider answered. None = not asked yet."""
        v = self._state().get("garmin", {}).get("syncs_to")
        return [x for x in v if x in SYNC_OPTIONS] if isinstance(v, list) else None

    def set_syncs_to(self, services) -> list[str]:
        if not isinstance(services, list):
            raise ValueError("syncs_to must be a list")
        clean = sorted({str(x) for x in services if str(x) in SYNC_OPTIONS})
        self._patch("garmin", syncs_to=clean)
        return clean

    def set_auto(self, svc: str, on: bool) -> None:
        self._get(svc)
        if svc in self.auto_hooks:
            self.auto_hooks[svc][1](bool(on))
        else:
            self._patch(svc, auto=bool(on))

    def _get(self, svc: str) -> Connector:
        c = self.conns.get(svc)
        if c is None:
            raise KeyError(svc)
        return c

    # ---------- page API ----------
    def list(self) -> list[dict]:
        state, garmin_on, syncs = self._state(), self.connected("garmin"), self.syncs_to()
        out = []
        for svc, c in self.conns.items():
            d = c.describe()
            try:
                st = c.status()
            except Exception as e:  # noqa: BLE001 - a broken integration never hides the others
                st = {"connected": False, "error": scrub(str(e), c.secrets())[:200]}
            s = state.get(svc, {})
            last_err = s.get("last_error")
            auto = self.auto(svc)
            d.update(status=st, auto=auto, last_success=s.get("last_success"), last_error=last_err,
                     needs_reconnect=bool(last_err and last_err.get("kind") == AUTH),
                     recommended=svc in RECOMMENDED)
            if svc == "garmin":
                names = [self.conns[x].name for x in syncs or [] if x in self.conns]
                d["recommended_reason"] = GARMIN_REASON_SYNCS.format(names=" and ".join(names)) if names else GARMIN_REASON
                d["syncs_to"] = syncs
                d["syncs_question"] = SYNC_QUESTION if garmin_on and syncs is None else None
            if svc in SYNC_OPTIONS:
                synced = garmin_on and svc in (syncs or [])
                d["synced_by_garmin"] = synced
                d["duplicate_risk"] = bool(synced and st.get("connected") and auto)
                d["duplicate_warning"] = DUP_WARNING.format(name=c.name) if synced else None
            out.append(d)
        return out

    def connect(self, svc: str, fields: dict, ride_id: str | None = None) -> dict:
        """Connect; with ride_id, queue that ride's upload at once (connect, then upload this ride now)."""
        c = self._get(svc)
        res = dict(c.connect(fields or {}))
        if res.get("connected"):
            self._patch(svc, last_error=None)
            self.log(f"INTEGRATION {svc} connected")
            if svc == "garmin":
                res["syncs_to"] = self.syncs_to()
                if res["syncs_to"] is None:
                    res["question"] = SYNC_QUESTION  # asked once; the answer sets the direct-upload defaults
            if ride_id:
                res["upload"] = self.retry(ride_id, svc)
        elif ride_id:
            res["ride_id"] = ride_id  # finish the MFA step (or OAuth) with the same ride id
        return res

    def disconnect(self, svc: str) -> None:
        self._get(svc).disconnect()
        self._patch(svc, last_error=None)
        self.log(f"INTEGRATION {svc} disconnected")

    def after_ride(self, rid: str) -> list[str]:
        """Queue uploads for a saved ride: every connected service with auto upload on. Never raises."""
        try:
            svcs = [s for s, c in self.conns.items() if c.uploads and self.connected(s) and self.auto(s)]
            if svcs:
                self.runner.enqueue(rid, svcs)
            return svcs
        except Exception as e:  # noqa: BLE001 - saving a ride must never fail because of an upload
            self.log(f"UPLOAD queue failed: {e}"[:200])
            return []

    def fallback(self, svc: str, rid: str) -> dict:
        return {"ride_id": rid, "fit_url": f"/api/rides/{rid}/fit", "label": FIT_LABEL, "manual": MANUAL.get(svc)}

    def ride_uploads(self, rid: str) -> dict:
        jobs = self.runner.for_ride(rid)
        return {"ride_id": rid, "fit_url": f"/api/rides/{rid}/fit",
                "uploads": {svc: public(jobs.get(svc), self.fallback(svc, rid)) for svc in self.conns if svc in jobs}}

    def targets(self, rid: str) -> dict:
        """Everything one Upload button on the ride summary needs: per service connected, recommended,
        this ride's upload state and the manual route. `any_connected` false = render "connect something"."""
        jobs, rows = self.runner.for_ride(rid), []
        for d in self.list():
            svc = d["id"]
            if not d["caps"]["upload"] and not d["manual"]:
                continue
            rows.append({"id": svc, "name": d["name"], "official": d["official"], "unofficial_note": d.get("unofficial_note"),
                         "connected": bool(d["status"].get("connected")), "auto": d["auto"] and d["caps"]["upload"],
                         "manual_only": not d["caps"]["upload"],
                         "recommended": d["recommended"], "recommended_reason": d.get("recommended_reason"),
                         "needs_reconnect": d["needs_reconnect"], "duplicate_risk": d.get("duplicate_risk", False),
                         "duplicate_warning": d.get("duplicate_warning"), "connect": d["connect"], "manual": d["manual"],
                         "upload": public(jobs.get(svc), self.fallback(svc, rid))})
        return {"ride_id": rid, "fit_url": f"/api/rides/{rid}/fit", "fit_label": FIT_LABEL,
                "any_connected": any(r["connected"] for r in rows), "targets": rows}

    def retry(self, rid: str, svc: str) -> dict:
        """Queue (or re-queue) one upload now; the worker runs it."""
        self._get(svc)
        self.runner.enqueue(rid, [svc], restart=True)
        return public(self.runner.get(rid, svc), self.fallback(svc, rid))

    def planned(self, day: str) -> dict:
        out, errors = [], {}
        for svc, c in self.conns.items():
            if not c.planned_workouts or not self.connected(svc):
                continue
            try:
                for w in c.planned(day):
                    out.append({**w, "source": svc})
            except IntegrationError as e:
                errors[svc] = {"kind": e.kind, "error": scrub(str(e), c.secrets())[:200], "action": ACTION.get(e.kind)}
                if e.kind == AUTH:
                    self._patch(svc, last_error={"kind": AUTH, "error": errors[svc]["error"], "at": int(self.clock() * 1000)})
            except Exception as e:  # noqa: BLE001
                errors[svc] = {"kind": TEMPORARY, "error": scrub(f"{type(e).__name__}: {e}", c.secrets())[:200], "action": "retry"}
        return {"date": day, "workouts": out, "errors": errors}

    def start(self) -> None:
        self.runner.start()

    def stop(self) -> None:
        self.runner.stop()


__all__ = ["Integrations", "IntegrationError", "RideMeta", "Connector", "AUTH", "BLOCKED", "TEMPORARY", "DUPLICATE", "KINDS"]
