"""Paths, port and the local API token.

Environment:
  HW_PORT            port of the local server (default 8765)
  HW_DATA            data dir for rides/, coach/ and the token (default ~/.trainer-coach)
  HW_GARMIN_TOKENS   python-garminconnect token dir (default ~/.garminconnect)
  HW_TOKEN           API token for CLI/MCP callers (default: read from <data>/token)
  HW_APP             directory with the web UI (default: bundled app/)
  HW_GARMIN          off = Garmin disabled entirely (tests and dev servers). on = force enable.
                     Default: enabled only for the default data dir or when HW_GARMIN_TOKENS is set,
                     so a scratch server never reaches the real Garmin account by accident.
  HW_BLE             off = no Bluetooth (the server never imports bleak)
"""
from __future__ import annotations

import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_PORT = 8765
DEFAULT_DATA = Path("~/.trainer-coach").expanduser()


def _flag(name: str) -> str:
    return os.environ.get(name, "").strip().lower()


def _app_dir() -> Path:
    if os.environ.get("HW_APP"):
        return Path(os.environ["HW_APP"]).resolve()
    here = Path(__file__).resolve().parent
    for cand in (here / "app", here.parent.parent / "app"):  # wheel install, then repo checkout
        if (cand / "index.html").exists():
            return cand
    return here.parent.parent / "app"


@dataclass
class Config:
    port: int = field(default_factory=lambda: int(os.environ.get("HW_PORT", DEFAULT_PORT)))
    data: Path = field(default_factory=lambda: Path(os.environ.get("HW_DATA", "~/.trainer-coach")).expanduser())
    garmin_tokens: Path = field(default_factory=lambda: Path(os.environ.get("HW_GARMIN_TOKENS", "~/.garminconnect")).expanduser())
    app: Path = field(default_factory=_app_dir)
    garmin: bool | None = None  # None = decide from env + data dir (see garmin_enabled)
    ble: bool | None = None

    @property
    def is_default_data(self) -> bool:
        try:
            return self.data.resolve() == DEFAULT_DATA.resolve()
        except OSError:
            return False

    @property
    def garmin_enabled(self) -> bool:
        if self.garmin is not None:
            return self.garmin
        f = _flag("HW_GARMIN")
        if f in ("off", "0", "false", "no"):
            return False
        if f in ("on", "1", "true", "yes"):
            return True
        return self.is_default_data or bool(os.environ.get("HW_GARMIN_TOKENS"))

    @property
    def ble_enabled(self) -> bool:
        if self.ble is not None:
            return self.ble
        return _flag("HW_BLE") not in ("off", "0", "false", "no")

    @property
    def rides(self) -> Path:
        return self.data / "rides"

    @property
    def coach_dir(self) -> Path:
        return self.data / "coach"

    @property
    def events_log(self) -> Path:
        return self.coach_dir / "events.log"

    @property
    def current(self) -> Path:
        return self.coach_dir / "current.json"

    @property
    def token_file(self) -> Path:
        return self.data / "token"

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def ensure_token(self) -> str:
        """Return the API token, creating it (mode 0600) on first run."""
        f = self.token_file
        if f.exists():
            tok = f.read_text(encoding="utf-8").strip()
            if tok:
                return tok
        f.parent.mkdir(parents=True, exist_ok=True)
        tok = secrets.token_urlsafe(32)
        fd = os.open(f, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(tok + "\n")
        return tok

    def read_token(self) -> str | None:
        if os.environ.get("HW_TOKEN"):
            return os.environ["HW_TOKEN"].strip()
        try:
            return self.token_file.read_text(encoding="utf-8").strip() or None
        except OSError:
            return None
