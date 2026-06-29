(function () {
  function registerHubCommands() {
    if (!globalThis.command) return;

    command.add("js", "Confirm JavaScript hooks are working", function ({ ply, reply }) {
      reply(ply, "JavaScript hooks are working.");
      return false;
    });

    command.add("hp", "Show current health", function ({ ply, reply }) {
      if (!ply) return false;
      reply(ply, `Health: ${ply.health()}`);
      return false;
    });

    command.add("players", "Show player count", function ({ ply, reply }) {
      reply(ply, `Players online: ${OV.players().length}`);
      return false;
    });

    command.add("where", "Show current mode and map", function ({ ply, reply }) {
      reply(ply, `Mode=${OV.getMode()} map=${OV.getMapName()}`);
      return false;
    });

    command.add("hub_status", "Broadcast hub status", function ({ ply, reply }) {
      reply(ply, `Hub OK. mode=${OV.getMode()} map=${OV.getMapName()} players=${OV.players().length}`);
      return false;
    });
  }

  const HubServerGM = {
    mode: "hub",
    name: "OpenVibe Hub",

    Initialize() {
      OV.log("Hub Initialize fired");
      registerHubCommands();
    },

    MapInitialize(mapName) {
      OV.log(`Hub MapInitialize: ${mapName}`);
    },

    PlayerInitialSpawn(ply) {
      ply.chat("Welcome to OpenVibe: Source JS runtime.");
      OV.broadcast(`${ply.name()} joined the hub.`);
    },

    PlayerSpawn(ply) {
      ply.chat("PlayerSpawn hook fired.");
    },

    PlayerSay(_ply, _text) {
      return undefined;
    },

    ConsoleCommand(text) {
      OV.log(`Hub ConsoleCommand fallback: ${text}`);
      return undefined;
    },

    Think() {}
  };

  gamemode.set(HubServerGM);
})();
