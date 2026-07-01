# Windows Win32 public client libs fix

The Proton-compatible Source SDK Base 2013 path needs 32-bit PE32 DLLs. After converting VPC's generated win64 project metadata to Win32, the HL2MP client link began looking in `src/lib/public` instead of `src/lib/public/x64`.

The previous fix added `bitmap.lib`; the next missing public lib was `choreoobjects.lib`.

This patch expands the Windows dependency build list to cover common Source SDK public static libraries used by the client:

- `bitmap.lib`
- `choreoobjects.lib`
- `tier1.lib`
- `tier2.lib`
- `mathlib.lib`
- `raytrace.lib`
- `dmxloader.lib`
- `dmserializers.lib`
- `datamodel.lib`
- `particles.lib`
- `appframework.lib`
- `vgui_controls.lib`
- `vgui_surfacelib.lib`
- `matsys_controls.lib`

It also audits `src/lib/public` before the client link so the next missing library is obvious from diagnostics.
