const GM = {
  mode: "base",
  name: "OpenVibe Base",

  Initialize() {
    OV.log("Base Initialize fired");
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

  Think() {}
};

gamemode.set(GM);
