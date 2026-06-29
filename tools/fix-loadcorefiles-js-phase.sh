#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
SDK="${OPENVIBE_SDK:-$ROOT/engine/source-sdk-2013}"
STAMP="$(date +%Y%m%d-%H%M%S)"

cd "$ROOT"

echo "[openvibe] fix LoadCoreFiles patch + finish JS command/timer phase"
echo "[openvibe] root=$ROOT"
echo "[openvibe] sdk=$SDK"

backup_file() {
  local f="$1"
  [[ -f "$f" ]] && cp "$f" "$f.bak.$STAMP"
}

mkdir -p game/openvibe.games/js/core
mkdir -p game/openvibe.games/js/gamemodes/base
mkdir -p game/openvibe.games/js/gamemodes/hub
mkdir -p game/openvibe.games/js/gamemodes/prophunt
mkdir -p game/openvibe.games/js/gamemodes/deathrun
mkdir -p game/openvibe.games/js/gamemodes/fortwars
mkdir -p game/openvibe.games/js/gamemodes/traitortown
mkdir -p tools

echo "[openvibe] writing canonical JS core files"

cat > game/openvibe.games/js/core/hook.js <<'JS'
(function () {
  const buckets = Object.create(null);

  function ensure(name) {
    name = String(name || "");
    if (!buckets[name]) buckets[name] = [];
    return buckets[name];
  }

  globalThis.hook = {
    add(name, id, fn) {
      if (!name || !id || typeof fn !== "function") {
        throw new Error("hook.add(name, id, fn) requires a hook name, id, and function");
      }

      const list = ensure(name);
      const sid = String(id);
      for (let i = list.length - 1; i >= 0; --i) {
        if (list[i].id === sid) list.splice(i, 1);
      }
      list.push({ id: sid, fn });
    },

    remove(name, id) {
      const list = buckets[String(name || "")];
      if (!list) return;
      const sid = String(id || "");
      for (let i = list.length - 1; i >= 0; --i) {
        if (list[i].id === sid) list.splice(i, 1);
      }
    },

    run(name, ...args) {
      const list = buckets[String(name || "")];
      if (!list) return undefined;

      const snapshot = list.slice();
      for (const item of snapshot) {
        const result = item.fn(...args);
        if (result !== undefined) return result;
      }

      return undefined;
    },

    list(name) {
      if (name) return (buckets[String(name)] || []).map((item) => item.id);
      const out = Object.create(null);
      for (const key of Object.keys(buckets)) out[key] = buckets[key].map((item) => item.id);
      return out;
    }
  };
})();
JS

cat > game/openvibe.games/js/core/gamemode.js <<'JS'
(function () {
  let current = null;

  globalThis.gamemode = {
    set(gm) {
      if (!gm || typeof gm !== "object") throw new Error("gamemode.set(gm) requires an object");
      current = gm;
      return gm;
    },

    get() {
      return current;
    },

    call(name, ...args) {
      const hookResult = hook.run(name, ...args);
      if (hookResult !== undefined) return hookResult;

      if (current && typeof current[name] === "function") {
        return current[name](...args);
      }

      return undefined;
    }
  };
})();
JS

cat > game/openvibe.games/js/bridge.js <<'JS'
(function () {
  if (globalThis.OV && typeof OV.log === "function") {
    OV.log("bridge.js loaded");
  }
})();
JS

cat > game/openvibe.games/js/core/command.js <<'JS'
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
JS

cat > game/openvibe.games/js/core/timer.js <<'JS'
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
JS

echo "[openvibe] writing scoped gamemode scripts"

