"""Device hub: the server owns the trainer and HR strap, so a page reload never drops them.

Bluetooth runs in its own asyncio thread via `bleak` (optional extra [ble]). The hub remembers the
last devices in <data>/devices.json and reconnects to them at startup and after any drop, forever,
until the user disconnects. Set OPENSPIN_BLE=off to disable Bluetooth entirely (tests do).
"""
from __future__ import annotations

import asyncio
import json
import os
import threading
import time
from pathlib import Path
from typing import Any, Callable

from . import ftms


def ble_enabled_by_env() -> bool:
    from .config import env
    return (env("BLE", "on") or "on").lower() not in ("off", "0", "false", "no")


class HRNotReady(Exception):
    """The strap is connected but does not offer the heart rate service yet."""


class Readings:
    def __init__(self):
        self.power = 0.0
        self.cadence = 0.0
        self.speed = 0.0
        self.hr = 0
        self.last = 0.0      # monotonic time of the last trainer data
        self.hr_last = 0.0   # monotonic time of the last HR value
        self.hr_src: str | None = None  # strap name, 'hub' (trainer relayed), 'sim', or None


class DeviceHub:
    def __init__(self, store: Path | None = None, ble_enabled: bool | None = None, ble: Any = None,
                 clock: Callable[[], float] = time.monotonic, log: Callable[[str], None] | None = None):
        self.store = store
        self.ble_enabled = ble_enabled_by_env() if ble_enabled is None else ble_enabled
        self._ble = ble  # injectable module with BleakClient / BleakScanner (tests pass a fake)
        self.clock = clock
        self.log = log or (lambda m: None)
        self.r = Readings()
        self.mode = "none"  # none | wait | ble | sim
        self.trainer: dict | None = None  # {address, name}
        self.hr: dict | None = None
        self.hr_connected = False
        self.hr_state: str | None = None  # connecting | waiting_heartbeat | connected
        self.error: str | None = None
        self._want: dict | None = None
        self._sent: str | None = None
        self._busy = False
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._tclient = None
        self._hclient = None
        self._wanted = {"trainer": False, "hr": False}
        self._tasks: dict[str, asyncio.Task] = {}

    # ---------- lifecycle ----------
    def ble_module(self):
        if self._ble is None:
            if not self.ble_enabled:
                raise RuntimeError("Bluetooth is disabled (OPENSPIN_BLE=off)")
            try:
                import bleak
            except ImportError as e:
                raise RuntimeError("bleak not installed: pip install 'openspin[ble]'") from e
            self._ble = bleak
        return self._ble

    def start(self) -> None:
        """Start the BLE thread and reconnect to remembered devices."""
        if not self.ble_enabled or self._thread:
            return
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._loop.run_forever, name="ble", daemon=True)
        self._thread.start()
        saved = self._load()
        for kind in ("trainer", "hr"):
            if saved.get(kind):
                setattr(self, kind, saved[kind])
                self._wanted[kind] = True
                if kind == "trainer":
                    self.mode = "wait"  # before spawning: a fast connect must not be overwritten
                else:
                    self.hr_state = "connecting"
                self._spawn(kind)

    def stop(self) -> None:
        if self._loop:
            async def close():
                for t in list(self._tasks.values()):
                    t.cancel()
                self._tasks.clear()
                for c in (self._tclient, self._hclient):
                    try:
                        if c is not None:
                            await c.disconnect()
                    except Exception:  # noqa: BLE001
                        pass
            try:
                asyncio.run_coroutine_threadsafe(close(), self._loop).result(5)
            except Exception:  # noqa: BLE001
                pass
            self._loop.call_soon_threadsafe(self._loop.stop)
            self._thread = None
            self._loop = None

    def _run(self, coro, timeout: float):
        if not self._loop:
            raise RuntimeError("Bluetooth is disabled (OPENSPIN_BLE=off)" if not self.ble_enabled else "BLE thread not started")
        return asyncio.run_coroutine_threadsafe(coro, self._loop).result(timeout)

    # ---------- persistence ----------
    def _load(self) -> dict:
        try:
            return json.loads(self.store.read_text(encoding="utf-8")) if self.store else {}
        except (OSError, ValueError):
            return {}

    def _save(self) -> None:
        if not self.store:
            return
        self.store.parent.mkdir(parents=True, exist_ok=True)
        data = {"trainer": self.trainer if self._wanted["trainer"] else None, "hr": self.hr if self._wanted["hr"] else None}
        tmp = self.store.with_suffix(".tmp")
        tmp.write_text(json.dumps(data), encoding="utf-8")
        os.replace(tmp, self.store)

    # ---------- public API (called from HTTP threads) ----------
    def status(self) -> dict:
        now = self.clock()
        hr_on = bool(self.r.hr_src) and now - self.r.hr_last < 5
        return {"trainer": self.mode, "trainer_name": (self.trainer or {}).get("name") if self.mode != "sim" else "Simulated",
                "trainer_address": (self.trainer or {}).get("address"),
                "hr": self.r.hr_src if hr_on else None, "hr_name": (self.hr or {}).get("name"),
                "hr_connected": self.hr_connected, "hr_waiting": bool(self.r.hr_src) and not hr_on,
                "hr_state": self.hr_state if self.hr else None,
                "ble": self.ble_enabled, "error": self.error}

    def scan(self, kind: str = "trainer", timeout: float = 5.0) -> list[dict]:
        svc = ftms.FTMS_SERVICE if kind == "trainer" else ftms.HR_SERVICE
        ble = self.ble_module()

        async def go():
            found = await ble.BleakScanner.discover(timeout=timeout, return_adv=True)
            out = []
            for dev, adv in found.values():
                uuids = [u.lower() for u in (adv.service_uuids or [])]
                if svc in uuids:
                    out.append({"address": dev.address, "name": dev.name or adv.local_name or dev.address,
                                "rssi": getattr(adv, "rssi", None)})
            return sorted(out, key=lambda d: -(d["rssi"] or -999))
        return self._run(go(), timeout + 10)

    def connect(self, kind: str, address: str, name: str | None = None) -> None:
        """Remember and connect. Returns once the first attempt finishes (reconnects continue in background)."""
        if kind == "trainer" and self.mode == "sim":
            self.set_sim(False)
        info = {"address": address, "name": name or address}
        setattr(self, kind, info)
        self._wanted[kind] = True
        self._save()
        if kind == "trainer":
            self.mode = "wait"
        else:
            self.hr_state = "connecting"
        self.error = None
        self._spawn(kind)

    def disconnect(self, kind: str) -> None:
        self._wanted[kind] = False
        self._save()
        task = self._tasks.pop(kind, None)
        client = self._tclient if kind == "trainer" else self._hclient

        async def go():
            if task:
                task.cancel()
            if client is not None:
                try:
                    await client.disconnect()
                except Exception:  # noqa: BLE001
                    pass
        if self._loop:
            try:
                self._run(go(), 10)
            except Exception:  # noqa: BLE001
                pass
        if kind == "trainer":
            self._tclient = None
            if self.mode != "sim":
                self.mode = "none"
            self.r.power = self.r.cadence = self.r.speed = 0
            if self.r.hr_src == "hub":
                self.r.hr_src = None
        else:
            self._hclient = None
            self.hr_connected = False
            self.hr_state = None
            if self.r.hr_src not in ("hub", "sim"):
                self.r.hr_src = None

    def set_sim(self, on: bool) -> None:
        r = self.r
        if on:
            if self.mode in ("ble", "wait"):
                self.disconnect("trainer")
            self.mode = "sim"
            r.hr_src = "sim"
        elif self.mode == "sim":
            self.mode = "none"
            r.power = r.cadence = r.speed = 0
            if r.hr_src == "sim":
                r.hr_src = None
                r.hr = 0

    def want(self, cmd: dict) -> None:
        """Latest wanted trainer command ({'k': 'erg', 'w': W} or {'k': 'sim', 'g': grade}); coalesced."""
        self._want = cmd
        if self._loop and self.mode == "ble":
            self._loop.call_soon_threadsafe(lambda: asyncio.ensure_future(self._pump()))

    @property
    def wanted_cmd(self) -> dict | None:
        return self._want

    # ---------- BLE internals (run on the BLE loop) ----------
    def _spawn(self, kind: str) -> None:
        if not self._loop:
            return

        def mk():
            old = self._tasks.get(kind)
            if old and not old.done():
                return
            self._tasks[kind] = asyncio.ensure_future(self._keep(kind))
        self._loop.call_soon_threadsafe(mk)

    async def _keep(self, kind: str) -> None:
        """Connect, then reconnect after every drop until the user disconnects."""
        tries = 0
        while self._wanted[kind]:
            client = self._tclient if kind == "trainer" else self._hclient
            if client is not None and client.is_connected:
                await asyncio.sleep(1)
                continue
            try:
                await (self._connect_trainer() if kind == "trainer" else self._connect_hr())
                tries = 0
                self.error = None
            except asyncio.CancelledError:
                raise
            except HRNotReady:
                self.error = None
                await asyncio.sleep(3)  # rediscover services every few seconds
            except Exception as e:  # noqa: BLE001 - keep trying, report the reason
                tries += 1
                self.error = f"{kind}: {e}"[:200]
                if kind == "trainer" and self.mode != "sim":
                    self.mode = "wait"
                if kind == "hr":
                    self.hr_state = "connecting"
                await asyncio.sleep(min(10, 1 + tries))

    def _lost(self, kind: str):
        def cb(_client):
            self.log(f"{kind} disconnected")
            if kind == "trainer":
                self._sent = None
                if self.mode == "ble":
                    self.mode = "wait" if self._wanted["trainer"] else "none"
            else:
                self.hr_connected = False
                if self._wanted["hr"]:
                    self.hr_state = "connecting"
        return cb

    async def _connect_trainer(self) -> None:
        ble = self.ble_module()
        c = ble.BleakClient(self.trainer["address"], disconnected_callback=self._lost("trainer"), timeout=15)
        await c.connect()
        self._tclient = c

        def on_data(_s, data):
            try:
                d = ftms.parse_indoor_bike_data(data)
            except Exception:  # noqa: BLE001 - malformed packet
                return
            r = self.r
            r.speed = d.get("speed_kmh", r.speed)
            r.cadence = d.get("cadence", r.cadence)
            r.power = d.get("power", r.power)
            if d.get("hr") and (not r.hr_src or r.hr_src == "hub"):
                r.hr, r.hr_last, r.hr_src = d["hr"], self.clock(), "hub"
            r.last = self.clock()

        def on_cp(_s, data):
            if ftms.cp_response_needs_control(data) and self._loop:
                self._sent = None
                self._loop.call_soon_threadsafe(lambda: asyncio.ensure_future(self._recontrol()))

        await c.start_notify(ftms.INDOOR_BIKE_DATA, on_data)
        await c.start_notify(ftms.CONTROL_POINT, on_cp)
        await self._write(ftms.cp_request_control())
        await self._write(ftms.cp_start())
        self._sent = None
        if self.mode != "sim":
            self.mode = "ble"
        self.log(f"trainer connected: {self.trainer.get('name')}")
        await self._pump()

    async def _connect_hr(self) -> None:
        ble = self.ble_module()
        c = ble.BleakClient(self.hr["address"], disconnected_callback=self._lost("hr"), timeout=15)
        await c.connect()
        self._hclient = c
        name = self.hr.get("name") or "strap"

        def on_hr(_s, data):
            try:
                self.r.hr = ftms.parse_hr_measurement(data)
            except Exception:  # noqa: BLE001
                return
            self.r.hr_last = self.clock()
            if self.r.hr_src in (None, "hub", name):
                self.r.hr_src = name

        self.hr_state = "connecting"
        try:
            await c.start_notify(ftms.HR_MEASUREMENT, on_hr)
        except Exception as e:  # noqa: BLE001
            # Some straps (seen on a Wahoo TRACKR) only expose the HR service once they detect a
            # heartbeat. Drop the link and rediscover in a few seconds instead of failing.
            self.hr_state = "waiting_heartbeat"
            try:
                await c.disconnect()
            except Exception:  # noqa: BLE001
                pass
            self._hclient = None
            raise HRNotReady(f"strap found, waiting for heartbeat ({e})") from None
        self.hr_connected = True
        self.hr_state = "connected"
        self.r.hr_src = name
        self.log(f"HR connected: {name}")

    async def _recontrol(self) -> None:
        await self._write(ftms.cp_request_control())
        self._sent = None
        await self._pump()

    async def _write(self, data: bytes) -> None:
        c = self._tclient
        if c is None or not c.is_connected:
            return
        try:
            await c.write_gatt_char(ftms.CONTROL_POINT, data, response=True)
        except Exception as e:  # noqa: BLE001
            self.log(f"control point write failed: {e}")

    async def _pump(self) -> None:
        if self._busy or self.mode != "ble" or not self._want:
            return
        key = json.dumps(self._want, sort_keys=True)
        if key == self._sent:
            return
        self._busy = True
        try:
            want = self._want
            await self._write(ftms.cp_command(want))
            self._sent = json.dumps(want, sort_keys=True)
        finally:
            self._busy = False
        if json.dumps(self._want, sort_keys=True) != self._sent:
            await self._pump()
