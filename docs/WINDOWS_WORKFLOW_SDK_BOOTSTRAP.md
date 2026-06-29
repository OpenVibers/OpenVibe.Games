# Windows Source SDK bootstrap

The Windows GitHub Actions runner is fresh and does not have Alex's local `engine/source-sdk-2013` checkout.

The workflow bootstraps Valve's public Source SDK 2013 repository into:

```text
engine/source-sdk-2013
```

The expected SDK layout is:

```text
engine/source-sdk-2013/src/game/client/hl2mp
engine/source-sdk-2013/src/game/server/hl2mp
```

The bootstrap intentionally downloads the default/master zip first:

```text
https://codeload.github.com/ValveSoftware/source-sdk-2013/zip/refs/heads/master
```

This avoids brittle branch assumptions and avoids GitHub Actions `git` auth/header issues. A git clone fallback is still present for debugging.
