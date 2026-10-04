// Cards on Hikvision controllers through the SDK's classic access-control
// interface (NET_DVR_GET/SET_CARD_CFG_V50), for firmware with no ISAPI card or
// person management — like the DS-K2804s on site, where every ISAPI card call
// answers "not supported" (SDK error 23).
//
// The structures are built as plain buffers at their HCNetSDK offsets:
//   NET_DVR_CARD_CFG_COND  40 bytes
//   NET_DVR_CARD_CFG_V50   2708 bytes (the controller reports the same size)
//
// Results come back through a callback with no reference to the call it
// belongs to, so operations run one at a time. Waiting is asynchronous, so
// card swipes and door commands keep flowing while a card list is written.
// No relative requires: the bridge can also load this file on its own.

const GET_CARD_CFG_V50 = 2178;
const SET_CARD_CFG_V50 = 2179;
const ENUM_ACS_SEND_DATA = 3;
const CB_STATUS = 0;
const CB_DATA = 2;
const STATUS_SUCCESS = 1000;
const STATUS_PROCESSING = 1001;
const STATUS_FAILED = 1002;

const COND_SIZE = 40;
const CARD_SIZE = 2708;
const MODIFY = { VALID: 0x1, PERIOD: 0x2, TYPE: 0x4, DOOR_RIGHT: 0x8, RIGHT_PLAN: 0x100, EMPLOYEE_NO: 0x400, NAME: 0x800 };
const OFFSET = {
  size: 0, modify: 4, cardNo: 8, valid: 40, type: 41, doorRight: 44,
  periodEnable: 300, begin: 304, end: 312, timeType: 320, rightPlan: 488, employeeNo: 2548, name: 2552,
};
const TIMEOUT_MS = 15_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cstr = (b) => { const i = b.indexOf(0); return b.slice(0, i < 0 ? b.length : i).toString('latin1'); };

function condBuffer(cardNum, checkCardNo) {
  const b = Buffer.alloc(COND_SIZE);
  b.writeUInt32LE(COND_SIZE, 0);
  b.writeUInt32LE(cardNum >>> 0, 4);
  b[8] = checkCardNo ? 1 : 0;
  return b;
}

/** "2027-10-04T23:59:59" (controller local time) → NET_DVR_TIME_EX at `at`. */
function writeTime(b, at, local) {
  const m = String(local).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!m) throw new Error(`Bad time ${local}`);
  b.writeUInt16LE(Number(m[1]), at);
  b[at + 2] = Number(m[2]); b[at + 3] = Number(m[3]);
  b[at + 4] = Number(m[4]); b[at + 5] = Number(m[5]); b[at + 6] = Number(m[6]);
}

const readTime = (b, at) =>
  `${String(b.readUInt16LE(at)).padStart(4, '0')}-${String(b[at + 2]).padStart(2, '0')}-${String(b[at + 3]).padStart(2, '0')}T${String(b[at + 4]).padStart(2, '0')}:${String(b[at + 5]).padStart(2, '0')}:${String(b[at + 6]).padStart(2, '0')}`;

/**
 * A card allowed through `doors` on plan template 1 (all day), valid from
 * `begin` to `end` (controller local time, "YYYY-MM-DDTHH:mm:ss").
 */
function encodeCard({ cardNo, doors = [1], begin = '2020-01-01T00:00:00', end = '2037-12-31T23:59:59', name = '', employeeNo = 0 }) {
  const b = Buffer.alloc(CARD_SIZE);
  b.writeUInt32LE(CARD_SIZE, OFFSET.size);
  b.writeUInt32LE(MODIFY.VALID | MODIFY.PERIOD | MODIFY.TYPE | MODIFY.DOOR_RIGHT | MODIFY.RIGHT_PLAN | MODIFY.EMPLOYEE_NO | MODIFY.NAME, OFFSET.modify);
  b.write(String(cardNo).slice(0, 31), OFFSET.cardNo, 'latin1');
  b[OFFSET.valid] = 1;
  b[OFFSET.type] = 1; // normal card
  for (const d of doors) {
    if (d < 1 || d > 256) continue;
    b[OFFSET.doorRight + d - 1] = 1;
    b.writeUInt16LE(1, OFFSET.rightPlan + (d - 1) * 8); // wCardRightPlan[door][0] = template 1
  }
  b[OFFSET.periodEnable] = 1;
  writeTime(b, OFFSET.begin, begin);
  writeTime(b, OFFSET.end, end);
  b[OFFSET.timeType] = 0; // local time
  b.writeUInt32LE(employeeNo >>> 0, OFFSET.employeeNo);
  b.write(String(name || '').replace(/[^\x20-\x7e]/g, '').slice(0, 31), OFFSET.name, 'latin1');
  return b;
}

