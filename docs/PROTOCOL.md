# Protocol

The local server owns the ride. It talks Bluetooth to the trainer and HR strap, runs the ride engine
once a second, and serves the web page, which is only a view: reloading or closing the page never
interrupts a ride. The CLI uses the same HTTP API.

```
 trainer, HR strap ── BLE (bleak) ── justwatts serve ── SSE /api/stream ──▶ page (any browser)
                                       │  ride engine        ◀── /api/ride/control, /api/devices
                                       │  events.log, engine.json
                                       └── HTTP ── CLI
```

Default base URL `http://127.0.0.1:8765` (`JUSTWATTS_PORT`). Data dir `~/.justwatts` (`JUSTWATTS_DATA`).

## Auth

| Check | Applies to | Rule |
|---|---|---|
| Host | every request | `Host` must be `127.0.0.1:<port>` or `localhost:<port>` and no proxy header (`X-Forwarded-For`, `Forwarded`, ...) may be present, else `421`. Blocks DNS rebinding and accidental exposure through a proxy. |
| Page | write endpoints, state/event reads | `Origin` equals the app origin and header `X-HW: 1`. The custom header forces a CORS preflight that the server never answers, so other sites cannot send it. |
| Token | same | `Authorization: Bearer <token>`. Created at first `serve` in `<data>/token` (mode 0600). A token request with a foreign `Origin` is refused. |

Open endpoints (Host-checked only): `GET /api/health`, `/api/stream`, `/api/live`, `/api/settings`,
`/api/devices`, `/api/rides`, `/api/rides/<id>`, `/api/garmin/status`, `/api/garmin/zones`, static files. Browsers block other origins from reading
them (no CORS headers). Local tools should use the token, never fake `Origin`.

```sh
curl -s -H "Authorization: Bearer $(cat ~/.justwatts/token)" http://127.0.0.1:8765/api/state
```

## Endpoints

| Method | Path | Auth | Body / query | Response |
|---|---|---|---|---|
| GET | `/api/health` | none | | `{ok, app, version, garmin, ble}` |
| GET | `/api/stream` | none | | Server-sent events: one `data:` live message per engine change, at least 1/s |
| GET | `/api/live` | none | `?ride=<id>&n=<count>` | one live message (polling fallback) |
| GET | `/api/state` | page/token | | `{state}` (state object below) |
| GET | `/api/events` | page/token | `?n=50` (1..2000) | `{events: [parsed]}` from `live/events.log` |
| POST | `/api/ride/control` | page/token | `{action, ...}` | `{ok, ...}`; actions below |
| GET | `/api/ride/course` | page/token | | `{course, d}`: the ride's whole course and the metres ridden (an open-world page rebuilds its road plan from it) |
| GET/POST | `/api/settings` | none / page/token | partial settings | `{settings, stored, garmin}` |
| GET | `/api/devices` | none | | device status |
| POST | `/api/devices` | page/token | `{action: scan\|connect\|disconnect\|sim, kind: trainer\|hr, address?, name?, on?, timeout?}` | status, or `{devices: [{address, name, rssi}]}` for scan; `503` when Bluetooth is off |
| GET | `/api/rides` | none | | `{rides: [{id, name, start, time_s, avg_w, np, if, tss, kJ, avg_hr, best: {1m, 5m, 20m}, ftp, ftp_estimate, garmin, ...}]}` newest first |
| GET | `/api/rides/<id>` | none | | ride payload |
| GET | `/api/rides/<id>/detail` | none | | `{summary, best, power_zones_s, hr_zones_s, laps: [...], garmin, strava, description, ftp_estimate?}` |
| GET | `/api/rides/<id>/fit`, `/tcx` | none | | file download (encoded on the server) |
| POST | `/api/rides/<id>/garmin` | page/token | | upload that ride; records Garmin status |
| POST | `/api/rides/<id>/delete` | page/token | | moves it to `rides/trash/` |
| GET | `/api/trends` | none | `?weeks=12` | `{weeks: [{week, tss, time_s, kJ, rides}], ftp_history: [...], best: {1m, 5m, 20m}}` |
| POST | `/api/garmin/import` | page/token | `{force?}` | copies FTP, weight, HR zones from Garmin into settings |
| GET | `/api/strava/status` | none | | `{client_id, has_secret, configured, connected, athlete, scope, auto}` (never the secret) |
| POST | `/api/strava/config` | **page only** | `{client_id, client_secret?}` | stores the user's Strava API app; a bearer token is refused, so no local tool can set it |
| GET | `/api/strava/connect` | none (navigation) | | 302 to Strava OAuth, scope `activity:write,activity:read`, redirect `http://localhost:<port>/api/strava/callback` |
| GET | `/api/strava/callback` | state check | `code, state, scope` | stores tokens in `<data>/strava_token.json`, 302 back to the app |
| POST | `/api/strava/disconnect` | page/token | | forgets the tokens |
| POST | `/api/rides/<id>/strava` | page/token | | upload (FIT, `external_id` = ride id), poll status, store the activity id |
| POST | `/api/rides/<id>/description` | page/token | `{text}` | a note that leads the Strava description |
| POST | `/api/rides/<id>/card` | page/token | PNG bytes | stores the share card |
| GET | `/share/<id>.png` | any Host | | the share card, only when `settings.shareBaseUrl` is set |
| POST | `/api/ride` | page/token | ride payload | archive to `rides/<id>.json` (the page moves rides kept in old browser storage here) |
| POST | `/api/garmin/upload` | page/token | FIT bytes, header `X-Filename` | `{ok, saved, activityId?, duplicate?, disabled?, error?}`. Always saved to `rides/` first. `503` when Garmin is disabled, `401` when not signed in. |
| GET | `/api/garmin/status`, `/api/garmin/zones` | none | | `{linked, enabled}`, `{floors, max, lthr}` or `502` |

