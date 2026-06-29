#!/usr/bin/env bash
set -euo pipefail

ROOT="${OPENVIBE_ROOT:-$HOME/src/openvibe-source}"
SDK="${OPENVIBE_SDK:-$ROOT/engine/source-sdk-2013}"
STAMP="$(date +%Y%m%d-%H%M%S)"
RUN_BUILD="${RUN_BUILD:-1}"

cd "$ROOT"

echo "[openvibe] next phase: JS command registry + timers + smoke tests"
echo "[openvibe] root=$ROOT"
echo "[openvibe] sdk=$SDK"

backup_file() {
  local file="$1"
  [[ -f "$file" ]] && cp "$file" "$file.bak.$STAMP"
}

need_file() {
  [[ -f "$1" ]] || { echo "[openvibe] missing required file: $1" >&2; exit 1; }
}

need_file sdk/openvibe/shared/ov_js_runtime.cpp
need_file tools/apply-openvibe-sdk.sh
need_file tools/build-sdk-linux.sh
need_file tools/setup-openvibe-bin.sh

mkdir -p game/openvibe.games/js/core game/openvibe.games/js/gamemodes/{base,hub,prophunt,deathrun,fortwars,traitortown} tools

echo "[openvibe] writing JS core command registry"

cat > game/openvibe.games/js/core/command.js <<'JS_COMMAND'
(function () {
  const chatCommands = new Map();
  const consoleCommands = new Map();

  function splitWords(text) {
    const source = String(text || "").trim();
    if (!source) return [];
    return source.split(/\s+/g);
  }

  function normalizeChatName(name) {
    return String(name || "").replace(/^!+/, "").toLowerCase();
  }

  function normalizeConsoleName(name) {
    return String(name || "").toLowerCase();
  }

  function register(map, name, fn, help) {
    if (typeof fn !== "function") throw new Error("command callback must be function");
    const key = map === chatCommands ? normalizeChatName(name) : normalizeConsoleName(name);
    if (!key) throw new Error("command name is required");
    map.set(key, { fn, help: help ? String(help) : "" });
  }

  function runChat(ply, text) {
    const words = splitWords(text);
    if (words.length === 0) return undefined;
    if (words[0][0] !== "!") return undefined;

    const name = normalizeChatName(words[0]);
    const entry = chatCommands.get(name);
    if (!entry) return undefined;

    try {
      const args = words.slice(1);
      const result = entry.fn(ply, args, String(text || ""));
      return result === undefined ? false : result;
    } catch (err) {
      OV.error(`[chat:${name}] ${err && err.stack ? err.stack : err}`);
      if (ply && typeof ply.chat === "function") ply.chat("Command failed. Check server console.");
      return false;
    }
  }

  function runConsole(text) {
    const words = splitWords(text);
    if (words.length === 0) return undefined;

    const name = normalizeConsoleName(words[0]);
    const entry = consoleCommands.get(name);
    if (!entry) return undefined;

    try {
      const args = words.slice(1);
      const result = entry.fn(args, String(text || ""));
      return result === undefined ? false : result;
    } catch (err) {
      OV.error(`[console:${name}] ${err && err.stack ? err.stack : err}`);
      return false;
    }
  }

  function list(map) {
    const out = [];
    for (const [name, entry] of map.entries()) out.push({ name, help: entry.help });
    out.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    return out;
  }

  globalThis.command = {
    chat(name, fn, help) { register(chatCommands, name, fn, help); },
    console(name, fn, help) { register(consoleCommands, name, fn, help); },
    removeChat(name) { return chatCommands.delete(normalizeChatName(name)); },
    removeConsole(name) { return consoleCommands.delete(normalizeConsoleName(name)); },
    runChat,
    runConsole,
    chatList() { return list(chatCommands); },
    consoleList() { return list(consoleCommands); }
  };

  globalThis.concommand = {
    add(name, fn, help) { register(consoleCommands, name, fn, help); },
    remove(name) { return consoleCommands.delete(normalizeConsoleName(name)); },
    list() { return list(consoleCommands); }
  };

  hook.add("PlayerSay", "openvibe.command.chat", runChat);
  hook.add("ConsoleCommand", "openvibe.command.console", runConsole);

  OV.log("command.js loaded");
})();
JS_COMMAND

echo "[openvibe] writing JS timer library"

