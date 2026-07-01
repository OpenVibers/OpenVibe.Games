# OpenVibe.JS - JavaScript Gamemode Engine

A Garry's Mod-style JavaScript/Node.js scripting system for OpenVibe: Source. Write gamemodes, modify gameplay mechanics, and extend the engine all in JavaScript.

## Overview

OpenVibe.JS is a complete gamemode scripting framework similar to Garry's Mod's Lua system. Instead of Squirrel VScript, gamemodes are written in JavaScript and loaded dynamically at runtime.

**Key Features:**
- 🎮 **Hook System** - Register callbacks for game events
- 🔄 **Hot Reloading** - Reload gamemodes without server restart
- 📦 **Modular Gamemodes** - Each gamemode is a self-contained module
- 🌐 **Event-Driven** - Fully async, event-based architecture
- ⚡ **Performance** - Native V8 JavaScript runtime
- 🛡️ **Sandboxed** - Restricts gamemode access to safe APIs

## Architecture

```
OpenVibe.JS Runtime (index.js)
    ↓
Gamemode Loader (gamemode-loader.js)
    ↓
Hook System (hook.js) ←→ Game API (game-api.js)
    ↓
Gamemodes (gamemodes/)
    - hub/
    - prophunt/
    - deathrun/
    - fortwars/
    - traitortown/
```

### Components

#### **Hook System** (`hook.js`)
The event dispatcher for the entire engine. Similar to GMod's `hook.Add()` and `hook.Call()`.

```javascript
const hook = require('./hook');

// Register a handler
hook.on('PlayerSpawn', 'my-unique-id', (player) => {
  console.log(`${player.name} spawned`);
});

// Emit an event
hook.emit('PlayerSpawn', player);

// Unregister a handler
hook.off('PlayerSpawn', 'my-unique-id');

// Queue events for async processing
hook.queue('PlayerSpawn', player);
```

#### **Game API** (`game-api.js`)
Exposes server state and functions to gamemodes. Provides `Player`, `GameServer` classes.

```javascript
const { gameServer, Player } = require('./game-api');

// Access players
const players = gameServer.getPlayers();
const player = gameServer.getPlayer(steamId);

// Manage round state
gameServer.setRoundState('active'); // 'prep', 'active', 'ending'
gameServer.broadcast('Message to all players');

// Access/set player data
player.setData('role', 'innocent');
player.getData('role'); // Returns 'innocent'

// Network variables (synced to clients)
player.setNetVar('health', 100);
```

#### **Gamemode Loader** (`gamemode-loader.js`)
Dynamically loads, manages, and coordinates gamemode lifecycle.

```javascript
const GamemodeLoader = require('./gamemode-loader');
const loader = new GamemodeLoader('./gamemodes');

// Load a gamemode
loader.load('prophunt');

// Start it
loader.start('prophunt', { maxPlayers: 32 });

// Reload (for dev)
loader.reload('prophunt');

// Stop it
loader.stop();
```

#### **OpenVibe Runtime** (`index.js`)
Main entry point. Singleton that orchestrates everything.

```javascript
const { runtime } = require('./index');

runtime.initialize();
runtime.startGamemode('hub');
runtime.stopGamemode();
runtime.reloadGamemode('hub');
```

## Writing Gamemodes

A gamemode is a Node.js module (directory with `index.js`).

### Minimal Gamemode Template

```javascript
// gamemodes/mygame/index.js

module.exports = {
  // Required
  name: 'My Game Mode',
  version: '1.0.0',
  description: 'A custom gamemode',

  // Lifecycle hooks
  onLoad(gameServer) {
    console.log('Gamemode loaded');
  },

  onStart(gameServer, config) {
    console.log('Gamemode started');
    
    // Register event handlers
    hook.on('PlayerJoined', 'mygame-join', (player) => {
      // Handle player join
    });
  },

  onStop(gameServer) {
    console.log('Gamemode stopped');
    
    // Cleanup
    hook.off('PlayerJoined', 'mygame-join');
  },

  // Custom methods/exports
  customMethod(gameServer) {
    // ...
  },
};
```

### Lifecycle Events

Every gamemode receives these callbacks:

