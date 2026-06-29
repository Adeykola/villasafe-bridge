# Installing the VillaSafe Gate Bridge

The Gate Bridge is a small program you install on the **guardhouse PC** (the computer at your gate). It connects VillaSafe in the cloud to your physical gate hardware — turnstiles, boom barriers, tyre killers — regardless of brand.

## 1. Download

Pick the build for your operating system:

| OS      | File                                       | How to start it                          |
|---------|--------------------------------------------|------------------------------------------|
| Windows | `VillaSafe-GateBridge-win-x64.zip`         | Extract, then run `GateBridge.exe`       |
| macOS   | `VillaSafe-GateBridge-mac-x64.zip`         | Extract and drag `GateBridge.app` to `/Applications` |
| Linux   | `VillaSafe-GateBridge-linux-x64.tar.gz`    | Extract and run `./GateBridge`           |

On first launch, Windows SmartScreen / macOS Gatekeeper may ask you to confirm — choose **Run anyway** / **Open**. The bridge is unsigned for now.

## 2. Wire your hardware

The bridge supports four electrical / network interfaces. Pick the one your installed hardware exposes. Most third-party gate equipment has at least the relay (dry-contact) input.

### Turnstile (full-height)

```text
  USB relay board                    Turnstile control box
  ┌──────────────┐                   ┌────────────────────┐
  │   Relay 1    │ COM ──────────────│ COM (dry contact)  │
  │  (channel 1) │ NO  ──────────────│ Open input         │
  └──────────────┘                   └────────────────────┘
```

Driver: **relay**. Channel = relay number on the board. Pulse 500 ms is enough for most rotors.

### Boom barrier (up/down)

```text
  USB relay board                    Barrier controller
  ┌──────────────┐                   ┌────────────────────┐
  │   Relay 2    │ COM ──────────────│ COM                │
  │  (channel 2) │ NO  ──────────────│ "Up" / "Open" input│
  └──────────────┘                   └────────────────────┘
```

Most barriers auto-close on a timer. If yours needs an explicit close pulse, wire a second channel and set the **Close pulse** in the lane wizard.

### Tyre killer / road blocker

```text
  USB relay board                    Spike controller
  ┌──────────────┐                   ┌────────────────────┐
  │   Relay 3    │ COM ──────────────│ COM                │
  │  (channel 3) │ NO  ──────────────│ "Retract" input    │
  └──────────────┘                   └────────────────────┘
```

Important: the spike should default to **deployed** so power loss leaves it in the safe (raised) state. The bridge only retracts it when a lane is opened.

### TCP / IP controllers

Plug the controller into the LAN. Note its IP and port. Driver: **tcp**. Enter the ASCII command the vendor documents for "open" and "close" (e.g. `*OPEN#`, `RLY1=ON`).

### Modbus RTU (RS-485)

Use a USB-to-RS485 adapter. Connect A→A, B→B with a 120 Ω terminator at the end of the line. Driver: **modbus**. Set the slave ID and register the controller exposes.

### Wiegand reader emulation

If the panel only accepts Wiegand card swipes, plug in a Wiegand-to-serial adapter. Driver: **wiegand**. Configure the card ID the panel recognises as "authorised".

## 3. Pair the bridge

1. In VillaSafe (web app) → **Gate Bridges** → click **Add Bridge** → copy the 6-digit code.
2. Open the bridge desktop app on the guardhouse PC.
3. Go to the **Settings** tab, enter the 6-digit code, and click **Pair this PC**.
   The bridge ships with **no Supabase URL or anon key** — it only knows the VillaSafe gateway URL until you pair, after which it stores a one-off bridge token.
4. The bridge's status pill in the header turns green ("Online").

The app has two tabs at the top:

- **Control** — large green **OPEN** / red **CLOSE** buttons per lane, designed for guardhouse touchscreens.
- **Settings** — pairing, diagnostics, and the activity log.

> One PC pairs to one estate — the one whose gates it physically controls. To serve another estate, install the Bridge on a PC at that site and pair it with that estate's own 6-digit code.

## 4. Map a lane

Back in VillaSafe → **Gate Bridges → Lanes → New Lane**. The wizard walks you through:

1. Lane name, bridge, direction.
2. Turnstile driver + parameters.
3. Boom barrier driver + parameters.
4. Tyre killer driver + parameters.
5. Auto-close time + auto-open on check-in.
6. Review and save.

Then open the **Manual Test** tab and fire **Open** / **Close** for each device. Each device shows a green/red status dot once the bridge has probed it.

## 5. Operate

- **Guards** open lanes from the web app: Gate Bridges → Manual Control → **Open**.
- **Approved check-ins** auto-open the configured lane if you turned that on.
- **ANPR cameras** can POST license-plate matches to the bridge directly:

  ```http
  POST http://<guardhouse-pc-ip>:8765/anpr
  Content-Type: application/json

  { "plate": "ABC123XY", "laneId": "<uuid>" }
  ```

- **Offline?** The bridge keeps running. Scheduled rules (e.g. "open at 06:00") fire locally; manual UI and ANPR work; events queue up and flush to the cloud once the internet returns.

## 6. Troubleshooting

Open the bridge app → **Diagnostics → Run diagnostics**. It checks:

- Cloud URL/key set
- Internet reachable
- Bridge paired
- Each configured device probed (port detected, TCP reachable, Modbus port open, Wiegand adapter present)

Each failing row carries a hint. Click **Copy report** and share it with VillaSafe support if you're stuck.

Common issues:

- **"Port COM3 not present"** — install the USB-serial driver (CH340 / FTDI / Prolific) and confirm the COM number in Device Manager (Windows) or `ls /dev/tty*` (Linux/macOS).
- **"TCP timeout"** — ping the controller IP. Open the configured port in Windows Firewall / your router.
- **"Modbus port open"** but commands fail — RS-485 A/B wires are swapped, or the slave ID / register is wrong.
- **Linux serial permission denied** — add your user to the `dialout` group: `sudo usermod -aG dialout $USER`, then log out and back in.