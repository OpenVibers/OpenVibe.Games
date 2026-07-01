/**
 * OpenVibe.JS Runtime
 * Main entry point for the JavaScript gamemode engine
 * 
 * This is the bridge between Source engine and JavaScript gamemodes
 * In production, this would be loaded by C++ code via V8 bindings or IPC
 */

const path = require('path');
const GamemodeLoader = require('./gamemode-loader');
const hook = require('./hook');
const { gameServer, Player } = require('./game-api');

class OpenVibeRuntime {
  constructor(baseDir = process.cwd()) {
    this.baseDir = baseDir;
    this.gamemodeDir = path.join(baseDir, 'game', 'openvibe.games', 'gamemodes');
    this.gamemodeLoader = new GamemodeLoader(this.gamemodeDir);
    this.isInitialized = false;
  }

  /**
   * Initialize the runtime
   * Called on server startup
   */
  initialize() {
    console.log('[OpenVibe.JS] Initializing runtime');
    console.log(`[OpenVibe.JS] Gamemode directory: ${this.gamemodeDir}`);

    // Pre-load all gamemodes
    const gamemodeDirs = ['hub', 'prophunt', 'deathrun', 'fortwars', 'traitortown'];
    gamemodeDirs.forEach((dir) => {
      this.gamemodeLoader.load(dir);
    });

    this.isInitialized = true;
    console.log(
      `[OpenVibe.JS] Initialized with ${gamemodeDirs.length} gamemodes`
    );
  }

  /**
   * Start a gamemode
   * @param {string} gamemodeName - Name of gamemode (e.g., 'hub', 'prophunt')
   * @param {Object} config - Optional configuration overrides
   */
  startGamemode(gamemodeName, config = {}) {
    if (!this.isInitialized) {
      console.error('[OpenVibe.JS] Not initialized');
      return false;
    }

    console.log(`[OpenVibe.JS] Starting gamemode: ${gamemodeName}`);
    return this.gamemodeLoader.start(gamemodeName, config);
  }

  /**
   * Stop current gamemode
   */
  stopGamemode() {
    console.log('[OpenVibe.JS] Stopping gamemode');
    this.gamemodeLoader.stop();
  }

  /**
   * Reload a gamemode (for development)
   */
  reloadGamemode(gamemodeName, config = {}) {
    console.log(`[OpenVibe.JS] Reloading gamemode: ${gamemodeName}`);
    this.gamemodeLoader.reload(gamemodeName, config);
  }

  /**
   * Get current gamemode
   */
  getGamemode() {
    return gameServer.gamemode;
  }

  /**
   * Handle player join event from server
   * @param {string} steamId
   * @param {string} playerName
   */
  onPlayerJoin(steamId, playerName) {
    console.log(`[OpenVibe.JS] Player joined: ${playerName} (${steamId})`);
    const player = gameServer.addPlayer(steamId, playerName);
    return player;
  }

  /**
   * Handle player leave event from server
   * @param {string} steamId
   */
  onPlayerLeave(steamId) {
    console.log(`[OpenVibe.JS] Player left: ${steamId}`);
    gameServer.removePlayer(steamId);
  }

  /**
   * Handle player death event from server
   * @param {string} deadSteamId
   * @param {string} killerSteamId - null for suicide/environment
   */
  onPlayerDeath(deadSteamId, killerSteamId = null) {
    const deadPlayer = gameServer.getPlayer(deadSteamId);
    const killer = killerSteamId ? gameServer.getPlayer(killerSteamId) : null;

    if (deadPlayer) {
      hook.emit('PlayerDeath', deadPlayer, killer);
    }
  }

  /**
   * Get game server instance
   * Used by C++ bindings to access server state
   */
  getGameServer() {
    return gameServer;
  }

  /**
   * Get hook system
   * Allows C++ to emit hooks
   */
  getHookSystem() {
    return hook;
  }

  /**
   * List all available gamemodes
   */
  listGamemodes() {
    return this.gamemodeLoader.list();
  }

  /**
   * Execute a console command
   * @param {string} command
   */
  executeCommand(command) {
    console.log(`[OpenVibe.JS] Executing command: ${command}`);

    if (command.startsWith('ov_gamemode_')) {
      const gamemodeName = command.substring(12);
      this.startGamemode(gamemodeName);
    } else if (command === 'ov_gamemode_stop') {
      this.stopGamemode();
    } else if (command.startsWith('ov_gamemode_reload ')) {
      const gamemodeName = command.substring(19);
      this.reloadGamemode(gamemodeName);
    } else {
      hook.emit('ConsoleCommand', command);
    }
  }

  /**
   * Get status of the runtime
   */
  getStatus() {
    return {
      initialized: this.isInitialized,
      currentGamemode: gameServer.gamemode ? gameServer.gamemode.name : null,
      playerCount: gameServer.getPlayerCount(),
      maxPlayers: gameServer.maxPlayers,
      gamemodes: this.listGamemodes(),
    };
  }
}

// Export singleton
const runtime = new OpenVibeRuntime();

// Export both the class and singleton
module.exports = {
  OpenVibeRuntime,
  runtime,
};
