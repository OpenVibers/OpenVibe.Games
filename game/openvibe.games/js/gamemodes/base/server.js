(function () {
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

    PlayerDisconnected(ply) {
      if (ply && typeof OV.log === "function") OV.log(`${ply.name()} disconnected.`);
    },

    PlayerSay(_ply, _text) {
      return undefined;
    },

    Think() {}
  };

  gamemode.setBase(GM);
  gamemode.set(GM, { base: true });
})();