cat > game/openvibe.games/js/gamemodes/base/server.js <<'JS'
(function () {
  const BaseServerGM = {
    mode: "base",
    name: "OpenVibe Base",

    Initialize() {
      OV.log("Base Initialize fired");
    },

    MapInitialize(mapName) {
      OV.log(`Base MapInitialize: ${mapName}`);
    },

    PlayerInitialSpawn(ply) {
      ply.chat("Welcome to OpenVibe: Source.");
    },

    PlayerSpawn(_ply) {},
    PlayerDeath(_victim, _attacker) {},
    PlayerDisconnected(_ply) {},
    Think() {}
  };

  gamemode.set(BaseServerGM);
})();
JS

cat > game/openvibe.games/js/gamemodes/hub/server.js <<'JS'
(function () {
  function registerHubCommands() {
    if (!globalThis.command) return;

    command.add("js", "Confirm JavaScript hooks are working", function ({ ply, reply }) {
      reply(ply, "JavaScript hooks are working.");
      return false;
    });

    command.add("hp", "Show current health", function ({ ply, reply }) {
      if (!ply) return false;
      reply(ply, `Health: ${ply.health()}`);
      return false;
    });

    command.add("players", "Show player count", function ({ ply, reply }) {
      reply(ply, `Players online: ${OV.players().length}`);
      return false;
    });

    command.add("where", "Show current mode and map", function ({ ply, reply }) {
      reply(ply, `Mode=${OV.getMode()} map=${OV.getMapName()}`);
      return false;
    });

    command.add("hub_status", "Broadcast hub status", function ({ ply, reply }) {
      reply(ply, `Hub OK. mode=${OV.getMode()} map=${OV.getMapName()} players=${OV.players().length}`);
      return false;
    });
  }

  const HubServerGM = {
    mode: "hub",
    name: "OpenVibe Hub",

    Initialize() {
      OV.log("Hub Initialize fired");
      registerHubCommands();
    },

    MapInitialize(mapName) {
      OV.log(`Hub MapInitialize: ${mapName}`);
    },

    PlayerInitialSpawn(ply) {
      ply.chat("Welcome to OpenVibe: Source JS runtime.");
      OV.broadcast(`${ply.name()} joined the hub.`);
    },

    PlayerSpawn(ply) {
      ply.chat("PlayerSpawn hook fired.");
    },

    PlayerSay(_ply, _text) {
      return undefined;
    },

    ConsoleCommand(text) {
      OV.log(`Hub ConsoleCommand fallback: ${text}`);
      return undefined;
    },

    Think() {}
  };

  gamemode.set(HubServerGM);
})();
JS

cat > game/openvibe.games/js/gamemodes/prophunt/server.js <<'JS'
(function () {
  function registerCommands() {
    if (!globalThis.command) return;
    command.add("ph_status", "Show Prop Hunt status", function ({ ply, reply }) {
      reply(ply, `Prop Hunt JS online. map=${OV.getMapName()} players=${OV.players().length}`);
      return false;
    });
    command.add("disguise", "Disguise as an allowlisted prop", function ({ args, ply, reply }) {
      const choice = args[0] || "crate";
      if (!ply) return false;
      ply.runCommand(`ov_prophunt_disguise ${choice}`);
      reply(ply, `Trying prop disguise: ${choice}`);
      return false;
    });
  }

  const PropHuntGM = {
    mode: "prophunt",
    name: "OpenVibe Prop Hunt",
    Initialize() { OV.log("Prop Hunt Initialize fired"); registerCommands(); },
    PlayerInitialSpawn(ply) { ply.chat("Prop Hunt JS loaded. Try !ph_status or !disguise crate"); },
    Think() {}
  };
  gamemode.set(PropHuntGM);
})();
JS

cat > game/openvibe.games/js/gamemodes/deathrun/server.js <<'JS'
(function () {
  function registerCommands() {
    if (!globalThis.command) return;
    command.add("dr_status", "Show Deathrun status", function ({ ply, reply }) {
      reply(ply, `Deathrun JS online. map=${OV.getMapName()} players=${OV.players().length}`);
      return false;
    });
  }

  const DeathrunGM = {
    mode: "deathrun",
    name: "OpenVibe Deathrun",
    Initialize() { OV.log("Deathrun Initialize fired"); registerCommands(); },
    PlayerInitialSpawn(ply) { ply.chat("Deathrun JS loaded. Try !dr_status"); },
    Think() {}
  };
  gamemode.set(DeathrunGM);
})();
JS

