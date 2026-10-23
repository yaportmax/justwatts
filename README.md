# trainer-coach

Let an AI agent coach your smart-trainer ride.

A local server connects to any FTMS smart trainer and HR strap over Bluetooth, runs the workout
(ERG targets, grade, auto-pause) and saves it to disk every few seconds. A dependency-free web page
shows the ride; reloading or closing it never drops the trainer or the ride. An agent (Claude Code,
Codex, any MCP client) reads the same live state and coaches: messages read aloud, target changes,
and real workout edits mid-ride (add reps, drop a rep, lengthen a recovery). Optional local Whisper
lets you talk back.

![demo](docs/demo.gif)
<!-- placeholder: record a 20 s GIF of a coached interval and save it as docs/demo.gif -->

## What you get

- **Local server** (`trainer-coach serve`): owns the trainer and HR strap (bleak), reconnects after
  drops, runs the ride engine at 1 Hz, writes the ride in progress to disk and resumes it after a
  crash or restart, logs events, applies coach commands. Stdlib plus optional extras.
- **Ride modes**: structured workouts (ERG), free ride by grade (simulation), ERG watts or FTMS
  resistance level. When the plan ends you keep riding free until you press End. Pause, Save (to
  History, keeps riding) and End (two taps) on the ride screen; workout length +/-5 min.
- **History** on the server: every ride with NP, IF, TSS, best 1/5/20 min, power and HR zones, laps
  per interval, the coach transcript, FIT/TCX export, Garmin status; weekly TSS, FTP history and
  best-effort trends.
- **Web app** (`app/`): a view over the server stream. Workout builder with a text format
  (`10m 45-75%, 5x(3m 115%, 3m 50%), 10m free`), .zwo import/export, one-screen ride view with power,
  HR (zones, right-hand axis) and cadence target tiles, coach bar with the last 3 messages and your
  voice transcripts, read-aloud coach (Voice button), history with power and HR zones, FIT and TCX
  export, a simulated trainer (Sim). `browser.html` keeps the old in-tab Web Bluetooth mode as a fallback.
- **Voice** (`serve --voice`): local faster-whisper transcription with an adaptive noise gate and
  filters for silence hallucinations, fragments and the coach's own voice.
