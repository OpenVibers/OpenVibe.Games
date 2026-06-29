(function () {
  const commands = Object.create(null);

  function normalize(name) {
    return String(name || "").trim().replace(/^!+/, "").toLowerCase();
  }

  function split(text) {
    const raw = String(text || "").trim();
    if (!raw) return { name: "", args: [], raw: "" };
    const parts = raw.split(/\s+/g);
    const name = normalize(parts.shift());
    return { name, args: parts, raw };
  }

  function reply(ply, msg) {
    if (ply && typeof ply.chat === "function") ply.chat(String(msg));
    else if (globalThis.OV && typeof OV.broadcast === "function") OV.broadcast(String(msg));
    else if (globalThis.OV && typeof OV.log === "function") OV.log(String(msg));
  }

  function listNames() {
    return Object.keys(commands).sort();
  }

  globalThis.command = {
    add(name, helpOrFn, maybeFn) {
      const key = normalize(name);
      if (!key) throw new Error("command.add requires a command name");

      let help = "";
      let fn = helpOrFn;
      if (typeof helpOrFn === "string") {
        help = helpOrFn;
        fn = maybeFn;
      }

      if (typeof fn !== "function") throw new Error("command.add requires a function");
      commands[key] = { help, fn };
    },

    remove(name) {
      delete commands[normalize(name)];
    },

    has(name) {
      return !!commands[normalize(name)];
    },

    list: listNames,

    run(ply, text) {
      const parsed = split(text);
      if (!parsed.name) return undefined;

      const entry = commands[parsed.name];
      if (!entry) {
        reply(ply, `Unknown command: ${parsed.name}. Try !help`);
        return false;
      }

      const result = entry.fn({ ply, name: parsed.name, args: parsed.args, raw: parsed.raw, reply });
      return result === undefined ? false : result;
    },

    dispatchConsole(text) {
      return this.run(null, text);
    },

    Add(name, helpOrFn, maybeFn) {
      return this.add(name, helpOrFn, maybeFn);
    },

    Remove(name) {
      return this.remove(name);
    },

    Run(ply, text) {
      return this.run(ply, text);
    },

    List() {
      return this.list();
    }
  };

  globalThis.concommand = {
    Add(name, fn, help) {
      return command.add(name, help || "", function ({ args, raw, reply }) {
        return fn(args, raw, reply);
      });
    },

    Remove(name) {
      return command.remove(name);
    },

    Run(text) {
      return command.dispatchConsole(text);
    },

    List() {
      return command.list();
    }
  };

  hook.add("PlayerSay", "OpenVibeCommandRegistry", function (ply, text) {
    const msg = String(text || "").trim();
    if (!msg.startsWith("!")) return undefined;
    return command.run(ply, msg.slice(1));
  });

  hook.add("ConsoleCommand", "OpenVibeConsoleCommandRegistry", function (text) {
    return command.dispatchConsole(text);
  });

  command.add("help", "List OpenVibe JS commands", function ({ reply, ply }) {
    reply(ply, `Commands: ${listNames().map((name) => `!${name}`).join(", ")}`);
    return false;
  });

  command.add("smoke", "Run the embedded JS smoke test", function ({ reply, ply }) {
    reply(ply, "OpenVibe embedded JS smoke test passed.");
    return false;
  });

  command.add("timer_smoke", "Run the JS timer smoke test", function ({ reply, ply }) {
    reply(ply, "Timer smoke scheduled.");
    if (globalThis.timer && typeof timer.simple === "function") {
      timer.simple(0.05, function () {
        if (globalThis.OV && typeof OV.broadcast === "function") {
          OV.broadcast("OpenVibe JS timer smoke fired.");
        }
      });
    }
    return false;
  });
})();
