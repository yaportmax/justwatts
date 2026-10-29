# Just Watts

A free, open-source smart-trainer app.

Just Watts connects to any Bluetooth FTMS smart trainer and heart rate strap, runs your workouts in
ERG mode or lets you ride free by grade, watts or resistance level, coaches you with a built-in
rule-based coach, and keeps your history: NP, TSS, zones, intervals, trends. It runs on your own
computer, with no account and no API keys. The trainer connection lives in a small local server,
so reloading or closing the browser never drops the trainer or the ride.

Try it in the browser, no install: **[openspin.maxyaport.com](https://openspin.maxyaport.com)** (Chrome or
Edge, Web Bluetooth; rides stay in the browser, no uploads). The local app below adds Garmin and Strava
upload, voice, agent coaching, and a trainer connection that survives closing the tab.

## Quick start

Needs Python 3.10+ and a computer with Bluetooth LE. Any modern browser works for the page.

```sh
git clone https://github.com/yaportmax/openspin
cd justwatts
pip install -e .
justwatts serve
```

Open http://127.0.0.1:8765, press **Connect trainer**,
pick it from the scan list. The server remembers it and reconnects by itself. A trainer accepts one
controller at a time: close Zwift or any other app using it first. `start.cmd` (Windows) or
`./start.sh` (macOS, Linux) starts the server and opens the browser.

No trainer? `justwatts simulate` drives a fake ride through the server.

## What you get

- **Workouts**: library, a builder with a text format (`10m 45-75%, 5x(3m 115%, 3m 50%), 10m free`),
  .zwo import and export, an FTP ramp test.
- **Ride modes**: structured ERG workouts, free ride by grade (simulation), ERG watts or FTMS
  resistance level. When the plan ends you keep riding free until you press End.
