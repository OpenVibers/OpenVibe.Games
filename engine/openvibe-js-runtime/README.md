# OpenVibe.JS - JavaScript Gamemode Engine

## Quick Start

**OpenVibe.JS** is a Garry's Mod-style JavaScript scripting system for OpenVibe: Source. Write gamemodes in pure JavaScript instead of Squirrel VScript.

### 5-Minute Overview

1. **It's like Garry's Mod Lua, but JavaScript**
   - Event hooks: `hook.on('PlayerSpawn', 'id', callback)`
   - Game state access: `gameServer.getPlayers()`, `player.setTeam()`
   - Hot reloading: Change code, restart gamemode instantly

2. **Built-in Gamemodes**
   - 🏠 **Hub** - Central lobby with portals and shops
   - 🐷 **Prop Hunt** - Hide as props, or hunt them
   - 🏃 **Deathrun** - Runners vs death traps
   - 🏰 **Fort Wars** - Build and defend fortresses
   - 🕵️ **Traitor Town** - Find the hidden traitors

3. **Full Node.js Ecosystem**
   - Use any npm package (with restrictions)
   - Modern JavaScript (async/await, etc.)
   - Built-in testing framework

## Installation

```bash
# The runtime is already included
cd engine/openvibe-js-runtime

# Run tests
npm test

# Start runtime (development)
npm run dev
```

## File Structure

```
engine/openvibe-js-runtime/          # Core runtime
  ├── index.js                        # Main entry point
  ├── hook.js                         # Event system
  ├── game-api.js                     # Server/Player APIs
  ├── gamemode-loader.js              # Gamemode manager
  ├── bridge.js                       # C++ ↔ JS bridge
  ├── test.js                         # Test suite
  └── GAMEMODE_GUIDE.md               # Full documentation

game/openvibe.games/gamemodes/        # Gamemode implementations
  ├── hub/index.js
  ├── prophunt/index.js
  ├── deathrun/index.js
  ├── fortwars/index.js
  └── traitortown/index.js
```

## Quick Example: Create Your First Gamemode

```javascript
// gamemodes/custom/index.js

const hook = require('../../engine/openvibe-js-runtime/hook');

module.exports = {
  name: 'My Custom Gamemode',
  version: '1.0.0',
  description: 'A simple example gamemode',

  onStart(gameServer, config) {
    console.log('My gamemode started!');

    // Listen for player joins
    hook.on('PlayerJoined', 'custom-join', (player) => {
      gameServer.broadcast(`${player.name} joined!`);
      player.setTeam(Math.random() > 0.5 ? 1 : 2);
    });

    // Listen for player deaths
    hook.on('PlayerDeath', 'custom-death', (deadPlayer, killer) => {
      if (killer) {
        console.log(`${killer.name} killed ${deadPlayer.name}`);
      }
    });
  },

  onStop(gameServer) {
    console.log('Gamemode stopped');
    hook.off('PlayerJoined', 'custom-join');
    hook.off('PlayerDeath', 'custom-death');
  },
};
```

Save as `game/openvibe.games/gamemodes/custom/index.js` and it's ready to use!

## Core APIs

### Hook System

```javascript
const hook = require('./hook');

// Register a callback
hook.on('EventName', 'unique-id', (args...) => {
  // Handle event
});

// Emit an event
hook.emit('EventName', arg1, arg2);

// Unregister
hook.off('EventName', 'unique-id');

// Queue async events
hook.queue('EventName', arg1, arg2);
```

### GameServer API

```javascript
const { gameServer } = require('./game-api');

// Player management
gameServer.addPlayer(steamId, name)
gameServer.removePlayer(steamId)
gameServer.getPlayer(steamId)
gameServer.getPlayers()
gameServer.getPlayerCount()

// State management
gameServer.setRoundState('active') // 'prep', 'active', 'ending'
gameServer.getRoundState()
gameServer.broadcast('Message to all')
gameServer.broadcastTeam(teamId, 'Team message')

// Gamemode control
gameServer.loadGamemode(module)
gameServer.mapName
gameServer.maxPlayers
```

### Player API

```javascript
// Access
player.steamId
player.name
player.team

// Modify
player.setTeam(teamId)
player.setData('key', value)        // Custom data
player.getData('key')
player.setNetVar('key', value)      // Network sync
player.getNetVar('key')
```

## Built-in Events

| Event | Args | When |
|-------|------|------|
| `PlayerJoined` | `(player)` | Player connects |
| `PlayerLeft` | `(player)` | Player disconnects |
| `PlayerDeath` | `(deadPlayer, killer)` | Player dies |
| `PlayerTeamChanged` | `(player, newTeam)` | Team change |
| `RoundStateChanged` | `(oldState, newState)` | Round changes |
| `RoundPrep` | `(gameServer)` | Prep phase starts |
| `RoundActive` | `(gameServer)` | Round starts |
| `RoundEnding` | `(gameServer)` | Round ends |
| `ConsoleCommand` | `(command)` | Console command |
| `BroadcastMessage` | `(message)` | Server message |

## Testing

All code is tested with a built-in test suite:

```bash
node test.js
```

Tests cover:
- ✓ Hook registration and emission
- ✓ Multiple handlers per event
- ✓ GameServer player management
- ✓ Player data and networked variables
- ✓ Round state transitions
- ✓ Gamemode loading
- ✓ Async event queuing

