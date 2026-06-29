const GM = {
  mode: "base",
  name: "OpenVibe Base",

  Initialize() {
    OV.log("Base Initialize fired");
  },

  MapInitialize(mapName) {
    OV.log(`Base MapInitialize: ${mapName}`);
  },

  PlayerInitialSpawn(ply) {
    ply.chat("Welcome to OpenVibe: Source.");
  },

  PlayerSpawn(_ply) {},

  PlayerDeath(_victim, _attacker) {},

  PlayerDisconnected(_ply) {},

  PlayerSay(_ply, _text) {
    return undefined;
  },

  ConsoleCommand(text) {
    OV.log(`ConsoleCommand: ${text}`);
    return undefined;
  },

  Think() {},

ConsoleCommand(text) {
    OV.log(`Base ConsoleCommand: ${text}`);
  }
};

gamemode.set(GM);
