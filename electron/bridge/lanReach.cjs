// Making sure guard phones can reach this PC over the estate network, whether
// the PC is on a cable or on Wi-Fi.
//
// Three things break Wi-Fi in practice, and this module handles the two a PC
// can fix itself:
//   1. Addresses: laptops carry virtual adapters (Hyper-V, VirtualBox, VPNs,
//      Bluetooth) whose addresses phones can never reach. We announce the real
//      Wi-Fi / Ethernet address first so phones don't time out on the rest.
//   2. Windows Firewall: Wi-Fi networks are often marked "Public", which
//      blocks port 8787, and a "Cancel" on Windows' first-run prompt leaves a
//      Block rule that beats any Allow rule. allowGuardPhones() fixes both with
//      one admin prompt, and stops Windows powering the Wi-Fi adapter down.
// The third — a router with "AP / client isolation" on (common on guest
// Wi-Fi) — can only be fixed on the router; the UI explains it.
const os = require('os');
const { execFile } = require('child_process');

const PORT = 8787;
const RULE_NAME = 'VillaSafeGateBridgeLAN';
// The firewall cmdlets take 10–20 s on a PC with a few hundred rules; the
// HNetCfg.FwPolicy2 COM object reads the same rules in about 2 s.
const PS_BLOCK_RULES = "@($fw.Rules | Where-Object { $_.Direction -eq 1 -and $_.Action -eq 0 -and $_.Enabled -and $_.ApplicationName -ieq $exe })";
const PRIVATE_RANGES = '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16';

const VIRTUAL = /vethernet|hyper-v|virtualbox|vmware|vmnet|docker|wsl|loopback|pseudo|tap|tun|vpn|wireguard|tailscale|zerotier|hamachi|npcap|teredo|isatap/i;
const BLUETOOTH = /bluetooth/i;
const WIFI = /wi-?fi|wlan|wireless|802\.11/i;
const ETHERNET = /ethernet|^eth|^en[ops]?\d|local area connection/i;

const isPrivate = (ip) => /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);

/**
 * IPv4 addresses phones might reach, best first: Wi-Fi and Ethernet on private
 * ranges, then anything else, then virtual adapters. Link-local (169.254.x,
 * no DHCP) and Bluetooth addresses are dropped — no phone can use them.
 */
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || a.address.startsWith('169.254.') || BLUETOOTH.test(name)) continue;
      const kind = VIRTUAL.test(name) ? 'virtual' : WIFI.test(name) ? 'wifi' : ETHERNET.test(name) ? 'ethernet' : 'other';
      const rank = (kind === 'virtual' ? 20 : kind === 'other' ? 10 : 0) + (isPrivate(a.address) ? 0 : 5);
      out.push({ address: a.address, iface: name, kind, rank });
    }
  }
  return out.sort((x, y) => x.rank - y.rank || x.address.localeCompare(y.address))
    .map(({ rank, ...rest }) => rest);
}

// ---------------------------------------------------------------------------
// Windows Firewall

function powershell(script, timeout = 20000) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout, windowsHide: true },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), code: err?.code }));
  });
}

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

let cached = null;
let cachedAt = 0;

/**
 * { supported, state: 'ok' | 'blocked' | 'unknown', profiles, ruleEnabled, blockRules }
 * "unknown" means a private network with no rule of ours — it probably works
 * through Windows' own first-run prompt, but we can't be sure.
 */
