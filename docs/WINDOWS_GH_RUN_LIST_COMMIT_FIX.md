# Windows DLL workflow run lookup fix

GitHub CLI uses `gh run list --commit <sha>` to filter by commit. A previous helper accidentally used `gh run list sha <sha>`, which aborts after triggering the workflow. The Win32 DLL build can still be continued by finding the workflow run with `--commit`, downloading `openvibe-windows-dlls`, rejecting PE32+ x64 DLLs, and installing only PE32 x86 DLLs.
