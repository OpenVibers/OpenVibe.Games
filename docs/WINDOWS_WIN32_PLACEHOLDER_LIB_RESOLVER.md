# Windows Win32 placeholder lib resolver

The Proton-compatible build targets 32-bit Source SDK Base 2013 Multiplayer. Current Valve VPC output may reference old Win32 `.lib` inputs that are not present in the public GitHub checkout.

The Windows build now performs three passes before linking HL2MP DLLs:

1. Build/copy real Source SDK dependency projects where possible.
2. Dynamically read `<AdditionalDependencies>` from selected client/server vcxproj files and copy any real matching libs found in the SDK tree.
3. For any remaining missing non-system `.lib` inputs, generate a tiny x86 placeholder archive with MSVC `cl.exe` + `lib.exe`.

This converts opaque one-at-a-time `LNK1181: cannot open input file` failures into a real linker result. If a missing library actually provides required symbols, the build will still fail with unresolved externals, which points at the real missing implementation instead of just the missing file.
