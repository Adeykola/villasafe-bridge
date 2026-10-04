# Publishing native installers

This repo's only job is to build signed `.exe`, `.dmg`, and `.AppImage`
installers for the **VillaSafe Gate Bridge** desktop app and attach them to
a GitHub Release. The main VillaSafe web app downloads them from
`https://github.com/Adeykola/villasafe-bridge/releases/latest/download/...`.

## One-time setup

1. Push this folder to `main` on `Adeykola/villasafe-bridge`.
2. Make sure GitHub Actions is enabled (Settings → Actions → "Allow all").
3. **Settings → Actions → General → Workflow permissions** → select
   **"Read and write permissions"** → Save. Without this, the release job
   cannot create the GitHub Release and the build fails with
   `403 Resource not accessible by integration`.
4. Verify the workflow file `.github/workflows/release.yml` is present.

## Cut a release

```bash
# from your local clone of villasafe-bridge
git tag bridge-v1.1.0
git push origin bridge-v1.1.0
```

The matrix workflow then runs on Windows, macOS, and Ubuntu runners,
produces version-less filenames (so the VillaSafe dashboard's
`releases/latest/download/...` links never break on a version bump):

- `VillaSafeGateBridge-Setup.exe`
- `VillaSafeGateBridge.dmg`
- `VillaSafeGateBridge.AppImage`

...and attaches them to the GitHub Release for the pushed tag (e.g.
`bridge-v1.0.5`).

## Updating the bridge code

The source of truth is the `desktop/` folder inside the private VillaSafe
project. After changes there, run `node scripts/sync-bridge-repo.mjs`
inside that project, copy the refreshed `bridge-repo/` contents into your
local clone of this repo, bump `package.json` version, commit, and tag
`bridge-vX.Y.Z`.

## Release notes

- **v1.2.5** — Tags work offline through a Hikvision controller. Cards were
  written into the controller with no person, door permission or validity,
  so the controller refused them whenever it had to decide alone (internet
  down, PC unreachable or off). Each tag now goes on a person allowed through
  its lane's doors on the all-day schedule, valid until the tag expires or
  the resident's next bill falls overdue, so the controller pauses owing
  residents on time even with the PC off; cards written by older versions are
  fixed up. The bridge now starts with Windows and keeps running in the
  background (tray icon) when its window is closed, and gives up on a hung
  request to VillaSafe after 20 seconds.
- **v1.2.4** — Long-range readers wired by Wiegand into a Hikvision
  controller now work end to end. The bridge listens for card swipes on every
  controller behind a VillaSafe lane (it only listened on its own internal
  lane list before, so these swipes never reached VillaSafe), re-arming every
  minute so a rebooted controller reports again. Each swipe is tied to its
  lane by controller and door. Cards are written into the controller in its
  own number format (decimal, learned exactly from its swipes) instead of
  hex, which it never matched; and a card VillaSafe allows also opens the
  lane from the bridge, so the boom lifts even before the controller has it.
- **v1.2.3** — The long-range reader says what's wrong instead of failing
  silently: a serial port that isn't on the PC (listing the ports that are),
  a port another program holds, a pulled cable, or data with no tag numbers
  in it. This shows on the bridge, in Gate Bridges and on VillaSafe's Gate
  reader page and Scan card. A reader that can't open keeps retrying, so
  plugging the cable in later just works; if the lane names a port the PC
  doesn't have and there's one USB serial port, that one is used; and the
  reader's ASCII or native output is detected by itself.
- **v1.2.2** — Card reads reach VillaSafe within about a second, so a card
  held to the gate reader can be enrolled to a resident from VillaSafe's Scan
  card, and the Gate reader page shows each read live. A resident whose next
  bill falls overdue during an internet outage is paused on time, on the PC's
  clock. Reads of residents let in while offline are uploaded (they used to
  be dropped), and everything decided offline keeps the time it happened.
  S4A frames whose EPC contains `7E` are read whole, and a card enrolled by
  its printed Wiegand number opens for the full EPC. Only one sync runs at a
  time, so a gate command is never fetched twice.
- **v1.2.0** — Desktop licence: the estate's `VS-…` licence key is entered
  when pairing, and a paired PC that VillaSafe hasn't licensed locks its lanes
  and asks for the key on its own screen. v1.1.0 and older have no key field,
  so they must be updated to this version to keep working. Also: the
  Hikvision (HCNetSDK) service is built into the app, RFID tags are kept on
  the PC with suspend, renew and expiry, and guard phones can reach the PC
  over Wi-Fi as well as cable.
- **v1.1.0** — Redesigned app: big Open/Close buttons per lane with live
  device health, a live activity feed, a readable health check, and a guided
  6-digit pairing screen. New offline scanning: the bridge keeps the estate's
  valid guest passes (codes stored hashed) and serves a signed local API on
  TCP 8787, so VillaSafe phone apps on the estate network can scan through it
  and open the lane with no internet. Scans upload with their real time when
  the connection returns. Allow the app through Windows Firewall on private
  networks.
- **v1.0.14** — Make DS-K2804 door opening resilient across Hikvision SDK
  firmware variants. The hardware-bridge now tries `NET_DVR_RemoteControl`
  command `16009` with the full `NET_DVR_CONTROL_GATEWAY` payload first,
  falls back to 1-based `NET_DVR_ControlGateway`, then tries the older
  command `2001` DWORD payload. Logs now show the method that worked or every
  SDK code that failed.
- **v1.0.13** — Fix `SDK error 17 — Parameter error` on DS-K2804 door open.
  `NET_DVR_RemoteControl` command `2001` expects a 4-byte DWORD gateway
  index, not a `NET_DVR_CONTROL_GATEWAY` struct. The hardware-bridge now
  sends the correct 4-byte payload. Close is treated as best-effort (DS-K
  controllers auto-close after dwell) and no longer surfaces red failures.
- **v1.0.12** — Fix `SDK error 11 — Device is not supported.` when opening
  or closing a door on DS-K2804 (and other DS-K access-control panels).
  The hardware-bridge now uses `NET_DVR_RemoteControl` with command
  `NET_DVR_REMOTE_OPEN_DOOR (2001)` and a `NET_DVR_CONTROL_GATEWAY`
  payload, which is the supported path on access controllers.
  `NET_DVR_ControlGateway` (NVR/DVR-only) is no longer called.
- **v1.0.11** — Fix `Expected 2 arguments, got 1` crash during Hikvision
  controller login. The koffi FFI calls now pass the required count
  argument to `koffi.alloc`, and any future SDK marshalling error is
  surfaced as a `LOGIN_FAILED` with SDK context instead of a bare
  `INTERNAL`.
- **v1.0.10** — Fix `HTTP 400` from hardware-bridge on controller upsert.
  The bridge REST layer now accepts slug controller IDs (e.g.
  `hik-192-168-1-64`) in addition to UUIDs, matching what the desktop
  Hikvision driver sends.
- **v1.0.9** — Hikvision driver now surfaces real error messages from the
  hardware-bridge instead of `[object Object]`. Login failures, missing
  SDK, and network timeouts each report their own code and hint.