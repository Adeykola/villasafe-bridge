# Installing HCNetSDK

The Hikvision service is built into the Gate Bridge app, so there is nothing
extra to install or start. The one thing the app can't ship is the SDK itself:
Hikvision's licence forbids redistributing it, so it is downloaded once per
guardhouse PC.

## 1. Download

1. Sign in to the Hikvision Partner Portal (`https://www.hikvision.com/en/support/download/sdk/`).
2. Download **Device Network SDK (HCNetSDK) V6.1.9.x** or later, for the OS
   the guardhouse PC runs.
3. Extract the archive.

## 2. Copy the libraries

Copy the whole `lib` folder from the archive into the Gate Bridge's SDK folder
in the user profile (create the folders if they don't exist):

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
`vendor/hcnetsdk/`.
