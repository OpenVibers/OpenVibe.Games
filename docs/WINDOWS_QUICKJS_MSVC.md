# Windows QuickJS MSVC Build Note

The vendored QuickJS source is GCC/clang oriented. On Windows/MSVC it needs compatibility for:

- POSIX `sys/time.h`
- accidental `pthread.h` includes
- GNU `__attribute__((...))`
- GNU `__builtin_clz`, `__builtin_ctz`, and `__builtin_expect`

`tools/build-quickjs-lib-windows.ps1` now generates build-local compatibility headers under:

```text
engine/source-sdk-2013/src/game/shared/openvibe/third_party/quickjs/build/compat/include
```

It also force-includes `openvibe_qjs_msvc_compat.h` for every QuickJS source file and disables `CONFIG_ATOMICS` in the copied SDK-side `quickjs.c` before compiling. Linux builds are unchanged.
