"""Whisper transcript filters (no mic, no model) and the Garmin/BLE kill switches."""
from types import SimpleNamespace

import pytest

from trainer_coach import voice as V
from trainer_coach.config import Config


def seg(text, nsp=0.05, alp=-0.3):
    return SimpleNamespace(text=text, no_speech_prob=nsp, avg_logprob=alp)


@pytest.mark.parametrize("text", ["Thank you.", "Thanks.", "Thank you very much.", "Thanks for watching!", " you ",
                                  "[Music]", "(silence)", "Thank you. Thank you.", "Bye.", "", "..."])
def test_hallucinations_dropped(text):
    assert V.accept([seg(text)]) is None


@pytest.mark.parametrize("text,keep", [
    ("Make it a bit easier please", True),
    ("Easier", True), ("harder!", True), ("Stop.", True), ("pause", True), ("skip it", True), ("help", True),
    ("okay then", False), ("Yeah", False), ("oh wow", False),
    ("That interval felt really hard", True),
])
def test_fragments_need_three_words_or_a_command(text, keep):
    assert (V.accept([seg(text)]) is not None) is keep


def test_low_confidence_segments_dropped():
    assert V.accept([seg("I want to stop now", nsp=0.6)]) is None
    assert V.accept([seg("I want to stop now", alp=-0.95)]) is None
    assert V.accept([seg("I want to stop now", nsp=0.49, alp=-0.89)]) == "I want to stop now"
    # one doubtful segment is dropped, the confident one kept
    assert V.accept([seg("Thank you.", nsp=0.9), seg("this is too hard")]) == "this is too hard"


def test_echo_of_coach_messages_dropped():
    now = [1000.0]
    echo = V.CoachEcho(lambda since: [{"seq": 5, "msg": "HR 168. Dropping to 275 now."}], clock=lambda: now[0])
    echo.poll()
    assert V.accept([seg("dropping to 275 now")], echo) is None
    assert V.accept([seg("my legs are burning badly")], echo) == "my legs are burning badly"
    now[0] += 61
    echo.next_check = 0
    echo.fetch = lambda since: []
    echo.poll()
    assert V.accept([seg("dropping to 275 now")], echo) == "dropping to 275 now"


def test_energy_gate_starts_at_4x_noise():
    g = V.PhraseGate(floor=0.005)
    for _ in range(200):
        assert g.feed("n", 0.005) is None  # learns the floor
    assert g.feed("x", 0.018) is None and not g.voiced  # 3.6x: below the start threshold
    assert g.feed("x", 0.023) is None and g.voiced     # above 4x: phrase starts
    for _ in range(30):
        g.feed("v", 0.03)
    out = None
    for _ in range(25):
        out = g.feed("s", 0.004) or out
    assert out is not None and len(out) >= 50 and not g.voiced


def test_short_blips_are_not_phrases():
    g = V.PhraseGate(floor=0.005)
    g.feed("x", 0.05)
    res = [g.feed("s", 0.001) for _ in range(25)]
    assert all(r is None for r in res)  # 30 ms of sound plus the 750 ms pause is not speech


def test_said_lines_parse():
    from trainer_coach.events import parse_line
    e = parse_line('[10:00:00] SAID (whisper): "make it easier"')
    assert e["type"] == "said" and e["said"] == "make it easier" and e["source"] == "whisper"
    assert parse_line('SAID: "hi"')["source"] == "browser"
    assert parse_line("VOICE ON (whisper)")["on"] is True


# ---------- Garmin / BLE switches ----------
def test_garmin_flag_logic(monkeypatch, tmp_path):
    monkeypatch.delenv("HW_GARMIN", raising=False)
    monkeypatch.delenv("HW_GARMIN_TOKENS", raising=False)
    assert Config(data=tmp_path).garmin_enabled is False  # scratch data dir: off by default
    monkeypatch.setenv("HW_GARMIN", "on")
    assert Config(data=tmp_path).garmin_enabled is True
    monkeypatch.setenv("HW_GARMIN", "off")
    from trainer_coach.config import DEFAULT_DATA
    assert Config(data=DEFAULT_DATA).garmin_enabled is False  # off wins even for the real data dir
    monkeypatch.delenv("HW_GARMIN")
    assert Config(data=DEFAULT_DATA).garmin_enabled is True
    assert Config(data=tmp_path, garmin=False).garmin_enabled is False


def test_disabled_garmin_never_imports_and_refuses(tmp_path, monkeypatch):
    import builtins
    from conftest import free_port, request
    from trainer_coach.server import make_server

    real_import = builtins.__import__

    def guard(name, *a, **kw):
        if name.startswith("garminconnect"):
            raise AssertionError("garminconnect imported on a disabled server")
        return real_import(name, *a, **kw)

    monkeypatch.setattr(builtins, "__import__", guard)
    (tmp_path / "gt").mkdir()
    (tmp_path / "gt" / "oauth1_token.json").write_text("{}")  # tokens exist, still must not be used
    s = make_server(Config(port=free_port(), data=tmp_path / "d", garmin_tokens=tmp_path / "gt"), quiet=True,
                    ticker=False, devices=False)
    import threading
    threading.Thread(target=s.serve_forever, daemon=True).start()
    try:
        page = {"Origin": f"http://127.0.0.1:{s.server_address[1]}", "X-HW": "1"}
        code, body = request(s.server_address[1], "POST", "/api/garmin/upload", b"\x0e" * 20, headers={**page, "X-Filename": "a.fit"})
        assert code == 503 and body["disabled"] and (tmp_path / "d" / "rides" / "a.fit").exists()
        assert request(s.server_address[1], "GET", "/api/garmin/zones")[0] == 502
        assert request(s.server_address[1], "GET", "/api/garmin/status")[1] == {"linked": False, "enabled": False}
        assert request(s.server_address[1], "GET", "/api/health")[1]["garmin"] is False
    finally:
        s.shutdown()
        s.server_close()
