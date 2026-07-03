// OpenVibe file library — AddCSLuaFile/include equivalents + client script sync.
// https://wiki.facepunch.com/gmod/Global.AddCSLuaFile
//
// AddCSJSFile(path?) marks a js/-relative file for download to clients
// (server-only effect). These paths are auto-networked without marking:
//   js/autorun/*.js, js/autorun/client/*.js,
//   js/gamemodes/*/{manifest.json,shared.js,client.js},
//   js/entities/** ,
//   addons/*/{shared.js,client.js} + addon autorun/entities
//
// Sync protocol (net messages, server->client unless noted):
//   __ovfs_manifest  [{p, h, s}]           full manifest {path, hash, size}
//   __ovfs_request   [paths] (client->server, rate limited)
//   __ovfs_data      path, content         one file (net library auto-chunks)
//   -> client caches under js/ov_downloads/<path> (OV.writeFile) and fires
//      the "OVFilesSynced" hook when the diff is satisfied.
(function () {
  if (globalThis.file && globalThis.file.__ovOpenvibe) return;

  var OV = globalThis.OV;
  var isServer = OV && OV.isServer ? !!OV.isServer() : true;

  var marked = Object.create(null);    // js-relative path -> true (explicit AddCSJSFile)
  var currentFile = null;              // set by the loader while a file executes

  function normalize(p) {
    var parts = String(p).replace(/\\/g, "/").split("/");
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var s = parts[i];
      if (s === "" || s === ".") continue;
      if (s === "..") { out.pop(); continue; }
      out.push(s);
    }
    return out.join("/");
  }

  function dirname(p) {
    var i = p.lastIndexOf("/");
    return i <= 0 ? "" : p.slice(0, i);
  }

  // Resolve a script path GMod-style: relative to js/ first, then relative to
  // the currently executing file's directory.
  function resolveScript(p) {
    p = normalize(p);
    var candidates = [];
    if (p.indexOf("js/") === 0 || p.indexOf("addons/") === 0) candidates.push(p);
    else {
      candidates.push("js/" + p);
      if (currentFile) candidates.push(normalize(dirname(currentFile) + "/" + p));
    }
    for (var i = 0; i < candidates.length; i++) {
      if (OV && OV.fileExists && OV.fileExists(candidates[i])) return candidates[i];
    }
    // client: fall back to the synced download cache
    if (!isServer) {
      for (var j = 0; j < candidates.length; j++) {
        var dl = "js/ov_downloads/" + candidates[j];
        if (OV && OV.fileExists && OV.fileExists(dl)) return dl;
      }
    }
    return null;
  }

  function readScript(p) {
    var full = resolveScript(p);
    return full ? { path: full, code: OV.readFile(full) } : null;
  }

  // ---- AddCSJSFile ----
  function addCSJSFile(p) {
    if (!isServer) return; // no-op on the client (safe in shared files)
    var path = p === undefined ? currentFile : resolveScript(p);
    if (!path && p !== undefined) path = normalize(String(p).indexOf("js/") === 0 ? String(p) : "js/" + String(p));
    if (path) marked[path] = true;
  }

  // ---- include ----
  function include(p) {
    var found = readScript(p);
    if (!found || found.code == null) {
      var msg = "include('" + p + "'): file doesn't exist";
      if (OV && OV.error) OV.error(msg); else throw new Error(msg);
      return undefined;
    }
    var prev = currentFile;
    currentFile = found.path;
    try {
      return (0, eval)(found.code + "\n//# sourceURL=" + found.path);
    } catch (e) {
      if (OV && OV.error) OV.error("include('" + p + "'): " + (e && e.stack ? e.stack : e));
      return undefined;
    } finally {
      currentFile = prev;
    }
  }

  // ---- auto-networked path discovery ----
  function listJs(dir) {
    if (!OV || !OV.listDir) return [];
    var names = OV.listDir(dir, "*") || [];
    return names.filter(function (n) { return /\.(js|json)$/.test(n); }).map(function (n) { return dir + "/" + n; });
  }

  function autoNetworkedFiles() {
    var out = [];
    out.push.apply(out, listJs("js/autorun"));
    out.push.apply(out, listJs("js/autorun/client"));
    var modes = (OV && OV.listDir ? OV.listDir("js/gamemodes", "*") : []) || [];
    modes.forEach(function (m) {
      if (m.charAt(0) === ".") return;
      ["manifest.json", "shared.js", "client.js"].forEach(function (f) {
        var p = "js/gamemodes/" + m + "/" + f;
        if (OV.fileExists(p)) out.push(p);
      });
    });
    var entities = (OV && OV.listDir ? OV.listDir("js/entities", "*") : []) || [];
    entities.forEach(function (e) {
      if (e.charAt(0) === ".") return;
      var single = "js/entities/" + e;
      if (/\.js$/.test(e) && OV.fileExists(single)) { out.push(single); return; }
      ["shared.js", "cl_init.js"].forEach(function (f) {
        var p = "js/entities/" + e + "/" + f;
        if (OV.fileExists(p)) out.push(p);
      });
    });
    var addons = (OV && OV.listDir ? OV.listDir("addons", "*") : []) || [];
    addons.forEach(function (a) {
      if (a === "node_modules" || a.charAt(0) === ".") return;
      ["shared.js", "client.js", "addon.json"].forEach(function (f) {
        var p = "addons/" + a + "/" + f;
        if (OV.fileExists(p)) out.push(p);
      });
    });
    return out;
  }

  function buildManifest() {
    var files = autoNetworkedFiles();
    for (var p in marked) if (files.indexOf(p) < 0) files.push(p);
    return files.map(function (p) {
      var code = OV.readFile(p);
      return { p: p, h: code != null && globalThis.util ? util.CRC(code) : "0", s: code ? code.length : 0 };
    }).filter(function (f) { return f.s > 0; });
  }

  var file = {
    __ovOpenvibe: true,
    Exists: function (p) { return !!resolveScript(p); },
    Read: function (p) { var f = readScript(p); return f ? f.code : null; },
    Write: function (p, content) {
      // Client-side cache writes only (download dir), mirroring GMod's data/ jail.
      if (OV && OV.writeFile) return OV.writeFile("js/ov_downloads/" + normalize(p), String(content));
      return false;
    },
    BuildClientManifest: buildManifest,
    _setCurrent: function (p) { currentFile = p ? normalize(p) : null; },
    _getCurrent: function () { return currentFile; },
    _resolve: resolveScript,
    _marked: marked
  };

  globalThis.file = file;
  globalThis.include = include;
  globalThis.AddCSJSFile = addCSJSFile;
  globalThis.AddCSLuaFile = addCSJSFile; // muscle-memory alias

  // ---- sync protocol ----
  function poolNames() {
    if (isServer && globalThis.util && util.AddNetworkString) {
      util.AddNetworkString("__ovfs_manifest");
      util.AddNetworkString("__ovfs_request");
      util.AddNetworkString("__ovfs_data");
    }
  }
  poolNames();

  if (globalThis.net && net.__openvibe) {
    if (isServer) {
      // Send the manifest shortly after a player finishes joining.
      if (globalThis.hook) {
        hook.Add("PlayerInitialSpawn", "OpenVibeFileSync", function (ply) {
          var send = function () {
            try {
              net.Start("__ovfs_manifest");
              net.WriteTable(buildManifest());
              net.Send(ply);
            } catch (e) { OV && OV.warn && OV.warn("file sync manifest: " + (e && e.message)); }
          };
          if (globalThis.timer && timer.simple) timer.simple(2, send); else send();
          return undefined;
        });
      }
      net.SetRateLimit("__ovfs_request", 10);
      net.Receive("__ovfs_request", function (len, ply) {
        if (!ply) return;
        var paths = net.ReadTable(true) || [];
        if (!Array.isArray(paths)) return;
        var manifest = buildManifest();
        var allowed = {};
        manifest.forEach(function (f) { allowed[f.p] = true; });
        paths.slice(0, 64).forEach(function (p) {
          p = normalize(String(p));
          if (!allowed[p]) return; // only networked files may be requested
          var code = OV.readFile(p);
          if (code == null) return;
          net.Start("__ovfs_data");
          net.WriteString(p);
          net.WriteString(code);
          net.Send(ply);
        });
      });
    } else {
      var pendingSync = null;
      net.Receive("__ovfs_manifest", function () {
        var manifest = net.ReadTable(true) || [];
        var missing = [];
        manifest.forEach(function (f) {
          var local = OV.readFile(f.p);
          var cached = OV.readFile("js/ov_downloads/" + f.p);
          var have = local != null ? util.CRC(local) : (cached != null ? util.CRC(cached) : null);
          if (have !== f.h) missing.push(f.p);
        });
        if (!missing.length) {
          if (globalThis.hook) hook.Run("OVFilesSynced", []);
          return;
        }
        pendingSync = { missing: {}, count: missing.length };
        missing.forEach(function (p) { pendingSync.missing[p] = true; });
        net.Start("__ovfs_request");
        net.WriteTable(missing, true);
        net.SendToServer();
      });
      net.Receive("__ovfs_data", function () {
        var p = net.ReadString();
        var content = net.ReadString();
        file.Write(p, content);
        if (pendingSync && pendingSync.missing[p]) {
          delete pendingSync.missing[p];
          pendingSync.count--;
          if (pendingSync.count <= 0) {
            pendingSync = null;
            if (globalThis.hook) hook.Run("OVFilesSynced", []);
          }
        }
      });
    }
  }

  if (OV && OV.log) OV.log("file library ready (AddCSJSFile/include)");
})();
