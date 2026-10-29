"""3-hour ride soak test against a hostile fake Bluetooth stack.

The fake trainer drops the link at random, stays unreachable for a while, answers control point
writes slowly, fails some writes, skips, duplicates or reorders indications, and duplicates
notifications; old (replaced) clients keep sending junk. The ride engine runs on a simulated
clock, so 3 hours take seconds. Then: every recorded sample checked, targets checked after every
reconnect and step change, and the FIT file decoded with CRC checks.
"""
import asyncio
import io
import json
import random
import struct
import time
from types import SimpleNamespace

import pytest

from justwatts import ftms
from justwatts import history as H
from justwatts.devices import DeviceHub
from justwatts.engine import RideEngine

WORKOUT = "10m 45-70%, 16x(5m 95%, 5m 55%), 10m 60-40%"  # 180 min
FTP = 250


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class HostileBle:
    def __init__(self, clock, rng):
        self.clock, self.rng = clock, rng
        self.clients = []
        self.available_at = 0.0
        self.target = None          # what the trainer is actually holding (from accepted writes)
        self.loop = None
        outer = self

        class Client:
            def __init__(self, address, disconnected_callback=None, timeout=30):
                self.address, self.cb, self.notify, self.is_connected = address, disconnected_callback, {}, False
                self.registrations = 0
                outer.clients.append(self)

            async def connect(self):
                await asyncio.sleep(outer.rng.uniform(0, 0.002))
                if outer.clock() < outer.available_at or outer.rng.random() < 0.05:
                    raise OSError("device unreachable")
                self.is_connected = True

            async def start_notify(self, uuid, cb):
                self.registrations += 1
                self.notify[uuid] = cb

            async def write_gatt_char(self, uuid, data, response=True):
                if not self.is_connected:
                    raise OSError("not connected")
                await asyncio.sleep(outer.rng.uniform(0, 0.004))   # slow writes
                if outer.rng.random() < 0.03:
                    raise OSError("write failed")
                op = data[0]
                r = outer.rng.random()
                result = 0x04 if r < 0.03 else 0x01                # explicit failures
                if result == 0x01 and op == ftms.OP_TARGET_POWER:
                    outer.target = data[1] | (data[2] << 8)
                ind = self.notify.get(ftms.CONTROL_POINT)
                if ind is None:
                    return
                if outer.rng.random() < 0.03:                      # no indication at all
                    return
                if outer.rng.random() < 0.03:                      # a stray answer for another request first
                    outer.loop.call_soon(ind, None, bytearray([0x80, 0x07, 0x01]))
                outer.loop.call_soon(ind, None, bytearray([0x80, op, result]))
                if outer.rng.random() < 0.03:                      # duplicated indication
                    outer.loop.call_soon(ind, None, bytearray([0x80, op, result]))

            async def disconnect(self):
                self.is_connected = False

        self.BleakClient = Client

    def current(self):
        live = [c for c in self.clients if c.is_connected and ftms.INDOOR_BIKE_DATA in c.notify]
        return live[-1] if live else None

    def drop(self, outage_s):
        c = self.current()
        if c:
            c.is_connected = False
            self.available_at = self.clock() + outage_s
            self.loop.call_soon_threadsafe(c.cb, c)


def ibd(power, cadence=90, speed_kmh=32.0):
    return bytearray(struct.pack("<HHHh", 0x44, int(speed_kmh * 100), int(cadence * 2), power))


def wait_real(cond, timeout=3.0):
    t0 = time.monotonic()
    while not cond():
        if time.monotonic() - t0 > timeout:
            return False
        time.sleep(0.001)
    return True


