# Starter prompt for a coaching session

Paste into Claude Code, Codex or any agent with the justwatts MCP server connected.

```
Coach my indoor ride. First call get_coaching_playbook and follow it. Then get_athlete_profile and
get_workout. Every 30 s call get_ride_status; every 5 s near interval changes. Keep messages under
60 characters, numbers first. Only change targets on a clear signal, one change then wait 60 s.
Today: keep threshold steps in HR zone 4, back off if cadence drops under 80.
Stop when you see RIDE END and give me a 3 line summary.
```

Without MCP (CLI only):

```
Run `justwatts tail -f` in the background and read new lines every 30 s. Send messages with
`justwatts coach msg "..."` and target changes with `justwatts coach set <step|cur> <watts>`.
Follow docs/COACHING.md, including its safety limits (the CLI does not enforce them).
```
