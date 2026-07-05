// js/autorun/shared/ — runs on BOTH realms at load, like GMod's lua/autorun.
// (Top-level js/autorun/*.js files are shared too; this subfolder is the
// explicit variant.) Try it live from the console:
//   js_run print("hello from the server realm")
//   js_run_cl print("hello from the client realm")
//   js_openscript autorun/shared/example_hello.js      (re-runs this file)
//   js_openscript_cl autorun/shared/example_hello.js
print("[example] autorun/shared ran (SERVER=" + SERVER + ", CLIENT=" + CLIENT + ")");
