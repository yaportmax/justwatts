"""FTMS/HR byte codecs and the device hub, driven through a fake bleak module (no Bluetooth)."""
import asyncio
import json
import struct
import time
from types import SimpleNamespace

import pytest

from trainer_coach import ftms
from trainer_coach.devices import DeviceHub


# ---------- codecs ----------
def ibd(flags, *fields):
    return struct.pack("<H", flags) + b"".join(fields)


def test_parse_indoor_bike_data_zwift_hub_style():
    # speed present (bit0 clear), cadence (bit2), power (bit6)
    d = ftms.parse_indoor_bike_data(ibd(0x0044, struct.pack("<H", 3125), struct.pack("<H", 180), struct.pack("<h", 250)))
    assert d == {"speed_kmh": 31.25, "cadence": 90.0, "power": 250}


def test_parse_indoor_bike_data_all_skipped_fields_and_hr():
    flags = 1 | 2 | 4 | 8 | 16 | 32 | 64 | 128 | 256 | 512  # more-data set: no instantaneous speed
    data = ibd(flags, struct.pack("<H", 1), struct.pack("<H", 170), struct.pack("<H", 1), b"\x01\x02\x03",
               struct.pack("<h", 5), struct.pack("<h", -20), struct.pack("<h", 1), b"\x00" * 5, bytes([142]))
    d = ftms.parse_indoor_bike_data(data)
    assert d == {"cadence": 85.0, "power": 0, "hr": 142}  # negative power clamps to 0


def test_parse_hr_measurement():
    assert ftms.parse_hr_measurement(bytes([0x00, 150])) == 150
    assert ftms.parse_hr_measurement(bytes([0x01, 0x2C, 0x01])) == 300


def test_control_point_encoding():
    assert ftms.cp_request_control() == b"\x00" and ftms.cp_start() == b"\x07"
    assert ftms.cp_target_power(250) == bytes([0x05, 250, 0])
    assert ftms.cp_target_power(300) == bytes([0x05, 0x2C, 0x01])
    assert ftms.cp_target_power(5000) == bytes([0x05, 0xD0, 0x07])  # clamped to 2000
    assert ftms.cp_simulation(2.5) == bytes([0x11, 0, 0, 0xFA, 0x00, 40, 51])
    assert ftms.cp_simulation(-1) == bytes([0x11, 0, 0, 0x9C, 0xFF, 40, 51])
    assert ftms.cp_command({"k": "erg", "w": 100}) == bytes([0x05, 100, 0])
    assert ftms.cp_response_needs_control(bytes([0x80, 0x05, 0x05]))
    assert not ftms.cp_response_needs_control(bytes([0x80, 0x05, 0x01]))


# ---------- fake bleak ----------
class FakeBle:
    def __init__(self):
        self.clients = []
        self.fail_connects = 0
        self.ads = []
        outer = self

        class BleakClient:
            def __init__(self, address, disconnected_callback=None, timeout=30):
                self.address, self.cb, self.notify, self.writes = address, disconnected_callback, {}, []
                self.is_connected = False
                outer.clients.append(self)

            async def connect(self):
                if outer.fail_connects > 0:
                    outer.fail_connects -= 1
                    raise OSError("device not found")
                self.is_connected = True

            async def start_notify(self, uuid, cb):
                self.notify[uuid] = cb

            async def write_gatt_char(self, uuid, data, response=True):
                self.writes.append(bytes(data))

            async def disconnect(self):
                self.is_connected = False

            def drop(self):  # simulate the trainer going out of range
                self.is_connected = False
                self.cb(self)

        class BleakScanner:
            @staticmethod
            async def discover(timeout=5, return_adv=True):
                return {d.address: (d, a) for d, a in outer.ads}

        self.BleakClient, self.BleakScanner = BleakClient, BleakScanner

    def advertise(self, address, name, uuids, rssi=-60):
        self.ads.append((SimpleNamespace(address=address, name=name), SimpleNamespace(service_uuids=uuids, local_name=name, rssi=rssi)))


def until(fn, what, t=5):
    t0 = time.time()
    while not fn():
        if time.time() - t0 > t:
            raise AssertionError("timeout: " + what)
        time.sleep(0.01)


@pytest.fixture
def hub(tmp_path):
    ble = FakeBle()
    h = DeviceHub(tmp_path / "devices.json", ble_enabled=True, ble=ble)
    h.start()
    yield h, ble
    h.stop()


