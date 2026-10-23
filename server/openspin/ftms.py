"""Bluetooth FTMS + Heart Rate byte codecs (pure functions, no I/O). Mirrors the original browser code."""
from __future__ import annotations

import struct


def uuid16(x: int) -> str:
    return f"0000{x:04x}-0000-1000-8000-00805f9b34fb"


FTMS_SERVICE = uuid16(0x1826)
INDOOR_BIKE_DATA = uuid16(0x2AD2)
CONTROL_POINT = uuid16(0x2AD9)
HR_SERVICE = uuid16(0x180D)
HR_MEASUREMENT = uuid16(0x2A37)

OP_REQUEST_CONTROL = 0x00
OP_START = 0x07
OP_TARGET_RESISTANCE = 0x04
OP_TARGET_POWER = 0x05
OP_SIMULATION = 0x11
OP_RESPONSE = 0x80
RESULT_CONTROL_NOT_PERMITTED = 0x05


def parse_indoor_bike_data(data: bytes) -> dict:
    """Indoor Bike Data (0x2AD2) -> {speed_kmh?, cadence?, power?, hr?}."""
    v = bytes(data)
    f = struct.unpack_from("<H", v, 0)[0]
    i = 2
    out: dict = {}
    if not f & 1:  # bit 0 "more data" clear: instantaneous speed present
        out["speed_kmh"] = struct.unpack_from("<H", v, i)[0] / 100
        i += 2
    if f & 2:
        i += 2  # average speed
    if f & 4:
        out["cadence"] = struct.unpack_from("<H", v, i)[0] / 2
        i += 2
    if f & 8:
        i += 2  # average cadence
    if f & 16:
        i += 3  # total distance
    if f & 32:
        i += 2  # resistance level
    if f & 64:
        out["power"] = max(0, struct.unpack_from("<h", v, i)[0])
        i += 2
    if f & 128:
        i += 2  # average power
    if f & 256:
        i += 5  # expended energy
    if f & 512:
        out["hr"] = v[i]
        i += 1
    return out


def parse_hr_measurement(data: bytes) -> int:
    v = bytes(data)
    return struct.unpack_from("<H", v, 1)[0] if v[0] & 1 else v[1]


def cp_request_control() -> bytes:
    return bytes([OP_REQUEST_CONTROL])


def cp_start() -> bytes:
    return bytes([OP_START])


def cp_target_power(watts: float) -> bytes:
    w = max(0, min(2000, int(round(watts))))
    return bytes([OP_TARGET_POWER, w & 255, (w >> 8) & 255])


def cp_simulation(grade_pct: float) -> bytes:
    """Wind 0, grade in 0.01 % (signed), Crr 0.0040, Cw 0.51 kg/m."""
    g = int(round(grade_pct * 100)) & 0xFFFF
    return bytes([OP_SIMULATION, 0, 0, g & 255, (g >> 8) & 255, 40, 51])


def cp_resistance(level: float) -> bytes:
    """Set Target Resistance Level (FTMS 1.0: UINT8, unitless, resolution 0.1, so 0..25.5)."""
    v = max(0, min(255, int(round(level * 10))))
    return bytes([OP_TARGET_RESISTANCE, v])


def cp_command(cmd: dict) -> bytes:
    """{'k': 'erg', 'w': 200}, {'k': 'sim', 'g': 2.5} or {'k': 'res', 'r': 8.5} -> control point bytes."""
    if cmd["k"] == "erg":
        return cp_target_power(cmd["w"])
    if cmd["k"] == "res":
        return cp_resistance(cmd["r"])
    return cp_simulation(cmd["g"])


def cp_response_needs_control(data: bytes) -> bool:
    """True when the trainer answered 'control not permitted' (it lost or never gave us control)."""
    v = bytes(data)
    return len(v) >= 3 and v[0] == OP_RESPONSE and v[2] == RESULT_CONTROL_NOT_PERMITTED
