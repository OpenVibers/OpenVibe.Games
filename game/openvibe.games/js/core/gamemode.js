(function () {
  let base = null;
  let current = null;

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

  function set(gm, options) {
    if (!gm || typeof gm !== "object") throw new Error("gamemode.set(gm) requires an object");

    const opts = options || {};
    if (!base || opts.base === true || gm.mode === "base") {
      base = gm;
      return publish(gm);
    }

    return publish(derive(gm, base));
  }

  function setBase(gm) {
    if (!gm || typeof gm !== "object") throw new Error("gamemode.setBase(gm) requires an object");
    base = gm;
    if (!current) publish(gm);
    return gm;
  }

  function get() {
      return current;
  }

  function getBase() {
    return base;
  }

  function call(name, ...args) {
    return hook.call(name, current, ...args);
  }

  globalThis.gamemode = {
    set,
    setBase,
    derive,
    get,
    getBase,
    call,

    Set: set,
    SetBase: setBase,
    Derive: derive,
    Get: get,
    GetBase: getBase,
    Call: call
  };

  globalThis.GM = null;
  globalThis.GAMEMODE = null;
})();
