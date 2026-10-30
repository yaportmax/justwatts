<picture><source media="(prefers-color-scheme: dark)" srcset="app/wordmark.svg"><img src="app/wordmark-dark.svg" width="320" alt="Just Watts"></picture>

# Just Watts

A free, open-source smart-trainer app.

Just Watts connects to any Bluetooth FTMS smart trainer and heart rate strap, runs your workouts in
ERG mode or lets you ride free by grade, watts or resistance level, and keeps your history: NP, TSS,
zones, intervals, trends. It runs on your own computer, with no account and no API keys. The trainer
connection lives in a small local server, so reloading or closing the browser never drops the trainer or the ride.

Try it in the browser, no install: **[justwatts.com](https://justwatts.com)** (Chrome or
Edge, Web Bluetooth; rides stay in the browser, no uploads). The local app below adds Garmin and Strava
upload and a trainer connection that survives closing the tab.

## Quick start

Needs Python 3.10+ and a computer with Bluetooth LE. Any modern browser works for the page.

```sh
git clone https://github.com/yaportmax/justwatts
cd justwatts
pip install -e .
justwatts serve
```

Open http://127.0.0.1:8765, press **Connect trainer**,
pick it from the scan list. The server remembers it and reconnects by itself. A trainer accepts one
controller at a time: close Zwift or any other app using it first. `start.cmd` (Windows) or
`./start.sh` (macOS, Linux) starts the server and opens the browser.

No trainer? `justwatts simulate` starts a workout on the server's fake trainer; watch it in the page.

## What you get

- **Workouts**: library, a builder with a text format (`10m 45-75%, 5x(3m 115%, 3m 50%), 10m free`),
  .zwo import and export, an FTP ramp test.
- **Ride modes**: structured ERG workouts, free ride by grade (simulation), ERG watts or FTMS
  resistance level. When the plan ends you keep riding free until you press End.
