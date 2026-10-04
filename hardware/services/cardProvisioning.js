// Pushes the approved card list down to the controller so access still works —
// and paused cards are still refused — when the internet is down, or the
// Gate Bridge PC can't reach the controller, or is switched off.
//
// A Hikvision access controller decides a card by the person it belongs to: a
// card on its own, with no door permission, is refused. So each VillaSafe tag
// becomes a person (employeeNo = the card number) allowed through the lane's
// doors on the all-day schedule (plan template 1), valid until the tag expires
// or the resident's next bill falls overdue, and then the card is added to
// that person. The controller then keeps deciding correctly by itself.
// Older card-based firmware without persons gets the permission on the card.
// Firmware with no ISAPI card management at all (the DS-K2804s on site answer
// every ISAPI card call with "not supported") gets the same card through the
// SDK's classic card interface (drivers/hikvision/cardsSdk.js).
//
// Uses the SDK's ISAPI passthrough (NET_DVR_STDXMLConfig) where it can.
const sdkLoader = require('../drivers/hikvision/sdkLoader');
const sdkCards = require('../drivers/hikvision/cardsSdk');
const registry = require('../sessions/sessionRegistry');
const log = require('../logger');
const { BridgeError } = require('../utils/errorMap');
const fs = require('fs');
const path = require('path');
const { dataDir } = require('../paths');

// controllerId -> Map(cardNo -> what was written: doors|valid until|name).
// Saved to disk: if it only lived in memory, a restart would forget which
// cards we wrote, and a card paused afterwards (resident owing, tag suspended
// or expired) would never be deleted — the controller would keep opening for
// it on its own.
const FILE = path.join(dataDir(), 'provisioned-cards.json');
const provisioned = new Map();
// Controllers whose panel we've read back this launch.
const reconciled = new Set();
// controllerId -> 'person' | 'card' (ISAPI without persons) | 'sdk' (no ISAPI cards).
const firmware = new Map();

function loadProvisioned() {
  try {
    const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    for (const [id, cards] of Object.entries(saved || {})) {
      // Older files list card numbers only: written without permissions, so
      // an empty record makes them be written again, properly.
      provisioned.set(id, new Map(Array.isArray(cards) ? cards.map((c) => [c, '']) : Object.entries(cards || {})));
    }
  } catch { /* first run */ }
}

function saveProvisioned() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const out = Object.fromEntries([...provisioned.entries()].map(([id, cards]) => [id, Object.fromEntries(cards)]));
    fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(out));
    fs.renameSync(`${FILE}.tmp`, FILE);
  } catch (e) { log.warn('Could not save provisioned cards', { error: e.message }); }
}

loadProvisioned();

