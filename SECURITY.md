# Security

## Reporting

Please report vulnerabilities privately through GitHub's "Report a vulnerability" button
(Security tab of this repository), not in a public issue. Include steps to reproduce. You will get
an answer within a week.

## Threat model

- **Local server only.** `openspin serve` binds `127.0.0.1`. Every request needs a localhost `Host`
  header (blocks DNS rebinding) and requests carrying proxy headers (`X-Forwarded-For`, ...) are
  refused. Writes need the page (same `Origin` plus `X-HW: 1`) or the bearer token. Pages cannot be
  framed. Do not put the server behind a public proxy or tunnel; if you set a share base URL, forward
  only `/share/*.png`.
- **Other software on this computer is trusted.** Any local process can read the open endpoints,
  and one that can read `<data>/token` (or fake an `Origin` header) can do whatever the page can.
- **The token** (`<data>/token`, mode 0600) lets agents, the CLI and the MCP server read ride state
  and history, coach (messages, targets, workout edits within the guard rails), control rides,
  devices and settings, and start uploads. It cannot set the Strava client secret, and no endpoint
  returns Strava or Garmin tokens or the secret.
- **Prompt injection.** Ride and workout names, coach messages and voice transcripts reach agents as
  text. Treat them as untrusted input in agent prompts.
- **The Strava relay** (`web/api/strava/token.js`, deployed with the web build) holds only OpenSpin's
  shared Strava client ID and secret, in environment variables. It swaps an OAuth code or refresh
  token for access tokens, stores and logs nothing, and returns only the token fields. Its operator
  sees refresh tokens in transit; set up your own Strava API app in Settings to bypass it.
- **Web build** is static (strict CSP, no third-party scripts). Rides stay in the browser's
  IndexedDB. Only import backup files you made yourself.
