# OpenVibe: Source Implementation Summary

## Scope

This phase moved OpenVibe from VScript/backend prototype into a compiled Source SDK foundation:

- authenticated travel command
- custom VGUI menu command
- server-side join-token validation
- Prop Hunt disguise hook
- Fort Wars prop placement hook
- Steam Web API auth route
- Redis session support
- CDN asset manifest
- production infra templates
- SRCDS smoke-tested maps

## C++ GameDLL Patch

Tracked source files:

```text
sdk/openvibe/client/hl2mp/openvibe_client.cpp
sdk/openvibe/client/hl2mp/vgui_openvibe_menu.cpp
sdk/openvibe/server/hl2mp/openvibe_server.cpp
```

Apply/build tooling:

```text
tools/apply-openvibe-sdk.sh
tools/build-sdk-linux.sh
tools/setup-openvibe-bin.sh
```

The patch is copied into the ignored local Valve SDK checkout at `engine/source-sdk-2013/` and added to the HL2MP client/server VPC projects before building.

### Client Commands

| Command | Purpose |
| --- | --- |
| `ov_join <mode>` | Calls `/v1/travel/request`, stores join token, connects to returned server. |
| `ov_auth_steam` | Gets a Steam Web API ticket and posts to `/v1/auth/steam`. |
| `openvibe_menu` / `ov_menu` | Opens the OpenVibe VGUI hub selector. |
| `ov_open_url <url>` | Opens OpenVibe web pages such as auth/inventory. |

### Server Commands / Hooks

| Command / hook | Purpose |
| --- | --- |
| `ClientActive` hook | Reads `ov_join_token` and validates it against the backend. |
| `ov_prophunt_disguise <model>` | Applies an allowlisted Prop Hunt disguise model. |
| `ov_prophunt_reset_disguise` | Restores the normal player model. |
| `ov_fortwars_spawn <type>` | Spawns allowlisted physics props for Fort Wars build phase. |

## Backend Work

Implemented in `backend/src/`:

- `/v1/auth/steam` validates Steam Web API tickets when `STEAM_WEB_API_KEY` and `STEAM_APP_ID` are configured.
- Session tokens use Redis when `SESSION_REDIS_URL` is configured, otherwise local/dev behavior remains available.
- `/v1/assets/manifest` exposes CDN URLs for shop assets using `OPENVIBE_CDN_BASE_URL`.
- Travel, validation, rewards, shop, equip, leaderboard, and admin item flows are covered by tests.

Verification:

```text
npm run build
npm test
```

Current result: TypeScript build passes and 9 tests pass.

## Maps And SRCDS

The VMF generator now emits portal commands using `ov_join`:

```text
ov_join hub
ov_join prophunt
ov_join deathrun
ov_join fortwars
ov_join traitortown
```

Compiled and smoke-tested BSPs:

```text
game/openvibe.games/maps/ov_hub.bsp
game/openvibe.games/maps/ph_openvibe_dev.bsp
game/openvibe.games/maps/dr_openvibe_dev.bsp
game/openvibe.games/maps/fw_openvibe_dev.bsp
game/openvibe.games/maps/tt_openvibe_dev.bsp
```

SRCDS verification:

```bash
OPENVIBE_SRCDS_MAP_DELAY=3 OPENVIBE_SRCDS_SMOKE_TIMEOUT=45 tools/smoke-srcds.sh
```

Current result: all five maps reach server activation without fatal load errors or VScript startup errors.

## Infrastructure

Added or expanded:

```text
infra/docker-compose.yml
infra/cdn/nginx.conf
infra/production/docker-stack.yml
infra/kubernetes/openvibe.yaml
```

These provide the production shape for:

- API
- PostgreSQL
- Redis
- CDN/static assets
- Kubernetes services/ingress/secrets
- Docker Swarm deployment

## Remaining Work

This is a working local MVP foundation, not a finished public game. Production still needs:

- real Steam app credentials
- real hosted assets under `openvibe.games`
- production secrets and backups
- metrics/logging/alerts
- larger maps and polished assets
- completed game-mode rules
- moderation and anti-abuse controls
