/**
 * OpenVibe Deathrun Gamemode
 * 
 * A team of runners must reach the end while a team of death players
 * activate traps and obstacles to stop them
 * 
 * Features:
 * - Trap activation system
 * - Runners vs Death teams
 * - Checkpoint-based progression
 * - Trap mechanics and timing
 * - Win conditions based on reaching end or eliminating runners
 */

const hook = require('../../../engine/openvibe-js-runtime/hook');

module.exports = {
  name: 'Deathrun',
  version: '1.0.0',
  description: 'Runners vs Deaths - dodge traps to escape',

  config: {
    maxPlayers: 32,
    roundTime: 900, // 15 minutes
    runnerTeam: 2,
    deathTeam: 3,
    traps: [
      { id: 'trap_spikes', name: 'Spikes', cooldown: 5 },
      { id: 'trap_fire', name: 'Fire', cooldown: 8 },
      { id: 'trap_crush', name: 'Crusher', cooldown: 10 },
      { id: 'trap_push', name: 'Push', cooldown: 3 },
    ],
  },

  roundState: 'prep', // prep, active, ending
  roundTimeRemaining: 0,
  trapCooldowns: {}, // trapId -> secondsRemaining

  onLoad(gameServer) {
    console.log('[Deathrun] Loaded');
  },

  onStart(gameServer, config) {
    console.log('[Deathrun] Starting');

    gameServer.mapName = 'ov_deathrun';
    module.exports.roundTimeRemaining = module.exports.config.roundTime;

    // Initialize trap cooldowns
    module.exports.config.traps.forEach((trap) => {
      module.exports.trapCooldowns[trap.id] = 0;
    });

    // Register hooks
    hook.on('PlayerJoined', 'deathrun-player-join', (player) => {
      module.exports.onPlayerJoin(gameServer, player);
    });

    hook.on('PlayerLeft', 'deathrun-player-leave', (player) => {
      module.exports.onPlayerLeave(gameServer, player);
    });

    hook.on('PlayerDeath', 'deathrun-death', (deadPlayer, killer) => {
      module.exports.onPlayerDeath(gameServer, deadPlayer, killer);
    });

    // Start round management
    module.exports.startRoundManagement(gameServer);
  },

  onStop(gameServer) {
    console.log('[Deathrun] Stopping');
    hook.off('PlayerJoined', 'deathrun-player-join');
    hook.off('PlayerLeft', 'deathrun-player-leave');
    hook.off('PlayerDeath', 'deathrun-death');
  },

  onPlayerJoin(gameServer, player) {
    console.log(`[Deathrun] ${player.name} joined`);
    const runners = gameServer
      .getPlayers()
      .filter((p) => p.team === module.exports.config.runnerTeam).length;
    const deaths = gameServer
      .getPlayers()
      .filter((p) => p.team === module.exports.config.deathTeam).length;

    // Balance teams: more runners than deaths
    const newTeam =
      runners < deaths * 2
        ? module.exports.config.runnerTeam
        : module.exports.config.deathTeam;
    player.setTeam(newTeam);
    gameServer.broadcast(
      `${player.name} joined ${newTeam === module.exports.config.runnerTeam ? 'runners' : 'deaths'}`
    );
  },

  onPlayerLeave(gameServer, player) {
    console.log(`[Deathrun] ${player.name} left`);
  },

  onPlayerDeath(gameServer, deadPlayer, killer) {
    if (killer) {
      console.log(`[Deathrun] ${killer.name} killed ${deadPlayer.name}`);
      killer.setData('kills', (killer.getData('kills') || 0) + 1);
    } else {
      console.log(`[Deathrun] ${deadPlayer.name} died`);
    }

    // Respawn as same team after 5 seconds
    setTimeout(() => {
      hook.emit('PlayerRespawn', deadPlayer);
    }, 5000);
  },

  startRoundManagement(gameServer) {
    const tickRound = () => {
      module.exports.roundTimeRemaining--;

      // Update trap cooldowns
      module.exports.config.traps.forEach((trap) => {
        if (module.exports.trapCooldowns[trap.id] > 0) {
          module.exports.trapCooldowns[trap.id]--;
        }
      });

      if (module.exports.roundState === 'prep') {
        if (module.exports.roundTimeRemaining <= 0) {
          module.exports.startRound(gameServer);
        }
      } else if (module.exports.roundState === 'active') {
        if (module.exports.roundTimeRemaining <= 0) {
          module.exports.endRound(gameServer, 'time');
        }
      }

      setTimeout(tickRound, 1000);
    };

    module.exports.roundTimeRemaining = module.exports.config.roundTime;
    tickRound();
  },

  startRound(gameServer) {
    console.log('[Deathrun] Round started');
    module.exports.roundState = 'active';
    gameServer.broadcast('ROUND START!');
  },

  endRound(gameServer, reason) {
    console.log(`[Deathrun] Round ended (${reason})`);
    module.exports.roundState = 'ending';

    if (reason === 'time') {
      gameServer.broadcast('RUNNERS WIN! Time expired');
    } else if (reason === 'allRunnersKilled') {
      gameServer.broadcast('DEATHS WIN! All runners eliminated');
    } else if (reason === 'runnersReachedEnd') {
      gameServer.broadcast('RUNNERS WIN! Reached the end');
    }

    // Swap teams
    setTimeout(() => {
      const runners = gameServer
        .getPlayers()
        .filter((p) => p.team === module.exports.config.runnerTeam);
      const deaths = gameServer
        .getPlayers()
        .filter((p) => p.team === module.exports.config.deathTeam);

      runners.forEach((p) => p.setTeam(module.exports.config.deathTeam));
      deaths.forEach((p) => p.setTeam(module.exports.config.runnerTeam));

      module.exports.roundState = 'prep';
      module.exports.roundTimeRemaining = 30; // Prep time
      gameServer.broadcast('Next round starting...');
    }, 5000);
  },

  // Activate a trap
  activateTrap(gameServer, trapId, deathPlayer) {
    const trap = module.exports.config.traps.find((t) => t.id === trapId);
    if (!trap) {
      console.error(`[Deathrun] Unknown trap: ${trapId}`);
      return false;
    }

    const cooldown = module.exports.trapCooldowns[trapId];
    if (cooldown > 0) {
      console.log(
        `[Deathrun] Trap ${trap.name} on cooldown (${cooldown}s remaining)`
      );
      return false;
    }

    console.log(`[Deathrun] ${deathPlayer.name} activated ${trap.name}!`);
    module.exports.trapCooldowns[trapId] = trap.cooldown;

    hook.emit('TrapActivated', trapId, deathPlayer);
    hook.emit('BroadcastMessage', `${trap.name} activated!`);

    return true;
  },

  // Check if runners reached the end
  checkRunnerProgress(gameServer, runnerPlayer) {
    const hasReachedEnd = runnerPlayer.getData('reachedEnd') === true;
    if (hasReachedEnd) {
      module.exports.endRound(gameServer, 'runnersReachedEnd');
    }
  },

  // Get trap status (for UI)
  getTrapStatus() {
    const status = {};
    module.exports.config.traps.forEach((trap) => {
      status[trap.id] = {
        name: trap.name,
        cooldown: module.exports.trapCooldowns[trap.id],
        maxCooldown: trap.cooldown,
        ready: module.exports.trapCooldowns[trap.id] === 0,
      };
    });
    return status;
  },
};