@pytest.mark.parametrize("seed", [int(s) for s in __import__("os").environ.get("SOAK_SEEDS", "1,2").split(",")])
def test_three_hour_soak(tmp_path, seed):
    rng = random.Random(seed)
    clk = Clock()
    wall = lambda: 1_767_250_800 + (clk.t - 1000.0)  # noqa: E731
    ble = HostileBle(clk, rng)
    hub = DeviceHub(tmp_path / "devices.json", ble_enabled=True, ble=ble, clock=clk, backoff=0.001, cp_timeout=0.05)
    hub.start()
    ble.loop = hub._loop
    errors = []
    hub._loop.set_exception_handler(lambda loop, ctx: errors.append(ctx.get("message")))
    events = []
    eng = RideEngine(hub, tmp_path, events.append, lambda: {"ftp": FTP}, clock=clk, wall=wall)
    try:
        hub.connect("trainer", "AA:BB", "Fake Hub")
        assert wait_real(lambda: hub.mode == "ble"), "first connect"
        eng.control("load", {"workout": {"name": "Soak", "text": WORKOUT}})
        eng.control("start", {})
        drops = outages = 0
        stale_junk = 0
        last_step = None
        reconnect_checks = step_checks = 0
        checks = []
        paused_ticks = 0
        while not (eng.ride and eng.ride.overtime) and clk.t < 1000 + 4 * 3600:
            clk.t += 1
            c = ble.current()
            if c is not None and hub.mode == "ble" and ble.target is not None:
                cb = c.notify[ftms.INDOOR_BIKE_DATA]
                p = max(0, ble.target + rng.randint(-8, 8))
                cb(None, ibd(p))
                if rng.random() < 0.05:
                    cb(None, ibd(p))                     # duplicate notification
            old = [x for x in ble.clients if x is not hub._tclient and ftms.INDOOR_BIKE_DATA in x.notify]
            if old and rng.random() < 0.02:              # a replaced client still talking
                old[-1].notify[ftms.INDOOR_BIKE_DATA](None, ibd(1999, 200))
                stale_junk += 1
            if c is not None and rng.random() < 1 / 600:  # ~18 drops in 3 h, outage 2..25 s
                ble.drop(rng.uniform(2, 25))
                drops += 1
            eng.tick(1.0)
            if eng.ride.paused:
                paused_ticks += 1
            # the trainer must hold the engine's target: checked mid-way through every steady step and
            # 15 s after every reconnect (writes can be lost or misreported; the hub re-asserts every 10 s)
            st = eng.state({})["ride"]
            step = st["step"]
            if step and step["index"] != last_step:
                last_step = step["index"]
                sd = st["steps"][step["index"] - 1]
                if sd["start_w"] == sd["end_w"]:
                    checks.append((clk.t + step["duration_s"] // 2,))
            if hub.stats["connects"] > reconnect_checks + 1:
                reconnect_checks = hub.stats["connects"] - 1
                checks.append((clk.t + 15,))
            # a check passes when, within 20 simulated seconds, the trainer holds the target (+-3 W
            # for ramps); while checks are open the loop gives the BLE thread real time to work
            for chk in [c for c in checks if c[0] <= clk.t]:
                if hub.mode != "ble" or eng.ride.paused:
                    checks.remove(chk)
                    continue
                tgt = eng.cur_target()
                if tgt is not None and ble.target is not None and abs(ble.target - tgt) <= 3:
                    checks.remove(chk)
                    step_checks += 1
                elif clk.t > chk[0] + 20:
                    raise AssertionError(f"t+{clk.t - 1000:.0f}: trainer holds {ble.target}, engine wants {tgt}, stats {hub.stats}")
            if any(c[0] <= clk.t for c in checks):
                time.sleep(0.01)
            if hub.mode == "wait":  # give the reconnect loop real time while the simulated outage runs
                outages += 1
                wait_real(lambda: hub.mode == "ble", 0.01)
        r = eng.ride
        assert r.overtime, f"the plan finished: el {r.el:.0f} mode {hub.mode} target {ble.target} sent {hub._sent} want {hub.wanted_cmd} paused {r.paused} {hub.stats} err {hub.error} drops {drops}"
        # ---------- the recording ----------
        s = r.samples
        els = [x[1] for x in s]
        tss = [x[0] for x in s]
        assert all(b > a for a, b in zip(els, els[1:])), "elapsed strictly increasing"
        assert all(b > a for a, b in zip(tss, tss[1:])), "timestamps strictly increasing"
        assert len(s) == int(round(r.el)) and r.el >= 180 * 60
        assert max(x[2] for x in s) < 1999, "junk from a replaced client never recorded"
        riding = [x for x in s if x[6]]
        close = sum(1 for x in riding if abs(x[2] - x[6]) <= 40)
        # (simulated time runs far faster than the BLE thread, so ramps lag here more than in real life)
        assert close / len(riding) > 0.9, f"power follows target in {close / len(riding):.1%} of samples"
        assert not errors, errors
        assert hub.stats["drops"] == drops and hub.stats["connects"] >= drops  # the last drop may still be reconnecting
        assert all(c.registrations <= 2 for c in ble.clients), "never two handlers on one client"
        assert step_checks >= 30
        # ---------- archive + FIT ----------
        res = eng.control("end", {})
        ride = json.loads((tmp_path / "rides" / f"{res['id']}.json").read_text())
        fitdecode = pytest.importorskip("fitdecode")
        data = H.fit_encode(ride)
        recs = 0
        with fitdecode.FitReader(io.BytesIO(data), check_crc=fitdecode.CrcCheck.RAISE) as fr:
            for f in fr:
                if isinstance(f, fitdecode.FitDataMessage) and f.name == "record":
                    recs += 1
        assert recs == len(ride["samples"])
        print(f"\nsoak seed {seed}: {len(s)} samples ({r.el / 3600:.2f} h), {drops} drops, {hub.stats['connects']} connects, "
              f"{paused_ticks} auto-paused s, {stale_junk} stale notifications ignored, cp {hub.stats}")
    finally:
        hub.stop()
