/**
 * OpenVibe Hub Gamemode
 * Central hub with portals to other gamemodes, shops, and players
 * 
 * Features:
 * - Spawn management
 * - Shop/inventory system
 * - Teleport portals to other gamemodes
 * - Player interaction/grouping
 * - Global currency and cosmetics
 */

const hook = require('../../../engine/openvibe-js-runtime/hook');

module.exports = {
  name: 'OpenVibe Hub',
  version: '1.0.0',
  description: 'Central hub server with shops and portals',

  // Configuration
  config: {
    maxPlayers: 64,
    spawnLocations: [
      { x: 0, y: 0, z: 64 },
      { x: 100, y: 0, z: 64 },
      { x: -100, y: 0, z: 64 },
      { x: 0, y: 100, z: 64 },
    ],
    portals: [
      { name: 'Prop Hunt', mode: 'prophunt', pos: { x: 500, y: 0, z: 64 } },
      { name: 'Deathrun', mode: 'deathrun', pos: { x: 600, y: 0, z: 64 } },
      { name: 'Fort Wars', mode: 'fortwars', pos: { x: 700, y: 0, z: 64 } },
      { name: 'Traitor Town', mode: 'traitortown', pos: { x: 800, y: 0, z: 64 } },
    ],
    shops: [
      { name: 'Model Shop', npcPos: { x: -500, y: 0, z: 64 } },
      { name: 'Trail Shop', npcPos: { x: -600, y: 0, z: 64 } },
    ],
  },

  // Called when gamemode is loaded
  onLoad(gameServer) {
    console.log(`[Hub] Loaded - Ready for ${gameServer.maxPlayers} players`);
  },

  // Called when gamemode starts
  onStart(gameServer, config) {
    console.log('[Hub] Starting');

    // Set map and round state
    gameServer.mapName = 'ov_hub';
    gameServer.setRoundState('active');

    // Register hub-specific hooks
    hook.on('PlayerJoined', 'hub-spawn-player', (player) => {
      module.exports.spawnPlayer(gameServer, player);
    });

    hook.on('PlayerLeft', 'hub-player-left', (player) => {
      console.log(`[Hub] Player ${player.name} left the hub`);
    });

    hook.on('ConsoleCommand', 'hub-commands', (cmd) => {
      if (cmd.startsWith('ov_hub_')) {
        module.exports.handleHubCommand(gameServer, cmd);
      }
    });

    // Hub think (like Entity:Think() in Lua)
    module.exports.startThink(gameServer);
  },

  // Called when gamemode stops
  onStop(gameServer) {
    console.log('[Hub] Stopping');
    // Clean up: remove hooks, etc
    hook.off('PlayerJoined', 'hub-spawn-player');
    hook.off('PlayerLeft', 'hub-player-left');
    hook.off('ConsoleCommand', 'hub-commands');
  },

  // Spawn a player at a random spawn location
  spawnPlayer(gameServer, player) {
    const spawns = module.exports.config.spawnLocations;
    const spawn = spawns[Math.floor(Math.random() * spawns.length)];

    console.log(
      `[Hub] Spawning ${player.name} at (${spawn.x}, ${spawn.y}, ${spawn.z})`
    );

    // These would trigger actual engine commands
    hook.emit('SpawnPlayer', player, spawn);
    gameServer.broadcast(`${player.name} joined the hub`);
  },

  // Handle hub-specific console commands
  handleHubCommand(gameServer, cmd) {
    if (cmd === 'ov_hub_status') {
      const players = gameServer.getPlayers();
      console.log(`[Hub] Players: ${players.length}/${gameServer.maxPlayers}`);
      players.forEach((p) => {
        console.log(`  - ${p.name} (${p.steamId})`);
      });
    }
  },

  // Main game think loop (called every frame)
  startThink(gameServer) {
    const think = () => {
      // Update game state, check for interactions, etc
      const players = gameServer.getPlayers();

      players.forEach((player) => {
        // Check if player is near a portal
        module.exports.checkPortalInteraction(gameServer, player);

        // Check if player is near a shop
        module.exports.checkShopInteraction(gameServer, player);
      });

      // Think again next frame
      setImmediate(think);
    };

    think();
  },

  // Check if player is near a portal and emit interaction
  checkPortalInteraction(gameServer, player) {
    const portals = module.exports.config.portals;

    portals.forEach((portal) => {
      const dist = Math.hypot(
        player.x - portal.pos.x,
        player.y - portal.pos.y
      );

      // If within 100 units of portal
      if (dist < 100) {
        hook.emit('PlayerNearPortal', player, portal);
      }
    });
  },

  // Check if player is near a shop and emit interaction
  checkShopInteraction(gameServer, player) {
    const shops = module.exports.config.shops;

    shops.forEach((shop) => {
      const dist = Math.hypot(
        player.x - shop.npcPos.x,
        player.y - shop.npcPos.y
      );

      // If within 80 units of NPC
      if (dist < 80) {
        hook.emit('PlayerNearShop', player, shop);
      }
    });
  },

  // Portal interaction handler
  portalJoin(gameServer, player, mode) {
    console.log(`[Hub] ${player.name} joining ${mode}`);
    hook.emit('PlayerPortalJoin', player, mode);

    // This triggers the actual ov_join command to connect to the gamemode server
    gameServer.execCommand(`ov_join ${mode}`);
  },

  // Shop interaction handler
  shopOpen(gameServer, player, shopName) {
    console.log(`[Hub] Opening shop for ${player.name}: ${shopName}`);
    hook.emit('PlayerOpenShop', player, shopName);
  },
};
