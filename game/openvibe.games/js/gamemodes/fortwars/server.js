(function () {
  function registerCommands() {
    if (!globalThis.command) return;
    command.add("fw_status", "Show Fort Wars status", function ({ ply, reply }) {
      reply(ply, `Fort Wars JS online. map=${OV.getMapName()} players=${OV.players().length}`);
      return false;
    });
    command.add("build", "Spawn an allowlisted Fort Wars prop", function ({ args, ply, reply }) {
      const choice = args[0] || "crate";
      if (!ply) return false;
      ply.runCommand(`ov_fortwars_spawn ${choice}`);
      reply(ply, `Trying Fort Wars prop: ${choice}`);
      return false;
    });
  }

  const GM = {
    mode: "fortwars",
    name: "OpenVibe Fort Wars",
    Initialize() { OV.log("Fort Wars Initialize fired"); registerCommands(); },
    PlayerInitialSpawn(ply) { ply.chat("Fort Wars JS loaded. Try !fw_status or !build crate"); },
    Think() {}
  };

  hook.Add("PlayerSpawn", "OpenVibeFortWarsSpawnTip", function (ply) {
    ply.chat("Build phase: use !build crate, !build pallet, or !build fence.");
  });

  gamemode.set(GM);
})();
