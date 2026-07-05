// OpenVibe JS addon system — GMod-style addons for Source, in JavaScript.
//
// Discovers addons under addons/<name>/ and loads them through require() so an
// addon can pull in npm packages (js/node_modules or addons/node_modules) and
// its own relative files. Each addon may ship:
//     addons/<name>/addon.json   { "name", "entry": { "shared","server","client" } }
//     addons/<name>/shared.js    loaded in both realms first
//     addons/<name>/server.js    loaded only on the server realm
//     addons/<name>/client.js    loaded only on the client realm
//
// Realm is decided by OV.isServer(). Loading is idempotent per realm.
(function () {
  if (globalThis.Addon && globalThis.Addon.__openvibe) return;

  var OV = globalThis.OV;
  var require = globalThis.require;

  function log(m) { if (OV && OV.log) OV.log("[addon] " + m); }
  function warn(m) { if (OV && OV.warn) OV.warn("[addon] " + m); }

  var loaded = Object.create(null); // path -> true

  // path is a mod-root-relative file path (no leading slash), e.g.
  // "addons/foo/server.js" — the file bridge is mod-sandboxed and rejects
  // leading-slash/parent paths, so we keep specifiers slash-free and load
  // them via require.load (mod-root loader).
  function tryRequire(path, label) {
    if (loaded[path]) return true;
    if (!OV.fileExists(path)) return false;
    try {
      require.load(path);
      loaded[path] = true;
      log(label + " -> " + path);
      return true;
    } catch (e) {
      warn("failed " + path + ": " + (e && e.message ? e.message : e));
      return false;
    }
  }

  var announced = Object.create(null); // addon dir name -> logged once

  function loadOne(name, isServer) {
    var dir = "addons/" + name;
    var manifestPath = dir + "/addon.json";
    var entry = { shared: "shared.js", server: "server.js", client: "client.js" };

    if (OV.fileExists(manifestPath)) {
      try {
        var m = JSON.parse(OV.readFile(manifestPath));
        if (m && m.entry) {
          entry.shared = m.entry.shared || entry.shared;
          entry.server = m.entry.server || entry.server;
          entry.client = m.entry.client || entry.client;
        }
        if (!announced[name]) {
          announced[name] = true;
          log("addon '" + (m && m.name ? m.name : name) + "'");
        }
      } catch (e) {
        warn("bad addon.json in " + name + ": " + (e && e.message));
      }
    }

    tryRequire(dir + "/" + entry.shared, name + ":shared");
    if (isServer) tryRequire(dir + "/" + entry.server, name + ":server");
    else tryRequire(dir + "/" + entry.client, name + ":client");
  }

  var Addon = {
    __openvibe: true,
    list: function () {
      if (!OV || !OV.listDir) return [];
      return OV.listDir("addons", "*");
    },
    __scanned: false,
    loadAll: function () {
      if (!OV || !OV.listDir) { warn("file bridge unavailable"); return; }
      var isServer = OV.isServer ? OV.isServer() : true;
      var names = this.list();
      // Repeat scans (loader re-entry / hot-reload) are idempotent — log once.
      if (!this.__scanned) {
        this.__scanned = true;
        log("scanning " + names.length + " addon folder(s), realm=" + (isServer ? "server" : "client"));
      }
      for (var i = 0; i < names.length; i++) {
        // Skip node_modules and dotfiles.
        if (names[i] === "node_modules" || names[i].charAt(0) === ".") continue;
        loadOne(names[i], isServer);
      }
    }
  };

  globalThis.Addon = Addon;
  if (OV && OV.log) OV.log("addon system ready");
})();
