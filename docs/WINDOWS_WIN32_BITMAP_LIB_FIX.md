# Windows Win32 bitmap.lib fix

The Win32/Proton DLL build converts VPC's generated win64 projects to Win32 before MSBuild.
After conversion, the HL2MP client links against `..\..\lib\public\bitmap.lib`.

This patch adds the generated bitmap project to the dependency build list and copies
`bitmap.lib` into the target public library directory before building `client.dll`.
