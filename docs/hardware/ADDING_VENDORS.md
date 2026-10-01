# Adding a new hardware vendor

The bridge is deliberately vendor-agnostic. A vendor driver is any module
that exports the following async interface:

```js
// src/drivers/<vendor>/index.js
module.exports = {
  async connect(controllerConfig) {},
  async disconnect(controllerConfig) {},
  async openDoor(session, doorNo) {},
  async closeDoor(session, doorNo) {},
  async status(session) { return { online: true, lastError: null }; },
  async deviceInfo(session) { return { serial: '', firmware: '' }; },
  onEvent(fn) { /* card swipe, tamper, loop, etc. */ return () => {}; },
};
```

## Steps

1. **Create the folder** `src/drivers/<vendor>/` with `index.js`, plus
   whatever helpers you need (SDK loader, protocol client, error map).
2. **Register the driver** in `src/sessions/sessionRegistry.js` — swap
   `ControllerSession` for a factory that picks the driver by
   `controller.vendor` (currently hardcoded to Hikvision; extend the switch).
3. **Expose vendor-specific config** on the `controllers` repo — add fields
   like `apiKey` or `port` to `controllers.store.js` and to the Zod schema
   in `routes/controllers.routes.js`.
4. **Compose lane drivers** by delegating from `drivers/barrier/`,
   `drivers/turnstile/`, `drivers/tyreSpike/` — they should never call the
   Hikvision SDK directly, only the abstracted `openDoor` / `closeDoor` of
   the active session.
5. **Error mapping** — add a `errors.js` translating vendor error codes to
   human strings and wrap thrown errors in `BridgeError` from
   `utils/errorMap.js`.

## Testing checklist

- Ping / port reachable
- Connect returns a session; disconnect releases it
- `openDoor` / `closeDoor` toggle the relay
- Session heartbeat detects cable unplug and reconnects
- Diagnostics report includes the vendor as a step