// Central bridge-level error class + normalizer.
class BridgeError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.code = code;
    this.hint = hint || null;
  }
  toJSON() { return { code: this.code, message: this.message, hint: this.hint }; }
}

function normalize(err) {
  if (err instanceof BridgeError) return err;
  const msg = err && err.message ? err.message : String(err);
  if (/ECONNRESET/.test(msg)) {
    return new BridgeError('CONTROLLER_RESET', 'Controller rejected the connection.',
      'Possible causes: wrong password, controller rebooting, SDK version mismatch, or ISAPI disabled.');
  }
  if (/ETIMEDOUT/.test(msg)) {
    return new BridgeError('CONTROLLER_TIMEOUT', 'Controller did not reply.',
      'Check LAN reachability and that SDK port 8000 is open on the controller.');
  }
  if (/ECONNREFUSED/.test(msg)) {
    return new BridgeError('CONTROLLER_REFUSED', 'Nothing is listening on that port.',
      'Confirm the controller IP and that the SDK service is enabled.');
  }
  return new BridgeError('INTERNAL', msg, null);
}

module.exports = { BridgeError, normalize };