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
produces:

- `VillaSafeGateBridge-Setup-1.0.4.exe`
- `VillaSafeGateBridge-1.0.4.dmg`
- `VillaSafeGateBridge-1.0.4.AppImage`

...and attaches them to the GitHub Release for tag `bridge-v1.0.4`.

## Updating the bridge code

The source of truth is the `desktop/` folder inside the private VillaSafe
project. After changes there, run `node scripts/sync-bridge-repo.mjs`
inside that project, copy the refreshed `bridge-repo/` contents into your
local clone of this repo, bump `package.json` version, commit, and tag
`bridge-vX.Y.Z`.