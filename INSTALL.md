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

### Full end-to-end install: DS-K2804 + Router + Guardhouse PC

This walks you from an unopened box to a working gate. Do the steps in order — skipping any one of them is the most common reason installs fail.

#### A. Kit checklist (gather these first)

- 1× Hikvision DS-K2804 controller (in the box)
- 1× 12V DC power supply, minimum 2A (included with the controller)
- 1× Wi-Fi router with at least **2 free LAN ports** (or a small 5-port unmanaged switch)
- 3× Ethernet (Cat6) cables:
  - Cable #1 (short, ~1 m): PC ↔ K2804 for first-time setup
  - Cable #2: PC ↔ router (permanent)
  - Cable #3: K2804 ↔ router (permanent)
- 1× guardhouse PC (Windows 10 or 11, 4 GB RAM minimum), monitor, keyboard, mouse
- 1× UPS (uninterruptible power supply) — protects K2804, router, and PC from power flicker
- Screwdriver set, wire strippers
- 1.0 mm² (or thicker) 2-core cable to run from K2804 relay to the boom-barrier control box
- A multimeter (for verifying wiring — optional but strongly recommended)
- A phone with internet to download the Hikvision SADP tool

#### B. Mount and power the K2804

1. Mount the K2804 **indoors**, in the guardhouse, on a wall or inside a lockable enclosure. Keep it within a few metres of the boom-barrier control box so the relay wire run is short.
2. Connect the included 12V DC power supply:
   - Red / `+` → `+12V` terminal on the K2804
   - Black / `-` → `GND` terminal on the K2804
3. Plug the PSU into a wall outlet **through the UPS**.
4. Watch the front LEDs:
   - **POWER** — solid on immediately
   - **RUN** — starts blinking within ~30 seconds (heartbeat, once per second)
   - **COMM** — will start blinking once you plug in Ethernet later
5. If **POWER** never lights up, swap the PSU and check polarity — do not proceed.
6. Ground the K2804's `GND` terminal to your guardhouse earth if one is available.

#### C. Wire the K2804 relay to the boom-barrier control box

1. Open the boom-barrier controller. Find the **dry-contact input** the manufacturer labels as **"Open"**, **"Trigger"**, or **"Manual open"**. It will be two screw terminals expecting a **momentary short** (not voltage).
2. Run 1.0 mm² 2-core cable from the barrier controller back to the K2804.
3. Terminate at the K2804 side:
   - One conductor → `NO1` (Normally Open, Door 1 relay)
   - Other conductor → `COM1` (Common, Door 1 relay)
