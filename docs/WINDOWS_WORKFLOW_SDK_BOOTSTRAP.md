# Windows Source SDK bootstrap

The Windows DLL workflow uses a two-checkout model:

1. Checkout this OpenVibe repository.
2. Checkout `ValveSoftware/source-sdk-2013` into `_deps/source-sdk-2013-upstream`.
3. Normalize the Valve SDK layout into `engine/source-sdk-2013`.
4. Apply OpenVibe SDK patches.
5. Build `client.dll` and `server.dll` with MSBuild.

The bootstrap script accepts these upstream layouts:

- `_deps/source-sdk-2013-upstream/src/...`
- `_deps/source-sdk-2013-upstream/mp/src/...`
- `_deps/source-sdk-2013-upstream/sp/src/...`

Diagnostics are uploaded under the `openvibe-windows-build-debug` artifact.
