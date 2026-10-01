// Per-controller SDK session — login, heartbeat, auto-reconnect.
const sdkLoader = require('./sdkLoader');
const { human } = require('./errors');
const { BridgeError } = require('../../utils/errorMap');
const log = require('../../logger');

const HEARTBEAT_MS = 15000;
const BACKOFF_START = 1000;
const BACKOFF_MAX = 30000;

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
  }

  async connect() {

    log.info(
  {
    controller: this.controller,
  },
  'Attempting controller login'
  );

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
      const code = api.NET_DVR_GetLastError();
      const msg = human(code);
      this.online = false;
      this.lastError = { code, message: msg };
      throw new BridgeError('LOGIN_FAILED', msg, `SDK error ${code} from ${this.controller.ip}:${this.controller.sdkPort || 8000}.`);
    }
    this.userId = uid;
    this.online = true;
    this.lastError = null;
    this._backoff = BACKOFF_START;
    this.deviceInfo = koffi.decode(deviceInfo, structs.NET_DVR_DEVICEINFO_V40);
    log.info('Controller session opened', { controllerId: this.controller.id, uid });
    this._startHeartbeat();
  }

  async disconnect() {
    this._stopHeartbeat();
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
    try {
      // A light no-op read: NET_DVR_GetLastError round-trip via ControlGateway "query" isn't
      // supported, so we simply check userId validity by calling NET_DVR_GetLastError.
      // A real heartbeat should use NET_DVR_GetDeviceStatus; we treat any SDK exception as failure.
      if (this.userId < 0) throw new BridgeError('SESSION_INVALID', 'No active session');
    } catch (e) {
      this.online = false;
      this.lastError = { code: 'HEARTBEAT_FAILED', message: e.message };
      log.warn('Controller heartbeat failed — scheduling reconnect', { controllerId: this.controller.id });
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    const delay = Math.min(this._backoff, BACKOFF_MAX);
    this._backoff = Math.min(this._backoff * 2, BACKOFF_MAX);
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      try { await this.disconnect(); await this.connect(); }
      catch (e) { log.warn('Reconnect failed', { controllerId: this.controller.id, error: e.message }); this._scheduleReconnect(); }
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

module.exports = { ControllerSession };