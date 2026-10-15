// The Registered page: every tag VillaSafe gave this PC, and what each
// Hikvision device behind a lane actually holds — its people, cards, faces
// and fingerprints — with each tag checked against the devices it should be
// on. Reading a device logs in to it, so it's done when someone asks.
const hik = require('../drivers/hikvision.cjs');
const tagStore = require('./tagStore.cjs');
const cardBridge = require('./cardBridge.cjs');

const READ_TIMEOUT_MS = 180_000;

/** Card numbers compared the way the controller compares them (leading zeros don't count). */
const cardKey = (n) => String(n || '').toUpperCase().replace(/^0+(?=.)/, '');

function laneNamesFor(lanes, controllerId) {
  return (lanes || [])
    .filter((l) => (l.devices || []).some((d) => d.driver === 'hikvision' && hik.controllerIdFor(d.params || {}) === controllerId))
    .map((l) => l.name);
}

/** Every tag on this PC, with whether it may open now and why not. */
function tagRows(tags, lanes, now = Date.now()) {
  const laneName = new Map((lanes || []).map((l) => [l.id, l.name]));
  return (tags || [])
    .map((t) => {
      const why = tagStore.refusal(t, null, now);
      return {
        uid: String(t.tag_uid || '').toUpperCase(),
        label: t.label || null,
        laneName: t.lane_id ? laneName.get(t.lane_id) || 'Another lane' : null,
        status: why || 'ok',
        reason: why ? tagStore.REASON_TEXT[why] || why : null,
        validUntil: t.valid_until || null,
        owingFrom: t.owing_from || null,
        cardNo: cardBridge.controllerCardNo(t.tag_uid),
      };
    })
    .sort((a, b) => (a.status === 'ok' ? 0 : 1) - (b.status === 'ok' ? 0 : 1)
      || String(a.label || a.uid).localeCompare(String(b.label || b.uid)));
}

/**
 * Read every Hikvision device behind this bridge's lanes.
 * @param lanes the bridge's lanes
 * @param tags  tagStore.effective(): every tag, paused where it may not open now
 */
async function readDevices(lanes, tags) {
  const controllers = cardBridge.controllersOf(lanes);
  const desired = cardBridge.desiredCards(lanes, tags);
  const byCard = new Map((tags || []).map((t) => [cardKey(cardBridge.controllerCardNo(t.tag_uid)), t]));
  const tagFor = (cardNo) => {
    const t = byCard.get(cardKey(cardNo));
    return t ? { uid: String(t.tag_uid || '').toUpperCase(), label: t.label || null } : null;
  };

  const results = [];
  for (const [id, params] of controllers) {
    const base = { id, name: params.name || params.host || id, host: params.host || null, lanes: laneNamesFor(lanes, id) };
    try {
      await hik.ensureController(params);
      const r = await hik.bridgeRequest('GET', `/api/cards/registry/${encodeURIComponent(id)}`, null, { timeoutMs: READ_TIMEOUT_MS });
      const written = new Set((r.written || []).map(cardKey));
      const want = new Set(((desired.get(id) || {}).cards || []).map((c) => cardKey(c.cardNo)));
      const cards = (r.cards || []).map((c) => ({ ...c, tag: tagFor(c.cardNo), fromVillaSafe: written.has(cardKey(c.cardNo)) }));
      const persons = (r.persons || []).map((p) => ({
        ...p,
        tags: (p.cardNos || []).map(tagFor).filter(Boolean),
        fromVillaSafe: (p.cardNos || []).some((n) => written.has(cardKey(n))) || written.has(cardKey(p.employeeNo)),
      }));
      const held = new Set(cards.map((c) => cardKey(c.cardNo)));
      results.push({
        ...base,
        ok: true,
        mode: r.mode,
        readAt: r.readAt,
        truncated: !!r.truncated,
        totals: r.totals || {},
        persons,
        cards,
        held: [...held],
        want: [...want],
      });
    } catch (e) {
      results.push({ ...base, ok: false, error: e.message });
    }
  }

  // Each tag against the devices that were read: on every one it should be
  // on, missing from one, or still on one although it may not open now.
  const read = results.filter((c) => c.ok);
  const presence = {};
  for (const t of tags || []) {
    if (!read.length) break;
    const key = cardKey(cardBridge.controllerCardNo(t.tag_uid));
    const missing = read.filter((c) => c.want.includes(key) && !c.held.includes(key)).map((c) => c.name);
    const stale = read.filter((c) => !c.want.includes(key) && c.held.includes(key)).map((c) => c.name);
    const on = read.filter((c) => c.held.includes(key)).map((c) => c.name);
    presence[String(t.tag_uid || '').toUpperCase()] = {
      state: missing.length ? 'missing' : stale.length ? 'stale' : on.length ? 'on' : 'none',
      on, missing, stale,
    };
  }
  for (const c of results) { delete c.held; delete c.want; }
  return { readAt: new Date().toISOString(), controllers: results, presence };
}

module.exports = { tagRows, readDevices, _internal: { cardKey } };
