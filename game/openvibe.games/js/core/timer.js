(function () {
  const timers = Object.create(null);
  let nextAutoId = 1;

  function now() {
    if (globalThis.OV && typeof OV.time === "function") return Number(OV.time()) || 0;
    return Date.now() / 1000;
  }

  function create(id, delay, reps, fn) {
    if (!id) id = `timer_${nextAutoId++}`;
    if (typeof fn !== "function") throw new Error("timer.create requires a callback");

    delay = Math.max(0, Number(delay) || 0);
    reps = Number(reps);
    if (!Number.isFinite(reps)) reps = 1;

    timers[String(id)] = {
      id: String(id),
      delay,
      reps,
      count: 0,
      next: now() + delay,
      fn
    };

    return String(id);
  }

  function remove(id) {
    delete timers[String(id || "")];
  }

  function tick() {
    const t = now();
    for (const id of Object.keys(timers)) {
      const item = timers[id];
      if (!item || t < item.next) continue;

      item.count += 1;
      try {
        item.fn(item.count, id);
      } catch (err) {
        if (globalThis.OV && typeof OV.error === "function") OV.error(`timer ${id}: ${err && err.message ? err.message : err}`);
        delete timers[id];
        continue;
      }

      if (item.reps > 0 && item.count >= item.reps) {
        delete timers[id];
      } else {
        item.next = t + item.delay;
      }
    }
  }

  globalThis.timer = {
    create,
    remove,
    exists(id) {
      return !!timers[String(id || "")];
    },
    simple(delay, fn) {
      return create(`simple_${nextAutoId++}`, delay, 1, fn);
    },
    tick,
    list() {
      return Object.keys(timers).sort();
    },

    // GMod-style aliases (https://wiki.facepunch.com/gmod/timer)
    Create(id, delay, reps, fn) {
      return create(id, delay, reps, fn);
    },
    Simple(delay, fn) {
      return create(`simple_${nextAutoId++}`, delay, 1, fn);
    },
    Remove(id) {
      return remove(id);
    },
    Exists(id) {
      return !!timers[String(id || "")];
    },
    Adjust(id, delay, reps, fn) {
      const item = timers[String(id || "")];
      if (!item) return false;
      if (delay !== undefined && delay !== null) item.delay = Math.max(0, Number(delay) || 0);
      if (reps !== undefined && reps !== null) item.reps = Number(reps) || 0;
      if (typeof fn === "function") item.fn = fn;
      item.next = now() + item.delay;
      return true;
    }
  };

  hook.add("Think", "OpenVibeTimerThink", tick);
})();
