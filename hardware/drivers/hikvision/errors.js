// HCNetSDK error codes → human messages.
// Full list in Hikvision "Device Network SDK Error Codes.pdf".
const MAP = {
  0: 'Success',
  1: 'User name error.',
  2: 'Password error.',
  3: 'User has no permission for this operation.',
  4: 'SDK not initialized.',
  5: 'Channel does not exist on this device.',
  6: 'No permission for this channel.',
  7: 'Login failed — the controller refused the credentials or the SDK service is unavailable.',
  8: 'Device is offline.',
  9: 'Device is busy — try again in a few seconds.',
  10: 'Command timed out.',
  11: 'Device is not supported.',
  17: 'Parameter error — the door number or command is invalid.',
  23: 'The device is already connected in another session.',
  29: 'Operation failed — SDK returned a generic error.',
  43: 'Function not supported by this device firmware.',
  47: 'Login rejected — user is locked out; wait or reset on the controller.',
  84: 'Session is invalid — reconnect required.',
};

function human(code) {
  const n = Number(code);
  return MAP[n] || `SDK error ${n}`;
}

module.exports = { human };