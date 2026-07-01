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

## Hikvision DS-K2804 (4-door controller)

![DS-K2804 wiring for one vehicle lane (boom barrier + tyre killer + loop detector) and one pedestrian lane (full-height turnstile), connected via LAN to the guardhouse PC](../src/assets/hikvision-ds-k2804-wiring.png)

One DS-K2804 unit can drive **up to 4 lanes** at once — any mix of turnstile, boom barrier, or tyre killer. Each of the 4 relay outputs (Door 1–4) becomes one VillaSafe lane.

**Wiring (per lane):** Wire the gate device's "open" trigger input to `NO` + `COM` of one door relay (Door 1, 2, 3, or 4). Power the K2804 with 12V DC and connect its LAN port to the same network as the bridge PC.

**Controller setup:**
1. Log into the K2804 web UI, set a static IP on your LAN (e.g. `192.168.1.70`).
2. Enable **ISAPI** under Network → Advanced.
3. Set the **Door open duration** per door — short for turnstile/barrier, longer for tyre killer.
4. Set/note the admin password.

**In VillaSafe:** create **one lane per physical gate** in the Lane Wizard, pick driver **"Hikvision network controller"**, and enter the same Host/IP + password on every lane — changing only **Door no.** (1–4). The password stays on this bridge PC and is never sent to the cloud.

### Example: two lanes off one DS-K2804

The diagram above shows the recommended install for a typical estate gate:

- **Lane 1 — Vehicle lane (Door 1 relay, `NO1`/`COM1`)**
  - **Boom barrier** "Open" input → `NO1` + `COM1`.
  - **Tyre killer / road blocker** "Retract" input → wired in parallel to `NO1` + `COM1` so both fire together. Must default to **spikes UP** on power loss (fail-safe).
  - **Loop detector** output → **the boom barrier's own loop input** (recommended, faster and safer auto-close). Alternatively feed it into K2804 `IN1` if you want central logic.
- **Lane 2 — Pedestrian lane (Door 2 relay, `NO2`/`COM2`)**
  - **Full-height turnstile** control box "Open" dry contact → `NO2` + `COM2`.

All relay outputs are dry contacts — polarity doesn't matter. Use 1.0 mm² or thicker cable for runs over 10 m. Use a 12V DC, minimum 2A power supply for the K2804.

### Connecting the DS-K2804 to the guardhouse PC

