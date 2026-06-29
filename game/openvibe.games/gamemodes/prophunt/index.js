/**
 * OpenVibe Prop Hunt Gamemode
 * 
 * Hunters vs Props: One team hunts, the other hides as props
 * Props can disguise as any map prop
 * Rotation occurs when props are found or time expires
 * 
 * Features:
 * - Team-based gameplay (Hunters vs Props)
 * - Prop model selection system
 * - Time-based round rotation
 * - Score tracking
 * - Anti-camp mechanics
 */

const hook = require('../../../engine/openvibe-js-runtime/hook');

module.exports = {
  name: 'Prop Hunt',
  version: '1.0.0',
  description: 'Hide as props, or hunt them down',

  config: {
    maxPlayers: 32,
    roundTime: 600, // 10 minutes
    minPrepTime: 10, // 10 seconds prep before hunt starts
    teamsMinSize: 4, // Minimum 4v4
    propModels: [
      'models/props_c17/oildrum001.mdl',
      'models/props_c17/signbox01a.mdl',
      'models/props_c17/barrel.mdl',
      'models/props_c17/crate_32x32x32.mdl',
      'models/props_c17/pulley01_sheet.mdl',
    ],
  },

  roundState: 'prep', // prep, hunt, ending
  hunterTeam: 2,
  propTeam: 3,
  roundTimeRemaining: 0,

  onLoad(gameServer) {
    console.log('[PropHunt] Loaded');
  },

  onStart(gameServer, config) {
    console.log('[PropHunt] Starting');

    gameServer.mapName = 'ov_prophunt';
    module.exports.roundTimeRemaining = module.exports.config.roundTime;

    // Register hooks
    hook.on('PlayerJoined', 'prophunt-player-join', (player) => {
      module.exports.onPlayerJoin(gameServer, player);
    });

    hook.on('PlayerLeft', 'prophunt-player-leave', (player) => {
      module.exports.onPlayerLeave(gameServer, player);
    });

    hook.on('PlayerTeamChanged', 'prophunt-team-change', (player, team) => {
      module.exports.onPlayerTeamChange(gameServer, player, team);
    });

    // Start round management
    module.exports.startRoundManagement(gameServer);
    module.exports.startThink(gameServer);
  },

  onStop(gameServer) {
    console.log('[PropHunt] Stopping');
    hook.off('PlayerJoined', 'prophunt-player-join');
    hook.off('PlayerLeft', 'prophunt-player-leave');
    hook.off('PlayerTeamChanged', 'prophunt-team-change');
  },

  onPlayerJoin(gameServer, player) {
    console.log(`[PropHunt] ${player.name} joined`);
    // Assign to team with fewer players
    const hunters = gameServer
      .getPlayers()
      .filter((p) => p.team === module.exports.hunterTeam).length;
    const props = gameServer
      .getPlayers()
      .filter((p) => p.team === module.exports.propTeam).length;

    const newTeam = hunters <= props ? module.exports.hunterTeam : module.exports.propTeam;
    player.setTeam(newTeam);
    gameServer.broadcast(`${player.name} joined team ${newTeam}`);
  },

  onPlayerLeave(gameServer, player) {
    console.log(`[PropHunt] ${player.name} left`);
    hook.emit('CheckRoundStatus', gameServer);
  },

  onPlayerTeamChange(gameServer, player, team) {
    if (team === module.exports.propTeam) {
      // Let prop player select a model
      hook.emit('PropSelectModel', player, module.exports.config.propModels);
    }
  },

  startRoundManagement(gameServer) {
    const tickRound = () => {
      module.exports.roundTimeRemaining--;

      if (module.exports.roundState === 'prep') {
        if (module.exports.roundTimeRemaining <= 0) {
          module.exports.startHuntPhase(gameServer);
        }
      } else if (module.exports.roundState === 'hunt') {
        if (module.exports.roundTimeRemaining <= 0) {
          module.exports.endRound(gameServer, 'time');
        }
      }

      setTimeout(tickRound, 1000); // Tick every second
    };

    tickRound();
  },

  startHuntPhase(gameServer) {
    console.log('[PropHunt] Starting hunt phase');
    module.exports.roundState = 'hunt';
    module.exports.roundTimeRemaining = module.exports.config.roundTime;

    gameServer.broadcast('HUNT PHASE STARTS!');
    hook.emit('RoundHuntStart', gameServer);
  },

  endRound(gameServer, reason) {
    console.log(`[PropHunt] Round ended (${reason})`);
    module.exports.roundState = 'ending';

    // Determine winner
    const hunters = gameServer
      .getPlayers()
      .filter((p) => p.team === module.exports.hunterTeam);
    const props = gameServer
      .getPlayers()
      .filter((p) => p.team === module.exports.propTeam);

    if (reason === 'time') {
      gameServer.broadcast('PROPS WIN! Time expired');
    } else if (reason === 'allPropsCaught') {
      gameServer.broadcast('HUNTERS WIN! All props caught');
    }

    // Swap teams and start new round
    setTimeout(() => {
      hunters.forEach((p) => p.setTeam(module.exports.propTeam));
      props.forEach((p) => p.setTeam(module.exports.hunterTeam));

      module.exports.roundState = 'prep';
      module.exports.roundTimeRemaining = module.exports.config.minPrepTime;
      gameServer.broadcast('New round starting...');
    }, 5000);
  },

  startThink(gameServer) {
    const think = () => {
      // Check if all props are caught
      const props = gameServer
        .getPlayers()
        .filter((p) => p.team === module.exports.propTeam);
      const propsCaught = props.filter(
        (p) => p.getData('caught') === true
      ).length;

      if (
        module.exports.roundState === 'hunt' &&
        propsCaught === props.length &&
        props.length > 0
      ) {
        module.exports.endRound(gameServer, 'allPropsCaught');
      }

      setImmediate(think);
    };

    think();
  },

  // Get available prop models
  getPropModels() {
    return module.exports.config.propModels;
  },

  // Set player as prop with specific model
  setPropModel(player, modelPath) {
    console.log(`[PropHunt] ${player.name} is now a ${modelPath}`);
    player.setNetVar('prop_model', modelPath);
    hook.emit('PropModelChanged', player, modelPath);
  },

  // Mark a prop as caught
  catchProp(gameServer, propPlayer, hunterPlayer) {
    console.log(
      `[PropHunt] ${hunterPlayer.name} caught ${propPlayer.name}!`
    );
    propPlayer.setData('caught', true);
    hunterPlayer.setData('score', (hunterPlayer.getData('score') || 0) + 100);
    hook.emit('PropCaught', propPlayer, hunterPlayer);
  },
};
