# VillaSafe Gate Bridge (Desktop)

Cross-platform desktop app that connects the VillaSafe cloud to physical gate hardware:

- Full-height turnstiles
- Boom barriers
- Tyre killers / road blockers

## Brand-agnostic by design

Any device that exposes one of the following triggers is supported:

| Driver  | Hardware example                                     |
|---------|------------------------------------------------------|
| relay   | USB/serial relay board (Sainsmart, Numato, KMtronic) firing a dry-contact input on the device |
| tcp     | IP controller listening for ASCII OPEN/CLOSE commands |
| modbus  | Industrial barrier / spike controller on RS-485       |
| wiegand | Reader emulator sending card IDs to an access panel   |

## Setup

1. Install Node.js 20+.
2. `npm install`
3. `npm start`
4. In the app, enter the 6-digit **pairing code** from VillaSafe → Gate Bridges and click **Pair this PC**. Cloud connection details are baked into the build — no URL or key to paste.
5. Configure lanes from the web UI; the desktop app pulls config and listens for commands.

One installed Bridge pairs to one estate (the site whose hardware it's wired to). To serve another estate, install the Bridge on a PC at that site.

## Packaging

```
npm run package:win    # Windows .exe folder
npm run package:mac    # macOS .app
npm run package:linux  # Linux executable
```

## Triggers

- Realtime command queue from Supabase (`gate_commands` table)
- Manual buttons in the desktop UI
- ANPR cameras posting to `http://<bridge-host>:8765/anpr` with `{plate, laneId}`

## Safety

- Heartbeat every 15s; web UI shows offline state.
- Watchdog on every relay pulse so a stuck barrier auto-closes.
- Offline buffer: commands queue locally and flush on reconnect.

## Guard app — how it works

The "security app" used by guards is the **Guard role** inside the VillaSafe PWA. Guards open `villasafe.com` on a phone (or install it to the home screen) and log in with their guard account. Row-level security pins them to a single tenant/estate.

- **Guard dashboard (`/dashboard/guard`)** — expected arrivals today, currently checked-in guests, overstayed guests (highlighted amber), plus quick tiles for Scan, Emergency, and Gate Control.
- **Check-in / check-out (`CheckIn.tsx`)** — QR or barcode via the phone camera, or manual code entry.
  - First scan of a code → `checked_in` (timestamp + guard id logged; the resident gets a push and email).
  - Second scan of the same code → `checked_out`.
  - Works offline via `offlineCheckInQueue.ts` and syncs when connectivity returns.
- **Facility visitor passes** — guards generate temporary codes for visitors going to gym/pool/clubhouse; the facility owner is notified.
- **Emergencies** — a red SOS button raises a tenant-wide alert with a global blocking popup for admins/residents, plus an email fallback.
- **Gate control** — guards with permission press the big OPEN / CLOSE buttons on the **Control** tab of this desktop Bridge. Commands flow web → `bridge-sync` → desktop drivers → turnstile / boom barrier / tyre killer. RFID tag reads at the lane open the gate automatically with no tap.
- **What guards CANNOT do** — create residents, edit bills, change tenant settings, or see other estates' data. Enforced in `src/lib/permissions.ts` and Supabase RLS.

## Native installers (.exe / .dmg / .AppImage)

Signed Windows/macOS installers are built by GitHub Actions, not from your laptop. Push a tag named `bridge-vX.Y.Z` (matching the `version` in `desktop/package.json`) and the workflow `.github/workflows/bridge-release.yml` builds on Windows, macOS, and Linux runners using `electron-builder` and uploads:

- `VillaSafeGateBridge-Setup-X.Y.Z.exe` — Windows NSIS one-click installer (desktop shortcut)
- `VillaSafeGateBridge-X.Y.Z.dmg` — macOS disk image
- `VillaSafeGateBridge-X.Y.Z.AppImage` — Linux portable

The download buttons on the **Gate Bridges** page in VillaSafe link to the latest release once `GH_OWNER_REPO` is filled in inside `src/pages/dashboard/GateBridges.tsx`. The source ZIP remains available as a "build it yourself" fallback.