4. Terminate at the boom-barrier side into its "Open" input (polarity does not matter — it's a dry contact).
5. **Verify with a multimeter** (optional but recommended):
   - Set multimeter to continuity mode across `NO1` and `COM1`.
   - Multimeter should read **open circuit** normally.
   - After you complete section J and hit **Open**, the K2804 will click and continuity should briefly close.
6. Cable runs over 10 m: use 1.5 mm² or thicker cable to avoid voltage drop.

#### D. First-time direct connection: PC ↔ K2804

The K2804 ships with the factory IP `192.0.0.64`. Your router almost certainly uses a different subnet (e.g. `192.168.1.x`), so you must reach the K2804 directly the first time.

1. Unplug the PC from Wi-Fi and from any other Ethernet cable.
2. Use Cable #1 (short Ethernet) to connect the K2804's LAN port directly to the PC's Ethernet port. The K2804's **COMM** LED should start blinking.
3. Set the PC's Ethernet adapter to a static IP on the K2804's subnet:
   - **Windows 11:** Settings → Network & internet → Ethernet → **Edit** next to "IP assignment" → choose **Manual** → toggle **IPv4 on** → enter IP `192.0.0.10`, subnet mask `255.255.255.0`, gateway blank → Save.
   - **Windows 10:** Control Panel → Network and Sharing Center → **Change adapter settings** → right-click **Ethernet** → **Properties** → double-click **Internet Protocol Version 4 (TCP/IPv4)** → tick **Use the following IP address** → IP `192.0.0.10`, mask `255.255.255.0` → OK.
4. Open Command Prompt and run `ping 192.0.0.64`. You should see replies. If you see "Request timed out", check the cable and that both LEDs on the Ethernet port are lit.

#### E. Activate the K2804 with SADP

A brand-new K2804 has **no password** — you must activate it first.

1. On the same PC, open a browser to <https://www.hikvision.com/en/support/tools/hitools/> and download **SADP Tool** (Windows).
2. Install SADP, then run it **as administrator** (right-click → "Run as administrator").
3. Within ~20 seconds the K2804 appears in the device list with status **Inactive**.
4. Select the K2804 (tick its checkbox). In the right-hand panel, enter a new admin password:
   - Minimum 8 characters
   - Must mix at least two of: uppercase, lowercase, digits, symbols
   - Example: `Guardhouse2026!`
5. Confirm the password and click **Activate**.
6. **Write the password down and store it somewhere safe.** Hikvision cannot recover it — if lost, the K2804 must be factory-reset with a physical reset button.

#### F. Configure the K2804 web UI

1. Still on the direct PC↔K2804 connection, open Chrome or Edge and go to `http://192.0.0.64`.
2. If the browser prompts for a plugin, install the Hikvision web plugin (only needed for live-view features — not required for VillaSafe, but harmless).
3. Log in as `admin` with the password from step E.
4. **Network → Basic → TCP/IP:**
   - Uncheck **DHCP**
   - **IPv4 Address:** `192.168.1.70` (pick any address in your router's subnet that is outside its DHCP range)
   - **IPv4 Subnet Mask:** `255.255.255.0`
   - **IPv4 Default Gateway:** your router's IP (usually `192.168.1.1`)
   - **Preferred DNS Server:** `8.8.8.8`
   - Click **Save**.
5. **Network → Advanced → Integration Protocol** (also called **Platform Access** on some firmware): tick **Enable ISAPI**. Save.
6. **Door → Door Parameters:**
   - **Door 1** — Door open duration: `3` seconds (for a boom barrier)
   - **Door 2** — Door open duration: `2` seconds (for a turnstile)
   - **Door 3 / 4** — set later if used (5–8 seconds for tyre-killer retraction)
   - Save each door.
7. **Maintenance → Reboot** — reboot the controller so the new static IP takes effect. Once it reboots it is no longer at `192.0.0.64`.

#### G. Set up the router

1. Power the router through the UPS. Wait ~2 minutes for it to boot.
2. Cable your ISP / modem into the router's **WAN** port (usually a different colour). Confirm the internet LED lights up.
3. Log into the router admin page — typically `http://192.168.1.1` or `http://192.168.0.1`. Username/password is on the sticker on the underside of the router.
4. **Confirm the router's LAN subnet matches the K2804's static IP.** If your router uses `192.168.0.x`, either:
   - Change the router's LAN IP to `192.168.1.1` and reboot, **or**
   - Go back to step F.4 and give the K2804 an IP like `192.168.0.70` instead.
   - Both sides must be on the same subnet.
5. Reserve the K2804's IP so DHCP never hands it to another device:
   - **TP-Link:** Advanced → Network → DHCP Server → **Address Reservation** → Add → enter K2804 MAC (printed on the K2804 label) and IP `192.168.1.70`.
   - **MikroTik:** IP → DHCP Server → Leases → find the K2804 → **Make Static**.
   - **Generic:** look for "DHCP reservation", "Static lease", or "Address reservation".
6. Set a strong Wi-Fi SSID and password if you plan to also use Wi-Fi.

#### H. Connect PC + K2804 to the router (permanent wiring)

1. Undo the temporary static IP on the PC:
   - **Windows 11:** Settings → Network & internet → Ethernet → **Edit** → **Automatic (DHCP)** → Save.
   - **Windows 10:** TCP/IPv4 Properties → **Obtain an IP address automatically** → OK.
2. Unplug Cable #1 (the direct PC↔K2804 cable).
3. Cable #2: PC → **any LAN port** on the router.
4. Cable #3: K2804 → **any other LAN port** on the router. The K2804's **COMM** LED should blink again within 15 seconds.
5. On the PC, open Command Prompt and verify:
   - `ping 192.168.1.70` — should get replies from the K2804.
   - `ping 8.8.8.8` — should get replies (means the router has internet).
   - `http://192.168.1.70` in the browser should open the K2804 login page.
6. If `ping 192.168.1.70` fails: unplug/replug the K2804 Ethernet cable, wait 30 s, retry. If still failing, the K2804 didn't accept the static IP — plug Cable #1 back in and redo step F.4.

#### I. Install and pair the VillaSafe Bridge on the PC

1. On the guardhouse PC, download `VillaSafe-GateBridge-win-x64.zip` (see section 1 at the top of this document).
2. Extract the zip anywhere (e.g. `C:\VillaSafe\`).
3. Double-click `GateBridge.exe`. If Windows SmartScreen warns, click **More info → Run anyway**.
4. In the VillaSafe web app on another device: **Gate Bridges → Add Bridge** → copy the 6-digit code.
5. In the Bridge app: **Settings** tab → paste the code → **Pair this PC**.
6. The header status pill turns **green ("Online")** — this confirms the Bridge can reach VillaSafe's cloud.

#### J. Create the lane in VillaSafe

1. VillaSafe web app → **Gate Bridges → Lanes → New Lane**.
2. Walk through the wizard:
   - **Lane name:** `Vehicle Gate 1`
   - **Bridge:** select the PC you just paired
   - **Direction:** In / Out / Both, as appropriate
   - **Boom barrier driver:** **Hikvision network controller**
     - Host: `192.168.1.70`
     - Port: `80`
     - Username: `admin`
     - Password: from step E
     - Door no.: `1`
     - Open seconds: `3`
   - Turnstile / tyre killer: leave blank unless wired
   - Auto-close time: `10` seconds (typical)
   - Auto-open on check-in: on/off as your policy requires
3. Save. The Bridge picks up the new lane within 5 seconds.

#### K. End-to-end verification

1. In the desktop Bridge → **Control** tab → click the big green **OPEN** button on the lane.
2. You should hear a distinct **click** from the K2804 (Door 1 relay firing) and the boom barrier should lift.
3. After ~10 seconds the barrier should auto-close (or you can hit **CLOSE** manually if you wired a close pulse).
4. If nothing happens, open **Settings → Diagnostics → Run diagnostics** and use this table:

   | Diagnostic message | Meaning | Fix |
   |---|---|---|
   | `HTTP 401` on Hikvision probe | Wrong password | Redo the lane, re-enter the password from step E. |
   | `HTTP 403` on Hikvision probe | ISAPI is not enabled | Redo step F.5. |
   | `Timeout` / `EHOSTUNREACH` | Bridge PC can't reach the K2804 | Ping test in step H.5. Check cables and static IP. |
   | `Cloud unreachable` | PC has no internet | Check router WAN light and PC network. |
   | K2804 clicks but barrier doesn't move | Relay fires but barrier wiring wrong | Re-check section C wiring; try continuity test with multimeter. |

#### L. Pre-handover sanity checklist

- [ ] All Ethernet cables and relay wires are strain-relieved (no tension on connectors).
- [ ] K2804, router, and PC are all plugged into the **UPS**.
- [ ] K2804 admin password is written down and stored in a sealed envelope in the estate office.
- [ ] Router admin password is changed from the sticker default and recorded.
- [ ] Bridge desktop app status pill is **green**.
- [ ] At least one full **Open → auto-close** cycle observed on the physical barrier.
- [ ] A test guest check-in in VillaSafe (if auto-open enabled) actually lifts the barrier.
- [ ] Guards trained: they know to open lanes from **Gate Bridges → Manual Control → Open** in the web app.

> The K2804's admin password stays **only on this guardhouse PC** — it's saved in the Bridge's local lane config and never uploaded to the VillaSafe cloud.

### Running two (or more) DS-K2804 controllers from one bridge PC

You do **not** need a second PC to run a second gate. One guardhouse PC running the Gate Bridge can drive multiple DS-K2804 controllers over the same router — wired or Wi-Fi — as long as every controller is reachable on the LAN.

**Why it works.** The bridge talks to each controller over HTTP/ISAPI. Every lane in VillaSafe stores its own `Host` + `Door no.`, so one PC can address unlimited controllers.

**1. IP plan.** Give each controller a unique static IP on the router's subnet:

- Controller A (Gate 1, near guardhouse): `192.168.1.70`
- Controller B (Gate 2, far side): `192.168.1.71`
- Bridge PC: DHCP or static, same subnet.

Reserve both IPs in the router's DHCP settings so they never change.

**2. Bridge the physical distance (>30 m).** The DS-K2804 has **no built-in Wi-Fi** — it needs an Ethernet link. Cat6 is only rated to ~90 m and indoor Wi-Fi through walls is often unreliable past 30 m, so the far controller is always wired into some kind of network extender:

| Option | When to use | Notes |
|---|---|---|
| **Ethernet + PoE switch** | You can run a cable | Cat6 up to 90 m; add a mid-span switch to go further. |
| **Outdoor Wi-Fi bridge** (Ubiquiti NanoStation, TP-Link CPE) | Line-of-sight between buildings | Best for >50 m outdoor. Point-to-point; wire into each controller's LAN port. |
| **Wi-Fi mesh node / repeater** | Router signal too weak at far gate | Place the mesh node near the far controller; plug the controller into its LAN port. |
| **Powerline adapter (HomePlug AV2)** | Same electrical circuit reaches both gates | One adapter near the router, another at the far gate, controller into its LAN port. |
| **Second access point in bridge/client mode** | You have a spare router | Wire the far controller into the AP's LAN port. |

**3. Topology:**

```text
                                    Gate 1 (near guardhouse)
                                    ┌────────────────────┐
                                    │  DS-K2804 #A       │
                                    │  192.168.1.70      │
                                    └─────────┬──────────┘
                                              │ Cat6 (<30 m)
┌───────────────┐      ┌──────────┐           │
│ Guardhouse PC │──────│  Router  │───────────┤
│  (Bridge app) │ LAN  │  + Wi-Fi │           │
└───────────────┘      └────┬─────┘           │  Wi-Fi bridge / powerline / mesh
                            │                 │      (long-distance link)
                            │       ┌─────────┴────────┐
                            │       │  Client bridge   │
                            │       │  or mesh node    │
                            │       └─────────┬────────┘
                            │                 │ Cat6 (<30 m)
                                    ┌─────────┴──────────┐
                                    │  DS-K2804 #B       │
                                    │  192.168.1.71      │
                                    │  (Gate 2, far)     │
                                    └────────────────────┘
```

**4. VillaSafe configuration.** In the Lane Wizard, create one lane per physical gate. Same driver ("Hikvision network controller"), different Host / Door no.:

- Vehicle lane, Gate 1 → Host `192.168.1.70`, Door `1`
- Pedestrian lane, Gate 1 → Host `192.168.1.70`, Door `2`
- Vehicle lane, Gate 2 → Host `192.168.1.71`, Door `1`
- Pedestrian lane, Gate 2 → Host `192.168.1.71`, Door `2`

**5. Verify.** In the desktop bridge → **Control** tab, hit **Open** on each lane. If a lane fails, open **Settings → Diagnostics**:

- Timeout → network path broken. From the guardhouse PC run `ping 192.168.1.71` — fix Wi-Fi/powerline link first.
- HTTP 401 → wrong password on that lane.
- HTTP 403 → ISAPI not enabled on that controller.

**Limits & tips.** One bridge PC comfortably handles 8–10 controllers (32–40 lanes). The bottleneck is network reliability, not the bridge software. Put every controller on a UPS so a brief power flicker doesn't drop your far gate.

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