- **Manual control mid-ride**: intensity, segment watts and time, the rest of the plan, trainer
  mode, in one or two taps (see [Ride controls](#ride-controls)).
- **Ride screen** on one page: power, target, distance (and climb on a course), cadence against your
  target range, HR with zones, interval timer, the chart with a right-hand HR axis. On a course: the
  route map in four styles or a 3D terrain view that follows you (MapLibre GL JS, vendored).
- **Open world**: Marin, from the Golden Gate Bridge over the Headlands and Mt Tam to West Marin and
  Point Reyes Station, with named starts (the bridge, Hawk Hill, Rodeo Beach, Sausalito, Mill Valley, Muir
  and Stinson Beach, Pantoll, East Peak, Seven Sisters, Fairfax, Whites Hill, Samuel P. Taylor, Point Reyes
  Station) or a tap on the map. Ride real roads with no route: you stay on the road; at a junction you go
  straight on or follow the main road unless you pick another way, and no way leads out of the world. A
  workout can run on top, and the road ridden can be saved as a course. The ride map shows it as a 3D world
  (three.js, vendored): terrain, grass that moves in the wind, roads with their lanes and markings, trees, towns,
  the Golden Gate Bridge and the city across the water, a little traffic and wildlife, wind and road sound, a
  chase camera (V: first person, T: time of day, G: fog, M: sound, K: kit colour), other riders, and their
  draft when you sit on a wheel. Without WebGL2, or if it runs too slowly, the 3D map or the 2D map shows
  instead. Roads, terrain and ground data are OpenStreetMap and Mapzen terrain, baked into the app
  (`app/roads/marin`, `app/world`) so a ride never waits on a server.
- **Riding with others** (justwatts.com, signed in): riders on the same course or within about 5 km in
  the open world show on the 2D and 3D maps with name and watts, friends highlighted. Friends by name
  or share link, a Friends panel with who is riding now and "Ride here", group rides (a course or
  open-world start, a time, an optional workout, a lobby and a countdown, everyone starts together),
  text chat per friend and per group ride, and ride-ons for friends' finished rides. Plain HTTP
  polling to the accounts API (`web/api/_lib/social.js`), no extra service. Visibility can be switched
  off in Settings. The local app has no accounts, so none of this shows there.
- **History**: every ride with NP, IF, TSS, best 1/5/20 min, power and HR zones, laps per interval,
  FIT and TCX export, a share card (PNG) to download or share; weekly TSS, FTP history and best
  efforts.
- **Uploads** (optional): Garmin Connect and Strava.
- **Crash-safe**: every second of the ride is fsync'd to disk; a crash, kill or restart resumes the ride.
- The web version (justwatts.com) runs the same app with Bluetooth in the browser tab (Chrome or Edge).

## Ride controls

Common actions sit on the ride screen; the rest are in **Adjust**. Each change shows what changed,
and intensity, watts, segment time, length, trainer mode and settings can be undone for 15 s.

| Control | Where | Key |
|---|---|---|
| Pause, resume (Pause during an auto-pause stays paused) | bar | Space |
| Intensity ±1 % (grade, watts or level when not in ERG) | bar −/+ | ↑ ↓ (Shift ±5) |
| Back (restart segment; in its first 10 s, the previous one), Skip | bar | ← → |
| Segment time ±1 min (±30 s in Adjust) | bar | [ ] |
| Segment watts ±5/±10 | Adjust | - = |
| Intensity presets, reset to 100 % | Adjust | |
| Workout length ±5 min | Adjust | |
| Trainer: ERG, or ERG off by grade or level (the plan keeps showing) | Adjust | 1 2 3 |
| Edit the plan from the current segment | Adjust | |
| After the plan: hold the last target or ride flat | Adjust | |
| Cadence on/off and range (off: no readout, target or cues), beeps | Adjust | |
| Map style (Map, Satellite, Topo, Cycling), 3D terrain, map or chart focus (courses with a route) | map | F |
| Open world: the way at the junction ahead (shown about 200 m before it) | tap | ← ↑ → |
| Open world: U-turn (ride back the way you came) | bar, junction prompt | ↓ |
| Open world: go to another spot, the ride goes on | bar (Spots) | P |
| Full screen | bar | Shift F |
| Undo, Save, End (two taps) | bar | Z, S |
| Reconnect trainer or HR | header | |

`?` shows the keys. Free segments and a flat finish ride by grade, and −/+ moves it. FTP tests keep
their targets.

## Supported hardware

| Device | Support |
|---|---|
| Smart trainers with Bluetooth FTMS (service `0x1826`) | ERG, grade simulation, resistance level |
| Tested | Zwift Hub (server Bluetooth, survives page reloads) |
| HR straps, Bluetooth Heart Rate service `0x180D` | Yes; trainer-relayed HR is used if no strap. Straps that hide the HR service until they feel a heartbeat (seen on a Wahoo TRACKR) show "waiting for heartbeat" and connect once you wet the contacts. |
| ANT+ only devices | No |

Most current trainers (Wahoo, Tacx, Elite, Saris, JetBlack) expose FTMS; only the Zwift Hub has been
tested so far. Resistance-level mode follows FTMS 1.0 and is untested on hardware.

## Uploads

**Garmin** (`pip install "justwatts[garmin]"`, then `justwatts login-garmin` once). On first start with
Garmin linked, Just Watts imports your FTP and weight (only the ones you have not set yourself;
**Import from Garmin** in Settings redoes it and also brings HR zones). HR zones from Garmin are a
choice under Settings > HR zones; the default is % of max HR. It uses the unofficial
[python-garminconnect](https://github.com/cyberjunky/python-garminconnect) library, which Garmin can
break at any time. Garmin is only active for the default data dir; `JUSTWATTS_GARMIN=off` or
`serve --no-garmin` disables it, and any other `JUSTWATTS_DATA` has it off unless `JUSTWATTS_GARMIN=on`.

**Strava** (no extra needed). Press **Connect Strava** in Settings and approve on Strava. This uses
Just Watts's Strava app: its client secret is not in this repo, it lives only in a tiny stateless token
service ([web/api/strava/token.js](web/api/strava/token.js)) that swaps the sign-in code and refresh
tokens for access tokens. Uploads go straight from your computer to Strava; tokens stay in your data
folder. To skip the token service, open **Use your own Strava API app** in Settings and enter your own
Client ID and secret (strava.com/settings/api, callback domain `localhost`), or host the function
yourself and set `JUSTWATTS_STRAVA_RELAY` and `JUSTWATTS_STRAVA_CLIENT_ID`. Uploads go through the official API with the FIT file,
the ride name and a text summary (NP, IF, TSS, intervals, "Recorded with Just Watts"). If Garmin
Connect already syncs to Strava for you, uploading to both makes duplicates: pick one.

**Share card**: the ride summary renders a PNG card to download or share. Strava's API cannot attach
photos, so add it by hand. If you set a public base URL in Settings (your own proxy or host), the
Strava description links the card.

Every FIT file is saved to `~/.justwatts/rides/` before any upload, and History can always export
.fit and .tcx.

## Security model

The server binds `127.0.0.1` and rejects any non-localhost `Host` header (the only exception is
`/share/<ride>.png` when you set a public base URL). The page proves itself with its own `Origin`
plus an `X-HW: 1` header; the CLI uses a bearer token from a 0600 file. Details in
[docs/PROTOCOL.md](docs/PROTOCOL.md#auth).

## Data and configuration

| Env | Default | |
|---|---|---|
| `JUSTWATTS_PORT` | `8765` | server port |
| `JUSTWATTS_DATA` | `~/.justwatts` | settings, devices, rides, the ride in progress, logs, token, Strava tokens |
| `JUSTWATTS_GARMIN_TOKENS` | `~/.garminconnect` | Garmin session tokens |
| `JUSTWATTS_TOKEN` | from `<data>/token` | API token for the CLI |
| `JUSTWATTS_GARMIN` | auto | `off` disables Garmin, `on` forces it for a non-default data dir |
| `JUSTWATTS_BLE` | `on` | `off` disables Bluetooth |
| `JUSTWATTS_STRAVA_RELAY` | justwatts.com | Strava token service for the shared app; `off` allows only your own API app |
| `JUSTWATTS_STRAVA_CLIENT_ID` | `168528` | Strava client ID used with that token service |

Older `OPENSPIN_*` and `HW_*` names still work. An existing `~/.openspin` data dir keeps being used,
and older data dirs move to `~/.justwatts` on first start.

## Development

```sh
pip install -e ".[dev]"
pytest
```

Tests run the browser code under Node (`node` 18+ on PATH), boot the full page against a real test
server, drive BLE through a fake bleak module, mock Garmin and Strava, force Garmin and Bluetooth
off, and check that a full ride works with none of the optional extras installed.

## Security

See [SECURITY.md](SECURITY.md) for the threat model and how to report a vulnerability.

## License

MIT, see [LICENSE](LICENSE). The vendored MapLibre GL JS 5.24.0 (`app/vendor/`, the 3D map) is BSD-3-Clause,
license next to it.
