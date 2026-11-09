# homebridge-control4-local

Expose a [Control4](https://www.control4.com/) system to Apple HomeKit through
[Homebridge](https://homebridge.io/).

The plugin uses your Control4 account only to obtain a short-lived Director
token, then talks to your controller **locally over your LAN** via its Director
REST API (`https://<controller>/api/v1/...`). No cloud round-trip is needed for
day-to-day control, and nothing is installed on the controller itself.

## Features

- **Lights** — dimmers and switches; dimmable lights fade smoothly (configurable ramp).
- **Color temperature + Adaptive Lighting** — on lights that report CCT support (e.g. Hue).
- **Locks** — Control4 door locks as HomeKit locks.
- **Cameras** — live streaming plus **HomeKit Secure Video** (motion-triggered recording).
  Stream details are resolved from the Director over the token — no DVR login needed.
- **Rooms as Televisions** — power / volume / mute / input from the room's own Control4 state,
  so it works for IR- and IP-controlled TVs alike. Inputs are exactly the sources the
  Navigator shows for that room (plus "Control4" where the room has an on-screen navigator).
- **Volume tiles** — a volume slider per room with a TV.
- **Lighting scenes** — Control4 Advanced Lighting scenes as HomeKit switches.
- **Live sync** — devices added / removed / renamed in Control4 appear in HomeKit
  automatically (periodic re-discovery), no restart needed.

Tested against Control4 OS 3.x.

## How it works

```
 Apple Home  ──HAP──▶  Homebridge + this plugin  ──HTTPS (LAN)──▶  Control4 Director
                                   │
                                   └── Control4 cloud (once, for a 24h token)
```

- **Auth** (`src/control4/account.ts`): account email + password → account token →
  per-controller Director token (valid ~24 h, refreshed automatically).
- **Local control** (`src/control4/director.ts`): list items, read variables, and
  send commands straight to the controller. The controller's self-signed
  certificate means TLS verification is disabled for that one host.

## Install

1. Install [Homebridge](https://github.com/homebridge/homebridge/wiki).
2. Install this plugin (from the Homebridge UI, search "Control4", or):
   ```
   npm install -g homebridge-control4-local
   ```
3. Configure it in the Homebridge UI, or add a platform block to `config.json`:
   ```json
   {
     "platform": "Control4",
     "name": "Control4",
     "username": "you@example.com",
     "password": "••••••••",
     "controllerIp": "192.168.1.172"
   }
   ```

| Option | Required | Notes |
| --- | --- | --- |
| `username` / `password` | yes | Your Control4 account login. |
| `controllerIp` | recommended | Controller's LAN IP. |
| `controllerCommonName` | if >1 controller | e.g. `Home-EA1-000FFF…`. |
| `pollSeconds` | no | Backstop refresh (default 30). |
| `excludeRooms` | no | Rooms to hide from HomeKit. |

## Credentials & privacy

Your credentials are stored only in your own Homebridge instance and are sent
only to Control4's own servers to mint the Director token. All device traffic is
local.

## License

MIT
