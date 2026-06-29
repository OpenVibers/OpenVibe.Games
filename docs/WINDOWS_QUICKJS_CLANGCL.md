# Windows QuickJS build uses clang-cl

QuickJS uses GNU/C99 compiler features that plain `cl.exe` does not parse cleanly, including GNU attributes, GCC/Clang builtins, and C initializer patterns. The Windows workflow now prefers `clang-cl.exe` for QuickJS only. `clang-cl` emits MSVC-compatible COFF `.obj` files, and `lib.exe` packs them into `libquickjs_openvibe.lib` for the regular Source SDK MSVC link.

The rest of the Source SDK build still uses the Visual Studio/MSBuild toolchain.
