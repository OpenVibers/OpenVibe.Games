/**
 * OpenVibe.JS - Hook & Event System
 * Similar to Garry's Mod Lua hooks but for JavaScript
 * 
 * Usage:
 *   hook.on('PlayerSpawn', 'myhandler', (player) => { console.log(player.name + ' spawned'); });
 *   hook.emit('PlayerSpawn', player);
 *   hook.off('PlayerSpawn', 'myhandler');
 */

class HookSystem {
  constructor() {
    this.hooks = new Map(); // hookName -> Map(id -> callback)
    this.eventQueue = []; // Internal queue for queued events
    this.processing = false;
  }

  /**
   * Register a hook callback
   * @param {string} hookName - Event name
   * @param {string} id - Unique identifier for this hook
   * @param {Function} callback - Handler function
   */
  on(hookName, id, callback) {
    if (!this.hooks.has(hookName)) {
      this.hooks.set(hookName, new Map());
    }
    this.hooks.get(hookName).set(id, callback);
    console.log(`[Hook] Registered: ${hookName} (${id})`);
  }

  /**
   * Unregister a hook callback
   * @param {string} hookName - Event name
   * @param {string} id - Handler identifier
   */
  off(hookName, id) {
    if (this.hooks.has(hookName)) {
      this.hooks.get(hookName).delete(id);
      console.log(`[Hook] Unregistered: ${hookName} (${id})`);
    }
  }

  /**
   * Emit an event, calling all registered hooks
   * @param {string} hookName - Event name
   * @param {...any} args - Arguments to pass to handlers
   * @returns {boolean|any} - Return value from handlers (stops on first truthy)
   */
  emit(hookName, ...args) {
    if (!this.hooks.has(hookName)) {
      return null;
    }

    const handlers = this.hooks.get(hookName);
    let result = null;

    for (const [id, callback] of handlers) {
      try {
        const ret = callback(...args);
        if (ret !== undefined && ret !== null) {
          result = ret; // Allow chaining return values
        }
      } catch (err) {
        console.error(`[Hook] Error in ${hookName} (${id}):`, err.message);
      }
    }

    return result;
  }

  /**
   * Queue an async hook emission
   * Useful for network events that might batch together
   * @param {string} hookName - Event name
   * @param {...any} args - Arguments
   */
  queue(hookName, ...args) {
    this.eventQueue.push({ hook: hookName, args });

    if (!this.processing) {
      this.processQueue();
    }
  }

  /**
   * Process queued hooks
   */
  processQueue() {
    this.processing = true;

    // Process all queued hooks in next tick
    setImmediate(() => {
      while (this.eventQueue.length > 0) {
        const { hook, args } = this.eventQueue.shift();
        this.emit(hook, ...args);
      }
      this.processing = false;
    });
  }

  /**
   * Get all hooks for an event
   * @param {string} hookName
   * @returns {Map} - Map of id -> callback
   */
  getHooks(hookName) {
    return this.hooks.get(hookName) || new Map();
  }

  /**
   * Clear all hooks (for testing)
   */
  clear() {
    this.hooks.clear();
    this.eventQueue = [];
  }
}

// Export singleton
module.exports = new HookSystem();
