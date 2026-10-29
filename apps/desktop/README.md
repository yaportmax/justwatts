# Just Watts desktop app (Windows, Mac)

The website's own build in an Electron window. Same UI, features, account and sync as justwatts.com. The difference:
Bluetooth runs outside the page, so the trainer and the HR strap stay connected through reloads, and the display
stays awake during a ride.

## How it works

- `scripts/build-web.mjs` runs `web/build.py` into `web/` (MODE='web'). The app serves it on `app://justwatts`.
- Bluetooth: a hidden window (`native/host.html`) runs the web build's `WebHub` (`app/js/web/ble.js`) with
  Chromium's Web Bluetooth, the stack Chrome uses on the website. It never reloads. The page gets a `DesktopHub`
  (`native/hub-core.js`) with the same interface, through `JustWattsNative.hubModule` (the hook in
  `app/js/web/backend.js`). The device chooser is in the page; remembered devices reconnect on launch.
- API: `/api/*` calls from the page go through the main process to justwatts.com with the site's Origin. The session
  cookie lives in the app's own jar, encrypted with the OS keychain (DPAPI on Windows).
- Google and Strava sign-in open in the system browser and come back through `justwatts://auth` with a one-time code
  (PKCE). Server side: `/api/auth/app/ticket` and `/api/auth/app/exchange` in `web/api/_lib/auth.js`.
- Updates: electron-updater against GitHub Releases. Checks at launch and every 4 hours, installs on quit, or the
  page shows "Update ready / Restart" when no ride is running. Never restarts mid-ride.
- Closing the window during a ride asks first. The ride is saved either way and resumes on the next launch.

## Build and run locally

Needs Node 22+ and Python 3.

```
cd apps/desktop
npm install
node node_modules/electron/install.js   # if npm skipped Electron's download script
npm start                               # builds web/ and runs the app
npm test                                # adapter, proxy and sign-in tests (no Electron needed)
npm run e2e                             # launches the app with a mocked trainer and a local API
npm run dist:win                        # dist/JustWatts-Setup.exe
npm run dist:mac                        # dist/JustWatts.dmg + JustWatts-mac.zip (on a Mac)
```

Environment for development and tests:

| Variable | Effect |
| --- | --- |
| `JUSTWATTS_API` | API origin (default `https://justwatts.com`) |
| `JUSTWATTS_DESKTOP_PROFILE` | profile folder; also skips the `justwatts://` registration |
| `JUSTWATTS_FAKE_BLE=1` | a mocked trainer and strap instead of the radio |
| `JUSTWATTS_NO_UPDATE=1` | no update checks |

`npm run e2e -- --exe "dist/win-unpacked/Just Watts.exe"` runs the same test on a packaged build.

## Releases

`.github/workflows/desktop.yml` builds and smoke-tests both installers on every push to the `apps` branch. A tag
`v1.2.3` also publishes a GitHub Release with `JustWatts-Setup.exe`, `JustWatts.dmg`, `JustWatts-mac.zip` and the
`latest*.yml` files the updater reads. The website links to `releases/latest/download/<file>`.

Signing secrets are optional and listed at the top of the workflow. Without them the Windows installer is unsigned
(SmartScreen warns) and the Mac app is ad-hoc signed (right-click, Open the first time; auto-update on Mac needs
the Developer ID signature).
