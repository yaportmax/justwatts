"""Whisper transcript filters (no mic, no model) and the Garmin/BLE kill switches."""
from types import SimpleNamespace

import pytest

from openspin import voice as V
from openspin.config import Config


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
    from openspin.events import parse_line
    e = parse_line('[10:00:00] SAID (whisper): "make it easier"')
    assert e["type"] == "said" and e["said"] == "make it easier" and e["source"] == "whisper"
    assert parse_line('SAID: "hi"')["source"] == "browser"
    assert parse_line("VOICE ON (whisper)")["on"] is True


# ---------- Garmin / BLE switches ----------
def test_garmin_flag_logic(monkeypatch, tmp_path):
    monkeypatch.delenv("OPENSPIN_GARMIN", raising=False)
    monkeypatch.delenv("OPENSPIN_GARMIN_TOKENS", raising=False)
    assert Config(data=tmp_path).garmin_enabled is False  # scratch data dir: off by default
    monkeypatch.setenv("OPENSPIN_GARMIN", "on")
    assert Config(data=tmp_path).garmin_enabled is True
    monkeypatch.setenv("OPENSPIN_GARMIN", "off")
    from openspin.config import DEFAULT_DATA
    assert Config(data=DEFAULT_DATA).garmin_enabled is False  # off wins even for the real data dir
    monkeypatch.delenv("OPENSPIN_GARMIN")
    assert Config(data=DEFAULT_DATA).garmin_enabled is True
    assert Config(data=tmp_path, garmin=False).garmin_enabled is False


def test_disabled_garmin_never_imports_and_refuses(tmp_path, monkeypatch):
    import builtins
    from conftest import free_port, request
    from openspin.server import make_server

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


# ---------- rename: legacy env names and data dir ----------
def test_legacy_env_names_still_work(monkeypatch, tmp_path):
    from openspin.config import env
    for k in ("OPENSPIN_PORT", "OPENSPIN_GARMIN", "OPENSPIN_GARMIN_TOKENS"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("HW_PORT", "8791")
    assert Config().port == 8791
    monkeypatch.setenv("OPENSPIN_PORT", "8792")
    assert Config().port == 8792 and env("PORT") == "8792"
    monkeypatch.setenv("HW_GARMIN", "on")
    assert Config(data=tmp_path).garmin_enabled is True
    monkeypatch.setenv("TC_MAX_PCT", "120")
    from openspin.safety import Limits
    assert Limits().max_pct == 120


def test_legacy_data_dir_is_moved_once(tmp_path):
    from openspin.config import migrate_legacy_data
    old, new = tmp_path / ".trainer-coach", tmp_path / ".openspin"
    (old / "rides").mkdir(parents=True)
    (old / "rides" / "r-1.json").write_text("{}")
    assert migrate_legacy_data(new, old) is True
    assert (new / "rides" / "r-1.json").exists() and not old.exists()
    old.mkdir()
    assert migrate_legacy_data(new, old) is False and old.exists()  # never overwrites the new dir
