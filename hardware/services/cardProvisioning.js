// Pushes the approved card list down to the controller so access still works —
// and paused cards are still refused — when the internet is down.
//
// Uses the SDK's ISAPI passthrough (NET_DVR_STDXMLConfig) against
// /ISAPI/AccessControl/CardInfo, which the K2 series supports natively.
const sdkLoader = require('../drivers/hikvision/sdkLoader');
const registry = require('../sessions/sessionRegistry');
const log = require('../logger');
const { BridgeError } = require('../utils/errorMap');
const fs = require('fs');
const path = require('path');
const { dataDir } = require('../paths');

// controllerId -> Set of card numbers currently written to the panel.
// Saved to disk: if it only lived in memory, a restart would forget which
// cards we wrote, and a card paused afterwards (resident owing, tag suspended
// or expired) would never be deleted — the controller would keep opening for
// it on its own.
const FILE = path.join(dataDir(), 'provisioned-cards.json');
const provisioned = new Map();
// Controllers whose panel we've read back this launch.
const reconciled = new Set();

function loadProvisioned() {
  try {
    const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    for (const [id, cards] of Object.entries(saved || {})) provisioned.set(id, new Set(cards));
  } catch { /* first run */ }
}

function saveProvisioned() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const out = Object.fromEntries([...provisioned.entries()].map(([id, set]) => [id, [...set]]));
    fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(out));
    fs.renameSync(`${FILE}.tmp`, FILE);
  } catch (e) { log.warn('Could not save provisioned cards', { error: e.message }); }
}

loadProvisioned();

function isapi(session, url, bodyJson) {
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

  const input = koffi.alloc(structs.NET_DVR_XML_CONFIG_INPUT, 1);
  koffi.encode(input, structs.NET_DVR_XML_CONFIG_INPUT, {
    dwSize: 40,
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
    dwSize: 40,
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

function addCard(session, card) {
  return isapi(session, 'POST /ISAPI/AccessControl/CardInfo/Record?format=json', {
    CardInfo: {
      employeeNo: card.employeeNo || card.cardNo,
      cardNo: card.cardNo,
      cardType: 'normalCard',
    },
  });
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
    const r = isapi(session, 'POST /ISAPI/AccessControl/CardInfo/Search?format=json', {
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
  return isapi(session, 'PUT /ISAPI/AccessControl/CardInfo/Delete?format=json', {
    CardInfoDelCond: { CardNoList: [{ cardNo }] },
  });
}

/**
 * Diff the desired card list against what we last wrote and apply the delta.
 * @param {string} controllerId
 * @param {Array<{cardNo:string, employeeNo?:string}>} desired
 */
async function sync(controllerId, desired) {
  const session = await registry.ensure(controllerId);
  const want = new Set((desired || []).map(c => String(c.cardNo).toUpperCase()).filter(Boolean));
  const have = provisioned.get(controllerId) || new Set();

  // Once per launch, add what the panel actually holds from us to our record,
  // so cards written before this record existed are removed too.
  if (!reconciled.has(controllerId)) {
    try {
      for (const cardNo of listVillaSafeCards(session)) have.add(cardNo);
      reconciled.add(controllerId);
    } catch (e) {
      log.warn('Could not read cards back from the controller', { controllerId, error: e.message });
    }
  }

  const toAdd = [...want].filter(c => !have.has(c));
  const toRemove = [...have].filter(c => !want.has(c));
  if (!toAdd.length && !toRemove.length) {
    return { controllerId, added: 0, removed: 0, unchanged: want.size };
  }

  const errors = [];
  let added = 0;
  let removed = 0;
  for (const cardNo of toAdd) {
    try {
      const card = desired.find(d => String(d.cardNo).toUpperCase() === cardNo) || { cardNo };
      addCard(session, { ...card, cardNo });
      have.add(cardNo);
      added++;
    } catch (e) { errors.push({ cardNo, op: 'add', error: e.message }); }
  }
  for (const cardNo of toRemove) {
    try { deleteCard(session, cardNo); have.delete(cardNo); removed++; }
    catch (e) { errors.push({ cardNo, op: 'remove', error: e.message }); }
  }
  provisioned.set(controllerId, have);
  saveProvisioned();
  log.info('Card provisioning applied', { controllerId, added, removed, errors: errors.length });
  return { controllerId, added, removed, total: have.size, errors };
}

function state() {
  return [...provisioned.entries()].map(([controllerId, set]) => ({
    controllerId, cards: set.size,
  }));
}

function reset(controllerId) {
  if (controllerId) { provisioned.delete(controllerId); reconciled.delete(controllerId); }
  else { provisioned.clear(); reconciled.clear(); }
  saveProvisioned();
}

module.exports = { sync, state, reset, addCard, deleteCard };
