"""Command line: justwatts <serve|voice|login-garmin|coach|tail|status|simulate|mcp|token>."""
from __future__ import annotations

import argparse
import json
import sys
import time

from . import __version__
from .client import ClientError, CoachClient
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
    import os
    import subprocess

    from .server import serve
    cfg = _cfg(args)
    if args.no_garmin:
        cfg.garmin = False
    if args.no_ble:
        cfg.ble = False
    voice = None
    if args.voice:
        env = {**os.environ, "JUSTWATTS_PORT": str(cfg.port), "JUSTWATTS_DATA": str(cfg.data)}
        # the listener waits for the token file the server creates on start
        cfg.ensure_token()
        voice = subprocess.Popen([sys.executable, "-m", "justwatts", "voice", "--model", args.voice_model], env=env)
        print(f"voice listener started (pid {voice.pid}, model {args.voice_model})")
    try:
        serve(cfg)
    finally:
        if voice and voice.poll() is None:
            voice.terminate()
    return 0


def cmd_voice(args) -> int:
    import os
    from .voice import main as voice_main
    cfg = _cfg(args)
    os.environ["JUSTWATTS_PORT"], os.environ["JUSTWATTS_DATA"] = str(cfg.port), str(cfg.data)
    argv = ["--model", args.model] + (["--device", args.device] if args.device else [])
    return voice_main(argv)


def cmd_login(args) -> int:
    from .garmin import interactive_login
    interactive_login(_cfg(args).garmin_tokens)
    return 0


def cmd_coach(args) -> int:
    c = CoachClient(_cfg(args))
    if args.action == "msg":
        res = c.coach(msg=" ".join(args.text))
    elif args.action in ("insert", "replace", "delete", "duration", "extend"):
        step = lambda v: "cur" if v in (None, "cur") else int(v)  # noqa: E731
        edit = {"insert": lambda: {"op": "insert", "steps": args.steps, "after": step(args.after)},
                "replace": lambda: {"op": "replace", "step": step(args.step), "steps": args.steps},
                "delete": lambda: {"op": "delete", "step": step(args.step)},
                "duration": lambda: {"op": "duration", "step": step(args.step), "seconds": args.seconds},
                "extend": lambda: {"op": "extend", "seconds": args.seconds}}[args.action]()
        res = c.coach(msg=args.msg, edit=edit)
    else:
        step = "cur" if args.step == "cur" else int(args.step)
        res = c.coach(msg=args.msg, step=step, watts=args.watts)
    print(json.dumps(res))
    return 0


def cmd_tail(args) -> int:
    """Follow the event log file directly (it lives in the local data dir), like `tail -f`.
    With --agent: follow the gated agent stream instead (one line per batch = one agent wake)."""
    from .events import parse_line, tail_lines
    if args.agent:
        c = CoachClient(_cfg(args))
        since = c.agent_events(0)["next"] if args.follow else max(0, c.agent_events(0)["next"] - args.n)
        if not args.follow:
            for b in c.agent_events(since)["batches"]:
                print(json.dumps(b) if args.json else _batch_line(b), flush=True)
            return 0
        while True:
            res = c.agent_events(since, wait=60)
            for b in res["batches"]:
                print(json.dumps(b) if args.json else _batch_line(b), flush=True)
            since = res["next"]
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


def _batch_line(b: dict) -> str:
    t = time.strftime("%H:%M:%S", time.localtime(b["ts"]))
    return f"[{t}] #{b['seq']} " + " || ".join(f"{e['kind']}: {e['text']}" for e in b["events"])


def cmd_status(args) -> int:
    print(json.dumps(CoachClient(_cfg(args)).state(), indent=2))
    return 0


def cmd_simulate(args) -> int:
    from .simulator import Simulator
    sim = Simulator(CoachClient(_cfg(args)), args.workout, ftp=args.ftp, name=args.name, speed=args.speed,
                    scenarios=args.scenario, seed=args.seed)
    print(json.dumps(sim.run()))
    return 0


def cmd_mcp(args) -> int:
    try:
        from .mcp_server import main
    except ImportError as e:
        print(f"MCP SDK missing ({e}): pip install 'justwatts[mcp]'", file=sys.stderr)
        return 1
    if args.port or args.data:
        import os
        if args.port:
            os.environ["JUSTWATTS_PORT"] = str(args.port)
        if args.data:
            os.environ["JUSTWATTS_DATA"] = args.data
    main()
    return 0


