# Windows Win32 tier0/vstdlib compatibility libs

The Windows VPC project generator can emit Win64-named project files and linker inputs even when the OpenVibe build is targeting Proton's 32-bit Source SDK Base `hl2.exe`.

The build converts the project platform to Win32, rewrites lingering 64-bit import-lib names to x86 names, and creates tiny x86 compatibility archives for linker input filenames that are referenced by VPC but missing from the modern Valve Source SDK checkout.

This is intentionally scoped to the CI Win32 build path. The artifact verifier still rejects PE32+ x64 DLLs and still requires OpenVibe command strings in the produced DLLs.
