"""Headless simulator end to end, and the CLI subcommands, against a test server."""
import json

from trainer_coach.cli import main
from trainer_coach.simulator import Simulator


def test_simulated_ride_full_loop(srv):
    srv.client.coach(msg="go", step=2, watts=210)  # queued before start, like a command sent during load
    sim = Simulator(srv.client, "1m 50%, 2m 110%, 1m 50%", ftp=200, speed=0, scenarios="fade,pause,harder", log=None)
    res = sim.run()
    assert res["finished"] and res["elapsed_s"] == 240
    assert res["ticks"] > 240  # pause added wall ticks without elapsed time
    assert res["applied"][0]["step"] == 2 and res["applied"][0]["w"] == 210 and res["messages"] == ["go"]
    evs = srv.client.events(500)
    types = [e["type"] for e in evs]
    assert types.index("ride_start") < types.index("step_start") and types[-1] == "ride_end"
    assert types.count("step_start") == 3 and types.count("step_end") == 3
    assert "tick" in types and "resumed" in types and "coach" in types
    assert any(e["type"] == "paused" and e["auto"] for e in evs)
    assert any(e["type"] == "feel" and e["feel"] == "harder" for e in evs)
    hard_start = next(e for e in evs if e["type"] == "step_start" and e["step"] == 2)
    assert hard_start["target_w"] == 210  # override arrived at tick 2, before step 2 began
    end2 = next(e for e in evs if e["type"] == "step_end" and e["step"] == 2)
    assert end2["target_w"] == 210 and end2["cadence"] < 85  # fade scenario: cadence sags late in hard steps
    assert "other" not in types
    final = srv.client.state()["state"]
    assert final["ride"] is None and final["source"] == "sim"
    assert not srv.cfg.current.exists()
    assert len(srv.client.history(3600)) > 50


def _run(capsys, srv, *argv):
    code = main([*argv, "--port", str(srv.port), "--data", str(srv.cfg.data)])
    return code, capsys.readouterr().out


def test_cli_coach_tail_status_token(srv, capsys):
    code, out = _run(capsys, srv, "coach", "msg", "HR", "160,", "hold")
    assert code == 0 and json.loads(out)["msg"] == "HR 160, hold"
    code, out = _run(capsys, srv, "coach", "set", "cur", "205", "--msg", "205 now")
    assert json.loads(out)["set"] == {"step": "cur", "w": 205}
    code, out = _run(capsys, srv, "coach", "set", "3", "180")
    assert json.loads(out)["set"] == {"step": 3, "w": 180}
    code, out = _run(capsys, srv, "tail", "-n", "2")
    lines = out.strip().splitlines()
    assert len(lines) == 2 and "COACH" in lines[0] and "set 3 180W" in lines[1]
    code, out = _run(capsys, srv, "tail", "-n", "1", "--json")
    assert json.loads(out)["set"] == {"step": 3, "w": 180}
    code, out = _run(capsys, srv, "status")
    assert json.loads(out)["state"]["ride"] is None
    code, out = _run(capsys, srv, "token")
    assert out.strip() == str(srv.cfg.token_file)


def test_cli_simulate(srv, capsys):
    code, out = _run(capsys, srv, "simulate", "--workout", "1m 50%, 30s 100%", "--speed", "0", "--scenario", "steady")
    assert code == 0
    res = json.loads(out.strip().splitlines()[-1])
    assert res["finished"] and res["elapsed_s"] == 90


def test_cli_error_when_server_down(tmp_path, capsys):
    from conftest import free_port
    (tmp_path / "token").write_text("abc")
    code = main(["coach", "msg", "hi", "--port", str(free_port()), "--data", str(tmp_path)])
    assert code == 2 and "cannot reach" in capsys.readouterr().err
