# Installing HCNetSDK

The Hikvision service is built into the Gate Bridge app, so there is nothing
extra to install or start. The one thing the app can't ship is the SDK itself:
Hikvision's licence forbids redistributing it, so it is downloaded once per
guardhouse PC.

Hikvision gives it out free, with no sign-in, on its HiTools page:
**Device Network SDK_Win64**,
<https://www.hikvision.com/en/support/tools/hitools/clc33f9cd4117c753a/>
(V6.1.11.40, 298 MB, in October 2026). Its download server only hands the zip
to someone who clicks Download on that page and accepts Hikvision's terms, so
it can't be fetched by a script.

## 1. Install it from the bridge (1.2.12 and later)

Open **Health** in the Gate Bridge. While the SDK isn't loaded, a card at the
top has three buttons:

- **Get Hikvision SDK** opens Hikvision's page in a window of the bridge's own.
  Click **Download** next to "Device Network SDK_Win64" and accept Hikvision's
  terms. The bridge downloads the zip to `~/.villasafe-gate-bridge/downloads/`,
  shows the progress, installs it and loads it. No restart.
- **Install from Downloads** appears when a Hikvision SDK zip is already in the
  PC's Downloads folder (downloaded in a browser, say).
- **Install from a zip file…** takes the zip from anywhere, such as a USB stick
  for a PC with no internet.

The bridge unpacks only the zip's library folder (the one holding
`HCNetSDK.dll`, with `HCNetSDKCom\` and the rest beside it; the demos and
manuals are left out) into
`%USERPROFILE%\.villasafe-gate-bridge\hcnetsdk\win-x64\`. It refuses a zip
without `HCNetSDK.dll` and `HCCore.dll`, and the 32-bit SDK, and leaves any SDK
folder that was already there untouched if something goes wrong.
(`electron/bridge/sdkInstaller.cjs`)

## 2. Or copy the libraries by hand

Download the zip from the page above and extract it. Copy the contents of its
library folder (the one with `HCNetSDK.dll` in it) into the Gate Bridge's SDK
folder in the user profile (create the folders if they don't exist):

| Platform | Folder | Required files |
| --- | --- | --- |
| Windows x64 | `%USERPROFILE%\.villasafe-gate-bridge\hcnetsdk\win-x64\` | `HCNetSDK.dll`, `HCCore.dll`, `PlayCtrl.dll`, `hpr.dll`, the entire `HCNetSDKCom\` folder, `libeay32.dll`, `ssleay32.dll` (and anything else shipped in the archive) |
| Linux x64   | `~/.villasafe-gate-bridge/hcnetsdk/linux-x64/` | `libhcnetsdk.so`, `libHCCore.so`, `libhpr.so`, `libssl.so*`, `libcrypto.so*`, entire `HCNetSDKCom/` folder |
| macOS Intel | `~/.villasafe-gate-bridge/hcnetsdk/mac-x64/`   | `libhcnetsdk.dylib`, `libHCCore.dylib`, `libhpr.dylib`, `HCNetSDKCom/` |
| macOS Apple | `~/.villasafe-gate-bridge/hcnetsdk/mac-arm64/` | Same as mac-x64 (only when Hikvision ships an arm64 build) |

Keep the sibling libraries next to the main one. The app adds the folder to
`PATH` / `LD_LIBRARY_PATH` / `DYLD_LIBRARY_PATH` before loading, so the OS
loader finds them.

The app also looks, in order, in:

1. `HCNETSDK_DIR` (environment variable), if set.
2. `%USERPROFILE%\.villasafe-gate-bridge\hcnetsdk\<platform>\` — the usual place.
3. `resources\hcnetsdk\<platform>\` inside the installed app, for builds made
   with the SDK in `desktop/vendor/hcnetsdk/<platform>/` (licensed installs only).
4. `desktop/vendor/hcnetsdk/<platform>/` when running from source.
5. `C:\VillaSafe\hardware-bridge\vendor\hcnetsdk\<platform>\` — where the old,
   separate hardware bridge kept it, so PCs that already had it keep working
   after upgrading.

## 3. Verify

Open the Gate Bridge, go to **Health** and press **Run health check**. The
connection section should show **Hikvision SDK loaded**. If it doesn't, the
hint names the folder the app expects; copy the files there and press
**Retry SDK** (no restart needed).

The bridge was written against V6.1.9. After installing a newer SDK, open each
Hikvision lane once from the Gates page and check a tag swipe reaches the
Activity page.

For debugging without the desktop app, the service still runs on its own:

```
cd desktop
npm install
npm run hardware:standalone     # http://127.0.0.1:8788
curl http://127.0.0.1:8788/api/health
```

## 4. Licence reminder

HCNetSDK is subject to Hikvision's SDK licence. Do not commit the binaries
to git or redistribute them. `desktop/.gitignore` already excludes
`vendor/hcnetsdk/`. The bridge's own SDK button never downloads from anywhere
but Hikvision's page, and only when someone clicks Download there.
