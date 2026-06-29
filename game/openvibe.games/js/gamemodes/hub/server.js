const GM = {
  mode: "hub",
  name: "OpenVibe Hub",

  Initialize() {
    OV.log("Hub Initialize fired");
  },

  MapInitialize(mapName) {
    OV.log(`Map initialized: ${mapName}`);
  },

  PlayerInitialSpawn(ply) {
    ply.chat("Welcome to OpenVibe: Source JS runtime.");
    OV.broadcast(`${ply.name()} joined the hub.`);
  },

  PlayerSpawn(ply) {
    ply.chat("PlayerSpawn hook fired.");
  },

  PlayerSay(ply, text) {
    if (text === "!js") {
      ply.chat("JavaScript hooks are working.");
      return false;
    }

    if (text === "!hp") {
      ply.chat(`Health: ${ply.health()}`);
      return false;
    }

    if (text === "!players") {
      ply.chat(`Players online: ${OV.players().length}`);
      return false;
    }

    return undefined;
  },

  Think() {}
};

gamemode.set(GM);
