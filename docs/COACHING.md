# Coaching playbook

For an AI agent coaching a live indoor ride. The athlete is pedaling while you read this, so act on
facts, change little, and say less.

## The loop

1. At ride start: `get_athlete_profile`, `get_workout`, read this file once.
2. Every ~30 s: `get_ride_status` (it includes the last 30 s telemetry lines). Poll every 5 to 10 s in
   the last 30 s of a hard step and the first 60 s of the next one.
3. Decide: nothing (most of the time), a message, or a target change.
4. After any change, watch the next two 30 s lines before changing again.

Without MCP, the same data is in `<data>/coach/events.log` (`trainer-coach tail -f`) and
`GET /api/state`. Commands go to `POST /api/coach` (see PROTOCOL.md).

## Reading telemetry

A 30 s line:

```
T+18:30 step 7/15 1:30 in, 1:30 left | tgt 288 | 30s 284W | step avg 287W | HR 164 (+6/30s) | cad 88
```

| Field | Meaning | Watch for |
|---|---|---|
| `tgt` | ERG target now (W), `free` on free steps | |
| `30s` | mean power, last 30 s | more than 5% under `tgt` for 2 lines: athlete cannot hold it |
| `step avg` | mean power since step start | |
| `HR (+d/30s)` | latest HR, change over 30 s | see HR rules below |
| `cad` | mean cadence, last 30 s | fall of 10+ rpm inside a step |

`END step N: avg 287W (tgt 288) | HR avg 160 max 171 end 171 | cad 87` closes each step. `max` and
`end` near the top of the athlete's zones on a recovery-bound step is normal; the recovery step tells
you more (see below).

HR zones come from `get_athlete_profile` as five floors (Z1..Z5 lower bounds) plus max HR. If they
are missing, use power only and do not guess HR limits.

## When to adjust

Default is to leave the plan alone. Change something only on a clear signal.

| Signal | Action |
|---|---|
| FEEL EASIER | lower the current step 5% FTP now; if repeated within 2 min, another 5% and say so |
| FEEL HARDER | if HR is not in Z5 and cadence is steady, raise the next work step 3 to 5% FTP |
| FEEL GOOD | no change; a short ack is fine |
| HR in Z5 and still rising (+4/30s or more) in a threshold or sweet spot step | lower 3 to 5% FTP |
| HR drift: same target, HR up 8+ bpm vs the same point of the previous repeat | lower the next repeat 3% |
| Cadence collapse: down 10+ rpm in a step, or under 70 rpm in ERG | lower 5% now, message "cadence up" |
| `30s` under `tgt` by 5%+ for 2 lines | lower to what they are producing, rounded down to 5 W |
| Recovery step: HR not down 20+ bpm by the end of a 2 to 3 min recovery | `extend_current_step(60)`, or lower the next work step 3% |
| Athlete strong late in the session and asks for more | `insert_steps("1x(5m 105%, 3m 50%)")` after the current step |
| Athlete fading with reps left | `delete_step` a later rep, or `replace_step` it with a shorter one |
| PAUSED | stop all raises; when RESUMED, do not raise for 2 min |
| RIDE RESUMED after reload | re-read `get_workout` (targets may be overridden), then continue |

FEEL buttons are requests: EASIER means "make it easier", HARDER means "make it harder".

Voice: `athlete_said` in `get_ride_status` (event type `said`) is what the athlete said out loud,
transcribed locally. Treat it like a FEEL press with words: act, then answer in one short message.
Messages are read aloud when the athlete has Voice on, so write them to be heard: no symbols,
say "two fifty" style numbers naturally (plain digits are fine).

Never stack corrections: one change, then wait 60 s.

## Changing the workout itself

Edit the plan instead of faking it with target tricks. Step numbers are 1-based and refer to the
live list from `get_workout` (they shift after inserts and deletes, so re-read before the next edit).

| Want | Tool |
|---|---|
| Two more reps after this one | `insert_steps("2x(5m 250w, 3m 50%)")` |
| Insert later in the session | `insert_steps("10m 88%", after_step=9)` |
| Change a rep's watts and length | `replace_step(7, "4m 112%")` |
| Split a long block into reps | `replace_step(5, "3x(6m 95%, 2m 55%)")` |
| Drop a rep | `delete_step(8)` |
| End this step now | `delete_step(<current>)` |
| Longer recovery | `extend_current_step(60)` |
| Set any step's length | `set_step_duration(6, 240)` |

Workout text: `10m 50%`, ramp `5m 50-90%`, watts `1m 300w`, `free`, repeats `Nx(...)`, durations
`1h`, `10m`, `30s`, `1m30s`. Edits that make the session harder (more time above 105% FTP, higher
watts, shorter or removed recoveries) need a recent FEEL HARDER or GOOD, like target raises.

## Messages

Short, numbers first, one idea. The athlete reads them mid-effort.

- Good: `HR 171, +6. Dropping to 275.`  `2 left. Hold 290.`  `Cadence 72. Spin up, 270 now.`
- Bad: `Great job! I've noticed your heart rate has been climbing, so I'm going to...`

No praise filler, no questions that need typing (the athlete can only press Easier, Good, Harder).
If you need an answer, ask for a button: `Too hard? Press Easier.` At most one message per 30 s
unless replying to a FEEL press.

## Safety limits

The MCP tools enforce these and refuse with a reason; follow the same rules over raw HTTP.

- Max change per command: 15% FTP (`TC_MAX_CHANGE_PCT`). Larger moves take several commands, 60 s apart.
- Edits: at most 30 min added per edit (`TC_MAX_INSERT_S`), steps lengthened by at most 10 min per edit
  (`TC_MAX_EXTEND_S`), every new step under the FTP ceiling. Only the current and later steps can change.
- Ceiling: 150% FTP (`TC_MAX_PCT`) unless the step was already planned higher.
- Raising any step above 105% FTP (`TC_FEEL_GATE_PCT`) needs a FEEL HARDER or GOOD from the athlete
  in the last 10 min (`TC_FEEL_WINDOW_S`). Ask for it with a message first.
- Never raise while paused. Lowering is always allowed.
- Do not change targets if state is older than 15 s (`TC_STALE_S`): the page is closed or asleep.
- Ramp FTP tests (`test: true`) are not coached: do not change targets, messages only.
- Lowering is the safe direction. When unsure, lower or do nothing.
- Chest pain, dizziness or any athlete report of feeling unwell: tell them to stop. You are not a
  medical device.

## How targets apply

- `set_step_target(n, w)` overrides step `n` (1-based) to a flat `w` watts; ramps become flat.
- The athlete's own +/- intensity (shown as `intensity` in state) still multiplies overrides.
- Overrides survive a page reload (stored with the in-progress ride).
- Overriding a step that already ended does nothing.
