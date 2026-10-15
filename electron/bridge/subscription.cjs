// The estate's VillaSafe subscription, on this PC.
//
// With every sync VillaSafe sends paidUntil: the end of the estate's last paid
// day (Lagos time), or null for estates it doesn't charge. It's saved on this
// PC and checked every few seconds, so when it passes the gates stop — with no
// internet, and after a restart. They start again once VillaSafe accepts a sync
// (the estate has paid, or VillaSafe has extended it).
//
// "Now" is this PC's clock corrected by VillaSafe's at the last sync, and never
// earlier than the latest time this PC has seen: setting the date back on the
// PC doesn't reopen the gates. A clock that was set too far ahead is put right
// by the next sync.
const SAVE_EVERY_MS = 10 * 60_000;

let offset = 0; // VillaSafe's clock minus this PC's, at the last sync
let floor = 0; // the latest trusted time seen
let savedAt = 0;
let save = () => {};

/** Pick up what was saved, and how to save it (Store.update). */
function init(cfg = {}, saver) {
  offset = Number(cfg.clockOffset) || 0;
  floor = Number(cfg.clockFloor) || 0;
  savedAt = Date.now();
  if (saver) save = saver;
}

function persist(force = false) {
  if (!force && Date.now() - savedAt < SAVE_EVERY_MS) return;
  savedAt = Date.now();
  try { save({ clockOffset: offset, clockFloor: floor }); } catch { /* kept in memory */ }
}

function trustedNow(local = Date.now()) {
  floor = Math.max(local + offset, floor);
  persist();
  return floor;
}

/** VillaSafe's time, from a sync it accepted: the truth, even if it's earlier. */
function noteServerTime(iso, local = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return;
  offset = t - local;
  floor = t;
  persist(true);
}

/** Whether the subscription has run out, and how long is left. */
function check(paidUntil, now = trustedNow()) {
  const until = paidUntil ? Date.parse(paidUntil) : NaN;
  if (!Number.isFinite(until)) return { paidUntil: null, locked: false, daysLeft: null };
  return { paidUntil, locked: now > until, daysLeft: Math.max(0, Math.ceil((until - now) / 86_400_000)) };
}

function lockMessage(paidUntil) {
  const d = new Date(paidUntil);
  const day = Number.isFinite(d.getTime())
    ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Lagos' })
    : 'its last paid day';
  return `This estate's VillaSafe subscription ended on ${day}. Pay VillaSafe to unlock the gates — they open again within a minute of the payment being approved.`;
}

/** Cap each tag's validity at the end of the subscription, so a controller stops on its own too. */
function capTags(tags, paidUntil) {
  const until = paidUntil ? Date.parse(paidUntil) : NaN;
  if (!Number.isFinite(until)) return tags;
  return (tags || []).map((t) => {
    const own = t.valid_until ? Date.parse(t.valid_until) : NaN;
    return Number.isFinite(own) && own <= until ? t : { ...t, valid_until: new Date(until).toISOString() };
  });
}

module.exports = { init, trustedNow, noteServerTime, check, lockMessage, capTags, persist };
