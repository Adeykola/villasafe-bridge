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
git tag bridge-v1.0.4
git push origin bridge-v1.0.4
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