### Ride control actions

`load {workout: {name, text, test?} | null, course?}` (null = free ride; finishes a started ride first;
`course` see Courses below),
`start`, `hold` (pause; during an auto-pause it makes the pause stick), `resume`, `pause` (toggle),
`road` (open world, see Courses), `skip`, `back` (restart the current step, or in its first 10 s ride the previous one again; inserts
copies, time only moves forward; after the plan it rides the last step again), `save` (archive the
ride so far, keep riding), `end` (finish and save), `adjust {dir: 1|-1, big?}` (intensity 1 %, or
grade 0.5 % / 5 W / level 0.5 when the trainer is not following the plan in ERG; `big` is 5 times
that), `intensity {percent: 50..150}`, `target {w | delta, step?}` (a step's watts as the trainer
gets them now, default the current step; free ride: ERG watts), `mode {m}` (free ride `g|w|r`;
workout `e` = ERG follows the plan, `g` or `r` = ERG off, the rider sets grade or level and the plan
still shows and records its target), `free {m: g|w|r, value}` (grade %, ERG watts or FTMS level
0..25; in a workout `g` or `r` only), `edit {edit: {...}}` (see Edits below), `dismiss` (clears
`notice`).

Free steps and a flat finish (`afterWorkout: grade0`) ride by grade, and +/- moves that grade.
FTP tests refuse `adjust` and `intensity` in ERG (their targets are fixed).

Each target or plan change writes a `MANUAL <what>` line (edits write their `EDIT` line) and is
echoed as `did` in the response.

When the planned workout ends the ride does not stop: it writes `WORKOUT DONE`, sets
`ride.overtime`, keeps recording and holds the last target (`afterWorkout: hold`) or rides flat at
grade 0 (`afterWorkout: grade0`) until `end`. Inserting steps in overtime turns the time ridden
since into a free step and starts the new steps now.

### Courses

A ride can carry a course: `{name, dist, ele, ll?}` with `dist` in metres (100..500000), `ele` the
smoothed elevation every 10 m from the start, `ll` an optional decimated `[[lat, lon]]` polyline.
The page builds it from a GPX or TCX file (`app/js/course.js`, mirrored by `server/justwatts/course.py`):
track points, haversine distance, resampled every 10 m, 50 m median then 90 m moving average; the
grade of each 10 m segment is clamped to -15..+20 %. The engine checks it and keeps it with the ride.

Each second the engine turns power into a virtual speed (rider weight from settings, 75 kg when
unset, plus a 9 kg bike; CdA 0.32, Crr 0.004, air 1.2 kg/m3, drivetrain 0.97; kinetic energy
integrated, so the rider speeds up, slows down and coasts) and moves along the course. Position
always advances while riding, whatever the trainer follows.

- Course alone: grade mode sends the road grade under the rider (+/- adds an offset, `jr.g`). ERG
  watts and level modes still work and the position still advances.
- Workout + course: steps with a target ride ERG as usual; `free` steps (and ERG off) send the road
  grade. With no course, grade mode is flat (0 % plus +/-).
- Grade commands are rate limited: a change over 0.1 % goes out at once, smaller ones at most every 2 s.
- Open world: `{name, open: true, ele, ll, nd?}` with `ll` one `[lat, lon]` per `ele` point (so `dist` is
  10 m times the points less one) and `nd` the page's road plan, ascending `[metres, OSM node id]`. The
  page (`app/js/world.js`, `app/js/roads.js`) loads OpenStreetMap roads, plans the road ahead and adds it
  with `road {at, ele, ll, nd?}`: the points from index `at` on are replaced (`nd` from its first entry on),
  never the segment under the rider; `at` at the end appends. Answers `{n}` (points now). The rider
  waits at the end of the known road; there is no finish. On `end` the course keeps only the road ridden.
