// VillaSafe WhatsApp companion: keeps VillaSafe's WhatsApp number linked the
// way WhatsApp Web / Desktop does (scan a QR code once), and relays messages
// between WhatsApp and the communications inbox.
//
// It talks only to the whatsapp-connector edge function, with a shared secret.
// It never holds database keys. Its own login lives in AUTH_DIR; keep that
// folder on persistent storage or you'll have to scan the QR again.
//
// Runs on its own (npm start, Docker) or inside the VillaSafe WhatsApp
// Connector desktop app (app/main.cjs), which starts it with Windows, restarts
// it if it stops, and shows the QR code it reports over IPC.

import 'dotenv/config';
import { rm } from 'node:fs/promises';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

const API = process.env.CONNECTOR_URL;
const SECRET = process.env.CONNECTOR_SECRET;
const AUTH_DIR = process.env.AUTH_DIR || './auth';
const DEVICE_NAME = process.env.DEVICE_NAME || 'VillaSafe Inbox';

if (!API || !SECRET) {
  console.error('Set CONNECTOR_URL and CONNECTOR_SECRET (see .env.example).');
  process.exit(1);
}

const log = pino({ level: process.env.LOG_LEVEL || 'info' });

// With Wi-Fi up but no internet a request can hang for minutes; give up in time.
const REQUEST_TIMEOUT_MS = 20_000;

