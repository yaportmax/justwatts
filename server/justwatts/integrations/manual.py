"""Manual-upload-only services: listed so the rider sees the route for their FIT file, no automatic upload yet.
What each would need for a connector is in docs/INTEGRATIONS.md (Later)."""
from __future__ import annotations

from .base import Connector

SERVICES = (("coros", "COROS"), ("polar", "Polar"), ("suunto", "Suunto"), ("wahoo", "Wahoo"))


class ManualConnector(Connector):
    uploads = False
    connect_kind = None

    def __init__(self, sid: str, name: str):
        self.id, self.name = sid, name

    def status(self) -> dict:
        return {"connected": False, "manual_only": True}

    def disconnect(self) -> None:
        pass


def manual_only() -> list[ManualConnector]:
    return [ManualConnector(i, n) for i, n in SERVICES]
