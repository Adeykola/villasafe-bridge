// Access-control event listener.
//
// Hikvision panels (DS-K2804 & friends) push card-swipe / door / tamper events
// through a single global message callback. We register that callback once,
// arm an alarm channel per controller session, decode the card number out of
// NET_DVR_ACS_ALARM_INFO and fan the result out to subscribers.
//
// If the SDK build lacks the alarm symbols we degrade quietly: the bridge keeps
// running, and `status()` explains why no card events arrive.
const sdkLoader = require('./sdkLoader');
const log = require('../../logger');
const { normalizeCardNumber } = require('../../utils/wiegand');

const COMM_ALARM_ACS = 0x5002;

// NET_DVR_ACS_ALARM_INFO layout (bytes)
//   0   dwSize                (4)
//   4   dwMajor               (4)
//   8   dwMinor               (4)
//   12  struTime              (24)  NET_DVR_TIME
//   36  sNetUser              (16)
//   52  struRemoteHostAddr    (144) NET_DVR_IPADDR
//   196 struAcsEventInfo      (...) NET_DVR_ACS_EVENT_INFO
//        +0   dwSize          (4)
//        +4   byCardNo        (32)
//        +36  byCardType      (1)
//        +37  byAllowListNo   (1)
//        +38  byReportChannel (1)
//        +39  byCardReaderKind(1)
//        +40  dwCardReaderNo  (4)
//        +44  dwDoorNo        (4)
const ACS_EVENT_OFFSET = 196;
const CARD_NO_OFFSET = ACS_EVENT_OFFSET + 4;
const CARD_NO_LEN = 32;
const READER_NO_OFFSET = ACS_EVENT_OFFSET + 40;
const DOOR_NO_OFFSET = ACS_EVENT_OFFSET + 44;

const listeners = new Set();
let registered = false;
let registrationError = null;
let callbackRef = null;
const alarmHandles = new Map(); // controllerId -> handle
let lastEventAt = null;

function onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function emit(evt) {
  lastEventAt = new Date().toISOString();
  log.info('Controller event', evt);
  for (const fn of listeners) {
    try { fn(evt); } catch (e) { log.warn('event listener failed', { error: e.message }); }
  }
}

function readCString(buf, offset, len) {
  const slice = buf.slice(offset, offset + len);
  const end = slice.indexOf(0);
  return slice.slice(0, end === -1 ? slice.length : end).toString('ascii').trim();
}

function decodeAcsAlarm(bytes) {
  if (!bytes || bytes.length < DOOR_NO_OFFSET + 4) return null;
  const buf = Buffer.from(bytes);
  const rawCard = readCString(buf, CARD_NO_OFFSET, CARD_NO_LEN);
  if (!rawCard) return null;
  return {
    rawCardNo: rawCard,
    tagUid: normalizeCardNumber(rawCard, 'auto'),
    readerNo: buf.readUInt32LE(READER_NO_OFFSET),
    doorNo: buf.readUInt32LE(DOOR_NO_OFFSET),
    major: buf.readUInt32LE(4),
    minor: buf.readUInt32LE(8),
    at: new Date().toISOString(),
  };
}

/** Register the single global SDK message callback. Idempotent. */
function ensureRegistered() {
  if (registered) return true;
  if (registrationError) return false;
  let sdk;
  try { sdk = sdkLoader.load(); } catch (e) { registrationError = e.message; return false; }
  const { api, koffi, structs } = sdk;
  if (!api.NET_DVR_SetDVRMessageCallBack_V31) {
    registrationError = 'NET_DVR_SetDVRMessageCallBack_V31 is not exported by this SDK build';
    return false;
  }
  try {
    callbackRef = koffi.register((lCommand, _pAlarmer, pAlarmInfo, dwBufLen) => {
      try {
        if (lCommand === COMM_ALARM_ACS && pAlarmInfo) {
          const len = Math.max(Number(dwBufLen) || 0, DOOR_NO_OFFSET + 8);
          const bytes = koffi.decode(pAlarmInfo, koffi.array('uint8', len));
          const evt = decodeAcsAlarm(bytes);
          if (evt) emit({ type: 'card', ...evt });
        }
      } catch (e) {
        log.warn('Failed to decode controller alarm', { error: e.message });
      }
      return true;
    }, koffi.pointer(structs.MSG_CALLBACK));

    const ok = api.NET_DVR_SetDVRMessageCallBack_V31(callbackRef, null);
    if (!ok) {
      registrationError = `NET_DVR_SetDVRMessageCallBack_V31 failed (SDK error ${api.NET_DVR_GetLastError()})`;
      return false;
    }
    registered = true;
    log.info('Access-control message callback registered');
    return true;
  } catch (e) {
    registrationError = e.message;
    log.warn('Could not register message callback', { error: e.message });
    return false;
  }
}

/** Arm the alarm channel for one logged-in controller session. */
function subscribe(session) {
  if (!session || session.userId < 0) return { ok: false, error: 'Controller session is not connected' };
  if (alarmHandles.has(session.controller.id)) return { ok: true, alreadyArmed: true };
  if (!ensureRegistered()) return { ok: false, error: registrationError };

  const { api, koffi, structs } = sdkLoader.load();
  if (!api.NET_DVR_SetupAlarmChan_V41) {
    return { ok: false, error: 'NET_DVR_SetupAlarmChan_V41 is not exported by this SDK build' };
  }
  try {
    const param = koffi.alloc(structs.NET_DVR_SETUPALARM_PARAM, 1);
    koffi.encode(param, structs.NET_DVR_SETUPALARM_PARAM, {
      dwSize: 24,
      byLevel: 1,
      byAlarmInfoType: 1,       // return NET_DVR_ACS_ALARM_INFO
      byRetAlarmTypeV40: 0,
      byRetDevInfoVersion: 0,
      byRetVQDAlarmType: 0,
      byFaceAlarmDetection: 0,
      bySupport: 0,
      byBrokenNetHttp: 0,
      wTaskNo: 0,
      byDeployType: 0,
      bySubScription: 0,
      byRes1: Buffer.alloc(2),
      byAlarmTypeURL: 0,
      byCustomCtrl: 0,
    });
    const handle = api.NET_DVR_SetupAlarmChan_V41(session.userId, param);
    if (handle < 0) {
      return { ok: false, error: `NET_DVR_SetupAlarmChan_V41 failed (SDK error ${api.NET_DVR_GetLastError()})` };
    }
    alarmHandles.set(session.controller.id, handle);
    log.info('Armed access-control alarm channel', { controllerId: session.controller.id, handle });
    return { ok: true, handle };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function unsubscribe(controllerId) {
  const handle = alarmHandles.get(controllerId);
  if (handle == null) return;
  alarmHandles.delete(controllerId);
  try { sdkLoader.load().api.NET_DVR_CloseAlarmChan_V30?.(handle); } catch { /* noop */ }
}

function status() {
  return {
    callbackRegistered: registered,
    registrationError,
    armedControllers: [...alarmHandles.keys()],
    lastEventAt,
  };
}

module.exports = {
  onEvent, emit, subscribe, unsubscribe, status,
  // exported for tests
  decodeAcsAlarm, COMM_ALARM_ACS,
};
