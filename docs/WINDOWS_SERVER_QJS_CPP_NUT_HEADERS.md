# Windows server build: QuickJS C++ and vscript nut headers

The Windows HL2MP server build needs two extra fixes on hosted Actions runners:

- The Source SDK custom build step for `vscript_server.nut` can report success without producing `vscript_server_nut.h`, so the build script pre-generates `spawn_helper_nut.h` and `vscript_server_nut.h` with `devtools/bin/texttoarray.py`.
- QuickJS is compiled as C with `clang-cl`, but its header is also included from C++ server files. The script patches the SDK copy of `quickjs.h` so MSVC C++ can compile QuickJS value macros without C compound literals/designated initializers.

The patch is applied only to the generated SDK copy under `engine/source-sdk-2013`, not to the vendored source files.
