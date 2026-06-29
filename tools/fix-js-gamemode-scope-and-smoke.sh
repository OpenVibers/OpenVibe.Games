#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
SDK="${OPENVIBE_SDK:-$ROOT/engine/source-sdk-2013}"
STAMP="$(date +%Y%m%d-%H%M%S)"

cd "$ROOT"

echo "[openvibe] fix JS global-scope redeclare and continue command/timer phase"
echo "[openvibe] root=$ROOT"
echo "[openvibe] sdk=$SDK"

backup_file() {
  local file="$1"
  [[ -f "$file" ]] && cp "$file" "$file.bak.$STAMP"
}

mkdir -p \
  game/openvibe.games/js/core \
  game/openvibe.games/js/gamemodes/base \
  game/openvibe.games/js/gamemodes/hub \
  game/openvibe.games/js/gamemodes/prophunt \
  game/openvibe.games/js/gamemodes/deathrun \
  game/openvibe.games/js/gamemodes/fortwars \
  game/openvibe.games/js/gamemodes/traitortown \
  tools

echo "[openvibe] writing canonical command.js"
backup_file game/openvibe.games/js/core/command.js
cat > game/openvibe.games/js/core/command.js <<'JS'
(function () {
  const commands = new Map();

  function say(target, message) {
    const text = String(message);
    if (target && typeof target.chat === "function") {
      target.chat(text);
    } else {
      OV.log(text);
    }
  }

  function normalizeName(name) {
    return String(name || "").trim().replace(/^[!/]+/, "").toLowerCase();
  }

  function parse(text) {
    const raw = String(text || "").trim();
    const withoutPrefix = raw.replace(/^[!/]+/, "");
    const parts = withoutPrefix.length ? withoutPrefix.split(/\s+/) : [];
    const name = normalizeName(parts.shift() || "");
    return { raw, name, args: parts };
  }

  globalThis.command = {
    add(name, descriptionOrFn, maybeFn) {
      const key = normalizeName(name);
      if (!key) throw new Error("command.add requires command name");

      let description = "";
      let fn = maybeFn;

      if (typeof descriptionOrFn === "function") {
        fn = descriptionOrFn;
      } else {
        description = String(descriptionOrFn || "");
      }

      if (typeof fn !== "function") throw new Error(`command '${key}' requires function`);
      commands.set(key, { name: key, description, fn });
    },

    remove(name) {
      return commands.delete(normalizeName(name));
    },

    has(name) {
      return commands.has(normalizeName(name));
    },

    list() {
      return Array.from(commands.values()).map((entry) => ({
        name: entry.name,
        description: entry.description
      }));
    },

    run(source, text, ...extra) {
      const parsed = parse(text);
      if (!parsed.name) return undefined;

      const entry = commands.get(parsed.name);
      if (!entry) {
        say(source, `Unknown command: ${parsed.name}. Try !help.`);
        return source ? false : undefined;
      }

      try {
        const result = entry.fn(source, parsed.args, parsed.raw, ...extra);
        return result === undefined ? false : result;
      } catch (err) {
        OV.error(`[command:${parsed.name}] ${err && err.stack ? err.stack : err}`);
        say(source, `Command failed: ${parsed.name}`);
        return false;
      }
    }
  };

  hook.add("ConsoleCommand", "OpenVibeCommandConsole", function (text) {
    return command.run(null, text);
  });

  hook.add("PlayerSay", "OpenVibeCommandChat", function (ply, text) {
    const msg = String(text || "").trim();
    if (!msg.startsWith("!")) return undefined;
    return command.run(ply, msg.slice(1));
  });
})();
JS

echo "[openvibe] writing canonical timer.js"
backup_file game/openvibe.games/js/core/timer.js
cat > game/openvibe.games/js/core/timer.js <<'JS'
(function () {
  const timers = new Map();
  let nextId = 1;

  function now() {
    if (typeof OV !== "undefined" && typeof OV.time === "function") return Number(OV.time()) || 0;
    return Date.now() / 1000;
  }

  function makeId() {
    return `timer_${nextId++}`;
  }

  globalThis.timer = {
    create(id, delay, repetitions, fn) {
      if (typeof id !== "string" || !id) throw new Error("timer.create requires id");
      if (typeof fn !== "function") throw new Error("timer.create requires callback");

      const safeDelay = Math.max(0, Number(delay) || 0);
      const reps = repetitions === undefined ? 1 : Number(repetitions);

      timers.set(id, {
        id,
        delay: safeDelay,
        repetitions: reps,
        fn,
        next: now() + safeDelay,
        running: true
      });

      return id;
    },

    simple(delay, fn) {
      return timer.create(makeId(), delay, 1, fn);
    },

    remove(id) {
      return timers.delete(String(id));
    },

    exists(id) {
      return timers.has(String(id));
    },

    count() {
      return timers.size;
    },

    tick() {
      const t = now();

      for (const [id, item] of Array.from(timers.entries())) {
        if (!item.running || t < item.next) continue;

        try {
          item.fn();
        } catch (err) {
          OV.error(`[timer:${id}] ${err && err.stack ? err.stack : err}`);
        }

        if (item.repetitions > 0) item.repetitions -= 1;

        if (item.repetitions === 0) {
          timers.delete(id);
        } else {
          item.next = t + item.delay;
        }
      }
    },

    clear() {
      timers.clear();
    }
  };

  hook.add("Think", "OpenVibeTimerThink", function () {
    timer.tick();
    return undefined;
  });
})();
JS

