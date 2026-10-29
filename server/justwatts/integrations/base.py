"""Common pieces for every integration: errors, failure kinds, HTTP, secret files, manual-upload metadata.

A connector answers: status(), connect(fields), disconnect(), upload(fit, meta) and, where the service has a
calendar, planned(day). Failures raise IntegrationError with one of the kinds below; the job runner decides
what to do with each kind. Secrets live in <data>/integrations/<service>.json (mode 0600) and never leave
this computer: status() returns only names, ids and flags.
"""
from __future__ import annotations

import json
import os
import socket
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

AUTH, BLOCKED, TEMPORARY, DUPLICATE = "auth", "blocked", "temporary", "duplicate"
KINDS = (AUTH, BLOCKED, TEMPORARY, DUPLICATE)
ACTION = {AUTH: "reconnect", BLOCKED: "download_fit", TEMPORARY: "retry"}  # one action per failure (plan)
UA = "JustWatts/0.1 (+https://justwatts.com)"


class IntegrationError(Exception):
    def __init__(self, kind: str, message: str, retry_after: float | None = None):
        assert kind in KINDS, kind
        super().__init__(message)
        self.kind, self.retry_after = kind, retry_after


def kind_for_status(code: int) -> str:
    """HTTP status -> failure kind. Connectors override where a service means something else."""
    if code in (401, 419):
        return AUTH
    if code == 409:
        return DUPLICATE
    if code in (408, 425, 429) or code >= 500:
        return TEMPORARY
    return BLOCKED  # 403 (bot wall, refused), 400/404/413/415/422: retrying will not help


def retry_after(headers: dict) -> float | None:
    try:
        return max(0.0, float(headers.get("retry-after", "")))
    except ValueError:
        return None


@dataclass
class Resp:
    status: int
    headers: dict = field(default_factory=dict)  # lower-case names; set-cookie values joined by "\n"
    body: bytes = b""

    def json(self) -> Any:
        try:
            return json.loads(self.body or b"null")
        except ValueError:
            return None

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", "replace")


