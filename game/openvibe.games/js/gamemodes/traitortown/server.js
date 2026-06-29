const roles = new Map();

const GM = {
  mode: "traitortown",
  name: "OpenVibe Traitor Town",

  Initialize() {
    OV.log("Traitor Town Initialize fired");
  },

  PlayerInitialSpawn(ply) {
    ply.chat("Traitor Town: find the traitors before they find you.");
    roles.set(ply.userId(), "innocent");
  },

  PlayerSay(ply, text) {
    if (text === "!role") {
      ply.chat(`Your role: ${roles.get(ply.userId()) || "none"}`);
      return false;
    }

    return undefined;
  },

  PlayerDeath(victim, attacker) {
    OV.broadcast(`${victim.name()} died.`);
  }
};

gamemode.set(GM);
