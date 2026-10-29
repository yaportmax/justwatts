"""CLI subcommands against a test server."""
import json

from justwatts.cli import main


def _run(capsys, srv, *argv):
    code = main([*argv, "--port", str(srv.port), "--data", str(srv.cfg.data)])
    return code, capsys.readouterr().out


def test_cli_tail_status_token(srv, capsys):
    srv.server.log_event("RIDE START Test | FTP 200 | free")
    srv.server.log_event("MANUAL target step 3 180W")
    code, out = _run(capsys, srv, "tail", "-n", "2")
    lines = out.strip().splitlines()
    assert code == 0 and len(lines) == 2 and "RIDE START" in lines[0] and "step 3 180W" in lines[1]
    code, out = _run(capsys, srv, "tail", "-n", "1", "--json")
    assert json.loads(out)["type"] == "manual"
    code, out = _run(capsys, srv, "status")
    assert json.loads(out)["state"]["ride"] is None
    code, out = _run(capsys, srv, "token")
    assert out.strip() == str(srv.cfg.token_file)


def test_cli_simulate(srv, capsys):
    code, out = _run(capsys, srv, "simulate", "--workout", "1m 50%, 30s 100%")
    assert code == 0
    res = json.loads(out.strip().splitlines()[-1])
    assert res == {"name": "Simulated workout", "steps": 2, "total_s": 90, "started": True}
    assert srv.server.hub.mode == "sim"
    for _ in range(5):
        srv.server.engine.tick(1.0)
    assert srv.client.state()["state"]["ride"]["samples"] == 5  # the fake trainer rides it


def test_cli_error_when_server_down(tmp_path, capsys):
    import socket
    (tmp_path / "token").write_text("abc")
    with socket.socket() as s:  # bound, never listening: nothing can answer on this port
        s.bind(("127.0.0.1", 0))
        code = main(["status", "--port", str(s.getsockname()[1]), "--data", str(tmp_path)])
    assert code == 2 and "cannot reach" in capsys.readouterr().err
