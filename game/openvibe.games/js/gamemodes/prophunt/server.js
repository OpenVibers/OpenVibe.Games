(function () {
  function registerCommands() {
    if (!globalThis.command) return;
    command.add("ph_status", "Show Prop Hunt status", function ({ ply, reply }) {
      reply(ply, `Prop Hunt JS online. map=${OV.getMapName()} players=${OV.players().length}`);
      return false;
    });
    command.add("disguise", "Disguise as an allowlisted prop", function ({ args, ply, reply }) {
      const choice = args[0] || "crate";
      if (!ply) return false;
      ply.runCommand(`ov_prophunt_disguise ${choice}`);
      reply(ply, `Trying prop disguise: ${choice}`);
      return false;
    });
  }

  const PropHuntGM = {
    mode: "prophunt",
    name: "OpenVibe Prop Hunt",
    Initialize() { OV.log("Prop Hunt Initialize fired"); registerCommands(); },
    PlayerInitialSpawn(ply) { ply.chat("Prop Hunt JS loaded. Try !ph_status or !disguise crate"); },
    Think() {}
  };
  gamemode.set(PropHuntGM);
})();
