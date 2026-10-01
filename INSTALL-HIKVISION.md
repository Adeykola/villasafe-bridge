# Getting Hikvision DS-K2804 working on the guardhouse PC

DS-K2804 firmware ships with HTTP/HTTPS **disabled by default**, so VillaSafe talks to the controller through Hikvision's HCNetSDK on port 8000. From Gate Bridge **1.2.0** that SDK service is built into the Gate Bridge app. There is no separate "VillaSafeHardwareBridge" to install or keep running any more.

## 1. Install the latest Gate Bridge

1. Download and install **1.2.0** or later from the Downloads card in Dashboard → Gate Bridges.
2. Confirm the version shown in the bridge's left rail is `v1.2.0+`.
3. If the PC still runs the old separate hardware bridge (a PowerShell window, an `nssm` / `pm2` service, or `C:\VillaSafe\hardware-bridge\`), stop and remove that service. Leave the `vendor\hcnetsdk` folder where it is: the new app finds the SDK there too.

## 2. Enter the licence key

Pairing asks for the estate's **desktop licence key** (`VS-XXXXX-XXXXX-XXXXX-XXXXX`). VillaSafe issues it once the estate has paid for the desktop app. The same key works on every gate PC in the estate. PCs that were paired before licences existed show a **Gates locked** screen; type the key there. You don't need to pair again.

## 3. Drop in the Hikvision SDK

Hikvision does not permit us to redistribute the SDK, so download it once from the Hikvision partner portal.

1. Download `Device Network SDK (HCNetSDK) V6.1.9.x` for Windows x64.
2. Copy the extracted library files (including `HCNetSDK.dll`, `HCCore.dll`, `PlayCtrl.dll`, `hpr.dll`, `libeay32.dll`, `ssleay32.dll`, and the entire `HCNetSDKCom\` folder) into:
   ```
   %USERPROFILE%\.villasafe-gate-bridge\hcnetsdk\win-x64\
   ```
3. In the Gate Bridge, open **Health**, press **Run health check**, then **Retry SDK** if it isn't loaded yet. It should say **Hikvision SDK loaded**.

## 4. Verify the controller

In the Lane Wizard, set the Hikvision device parameters:

- **Host**: the DS-K2804's LAN IP (e.g. `192.168.1.64`).
- **SDK port**: `8000` (not 80 or 443).
- **Username / password**: the admin account you activated the controller with.
- **Door No**: `1` for the first door, `2` for the second, etc.

Save the lane. Send OPEN from Guard Dashboard. If it still fails, the error names the exact cause (SDK not loaded, login failed, wrong IP, wrong door number).

## 5. Wiring a boom barrier to the DS-K2804

The DS-K2804 opens a barrier by closing a door's lock relay. The barrier board's inputs trigger when shorted to its own ground, so the relay must be a **dry contact** (no voltage from the DS-K2804):

| DS-K2804 (Door N lock relay) | Barrier board (e.g. 伺服道闸控制器) |
| --- | --- |
| `NO` (normally open) | `起` (raise / open) |
| `COM` | `地` (ground / common) |

- If the DS-K2804 has a dry/wet jumper for that lock output, set it to **dry**. Don't run the controller's 12 V lock supply into the barrier inputs.
- Set that door's **open duration** on the DS-K2804 to about 1 s, so it gives a short pulse like the barrier's own remote.
- Closing is done by the barrier, not the DS-K2804: fit a vehicle loop (either loop wire on `线圈`, or an external loop detector's relay on `地感` + `地`). The barrier then lowers once the car has cleared the arm and won't lower onto a car. VillaSafe's CLOSE button can't drive `落` on a Hikvision lane.
- Don't touch the motor (`U V W`), hall sensor (`GND HW HV HU 5V`) or `24V` terminals. Those belong to the barrier itself.

## 6. If you see "fetch failed" on the status card

That is the cloud gateway, not Hikvision. It means the PC couldn't reach `*.functions.supabase.co` at that moment. Check:

- Internet access on the PC.
- DNS: `nslookup mnrbxdpimeqtiwofjjri.functions.supabase.co`.
- Corporate antivirus / proxy: some intercept TLS and break Undici's `fetch`.
- System clock: a skew of more than a few minutes breaks TLS handshakes.

The bridge queues events while offline and replays them once connectivity returns, so no activity is lost.