/** POST an action to the whatsapp-connector edge function. */
async function call(action, payload = {}) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-connector-secret': SECRET },
    body: JSON.stringify({ action, ...payload }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${action}: ${res.status} ${body.error || ''}`.trim());
  return body;
}

// The last state reported, repeated by the heartbeat (so a QR stays visible).
let current = { status: 'starting', extra: {} };

const report = (status, extra = {}) => {
  current = { status, extra };
  // The desktop app shows it too (the QR code even before VillaSafe is reachable).
  try { process.send?.({ type: 'state', status, ...extra }); } catch { /* no parent */ }
  return call('state', { status, ...extra }).catch((e) => {
    log.warn({ err: e.message }, 'could not report state');
    return {};
  });
};

let sock = null;
let connected = false;
let restarting = false;
// Messages this service sent; WhatsApp echoes them back and they're already recorded.
const sentByUs = new Set();

/** The text to show in the inbox for any kind of WhatsApp message. */
function textOf(message) {
  if (!message) return null;
  const m = message.ephemeralMessage?.message || message.viewOnceMessage?.message || message.viewOnceMessageV2?.message || message;
  if (m.protocolMessage || m.reactionMessage || (m.senderKeyDistributionMessage && Object.keys(m).length === 1)) return null;
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  const media = [
    ['imageMessage', 'photo'],
    ['videoMessage', 'video'],
    ['documentMessage', 'document'],
    ['audioMessage', 'voice note'],
    ['stickerMessage', 'sticker'],
  ];
  for (const [key, label] of media) {
    if (m[key]) {
      const caption = m[key].caption || m[key].fileName || '';
      return `[${label}]${caption ? ` ${caption}` : ''}`;
    }
  }
  if (m.locationMessage) return `[location] ${m.locationMessage.name || ''} ${m.locationMessage.degreesLatitude},${m.locationMessage.degreesLongitude}`.trim();
  if (m.contactMessage) return `[contact] ${m.contactMessage.displayName || ''}`.trim();
  if (m.buttonsResponseMessage) return m.buttonsResponseMessage.selectedDisplayText || '[button]';
  if (m.listResponseMessage) return m.listResponseMessage.title || '[list reply]';
  return null;
}

function contextOf(message) {
  const m = message?.ephemeralMessage?.message || message;
  if (!m) return null;
  for (const value of Object.values(m)) {
    if (value && typeof value === 'object' && value.contextInfo) return value.contextInfo;
  }
  return null;
}

/** The phone number behind a chat, when WhatsApp tells us. */
function phoneOf(key) {
  for (const jid of [key.remoteJid, key.remoteJidAlt]) {
    if (jid && jid.endsWith('@s.whatsapp.net')) return jid.split('@')[0].split(':')[0];
  }
  return null;
}

const STATUS = { 3: 'delivered', 4: 'read', 5: 'read', 0: 'failed' };

async function start() {
  restarting = false;
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  await report('starting');

  sock = makeWASocket({
    version,
    auth: state,
    logger: log.child({ module: 'baileys' }, { level: 'warn' }),
    browser: Browsers.appropriate(DEVICE_NAME),
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrcode.generate(qr, { small: true });
      log.info('Scan the QR code (in the terminal or the VillaSafe inbox) with WhatsApp → Linked devices');
      await report('qr', { qr });
    }
    if (connection === 'open') {
      connected = true;
      const id = sock.user?.id || '';
      log.info({ id }, 'WhatsApp linked');
      await report('connected', { phone: id.split(':')[0].split('@')[0], display_name: sock.user?.name || null });
    }
    if (connection === 'close') {
      connected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        log.warn('Logged out: clearing the saved login so a new QR code appears');
        await rm(AUTH_DIR, { recursive: true, force: true });
        await report('logged_out');
      } else {
        log.warn({ code }, 'Connection closed, reconnecting');
      }
      restart(code === DisconnectReason.restartRequired ? 500 : 4000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;
    const batch = [];
    for (const msg of messages) {
      const jid = msg.key?.remoteJid;
      if (!jid || isJidGroup(jid) || isJidBroadcast(jid) || isJidStatusBroadcast(jid) || isJidNewsletter(jid)) continue;
      if (msg.key.fromMe && sentByUs.has(msg.key.id)) continue;
      const body = textOf(msg.message);
      if (!body) continue;
      batch.push({
        wa_id: msg.key.id,
        jid,
        phone: phoneOf(msg.key),
        push_name: msg.key.fromMe ? null : msg.pushName || null,
        body,
        quoted_wa_id: contextOf(msg.message)?.stanzaId || null,
        timestamp: Number(msg.messageTimestamp) || null,
        from_me: !!msg.key.fromMe,
      });
    }
    if (batch.length) {
      await call('inbound', { messages: batch }).catch((e) => log.error({ err: e.message }, 'inbound failed'));
    }
  });

  sock.ev.on('messages.update', async (updates) => {
    const receipts = updates
      .filter((u) => u.key?.fromMe && STATUS[u.update?.status] && !isJidGroup(u.key.remoteJid || ''))
      .map((u) => ({ wa_id: u.key.id, status: STATUS[u.update.status] }));
    if (receipts.length) await call('receipts', { updates: receipts }).catch(() => undefined);
  });
}

function restart(delay) {
  if (restarting) return;
  restarting = true;
  try {
    sock?.ev.removeAllListeners();
  } catch {
    /* already gone */
  }
  setTimeout(() => start().catch((e) => {
    log.error({ err: e.message }, 'start failed');
    restarting = false;
    restart(10_000);
  }), delay);
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** Send the replies the team queued in the inbox, gently paced like a person. */
let draining = false;
async function drainOutbox() {
  // One batch at a time, even when a slow connection makes a batch outlast the timer.
  if (!connected || !sock || draining) return;
  draining = true;
  try {
    await sendQueued();
  } finally {
    draining = false;
  }
}

async function sendQueued() {
  const { messages = [] } = await call('outbox', { limit: 10 });
  if (!messages.length) return;
  const results = [];
  for (const m of messages) {
    try {
      const options = m.quoted_wa_id
        ? { quoted: { key: { remoteJid: m.jid, id: m.quoted_wa_id, fromMe: !!m.quoted_from_me }, message: { conversation: m.quoted_body || '' } } }
        : {};
      await sock.presenceSubscribe(m.jid).catch(() => undefined);
      await sock.sendPresenceUpdate('composing', m.jid).catch(() => undefined);
      await pause(600 + Math.min(2500, m.body.length * 25));
      const sent = await sock.sendMessage(m.jid, { text: m.body }, options);
      await sock.sendPresenceUpdate('paused', m.jid).catch(() => undefined);
      sentByUs.add(sent.key.id);
      if (sentByUs.size > 5000) sentByUs.clear();
      results.push({ id: m.id, wa_id: sent.key.id, ok: true });
    } catch (e) {
      results.push({ id: m.id, ok: false, error: e.message });
    }
    await pause(400 + Math.random() * 600);
  }
  await call('sent', { results });
}

// Every couple of seconds: send queued replies. Every 30s: heartbeat, and
// unlink if the team pressed "Unlink" in the inbox.
setInterval(() => drainOutbox().catch((e) => log.warn({ err: e.message }, 'outbox')), 2500);
setInterval(async () => {
  const res = await report(current.status, current.extra);
  if (res.logout_requested && sock) {
    log.warn('Unlink requested from the inbox');
    await sock.logout().catch(() => undefined);
  }
}, 30_000);

async function shutdown() {
  await report('offline');
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);
// The desktop app asks this way (Windows has no signals to send).
process.on('message', (m) => { if (m && m.type === 'shutdown') shutdown(); });

// A stray rejection from the WhatsApp library mustn't take the link down.
process.on('unhandledRejection', (e) => log.error({ err: e?.message || String(e) }, 'unhandled rejection'));
// Anything worse: exit, and let whatever runs this (the desktop app, Docker) start it again.
process.on('uncaughtException', (e) => {
  log.fatal({ err: e?.message || String(e) }, 'crashed — exiting to be restarted');
  process.exit(1);
});

start().catch((e) => {
  log.error({ err: e.message }, 'start failed');
  restart(10_000);
});
