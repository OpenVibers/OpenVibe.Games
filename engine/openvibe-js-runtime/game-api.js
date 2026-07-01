/**
 * OpenVibe Game API
 * Exposes Source engine functions and data to JavaScript
 * 
 * This is a mock API for now - in production, these would be bound
 * to actual C++ game engine functions via V8 bindings or IPC
 */

const hook = require('./hook');

class Player {
  constructor(steamId, name, team = 0) {
    this.steamId = steamId;
    this.name = name;
    this.team = team;
    this.data = new Map(); // Custom player data
    this.netVars = new Map(); // Networked variables
  }

  setTeam(team) {
    this.team = team;
    hook.emit('PlayerTeamChanged', this, team);
  }

  getTeam() {
    return this.team;
  }

  setData(key, value) {
    this.data.set(key, value);
  }

  getData(key) {
    return this.data.get(key);
  }

  // Networked variables sync to client
  setNetVar(key, value) {
    this.netVars.set(key, value);
    hook.emit('PlayerNetVarChanged', this, key, value);
  }

  getNetVar(key) {
    return this.netVars.get(key);
  }
}

class GameServer {
  constructor() {
    this.players = new Map(); // steamId -> Player
    this.roundState = 'prep'; // prep, active, ending
    this.mapName = 'ov_hub';
    this.maxPlayers = 32;
    this.config = {};
    this.gamemode = null;
  }

  getPlayer(steamId) {
    return this.players.get(steamId);
  }

  addPlayer(steamId, name) {
    const player = new Player(steamId, name);
    this.players.set(steamId, player);
    hook.emit('PlayerJoined', player);
    return player;
  }

  removePlayer(steamId) {
    const player = this.players.get(steamId);
    if (player) {
      this.players.delete(steamId);
      hook.emit('PlayerLeft', player);
    }
  }

  getPlayers() {
    return Array.from(this.players.values());
  }

  getPlayerCount() {
    return this.players.size;
  }

  getRoundState() {
    return this.roundState;
  }

  setRoundState(state) {
    const oldState = this.roundState;
    this.roundState = state;
    hook.emit('RoundStateChanged', oldState, state);
    hook.emit(`Round${state.charAt(0).toUpperCase() + state.slice(1)}`, this);
  }

  broadcast(message) {
    console.log(`[Broadcast] ${message}`);
    hook.emit('BroadcastMessage', message);
  }

  broadcastTeam(team, message) {
    console.log(`[Team ${team}] ${message}`);
    hook.emit('TeamMessage', team, message);
  }

  // Console command execution
  execCommand(cmd) {
    hook.emit('ConsoleCommand', cmd);
  }

  // Load gamemode
  loadGamemode(gamemodeModule) {
    this.gamemode = gamemodeModule;
    if (gamemodeModule.onLoad) {
      gamemodeModule.onLoad(this);
    }
    console.log(`[GameServer] Loaded gamemode: ${gamemodeModule.name}`);
  }
}

// Export singleton
const gameServer = new GameServer();

module.exports = {
  Player,
  GameServer,
  gameServer,
};
