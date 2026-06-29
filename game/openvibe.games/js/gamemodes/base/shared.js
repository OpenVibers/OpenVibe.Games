export const GM = {
  mode: "base",
  name: "OpenVibe Base",

  Initialize() {
    console.log("Base gamemode initialized");
  },

  PlayerInitialSpawn(ply) {
    ply.chat("Welcome to OpenVibe: Source");
  },

  PlayerSpawn(_ply) {},

  PlayerDeath(_victim, _attacker, _inflictor) {},

  PlayerSay(_ply, text) {
    return undefined;
  }
};

gamemode.set(GM);
