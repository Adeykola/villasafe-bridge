// Per-controller SDK session — login, heartbeat, auto-reconnect.
//
// The heartbeat really checks the controller is still there (its SDK port
// answers). When the PC drops off the gate network — a cable pulled, Wi-Fi
// switching to a hotspot — the login and the swipe channel die with it, and
// the SDK doesn't always bring them back. So a failed check logs in again
// (with back-off) until the controller answers, and the card-event service is
// told, so card swipes reach the bridge again within seconds, not after a restart.
const net = require('net');
const sdkLoader = require('./sdkLoader');
const { describeLogin } = require('./errors');
const { BridgeError } = require('../../utils/errorMap');
const log = require('../../logger');

const HEARTBEAT_MS = 15000;
const PROBE_TIMEOUT_MS = 3000;
const BACKOFF_START = 1000;
const BACKOFF_MAX = 30000;

/** Does the controller's SDK port still answer from this PC? */
function probePort(host, port, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

let probeImpl = probePort; // tests swap in a fake network
const reconnectListeners = new Set();
/** Be told when a session has logged in again after losing the controller. */
function onReconnected(fn) { reconnectListeners.add(fn); return () => reconnectListeners.delete(fn); }

class ControllerSession {
  constructor(controller) {
    this.controller = controller; // { id, name, ip, sdkPort, username, password }
    this.userId = -1;
    this.online = false;
    this.lastError = null;
    this.deviceInfo = null;
    this._backoff = BACKOFF_START;
    this._hbTimer = null;
    this._reconnectTimer = null;
    this._probing = false;
    // Goes up with every successful login: the SDK can hand out the same user
    // id again, so this is how the swipe channel knows it must be armed afresh.
    this.generation = 0;
  }

  async connect() {

    // Never the password: this log is kept on disk and shown in support bundles.
    const { password, ...controller } = this.controller || {};
    log.info({ controller }, 'Attempting controller login');

    const { api, structs, koffi } = sdkLoader.load();
    let info;
    let deviceInfo;
    try {
      // koffi >=2.x requires an explicit count: alloc(type, count)
      info = koffi.alloc(structs.NET_DVR_USER_LOGIN_INFO, 1);
      deviceInfo = koffi.alloc(structs.NET_DVR_DEVICEINFO_V40, 1);

      const payload = {
        sDeviceAddress: Buffer.alloc(129),
        byUseTransport: 0,
        wPort: Number(this.controller.sdkPort || 8000),
        sUserName: Buffer.alloc(64),
        sPassword: Buffer.alloc(64),
        cbLoginResult: null,
        pUser: null,
        bUseAsynLogin: 0,
        byProxyType: 0, byUseUTCTime: 0, byLoginMode: 0, byHttps: 0,
        iProxyID: 0, byVerifyMode: 0,
        byRes3: Buffer.alloc(119),
      };
      Buffer.from(String(this.controller.ip)).copy(payload.sDeviceAddress);
      Buffer.from(String(this.controller.username || 'admin')).copy(payload.sUserName);
      Buffer.from(String(this.controller.password || '')).copy(payload.sPassword);
      // koffi.encode(target, type, value)
      koffi.encode(info, structs.NET_DVR_USER_LOGIN_INFO, payload);
    } catch (e) {
      // Surface koffi/SDK-marshalling errors as a proper LOGIN_FAILED so the
      // dashboard sees actionable text instead of a bare INTERNAL.
      this.online = false;
      this.lastError = { code: 'SDK_MARSHAL', message: e.message };
      throw new BridgeError(
        'LOGIN_FAILED',
        `SDK marshalling failed: ${e.message}`,
        `Check that HCNetSDK libraries are installed and the koffi struct definitions match your SDK version (host ${this.controller.ip}:${this.controller.sdkPort || 8000}).`
      );
    }
log.info(
  {
    ip: this.controller.ip,
    port: this.controller.sdkPort || 8000,
    username: this.controller.username || 'admin',
  },
  'Calling NET_DVR_Login_V40'
);
    const uid = api.NET_DVR_Login_V40(info, deviceInfo);
    log.info(
  {
    uid,
  },
  'NET_DVR_Login_V40 returned'
);
    if (uid < 0) {
      const sdkCode = api.NET_DVR_GetLastError();
      const d = describeLogin(sdkCode, `${this.controller.ip}:${this.controller.sdkPort || 8000}`);
      this.online = false;
      this.lastError = { code: sdkCode, message: d.message };
      const err = new BridgeError(d.code, d.message, d.hint);
      // Refused for its credentials: retrying the same password only locks the controller.
      err.credential = d.credential;
      err.sdkCode = Number(sdkCode);
      throw err;
    }
    this.userId = uid;
    this.online = true;
    this.lastError = null;
    this.generation += 1;
    this._backoff = BACKOFF_START;
    this.deviceInfo = koffi.decode(deviceInfo, structs.NET_DVR_DEVICEINFO_V40);
    log.info('Controller session opened', { controllerId: this.controller.id, uid });
    this._startHeartbeat();
  }

  async disconnect() {
    this._stopHeartbeat();
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this.userId >= 0) {
      try { sdkLoader.load().api.NET_DVR_Logout(this.userId); } catch { /* noop */ }
    }
    this.userId = -1;
    this.online = false;
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._hbTimer = setInterval(() => this._heartbeat(), HEARTBEAT_MS);
  }
  _stopHeartbeat() {
    if (this._hbTimer) { clearInterval(this._hbTimer); this._hbTimer = null; }
  }

  async _heartbeat() {
    if (this._probing || this._reconnectTimer) return;
    this._probing = true;
    try {
      const where = `${this.controller.ip}:${this.controller.sdkPort || 8000}`;
      const answers = this.userId >= 0 && await probeImpl(this.controller.ip, Number(this.controller.sdkPort || 8000));
      if (answers) return;
      this.online = false;
      this.lastError = {
        code: 'HEARTBEAT_FAILED',
        message: this.userId < 0 ? 'No active session' : `The controller stopped answering at ${where} — logging in again when it's back`,
      };
      log.warn('Controller connection lost — logging in again when it answers', { controllerId: this.controller.id });
      this._stopHeartbeat();
      this._scheduleReconnect();
    } finally {
      this._probing = false;
    }
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    const delay = Math.min(this._backoff, BACKOFF_MAX);
    this._backoff = Math.min(this._backoff * 2, BACKOFF_MAX);
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      try {
        await this.disconnect();
        await this.connect();
        log.info('Controller back — logged in again', { controllerId: this.controller.id });
        for (const fn of reconnectListeners) { try { fn(this); } catch { /* a listener's problem */ } }
      } catch (e) {
        log.warn('Reconnect failed', { controllerId: this.controller.id, error: e.message });
        // A refused password stays refused; retrying it would lock the controller.
        if (!e.credential) this._scheduleReconnect();
      }
    }, delay);
  }

  status() {
    return {
      id: this.controller.id,
      name: this.controller.name,
      ip: this.controller.ip,
      online: this.online,
      userId: this.userId,
      lastError: this.lastError,
    };
  }
}

module.exports = {
  ControllerSession, onReconnected,
  _internal: { setProbe: (fn) => { probeImpl = fn || probePort; }, HEARTBEAT_MS },
};