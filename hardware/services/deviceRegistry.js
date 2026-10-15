// What a Hikvision device holds: its people, their cards, and how many faces
// and fingerprints each has enrolled — read back for the Gate Bridge's
// Registered page. Read-only: nothing on the device changes.
//
//   Persons (face terminals, newer controllers): ISAPI UserInfo/Search, which
//     reports numOfCard / numOfFace / numOfFP per person, and CardInfo/Search
//     for the card numbers.
//   Cards only (older firmware): CardInfo/Search.
//   No ISAPI card management (the DS-K2804s): the SDK's card list. These
//     controllers have no face or fingerprint readers.
//
// Pages are read 30 at a time, letting door commands and scans through
// between pages, up to a limit so a huge device can't hold the bridge up.
const registry = require('../sessions/sessionRegistry');
const provisioning = require('./cardProvisioning');

const PAGE = 30;
const MAX_ITEMS = 5000;

const yieldToOthers = () => new Promise((r) => setImmediate(r));
const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v) || 0);

/** Every UserInfo or CardInfo record, page by page. */
async function searchAll(session, kind, max = MAX_ITEMS) {
  const searchID = `villasafe-${kind}-${Date.now()}`;
  const items = [];
  let truncated = false;
  for (let position = 0; ;) {
    const r = provisioning.isapi(session, `POST /ISAPI/AccessControl/${kind}/Search?format=json`, {
      [`${kind}SearchCond`]: { searchID, searchResultPosition: position, maxResults: PAGE },
    });
    const page = r && r[`${kind}Search`];
    const list = page && Array.isArray(page[kind]) ? page[kind] : [];
    items.push(...list);
    if (!list.length || page.responseStatusStrg !== 'MORE') break;
    position += list.length;
    if (items.length >= max) { truncated = true; break; }
    await yieldToOthers();
  }
  return { items, truncated };
}

/** Faces in the device's face library, for firmware that doesn't count them per person. */
function faceLibraryCount(session) {
  try {
    const r = provisioning.isapi(session, 'GET /ISAPI/Intelligent/FDLib/Count?format=json');
    const libs = Array.isArray(r && r.FDRecordDataInfo) ? r.FDRecordDataInfo : [];
    return libs.length ? libs.reduce((s, l) => s + (Number(l.recordDataNumber) || 0), 0) : null;
  } catch {
    return null;
  }
}

const validity = (v) => (v && v.enable !== false ? { validFrom: v.beginTime || null, validUntil: v.endTime || null } : { validFrom: null, validUntil: null });

/**
 * @param {string} controllerId
 * @returns {Promise<{ controllerId, mode, persons, cards, totals, truncated, written, readAt }>}
 *   persons: [{ employeeNo, name, userType, validFrom, validUntil, doors, cardNos, faces, fingerprints }]
 *   cards:   [{ cardNo, employeeNo, name, doors, validFrom, validUntil }]
 *   totals.faces / totals.fingerprints are null when the device doesn't report them.
 */
async function read(controllerId) {
  const session = await registry.ensure(controllerId);
  const mode = provisioning.firmwareOf(session, controllerId);
  const written = [...provisioning.writtenCards(controllerId)];
  const readAt = new Date().toISOString();

  if (mode === 'sdk') {
    const cards = (await provisioning.sdkListCards(session)).map((c) => ({
      cardNo: String(c.cardNo || ''),
      employeeNo: c.employeeNo ? String(c.employeeNo) : null,
      name: c.name || null,
      doors: c.doors || [],
      validFrom: c.begin || null,
      validUntil: c.end || null,
    }));
    return {
      controllerId, mode, persons: [], cards, truncated: false, written, readAt,
      totals: { persons: null, cards: cards.length, faces: null, fingerprints: null },
    };
  }

  const people = mode === 'person' ? await searchAll(session, 'UserInfo') : { items: [], truncated: false };
  const cardList = await searchAll(session, 'CardInfo');

  const cards = cardList.items.map((c) => ({
    cardNo: String(c.cardNo || ''),
    employeeNo: c.employeeNo ? String(c.employeeNo) : null,
    name: null,
    doors: String(c.doorRight || '').split(',').map(Number).filter((n) => n >= 1),
    ...validity(c.Valid),
  }));
  const cardsOf = new Map();
  for (const c of cards) {
    if (!c.employeeNo) continue;
    if (!cardsOf.has(c.employeeNo)) cardsOf.set(c.employeeNo, []);
    cardsOf.get(c.employeeNo).push(c.cardNo);
  }

  const persons = people.items.map((p) => {
    const employeeNo = String(p.employeeNo || '');
    return {
      employeeNo,
      name: p.name || null,
      userType: p.userType || null,
      doors: String(p.doorRight || '').split(',').map(Number).filter((n) => n >= 1),
      ...validity(p.Valid),
      cardNos: cardsOf.get(employeeNo) || [],
      cards: num(p.numOfCard) ?? (cardsOf.get(employeeNo) || []).length,
      faces: num(p.numOfFace),
      fingerprints: num(p.numOfFP),
    };
  });
  for (const c of cards) c.name = persons.find((p) => p.employeeNo === c.employeeNo)?.name || null;

  const sum = (key) => (persons.some((p) => p[key] !== null) ? persons.reduce((s, p) => s + (p[key] || 0), 0) : null);
  const faces = sum('faces') ?? (mode === 'person' ? faceLibraryCount(session) : null);
  return {
    controllerId, mode, persons, cards, written, readAt,
    truncated: people.truncated || cardList.truncated,
    totals: {
      persons: mode === 'person' ? persons.length : null,
      cards: cards.length,
      faces,
      fingerprints: sum('fingerprints'),
      // People with at least one, where the device says.
      withFace: persons.some((p) => p.faces !== null) ? persons.filter((p) => p.faces > 0).length : null,
      withFingerprint: persons.some((p) => p.fingerprints !== null) ? persons.filter((p) => p.fingerprints > 0).length : null,
    },
  };
}

module.exports = { read, _internal: { searchAll, MAX_ITEMS } };
