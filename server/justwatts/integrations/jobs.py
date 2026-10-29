"""Upload jobs: one per (ride, service), run after the ride is saved, retried with backoff, persisted.

State lives in <data>/integrations/jobs.json, rewritten atomically after every change, so a restart resumes
pending uploads (a job caught mid-attempt runs again; services report the repeat as a duplicate).
Schedule: try now, again after 2 minutes, again 8 minutes later (3 tries over about 10 minutes).
`auth` and `blocked` stop at once; `duplicate` counts as done. Saving a ride never waits on any of this:
enqueue() only writes the job file and wakes the worker thread.
"""
from __future__ import annotations

import json
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Callable

from .base import ACTION, AUTH, BLOCKED, DUPLICATE, TEMPORARY, Connector, IntegrationError, RideMeta, scrub

DELAYS = (120, 480)          # seconds before try 2 and try 3
MAX_TRIES = len(DELAYS) + 1
MAX_RETRY_AFTER = 1800       # honour a service's Retry-After up to 30 minutes
KEEP_DONE_S = 90 * 86400     # finished jobs are forgotten after 90 days


class JobRunner:
    def __init__(self, path: Path, connectors: dict[str, Connector],
                 load: Callable[[str], tuple[bytes, RideMeta] | None],
                 on_result: Callable[[str, str, dict], None] | None = None,
                 log: Callable[[str], None] | None = None, clock: Callable[[], float] = time.time):
        self.path = Path(path)
        self.connectors = connectors
        self.load = load
        self.on_result = on_result or (lambda svc, rid, job: None)
        self.log = log or (lambda line: None)
        self.clock = clock
        self.lock = threading.RLock()
        self.wake = threading.Condition(self.lock)
        self.stopping = False
        self._thread: threading.Thread | None = None
        self.jobs: dict[str, dict] = self._load()

    # ---------- persistence ----------
    def _load(self) -> dict[str, dict]:
        try:
            jobs = json.loads(self.path.read_text(encoding="utf-8")).get("jobs") or {}
        except (OSError, ValueError, AttributeError):
            return {}
        now = self.clock()
        for j in jobs.values():
            if j.get("state") == "running":  # stopped mid-attempt: run it again now
                j.update(state="pending", next_at=now)
        return {k: v for k, v in jobs.items() if isinstance(v, dict)}

    def _save(self) -> None:
        now = self.clock()
        self.jobs = {k: j for k, j in self.jobs.items()
                     if j["state"] in ("pending", "running") or now - j.get("updated", now) < KEEP_DONE_S}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(f".{self.path.name}.{uuid.uuid4().hex}.tmp")
        tmp.write_text(json.dumps({"jobs": self.jobs}), encoding="utf-8")
        for attempt in range(50):
            try:
                os.replace(tmp, self.path)
                return
            except PermissionError:  # Windows: a reader has it open
                if attempt == 49:
                    raise
                time.sleep(0.01)

    # ---------- queue ----------
    @staticmethod
    def key(rid: str, svc: str) -> str:
        return f"{rid}:{svc}"

    def enqueue(self, rid: str, services: list[str], restart: bool = False) -> None:
        """New jobs run now. A finished job is left alone unless restart (a manual retry)."""
        now = self.clock()
        with self.lock:
            for svc in services:
                k = self.key(rid, svc)
                j = self.jobs.get(k)
                if j and j["state"] == "running":
                    continue
                if j and not restart and j["state"] in ("pending", "done", "failed"):
                    continue
                self.jobs[k] = {"ride_id": rid, "service": svc, "state": "pending", "tries": 0, "next_at": now,
                                "kind": None, "error": None, "created": (j or {}).get("created", now), "updated": now}
            self._save()
            self.wake.notify_all()

    def get(self, rid: str, svc: str) -> dict | None:
        with self.lock:
            j = self.jobs.get(self.key(rid, svc))
            return dict(j) if j else None

    def for_ride(self, rid: str) -> dict[str, dict]:
        with self.lock:
            return {j["service"]: dict(j) for j in self.jobs.values() if j["ride_id"] == rid}

    def next_due(self) -> float | None:
        with self.lock:
            due = [j["next_at"] for j in self.jobs.values() if j["state"] == "pending"]
            return min(due) if due else None

    # ---------- attempts ----------
    def run_due(self) -> int:
        """Run every job that is due now (one attempt each). Returns how many ran."""
        n = 0
        while True:
            now = self.clock()
            with self.lock:
                due = [j for j in self.jobs.values() if j["state"] == "pending" and j["next_at"] <= now]
                j = min(due, key=lambda j: j["next_at"]) if due else None
                if j is None:
                    return n
                self._begin(j)
            self._attempt(j)
            n += 1

    def run_now(self, rid: str, svc: str) -> dict:
        """One attempt right away (a button press). Waits for it; the retry schedule continues afterwards."""
        self.enqueue(rid, [svc], restart=True)
        with self.lock:
            j = self.jobs[self.key(rid, svc)]
            if j["state"] == "running":
                return dict(j)
            self._begin(j)
        self._attempt(j)
        return self.get(rid, svc) or {}

    def _begin(self, j: dict) -> None:
        j.update(state="running", tries=j["tries"] + 1, updated=self.clock())
        self._save()

    def _attempt(self, j: dict) -> None:
        svc, rid = j["service"], j["ride_id"]
        conn = self.connectors.get(svc)
        res: dict = {}
        err: IntegrationError | None = None
        try:
            if conn is None:
                raise IntegrationError(BLOCKED, f"unknown service {svc}")
            got = self.load(rid)
            if got is None:
                raise IntegrationError(BLOCKED, "ride not found")
            res = conn.upload(*got) or {}
        except IntegrationError as e:
            err = e
        except Exception as e:  # noqa: BLE001 - a connector bug must not kill the worker; retry it
            err = IntegrationError(TEMPORARY, f"{type(e).__name__}: {e}")
        now = self.clock()
        with self.lock:
            if err is not None and err.kind == DUPLICATE:
                res, err = {"duplicate": True}, None
            if err is None:
                j.update(state="done", kind=DUPLICATE if res.get("duplicate") else None, error=None, next_at=None,
                         activity_id=res.get("activity_id"), url=res.get("url"), duplicate=bool(res.get("duplicate")),
                         done_at=now, updated=now)
            else:
                msg = scrub(str(err), conn.secrets() if conn else [])[:300]
                again = err.kind == TEMPORARY and j["tries"] < MAX_TRIES
                wait = DELAYS[min(j["tries"], len(DELAYS)) - 1] if again else 0
                if again and err.retry_after:
                    wait = max(wait, min(err.retry_after, MAX_RETRY_AFTER))
                j.update(state="pending" if again else "failed", kind=err.kind, error=msg,
                         next_at=now + wait if again else None, updated=now)
            self._save()
            snap = dict(j)
        if snap["state"] == "done":
            self.log(f"UPLOAD {svc} {rid} {'duplicate' if snap['duplicate'] else 'ok'}")
        else:
            self.log(f"UPLOAD {svc} {rid} {snap['state']} {snap['kind']} (try {snap['tries']}): {snap['error']}"[:300])
        try:
            self.on_result(svc, rid, snap)
        except Exception:  # noqa: BLE001
            pass

    # ---------- worker thread ----------
    def start(self) -> None:
        if self._thread:
            return
        self._thread = threading.Thread(target=self._loop, name="uploads", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        with self.lock:
            self.stopping = True
            self.wake.notify_all()

    def _loop(self) -> None:
        while not self.stopping:
            try:
                self.run_due()
            except Exception as e:  # noqa: BLE001 - keep the worker alive
                self.log(f"UPLOAD worker error: {e}"[:200])
            with self.lock:
                if self.stopping:
                    return
                nxt = self.next_due()
                self.wake.wait(timeout=60 if nxt is None else max(0.05, min(60, nxt - self.clock())))


def public(job: dict | None, fallback: dict) -> dict | None:
    """What the page sees for one job. Every failure state carries the same FIT fallback."""
    if not job:
        return None
    out = {k: job.get(k) for k in ("service", "state", "kind", "error", "tries", "activity_id", "url", "duplicate")}
    out["max_tries"] = MAX_TRIES
    out["next_retry_at"] = int(job["next_at"] * 1000) if job.get("state") == "pending" and job.get("tries") else None
    out["updated_at"] = int(job.get("updated", 0) * 1000)
    out["action"] = ACTION.get(job.get("kind")) if job.get("state") in ("failed", "pending") and job.get("kind") else None
    if job.get("state") == "failed" or (job.get("state") == "pending" and job.get("kind")):
        out["fallback"] = fallback
    return out


__all__ = ["JobRunner", "public", "DELAYS", "MAX_TRIES", "AUTH", "BLOCKED", "TEMPORARY", "DUPLICATE"]
