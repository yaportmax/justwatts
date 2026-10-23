"""Paths, port and the local API token.

Environment:
  OPENSPIN_PORT            port of the local server (default 8765)
  OPENSPIN_DATA            data dir for rides/, coach/ and the token (default ~/.openspin)
  OPENSPIN_GARMIN_TOKENS   python-garminconnect token dir (default ~/.garminconnect)
  OPENSPIN_TOKEN           API token for CLI/MCP callers (default: read from <data>/token)
  OPENSPIN_APP             directory with the web UI (default: bundled app/)
  OPENSPIN_GARMIN          off = Garmin disabled entirely (tests and dev servers). on = force enable.
                     Default: enabled only for the default data dir or when OPENSPIN_GARMIN_TOKENS is set,
                     so a scratch server never reaches the real Garmin account by accident.
  OPENSPIN_BLE             off = no Bluetooth (the server never imports bleak)

The old HW_* names (HW_PORT, HW_DATA, ...) are still read when the OPENSPIN_* name is not set.
A data dir left at ~/.trainer-coach by earlier versions is moved to ~/.openspin on first start.
"""
from __future__ import annotations

import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_PORT = 8765
DEFAULT_DATA = Path("~/.openspin").expanduser()
LEGACY_DATA = Path("~/.trainer-coach").expanduser()


def env(name: str, default: str | None = None) -> str | None:
    """OPENSPIN_<name>, falling back to the legacy HW_<name>."""
    for key in (f"OPENSPIN_{name}", f"HW_{name}"):
        v = os.environ.get(key)
        if v is not None and v != "":
            return v
    return default


def _flag(name: str) -> str:
    return (env(name.removeprefix("OPENSPIN_")) or "").strip().lower()


def migrate_legacy_data(new: Path | None = None, old: Path | None = None) -> bool:
    """Move the pre-rename data dir to the new default location once. Returns True if moved."""
    new, old = new or DEFAULT_DATA, old or LEGACY_DATA
    if new.exists() or not old.is_dir():
        return False
    import shutil
    new.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(old), str(new))
    return True


def _app_dir() -> Path:
    if env("APP"):
        return Path(env("APP")).resolve()
    here = Path(__file__).resolve().parent
    for cand in (here / "app", here.parent.parent / "app"):  # wheel install, then repo checkout
        if (cand / "index.html").exists():
            return cand
    return here.parent.parent / "app"


@dataclass
class Config:
    port: int = field(default_factory=lambda: int(env("PORT", str(DEFAULT_PORT))))
    data: Path = field(default_factory=lambda: Path(env("DATA", "~/.openspin")).expanduser())
    garmin_tokens: Path = field(default_factory=lambda: Path(env("GARMIN_TOKENS", "~/.garminconnect")).expanduser())
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
        f = _flag("OPENSPIN_GARMIN")
        if f in ("off", "0", "false", "no"):
            return False
        if f in ("on", "1", "true", "yes"):
            return True
        return self.is_default_data or bool(env("GARMIN_TOKENS"))

    @property
    def ble_enabled(self) -> bool:
        if self.ble is not None:
            return self.ble
        return _flag("OPENSPIN_BLE") not in ("off", "0", "false", "no")

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
        if env("TOKEN"):
            return env("TOKEN").strip()
        try:
            return self.token_file.read_text(encoding="utf-8").strip() or None
        except OSError:
            return None
