/**
 * OpenVibe Fort Wars Gamemode
 * 
 * Team-based fortress building and battle
 * Teams compete to destroy enemy fortresses while defending their own
 * 
 * Features:
 * - Real-time fort building
 * - Resource management
 * - Turret/defense systems
 * - Team coordination
 * - Base destruction win condition
 */

const hook = require('../../../engine/openvibe-js-runtime/hook');

module.exports = {
  name: 'Fort Wars',
  version: '1.0.0',
  description: 'Build and defend your fort',

  config: {
    maxPlayers: 32,
    roundTime: 1200, // 20 minutes
    teamCount: 2,
    buildMaterials: ['wood', 'stone', 'metal'],
    buildObjectTypes: [
      { name: 'Wall', cost: 100, health: 500 },
      { name: 'Turret', cost: 300, health: 200 },
      { name: 'Barricade', cost: 50, health: 100 },
    ],
  },

  roundState: 'prep',
  bases: {}, // teamId -> { health, objects: [] }
  playerResources: {}, // steamId -> { wood, stone, metal }

  onLoad(gameServer) {
    console.log('[FortWars] Loaded');
  },

  onStart(gameServer, config) {
    console.log('[FortWars] Starting');

    gameServer.mapName = 'ov_fortwars';

    // Initialize bases
    module.exports.bases[1] = { health: 1000, objects: [] };
    module.exports.bases[2] = { health: 1000, objects: [] };

    hook.on('PlayerJoined', 'fortwars-join', (player) => {
      module.exports.onPlayerJoin(gameServer, player);
    });

    hook.on('PlayerLeft', 'fortwars-leave', (player) => {
      module.exports.onPlayerLeave(gameServer, player);
    });

    module.exports.startRoundManagement(gameServer);
  },

  onStop(gameServer) {
    console.log('[FortWars] Stopping');
    hook.off('PlayerJoined', 'fortwars-join');
    hook.off('PlayerLeft', 'fortwars-leave');
  },

  onPlayerJoin(gameServer, player) {
    const team1 = gameServer
      .getPlayers()
      .filter((p) => p.team === 1).length;
    const team2 = gameServer
      .getPlayers()
      .filter((p) => p.team === 2).length;

    player.setTeam(team1 <= team2 ? 1 : 2);
    module.exports.playerResources[player.steamId] = {
      wood: 500,
      stone: 300,
      metal: 100,
    };
  },

  onPlayerLeave(gameServer, player) {
    delete module.exports.playerResources[player.steamId];
  },

  startRoundManagement(gameServer) {
    const tickRound = () => {
      // Generate resources for all players
      gameServer.getPlayers().forEach((player) => {
        const res = module.exports.playerResources[player.steamId];
        if (res) {
          res.wood += 1;
          res.stone += 0.5;
          res.metal += 0.25;
        }
      });

      setTimeout(tickRound, 1000);
    };

    tickRound();
  },

  // Build an object at a location
  buildObject(gameServer, player, objectType, location) {
    const objDef = module.exports.config.buildObjectTypes.find(
      (o) => o.name === objectType
    );
    if (!objDef) {
      console.error(`[FortWars] Unknown object: ${objectType}`);
      return false;
    }

    const res = module.exports.playerResources[player.steamId];
    if (!res || res.wood < objDef.cost) {
      console.log(`[FortWars] ${player.name} insufficient resources`);
      return false;
    }

    res.wood -= objDef.cost;
    console.log(
      `[FortWars] ${player.name} built ${objectType} at (${location.x}, ${location.y})`
    );

    const obj = {
      type: objectType,
      team: player.team,
      health: objDef.health,
      location,
    };
    module.exports.bases[player.team].objects.push(obj);

    hook.emit('ObjectBuilt', player, obj);
    return true;
  },

  // Damage base
  damageBase(gameServer, attackerTeam, damage) {
    const defendingTeam = attackerTeam === 1 ? 2 : 1;
    const base = module.exports.bases[defendingTeam];
    base.health -= damage;

    console.log(
      `[FortWars] Base ${defendingTeam} damaged (${base.health} health remaining)`
    );

    if (base.health <= 0) {
      module.exports.endRound(gameServer, attackerTeam);
    }
  },

  endRound(gameServer, winnerTeam) {
    console.log(`[FortWars] Team ${winnerTeam} won!`);
    module.exports.roundState = 'ending';

    gameServer.broadcast(`Team ${winnerTeam} destroyed the enemy base!`);

    setTimeout(() => {
      module.exports.bases = {
        1: { health: 1000, objects: [] },
        2: { health: 1000, objects: [] },
      };
      module.exports.roundState = 'prep';
      gameServer.broadcast('New round starting...');
    }, 5000);
  },

  // Get base status
  getBaseStatus() {
    return module.exports.bases;
  },

  // Get player resources
  getPlayerResources(steamId) {
    return module.exports.playerResources[steamId] || {};
  },
};