echo "[openvibe] writing scoped base gamemode"
backup_file game/openvibe.games/js/gamemodes/base/server.js
cat > game/openvibe.games/js/gamemodes/base/server.js <<'JS'
(function () {
  function say(target, message) {
    if (target && typeof target.chat === "function") target.chat(String(message));
    else OV.log(String(message));
  }

  command.add("help", "List available OpenVibe commands.", function (source) {
    const names = command.list().map((entry) => `!${entry.name}`).sort().join(", ");
    say(source, `Commands: ${names}`);
    return false;
  });

  command.add("smoke", "Run embedded JS smoke test.", function (source) {
    const message = "OpenVibe embedded JS smoke test passed.";
    if (source) say(source, message);
    OV.broadcast(message);
    return false;
  });

  command.add("timer_smoke", "Run timer smoke test.", function (source) {
    timer.simple(0, function () {
      OV.broadcast("OpenVibe timer smoke fired.");
    });
    timer.tick();
    say(source, "Timer smoke scheduled.");
    return false;
  });

  const GM = {
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

    PlayerSay(ply, text) {
      const msg = String(text || "").trim();
      if (msg.startsWith("!")) return command.run(ply, msg.slice(1));
      return undefined;
    },

    ConsoleCommand(text) {
      return command.run(null, text);
    },

    Think() {
      timer.tick();
    }
  };

  gamemode.set(GM);
})();
JS

echo "[openvibe] writing scoped hub gamemode"
backup_file game/openvibe.games/js/gamemodes/hub/server.js
cat > game/openvibe.games/js/gamemodes/hub/server.js <<'JS'
(function () {
  command.add("hub_status", "Print hub runtime status.", function (source) {
    const message = `Hub mode online. Map=${OV.getMapName()} Players=${OV.players().length}`;
    if (source && typeof source.chat === "function") source.chat(message);
    else OV.log(message);
    return false;
  });

  command.add("where", "Show current map/mode.", function (source) {
    const message = `You are on ${OV.getMapName()} in ${OV.getMode()} mode.`;
    if (source && typeof source.chat === "function") source.chat(message);
    else OV.log(message);
    return false;
  });

  const GM = {
    mode: "hub",
    name: "OpenVibe Hub",

    Initialize() {
      OV.log("Hub Initialize fired");
    },

    MapInitialize(mapName) {
      OV.log(`Map initialized: ${mapName}`);
    },

    PlayerInitialSpawn(ply) {
      ply.chat("Welcome to OpenVibe: Source JS runtime.");
      OV.broadcast(`${ply.name()} joined the hub.`);
    },

    PlayerSpawn(_ply) {},

    PlayerSay(ply, text) {
      const msg = String(text || "").trim();

      if (msg === "!js") {
        ply.chat("JavaScript hooks are working.");
        return false;
      }

      if (msg === "!hp") {
        ply.chat(`Health: ${ply.health()}`);
        return false;
      }

      if (msg === "!players") {
        ply.chat(`Players online: ${OV.players().length}`);
        return false;
      }

      if (msg.startsWith("!")) return command.run(ply, msg.slice(1));
      return undefined;
    },

    ConsoleCommand(text) {
      OV.log(`Hub ConsoleCommand: ${text}`);
      return command.run(null, text);
    },

    Think() {
      timer.tick();
    }
  };

  gamemode.set(GM);
})();
JS

echo "[openvibe] writing scoped prototype gamemodes"
cat > game/openvibe.games/js/gamemodes/prophunt/server.js <<'JS'
(function () {
  const props = ["crate", "barrel", "chair", "bucket"];

  function randomProp() {
    return props[Math.floor(Math.random() * props.length)];
  }

  command.add("prop", "Prop Hunt disguise command.", function (ply, args) {
    if (!ply) {
      OV.log("prop command requires player");
      return false;
    }

    const prop = args[0] || randomProp();
    ply.runCommand(`ov_prophunt_disguise ${prop}`);
    return false;
  });

  const GM = {
    mode: "prophunt",
    name: "OpenVibe Prop Hunt",

    Initialize() {
      OV.log("Prop Hunt Initialize fired");
    },

    PlayerInitialSpawn(ply) {
      ply.chat("Prop Hunt: hide as props or hunt them down.");
    },

    PlayerSay(ply, text) {
      const msg = String(text || "").trim();
      if (msg.startsWith("!")) return command.run(ply, msg.slice(1));
      return undefined;
    },

    Think() {
      timer.tick();
    }
  };

  gamemode.set(GM);
})();
JS

