// OpenVibe hook library — GMod hook semantics.
// https://wiki.facepunch.com/gmod/Hook_Library_Usage
//
// - hook.Add(event, id, fn): id is a string OR an object with IsValid();
//   re-adding with the same (event, id) replaces the hook.
// - Object identifiers: if !IsValid(id) at call time the hook is silently
//   removed; otherwise the identifier is prepended as the first argument.
// - hook.Call(event, gm, ...): registered hooks run first (insertion order);
//   the first hook returning anything other than undefined short-circuits
//   (false counts as a result); otherwise the gamemode method runs.
(function () {
  const buckets = Object.create(null); // event -> [{id, obj, fn}]

  function ensure(name) {
    name = String(name || "");
    if (!buckets[name]) buckets[name] = [];
    return buckets[name];
  }

  function logError(name, id, err) {
    const message = err && err.stack ? err.stack : String(err);
    const label = typeof id === "string" ? id : "<object>";
    if (globalThis.OV && typeof OV.error === "function") {
      OV.error(`hook ${name}/${label}: ${message}`);
    } else {
      console.error(`hook ${name}/${label}: ${message}`);
    }
  }

  function objValid(obj) {
    if (obj == null) return false;
    if (typeof obj.IsValid === "function") { try { return !!obj.IsValid(); } catch { return false; } }
    if (typeof obj.isValid === "function") { try { return !!obj.isValid(); } catch { return false; } }
    return true; // plain object without IsValid stays registered (GMod requires IsValid, we are lenient)
  }

  function add(name, id, fn) {
    if (!name || id == null || typeof fn !== "function") {
      throw new Error("hook.Add(name, id, fn) requires a hook name, id, and function");
    }
    const isObj = typeof id === "object" || typeof id === "function";
    if (!isObj && typeof id !== "string" && typeof id !== "number") {
      throw new Error("hook.Add identifier must be a string or an object with IsValid()");
    }
    const list = ensure(name);
    const key = isObj ? id : String(id);
    for (let i = list.length - 1; i >= 0; --i) {
      if (list[i].key === key) list.splice(i, 1);
    }
    list.push({ key, id: isObj ? "<object>" : String(id), obj: isObj ? id : null, fn });
  }

  function remove(name, id) {
    const list = buckets[String(name || "")];
    if (!list) return;
    const isObj = typeof id === "object" || typeof id === "function";
    const key = isObj ? id : String(id == null ? "" : id);
    for (let i = list.length - 1; i >= 0; --i) {
      if (list[i].key === key) list.splice(i, 1);
    }
  }

  function call(name, gm, ...args) {
    const list = buckets[String(name || "")];
    if (list && list.length) {
      const snapshot = list.slice();
      for (const item of snapshot) {
        if (item.obj) {
          if (!objValid(item.obj)) { remove(name, item.obj); continue; }
          try {
            const result = item.fn(item.obj, ...args);
            if (result !== undefined) return result;
          } catch (err) { logError(name, item.id, err); }
        } else {
          try {
            const result = item.fn(...args);
            if (result !== undefined) return result;
          } catch (err) { logError(name, item.id, err); }
        }
      }
    }

    if (gm && typeof gm[name] === "function") {
      return gm[name](...args);
    }
    return undefined;
  }

  function run(name, ...args) {
    const gm = globalThis.gamemode && typeof gamemode.get === "function"
      ? gamemode.get()
      : globalThis.GAMEMODE;
    return call(name, gm, ...args);
  }

  function getTable(name) {
    if (name) return (buckets[String(name)] || []).map((item) => item.id);
    const out = Object.create(null);
    for (const key of Object.keys(buckets)) out[key] = buckets[key].map((item) => item.id);
    return out;
  }

  globalThis.hook = {
    add, remove, run, call,
    list: getTable,

    Add: add,
    Remove: remove,
    Run: run,
    Call: call,
    GetTable: getTable
  };
})();