| Event | When | Example |
|-------|------|---------|
| `onLoad(server)` | Gamemode loaded into memory | Initialize static data |
| `onStart(server, config)` | Gamemode activated | Register hooks, start timers |
| `onStop(server)` | Gamemode deactivated | Cleanup, remove hooks |

### Common Hooks

Gamemodes can listen to these built-in hooks:

| Hook | Arguments | When |
|------|-----------|------|
| `PlayerJoined` | `(player)` | Player connects |
| `PlayerLeft` | `(player)` | Player disconnects |
| `PlayerDeath` | `(deadPlayer, killer)` | Player dies |
| `PlayerTeamChanged` | `(player, team)` | Player switches team |
| `RoundStateChanged` | `(oldState, newState)` | Round state changes |
| `ConsoleCommand` | `(cmd)` | Console command executed |
| `BroadcastMessage` | `(message)` | Server broadcasts message |

### Example: Prop Hunt Gamemode

```javascript
const hook = require('./hook');

module.exports = {
  name: 'Prop Hunt',
  onStart(gameServer, config) {
    // Setup teams
    hook.on('PlayerJoined', 'prophunt-join', (player) => {
      player.setTeam(Math.random() > 0.5 ? 2 : 3); // 50/50 split
    });

    // Game loop
    setInterval(() => {
      gameServer.getPlayers().forEach(player => {
        // Check for player interactions
        if (player.getData('nearProp')) {
          hook.emit('PlayerPickProp', player);
        }
      });
    }, 100);
  },

  onStop(gameServer) {
    hook.off('PlayerJoined', 'prophunt-join');
  },

  setPropModel(player, modelPath) {
    player.setNetVar('prop_model', modelPath);
    hook.emit('PropModelChanged', player, modelPath);
  },
};
```

## Built-in Gamemodes

### Hub
Central lobbies with portals to other gamemodes, shops, and cosmetics.
- File: `gamemodes/hub/index.js`
- Players spawn randomly
- Portal interaction to join other modes
- Shop NPCs for cosmetics

### Prop Hunt
Hunters vs props that can disguise as map objects.
- File: `gamemodes/prophunt/index.js`
- Teams rotate between hunters and props
- Props select from model list
- Time-based round ending

### Deathrun
Runners vs deaths with trap activation mechanics.
- File: `gamemodes/deathrun/index.js`
- Runners race to escape
- Deaths activate environmental traps
- Trap cooldown system

### Fort Wars
Team-based fortress building and siege.
- File: `gamemodes/fortwars/index.js`
- Real-time base construction
- Resource gathering
- Destructible structures

### Traitor Town
Hidden role game (similar to TTT).
- File: `gamemodes/traitortown/index.js`
- Innocents, Traitors, Detectives
- Hidden role system
- Equipment purchases with credits

## Player API Reference

```javascript
const player = gameServer.getPlayer(steamId);

// Identity
player.steamId          // SteamID64 string
player.name             // Display name
player.team             // Team number (1, 2, 3, etc)

// Methods
player.setTeam(team)                // Change team
player.setData(key, value)          // Set custom data
player.getData(key)                 // Get custom data
player.setNetVar(key, value)        // Sync var to client
player.getNetVar(key)               // Get networked var
```

## GameServer API Reference

```javascript
// Player management
gameServer.getPlayer(steamId)       // Get by SteamID
gameServer.addPlayer(steamId, name) // Create player
gameServer.removePlayer(steamId)    // Remove player
gameServer.getPlayers()             // Get all players
gameServer.getPlayerCount()         // Get count

// Round/State
gameServer.getRoundState()          // Current state
gameServer.setRoundState(state)     // Change state
gameServer.broadcast(message)       // Announce to all
gameServer.broadcastTeam(team, msg) // Announce to team

// Configuration
gameServer.maxPlayers               // Max player count
gameServer.mapName                  // Current map

// Execution
gameServer.execCommand(cmd)         // Run console command
gameServer.loadGamemode(module)     // Load gamemode
```

## Hook API Reference

```javascript
// Register handler
hook.on(eventName, handlerId, callback)

// Unregister handler
hook.off(eventName, handlerId)

// Emit event (synchronously)
hook.emit(eventName, ...args)

// Queue event (asynchronous, batched)
hook.queue(eventName, ...args)

// Get all handlers for event
hook.getHooks(eventName)

// Clear all hooks (testing)
hook.clear()
```

