# HCNetSDK vendor directory

Drop the official Hikvision HCNetSDK here, per-platform. Layout:

```
vendor/hcnetsdk/
├── win-x64/     HCNetSDK.dll, HCCore.dll, PlayCtrl.dll, HCNetSDKCom/…
├── linux-x64/   libhcnetsdk.so, libhpr.so, libHCCore.so, libcrypto*.so, …
└── mac-x64/     libhcnetsdk.dylib, libHCCore.dylib, …
```

See `../../docs/hardware/SDK_INSTALL.md` for download links and per-OS caveats.

These files are **not** committed — the customer must download them from the
Hikvision partner portal and accept Hikvision's SDK license.