function sdkIsapi(session, url, bodyJson) {
  const sdk = sdkLoader.load();
  const { api, koffi, structs } = sdk;
  if (!api.NET_DVR_STDXMLConfig) {
    throw new BridgeError(
      'ISAPI_UNAVAILABLE',
      'NET_DVR_STDXMLConfig is not exported by this SDK build.',
      'Install the full HCNetSDK package (v6.1.9.4 or newer) in vendor/hcnetsdk/.',
    );
  }
  const urlBuf = Buffer.from(url + '\0', 'ascii');
  const inBuf = bodyJson ? Buffer.from(JSON.stringify(bodyJson), 'utf8') : null;
  const outBuf = Buffer.alloc(1024 * 32);
  const statusBuf = Buffer.alloc(1024 * 4);

  // dwSize is the structure's real size (72 bytes on 64-bit Windows). A fixed
  // 40 made the SDK refuse every call with "parameter error" (SDK error 17).
  const input = koffi.alloc(structs.NET_DVR_XML_CONFIG_INPUT, 1);
  koffi.encode(input, structs.NET_DVR_XML_CONFIG_INPUT, {
    dwSize: koffi.sizeof(structs.NET_DVR_XML_CONFIG_INPUT),
    lpRequestUrl: urlBuf,
    dwRequestUrlLen: urlBuf.length - 1,
    lpInBuffer: inBuf,
    dwInBufferSize: inBuf ? inBuf.length : 0,
    dwRecvTimeOut: 5000,
    byForceEncrpt: 0,
    byNumOfMultiPart: 0,
    byRes: Buffer.alloc(30),
  });
  const output = koffi.alloc(structs.NET_DVR_XML_CONFIG_OUTPUT, 1);
  koffi.encode(output, structs.NET_DVR_XML_CONFIG_OUTPUT, {
    dwSize: koffi.sizeof(structs.NET_DVR_XML_CONFIG_OUTPUT),
    lpOutBuffer: outBuf,
    dwOutBufferSize: outBuf.length,
    dwReturnedXMLSize: 0,
    lpStatusBuffer: statusBuf,
    dwStatusSize: statusBuf.length,
    byRes: Buffer.alloc(32),
  });

  const ok = api.NET_DVR_STDXMLConfig(session.userId, input, output);
  if (!ok) {
    const code = api.NET_DVR_GetLastError();
    const detail = statusBuf.toString('utf8').split('\0')[0];
    throw new BridgeError('ISAPI_FAILED', `ISAPI ${url} failed (SDK error ${code})`, detail || undefined);
  }
  const text = outBuf.toString('utf8').split('\0')[0];
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

let isapiImpl = sdkIsapi; // tests swap in a fake controller
let sdkCardsImpl = sdkCards;
let sdkImpl = () => sdkLoader.load();

/** One ISAPI call; a reply that reports a failure throws, with the controller's reason. */
function call(session, url, body) {
  const r = isapiImpl(session, url, body);
  if (r && typeof r.statusCode === 'number' && r.statusCode !== 1) {
    throw new BridgeError('ISAPI_FAILED', `ISAPI ${url} failed: ${r.subStatusCode || r.statusString || r.statusCode}`, JSON.stringify(r));
  }
  return r;
}

const why = (e) => `${e && e.message} ${e && e.hint}`;
const alreadyExists = (e) => /already ?exist|AlreadyExist|repeat/i.test(why(e));
const doesNotExist = (e) => /not ?exist|NotExist|noRecord/i.test(why(e));
const notSupported = (e) => /notSupport|not ?support|SDK error 23\b|invalidOperation|Invalid Operation|methodNotAllowed/i.test(why(e));
const badContent = (e) => /badParameters|Invalid Content|badJsonContent|badJsonFormat|SDK error 17\b/i.test(why(e));

const MAX_END = '2037-12-31T23:59:59';

/** ISO time → the controller's local-time format, never past what it accepts. */
function localTime(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return MAX_END;
  const p = (n) => String(n).padStart(2, '0');
  const s = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return s > MAX_END ? MAX_END : s;
}

const doorsOf = (c) => {
  const doors = [...new Set((c.doors && c.doors.length ? c.doors : [1]).map(Number).filter((n) => n >= 1))].sort((a, b) => a - b);
  return doors.length ? doors : [1];
};
const endOf = (c) => (c.validUntil ? localTime(c.validUntil) : MAX_END);
const nameOf = (c) => String(c.name || 'VillaSafe card').slice(0, 32);
/** What was written for a card, so a change of doors, expiry or name is written again. */
const sigOf = (c) => `${doorsOf(c).join(',')}|${endOf(c)}|${nameOf(c)}`;

function permission(c) {
  const doors = doorsOf(c);
  return {
    Valid: { enable: true, beginTime: '2020-01-01T00:00:00', endTime: endOf(c), timeType: 'local' },
    doorRight: doors.join(','),
    RightPlan: doors.map((doorNo) => ({ doorNo, planTemplateNo: '1' })),
  };
}

/** The person a card belongs to, created or updated. */
function upsertPerson(session, c) {
  const UserInfo = { employeeNo: c.employeeNo || c.cardNo, name: nameOf(c), userType: 'normal', ...permission(c) };
  try {
    call(session, 'POST /ISAPI/AccessControl/UserInfo/Record?format=json', { UserInfo });
  } catch (e) {
    if (!alreadyExists(e)) throw e;
    call(session, 'PUT /ISAPI/AccessControl/UserInfo/Modify?format=json', { UserInfo });
  }
}

function addCard(session, card) {
  const CardInfo = { employeeNo: card.employeeNo || card.cardNo, cardNo: card.cardNo, cardType: 'normalCard', ...(card.extra || {}) };
  try {
    return call(session, 'POST /ISAPI/AccessControl/CardInfo/Record?format=json', { CardInfo });
  } catch (e) {
    if (alreadyExists(e)) return null;
    throw e;
  }
}

const unsupported = (e) => notSupported(e) || (e && e.code === 'ISAPI_UNAVAILABLE');

/**
 * How this controller takes cards, asked once with read-only calls: persons
 * (ISAPI), cards (ISAPI, no persons), or neither — the SDK's card interface.
 */
function detectFirmware(session, controllerId) {
  if (firmware.has(controllerId)) return firmware.get(controllerId);
  let mode;
  try {
    call(session, 'GET /ISAPI/AccessControl/UserInfo/Count?format=json');
    mode = 'person';
  } catch (e) {
    if (!unsupported(e)) throw e; // couldn't ask: try again next time
    try {
      call(session, 'GET /ISAPI/AccessControl/CardInfo/Count?format=json');
      mode = 'card';
    } catch (e2) {
      if (!unsupported(e2)) throw e2;
      mode = 'sdk';
    }
  }
  firmware.set(controllerId, mode);
  log.info('Controller card management', { controllerId, mode });
  return mode;
}

/** Person (with door rights and validity) then card; card-based firmware gets the rights on the card. */
async function writeCard(session, controllerId, c) {
  if (firmware.get(controllerId) === 'sdk') {
    return sdkCardsImpl.setCard(sdkImpl(), session, {
      cardNo: c.cardNo, doors: doorsOf(c), end: endOf(c), name: nameOf(c), employeeNo: Number(c.employeeNo || c.cardNo) || 0,
    });
  }
  if (firmware.get(controllerId) !== 'card') {
    try {
      upsertPerson(session, c);
      firmware.set(controllerId, 'person');
    } catch (e) {
      if (!notSupported(e)) throw e;
      firmware.set(controllerId, 'card');
      log.info('Controller has no persons — writing door permission on each card', { controllerId });
    }
  }
  if (firmware.get(controllerId) === 'card') {
    try {
      deleteCard(session, c.cardNo); // a card can't be modified in place; rewrite it with its permission
    } catch { /* wasn't there */ }
    try {
      return addCard(session, { ...c, extra: permission(c) });
    } catch (e) {
      if (!badContent(e)) throw e;
      return addCard(session, c); // firmware that takes no permission fields at all
    }
  }
  return addCard(session, c);
}

/**
 * Cards VillaSafe wrote to the panel (we always set employeeNo = cardNo), read
 * back through ISAPI CardInfo/Search. Cards an installer enrolled by hand in
 * iVMS have their own employee numbers and are left alone.
 */
function listVillaSafeCards(session) {
  const found = new Set();
  const searchID = `villasafe-${Date.now()}`;
  for (let position = 0; position < 10000;) {
    const r = call(session, 'POST /ISAPI/AccessControl/CardInfo/Search?format=json', {
      CardInfoSearchCond: { searchID, searchResultPosition: position, maxResults: 30 },
    });
    const page = r && r.CardInfoSearch;
    const cards = page && Array.isArray(page.CardInfo) ? page.CardInfo : [];
    for (const c of cards) {
      const cardNo = String(c.cardNo || '').toUpperCase();
      if (cardNo && String(c.employeeNo || '').toUpperCase() === cardNo) found.add(cardNo);
    }
    if (!cards.length || page.responseStatusStrg !== 'MORE') break;
    position += cards.length;
  }
  return found;
}

function deleteCard(session, cardNo) {
  try {
    return call(session, 'PUT /ISAPI/AccessControl/CardInfo/Delete?format=json', {
      CardInfoDelCond: { CardNoList: [{ cardNo }] },
    });
  } catch (e) {
    if (doesNotExist(e)) return null;
    throw e;
  }
}

/** Card and its person (deleting the person also removes any cards left on it). */
async function removeCard(session, controllerId, cardNo) {
  if (firmware.get(controllerId) === 'sdk') return sdkCardsImpl.deleteCard(sdkImpl(), session, cardNo);
  deleteCard(session, cardNo);
  if (firmware.get(controllerId) === 'card') return;
  try {
    call(session, 'PUT /ISAPI/AccessControl/UserInfo/Delete?format=json', {
      UserInfoDelCond: { EmployeeNoList: [{ employeeNo: cardNo }] },
    });
  } catch (e) {
    if (!doesNotExist(e) && !notSupported(e)) throw e;
  }
}

/**
 * Bring the controller's cards in line with the desired list: add new ones,
 * rewrite ones whose doors, expiry or name changed, remove the rest.
 * @param {string} controllerId
 * @param {Array<{cardNo:string, employeeNo?:string, name?:string, doors?:number[], validUntil?:string|null}>} desired
 */
async function sync(controllerId, desired) {
  const session = await registry.ensure(controllerId);
  const want = new Map((desired || []).filter((c) => c && c.cardNo).map((c) => [String(c.cardNo).toUpperCase(), { ...c, cardNo: String(c.cardNo).toUpperCase() }]));
  const have = provisioned.get(controllerId) || new Map();

  let mode;
  try {
    mode = detectFirmware(session, controllerId);
  } catch (e) {
    throw new BridgeError('CARD_MODE_UNKNOWN', `Could not ask the controller how it takes cards: ${e.message}`);
  }

  // Once per launch, add what the panel actually holds from us to our record,
  // so cards written before this record existed are fixed up or removed too.
  // (The SDK card list doesn't say who wrote a card: only cards VillaSafe
  // wants are taken in, so cards enrolled by hand in iVMS are never removed.)
  if (!reconciled.has(controllerId)) {
    try {
      if (mode === 'sdk') {
        for (const card of await sdkCardsImpl.listCards(sdkImpl(), session)) {
          const cardNo = String(card.cardNo).toUpperCase();
          if (want.has(cardNo) && !have.has(cardNo)) have.set(cardNo, '');
        }
      } else {
        for (const cardNo of listVillaSafeCards(session)) if (!have.has(cardNo)) have.set(cardNo, '');
      }
      reconciled.add(controllerId);
    } catch (e) {
      log.warn('Could not read cards back from the controller', { controllerId, error: e.message });
    }
  }

  const toWrite = [...want.values()].filter((c) => have.get(c.cardNo) !== sigOf(c));
  const toRemove = [...have.keys()].filter((cardNo) => !want.has(cardNo));
  if (!toWrite.length && !toRemove.length) {
    return { controllerId, added: 0, updated: 0, removed: 0, unchanged: want.size };
  }

  const errors = [];
  let added = 0;
  let updated = 0;
  let removed = 0;
  for (const c of toWrite) {
    const existed = have.has(c.cardNo);
    try {
      await writeCard(session, controllerId, c);
      have.set(c.cardNo, sigOf(c));
      if (existed) updated++; else added++;
    } catch (e) { errors.push({ cardNo: c.cardNo, op: existed ? 'update' : 'add', error: e.message }); }
  }
  for (const cardNo of toRemove) {
    try { await removeCard(session, controllerId, cardNo); have.delete(cardNo); removed++; }
    catch (e) { errors.push({ cardNo, op: 'remove', error: e.message }); }
  }
  provisioned.set(controllerId, have);
  saveProvisioned();
  log.info('Card provisioning applied', { controllerId, added, updated, removed, errors: errors.length });
  if (errors.length) log.warn('Some cards were not written to the controller', { controllerId, first: errors[0] });
  return { controllerId, added, updated, removed, total: have.size, errors };
}

function state() {
  return [...provisioned.entries()].map(([controllerId, cards]) => ({
    controllerId, cards: cards.size, firmware: firmware.get(controllerId) || null,
  }));
}

function reset(controllerId) {
  if (controllerId) { provisioned.delete(controllerId); reconciled.delete(controllerId); firmware.delete(controllerId); }
  else { provisioned.clear(); reconciled.clear(); firmware.clear(); }
  saveProvisioned();
}

module.exports = {
  sync, state, reset, addCard, deleteCard,
  _internal: {
    setIsapi: (fn) => { isapiImpl = fn || sdkIsapi; },
    setSdkCards: (impl, sdk) => { sdkCardsImpl = impl || sdkCards; sdkImpl = sdk ? () => sdk : () => sdkLoader.load(); },
    sigOf, localTime,
  },
};