cat > game/openvibe.games/js/core/timer.js <<'JS_TIMER'
(function () {
  const timers = new Map();
  let nextId = 1;

  function now() {
    return Number(OV.time() || 0);
  }

  function create(id, delay, reps, fn) {
    if (typeof fn !== "function") throw new Error("timer callback must be function");

    const key = String(id || `timer_${nextId++}`);
    const seconds = Math.max(0, Number(delay || 0));
    const repeatCount = reps === undefined ? 1 : Number(reps);

    timers.set(key, {
      id: key,
      delay: seconds,
      reps: repeatCount,
      runs: 0,
      next: now() + seconds,
      fn
    });

    return key;
  }

  function simple(delay, fn) {
    return create(null, delay, 1, fn);
  }

  function remove(id) {
    return timers.delete(String(id));
  }

  function exists(id) {
    return timers.has(String(id));
  }

  function tick() {
    const t = now();
    const due = [];

    for (const item of timers.values()) {
      if (t >= item.next) due.push(item.id);
    }

    for (const id of due) {
      const item = timers.get(id);
      if (!item) continue;

      try {
        item.runs += 1;
        item.fn(item.runs, id);
      } catch (err) {
        OV.error(`[timer:${id}] ${err && err.stack ? err.stack : err}`);
      }

      if (item.reps > 0 && item.runs >= item.reps) {
        timers.delete(id);
      } else {
        item.next = now() + item.delay;
      }
    }

    return undefined;
  }

  function list() {
    const out = [];
    const t = now();
    for (const item of timers.values()) {
      out.push({
        id: item.id,
        delay: item.delay,
        reps: item.reps,
        runs: item.runs,
        remaining: Math.max(0, item.next - t)
      });
    }
    return out;
  }

  globalThis.timer = { create, simple, remove, exists, list };
  hook.add("Think", "openvibe.timer.tick", tick);

  OV.log("timer.js loaded");
})();
JS_TIMER

echo "[openvibe] patching runtime load order for command.js and timer.js"

backup_file sdk/openvibe/shared/ov_js_runtime.cpp
python3 <<'PY'
from pathlib import Path

p = Path("sdk/openvibe/shared/ov_js_runtime.cpp")
s = p.read_text()
old = '''bool COpenVibeJSRuntime::LoadCoreFiles()
{
    if (!LoadFile("js/core/hook.js"))
        return false;

    if (!LoadFile("js/core/gamemode.js"))
        return false;

    if (!LoadFile("js/bridge.js"))
        return false;

    return true;
}
'''
new = '''bool COpenVibeJSRuntime::LoadCoreFiles()
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
}
'''
if old not in s:
    start = s.find("bool COpenVibeJSRuntime::LoadCoreFiles()")
    if start == -1:
        raise SystemExit("LoadCoreFiles not found")
    brace = s.find("{", start)
    depth = 0
    end = None
    for i in range(brace, len(s)):
        if s[i] == "{":
            depth += 1
        elif s[i] == "}":
            depth -= 1
            if depth == 0:
                end = i + 1
                break
    if end is None:
        raise SystemExit("LoadCoreFiles end not found")
    s = s[:start] + new + s[end:]
else:
    s = s.replace(old, new)
p.write_text(s)
PY

echo "[openvibe] writing base gamemode with command/timer smoke support"

cat > game/openvibe.games/js/gamemodes/base/server.js <<'JS_BASE'
const GM = {
  mode: "base",
  name: "OpenVibe Base",

  Initialize() {
    OV.log("Base Initialize fired");

    command.console("help", () => {
      const chats = command.chatList().map((cmd) => `!${cmd.name}`).join(", ");
      const consoles = command.consoleList().map((cmd) => cmd.name).join(", ");
      OV.log(`Chat commands: ${chats || "none"}`);
      OV.log(`Console commands: ${consoles || "none"}`);
      return false;
    }, "List OpenVibe JS commands");

    command.console("smoke", () => {
      OV.log("OpenVibe embedded JS smoke command passed.");
      OV.broadcast("OpenVibe embedded JS smoke command passed.");
      return false;
    }, "Run embedded JS smoke test");

    command.console("timer_smoke", () => {
      OV.log("Scheduling timer smoke test.");
      timer.simple(1.0, () => OV.broadcast("OpenVibe JS timer smoke passed."));
      return false;
    }, "Schedule a one-second timer smoke test");

    command.chat("help", (ply) => {
      const names = command.chatList().map((cmd) => `!${cmd.name}`).join(", ");
      ply.chat(`Commands: ${names || "none"}`);
      return false;
    }, "List chat commands");

    command.chat("js", (ply) => {
      ply.chat("JavaScript command registry is working.");
      return false;
    }, "JS smoke test");
  },

  PlayerInitialSpawn(ply) {
    ply.chat("Welcome to OpenVibe: Source.");
  },

  PlayerSpawn(_ply) {},

  PlayerDeath(_victim, _attacker) {},

  PlayerDisconnected(_ply) {},

  PlayerSay(_ply, _text) {
    return undefined;
  },

  ConsoleCommand(text) {
    OV.log(`Unhandled ConsoleCommand: ${text}`);
    return undefined;
  },

  Think() {}
};

