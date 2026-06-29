# Windows VPC direct project build

Valve's `createallprojects.bat` runs VPC and is expected to emit `everything.sln`, but on the hosted runner VPC logged an extensionless `everything` solution while still generating the actual HL2MP `.vcxproj` files.

The Windows build now treats the solution as optional and builds the generated HL2MP client/server projects directly:

- `client*_hl2mp*.vcxproj`
- `server*_hl2mp*.vcxproj`

It also records generated projects and DLL locations in `artifacts/windows-build-debug`.
