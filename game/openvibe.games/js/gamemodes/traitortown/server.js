let state = "waiting";
let roles = new Map();

function assignRoles(players) {
  roles.clear();

  const shuffled = [...players].sort(() => Math.random() - 0.5);
  const traitorCount = Math.max(1, Math.floor(shuffled.length / 4));

  for (let i = 0; i < shuffled.length; i++) {
    const role = i < traitorCount ? "traitor" : "innocent";
    roles.set(shuffled[i].steamId(), role);
    shuffled[i].chat(`Your role: ${role}`);
  }
}

export const GM = {
  mode: "traitortown",
  name: "OpenVibe Traitor Town",

  Initialize() {
    state = "waiting";
  },

  PlayerInitialSpawn(ply) {
    ply.chat("Traitor Town: find the traitors before they find you.");
  },

  RoundStart() {
    state = "running";
    assignRoles(OV.players());
    game.broadcast("Traitor Town round started.");
  },

  PlayerDeath(victim, attacker) {
    const role = roles.get(victim.steamId()) || "unknown";
    game.broadcast(`${victim.name()} died. They were ${role}.`);
  },

  PlayerSay(ply, text) {
    if (text === "!role") {
      ply.chat(`Your role: ${roles.get(ply.steamId()) || "none"}`);
      return false;
    }

    return undefined;
  }
};

gamemode.set(GM);
