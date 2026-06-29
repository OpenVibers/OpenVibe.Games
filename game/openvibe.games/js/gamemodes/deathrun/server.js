(function () {
  function registerCommands() {
    if (!globalThis.command) return;
    command.add("dr_status", "Show Deathrun status", function ({ ply, reply }) {
      reply(ply, `Deathrun JS online. map=${OV.getMapName()} players=${OV.players().length}`);
      return false;
    });
  }

  const GM = {
    mode: "deathrun",
    name: "OpenVibe Deathrun",
    Initialize() { OV.log("Deathrun Initialize fired"); registerCommands(); },
    PlayerInitialSpawn(ply) { ply.chat("Deathrun JS loaded. Try !dr_status"); },
    Think() {}
  };

  hook.Add("PlayerSpawn", "OpenVibeDeathrunSpawnTip", function (ply) {
    ply.chat("Reach the end. Avoid traps. Trust nothing.");
  });

  gamemode.set(GM);
})();
