// Reads cached device info from the open session (populated at login).
function get(session) {
  if (!session.online) return null;
  const di = session.deviceInfo || {};
  return {
    serial: (di.struDeviceV30 || []).slice ? Buffer.from(di.struDeviceV30 || []).slice(0, 48).toString('utf8').replace(/\0.*$/, '') : null,
    firmware: null, // parse from struDeviceV30 if needed
    passwordLevel: di.byPasswordLevel ?? null,
    supportLock: di.bySupportLock ?? null,
  };
}
module.exports = { get };