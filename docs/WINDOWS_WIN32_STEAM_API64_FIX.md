# Windows Win32 steam_api64.lib compatibility fix

The Valve VPC generator can emit `client_win64_hl2mp.vcxproj` files that still reference
`steam_api64.lib` even after the OpenVibe workflow coerces those projects into Win32.

For Proton Source SDK Base 2013, the target process is 32-bit `hl2.exe`, so the workflow
must not link against an x64 Steam import library name. `tools/build-sdk-windows.ps1` now:

- rewrites `steam_api64.lib` references to `steam_api.lib` during Win32 project conversion;
- ensures `lib/public/steam_api.lib` exists before linking;
- creates an empty x86 compatibility archive only if Valve's SDK tree did not provide one.

The artifact verifier still rejects x64 PE32+ DLLs and still requires OpenVibe command strings.
