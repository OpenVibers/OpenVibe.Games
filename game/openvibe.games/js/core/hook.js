(function () {
  const buckets = Object.create(null);

  function ensure(name) {
    name = String(name || "");
    if (!buckets[name]) buckets[name] = [];
    return buckets[name];
  }

  function logError(name, id, err) {
    const message = err && err.stack ? err.stack : String(err);
    if (globalThis.OV && typeof OV.error === "function") {
      OV.error(`hook ${name}/${id}: ${message}`);
    } else {
      console.error(`hook ${name}/${id}: ${message}`);
    }
  }

  function add(name, id, fn) {
      if (!name || !id || typeof fn !== "function") {
        throw new Error("hook.add(name, id, fn) requires a hook name, id, and function");
      }

      const list = ensure(name);
      const sid = String(id);
      for (let i = list.length - 1; i >= 0; --i) {
        if (list[i].id === sid) list.splice(i, 1);
      }
      list.push({ id: sid, fn });
  }

  function remove(name, id) {
      const list = buckets[String(name || "")];
      if (!list) return;
      const sid = String(id || "");
      for (let i = list.length - 1; i >= 0; --i) {
        if (list[i].id === sid) list.splice(i, 1);
      }
  }

  function call(name, gm, ...args) {
      const list = buckets[String(name || "")];
      if (list) {
        const snapshot = list.slice();
        for (const item of snapshot) {
          try {
            const result = item.fn(...args);
            if (result !== undefined) return result;
          } catch (err) {
            logError(name, item.id, err);
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

  function list(name) {
      if (name) return (buckets[String(name)] || []).map((item) => item.id);
      const out = Object.create(null);
      for (const key of Object.keys(buckets)) out[key] = buckets[key].map((item) => item.id);
      return out;
  }

  globalThis.hook = {
    add,
    remove,
    run,
    call,
    list,

    Add: add,
    Remove: remove,
    Run: run,
    Call: call,
    GetTable: list
  };
})();
