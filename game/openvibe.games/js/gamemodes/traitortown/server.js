(function () {
  function registerCommands() {
    if (!globalThis.command) return;
    command.add("ttt_status", "Show Traitor Town status", function ({ ply, reply }) {
      reply(ply, `Traitor Town JS online. map=${OV.getMapName()} players=${OV.players().length}`);
      return false;
    });
  }

  const GM = {
    mode: "traitortown",
    name: "OpenVibe Traitor Town",
    Initialize() { OV.log("Traitor Town Initialize fired"); registerCommands(); },
    PlayerInitialSpawn(ply) { ply.chat("Traitor Town JS loaded. Try !ttt_status"); },
    Think() {}
  };

  hook.Add("PlayerSpawn", "OpenVibeTraitorTownSpawnTip", function (ply) {
    ply.chat("Watch the room. Someone here is lying.");
  });

  gamemode.set(GM);
})();