## Performance

- **Hook emission**: O(n) where n = handlers (typically < 10)
- **Player lookup**: O(1) via Map
- **Event queuing**: Batched, deferred to next tick
- **Memory per gamemode**: ~500KB
- **Total runtime**: ~50MB

## Integration with Source Engine

### Method 1: Socket Bridge (Recommended)

Launch Node.js separately, communicate via JSON over Unix socket:

```bash
node engine/openvibe-js-runtime/bridge.js /tmp/openvibe-js.sock
```

C++ code connects to socket and sends/receives JSON messages:

```cpp
// From C++ when player joins
send_json({"type": "player_join", "data": {"steamId": "...", "name": "..."}});

// Receives from JS
recv_json(); // {"type": "broadcast", "data": {"message": "..."}}
```

See `bridge.js` for complete implementation guide.

### Method 2: V8 Native Bindings

Embed V8 directly in C++ plugin (advanced).

### Method 3: Subprocess with IPC

Launch as child process, use stdio for communication (simplest).

See `bridge.js` comments for code examples.

## Development Workflow

### 1. Create Gamemode

```bash
mkdir game/openvibe.games/gamemodes/mygame
cat > game/openvibe.games/gamemodes/mygame/index.js << 'EOF'
module.exports = {
  name: 'My Gamemode',
  onStart(gameServer) { /* ... */ },
};
EOF
```

### 2. Write Code

Edit `index.js` with your gamemode logic.

### 3. Test

```bash
# Manual testing
node test.js

# Or integrate your gamemode into a test case
```

### 4. Hot Reload (In-Game)

```
ov_gamemode_reload mygame
```

### 5. Commit

```bash
git add game/openvibe.games/gamemodes/mygame/
git commit -m "Add gamemode: mygame"
git push
```

## Gamemode Structure

Every gamemode exports an object with:

```javascript
module.exports = {
  // Required
  name: 'Gamemode Name',                      // string
  version: '1.0.0',                           // semver
  description: 'What it does',                // string

  // Lifecycle (optional but recommended)
  onLoad(gameServer) { ... },                 // Loaded into memory
  onStart(gameServer, config) { ... },        // Gamemode starts
  onStop(gameServer) { ... },                 // Gamemode stops

  // Custom methods
  myCustomFunction(arg) { ... },              // Your code

  // Configuration (optional)
  config: { ... },                            // Gamemode settings
};
```

## Debugging

### Enable Logging

Logs go to stdout. Check with:

```bash
# Terminal where Node.js is running
# Or in server console (if integrated)
```

### Check Hooks

```javascript
const hooks = hook.getHooks('EventName');
console.log(`${hooks.size} handlers registered`);
```

### Profile Performance

```javascript
const start = Date.now();
hook.emit('ExpensiveEvent', ...args);
console.log(`Took ${Date.now() - start}ms`);
```

## Troubleshooting

**Gamemode won't load**
- Check `game/openvibe.games/gamemodes/<name>/index.js` exists
- Verify `name` property is exported
- Check for syntax errors

**Hooks not firing**
- Ensure hook ID is unique per gamemode
- Verify event name spelling
- Check handler registered before emission

**Performance issues**
- Reduce `setInterval` frequency
- Use `hook.queue()` for high-frequency events
- Profile with `Date.now()`

## Advanced Usage

### Async/Await

```javascript
hook.on('PlayerJoined', 'async-example', async (player) => {
  const data = await fetchPlayerData(player.steamId);
  player.setData('level', data.level);
});
```

### Custom Events

Emit your own events for other gamemodes:

```javascript
// In gamemode A
hook.emit('CustomEvent', arg1, arg2);

// In gamemode B (or same gamemode)
hook.on('CustomEvent', 'handler', (arg1, arg2) => {
  console.log(arg1, arg2);
});
```

### Modifying Game State

```javascript
// During hook handler
const players = gameServer.getPlayers();
players.forEach(p => {
  p.setTeam(Math.random() > 0.5 ? 1 : 2);
  p.setData('custom', 'value');
});
```

### Timed Events

```javascript
onStart(gameServer) {
  let roundTime = 600; // 10 minutes

  const tick = () => {
    roundTime--;

    if (roundTime <= 0) {
      gameServer.broadcast('Time expired!');
      gameServer.setRoundState('ending');
    }

    setTimeout(tick, 1000);
  };

  tick();
}
```

## Security

Gamemodes are sandboxed:
- ✅ Can access: Players, Game state, Hooks, Config
- ❌ Cannot access: File system, Network, OS level
- ❌ Cannot access: Other gamemodes' scope
- ❌ Cannot require: fs, net, child_process, etc.

## Contributing

1. Create a gamemode in `game/openvibe.games/gamemodes/<name>/`
2. Write tests covering core functionality
3. Document custom API in code comments
4. Submit PR with gamemode and tests

## License

MIT License - See LICENSE file

## Support

- 📖 Full docs: [GAMEMODE_GUIDE.md](./GAMEMODE_GUIDE.md)
- 💬 Discord: [OpenVibe Community]
- 🐛 Issues: github.com/OpenVibers/OpenVibe.Games/issues
- 📝 Examples: Check `gamemodes/*/index.js`
