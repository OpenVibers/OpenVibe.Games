# Windows server stub PCH order

Source SDK server projects compile with MSVC precompiled headers using `/Yu cbase.h`.
MSVC ignores/skips text before the configured PCH include, so the Windows server
QuickJS stub wrapper cannot put `#if ...` before `#include "cbase.h"`.

The stubbed OpenVibe server `.cpp` files must start with:

```cpp
#include "cbase.h"
// OPENVIBE_WINDOWS_SERVER_QUICKJS_STUB
#if defined(_WIN32) && defined(GAME_DLL) && !defined(OPENVIBE_WINDOWS_SERVER_REAL_QUICKJS)
```

The non-stub branch must not re-include `cbase.h` immediately after `#else`.