1. Power the K2804 with 12V DC. Wait for the **POWER**, **RUN**, and **COMM** LEDs on the front to settle.
2. Plug the K2804's LAN port into the same switch/router as the guardhouse PC (or connect directly with an Ethernet cable). The controller's factory-default IP is `192.0.0.64`.
3. On the PC, temporarily set the NIC to a static IP on the same subnet, e.g. IP `192.0.0.10`, mask `255.255.255.0`. This is only for first-time reach.
4. Download Hikvision's free **SADP Tool** (from hikvision.com) → run it → your K2804 appears in the list. Use SADP to **activate** the device by setting the admin password.
5. Open `http://192.0.0.64` in a browser, log in as `admin` with the password from step 4.
6. Under **Network → Basic**, change to a **static IP on your guardhouse LAN** (e.g. `192.168.1.70`, matching your router's subnet). Save and reboot the controller.
7. Under **Network → Advanced → Integration Protocol**, enable **ISAPI** (this is how VillaSafe talks to it).
8. Under **Door → Door Parameters**, set the **Door open duration** per door: short for turnstile/barrier (2–3 s), longer for tyre killer retraction (5–8 s).
9. Reset the PC's NIC back to your normal LAN / DHCP settings so it can reach both the K2804 and the internet.
10. In VillaSafe web app → **Gate Bridges → Lanes → New Lane**, run the wizard **twice**:
    - **Lane 1 (Vehicle)**: driver **"Hikvision network controller"**, Host `192.168.1.70`, Port `80`, Username `admin`, Password (from step 4), **Door no. `1`**, Open seconds `3`.
    - **Lane 2 (Pedestrian)**: identical settings, **Door no. `2`**, Open seconds `2`.
11. Open the desktop bridge → **Control** tab. Hit **Open** on each lane. A green dot on the lane means ISAPI was reachable and the relay fired — you should hear the K2804 click and the connected device should trigger.
12. If nothing happens: open **Settings → Diagnostics → Run diagnostics**. The Hikvision probe will report the exact HTTP error (401 = wrong password, timeout = wrong IP or blocked by Windows Firewall, HTTP 403 = ISAPI not enabled).

> The K2804's admin password stays **only on this guardhouse PC** — it's saved in the bridge's local lane config and never uploaded to the VillaSafe cloud.

---

## Long-range RFID: S4A UHF-202420 + RFCOBEI SW1900

VillaSafe's bridge can drive long-range UHF RFID for hands-free vehicle entry. The recommended pairing is the **S4A UHF-202420** reader on the gate and the **RFCOBEI SW1900** desktop writer for programming tags.

### 1. Mount and wire the reader (S4A UHF-202420)

1. Mount the reader 1.5–4 m from the vehicle lane, aimed roughly at the windscreen where the tag will sit.
2. Power it with **12V DC, minimum 2A** (its included PSU).
3. Pick one interface to the guardhouse PC:
   - **RS-232 → USB-Serial adapter** (simplest): reader TX → adapter RX, GND → GND. Note the COM port Windows assigns (e.g. `COM6`).
   - **TCP / LAN** (needs the RJ45 add-on module or a serial→Ethernet converter): put the reader on the same subnet as the PC.

### 2. Enable auto-read in the S4A configurator

On a Windows PC, run the **S4A UHF Reader Demo** tool that ships with the reader:

1. Connect over the same interface you'll use in production, confirm you see tag reads in the demo.
2. Under **Working Mode**, set **Auto-read (Active mode)**. The reader must push tags on its own — the bridge does NOT poll.
3. Under **Output Format**, pick one:
   - **ASCII / Keyboard** — reader emits `EPC_HEX\r\n` per read. Easiest. Use the **"S4A — Serial (ASCII)"** preset in the wizard.
   - **Native binary** — default `BB…7E` frames. Use the **"S4A — Serial (native binary)"** preset.
4. Save settings to the reader.

### 3. Add the reader to a lane

1. VillaSafe web app → **Gate Bridges → Lanes → New Lane** (or edit an existing lane).
2. On the reader step, choose driver **"Long-range RFID reader"**.
3. Pick the matching **Reader preset**:
   - **S4A UHF-202420 — Serial (ASCII, 115200)** → set **Serial port** to the COM port from step 1 (`COM6`, `/dev/ttyUSB0`, etc.).
   - **S4A UHF-202420 — Serial (native binary)** → same COM port, `frameFormat = s4a-binary`.
   - **S4A UHF-202420 — TCP push** → point the reader at the PC's LAN IP and port `6000`; the bridge listens on that port.
4. **Allow-list behavior**: keep **Whitelist only** for production so unknown tags are logged but never open the gate.
5. Save. The bridge picks the change up on its next 5-second sync and starts listening.

### 4. Program tags with the RFCOBEI SW1900

The SW1900 is a desktop USB writer. It does **not** plug into the bridge — it's used once, on an admin PC, to burn a unique EPC onto each new tag.

1. Plug SW1900 into a Windows PC and install its bundled writer utility.
2. Place a blank UHF tag on the writer pad.
3. Write the EPC you want (e.g. `E20000123456789ABCDEF001`). Keep a spreadsheet of `EPC → vehicle / resident` as you go.
4. Give the physical tag to the resident to stick behind their windscreen.
5. In VillaSafe web app → **Dashboard → RFID Tags → Add tag**:
   - Paste the EPC into **Tag UID**.
   - Assign it to a **Vehicle** or **Resident**.
   - Optionally lock it to a specific **Lane**.
6. Within 5 s the bridge caches the new tag list. Drive up — the gate opens automatically.

### 5. Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Reader shows as **online** but no reads appear | Wrong `frameFormat` — switch preset (ASCII ↔ binary). Also confirm Auto-read is enabled in the S4A tool. |
| Reads appear in the bridge log but the gate never opens | Tag isn't registered in **RFID Tags**, or allow-list is set to **Log only**. |
| "Serial port not set" error on Diagnostics | Wizard didn't get a COM port — re-open the lane and set it explicitly. |
| Tag reads but the wrong lane opens | The tag is registered without a **Lane** restriction and another lane picked it up. Lock the tag to a specific lane in the admin page. |

> All RFID reads are signed into the local audit log (`signedLog`) *and* pushed to the cloud, so you can prove after the fact which EPC opened which gate at which second.