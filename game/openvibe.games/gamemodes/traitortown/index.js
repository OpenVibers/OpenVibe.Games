/**
 * OpenVibe Traitor Town Gamemode
 * 
 * Innocents vs Traitors hidden among them
 * Find and eliminate traitors before time expires
 * 
 * Features:
 * - Role-based gameplay (Innocent/Traitor/Detective)
 * - Hidden role system
 * - Voting and elimination mechanics
 * - DNA/evidence collection
 * - Credit system for buying equipment
 */

const hook = require('../../../engine/openvibe-js-runtime/hook');

module.exports = {
  name: 'Traitor Town',
  version: '1.0.0',
  description: 'Find the traitors among innocents',

  config: {
    maxPlayers: 32,
    roundTime: 600, // 10 minutes
    minPlayers: 6,
    roles: {
      innocent: { traitorChance: 0.2, startingCredits: 0 },
      traitor: { startingCredits: 100 },
      detective: { traitorChance: 0.05, startingCredits: 50 },
    },
    equipment: [
      { id: 'pistol', name: 'Pistol', cost: 20 },
      { id: 'shotgun', name: 'Shotgun', cost: 60 },
      { id: 'scanner', name: 'DNA Scanner', cost: 50 },
      { id: 'radar', name: 'Radar Jammer', cost: 80 },
    ],
  },

  roundState: 'prep', // prep, active, voting, ending
  playerRoles: {}, // steamId -> 'innocent' | 'traitor' | 'detective'
  playerCredits: {}, // steamId -> credits
  deadPlayers: [], // Eliminated players
  roundTimeRemaining: 0,

  onLoad(gameServer) {
    console.log('[TraitorTown] Loaded');
  },

  onStart(gameServer, config) {
    console.log('[TraitorTown] Starting');

    gameServer.mapName = 'ov_traitortown';
    module.exports.roundTimeRemaining = module.exports.config.roundTime;
    module.exports.playerRoles = {};
    module.exports.playerCredits = {};
    module.exports.deadPlayers = [];

    hook.on('PlayerJoined', 'tt-join', (player) => {
      module.exports.onPlayerJoin(gameServer, player);
    });

    hook.on('PlayerLeft', 'tt-leave', (player) => {
      module.exports.onPlayerLeave(gameServer, player);
    });

    hook.on('PlayerDeath', 'tt-death', (deadPlayer, killer) => {
      module.exports.onPlayerDeath(gameServer, deadPlayer, killer);
    });

    module.exports.startRoundManagement(gameServer);
  },

  onStop(gameServer) {
    console.log('[TraitorTown] Stopping');
    hook.off('PlayerJoined', 'tt-join');
    hook.off('PlayerLeft', 'tt-leave');
    hook.off('PlayerDeath', 'tt-death');
  },

  onPlayerJoin(gameServer, player) {
    console.log(`[TraitorTown] ${player.name} joined`);
    player.setTeam(1); // Everyone on same team, roles are hidden
  },

  onPlayerLeave(gameServer, player) {
    console.log(`[TraitorTown] ${player.name} left`);
    const role = module.exports.playerRoles[player.steamId];
    if (role === 'traitor') {
      gameServer.broadcast(`A traitor has left the game!`);
    }
    delete module.exports.playerRoles[player.steamId];
    delete module.exports.playerCredits[player.steamId];
  },

  onPlayerDeath(gameServer, deadPlayer, killer) {
    const role = module.exports.playerRoles[deadPlayer.steamId] || 'innocent';
    console.log(`[TraitorTown] ${deadPlayer.name} (${role}) killed`);

    module.exports.deadPlayers.push({
      player: deadPlayer,
      role,
      killer,
    });

    // Reveal role to everyone
    gameServer.broadcast(`${deadPlayer.name} was ${role}`);

    if (killer && killer.steamId !== deadPlayer.steamId) {
      killer.setData('kills', (killer.getData('kills') || 0) + 1);

      // Award credits for kills
      module.exports.playerCredits[killer.steamId] =
        (module.exports.playerCredits[killer.steamId] || 0) + 50;
    }

    // Check win conditions
    module.exports.checkWinConditions(gameServer);
  },

  startRoundManagement(gameServer) {
    const tickRound = () => {
      if (module.exports.roundState === 'prep') {
        // Wait for enough players and time
        if (
          gameServer.getPlayerCount() >= module.exports.config.minPlayers &&
          module.exports.roundTimeRemaining <= 0
        ) {
          module.exports.assignRoles(gameServer);
          module.exports.startRound(gameServer);
        }
      } else if (module.exports.roundState === 'active') {
        module.exports.roundTimeRemaining--;

        if (module.exports.roundTimeRemaining <= 0) {
          module.exports.endRound(gameServer, 'time');
        }
      }

      setTimeout(tickRound, 1000);
    };

    module.exports.roundTimeRemaining = 30; // Prep time
    tickRound();
  },

  assignRoles(gameServer) {
    const players = gameServer.getPlayers();
    const numTraitors = Math.max(1, Math.floor(players.length * 0.2));
    const numDetectives = Math.max(1, Math.floor(players.length * 0.1));

    // Shuffle roles
    const roles = [];
    players.forEach(() => roles.push('innocent'));

    // Randomly select traitors and detectives
    for (let i = 0; i < numTraitors; i++) {
      const idx = Math.floor(Math.random() * players.length);
      roles[idx] = 'traitor';
    }

    for (let i = 0; i < numDetectives; i++) {
      let idx = Math.floor(Math.random() * players.length);
      while (roles[idx] !== 'innocent') {
        idx = Math.floor(Math.random() * players.length);
      }
      roles[idx] = 'detective';
    }

    // Assign roles
    players.forEach((player, idx) => {
      const role = roles[idx];
      module.exports.playerRoles[player.steamId] = role;
      module.exports.playerCredits[player.steamId] =
        module.exports.config.roles[role].startingCredits;

      console.log(`[TraitorTown] ${player.name} is ${role}`);

      // Tell player their role (only visible to them)
      hook.emit('PlayerRoleAssigned', player, role);
    });

    gameServer.broadcast('Roles assigned! Round starting...');
  },

  startRound(gameServer) {
    console.log('[TraitorTown] Round started');
    module.exports.roundState = 'active';
    module.exports.roundTimeRemaining = module.exports.config.roundTime;
    gameServer.broadcast('FIND THE TRAITORS!');
  },

  endRound(gameServer, reason) {
    console.log(`[TraitorTown] Round ended (${reason})`);
    module.exports.roundState = 'ending';

    // Determine winner
    const aliveTraitors = gameServer
      .getPlayers()
      .filter(
        (p) =>
          !module.exports.deadPlayers.find((d) => d.player.steamId === p.steamId)
      )
      .filter(
        (p) => module.exports.playerRoles[p.steamId] === 'traitor'
      ).length;

    if (aliveTraitors > 0) {
      gameServer.broadcast('TRAITORS WIN!');
    } else {
      gameServer.broadcast('INNOCENTS WIN!');
    }

    // Reset for next round
    setTimeout(() => {
      module.exports.playerRoles = {};
      module.exports.playerCredits = {};
      module.exports.deadPlayers = [];
      module.exports.roundState = 'prep';
      module.exports.roundTimeRemaining = 30;
      gameServer.broadcast('Next round starting...');
    }, 5000);
  },

  checkWinConditions(gameServer) {
    const aliveTraitors = gameServer
      .getPlayers()
      .filter(
        (p) =>
          !module.exports.deadPlayers.find((d) => d.player.steamId === p.steamId)
      )
      .filter(
        (p) => module.exports.playerRoles[p.steamId] === 'traitor'
      ).length;

    const aliveInnocents = gameServer
      .getPlayers()
      .filter(
        (p) =>
          !module.exports.deadPlayers.find((d) => d.player.steamId === p.steamId)
      )
      .filter(
        (p) => module.exports.playerRoles[p.steamId] !== 'traitor'
      ).length;

    if (aliveTraitors === 0) {
      module.exports.endRound(gameServer, 'allTraitorsEliminated');
    } else if (aliveInnocents === 0) {
      module.exports.endRound(gameServer, 'allInnocentsEliminated');
    }
  },

  // Get player's role (only visible if player is dead or is that player)
  getPlayerRole(viewerPlayer, targetPlayer) {
    const isDead = module.exports.deadPlayers.find(
      (d) => d.player.steamId === viewerPlayer.steamId
    );
    const isTarget = viewerPlayer.steamId === targetPlayer.steamId;

    if (isDead || isTarget) {
      return module.exports.playerRoles[targetPlayer.steamId];
    }
    return null; // Hidden
  },

  // Buy equipment with credits
  buyEquipment(gameServer, player, equipmentId) {
    const equipment = module.exports.config.equipment.find(
      (e) => e.id === equipmentId
    );
    if (!equipment) {
      return false;
    }

    const credits = module.exports.playerCredits[player.steamId] || 0;
    if (credits < equipment.cost) {
      console.log(`[TraitorTown] ${player.name} insufficient credits`);
      return false;
    }

    module.exports.playerCredits[player.steamId] -= equipment.cost;
    console.log(
      `[TraitorTown] ${player.name} bought ${equipment.name}`
    );

    hook.emit('EquipmentPurchased', player, equipment);
    return true;
  },
};
