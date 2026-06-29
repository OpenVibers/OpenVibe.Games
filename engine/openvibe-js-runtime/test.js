/**
 * OpenVibe.JS Test Suite
 * Tests for hook system, gamemode loading, and game API
 */

const assert = require('assert');
const hook = require('./hook');
const { GameServer, Player } = require('./game-api');
const GamemodeLoader = require('./gamemode-loader');
const { OpenVibeRuntime } = require('./index');

console.log('=== OpenVibe.JS Test Suite ===\n');

// Test 1: Hook System
console.log('Test 1: Hook System');
try {
  hook.clear();

  let callCount = 0;
  hook.on('TestEvent', 'handler1', (value) => {
    callCount += value;
  });

  hook.emit('TestEvent', 5);
  assert.strictEqual(callCount, 5, 'Hook should be called');

  hook.off('TestEvent', 'handler1');
  hook.emit('TestEvent', 5);
  assert.strictEqual(callCount, 5, 'Hook should not be called after off()');

  console.log('✓ Hook system works\n');
} catch (err) {
  console.error('✗ Hook system failed:', err.message, '\n');
}

// Test 2: Multiple Hooks
console.log('Test 2: Multiple Hooks');
try {
  hook.clear();

  let result = '';
  hook.on('Event', 'h1', () => {
    result += 'A';
  });
  hook.on('Event', 'h2', () => {
    result += 'B';
  });

  hook.emit('Event');
  assert.strictEqual(result, 'AB', 'Both hooks should be called');

  console.log('✓ Multiple hooks work\n');
} catch (err) {
  console.error('✗ Multiple hooks failed:', err.message, '\n');
}

// Test 3: GameServer API
console.log('Test 3: GameServer API');
try {
  const server = new GameServer();

  const p1 = server.addPlayer('76561198000000001', 'Player1');
  assert.strictEqual(server.getPlayerCount(), 1, 'Player count should be 1');
  assert.strictEqual(p1.name, 'Player1', 'Player name should match');

  const p2 = server.addPlayer('76561198000000002', 'Player2');
  assert.strictEqual(server.getPlayerCount(), 2, 'Player count should be 2');

  server.removePlayer('76561198000000001');
  assert.strictEqual(server.getPlayerCount(), 1, 'Player count should be 1 after removal');

  console.log('✓ GameServer API works\n');
} catch (err) {
  console.error('✗ GameServer API failed:', err.message, '\n');
}

// Test 4: Player NetVars
console.log('Test 4: Player NetVars');
try {
  const player = new Player('123', 'TestPlayer');

  player.setNetVar('health', 100);
  assert.strictEqual(player.getNetVar('health'), 100, 'NetVar should be set');

  player.setNetVar('health', 50);
  assert.strictEqual(player.getNetVar('health'), 50, 'NetVar should be updated');

  console.log('✓ Player NetVars work\n');
} catch (err) {
  console.error('✗ Player NetVars failed:', err.message, '\n');
}

// Test 5: Round State Changes
console.log('Test 5: Round State Changes');
try {
  hook.clear();
  const server = new GameServer();

  let stateChangeCount = 0;
  hook.on('RoundStateChanged', 'test', () => {
    stateChangeCount++;
  });

  server.setRoundState('active');
  assert.strictEqual(server.getRoundState(), 'active', 'Round state should be active');
  assert.strictEqual(stateChangeCount, 1, 'State change hook should fire');

  console.log('✓ Round state changes work\n');
} catch (err) {
  console.error('✗ Round state changes failed:', err.message, '\n');
}

// Test 6: Gamemode Loading (Mock)
console.log('Test 6: Gamemode Loading');
try {
  hook.clear();

  // Mock a simple gamemode module
  const mockGamemode = {
    name: 'TestMode',
    version: '1.0.0',
    onLoad: function(server) {
      console.log('    [Mock] TestMode loaded');
    },
    onStart: function(server, config) {
      console.log('    [Mock] TestMode started');
    },
    onStop: function(server) {
      console.log('    [Mock] TestMode stopped');
    },
  };

  const server = new GameServer();
  server.loadGamemode(mockGamemode);

  assert.strictEqual(server.gamemode.name, 'TestMode', 'Gamemode should be loaded');

  console.log('✓ Gamemode loading works\n');
} catch (err) {
  console.error('✗ Gamemode loading failed:', err.message, '\n');
}

// Test 7: Hook Queue (Async - runs after main tests)
console.log('Test 7: Hook Queue');
hook.clear();

let emissions = [];
hook.on('QueuedEvent', 'test', (val) => {
  emissions.push(val);
});

hook.queue('QueuedEvent', 1);
hook.queue('QueuedEvent', 2);
hook.queue('QueuedEvent', 3);

// Test 8: OpenVibe Runtime
console.log('Test 8: OpenVibe Runtime');
try {
  const runtime = new OpenVibeRuntime();
  assert.strictEqual(runtime.isInitialized, false, 'Should not be initialized');

  // Note: Can't fully test without real gamemodes directory
  console.log('✓ OpenVibe runtime instantiation works\n');
} catch (err) {
  console.error('✗ OpenVibe runtime failed:', err.message, '\n');
}

// Give async queue time to process - this runs after all other tests
setTimeout(() => {
  try {
    assert.strictEqual(
      emissions.length,
      3,
      'All queued hooks should be processed'
    );
    console.log('✓ Hook queue works\n');
  } catch (err) {
    console.error('✗ Hook queue failed:', err.message, '\n');
  }
  console.log('=== Tests Complete ===');
}, 100);