- **Manual control mid-ride**: anything the built-in coach or an agent can change, in one or two
  taps (see [Ride controls](#ride-controls)). Your change wins: the coaches see it
  and hold off.
- **Built-in coach** (no agent needed): interval start and 10 s countdown, rep recaps, recovery heart
  rate, cadence reminders, and automatic adjustments: Easier lowers the segment 5% FTP, Harder
  raises it 3% (not in HR zone 5), 30 s over your HR cap eases it 5%. Each cue can be turned off in
  Settings.
- **Ride screen** on one page: power, target, cadence against your target range, HR with zones,
  interval timer, the chart with a right-hand HR axis.
- **Voice** (optional): coach messages read aloud with Mute and an "important only" mode; with the
  `[voice]` extra, talk back through local Whisper, and the coach stops talking when you start.
- **History**: every ride with NP, IF, TSS, best 1/5/20 min, power and HR zones, laps per interval,
  FIT and TCX export, a share card (PNG) to download or share; weekly TSS, FTP history and best
  efforts.
- **Uploads** (optional): Garmin Connect and Strava.
- **Crash-safe**: every second of the ride is fsync'd to disk; a crash, kill or restart resumes the ride. See [docs/RELIABILITY.md](docs/RELIABILITY.md) for what is guaranteed and how it is tested.
- The web version (openspin.maxyaport.com) runs the same app with Bluetooth in the browser tab (Chrome or Edge).

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
| Cadence range, built-in coach on/off, beeps | Adjust | |
| Mute, voice level, Easier/Good/Harder | coach bar | M |
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

## Optional: AI agent coaching

An agent reads your heart rate trend and what you say, and edits the workout mid-ride. Agent features in the UI (the usage meter,
the History agent column) only appear when an agent is connected.

```sh
pip install "justwatts[mcp]"
claude mcp add justwatts -- justwatts mcp           # Claude Code
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.justwatts]
command = "justwatts"
args = ["mcp"]
```

Then: *"Coach my ride. Read the playbook, wait for events, keep me in zone."*

An event gate wakes the agent only for segment summaries, FEEL presses, speech, alerts
(HR cap, zone jump, low cadence, power off target, pause, device lost) and a status every few
minutes, in 5 s batches, while the built-in coach handles countdowns and recaps. The ride header
shows wakes, tokens and cost; `justwatts tail --agent` shows what wakes the coach. Guard rails limit
changes per command, cap watts at 150% FTP, and require your FEEL HARDER or GOOD before anything
harder. Playbook: [docs/COACHING.md](docs/COACHING.md). API: [docs/PROTOCOL.md](docs/PROTOCOL.md).

| Area | MCP tools |
|---|---|
| Wait (do not poll) | `wait_for_events`, `report_usage` |
| Read | `get_ride_status`, `get_workout`, `get_recent_events`, `get_telemetry_history`, `get_athlete_profile`, `get_coaching_playbook` |
| Coach | `send_message`, `set_step_target`, `set_current_target`, `set_intensity`, `set_voice_mode` |
| Edit the workout | `insert_steps`, `replace_step`, `delete_step`, `set_step_duration`, `extend_current_step`, `set_workout_length` |
| Ride | `load_workout`, `ride_control`, `free_ride` |
| Devices, settings | `devices`, `update_settings` |
| History | `list_rides`, `get_ride_detail`, `get_trends`, `upload_ride_to_garmin`, `upload_ride_to_strava`, `set_ride_description` |

Without MCP, use the CLI (`justwatts coach msg|set|insert|replace|delete|duration|extend`,
`justwatts tail -f`, `justwatts status`) or the HTTP API with the token in `~/.justwatts/token`. Agents
can never set the Strava secret.

## Voice

`pip install "justwatts[voice]"`, then `justwatts serve --voice`. It transcribes the default mic
locally with faster-whisper `small.en` (CPU, int8). Silence hallucinations ("Thank you."),
low-confidence segments, fragments under three words without a command word (easier, harder, stop,
pause, skip, help, mute) and echoes of the coach are dropped. Say "mute" or "quiet" to silence the
coach, "unmute" to bring it back.

## Security model

The server binds `127.0.0.1` and rejects any non-localhost `Host` header (the only exception is
`/share/<ride>.png` when you set a public base URL). The page proves itself with its own `Origin`
plus an `X-HW: 1` header; local tools use a bearer token from a 0600 file. Details in
[docs/PROTOCOL.md](docs/PROTOCOL.md#auth).

## Data and configuration

| Env | Default | |
|---|---|---|
| `JUSTWATTS_PORT` | `8765` | server port |
| `JUSTWATTS_DATA` | `~/.justwatts` | settings, devices, rides, the ride in progress, logs, token, Strava tokens |
| `JUSTWATTS_GARMIN_TOKENS` | `~/.garminconnect` | Garmin session tokens |
| `JUSTWATTS_TOKEN` | from `<data>/token` | API token for CLI/MCP |
| `JUSTWATTS_GARMIN` | auto | `off` disables Garmin, `on` forces it for a non-default data dir |
| `JUSTWATTS_BLE` | `on` | `off` disables Bluetooth |
| `JUSTWATTS_STRAVA_RELAY` | openspin.maxyaport.com | Strava token service for the shared app; `off` allows only your own API app |
| `JUSTWATTS_STRAVA_CLIENT_ID` | `168528` | Strava client ID used with that token service |
| `JUSTWATTS_MAX_CHANGE_PCT`, `JUSTWATTS_MAX_PCT`, `JUSTWATTS_FEEL_GATE_PCT`, `JUSTWATTS_FEEL_WINDOW_S`, `JUSTWATTS_STALE_S`, `JUSTWATTS_MAX_INSERT_S`, `JUSTWATTS_MAX_EXTEND_S`, `JUSTWATTS_MANUAL_HOLD_S` | 15, 150, 105, 600, 15, 1800, 600, 60 | agent guard rails |

Older `HW_*` and `TC_*` names still work, and a `~/.trainer-coach` data dir from earlier versions
moves to `~/.justwatts` on first start.

## Development

```sh
pip install -e ".[dev]"
pytest
```

Tests run the browser code under Node (`node` 18+ on PATH), boot the full page against a real test
server, drive BLE through a fake bleak module, mock Garmin and Strava, force Garmin and Bluetooth
off, and check that a full ride works with none of the optional extras installed. See
[AGENTS.md](AGENTS.md).

## Roadmap

- Import past rides from Garmin and Strava
- Push planned workouts to a calendar (Garmin, intervals.icu, TrainingPeaks)
- ANT+ FE-C via a USB bridge

## Security

See [SECURITY.md](SECURITY.md) for the threat model and how to report a vulnerability.

## License

MIT, see [LICENSE](LICENSE).
