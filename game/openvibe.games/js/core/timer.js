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
    }
  };

  hook.add("Think", "OpenVibeTimerThink", tick);
})();
