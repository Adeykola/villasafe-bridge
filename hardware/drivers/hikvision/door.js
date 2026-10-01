// Door relay control for Hikvision access-control panels (DS-K series).
//
// Hikvision has shipped multiple HCNetSDK door-control paths across access
// controller firmware lines. DS-K2804 installations have returned both
// "unsupported" and "parameter error" depending on which command shape was
// used, so open() intentionally tries the known access-control variants in a
// safe order and logs the method that actually worked.
const sdkLoader = require('./sdkLoader');
const { human } = require('./errors');
const { BridgeError } = require('../../utils/errorMap');
const log = require('../../logger');

const NET_DVR_CONTROL_GATEWAY_CMD = 16009;
const NET_DVR_REMOTE_OPEN_DOOR = 2001;
const NET_DVR_CONTROL_GATEWAY_SIZE = 172;

function doorContext(session, doorNo) {
  const original = Number(doorNo) || 1;
  const gatewayNo = Math.min(4, Math.max(1, Math.trunc(original)));
  const legacyZeroBased = gatewayNo - 1;
  const controllerId = session && session.controller ? session.controller.id : 'unknown';
  return { original, gatewayNo, legacyZeroBased, controllerId };
}

function sdkCode(api) {
  try { return Number(api.NET_DVR_GetLastError()); }
  catch { return -1; }
}

function summarizeAttempts(attempts) {
  return attempts
    .map((a) => `${a.method}: ${a.error ? a.error : `SDK ${a.code} (${human(a.code)})`}`)
    .join('; ');
}

function recordSdkFailure(api, attempts, method) {
  const code = sdkCode(api);
  attempts.push({ method, code });
  return code;
}

function makeGatewayPayload(koffi, gatewayStruct, gatewayNo) {
  const size = typeof koffi.sizeof === 'function'
    ? koffi.sizeof(gatewayStruct)
    : NET_DVR_CONTROL_GATEWAY_SIZE;
  const ptr = koffi.alloc(gatewayStruct, 1);
  const controlSrc = Buffer.alloc(32);
  Buffer.from('villasafe').copy(controlSrc);
  koffi.encode(ptr, gatewayStruct, {
    dwSize: size,
    dwGatewayIndex: gatewayNo,
    byCommand: 1,
    byLockType: 0,
    wLockID: 0,
    byControlSrc: controlSrc,
    byControlType: 1,
    byRes3: Buffer.alloc(3),
    byPassword: Buffer.alloc(16),
    byRes2: Buffer.alloc(108),
  });
  return { ptr, size };
}

async function open(session, doorNo) {
  const { api, structs, koffi } = sdkLoader.load();
  const ctx = doorContext(session, doorNo);
  const attempts = [];

  if (ctx.original !== ctx.gatewayNo) {
    log.warn('Door number outside DS-K2804 range — clamped for SDK command', {
      controllerId: ctx.controllerId,
      requestedDoorNo: ctx.original,
      usedDoorNo: ctx.gatewayNo,
    });
  }

  try {
    if (!structs.NET_DVR_CONTROL_GATEWAY || !koffi) throw new Error('NET_DVR_CONTROL_GATEWAY struct unavailable');
    const payload = makeGatewayPayload(koffi, structs.NET_DVR_CONTROL_GATEWAY, ctx.gatewayNo);
    const ok = api.NET_DVR_RemoteControl(session.userId, NET_DVR_CONTROL_GATEWAY_CMD, payload.ptr, payload.size);
    if (ok) {
      log.info('Door open', { controllerId: ctx.controllerId, doorNo: ctx.gatewayNo, method: 'RemoteControl 16009 gateway struct' });
      return;
    }
    recordSdkFailure(api, attempts, 'NET_DVR_RemoteControl(cmd=16009, NET_DVR_CONTROL_GATEWAY)');
  } catch (e) {
    attempts.push({ method: 'NET_DVR_RemoteControl(cmd=16009, NET_DVR_CONTROL_GATEWAY)', error: e && e.message ? e.message : String(e) });
  }

  try {
    if (typeof api.NET_DVR_ControlGateway !== 'function') throw new Error('NET_DVR_ControlGateway binding unavailable');
    const ok = api.NET_DVR_ControlGateway(session.userId, ctx.gatewayNo, 1);
    if (ok) {
      log.info('Door open', { controllerId: ctx.controllerId, doorNo: ctx.gatewayNo, method: 'ControlGateway 1-based' });
      return;
    }
    recordSdkFailure(api, attempts, 'NET_DVR_ControlGateway(doorNo, open)');
  } catch (e) {
    attempts.push({ method: 'NET_DVR_ControlGateway(doorNo, open)', error: e && e.message ? e.message : String(e) });
  }

  try {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(ctx.legacyZeroBased, 0);
    const ok = api.NET_DVR_RemoteControl(session.userId, NET_DVR_REMOTE_OPEN_DOOR, buf, 4);
    if (ok) {
      log.info('Door open', { controllerId: ctx.controllerId, doorNo: ctx.gatewayNo, method: 'RemoteControl 2001 DWORD fallback' });
      return;
    }
    recordSdkFailure(api, attempts, 'NET_DVR_RemoteControl(cmd=2001, DWORD index)');
  } catch (e) {
    attempts.push({ method: 'NET_DVR_RemoteControl(cmd=2001, DWORD index)', error: e && e.message ? e.message : String(e) });
  }

  throw new BridgeError(
    'DOOR_OPEN_FAILED',
    'Unable to open Hikvision door with any supported SDK command.',
    `Door ${ctx.gatewayNo} on DS-K2804 was tried with all known HCNetSDK open methods. ${summarizeAttempts(attempts)}`,
  );
}

async function close(session, doorNo) {
  // DS-K controllers auto-close after dwell. Try ControlGateway as a
  // best-effort hint and swallow the "unsupported" response so we don't
  // spam red failures on every close command.
  const { api } = sdkLoader.load();
  const ctx = doorContext(session, doorNo);
  try {
    const ok = api.NET_DVR_ControlGateway(session.userId, ctx.gatewayNo, 0);
    if (!ok) {
      const code = api.NET_DVR_GetLastError();
      log.info('Close not directly supported — relying on controller dwell', {
        controllerId: ctx.controllerId, doorNo: ctx.gatewayNo, sdkCode: code,
      });
    }
  } catch (e) {
    log.info('Close command skipped — controller dwell will auto-close', {
      controllerId: ctx.controllerId, doorNo: ctx.gatewayNo, err: e && e.message,
    });
  }
}

module.exports = { open, close };