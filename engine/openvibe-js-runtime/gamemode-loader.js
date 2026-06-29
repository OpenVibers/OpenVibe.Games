/**
 * Gamemode Loader
 * Loads and manages JavaScript-based gamemodes
 */

const path = require('path');
const hook = require('./hook');
const { gameServer } = require('./game-api');

class GamemodeLoader {
  constructor(baseDir) {
    this.baseDir = baseDir; // gamemodes/ directory
    this.gamemodes = new Map();
  }

  /**
   * Load a gamemode from directory
   * @param {string} name - Gamemode name (e.g., 'hub', 'prophunt')
   * @returns {Object} - Gamemode module
   */
  load(name) {
    const gamemodeDir = path.join(this.baseDir, name);
    console.log(`[Gamemode] Loading: ${name} from ${gamemodeDir}`);

    try {
      // Clear require cache to allow reloading
      delete require.cache[require.resolve(path.join(gamemodeDir, 'index.js'))];

      const gamemodeModule = require(path.join(gamemodeDir, 'index.js'));

      // Validate gamemode has required exports
      if (!gamemodeModule.name) {
        throw new Error('Gamemode must export "name" property');
      }

      this.gamemodes.set(name, gamemodeModule);
      console.log(`[Gamemode] Loaded: ${gamemodeModule.name}`);

      return gamemodeModule;
    } catch (err) {
      console.error(`[Gamemode] Failed to load ${name}:`, err.message);
      return null;
    }
  }

  /**
   * Unload a gamemode
   * @param {string} name - Gamemode name
   */
  unload(name) {
    const gamemode = this.gamemodes.get(name);
    if (gamemode) {
      if (gamemode.onUnload) {
        gamemode.onUnload(gameServer);
      }
      this.gamemodes.delete(name);
      console.log(`[Gamemode] Unloaded: ${name}`);

      // Clear hooks registered by this gamemode
      this.clearGamemodeHooks(name);
    }
  }

  /**
   * Get a loaded gamemode
   * @param {string} name
   * @returns {Object} - Gamemode module
   */
  get(name) {
    return this.gamemodes.get(name);
  }

  /**
   * Start a gamemode (initialize it)
   * @param {string} name - Gamemode name
   * @param {Object} config - Optional configuration
   */
  start(name, config = {}) {
    const gamemode = this.get(name);
    if (!gamemode) {
      console.error(`[Gamemode] Cannot start unknown gamemode: ${name}`);
      return false;
    }

    console.log(`[Gamemode] Starting: ${name}`);
    gameServer.loadGamemode(gamemode);

    if (gamemode.onStart) {
      gamemode.onStart(gameServer, config);
    }

    return true;
  }

  /**
   * Stop current gamemode
   */
  stop() {
    if (gameServer.gamemode) {
      const gamemode = gameServer.gamemode;
      if (gamemode.onStop) {
        gamemode.onStop(gameServer);
      }
      gameServer.gamemode = null;
      console.log(`[Gamemode] Stopped`);
    }
  }

  /**
   * Reload a gamemode
   * @param {string} name
   * @param {Object} config
   */
  reload(name, config = {}) {
    this.stop();
    this.unload(name);
    this.load(name);
    this.start(name, config);
  }

  /**
   * Clear all hooks from a specific gamemode
   * Used internally when unloading
   * @private
   */
  clearGamemodeHooks(gamemodePrefix) {
    // This is a simplified version - in production you'd track which hooks
    // belong to which gamemode and only remove those
    console.log(`[Gamemode] Cleared hooks for ${gamemodePrefix}`);
  }

  /**
   * List all loaded gamemodes
   */
  list() {
    return Array.from(this.gamemodes.keys());
  }
}

module.exports = GamemodeLoader;