def http(method: str, url: str, data: bytes | None = None, headers: dict | None = None, timeout: float = 30) -> Resp:
    """Stdlib HTTP that returns every status as a Resp. Network trouble is a temporary failure."""
    req = urllib.request.Request(url, data=data, method=method, headers={"User-Agent": UA, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return Resp(r.status, _hdrs(r.headers), r.read())
    except urllib.error.HTTPError as e:
        return Resp(e.code, _hdrs(e.headers), e.read() or b"")
    except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, OSError) as e:
        raise IntegrationError(TEMPORARY, f"network: {getattr(e, 'reason', e)}"[:200]) from None


def _hdrs(h) -> dict:
    out: dict[str, str] = {}
    for k, v in (h.items() if h else []):
        k = k.lower()
        out[k] = out[k] + "\n" + v if k in out else v
    return out


def multipart(fields: dict[str, str], file_field: str, filename: str, data: bytes,
              ctype: str = "application/octet-stream") -> tuple[bytes, str]:
    b = uuid.uuid4().hex
    parts = [f'--{b}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode() for k, v in fields.items()]
    parts.append(f'--{b}\r\nContent-Disposition: form-data; name="{file_field}"; filename="{filename}"\r\n'
                 f"Content-Type: {ctype}\r\n\r\n".encode() + data + b"\r\n")
    parts.append(f"--{b}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={b}"


class SecretFile:
    """One JSON file of secrets per service, written atomically with mode 0600."""

    def __init__(self, path: Path):
        self.path = Path(path)

    def read(self) -> dict:
        try:
            v = json.loads(self.path.read_text(encoding="utf-8"))
            return v if isinstance(v, dict) else {}
        except (OSError, ValueError):
            return {}

    def write(self, obj: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(f".{self.path.name}.{uuid.uuid4().hex}.tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(obj, f)
        os.replace(tmp, self.path)

    def clear(self) -> None:
        self.path.unlink(missing_ok=True)


@dataclass
class RideMeta:
    ride_id: str
    name: str = "Just Watts ride"
    description: str = ""
    start_ms: int | None = None
    filename: str = "ride.fit"
    extra: dict = field(default_factory=dict)


# Owner copy for unofficial services (tooltip); the page renders the last words as the FIT link.
UNOFFICIAL_NOTE = ("Unfortunately {name} doesn't allow official integrations, so we use a little workaround. "
                   "It can break. If it does, upload the .fit file manually:")

# Manual upload routes, checked against public help pages (sources in docs/INTEGRATIONS.md).
# url: where the rider drops the file (None when the service only imports in its phone app or not at all).
MANUAL = {
    "garmin": {"url": "https://connect.garmin.com/modern/import-data",
               "steps": ["1. Download the .fit file.", "2. Open Garmin Connect Import Data.",
                         "3. Drop the file in and click Import Data."]},
    "strava": {"url": "https://www.strava.com/upload/select",
               "steps": ["1. Download the .fit file.", "2. Open Strava Upload.", "3. Choose the file."],
               "help_url": "https://support.strava.com/hc/en-us/articles/216917807-Uploading-Files-to-Strava"},
    "trainingpeaks": {"url": "https://app.trainingpeaks.com/#calendar",
                      "steps": ["1. Download the .fit file.", "2. Open your TrainingPeaks calendar.",
                                "3. Drag the file onto the calendar."],
                      "help_url": "https://help.trainingpeaks.com/hc/en-us/articles/204072994-How-do-I-manually-Upload-a-workout-file-into-TrainingPeaks"},
    "intervals": {"url": "https://intervals.icu/activities",
                  "steps": ["1. Download the .fit file.", "2. Open intervals.icu Activities.",
                            "3. Click the upload arrow and drop the file in."]},
    "coros": {"url": "https://t.coros.com/",
              "steps": ["1. Download the .fit file.", "2. Open COROS Training Hub, Activity List.",
                        "3. Click Import Data and choose the file."],
              "help_url": "https://support.coros.com/hc/en-us/articles/4412176269844-COROS-Training-Hub-Manual"},
    "wahoo": {"url": None, "app_only": True,
              "steps": ["1. Download the .fit file to your phone.", "2. Open the Wahoo app, Add Activity.",
                        "3. Tap Upload and choose the file."],
              "help_url": "https://support.wahoofitness.com/hc/en-us/articles/18790709768850"},
    "polar": {"url": None, "supported": False,
              "steps": ["Polar Flow has no file import.", "Upload to Garmin Connect or Strava instead."],
              "help_url": "https://support.polar.com/en/export-training-sessions-flow"},
    "suunto": {"url": None, "supported": False,
               "steps": ["The Suunto app has no workout file import.", "Upload to Garmin Connect or Strava instead."],
               "help_url": "https://us.suunto.com/pages/what-type-of-files-can-i-export-from-the-suunto-app"},
}
for _m in MANUAL.values():
    _m.setdefault("supported", True)
    _m.setdefault("app_only", False)
    _m.setdefault("help_url", None)


class Connector:
    """Base class. Subclasses set the class fields and implement the methods they support."""
    id = ""
    name = ""
    official = True
    uploads = True
    planned_workouts = False
    connect_kind = "fields"  # fields | oauth (the page follows connect_url) | cli
    fields: list[dict] = []  # [{name, label, secret, help}] for connect_kind == fields

    def status(self) -> dict:
        raise NotImplementedError

    def connect(self, fields: dict) -> dict:
        raise IntegrationError(BLOCKED, f"{self.name} connects another way")

    def disconnect(self) -> None:
        raise NotImplementedError

    def upload(self, fit: bytes, meta: RideMeta) -> dict:
        """-> {activity_id?, url?, duplicate?}. Raises IntegrationError."""
        raise NotImplementedError

    def planned(self, day: str) -> list[dict]:
        """Planned workouts on day (YYYY-MM-DD): [{id, name, date, text, duration_s, description, source}]."""
        return []

    def secrets(self) -> list[str]:
        """Every secret value this connector holds, so error text can be scrubbed before it is stored or logged."""
        return []

    # import (profile, past rides): connectors with imports = True answer these; see importing.py
    imports = False

    def import_profile(self) -> dict:
        raise IntegrationError(BLOCKED, f"{self.name} has no import")

    def import_list(self, since: str, until: str, start: int = 0) -> dict:
        raise IntegrationError(BLOCKED, f"{self.name} has no import")

    def import_fit(self, activity_id: str) -> bytes:
        raise IntegrationError(BLOCKED, f"{self.name} has no import")

    def describe(self) -> dict:
        d = {"id": self.id, "name": self.name, "official": self.official,
             "caps": {"upload": self.uploads, "planned": self.planned_workouts, "import": self.imports},
             "connect": {"kind": self.connect_kind, "fields": [dict(f) for f in self.fields]} if self.connect_kind else None,
             "manual": MANUAL.get(self.id)}
        if not self.official:
            d["unofficial_note"] = UNOFFICIAL_NOTE.format(name=self.name)
        return d


def scrub(text: str, secrets: list[str]) -> str:
    for s in sorted((s for s in secrets if s and len(s) >= 4), key=len, reverse=True):
        text = text.replace(s, "[hidden]")
    return text


Http = Callable[..., Resp]