cat > game/openvibe.games/js/gamemodes/deathrun/server.js <<'JS'
(function () {
  command.add("finish", "Deathrun finish smoke command.", function (ply) {
    if (ply) ply.chat("Deathrun finish test.");
    return false;
  });

  const GM = {
    mode: "deathrun",
    name: "OpenVibe Deathrun",

    Initialize() {
      OV.log("Deathrun Initialize fired");
    },

    PlayerInitialSpawn(ply) {
      ply.chat("Deathrun: survive the traps and reach the finish.");
    },

    PlayerSay(ply, text) {
      const msg = String(text || "").trim();
      if (msg.startsWith("!")) return command.run(ply, msg.slice(1));
      return undefined;
    },

    Think() {
      timer.tick();
    }
  };

  gamemode.set(GM);
})();
JS

cat > game/openvibe.games/js/gamemodes/fortwars/server.js <<'JS'
(function () {
  const allowed = new Set(["crate", "barrel", "pallet", "fence", "sheet"]);

  command.add("build", "Fort Wars build command.", function (ply, args) {
    if (!ply) {
      OV.log("build command requires player");
      return false;
    }

    const part = args[0] || "crate";
    if (!allowed.has(part)) {
      ply.chat("Allowed: crate, barrel, pallet, fence, sheet");
      return false;
    }

    ply.runCommand(`ov_fortwars_spawn ${part}`);
    return false;
  });

  const GM = {
    mode: "fortwars",
    name: "OpenVibe Fort Wars",

    Initialize() {
      OV.log("Fort Wars Initialize fired");
    },

    PlayerInitialSpawn(ply) {
      ply.chat("Fort Wars: build first, fight second.");
    },

    PlayerSay(ply, text) {
      const msg = String(text || "").trim();
      if (msg.startsWith("!")) return command.run(ply, msg.slice(1));
      return undefined;
    },

    Think() {
      timer.tick();
    }
  };

  gamemode.set(GM);
})();
JS

cat > game/openvibe.games/js/gamemodes/traitortown/server.js <<'JS'
(function () {
  const roles = new Map();

  command.add("role", "Show your Traitor Town role.", function (ply) {
    if (!ply) {
      OV.log("role command requires player");
      return false;
    }

    ply.chat(`Your role: ${roles.get(ply.userId()) || "innocent"}`);
    return false;
  });

  const GM = {
    mode: "traitortown",
    name: "OpenVibe Traitor Town",

    Initialize() {
      OV.log("Traitor Town Initialize fired");
    },

    PlayerInitialSpawn(ply) {
      ply.chat("Traitor Town: find the traitors before they find you.");
      roles.set(ply.userId(), "innocent");
    },

    PlayerSay(ply, text) {
      const msg = String(text || "").trim();
      if (msg.startsWith("!")) return command.run(ply, msg.slice(1));
      return undefined;
    },

    PlayerDeath(victim, _attacker) {
      OV.broadcast(`${victim.name()} died.`);
    },

    Think() {
      timer.tick();
    }
  };

  gamemode.set(GM);
})();
JS

echo "[openvibe] patching runtime core load order"
backup_file sdk/openvibe/shared/ov_js_runtime.cpp
python3 <<'PY'
from pathlib import Path
import re

p = Path("sdk/openvibe/shared/ov_js_runtime.cpp")
s = p.read_text()

