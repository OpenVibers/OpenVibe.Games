# Windows DLL workflow bootstrap

The Windows GitHub Actions runner does not have the local `engine/source-sdk-2013` checkout that exists on the Linux workstation.

The workflow now bootstraps Valve's Source SDK 2013 multiplayer tree into:

```text
engine/source-sdk-2013
```

Then it applies the OpenVibe SDK patch, skips the Linux QuickJS static-library build, builds QuickJS with MSVC, generates Visual Studio projects, builds `client.dll/server.dll`, and only uploads DLLs when `client.dll` contains OpenVibe command strings such as `ov_join`, `ov_menu`, or `OpenVibe`.

Use:

```bash
tools/gh-windows-build-and-install.sh
```

or debug the latest run with:

```bash
tools/windows-workflow-debug-and-install.sh
```