cat > game/openvibe.games/js/gamemodes/fortwars/server.js <<'JS'
(function () {
  function registerCommands() {
    if (!globalThis.command) return;
    command.add("fw_status", "Show Fort Wars status", function ({ ply, reply }) {
      reply(ply, `Fort Wars JS online. map=${OV.getMapName()} players=${OV.players().length}`);
      return false;
    });
    command.add("build", "Spawn an allowlisted Fort Wars prop", function ({ args, ply, reply }) {
      const choice = args[0] || "crate";
      if (!ply) return false;
      ply.runCommand(`ov_fortwars_spawn ${choice}`);
      reply(ply, `Trying Fort Wars prop: ${choice}`);
      return false;
    });
  }

  const FortWarsGM = {
    mode: "fortwars",
    name: "OpenVibe Fort Wars",
    Initialize() { OV.log("Fort Wars Initialize fired"); registerCommands(); },
    PlayerInitialSpawn(ply) { ply.chat("Fort Wars JS loaded. Try !fw_status or !build crate"); },
    Think() {}
  };
  gamemode.set(FortWarsGM);
})();
JS

cat > game/openvibe.games/js/gamemodes/traitortown/server.js <<'JS'
(function () {
  function registerCommands() {
    if (!globalThis.command) return;
    command.add("ttt_status", "Show Traitor Town status", function ({ ply, reply }) {
      reply(ply, `Traitor Town JS online. map=${OV.getMapName()} players=${OV.players().length}`);
      return false;
    });
  }

  const TraitorTownGM = {
    mode: "traitortown",
    name: "OpenVibe Traitor Town",
    Initialize() { OV.log("Traitor Town Initialize fired"); registerCommands(); },
    PlayerInitialSpawn(ply) { ply.chat("Traitor Town JS loaded. Try !ttt_status"); },
    Think() {}
  };
  gamemode.set(TraitorTownGM);
})();
JS

echo "[openvibe] robustly replacing COpenVibeJSRuntime::LoadCoreFiles"

backup_file sdk/openvibe/shared/ov_js_runtime.cpp

python3 <<'PY'
from pathlib import Path

p = Path("sdk/openvibe/shared/ov_js_runtime.cpp")
s = p.read_text()

sig = "bool COpenVibeJSRuntime::LoadCoreFiles()"
idx = s.find(sig)
if idx < 0:
    raise SystemExit("Could not find COpenVibeJSRuntime::LoadCoreFiles signature")

brace = s.find("{", idx)
if brace < 0:
    raise SystemExit("Could not find COpenVibeJSRuntime::LoadCoreFiles opening brace")

depth = 0
end = None
for i in range(brace, len(s)):
    ch = s[i]
    if ch == "{":
        depth += 1
    elif ch == "}":
        depth -= 1
        if depth == 0:
            end = i + 1
            break

if end is None:
    raise SystemExit("Could not find COpenVibeJSRuntime::LoadCoreFiles closing brace")

replacement = '''bool COpenVibeJSRuntime::LoadCoreFiles()
{
    if (!LoadFile("js/core/hook.js"))
        return false;

    if (!LoadFile("js/core/gamemode.js"))
        return false;

    if (!LoadFile("js/bridge.js"))
        return false;

    if (!LoadFile("js/core/command.js"))
        return false;

    if (!LoadFile("js/core/timer.js"))
        return false;

    return true;
}'''

s = s[:idx] + replacement + s[end:]
p.write_text(s)
print("[openvibe] LoadCoreFiles replaced")
PY

echo "[openvibe] writing Node JS smoke test"

cat > tools/smoke-js-core-node.mjs <<'JS'
import fs from "node:fs";
import vm from "node:vm";

