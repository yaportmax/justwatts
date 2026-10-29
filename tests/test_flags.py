"""Garmin/BLE kill switches, legacy env names and data dirs."""
from justwatts.config import Config


# ---------- Garmin / BLE switches ----------
def test_garmin_flag_logic(monkeypatch, tmp_path):
    monkeypatch.delenv("JUSTWATTS_GARMIN", raising=False)
    monkeypatch.delenv("JUSTWATTS_GARMIN_TOKENS", raising=False)
    assert Config(data=tmp_path).garmin_enabled is False  # scratch data dir: off by default
    monkeypatch.setenv("JUSTWATTS_GARMIN", "on")
    assert Config(data=tmp_path).garmin_enabled is True
    monkeypatch.setenv("JUSTWATTS_GARMIN", "off")
    from justwatts.config import DEFAULT_DATA
    assert Config(data=DEFAULT_DATA).garmin_enabled is False  # off wins even for the real data dir
    monkeypatch.delenv("JUSTWATTS_GARMIN")
    assert Config(data=DEFAULT_DATA).garmin_enabled is True
    assert Config(data=tmp_path, garmin=False).garmin_enabled is False


def test_disabled_garmin_never_imports_and_refuses(tmp_path, monkeypatch):
    import builtins
    from conftest import free_port, request
    from justwatts.server import make_server

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
    from justwatts.config import env
    for k in ("JUSTWATTS_PORT", "JUSTWATTS_GARMIN", "JUSTWATTS_GARMIN_TOKENS"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("HW_PORT", "8791")
    assert Config().port == 8791
    monkeypatch.setenv("JUSTWATTS_PORT", "8792")
    assert Config().port == 8792 and env("PORT") == "8792"
    monkeypatch.setenv("HW_GARMIN", "on")
    assert Config(data=tmp_path).garmin_enabled is True


def test_legacy_data_dir_is_moved_once(tmp_path):
    from justwatts.config import migrate_legacy_data
    old, new = tmp_path / ".trainer-coach", tmp_path / ".justwatts"
    (old / "rides").mkdir(parents=True)
    (old / "rides" / "r-1.json").write_text("{}")
    assert migrate_legacy_data(new, old) is True
    assert (new / "rides" / "r-1.json").exists() and not old.exists()
    old.mkdir()
    assert migrate_legacy_data(new, old) is False and old.exists()  # never overwrites the new dir


def test_live_dir_of_older_versions_is_renamed(tmp_path):
    old = tmp_path / "coach"
    old.mkdir()
    (old / "engine.json").write_text("{}")
    cfg = Config(data=tmp_path)
    assert cfg.live_dir == tmp_path / "live" and (tmp_path / "live" / "engine.json").exists() and not old.exists()