async function firewallStatus({ fresh = false } = {}) {
  if (process.platform !== 'win32') return { supported: false, state: 'ok' };
  if (!fresh && cached && Date.now() - cachedAt < 120_000) return cached;
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$exe = ${psQuote(process.execPath)}
$fw = New-Object -ComObject HNetCfg.FwPolicy2
$profiles = @(Get-NetConnectionProfile | ForEach-Object { @{ alias = [string]$_.InterfaceAlias; category = [string]$_.NetworkCategory } })
$ours = @($fw.Rules | Where-Object { $_.Grouping -eq ${psQuote(RULE_NAME)} -and $_.Enabled })
$blocks = ${PS_BLOCK_RULES}.Count
@{ profiles = $profiles; ruleEnabled = ($ours.Count -gt 0); blockRules = $blocks } | ConvertTo-Json -Compress -Depth 4`;
  const r = await powershell(script);
  let data = null;
  try { data = JSON.parse(r.stdout.trim().split(/\r?\n/).pop()); } catch { /* fall through */ }
  if (!data) return { supported: true, state: 'unknown', error: (r.stderr || 'could not read firewall').slice(0, 200) };
  const profiles = Array.isArray(data.profiles) ? data.profiles : data.profiles ? [data.profiles] : [];
  const anyPublic = profiles.some((p) => /public/i.test(p.category));
  const state = data.blockRules > 0 ? 'blocked'
    : data.ruleEnabled ? 'ok'
    : anyPublic ? 'blocked'
    : 'unknown';
  cached = { supported: true, state, profiles, ruleEnabled: !!data.ruleEnabled, blockRules: data.blockRules || 0 };
  cachedAt = Date.now();
  return cached;
}

/**
 * One admin prompt (UAC) that lets guard phones in on any network profile:
 * drops Block rules Windows made for this app, adds an Allow rule for TCP 8787
 * from private addresses only, and stops Windows turning the Wi-Fi adapter off
 * to save power.
 */
async function allowGuardPhones() {
  if (process.platform !== 'win32') return { ok: true, status: await firewallStatus() };
  const inner = `
try {
  $exe = ${psQuote(process.execPath)}
  $fw = New-Object -ComObject HNetCfg.FwPolicy2
  # Block rules Windows made for this app when its first-run prompt was
  # cancelled. They share a name with the Allow rules, so switch them off
  # rather than removing by name.
  foreach ($r in ${PS_BLOCK_RULES}) { $r.Enabled = $false }
  foreach ($r in @($fw.Rules | Where-Object { $_.Grouping -eq ${psQuote(RULE_NAME)} })) { $fw.Rules.Remove($r.Name) }
  $rule = New-Object -ComObject HNetCfg.FWRule
  $rule.Name = 'VillaSafe Gate Bridge (guard phones)'
  $rule.Grouping = ${psQuote(RULE_NAME)}
  $rule.Description = 'Lets VillaSafe guard phones on the estate network scan through this gate PC.'
  $rule.Protocol = 6
  $rule.LocalPorts = '${PORT}'
  $rule.RemoteAddresses = '${PRIVATE_RANGES}'
  $rule.Direction = 1
  $rule.Action = 1
  $rule.Profiles = 0x7FFFFFFF
  $rule.Enabled = $true
  $fw.Rules.Add($rule)
  # Best effort: some Wi-Fi drivers don't expose power management.
  try {
    Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object { $_.NdisPhysicalMedium -eq 9 } |
      ForEach-Object { Disable-NetAdapterPowerManagement -Name $_.Name -NoRestart -ErrorAction SilentlyContinue }
  } catch { }
  exit 0
} catch { exit 1 }`;
  const encoded = Buffer.from(inner, 'utf16le').toString('base64');
  const outer = `
try {
  $p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}'
  exit $p.ExitCode
} catch { exit 5 }`;
  const r = await powershell(outer, 90_000);
  const status = await firewallStatus({ fresh: true });
  if (!r.ok && r.code === 5) return { ok: false, error: 'Windows did not allow the change (the admin prompt was cancelled).', status };
  if (!r.ok) return { ok: false, error: 'Windows could not update the firewall. Ask whoever manages this PC to allow TCP port 8787.', status };
  return { ok: status.state === 'ok', status, error: status.state === 'ok' ? null : 'The rule was added, but Windows still reports a block.' };
}

module.exports = { PORT, lanAddresses, firewallStatus, allowGuardPhones, _internal: { isPrivate } };