def cmd_token(args) -> int:
    cfg = _cfg(args)
    tok = cfg.ensure_token()
    print(tok if args.show else cfg.token_file)
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="justwatts", description="AI agent coaching for smart bike trainers.")
    p.add_argument("--version", action="version", version=f"justwatts {__version__}")
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--port", type=int, help="server port (env JUSTWATTS_PORT, default 8765)")
    common.add_argument("--data", help="data dir (env JUSTWATTS_DATA, default ~/.justwatts)")
    sub = p.add_subparsers(dest="cmd", required=True)

    sv = sub.add_parser("serve", parents=[common], help="run the local server + web app")
    sv.add_argument("--voice", action="store_true", help="also start the Whisper voice listener ([voice] extra)")
    sv.add_argument("--voice-model", default="small.en")
    sv.add_argument("--no-garmin", action="store_true", help="disable Garmin entirely (also: JUSTWATTS_GARMIN=off)")
    sv.add_argument("--no-ble", action="store_true", help="disable Bluetooth (also: JUSTWATTS_BLE=off)")
    sv.set_defaults(fn=cmd_serve)
    vo = sub.add_parser("voice", parents=[common], help="run only the Whisper voice listener")
    vo.add_argument("--model", default="small.en")
    vo.add_argument("--device", help="input device name or index")
    vo.set_defaults(fn=cmd_voice)
    sub.add_parser("login-garmin", parents=[common], help="one-time Garmin Connect sign-in").set_defaults(fn=cmd_login)

    co = sub.add_parser("coach", help="send a command to the ride")
    cs = co.add_subparsers(dest="action", required=True)
    m = cs.add_parser("msg", parents=[common], help="show a message on screen")
    m.add_argument("text", nargs="+")
    s = cs.add_parser("set", parents=[common], help="override a step's target watts (no guard rails)")
    s.add_argument("step", help="1-based step number or 'cur'")
    s.add_argument("watts", type=int)
    s.add_argument("--msg", help="also show this message")
    e = cs.add_parser("insert", parents=[common], help="insert steps, e.g. '2x(5m 250w, 3m 50%%)'")
    e.add_argument("steps")
    e.add_argument("--after", help="1-based step number (default: after the current step)")
    e.add_argument("--msg")
    e = cs.add_parser("replace", parents=[common], help="replace a step with new steps")
    e.add_argument("step")
    e.add_argument("steps")
    e.add_argument("--msg")
    e = cs.add_parser("delete", parents=[common], help="remove a step ('cur' ends the current step now)")
    e.add_argument("step")
    e.add_argument("--msg")
    e = cs.add_parser("duration", parents=[common], help="set a step's duration in seconds")
    e.add_argument("step")
    e.add_argument("seconds", type=int)
    e.add_argument("--msg")
    e = cs.add_parser("extend", parents=[common], help="lengthen (+) or shorten (-) the current step, seconds")
    e.add_argument("seconds", type=int)
    e.add_argument("--msg")
    co.set_defaults(fn=cmd_coach)

    t = sub.add_parser("tail", parents=[common], help="print recent events, -f to follow")
    t.add_argument("-n", type=int, default=20)
    t.add_argument("-f", "--follow", action="store_true")
    t.add_argument("--json", action="store_true", help="print parsed events as JSON lines")
    t.add_argument("--agent", action="store_true", help="follow the gated agent stream (what wakes the coach)")
    t.set_defaults(fn=cmd_tail)

    sub.add_parser("status", parents=[common], help="print the latest ride state JSON").set_defaults(fn=cmd_status)

    sm = sub.add_parser("simulate", parents=[common], help="drive a fake ride through the server (no hardware)")
    sm.add_argument("--workout", default="5m 50-70%, 3x(3m 110%, 2m 50%), 5m 50%")
    sm.add_argument("--ftp", type=int, default=200)
    sm.add_argument("--name", default="Simulated workout")
    sm.add_argument("--speed", type=float, default=10, help="sim seconds per real second, 0 = as fast as possible")
    sm.add_argument("--scenario", default="steady", help="comma list: steady, fade, pause, easier, harder")
    sm.add_argument("--seed", type=int, default=1)
    sm.set_defaults(fn=cmd_simulate)

    sub.add_parser("mcp", parents=[common], help="run the MCP server on stdio").set_defaults(fn=cmd_mcp)
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
