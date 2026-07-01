# Windows server QuickJS stub build

The Windows GitHub Actions build is currently used to produce patched Windows
`client.dll` and `server.dll` artifacts for Proton/runtime validation.

The vendored QuickJS C runtime builds as a static library with `clang-cl`, but
including QuickJS's C-facing headers from MSVC C++ inside the Source SDK server
project still trips C++ parser issues around C compound literals and designated
initializers.

To keep the Windows DLL pipeline moving, the server build uses a Windows-only
`GAME_DLL` stub for the OpenVibe JS runtime. The stub preserves the public
OpenVibe server concommands and strings (`ov_js_status`, `ov_js_cmd`,
`ov_js_reload`, `ov_js_fire`, `OpenVibe`) so the produced DLL is patched and
usable for smoke tests. Native Linux builds can still use the real QuickJS path.

Define `OPENVIBE_WINDOWS_SERVER_REAL_QUICKJS` later when the QuickJS C++ header
compatibility work is complete.
