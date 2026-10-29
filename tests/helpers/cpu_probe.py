"""Measures server process CPU over a window: idle, or 3 h into a ride with a live stream client.
Usage: cpu_probe.py <port> <seconds> idle|ride [calib|-] [server dir]"""
import os, sys, time, json, threading, tempfile, http.client
sys.path.insert(0, sys.argv[5] if len(sys.argv) > 5 else "server")
os.environ.update(JUSTWATTS_BLE="off", JUSTWATTS_GARMIN="off")
from justwatts.config import Config
from justwatts.server import make_server
port = int(sys.argv[1]); secs = float(sys.argv[2]); ride = sys.argv[3] == "ride"
srv = make_server(Config(port=port, data=tempfile.mkdtemp()), quiet=True)
threading.Thread(target=srv.serve_forever, daemon=True).start()
if ride:
    srv.hub.set_sim(True)
    srv.engine.control("load", {"workout": {"name": "P", "text": "3h 60%"}}); srv.engine.control("start", {})
    # pretend we're 3 hours in: preload 10800 samples so state/stream cost is realistic
    r = srv.engine.ride; t0 = int(time.time()*1000) - 10800*1000
    r.samples = [[t0 + i*1000, i+1.0, 150, 90, 140, 30.0, 150] for i in range(10800)]; r.el = 10800.0
    def client():
        c = http.client.HTTPConnection("127.0.0.1", port); c.request("GET", "/api/stream", headers={"Host": f"127.0.0.1:{port}"}); resp = c.getresponse()
        while True: resp.fp.readline()
    threading.Thread(target=client, daemon=True).start()
time.sleep(2)
n0 = len(srv.engine.ride.samples) if srv.engine.ride else 0; t0s = os.times(); c0, w0 = t0s.user + t0s.system, time.monotonic()
time.sleep(secs)
if len(sys.argv) > 4 and sys.argv[4] == "calib":
    t = time.monotonic()
    while time.monotonic() - t < 0.5: pass
t1s = os.times(); c1, w1 = t1s.user + t1s.system, time.monotonic(); n1 = len(srv.engine.ride.samples) if srv.engine.ride else 0
print(json.dumps({"ride": ride, "cpu_pct": round((c1 - c0) / (w1 - w0) * 100, 3), "cpu_s": round(c1 - c0, 3), "new_samples": n1 - n0}), flush=True)
os._exit(0)
