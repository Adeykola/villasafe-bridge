// electron-builder afterPack hook: ad-hoc sign the Mac app.
//
// VillaSafe has no Apple Developer ID, so the app isn't signed by electron-builder.
// Left like that, its signature no longer matches its contents and a Mac with an
// Apple chip calls the downloaded app "damaged". Signing it ad hoc (no identity)
// fixes that: macOS then treats it as an app from an unidentified developer, which
// opens after System Settings → Privacy & Security → Open Anyway.
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
};