def trainer_client(ble):
    return [c for c in ble.clients if c.is_connected and ftms.INDOOR_BIKE_DATA in c.notify][-1]


def test_scan_filters_by_service(hub):
    h, ble = hub
    ble.advertise("AA", "Zwift Hub", [ftms.FTMS_SERVICE], -50)
    ble.advertise("BB", "HRM", [ftms.HR_SERVICE])
    ble.advertise("CC", "Phone", [])
    assert [d["name"] for d in h.scan("trainer", 0.1)] == ["Zwift Hub"]
    assert [d["address"] for d in h.scan("hr", 0.1)] == ["BB"]


def test_connect_control_and_readings(hub):
    h, ble = hub
    h.want({"k": "erg", "w": 180})
    h.connect("trainer", "AA", "Zwift Hub")
    until(lambda: h.mode == "ble", "connected")
    c = trainer_client(ble)
    until(lambda: bytes([0x05, 180, 0]) in c.writes, "initial target sent")
    assert c.writes[:2] == [b"\x00", b"\x07"]  # request control, start
    c.notify[ftms.INDOOR_BIKE_DATA](None, bytearray(ibd(0x0244, struct.pack("<H", 3000), struct.pack("<H", 176),
                                                        struct.pack("<h", 205), bytes([131]))))
    assert (h.r.power, h.r.cadence, h.r.speed, h.r.hr, h.r.hr_src) == (205, 88.0, 30.0, 131, "hub")
    n = len(c.writes)
    h.want({"k": "erg", "w": 180})  # same command: coalesced, not resent
    time.sleep(0.1)
    assert len(c.writes) == n
    h.want({"k": "erg", "w": 200})
    h.want({"k": "erg", "w": 210})
    until(lambda: c.writes[-1] == bytes([0x05, 210, 0]), "latest target")
    # trainer says control not permitted: re-request control and resend the target
    c.notify[ftms.CONTROL_POINT](None, bytearray([0x80, 0x05, 0x05]))
    until(lambda: c.writes[-2:] == [b"\x00", bytes([0x05, 210, 0])], "control re-requested")
    assert json.loads(h.store.read_text())["trainer"]["address"] == "AA"


def test_drop_reconnects_until_user_disconnects(hub):
    h, ble = hub
    h.connect("trainer", "AA", "Hub")
    until(lambda: h.mode == "ble", "connected")
    ble.fail_connects = 2  # the next two attempts fail, then it comes back
    trainer_client(ble).drop()
    assert h.mode == "wait"
    until(lambda: h.mode == "ble", "reconnected", t=15)
    assert sum(1 for c in ble.clients if c.address == "AA") >= 2
    h.disconnect("trainer")
    assert h.mode == "none" and json.loads(h.store.read_text())["trainer"] is None
    time.sleep(1.5)
    assert not any(c.is_connected for c in ble.clients)


def test_remembered_devices_reconnect_on_start(tmp_path):
    (tmp_path / "devices.json").write_text(json.dumps({"trainer": {"address": "AA", "name": "Hub"},
                                                        "hr": {"address": "BB", "name": "Strap"}}))
    ble = FakeBle()
    h = DeviceHub(tmp_path / "devices.json", ble_enabled=True, ble=ble)
    h.start()
    try:
        until(lambda: h.mode == "ble" and h.hr_connected, "auto reconnect")
        hr = [c for c in ble.clients if ftms.HR_MEASUREMENT in c.notify][0]
        hr.notify[ftms.HR_MEASUREMENT](None, bytearray([0, 155]))
        assert h.r.hr == 155 and h.r.hr_src == "Strap"
        # a strap beats the trainer-relayed HR
        trainer_client(ble).notify[ftms.INDOOR_BIKE_DATA](None, bytearray(ibd(0x0200 | 1, bytes([99]))))
        assert h.r.hr == 155
        assert h.status()["hr"] == "Strap"
    finally:
        h.stop()


def test_ble_off_never_imports_bleak(tmp_path):
    h = DeviceHub(tmp_path / "d.json", ble_enabled=False)
    h.start()
    with pytest.raises(RuntimeError, match="disabled"):
        h.scan()
    h.set_sim(True)
    assert h.mode == "sim" and h.status()["ble"] is False
