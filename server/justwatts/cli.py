"""Command line: justwatts <serve|login-garmin|tail|status|simulate|token>."""
from __future__ import annotations

import argparse
import json
import sys
import time

from . import __version__
from .client import Client, ClientError
from .config import Config


def _cfg(args) -> Config:
    cfg = Config()
    if getattr(args, "port", None):
        cfg.port = args.port
    if getattr(args, "data", None):
        from pathlib import Path
        cfg.data = Path(args.data).expanduser()
    return cfg


def cmd_serve(args) -> int:
    from .server import serve
    cfg = _cfg(args)
    if args.no_garmin:
        cfg.garmin = False
    if args.no_ble:
        cfg.ble = False
    serve(cfg)
    return 0


def cmd_login(args) -> int:
    from .garmin import interactive_login
    interactive_login(_cfg(args).garmin_tokens)
    return 0


def cmd_tail(args) -> int:
    """Follow the event log file directly (it lives in the local data dir), like `tail -f`."""
    from .events import parse_line, tail_lines
    log = _cfg(args).events_log
    out = (lambda ln: print(json.dumps(parse_line(ln)), flush=True)) if args.json else (lambda ln: print(ln, flush=True))
    for ln in tail_lines(log, args.n):
        out(ln)
    if not args.follow:
        return 0
    pos = log.stat().st_size if log.exists() else 0
    buf = b""
    while True:
        time.sleep(0.5)
        if not log.exists():
            continue
        size = log.stat().st_size
        if size < pos:  # truncated or replaced
            pos = 0
        if size > pos:
            with log.open("rb") as f:
                f.seek(pos)
                buf += f.read()
                pos = f.tell()
            *lines, buf = buf.split(b"\n")
            for ln in lines:
                out(ln.decode("utf-8", "replace").rstrip("\r"))


def cmd_status(args) -> int:
    print(json.dumps(Client(_cfg(args)).state(), indent=2))
    return 0


def cmd_simulate(args) -> int:
    """No trainer: switch the server to its fake trainer and start a workout on it (watch it in the page)."""
    c = Client(_cfg(args))
    c.devices(action="sim", kind="trainer", on=True)
    c.control("load", workout={"name": args.name, "text": args.workout})
    c.control("start")
    r = c.state()["state"]["ride"]
    print(json.dumps({"name": r["name"], "steps": len(r["steps"] or []), "total_s": r["total_s"], "started": r["started"]}))
    return 0


def cmd_token(args) -> int:
    cfg = _cfg(args)
    tok = cfg.ensure_token()
    print(tok if args.show else cfg.token_file)
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="justwatts", description="Smart-trainer app: local server for ERG workouts and free rides.")
    p.add_argument("--version", action="version", version=f"justwatts {__version__}")
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--port", type=int, help="server port (env JUSTWATTS_PORT, default 8765)")
    common.add_argument("--data", help="data dir (env JUSTWATTS_DATA, default ~/.justwatts)")
    sub = p.add_subparsers(dest="cmd", required=True)

    sv = sub.add_parser("serve", parents=[common], help="run the local server + web app")
    sv.add_argument("--no-garmin", action="store_true", help="disable Garmin entirely (also: JUSTWATTS_GARMIN=off)")
    sv.add_argument("--no-ble", action="store_true", help="disable Bluetooth (also: JUSTWATTS_BLE=off)")
    sv.set_defaults(fn=cmd_serve)
    sub.add_parser("login-garmin", parents=[common], help="one-time Garmin Connect sign-in").set_defaults(fn=cmd_login)

    t = sub.add_parser("tail", parents=[common], help="print recent events, -f to follow")
    t.add_argument("-n", type=int, default=20)
    t.add_argument("-f", "--follow", action="store_true")
    t.add_argument("--json", action="store_true", help="print parsed events as JSON lines")
    t.set_defaults(fn=cmd_tail)

    sub.add_parser("status", parents=[common], help="print the latest ride state JSON").set_defaults(fn=cmd_status)

    sm = sub.add_parser("simulate", parents=[common], help="ride a workout on the server's fake trainer (no hardware)")
    sm.add_argument("--workout", default="5m 50-70%, 3x(3m 110%, 2m 50%), 5m 50%")
    sm.add_argument("--name", default="Simulated workout")
    sm.set_defaults(fn=cmd_simulate)

    tk = sub.add_parser("token", parents=[common], help="print the API token file path (--show for the value)")
    tk.add_argument("--show", action="store_true")
    tk.set_defaults(fn=cmd_token)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.fn(args)
    except ClientError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 130
