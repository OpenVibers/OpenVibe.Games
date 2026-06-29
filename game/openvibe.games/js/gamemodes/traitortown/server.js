(function () {
  function registerCommands() {
    if (!globalThis.command) return;
    command.add("ttt_status", "Show Traitor Town status", function ({ ply, reply }) {
      reply(ply, `Traitor Town JS online. map=${OV.getMapName()} players=${OV.players().length}`);
      return false;
    });
  }

  const TraitorTownGM = {
    mode: "traitortown",
    name: "OpenVibe Traitor Town",
    Initialize() { OV.log("Traitor Town Initialize fired"); registerCommands(); },
    PlayerInitialSpawn(ply) { ply.chat("Traitor Town JS loaded. Try !ttt_status"); },
    Think() {}
  };
  gamemode.set(TraitorTownGM);
})();
