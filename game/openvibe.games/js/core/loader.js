// OpenVibe loader — GMod Lua_Loading_Order equivalent for the js/ tree.
// https://wiki.facepunch.com/gmod/Lua_Loading_Order
//
// Per realm: autorun (shared, then realm dir; alphabetical) -> gamemode chain
// (base first, then the active mode: shared -> realm entry) -> scripted
// entities -> addons. Files are deduped, so hosts that pre-load gamemode
// files (the older embedded C++ path) can still call loadAll() safely.
//
// Also provides the console-exec entry points:
//   OVLoader.runString(code, id)   — js_run / js_run_cl
//   OVLoader.openScript(path)      — js_openscript / js_openscript_cl
(function () {
  if (globalThis.OVLoader && globalThis.OVLoader.__openvibe) return;

  var OV = globalThis.OV;
  var isServer = OV && OV.isServer ? !!OV.isServer() : true;
  var realmDir = isServer ? "server" : "client";
  var loadedFiles = Object.create(null); // path -> true

  function log(m) { if (OV && OV.log) OV.log("[loader] " + m); }
  function warn(m) { if (OV && OV.warn) OV.warn("[loader] " + m); }

  function execFile(path, force) {
    if (!force && loadedFiles[path]) return true;
    var code = OV.readFile(path);
    if (code == null) return false;
    loadedFiles[path] = true;
    var prev = globalThis.file ? file._getCurrent() : null;
    if (globalThis.file) file._setCurrent(path);
    try {
      (0, eval)(code + "\n//# sourceURL=" + path);
      return true;
    } catch (e) {
      warn("failed " + path + ": " + (e && e.stack ? e.stack : e));
      return false;
    } finally {
      if (globalThis.file) file._setCurrent(prev);
    }
  }

  function listSorted(dir, filterRx) {
    if (!OV || !OV.listDir) return [];
    var names = (OV.listDir(dir, "*") || []).slice();
    names.sort();
    return names.filter(function (n) { return filterRx.test(n); });
  }

  // ---- autorun (GMod lua/autorun parity) ----
  // Order: js/autorun/*.js (shared, like lua/autorun) -> js/autorun/shared/
  // (explicit alias, also both realms) -> js/autorun/<server|client>/
  // (realm-only). Alphabetical within each directory.
  function loadAutorun() {
    listSorted("js/autorun", /\.js$/).forEach(function (f) { execFile("js/autorun/" + f); });
    listSorted("js/autorun/shared", /\.js$/).forEach(function (f) { execFile("js/autorun/shared/" + f); });
    listSorted("js/autorun/" + realmDir, /\.js$/).forEach(function (f) { execFile("js/autorun/" + realmDir + "/" + f); });
  }

  // ---- gamemodes ----
  function readManifest(mode) {
    var p = "js/gamemodes/" + mode + "/manifest.json";
    if (!OV.fileExists(p)) return null;
    try { return JSON.parse(OV.readFile(p)); } catch (e) { warn("bad manifest for " + mode); return null; }
  }

  function loadGamemodeFiles(mode) {
    var dir = "js/gamemodes/" + mode;
    var sharedPath = dir + "/shared.js";
    var entryPath = dir + "/" + (isServer ? "server.js" : "client.js");
    if (OV.fileExists(sharedPath)) execFile(sharedPath);
    if (OV.fileExists(entryPath)) execFile(entryPath);
  }

  // Load a gamemode chain: recurse into the base first (GMod DeriveGamemode).
  function loadGamemodeChain(mode, seen) {
    seen = seen || {};
    if (seen[mode]) { warn("gamemode base cycle at '" + mode + "'"); return; }
    seen[mode] = true;
    var manifest = readManifest(mode);
    var baseName = manifest && manifest.base && manifest.base !== mode ? manifest.base : (mode !== "base" ? "base" : null);
    if (baseName) loadGamemodeChain(baseName, seen);
    loadGamemodeFiles(mode);
  }

  // ---- scripted entities ----
  function loadEntities(root) {
    root = root || "js/entities";
    var names = listSorted(root, /./);
    names.forEach(function (name) {
      if (name.charAt(0) === ".") return;
      var single = root + "/" + name;
      if (/\.js$/.test(name)) {
        // single-file SENT: runs in both realms; sets globalThis.ENT
        runEntityFile(name.replace(/\.js$/, ""), [single]);
        return;
      }
      // folder form: shared.js always; init.js server; cl_init.js client
      var files = [];
      if (OV.fileExists(single + "/shared.js")) files.push(single + "/shared.js");
      var entry = single + "/" + (isServer ? "init.js" : "cl_init.js");
      if (OV.fileExists(entry)) files.push(entry);
      if (files.length) runEntityFile(name, files);
    });
  }

  function runEntityFile(className, files) {
    if (!globalThis.scripted_ents) return;
    var prevENT = globalThis.ENT;
    globalThis.ENT = { Type: "anim", Base: "base_anim", ClassName: className };
    try {
      files.forEach(function (f) { execFile(f); });
      if (globalThis.ENT && typeof globalThis.ENT === "object") {
        scripted_ents.Register(globalThis.ENT, className);
      }
    } finally {
      globalThis.ENT = prevENT;
    }
  }

  // ---- scripted weapons (GMod SWEP tree: js/weapons/<class>/) ----
  function loadWeapons(root) {
    if (!globalThis.scripted_weapons) return;
    root = root || "js/weapons";
    listSorted(root, /./).forEach(function (name) {
      if (name.charAt(0) === ".") return;
      var single = root + "/" + name;
      if (/\.js$/.test(name)) { runWeaponFile(name.replace(/\.js$/, ""), [single]); return; }
      var files = [];
      if (OV.fileExists(single + "/shared.js")) files.push(single + "/shared.js");
      var entry = single + "/" + (isServer ? "init.js" : "cl_init.js");
      if (OV.fileExists(entry)) files.push(entry);
      if (files.length) runWeaponFile(name, files);
    });
  }

  function runWeaponFile(className, files) {
    var prevSWEP = globalThis.SWEP;
    globalThis.SWEP = { Base: "weapon_base", ClassName: className, Primary: {}, Secondary: {} };
    try {
      files.forEach(function (f) { execFile(f); });
      if (globalThis.SWEP && typeof globalThis.SWEP === "object") {
        scripted_weapons.Register(globalThis.SWEP, className);
      }
    } finally {
      globalThis.SWEP = prevSWEP;
    }
  }

  // ---- cades (Devolved barricade registry: js/cades/*.js) ----
  function loadCades(root) {
    if (!globalThis.cades) return;
    root = root || "js/cades";
    listSorted(root, /\.js$/).forEach(function (name) {
      if (name.charAt(0) === ".") return;
      // Each file sets globalThis.CADE (or several CADEs) and/or calls cades.Register.
      var prevCADE = globalThis.CADE;
      globalThis.CADE = null;
      execFile(root + "/" + name);
      if (globalThis.CADE && typeof globalThis.CADE === "object") cades.Register(globalThis.CADE);
      globalThis.CADE = prevCADE;
    });
  }

  // ---- base scripted-entity classes (GMod engine bases) ----
  function registerBaseEntities() {
    if (!globalThis.scripted_ents) return;
    if (!scripted_ents.GetStored("base_entity")) scripted_ents.Register({ Type: "anim" }, "base_entity");
    if (!scripted_ents.GetStored("base_anim")) scripted_ents.Register({ Type: "anim", Base: "base_entity", AutomaticFrameAdvance: false }, "base_anim");
    if (!scripted_ents.GetStored("base_point")) scripted_ents.Register({ Type: "point", Base: "base_entity" }, "base_point");
    if (!scripted_ents.GetStored("base_brush")) scripted_ents.Register({ Type: "brush", Base: "base_entity" }, "base_brush");
    if (!scripted_ents.GetStored("base_gmodentity")) {
      scripted_ents.Register({
        Type: "anim", Base: "base_anim",
        SetPlayer: function (ply) { this.SetNWEntity("Founder", ply); },
        GetPlayer: function () { return this.GetNWEntity("Founder", globalThis.NULL); }
      }, "base_gmodentity");
    }
  }

  var OVLoader = {
    __openvibe: true,

    // Full realm load. opts: { mode, gamemodes: false to skip gamemode files }
    loadAll: function (opts) {
      opts = opts || {};
      var mode = opts.mode || (OV && OV.getMode ? OV.getMode() : "base");
      registerBaseEntities();
      loadAutorun();
      if (opts.gamemodes !== false) loadGamemodeChain(mode);
      loadEntities();
      loadWeapons();
      loadCades();
      if (globalThis.Addon && Addon.loadAll) Addon.loadAll();
      if (globalThis.weapons && weapons.ValidateBases) weapons.ValidateBases();
      // GM:OnGamemodeLoaded — everything (gamemode chain, entities, weapons,
      // addons) is loaded; fires before the engine's Initialize.
      if (opts.gamemodes !== false && globalThis.hook && typeof hook.Run === "function") {
        try { hook.Run("OnGamemodeLoaded"); } catch (e) { warn("OnGamemodeLoaded: " + (e && e.message)); }
      }
      log("realm load complete (mode=" + mode + ", realm=" + realmDir + ")");
      return true;
    },

    // js_run / js_run_cl
    runString: function (code, id) {
      try {
        var result = (0, eval)(String(code) + "\n//# sourceURL=" + (id || "js_run"));
        return { ok: true, result: result };
      } catch (e) {
        var msg = e && e.stack ? e.stack : String(e);
        if (OV && OV.error) OV.error("js_run: " + msg);
        return { ok: false, error: msg };
      }
    },

    // js_openscript / js_openscript_cl — path relative to js/ (GMod: lua/)
    openScript: function (path) {
      var resolved = globalThis.file ? file._resolve(path) : ("js/" + path);
      if (!resolved || !OV.fileExists(resolved)) {
        warn("js_openscript: no such script '" + path + "'");
        return false;
      }
      log("running script " + resolved);
      return execFile(resolved, true); // force: openscript always re-runs
    },

    reloadFile: function (path) {
      var resolved = globalThis.file ? file._resolve(path) : null;
      if (resolved) delete loadedFiles[resolved];
      return resolved ? execFile(resolved, true) : false;
    },

    loadedFiles: loadedFiles
  };

  globalThis.OVLoader = OVLoader;
  if (OV && OV.log) OV.log("loader ready (realm=" + realmDir + ")");
})();
