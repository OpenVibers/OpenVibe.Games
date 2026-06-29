# Windows Source SDK bootstrap

The GitHub Actions Windows runner does not have Alex's local `engine/source-sdk-2013` checkout. The workflow bootstraps it by cloning ValveSoftware/source-sdk-2013.

Important detail: the Source SDK 2013 multiplayer code is normally on the `mp` branch, not necessarily in a `mp/` directory on the default branch. The bootstrap script now supports both layouts:

- `source-sdk-2013` checked out directly on the `mp` branch, with `src/...` at repo root
- older/mirrored layout with `mp/src/...`

The workflow should not upload or install stock/stale DLLs. A DLL artifact is considered useful only when `client.dll` contains OpenVibe command strings such as `ov_join`, `ov_menu`, or `OpenVibe`.
