// OpenVibe JS module system — CommonJS require() over the OV.readFile bridge.
//
// Gives the embedded QuickJS runtime a Node-style require() with:
//   - relative resolution ("./x", "../x")
//   - bare-specifier resolution via node_modules (npm packages)
//   - extensions: exact, .js, .json, /index.js, package.json "main"
//   - a module cache (require twice -> same exports)
//   - hotloading (require.reload(id) drops the cache entry and re-evaluates)
//
// Everything is read through OV.readFile (mod-sandboxed), so only pure-JS
// packages work — there is no Node native-addon or node: builtin support in
// QuickJS. Safe browser/node-agnostic npm packages run fine.
(function () {
  if (globalThis.require && globalThis.require.__openvibe) return;
  // In the Node runtime a real native require is already provided (with .load/
  // .reload for the addon loader). Defer to it so npm packages resolve through
  // Node — full ecosystem incl. native modules — instead of this OV.readFile
  // reimplementation (which the embedded QuickJS build needs).
  if (globalThis.require && globalThis.require.__ovNodeNative) {
    if (globalThis.OV && globalThis.OV.log) globalThis.OV.log("module system: using native Node require");
    return;
  }

  var OV = globalThis.OV;
  function readFile(p) { return OV && OV.readFile ? OV.readFile(p) : null; }
  function fileExists(p) { return OV && OV.fileExists ? OV.fileExists(p) : false; }

  // Roots searched for bare specifiers (npm-style). Mod-relative.
  var NODE_MODULES_ROOTS = ["js/node_modules", "addons/node_modules"];

  var cache = Object.create(null);

  function dirname(p) {
    var i = p.lastIndexOf("/");
    return i <= 0 ? "" : p.slice(0, i);
  }
  function join(a, b) {
    if (!a) return b;
    if (b.charAt(0) === "/") b = b.slice(1);
    return a.replace(/\/+$/, "") + "/" + b;
  }
  // Collapse "a/./b" and "a/../b" without touching the filesystem.
  function normalize(p) {
    var parts = p.split("/");
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var s = parts[i];
      if (s === "" || s === ".") continue;
      if (s === "..") { out.pop(); continue; }
      out.push(s);
    }
    return out.join("/");
  }

  function tryFile(p) { return p && fileExists(p) ? p : null; }

  function hasExtension(p) {
    var slash = p.lastIndexOf("/");
    return p.slice(slash + 1).indexOf(".") >= 0;
  }

  // Resolve a base path to a concrete file. The exact path is only accepted when
  // it carries an extension — otherwise "foo" (a directory) would be mistaken for
  // a file, since fileExists() can be true for directories. Extension-less
  // specifiers fall through to .js/.json and then directory resolution.
  function resolveAsFile(p) {
    if (hasExtension(p) && tryFile(p)) return p;
    return tryFile(p + ".js") || tryFile(p + ".json") || null;
  }

  function resolveAsDirectory(p) {
    var pkgPath = join(p, "package.json");
    if (fileExists(pkgPath)) {
      try {
        var pkg = JSON.parse(readFile(pkgPath));
        var main = pkg && (pkg.main || (pkg.exports && (typeof pkg.exports === "string" ? pkg.exports : pkg.exports["."])));
        if (main) {
          var mainPath = normalize(join(p, main));
          var r = resolveAsFile(mainPath) || resolveAsFile(join(mainPath, "index"));
          if (r) return r;
        }
      } catch (e) { /* fall through to index */ }
    }
    return resolveAsFile(join(p, "index"));
  }

  function resolveBare(name) {
    // name may be "pkg" or "pkg/sub/path"
    for (var i = 0; i < NODE_MODULES_ROOTS.length; i++) {
      var base = join(NODE_MODULES_ROOTS[i], name);
      var r = resolveAsFile(base) || resolveAsDirectory(base);
      if (r) return r;
    }
    return null;
  }

  function resolve(request, fromDir) {
    if (request.charAt(0) === ".") {
      var abs = normalize(join(fromDir || "js", request));
      return resolveAsFile(abs) || resolveAsDirectory(abs);
    }
    if (request.charAt(0) === "/") {
      var absr = normalize(request);
      return resolveAsFile(absr) || resolveAsDirectory(absr);
    }
    return resolveBare(request);
  }

  function loadModule(filename, parentRequire) {
    if (cache[filename]) return cache[filename].exports;

    var module = { id: filename, exports: {}, loaded: false, filename: filename };
    cache[filename] = module;

    var code = readFile(filename);
    if (code == null) {
      delete cache[filename];
      throw new Error("Cannot read module file: " + filename);
    }

    if (/\.json$/.test(filename)) {
      module.exports = JSON.parse(code);
      module.loaded = true;
      return module.exports;
    }

    var dir = dirname(filename);
    var localRequire = makeRequire(dir);

    // Wrap like Node's module wrapper so top-level var/const stay module-scoped.
    var wrapper;
    try {
      wrapper = new Function(
        "exports", "require", "module", "__filename", "__dirname",
        code + "\n//# sourceURL=" + filename
      );
    } catch (e) {
      delete cache[filename];
      throw new Error("Syntax error in " + filename + ": " + (e && e.message));
    }

    try {
      wrapper.call(module.exports, module.exports, localRequire, module, filename, dir);
    } catch (e) {
      delete cache[filename];
      throw e;
    }

    module.loaded = true;
    return module.exports;
  }

  function makeRequire(fromDir) {
    function req(request) {
      var filename = resolve(request, fromDir);
      if (!filename) throw new Error("Cannot find module '" + request + "' from '" + (fromDir || "js") + "'");
      return loadModule(filename, req);
    }
    req.resolve = function (request) { return resolve(request, fromDir); };
    // Load a file by mod-root-relative path (no ./ or node_modules semantics).
    // Used by the addon loader, which knows exact mod-relative file paths.
    req.load = function (modPath) {
      var norm = normalize(modPath);
      var filename = resolveAsFile(norm) || resolveAsDirectory(norm);
      if (!filename) throw new Error("Cannot find module file '" + modPath + "'");
      return loadModule(filename, req);
    };
    req.cache = cache;
    req.reload = function (request) {
      var filename = resolve(request, fromDir);
      if (filename && cache[filename]) delete cache[filename];
      return req(request);
    };
    req.__openvibe = true;
    return req;
  }

  // Global require resolves relative specifiers against "js/".
  globalThis.require = makeRequire("js");
  globalThis.module = { exports: {} };

  if (OV && OV.log) OV.log("module system ready (require/ npm node_modules)");
})();
