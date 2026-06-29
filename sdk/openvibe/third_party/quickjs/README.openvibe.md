# QuickJS vendored for OpenVibe: Source

Vendored QuickJS core files for OpenVibe's embedded JavaScript runtime.

Excluded intentionally:
- qjs.c
- qjsc.c
- quickjs-libc.c
- quickjs-libc.h

Reason:
OpenVibe embeds QuickJS as a sandboxed script VM. Community scripts should not
receive raw std/os/filesystem/process APIs.
