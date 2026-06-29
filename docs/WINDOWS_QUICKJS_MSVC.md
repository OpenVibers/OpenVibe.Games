# Windows QuickJS MSVC Build Note

The vendored QuickJS C source includes POSIX `<sys/time.h>`, which MSVC does not provide. The Windows QuickJS build helper now generates a tiny compatibility include directory at build time:

```text
engine/source-sdk-2013/src/game/shared/openvibe/third_party/quickjs/build/compat/include/sys/time.h
```

That shim defines `struct timeval` and `gettimeofday()` using `GetSystemTimeAsFileTime()`, then passes the compatibility include directory to `cl.exe` before compiling QuickJS.

This keeps Linux builds unchanged while allowing the Windows GitHub Actions runner to produce `libquickjs_openvibe.lib` for `client.dll` / `server.dll` builds.