- At the finish the ride does not stop: `COURSE DONE` is written, the distance keeps counting, and
  the grade holds the last segment (`afterWorkout: hold`) or goes to 0 % (`grade0`) until `end`.

### Edits

`edit {edit: {...}}` changes the workout itself; the timeline, totals, later step numbers and the
chart update.

| op | Fields | Effect |
|---|---|---|
| `insert` | `steps` (workout text), `after` (`"cur"` or n, default cur) | inserts any number of steps after step n |
| `replace` | `step`, `steps` | replaces step n; for the current step, keeps what was ridden and starts the replacement now |
| `delete` | `step` | removes an upcoming step; `"cur"` ends the current step now |
| `duration` | `step`, `seconds` | sets a step's length (the current step never ends in the past) |
| `extend` | `seconds` (+/-) | lengthens or shortens the current step |
| `total` | `seconds`, `how` (`last` or `scale`) | sets the planned total: `last` changes the last block (dropping trailing steps when needed), `scale` stretches every remaining step |
| `rest` | `steps` (may be empty), `after` (optional: the step the text was based on), `with_current` | replaces every step after the current one; empty ends the plan after it; after the plan it adds steps now. A stale `after` is refused |

Errors return `400` and change nothing. Only the current and later steps can be edited. Overrides
move with their steps. Each edit writes an `EDIT ...` event line.

## Live message (`/api/stream`, `/api/live`)

```json
{"state": {...}, "ride_id": "r-1767250800000", "reset": false, "samples": [[...]], "n": 1834}
```

`samples` holds only the samples after the client's count `n`; `reset: true` means a new ride, and
`samples` is then the full list.

## State object

```json
{
  "v": 1, "source": "server", "ts": 1767250881000, "version": 1834,
  "athlete": {"ftp": 200, "weight_kg": 75, "hr_zones": [100, 120, 140, 160, 180], "hr_max": 190, "hr_zones_source": "garmin", "cadence_range": [85, 95]},
  "devices": {"trainer": "ble", "trainer_name": "Zwift Hub", "trainer_address": "...", "hr": "HRM-Pro", "hr_name": "HRM-Pro", "hr_connected": true, "hr_waiting": false, "ble": true, "error": null},
  "live": {"power": 251, "power_3s": 248, "cadence": 89, "hr": 158, "speed_kmh": 31.2},
  "last_finished": {"id": "r-...", "name": "...", "samples": 3600, "ts": 1767254400000},
  "notice": null,
  "ride": {
    "id": "r-1767250800000", "name": "VO2 5x3", "text": "12m 40-75%, ...", "mode": "workout",
    "started": true, "paused": false, "auto_paused": false, "elapsed_s": 1834, "el": 1834.0,
    "ftp": 200, "intensity": 1.0, "test": false, "target_w": 230, "grade": null, "jr": {"m": "g", "g": 0, "w": 120},
    "samples": 1834, "ov": {"6": 275}, "control": "k",
    "last30": {"power": 229, "cadence": 88, "hr": 158, "hr_delta": 6},
    "total_s": 3180,
    "step": {"index": 7, "count": 15, "duration_s": 180, "into_s": 61, "left_s": 119, "free": false},
    "steps": [{"index": 1, "start_s": 0, "duration_s": 720, "free": false, "start_w": 80, "end_w": 150,
               "planned": {"a": 0.4, "b": 0.75, "unit": "%"}, "override_w": null}]
  }
}
```

- `devices.trainer`: `none`, `wait` (connecting or reconnecting), `ble`, `sim`.
- `ride` is null when nothing is loaded. `mode`: `workout`, `erg` or `grade` (free ride).
- `steps` is the live list after overrides and edits; `start_w`/`end_w` are resolved watts;
  `override_w` is set on a step whose target was changed.
- `control`: what the trainer follows and +/- changes: `k` (ERG at plan times intensity), `w` (ERG
  watts), `g` (grade), `r` (level). `jr.wm` is the workout trainer mode (`e`, `g`, `r`).
- `course`: null, or `{name, dist_m, gain_m, done_m, odo_m, ele_m, climbed_m, grade, speed_kmh, end,
  profile, open, n}` (`open`: an open-world course, `n` its points). `done_m` stops at the finish, `odo_m` keeps counting; `grade` is the road under the rider
  (before rate limiting and the +/- offset); `profile` is the elevation in at most 300 points for drawing.
- `source` is `server` (`web` in the web build).

## Event lines

