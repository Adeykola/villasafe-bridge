# Hikvision service REST API

Base URL: `http://127.0.0.1:8788/api` (loopback only; the Gate Bridge picks the first free port from 8788–8792).
Auth: `X-Bridge-Token` — minted fresh on every app launch and held by the desktop drivers; `BRIDGE_TOKEN` when run standalone.

## Health
`GET /health` → `{ ok, version, sdk, uptime }`

## Controllers
| Method | Path | Body / Query | Purpose |
| --- | --- | --- | --- |
| GET  | `/controller`                 | — | List controllers (no passwords) |
| POST | `/controller`                 | `{ id?, name, ip, sdkPort, username, password }` | Create / update |
| DELETE | `/controller/:id`           | — | Remove |
| POST | `/controller/:id/connect`     | — | Open SDK session |
| POST | `/controller/:id/disconnect`  | — | Close SDK session |
| POST | `/controller/:id/restart`     | — | Close + reopen session |
| GET  | `/controller/status`          | — | Live status for every open session |
| GET  | `/controller/:id/deviceInfo`  | — | Device info from the last login |

## Doors (single relay)
| POST | `/door/open`  | `{ controllerId, doorNo }` | Pulse relay open |
| POST | `/door/close` | `{ controllerId, doorNo }` | Pulse relay close |

## Lanes (barrier + spike + turnstile + loop)
| GET  | `/lane`               | — | List lanes |
| POST | `/lane`               | `{ id?, name, controllerId, doorNo, barrierEnabled, tyreSpikeEnabled, loopDetectorEnabled, rfidReaderEnabled, turnstileEnabled, entryDoorNo?, exitDoorNo? }` | Create / update |
| DELETE | `/lane/:id`         | — | Remove |
| POST | `/lane/:id/open`      | — | Run full open sequence |
| POST | `/lane/:id/close`     | — | Force-close (skips loop wait) |

## Diagnostics
`GET /diagnostics/run?controllerId=<id>&testDoorNo=<n>` runs ping → port 8000 →
SDK loaded → SDK login → optional relay test. Returns per-step `{ name, ok, detail, hint? }`.

## Logs
`GET /logs?limit=200&controllerId=&laneId=` returns the tail of the ring buffer.

## Wiring from the Lovable frontend

The React UI does not talk to this bridge directly — it goes through the
existing `bridge-probe-device` and `bridge-sync` edge functions. For lanes
whose driver is `hikvision`, those edge functions should call this bridge's
`/api/diagnostics/run` and `/api/lane/:id/open` instead of ISAPI. The
contracts (`{ ok, error, hint }`) are unchanged so `LaneWizard.tsx` needs no
changes.