gamemode.set(GM);
JS_BASE

echo "[openvibe] writing hub gamemode using command registry"

cat > game/openvibe.games/js/gamemodes/hub/server.js <<'JS_HUB'
const GM = {
  mode: "hub",
  name: "OpenVibe Hub",

  Initialize() {
    OV.log("Hub Initialize fired");

    command.chat("hp", (ply) => {
      ply.chat(`Health: ${ply.health()}`);
      return false;
    }, "Show current health");

    command.chat("players", (ply) => {
      ply.chat(`Players online: ${OV.players().length}`);
      return false;
    }, "Show player count");

    command.chat("where", (ply) => {
      ply.chat(`Mode=${OV.getMode()} Map=${OV.getMapName()}`);
      return false;
    }, "Show mode and map");

    command.console("hub_status", () => {
      OV.log(`Hub status: mode=${OV.getMode()} map=${OV.getMapName()} players=${OV.players().length}`);
      return false;
    }, "Print hub status");
  },

  MapInitialize(mapName) {
    OV.log(`Map initialized: ${mapName}`);
  },

  PlayerInitialSpawn(ply) {
    ply.chat("Welcome to OpenVibe: Source JS runtime.");
    ply.chat("Type !help for JS commands.");
    OV.broadcast(`${ply.name()} joined the hub.`);
  },

  PlayerSpawn(ply) {
    timer.simple(0.2, () => ply.chat("PlayerSpawn hook fired."));
  },

  PlayerSay(_ply, _text) {
    return undefined;
  },

  ConsoleCommand(text) {
    OV.log(`Hub unhandled ConsoleCommand: ${text}`);
    return undefined;
  },

  Think() {}
};

gamemode.set(GM);
JS_HUB

echo "[openvibe] updating prototype gamemodes to use command registry when available"

cat > game/openvibe.games/js/gamemodes/prophunt/server.js <<'JS_PH'
const props = ["can", "crate", "barrel", "chair", "bucket"];

function randomProp() {
  return props[Math.floor(Math.random() * props.length)];
}

const GM = {
  mode: "prophunt",
  name: "OpenVibe Prop Hunt",

  Initialize() {
    OV.log("Prop Hunt Initialize fired");

    command.chat("prop", (ply, args) => {
      const prop = args[0] || randomProp();
      ply.runCommand(`ov_prophunt_disguise ${prop}`);
      return false;
    }, "Disguise as a prop");

    command.chat("human", (ply) => {
      ply.runCommand("ov_prophunt_reset_disguise");
      return false;
    }, "Reset disguise");
  },

  PlayerInitialSpawn(ply) {
    ply.chat("Prop Hunt: use !prop or !prop crate. Use !human to reset.");
  },

  Think() {}
};

gamemode.set(GM);
JS_PH

cat > game/openvibe.games/js/gamemodes/fortwars/server.js <<'JS_FW'
const allowed = new Set(["crate", "barrel", "pallet", "fence", "sheet"]);

const GM = {
  mode: "fortwars",
  name: "OpenVibe Fort Wars",

  Initialize() {
    OV.log("Fort Wars Initialize fired");

    command.chat("build", (ply, args) => {
      const part = args[0] || "";
      if (!allowed.has(part)) {
        ply.chat("Allowed: crate, barrel, pallet, fence, sheet");
        return false;
      }

      ply.runCommand(`ov_fortwars_spawn ${part}`);
      return false;
    }, "Spawn a Fort Wars build prop");
  },

  PlayerInitialSpawn(ply) {
    ply.chat("Fort Wars: build first, fight second. Try !build crate.");
  }
};

gamemode.set(GM);
JS_FW

cat > game/openvibe.games/js/gamemodes/deathrun/server.js <<'JS_DR'
const GM = {
  mode: "deathrun",
  name: "OpenVibe Deathrun",

  Initialize() {
    OV.log("Deathrun Initialize fired");

    command.chat("finish", (ply) => {
      ply.chat("Deathrun finish test.");
      OV.reward(ply, 50, 100, "deathrun_finish");
      return false;
    }, "Smoke-test Deathrun finish reward path");
  },

  PlayerInitialSpawn(ply) {
    ply.chat("Deathrun: survive the traps and reach the finish.");
  }
};