## Integration with C++

### Method 1: V8 Bindings (Native)

Create C++ code that directly calls JavaScript via V8:

```cpp
#include <v8.h>
using namespace v8;

// In Source plugin
Local<Script> script = Script::Compile("runtime.startGamemode('hub')");
script->Run();
```

### Method 2: IPC / Socket

Launch Node.js in a separate process and communicate via named pipes or localhost socket:

```cpp
// C++ to JS communication
send_ipc_message("join_player", {steamId: "123", name: "Player"});

// JS to C++ communication (via ISteamHTMLSurface)
window.location.href = "openvibe://join?mode=prophunt";
```

### Method 3: Direct Node.js Embedding

Use node-gyp to create a C++ native module that loads the OpenVibe.JS runtime directly.

## Testing

Run the test suite:

```bash
cd engine/openvibe-js-runtime
node test.js
```

Tests cover:
- ✓ Hook system
- ✓ GameServer API
- ✓ Player management
- ✓ Round state changes
- ✓ Gamemode loading
- ✓ Event queuing

## Performance Considerations

- **Hook System**: O(n) where n = number of handlers per event (typically < 10)
- **Player Lookup**: O(1) via Map (SteamID → Player)
- **Event Emission**: Synchronous, no yield (unless explicitly queued)
- **Gamemode Memory**: ~500KB per loaded gamemode
- **Runtime Memory**: ~50MB for full runtime

## Security

OpenVibe.JS gamemodes should only have access to:
- ✅ Player data
- ✅ Game state
- ✅ Hook system
- ✅ Config files

They should NOT access:
- ❌ File system directly
- ❌ Network (except openvibe:// bridge)
- ❌ C++ internals
- ❌ Other gamemodes' memory

This is enforced by:
1. Running gamemodes in require() sandbox
2. No `require('fs')`, `require('net')`, etc
3. Allowlist-only API exposure

## Development Workflow

### 1. Create a Gamemode

```bash
mkdir gamemodes/mygame
touch gamemodes/mygame/index.js
```

### 2. Write Code

```javascript
// gamemodes/mygame/index.js
module.exports = {
  name: 'My Gamemode',
  onStart(gameServer) { /* ... */ },
};
```

### 3. Test Locally

```bash
node engine/openvibe-js-runtime/test.js
```

### 4. Hot Reload

```bash
ov_gamemode_reload mygame
```

### 5. Commit & Push

```bash
git add gamemodes/mygame/
git commit -m "Add custom gamemode: mygame"
git push
```

## Troubleshooting

### Gamemode Won't Load
Check logs: `[Gamemode] Failed to load <name>: <error>`

Common issues:
- Missing `index.js` in gamemode directory
- Missing required exports (e.g., `name` property)
- Syntax errors in gamemode code
- Relative path issues with requires

### Hooks Not Firing
1. Verify event name spelling
2. Check hook was registered before event emission
3. Ensure callback doesn't throw errors (wrapped in try/catch)

### Performance Issues
1. Profile hook count: `hook.getHooks('EventName').size`
2. Check for infinite loops in think functions
3. Use `hook.queue()` instead of `hook.emit()` for high-frequency events
4. Reduce `setInterval`/`setTimeout` frequency

## Future Enhancements

- [ ] Gamemode hot-swapping without unload
- [ ] TypeScript support (.ts gamemodes)
- [ ] Debugger integration (VSCode)
- [ ] Gamemode marketplace/downloads
- [ ] Performance profiling built-in
- [ ] Multiplayer hook execution (cross-server)
- [ ] WebAssembly support for perf-critical code

## License

MIT - See LICENSE file

## Contributing

1. Create gamemode in `gamemodes/<name>/`
2. Add tests to `engine/openvibe-js-runtime/test.js`
3. Run test suite
4. Submit PR with gamemode and tests

## Support

- **Documentation**: See README.md and GAMEMODE_GUIDE.md
- **Examples**: See gamemodes/ directory
- **Issues**: github.com/OpenVibers/OpenVibe.Games/issues
- **Discord**: [OpenVibe Community Discord]