/** Marks a card invalid, which deletes it. */
function encodeDelete(cardNo) {
  const b = Buffer.alloc(CARD_SIZE);
  b.writeUInt32LE(CARD_SIZE, OFFSET.size);
  b.writeUInt32LE(MODIFY.VALID, OFFSET.modify);
  b.write(String(cardNo).slice(0, 31), OFFSET.cardNo, 'latin1');
  b[OFFSET.valid] = 0;
  return b;
}

function decodeCard(b) {
  const doors = [];
  for (let d = 0; d < 256; d++) if (b[OFFSET.doorRight + d]) doors.push(d + 1);
  return {
    cardNo: cstr(b.slice(OFFSET.cardNo, OFFSET.cardNo + 32)),
    valid: b[OFFSET.valid] === 1,
    type: b[OFFSET.type],
    doors,
    begin: b[OFFSET.periodEnable] ? readTime(b, OFFSET.begin) : null,
    end: b[OFFSET.periodEnable] ? readTime(b, OFFSET.end) : null,
  };
}

// ---------------------------------------------------------------------------
// The SDK side

const bound = new WeakMap();
function bind(sdk) {
  if (bound.has(sdk)) return bound.get(sdk);
  const { koffi, lib } = sdk;
  const proto = koffi.proto('void VsCardCfgCallback(uint32 dwType, void *lpBuffer, uint32 dwBufLen, void *pUserData)');
  const b = {
    sink: null,
    Start: lib.func('int NET_DVR_StartRemoteConfig(int lUserID, uint32 dwCommand, void *lpInBuffer, uint32 dwInBufferLen, VsCardCfgCallback *cbStateCallback, void *pUserData)'),
    Send: lib.func('bool NET_DVR_SendRemoteConfig(int lHandle, uint32 dwDataType, void *pSendBuf, uint32 dwBufSize)'),
    Stop: lib.func('bool NET_DVR_StopRemoteConfig(int lHandle)'),
  };
  // Kept on the object so it's never garbage-collected while the SDK holds it.
  b.cb = koffi.register((dwType, lpBuffer, dwBufLen) => {
    let bytes = Buffer.alloc(0);
    try { if (lpBuffer && dwBufLen) bytes = Buffer.from(koffi.decode(lpBuffer, koffi.array('uint8', dwBufLen))); } catch { /* unreadable */ }
    b.sink?.({ type: dwType, bytes });
  }, koffi.pointer(proto));
  bound.set(sdk, b);
  return b;
}

let queue = Promise.resolve();
function oneAtATime(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

/** One remote-config session: start, send each buffer, wait for the final status, stop. */
function remote(sdk, session, command, cond, sends = []) {
  return oneAtATime(async () => {
    const b = bind(sdk);
    const events = [];
    b.sink = (e) => events.push(e);
    const handle = b.Start(session.userId, command, cond, cond.length, b.cb, null);
    if (handle < 0) {
      b.sink = null;
      throw new Error(`Card command ${command} refused (SDK error ${sdk.api.NET_DVR_GetLastError()})`);
    }
    try {
      for (const buf of sends) {
        if (!b.Send(handle, ENUM_ACS_SEND_DATA, buf, buf.length)) {
          throw new Error(`Sending a card failed (SDK error ${sdk.api.NET_DVR_GetLastError()})`);
        }
      }
      const finished = () => events.some((e) => e.type === CB_STATUS && e.bytes.length >= 4 && e.bytes.readUInt32LE(0) !== STATUS_PROCESSING);
      const deadline = Date.now() + TIMEOUT_MS;
      while (!finished()) {
        if (Date.now() > deadline) throw new Error('The controller did not answer the card command in time');
        await sleep(50);
      }
    } finally {
      b.Stop(handle);
      b.sink = null;
    }
    const failed = events.find((e) => e.type === CB_STATUS && e.bytes.length >= 4 && e.bytes.readUInt32LE(0) === STATUS_FAILED);
    if (failed) {
      const code = failed.bytes.length >= 8 ? failed.bytes.readUInt32LE(4) : 0;
      throw new Error(`The controller refused the card${code ? ` (error ${code})` : ''}`);
    }
    return events;
  });
}

/** Every card on the controller. */
async function listCards(sdk, session) {
  const events = await remote(sdk, session, GET_CARD_CFG_V50, condBuffer(0xffffffff, false));
  return events.filter((e) => e.type === CB_DATA && e.bytes.length >= CARD_SIZE - 200).map((e) => decodeCard(e.bytes));
}

/** Add or update a card (same number: its doors and validity are replaced). */
async function setCard(sdk, session, card) {
  await remote(sdk, session, SET_CARD_CFG_V50, condBuffer(1, true), [encodeCard(card)]);
}

async function deleteCard(sdk, session, cardNo) {
  await remote(sdk, session, SET_CARD_CFG_V50, condBuffer(1, true), [encodeDelete(cardNo)]);
}

module.exports = {
  listCards, setCard, deleteCard,
  _internal: { encodeCard, encodeDelete, decodeCard, CARD_SIZE, STATUS_SUCCESS },
};