gamemode.set(GM);
JS_DR

cat > game/openvibe.games/js/gamemodes/traitortown/server.js <<'JS_TT'
const roles = new Map();

const GM = {
  mode: "traitortown",
  name: "OpenVibe Traitor Town",

  Initialize() {
    OV.log("Traitor Town Initialize fired");

    command.chat("role", (ply) => {
      ply.chat(`Your role: ${roles.get(ply.userId()) || "innocent"}`);
      return false;
    }, "Show your role");
  },

  PlayerInitialSpawn(ply) {
    ply.chat("Traitor Town: find the traitors before they find you.");
    roles.set(ply.userId(), "innocent");
  },

  PlayerDeath(victim, _attacker) {
    OV.broadcast(`${victim.name()} died.`);
  }
};

gamemode.set(GM);
JS_TT

echo "[openvibe] writing Node-based JS core smoke test"

cat > tools/smoke-js-core-node.mjs <<'NODE_SMOKE'
import fs from "node:fs";
import vm from "node:vm";

const files = [
  "game/openvibe.games/js/core/hook.js",
  "game/openvibe.games/js/core/gamemode.js",
  "game/openvibe.games/js/bridge.js",
  "game/openvibe.games/js/core/command.js",
  "game/openvibe.games/js/core/timer.js",
  "game/openvibe.games/js/gamemodes/base/server.js",
  "game/openvibe.games/js/gamemodes/hub/server.js"
];

const messages = [];
let fakeTime = 0;

const context = vm.createContext({
  console,
  Map,
  Set,
  Math,
  Number,
  String,
  Array,
  Object,
  Error,
  globalThis: {},
  OV: {
    log: (msg) => messages.push(`[log] ${msg}`),
    warn: (msg) => messages.push(`[warn] ${msg}`),
    error: (msg) => messages.push(`[error] ${msg}`),
    getMode: () => "hub",
    getMapName: () => "ov_hub",
    time: () => fakeTime,
    broadcast: (msg) => messages.push(`[broadcast] ${msg}`),
    players: () => [],
    playerByUserId: () => null,
    serverCommand: (cmd) => messages.push(`[serverCommand] ${cmd}`),
    fireHook: () => undefined,
    reward: () => undefined,
    endMatch: () => undefined
  }
});
context.globalThis = context;

for (const file of files) {
  const code = fs.readFileSync(file, "utf8");
  vm.runInContext(code, context, { filename: file });
}

context.gamemode.call("Initialize");
context.gamemode.call("MapInitialize", "ov_hub");
context.gamemode.call("ConsoleCommand", "smoke");
context.gamemode.call("ConsoleCommand", "timer_smoke");
fakeTime = 2;
context.gamemode.call("Think");

const fakePlayer = {
  userId: () => 1,
  entIndex: () => 1,
  steamId: () => "STEAM_0:1:1",
  name: () => "SmokePlayer",
  health: () => 100,
  setHealth: () => {},
  chat: (msg) => messages.push(`[chat] ${msg}`),
  runCommand: (cmd) => messages.push(`[runCommand] ${cmd}`)
};
context.gamemode.call("PlayerSay", fakePlayer, "!js");
context.gamemode.call("PlayerSay", fakePlayer, "!hp");
context.gamemode.call("PlayerSay", fakePlayer, "!players");

const required = [
  "command.js loaded",
  "timer.js loaded",
  "Hub Initialize fired",
  "OpenVibe embedded JS smoke command passed.",
  "OpenVibe JS timer smoke passed.",
  "JavaScript command registry is working.",
  "Health: 100",
  "Players online: 0"
];

for (const needle of required) {
  if (!messages.some((line) => line.includes(needle))) {
    console.error(messages.join("\n"));
    throw new Error(`missing smoke output: ${needle}`);
  }
}

console.log("[openvibe] JS core smoke passed");
for (const line of messages) console.log(line);
NODE_SMOKE
chmod +x tools/smoke-js-core-node.mjs

echo "[openvibe] run JS core smoke test"
node tools/smoke-js-core-node.mjs

echo "[openvibe] apply SDK patch"
tools/apply-openvibe-sdk.sh

if [[ "$RUN_BUILD" = "1" ]]; then
  echo "[openvibe] build SDK"
  tools/build-sdk-linux.sh 2>&1 | tee "$HOME/ov-build.log"

  echo "[openvibe] setup OpenVibe bin"
  tools/setup-openvibe-bin.sh

  echo
  echo "[openvibe] next phase build complete."
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
else
  echo "[openvibe] skipped SDK build because RUN_BUILD=0"
fi
