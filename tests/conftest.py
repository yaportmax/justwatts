import http.client
import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO = Path(__file__).resolve().parent.parent

# Never let a test fall back to the default port or the real data dir (or legacy HW_* settings).
for _k in [k for k in os.environ if k.startswith(("HW_", "OPENSPIN_", "TC_"))]:
    del os.environ[_k]
_SCRATCH = Path(tempfile.mkdtemp(prefix="openspin-tests-"))
os.environ["OPENSPIN_PORT"] = "8799"
os.environ["OPENSPIN_DATA"] = str(_SCRATCH / "default-data")
os.environ["OPENSPIN_GARMIN_TOKENS"] = str(_SCRATCH / "no-garmin")
os.environ.pop("OPENSPIN_TOKEN", None)
os.environ["OPENSPIN_GARMIN"] = "off"  # tests must never reach a real Garmin account
os.environ["OPENSPIN_BLE"] = "off"     # ...or real Bluetooth hardware

from openspin.client import CoachClient  # noqa: E402
from openspin.config import Config  # noqa: E402
from openspin.server import make_server  # noqa: E402


def free_port(start=8770, end=8798) -> int:
    for p in range(start, end):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    raise RuntimeError("no free port in 8770..8798")


class FakeGarmin:
    def __init__(self):
        self.is_linked = True
        self.uploads = []
        self.result = {"ok": True, "activityId": 42}
        self.zones_value = {"floors": [100, 120, 140, 160, 180], "max": 190, "lthr": 170}

    def linked(self):
        return self.is_linked

    def upload(self, path):
        self.uploads.append(Path(path).read_bytes())
        return dict(self.result)

    def zones(self):
        if isinstance(self.zones_value, Exception):
            raise self.zones_value
        return self.zones_value


def request(port, method, path, body=None, headers=None, host=None, raw=False):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    data = body if isinstance(body, (bytes, bytearray)) or body is None else json.dumps(body).encode()
    h = {"Host": host or f"127.0.0.1:{port}"}
    if data is not None:
        h["Content-Type"] = "application/json"
        h["Content-Length"] = str(len(data))
    h.update(headers or {})
    conn.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
    for k, v in h.items():
        conn.putheader(k, v)
    conn.endheaders(data)
    r = conn.getresponse()
    payload = r.read()
    ctype = r.getheader("Content-Type", "")
    conn.close()
    if raw:
        return r.status, payload, ctype
    try:
        return r.status, json.loads(payload)
    except ValueError:
        return r.status, payload


@pytest.fixture
def srv(tmp_path):
    port = free_port()
    cfg = Config(port=port, data=tmp_path / "data", garmin_tokens=tmp_path / "gtokens", app=REPO / "app")
    g = FakeGarmin()
    server = make_server(cfg, garmin=g, quiet=True, ticker=False, devices=False)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    url = f"http://127.0.0.1:{port}"
    ns = SimpleNamespace(
        cfg=cfg, server=server, port=port, url=url, token=server.token, garmin=g,
        client=CoachClient(cfg),
        page={"Origin": url, "X-HW": "1"},
        bearer={"Authorization": f"Bearer {server.token}"},
        req=lambda *a, **kw: request(port, *a, **kw),
    )
    yield ns
    server.shutdown()
    server.server_close()


@pytest.fixture(scope="session")
def node():
    exe = shutil.which("node")
    if not exe:
        pytest.skip("node not installed")
    return exe


def run_node(node_exe, script, payload=None, timeout=60):
    p = subprocess.run([node_exe, str(script)], input=json.dumps(payload) if payload is not None else "",
                       capture_output=True, text=True, timeout=timeout, encoding="utf-8")
    if p.returncode != 0:
        raise AssertionError(f"node failed: {p.stderr}")
    return json.loads(p.stdout)