`live/events.log`, one per line, `[HH:MM:SS]` server local time. `GET /api/events` parses each into
`{time, type, raw, text, ...fields}`.

| type | Line | Fields |
|---|---|---|
| `ride_start` | `RIDE START <name> \| FTP <ftp> \| <n> steps, <total>` or `\| free` | name, ftp, steps, total_s |
| `step_start` | `START step <i>/<n> <dur> @<w\|free>W` | step, steps, duration_s, target_w |
| `step_end` | `END step <i>: avg <w>W (tgt <w>) \| HR avg <bpm> max <bpm> end <bpm> \| cad <rpm>` | step, avg_w, target_w, hr_avg, hr_max, hr_end, cadence |
| `paused` | `PAUSED` or `PAUSED (stopped pedaling)` | auto |
| `resumed` | `RESUMED` | |
| `ride_resumed` | `RIDE RESUMED after <reload\|restart> at T+<el> (<n> samples kept)` | after, elapsed_s, samples |
| `ride_end` | `RIDE END <el>` | elapsed_s |
| `edit` | `EDIT <insert\|replace\|delete\|end\|duration\|rest> ... \| <n> steps, <total>` | op, detail, steps, total_s |
| `manual` | `MANUAL intensity 105%`, `target step 3 250W`, `skip step 3`, `back step 2`, `mode erg\|grade\|level`, `grade 2.5%`, `erg 180W`, `level 6.0` | action, detail |
| `workout_done` | `WORKOUT DONE at T+<el>, riding free until End` | elapsed_s |
| `course_done` | `COURSE DONE at T+<el>, riding on until End` | elapsed_s |

`-` means no data. Other lines (Garmin and Strava results, ...) parse as type `other`.

## Ride payload

`/api/rides/<id>`, `engine.json` (server ride in progress), and the page's `localStorage`
(`hw.rides`).

```json
{"id": "r-1767250800000", "name": "VO2 5x3", "text": "12m 40-75%, ...", "steps": [{"d": 720, "a": 0.4, "b": 0.75, "u": "%"}],
 "test": false, "ftp": 200, "start": 1767250800000, "el": 1834.2, "k": 1, "jr": {"m": "g", "g": 0, "w": 120},
 "ov": {"6": 275}, "samples": [[1767250801000, 1.0, 152, 88, 121, 29.4, 150]], "source": "server"}
```

Sample: `[epoch_ms, elapsed_s, watts, cadence, hr (0 = none), speed_kmh, target_w (0 = none)]`, 1 Hz.
On a course each sample adds `altitude_m, distance_m` (course metres ridden) and `speed_kmh` is the
virtual speed; FIT and TCX then carry altitude and that distance. Course rides also store `course`
and `cs` (`{d, v, up, end}`: metres ridden, m/s, metres climbed, finished).
`steps` is the final step list (edits included); `text` is regenerated from it.

## Persistence and recovery

- Every sample is appended to `live/engine.journal` (flushed each second). `live/engine.json` is a
  full atomic snapshot every 30 samples and after every control and edit; the journal is
  restarted after each snapshot. On start the server resumes snapshot plus journal (a torn last line
  is skipped), paused until pedaling; rides older than 6 h are archived as "(recovered)".
- Each ride carries its own event lines (`events`) into the archive.
- Garmin upload status lives in `rides/meta/<id>.json`. With auto-upload on, the server uploads when
  the ride ends, even with no page open.
- `devices.json` remembers the trainer and strap; the server reconnects at start and after every
  drop, until you press Disconnect.
- `settings.json` holds FTP, weight (kg), units (`imperial` or `metric`, display only), HR zones
  (`hrZonesSrc`: `default`, `manual` or `garmin`), cadence range and Garmin auto-upload.

## Workout text

```
10m 45-75%, 5x(3m 115%, 3m 50%), 1m 300w, 10m free
```

Steady `10m 50%`, ramp `5m 50-90%`, absolute `1m 300w`, free `10m free`, repeats `5x(...)`
(nestable). Durations `1h`, `10m`, `10min`, `30s`, `30sec`, combined `1m30s`. `.zwo` import/export
maps SteadyState, Ramp/Warmup/Cooldown, IntervalsT, FreeRide/MaxEffort.

## FTMS (trainer side)

- Indoor Bike Data `0x2AD2` notifications: speed, cadence, power, HR (if the trainer relays it).
- Control Point `0x2AD9`: request control `0x00`, start `0x07`, ERG target `0x05 <u16 W>`,
  simulation `0x11 <wind s16> <grade s16 0.01%> <crr 0.0001> <cw 0.01>`. Only the latest wanted
  command is sent. A "control not permitted" response triggers a new control request and a resend.
- Heart Rate service `0x180D`, measurement `0x2A37`.