- **MCP server** (`trainer-coach mcp`): tools for an agent to read the ride, coach it and edit the
  workout, with guard rails (max change per command, FTP ceiling, no raises while paused, harder
  changes need the athlete's FEEL signal).
- **CLI**: `coach msg|set|insert|replace|delete|duration|extend`, `tail -f`, `status`, `simulate`, `voice`.
- **Headless simulator**: drives a fake ride through the API so agents and tests can run the coach
  loop with no browser or trainer.
- **Playbook** for agents: [docs/COACHING.md](docs/COACHING.md). Protocol: [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Quick start

Needs Python 3.10+ and a computer with Bluetooth LE. Any modern browser works for the page.

```sh
git clone <repo-url> trainer-coach && cd trainer-coach
python -m venv .venv && . .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -e ".[ble,mcp]"                       # add ,voice for Whisper, ,garmin for Garmin upload
trainer-coach serve                               # --voice to start the listener too
```

Open http://127.0.0.1:8765, press **Connect trainer**, pick it from the scan list. The server
remembers it and reconnects by itself. A trainer accepts one controller at a time: close Zwift or any
other app (and any browser tab using Web Bluetooth) first. Ride history lives in that origin's browser
storage plus `~/.trainer-coach/rides/`, so keep the same URL.

Browser Bluetooth fallback (no bleak, Chrome or Edge only): open `/browser.html`. In that mode the
tab owns the trainer again, so a reload reconnects instead of carrying on.

Or run `start.cmd` (Windows) / `./start.sh` (macOS, Linux): starts the server if needed and opens
the browser.

No trainer? Press **Sim** in the header, or run the headless simulator in a second terminal:

```sh
trainer-coach simulate --scenario fade --speed 10
```

## Supported hardware

| Device | Support |
|---|---|
| Smart trainers with Bluetooth FTMS (service `0x1826`) | ERG (target watts) and grade simulation |
| Tested | Zwift Hub, in browser Bluetooth mode. The server Bluetooth path (bleak) is covered by tests against a fake BLE stack but not yet ridden on hardware. |
| HR straps, Bluetooth Heart Rate service `0x180D` | Yes; trainer-relayed HR is used if no strap |
| ANT+ only devices | No |

Most current trainers (Wahoo, Tacx, Elite, Saris, JetBlack, Zwift Hub) expose FTMS; only the Zwift
Hub has been tested so far. Reports welcome.

## Connect an agent

Start the server first. The MCP server talks to it over HTTP using the token in
`~/.trainer-coach/token` (created on first `serve`). Use the same `HW_PORT`/`HW_DATA` for both.

**Claude Code**

```sh
claude mcp add trainer-coach -- trainer-coach mcp
```

or in a project `.mcp.json`:

```json
{ "mcpServers": { "trainer-coach": { "command": "trainer-coach", "args": ["mcp"] } } }
```

Then: *"Coach my ride. Read the playbook, check status every 30 s, keep me in zone."*

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.trainer-coach]
command = "trainer-coach"
args = ["mcp"]
```

**Anything else**: shell out to the CLI or call HTTP directly.

```sh
trainer-coach tail -f                      # follow the event log
trainer-coach status                       # latest ride state, JSON
trainer-coach coach msg "HR 168. Hold 250."
trainer-coach coach set cur 240            # override the current step (no guard rails)
trainer-coach coach set 7 260 --msg "Last one at 260"
trainer-coach coach insert "2x(5m 250w, 3m 50%)"   # two more reps after the current step
trainer-coach coach extend 60                      # one more minute of this step
trainer-coach coach delete 9                       # drop step 9
```

MCP tools (anything the athlete can do in the UI, an agent can do too):

| Area | Tools |
|---|---|
| Read | `get_ride_status`, `get_workout`, `get_recent_events`, `get_telemetry_history`, `get_athlete_profile`, `get_coaching_playbook` |
| Coach | `send_message`, `set_step_target`, `set_current_target`, `set_intensity`, `set_voice_mode` |
| Edit the workout | `insert_steps`, `replace_step`, `delete_step`, `set_step_duration`, `extend_current_step`, `set_workout_length` |
| Ride | `load_workout`, `ride_control` (start, pause, resume, skip, save, end), `free_ride` (grade, ERG, resistance) |
| Devices, settings | `devices` (status, scan, connect, disconnect, sim), `update_settings` |
| History | `list_rides`, `get_ride_detail`, `get_trends`, `upload_ride_to_garmin` | More examples in [examples/](examples/).

## Security model

The server binds `127.0.0.1` and rejects any non-localhost `Host` header. The page proves itself
with its own `Origin` plus an `X-HW: 1` header; local tools use a bearer token from a 0600 file.
Any local process that can read your home directory can coach your ride; nothing is exposed to the
network. Details in [docs/PROTOCOL.md](docs/PROTOCOL.md#auth).

## Voice

`pip install -e ".[voice]"`, then `trainer-coach serve --voice` (or `trainer-coach voice` beside a
running server). It transcribes the default mic locally with faster-whisper `small.en` (CPU, int8)
and posts `SAID (whisper): "..."` events that agents see in `get_ride_status`. Silence
hallucinations ("Thank you.", "Thanks for watching!"), low-confidence segments, fragments under three
words without a command word (easier, harder, stop, pause, skip, help) and echoes of the coach's
own messages are dropped. Coach messages are read aloud with the best voice the browser has. The
coach bar has a **Mute** button and a menu (Speak all, Important only, Silent); saying "mute" or
"quiet" mutes too ("unmute" to undo). When you start talking, the coach stops mid-sentence.

## Garmin upload

Optional (`pip install -e ".[garmin]"`, then `trainer-coach login-garmin` once). Garmin is only
active for the default data dir; a server on any other `HW_DATA` (tests, dev copies) has it off
unless `HW_GARMIN=on`, and `HW_GARMIN=off` / `serve --no-garmin` disables it everywhere. It uses the
unofficial [python-garminconnect](https://github.com/cyberjunky/python-garminconnect) library, which
signs in like the Garmin Connect app; Garmin can break it at any time. Every FIT file is saved to
`~/.trainer-coach/rides/` before any upload is attempted, and you can always download .fit/.tcx from
History and upload by hand. HR zones sync from Garmin when signed in.

## Data and configuration

| Env | Default | |
|---|---|---|
| `HW_PORT` | `8765` | server port |
| `HW_DATA` | `~/.trainer-coach` | `rides/`, `coach/events.log`, `coach/current.json`, `token` |
| `HW_GARMIN_TOKENS` | `~/.garminconnect` | Garmin session tokens |
| `HW_TOKEN` | from `<data>/token` | API token for CLI/MCP |
| `HW_GARMIN` | auto | `off` disables Garmin, `on` forces it for a non-default data dir |
| `HW_BLE` | `on` | `off` disables Bluetooth (no bleak import) |
| `TC_MAX_CHANGE_PCT`, `TC_MAX_PCT`, `TC_FEEL_GATE_PCT`, `TC_FEEL_WINDOW_S`, `TC_STALE_S`, `TC_MAX_INSERT_S`, `TC_MAX_EXTEND_S` | 15, 150, 105, 600, 15, 1800, 600 | MCP guard rails, see COACHING.md |

The server keeps settings (`settings.json`), remembered devices (`devices.json`), the ride in
progress (`coach/engine.json`) and every finished ride (`rides/`). The browser keeps custom workouts
and its history list, and imports rides that finished while it was closed.

## Development

```sh
pip install -e ".[dev]"
pytest
```

Tests run the browser code under Node (`node` 18+ on PATH): the workout parser, the FIT encoder
(decoded and CRC-checked with `fitdecode`), and the full app booted with a stubbed DOM against a real
test server. BLE runs against a fake bleak module, Garmin and Bluetooth are forced off, and every test
server binds a throwaway port from 8770 up. See
[AGENTS.md](AGENTS.md) for repo conventions.

## Roadmap

- Strava upload via the official API (OAuth)
- Push planned workouts to a calendar (Garmin, intervals.icu, TrainingPeaks)
- Coach-initiated grade/resistance changes in free rides
- ANT+ FE-C via a USB bridge

## License

MIT, see [LICENSE](LICENSE).
