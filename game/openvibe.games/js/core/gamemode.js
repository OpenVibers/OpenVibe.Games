// OpenVibe gamemode library — GMod gamemode.Register / DeriveGamemode /
// baseclass parity, layered on prototype inheritance.
// https://wiki.facepunch.com/gmod/Gamemode_Creation
(function () {
  let base = null;              // the "base" gamemode table
  let current = null;           // active GAMEMODE
  const registered = Object.create(null); // name -> gm table
  const baseclasses = Object.create(null); // "gamemode_<name>" -> table

  function publish(gm) {
    current = gm;
    globalThis.GM = gm;
    globalThis.GAMEMODE = gm;
    return gm;
  }

  function derive(gm, parent) {
    if (!gm || typeof gm !== "object") throw new Error("gamemode.derive(gm) requires an object");
    const prototype = parent || base || null;
    const out = prototype ? Object.create(prototype) : {};
    for (const key of Object.keys(gm)) out[key] = gm[key];
    return out;
  }

  // gamemode.Register(GM, name, derivedName) — wires inheritance, stores the
  // table under the name, publishes baseclass. Mirrors the engine step that
  // runs after gamemode files finish executing.
  function register(gm, name, derivedName) {
    if (!gm || typeof gm !== "object") throw new Error("gamemode.Register(gm, name) requires an object");
    name = String(name || gm.mode || gm.FolderName || "unnamed");

    let parent = null;
    if (derivedName && registered[derivedName]) parent = registered[derivedName];
    else if (derivedName === "base" || !derivedName) parent = base;

    const out = (parent && Object.getPrototypeOf(gm) !== parent) ? derive(gm, parent) : gm;
    out.FolderName = out.FolderName || name;
    out.DerivedFrom = derivedName || (parent === base && name !== "base" ? "base" : undefined);

    registered[name] = out;
    baseclasses["gamemode_" + name] = out;
    if (name === "base") base = out;
    return out;
  }

  function set(gm, options) {
    if (!gm || typeof gm !== "object") throw new Error("gamemode.set(gm) requires an object");
    const opts = options || {};
    if (!base || opts.base === true || gm.mode === "base") {
      base = register(gm, gm.mode || "base");
      return publish(base);
    }
    return publish(register(gm, gm.mode || gm.FolderName, gm.DerivedFrom || "base"));
  }

  function setBase(gm) {
    if (!gm || typeof gm !== "object") throw new Error("gamemode.setBase(gm) requires an object");
    base = register(gm, "base");
    if (!current) publish(base);
    return base;
  }

  function get() { return current; }
  function getBase() { return base; }
  function getRegistered(name) { return name ? registered[String(name)] || null : Object.keys(registered); }

  // gamemode.call — the C++ bridge entry point for every engine-fired hook.
  // Wraps native player handles into framework Player objects when the player
  // library is loaded, then dispatches through the hook library.
  function wrapArg(a) {
    if (a && typeof a === "object" && !a.__ovEntity &&
        typeof a.userId === "function" && globalThis.Player &&
        typeof Player.fromNative === "function") {
      try { return Player.fromNative(a); } catch { return a; }
    }
    return a;
  }

  function call(name, ...args) {
    const wrapped = args.map(wrapArg);
    return hook.call(name, current, ...wrapped);
  }

  globalThis.gamemode = {
    set, setBase, derive, get, getBase, call,
    register,

    Set: set,
    SetBase: setBase,
    Derive: derive,
    Get: get,
    GetBase: getBase,
    Call: call,
    Register: register,
    GetRegistered: getRegistered
  };

  // DeriveGamemode("name") — GMod global; records the parent for the gamemode
  // file currently executing. gamemode.set applies it via GM.DerivedFrom.
  globalThis.DeriveGamemode = function (parentName) {
    if (globalThis.GM && typeof GM === "object") GM.DerivedFrom = String(parentName);
    return parentName;
  };

  // baseclass library (https://wiki.facepunch.com/gmod/baseclass)
  globalThis.baseclass = {
    Set: function (name, tbl) { baseclasses[String(name)] = tbl; },
    Get: function (name) { return baseclasses[String(name)] || null; }
  };

  globalThis.GM = null;
  globalThis.GAMEMODE = null;
})();
