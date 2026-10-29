# Social

Friends, riders nearby, group rides, chat and ride-ons. Web build only, signed in only. The local app
has no accounts, so none of this runs there.

## Transport

Plain HTTP polling to the accounts function (`web/api/accounts.js`, routes in `web/api/_lib/social.js`),
backed by the same Postgres. No extra service. The page side is `app/js/web/social.js`; every call goes
through `createLink()` there, so a pub/sub client can replace it later.

- While a course or open-world ride runs, the page posts its position about every 2 s and gets the
  riders around it in the same reply (one call out at a time; a failure only backs off).
- The server keeps one presence row per rider, overwritten on each call, and reads it back by area
  cell (open world: 0.05 degree cells, then 5 km by distance) or by course. One SQL statement per call.
  Rows older than 15 s are not shown; older than 75 s are deleted.
- In a group ride the same call carries new group chat. An open chat polls every 3 s.

## Endpoints (`/api/social`)

| Method | Path | What |
| --- | --- | --- |
| GET | `/api/social` | Friends panel: friends (riding now or not), requests, blocked, group rides, activity |
| GET, POST | `/api/social/me` | Share code and visibility (`{ visible }`) |
| POST | `/api/social/search` | `{ q }`, display names, 2+ characters |
| POST | `/api/social/friends/request` | `{ id }` or `{ code }` (share link) |
| POST | `/api/social/friends/accept`, `/remove` | `{ id }`; remove also declines or cancels |
| POST | `/api/social/block`, `/unblock` | `{ id }`; a block hides both ways |
| POST | `/api/social/presence` | `{ open, lat, lon, h, d, course, cid, road, w, v, group, visible, chat }` -> `{ riders, chat }` |
| POST | `/api/social/presence/stop` | Ride over: drop my row |
| POST | `/api/social/groups` | `{ name, plan, at, workout, invite }` |
| GET | `/api/social/groups/:id` | Lobby: the group and its members |
| POST | `/api/social/groups/:id/join`, `/leave`, `/invite` | The organizer leaving cancels it |
| POST | `/api/social/chat/read`, `/send`, `/report` | `{ group }` or `{ to }` (friends only) |
| POST | `/api/social/activity` | A finished ride for friends (not sent when hidden) |
| POST | `/api/social/activity/:id/rideon` | Friends only, once |

Share links: `/?friend=<code>` and `/?group=<id>`; the page removes them from the address bar.

## Limits

Per account: presence 60 a minute, chat 20 a minute and 1000 a day (100 for accounts under a day old),
searches 30 a minute, friend requests 50 a day, group rides 20 a day. Chat uses the community word
and link filter; 3 reports hide a group message (1 for a direct message) until the owner reviews it in
Settings, Moderation.
