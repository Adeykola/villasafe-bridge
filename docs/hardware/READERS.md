# Supported RFID readers

## Tags, suspension, renewal and debt — how it fits together

Estates manage tags in VillaSafe → **RFID Tags**: add a tag (or enrol it from
its last read), link it to a resident's vehicle, set **Access until**, **Renew**
(1/3/6/12 months or no end date), **Suspend** with a reason, and **Resume**.
A tag whose resident has an overdue bill pauses by itself and works again once
the bill is paid (unless the estate ticks "Allow while owing").

The gate PC keeps the whole list on disk (`~/.villasafe-gate-bridge/rfid-tags.json`),
the same way it keeps guest passes, and decides every read itself:

| Tag | At the gate |
| --- | --- |
| Active, paid up, not expired | Opens |
| Suspended by the estate | Refused — "suspended by the estate" |
| Resident owing (no override) | Refused — "resident has an overdue bill" |
| Past its **Access until** date | Refused — "access has expired" (checked on the PC's clock, so on time even offline) |
| Locked to another lane | Refused — "tag not allowed on this lane" |
| Not in VillaSafe | Refused — "unknown tag" |

Changes reach the gate within a few seconds while it's online. With no
internet the PC keeps deciding from its saved list, including after a restart.
The one thing it can't learn offline is a *new* debt or a *new* suspension —
those apply at the first sync once the internet is back.

## Two ways to connect the S4A

1. **Straight to the gate PC** (simplest): the S4A's RS-485/USB or TCP output
   into the PC. In the Lane Wizard add a device with driver **RFID reader**
   (mode `serial` with the COM port and baud rate, or `tcp` with the port the
   reader pushes to; frame format `ascii-line`, or `s4a-binary` for the
   reader's native BB…7E frames) plus the lane's barrier. The PC opens the
   barrier itself when a tag is allowed.
2. **Wiegand into the Hikvision DS-K2804** (below): the controller opens the
   door itself from the card list VillaSafe writes into it, so the gate works
   even if the PC is switched off. VillaSafe removes suspended, owing and
   expired cards from the controller within seconds (and remembers what it
   wrote, so this survives PC restarts).

## S4A UHF-202420 (long-range, 4–8 m)

**Recommended wiring — Wiegand-26 into DS-K2804 reader port.**
The reader outputs the tag EPC over Wiegand, the DS-K2804 handles the card
lookup and fires the door relay natively. The Gate Bridge's built-in Hikvision service subscribes to
SDK card events (`NET_DVR_SetDVRMessageCallBack_V51`) and forwards each read
to the Lovable Cloud `bridge-sync` edge function for audit + resident lookup.

### Pinout

| S4A UHF-202420 wire | DS-K2804 reader port | Notes |
| --- | --- | --- |
| Red   (12V+) | +12V     | Use a regulated 12 V, ≥ 2 A supply. Do not share the DS-K2804's 12 V output — the reader draws 0.8 A peak. |
| Black (GND)  | GND      | Common ground with the controller. |
| Green (D0)   | WG_D0    | Wiegand data 0 line. |
| White (D1)   | WG_D1    | Wiegand data 1 line. |
| Yellow (BEEP) | BEEP    | Optional — makes the reader beep on a successful open. |
| Blue  (LED)   | LED     | Optional — LED goes green on grant. |

Twist D0/D1 together, keep runs under 30 m, and use CAT5e or shielded cable.
For longer runs (30–100 m) drop to Wiegand-26 speed (default) and add a
120 Ω terminator.

### Reader configuration

On the reader's config utility set:

- **Output**: Wiegand-26 (default). Wiegand-34 also works — set `wiegandFormat: 34` in the lane row.
- **Antenna power**: start at 15 dBm; raise until reads stabilise at your intended lane distance. Reading beyond 8 m usually means the antenna is aimed at another lane.
- **Anti-collision**: on. Prevents duplicate reads when a car pauses at the boom.
- **Buzzer**: on for guard-visible feedback.

### DS-K2804 side

In iVMS-4200 or the web setup:

1. **Access Control → Reader → Reader 1** (or the port you wired to) →
   Card Reader Type: `Wiegand`, Encoding: `Wiegand-26`.
2. Don't import cards by hand: the Gate Bridge writes every approved tag into
   the controller (and deletes ones that are suspended, owing or expired), so
   cards keep working when the internet is down. Cards you enrol yourself in
   iVMS are left alone.
3. **Access Control → Door → Door 1** → Bind to the reader you configured
   and set an unlock duration ≥ the vehicle's expected transit time.

### Verifying end-to-end

1. Enrol a test tag in the Lovable Cloud RFID Tags page, link it to a
   vehicle.
2. Present the tag ~4 m from the antenna — the reader beeps, the DS-K2804
   relay clicks, the boom lifts.
3. Check the Activity tab: a `rfid_read` event with the tag UID, resident
   name, and lane appears within a few seconds.
4. If step 3 fails but step 2 works, the SDK card callback isn't reaching
   the bridge — check the Gate Bridge Health page log for `card event` messages and
   confirm the bridge PC and the controller can reach each other on TCP
   port 8000.

### Long-range readers not tested but should work

- Impinj Speedway R120 — TCP/IP; needs a bespoke driver, not Wiegand.
- Nedap uPASS Reach — Wiegand-26 compatible, same wiring plan.
- Zebra FX7500 — RS-485 / TCP; needs a bespoke driver.

Only the S4A UHF-202420 wiring is validated on production estates today.

## Where the decision is made

- **Direct reader (serial/TCP):** the driver only reads and debounces; the
  runner looks the tag up in the saved list (`electron/bridge/tagStore.cjs`)
  and opens the lane or logs `rfid_paused` / `rfid_blocked` / `rfid_denied`
  with the reason. Readers restart only when their own settings change, never
  because the tag list changed.
- **Wiegand via DS-K2804:** the controller decides from the cards VillaSafe
  wrote to it; the PC re-checks every 5 seconds (so expiry is applied offline)
  and updates the controller when the set of allowed tags changes.

### Auto-pause on debt

`bridge-sync` flags a tag as `paused: true, pause_reason: 'owing'` when the
linked resident (direct `resident_id` or the owner of the linked `vehicle_id`)
has a pending bill past its due date that their wallet credit doesn't cover.
The pause clears on the next sync after the bill is settled.
