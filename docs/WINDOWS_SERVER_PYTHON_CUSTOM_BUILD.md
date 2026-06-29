# Windows server.vcxproj Python custom build fix

Valve Source SDK's generated server project uses custom build commands that run
`python` while converting `.nut` script resources into generated headers. On
GitHub-hosted Windows runners, `actions/setup-python` may succeed while the VPC
emitted MSBuild custom step still cannot resolve the literal `python` command.

The Windows build script now:

1. creates a deterministic `python.bat`/`python.cmd` shim;
2. prepends it to PATH;
3. rewrites generated `.vcxproj` custom build command bodies so `python ...`
   uses the absolute shim path.

This keeps the generated Source SDK tree disposable while making CI builds
reliable.