let fakeTime = 0;
const messages = [];

function player() {
  return {
    userId: 1,
    entIndex: 1,
    steamId: () => "STEAM_0:1:1",
    name: () => "SmokePlayer",
    health: () => 87,
    setHealth: () => undefined,
    chat: (msg) => messages.push(`[chat] ${msg}`),
    team: () => 0,
    setTeam: () => undefined,
    runCommand: (cmd) => messages.push(`[runCommand] ${cmd}`)
  };
}

const context = vm.createContext({
  console,
  globalThis: {},
  OV: {
    log: (msg) => messages.push(`[log] ${msg}`),
    warn: (msg) => messages.push(`[warn] ${msg}`),
    error: (msg) => messages.push(`[error] ${msg}`),
    getMode: () => "hub",
    getMapName: () => "ov_hub",
    time: () => fakeTime,
    broadcast: (msg) => messages.push(`[broadcast] ${msg}`),
    players: () => [player()],
    playerByUserId: () => player(),
    serverCommand: (cmd) => messages.push(`[serverCommand] ${cmd}`),
    reward: () => undefined,
    endMatch: () => undefined
  }
});
context.globalThis = context;

const files = [
  "game/openvibe.games/js/core/hook.js",
  "game/openvibe.games/js/core/gamemode.js",
  "game/openvibe.games/js/bridge.js",
  "game/openvibe.games/js/core/command.js",
  "game/openvibe.games/js/core/timer.js",
  "game/openvibe.games/js/gamemodes/base/server.js",
  "game/openvibe.games/js/gamemodes/hub/server.js"
];

for (const file of files) {
  const code = fs.readFileSync(file, "utf8");
  vm.runInContext(code, context, { filename: file });
}

context.gamemode.call("Initialize");
context.gamemode.call("MapInitialize", "ov_hub");
context.gamemode.call("PlayerInitialSpawn", player());

const blocked = context.gamemode.call("PlayerSay", player(), "!js");
if (blocked !== false) throw new Error("!js did not block default chat");

context.gamemode.call("ConsoleCommand", "smoke");
context.gamemode.call("ConsoleCommand", "hub_status");
context.gamemode.call("ConsoleCommand", "timer_smoke");
fakeTime += 1;
context.gamemode.call("Think");

if (!messages.some((line) => line.includes("JavaScript hooks are working"))) throw new Error("missing !js response");
if (!messages.some((line) => line.includes("OpenVibe embedded JS smoke test passed"))) throw new Error("missing smoke response");
if (!messages.some((line) => line.includes("OpenVibe JS timer smoke fired"))) throw new Error("missing timer smoke response");

console.log(messages.join("\n"));
console.log("[openvibe-smoke] JS command/timer smoke passed");
JS

echo "[openvibe] run JS smoke test"
node tools/smoke-js-core-node.mjs

echo "[openvibe] apply SDK patch"
tools/apply-openvibe-sdk.sh

echo "[openvibe] build SDK"
if [[ "${RUN_BUILD:-1}" = "1" ]]; then
  tools/build-sdk-linux.sh 2>&1 | tee "$HOME/ov-build.log"
fi

echo "[openvibe] setup OpenVibe bin"
tools/setup-openvibe-bin.sh

echo

echo "[openvibe] JS command/timer phase complete."
echo

echo "Runtime test:"
echo "  OPENVIBE_SRCDS_MAP_DELAY=3 tools/dev-up.sh"
echo
echo "Server console tests:"
echo "  ov_js_status"
echo "  ov_js_cmd help"
echo "  ov_js_cmd smoke"
echo "  ov_js_cmd timer_smoke"
echo "  ov_js_cmd hub_status"
echo
echo "Client tests:"
echo "  connect 127.0.0.1:27015"
echo "  say !help"
echo "  say !js"
echo "  say !hp"
echo "  say !players"
echo "  say !where"
