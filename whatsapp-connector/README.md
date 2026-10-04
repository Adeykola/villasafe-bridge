# VillaSafe WhatsApp connector

Links VillaSafe's WhatsApp number to the communications inbox the same way
WhatsApp Web or WhatsApp Desktop does: you scan a QR code once from the
company phone, and from then on:

- messages people send to that number appear in **Inbox** in VillaSafe;
- replies the team types in the inbox are sent from that number, and can quote
  the message they answer;
- delivered / read ticks come back;
- replies typed on the phone itself are recorded too, marked "Sent from the
  phone", so the inbox always shows who answered.

It is a small Node program that has to stay running. Vercel and the VillaSafe
backend can't host it: they only run code for a few seconds per request, and
WhatsApp needs a connection that stays open.

> **Know the risk.** This uses WhatsApp's web protocol (via the open-source
> Baileys library), not Meta's official Business API, which goes against
> WhatsApp's terms. Numbers used this way are occasionally banned —
> especially when they message many people who haven't written first. Use a
> dedicated support number, reply to people rather than broadcasting, and keep
> volumes human.

## 1. Set the shared secret

Pick a long random value (for example `openssl rand -hex 32`) and add it in
Lovable → Cloud → Secrets as **`WHATSAPP_CONNECTOR_SECRET`**. The
`whatsapp-connector` edge function refuses any call without it.

## 2. Run the connector somewhere that's always on

**Easiest: the Windows app.** In VillaSafe, open **Platform overview →
WhatsApp connector** (super admin), press **Download for Windows**, install it
on a computer that stays on (no admin rights needed), then press **Copy setup
key** and paste the key into the app once. From then on it starts with
Windows, runs in the background (tray icon), restarts the connector if it ever
stops, and reconnects by itself after sleep or an internet drop. It runs while
someone is signed in to Windows; turn on automatic sign-in for a computer that
may restart unattended. The app's source is `app/`; installers are built by the
public `villasafe-bridge` repo when a `connector-vX.Y.Z` tag is pushed (bump
`WHATSAPP_CONNECTOR_VERSION` in `src/lib/whatsappConnector.ts` to match).

**Or on a server:**

Any of these work: Railway or Render (as a background worker), Fly.io, a small
VPS (Hetzner, Oracle Cloud free tier), or an office computer that stays on.

The WhatsApp login is saved in `AUTH_DIR`. Put it on persistent storage (a
volume), otherwise you'll need to scan the QR again after every restart.

**With Node 20+**

```bash
cd whatsapp-connector
cp .env.example .env      # then fill in CONNECTOR_SECRET
npm install
npm start
```

**With Docker**

```bash
docker build -t villasafe-whatsapp whatsapp-connector
docker run -d --restart unless-stopped \
  -e CONNECTOR_URL=https://mnrbxdpimeqtiwofjjri.supabase.co/functions/v1/whatsapp-connector \
  -e CONNECTOR_SECRET=your-secret \
  -v villasafe-whatsapp:/data \
  villasafe-whatsapp
```

On Railway/Render, deploy this folder with the Dockerfile, set the two
environment variables, and attach a volume at `/data`.

## 3. Link the number

Open VillaSafe → **Inbox** (communications team or super admin). Under
**WhatsApp** a QR code appears within a few seconds of the connector starting.
On the company phone: **WhatsApp → Settings → Linked devices → Link a device**,
and scan it. (The same QR is also printed in the connector's log.)

The phone needs to stay switched on and online now and then, exactly as with
WhatsApp Web; it doesn't need to be on the same network.

To unlink, press **Unlink** in the inbox, or remove "VillaSafe Inbox" under
Linked devices on the phone.

## What it ignores

Groups, status updates, channels and broadcasts. Photos, videos, voice notes
and documents show in the inbox as a label with their caption (for example
`[photo] gate receipt`); open the phone to see the file itself.