new_func = r'''bool COpenVibeJSRuntime::LoadCoreFiles()
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

s2 = re.sub(
    r'bool\s+COpenVibeJSRuntime::LoadCoreFiles\s*\(\s*\)\s*\{.*?\n\}',
    new_func,
    s,
    count=1,
    flags=re.S,
)

if s2 == s:
    raise SystemExit("Could not patch COpenVibeJSRuntime::LoadCoreFiles")

p.write_text(s2)
PY

echo "[openvibe] writing robust Node JS core smoke test"
backup_file tools/smoke-js-core-node.mjs
cat > tools/smoke-js-core-node.mjs <<'MJS'
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = process.env.OPENVIBE_ROOT || process.cwd();
let fakeTime = 0;
const logs = [];
const broadcasts = [];
const chats = [];
const serverCommands = [];

const context = {
  console,
  globalThis: null,
  OV: {
    log: (msg) => logs.push(String(msg)),
    warn: (msg) => logs.push(`WARN ${String(msg)}`),
    error: (msg) => logs.push(`ERROR ${String(msg)}`),
    getMode: () => "hub",
    getMapName: () => "ov_hub",
    time: () => fakeTime,
    broadcast: (msg) => broadcasts.push(String(msg)),
    players: () => [mockPlayer],
    playerByUserId: (id) => Number(id) === 1 ? mockPlayer : null,
    serverCommand: (cmd) => serverCommands.push(String(cmd)),
    fireHook: (...args) => context.gamemode.call(...args),
    reward: () => undefined,
    endMatch: () => undefined
  }
};

const mockPlayer = {
  userId: () => 1,
  entIndex: () => 1,
  steamId: () => "STEAM_0:1:1",
  name: () => "SmokePlayer",
  health: () => 100,
  setHealth: () => undefined,
  team: () => 0,
  setTeam: () => undefined,
  chat: (msg) => chats.push(String(msg)),
  runCommand: (cmd) => serverCommands.push(String(cmd))
};

context.globalThis = context;
vm.createContext(context);

function load(relativePath) {
  const full = path.join(root, relativePath);
  const source = fs.readFileSync(full, "utf8");
  vm.runInContext(source, context, { filename: relativePath });
}

for (const file of [
  "game/openvibe.games/js/core/hook.js",
  "game/openvibe.games/js/core/gamemode.js",
  "game/openvibe.games/js/bridge.js",
  "game/openvibe.games/js/core/command.js",
  "game/openvibe.games/js/core/timer.js",
  "game/openvibe.games/js/gamemodes/base/server.js",
  "game/openvibe.games/js/gamemodes/hub/server.js"
]) {
  load(file);
}

if (!context.hook) throw new Error("hook global missing");
if (!context.gamemode) throw new Error("gamemode global missing");
if (!context.command) throw new Error("command global missing");
if (!context.timer) throw new Error("timer global missing");
if (!context.gamemode.get()) throw new Error("gamemode was not set");

context.gamemode.call("Initialize");
context.gamemode.call("MapInitialize", "ov_hub");
context.gamemode.call("ConsoleCommand", "help");
context.gamemode.call("ConsoleCommand", "smoke");
context.gamemode.call("ConsoleCommand", "timer_smoke");
context.gamemode.call("ConsoleCommand", "hub_status");
context.gamemode.call("PlayerInitialSpawn", mockPlayer);
context.gamemode.call("PlayerSay", mockPlayer, "!help");
context.gamemode.call("PlayerSay", mockPlayer, "!where");
context.gamemode.call("PlayerSay", mockPlayer, "!js");
context.gamemode.call("PlayerSay", mockPlayer, "!hp");
context.gamemode.call("PlayerSay", mockPlayer, "!players");
fakeTime += 1;
context.gamemode.call("Think");
context.timer.tick();

const combined = [...logs, ...broadcasts, ...chats, ...serverCommands].join("\n");

for (const expected of [
  "Hub Initialize fired",
  "OpenVibe embedded JS smoke test passed.",
  "OpenVibe timer smoke fired.",
  "JavaScript hooks are working.",
  "Health: 100",
  "Players online: 1",
  "You are on ov_hub in hub mode."
]) {
  if (!combined.includes(expected)) {
    console.error(combined);
    throw new Error(`missing expected smoke output: ${expected}`);
  }
}

console.log("[openvibe-smoke] JS core command/timer smoke passed");
console.log(`[openvibe-smoke] logs=${logs.length} broadcasts=${broadcasts.length} chats=${chats.length}`);
MJS

echo "[openvibe] run JS core smoke test"
node tools/smoke-js-core-node.mjs

echo "[openvibe] apply SDK patch"
tools/apply-openvibe-sdk.sh

echo "[openvibe] build SDK"
tools/build-sdk-linux.sh 2>&1 | tee "$HOME/ov-build.log"

echo "[openvibe] setup OpenVibe bin"
tools/setup-openvibe-bin.sh

echo
printf '%s\n' "[openvibe] JS command/timer phase complete."
printf '%s\n' ""
printf '%s\n' "Runtime test:"
printf '%s\n' "  OPENVIBE_SRCDS_MAP_DELAY=3 tools/dev-up.sh"
printf '%s\n' ""
printf '%s\n' "Server console tests:"
printf '%s\n' "  ov_js_status"
printf '%s\n' "  ov_js_fire Initialize"
printf '%s\n' "  ov_js_cmd help"
printf '%s\n' "  ov_js_cmd smoke"
printf '%s\n' "  ov_js_cmd timer_smoke"
printf '%s\n' "  ov_js_cmd hub_status"
printf '%s\n' ""
printf '%s\n' "Client tests:"
printf '%s\n' "  connect 127.0.0.1:27015"
printf '%s\n' "  say !help"
printf '%s\n' "  say !js"
printf '%s\n' "  say !hp"
printf '%s\n' "  say !players"
printf '%s\n' "  say !where"
