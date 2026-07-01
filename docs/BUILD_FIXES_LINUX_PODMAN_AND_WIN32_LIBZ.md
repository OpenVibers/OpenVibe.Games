# Linux podman wrapper + Win32 libz build fixes

This patch fixes two local build blockers:

1. `tools/build-sdk-linux.sh` no longer uses `exec ./buildallprojects`. It captures the exit status and treats the build as successful when Valve's podman wrapper emits post-build signal-forwarding noise after all required Linux64 outputs have already been produced.
2. `tools/build-sdk-windows.ps1` creates a tiny Win32 placeholder `libz.lib` in `engine/source-sdk-2013/src/lib/public` when targeting Proton/x86. Valve's public Source SDK checkout can generate an HL2MP Win32 client project that references `..\..\lib\public\libz.lib`, but that x86 library is not present in the checkout. The current OpenVibe HL2MP client path does not use zlib symbols; if future code does, link.exe will fail with unresolved externals and this placeholder must be replaced by a real zlib build.
