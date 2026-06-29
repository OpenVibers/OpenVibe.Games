# OpenVibe JavaScript Scripting

OpenVibe embeds QuickJS in the Source server DLL and exposes a small
GMod-style hook/gamemode API.

## File Layout

```text
game/openvibe.games/js/
  core/
    hook.js
    gamemode.js
    command.js
    timer.js
  bridge.js
  gamemodes/
    base/server.js
    hub/server.js
    prophunt/server.js
    deathrun/server.js
    fortwars/server.js
    traitortown/server.js
```

The server loads core files first, then `base/server.js`, then the active mode:

```text
js/gamemodes/<ov_mode>/server.js
```

## Hook API

Use the GMod-shaped API:

```js
hook.Add("PlayerSpawn", "MyAddon.SpawnMessage", function (ply) {
  ply.chat("Spawn hook from JS.");
});

hook.Remove("PlayerSpawn", "MyAddon.SpawnMessage");

const result = hook.Run("SomeHook", arg1, arg2);
```

Lowercase aliases also exist:

```js
hook.add("PlayerSpawn", "id", fn);
hook.remove("PlayerSpawn", "id");
hook.run("PlayerSpawn", ply);
```

Execution order:

1. Registered hooks run in insertion order.
2. The first hook that returns anything other than `undefined` wins.
3. If no hook returns a value, the active `GM` method runs.

This mirrors the GMod pattern where addon hooks can override gamemode behavior.

## Gamemode API

`base/server.js` defines the base `GM`. Active modes inherit from it:

```js
(function () {
  const GM = {
    mode: "deathrun",
    name: "OpenVibe Deathrun",

    Initialize() {
      OV.log("Deathrun initialized.");
    },

    PlayerInitialSpawn(ply) {
      ply.chat("Welcome to Deathrun.");
    }
  };

  gamemode.set(GM);
})();
```

Globals:

```js
GM
GAMEMODE
gamemode.get()
gamemode.getBase()
gamemode.call("HookName", ...args)
```

## Events Exposed Today

The native server bridge currently fires:

```text
Initialize
MapInitialize(mapName)
Think
PlayerInitialSpawn(ply)
PlayerSpawn(ply)
PlayerDeath(victim, attacker)
PlayerDisconnected(ply)
PlayerSay(ply, text)
ConsoleCommand(text)
Shutdown
```

## Commands

Chat commands are routed through the `PlayerSay` hook.

```js
command.Add("where", "Show mode and map", function ({ ply, reply }) {
  reply(ply, `Mode=${OV.getMode()} map=${OV.getMapName()}`);
  return false;
});
```

Players type:

```text
!where
```

Returning `false` blocks normal chat, matching the current C++ bridge behavior.

Console commands can be sent from SRCDS:

```text
ov_js_cmd where
```

## Timers

Timers are advanced from the `Think` hook:

```js
timer.simple(3, function () {
  OV.broadcast("Three seconds passed.");
});

timer.create("round_tick", 1, 0, function (count) {
  OV.log(`Round tick ${count}`);
});
```

`reps=0` means repeat forever.

## Native Bridge

Available server APIs:

```js
OV.log(msg)
OV.warn(msg)
OV.error(msg)
OV.getMode()
OV.getMapName()
OV.time()
OV.players()
OV.playerByUserId(userId)
OV.broadcast(msg)
OV.serverCommand(cmd)
OV.fireHook(name, ...args)
```

Player wrapper APIs:

```js
ply.userId()
ply.entIndex()
ply.steamId()
ply.name()
ply.health()
ply.setHealth(value)
ply.team()
ply.setTeam(team)
ply.chat(msg)
ply.runCommand("ov_prophunt_disguise crate")
```

Server and player command execution is allowlisted to `ov_*` commands.

## Reloading

In SRCDS:

```text
ov_js_status
ov_js_reload
ov_js_fire Initialize
ov_js_cmd smoke
```

## Next Native Hooks To Add

Good next bridge events:

```text
EntityTakeDamage(entity, damageInfo)
PlayerUse(ply, entity)
PlayerCanPickupWeapon(ply, weapon)
PlayerLoadout(ply)
RoundStart
RoundEnd
```
