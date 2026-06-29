# Windows Win32 VPC project conversion

Current Valve Source SDK 2013 VPC output on GitHub's Windows runner can still emit `*_win64_*.vcxproj` projects even when the build is relaunched through an x86 Visual Studio shell. For Proton compatibility with 32-bit Source SDK Base installs, the Windows build script converts generated vcxproj platform/config metadata to Win32 before MSBuild runs.

The conversion changes project configurations from x64/Win64 to Win32, switches the linker target to MachineX86, removes 64-bit preprocessor defines, adds COMPILER_MSVC32, points public library paths back to `lib/public`, and disables warning-as-error behavior for the modern VS2022 Win32 pass.
