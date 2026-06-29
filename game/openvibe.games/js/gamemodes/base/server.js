(function () {
  const BaseServerGM = {
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
    Think() {}
  };

  gamemode.set(BaseServerGM);
})();
